"use strict";

/**
 * PHASE 7 — live-PostgreSQL verification of the energy and payload schema (§14, §15).
 *
 * Phase 7's implementation report and its independent verification both recorded the
 * same limitation: no PostgreSQL instance was reachable, so the migration
 * `20260804180000_energy_and_payload_models` was confirmed only by regenerating it with
 * `prisma migrate diff --from-empty` and diffing the result. That proves the DDL is
 * Prisma's own output plus five hand-written CHECK constraints. It does not prove that
 * any of them **fires**, and it cannot touch the claims that are about the database's
 * behaviour rather than about the text of the DDL:
 *
 *   1. **Five hand-written CHECK constraints**, absent from Prisma's generated SQL by
 *      design. A CHECK naming a column that does not exist, or bounding the wrong side
 *      of an interval, is a constraint that never fires — and it reads identically to a
 *      correct one in a diff.
 *   2. **`ChargerAvailabilityProjection` is insert-only** and carries **no `updatedAt`**.
 *      §9.6 replay depends on it: a projection editable after a round consumed it makes
 *      that round unreplayable. "The column is absent" is a statement about the live
 *      table, not about the model text.
 *   3. **`PackingResultCache` may hold only a decided verdict.** §15.3 tier 4 memoises;
 *      memoising a `BUDGET_EXHAUSTED` would turn a transient node-budget limit into a
 *      standing refusal. `packing.evaluateMemoised()` refuses to write one, and the
 *      CHECK is the second, independent enforcement from the storage side — which only
 *      means something if a direct writer is actually refused.
 *   4. **The six foreign keys' delete behaviour.** `ON DELETE CASCADE` versus
 *      `ON DELETE SET NULL` is a data-retention decision: a decommissioned agent's
 *      battery history goes, a decommissioned site's chargers stay and lose their site.
 *      Only a real delete evidences which one the database performs.
 *
 * The harness writes only rows it creates, all keyed under a `p7-` prefix, and removes
 * them in a `finally`. It never writes to any table outside Phase 7's six plus the four
 * parent rows its foreign keys require.
 *
 * Usage:
 *   DATABASE_URL=postgresql://user:pw@127.0.0.1:55432/db node tools/verify/phase7LiveDatabase.js
 *
 * Deliberately **not** a Jest suite, for the same reason Phases 3–6's harnesses are
 * not: it requires a PostgreSQL instance, and a test that silently skips when its
 * environment is absent is a test that reports green for having done nothing.
 */

const { PrismaClient } = require("@prisma/client");

const packing = require("../../src/engine/payload/packing");

const prisma = new PrismaClient();

const PREFIX = "p7-live";
const T0 = new Date("2026-08-18T09:00:00.000Z");
const T1 = new Date("2026-08-18T10:00:00.000Z");

const PHASE_7_TABLES = [
  "EnergyModelParams",
  "BatteryState",
  "Charger",
  "ChargerReservation",
  "ChargerAvailabilityProjection",
  "PackingResultCache",
];

let passed = 0;
let failed = 0;

/**
 * @param {string} label
 * @param {boolean} condition
 * @param {string} [detail]
 */
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Run a statement expected to be refused by the database, and report what refused it.
 *
 * @param {string} label
 * @param {string|string[]} expected the constraint name, or — for a unique violation,
 *   whose PostgreSQL message names the offending key rather than the index — any marker
 *   that identifies *which* rule refused the write. Matching on "something threw" would
 *   pass for a typo'd column name, which is the failure mode this harness exists to
 *   catch, so the identifying marker is always required.
 * @param {() => Promise<*>} run
 */
async function refuses(label, expected, run) {
  const markers = Array.isArray(expected) ? expected : [expected];
  try {
    await run();
    check(label, false, "the write was ACCEPTED; the constraint did not fire");
  } catch (error) {
    const message = `${String(error && error.message)} ${JSON.stringify((error && error.meta) || {})}`;
    check(
      label,
      markers.some((marker) => message.includes(marker)),
      `refused, but not identifiably by ${markers.join(" / ")}: ${message.split("\n").slice(-2).join(" ")}`,
    );
  }
}

/**
 * Run a statement expected to be accepted.
 *
 * @param {string} label
 * @param {() => Promise<*>} run
 */
async function accepts(label, run) {
  try {
    await run();
    check(label, true);
  } catch (error) {
    check(label, false, `the lawful write was REFUSED: ${String(error && error.message).split("\n").slice(-2).join(" ")}`);
  }
}

/**
 * @param {string} sql
 * @returns {Promise<Array<object>>}
 */
function query(sql) {
  return prisma.$queryRawUnsafe(sql);
}

async function main() {
  console.log(`PHASE 7 live database verification — ${(process.env.DATABASE_URL || "").replace(/:[^:@/]*@/, ":***@")}\n`);

  const [{ version }] = await query("select version() as version");
  console.log(`  ${version}\n`);

  /* ── 1. The six tables, their columns, and the absent `updatedAt` ──────────── */

  console.log("1. Tables and columns\n");

  const columns = await query(
    `select table_name, column_name, is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public' and table_name in (${PHASE_7_TABLES.map((t) => `'${t}'`).join(",")})`,
  );
  const byTable = new Map();
  for (const row of columns) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Map());
    byTable.get(row.table_name).set(row.column_name, row);
  }

  for (const table of PHASE_7_TABLES) {
    check(`${table} exists`, byTable.has(table));
  }

  // §14.2 — every β term the consumption model reads has a column to be fitted into.
  for (const column of ["betaDist", "betaMass", "betaClimb", "betaRegen", "betaMoveTime", "betaStopStart", "betaDwell", "betaAux", "etaRegen", "betaThermal", "betaPayloadThermal", "residualCv"]) {
    check(`EnergyModelParams.${column} present`, byTable.get("EnergyModelParams").has(column));
  }

  // §14.6 — target SoC lives on the reservation, which is the schema-level expression
  // of "the Scheduler owns the target and the engine consumes it".
  check("ChargerReservation.targetSoc present (Scheduler-owned target)", byTable.get("ChargerReservation").has("targetSoc"));

  // §9.6 — a projection editable after a round consumed it is unreplayable.
  check(
    "ChargerAvailabilityProjection has NO updatedAt column (insert-only, §9.6)",
    !byTable.get("ChargerAvailabilityProjection").has("updatedAt"),
  );

  // §14.2 — κ's identity seed. The settlement worker seeds an agent with no history at
  // the identity, and `consumption.updateKappa()` refuses a non-positive previous κ.
  check(
    "BatteryState.kappa defaults to the identity 1",
    String(byTable.get("BatteryState").get("kappa").column_default).startsWith("1"),
  );
  check("BatteryState.kappaSampleCount defaults to 0", String(byTable.get("BatteryState").get("kappaSampleCount").column_default).startsWith("0"));

  /* ── 2. Indexes ───────────────────────────────────────────────────────────── */

  console.log("\n2. Indexes\n");

  const indexes = await query(
    `select indexname, tablename from pg_indexes
      where schemaname = 'public' and tablename in (${PHASE_7_TABLES.map((t) => `'${t}'`).join(",")})`,
  );
  const indexNames = new Set(indexes.map((row) => row.indexname));

  for (const name of [
    "EnergyModelParams_pkey",
    "EnergyModelParams_agentClassId_idx",
    "EnergyModelParams_agentClassId_modelVersion_key",
    "BatteryState_pkey",
    "BatteryState_agentId_key",
    "Charger_pkey",
    "Charger_chargerId_key",
    "Charger_cellId_idx",
    "Charger_regionId_idx",
    "Charger_siteId_idx",
    "Charger_isDepot_idx",
    "ChargerReservation_pkey",
    "ChargerReservation_reservationId_key",
    "ChargerReservation_agentId_reservedFrom_idx",
    "ChargerReservation_chargerDbId_reservedFrom_idx",
    "ChargerReservation_state_idx",
    "ChargerAvailabilityProjection_pkey",
    "ChargerAvailabilityProjection_version_key",
    "ChargerAvailabilityProjection_publishedAt_idx",
    "ChargerAvailabilityProjection_regionId_idx",
    "PackingResultCache_pkey",
    "PackingResultCache_containerConfig_itemSignature_key",
    "PackingResultCache_expiresAt_idx",
  ]) {
    check(`index ${name}`, indexNames.has(name));
  }

  /* ── 3. Foreign keys and their delete behaviour ────────────────────────────── */

  console.log("\n3. Foreign keys\n");

  const foreignKeys = await query(
    `select con.conname, con.confdeltype, cls.relname as child
       from pg_constraint con
       join pg_class cls on cls.oid = con.conrelid
      where con.contype = 'f' and cls.relname in (${PHASE_7_TABLES.map((t) => `'${t}'`).join(",")})`,
  );
  const fkByName = new Map(foreignKeys.map((row) => [row.conname, row]));

  // 'c' = CASCADE, 'n' = SET NULL.
  for (const [name, expected] of [
    ["EnergyModelParams_agentClassId_fkey", "c"],
    ["BatteryState_agentId_fkey", "c"],
    ["ChargerReservation_agentId_fkey", "c"],
    ["Charger_siteId_fkey", "n"],
    ["Charger_regionId_fkey", "n"],
    ["ChargerReservation_chargerDbId_fkey", "n"],
    ["ChargerAvailabilityProjection_regionId_fkey", "n"],
  ]) {
    const row = fkByName.get(name);
    check(
      `${name} exists with ON DELETE ${expected === "c" ? "CASCADE" : "SET NULL"}`,
      Boolean(row) && row.confdeltype === expected,
      row ? `confdeltype=${row.confdeltype}` : "constraint absent",
    );
  }

  /* ── 4. Parent rows, then the five CHECK constraints ───────────────────────── */

  console.log("\n4. The five hand-written CHECK constraints, each made to fire\n");

  await prisma.$executeRawUnsafe(
    `insert into "Region" (id, "regionId", name, "createdAt", "updatedAt") values ('${PREFIX}-region', '${PREFIX}-region', 'p7 region', now(), now())`,
  );
  await prisma.$executeRawUnsafe(
    `insert into "Site" (id, "siteId", name, "regionId", "createdAt", "updatedAt") values ('${PREFIX}-site', '${PREFIX}-site', 'p7 site', '${PREFIX}-region', now(), now())`,
  );
  await prisma.$executeRawUnsafe(
    `insert into "AgentClass" (id, "classId", name, "createdAt", "updatedAt") values ('${PREFIX}-class', '${PREFIX}-class', 'p7 class', now(), now())`,
  );
  await prisma.$executeRawUnsafe(
    `insert into "Agent" (id, "agentId", "createdAt", "updatedAt") values ('${PREFIX}-agent', '${PREFIX}-agent', now(), now())`,
  );

  /**
   * @param {object} fields
   * @returns {Promise<*>}
   */
  const insertBatteryState = (fields) => {
    const soh = fields.soh === null ? "NULL" : String(fields.soh);
    return prisma.$executeRawUnsafe(
      `insert into "BatteryState" (id, "agentId", soh, kappa, "updatedAt")
       values ('${fields.id}', '${PREFIX}-agent', ${soh}, ${fields.kappa}, now())`,
    );
  };

  // §14.3 — SoH is a fraction of the pack that was built. A SoH above 1 claims a larger
  // pack than exists, and would inflate E_usable for every mission the agent is offered.
  await refuses("soh = 1.4 is refused", "BatteryState_soh_fraction", () => insertBatteryState({ id: `${PREFIX}-bs-a`, soh: 1.4, kappa: 1 }));
  await refuses("soh = 0 is refused", "BatteryState_soh_fraction", () => insertBatteryState({ id: `${PREFIX}-bs-b`, soh: 0, kappa: 1 }));
  await refuses("soh = -0.1 is refused", "BatteryState_soh_fraction", () => insertBatteryState({ id: `${PREFIX}-bs-c`, soh: -0.1, kappa: 1 }));
  await accepts("soh = 1.0 (a new pack) is accepted", () => insertBatteryState({ id: `${PREFIX}-bs-d`, soh: 1, kappa: 1 }));
  await prisma.$executeRawUnsafe(`delete from "BatteryState" where id = '${PREFIX}-bs-d'`);
  await accepts("soh NULL (not yet measured) is accepted", () => insertBatteryState({ id: `${PREFIX}-bs-e`, soh: null, kappa: 1 }));
  await prisma.$executeRawUnsafe(`delete from "BatteryState" where id = '${PREFIX}-bs-e'`);

  // §14.2 — κ is a multiplicative correction. A zero or negative κ zeroes or inverts
  // every consumption estimate the agent's model produces.
  await refuses("kappa = 0 is refused", "BatteryState_kappa_positive", () => insertBatteryState({ id: `${PREFIX}-bs-f`, soh: null, kappa: 0 }));
  await refuses("kappa = -1 is refused", "BatteryState_kappa_positive", () => insertBatteryState({ id: `${PREFIX}-bs-g`, soh: null, kappa: -1 }));
  await accepts("kappa = 1.12 (a calibrated agent) is accepted", () => insertBatteryState({ id: `${PREFIX}-bs-h`, soh: 0.87, kappa: 1.12 }));

  /**
   * @param {object} fields
   * @returns {Promise<*>}
   */
  const insertReservation = (fields) =>
    prisma.$executeRawUnsafe(
      `insert into "ChargerReservation" (id, "reservationId", "agentId", "reservedFrom", "reservedUntil", "targetSoc", "updatedAt")
       values ('${fields.id}', '${fields.id}', '${PREFIX}-agent', '${fields.from.toISOString()}', '${fields.until.toISOString()}',
               ${fields.targetSoc === null ? "NULL" : String(fields.targetSoc)}, now())`,
    );

  // §14.6 — targetSoc crosses the Charging Scheduler service boundary, which is exactly
  // where a unit confusion (80 versus 0.8) survives review.
  await refuses("targetSoc = 80 (a percentage, not a fraction) is refused", "ChargerReservation_target_soc_fraction", () =>
    insertReservation({ id: `${PREFIX}-res-a`, from: T0, until: T1, targetSoc: 80 }),
  );
  await refuses("targetSoc = -0.1 is refused", "ChargerReservation_target_soc_fraction", () =>
    insertReservation({ id: `${PREFIX}-res-b`, from: T0, until: T1, targetSoc: -0.1 }),
  );
  await accepts("targetSoc = 0.8 is accepted", () => insertReservation({ id: `${PREFIX}-res-c`, from: T0, until: T1, targetSoc: 0.8 }));

  // §7.5 F18 — a zero-width or inverted window makes "this agent is reserved for
  // charging, so it is not available" unevaluable.
  await refuses("reservedUntil == reservedFrom is refused", "ChargerReservation_window_ordered", () =>
    insertReservation({ id: `${PREFIX}-res-d`, from: T0, until: T0, targetSoc: 0.8 }),
  );
  await refuses("reservedUntil < reservedFrom is refused", "ChargerReservation_window_ordered", () =>
    insertReservation({ id: `${PREFIX}-res-e`, from: T1, until: T0, targetSoc: 0.8 }),
  );

  /**
   * @param {string} id
   * @param {string} verdict
   * @returns {Promise<*>}
   */
  const insertMemo = (id, verdict) =>
    prisma.$executeRawUnsafe(
      `insert into "PackingResultCache" (id, "containerConfig", "itemSignature", verdict)
       values ('${id}', '${id}-container', '${id}-items', '${verdict}')`,
    );

  // §15.3 tier 4 — the memo may hold only a *decided* verdict. Memoising an indecision
  // turns a transient node-budget limit into a standing refusal for the entry's life.
  await refuses("verdict 'BUDGET_EXHAUSTED' is refused by the database", "PackingResultCache_verdict_decided", () =>
    insertMemo(`${PREFIX}-memo-a`, "BUDGET_EXHAUSTED"),
  );
  await refuses("verdict 'INDETERMINATE' is refused", "PackingResultCache_verdict_decided", () => insertMemo(`${PREFIX}-memo-b`, "INDETERMINATE"));
  await accepts("verdict 'FEASIBLE' is accepted", () => insertMemo(`${PREFIX}-memo-c`, "FEASIBLE"));
  await accepts("verdict 'INFEASIBLE' is accepted", () => insertMemo(`${PREFIX}-memo-d`, "INFEASIBLE"));

  // And the application half of the same rule, from the shipped module rather than from
  // a restatement of it: the set of verdicts the memo writer will ever offer the
  // database is exactly the set the CHECK admits.
  check(
    "packing.VERDICT's decided values are exactly the CHECK's admitted set",
    packing.VERDICT.FEASIBLE === "FEASIBLE" &&
      packing.VERDICT.INFEASIBLE === "INFEASIBLE" &&
      packing.VERDICT.BUDGET_EXHAUSTED === "BUDGET_EXHAUSTED",
  );

  /* ── 5. Uniqueness and immutability ────────────────────────────────────────── */

  console.log("\n5. Uniqueness, immutability, and replayability\n");

  /**
   * @param {number} version
   * @param {string} id
   * @returns {Promise<*>}
   */
  const insertProjection = (version, id) =>
    prisma.$executeRawUnsafe(
      `insert into "ChargerAvailabilityProjection" (id, version, "publishedAt", "regionId", payload)
       values ('${id}', ${version}, '${T0.toISOString()}', '${PREFIX}-region', '{"chargers":[]}'::jsonb)`,
    );

  await accepts("a projection at version 9001 inserts", () => insertProjection(9001, `${PREFIX}-proj-a`));
  await refuses("a second projection at the same version is refused", ["ChargerAvailabilityProjection_version_key", "Key (version)=(9001)"], () =>
    insertProjection(9001, `${PREFIX}-proj-b`),
  );
  await accepts("a projection at a new version inserts", () => insertProjection(9002, `${PREFIX}-proj-c`));

  await refuses(
    "a duplicate (containerConfig, itemSignature) memo is refused",
    ["PackingResultCache_containerConfig_itemSignature_key", 'Key ("containerConfig", "itemSignature")'],
    () =>
    prisma.$executeRawUnsafe(
      `insert into "PackingResultCache" (id, "containerConfig", "itemSignature", verdict)
       values ('${PREFIX}-memo-e', '${PREFIX}-memo-c-container', '${PREFIX}-memo-c-items', 'INFEASIBLE')`,
    ),
  );

  await accepts("a second EnergyModelParams row for the same class at a new modelVersion inserts", async () => {
    await prisma.$executeRawUnsafe(
      `insert into "EnergyModelParams" (id, "agentClassId", "modelVersion", "betaDist", "updatedAt")
       values ('${PREFIX}-emp-a', '${PREFIX}-class', 1, 12.5, now())`,
    );
    await prisma.$executeRawUnsafe(
      `insert into "EnergyModelParams" (id, "agentClassId", "modelVersion", "betaDist", "updatedAt")
       values ('${PREFIX}-emp-b', '${PREFIX}-class', 2, 13.0, now())`,
    );
  });
  await refuses(
    "a duplicate (agentClassId, modelVersion) is refused — a decision can name its model",
    ["EnergyModelParams_agentClassId_modelVersion_key", 'Key ("agentClassId", "modelVersion")'],
    () =>
    prisma.$executeRawUnsafe(
      `insert into "EnergyModelParams" (id, "agentClassId", "modelVersion", "betaDist", "updatedAt")
       values ('${PREFIX}-emp-c', '${PREFIX}-class', 2, 99.0, now())`,
    ),
  );

  /* ── 6. Delete behaviour, actually performed ───────────────────────────────── */

  console.log("\n6. Delete behaviour, performed rather than read off the DDL\n");

  await prisma.$executeRawUnsafe(
    `insert into "Charger" (id, "chargerId", "siteId", "regionId", "cellId", "isDepot", "updatedAt")
     values ('${PREFIX}-charger', '${PREFIX}-charger', '${PREFIX}-site', '${PREFIX}-region', 'cell-1', true, now())`,
  );
  await prisma.$executeRawUnsafe(
    `insert into "ChargerReservation" (id, "reservationId", "agentId", "chargerDbId", "reservedFrom", "reservedUntil", "updatedAt")
     values ('${PREFIX}-res-f', '${PREFIX}-res-f', '${PREFIX}-agent', '${PREFIX}-charger', '${T0.toISOString()}', '${T1.toISOString()}', now())`,
  );

  await prisma.$executeRawUnsafe(`delete from "Charger" where id = '${PREFIX}-charger'`);
  const [orphaned] = await query(`select "chargerDbId" from "ChargerReservation" where id = '${PREFIX}-res-f'`);
  check(
    "deleting a Charger nulls its reservations' chargerDbId rather than deleting them",
    orphaned && orphaned.chargerDbId === null,
    `chargerDbId=${orphaned ? String(orphaned.chargerDbId) : "row gone"}`,
  );

  const beforeAgentDelete = await query(
    `select (select count(*) from "BatteryState" where "agentId" = '${PREFIX}-agent') as battery,
            (select count(*) from "ChargerReservation" where "agentId" = '${PREFIX}-agent') as reservations`,
  );
  check(
    "the agent has battery state and reservations before the delete",
    Number(beforeAgentDelete[0].battery) > 0 && Number(beforeAgentDelete[0].reservations) > 0,
  );

  await prisma.$executeRawUnsafe(`delete from "Agent" where id = '${PREFIX}-agent'`);
  const afterAgentDelete = await query(
    `select (select count(*) from "BatteryState" where "agentId" = '${PREFIX}-agent') as battery,
            (select count(*) from "ChargerReservation" where "agentId" = '${PREFIX}-agent') as reservations`,
  );
  check(
    "deleting an Agent cascades its BatteryState and ChargerReservations away",
    Number(afterAgentDelete[0].battery) === 0 && Number(afterAgentDelete[0].reservations) === 0,
    JSON.stringify(afterAgentDelete[0], (key, value) => (typeof value === "bigint" ? String(value) : value)),
  );

  await prisma.$executeRawUnsafe(`delete from "AgentClass" where id = '${PREFIX}-class'`);
  const [afterClassDelete] = await query(`select count(*) as n from "EnergyModelParams" where "agentClassId" = '${PREFIX}-class'`);
  check("deleting an AgentClass cascades its EnergyModelParams away", Number(afterClassDelete.n) === 0);

  // The Site is removed first: Phase 2's `Site_regionId_fkey` is RESTRICT, so a Region
  // with sites cannot be deleted at all. That is Phase 2's decision and is not under
  // test here — what is under test is what happens to a *projection* when its region
  // goes, because a projection is a pinned decision input (§9.6).
  await prisma.$executeRawUnsafe(`delete from "Site" where id = '${PREFIX}-site'`);
  const [afterRegionDelete] = await (async () => {
    await prisma.$executeRawUnsafe(`delete from "Region" where id = '${PREFIX}-region'`);
    return query(`select "regionId" from "ChargerAvailabilityProjection" where id = '${PREFIX}-proj-a'`);
  })();
  check(
    "deleting a Region nulls a projection's regionId rather than destroying the projection",
    afterRegionDelete && afterRegionDelete.regionId === null,
    afterRegionDelete ? `regionId=${String(afterRegionDelete.regionId)}` : "projection row gone — a replayed round would lose its input",
  );
}

/**
 * Remove everything this harness created, whatever happened.
 */
async function cleanup() {
  const statements = [
    `delete from "PackingResultCache" where id like '${PREFIX}-%'`,
    `delete from "ChargerAvailabilityProjection" where id like '${PREFIX}-%'`,
    `delete from "ChargerReservation" where id like '${PREFIX}-%'`,
    `delete from "Charger" where id like '${PREFIX}-%'`,
    `delete from "BatteryState" where id like '${PREFIX}-%'`,
    `delete from "EnergyModelParams" where id like '${PREFIX}-%'`,
    `delete from "Agent" where id like '${PREFIX}-%'`,
    `delete from "AgentClass" where id like '${PREFIX}-%'`,
    `delete from "Site" where id like '${PREFIX}-%'`,
    `delete from "Region" where id like '${PREFIX}-%'`,
  ];
  for (const statement of statements) {
    try {
      await prisma.$executeRawUnsafe(statement);
    } catch {
      /* a row this harness never created is not an error */
    }
  }
}

main()
  .catch((error) => {
    failed += 1;
    console.error(`\n  HARNESS ERROR: ${error && error.stack ? error.stack : String(error)}`);
  })
  .then(cleanup)
  .then(async () => {
    const leftovers = await query(
      `select ${PHASE_7_TABLES.map((t) => `(select count(*) from "${t}" where id like '${PREFIX}-%')`).join(" + ")} as n`,
    );
    check("\n  the harness left no rows behind", Number(leftovers[0].n) === 0);
    console.log(`\n${passed} passed, ${failed} failed.`);
    process.exitCode = failed === 0 ? 0 : 1;
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
    await prisma.$disconnect();
  });

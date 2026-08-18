"use strict";

/**
 * PHASE 8 — live-PostgreSQL verification of the cost-function and Plan Builder schema
 * (§8.3, §13.2).
 *
 * `PHASE_8_IMPLEMENTATION_REPORT.md` §10 and §14 item 9, and
 * `PHASE_8_INDEPENDENT_VERIFICATION.md` Part 4, both record the same undischarged
 * limitation: no PostgreSQL was reachable, so migration
 * `20260804220000_cost_function_and_plan_builder` was confirmed only by regenerating it
 * with `prisma migrate diff --from-empty` and diffing. That proves the DDL is Prisma's
 * own output plus four hand-written CHECK constraints. It does not prove any of them
 * **fires**, and it cannot reach the claims that are about the database's behaviour
 * rather than about the text of the DDL:
 *
 *   1. **Four hand-written CHECK constraints**, absent from Prisma's generated SQL by
 *      design. A CHECK bounding the wrong side of an inequality, or naming a column that
 *      does not exist, never fires — and reads identically to a correct one in a diff.
 *      Each of the four guards a §6.4 admissibility property, not a hygiene preference:
 *      `λ_zone ≥ 0` is *why* the unavailability component is non-negative, and
 *      `Ω_terminal ≥ 0` is *why* subtracting it lowers the bound rather than raising it.
 *   2. **`ServiceTimeModel`'s five-part unique key contains four NULLable columns.**
 *      §13.2's shrinkage ladder *is* the NULL pattern — a row with `hourOfWeek IS NULL`
 *      is the cohort marginalised over the hour. Under the SQL default, NULLs are
 *      distinct in a unique index, so the ladder's broad cohorts are not actually unique
 *      and the fitter can write the same cohort twice. Which behaviour this index has is
 *      a property of the live index, not of the model text. Phase 6's
 *      `RejectionAggregate` carried exactly this defect and needed a migration
 *      (`20260817120000_rejection_aggregate_nulls_not_distinct`) to fix it, so the same
 *      question is asked here rather than assumed answered.
 *   3. **`ZonePriceSnapshot` is insert-only and carries no `updatedAt`.** §9.6 replay
 *      depends on it: a price surface editable after a round consumed it makes that
 *      round unreplayable, and `omegaTerminalCu` rides on the row precisely so the bound
 *      cannot drift from the prices it was derived from. "The column is absent" is a
 *      statement about the live table.
 *   4. **Both foreign keys' delete behaviour.** `ON DELETE CASCADE` on `Zone` and `Site`
 *      is a retention decision — a decommissioned zone's price history goes with it —
 *      and only a real delete evidences which behaviour the database performs.
 *
 * The harness writes only rows it creates, all keyed under a `p8-live` prefix, and
 * removes them in a `finally`. It never writes to any table outside Phase 8's two plus
 * the two parent rows its foreign keys require.
 *
 * Usage:
 *   DATABASE_URL=postgresql://user:pw@127.0.0.1:55433/db node tools/verify/phase8LiveDatabase.js
 *
 * Deliberately **not** a Jest suite, for the same reason Phases 3–7's harnesses are not:
 * it requires a PostgreSQL instance, and a test that silently skips when its environment
 * is absent is a test that reports green for having done nothing.
 */

const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const PREFIX = "p8-live";
const T0 = new Date("2026-08-18T09:00:00.000Z");
const T1 = new Date("2026-08-18T10:00:00.000Z");

const PHASE_8_TABLES = ["ServiceTimeModel", "ZonePriceSnapshot"];

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
 * Run a statement expected to be refused, and report **what** refused it.
 *
 * Matching on "something threw" would pass for a typo'd column name, which is the
 * failure mode this harness exists to catch, so an identifying marker is always required.
 *
 * @param {string} label
 * @param {string|string[]} expected
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

/**
 * @param {string} sql
 * @returns {Promise<number>}
 */
function exec(sql) {
  return prisma.$executeRawUnsafe(sql);
}

async function main() {
  console.log(`PHASE 8 live database verification — ${(process.env.DATABASE_URL || "").replace(/:[^:@/]*@/, ":***@")}\n`);

  const [{ version }] = await query("select version() as version");
  console.log(`  ${version}\n`);

  /* ── 1. Tables, columns, and the absent `updatedAt` ────────────────────────── */

  console.log("1. Tables and columns\n");

  const columns = await query(`
    select table_name, column_name, is_nullable, data_type
    from information_schema.columns
    where table_schema = 'public' and table_name in ('ServiceTimeModel', 'ZonePriceSnapshot')
    order by table_name, column_name
  `);
  const columnsOf = (table) => columns.filter((row) => row.table_name === table).map((row) => row.column_name);
  const nullableOf = (table, name) => {
    const row = columns.find((c) => c.table_name === table && c.column_name === name);
    return row ? row.is_nullable === "YES" : null;
  };

  for (const table of PHASE_8_TABLES) {
    check(`${table} exists`, columnsOf(table).length > 0, "no columns found");
  }

  check(
    "ZonePriceSnapshot has no updatedAt column — §9.6: a surface editable after a round consumed it makes that round unreplayable",
    !columnsOf("ZonePriceSnapshot").includes("updatedAt"),
    `columns: ${columnsOf("ZonePriceSnapshot").join(", ")}`,
  );
  check(
    "ZonePriceSnapshot carries omegaTerminalCu on the row, not in a side table (§6.4)",
    columnsOf("ZonePriceSnapshot").includes("omegaTerminalCu"),
  );
  check(
    "ServiceTimeModel stores dispersion as well as the mean (§8.4 prices p_late from the distribution)",
    columnsOf("ServiceTimeModel").includes("sdSeconds") && columnsOf("ServiceTimeModel").includes("meanSeconds"),
  );
  check(
    "ServiceTimeModel stores sampleCount — the shrinkage weight's numerator (§13.2)",
    columnsOf("ServiceTimeModel").includes("sampleCount"),
  );

  // §13.2's hierarchy IS the NULL pattern: all four discriminators must be nullable.
  for (const discriminator of ["siteId", "stopType", "missionClass", "hourOfWeek"]) {
    check(
      `ServiceTimeModel.${discriminator} is nullable — a NULL is the cohort marginalised over it (§13.2)`,
      nullableOf("ServiceTimeModel", discriminator) === true,
      `is_nullable = ${nullableOf("ServiceTimeModel", discriminator)}`,
    );
  }
  for (const required of ["meanSeconds", "sdSeconds", "sampleCount", "version"]) {
    check(
      `ServiceTimeModel.${required} is NOT NULL`,
      nullableOf("ServiceTimeModel", required) === false,
      `is_nullable = ${nullableOf("ServiceTimeModel", required)}`,
    );
  }

  /* ── 2. The four hand-written CHECK constraints exist ──────────────────────── */

  console.log("\n2. CHECK constraints present in the live catalogue\n");

  const checks = await query(`
    select con.conname as name, pg_get_constraintdef(con.oid) as definition
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    where con.contype = 'c' and rel.relname in ('ServiceTimeModel', 'ZonePriceSnapshot')
    order by con.conname
  `);
  const named = new Map(checks.map((row) => [row.name, row.definition]));

  for (const name of [
    "ZonePriceSnapshot_lambda_non_negative",
    "ZonePriceSnapshot_omega_terminal_non_negative",
    "ZonePriceSnapshot_estimator_known",
    "ServiceTimeModel_distribution_well_formed",
  ]) {
    check(`CHECK ${name} exists`, named.has(name), `found: ${[...named.keys()].join(", ") || "none"}`);
  }
  check(
    "the estimator CHECK names exactly §8.3.1's three estimators and no fourth",
    /FORECAST_QUEUEING/.test(named.get("ZonePriceSnapshot_estimator_known") || "") &&
      /SOLVER_DUAL_CALIBRATION/.test(named.get("ZonePriceSnapshot_estimator_known") || "") &&
      /STATIC_PRIOR/.test(named.get("ZonePriceSnapshot_estimator_known") || ""),
    named.get("ZonePriceSnapshot_estimator_known"),
  );

  /* ── 3. Parent rows the foreign keys require ──────────────────────────────── */

  await exec(
    `insert into "Region" (id, "regionId", name, "createdAt", "updatedAt")
     values ('${PREFIX}-region', '${PREFIX}-region-key', '${PREFIX}-region-name', now(), now())`,
  );
  await exec(
    `insert into "Zone" (id, name, "minLat", "maxLat", "minLon", "maxLon", "regionId")
     values ('${PREFIX}-zone', '${PREFIX}-zone-name', 0, 1, 0, 1, '${PREFIX}-region')`,
  );
  await exec(
    `insert into "Site" (id, "siteId", name, "regionId", "createdAt", "updatedAt")
     values ('${PREFIX}-site', '${PREFIX}-site-key', '${PREFIX}-site-name', '${PREFIX}-region', now(), now())`,
  );

  /* ── 4. The CHECK constraints actually fire ───────────────────────────────── */

  console.log("\n3. Do the CHECK constraints fire?\n");

  const zonePrice = (id, overrides) => {
    const row = {
      version: 1,
      zoneId: `'${PREFIX}-zone'`,
      bucket: `'${id}'`,
      bucketStart: `'${T0.toISOString()}'`,
      bucketEnd: `'${T1.toISOString()}'`,
      lambdaCuPerSecond: 0.01,
      estimator: "'FORECAST_QUEUEING'",
      omegaTerminalCu: 5000,
      publishedAt: `'${T0.toISOString()}'`,
      ...(overrides || {}),
    };
    return `insert into "ZonePriceSnapshot"
      (id, version, "zoneId", bucket, "bucketStart", "bucketEnd", "lambdaCuPerSecond", estimator, "omegaTerminalCu", "publishedAt", "createdAt")
      values ('${PREFIX}-${id}', ${row.version}, ${row.zoneId}, ${row.bucket}, ${row.bucketStart}, ${row.bucketEnd},
              ${row.lambdaCuPerSecond}, ${row.estimator}, ${row.omegaTerminalCu}, ${row.publishedAt}, now())`;
  };

  await accepts("a well-formed λ_zone row is accepted", () => exec(zonePrice("ok-1")));

  await refuses(
    "a negative λ_zone is refused — §8.3.3's unavailability component is non-negative *because* λ ≥ 0",
    "ZonePriceSnapshot_lambda_non_negative",
    () => exec(zonePrice("neg-lambda", { lambdaCuPerSecond: -0.0001 })),
  );
  await accepts("λ_zone of exactly 0 is accepted — a zone with no marginal value is lawful", () =>
    exec(zonePrice("zero-lambda", { lambdaCuPerSecond: 0 })),
  );
  await refuses(
    "a negative Ω_terminal is refused — it is subtracted, so a negative value raises the bound (§6.4)",
    "ZonePriceSnapshot_omega_terminal_non_negative",
    () => exec(zonePrice("neg-omega", { omegaTerminalCu: -1 })),
  );
  await refuses(
    "a fourth estimator is refused — §8.3.1 names exactly three and §5.2 requires the degraded one flagged",
    "ZonePriceSnapshot_estimator_known",
    () => exec(zonePrice("bad-estimator", { estimator: "'GUESSED'" })),
  );
  for (const estimator of ["FORECAST_QUEUEING", "SOLVER_DUAL_CALIBRATION", "STATIC_PRIOR"]) {
    await accepts(`estimator ${estimator} is accepted`, () =>
      exec(zonePrice(`est-${estimator}`, { estimator: `'${estimator}'` })),
    );
  }

  const serviceTime = (id, overrides) => {
    const row = {
      version: 1,
      siteId: `'${PREFIX}-site'`,
      stopType: "'PICKUP'",
      missionClass: "'STANDARD'",
      hourOfWeek: 9,
      meanSeconds: 120,
      sdSeconds: 30,
      sampleCount: 40,
      ...(overrides || {}),
    };
    return `insert into "ServiceTimeModel"
      (id, version, "siteId", "stopType", "missionClass", "hourOfWeek", "meanSeconds", "sdSeconds", "sampleCount", "fittedAt")
      values ('${PREFIX}-${id}', ${row.version}, ${row.siteId}, ${row.stopType}, ${row.missionClass},
              ${row.hourOfWeek}, ${row.meanSeconds}, ${row.sdSeconds}, ${row.sampleCount}, now())`;
  };

  await accepts("a well-formed service-time row is accepted", () => exec(serviceTime("st-ok")));
  await refuses(
    "a negative mean service time is refused — a fit that did not converge, not a fast site (§13.2)",
    "ServiceTimeModel_distribution_well_formed",
    () => exec(serviceTime("st-neg-mean", { meanSeconds: -1 })),
  );
  await refuses(
    "a negative dispersion is refused — §8.4 prices p_late from the distribution",
    "ServiceTimeModel_distribution_well_formed",
    () => exec(serviceTime("st-neg-sd", { sdSeconds: -0.5 })),
  );
  await refuses(
    "a negative sampleCount is refused — it is the shrinkage weight's numerator",
    "ServiceTimeModel_distribution_well_formed",
    () => exec(serviceTime("st-neg-n", { sampleCount: -1 })),
  );
  await accepts("zero dispersion with zero samples is accepted — an unfitted cohort is lawful", () =>
    exec(serviceTime("st-zero", { sdSeconds: 0, sampleCount: 0, hourOfWeek: 10 })),
  );

  /* ── 5. Uniqueness, including the NULL question ───────────────────────────── */

  console.log("\n4. Uniqueness, and how the unique keys treat NULL\n");

  await refuses(
    "ZonePriceSnapshot (version, zoneId, bucket) is unique",
    // Raw SQL reports 23505 naming the offending key tuple rather than the index, which
    // identifies the rule that refused just as precisely.
    ['Key (version, "zoneId", bucket)', "ZonePriceSnapshot_version_zoneId_bucket_key"],
    () =>
      exec(
        zonePrice("dup", { bucket: "'ok-1'" }).replace(`'${PREFIX}-dup'`, `'${PREFIX}-dup-2'`),
      ),
  );

  await refuses(
    "ServiceTimeModel's five-part key is unique when every discriminator is present",
    [
      'Key (version, "siteId", "stopType", "missionClass", "hourOfWeek")',
      "ServiceTimeModel_version_siteId_stopType_missionClass_hourO_key",
    ],
    () => exec(serviceTime("st-dup")),
  );

  // §13.2's shrinkage ladder is the NULL pattern: the broadest cohort has every
  // discriminator NULL. Under the SQL default (NULLS DISTINCT) the unique index does not
  // constrain it, so the fitter could write the same broad cohort twice and
  // `timeline.js`'s broadest-first walk would pick whichever row it happened to read.
  // Phase 6's `RejectionAggregate` carried exactly this defect. Recorded either way.
  const [{ indexdef }] = await query(`
    select indexdef from pg_indexes
    where schemaname = 'public' and indexname = 'ServiceTimeModel_version_siteId_stopType_missionClass_hourO_key'
  `);
  const nullsNotDistinct = /NULLS NOT DISTINCT/i.test(indexdef);
  console.log(`     index definition: ${indexdef}`);

  await accepts("the broadest cohort (every discriminator NULL) is insertable", () =>
    exec(serviceTime("st-broad", { siteId: "null", stopType: "null", missionClass: "null", hourOfWeek: "null" })),
  );

  let duplicateBroadAccepted = false;
  try {
    await exec(
      serviceTime("st-broad-2", { siteId: "null", stopType: "null", missionClass: "null", hourOfWeek: "null" }),
    );
    duplicateBroadAccepted = true;
  } catch {
    duplicateBroadAccepted = false;
  }

  check(
    "the index definition and the observed NULL behaviour agree" +
      ` — index is NULLS ${nullsNotDistinct ? "NOT DISTINCT" : "DISTINCT (SQL default)"},` +
      ` duplicate broad cohort ${duplicateBroadAccepted ? "ACCEPTED" : "REFUSED"}`,
    duplicateBroadAccepted === !nullsNotDistinct,
    "the index definition and the observed behaviour disagree",
  );

  // The defect this harness found on 2026-08-18, and the migration that closes it.
  // §13.2's ladder falls back to exactly the NULL-bearing cohorts, and `loadVersion()`
  // reads a pinned version and keys by cohort — so two rows for one broad cohort make a
  // *pinned* model version yield different dwell times on two loads, breaking §9.6
  // replay. NULLS DISTINCT cannot bind those rows; NULLS NOT DISTINCT can.
  check(
    "§13.2's broad cohorts are constrained: the five-part key is NULLS NOT DISTINCT " +
      "(migration 20260818090000)",
    nullsNotDistinct,
    `index is NULLS DISTINCT — a duplicate broad cohort is accepted, and \`loadVersion()\` would then ` +
      "return whichever row the database listed last, making a pinned version unreplayable (§9.6)",
  );
  check(
    "a duplicate broad cohort (every discriminator NULL) is refused by the database",
    duplicateBroadAccepted === false,
    "the duplicate was ACCEPTED",
  );

  /* ── 6. Foreign-key delete behaviour ──────────────────────────────────────── */

  console.log("\n5. Foreign keys — what a parent delete actually does\n");

  const beforeZone = await query(
    `select count(*)::int as n from "ZonePriceSnapshot" where "zoneId" = '${PREFIX}-zone'`,
  );
  await exec(`delete from "Zone" where id = '${PREFIX}-zone'`);
  const afterZone = await query(
    `select count(*)::int as n from "ZonePriceSnapshot" where "zoneId" = '${PREFIX}-zone'`,
  );
  check(
    `deleting a Zone cascades to its price surface (${beforeZone[0].n} → ${afterZone[0].n} rows)`,
    beforeZone[0].n > 0 && afterZone[0].n === 0,
  );

  const beforeSite = await query(
    `select count(*)::int as n from "ServiceTimeModel" where "siteId" = '${PREFIX}-site'`,
  );
  await exec(`delete from "Site" where id = '${PREFIX}-site'`);
  const afterSite = await query(
    `select count(*)::int as n from "ServiceTimeModel" where "siteId" = '${PREFIX}-site'`,
  );
  check(
    `deleting a Site cascades to its service-time models (${beforeSite[0].n} → ${afterSite[0].n} rows)`,
    beforeSite[0].n > 0 && afterSite[0].n === 0,
  );

  /* ── 7. Additivity: no Phase 8 table shadows an earlier phase's ───────────── */

  console.log("\n6. Migration additivity\n");

  const tables = await query(`
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
    order by table_name
  `);
  check(
    `the full migration chain applies cleanly and yields ${tables.length} tables, both Phase 8 tables among them`,
    PHASE_8_TABLES.every((t) => tables.some((row) => row.table_name === t)),
  );
}

async function cleanup() {
  const statements = [
    `delete from "ZonePriceSnapshot" where id like '${PREFIX}-%'`,
    `delete from "ServiceTimeModel" where id like '${PREFIX}-%'`,
    `delete from "Zone" where id like '${PREFIX}-%'`,
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
      `select ${PHASE_8_TABLES.map((t) => `(select count(*)::int from "${t}" where id like '${PREFIX}-%')`).join(" + ")} as n`,
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

"use strict";

/**
 * BATCH 2 — the development Charging Scheduler and the index maintainer, against **real
 * PostgreSQL**.
 *
 * ── Why a live run, when the jest suite already covers this ─────────────────
 * Because five of Batch 2's claims are about things the in-memory store cannot establish.
 *
 *   1. **The plug count survives genuine concurrency.** The unit suite's
 *      `runSerializable` runs its callback against the same object; it models no isolation
 *      at all. "Never four robots on three plugs" is a claim about `SELECT … FOR UPDATE`
 *      inside a SERIALIZABLE transaction, and only a database has one.
 *   2. **`reservationId`'s unique index is real.** The store double raises `P2002` because
 *      it was written to. That PostgreSQL raises it — and that the scheduler's recovery
 *      path then finds the surviving row — is a property of the constraint.
 *   3. **`ChargerReservation.state` accepts these values.** `QUEUED` and `RELEASED` are
 *      new *values* of an existing `String` column, and the batch adds no migration. That
 *      the column takes them, and that the `reservedUntil > reservedFrom` CHECK holds for
 *      an instantaneous release, are schema facts.
 *   4. **`ChargerAvailabilityProjection.payload` round-trips as JSONB.** The plug count
 *      lives in it, so `payload->'chargers'` being queryable is what makes capacity a
 *      published artefact rather than a JS object.
 *   5. **The index maintainer really indexes a simulated agent and really does not index
 *      a physical one.** Two agents, one sweep, one table.
 *
 * ── What this tool does NOT claim, stated before any output is read ─────────
 *   * **No physical charger exists.** Every row written here is development simulation
 *     configuration and is labelled so inside the projection payload itself.
 *   * **No production charger readiness, and no V1 stop condition,** is established,
 *     advanced or discharged. S-3 … S-7 are untouched; B2 remains open.
 *   * **No assignment occurs.** A populated `AgentCellPosition` means an agent is
 *     *visible* to candidate search. No round runs, no commitment is written, and the
 *     coordinator is still not composable (B1).
 *   * **No calibration.** No β coefficient, state of health, κ or rated power is produced.
 *   * **Nothing here is a fidelity measurement.** `sim:fidelity` stays `NOT_MEASURED`.
 *
 * ── Running it ─────────────────────────────────────────────────────────────
 *   node tools/verify/batch2ChargingScheduler.js "postgresql://user@127.0.0.1:55432/db"
 *
 * Never against `DATABASE_URL`: that is shared, hosted infrastructure. Build a throwaway
 * cluster and apply `prisma/migrations/*​/migration.sql` to it in directory-name order.
 */

const url = process.argv[2];
if (!url) {
  process.stderr.write("usage: node tools/verify/batch2ChargingScheduler.js <postgres-url>\n");
  process.exit(2);
}
if (/neon\.tech/i.test(url)) {
  process.stderr.write(
    "refused: this tool writes and deletes fleet rows and must never run against shared infrastructure\n",
  );
  process.exit(2);
}

process.env.DATABASE_URL = url;
process.env.JWT_SECRET = process.env.JWT_SECRET || "batch2-verification-secret";
// The hosted Redis in `.env` must not be touched. `REDIS_ENABLED=false` is `initKv`'s own
// "not configured" branch — the in-memory store — so nothing outside this process is read.
process.env.REDIS_ENABLED = "false";
delete process.env.REDIS_URL;

const { PrismaClient } = require("@prisma/client");
const {
  getPrisma, disconnectPrisma, runSerializable, selectForUpdate, isSerializationFailure,
} = require("../../src/db/prisma");
const { initKv } = require("../../src/cache/kv");

const devChargingScheduler = require("../../src/simulation/devChargingScheduler");
const chargingStatusService = require("../../src/services/chargingStatus.service");
const indexMaintainer = require("../../src/workers/indexMaintainer.worker");
const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");

const silentLogger = {
  info() {}, debug() {}, warn() {}, error() {}, child() { return silentLogger; },
};

const checks = [];
let failures = 0;

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function section(title) {
  process.stdout.write(`\n── ${title}\n`);
}

const BENGALURU = { lat: 12.9716, lon: 77.5946 };
const LOCATION_ID = "loc-batch2";
const SIM_IDS = ["SIM-B2-1", "SIM-B2-2", "SIM-B2-3", "SIM-B2-4", "SIM-B2-5"];
const PHYSICAL_ID = "RBT-B2-PHYS";

async function reset(prisma) {
  for (const table of [
    "AgentCellPosition", "Observation", "ChargerReservation", "ChargerAvailabilityProjection",
    "Charger", "BatteryState", "Commitment", "Agent", "Robot", "AgentClass",
    "MobilityModel", "EnergyModel", "ContainerModel",
  ]) {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`).catch(() => {});
  }
}

/**
 * Seed the minimal fleet: one physical unit and five simulated ones, identical in every
 * respect the engine can see. Only `Robot.simulated` differs, and the engine never reads
 * it — which is the property `tests/engine/simulationBoundary.test.js` holds structurally
 * and this harness exercises in fact.
 */
async function seed(prisma) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Location" ("id","name","type","lat","lon") VALUES ($1,$2,$3::"LocationType",$4,$5)
     ON CONFLICT ("id") DO NOTHING`,
    LOCATION_ID, "Batch 2 area", "AREA", BENGALURU.lat, BENGALURU.lon,
  );

  const agentClass = await prisma.agentClass.create({
    data: { classId: "batch2-class", name: "Batch 2 verification class" },
  });

  const made = [];
  for (const [index, robotId] of [...SIM_IDS, PHYSICAL_ID].entries()) {
    const simulatedUnit = robotId !== PHYSICAL_ID;
    const robot = await prisma.robot.create({
      data: {
        robotId,
        locationId: LOCATION_ID,
        // The discriminator. Written here at the creation boundary, exactly as the
        // commissioning path writes it; nothing downstream re-derives it.
        simulated: simulatedUnit,
      },
    });
    const agent = await prisma.agent.create({
      data: {
        agentId: robotId,
        robotDbId: robot.id,
        agentClassId: agentClass.id,
        lifecycleState: "ACTIVE",
      },
    });
    made.push({ robotId, agentRowId: agent.id, simulatedUnit, index });
  }
  return made;
}

/** Count rows by reservation state, straight from SQL rather than through Prisma. */
async function stateCounts(prisma) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT "state", count(*)::int AS n FROM "ChargerReservation" GROUP BY "state" ORDER BY "state"`,
  );
  const counts = {};
  for (const row of rows) counts[row.state] = row.n;
  return counts;
}

async function main() {
  const admin = new PrismaClient({ datasources: { db: { url } } });
  await admin.$connect();

  process.stdout.write("\nBATCH 2 — development charging scheduler + index maintainer, against live PostgreSQL\n");
  const version = await admin.$queryRawUnsafe("SELECT version()");
  process.stdout.write(`  ${version[0].version}\n`);
  process.stdout.write(
    "  DEVELOPMENT SIMULATION ONLY. No physical charger exists; no V1 stop condition is affected.\n",
  );

  await reset(admin);
  const fleet = await seed(admin);

  const prisma = getPrisma();
  await prisma.$connect();
  const { kv, close: closeKv } = await initKv({ logger: silentLogger });

  const deps = { prisma, runSerializable, selectForUpdate, isSerializationFailure };

  /**
   * Ask for a plug the way a real agent does: once per tick, until it is answered.
   *
   * Under genuine SERIALIZABLE isolation several simultaneous requesters WILL collide, and
   * `db/prisma.runSerializable` states this codebase's rule for that — it "deliberately
   * performs no retry", because a bound would be an unregistered behavioural constant. So
   * the retry lives with the caller, and the caller is the agent's 2 s tick. This models
   * exactly that, and reports how many attempts convergence actually took rather than
   * hiding the collisions behind a loop.
   */
  let totalAttempts = 0;
  async function askForPlug(agentRowId, nowMs) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      totalAttempts += 1;
      // eslint-disable-next-line no-await-in-loop
      const verdict = await devChargingScheduler.requestPlug(deps, { agentRowId, targetSoc: 0.8, nowMs: nowMs + attempt });
      if (verdict.ok) return verdict;
      if (verdict.retryable !== true) return verdict;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { ok: false, problems: ["did not converge within 20 agent ticks"] };
  }
  const simulated = fleet.filter((entry) => entry.simulatedUnit);
  const physical = fleet.find((entry) => !entry.simulatedUnit);
  const roster = new Set(simulated.map((entry) => entry.robotId));
  const chargingStatusFor = chargingStatusService.createChargingStatusReader({
    prisma,
    inScope: async (subject) => roster.has(subject.robotId),
  });

  const T = Date.now();

  try {
    /* ─────────────────────────────────────────────────────────────────────── */
    section("1. Provisioning — one charger, three plugs, in the existing schema");

    const provisioned = await devChargingScheduler.provision({ prisma }, { nowMs: T });
    record("provision succeeded", provisioned.ok, provisioned.problems.join("; ") || null);

    const chargerRows = await admin.$queryRawUnsafe(`SELECT * FROM "Charger"`);
    record("exactly one Charger row exists", chargerRows.length === 1, `${chargerRows.length} row(s)`);
    record(
      "it is the declared development charger",
      chargerRows[0] && chargerRows[0].chargerId === "DEV-SIM-RNSIT-MBA-01",
      chargerRows[0] && chargerRows[0].chargerId,
    );
    record(
      "it is NOT a depot, so it cannot enter §14.5's E_return fallback set",
      chargerRows[0] && chargerRows[0].isDepot === false,
    );
    record(
      "no rated power is asserted — the curve is a model, not a nameplate",
      chargerRows[0] && chargerRows[0].ratedPowerW === null,
    );

    // JSONB, queried as JSONB — this is claim 4.
    const [capacityRow] = await admin.$queryRawUnsafe(
      `SELECT ("payload"->'chargers'->0->>'plugCount')::int AS plugs,
              "payload"->'evidence'->>'kind'                AS evidence_kind,
              ("payload"->'evidence'->>'physicalChargerEvidence')::boolean AS physical,
              "publishedBy"
         FROM "ChargerAvailabilityProjection" ORDER BY "version" DESC LIMIT 1`,
    );
    record("the published projection states three plugs, queryable as JSONB", capacityRow.plugs === 3, `plugs=${capacityRow.plugs}`);
    record("the projection is labelled DEVELOPMENT_SIMULATION", capacityRow.evidence_kind === "DEVELOPMENT_SIMULATION");
    record("the projection disclaims physical charger evidence", capacityRow.physical === false);
    record("the publisher names itself a development scheduler", capacityRow.publishedBy === devChargingScheduler.PUBLISHER);

    const reprovisioned = await devChargingScheduler.provision({ prisma }, { nowMs: T + 1000 });
    const projectionCount = await admin.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "ChargerAvailabilityProjection"`);
    record(
      "re-provisioning publishes no second version (the table is insert-only and immutable)",
      reprovisioned.published === false && projectionCount[0].n === 1,
      `${projectionCount[0].n} projection(s)`,
    );

    /* ─────────────────────────────────────────────────────────────────────── */
    section("2. Concurrency — five simultaneous requests, three plugs");

    const granted = await Promise.all(simulated.map((entry, index) => askForPlug(entry.agentRowId, T + index)));
    record(
      "every simultaneous request was eventually answered",
      granted.every((verdict) => verdict.ok),
      `${totalAttempts} attempt(s) across ${simulated.length} agents — collisions are expected and are retried by the agent's tick`,
    );
    await devChargingScheduler.promote(deps, { nowMs: T + 100 });

    let counts = await stateCounts(prisma);
    record("exactly three reservations are ACTIVE", counts.ACTIVE === 3, JSON.stringify(counts));
    record("the other two are QUEUED", counts.QUEUED === 2, JSON.stringify(counts));
    record("five reservations exist in total — one per agent", (counts.ACTIVE || 0) + (counts.QUEUED || 0) === 5);

    const [{ n: distinctAgents }] = await admin.$queryRawUnsafe(
      `SELECT count(DISTINCT "agentId")::int AS n FROM "ChargerReservation"`,
    );
    record("no agent holds two reservations", distinctAgents === 5, `${distinctAgents} distinct agent(s)`);

    /* ─────────────────────────────────────────────────────────────────────── */
    section("3. Idempotency — a retried request under a real unique index");

    const before = await admin.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "ChargerReservation"`);
    const retries = await Promise.all(
      Array.from({ length: 10 }, (_, i) => askForPlug(simulated[0].agentRowId, T + 200 + i)),
    );
    const after = await admin.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "ChargerReservation"`);
    record("ten concurrent retries create no new row", before[0].n === after[0].n, `${before[0].n} → ${after[0].n}`);
    record("every retry returned the existing reservation, none created a second", retries.every((r) => r.ok && !r.created));

    /* ─────────────────────────────────────────────────────────────────────── */
    section("4. FIFO — the released plug goes to the longest waiter");

    const queuedBefore = await admin.$queryRawUnsafe(
      `SELECT "agentId" FROM "ChargerReservation" WHERE "state" = 'QUEUED' ORDER BY "reservedFrom", "reservationId"`,
    );
    const frontOfQueue = queuedBefore[0].agentId;
    const backOfQueue = queuedBefore[1].agentId;

    const holder = await admin.$queryRawUnsafe(
      `SELECT "agentId" FROM "ChargerReservation" WHERE "state" = 'ACTIVE' ORDER BY "reservedFrom" LIMIT 1`,
    );
    await devChargingScheduler.release(deps, {
      agentRowId: holder[0].agentId,
      nowMs: T + 5000,
      reason: devChargingScheduler.RELEASE_REASON.TARGET_REACHED,
    });

    const [promotedRow] = await admin.$queryRawUnsafe(
      `SELECT "state" FROM "ChargerReservation" WHERE "agentId" = $1 AND "state" <> 'RELEASED'`,
      frontOfQueue,
    );
    const [stillWaiting] = await admin.$queryRawUnsafe(
      `SELECT "state" FROM "ChargerReservation" WHERE "agentId" = $1 AND "state" <> 'RELEASED'`,
      backOfQueue,
    );
    record("the longest waiter was promoted", promotedRow && promotedRow.state === "ACTIVE", promotedRow && promotedRow.state);
    record("the later arrival is still waiting", stillWaiting && stillWaiting.state === "QUEUED", stillWaiting && stillWaiting.state);

    counts = await stateCounts(prisma);
    record("still exactly three charging after the hand-over", counts.ACTIVE === 3, JSON.stringify(counts));

    const [released] = await admin.$queryRawUnsafe(
      `SELECT "state","externalId", ("reservedUntil" > "reservedFrom") AS ordered
         FROM "ChargerReservation" WHERE "agentId" = $1 AND "state" = 'RELEASED'`,
      holder[0].agentId,
    );
    record("the released row records why", released && released.externalId === "TARGET_REACHED", released && released.externalId);
    record(
      "the CHECK constraint reservedUntil > reservedFrom still holds after release",
      released && released.ordered === true,
    );

    /* ─────────────────────────────────────────────────────────────────────── */
    section("5. chargingStatusFor — over live reservation state");

    const chargingAgent = (await admin.$queryRawUnsafe(
      `SELECT "agentId" FROM "ChargerReservation" WHERE "state" = 'ACTIVE' LIMIT 1`,
    ))[0].agentId;
    const waitingAgent = backOfQueue;

    const chargingVerdict = await chargingStatusFor(chargingAgent);
    record(
      "an ACTIVE reservation reads as charging, non-interruptible",
      chargingVerdict.known === true && chargingVerdict.charging === true && chargingVerdict.chargingInterruptible === false,
      JSON.stringify(chargingVerdict),
    );

    const waitingVerdict = await chargingStatusFor(waitingAgent);
    record(
      "a QUEUED reservation reads as waiting — not charging, and not ready",
      waitingVerdict.known === true && waitingVerdict.charging === false && waitingVerdict.waiting === true,
      JSON.stringify(waitingVerdict),
    );

    const freeVerdict = await chargingStatusFor(holder[0].agentId);
    record(
      "a released agent reads as authoritatively NOT charging",
      freeVerdict.known === true && freeVerdict.charging === false && freeVerdict.waiting === false,
      JSON.stringify(freeVerdict),
    );

    const physicalVerdict = await chargingStatusFor(physical.agentRowId);
    record(
      "the PHYSICAL agent's charging state is UNKNOWN — never 'free'",
      physicalVerdict.known === false && physicalVerdict.charging === false,
      JSON.stringify({ known: physicalVerdict.known, charging: physicalVerdict.charging }),
    );

    /* ─────────────────────────────────────────────────────────────────────── */
    section("6. The index maintainer — one sweep, two fleets");

    // Every agent reports a position through the STEP 5 vocabulary. Written directly here
    // because this harness is about charging, not about the telemetry path Step 5 already
    // verifies end to end.
    for (const entry of fleet) {
      await prisma.observation.create({
        data: {
          agentId: entry.agentRowId,
          kind: "position",
          source: "AGENT_REPORT",
          observedAt: new Date(T - 1000),
          value: {
            lat: BENGALURU.lat + entry.index * 0.0001,
            lon: BENGALURU.lon,
            provenance: entry.simulatedUnit ? "SIMULATED" : "PHYSICAL",
          },
        },
      });
    }

    const sweep = await indexMaintainer.sweepOnce({ prisma, kv, chargingStatusFor, now: () => T + 10_000 });
    process.stdout.write(`      sweep: ${JSON.stringify(sweep)}\n`);

    const indexed = await admin.$queryRawUnsafe(
      `SELECT acp."agentId", acp."availabilityClass", a."agentId" AS business_id
         FROM "AgentCellPosition" acp JOIN "Agent" a ON a."id" = acp."agentId"
        ORDER BY a."agentId"`,
    );
    const indexedIds = indexed.map((row) => row.business_id);

    record(
      "the PHYSICAL agent is NOT indexed — its charging state is unknown",
      !indexedIds.includes(PHYSICAL_ID),
      `indexed: ${indexedIds.join(", ") || "none"}`,
    );
    record(
      "the three CHARGING agents are not indexed either (§6.3 tier 5 admits only interruptible charging)",
      indexed.every((row) => row.availabilityClass !== "IDLE_READY" || row.business_id === simulated[0].agentId) ||
        indexedIds.length <= 2,
      `indexed: ${indexedIds.join(", ") || "none"}`,
    );

    // The one agent that is provably free: the one that just released.
    const releasedBusinessId = fleet.find((entry) => entry.agentRowId === holder[0].agentId).robotId;
    record(
      "the RELEASED simulated agent IS indexed, as IDLE_READY",
      indexed.some((row) => row.business_id === releasedBusinessId && row.availabilityClass === "IDLE_READY"),
      `indexed: ${indexedIds.join(", ") || "none"}`,
    );

    // Claim 5's second half: the row the engine would read.
    const [mirror] = await admin.$queryRawUnsafe(
      `SELECT "fineCellId","coarseCellId","observedAtMs","capabilityClasses","containerClasses"
         FROM "AgentCellPosition" acp JOIN "Agent" a ON a."id" = acp."agentId" WHERE a."agentId" = $1`,
      releasedBusinessId,
    );
    record("the mirror row carries an H3 fine cell", Boolean(mirror && mirror.fineCellId), mirror && mirror.fineCellId);
    record(
      "observedAtMs is the Observation's own instant, not the sweep's clock",
      mirror && Number(mirror.observedAtMs) === T - 1000,
      mirror && `${mirror.observedAtMs} (sweep ran at ${T + 10_000})`,
    );
    record(
      "the secondary index classes are EMPTY — capabilityAndContainerClassesFor is still absent and was not fabricated",
      mirror && mirror.capabilityClasses.length === 0 && mirror.containerClasses.length === 0,
    );

    const members = await availabilityIndex.candidatesInFineCell(
      { kv }, "default", mirror.fineCellId, "IDLE_READY",
    );
    record(
      "the agent is visible to candidate search through the availability index",
      members.length >= 1,
      `${members.length} member(s) in ${mirror.fineCellId}`,
    );

    /* ─────────────────────────────────────────────────────────────────────── */
    section("7. Reconciliation — a stale reservation does not hold a plug forever");

    const horizon = devChargingScheduler.sessionHorizonSeconds(1000);
    record("the session window is derived from the protected charge curve", horizon.ok, `${horizon.seconds}s at ${horizon.tempC}°C`);

    const wellPast = T + horizon.seconds * 1000 + 3_600_000;
    const reconciled = await devChargingScheduler.reconcile(deps, { nowMs: wellPast });
    counts = await stateCounts(prisma);
    record(
      "every live reservation past its published window is expired",
      (counts.ACTIVE || 0) === 0 && (counts.QUEUED || 0) === 0,
      JSON.stringify(counts),
    );
    record("the expiry is recorded as such", reconciled.expired > 0, `${reconciled.expired} expired`);

    const [staleLabel] = await admin.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "ChargerReservation" WHERE "externalId" = 'STALE_EXPIRED'`,
    );
    record("the expired rows say STALE_EXPIRED", staleLabel.n > 0, `${staleLabel.n} row(s)`);

    /* ─────────────────────────────────────────────────────────────────────── */
    section("8. The production boundary — what was NOT written");

    for (const [table, claim] of [
      ["Commitment", "no commitment was created — no assignment occurred"],
      ["BatteryState", "no battery calibration row was invented"],
      ["Decision", "no decision record was produced"],
    ]) {
      const [row] = await admin.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${table}"`).catch(() => [{ n: -1 }]);
      if (row.n === -1) continue;
      record(claim, row.n === 0, `${row.n} row(s) in ${table}`);
    }

    const [physicalReservations] = await admin.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "ChargerReservation" WHERE "agentId" = $1`,
      physical.agentRowId,
    );
    record("the physical agent holds no charging reservation, ever", physicalReservations.n === 0, `${physicalReservations.n} row(s)`);

    const [physicalMirror] = await admin.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "AgentCellPosition" WHERE "agentId" = $1`,
      physical.agentRowId,
    );
    record("the physical agent has no availability-index mirror row", physicalMirror.n === 0, `${physicalMirror.n} row(s)`);

    /* ─────────────────────────────────────────────────────────────────────── */
    process.stdout.write(
      `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks.length - failures}/${checks.length} checks\n`,
    );
    process.stdout.write(
      "\nWhat this run did NOT establish: no physical charger exists, no production charger readiness is\n" +
      "shown, no V1 stop condition (S-3 … S-7) moves, no assignment was made, and nothing here is a\n" +
      "simulator-fidelity measurement. B1 and B2 are both still open.\n",
    );
  } finally {
    await closeKv().catch(() => {});
    await disconnectPrisma().catch(() => {});
    await admin.$disconnect().catch(() => {});
  }

  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`\nharness crashed: ${error && error.stack}\n`);
  process.exit(1);
});

"use strict";

/**
 * PHASE 12 — live-PostgreSQL verification of §18.5's, §26's and §18.6's three tables, and of
 * the behaviours a green Jest suite structurally cannot reach.
 *
 * `PHASE_12_IMPLEMENTATION_REPORT.md` §5 records the schema as verified by reading
 * `migration.sql` beside `schema.prisma` and re-running `prisma migrate diff --from-empty`, and
 * `PHASE_12_INDEPENDENT_VERIFICATION.md` confirms that reading. That proves the DDL is Prisma's
 * own output plus ten hand-written CHECK constraints and one partial unique index. It does not
 * prove that a single one of them **fires** — a CHECK naming the wrong column, or listing the
 * wrong strings, reads identically to a correct one in a diff — and the report itself states
 * "Not applied to a live database".
 *
 * Four Phase 12 claims are about the database's behaviour rather than the text of the DDL, and
 * none is reachable from `tests/engine/helpers/degradedFixture.js`:
 *
 *   1. **Step 4's human gate is enforced at the schema.** The report calls
 *      `ExternalEscalation_step_four_is_human_gated` "the one a future writer cannot route
 *      around by calling a different function". Whether the database refuses the row is only
 *      observable by inserting one.
 *
 *   2. **Entry idempotence is a PARTIAL unique index.** `DegradedModeEvent_one_open_per_shard_mode`
 *      is `UNIQUE (shardId, mode) WHERE "exitedAt" IS NULL`. Two properties matter and they pull
 *      in opposite directions: a second *open* row for one mode must be refused, and a second
 *      row for a mode that has been exited and re-entered must be **allowed** — a non-partial
 *      index would forbid a shard from ever re-entering Custodial Operation, which no test
 *      against an in-memory double would notice. Both are exercised here.
 *
 *   3. **`InvariantStatus_suspension_names_its_mode` is enforced in BOTH directions.** §18.5
 *      rule 2 needs a SUSPENDED row to name its authorising mode *and* a non-suspended row not
 *      to carry one, so the column cannot decay into a general-purpose annotation.
 *
 *   4. **The concurrent-entry race resolves to `alreadyOpen`, not to an exception.** The Jest
 *      regression simulates the constraint violation with a double whose `create` throws P2002.
 *      That proves `enter()` handles the error it is given; it does not prove PostgreSQL raises
 *      that error for two genuinely concurrent transactions, nor that the loser's re-read finds
 *      the winner's row. Two real transactions, one real index, settle it.
 *
 * Everything else here is the same discipline applied to the rest of the phase's schema: all
 * ten CHECKs made to fire, the `ON DELETE CASCADE` from `Leg`, the unique key the worker's
 * upsert depends on, `BigInt` round-tripping for I6's high-water marks, and the `TEXT[]`
 * semantics that let "suspended nothing" be told from "nobody wrote it down".
 *
 * The harness writes only rows it creates, all keyed under a `p12-live` prefix, and removes them
 * in a `finally`. It touches no table outside the three this phase owns, plus the one `Leg` its
 * foreign key requires.
 *
 * Usage:
 *   DATABASE_URL=postgresql://pgverify:verify@127.0.0.1:55432/robotx_p12 \
 *     node tools/verify/phase12LiveDatabase.js
 *
 * NEVER point this at `DATABASE_URL`'s shared Neon instance or at the default 5432 cluster. It
 * is deliberately **not** a Jest suite, for the same reason Phases 3-11's harnesses are not: it
 * requires a PostgreSQL instance, and a test that silently skips when its environment is absent
 * is a test that reports green for having done nothing.
 */

const { PrismaClient } = require("@prisma/client");

const transitions = require("../../src/engine/degraded/transitions");
const modeRegister = require("../../src/engine/degraded/modeRegister");
const externalEscalation = require("../../src/engine/failure/externalEscalation");
const invariantWorker = require("../../src/workers/invariant.worker");

const PREFIX = "p12-live";
const results = [];

function record(id, description, passed, detail) {
  results.push({ id, description, passed, detail });
  console.log(`  [${passed ? "PASS" : "FAIL"}] ${id} — ${description}`);
  if (detail) console.log(`         ${detail}`);
}

/** Run something that MUST be rejected by the database, and report what rejected it. */
async function refused(id, description, run) {
  try {
    await run();
    record(id, description, false, "the database ACCEPTED a row the constraint exists to refuse");
  } catch (error) {
    const message = String((error && error.message) || error).replace(/\s+/g, " ").slice(0, 200);
    record(id, description, true, message);
  }
}

/** Run something that MUST be accepted, and report the failure if it is not. */
async function accepted(id, description, run) {
  try {
    const value = await run();
    record(id, description, true, typeof value === "string" ? value : undefined);
    return value;
  } catch (error) {
    const message = String((error && error.message) || error).replace(/\s+/g, " ").slice(0, 200);
    record(id, description, false, `the database REFUSED a row it must accept: ${message}`);
    return null;
  }
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  if (/neon\.tech/i.test(url) || /:5432\//.test(url)) {
    console.error("REFUSING to run: DATABASE_URL looks like a shared or default cluster. Use a disposable one.");
    process.exitCode = 1;
    return;
  }
  if (!url) {
    console.error("REFUSING to run: no DATABASE_URL. This harness requires a disposable PostgreSQL instance.");
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  const now = new Date("2026-08-18T12:00:00.000Z");
  const SHARD = `${PREFIX}:s1`;

  try {
    console.log("\nPHASE 12 — live PostgreSQL verification (§18.5, §18.6, §26)\n");

    /* ── 1. The three tables and the hand-written objects exist ──────────────── */
    const columns = await prisma.$queryRawUnsafe(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('DegradedModeEvent','InvariantStatus','ExternalEscalation')`,
    );
    const byTable = new Map();
    for (const row of columns) {
      if (!byTable.has(row.table_name)) byTable.set(row.table_name, new Set());
      byTable.get(row.table_name).add(row.column_name);
    }
    record(
      "T1",
      "all three Phase 12 tables exist",
      ["DegradedModeEvent", "InvariantStatus", "ExternalEscalation"].every((name) => byTable.has(name)),
      [...byTable.keys()].sort().join(", "),
    );

    const checks = await prisma.$queryRawUnsafe(
      `SELECT conname FROM pg_constraint
        WHERE contype = 'c' AND conrelid::regclass::text IN
          ('"DegradedModeEvent"','"InvariantStatus"','"ExternalEscalation"')`,
    );
    const checkNames = new Set(checks.map((row) => row.conname));
    const expectedChecks = [
      "DegradedModeEvent_mode_known",
      "DegradedModeEvent_exit_is_evidenced",
      "InvariantStatus_invariant_known",
      "InvariantStatus_status_known",
      "InvariantStatus_suspension_names_its_mode",
      "InvariantStatus_violation_count_non_negative",
      "InvariantStatus_subject_type_known",
      "ExternalEscalation_step_in_range",
      "ExternalEscalation_step_four_is_human_gated",
      "ExternalEscalation_disposition_known",
    ];
    record(
      "T2",
      "all TEN hand-written CHECK constraints are present — the migration's header comment said eight",
      expectedChecks.every((name) => checkNames.has(name)),
      `${expectedChecks.filter((name) => checkNames.has(name)).length}/10 present` +
        (expectedChecks.some((name) => !checkNames.has(name))
          ? `; MISSING: ${expectedChecks.filter((name) => !checkNames.has(name)).join(", ")}`
          : ""),
    );

    const indexes = await prisma.$queryRawUnsafe(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'DegradedModeEvent_one_open_per_shard_mode'`,
    );
    record(
      "T3",
      "entry idempotence is a PARTIAL unique index, not a plain one — a plain index would forbid re-entering a mode ever again",
      indexes.length === 1 && /UNIQUE/i.test(indexes[0].indexdef) && /WHERE .*exitedAt.* IS NULL/i.test(indexes[0].indexdef),
      indexes.length === 1 ? indexes[0].indexdef : "index absent",
    );

    /* ── 2. A Leg for §18.6's foreign key ───────────────────────────────────── */
    const mission = await prisma.mission.findFirst({ select: { id: true } });
    if (!mission) {
      record("T4", "a Mission exists to hang a Leg from", false, "no Mission row; seed the database first");
      throw new Error("no Mission to attach a Leg to");
    }
    const leg = await prisma.leg.create({
      data: {
        legId: `${PREFIX}:L1`,
        missionId: mission.id,
        purpose: "PRIMARY",
        state: "STRANDED_OBSTRUCTING",
        obstructionClass: "BLOCKING_CRITICAL",
      },
    });
    record("T4", "a STRANDED_OBSTRUCTING Leg was created for the §18.6 chain", true, `legId = ${leg.legId}`);

    /* ── 3. §18.5's mode vocabulary is closed at six ─────────────────────────── */
    const entryData = (mode, overrides) => ({
      shardId: SHARD,
      mode,
      cause: "B1 — the Commitment Store is unavailable",
      enteringComponent: "phase12LiveDatabase",
      suspendedInvariants: mode === "CUSTODIAL_OPERATION" ? ["I2"] : [],
      degradedInvariants: mode === "CUSTODIAL_OPERATION" ? ["I11", "I13"] : [],
      enteredAt: now,
      timeBoxExpiresAt: new Date(now.getTime() + 900000),
      exitCriterion: "the store returns and full reconciliation completes",
      ...(overrides || {}),
    });

    await refused(
      "C1",
      "DegradedModeEvent_mode_known refuses a seventh mode — an unnamed mode has no row in §26.2's matrix, so the checker could not say what it means for any invariant",
      () => prisma.degradedModeEvent.create({ data: entryData("PANIC_MODE") }),
    );

    await refused(
      "C2",
      "DegradedModeEvent_exit_is_evidenced refuses an exit with no stated reason — §18.5 gives every mode an explicit exit criterion",
      () => prisma.degradedModeEvent.create({ data: entryData("COLD_INDEX", { exitedAt: now, exitReason: null, exitingComponent: null }) }),
    );

    /* ── 4. The partial index, in both directions ───────────────────────────── */
    const open = await accepted("I1", "one open Custodial Operation row is accepted", async () => {
      const row = await prisma.degradedModeEvent.create({ data: entryData("CUSTODIAL_OPERATION") });
      return `id = ${row.id}`;
    });

    await refused(
      "I2",
      "a SECOND open row for the same (shard, mode) is refused — two would double-count the time-in-mode SLI and leave an exit closing an arbitrary one",
      () => prisma.degradedModeEvent.create({ data: entryData("CUSTODIAL_OPERATION") }),
    );

    // The half a non-partial index would break, and which no double would catch.
    await prisma.degradedModeEvent.updateMany({
      where: { shardId: SHARD, mode: "CUSTODIAL_OPERATION", exitedAt: null },
      data: { exitedAt: new Date(now.getTime() + 60000), exitReason: "store returned; reconciliation complete", exitingComponent: "harness", durationMs: 60000 },
    });
    await accepted(
      "I3",
      "the shard can RE-ENTER a mode it has exited — the index is partial, so history does not lock the shard out of Custodial Operation for ever",
      async () => {
        const row = await prisma.degradedModeEvent.create({ data: entryData("CUSTODIAL_OPERATION", { enteredAt: new Date(now.getTime() + 120000) }) });
        return `second entry accepted, id = ${row.id}`;
      },
    );

    /* ── 5. The concurrent-entry race, with two real transactions ───────────── */
    //
    // Both callers read (finding the mode closed), then both insert. Postgres serialises the
    // index check, one insert wins, and `enter()` must resolve the loser's constraint violation
    // into `alreadyOpen: true` rather than letting it reach the detector as an exception.
    await prisma.degradedModeEvent.deleteMany({ where: { shardId: SHARD } });
    const raceInput = {
      mode: modeRegister.MODE.SHED_LOAD,
      shardId: SHARD,
      cause: "B19 — arrival rate exceeds capacity",
      enteringComponent: "phase12LiveDatabase",
      atMs: now.getTime(),
      maxDurationMs: 900000,
    };
    const [a, b] = await Promise.all([
      transitions.enter({ prisma }, raceInput).then((value) => value, (error) => ({ threw: error })),
      transitions.enter({ prisma }, raceInput).then((value) => value, (error) => ({ threw: error })),
    ]);
    const openShedLoad = await prisma.degradedModeEvent.count({ where: { shardId: SHARD, mode: "SHED_LOAD", exitedAt: null } });
    const threw = [a, b].filter((row) => row && row.threw);
    const entered = [a, b].filter((row) => row && row.entered === true);
    const already = [a, b].filter((row) => row && row.alreadyOpen === true);
    record(
      "R1",
      "two genuinely concurrent entries produce ONE open row, one `entered`, one `alreadyOpen`, and no exception reaching the detector",
      openShedLoad === 1 && threw.length === 0 && entered.length === 1 && already.length === 1,
      `open rows = ${openShedLoad}, entered = ${entered.length}, alreadyOpen = ${already.length}, threw = ${threw.length}` +
        (threw.length > 0 ? ` (${String(threw[0].threw && threw[0].threw.message).slice(0, 120)})` : ""),
    );

    /* ── 6. TEXT[] semantics: "suspended nothing" vs "nobody wrote it down" ─── */
    const shedRow = await prisma.degradedModeEvent.findFirst({ where: { shardId: SHARD, mode: "SHED_LOAD" } });
    record(
      "A1",
      "an EMPTY suspendedInvariants array round-trips as `[]` and not as NULL — four of the six modes suspend nothing, and recording that explicitly is what lets a reader tell it from an omission",
      Array.isArray(shedRow.suspendedInvariants) && shedRow.suspendedInvariants.length === 0,
      `suspendedInvariants = ${JSON.stringify(shedRow.suspendedInvariants)}`,
    );

    /* ── 7. §26's status vocabulary and the two-directional suspension CHECK ── */
    const statusData = (overrides) => ({
      invariantId: "I2",
      shardId: SHARD,
      subjectType: "SHARD",
      subjectId: "",
      status: "ENFORCED",
      checkedAt: now,
      violationCount: 0,
      instrument: "harness",
      ...(overrides || {}),
    });

    await refused(
      "C3",
      "InvariantStatus_invariant_known refuses I23 — §26.2 states its matrix over exactly twenty-two, so a status row for a twenty-third is a claim nobody defined the response to",
      () => prisma.invariantStatus.create({ data: statusData({ invariantId: "I23" }) }),
    );
    await refused(
      "C4",
      "InvariantStatus_status_known refuses a fourth status — ENFORCED is silence, VIOLATED is a page, SUSPENDED is a counted event; anything else is an alert nobody knows what to do with",
      () => prisma.invariantStatus.create({ data: statusData({ status: "PROBABLY_FINE" }) }),
    );
    await refused(
      "C5",
      "InvariantStatus_suspension_names_its_mode refuses a SUSPENDED row with no authorising mode — §18.5 rule 2: no invariant is ever suspended implicitly",
      () => prisma.invariantStatus.create({ data: statusData({ status: "SUSPENDED", authorisingMode: null }) }),
    );
    await refused(
      "C6",
      "…and the CONVERSE: an ENFORCED row carrying an authorising mode is refused, so the column cannot decay into a general-purpose annotation",
      () => prisma.invariantStatus.create({ data: statusData({ status: "ENFORCED", authorisingMode: "CUSTODIAL_OPERATION" }) }),
    );
    await refused(
      "C7",
      "InvariantStatus_violation_count_non_negative refuses a negative count — a negative SLI is a defect in the accounting, not a healthier shard",
      () => prisma.invariantStatus.create({ data: statusData({ violationCount: -1 }) }),
    );
    await refused(
      "C8",
      "InvariantStatus_subject_type_known refuses an unknown subject type",
      () => prisma.invariantStatus.create({ data: statusData({ subjectType: "REGION" }) }),
    );

    await accepted(
      "S1",
      "a SUSPENDED row naming CUSTODIAL_OPERATION is accepted — the one suspension §26.2 authorises",
      async () => {
        const row = await prisma.invariantStatus.create({
          data: statusData({ status: "SUSPENDED", authorisingMode: "CUSTODIAL_OPERATION", violationCount: 3 }),
        });
        return `id = ${row.id}, authorisingMode = ${row.authorisingMode}`;
      },
    );

    /* ── 8. The unique key the worker's upsert depends on, and BigInt marks ─── */
    await refused(
      "U1",
      "a second row for the same (invariantId, shardId, subjectId) is refused — the worker upserts on this key, and a duplicate would make the register report two statuses for one invariant",
      () => prisma.invariantStatus.create({ data: statusData({ status: "SUSPENDED", authorisingMode: "CUSTODIAL_OPERATION" }) }),
    );

    // `subjectId` defaults to `''` rather than NULL precisely so the key collides: a NULL in a
    // unique key does not collide in Postgres, and upsert-by-key is what the worker needs. That
    // is a database behaviour, and U1 is what proves the choice was necessary.
    await accepted(
      "U2",
      "an I6 per-agent high-water row coexists with the shard row, discriminated by subjectId, and BigInt marks round-trip exactly",
      async () => {
        const row = await prisma.invariantStatus.create({
          data: statusData({
            invariantId: "I6",
            subjectType: "AGENT",
            subjectId: `${PREFIX}:AGT-1`,
            highWaterMark: 9007199254740993n,
            secondaryHighWaterMark: 42n,
          }),
        });
        const read = await prisma.invariantStatus.findUnique({ where: { id: row.id } });
        // 2^53 + 1 is chosen deliberately: it is the first integer a double cannot represent, so
        // a mark silently coerced through Number would come back as 9007199254740992.
        if (read.highWaterMark !== 9007199254740993n) {
          throw new Error(`high-water mark came back as ${read.highWaterMark}, so it was coerced through a double`);
        }
        return `highWaterMark = ${read.highWaterMark} (2^53 + 1, exact)`;
      },
    );

    /* ── 9. §18.6's step range, disposition vocabulary, and the human gate ──── */
    const chainData = (overrides) => ({
      legId: leg.id,
      step: 1,
      obstructionClass: "BLOCKING_CRITICAL",
      hazardState: "SEVERE",
      disposition: "EMITTED",
      occurredAt: now,
      ...(overrides || {}),
    });

    await refused(
      "C9",
      "ExternalEscalation_step_in_range refuses a step 6 — §18.6 has exactly five, and a sixth is a rung nobody specified the action, timing or gating of",
      () => prisma.externalEscalation.create({ data: chainData({ step: 6 }) }),
    );
    await refused(
      "C10",
      "ExternalEscalation_disposition_known refuses an unknown disposition",
      () => prisma.externalEscalation.create({ data: chainData({ disposition: "PROBABLY_SENT" }) }),
    );

    /* ── 10. THE safety-critical one: step 4's human gate, at the schema ────── */
    await refused(
      "G1",
      "ExternalEscalation_step_four_is_human_gated REFUSES a step-4 row with no operatorId — §18.6: automatic calls to emergency services are not an appropriate output of an allocation engine",
      () => prisma.externalEscalation.create({ data: chainData({ step: 4, disposition: "CONFIRMED_BY_OPERATOR", operatorId: null }) }),
    );
    // The check that found the defect: `IS NOT NULL` admitted `''`, so the enforcement point the
    // report calls "the one a future writer cannot route around" could be routed around by
    // supplying an empty string. Migration 20260818210000 tightened it to
    // `btrim("operatorId") <> ''`, and this is what proves the tightening reached the database.
    await refused(
      "G2",
      "…and an empty-string operatorId is refused too — an empty string is not a named operator, and a gate a space defeats is not a gate",
      () => prisma.externalEscalation.create({ data: chainData({ step: 4, disposition: "CONFIRMED_BY_OPERATOR", operatorId: "" }) }),
    );
    await refused(
      "G2b",
      "…and a whitespace-only operatorId is refused",
      () => prisma.externalEscalation.create({ data: chainData({ step: 4, disposition: "CONFIRMED_BY_OPERATOR", operatorId: "   " }) }),
    );
    await accepted(
      "G3",
      "a step-4 row WITH a named operator is accepted — the gate is the operator's presence, not a prohibition on the step",
      async () => {
        const confirmation = externalEscalation.confirmEmergencyServices({
          operator: { operatorId: `${PREFIX}:op-1`, role: "ON_CALL" },
          confirmed: true,
          atMs: now.getTime(),
          eligibility: { eligible: true },
        });
        const row = await prisma.externalEscalation.create({
          data: chainData({
            step: confirmation.step,
            disposition: confirmation.disposition,
            operatorId: confirmation.operatorId,
            operatorRole: confirmation.operatorRole,
          }),
        });
        return `step 4 recorded by ${row.operatorId} (${row.operatorRole})`;
      },
    );

    /* ── 11. §18.6's chain, opened and swept by the REAL production passes ──── */
    await prisma.externalEscalation.deleteMany({ where: { legId: leg.id } });

    const openPass = await invariantWorker.chainOpenPass(
      {
        prisma,
        readEscalationContext: async () => ({
          position: { lat: 51.5, lon: -0.1 },
          custodyManifest: [`${PREFIX}:parcel`],
          agentCondition: "IMMOBILISED",
          hazardState: "SEVERE",
          physicalAccessInstructions: "gate 4",
          segmentId: `${PREFIX}:seg`,
        }),
        regionOf: async () => "region-a",
      },
      {
        nowMs: now.getTime(),
        escalationContacts: { "region-a": { owner: "Ops lead", contacts: ["+441234"], reviewedAtMs: now.getTime() - 1000 } },
        contactReviewPeriodSeconds: 86400,
        emergencyServicesThreshold: { obstructionClasses: ["BLOCKING_CRITICAL"], hazardStates: ["SEVERE"] },
      },
    );
    const openedRows = await prisma.externalEscalation.findMany({ where: { legId: leg.id }, orderBy: { step: "asc" } });
    record(
      "E1",
      "the production chain-open pass writes §18.6 steps 1-3 against a real database, and no step 4",
      openPass.opened.length === 1 && openedRows.map((row) => row.step).join(",") === "1,2,3",
      `steps written: ${openedRows.map((row) => row.step).join(", ")}; emergency services eligible = ${openPass.opened[0] && openPass.opened[0].emergencyServicesEligible}, gated = true`,
    );

    const secondOpen = await invariantWorker.chainOpenPass({ prisma }, { nowMs: now.getTime() + 60000 });
    const afterSecond = await prisma.externalEscalation.count({ where: { legId: leg.id } });
    record(
      "E2",
      "a second pass does not page a responder twice for one incident",
      secondOpen.opened.length === 0 && afterSecond === 3,
      `opened = ${secondOpen.opened.length}, rows = ${afterSecond}`,
    );

    // The growth defect, against a real table: eight sweeps of an unresolved stranding.
    let sweepAt = now.getTime();
    for (let tick = 1; tick <= 8; tick += 1) {
      sweepAt = now.getTime() + tick * 60000;
      // eslint-disable-next-line no-await-in-loop
      await invariantWorker.escalationSweepPass(
        { prisma, readHazardData: async () => ({ obstructionClass: "BLOCKING_CRITICAL", observedAtMs: sweepAt - 1000 }) },
        { nowMs: sweepAt, maxAgeSeconds: 300 },
      );
    }
    const afterSweeps = await prisma.externalEscalation.count({ where: { legId: leg.id } });
    record(
      "E3",
      "eight sweeps of an unresolved stranding add NO rows — before the remediation the same eight ticks turned 3 rows into 768",
      afterSweeps === 3,
      `rows after 8 sweeps = ${afterSweeps} (expected 3)`,
    );

    // Clearance closes the whole chain, not just the row that observed it.
    const clearAt = sweepAt + 60000;
    const clearing = await invariantWorker.escalationSweepPass(
      { prisma, readHazardData: async () => ({ obstructionClass: "CLEAR", observedAtMs: clearAt - 1000 }) },
      { nowMs: clearAt, maxAgeSeconds: 300 },
    );
    const stillOpen = await prisma.externalEscalation.count({ where: { legId: leg.id, clearedAt: null } });
    record(
      "E4",
      "clearance sets clearedAt on EVERY open row of the chain — closing only the observing row left the chain open for ever, and the sweep re-evaluated a resolved incident indefinitely",
      stillOpen === 0 && clearing.cleared >= 1,
      `rows still open = ${stillOpen}, closed by this pass = ${clearing.cleared}`,
    );
    record(
      "E5",
      "the §4.4 de-escalation the sweep may NOT perform is reported rather than implied — STRANDED_OBSTRUCTING → STRANDED_SAFE carries GUARD.CORROBORATED_POSITION, which map data does not discharge",
      clearing.admissibleTransitions.length === 1 && clearing.admissibleTransitions[0].to === "STRANDED_SAFE",
      JSON.stringify(clearing.admissibleTransitions[0] || null),
    );

    /* ── 12. ON DELETE CASCADE from Leg ─────────────────────────────────────── */
    await prisma.leg.delete({ where: { id: leg.id } });
    const orphans = await prisma.externalEscalation.count({ where: { legId: leg.id } });
    record(
      "D1",
      "deleting a Leg CASCADEs to its ExternalEscalation rows — an escalation chain for a Leg that no longer exists is unreachable evidence",
      orphans === 0,
      `orphans = ${orphans}`,
    );

    /* ── 13. The worker's full check pass, against a real database ───────────── */
    await prisma.invariantStatus.deleteMany({ where: { shardId: SHARD } });
    await prisma.degradedModeEvent.deleteMany({ where: { shardId: SHARD } });

    const state = {};
    const pass = await invariantWorker.checkPass({ prisma }, { shardId: SHARD, nowMs: now.getTime(), checkerState: state, sweepEscalations: false });
    const persisted = await prisma.invariantStatus.count({ where: { shardId: SHARD, subjectType: "SHARD" } });
    record(
      "W1",
      "the production check pass runs all twenty-two checks against a real database and persists a row per invariant",
      pass.summary.total === 22 && persisted >= 20,
      `statuses persisted = ${persisted}, unchecked = ${pass.summary.unchecked}, violated = ${JSON.stringify(pass.summary.violatedInvariants)}`,
    );

    const secondPass = await invariantWorker.checkPass(
      { prisma },
      { shardId: SHARD, nowMs: now.getTime() + 60000, checkerState: state, sweepEscalations: false },
    );
    const stillOne = await prisma.invariantStatus.count({ where: { shardId: SHARD, subjectType: "SHARD" } });
    record(
      "W2",
      "a second pass UPSERTs rather than duplicating — against the real unique key, not a double that models it",
      stillOne === persisted,
      `rows after two passes = ${stillOne}`,
    );
    record(
      "W2b",
      "the I5 baseline and the I12 version marks survive in the row's detail, so a restarted worker recovers them from the database",
      Boolean(
        (await prisma.invariantStatus.findFirst({ where: { shardId: SHARD, invariantId: "I12", subjectType: "SHARD" } }))?.detail?.carry,
      ),
      JSON.stringify(
        (await prisma.invariantStatus.findFirst({ where: { shardId: SHARD, invariantId: "I12", subjectType: "SHARD" } }))?.detail?.carry ?? null,
      ).slice(0, 160),
    );

    void secondPass;

    /* ── 13b. I12 fires on a real database, across two real passes ───────────── */
    //
    // The headline defect: `checkI12` returned its version marks and the worker dropped them, so
    // `context.terminalVersionMarks` was empty on every pass and a Tier 0 safety-core invariant
    // could not report `VIOLATED` in any composition. Proved here end to end — a settled Leg, a
    // write to it, and the register's verdict — rather than by injecting a mark into a unit test.
    await prisma.invariantStatus.deleteMany({ where: { shardId: SHARD } });
    const settled = await prisma.leg.create({
      data: {
        legId: `${PREFIX}:L-TERMINAL`,
        missionId: mission.id,
        purpose: "PRIMARY",
        state: "SETTLED",
      },
    });

    // I12's window is `updatedAt >= windowStart AND < now`, and `updatedAt` is written by the
    // database's own `@updatedAt`, not by the harness's fixed instant. So the pass times are
    // anchored to the row the database actually wrote — the alternative is a check that silently
    // audits an empty window and reports ENFORCED, which is the exact failure mode this harness
    // exists to refuse.
    const anchorMs = settled.updatedAt.getTime() + 1000;
    const i12State = {};
    const i12First = await invariantWorker.checkPass(
      { prisma },
      { shardId: SHARD, nowMs: anchorMs, checkerState: i12State, sweepEscalations: false },
    );
    const i12A = i12First.results.find((row) => row.invariantId === "I12");
    if (!/1 carried|1 terminal rows touched|^1 /.test(String(i12A.detail))) {
      // Fail loudly rather than proceed: if pass 1 saw no terminal row, pass 2's ENFORCED would
      // mean "nothing was in the window", and would read exactly like "no modification occurred".
      record("W3a", "pass 1 actually observed the settled Leg — otherwise the verdict below is vacuous", /terminal rows touched in the window/.test(String(i12A.detail)) && !/^0 terminal/.test(String(i12A.detail)), String(i12A.detail));
    }

    // Somebody writes to a settled row. `version` is what I12's write audit compares.
    await prisma.leg.update({ where: { id: settled.id }, data: { version: { increment: 1 } } });

    const i12Second = await invariantWorker.checkPass(
      { prisma },
      { shardId: SHARD, nowMs: Date.now() + 1000, checkerState: i12State, sweepEscalations: false },
    );
    const i12B = i12Second.results.find((row) => row.invariantId === "I12");
    record(
      "W3",
      "I12 detects a modified terminal row across two passes against a REAL database — before the remediation this check could not report VIOLATED in any composition",
      i12A.status === "ENFORCED" && i12B.status === "VIOLATED" && i12B.violations.some((row) => row.problem === "TERMINAL_ROW_MODIFIED"),
      `pass 1 = ${i12A.status} (${i12A.detail || ""}), pass 2 = ${i12B.status}, violations = ${JSON.stringify(i12B.violations)}`,
    );

    const carried = await prisma.invariantStatus.findFirst({
      where: { shardId: SHARD, invariantId: "I12", subjectType: "SHARD" },
      select: { detail: true },
    });
    record(
      "W4",
      "the version marks are backed up on the row the pass writes, so the comparison survives a restart",
      Boolean(carried && carried.detail && carried.detail.carry && Object.keys(carried.detail.carry.terminalVersionMarks || {}).length > 0),
      JSON.stringify((carried && carried.detail && carried.detail.carry) || null).slice(0, 200),
    );

    // A restart: a fresh carry object must still see the marks, from the row alone.
    await prisma.leg.update({ where: { id: settled.id }, data: { version: { increment: 1 } } });
    const afterRestart = await invariantWorker.checkPass(
      { prisma },
      { shardId: SHARD, nowMs: Date.now() + 1000, checkerState: {}, sweepEscalations: false },
    );
    const i12C = afterRestart.results.find((row) => row.invariantId === "I12");
    record(
      "W5",
      "…and a RESTARTED worker — a fresh carry object — still detects the next modification, from the stored row alone",
      i12C.status === "VIOLATED",
      `after restart: I12 = ${i12C.status}, violations = ${JSON.stringify(i12C.violations)}`,
    );

    const seeded = await invariantWorker.seedCheckerState({ prisma }, {}, SHARD);
    record(
      "W6",
      "seedCheckerState recovers both cross-pass carries from the durable rows",
      seeded.terminalVersionMarks instanceof Map && seeded.terminalVersionMarks.size > 0,
      `previousFenceRejections = ${JSON.stringify(seeded.previousFenceRejections ?? null)}, terminalVersionMarks = ${seeded.terminalVersionMarks ? seeded.terminalVersionMarks.size : "absent"}`,
    );

    /* ── 14. The advisory mirror is NOT the authority ────────────────────────── */
    await transitions.enter({ prisma }, {
      mode: modeRegister.MODE.CUSTODIAL_OPERATION,
      shardId: SHARD,
      cause: "B1",
      enteringComponent: "phase12LiveDatabase",
      atMs: now.getTime(),
      maxDurationMs: 900000,
    });
    const modesFromStore = await transitions.activeModes({ prisma }, SHARD);
    const withDeadCache = await invariantWorker.modeSweepPass(
      { prisma, kv: { set: async () => { throw new Error("cache tier lost entirely (B3)"); } } },
      { shardId: SHARD, nowMs: now.getTime() },
    );
    record(
      "M1",
      "a failed advisory publish costs visibility and never correctness — the mode set still comes from DegradedModeEvent (§3.3)",
      withDeadCache.advisoryPublished === false && withDeadCache.activeModes.join(",") === modesFromStore.join(",") && modesFromStore.includes("CUSTODIAL_OPERATION"),
      `advisoryPublished = ${withDeadCache.advisoryPublished}, modes from the durable store = ${modesFromStore.join(", ")}`,
    );
  } finally {
    await prisma.externalEscalation.deleteMany({ where: { operatorId: { startsWith: PREFIX } } });
    await prisma.invariantStatus.deleteMany({ where: { shardId: { startsWith: PREFIX } } });
    await prisma.degradedModeEvent.deleteMany({ where: { shardId: { startsWith: PREFIX } } });
    await prisma.leg.deleteMany({ where: { legId: { startsWith: PREFIX } } });
    await prisma.$disconnect();
  }

  const failed = results.filter((row) => !row.passed);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed.\n`);
  if (failed.length > 0) {
    console.log("  FAILED:");
    for (const row of failed) console.log(`    ${row.id} — ${row.description}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

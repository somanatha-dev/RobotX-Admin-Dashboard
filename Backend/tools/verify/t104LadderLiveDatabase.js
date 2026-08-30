"use strict";

/**
 * REMEDIAL PHASE T1-04 — §17.4's escalation ladder, against **real PostgreSQL**.
 *
 * ── Why this exists and what it is not ─────────────────────────────────────
 * `tests/engine/fairnessLadder.test.js` runs against `helpers/commitmentStore.js`, which
 * evaluates the migration's CHECK constraints in JavaScript. That is a model of the
 * database, and a model agrees with whatever it was told: every constraint in this
 * phase's migration was written twice — once in SQL, once in the double — and a suite
 * that only ran the second one would prove the two copies agree with *each other*, not
 * that either matches PostgreSQL.
 *
 * This tool is the other half. It runs the shipped migration against a real server and
 * then attempts, one at a time, every write §17.4 forbids. A constraint that does not
 * reject its planted violation here is a constraint that exists only in a comment.
 *
 * It is deliberately **not** a jest test. It needs a live server, and a test lane that
 * silently skips when one is absent is how a live-database obligation goes undischarged
 * for four phases — which is exactly what happened to Phases 1 and 2.
 *
 * ── Running it ─────────────────────────────────────────────────────────────
 *   node tools/verify/t104LadderLiveDatabase.js "postgresql://user@host:port/db"
 *
 * Never against `DATABASE_URL`: that is shared infrastructure. Build a throwaway cluster.
 */

const { PrismaClient } = require("@prisma/client");

const ladder = require("../../src/engine/fairness/ladder");
const metrics = require("../../src/engine/observability/metrics");
const operatorCapacity = require("../../src/engine/fairness/operatorCapacity");

const checks = [];
let failures = 0;

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  if (!ok) failures += 1;
  process.stdout.write(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
}

/** Rolls a probe's transaction back without making the probe look like a failure. */
class Rollback extends Error {}

/**
 * Assert that a write is refused by a named constraint.
 *
 * The constraint name is asserted, not merely the failure: a row rejected by the *wrong*
 * constraint is a row the intended one would have admitted, and reporting that as a pass
 * is how a guard gets credit for another guard's work.
 *
 * Every attempt runs inside an interactive transaction that is always rolled back, so a
 * planted violation leaves nothing behind for the next one to trip over.
 */
async function refuses(prisma, name, constraint, sql, values) {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(sql, ...values);
      throw new Rollback("accepted");
    });
    record(name, false, "the write was ACCEPTED; the constraint did not fire");
  } catch (error) {
    if (error instanceof Rollback) {
      record(name, false, "the write was ACCEPTED; the constraint did not fire");
      return;
    }
    const message = String(error && error.message);
    record(name, message.includes(constraint), message.includes(constraint) ? null : `rejected by something else: ${message}`);
  }
}

async function accepts(prisma, name, sql, values) {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(sql, ...values);
      throw new Rollback("accepted");
    });
    record(name, false, "unreachable: the transaction did not roll back");
  } catch (error) {
    if (error instanceof Rollback) {
      record(name, true);
      return;
    }
    record(name, false, `the write was REFUSED: ${error && error.message}`);
  }
}

const INSERT = `
  INSERT INTO "LadderEscalation"
    ("id", "legId", "step", "action", "relaxations", "cause", "queueAgeSeconds", "budgetSeconds",
     "elapsedFraction", "regionId", "shardId", "slaClass", "reachedAt", "humanStep", "admittedAt",
     "heldReason", "resolvedAt", "outcome", "updatedAt")
  VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::double precision, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW())
`;

/** A well-formed row, which each planted violation then breaks in exactly one way. */
function row(overrides) {
  return {
    id: "esc-1",
    legId: "leg-1",
    step: 1,
    action: "WIDEN_SEARCH_RADIUS",
    relaxations: JSON.stringify(["SEARCH_RADIUS"]),
    cause: "ELAPSED_FRACTION_0.25",
    queueAgeSeconds: 225,
    budgetSeconds: 900,
    elapsedFraction: 0.25,
    regionId: "region-north",
    shardId: "shard-1",
    slaClass: "STANDARD",
    reachedAt: new Date("2026-07-29T12:00:00Z"),
    humanStep: false,
    admittedAt: null,
    heldReason: null,
    resolvedAt: null,
    outcome: null,
    ...(overrides || {}),
  };
}

const params = (over) => {
  const r = row(over);
  return [
    r.id, r.legId, r.step, r.action, r.relaxations, r.cause, r.queueAgeSeconds, r.budgetSeconds,
    r.elapsedFraction, r.regionId, r.shardId, r.slaClass, r.reachedAt, r.humanStep, r.admittedAt,
    r.heldReason, r.resolvedAt, r.outcome,
  ];
};

async function main() {
  const url = process.argv[2];
  if (!url) {
    process.stderr.write("usage: node tools/verify/t104LadderLiveDatabase.js <postgres-url>\n");
    process.exit(2);
  }
  if (/neon\.tech/i.test(url)) {
    process.stderr.write("refused: this tool plants constraint violations and must never run against shared infrastructure\n");
    process.exit(2);
  }

  // The generated Prisma client, against the disposable cluster - not DATABASE_URL.
  // Using the real client rather than a raw driver is deliberate: it proves the
  // *generated* client can address the new model, which a hand-rolled driver would not.
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$connect();

  process.stdout.write("\nT1-04 — §17.4's escalation ladder against live PostgreSQL\n\n");

  // ── 0. The table and its shape exist as the migration wrote them ──────────
  const columns = await prisma.$queryRawUnsafe(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'LadderEscalation' ORDER BY column_name`,
  );
  record("the LadderEscalation table exists", columns.length > 0, `${columns.length} columns`);

  const nullable = new Map(columns.map((r) => [r.column_name, r.is_nullable]));
  // The four columns whose nullability *is* the semantics: a held rung has no
  // `admittedAt`, an outstanding one has no `resolvedAt`.
  for (const column of ["admittedAt", "heldReason", "resolvedAt", "outcome"]) {
    record(`${column} is nullable — a rung reached is not a rung escalated`, nullable.get(column) === "YES");
  }
  for (const column of ["step", "action", "cause", "queueAgeSeconds", "budgetSeconds", "elapsedFraction", "reachedAt"]) {
    record(`${column} is NOT NULL`, nullable.get(column) === "NO");
  }

  const constraints = await prisma.$queryRawUnsafe(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = '"LadderEscalation"'::regclass AND contype = 'c' ORDER BY conname`,
  );
  const names = constraints.map((r) => r.conname);
  // Ten, and the count is asserted rather than the list: a constraint dropped by a later
  // migration would still leave every name this file checks by hand present.
  record("ten CHECK constraints were created", names.length === 10, names.join(", "));

  const indexes = await prisma.$queryRawUnsafe(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'LadderEscalation' ORDER BY indexname`,
  );
  record(
    "the (legId, step) unique index exists — one arrival per rung",
    indexes.some((r) => r.indexname === "LadderEscalation_legId_step_key"),
  );

  // A Leg to hang the rows off, since the FK is real.
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Mission" ("id", "missionId", "createdAt", "updatedAt")
    VALUES ('mission-1', 'mission-1', NOW(), NOW()) ON CONFLICT DO NOTHING`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO "Leg" ("id", "legId", "missionId", "sequence", "purpose", "state", "custodyState",
                       "version", "createdAt", "updatedAt")
    VALUES ('leg-1', 'leg-1', 'mission-1', 0, 'PRIMARY', 'QUEUED', 'NONE', 0, NOW(), NOW())
    ON CONFLICT DO NOTHING`);

  // ── 1. The well-formed rows the ladder actually writes ────────────────────
  await accepts(prisma, "a non-human rung with neither admittedAt nor heldReason is accepted", INSERT, params());
  await accepts(
    prisma,
    "a human rung that is HELD (heldReason, no admittedAt) is accepted — §17.4's held Leg",
    INSERT,
    params({ step: 7, action: "ESCALATE_TO_HUMAN_DISPATCHER", humanStep: true, heldReason: "CAPACITY_SATURATED" }),
  );
  await accepts(
    prisma,
    "a human rung that is ADMITTED (admittedAt, no heldReason) is accepted",
    INSERT,
    params({ step: 7, action: "ESCALATE_TO_HUMAN_DISPATCHER", humanStep: true, admittedAt: new Date("2026-07-29T12:00:00Z") }),
  );
  await accepts(
    prisma,
    "a resolved escalation with an outcome is accepted",
    INSERT,
    params({
      step: 8,
      action: "ALTERNATIVE_MODALITY_OR_DECLINE",
      humanStep: true,
      admittedAt: new Date("2026-07-29T12:00:00Z"),
      resolvedAt: new Date("2026-07-29T12:10:00Z"),
      outcome: "ASSIGNED",
    }),
  );

  // ── 2. The planted violations — one per constraint ────────────────────────
  await refuses(prisma, "rung 0 is refused — §17.4 has eight rungs", "LadderEscalation_step_in_range", INSERT, params({ step: 0 }));
  // Well-formed in every respect except the rung number: a rung 9 left un-marked as human
  // work trips `human_steps_are_seven_and_eight` first, and a probe that passes for the
  // wrong reason proves nothing about the constraint it names.
  await refuses(
    prisma,
    "rung 9 is refused",
    "LadderEscalation_step_in_range",
    INSERT,
    params({ step: 9, action: "ALTERNATIVE_MODALITY_OR_DECLINE", humanStep: true, heldReason: "CAPACITY_SATURATED" }),
  );
  await refuses(
    prisma,
    "an unpublished action token is refused — a published order that admits one is not published",
    "LadderEscalation_action_known",
    INSERT,
    params({ action: "WIDEN_EVERYTHING" }),
  );

  // **The one that matters most.** §17.4: "A Leg that 'reached step 7' without a human
  // ever seeing it has not been escalated, and recording otherwise would make the
  // ladder's guarantee false in exactly the conditions it exists for." All four rows
  // below are ways of recording exactly that, and the database refuses each of them.
  await refuses(
    prisma,
    "a human rung that is BOTH admitted and held is refused",
    "LadderEscalation_admitted_xor_held",
    INSERT,
    params({
      step: 7,
      action: "ESCALATE_TO_HUMAN_DISPATCHER",
      humanStep: true,
      admittedAt: new Date("2026-07-29T12:00:00Z"),
      heldReason: "CAPACITY_SATURATED",
    }),
  );
  await refuses(
    prisma,
    "a human rung that is NEITHER admitted nor held is refused — its disposition is unrecorded",
    "LadderEscalation_admitted_xor_held",
    INSERT,
    params({ step: 7, action: "ESCALATE_TO_HUMAN_DISPATCHER", humanStep: true }),
  );
  await refuses(
    prisma,
    "a non-human rung carrying admittedAt is refused — it would inflate the outstanding count",
    "LadderEscalation_admitted_xor_held",
    INSERT,
    params({ step: 3, action: "RELAX_CLASS_P_SOFT_CONSTRAINTS", admittedAt: new Date("2026-07-29T12:00:00Z") }),
  );
  await refuses(
    prisma,
    "rung 3 marked humanStep is refused — only 7 and 8 route to people",
    "LadderEscalation_human_steps_are_seven_and_eight",
    INSERT,
    params({ step: 3, action: "RELAX_CLASS_P_SOFT_CONSTRAINTS", humanStep: true, heldReason: "CAPACITY_SATURATED" }),
  );
  await refuses(
    prisma,
    "rung 7 not marked humanStep is refused",
    "LadderEscalation_human_steps_are_seven_and_eight",
    INSERT,
    params({ step: 7, action: "ESCALATE_TO_HUMAN_DISPATCHER", humanStep: false }),
  );

  await refuses(
    prisma,
    "a resolution before its admission is refused — a negative interval poisons every saturation reading",
    "LadderEscalation_resolution_follows_admission",
    INSERT,
    params({
      step: 7,
      action: "ESCALATE_TO_HUMAN_DISPATCHER",
      humanStep: true,
      admittedAt: new Date("2026-07-29T12:10:00Z"),
      resolvedAt: new Date("2026-07-29T12:00:00Z"),
      outcome: "ASSIGNED",
    }),
  );
  await refuses(
    prisma,
    "a resolution with no admission is refused",
    "LadderEscalation_resolution_follows_admission",
    INSERT,
    params({
      step: 7,
      action: "ESCALATE_TO_HUMAN_DISPATCHER",
      humanStep: true,
      heldReason: "CAPACITY_SATURATED",
      resolvedAt: new Date("2026-07-29T12:00:00Z"),
      outcome: "ASSIGNED",
    }),
  );
  await refuses(
    prisma,
    "a resolution with no stated outcome is refused — closed, cause unknown",
    "LadderEscalation_resolution_is_explained",
    INSERT,
    params({
      step: 7,
      action: "ESCALATE_TO_HUMAN_DISPATCHER",
      humanStep: true,
      admittedAt: new Date("2026-07-29T12:00:00Z"),
      resolvedAt: new Date("2026-07-29T12:10:00Z"),
    }),
  );
  await refuses(
    prisma,
    "an outcome with no resolution instant is refused",
    "LadderEscalation_resolution_is_explained",
    INSERT,
    params({
      step: 7,
      action: "ESCALATE_TO_HUMAN_DISPATCHER",
      humanStep: true,
      admittedAt: new Date("2026-07-29T12:00:00Z"),
      outcome: "ASSIGNED",
    }),
  );
  await refuses(
    prisma,
    "an unknown outcome is refused",
    "LadderEscalation_outcome_known",
    INSERT,
    params({
      step: 7,
      action: "ESCALATE_TO_HUMAN_DISPATCHER",
      humanStep: true,
      admittedAt: new Date("2026-07-29T12:00:00Z"),
      resolvedAt: new Date("2026-07-29T12:10:00Z"),
      outcome: "SORTED",
    }),
  );

  await refuses(prisma, "a zero budget is refused — there is no fraction of zero", "LadderEscalation_budget_is_positive", INSERT, params({ budgetSeconds: 0 }));
  await refuses(prisma, "a negative queue age is refused", "LadderEscalation_queue_age_is_not_negative", INSERT, params({ queueAgeSeconds: -1 }));
  await refuses(
    prisma,
    "a NaN elapsed fraction is refused",
    "LadderEscalation_elapsed_fraction_is_finite_and_not_negative",
    INSERT,
    params({ elapsedFraction: "NaN" }),
  );
  await refuses(
    prisma,
    "an infinite elapsed fraction is refused",
    "LadderEscalation_elapsed_fraction_is_finite_and_not_negative",
    INSERT,
    params({ elapsedFraction: "Infinity" }),
  );

  // ── 3. The unique index, which is what makes a re-fired timer converge ────
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(INSERT, ...params({ id: "esc-a", step: 4, action: "PERMIT_PREEMPTION" }));
      await tx.$executeRawUnsafe(INSERT, ...params({ id: "esc-b", step: 4, action: "PERMIT_PREEMPTION" }));
      throw new Rollback("accepted");
    });
    record("the same rung recorded twice for one Leg is refused", false, "the second insert was ACCEPTED");
  } catch (error) {
    if (error instanceof Rollback) {
      record("the same rung recorded twice for one Leg is refused", false, "the second insert was ACCEPTED");
    } else {
      record(
        "the same rung recorded twice for one Leg is refused — §4.5 fires at least once, by design",
        // Prisma reports a unique violation by the key, not by the index name.
        /LadderEscalation_legId_step_key|Key \("legId", step\)/.test(String(error.message)),
        String(error.message),
      );
    }
  }

  // ── 4. The vocabulary the code writes is the vocabulary the schema admits ─
  //
  // Not a re-listing: the actions come from `ladder.STEPS` and the outcomes from
  // `operatorCapacity.RESOLUTION`, so a rung renamed in the module without a migration
  // fails here rather than at the first escalation in production.
  for (const rung of ladder.STEPS) {
    await accepts(
      prisma,
      `the schema admits the action module rung ${rung.step} writes (${rung.action})`,
      INSERT,
      params({
        step: rung.step,
        action: rung.action,
        humanStep: rung.humanStep,
        heldReason: rung.humanStep ? "CAPACITY_SATURATED" : null,
      }),
    );
  }
  for (const outcome of Object.values(operatorCapacity.RESOLUTION)) {
    await accepts(
      prisma,
      `the schema admits the resolution outcome the module writes (${outcome})`,
      INSERT,
      params({
        step: 7,
        action: "ESCALATE_TO_HUMAN_DISPATCHER",
        humanStep: true,
        admittedAt: new Date("2026-07-29T12:00:00Z"),
        resolvedAt: new Date("2026-07-29T12:10:00Z"),
        outcome,
      }),
    );
  }

  // ── 5. The module itself, against real PostgreSQL ────────────────────────
  //
  // Everything above proves the *schema*. This proves the **ladder**: the shipped
  // `fairness/ladder.js`, reading a real `WorkQueue.enqueuedAt` through a real Prisma
  // transaction and writing real rows, with `operatorCapacity` deciding admission against
  // a real count. The store model cannot establish this — it agrees with whatever it was
  // told about Prisma's own semantics, and `admittedAt` reading back as `undefined`
  // instead of `null` from an in-transaction read was exactly that kind of difference.
  process.stdout.write("\n  -- the ladder module, driven against this database --\n");

  // Idempotent across runs: the section below writes real Legs, and a second run against
  // the same cluster must start from the same state as the first. A verifier that only
  // passes on a virgin database is a verifier nobody re-runs.
  await prisma.$executeRawUnsafe(`DELETE FROM "LadderEscalation"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "WorkQueue"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "Leg" WHERE "id" LIKE 'leg-live-%'`);

  const BUDGET = 900;
  const REGION = "region-north";

  // `Leg` is unique on `(missionId, sequence)`, so each Leg in one mission needs its own
  // position. Counted rather than passed in, so a test added later cannot collide.
  let sequence = 0;

  /** Queue a Leg with a real row, aged by `queueAgeSeconds` against the store clock. */
  async function queueLeg(legId, queueAgeSeconds) {
    sequence += 1;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Leg" ("id", "legId", "missionId", "sequence", "purpose", "state", "custodyState",
                          "version", "createdAt", "updatedAt")
       VALUES ($1, $1, 'mission-1', $2, 'PRIMARY', 'QUEUED', 'NONE', 0, NOW(), NOW())
       ON CONFLICT ("id") DO UPDATE SET "state" = 'QUEUED'`,
      legId,
      sequence,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "WorkQueue" ("id", "legId", "shardId", "idempotencyKey", "purpose", "slaClass",
                                "priority", "state", "roundsConsidered", "consecutiveDeferrals",
                                "version", "enqueuedAt", "createdAt", "updatedAt")
       VALUES ($1, $2, 'shard-1', $1, 'PRIMARY', 'STANDARD', 0, 'QUEUED', 0, 0, 0,
               (NOW() AT TIME ZONE 'UTC') - ($3 || ' seconds')::interval, NOW(), NOW())`,
      `wq-${legId}`,
      legId,
      String(queueAgeSeconds),
    );
    return prisma.leg.findUnique({ where: { id: legId } });
  }

  const built = ladder.create({
    prisma,
    values: new Map(ladder.STEPS.map((rung, index) => [rung.parameter, [0.25, 0.4, 0.55, 0.7, 0.8, 0.85, 0.9, 1.0][index]])),
    budgetSeconds: BUDGET,
    regionId: REGION,
    escalationCapacity: 1,
    saturationPeriodSeconds: 600,
  });

  // `AT TIME ZONE 'UTC'`, because every instant column in this schema is
  // `TIMESTAMP(3)` *without* time zone and Prisma reads one back as UTC. A bare `NOW()` is
  // `timestamptz` and would put the harness's clock and the rows it writes in two
  // different coordinate systems — which is a property of writing timestamps through raw
  // SQL, not of the ladder: production writes JS Dates through Prisma, in UTC.
  const storeTime = new Date(
    `${(await prisma.$queryRawUnsafe(`SELECT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "now"`))[0].now}`,
  );

  // 60 % of budget: rung 3, with rungs 1 and 2 recorded behind it.
  const legA = await queueLeg("leg-live-a", BUDGET * 0.6);
  const verdictA = await prisma.$transaction((tx) =>
    built.nextStep({ tx, entityType: "LEG", entityId: legA.id, leg: legA, storeTime }),
  );
  record("the ladder reaches rung 3 at 60 % of budget against a real queue row", verdictA.step === 3, `${verdictA.verdict} ${verdictA.reason || ""} ${verdictA.detail || ""}`);
  const rowsA = await prisma.ladderEscalation.findMany({ where: { legId: legA.id }, orderBy: { step: "asc" } });
  record("rungs 1 to 3 are all durably recorded", rowsA.map((r) => r.step).join(",") === "1,2,3", rowsA.map((r) => r.step).join(","));
  record(
    "the recorded relaxations are the tokens the round consumes",
    JSON.stringify(rowsA[2].relaxations) === JSON.stringify(["ZONE_AFFINITY", "DEDICATED_FLEET_PREFERENCE"]),
    JSON.stringify(rowsA[2].relaxations),
  );
  // The defect the store model could not have surfaced on its own.
  record("a non-human rung reads back with admittedAt NULL, not undefined", rowsA[0].admittedAt === null);

  // Re-fire: §4.5 fires at least once by design, so the second pass must converge.
  await prisma.$transaction((tx) => built.nextStep({ tx, entityType: "LEG", entityId: legA.id, leg: legA, storeTime }));
  const rowsARepeat = await prisma.ladderEscalation.findMany({ where: { legId: legA.id } });
  record("a re-fired timer records no second arrival at the same rung", rowsARepeat.length === 3, `${rowsARepeat.length} rows`);

  // 92 % of budget: rung 7, the first human rung. Capacity is 1 and nothing holds it.
  const legB = await queueLeg("leg-live-b", BUDGET * 0.92);
  const verdictB = await prisma.$transaction((tx) =>
    built.nextStep({ tx, entityType: "LEG", entityId: legB.id, leg: legB, storeTime }),
  );
  record("rung 7 with capacity free is admitted to the human queue", verdictB.escalated === true, verdictB.verdict);
  const rung7 = await prisma.ladderEscalation.findFirst({ where: { legId: legB.id, step: 7 } });
  record("the admitted rung carries an admittedAt and no heldReason", rung7.admittedAt !== null && rung7.heldReason === null);

  // A second Leg at rung 7 with capacity 1 already spent: §17.4's held Leg.
  const legC = await queueLeg("leg-live-c", BUDGET * 0.92);
  const verdictC = await prisma.$transaction((tx) =>
    built.nextStep({ tx, entityType: "LEG", entityId: legC.id, leg: legC, storeTime }),
  );
  record(
    "with capacity spent, the next Leg is HELD on the ladder rather than escalated",
    verdictC.verdict === "HELD_FOR_HUMAN_CAPACITY" && verdictC.available === true && verdictC.exhausted === false,
    verdictC.verdict,
  );
  const heldRow = await prisma.ladderEscalation.findFirst({ where: { legId: legC.id, step: 7 } });
  record("the held rung carries a heldReason and no admittedAt", heldRow.admittedAt === null && heldRow.heldReason === "CAPACITY_SATURATED");

  // **The property §17.4 exists for.** 120 % of budget, every rung crossed, no capacity —
  // the obvious answer is "exhausted" and it is the wrong one, because no dispatcher has
  // seen it. A ladder that declined here would make its own guarantee false.
  const legD = await queueLeg("leg-live-d", BUDGET * 1.2);
  const verdictD = await prisma.$transaction((tx) =>
    built.nextStep({ tx, entityType: "LEG", entityId: legD.id, leg: legD, storeTime }),
  );
  record(
    "a Leg past 100 % of budget with no human capacity is NOT exhausted",
    verdictD.exhausted === false && verdictD.verdict === "HELD_FOR_HUMAN_CAPACITY",
    verdictD.verdict,
  );

  // Free the capacity by taking the admitted Leg out of the queue, then re-fire the
  // overdue one: now a human can hold it, and only now may the ladder decline.
  await prisma.$executeRawUnsafe(`UPDATE "Leg" SET "state" = 'SETTLED' WHERE "id" = $1`, legB.id);
  const verdictD2 = await prisma.$transaction((tx) =>
    built.nextStep({ tx, entityType: "LEG", entityId: legD.id, leg: legD, storeTime }),
  );
  // Now — and *only* now — may the ladder decline. The Leg is past 100 % of budget, so its
  // rung is 8, the terminal one; a dispatcher is holding it; and no alternative modality is
  // configured, which §17.4 reads literally as "the fallback is not available". The decline
  // is the specified decision, and the two checks below are what separate it from the
  // decline the previous case forbade: the same Leg, the same budget, the same clock, and
  // the only thing that changed is that a human now has it.
  const rung8 = await prisma.ladderEscalation.findFirst({ where: { legId: legD.id, step: 8 } });
  record(
    "with a dispatcher holding it, the overdue Leg is declined — §17.4's terminal decision",
    verdictD2.verdict === "EXHAUSTED" && verdictD2.decision === "DECLINE_WITH_STATED_REASON",
    verdictD2.verdict,
  );
  record(
    "the decline happened only after rung 8 was actually admitted to a human",
    rung8 !== null && rung8.admittedAt !== null && rung8.heldReason === null,
    rung8 ? `admittedAt=${rung8.admittedAt}` : "no rung 8 row",
  );
  record(
    "the decline carries the stated reason §17.4 requires for the customer notification",
    typeof verdictD2.sentence === "string" && /escalation ladder was exhausted/.test(verdictD2.sentence),
    verdictD2.sentence,
  );
  const resolvedB = await prisma.ladderEscalation.findFirst({ where: { legId: legB.id, step: 7 } });
  record(
    "the finished escalation is closed with a stated outcome — the saturation window's other end",
    resolvedB.resolvedAt !== null && resolvedB.outcome === "TERMINAL",
    `${resolvedB.outcome}`,
  );

  // A Leg with no queue row at all: the one input whose absence must never be read as
  // exhaustion, checked here against a real store rather than a model of one.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Leg" ("id", "legId", "missionId", "sequence", "purpose", "state", "custodyState",
                        "version", "createdAt", "updatedAt")
     VALUES ('leg-live-e', 'leg-live-e', 'mission-1', 99, 'PRIMARY', 'QUEUED', 'NONE', 0, NOW(), NOW())`,
  );
  const legE = await prisma.leg.findUnique({ where: { id: "leg-live-e" } });
  const verdictE = await prisma.$transaction((tx) =>
    built.nextStep({ tx, entityType: "LEG", entityId: legE.id, leg: legE, storeTime }),
  );
  record(
    "a Leg with no work-queue row is UNDETERMINED, never exhausted",
    verdictE.verdict === "UNDETERMINED" && verdictE.reason === "NO_QUEUE_ROW" && verdictE.available === null,
    verdictE.reason,
  );

  // The three §21.4 SLIs, derived from the rows the ladder just wrote. Their producer note
  // in `metrics.js` said "src/engine/fairness/ still holds no ladder"; it does now.
  const metricsReadings = await metrics.derive(
    { prisma },
    { fromMs: storeTime.getTime() - 3600_000, toMs: storeTime.getTime() + 3600_000 },
  );
  for (const id of ["outstanding_escalations", "escalation_saturation_time", "ladder_step_distribution"]) {
    const found = metricsReadings.readings.find((r) => r.id === id);
    record(`§21.4's ${id} derives from the ladder's own rows`, Boolean(found) && found.value !== null, found ? JSON.stringify(found.value) : "absent");
  }

  // ── 6. The `Leg.slaDeadline` producer, through the real intake path ───────
  //
  // §4.3 gives Leg `QUEUED` the exit deadline `sla.assignment_deadline`; §4.5 registers it
  // in the transaction that enters the state; `Leg.slaDeadline` is that deadline's absolute
  // instant, and §17.4's triage comparator (section 5's `operatorCapacity`) sorts on it.
  //
  // This drives the **shipped** `task.service.admitToRound` — the production request path —
  // against this database, rather than the in-memory double `tests/engine/
  // intakeStranglerSeam.test.js` uses. The double stores a JavaScript `Date` verbatim;
  // PostgreSQL stores `TIMESTAMP(3)` and `NOW()` carries microseconds, so the one thing the
  // double structurally cannot show is whether the instant survives the round trip. If the
  // column truncated where the timer did not, §17.4 would sort on a different instant from
  // the one §4.5 fires on — and both would still look correct in jest.
  process.stdout.write("\n  -- the Leg.slaDeadline producer, through the real intake path --\n");

  const taskService = require("../../src/services/task.service");
  const configService = require("../../src/engine/config/service");
  const { taskToWork } = require("../../src/engine/domain/mappers/legacyTask");

  const publishedValues = configService.buildSnapshot({}).values;
  const budgetSeconds = publishedValues.get("sla.assignment_deadline");
  // §23.7's two secrets, passed rather than read from the environment: this tool must not
  // depend on a deployment's key material, and `admitToRound` already accepts them.
  const livePrivacyKeys = {
    secret: "t104-verifier-surrogate-secret",
    encryptionKey: Buffer.alloc(32, 7),
  };

  const LIVE_TASK_ID = "TSK-SLA-LIVE";
  const liveWork = taskToWork({ taskId: LIVE_TASK_ID });

  /** Idempotent across runs, for the same reason section 5 is. */
  async function resetSlaFixture() {
    await prisma.$executeRawUnsafe(`DELETE FROM "Timer" WHERE "entityId" = $1`, liveWork.leg.id);
    await prisma.$executeRawUnsafe(`DELETE FROM "WorkQueue" WHERE "legId" = $1`, liveWork.leg.id);
    await prisma.$executeRawUnsafe(`DELETE FROM "Stop" WHERE "legId" = $1`, liveWork.leg.id);
    await prisma.$executeRawUnsafe(`DELETE FROM "Leg" WHERE "id" = $1`, liveWork.leg.id);
    await prisma.$executeRawUnsafe(`DELETE FROM "Mission" WHERE "id" = $1`, liveWork.mission.id);
    await prisma.$executeRawUnsafe(`DELETE FROM "Task" WHERE "taskId" = $1`, LIVE_TASK_ID);
  }

  await resetSlaFixture();

  const pending = await prisma.task.create({
    data: {
      taskId: LIVE_TASK_ID,
      pickup: "Building A",
      pickupLat: 1,
      pickupLon: 1,
      drop: "Building B",
      dropLat: 2,
      dropLon: 2,
      status: "PENDING",
    },
  });

  const admitOptions = {
    receivedAtMs: Date.now(),
    configValues: publishedValues,
    privacyKeys: livePrivacyKeys,
    feasibleSupply: 3,
  };

  await taskService.admitToRound(prisma, pending, admitOptions);

  const liveLeg = await prisma.leg.findUnique({ where: { id: liveWork.leg.id } });
  const liveTimer = await prisma.timer.findFirst({
    where: { entityType: "LEG", entityId: liveWork.leg.id },
    orderBy: { createdAt: "desc" },
  });

  record(
    "the production request path writes Leg.slaDeadline — the column has a producer",
    Boolean(liveLeg) && liveLeg.slaDeadline instanceof Date,
    liveLeg ? String(liveLeg.slaDeadline) : "no Leg row",
  );

  // `armedSeconds` is carried on the timer's `payload`, not as a column of its own — read
  // it from where `timers.register` actually writes it rather than from where a reader
  // might assume. (This verifier asserted the column on its first run and produced a NaN
  // comparison, which is the same class of mistake it exists to catch in production code.)
  const armedSeconds = liveTimer && liveTimer.payload ? liveTimer.payload.armedSeconds : undefined;

  record(
    "the §4.5 QUEUED timer was armed in the same transaction",
    Boolean(liveTimer) && liveTimer.dueAt instanceof Date && Number.isFinite(armedSeconds),
    liveTimer ? `dueAt=${liveTimer.dueAt.toISOString()} armedSeconds=${armedSeconds}` : "no timer row",
  );

  if (liveLeg && liveLeg.slaDeadline && liveTimer && Number.isFinite(armedSeconds)) {
    // The store instant both were derived from, reconstructed from what PostgreSQL
    // actually persisted rather than from this process's clock.
    const storeInstantMs = liveTimer.dueAt.getTime() - armedSeconds * 1000;

    // **The exactness is the point.** Not "approximately a budget later" — exactly, to the
    // millisecond, after a TIMESTAMP(3) round trip on both columns. A truncation that hit
    // one and not the other would land here.
    record(
      "the persisted deadline is exactly the store instant plus sla.assignment_deadline",
      liveLeg.slaDeadline.getTime() - storeInstantMs === budgetSeconds * 1000,
      `deadline−store = ${liveLeg.slaDeadline.getTime() - storeInstantMs} ms, budget = ${budgetSeconds * 1000} ms`,
    );

    // The rung-1 trap, against real persistence: the timer is armed at 25 % of the budget
    // because the ladder re-arms at each rung, so a deadline derived from `armedSeconds`
    // would sit *at* the timer rather than beyond it.
    record(
      "the deadline is the whole budget, not the rung the timer is armed at",
      liveLeg.slaDeadline.getTime() > liveTimer.dueAt.getTime() && armedSeconds < budgetSeconds,
      `deadline=${liveLeg.slaDeadline.toISOString()} dueAt=${liveTimer.dueAt.toISOString()} ` +
        `(armed at ${armedSeconds}s of a ${budgetSeconds}s budget)`,
    );

    record(
      "the timer's recorded ladder budget is the same parameter the deadline used",
      liveTimer.payload && liveTimer.payload.ladderBudgetSeconds === budgetSeconds,
      liveTimer.payload ? JSON.stringify(liveTimer.payload) : "no payload",
    );
  }

  // A retried submission converges on the same Leg. Its deadline must not move: an
  // anti-starvation clock that restarts on every retry is not a guarantee. Checked against
  // the real unique constraints and the real "already supervised" read.
  const deadlineBeforeRetry = liveLeg && liveLeg.slaDeadline ? liveLeg.slaDeadline.getTime() : null;
  await new Promise((resolve) => setTimeout(resolve, 25));
  await taskService.admitToRound(prisma, pending, { ...admitOptions, receivedAtMs: Date.now() });
  const afterRetry = await prisma.leg.findUnique({ where: { id: liveWork.leg.id } });
  const timerCount = await prisma.timer.count({ where: { entityType: "LEG", entityId: liveWork.leg.id } });

  record(
    "a retried admission moves neither the deadline nor the timer",
    deadlineBeforeRetry !== null &&
      afterRetry.slaDeadline instanceof Date &&
      afterRetry.slaDeadline.getTime() === deadlineBeforeRetry &&
      timerCount === 1,
    `deadline=${afterRetry.slaDeadline && afterRetry.slaDeadline.toISOString()} timers=${timerCount}`,
  );

  // The consumer, reading the column back out of PostgreSQL: §17.4's third triage key
  // orders on a measured breach proximity rather than on "unknown".
  const triaged = operatorCapacity.triage([
    { legId: "later", custodyState: "NONE", obstructionClass: null, queueAgeSeconds: 0, slaDeadline: new Date(afterRetry.slaDeadline.getTime() + 60_000) },
    { legId: liveWork.leg.legId, custodyState: "NONE", obstructionClass: null, queueAgeSeconds: 0, slaDeadline: afterRetry.slaDeadline },
  ]);
  record(
    "§17.4's triage comparator orders on the deadline this path persisted",
    triaged[0].legId === liveWork.leg.legId,
    triaged.map((r) => r.legId).join(" → "),
  );

  await resetSlaFixture();

  await prisma.$disconnect();

  process.stdout.write(`\n${checks.length} checks, ${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack}\n`);
  process.exit(1);
});

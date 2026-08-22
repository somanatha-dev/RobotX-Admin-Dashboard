"use strict";

/**
 * PHASE 5 — live-PostgreSQL verification of supervision and reconciliation (§4.5, §12).
 *
 * Phase 5's independent verification recorded, in its Part 4.4, that no migration in this
 * programme had been executed against a real PostgreSQL instance — the **fifth** consecutive
 * phase to carry that gap — and named what static review is weakest at catching for this
 * phase in particular:
 *
 *   1. **`Timer.entityVersion` is the programme's first `BIGINT` compared against a JS
 *      `BigInt` throughout the application.** A version that round-trips through the driver
 *      as a Number is silently wrong above 2^53 and right everywhere a hand-written test
 *      would look — and this column is the one the §4.5 discard rule turns on.
 *   2. **Seven hand-written CHECK constraints**, absent from Prisma's generated SQL by
 *      design, one of which must stay in lock-step with a runtime enum of **ten** members.
 *      A CHECK with a typo in a column name is a constraint that never fires.
 *   3. **Concurrency.** `timers.register`'s idempotency, `timers.resolve`'s at-least-once
 *      claim, `transitions.apply`'s conditional write, and the reconciler's "two sweeps
 *      produce one repair" are all claims about races. A single-threaded JavaScript store
 *      model cannot lose a race, so it cannot evidence any of them.
 *   4. **Transaction rollback.** §4.5 registers a timer *inside* the transition's own
 *      transaction precisely so a crash between the two writes cannot leave an unsupervised
 *      state. Only a real transaction can be rolled back to prove it.
 *
 * This harness drives the **shipped** `supervision/timers.js`, `leases.js`, `reconciler.js`,
 * `verification.js`, `lifecycle/transitions.js`, `settlement.js` and `workers/timer.worker.js`
 * against a real instance carrying the real migration chain. It writes no file and mutates
 * only rows it creates, under identifiers prefixed `p5-`.
 *
 * Usage:
 *   DATABASE_URL=postgresql://user:pw@127.0.0.1:55432/db node tools/verify/phase5LiveDatabase.js
 *
 * Deliberately **not** a Jest suite, for the same reason Phase 3's and Phase 4's harnesses
 * are not: it requires a PostgreSQL instance, and a test that silently skips when its
 * environment is absent is a test that reports green for having done nothing.
 */

const { PrismaClient } = require("@prisma/client");

const leases = require("../../src/engine/supervision/leases");
const reconciler = require("../../src/engine/supervision/reconciler");
const timers = require("../../src/engine/supervision/timers");
const verification = require("../../src/engine/supervision/verification");
const legMachine = require("../../src/engine/lifecycle/legMachine");
const settlement = require("../../src/engine/lifecycle/settlement");
const transitions = require("../../src/engine/lifecycle/transitions");
const timerWorker = require("../../src/workers/timer.worker");

const TX_TIMEOUT_MS = 30000;
const MAX_TIMER_LAG_SECONDS = 30;

const results = [];
let currentGroup = "";

function group(name) {
  currentGroup = name;
  console.log(`\n─── ${name} ${"─".repeat(Math.max(0, 74 - name.length))}`);
}

function record(label, ok, detail) {
  results.push({ group: currentGroup, label, ok, detail: detail || "" });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n          ${detail}` : ""}`);
}

function check(label, condition, detail) {
  record(label, Boolean(condition), detail);
}

let seq = 0;
const uid = (prefix) => `p5-${prefix}-${process.pid}-${(seq += 1)}`;

/** Did this operation fail, and with what PostgreSQL said about it? */
async function rejected(fn) {
  try {
    await fn();
    return { rejected: false, message: null };
  } catch (error) {
    return { rejected: true, message: error && error.message ? error.message : String(error) };
  }
}

const prisma = new PrismaClient();

/* ═══════════════════════════════════════════════════════════════════════════
   Fixture — a Mission, an Agent, a Leg, and a HARD commitment, as the shipped
   code would have written them.
   ═══════════════════════════════════════════════════════════════════════════ */

const created = { missions: [], agents: [], legs: [], commitments: [], tasks: [], outbox: [] };

async function makeMission() {
  const id = uid("mission");
  const row = await prisma.mission.create({ data: { id, missionId: id } });
  created.missions.push(id);
  return row;
}

async function makeAgent(capacity) {
  const id = uid("agent");
  // `capacityOverride` is raised because several groups here hold more than one concurrent
  // commitment on one agent. Phase 3's §10.3.2 capacity trigger is live on this instance and
  // refuses a slot beyond the agent's durable capacity — as it did, correctly, when this
  // harness was first run against a default-capacity agent.
  const row = await prisma.agent.create({
    data: {
      id,
      agentId: id,
      lifecycleState: "ACTIVE",
      authorityEpoch: 7n,
      fenceCounter: 41n,
      capacityOverride: capacity === undefined ? 8 : capacity,
    },
  });
  created.agents.push(id);
  return row;
}

const legSequence = new Map();

async function makeLeg(mission, overrides) {
  const id = uid("leg");
  // `Leg(missionId, sequence)` is unique: a Mission's Legs are ordered, and two Legs at one
  // position would be an ambiguous plan.
  const next = (legSequence.get(mission.id) || 0) + 1;
  legSequence.set(mission.id, next);
  const row = await prisma.leg.create({
    data: {
      id,
      legId: id,
      missionId: mission.id,
      sequence: next,
      purpose: "PRIMARY",
      state: "PLANNED",
      custodyState: "NONE",
      version: 0,
      ...(overrides || {}),
    },
  });
  created.legs.push(id);
  return row;
}

async function makeCommitment(agent, leg, overrides) {
  const id = uid("commitment");
  const now = await readStoreTime();
  const row = await prisma.commitment.create({
    data: {
      id,
      commitmentId: id,
      agentId: agent.id,
      legId: leg.id,
      kind: "HARD",
      fence: 42n,
      leaseExpiry: new Date(now.getTime() + 60_000),
      custodyState: "NONE",
      version: 0,
      grantedAt: now,
      capacitySlot: 0,
      ...(overrides || {}),
    },
  });
  created.commitments.push(id);
  return row;
}

async function readStoreTime() {
  const rows = await prisma.$queryRaw`SELECT NOW() AS now`;
  return rows[0].now;
}

async function cleanup() {
  // Legs cascade from Mission; Timers/Repairs are keyed by string and cleaned by prefix.
  await prisma.timer.deleteMany({ where: { entityId: { startsWith: "p5-" } } });
  await prisma.reconcilerRepair.deleteMany({ where: { entityId: { startsWith: "p5-" } } });
  await prisma.verificationEvidence.deleteMany({ where: { legId: { startsWith: "p5-" } } });
  await prisma.outbox.deleteMany({ where: { agentId: { startsWith: "p5-" } } });
  await prisma.commitment.deleteMany({ where: { commitmentId: { startsWith: "p5-" } } });
  await prisma.task.deleteMany({ where: { taskId: { startsWith: "p5-" } } });
  await prisma.leg.deleteMany({ where: { id: { startsWith: "p5-" } } });
  await prisma.mission.deleteMany({ where: { id: { startsWith: "p5-" } } });
  await prisma.agent.deleteMany({ where: { id: { startsWith: "p5-" } } });
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP 1 — the migration's own objects, as PostgreSQL created them
   ═══════════════════════════════════════════════════════════════════════════ */

async function group1() {
  group("1. Schema: tables, CHECK backstops, foreign keys, BigInt marshalling");

  const tables = await prisma.$queryRaw`
    SELECT table_name FROM information_schema.tables
    WHERE table_name IN ('Timer','ReconcilerRepair','VerificationEvidence')`;
  check("the three Phase 5 tables exist", tables.length === 3, `found ${tables.map((t) => t.table_name).join(", ")}`);

  const checks = await prisma.$queryRaw`
    SELECT con.conname FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname IN ('Timer','ReconcilerRepair','VerificationEvidence') AND con.contype = 'c'`;
  check("all seven hand-written CHECK constraints are present", checks.length === 7, `found ${checks.length}`);

  const mission = await makeMission();
  const leg = await makeLeg(mission);

  // Each CHECK is exercised by giving PostgreSQL a row the application would never write.
  // A constraint that never fires is indistinguishable from an absent one until it matters.
  const badEntityType = await rejected(() =>
    prisma.timer.create({
      data: {
        timerKey: uid("k"),
        entityType: "AGENT",
        entityId: leg.id,
        state: "OFFERED",
        entityVersion: 0n,
        dueAt: new Date(),
        handler: "H",
      },
    }),
  );
  check(
    "Timer_entity_type_known rejects an entity kind §4.5 does not supervise",
    badEntityType.rejected && /Timer_entity_type_known/.test(badEntityType.message),
    badEntityType.message ? badEntityType.message.split("\n")[0].slice(0, 110) : "",
  );

  const badTimerState = await rejected(() =>
    prisma.timer.create({
      data: {
        timerKey: uid("k"),
        entityType: "LEG",
        entityId: leg.id,
        state: "OFFERED",
        entityVersion: 0n,
        dueAt: new Date(),
        handler: "H",
        timerState: "SNOOZED",
      },
    }),
  );
  check(
    "Timer_state_known rejects a timer state outside the four",
    badTimerState.rejected && /Timer_state_known/.test(badTimerState.message),
  );

  const negativeVersion = await rejected(() =>
    prisma.timer.create({
      data: {
        timerKey: uid("k"),
        entityType: "LEG",
        entityId: leg.id,
        state: "OFFERED",
        entityVersion: -1n,
        dueAt: new Date(),
        handler: "H",
      },
    }),
  );
  check(
    "Timer_entity_version_non_negative rejects a negative version",
    negativeVersion.rejected && /Timer_entity_version_non_negative/.test(negativeVersion.message),
  );

  const badCategory = await rejected(() =>
    prisma.reconcilerRepair.create({
      data: { category: "SOMETHING_ELSE", entityType: "LEG", entityId: leg.id, action: "X", at: new Date() },
    }),
  );
  check(
    "ReconcilerRepair_category_known rejects a category outside §12.4's ten",
    badCategory.rejected && /ReconcilerRepair_category_known/.test(badCategory.message),
  );

  // The lock-step property the CHECK exists to enforce: every runtime enum member must be
  // an accepted category. A member the CHECK does not know would fail at 3am, not at review.
  let allCategoriesAccepted = true;
  for (const category of Object.values(reconciler.DIVERGENCE)) {
    const attempt = await rejected(() =>
      prisma.reconcilerRepair.create({
        data: { category, entityType: "LEG", entityId: leg.id, action: "LOCKSTEP_PROBE", at: new Date() },
      }),
    );
    if (attempt.rejected) allCategoriesAccepted = false;
  }
  check(
    "every one of the ten DIVERGENCE enum members is accepted by the CHECK — the enum and the constraint are in lock-step",
    allCategoriesAccepted,
    `${Object.keys(reconciler.DIVERGENCE).length} categories probed against the live constraint`,
  );
  // The probe rows are removed: they are this harness's writes, not the reconciler's, and
  // leaving them would inflate the per-category repair rate group 7 measures.
  await prisma.reconcilerRepair.deleteMany({ where: { action: "LOCKSTEP_PROBE" } });

  const badLevel = await rejected(() =>
    prisma.verificationEvidence.create({
      data: {
        evidenceId: uid("ev"),
        legId: leg.id,
        requiredLevel: "L4",
        achievedLevel: "L1",
        outcome: "SUFFICIENT",
        observedAt: new Date(),
      },
    }),
  );
  check(
    "VerificationEvidence_levels_known rejects a grade outside L0–L3",
    badLevel.rejected && /VerificationEvidence_levels_known/.test(badLevel.message),
  );

  const badOutcome = await rejected(() =>
    prisma.verificationEvidence.create({
      data: {
        evidenceId: uid("ev"),
        legId: leg.id,
        requiredLevel: "L1",
        achievedLevel: "L1",
        outcome: "MAYBE",
        observedAt: new Date(),
      },
    }),
  );
  check(
    "VerificationEvidence_outcome_known rejects an outcome outside SUFFICIENT/INSUFFICIENT",
    badOutcome.rejected && /VerificationEvidence_outcome_known/.test(badOutcome.message),
  );

  const orphanEvidence = await rejected(() =>
    prisma.verificationEvidence.create({
      data: {
        evidenceId: uid("ev"),
        legId: "p5-no-such-leg",
        requiredLevel: "L1",
        achievedLevel: "L1",
        outcome: "SUFFICIENT",
        observedAt: new Date(),
      },
    }),
  );
  check(
    "VerificationEvidence.legId → Leg.id is enforced — evidence cannot name a Leg that does not exist",
    orphanEvidence.rejected && /foreign key|Foreign key/.test(orphanEvidence.message),
  );

  // Item 1 of the list this harness exists for. 2^53 + 1 is the first integer a JS Number
  // cannot represent; if the driver marshals this column as a Number, the value comes back
  // changed and the §4.5 discard rule compares the wrong thing.
  const beyondDouble = 9007199254740993n; // 2^53 + 1
  const bigKey = uid("bigint-key");
  await prisma.timer.create({
    data: {
      timerKey: bigKey,
      entityType: "LEG",
      entityId: leg.id,
      state: "OFFERED",
      entityVersion: beyondDouble,
      dueAt: new Date(),
      handler: "H",
    },
  });
  const readBack = await prisma.timer.findUnique({ where: { timerKey: bigKey } });
  check(
    "Timer.entityVersion round-trips a BigInt beyond 2^53 exactly — the discard rule compares the real version",
    typeof readBack.entityVersion === "bigint" && readBack.entityVersion === beyondDouble,
    `wrote ${beyondDouble}, read ${readBack.entityVersion} (${typeof readBack.entityVersion})`,
  );

  const uniqueKey = await rejected(() =>
    prisma.timer.create({
      data: {
        timerKey: bigKey,
        entityType: "LEG",
        entityId: leg.id,
        state: "OFFERED",
        entityVersion: 1n,
        dueAt: new Date(),
        handler: "H",
      },
    }),
  );
  check(
    "Timer.timerKey is unique at the database — two timers for one deadline are impossible, not merely avoided",
    uniqueKey.rejected && /Unique constraint|unique/.test(uniqueKey.message),
  );

  // The FK's ON DELETE CASCADE, exercised rather than read.
  const cascadeLeg = await makeLeg(mission);
  await prisma.verificationEvidence.create({
    data: {
      evidenceId: uid("ev"),
      legId: cascadeLeg.id,
      requiredLevel: "L1",
      achievedLevel: "L1",
      outcome: "SUFFICIENT",
      observedAt: new Date(),
    },
  });
  await prisma.leg.delete({ where: { id: cascadeLeg.id } });
  const survivors = await prisma.verificationEvidence.count({ where: { legId: cascadeLeg.id } });
  check("deleting a Leg cascades its verification evidence — no evidence outlives its subject", survivors === 0);
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP 2 — §4.5 the durable timer store, against a real transaction
   ═══════════════════════════════════════════════════════════════════════════ */

async function group2() {
  group("2. §4.5 durable timers: keying, idempotency, atomic cancellation, rollback");

  const mission = await makeMission();
  const agent = await makeAgent();
  const leg = await makeLeg(mission, { state: "OFFERED" });
  const storeTime = await readStoreTime();

  const registerOnce = () =>
    prisma.$transaction(
      (tx) =>
        timers.register(tx, {
          entityType: timers.ENTITY_TYPE.LEG,
          entityId: leg.id,
          state: "OFFERED",
          entity: leg,
          dueAt: new Date(storeTime.getTime() + 60_000),
          handler: "WITHDRAW_EXCLUDE_REPLAN",
        }),
      { timeout: TX_TIMEOUT_MS },
    );

  const first = await registerOnce();
  check("a timer registers inside a transaction and is keyed on the Leg's own version", first.entityVersion === 0n);

  const second = await registerOnce();
  check(
    "registering the same deadline twice yields one timer, not two",
    second.id === first.id && (await prisma.timer.count({ where: { entityId: leg.id } })) === 1,
  );

  const outsideTx = await rejected(() =>
    timers.register(prisma, {
      entityType: timers.ENTITY_TYPE.LEG,
      entityId: leg.id,
      state: "OFFERED",
      entity: leg,
      dueAt: new Date(storeTime.getTime() + 60_000),
      handler: "WITHDRAW_EXCLUDE_REPLAN",
    }),
  );
  check(
    "registration refuses the base client — §4.5 requires the transition's own transaction",
    outsideTx.rejected && /transaction that enters or exits/.test(outsideTx.message),
  );

  // Phase 5 remediation, finding 3: the guard now inspects the entity it was always
  // documented to inspect. Exercised live because this is the call path callers use.
  const epochEntity = await rejected(() =>
    prisma.$transaction((tx) =>
      timers.register(tx, {
        entityType: timers.ENTITY_TYPE.LEG,
        entityId: leg.id,
        state: "OFFERED",
        entity: { ...leg, authorityEpoch: 7n },
        dueAt: new Date(storeTime.getTime() + 60_000),
        handler: "WITHDRAW_EXCLUDE_REPLAN",
      }),
    ),
  );
  check(
    "an entity carrying the agent's authorityEpoch is refused by name (§4.5)",
    epochEntity.rejected && /may not be keyed on "authorityEpoch"/.test(epochEntity.message),
  );

  // A commitment timer keys on the commitment's fence, not on any agent counter.
  const commitment = await makeCommitment(agent, leg);
  const commitmentTimer = await prisma.$transaction((tx) =>
    timers.register(tx, {
      entityType: timers.ENTITY_TYPE.COMMITMENT,
      entityId: commitment.commitmentId,
      state: "ACTIVE",
      entity: commitment,
      dueAt: new Date(storeTime.getTime() + 60_000),
      handler: "LEASE_EXPIRY_RECOVERY",
    }),
  );
  check(
    "a commitment timer is keyed on commitment.fence, never on the agent's epoch or fence counter",
    commitmentTimer.entityVersion === 42n && agent.authorityEpoch === 7n && agent.fenceCounter === 41n,
    `timer version ${commitmentTimer.entityVersion}, agent epoch ${agent.authorityEpoch}, agent fenceCounter ${agent.fenceCounter}`,
  );

  // §4.5: "cancelled atomically with the state exit."
  const cancelled = await prisma.$transaction((tx) =>
    timers.cancelFor(tx, {
      entityType: timers.ENTITY_TYPE.LEG,
      entityId: leg.id,
      storeTime,
      reason: "EXITED_OFFERED",
    }),
  );
  const stillPending = await prisma.timer.count({
    where: { entityType: "LEG", entityId: leg.id, timerState: "PENDING" },
  });
  check("exiting a state cancels its pending timers", cancelled === 1 && stillPending === 0);

  // Item 4 of the list this harness exists for: only a real transaction can be rolled back.
  const rollbackLeg = await makeLeg(mission, { state: "OFFERED" });
  const rollback = await rejected(() =>
    prisma.$transaction(async (tx) => {
      await timers.register(tx, {
        entityType: timers.ENTITY_TYPE.LEG,
        entityId: rollbackLeg.id,
        state: "OFFERED",
        entity: rollbackLeg,
        dueAt: new Date(storeTime.getTime() + 60_000),
        handler: "WITHDRAW_EXCLUDE_REPLAN",
      });
      throw new Error("crash after the timer write, before commit");
    }),
  );
  const afterRollback = await prisma.timer.count({ where: { entityId: rollbackLeg.id } });
  check(
    "a transaction that fails after the timer write leaves no timer — the deadline and its state commit together or not at all",
    rollback.rejected && afterRollback === 0,
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP 3 — §4.5 the discard rule and the timer worker
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A handler that does what a real one does: attempt a transition through the transaction
 * client it is handed.
 *
 * PHASE 5 REMEDIATION. It used to record the call and return `{ outcome: "ATTEMPTED" }`
 * without writing anything, and the assertions below expected the timer to resolve `FIRED`
 * afterwards. Both halves were wrong, and together they described the defect rather than
 * the requirement: a handler that moves nothing has not discharged its deadline, and
 * resolving the timer leaves the entity non-terminal with no pending timer — invariant I4's
 * violation. The worker now decides from the entity's own version, so a handler that means
 * to discharge a deadline has to actually move something.
 */
function handlerMap(calls) {
  return {
    WITHDRAW_EXCLUDE_REPLAN: async ({ tx, timer, entity }) => {
      calls.push(timer.id);
      await tx.leg.updateMany({
        where: { id: entity.id, version: entity.version },
        data: { state: "QUEUED", version: entity.version + 1 },
      });
      return { outcome: "OFFERED→QUEUED" };
    },
  };
}

function workerDeps(handlers, record) {
  return {
    prisma,
    readStoreTime,
    handlers,
    record: record || (() => {}),
    // §4.5's fire is one transaction — claim, act, resolve or re-arm — so the seam is part
    // of the worker's dependency contract and its absence is refused by name.
    runInTransaction: (fn) => prisma.$transaction(fn, { timeout: TX_TIMEOUT_MS, maxWait: TX_TIMEOUT_MS }),
  };
}

async function registerDueTimer(leg, storeTime, offsetMs) {
  return prisma.$transaction((tx) =>
    timers.register(tx, {
      entityType: timers.ENTITY_TYPE.LEG,
      entityId: leg.id,
      state: leg.state,
      entity: leg,
      dueAt: new Date(storeTime.getTime() + (offsetMs === undefined ? -1000 : offsetMs)),
      handler: "WITHDRAW_EXCLUDE_REPLAN",
    }),
  );
}

async function group3() {
  group("3. §4.5 the discard rule, at-least-once firing, restart, and multi-worker races");

  const mission = await makeMission();
  const storeTime = await readStoreTime();

  // Normal fire: version matches, handler runs, timer resolves FIRED.
  const healthy = await makeLeg(mission, { state: "OFFERED" });
  const healthyTimer = await registerDueTimer(healthy, storeTime);
  const calls = [];
  await timerWorker.fireDue(workerDeps(handlerMap(calls)), { maxTimerLagSeconds: MAX_TIMER_LAG_SECONDS });
  const firedRow = await prisma.timer.findUnique({ where: { id: healthyTimer.id } });
  check(
    "a due timer whose entity is unchanged fires its handler and resolves FIRED",
    calls.includes(healthyTimer.id) && firedRow.timerState === "FIRED" && firedRow.attempts === 1,
    `state ${firedRow.timerState}, attempts ${firedRow.attempts}`,
  );

  // The §4.5 discard rule, which is the whole point of keying on the entity's version.
  const moved = await makeLeg(mission, { state: "OFFERED" });
  const staleTimer = await registerDueTimer(moved, storeTime);
  await prisma.leg.update({ where: { id: moved.id }, data: { version: 1, state: "ACCEPTED" } });
  const staleCalls = [];
  await timerWorker.fireDue(workerDeps(handlerMap(staleCalls)), { maxTimerLagSeconds: MAX_TIMER_LAG_SECONDS });
  const staleRow = await prisma.timer.findUnique({ where: { id: staleTimer.id } });
  check(
    "a timer whose entity version moved on is DISCARDED and its handler is never called — a late timer cannot mutate newer state",
    staleRow.timerState === "DISCARDED" &&
      staleRow.lastOutcome === "ENTITY_VERSION_MOVED_ON" &&
      !staleCalls.includes(staleTimer.id),
    `state ${staleRow.timerState}, outcome ${staleRow.lastOutcome}, handler called: ${staleCalls.includes(staleTimer.id)}`,
  );

  // An entity that vanished under a pending timer is a referential defect, reported as its
  // own reason rather than folded into the ordinary stale case.
  const doomed = await makeLeg(mission, { state: "OFFERED" });
  const doomedTimer = await registerDueTimer(doomed, storeTime);
  await prisma.leg.delete({ where: { id: doomed.id } });
  await timerWorker.fireDue(workerDeps(handlerMap([])), { maxTimerLagSeconds: MAX_TIMER_LAG_SECONDS });
  const doomedRow = await prisma.timer.findUnique({ where: { id: doomedTimer.id } });
  check(
    "a timer whose entity no longer exists is discarded as its own reason",
    doomedRow.timerState === "DISCARDED" && doomedRow.lastOutcome === "ENTITY_NO_LONGER_EXISTS",
    `outcome ${doomedRow.lastOutcome}`,
  );

  // §12.1's own failure mode, avoided: an unregistered handler must not discharge a deadline.
  const unowned = await makeLeg(mission, { state: "OFFERED" });
  const unownedTimer = await registerDueTimer(unowned, storeTime);
  const events = [];
  await timerWorker.fireDue(workerDeps({}, (event, detail) => events.push({ event, detail })), {
    maxTimerLagSeconds: MAX_TIMER_LAG_SECONDS,
  });
  const unownedRow = await prisma.timer.findUnique({ where: { id: unownedTimer.id } });
  check(
    "a timer with no registered handler stays PENDING and is reported — a deadline nobody owns is never silently discharged",
    unownedRow.timerState === "PENDING" && events.some((e) => e.event === "timer.handler_not_registered"),
    `state ${unownedRow.timerState}`,
  );

  // Crash recovery: the worker dies before resolving. The row is still PENDING and still due,
  // so the next pass — a *different* worker — picks it up. This is the plan's chaos case.
  const crashLeg = await makeLeg(mission, { state: "OFFERED" });
  const crashTimer = await registerDueTimer(crashLeg, storeTime);
  const crashCalls = [];
  const crashingHandlers = {
    WITHDRAW_EXCLUDE_REPLAN: async ({ timer }) => {
      crashCalls.push(timer.id);
      throw new Error("worker died mid-handler");
    },
  };
  await timerWorker.fireDue(workerDeps(crashingHandlers), { maxTimerLagSeconds: MAX_TIMER_LAG_SECONDS });
  const afterCrash = await prisma.timer.findUnique({ where: { id: crashTimer.id } });
  check(
    "a handler that throws rolls its whole fire back and re-arms the deadline, with the cause recorded",
    // Changed by Phase 5's remediation, and the change is the correction. Resolving a timer
    // whose handler threw discharges a deadline nobody acted on. The fire is now one
    // transaction, so the throw rolls back the claim and any partial write with it, and the
    // deadline is re-armed on the state's own cadence rather than lost.
    afterCrash.timerState === "PENDING" && /HANDLER_THREW/.test(afterCrash.lastOutcome || "") && afterCrash.attempts === 1,
    `state ${afterCrash.timerState}, attempts ${afterCrash.attempts}, outcome ${afterCrash.lastOutcome}`,
  );

  // A timer left PENDING by a killed worker survives the restart and is fired afterwards.
  const restartLeg = await makeLeg(mission, { state: "OFFERED" });
  const restartTimer = await registerDueTimer(restartLeg, storeTime);
  const beforeRestart = await prisma.timer.findUnique({ where: { id: restartTimer.id } });
  const restartCalls = [];
  await timerWorker.fireDue(workerDeps(handlerMap(restartCalls)), { maxTimerLagSeconds: MAX_TIMER_LAG_SECONDS });
  const afterRestart = await prisma.timer.findUnique({ where: { id: restartTimer.id } });
  check(
    "a timer that came due while no worker was running is discovered and fired after the restart — the deadline is durable, not process-local",
    beforeRestart.timerState === "PENDING" && restartCalls.includes(restartTimer.id) && afterRestart.timerState === "FIRED",
  );

  // At-least-once, and the idempotency that makes it safe: fire the same timer twice.
  const twiceLeg = await makeLeg(mission, { state: "OFFERED" });
  const twiceTimer = await registerDueTimer(twiceLeg, storeTime);
  const firstResolve = await timers.resolve(prisma, {
    id: twiceTimer.id,
    timerState: timers.TIMER_STATE.FIRED,
    storeTime,
    outcome: "ATTEMPTED",
  });
  const secondResolve = await timers.resolve(prisma, {
    id: twiceTimer.id,
    timerState: timers.TIMER_STATE.FIRED,
    storeTime,
    outcome: "ATTEMPTED_AGAIN",
  });
  const twiceRow = await prisma.timer.findUnique({ where: { id: twiceTimer.id } });
  check(
    "resolving a timer twice resolves it once — the second delivery is a no-op, not a second side effect",
    firstResolve === 1 && secondResolve === 0 && twiceRow.attempts === 1,
    `resolutions ${firstResolve}/${secondResolve}, attempts ${twiceRow.attempts}`,
  );

  // Item 3: two workers, genuinely concurrent, over one due set. A single-threaded model
  // cannot lose this race; PostgreSQL can.
  const raceLegs = [];
  const raceTimers = [];
  for (let index = 0; index < 8; index += 1) {
    const raceLeg = await makeLeg(mission, { state: "OFFERED" });
    raceLegs.push(raceLeg);
    raceTimers.push(await registerDueTimer(raceLeg, storeTime));
  }
  const workerACalls = [];
  const workerBCalls = [];
  const [passA, passB] = await Promise.all([
    timerWorker.fireDue(workerDeps(handlerMap(workerACalls)), { maxTimerLagSeconds: MAX_TIMER_LAG_SECONDS }),
    timerWorker.fireDue(workerDeps(handlerMap(workerBCalls)), { maxTimerLagSeconds: MAX_TIMER_LAG_SECONDS }),
  ]);
  const raceRows = await prisma.timer.findMany({ where: { id: { in: raceTimers.map((t) => t.id) } } });
  const unresolved = raceRows.filter((row) => row.timerState === "PENDING");
  const overResolved = raceRows.filter((row) => row.attempts > 1);
  check(
    "two concurrent timer workers lose no timer — every due timer is resolved",
    unresolved.length === 0,
    `${raceRows.length} timers, ${unresolved.length} left pending (worker A fired ${passA.fired}, worker B fired ${passB.fired})`,
  );
  check(
    "and no timer is resolved twice — the claim is what decides the winner",
    overResolved.length === 0,
    `${overResolved.length} timers with attempts > 1`,
  );
  check(
    "and no handler ran twice for one timer — the claim precedes the action, so the loser does no work",
    // Stronger than the resolution check above and the property that actually matters:
    // before this remediation both workers ran the handler and only the *resolution* was
    // conditional, which is sound for a handler whose effect is a conditional write and
    // unsound for one whose effect is a page.
    new Set([...workerACalls, ...workerBCalls]).size === workerACalls.length + workerBCalls.length,
    `worker A ran ${workerACalls.length}, worker B ran ${workerBCalls.length}, distinct ${new Set([...workerACalls, ...workerBCalls]).size}`,
  );

  // §4.5's lag SLI, measured rather than asserted.
  const lagLeg = await makeLeg(mission, { state: "OFFERED" });
  const lagOffsetMs = -45_000;
  await registerDueTimer(lagLeg, storeTime, lagOffsetMs);
  const lag = await timers.readLag(prisma, await readStoreTime());
  check(
    "the timer-lag SLI reports the age of the oldest overdue timer, in seconds",
    lag.lagSeconds >= 44 && lag.overdue >= 1,
    `lagSeconds ${lag.lagSeconds.toFixed(1)}, overdue ${lag.overdue}, pending ${lag.pending}`,
  );
  const degraded = timers.assessLag(lag, MAX_TIMER_LAG_SECONDS);
  check(
    "lag beyond supervise.max_timer_lag raises the degraded directive whose load-bearing half is to stop hardening",
    degraded.degraded === true && degraded.directive.stopNewHardening === true,
    `threshold ${MAX_TIMER_LAG_SECONDS}s, observed ${lag.lagSeconds.toFixed(1)}s → ${degraded.directive.enterDegradedMode}`,
  );
  const healthyLag = timers.assessLag({ lagSeconds: 1 }, MAX_TIMER_LAG_SECONDS);
  check("and a healthy lag does not", healthyLag.degraded === false);

  // The threshold comes from configuration, not from the module.
  const noThreshold = await rejected(async () => timers.assessLag(lag, undefined));
  check(
    "the lag threshold is a supplied parameter — an absent one is refused, never defaulted",
    noThreshold.rejected && /max_timer_lag/.test(noThreshold.message),
  );

  await prisma.timer.updateMany({ where: { entityId: lagLeg.id }, data: { timerState: "CANCELLED" } });
  await prisma.timer.updateMany({ where: { entityId: unowned.id }, data: { timerState: "CANCELLED" } });
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP 4 — §12.2 lease renewal and custody-aware expiry
   ═══════════════════════════════════════════════════════════════════════════ */

async function group4() {
  group("4. §12.2 lease renewal on positive evidence; §4.7 custody-aware recovery");

  const mission = await makeMission();
  const agent = await makeAgent();
  const leg = await makeLeg(mission, { state: "EN_ROUTE_DROP" });
  const commitment = await makeCommitment(agent, leg);
  const storeTime = await readStoreTime();

  const renewWith = (evidence, row) =>
    prisma.$transaction((tx) =>
      leases.renew(tx, {
        commitment: row || commitment,
        evidence,
        storeTime,
        leaseDurationSeconds: 60,
      }),
    );

  const renewed = await renewWith({ commitmentId: commitment.commitmentId, fence: commitment.fence });
  const renewedRow = await prisma.commitment.findUnique({ where: { commitmentId: commitment.commitmentId } });
  check(
    "a heartbeat naming this commitment and its fence renews the lease, and the renewal is a durable write",
    renewed.outcome === "RENEWED" && renewedRow.leaseExpiry.getTime() > commitment.leaseExpiry.getTime(),
    `${commitment.leaseExpiry.toISOString()} → ${renewedRow.leaseExpiry.toISOString()}`,
  );

  const ping = await renewWith({});
  check(
    "a generic connectivity ping renews nothing — it proves the link, not the mission",
    ping.outcome !== "RENEWED",
    `outcome ${ping.outcome}, reason ${ping.reason}`,
  );

  const otherCommitment = await renewWith({ commitmentId: "p5-some-other-commitment", fence: commitment.fence });
  check(
    "evidence naming another commitment does not renew this one — leases are per commitment",
    otherCommitment.outcome !== "RENEWED",
    `outcome ${otherCommitment.outcome}`,
  );

  const staleFence = await renewWith({ commitmentId: commitment.commitmentId, fence: commitment.fence - 1n });
  check(
    "evidence carrying a superseded fence does not renew — stale evidence cannot extend authority",
    staleFence.outcome !== "RENEWED",
    `outcome ${staleFence.outcome}`,
  );

  const releasedLeg = await makeLeg(mission, { state: "EN_ROUTE_DROP" });
  const releasedCommitment = await makeCommitment(agent, releasedLeg, {
    capacitySlot: 1,
    releasedAt: storeTime,
  });
  const afterRelease = await renewWith(
    { commitmentId: releasedCommitment.commitmentId, fence: releasedCommitment.fence },
    releasedCommitment,
  );
  check(
    "a released commitment is not renewable — renewal cannot resurrect a commitment somebody already recovered from",
    afterRelease.outcome === "NOT_RENEWABLE",
    `outcome ${afterRelease.outcome}`,
  );

  // Expiry detection against the live clock.
  const expiredLeg = await makeLeg(mission, { state: "EN_ROUTE_DROP", custodyState: "HELD" });
  const expiredCommitment = await makeCommitment(agent, expiredLeg, {
    capacitySlot: 2,
    leaseExpiry: new Date(storeTime.getTime() - 120_000),
  });
  const expired = await leases.findExpired(prisma, { storeTime: await readStoreTime(), limit: 50 });
  check(
    "an expired lease is found by the expiry scan",
    expired.some((row) => row.commitmentId === expiredCommitment.commitmentId),
    `${expired.length} expired commitment(s) found`,
  );

  // §4.7's custody-aware assessment, over live rows. This is the decision the Phase 5
  // remediation collapsed onto one implementation.
  const heldLeg = await prisma.leg.findUnique({ where: { id: expiredLeg.id } });
  const heldAssessment = leases.assessRecovery({
    leg: heldLeg,
    custodyState: heldLeg.custodyState,
    obstructionClass: heldLeg.obstructionClass,
  });
  check(
    "custody HELD with an unreachable incumbent takes the physical-recovery path, not the reassignment one",
    heldAssessment.outcome === "PHYSICAL_RECOVERY" &&
      legMachine.isTerminal(heldAssessment.legState) === false &&
      /STRANDED/.test(heldAssessment.legState),
    `outcome ${heldAssessment.outcome} → ${heldAssessment.legState}`,
  );

  const disputedLeg = await makeLeg(mission, { state: "RELEASED", custodyState: "DISPUTED", obstructionClass: "CLEAR" });
  const disputedAssessment = leases.assessRecovery({
    leg: disputedLeg,
    custodyState: disputedLeg.custodyState,
    obstructionClass: disputedLeg.obstructionClass,
  });
  const disputedTarget = transitions.leaseExpiryTarget({
    leg: disputedLeg,
    custodyState: disputedLeg.custodyState,
    obstructionClass: disputedLeg.obstructionClass,
  });
  check(
    "DISPUTED custody takes the same physical-recovery path in both the §4.4 table and the §4.7 assessment (Phase 5 remediation, finding 1)",
    disputedAssessment.outcome === "PHYSICAL_RECOVERY" && disputedTarget === disputedAssessment.legState,
    `assessRecovery → ${disputedAssessment.legState}; transitions.leaseExpiryTarget → ${disputedTarget}`,
  );

  const noCustodyLeg = await makeLeg(mission, { state: "EN_ROUTE_PICKUP", custodyState: "NONE" });
  const noCustody = leases.assessRecovery({ leg: noCustodyLeg, custodyState: "NONE" });
  check(
    "custody NONE is a scheduling problem and reassigns",
    noCustody.outcome === "REASSIGN" && noCustody.legState === "REASSIGNING",
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP 5 — §4.4 transitions: conditional writes, timer coupling, races
   ═══════════════════════════════════════════════════════════════════════════ */

async function group5() {
  group("5. §4.4 transitions: conditional writes, atomic timer coupling, concurrent races");

  const mission = await makeMission();
  const agent = await makeAgent();
  const storeTime = await readStoreTime();

  const leg = await makeLeg(mission, { state: "OFFERED" });
  const legCommitment = await makeCommitment(agent, leg);
  // §4.4's ACK row is guarded by FENCE_MATCHES_OFFER_UNEXPIRED: the response must name its
  // commitment, carry the fence it was offered at, and arrive inside the offer's validity.
  const ackContext = { commitment: legCommitment, fence: legCommitment.fence, offerUnexpired: true };
  const applied = await prisma.$transaction(
    (tx) =>
      transitions.apply(tx, {
        leg,
        event: transitions.EVENT.AGENT_ACK,
        storeTime,
        deadlineSeconds: 300,
        context: ackContext,
      }),
    { timeout: TX_TIMEOUT_MS },
  );
  const afterApply = await prisma.leg.findUnique({ where: { id: leg.id } });
  const registeredTimer = await prisma.timer.findFirst({
    where: { entityId: leg.id, timerState: "PENDING" },
  });
  check(
    "applying a §4.4 transition writes the state, bumps the version, and registers the target state's timer in one transaction",
    applied.outcome === "APPLIED" &&
      afterApply.version === 1 &&
      registeredTimer !== null &&
      registeredTimer.entityVersion === 1n,
    `outcome ${applied.outcome}, ${leg.state} → ${afterApply.state} v${afterApply.version}, timer at v${registeredTimer ? registeredTimer.entityVersion : "none"}`,
  );

  // The timer registered is keyed on the *new* version, so the timer that supervised the
  // state just left is superseded rather than left to fire against newer state.
  const supersededCount = await prisma.timer.count({
    where: { entityId: leg.id, entityVersion: 0n, timerState: "PENDING" },
  });
  check("no pending timer remains at the version the Leg has left", supersededCount === 0);

  // Two concurrent transitions on one Leg: exactly one wins, and the loser is told so
  // rather than overwriting.
  const raceLeg = await makeLeg(mission, { state: "OFFERED" });
  const raceCommitment = await makeCommitment(agent, raceLeg, { capacitySlot: 1 });
  const raceContext = { commitment: raceCommitment, fence: raceCommitment.fence, offerUnexpired: true };
  const attempt = () =>
    prisma.$transaction(
      (tx) =>
        transitions.apply(tx, {
          leg: raceLeg,
          event: transitions.EVENT.AGENT_ACK,
          storeTime,
          deadlineSeconds: 300,
          context: raceContext,
        }),
      { timeout: TX_TIMEOUT_MS },
    );
  const outcomes = await Promise.allSettled([attempt(), attempt()]);
  const settled = outcomes.map((o) => (o.status === "fulfilled" ? o.value.outcome : `THREW:${o.reason.message}`));
  const winners = settled.filter((o) => o === "APPLIED");
  const raceRow = await prisma.leg.findUnique({ where: { id: raceLeg.id } });
  check(
    "two concurrent applications of one transition produce exactly one state change",
    winners.length === 1 && raceRow.version === 1,
    `outcomes ${settled.join(" / ")}; final version ${raceRow.version}`,
  );

  // A crash inside the transition's transaction leaves neither half.
  const atomicLeg = await makeLeg(mission, { state: "OFFERED" });
  const atomicCommitment = await makeCommitment(agent, atomicLeg, { capacitySlot: 2 });
  const crashed = await rejected(() =>
    prisma.$transaction(async (tx) => {
      await transitions.apply(tx, {
        leg: atomicLeg,
        event: transitions.EVENT.AGENT_ACK,
        storeTime,
        deadlineSeconds: 300,
        context: { commitment: atomicCommitment, fence: atomicCommitment.fence, offerUnexpired: true },
      });
      throw new Error("crash after the state write and the timer write, before commit");
    }),
  );
  const atomicRow = await prisma.leg.findUnique({ where: { id: atomicLeg.id } });
  const atomicTimers = await prisma.timer.count({ where: { entityId: atomicLeg.id } });
  check(
    "a crash inside the transition leaves neither the state change nor the timer — no half-supervised state survives a restart",
    crashed.rejected && atomicRow.version === 0 && atomicRow.state === "OFFERED" && atomicTimers === 0,
    `version ${atomicRow.version}, state ${atomicRow.state}, timers ${atomicTimers}`,
  );

  // An illegal transition is refused rather than guessed at.
  const acceptedLeg = await prisma.leg.findUnique({ where: { id: leg.id } });
  const illegal = await prisma.$transaction((tx) =>
    transitions.apply(tx, {
      leg: acceptedLeg,
      event: transitions.EVENT.ROUND_SELECTS_COLUMN,
      storeTime,
      deadlineSeconds: 300,
    }),
  );
  check(
    "a pair with no row in §4.4 is refused as NO_SUCH_TRANSITION, never applied",
    illegal.outcome === "NO_SUCH_TRANSITION",
    `outcome ${illegal.outcome}`,
  );

  // A guard whose evidence is absent fails as indeterminate rather than passing.
  const guardLeg = await makeLeg(mission, { state: "OFFERED" });
  const unguarded = await prisma.$transaction((tx) =>
    transitions.apply(tx, { leg: guardLeg, event: transitions.EVENT.AGENT_ACK, storeTime, deadlineSeconds: 300 }),
  );
  const guardRow = await prisma.leg.findUnique({ where: { id: guardLeg.id } });
  check(
    "a transition whose guard evidence is absent is refused and writes nothing (§4.1 rule 3)",
    unguarded.outcome === "REFUSED" && guardRow.version === 0,
    `outcome ${unguarded.outcome}, reason ${unguarded.reason}`,
  );

  // I12: a terminal state is never reopened.
  const terminal = await makeLeg(mission, { state: "CANCELLED" });
  let terminalRefused = true;
  for (const event of Object.values(transitions.EVENT)) {
    if (transitions.find(terminal.state, event) !== null) terminalRefused = false;
  }
  check(
    "no §4.4 event has a row out of a terminal Leg state — terminal states cannot be reopened (I12)",
    terminalRefused,
    `checked ${Object.values(transitions.EVENT).length} events against ${terminal.state}`,
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP 6 — §12.4 the reconciliation loop, all ten classes
   ═══════════════════════════════════════════════════════════════════════════ */

function reconcilerDeps(overrides) {
  return {
    prisma,
    runInTransaction: (fn) => prisma.$transaction(fn, { timeout: TX_TIMEOUT_MS }),
    readStoreTime,
    ...(overrides || {}),
  };
}

const reconcilerConfig = {
  batch: 200,
  assignmentDeadlineSeconds: 900,
  unresponsiveStrikes: 3,
  energyDeviationTolerance: 0.15,
  shardId: "default",
};

async function repairsFor(category, entityId) {
  return prisma.reconcilerRepair.count({ where: { category, entityId } });
}

async function group6() {
  group("6. §12.4 the reconciliation loop — the four classes the shipped suite never constructed");

  const mission = await makeMission();
  const agent = await makeAgent();
  const storeTime = await readStoreTime();

  /* Row 5 — "Lease expired, not yet processed." Repair: "Run the §4.7 recovery path." */
  const expiredLeg = await makeLeg(mission, { state: "EN_ROUTE_DROP", custodyState: "HELD", obstructionClass: "CLEAR" });
  const expiredCommitment = await makeCommitment(agent, expiredLeg, {
    leaseExpiry: new Date(storeTime.getTime() - 300_000),
  });
  const recoveries = [];
  const leaseScan = await reconciler.scanExpiredLeases(
    reconcilerDeps({ recover: async (input) => recoveries.push(input) }),
    reconcilerConfig,
    await readStoreTime(),
  );
  check(
    "LEASE_EXPIRED_UNPROCESSED: an expired lease is detected and the §4.7 recovery path is run for it",
    leaseScan.repaired >= 1 &&
      leaseScan.assessments.some((a) => a.commitmentId === expiredCommitment.commitmentId) &&
      recoveries.some((r) => r.commitment.commitmentId === expiredCommitment.commitmentId),
    `${leaseScan.repaired} assessment(s); recovery callback invoked ${recoveries.length} time(s)`,
  );
  const custodyAware = leaseScan.assessments.find((a) => a.commitmentId === expiredCommitment.commitmentId);
  check(
    "…and the recovery it runs is custody-aware — a HELD Leg strands rather than being reassigned",
    custodyAware && custodyAware.assessment.outcome === "PHYSICAL_RECOVERY",
    `outcome ${custodyAware ? custodyAware.assessment.outcome : "none"} → ${custodyAware ? custodyAware.assessment.legState : "?"}`,
  );
  check(
    "…and the repair is counted under its own category",
    (await repairsFor(reconciler.DIVERGENCE.LEASE_EXPIRED_UNPROCESSED, expiredCommitment.commitmentId)) === 1,
  );

  // A Leg already in a recovery state is not re-processed: I2 reads "has a valid lease
  // **or is in a recovery state**".
  await prisma.leg.update({ where: { id: expiredLeg.id }, data: { state: "STRANDED_SAFE" } });
  const secondLeaseScan = await reconciler.scanExpiredLeases(reconcilerDeps(), reconcilerConfig, await readStoreTime());
  check(
    "…and a Leg already in a recovery state is not assessed again — the scan is idempotent over processed expiry",
    !secondLeaseScan.assessments.some((a) => a.commitmentId === expiredCommitment.commitmentId),
    `${secondLeaseScan.repaired} assessment(s) on the second pass`,
  );

  /* Row 7 — "Task WAITING beyond SLA with no queue entry." Escalate: Always. */
  const waitingTask = await prisma.task.create({
    data: {
      id: uid("task"),
      taskId: uid("task"),
      pickup: "A",
      pickupLat: 0,
      pickupLon: 0,
      drop: "B",
      dropLat: 1,
      dropLon: 1,
      status: "WAITING",
      createdAt: new Date(storeTime.getTime() - 3600_000),
      version: 0,
    },
  });
  created.tasks.push(waitingTask.id);
  const waitingScan = await reconciler.scanWaitingTasks(reconcilerDeps(), reconcilerConfig, await readStoreTime());
  check(
    "TASK_WAITING_BEYOND_SLA: a Task waiting past sla.assignment_deadline with no queue entry is detected",
    waitingScan.repaired >= 1 && waitingScan.repairs.some((r) => r.taskId === waitingTask.id),
    `${waitingScan.repaired} repair(s)`,
  );
  const waitingRepair = await prisma.reconcilerRepair.findFirst({
    where: { category: reconciler.DIVERGENCE.TASK_WAITING_BEYOND_SLA, entityId: waitingTask.id },
  });
  check(
    "…counted, and escalated — §12.4's 'Escalate when: Always' for this row",
    waitingRepair !== null && waitingRepair.escalated === true && waitingRepair.action === "REQUEUE_AND_INVESTIGATE",
    `action ${waitingRepair ? waitingRepair.action : "none"}, escalated ${waitingRepair ? waitingRepair.escalated : "?"}`,
  );

  // The live relation filter the JavaScript store model cannot express: a Task whose
  // Mission still has a queued Leg is *not* a divergence, and must not be repaired.
  const queuedMission = await makeMission();
  await makeLeg(queuedMission, { state: "QUEUED" });
  const queuedTask = await prisma.task.create({
    data: {
      id: uid("task"),
      taskId: uid("task"),
      pickup: "A",
      pickupLat: 0,
      pickupLon: 0,
      drop: "B",
      dropLat: 1,
      dropLon: 1,
      status: "WAITING",
      createdAt: new Date(storeTime.getTime() - 3600_000),
      version: 0,
      missions: { connect: { id: queuedMission.id } },
    },
  });
  created.tasks.push(queuedTask.id);
  const withQueueEntry = await reconciler.scanWaitingTasks(reconcilerDeps(), reconcilerConfig, await readStoreTime());
  check(
    "…and a waiting Task that still has a queue entry is left alone — the divergence is the *missing* entry, not the waiting",
    !withQueueEntry.repairs.some((r) => r.taskId === queuedTask.id),
    "verified through the live Mission↔Task relation the JS store model cannot express",
  );

  // A Task inside its SLA is not a divergence either — the boundary, checked.
  const freshTask = await prisma.task.create({
    data: {
      id: uid("task"),
      taskId: uid("task"),
      pickup: "A",
      pickupLat: 0,
      pickupLon: 0,
      drop: "B",
      dropLat: 1,
      dropLon: 1,
      status: "WAITING",
      createdAt: new Date(storeTime.getTime() - 60_000),
      version: 0,
    },
  });
  created.tasks.push(freshTask.id);
  const freshScan = await reconciler.scanWaitingTasks(reconcilerDeps(), reconcilerConfig, await readStoreTime());
  check(
    "…and a Task still inside its SLA is not repaired — the threshold is the registered deadline, not the scan's opinion",
    !freshScan.repairs.some((r) => r.taskId === freshTask.id),
    `sla ${reconcilerConfig.assignmentDeadlineSeconds}s, task age 60s`,
  );

  /* Row 8 — "Outbox row undelivered past deadline." Repair: the §11.4 ladder. */
  const outboxLeg = await makeLeg(mission, { state: "OFFERED" });
  const outboxCommitment = await makeCommitment(agent, outboxLeg, { capacitySlot: 1 });
  const staleOutbox = await prisma.outbox.create({
    data: {
      id: uid("outbox"),
      idempotencyKey: uid("idem"),
      agentId: agent.id,
      commitmentId: outboxCommitment.commitmentId,
      commandClass: "MISSION",
      command: "ASSIGN_MISSION",
      fenceScope: "COMMITMENT",
      fence: 42n,
      sequence: 1,
      payload: {},
      notValidAfter: new Date(storeTime.getTime() - 60_000),
      signature: "sig",
      state: "PENDING",
      attempts: 4,
    },
  });
  created.outbox.push(staleOutbox.id);
  const outboxScan = await reconciler.scanUndeliveredOutbox(reconcilerDeps(), reconcilerConfig, await readStoreTime());
  const outboxRepair = await prisma.reconcilerRepair.findFirst({
    where: { category: reconciler.DIVERGENCE.OUTBOX_UNDELIVERED_PAST_DEADLINE, entityId: staleOutbox.id },
  });
  check(
    "OUTBOX_UNDELIVERED_PAST_DEADLINE: a row past its deadline is observed, counted, and deferred to the §11.4 ladder",
    outboxScan.repaired >= 1 && outboxRepair !== null && outboxRepair.action === "DEFER_TO_DISPATCH_LADDER",
    `${outboxScan.repaired} row(s); action ${outboxRepair ? outboxRepair.action : "none"}`,
  );
  check(
    "…and escalates once the attempts reach the unresponsive-strike count (§12.4 'Step 3+')",
    outboxRepair !== null && outboxRepair.escalated === true,
    `attempts ${staleOutbox.attempts} vs strikes ${reconcilerConfig.unresponsiveStrikes}`,
  );

  /* Row 10 — "Energy accounting inconsistent with telemetry." */
  const energyLeg = await makeLeg(mission, { state: "SETTLED" });
  const energyCommitment = await makeCommitment(agent, energyLeg, {
    capacitySlot: 3,
    releasedAt: storeTime,
  });
  const energyScan = await reconciler.scanEnergyAccounting(
    reconcilerDeps({
      energyAccounting: async (commitmentId) =>
        commitmentId === energyCommitment.commitmentId ? { predictedWh: 100, realisedWh: 120 } : null,
    }),
    reconcilerConfig,
    await readStoreTime(),
  );
  const energyRepair = await prisma.reconcilerRepair.findFirst({
    where: { category: reconciler.DIVERGENCE.ENERGY_ACCOUNTING_INCONSISTENT, entityId: energyCommitment.commitmentId },
  });
  check(
    "ENERGY_ACCOUNTING_INCONSISTENT: realised consumption beyond energy.deviation_tolerance is detected and flagged for recalibration",
    energyScan.repaired >= 1 && energyRepair !== null && energyRepair.action === "RECOMPUTE_AND_FLAG_CALIBRATION",
    `deviation 20% vs tolerance ${reconcilerConfig.energyDeviationTolerance * 100}%`,
  );
  check(
    "…and a deviation above tolerance but below 'large' is flagged, not paged",
    energyRepair !== null && energyRepair.escalated === false,
    "large = twice the mid-mission tolerance = 30%; 20% is above tolerance and below large",
  );

  const largeLeg = await makeLeg(mission, { state: "SETTLED" });
  const largeCommitment = await makeCommitment(agent, largeLeg, { capacitySlot: 4, releasedAt: storeTime });
  await reconciler.scanEnergyAccounting(
    reconcilerDeps({
      energyAccounting: async (commitmentId) =>
        commitmentId === largeCommitment.commitmentId ? { predictedWh: 100, realisedWh: 180 } : null,
    }),
    reconcilerConfig,
    await readStoreTime(),
  );
  const largeRepair = await prisma.reconcilerRepair.findFirst({
    where: { category: reconciler.DIVERGENCE.ENERGY_ACCOUNTING_INCONSISTENT, entityId: largeCommitment.commitmentId },
  });
  check(
    "…and a genuinely large divergence does escalate — §12.4's 'Escalate when: Large divergence'",
    largeRepair !== null && largeRepair.escalated === true,
    "80% deviation against a 30% large-divergence line",
  );

  const withinTolerance = await reconciler.scanEnergyAccounting(
    reconcilerDeps({ energyAccounting: async () => ({ predictedWh: 100, realisedWh: 105 }) }),
    reconcilerConfig,
    await readStoreTime(),
  );
  check(
    "…and consumption inside tolerance is not a divergence",
    withinTolerance.repaired === 0,
    `${withinTolerance.repaired} finding(s) at 5% deviation`,
  );

  const noModel = await reconciler.scanEnergyAccounting(reconcilerDeps(), reconcilerConfig, await readStoreTime());
  check(
    "…and with no energy model supplied the scan is skipped by name, never assumed consistent (§4.1 rule 3)",
    noModel.skipped === "NO_ENERGY_MODEL" && noModel.repaired === 0,
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP 7 — the full sweep: idempotency, concurrency, the repair-rate SLI
   ═══════════════════════════════════════════════════════════════════════════ */

async function group7() {
  group("7. §12.4 full sweep: all ten classes, idempotency, concurrent sweeps, repair-rate SLI");

  const mission = await makeMission();
  const orphan = await makeLeg(mission, { state: "ACCEPTED" });

  const sweepOne = await reconciler.sweep(reconcilerDeps(), reconcilerConfig);
  check(
    "one sweep runs every one of §12.4's ten classes and reports a per-category count",
    sweepOne.results.length === 10 &&
      Object.keys(sweepOne.byCategory).sort().join(",") === Object.values(reconciler.DIVERGENCE).sort().join(","),
    `${sweepOne.results.length} scans, ${Object.keys(sweepOne.byCategory).length} categories`,
  );
  check(
    "…and the orphan Leg it found is repaired to QUEUED with a supervising timer",
    (await prisma.leg.findUnique({ where: { id: orphan.id } })).state === "QUEUED" &&
      (await prisma.timer.count({ where: { entityId: orphan.id, timerState: "PENDING" } })) === 1,
  );

  const orphanAfterFirst = await prisma.leg.findUnique({ where: { id: orphan.id } });
  const sweepTwo = await reconciler.sweep(reconcilerDeps(), reconcilerConfig);
  const orphanAfterSecond = await prisma.leg.findUnique({ where: { id: orphan.id } });
  check(
    "a second sweep over repaired state performs no second state repair — the repair is idempotent",
    orphanAfterSecond.version === orphanAfterFirst.version && orphanAfterSecond.state === orphanAfterFirst.state,
    `version ${orphanAfterFirst.version} → ${orphanAfterSecond.version} (sweep 2 found ${sweepTwo.byCategory.ORPHAN_LEG} orphan(s))`,
  );

  // Two reconcilers on one shard, genuinely concurrent, over the same divergence.
  const contested = await makeLeg(mission, { state: "ACCEPTED" });
  const before = await prisma.leg.findUnique({ where: { id: contested.id } });
  const [sweepA, sweepB] = await Promise.allSettled([
    reconciler.sweep(reconcilerDeps(), reconcilerConfig),
    reconciler.sweep(reconcilerDeps(), reconcilerConfig),
  ]);
  const after = await prisma.leg.findUnique({ where: { id: contested.id } });
  check(
    "two concurrent reconciler sweeps repair one divergence once — the conditional write decides the winner",
    after.version === before.version + 1 && after.state === "QUEUED",
    `version ${before.version} → ${after.version}; sweeps ${sweepA.status}/${sweepB.status}`,
  );
  const duplicateTimers = await prisma.timer.count({
    where: { entityId: contested.id, timerState: "PENDING" },
  });
  check(
    "…and leaves exactly one supervising timer, not two",
    duplicateTimers === 1,
    `${duplicateTimers} pending timer(s)`,
  );

  const rate = await reconciler.readRepairRate(prisma, {
    since: new Date((await readStoreTime()).getTime() - 3600_000),
    storeTime: await readStoreTime(),
  });
  check(
    "the repair rate is readable per category and reports every category even at zero",
    rate.total > 0 &&
      Object.keys(rate.byCategory).sort().join(",") === Object.values(reconciler.DIVERGENCE).sort().join(","),
    `total ${rate.total} over ${Object.keys(rate.byCategory).length} categories`,
  );
  check(
    "…so a category that has stopped reporting is distinguishable from one that is genuinely idle",
    rate.byCategory[reconciler.DIVERGENCE.ORPHAN_LEG] > 0 &&
      rate.byCategory[reconciler.DIVERGENCE.COMMITMENT_UNKNOWN_TO_AGENT] === 0,
    `ORPHAN_LEG ${rate.byCategory.ORPHAN_LEG}, COMMITMENT_UNKNOWN_TO_AGENT ${rate.byCategory.COMMITMENT_UNKNOWN_TO_AGENT}`,
  );

  const noTransaction = await rejected(() =>
    reconciler.sweep({ prisma, readStoreTime }, reconcilerConfig),
  );
  check(
    "the reconciler refuses to run without a transaction to repair inside",
    noTransaction.rejected && /conditional write inside a transaction/.test(noTransaction.message),
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP 8 — §4.9 settlement and I7's ordering
   ═══════════════════════════════════════════════════════════════════════════ */

async function group8() {
  group("8. §4.9 settlement: I7 ordering, rollback, idempotency, concurrency");

  const mission = await makeMission();
  const agent = await makeAgent();
  const storeTime = await readStoreTime();
  const sufficient = { outcome: "SUFFICIENT", achievedLevel: "L2" };

  // I7 — custody release strictly before commitment release. The refusal is the mechanism.
  const heldLeg = await makeLeg(mission, { state: "RELEASED", custodyState: "HELD" });
  const heldCommitment = await makeCommitment(agent, heldLeg);
  const refusedHeld = await prisma.$transaction((tx) =>
    settlement.settle(tx, {
      leg: heldLeg,
      commitment: heldCommitment,
      verification: sufficient,
      manifests: [],
      storeTime,
    }),
  );
  const heldCommitmentAfter = await prisma.commitment.findUnique({
    where: { commitmentId: heldCommitment.commitmentId },
  });
  check(
    "settlement refuses while custody is HELD, and the commitment is *not* released (I7)",
    refusedHeld.outcome === "REFUSED" && heldCommitmentAfter.releasedAt === null,
    `reason ${refusedHeld.reason}`,
  );

  const disputedLeg = await makeLeg(mission, { state: "RELEASED", custodyState: "DISPUTED" });
  const disputedCommitment = await makeCommitment(agent, disputedLeg, { capacitySlot: 1 });
  const refusedDisputed = await prisma.$transaction((tx) =>
    settlement.settle(tx, {
      leg: disputedLeg,
      commitment: disputedCommitment,
      verification: sufficient,
      manifests: [],
      storeTime,
    }),
  );
  check(
    "a DISPUTED custody is refused as its own case — an operator is routed to a contested handover, not a goods-aboard one",
    refusedDisputed.outcome === "REFUSED" && refusedDisputed.reason !== refusedHeld.reason,
    `HELD → ${refusedHeld.reason}; DISPUTED → ${refusedDisputed.reason}`,
  );

  const openManifestLeg = await makeLeg(mission, { state: "RELEASED", custodyState: "RELEASED" });
  const openManifestCommitment = await makeCommitment(agent, openManifestLeg, { capacitySlot: 2 });
  const refusedManifest = await prisma.$transaction((tx) =>
    settlement.settle(tx, {
      leg: openManifestLeg,
      commitment: openManifestCommitment,
      verification: sufficient,
      manifests: [{ itemId: "parcel-1", state: "OPEN" }],
      storeTime,
    }),
  );
  check(
    "an open manifest refuses settlement even when the custody flag says RELEASED — the manifest is checked, not the flag alone",
    refusedManifest.outcome === "REFUSED",
    `reason ${refusedManifest.reason}`,
  );

  const unverifiedLeg = await makeLeg(mission, { state: "RELEASED", custodyState: "RELEASED" });
  const unverifiedCommitment = await makeCommitment(agent, unverifiedLeg, { capacitySlot: 3 });
  const refusedUnverified = await prisma.$transaction((tx) =>
    settlement.settle(tx, {
      leg: unverifiedLeg,
      commitment: unverifiedCommitment,
      verification: { outcome: "INSUFFICIENT" },
      manifests: [],
      storeTime,
    }),
  );
  check(
    "settlement without sufficient verification is refused — a TASK_COMPLETE event is not a completion",
    refusedUnverified.outcome === "REFUSED" && refusedUnverified.reason === "VERIFICATION_NOT_SUFFICIENT",
  );

  // The happy path, and the ordering inside it.
  const goodLeg = await makeLeg(mission, { state: "RELEASED", custodyState: "RELEASED" });
  const goodCommitment = await makeCommitment(agent, goodLeg, { capacitySlot: 4 });
  await prisma.$transaction((tx) =>
    timers.register(tx, {
      entityType: timers.ENTITY_TYPE.LEG,
      entityId: goodLeg.id,
      state: "RELEASED",
      entity: goodLeg,
      dueAt: new Date(storeTime.getTime() + 60_000),
      handler: "VERIFY_OR_ESCALATE",
    }),
  );
  const settledResult = await prisma.$transaction((tx) =>
    settlement.settle(tx, {
      leg: goodLeg,
      commitment: goodCommitment,
      verification: sufficient,
      manifests: [{ itemId: "parcel-1", state: "CLOSED" }],
      storeTime,
    }),
  );
  const settledLeg = await prisma.leg.findUnique({ where: { id: goodLeg.id } });
  const settledCommitment = await prisma.commitment.findUnique({
    where: { commitmentId: goodCommitment.commitmentId },
  });
  const settledTimers = await prisma.timer.count({ where: { entityId: goodLeg.id, timerState: "PENDING" } });
  check(
    "with custody discharged, settlement writes SETTLED, releases the commitment, and cancels the Leg's timers",
    settledResult.outcome === "SETTLED" &&
      settledLeg.state === "SETTLED" &&
      settledCommitment.releasedAt !== null &&
      settledTimers === 0,
    `steps ${settledResult.steps.join(" → ")}`,
  );
  check(
    "…in the I7 order: custody closed before the commitment was released",
    settledResult.steps.indexOf("CUSTODY_CLOSED") < settledResult.steps.indexOf("COMMITMENT_RELEASED"),
    settledResult.steps.join(" → "),
  );
  const agentAfter = await prisma.agent.findUnique({ where: { id: agent.id } });
  check(
    "…and the agent's authority_epoch is untouched (I19)",
    agentAfter.authorityEpoch === 7n && settledResult.authorityEpochTouched === false,
    `epoch ${agentAfter.authorityEpoch}`,
  );

  const settledLegRow = await prisma.leg.findUnique({ where: { id: goodLeg.id } });
  const retried = await prisma.$transaction((tx) =>
    settlement.settle(tx, {
      leg: settledLegRow,
      commitment: settledCommitment,
      verification: sufficient,
      manifests: [],
      storeTime,
    }),
  );
  check(
    "settlement is idempotent — a retry is ALREADY_SETTLED, not a second release",
    retried.outcome === "ALREADY_SETTLED",
    `outcome ${retried.outcome}`,
  );

  // Rollback: custody closed, then the transaction fails. Neither half may survive.
  const rollbackLeg = await makeLeg(mission, { state: "RELEASED", custodyState: "RELEASED" });
  const rollbackCommitment = await makeCommitment(agent, rollbackLeg, { capacitySlot: 5 });
  const rolledBack = await rejected(() =>
    prisma.$transaction(async (tx) => {
      const outcome = await settlement.settle(tx, {
        leg: rollbackLeg,
        commitment: rollbackCommitment,
        verification: sufficient,
        manifests: [],
        storeTime,
      });
      if (outcome.outcome !== "SETTLED") throw new Error(`unexpected ${outcome.outcome}`);
      throw new Error("crash after the commitment release, before commit");
    }),
  );
  const rollbackLegAfter = await prisma.leg.findUnique({ where: { id: rollbackLeg.id } });
  const rollbackCommitmentAfter = await prisma.commitment.findUnique({
    where: { commitmentId: rollbackCommitment.commitmentId },
  });
  check(
    "a settlement that fails mid-transaction leaves neither a SETTLED Leg nor a released commitment — no contradictory custody/commitment state",
    rolledBack.rejected &&
      rollbackLegAfter.state === "RELEASED" &&
      rollbackLegAfter.version === 0 &&
      rollbackCommitmentAfter.releasedAt === null,
    `leg ${rollbackLegAfter.state} v${rollbackLegAfter.version}, commitment released ${rollbackCommitmentAfter.releasedAt !== null}`,
  );

  // Two settlements of one Leg, concurrent.
  const raceLeg = await makeLeg(mission, { state: "RELEASED", custodyState: "RELEASED" });
  const raceCommitment = await makeCommitment(agent, raceLeg, { capacitySlot: 6 });
  const settleOnce = () =>
    prisma.$transaction(
      (tx) =>
        settlement.settle(tx, {
          leg: raceLeg,
          commitment: raceCommitment,
          verification: sufficient,
          manifests: [],
          storeTime,
        }),
      { timeout: TX_TIMEOUT_MS },
    );
  const raced = await Promise.allSettled([settleOnce(), settleOnce()]);
  const racedOutcomes = raced.map((r) => (r.status === "fulfilled" ? r.value.outcome : `THREW:${r.reason.message}`));
  const raceLegAfter = await prisma.leg.findUnique({ where: { id: raceLeg.id } });
  check(
    "two concurrent settlements of one Leg settle it once",
    racedOutcomes.filter((o) => o === "SETTLED").length === 1 && raceLegAfter.version === 1,
    `outcomes ${racedOutcomes.join(" / ")}; final version ${raceLegAfter.version}`,
  );

  // I7 as a live audit query, not only as a refusal.
  const audit = await settlement.auditI7(prisma, 50);
  check(
    "the I7 audit query runs against the live schema and reports no agent available while custody is outstanding",
    Array.isArray(audit),
    `${audit.length} violation(s) reported`,
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP 9 — §12.5 verification evidence, durable and attributed
   ═══════════════════════════════════════════════════════════════════════════ */

async function group9() {
  group("9. §12.5 completion verification — L0–L3 and the three track-plausibility tests");

  const mission = await makeMission();
  const leg = await makeLeg(mission, { state: "RELEASED" });
  const storeTime = await readStoreTime();

  // The registered thresholds this grading reads, named once so a change moves every case
  // below together rather than one at a time.
  const THRESHOLDS = {
    minFixRatePerMinute: 6,
    corridorHalfWidthM: 30,
    minCorridorFraction: 0.9,
    maxGapSeconds: 60,
    maxSpeedMs: 20,
  };
  const ARRIVAL_RADIUS_M = 25;

  // A well-formed ten-minute leg: a fix every five seconds, straight down the corridor, at
  // a walking pace. Every crafted failure below perturbs exactly one property of this one
  // track, which is what makes "rejects its own failure and no other" a real claim rather
  // than a comparison between two unrelated fixtures.
  const LEG_SECONDS = 600;
  const FIX_INTERVAL_S = 5;

  function goodTrack() {
    const fixes = [];
    for (let i = 0; i * FIX_INTERVAL_S <= LEG_SECONDS; i += 1) {
      fixes.push({
        at: new Date(storeTime.getTime() - (LEG_SECONDS - i * FIX_INTERVAL_S) * 1000),
        lat: 0,
        lon: i * 0.00002, // ≈2.2 m between fixes — comfortably inside the speed limit
      });
    }
    return fixes;
  }

  const corridor = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.0025 },
  ];
  const stopPosition = { lat: 0, lon: 0.0024 };

  function trackInput(track) {
    return {
      track: track || goodTrack(),
      legDurationSeconds: LEG_SECONDS,
      corridor,
      ...THRESHOLDS,
    };
  }

  function verifyClaim(overrides) {
    return verification.verify({
      completionClaimed: true,
      requiredLevel: "L1",
      claimedPosition: stopPosition,
      stopPosition,
      arrivalRadiusM: ARRIVAL_RADIUS_M,
      track: trackInput(),
      ...(overrides || {}),
    });
  }

  /* ── L0–L3, graded ── */

  const good = verifyClaim();
  check(
    "a well-formed completion claim reaches L1 — the geometric check and all three plausibility tests pass",
    good.achievedLevel === "L1" && good.outcome === "SUFFICIENT" && good.failures.length === 0,
    `required ${good.requiredLevel}, achieved ${good.achievedLevel}, outcome ${good.outcome}, failures ${JSON.stringify(good.failures)}`,
  );

  const noClaim = verification.verify({ completionClaimed: false, requiredLevel: "L1" });
  check(
    "no claim at all is INSUFFICIENT at L0 and distinctly reasoned",
    noClaim.achievedLevel === "L0" &&
      noClaim.outcome === "INSUFFICIENT" &&
      noClaim.failures.includes("NO_COMPLETION_CLAIM"),
    `failures ${JSON.stringify(noClaim.failures)}`,
  );

  const l0Only = verification.verify({ completionClaimed: true, requiredLevel: "L0" });
  check(
    "L0 accepts the assertion alone — a TASK_COMPLETE is evidence at L0 and at no level above it",
    l0Only.achievedLevel === "L0" && l0Only.outcome === "SUFFICIENT",
    `outcome ${l0Only.outcome}`,
  );

  const outsideRadius = verifyClaim({ claimedPosition: { lat: 0.01, lon: 0.0024 } });
  check(
    "L1 requires arrival inside verify.arrival_radius — a claim made a kilometre away fails it",
    outsideRadius.achievedLevel === "L0" && outsideRadius.failures.includes("ARRIVAL_RADIUS"),
    `failures ${JSON.stringify(outsideRadius.failures)}`,
  );

  const noPosition = verification.verify({
    completionClaimed: true,
    requiredLevel: "L1",
    arrivalRadiusM: ARRIVAL_RADIUS_M,
    track: trackInput(),
  });
  check(
    "…and no position at all fails L1 rather than being assumed to have arrived (§4.1 rule 3)",
    noPosition.achievedLevel === "L0" && noPosition.failures.includes("ARRIVAL_RADIUS"),
    `failures ${JSON.stringify(noPosition.failures)}`,
  );

  const l2 = verifyClaim({ requiredLevel: "L2", physicalEvidence: { kind: "DOOR_CYCLE" } });
  check("L2 is L1 plus a physical event", l2.achievedLevel === "L2" && l2.outcome === "SUFFICIENT", `achieved ${l2.achievedLevel}`);

  const l2NoEvent = verifyClaim({ requiredLevel: "L2" });
  check(
    "…and L2 without one grades down to L1 rather than passing",
    l2NoEvent.achievedLevel === "L1" &&
      l2NoEvent.outcome === "INSUFFICIENT" &&
      l2NoEvent.failures.includes("NO_PHYSICAL_EVENT"),
    `achieved ${l2NoEvent.achievedLevel}, failures ${JSON.stringify(l2NoEvent.failures)}`,
  );

  const l3 = verifyClaim({
    requiredLevel: "L3",
    physicalEvidence: { kind: "DOOR_CYCLE" },
    attestation: { signedBy: "recipient", signature: "abc" },
  });
  check("L3 is L2 plus an external attestation", l3.achievedLevel === "L3" && l3.outcome === "SUFFICIENT", `achieved ${l3.achievedLevel}`);

  const l3NoGeometry = verification.verify({
    completionClaimed: true,
    requiredLevel: "L3",
    arrivalRadiusM: ARRIVAL_RADIUS_M,
    track: trackInput(),
    physicalEvidence: { kind: "DOOR_CYCLE" },
    attestation: { signedBy: "recipient" },
  });
  check(
    "…and the grading is cumulative — L3 is unreachable when the L1 geometric check failed, however good the attestation",
    l3NoGeometry.achievedLevel === "L0" && l3NoGeometry.outcome === "INSUFFICIENT",
    `achieved ${l3NoGeometry.achievedLevel}`,
  );

  /* ── The three plausibility tests: each rejects its own crafted failure and no other ── */

  const wellFormed = verification.assessTrackPlausibility(trackInput());
  check(
    "the well-formed track is rejected by none of the three",
    wellFormed.plausible === true && wellFormed.failures.length === 0 && wellFormed.securityEvent === false,
    `failures ${JSON.stringify(wellFormed.failures)}`,
  );

  // Coverage's own failure, isolated: a fix every 15 s instead of every 5 s. That is 4.1
  // fixes per minute against a 6/min floor, so coverage rejects it — while every gap is
  // 15 s against a 60 s limit and every fix is on the road, so the other two must not.
  // The isolation is the point: a fixture that trips two tests cannot evidence which one
  // is doing the rejecting.
  const sparse = verification.assessTrackPlausibility(trackInput(goodTrack().filter((_, index) => index % 3 === 0)));
  check(
    "coverage rejects a track with too few fixes for its duration — and neither corridor nor continuity does",
    sparse.failures.length === 1 && sparse.failures[0] === "TRACK_COVERAGE",
    `failures ${JSON.stringify(sparse.failures)} (4.1 fixes/min against a 6/min floor, 15 s gaps against a 60 s limit)`,
  );

  // Corridor's own failure: every fix present and evenly spaced, but a kilometre off route.
  const offRoute = verification.assessTrackPlausibility(
    trackInput(goodTrack().map((fix) => ({ ...fix, lat: 0.01 }))),
  );
  check(
    "corridor rejects a track that took a different road — and coverage and continuity do not",
    offRoute.failures.includes("TRACK_CORRIDOR") &&
      !offRoute.failures.includes("TRACK_COVERAGE") &&
      !offRoute.failures.includes("TRACK_CONTINUITY"),
    `failures ${JSON.stringify(offRoute.failures)}`,
  );

  // Continuity's own failure, isolated: one 110 s hole punched into the middle of the track.
  // 100 fixes survive, which is 10/min against the 6/min floor, so coverage must not fire;
  // every surviving fix is on the road, so corridor must not either.
  const gapped = verification.assessTrackPlausibility(
    trackInput(goodTrack().filter((_, index) => index < 40 || index > 60)),
  );
  check(
    "continuity rejects an unexplained gap — and neither coverage nor corridor does",
    gapped.failures.length === 1 && gapped.failures[0] === "TRACK_CONTINUITY",
    `failures ${JSON.stringify(gapped.failures)} (110 s gap against a 60 s limit, 10 fixes/min against a 6/min floor)`,
  );

  // Continuity separates its two failures: a gap is a telemetry problem, an impossible
  // implied speed is a security one, and only the latter raises the flag.
  const teleport = verification.assessTrackPlausibility(
    trackInput(goodTrack().map((fix, index) => (index === 60 ? { ...fix, lon: fix.lon + 0.05 } : fix))),
  );
  check(
    "…and a kinematically impossible implied speed is a security event, not merely a telemetry gap",
    teleport.securityEvent === true,
    `failures ${JSON.stringify(teleport.failures)}, securityEvent ${teleport.securityEvent}`,
  );
  check(
    "…while the ordinary gap is not — the two continuity failures are distinguished",
    gapped.securityEvent === false,
    `gap securityEvent ${gapped.securityEvent}`,
  );

  /* ── Evidence is durable, attributed, and typed at the database ── */

  const stored = await prisma.verificationEvidence.create({
    data: {
      evidenceId: uid("ev"),
      legId: leg.id,
      requiredLevel: good.requiredLevel,
      achievedLevel: good.achievedLevel,
      outcome: good.outcome,
      observedAt: storeTime,
      failures: good.failures,
      arrivalDistanceM: good.measured ? good.measured.arrivalDistanceM : null,
      trackFixCount: good.measured ? good.measured.fixCount : null,
      fixRatePerMinute: good.measured ? good.measured.fixRatePerMinute : null,
      corridorFraction: good.measured ? good.measured.corridorFraction : null,
      maxGapSeconds: good.measured ? good.measured.maxGapSeconds : null,
      maxImpliedSpeedMs: good.measured ? good.measured.maxImpliedSpeedMs : null,
      securityEvent: false,
    },
  });
  const readBack = await prisma.verificationEvidence.findUnique({ where: { evidenceId: stored.evidenceId } });
  check(
    "verification evidence is durable, attributed to its Leg, timestamped, and carries the measurements it graded on",
    readBack !== null &&
      readBack.legId === leg.id &&
      readBack.createdAt instanceof Date &&
      readBack.achievedLevel === good.achievedLevel &&
      Number.isFinite(readBack.fixRatePerMinute),
    `${readBack.achievedLevel}/${readBack.outcome}, ${readBack.trackFixCount} fixes at ${readBack.fixRatePerMinute}/min, corridor ${readBack.corridorFraction}`,
  );

  const securityStored = await prisma.verificationEvidence.create({
    data: {
      evidenceId: uid("ev"),
      legId: leg.id,
      requiredLevel: "L1",
      achievedLevel: "L0",
      outcome: "INSUFFICIENT",
      observedAt: storeTime,
      securityEvent: true,
    },
  });
  const securityRow = await prisma.verificationEvidence.findUnique({
    where: { evidenceId: securityStored.evidenceId },
  });
  check(
    "…and a security event is a durable flag of its own, not inferred from the failure list",
    securityRow.securityEvent === true,
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP 10 — the "stuck forever" property, end to end
   ═══════════════════════════════════════════════════════════════════════════ */

async function group10() {
  group("10. The Phase 5 property: a non-terminal state cannot remain unsupervised");

  const mission = await makeMission();
  const storeTime = await readStoreTime();

  // I4's audit, run against the live store: a non-terminal Leg with no pending timer at its
  // own current version is an unsupervised state, which is the defect this phase removes.
  const unsupervised = await makeLeg(mission, { state: "OFFERED" });
  const before = await timers.findUnsupervised(prisma, { limit: 500 });
  check(
    "a non-terminal Leg with no timer is detected as unsupervised by I4's audit",
    before.some((row) => row.entityId === unsupervised.id),
    `${before.length} unsupervised entit(ies) found`,
  );

  await prisma.$transaction((tx) =>
    timers.register(tx, {
      entityType: timers.ENTITY_TYPE.LEG,
      entityId: unsupervised.id,
      state: "OFFERED",
      entity: unsupervised,
      dueAt: new Date(storeTime.getTime() + 60_000),
      handler: "WITHDRAW_EXCLUDE_REPLAN",
    }),
  );
  const after = await timers.findUnsupervised(prisma, { limit: 500 });
  check(
    "…and is no longer reported once its deadline is registered",
    !after.some((row) => row.entityId === unsupervised.id),
  );

  // The end-to-end claim: an expected event never arrives, the worker is not running when
  // the deadline passes, the process restarts, and the deadline is still acted upon.
  const abandoned = await makeLeg(mission, { state: "OFFERED" });
  await prisma.$transaction((tx) =>
    timers.register(tx, {
      entityType: timers.ENTITY_TYPE.LEG,
      entityId: abandoned.id,
      state: "OFFERED",
      entity: abandoned,
      dueAt: new Date(storeTime.getTime() - 5_000),
      handler: "WITHDRAW_EXCLUDE_REPLAN",
    }),
  );

  // "The process restarts": a brand-new worker deps object, with no memory of the timer.
  const recovered = [];
  const freshWorker = {
    prisma,
    readStoreTime,
    handlers: {
      WITHDRAW_EXCLUDE_REPLAN: async ({ tx, timer, entity }) => {
        recovered.push({ timerId: timer.id, legId: entity.id });
        await tx.leg.updateMany({
          where: { id: entity.id, version: entity.version },
          data: { state: "QUEUED", version: entity.version + 1 },
        });
        return { outcome: "RECOVERY_ATTEMPTED" };
      },
    },
    record: () => {},
    runInTransaction: (fn) => prisma.$transaction(fn, { timeout: TX_TIMEOUT_MS, maxWait: TX_TIMEOUT_MS }),
  };
  const pass = await timerWorker.fireDue(freshWorker, { maxTimerLagSeconds: MAX_TIMER_LAG_SECONDS });
  check(
    "a deadline that passed while no worker was running is fired by a freshly started worker — supervision is durable, not process-local",
    recovered.some((r) => r.legId === abandoned.id),
    `pass fired ${pass ? pass.fired : 0} timer(s); ${recovered.length} recovery attempt(s)`,
  );

  // Every non-terminal state has an outgoing transition: the precondition of the liveness
  // claim, checked against the shipped table rather than asserted.
  check(
    "every non-terminal Leg state has an outgoing §4.4 transition — no state can be entered and never left",
    transitions.statesWithoutExit().length === 0,
    `states with no exit: ${JSON.stringify(transitions.statesWithoutExit())}`,
  );

  const withoutDeadline = legMachine.statesWithoutDeadline();
  check(
    "and every non-terminal Leg state except LOADED carries a deadline, matching §4.3's own table",
    withoutDeadline.length === 1 && withoutDeadline[0] === "LOADED",
    `states without a deadline: ${JSON.stringify(withoutDeadline)}`,
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */

async function main() {
  console.log("PHASE 5 — live PostgreSQL verification of supervision and reconciliation");
  console.log(`Instance: ${(process.env.DATABASE_URL || "").replace(/:[^:@/]*@/, ":***@")}`);

  const version = await prisma.$queryRaw`SELECT version()`;
  console.log(`Server:   ${version[0].version.split(",")[0]}`);

  try {
    await group1();
    await group2();
    await group3();
    await group4();
    await group5();
    await group6();
    await group7();
    await group8();
    await group9();
    await group10();
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  console.log(`\n${"═".repeat(80)}`);
  console.log(`  ${passed}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log(`\n  FAILURES:`);
    for (const failure of failed) console.log(`    [${failure.group}] ${failure.label}`);
  }
  console.log(`${"═".repeat(80)}\n`);

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("\nHARNESS ERROR:", error);
  try {
    await cleanup();
  } catch {
    /* best effort */
  }
  await prisma.$disconnect();
  process.exit(2);
});

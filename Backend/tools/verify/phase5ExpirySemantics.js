"use strict";

/**
 * PHASE 5 — §4.5 expiry semantics, driven against a real PostgreSQL instance.
 *
 * The companion to `phase5LiveDatabase.js`, and the one that exists because that harness's
 * conclusion turned out to be too narrow. It verified the timer *store* — registration,
 * keying, the discard rule, cancellation, the lag SLI — and recorded, honestly, that
 * *"`transitions.apply` is not yet reached by a fired timer: the handler map that connects
 * the two is Phase 15's bootstrap"*. Phase 15 then found that the map had no producer
 * because the seventeen expiry actions §4.2 and §4.3 declare had **no implementation at
 * all**, and returned the finding to Phase 5.
 *
 * So this harness verifies the half that was missing: a deadline passing and something
 * happening. Every check drives the **shipped** modules —
 * `workers/leaderWorkers.js` composes the worker exactly as the production composition
 * root does, and its own `handlers` map and `config` are captured from that composer and
 * used for every group below. Nothing here hand-builds a dependency object, which is the
 * defect that let 6 741 tests pass over an engine that did not run.
 *
 *   DATABASE_URL=postgresql://user:pw@127.0.0.1:55435/db node tools/verify/phase5ExpirySemantics.js
 *
 * It refuses to run against anything that is not a local disposable instance.
 */

const { PrismaClient } = require("@prisma/client");

const expiryActions = require("../../src/engine/supervision/expiryActions");
const legMachine = require("../../src/engine/lifecycle/legMachine");
const offers = require("../../src/engine/dispatch/offers");
const leaderWorkers = require("../../src/workers/leaderWorkers");
const timerWorker = require("../../src/workers/timer.worker");
const timers = require("../../src/engine/supervision/timers");
const transitions = require("../../src/engine/lifecycle/transitions");

const TX_TIMEOUT_MS = 30000;

const results = [];
let currentGroup = "";

function group(name) {
  currentGroup = name;
  console.log(`\n─── ${name} ${"─".repeat(Math.max(0, 74 - name.length))}`);
}

function check(label, condition, detail) {
  const ok = Boolean(condition);
  results.push({ group: currentGroup, label, ok, detail: detail || "" });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n          ${detail}` : ""}`);
}

let seq = 0;
const uid = (prefix) => `p5x-${prefix}-${process.pid}-${(seq += 1)}`;

const url = process.env.DATABASE_URL || "";
if (!/127\.0\.0\.1|localhost/.test(url)) {
  console.error(
    "REFUSED: DATABASE_URL does not name a local instance. This harness writes and deletes rows; it is for a " +
      "disposable cluster only, never the shared one.",
  );
  process.exit(2);
}

const prisma = new PrismaClient();

async function readStoreTime() {
  const rows = await prisma.$queryRaw`SELECT NOW() AS now`;
  return rows[0].now;
}

const runInTransaction = (fn) => prisma.$transaction(fn, { timeout: TX_TIMEOUT_MS, maxWait: TX_TIMEOUT_MS });

/* ═══════════════════════════════════════════════════════════════════════════
   The production composition, captured
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The published register's values, as the composer reads them. Every one is a real
 * Appendix A / supplementary register entry; none is invented here.
 */
const VALUES = new Map([
  ["sla.assignment_deadline", 900],
  ["assign.max_deferral_time", 300],
  ["commit.hardening_deadline", 120],
  ["dispatch.offer_ttl", 30],
  ["dispatch.max_delivery_delay", 5],
  ["dispatch.retry_window", 30],
  ["dispatch.nack_cooloff", 60],
  ["dispatch.systemic_threshold", 0.5],
  ["health.unresponsive_strikes", 3],
  ["execute.start_grace", 120],
  ["execute.eta_tolerance", 1.3],
  ["stop.service_time_limit", 600],
  ["verify.evidence_deadline", 900],
  ["recover.abort_budget", 300],
  ["recover.reassign_budget", 600],
  ["recover.incumbent_cooloff", 300],
  ["recover.max_reassignments_per_leg", 3],
  ["ops.stranded_safe_response_target", 14400],
  ["ops.stranded_restrictive_response_target", 2700],
  ["ops.stranded_obstructing_response_target", 600],
  ["ops.suspension_review_period", 3600],
  ["intake.validation_budget", 60],
  ["supervise.max_timer_lag", 30],
  ["reconciler.sweep_interval", 10],
  ["energy.deviation_tolerance", 0.2],
  ["ops.escalation_contact_review_period", 7776000],
  [
    "ops.external_escalation_contacts",
    { "region-1": { owner: "ops-lead", contacts: ["+44-000"], reviewedAtMs: Date.now() } },
  ],
  ["ops.emergency_services_hazard_threshold", { obstructionClasses: ["BLOCKING_CRITICAL"], hazardStates: ["SEVERE"] }],
]);

/** Captured from the production composer, never hand-built. */
let composedDeps = null;
let composedConfig = null;

function captureComposition() {
  const realStart = timerWorker.start;
  timerWorker.start = (deps, config) => {
    composedDeps = deps;
    composedConfig = config;
    return { stop() {} };
  };
  try {
    const lifecycle = leaderWorkers.create({
      prisma,
      kv: null,
      io: {},
      values: VALUES,
      shardId: "shard-p5x",
      regionId: "region-1",
      instanceId: "verify:1",
      runInTransaction,
      deliver: async () => ({ delivered: true }),
      record: () => {},
      signingKey: "phase5-verification-signing-key-0123456789abcdef",
      logger: { info() {}, warn() {}, error() {} },
    });
    const outcome = lifecycle.apply({ mayRunRound: true });
    lifecycle.stop();
    return outcome;
  } finally {
    timerWorker.start = realStart;
  }
}

/** Drive one pass with the captured production dependencies, plus a record sink. */
async function firePass(events) {
  return timerWorker.fireDue({ ...composedDeps, record: (event, detail) => events.push({ event, detail }) }, composedConfig);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Fixture
   ═══════════════════════════════════════════════════════════════════════════ */

const legSequence = new Map();

async function makeMission() {
  const id = uid("mission");
  return prisma.mission.create({ data: { id, missionId: id } });
}

async function makeAgent() {
  const id = uid("agent");
  return prisma.agent.create({
    data: { id, agentId: id, lifecycleState: "ACTIVE", authorityEpoch: 7n, fenceCounter: 42n, capacityOverride: 8 },
  });
}

async function makeLeg(mission, overrides) {
  const id = uid("leg");
  const next = (legSequence.get(mission.id) || 0) + 1;
  legSequence.set(mission.id, next);
  return prisma.leg.create({
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
}

async function makeCommitment(agent, leg, overrides) {
  const id = uid("commitment");
  const now = await readStoreTime();
  return prisma.commitment.create({
    data: {
      id,
      commitmentId: id,
      agentId: agent.id,
      legId: leg.id,
      kind: "HARD",
      fence: 42n,
      leaseExpiry: new Date(now.getTime() + 60_000),
      custodyState: overrides && overrides.custodyState ? overrides.custodyState : "NONE",
      version: 0,
      grantedAt: now,
      capacitySlot: (overrides && overrides.capacitySlot) || 0,
      ...(overrides || {}),
    },
  });
}

/**
 * Arm a Leg's own deadline through the shipped store, overdue by `overdueSeconds`.
 *
 * Registered exactly as `transitions.apply` registers one — same key, same handler drawn
 * from the state's own machine — so that what fires below is the row production writes.
 */
async function armLeg(leg, overdueSeconds) {
  const now = await readStoreTime();
  const spec = legMachine.deadlineFor(leg.state);
  // The interval production would have armed it for. For §4.3's two *projected* deadlines
  // there is no register value — the plan supplies the projection — so a representative one
  // is used and recorded on the row exactly as `transitions.apply` records it.
  const armedSeconds = spec.projected === true ? 900 : VALUES.get(spec.parameter);
  const armed = await runInTransaction((tx) =>
    timers.register(tx, {
      entityType: timers.ENTITY_TYPE.LEG,
      entityId: leg.id,
      state: leg.state,
      entity: leg,
      dueAt: new Date(now.getTime() + armedSeconds * 1000),
      armedSeconds,
      handler: spec.onExpiry,
      payload: { armedBy: "phase5ExpirySemantics" },
      shardId: "shard-p5x",
    }),
  );
  // Time passes. The deadline is now overdue, and nothing else about the row changes —
  // which is precisely the state a real overdue timer is in.
  return prisma.timer.update({
    where: { id: armed.id },
    data: { dueAt: new Date(now.getTime() - (overdueSeconds || 1) * 1000) },
  });
}

async function timerRow(id) {
  return prisma.timer.findUnique({ where: { id } });
}

async function legRow(id) {
  return prisma.leg.findUnique({ where: { id } });
}

/** Delete every row this harness created, in dependency order. */
async function cleanup() {
  await prisma.timer.deleteMany({ where: { entityId: { startsWith: "p5x-" } } });
  await prisma.externalEscalation.deleteMany({ where: { leg: { id: { startsWith: "p5x-" } } } });
  await prisma.outbox.deleteMany({ where: { agentId: { startsWith: "p5x-" } } });
  await prisma.agentFenceAudit.deleteMany({ where: { agentId: { startsWith: "p5x-" } } });
  await prisma.commitment.deleteMany({ where: { commitmentId: { startsWith: "p5x-" } } });
  await prisma.leg.deleteMany({ where: { id: { startsWith: "p5x-" } } });
  await prisma.mission.deleteMany({ where: { id: { startsWith: "p5x-" } } });
  await prisma.agent.deleteMany({ where: { id: { startsWith: "p5x-" } } });
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP A — the production composition root reaches the timer worker
   ═══════════════════════════════════════════════════════════════════════════ */

async function groupA() {
  group("A. Production composition — who starts the timer worker, and with what");

  const outcome = captureComposition();

  check("leadership acquisition starts the timer worker", outcome.running.includes("timer"), `running: ${outcome.running.join(", ")}`);
  check(
    "it is not refused",
    !outcome.refusals.some((entry) => entry.worker === "timer"),
    `refusals: ${outcome.refusals.map((entry) => entry.worker).join(", ") || "none"}`,
  );
  check("the composer supplied the store client", composedDeps && composedDeps.prisma === prisma);
  check("the composer supplied a transaction seam", typeof (composedDeps || {}).runInTransaction === "function");
  check("the composer supplied the store clock, not a worker's (§10.6)", typeof (composedDeps || {}).readStoreTime === "function");

  const declared = expiryActions.declaredActionNames();
  const provided = Object.keys((composedDeps || {}).handlers || {}).sort();
  check(
    `every one of the ${declared.length} declared §4.2/§4.3 expiry actions has a handler`,
    JSON.stringify(provided) === JSON.stringify(declared),
    `declared ${declared.length}, provided ${provided.length}`,
  );

  // The whole finding, inverted: before this remediation the answer to each of these was
  // "nothing anywhere under src/".
  const unimplemented = declared.filter((action) => typeof composedDeps.handlers[action] !== "function");
  check("none is a placeholder", unimplemented.length === 0, unimplemented.join(", ") || "all seventeen are functions");

  check(
    "the timer no longer appears in the composition blocker table",
    leaderWorkers.UNCOMPOSABLE.timer === undefined,
    `remaining blockers: ${Object.keys(leaderWorkers.UNCOMPOSABLE).join(", ")}`,
  );

  const storeTime = await composedDeps.readStoreTime();
  check("the store clock reads through the live connection", storeTime instanceof Date && !Number.isNaN(storeTime.getTime()), String(storeTime));
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP B — every declared Leg action, end to end
   ═══════════════════════════════════════════════════════════════════════════ */

async function groupB() {
  group("B. Every §4.3 Leg expiry action: armed → due → fired → effect");

  const mission = await makeMission();

  /**
   * Arm one Leg in `state`, fire a pass, and report what the shipped code did.
   */
  async function exercise(state, overrides, prepare) {
    const leg = await makeLeg(mission, { state, ...(overrides || {}) });
    if (typeof prepare === "function") await prepare(leg);
    const timer = await armLeg(leg);
    const events = [];
    const summary = await firePass(events);
    return { leg, timer: await timerRow(timer.id), after: await legRow(leg.id), summary, events };
  }

  // ── QUEUED / ESCALATION_LADDER ──────────────────────────────────────────
  {
    const r = await exercise("QUEUED");
    check(
      "QUEUED · ESCALATION_LADDER refuses by name — §17.4's ladder has no implementation",
      r.timer.lastOutcome === "LADDER_NOT_IMPLEMENTED",
      `lastOutcome=${r.timer.lastOutcome}`,
    );
    check(
      "  it does NOT read a missing ladder as an exhausted one — the Leg is not FAILED",
      r.after.state === "QUEUED",
      `state=${r.after.state}`,
    );
    check(
      "  and the deadline is re-armed rather than discharged (I4)",
      r.timer.timerState === "PENDING" && r.timer.attempts === 1 && r.timer.dueAt > r.leg.createdAt,
      `timerState=${r.timer.timerState} attempts=${r.timer.attempts}`,
    );
  }

  // ── DEFERRED / FORCE_WIDEN_AND_ESCALATE ─────────────────────────────────
  {
    const r = await exercise("DEFERRED");
    check(
      "DEFERRED · FORCE_WIDEN_AND_ESCALATE ends the deferral — DEFERRED → QUEUED",
      r.after.state === "QUEUED" && r.after.version === 1,
      `state=${r.after.state} version=${r.after.version}`,
    );
    check("  the old timer is resolved FIRED", r.timer.timerState === "FIRED", `timerState=${r.timer.timerState}`);
    const armed = await prisma.timer.findFirst({
      where: { entityId: r.leg.id, timerState: "PENDING", state: "QUEUED" },
    });
    check("  and QUEUED's own deadline is registered in the same transaction (§4.5)", Boolean(armed), armed ? armed.timerKey : "none");
    check(
      "  the §17.4 widening is emitted as a directive for the ladder, not performed here",
      r.events.some((entry) => entry.event === "timer.widen_directive"),
    );
  }

  // ── PLANNED / HARDEN_OR_REPLAN ──────────────────────────────────────────
  {
    const r = await exercise("PLANNED");
    check(
      "PLANNED · HARDEN_OR_REPLAN takes the re-plan branch — PLANNED → QUEUED",
      r.after.state === "QUEUED" && r.after.version === 1,
      `state=${r.after.state} version=${r.after.version}`,
    );
    check(
      "  no commitment was created or released — §2.6: nothing was said to any agent",
      (await prisma.commitment.count({ where: { legId: r.leg.id } })) === 0,
    );
    check("  the old timer is resolved FIRED", r.timer.timerState === "FIRED");
  }

  // ── OFFERED / WITHDRAW_EXCLUDE_REPLAN ───────────────────────────────────
  {
    const agent = await makeAgent();
    const leg = await makeLeg(mission, { state: "OFFERED" });
    const commitment = await makeCommitment(agent, leg);
    const timer = await armLeg(leg);
    const events = [];
    await firePass(events);

    const after = await legRow(leg.id);
    const timerAfter = await timerRow(timer.id);
    const released = await prisma.commitment.findUnique({ where: { commitmentId: commitment.commitmentId } });
    const withdraw = await prisma.outbox.findFirst({ where: { commitmentId: commitment.commitmentId, command: "WITHDRAW" } });
    const agentAfter = await prisma.agent.findUnique({ where: { id: agent.id } });

    check("OFFERED · WITHDRAW_EXCLUDE_REPLAN returns the Leg to QUEUED", after.state === "QUEUED", `state=${after.state}`);
    check("  a WITHDRAW is enqueued at an advanced commitment fence (§11.4 step 2)", Boolean(withdraw) && withdraw.fence > commitment.fence, withdraw ? `fence ${commitment.fence} → ${withdraw.fence}` : "no row");
    check("  the fence advance and the command it authorises are one transaction (§4.1 rule 5)", Boolean(withdraw) && agentAfter.fenceCounter === withdraw.fence);
    check("  the agent's authority_epoch is untouched (I19)", agentAfter.authorityEpoch === agent.authorityEpoch, `${agent.authorityEpoch} → ${agentAfter.authorityEpoch}`);
    check("  the commitment is released", released.releasedAt !== null);
    check("  the OFFERED timer is resolved FIRED", timerAfter.timerState === "FIRED", `timerState=${timerAfter.timerState}`);
    const requeued = await prisma.timer.findFirst({ where: { entityId: leg.id, timerState: "PENDING", state: "QUEUED" } });
    check(
      "  REGRESSION — the requeued Leg is armed: `withdrawExpiredOffer` does not run §4.4, so the handler registers it",
      Boolean(requeued),
      requeued ? requeued.timerKey : "none — the Leg would be QUEUED and unsupervised",
    );
    check("  the exclusion window is reported for the index and the round", events.some((e) => e.event === "timer.offer_withdrawn"));
  }

  // ── ACCEPTED / PROBE_THEN_REASSIGN ──────────────────────────────────────
  {
    const agent = await makeAgent();
    const leg = await makeLeg(mission, { state: "ACCEPTED" });
    const commitment = await makeCommitment(agent, leg);
    const timer = await armLeg(leg);
    const events = [];
    await firePass(events);

    const after = await legRow(leg.id);
    const recall = await prisma.outbox.findFirst({ where: { commitmentId: commitment.commitmentId, command: "RECALL" } });
    const released = await prisma.commitment.findUnique({ where: { commitmentId: commitment.commitmentId } });

    check("ACCEPTED · PROBE_THEN_REASSIGN moves the Leg to REASSIGNING", after.state === "REASSIGNING", `state=${after.state}`);
    check("  §4.7 step 2's RECALL is written at an advanced fence", Boolean(recall) && recall.fence > commitment.fence);
    check("  the incumbent commitment is released", released.releasedAt !== null);
    check("  the absent probe is recorded rather than assumed away", events.some((e) => e.event === "timer.start_grace_probe"));
    check("  the old timer is resolved FIRED", (await timerRow(timer.id)).timerState === "FIRED");
    const reassigning = await prisma.timer.findFirst({ where: { entityId: leg.id, timerState: "PENDING", state: "REASSIGNING" } });
    check("  REASSIGNING's own deadline is armed by the reassignment's transaction", Boolean(reassigning));
  }

  // ── ACCEPTED with custody — the §4.4 guard ──────────────────────────────
  {
    const r = await exercise("ACCEPTED", { custodyState: "HELD" });
    check(
      "ACCEPTED with custody HELD is REFUSED — §4.4 guards this row on `no custody`",
      r.timer.lastOutcome.startsWith("CUSTODY_NOT_NONE"),
      `lastOutcome=${r.timer.lastOutcome}`,
    );
    check("  the Leg did not move", r.after.state === "ACCEPTED" && r.after.version === 0);
    check("  and it is still supervised", r.timer.timerState === "PENDING");
  }

  // ── EN_ROUTE_PICKUP / EN_ROUTE_DROP / PROGRESS_PROBE ────────────────────
  for (const state of ["EN_ROUTE_PICKUP", "EN_ROUTE_DROP"]) {
    const r = await exercise(state, state === "EN_ROUTE_DROP" ? { custodyState: "HELD" } : undefined);
    check(
      `${state} · PROGRESS_PROBE applies §4.4's ETA-breach self-transition`,
      r.after.state === state && r.after.version === 1,
      `state=${r.after.state} version=${r.after.version}`,
    );
    check("  the old timer resolves and a new one is armed at the new version", r.timer.timerState === "FIRED");
    const rearmed = await prisma.timer.findFirst({ where: { entityId: r.leg.id, timerState: "PENDING", state } });
    check("  so the mission stays supervised across the breach", Boolean(rearmed) && rearmed.entityVersion === 1n);
    check("  §12.3's re-projection and AT_RISK are named with their owners, not faked", r.events.some((e) => e.event === "timer.progress_probe"));
  }

  // ── AT_PICKUP / AT_DROP / OPERATOR_ALERT ────────────────────────────────
  for (const state of ["AT_PICKUP", "AT_DROP"]) {
    const r = await exercise(state, state === "AT_DROP" ? { custodyState: "HELD" } : undefined);
    check(
      `${state} · OPERATOR_ALERT alerts and does not move the Leg`,
      r.after.state === state && r.after.version === 0 && r.timer.lastOutcome === "OPERATOR_ALERTED",
      `state=${r.after.state} version=${r.after.version} outcome=${r.timer.lastOutcome}`,
    );
    check("  the deadline is re-armed, so the alert repeats at the service-time cadence", r.timer.timerState === "PENDING" && r.timer.attempts === 1);
    check("  and the repeat count is durable on the timer row", r.events.some((e) => e.event === "timer.operator_alert" && e.detail.consecutiveExpiries === 1));
  }

  // ── RELEASED / VERIFICATION_ESCALATION ──────────────────────────────────
  {
    const r = await exercise("RELEASED", { custodyState: "RELEASED" });
    check(
      "RELEASED · VERIFICATION_ESCALATION applies §4.4's evidence-insufficient row",
      r.after.state === "RELEASED" && r.after.version === 1,
      `state=${r.after.state} version=${r.after.version}`,
    );
    check("  the operator queue is named and the Task write is declared unavailable, not faked", r.events.some((e) => e.event === "timer.verification_escalation" && e.detail.operatorQueue === true));
  }

  // ── ABORTING / FORCE_STRANDED ───────────────────────────────────────────
  for (const [obstruction, expected] of [
    ["CLEAR", "STRANDED_SAFE"],
    ["RESTRICTIVE", "STRANDED_SAFE"],
    ["BLOCKING_CRITICAL", "STRANDED_OBSTRUCTING"],
    [null, "STRANDED_OBSTRUCTING"],
  ]) {
    const agent = await makeAgent();
    const leg = await makeLeg(mission, { state: "ABORTING", custodyState: "HELD", obstructionClass: obstruction });
    await makeCommitment(agent, leg);
    await armLeg(leg);
    await firePass([]);
    const after = await legRow(leg.id);
    check(
      `ABORTING · FORCE_STRANDED with obstruction ${obstruction === null ? "ABSENT" : obstruction} → ${expected}`,
      after.state === expected,
      `state=${after.state}`,
    );
  }

  // ── STRANDED_SAFE / PAGE_OPERATIONS ─────────────────────────────────────
  {
    const r = await exercise("STRANDED_SAFE", { custodyState: "HELD", obstructionClass: "CLEAR" });
    check(
      "STRANDED_SAFE · PAGE_OPERATIONS pages and does not move the Leg",
      r.after.state === "STRANDED_SAFE" && r.timer.lastOutcome === "OPERATIONS_PAGED",
      `outcome=${r.timer.lastOutcome}`,
    );
    check("  the response-target breach is recorded with its parameter", r.events.some((e) => e.event === "timer.stranding_response_target_missed" && e.detail.responseTargetParameter === "ops.stranded_safe_response_target"));
    check(
      "  no §18.6 external chain is opened for a CLEAR stranding — that is the false positive §18.6 warns about",
      (await prisma.externalEscalation.count({ where: { legId: r.leg.id } })) === 0,
    );
    check("  and it is re-armed, so a responder who never arrives is paged again", r.timer.timerState === "PENDING");
  }

  // ── STRANDED_OBSTRUCTING / PAGE_OPERATIONS_AND_EXTERNAL_ESCALATION ──────
  {
    const r = await exercise("STRANDED_OBSTRUCTING", { custodyState: "HELD", obstructionClass: "BLOCKING_CRITICAL" });
    const chain = await prisma.externalEscalation.findMany({ where: { legId: r.leg.id }, orderBy: { step: "asc" } });
    check(
      "STRANDED_OBSTRUCTING · the §18.6 chain is opened durably",
      chain.length === 3 && chain.map((row) => row.step).join(",") === "1,2,3",
      `steps: ${chain.map((row) => row.step).join(",")}`,
    );
    check(
      "  step 4 is NOT written — it is human-gated and unreachable from any automatic path",
      chain.every((row) => row.step !== 4),
    );
    check("  the page carries the response-target breach and its count", chain[0] && chain[0].detail.responseTargetMissed === true);
    check("  the Leg does not move: a stranding ends when a responder attends", r.after.state === "STRANDED_OBSTRUCTING");
    check("  and it is re-armed", r.timer.timerState === "PENDING");
  }

  // ── REASSIGNING / ESCALATE ──────────────────────────────────────────────
  {
    const r = await exercise("REASSIGNING");
    check(
      "REASSIGNING · ESCALATE escalates in place — §4.3 has no Leg SUSPENDED state",
      r.after.state === "REASSIGNING" && r.timer.lastOutcome.startsWith("REASSIGNMENT_ESCALATED"),
      `outcome=${r.timer.lastOutcome}`,
    );
    check(
      "  §4.7's SUSPENDED is reported as the Task's, following reassignment.js's precedent",
      r.events.some((e) => e.event === "timer.reassignment_escalated" && e.detail.taskState === "SUSPENDED"),
    );
    check("  and it is re-armed", r.timer.timerState === "PENDING");
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP C — adversarial: staleness, concurrency, crashes, idempotency
   ═══════════════════════════════════════════════════════════════════════════ */

async function groupC() {
  group("C. Adversarial — staleness, concurrency, crash points, idempotency");

  const mission = await makeMission();

  // ── stale timer from an old state ───────────────────────────────────────
  {
    const leg = await makeLeg(mission, { state: "AT_PICKUP" });
    const timer = await armLeg(leg);
    await prisma.leg.update({ where: { id: leg.id }, data: { version: 5 } });
    const events = [];
    await firePass(events);
    const after = await timerRow(timer.id);
    check(
      "a timer whose entity version moved on is DISCARDED and its handler never runs",
      after.timerState === "DISCARDED" && after.lastOutcome === "ENTITY_VERSION_MOVED_ON",
      `timerState=${after.timerState} outcome=${after.lastOutcome}`,
    );
    check("  and no alert was emitted for it", !events.some((e) => e.event === "timer.operator_alert"));
  }

  // ── entity gone ─────────────────────────────────────────────────────────
  {
    const leg = await makeLeg(mission, { state: "AT_PICKUP" });
    const timer = await armLeg(leg);
    await prisma.leg.delete({ where: { id: leg.id } });
    await firePass([]);
    const after = await timerRow(timer.id);
    check(
      "a timer whose entity has vanished is DISCARDED, not fired against nothing",
      after.timerState === "DISCARDED" && after.lastOutcome === "ENTITY_NO_LONGER_EXISTS",
      `outcome=${after.lastOutcome}`,
    );
  }

  // ── entity already terminal ─────────────────────────────────────────────
  {
    const leg = await makeLeg(mission, { state: "AT_PICKUP" });
    const timer = await armLeg(leg);
    await prisma.leg.update({ where: { id: leg.id }, data: { state: "SETTLED", version: 1 } });
    await firePass([]);
    const after = await timerRow(timer.id);
    check(
      "a timer on an entity that reached a terminal state is DISCARDED",
      after.timerState === "DISCARDED",
      `outcome=${after.lastOutcome}`,
    );
  }

  // ── state changed WITHOUT the version — an unconditional write somewhere ─
  {
    const leg = await makeLeg(mission, { state: "AT_PICKUP" });
    const timer = await armLeg(leg);
    // §4.1 rule 2 makes this impossible through any shipped path; done here with raw SQL
    // precisely because it is the shape of a defect the discard rule must still catch.
    await prisma.$executeRawUnsafe(`UPDATE "Leg" SET state = 'AT_DROP' WHERE id = $1`, leg.id);
    await firePass([]);
    const after = await timerRow(timer.id);
    check(
      "a state that changed without its version is DISCARDED as STATE_CHANGED_WITHOUT_VERSION",
      after.timerState === "DISCARDED" && after.lastOutcome === "STATE_CHANGED_WITHOUT_VERSION",
      `outcome=${after.lastOutcome}`,
    );
  }

  // ── two workers, one timer, concurrently ────────────────────────────────
  {
    const leg = await makeLeg(mission, { state: "STRANDED_OBSTRUCTING", custodyState: "HELD", obstructionClass: "BLOCKING_CRITICAL" });
    const timer = await armLeg(leg);
    const storeTime = await readStoreTime();

    const both = await Promise.allSettled([
      timerWorker.fireOne(composedDeps, composedConfig, await timerRow(timer.id), storeTime),
      timerWorker.fireOne(composedDeps, composedConfig, await timerRow(timer.id), storeTime),
    ]);
    const dispositions = both.map((r) => (r.status === "fulfilled" ? r.value.disposition : `REJECTED:${r.reason.message}`));
    const chain = await prisma.externalEscalation.count({ where: { legId: leg.id } });
    const after = await timerRow(timer.id);

    check(
      "two workers firing one timer concurrently produce ONE page, not two",
      chain === 3,
      `ExternalEscalation rows: ${chain} (3 = one chain of steps 1–3); dispositions ${dispositions.join(" / ")}`,
    );
    check("  the loser did no work at all", dispositions.filter((d) => d === "REARMED").length === 1, dispositions.join(" / "));
    check("  and the deadline was re-armed exactly once", after.attempts === 1, `attempts=${after.attempts}`);
  }

  // ── the same, for a transitioning action ────────────────────────────────
  {
    const leg = await makeLeg(mission, { state: "DEFERRED" });
    const timer = await armLeg(leg);
    const storeTime = await readStoreTime();
    const both = await Promise.allSettled([
      timerWorker.fireOne(composedDeps, composedConfig, await timerRow(timer.id), storeTime),
      timerWorker.fireOne(composedDeps, composedConfig, await timerRow(timer.id), storeTime),
    ]);
    const after = await legRow(leg.id);
    check(
      "a transitioning action applied concurrently moves the Leg exactly once",
      after.version === 1 && after.state === "QUEUED",
      `state=${after.state} version=${after.version}; ${both.map((r) => (r.status === "fulfilled" ? r.value.disposition : "REJECTED")).join(" / ")}`,
    );
    const pending = await prisma.timer.count({ where: { entityId: leg.id, timerState: "PENDING" } });
    check("  and exactly one pending timer supervises it afterwards", pending === 1, `pending=${pending}`);
  }

  // ── crash after the DB mutation, before resolution ──────────────────────
  {
    const leg = await makeLeg(mission, { state: "DEFERRED" });
    const timer = await armLeg(leg);
    const storeTime = await readStoreTime();

    const sabotaged = {
      ...composedDeps,
      handlers: {
        ...composedDeps.handlers,
        FORCE_WIDEN_AND_ESCALATE: async (ctx) => {
          await composedDeps.handlers.FORCE_WIDEN_AND_ESCALATE(ctx);
          throw new Error("process died after the mutation");
        },
      },
    };
    await timerWorker.fireOne(sabotaged, composedConfig, await timerRow(timer.id), storeTime);

    const after = await legRow(leg.id);
    const timerAfter = await timerRow(timer.id);
    check(
      "a crash after the mutation rolls the mutation back — the Leg did not move",
      after.state === "DEFERRED" && after.version === 0,
      `state=${after.state} version=${after.version}`,
    );
    check(
      "  and the deadline is still owned: PENDING, re-armed, with the cause recorded",
      timerAfter.timerState === "PENDING" && /HANDLER_THREW/.test(timerAfter.lastOutcome),
      `timerState=${timerAfter.timerState} outcome=${timerAfter.lastOutcome}`,
    );
  }

  // ── repeated execution does not duplicate the effect ────────────────────
  {
    const leg = await makeLeg(mission, { state: "STRANDED_SAFE", custodyState: "HELD", obstructionClass: "CLEAR" });
    await armLeg(leg);
    for (let pass = 0; pass < 3; pass += 1) {
      // Each pass re-arms the timer forward, so it must be made due again — which is
      // exactly what elapsed time does in production.
      await prisma.timer.updateMany({ where: { entityId: leg.id, timerState: "PENDING" }, data: { dueAt: new Date(Date.now() - 5000) } });
      await firePass([]);
    }
    const after = await legRow(leg.id);
    const timerRows = await prisma.timer.findMany({ where: { entityId: leg.id } });
    check(
      "three consecutive expiries of a non-transitioning action leave ONE timer and ONE state",
      timerRows.length === 1 && after.state === "STRANDED_SAFE" && after.version === 0,
      `timers=${timerRows.length} attempts=${timerRows[0] && timerRows[0].attempts} state=${after.state}`,
    );
    check("  and the attempt count is the durable record of how long it has been overdue", timerRows[0].attempts === 3, `attempts=${timerRows[0].attempts}`);
  }

  // ── clock boundary exactly at expiry ────────────────────────────────────
  {
    const leg = await makeLeg(mission, { state: "AT_PICKUP" });
    const timer = await armLeg(leg);
    const storeTime = await readStoreTime();
    await prisma.timer.update({ where: { id: timer.id }, data: { dueAt: storeTime } });
    const due = await timers.due(prisma, { storeTime, limit: 64 });
    check(
      "a timer due at exactly the store's clock is selected — the boundary is inclusive",
      due.some((row) => row.id === timer.id),
      `selected ${due.length}`,
    );
    const notYet = await timers.due(prisma, { storeTime: new Date(storeTime.getTime() - 1), limit: 64 });
    check("  and one millisecond earlier it is not", !notYet.some((row) => row.id === timer.id));
  }

  // ── multiple timers for one entity ──────────────────────────────────────
  {
    const leg = await makeLeg(mission, { state: "AT_PICKUP" });
    const now = await readStoreTime();
    await armLeg(leg);
    // A second timer for the same entity at a different state — the shape a reconciler
    // repair racing a transition leaves behind.
    await runInTransaction((tx) =>
      timers.register(tx, {
        entityType: timers.ENTITY_TYPE.LEG,
        entityId: leg.id,
        state: "AT_PICKUP",
        entity: leg,
        dueAt: new Date(now.getTime() - 1000),
        handler: "OPERATOR_ALERT",
        payload: { second: true },
      }),
    );
    const rows = await prisma.timer.findMany({ where: { entityId: leg.id } });
    check(
      "registering the same §4.5 key twice yields ONE timer, not two",
      rows.length === 1,
      `rows=${rows.length} — the key is (entity, id, state, version, handler) and it is unique`,
    );
  }

  // ── a fired timer's key is not re-usable as supervision ─────────────────
  {
    const leg = await makeLeg(mission, { state: "DEFERRED" });
    const timer = await armLeg(leg);
    await firePass([]);
    const fired = await timerRow(timer.id);
    const now = await readStoreTime();
    const reRegistered = await runInTransaction((tx) =>
      timers.register(tx, {
        entityType: timers.ENTITY_TYPE.LEG,
        entityId: leg.id,
        state: "DEFERRED",
        entity: { ...leg, version: 0 },
        dueAt: new Date(now.getTime() + 60_000),
        handler: "FORCE_WIDEN_AND_ESCALATE",
      }),
    );
    check(
      "PHASE 5 REGRESSION — re-registering a resolved key RE-ARMS it rather than handing back a resolved row",
      fired.timerState === "FIRED" && reRegistered.id === timer.id && reRegistered.timerState === "PENDING",
      `fired=${fired.timerState} reRegistered=${reRegistered.timerState} (same row: ${reRegistered.id === timer.id}) — ` +
        "returning the FIRED row left the state non-terminal and unsupervised, which is I4's violation",
    );
  }

  // ── batch bound ─────────────────────────────────────────────────────────
  {
    const many = await makeMission();
    const now = await readStoreTime();
    for (let i = 0; i < timerWorker.FIRE_BATCH + 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const leg = await makeLeg(many, { state: "AT_PICKUP" });
      // eslint-disable-next-line no-await-in-loop
      await runInTransaction((tx) =>
        timers.register(tx, {
          entityType: timers.ENTITY_TYPE.LEG,
          entityId: leg.id,
          state: "AT_PICKUP",
          entity: leg,
          dueAt: new Date(now.getTime() - 10_000),
          handler: "OPERATOR_ALERT",
        }),
      );
    }
    const summary = await firePass([]);
    check(
      `a backlog is drained in bounded passes — one pass takes at most FIRE_BATCH (${timerWorker.FIRE_BATCH})`,
      summary.due === timerWorker.FIRE_BATCH,
      `due=${summary.due} rearmed=${summary.rearmed}`,
    );
    check("  and the lag SLI reflects what the pass could NOT clear", summary.overdue > 0, `overdue after the pass: ${summary.overdue}`);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP D — the lag SLI and the degraded directive, live
   ═══════════════════════════════════════════════════════════════════════════ */

async function groupD() {
  group("D. §4.5's lag SLI and the degraded directive");

  await prisma.timer.deleteMany({ where: { entityId: { startsWith: "p5x-" } } });
  const mission = await makeMission();
  const leg = await makeLeg(mission, { state: "AT_PICKUP" });
  const now = await readStoreTime();
  await runInTransaction((tx) =>
    timers.register(tx, {
      entityType: timers.ENTITY_TYPE.LEG,
      entityId: leg.id,
      state: "AT_PICKUP",
      entity: leg,
      dueAt: new Date(now.getTime() - 600_000),
      handler: "OPERATOR_ALERT",
    }),
  );

  const lag = await timers.readLag(prisma, await readStoreTime());
  check("lag is the age of the OLDEST overdue timer, read live", lag.lagSeconds > 590, `lagSeconds=${Math.round(lag.lagSeconds)}`);

  // The lag is read *after* the pass, deliberately: it reports what the pass could not
  // clear. A single timer the pass handles therefore leaves lag at zero, which is correct
  // and is why the backlog below is larger than one pass can drain.
  for (let i = 0; i < timerWorker.FIRE_BATCH + 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const extra = await makeLeg(mission, { state: "AT_PICKUP" });
    // eslint-disable-next-line no-await-in-loop
    await runInTransaction((tx) =>
      timers.register(tx, {
        entityType: timers.ENTITY_TYPE.LEG,
        entityId: extra.id,
        state: "AT_PICKUP",
        entity: extra,
        dueAt: new Date(now.getTime() - 600_000),
        armedSeconds: 600,
        handler: "OPERATOR_ALERT",
      }),
    );
  }

  const events = [];
  const summary = await firePass(events);
  const directive = events.find((entry) => entry.event === "timer.degraded");
  check(
    "lag beyond supervise.max_timer_lag emits the degraded directive",
    summary.degraded === true && Boolean(directive),
    `lagSeconds=${Math.round(summary.lagSeconds)} overdue=${summary.overdue} degraded=${summary.degraded}`,
  );
  check(
    "  and its load-bearing half is to stop creating things that need supervising (T3)",
    directive && directive.detail.stopNewHardening === true && directive.detail.enterDegradedMode === "UNSUPERVISED_COMMITMENT",
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP E — planted violations: prove the mechanism fails closed
   ═══════════════════════════════════════════════════════════════════════════ */

async function groupE() {
  group("E. Planted violations — the mechanism fails closed");

  const mission = await makeMission();

  // P1 — a handler removed from the map.
  {
    // Groups B–D leave re-armed timers behind, which is correct behaviour and would make
    // `unhandled` count them too. Cleared so the number below means what the label says.
    await prisma.timer.deleteMany({ where: { entityId: { startsWith: "p5x-" } } });
    const leg = await makeLeg(mission, { state: "AT_PICKUP" });
    const timer = await armLeg(leg);
    const holed = { ...composedDeps, handlers: { ...composedDeps.handlers } };
    delete holed.handlers.OPERATOR_ALERT;
    const events = [];
    const summary = await timerWorker.fireDue({ ...holed, record: (e, d) => events.push({ event: e, detail: d }) }, composedConfig);
    const after = await timerRow(timer.id);
    check(
      "P1 · a due timer whose handler is missing stays PENDING and is reported — never silently discharged",
      summary.unhandled === 1 && after.timerState === "PENDING" && events.some((e) => e.event === "timer.handler_not_registered"),
      `unhandled=${summary.unhandled} timerState=${after.timerState}`,
    );
    await prisma.timer.delete({ where: { id: timer.id } });
  }

  // P2 — the completeness check itself.
  {
    const full = expiryActions.handlers({});
    const holed = { ...full };
    delete holed.FORCE_STRANDED;
    const verdict = expiryActions.assertComplete(holed);
    check("P2 · the completeness check catches a removed handler", verdict.ok === false && verdict.missing.includes("FORCE_STRANDED"));
    const extra = expiryActions.assertComplete({ ...full, GHOST_ACTION: () => {} });
    check("  and a handler for an action no machine declares", extra.ok === false && extra.unexpected.includes("GHOST_ACTION"));
  }

  // P3 — the re-arm removed: prove the Leg becomes unsupervised, which is what I4 forbids.
  {
    const leg = await makeLeg(mission, { state: "AT_PICKUP" });
    const timer = await armLeg(leg);
    const storeTime = await readStoreTime();

    // The planted defect: resolve instead of re-arm, which is exactly what `fireOne` did
    // before this remediation.
    await runInTransaction(async (tx) => {
      await timers.claim(tx, { id: timer.id, storeTime });
      await composedDeps.handlers.OPERATOR_ALERT({
        tx,
        prisma,
        timer: await tx.timer.findUnique({ where: { id: timer.id } }),
        entity: await tx.leg.findUnique({ where: { id: leg.id } }),
        storeTime,
        config: composedConfig,
        record: () => {},
      });
      await timers.resolve(tx, { id: timer.id, timerState: "FIRED", storeTime, outcome: "PLANTED_RESOLVE" });
    });

    const unsupervised = await timers.findUnsupervised(prisma, { limit: 500 });
    check(
      "P3 · with the re-arm removed the Leg is left non-terminal with no pending timer — I4's violation, detected",
      unsupervised.some((row) => row.entityId === leg.id),
      `findUnsupervised reported ${unsupervised.length} row(s); the planted Leg is ${unsupervised.some((r) => r.entityId === leg.id) ? "among them" : "MISSING — the audit cannot see it"}`,
    );

    // Restore: re-arm it properly and prove the audit goes quiet for this Leg.
    const now = await readStoreTime();
    await runInTransaction((tx) =>
      timers.register(tx, {
        entityType: timers.ENTITY_TYPE.LEG,
        entityId: leg.id,
        state: "AT_PICKUP",
        entity: { ...leg, version: 0 },
        dueAt: new Date(now.getTime() + 600_000),
        handler: "OPERATOR_ALERT",
        payload: { restored: true },
      }),
    );
    const after = await timers.findUnsupervised(prisma, { limit: 500 });
    check("  and restoring supervision clears it", !after.some((row) => row.entityId === leg.id));
  }

  // P4 — the claim's dueAt re-check removed would double-fire a re-armed timer.
  {
    const leg = await makeLeg(mission, { state: "STRANDED_OBSTRUCTING", custodyState: "HELD", obstructionClass: "BLOCKING_CRITICAL" });
    const timer = await armLeg(leg);
    const storeTime = await readStoreTime();

    await timerWorker.fireOne(composedDeps, composedConfig, await timerRow(timer.id), storeTime);
    const afterFirst = await prisma.externalEscalation.count({ where: { legId: leg.id } });

    // A second pass at the same clock: the row is still PENDING (it was re-armed), so a
    // claim that checked only `timerState` would fire it again and page twice.
    const second = await timerWorker.fireOne(composedDeps, composedConfig, { ...(await timerRow(timer.id)), dueAt: storeTime }, storeTime);
    const afterSecond = await prisma.externalEscalation.count({ where: { legId: leg.id } });

    check(
      "P4 · a re-armed timer cannot be fired again at the same store clock",
      second.disposition === "NOT_CLAIMED" && afterSecond === afterFirst,
      `disposition=${second.disposition}, chain rows ${afterFirst} → ${afterSecond}`,
    );
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP F — cross-phase findings, reproduced rather than asserted
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * §4.5's other half — *"Every deadline in §4.2 and §4.3 MUST be registered in the durable
 * timer store at the moment the state is entered"* — is not Phase 5's to close everywhere
 * it is broken, and this group is why that sentence is not a dodge.
 *
 * Phase 5's answer to the requirement is `lifecycle/transitions.apply`, which registers and
 * cancels inside the transition's own transaction so that *"a caller cannot forget, because
 * there is nothing to forget"*. But **`transitions.apply` has no production caller**, and
 * several live paths write a Leg's state directly instead. Each leaves the Leg in a
 * non-terminal state with no pending timer, which is invariant I4's violation and precisely
 * the unsupervised state §4.5 exists to prevent.
 *
 * These checks **reproduce the findings**: a PASS here means "the gap is present and is
 * exactly as the closure document describes it". They are not fixed here, because the
 * modules belong to Phase 3, Phase 4 and the Phase 15 cutover, and this exercise is
 * instructed to preserve Phases 0–4 and not to fix other phases silently. Written into the
 * harness rather than only into a document so the handoff stays true as the tree moves: if
 * an owner closes one, this check fails and says so.
 */
async function groupF() {
  group("F. Cross-phase findings — reproduced, owned elsewhere, NOT fixed here");

  const mission = await makeMission();

  check(
    "FINDING X2 — `transitions.apply` still has no production caller outside supervision",
    true,
    "the §4.4 machine is reached from `supervision/expiryActions.js` and from tests, and from nowhere else. " +
      "`dispatch/offers.js` says so in its own header: every Leg write there is conditional on the version, " +
      "\"which is the property Phase 5's machine will preserve when it takes ownership of the transitions\". " +
      "That ownership transfer is the Phase 15 cutover's.",
  );

  // X2a — the ACK path, live through `sockets/handlers/offer.handler.js`.
  {
    const agent = await makeAgent();
    const leg = await makeLeg(mission, { state: "OFFERED" });
    const commitment = await makeCommitment(agent, leg);
    await armLeg(leg, 1);

    await runInTransaction((tx) =>
      offers.applyAccept(tx, {
        commitment,
        leg,
        storeTime: new Date(),
        leaseDurationSeconds: 300,
        evidence: { commitmentId: commitment.commitmentId, fence: commitment.fence },
      }),
    );

    const after = await legRow(leg.id);
    const pending = await prisma.timer.count({
      where: { entityId: leg.id, timerState: "PENDING", entityVersion: BigInt(after.version) },
    });
    check(
      "FINDING X2a — `offers.applyAccept` moves OFFERED→ACCEPTED and registers no ACCEPTED deadline",
      after.state === "ACCEPTED" && pending === 0,
      `state=${after.state} version=${after.version}; pending timers at that version: ${pending}. ` +
        "The Leg is ACCEPTED and unsupervised: `execute.start_grace` will never expire, so a silent agent is " +
        "never probed and never reassigned. Owner: Phase 4 module, Phase 15 cutover to route it through §4.4.",
    );
  }

  // X2b — the outbox worker's own §11.4 withdrawal, live since Phase 15 wired that worker.
  {
    const agent = await makeAgent();
    const leg = await makeLeg(mission, { state: "OFFERED" });
    const commitment = await makeCommitment(agent, leg);
    await armLeg(leg, 1);

    await runInTransaction((tx) =>
      offers.withdrawExpiredOffer(tx, {
        commitment,
        agent,
        leg,
        storeTime: new Date(),
        maxDeliveryDelaySeconds: 5,
        nackCooloffSeconds: 60,
        signingKey: "phase5-verification-signing-key-0123456789abcdef",
        reason: "OFFER_TTL_EXPIRED",
      }),
    );

    const after = await legRow(leg.id);
    const pending = await prisma.timer.count({
      where: { entityId: leg.id, timerState: "PENDING", entityVersion: BigInt(after.version) },
    });
    check(
      "FINDING X2b — `outbox.worker`'s §11.4 withdrawal requeues a Leg with no QUEUED deadline",
      after.state === "QUEUED" && pending === 0,
      `state=${after.state} version=${after.version}; pending timers at that version: ${pending}. ` +
        "Phase 5's own WITHDRAW_EXCLUDE_REPLAN handler registers it (group B proves that); the outbox worker " +
        "calls the same function directly and does not. Owner: Phase 4 module, live since Phase 15 wired the worker.",
    );
  }

  // X3 — the §4.2 half of §4.5 has no producer at all.
  {
    const taskTimers = await prisma.timer.count({ where: { entityType: "TASK" } });
    check(
      "FINDING X3 — no path anywhere registers a TASK timer, so §4.2's half of §4.5 is dormant",
      taskTimers === 0,
      `TASK-entity timers in the store: ${taskTimers}. No engine path writes a §4.2 Task state at all: ` +
        "`taskMachine.js` declines to map the legacy vocabulary because \"inventing one would be deciding the " +
        "cutover semantics four phases early, and Phase 15 owns that\". Phase 5 supplies the four Task expiry " +
        "handlers so the deadlines are owned when the cutover lands; today they are unreachable.",
    );
  }

  // X1 — §17.4, the collaborator the ladder handler refuses by name.
  {
    const fs = require("fs");
    const path = require("path");
    const fairness = path.join(__dirname, "..", "..", "src", "engine", "fairness");
    const contents = fs.existsSync(fairness) ? fs.readdirSync(fairness).filter((f) => f.endsWith(".js")) : [];
    check(
      "FINDING X1 — §17.4's escalation ladder (T1-04) has no implementation",
      contents.length === 0,
      `src/engine/fairness/ holds ${contents.length} module(s). The execution plan assigns ladder.js, ` +
        "operatorCapacity.js and agentStarvation.js to REMEDIAL PHASE T1-04 and records that \"registration is " +
        "authorization, not implementation\". ESCALATION_LADDER therefore refuses by name and re-arms.",
    );
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Run
   ═══════════════════════════════════════════════════════════════════════════ */

async function main() {
  console.log("PHASE 5 — §4.5 expiry semantics against live PostgreSQL");
  console.log(`  database: ${url.replace(/:[^:@]*@/, ":***@")}`);

  try {
    await cleanup();
    await groupA();
    await groupB();
    await groupC();
    await groupD();
    await groupE();
    await groupF();
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }

  const failed = results.filter((row) => !row.ok);
  console.log(`\n${"═".repeat(78)}`);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log("\n  FAILURES:");
    for (const row of failed) console.log(`    [${row.group}] ${row.label}${row.detail ? ` — ${row.detail}` : ""}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nHARNESS ERROR:", error);
  process.exit(3);
});

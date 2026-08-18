"use strict";

/**
 * The Invariant Checker (§26) — **Tier 1**, mechanism T1-07. Invariants I3, I6 by
 * ownership, all twenty-two by verification.
 *
 * > These MUST hold at all times **in nominal operation**, and their behaviour in every
 * > named degraded mode is stated in §26.2 rather than left to inference. Each is
 * > continuously verified by the Invariant Checker, **which runs independently of the code
 * > paths that maintain them — a checker sharing logic with the enforcer verifies nothing.**
 *
 * ── What "independently" is taken to mean here, concretely ──────────────────
 * The last clause is the whole design constraint, so it is worth being exact about how it
 * is honoured rather than asserting it:
 *
 *   1. **This module imports no enforcing module.** Not `commitment/`, not `supervision/`,
 *      not `dispatch/`, not `lifecycle/`, not `intake/`, not `solve/`. Every check is a
 *      query this module writes against the durable store. A source-scanning test asserts
 *      the import list, so the property is checked rather than remembered.
 *   2. **It does not read the enforcer's own bookkeeping as evidence.** I6 in particular
 *      is verified against a high-water mark **this checker persists from its own
 *      observations**, not against `AgentFenceAudit.fenceHighWater`, which the commit path
 *      maintains. Verifying the commit path against a number the commit path writes is the
 *      circularity §26.1 is warning about, stated in miniature.
 *   3. **It re-declares the state vocabulary it needs** — the terminal Leg states, the
 *      recovery states — as local constants transcribed from §4.3, rather than importing
 *      `lifecycle/legMachine.js`. A checker that read its state partition from the module
 *      under test would inherit that module's mistake and report `ENFORCED` on it.
 *      `assertVocabularyAgreesWithDomain()` compares the two at build time, so the
 *      independence costs nothing in drift.
 *
 * The one module it does import is `degraded/modeRegister.js`, and that is not an enforcer:
 * it is §26.2's matrix, which is *the specification of what this checker should report*.
 * Reading it is the checker consulting its own requirements.
 *
 * ── Three statuses, and the third is not a euphemism for the second ─────────
 * `ENFORCED` · `VIOLATED` · `SUSPENDED`, exactly as §26.1 defines them. A `SUSPENDED`
 * status is only ever produced from §26.2's matrix against the shard's *actually open*
 * modes — never from a check finding its own evidence inconvenient — and it names the mode
 * that authorised it.
 *
 * ── A check that could not run reports neither `ENFORCED` nor `VIOLATED` ────
 * A query that throws is a fact about the checker, not about the invariant. Returning
 * `ENFORCED` in that case would be the single worst behaviour this module could have: a
 * green register produced by a broken query is indistinguishable from a healthy system and
 * strictly worse than no register. So a failed check reports `status: null` with
 * `checkError` set, the previous stored status is left standing, and the *checker* is
 * marked unhealthy in the summary — which alerts on the checker rather than on the fleet.
 *
 * ── No clock ────────────────────────────────────────────────────────────────
 * Time is supplied. A check run against the store's clock and a check run against a
 * worker's clock disagree about lease expiry by exactly the skew between them (§10.6).
 */

const modeRegister = require("../degraded/modeRegister");

/**
 * §26.1's three statuses.
 * @structural the specification's own status vocabulary
 */
const STATUS = Object.freeze({
  ENFORCED: "ENFORCED",
  VIOLATED: "VIOLATED",
  SUSPENDED: "SUSPENDED",
});

/**
 * The four terminal Leg states of §4.3, transcribed rather than imported — see the
 * independence note above.
 * @structural the terminal partition of §4.3
 */
const TERMINAL_LEG_STATES = Object.freeze(["SETTLED", "WITHDRAWN", "CANCELLED", "FAILED"]);

/**
 * The states I2 reads as "or is in a recovery state".
 * @structural the recovery partition of §4.3, as invariant I2 reads it
 */
const RECOVERY_LEG_STATES = Object.freeze(["ABORTING", "REASSIGNING", "STRANDED_SAFE", "STRANDED_OBSTRUCTING"]);

/**
 * The two `STRANDED_*` states I22 is stated over.
 * @structural §4.3's stranding pair
 */
const STRANDED_LEG_STATES = Object.freeze(["STRANDED_SAFE", "STRANDED_OBSTRUCTING"]);

/**
 * The obstruction classes that produce `STRANDED_OBSTRUCTING` (§4.3).
 * @structural §4.3's obstructing partition, INDETERMINATE included by its own resolution
 */
const OBSTRUCTING_CLASSES = Object.freeze(["BLOCKING_CRITICAL", "INDETERMINATE"]);

/**
 * The entity types a §4.5 timer may be keyed on. `AGENT` is deliberately absent: I4's
 * verification is "including a check that no timer is keyed on an agent-level counter".
 * @structural §4.5's permitted timer entity types
 */
const TIMER_ENTITY_TYPES = Object.freeze(["LEG", "TASK", "COMMITMENT"]);

/** @structural the ceiling on rows one check reports, so one defect cannot flood a page */
const MAX_REPORTED_VIOLATIONS = 50;

/** @structural milliseconds per second */
const MS_PER_SECOND = 1000;

/**
 * A check's result.
 *
 * @param {string} invariantId
 * @param {object} input
 * @returns {object}
 */
function result(invariantId, input) {
  const source = input || {};
  return {
    invariantId,
    status: source.status ?? null,
    violations: source.violations || [],
    violationCount: Number.isFinite(source.violationCount) ? source.violationCount : (source.violations || []).length,
    instrument: source.instrument || null,
    detail: source.detail || null,
    authorisedBy: source.authorisedBy ?? null,
    checkError: source.checkError ?? null,
  };
}

/**
 * Trim a violation list to the reporting ceiling, keeping the count honest.
 *
 * @param {object[]} rows
 * @returns {{ violations: object[], violationCount: number, truncated: boolean }}
 */
function bounded(rows) {
  const all = rows || [];
  return {
    violations: all.slice(0, MAX_REPORTED_VIOLATIONS),
    violationCount: all.length,
    truncated: all.length > MAX_REPORTED_VIOLATIONS,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   The twenty-two checks
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * I1 — every agent has at most `capacity[class]` active HARD commitments.
 *
 * The count is taken over the store, not over the commit path's own accounting. A commit
 * path that miscounted would produce a consistent internal view and an inconsistent table,
 * and the table is the one the physical world is downstream of.
 */
async function checkI1(deps, context) {
  // `Commitment` carries no shard column — a commitment's shard is its agent's region
  // (§3.5), and joining through the agent to filter would make this check depend on the
  // membership table Phase 13 owns. The count is fleet-wide and correct either way: an
  // agent over capacity is over capacity in whichever shard holds it.
  const grouped = await deps.prisma.commitment.groupBy({
    by: ["agentId"],
    where: { releasedAt: null, kind: "HARD" },
    _count: { _all: true },
  });

  const capacityByClass = context.capacityByClass || {};
  const defaultCapacity = Number.isFinite(context.defaultCapacity) ? context.defaultCapacity : 1;

  const over = [];
  for (const row of grouped) {
    const held = Number(row._count._all || 0);
    const agentClass = context.agentClassOf ? context.agentClassOf(row.agentId) : null;
    const capacity = Number.isFinite(capacityByClass[agentClass]) ? capacityByClass[agentClass] : defaultCapacity;
    if (held > capacity) {
      over.push({ agentId: row.agentId, held, capacity, agentClass });
    }
  }

  const { violations, violationCount, truncated } = bounded(over);
  return result("I1", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "periodic count of unreleased Commitment rows per agent (§26.1)",
    detail: truncated ? `${violationCount} agents over capacity; the first ${MAX_REPORTED_VIOLATIONS} are listed` : null,
  });
}

/**
 * I2 — every active commitment has a valid lease or is in a recovery state.
 *
 * Judged against the store's clock (§10.6). The recovery-state arm is what stops the check
 * paging for the expiries the design *expects*: the expiry is supposed to produce a
 * recovery, and a commitment whose Leg is already recovering is the mechanism working.
 */
async function checkI2(deps, context) {
  const expired = await deps.prisma.commitment.findMany({
    where: { releasedAt: null, leaseExpiry: { lte: context.storeTime } },
    orderBy: { leaseExpiry: "asc" },
  });

  const offending = [];
  for (const commitment of expired) {
    // eslint-disable-next-line no-await-in-loop
    const leg = await deps.prisma.leg.findUnique({ where: { id: commitment.legId } });
    if (leg && RECOVERY_LEG_STATES.includes(leg.state)) continue;
    offending.push({
      commitmentId: commitment.commitmentId,
      agentId: commitment.agentId,
      legId: commitment.legId,
      leaseExpiry: commitment.leaseExpiry,
      legState: leg ? leg.state : null,
    });
  }

  const { violations, violationCount } = bounded(offending);
  return result("I2", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "lease audit sweep against the store's clock (§26.1)",
  });
}

/**
 * I3 — every non-terminal Leg has an active commitment, a SOFT reservation in the leader's
 * plan state, or a queue entry.
 *
 * The SOFT arm lives in coordinator memory (I18 forbids persisting it), so it arrives as
 * `context.softReservedLegIds`. A checker that ignored it would report every `PLANNED` Leg
 * as an orphan; one that assumed it would report none. It is therefore an explicit input
 * whose absence is recorded in `detail` — the honest position when the coordinator is not
 * reachable from the checker's process.
 *
 * Post-failover `PLANNED` orphans are counted separately from defect orphans, per §26.1.
 */
async function checkI3(deps, context) {
  const legs = await deps.prisma.leg.findMany({
    where: { state: { notIn: [...TERMINAL_LEG_STATES] } },
    select: { id: true, legId: true, state: true },
  });

  // ── Two set reads, not two reads per Leg ────────────────────────────────────
  //
  // This scan used to issue a `findFirst` for the commitment and another for the queue entry per
  // Leg, which made the pass's cost 2N round trips. Measured against a live PostgreSQL cluster at
  // 500 Legs, I3 alone took 515 ms of a 2,137 ms pass; the checker runs on a 60 s interval, so a
  // pass whose cost is linear in *round trips* reaches its own cadence at a fleet size §19.2's
  // sizing argument treats as small. "Continuously verified" (§26.1) is a claim about the pass
  // completing, so the shape is part of the requirement rather than an optimisation.
  //
  // The set-based form is exactly equivalent: membership in "has an unreleased commitment" and in
  // "has a queue entry" is what the per-Leg queries were establishing one row at a time.
  const legIds = legs.map((leg) => leg.id);
  const committed = new Set(
    (await deps.prisma.commitment.findMany({
      where: { legId: { in: legIds }, releasedAt: null },
      select: { legId: true },
    })).map((row) => row.legId),
  );
  const queuedLegIds = new Set(
    (await deps.prisma.workQueue.findMany({
      where: { legId: { in: legIds } },
      select: { legId: true },
    })).map((row) => row.legId),
  );

  const soft = new Set(context.softReservedLegIds || []);
  const orphans = [];
  const plannedOrphans = [];

  for (const leg of legs) {
    if (committed.has(leg.id)) continue;
    if (queuedLegIds.has(leg.id)) continue;
    if (soft.has(leg.legId) || soft.has(leg.id)) continue;

    const row = { legId: leg.legId, state: leg.state };
    // §26.1: "post-failover `PLANNED` orphans counted separately from defect orphans".
    if (leg.state === "PLANNED") plannedOrphans.push(row);
    else orphans.push(row);
  }

  const all = [...orphans, ...plannedOrphans];
  const { violations, violationCount } = bounded(all);
  return result("I3", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "orphan scan over non-terminal Legs (§26.1)",
    detail:
      `${orphans.length} defect orphans, ${plannedOrphans.length} PLANNED orphans (re-planned in the first ` +
      "round after a failover, and counted separately for that reason)" +
      (context.softReservedLegIds ? "" : ". No SOFT reservation set was supplied, so PLANNED Legs held only in coordinator memory appear here"),
  });
}

/**
 * I4 — every non-terminal state has a pending timer keyed on **that entity's own version**.
 *
 * Two halves, and the second is the one §26.1 spells out: "including a check that no timer
 * is keyed on an agent-level counter". A timer keyed on the agent's epoch is invalidated by
 * any unrelated commit on that agent, which silently removes supervision from missions
 * executing normally — the failure §4.5 revised the keying to prevent.
 */
async function checkI4(deps, context) {
  const legs = await deps.prisma.leg.findMany({
    where: { state: { notIn: [...TERMINAL_LEG_STATES] } },
    select: { id: true, legId: true, state: true, version: true },
  });

  // One read of the pending LEG timers, indexed by entity — not one read per Leg. The same
  // measurement that reshaped I3 put I4 at 446 ms of a 2,137 ms pass over 500 Legs, and
  // `Timer` already carries the `(entityType, entityId, timerState)` index this uses.
  const supervised = new Map();
  for (const timer of await deps.prisma.timer.findMany({
    where: { entityType: "LEG", entityId: { in: legs.map((leg) => leg.id) }, timerState: "PENDING" },
    select: { entityId: true, entityVersion: true },
  })) {
    // A Leg with several pending timers is supervised by any of them; the version comparison
    // below wants the one that matches, so the freshest is kept.
    const existing = supervised.get(timer.entityId);
    if (!existing || BigInt(timer.entityVersion) > BigInt(existing.entityVersion)) {
      supervised.set(timer.entityId, timer);
    }
  }

  const unsupervised = [];
  for (const leg of legs) {
    // States with no deadline in §4.3 are legitimately timerless; the caller supplies the
    // set rather than this module re-deriving §4.3's deadline column, because deriving it
    // here would be the second copy of a table the lifecycle module already owns.
    if ((context.statesWithoutDeadline || []).includes(leg.state)) continue;
    const timer = supervised.get(leg.id);
    if (!timer) {
      unsupervised.push({ legId: leg.legId, state: leg.state, problem: "NO_PENDING_TIMER" });
      continue;
    }
    if (BigInt(timer.entityVersion) !== BigInt(leg.version)) {
      unsupervised.push({
        legId: leg.legId,
        state: leg.state,
        problem: "TIMER_VERSION_STALE",
        timerVersion: String(timer.entityVersion),
        legVersion: String(leg.version),
      });
    }
  }

  const misKeyed = await deps.prisma.timer.findMany({
    where: { entityType: { notIn: [...TIMER_ENTITY_TYPES] } },
    select: { timerKey: true, entityType: true, entityId: true },
  });
  for (const timer of misKeyed) {
    unsupervised.push({
      timerKey: timer.timerKey,
      problem: "TIMER_KEYED_ON_UNPERMITTED_ENTITY",
      entityType: timer.entityType,
      detail:
        "§4.5 keys timers on the supervised entity's own version. An agent-level key means any unrelated " +
        "commit on that agent invalidates this timer, removing supervision from a mission that is fine.",
    });
  }

  const { violations, violationCount } = bounded(unsupervised);
  return result("I4", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "timer/state cross-audit, including the agent-level-key check (§26.1)",
  });
}

/**
 * I5 — no agent applies a command carrying a superseded fence, in either scope.
 *
 * §26.1's verification is "Fence-rejection counters, reported per scope; neither may have a
 * rising baseline." A rejection is *the mechanism working*, so a non-zero count is not a
 * violation; a **rising baseline** is. The check therefore compares the window's rate
 * against the persisted previous window rather than against zero.
 */
async function checkI5(deps, context) {
  const rows = await deps.prisma.outbox.groupBy({
    by: ["fenceScope"],
    where: {
      lastError: { contains: "FENCE" },
      updatedAt: { gte: new Date(context.windowStartMs), lt: new Date(context.nowMs) },
    },
    _count: { _all: true },
  });

  const byScope = Object.fromEntries(rows.map((row) => [row.fenceScope, Number(row._count._all || 0)]));

  const observedTotal = Object.values(byScope).reduce((sum, count) => sum + count, 0);

  // §26.1's instrument is a **rising baseline**, which is a statement about two windows. A
  // single window carries no baseline — and `previousFenceRejections` is deliberately
  // distinguished from an empty object here: `{}` is a real observation (a previous window
  // with no rejections in any scope), `undefined` is the absence of one.
  // `workers/invariant.worker.js` carries the observation forward between passes.
  //
  // With no baseline there are two cases and they are not the same fact:
  //
  //   · **No rejections at all this window.** Zero cannot be a rise from any non-negative
  //     baseline, so the invariant provably holds and `ENFORCED` is not a guess.
  //   · **Rejections, and nothing to compare them against.** Whether they are a rise is
  //     genuinely unknown, and the honest report is "not verified" — not `ENFORCED`, which
  //     would be a claim about a trend nobody has observed, and not `VIOLATED`, which would
  //     page for the mechanism working (a rejection *is* the fence doing its job).
  if (context.previousFenceRejections === undefined || context.previousFenceRejections === null) {
    return {
      ...result("I5", {
        status: observedTotal === 0 ? STATUS.ENFORCED : null,
        instrument: "fence-rejection counters per scope, compared against the previous window (§26.1)",
        checkError:
          observedTotal === 0
            ? null
            : "no previous window is on record, so whether this window's fence rejections are a *rising* " +
              "baseline cannot be established. §26.1 verifies I5 by \"fence-rejection counters, reported per " +
              "scope; neither may have a rising baseline\" — a comparison over two windows.",
        detail:
          `rejections this window by scope: ${JSON.stringify(byScope)}. No previous window on record` +
          (observedTotal === 0
            ? "; a count of zero cannot be a rise from any baseline, so the invariant holds on this window alone."
            : "."),
      }),
      fenceRejectionsByScope: byScope,
    };
  }

  const previous = context.previousFenceRejections;
  const rising = [];

  for (const [scope, count] of Object.entries(byScope)) {
    const before = Number.isFinite(previous[scope]) ? previous[scope] : 0;
    if (count > before) {
      rising.push({ scope, previous: before, current: count });
    }
  }

  const { violations, violationCount } = bounded(rising);
  return {
    ...result("I5", {
      status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
      violations,
      violationCount,
      instrument: "fence-rejection counters per scope, compared against the previous window (§26.1)",
      detail: `rejections this window by scope: ${JSON.stringify(byScope)}; previous window: ${JSON.stringify(previous)}`,
    }),
    // Returned for the worker to carry to the next pass, exactly as I6's marks are. The
    // check itself writes nothing.
    fenceRejectionsByScope: byScope,
  };
}

/**
 * I6 — `fence_counter` and `authority_epoch` are each strictly monotonic per agent.
 *
 * > Windowed monotonicity audit against a **persisted high-water mark per agent**.
 *
 * The mark this check compares against is one **this checker persisted from its own
 * observations**, held on the checker's own `InvariantStatus` rows. It is deliberately not
 * `AgentFenceAudit.fenceHighWater`: that column is maintained by the commit path, and
 * checking the commit path's monotonicity against a high-water mark the commit path writes
 * verifies that the commit path is self-consistent, which is not the property I6 states.
 *
 * "Windowed" is what makes it tractable: a full-history audit is a table scan per pass, and
 * a monotonic sequence that was monotone at the last pass and is monotone since is monotone.
 */
async function checkI6(deps, context) {
  const agents = await deps.prisma.agent.findMany({
    select: { id: true, agentId: true, fenceCounter: true, authorityEpoch: true },
    ...(context.agentScanLimit ? { take: context.agentScanLimit } : {}),
  });

  const marks = context.highWaterMarks || new Map();
  const regressions = [];
  const nextMarks = new Map();

  for (const agent of agents) {
    const fence = agent.fenceCounter === null || agent.fenceCounter === undefined ? 0n : BigInt(agent.fenceCounter);
    const epoch = agent.authorityEpoch === null || agent.authorityEpoch === undefined ? 0n : BigInt(agent.authorityEpoch);
    const mark = marks.get(agent.agentId) || null;

    if (mark) {
      if (fence < BigInt(mark.fence)) {
        regressions.push({
          agentId: agent.agentId,
          counter: "fence_counter",
          highWater: String(mark.fence),
          observed: String(fence),
        });
      }
      if (epoch < BigInt(mark.epoch)) {
        regressions.push({
          agentId: agent.agentId,
          counter: "authority_epoch",
          highWater: String(mark.epoch),
          observed: String(epoch),
        });
      }
    }

    nextMarks.set(agent.agentId, {
      fence: (mark && BigInt(mark.fence) > fence ? BigInt(mark.fence) : fence).toString(),
      epoch: (mark && BigInt(mark.epoch) > epoch ? BigInt(mark.epoch) : epoch).toString(),
    });
  }

  const { violations, violationCount } = bounded(regressions);
  return {
    ...result("I6", {
      status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
      violations,
      violationCount,
      instrument: "windowed monotonicity audit against the checker's own persisted high-water mark (§26.1)",
      detail: `${agents.length} agents observed; ${marks.size} carried a prior mark`,
    }),
    // Returned so the worker can persist them; the check itself writes nothing, which is
    // what keeps it a pure query over the store.
    highWaterMarks: nextMarks,
  };
}

/**
 * I7 — an agent with a non-empty payload manifest is never returned to the available pool.
 *
 * §26.1 marks this **highest-severity alert on violation**, which is why the check is the
 * blunt one: an agent in the pool with a manifest, regardless of how it got there.
 */
async function checkI7(deps) {
  // Pool membership itself lives in the availability index, which is a cache tier and
  // therefore not an authority for anything (§3.3) — so the durable shadow of "returned to
  // the pool" is used instead: an agent holding goods with **no active commitment** has
  // been released by settlement, and the index will follow. Checking the durable fact
  // rather than the cached one is also what keeps this check independent of Phase 9's index.
  const holding = await deps.prisma.leg.findMany({
    where: { custodyState: "HELD" },
    select: { id: true, legId: true, custodyState: true },
  });

  const offending = [];
  for (const leg of holding) {
    // eslint-disable-next-line no-await-in-loop
    const active = await deps.prisma.commitment.findFirst({
      where: { legId: leg.id, releasedAt: null },
      select: { commitmentId: true, agentId: true },
    });
    if (active) continue;
    // eslint-disable-next-line no-await-in-loop
    const released = await deps.prisma.commitment.findFirst({
      where: { legId: leg.id },
      orderBy: { releasedAt: "desc" },
      select: { commitmentId: true, agentId: true, releasedAt: true },
    });
    offending.push({
      legId: leg.legId,
      custodyState: leg.custodyState,
      agentId: released ? released.agentId : null,
      releasedAt: released ? released.releasedAt : null,
      problem: "AGENT_RELEASED_WHILE_CUSTODY_HELD",
      severity: "HIGHEST",
    });
  }

  const { violations, violationCount } = bounded(offending);
  return result("I7", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "custody audit over HELD Legs against active commitments (§26.1)",
    detail: violationCount > 0 ? "highest-severity alert on violation (§26.1)" : null,
  });
}

/**
 * I8 — custody `HELD` always has exactly one accountable agent or custodian.
 */
async function checkI8(deps) {
  const held = await deps.prisma.leg.findMany({
    where: { custodyState: "HELD" },
    select: { id: true, legId: true },
  });

  const offending = [];
  for (const leg of held) {
    // "Exactly one" is the whole of I8, and both directions are failures: zero accountable
    // parties is goods nobody owns, and two is a dispute nobody has resolved. Counting is
    // therefore the check, not "is there at least one".
    // eslint-disable-next-line no-await-in-loop
    const accountable = await deps.prisma.commitment.findMany({
      where: { legId: leg.id, releasedAt: null },
      select: { commitmentId: true, agentId: true },
    });
    if (accountable.length === 1) continue;
    offending.push({
      legId: leg.legId,
      accountableCount: accountable.length,
      agentIds: accountable.map((row) => row.agentId),
      problem: accountable.length === 0 ? "NO_ACCOUNTABLE_PARTY" : "MORE_THAN_ONE_ACCOUNTABLE_PARTY",
    });
  }

  const { violations, violationCount } = bounded(offending);
  return result("I8", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "custody reconciliation over HELD Legs against their active commitments (§26.1)",
  });
}

/**
 * I9 — no committed plan violates a class I, R, or F constraint at commit time.
 *
 * > Post-hoc audit of committed plans against predicates.
 *
 * The audit is over the *decision record*, which carries the gate's verdict at commit time
 * — not a re-evaluation now. Re-evaluating today's predicates against yesterday's world
 * would report violations for every agent whose battery has since drained, which is a
 * different and uninteresting statement.
 */
async function checkI9(deps, context) {
  const committed = await deps.prisma.decisionRecordA.findMany({
    where: {
      outcome: { not: null },
      decisionTime: { gte: new Date(context.windowStartMs), lt: new Date(context.nowMs) },
      ...(context.shardId ? { shardId: context.shardId } : {}),
      ...(context.productionOnly || {}),
    },
    select: { decisionId: true, legId: true, outcome: true, rejectionSummary: true },
  });

  const offending = [];
  for (const row of committed) {
    const outcome = row.outcome || {};
    // A decision that assigned while recording a binding class I or R predicate against the
    // chosen candidate is the shape of an I9 violation in the record.
    if (outcome.action === "ASSIGNED" && outcome.chosenBindingPredicateId) {
      offending.push({
        decisionId: row.decisionId,
        legId: row.legId,
        bindingPredicateId: outcome.chosenBindingPredicateId,
      });
    }
  }

  const { violations, violationCount } = bounded(offending);
  return result("I9", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "post-hoc audit of committed plans against the gate's recorded verdict (§26.1)",
    detail: `${committed.length} decisions audited in the window`,
  });
}

/**
 * I10 — every commitment references a decision record that reproduces it.
 *
 * The reproduction half is Phase 11's replay sampling; the reference half is checkable
 * structurally, and a commitment with a dangling or absent `decisionRef` is a commitment
 * nobody can explain — which is I10's operational content.
 */
async function checkI10(deps, context) {
  const commitments = await deps.prisma.commitment.findMany({
    where: { grantedAt: { gte: new Date(context.windowStartMs), lt: new Date(context.nowMs) } },
    select: { commitmentId: true, decisionRef: true },
  });

  const offending = [];
  for (const commitment of commitments) {
    if (!commitment.decisionRef) {
      offending.push({ commitmentId: commitment.commitmentId, problem: "NO_DECISION_REFERENCE" });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const record = await deps.prisma.decisionRecordA.findFirst({
      where: { decisionId: commitment.decisionRef },
      select: { decisionId: true },
    });
    if (!record) {
      offending.push({
        commitmentId: commitment.commitmentId,
        decisionRef: commitment.decisionRef,
        problem: "DANGLING_DECISION_REFERENCE",
      });
    }
  }

  const { violations, violationCount } = bounded(offending);
  return result("I10", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "reference audit over commitments in the window; reproduction is Phase 11's replay sampling (§26.1)",
  });
}

/**
 * I11 — no `PRIMARY` Leg of a cancelled Task transitions into execution, **and** a cancelled
 * Task reaches `CANCELLED` only once every custodial Leg it spawned has settled.
 *
 * Stated over both clauses, because §26.1 is explicit that stating it over execution alone
 * "would forbid the recovery the design mandates".
 */
async function checkI11(deps) {
  const executionStates = ["EN_ROUTE_PICKUP", "AT_PICKUP", "LOADED", "EN_ROUTE_DROP", "AT_DROP"];

  const executing = await deps.prisma.leg.findMany({
    where: { purpose: "PRIMARY", cancelRequestedAt: { not: null }, state: { in: executionStates } },
    select: { legId: true, state: true, missionId: true },
  });

  const offending = executing.map((leg) => ({
    legId: leg.legId,
    state: leg.state,
    problem: "CANCELLED_PRIMARY_LEG_IN_EXECUTION",
  }));

  const cancelledTasks = await deps.prisma.task.findMany({
    where: { status: "CANCELLED" },
    select: { id: true, taskId: true },
  });

  for (const task of cancelledTasks) {
    // §2.8 draws `Task >──< Mission` as many-to-many, so the custodial Legs a cancelled
    // Task spawned are reached through its Missions rather than through a foreign key.
    // eslint-disable-next-line no-await-in-loop
    const unsettled = await deps.prisma.leg.findMany({
      where: {
        purpose: { in: ["RECOVERY", "TRANSFER"] },
        state: { notIn: [...TERMINAL_LEG_STATES] },
        mission: { tasks: { some: { id: task.id } } },
      },
      select: { legId: true, state: true, purpose: true },
    });
    for (const leg of unsettled) {
      offending.push({
        taskId: task.taskId,
        legId: leg.legId,
        state: leg.state,
        purpose: leg.purpose,
        problem: "TASK_CANCELLED_WITH_UNSETTLED_CUSTODIAL_LEG",
      });
    }
  }

  const { violations, violationCount } = bounded(offending);
  return result("I11", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "transition audit over PRIMARY Legs plus custody-discharge audit over RECOVERY/TRANSFER Legs (§26.1)",
  });
}

/**
 * I12 — a terminal state is never modified.
 *
 * Verified by write audit: a terminal Leg whose `updatedAt` moved after it settled has been
 * written to. `settledAt`/`updatedAt` is the only signal available without a trigger, and
 * it is a genuine one — the row was written.
 */
async function checkI12(deps, context) {
  const terminal = await deps.prisma.leg.findMany({
    where: {
      state: { in: [...TERMINAL_LEG_STATES] },
      updatedAt: { gte: new Date(context.windowStartMs), lt: new Date(context.nowMs) },
    },
    select: { legId: true, state: true, updatedAt: true, version: true },
  });

  const marks = context.terminalVersionMarks || new Map();
  const offending = [];
  const nextMarks = new Map();

  for (const leg of terminal) {
    const previous = marks.get(leg.legId);
    if (previous !== undefined && BigInt(leg.version) !== BigInt(previous)) {
      offending.push({
        legId: leg.legId,
        state: leg.state,
        versionWas: String(previous),
        versionNow: String(leg.version),
        problem: "TERMINAL_ROW_MODIFIED",
      });
    }
    nextMarks.set(leg.legId, String(leg.version));
  }

  const { violations, violationCount } = bounded(offending);
  return {
    ...result("I12", {
      status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
      violations,
      violationCount,
      instrument: "write audit on terminal rows, by version comparison across passes (§26.1)",
      // The comparison is only as wide as the marks carried in. Saying so is what stops a
      // reader taking `ENFORCED` from a pass that had nothing to compare against — which is
      // exactly what a checker whose caller drops the returned marks produces.
      detail:
        `${terminal.length} terminal rows touched in the window; ${marks.size} carried a version mark from ` +
        "a previous pass and were therefore comparable" +
        (marks.size === 0 && terminal.length > 0
          ? ". No mark was carried in, so this pass established the baseline rather than verifying it — a " +
            "modification is detectable from the next pass onward (§26.1's write audit is a comparison across passes)"
          : ""),
    }),
    terminalVersionMarks: nextMarks,
  };
}

/**
 * I13 — every queued mission is progressing through the escalation ladder or has a terminal
 * decision.
 *
 * §17.4's ladder is Phase 8's; this is the queue-age half of §26.1's "queue age audit versus
 * ladder step", which is checkable from the queue itself: an entry older than the ladder's
 * total budget with no recorded step has stopped progressing.
 */
async function checkI13(deps, context) {
  // "Past the ladder's total budget" is the age half of §26.1's instrument, and the budget is
  // §17.4's. Without it the original comparison degenerated to `enqueuedAt < now`, which makes
  // **every** unconsidered queue entry a violation the instant it is enqueued — a guaranteed
  // page on a healthy fleet, produced by a missing argument rather than by the fleet.
  //
  // An unresolved budget therefore splits the same two ways I5's missing baseline does: if no
  // entry is unconsidered at all, no entry can be past *any* budget and the invariant provably
  // holds; if some are, whether they are past budget is unknown and the check says so.
  if (!Number.isFinite(context.ladderBudgetSeconds) || context.ladderBudgetSeconds <= 0) {
    const unconsidered = await deps.prisma.workQueue.findMany({
      where: {
        state: { in: ["QUEUED", "DEFERRED"] },
        ...(context.shardId ? { shardId: context.shardId } : {}),
      },
      select: { legId: true, state: true, enqueuedAt: true, roundsConsidered: true },
    });
    const never = unconsidered.filter((row) => Number(row.roundsConsidered || 0) === 0);
    return result("I13", {
      status: never.length === 0 ? STATUS.ENFORCED : null,
      instrument: "queue age audit versus ladder step (§26.1)",
      checkError:
        never.length === 0
          ? null
          : "no §17.4 ladder budget was supplied (sla.assignment_deadline), so \"queued past the ladder's total " +
            `budget\" has no value to compare against. ${never.length} queue entr${never.length === 1 ? "y has" : "ies have"} ` +
            "not yet been considered by a round, which may be normal or may be starvation; without the budget " +
            "the two are indistinguishable, and treating the budget as zero would report every one of them as a " +
            "violation.",
      detail:
        `${unconsidered.length} queued or deferred entries, ${never.length} never considered by a round` +
        (never.length === 0 ? "; no entry can be past any budget, so the invariant holds regardless of its value." : "."),
    });
  }

  const stale = await deps.prisma.workQueue.findMany({
    where: {
      state: { in: ["QUEUED", "DEFERRED"] },
      enqueuedAt: { lt: new Date(context.nowMs - (context.ladderBudgetSeconds || 0) * MS_PER_SECOND) },
      ...(context.shardId ? { shardId: context.shardId } : {}),
    },
    select: { legId: true, state: true, enqueuedAt: true, roundsConsidered: true, consecutiveDeferrals: true },
  });

  // "Progressing through the escalation ladder" is read off the queue's own progress
  // counters: an entry past the ladder's total budget that no round has ever considered is
  // not on the ladder at all, which is I13's failure case. An entry that has been
  // considered and deferred is progressing — badly, but visibly, which is what §17.4's
  // ladder is for and what a queue-age SLI already reports.
  const offending = stale
    .filter((row) => Number(row.roundsConsidered || 0) === 0)
    .map((row) => ({
      legId: row.legId,
      state: row.state,
      enqueuedAt: row.enqueuedAt,
      roundsConsidered: Number(row.roundsConsidered || 0),
      problem: "QUEUED_PAST_LADDER_BUDGET_AND_NEVER_CONSIDERED",
    }));

  const { violations, violationCount } = bounded(offending);
  return result("I13", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "queue age audit versus ladder step (§26.1)",
    detail: context.ladderBudgetSeconds ? null : "no ladder budget supplied; every stale entry is reported",
  });
}

/**
 * I14 — cost is computed only for feasible pairings.
 *
 * §26.1: "Static analysis plus decision-record audit." The static half is the T1 build gate
 * (`guards/tenets.js`), which runs on every build and is not re-run here. The audit half is
 * this: a decision record carrying a cost for a candidate the gate rejected.
 */
async function checkI14(deps, context) {
  const records = await deps.prisma.decisionRecordA.findMany({
    where: {
      decisionTime: { gte: new Date(context.windowStartMs), lt: new Date(context.nowMs) },
      ...(context.shardId ? { shardId: context.shardId } : {}),
      ...(context.productionOnly || {}),
    },
    select: { decisionId: true, runnerUpAndTopN: true },
  });

  const offending = [];
  for (const record of records) {
    const rows = Array.isArray(record.runnerUpAndTopN) ? record.runnerUpAndTopN : [];
    for (const row of rows) {
      if (row && row.bindingPredicateId && row.gammaMilliCU !== undefined && row.gammaMilliCU !== null) {
        offending.push({
          decisionId: record.decisionId,
          agentId: row.agentId ?? null,
          bindingPredicateId: row.bindingPredicateId,
          problem: "COST_RECORDED_FOR_REJECTED_CANDIDATE",
        });
      }
    }
  }

  const { violations, violationCount } = bounded(offending);
  return result("I14", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "decision-record audit; the static half is the T1 build gate (§26.1)",
  });
}

/**
 * I15 — every parameter in use is resolvable to a published config version.
 */
async function checkI15(deps, context) {
  const records = await deps.prisma.decisionRecordA.findMany({
    where: {
      decisionTime: { gte: new Date(context.windowStartMs), lt: new Date(context.nowMs) },
      ...(context.shardId ? { shardId: context.shardId } : {}),
      ...(context.productionOnly || {}),
    },
    select: { decisionId: true, versions: true },
  });

  const offending = records
    .filter((record) => {
      const versions = record.versions || {};
      return versions.configVersion === undefined || versions.configVersion === null;
    })
    .map((record) => ({ decisionId: record.decisionId, problem: "NO_RESOLVED_CONFIG_VERSION" }));

  const { violations, violationCount } = bounded(offending);
  return result("I15", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "decision-record audit of the pinned config version (§26.1)",
  });
}

/**
 * I16 — cache loss cannot cause commitment loss, duplication, or double-granting.
 *
 * §26.1 verifies this by chaos test (§24.5), which is a build-time instrument rather than a
 * production one. What *is* checkable continuously, and is the production shadow of the same
 * property, is that the store's own exclusivity holds while the cache tier is unavailable —
 * which is I1's query restricted to the Cold Index window. Reporting it under I16 rather than
 * inventing a new claim is the honest framing: the invariant's real verification is the chaos
 * suite, and this is the continuous corroboration.
 */
async function checkI16(deps, context) {
  const duplicated = await deps.prisma.commitment.groupBy({
    by: ["legId"],
    where: { releasedAt: null },
    _count: { _all: true },
  });

  const offending = duplicated
    .filter((row) => Number(row._count._all || 0) > 1)
    .map((row) => ({ legId: row.legId, activeCommitments: Number(row._count._all), problem: "LEG_DOUBLE_GRANTED" }));

  const { violations, violationCount } = bounded(offending);
  return result("I16", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "continuous double-grant scan; the invariant's own verification is the §24.5 chaos test (§26.1)",
  });
}

/**
 * I17 — every energy-feasible commitment satisfies F34 at all three tier confidences, and
 * each tier's realised fleet-year event rate stays within its budget.
 *
 * > **I17 deserves note.** It is the only invariant verified *statistically* rather than
 * > structurally […] T3's budget is a handful of events per fleet-year, so it is **not**
 * > verified by counting occurrences — at that rate an event count carries no statistical
 * > power on any useful timescale — but by validating the predictive distribution's tail.
 *
 * So T1 and T2 are scored by event count against their budgets and **T3 is not scored here
 * at all**: its instrument is Phase 11's tail calibration, and this check says so rather
 * than producing a confident "0 observed, 0 expected" for a target it has no power to test.
 *
 * ── The two timescales are the specification's, and they are not the checker's window ──
 * §26.1 states the instrument per tier: "T1 by event count over **days**, T2 by event count
 * over **quarters**". The budgets in the register (`energy.event_budget_per_fleet_year`) are
 * **fleet-year** rates, so comparing them against a count taken over the checker's few-minute
 * monotonicity window compares a rate to a count and can never fire: 365 events per fleet-year
 * is 0.003 events per five minutes, and no integer count of events in five minutes exceeds
 * 365. Each tier is therefore counted over *its own* window and the annual budget is pro-rated
 * to it, which is what makes a breach expressible at all.
 *
 * @structural §26.1's own per-tier verification timescales — "T1 by event count over days, T2 by
 *   event count over quarters". A week and a quarter, transcribed from the specification rather
 *   than chosen: these are not a tuning knob whose value an operator may change, they are the
 *   instrument the register names, and a registered parameter here would invite exactly the
 *   re-timing that destroys the statistical power §26.1 spends a paragraph establishing.
 */
const TIER_WINDOW_DAYS = Object.freeze({ T1: 7, T2: 91 });

/** @structural days per year, for pro-rating a fleet-year budget to a window */
const DAYS_PER_YEAR = 365;

/** @structural milliseconds per day */
const MS_PER_DAY = 86400000;

const I17_INSTRUMENT =
  "T1 over days and T2 over quarters against a pro-rated fleet-year budget; T3 by predictive-tail " +
  "calibration (§21.5), not here (§26.1)";

async function checkI17(deps, context) {
  const budgets = context.tierEventBudgets || {};
  const missing = ["T1", "T2"].filter((tier) => !Number.isFinite(budgets[tier]));

  const offending = [];
  const observedByTier = {};

  for (const tier of ["T1", "T2"]) {
    const windowDays = TIER_WINDOW_DAYS[tier];
    const from = new Date(context.nowMs - windowDays * MS_PER_DAY);
    // eslint-disable-next-line no-await-in-loop
    const count = await deps.prisma.calibrationObservation.count({
      where: {
        predictor: "ENERGY_SHORTFALL",
        eventOccurred: true,
        tier,
        observedAt: { gte: from, lt: new Date(context.nowMs) },
      },
    });

    // I17 is "each tier's realised fleet-year event rate stays **within its budget**". With no
    // budget resolved there is normally no claim to test — except in the one case where the
    // answer does not depend on the budget's value: zero observed events are within every
    // non-negative budget, and `energy.event_budget_per_fleet_year` has `min: 0`. So a fleet
    // with no shortfall events is `ENFORCED` on the arithmetic, and a fleet *with* them and no
    // budget is unverified rather than assumed fine.
    if (!Number.isFinite(budgets[tier])) {
      observedByTier[tier] = { observed: count, windowDays, allowance: null, fleetYearBudget: null };
      continue;
    }

    // The fleet-year budget, pro-rated to this tier's own timescale. A fractional allowance is
    // kept fractional: rounding 0.35 events up to 1 would grant a whole event of slack a
    // budget of 4 per fleet-year does not have (T3's, which is why T3 is not scored this way
    // at all).
    const allowance = (budgets[tier] * windowDays) / DAYS_PER_YEAR;
    observedByTier[tier] = { observed: count, windowDays, allowance, fleetYearBudget: budgets[tier] };

    if (count > allowance) {
      offending.push({
        tier,
        observed: count,
        allowance,
        windowDays,
        fleetYearBudget: budgets[tier],
        problem: "REALISED_RATE_EXCEEDS_TIER_BUDGET",
      });
    }
  }

  // A tier whose budget is unresolved is unverifiable *unless* it observed nothing, in which
  // case the comparison's outcome is the same for every admissible budget.
  const unverifiable = missing.filter((tier) => (observedByTier[tier] || {}).observed > 0);

  const { violations, violationCount } = bounded(offending);
  const detail =
    `observed shortfall events per tier: ${JSON.stringify(observedByTier)}. T3 is deliberately not scored ` +
    "by an event count: validating a handful of events per fleet-year by counting occurrences is a category error." +
    (missing.length > 0
      ? ` No fleet-year budget was resolved for ${missing.join(", ")} (energy.event_budget_per_fleet_year).`
      : "");

  if (unverifiable.length > 0) {
    return result("I17", {
      status: null,
      instrument: I17_INSTRUMENT,
      checkError:
        `${unverifiable.join(" and ")} observed shortfall events and no fleet-year budget was resolved for ` +
        "them, so \"within its budget\" has nothing to compare against. Reporting ENFORCED would assert a " +
        "probabilistic claim on the strength of not having evaluated it.",
      detail,
    });
  }

  return result("I17", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: I17_INSTRUMENT,
    detail,
  });
}

/**
 * I18 — no SOFT reservation is ever persisted to the Commitment Store.
 *
 * The schema constraint admits HARD commitments only; this is §26.1's "periodic table
 * audit" beside it, because a constraint that was dropped by a migration would otherwise be
 * discovered by the shard-sizing derivation of §3.5 failing, months later.
 */
async function checkI18(deps) {
  const soft = await deps.prisma.commitment.findMany({
    where: { kind: { not: "HARD" } },
    select: { commitmentId: true, kind: true },
  });

  const offending = soft.map((row) => ({
    commitmentId: row.commitmentId,
    kind: row.kind,
    problem: "SOFT_RESERVATION_PERSISTED",
    detail: "a violation invalidates the shard-sizing derivation of §3.5 and is a page (§26.1)",
  }));

  const { violations, violationCount } = bounded(offending);
  return result("I18", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "periodic table audit beside the schema constraint (§26.1)",
  });
}

/**
 * I19 — commanding, reassigning, or settling one commitment never invalidates another
 * commitment on the same agent.
 *
 * §26.1's production instrument is "zero cross-commitment fence rejections". The check is
 * therefore for the *shape* that would produce one: two active commitments on one agent
 * whose mission fences share a value, which is what a mission-scope fence allocated from an
 * agent-level counter looks like in the table.
 */
async function checkI19(deps) {
  const active = await deps.prisma.commitment.findMany({
    where: { releasedAt: null },
    select: { commitmentId: true, agentId: true, fence: true },
  });

  const byAgent = new Map();
  for (const commitment of active) {
    const list = byAgent.get(commitment.agentId) || [];
    list.push(commitment);
    byAgent.set(commitment.agentId, list);
  }

  const offending = [];
  for (const [agentId, commitments] of byAgent) {
    // @structural one commitment cannot share a fence with itself; I19 is stated over pairs
    if (commitments.length < 2) continue;
    const seen = new Map();
    for (const commitment of commitments) {
      const fence = String(commitment.fence);
      if (seen.has(fence)) {
        offending.push({
          agentId,
          fence,
          commitmentIds: [seen.get(fence), commitment.commitmentId],
          problem: "SHARED_MISSION_FENCE_ACROSS_COMMITMENTS",
        });
      }
      seen.set(fence, commitment.commitmentId);
    }
  }

  const { violations, violationCount } = bounded(offending);
  return result("I19", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "per-agent fence-sharing scan; the production instrument is zero cross-commitment fence rejections (§26.1)",
  });
}

/**
 * I20 — every reported optimality gap is a true bound, and the two gaps are reported
 * separately.
 *
 * §26.1 puts I20's verification at build and publish time "because by the time a broken
 * bound is observable in production it has already been asserted". The continuous half it
 * does name is the decision-record audit: "no decision reports a combined or negative gap".
 */
async function checkI20(deps, context) {
  const records = await deps.prisma.decisionRecordA.findMany({
    where: {
      decisionTime: { gte: new Date(context.windowStartMs), lt: new Date(context.nowMs) },
      ...(context.shardId ? { shardId: context.shardId } : {}),
      ...(context.productionOnly || {}),
    },
    select: { decisionId: true, searchAndSolveBounds: true },
  });

  const offending = [];
  for (const record of records) {
    const bounds = record.searchAndSolveBounds || {};
    const search = bounds.searchGapMilliCU;
    const lpIp = bounds.lpIpGapMilliCU;

    if (bounds.combinedGapMilliCU !== undefined && bounds.combinedGapMilliCU !== null) {
      offending.push({ decisionId: record.decisionId, problem: "COMBINED_GAP_REPORTED" });
    }
    for (const [name, value] of [["searchGapMilliCU", search], ["lpIpGapMilliCU", lpIp]]) {
      if (value !== undefined && value !== null && BigInt(value) < 0n) {
        offending.push({ decisionId: record.decisionId, problem: "NEGATIVE_GAP_REPORTED", field: name, value: String(value) });
      }
    }
  }

  const { violations, violationCount } = bounded(offending);
  return result("I20", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "decision-record audit for combined or negative gaps; the bound itself is a build gate (§26.1)",
  });
}

/**
 * I21 — no command is applied twice by an agent, across restarts.
 *
 * §26.1's instruments are the `dedup_state_generation` advance rate and a duplicate-
 * application counter "which must be exactly zero". The durable shadow of the second is an
 * outbox row acknowledged more than once, and of the first is a generation that advanced
 * within the window — the latter is a *signal*, not a violation, so it is reported in the
 * detail rather than counted as one.
 */
async function checkI21(deps, context) {
  // The authoritative counter is agent-side: only the agent knows whether it *applied* a
  // command twice, and §11.5 makes its dedup state the thing that prevents it. The server's
  // durable record of such a report is the outbox row's `lastError`, which §11.3 forbids
  // discarding silently — so a duplicate application is visible here exactly because
  // nothing is allowed to swallow an agent-side rejection.
  const reported = await deps.prisma.outbox.findMany({
    where: { lastError: { contains: DUPLICATE_APPLICATION_MARK } },
    select: { idempotencyKey: true, agentId: true, command: true, lastError: true },
  });

  const offending = reported.map((row) => ({
    idempotencyKey: row.idempotencyKey,
    agentId: row.agentId,
    command: row.command,
    detail: row.lastError,
    problem: "COMMAND_APPLIED_MORE_THAN_ONCE",
  }));

  const advances = await deps.prisma.agentDedupState.count({
    where: { updatedAt: { gte: new Date(context.windowStartMs), lt: new Date(context.nowMs) } },
  });

  const { violations, violationCount } = bounded(offending);
  return result("I21", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "duplicate-application counter (must be exactly zero) beside the dedup-generation advance rate (§26.1)",
    detail:
      `${advances} dedup states advanced in the window — the §18.2 A20 signal, monitored rather than counted ` +
      "as a violation: a reset is a fact about the agent's storage, and the redelivery it would have caused " +
      "is what §11.5's handshake suppresses.",
  });
}

/**
 * The marker an agent-side duplicate-application report carries in `Outbox.lastError`.
 * @structural the agent protocol's own rejection code
 */
const DUPLICATE_APPLICATION_MARK = "DUPLICATE_APPLICATION";

/**
 * I22 — every `STRANDED_*` Leg carries an obstruction classification, and no obstructing
 * stranding is held in the ordinary operations queue.
 *
 * Both clauses. The second is checked as "an obstructing class in `STRANDED_SAFE`", which is
 * the state that would route it to the ordinary queue, and against the presence of an
 * `ExternalEscalation` chain for the ones correctly in `STRANDED_OBSTRUCTING` — §26.1's
 * "matching escalation path (§18.6)".
 */
async function checkI22(deps) {
  const stranded = await deps.prisma.leg.findMany({
    where: { state: { in: [...STRANDED_LEG_STATES] } },
    select: { id: true, legId: true, state: true, obstructionClass: true },
  });

  const offending = [];
  for (const leg of stranded) {
    if (!leg.obstructionClass) {
      offending.push({ legId: leg.legId, state: leg.state, problem: "STRANDED_LEG_WITH_NO_CLASSIFICATION" });
      continue;
    }
    const obstructing = OBSTRUCTING_CLASSES.includes(leg.obstructionClass);
    if (obstructing && leg.state !== "STRANDED_OBSTRUCTING") {
      offending.push({
        legId: leg.legId,
        state: leg.state,
        obstructionClass: leg.obstructionClass,
        problem: "OBSTRUCTING_STRANDING_HELD_IN_ORDINARY_QUEUE",
      });
      continue;
    }
    if (leg.state === "STRANDED_OBSTRUCTING") {
      // eslint-disable-next-line no-await-in-loop
      const chain = await deps.prisma.externalEscalation.findFirst({ where: { legId: leg.id } });
      if (!chain) {
        offending.push({
          legId: leg.legId,
          state: leg.state,
          obstructionClass: leg.obstructionClass,
          problem: "OBSTRUCTING_STRANDING_WITH_NO_ESCALATION_CHAIN",
        });
      }
    }
  }

  const { violations, violationCount } = bounded(offending);
  return result("I22", {
    status: violationCount === 0 ? STATUS.ENFORCED : STATUS.VIOLATED,
    violations,
    violationCount,
    instrument: "classification audit plus matching-escalation-path audit (§26.1, §18.6)",
  });
}

/**
 * The check table. Keyed by invariant id so the register and the implementations cannot
 * drift in count — `assertEveryInvariantIsChecked()` proves the join is total.
 */
const CHECKS = Object.freeze({
  I1: checkI1,
  I2: checkI2,
  I3: checkI3,
  I4: checkI4,
  I5: checkI5,
  I6: checkI6,
  I7: checkI7,
  I8: checkI8,
  I9: checkI9,
  I10: checkI10,
  I11: checkI11,
  I12: checkI12,
  I13: checkI13,
  I14: checkI14,
  I15: checkI15,
  I16: checkI16,
  I17: checkI17,
  I18: checkI18,
  I19: checkI19,
  I20: checkI20,
  I21: checkI21,
  I22: checkI22,
});

/* ═══════════════════════════════════════════════════════════════════════════
   The pass
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Run one invariant's check and resolve its status against §26.2.
 *
 * The order is deliberate: the check runs **first**, and the mode matrix is applied to its
 * result afterwards. Skipping the check because a mode suspends the invariant would mean
 * the register learned nothing during exactly the periods it most needs evidence from — and
 * §26.2's `D` cells are cells where the invariant is *still enforced*, only verified more
 * coarsely, so a checker that short-circuited on any non-`E` cell would silently stop
 * verifying eleven live guarantees.
 *
 * @param {string} invariantId
 * @param {object} deps `{ prisma }`
 * @param {object} context
 * @returns {Promise<object>}
 */
async function checkOne(invariantId, deps, context) {
  const check = CHECKS[invariantId];
  if (!check) {
    throw new TypeError(`"${String(invariantId)}" is not one of §26.1's twenty-two invariants`);
  }

  const activeModes = context.activeModes || [];
  const behaviour = modeRegister.resolveBehaviour(invariantId, activeModes);

  let raw;
  try {
    raw = await check(deps, context);
  } catch (error) {
    // A query that threw is a fact about the checker. Reporting ENFORCED here would produce
    // a green register from a broken query, which is strictly worse than no register.
    return result(invariantId, {
      status: null,
      checkError: (error && error.message) || String(error),
      instrument: "the check could not run; the previously stored status stands and the checker is unhealthy",
      authorisedBy: behaviour.authorisedBy,
    });
  }

  if (behaviour.status === modeRegister.BEHAVIOUR.SUSPENDED) {
    return {
      ...raw,
      status: STATUS.SUSPENDED,
      authorisedBy: behaviour.authorisedBy,
      // The findings are retained rather than discarded: a suspension means the *status* is
      // not a page, not that the observations are worthless. On mode exit they are exactly
      // the reconciliation input §18.5 requires.
      suspensionNote: behaviour.note,
      detail: raw.detail,
    };
  }

  return {
    ...raw,
    authorisedBy: behaviour.authorisedBy,
    // §26.2's `D`: enforced, verified at degraded latency or granularity, **with the
    // degradation recorded**. The status stays what the check found; the degradation is
    // recorded beside it, which is what "recorded" means.
    degradedVerification: behaviour.status === modeRegister.BEHAVIOUR.DEGRADED,
    degradationNote: behaviour.status === modeRegister.BEHAVIOUR.DEGRADED ? behaviour.note : null,
    vacuous: behaviour.vacuous === true,
    vacuousNote: behaviour.vacuous === true ? behaviour.note : null,
  };
}

/**
 * Run every check.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} context `{ shardId, nowMs, storeTime, windowStartMs, activeModes, … }`
 * @returns {Promise<{ shardId: string|null, checkedAtMs: number, results: object[], summary: object }>}
 */
async function checkAll(deps, context) {
  const settings = context || {};
  const results = [];

  for (const invariantId of modeRegister.INVARIANTS) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await checkOne(invariantId, deps, settings));
  }

  return {
    shardId: settings.shardId ?? null,
    checkedAtMs: settings.nowMs ?? null,
    activeModes: settings.activeModes || [],
    results,
    summary: summarise(results),
  };
}

/**
 * The register's own SLI (§21.4, §26.1): the violation count, whose target is exactly zero.
 *
 * `suspended` is counted separately and never folded into `violated`, because §26.1 makes
 * that distinction the whole reason the third status exists.
 *
 * @param {object[]} results
 * @returns {object}
 */
function summarise(results) {
  const rows = results || [];
  const byStatus = { ENFORCED: 0, VIOLATED: 0, SUSPENDED: 0 };
  let unchecked = 0;
  let totalViolations = 0;

  for (const row of rows) {
    if (row.status === null) {
      unchecked += 1;
      continue;
    }
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
    if (row.status === STATUS.VIOLATED) totalViolations += row.violationCount;
  }

  return {
    total: rows.length,
    ...byStatus,
    unchecked,
    // The §21.4 metric. Its target is exactly zero (§26.1).
    invariantViolations: totalViolations,
    violatedInvariants: rows.filter((row) => row.status === STATUS.VIOLATED).map((row) => row.invariantId),
    suspendedInvariants: rows
      .filter((row) => row.status === STATUS.SUSPENDED)
      .map((row) => ({ invariantId: row.invariantId, authorisedBy: row.authorisedBy })),
    // A checker that could not run some of its checks is not a healthy checker, and the
    // distinction between "nothing is wrong" and "we did not look" is the one this field
    // exists to preserve.
    checkerHealthy: unchecked === 0,
    pageWorthy: totalViolations > 0,
  };
}

/**
 * The dashboard-facing socket payload for a status change (plan row "Socket.IO changes").
 * @structural the wire event name
 */
const SOCKET_EVENT = "INVARIANT_STATUS_CHANGED";

/**
 * Which invariants changed status between two passes.
 *
 * Emitting on change rather than on every pass is what keeps the event stream meaningful:
 * a dashboard told twenty-two times a minute that everything is still fine learns nothing,
 * and the one transition that matters arrives in the same shape as the noise.
 *
 * @param {object[]} previous
 * @param {object[]} current
 * @returns {object[]}
 */
function statusChanges(previous, current) {
  const before = new Map((previous || []).map((row) => [row.invariantId, row.status]));
  const changes = [];

  for (const row of current || []) {
    const was = before.has(row.invariantId) ? before.get(row.invariantId) : null;
    if (was === row.status) continue;
    changes.push({
      event: SOCKET_EVENT,
      payload: {
        invariantId: row.invariantId,
        from: was,
        to: row.status,
        authorisedBy: row.authorisedBy ?? null,
        violationCount: row.violationCount,
        instrument: row.instrument,
      },
    });
  }

  return changes;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Assertions
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Every invariant in §26.1 has a check, and every check names an invariant in §26.1.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertEveryInvariantIsChecked() {
  const problems = [];
  for (const invariantId of modeRegister.INVARIANTS) {
    if (!CHECKS[invariantId]) problems.push(`${invariantId} has no check. §26.1: "Each is continuously verified by the Invariant Checker".`);
  }
  for (const invariantId of Object.keys(CHECKS)) {
    if (!modeRegister.INVARIANTS.includes(invariantId)) {
      problems.push(`${invariantId} is checked but is not one of §26.1's twenty-two`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The locally-transcribed state vocabulary agrees with the domain model.
 *
 * The checker declares its own copy so it does not inherit the enforcer's mistakes at
 * runtime (see the header). This assertion is the counterweight: independence at runtime,
 * drift detection at build time. It is the only place in this module that reaches for the
 * lifecycle vocabulary, and it runs in the test lane rather than on the check path.
 *
 * @param {object} domain `{ TERMINAL_LEG_STATES, RECOVERY_STATES, STRANDED_STATES }`
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertVocabularyAgreesWithDomain(domain) {
  const problems = [];
  const compare = (name, mine, theirs) => {
    const a = [...mine].sort().join(",");
    const b = [...(theirs || [])].sort().join(",");
    if (a !== b) problems.push(`${name}: the checker's [${a}] and the domain's [${b}] disagree`);
  };

  compare("TERMINAL_LEG_STATES", TERMINAL_LEG_STATES, domain && domain.TERMINAL_LEG_STATES);
  compare("RECOVERY_LEG_STATES", RECOVERY_LEG_STATES, domain && domain.RECOVERY_STATES);
  compare("STRANDED_LEG_STATES", STRANDED_LEG_STATES, domain && domain.STRANDED_STATES);

  return { ok: problems.length === 0, problems };
}

module.exports = {
  STATUS,
  CHECKS,
  SOCKET_EVENT,
  TIER_WINDOW_DAYS,
  TERMINAL_LEG_STATES,
  RECOVERY_LEG_STATES,
  STRANDED_LEG_STATES,
  OBSTRUCTING_CLASSES,
  TIMER_ENTITY_TYPES,
  MAX_REPORTED_VIOLATIONS,
  checkOne,
  checkAll,
  summarise,
  statusChanges,
  assertEveryInvariantIsChecked,
  assertVocabularyAgreesWithDomain,
};

"use strict";

/**
 * Lease renewal and expiry (§12.2) — the Supervisor's half of the lease that
 * `commitment/leases.js` grants.
 *
 * > Each HARD commitment holds a lease with expiry `now + lease.duration` (default 60
 * > s), renewed by the Supervisor while progress evidence continues to arrive.
 *
 * ── Renewal takes positive evidence, per commitment ─────────────────────────
 * > Renewal requires *positive evidence*: a heartbeat that includes the commitment id
 * > and its fence. A generic connectivity ping is insufficient — it proves the link, not
 * > the mission. Leases are **per commitment**, so an agent holding several commitments
 * > renews each one on its own evidence; a heartbeat naming one mission does not renew
 * > the lease of another.
 *
 * The predicate is Phase 3's `commitment/leases.isRenewalEvidenceSufficient`, stated
 * once there and *called* here. Restating it would produce two definitions of "positive
 * evidence" that could drift, and the drift would be invisible until an agent renewed
 * something it should not have.
 *
 * ── Never against a cached value ────────────────────────────────────────────
 * > **Leases are never renewed against a cached value.** Renewal is a durable write to
 * > the Commitment Store, which is the sole authority for lease validity (§3.3). When
 * > that store is unavailable, renewal does not fall back to a cached lease — it
 * > **stops**, the shard enters Custodial Operation, and invariant I2 is explicitly
 * > suspended for the duration.
 * >
 * > […] Continuing to supervise on a cached lease would mean treating the cache tier as
 * > the authority for a correctness-relevant fact, which the architecture prohibits, and
 * > it would provide no real protection in any case: a cached lease cannot be *revoked*,
 * > so it certifies only that the commitment was valid at some point in the past.
 *
 * This module imports no cache, and a test asserts it.
 *
 * ── Expiry does not abort ───────────────────────────────────────────────────
 * > Lease expiry does not itself abort the mission. It transitions the Leg to a recovery
 * > assessment whose outcome depends on custody (§4.7).
 *
 * `assessRecovery` is that assessment, and it is a pure function so it can be tested
 * exhaustively against §4.7's three lawful custody-`HELD` outcomes without a store.
 *
 * Tier 0 (T0-08). Invariants I2, I7, I8.
 */

const commitmentLeases = require("../commitment/leases");
const clock = require("../commitment/clock");
const custody = require("../domain/custody");
const legMachine = require("../lifecycle/legMachine");

/** What a renewal attempt produces. @structural outcome labels */
const RENEWAL_OUTCOME = Object.freeze({
  RENEWED: "RENEWED",
  REFUSED: "REFUSED",
  LOST_RACE: "LOST_RACE",
  NOT_RENEWABLE: "NOT_RENEWABLE",
  /**
   * PHASE 12 — §18.5 B1. The Commitment Store is unavailable, so renewal **stops**. It is
   * a distinct outcome from `REFUSED` (the evidence was insufficient) and from
   * `NOT_RENEWABLE` (the commitment is gone), because the operational response is
   * different in kind: those two are facts about one commitment, and this one is a fact
   * about the shard.
   */
  HALTED_STORE_UNAVAILABLE: "HALTED_STORE_UNAVAILABLE",
});

/**
 * §4.7's three lawful outcomes when custody is `HELD`, plus the custody-`NONE` case.
 * @structural the enumerated recovery dispositions of §4.7 and §12.2
 */
const RECOVERY_OUTCOME = Object.freeze({
  /** Custody NONE — a scheduling problem. §4.7's custody-NONE protocol. */
  REASSIGN: "REASSIGN",
  /** §4.7: "Incumbent recovers within `recover.resume_window` and remains feasible". */
  RESUME: "RESUME",
  /** §4.7: a receiving party exists that can physically take the goods. */
  TRANSFER: "TRANSFER",
  /** §4.7: "Incumbent unreachable, unsafe, or unable to release". */
  PHYSICAL_RECOVERY: "PHYSICAL_RECOVERY",
  /**
   * Custody `RELEASED` — the goods were delivered (§2.5: "Task complete pending
   * verification"). Nothing is reassigned and the Leg does not move: it waits in `RELEASED`
   * under §4.4's evidence-insufficient row and its own `VERIFICATION_ESCALATION` deadline.
   */
  AWAIT_VERIFICATION: "AWAIT_VERIFICATION",
});

/**
 * §12.2 — renew one commitment's lease on its own positive evidence.
 *
 * The write is conditional on the commitment's version, so a renewal racing a release or
 * an expiry recovery loses rather than resurrecting a commitment somebody else has
 * already recovered from. That case is not hypothetical: §12.4 states plainly that the
 * reconciler and the timer supervisor act on the same entity concurrently.
 *
 * @param {object} tx a Prisma transaction client
 * @param {object} input
 * @param {object} input.commitment the row, read by the caller
 * @param {{ commitmentId: string, fence: bigint|number|string }} input.evidence
 * @param {Date} input.storeTime the Commitment Store's clock (§10.6)
 * @param {number} input.leaseDurationSeconds `lease.duration`
 * @returns {Promise<object>}
 */
async function renew(tx, input) {
  const source = input || {};
  const commitment = source.commitment;

  // PHASE 12 — §18.5 / §18.3 B1, enforced rather than described.
  //
  // The module header has always stated that renewal "stops" when the store is
  // unavailable rather than falling back to a cached lease. Until Phase 12 that was a
  // property of what this module *imports* — no cache — which is a real guarantee against
  // one mistake (reading a cached lease) and no guarantee at all against another: a caller
  // that kept renewing against a store it already knew was unreachable would produce a
  // stream of failed writes and, worse, would leave the shard supervising on the belief
  // that renewal was still happening. `storeAvailable === false` is the caller stating
  // what it knows, and this refusal is what turns that knowledge into a stop.
  //
  // Only an explicit `false` halts. An absent flag means the caller has no health signal,
  // and in that case the correct behaviour is to attempt the write and let it fail on its
  // own evidence — refusing on an unknown would convert a missing argument into a shard
  // that stops supervising.
  if (source.storeAvailable === false) {
    return {
      outcome: RENEWAL_OUTCOME.HALTED_STORE_UNAVAILABLE,
      reason: "COMMITMENT_STORE_UNAVAILABLE",
      detail:
        "§12.2: leases are never renewed against a cached value. The durable store is the sole authority " +
        "for lease validity (§3.3), and when it is unavailable renewal stops — it does not fall back. " +
        "A cached lease cannot be revoked, so it certifies only that the commitment was valid at some " +
        "point in the past.",
      leaseExpiry: null,
      // Named, not entered: `degraded/transitions.js` owns entry, and entering a mode from
      // inside a per-commitment renewal would enter it once per commitment.
      directive: custodialDirective(),
    };
  }

  if (!commitment) {
    return { outcome: RENEWAL_OUTCOME.NOT_RENEWABLE, reason: "NO_COMMITMENT", leaseExpiry: null };
  }
  if (commitment.releasedAt !== null && commitment.releasedAt !== undefined) {
    return { outcome: RENEWAL_OUTCOME.NOT_RENEWABLE, reason: "COMMITMENT_RELEASED", leaseExpiry: null };
  }

  // §12.2's evidence rule — the whole reason renewal is not a ping handler.
  const sufficient = commitmentLeases.isRenewalEvidenceSufficient(commitment, source.evidence);
  if (!sufficient.sufficient) {
    return {
      outcome: RENEWAL_OUTCOME.REFUSED,
      reason: sufficient.reason,
      detail:
        "§12.2 requires a heartbeat that includes the commitment id and its fence. A generic connectivity ping " +
        "proves the link, not the mission.",
      leaseExpiry: null,
    };
  }

  const granted = commitmentLeases.grant({
    storeTime: source.storeTime,
    leaseDurationSeconds: source.leaseDurationSeconds,
  });

  const written = await tx.commitment.updateMany({
    where: { commitmentId: commitment.commitmentId, version: commitment.version, releasedAt: null },
    data: { leaseExpiry: granted.expiresAt, version: commitment.version + 1 },
  });

  if (written.count !== 1) {
    return {
      outcome: RENEWAL_OUTCOME.LOST_RACE,
      reason: "COMMITMENT_VERSION_MOVED",
      detail: "a concurrent release or recovery moved this commitment first",
      leaseExpiry: null,
    };
  }

  return { outcome: RENEWAL_OUTCOME.RENEWED, reason: null, leaseExpiry: granted.expiresAt };
}

/**
 * PHASE 12 — the §18.5 Custodial Operation directive, in the shape
 * `degraded/transitions.enter()` consumes.
 *
 * Named here and entered there, which is the discipline `dispatch/escalation.js` and
 * `supervision/timers.js` already apply to their own modes: a component that entered a mode
 * would be a second mode register, and this one would enter it once per commitment renewed.
 *
 * The three fields are what §18.5 makes non-negotiable about this mode. `noCommands` is the
 * one most easily lost in translation — the natural reading of "the database is down" is
 * "stop writing", and the specification's reading is "stop *commanding*", because command
 * authority is a fence and a fence that cannot be advanced durably is not a fence.
 *
 * @returns {object}
 */
function custodialDirective() {
  return Object.freeze({
    alert: "COMMITMENT_STORE_UNAVAILABLE",
    enterDegradedMode: "CUSTODIAL_OPERATION",
    suspendsInvariant: "I2",
    noCommits: true,
    noCommands: true,
    // §18.5: the safety property that replaces server-side supervision, enforced on the
    // agent and therefore unaffected by the outage that caused this.
    agentAutonomyLimitParameter: "agent.autonomous_continuation_limit",
    ownedBy: "Phase 12 — degraded/modeRegister.js",
  });
}

/**
 * The commitments whose lease has passed and which are still active.
 *
 * Judged against the store's clock, never a worker's (§10.6).
 *
 * @param {object} prisma
 * @param {object} input
 * @param {Date} input.storeTime
 * @param {number} input.limit
 * @returns {Promise<object[]>}
 */
async function findExpired(prisma, input) {
  const source = input || {};
  return prisma.commitment.findMany({
    where: { releasedAt: null, leaseExpiry: { lte: source.storeTime } },
    orderBy: { leaseExpiry: "asc" },
    take: source.limit || DEFAULT_BATCH,
  });
}

/**
 * §12.2 / §4.7 — the custody-aware recovery assessment an expired lease triggers.
 *
 * > **Protocol, custody `HELD`:** the goods are physically inside the incumbent. There
 * > are exactly three lawful outcomes, and the engine MUST choose explicitly rather than
 * > defaulting.
 *
 * "Rather than defaulting" is why this returns a named outcome with its reason and never
 * falls through: an unhandled combination returns `PHYSICAL_RECOVERY`, which is the
 * conservative one, and says so.
 *
 * The `TRANSFER` outcome is gated exactly as §4.7 gates it:
 *
 * > Where no `custody_transfer_capable` agent class is deployed, this outcome is
 * > human-mediated by default and the engine MUST NOT select an agent-to-agent transfer.
 *
 * so `transferCapableReceiverAvailable` must be *positively* true. Unknown is not
 * permission — the same asymmetry §23.5 applies to self-reported health, applied to the
 * existence of a receiving party.
 *
 * @param {object} input
 * @param {object} input.leg
 * @param {string} [input.custodyState] defaults to the Leg's
 * @param {boolean} [input.agentReachable]
 * @param {boolean} [input.withinResumeWindow]
 * @param {boolean} [input.stillFeasible]
 * @param {boolean} [input.ableToReleaseCustody]
 * @param {boolean} [input.transferCapableReceiverAvailable]
 * @param {string} [input.obstructionClass]
 * @returns {{ outcome: string, legState: string, reason: string, obstructionClass: string|null, externalEscalation: boolean }}
 */
function assessRecovery(input) {
  const source = input || {};
  const leg = source.leg || {};
  const custodyState = source.custodyState || leg.custodyState || custody.CUSTODY_STATES.NONE.name;

  // Custody RELEASED: the goods were delivered and the release was recorded. A lease that
  // lapses afterwards is the agent having finished, not a scheduling problem, so it must not
  // take the custody-NONE path below: `holdsGoods` is false here too, and reassigning would
  // dispatch a second delivery of goods that are already at the drop (measured in the V1
  // final E2E, F-1: verification INSUFFICIENT after a telemetry gap, lease expired, Leg
  // reassigned, delivered twice). The Leg stays where it is, awaiting verification — §4.4's
  // `RELEASED | evidence insufficient` row and `VERIFICATION_ESCALATION` own it from here,
  // and the commitment is released only by settlement.
  if (custodyState === custody.CUSTODY_STATES.RELEASED.name) {
    return {
      outcome: RECOVERY_OUTCOME.AWAIT_VERIFICATION,
      legState: typeof leg.state === "string" && leg.state !== "" ? leg.state : legMachine.LEG_STATE.RELEASED,
      reason: "CUSTODY_RELEASED_AWAITING_VERIFICATION",
      obstructionClass: null,
      externalEscalation: false,
    };
  }

  // Custody NONE: "a failure before custody is a scheduling problem" (§2.5). The Leg is
  // reassigned through §4.7's custody-NONE protocol. `holdsGoods` answers **true** for
  // `DISPUTED`, deliberately, so a contested custody takes the physical-recovery path
  // rather than being reassigned as though the agent were empty.
  if (!custody.holdsGoods(custodyState)) {
    return {
      outcome: RECOVERY_OUTCOME.REASSIGN,
      legState: legMachine.LEG_STATE.REASSIGNING,
      reason: "CUSTODY_NONE",
      obstructionClass: null,
      externalEscalation: false,
    };
  }

  // Outcome 1 — Resume. "Incumbent recovers within `recover.resume_window` and remains
  // feasible."
  if (source.agentReachable === true && source.withinResumeWindow === true && source.stillFeasible === true) {
    return {
      outcome: RECOVERY_OUTCOME.RESUME,
      legState: leg.state,
      reason: "INCUMBENT_RECOVERED_WITHIN_RESUME_WINDOW",
      obstructionClass: null,
      externalEscalation: false,
    };
  }

  // Outcome 2 — Transfer. "Incumbent immobile or infeasible, but reachable and able to
  // release custody, **and** a receiving party exists that can physically take the goods."
  if (
    source.agentReachable === true &&
    source.ableToReleaseCustody === true &&
    source.transferCapableReceiverAvailable === true
  ) {
    return {
      outcome: RECOVERY_OUTCOME.TRANSFER,
      legState: legMachine.LEG_STATE.REASSIGNING,
      reason: "TRANSFER_MISSION_REQUIRED",
      obstructionClass: null,
      externalEscalation: false,
    };
  }

  // Outcome 3 — Physical recovery. Also the explicit default, which §4.7 requires be a
  // choice rather than a fall-through, so it names itself.
  const stranding = legMachine.strandingStateFor(source.obstructionClass);
  return {
    outcome: RECOVERY_OUTCOME.PHYSICAL_RECOVERY,
    legState: stranding.state,
    reason:
      source.agentReachable === true
        ? "INCUMBENT_UNABLE_TO_RELEASE_OR_NO_RECEIVER"
        : "INCUMBENT_UNREACHABLE_WITH_CUSTODY_HELD",
    obstructionClass: stranding.obstructionClass,
    externalEscalation: stranding.externalEscalation,
  };
}

/**
 * §26 invariant I2, as a query: every active commitment has a valid lease or is in a
 * recovery state.
 *
 * Returns the violations rather than a boolean, because "which commitments" is the
 * actionable part and because the Phase 12 invariant checker consumes the list.
 *
 * @param {object} prisma
 * @param {Date} storeTime
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
async function auditI2(prisma, storeTime, limit) {
  const expired = await findExpired(prisma, { storeTime, limit: limit || DEFAULT_BATCH });
  const violations = [];

  for (const commitment of expired) {
    const leg = await prisma.leg.findUnique({ where: { id: commitment.legId } });
    // A commitment whose Leg is already in a recovery state is not a violation: I2 reads
    // "has a valid lease **or is in a recovery state**", and the recovery is what the
    // expiry was supposed to produce.
    if (leg && RECOVERY_STATES.includes(leg.state)) continue;
    violations.push({
      commitmentId: commitment.commitmentId,
      agentId: commitment.agentId,
      legId: commitment.legId,
      leaseExpiry: commitment.leaseExpiry,
      legState: leg ? leg.state : null,
    });
  }

  return violations;
}

/**
 * The §4.3 states that count as "in a recovery state" for I2.
 * @structural the recovery partition of §4.3, as invariant I2 reads it
 */
const RECOVERY_STATES = Object.freeze([
  legMachine.LEG_STATE.ABORTING,
  legMachine.LEG_STATE.REASSIGNING,
  legMachine.LEG_STATE.STRANDED_SAFE,
  legMachine.LEG_STATE.STRANDED_OBSTRUCTING,
]);

/** @structural the sweep's batch size; a work-partitioning constant */
const DEFAULT_BATCH = 200;

module.exports = {
  RENEWAL_OUTCOME,
  RECOVERY_OUTCOME,
  RECOVERY_STATES,
  custodialDirective,
  renew,
  findExpired,
  assessRecovery,
  auditI2,
  isValidAt: commitmentLeases.isValidAt,
  deadlineFrom: clock.deadlineFrom,
};

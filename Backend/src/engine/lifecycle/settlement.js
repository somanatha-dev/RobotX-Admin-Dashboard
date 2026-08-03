"use strict";

/**
 * Settlement (§4.9) — and the ordering rule that makes it a Tier 0 mechanism.
 *
 * > `SETTLED` is separate from "delivered" because several things MUST happen after
 * > physical completion and MUST not be skipped when a later step fails:
 * >
 * > 1. Verification evidence evaluated and archived (§12.5).
 * > 2. Custody closed; payload manifest reconciled to zero.
 * > 3. Commitment released; its fence retired; capacity returned to the pool. **The
 * >    agent's `authority_epoch` is not touched.**
 * > 4. Accounting written: distance, energy, cycles, duty-cycle contribution, wear
 * >    amortisation.
 * > 5. Realised-versus-predicted deltas emitted for ETA, energy, and dwell calibration.
 * > 6. Reliability counters updated with the attributed outcome.
 * > 7. SLA outcome recorded against the Task's contract.
 * >
 * > Settlement is idempotent and retried until complete. An agent MUST NOT be returned
 * > to the available pool before step 3, and **step 3 MUST NOT occur before step 2** —
 * > releasing an agent that still holds goods is a correctness violation (§26 invariant
 * > I7).
 *
 * ── The ordering is enforced, not documented ────────────────────────────────
 * I7 is one of the two invariants §26 marks for a *highest-severity* alert. The way it
 * fails in practice is not that somebody writes the steps backwards; it is that step 2
 * silently does nothing — an empty manifest query returning zero rows because the
 * manifest was never created — and step 3 then proceeds against a custody state nobody
 * checked. So `settle` **reads the manifest and the custody state and refuses** rather
 * than trusting that step 2 ran, and the refusal names I7.
 *
 * ── Steps 4 to 7 are seams, and they are named ──────────────────────────────
 * Accounting (§21), calibration deltas (§21.5), reliability attribution (§16.3), and the
 * SLA outcome all belong to phases that have not landed. They are collected here into a
 * `pending` list on the result rather than silently skipped, because §4.9's "MUST not be
 * skipped when a later step fails" is a statement about *this* function's contract: it
 * reports what it has not yet done, so a caller cannot mistake a partial settlement for
 * a complete one.
 *
 * Tier 0 (T0-07). Invariants I7, I8, I12, I19.
 */

const custody = require("../domain/custody");
const legMachine = require("./legMachine");
const timers = require("../supervision/timers");

/** @structural outcome labels */
const OUTCOME = Object.freeze({
  SETTLED: "SETTLED",
  ALREADY_SETTLED: "ALREADY_SETTLED",
  REFUSED: "REFUSED",
  LOST_RACE: "LOST_RACE",
});

/**
 * The §4.9 steps this phase performs, and the ones it records as outstanding.
 * @structural the §4.9 step list
 */
const STEP = Object.freeze({
  VERIFICATION_ARCHIVED: "VERIFICATION_ARCHIVED",
  CUSTODY_CLOSED: "CUSTODY_CLOSED",
  COMMITMENT_RELEASED: "COMMITMENT_RELEASED",
  ACCOUNTING_WRITTEN: "ACCOUNTING_WRITTEN",
  CALIBRATION_DELTAS_EMITTED: "CALIBRATION_DELTAS_EMITTED",
  RELIABILITY_UPDATED: "RELIABILITY_UPDATED",
  SLA_OUTCOME_RECORDED: "SLA_OUTCOME_RECORDED",
});

/**
 * Steps 4–7, whose owners are later phases. Named rather than omitted.
 * @structural the §4.9 steps owned by later phases
 */
const DEFERRED_STEPS = Object.freeze({
  [STEP.ACCOUNTING_WRITTEN]: "Phase 11 — observability/decisionRecord.js and the accounting sink",
  [STEP.CALIBRATION_DELTAS_EMITTED]: "Phase 11 — §21.5 prediction calibration",
  [STEP.RELIABILITY_UPDATED]: "Phase 16 (T2-09) — reliability/, with cohort priors until then",
  [STEP.SLA_OUTCOME_RECORDED]: "Phase 11 — the Task's contract outcome",
});

/**
 * §4.9 step 2's precondition, as a checkable predicate.
 *
 * Invariant I7 reads *"An agent with a non-empty payload manifest is never returned to
 * the available pool"*, so the question is about the **manifest**, not only about the
 * custody enum. Both are checked: a custody state of `RELEASED` with an open manifest is
 * exactly the disagreement I7 exists to catch, and trusting either one alone would make
 * the other decorative.
 *
 * @param {object} input
 * @param {string} input.custodyState
 * @param {Array<{ state: string }>} input.manifests
 * @returns {{ ok: boolean, reason: string|null, detail: string|null }}
 */
function assertCustodyDischarged(input) {
  const source = input || {};
  const state = source.custodyState;
  const manifests = Array.isArray(source.manifests) ? source.manifests : [];

  if (!custody.isCustodyState(state)) {
    // §4.1 rule 3 — an unreadable custody state is not a discharged one.
    return {
      ok: false,
      reason: "CUSTODY_STATE_UNKNOWN",
      detail: `custody state ${String(state)} is not one of §2.5's; absence is not discharge (§4.1 rule 3)`,
    };
  }

  // Checked before `holdsGoods`, which answers **true** for `DISPUTED` — deliberately,
  // because the evidence conflicts and not knowing resolves to the conservative case.
  // Reporting it as "still held" would be true but would send an operator looking for
  // goods aboard rather than for a contested handover, and they are different jobs.
  if (state === "DISPUTED") {
    return {
      ok: false,
      reason: "CUSTODY_DISPUTED",
      detail:
        "a disputed custody state is not a discharged one. Settling it would record an accounting outcome for " +
        "goods whose location is contested (§2.5, invariant I8).",
    };
  }

  if (custody.holdsGoods(state)) {
    return {
      ok: false,
      reason: "CUSTODY_STILL_HELD",
      detail:
        `custody is ${String(state)}. §4.9 step 3 MUST NOT occur before step 2 — releasing an agent that still ` +
        "holds goods is a correctness violation (invariant I7, highest-severity alert).",
    };
  }

  const open = manifests.filter((manifest) => manifest.state !== "CLOSED");
  if (open.length > 0) {
    return {
      ok: false,
      reason: "MANIFEST_NOT_RECONCILED",
      detail:
        `${open.length} payload manifest(s) are still open. §4.9 step 2 requires the manifest reconciled to zero, ` +
        "and invariant I7 is stated over the manifest rather than over the custody flag precisely so that a " +
        "flag flipped without the goods being accounted for does not satisfy it.",
    };
  }

  return { ok: true, reason: null, detail: null };
}

/**
 * Settle one Leg and its commitment.
 *
 * Idempotent: a Leg already `SETTLED` returns `ALREADY_SETTLED` rather than releasing a
 * second time. §4.9 says settlement "is idempotent and retried until complete", so the
 * retry must be a no-op and not a second release.
 *
 * @param {object} tx a Prisma transaction client
 * @param {object} input
 * @param {object} input.leg the Leg row, read under lock by the caller
 * @param {object|null} input.commitment the active commitment, if any
 * @param {Array<object>} [input.manifests] the Leg's payload manifests
 * @param {object} [input.verification] the §12.5 result, already archived
 * @param {Date} input.storeTime
 * @param {string} [input.shardId]
 * @returns {Promise<object>}
 */
async function settle(tx, input) {
  const source = input || {};
  const leg = source.leg;
  const storeTime = source.storeTime;

  if (!leg) return refuse("NO_LEG", "settlement names the Leg it settles");

  if (leg.state === legMachine.LEG_STATE.SETTLED) {
    return {
      outcome: OUTCOME.ALREADY_SETTLED,
      reason: null,
      detail: "settlement is idempotent and retried until complete (§4.9)",
      steps: [],
      pending: [],
    };
  }

  // §12.12's I12 — a terminal state is never modified. Settling a Leg that terminated
  // some other way would be exactly that write.
  if (legMachine.isTerminal(leg.state)) {
    return refuse(
      "LEG_ALREADY_TERMINAL",
      `the Leg is ${leg.state}; a terminal state is never modified (invariant I12)`,
    );
  }

  // Step 1 — verification evidence evaluated and archived. The evaluation is
  // `supervision/verification.js`; what settlement requires is that it *happened* and
  // was sufficient. An absent verification is not a pass (§4.1 rule 3).
  if (!source.verification || source.verification.outcome !== "SUFFICIENT") {
    return refuse(
      "VERIFICATION_NOT_SUFFICIENT",
      "§4.9 step 1 — settlement follows archived, sufficient verification evidence (§12.5). Insufficient evidence " +
        "sends the Task to VERIFYING with an operator queue, which is neither COMPLETED nor FAILED because both " +
        "of those would be lies about the physical state.",
    );
  }

  // Step 2 — custody closed, manifest reconciled to zero. Checked, not assumed.
  const discharged = assertCustodyDischarged({
    custodyState: leg.custodyState,
    manifests: source.manifests,
  });
  if (!discharged.ok) return refuse(discharged.reason, discharged.detail);

  const steps = [STEP.VERIFICATION_ARCHIVED, STEP.CUSTODY_CLOSED];

  // The Leg's own transition, conditional on its version (§4.1 rule 2).
  const written = await tx.leg.updateMany({
    where: { id: leg.id, version: leg.version },
    data: { state: legMachine.LEG_STATE.SETTLED, version: leg.version + 1 },
  });
  if (written.count !== 1) {
    return {
      outcome: OUTCOME.LOST_RACE,
      reason: "LEG_VERSION_MOVED",
      detail: "another writer moved this Leg first",
      steps: [],
      pending: [],
    };
  }

  // Step 3 — release the commitment, retire its fence, return capacity. Strictly after
  // step 2, which is the ordering I7 is stated over.
  //
  // `releasedAt` is what the §10.3.2 partial unique index is predicated on, so the
  // capacity slot becomes free **at the database** rather than in the application's
  // opinion of its own state. The agent's `authority_epoch` is untouched: §4.9 step 3
  // says so explicitly, and advancing it would invalidate the fences of every other
  // commitment the agent is concurrently executing (invariant I19).
  if (source.commitment && (source.commitment.releasedAt === null || source.commitment.releasedAt === undefined)) {
    await tx.commitment.update({
      where: { commitmentId: source.commitment.commitmentId },
      data: { releasedAt: storeTime, custodyState: leg.custodyState, version: source.commitment.version + 1 },
    });
    steps.push(STEP.COMMITMENT_RELEASED);
  }

  // §4.5 — the terminal state has no deadline, so every pending timer for this Leg is
  // cancelled with the exit.
  const cancelled = await timers.cancelFor(tx, {
    entityType: timers.ENTITY_TYPE.LEG,
    entityId: leg.id,
    storeTime,
    reason: "SETTLED",
  });

  return {
    outcome: OUTCOME.SETTLED,
    reason: null,
    detail: null,
    steps,
    timersCancelled: cancelled,
    // §4.9's "MUST not be skipped when a later step fails", made visible: a caller
    // cannot mistake this for a complete settlement.
    pending: Object.entries(DEFERRED_STEPS).map(([step, ownedBy]) => ({ step, ownedBy })),
    authorityEpochTouched: false,
  };
}

function refuse(reason, detail) {
  return { outcome: OUTCOME.REFUSED, reason, detail, steps: [], pending: [] };
}

/**
 * Invariant I7, as a query: is any agent holding an open manifest while being available?
 *
 * The Phase 12 invariant checker consumes this. It is here rather than there because the
 * definition of "discharged" must have exactly one home, and this module is where
 * settlement enforces it.
 *
 * @param {object} prisma
 * @param {number} [limit]
 * @returns {Promise<object[]>}
 */
async function auditI7(prisma, limit) {
  const openManifests = await prisma.payloadManifest.findMany({
    where: { state: { not: "CLOSED" } },
    take: limit || DEFAULT_AUDIT_LIMIT,
  });

  const violations = [];
  for (const manifest of openManifests) {
    if (!manifest.legId) continue;
    const leg = await prisma.leg.findUnique({ where: { id: manifest.legId } });
    if (!leg) continue;
    // A non-terminal Leg with an open manifest is the normal case — the goods are aboard
    // and the mission is running. The violation is a *terminal* Leg with goods still on
    // the books, because that is an agent back in the pool with a non-empty manifest.
    if (!legMachine.isTerminal(leg.state)) continue;
    violations.push({
      manifestId: manifest.manifestId,
      legId: leg.id,
      legState: leg.state,
      custodyState: leg.custodyState,
    });
  }

  return violations;
}

/** @structural the audit's batch size; a work-partitioning constant */
const DEFAULT_AUDIT_LIMIT = 200;

module.exports = {
  OUTCOME,
  STEP,
  DEFERRED_STEPS,
  assertCustodyDischarged,
  settle,
  auditI7,
};

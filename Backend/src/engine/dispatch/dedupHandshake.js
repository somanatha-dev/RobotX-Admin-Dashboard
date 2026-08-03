"use strict";

/**
 * Durable agent-side deduplication, and the session-establishment handshake (§11.5).
 *
 * > At-least-once delivery combined with **non-durable** deduplication state is not
 * > exactly-once in practice, whatever the protocol intends. A robot that
 * > power-cycles — which happens routinely, including as a deliberate fault-recovery
 * > action (§18.2 A5) and on every scheduled firmware update — would lose an in-memory
 * > dedup table and then re-execute a redelivered offer or command it had already
 * > processed before the restart.
 *
 * The agent holds the state; this module holds the server's half of the handshake:
 * comparing what the agent reports against the Commitment Store and choosing one of
 * §11.5's three paths.
 *
 * | Server observation | Interpretation | Action |
 * |---|---|---|
 * | Generation unchanged, marks consistent with the store | Normal reconnect | Resume; redeliver only unapplied commands |
 * | Generation unchanged, marks *behind* the store | Commands lost in flight, not applied | Redeliver from the agent's high-water mark |
 * | **Generation advanced, or state absent** | **The dedup state was reset** | **Suppress redelivery entirely**; advance `authority_epoch`; reconcile physical and custody state; re-offer fresh work under new commitment ids and fences |
 *
 * ── Why the third path reuses the agent-scope fence ─────────────────────────
 * > A dedup reset is exactly the condition the agent-scope fence was designed for: the
 * > question "which of my prior authorities does this agent still correctly honour?"
 * > has become unanswerable, and the correct response is to invalidate all of them at
 * > once and start from a known state. Redelivering into an agent whose dedup table is
 * > empty is the one action guaranteed to cause the double execution the protocol
 * > forbids.
 *
 * ── Custody first, always ───────────────────────────────────────────────────
 * > A reset agent may be carrying goods it can no longer account for against a
 * > commitment id the server has retired. The custody audit of §12.4 runs first, and an
 * > agent with an unreconciled non-empty manifest is not returned to the available pool
 * > (invariant I7) regardless of how healthy it reports itself to be.
 *
 * The audit itself is Phase 5's reconciler. What Phase 4 owes is the *hold*: the
 * classification reports `custodyReconciliationRequired`, and no re-offer may be built
 * for an agent under that hold. That obligation is expressed here as a predicate the
 * round (Phase 10) must consult, in the same style as Phase 3's `volatileRecheck`
 * seam — a requirement stated where it is discovered rather than left to be
 * rediscovered by whoever writes the round.
 *
 * Tier 0 (T0-06). Invariants I5, I7, I19, I21.
 */

const custody = require("../domain/custody");
const fencing = require("../commitment/fencing");
const outbox = require("./outbox");

/** §11.5's three paths, plus the one the table does not cover. @structural path labels */
const DEDUP_PATH = Object.freeze({
  /** Row 1 — normal reconnect. */
  RESUME: "RESUME",
  /** Row 2 — the agent is behind the store; redeliver from its mark. */
  REDELIVER_FROM_MARK: "REDELIVER_FROM_MARK",
  /** Row 3 — reset. Suppress, re-fence, reconcile. */
  SUPPRESS_AND_REFENCE: "SUPPRESS_AND_REFENCE",
  /**
   * Not a row of §11.5's table: an agent the server has never handshaken with, which
   * holds no commitments. See `classify` for why this is not row 3.
   */
  FIRST_CONTACT: "FIRST_CONTACT",
});

/**
 * Validate the shape an agent reports at AUTH.
 *
 * > On every session establishment the agent reports its **deduplication high-water
 * > mark**: `dedup_state_generation`, `authority_epoch`, `fence_floor`, and the
 * > per-commitment high-water pairs for every commitment it believes it holds.
 *
 * A malformed report is **not** treated as an absent one. Absence means "this agent
 * does not speak the protocol", which is the legacy path; malformation means "this
 * agent speaks it and got it wrong", which is a defect to surface rather than a
 * condition to degrade around (T2: unknown is never permission).
 *
 * @param {unknown} reported
 * @returns {{ ok: boolean, reason: string|null, value: object|null }}
 */
function parseReport(reported) {
  if (reported === undefined || reported === null) {
    return { ok: false, reason: "NO_DEDUP_REPORT", value: null };
  }
  if (typeof reported !== "object") {
    return { ok: false, reason: "DEDUP_REPORT_MALFORMED", value: null };
  }

  const generation = reported.dedupStateGeneration;
  if (generation === undefined || generation === null) {
    return { ok: false, reason: "DEDUP_REPORT_WITHOUT_GENERATION", value: null };
  }

  let parsed;
  try {
    parsed = {
      dedupStateGeneration: BigInt(generation),
      authorityEpoch: BigInt(reported.authorityEpoch === undefined || reported.authorityEpoch === null ? 0 : reported.authorityEpoch),
      fenceFloor: BigInt(reported.fenceFloor === undefined || reported.fenceFloor === null ? 0 : reported.fenceFloor),
      marks: normaliseMarks(reported.highWaterMarks),
    };
  } catch {
    return { ok: false, reason: "DEDUP_REPORT_COUNTERS_NOT_INTEGRAL", value: null };
  }

  if (parsed.dedupStateGeneration < BigInt(0) || parsed.authorityEpoch < BigInt(0) || parsed.fenceFloor < BigInt(0)) {
    return { ok: false, reason: "DEDUP_REPORT_COUNTERS_NEGATIVE", value: null };
  }

  return { ok: true, reason: null, value: parsed };
}

/**
 * The per-commitment high-water pairs, as a Map keyed by commitment id.
 *
 * A Map keyed by commitment id, never a maximum: §10.3.1's whole correction is that
 * the comparison is per commitment, and a normaliser that reduced the pairs to their
 * maximum here would reintroduce the defect one layer below where it was removed.
 *
 * @param {unknown} marks
 * @returns {Map<string, { sequence: number, fence: bigint }>}
 */
function normaliseMarks(marks) {
  const result = new Map();
  if (!marks) return result;

  const entries = marks instanceof Map ? [...marks.entries()] : Object.entries(marks);
  for (const [commitmentId, mark] of entries) {
    if (typeof commitmentId !== "string" || commitmentId === "" || !mark) continue;
    result.set(commitmentId, {
      sequence: Number.isInteger(mark.sequence) ? mark.sequence : -1,
      fence: BigInt(mark.fence === undefined || mark.fence === null ? 0 : mark.fence),
    });
  }
  return result;
}

/**
 * Choose §11.5's path. Pure: it reads no store and writes nothing.
 *
 * ── The case §11.5's table does not name ────────────────────────────────────
 * The table's third row is "Generation advanced, **or state absent**", and *state* there
 * is the **agent's**. When the server has no stored generation to compare against, it
 * cannot tell whether the agent's advanced — so the conservative reading applies:
 *
 *   - the agent holds active commitments in the store → treat as a reset. There is
 *     something that could be double-executed, and the agent's assertion about what it
 *     has applied is unverifiable. Row 3.
 *   - the agent holds none → `FIRST_CONTACT`. There is nothing to suppress, nothing to
 *     redeliver, and no authority to invalidate; advancing the epoch would be a write
 *     with no property to defend, performed on every agent's first ever session.
 *
 * This is the only judgement in the module the specification does not make explicitly,
 * and it is resolved towards the safe side wherever anything is at stake.
 *
 * @param {object} input
 * @param {object} input.reported from `parseReport`
 * @param {object|null} input.stored the `AgentDedupState` row, or null
 * @param {Array<object>} input.activeCommitments the agent's active commitments
 * @returns {object} the classification
 */
function classify(input) {
  const settings = input || {};
  const reported = settings.reported;
  const stored = settings.stored;
  const active = Array.isArray(settings.activeCommitments) ? settings.activeCommitments : [];

  if (!reported) {
    throw new TypeError("classify takes a parsed dedup report; parse it with parseReport first (§11.5)");
  }

  const custodyHold = requiresCustodyReconciliation(active);

  if (!stored) {
    if (active.length > 0) {
      return decision(DEDUP_PATH.SUPPRESS_AND_REFENCE, "NO_STORED_GENERATION_WITH_ACTIVE_COMMITMENTS", {
        custodyHold,
        redeliver: [],
      });
    }
    return decision(DEDUP_PATH.FIRST_CONTACT, "NO_STORED_GENERATION_AND_NO_ACTIVE_COMMITMENTS", {
      custodyHold,
      redeliver: [],
    });
  }

  const storedGeneration = BigInt(stored.dedupStateGeneration);
  if (reported.dedupStateGeneration > storedGeneration) {
    return decision(DEDUP_PATH.SUPPRESS_AND_REFENCE, "DEDUP_STATE_GENERATION_ADVANCED", { custodyHold, redeliver: [] });
  }
  if (reported.dedupStateGeneration < storedGeneration) {
    // The generation is monotonic by §11.5's own definition, so a *lower* value is not
    // "an older session reconnecting" — it is state that cannot be reconciled with what
    // this agent previously asserted. Treated as a reset, which is the conservative
    // direction: suppression costs one round of re-offering, admission costs a double
    // execution.
    return decision(DEDUP_PATH.SUPPRESS_AND_REFENCE, "DEDUP_STATE_GENERATION_WENT_BACKWARDS", {
      custodyHold,
      redeliver: [],
    });
  }

  // Generation unchanged. Rows 1 and 2 are distinguished by whether the agent's marks
  // are consistent with, or behind, the store.
  const behind = active.filter((commitment) => {
    const mark = reported.marks.get(commitment.commitmentId);
    if (!mark) return true;
    return mark.fence < BigInt(commitment.fence);
  });

  if (behind.length > 0) {
    return decision(DEDUP_PATH.REDELIVER_FROM_MARK, "AGENT_MARKS_BEHIND_THE_STORE", {
      custodyHold,
      // Safe, "because the agent's dedup state is intact and will reject anything it
      // has already applied" (§11.5 row 2).
      redeliver: behind.map((commitment) => commitment.commitmentId),
    });
  }

  return decision(DEDUP_PATH.RESUME, "MARKS_CONSISTENT_WITH_THE_STORE", { custodyHold, redeliver: [] });
}

/**
 * @param {string} path
 * @param {string} reason
 * @param {{ custodyHold: object, redeliver: string[] }} detail
 * @returns {object}
 */
function decision(path, reason, detail) {
  return Object.freeze({
    path,
    reason,
    suppressRedelivery: path === DEDUP_PATH.SUPPRESS_AND_REFENCE,
    advanceAuthorityEpoch: path === DEDUP_PATH.SUPPRESS_AND_REFENCE,
    redeliverCommitmentIds: Object.freeze(detail.redeliver),
    custodyReconciliationRequired: detail.custodyHold.required,
    custodyDetail: detail.custodyHold,
  });
}

/**
 * Invariant I7's half of the handshake: does this agent hold goods it must account for
 * before it may be offered anything?
 *
 * @param {Array<{ custodyState?: string }>} activeCommitments
 * @returns {{ required: boolean, commitments: string[], reason: string|null }}
 */
function requiresCustodyReconciliation(activeCommitments) {
  const holding = (activeCommitments || []).filter((commitment) => custody.holdsGoods(commitment.custodyState));
  if (holding.length === 0) {
    return { required: false, commitments: [], reason: null };
  }
  return {
    required: true,
    commitments: holding.map((commitment) => commitment.commitmentId),
    reason:
      "the agent holds custody against at least one commitment; §11.5 runs the §12.4 custody audit before any " +
      "re-offer, and an agent with an unreconciled non-empty manifest is not returned to the available pool " +
      "(invariant I7)",
  };
}

/**
 * Apply a classification, inside the caller's transaction.
 *
 * The reset path performs three writes that must land together or not at all:
 * suppression of every outstanding dispatch obligation, the `authority_epoch` advance
 * that invalidates the agent's mission authorities, and the I6 high-water record of
 * that advance. Splitting them would leave a window in which the epoch had advanced but
 * stale rows were still deliverable — which is the double execution §11.5 exists to
 * prevent, arrived at from the other direction.
 *
 * No command is emitted. §11.5 row 3's action is "**suppress** redelivery entirely",
 * and the agent whose state was wiped has nothing left to fence against; the new
 * authority reaches it with the first fresh offer, under a new commitment id.
 *
 * @param {object} tx a transaction client
 * @param {object} input
 * @param {object} input.agent the `Agent` row
 * @param {object} input.reported from `parseReport`
 * @param {object} input.classification from `classify`
 * @param {Date} input.storeTime
 * @returns {Promise<object>} what was written
 */
async function apply(tx, input) {
  const settings = input || {};
  const { agent, reported, classification, storeTime } = settings;

  if (!outbox.isTransactionClient(tx)) {
    throw new TypeError(
      "the handshake's writes — suppression, the authority_epoch advance, and its audit — MUST share one " +
        "transaction (§4.1 rule 5, §11.5)",
    );
  }

  let suppressed = 0;
  let authorityEpoch = BigInt(agent.authorityEpoch);

  if (classification.suppressRedelivery) {
    suppressed = await outbox.suppressOutstandingForAgent(tx, {
      agentId: agent.id,
      reason: `DEDUP_STATE_RESET:${classification.reason}`,
    });
  }

  if (classification.advanceAuthorityEpoch) {
    authorityEpoch = BigInt(agent.authorityEpoch) + BigInt(1);
    await tx.agent.update({ where: { id: agent.id }, data: { authorityEpoch } });
    await tx.agentFenceAudit.upsert({
      where: { agentId: agent.id },
      create: {
        agentId: agent.id,
        fenceHighWater: BigInt(agent.fenceCounter),
        epochHighWater: authorityEpoch,
        lastFenceSource: `dedup-reset:${classification.reason}`,
        observedAt: storeTime,
      },
      update: {
        fenceHighWater: BigInt(agent.fenceCounter),
        epochHighWater: authorityEpoch,
        lastFenceSource: `dedup-reset:${classification.reason}`,
        observedAt: storeTime,
      },
    });
  }

  // Record what the agent reported, whichever path was taken. This row is the only
  // thing that makes the *next* reset detectable: without it, every session would look
  // like first contact.
  await tx.agentDedupState.upsert({
    where: { agentId: agent.id },
    create: {
      agentId: agent.id,
      dedupStateGeneration: reported.dedupStateGeneration,
      authorityEpoch: reported.authorityEpoch,
      fenceFloor: reported.fenceFloor,
      reportedAt: storeTime,
    },
    update: {
      dedupStateGeneration: reported.dedupStateGeneration,
      authorityEpoch: reported.authorityEpoch,
      fenceFloor: reported.fenceFloor,
      reportedAt: storeTime,
    },
  });

  return {
    path: classification.path,
    suppressedRows: suppressed,
    authorityEpoch,
    fenceFloor: BigInt(agent.fenceCounter),
    custodyReconciliationRequired: classification.custodyReconciliationRequired,
  };
}

/**
 * The instruction the server sends back to the agent after a handshake.
 *
 * On the reset path it carries the new `authority_epoch` and the current
 * `fence_floor`, which is §10.3.1's interaction rule applied to a session rather than
 * to a command: the agent adopts both and discards its (already empty) per-commitment
 * authority table, so a stale offer that escapes suppression and arrives anyway is
 * rejected by the agent as well as by the server.
 *
 * @param {object} applied from `apply`
 * @returns {object}
 */
function acknowledgement(applied) {
  return Object.freeze({
    path: applied.path,
    authorityEpoch: String(applied.authorityEpoch),
    fenceFloor: String(applied.fenceFloor),
    redeliverySuppressed: applied.path === DEDUP_PATH.SUPPRESS_AND_REFENCE,
    custodyReconciliationRequired: applied.custodyReconciliationRequired,
  });
}

/**
 * §11.5's monitoring requirement, as a countable event.
 *
 * > `dedup_state_generation` advances are counted per agent and per agent class and are
 * > a first-class SLI. A single advance is an expected consequence of a firmware
 * > update; a rising rate across a class indicates non-volatile storage that is not
 * > actually durable — a defect that is invisible in every other signal, because a
 * > fleet with broken dedup persistence behaves perfectly until the first redelivery.
 *
 * @param {object} classification
 * @returns {boolean}
 */
function isGenerationAdvance(classification) {
  return Boolean(classification) && classification.reason === "DEDUP_STATE_GENERATION_ADVANCED";
}

/**
 * The agent-side rejection rules, exposed as one function so that the server, the
 * simulator, and the conformance fixture apply the same definition.
 *
 * Delegates to `commitment/fencing.js` rather than restating: §10.3.1's rules were
 * written once in Phase 3 precisely so Phase 4 would not write them a second time and
 * let the two drift.
 *
 * @param {object} command
 * @param {object} agentState `{ highestSeenPerCommitment, fenceFloor, highestSeenAuthority }`
 * @returns {{ accepted: boolean, reason: string|null }}
 */
function agentAdmits(command, agentState) {
  const state = agentState || {};
  const scope = fencing.fenceScopeOf(command && command.command);

  if (scope === null) {
    // §10.3.1 row 3 — "Always answered; never fenced."
    return { accepted: true, reason: null };
  }
  if (scope === fencing.FENCE_SCOPE.COMMITMENT) {
    return fencing.acceptsMissionCommand(command, state.highestSeenPerCommitment, state.fenceFloor);
  }
  return fencing.acceptsAgentCommand(command, state.highestSeenAuthority);
}

module.exports = {
  DEDUP_PATH,
  parseReport,
  normaliseMarks,
  classify,
  requiresCustodyReconciliation,
  apply,
  acknowledgement,
  isGenerationAdvance,
  agentAdmits,
};

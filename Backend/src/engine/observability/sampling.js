"use strict";

/**
 * Tier B sampling, the **bounded** exemption list, and the write budget (§21.2).
 * **Tier 1** (T1-03).
 *
 * ── Why sampling Tier B is sound rather than merely cheaper ─────────────────
 * §21.2 states the arithmetic that forces the two-tier design rather than leaving it
 * to be discovered in production: at `candidate.max_evaluated` = 200 and 38
 * predicates, a fully itemised feasibility section is ~7 600 predicate sub-records per
 * decision, and a region at 10 000 missions/hour produces ~1.5 x 10^8 of them an hour —
 * "on the order of 10 TB/day per region. That is not a storage-tuning problem; it is a
 * design defect, and it lands hardest during incidents."
 *
 * Sampling is sound because of determinism, not because of a storage argument:
 *
 * > Because replay reproduces Tier B exactly, the pair (Tier A + deterministic replay)
 * > is informationally equivalent to (Tier A + Tier B) for every decision whose inputs
 * > are retained. Tier B is therefore a **cache of a computable function**.
 *
 * ── The draw is deterministic, seeded from the decision id ──────────────────
 * > The decision falls in the `observability.tier_b_sample_rate` random sample
 * > (default 1 %), **seeded deterministically from the decision id so that sampling is
 * > itself replayable**.
 *
 * `draw()` is FNV-1a over the decision id normalised onto `[0, 1)`. No clock, no
 * `Math.random`, no process state: the same decision id yields the same draw in every
 * process, on every machine, on every replay. A replay that resampled would produce a
 * different Tier B population from the original run, and the reconstruction-equivalence
 * gate of §24.3 would be comparing two different things.
 *
 * ── The exemption list is bounded, and that is the whole correction ─────────
 * > The exemption list is broad by design, and under a shard-wide degraded mode *every*
 * > decision in the shard is degraded — so an unbounded exemption converts to full
 * > retention across the entire shard at exactly the moment volume spikes hardest,
 * > which is the opposite of what a sampling scheme is for.
 *
 * Two mechanisms implement the bound, and both are structural rather than advisory:
 *
 *   1. **Scope.** `classifyExemption()` admits only `DEGRADATION_SCOPE.DECISION`
 *      degradations. A `SHARD` degradation is refused as an exemption and is recorded
 *      once at the mode level instead (§18.5, Phase 12's `degraded/modeRegister.js`).
 *      The refusal is by scope, not by counting: a scheme that admitted shard-wide
 *      degradations and then capped the resulting volume would still have converted
 *      the sample into "whatever arrived first", which is the failure mode.
 *   2. **Budget.** Exempt writes draw on `observability.tier_b_write_budget` per shard
 *      per minute. On exhaustion the decision falls back to Tier A plus a reservoir
 *      sample, "and the shedding is itself recorded as a counted event. Retention
 *      degrades visibly and uniformly rather than by arrival order."
 *
 * ── The reservoir is bottom-k over the deterministic draw, not Algorithm R ──
 * §21.2 requires the reservoir to be "uniform over the exempt population". The textbook
 * reservoir (Algorithm R) needs a fresh random number per candidate, which the decision
 * path prohibits (T6, §9.6 requirement 7), and its content depends on arrival order.
 *
 * Bottom-k over `draw(decisionId)` — retain the `k` exempt decisions with the smallest
 * draws — is uniform over the population by the uniformity of the hash, needs no
 * randomness beyond the draw already computed, and is **order-independent**: the same
 * exempt population yields the same reservoir however the decisions arrived. That last
 * property is what makes a shed episode reproducible after the fact rather than a
 * story about scheduling.
 */

const { canonicalJson } = require("../determinism/ordering");

/** Why a Tier B record exists. Matches `DecisionRecordB_written_because_known`. */
const WRITTEN_BECAUSE = Object.freeze({
  /** In the `observability.tier_b_sample_rate` sample. Representative. */
  SAMPLED: "SAMPLED",
  /** On the bounded exemption list, within the write budget. Deliberately not representative. */
  EXEMPT: "EXEMPT",
  /** A uniform draw from the exempt population after the budget was exhausted. */
  RESERVOIR: "RESERVOIR",
});

/** The verdict `offer()` returns. `SHED` writes no Tier B and is counted. */
const VERDICT = Object.freeze({
  ...WRITTEN_BECAUSE,
  /** Neither sampled nor exempt: Tier A only, by design, reconstructible by replay. */
  NOT_SELECTED: "NOT_SELECTED",
  /** Exempt, but the budget and the reservoir are both full. Counted, never silent. */
  SHED: "SHED",
});

/**
 * §21.2's exemption list, split by **when the reason becomes known**, because the two
 * halves have different remedies.
 *
 * The four `AT_DECISION` reasons are knowable while the decision is being taken, so a
 * Tier B record can be written then. The three `LATER` reasons are not:
 *
 * > Records exempted for a *later* reason — reassigned, failed, disputed — cannot be
 * > written retroactively if Tier B was not captured. For these the Explanation API
 * > reconstructs by replay, which yields the identical content.
 *
 * Enumerating them here, rather than leaving the distinction to the caller, is what
 * stops a future writer from adding a retroactive Tier B path that would silently
 * produce a record whose content was never the one the decision was taken with.
 */
const EXEMPTION = Object.freeze({
  AT_DECISION: Object.freeze({
    /** This candidate's stale telemetry, this decision's degraded dependency. */
    DEGRADED: "DEGRADED",
    /** A constraint relaxation applied to this decision. */
    RELAXED: "RELAXED",
    /** An operator action on this decision (§23.6). */
    OVERRIDDEN: "OVERRIDDEN",
    /** This decision preempted an incumbent (§4.8). */
    PREEMPTED: "PREEMPTED",
  }),
  LATER: Object.freeze({
    REASSIGNED: "REASSIGNED",
    FAILED: "FAILED",
    DISPUTED: "DISPUTED",
  }),
});

const AT_DECISION_REASONS = Object.freeze(Object.values(EXEMPTION.AT_DECISION));
const LATER_REASONS = Object.freeze(Object.values(EXEMPTION.LATER));

/**
 * The scope of a degradation, and the reason this vocabulary lives in Phase 11 rather
 * than in Phase 12's degraded-mode register: the *bound* on the exemption list is a
 * property of the sampler, and it must exist before the register that will feed it.
 * Phase 12's `degraded/modeRegister.js` supplies values; nothing here imports it.
 */
const DEGRADATION_SCOPE = Object.freeze({
  /** Specific to this decision — this candidate's stale observation, this relaxation. */
  DECISION: "DECISION",
  /** A named mode active across the whole shard (§18.5). Recorded once, at mode level. */
  SHARD: "SHARD",
});

/** @structural FNV-1a's published 32-bit offset basis; a hash constant, not a threshold */
const FNV_OFFSET_BASIS = 0x811c9dc5;

/** @structural FNV-1a's published 32-bit prime; a hash constant, not a threshold */
const FNV_PRIME = 0x01000193;

/** @structural 2^32 — normalises a 32-bit unsigned hash onto the half-open [0, 1) */
const UINT32_SPAN = 4294967296;

/**
 * MurmurHash3's published 32-bit finalizer constants. @structural hash constants
 */
const FMIX_SHIFT_1 = 16;
/** @structural MurmurHash3 fmix32 multiplier 1 */
const FMIX_C1 = 0x85ebca6b;
/** @structural MurmurHash3 fmix32 shift 2 */
const FMIX_SHIFT_2 = 13;
/** @structural MurmurHash3 fmix32 multiplier 2 */
const FMIX_C2 = 0xc2b2ae35;

/**
 * Avalanche a 32-bit hash so that inputs differing in one character land far apart.
 *
 * **This step is load-bearing, and it was added because its absence was measured.**
 * FNV-1a alone is asymptotically uniform but has weak short-range avalanche: over 200
 * sequentially-numbered decision ids — `…:L0` through `…:L199`, which is exactly the
 * shape of one round's batch — a 10 % rate retained 0 of them rather than ~20, because
 * neighbouring inputs produced neighbouring hashes and the whole batch fell on one side
 * of the threshold.
 *
 * That is not a cosmetic statistics point. §21.2's sample must be *representative of the
 * population*, because every rate and distribution computed over the sampled records
 * assumes it is; a sampler that systematically retains none of one round and all of the
 * next produces a Tier B population that is a biased view of the fleet, and the bias is
 * invisible in the aggregate counts (which are exact by construction) precisely where it
 * would be most misleading.
 *
 * MurmurHash3's `fmix32` is a bijection, so it changes no cardinality and adds no
 * collisions; it only redistributes. Determinism is untouched — the same id still yields
 * the same draw in every process and on every replay.
 *
 * @param {number} hash a 32-bit unsigned value
 * @returns {number} a 32-bit unsigned value
 */
function avalanche(hash) {
  let mixed = hash >>> 0;
  mixed ^= mixed >>> FMIX_SHIFT_1;
  mixed = Math.imul(mixed, FMIX_C1) >>> 0;
  mixed ^= mixed >>> FMIX_SHIFT_2;
  mixed = Math.imul(mixed, FMIX_C2) >>> 0;
  mixed ^= mixed >>> FMIX_SHIFT_1;
  return mixed >>> 0;
}

/** @structural milliseconds in the minute `observability.tier_b_write_budget` is per */
const BUDGET_WINDOW_MS = 60000;

/**
 * The deterministic draw for a decision, in `[0, 1)`.
 *
 * @param {string} decisionId
 * @returns {number}
 */
function draw(decisionId) {
  const identity = String(decisionId === undefined || decisionId === null ? "" : decisionId);
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  // FNV-1a, then avalanche. Without the second step, one round's sequentially-numbered
  // Legs land in one region of the range and the sample is drawn from a batch rather
  // than from the population — see `avalanche()`.
  return avalanche(hash) / UINT32_SPAN;
}

/**
 * Is this decision in the `observability.tier_b_sample_rate` sample?
 *
 * @param {string} decisionId
 * @param {number} sampleRate in `[0, 1]`
 * @returns {boolean}
 */
function isSampled(decisionId, sampleRate) {
  if (typeof sampleRate !== "number" || !Number.isFinite(sampleRate) || sampleRate <= 0) return false;
  if (sampleRate >= 1) return true;
  return draw(decisionId) < sampleRate;
}

/**
 * Decide whether a decision is on the **bounded** exemption list.
 *
 * @param {object} input
 * @param {Array<{ scope: string, reason?: string, mode?: string }>} [input.degradations]
 *   every degradation in force for this decision, each carrying its scope
 * @param {boolean} [input.relaxed] a constraint relaxation was applied to this decision
 * @param {boolean} [input.overridden] an operator acted on this decision
 * @param {boolean} [input.preempted] this decision preempted an incumbent
 * @returns {{ exempt: boolean, reasons: string[], shardWideRefused: object[], why: string }}
 */
function classifyExemption(input) {
  const source = input || {};
  const reasons = [];
  const shardWideRefused = [];

  for (const degradation of source.degradations || []) {
    if (!degradation) continue;
    if (degradation.scope === DEGRADATION_SCOPE.SHARD) {
      // Refused as an exemption *by scope*. §21.2: "A shard-wide degraded mode is
      // recorded once, at the mode level (§18.5), not as a per-decision exemption."
      shardWideRefused.push({
        mode: degradation.mode ?? null,
        reason: degradation.reason ?? null,
        recordedAt: "MODE_LEVEL",
      });
      continue;
    }
    if (degradation.scope === DEGRADATION_SCOPE.DECISION) {
      if (!reasons.includes(EXEMPTION.AT_DECISION.DEGRADED)) reasons.push(EXEMPTION.AT_DECISION.DEGRADED);
    }
  }

  if (source.relaxed === true) reasons.push(EXEMPTION.AT_DECISION.RELAXED);
  if (source.overridden === true) reasons.push(EXEMPTION.AT_DECISION.OVERRIDDEN);
  if (source.preempted === true) reasons.push(EXEMPTION.AT_DECISION.PREEMPTED);

  return {
    exempt: reasons.length > 0,
    reasons,
    shardWideRefused,
    why:
      shardWideRefused.length > 0 && reasons.length === 0
        ? "every degradation in force is shard-wide, so this decision is not individually exempt: a shard-wide " +
          "mode is recorded once at the mode level (§18.5). An unbounded exemption would convert the sample to " +
          "full retention across the shard at exactly the moment volume spikes hardest (§21.2)."
        : reasons.length > 0
          ? `decision-specific exemption(s): ${reasons.join(", ")}`
          : "not exempt",
  };
}

/**
 * Is this reason one that only becomes known after the decision?
 *
 * @param {string} reason
 * @returns {boolean}
 */
function isLaterReason(reason) {
  return LATER_REASONS.includes(reason);
}

/**
 * Create the per-shard write budget with its bottom-k reservoir.
 *
 * The budget is held in coordinator memory and rolled per window, the same placement
 * §7.7's rejection aggregator uses and for the same reason: a synchronous durable write
 * to decide whether to make a durable write is a round-trip on the round's critical
 * path to answer a question about volume.
 *
 * @param {object} config
 * @param {number} config.writeBudgetPerMinute `observability.tier_b_write_budget`
 * @param {number} config.reservoirSize `observability.tier_b_reservoir_size`
 * @returns {object}
 */
function createBudget(config) {
  const settings = config || {};
  const writeBudget = Number.isFinite(settings.writeBudgetPerMinute) ? settings.writeBudgetPerMinute : 0;
  const reservoirSize = Number.isFinite(settings.reservoirSize) ? settings.reservoirSize : 0;

  /** shardId → `{ windowStartMs, spent, shed, reservoir: [{ decisionId, draw, payload }] }` */
  const shards = new Map();

  const stateFor = (shardId, nowMs) => {
    const key = String(shardId);
    let state = shards.get(key);
    const windowStartMs = Math.floor(nowMs / BUDGET_WINDOW_MS) * BUDGET_WINDOW_MS;
    if (!state) {
      state = { shardId: key, windowStartMs, spent: 0, shed: 0, exemptOffered: 0, reservoir: [] };
      shards.set(key, state);
      return state;
    }
    if (state.windowStartMs !== windowStartMs) {
      // A new minute. The previous window's reservoir is left in place for the flusher
      // to drain; the counters roll. Rolling the counters without draining the
      // reservoir would lose the very records the reservoir exists to preserve.
      state.windowStartMs = windowStartMs;
      state.spent = 0;
      state.shed = 0;
      state.exemptOffered = 0;
    }
    return state;
  };

  /**
   * Offer one decision to the sampler.
   *
   * Ordering is load-bearing and matches §21.2's own: the sample is decided first and
   * is **never** charged to the exemption budget. Charging the random sample to the
   * exempt budget would let a degraded episode starve the representative sample, which
   * is the one population every aggregate rate is computed against.
   *
   * @param {object} input
   * @param {string} input.shardId
   * @param {string} input.decisionId
   * @param {number} input.nowMs
   * @param {number} input.sampleRate
   * @param {boolean} [input.exempt]
   * @param {string[]} [input.exemptionReasons]
   * @param {*} [input.payload] held only if the decision lands in the reservoir
   * @returns {object} the verdict, with the draw and the rate that produced it
   */
  function offer(input) {
    const source = input || {};
    const nowMs = Number.isFinite(source.nowMs) ? source.nowMs : 0;
    const state = stateFor(source.shardId, nowMs);
    const value = draw(source.decisionId);
    const sampled = isSampled(source.decisionId, source.sampleRate);

    const base = {
      decisionId: source.decisionId,
      shardId: state.shardId,
      draw: value,
      sampleRate: source.sampleRate ?? null,
      exemptionReasons: source.exemptionReasons || [],
      windowStartMs: state.windowStartMs,
    };

    if (sampled) {
      return Object.freeze({ ...base, verdict: VERDICT.SAMPLED, writtenBecause: WRITTEN_BECAUSE.SAMPLED, reason: null });
    }

    if (source.exempt !== true) {
      return Object.freeze({
        ...base,
        verdict: VERDICT.NOT_SELECTED,
        writtenBecause: null,
        reason: null,
        note:
          "Tier A only. The record is not lost: replay from the pinned snapshot reproduces Tier B byte for byte " +
          "(§21.2), and the Explanation API labels such an answer RECONSTRUCTED.",
      });
    }

    state.exemptOffered += 1;

    if (state.spent < writeBudget) {
      state.spent += 1;
      return Object.freeze({
        ...base,
        verdict: VERDICT.EXEMPT,
        writtenBecause: WRITTEN_BECAUSE.EXEMPT,
        reason: base.exemptionReasons[0] ?? EXEMPTION.AT_DECISION.DEGRADED,
        budgetRemaining: writeBudget - state.spent,
      });
    }

    // The budget is exhausted. Bottom-k over the deterministic draw: uniform over the
    // exempt population and independent of arrival order.
    const entry = { decisionId: source.decisionId, draw: value, payload: source.payload ?? null, reasons: base.exemptionReasons };
    if (state.reservoir.length < reservoirSize) {
      state.reservoir.push(entry);
      state.reservoir.sort((a, b) => a.draw - b.draw || String(a.decisionId).localeCompare(String(b.decisionId)));
      return Object.freeze({
        ...base,
        verdict: VERDICT.RESERVOIR,
        writtenBecause: WRITTEN_BECAUSE.RESERVOIR,
        reason: base.exemptionReasons[0] ?? EXEMPTION.AT_DECISION.DEGRADED,
      });
    }

    const worst = state.reservoir[state.reservoir.length - 1];
    if (reservoirSize > 0 && (value < worst.draw || (value === worst.draw && String(source.decisionId) < String(worst.decisionId)))) {
      state.reservoir[state.reservoir.length - 1] = entry;
      state.reservoir.sort((a, b) => a.draw - b.draw || String(a.decisionId).localeCompare(String(b.decisionId)));
      state.shed += 1;
      return Object.freeze({
        ...base,
        verdict: VERDICT.RESERVOIR,
        writtenBecause: WRITTEN_BECAUSE.RESERVOIR,
        reason: base.exemptionReasons[0] ?? EXEMPTION.AT_DECISION.DEGRADED,
        evicted: worst.decisionId,
      });
    }

    state.shed += 1;
    return Object.freeze({
      ...base,
      verdict: VERDICT.SHED,
      writtenBecause: null,
      reason: base.exemptionReasons[0] ?? EXEMPTION.AT_DECISION.DEGRADED,
      note:
        "the shard's Tier B write budget is exhausted and the reservoir holds uniformly better draws. The shedding " +
        "is counted, not silent (§21.2), and the decision remains reconstructible by replay.",
    });
  }

  /**
   * Drain a shard's reservoir for the flusher, and reset its counters.
   *
   * @param {string} shardId
   * @returns {{ shardId: string, windowStartMs: number, spent: number, shed: number,
   *             exemptOffered: number, reservoir: object[] }}
   */
  function drain(shardId) {
    const key = String(shardId);
    const state = shards.get(key);
    if (!state) return { shardId: key, windowStartMs: null, spent: 0, shed: 0, exemptOffered: 0, reservoir: [] };
    const snapshot = {
      shardId: key,
      windowStartMs: state.windowStartMs,
      spent: state.spent,
      shed: state.shed,
      exemptOffered: state.exemptOffered,
      reservoir: state.reservoir,
    };
    state.reservoir = [];
    state.shed = 0;
    state.exemptOffered = 0;
    return snapshot;
  }

  /**
   * Read a shard's counters without draining. The §21.4 SLIs — "Tier-B write rate
   * against `observability.tier_b_write_budget`; Tier-B exempt-shedding count" — read
   * through here.
   *
   * @param {string} shardId
   * @returns {object}
   */
  function counters(shardId) {
    const state = shards.get(String(shardId));
    return Object.freeze({
      shardId: String(shardId),
      windowStartMs: state ? state.windowStartMs : null,
      writeBudget,
      reservoirSize,
      spent: state ? state.spent : 0,
      shed: state ? state.shed : 0,
      exemptOffered: state ? state.exemptOffered : 0,
      reservoirHeld: state ? state.reservoir.length : 0,
      budgetRemaining: state ? Math.max(0, writeBudget - state.spent) : writeBudget,
    });
  }

  function shardIds() {
    return [...shards.keys()].sort();
  }

  return { offer, drain, counters, shardIds, BUDGET_WINDOW_MS };
}

/**
 * Prove that a sampling verdict is reproducible: the same decision id and rate always
 * yield the same draw and the same sampled/not-sampled answer.
 *
 * Exposed as a function rather than left to a test so that the property can be asserted
 * from the replayer as well — a replay whose sampling diverged would silently compare a
 * different Tier B population than the original run produced.
 *
 * @param {string} decisionId
 * @param {number} sampleRate
 * @returns {{ ok: boolean, draw: number, sampled: boolean, digest: string }}
 */
function reproducibility(decisionId, sampleRate) {
  const first = { draw: draw(decisionId), sampled: isSampled(decisionId, sampleRate) };
  const second = { draw: draw(decisionId), sampled: isSampled(decisionId, sampleRate) };
  return {
    ok: first.draw === second.draw && first.sampled === second.sampled,
    draw: first.draw,
    sampled: first.sampled,
    digest: canonicalJson(first),
  };
}

module.exports = {
  WRITTEN_BECAUSE,
  VERDICT,
  EXEMPTION,
  AT_DECISION_REASONS,
  LATER_REASONS,
  DEGRADATION_SCOPE,
  BUDGET_WINDOW_MS,
  avalanche,
  draw,
  isSampled,
  classifyExemption,
  isLaterReason,
  createBudget,
  reproducibility,
};

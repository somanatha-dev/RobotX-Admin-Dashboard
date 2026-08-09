"use strict";

/**
 * The solve regime and its guarantees (§9.3) — **Tier 1**, decision path.
 *
 * > **Two solve regimes, with different guarantees.** The regime is a property of the
 * > generated column set, is determined per round, and is recorded in the decision
 * > record. **The engine never asserts a guarantee it is not in the regime for.**
 *
 * | Regime | Column set | Solved by | Guarantee | Duals |
 * |---|---|---|---|---|
 * | **Singleton** | every column covers exactly one Leg | min-cost flow | LP relaxation is integral; the solve is **exact**, with no branching and no integrality gap | Exact marginal prices of the integer problem — valid for §8.3 calibration **without qualification** |
 * | **Column** | at least one column covers ≥ 2 Legs | LP relaxation then branch-and-bound | Exact **over the generated column set**, with the residual LP–IP gap reported in CU | Prices of the *relaxation*, not of the integer problem; MUST be recorded as such |
 *
 * ── Why this is a module and not an `if` ────────────────────────────────────
 * The sentence "the engine never asserts a guarantee it is not in the regime for" is a
 * safety property about *claims*, and claims are made in decision records, in SLIs, and
 * in the dual prices §8.3.1 feeds back into the opportunity-cost model. A round in the
 * column regime that published its LP duals as exact integer prices would silently
 * miscalibrate `λ_zone` for every subsequent round, and nothing downstream could detect
 * it, because a dual is just a number.
 *
 * So the guarantee is not a comment: `assertClaim()` refuses the claim, and
 * `dualsFor()` returns duals **labelled with what they are**, so a consumer that wants
 * exact prices has to ask for them and be told no rather than receive relaxation prices
 * that look identical.
 *
 * ── The Phase 10 boundary, stated ───────────────────────────────────────────
 * The column regime is **recognised and refused**, not implemented. Multi-Leg columns
 * are T2-02 (`solve/setPartitioning.js`, `plan/multiLegColumn.js`, kill switch
 * `multi_leg_columns`) and belong to Phase 16d; `plan/columnBuilder.js` (Phase 8) is
 * structurally incapable of emitting one. This module therefore *classifies* a column
 * set that contains a multi-Leg column, records the regime honestly, and reports that no
 * solver is registered for it — rather than either pretending the set is singleton (which
 * would assert an integrality guarantee that does not hold) or throwing (which would make
 * the round's failure mode a crash instead of a recorded outcome).
 *
 * That is §22.5 rule 1's shape: the disabled behaviour is a complete, tested Tier 1
 * behaviour — every round in the singleton regime — not a truncated Tier 2 one.
 *
 * T1 (§1.5, I14): `determine()` asserts the feasibility brand on every column's plan
 * before classifying. That may look like an odd place for the check — classification is
 * not pricing — but the regime is what *authorises the guarantee claims* made about the
 * priced allocation, and a regime determined over a column the gate never admitted would
 * authorise a claim about work that was never eligible. The scope §1.8 draws around
 * `solve/` is drawn at exactly this granularity.
 *
 * Determinism (T6): no clock, no randomness, no store.
 */

const { assertFeasible } = require("../guards/tenets");

/** §9.3's two regimes. @structural the specification's own regime names */
const REGIME = Object.freeze({
  SINGLETON: "SINGLETON",
  COLUMN: "COLUMN",
});

/**
 * What a dual price *is*, in each regime. Carried alongside every dual vector so a
 * consumer cannot mistake one for the other.
 * @structural the two dual kinds §9.3 distinguishes
 */
const DUAL_KIND = Object.freeze({
  /** Exact marginal prices of the integer problem. Valid for §8.3 calibration without qualification. */
  EXACT_INTEGER: "EXACT_INTEGER_MARGINAL_PRICE",
  /** Prices of the relaxation. §8.3.1 requires this to be recorded as such. */
  RELAXATION: "LP_RELAXATION_PRICE",
});

/**
 * The claims a round might make. Named so `assertClaim()` can refuse one by name rather
 * than by an inferred property of a result object.
 * @structural the enumerated guarantee claims
 */
const CLAIM = Object.freeze({
  /** "The allocation is optimal over the generated column set with no integrality gap." */
  EXACT_INTEGER_OPTIMAL: "EXACT_INTEGER_OPTIMAL",
  /** "The duals are exact marginal prices of the integer problem." */
  EXACT_INTEGER_DUALS: "EXACT_INTEGER_DUALS",
  /** "No branching was required." */
  NO_BRANCHING: "NO_BRANCHING",
  /** "The LP–IP gap is zero." */
  ZERO_LP_IP_GAP: "ZERO_LP_IP_GAP",
});

/** The claims each regime is entitled to. @structural §9.3's guarantee table */
const CLAIMS_BY_REGIME = Object.freeze({
  [REGIME.SINGLETON]: Object.freeze([
    CLAIM.EXACT_INTEGER_OPTIMAL,
    CLAIM.EXACT_INTEGER_DUALS,
    CLAIM.NO_BRANCHING,
    CLAIM.ZERO_LP_IP_GAP,
  ]),
  // Deliberately empty. Every one of the four is false in general for a set-partitioning
  // problem whose constraint matrix is not totally unimodular, and §9.3 states each
  // exception explicitly — "exact **over the generated column set**", "prices of the
  // *relaxation*", "branch-and-bound … within solve.branch_node_budget", "the residual
  // LP–IP gap reported in CU". A round in this regime reports numbers; it asserts
  // nothing.
  [REGIME.COLUMN]: Object.freeze([]),
});

/**
 * Determine the regime from the generated column set.
 *
 * §9.3: "The regime is a property of the generated column set" — of the set actually
 * handed to the solver, not of the kill-switch state, not of the configured
 * `plan.max_bundle_size`, and not of what the Column Builder intended. A round whose
 * bundling was enabled but which happened to generate only singletons **is** in the
 * singleton regime and is entitled to its guarantee; that is §9.3's own sentence, "it is
 * what the round degenerates to … when chaining produces no multi-Leg column".
 *
 * @param {object[]} columns each carrying `legIds`
 * @returns {{ regime: string, singletonCount: number, multiLegCount: number,
 *             maxLegsPerColumn: number, why: string }}
 */
function determine(columns) {
  const set = columns || [];
  let singletonCount = 0;
  let multiLegCount = 0;
  let maxLegsPerColumn = 0;

  for (const entry of set) {
    assertFeasible(
      entry && (entry.plan || (entry.column && entry.column.plan)),
      `solve/regime.determine (column ${String(entry && entry.identity)})`,
    );
    const legIds = (entry && (entry.legIds || (entry.column && entry.column.legIds))) || [];
    maxLegsPerColumn = Math.max(maxLegsPerColumn, legIds.length);
    if (legIds.length === 1) singletonCount += 1;
    else if (legIds.length > 1) multiLegCount += 1;
  }

  const regime = multiLegCount > 0 ? REGIME.COLUMN : REGIME.SINGLETON;

  return {
    regime,
    singletonCount,
    multiLegCount,
    maxLegsPerColumn,
    why:
      regime === REGIME.SINGLETON
        ? "every column covers exactly one Leg, so the constraint matrix is the incidence matrix of a bipartite " +
          "graph and is totally unimodular: the LP relaxation is integral and the min-cost flow is exact (§9.3)"
        : `${multiLegCount} column(s) cover more than one Leg (largest covers ${maxLegsPerColumn}), so total ` +
          "unimodularity does not hold in general and the integrality gap is real (§9.3)",
  };
}

/**
 * The guarantees a regime carries, for the decision record.
 *
 * @param {string} regime
 * @returns {object}
 */
function guaranteesFor(regime) {
  if (regime === REGIME.SINGLETON) {
    return Object.freeze({
      regime,
      solvedBy: "min-cost flow on the bipartite-plus-defer-plus-sink network",
      exact: true,
      exactOver: "the integer problem",
      branches: false,
      integralityGap: "none — the LP relaxation is integral",
      dualKind: DUAL_KIND.EXACT_INTEGER,
      dualValidity:
        "exact marginal prices of the integer problem — valid for §8.3 calibration without qualification",
      claims: CLAIMS_BY_REGIME[REGIME.SINGLETON],
      note:
        "selecting the flow solver here is not a fallback but a specialisation — the same problem, solved by " +
        "the algorithm that exploits its structure (§9.3)",
    });
  }

  if (regime === REGIME.COLUMN) {
    return Object.freeze({
      regime,
      solvedBy: "LP relaxation, then branch-and-bound over fractional columns within solve.branch_node_budget",
      exact: false,
      exactOver: "the generated column set only, with the residual LP–IP gap reported in CU",
      branches: true,
      integralityGap: "real; reported in CU, never assumed zero",
      dualKind: DUAL_KIND.RELAXATION,
      dualValidity:
        "prices of the relaxation, not of the integer problem; §8.3.1 requires them to be recorded as such " +
        "before any calibration consumes them",
      claims: CLAIMS_BY_REGIME[REGIME.COLUMN],
      note:
        "no solver for this regime is registered in Phase 10. Multi-Leg columns are T2-02 behind the " +
        "`multi_leg_columns` kill switch and belong to Phase 16d; a Tier 1 module able to solve this regime " +
        "would be a kill switch that cannot be thrown (§1.8 rule 2)",
    });
  }

  throw new RangeError(
    `"${String(regime)}" is not a solve regime. §9.3 defines exactly two — ${REGIME.SINGLETON} and ` +
      `${REGIME.COLUMN} — and the Round table's own CHECK constraint enforces the same closed vocabulary, ` +
      "because a round claiming an unrecognised regime could claim any guarantee.",
  );
}

/**
 * Is this round entitled to make this claim?
 *
 * @param {string} regime
 * @param {string} claim one of `CLAIM`
 * @returns {{ entitled: boolean, reason: string|null }}
 */
function entitledTo(regime, claim) {
  const permitted = CLAIMS_BY_REGIME[regime];
  if (!permitted) {
    return { entitled: false, reason: `"${String(regime)}" is not a solve regime (§9.3)` };
  }
  if (permitted.includes(claim)) return { entitled: true, reason: null };
  return {
    entitled: false,
    reason:
      `a round in the ${regime} regime may not claim ${claim}. §9.3: "The engine never asserts a guarantee it ` +
      `is not in the regime for." ${guaranteesFor(regime).dualValidity}`,
  };
}

/**
 * Refuse a claim the regime does not carry.
 *
 * Throws rather than returning false, and does so deliberately: an out-of-regime
 * guarantee is not a recoverable condition to be branched on but a defect in the code
 * that made the claim. §8.3.1's calibration loop consumes duals without being able to
 * tell exact prices from relaxation prices by inspection, so the refusal has to happen at
 * the site of the claim, loudly, and before the number travels.
 *
 * @param {string} regime
 * @param {string} claim
 * @returns {void}
 * @throws {Error} when the regime does not carry the claim
 */
function assertClaim(regime, claim) {
  const verdict = entitledTo(regime, claim);
  if (!verdict.entitled) throw new Error(verdict.reason);
}

/**
 * Label a dual vector with what it actually is.
 *
 * The labelling is the mechanism. §8.3.1 requires relaxation prices to "be recorded as
 * such"; returning a bare array of numbers makes that a discipline the consumer must
 * remember, and returning a labelled object makes it a fact the consumer cannot avoid
 * reading.
 *
 * @param {string} regime
 * @param {Record<string, bigint>} duals leg id → price in milli-CU
 * @returns {object}
 */
function dualsFor(regime, duals) {
  const guarantees = guaranteesFor(regime);
  return Object.freeze({
    kind: guarantees.dualKind,
    validity: guarantees.dualValidity,
    regime,
    // §8.3.1's own condition for feeding duals back into λ_zone calibration. False in
    // the column regime, and the consumer reads this field rather than inferring it
    // from the regime name.
    validForCalibrationWithoutQualification: guarantees.dualKind === DUAL_KIND.EXACT_INTEGER,
    prices: Object.freeze({ ...(duals || {}) }),
  });
}

/**
 * Is a solver registered for this regime in this build?
 *
 * @param {string} regime
 * @returns {{ solvable: boolean, reason: string|null }}
 */
function solverAvailable(regime) {
  if (regime === REGIME.SINGLETON) return { solvable: true, reason: null };
  return {
    solvable: false,
    reason:
      "no solver for the column regime is registered. The round records the regime honestly and reports that " +
      "it could not be solved, rather than solving it as though it were singleton — which would assert an " +
      "integrality guarantee that does not hold — or throwing, which would make the outcome a crash instead of " +
      "a recorded one (§22.5 rule 1).",
  };
}

module.exports = {
  REGIME,
  DUAL_KIND,
  CLAIM,
  CLAIMS_BY_REGIME,
  determine,
  guaranteesFor,
  entitledTo,
  assertClaim,
  dualsFor,
  solverAvailable,
};

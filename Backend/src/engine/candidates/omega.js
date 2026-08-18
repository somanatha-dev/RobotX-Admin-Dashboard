"use strict";

/**
 * Ω_terminal and Ω_policy (§6.4) — Tier 1.
 *
 * > The last two components exist because three cost terms can be negative, and a
 * > bound that omits a negative term is larger than the true cost, not smaller...
 * > Each negative contribution is bounded by construction.
 *
 * `LB(a, l)` (`candidates/lowerBound.js`) subtracts both quantities this module
 * produces so that the four non-negative components above it remain a genuine lower
 * bound on `γ` even when `C_opportunity` or `C_policy` land negative. Getting either
 * wrong does not merely mis-order candidates — it makes the pruning rule discard the
 * true optimum while the decision record advertises a proof that it did not (§6.4,
 * §24.1), which is why both are computed here rather than estimated at the call site.
 *
 * ── Ω_policy — resolved, not recomputed ──────────────────────────────────────
 * §6.4: "`Ω_policy` is `cost.policy.max_total_credit`... derived at configuration
 * publish time... This is what makes the bound a structural property of the
 * configuration rather than a claim requiring separate maintenance." That derivation
 * already exists — `config/derived.js`'s `derivePolicyTotalCredit()`, wired into
 * every snapshot `config/service.js` builds — so this module only resolves it and
 * converts it to milli-CU. Recomputing the sum here, against a second read of the
 * register, is exactly the "separate maintenance" §6.4 says the derivation exists to
 * avoid: two additions of the same ceilings can drift, and only one of them would be
 * the one the Config Service actually validated at publish time (§8.6, §22.1).
 *
 * ── Ω_terminal — consumed, not computed ──────────────────────────────────────
 * `pricing/vTerminal.js`'s `omegaTerminal()` computes exactly the §6.4 formula from
 * the round's pinned price snapshot, and its own docstring states the seam: "Phase
 * 9's `candidates/omega.js` consumes what this produces; it does not recompute it."
 * This module honours that — with one adjustment §1.8 rule 2 requires. `pricing/` is
 * classified Tier 2 (`cost.opportunity`'s dynamic λ_zone estimation, §8.3.1), and
 * "no Tier 0 or Tier 1 guarantee may depend on a Tier 2 mechanism" is enforced over
 * the *static import graph* (`tools/gates/checkTierDependencies.js`). A `require()`
 * of `pricing/vTerminal` from this Tier 1 module would be exactly the shape rule 2
 * forbids — the same shape `TIERS.md` documents and rejects for `cost/phi.js` and
 * `cost/cOpportunity.js` ("Φ... may not import cOpportunity.js; it obtains optional
 * terms through registration, never a static import").
 *
 * So `acceptOmegaTerminal()` below takes the **already-computed** CU figure as plain
 * data. The composition root that is allowed to see both tiers — Phase 10's round
 * loop / coordinator — calls `pricing/vTerminal.omegaTerminal()` when
 * `opportunity_cost_term` is not thrown and passes the result in; this module never
 * imports the function that produced it. When the switch **is** thrown, `C_opportunity`
 * is not registered into `Φ` at all (`cost/phi.js`'s `registerTerm` seam), so `Φ`
 * carries no negative contribution from it this round and no correction is owed —
 * `omegaTerminalMilliCU()` returns `0n` in that case, not an estimate standing in for
 * a term that was never priced.
 */

const { toMilliCU, assertInt64 } = require("../determinism/fixedPoint");

const OPPORTUNITY_KILL_SWITCH = "opportunity_cost_term";

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Is `C_opportunity` registered into `Φ` this round? Mirrors `killSwitches.js`'s own
 * terminology: a switch is *thrown* when the mechanism it guards is disabled, and the
 * §1.8 rule 3 baseline — every switch thrown — is the Tier 0 + Tier 1 ship state.
 *
 * @param {{ killSwitchState?: Record<string, boolean> }} snapshot a config snapshot
 * @returns {boolean}
 */
function opportunityTermActive(snapshot) {
  const state = (snapshot && snapshot.killSwitchState) || {};
  return state[OPPORTUNITY_KILL_SWITCH] !== true;
}

/**
 * Ω_policy in milli-CU, resolved from `cost.policy.max_total_credit` — a value
 * `config/derived.js` derives once, at snapshot build time, from every `C_policy`
 * adjustment's declared credit ceiling (§8.6). A publish that cannot derive it (no
 * adjustment declares a usable ceiling) is rejected before it ever reaches a round
 * (§22.1), so a snapshot that reaches this function is expected to resolve cleanly;
 * this function reports the failure rather than assuming a value when it does not.
 *
 * @param {{ resolve: (name: string, context?: object, options?: object) => * }} snapshot
 * @param {object} [context] scope context, as `config/resolver.js` defines it
 * @returns {{ ok: boolean, milliCU: bigint|null, cu: number|null, problems: string[] }}
 */
function omegaPolicyMilliCU(snapshot, context) {
  if (!snapshot || typeof snapshot.resolve !== "function") {
    return { ok: false, milliCU: null, cu: null, problems: ["no config snapshot with a resolve() method"] };
  }

  let value;
  try {
    value = snapshot.resolve("cost.policy.max_total_credit", context);
  } catch (error) {
    return {
      ok: false,
      milliCU: null,
      cu: null,
      problems: [`cost.policy.max_total_credit did not resolve: ${error.message}`],
    };
  }

  if (!isFiniteNumber(value) || value < 0) {
    return {
      ok: false,
      milliCU: null,
      cu: null,
      problems: [
        "cost.policy.max_total_credit resolved to no usable non-negative value. Every C_policy " +
          "adjustment must declare a credit ceiling for this to derive (§8.6, §6.4)",
      ],
    };
  }

  return { ok: true, milliCU: toMilliCU(value), cu: value, problems: [] };
}

/**
 * Ω_terminal in milli-CU. Callers on the Tier 0/1 side of the boundary never compute
 * the CU figure themselves — see the module docstring — they either pass what the
 * Tier 2 composition root supplied, or nothing when `opportunity_cost_term` is
 * thrown.
 *
 * @param {object} input
 * @param {{ killSwitchState?: Record<string, boolean> }} input.snapshot the round's
 *   config snapshot, read only for the kill-switch state
 * @param {number} [input.omegaTerminalCu] the CU figure `pricing/vTerminal.
 *   omegaTerminal()` produced this round, supplied by the composition root. Required
 *   exactly when the opportunity term is active; ignored otherwise.
 * @returns {{ ok: boolean, milliCU: bigint|null, cu: number, active: boolean, problems: string[] }}
 */
function omegaTerminalMilliCU(input) {
  const source = input || {};
  const active = opportunityTermActive(source.snapshot);

  if (!active) {
    // No correction is owed: C_opportunity contributes nothing to Φ this round, so
    // there is no negative term for Ω_terminal to bound.
    return { ok: true, milliCU: assertInt64(0n, "omegaTerminalMilliCU"), cu: 0, active: false, problems: [] };
  }

  if (!isFiniteNumber(source.omegaTerminalCu) || source.omegaTerminalCu < 0) {
    return {
      ok: false,
      milliCU: null,
      cu: 0,
      active: true,
      problems: [
        `${OPPORTUNITY_KILL_SWITCH} is active this round but no non-negative omegaTerminalCu was ` +
          "supplied. C_opportunity may be negative whenever this term is registered, and an admissible " +
          "bound cannot omit its correction while the term is live (§6.4, I20)",
      ],
    };
  }

  return { ok: true, milliCU: toMilliCU(source.omegaTerminalCu), cu: source.omegaTerminalCu, active: true, problems: [] };
}

/**
 * Both Ω corrections together, as `LB(a, l)` consumes them: one combined,
 * non-negative milli-CU quantity to subtract, plus the per-term detail for the
 * decision record.
 *
 * @param {object} input
 * @param {object} input.snapshot
 * @param {object} [input.context]
 * @param {number} [input.omegaTerminalCu]
 * @returns {{ ok: boolean, milliCU: bigint|null, correctionMilliCU: bigint|null,
 *   breakdown: object|null, policy: object, terminal: object, problems: string[] }}
 *
 * ── Why `milliCU` is the field name, and `correctionMilliCU` only its alias ──
 * `lowerBound()` and `expansion.unexploredRingFloorMilliCU()` both read
 * `correction.milliCU` and reject anything else — that is the contract
 * `lowerBound()`'s own `@param` already states ("`{ milliCU: bigint, breakdown?: object }`
 * ... from `candidates/omega.combinedCorrection()`"). This function used to return
 * the quantity under `correctionMilliCU` alone, so every real composition of the
 * two — the only one that existed, `diagnostics.controller.getLegCandidates` —
 * handed `lowerBound()` an object whose `.milliCU` was `undefined`, and the bound
 * failed to resolve on every agent, every request. No test caught it because every
 * fixture built the `{ milliCU }` object by hand instead of calling this function
 * (`tests/engine/helpers/candidateFixture.zeroCorrection`). The producer now
 * satisfies the consumer's contract directly; `correctionMilliCU` is retained so
 * nothing reading the old name breaks.
 */
function combinedCorrection(input) {
  const source = input || {};
  const policy = omegaPolicyMilliCU(source.snapshot, source.context);
  const terminal = omegaTerminalMilliCU({ snapshot: source.snapshot, omegaTerminalCu: source.omegaTerminalCu });

  const problems = [...policy.problems, ...terminal.problems];
  if (!policy.ok || !terminal.ok) {
    // `milliCU: null` keeps the failure fail-closed at the consumer too: a
    // non-bigint is exactly what `lowerBound()`/`unexploredRingFloorMilliCU()`
    // refuse, so an unresolved Ω can never be silently read as "no correction".
    return { ok: false, milliCU: null, correctionMilliCU: null, breakdown: null, policy, terminal, problems };
  }

  const milliCU = assertInt64(policy.milliCU + terminal.milliCU, "combinedCorrection");
  return {
    ok: true,
    milliCU,
    correctionMilliCU: milliCU,
    breakdown: Object.freeze({
      omegaPolicyMilliCU: policy.milliCU,
      omegaPolicyCu: policy.cu,
      omegaTerminalMilliCU: terminal.milliCU,
      omegaTerminalCu: terminal.cu,
      opportunityTermActive: terminal.active,
    }),
    policy,
    terminal,
    problems: [],
  };
}

module.exports = {
  OPPORTUNITY_KILL_SWITCH,
  opportunityTermActive,
  omegaPolicyMilliCU,
  omegaTerminalMilliCU,
  combinedCorrection,
};

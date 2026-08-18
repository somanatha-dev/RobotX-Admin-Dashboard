"use strict";

/**
 * `Φ(plan)` — the cost functional (§8.1). **Tier 1.**
 *
 * ```
 * Φ(plan) =  C_direct(plan) + C_opportunity(plan) + C_risk(plan)
 *          + C_lifecycle(plan) + C_policy(plan)
 *          + Σ        C_delay[l]( completion_time(l, plan) )
 *         l ∈ legs(plan)
 * ```
 *
 * > where `legs(plan)` is **every** Leg the plan executes — the Legs being newly inserted
 * > *and* the Legs the agent had already committed.
 *
 * That clause is the whole reason `Φ` is a functional over plans rather than a score over
 * pairings, and two consequences follow immediately, both load-bearing:
 *
 * > **The pairing cost is the degenerate case.** For an idle agent `a` and a single Leg
 * > `l`, `plan₀(a)` is empty and `γ = Φ(plan with l) = Cost(a,l)` … Nothing about the
 * > single-mission case becomes more complicated.
 *
 * > **Insertion is priced correctly and automatically.** For an occupied agent, `Φ(plan(c))`
 * > includes the delay that inserting a new Leg imposes on the agent's existing Legs, the
 * > extra energy, the extra wear, and the altered terminal state. **There is no separate
 * > "insertion cost model" that could disagree with the cost model**; there is one
 * > functional evaluated at two plans (§13.3).
 *
 * ── What this module contains none of ──────────────────────────────────────
 * > The reader should note what this does **not** contain: no normalisation, no rescaling,
 * > no relative ranking. Each addend is an estimate of a real quantity of resource consumed
 * > or value destroyed.
 *
 * There is no `normalize()` here and no path to one; `units.refuseNormalisation()` exists
 * as the explicit failure a contributor meets if they reintroduce the baseline's habit of
 * rescaling each candidate set into [0, 1] before weighting. The phase's test suite scans
 * this module and its five siblings for min-max, rank, and z-score arithmetic.
 *
 * ── How the Tier 2 opportunity term reaches a Tier 1 functional ────────────
 * `C_opportunity` is Tier 2 (T2-06, kill switch `opportunity_cost_term`) and this module
 * is Tier 1, so §1.8 rule 2 forbids a static import — and the build gate enforces it. The
 * compliant pattern the gate's own documentation names is dependency inversion:
 *
 * > The Tier 2 module registers itself with, or is injected into, the Tier 1 module. **A
 * > Tier 2 mechanism statically linked into the Tier 1 path is a kill switch that cannot
 * > actually be thrown.**
 *
 * So `registerTerm()` is the seam. With nothing registered, `Φ` is exactly the Tier 1
 * functional — five terms instead of six — and it says so in its breakdown rather than
 * reporting a zero that could be mistaken for "the opportunity cost happened to be nil".
 * That distinction matters: §22.5 requires the disabled behaviour to be a complete, tested
 * Tier 1 behaviour, not a silently truncated Tier 2 one.
 *
 * ── The distance-wear attribution rule ─────────────────────────────────────
 * §8.2's `C_direct` and §8.5's `C_lifecycle` both state
 * `cost.wear.cu_per_metre[class] · d_mission`. Summing both as written charges one
 * registered exchange rate twice, which doubles the fleet's modelled wear cost and is the
 * failure §1.3's unit discipline exists to prevent. `Φ` charges it **once, in
 * `C_lifecycle`**, and `assertWearChargedOnce()` proves the property from the two
 * breakdowns rather than trusting the call site.
 *
 * This is a specification ambiguity, not an implementation preference. It is recorded as
 * such in the Phase 8 report; the resolution here is the conservative one — charge the
 * registered rate the number of times the register says it is worth — and the alternative
 * (that §8.2 and §8.5 price two different wear mechanisms that happen to share a
 * coefficient name) would require §8.10 to register two rates, which it does not.
 *
 * ── What a violated declaration does ───────────────────────────────────────
 * §8.1 declares each term's sign and, where it may be negative, its bound, because §6.4's
 * pruning bound is admissible only while those declarations hold. `evaluate()` therefore
 * **refuses** a plan whose terms violate them, rather than returning the value with a note:
 * `problems` has no consumer anywhere in `src/`, so a note there reached nothing, while
 * `ok: false` reaches `plan/columnBuilder.js`, which prunes the column and records the
 * reason in the decision record. In development and test the same finding additionally
 * throws (`escalationEnabled()`), which is the escalation the Phase 8 checklist asks for
 * "at runtime in dev/test".
 *
 * A `BOUNDED_BELOW` term whose bound was not supplied at all is reported as a missing
 * input by name, the way every other unresolved input in this module is.
 *
 * ── Integer arithmetic throughout ──────────────────────────────────────────
 * Every addend arrives as `BigInt` milli-CU and the sum is exact and order-independent
 * (§9.6 requirement 1). No float ever enters `Φ` itself; the conversions happen inside the
 * term modules at their single boundary.
 *
 * T1 (§1.5, I14): `evaluate()` asserts the feasibility brand, so `Φ` is structurally
 * incapable of pricing a candidate the gate did not admit. Determinism: no clock, no
 * randomness, no store.
 */

const { assertFeasible } = require("../guards/tenets");
const { milli, ZERO, total, assertCost } = require("./units");
const signDiscipline = require("./signDiscipline");
const cDirect = require("./cDirect");
const cRisk = require("./cRisk");
const cLifecycle = require("./cLifecycle");
const cPolicy = require("./cPolicy");
const cDelay = require("./cDelay");

/**
 * The five terms `Φ` computes itself, in §8.1's order.
 * @structural §8.1's own term list, less the registered ones
 */
const CORE_TERMS = Object.freeze(["C_direct", "C_risk", "C_lifecycle", "C_policy", "C_delay"]);

/**
 * The terms that arrive by registration because their mechanisms are Tier 2.
 * @structural the Tier 2 terms §1.8 names, keyed by the slot they register into
 */
const REGISTRABLE_TERMS = Object.freeze({
  /** §8.3, T2-06, kill switch `opportunity_cost_term`. A term of `Φ`. */
  C_opportunity: Object.freeze({
    killSwitch: "opportunity_cost_term",
    scope: "PLAN",
    degradesTo:
      "λ_zone from configured static per-zone, per-bucket priors; the derivation of §8.3 is unchanged, " +
      "only its input source is (§5.2). With no evaluator registered at all, Φ omits the term and " +
      "reports the omission",
  }),
  /** §8.9, T2-07, kill switch `churn_pricing`. A term of the **column price**, not of `Φ`. */
  C_churn: Object.freeze({
    killSwitch: "churn_pricing",
    scope: "COLUMN",
    degradesTo: "reassignment priced without a churn term",
  }),
});

/**
 * The registry. Module-scoped and mutable by design: this is the injection seam, and a
 * per-call parameter would not satisfy §22.5 rule 1, since a caller could then supply a
 * Tier 2 evaluator whatever the switch said.
 */
const registered = new Map();

/**
 * Register a Tier 2 term evaluator.
 *
 * @param {string} term one of `REGISTRABLE_TERMS`
 * @param {(plan: object, input: object) => {ok: boolean, milliCU: bigint|null}} evaluator
 * @returns {void}
 */
function registerTerm(term, evaluator) {
  if (!Object.prototype.hasOwnProperty.call(REGISTRABLE_TERMS, term)) {
    throw new Error(
      `"${term}" is not a registrable term. Φ's five core terms are computed directly; only the Tier 2 ` +
        `terms ${Object.keys(REGISTRABLE_TERMS).join(", ")} arrive by registration, because §1.8 rule 2 ` +
        "forbids a Tier 1 module from statically importing a Tier 2 mechanism.",
    );
  }
  if (typeof evaluator !== "function") {
    throw new TypeError(`registerTerm("${term}") requires an evaluator function`);
  }
  registered.set(term, evaluator);
}

/**
 * Remove a registration — the state a thrown kill switch produces.
 *
 * @param {string} [term] omitted, clears every registration
 * @returns {void}
 */
function clearTerms(term) {
  if (term === undefined) registered.clear();
  else registered.delete(term);
}

/**
 * Which optional terms are currently registered, for the decision record.
 *
 * @returns {string[]}
 */
function registeredTerms() {
  return [...registered.keys()].sort();
}

/**
 * Read a registered evaluator, for a caller composing the column price.
 *
 * @param {string} term
 * @returns {Function|null}
 */
function evaluatorFor(term) {
  return registered.get(term) || null;
}

/**
 * Is the throwing escalation of §8.1's sign discipline enabled in this environment?
 *
 * The Phase 8 checklist requires the declared signs and lower bounds to be asserted "at
 * runtime **in dev/test**", and `signDiscipline.js`'s own docstring says `assertOrThrow()`
 * "is the escalation the development and test environments enable". Neither was true as
 * shipped: nothing under `src/` called it in any environment.
 *
 * Enabled on an *explicit* `test` or `development` value only. An unset `NODE_ENV` is
 * common in production deployments, so treating "not production" as "development" would
 * turn a reporting path into a throwing one exactly where throwing is least wanted — the
 * failure direction §22.5 rule 1 tells this engine to avoid.
 *
 * @returns {boolean}
 */
function escalationEnabled() {
  const environment = process.env.NODE_ENV;
  return environment === "test" || environment === "development";
}

/**
 * Escalate a sign-discipline or attribution finding where the environment enables it.
 *
 * @param {string[]} findings
 * @returns {void}
 * @throws {RangeError} in development and test
 */
function escalate(findings) {
  if (findings.length === 0 || !escalationEnabled()) return;
  throw new RangeError(
    `cost/phi.evaluate: ${findings.join(" | ")}. §8.1 declares every term's sign and, where it may be ` +
      "negative, its bound; §6.4's pruning bound is admissible only because those declarations hold. " +
      "This throws in development and test and is reported as an unpriceable candidate in production.",
  );
}

/**
 * The bound each `BOUNDED_BELOW` term needs, checked before the term is summed.
 *
 * `signDiscipline.check()` already refuses a `BOUNDED_BELOW` term whose bound was not
 * supplied — "an unbounded negative term cannot be pruned against" — but Φ used to record
 * that refusal in `problems` and still return `ok: true`, so a caller that simply omitted
 * `bounds` got a priced column carrying no admissibility guarantee at all. An absent bound
 * is a missing *input*, not an anomaly in a computed value, so it is reported the way every
 * other missing input in this module is: by name, with `ok: false`. `cOpportunity.evaluate`
 * already refuses an absent `Ω_terminal` on exactly this reasoning.
 *
 * @param {string[]} terms the term names Φ will sum
 * @param {object} [bounds]
 * @returns {string[]} missing bound names
 */
function missingBoundsFor(terms, bounds) {
  const supplied = bounds || {};
  const missing = [];
  for (const term of terms) {
    const declaration = signDiscipline.DECLARATIONS[term];
    if (!declaration || declaration.sign !== signDiscipline.SIGN.BOUNDED_BELOW) continue;
    const field = signDiscipline.BOUND_FIELD[term];
    if (typeof supplied[field] !== "bigint") {
      missing.push(
        `bounds.${field} — ${term} may be negative and is bounded below by ${declaration.bound}. ` +
          "§6.4 subtracts exactly that quantity to keep the pruning bound admissible, so pricing " +
          "without it produces a cost no bound covers",
      );
    }
  }
  return missing;
}

/**
 * Prove that `cost.wear.cu_per_metre · d_mission` is charged exactly once.
 *
 * @param {object} directBreakdown from `cDirect.evaluate()`
 * @param {object} lifecycleBreakdown from `cLifecycle.evaluate()`
 * @param {bigint} directMilliCU the value Φ actually summed for `C_direct`
 * @returns {{ ok: boolean, chargedIn: string[], problems: string[] }}
 */
function assertWearChargedOnce(directBreakdown, lifecycleBreakdown, directMilliCU) {
  const problems = [];
  const chargedIn = [];

  const inDirect = (directBreakdown && directBreakdown.distanceWear) || null;
  const inLifecycle = (lifecycleBreakdown && lifecycleBreakdown.distanceWear) || null;

  if (!inDirect || typeof inDirect.milliCU !== "bigint" || typeof directMilliCU !== "bigint") {
    return {
      ok: false,
      chargedIn,
      problems: ["the C_direct breakdown does not report its distance-wear addend, so the attribution cannot be checked"],
    };
  }

  if (inLifecycle && typeof inLifecycle.milliCU === "bigint") chargedIn.push("C_lifecycle");

  // Whether `C_direct` charged it is decided by what Φ actually summed, not by what
  // `cDirect` reported: the module returns the addend either way, and the question here is
  // whether it entered the total. The two candidate totals differ by exactly the addend.
  const energyMilliCU = directBreakdown.energy ? directBreakdown.energy.milliCU : 0n;
  const withoutWear = directBreakdown.timeMilliCU + energyMilliCU;
  const withWear = withoutWear + inDirect.milliCU;

  if (directMilliCU === withWear && inDirect.milliCU !== 0n) chargedIn.push("C_direct");
  else if (directMilliCU !== withoutWear) {
    problems.push(
      `Φ summed ${directMilliCU} milli-CU for C_direct, which is neither its time-plus-energy total ` +
        `(${withoutWear}) nor that total with the distance-wear addend (${withWear}). The attribution ` +
        "of cost.wear.cu_per_metre · d_mission cannot be established.",
    );
  }

  if (chargedIn.length !== 1) {
    problems.push(
      `cost.wear.cu_per_metre · d_mission is charged in [${chargedIn.join(", ") || "no term"}]. §8.2 and ` +
        "§8.5 both state the expression; Φ charges the registered rate exactly once, in C_lifecycle. " +
        "Charging it twice doubles a registered exchange rate (§1.3); charging it not at all leaves " +
        "distance wear unpriced and removes the basis §17.1 levels wear on.",
    );
  }

  return { ok: problems.length === 0, chargedIn, problems };
}

/**
 * `Φ(plan)`.
 *
 * @param {object} plan the branded plan the feasibility gate admitted
 * @param {object} input
 * @param {object} input.direct arguments for `cDirect.evaluate()`
 * @param {object} input.risk arguments for `cRisk.evaluate()`
 * @param {object} input.lifecycle arguments for `cLifecycle.evaluate()`
 * @param {object} input.policy arguments for `cPolicy.evaluate()`
 * @param {Record<string, number>} input.completionByLegId from `plan/timeline.legCompletions()`
 * @param {(legId: string) => object} input.delayParametersFor
 * @param {object} [input.opportunity] arguments for a registered `C_opportunity` evaluator
 * @param {object} [input.bounds] `{ omegaTerminalMilliCU, omegaPolicyMilliCU }` for the
 *   sign-discipline check
 * @returns {{ ok: boolean, milliCU: bigint|null, breakdown: object|null,
 *             signDiscipline: object|null, omittedTerms: object[], missing: string[],
 *             problems: string[] }}
 */
function evaluate(plan, input) {
  assertFeasible(plan, "cost/phi.evaluate");

  const source = input || {};
  const missing = [];
  const problems = [];
  const perTerm = Object.create(null);
  const detail = Object.create(null);
  const omittedTerms = [];

  const direct = cDirect.evaluate(plan, source.direct);
  if (!direct.ok) missing.push(...direct.missing.map((name) => `C_direct: ${name}`));

  const risk = cRisk.evaluate(plan, source.risk);
  if (!risk.ok) missing.push(...risk.missing.map((name) => `C_risk: ${name}`));

  const lifecycle = cLifecycle.evaluate(plan, source.lifecycle);
  if (!lifecycle.ok) missing.push(...lifecycle.missing.map((name) => `C_lifecycle: ${name}`));

  const policy = cPolicy.evaluate(plan, source.policy);
  if (!policy.ok) missing.push(...policy.missing.map((name) => `C_policy: ${name}`));

  // Every Leg the plan executes, committed ones included. `plan.legs` is the Plan
  // Builder's own list and includes them by construction; `cDelay.forPlan` sums over it.
  const delay = cDelay.forPlan(plan, source.completionByLegId, source.delayParametersFor);
  if (!delay.ok) missing.push(...delay.missing.map((name) => `C_delay: ${name}`));

  // The bounds the `BOUNDED_BELOW` terms of this evaluation need. `C_policy` is always
  // summed; `C_opportunity` is summed only when its Tier 2 evaluator is registered, so an
  // unregistered term requires no bound — the omission is recorded instead.
  missing.push(
    ...missingBoundsFor(
      registered.has("C_opportunity") ? ["C_policy", "C_opportunity"] : ["C_policy"],
      source.bounds,
    ),
  );

  if (missing.length > 0) {
    return {
      ok: false,
      milliCU: null,
      breakdown: null,
      signDiscipline: null,
      omittedTerms,
      missing: [...new Set(missing)],
      problems,
    };
  }

  perTerm.C_direct = direct.milliCU;
  perTerm.C_risk = risk.milliCU;
  perTerm.C_lifecycle = lifecycle.milliCU;
  perTerm.C_policy = policy.milliCU;
  perTerm.C_delay = delay.milliCU;

  detail.C_direct = direct.breakdown;
  detail.C_risk = risk.breakdown;
  detail.C_lifecycle = lifecycle.breakdown;
  detail.C_policy = Object.freeze({ records: policy.records, refusals: policy.refusals });
  detail.C_delay = Object.freeze({ perLeg: delay.perLeg, terminalLegCount: delay.terminalLegCount });

  const wear = assertWearChargedOnce(direct.breakdown, lifecycle.breakdown, direct.milliCU);
  if (!wear.ok) problems.push(...wear.problems);

  // ── The registered Tier 2 term ────────────────────────────────────────────
  const opportunityEvaluator = registered.get("C_opportunity");
  if (opportunityEvaluator) {
    const opportunity = opportunityEvaluator(plan, source.opportunity);
    if (!opportunity || !opportunity.ok || typeof opportunity.milliCU !== "bigint") {
      return {
        ok: false,
        milliCU: null,
        breakdown: null,
        signDiscipline: null,
        omittedTerms,
        missing: (opportunity && (opportunity.missing || opportunity.problems)) || ["C_opportunity"],
        problems,
      };
    }
    perTerm.C_opportunity = opportunity.milliCU;
    detail.C_opportunity = opportunity.breakdown || null;
  } else {
    omittedTerms.push({
      term: "C_opportunity",
      killSwitch: REGISTRABLE_TERMS.C_opportunity.killSwitch,
      degradesTo: REGISTRABLE_TERMS.C_opportunity.degradesTo,
      note:
        "no evaluator is registered, so Φ is the five-term Tier 1 functional. This is recorded rather " +
        "than summed as zero: a zero would be indistinguishable from an opportunity cost that happened " +
        "to be nil, and the two mean opposite things when reading a decision record.",
    });
  }

  const checked = signDiscipline.checkBreakdown(perTerm, source.bounds);
  if (!checked.ok) problems.push(...checked.findings);

  // ── The escalation §8.1 requires, and the failure it produces ─────────────
  // A term beneath its declared floor, or a distance-wear rate charged twice, makes the
  // priced value one §6.4's bound does not cover. Returning it with `ok: true` and a note
  // in `problems` was the shipped behaviour, and `problems` has no consumer anywhere in
  // `src/` — so the anomaly reached no decision record and no operator. `ok: false` puts
  // it on the one path that *is* recorded: `plan/columnBuilder.js` prunes an unpriceable
  // column and carries the reason into the decision record, so the round proceeds on its
  // remaining candidates and the refusal is auditable rather than silent.
  if (problems.length > 0) {
    escalate(problems);
    return {
      ok: false,
      milliCU: null,
      breakdown: null,
      signDiscipline: checked,
      omittedTerms,
      missing: [],
      problems,
    };
  }

  const summed = total(...Object.keys(perTerm).sort().map((term) => milli(perTerm[term])));
  assertCost(summed, "cost/phi.evaluate");

  return {
    ok: true,
    milliCU: summed.milliCU,
    breakdown: Object.freeze({
      terms: Object.freeze({ ...perTerm }),
      detail: Object.freeze(detail),
      termsSummed: Object.keys(perTerm).sort(),
      legCount: (plan.legs || []).length,
      committedLegCount: (plan.legs || []).filter((leg) => leg && leg.committed === true).length,
      wearAttribution: Object.freeze({ chargedIn: wear.chargedIn }),
    }),
    signDiscipline: checked,
    omittedTerms,
    missing: [],
    problems,
  };
}

/**
 * `Φ` of the empty plan: zero, by construction.
 *
 * §8.1's degenerate case — "for an idle agent `a` and a single Leg `l`, `plan₀(a)` is
 * empty and `γ = Φ(plan with l) = Cost(a,l)`" — needs `Φ(∅) = 0` to hold exactly, in
 * integer milli-CU, so that the column price of a fresh assignment is the plan's own cost
 * with no residue. It is a named function rather than a literal at the call site so the
 * property has somewhere to be tested.
 *
 * @returns {{ ok: boolean, milliCU: bigint, breakdown: object }}
 */
function empty() {
  return {
    ok: true,
    milliCU: ZERO.milliCU,
    breakdown: Object.freeze({
      terms: Object.freeze({}),
      termsSummed: [],
      legCount: 0,
      committedLegCount: 0,
      note: "Φ(∅) = 0 exactly, which is what makes γ(c) = Φ(plan(c)) for an idle agent (§8.1)",
    }),
  };
}

module.exports = {
  CORE_TERMS,
  REGISTRABLE_TERMS,
  registerTerm,
  clearTerms,
  registeredTerms,
  evaluatorFor,
  escalationEnabled,
  missingBoundsFor,
  assertWearChargedOnce,
  evaluate,
  empty,
};

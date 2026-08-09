"use strict";

/**
 * **F23 — Dimensional and volumetric packing feasible.** Class I. Indeterminate:
 * `DENY`.
 *
 * > A parcel that does not physically fit cannot be carried; tiered check in §15.3.
 *
 * ── Why a mass limit is not enough ──────────────────────────────────────────
 * §15.2 states the case in one line: *"a capacity scalar is insufficient: a 20 kg limit
 * tells you nothing about whether two 40 cm boxes fit through a 30 cm hatch."* F22
 * bounds the mass; F23 bounds the geometry, and the **aperture** is modelled separately
 * from the internal dimension because it is a distinct and frequently binding
 * constraint that a volume-based model misses entirely.
 *
 * ── The four tiers of §15.3, and what each verdict means here ───────────────
 * The tiered evaluation is `engine/payload/packing.js` (Phase 7). It escalates from
 * cheap sufficient conditions to an explicit placement search, and its budget can be
 * exhausted. This predicate consumes the verdict and maps it:
 *
 *   | Packing verdict        | F23 outcome     | Why |
 *   |---|---|---|
 *   | `FEASIBLE`             | `SATISFIED`     | a placement exists |
 *   | `INFEASIBLE`           | `VIOLATED`      | no placement exists |
 *   | `BUDGET_EXHAUSTED`     | `INDETERMINATE` | §15.3 tier 3 — the search ran out of budget before deciding, which is *not* evidence that no placement exists, and is not evidence that one does |
 *
 * The execution plan states the tier-3 mapping explicitly as a Phase 7 completion
 * criterion — *"packing tiers 1–4 implemented with `INDETERMINATE`/`DENY` on tier-3
 * budget exhaustion"* — and this is the `DENY` half of it, applied through the class I
 * policy rather than written into the packing search.
 *
 * ── The seam ────────────────────────────────────────────────────────────────
 * Until Phase 7 lands, `plan.packing` is absent and this predicate returns
 * `INDETERMINATE`. Deciding packing feasibility here would be implementing §15.3 in
 * the wrong module.
 *
 * Tier 0 (T0-01, T0-04).
 */

const tv = require("../threeValued");

/**
 * §15.3's packing verdicts, as produced by the tiered evaluation.
 * @structural the specification's own packing outcomes
 */
const PACKING_VERDICT = Object.freeze({
  FEASIBLE: "FEASIBLE",
  INFEASIBLE: "INFEASIBLE",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
});

const REQUIRED = "a physically realisable placement of every item (§15.3)";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const plan = (context && context.plan) || null;
  if (!plan) return tv.absent("the candidate plan", { required: REQUIRED });

  const packing = plan.packing;
  if (packing === undefined) {
    return tv.absent("the plan's packing result (§15.3)", {
      required: REQUIRED,
      inputSource: "PLAN",
      reason:
        "no tiered packing evaluation is attached to this plan. §15.3's tiered check is " +
        "engine/payload/packing.js (Phase 7); deciding packing feasibility here would implement " +
        "it in the wrong module",
    });
  }
  if (packing === null || typeof packing !== "object") {
    return tv.indeterminate({ required: REQUIRED, inputSource: "PLAN", reason: "the packing result is unreadable" });
  }

  const verdict = packing.verdict;

  if (verdict === PACKING_VERDICT.BUDGET_EXHAUSTED) {
    return tv.indeterminate({
      observed: { verdict, tier: packing.tier === undefined ? null : packing.tier },
      required: REQUIRED,
      inputSource: "PLAN",
      reason:
        "the tier-3 placement search exhausted its budget before deciding (§15.3). Budget " +
        "exhaustion is not evidence that no placement exists, and it is not evidence that one does",
    });
  }

  if (verdict === PACKING_VERDICT.INFEASIBLE) {
    return tv.violated({
      observed: {
        verdict,
        tier: packing.tier === undefined ? null : packing.tier,
        binding: packing.bindingConstraint === undefined ? null : packing.bindingConstraint,
      },
      required: REQUIRED,
      inputSource: "PLAN",
      reason:
        `no placement exists for this load${packing.bindingConstraint ? `; binding constraint: ${packing.bindingConstraint}` : ""} ` +
        "(§7.5 F23, §15.3). The aperture is modelled separately from the internal dimension because " +
        "it is a distinct and frequently binding constraint",
    });
  }

  if (verdict !== PACKING_VERDICT.FEASIBLE) {
    return tv.indeterminate({
      observed: { verdict: verdict === undefined ? null : String(verdict) },
      required: REQUIRED,
      inputSource: "PLAN",
      reason: `packing verdict "${String(verdict)}" is not one of ${Object.keys(PACKING_VERDICT).join(", ")}`,
    });
  }

  return tv.satisfied({
    observed: { verdict, tier: packing.tier === undefined ? null : packing.tier },
    required: REQUIRED,
    inputSource: "PLAN",
  });
}

module.exports = { evaluate, PACKING_VERDICT };

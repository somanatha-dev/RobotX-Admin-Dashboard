"use strict";

/**
 * `C_policy` — explicit business intent (§8.6). **Tier 1.**
 *
 * > A named, individually-auditable adjustment for intent that is not derivable from
 * > physics. **Every adjustment MUST declare a credit ceiling** — the largest negative
 * > value it may contribute — because those ceilings are what make the candidate-pruning
 * > lower bound admissible (§6.4). An adjustment without a declared ceiling is rejected at
 * > configuration publish time.
 *
 * > Every entry is individually reported in the decision record. A policy adjustment that
 * > cannot be named and attributed is prohibited; this is where undisciplined systems
 * > accumulate their magic constants, **so the register itself is the control**.
 *
 * The register is `ADJUSTMENTS` below: five entries, each naming the ceiling parameter
 * §8.6's table gives it. Adding a sixth adjustment means adding a row here *and* a
 * register entry with `creditCeiling: true`, and `config/derived.js` then folds the new
 * ceiling into `Ω_policy` automatically —
 *
 * > Introducing a new policy adjustment therefore updates the pruning bound as a
 * > mechanical consequence of registering it, which is what prevents the bound from
 * > silently decaying as the policy register grows — **the most likely way an admissible
 * > bound becomes inadmissible over a system's life.**
 *
 * `assertRegisterCoverage()` is the other half of that guarantee: it checks that every
 * adjustment this module knows about is one `Ω_policy` was actually computed from. A row
 * added here and not registered would contribute a credit the bound does not cover.
 *
 * ── Two rules enforced at evaluation, not only at publish ──────────────────
 * **A credit may not exceed its own ceiling.** Publish-time validation (V2, Phase 1)
 * checks that ceilings are declared and non-negative; it cannot check that a *runtime*
 * adjustment respects the one it declared, because the adjustment's value arrives with the
 * candidate. So each is clamped and the clamping is reported, rather than the sum being
 * quietly allowed past `−Ω_policy` — which would invalidate §6.4's bound for that round.
 *
 * **A pilot adjustment past its expiry is refused.** §8.6: "MUST carry an expiry, and the
 * engine MUST refuse an adjustment whose expiry has passed." Refused, not ignored: an
 * expired experiment still influencing allocation is the failure mode the expiry exists
 * for, and silently dropping it would leave nothing in the record to notice.
 *
 * T1: entry point asserts the feasibility brand. Determinism: the expiry is compared
 * against the round's pinned decision time, never a clock.
 */

const { assertFeasible } = require("../guards/tenets");
const { cu, milli, ZERO, total } = require("./units");
const { compareStrings } = require("../determinism/ordering");

/**
 * §8.6's table, as data. Each row names the adjustment, its purpose, and the register
 * entry that caps the credit it may contribute.
 * @structural §8.6's own five-row register
 */
const ADJUSTMENTS = Object.freeze([
  Object.freeze({
    id: "ZONE_AFFINITY",
    ceilingParameter: "policy.max_zone_affinity_credit",
    purpose:
      "retains the baseline's zone-locality preference, now priced in CU rather than as a 0.05 " +
      "additive constant, and applied where the operational reason is real (local knowledge, permit " +
      "familiarity, supervision coverage)",
    requiresExpiry: false,
  }),
  Object.freeze({
    id: "DEDICATED_FLEET",
    ceilingParameter: "policy.max_dedicated_fleet_credit",
    purpose: "steers a tenant's contractually dedicated agents to that tenant's work",
    requiresExpiry: false,
  }),
  Object.freeze({
    id: "BURN_IN",
    ceilingParameter: "policy.max_burn_in_credit",
    purpose:
      "directs new agents or new firmware to low-risk work during a probation window, with a " +
      "configured decay",
    requiresExpiry: false,
  }),
  Object.freeze({
    id: "PILOT",
    ceilingParameter: "policy.max_pilot_adjustment",
    purpose: "scoped, expiring adjustments for controlled trials",
    requiresExpiry: true,
  }),
  Object.freeze({
    id: "OPERATOR",
    ceilingParameter: "policy.max_operator_adjustment",
    purpose:
      "an authorised, reasoned, audited nudge — bounded so that it can influence choice among " +
      "feasible agents but never dominate the objective",
    requiresExpiry: false,
  }),
]);

const ADJUSTMENT_BY_ID = Object.freeze(
  Object.fromEntries(ADJUSTMENTS.map((adjustment) => [adjustment.id, adjustment])),
);

/** Why an adjustment was not applied as offered. */
const DISPOSITION = Object.freeze({
  APPLIED: "APPLIED",
  CLAMPED_TO_CEILING: "CLAMPED_TO_CEILING",
  REFUSED_EXPIRED: "REFUSED_EXPIRED",
  REFUSED_UNREGISTERED: "REFUSED_UNREGISTERED",
  REFUSED_NO_CEILING: "REFUSED_NO_CEILING",
  REFUSED_UNATTRIBUTED: "REFUSED_UNATTRIBUTED",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {object|Map} config
 * @param {string} name
 * @returns {*}
 */
function readParameter(config, name) {
  if (!config) return undefined;
  if (config instanceof Map) return config.get(name);
  return config[name];
}

/**
 * Check that `Ω_policy` was derived from exactly this module's adjustment register.
 *
 * The evidence `config/derived.js` publishes carries the ceilings it actually summed, keyed
 * by parameter name (`derivationEvidence.policyTotalCredit.ceilings`). Reading the summed
 * set rather than the register's declared input list is deliberate: the question is what the
 * derivation *did*, not what it was configured to do, and those two are exactly what could
 * drift apart as the policy register grows — the failure §8.6 calls "the most likely way an
 * admissible bound becomes inadmissible over a system's life".
 *
 * @param {object} derivationEvidence either the whole `snapshot.derivationEvidence` or its
 *   `policyTotalCredit` entry
 * @returns {{ ok: boolean, problems: string[], covered: string[] }}
 */
function assertRegisterCoverage(derivationEvidence) {
  const problems = [];
  const evidence = derivationEvidence || {};
  const entry = evidence.policyTotalCredit || evidence;
  const inputs = new Set([
    ...Object.keys((entry && entry.ceilings) || {}),
    ...(Array.isArray(entry && entry.inputs) ? entry.inputs : []),
  ]);

  for (const adjustment of ADJUSTMENTS) {
    if (!inputs.has(adjustment.ceilingParameter)) {
      problems.push(
        `adjustment ${adjustment.id} declares ceiling "${adjustment.ceilingParameter}", which Ω_policy ` +
          "was not derived from. §6.4's lower bound subtracts Ω_policy to cover every C_policy credit; " +
          "a credit outside the sum is a credit the bound does not cover, and the bound is then " +
          "inadmissible while still advertising a proof (§8.6)",
      );
    }
  }

  return { ok: problems.length === 0, problems, covered: [...inputs].sort() };
}

/**
 * Apply one adjustment, with its ceiling and its expiry.
 *
 * @param {object} adjustment
 * @param {string} adjustment.id one of `ADJUSTMENTS`
 * @param {number} adjustment.cu the offered value; negative is a credit, positive a penalty
 * @param {string} adjustment.reason the audited justification — required, because §8.6
 *   prohibits an adjustment that cannot be named and attributed
 * @param {string} [adjustment.authorisedBy] required for the operator adjustment (§23.6)
 * @param {number} [adjustment.expiresAtMs] required for the pilot adjustment
 * @param {object|Map} config the resolved configuration view
 * @param {number} decisionTimeMs the round's pinned time
 * @returns {{ ok: boolean, milliCU: bigint|null, disposition: string, record: object }}
 */
function applyOne(adjustment, config, decisionTimeMs) {
  const offered = adjustment || {};
  const known = ADJUSTMENT_BY_ID[offered.id];

  if (!known) {
    return {
      ok: false,
      milliCU: null,
      disposition: DISPOSITION.REFUSED_UNREGISTERED,
      record: Object.freeze({
        id: offered.id ?? null,
        disposition: DISPOSITION.REFUSED_UNREGISTERED,
        reason:
          "the adjustment is not in §8.6's register. A policy adjustment that cannot be named and " +
          "attributed is prohibited, and an unregistered one also contributes a credit Ω_policy does " +
          "not cover (§6.4)",
      }),
    };
  }

  if (typeof offered.reason !== "string" || offered.reason.trim() === "") {
    return {
      ok: false,
      milliCU: null,
      disposition: DISPOSITION.REFUSED_UNATTRIBUTED,
      record: Object.freeze({
        id: known.id,
        disposition: DISPOSITION.REFUSED_UNATTRIBUTED,
        reason: "§8.6 prohibits a policy adjustment that cannot be named and attributed; no reason was given",
      }),
    };
  }

  if (known.requiresExpiry) {
    if (!isNumber(offered.expiresAtMs)) {
      return {
        ok: false,
        milliCU: null,
        disposition: DISPOSITION.REFUSED_EXPIRED,
        record: Object.freeze({
          id: known.id,
          disposition: DISPOSITION.REFUSED_EXPIRED,
          reason: "§8.6: a pilot adjustment MUST carry an expiry; none was supplied",
        }),
      };
    }
    if (!isNumber(decisionTimeMs) || offered.expiresAtMs <= decisionTimeMs) {
      return {
        ok: false,
        milliCU: null,
        disposition: DISPOSITION.REFUSED_EXPIRED,
        record: Object.freeze({
          id: known.id,
          disposition: DISPOSITION.REFUSED_EXPIRED,
          expiresAtMs: offered.expiresAtMs,
          decisionTimeMs: isNumber(decisionTimeMs) ? decisionTimeMs : null,
          reason:
            "§8.6: the engine MUST refuse an adjustment whose expiry has passed. Refused rather than " +
            "ignored, so the record shows an expired experiment was offered",
        }),
      };
    }
  }

  const ceiling = readParameter(config, known.ceilingParameter);
  if (!isNumber(ceiling) || ceiling < 0) {
    return {
      ok: false,
      milliCU: null,
      disposition: DISPOSITION.REFUSED_NO_CEILING,
      record: Object.freeze({
        id: known.id,
        disposition: DISPOSITION.REFUSED_NO_CEILING,
        ceilingParameter: known.ceilingParameter,
        reason:
          `"${known.ceilingParameter}" resolves to no non-negative ceiling. §8.6 rejects an adjustment ` +
          "without a declared ceiling at publish time; at evaluation time the same rule refuses it, " +
          "because an uncapped credit is one §6.4's bound cannot account for",
      }),
    };
  }

  if (!isNumber(offered.cu)) {
    return {
      ok: false,
      milliCU: null,
      disposition: DISPOSITION.REFUSED_UNREGISTERED,
      record: Object.freeze({
        id: known.id,
        disposition: DISPOSITION.REFUSED_UNREGISTERED,
        reason: "the adjustment offered no finite CU value",
      }),
    };
  }

  // The ceiling caps the **credit**: the largest negative value the adjustment may
  // contribute. A positive adjustment is a penalty and needs no cap for admissibility —
  // §6.4's bound is a *lower* bound, and a penalty only raises the true cost.
  const clamped = offered.cu < -ceiling ? -ceiling : offered.cu;
  const wasClamped = clamped !== offered.cu;

  return {
    ok: true,
    milliCU: cu(clamped).milliCU,
    disposition: wasClamped ? DISPOSITION.CLAMPED_TO_CEILING : DISPOSITION.APPLIED,
    record: Object.freeze({
      id: known.id,
      disposition: wasClamped ? DISPOSITION.CLAMPED_TO_CEILING : DISPOSITION.APPLIED,
      purpose: known.purpose,
      reason: offered.reason,
      authorisedBy: offered.authorisedBy ?? null,
      offeredCu: offered.cu,
      appliedCu: clamped,
      ceilingParameter: known.ceilingParameter,
      creditCeilingCu: ceiling,
      expiresAtMs: isNumber(offered.expiresAtMs) ? offered.expiresAtMs : null,
    }),
  };
}

/**
 * `C_policy` for one plan: the sum of its named adjustments, each individually reported.
 *
 * @param {object} plan the branded plan
 * @param {object} input
 * @param {object[]} input.adjustments
 * @param {object|Map} input.config
 * @param {number} input.decisionTimeMs
 * @param {number} input.omegaPolicyCu `cost.policy.max_total_credit`, derived at publish
 * @returns {{ ok: boolean, milliCU: bigint|null, records: object[], refusals: object[],
 *             withinOmegaPolicy: boolean|null, missing: string[] }}
 */
function evaluate(plan, input) {
  assertFeasible(plan, "cost/cPolicy.evaluate");

  const source = input || {};
  if (!isNumber(source.omegaPolicyCu) || source.omegaPolicyCu < 0) {
    return {
      ok: false,
      milliCU: null,
      records: [],
      refusals: [],
      withinOmegaPolicy: null,
      missing: ["cost.policy.max_total_credit"],
    };
  }

  // Canonical order so a decision record lists adjustments identically on every run.
  const offered = [...(source.adjustments || [])].sort((a, b) =>
    compareStrings(String((a || {}).id), String((b || {}).id)),
  );

  const records = [];
  const refusals = [];
  let accumulated = ZERO;

  for (const adjustment of offered) {
    const applied = applyOne(adjustment, source.config, source.decisionTimeMs);
    if (!applied.ok) {
      refusals.push(applied.record);
      continue;
    }
    records.push(applied.record);
    accumulated = total(accumulated, milli(applied.milliCU));
  }

  // The per-adjustment clamps make this hold by construction; the check is here because
  // "holds by construction" is the sort of claim that stops being true after an edit, and
  // §6.4's admissibility rests on it.
  const omegaPolicyMilliCU = cu(source.omegaPolicyCu).milliCU;
  const withinOmegaPolicy = accumulated.milliCU >= -omegaPolicyMilliCU;

  return {
    ok: true,
    milliCU: accumulated.milliCU,
    records,
    refusals,
    withinOmegaPolicy,
    omegaPolicyMilliCU,
    missing: [],
  };
}

module.exports = {
  ADJUSTMENTS,
  ADJUSTMENT_BY_ID,
  DISPOSITION,
  readParameter,
  assertRegisterCoverage,
  applyOne,
  evaluate,
};

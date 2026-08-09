"use strict";

/**
 * Admissibility as a build gate (§6.4, §24.1). **Tier 1.**
 *
 * > **Admissibility is a build gate, not a sampled property.** `LB ≤ γ` is verified
 * > by an exhaustive build-time check over the configured parameter space — every
 * > `C_policy` ceiling, every `λ_zone` range, every agent class — and the build
 * > fails if any combination admits `LB > γ`... The check is re-run by the Config
 * > Service at every configuration publish, because admissibility is a joint
 * > property of code and configuration and a new policy credit can break it
 * > without any code change.
 *
 * Two halves, because the admissibility argument itself has two halves:
 *
 *   1. **Register-level prerequisites** — the configured values `LB(a, l)`'s
 *      formula depends on for its four positive components to be genuine
 *      underestimates and its two corrections to be genuine floors. These can
 *      change at every publish, which is exactly why §24.1 requires the check to
 *      re-run then, not only at build time. Two of the three already exist and are
 *      wired into `config/validators.validatePublish()`:
 *        - **A1** (`config/validators.js`) — `cost.lambda_time_floor ≤
 *          cost.lambda_time[class]` for every class, which is what keeps `LB`'s
 *          travel term a genuine underestimate.
 *        - **V2** (`config/validators.js`) — every `C_policy` adjustment declares a
 *          credit ceiling and `cost.policy.max_total_credit` (Ω_policy) is their
 *          exact sum, which is what keeps `LB`'s policy correction a genuine floor.
 *      This module adds the one Phase 9 owns: `Ω_terminal` (when the opportunity
 *      term is active) is never negative — see `checkOmegaNonNegative()`. A
 *      negative `Ω_terminal` would *raise* `LB` instead of lowering it, turning the
 *      correction that keeps the bound admissible into one that breaks it (the
 *      same failure mode `ZonePriceSnapshot_omega_terminal_non_negative` guards at
 *      the database in Phase 8's migration — this is that same property, checked
 *      again where `omega.js` actually consumes the figure).
 *   2. **The formula-level inequality itself** — that `LB`'s four components really
 *      are underestimates of their `γ` counterparts and that subtracting the two
 *      corrections really does preserve `LB ≤ γ`. This is a mathematical property
 *      of the code in `lowerBound.js`, `omega.js`, and `cost/cDelay.js`, not of any
 *      configuration value, so it is exhaustively swept **once, at build time**, by
 *      `tests/engine/candidateAdmissibility.test.js` rather than re-run per publish
 *      — a publish cannot change what the formula computes, only the inputs
 *      `checkRegisterPrerequisites()` here re-validates.
 */

const { a1LambdaFloorAdmissible, v2PolicyCreditCeilings } = require("../config/validators");

/**
 * §6.4: "the maximum achievable terminal-value gain... All three quantities are
 * computed once per round from the same price snapshot" — a magnitude, never
 * negative. Checked here rather than only trusted from `pricing/vTerminal.js`'s own
 * arithmetic, because `omega.js` is the Tier 1 boundary an incorrectly-wired
 * composition root could hand a bad number across (§1.8 rule 2's injection seam is
 * exactly the place a caller could pass something the callee cannot itself compute
 * to double-check).
 *
 * @param {ReturnType<import("./omega").omegaTerminalMilliCU>} omegaTerminalResult
 * @returns {string[]} problems, empty when admissible
 */
function checkOmegaNonNegative(omegaTerminalResult) {
  const problems = [];
  if (!omegaTerminalResult || !omegaTerminalResult.ok) return problems;
  if (typeof omegaTerminalResult.milliCU === "bigint" && omegaTerminalResult.milliCU < 0n) {
    problems.push(
      `Ω_terminal resolved to a negative value (${omegaTerminalResult.milliCU} milli-CU). §6.4 defines it ` +
        "as a magnitude subtracted from LB; a negative value would raise LB instead of lowering it, " +
        "breaking the admissibility the correction exists to guarantee.",
    );
  }
  return problems;
}

/**
 * Re-run the register-level prerequisites `LB(a, l)`'s admissibility depends on,
 * against a resolved config snapshot's `values`/`entries`/`derivedValues` — the
 * same shape `config/validators.validatePublish()` already checks these against,
 * reused rather than re-derived so the build gate and the publish-time gate can
 * never disagree about what "admissible" means.
 *
 * @param {object} input
 * @param {object[]} input.entries the parameter register
 * @param {Map<string, *>} input.values resolved values
 * @param {Map<string, *>} input.derivedValues
 * @returns {{ ok: boolean, problems: string[] }}
 */
function checkRegisterPrerequisites(input) {
  const source = input || {};
  const problems = [
    ...a1LambdaFloorAdmissible(source.values).map((item) => item.message),
    ...v2PolicyCreditCeilings(source.entries, source.values, source.derivedValues).map((item) => item.message),
  ];
  return { ok: problems.length === 0, problems };
}

module.exports = {
  checkOmegaNonNegative,
  checkRegisterPrerequisites,
};

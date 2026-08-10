"use strict";

/**
 * The Config Service's validation error type (§22.1 rule 5).
 *
 * > Invalid configuration is rejected at publish time, not discovered at decision
 * > time.
 *
 * §22.1 rule 5 draws one line, and this module is where the code draws it too: on one
 * side, **a configuration the caller got wrong**, which is a validation outcome and
 * must come back naming the rule that rejected it; on the other, **the service
 * failing**, which is a fault and must not be dressed up as the caller's mistake.
 *
 * The distinction has to be carried by the error's *type* rather than by where it was
 * thrown, because the two travel the same stack. A publish validates its input from
 * several modules — the resolver indexes the scope bindings, `killSwitches` normalises
 * the switch state, `regimes` picks the active regime — and each of those detects a
 * malformed input long before the V1–V10 matrix runs. When those modules threw a plain
 * `Error`, the REST boundary could not tell "you named a kill switch that does not
 * exist" from "the database connection dropped", and returned `500` for both: the
 * operator's typo was reported as a server fault, and the endpoint's own designed,
 * tested `422`-with-findings contract was bypassed entirely.
 *
 * So this type lives in its own module rather than in `service.js`: the modules that
 * detect malformed input are the ones `service.js` itself depends on, and an error
 * type they all import must sit below all of them. `service.js` re-exports it, so
 * `configService.ConfigValidationError` remains the name callers already use.
 *
 * **A plain `Error` from a config module therefore still means what it should mean —
 * something unexpected went wrong** — and still surfaces as a `500`. Nothing here
 * widens into a catch-all: each throw site names the input it rejected.
 */

/**
 * Findings carry the same shape `validators.js` emits, so a caller — the REST
 * endpoint, a test, or an operator's tooling — reads one structure regardless of
 * which stage rejected the publish.
 *
 * @typedef {{ id: string, severity: string, rule: string, message: string }} ConfigFinding
 */

/**
 * Raised when a publish is refused: either because the submitted configuration is
 * malformed, or because it violates one of the publish-time rules.
 *
 * Carries the findings so the caller can report *which* rule rejected it rather than
 * "invalid configuration".
 */
class ConfigValidationError extends Error {
  /**
   * @param {string} message
   * @param {ConfigFinding[]} [findings]
   */
  constructor(message, findings) {
    super(message);
    this.name = "ConfigValidationError";
    this.findings = Array.isArray(findings) ? findings : [];
  }
}

module.exports = { ConfigValidationError };

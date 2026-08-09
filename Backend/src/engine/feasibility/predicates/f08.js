"use strict";

/**
 * **F8 — No active fault of severity ≥ `blocking`.** Class I. Indeterminate: `DENY`.
 *
 * > Graded rather than binary: a `degraded` fault does not bar work but raises risk
 * > cost and may bar high-value work (§16.5).
 *
 * The grading is the point. The baseline's fault check is a single boolean, so it has
 * exactly two behaviours available — ignore the fault entirely, or ground the agent —
 * and neither is right for a worn brush or a marginal sensor. Here the gate bars only
 * `BLOCKING` and above; everything below it passes this predicate and is *priced*
 * through `C_risk` (§8.4) and gated for high-value work by F9's health tier.
 *
 * ── Severity is ordered, and the order is declared ──────────────────────────
 * An unrecognised severity is `INDETERMINATE`, never "probably fine". A fault the
 * engine cannot rank is a fault whose consequences it cannot bound, and class I's
 * `DENY` is the right response to that.
 *
 * On the volatile subset (§10.3.2 step 3): a fault raised during the routing window
 * must not survive to commit.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

/**
 * §16.5's fault severity ladder, ordered. `BLOCKING` is the gate threshold §7.5 names.
 * @structural the specification's own severity labels, ordered by severity
 */
const SEVERITY_ORDER = Object.freeze(["INFO", "DEGRADED", "BLOCKING", "CRITICAL"]);

/** The severity at and above which F8 denies (§7.5 F8). @structural §7.5's own threshold label */
const BLOCKING = "BLOCKING";

const REQUIRED = `no active fault of severity >= ${BLOCKING}`;

/**
 * @param {string} severity
 * @returns {number} rank, or -1 when unrecognised
 */
function rankOf(severity) {
  return SEVERITY_ORDER.indexOf(String(severity).toUpperCase());
}

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });

  const faults = agent.faults;
  if (faults === undefined) {
    // Not "no faults". The baseline read an absent health record as passing the fault
    // check; §7.3 names that inversion explicitly as what the third value removes.
    return tv.absent("the agent's fault list", { required: REQUIRED, inputSource: "SENSOR" });
  }

  if (faults === null || !Array.isArray(faults)) {
    return tv.indeterminate({
      observed: null,
      required: REQUIRED,
      inputSource: "SENSOR",
      reason: "the agent's fault list is not an enumerated list; active faults cannot be ranked",
    });
  }

  const blockingRank = rankOf(BLOCKING);
  const active = faults.filter((fault) => fault && fault.active !== false);

  const unrankable = active.find((fault) => rankOf(fault.severity) < 0);
  if (unrankable) {
    return tv.indeterminate({
      observed: { code: unrankable.code === undefined ? null : unrankable.code, severity: unrankable.severity },
      required: REQUIRED,
      inputSource: "SENSOR",
      reason:
        `active fault "${String(unrankable.code)}" carries severity "${String(unrankable.severity)}", ` +
        `which is not one of ${SEVERITY_ORDER.join(", ")}. A fault the engine cannot rank is one ` +
        "whose consequences it cannot bound",
    });
  }

  const blocking = active
    .filter((fault) => rankOf(fault.severity) >= blockingRank)
    .sort((a, b) => rankOf(b.severity) - rankOf(a.severity));

  if (blocking.length > 0) {
    const worst = blocking[0];
    return tv.violated({
      observed: { code: worst.code === undefined ? null : worst.code, severity: worst.severity, activeCount: blocking.length },
      required: REQUIRED,
      inputSource: "SENSOR",
      // How many severity steps past the threshold — the near-miss dimension that
      // makes "just over the line" distinguishable from "critical".
      margin: blockingRank - rankOf(worst.severity),
      marginUnit: tv.MARGIN_UNIT.RANK,
      reason: `active fault "${String(worst.code)}" has severity ${worst.severity} (§7.5 F8)`,
    });
  }

  const worstBelow = active.sort((a, b) => rankOf(b.severity) - rankOf(a.severity))[0];
  return tv.satisfied({
    observed: {
      activeCount: active.length,
      worstSeverity: worstBelow ? worstBelow.severity : null,
    },
    required: REQUIRED,
    inputSource: "SENSOR",
    margin: worstBelow ? blockingRank - rankOf(worstBelow.severity) : null,
    marginUnit: tv.MARGIN_UNIT.RANK,
  });
}

module.exports = { evaluate, SEVERITY_ORDER, BLOCKING };

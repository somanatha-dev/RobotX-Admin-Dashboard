"use strict";

/**
 * Operating regimes (§22.2).
 *
 * A **regime** is a named, pre-declared parameter set for a foreseeable operating
 * condition that invalidates the fleet's ordinary calibration — first snowfall, a
 * sustained heatwave, monsoon, a major public event. It is a time-windowed override
 * with two additional properties: it is **named**, so its entry and exit are events
 * like a degraded mode's, and it is **forecast-triggerable**, so it can be entered on
 * a *correct* forecast rather than discovered.
 *
 * The distinction from a degraded mode matters. §18.3 handles the forecast service
 * being *unavailable*. Nothing there handles a forecast that is *correct* and
 * predicts conditions under which the calibrated coefficients are simply wrong: in
 * the first snowfall of the season, energy consumption, service times, travel times,
 * and intervention rates all move together, and every one of them moves outside the
 * range the current coefficient set was fitted on. Left unmodelled, this arrives as a
 * simultaneous drift alarm on every predictor (§21.5) and as an unexplained spike in
 * T1 energy events — a genuine regime change presenting as a system fault.
 *
 * The four properties this module enforces:
 *
 *   - Each regime declares its **trigger condition**, its **parameter deltas**, its
 *     **entry and exit criteria**, and its **owner**. A regime missing any of them is
 *     rejected at publish.
 *   - **Safety-class deltas within a regime remain Safety-class changes** and carry
 *     the same approval (§22.3).
 *   - **Entry is proposed automatically from the forecast and confirmed by an
 *     operator, in both directions.** An automatic regime change on a forecast is a
 *     large, fleet-wide behavioural shift and belongs to a person; the automation's
 *     job is to propose it early enough to matter.
 *   - **Calibration is per regime** (§22.4). A coefficient set fitted across a mixed
 *     year is wrong in both regimes, so a regime carries its own calibration status.
 *
 * The active regime is pinned into the round snapshot and recorded per decision
 * (§9.6, §21.2), so a decision taken under a winter regime replays under it. That
 * pinning lives in `determinism/snapshot.js`; this module owns the declaration, the
 * lifecycle, and the delta application.
 */

const { CALIBRATION_STATUS, isKnownStatus } = require("./calibrationStatus");
const { normaliseScopeLevel, isScopeLevel } = require("./resolver");
const { ConfigValidationError } = require("./errors");

/**
 * Regime lifecycle. Operator confirmation is required in **both** directions, so
 * neither entry nor exit can be reached by automation alone.
 */
const REGIME_STATE = Object.freeze({
  INACTIVE: "INACTIVE",
  PROPOSED_ENTRY: "PROPOSED_ENTRY",
  ACTIVE: "ACTIVE",
  PROPOSED_EXIT: "PROPOSED_EXIT",
});

/**
 * Who or what caused a transition. Recorded so that "the forecast proposed it and a
 * person confirmed it" is reconstructable after the fact.
 */
const TRANSITION_ACTOR = Object.freeze({
  FORECAST: "FORECAST",
  OPERATOR: "OPERATOR",
});

const LEGAL_TRANSITIONS = Object.freeze({
  INACTIVE: Object.freeze(["PROPOSED_ENTRY"]),
  PROPOSED_ENTRY: Object.freeze(["ACTIVE", "INACTIVE"]),
  ACTIVE: Object.freeze(["PROPOSED_EXIT"]),
  PROPOSED_EXIT: Object.freeze(["INACTIVE", "ACTIVE"]),
});

/**
 * Transitions only an operator may make. Both confirmations are here, which is the
 * §22.2 requirement stated as data rather than as prose.
 */
const OPERATOR_ONLY_TRANSITIONS = Object.freeze([
  "PROPOSED_ENTRY→ACTIVE",
  "PROPOSED_EXIT→INACTIVE",
]);

const SAFETY_CHANGE_CLASS = "SAFETY";

/**
 * Validate a regime declaration.
 *
 * @param {object} regime
 * @param {Map<string, object>} entries the parameter register
 * @returns {string[]} problems; empty means the declaration is well-formed
 */
function validateDeclaration(regime, entries) {
  const problems = [];
  const label = regime && regime.name ? `regime "${regime.name}"` : "regime";

  if (!regime || typeof regime !== "object") return ["regime declaration is not an object"];
  if (!regime.name || String(regime.name).trim() === "") {
    problems.push("regime has no name. A regime is named so its entry and exit are events (§22.2)");
  }
  if (!regime.triggerCondition) {
    problems.push(`${label} declares no trigger condition (§22.2)`);
  }
  if (!regime.entryCriteria) problems.push(`${label} declares no entry criteria (§22.2)`);
  if (!regime.exitCriteria) problems.push(`${label} declares no exit criteria (§22.2)`);
  if (!regime.owner) problems.push(`${label} declares no owner (§22.2)`);
  if (!isKnownStatus(regime.calibrationStatus)) {
    problems.push(
      `${label} carries no calibration status. Calibration is per regime: a coefficient set fitted ` +
        "across a mixed year is wrong in both regimes (§22.4)",
    );
  }

  const deltas = regime.parameterDeltas;
  if (!Array.isArray(deltas) || deltas.length === 0) {
    problems.push(`${label} declares no parameter deltas — a regime that changes nothing is not a regime (§22.2)`);
    return problems;
  }

  for (const delta of deltas) {
    if (!delta || !delta.name) {
      problems.push(`${label} has a parameter delta with no parameter name`);
      continue;
    }
    const entry = entries.get(delta.name);
    if (!entry) {
      problems.push(
        `${label} sets "${delta.name}", which is not in the parameter register (§22.1 rule 1)`,
      );
      continue;
    }
    if (entry.changeClass === "DERIVED") {
      problems.push(
        `${label} sets derived parameter "${delta.name}". Derived parameters are computed by the ` +
          "Config Service, never hand-entered — a regime is not an exception (§22.1 rule 6)",
      );
    }
    const level = normaliseScopeLevel(delta.level || "global");
    if (!isScopeLevel(level)) {
      problems.push(`${label} binds "${delta.name}" at unknown scope level "${delta.level}"`);
    }
    if (delta.value === undefined) {
      problems.push(`${label} declares "${delta.name}" with no value`);
    }
  }

  return problems;
}

/**
 * Does this regime carry Safety-class deltas? Those remain Safety-class changes and
 * carry the same two-person approval as any other Safety-class change (§22.3).
 *
 * @param {object} regime
 * @param {Map<string, object>} entries
 * @returns {string[]} the Safety-class parameter names the regime moves
 */
function safetyClassDeltas(regime, entries) {
  return (regime.parameterDeltas || [])
    .map((delta) => delta && delta.name)
    .filter((name) => {
      const entry = name ? entries.get(name) : null;
      return Boolean(entry) && entry.changeClass === SAFETY_CHANGE_CLASS;
    });
}

/**
 * Apply a transition to a regime's lifecycle state.
 *
 * @param {{ name: string, state: string }} regime
 * @param {string} to target state
 * @param {{ actor: string, actorId?: string, reason?: string, at?: string }} by
 * @returns {{ name: string, state: string, history: object[] }}
 * @throws {Error} on an illegal transition, or an operator-only transition attempted
 *   by automation
 */
function transition(regime, to, by) {
  const from = regime.state || REGIME_STATE.INACTIVE;
  const legal = LEGAL_TRANSITIONS[from] || [];

  if (!legal.includes(to)) {
    throw new Error(
      `regime "${regime.name}": ${from} → ${to} is not a legal transition. ` +
        `Legal from ${from}: ${legal.join(", ") || "none"} (§22.2)`,
    );
  }

  const edge = `${from}→${to}`;
  if (OPERATOR_ONLY_TRANSITIONS.includes(edge) && by.actor !== TRANSITION_ACTOR.OPERATOR) {
    throw new Error(
      `regime "${regime.name}": ${edge} requires operator confirmation. An automatic regime change ` +
        "on a forecast is a large, fleet-wide behavioural shift and belongs to a person; the " +
        "automation's job is to propose it early enough to matter (§22.2)",
    );
  }

  return {
    ...regime,
    state: to,
    history: [
      ...(regime.history || []),
      { from, to, actor: by.actor, actorId: by.actorId || null, reason: by.reason || null, at: by.at || null },
    ],
  };
}

/**
 * The scope bindings an active regime contributes.
 *
 * A regime is a time-windowed override, and `time_window` is the most specific level
 * in the §22.2 hierarchy, so its deltas win over every other binding — which is what
 * makes a regime able to move a parameter at all.
 *
 * @param {object} regime
 * @returns {Array<{ level: string, key: string, name: string, value: * }>}
 */
function bindingsFor(regime) {
  if (!regime || regime.state !== REGIME_STATE.ACTIVE) return [];
  return (regime.parameterDeltas || []).map((delta) => ({
    level: "time_window",
    key: `regime:${regime.name}`,
    name: delta.name,
    value: delta.value,
    origin: { regime: regime.name, declaredLevel: delta.level || "global", declaredKey: delta.key || "" },
  }));
}

/**
 * The single active regime, if any. Two simultaneously active regimes would make the
 * pinned "active regime" of the round snapshot ambiguous, and a decision that cannot
 * name the regime it was taken under cannot replay under it.
 *
 * @param {object[]} regimes
 * @returns {object|null}
 * @throws {Error} when more than one regime is active
 */
function activeRegime(regimes) {
  if (regimes !== undefined && regimes !== null && !Array.isArray(regimes)) {
    throw new ConfigValidationError(`regimes must be an array; received ${typeof regimes} (§22.2)`, [
      {
        id: "P7",
        severity: "BLOCKING",
        rule: "§22.2",
        message: `regimes is a ${typeof regimes}; a publish declares its regimes as an array (§22.2).`,
      },
    ]);
  }

  const declared = regimes || [];
  const malformed = declared.filter((regime) => !regime || typeof regime !== "object" || Array.isArray(regime));
  if (malformed.length > 0) {
    throw new ConfigValidationError(`${malformed.length} declared regime(s) are not objects (§22.2)`, [
      {
        id: "P7",
        severity: "BLOCKING",
        rule: "§22.2",
        message:
          `${malformed.length} declared regime(s) are not objects. Each regime declares its trigger ` +
          "condition, parameter deltas, entry and exit criteria, and owner (§22.2).",
      },
    ]);
  }

  const active = declared.filter((regime) => regime.state === REGIME_STATE.ACTIVE);
  // Two simultaneously active regimes is a malformed submission the caller can fix,
  // so it is a validation finding rather than a server fault (see `errors.js`).
  if (active.length > 1) {
    throw new ConfigValidationError(
      `${active.length} regimes are active simultaneously (${active.map((r) => r.name).join(", ")}). ` +
        "The round snapshot pins one active regime; two would make a decision unreplayable (§9.6, §22.2)",
      [
        {
          id: "P7",
          severity: "BLOCKING",
          rule: "§9.6 · §22.2",
          message:
            `${active.length} regimes are active simultaneously (${active.map((r) => r.name).join(", ")}). ` +
            "The round snapshot pins one active regime; two would make a decision unreplayable (§9.6, §22.2).",
        },
      ],
    );
  }
  return active.length === 1 ? active[0] : null;
}

module.exports = {
  REGIME_STATE,
  TRANSITION_ACTOR,
  LEGAL_TRANSITIONS,
  OPERATOR_ONLY_TRANSITIONS,
  CALIBRATION_STATUS,
  validateDeclaration,
  safetyClassDeltas,
  transition,
  bindingsFor,
  activeRegime,
};

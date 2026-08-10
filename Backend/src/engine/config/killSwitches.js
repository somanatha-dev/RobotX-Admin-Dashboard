"use strict";

/**
 * Feature flags and kill switches (§22.5).
 *
 * Every significant capability has an independent kill switch that degrades to a
 * simpler, well-tested behaviour rather than to nothing. Four rules bound the 512
 * combinations of the nine switches to something exercisable:
 *
 *   1. Every switch degrades to a Tier 1 behaviour (§1.8), so **any** combination is
 *      safe. Every switch here disables a Tier 2 mechanism, and no Tier 0 or Tier 1
 *      guarantee depends on a Tier 2 mechanism. No switch may ever be added that
 *      could produce an unsafe allocation.
 *   2. The supported set is the monotone ladder, and it is what is tested: the
 *      supported combinations are the **prefixes** of the ladder order. Any other
 *      combination is *permitted* — an operator must never be blocked from disabling
 *      a specific misbehaving mechanism — but is recorded as an **unrehearsed
 *      combination**, alerts as such, and requires explicit acknowledgement.
 *   3. Two pairs are order-dependent. Chaining is disabled *before* multi-Leg
 *      columns, never after: the reverse leaves column generation proposing bundles
 *      that plan feasibility will always reject, wasting the round's column budget.
 *      The opportunity-cost term is disabled last, and degrades to static priors
 *      rather than to zero.
 *   4. Every switch state is pinned in the decision record and is part of the replay
 *      input (`determinism/snapshot.js`), so a decision made under a thrown switch
 *      replays under that switch. A switch state that is not recorded would silently
 *      break replay determinism (T6).
 *
 * ── Terminology ─────────────────────────────────────────────────────────────
 * A switch is **thrown** when the mechanism it guards is disabled. The ship state of
 * §1.8 rule 3 — "Tier 0 plus Tier 1 … is a complete, safe, shippable engine. Tier 2
 * mechanisms are then enabled one at a time" — is therefore *every switch thrown*,
 * and that is this module's default.
 *
 * ── CARRIED FORWARD: recorded specification discrepancy ─────────────────────
 * §1.8 enumerates twelve Tier 2 mechanisms; §22.5 tabulates nine kill switches and
 * reasons about "the nine independent switches above" and their 512 combinations.
 * Churn pricing (§8.9), post-solve local search (§9.5), and the duty-cycle
 * regulariser (§17.2) have no §22.5 row. Phase 0 recorded this and escalated it to
 * the tech lead as an item for Phase 1 (`PHASE_0_IMPLEMENTATION_REPORT.md` §7.1).
 * **No decision has been returned, so Phase 1 does not resolve it either** — the
 * architecture is frozen and resolving it is an architecture change. The recorded
 * treatment is carried forward unchanged: the three carry their own switches so
 * §1.8 rule 1 ("every Tier 2 mechanism MUST be individually disableable") holds, and
 * they sit **off the ladder**, leaving §22.5 rule 2's prefix reasoning and its 2⁹
 * combination count untouched.
 *
 * One decision rule is stated here because the code cannot avoid making it: the
 * §1.8 rule 3 baseline — every switch thrown, including the three off-ladder ones —
 * is classified `TIER_ONE_BASELINE` and does **not** alert, because it is the state
 * the specification mandates for launch. Throwing an off-ladder switch in any other
 * combination is unrehearsed and alerts, which is Phase 0's conservative reading.
 */

const { CALIBRATION_STATUS } = require("./calibrationStatus");
const { ConfigValidationError } = require("./errors");

/**
 * A malformed switch state is a caller error, so it is reported in the same finding
 * shape `validators.js` emits and the REST boundary already renders.
 *
 * @param {string} message
 * @returns {{ id: string, severity: string, rule: string, message: string }}
 */
function finding(message) {
  return { id: "P5", severity: "BLOCKING", rule: "§22.5", message };
}

/**
 * The nine §22.5 switches, in the order of the supported monotone ladder. The
 * supported combinations are the prefixes of this order (§22.5 rule 2).
 */
const KILL_SWITCH_LADDER = Object.freeze([
  "reposition_injection",
  "preemption",
  "deferral",
  "cross_region_candidacy",
  "chaining",
  "multi_leg_columns",
  "reliability_based_gating",
  "batch_solving",
  "opportunity_cost_term",
]);

/**
 * §1.8 rule-1 switches for the three Tier 2 mechanisms the §22.5 table omits.
 */
const KILL_SWITCHES_OFF_LADDER = Object.freeze([
  "churn_pricing",
  "local_search",
  "duty_cycle_regulariser",
]);

const KILL_SWITCH_NAMES = Object.freeze([...KILL_SWITCH_LADDER, ...KILL_SWITCHES_OFF_LADDER]);

/**
 * What each switch degrades to (§22.5). Every target is a Tier 1 behaviour, which is
 * rule 1 and is what makes every combination safe.
 */
const KILL_SWITCHES = Object.freeze(
  Object.fromEntries(
    [
      {
        name: "reposition_injection",
        capability: "Repositioning",
        section: "§17.3",
        degradesTo: "No reposition missions",
      },
      {
        name: "preemption",
        capability: "Preemption, including victim disposition",
        section: "§4.8",
        degradesTo: "Disabled entirely",
      },
      {
        name: "deferral",
        capability: "Deferral as a priced arc",
        section: "§8.8",
        degradesTo: "Immediate assignment when any feasible candidate exists",
      },
      {
        name: "cross_region_candidacy",
        capability: "Cross-region candidacy",
        section: "§19.6",
        degradesTo: "Region-local only",
      },
      {
        name: "chaining",
        capability: "Chaining — queue depth > 1",
        section: "§13.3",
        degradesTo:
          "capacity[agent_class] = 1; strict one-mission-per-agent. Independent of multi-Leg columns, because queue depth lives in plan feasibility while multi-Leg structure lives in column generation",
      },
      {
        name: "multi_leg_columns",
        capability: "Multi-Leg columns (bundling and consolidation)",
        section: "§9.3",
        degradesTo:
          "Singleton columns only — which puts every round in the singleton regime, where the solve is a totally unimodular min-cost flow, integral and exact, and solver duals are exact marginal prices. This switch degrades to a *stronger* guarantee, not a weaker one",
      },
      {
        name: "reliability_based_gating",
        capability: "Reliability-priced risk",
        section: "§8.4, §16",
        degradesTo: "Cohort priors only",
      },
      {
        name: "batch_solving",
        capability: "Batch solving",
        section: "§9.1, §9.2",
        degradesTo: "The same round executed with a batch of one Leg",
      },
      {
        name: "opportunity_cost_term",
        capability: "The opportunity-cost and terminal-value model",
        section: "§8.3",
        degradesTo:
          "λ_zone from configured static per-zone, per-bucket priors; the derivation of §8.3 is unchanged, only its input source is",
      },
      {
        name: "churn_pricing",
        capability: "Churn pricing",
        section: "§8.9",
        degradesTo: "Reassignment priced without a churn term",
        offLadder: true,
      },
      {
        name: "local_search",
        capability: "Post-solve local search",
        section: "§9.5",
        degradesTo: "The solver's own solution, reported with its own gap",
        offLadder: true,
      },
      {
        name: "duty_cycle_regulariser",
        capability: "The duty-cycle regulariser",
        section: "§17.2",
        degradesTo: "Priced wear only (§17.1)",
        offLadder: true,
      },
    ].map((entry) => [
      entry.name,
      Object.freeze({ ...entry, offLadder: Boolean(entry.offLadder), ladderPosition: KILL_SWITCH_LADDER.indexOf(entry.name) }),
    ]),
  ),
);

/**
 * How a combination of thrown switches is classified.
 */
const COMBINATION_STATUS = Object.freeze({
  /** Every switch thrown: the §1.8 rule 3 Tier 0 + Tier 1 engine. The launch state. */
  TIER_ONE_BASELINE: "TIER_ONE_BASELINE",
  /** A prefix of the ladder, no off-ladder switch thrown: rehearsed and staged. */
  REHEARSED: "REHEARSED",
  /** Permitted and safe, but never exercised together. Alerts; needs acknowledgement. */
  UNREHEARSED: "UNREHEARSED",
});

/**
 * @param {string} name
 * @returns {boolean}
 */
function isKnownSwitch(name) {
  return Object.prototype.hasOwnProperty.call(KILL_SWITCHES, name);
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isOnSupportedLadder(name) {
  return KILL_SWITCH_LADDER.includes(name);
}

/**
 * The default switch state: every switch thrown.
 *
 * This is not a conservative choice made here; it is §1.8 rule 3. Tier 0 plus Tier 1
 * at `capacity[agent_class] = 1`, in the singleton regime, with deferral and
 * preemption off and `λ_zone` from static configured priors, is the complete, safe,
 * shippable engine. Phase 16 enables the Tier 2 mechanisms one at a time, each
 * validated in shadow mode before it is trusted.
 *
 * @returns {Record<string, boolean>} switch name → thrown
 */
function defaultState() {
  return Object.fromEntries(KILL_SWITCH_NAMES.map((name) => [name, true]));
}

/**
 * Normalise a partial state into a complete one, rejecting unknown switch names.
 *
 * @param {Record<string, boolean>} [state]
 * @returns {Record<string, boolean>}
 */
function normaliseState(state) {
  if (state !== undefined && state !== null && (typeof state !== "object" || Array.isArray(state))) {
    throw new ConfigValidationError(
      "killSwitchState must be an object mapping switch name to a boolean (§22.5)",
      [
        finding(
          `killSwitchState is a ${Array.isArray(state) ? "array" : typeof state}; §22.5 pins the state of ` +
            `each named switch, so it is an object of ${KILL_SWITCH_NAMES.length} optional boolean keys.`,
        ),
      ],
    );
  }

  const complete = defaultState();
  const unrecognised = [];
  for (const [name, thrown] of Object.entries(state || {})) {
    if (!isKnownSwitch(name)) {
      unrecognised.push(name);
      continue;
    }
    complete[name] = Boolean(thrown);
  }

  // An operator's typo in a switch name is a plausible mistake and a validation
  // outcome, not a server fault: it is reported by name, with the switches that do
  // exist, rather than as an opaque failure (see `errors.js`).
  if (unrecognised.length > 0) {
    throw new ConfigValidationError(
      `kill switch ${unrecognised.map((name) => `"${name}"`).join(", ")} is not recognised (§22.5)`,
      unrecognised.map((name) =>
        finding(
          `kill switch "${name}" is not recognised. Known switches: ${KILL_SWITCH_NAMES.join(", ")} (§22.5).`,
        ),
      ),
    );
  }
  return complete;
}

/**
 * Is the thrown ladder set a prefix of the ladder order?
 *
 * @param {string[]} thrownLadder
 * @returns {boolean}
 */
function isLadderPrefix(thrownLadder) {
  const thrown = new Set(thrownLadder);
  const expected = KILL_SWITCH_LADDER.slice(0, thrown.size);
  return expected.every((name) => thrown.has(name));
}

/**
 * Classify a switch combination (§22.5 rule 2), and report the order-dependent pairs
 * §22.5 rule 3 states by name.
 *
 * The classification never blocks: "an operator must never be blocked from disabling
 * a specific misbehaving mechanism". It distinguishes "we know exactly what this
 * does" from "this is safe but untested", and conflating those is what makes an
 * incident worse.
 *
 * @param {Record<string, boolean>} [state]
 * @returns {{ state: Record<string, boolean>, status: string, thrown: string[],
 *             thrownLadder: string[], thrownOffLadder: string[],
 *             ladderPrefixLength: number, acknowledgementRequired: boolean,
 *             orderingWarnings: string[], notes: string[] }}
 */
function classify(state) {
  const complete = normaliseState(state);
  const thrown = KILL_SWITCH_NAMES.filter((name) => complete[name]);
  const thrownLadder = KILL_SWITCH_LADDER.filter((name) => complete[name]);
  const thrownOffLadder = KILL_SWITCHES_OFF_LADDER.filter((name) => complete[name]);

  const everythingThrown = thrown.length === KILL_SWITCH_NAMES.length;
  const prefix = isLadderPrefix(thrownLadder);

  let status;
  if (everythingThrown) status = COMBINATION_STATUS.TIER_ONE_BASELINE;
  else if (prefix && thrownOffLadder.length === 0) status = COMBINATION_STATUS.REHEARSED;
  else status = COMBINATION_STATUS.UNREHEARSED;

  const orderingWarnings = [];
  if (complete.multi_leg_columns && !complete.chaining) {
    orderingWarnings.push(
      "multi-Leg columns are disabled while chaining is still enabled. §22.5 rule 3: chaining is " +
        "disabled *before* multi-Leg columns, never after — the reverse leaves column generation " +
        "proposing bundles that plan feasibility will always reject, wasting the round's column budget.",
    );
  }
  if (complete.opportunity_cost_term && !prefix) {
    orderingWarnings.push(
      "the opportunity-cost term is disabled outside a ladder prefix. §22.5 rule 3: it is disabled " +
        "last, because it is the term whose loss most changes fleet behaviour.",
    );
  }

  const notes = [];
  if (thrownOffLadder.length > 0 && !everythingThrown) {
    notes.push(
      `off-ladder switch(es) thrown: ${thrownOffLadder.join(", ")}. These guard Tier 2 mechanisms ` +
        "§1.8 names that §22.5 gives no row (recorded discrepancy, Phase 0 §7.1), so the " +
        "combination is outside the rehearsed ladder.",
    );
  }

  return {
    state: complete,
    status,
    thrown,
    thrownLadder,
    thrownOffLadder,
    ladderPrefixLength: prefix ? thrownLadder.length : -1,
    acknowledgementRequired: status === COMBINATION_STATUS.UNREHEARSED,
    orderingWarnings,
    notes,
  };
}

/**
 * Is the mechanism this switch guards currently enabled?
 *
 * @param {Record<string, boolean>} state
 * @param {string} name
 * @returns {boolean}
 */
function isEnabled(state, name) {
  if (!isKnownSwitch(name)) {
    throw new ConfigValidationError(`kill switch "${name}" is not recognised (§22.5)`, [
      finding(`kill switch "${name}" is not recognised. Known switches: ${KILL_SWITCH_NAMES.join(", ")} (§22.5).`),
    ]);
  }
  return !normaliseState(state)[name];
}

/**
 * The stated source every kill-switch entry carries (§22.4).
 *
 * The launch value is not a measurement and could not be one: §1.8 rule 3 fixes it
 * directly, and the only thing that changes it is Phase 16, one switch at a time behind
 * its own gate. Recording that is what distinguishes a derived value from a default
 * nobody has looked at, which is the distinction §22.4 exists to draw.
 */
const DERIVATION =
  "Stated source: §1.8 rule 3 fixes this value directly — \"Tier 0 plus Tier 1 ... is a complete, safe, shippable engine. Tier 2 mechanisms are then enabled one at a time.\" The launch value of every kill switch is therefore thrown, and it is DERIVED from that sentence rather than chosen: there is no measurement that could produce a different launch state, and Phase 16 is the only thing that changes it, one switch at a time behind its own gate.";

/**
 * Register entries describing the switch set, so the switch states are governed by
 * the same register discipline as every other behavioural value (§22.1 rule 1) and
 * appear in the resolution-explain query.
 *
 * @returns {object[]}
 */
function registerEntries() {
  return KILL_SWITCH_NAMES.map((name) => {
    const definition = KILL_SWITCHES[name];
    return {
      name: `killswitch.${name}`,
      type: "boolean",
      unit: "thrown",
      default: true,
      range: null,
      scopes: ["global", "region"],
      specScope: "region",
      changeClass: "SAFETY",
      owner: "SRE + Safety",
      blastRadius: definition.offLadder ? "region" : "shard",
      calibrationStatus: CALIBRATION_STATUS.DERIVED,
      /**
       * PHASE 15 — §22.4 defines `DERIVED` as "from a stated **accounting or measured
       * source**", and `tools/gates/checkCalibration.js` refuses a Safety-class entry that
       * claims the status without stating one. Every row here is Safety-class, so the
       * source is stated once, here, rather than pasted into the register file where it
       * would drift away from the generator.
       */
      derivation: DERIVATION,
      section: definition.section,
      description:
        `Kill switch for ${definition.capability}. Thrown (true) disables the mechanism and degrades to: ` +
        `${definition.degradesTo}. Ships thrown — §1.8 rule 3 launches the Tier 0 + Tier 1 engine and ` +
        "enables Tier 2 mechanisms one at a time, each validated in shadow mode first.",
    };
  });
}

module.exports = {
  KILL_SWITCH_LADDER,
  KILL_SWITCHES_OFF_LADDER,
  KILL_SWITCH_NAMES,
  KILL_SWITCHES,
  COMBINATION_STATUS,
  isKnownSwitch,
  isOnSupportedLadder,
  defaultState,
  normaliseState,
  isLadderPrefix,
  classify,
  isEnabled,
  registerEntries,
};

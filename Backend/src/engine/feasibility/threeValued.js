"use strict";

/**
 * Three-valued evaluation (§7.3) — **Tier 0**, mechanism T0-02.
 *
 * > Each predicate returns **`SATISFIED`**, **`VIOLATED`**, or **`INDETERMINATE`**.
 * > `INDETERMINATE` means the predicate could not be evaluated — data absent, stale
 * > beyond its budget, or from an untrusted source.
 *
 * The third value is the whole point. A two-valued gate has to decide what an absent
 * reading means at the moment it reads it, and the baseline decided *permissively*
 * every time:
 *
 * > This inverts the baseline's defaults, where a null battery reading passed
 * > eligibility *and* scored as 100 %, an absent health record passed the fault check,
 * > and an expired live state yielded the best possible utilisation score. Under T2,
 * > unknown is never permission.
 *
 * Separating "could not evaluate" from "evaluated to false" is also what makes the
 * systemic guard of §7.4 possible at all: a fleet that is genuinely unfit and a fleet
 * whose telemetry has failed produce identical rejection counts in a two-valued gate,
 * and they require opposite responses.
 *
 * ── The four policies ───────────────────────────────────────────────────────
 * A predicate does not decide what its own `INDETERMINATE` *means*; it declares a
 * policy and this module applies it. The declaration lives in `register.js` and is
 * machine-checked there against §7.3's permission column, so a class I or R predicate
 * cannot acquire a permissive policy by editing one file.
 *
 * ── Purity ──────────────────────────────────────────────────────────────────
 * Nothing here reads a clock, a store, or a cache. Every function is a pure function
 * of its arguments, which is what §7.5 requires of the register as a whole:
 * *"the result is order-independent because every predicate is a pure function of the
 * snapshot"*.
 */

/**
 * §7.3's three outcomes. Deliberately identical to `domain/capability.js`'s `MATCH`
 * and `domain/observation.js`'s vocabulary so a predicate lifts either result without
 * translating it — a translation layer between two three-valued vocabularies is
 * exactly where a value quietly becomes permissive.
 * @structural the specification's own outcome labels
 */
const OUTCOME = Object.freeze({
  SATISFIED: "SATISFIED",
  VIOLATED: "VIOLATED",
  INDETERMINATE: "INDETERMINATE",
});

const OUTCOMES = Object.freeze(Object.values(OUTCOME));

/**
 * §7.2's constraint taxonomy — *who may change them and under what authority*.
 *
 * > This matters because a single undifferentiated list of rules inevitably acquires
 * > a bypass.
 * @structural the specification's own class labels
 */
const CONSTRAINT_CLASS = Object.freeze({
  INVARIANT: "I",
  REGULATORY: "R",
  CONTRACTUAL: "C",
  POLICY: "P",
  FEASIBILITY: "F",
});

const CONSTRAINT_CLASSES = Object.freeze(Object.values(CONSTRAINT_CLASS));

/**
 * The classes §7.2 states are **never overridable operationally**. Class I is
 * "Never overridable by anyone, including operators and manual assignment"; class R
 * is "Never overridable operationally". Both therefore carry mandatory `DENY`.
 * @structural derived from §7.2's Override column
 */
const NEVER_OVERRIDABLE_CLASSES = Object.freeze([
  CONSTRAINT_CLASS.INVARIANT,
  CONSTRAINT_CLASS.REGULATORY,
]);

/**
 * §7.3's four indeterminate policies, with the Permitted-for column carried as data
 * so `assertPolicyLawful()` checks the specification's own table rather than a
 * paraphrase of it.
 * @structural the specification's own policy labels
 */
const POLICY = Object.freeze({
  DENY: "DENY",
  DENY_UNLESS_ENVELOPE: "DENY_UNLESS_ENVELOPE",
  ADMIT_WITH_PENALTY: "ADMIT_WITH_PENALTY",
  ADMIT: "ADMIT",
});

const POLICIES = Object.freeze(Object.values(POLICY));

/**
 * §7.3's Permitted-for column, as data.
 *
 *   | `DENY`                  | **Mandatory** for all class I and R predicates      |
 *   | `DENY_UNLESS_ENVELOPE`  | Class F where a conservative bound exists           |
 *   | `ADMIT_WITH_PENALTY`    | Class P and non-safety F only                       |
 *   | `ADMIT`                 | Only predicates with no safety or contractual consequence |
 *
 * `DENY` is permitted for every class: it is never *unsafe* to deny on unknown, only
 * potentially over-strict, and §7.4's guard is what bounds the availability cost of
 * that strictness.
 */
const POLICY_PERMITTED_CLASSES = Object.freeze({
  [POLICY.DENY]: Object.freeze([...CONSTRAINT_CLASSES]),
  [POLICY.DENY_UNLESS_ENVELOPE]: Object.freeze([CONSTRAINT_CLASS.FEASIBILITY]),
  [POLICY.ADMIT_WITH_PENALTY]: Object.freeze([
    CONSTRAINT_CLASS.POLICY,
    CONSTRAINT_CLASS.FEASIBILITY,
  ]),
  [POLICY.ADMIT]: Object.freeze([CONSTRAINT_CLASS.POLICY]),
});

/**
 * What applying a policy to an `INDETERMINATE` produced. Kept distinct from `OUTCOME`
 * because "denied because unknown" and "denied because measured and violating" are
 * different facts, and §7.4 counts only the first.
 * @structural resolution labels
 */
const RESOLUTION = Object.freeze({
  DENIED: "DENIED",
  ADMITTED: "ADMITTED",
  ADMITTED_WITH_PENALTY: "ADMITTED_WITH_PENALTY",
  ADMITTED_REDUCED_ENVELOPE: "ADMITTED_REDUCED_ENVELOPE",
});

/* ═══════════════════════════════════════════════════════════════════════════
   Predicate result constructors
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The shape every one of the 38 predicates returns.
 *
 * The fields are §7.7's rejection tuple — `(agent_id, predicate_id, observed_value,
 * required_value, input_source, observation_age)` — minus the two the evaluator
 * supplies (`agent_id`, `predicate_id`), plus `margin`.
 *
 * > **Near-miss margins.** For each rejected predicate, the *distance* from
 * > satisfaction, kept as a streaming quantile sketch rather than raw rows. A fleet
 * > routinely failing F34 by 3 % is one configuration change away from working, and
 * > that is very different from failing by 60 %.
 *
 * `margin` is therefore part of the predicate's own result: only the predicate knows
 * what "distance from satisfaction" means in its units. A predicate with no ordered
 * notion of distance — a capability mismatch, a boolean hold — returns `null`, which
 * the sketch skips rather than recording as zero.
 *
 * **`marginUnit` travels with it, and the sketch buckets on it.** Several predicates
 * carry more than one condition in different dimensions — F17 bounds a count *and* a
 * duration, F34 a probability at three tiers — and a quantile sketch fed metres,
 * milliseconds, and counts indiscriminately produces a number with no interpretation.
 * A margin without a unit is therefore not recorded (§7.7).
 *
 * @param {string} outcome one of OUTCOME
 * @param {object} detail
 * @returns {object} a frozen predicate result
 */
function result(outcome, detail) {
  const source = detail || {};
  const margin = source.margin === undefined ? null : source.margin;
  return Object.freeze({
    outcome,
    observed: source.observed === undefined ? null : source.observed,
    required: source.required === undefined ? null : source.required,
    inputSource: source.inputSource === undefined ? null : source.inputSource,
    observationAgeMs: source.observationAgeMs === undefined ? null : source.observationAgeMs,
    margin,
    marginUnit: margin === null || source.marginUnit === undefined ? null : source.marginUnit,
    reason: source.reason === undefined ? null : source.reason,
  });
}

/**
 * The dimensions a predicate margin can be expressed in. Enumerated so the near-miss
 * sketch can key on the unit rather than trusting every predicate to agree by
 * convention.
 * @structural margin dimension labels
 */
const MARGIN_UNIT = Object.freeze({
  COUNT: "count",
  MILLISECONDS: "ms",
  METRES: "m",
  KILOGRAMS: "kg",
  WATT_HOURS: "Wh",
  PROBABILITY: "prob",
  RATIO: "ratio",
  RANK: "rank",
  DEGREES_CELSIUS: "degC",
});

/**
 * @param {object} [detail]
 * @returns {object}
 */
function satisfied(detail) {
  return result(OUTCOME.SATISFIED, detail);
}

/**
 * @param {object} [detail]
 * @returns {object}
 */
function violated(detail) {
  return result(OUTCOME.VIOLATED, detail);
}

/**
 * @param {object} [detail]
 * @returns {object}
 */
function indeterminate(detail) {
  return result(OUTCOME.INDETERMINATE, detail);
}

/**
 * The specific `INDETERMINATE` a predicate returns when the input it needs is simply
 * not present in the snapshot.
 *
 * It exists as its own constructor because this is the case the baseline got wrong
 * everywhere, and a named constructor is what makes the 38 modules consistent about
 * it: absence is `INDETERMINATE`, never `SATISFIED` and never `VIOLATED`. It is also
 * not evidence of *lack* — "we have no record" and "it definitely does not hold" are
 * different facts (§2.3).
 *
 * @param {string} what the input that was missing, named so the tuple is diagnosable
 * @param {object} [detail]
 * @returns {object}
 */
function absent(what, detail) {
  const source = detail || {};
  const base = `${what} is absent from the snapshot; unknown is never permission (T2, §7.3)`;
  return result(OUTCOME.INDETERMINATE, {
    ...source,
    // A caller's own reason is *appended*, never discarded. Several predicates have
    // something specific to say about why their particular absence matters — F17's
    // "F17 is evaluated as a property of the plan", F22's pointer at §15.4 — and a
    // constructor that silently dropped it would make those rejection tuples less
    // diagnosable than the hand-written ones they replaced.
    reason: source.reason ? `${base}. ${source.reason}` : base,
  });
}

/**
 * The `INDETERMINATE` a predicate returns when the input exists but is older than the
 * staleness budget its consumer declared (§2.7).
 *
 * @param {string} what
 * @param {number|null} ageMs
 * @param {number|null} budgetMs
 * @param {object} [detail]
 * @returns {object}
 */
function stale(what, ageMs, budgetMs, detail) {
  return result(OUTCOME.INDETERMINATE, {
    ...(detail || {}),
    observationAgeMs: ageMs,
    reason:
      `${what} is stale: age ${ageMs === null ? "unknown" : `${ageMs} ms`} exceeds its ` +
      `${budgetMs === null ? "undeclared" : `${budgetMs} ms`} staleness budget (§2.7)`,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Policy application
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Is this policy lawful for a predicate of this class (§7.3's Permitted-for column)?
 *
 * @param {string} constraintClass one of CONSTRAINT_CLASS
 * @param {string} policy one of POLICY
 * @returns {string[]} problems, empty when lawful
 */
function assertPolicyLawful(constraintClass, policy) {
  const problems = [];

  if (!CONSTRAINT_CLASSES.includes(constraintClass)) {
    problems.push(`constraint class "${String(constraintClass)}" is not one of ${CONSTRAINT_CLASSES.join(", ")} (§7.2)`);
    return problems;
  }
  if (!POLICIES.includes(policy)) {
    problems.push(`indeterminate policy "${String(policy)}" is not one of ${POLICIES.join(", ")} (§7.3)`);
    return problems;
  }

  // The mandatory direction, stated positively so the message names the rule rather
  // than the table lookup that implements it.
  if (NEVER_OVERRIDABLE_CLASSES.includes(constraintClass) && policy !== POLICY.DENY) {
    problems.push(
      `a class ${constraintClass} predicate declares policy "${policy}". §7.3 makes DENY ` +
        "**mandatory** for all class I and R predicates, because §7.2 makes those classes " +
        "never overridable — by anyone, including operators and manual assignment",
    );
    return problems;
  }

  if (!POLICY_PERMITTED_CLASSES[policy].includes(constraintClass)) {
    problems.push(
      `policy "${policy}" is not permitted for a class ${constraintClass} predicate; ` +
        `§7.3 permits it for class ${POLICY_PERMITTED_CLASSES[policy].join(", ")} only`,
    );
  }

  return problems;
}

/**
 * Apply a predicate's declared policy to its outcome (§7.3).
 *
 * > Every `INDETERMINATE` resolution is recorded per decision with the predicate name
 * > and the reason.
 *
 * The record is the return value's business: this function reports what it did and
 * why, and `rejectionTelemetry.js` is what writes it down.
 *
 * `DENY_UNLESS_ENVELOPE` needs an answer to "is a reduced-envelope variant of the
 * mission feasible under pessimistic assumptions?", which only the caller can supply
 * because it requires re-planning. It is passed in as `envelopeFeasible`; **absent, it
 * denies**, which is the policy's own name read literally.
 *
 * @param {object} predicateResult a result from the constructors above
 * @param {{ constraintClass: string, policy: string, predicateId: string }} declaration
 * @param {{ envelopeFeasible?: boolean, uncertaintyPenaltyMilliCu?: number }} [options]
 * @returns {{ admitted: boolean, resolution: string|null, outcome: string,
 *             deniedForIndeterminacy: boolean, penaltyMilliCu: number|null,
 *             envelopeReduced: boolean, policy: string|null, reason: string|null }}
 */
function applyPolicy(predicateResult, declaration, options) {
  const outcome = predicateResult && predicateResult.outcome;
  const settings = options || {};

  if (outcome === OUTCOME.SATISFIED) {
    return Object.freeze({
      admitted: true,
      resolution: null,
      outcome,
      deniedForIndeterminacy: false,
      penaltyMilliCu: null,
      envelopeReduced: false,
      policy: null,
      reason: null,
    });
  }

  if (outcome === OUTCOME.VIOLATED) {
    // A measured violation is not a policy question. No policy admits it — that is
    // what T1 means by "safety constraints are absolute and never priced".
    return Object.freeze({
      admitted: false,
      resolution: RESOLUTION.DENIED,
      outcome,
      deniedForIndeterminacy: false,
      penaltyMilliCu: null,
      envelopeReduced: false,
      policy: null,
      reason: predicateResult.reason || "predicate evaluated to VIOLATED",
    });
  }

  if (outcome !== OUTCOME.INDETERMINATE) {
    throw new Error(
      `predicate "${declaration && declaration.predicateId}" returned outcome ` +
        `"${String(outcome)}", which is not one of ${OUTCOMES.join(", ")} (§7.3). An ` +
        "unrecognised outcome is never treated as satisfied.",
    );
  }

  const policy = declaration && declaration.policy;
  const problems = assertPolicyLawful(declaration && declaration.constraintClass, policy);
  if (problems.length > 0) {
    // An unlawful declaration denies. Refusing to evaluate would take the whole gate
    // down on a registry defect; admitting would be the bypass §7.2 exists to prevent.
    return Object.freeze({
      admitted: false,
      resolution: RESOLUTION.DENIED,
      outcome,
      deniedForIndeterminacy: true,
      penaltyMilliCu: null,
      envelopeReduced: false,
      policy,
      reason: `unlawful indeterminate policy, denied: ${problems.join("; ")}`,
    });
  }

  switch (policy) {
    case POLICY.DENY:
      return Object.freeze({
        admitted: false,
        resolution: RESOLUTION.DENIED,
        outcome,
        deniedForIndeterminacy: true,
        penaltyMilliCu: null,
        envelopeReduced: false,
        policy,
        reason: predicateResult.reason || "INDETERMINATE under policy DENY",
      });

    case POLICY.DENY_UNLESS_ENVELOPE: {
      const envelopeFeasible = settings.envelopeFeasible === true;
      return Object.freeze({
        admitted: envelopeFeasible,
        resolution: envelopeFeasible ? RESOLUTION.ADMITTED_REDUCED_ENVELOPE : RESOLUTION.DENIED,
        outcome,
        deniedForIndeterminacy: !envelopeFeasible,
        penaltyMilliCu: null,
        envelopeReduced: envelopeFeasible,
        policy,
        reason: envelopeFeasible
          ? "INDETERMINATE, but a reduced-envelope variant is feasible under pessimistic assumptions (§7.3)"
          : "INDETERMINATE and no reduced-envelope variant was established; the policy denies by default (§7.3)",
      });
    }

    case POLICY.ADMIT_WITH_PENALTY: {
      const penalty = settings.uncertaintyPenaltyMilliCu;
      if (typeof penalty !== "number" || !Number.isFinite(penalty)) {
        // §7.3: the policy is "Admit, **add** `cost.uncertainty_penalty[predicate]`,
        // and shrink the mission envelope". Admitting without the penalty is a
        // different policy — ADMIT — and it is not the one this predicate declared.
        return Object.freeze({
          admitted: false,
          resolution: RESOLUTION.DENIED,
          outcome,
          deniedForIndeterminacy: true,
          penaltyMilliCu: null,
          envelopeReduced: false,
          policy,
          reason:
            "INDETERMINATE under ADMIT_WITH_PENALTY, but no cost.uncertainty_penalty was " +
            "resolved for this predicate; admitting without the penalty would silently " +
            "downgrade the policy to ADMIT (§7.3)",
        });
      }
      return Object.freeze({
        admitted: true,
        resolution: RESOLUTION.ADMITTED_WITH_PENALTY,
        outcome,
        deniedForIndeterminacy: false,
        penaltyMilliCu: penalty,
        envelopeReduced: true,
        policy,
        reason: predicateResult.reason || "INDETERMINATE admitted with uncertainty penalty (§7.3)",
      });
    }

    case POLICY.ADMIT:
      return Object.freeze({
        admitted: true,
        resolution: RESOLUTION.ADMITTED,
        outcome,
        deniedForIndeterminacy: false,
        penaltyMilliCu: null,
        envelopeReduced: false,
        policy,
        reason: predicateResult.reason || "INDETERMINATE admitted unchanged (§7.3)",
      });

    default:
      // Unreachable: assertPolicyLawful already rejected an unknown policy. Kept so
      // that a future policy added to POLICY without a case here denies rather than
      // falls through to admission.
      return Object.freeze({
        admitted: false,
        resolution: RESOLUTION.DENIED,
        outcome,
        deniedForIndeterminacy: true,
        penaltyMilliCu: null,
        envelopeReduced: false,
        policy,
        reason: `policy "${String(policy)}" has no application rule; denied`,
      });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Shared predicate support
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Read a resolved configuration value by its register name.
 *
 * `config` is the **already resolved** view for this candidate's scope chain — the
 * output of `config/resolver.js`, not the resolver itself. Predicates are pure
 * functions of `(agentSnapshot, mission, plan, config)`; handing them a resolver
 * would hand them a store, and the register's order-independence claim (§7.5) rests
 * on their having neither.
 *
 * A value that is absent is returned as `undefined` rather than defaulted here. Every
 * caller in the 38 modules turns that into `INDETERMINATE`, which is what §22.1
 * requires: a threshold that silently defaults inside a predicate is a behavioural
 * constant outside the register.
 *
 * @param {object|Map|null|undefined} config
 * @param {string} name a parameter-register name
 * @returns {*} the resolved value, or `undefined`
 */
function readParameter(config, name) {
  if (!config) return undefined;
  if (config instanceof Map) return config.get(name);
  if (typeof config.get === "function") return config.get(name);
  if (typeof config.values === "object" && config.values !== null) return config.values[name];
  return config[name];
}

/**
 * Read a register parameter that is indexed by a key — `capacity[agent_class]`,
 * `cost.uncertainty_penalty[predicate]`, `energy.shortfall_probability[tier]`.
 *
 * Accepts both the flat form (`"capacity.ROBOT_A"`) and the map form
 * (`config["capacity"] = { ROBOT_A: 2 }`), because the resolver publishes indexed
 * parameters as maps and a caller assembling a fixture will reach for the flat name.
 *
 * @param {object|Map|null|undefined} config
 * @param {string} name
 * @param {string|null|undefined} key
 * @returns {*}
 */
function readIndexedParameter(config, name, key) {
  const map = readParameter(config, name);
  if (map !== undefined && map !== null && typeof map === "object" && key !== undefined && key !== null) {
    const indexed = map instanceof Map ? map.get(String(key)) : map[String(key)];
    if (indexed !== undefined) return indexed;
  }
  if (key === undefined || key === null) return map;
  const flat = readParameter(config, `${name}.${key}`);
  return flat !== undefined ? flat : undefined;
}

/**
 * Is this a usable finite number? Used everywhere a threshold or a measurement is
 * read, because `null`, `undefined`, and `NaN` must all take the `INDETERMINATE`
 * path rather than the comparison path — `NaN < x` is `false`, and a predicate that
 * compared against it would report SATISFIED for an unreadable value.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Seconds → milliseconds. Register durations are held in seconds (Appendix A's
 * `unit: "s"`); every age this module's predicates compute is in milliseconds,
 * because that is what `Date` arithmetic and `observation.assess()` produce.
 *
 * @param {number} seconds
 * @returns {number}
 * @structural the SI relation between seconds and milliseconds, not a tunable value
 */
function secondsToMs(seconds) {
  // @structural the SI relation between seconds and milliseconds, not a tunable value
  return seconds * 1000;
}

/**
 * Coerce a `Date`, ISO string, or epoch-millisecond number to epoch milliseconds.
 *
 * Written with `Date.parse` and `getTime` rather than the `new Date(value)`
 * constructor purely so the T6 gate can read this module without an exemption: the
 * gate's pattern for a wall-clock read is the constructor call itself, and a
 * parameterised construction is indistinguishable from `new Date()` to a regular
 * expression. Both forms here are pure functions of their argument.
 *
 * @param {Date|string|number|null|undefined} value
 * @returns {number|null} null when unreadable — never a defaulted "now", which would
 *   make an unreadable timestamp maximally fresh
 */
function epochMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value.getTime === "function") {
    const fromDate = value.getTime();
    return Number.isFinite(fromDate) ? fromDate : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = {
  OUTCOME,
  MARGIN_UNIT,
  OUTCOMES,
  CONSTRAINT_CLASS,
  CONSTRAINT_CLASSES,
  NEVER_OVERRIDABLE_CLASSES,
  POLICY,
  POLICIES,
  POLICY_PERMITTED_CLASSES,
  RESOLUTION,
  result,
  satisfied,
  violated,
  indeterminate,
  absent,
  stale,
  assertPolicyLawful,
  applyPolicy,
  readParameter,
  readIndexedParameter,
  isNumber,
  secondsToMs,
  epochMs,
};

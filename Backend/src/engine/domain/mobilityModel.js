"use strict";

/**
 * MobilityModel (§2.2).
 *
 * > The MobilityModel makes heterogeneous locomotion a parameter rather than a
 * > special case.
 *
 * > The Routing Service is queried *with* a MobilityModel reference, so travel time
 * > for a loaded stair-capable indoor robot and for a drone over the same
 * > origin/destination pair are different queries against different networks — not
 * > the same query with a fudge factor.
 *
 * That last sentence is the reason this module exists in Phase 2 rather than Phase
 * 7: the routing key is part of the domain model, and every routing cache built in
 * Phases 7–9 is keyed by a *profile* that this module defines. A cache keyed on a
 * profile invented later would have to be rebuilt.
 *
 * Phase 2 lands the six §2.2 elements, the validation that a model declares all of
 * them, and the routing-profile key. The speed model itself — speed as a function of
 * road class, gradient, surface, payload mass, congestion, and weather — is
 * evaluated by the routing client in Phases 7–9 against a self-hosted engine
 * (blocking decision B1); this module holds its declaration, not its arithmetic.
 */

/**
 * The six elements §2.2 tabulates. Named as data so `validateModel()` and any later
 * consumer read the same list.
 * @structural the specification's own element names
 */
const MOBILITY_ELEMENTS = Object.freeze([
  "traversalDomain",
  "permissionSet",
  "speedModel",
  "kinematicLimits",
  "envelopeConstraints",
  "dimensionalFootprint",
]);

/**
 * Which network the agent may use (§2.2 "Traversal domain"). A composition is
 * permitted — §25.3's multi-modal missions are exactly a composition — and is
 * expressed as an array of these values rather than a seventh value meaning "some
 * combination".
 * @structural network identifiers
 */
const TRAVERSAL_DOMAIN = Object.freeze({
  SIDEWALK_GRAPH: "SIDEWALK_GRAPH",
  ROAD_GRAPH: "ROAD_GRAPH",
  INDOOR_GRAPH: "INDOOR_GRAPH",
  AIRSPACE_VOLUME: "AIRSPACE_VOLUME",
});

const TRAVERSAL_DOMAINS = Object.freeze(Object.values(TRAVERSAL_DOMAIN));

/**
 * @param {unknown} domain
 * @returns {boolean}
 */
function isTraversalDomain(domain) {
  return typeof domain === "string" && TRAVERSAL_DOMAINS.includes(domain);
}

/**
 * Normalise a declared traversal domain — a single value or a composition — into a
 * canonically ordered array, so two models declaring the same networks in different
 * orders produce the same routing profile key.
 *
 * @param {string|string[]|null|undefined} declared
 * @returns {string[]}
 */
function traversalDomains(declared) {
  const list = Array.isArray(declared) ? declared : declared === undefined || declared === null ? [] : [declared];
  const unique = [...new Set(list.filter(isTraversalDomain))];
  // Code-unit sort: host-independent, per the determinism discipline of §9.6.
  return unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The routing-profile key a Routing Service query is made under (§2.2, §20.3).
 *
 * §20.3's cell-pair cache is keyed `{originCell}:{destCell}:{profile}:{bucket}`, and
 * this is the `profile` component. It is derived from the model rather than stored
 * beside it so that a model change cannot leave a cache keyed under a profile that
 * no longer describes it.
 *
 * The loaded and unloaded cases are distinct profiles because §15.5 states that
 * mass and CoG limit traversable inclines, which makes it a *routing* constraint:
 * "the routing query for a loaded leg differs from the unloaded one".
 *
 * @param {{ modelId?: string, traversalDomain?: string|string[] }} model
 * @param {{ loaded?: boolean }} [options]
 * @returns {string}
 */
function routingProfileKey(model, options) {
  const id = model && typeof model.modelId === "string" ? model.modelId : "unknown";
  const domains = traversalDomains(model && model.traversalDomain).join("+") || "unknown";
  const load = options && options.loaded ? "loaded" : "unloaded";
  return `${id}:${domains}:${load}`;
}

/**
 * Structural validation of a declared MobilityModel.
 *
 * Every §2.2 element must be **declared**, including as an explicitly empty object.
 * An absent element is a gap, and §2.7's rule applies to model declarations as much
 * as to observations: state is never inferred from the absence of data.
 *
 * @param {object} model
 * @returns {string[]} problems, empty when well-formed
 */
function validateModel(model) {
  if (!model || typeof model !== "object") return ["mobility model is not an object"];
  const problems = [];
  const id = typeof model.modelId === "string" ? model.modelId : "<unnamed>";

  if (typeof model.modelId !== "string" || model.modelId.length === 0) {
    problems.push("mobility model has no modelId");
  }

  if (traversalDomains(model.traversalDomain).length === 0) {
    problems.push(
      `mobility model "${id}" declares no recognised traversal domain; §2.2 defines ${TRAVERSAL_DOMAINS.join(", ")} ` +
        "or a composition of them",
    );
  }

  for (const element of MOBILITY_ELEMENTS) {
    if (model[element] === undefined || model[element] === null) {
      problems.push(
        `mobility model "${id}" does not declare "${element}". §2.2 requires all six elements; an absent ` +
          "one is a gap, not a permissive default",
      );
    }
  }

  return problems;
}

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 15 — the speed model's readiness, which is D3's and is not decided here
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The six things §2.2 states a speed model is a function **of**: "speed as a function of road
 * class, gradient, surface, payload mass, congestion, and weather".
 *
 * This list is the specification's own and is not a schema this module invents. Nothing below
 * reads a *value* from any of them, states a plausible range for one, or supplies one when it
 * is missing — a speed, a gradient response, a congestion coefficient and a weather
 * coefficient are **D3**, owned by Product + Fleet Engineering, and §25.4 makes inventing one
 * a commissioning-gate violation: "a heterogeneous fleet with copy-pasted parameters will make
 * confidently wrong cross-class comparisons, which is worse than not comparing at all."
 *
 * What is checked is only whether the declaration *addresses* each factor. That is the
 * difference between a model and a placeholder, and it is checkable without knowing a number.
 * @structural §2.2's own factor list
 */
const SPEED_MODEL_FACTORS = Object.freeze(["roadClass", "gradient", "surface", "payloadMass", "congestion", "weather"]);

/**
 * How usable a declared speed model is as an input to routing edge costs.
 *
 * The distinction that matters is `STUB` versus `ABSENT`. §36.6 records the seeded model's
 * `speedModel` as `{ note: "Populated by the routing integration in Phases 7–9 (blocking
 * decision B1)" }` — an object, so every "is it declared?" check passes, and it contains
 * nothing a routing engine could weight an edge with. A stub that reads as present is more
 * dangerous than an absent field, because absence is at least visible.
 * @structural the D3 readiness states
 */
const SPEED_MODEL_STATUS = Object.freeze({
  /** No speed model is declared at all. */
  ABSENT: "ABSENT",
  /** Declared, and it addresses none of §2.2's factors — a placeholder, not a model. */
  STUB: "STUB",
  /** Declared and addresses some but not all of §2.2's factors. */
  INCOMPLETE: "INCOMPLETE",
  /** Declared and addresses every §2.2 factor. Whether the *values* are right is commissioning's. */
  DECLARED: "DECLARED",
});

/**
 * Classify a model's `speedModel` (§2.2, decision **D3**).
 *
 * @param {object} model
 * @returns {{ status: string, declared: string[], missing: string[], reason: string }}
 */
function speedModelStatus(model) {
  const declared = model && typeof model === "object" ? model.speedModel : undefined;
  if (declared === undefined || declared === null) {
    return Object.freeze({
      status: SPEED_MODEL_STATUS.ABSENT,
      declared: Object.freeze([]),
      missing: SPEED_MODEL_FACTORS,
      reason: "no speedModel is declared (§2.2 requires all six MobilityModel elements)",
    });
  }
  if (typeof declared !== "object" || Array.isArray(declared)) {
    return Object.freeze({
      status: SPEED_MODEL_STATUS.ABSENT,
      declared: Object.freeze([]),
      missing: SPEED_MODEL_FACTORS,
      reason: `speedModel is ${Array.isArray(declared) ? "an array" : typeof declared}; §2.2's speed model is a declaration of speed as a function of six named factors`,
    });
  }

  const present = SPEED_MODEL_FACTORS.filter(
    (factor) => Object.prototype.hasOwnProperty.call(declared, factor) && declared[factor] !== undefined && declared[factor] !== null,
  );
  const missing = SPEED_MODEL_FACTORS.filter((factor) => !present.includes(factor));

  if (present.length === 0) {
    return Object.freeze({
      status: SPEED_MODEL_STATUS.STUB,
      declared: Object.freeze([]),
      missing: Object.freeze(missing),
      reason:
        "speedModel is declared but addresses none of §2.2's factors — it is a placeholder. A contraction " +
        "hierarchy is a precomputation over edge COSTS, and a placeholder yields no costs, so a hierarchy built " +
        "behind it would be a precomputation over numbers nobody chose",
    });
  }
  if (missing.length > 0) {
    return Object.freeze({
      status: SPEED_MODEL_STATUS.INCOMPLETE,
      declared: Object.freeze(present),
      missing: Object.freeze(missing),
      reason: `speedModel addresses ${present.join(", ")} but not ${missing.join(", ")}; §2.2 states all six, and an omitted factor is a gap rather than a permissive default (§2.7)`,
    });
  }
  return Object.freeze({
    status: SPEED_MODEL_STATUS.DECLARED,
    declared: Object.freeze(present),
    missing: Object.freeze([]),
    reason: "speedModel addresses every §2.2 factor. Whether its VALUES are the fleet's is commissioning evidence, which this check cannot and does not assert",
  });
}

/**
 * Is this model usable as a routing input — that is, may a per-profile contraction hierarchy
 * be built from it?
 *
 * ── Why this is separate from `validateModel()` ───────────────────────────
 * `validateModel()` answers §2.2's structural question — are all six elements *declared*? —
 * and `ADR-33` rider 2 makes it the check the Phase 8 client must call before it keys, because
 * `routingProfileKey()` is total and yields `unknown:unknown:*` for a broken model. That
 * contract is unchanged, and this function does not alter it.
 *
 * This one answers B1 Step 1's question instead, and it is stricter for one specific reason:
 * a model can satisfy §2.2 structurally and still be unroutable, which is exactly the state
 * the repository is in. The seeded `MOB-SIDEWALK-DEFAULT` declares all six elements and its
 * speed model is a note. Passing it into hierarchy construction would produce edge costs
 * derived from nothing, and a benchmark run against those hierarchies would produce numbers
 * that look like evidence and are not.
 *
 * **This function decides no value.** It reports `BLOCKED` and names D3's owner.
 *
 * @param {object} model
 * @returns {{ routable: boolean, problems: string[], speedModel: object }}
 */
function validateRoutingReadiness(model) {
  const problems = [...validateModel(model)];
  const speed = speedModelStatus(model);
  if (speed.status !== SPEED_MODEL_STATUS.DECLARED) {
    const id = model && typeof model.modelId === "string" ? model.modelId : "<unnamed>";
    problems.push(
      `mobility model "${id}" is NOT ROUTABLE — ${speed.status}: ${speed.reason}. This is decision D3 (Product + ` +
        "Fleet Engineering): the fleet's agent classes and, per class, a real speed model. No speed is chosen " +
        "here, no default is substituted, and B1 Step 1 stays BLOCKED rather than building a hierarchy over " +
        "costs that were never decided",
    );
  }
  return { routable: problems.length === 0, problems, speedModel: speed };
}

module.exports = {
  MOBILITY_ELEMENTS,
  TRAVERSAL_DOMAIN,
  TRAVERSAL_DOMAINS,
  SPEED_MODEL_FACTORS,
  SPEED_MODEL_STATUS,
  isTraversalDomain,
  traversalDomains,
  routingProfileKey,
  validateModel,
  speedModelStatus,
  validateRoutingReadiness,
};

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

module.exports = {
  MOBILITY_ELEMENTS,
  TRAVERSAL_DOMAIN,
  TRAVERSAL_DOMAINS,
  isTraversalDomain,
  traversalDomains,
  routingProfileKey,
  validateModel,
};

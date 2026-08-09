"use strict";

/**
 * The layered reserve model (§14.5) — **Tier 0**.
 *
 * > Four reserves, each with a distinct justification. They are additive, and **none may
 * > be traded against another.**
 *
 * | Reserve | Definition | Purpose | Overridable |
 * |---|---|---|---|
 * | `E_floor` | Hardware protection floor | Below this the pack risks damage or the agent loses controlled shutdown | **Never** |
 * | `E_return` | Energy to reach the nearest *available* charger from the mission end, by a pessimistic route | Prevents completing the delivery and stranding afterwards | Never |
 * | `E_contingency` | Quantile allowance for reroutes, congestion, weather, and consumption variance | Absorbs the realistic bad case rather than the average case | Never |
 * | `E_operational` | Optional buffer to remain useful for a following mission | Efficiency, not safety | Yes, by policy |
 *
 * ── "May not be traded" is enforced, not asserted ───────────────────────────
 * The sentence is easy to agree with and easy to violate, because the violation never
 * looks like one: it looks like "we have plenty of contingency, borrow 40 Wh of it to
 * make the return reserve work". `assertNoTrade()` compares two compositions and
 * refuses any recomposition in which a non-overridable layer *fell* while another
 * *rose*. That is the shape every trade takes, whatever it is called at the call site.
 *
 * ── The contingency layer is derived, not configured ────────────────────────
 * > The contingency reserve is sized at the quantile that satisfies T1, so
 * > `energy.contingency_quantile = 1 − α_1` is **derived**, not a free parameter.
 * > Configuring the quantile and the tier-1 probability independently would permit them
 * > to contradict each other — a 0.95 quantile cannot deliver a 1e-2 tier-1 target —
 * > and the contradiction would be invisible because each value looks defensible alone.
 *
 * So `contingencyWh()` takes the derived quantile and the predictive distribution, and
 * returns the distance from the mean to that quantile. There is no path through this
 * module by which a contingency reserve is chosen directly.
 *
 * ── Degradation multiplies every layer, never one ───────────────────────────
 * `applyMultiplier()` scales all four together. A degraded mode that inflated only the
 * return reserve would change the *shape* of the reserve stack, and the shape is what
 * the three tier conditions of §14.5 are defined against — T2's threshold is
 * `E_floor + E_return` specifically, not "some reserve".
 *
 * Tier 0 (T0-03). Decision path (T6): no clock, no randomness, no store.
 */

const { quantileWh } = require("./consumption");

/**
 * §14.5's four layers, in the nesting order the tier conditions consume them.
 * @structural the specification's own reserve table
 */
const LAYERS = Object.freeze([
  Object.freeze({
    id: "E_floor",
    field: "floorWh",
    definition: "Hardware protection floor",
    purpose: "Below this the pack risks damage or the agent loses controlled shutdown",
    overridable: false,
  }),
  Object.freeze({
    id: "E_return",
    field: "returnWh",
    definition: "Energy to reach the nearest available charger from the mission end, by a pessimistic route",
    purpose: "Prevents completing the delivery and stranding afterwards",
    overridable: false,
  }),
  Object.freeze({
    id: "E_contingency",
    field: "contingencyWh",
    definition: "Quantile allowance for reroutes, congestion, weather, and consumption variance",
    purpose: "Absorbs the realistic bad case rather than the average case",
    overridable: false,
  }),
  Object.freeze({
    id: "E_operational",
    field: "operationalWh",
    definition: "Optional buffer to remain useful for a following mission",
    purpose: "Efficiency, not safety",
    overridable: true,
  }),
]);

const LAYER_FIELDS = Object.freeze(LAYERS.map((layer) => layer.field));
const PROTECTED_FIELDS = Object.freeze(LAYERS.filter((layer) => !layer.overridable).map((layer) => layer.field));

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Compose the four layers into one immutable stack.
 *
 * Every layer is required. An absent `E_return` is not a zero return reserve — it is a
 * reachability question nobody answered, and treating it as zero is precisely the
 * "completed the delivery, stranded afterwards" failure §14.5 exists to prevent.
 *
 * @param {{floorWh: number, returnWh: number, contingencyWh: number, operationalWh: number}} input
 * @returns {{ ok: boolean, layers: object|null, totalWh: number|null, missing: string[] }}
 */
function compose(input) {
  const source = input || {};
  const missing = [];

  for (const field of LAYER_FIELDS) {
    const value = source[field];
    if (!isNumber(value) || value < 0) missing.push(field);
  }
  if (missing.length > 0) return { ok: false, layers: null, totalWh: null, missing };

  const layers = Object.freeze(
    LAYER_FIELDS.reduce((accumulator, field) => {
      accumulator[field] = source[field];
      return accumulator;
    }, {}),
  );

  return {
    ok: true,
    layers,
    totalWh: LAYER_FIELDS.reduce((sum, field) => sum + layers[field], 0),
    missing: [],
  };
}

/**
 * `E_contingency` — the distance from the mean to the derived quantile.
 *
 * > Absorbs the realistic bad case rather than the average case.
 *
 * The mission's *mean* energy is already charged against usable energy by F34's own
 * arithmetic, so the reserve is the excess of the quantile over the mean, not the
 * quantile itself. Charging the whole quantile would double-count the mean.
 *
 * @param {{ meanWh: number, sdWh: number }} distribution the predictive distribution
 * @param {number} contingencyQuantile the **derived** `energy.contingency_quantile`
 * @returns {{ ok: boolean, wh: number|null, quantileWh: number|null, reason: string|null }}
 */
function contingencyWh(distribution, contingencyQuantile) {
  if (!distribution || !isNumber(distribution.meanWh) || !isNumber(distribution.sdWh)) {
    return { ok: false, wh: null, quantileWh: null, reason: "no predictive distribution for E_mission (§14.5)" };
  }
  if (!isNumber(contingencyQuantile) || contingencyQuantile <= 0 || contingencyQuantile >= 1) {
    return {
      ok: false,
      wh: null,
      quantileWh: null,
      reason:
        "energy.contingency_quantile is unresolved. It is DERIVED as 1 − α₁ and may not be configured " +
        "independently of the tier-1 target (§14.5, §22.1 rule 6)",
    };
  }

  const atQuantile = quantileWh(distribution, contingencyQuantile);
  if (!isNumber(atQuantile)) {
    return { ok: false, wh: null, quantileWh: null, reason: "the quantile could not be evaluated" };
  }

  return { ok: true, wh: Math.max(0, atQuantile - distribution.meanWh), quantileWh: atQuantile, reason: null };
}

/**
 * Scale every layer by a degradation multiplier.
 *
 * @param {object} layers
 * @param {number} multiplier ≥ 1
 * @returns {{ ok: boolean, layers: object|null, multiplier: number|null, reason: string|null }}
 */
function applyMultiplier(layers, multiplier) {
  if (!layers) return { ok: false, layers: null, multiplier: null, reason: "no reserve stack supplied" };
  if (!isNumber(multiplier) || multiplier < 1) {
    // A multiplier below 1 shrinks reserves. §7.4's `assertRelaxesNothing()` refuses
    // one on the degraded envelope for the same reason it is refused here: a
    // relaxation wearing a tightening's name.
    return {
      ok: false,
      layers: null,
      multiplier: null,
      reason: "a reserve multiplier below 1 shrinks the reserve stack; degradation may not relax a Tier 0 constraint (§7.4, §18.5)",
    };
  }

  const scaled = {};
  for (const field of LAYER_FIELDS) {
    const value = layers[field];
    if (!isNumber(value)) return { ok: false, layers: null, multiplier: null, reason: `layer ${field} is unreadable` };
    scaled[field] = value * multiplier;
  }

  return { ok: true, layers: Object.freeze(scaled), multiplier, reason: null };
}

/**
 * §14.5's "none may be traded against another", enforced.
 *
 * A trade is any recomposition in which a **non-overridable** layer decreased at all.
 * The rule is stated on the protected layers only because `E_operational` is explicitly
 * overridable by policy — releasing it is a policy decision, not a trade.
 *
 * The check is deliberately one-sided: a protected layer *rising* is always lawful (a
 * later, more pessimistic return route is more reserve, not less), and only a fall
 * needs justification. That keeps the assertion usable at every point a stack is
 * recomputed rather than only at composition.
 *
 * @param {object} before
 * @param {object} after
 * @param {number} [toleranceWh] floating-point slack, in Wh
 * @returns {{ ok: boolean, traded: object[], problems: string[] }}
 */
function assertNoTrade(before, after, toleranceWh) {
  // @structural floating-point slack, not a policy allowance: a genuine trade moves
  // whole watt-hours, and this admits only re-association error in a sum.
  const tolerance = isNumber(toleranceWh) ? toleranceWh : 1e-9;
  const traded = [];
  const problems = [];

  if (!before || !after) {
    return { ok: false, traded, problems: ["assertNoTrade needs both compositions"] };
  }

  const rose = [];
  for (const field of LAYER_FIELDS) {
    const from = before[field];
    const to = after[field];
    if (!isNumber(from) || !isNumber(to)) {
      problems.push(`layer ${field} is unreadable in one of the two compositions`);
      continue;
    }
    if (to > from + tolerance) rose.push(field);
    if (PROTECTED_FIELDS.includes(field) && to < from - tolerance) {
      traded.push({ layer: field, fromWh: from, toWh: to });
    }
  }

  for (const fell of traded) {
    problems.push(
      `${fell.layer} fell from ${fell.fromWh} Wh to ${fell.toWh} Wh` +
        (rose.length > 0 ? ` while ${rose.join(", ")} rose` : "") +
        ". §14.5's reserves are additive and none may be traded against another; each exists for a " +
        "different failure whose consequence is orders of magnitude apart from the others'",
    );
  }

  return { ok: problems.length === 0, traded, problems };
}

/**
 * Release the one overridable layer, by policy (§14.5).
 *
 * Returned as a new stack rather than mutated, and reported, so that a decision record
 * can state that the efficiency buffer was released and by whose policy — which is the
 * difference between an override and an erosion.
 *
 * @param {object} layers
 * @param {string} reason
 * @returns {{ ok: boolean, layers: object|null, released: object|null }}
 */
function releaseOperational(layers, reason) {
  if (!layers || !isNumber(layers.operationalWh)) return { ok: false, layers: null, released: null };
  return {
    ok: true,
    layers: Object.freeze({ ...layers, operationalWh: 0 }),
    released: Object.freeze({ layer: "E_operational", wh: layers.operationalWh, reason: reason || "policy" }),
  };
}

/**
 * The `energyReserveParams` field of §11.2's offer.
 *
 * Phase 4 declared the field and left it null; this is the producer the execution plan
 * assigns to Phase 7 ("Offer payload gains `energyReserveParams` and `targetSoc`").
 *
 * > the *agent* receives the reserve parameters and the target SoC as part of the offer,
 * > so the two sides reason from identical inputs by construction rather than by a
 * > shared constant that a future edit could desynchronise.
 *
 * The layers are sent **in watt-hours**, unsummed, together with the pack capacity the
 * agent needs to turn its own state of charge into watt-hours. Sending a single total
 * would let the agent trade the layers against one another without knowing it was doing
 * so; sending a percentage would reintroduce the constant §14.1 removed.
 *
 * `targetSoc` is passed through with its provenance. The agent consumes it exactly as
 * the engine does — as an input it did not choose (§14.6).
 *
 * @param {object} input
 * @param {object} input.layers a `compose()` stack
 * @param {number} input.packNominalWh
 * @param {number|null} input.targetSoc
 * @param {string|null} input.targetSocSource `SCHEDULER` or `CLASS_DEFAULT`
 * @returns {{ ok: boolean, params: object|null, problems: string[] }}
 */
function offerParams(input) {
  const source = input || {};
  const problems = [];

  if (!source.layers) problems.push("no reserve stack supplied");
  else {
    for (const field of LAYER_FIELDS) {
      if (!isNumber(source.layers[field])) problems.push(`reserve layer ${field} is unresolved`);
    }
  }
  if (!isNumber(source.packNominalWh) || source.packNominalWh <= 0) {
    problems.push("packNominalWh is unresolved; without it the agent cannot convert its own SoC into watt-hours");
  }

  if (problems.length > 0) return { ok: false, params: null, problems };

  return {
    ok: true,
    params: Object.freeze({
      packNominalWh: source.packNominalWh,
      floorWh: source.layers.floorWh,
      returnWh: source.layers.returnWh,
      contingencyWh: source.layers.contingencyWh,
      operationalWh: source.layers.operationalWh,
      // Named so a firmware author reading the wire format sees which layer policy may
      // release and which three it may not (§14.5).
      overridableLayers: Object.freeze(LAYERS.filter((layer) => layer.overridable).map((layer) => layer.field)),
      targetSoc: isNumber(source.targetSoc) ? source.targetSoc : null,
      targetSocSource: source.targetSocSource || null,
    }),
    problems: [],
  };
}

module.exports = {
  LAYERS,
  LAYER_FIELDS,
  PROTECTED_FIELDS,
  compose,
  contingencyWh,
  applyMultiplier,
  assertNoTrade,
  releaseOperational,
  offerParams,
};

"use strict";

/**
 * Load state along the plan (§15.4) — **Tier 0**.
 *
 * > Payload state is evaluated **per stop**, not once. Along a multi-stop plan, mass and
 * > volume rise and fall, compartments are occupied and freed, and CoG shifts. F22–F24
 * > must therefore hold at every point in the sequence, and a plan can be feasible at
 * > stops 1–3 and infeasible at stop 4. **This is why feasibility is a property of the
 * > plan (§13.1) rather than of the pairing.**
 *
 * That last sentence is the reason this module exists at all. A capacity check against
 * the consignment's total mass is not wrong so much as it is answering a different
 * question: the binding moment is the peak, and on a multi-drop plan the peak is
 * usually mid-route rather than at either end. `project()` produces the per-stop series
 * F22 iterates and F24 reads the CoG from.
 *
 * ── Access ordering is a sequencing constraint, not a packing one ──────────
 * > if item A must be removed before item B is reachable, then B's drop cannot precede
 * > A's. This is a genuine sequencing constraint that a capacity-only model cannot
 * > express, and it is a common source of real-world failures in multi-drop delivery.
 *
 * `accessOrderViolations()` checks it against the stop sequence, using the
 * `blockedBy` relation the container model declares. It is reported rather than
 * repaired: reordering the stops is the Plan Builder's decision (§13.3), and a payload
 * module that silently resequenced a plan would be making a routing decision.
 *
 * ── Where the CoG geometry comes from ──────────────────────────────────────
 * §15.2 puts the CoG envelope on the container model and does not tabulate compartment
 * positions, but a centre of mass cannot be computed without them. They are read from
 * the container's `cogEnvelope` payload as `compartmentCentroids` alongside the
 * envelope itself, so the geometry and the envelope it is checked against are published
 * together and cannot drift apart. A container that publishes an envelope but no
 * centroids yields `withinEnvelope: null` — unknown — and F24's class I policy denies,
 * rather than a CoG being assumed to sit at the origin.
 *
 * Tier 0 (T0-04). Decision path (T6): no clock, no randomness, no store.
 */

const spec = require("./spec");

/**
 * The three axes the CoG envelope is stated over. Height is optional: many envelopes
 * are stated in plan only.
 * @structural the axes of a centre-of-mass envelope
 */
const AXES = Object.freeze(["longitudinalMm", "lateralMm", "heightMm"]);

/**
 * What a stop does to the load. §2.4's stop types map onto these two effects.
 * @structural the two payload-affecting stop effects
 */
const EFFECT = Object.freeze({ LOAD: "LOAD", UNLOAD: "UNLOAD", NONE: "NONE" });

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Which effect a stop has, from its type.
 *
 * @param {object} stop
 * @returns {string}
 */
function effectOf(stop) {
  if (!stop) return EFFECT.NONE;
  if (stop.stopType === "PICKUP") return EFFECT.LOAD;
  if (stop.stopType === "DROP") return EFFECT.UNLOAD;
  return EFFECT.NONE;
}

/**
 * The centre of mass of a set of occupied compartments plus the empty vehicle.
 *
 * @param {object} cogEnvelope the container's published envelope and centroids
 * @param {Array<{compartmentId: string, massKg: number}>} occupancy
 * @returns {{ ok: boolean, cog: object|null, reason: string|null }}
 */
function centreOfMass(cogEnvelope, occupancy) {
  if (!cogEnvelope || typeof cogEnvelope !== "object") {
    return { ok: false, cog: null, reason: "the container publishes no CoG envelope (§15.2)" };
  }
  const centroids = cogEnvelope.compartmentCentroids;
  if (!centroids || typeof centroids !== "object") {
    return {
      ok: false,
      cog: null,
      reason:
        "the container publishes a CoG envelope but no compartment centroids, so a centre of mass cannot be " +
        "computed. Assuming an origin would put every load inside every envelope (§15.2)",
    };
  }

  const empty = cogEnvelope.emptyVehicle;
  const moments = { longitudinalMm: 0, lateralMm: 0, heightMm: 0 };
  let mass = 0;

  if (empty && isNumber(empty.massKg)) {
    mass += empty.massKg;
    for (const axis of AXES) {
      if (isNumber(empty[axis])) moments[axis] += empty.massKg * empty[axis];
    }
  }

  for (const row of occupancy) {
    if (!isNumber(row.massKg) || row.massKg === 0) continue;
    const centroid = centroids[row.compartmentId];
    if (!centroid) {
      return { ok: false, cog: null, reason: `no centroid is published for compartment ${String(row.compartmentId)}` };
    }
    mass += row.massKg;
    for (const axis of AXES) {
      if (isNumber(centroid[axis])) moments[axis] += row.massKg * centroid[axis];
    }
  }

  if (mass <= 0) {
    // An unladen vehicle whose own mass and centroid are unpublished. Reported rather
    // than answered: F24 asks where the mass is, and "there is no mass" is only a
    // lawful answer when the empty vehicle was declared.
    return { ok: false, cog: null, reason: "no mass is attributed, so a centre of mass is undefined" };
  }

  const cog = {};
  for (const axis of AXES) cog[axis] = moments[axis] / mass;
  return { ok: true, cog, reason: null };
}

/**
 * Is a centre of mass inside the published envelope, and by what margin?
 *
 * The margin is the **smallest** distance to any bound across the stated axes — the one
 * that binds. F24 reports it as `envelopeMarginMm`, and a per-axis margin would need
 * the predicate to know which axis to compare against a threshold.
 *
 * @param {object} cogEnvelope
 * @param {object} cog
 * @returns {{ withinEnvelope: boolean|null, envelopeMarginMm: number|null, axis: string|null }}
 */
function withinEnvelope(cogEnvelope, cog) {
  if (!cogEnvelope || !cog) return { withinEnvelope: null, envelopeMarginMm: null, axis: null };

  let tightest = null;
  let tightestAxis = null;
  let stated = 0;

  for (const axis of AXES) {
    const bounds = cogEnvelope[axis];
    // @structural an envelope bound is a [min, max] pair
    const isPair = Array.isArray(bounds) && bounds.length === 2 && bounds.every(isNumber);
    if (!isPair) continue;
    if (!isNumber(cog[axis])) continue;
    stated += 1;
    const [lower, upper] = bounds;
    const margin = Math.min(cog[axis] - lower, upper - cog[axis]);
    if (tightest === null || margin < tightest) {
      tightest = margin;
      tightestAxis = axis;
    }
  }

  if (stated === 0) return { withinEnvelope: null, envelopeMarginMm: null, axis: null };
  return { withinEnvelope: tightest >= 0, envelopeMarginMm: tightest, axis: tightestAxis };
}

/**
 * Project the load state at every stop in the plan.
 *
 * @param {object} input
 * @param {object[]} input.stops the plan's ordered stops
 * @param {object} input.container a normalised container model
 * @param {object[]} input.compartmentLoads the packing result's placement
 * @param {Record<string, string[]>} [input.itemsByStop] item ids loaded or unloaded at
 *   each stop, keyed by stop sequence. Absent, every item is loaded at the first
 *   `PICKUP` and unloaded at the last `DROP`, which is the single-consignment shape the
 *   Phase 2 backfill produces.
 * @returns {{ ok: boolean, loadState: object[]|null, peakLoadedMassKg: number|null,
 *             occupancy: object[]|null, problems: string[] }}
 */
function project(input) {
  const source = input || {};
  const stops = Array.isArray(source.stops) ? source.stops : null;
  if (!stops || stops.length === 0) return { ok: false, loadState: null, peakLoadedMassKg: null, occupancy: null, problems: ["the plan states no stops"] };

  const loads = Array.isArray(source.compartmentLoads) ? source.compartmentLoads : [];
  const compartmentOf = new Map();
  const itemById = new Map();
  for (const load of loads) {
    for (const item of load.items || []) {
      compartmentOf.set(item.itemId, load.compartmentId);
      itemById.set(item.itemId, item);
    }
  }

  const allItemIds = [...itemById.keys()];
  const firstPickup = stops.find((stop) => effectOf(stop) === EFFECT.LOAD);
  const lastDrop = [...stops].reverse().find((stop) => effectOf(stop) === EFFECT.UNLOAD);

  const byStop = source.itemsByStop || null;
  const loadedAt = (stop) => {
    if (byStop) return byStop[String(stop.sequence)] || [];
    return firstPickup && stop.sequence === firstPickup.sequence ? allItemIds : [];
  };
  const unloadedAt = (stop) => {
    if (byStop) return [];
    return lastDrop && stop.sequence === lastDrop.sequence ? allItemIds : [];
  };

  const onboard = new Set();
  const series = [];
  const occupancy = new Map();
  let peak = 0;
  const problems = [];

  /**
   * `t_occupied(k)` runs from the stop at which conditioned goods are **loaded** to the
   * stop at which they are **unloaded**, and it is recorded on the load and unload
   * events rather than by sampling membership at each stop. Sampling would close the
   * interval at the last stop where the goods were still aboard — which on a two-stop
   * plan is the pickup, giving a zero-length interval and an unpriced conditioning load
   * on exactly the cold-chain missions §14.2 says the omission hurts most.
   *
   * @param {string} compartmentId
   * @param {string} itemId
   * @param {number|null} atMs
   * @param {"open"|"close"} edge
   */
  const markOccupancy = (compartmentId, itemId, atMs, edge) => {
    const interval = occupancy.get(compartmentId) || { compartmentId, fromMs: null, untilMs: null, itemIds: new Set() };
    interval.itemIds.add(itemId);
    if (isNumber(atMs)) {
      if (edge === "open") interval.fromMs = interval.fromMs === null ? atMs : Math.min(interval.fromMs, atMs);
      else interval.untilMs = interval.untilMs === null ? atMs : Math.max(interval.untilMs, atMs);
    }
    occupancy.set(compartmentId, interval);
  };

  const isConditioned = (item) => Boolean(item) && (isNumber(item.thermalMinC) || isNumber(item.thermalMaxC));

  for (const stop of stops) {
    const arrivalMs = isNumber(stop.projectedArrivalMs) ? stop.projectedArrivalMs : null;

    if (effectOf(stop) === EFFECT.LOAD) {
      for (const itemId of loadedAt(stop)) {
        onboard.add(itemId);
        if (isConditioned(itemById.get(itemId))) markOccupancy(compartmentOf.get(itemId), itemId, arrivalMs, "open");
      }
    }
    if (effectOf(stop) === EFFECT.UNLOAD) {
      for (const itemId of unloadedAt(stop)) {
        onboard.delete(itemId);
        if (isConditioned(itemById.get(itemId))) markOccupancy(compartmentOf.get(itemId), itemId, arrivalMs, "close");
      }
    }

    let massUpperBoundKg = 0;
    let massExpectationKg = 0;
    let volumeLitres = 0;
    const perCompartment = new Map();

    for (const itemId of onboard) {
      const item = itemById.get(itemId);
      if (!item) continue;
      const upper = spec.itemMassForFeasibilityKg(item);
      const expectation = spec.itemMassForEnergyKg(item);
      if (upper === null || expectation === null) {
        problems.push(`item "${String(itemId)}" states no mass or tolerance; the per-stop load cannot be projected (§15.1)`);
        continue;
      }
      massUpperBoundKg += upper;
      massExpectationKg += expectation;
      if (isNumber(item.volumeLitres)) volumeLitres += item.volumeLitres;

      const compartmentId = compartmentOf.get(itemId);
      perCompartment.set(compartmentId, (perCompartment.get(compartmentId) || 0) + upper);
    }

    if (massUpperBoundKg > peak) peak = massUpperBoundKg;

    const occupied = [...perCompartment.entries()].map(([compartmentId, massKg]) => ({ compartmentId, massKg }));
    const cog = centreOfMass(source.container && source.container.cogEnvelope, occupied);
    const envelope = cog.ok
      ? withinEnvelope(source.container.cogEnvelope, cog.cog)
      : { withinEnvelope: null, envelopeMarginMm: null, axis: null };

    series.push(
      Object.freeze({
        sequence: stop.sequence,
        stopType: stop.stopType ?? null,
        projectedArrivalMs: isNumber(stop.projectedArrivalMs) ? stop.projectedArrivalMs : null,
        // F22's input, at the tolerance upper bound (§15.1).
        massUpperBoundKg,
        // `consumption.js`'s input, at the expectation (§15.1).
        massExpectationKg,
        volumeLitres,
        onboardItemIds: Object.freeze([...onboard]),
        compartmentMassKg: Object.freeze(Object.fromEntries(perCompartment)),
        // F24's input.
        cog: Object.freeze({
          withinEnvelope: envelope.withinEnvelope,
          envelopeMarginMm: envelope.envelopeMarginMm,
          bindingAxis: envelope.axis,
          longitudinalMm: cog.ok ? cog.cog.longitudinalMm : null,
          lateralMm: cog.ok ? cog.cog.lateralMm : null,
          heightMm: cog.ok ? cog.cog.heightMm : null,
          reason: cog.ok ? null : cog.reason,
        }),
      }),
    );
  }

  return {
    ok: problems.length === 0,
    loadState: Object.freeze(series),
    peakLoadedMassKg: peak,
    // `t_occupied(k)` per compartment — the interval `β_payload_thermal` is charged
    // over, and the reason the term is not charged over the whole mission (§14.2).
    occupancy: Object.freeze(
      [...occupancy.values()].map((interval) =>
        Object.freeze({
          compartmentId: interval.compartmentId,
          fromMs: interval.fromMs,
          untilMs: interval.untilMs,
          occupiedSeconds:
            isNumber(interval.fromMs) && isNumber(interval.untilMs)
              ? Math.max(0, (interval.untilMs - interval.fromMs) / 1000) // @structural milliseconds per second
              : null,
          itemIds: Object.freeze([...interval.itemIds]),
        }),
      ),
    ),
    problems,
  };
}

/**
 * §15.4's access-ordering constraint.
 *
 * A compartment's `blockedBy` names the compartments that must be cleared before it is
 * reachable. If item B sits in a compartment blocked by the compartment holding item A,
 * then B's drop may not precede A's.
 *
 * @param {object} input
 * @param {object[]} input.stops
 * @param {object} input.container a normalised container
 * @param {object[]} input.compartmentLoads
 * @param {Record<string, string[]>} input.dropsByStop item ids dropped at each stop
 * @returns {{ ok: boolean, violations: object[] }}
 */
function accessOrderViolations(input) {
  const source = input || {};
  const container_ = source.container || { compartments: [] };
  const blockedBy = new Map();
  for (const compartment of container_.compartments || []) {
    blockedBy.set(compartment.compartmentId, compartment.blockedBy || []);
  }

  const compartmentOf = new Map();
  for (const load of source.compartmentLoads || []) {
    for (const item of load.items || []) compartmentOf.set(item.itemId, load.compartmentId);
  }

  const dropOrder = new Map();
  for (const stop of source.stops || []) {
    const dropped = (source.dropsByStop || {})[String(stop.sequence)] || [];
    for (const itemId of dropped) dropOrder.set(itemId, stop.sequence);
  }

  const violations = [];
  for (const [itemId, sequence] of dropOrder.entries()) {
    const compartmentId = compartmentOf.get(itemId);
    for (const blockerId of blockedBy.get(compartmentId) || []) {
      for (const [otherId, otherSequence] of dropOrder.entries()) {
        if (compartmentOf.get(otherId) !== blockerId) continue;
        if (otherSequence > sequence) {
          violations.push({
            itemId,
            compartmentId,
            blockedByCompartmentId: blockerId,
            blockingItemId: otherId,
            droppedAtSequence: sequence,
            blockerDroppedAtSequence: otherSequence,
            reason:
              `item "${String(itemId)}" is dropped at stop ${sequence} but sits in compartment ` +
              `${String(compartmentId)}, which is blocked by compartment ${String(blockerId)} holding ` +
              `"${String(otherId)}" until stop ${otherSequence} (§15.4)`,
          });
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

module.exports = {
  AXES,
  EFFECT,
  effectOf,
  centreOfMass,
  withinEnvelope,
  project,
  accessOrderViolations,
};

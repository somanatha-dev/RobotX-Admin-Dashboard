"use strict";

/**
 * Execution geometry — the drivable route an offer's stop sequence carries.
 *
 * ── Two producers, chosen by the composition ────────────────────────────────
 *   * `attachPricedPaths` — the route the assignment was **priced** on, carried from the
 *     round's routing. Used where the decision-path router returns the traversal's geometry
 *     (the V1 demonstration's campus network, `routeEndpointBasis: EXACT_POINTS`). The
 *     priced route and the driven route are then the same points.
 *   * `attachStopPaths` — a provider route per stop (Mapbox by default), computed for an
 *     agent already chosen. Used where the decision-path router carries no geometry; it is
 *     what the paragraphs below describe.
 *
 * ── What this is, and the one thing it is emphatically not ──────────────────
 * It is an **execution-path addition**. It produces the waypoint list an agent drives
 * between two points that the assignment has already been made about, using the same
 * `mapbox.service.directionsWithDistance()` the reroute path has always used.
 *
 * It is **not** a routing source for the decision path. §5's `route` contract that the
 * coordinator's composition declares — travel time, its standard deviation, per-hop
 * terrain, a time bucket, a per-profile speed — is six fields, and this produces one of
 * them at best. Nothing here is read by candidate generation, by the feasibility gate, by
 * any cost term, or by the solve. `coordinatorPipeline.requirements()` is unchanged by
 * this module's existence, and a run that imports it still refuses on `route`. Presenting
 * a Mapbox polyline as the missing traversal source would be exactly the fabrication the
 * programme's standing rule forbids; drawing the line an already-chosen agent drives is
 * not.
 *
 * ── No network call happens inside the commitment transaction ───────────────
 * §10.3.2's commit is a SERIALIZABLE transaction over locked rows. An HTTP request inside
 * it would hold those locks for the duration of an external round trip, and a slow or
 * hanging provider would become a store-wide stall. So the geometry is computed **before**
 * the transaction opens, by the composition root, and the already-resolved points are
 * closed over by the `sideEffects` writer that runs inside it. The transaction sees data,
 * never a socket.
 *
 * ── Absence is absence ──────────────────────────────────────────────────────
 * When no route can be obtained the stop carries **no** `path`, and that is the whole
 * behaviour. There is deliberately no straight-line substitute: `VirtualRobot`'s
 * `assessExecutability` refuses an offer whose stops carry no traversable path and answers
 * `OFFER_REJECT` with `NO_EXECUTABLE_PATH`, which returns the Leg to `QUEUED` and records a
 * feasibility observation. That refusal is correct and this module must not defeat it by
 * inventing a line through buildings for the agent to "drive".
 */

const { directionsWithDistance } = require("./mapbox.service");
const logger = require("../config/logger");

/**
 * The profiles tried, in order, until one answers.
 *
 * The same three the reroute path has always tried, in the same order and for the same
 * reason: `driving` is the real road network and works for any two points in the operating
 * region, `walking` covers campus paths a vehicle profile will not route over, and
 * `cycling` is the last resort. A campus pickup that no car can reach is a real case, and
 * a single-profile lookup turns it into "no route" rather than "a different route".
 *
 * @structural provider profile names, not tunable values
 */
const PROFILES = Object.freeze(["driving", "walking", "cycling"]);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isCoordinate(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Number.isFinite(value.lat) &&
    Number.isFinite(value.lon)
  );
}

/**
 * Is this a path an agent can actually traverse?
 *
 * The same two-point floor `VirtualRobot.isTraversablePath` applies, restated on the
 * producing side so a path that the consumer would refuse is never attached in the first
 * place. A one-point "route" satisfies the phase machine's end condition on its first tick
 * and would complete a mission during which nothing moved.
 *
 * @param {unknown} points
 * @returns {boolean}
 */
function isTraversable(points) {
  return Array.isArray(points) && points.length >= 2 && points.every(isCoordinate);
}

/**
 * One route between two points, or null.
 *
 * @param {{ from: object, to: object, directions?: Function }} input
 * @returns {Promise<{ points: object[], distanceMeters: number|null, profile: string }|null>}
 */
async function routeBetween(input) {
  const settings = input || {};
  const provider = typeof settings.directions === "function" ? settings.directions : directionsWithDistance;

  if (!isCoordinate(settings.from) || !isCoordinate(settings.to)) return null;

  for (const profile of PROFILES) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await provider({ from: settings.from, to: settings.to, profile });
      if (isTraversable(result && result.points)) {
        return {
          points: result.points,
          distanceMeters: Number.isFinite(result.distanceMeters) ? result.distanceMeters : null,
          profile,
        };
      }
    } catch (e) {
      logger.warn?.(`[executionGeometry] ${profile} route failed — ${e?.message}`);
    }
  }

  return null;
}

/**
 * Attach drivable geometry to a plan's stop sequence.
 *
 * The first leg runs from the agent's own position to the first stop; each subsequent leg
 * runs from the previous stop to the next. That is the sequence the agent actually drives,
 * and it is why the agent's position is a required input rather than an optimisation: a
 * stop sequence alone describes where to be, not how to get to the first of them.
 *
 * ── All or nothing, per stop ────────────────────────────────────────────────
 * A stop whose leg could not be routed is returned **unchanged** — no `path` key at all,
 * so the consumer's own absence check reads absence rather than an empty array it has to
 * interpret. Subsequent stops are still attempted, because a single unroutable hop is not
 * a reason to withhold geometry for the rest of the plan; the agent will refuse the offer
 * either way, and the refusal names which half is missing.
 *
 * @param {object} input
 * @param {{ lat: number, lon: number }} input.from the agent's position at decision time
 * @param {object[]} input.stops the offer's stop sequence, each with `lat`/`lon`
 * @param {Function} [input.directions] injected provider, for tests
 * @returns {Promise<{ stops: object[], routed: number, unroutable: number[] }>}
 */
async function attachStopPaths(input) {
  const settings = input || {};
  const stops = Array.isArray(settings.stops) ? settings.stops : [];

  let cursor = isCoordinate(settings.from) ? { lat: settings.from.lat, lon: settings.from.lon } : null;

  const out = [];
  const unroutable = [];
  let routed = 0;

  for (const stop of stops) {
    const target = isCoordinate(stop) ? { lat: stop.lat, lon: stop.lon } : null;

    if (cursor === null || target === null) {
      unroutable.push(stop && stop.sequence !== undefined ? stop.sequence : out.length);
      out.push(stop);
      if (target !== null) cursor = target;
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const route = await routeBetween({ from: cursor, to: target, directions: settings.directions });

    if (route === null) {
      unroutable.push(stop.sequence === undefined ? out.length : stop.sequence);
      out.push(stop);
    } else {
      out.push({
        ...stop,
        // The executable geometry, in the `[{ lat, lon }, …]` shape the agent's phase
        // machine walks — the exact shape `mapbox.service.directionsWithDistance()`
        // already returns, reused rather than re-projected.
        path: route.points,
        // Carried beside it so a reader of the offer, the outbox row or the audit can tell
        // which provider profile produced the line without re-deriving it.
        pathProfile: route.profile,
        pathDistanceMeters: route.distanceMeters,
      });
      routed += 1;
    }

    cursor = target;
  }

  return { stops: out, routed, unroutable };
}

/** The `pathProfile` an OFFER stop carries when its path is the route it was priced on. @structural */
const PRICED_ROUTE_PROFILE = "PRICED_ROUTE";

/**
 * Attach the route each stop was **priced** on — no provider call, no second route.
 *
 * Where the composition's decision-path router returns the traversal's own geometry (the V1
 * demonstration's campus network), the round already holds, per stop, the points the hop's
 * distance and travel time were measured over. Those points are the execution geometry:
 * attaching them is what makes the route the agent drives and the dashboard draws the route
 * the assignment was decided on, rather than a line computed afterwards.
 *
 * Same output shape and the same absence rule as `attachStopPaths`: a stop with no priced
 * path (or one the agent could not traverse) is returned unchanged with no `path` key, and
 * the agent refuses the offer by name.
 *
 * @param {object} input
 * @param {object[]} input.stops the offer's stop sequence
 * @param {Array<{ path: object[], distanceM: number }|null>|null} input.pricedPaths per stop, in order
 * @returns {{ stops: object[], routed: number, unroutable: number[] }}
 */
function attachPricedPaths(input) {
  const settings = input || {};
  const stops = Array.isArray(settings.stops) ? settings.stops : [];
  const priced = Array.isArray(settings.pricedPaths) ? settings.pricedPaths : [];

  const out = [];
  const unroutable = [];
  let routed = 0;

  stops.forEach((stop, index) => {
    const entry = priced[index];
    const points = entry && Array.isArray(entry.path) ? entry.path.map((point) => ({ lat: point.lat, lon: point.lon })) : null;
    if (!isTraversable(points)) {
      unroutable.push(stop && stop.sequence !== undefined ? stop.sequence : index);
      out.push(stop);
      return;
    }
    out.push({
      ...stop,
      path: points,
      pathProfile: PRICED_ROUTE_PROFILE,
      pathDistanceMeters: Number.isFinite(entry.distanceM) ? entry.distanceM : null,
    });
    routed += 1;
  });

  return { stops: out, routed, unroutable };
}

module.exports = {
  PROFILES,
  PRICED_ROUTE_PROFILE,
  isTraversable,
  routeBetween,
  attachStopPaths,
  attachPricedPaths,
};

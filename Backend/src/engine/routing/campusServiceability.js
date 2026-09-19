"use strict";

/**
 * **Routing-local campus serviceability** — may the routing layer project and route to this
 * coordinate, or must it refuse?
 *
 * ── What this module is NOT: it is not the delivery-domain authority ────────
 * Read this before using any verdict below as an answer to "may this order be accepted?".
 *
 * The authoritative answer to *"is this destination inside RobotX's delivery domain?"* is the
 * **intake-pinned `Stop.geofenceResult`**, produced exactly once by `spatial/deliveryDomain.js`
 * at intake and read by the round through `deliveryDomain.pinnedMembership`. That is D1, and
 * ADR-28 states the rule it rests on: *containment by published assignment, **not by
 * query-time geometry***. This module is query-time geometry, so it **must not** be promoted
 * into that role, and no caller may write a verdict from here onto `Stop.geofenceResult`.
 *
 * What it is for: the routing layer holds cell ids, and a cell's representative coordinate is
 * a coordinate **this repository derived**, not one a customer supplied and intake pinned. Some
 * instrument has to be able to say "that derived point is off-campus, refuse rather than route
 * to it" — see `cellProjection.js`. That is a routing-local refusal about a derived point, and
 * it is a strictly narrower question than domain membership.
 *
 * The two vocabularies are deliberately different and are **not** interconvertible: this module
 * reports five verdicts including `ON_BOUNDARY`, while the pinned D1 vocabulary is three
 * (`INSIDE` / `OUTSIDE` / `INDETERMINATE`). They also differ by design on a declared boundary
 * vertex — D1 reads the domain as a **closed** set and answers `INSIDE`, this module answers
 * `ON_BOUNDARY` and leaves the commercial reading to its caller — and on a malformed
 * coordinate, where D1 answers `INDETERMINATE` rather than making a geographic claim. Those
 * divergences are intentional and are pinned by `routingSpatialAuthorityBoundary.test.js` so
 * they cannot drift silently or be mistaken for a bug to be "harmonised" away.
 *
 * ── The underlying question this module does answer ────────────────────────
 * Is this coordinate inside the operating region RobotX has committed to serve?
 *
 * ── The owner's requirement, stated exactly ────────────────────────────────
 * > The **entire** RNSIT campus is the V1 serviceable delivery domain. A user may place an
 * > order at any valid destination point inside the RNSIT campus boundary.
 *
 * and the distinction that makes it implementable:
 *
 * > **Inside the campus does not mean automatically routable.** A destination outside the
 * > campus is refused as outside the operational domain; a destination inside it is
 * > accepted as a valid delivery-domain destination and the routing engine is asked for a
 * > path; a destination inside but genuinely unroutable fails closed with an explainable
 * > routing reason.
 *
 * This module answers only the **first** of those three questions — domain membership. It
 * has no opinion about whether a point is reachable; that is the routing graph's answer and
 * `productionRouter.js` keeps the two verdicts separate precisely so that "we do not serve
 * there" and "we serve there and today we cannot reach it" are never reported as the same
 * thing. Collapsing them is how a temporary graph gap becomes a permanent shrinking of the
 * commercial commitment.
 *
 * ── Why membership is a point-in-polygon test and NOT a cell-cover lookup ───
 * This is the single most important sentence in this file, and it is a deliberate
 * avoidance of a decision that is not this module's to make.
 *
 * `B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.3–§1.8.5 recorded that the approved campus polygons
 * are roughly **one seventh of a single H3 resolution-8 cell**, so at that resolution the
 * standard `polygonToCells` cover was **empty** and V-8 fired. The two containment modes that
 * would have yielded a non-empty cover — `containmentOverlapping` and
 * `containmentOverlappingBbox` — are both **refused by the owner** as geographic
 * over-assignment of non-campus area, and §1.8.4 states that refusal is standing rather than
 * an unfilled blank.
 *
 * **That premise has since changed, and the conclusion drawn from it must not be quoted as
 * current.** ADR-35 adopted `FINE` = **H3 resolution 11**, at which the standard centre-contained
 * cover of the adopted RNSIT way is **non-empty** and V-8 no longer fires for this campus. The
 * resolution change, not a containment mode, is what resolved it; the owner's refusal was never
 * overturned. The authoritative measurements — empty at resolutions 8 and 9, non-empty at 11 —
 * are asserted against literal resolutions in `spatialRnsitCover.test.js`.
 *
 * None of that changes this module's choice of instrument, which is the point of the next
 * paragraph: a point-in-polygon test was correct under both models precisely because it decides
 * no containment semantics at all.
 *
 * A point-in-polygon test **decides none of that**. Asking "does this coordinate lie inside
 * this ring?" is a question about a point, and it neither selects a polygon→cell
 * containment semantics, nor assigns any cell to the region, nor produces a cover, nor
 * over-assigns one square metre of non-campus area. It is the narrowest instrument that
 * answers the owner's actual requirement, and choosing it here is how this batch serves the
 * requirement without overturning a recorded refusal by inference.
 *
 * What that does **not** do is rescue the cell-keyed routing identity — see
 * `cellProjection.js`, which is where the consequence lands and is reported rather than
 * worked around.
 *
 * ── This module declares no boundary ───────────────────────────────────────
 * It holds no coordinate, no polygon, no region id and no default, exactly as
 * `spatial/regionBoundary.js` holds none. A boundary is **supplied** and is validated
 * through that module's own V-1…V-6 checks before it is usable here, so there is one
 * authority on what a well-formed boundary is rather than two. Supplied nothing, every
 * query answers `NOT_CONFIGURED`, which is not a pass and is never read as one.
 *
 * ── Boundary semantics, and why they are stated rather than discovered ─────
 * A point exactly **on** the boundary is `ON_BOUNDARY`, reported as its own verdict rather
 * than silently resolved to inside or outside. Ray casting's answer for a point lying on an
 * edge is whichever side the arithmetic lands on — `regionBoundary.js:643-645` says the same
 * about its own `pointInRing` — so an implementation that did not distinguish the case
 * would be reporting a coin toss as a serviceability decision. The caller decides what an
 * on-boundary destination means, because that is a commercial question.
 *
 * No tolerance is applied, in either direction. `RD-2026-08-30-01` §1 forbids buffering and
 * enlargement, §4 makes the polygon authoritative with the parking lot excluded by **0.7 m**,
 * and §8.1 records that the exclusion and one inclusion both rest on margins the
 * repository's own map layer calls unknowable. A tolerance here would quietly re-admit the
 * parking lot and would be this module overturning an owner decision by arithmetic. The
 * uncertainty is real and it is recorded as GAP-1; it is not resolved by widening a ring.
 *
 * ── Determinism ───────────────────────────────────────────────────────────
 * No clock, no randomness, no locale-sensitive comparison, no floating-point tolerance.
 * Every comparison is exact, so the same coordinate receives the same verdict on every host
 * and in every replay.
 */

const { validateRegionDeclaration, BOUNDARY_STATUS } = require("../spatial/regionBoundary");

/**
 * Where a coordinate stands relative to the serviceable region.
 * @structural the serviceability verdicts
 */
const SERVICEABILITY = Object.freeze({
  /**
   * Strictly inside the region. The routing layer may proceed with this coordinate.
   * **Not** a delivery-domain admission: that is the intake-pinned `Stop.geofenceResult`.
   */
  INSIDE: "INSIDE",
  /** Strictly outside. Refused by the routing layer as outside the operating region. */
  OUTSIDE: "OUTSIDE",
  /** Exactly on the boundary. Reported, never silently resolved either way. */
  ON_BOUNDARY: "ON_BOUNDARY",
  /** No boundary has been supplied. Not a pass. */
  NOT_CONFIGURED: "NOT_CONFIGURED",
  /** A boundary was supplied and it does not validate. Not a pass. */
  INVALID_BOUNDARY: "INVALID_BOUNDARY",
});

/** @param {unknown} value @returns {boolean} */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Does the point lie exactly on the closed segment `[a, b]`?
 *
 * Collinearity is tested by the exact cross product rather than by a distance threshold,
 * for the reason the header gives: a threshold here is a buffer, and buffering is forbidden.
 *
 * @param {number[]} point `[lon, lat]`
 * @param {number[]} a @param {number[]} b
 * @returns {boolean}
 */
function onSegment(point, a, b) {
  const cross = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
  if (cross !== 0) return false;
  return (
    point[0] >= Math.min(a[0], b[0]) &&
    point[0] <= Math.max(a[0], b[0]) &&
    point[1] >= Math.min(a[1], b[1]) &&
    point[1] <= Math.max(a[1], b[1])
  );
}

/**
 * Is the point on any edge of this closed ring?
 *
 * @param {number[]} point `[lon, lat]`
 * @param {number[][]} ring
 * @returns {boolean}
 */
function onRing(point, ring) {
  for (let index = 0; index < ring.length - 1; index += 1) {
    if (onSegment(point, ring[index], ring[index + 1])) return true;
  }
  return false;
}

/**
 * Ray casting on a closed ring, for a point already established **not** to lie on it.
 *
 * The same algorithm `spatial/regionBoundary.pointInRing` uses, restated here rather than
 * imported because that one is not exported and this module must not widen another
 * authority's public surface to borrow a helper. The two are pinned equal by test.
 *
 * @param {number[]} point `[lon, lat]`
 * @param {number[][]} ring
 * @returns {boolean}
 */
function pointInRing(point, ring) {
  let inside = false;
  // @structural a closed ring repeats its first position last, so the last distinct vertex is at length - 2
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Is the point inside one polygon — inside its exterior ring and outside every hole?
 *
 * @param {number[]} point `[lon, lat]`
 * @param {number[][][]} polygon exterior ring first, holes after
 * @returns {{ inside: boolean, onBoundary: boolean }}
 */
function pointInPolygon(point, polygon) {
  // @structural RFC 7946 — a Polygon's first ring is its exterior, the rest are holes
  const exterior = polygon[0];
  if (onRing(point, exterior)) return { inside: false, onBoundary: true };
  if (!pointInRing(point, exterior)) return { inside: false, onBoundary: false };

  for (let index = 1; index < polygon.length; index += 1) {
    const hole = polygon[index];
    // A point on a hole's edge is on the region's boundary just as surely as one on the
    // exterior ring; the interior it bounds is not served.
    if (onRing(point, hole)) return { inside: false, onBoundary: true };
    if (pointInRing(point, hole)) return { inside: false, onBoundary: false };
  }
  return { inside: true, onBoundary: false };
}

/**
 * Build a serviceability oracle from a **supplied** region declaration.
 *
 * The declaration is validated by `spatial/regionBoundary.validateRegionDeclaration`, which
 * is D1's acceptance gate, so a boundary that would be refused as a D1 supply is refused
 * here too. That is deliberate: a routing boundary and a serviceable-area boundary are the
 * same geometry under §3.5, and two modules disagreeing about whether a polygon is
 * acceptable is the failure shape this programme keeps finding.
 *
 * Note what validation does **not** confer. A `VALID` result here means the geometry is
 * well-formed and the five §36.3.1 fields are present; it does not mean D1 is discharged,
 * because D1 additionally requires an admissible external supply and a signed human
 * declaration that no validator can produce (`B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.5).
 * `regionStatus` is reported so a caller can state which of the two it has.
 *
 * @param {object|null|undefined} declaration the five fields of §36.3.1
 * @returns {object} the oracle
 */
function createServiceabilityOracle(declaration) {
  const validated = validateRegionDeclaration(declaration);
  const usable = validated.status === BOUNDARY_STATUS.VALID && Array.isArray(validated.polygons);

  const unusableVerdict =
    validated.status === BOUNDARY_STATUS.NOT_CONFIGURED ? SERVICEABILITY.NOT_CONFIGURED : SERVICEABILITY.INVALID_BOUNDARY;

  return Object.freeze({
    /**
     * `VALID`, `INVALID` or `NOT_CONFIGURED` — `regionBoundary`'s verdict on this **geometry**,
     * passed straight through. A well-formedness fact about a supplied polygon, and deliberately
     * not a D1 domain verdict about any coordinate.
     */
    regionStatus: validated.status,
    regionId: validated.regionId,
    kind: validated.kind,
    bbox: validated.bbox,
    problems: validated.problems,
    /** Whether this oracle can answer a containment question at all. */
    usable,

    /**
     * Where one coordinate stands relative to the serviceable region.
     *
     * @param {number} lat @param {number} lon
     * @returns {{ status: string, reason: string|null }}
     */
    assess(lat, lon) {
      if (!usable) {
        return Object.freeze({
          status: unusableVerdict,
          reason:
            validated.status === BOUNDARY_STATUS.NOT_CONFIGURED
              ? "no serviceable region boundary has been supplied, so no coordinate can be shown to be inside the " +
                "operational domain. Unknown is DENY: this is not a pass and no destination is admitted by it"
              : `the supplied region boundary does not validate: ${validated.problems.join("; ")}`,
        });
      }
      // @structural WGS84 latitude range
      const latInRange = isFiniteNumber(lat) && lat >= -90 && lat <= 90;
      // @structural WGS84 longitude range
      const lonInRange = isFiniteNumber(lon) && lon >= -180 && lon <= 180;
      if (!latInRange || !lonInRange) {
        return Object.freeze({
          status: SERVICEABILITY.OUTSIDE,
          reason: `(${String(lat)}, ${String(lon)}) is not a finite in-range WGS-84 coordinate, so it is not a point inside any region`,
        });
      }

      const point = [lon, lat];
      let onBoundary = false;
      for (const polygon of validated.polygons) {
        const verdict = pointInPolygon(point, polygon);
        if (verdict.inside) return Object.freeze({ status: SERVICEABILITY.INSIDE, reason: null });
        if (verdict.onBoundary) onBoundary = true;
      }

      if (onBoundary) {
        return Object.freeze({
          status: SERVICEABILITY.ON_BOUNDARY,
          reason:
            `(${lat}, ${lon}) lies exactly on the region boundary. It is reported rather than resolved because a ` +
            "ray cast's answer on an edge is whichever side the arithmetic lands on, and whether an on-perimeter " +
            "destination is served is a commercial decision rather than an arithmetic one",
        });
      }
      return Object.freeze({
        status: SERVICEABILITY.OUTSIDE,
        reason:
          `(${lat}, ${lon}) is outside the serviceable operating region${validated.regionId ? ` "${validated.regionId}"` : ""}. ` +
          "No buffer, tolerance or snap is applied: RD-2026-08-30-01 §1 forbids buffering and enlargement of the " +
          "adopted geometry, and a tolerance here would re-admit destinations an owner decision excluded",
      });
    },

    /**
     * The whole-campus acceptance predicate, for callers that want the owner's requirement
     * as a single boolean rather than as a verdict to switch on.
     *
     * `ON_BOUNDARY` is **not** accepted, which is the fail-closed direction.
     *
     * @param {number} lat @param {number} lon
     * @returns {boolean}
     */
    isServiceable(lat, lon) {
      return this.assess(lat, lon).status === SERVICEABILITY.INSIDE;
    },
  });
}

module.exports = {
  SERVICEABILITY,
  createServiceabilityOracle,
  // Exported so `routingSpatialAuthorityBoundary.test.js` can pin this ray cast behaviourally
  // equal to `spatial/regionBoundary.pointInRing`, and can pin the verdict-policy divergences
  // above as deliberate. That test exists; until 2026-09-19 this comment claimed a test that had
  // never been written, and the two had already diverged one layer up without anything failing.
  pointInRing,
  pointInPolygon,
};

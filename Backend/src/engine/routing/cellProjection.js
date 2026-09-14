"use strict";

/**
 * **cell → routing coordinate** — the one deterministic projection the routing adapters are
 * given, and the place where a cell that cannot honestly be routed from is refused.
 *
 * ── Why this seam exists at all ────────────────────────────────────────────
 * No routing engine accepts a cell token. `tools/routing/adapters/contract.js` records this
 * as **N27** and makes `projectCell(cellId) -> { lat, lon }` required configuration that no
 * adapter may invent, precisely so that one implementation is supplied once and shared by
 * every candidate rather than four adapters each inventing a coordinate. This module is that
 * one implementation.
 *
 * ── It reuses `spatial/cells.js` and adds no second coordinate system ──────
 * The cell → point map is `spatial/cells.centreOfCell`, which is already the repository's
 * only cell-geometry function and already carries the convention that nothing outside that
 * module calls `h3-js` directly. Nothing is re-derived here; the H3 resolutions are B5's and
 * are not touched, read as tunable, or overridden.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE RNSIT FINDING — measured on this tree, and reported rather than worked around
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The adopted RNSIT serviceable boundary (`way/1120154292`, RD-2026-08-30-01) encloses
 * **0.0998 km²**. An H3 resolution-8 cell averages **0.7373 km²**. Measured on this tree with
 * `h3-js@4.5.0` at the resolutions `cells.js:181-184` fixes as `@structural B5`:
 *
 *   * the campus boundary's vertices fall in **3 distinct res-8 cells**
 *     (`8860145105fffff`, `8860145129fffff`, `886014512bfffff`);
 *   * standard `polygonToCells` at res 8 returns **0 cells**, and at res 5 also **0**;
 *   * **every one of those three cells has its centre OUTSIDE the campus polygon.**
 *     `8860145105fffff`'s centre is at 12.896460, 77.517454 — roughly 270 m south of the
 *     campus, on the far side of the perimeter.
 *
 * The third measurement is this module's problem and it is a hard one. `centreOfCell` is the
 * only deterministic cell → point map that exists, and at RNSIT it yields a coordinate the
 * serviceability oracle correctly calls `OUTSIDE`. A projection that returned it anyway
 * would hand the routing engine a start or end point **outside the region RobotX has
 * committed to serve**, and the engine would answer with a perfectly well-formed route
 * between two points that are not on the campus. That is not a missing answer; it is a
 * plausible wrong one, which is the failure class R13 and `assertVersionInKey` exist to
 * prevent, and it is exactly what §16 of the owner's decision forbids: *"do not silently
 * move an order outside the campus."*
 *
 * So the guard below refuses, and at RNSIT it refuses **every** cell. That is the truthful
 * report: **the cell-keyed routing identity cannot represent intra-campus RNSIT routes at
 * the frozen resolution.** It is the same arithmetic behind the V-8 finding in
 * `B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.3, surfacing one layer further down, and it is
 * **not** fixed here:
 *
 *   * changing the resolution is **B5/D2**, and `cells.js` has one global pair with no
 *     override path (`regionBoundary.d2ResidualCheck` says which way to resolve it is
 *     Architecture's, *"on this evidence — it is not resolved here"*);
 *   * selecting `containmentOverlapping` or `containmentOverlappingBbox` to manufacture a
 *     non-empty cover is a **standing owner refusal** (§1.8.4), and a mode chosen because it
 *     makes a validator pass is the check answering itself;
 *   * the escalation target for the spatial-model question is **NOT DEFINED** (§1.8.5), and
 *     §1.8.5 says outright: do not invent one.
 *
 * The consequence for this batch is recorded in the final report and nowhere else is it
 * papered over. `routePoints()` on the production router serves the owner's actual
 * delivery-domain requirement — any valid point inside the campus — **without** the cell
 * cache, and says so.
 *
 * ── The supplied-representative-point seam ────────────────────────────────
 * A caller may supply a cell → representative point map. It is **external input**, in the
 * same class as the charger catalogue: supplied, never fabricated here, and validated
 * against the serviceable boundary exactly as a cell centre is. It exists so that a
 * deployment which has published real representative delivery points can use them; it is
 * **not** a mechanism for giving RNSIT's three cells plausible in-campus coordinates,
 * because a point chosen to make a cell pass this guard would be this module deciding where
 * a cell "really is", which is the same over-assignment the owner refused.
 *
 * ── Determinism (R10, §9.6) ───────────────────────────────────────────────
 * No clock, no randomness, no iteration over an unordered collection. `centreOfCell` is a
 * pure function of the token, and a supplied map is read by key. The same cell projects to
 * the same coordinate on every host and in every replay.
 */

const { centreOfCell, resolutionOfH3Cell, RESOLUTION } = require("../spatial/cells");
const { SERVICEABILITY } = require("./campusServiceability");

/**
 * Why a cell could not be projected to a routable coordinate.
 * @structural the projection's own refusal reasons
 */
const PROJECTION_REFUSAL = Object.freeze({
  /** The token is not a valid H3 cell id at a resolution this repository mints. */
  NOT_A_CELL: "NOT_A_CELL",
  /** The cell is valid but its representative coordinate is outside the serviceable region. */
  OUTSIDE_SERVICEABLE_REGION: "OUTSIDE_SERVICEABLE_REGION",
  /** No serviceable region is configured, so no coordinate can be shown to be inside one. */
  NO_REGION: "NO_REGION",
  /** A supplied representative point is not a usable coordinate. */
  MALFORMED_REPRESENTATIVE_POINT: "MALFORMED_REPRESENTATIVE_POINT",
});

/**
 * Where a projected coordinate came from.
 * @structural the projection's own source labels
 */
const PROJECTION_SOURCE = Object.freeze({
  /** `spatial/cells.centreOfCell` — H3's own cell centre. */
  CELL_CENTRE: "CELL_CENTRE",
  /** A representative point supplied by the deployment. */
  SUPPLIED_REPRESENTATIVE_POINT: "SUPPLIED_REPRESENTATIVE_POINT",
});

/**
 * An error carrying the refusal reason, so a caller can tell "not a cell" from "not on the
 * campus" without parsing a message.
 */
class ProjectionError extends Error {
  /**
   * @param {string} refusal one of `PROJECTION_REFUSAL`
   * @param {string} reason
   */
  constructor(refusal, reason) {
    super(reason);
    this.name = "ProjectionError";
    this.refusal = refusal;
    this.reason = reason;
  }
}

/** @param {unknown} value @returns {boolean} */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Build the `projectCell` seam the B1 adapters require.
 *
 * @param {object} input `{ serviceability, representativePoints }`
 *   * `serviceability` — an oracle from `campusServiceability.createServiceabilityOracle`.
 *     **Required.** Without it there is nothing to check a coordinate against, and a
 *     projection that cannot check is a projection that can move an order off the campus.
 *   * `representativePoints` — optional `Map` or plain object of `cellId -> { lat, lon }`,
 *     supplied by the deployment. Never fabricated here.
 * @returns {object} `{ project, projectCell, describe }`
 */
function createCellProjection(input) {
  const source = input || {};
  const oracle = source.serviceability;
  const supplied = source.representativePoints;

  /**
   * @param {string} cellId
   * @returns {{ lat: number, lon: number }|null}
   */
  function suppliedPointFor(cellId) {
    if (!supplied) return null;
    const entry = typeof supplied.get === "function" ? supplied.get(cellId) : supplied[cellId];
    if (entry === undefined || entry === null) return null;
    if (!isFiniteNumber(entry.lat) || !isFiniteNumber(entry.lon)) {
      throw new ProjectionError(
        PROJECTION_REFUSAL.MALFORMED_REPRESENTATIVE_POINT,
        `the supplied representative point for cell "${cellId}" is not a { lat, lon } pair of finite numbers`,
      );
    }
    return { lat: entry.lat, lon: entry.lon };
  }

  return Object.freeze({
    /**
     * Project one cell to its routing coordinate, or refuse.
     *
     * @param {string} cellId
     * @returns {{ lat: number, lon: number, source: string, cellId: string }}
     * @throws {ProjectionError}
     */
    project(cellId) {
      if (!oracle || typeof oracle.assess !== "function") {
        throw new ProjectionError(
          PROJECTION_REFUSAL.NO_REGION,
          "no serviceability oracle was supplied to the cell projection. A coordinate that has not been shown to " +
            "lie inside the serviceable region must not be handed to a routing engine as an origin or a " +
            "destination — unknown is DENY",
        );
      }

      const fromSupplied = suppliedPointFor(cellId);
      let point;
      let projectionSource;

      if (fromSupplied) {
        point = fromSupplied;
        projectionSource = PROJECTION_SOURCE.SUPPLIED_REPRESENTATIVE_POINT;
      } else {
        // `resolutionOfH3Cell` returns null for anything that is not an H3 cell at one of
        // the two §3.6 resolutions — including §6.2's site-local graph-zone tokens, which
        // are deliberately not geodesic and therefore have no coordinate to project to.
        if (resolutionOfH3Cell(cellId) !== RESOLUTION.FINE) {
          throw new ProjectionError(
            PROJECTION_REFUSAL.NOT_A_CELL,
            `"${String(cellId)}" is not a fine-resolution H3 cell id, so it has no cell centre to route from. ` +
              "§6.2's site-local graph-zone tokens are deliberately not geodesic and cannot be projected; a " +
              "deployment that routes them must supply a representative point for each, and none was supplied",
          );
        }
        point = centreOfCell(cellId);
        projectionSource = PROJECTION_SOURCE.CELL_CENTRE;
      }

      const verdict = oracle.assess(point.lat, point.lon);
      if (verdict.status !== SERVICEABILITY.INSIDE) {
        throw new ProjectionError(
          verdict.status === SERVICEABILITY.NOT_CONFIGURED || verdict.status === SERVICEABILITY.INVALID_BOUNDARY
            ? PROJECTION_REFUSAL.NO_REGION
            : PROJECTION_REFUSAL.OUTSIDE_SERVICEABLE_REGION,
          `cell "${cellId}" projects to (${point.lat}, ${point.lon}) via ${projectionSource}, which is ` +
            `${verdict.status} relative to the serviceable region. ${verdict.reason}\n` +
            "This is refused rather than routed. Handing a routing engine an origin or destination outside the " +
            "committed serviceable area yields a well-formed route between two points that are not on the campus " +
            "— a plausible wrong answer rather than a missing one. At RNSIT this refusal is expected for every " +
            "cell: the campus is ~0.0998 km² against a 0.7373 km² res-8 cell, so all three cells its boundary " +
            "touches have centres outside it. That is the spatial-model escalation of " +
            "B1_EXTERNAL_INPUT_HANDOFF.md §1.8.3-§1.8.5, whose escalation target is NOT DEFINED; it is not " +
            "resolved by this projection and must not be resolved by widening the boundary or by selecting a " +
            "containment mode the owner has refused",
        );
      }

      return Object.freeze({ lat: point.lat, lon: point.lon, source: projectionSource, cellId });
    },

    /**
     * The `projectCell` signature `contract.normaliseConfig` requires: `{ lat, lon }` or a
     * throw. A thin wrapper so the adapter contract and this module's richer result do not
     * have to be the same shape.
     *
     * @param {string} cellId
     * @returns {{ lat: number, lon: number }}
     */
    projectCell(cellId) {
      const projected = this.project(cellId);
      return { lat: projected.lat, lon: projected.lon };
    },

    /**
     * What this projection is, for an adapter description or a decision record.
     * @returns {string}
     */
    describe() {
      return (
        `spatial/cells.centreOfCell at the §3.6 ${RESOLUTION.FINE} band${supplied ? ", with supplied representative points" : ""}; ` +
        `every projected coordinate is checked against serviceable region ${oracle && oracle.regionId ? `"${oracle.regionId}"` : "(none configured)"} ` +
        "and a coordinate outside it is refused rather than routed"
      );
    },
  });
}

module.exports = {
  PROJECTION_REFUSAL,
  PROJECTION_SOURCE,
  ProjectionError,
  createCellProjection,
};

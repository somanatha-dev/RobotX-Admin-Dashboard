"use strict";

/**
 * The **D1 acceptance gate** — validation for an authoritative operating-region
 * declaration, and nothing else (§3.5, §3.6, §5.2).
 *
 * ── What this module is ────────────────────────────────────────────────────
 * `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md` §30.5.5 records thirteen checks the D1
 * gate should apply (V-1 … V-13) and §36.2 records that none of them exists in code. This
 * module is those checks, and it is the engineering half of D1: the half that can be built
 * before the decision arrives, so that when a real boundary is supplied it is **accepted
 * mechanically or refused mechanically** rather than by reviewer diligence.
 *
 * ── What this module is NOT, and must never become ─────────────────────────
 * It **declares no region**. It holds no coordinate, no bounding box, no polygon, no region
 * id, no region kind, no CRS other than the one WGS-84 identifier it compares against, no
 * default and no fallback. Every function below takes a declaration supplied from outside the
 * repository and answers `VALID` or `INVALID` with reasons; supplied nothing, it answers
 * `NOT_CONFIGURED`, which is **not** a pass.
 *
 * It also derives nothing. §36.4 refuses a polygon → H3 cover utility on the ground that "it
 * would have no input, and its only test data would be invented geometry". That reasoning
 * holds and this module respects it: a cover is **validated** here, never computed here. The
 * derivations §30.4 lists (G1–G12) remain unwritten and remain the work that D1 releases.
 *
 * ── The five fields D1 must supply (§36.3.1), and who owns each ────────────
 *
 *   1. `regionId` + `name`            Operations (Commercial confirms the name)
 *   2. `kind`                          Operations — one of §3.5's four
 *   3. `boundary`                      Commercial (what we commit to serve)
 *                                      + Operations (what we can operate) — one geometry
 *   4. `crs`                           whoever authored the file
 *   5. `version` + `versionDate`       Operations
 *
 * All five are **required**. §4.1 rule 3 — state is never inferred from the absence of data —
 * is why an omitted CRS is a rejection rather than an assumed EPSG:4326: the single most
 * common real-world failure in this class is a geometry authored in a projected CRS read as
 * degrees, and it produces a boundary that looks entirely plausible and is wrong.
 *
 * ── Determinism ───────────────────────────────────────────────────────────
 * No clock, no randomness, no locale-sensitive comparison. Problems are emitted in a fixed
 * order so that two runs over the same declaration produce byte-identical output (§9.6).
 */

const h3 = require("h3-js");
const { compareStrings } = require("../determinism/ordering");
const { RESOLUTION, H3_RESOLUTION } = require("./cells");

/**
 * The three states a D1 declaration can be in. `NOT_CONFIGURED` exists so that "no region has
 * been declared" can never be reported as "the region is fine": it is the state this
 * repository is actually in, and it is the state B1 Step 1 is blocked by.
 * @structural the D1 gate's own verdicts
 */
const BOUNDARY_STATUS = Object.freeze({
  /** No declaration was supplied. Not a pass. */
  NOT_CONFIGURED: "NOT_CONFIGURED",
  /** A declaration was supplied and it fails at least one check. */
  INVALID: "INVALID",
  /** A declaration was supplied and every check this module can run passed. */
  VALID: "VALID",
});

/**
 * §3.5's four region kinds, verbatim: "a site, campus, depot catchment, or metro service
 * area". This module does not choose among them — D1 field 2 does — and the list exists only
 * so that a declaration naming a fifth thing is refused.
 * @structural the specification's own region kinds
 */
const REGION_KIND = Object.freeze({
  SITE: "SITE",
  CAMPUS: "CAMPUS",
  DEPOT_CATCHMENT: "DEPOT_CATCHMENT",
  METRO_SERVICE_AREA: "METRO_SERVICE_AREA",
});

const REGION_KINDS = Object.freeze(Object.values(REGION_KIND));

/**
 * The CRS identifiers that all name WGS-84 geographic coordinates in `[lon, lat]` order.
 *
 * OGC:CRS84 and EPSG:4326 differ in *stated* axis order (CRS84 is lon/lat, EPSG:4326 is
 * lat/lon in the authority's definition) while RFC 7946 fixes GeoJSON at lon/lat regardless.
 * Both are therefore accepted **and the axis-order check below runs on the coordinates
 * either way**, because a stated CRS is a claim about the file and V-5 is a check on it.
 * @structural CRS identifiers, not a tunable value
 */
const WGS84_CRS = Object.freeze(["EPSG:4326", "OGC:CRS84", "CRS84", "URN:OGC:DEF:CRS:OGC::CRS84", "WGS84"]);

/**
 * §3.6's stated fine-cell cardinality band per region: 10³ – 10⁵.
 * @structural the specification's own table
 */
const FINE_CELL_BAND = Object.freeze({ min: 1000, max: 100000 });

/**
 * What §3.6's cardinality band means as an *area*, at whatever resolution FINE is
 * currently set to.
 *
 * Derived rather than written down. This sentence used to read "at H3 resolution 8 the
 * band corresponds to roughly 737–73 733 km²", which was true when FINE was 8 and became
 * false the moment ADR-35 moved it — a validator that explains itself with a stale
 * number teaches the reader the wrong thing about why their cover was rejected, and
 * N23's whole point is that the count and the resolution have to be read together.
 *
 * @returns {string}
 */
function bandAreaDescription() {
  const cellKm2 = h3.getHexagonAreaAvg(H3_RESOLUTION.FINE, h3.UNITS.km2);
  /** @structural presentation only — above this an integer reads better than 3 significant figures */
  const WHOLE_NUMBER_FROM = 100;
  /** @structural presentation only — significant figures for a sub-100 km² figure */
  const SIGNIFICANT_FIGURES = 3;
  const format = (value) => (value >= WHOLE_NUMBER_FROM ? Math.round(value).toLocaleString("en-GB") : value.toPrecision(SIGNIFICANT_FIGURES));
  return `${format(FINE_CELL_BAND.min * cellKm2)}–${format(FINE_CELL_BAND.max * cellKm2)} km²`;
}

/**
 * RFC 7946 requires a closed linear ring, which needs at least four positions.
 * @structural RFC 7946's own minimum, not a tunable value
 */
const MIN_RING_POSITIONS = 4;

/** @param {unknown} value @returns {boolean} */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** @param {unknown} value @returns {boolean} */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * An ISO calendar date, `YYYY-MM-DD`, checked for real-calendar validity rather than only for
 * shape — `2026-02-30` matches the pattern and is not a date.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // @structural the length of an ISO calendar-date prefix, "YYYY-MM-DD"
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/* ═══════════════════════════════════════════════════════════════════════════
   V-1 … V-6 — the geometry itself
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * V-5 — one position, in `[lon, lat]` WGS-84 degrees.
 *
 * The axis-order check is the only one of the thirteen that catches a silently wrong answer
 * rather than a malformed one: a `[lat, lon]` file whose latitudes happen to be under 90°
 * produces a cover somewhere else on Earth, and every downstream check passes. What can be
 * proven is the converse — a second element outside ±90° **cannot** be a latitude — so that
 * is what is asserted. Where the ordering is genuinely ambiguous nothing is claimed, because
 * guessing would be inventing the region's location.
 *
 * @param {unknown} position
 * @param {string} where a stable path for the message
 * @param {string[]} problems appended to
 * @returns {boolean} whether the position is usable
 */
function checkPosition(position, where, problems) {
  // @structural a GeoJSON position is [lon, lat] — two elements, per RFC 7946
  if (!Array.isArray(position) || position.length < 2) {
    problems.push(`V-5 ${where}: a position must be an array of at least [lon, lat]`);
    return false;
  }
  const [lon, lat] = position;
  if (!isFiniteNumber(lon) || !isFiniteNumber(lat)) {
    problems.push(`V-5 ${where}: a position must hold two finite numbers, received [${String(lon)}, ${String(lat)}]`);
    return false;
  }
  // @structural WGS84 latitude range
  if (lat < -90 || lat > 90) {
    problems.push(
      `V-5 ${where}: the second element is ${lat}, which is outside ±90° and therefore not a latitude. ` +
        "GeoJSON positions are [lon, lat] (RFC 7946); this file appears to be authored [lat, lon], or in a " +
        "projected CRS read as degrees. Neither is corrected here — a re-ordered or reprojected geometry is a " +
        "new authoritative file from its author, not an adjustment made by the consumer",
    );
    return false;
  }
  // @structural WGS84 longitude range
  if (lon < -180 || lon > 180) {
    problems.push(`V-5 ${where}: the first element is ${lon}, which is outside ±180° and therefore not a longitude`);
    return false;
  }
  return true;
}

/**
 * Do two closed segments properly cross? Endpoint contact is not a crossing — consecutive
 * segments of a ring share an endpoint by construction, and the ring's first and last do too.
 *
 * @param {number[]} p1 @param {number[]} p2 @param {number[]} q1 @param {number[]} q2
 * @returns {boolean}
 */
function segmentsCross(p1, p2, q1, q2) {
  const orientation = (a, b, c) => {
    const value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
    if (value === 0) return 0;
    // @structural orientation codes: 0 collinear, 1 clockwise, 2 counter-clockwise
    return value > 0 ? 1 : 2;
  };
  const onSegment = (a, b, c) =>
    b[0] <= Math.max(a[0], c[0]) && b[0] >= Math.min(a[0], c[0]) && b[1] <= Math.max(a[1], c[1]) && b[1] >= Math.min(a[1], c[1]);

  const o1 = orientation(p1, p2, q1);
  const o2 = orientation(p1, p2, q2);
  const o3 = orientation(q1, q2, p1);
  const o4 = orientation(q1, q2, p2);

  if (o1 !== o2 && o3 !== o4) {
    // A proper crossing, unless the "crossing" is only the shared endpoint of two segments
    // the caller already knows are adjacent — which the caller excludes before calling.
    return true;
  }
  // Collinear overlap is a self-intersection too: a ring that doubles back along itself has
  // no well-defined interior either.
  if (o1 === 0 && onSegment(p1, q1, p2) && (q1[0] !== p1[0] || q1[1] !== p1[1]) && (q1[0] !== p2[0] || q1[1] !== p2[1])) return true;
  if (o2 === 0 && onSegment(p1, q2, p2) && (q2[0] !== p1[0] || q2[1] !== p1[1]) && (q2[0] !== p2[0] || q2[1] !== p2[1])) return true;
  return false;
}

/**
 * The shoelace (signed planar) area of a ring, in square degrees.
 *
 * Square degrees are not an area anybody should quote, and none is quoted: V-4 asks only
 * whether the ring encloses **anything**, and a degenerate ring is degenerate under any
 * projection. Converting to square metres would require a projection choice this module has
 * no authority to make.
 *
 * @param {number[][]} ring
 * @returns {number}
 */
function signedRingArea(ring) {
  let total = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    total += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  // @structural the shoelace formula's own divisor
  return total / 2;
}

/**
 * V-2, V-3, V-4, V-5 over one linear ring.
 *
 * @param {unknown} ring
 * @param {string} where
 * @param {string[]} problems appended to
 * @returns {number[][]|null} the ring when it is usable
 */
function checkRing(ring, where, problems) {
  if (!Array.isArray(ring)) {
    problems.push(`V-2 ${where}: a linear ring must be an array of positions`);
    return null;
  }
  if (ring.length < MIN_RING_POSITIONS) {
    problems.push(`V-2 ${where}: a linear ring needs at least ${MIN_RING_POSITIONS} positions, received ${ring.length} (RFC 7946)`);
    return null;
  }

  let positionsUsable = true;
  ring.forEach((position, index) => {
    if (!checkPosition(position, `${where}[${index}]`, problems)) positionsUsable = false;
  });
  if (!positionsUsable) return null;

  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    problems.push(`V-2 ${where}: the ring is not closed — its first position [${first[0]}, ${first[1]}] is not its last [${last[0]}, ${last[1]}] (RFC 7946)`);
    return null;
  }

  // V-3 runs **before** V-4, and the order is load-bearing rather than stylistic. A ring that
  // crosses itself has two lobes of opposite winding, and the shoelace sum of a symmetric
  // bow-tie is exactly zero — so an area-first check would report "encloses nothing" for a
  // geometry whose real defect is that its interior is undefined. The second message sends the
  // author looking for a missing vertex; the first sends them looking at the right thing.
  //
  // Segments adjacent in the ring share an endpoint legitimately and are skipped; so are the
  // first and last, which close the ring.
  const segments = ring.length - 1;
  for (let a = 0; a < segments; a += 1) {
    for (let b = a + 1; b < segments; b += 1) {
      const adjacent = b === a + 1 || (a === 0 && b === segments - 1);
      if (adjacent) continue;
      if (segmentsCross(ring[a], ring[a + 1], ring[b], ring[b + 1])) {
        problems.push(
          `V-3 ${where}: segment ${a} crosses segment ${b}. A self-intersecting ring has no well-defined ` +
            "interior, so a cover derived from it is undefined rather than approximate",
        );
        return null;
      }
    }
  }

  if (signedRingArea(ring) === 0) {
    problems.push(
      `V-4 ${where}: the ring encloses zero area. §3.6 keys a region's pricing surface to its cell set, and a ` +
        "region enclosing nothing has no cells and therefore no pricing surface",
    );
    return null;
  }

  return ring;
}

/**
 * V-1 … V-5 over one `Polygon` coordinate array (exterior ring first, holes after).
 *
 * @param {unknown} rings
 * @param {string} where
 * @param {string[]} problems
 * @returns {number[][][]|null}
 */
function checkPolygon(rings, where, problems) {
  if (!Array.isArray(rings) || rings.length === 0) {
    problems.push(`V-1 ${where}: a Polygon's coordinates must be a non-empty array of linear rings`);
    return null;
  }
  const checked = rings.map((ring, index) => checkRing(ring, `${where}.rings[${index}]`, problems));
  return checked.every((ring) => ring !== null) ? checked : null;
}

/**
 * V-1 … V-6 over a complete D1 declaration.
 *
 * @param {object|null|undefined} declaration the five fields of §36.3.1
 * @returns {{ status: string, problems: string[], regionId: string|null, kind: string|null,
 *             polygons: number[][][][]|null, bbox: object|null }}
 */
function validateRegionDeclaration(declaration) {
  if (declaration === null || declaration === undefined) {
    return Object.freeze({
      status: BOUNDARY_STATUS.NOT_CONFIGURED,
      problems: Object.freeze([
        "D1 is undecided: no authoritative operating region has been declared. This is not a validation " +
          "failure and it is not a pass — it is the absence of an Operations + Commercial decision. Supply the " +
          "five fields of PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md §36.3.1: regionId + name, kind, the " +
          "serviceable boundary as GeoJSON Polygon/MultiPolygon in WGS-84 [lon, lat], the CRS, and a version " +
          "label with a date",
      ]),
      regionId: null,
      kind: null,
      polygons: null,
      bbox: null,
    });
  }

  const problems = [];
  const source = typeof declaration === "object" ? declaration : {};
  if (typeof declaration !== "object") problems.push("a region declaration must be an object");

  // ── Field 1 — V-7, sharpened: an id configuration is keyed by must be stable ──
  if (!isNonEmptyString(source.regionId)) {
    problems.push("V-7 field 1: regionId is required — a stable identifier every region-scoped parameter binding and decision record will cite");
  } else if (source.regionId !== source.regionId.trim()) {
    problems.push(`V-7 field 1: regionId "${source.regionId}" has leading or trailing whitespace; a key that differs from its own trimmed form is two keys`);
  }
  if (!isNonEmptyString(source.name)) problems.push("field 1: name is required — the human-readable name the commercial commitment is written against");

  // ── Field 2 — the region kind, which D2's residual fitness check reads ──
  if (!isNonEmptyString(source.kind) || !REGION_KINDS.includes(source.kind)) {
    problems.push(
      `field 2: kind must be one of ${REGION_KINDS.join(", ")} (§3.5: "a site, campus, depot catchment, or metro ` +
        `service area"), received ${JSON.stringify(source.kind)}. It is required because §3.6's 10³–10⁵ fine-cell ` +
        `band is satisfiable for some of those kinds and not others at H3 resolution ${H3_RESOLUTION.FINE} — see d2ResidualCheck()`,
    );
  }

  // ── Field 4 — the CRS, checked before the coordinates it governs ──
  if (!isNonEmptyString(source.crs)) {
    problems.push(
      "V-6 field 4: crs is required and is never assumed. A geometry authored in a projected CRS and read as " +
        "degrees produces a plausible boundary in the wrong place, and §4.1 rule 3 forbids inferring state from " +
        "the absence of data — state EPSG:4326 explicitly if that is what it is",
    );
  } else if (!WGS84_CRS.includes(source.crs.trim().toUpperCase())) {
    problems.push(
      `V-6 field 4: crs "${source.crs}" is not WGS-84 geographic. The engine's coordinate checks ` +
        "(spatial/cells.js, feasibility/f33.js) and H3 itself are defined on WGS-84 degrees. Reprojection is the " +
        "authoring side's to perform and record — it is deliberately not performed here, because a silently " +
        "reprojected boundary is a boundary nobody reviewed",
    );
  }

  // ── Field 5 — an immutable version label and its date ──
  if (!isNonEmptyString(source.version)) {
    problems.push("field 5: version is required — an immutable label, so a re-cut extract and a re-derived cover can name the geometry they came from");
  }
  if (!isIsoDate(source.versionDate)) {
    problems.push(`field 5: versionDate must be an ISO calendar date (YYYY-MM-DD), received ${JSON.stringify(source.versionDate)}`);
  }

  // ── Field 3 — V-1 … V-5, the geometry ──
  let polygons = null;
  const boundary = source.boundary;
  if (!boundary || typeof boundary !== "object") {
    problems.push("V-1 field 3: boundary is required — a GeoJSON Polygon or MultiPolygon. No boundary is derived, defaulted or inferred here");
  } else if (boundary.type === "Polygon") {
    const polygon = checkPolygon(boundary.coordinates, "boundary", problems);
    if (polygon) polygons = [polygon];
  } else if (boundary.type === "MultiPolygon") {
    if (!Array.isArray(boundary.coordinates) || boundary.coordinates.length === 0) {
      problems.push("V-1 field 3: a MultiPolygon's coordinates must be a non-empty array of Polygon coordinate arrays");
    } else {
      const checked = boundary.coordinates.map((rings, index) => checkPolygon(rings, `boundary[${index}]`, problems));
      if (checked.every((polygon) => polygon !== null)) polygons = checked;
    }
  } else {
    problems.push(
      `V-1 field 3: boundary.type is ${JSON.stringify(boundary.type)}; only Polygon and MultiPolygon are accepted. ` +
        "Only an areal geometry can be cut into a cell cover or into a routing extract — a Point, a LineString or a " +
        "GeometryCollection cannot",
    );
  }

  return Object.freeze({
    status: problems.length === 0 ? BOUNDARY_STATUS.VALID : BOUNDARY_STATUS.INVALID,
    problems: Object.freeze(problems),
    regionId: isNonEmptyString(source.regionId) ? source.regionId.trim() : null,
    kind: REGION_KINDS.includes(source.kind) ? source.kind : null,
    polygons,
    bbox: polygons ? boundingBoxOf(polygons) : null,
  });
}

/**
 * The axis-aligned bounding box of a validated geometry.
 *
 * This is a **derivation from a supplied geometry**, not a declaration: it exists only so that
 * V-11 and V-13 have something cheap to compare, and it is `null` whenever the geometry is
 * absent or invalid. Nothing here manufactures a box in the absence of a polygon.
 *
 * @param {number[][][][]} polygons
 * @returns {{ minLon: number, minLat: number, maxLon: number, maxLat: number }}
 */
function boundingBoxOf(polygons) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
      }
    }
  }
  return Object.freeze({ minLon, minLat, maxLon, maxLat });
}

/* ═══════════════════════════════════════════════════════════════════════════
   V-8, V-9, V-10 — the cover derived from the geometry
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * How a published cell id is indexed.
 *
 * §6.2 settles B5 as H3 **outdoors**, and in the same breath carves out indoor and
 * multi-level space as "site-local graph zones" — a per-region proximity partition whose
 * tokens are deliberately not geodesic. Both are legitimate; what is not legitimate is a
 * token that is neither, because that is indistinguishable from a fabricated one (N21).
 *
 * So the discriminator is **declared, not guessed**. A cell that says nothing is treated as
 * geodesic and must be a valid H3 index — fail-closed, per §4.1 rule 3.
 * @structural §6.2's two indexing schemes
 */
const CELL_INDEXING = Object.freeze({
  /** An H3 index at the resolution its §3.6 band maps to. The default. */
  H3: "H3",
  /** §6.2's indoor / multi-level site-local graph zone. Must name a site. */
  SITE_LOCAL_GRAPH_ZONE: "SITE_LOCAL_GRAPH_ZONE",
});

const CELL_INDEXINGS = Object.freeze(Object.values(CELL_INDEXING));

/**
 * V-10 — is one published cell id what it claims to be?
 *
 * This is the check whose absence §30.5.2 records as **N21**: `SEED_SPATIAL_MAP`, every one of
 * whose cell ids is a placeholder token, passes the full spatial validation with zero
 * problems. `cells.js`'s header explains why that was correct for Phase 2 — a cell id was "an
 * opaque token supplied by the published map" while B5 was open — and B5 is now settled
 * (`cells.js:29–39`), so the validator behind it can be closed.
 *
 * @param {object} assignment a published cell row
 * @param {string} expectedResolution one of `RESOLUTION`
 * @returns {string[]} problems
 */
function validateCellIdentity(assignment, expectedResolution) {
  if (!assignment || typeof assignment !== "object") return ["a cell assignment is not an object"];
  const problems = [];
  const cellId = typeof assignment.cellId === "string" ? assignment.cellId : String(assignment.cellId);
  const indexing = assignment.indexing === undefined || assignment.indexing === null ? CELL_INDEXING.H3 : assignment.indexing;

  if (!CELL_INDEXINGS.includes(indexing)) {
    problems.push(`V-10 cell "${cellId}" declares indexing ${JSON.stringify(assignment.indexing)}; §6.2 defines ${CELL_INDEXINGS.join(", ")}`);
    return problems;
  }

  if (indexing === CELL_INDEXING.SITE_LOCAL_GRAPH_ZONE) {
    // §6.2's carve-out is *site-local*. A site-local token that names no site is not a
    // site-local token; it is an unvalidatable string with an exemption attached to it.
    if (!isNonEmptyString(assignment.siteId)) {
      problems.push(
        `V-10 cell "${cellId}" claims §6.2's site-local graph-zone exemption but names no site. The exemption is ` +
          "for indoor and multi-level space inside a site; a token claiming it without one cannot be told apart " +
          "from a fabricated cell id, which is the failure this check exists to prevent (N21)",
      );
    }
    return problems;
  }

  const expectedH3 = expectedResolution === RESOLUTION.COARSE ? H3_RESOLUTION.COARSE : H3_RESOLUTION.FINE;
  if (!h3.isValidCell(cellId)) {
    problems.push(
      `V-10 cell "${cellId}" is not a valid H3 index. B5 is settled (§6.2, spatial/cells.js): an outdoor cell id ` +
        "IS an H3 index, so a map of placeholder tokens can no longer be published as an operating region. If this " +
        `token is §6.2 indoor/multi-level space, declare indexing: "${CELL_INDEXING.SITE_LOCAL_GRAPH_ZONE}" and name its site`,
    );
    return problems;
  }
  const actual = h3.getResolution(cellId);
  if (actual !== expectedH3) {
    problems.push(
      `V-10 cell "${cellId}" is an H3 index at resolution ${actual}, but is published as ${expectedResolution}, ` +
        `which §3.6 maps to H3 resolution ${expectedH3}. A cell keyed at the wrong resolution silently changes the ` +
        "cache key space (§20.3) and the k-ring distance bounds (§6.3)",
    );
  }
  return problems;
}

/**
 * V-8, V-9, V-10 over a supplied cover.
 *
 * **The cover is supplied, never computed.** §36.4 refuses a polygon → H3 cover utility while
 * D1 is open, and that refusal stands: this function reads a cover somebody else derived from
 * a real boundary and reports whether it is usable.
 *
 * @param {{ fineCells?: object[], coarseCells?: object[], cardinalityException?: string }} cover
 * @returns {{ status: string, problems: string[], fineCellCount: number }}
 */
function validateCover(cover) {
  if (cover === null || cover === undefined) {
    return Object.freeze({
      status: BOUNDARY_STATUS.NOT_CONFIGURED,
      problems: Object.freeze(["no cell cover has been supplied; a cover is derived from D1's boundary, which is undecided"]),
      fineCellCount: 0,
    });
  }

  const problems = [];
  const source = typeof cover === "object" ? cover : {};
  const fineCells = Array.isArray(source.fineCells) ? source.fineCells : [];
  const coarseCells = Array.isArray(source.coarseCells) ? source.coarseCells : [];

  // ── V-8 — a region that covers nothing ──
  if (fineCells.length === 0) {
    problems.push(
      "V-8: the fine-cell cover is empty. §3.6 makes a zone a set of fine cells and prices supply per zone, so a " +
        "region with no fine cells has no pricing surface and no cell for any Leg to be contained by",
    );
  }

  // ── V-9 — §3.6's stated cardinality band, or an explicitly recorded exception ──
  if (fineCells.length > 0 && (fineCells.length < FINE_CELL_BAND.min || fineCells.length > FINE_CELL_BAND.max)) {
    if (!isNonEmptyString(source.cardinalityException)) {
      problems.push(
        `V-9: the cover holds ${fineCells.length} fine cells, outside §3.6's stated ${FINE_CELL_BAND.min}–${FINE_CELL_BAND.max} ` +
          `band. This is N23: at H3 resolution ${H3_RESOLUTION.FINE} the band corresponds to roughly ${bandAreaDescription()}, which a metro ` +
          "service area satisfies and a site or campus does not. Either the region kind and the resolution " +
          "disagree, or the exception is deliberate — in which case record it in cover.cardinalityException, " +
          "because an unstated exception and a defect look identical",
      );
    }
  }

  // ── V-10 — every published cell id is what it claims to be ──
  fineCells.forEach((assignment, index) => {
    for (const problem of validateCellIdentity(assignment, RESOLUTION.FINE)) problems.push(`fineCells[${index}]: ${problem}`);
  });
  coarseCells.forEach((assignment, index) => {
    for (const problem of validateCellIdentity(assignment, RESOLUTION.COARSE)) problems.push(`coarseCells[${index}]: ${problem}`);
  });

  return Object.freeze({
    status: problems.length === 0 ? BOUNDARY_STATUS.VALID : BOUNDARY_STATUS.INVALID,
    problems: Object.freeze(problems),
    fineCellCount: fineCells.length,
  });
}

/**
 * **D2's residual fitness check** (§30.5.4 N23, §36.2) — is the current FINE resolution a fit
 * for *this* region kind, given the cover it actually produced?
 *
 * D2 is closed globally at the `H3_RESOLUTION` pair — FINE 11 / COARSE 5 since ADR-35 — and
 * this function does not reopen it: it changes no resolution and recommends none. It reports
 * whether §3.6's cardinality band and the declared region kind are consistent, which is the
 * check §36.2 records as unrunnable until D1 field 2 and a geometry exist. It is the whole of
 * D2's residual, and it costs one comparison once the inputs arrive.
 *
 * **It still reports `fits: false` for a small campus, and that is correct.** ADR-35 moved the
 * resolution to make the cover *non-empty* (V-8), not to bring the count inside §3.6's band —
 * measured, RNSIT holds 45 fine cells at resolution 11. The sanctioned mechanism for the
 * residual is `cover.cardinalityException`, a standing owner decision
 * (`B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.4 item 1) that ADR-35 leaves untouched. This function
 * must not start accepting that exception itself: V-9 is where a declared exception is read,
 * and a residual check that silently absorbed one would report a closure nobody declared.
 *
 * @param {{ kind: string|null, fineCellCount: number }} input
 * @returns {{ status: string, fits: boolean|null, note: string }}
 */
function d2ResidualCheck(input) {
  const kind = input && input.kind;
  const count = input && input.fineCellCount;
  if (!REGION_KINDS.includes(kind) || !Number.isInteger(count) || count <= 0) {
    return Object.freeze({
      status: BOUNDARY_STATUS.NOT_CONFIGURED,
      fits: null,
      note:
        "D2's residual cannot be evaluated: it needs D1 field 2 (the region kind) and a cover derived from D1's " +
        "geometry. D2's global value is unchanged and is not reopened by the absence of this check",
    });
  }
  const fits = count >= FINE_CELL_BAND.min && count <= FINE_CELL_BAND.max;
  return Object.freeze({
    status: fits ? BOUNDARY_STATUS.VALID : BOUNDARY_STATUS.INVALID,
    fits,
    note: fits
      ? `${count} fine cells at H3 resolution ${H3_RESOLUTION.FINE} sits inside §3.6's ${FINE_CELL_BAND.min}–${FINE_CELL_BAND.max} band for a ${kind}; D2's residual closes`
      : `${count} fine cells at H3 resolution ${H3_RESOLUTION.FINE} is outside §3.6's ${FINE_CELL_BAND.min}–${FINE_CELL_BAND.max} band for a ${kind}. ` +
        "D2's residual does NOT close. ADR-35 moved FINE to resolve V-8 (an empty cover), not this band, and a " +
        "campus-scale region does not reach 1 000 fine cells at any resolution whose cells are large enough to " +
        "index. The sanctioned mechanism is a declared cover.cardinalityException (§1.8.4 item 1), which V-9 reads " +
        "and this check deliberately does not. No per-region resolution override is offered or taken " +
        "(RD-2026-09-14-01 D2). Which way to resolve the residual is Architecture's, on this evidence — it is " +
        "not resolved here",
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   V-11, V-12, V-13 — the region among its neighbours, and against the extract
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A **conservative pre-filter**, never the answer: do two axis-aligned boxes share any point at
 * all? Two boxes that are strictly separated cannot bound polygons that meet, so the geometry
 * below can be skipped for them. Boxes that touch or overlap go on to the real comparison — a
 * bounding box is not a region and V-11 is never decided on one.
 *
 * @returns {boolean}
 */
function boxesOverlap(a, b) {
  return !(a.maxLon < b.minLon || b.maxLon < a.minLon || a.maxLat < b.minLat || b.maxLat < a.minLat);
}

/**
 * Ray casting on a closed ring. Defined for a point that is **not on** the ring; every caller
 * below establishes that first, because the ray cast's answer for a point lying on an edge is
 * whichever side the arithmetic happens to land on.
 *
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
 * Every parameter `t ∈ [0, 1]` along the segment `[p1, p2]` at which it meets the closed segment
 * `[q1, q2]`, and the sub-range of `t` over which the two are collinear and overlapping.
 *
 * The collinear stretch is reported as a **parameter range** rather than as a pair of points
 * because that is what lets the caller recognise a shared edge by arithmetic on the parameters
 * it already has. Re-deriving a midpoint and testing it back against the other line would
 * reintroduce exactly the rounding a tolerance would then have to absorb, and V-11 introduces
 * none — see `validateRegionsDisjoint`.
 *
 * @param {number[]} p1 @param {number[]} p2 @param {number[]} q1 @param {number[]} q2
 * @returns {{ touches: number[], collinear: number[]|null }}
 */
function meetingParameters(p1, p2, q1, q2) {
  const rx = p2[0] - p1[0];
  const ry = p2[1] - p1[1];
  const sx = q2[0] - q1[0];
  const sy = q2[1] - q1[1];
  const denominator = rx * sy - ry * sx;
  const dx = q1[0] - p1[0];
  const dy = q1[1] - p1[1];

  if (denominator !== 0) {
    const t = (dx * sy - dy * sx) / denominator;
    const u = (dx * ry - dy * rx) / denominator;
    return { touches: t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t] : [], collinear: null };
  }
  // Parallel. Collinear as well only when the offset between the two lines is zero.
  if (dx * ry - dy * rx !== 0) return { touches: [], collinear: null };
  const lengthSquared = rx * rx + ry * ry;
  if (lengthSquared === 0) return { touches: [], collinear: null };
  const first = (dx * rx + dy * ry) / lengthSquared;
  const second = first + (sx * rx + sy * ry) / lengthSquared;
  const lo = Math.max(0, Math.min(first, second));
  const hi = Math.min(1, Math.max(first, second));
  if (lo > hi) return { touches: [], collinear: null };
  return { touches: [lo, hi], collinear: [lo, hi] };
}

/**
 * Walk one ring against another and report what its boundary does relative to the other's
 * **interior**.
 *
 * Each edge is cut at every parameter where it meets the other ring, so the interior of every
 * resulting stretch is homogeneous — wholly inside the other ring, wholly outside it, or wholly
 * along it — and one sample per stretch decides the stretch exactly. A stretch lying along a
 * shared edge is recognised from the collinear parameter range that produced it, never by
 * re-testing a recomputed point.
 *
 * @param {number[][]} ring
 * @param {number[][]} other
 * @returns {{ entersInterior: boolean, wholly: boolean }} `wholly` — every stretch of this ring
 *   runs along the other's boundary
 */
function traceRingAgainst(ring, other) {
  let stretches = 0;
  let alongBoundary = 0;

  for (let index = 0; index < ring.length - 1; index += 1) {
    const from = ring[index];
    const to = ring[index + 1];
    const cuts = [0, 1];
    const shared = [];
    for (let j = 0; j < other.length - 1; j += 1) {
      const meeting = meetingParameters(from, to, other[j], other[j + 1]);
      for (const t of meeting.touches) cuts.push(t);
      if (meeting.collinear) shared.push(meeting.collinear);
    }
    cuts.sort((a, b) => a - b);

    for (let k = 0; k < cuts.length - 1; k += 1) {
      // @structural the arithmetic mean of two parameters — a midpoint's own divisor
      const mid = (cuts[k] + cuts[k + 1]) / 2;
      // A cut repeated, or two cuts too close to have a midpoint between them, is not a stretch.
      if (!(mid > cuts[k]) || !(mid < cuts[k + 1])) continue;
      stretches += 1;
      if (shared.some(([lo, hi]) => mid >= lo && mid <= hi)) {
        alongBoundary += 1;
        continue;
      }
      const point = [from[0] + (to[0] - from[0]) * mid, from[1] + (to[1] - from[1]) * mid];
      // The stretch meets the other ring nowhere in its interior, so this point is strictly
      // inside or strictly outside and the ray cast is well defined.
      if (pointInRing(point, other)) return { entersInterior: true, wholly: false };
    }
  }
  return { entersInterior: false, wholly: stretches > 0 && alongBoundary === stretches };
}

/**
 * Do two validated polygons share **area**?
 *
 * PHASE 15 residual pass, R-2. This asked whether any pair of edges met at all — `segmentsCross`
 * reports a collinear overlap as a crossing, because for V-3 (a ring doubling back on itself) it
 * must — so two regions sharing only the line `x = 1` were reported as overlapping, and so were
 * two meeting at a single corner. That is the **strict** direction, but it is not the contract:
 * this function's own name and the sentence above it ask about shared *area*, `boxesOverlap` is
 * documented as a filter rather than an answer, and V-11's reason (§3.5 — every Agent and every
 * Leg belongs to exactly one region at a time, and §3.6 assigns membership by **published cell**,
 * not by geometry) is about a shared interior. Genuinely adjacent operating regions — a depot
 * catchment abutting the metro area next to it — are the normal case, and refusing them would
 * have sent Operations back to redraw a correct boundary.
 *
 * So the question asked is the one V-11 means: **positive-area intersection is an overlap;
 * boundary-only contact is not.** No tolerance is introduced — an "almost touching" rule would
 * be this module deciding how close two regions may be drawn, which is a geographic question it
 * has no authority over, and the comparisons below are the same exact ones `segmentsCross` and
 * `checkRing` already make.
 *
 * @param {number[][][]} left @param {number[][][]} right
 * @returns {boolean}
 */
function polygonsOverlap(left, right) {
  // The exterior ring is what the containment half of this comparison has always used
  // (`left[0]`, `right[0]`). Hole semantics are unchanged and none is introduced here.
  const leftTrace = traceRingAgainst(left[0], right[0]);
  if (leftTrace.entersInterior) return true;
  const rightTrace = traceRingAgainst(right[0], left[0]);
  if (rightTrace.entersInterior) return true;
  // Neither boundary passes through the other's interior, so the two interiors are either
  // disjoint or the same. They are the same exactly when one boundary runs wholly along the
  // other: V-2 and V-3 have already established that both rings are closed and simple, and a
  // simple closed curve cannot be a proper subset of another simple closed curve.
  return leftTrace.wholly || rightTrace.wholly;
}

/**
 * V-11 — regions do not overlap.
 *
 * §3.5 makes region → shard a function (`Shard.regionId @unique`) and states that every Agent
 * and every Leg belongs to exactly one region at a time. Two overlapping regions make that
 * statement false for the overlap, and the failure surfaces as an Agent routed to two shards.
 *
 * **What counts as an overlap (R-2).** A shared *interior* — positive area. Regions that meet
 * along an edge or at a corner are disjoint and are accepted: they share no area, so no Agent
 * and no Leg is in two of them, and adjacent operating regions are the ordinary case rather
 * than a defect. See `polygonsOverlap`, which is where that contract is enforced.
 *
 * **No tolerance.** Every comparison here is exact. A near-miss rule would amount to this module
 * deciding how close two boundaries may be drawn before they count as the same place, which is a
 * geographic decision it holds no authority to make — the same reason `checkPosition` refuses to
 * re-order a `[lat, lon]` file rather than correcting it.
 *
 * **Entries that are not usable are the caller's to report.** This compares the geometries it can
 * compare and filters the rest; an entry that never reaches the comparison is silently
 * uncompared, so a caller that assembles the list from operator input must report the entries it
 * supplied that did not validate. `b1Readiness.assessD1` does — see R-1 there.
 *
 * @param {object[]} validated results of `validateRegionDeclaration`, `VALID` ones only
 * @returns {{ status: string, problems: string[] }}
 */
function validateRegionsDisjoint(validated) {
  const usable = (validated || []).filter((entry) => entry && entry.status === BOUNDARY_STATUS.VALID && entry.polygons);
  // @structural an overlap needs two regions; fewer cannot overlap
  if (usable.length < 2) {
    return Object.freeze({
      status: usable.length === 0 ? BOUNDARY_STATUS.NOT_CONFIGURED : BOUNDARY_STATUS.VALID,
      problems: Object.freeze([]),
    });
  }

  const problems = [];
  // Ordered by regionId so the report is identical on every run, whatever order the caller
  // supplied (§9.6).
  const ordered = [...usable].sort((a, b) => compareStrings(a.regionId, b.regionId));
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      if (!boxesOverlap(ordered[i].bbox, ordered[j].bbox)) continue;
      const overlapping = ordered[i].polygons.some((left) => ordered[j].polygons.some((right) => polygonsOverlap(left, right)));
      if (overlapping) {
        problems.push(
          `V-11 regions "${ordered[i].regionId}" and "${ordered[j].regionId}" overlap — they share area, not merely ` +
            "a boundary. §3.5 makes region → shard a function (Shard.regionId is unique) and requires every Agent " +
            "and every Leg to belong to exactly one region at a time; an overlap makes that undefined for anything " +
            "inside it",
        );
      }
    }
  }
  return Object.freeze({ status: problems.length === 0 ? BOUNDARY_STATUS.VALID : BOUNDARY_STATUS.INVALID, problems: Object.freeze(problems) });
}

/**
 * V-12 — every charger and depot lies in the region's own cell set.
 *
 * Containment is by assignment, not geometry (§3.6), so this is a set membership check over
 * published cell ids and not a point-in-polygon test. §14.5 makes the consequence concrete: a
 * charger outside the region's cell set is a return-leg destination the region's routing
 * cannot reach, which is an unreachable fallback rather than a fallback.
 *
 * @param {{ cover?: object, chargers?: object[] }} input
 * @returns {{ status: string, problems: string[] }}
 */
function validateChargerContainment(input) {
  const source = input || {};
  const cover = source.cover;
  const chargers = source.chargers;
  if (!cover || !Array.isArray(chargers)) {
    return Object.freeze({
      status: BOUNDARY_STATUS.NOT_CONFIGURED,
      problems: Object.freeze(["V-12 cannot run: it needs both a cell cover (from D1's boundary) and the region's charger catalogue"]),
    });
  }

  const covered = new Set();
  for (const list of [cover.fineCells, cover.coarseCells]) {
    for (const assignment of Array.isArray(list) ? list : []) {
      if (assignment && typeof assignment.cellId === "string") covered.add(assignment.cellId);
    }
  }

  const problems = [];
  for (const charger of chargers) {
    if (!charger || !isNonEmptyString(charger.chargerId)) {
      problems.push("V-12 a charger entry has no chargerId");
      continue;
    }
    if (!isNonEmptyString(charger.cellId)) {
      problems.push(`V-12 charger "${charger.chargerId}" names no cell; containment is by published assignment (§3.6), so an unassigned charger is not locatable at all`);
      continue;
    }
    if (!covered.has(charger.cellId)) {
      problems.push(
        `V-12 charger "${charger.chargerId}" is assigned to cell "${charger.cellId}", which is not in this region's ` +
          "cover. §14.5's return leg would route to a destination outside the region's routing graph — an " +
          "unreachable fallback is worse than a missing one, because it is selected before it fails",
      );
    }
  }
  return Object.freeze({ status: problems.length === 0 ? BOUNDARY_STATUS.VALID : BOUNDARY_STATUS.INVALID, problems: Object.freeze(problems) });
}

/**
 * V-13 — the routing extract covers the region's bounding box plus a margin.
 *
 * §5.2 colocates the routing service with the shard and routes within the region; a route that
 * leaves the graph is the `EXTRACT_MISS` condition the B1 adapters classify. The margin's
 * **size**, however, is a property of the chosen engine's snapping and border behaviour, which
 * is B1's to measure — so an unsupplied margin returns `NOT_CONFIGURED` and never a pass.
 * §30.5.5 states this outright: "V-13 cannot be written before B1."
 *
 * @param {{ region?: object, extract?: object }} input
 * @returns {{ status: string, problems: string[] }}
 */
function validateExtractMargin(input) {
  const source = input || {};
  const region = source.region;
  const extract = source.extract;

  if (!region || region.status !== BOUNDARY_STATUS.VALID || !region.bbox) {
    return Object.freeze({ status: BOUNDARY_STATUS.NOT_CONFIGURED, problems: Object.freeze(["V-13 cannot run: there is no valid region geometry to size an extract against (D1)"]) });
  }
  if (!extract || typeof extract !== "object" || !extract.bbox || !isFiniteNumber(extract.marginDegrees)) {
    return Object.freeze({
      status: BOUNDARY_STATUS.NOT_CONFIGURED,
      problems: Object.freeze([
        "V-13 cannot run: it needs the extract's own bounding box and the margin it was cut with. The margin's size " +
          "is a property of the chosen engine's snapping and border behaviour, which is measured at B1 Step 1/3 — " +
          "so no margin is assumed here and this check does not pass by default",
      ]),
    });
  }

  const { minLon, minLat, maxLon, maxLat } = region.bbox;
  const margin = extract.marginDegrees;
  const required = { minLon: minLon - margin, minLat: minLat - margin, maxLon: maxLon + margin, maxLat: maxLat + margin };
  const problems = [];
  const box = extract.bbox;
  for (const [field, comparison] of [["minLon", "<="], ["minLat", "<="], ["maxLon", ">="], ["maxLat", ">="]]) {
    if (!isFiniteNumber(box[field])) {
      problems.push(`V-13 extract.bbox.${field} is not a finite number`);
      continue;
    }
    const ok = comparison === "<=" ? box[field] <= required[field] : box[field] >= required[field];
    if (!ok) {
      problems.push(
        `V-13 extract.bbox.${field} is ${box[field]}, which does not cover the region's ${field} of ${required[field]} ` +
          `(region bbox ${comparison === "<=" ? "minus" : "plus"} the ${margin}° margin). A route leaving the cut graph ` +
          "returns EXTRACT_MISS rather than a route (§5.2)",
      );
    }
  }
  return Object.freeze({ status: problems.length === 0 ? BOUNDARY_STATUS.VALID : BOUNDARY_STATUS.INVALID, problems: Object.freeze(problems) });
}

module.exports = {
  BOUNDARY_STATUS,
  REGION_KIND,
  REGION_KINDS,
  WGS84_CRS,
  FINE_CELL_BAND,
  CELL_INDEXING,
  CELL_INDEXINGS,
  // Exported because D1's `versionDate` and D8's `extract.vintage` are the same kind of fact
  // and were being judged by two different rules: this one rejects `2026-02-31`, and
  // `b1Readiness.assessD8`'s own regex accepted it. Two authorities disagreeing about what a
  // date is, is the shape this programme has now found five times.
  isIsoDate,
  validateRegionDeclaration,
  // Exported for `spatial/deliveryDomain.js`, which is the authoritative point-in-domain
  // primitive (D1). It is exported rather than re-implemented there so that **one** ray-cast
  // exists in the tree: two would be two answers to one question, and the failure mode is a
  // point that V-11 and the geofence disagree about. `deliveryDomain` supplies the on-edge
  // test this function's contract requires of its callers.
  pointInRing,
  boundingBoxOf,
  validateCellIdentity,
  validateCover,
  d2ResidualCheck,
  validateRegionsDisjoint,
  validateChargerContainment,
  validateExtractMargin,
};

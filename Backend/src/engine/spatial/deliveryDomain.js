"use strict";

/**
 * **The authoritative delivery-domain membership test** — D1 layer 2, the exact
 * coordinate against the published domain geometry (`RD-2026-09-14-01`).
 *
 * ── The two layers, and why they are not the same question ──────────────────
 * §3.6 calls an H3 cell *"the **index and cache** unit"*. RD-2026-09-14-01 D1 makes the
 * consequence binding:
 *
 *     H3 cell            → indexing, caching, candidate expansion.
 *     exact coordinate   → delivery-domain membership.
 *
 * **An H3 cell's presence in the published index does not establish that the ground it
 * covers is inside the RobotX delivery domain.** A hexagon is not a campus and never
 * becomes one by being indexed. The published index may — by explicit owner ruling
 * (D6) — contain cells that straddle the boundary, whose centres lie outside it, and
 * part of whose area is outside it. Those are **index buckets**. They are not a
 * geographic assignment of the non-campus ground they happen to cover, and they confer
 * no serviceability on it.
 *
 * This module answers the *other* question, and it is the only thing in the tree that
 * does: given one exact coordinate and one published domain geometry, is that point in
 * the delivery domain?
 *
 * ── Where it runs, and where it must never run ──────────────────────────────
 * Once, at intake/seal (`services/task.service.sealIdentities`), pinned onto
 * `Stop.geofenceResult`, and read from there by the round.
 *
 * It must **not** be called inside a coordinator round. ADR-28's decision text is
 * *"containment by published assignment, not by query-time geometry"*, and §3.6 gives
 * the reason: *"floating-point geometry evaluated per round … is both slow and
 * non-deterministic (T6)"*. Evaluating once at a lifecycle boundary and pinning the
 * answer is what reconciles D1 with ADR-28; evaluating per round would not, and would
 * need the architecture unfrozen. `workers/coordinatorSolvePath.js` consumes the pin
 * and a test asserts that this module is unreachable from it.
 *
 * ── The three answers ───────────────────────────────────────────────────────
 * `INSIDE`, `OUTSIDE`, `INDETERMINATE`, mapping onto §4.1's discipline exactly:
 *
 *   · no declaration published, or it does not validate → **INDETERMINATE**
 *   · no readable coordinate                            → **INDETERMINATE**
 *   · a readable coordinate outside the geometry        → **OUTSIDE** (a definite fact)
 *   · a readable coordinate inside the geometry         → **INSIDE**
 *
 * There is no fourth branch and no default. §4.1 rule 3 — state is never inferred from
 * the absence of data — is why an absent declaration is not "the world is serviceable"
 * and an absent coordinate is not "inside".
 *
 * ── Determinism ─────────────────────────────────────────────────────────────
 * No clock, no randomness, no locale-sensitive comparison, no tolerance and no epsilon.
 * The ray cast is `regionBoundary.pointInRing` — the same one V-11 uses, exported
 * rather than re-implemented so that one ray cast exists in this tree. Two would be two
 * answers to one question. Rings are walked in their declared order, so two runs over
 * the same declaration and the same point produce byte-identical output (§9.6).
 */

const regionBoundary = require("./regionBoundary");
const { SPATIAL_MODEL } = require("./cells");

/**
 * The three verdicts, and the exact strings persisted on `Stop.geofenceResult`.
 *
 * `Stop.geofenceResult` is one of §23.7's **six already-declared derived quantities**
 * (`privacy/surrogateKeys.js`), so pinning a verdict there adds no new field to the
 * privacy enumeration and widens no exemption. It is the column the schema already
 * carries for this fact and which, until now, nothing wrote.
 * @structural the geofence verdict vocabulary
 */
const GEOFENCE_VERDICT = Object.freeze({
  INSIDE: "INSIDE",
  OUTSIDE: "OUTSIDE",
  INDETERMINATE: "INDETERMINATE",
});

const GEOFENCE_VERDICTS = Object.freeze(Object.values(GEOFENCE_VERDICT));

/** @structural the WGS-84 latitude bound in degrees */
const MAX_ABS_LATITUDE = 90;
/** @structural the WGS-84 longitude bound in degrees */
const MAX_ABS_LONGITUDE = 180;

/** @param {unknown} value @returns {boolean} */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Is `point` exactly on the closed segment `[a, b]`?
 *
 * **Exact arithmetic, no tolerance.** A point on the declared boundary is a real case
 * that has to have one answer, and a tolerance would make that answer depend on a
 * number nobody declared. `pointInRing`'s own contract says its result for a point
 * lying on an edge is *"whichever side the arithmetic happens to land on"*, so this
 * test runs **first** and settles it.
 *
 * @param {number[]} point `[lon, lat]`
 * @param {number[]} a @param {number[]} b
 * @returns {boolean}
 */
function isOnSegment(point, a, b) {
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
 * Is `point` exactly on any edge of a closed ring?
 *
 * @param {number[]} point @param {number[][]} ring
 * @returns {boolean}
 */
function isOnRing(point, ring) {
  for (let index = 0; index < ring.length - 1; index += 1) {
    if (isOnSegment(point, ring[index], ring[index + 1])) return true;
  }
  return false;
}

/**
 * Is `point` inside one Polygon — exterior ring first, holes after (RFC 7946)?
 *
 * **A point on the boundary is INSIDE.** The declared domain is read as a *closed*
 * set: the polygon its owner published is the area committed to, and its perimeter is
 * part of it. The alternative reading was considered and rejected for one reason — it
 * is not that one is safer, it is that "on the line" must be *decided* rather than left
 * to the sign of a floating-point subtraction, and a closed set is the reading RFC 7946
 * geometry and the adopted OSM way both carry. A hole's edge is the domain's boundary
 * too, so it is inside as well.
 *
 * ── What "on the boundary" means exactly, because it is narrower than it sounds ──
 * `isOnSegment` uses **exact IEEE-754 arithmetic with no tolerance**, so "on the
 * boundary" means *on it exactly as a double*, not *near it*. Every declared **vertex**
 * satisfies that by construction. A point computed from the geometry — an edge midpoint,
 * say — generally does **not**: measured on the adopted RNSIT ring, 6 of its 18 edge
 * midpoints are exactly collinear and 12 are not, because `(a + b) / 2` is not in general
 * on the segment `[a, b]` in floating point.
 *
 * Those 12 fall through to the ray cast and get a deterministic answer that is simply
 * whichever side the arithmetic lands on. **That is accepted, and it is not a defect
 * being tolerated** — the alternative is an epsilon, and an epsilon is a number nobody
 * declared that silently widens or narrows the delivery domain by a distance no decision
 * record names. Determinism, which is the property the round actually depends on, holds
 * either way: the same coordinate and the same declaration always give the same verdict.
 * The residual is sub-millimetre and is recorded rather than papered over.
 *
 * @param {number[]} point `[lon, lat]`
 * @param {number[][][]} rings
 * @returns {boolean}
 */
function isInPolygon(point, rings) {
  const [exterior, ...holes] = rings;
  if (!Array.isArray(exterior)) return false;

  if (isOnRing(point, exterior)) return true;
  if (!regionBoundary.pointInRing(point, exterior)) return false;

  for (const hole of holes) {
    if (!Array.isArray(hole)) continue;
    // On a hole's edge is on the domain's boundary — inside, by the closed-set reading
    // above — so this test precedes the strict-interior one.
    if (isOnRing(point, hole)) return true;
    if (regionBoundary.pointInRing(point, hole)) return false;
  }
  return true;
}

/**
 * Validate and normalise a published delivery-domain declaration — **S-3 row 29**.
 *
 * ── Why this is its own external input and not part of the cell assignments ─
 * RD-2026-09-14-01 **D7**. S-3 row 26 is the `CellAssignment` input: cell → zone / site
 * / region attribution, which §8.3's `λ_zone` and §3.6's pricing hierarchy read and
 * which nothing here replaces. Row 29 is a *different fact from a different owner* —
 * the signed, published geometry that says what ground RobotX commits to serve. Hiding
 * the second inside the first would make an index publication silently redefine the
 * delivery domain, which is exactly the conflation D1 exists to end.
 *
 * The five geometry/identity fields are validated by `regionBoundary.validateRegionDeclaration`
 * — the same V-1 … V-7 checks D1's acceptance gate applies, deliberately not a second
 * set. A CRS is never assumed, a `[lat, lon]` file is refused rather than re-ordered,
 * and nothing is buffered, simplified, reprojected or snapped.
 *
 * ── `attested` is reported, never inferred ──────────────────────────────────
 * A declaration that validates geometrically is still not the production owner
 * declaration until a person has signed it. `B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.5 is
 * explicit that **no validator can discharge that** — so this function reports
 * `attested: false` and names what is missing rather than treating a development
 * artefact as a signed one. A verdict is still produced from a valid unattested
 * geometry, because the geometry is real and refusing to compute would not make the
 * signature appear; what must not happen is S-3 row 29 being reported as satisfied.
 *
 * @param {object|null|undefined} published the `deliveryDomain` payload of a pinned snapshot
 * @returns {{ status: string, problems: string[], domainId: string|null, version: string|null,
 *             polygons: number[][][][]|null, bbox: object|null, attested: boolean,
 *             attestation: object|null }}
 */
function validateDomainDeclaration(published) {
  if (published === null || published === undefined) {
    return Object.freeze({
      status: regionBoundary.BOUNDARY_STATUS.NOT_CONFIGURED,
      problems: Object.freeze([
        "S-3 row 29 is undeclared: no authoritative delivery-domain geometry has been published. This is not a " +
          "validation failure and it is not a pass — it is the absence of an owner declaration. Every geofence " +
          "verdict is INDETERMINATE until it arrives, and F33 denies. Supply regionId + name, kind, the boundary " +
          "as GeoJSON Polygon/MultiPolygon in WGS-84 [lon, lat], the CRS, a version label with a date, and the " +
          "declaration block that attests it",
      ]),
      domainId: null,
      version: null,
      polygons: null,
      bbox: null,
      attested: false,
      attestation: null,
    });
  }

  const base = regionBoundary.validateRegionDeclaration(published);
  const problems = [...base.problems];

  // The attestation block — the half §1.8.5 says no validator can discharge. Its absence
  // is reported as a problem against *row 29's discharge*, never as a geometry fault.
  const source = typeof published === "object" && published !== null ? published : {};
  const declaration = source.declaration && typeof source.declaration === "object" ? source.declaration : null;
  const attestationGaps = [];
  if (declaration === null) {
    attestationGaps.push("declaration is absent — an unsigned development artefact is not an owner declaration");
  } else {
    if (!isNonEmptyString(declaration.declaredBy)) attestationGaps.push("declaration.declaredBy is required — the accountable owner, by name");
    if (!regionBoundary.isIsoDate(declaration.declaredAt)) attestationGaps.push("declaration.declaredAt must be an ISO calendar date (YYYY-MM-DD)");
    if (!isNonEmptyString(declaration.geometryDigestSha256)) {
      attestationGaps.push("declaration.geometryDigestSha256 is required — the digest of the geometry actually signed, so the signed file and the published one can be shown to be the same file");
    }
  }

  const attested = base.status === regionBoundary.BOUNDARY_STATUS.VALID && attestationGaps.length === 0;
  for (const gap of attestationGaps) problems.push(`S-3 row 29 is NOT discharged: ${gap}`);

  return Object.freeze({
    // The *geometry's* status. An unattested but geometrically valid declaration is
    // VALID here and `attested: false` — two different facts, reported as two.
    status: base.status,
    problems: Object.freeze(problems),
    domainId: base.regionId,
    version: typeof source.version === "string" ? source.version : null,
    polygons: base.polygons,
    bbox: base.bbox,
    attested,
    attestation: declaration,
  });
}

/**
 * The authoritative point-in-domain test. **One primitive, one answer.**
 *
 * @param {object|null|undefined} domain the validated declaration, from `validateDomainDeclaration`
 * @param {unknown} lat @param {unknown} lon
 * @returns {{ verdict: string, reason: string, domainId: string|null, domainVersion: string|null,
 *             spatialModel: string }}
 */
function evaluatePoint(domain, lat, lon) {
  const identity = {
    domainId: domain && domain.domainId ? domain.domainId : null,
    domainVersion: domain && domain.version ? domain.version : null,
    // Carried so a pinned verdict can be attributed to the model in force when it was
    // taken. The verdict does not *depend* on the model — it is a coordinate against a
    // polygon, with no cell in it anywhere — and that independence is the point of D1.
    spatialModel: SPATIAL_MODEL.id,
  };

  if (!domain || domain.status !== regionBoundary.BOUNDARY_STATUS.VALID || !Array.isArray(domain.polygons) || domain.polygons.length === 0) {
    return Object.freeze({
      ...identity,
      verdict: GEOFENCE_VERDICT.INDETERMINATE,
      reason:
        "no valid authoritative delivery-domain declaration is published (S-3 row 29), so membership is unknown. " +
        "An undeclared domain is not a universal one: §4.1 rule 3 forbids reading the absence of the declaration " +
        "as permission",
    });
  }

  const readable =
    typeof lat === "number" && Number.isFinite(lat) && Math.abs(lat) <= MAX_ABS_LATITUDE &&
    typeof lon === "number" && Number.isFinite(lon) && Math.abs(lon) <= MAX_ABS_LONGITUDE;
  if (!readable) {
    return Object.freeze({
      ...identity,
      verdict: GEOFENCE_VERDICT.INDETERMINATE,
      reason:
        `no readable coordinate to test (lat=${String(lat)}, lon=${String(lon)}); no geofence verdict is taken. ` +
        "A malformed coordinate is a definite fact about the request and F33 reports it as such from the " +
        "coordinate itself — it is deliberately not reported here as 'outside the domain', which would be a " +
        "claim about geography that nothing established",
    });
  }

  const point = [lon, lat];
  const box = domain.bbox;
  // A bounding box is never the answer, only a conservative exclusion: a point outside
  // the box cannot be inside any ring the box bounds. Points inside the box go on to
  // the real test.
  if (box && (point[0] < box.minLon || point[0] > box.maxLon || point[1] < box.minLat || point[1] > box.maxLat)) {
    return Object.freeze({
      ...identity,
      verdict: GEOFENCE_VERDICT.OUTSIDE,
      reason: "the coordinate lies outside the declared delivery domain's bounding box",
    });
  }

  for (const rings of domain.polygons) {
    if (isInPolygon(point, rings)) {
      return Object.freeze({ ...identity, verdict: GEOFENCE_VERDICT.INSIDE, reason: "the coordinate lies inside the declared delivery domain" });
    }
  }

  return Object.freeze({
    ...identity,
    verdict: GEOFENCE_VERDICT.OUTSIDE,
    reason: "the coordinate lies outside the declared delivery domain",
  });
}

/**
 * Evaluate a coordinate straight from a published snapshot payload — the one call
 * intake makes, so that the validate-then-evaluate pair cannot be split by a caller
 * who forgets the first half.
 *
 * @param {object|null|undefined} published a pinned snapshot's `deliveryDomain` payload
 * @param {unknown} lat @param {unknown} lon
 * @returns {object} as `evaluatePoint`
 */
function verdictFor(published, lat, lon) {
  return evaluatePoint(validateDomainDeclaration(published), lat, lon);
}

/**
 * Read a **pinned** verdict back, three-valued — the round's side of the seam.
 *
 * `true` / `false` / `undefined`, never a coerced boolean:
 *
 *   · `INSIDE`                      → `true`
 *   · `OUTSIDE`                     → `false`   (a definite fact; F33 reports VIOLATED)
 *   · `INDETERMINATE`, null, absent → `undefined`
 *   · **anything else**             → `undefined`
 *
 * The last branch is the one worth stating. A value this vocabulary does not contain is
 * a value written by something that does not agree with this module — a foreign
 * migration, a hand-edited row, a future verdict class. It is read as *absent*, not as
 * `false` and never as `true`: absent denies and says why, which is the honest answer
 * to "I cannot interpret this", whereas `false` would assert a geographic fact nothing
 * established.
 *
 * @param {unknown} pinned the value of `Stop.geofenceResult`
 * @returns {boolean|undefined}
 */
function pinnedMembership(pinned) {
  if (pinned === GEOFENCE_VERDICT.INSIDE) return true;
  if (pinned === GEOFENCE_VERDICT.OUTSIDE) return false;
  return undefined;
}

module.exports = {
  GEOFENCE_VERDICT,
  GEOFENCE_VERDICTS,
  validateDomainDeclaration,
  evaluatePoint,
  verdictFor,
  pinnedMembership,
  // Exported for the RNSIT geometry tests, which assert the closed-set boundary reading
  // directly rather than only through a declaration.
  isInPolygon,
  isOnRing,
};

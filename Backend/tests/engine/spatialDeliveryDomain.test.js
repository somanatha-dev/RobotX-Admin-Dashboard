"use strict";

/**
 * **D1 — the two-layer spatial model** (`RD-2026-09-14-01`).
 *
 *     H3 cell          → index / cache / candidate expansion
 *     exact coordinate → delivery-domain membership
 *
 * Every fixture below that needs a boundary uses the **real adopted RNSIT geometry**,
 * `way/1120154292`, hash-verified before use, with no buffer, no simplification, no
 * reprojection and no snapping. The out-of-campus points are real too: `rnsit-parking-lot`
 * and `rnsit-main-gate` are both measured outside the adopted perimeter *and* inside the
 * D6 boundary-overlap index cover, which makes them the exact case D6 rules on rather
 * than an invented one.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const h3 = require("h3-js");

const cells = require("../../src/engine/spatial/cells");
const deliveryDomain = require("../../src/engine/spatial/deliveryDomain");
const hierarchy = require("../../src/engine/spatial/hierarchy");
const solvePath = require("../../src/workers/coordinatorSolvePath");
const f33 = require("../../src/engine/feasibility/predicates/f33");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");

/** The SHA-256 `RD-2026-08-30-01` pins the adopted boundary file at. */
const BOUNDARY_SHA256 = "04cb64c4205dc59462e149501fdd93b412106cfdc8d7249661bc8f3f47dc08b4";

function loadAdoptedBoundary() {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "rnsit-campus-osm.geojson"));
  const digest = crypto.createHash("sha256").update(raw).digest("hex");
  // Verified, not trusted. A boundary that is not the adopted one is not a fixture
  // problem — it is a different campus, and every number below would be about it.
  expect(digest).toBe(BOUNDARY_SHA256);
  const feature = JSON.parse(raw).features.find((row) => row.id === "way/1120154292");
  expect(feature).toBeDefined();
  return feature.geometry;
}

const BOUNDARY = loadAdoptedBoundary();

/** The supplemental verification points, by id. */
const POINTS = (() => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "rnsit-campus-supplemental.geojson")));
  const byId = {};
  for (const feature of raw.features) {
    const [lon, lat] = feature.geometry.coordinates;
    byId[feature.properties.id] = { lat, lon };
  }
  return byId;
})();

/** A complete, geometrically valid declaration. Attested separately — see the D7 block. */
function declarationOf(overrides = {}) {
  return {
    regionId: "rnsit-campus",
    name: "RNSIT Campus",
    kind: "CAMPUS",
    crs: "EPSG:4326",
    version: "way/1120154292",
    versionDate: "2026-08-30",
    boundary: BOUNDARY,
    ...overrides,
  };
}

const FINE = cells.H3_RESOLUTION.FINE;
const cellOf = (point) => h3.latLngToCell(point.lat, point.lon, FINE);

/** The centre-contained cover — what `polygonToCells` produces by default. */
const CENTRE_COVER = h3.polygonToCells(BOUNDARY.coordinates, FINE, true);
/** **The D6 index cover** — boundary-overlapping, permitted as index membership only. */
const INDEX_COVER = h3.polygonToCellsExperimental(
  BOUNDARY.coordinates,
  FINE,
  h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping,
  true,
);

/** A published `spatial` payload assigning exactly the given cells. */
function spatialPayloadFor(cellIds) {
  return {
    version: 1,
    regions: [{ id: "region-1" }],
    zones: [{ id: "zone-1", regionId: "region-1" }],
    sites: [],
    cells: cellIds.map((cellId) => ({ cellId, resolution: cells.RESOLUTION.FINE, regionId: "region-1", zoneId: "zone-1" })),
  };
}

/**
 * One stop through the production seam: pin the verdict as intake would, then run the
 * round's `serviceabilityFor` and F33 over it.
 */
function throughTheSeam({ point, spatial, domain = declarationOf(), routable = true }) {
  const pinned = deliveryDomain.verdictFor(domain, point.lat, point.lon);
  const stop = { stopId: "s1", sequence: 1, lat: point.lat, lon: point.lon, geofenceResult: pinned.verdict, routable };
  const [projected] = solvePath.serviceabilityFor({ spatial })([stop]);
  const verdict = f33.evaluate({ plan: { stops: [{ ...projected, sequence: 1 }] } });
  return { pinned, projected, verdict };
}

/* ═══════════════════════════════════════════════════════════════════════════
   The measured facts every case below stands on
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the adopted RNSIT boundary, measured", () => {
  test("the centre cover and the D6 index cover are different sets, and the index one is larger", () => {
    expect(CENTRE_COVER.length).toBe(45);
    expect(INDEX_COVER.length).toBe(64);
    const centre = new Set(CENTRE_COVER);
    const added = INDEX_COVER.filter((cellId) => !centre.has(cellId));
    expect(added.length).toBe(19);

    // Every cell the overlap mode adds has its centre OUTSIDE the campus — that is what
    // "boundary-overlapping" means, and it is exactly why the mode was refused as a
    // *geographic assignment* and is permitted as an *index*.
    const domain = deliveryDomain.validateDomainDeclaration(declarationOf());
    for (const cellId of added) {
      const [lat, lon] = h3.cellToLatLng(cellId);
      expect(deliveryDomain.evaluatePoint(domain, lat, lon).verdict).not.toBe("INSIDE");
    }
  });

  test("rnsit-parking-lot and rnsit-main-gate are outside the campus AND inside the index cover", () => {
    const domain = deliveryDomain.validateDomainDeclaration(declarationOf());
    const index = new Set(INDEX_COVER);
    const centre = new Set(CENTRE_COVER);
    for (const id of ["rnsit-parking-lot", "rnsit-main-gate"]) {
      const point = POINTS[id];
      expect(deliveryDomain.evaluatePoint(domain, point.lat, point.lon).verdict).toBe("OUTSIDE");
      expect(index.has(cellOf(point))).toBe(true);
      expect(centre.has(cellOf(point))).toBe(false);
    }
  });

  test("in-campus verification points geofence INSIDE and are indexed", () => {
    const domain = deliveryDomain.validateDomainDeclaration(declarationOf());
    const index = new Set(INDEX_COVER);
    for (const id of ["rnsit-food-court", "rnsit-canara-bank", "rnsit-innovation-center", "rnsit-pre-university-college"]) {
      const point = POINTS[id];
      expect(deliveryDomain.evaluatePoint(domain, point.lat, point.lon).verdict).toBe("INSIDE");
      expect(index.has(cellOf(point))).toBe(true);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   D1 tests 1 – 6, 14, 15 — the conjunction, case by case
   ═══════════════════════════════════════════════════════════════════════════ */

describe("D1 — serviceable = assigned ∧ inDeliveryDomain ∧ routable", () => {
  // 1
  test("1. assigned cell + point INSIDE the domain → may continue", () => {
    const point = POINTS["rnsit-food-court"];
    const { pinned, projected, verdict } = throughTheSeam({ point, spatial: spatialPayloadFor([cellOf(point)]) });
    expect(pinned.verdict).toBe("INSIDE");
    expect(projected.serviceable).toBe(true);
    expect(verdict.outcome).toBe("SATISFIED");
  });

  // 2 and 14 — the same fact from both directions.
  test("2/14. assigned BOUNDARY-OVERLAP cell + point OUTSIDE the domain → VIOLATED, DENY", () => {
    const point = POINTS["rnsit-parking-lot"];
    const assigned = cellOf(point);
    // The cell really is in the published index — this is not a fixture that withholds
    // the assignment to obtain the answer.
    expect(INDEX_COVER).toContain(assigned);

    const { pinned, projected, verdict } = throughTheSeam({ point, spatial: spatialPayloadFor([assigned]) });
    expect(pinned.verdict).toBe("OUTSIDE");
    expect(projected.serviceable).toBe(false);
    expect(verdict.outcome).toBe("VIOLATED");
    // Index membership did not authorise the outside point, and that is the whole of D6.
    expect(verdict.outcome).not.toBe("SATISFIED");
  });

  // 3
  test("3. assigned BOUNDARY-OVERLAP cell + point INSIDE the domain → the domain condition is satisfied", () => {
    // A point inside the campus whose cell is one the overlap mode added — i.e. a cell
    // whose centre is outside. Found, not assumed.
    const domain = deliveryDomain.validateDomainDeclaration(declarationOf());
    const centre = new Set(CENTRE_COVER);
    const added = INDEX_COVER.filter((cellId) => !centre.has(cellId));

    let found = null;
    for (const cellId of added) {
      for (const [lat, lon] of h3.cellToBoundary(cellId)) {
        if (deliveryDomain.evaluatePoint(domain, lat, lon).verdict === "INSIDE" && h3.latLngToCell(lat, lon, FINE) === cellId) {
          found = { cellId, point: { lat, lon } };
          break;
        }
      }
      if (found) break;
    }
    expect(found).not.toBeNull();

    const { pinned, projected } = throughTheSeam({ point: found.point, spatial: spatialPayloadFor([found.cellId]) });
    expect(pinned.verdict).toBe("INSIDE");
    expect(projected.serviceable).toBe(true);
  });

  // 4
  test("4. UNASSIGNED cell + point INSIDE the domain → INDETERMINATE, never true", () => {
    const point = POINTS["rnsit-food-court"];
    // A published map that assigns somewhere else entirely.
    const { pinned, projected, verdict } = throughTheSeam({
      point,
      spatial: spatialPayloadFor([h3.latLngToCell(51.5074, -0.1278, FINE)]),
    });
    expect(pinned.verdict).toBe("INSIDE");
    expect(projected.serviceable).toBeUndefined();
    expect(projected.serviceable).not.toBe(true);
    expect(verdict.outcome).toBe("INDETERMINATE");
    // §M.2 — an unassigned cell is not an out-of-area one.
    expect(verdict.outcome).not.toBe("VIOLATED");
  });

  // 5
  test("5. MISSING domain declaration → INDETERMINATE, never true", () => {
    const point = POINTS["rnsit-food-court"];
    const { pinned, projected, verdict } = throughTheSeam({
      point,
      spatial: spatialPayloadFor([cellOf(point)]),
      domain: null,
    });
    expect(pinned.verdict).toBe("INDETERMINATE");
    expect(projected.serviceable).toBeUndefined();
    expect(verdict.outcome).toBe("INDETERMINATE");
    // An undeclared domain is not a universal one.
    expect(projected.serviceable).not.toBe(true);
  });

  // 6
  test("6. MISSING coordinate → no geofence verdict, fail closed", () => {
    const domain = deliveryDomain.validateDomainDeclaration(declarationOf());
    for (const [lat, lon] of [[null, null], [undefined, undefined], [Number.NaN, 77.5], [12.9, "77.5"], [91, 77.5], [12.9, 181]]) {
      const result = deliveryDomain.evaluatePoint(domain, lat, lon);
      expect(result.verdict).toBe("INDETERMINATE");
      // Deliberately NOT reported as "outside the domain": that would be a geographic
      // claim about a thing that is not a point.
      expect(result.verdict).not.toBe("OUTSIDE");
      expect(result.reason).toMatch(/no readable coordinate/u);
    }
  });

  // 15
  test("15. CellAssignment semantics are intact — resolve() still answers the index question alone", () => {
    const point = POINTS["rnsit-food-court"];
    const index = hierarchy.indexMap(spatialPayloadFor([cellOf(point)]));
    const resolved = index.resolve(cellOf(point));
    expect(resolved).toMatchObject({ assigned: true, zoneId: "zone-1", regionId: "region-1" });
    // It takes no coordinate, computes no geometry and makes no domain claim.
    expect(Object.keys(resolved)).not.toContain("geofenceResult");
    expect(Object.keys(resolved)).not.toContain("serviceable");

    const elsewhere = index.resolve(h3.latLngToCell(51.5074, -0.1278, FINE));
    expect(elsewhere.assigned).toBe(false);
  });

  test("every conjunct is required — no single one of the three produces serviceability", () => {
    const point = POINTS["rnsit-food-court"];
    const assigned = spatialPayloadFor([cellOf(point)]);
    const unassigned = spatialPayloadFor([h3.latLngToCell(51.5074, -0.1278, FINE)]);

    const run = (spatial, geofenceResult, routable) =>
      solvePath.serviceabilityFor({ spatial })([{ sequence: 1, lat: point.lat, lon: point.lon, geofenceResult, routable }])[0].serviceable;

    expect(run(assigned, "INSIDE", true)).toBe(true);
    expect(run(unassigned, "INSIDE", true)).toBeUndefined();
    expect(run(assigned, undefined, true)).toBeUndefined();
    expect(run(assigned, "INSIDE", undefined)).toBeUndefined();
    expect(run(assigned, "INDETERMINATE", true)).toBeUndefined();
    // A definite negative in any conjunct is VIOLATED-producing, not absent.
    expect(run(assigned, "OUTSIDE", true)).toBe(false);
    expect(run(assigned, "INSIDE", false)).toBe(false);
  });

  test("an unrecognised pinned value is read as absent — never as inside, never as outside", () => {
    for (const foreign of ["inside", "IN", "TRUE", "", "1", {}, 0, true]) {
      expect(deliveryDomain.pinnedMembership(foreign)).toBeUndefined();
    }
    expect(deliveryDomain.pinnedMembership("INSIDE")).toBe(true);
    expect(deliveryDomain.pinnedMembership("OUTSIDE")).toBe(false);
    expect(deliveryDomain.pinnedMembership(null)).toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   D1 tests 7 and 8 — the coordinator consumes the pin and computes no geometry
   ═══════════════════════════════════════════════════════════════════════════ */

describe("D1 — the coordinator consumes a pinned verdict and never evaluates geometry (ADR-28)", () => {
  // 7
  test("7. the round reads the pin, and changing ONLY the pin changes the outcome", () => {
    const point = POINTS["rnsit-food-court"];
    const spatial = spatialPayloadFor([cellOf(point)]);
    const at = (geofenceResult) =>
      solvePath.serviceabilityFor({ spatial })([{ sequence: 1, lat: point.lat, lon: point.lon, geofenceResult, routable: true }])[0].serviceable;

    // Same coordinate, same published map, same routability. Only the pin differs.
    expect(at("INSIDE")).toBe(true);
    expect(at("OUTSIDE")).toBe(false);
    expect(at(null)).toBeUndefined();
  });

  // 8 — runtime
  test("8. serviceabilityFor calls no geometry primitive, even with a domain published", () => {
    const spies = ["evaluatePoint", "validateDomainDeclaration", "verdictFor", "isInPolygon", "isOnRing"].map((name) => {
      const spy = jest.spyOn(deliveryDomain, name);
      return { name, spy };
    });
    const pointInRing = jest.spyOn(require("../../src/engine/spatial/regionBoundary"), "pointInRing");

    try {
      const point = POINTS["rnsit-food-court"];
      const stops = [{ sequence: 1, lat: point.lat, lon: point.lon, geofenceResult: "INSIDE", routable: true }];
      // A snapshot carrying the whole declaration — the temptation case. The round must
      // still not look at it.
      const projected = solvePath.serviceabilityFor({
        spatial: spatialPayloadFor([cellOf(point)]),
        deliveryDomain: declarationOf(),
      })(stops);

      expect(projected[0].serviceable).toBe(true);
      for (const { name, spy } of spies) {
        expect({ primitive: name, calls: spy.mock.calls.length }).toEqual({ primitive: name, calls: 0 });
      }
      expect(pointInRing).not.toHaveBeenCalled();
    } finally {
      for (const { spy } of spies) spy.mockRestore();
      pointInRing.mockRestore();
    }
  });

  // 8 — static. A spy proves this call did not; the source proves no call can.
  test("8. coordinatorSolvePath.js contains no query-time geometry call, by source inspection", () => {
    const raw = fs.readFileSync(path.join(__dirname, "..", "..", "src", "workers", "coordinatorSolvePath.js"), "utf8");
    // **Comments are stripped first.** That module's docstrings name these primitives
    // precisely in order to forbid them, so a naive substring scan would fail on the
    // prohibition itself and would have to be relaxed — which is how a gate gets
    // weakened to stay green. Scan the code.
    const code = raw.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    expect(code).not.toMatch(/\/\*/u);

    for (const forbidden of [
      "deliveryDomain.evaluatePoint",
      "deliveryDomain.verdictFor",
      "deliveryDomain.validateDomainDeclaration",
      "deliveryDomain.isInPolygon",
      "deliveryDomain.isOnRing",
      "pointInRing",
      "polygonToCells",
    ]) {
      expect({ call: forbidden, present: code.includes(forbidden) }).toEqual({ call: forbidden, present: false });
    }
    // The one member it may read is the pin interpreter, which touches no geometry.
    expect(code).toContain("deliveryDomain.pinnedMembership");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   D1 tests 11 and 13 — historical identity and model identity
   ═══════════════════════════════════════════════════════════════════════════ */

describe("D4 — a historical token keeps its historical identity", () => {
  // 11
  test("11. a res-8 token is never interpreted as res-11", () => {
    const point = POINTS["rnsit-food-court"];
    const res8 = h3.latLngToCell(point.lat, point.lon, 8);
    const res11 = h3.latLngToCell(point.lat, point.lon, 11);
    expect(res8).not.toBe(res11);

    // ── Enforcement point 1 — the decode. It resolves to nothing this model
    // recognises, and specifically NOT to FINE.
    expect(cells.resolutionOfH3Cell(res8)).toBeNull();
    expect(cells.resolutionOfH3Cell(res11)).toBe(cells.RESOLUTION.FINE);

    // ── Enforcement point 2 — the hierarchy relation refuses it rather than coercing it.
    expect(() => cells.coarseParentOf(res8)).toThrow(/not a fine-resolution H3 cell/u);

    // ── Enforcement point 3 — a foreign token is never assigned, so F33 stays
    // INDETERMINATE rather than becoming serviceable.
    expect(hierarchy.indexMap(spatialPayloadFor([res11])).resolve(res8).assigned).toBe(false);

    // ── Enforcement point 4 — a published map holding one is refused at publish by V-10 / A6.
    const findings = require("../../src/engine/config/validators").a6SpatialCellIdentity(spatialPayloadFor([res8]));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((row) => row.severity === "BLOCKING")).toBe(true);
  });

  /**
   * **There are exactly four enforcement points, and no fifth.**
   *
   * Wrapper predicates over the decode (`isFineCell`, `assertFineCell`) were written for
   * this model and then removed: they added a name at a call site and no behaviour, had
   * no production caller, and a guard that restates a check already made is a guard whose
   * absence nobody notices. This pins their absence so they cannot drift back in as dead
   * code, and pins that the decode they wrapped is exported and is the thing callers use.
   */
  test("the production resolution model is one decoder plus four enforcement points — no fifth layer", () => {
    expect(typeof cells.resolutionOfH3Cell).toBe("function");
    expect(cells.isFineCell).toBeUndefined();
    expect(cells.assertFineCell).toBeUndefined();
  });

  test("a res-8 cache key can never be HIT by a res-11 lookup — stale entries are orphans", () => {
    const cellPairCache = require("../../src/engine/routing/cellPairCache");
    const point = POINTS["rnsit-food-court"];
    const other = POINTS["rnsit-canara-bank"];
    const keyAt = (resolution) =>
      cellPairCache.key({
        originCell: h3.latLngToCell(point.lat, point.lon, resolution),
        destCell: h3.latLngToCell(other.lat, other.lon, resolution),
        profileKey: "profile-1",
        timeBucket: "bucket-1",
      });
    const old = keyAt(8);
    const now = keyAt(11);
    expect(old.ok).toBe(true);
    expect(now.ok).toBe(true);
    expect(old.key).not.toBe(now.key);
  });

  /**
   * §20.3 item 2 keys this cache on `(origin_cell, destination_cell, mobility_profile,
   * time_bucket)`. **All four, and each of them discriminating.** Asserting only that
   * each is *required* is not enough — a key that demands a component and then omits it
   * from the string passes that check and silently applies one profile's matrix under
   * another, which is the failure the key exists to prevent.
   */
  test("the routing cache key requires all four components AND every one of them changes it", () => {
    const cellPairCache = require("../../src/engine/routing/cellPairCache");
    const base = {
      originCell: h3.latLngToCell(POINTS["rnsit-food-court"].lat, POINTS["rnsit-food-court"].lon, FINE),
      destCell: h3.latLngToCell(POINTS["rnsit-canara-bank"].lat, POINTS["rnsit-canara-bank"].lon, FINE),
      profileKey: "profile-a",
      timeBucket: "bucket-a",
    };
    const baseKey = cellPairCache.key(base);
    expect(baseKey.ok).toBe(true);

    const different = {
      originCell: h3.latLngToCell(POINTS["rnsit-innovation-center"].lat, POINTS["rnsit-innovation-center"].lon, FINE),
      destCell: h3.latLngToCell(POINTS["rnsit-pre-university-college"].lat, POINTS["rnsit-pre-university-college"].lon, FINE),
      profileKey: "profile-b",
      timeBucket: "bucket-b",
    };

    for (const field of ["originCell", "destCell", "profileKey", "timeBucket"]) {
      // Required: omitting it is refused, not defaulted.
      const missing = cellPairCache.key({ ...base, [field]: undefined });
      expect({ field, ok: missing.ok }).toEqual({ field, ok: false });
      expect(missing.reason).toMatch(new RegExp(field, "u"));

      // Discriminating: changing it changes the key.
      const changed = cellPairCache.key({ ...base, [field]: different[field] });
      expect(changed.ok).toBe(true);
      expect({ field, distinct: changed.key !== baseKey.key }).toEqual({ field, distinct: true });
    }
  });

  // 13
  test("13. the spatial-model identity is deterministic", () => {
    const readings = Array.from({ length: 5 }, () => {
      jest.resetModules();
      return require("../../src/engine/spatial/cells").SPATIAL_MODEL;
    });
    for (const reading of readings) {
      expect(reading.id).toBe("H3-F11-C5");
      expect({ fine: reading.fine, coarse: reading.coarse }).toEqual({ fine: 11, coarse: 5 });
    }
    expect(new Set(readings.map((row) => JSON.stringify(row))).size).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   D7 — the declaration is its own external input, and attestation is reported
   ═══════════════════════════════════════════════════════════════════════════ */

describe("D7 — the delivery-domain declaration (S-3 row 29)", () => {
  test("an absent declaration is NOT_CONFIGURED, which is not a pass", () => {
    const verdict = deliveryDomain.validateDomainDeclaration(null);
    expect(verdict.status).toBe("NOT_CONFIGURED");
    expect(verdict.attested).toBe(false);
    expect(verdict.problems.join("\n")).toMatch(/S-3 row 29 is undeclared/u);
  });

  test("a geometrically valid but unsigned declaration is VALID and NOT attested", () => {
    const verdict = deliveryDomain.validateDomainDeclaration(declarationOf());
    expect(verdict.status).toBe("VALID");
    expect(verdict.attested).toBe(false);
    expect(verdict.problems.join("\n")).toMatch(/S-3 row 29 is NOT discharged/u);
    // It still produces verdicts — the geometry is real, and refusing to compute would
    // not make a signature appear.
    expect(deliveryDomain.evaluatePoint(verdict, POINTS["rnsit-food-court"].lat, POINTS["rnsit-food-court"].lon).verdict).toBe("INSIDE");
  });

  test("attestation requires a named owner, a date and the digest of the geometry signed", () => {
    const complete = declarationOf({
      declaration: { declaredBy: "Owner", declaredAt: "2026-09-14", geometryDigestSha256: BOUNDARY_SHA256 },
    });
    expect(deliveryDomain.validateDomainDeclaration(complete).attested).toBe(true);

    for (const missing of ["declaredBy", "declaredAt", "geometryDigestSha256"]) {
      const partial = { ...complete.declaration };
      delete partial[missing];
      expect(deliveryDomain.validateDomainDeclaration(declarationOf({ declaration: partial })).attested).toBe(false);
    }
  });

  test("the CRS is never assumed — an omitted one is a refusal, not an assumed EPSG:4326", () => {
    const noCrs = declarationOf();
    delete noCrs.crs;
    expect(deliveryDomain.validateDomainDeclaration(noCrs).status).toBe("INVALID");

    const projected = declarationOf({ crs: "EPSG:32643" });
    expect(deliveryDomain.validateDomainDeclaration(projected).status).toBe("INVALID");
  });

  /**
   * **V-5's axis-order check is a PROVABLE refusal, not a detector — and RNSIT is
   * exactly the case it cannot catch.** Recorded here as a standing residual rather than
   * asserted away.
   *
   * `regionBoundary.checkPosition` refuses a second element outside ±90°, because such a
   * value *cannot* be a latitude. RNSIT sits at lon 77.5, lat 12.9: transposed, the
   * second element becomes 77.5, which is a perfectly possible latitude. So a
   * `[lat, lon]` authoring error in **this** file is undetectable by construction, and
   * the module says so — *"where the ordering is genuinely ambiguous nothing is claimed,
   * because guessing would be inventing the region's location"*.
   *
   * The mitigation is not code. It is the D7 attestation: a human reads the declaration.
   */
  test("a transposed RNSIT file is NOT detected — the residual V-5 cannot close", () => {
    const transposed = declarationOf({
      boundary: { type: "Polygon", coordinates: [BOUNDARY.coordinates[0].map(([lon, lat]) => [lat, lon])] },
    });
    const verdict = deliveryDomain.validateDomainDeclaration(transposed);
    expect(verdict.status).toBe("VALID");
    // It is a valid geometry describing somewhere in Kazakhstan, and every RNSIT point
    // now reads OUTSIDE — which is fail-closed, and is the only reason this residual is
    // survivable.
    expect(deliveryDomain.evaluatePoint(verdict, POINTS["rnsit-food-court"].lat, POINTS["rnsit-food-court"].lon).verdict).toBe("OUTSIDE");
  });

  test("a transposed file whose second element exceeds ±90° IS refused", () => {
    // Proving the check is live, on a geometry where it can fire.
    const refusable = declarationOf({
      regionId: "fixture-transposed",
      boundary: { type: "Polygon", coordinates: [[[10, 100], [11, 100], [11, 101], [10, 101], [10, 100]]] },
    });
    const verdict = deliveryDomain.validateDomainDeclaration(refusable);
    expect(verdict.status).toBe("INVALID");
    expect(verdict.problems.join("\n")).toMatch(/not a latitude/u);
  });

  test("an INVALID declaration yields INDETERMINATE, not a permissive default", () => {
    const noCrs = declarationOf();
    delete noCrs.crs;
    const result = deliveryDomain.verdictFor(noCrs, POINTS["rnsit-food-court"].lat, POINTS["rnsit-food-court"].lon);
    expect(result.verdict).toBe("INDETERMINATE");
  });

  test("A7 refuses a malformed published declaration at publish, and warns on an unattested one", () => {
    const validators = require("../../src/engine/config/validators");
    expect(validators.a7DeliveryDomainDeclaration(null)).toEqual([]);

    const unattested = validators.a7DeliveryDomainDeclaration(declarationOf());
    expect(unattested.every((row) => row.severity === "WARNING")).toBe(true);
    expect(unattested.length).toBe(1);

    const noCrs = declarationOf();
    delete noCrs.crs;
    const malformed = validators.a7DeliveryDomainDeclaration(noCrs);
    expect(malformed.some((row) => row.severity === "BLOCKING")).toBe(true);
  });

  test("the declaration is a SIBLING of the cell assignments, not a member of them", () => {
    const service = require("../../src/engine/config/service");
    const snapshot = service.buildSnapshot({ spatial: spatialPayloadFor([]), deliveryDomain: declarationOf() });
    expect(snapshot.deliveryDomain).not.toBeNull();
    expect(snapshot.spatial.deliveryDomain).toBeUndefined();
    // And it survives the publish payload round-trip, so a replay reconstructs the same
    // geometry the verdict was taken against.
    const rebuilt = service.buildSnapshot({ deliveryDomain: snapshot.deliveryDomain });
    expect(rebuilt.deliveryDomain.version).toBe("way/1120154292");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Determinism, and the closed-set boundary reading
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the domain primitive is deterministic and exact", () => {
  test("every declared vertex of the boundary is INSIDE — the closed-set reading", () => {
    const domain = deliveryDomain.validateDomainDeclaration(declarationOf());
    for (const [lon, lat] of BOUNDARY.coordinates[0]) {
      expect(deliveryDomain.evaluatePoint(domain, lat, lon).verdict).toBe("INSIDE");
    }
  });

  /**
   * **The exactness limit, asserted rather than assumed away.**
   *
   * `isOnSegment` has no tolerance, so "on the boundary" means *exactly on it as a
   * double*. A computed edge midpoint generally is not: `(a + b) / 2` is not in general
   * collinear with `[a, b]` in floating point. Measured on this ring, 6 of 18 midpoints
   * are exactly collinear and 12 are not.
   *
   * This pins both halves: the exactly-collinear ones take the closed-set branch, and
   * **every** midpoint gets a stable answer. The property the round depends on is
   * determinism, and determinism holds for all 18. Adding an epsilon to make the other
   * 12 read INSIDE would widen the delivery domain by a distance no decision record
   * names, which is why it is not done.
   */
  test("an on-boundary point is exact-or-ray-cast, and is deterministic either way", () => {
    const domain = deliveryDomain.validateDomainDeclaration(declarationOf());
    const ring = BOUNDARY.coordinates[0];

    let exactlyCollinear = 0;
    for (let index = 0; index < ring.length - 1; index += 1) {
      const lon = (ring[index][0] + ring[index + 1][0]) / 2;
      const lat = (ring[index][1] + ring[index + 1][1]) / 2;
      const mid = [lon, lat];

      if (deliveryDomain.isOnRing(mid, ring)) {
        exactlyCollinear += 1;
        expect(deliveryDomain.evaluatePoint(domain, lat, lon).verdict).toBe("INSIDE");
      }

      // Stable regardless of which branch decided it, and never INDETERMINATE: the
      // coordinate is readable and the declaration is valid, so a verdict is owed.
      const runs = new Set(Array.from({ length: 8 }, () => deliveryDomain.evaluatePoint(domain, lat, lon).verdict));
      expect(runs.size).toBe(1);
      expect([...runs][0]).not.toBe("INDETERMINATE");
    }
    expect(exactlyCollinear).toBe(6);
  });

  test("the same point and declaration give a byte-identical result every time", () => {
    const domain = deliveryDomain.validateDomainDeclaration(declarationOf());
    const point = POINTS["rnsit-food-court"];
    const runs = Array.from({ length: 20 }, () => JSON.stringify(deliveryDomain.evaluatePoint(domain, point.lat, point.lon)));
    expect(new Set(runs).size).toBe(1);
  });

  test("a hole in the geometry is excluded, and the hole's own edge is still the domain boundary", () => {
    // A synthetic square with a square hole — the adopted RNSIT boundary has no hole, and
    // a hole case must still be correct because a declaration may carry one.
    const withHole = declarationOf({
      regionId: "fixture-hole",
      boundary: {
        type: "Polygon",
        coordinates: [
          [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
          [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6], [0.4, 0.4]],
        ],
      },
    });
    const domain = deliveryDomain.validateDomainDeclaration(withHole);
    expect(deliveryDomain.evaluatePoint(domain, 0.2, 0.2).verdict).toBe("INSIDE");
    expect(deliveryDomain.evaluatePoint(domain, 0.5, 0.5).verdict).toBe("OUTSIDE");
    expect(deliveryDomain.evaluatePoint(domain, 0.4, 0.5).verdict).toBe("INSIDE");
    expect(deliveryDomain.evaluatePoint(domain, 2, 2).verdict).toBe("OUTSIDE");
  });

  test("the verdict is independent of the spatial model — it is a coordinate against a polygon", () => {
    const domain = deliveryDomain.validateDomainDeclaration(declarationOf());
    const point = POINTS["rnsit-food-court"];
    const result = deliveryDomain.evaluatePoint(domain, point.lat, point.lon);
    // The model is *attributed* on the verdict for provenance, and no cell appears in
    // the computation at all.
    expect(result.spatialModel).toBe(cells.SPATIAL_MODEL.id);
    expect(result.domainVersion).toBe("way/1120154292");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §23.7 — privacy is not widened
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§23.7 — geofenceResult is an already-declared derived quantity", () => {
  test("the six derived quantities are exactly §23.7's six, and geofenceResult is one of them", () => {
    const surrogateKeys = require("../../src/engine/privacy/surrogateKeys");
    expect([...surrogateKeys.DERIVED_QUANTITIES].sort()).toEqual(
      ["accessWindowClass", "fineCell", "geofenceResult", "routingNodeId", "serviceTimeCohort", "zoneId"].sort(),
    );
    // Six, not seven. Pinning a verdict into an existing column adds no exemption, and a
    // later spatial field cannot be slipped in beside it.
    expect(surrogateKeys.DERIVED_QUANTITIES.length).toBe(6);
  });
});

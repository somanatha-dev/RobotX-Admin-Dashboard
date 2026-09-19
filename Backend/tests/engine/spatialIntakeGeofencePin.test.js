"use strict";

/**
 * **The intake producer — where the D1 geofence verdict is taken and pinned.**
 *
 * `task.service.sealIdentities` is the one place a delivery-domain verdict is computed
 * (`RD-2026-09-14-01` D1, and F33's own frozen rationale: *"also a hard input-validation
 * rule at intake"*). These tests exist because the mutation sweep proved they had to:
 * mutants that made intake write **no** verdict, and that derived the verdict from the
 * **cell centre** instead of the coordinate, both survived a suite that covered every
 * other part of D1. A producer nobody tests is a producer that can silently stop.
 */

const fs = require("fs");
const path = require("path");
const h3 = require("h3-js");

const taskService = require("../../src/services/task.service");
const deliveryDomain = require("../../src/engine/spatial/deliveryDomain");
const cells = require("../../src/engine/spatial/cells");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const FINE = cells.H3_RESOLUTION.FINE;

const BOUNDARY = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "rnsit-campus-osm.geojson")))
  .features.find((row) => row.id === "way/1120154292").geometry;

const DECLARATION = {
  regionId: "rnsit-campus",
  name: "RNSIT Campus",
  kind: "CAMPUS",
  crs: "EPSG:4326",
  version: "way/1120154292",
  versionDate: "2026-08-30",
  boundary: BOUNDARY,
};
const DOMAIN = deliveryDomain.validateDomainDeclaration(DECLARATION);

const PRIVACY_KEYS = { secret: "test-secret-value", encryptionKey: Buffer.alloc(32, 7) };

/** An in-memory Prisma double, recording exactly what the seal writes. */
function prismaDouble() {
  const stopUpdates = [];
  return {
    stopUpdates,
    identityRecord: {
      findUnique: async () => null,
      create: async () => ({}),
      update: async () => ({}),
    },
    stop: {
      update: async (args) => {
        stopUpdates.push(args);
        return {};
      },
    },
    task: { update: async () => ({}) },
  };
}

async function seal(stops, deliveryDomainPayload) {
  const prisma = prismaDouble();
  const result = await taskService.sealIdentities(prisma, {
    task: { id: "task-row-1", taskId: "task-1" },
    work: { stops },
    privacyKeys: PRIVACY_KEYS,
    deliveryDomain: deliveryDomainPayload,
  });
  return { prisma, result };
}

const stopAt = (id, point) => ({ id, stopId: id, label: `label-${id}`, lat: point.lat, lon: point.lon });

/**
 * A point that is **inside the campus** but whose fine cell's **centre is outside** it.
 * Found from the real geometry, not assumed: these are exactly the cells D6 admits to the
 * index and refuses to treat as a domain claim. This is the fixture that tells a
 * coordinate test apart from a cell-centre test.
 */
const INSIDE_BUT_CELL_CENTRE_OUTSIDE = (() => {
  const centreCover = new Set(h3.polygonToCells(BOUNDARY.coordinates, FINE, true));
  const indexCover = h3.polygonToCellsExperimental(
    BOUNDARY.coordinates, FINE, h3.POLYGON_TO_CELLS_FLAGS.containmentOverlapping, true,
  );
  for (const cellId of indexCover) {
    if (centreCover.has(cellId)) continue;
    for (const [lat, lon] of h3.cellToBoundary(cellId)) {
      if (deliveryDomain.evaluatePoint(DOMAIN, lat, lon).verdict !== "INSIDE") continue;
      if (h3.latLngToCell(lat, lon, FINE) !== cellId) continue;
      const [cLat, cLon] = h3.cellToLatLng(cellId);
      if (deliveryDomain.evaluatePoint(DOMAIN, cLat, cLon).verdict !== "OUTSIDE") continue;
      return { point: { lat, lon }, cellId };
    }
  }
  return null;
})();

const POINTS = (() => {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "rnsit-campus-supplemental.geojson")));
  const byId = {};
  for (const feature of raw.features) {
    const [lon, lat] = feature.geometry.coordinates;
    byId[feature.properties.id] = { lat, lon };
  }
  return byId;
})();

describe("intake pins the delivery-domain verdict (D1)", () => {
  test("a stop inside the campus is sealed with geofenceResult = INSIDE", async () => {
    const { prisma, result } = await seal([stopAt("s1", POINTS["rnsit-food-court"])], DECLARATION);
    expect(prisma.stopUpdates).toHaveLength(1);
    expect(prisma.stopUpdates[0].data.geofenceResult).toBe("INSIDE");
    expect(result.geofence).toEqual({ INSIDE: 1 });
  });

  test("a stop outside the campus is sealed with geofenceResult = OUTSIDE", async () => {
    const { prisma } = await seal([stopAt("s1", POINTS["rnsit-parking-lot"])], DECLARATION);
    expect(prisma.stopUpdates[0].data.geofenceResult).toBe("OUTSIDE");
  });

  /**
   * **The column is written even when nothing can be decided.** An absent column and a
   * recorded "no declaration was published when this was sealed" are different facts, and
   * only the second is auditable. Both deny.
   */
  test("with NO published declaration the verdict is recorded as INDETERMINATE, not left null", async () => {
    const { prisma } = await seal([stopAt("s1", POINTS["rnsit-food-court"])], null);
    expect(prisma.stopUpdates[0].data.geofenceResult).toBe("INDETERMINATE");
    expect(deliveryDomain.pinnedMembership(prisma.stopUpdates[0].data.geofenceResult)).toBeUndefined();
  });

  test("the verdict IS written — a seal that pins nothing leaves the round undecidable", async () => {
    const { prisma } = await seal([stopAt("s1", POINTS["rnsit-food-court"])], DECLARATION);
    expect(Object.keys(prisma.stopUpdates[0].data)).toContain("geofenceResult");
    expect(prisma.stopUpdates[0].data.geofenceResult).not.toBeNull();
    expect(prisma.stopUpdates[0].data.geofenceResult).not.toBeUndefined();
  });

  /**
   * **The verdict is taken on the COORDINATE, never on the cell.** This is the whole of
   * D1 layer 2, and it is the assertion a cell-centre implementation fails: the fixture
   * point is inside the campus while its own fine cell's centre is outside, so a
   * cell-derived verdict says OUTSIDE and a coordinate verdict says INSIDE.
   */
  test("the verdict comes from the exact coordinate, not from the fine cell's centre", async () => {
    expect(INSIDE_BUT_CELL_CENTRE_OUTSIDE).not.toBeNull();
    const { point, cellId } = INSIDE_BUT_CELL_CENTRE_OUTSIDE;

    // The premise, asserted so the test cannot quietly stop discriminating.
    const [centreLat, centreLon] = h3.cellToLatLng(cellId);
    expect(deliveryDomain.evaluatePoint(DOMAIN, point.lat, point.lon).verdict).toBe("INSIDE");
    expect(deliveryDomain.evaluatePoint(DOMAIN, centreLat, centreLon).verdict).toBe("OUTSIDE");

    const { prisma } = await seal([stopAt("s1", point)], DECLARATION);
    expect(prisma.stopUpdates[0].data.geofenceResult).toBe("INSIDE");
    // And the cell is still written, at its own resolution — the two layers coexist.
    expect(prisma.stopUpdates[0].data.fineCell).toBe(cellId);
    expect(cells.resolutionOfH3Cell(prisma.stopUpdates[0].data.fineCell)).toBe(cells.RESOLUTION.FINE);
  });

  test("a stop with no usable coordinate is sealed INDETERMINATE and gets no fine cell", async () => {
    const { prisma } = await seal([{ id: "s1", stopId: "s1", label: "somewhere", lat: null, lon: null }], DECLARATION);
    expect(prisma.stopUpdates[0].data.geofenceResult).toBe("INDETERMINATE");
    expect(prisma.stopUpdates[0].data.fineCell).toBeUndefined();
  });

  test("a declaration that does not validate yields INDETERMINATE, never a permissive default", async () => {
    const noCrs = { ...DECLARATION };
    delete noCrs.crs;
    const { prisma } = await seal([stopAt("s1", POINTS["rnsit-food-court"])], noCrs);
    expect(prisma.stopUpdates[0].data.geofenceResult).toBe("INDETERMINATE");
  });

  test("every stop of a multi-stop submission is judged independently", async () => {
    const { prisma, result } = await seal(
      [stopAt("s1", POINTS["rnsit-food-court"]), stopAt("s2", POINTS["rnsit-parking-lot"])],
      DECLARATION,
    );
    expect(prisma.stopUpdates.map((row) => row.data.geofenceResult)).toEqual(["INSIDE", "OUTSIDE"]);
    expect(result.geofence).toEqual({ INSIDE: 1, OUTSIDE: 1 });
  });

  test("sealing is deterministic — the same submission pins the same verdicts every time", async () => {
    const runs = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { prisma } = await seal([stopAt("s1", POINTS["rnsit-food-court"]), stopAt("s2", POINTS["rnsit-main-gate"])], DECLARATION);
      runs.push(prisma.stopUpdates.map((row) => row.data.geofenceResult).join(","));
    }
    expect(new Set(runs).size).toBe(1);
    expect(runs[0]).toBe("INSIDE,OUTSIDE");
  });
});

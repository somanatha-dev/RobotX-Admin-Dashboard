"use strict";

/**
 * `GET /api/dtaro/zones` — the published zone view (unit level; Prisma is a recording stand-in).
 *
 * The geometry must be exactly the published cell assignment: no bounding box, no proposal, no
 * cell the map does not assign; zones keyed by region AND zone id. The map is served whether or
 * not obstacle alerts are on — the alert switch is reported, it does not hide the map.
 */

const h3 = require("h3-js");
const { publishedZoneView } = require("../../../src/services/dtaroZoneView.service");

const A = { lat: 12.9023, lon: 77.5186 };
const B = { lat: 12.9027, lon: 77.505 };
const disk = (p, k) => h3.gridDisk(h3.latLngToCell(p.lat, p.lon, 11), k);

const CELLS_A = disk(A, 2); // 19 cells
const CELLS_B = disk(B, 1); // 7 cells
const STRAY = h3.latLngToCell(12.95, 77.6, 11);

function snapshot() {
  return {
    version: 7,
    spatial: {
      version: 3,
      regions: [{ id: "row-A" }, { id: "row-B" }],
      zones: [{ id: "z1", regionId: "row-A" }],
      cells: [
        ...CELLS_A.map((cellId) => ({ cellId, resolution: "FINE", regionId: "row-A", zoneId: "z1" })),
        // Region B reuses the label "z1"; each cell names its own region.
        ...CELLS_B.map((cellId) => ({ cellId, resolution: "FINE", regionId: "row-B", zoneId: "z1" })),
        { cellId: STRAY, resolution: "FINE", regionId: null, zoneId: null },
      ],
      coarseCells: [{ cellId: h3.latLngToCell(A.lat, A.lon, 5), resolution: "COARSE", regionId: "row-A" }],
    },
  };
}

function recordingPrisma() {
  const calls = [];
  const model = (name, rows) => ({
    findMany: jest.fn(async (args) => {
      calls.push({ name, method: "findMany", args });
      return rows.filter((r) => args.where.id.in.includes(r.id));
    }),
  });
  return {
    calls,
    region: model("region", [
      { id: "row-A", regionId: "rnsit", name: "RNSIT" },
      { id: "row-B", regionId: "synthetic-b", name: "Synthetic B" },
    ]),
    zone: model("zone", [{ id: "z1", name: "Zone 1" }]),
  };
}

function cellsCoveredBy(geometry) {
  const covered = new Set();
  for (const polygon of geometry.coordinates) {
    for (const cellId of h3.polygonToCells(polygon, 11, true)) covered.add(cellId);
  }
  return covered;
}

describe("publishedZoneView", () => {
  test("alerts off: the same published map is served, flagged alertsEnabled: false, still read-only", async () => {
    const prisma = recordingPrisma();
    const off = await publishedZoneView({ snapshot: snapshot(), prisma, alertsEnabled: false });
    const on = await publishedZoneView({ snapshot: snapshot(), prisma: recordingPrisma(), alertsEnabled: true });
    expect(off).toMatchObject({ available: true, alertsEnabled: false, source: "PUBLISHED_MAP" });
    expect(on.alertsEnabled).toBe(true);
    // The switch changes only the flag: identical zones and geometry either way.
    expect(off.zones).toEqual(on.zones);
    expect(off.zones).toHaveLength(2);
    expect(prisma.calls.map((c) => `${c.name}.${c.method}`)).toEqual(["region.findMany", "zone.findMany"]);
    // Anything but a literal true is off.
    expect((await publishedZoneView({ snapshot: snapshot(), prisma: recordingPrisma() })).alertsEnabled).toBe(false);
    expect((await publishedZoneView({ snapshot: snapshot(), prisma: recordingPrisma(), alertsEnabled: "true" })).alertsEnabled).toBe(false);
  });

  test("no published map: unavailable, stated, nothing invented", async () => {
    expect(await publishedZoneView({ snapshot: null, prisma: recordingPrisma(), alertsEnabled: true })).toEqual({
      available: false,
      alertsEnabled: true,
      reason: "SPATIAL_AUTHORITY_UNAVAILABLE",
      regions: [],
      zones: [],
    });
  });

  test("one zone per (region, zone); the same label in two regions stays two zones", async () => {
    const view = await publishedZoneView({ snapshot: snapshot(), prisma: recordingPrisma(), alertsEnabled: true });
    expect(view).toMatchObject({ alertsEnabled: true, available: true, source: "PUBLISHED_MAP", configVersion: 7, spatialVersion: 3, cellsWithoutZone: 1 });
    expect(view.zones.map((z) => [z.key, z.regionKey, z.zoneId, z.name, z.cellCount])).toEqual([
      ["row-A/z1", "rnsit", "z1", "Zone 1", 19],
      ["row-B/z1", "synthetic-b", "z1", "Zone 1", 7],
    ]);
    expect(view.regions).toEqual([
      { id: "row-A", regionKey: "rnsit", name: "RNSIT" },
      { id: "row-B", regionKey: "synthetic-b", name: "Synthetic B" },
    ]);
  });

  test("each zone's outline covers exactly its published cells — no more, no fewer", async () => {
    const view = await publishedZoneView({ snapshot: snapshot(), prisma: recordingPrisma(), alertsEnabled: true });
    const a = view.zones.find((z) => z.key === "row-A/z1");
    expect(a.geometry.type).toBe("MultiPolygon");
    expect([...cellsCoveredBy(a.geometry)].sort()).toEqual([...CELLS_A].sort());
    const b = view.zones.find((z) => z.key === "row-B/z1");
    expect([...cellsCoveredBy(b.geometry)].sort()).toEqual([...CELLS_B].sort());
    // GeoJSON order: [lon, lat].
    const [lon, lat] = a.geometry.coordinates[0][0][0];
    expect(lon).toBeGreaterThan(77);
    expect(lat).toBeLessThan(13);
  });

  test("it only reads: two findMany calls, no write of any kind", async () => {
    const prisma = recordingPrisma();
    await publishedZoneView({ snapshot: snapshot(), prisma, alertsEnabled: true });
    expect(prisma.calls.map((c) => `${c.name}.${c.method}`)).toEqual(["region.findMany", "zone.findMany"]);
  });

  test("a failed name lookup costs only the names", async () => {
    const prisma = { region: { findMany: async () => { throw new Error("db down"); } }, zone: { findMany: async () => { throw new Error("db down"); } } };
    const view = await publishedZoneView({ snapshot: snapshot(), prisma, alertsEnabled: true });
    expect(view.zones.map((z) => [z.key, z.regionKey, z.name])).toEqual([
      ["row-A/z1", null, null],
      ["row-B/z1", null, null],
    ]);
  });
});

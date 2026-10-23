"use strict";

/**
 * G4 publication rehearsal tool — the parts that decide what is published and where.
 *
 *   · the candidate is the pinned map with ONLY the RNSIT cover's zones changed;
 *   · the Zone-row reference check that `configService.publish` does not make (F27 needs it);
 *   · the disposable-target guard refuses before any query unless the server's own data
 *     directory is the throwaway cluster under the temp directory;
 *   · the offline audit, and the rehearsal scenario's obstacles.
 */

const os = require("os");
const path = require("path");
const h3 = require("h3-js");

const tool = require("../../../tools/demo/dtaro/rehearseG4Publication");
const zoneMap = require("../../../tools/campus/rnsitZoneMap");
const { parseScenario } = require("../../../src/simulation/dtaroScenario");

let validated;
beforeAll(() => {
  validated = tool.loadValidated();
}, 300_000);

const RNSIT = "row-rnsit";
const OTHER = "row-other";
/** Today's one-zone map plus an unrelated region, as a pinned version would hold it. */
function pinnedMap(cover) {
  const other = h3.gridDisk(h3.latLngToCell(12.9027, 77.505, 11), 1);
  const base = zoneMap.currentSpatialMap(cover, { regionId: RNSIT });
  return {
    version: 1,
    ...base,
    regions: [...base.regions, { id: OTHER }],
    zones: [...base.zones, { id: "other-z1", regionId: OTHER }],
    sites: [],
    cells: [...base.cells, ...other.map((cellId) => ({ cellId, resolution: "FINE", regionId: OTHER, zoneId: "other-z1" }))],
  };
}

test("the validated proposal: digest, stage, four zones, 64 cells", () => {
  const { proposal, digest } = validated;
  expect(digest).toBe(tool.VALIDATED_DIGEST);
  expect(proposal.zones.map((z) => z.id)).toEqual(tool.G4_ZONE_IDS);
  expect(proposal.cells).toHaveLength(64);
  expect(proposal.cells.every((r) => tool.G4_ZONE_IDS.includes(r.zoneId))).toBe(true);
});

test("candidate: the pinned map with only the RNSIT cover reassigned; other regions untouched", () => {
  const { proposal, context } = validated;
  const pinned = pinnedMap(context.cover);
  const g4map = tool.g4SpatialFrom(pinned, { proposal, rnsitRowId: RNSIT });
  const diff = tool.spatialDiff(pinned, g4map);
  expect(diff).toMatchObject({ cellsWithNewZone: 64, cellsOtherwiseChanged: 0, regionsIdentical: true, sitesIdentical: true });
  expect(diff.cellsAfter).toBe(diff.cellsBefore);
  expect(g4map.zones.map((z) => z.id)).toEqual(["other-z1", ...tool.G4_ZONE_IDS]);
  expect(g4map.cells.filter((c) => c.regionId === OTHER)).toEqual(pinned.cells.filter((c) => c.regionId === OTHER));
  expect(tool.engineFindings(g4map)).toEqual([]);
  // Alert delivery resolves every cover cell to its G4 zone.
  const resolved = tool.resolveCover({ spatial: g4map }, context.cover);
  expect(proposal.cells.every((r) => resolved.get(r.cellId) === r.zoneId)).toBe(true);
});

test("candidate refused when the pinned RNSIT cells are not exactly the cover", () => {
  const { proposal, context } = validated;
  const pinned = pinnedMap(context.cover);
  const short = { ...pinned, cells: pinned.cells.filter((c) => c.cellId !== context.cover[0]) };
  expect(() => tool.g4SpatialFrom(short, { proposal, rnsitRowId: RNSIT })).toThrow(tool.RehearsalRefused);
  expect(() => tool.g4SpatialFrom(null, { proposal, rnsitRowId: RNSIT })).toThrow(/no spatial map/);
});

test("Zone-row references: missing, wrong region, unknown cell zone — and the engine validators accept all three", () => {
  const { proposal, context } = validated;
  const g4map = tool.g4SpatialFrom(pinnedMap(context.cover), { proposal, rnsitRowId: RNSIT });
  const rows = [{ id: "other-z1", regionId: OTHER }, ...tool.zoneRowPlan(proposal, RNSIT)];
  expect(tool.zoneRowFindings(g4map, rows)).toEqual([]);
  // Before the four rows exist: one finding per G4 zone (what F27 would refuse).
  expect(tool.zoneRowFindings(g4map, rows.slice(0, 1))).toHaveLength(4);
  const moved = rows.map((r) => (r.id === "rnsit-z-west" ? { ...r, regionId: OTHER } : r));
  expect(tool.zoneRowFindings(g4map, moved)).toEqual([expect.stringMatching(/rnsit-z-west.*region row-other/)]);
  const unknown = { ...g4map, cells: g4map.cells.map((c, i) => (i === 0 ? { ...c, zoneId: "rnsit-z-nowhere" } : c)) };
  expect(tool.zoneRowFindings(unknown, rows)).toEqual([expect.stringMatching(/rnsit-z-nowhere/)]);
  // The gap the preflight closes: publish-time validation accepts a zone with no Zone row.
  const listedNoRow = { ...g4map, zones: [...g4map.zones, { id: "rnsit-z-norow", regionId: RNSIT }] };
  expect(tool.engineFindings(listedNoRow)).toEqual([]);
  expect(tool.zoneRowFindings(listedNoRow, rows)).toEqual([expect.stringMatching(/no Zone row "rnsit-z-norow"/)]);
});

test("Zone rows: the four G4 zones, degenerate boxes (the legacy box lookup never matches them)", () => {
  const plan = tool.zoneRowPlan(validated.proposal, RNSIT);
  expect(plan.map((r) => r.id)).toEqual(tool.G4_ZONE_IDS);
  for (const row of plan) expect(row).toMatchObject({ regionId: RNSIT, minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 });
  expect(new Set(plan.map((r) => r.name)).size).toBe(4);
});

describe("disposable-target guard", () => {
  const tmpDir = path.join(os.tmpdir(), "robotx-g4-test", "pgdata");
  const fakePrisma = (dataDirectory) => {
    const calls = [];
    return {
      calls,
      $queryRawUnsafe: async (q) => {
        calls.push(q);
        if (/data_directory/.test(q)) return [{ data_directory: dataDirectory }];
        return [{ current_database: "robotx_g4_rehearsal" }];
      },
    };
  };

  test.each([
    ["Neon", "postgresql://u@ep-x.neon.tech/db"],
    ["default port", "postgresql://u@127.0.0.1:5432/db"],
    ["no port", "postgresql://u@127.0.0.1/db"],
  ])("refuses %s before any query", async (_name, url) => {
    const prisma = fakePrisma(tmpDir);
    await expect(tool.verifyDisposable(prisma, { url, expectDataDirectory: tmpDir })).rejects.toThrow();
    expect(prisma.calls).toEqual([]);
  });

  test("refuses a data directory outside the temp directory, before any query", async () => {
    const prisma = fakePrisma("C:/Program Files/PostgreSQL/18/data");
    await expect(tool.verifyDisposable(prisma, { url: "postgresql://u@127.0.0.1:55474/db", expectDataDirectory: "C:/Program Files/PostgreSQL/18/data" })).rejects.toThrow(/not under the temp directory/);
    expect(prisma.calls).toEqual([]);
  });

  test("refuses when the server's own data directory is another cluster's", async () => {
    const prisma = fakePrisma(path.join(os.tmpdir(), "some-other-cluster"));
    await expect(tool.verifyDisposable(prisma, { url: "postgresql://u@127.0.0.1:55474/db", expectDataDirectory: tmpDir })).rejects.toThrow(/not the throwaway cluster/);
  });

  test("accepts the throwaway cluster it was told about", async () => {
    const prisma = fakePrisma(tmpDir);
    await expect(tool.verifyDisposable(prisma, { url: "postgresql://u@127.0.0.1:55474/db", expectDataDirectory: tmpDir })).resolves.toEqual({ dataDirectory: tmpDir, database: "robotx_g4_rehearsal" });
  });

  test("requires the expected data directory", async () => {
    await expect(tool.verifyDisposable(fakePrisma(tmpDir), { url: "postgresql://u@127.0.0.1:55474/db" })).rejects.toThrow(/--expect-data-directory is required/);
  });
});

test("offline audit: every check passes; limitations are stated, not hidden", () => {
  const result = tool.audit();
  expect(result.passed).toBe(true);
  const status = Object.fromEntries(result.checks.map((c) => [c.id, c.status]));
  expect(status).toMatchObject({
    ASSIGNMENT_64_EXACTLY_ONE_ZONE: "PASS",
    ENGINE_VALIDATORS_CANDIDATE_MAP: "PASS",
    ALERT_PATH_RESOLVES_G4: "PASS",
    PREVIEW_AGREES: "PASS",
    PREVIEW_READ_ONLY: "PASS",
    G4_REGION_ISOLATION: "PASS",
    G4_ACCESS_POINTS_JOIN_OWN_ZONE: "PASS",
    SIM_ROUTES_CONTAINED: "LIMITATION",
    LOW_CONFIDENCE_DECISIONS: "LIMITATION",
  });
  expect(result.counts).toEqual({ "rnsit-z-west": 15, "rnsit-z-east": 17, "rnsit-z-south": 14, "rnsit-z-southwest": 18 });
}, 300_000);

test("rehearsal scenario: valid, three obstacles per G4 zone, each inside the boundary in its stated zone", () => {
  const raw = require("../../../tools/demo/dtaro/rnsit-dtaro-g4-scenario.json");
  expect(parseScenario(raw).ok).toBe(true);
  const { proposal, context } = validated;
  const zoneOf = new Map(proposal.cells.map((r) => [r.cellId, r.zoneId]));
  const perZone = {};
  for (const o of raw.obstacles) {
    const cellId = h3.latLngToCell(o.lat, o.lon, 11);
    expect(cellId).toBe(o.cellId);
    expect(zoneOf.get(cellId)).toBe(o.zone);
    expect(context.containment.containsPoint({ lat: o.lat, lon: o.lon })).toBe(true);
    expect(o.metresFromNearestRoute).toBeGreaterThan(raw.senseRadiusM * 2);
    perZone[o.zone] = (perZone[o.zone] || 0) + 1;
  }
  expect(perZone).toEqual({ "rnsit-z-west": 3, "rnsit-z-east": 3, "rnsit-z-south": 3, "rnsit-z-southwest": 3 });
});

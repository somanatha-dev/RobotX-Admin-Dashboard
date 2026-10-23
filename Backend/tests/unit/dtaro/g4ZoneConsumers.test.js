"use strict";

/**
 * Who reads a zone id, and what each one does once G4 is pinned (pre-publication audit,
 * 2026-10-23). Each test pins one row of the call-site inventory in G4_PUBLICATION_SAFETY_MEMO.md:
 *
 *   · the legacy bounding-box lookup keeps answering `rnsit-z1` — G4 rows have degenerate boxes;
 *   · route zone facts come from the PUBLISHED map, and F27 authorises them only through `Zone`
 *     rows: with G4 pinned and the rows missing, F27 refuses; with the rows, it is satisfied;
 *   · F30 declares no restriction for any zone, so G4 ids change nothing there;
 *   · the zone-priced cost term is off (kill switch thrown by default);
 *   · the publish path refuses a map whose Zone rows are missing — before publishing or pinning.
 */

jest.mock("../../../src/db/prisma", () => ({ getPrisma: jest.fn() }));

const h3 = require("h3-js");
const { getPrisma } = require("../../../src/db/prisma");
const zoneManager = require("../../../src/services/zoneManager.service");
const hierarchy = require("../../../src/engine/spatial/hierarchy");
const f27 = require("../../../src/engine/feasibility/predicates/f27");
const profile = require("../../../src/services/v1DemonstrationProfile");
const killSwitches = require("../../../src/engine/config/killSwitches");
const configService = require("../../../src/engine/config/service");
const configController = require("../../../src/controllers/config.controller");
const { zoneReferenceFindings, checkSpatialZoneReferences } = require("../../../src/services/spatialZoneReferences");
const tool = require("../../../tools/demo/dtaro/rehearseG4Publication");
const zoneMap = require("../../../tools/campus/rnsitZoneMap");
const bootstrap = require("../../../tools/deploy/bootstrapV1Environment");

const RNSIT = "row-rnsit";
let validated;
let g4map;
let boundaryBox;
beforeAll(() => {
  validated = tool.loadValidated();
  g4map = tool.g4SpatialFrom({ version: 1, ...zoneMap.currentSpatialMap(validated.context.cover, { regionId: RNSIT }) }, { proposal: validated.proposal, rnsitRowId: RNSIT });
  const ring = bootstrap.intendedWorld().declaration.boundary.coordinates[0];
  boundaryBox = {
    minLat: Math.min(...ring.map((p) => p[1])),
    maxLat: Math.max(...ring.map((p) => p[1])),
    minLon: Math.min(...ring.map((p) => p[0])),
    maxLon: Math.max(...ring.map((p) => p[0])),
  };
}, 300_000);

const legacyRow = () => ({ id: "rnsit-z1", name: "RNSIT Z1", regionId: RNSIT, ...boundaryBox });
const g4Rows = () => tool.zoneRowPlan(validated.proposal, RNSIT);
/** A prisma whose zone.findMany answers like PostgreSQL would (`orderBy: { name: "asc" }` / `where: { id: { in } }`). */
function prismaWith(rows) {
  return {
    zone: {
      findMany: jest.fn(async (args = {}) => {
        let out = [...rows];
        if (args.where && args.where.id && args.where.id.in) out = out.filter((r) => args.where.id.in.includes(r.id));
        if (args.where && args.where.regionId) out = out.filter((r) => r.regionId === args.where.regionId);
        if (args.orderBy && args.orderBy.name === "asc") out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return out.map((r) => (args.select ? Object.fromEntries(Object.keys(args.select).map((k) => [k, r[k]])) : r));
      }),
    },
  };
}
const centres = () => validated.context.cover.map((c) => h3.cellToLatLng(c)).filter(([lat, lon]) => lat >= boundaryBox.minLat && lat <= boundaryBox.maxLat && lon >= boundaryBox.minLon && lon <= boundaryBox.maxLon);

describe("legacy bounding-box zone (zoneManager.getZoneForCoordinates — telemetry, AUTH, legacy obstacle path)", () => {
  afterEach(() => zoneManager.invalidateZoneCache(null));

  test("with G4's degenerate rows beside rnsit-z1, every in-box cover point still answers rnsit-z1", async () => {
    const prisma = prismaWith([legacyRow(), ...g4Rows()]);
    const answers = new Set();
    for (const [lat, lon] of centres()) answers.add((await zoneManager.getZoneForCoordinates(prisma, null, lat, lon))?.id || null);
    expect([...answers]).toEqual(["rnsit-z1"]);
    expect(centres().length).toBeGreaterThan(40);
  });

  test("counterexample: G4 rows WITH real boxes would change the legacy answer (first box by name wins)", async () => {
    const boxed = g4Rows().map((row) => {
      const cellsOf = validated.proposal.cells.filter((c) => c.zoneId === row.id).map((c) => h3.cellToLatLng(c.cellId));
      return { ...row, minLat: Math.min(...cellsOf.map((p) => p[0])), maxLat: Math.max(...cellsOf.map((p) => p[0])), minLon: Math.min(...cellsOf.map((p) => p[1])), maxLon: Math.max(...cellsOf.map((p) => p[1])) };
    });
    const prisma = prismaWith([legacyRow(), ...boxed]);
    const answers = new Set();
    for (const [lat, lon] of centres()) answers.add((await zoneManager.getZoneForCoordinates(prisma, null, lat, lon))?.id || null);
    expect([...answers].some((id) => tool.G4_ZONE_IDS.includes(id))).toBe(true);
  });
});

describe("route zone facts and F27 (engine path, unchanged code)", () => {
  // As v1DemonstrationComposition.routeDescriptorFor builds them: the zones of the agent's cell and
  // of each stop's cell, resolved through the PUBLISHED map.
  const traversed = (cells) => {
    const index = hierarchy.indexMap(g4map);
    return [...new Set(cells.map((c) => index.resolve(c).zoneId))].sort();
  };
  const westCell = () => validated.proposal.cells.find((c) => c.zoneId === "rnsit-z-west").cellId;
  const eastCell = () => validated.proposal.cells.find((c) => c.zoneId === "rnsit-z-east").cellId;

  test("the published G4 map resolves every cover cell to its G4 zone (no rnsit-z1)", () => {
    const index = hierarchy.indexMap(g4map);
    for (const row of validated.proposal.cells) expect(index.resolve(row.cellId).zoneId).toBe(row.zoneId);
  });

  test("G4 pinned without its Zone rows: F27 is VIOLATED for a West→East route", () => {
    const verdict = f27.evaluate({ agentSnapshot: { authorisedZoneIds: ["rnsit-z1"] }, plan: { route: { zonesTraversed: traversed([westCell(), eastCell()]) } } });
    expect(verdict.outcome).toBe("VIOLATED");
    expect(verdict.observed.unauthorisedZones).toEqual(["rnsit-z-east", "rnsit-z-west"]);
  });

  test("with the four Zone rows (F27's authorised set is every Zone row of the region): SATISFIED", async () => {
    const prisma = prismaWith([legacyRow(), ...g4Rows()]);
    const authorisedZoneIds = (await prisma.zone.findMany({ where: { regionId: RNSIT }, select: { id: true } })).map((z) => z.id).sort();
    const verdict = f27.evaluate({ agentSnapshot: { authorisedZoneIds }, plan: { route: { zonesTraversed: traversed([westCell(), eastCell()]) } } });
    expect(verdict.outcome).toBe("SATISFIED");
  });

  test("F30: the V1 profile declares no restriction for any G4 zone", () => {
    for (const id of tool.G4_ZONE_IDS) expect(profile.zoneRestrictionsFor(id)).toEqual([]);
  });

  test("zone-priced cost (V_terminal / λ_zone) is off: opportunity_cost_term is thrown unless a version releases it", () => {
    expect(killSwitches.normaliseState(undefined).opportunity_cost_term).toBe(true);
    expect(require("../../../tools/config/publishV1Demonstration").publishRequest({ accommodate: true }).killSwitchState).toBeUndefined();
  });
});

describe("Zone-reference guard (services/spatialZoneReferences)", () => {
  test("pure: missing rows, wrong region, unknown cell zone, and a clean map", () => {
    const rows = g4Rows();
    expect(zoneReferenceFindings(g4map, rows)).toEqual([]);
    expect(zoneReferenceFindings(g4map, [])).toHaveLength(4);
    expect(zoneReferenceFindings(g4map, rows.map((r) => (r.id === "rnsit-z-east" ? { ...r, regionId: "elsewhere" } : r)))).toEqual([expect.stringMatching(/rnsit-z-east.*region elsewhere/)]);
    const stray = { ...g4map, cells: g4map.cells.map((c, i) => (i === 0 ? { ...c, zoneId: "rnsit-z-ghost" } : c)) };
    expect(zoneReferenceFindings(stray, rows)).toEqual([expect.stringMatching(/rnsit-z-ghost/)]);
    expect(zoneReferenceFindings(null, [])).toEqual([]);
  });

  test("loader reads only the Zone rows the map names", async () => {
    const prisma = prismaWith([legacyRow(), ...g4Rows(), { id: "unrelated", name: "U", regionId: "x" }]);
    expect(await checkSpatialZoneReferences(prisma, g4map)).toEqual([]);
    expect(prisma.zone.findMany).toHaveBeenCalledWith({ where: { id: { in: tool.G4_ZONE_IDS } }, select: { id: true, regionId: true } });
    expect(await checkSpatialZoneReferences(prismaWith([legacyRow()]), g4map)).toHaveLength(4);
    expect(await checkSpatialZoneReferences(prismaWith([]), undefined)).toEqual([]);
  });
});

describe("POST /api/config/publish (config.controller.publishVersion)", () => {
  const call = async (prisma, body) => {
    getPrisma.mockReturnValue(prisma);
    // asyncHandler does not return its promise: wait for the response (or for next(error)).
    let done;
    const finished = new Promise((resolve) => { done = resolve; });
    const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; done(); return this; } };
    const next = jest.fn(() => done());
    configController.publishVersion({ body, user: { id: "operator-1" }, app: { locals: { kv: null } } }, res, next);
    await finished;
    return { res, next };
  };
  let publish;
  let pin;
  beforeEach(() => {
    publish = jest.spyOn(configService, "publish").mockResolvedValue({ version: 7, signature: "s", publishedAt: new Date(0), safetyClassChanges: [], launchGate: [], findings: [] });
    pin = jest.spyOn(configService, "pinVersion").mockResolvedValue({ version: 7 });
  });
  afterEach(() => jest.restoreAllMocks());

  test("G4 map with its Zone rows missing: 422, nothing published, nothing pinned", async () => {
    const { res, next } = await call(prismaWith([legacyRow()]), { spatial: g4map, bindings: [] });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(422);
    expect(res.body.ok).toBe(false);
    expect(res.body.findings).toHaveLength(4);
    expect(res.body.findings[0]).toMatchObject({ id: "ZONE_REFERENCE", severity: "BLOCKING", rule: "F27" });
    expect(publish).not.toHaveBeenCalled();
    expect(pin).not.toHaveBeenCalled();
  });

  test("G4 map with its Zone rows present: published and pinned as before", async () => {
    const { res } = await call(prismaWith([legacyRow(), ...g4Rows()]), { spatial: g4map, bindings: [] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, version: 7, pinned: true });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(pin).toHaveBeenCalledWith(expect.anything(), null, 7, "operator-1");
  });

  test("a publish with no spatial map is unaffected by the guard", async () => {
    const prisma = prismaWith([]);
    const { res } = await call(prisma, { bindings: [] });
    expect(res.statusCode).toBe(200);
    expect(prisma.zone.findMany).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

"use strict";

/**
 * The DTARO cross-zone demonstration's staging tool (`tools/demo/dtaro/stageCrossZoneDemo.js`):
 * its synthetic map, and its refusal to touch anything but a disposable loopback database.
 * Nothing here opens a database connection.
 */

const path = require("path");
const { spawnSync } = require("child_process");
const fs = require("fs");
const h3 = require("h3-js");

const stage = require("../../../tools/demo/dtaro/stageCrossZoneDemo");
const bootstrap = require("../../../tools/deploy/bootstrapV1Environment");
const hierarchy = require("../../../src/engine/spatial/hierarchy");
const { parseScenario } = require("../../../src/simulation/dtaroScenario");

const world = bootstrap.intendedWorld();
const spatial = stage.syntheticSpatialMap({ cover: world.indexCover, rnsitRowId: "row-rnsit", r2RowId: "row-r2" });
const zoneOfPoint = (lat, lon) => hierarchy.indexMap(spatial).resolve(h3.latLngToCell(lat, lon, 11));
const SCENARIO = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../tools/demo/dtaro/rnsit-dtaro-crosszone-scenario.json"), "utf8"));

describe("the synthetic demonstration map", () => {
  test("passes the engine's own publish validators", () => {
    expect(() => stage.assertPublishable(spatial)).not.toThrow();
  });

  test("keeps the adopted 64-cell RNSIT cover, split into exactly two TEST zones — not the G4 zones", () => {
    const rnsitCells = spatial.cells.filter((c) => c.regionId === "row-rnsit");
    expect(rnsitCells.map((c) => c.cellId).sort()).toEqual([...world.indexCover].sort());
    expect([...new Set(rnsitCells.map((c) => c.zoneId))].sort()).toEqual(["rnsit-syn-east", "rnsit-syn-west"]);
    expect(spatial.zones.map((z) => z.id).some((id) => /^rnsit-z-/.test(id))).toBe(false);
  });

  test("the second region is separate: its own region and zone, no shared cell", () => {
    const r2 = spatial.cells.filter((c) => c.regionId === "row-r2");
    expect(r2.length).toBeGreaterThan(0);
    expect(r2.every((c) => c.zoneId === stage.R2.zone.id)).toBe(true);
    const rnsit = new Set(world.indexCover);
    expect(r2.some((c) => rnsit.has(c.cellId))).toBe(false);
    expect(zoneOfPoint(stage.R2.centre.lat, stage.R2.centre.lon)).toMatchObject({ regionId: "row-r2", zoneId: stage.R2.zone.id });
  });

  test("the demonstration points fall where the scenario needs them: depot WEST, OB-A and OB-B EAST, OB-C WEST", () => {
    expect(zoneOfPoint(world.depot.lat, world.depot.lon).zoneId).toBe("rnsit-syn-west");
    const at = (id) => SCENARIO.obstacles.find((o) => o.id === id);
    expect(zoneOfPoint(at("OB-A").lat, at("OB-A").lon).zoneId).toBe("rnsit-syn-east");
    expect(zoneOfPoint(at("OB-B").lat, at("OB-B").lon).zoneId).toBe("rnsit-syn-east");
    expect(zoneOfPoint(at("OB-C").lat, at("OB-C").lon).zoneId).toBe("rnsit-syn-west");
  });

  test("the demonstration scenario parses with the shipped loader, sensed within 4 m only", () => {
    const parsed = parseScenario(SCENARIO);
    expect(parsed.ok).toBe(true);
    expect(parsed.scenario.obstacles.map((o) => [o.id, o.senseRadiusM])).toEqual([["OB-A", 4], ["OB-B", 4], ["OB-C", 4]]);
  });

  test("control: a map whose cell names an undeclared zone is refused", () => {
    const broken = { ...spatial, cells: spatial.cells.map((c, i) => (i === 0 ? { ...c, zoneId: "nowhere" } : c)) };
    expect(() => stage.assertPublishable(broken)).toThrow(/fails validation/);
  });
});

describe("the staging CLI refuses any non-disposable target before connecting", () => {
  const tool = path.resolve(__dirname, "../../../tools/demo/dtaro/stageCrossZoneDemo.js");
  test.each([
    ["a remote host", "postgresql://u:p@db.example.com:5432/robotx"],
    ["no URL", null],
  ])("%s", (_label, url) => {
    const args = url ? [tool, "--database-url", url] : [tool];
    const run = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" }, timeout: 60_000 });
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).not.toMatch(/staged:/);
  });
});

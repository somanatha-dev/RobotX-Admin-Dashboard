"use strict";

/**
 * P0-A / P0-B — the V1 demonstration world and the V1 server launcher.
 *
 *   A. `seedV1Demonstration.publishConfiguration` publishes the V1 execution bindings.
 *      Measured before this fix (enablement audit, 2026-09-27): a `server.js` world seeded
 *      by the tool without them ran every round at `agentCount 0, BUDGET_LIMITED`.
 *      `runV1Assignment.js` publishes through the same function, so the two cannot drift.
 *   B. `startV1Server.js` refuses any database that is not a throwaway local cluster —
 *      checked as a real child process, which exits before anything could connect.
 */

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const configService = require("../../src/engine/config/service");
const seedTool = require("../../tools/demo/seedV1Demonstration");
const demonstration = require("../../tools/config/v1DemonstrationConfig");
const { assertDisposableLocal } = require("../../tools/demo/disposableDatabase");

const BACKEND = path.resolve(__dirname, "../..");
const LAUNCHER = path.join(BACKEND, "tools/demo/startV1Server.js");

describe("A — the seed publishes what the engine needs", () => {
  const world = {
    region: { id: "region-row-1" },
    zone: { id: "zone-1" },
    indexCover: ["8b6014512844fff"],
    declaration: { regionId: "rnsit-campus" },
  };
  let captured;

  beforeEach(() => {
    captured = null;
    jest.spyOn(configService, "publish").mockImplementation(async (prisma, request) => {
      captured = request;
      return { version: 7 };
    });
    jest.spyOn(configService, "pinVersion").mockResolvedValue(undefined);
    jest.spyOn(configService, "loadPinnedSnapshot").mockResolvedValue({ version: 7 });
  });
  afterEach(() => jest.restoreAllMocks());

  test("every V1 execution binding is published, with its canonical value", async () => {
    await seedTool.publishConfiguration({}, world);
    const published = new Map(captured.bindings.map((row) => [row.name, row]));
    for (const binding of demonstration.executionBindings()) {
      expect(published.get(binding.name)).toEqual(binding);
    }
    // The two the audit's zero-candidate rounds turned on.
    expect(published.get("candidate.max_radius_by_sla_class").value).toBe(700);
    expect(published.get("solve.time_budget").value).toBe(2000);
  });

  test("the thirteen and the region's cutover binding are still published", async () => {
    await seedTool.publishConfiguration({}, world);
    const names = captured.bindings.map((row) => row.name);
    for (const name of demonstration.PARAMETER_NAMES) expect(names).toContain(name);
    expect(captured.bindings).toContainEqual({ level: "region", key: "region-row-1", name: "cutover.engine_enabled", value: true });
  });

  test("no binding name is published twice", async () => {
    await seedTool.publishConfiguration({}, world);
    const names = captured.bindings.map((row) => `${row.level}:${row.key}:${row.name}`);
    expect(new Set(names).size).toBe(names.length);
  });

  test("the proof run publishes and commissions through the seed tool — one definition", () => {
    const runner = fs.readFileSync(path.join(BACKEND, "tools/demo/runV1Assignment.js"), "utf8");
    expect(runner).toMatch(/seedTool\.publishConfiguration\(/);
    expect(runner).toMatch(/const commissionFleet = seedTool\.commissionFleet;/);
    expect(runner).toMatch(/const BASELINE_FLEET = seedTool\.BASELINE_FLEET;/);
    expect(runner).not.toMatch(/configService\.publish\(/);
  });

  test("the baseline fleet is the six-unit acceptance fleet, two of them for the engine to refuse", () => {
    expect(seedTool.FLEETS.baseline.map((row) => row.code)).toEqual([
      "V1DEMO-01", "V1DEMO-02", "V1DEMO-03", "V1DEMO-04", "V1DEMO-05", "V1DEMO-06",
    ]);
    expect(seedTool.FLEETS.baseline.filter((row) => row.expect === "NEVER_ASSIGNED").map((row) => row.code)).toEqual([
      "V1DEMO-05", "V1DEMO-06",
    ]);
    expect(seedTool.FLEETS.single.map((row) => row.code)).toEqual(["V1DEMO-01"]);
  });
});

describe("B — only a throwaway local database", () => {
  test.each([
    ["postgresql://u@127.0.0.1:55450/v1", true],
    ["postgresql://u@localhost:55450/v1", true],
    ["postgresql://u@[::1]:55450/v1", true],
    ["postgresql://u@ep-broad-lab-a1shw6nm-pooler.ap-southeast-1.aws.neon.tech/neondb", false],
    ["postgresql://u@127.0.0.1.neon.tech:5433/v1", false],
    ["postgresql://localhost@db.example.com:5433/v1", false],
    ["postgresql://u@127.0.0.1:5433/v1?host=db.example.com", false],
    ["postgresql://u@127.0.0.1:5432/v1", false],
    ["postgresql://u@127.0.0.1/v1", false],
    ["mysql://u@127.0.0.1:3306/v1", false],
    ["", false],
  ])("%s → %s", (url, allowed) => {
    if (allowed) expect(assertDisposableLocal(url)).toBe(url);
    else expect(() => assertDisposableLocal(url)).toThrow();
  });

  const launch = (args, env = {}) =>
    spawnSync(process.execPath, [LAUNCHER, ...args], {
      cwd: BACKEND,
      encoding: "utf8",
      timeout: 20000,
      // A clean environment: no inherited DATABASE_URL, and nothing that could reach a network.
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...env },
    });

  test("refuses a Neon URL and exits before loading anything", () => {
    const run = launch(["--database-url", "postgresql://u@ep-broad-lab-a1shw6nm-pooler.ap-southeast-1.aws.neon.tech/neondb"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/V1 LAUNCHER REFUSED TO START/);
    expect(run.stderr).toMatch(/never Neon/);
    expect(run.stdout).not.toMatch(/V1 DEMONSTRATION BACKEND/);
  });

  test("refuses to start with no database named — it never falls back to DATABASE_URL", () => {
    const run = launch([], { DATABASE_URL: "postgresql://u@127.0.0.1:55450/v1" });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/requires a throwaway local database/);
  });

  test("refuses the developer's own cluster on 5432", () => {
    const run = launch(["--database-url", "postgresql://u@127.0.0.1:5432/v1"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/developer's own cluster/);
  });

  test("the launcher does not read DATABASE_URL for its target", () => {
    const source = fs.readFileSync(LAUNCHER, "utf8");
    expect(source).toMatch(/flag\("--database-url", process\.env\.V1_DATABASE_URL \|\| ""\)/);
    expect(source).not.toMatch(/flag\("--database-url", process\.env\.DATABASE_URL/);
  });
});

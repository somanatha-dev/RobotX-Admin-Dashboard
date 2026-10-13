"use strict";

/**
 * Decisions 2, 5, 6 and 7 (2026-10-13) — the shipped defaults, pinned.
 *
 *   2. The charger-projection refresh stays OFF: with the default configuration the simulator
 *      never republishes, so after `energy.charger_projection_max_age` every round — physical robots
 *      included — prices the return on §14.5's DEPOT_ONLY fallback, with the uncalibrated reserve
 *      factor (1.25) kept.
 *   5. `SIM_FIXED_RESERVE_WH` defaults to 0 Wh (configurable; no value invented).
 *   6. The charge curve defaults to the compatibility path (ABSOLUTE_W); PACK_RELATIVE is opt-in and
 *      labelled a simulation assumption.
 *   7. The CODE default (no `SIMULATED_CHARGING_STATIONS_FILE` — every process today) leaves both
 *      RNSIT stations unapproved and outside the estate. The declaration FILE approves PU College
 *      alone (owner, 2026-10-13); Canara Bank stays unapproved pending its boundary-margin review.
 *      JSSATE has no station at all.
 */

const path = require("path");

const cw = require("../../helpers/chargingWorld");
const devChargingScheduler = require("../../../src/simulation/devChargingScheduler");
const chargingStations = require("../../../src/simulation/chargingStations");
const chargeModel = require("../../../src/simulation/chargeModel");
const energyPolicy = require("../../../src/simulation/energyPolicy");
const eReturn = require("../../../src/engine/energy/eReturn");
const service = require("../../../src/engine/config/service");

const EXAMPLE = path.resolve(__dirname, "../../../../docs/runbooks/simulated-charging-stations.example.json");
const NOW = 1_791_700_000_000;
const MIN = 60_000;
const ENV_KEYS = ["SIM_CHARGER_PROJECTION_REFRESH_SECONDS", "SIM_FIXED_RESERVE_WH", "SIM_CHARGE_CURVE_MODE", "SIM_CHARGE_CC_C_RATE", "SIMULATED_CHARGING_STATIONS_FILE"];
const saved = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  energyPolicy.resetForTests();
  chargeModel.resetForTests();
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  energyPolicy.resetForTests();
  chargeModel.resetForTests();
});

describe("Decision 2 — the projection refresh is OFF by default, so the return margin is kept", () => {
  const clock = cw.createClock(NOW);
  let intervals;
  let setSpy;
  let clearSpy;
  beforeEach(() => {
    clock.install();
    intervals = [];
    setSpy = jest.spyOn(global, "setInterval").mockImplementation((fn, ms) => {
      const handle = { fn, ms, unref() {} };
      intervals.push(handle);
      return handle;
    });
    clearSpy = jest.spyOn(global, "clearInterval").mockImplementation(() => {});
  });
  afterEach(() => {
    setSpy.mockRestore();
    clearSpy.mockRestore();
    clock.uninstall();
  });

  test("the setting is unset in the default environment → OFF", () => {
    expect(devChargingScheduler.projectionRefreshSeconds()).toEqual({ enabled: false, seconds: null, problem: null });
  });

  test("ten minutes of scheduler passes publish nothing new; the round then prices DEPOT_ONLY with the 1.25 factor", async () => {
    const world = cw.createWorld();
    const { simulator } = await cw.boot(clock, world, []);
    simulator.start();
    const pass = intervals.find((handle) => handle.ms === 10_000);
    for (let i = 0; i < 60; i += 1) {
      clock.advance(10_000);
      pass.fn();
      // eslint-disable-next-line no-await-in-loop
      await cw.settle();
    }
    simulator.stop();
    expect(world.rows.chargerAvailabilityProjection.map((row) => row.version)).toEqual([1]);

    // The engine's own evaluation of that projection, as a round ten minutes after boot reads it.
    const latest = world.rows.chargerAvailabilityProjection[0];
    const config = service.defaultSnapshot();
    const evaluated = eReturn.evaluate({
      candidates: [{ chargerId: "V1DEMO-DEPOT-01", energyWh: 10, travelSeconds: 60, isDepot: true }],
      projection: { version: latest.version, publishedAt: latest.publishedAt, chargers: latest.payload.chargers },
      decisionTimeMs: clock.now,
      projectedEndMs: clock.now + 5 * MIN,
      usableWh: 400,
      missionWh: 50,
      floorWh: 30,
      availabilityMargin: config.resolve("energy.charger_availability_margin"),
      projectionMaxAgeSeconds: config.resolve("energy.charger_projection_max_age"),
      uncalibratedReserveFactor: config.resolve("energy.uncalibrated_reserve_factor"),
    });
    expect(evaluated.basis).toBe("DEPOT_ONLY");
    expect(evaluated.degradation.appliedFactor).toBe(1.25);
    expect(evaluated.verdict.eReturnWh).toBeCloseTo(10 * config.resolve("energy.charger_availability_margin") * 1.25, 9);
  });
});

describe("Decision 7 — the code default activates nothing; the declaration file activates PU College alone", () => {
  async function bootOn(env, { regionRow = true } = {}) {
    if (env) process.env.SIMULATED_CHARGING_STATIONS_FILE = env;
    const clock = cw.createClock(NOW);
    clock.install();
    try {
      const world = cw.createWorld();
      // The RNSIT Region row every V1 database carries (`regionId: "rnsit"`, seed and bootstrap alike),
      // which a station's `regionId` names.
      if (regionRow) world.prisma.region = { async findUnique({ where }) { return where.regionId === "rnsit" ? { id: cw.DEPOT_ROW.regionId, regionId: "rnsit" } : null; } };
      const { simulator, provisioned } = await cw.boot(clock, world, []);
      return { world, simulator, provisioned, overview: await simulator.chargingOverview() };
    } finally {
      clock.uninstall();
    }
  }

  test("no declaration file (every process today, LOCAL included): the depot alone; both stations unapproved, no row, not usable", async () => {
    const { world, provisioned, overview } = await bootOn(null);
    expect(provisioned.ok).toBe(true);
    expect(world.rows.charger.map((row) => row.chargerId)).toEqual(["V1DEMO-DEPOT-01", "DEV-SIM-RNSIT-MBA-01"]);
    expect(world.rows.chargerAvailabilityProjection[0].payload.chargers.map((c) => c.chargerId)).toEqual(["V1DEMO-DEPOT-01"]);
    expect(overview.stations.filter((s) => !s.isDepot).map((s) => [s.chargerId, s.approved, s.usable, s.lat, s.lon, s.inEstate])).toEqual([
      ["RNSIT-CHG-PU-COLLEGE", false, false, null, null, false],
      ["RNSIT-CHG-CANARA-BANK", false, false, null, null, false],
    ]);
    // Display only: the owner's DECLARED coordinates, so the dashboard can draw both as inactive
    // (NOT_APPROVED) — never as a usable charger (`lat`/`lon` stay null, `usable` false).
    expect(overview.stations.filter((s) => !s.isDepot).map((s) => [s.chargerId, s.declaredLat, s.declaredLon, s.problems.map((p) => p.code)])).toEqual([
      ["RNSIT-CHG-PU-COLLEGE", 12.900742024769887, 77.51884060360668, ["NOT_APPROVED"]],
      ["RNSIT-CHG-CANARA-BANK", 12.902396962367357, 77.51862316497345, ["NOT_APPROVED"]],
    ]);
  });

  test("the declaration file: PU College approved, Canara Bank not; exact owner coordinates; JSSATE has no station", () => {
    const declared = chargingStations.loadDeclaration({ SIMULATED_CHARGING_STATIONS_FILE: EXAMPLE });
    expect(declared.problems).toEqual([]);
    expect(declared.includeDepot).toBe(true);
    expect(declared.stations.map((s) => [s.chargerId, s.approved, s.lat, s.lon, s.plugCount])).toEqual([
      ["RNSIT-CHG-PU-COLLEGE", true, 12.900742024769887, 77.51884060360668, 1],
      ["RNSIT-CHG-CANARA-BANK", false, 12.902396962367357, 77.51862316497345, 1],
    ]);
    expect(declared.stations.some((s) => /JSSATE/i.test(`${s.chargerId} ${s.name} ${s.regionId}`))).toBe(false);
  });

  test("booting on the file: depot + PU College published; PU's row ADDED, depot untouched; Canara gets no row and no marker", async () => {
    const { world, provisioned, overview } = await bootOn(EXAMPLE);
    expect(provisioned.ok).toBe(true);
    expect(world.rows.charger.find((row) => row.chargerId === "V1DEMO-DEPOT-01")).toEqual(cw.DEPOT_ROW);
    expect(world.rows.charger.find((row) => row.chargerId === "RNSIT-CHG-PU-COLLEGE")).toMatchObject({ latitude: 12.900742024769887, longitude: 77.51884060360668, isDepot: false });
    expect(world.rows.charger.some((row) => row.chargerId === "RNSIT-CHG-CANARA-BANK")).toBe(false);
    expect(world.rows.chargerAvailabilityProjection[0].payload.chargers.map((c) => [c.chargerId, c.plugCount])).toEqual([["V1DEMO-DEPOT-01", 3], ["RNSIT-CHG-PU-COLLEGE", 1]]);
    expect(overview.stations.map((s) => [s.chargerId, s.approved, s.usable, s.lat, s.lon, s.inEstate])).toEqual([
      ["V1DEMO-DEPOT-01", true, true, cw.DEPOT_ROW.latitude, cw.DEPOT_ROW.longitude, true],
      ["RNSIT-CHG-PU-COLLEGE", true, true, 12.900742024769887, 77.51884060360668, true],
      ["RNSIT-CHG-CANARA-BANK", false, false, null, null, false],
    ]);
    expect(overview.stations.find((s) => s.chargerId === "RNSIT-CHG-CANARA-BANK").problems.map((p) => p.code)).toEqual(["NOT_APPROVED"]);
  });

  test("without the station's Region row, PU College is refused by name and no row is created (fail closed)", async () => {
    const { world, overview } = await bootOn(EXAMPLE, { regionRow: false });
    expect(world.rows.charger.some((row) => row.chargerId === "RNSIT-CHG-PU-COLLEGE")).toBe(false);
    const pu = overview.stations.find((s) => s.chargerId === "RNSIT-CHG-PU-COLLEGE");
    expect(pu.usable).toBe(false);
    expect(pu.problems).toEqual([{ code: "NOT_PROVISIONED", detail: expect.stringMatching(/region "rnsit" has no row/) }]);
  });

  test("the file does not turn the projection refresh on", () => {
    expect(devChargingScheduler.projectionRefreshSeconds()).toEqual({ enabled: false, seconds: null, problem: null });
  });
});

describe("Decisions 5 and 6 — unprovided values stay unprovided", () => {
  test("SIM_FIXED_RESERVE_WH defaults to 0 Wh and is configurable", () => {
    expect(energyPolicy.FIELDS.fixedReserveWh.default).toBe(0);
    expect(energyPolicy.policy().fixedReserveWh).toBe(0);
    process.env.SIM_FIXED_RESERVE_WH = "12.5";
    energyPolicy.resetForTests();
    expect(energyPolicy.policy().fixedReserveWh).toBe(12.5);
  });

  test("the charge curve defaults to the compatibility path; PACK_RELATIVE is opt-in and labelled an assumption", () => {
    expect(chargeModel.settings().mode).toBe("ABSOLUTE_W");
    expect(chargeModel.curveFor(500)).toBe(require("../../../src/simulation/constants").CHARGE_POWER_CURVE);
    expect(chargeModel.PROVENANCE).toMatchObject({ kind: "SIMULATION_ASSUMPTION", measured: false });
  });
});

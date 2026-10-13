"use strict";

/**
 * Charging lifecycle step D — the development scheduler's projection refresh (OPT-IN).
 *
 * `E_return` (frozen, §14.5) plans against every charger the pinned projection covers only while
 * that projection is younger than `energy.charger_projection_max_age`; otherwise its stated
 * fallback is DEPOT_ONLY × `energy.uncalibrated_reserve_factor`. The development publisher wrote a
 * projection only when the estate changed, so it went stale two minutes after boot.
 * `refreshProjection` republishes the SAME estate with each charger's occupancy; it is OFF unless
 * `SIM_CHARGER_PROJECTION_REFRESH_SECONDS` is set, because a fresh projection changes the basis for
 * every agent of the round, physical ones included (an owner decision).
 *
 * The decision-path consequences are in `tests/engine/chargingAssignmentIntegration.test.js`.
 */

const cw = require("../../helpers/chargingWorld");
const devChargingScheduler = require("../../../src/simulation/devChargingScheduler");

const NOW = 1_791_700_000_000;
const MIN = 60_000;
const RESERVABLE = "RESERVABLE";
const OCCUPIED = "OCCUPIED";

const active = (untilMs) => ({ state: "ACTIVE", reservedFrom: new Date(NOW - MIN), reservedUntil: new Date(untilMs) });
const queued = (lengthMs) => ({ state: "QUEUED", reservedFrom: new Date(NOW), reservedUntil: new Date(NOW + lengthMs) });

describe("the refresh is OFF unless the owner sets SIM_CHARGER_PROJECTION_REFRESH_SECONDS", () => {
  test.each([
    ["unset", {}, { enabled: false, seconds: null }],
    ["empty", { SIM_CHARGER_PROJECTION_REFRESH_SECONDS: " " }, { enabled: false, seconds: null }],
    ["60", { SIM_CHARGER_PROJECTION_REFRESH_SECONDS: "60" }, { enabled: true, seconds: 60 }],
  ])("%s", (_label, env, expected) => {
    expect(devChargingScheduler.projectionRefreshSeconds(env)).toMatchObject({ ...expected, problem: null });
  });

  test.each([["5"], ["901"], ["60.5"], ["sixty"]])("%s is refused by name and the refresh stays OFF", (value) => {
    const out = devChargingScheduler.projectionRefreshSeconds({ SIM_CHARGER_PROJECTION_REFRESH_SECONDS: value });
    expect(out.enabled).toBe(false);
    expect(out.problem).toMatch(/SIM_CHARGER_PROJECTION_REFRESH_SECONDS/);
  });
});

describe("occupancyIntervals — what a newcomer would find, from the reservations held now", () => {
  const until = NOW + 120 * MIN;
  const at = (live, plugCount = 3) => devChargingScheduler.occupancyIntervals({ nowMs: NOW, untilMs: until, plugCount, live });

  test("no reservations: reservable for the whole horizon", () => {
    expect(at([])).toEqual([{ fromMs: NOW, untilMs: until, state: RESERVABLE }]);
  });

  test("a plug still free: reservable now", () => {
    expect(at([active(NOW + 10 * MIN), active(NOW + 20 * MIN)])).toEqual([{ fromMs: NOW, untilMs: until, state: RESERVABLE }]);
  });

  test("every plug taken: OCCUPIED until the first plug frees, reservable after", () => {
    expect(at([active(NOW + 10 * MIN), active(NOW + 20 * MIN), active(NOW + 30 * MIN)])).toEqual([
      { fromMs: NOW, untilMs: NOW + 10 * MIN, state: OCCUPIED },
      { fromMs: NOW + 10 * MIN, untilMs: until, state: RESERVABLE },
    ]);
  });

  test("a queue is seated first (FIFO, its own window length): the newcomer waits behind it", () => {
    // Plugs free at +10, +20, +30; the queued 15-minute session takes the +10 plug until +25.
    expect(at([active(NOW + 10 * MIN), active(NOW + 20 * MIN), active(NOW + 30 * MIN), queued(15 * MIN)])).toEqual([
      { fromMs: NOW, untilMs: NOW + 20 * MIN, state: OCCUPIED },
      { fromMs: NOW + 20 * MIN, untilMs: until, state: RESERVABLE },
    ]);
  });

  test("more robots plugged in than plugs (capacity cut): the surplus leaves first", () => {
    expect(at([active(NOW + 5 * MIN), active(NOW + 10 * MIN), active(NOW + 20 * MIN), active(NOW + 30 * MIN)])).toEqual([
      { fromMs: NOW, untilMs: NOW + 10 * MIN, state: OCCUPIED },
      { fromMs: NOW + 10 * MIN, untilMs: until, state: RESERVABLE },
    ]);
  });

  test("occupied past the horizon: OCCUPIED throughout, never guessed reservable", () => {
    expect(at([active(until + MIN)], 1)).toEqual([{ fromMs: NOW, untilMs: until, state: OCCUPIED }]);
  });
});

describe("refreshProjection republishes the SAME estate, fresh, and nothing else", () => {
  const deps = (world) => ({ prisma: world.prisma });
  const latest = (world) => [...world.rows.chargerAvailabilityProjection].sort((a, b) => b.version - a.version)[0];

  async function provisioned() {
    const world = cw.createWorld();
    const out = await devChargingScheduler.provision(deps(world), { nowMs: NOW });
    expect(out.published).toBe(true);
    return world;
  }

  test("nothing published yet: refused, nothing written", async () => {
    const world = cw.createWorld();
    const out = await devChargingScheduler.refreshProjection(deps(world), { nowMs: NOW, refreshAfterSeconds: 60 });
    expect(out.ok).toBe(false);
    expect(out.published).toBe(false);
    expect(world.rows.chargerAvailabilityProjection).toHaveLength(0);
  });

  test("younger than the period: no new version (no churn)", async () => {
    const world = await provisioned();
    const out = await devChargingScheduler.refreshProjection(deps(world), { nowMs: NOW + 59_000, refreshAfterSeconds: 60 });
    expect(out).toMatchObject({ ok: true, published: false, version: 1, ageSeconds: 59 });
    expect(world.rows.chargerAvailabilityProjection).toHaveLength(1);
  });

  test("older than the period: a new version, published now, same charger set, positions and plug counts", async () => {
    const world = await provisioned();
    const before = latest(world);
    const out = await devChargingScheduler.refreshProjection(deps(world), { nowMs: NOW + 61_000, refreshAfterSeconds: 60 });
    expect(out).toMatchObject({ ok: true, published: true, version: 2 });
    const after = latest(world);
    expect(after.version).toBe(2);
    expect(after.publishedAt.getTime()).toBe(NOW + 61_000);
    expect(after.publishedBy).toBe(devChargingScheduler.PUBLISHER);
    expect(after.payload.evidence).toEqual(before.payload.evidence);
    const estate = (payload) => payload.chargers.map(({ intervals, ...rest }) => rest);
    expect(estate(after.payload)).toEqual(estate(before.payload));
    // The depot alone: the superseded DEV-SIM row is not in the estate and is not added.
    expect(after.payload.chargers.map((c) => c.chargerId)).toEqual(["V1DEMO-DEPOT-01"]);
    expect(after.payload.chargers[0].intervals).toEqual([{ fromMs: NOW + 61_000, untilMs: after.horizonEnd.getTime(), state: RESERVABLE }]);
  });

  test("the depot's plugs all held: the refreshed projection says OCCUPIED until the first frees", async () => {
    const world = await provisioned();
    const nowMs = NOW + 61_000;
    for (const [i, end] of [[1, 10], [2, 20], [3, 30]]) {
      cw.seedReservation(world, { agentRowId: `agent-${i}`, state: "ACTIVE", fromMs: NOW, untilMs: nowMs + end * MIN, ordinal: i });
    }
    await devChargingScheduler.refreshProjection(deps(world), { nowMs, refreshAfterSeconds: 60 });
    expect(latest(world).payload.chargers[0].intervals.slice(0, 1)).toEqual([{ fromMs: nowMs, untilMs: nowMs + 10 * MIN, state: OCCUPIED }]);
  });

  test("a charger of the estate whose row is gone: refused, nothing written (the projection goes stale, as before)", async () => {
    const world = await provisioned();
    world.rows.charger.splice(world.rows.charger.findIndex((row) => row.chargerId === "V1DEMO-DEPOT-01"), 1);
    const out = await devChargingScheduler.refreshProjection(deps(world), { nowMs: NOW + 61_000, refreshAfterSeconds: 60 });
    expect(out.ok).toBe(false);
    expect(out.problems.join(" ")).toMatch(/has no row/);
    expect(world.rows.chargerAvailabilityProjection).toHaveLength(1);
  });

  test("a row moved since publication: refused — estate changes are provisioning's, not the refresh's", async () => {
    const world = await provisioned();
    world.rows.charger.find((row) => row.chargerId === "V1DEMO-DEPOT-01").latitude += 0.001;
    const out = await devChargingScheduler.refreshProjection(deps(world), { nowMs: NOW + 61_000, refreshAfterSeconds: 60 });
    expect(out.ok).toBe(false);
    expect(out.problems.join(" ")).toMatch(/no longer matches the published estate/);
    expect(world.rows.chargerAvailabilityProjection).toHaveLength(1);
  });

  test("provisioning after a refresh still sees an unchanged estate (no extra version)", async () => {
    const world = await provisioned();
    await devChargingScheduler.refreshProjection(deps(world), { nowMs: NOW + 61_000, refreshAfterSeconds: 60 });
    const again = await devChargingScheduler.provision(deps(world), { nowMs: NOW + 120_000 });
    expect(again).toMatchObject({ ok: true, published: false, projectionVersion: 2 });
  });
});

describe("the simulator's periodic pass: refresh only when configured", () => {
  const clock = cw.createClock(NOW);
  let intervals;
  let setSpy;
  let clearSpy;
  const ORIGINAL = process.env.SIM_CHARGER_PROJECTION_REFRESH_SECONDS;

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
    if (ORIGINAL === undefined) delete process.env.SIM_CHARGER_PROJECTION_REFRESH_SECONDS;
    else process.env.SIM_CHARGER_PROJECTION_REFRESH_SECONDS = ORIGINAL;
  });

  async function passAfter(ms) {
    const world = cw.createWorld();
    const { simulator } = await cw.boot(clock, world, []);
    simulator.start();
    const pass = intervals.find((handle) => handle.ms === 10_000);
    expect(pass).toBeDefined();
    clock.advance(ms);
    pass.fn();
    await cw.settle();
    await cw.settle();
    simulator.stop();
    return world.rows.chargerAvailabilityProjection.map((row) => row.version);
  }

  test("default (unset): the pass reconciles only — the projection is never republished", async () => {
    delete process.env.SIM_CHARGER_PROJECTION_REFRESH_SECONDS;
    expect(await passAfter(10 * MIN)).toEqual([1]);
  });

  test("SIM_CHARGER_PROJECTION_REFRESH_SECONDS=60: a pass after 60 s republishes", async () => {
    process.env.SIM_CHARGER_PROJECTION_REFRESH_SECONDS = "60";
    expect(await passAfter(61_000)).toEqual([1, 2]);
  });
});

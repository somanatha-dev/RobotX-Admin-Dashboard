"use strict";

/**
 * A controlled three-robot charging scenario on the REAL simulator, scheduler, contained campus
 * router and charging classifier (the one the Availability Index uses), over an in-memory store and
 * a pinned clock. ISOLATED — no database, no socket server, no browser: this is integration
 * evidence, not a dashboard run. The dashboard's own data source (`chargingOverview`, merged into
 * `GET /api/simulator/status`, and each robot's `chargingView`) is recorded as a timeline.
 *
 * Estate: the declaration file AS SHIPPED (PU College approved, Canara Bank not) with the depot
 * excluded — `includeDepot: false` — so exactly ONE plug exists (PU College's).
 *
 *   R1  SIM-R1  at PU College, 12 %       → charges at PU College
 *   R2  SIM-R2  at SIM-0A8C's campus spot → drops to 12 %, drives the contained route to PU
 *                                            College, QUEUES (no plug held), is promoted when R1
 *                                            releases, charges to 80 %
 *   R3  SIM-R3  at the depot, 90 %        → carries out a campus delivery meanwhile, never seeks a
 *                                            charger, stays available
 */

const cw = require("../../helpers/chargingWorld");

require(cw.ENGINE_PATH);

const path = require("path");
const chargingStations = require("../../../src/simulation/chargingStations");
const chargingStatus = require("../../../src/services/chargingStatus.service");
const campusTraversalNetwork = require("../../../src/simulation/campusTraversalNetwork");
const routeContainment = require("../../../src/services/fleetProviders/routeContainment");

jest.setTimeout(300_000);

const PU = Object.freeze({ lat: 12.900742024769887, lon: 77.51884060360668 });
const FILE = path.resolve(__dirname, "../../../../docs/runbooks/simulated-charging-stations.example.json");

const clock = cw.createClock();
beforeEach(() => clock.install());
afterEach(() => clock.uninstall());

function campusPath(from, to) {
  const extract = campusTraversalNetwork.extractForDeclaration(cw.DECLARATION);
  const network = campusTraversalNetwork.createCampusTraversalNetwork({
    features: extract.features,
    roadClasses: campusTraversalNetwork.permittedClasses(cw.PERMISSION_SET),
    source: extract.file,
  });
  const routed = network.route(from, to);
  if (!routed.ok) throw new Error(routed.reason);
  return routed.points.map((p) => ({ lat: p.lat, lon: p.lon }));
}

test("one charges, one queues without a plug, the third keeps working; the queued robot is promoted, charges to 80 % and returns to the pool", async () => {
  const declared = chargingStations.loadDeclaration({ SIMULATED_CHARGING_STATIONS_FILE: FILE });
  expect(declared.stations.map((s) => [s.chargerId, s.approved])).toEqual([["RNSIT-CHG-PU-COLLEGE", true], ["RNSIT-CHG-CANARA-BANK", false]]);

  const world = cw.createWorld();
  world.prisma.region = { async findUnique({ where }) { return where.regionId === "rnsit" ? { id: cw.DEPOT_ROW.regionId, regionId: "rnsit" } : null; } };
  for (const [robotId, battery] of [["SIM-R1", 12], ["SIM-R2", 40], ["SIM-R3", 90]]) {
    cw.addRobotRow(world, { robotId, agentRowId: `agent-${robotId}`, battery });
  }
  const { simulator, byId } = await cw.boot(clock, world, [
    { robotId: "SIM-R1", at: PU },
    { robotId: "SIM-R2", at: cw.AWAY },
    { robotId: "SIM-R3", at: cw.AT_DEPOT },
  ], { simulatorOptions: { stationDeclaration: { includeDepot: false, stations: declared.stations } } });
  const [r1, r2, r3] = ["SIM-R1", "SIM-R2", "SIM-R3"].map(byId);
  const all = [r1, r2, r3];
  const status = chargingStatus.createChargingStatusReader({ prisma: world.prisma, inScope: () => true });
  const guard = routeContainment.createRouteContainment(cw.DECLARATION);
  const timeline = [];
  const snap = async (label) => {
    const overview = await simulator.chargingOverview();
    const entry = {
      label,
      atS: Math.round((clock.now - 1_791_700_000_000) / 1000),
      station: overview.stations.map((s) => ({ id: s.chargerId, usable: s.usable, plugs: s.plugCount, active: s.active, queued: s.queued })),
      robots: Object.fromEntries(all.map((vr) => {
        const view = vr.chargingView();
        return [vr.robotId, {
          status: vr.status,
          battery: Math.round(vr.battery * 10) / 10,
          phase: view.phase,
          stationId: view.stationId,
          remainingRouteM: view.remainingRouteM === null ? null : Math.round(view.remainingRouteM),
          etaArrivalS: view.etaArrivalS === null ? null : Math.round(view.etaArrivalS),
          etaCompleteS: view.etaCompleteS === null ? null : Math.round(view.etaCompleteS),
          queue: overview.robots[vr.robotId] || null,
          blocked: view.blocked ? view.blocked.code : null,
          task: vr.task ? vr.task.taskId : null,
        }];
      })),
    };
    timeline.push(entry);
    return { overview, entry };
  };

  // ── R3 receives a delivery (campus route) and moves; R1 starts charging at PU College ──
  r3._onTaskAssign({ taskId: "TSK-R3", pathToPickup: campusPath(cw.AT_DEPOT, cw.MBA), pathToDrop: campusPath(cw.MBA, cw.AT_DEPOT) });
  const r3Start = { lat: r3.lat, lon: r3.lon };
  await cw.runUntil(clock, all, () => r1._chargingPhase === "CHARGING", 40);
  await snap("R1 charging at PU College; R3 on its delivery");
  expect(r1.chargingView().stationId).toBe("RNSIT-CHG-PU-COLLEGE");
  expect({ lat: r3.lat, lon: r3.lon }).not.toEqual(r3Start); // R3 is moving
  expect(await status("agent-SIM-R1")).toMatchObject({ known: true, charging: true }); // not assignable

  // ── R2 needs charge: it routes to the only usable station over the contained network ──
  r2.battery = 12;
  await cw.runUntil(clock, all, () => r2._chargingPhase === "APPROACHING", 40);
  const approaching = await snap("R2 approaching PU College along its campus route");
  const view = r2.chargingView();
  expect(view.stationId).toBe("RNSIT-CHG-PU-COLLEGE");
  expect(view.remainingRouteM).toBeGreaterThan(0);
  expect(view.etaArrivalS).toBeGreaterThan(0);
  for (let i = 1; i < view.route.length; i += 1) expect(guard.containsSegment(view.route[i - 1], view.route[i])).toBe(true);
  expect(approaching.entry.robots["SIM-R2"].phase).toBe("APPROACHING");
  // Its reservation is QUEUED: it does not hold the one plug while it drives.
  expect(cw.liveReservations(world, "agent-SIM-R2")[0].state).toBe("QUEUED");

  // ── R2 arrives and queues behind R1 — no plug held ──
  await cw.runUntil(clock, all, () => r2._chargingPhase === "WAITING", 400);
  const queued = await snap("R2 queued at PU College behind R1");
  expect(cw.liveReservations(world, "agent-SIM-R2")[0].state).toBe("QUEUED");
  expect(queued.overview.stations[0]).toMatchObject({ chargerId: "RNSIT-CHG-PU-COLLEGE", plugCount: 1, active: 1, queued: 1 });
  expect(queued.overview.robots["SIM-R2"].queuePosition).toBe(1);
  expect(queued.overview.robots["SIM-R2"].estimatedWaitS).toBeGreaterThan(0);
  expect(await status("agent-SIM-R2")).toMatchObject({ known: true, charging: false, waiting: true }); // not assignable
  expect(await status("agent-SIM-R3")).toMatchObject({ known: true, charging: false, waiting: false }); // assignable

  // ── R1 reaches 80 %: plug released; R2 promoted and starts charging ──
  await cw.runUntil(clock, all, () => r1._chargingPhase === null && r1.status === "IDLE", 3000);
  expect(r1.battery).toBeGreaterThanOrEqual(79.9);
  expect(world.rows.chargerReservation.find((r) => r.agentId === "agent-SIM-R1").externalId).toBe("TARGET_REACHED");
  await cw.runUntil(clock, all, () => r2._chargingPhase === "CHARGING", 60);
  const promoted = await snap("R1 released at 80 %; R2 promoted and charging");
  expect(promoted.overview.stations[0]).toMatchObject({ active: 1, queued: 0 });
  expect(promoted.entry.robots["SIM-R2"].etaCompleteS).toBeGreaterThan(0);
  expect(await status("agent-SIM-R1")).toMatchObject({ known: true, charging: false, waiting: false }); // back in the pool

  // ── R2 reaches 80 %: released, IDLE, back in the pool ──
  const r2Start = r2.battery;
  await cw.runUntil(clock, all, () => r2._chargingPhase === null && r2.status === "IDLE", 3000);
  await snap("R2 released at 80 %; all three available");
  expect(r2.battery).toBeGreaterThan(r2Start);
  expect(r2.battery).toBeGreaterThanOrEqual(79.9);
  expect(cw.liveReservations(world)).toHaveLength(0);
  expect(await status("agent-SIM-R2")).toMatchObject({ known: true, charging: false, waiting: false });

  // R3 finished its delivery without ever seeking a charger.
  expect(r3.socket.emitted.some((e) => e.event === "TASK_COMPLETE")).toBe(true);
  expect(timeline.every((t) => t.robots["SIM-R3"].phase === null)).toBe(true);

  if (process.env.SCENARIO_TIMELINE_OUT) require("fs").writeFileSync(process.env.SCENARIO_TIMELINE_OUT, JSON.stringify(timeline, null, 2));
});

test("a trigger at or above the target is refused, and a trigger below it never loops (live-run defect, 2026-10-13)", async () => {
  const world = cw.createWorld();
  for (const [robotId, battery] of [["SIM-AT80", 80], ["SIM-BELOW", 78.9]]) {
    cw.addRobotRow(world, { robotId, agentRowId: `agent-${robotId}`, battery });
  }
  const { simulator, byId } = await cw.boot(clock, world, [
    { robotId: "SIM-AT80", at: cw.AT_DEPOT },
    { robotId: "SIM-BELOW", at: cw.AT_DEPOT },
  ]);
  const atTarget = byId("SIM-AT80");
  const below = byId("SIM-BELOW");

  // Measured live: trigger 80 with target 80 made charged robots re-seek every ~30 s for ever.
  const refused = simulator.setConfig({ chargeTriggerPct: 80 });
  expect(refused.ok).toBe(false);
  expect(refused.problems.join(" ")).toMatch(/below the charge target \(80 %\)/);
  expect(atTarget._chargeTriggerPct).toBe(20);
  expect(atTarget.setChargeTriggerPct(80)).toBe(false);

  expect(simulator.setConfig({ chargeTriggerPct: 79 }).ok).toBe(true);
  // Record the battery at every moment a robot STARTS seeking a charger.
  const starts = [];
  const last = new Map();
  const watch = () => {
    for (const vr of [atTarget, below]) {
      if (vr._chargingPhase === "SEEKING" && last.get(vr.robotId) !== "SEEKING") starts.push({ robotId: vr.robotId, battery: vr.battery });
      last.set(vr.robotId, vr._chargingPhase);
    }
  };
  await cw.runTicks(clock, [atTarget, below], 400, watch);
  // Every session began at or below the trigger — never at the target (the live loop began AT 80 %).
  expect(starts.length).toBeGreaterThan(0);
  for (const start of starts) expect(start.battery).toBeLessThanOrEqual(79);
  // Every finished session charged to the target (a real session, not a dock/undock at 0 s), and a
  // robot only seeks again after draining back to the trigger — the 1-point gap is the hysteresis.
  const finished = world.rows.chargerReservation.filter((r) => r.state === "RELEASED");
  expect(finished.length).toBeGreaterThan(0);
  for (const row of finished) expect(row.externalId).toBe("TARGET_REACHED");
});

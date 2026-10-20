"use strict";

/**
 * The charging-to-reassignment loop, end to end, in ONE world (`helpers/chargingLoopWorld`):
 *
 *   round 1 assigns a simulated robot at 20.3 % (above the 20 % trigger, inside F34)
 *   → the commit's OFFER reaches it through the outbox worker → it accepts and delivers
 *   → the server grades the completion and settles the Leg → the robot, now below 20 %,
 *   seeks a charger → reserves a depot plug → drives to the depot → docks → charges to 80 %
 *   → releases TARGET_REACHED → a SECOND real round indexes it again, admits it through the
 *   gate and commits a second Leg → that OFFER reaches it and it accepts.
 *
 * A round taken WHILE it charges must not assign it (its reservation keeps it out of the index).
 *
 * Nothing between the phases writes a robot, battery, observation, reservation or commitment row:
 * the world is set up once, and every later row is what the engine, the socket handlers, the
 * outbox worker or the simulator wrote. The post-charge state the second round decides on is the
 * one the charging lifecycle actually left.
 *
 * REAL: index maintainer + charging classifier, V1 composition, solve path, §7 gate, round.plan,
 * §10.3.2 commit, outbox worker (as `leaderWorkers` composes it) + `commandDispatcher` delivery,
 * robot/telemetry/command/dtaro/offer socket handlers, SimulationEngine, VirtualRobot,
 * devChargingScheduler, chargerRoute, the campus network.
 * DOUBLED (see the helper's header): the store, raw SQL answers, the clock, the socket transport,
 * the AUTH handshake (the socket is marked authenticated as AUTH marks it), the outbox worker's
 * interval loop, and task intake (the Leg rows are built as `phase7World` builds them).
 */

const cw = require("../helpers/chargingWorld");

require(cw.ENGINE_PATH);

const fs = require("fs");
const path = require("path");

const constants = require("../../src/simulation/constants");
const chargerRoute = require("../../src/simulation/chargerRoute");
const chargingStatus = require("../../src/services/chargingStatus.service");
const { haversineMeters } = require("../../src/utils/distance");
const loop = require("./helpers/chargingLoopWorld");

jest.setTimeout(300_000);

const ROBOT = "SIM-LOOP";
const T0 = Date.parse("2026-10-09T14:00:00Z");
const DEPOT = cw.AT_DEPOT;
/** The deployment's completion-grading thresholds (`.env.example`, the V1 runbook, LOCAL). */
const VERIFY_ENV = Object.freeze({
  VERIFY_ARRIVAL_RADIUS_M: "25",
  VERIFY_TRACK_MIN_FIX_RATE: "10",
  VERIFY_TRACK_MIN_CORRIDOR_FRACTION: "0.8",
  VERIFY_TRACK_MAX_GAP_SECONDS: "10",
  VERIFY_CORRIDOR_HALF_WIDTH_M: "30",
  VERIFY_MAX_SPEED_MS: "8.33",
});
const ENGINE_ENV = Object.freeze({ ENGINE_ENABLED: "true", ENABLE_VIRTUAL_SIMULATOR: "true", V1_DEMONSTRATION_COMPOSITION: "true" });

const clock = cw.createClock(T0);
const savedEnv = {};
beforeAll(() => {
  for (const [name, value] of Object.entries({ ...ENGINE_ENV, ...VERIFY_ENV })) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
});
afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
beforeEach(() => clock.install());
afterEach(() => clock.uninstall());

const { sameRealm } = require("./helpers/phase7World");

/** The store's rows as a Prisma read returns them (Dates of this realm; see `phase7World.sameRealm`). */
const rowsOf = (world, model) => sameRealm((world.store.delegateFor(model) && world.store.rowsOf(model)) || []);
const live = (world) => rowsOf(world, "chargerReservation").filter((row) => row.state === "QUEUED" || row.state === "ACTIVE");
/** Every §7 predicate the gate registers (F1 … F38), as the gate names them in `evaluated`. */
const ALL_PREDICATES = fs
  .readdirSync(path.resolve(__dirname, "../../src/engine/feasibility/predicates"))
  .map((file) => /^f(\d+)\.js$/.exec(file))
  .filter(Boolean)
  .map((match) => `F${Number(match[1])}`);
const offersTo = (connection) => connection.delivered.filter((entry) => entry.event === "OFFER");
const accepts = (connection) => connection.client.emitted.filter((entry) => entry.event === "OFFER_ACCEPT");

test("assigned → delivers → crosses the trigger → charges at the depot → released → re-indexed and assigned again by a real round", async () => {
  const lines = [];
  const logger = new Proxy({}, { get: (_t, level) => (msg, meta) => lines.push({ level: String(level), msg: String(msg), meta }) });
  const world = await loop.createLoopWorld({ clock, robotId: ROBOT, at: cw.AWAY, socFraction: 0.203 });
  try {
    const booted = await cw.boot(
      clock,
      { prisma: world.prisma, runSerializable: (_client, fn) => fn(world.tx), selectForUpdate: async () => null },
      [{ robotId: ROBOT, at: cw.AWAY }],
    );
    // The simulator published its estate: the depot, 3 plugs.
    expect(booted.provisioned).toMatchObject({ ok: true, projectionVersion: 2, problems: [] });
    const depotRow = rowsOf(world, "charger").find((row) => row.chargerId === "V1DEMO-DEPOT-01");
    const vr = booted.byId(ROBOT);
    expect(vr._chargeTriggerPct).toBe(20); // the shipped default (energyPolicy)
    expect(vr.battery).toBeCloseTo(20.3, 6); // above the trigger: an idle robot here does not seek a charger
    const connection = loop.connectRobot(world, vr, { logger });
    await loop.authenticate(world, connection);
    loop.composeOutbox(world, connection);
    const writesAtSetup = world.store.writes.length;

    // ── A. Round 1: a legitimate assignment through the real engine ────────────────────────
    const leg1 = loop.addLeg(world, { legKey: "LOOP-1", pickup: cw.MBA, drop: cw.AWAY });
    const r1 = await loop.runRound(world, { legRowId: leg1.leg.id });
    expect(r1.indexErrors).toEqual([]);
    expect(r1.indexed).toEqual([expect.objectContaining({ agentId: ROBOT, availabilityClass: "IDLE_READY" })]);
    expect(r1.gated).toEqual([ROBOT]);
    expect(r1.denials).toEqual({});
    // Every predicate ran on it (none skipped), and none denied.
    expect(ALL_PREDICATES.length).toBeGreaterThanOrEqual(38);
    expect([...r1.evaluatedPredicates[ROBOT]].sort()).toEqual([...ALL_PREDICATES].sort());
    expect(r1.outcome).toBe("ASSIGNED");
    expect(r1.winner).toBe(ROBOT);
    expect(r1.committed).toMatchObject({ outcome: "COMMITTED", committed: true });
    const commitment1 = rowsOf(world, "commitment").find((row) => row.legId === leg1.leg.id);
    expect(commitment1).toMatchObject({ agentId: world.agentRowId, releasedAt: null });
    const offerRow1 = rowsOf(world, "outbox").find((row) => row.command === "OFFER" && row.commitmentId === commitment1.commitmentId);
    expect(offerRow1).toBeDefined();

    // The OFFER the commit wrote, delivered by the outbox worker to the robot's room.
    const drained1 = await loop.drainOutbox(world);
    await loop.settleDeep(80);
    expect(drained1).toMatchObject({ claimed: 1, delivered: 1, undelivered: 0 });
    expect(offersTo(connection)).toHaveLength(1);
    expect(offersTo(connection)[0].payload).toMatchObject({ outboxId: offerRow1.id, commitmentId: commitment1.commitmentId });
    expect(accepts(connection).map((entry) => entry.payload.commitmentId)).toEqual([commitment1.commitmentId]);
    expect(rowsOf(world, "leg").find((row) => row.id === leg1.leg.id).state).toBe("ACCEPTED");
    expect(vr.task && vr.task.taskId).toBe("TSK-LOOP-1");

    // ── B–C. Deliver, cross the trigger, reserve, drive, dock, charge, release ──────────────
    const ticks = [];
    const legStates = [];
    let midChargeRound = null;
    let leg2 = null;
    for (let i = 0; i < 2000; i += 1) {
      const before = { battery: vr.battery, status: vr.status, phase: vr._chargingPhase, task: vr.task ? vr.task.taskId : null };
      clock.advance(constants.TELEMETRY_INTERVAL_MS);
      vr._tick();
      // eslint-disable-next-line no-await-in-loop
      await loop.settleDeep(30);
      // eslint-disable-next-line no-await-in-loop
      if (i % 5 === 0) await loop.drainOutbox(world);
      const legState = rowsOf(world, "leg").find((row) => row.id === leg1.leg.id).state;
      if (legStates[legStates.length - 1] !== legState) legStates.push(legState);
      ticks.push({
        i,
        before,
        after: { battery: vr.battery, status: vr.status, phase: vr._chargingPhase, task: vr.task ? vr.task.taskId : null },
        stationId: vr.chargingView().stationId || null,
        toDepotM: haversineMeters(vr.lat, vr.lon, DEPOT.lat, DEPOT.lon),
        reservations: rowsOf(world, "chargerReservation").map((row) => ({ state: row.state, externalId: row.externalId, chargerDbId: row.chargerDbId, targetSoc: row.targetSoc })),
      });

      // A round taken while the robot charges (current flowing at the depot plug): a second Leg
      // arrives, and the real engine must not give it to this robot.
      if (!midChargeRound && vr._chargingPhase === "CHARGING" && vr.battery > 50) {
        leg2 = loop.addLeg(world, { legKey: "LOOP-2", pickup: cw.MBA, drop: cw.AWAY });
        // eslint-disable-next-line no-await-in-loop
        midChargeRound = await loop.runRound(world, { legRowId: leg2.leg.id });
      }
      if (vr._chargingPhase === null && vr.battery >= 79.9 && rowsOf(world, "chargerReservation").some((row) => row.state === "RELEASED")) break;
    }

    // B. The delivery ran to a graded completion; the server settled the Leg and released the commitment.
    expect(legStates).toEqual(["ACCEPTED", "EN_ROUTE_PICKUP", "AT_PICKUP", "LOADED", "EN_ROUTE_DROP", "AT_DROP", "SETTLED"]);
    expect(rowsOf(world, "task").find((row) => row.taskId === "TSK-LOOP-1").status).toBe("COMPLETED");
    expect(rowsOf(world, "commitment").find((row) => row.id === commitment1.id).releasedAt).toBeInstanceOf(Date);
    // It crossed 20 % on the delivery and kept going: no session while it had a task.
    const crossedOnTask = ticks.find((t) => t.after.task && t.after.battery <= 20);
    expect(crossedOnTask).toBeDefined();
    expect(ticks.filter((t) => t.after.task).every((t) => t.after.phase === null)).toBe(true);
    // The session began on the first idle tick after the delivery, below the trigger.
    const seek = ticks.find((t) => t.before.phase === null && t.after.phase === "SEEKING");
    expect(seek).toBeDefined();
    expect(seek.before.task === null || seek.after.task === null).toBe(true);
    expect(seek.after.battery).toBeLessThanOrEqual(20);
    expect(ticks.filter((t) => t.after.phase === "SEEKING").length).toBeGreaterThan(0);

    // The reservation: one row, at the depot, for the 80 % target, granted (ACTIVE) before docking.
    const reservations = rowsOf(world, "chargerReservation");
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ agentId: world.agentRowId, chargerDbId: depotRow.id, targetSoc: 0.8 });
    const approaching = ticks.filter((t) => t.after.phase === "APPROACHING");
    expect(approaching.length).toBeGreaterThan(0);
    expect(approaching.every((t) => t.after.status === "RETURNING" && t.stationId === "V1DEMO-DEPOT-01")).toBe(true);

    // C. Charging never began before docking, and only at the depot, within the docking radius.
    const firstCharging = ticks.find((t) => t.after.status === "CHARGING");
    expect(firstCharging).toBeDefined();
    expect(firstCharging.toDepotM).toBeLessThanOrEqual(chargerRoute.DOCKING_RADIUS_M);
    expect(ticks.filter((t) => t.i < firstCharging.i).every((t) => t.after.status !== "CHARGING")).toBe(true);
    // The battery rose ONLY on ticks spent CHARGING at the depot with the plug ACTIVE, and on
    // every tick current flowed; it never went past the 80 % target.
    const rises = ticks.filter((t) => t.after.battery > t.before.battery + 1e-9);
    expect(rises.length).toBeGreaterThan(100);
    for (const t of rises) {
      expect(t.before.status).toBe("CHARGING");
      expect(t.toDepotM).toBeLessThanOrEqual(chargerRoute.DOCKING_RADIUS_M);
      expect(t.reservations.some((row) => row.state === "ACTIVE")).toBe(true);
    }
    const flowing = ticks.filter((t) => t.before.phase === "CHARGING" && t.after.phase === "CHARGING");
    expect(flowing.every((t) => t.after.battery > t.before.battery)).toBe(true);
    expect(Math.max(...ticks.map((t) => t.after.battery))).toBeLessThanOrEqual(80 + 1e-9);
    expect(vr.battery).toBeGreaterThanOrEqual(79.9);
    // Released at the target; nothing live remains.
    expect(rowsOf(world, "chargerReservation")[0]).toMatchObject({ state: "RELEASED", externalId: "TARGET_REACHED" });
    expect(live(world)).toEqual([]);
    expect(vr.status).toBe("IDLE");
    expect(haversineMeters(vr.lat, vr.lon, DEPOT.lat, DEPOT.lon)).toBeLessThanOrEqual(chargerRoute.DOCKING_RADIUS_M);
    // Every telemetry frame was accepted (§23.5's energy row never refused the charge's rise).
    expect(lines.filter((l) => /TELEMETRY refused/.test(l.msg))).toEqual([]);

    // The mid-charge round: the reservation kept the robot out of the index; nothing was committed.
    expect(midChargeRound).not.toBeNull();
    expect(midChargeRound.indexed.filter((row) => row.agentId === ROBOT && row.availabilityClass === "IDLE_READY")).toEqual([]);
    expect(midChargeRound.winner).toBeNull();
    expect(midChargeRound.committed).toBeNull();
    expect(rowsOf(world, "commitment").filter((row) => row.legId === leg2.leg.id)).toEqual([]);

    // ── D. Re-indexing and reassignment ────────────────────────────────────────────────────
    // The charging classifier the index maintainer uses now states, positively, "not charging".
    const classifier = chargingStatus.createChargingStatusReader({ prisma: world.prisma, inScope: () => true });
    expect(await classifier(world.agentRowId)).toMatchObject({ known: true, charging: false, waiting: false });
    // What the server holds is what the robot reported: IDLE at the depot at 80 %, no live commitment.
    const robotRow = rowsOf(world, "robot").find((row) => row.robotId === ROBOT);
    expect(robotRow.status).toBe("IDLE");
    expect(robotRow.battery).toBeGreaterThanOrEqual(79.9);
    expect(rowsOf(world, "batteryState").find((row) => row.agentId === world.agentRowId).lastObservedSoc).toBeGreaterThanOrEqual(0.799);
    const lastFix = rowsOf(world, "observation").filter((row) => row.agentId === world.agentRowId && row.kind === "position").slice(-1)[0];
    expect(haversineMeters(lastFix.value.lat, lastFix.value.lon, DEPOT.lat, DEPOT.lon)).toBeLessThanOrEqual(chargerRoute.DOCKING_RADIUS_M);
    expect(rowsOf(world, "commitment").filter((row) => row.agentId === world.agentRowId && row.releasedAt === null)).toEqual([]);
    // Those rows were written by production code after setup, not by this test.
    const laterWrites = world.store.writes.slice(writesAtSetup);
    for (const model of ["robot", "batteryState", "observation", "chargerReservation", "commitment"]) {
      expect(laterWrites.some((entry) => entry.model === model)).toBe(true);
    }

    // Round 2 — the same Leg the mid-charge round could not assign, decided again now.
    const r2 = await loop.runRound(world, { legRowId: leg2.leg.id });
    expect(r2.indexErrors).toEqual([]);
    expect(r2.indexed).toEqual([expect.objectContaining({ agentId: ROBOT, availabilityClass: "IDLE_READY" })]);
    expect(r2.gated).toEqual([ROBOT]);
    expect(r2.denials).toEqual({});
    expect([...r2.evaluatedPredicates[ROBOT]].sort()).toEqual([...ALL_PREDICATES].sort());
    // The projection the simulator published at boot is ~20 min old: the return is priced on the
    // depot-only fallback (§14.5), never against the stale availability.
    expect(r2.returnReach[ROBOT]).toMatchObject({ basis: "DEPOT_ONLY", chargerId: "V1DEMO-DEPOT-01", reachable: true });
    expect(r2.outcome).toBe("ASSIGNED");
    expect(r2.winner).toBe(ROBOT);
    expect(r2.committed).toMatchObject({ outcome: "COMMITTED", committed: true });
    const commitment2 = rowsOf(world, "commitment").find((row) => row.legId === leg2.leg.id);
    expect(commitment2).toMatchObject({ agentId: world.agentRowId, releasedAt: null });
    expect(commitment2.commitmentId).not.toBe(commitment1.commitmentId);
    const offerRow2 = rowsOf(world, "outbox").find((row) => row.command === "OFFER" && row.commitmentId === commitment2.commitmentId);
    expect(offerRow2).toBeDefined();

    const drained2 = await loop.drainOutbox(world);
    await loop.settleDeep(80);
    expect(drained2.delivered).toBe(1);
    expect(offersTo(connection)).toHaveLength(2);
    expect(offersTo(connection)[1].payload).toMatchObject({ outboxId: offerRow2.id, commitmentId: commitment2.commitmentId });
    expect(accepts(connection).map((entry) => entry.payload.commitmentId)).toEqual([commitment1.commitmentId, commitment2.commitmentId]);
    expect(rowsOf(world, "leg").find((row) => row.id === leg2.leg.id).state).toBe("ACCEPTED");
    expect(vr.task && vr.task.taskId).toBe("TSK-LOOP-2");

    // No handler logged a failure anywhere in the loop.
    expect(lines.filter((l) => l.level === "error")).toEqual([]);
  } finally {
    await world.close();
  }
});

"use strict";

/**
 * Operator holds: where a PAUSED simulated robot's hold comes from, and that the SIMULATOR never
 * creates one by itself (2026-10-13 investigation).
 *
 * LOCAL evidence (read-only, `tools/ops/operatorHolds.js`): all five simulated robots are PAUSED by
 * acknowledged STOP commands — four at 19:01:43.631–.657Z on 2026-10-12, one burst of five within
 * 26 ms, the dashboard's "EXECUTE GLOBAL EMERGENCY STOP" (`AppProvider.stopAll`, behind the
 * authorisation dialog), plus two single STOPs to SIM-2D8E at 19:03:35Z and 19:03:42Z. Each placed
 * the server-side hold (`robots.controller.placeOperatorHold`) — a legitimate F3 hold. No code path
 * of the simulator writes PAUSED: that is what is pinned here, with the legitimate holds intact.
 *
 * Releasing a hold is the operator's gated act (RESUME, then `POST /clear-fault` under
 * QUARANTINE_OVERRIDE), covered by `tests/unit/robots/p7d1HoldAndRestore.test.js`.
 */

const cw = require("../../helpers/chargingWorld");

require(cw.ENGINE_PATH);

const operatorHolds = require("../../../tools/ops/operatorHolds");

const clock = cw.createClock();
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

async function fleet(rows) {
  const world = cw.createWorld();
  for (const r of rows) {
    cw.addRobotRow(world, { robotId: r.robotId, agentRowId: `agent-${r.robotId}`, battery: r.battery ?? 60, status: r.status, statusBeforeOffline: r.statusBeforeOffline ?? null });
  }
  const booted = await cw.boot(clock, world, rows.map((r) => ({ robotId: r.robotId, at: cw.AT_DEPOT })));
  return { world, ...booted };
}

describe("the simulator never places a hold by itself", () => {
  test("boot → start → ticks → stop → start → reset: robots stored IDLE/ACTIVE never become PAUSED", async () => {
    const { simulator, instances } = await fleet([
      { robotId: "SIM-I1", status: "IDLE" },
      { robotId: "SIM-I2", status: "IDLE", battery: 90 },
      { robotId: "SIM-O1", status: "OFFLINE", statusBeforeOffline: "IDLE" },
    ]);
    const seen = new Set();
    const note = () => instances.forEach((vr) => seen.add(vr.status));
    note();
    simulator.start();
    await cw.runTicks(clock, instances, 20, note);
    simulator.stop();
    note();
    simulator.start();
    await cw.runTicks(clock, instances, 5, note);
    simulator.reset();
    note();
    expect(seen.has("PAUSED")).toBe(false);
    expect(instances.every((vr) => vr._stopLatched === false)).toBe(true);
    simulator.stop();
  });

  test("a robot charging at the depot through a simulator stop/start is not left held", async () => {
    const { simulator, instances } = await fleet([{ robotId: "SIM-C1", status: "IDLE", battery: 10 }]);
    const [vr] = instances;
    await cw.runUntil(clock, vr, () => vr._chargingPhase === "CHARGING", 60);
    simulator.stop();
    simulator.start();
    await cw.runTicks(clock, vr, 5);
    expect(vr.status).not.toBe("PAUSED");
    expect(vr._stopLatched).toBe(false);
    simulator.stop();
  });
});

describe("a legitimate hold is kept: the simulator restores it and never lifts it", () => {
  test.each([
    ["PAUSED (an operator STOP/PAUSE)", { status: "PAUSED" }],
    ["OFFLINE, remembered PAUSED (a STOP before the disconnect)", { status: "OFFLINE", statusBeforeOffline: "PAUSED" }],
  ])("%s → restarts PAUSED and stays PAUSED through ticks, stop/start and reset", async (_label, row) => {
    const { simulator, instances } = await fleet([{ robotId: "SIM-H1", ...row }]);
    const [vr] = instances;
    expect(vr.status).toBe("PAUSED");
    simulator.start();
    await cw.runTicks(clock, vr, 10);
    simulator.stop();
    simulator.start();
    simulator.reset();
    await cw.runTicks(clock, vr, 5);
    expect(vr.status).toBe("PAUSED");
    simulator.stop();
  });

  test("a held robot at low battery does not drive off to charge (the hold outranks the trigger)", async () => {
    const { instances, world } = await fleet([{ robotId: "SIM-H2", status: "PAUSED", battery: 7 }]);
    const [vr] = instances;
    await cw.runTicks(clock, vr, 30);
    expect(vr.status).toBe("PAUSED");
    expect(cw.liveReservations(world)).toHaveLength(0);
    expect({ lat: vr.lat, lon: vr.lon }).toEqual(cw.AT_DEPOT);
  });
});

describe("tools/ops/operatorHolds — provenance, SIMULATED vs PHYSICAL, and the release steps (read-only)", () => {
  const stop = { type: "STOP", status: "ACK", issuedAt: "2026-10-12T19:01:43.657Z" };

  test("a STOP-placed hold names its command and the gated release", () => {
    const row = operatorHolds.describeHold({ robotId: "SIM-0A8C043FFE67", simulated: true, status: "PAUSED" }, [stop]);
    expect(row).toMatchObject({ kind: "SIMULATED", hold: "OPERATOR_HOLD" });
    expect(row.provenance).toBe("STOP command at 2026-10-12T19:01:43.657Z (ACK)");
    expect(row.next).toMatch(/RESUME .*clear-fault .*SUPER_ADMIN/);
  });

  test("a physical robot is labelled PHYSICAL", () => {
    expect(operatorHolds.describeHold({ robotId: "RBT-1", simulated: false, status: "PAUSED" }, [stop]).kind).toBe("PHYSICAL");
  });

  test("a hold with no STOP/PAUSE on record is UNEXPLAINED — investigate, not clear", () => {
    const row = operatorHolds.describeHold({ robotId: "SIM-X", simulated: true, status: "PAUSED" }, [{ type: "RETURN", status: "ACK", issuedAt: "2026-10-02T17:00:03Z" }]);
    expect(row.provenance).toMatch(/^UNEXPLAINED/);
    expect(row.next).toMatch(/investigate/);
  });

  test("OFFLINE remembered PAUSED is a hold; ERROR is a fault, not an operator hold; IDLE is no hold", () => {
    expect(operatorHolds.describeHold({ robotId: "A", simulated: true, status: "OFFLINE", statusBeforeOffline: "PAUSED" }, [stop]).hold).toBe("OPERATOR_HOLD");
    expect(operatorHolds.describeHold({ robotId: "B", simulated: true, status: "ERROR" }, []).hold).toBe("FAULT");
    expect(operatorHolds.describeHold({ robotId: "C", simulated: true, status: "IDLE" }, []).hold).toBeNull();
  });

  test("it reads LOCAL only: a hosted database is refused", () => {
    expect(() => operatorHolds.assertLocalDatabase("postgresql://u:p@ep-example.neon.tech/db")).toThrow(/refused/);
    expect(() => operatorHolds.assertLocalDatabase("postgresql://u:p@127.0.0.1:5433/robotx")).not.toThrow();
  });
});

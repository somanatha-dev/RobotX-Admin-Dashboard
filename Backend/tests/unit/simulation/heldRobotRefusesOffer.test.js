"use strict";

/**
 * Commit-race closure, Gap A — the simulated robot's own half.
 *
 * A robot that is held — PAUSED (an operator STOP/PAUSE, or the server's restart hold), or a STOP
 * latched while it charges — must not accept new work: it answers the OFFER with a REJECT naming
 * the hold (§11.2: "the agent is the authority on its own physical condition"). The server refuses
 * the ACCEPT independently (`tests/unit/sockets/offerAcceptAdmission.test.js`); this is not the
 * only protection, and it is not relied on as one.
 *
 * And a WITHDRAW of the work it was given does not lift the hold: before this, `_applyReturnToBase`
 * wrote IDLE over PAUSED, so the withdrawal the server sends a held robot would have un-paused it.
 */

const VirtualRobot = require("../../../src/simulation/VirtualRobot");

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function pathBetween(fromLat, fromLon, toLat, toLon) {
  return [
    { lat: fromLat, lon: fromLon },
    { lat: (fromLat + toLat) / 2, lon: (fromLon + toLon) / 2 },
    { lat: toLat, lon: toLon },
  ];
}

function makeAgent() {
  const emitted = [];
  const agent = new VirtualRobot({
    robotId: "SIM-HELD",
    lat: 12.9,
    lon: 77.5,
    logger: silentLogger,
    simulated: true,
    telemetryIntervalMs: 1000,
    specification: { massKg: 2, normalSpeedMps: 1.5, maxSpeedMps: 2.5, packNominalWh: 300, payloadCapacityKg: 5 },
    batteryState: { kappa: 1, kappaSampleCount: 0 },
  });
  agent.socket = { connected: true, emit: (event, payload) => emitted.push({ event, payload }), on() {} };
  agent.connected = true;
  agent.battery = 95;
  const of = (event) => emitted.filter((entry) => entry.event === event);
  return { agent, of };
}

/** An executable two-stop offer — the kind an un-held robot accepts. */
const offer = (commitmentId = "CMT-H") => ({
  commitmentId,
  fence: "7",
  payload: {
    taskId: "TASK-H",
    stopSequence: [
      { sequence: 0, stopType: "PICKUP", lat: 12.901, lon: 77.501, path: pathBetween(12.9, 77.5, 12.901, 77.501) },
      { sequence: 1, stopType: "DROP", lat: 12.902, lon: 77.502, path: pathBetween(12.901, 77.501, 12.902, 77.502) },
    ],
  },
});

describe("a held robot refuses new work", () => {
  test("control: an IDLE robot accepts the same offer", () => {
    const { agent, of } = makeAgent();
    agent._respondToOffer(offer());
    expect(of("OFFER_ACCEPT")).toHaveLength(1);
    expect(of("OFFER_REJECT")).toHaveLength(0);
  });

  test("PAUSED: OFFER_REJECT naming the hold, nothing accepted, no task taken", () => {
    const { agent, of } = makeAgent();
    agent.status = "PAUSED";
    agent._respondToOffer(offer());
    expect(of("OFFER_ACCEPT")).toHaveLength(0);
    expect(of("OFFER_REJECT")).toEqual([{ event: "OFFER_REJECT", payload: expect.objectContaining({ commitmentId: "CMT-H", reason: "AGENT_HELD:PAUSED" }) }]);
    expect(agent.task).toBeNull();
    expect(agent.status).toBe("PAUSED");
  });

  test("a STOP latched while charging: OFFER_REJECT, not a DEFER (the robot will end the session PAUSED)", () => {
    const { agent, of } = makeAgent();
    agent.status = "CHARGING";
    agent._stopLatched = true;
    agent._respondToOffer(offer());
    expect(of("OFFER_ACCEPT")).toHaveLength(0);
    expect(of("OFFER_DEFER")).toHaveLength(0);
    expect(of("OFFER_REJECT")[0].payload.reason).toBe("AGENT_HELD:STOP_LATCHED");
  });
});

describe("a WITHDRAW does not lift a hold", () => {
  test("a robot that accepted, was then PAUSED, and is withdrawn stays PAUSED", () => {
    const { agent, of } = makeAgent();
    agent._applyMissionEffect("OFFER", offer("CMT-W"));
    expect(of("OFFER_ACCEPT")).toHaveLength(1);
    agent._applyStop("STOP");
    expect(agent.status).toBe("PAUSED");

    agent._applyMissionEffect("WITHDRAW", { commitmentId: "CMT-W" });
    expect(agent.task).toBeNull();
    expect(agent.status).toBe("PAUSED");
  });

  test("control: a WITHDRAW of an un-held robot's work leaves it IDLE, as before", () => {
    const { agent, of } = makeAgent();
    agent._applyMissionEffect("OFFER", offer("CMT-W2"));
    expect(of("OFFER_ACCEPT")).toHaveLength(1);
    agent._applyMissionEffect("WITHDRAW", { commitmentId: "CMT-W2" });
    expect(agent.task).toBeNull();
    expect(agent.status).toBe("IDLE");
  });
});

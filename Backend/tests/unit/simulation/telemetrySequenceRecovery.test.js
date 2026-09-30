"use strict";

/**
 * P1.3-B — a simulated robot's telemetry `sequence` survives a restart.
 *
 * §2.7's ordering contract, as `positionObservation.service` enforces it: a position frame
 * is admitted only if its sequence exceeds every sequence already accepted for that robot,
 * and the server seeds that high-water mark from the robot's durable position log. The
 * simulator's counter restarted at 1 with every `VirtualRobot` instance, so after a restart
 * each robot was refused as a replay (STALE_SEQUENCE) until it re-counted past its old mark
 * — measured on a live server: 45 accepted frames → ~100 s with every robot unassignable
 * (F16). The fix is on the agent side: `SimulationEngine.addRobot` reads the highest
 * accepted sequence from that same log and the robot resumes above it. The server's check is
 * unchanged, and the last test below shows it still refuses a genuinely stale frame.
 *
 * Every frame here is produced by a real `VirtualRobot` and judged by the real
 * `recordPositionObservation`; the store is an in-memory durable log shared by both.
 */

const { createVirtualRobotSimulator } = require("../../../src/simulation/SimulationEngine");
const VirtualRobot = require("../../../src/simulation/VirtualRobot");
const positionObservation = require("../../../src/services/positionObservation.service");
const { createTestKv } = require("../../helpers/testKv");

const silent = { info() {}, warn() {}, error() {}, debug() {}, child() { return silent; } };
const ROBOTS = ["SIM-A", "SIM-B", "SIM-C"];
const agentOf = (robotId) => `agent-row-${robotId}`;

/** The durable position log, and just enough of Prisma over it for both sides. */
function durableStore() {
  const log = [];
  const prisma = {
    robot: {
      async findUnique({ where }) {
        if (!ROBOTS.includes(where.robotId)) return null;
        return { battery: 80, simulated: true, massKg: null, agent: { id: agentOf(where.robotId), batteryState: null, agentClass: null } };
      },
    },
    observation: {
      async aggregate({ where }) {
        const rows = log.filter((row) => row.agentId === where.agentId && row.kind === where.kind && row.sequence !== null);
        return { _max: { sequence: rows.length ? rows.reduce((m, r) => (r.sequence > m ? r.sequence : m), 0n) : null } };
      },
      async findFirst({ where }) {
        const rows = log.filter((row) => row.agentId === where.agentId && row.kind === where.kind);
        rows.sort((a, b) => b.observedAt - a.observedAt);
        return rows[0] ? { observedAt: rows[0].observedAt, sequence: rows[0].sequence } : null;
      },
      async create({ data }) {
        log.push({ ...data, observedAt: new Date(data.observedAt) });
        return data;
      },
    },
  };
  return { log, prisma };
}

/** A socket that records what the robot emits, as socket.io would carry it. */
function recordingSocket() {
  const emitted = [];
  return { emitted, connected: true, emit: (event, payload) => emitted.push({ event, payload }), on() {}, disconnect() {} };
}

/** A robot as `addRobot` constructs it, with its socket attached and frames recorded. */
function robotWithFloor(robotId, floor) {
  const robot = new VirtualRobot({ robotId, lat: 12.9, lon: 77.5, logger: silent, kv: null, simulated: true, telemetrySequenceFloor: floor });
  const socket = recordingSocket();
  robot.socket = socket;
  robot.connected = true;
  return { robot, socket };
}

// Agent timestamps: strictly increasing, and always in the past (the server bounds clock skew).
let clockMs = 0;
/** Emit `count` frames and submit each to the real server-side admission. */
async function sendFrames(prisma, robot, socket, count) {
  const outcomes = [];
  for (let i = 0; i < count; i += 1) {
    clockMs += 1;
    robot._emitTelemetry(clockMs);
    const frame = socket.emitted[socket.emitted.length - 1].payload;
    // eslint-disable-next-line no-await-in-loop
    const result = await positionObservation.recordPositionObservation(prisma, {
      robotId: frame.robotId,
      lat: frame.lat,
      lon: frame.lon,
      agentTimestampMs: positionObservation.agentTimestampFrom(frame),
      sequence: positionObservation.sequenceFrom(frame),
      maxClockSkewMs: 500,
    });
    outcomes.push({ sequence: frame.sequence, outcome: result.outcome });
  }
  return outcomes;
}

/** What `addRobot` reads for a robot, observed through the engine's own status surface. */
async function engineFloors(prisma, robotIds) {
  const { kv, close } = await createTestKv();
  try {
    const engine = createVirtualRobotSimulator({ prisma, kv, serverUrl: "http://127.0.0.1:0", logger: silent, enabled: true });
    for (const robotId of robotIds) {
      // eslint-disable-next-line no-await-in-loop
      await engine.addRobot({ robotId, simulated: true });
    }
    return Object.fromEntries(engine.getStatus().robots.map((row) => [row.robotId, row.telemetrySequence]));
  } finally {
    await close();
  }
}

/** A server restart: the in-process high-water marks are gone; the durable log is not. */
const restartServer = () => positionObservation.resetPositionObservationState();

beforeEach(() => {
  restartServer();
  clockMs = Date.now() - 600_000;
});

describe("P1.3-B — telemetry sequence across restarts", () => {
  test("1: initial startup — no history, the first frame is 1 and is accepted", async () => {
    const { prisma } = durableStore();
    expect(await engineFloors(prisma, ["SIM-A"])).toEqual({ "SIM-A": 0 });
    const { robot, socket } = robotWithFloor("SIM-A", 0);
    expect(await sendFrames(prisma, robot, socket, 3)).toEqual([
      { sequence: 1, outcome: "WRITTEN" },
      { sequence: 2, outcome: "WRITTEN" },
      { sequence: 3, outcome: "WRITTEN" },
    ]);
  });

  test("2 + 4 + 5: restart after 45 frames — resumes at 46, accepted by a restarted server, strictly increasing", async () => {
    const { prisma } = durableStore();
    const first = robotWithFloor("SIM-A", 0);
    await sendFrames(prisma, first.robot, first.socket, 45);

    restartServer(); // the server process restarts: marks re-seeded from the log (45)
    const floors = await engineFloors(prisma, ["SIM-A"]); // the simulator restarts too
    expect(floors).toEqual({ "SIM-A": 45 });

    const resumed = robotWithFloor("SIM-A", floors["SIM-A"]);
    const outcomes = await sendFrames(prisma, resumed.robot, resumed.socket, 5);
    expect(outcomes.map((row) => row.sequence)).toEqual([46, 47, 48, 49, 50]);
    expect(outcomes.every((row) => row.outcome === "WRITTEN")).toBe(true);
  });

  test("before the fix: a restarted counter (1) is refused as STALE_SEQUENCE — the defect this closes", async () => {
    const { prisma } = durableStore();
    const first = robotWithFloor("SIM-A", 0);
    await sendFrames(prisma, first.robot, first.socket, 45);
    restartServer();
    const unseeded = robotWithFloor("SIM-A", 0);
    const outcomes = await sendFrames(prisma, unseeded.robot, unseeded.socket, 3);
    expect(outcomes.map((row) => row.outcome)).toEqual(["STALE_SEQUENCE", "STALE_SEQUENCE", "STALE_SEQUENCE"]);
  });

  test("3: three robots restart independently — each resumes above its own history, not another's", async () => {
    const { prisma } = durableStore();
    const counts = { "SIM-A": 10, "SIM-B": 200, "SIM-C": 0 };
    for (const [robotId, n] of Object.entries(counts)) {
      const { robot, socket } = robotWithFloor(robotId, 0);
      // eslint-disable-next-line no-await-in-loop
      if (n > 0) await sendFrames(prisma, robot, socket, n);
    }
    restartServer();
    const floors = await engineFloors(prisma, ROBOTS);
    expect(floors).toEqual({ "SIM-A": 10, "SIM-B": 200, "SIM-C": 0 });

    for (const robotId of ROBOTS) {
      const { robot, socket } = robotWithFloor(robotId, floors[robotId]);
      // eslint-disable-next-line no-await-in-loop
      const [next] = await sendFrames(prisma, robot, socket, 1);
      expect(next).toEqual({ sequence: counts[robotId] + 1, outcome: "WRITTEN" });
    }
  });

  test("a simulator restart while the server keeps running also resumes cleanly", async () => {
    const { prisma } = durableStore();
    const first = robotWithFloor("SIM-B", 0);
    await sendFrames(prisma, first.robot, first.socket, 12);
    // No server restart: its in-process mark (12) is still live.
    const floors = await engineFloors(prisma, ["SIM-B"]);
    const resumed = robotWithFloor("SIM-B", floors["SIM-B"]);
    expect(await sendFrames(prisma, resumed.robot, resumed.socket, 1)).toEqual([{ sequence: 13, outcome: "WRITTEN" }]);
  });

  test("7: a genuinely stale or repeated frame is still refused — the safety check is untouched", async () => {
    const { prisma } = durableStore();
    const { robot, socket } = robotWithFloor("SIM-C", 0);
    await sendFrames(prisma, robot, socket, 5);
    const judge = (sequence) =>
      positionObservation.recordPositionObservation(prisma, {
        robotId: "SIM-C", lat: 12.9, lon: 77.5, agentTimestampMs: (clockMs += 1), sequence: BigInt(sequence), maxClockSkewMs: 500,
      });
    expect((await judge(5)).outcome).toBe("STALE_SEQUENCE"); // a repeat
    expect((await judge(2)).outcome).toBe("STALE_SEQUENCE"); // a regression
    restartServer();
    expect((await judge(5)).outcome).toBe("STALE_SEQUENCE"); // still refused after a restart
    expect((await judge(6)).outcome).toBe("WRITTEN");
  });

  test("a failed history read falls back to the old behaviour (resume from 0), and says so", async () => {
    const { prisma } = durableStore();
    prisma.observation.aggregate = async () => { throw new Error("store unavailable"); };
    expect(await engineFloors(prisma, ["SIM-A"])).toEqual({ "SIM-A": 0 });
  });
});

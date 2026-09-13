"use strict";

/**
 * STEP 5 — the telemetry → position Observation → AgentCellPosition bridge.
 *
 * ── What is being asserted, and what deliberately is not ────────────────────
 * These tests cover the *bridge*: that an accepted telemetry frame becomes one canonical
 * §2.7 Observation carrying the agent's own timestamp and an explicit provenance, that a
 * frame which was not accepted becomes nothing, and that `indexMaintainer.worker.js` turns
 * those rows — and only those rows — into `AgentCellPosition`.
 *
 * They assert nothing about assignment. A populated `AgentCellPosition` is a candidate the
 * engine *can see*; it is not a decision, not a commitment, and not movement. The
 * coordinator's own prerequisites are unchanged and still unmet (B1), and no test here
 * touches them.
 */

const positionObservation = require("../../src/services/positionObservation.service");
const indexMaintainer = require("../../src/workers/indexMaintainer.worker");
const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
const cells = require("../../src/engine/spatial/cells");
const observationDomain = require("../../src/engine/domain/observation");

const BENGALURU = { lat: 12.9716, lon: 77.5946 };

/**
 * A prisma double narrow enough that a call the writer does not make is visible, and wide
 * enough that a call it does make is not silently absorbed. The `observation` table is a
 * real array, because half of what is under test is *what ends up in it*.
 */
function fakePrisma(options = {}) {
  const robots = new Map(options.robots || []);
  const observations = [];
  return {
    observations,
    robot: {
      findUnique: jest.fn(async ({ where }) => robots.get(where.robotId) || null),
    },
    observation: {
      findFirst: jest.fn(async ({ where, orderBy }) => {
        const matching = observations
          .filter((row) => row.agentId === where.agentId && row.kind === where.kind)
          .sort((a, b) =>
            orderBy && orderBy.observedAt === "desc"
              ? b.observedAt.getTime() - a.observedAt.getTime()
              : a.observedAt.getTime() - b.observedAt.getTime(),
          );
        return matching[0] || null;
      }),
      create: jest.fn(async ({ data }) => {
        observations.push({ ...data, observedAt: new Date(data.observedAt) });
        return data;
      }),
    },
  };
}

/** A Robot row as the resolver's `select` returns it. */
function robotRow(agentRowId, simulated) {
  return { simulated, agent: { id: agentRowId } };
}

beforeEach(() => {
  positionObservation.resetPositionObservationState();
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Step 5.1 — an accepted telemetry position becomes one canonical Observation", () => {
  test("a PHYSICAL robot's frame creates a position Observation labelled PHYSICAL", async () => {
    const prisma = fakePrisma({ robots: [["RBT-1", robotRow("agent-row-1", false)]] });

    const result = await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-1",
      lat: BENGALURU.lat,
      lon: BENGALURU.lon,
      agentTimestampMs: 1_700_000_000_000,
      sequence: 1n,
    });

    expect(result).toMatchObject({
      written: true,
      outcome: positionObservation.OUTCOME.WRITTEN,
      provenance: "PHYSICAL",
      agentRowId: "agent-row-1",
    });
    expect(prisma.observations).toHaveLength(1);
    expect(prisma.observations[0]).toMatchObject({
      agentId: "agent-row-1",
      kind: "position",
      source: observationDomain.OBSERVATION_SOURCE.AGENT_REPORT,
      value: { lat: BENGALURU.lat, lon: BENGALURU.lon, provenance: "PHYSICAL" },
    });
  });

  test("a SIMULATED robot's frame creates a position Observation through the same call", async () => {
    const prisma = fakePrisma({ robots: [["SIM-A", robotRow("agent-row-sim", true)]] });

    const result = await positionObservation.recordPositionObservation(prisma, {
      robotId: "SIM-A",
      lat: BENGALURU.lat,
      lon: BENGALURU.lon,
      agentTimestampMs: 1_700_000_000_000,
      sequence: 1n,
    });

    expect(result.written).toBe(true);
    expect(prisma.observations[0].value.provenance).toBe("SIMULATED");
    // The same kind and the same source. A second pipeline would show up here as a
    // different value in one of these two fields.
    expect(prisma.observations[0].kind).toBe("position");
    expect(prisma.observations[0].source).toBe(observationDomain.OBSERVATION_SOURCE.AGENT_REPORT);
  });

  test("the kind the writer emits is the kind the index maintainer queries", () => {
    // Stated as an assertion rather than as a shared constant only, because the two are in
    // different layers and a rename in one is exactly how the pipe would silently empty.
    const workerSource = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "src", "workers", "indexMaintainer.worker.js"),
      "utf8",
    );
    expect(workerSource).toContain(`kind: "${positionObservation.POSITION_KIND}"`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Step 5.2 — simulated evidence is distinguishable and is never physical", () => {
  test("isPhysicalEvidence is true only for an explicitly PHYSICAL row", () => {
    expect(positionObservation.isPhysicalEvidence({ value: { provenance: "PHYSICAL" } })).toBe(true);
    expect(positionObservation.isPhysicalEvidence({ value: { provenance: "SIMULATED" } })).toBe(false);
    // A row from before this writer existed carries no label. An absent label is NOT a
    // physical one — this is the assertion that keeps the gate one-sided.
    expect(positionObservation.isPhysicalEvidence({ value: { lat: 1, lon: 2 } })).toBe(false);
    expect(positionObservation.isPhysicalEvidence({ value: null })).toBe(false);
    expect(positionObservation.isPhysicalEvidence(null)).toBe(false);
    expect(positionObservation.isPhysicalEvidence({ value: { provenance: "physical" } })).toBe(false);
  });

  test("isSimulatedEvidence is likewise strictly positive", () => {
    expect(positionObservation.isSimulatedEvidence({ value: { provenance: "SIMULATED" } })).toBe(true);
    expect(positionObservation.isSimulatedEvidence({ value: { provenance: "PHYSICAL" } })).toBe(false);
    expect(positionObservation.isSimulatedEvidence({ value: {} })).toBe(false);
  });

  test("a simulated observation never satisfies the physical-evidence predicate", async () => {
    const prisma = fakePrisma({ robots: [["SIM-A", robotRow("agent-row-sim", true)]] });
    await positionObservation.recordPositionObservation(prisma, {
      robotId: "SIM-A",
      lat: 1,
      lon: 2,
      agentTimestampMs: 1_700_000_000_000,
    });
    expect(positionObservation.isPhysicalEvidence(prisma.observations[0])).toBe(false);
    expect(positionObservation.isSimulatedEvidence(prisma.observations[0])).toBe(true);
  });

  test("a Robot row whose `simulated` column was not read writes NOTHING", async () => {
    // The `select`-narrowing developer error. Answering "PHYSICAL" for it would label
    // simulator output as physical evidence with nobody having written a line to do it.
    const prisma = fakePrisma({ robots: [["RBT-X", { agent: { id: "agent-x" } }]] });
    const result = await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-X",
      lat: 1,
      lon: 2,
      agentTimestampMs: 1_700_000_000_000,
    });
    expect(result.written).toBe(false);
    expect(result.outcome).toBe(positionObservation.OUTCOME.AGENT_NOT_PROJECTED);
    expect(prisma.observations).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Step 5.3 — the observation timestamp is the agent's, and is never substituted", () => {
  test("observedAt is exactly the agent-supplied timestamp, not the time of the write", async () => {
    const prisma = fakePrisma({ robots: [["RBT-1", robotRow("agent-row-1", false)]] });
    const agentMeasuredAt = 1_699_000_000_000;

    await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-1",
      lat: 1,
      lon: 2,
      agentTimestampMs: agentMeasuredAt,
    });

    expect(prisma.observations[0].observedAt.getTime()).toBe(agentMeasuredAt);
    // …and it is emphatically not "now". The frame is stamped in 2023; the test runs now.
    expect(Math.abs(Date.now() - agentMeasuredAt)).toBeGreaterThan(60_000);
  });

  test("a frame with no agent timestamp produces NO observation rather than a receipt-time one", async () => {
    const prisma = fakePrisma({ robots: [["RBT-1", robotRow("agent-row-1", false)]] });
    const result = await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-1",
      lat: 1,
      lon: 2,
      agentTimestampMs: null,
    });
    expect(result.outcome).toBe(positionObservation.OUTCOME.NO_AGENT_TIMESTAMP);
    expect(prisma.observations).toHaveLength(0);
  });

  test("agentTimestampFrom reads the wire field and refuses everything that is not one", () => {
    expect(positionObservation.agentTimestampFrom({ timestamp: 1_700_000_000_000 })).toBe(1_700_000_000_000);
    expect(positionObservation.agentTimestampFrom({ timestamp: "1700000000000" })).toBe(1_700_000_000_000);
    expect(positionObservation.agentTimestampFrom({ timestamp: 0 })).toBeNull();
    expect(positionObservation.agentTimestampFrom({ timestamp: -1 })).toBeNull();
    expect(positionObservation.agentTimestampFrom({ timestamp: "soon" })).toBeNull();
    expect(positionObservation.agentTimestampFrom({ timestamp: NaN })).toBeNull();
    expect(positionObservation.agentTimestampFrom({})).toBeNull();
    expect(positionObservation.agentTimestampFrom(null)).toBeNull();
  });

  test("the domain module itself refuses an observation with no observedAt", () => {
    // The writer's refusal is not the only line of defence: `createObservation` is the
    // contract, and it throws. Asserted so a future edit that dropped the writer's check
    // still could not produce an unstamped row.
    expect(() =>
      observationDomain.createObservation({
        agentId: "a",
        kind: "position",
        value: { lat: 1, lon: 2 },
        source: "AGENT_REPORT",
      }),
    ).toThrow(/observedAt/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Step 5.4 — stale and out-of-order telemetry cannot overwrite newer position state", () => {
  test("a regressing sequence is refused as a replay", async () => {
    const prisma = fakePrisma({ robots: [["RBT-1", robotRow("agent-row-1", false)]] });
    await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-1", lat: 1, lon: 2, agentTimestampMs: 2_000, sequence: 5n,
    });
    const replay = await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-1", lat: 9, lon: 9, agentTimestampMs: 3_000, sequence: 4n,
    });
    expect(replay.outcome).toBe(positionObservation.OUTCOME.STALE_SEQUENCE);
    expect(prisma.observations).toHaveLength(1);
    expect(prisma.observations[0].value.lat).toBe(1);
  });

  test("a repeated sequence is refused too", async () => {
    const prisma = fakePrisma({ robots: [["RBT-1", robotRow("agent-row-1", false)]] });
    await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-1", lat: 1, lon: 2, agentTimestampMs: 2_000, sequence: 5n,
    });
    const repeat = await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-1", lat: 9, lon: 9, agentTimestampMs: 3_000, sequence: 5n,
    });
    expect(repeat.outcome).toBe(positionObservation.OUTCOME.STALE_SEQUENCE);
    expect(prisma.observations).toHaveLength(1);
  });

  test("an earlier observedAt is refused even when the sequence advances", async () => {
    const prisma = fakePrisma({ robots: [["RBT-1", robotRow("agent-row-1", false)]] });
    await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-1", lat: 1, lon: 2, agentTimestampMs: 5_000, sequence: 1n,
    });
    const late = await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-1", lat: 9, lon: 9, agentTimestampMs: 4_000, sequence: 2n,
    });
    expect(late.outcome).toBe(positionObservation.OUTCOME.STALE_OBSERVED_AT);
    expect(prisma.observations).toHaveLength(1);
  });

  test("an identical observedAt is refused — two frames in one millisecond order nothing", async () => {
    const prisma = fakePrisma({ robots: [["RBT-1", robotRow("agent-row-1", false)]] });
    await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-1", lat: 1, lon: 2, agentTimestampMs: 5_000, sequence: 1n,
    });
    const same = await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-1", lat: 9, lon: 9, agentTimestampMs: 5_000, sequence: 2n,
    });
    expect(same.outcome).toBe(positionObservation.OUTCOME.STALE_OBSERVED_AT);
  });

  test("an advancing frame is accepted, so the guard is not simply refusing everything", async () => {
    const prisma = fakePrisma({ robots: [["RBT-1", robotRow("agent-row-1", false)]] });
    await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-1", lat: 1, lon: 2, agentTimestampMs: 5_000, sequence: 1n,
    });
    const next = await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-1", lat: 3, lon: 4, agentTimestampMs: 6_000, sequence: 2n,
    });
    expect(next.written).toBe(true);
    expect(prisma.observations).toHaveLength(2);
  });

  test("the high-water mark is seeded from the durable log, so a restart admits no older frame", async () => {
    const prisma = fakePrisma({ robots: [["RBT-1", robotRow("agent-row-1", false)]] });
    await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-1", lat: 1, lon: 2, agentTimestampMs: 9_000, sequence: 7n,
    });

    // A restart: the process forgets everything, the database does not.
    positionObservation.resetPositionObservationState();

    const older = await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-1", lat: 9, lon: 9, agentTimestampMs: 8_000, sequence: 6n,
    });
    expect(older.written).toBe(false);
    expect(prisma.observation.findFirst).toHaveBeenCalled();
    expect(prisma.observations).toHaveLength(1);
  });

  test("indexMaintainer takes the NEWEST observation, ordered in the query", async () => {
    // The second half of the ordering guarantee, and the half that holds even if the
    // writer's in-process mark is wrong: the read is `orderBy observedAt desc`.
    const prisma = {
      agent: { findUnique: jest.fn(async () => ({ id: "a1", agentId: "RBT-1", lifecycleState: "ACTIVE", agentClassId: null, capacityOverride: 1 })) },
      observation: { findFirst: jest.fn(async () => ({ value: { lat: 1, lon: 2 }, observedAt: new Date(5_000) })) },
      commitment: { count: jest.fn(async () => 0) },
    };
    await indexMaintainer.assembleRecord({ prisma }, "a1", 99_000);
    expect(prisma.observation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId: "a1", kind: "position" },
        orderBy: { observedAt: "desc" },
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Step 5.5 — agent resolution reuses the existing 1:1 Robot → Agent projection", () => {
  test("the Agent.id on the observation is the one the Robot row projects to", async () => {
    const prisma = fakePrisma({ robots: [["RBT-7", robotRow("the-agent-row-id", false)]] });
    const result = await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-7", lat: 1, lon: 2, agentTimestampMs: 1_000,
    });
    expect(result.agentRowId).toBe("the-agent-row-id");
    expect(prisma.observations[0].agentId).toBe("the-agent-row-id");
  });

  test("an unprojected robot writes nothing, and no Agent is invented for it", async () => {
    const prisma = fakePrisma({ robots: [["RBT-8", { simulated: false, agent: null }]] });
    const result = await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-8", lat: 1, lon: 2, agentTimestampMs: 1_000,
    });
    expect(result.outcome).toBe(positionObservation.OUTCOME.AGENT_NOT_PROJECTED);
    expect(prisma.observations).toHaveLength(0);
  });

  test("an unknown robotId writes nothing", async () => {
    const prisma = fakePrisma({ robots: [] });
    const result = await positionObservation.recordPositionObservation(prisma, {
      robotId: "GHOST", lat: 1, lon: 2, agentTimestampMs: 1_000,
    });
    expect(result.outcome).toBe(positionObservation.OUTCOME.AGENT_NOT_PROJECTED);
    expect(prisma.observations).toHaveLength(0);
  });

  test("the binding is resolved once per robot and then cached", async () => {
    const prisma = fakePrisma({ robots: [["RBT-1", robotRow("agent-row-1", false)]] });
    for (let i = 1; i <= 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await positionObservation.recordPositionObservation(prisma, {
        robotId: "RBT-1", lat: 1, lon: 2, agentTimestampMs: 1_000 * i, sequence: BigInt(i),
      });
    }
    expect(prisma.observations).toHaveLength(3);
    expect(prisma.robot.findUnique).toHaveBeenCalledTimes(1);
  });

  test("the decommission path calls forget() — the export has a production caller", () => {
    // The family this project keeps finding: a function written, tested, and called from
    // nowhere. Asserted structurally because the alternative is driving an HTTP delete for
    // one line, and because what matters is that the call site exists at all.
    const controller = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "src", "controllers", "robots.controller.js"),
      "utf8",
    );
    expect(controller).toContain("positionObservation.forget(robotCode)");
    expect(controller).toContain('require("../services/positionObservation.service")');
  });

  test("forget() drops one robot's binding without disturbing another's", async () => {
    const prisma = fakePrisma({
      robots: [["RBT-1", robotRow("agent-1", false)], ["SIM-A", robotRow("agent-2", true)]],
    });
    await positionObservation.recordPositionObservation(prisma, { robotId: "RBT-1", lat: 1, lon: 2, agentTimestampMs: 1_000 });
    await positionObservation.recordPositionObservation(prisma, { robotId: "SIM-A", lat: 1, lon: 2, agentTimestampMs: 1_000 });
    expect(prisma.robot.findUnique).toHaveBeenCalledTimes(2);

    positionObservation.forget("RBT-1");
    await positionObservation.recordPositionObservation(prisma, { robotId: "RBT-1", lat: 1, lon: 2, agentTimestampMs: 2_000 });
    await positionObservation.recordPositionObservation(prisma, { robotId: "SIM-A", lat: 1, lon: 2, agentTimestampMs: 2_000 });
    expect(prisma.robot.findUnique).toHaveBeenCalledTimes(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Step 5.6 — physical and simulated agents coexist and stay independent", () => {
  test("two robots of different provenance are written under their own agent ids and labels", async () => {
    const prisma = fakePrisma({
      robots: [["RBT-1", robotRow("agent-phys", false)], ["SIM-A", robotRow("agent-sim", true)]],
    });

    await positionObservation.recordPositionObservation(prisma, {
      robotId: "RBT-1", lat: 12.9, lon: 77.5, agentTimestampMs: 1_000, sequence: 1n,
    });
    await positionObservation.recordPositionObservation(prisma, {
      robotId: "SIM-A", lat: 12.8, lon: 77.4, agentTimestampMs: 1_000, sequence: 1n,
    });

    expect(prisma.observations).toHaveLength(2);
    const byAgent = new Map(prisma.observations.map((row) => [row.agentId, row]));
    expect(byAgent.get("agent-phys").value.provenance).toBe("PHYSICAL");
    expect(byAgent.get("agent-sim").value.provenance).toBe("SIMULATED");
  });

  test("several simulated robots keep independent sequence and timestamp state", async () => {
    const prisma = fakePrisma({
      robots: [
        ["SIM-A", robotRow("agent-a", true)],
        ["SIM-B", robotRow("agent-b", true)],
        ["SIM-C", robotRow("agent-c", true)],
      ],
    });

    // A advances to sequence 9; B and C are still at 1. B's frame at sequence 2 must not be
    // measured against A's mark.
    for (const seq of [1n, 5n, 9n]) {
      // eslint-disable-next-line no-await-in-loop
      await positionObservation.recordPositionObservation(prisma, {
        robotId: "SIM-A", lat: 1, lon: 1, agentTimestampMs: 1_000 * Number(seq), sequence: seq,
      });
    }
    await positionObservation.recordPositionObservation(prisma, {
      robotId: "SIM-B", lat: 2, lon: 2, agentTimestampMs: 1_000, sequence: 1n,
    });
    const bSecond = await positionObservation.recordPositionObservation(prisma, {
      robotId: "SIM-B", lat: 3, lon: 3, agentTimestampMs: 2_000, sequence: 2n,
    });
    const cFirst = await positionObservation.recordPositionObservation(prisma, {
      robotId: "SIM-C", lat: 4, lon: 4, agentTimestampMs: 1_000, sequence: 1n,
    });

    expect(bSecond.written).toBe(true);
    expect(cFirst.written).toBe(true);
    expect(prisma.observations.filter((row) => row.agentId === "agent-a")).toHaveLength(3);
    expect(prisma.observations.filter((row) => row.agentId === "agent-b")).toHaveLength(2);
    expect(prisma.observations.filter((row) => row.agentId === "agent-c")).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Step 5.7 — indexMaintainer turns position Observations into AgentCellPosition", () => {
  /** A prisma double for the maintainer's three reads and its mirror write. */
  function maintainerPrisma(observationRow) {
    const rows = new Map();
    return {
      rows,
      agent: {
        findUnique: jest.fn(async () => ({
          id: "a1", agentId: "RBT-1", lifecycleState: "ACTIVE", agentClassId: null, capacityOverride: 2,
        })),
        findMany: jest.fn(async () => [{ id: "a1" }]),
      },
      observation: { findFirst: jest.fn(async () => observationRow) },
      commitment: { count: jest.fn(async () => 0) },
      agentCellPosition: {
        findUnique: jest.fn(async ({ where }) => rows.get(where.agentId) || null),
        upsert: jest.fn(async ({ where, create, update }) => {
          const existing = rows.get(where.agentId);
          const next = existing ? { ...existing, ...update } : { ...create };
          rows.set(where.agentId, next);
          return next;
        }),
        delete: jest.fn(async ({ where }) => {
          rows.delete(where.agentId);
        }),
      },
    };
  }

  test("a valid position Observation becomes an AgentCellPosition row in the existing H3 cell", async () => {
    const observedAt = new Date(1_700_000_000_000);
    const prisma = maintainerPrisma({ value: { lat: BENGALURU.lat, lon: BENGALURU.lon, provenance: "PHYSICAL" }, observedAt });

    const outcome = await indexMaintainer.sweepAgents({ prisma, kv: null }, ["a1"]);

    expect(outcome).toMatchObject({ processed: 1, indexed: 1, failed: 0 });
    const row = prisma.rows.get("a1");
    // The cell ids are `engine/spatial/cells.js`'s, computed through
    // `availabilityIndex.positionRecord` — not recomputed here by a second implementation.
    expect(row.fineCellId).toBe(cells.cellForPoint(BENGALURU.lat, BENGALURU.lon, cells.RESOLUTION.FINE));
    expect(row.coarseCellId).toBe(cells.coarseParentOf(row.fineCellId));
    expect(availabilityIndex.AVAILABILITY_CLASSES).toContain(row.availabilityClass);
  });

  test("observedAtMs is the Observation's own instant, NOT the sweep's clock", async () => {
    const observedAt = new Date(1_700_000_000_000);
    const prisma = maintainerPrisma({ value: { lat: BENGALURU.lat, lon: BENGALURU.lon }, observedAt });

    const sweepClock = 1_700_000_600_000; // ten minutes after the fix was taken
    await indexMaintainer.sweepAgents({ prisma, kv: null, now: () => sweepClock }, ["a1"]);

    expect(prisma.rows.get("a1").observedAtMs).toBe(BigInt(observedAt.getTime()));
    expect(prisma.rows.get("a1").observedAtMs).not.toBe(BigInt(sweepClock));
  });

  test("a second sweep does not refresh observedAtMs for an unchanged observation", async () => {
    // The defect this replaces was self-concealing: the 5 s loop rewrote the column with
    // its own clock, so the mirror could never be seen to age. Two sweeps, one fix.
    const observedAt = new Date(1_700_000_000_000);
    const prisma = maintainerPrisma({ value: { lat: BENGALURU.lat, lon: BENGALURU.lon }, observedAt });

    await indexMaintainer.sweepAgents({ prisma, kv: null, now: () => 1_700_000_005_000 }, ["a1"]);
    await indexMaintainer.sweepAgents({ prisma, kv: null, now: () => 1_700_000_600_000 }, ["a1"]);

    expect(prisma.rows.get("a1").observedAtMs).toBe(BigInt(observedAt.getTime()));
  });

  test("no AgentCellPosition is created when no position Observation exists", async () => {
    const prisma = maintainerPrisma(null);
    const outcome = await indexMaintainer.sweepAgents({ prisma, kv: null }, ["a1"]);
    expect(outcome).toMatchObject({ processed: 1, indexed: 0, failed: 0 });
    expect(prisma.agentCellPosition.upsert).not.toHaveBeenCalled();
    expect(prisma.rows.size).toBe(0);
  });

  test("no AgentCellPosition is created when the observation carries no usable coordinates", async () => {
    const prisma = maintainerPrisma({ value: { reason: "NACK" }, observedAt: new Date(1_000) });
    await indexMaintainer.sweepAgents({ prisma, kv: null }, ["a1"]);
    expect(prisma.agentCellPosition.upsert).not.toHaveBeenCalled();
  });

  test("no AgentCellPosition is created when the observation's observedAt is unreadable", async () => {
    const prisma = maintainerPrisma({ value: { lat: 1, lon: 2 }, observedAt: new Date("not-a-date") });
    await indexMaintainer.sweepAgents({ prisma, kv: null }, ["a1"]);
    expect(prisma.agentCellPosition.upsert).not.toHaveBeenCalled();
  });

  test("an existing mirror row is removed once its agent has no indexable position", async () => {
    const prisma = maintainerPrisma({ value: { lat: BENGALURU.lat, lon: BENGALURU.lon }, observedAt: new Date(1_000) });
    await indexMaintainer.sweepAgents({ prisma, kv: null }, ["a1"]);
    expect(prisma.rows.size).toBe(1);

    prisma.observation.findFirst = jest.fn(async () => null);
    const outcome = await indexMaintainer.sweepAgents({ prisma, kv: null }, ["a1"]);
    expect(outcome.removed).toBe(1);
    expect(prisma.rows.size).toBe(0);
  });

  test("the mirror carries no provenance column — the engine cannot see it", async () => {
    const prisma = maintainerPrisma({
      value: { lat: BENGALURU.lat, lon: BENGALURU.lon, provenance: "SIMULATED" },
      observedAt: new Date(1_000),
    });
    await indexMaintainer.sweepAgents({ prisma, kv: null }, ["a1"]);
    const row = prisma.rows.get("a1");
    expect(row).toBeTruthy();
    expect(Object.keys(row)).not.toContain("provenance");
    expect(JSON.stringify(row, (key, value) => (typeof value === "bigint" ? String(value) : value))).not.toContain(
      "SIMULATED",
    );
  });
});

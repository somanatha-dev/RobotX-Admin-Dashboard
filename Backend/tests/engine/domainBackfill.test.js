"use strict";

/**
 * Phase 2 — the legacy mappers and the domain backfill.
 *
 * The plan's testing requirements for this phase:
 *
 * > Migration: forward + rollback on a production-shaped dump; **backfill
 * > idempotency (run twice → identical state)**; referential integrity for every FK.
 * > Unit: **mappers round-trip legacy↔domain**. Property: **every legacy Task maps
 * > to exactly one Mission with exactly one `PRIMARY` Leg and two Stops**.
 *
 * The backfill runs against an in-memory store that behaves like the subset of
 * Prisma it uses — `findMany` with cursor paging, `upsert` on a primary key,
 * `count` with the relation filters `verify()` issues, and `$transaction`. Building
 * one here rather than extending `tests/helpers/mockPrisma.js` keeps the legacy
 * lane's shared helper untouched, which is the property the legacy lane depends on.
 */

const legacyRobot = require("../../src/engine/domain/mappers/legacyRobot");
const legacyTask = require("../../src/engine/domain/mappers/legacyTask");
const work = require("../../src/engine/domain/work");
const backfill = require("../../tools/migrate/backfillDomain");
const { SEED_SPATIAL_MAP } = require("../../prisma/seed");

/* ═══════════════════════════════════════════════════════════════════════════
   An in-memory store with the Prisma surface the backfill uses
   ═══════════════════════════════════════════════════════════════════════════ */

function createStore(seed) {
  const tables = {
    robot: new Map(),
    task: new Map(),
    agent: new Map(),
    mission: new Map(),
    leg: new Map(),
    stop: new Map(),
    region: new Map(),
    cellAssignment: new Map(),
  };

  for (const robot of (seed && seed.robots) || []) tables.robot.set(robot.id, { ...robot });
  for (const task of (seed && seed.tasks) || []) tables.task.set(task.id, { ...task, missionIds: new Set() });
  for (const region of (seed && seed.regions) || []) tables.region.set(region.id, { ...region });

  const rows = (name) => [...tables[name].values()];

  const paged = (name) => async (args) => {
    const options = args || {};
    const sorted = rows(name).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let start = 0;
    if (options.cursor && options.cursor.id) {
      start = sorted.findIndex((row) => row.id === options.cursor.id) + (options.skip || 0);
    }
    const take = options.take === undefined ? sorted.length : options.take;
    return sorted.slice(start, start + take).map((row) => ({ ...row }));
  };

  const upsert = (name) => async ({ where, create, update }) => {
    const key = where.id !== undefined ? where.id : keyOf(where);
    const existing = tables[name].get(key);
    if (existing) {
      const next = { ...existing, ...update };
      applyRelations(name, next, update);
      tables[name].set(key, next);
      return { ...next };
    }
    const created = { ...create, id: create.id === undefined ? key : create.id };
    applyRelations(name, created, create);
    tables[name].set(created.id !== undefined ? created.id : key, created);
    return { ...created };
  };

  // Composite-key support for `cellAssignment`'s `cellId_mapVersion`.
  const keyOf = (where) => {
    const composite = where.cellId_mapVersion;
    if (composite) return `${composite.cellId}@${composite.mapVersion}`;
    return JSON.stringify(where);
  };

  // The only relation write the backfill performs: connecting a Mission to a Task.
  const applyRelations = (name, row, payload) => {
    if (name !== "mission" || !payload || !payload.tasks || !payload.tasks.connect) return;
    delete row.tasks;
    for (const connect of payload.tasks.connect) {
      const task = tables.task.get(connect.id);
      if (task) task.missionIds.add(row.id);
    }
  };

  const client = {
    robot: {
      findMany: paged("robot"),
      count: async (args) => {
        if (args && args.where && args.where.agent && args.where.agent.is === null) {
          const projected = new Set(rows("agent").map((a) => a.robotDbId));
          return rows("robot").filter((robot) => !projected.has(robot.id)).length;
        }
        return tables.robot.size;
      },
    },
    task: {
      findMany: paged("task"),
      count: async (args) => {
        if (args && args.where && args.where.missions && args.where.missions.none) {
          return rows("task").filter((task) => task.missionIds.size === 0).length;
        }
        return tables.task.size;
      },
    },
    agent: {
      upsert: upsert("agent"),
      count: async (args) => {
        if (args && args.where && args.where.robotDbId === null) {
          return rows("agent").filter((agent) => !agent.robotDbId).length;
        }
        return tables.agent.size;
      },
    },
    mission: {
      upsert: upsert("mission"),
      count: async (args) => {
        if (args && args.where && args.where.legs && args.where.legs.none) {
          const withLegs = new Set(rows("leg").map((leg) => leg.missionId));
          return rows("mission").filter((mission) => !withLegs.has(mission.id)).length;
        }
        return tables.mission.size;
      },
    },
    leg: {
      upsert: upsert("leg"),
      count: async (args) => {
        if (args && args.where && args.where.stops && args.where.stops.none) {
          const withStops = new Set(rows("stop").map((stop) => stop.legId));
          return rows("leg").filter((leg) => !withStops.has(leg.id)).length;
        }
        if (args && args.where && args.where.purpose && args.where.purpose.not) {
          return rows("leg").filter((leg) => leg.purpose !== args.where.purpose.not).length;
        }
        return tables.leg.size;
      },
    },
    stop: { upsert: upsert("stop"), count: async () => tables.stop.size },
    region: { findMany: async () => rows("region").map((row) => ({ ...row })) },
    cellAssignment: { upsert: upsert("cellAssignment") },
    $transaction: async (fn) => fn(client),
    __tables: tables,
  };

  return client;
}

/** A stable, comparable snapshot of everything the backfill writes. */
function snapshotOf(store) {
  const dump = (name) =>
    [...store.__tables[name].values()]
      .map((row) => JSON.parse(JSON.stringify(row, (key, value) => (typeof value === "bigint" ? String(value) : value))))
      .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

  return {
    agent: dump("agent"),
    mission: dump("mission"),
    leg: dump("leg"),
    stop: dump("stop"),
    cellAssignment: dump("cellAssignment"),
  };
}

const SEED = {
  regions: [{ id: "region-row-1", regionId: "RGN-BLR" }],
  robots: [
    { id: "robot-row-1", robotId: "RBT-001" },
    { id: "robot-row-2", robotId: "RBT-002" },
  ],
  tasks: [
    {
      id: "task-row-1",
      taskId: "TSK-1000-111",
      status: "PENDING",
      pickup: "Gate A", pickupLat: 12.9, pickupLon: 77.5,
      drop: "Block C", dropLat: 12.91, dropLon: 77.52,
    },
    {
      id: "task-row-2",
      taskId: "TSK-2000-222",
      status: "IN_PROGRESS",
      pickup: "Canteen", pickupLat: 12.92, pickupLon: 77.53,
      drop: "Library", dropLat: 12.93, dropLon: 77.54,
    },
  ],
};

/* ═══════════════════════════════════════════════════════════════════════════
   Mappers
   ═══════════════════════════════════════════════════════════════════════════ */

describe("deterministic identity", () => {
  test("the same legacy key always yields the same id", () => {
    const first = legacyRobot.deterministicId(legacyRobot.ID_NAMESPACE.AGENT, "RBT-001");
    const second = legacyRobot.deterministicId(legacyRobot.ID_NAMESPACE.AGENT, "RBT-001");
    expect(first).toBe(second);
  });

  test("the id is UUID-shaped, so the column type and every consumer keep working", () => {
    const id = legacyRobot.deterministicId(legacyRobot.ID_NAMESPACE.AGENT, "RBT-001");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("different namespaces never collide on the same key", () => {
    const namespaces = Object.values(legacyRobot.ID_NAMESPACE);
    const ids = new Set(namespaces.map((namespace) => legacyRobot.deterministicId(namespace, "SAME-KEY")));
    expect(ids.size).toBe(namespaces.length);
  });

  test("different keys give different ids", () => {
    expect(legacyRobot.deterministicId(legacyRobot.ID_NAMESPACE.AGENT, "RBT-001"))
      .not.toBe(legacyRobot.deterministicId(legacyRobot.ID_NAMESPACE.AGENT, "RBT-002"));
  });
});

describe("Robot → Agent (§2.1)", () => {
  const robot = { id: "robot-row-1", robotId: "RBT-001", status: "PAUSED", isOnline: true, battery: 55 };

  test("the legacy robot code is the Agent's stable identity", () => {
    expect(legacyRobot.robotToAgent(robot).agentId).toBe("RBT-001");
  });

  test("both fencing counters start at zero", () => {
    const agent = legacyRobot.robotToAgent(robot);
    expect(agent.authorityEpoch).toBe(BigInt(0));
    expect(agent.fenceCounter).toBe(BigInt(0));
  });

  test("Robot.status is NOT mapped to lifecycleState — §2.1's separation is preserved", () => {
    // PAUSED means either "paused" or "charging" in the baseline, depending on a
    // Redis key that may have expired. A mapper that folded it into a lifecycle
    // state would carry the baseline's defining ambiguity forward under a new name.
    const agent = legacyRobot.robotToAgent(robot);
    expect(agent.lifecycleState).toBe("ACTIVE");
    expect(Object.keys(agent)).not.toContain("status");
    expect(Object.keys(agent)).not.toContain("activity");
  });

  test("capacityOverride is never a backfill product", () => {
    expect(legacyRobot.robotToAgent(robot).capacityOverride).toBeNull();
  });

  test("the projection keeps the two vocabularies separate and flags an unprojected robot", () => {
    const projected = legacyRobot.toAgentProjection({ ...robot, agent: { agentId: "RBT-001", lifecycleState: "ACTIVE" } });
    expect(projected.agentId).toBe("RBT-001");
    expect(projected.legacy.status).toBe("PAUSED");
    expect(projected.unprojected).toBe(false);

    expect(legacyRobot.toAgentProjection(robot).unprojected).toBe(true);
  });

  test("a robot with no robotId is refused rather than given a fabricated identity", () => {
    expect(() => legacyRobot.robotToAgent({ id: "x" })).toThrow(/robotId/);
  });
});

describe("Task → Mission + Leg + Stops (§2.4)", () => {
  const task = SEED.tasks[0];

  test("exactly one Mission, one PRIMARY Leg, two Stops", () => {
    const { mission, leg, stops } = legacyTask.taskToWork(task);
    expect(mission.missionId).toBe("MSN-TSK-1000-111");
    expect(leg.purpose).toBe("PRIMARY");
    expect(stops).toHaveLength(2);
    expect(work.isPointToPointMission({ legs: [{ ...leg, stops }] })).toBe(true);
  });

  test("custody is NONE — never inferred from the absence of data", () => {
    expect(legacyTask.taskToWork(task).leg.custodyState).toBe("NONE");
  });

  test("the mapping round-trips: decompose then recompose preserves every legacy field", () => {
    const recomposed = legacyTask.workToLegacyTask(legacyTask.taskToWork(task));
    expect(recomposed).toEqual({
      pickup: task.pickup,
      pickupLat: task.pickupLat,
      pickupLon: task.pickupLon,
      drop: task.drop,
      dropLat: task.dropLat,
      dropLon: task.dropLon,
    });
  });

  test("legacy status → §4.2 Task state, with ASSIGNED deliberately unmapped", () => {
    expect(legacyTask.legacyStatusToTaskState("PENDING")).toBe("WAITING");
    expect(legacyTask.legacyStatusToTaskState("IN_PROGRESS")).toBe("IN_EXECUTION");
    expect(legacyTask.legacyStatusToTaskState("COMPLETED")).toBe("COMPLETED");
    // §4.2's states are deliberately coarse; "assigned" is Leg detail, and it is
    // exactly the OFFERED/ACCEPTED/EN_ROUTE_PICKUP distinction §4.3 exists to make.
    expect(legacyTask.legacyStatusToTaskState("ASSIGNED")).toBeNull();
  });

  test("legacy status → §4.3 Leg state claims the least the evidence supports", () => {
    expect(legacyTask.legacyStatusToLegState("PENDING")).toBe("QUEUED");
    expect(legacyTask.legacyStatusToLegState("ASSIGNED")).toBe("ACCEPTED");
    expect(legacyTask.legacyStatusToLegState("IN_PROGRESS")).toBe("EN_ROUTE_PICKUP");
    expect(legacyTask.legacyStatusToLegState("COMPLETED")).toBe("SETTLED");
  });

  test("nothing maps to LOADED — custody is a fact the legacy schema never recorded", () => {
    const mapped = Object.values(legacyTask.LEGACY_STATUS_TO_LEG_STATE);
    expect(mapped).not.toContain("LOADED");
  });

  test("an unrecognised legacy status yields QUEUED, never a terminal state", () => {
    expect(legacyTask.legacyStatusToLegState("SOMETHING_NEW")).toBe("QUEUED");
  });

  test("every §4.2 and §4.3 target the bridge names is a real state", () => {
    for (const state of Object.values(legacyTask.LEGACY_STATUS_TO_TASK_STATE)) {
      if (state !== null) expect(work.isTaskState(state)).toBe(true);
    }
    for (const state of Object.values(legacyTask.LEGACY_STATUS_TO_LEG_STATE)) {
      expect(work.isLegState(state)).toBe(true);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The backfill
   ═══════════════════════════════════════════════════════════════════════════ */

describe("tools/migrate/backfillDomain.js", () => {
  test("converts 100 % of legacy rows with zero orphans", async () => {
    const store = createStore(SEED);
    const report = await backfill.run(store, { spatialMap: SEED_SPATIAL_MAP });

    expect(report.ok).toBe(true);
    expect(report.verification.findings).toEqual([]);
    expect(report.agents).toEqual({ scanned: 2, written: 2 });
    expect(report.work).toEqual({ scanned: 2, missions: 2, legs: 2, stops: 4 });
    expect(report.verification.counts).toEqual({ robots: 2, agents: 2, tasks: 2, missions: 2, legs: 2, stops: 4 });
  });

  test("running it twice produces identical state", async () => {
    const store = createStore(SEED);
    await backfill.run(store, { spatialMap: SEED_SPATIAL_MAP });
    const afterFirst = snapshotOf(store);

    await backfill.run(store, { spatialMap: SEED_SPATIAL_MAP });
    const afterSecond = snapshotOf(store);

    expect(afterSecond).toEqual(afterFirst);
  });

  test("a re-run never resets a monotone fencing counter", async () => {
    const store = createStore(SEED);
    await backfill.run(store, { spatialMap: SEED_SPATIAL_MAP });

    // Phase 3 advances these counters. A backfill re-run that reset one would
    // invalidate a fencing decision already taken against it (§2.6, I6).
    for (const agent of store.__tables.agent.values()) {
      agent.authorityEpoch = BigInt(7);
      agent.fenceCounter = BigInt(4);
    }

    await backfill.run(store, { spatialMap: SEED_SPATIAL_MAP });

    for (const agent of store.__tables.agent.values()) {
      expect(agent.authorityEpoch).toBe(BigInt(7));
      expect(agent.fenceCounter).toBe(BigInt(4));
    }
  });

  test("a re-run never resets a Leg's lifecycle state", async () => {
    const store = createStore(SEED);
    await backfill.run(store, { spatialMap: SEED_SPATIAL_MAP });

    for (const leg of store.__tables.leg.values()) {
      leg.state = "EN_ROUTE_DROP";
      leg.custodyState = "HELD";
      leg.version = 3;
    }

    await backfill.run(store, { spatialMap: SEED_SPATIAL_MAP });

    for (const leg of store.__tables.leg.values()) {
      expect(leg.state).toBe("EN_ROUTE_DROP");
      expect(leg.custodyState).toBe("HELD");
      expect(leg.version).toBe(3);
    }
  });

  test("every backfilled Mission is exactly one PRIMARY Leg and two Stops", async () => {
    const store = createStore(SEED);
    await backfill.run(store, { spatialMap: SEED_SPATIAL_MAP });

    for (const mission of store.__tables.mission.values()) {
      const legs = [...store.__tables.leg.values()].filter((leg) => leg.missionId === mission.id);
      expect(legs).toHaveLength(1);
      const stops = [...store.__tables.stop.values()].filter((stop) => stop.legId === legs[0].id);
      expect(work.isPointToPointMission({ legs: [{ ...legs[0], stops }] })).toBe(true);
    }
  });

  test("it writes no Commitment — that is Phase 3's fenced, leased, guarded transaction", async () => {
    const store = createStore(SEED);
    await backfill.run(store, { spatialMap: SEED_SPATIAL_MAP });
    expect(store.commitment).toBeUndefined();
  });

  test("a dry run writes nothing but reports the same counts", async () => {
    const store = createStore(SEED);
    const report = await backfill.run(store, { spatialMap: SEED_SPATIAL_MAP, dryRun: true });

    expect(report.agents.written).toBe(2);
    expect(report.work.missions).toBe(2);
    expect(store.__tables.agent.size).toBe(0);
    expect(store.__tables.mission.size).toBe(0);
    expect(store.__tables.cellAssignment.size).toBe(0);
  });

  test("the single declared region is used; no region is inferred from geometry", () => {
    expect(backfill.resolveRegionId([{ id: "R1" }], null)).toBe("R1");
    // Two regions and no explicit choice: the assignment is left to be published
    // rather than guessed (§3.6 — containment is by assignment, not geometry).
    expect(backfill.resolveRegionId([{ id: "R1" }, { id: "R2" }], null)).toBeNull();
    expect(backfill.resolveRegionId([{ id: "R1" }, { id: "R2" }], "R2")).toBe("R2");
  });

  test("an invalid spatial map is refused rather than partially mirrored", async () => {
    const store = createStore(SEED);
    const broken = {
      regions: [{ id: "RGN-BLR" }],
      zones: [{ id: "Z1", regionId: "RGN-BLR" }],
      sites: [],
      cells: [
        { cellId: "c1", resolution: "FINE", regionId: "RGN-BLR", zoneId: "Z1" },
        { cellId: "c1", resolution: "FINE", regionId: "RGN-BLR", zoneId: "Z-OTHER" },
      ],
    };
    const report = await backfill.run(store, { spatialMap: broken });

    expect(report.spatial.skipped).toBe(true);
    expect(report.spatial.problems.length).toBeGreaterThan(0);
    expect(store.__tables.cellAssignment.size).toBe(0);
  });

  test("the spatial mirror carries every cell assignment, fine and coarse", async () => {
    const store = createStore(SEED);
    await backfill.run(store, { spatialMap: SEED_SPATIAL_MAP });
    expect(store.__tables.cellAssignment.size).toBe(SEED_SPATIAL_MAP.cells.length);
  });

  test("verification reports an unprojected Robot rather than passing silently", async () => {
    const store = createStore(SEED);
    await backfill.run(store, { spatialMap: SEED_SPATIAL_MAP });

    store.__tables.robot.set("robot-row-3", { id: "robot-row-3", robotId: "RBT-003" });
    const verdict = await backfill.verify(store);

    expect(verdict.ok).toBe(false);
    expect(verdict.findings.join(" ")).toMatch(/no Agent projection/);
  });

  test("verification reports an undecomposed Task rather than passing silently", async () => {
    const store = createStore(SEED);
    await backfill.run(store, { spatialMap: SEED_SPATIAL_MAP });

    store.__tables.task.set("task-row-3", {
      id: "task-row-3", taskId: "TSK-3", status: "PENDING", missionIds: new Set(),
    });
    const verdict = await backfill.verify(store);

    expect(verdict.ok).toBe(false);
    expect(verdict.findings.join(" ")).toMatch(/no Mission/);
  });

  test("verification reports a non-PRIMARY backfilled Leg", async () => {
    const store = createStore(SEED);
    await backfill.run(store, { spatialMap: SEED_SPATIAL_MAP });

    for (const leg of store.__tables.leg.values()) leg.purpose = "REPOSITION";
    const verdict = await backfill.verify(store);

    expect(verdict.ok).toBe(false);
    expect(verdict.findings.join(" ")).toMatch(/purpose other than PRIMARY/);
  });

  test("it pages, so a fleet larger than one batch is fully converted", async () => {
    const many = {
      regions: SEED.regions,
      robots: Array.from({ length: 25 }, (unused, index) => ({
        id: `robot-${String(index).padStart(3, "0")}`,
        robotId: `RBT-${String(index).padStart(3, "0")}`,
      })),
      tasks: [],
    };
    const store = createStore(many);
    const report = await backfill.run(store, { batchSize: 4 });

    expect(report.agents).toEqual({ scanned: 25, written: 25 });
    expect(store.__tables.agent.size).toBe(25);
  });
});

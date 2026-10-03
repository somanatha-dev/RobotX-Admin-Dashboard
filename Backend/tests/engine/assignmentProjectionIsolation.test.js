/**
 * The assignment read model is a **projection**, and this file is where that is a
 * property of the build rather than a claim in a comment (P0-9).
 *
 * Three kinds of assertion:
 *
 *   1. **Structural, outward** — the module imports nothing that could make it part of a
 *      decision: no candidate generation, no feasibility predicate, no cost term, no plan
 *      builder, no solve.
 *   2. **Structural, inward** — nothing in the decision path imports it, so no candidate
 *      set, gate verdict or objective can read what it wrote.
 *   3. **Behavioural** — it writes only legacy columns, only from PENDING, and never a row
 *      the engine reasons from.
 */

const fs = require("fs");
const path = require("path");

const { codeOnly, stripComments, listSourceFiles } = require("../../src/engine/guards/sourceScan");
const projection = require("../../src/services/assignmentProjection.service");
const { createMockPrisma } = require("../helpers/mockPrisma");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const MODULE_PATH = "src/services/assignmentProjection.service.js";

/** Module specifiers a decision would have to reach through. */
const DECISION_PATH_PREFIXES = Object.freeze([
  "engine/candidates",
  "engine/feasibility",
  "engine/cost",
  "engine/plan",
  "engine/solve",
  "engine/pricing",
  "engine/determinism",
]);

function requiresIn(relative) {
  const source = stripComments(fs.readFileSync(path.join(BACKEND_ROOT, relative), "utf8"));
  const pattern = /require\s*\(\s*["']([^"']+)["']\s*\)/gu;
  const specifiers = [];
  let match = pattern.exec(source);
  while (match) {
    specifiers.push(match[1]);
    match = pattern.exec(source);
  }
  return specifiers;
}

describe("structural — the projection cannot participate in a decision", () => {
  test("imports no candidate, feasibility, cost, plan or solve module", () => {
    const specifiers = requiresIn(MODULE_PATH);
    const offending = specifiers.filter((specifier) =>
      DECISION_PATH_PREFIXES.some((prefix) => specifier.includes(prefix)),
    );
    expect(offending).toEqual([]);
  });

  test("imports nothing from src/engine at all", () => {
    const specifiers = requiresIn(MODULE_PATH);
    expect(specifiers.filter((s) => s.includes("engine/"))).toEqual([]);
  });
});

describe("structural — nothing in the decision path can read what it wrote", () => {
  const importers = listSourceFiles(BACKEND_ROOT, { include: ["src"] }).filter((relative) => {
    if (relative === MODULE_PATH) return false;
    const source = codeOnly(fs.readFileSync(path.join(BACKEND_ROOT, relative), "utf8"));
    return /assignmentProjection\.service/u.test(stripComments(fs.readFileSync(path.join(BACKEND_ROOT, relative), "utf8")))
      && source.length > 0;
  });

  test("no module under src/engine imports it", () => {
    expect(importers.filter((relative) => relative.startsWith("src/engine/"))).toEqual([]);
  });

  test("the coordinator's solve path and pipeline do not import it", () => {
    expect(importers).not.toContain("src/workers/coordinatorSolvePath.js");
    expect(importers).not.toContain("src/workers/coordinatorPipeline.js");
    expect(importers).not.toContain("src/workers/coordinator.worker.js");
  });

  test("its only importers are the socket handlers that run after the decision", () => {
    // `offer.handler` projects an accepted assignment; `command.handler` releases it when
    // the agent acknowledges a RECALL / WITHDRAW (2026-10-02). Both run on an agent's
    // response to a command already decided and delivered — neither is on the decision path.
    expect(importers).toEqual(["src/sockets/handlers/command.handler.js", "src/sockets/handlers/offer.handler.js"]);
  });
});

describe("behavioural — it writes only the legacy read model", () => {
  const LEG_ROW = "leg-row-1";
  const TASK = Object.freeze({
    id: "task-row-1",
    taskId: "TSK-1",
    status: "PENDING",
    pickup: "Gate 1",
    pickupLat: 12.9081,
    pickupLon: 77.5012,
    drop: "Block C",
    dropLat: 12.9095,
    dropLon: 77.5031,
  });

  function projectionPrisma({ taskStatus = "PENDING", currentTaskId = null, taskMoved = 1, robotMoved = 1 } = {}) {
    const prisma = createMockPrisma();
    prisma.leg.findUnique.mockResolvedValue({ mission: { tasks: [{ ...TASK, status: taskStatus }] } });
    prisma.robot.findUnique.mockResolvedValue({ id: "robot-row-1", currentTaskId });
    prisma.task.updateMany.mockResolvedValue({ count: taskMoved });
    prisma.robot.updateMany.mockResolvedValue({ count: robotMoved });
    return prisma;
  }

  test("sets Task.robotId, Task.status and Robot.currentTaskId — and nothing else", async () => {
    const prisma = projectionPrisma();
    const result = await projection.projectAcceptedAssignment(prisma, { legRowId: LEG_ROW, robotCode: "RBT-1000" });

    expect(result.projected).toBe(true);
    expect(prisma.task.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ robotId: "robot-row-1", status: "ASSIGNED" }),
      }),
    );
    expect(prisma.robot.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { currentTaskId: "task-row-1", status: "ACTIVE" } }),
    );
  });

  test("touches no row the engine reasons from", async () => {
    const prisma = projectionPrisma();
    await projection.projectAcceptedAssignment(prisma, { legRowId: LEG_ROW, robotCode: "RBT-1000" });

    expect(prisma.leg.update).not.toHaveBeenCalled();
    expect(prisma.leg.updateMany).not.toHaveBeenCalled();
    expect(prisma.leg.upsert).not.toHaveBeenCalled();
    expect(prisma.agent.update).not.toHaveBeenCalled();
    expect(prisma.agent.upsert).not.toHaveBeenCalled();
  });

  test("refuses to overwrite a task that is no longer PENDING", async () => {
    const prisma = projectionPrisma({ taskMoved: 0 });
    const result = await projection.projectAcceptedAssignment(prisma, { legRowId: LEG_ROW, robotCode: "RBT-1000" });

    expect(result.projected).toBe(false);
    expect(result.reason).toBe("TASK_NOT_PENDING");
    expect(prisma.robot.updateMany).not.toHaveBeenCalled();
  });

  test("refuses to bind a robot that is already carrying a different task", async () => {
    const prisma = projectionPrisma({ robotMoved: 0 });
    const result = await projection.projectAcceptedAssignment(prisma, { legRowId: LEG_ROW, robotCode: "RBT-1000" });
    expect(result.projected).toBe(false);
    expect(result.reason).toBe("ROBOT_ALREADY_BOUND");
  });

  test("a Leg discharging several Tasks projects nothing rather than picking one", async () => {
    const prisma = projectionPrisma();
    prisma.leg.findUnique.mockResolvedValue({ mission: { tasks: [TASK, { ...TASK, id: "t2", taskId: "TSK-2" }] } });

    const result = await projection.projectAcceptedAssignment(prisma, { legRowId: LEG_ROW, robotCode: "RBT-1000" });
    expect(result.projected).toBe(false);
    expect(result.reason).toBe("NO_SINGLE_TASK_FOR_LEG");
    expect(prisma.task.updateMany).not.toHaveBeenCalled();
  });

  test("an engine-native Leg with no legacy Task is not an error", async () => {
    const prisma = projectionPrisma();
    prisma.leg.findUnique.mockResolvedValue({ mission: { tasks: [] } });
    const result = await projection.projectAcceptedAssignment(prisma, { legRowId: LEG_ROW, robotCode: "RBT-1000" });
    expect(result.projected).toBe(false);
    expect(result.reason).toBe("NO_SINGLE_TASK_FOR_LEG");
  });
});

describe("the route handoff reads the offer the agent was actually sent (P0-8)", () => {
  test("reads both paths back from the OFFER outbox row", async () => {
    const prisma = createMockPrisma();
    prisma.outbox.findFirst.mockResolvedValue({
      payload: {
        stopSequence: [
          { sequence: 0, path: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }] },
          { sequence: 1, path: [{ lat: 3, lon: 4 }, { lat: 5, lon: 6 }] },
        ],
      },
    });

    const route = await projection.offeredRouteFor(prisma, "CMT-1");
    expect(route.pathToPickup).toHaveLength(2);
    expect(route.pathToDrop).toHaveLength(2);
    expect(prisma.outbox.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { commitmentId: "CMT-1", command: "OFFER" } }),
    );
  });

  test("an offer with no geometry yields null, so no TASK_ASSIGNED is emitted", async () => {
    const prisma = createMockPrisma();
    prisma.outbox.findFirst.mockResolvedValue({ payload: { stopSequence: [{ sequence: 0 }, { sequence: 1 }] } });
    expect(await projection.offeredRouteFor(prisma, "CMT-1")).toBeNull();
  });

  test("recomputes nothing and calls no routing provider", async () => {
    const prisma = createMockPrisma();
    prisma.outbox.findFirst.mockResolvedValue(null);
    await projection.offeredRouteFor(prisma, "CMT-1");
    // The module imports no provider at all; asserted structurally so a future edit that
    // added one would fail here rather than at 3 a.m. inside a socket handler.
    expect(requiresIn(MODULE_PATH).some((s) => s.includes("mapbox") || s.includes("executionGeometry"))).toBe(false);
  });

  test("the TASK_ASSIGNED payload is exactly the shape the frontend already caches", () => {
    const payload = projection.taskAssignedPayload({
      task: {
        taskId: "TSK-1",
        pickup: "Gate 1",
        pickupLat: 12.9081,
        pickupLon: 77.5012,
        drop: "Block C",
        dropLat: 12.9095,
        dropLon: 77.5031,
      },
      robotId: "RBT-1000",
      route: { pathToPickup: [{ lat: 1, lon: 2 }], pathToDrop: [{ lat: 3, lon: 4 }] },
    });

    // `AppProvider.onTaskAssigned` reads exactly these keys and discards the event
    // without both paths.
    expect(Object.keys(payload).sort()).toEqual(
      ["drop", "pathToDrop", "pathToPickup", "pickup", "robotId", "taskId"],
    );
  });
});

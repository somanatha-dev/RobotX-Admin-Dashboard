"use strict";

/**
 * Authorised recommissioning of a retired robot — `POST /api/robots/:robotId/recommission`.
 *
 * Regression for the RBT-2000 report: commissioning a physical robot whose id belonged to a
 * retired unit answered "The ID "RBT-2000" belongs to a retired robot and cannot be reused",
 * and there was no way back. Retirement keeps the robot's rows (that is what preserves its
 * history), so the id stays taken for a *new* unit; the same robot now comes back through an
 * explicit, elevated, audited operation that reuses its rows.
 *
 *   A  the transition: same identity, COMMISSIONED, epoch +1, fence audit, Event; history kept
 *   B  refusals: request validation, unknown, not retired, simulated, credential store — and
 *      that a refusal writes nothing and never touches a live robot's credentials
 *   C  retries and concurrency: one transition, no duplicate identity, retire/recommission order
 *   D  credentials: every pre-retirement credential is dead; only a fresh code enrolls, once
 *   E  dispatch eligibility: COMMISSIONED is refused by F2 and the index; only the physical
 *      fleet declaration releases the unit, and holds survive
 *   F  HTTP: authentication, elevated role, the response contract, no secrets, the retired list,
 *      and the commissioning endpoint's codes for retired vs active ids
 *   G  structure
 */

jest.mock("../../../src/db/prisma");

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const { createRetirementStore } = require("../../helpers/retirementStore");
const { createTestKv } = require("../../helpers/testKv");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { waitFor } = require("../../helpers/waitFor");
const { createMockPrisma } = require("../../helpers/mockPrisma");

const SRC = path.join(__dirname, "..", "..", "..", "src");
const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const FUTURE = () => new Date(Date.now() + 86_400_000).toISOString();
const snapshotOf = (state) => JSON.parse(JSON.stringify(state, (k, v) => (typeof v === "bigint" ? `${v}n` : v)));

const ADMIN_ID = "3f1c2a4e-9b7d-4c1e-8a2b-5d6e7f809a1b";
const OPERATOR_ID = "6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d";
const REASON = "Drive train repaired and re-inspected; returning to the campus fleet";

/**
 * RBT-2000, retired the way `robotRetirement.service` leaves a robot: DECOMMISSIONED, epoch
 * advanced (audit source `decommission`), offline, its durable session revoked — with the
 * engine history retirement preserved, and a PAUSED hold that was in force when it retired.
 * RBT-3000 is an active unit with a live session. SIM-0001 is a retired simulated unit.
 */
function world(overrides) {
  const o = overrides || {};
  const store = createRetirementStore({
    robots: [
      { id: "row-2000", robotId: "RBT-2000", name: "Rover 2000", status: "PAUSED", battery: null, simulated: false },
      { id: "row-3000", robotId: "RBT-3000", isOnline: true, socketId: "sock-3000" },
      { id: "row-sim", robotId: "SIM-0001", simulated: true },
      ...(o.robots || []),
    ],
    agents: [
      { id: "agent-2000", agentId: "RBT-2000", robotDbId: "row-2000", lifecycleState: "DECOMMISSIONED", authorityEpoch: 5, fenceCounter: 9 },
      { id: "agent-3000", agentId: "RBT-3000", robotDbId: "row-3000", lifecycleState: "ACTIVE", authorityEpoch: 2, fenceCounter: 4 },
      { id: "agent-sim", agentId: "SIM-0001", robotDbId: "row-sim", lifecycleState: "DECOMMISSIONED", authorityEpoch: 1 },
      ...(o.agents || []),
    ],
    commitments: [{ commitmentId: "C-old", agentId: "agent-2000", releasedAt: "2026-10-01T00:00:00.000Z" }],
    outbox: [{ id: "ob-acked", agentId: "agent-2000", command: "OFFER", state: "ACKED" }],
    tasks: [{ id: "task-done", taskId: "TSK-DONE", robotId: "row-2000", status: "COMPLETED" }],
    reservations: [{ reservationId: "res-old", agentId: "agent-2000", state: "RELEASED" }],
    sessions: [{ robotDbId: "row-3000", tokenHash: sha256("tok-3000"), expiresAt: FUTURE() }, ...(o.sessions || [])],
  });
  store.state.fenceAudits.push({ agentId: "agent-2000", epochHighWater: 5n, fenceHighWater: 9n, lastFenceSource: "decommission", observedAt: "2026-10-10T08:00:00.000Z" });
  store.state.events.push({ robotId: "row-2000", type: "INFO", message: "Unit RBT-2000 retired (lifecycle ACTIVE -> DECOMMISSIONED, authority epoch 4 -> 5) by op-1" });
  return store;
}

const BODY = Object.freeze({ reason: REASON, confirmRobotId: "RBT-2000" });

function loadService() {
  return require("../../../src/services/robotRecommission.service");
}

/** A KV double that records the order of deletes; `fail` makes `del` throw. */
function recordingKv(options) {
  const settings = options || {};
  const deleted = [];
  return {
    deleted,
    del: jest.fn(async (key) => {
      if (settings.fail) throw new Error("kv down");
      deleted.push(key);
    }),
  };
}

const agentOf = (w, id) => w.state.agents.find((a) => a.id === id);

// ═══════════════════════════════════════════════════════════════════════════
// A — the transition
// ═══════════════════════════════════════════════════════════════════════════

describe("A — recommissioning returns the same robot, not a new one", () => {
  test("RBT-2000: DECOMMISSIONED -> COMMISSIONED, epoch +1, fence audit, robot offline, Event names actor and reason", async () => {
    const svc = loadService();
    const w = world();
    const kv = recordingKv();

    const result = await svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: ADMIN_ID, kv });

    expect(result).toMatchObject({
      outcome: "RECOMMISSIONED",
      robotId: "RBT-2000",
      robotDbId: "row-2000",
      agentRowId: "agent-2000",
      lifecycleState: "COMMISSIONED",
      epochBefore: 5n,
      epochAfter: 6n,
      postCommitRevocationFailed: false,
    });
    const agent = agentOf(w, "agent-2000");
    expect(agent.lifecycleState).toBe("COMMISSIONED");
    expect(agent.authorityEpoch).toBe(6n);
    expect(agent.fenceCounter).toBe(9n);
    expect(w.state.fenceAudits.find((r) => r.agentId === "agent-2000")).toMatchObject({ epochHighWater: 6n, fenceHighWater: 9n, lastFenceSource: "recommission" });
    expect(w.state.robots.find((r) => r.id === "row-2000")).toMatchObject({ isOnline: false, socketId: null });

    const event = w.state.events[w.state.events.length - 1];
    expect(event).toMatchObject({ robotId: "row-2000", type: "INFO" });
    expect(event.message).toMatch(/Unit RBT-2000 recommissioned \(lifecycle DECOMMISSIONED -> COMMISSIONED, authority epoch 5 -> 6\)/);
    expect(event.message).toContain(`by ${ADMIN_ID}`);
    expect(event.message).toContain(REASON);
    expect(event.message).toMatch(/not yet released into service/);
  });

  test("identity and history are preserved: no row created or deleted; tasks, commitments, outbox, charges, events kept", async () => {
    const svc = loadService();
    const w = world();
    const before = snapshotOf(w.state);

    await svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: ADMIN_ID, kv: recordingKv() });

    expect(w.prisma.robot.create).not.toHaveBeenCalled();
    expect(w.prisma.robot.delete).not.toHaveBeenCalled();
    expect(w.prisma.agent.delete).not.toHaveBeenCalled();
    expect(w.state.robots.map((r) => r.id)).toEqual(before.robots.map((r) => r.id));
    expect(w.state.agents.map((a) => a.id)).toEqual(before.agents.map((a) => a.id));
    expect(w.state.robots.filter((r) => r.robotId === "RBT-2000")).toHaveLength(1);
    const after = snapshotOf(w.state);
    expect(after.commitments).toEqual(before.commitments);
    expect(after.outbox).toEqual(before.outbox);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.reservations).toEqual(before.reservations);
    // The retirement Event is still there, followed by the recommissioning one.
    expect(after.events.slice(0, before.events.length)).toEqual(before.events);
    expect(after.events).toHaveLength(before.events.length + 1);
    // Other units untouched.
    expect(agentOf(w, "agent-3000").lifecycleState).toBe("ACTIVE");
    expect(agentOf(w, "agent-sim").lifecycleState).toBe("DECOMMISSIONED");
  });

  test("a hold survives: Robot.status (PAUSED) and the battery reading are not touched", async () => {
    const svc = loadService();
    const w = world();
    await svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: ADMIN_ID, kv: recordingKv() });
    expect(w.state.robots.find((r) => r.id === "row-2000")).toMatchObject({ status: "PAUSED", battery: null });
    const robotUpdates = w.prisma.robot.update.mock.calls.map(([args]) => args.data);
    for (const data of robotUpdates) expect(Object.keys(data).sort()).toEqual(["isOnline", "socketId"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B — refusals
// ═══════════════════════════════════════════════════════════════════════════

describe("B — refusals, each writing nothing", () => {
  const invalid = [
    ["no reason", { confirmRobotId: "RBT-2000" }, /reason is required/],
    ["a blank reason", { reason: "   ", confirmRobotId: "RBT-2000" }, /reason is required/],
    ["an over-long reason", { reason: "x".repeat(501), confirmRobotId: "RBT-2000" }, /at most 500/],
    ["no confirmation", { reason: REASON }, /confirmRobotId must repeat/],
    ["a confirmation naming another unit", { reason: REASON, confirmRobotId: "RBT-3000" }, /confirmRobotId must repeat/],
    ["a confirmation in another case", { reason: REASON, confirmRobotId: "rbt-2000" }, /confirmRobotId must repeat/],
    ["an unknown field", { ...BODY, lifecycleState: "ACTIVE" }, /refused: lifecycleState/],
    ["a configuration field", { ...BODY, locationId: "loc-9" }, /refused: locationId/],
  ];

  test.each(invalid)("400 INVALID_REQUEST for %s, before any read or credential delete", async (_label, body, message) => {
    const svc = loadService();
    const w = world();
    const kv = recordingKv();
    const before = snapshotOf(w.state);

    const error = await svc.recommission(w.prisma, "RBT-2000", body, { actorId: ADMIN_ID, kv }).catch((e) => e);

    expect(error).toBeInstanceOf(svc.RecommissionRefused);
    expect(error).toMatchObject({ status: 400, code: "INVALID_REQUEST" });
    expect(error.message).toMatch(message);
    expect(kv.del).not.toHaveBeenCalled();
    expect(w.prisma.$transaction).not.toHaveBeenCalled();
    expect(snapshotOf(w.state)).toEqual(before);
  });

  test("404 for an unknown robot", async () => {
    const svc = loadService();
    const w = world();
    const error = await svc.recommission(w.prisma, "RBT-9999", { reason: REASON, confirmRobotId: "RBT-9999" }, { kv: recordingKv() }).catch((e) => e);
    expect(error).toMatchObject({ status: 404, code: "ROBOT_NOT_FOUND" });
  });

  test("409 ROBOT_NOT_RETIRED for an active robot, and its live credentials are never touched", async () => {
    const svc = loadService();
    const w = world();
    const kv = recordingKv();
    const before = snapshotOf(w.state);

    const error = await svc
      .recommission(w.prisma, "RBT-3000", { reason: REASON, confirmRobotId: "RBT-3000" }, { actorId: ADMIN_ID, kv })
      .catch((e) => e);

    expect(error).toMatchObject({ status: 409, code: "ROBOT_NOT_RETIRED" });
    expect(error.toBody()).toMatchObject({ ok: false, code: "ROBOT_NOT_RETIRED", lifecycleState: "ACTIVE" });
    expect(kv.del).not.toHaveBeenCalled();
    expect(snapshotOf(w.state)).toEqual(before);
    expect(w.state.sessions.some((s) => s.robotDbId === "row-3000")).toBe(true);
  });

  test("409 ROBOT_NOT_RETIRED for a robot with no Agent row (never retired)", async () => {
    const svc = loadService();
    const w = world({ robots: [{ id: "row-old", robotId: "RBT-OLD" }] });
    const error = await svc.recommission(w.prisma, "RBT-OLD", { reason: REASON, confirmRobotId: "RBT-OLD" }, { kv: recordingKv() }).catch((e) => e);
    expect(error).toMatchObject({ status: 409, code: "ROBOT_NOT_RETIRED" });
    expect(w.state.agents.some((a) => a.robotDbId === "row-old")).toBe(false);
  });

  test("409 SIMULATED_NOT_RECOMMISSIONABLE for a retired simulated robot", async () => {
    const svc = loadService();
    const w = world();
    const kv = recordingKv();
    const before = snapshotOf(w.state);
    const error = await svc.recommission(w.prisma, "SIM-0001", { reason: REASON, confirmRobotId: "SIM-0001" }, { kv }).catch((e) => e);
    expect(error).toMatchObject({ status: 409, code: "SIMULATED_NOT_RECOMMISSIONABLE" });
    expect(kv.del).not.toHaveBeenCalled();
    expect(snapshotOf(w.state)).toEqual(before);
  });

  test("503 when the credential store is absent or failing: the transaction rolls back, nothing is transitioned", async () => {
    const svc = loadService();
    for (const kv of [undefined, recordingKv({ fail: true })]) {
      const w = world();
      const before = snapshotOf(w.state);
      // eslint-disable-next-line no-await-in-loop
      const error = await svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: ADMIN_ID, kv }).catch((e) => e);
      expect(error).toMatchObject({ status: 503, code: "CREDENTIAL_REVOCATION_UNAVAILABLE" });
      expect(error.message).toMatch(/Nothing was changed/);
      expect(w.prisma.agent.update).not.toHaveBeenCalled();
      expect(snapshotOf(w.state)).toEqual(before);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C — retries, concurrency, no duplicate identity
// ═══════════════════════════════════════════════════════════════════════════

describe("C — retries and concurrent requests produce one transition and one identity", () => {
  test("a repeat is ALREADY_RECOMMISSIONED: no second epoch advance, Event, or credential delete", async () => {
    const svc = loadService();
    const w = world();
    await svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: ADMIN_ID, kv: recordingKv() });
    const events = w.state.events.length;
    const kv = recordingKv();

    const again = await svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: ADMIN_ID, kv });

    expect(again).toMatchObject({ outcome: "ALREADY_RECOMMISSIONED", lifecycleState: "COMMISSIONED", epochBefore: 6n, epochAfter: 6n });
    expect(agentOf(w, "agent-2000").authorityEpoch).toBe(6n);
    expect(w.state.events).toHaveLength(events);
    // Not retired any more, so a robot that paired since keeps its session.
    expect(kv.del).not.toHaveBeenCalled();
  });

  test("two concurrent requests: one RECOMMISSIONED, one ALREADY_RECOMMISSIONED, the epoch advanced once", async () => {
    const svc = loadService();
    const w = world();
    const outcomes = await Promise.all([
      svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: ADMIN_ID, kv: recordingKv() }),
      svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: OPERATOR_ID, kv: recordingKv() }),
    ]);
    expect(outcomes.map((r) => r.outcome).sort()).toEqual(["ALREADY_RECOMMISSIONED", "RECOMMISSIONED"]);
    expect(agentOf(w, "agent-2000").authorityEpoch).toBe(6n);
    expect(w.state.events.filter((e) => /recommissioned/.test(e.message))).toHaveLength(1);
    expect(w.state.robots.filter((r) => r.robotId === "RBT-2000")).toHaveLength(1);
    expect(w.state.agents.filter((a) => a.robotDbId === "row-2000")).toHaveLength(1);
  });

  test("the second request waits on the Agent lock the first holds", async () => {
    const svc = loadService();
    const w = world();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let lockedSignal;
    const locked = new Promise((resolve) => {
      lockedSignal = resolve;
    });
    const first = svc.recommission(w.prisma, "RBT-2000", BODY, {
      kv: recordingKv(),
      hooks: { afterLock: async () => { lockedSignal(); await gate; } },
    });
    await locked;
    let secondSettled = false;
    const second = svc.recommission(w.prisma, "RBT-2000", BODY, { kv: recordingKv() }).then((r) => {
      secondSettled = true;
      return r;
    });
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(secondSettled).toBe(false);
    release();
    expect((await first).outcome).toBe("RECOMMISSIONED");
    expect((await second).outcome).toBe("ALREADY_RECOMMISSIONED");
  });

  test("retire and recommission serialise on the same lock, in either order", async () => {
    const svc = loadService();
    const retirement = require("../../../src/services/robotRetirement.service");
    const w = world();
    // Recommission first, then retire again: a clean round trip, each epoch advance recorded.
    await svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: ADMIN_ID, kv: recordingKv() });
    const retired = await retirement.retireRobot(w.prisma, "RBT-2000", { actorId: ADMIN_ID });
    expect(retired).toMatchObject({ outcome: "RETIRED", epochBefore: 6n, epochAfter: 7n });
    const back = await svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: ADMIN_ID, kv: recordingKv() });
    expect(back).toMatchObject({ outcome: "RECOMMISSIONED", epochBefore: 7n, epochAfter: 8n });
    expect(w.state.robots.filter((r) => r.robotId === "RBT-2000")).toHaveLength(1);
  });

  test("once the declaration has put the unit in service (ACTIVE), a late retry is ROBOT_NOT_RETIRED", async () => {
    const svc = loadService();
    const w = world();
    await svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: ADMIN_ID, kv: recordingKv() });
    agentOf(w, "agent-2000").lifecycleState = "ACTIVE";
    const error = await svc.recommission(w.prisma, "RBT-2000", BODY, { kv: recordingKv() }).catch((e) => e);
    expect(error).toMatchObject({ status: 409, code: "ROBOT_NOT_RETIRED" });
  });

  test("a COMMISSIONED unit whose last fence event is not this operation is not mistaken for a retry", async () => {
    const svc = loadService();
    const w = world();
    await svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: ADMIN_ID, kv: recordingKv() });
    w.state.fenceAudits.find((r) => r.agentId === "agent-2000").lastFenceSource = "dedup-reset:SEQUENCE_REGRESSION";
    const error = await svc.recommission(w.prisma, "RBT-2000", BODY, { kv: recordingKv() }).catch((e) => e);
    expect(error).toMatchObject({ status: 409, code: "ROBOT_NOT_RETIRED" });
  });

  test("ordinary commissioning still cannot create a second RBT-2000, before or after recommissioning", async () => {
    const robotService = require("../../../src/services/robot.service");
    const svc = loadService();
    const w = world();
    const spec = { locationId: "loc-1", chassisType: "ROVER", specification: { massKg: 45, maxSpeedMps: 2.5, normalSpeedMps: 1.4, batteryCapacityWh: 500, batteryReservePct: 15, payloadCapacityKg: 20, initialBatteryPct: 82 } };

    const retiredRefusal = await robotService.createRobotWithProjection(w.prisma, spec, { robotCode: "RBT-2000", simulated: false }).catch((e) => e);
    expect(retiredRefusal).toMatchObject({ status: 409, code: "ROBOT_ID_TAKEN", retired: true });
    expect(retiredRefusal.message).toMatch(/belongs to a retired robot and cannot be reused for a new unit/);
    expect(retiredRefusal.message).toMatch(/recommission it instead/);

    await svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: ADMIN_ID, kv: recordingKv() });

    const activeRefusal = await robotService.createRobotWithProjection(w.prisma, spec, { robotCode: "RBT-2000", simulated: false }).catch((e) => e);
    expect(activeRefusal).toMatchObject({ status: 409, code: "ROBOT_ID_TAKEN", retired: false });
    expect(activeRefusal.message).toMatch(/already commissioned/);
    expect(w.prisma.robot.create).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D — credentials
// ═══════════════════════════════════════════════════════════════════════════

describe("D — no credential from before retirement survives; only a fresh code enrolls, once", () => {
  async function authProcess(w, kv) {
    const { registerRobotHandlers } = require("../../../src/sockets/handlers/robot.handler");
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const io = createFakeIo();
    async function auth(payload) {
      const socket = createFakeSocket();
      registerRobotHandlers(io, socket, { prisma: w.prisma, kv, logger, appLocals: {} });
      socket.trigger("AUTH", payload);
      await waitFor(() => socket.sent.some((s) => s.event === "AUTH_SUCCESS") || socket.disconnect.mock.calls.length > 0);
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
      const success = socket.sent.find((s) => s.event === "AUTH_SUCCESS");
      return { ok: Boolean(success), token: success?.payload?.token ?? null, socket };
    }
    return { auth, logger };
  }

  test("stale KV keys left by a failed retirement cleanup are deleted under the lock, before the lifecycle write", async () => {
    const svc = loadService();
    const w = world();
    const { kv, close } = await createTestKv();
    try {
      for (const key of ["session", "pairing", "pairingAttempts", "pairingLocked"]) await kv.set(`${key}:RBT-2000`, "stale", { ex: 300 });
      await kv.set("session:RBT-3000", "tok-3000", { ex: 300 });
      const seenAtWrite = {};
      const update = w.prisma.agent.update.getMockImplementation();
      w.prisma.agent.update.mockImplementation(async (args) => {
        for (const key of ["session", "pairing", "pairingAttempts", "pairingLocked"]) seenAtWrite[key] = await kv.get(`${key}:RBT-2000`);
        return update(args);
      });
      await svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: ADMIN_ID, kv });
      expect(seenAtWrite).toEqual({ session: null, pairing: null, pairingAttempts: null, pairingLocked: null });
      for (const key of ["session", "pairing", "pairingAttempts", "pairingLocked"]) expect(await kv.get(`${key}:RBT-2000`)).toBeNull();
      expect(await kv.get("session:RBT-3000")).toBe("tok-3000");
    } finally {
      await close();
    }
  });

  test("a durable session row written by an AUTH that raced retirement is removed in the transaction", async () => {
    const svc = loadService();
    const w = world({ sessions: [{ robotDbId: "row-2000", tokenHash: sha256("raced"), expiresAt: FUTURE() }] });
    await svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: ADMIN_ID, kv: recordingKv() });
    expect(w.state.sessions.filter((s) => s.robotDbId === "row-2000")).toEqual([]);
  });

  test("after recommissioning, the old token, the old durable session and a consumed code are all refused; a fresh code enrolls exactly once", async () => {
    const svc = loadService();
    const w = world({ sessions: [{ robotDbId: "row-2000", tokenHash: sha256("old-durable"), expiresAt: FUTURE() }] });
    const { kv, close } = await createTestKv();
    try {
      // What survived retirement in this scenario: an old bearer token and a pairing code that
      // had already been presented once (and rejected) before retirement.
      await kv.set("session:RBT-2000", "old-token", { ex: 300 });
      await kv.set("pairing:RBT-2000", "424242", { ex: 300 });

      await svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: ADMIN_ID, kv });
      const p = await authProcess(w, kv);

      expect((await p.auth({ robotId: "RBT-2000", token: "old-token" })).ok).toBe(false);
      expect((await p.auth({ robotId: "RBT-2000", token: "old-durable" })).ok).toBe(false);
      expect((await p.auth({ robotId: "RBT-2000", pairingCode: "424242" })).ok).toBe(false);
      expect(w.state.robots.find((r) => r.id === "row-2000").isOnline).toBe(false);

      // The existing enrollment flow mints a fresh single-use code.
      await kv.del("pairingAttempts:RBT-2000");
      await kv.set("pairing:RBT-2000", "135790", { ex: 300 });
      const enrolled = await p.auth({ robotId: "RBT-2000", pairingCode: "135790" });
      expect(enrolled.ok).toBe(true);
      expect(enrolled.token).toEqual(expect.any(String));
      expect(await kv.get("pairing:RBT-2000")).toBeNull();
      // One durable session, for the new token only.
      expect(w.state.sessions.filter((s) => s.robotDbId === "row-2000")).toEqual([expect.objectContaining({ tokenHash: sha256(enrolled.token) })]);
      // The code was consumed: presenting it again is refused.
      expect((await p.auth({ robotId: "RBT-2000", pairingCode: "135790" })).ok).toBe(false);
      // The unit is online but still COMMISSIONED — enrolled is not in service.
      expect(agentOf(w, "agent-2000").lifecycleState).toBe("COMMISSIONED");
    } finally {
      await close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E — dispatch eligibility
// ═══════════════════════════════════════════════════════════════════════════

describe("E — recommissioning alone never makes a unit dispatchable", () => {
  test("F2 refuses COMMISSIONED, as it refuses DECOMMISSIONED; the index maintainer does not index it", async () => {
    const f02 = require("../../../src/engine/feasibility/predicates/f02");
    const { agentIsLifecycleEligible } = require("../../../src/workers/indexMaintainer.worker");
    const svc = loadService();
    const w = world();
    await svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: ADMIN_ID, kv: recordingKv() });
    const state = agentOf(w, "agent-2000").lifecycleState;

    const verdict = f02.evaluate({ agentSnapshot: { lifecycleState: state } });
    expect(verdict.value ?? verdict.status ?? verdict.outcome).not.toBe("SATISFIED");
    expect(JSON.stringify(verdict)).toMatch(/VIOLATED|violated/);
    expect(agentIsLifecycleEligible(state)).toBe(false);
    expect(agentIsLifecycleEligible("ACTIVE")).toBe(true);
  });

  test("the physical fleet declaration is the only release into service, and it is conditional on COMMISSIONED/ACTIVE", () => {
    const declaration = fs.readFileSync(path.join(SRC, "services", "physicalDeclaration.service.js"), "utf8");
    expect(declaration).toMatch(/lifecycleState: \{ in: \["COMMISSIONED", "ACTIVE"\] \}/);
    // No other runtime module writes `lifecycleState: "ACTIVE"` onto an existing Agent.
    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) {
          const text = fs.readFileSync(full, "utf8");
          if (/agent\.(update|updateMany|upsert)\([\s\S]{0,400}?lifecycleState:\s*"ACTIVE"/.test(text)) offenders.push(path.relative(SRC, full));
        }
      }
    };
    walk(SRC);
    expect(offenders.map((f) => f.replace(/\\/g, "/"))).toEqual(["services/physicalDeclaration.service.js"]);
    const service = fs.readFileSync(path.join(SRC, "services", "robotRecommission.service.js"), "utf8");
    expect(service).not.toMatch(/lifecycleState:\s*"ACTIVE"/);
  });

  test("a recommissioned unit is back in the dashboard list (not retired) but is not in service", async () => {
    const robotService = require("../../../src/services/robot.service");
    const svc = loadService();
    const w = world();
    expect((await robotService.listRobots(w.prisma, {})).map((r) => r.robotId)).not.toContain("RBT-2000");
    await svc.recommission(w.prisma, "RBT-2000", BODY, { actorId: ADMIN_ID, kv: recordingKv() });
    const listed = await robotService.listRobots(w.prisma, {});
    expect(listed.map((r) => r.robotId)).toContain("RBT-2000");
    expect(listed.find((r) => r.robotId === "RBT-2000")).toMatchObject({ isOnline: false, agent: { lifecycleState: "COMMISSIONED" } });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F — HTTP
// ═══════════════════════════════════════════════════════════════════════════

describe("F — the HTTP surface", () => {
  let w;
  let kv;
  let closeKv;
  let io;
  let logger;

  async function makeApp() {
    jest.resetModules();
    jest.doMock("../../../src/db/prisma");
    require("../../../src/db/prisma").getPrisma.mockReturnValue(w.prisma);
    // The controller's `../config/logger` is mapped to this module by jest.config.js.
    logger = require("../../mocks/silentLogger");
    jest.spyOn(logger, "warn").mockImplementation(() => {});
    jest.spyOn(logger, "info").mockImplementation(() => {});
    const app = express();
    app.use(express.json());
    app.locals.kv = kv;
    app.locals.io = io;
    app.use("/api/robots", require("../../../src/routes/robots.routes"));
    return app;
  }

  const bearer = (id) => `Bearer ${jwt.sign({ id }, process.env.JWT_SECRET)}`;

  beforeEach(async () => {
    w = world();
    w.prisma.user.findUnique.mockImplementation(async ({ where }) => {
      if (where.id === ADMIN_ID) return { id: ADMIN_ID, email: "admin@example.test", role: "SUPER_ADMIN" };
      if (where.id === OPERATOR_ID) return { id: OPERATOR_ID, email: "op@example.test", role: "OPERATOR" };
      return null;
    });
    ({ kv, close: closeKv } = await createTestKv());
    io = createFakeIo();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await closeKv();
  });

  test("401 without authentication, and nothing changes", async () => {
    const app = await makeApp();
    const before = snapshotOf(w.state);
    const res = await request(app).post("/api/robots/RBT-2000/recommission").send(BODY);
    expect(res.status).toBe(401);
    expect(snapshotOf(w.state)).toEqual(before);
  });

  test("403 for an authenticated account without an elevated role, and nothing changes", async () => {
    const app = await makeApp();
    const before = snapshotOf(w.state);
    const res = await request(app).post("/api/robots/RBT-2000/recommission").set("Authorization", bearer(OPERATOR_ID)).send(BODY);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: "Forbidden" });
    expect(snapshotOf(w.state)).toEqual(before);
    expect(agentOf(w, "agent-2000").lifecycleState).toBe("DECOMMISSIONED");
  });

  test("200 for an elevated administrator: the contract, a dashboard event, and no secret in the response", async () => {
    const app = await makeApp();
    await kv.set("pairing:RBT-2000", "987654", { ex: 300 });
    const res = await request(app).post("/api/robots/RBT-2000/recommission").set("Authorization", bearer(ADMIN_ID)).send(BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      robotId: "RBT-2000",
      recommissioned: true,
      alreadyRecommissioned: false,
      lifecycleState: "COMMISSIONED",
      releasedToService: false,
      pairingRequired: true,
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/987654|token|pairingCode|session|tokenHash/i);
    expect(io.emittedTo("dashboard", "robot_recommissioned")).toEqual([expect.objectContaining({ robotId: "RBT-2000" })]);
    expect(w.state.events[w.state.events.length - 1].message).toContain(`by ${ADMIN_ID}`);
    // The success log names ids only.
    const logged = JSON.stringify(logger.info.mock.calls);
    expect(logged).toMatch(/recommissioned/);
    expect(logged).not.toContain("987654");

    const again = await request(app).post("/api/robots/RBT-2000/recommission").set("Authorization", bearer(ADMIN_ID)).send(BODY);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ recommissioned: true, alreadyRecommissioned: true });
  });

  test("refusals carry a code and a sentence; the refusal log carries no operator text or secret", async () => {
    const app = await makeApp();
    const secretish = "pin 4321 and code 112233";
    const bad = await request(app)
      .post("/api/robots/RBT-2000/recommission")
      .set("Authorization", bearer(ADMIN_ID))
      .send({ reason: secretish, confirmRobotId: "RBT-3000" });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ ok: false, code: "INVALID_REQUEST", refusal: "INVALID_REQUEST" });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secretish);

    const active = await request(app)
      .post("/api/robots/RBT-3000/recommission")
      .set("Authorization", bearer(ADMIN_ID))
      .send({ reason: REASON, confirmRobotId: "RBT-3000" });
    expect(active.status).toBe(409);
    expect(active.body).toMatchObject({ code: "ROBOT_NOT_RETIRED", lifecycleState: "ACTIVE" });

    const missing = await request(app)
      .post("/api/robots/RBT-0404/recommission")
      .set("Authorization", bearer(ADMIN_ID))
      .send({ reason: REASON, confirmRobotId: "RBT-0404" });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "ROBOT_NOT_FOUND" });
  });

  test("503 when the KV store is unavailable", async () => {
    kv = undefined;
    const app = await makeApp();
    const res = await request(app).post("/api/robots/RBT-2000/recommission").set("Authorization", bearer(ADMIN_ID)).send(BODY);
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "CREDENTIAL_REVOCATION_UNAVAILABLE" });
    expect(agentOf(w, "agent-2000").lifecycleState).toBe("DECOMMISSIONED");
    closeKv = async () => {};
  });

  test("GET /api/robots/retired lists retired units without credential fields, and drops a recommissioned one", async () => {
    const app = await makeApp();
    const res = await request(app).get("/api/robots/retired").set("Authorization", bearer(ADMIN_ID));
    expect(res.status).toBe(200);
    expect(res.body.robots).toEqual([
      { robotId: "RBT-2000", name: "Rover 2000", simulated: false, recommissionable: true, lastSeenAt: null, locationName: null, retiredAt: "2026-10-10T08:00:00.000Z" },
      { robotId: "SIM-0001", name: null, simulated: true, recommissionable: false, lastSeenAt: null, locationName: null, retiredAt: null },
    ]);
    const unauthenticated = await request(app).get("/api/robots/retired");
    expect(unauthenticated.status).toBe(401);

    await request(app).post("/api/robots/RBT-2000/recommission").set("Authorization", bearer(ADMIN_ID)).send(BODY);
    const after = await request(app).get("/api/robots/retired").set("Authorization", bearer(ADMIN_ID));
    expect(after.body.robots.map((r) => r.robotId)).toEqual(["SIM-0001"]);
  });

  test("RBT-2000 regression: POST /api/robots with a retired id is 409 ROBOT_ID_RETIRED; an active id is ROBOT_ID_TAKEN", async () => {
    const app = await makeApp();
    const spec = { massKg: 45, maxSpeedMps: 2.5, normalSpeedMps: 1.4, batteryCapacityWh: 500, batteryReservePct: 15, payloadCapacityKg: 20, initialBatteryPct: 82 };
    const retired = await request(app)
      .post("/api/robots")
      .set("Authorization", bearer(ADMIN_ID))
      .send({ robotId: "RBT-2000", locationId: "loc-1", chassisType: "ROVER", specification: spec });
    expect(retired.status).toBe(409);
    expect(retired.body).toMatchObject({ ok: false, code: "ROBOT_ID_RETIRED", retired: true });
    expect(retired.body.message).toMatch(/belongs to a retired robot/);
    // Still retired: an ordinary commissioning attempt never recommissions.
    expect(agentOf(w, "agent-2000").lifecycleState).toBe("DECOMMISSIONED");

    const active = await request(app)
      .post("/api/robots")
      .set("Authorization", bearer(ADMIN_ID))
      .send({ robotId: "RBT-3000", locationId: "loc-1", chassisType: "ROVER", specification: spec });
    expect(active.status).toBe(409);
    expect(active.body).toMatchObject({ code: "ROBOT_ID_TAKEN", retired: false });

    // The pairing endpoint still refuses the retired unit by name.
    const pairing = await request(app).post("/api/robots/commission").set("Authorization", bearer(ADMIN_ID)).send({ robotId: "RBT-2000" });
    expect(pairing.status).toBe(409);
    expect(pairing.body).toMatchObject({ code: "ROBOT_RETIRED" });
  });

  test("after recommissioning, the existing pairing endpoint issues a fresh code (and records the issue without the code)", async () => {
    const app = await makeApp();
    await request(app).post("/api/robots/RBT-2000/recommission").set("Authorization", bearer(ADMIN_ID)).send(BODY);
    const res = await request(app).post("/api/robots/commission").set("Authorization", bearer(ADMIN_ID)).send({ robotId: "RBT-2000" });
    expect(res.status).toBe(200);
    expect(res.body.pairingCode).toMatch(/^\d{6}$/);
    expect(await kv.get("pairing:RBT-2000")).toBe(res.body.pairingCode);
    const issued = w.state.events.filter((e) => /Pairing code issued for robot RBT-2000/.test(e.message));
    expect(issued).toHaveLength(1);
    expect(issued[0].message).not.toContain(res.body.pairingCode);
    // Issuing a code did not change the lifecycle.
    expect(agentOf(w, "agent-2000").lifecycleState).toBe("COMMISSIONED");
  });
});

describe("F — new-unit commissioning is unchanged", () => {
  test("POST /api/robots with a new id still commissions (200), and the Agent is created", async () => {
    jest.resetModules();
    jest.doMock("../../../src/db/prisma");
    const prisma = createMockPrisma();
    // The duplicate check finds nothing; the transaction's final re-read finds the created row.
    let created = null;
    prisma.robot.findUnique.mockImplementation(async () => created);
    prisma.user.findUnique.mockResolvedValue({ id: ADMIN_ID, email: "admin@example.test", role: "SUPER_ADMIN" });
    prisma.location.findUnique.mockResolvedValue({ id: "loc-1", lat: 12.9, lon: 77.5 });
    prisma.robot.create = jest.fn(async ({ data }) => {
      created = { id: "robot-row-1", ...data };
      return created;
    });
    prisma.mobilityModel.upsert.mockImplementation(async ({ create }) => ({ id: "mob-1", ...create }));
    prisma.energyModel.upsert.mockImplementation(async ({ create }) => ({ id: "eng-1", ...create }));
    prisma.containerModel.upsert.mockImplementation(async ({ create }) => ({ id: "ctr-1", ...create }));
    prisma.capabilityBundle.upsert.mockImplementation(async ({ create }) => ({ id: "cap-1", ...create }));
    prisma.capability.deleteMany.mockResolvedValue({ count: 0 });
    prisma.capability.createMany.mockImplementation(async ({ data }) => ({ count: data.length }));
    prisma.agentClass.upsert.mockImplementation(async ({ create }) => ({ id: "class-1", ...create }));
    prisma.agent.upsert.mockImplementation(async ({ create }) => ({ id: "agent-1", ...create }));
    prisma.$transaction.mockImplementation(async (fn) => fn(prisma));
    require("../../../src/db/prisma").getPrisma.mockReturnValue(prisma);
    const app = express();
    app.use(express.json());
    app.use("/api/robots", require("../../../src/routes/robots.routes"));

    const res = await request(app)
      .post("/api/robots")
      .set("Authorization", `Bearer ${jwt.sign({ id: ADMIN_ID }, process.env.JWT_SECRET)}`)
      .send({
        robotId: "RBT-4000",
        locationId: "loc-1",
        chassisType: "ROVER",
        specification: { massKg: 45, maxSpeedMps: 2.5, normalSpeedMps: 1.4, batteryCapacityWh: 500, batteryReservePct: 15, payloadCapacityKg: 20, initialBatteryPct: 82 },
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(prisma.robot.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ robotId: "RBT-4000" }) }));
    expect(prisma.agent.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ agentId: "RBT-4000", lifecycleState: "ACTIVE" }) }));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G — structure
// ═══════════════════════════════════════════════════════════════════════════

describe("G — structure", () => {
  const codeOnly = (file) =>
    fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, ""))
      .join("\n");

  test("the service never creates or deletes a Robot or Agent row, and issues no pairing code", () => {
    const service = codeOnly(path.join(SRC, "services", "robotRecommission.service.js"));
    expect(service).not.toMatch(/\.robot\.(create|delete|deleteMany)\b/);
    expect(service).not.toMatch(/\.agent\.(create|delete|deleteMany|upsert)\b/);
    expect(service).not.toMatch(/randomInt|pairingCode/);
  });

  test("the route is elevated-only and is not behind the retired-robot refusal", () => {
    const routes = fs.readFileSync(path.join(SRC, "routes", "robots.routes.js"), "utf8");
    const line = routes.split(/\r?\n/).find((l) => /router\.post\("\/:robotId\/recommission"/.test(l));
    expect(line).toBeDefined();
    expect(line).toMatch(/recommissionLimiter, elevatedOnly, robotsController\.recommissionRobot/);
    expect(line).not.toMatch(/notRetired/);
    expect(routes).toMatch(/const elevatedOnly = requireElevatedRole\(\);/);
    // The retired list is declared before any `/:robotId` GET.
    expect(routes.indexOf('router.get("/retired"')).toBeLessThan(routes.indexOf('router.get("/:robotId'));
  });
});

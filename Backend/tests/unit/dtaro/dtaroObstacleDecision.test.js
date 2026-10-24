"use strict";

/**
 * DTARO operator decisions — the server-owned deadline and the at-most-one commit, on a
 * deterministic clock (Jest's modern fake timers move `Date.now()` and the timers together).
 *
 * The report is accepted through the real `dtaroZoneAlert.processReport` with `deferDelivery`
 * over a synthetic published map; the fleet is empty (a fake `io` with no sockets), so these
 * tests are about the decision record itself. Real-socket delivery, suppression and execution
 * are `tests/integration/dtaroOperatorDecisionSockets.test.js`.
 */

const dtaroZoneAlert = require("../../../src/services/dtaroZoneAlert.service");
const obstacleDecision = require("../../../src/services/dtaroObstacleDecision.service");
const { createPermissivePrisma } = require("../../helpers/permissivePrisma");
const world = require("../../helpers/dtaroDecisionWorld");

const SPATIAL = world.buildMap();
const USER = { id: "11111111-1111-4111-8111-111111111111", role: "SUPER_ADMIN" };
const T0 = Date.UTC(2026, 9, 24, 6, 0, 0);

function fakeIo() {
  const emitted = [];
  const room = (name) => ({ emit: (event, payload) => emitted.push({ room: name, event, payload }), except: () => room(name) });
  return { emitted, to: room, in: () => ({ fetchSockets: async () => [] }), fetchSockets: async () => [] };
}

function stand() {
  const rows = new Map();
  const calls = [];
  const prisma = createPermissivePrisma((model, method, args) => {
    if (model !== "dtaroObstacleDecision") return undefined;
    calls.push({ method, args: JSON.parse(JSON.stringify(args)) });
    const where = (args && args.where) || {};
    if (method === "create") {
      rows.set(args.data.decisionId, { ...args.data });
      return rows.get(args.data.decisionId);
    }
    if (method === "updateMany") {
      const row = rows.get(where.decisionId);
      if (!row || (typeof where.status === "string" && row.status !== where.status)) return { count: 0 };
      for (const [k, v] of Object.entries(args.data)) if (v !== undefined) row[k] = v;
      return { count: 1 };
    }
    return undefined;
  });
  return { prisma, rows, calls };
}

async function openDecision({ prisma } = stand()) {
  const io = fakeIo();
  const socket = { data: { robotId: "REP", isAuthed: true, dtaroEligible: true, dtaroZone: { regionId: "rA", zoneId: "zE", room: dtaroZoneAlert.zoneRoom("rA", "zE") } }, emit: jest.fn() };
  const report = await dtaroZoneAlert.processReport({
    io, prisma, kv: null, snapshot: { spatial: SPATIAL }, socket, reporterRobotId: "REP", report: { lat: world.O.lat, lon: world.O.lon, severity: "HIGH" }, deferDelivery: true,
  });
  expect(report).toMatchObject({ accepted: true, deferred: true });
  const opened = obstacleDecision.open({ io, prisma, snapshotOf: () => ({ spatial: SPATIAL }), positionOf: async () => null, report });
  return { io, report, opened };
}

const decide = (decisionId, decision, key = `key-${decision}`) => obstacleDecision.decide({ decisionId, body: { decision, idempotencyKey: key }, user: USER });
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

beforeEach(() => {
  jest.useFakeTimers({ now: T0 });
  process.env[dtaroZoneAlert.ENV_SWITCH] = "true";
  process.env[obstacleDecision.ENV_SWITCH] = "true";
  dtaroZoneAlert.resetForTests();
  obstacleDecision.resetForTests();
});
afterEach(() => {
  obstacleDecision.resetForTests();
  jest.useRealTimers();
  delete process.env[obstacleDecision.ENV_SWITCH];
  delete process.env[dtaroZoneAlert.ENV_SWITCH];
});

describe("the switch", () => {
  test("needs both flags; either off is off", () => {
    expect(obstacleDecision.isEnabled({ DTARO_ZONE_ALERTS_ENABLED: "true", DTARO_OPERATOR_DECISION_ENABLED: "true" })).toBe(true);
    expect(obstacleDecision.isEnabled({ DTARO_ZONE_ALERTS_ENABLED: "true" })).toBe(false);
    expect(obstacleDecision.isEnabled({ DTARO_OPERATOR_DECISION_ENABLED: "true" })).toBe(false);
    expect(obstacleDecision.isEnabled({})).toBe(false);
  });
});

describe("the server's deadline", () => {
  test("is exactly 5 s after acceptance; nothing is decided at 4.999 s; REROUTE is committed at 5 s", async () => {
    const { opened } = await openDecision();
    expect(Date.parse(opened.deadlineAt)).toBe(T0 + 5000);
    jest.advanceTimersByTime(4999);
    const id = opened.decisionId;
    const viewAt = () => obstacleDecision.listDecisions(null).then((list) => list.find((d) => d.decisionId === id));
    expect((await viewAt()).decision).toBeNull();
    jest.advanceTimersByTime(1);
    const decided = await viewAt();
    expect(decided.decision).toMatchObject({ choice: "REROUTE", source: "DEFAULT_TIMEOUT", decidedBy: null, decidedAt: new Date(T0 + 5000).toISOString() });
  });

  test("a manual decision just before the deadline wins, and the timer then commits nothing", async () => {
    const { prisma, calls } = stand();
    const { opened } = await openDecision({ prisma });
    jest.advanceTimersByTime(4999);
    expect(decide(opened.decisionId, "STOP")).toMatchObject({ status: 200, body: { outcome: "COMMITTED" } });
    jest.advanceTimersByTime(10_000);
    await flush();
    const view = (await obstacleDecision.listDecisions(null)).find((d) => d.decisionId === opened.decisionId);
    expect(view.decision).toMatchObject({ choice: "STOP", source: "MANUAL" });
    const commits = calls.filter((c) => c.method === "updateMany" && c.args.data.decision);
    expect(commits).toHaveLength(1);
    expect(commits[0].args.where).toEqual({ decisionId: opened.decisionId, status: "AWAITING_OPERATOR_DECISION" });
  });

  test("a click that reaches the server AT the deadline, before the timer runs, is late: the default is committed once", async () => {
    const { prisma, calls } = stand();
    const { opened } = await openDecision({ prisma });
    jest.setSystemTime(T0 + 5000); // the clock is at the deadline; the timer callback has not run
    expect(decide(opened.decisionId, "STOP")).toMatchObject({ status: 409, body: { error: "DEADLINE_PASSED", committed: { choice: "REROUTE", source: "DEFAULT_TIMEOUT" } } });
    jest.runOnlyPendingTimers();
    await flush();
    expect(calls.filter((c) => c.method === "updateMany" && c.args.data.decision)).toHaveLength(1);
    expect(decide(opened.decisionId, "STOP")).toMatchObject({ status: 409, body: { error: "DEFAULT_ALREADY_APPLIED" } });
  });

  test("is not extended by anything that happens before it (a dashboard disconnect is not an input)", async () => {
    const { opened } = await openDecision();
    jest.advanceTimersByTime(5000);
    const view = (await obstacleDecision.listDecisions(null)).find((d) => d.decisionId === opened.decisionId);
    expect(view.decision.source).toBe("DEFAULT_TIMEOUT");
  });
});

describe("at most one decision", () => {
  test("simultaneous decisions: exactly one commits, every other is refused naming the committed one", async () => {
    const { opened } = await openDecision();
    const results = [decide(opened.decisionId, "STOP", "operator-a"), decide(opened.decisionId, "REROUTE", "operator-b"), decide(opened.decisionId, "REJECT_BROADCAST", "operator-c"), decide(opened.decisionId, "STOP", "operator-d")];
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.slice(1).every((r) => r.status === 409 && r.body.committed.choice === "STOP")).toBe(true);
  });

  test("a retried request (same key, same choice) is answered with the committed result; a changed one is refused", async () => {
    const { opened } = await openDecision();
    expect(decide(opened.decisionId, "REJECT_BROADCAST", "retry-key-1")).toMatchObject({ status: 200, body: { outcome: "COMMITTED" } });
    expect(decide(opened.decisionId, "REJECT_BROADCAST", "retry-key-1")).toMatchObject({ status: 200, body: { outcome: "ALREADY_COMMITTED", replay: true } });
    expect(decide(opened.decisionId, "STOP", "retry-key-1")).toMatchObject({ status: 409, body: { error: "ALREADY_DECIDED" } });
  });

  test("malformed, unknown and badly keyed requests are refused before anything is decided", async () => {
    const { opened } = await openDecision();
    expect(obstacleDecision.decide({ decisionId: opened.decisionId, body: { decision: "PANIC", idempotencyKey: "key-0001" }, user: USER }).status).toBe(400);
    expect(obstacleDecision.decide({ decisionId: opened.decisionId, body: { decision: "STOP" }, user: USER }).status).toBe(400);
    expect(obstacleDecision.decide({ decisionId: opened.decisionId, body: { decision: "STOP", idempotencyKey: "has spaces in it" }, user: USER }).status).toBe(400);
    expect(obstacleDecision.decide({ decisionId: "00000000-0000-4000-8000-000000000000", body: { decision: "STOP", idempotencyKey: "key-0001" }, user: USER })).toMatchObject({ status: 404, body: { error: "UNKNOWN_DECISION" } });
    const view = (await obstacleDecision.listDecisions(null)).find((d) => d.decisionId === opened.decisionId);
    expect(view.decision).toBeNull();
  });
});

describe("delivery is a separate stage", () => {
  test("nothing reaches a robot room before the decision; REJECT_BROADCAST suppresses for good", async () => {
    const { io, opened, report } = await openDecision();
    await flush();
    expect(io.emitted.filter((e) => e.event === "OBSTACLE_ALERT")).toEqual([]);
    expect(io.emitted.map((e) => e.event)).toContain(obstacleDecision.REQUIRED_EVENT);
    decide(opened.decisionId, "REJECT_BROADCAST");
    await flush();
    expect(io.emitted.filter((e) => e.event === "OBSTACLE_ALERT" || e.event === "ALERT_CREATED")).toEqual([]);
    expect(await dtaroZoneAlert.propagateAlert({ io, prisma: null, obstacleId: report.obstacle.obstacleId })).toEqual({ ok: false, reason: "DELIVERY_SUPPRESSED" });
  });

  test("STOP delivers the zone alert once, carrying the decision", async () => {
    const { io, opened, report } = await openDecision();
    decide(opened.decisionId, "STOP");
    for (let i = 0; i < 5; i += 1) {
      jest.advanceTimersByTime(10);
      await flush();
    }
    const alerts = io.emitted.filter((e) => e.event === "OBSTACLE_ALERT");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ room: dtaroZoneAlert.zoneRoom("rA", "zE"), payload: { decisionId: opened.decisionId, decision: "STOP", decisionSource: "MANUAL" } });
    expect(await dtaroZoneAlert.propagateAlert({ io, prisma: null, obstacleId: report.obstacle.obstacleId })).toEqual({ ok: false, reason: "DELIVERY_PROPAGATED" });
  });
});

describe("the audit row", () => {
  test("is created with the server's times, then updated under the status guard", async () => {
    const { prisma, rows } = stand();
    const { opened } = await openDecision({ prisma });
    await flush();
    expect(rows.get(opened.decisionId)).toMatchObject({ status: "AWAITING_OPERATOR_DECISION", receivedAt: new Date(T0), deadlineAt: new Date(T0 + 5000), reportingRobotId: "REP", cellId: world.OB_CELL, regionId: "rA" });
    decide(opened.decisionId, "STOP");
    for (let i = 0; i < 5; i += 1) {
      jest.advanceTimersByTime(10);
      await flush();
    }
    expect(rows.get(opened.decisionId)).toMatchObject({ decision: "STOP", decisionSource: "MANUAL", decidedByUserId: USER.id, idempotencyKey: "key-STOP", status: "COMPLETED" });
  });

  test("a failed audit write is reported on the decision, and never stops the decision or the default", async () => {
    const io = fakeIo();
    const prisma = createPermissivePrisma((model) => {
      if (model === "dtaroObstacleDecision") throw new Error("relation \"DtaroObstacleDecision\" does not exist");
      return undefined;
    });
    const socket = { data: { robotId: "REP", isAuthed: true, dtaroEligible: true, dtaroZone: { regionId: "rA", zoneId: "zE", room: dtaroZoneAlert.zoneRoom("rA", "zE") } }, emit: jest.fn() };
    const report = await dtaroZoneAlert.processReport({ io, prisma, kv: null, snapshot: { spatial: SPATIAL }, socket, reporterRobotId: "REP", report: { lat: world.O.lat, lon: world.O.lon, severity: "LOW" }, deferDelivery: true });
    const opened = obstacleDecision.open({ io, prisma, snapshotOf: () => ({ spatial: SPATIAL }), positionOf: async () => null, report });
    await flush();
    jest.advanceTimersByTime(5000);
    await flush();
    const view = (await obstacleDecision.listDecisions(null)).find((d) => d.decisionId === opened.decisionId);
    expect(view.decision).toMatchObject({ source: "DEFAULT_TIMEOUT" });
    expect(view.persistence).toMatchObject({ ok: false, error: expect.stringMatching(/does not exist/) });
  });
});

describe("restart recovery and retention", () => {
  test("every open decision is marked ABANDONED_ON_RESTART (never executed late); old rows are deleted", async () => {
    const calls = [];
    const prisma = createPermissivePrisma((model, method, args) => {
      if (model !== "dtaroObstacleDecision") return undefined;
      calls.push({ method, args });
      return { count: method === "updateMany" ? 2 : 5 };
    });
    const result = await obstacleDecision.recoverAfterRestart(prisma, { env: { DTARO_DECISION_RETENTION_DAYS: "7" } });
    expect(result).toEqual({ ok: true, abandoned: 2, deleted: 5 });
    const update = calls.find((c) => c.method === "updateMany");
    expect(update.args.where.status.in.sort()).toEqual(["AWAITING_OPERATOR_DECISION", "DECIDED", "EXECUTING", "PROPAGATED", "REPORTED", "SUPPRESSED"]);
    // Only rows a previous process left: received before this recovery started.
    expect(update.args.where.receivedAt).toEqual({ lt: new Date(T0) });
    expect(update.args.data).toMatchObject({ status: "ABANDONED_ON_RESTART", abandonedReason: expect.stringMatching(/nothing was executed late/) });
    const remove = calls.find((c) => c.method === "deleteMany");
    expect(remove.args.where.receivedAt.lt).toEqual(new Date(T0 - 7 * 86_400_000));
  });

  test("an archived row is listed with its reason, as stored", async () => {
    const prisma = createPermissivePrisma((model, method) =>
      model === "dtaroObstacleDecision" && method === "findMany"
        ? [{ decisionId: "d-old", obstacleId: "OBS-1", regionId: "rA", zoneId: "zE", cellId: world.OB_CELL, lat: 1, lon: 2, severity: "LOW", reportingRobotId: "REP", status: "ABANDONED_ON_RESTART", receivedAt: new Date(T0 - 60_000), deadlineAt: new Date(T0 - 55_000), expiresAt: new Date(T0 + 240_000), abandonedReason: "The server restarted…" }]
        : undefined,
    );
    const [row] = await obstacleDecision.listDecisions(prisma);
    expect(row).toMatchObject({ decisionId: "d-old", archived: true, status: "ABANDONED_ON_RESTART", abandonedReason: "The server restarted…", decision: null });
  });
});

describe("legsAhead — the legs still ahead on the commanded route, from the server-held position", () => {
  const P = (x) => world.xy(x, 0);
  const route = { stops: [{ index: 0, stopType: "PICKUP", points: [P(0), P(10), P(20)] }, { index: 1, stopType: "DROP", points: [P(20), P(30), P(40)] }] };

  test("on the first leg: the rest of it from the robot, then the whole second leg", () => {
    const legs = obstacleDecision.legsAhead(route, P(5), 0);
    expect(legs.map((l) => [l.stopIndex, l.geometry.length])).toEqual([[0, 3], [1, 3]]);
    expect(legs[0].from).toEqual(P(5));
    expect(legs[0].to).toEqual(P(20));
  });

  test("on the second leg (including its junction with the first): only that leg", () => {
    expect(obstacleDecision.legsAhead(route, P(25), 3).map((l) => l.stopIndex)).toEqual([1]);
    expect(obstacleDecision.legsAhead(route, P(20), 2).map((l) => l.stopIndex)).toEqual([1]);
  });

  test("no position or no cut: no legs (the robot is then stopped, never guessed about)", () => {
    expect(obstacleDecision.legsAhead(route, null, 0)).toEqual([]);
    expect(obstacleDecision.legsAhead(route, P(5), null)).toEqual([]);
  });
});

describe("sendNav — never to a session that is not a simulated robot", () => {
  const socket = (data) => ({ data: { isAuthed: true, dtaroEligible: true, robotId: "R1", ...data }, sent: [], emit(event, payload) { this.sent.push({ event, payload }); } });
  const ioWith = (sockets) => ({ in: () => ({ fetchSockets: async () => sockets }) });

  test("one simulated session: delivered", async () => {
    const s = socket();
    expect(await obstacleDecision.sendNavForTests(ioWith([s]), "R1", { action: "STOP" })).toEqual({ delivered: true, sockets: 1 });
    expect(s.sent.map((m) => m.event)).toEqual([obstacleDecision.NAV_EVENT]);
  });

  test("a room holding ANY non-simulated, unauthenticated or foreign socket: nothing is sent to any of them", async () => {
    for (const odd of [{ dtaroEligible: false }, { isAuthed: false }, { robotId: "OTHER" }]) {
      const good = socket();
      const bad = socket(odd);
      expect(await obstacleDecision.sendNavForTests(ioWith([good, bad]), "R1", { action: "STOP" })).toEqual({ delivered: false, reason: "NOT_SIMULATED" });
      expect([good.sent, bad.sent]).toEqual([[], []]);
    }
  });

  test("no socket at all: not delivered, and said so", async () => {
    expect(await obstacleDecision.sendNavForTests(ioWith([]), "R1", { action: "STOP" })).toEqual({ delivered: false, reason: "ROBOT_NOT_CONNECTED" });
  });
});

describe("restart recovery never abandons a decision the booting process itself holds", () => {
  test("a decision accepted after recovery started stays AWAITING in the audit table", async () => {
    // A store that applies the recovery's where-clause the way PostgreSQL would.
    const rows = new Map();
    const prisma = createPermissivePrisma((model, method, args) => {
      if (model !== "dtaroObstacleDecision") return undefined;
      const where = (args && args.where) || {};
      if (method === "create") {
        rows.set(args.data.decisionId, { ...args.data });
        return rows.get(args.data.decisionId);
      }
      if (method === "updateMany") {
        const apply = () => {
          let count = 0;
          for (const row of rows.values()) {
            const statusOk = where.status && where.status.in ? where.status.in.includes(row.status) : typeof where.status !== "string" || row.status === where.status;
            const idOk = !where.decisionId || row.decisionId === where.decisionId;
            const timeOk = !where.receivedAt || row.receivedAt < where.receivedAt.lt;
            if (statusOk && idOk && timeOk) {
              for (const [k, v] of Object.entries(args.data)) if (v !== undefined) row[k] = v;
              count += 1;
            }
          }
          return { count };
        };
        // The recovery query is still travelling to the database when this process accepts a
        // report: it is executed 50 ms later, against whatever rows exist by then.
        if (where.status && where.status.in) return new Promise((resolve) => setTimeout(() => resolve(apply()), 50));
        return apply();
      }
      if (method === "deleteMany") return { count: 0 };
      return undefined;
    });
    // A row a previous process left open, received a minute ago.
    rows.set("old", { decisionId: "old", status: "EXECUTING", receivedAt: new Date(T0 - 60_000) });
    const recovering = obstacleDecision.recoverAfterRestart(prisma);
    // This process accepts a report while the recovery query is still in flight.
    jest.advanceTimersByTime(1);
    const { opened } = await openDecision({ prisma });
    await flush();
    expect(rows.get(opened.decisionId).status).toBe("AWAITING_OPERATOR_DECISION");
    // Now the recovery query executes.
    jest.advanceTimersByTime(60);
    await recovering;
    await flush();
    expect(rows.get("old").status).toBe("ABANDONED_ON_RESTART");
    expect(rows.get(opened.decisionId).status).toBe("AWAITING_OPERATOR_DECISION");
  });
});

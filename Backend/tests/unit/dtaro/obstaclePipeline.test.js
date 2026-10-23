"use strict";

/**
 * DTARO Step 2 — a regression safety net for the obstacle pipeline as it stands.
 *
 *   OBSTACLE_REPORT (dtaro.handler) → alertDissemination.processObstacleReport
 *     → zoneManager.getZoneForCoordinates → ekb.storeObstacle → ALERT_CREATED (dashboardBroadcast)
 *     → robots:all scan → routeIntersection.findAffectedRobots → REROUTE_ALERT → routing.rerouteRobot
 *
 * Read with `docs/audits/dtaro-zone-coordination/`. This file adds tests only; it changes no
 * behaviour. It has three kinds of test, kept in separate blocks on purpose:
 *
 *   INV-*   Invariants. Must keep passing through every later DTARO step.
 *   CURRENT BEHAVIOUR (changes with OD-n)
 *           Characterisations of known gaps. They describe what the code does today, NOT what
 *           it should do. The owner decision named in each title is the one that, once approved,
 *           is expected to change the assertion — update the test in that change, do not treat
 *           it as a product requirement.
 *   FUTURE INVARIANT (test.failing)
 *           Decision-independent defects. They fail today, so `test.failing` passes. When the
 *           defect is fixed the test starts passing, `test.failing` turns red, and the fixer
 *           converts it to an ordinary `test` (the `shardSupervisorTickModel.test.js` pattern).
 *           Each has an ordinary sibling test proving its setup is valid, because a
 *           `test.failing` cannot tell an assertion failure from a broken fixture.
 *
 * Everything here is offline: KV is the real facade in its in-memory mode (`createTestKv`),
 * Prisma is a recording double, `getPrisma()` is replaced so no client is ever constructed,
 * and Mapbox refuses every call. Time is controlled by a `Date.now` spy, never by sleeping.
 * Unit-level coverage only: no composed `server.js`, no real Socket.IO, no database.
 */

const SRC = "../../../src";

/* ── No network: Mapbox refuses. A reroute that reached it would fall back, never hang. ── */
jest.mock("../../../src/services/mapbox.service", () => ({
  matrixDurationsToDestination: jest.fn(async () => {
    throw new Error("mapbox is not reachable from unit tests");
  }),
  directionsPolyline: jest.fn(async () => {
    throw new Error("mapbox is not reachable from unit tests");
  }),
  directionsWithDistance: jest.fn(async () => {
    throw new Error("mapbox is not reachable from unit tests");
  }),
}));

/* ── No database: getPrisma() returns a recorder. Only the INV-5 control's campus lookup answers. ── */
const mockDb = { calls: [], robotCampus: new Map() };
jest.mock("../../../src/db/prisma", () => {
  const actual = jest.requireActual("../../../src/db/prisma");
  const client = new Proxy(
    {},
    {
      get(_target, model) {
        if (typeof model !== "string" || model === "then") return undefined;
        return new Proxy(
          {},
          {
            get(_t, method) {
              if (typeof method !== "string" || method === "then") return undefined;
              return async (args) => {
                mockDb.calls.push({ model, method, args });
                if (model === "robot" && method === "findFirst") {
                  const key = args && args.where && args.where.OR && args.where.OR[0] && args.where.OR[0].robotId;
                  const campusId = mockDb.robotCampus.get(key);
                  return campusId ? { campusId, campus: { regionId: null }, agent: null } : null;
                }
                throw new Error(`unexpected database access in a unit test: ${model}.${method}`);
              };
            },
          },
        );
      },
    },
  );
  return { ...actual, getPrisma: () => client };
});

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, socket() {} };

/* ═══════════════════════════════════════════════════════════════════════════
   Fixtures
   ═══════════════════════════════════════════════════════════════════════════ */

/** The RNSIT seed centre; the obstacle in every scenario. */
const OBS = Object.freeze({ lat: 12.9023, lon: 77.5186 });

/** A legacy bounding-box zone containing OBS, shaped like the V1 bootstrap's `rnsit-z1`. */
const ZONE = Object.freeze({ id: "rnsit-z1", name: "RNSIT Zone 1", minLat: 12.899, maxLat: 12.906, minLon: 77.515, maxLon: 77.522 });
const ZONE_ROOM = `zone:${ZONE.id}`;

/** ~110 m each way of the obstacle. */
const D = 0.001;

/**
 * Two straight routes through OBS. `alertDissemination` models a point obstacle as ONE segment
 * from (lat−δ, lon−δ) to (lat+δ, lon+δ), i.e. on the SW→NE bearing.
 *   NW→SE crosses that segment at OBS.
 *   SW→NE runs along it — collinear — and `segmentsIntersect` treats parallel as "no".
 */
const ROUTE_NW_SE = Object.freeze([
  { lat: OBS.lat + D, lon: OBS.lon - D },
  { lat: OBS.lat - D, lon: OBS.lon + D },
]);
const ROUTE_SW_NE = Object.freeze([
  { lat: OBS.lat - D, lon: OBS.lon - D },
  { lat: OBS.lat + D, lon: OBS.lon + D },
]);

/** Engine-owned models an obstacle report must never touch (INV-1). */
const ENGINE_MODELS = Object.freeze(["outbox", "commitment", "leg", "task", "mission"]);

/**
 * A Prisma double that records every model call. Unlike `createMockPrisma`, it does not need to
 * know a model in advance, so a call to `outbox`/`commitment`/`leg`/`task` is recorded rather
 * than turned into a swallowed TypeError — which is what makes an absence assertion meaningful.
 */
function createRecordingPrisma({ zones = [] } = {}) {
  const calls = [];
  const respond = (model, method, args) => {
    if (model === "zone" && method === "findMany") return zones.map((zone) => ({ ...zone }));
    if (model === "zone" && method === "count") return zones.length;
    if (method === "create" || method === "update" || method === "upsert") return { ...((args && args.data) || {}) };
    if (method === "createMany" || method === "updateMany" || method === "deleteMany") return { count: 0 };
    if (method === "findMany") return [];
    return null;
  };
  const model = (name) =>
    new Proxy(
      {},
      {
        get(_target, method) {
          if (typeof method !== "string" || method === "then") return undefined;
          return async (args) => {
            calls.push({ model: name, method, args });
            return respond(name, method, args);
          };
        },
      },
    );
  const prisma = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        if (prop === "$transaction") {
          return async (work) => {
            calls.push({ model: "$transaction", method: "call" });
            return typeof work === "function" ? work(prisma) : Promise.all(work);
          };
        }
        if (prop.startsWith("$")) {
          return async (...args) => {
            calls.push({ model: prop, method: "call", args });
            return null;
          };
        }
        return model(prop);
      },
    },
  );
  return { prisma, calls };
}

/** Engine-model or raw/transaction calls in a recording. */
function engineTouches(calls) {
  return calls.filter((call) => ENGINE_MODELS.includes(call.model) || call.model.startsWith("$"));
}

/** Every fenced command emitted to any room or socket. */
function fencedCommandEmits(fencing, io, sockets) {
  const commands = new Set([...fencing.MISSION_COMMANDS, ...fencing.AGENT_COMMANDS, ...fencing.QUERY_COMMANDS]);
  const out = [];
  for (const [room, list] of io._rooms) {
    for (const message of list) if (commands.has(message.event)) out.push({ to: room, event: message.event });
  }
  for (const socket of sockets) {
    for (const message of socket.sent) if (commands.has(message.event)) out.push({ to: socket.id, event: message.event });
  }
  return out;
}

/** The rooms that received `event`. */
function roomsReceiving(io, event) {
  return [...io._rooms].filter(([, list]) => list.some((message) => message.event === event)).map(([room]) => room);
}

/** The obstacle records the EKB holds in KV (its primary store). */
async function storedObstacles(kv) {
  const ids = (await kv.smembers("ekb:obstacles")) || [];
  const records = [];
  for (const id of ids) {
    const raw = await kv.get(`ekb:event:${id}`);
    if (raw) records.push(JSON.parse(raw));
  }
  return records;
}

/** A minimal non-volatile store for a VirtualRobot (the behaviour suite's `makeFlash`). */
function makeFlash() {
  const values = new Map();
  return {
    async get(key) {
      return values.has(key) ? values.get(key) : null;
    },
    async set(key, value) {
      values.set(key, value);
      return "OK";
    },
    async del(key) {
      values.delete(key);
    },
    async sadd() {
      return 1;
    },
  };
}

const openKvs = [];

/**
 * A fresh module registry and an isolated world: every module-level cache (the zone cache, the
 * rate limiter's `lastEvent`, the EKB's in-memory fallback, `dashboardBroadcast`'s members) is
 * new, so no test depends on another's order.
 *
 * @param {{ robots?: Array<{ robotId: string, plannedPath?: object[] }> }} [options]
 */
async function createWorld({ robots = [] } = {}) {
  jest.resetModules();
  mockDb.calls.length = 0;
  mockDb.robotCampus.clear();

  const { createTestKv } = require("../../helpers/testKv");
  const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
  const m = {
    registerDtaroHandlers: require(`${SRC}/sockets/handlers/dtaro.handler`).registerDtaroHandlers,
    alertDissemination: require(`${SRC}/services/alertDissemination.service`),
    ekb: require(`${SRC}/services/ekb.service`),
    registry: require(`${SRC}/services/robotRegistry.service`),
    zoneManager: require(`${SRC}/services/zoneManager.service`),
    dashboardBroadcast: require(`${SRC}/sockets/dashboardBroadcast`),
    fencing: require(`${SRC}/engine/commitment/fencing`),
    createFakeSocket,
  };

  const { kv, close } = await createTestKv();
  openKvs.push(close);
  const rec = createRecordingPrisma({ zones: [ZONE] });
  const io = createFakeIo();

  for (const robot of robots) {
    await kv.sadd("robots:all", robot.robotId);
    await m.registry.setRobotState(kv, robot.robotId, {
      robotId: robot.robotId,
      lat: OBS.lat,
      lon: OBS.lon,
      ...(robot.plannedPath ? { plannedPath: robot.plannedPath.map((point) => ({ ...point })) } : {}),
    });
  }

  /** Register the real handlers on a socket; returns a function that awaits one report. */
  const attach = (socket) => {
    m.registerDtaroHandlers(io, socket, { prisma: rec.prisma, kv, logger: silentLogger, appLocals: {} });
    const [listener] = socket.listeners("OBSTACLE_REPORT");
    return (payload) => listener(payload);
  };

  const reporter = createFakeSocket({ id: "socket-reporter", data: { robotId: "RBT-REPORTER" } });
  const report = attach(reporter);

  return { ...m, kv, rec, io, reporter, report, attach };
}

afterEach(async () => {
  while (openKvs.length) {
    const close = openKvs.pop();
    // eslint-disable-next-line no-await-in-loop
    if (typeof close === "function") await close();
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   INV-1 — assignment-engine isolation
   ═══════════════════════════════════════════════════════════════════════════ */

describe("INV-1 — an obstacle report never touches the assignment engine", () => {
  test("the deepest reachable path (legacy reroute runs) writes no Outbox/Commitment/Leg/Task and emits no fenced command", async () => {
    const w = await createWorld({
      robots: [{ robotId: "RBT-CROSS", plannedPath: ROUTE_NW_SE }, { robotId: "RBT-IDLE" }],
    });
    // A legacy-shaped route cache WITH pickup/drop, so `rerouteRobot` does not return early:
    // the most behaviour this path can produce today.
    await w.kv.set("robotTaskState:RBT-CROSS", JSON.stringify({ taskId: "T-LEGACY", pathIndex: 0, segment: "toPickup" }));
    await w.kv.set(
      "taskPath:T-LEGACY",
      JSON.stringify({ toPickup: ROUTE_NW_SE, toDrop: ROUTE_SW_NE, pickup: ROUTE_NW_SE[1], drop: ROUTE_SW_NE[1] }),
    );

    await w.report({ lat: OBS.lat, lon: OBS.lon, severity: "HIGH" });

    // Coverage proof: the reroute branch really ran (it redraws the dashboard route).
    const rerouted = w.io.emittedTo("dashboard", "TASK_UPDATED");
    expect(rerouted).toEqual([expect.objectContaining({ robotId: "RBT-CROSS", taskId: "T-LEGACY", action: "REROUTED" })]);
    // Recorder proof: it does observe writes — the EKB's best-effort row is there.
    expect(w.rec.calls).toEqual(expect.arrayContaining([expect.objectContaining({ model: "obstacleEvent", method: "create" })]));

    // The invariant.
    expect(engineTouches(w.rec.calls)).toEqual([]);
    expect(mockDb.calls).toEqual([]);
    expect(fencedCommandEmits(w.fencing, w.io, [w.reporter])).toEqual([]);
    expect(w.io.emit).not.toHaveBeenCalled();
  });

  test("control: the INV-1 detectors do flag an engine write and a fenced command", async () => {
    const w = await createWorld();
    await w.rec.prisma.commitment.update({ where: { commitmentId: "C-1" }, data: { releasedAt: new Date(0) } });
    await w.rec.prisma.$transaction(async () => null);
    w.io.to("robot:RBT-CROSS").emit("REROUTE", { commitmentId: "C-1" });

    expect(engineTouches(w.rec.calls).map((call) => `${call.model}.${call.method}`)).toEqual(["commitment.update", "$transaction.call"]);
    expect(fencedCommandEmits(w.fencing, w.io, [w.reporter])).toEqual([{ to: "robot:RBT-CROSS", event: "REROUTE" }]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   INV-2 — authentication
   ═══════════════════════════════════════════════════════════════════════════ */

describe("INV-2 — an unauthenticated OBSTACLE_REPORT is refused and stores nothing", () => {
  test("a socket with no robotId gets ERROR 'Not authenticated' and no obstacle exists anywhere", async () => {
    const w = await createWorld();
    const anonymous = w.createFakeSocket({ id: "socket-anonymous", data: {} });
    const report = w.attach(anonymous);

    await report({ lat: OBS.lat, lon: OBS.lon, severity: "HIGH" });

    expect(anonymous.sent).toEqual([{ event: "ERROR", payload: { event: "OBSTACLE_REPORT", reason: "Not authenticated" } }]);
    expect(await storedObstacles(w.kv)).toEqual([]);
    expect(w.rec.calls.filter((call) => call.model === "obstacleEvent")).toEqual([]);
    expect(w.io._rooms.size).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   INV-3 — payload validation (the schema: lat number, lon number, severity LOW|MEDIUM|HIGH|CRITICAL?)
   ═══════════════════════════════════════════════════════════════════════════ */

describe("INV-3 — an invalid payload is refused and stores nothing", () => {
  // Note, recorded rather than tested: the schema has no range check, so a numeric but
  // impossible coordinate (lat 999) is accepted today. That belongs to report hardening (OD-5).
  test.each([
    ["no payload at all", undefined],
    ["lat missing", { lon: OBS.lon }],
    ["lon missing", { lat: OBS.lat }],
    ["lat as a numeric string", { lat: String(OBS.lat), lon: OBS.lon }],
    ["lon null (what JSON makes of NaN)", { lat: OBS.lat, lon: null }],
    ["lat as an object", { lat: { value: OBS.lat }, lon: OBS.lon }],
    ["severity outside the enum", { lat: OBS.lat, lon: OBS.lon, severity: "SEVERE" }],
    ["severity in the wrong case", { lat: OBS.lat, lon: OBS.lon, severity: "high" }],
    ["severity as a number", { lat: OBS.lat, lon: OBS.lon, severity: 3 }],
  ])("%s → ERROR 'Invalid payload', nothing stored or broadcast", async (_name, payload) => {
    const w = await createWorld();

    await w.report(payload);

    expect(w.reporter.sent).toHaveLength(1);
    expect(w.reporter.sent[0]).toEqual({
      event: "ERROR",
      payload: expect.objectContaining({ event: "OBSTACLE_REPORT", reason: "Invalid payload", details: expect.any(Array) }),
    });
    expect(await storedObstacles(w.kv)).toEqual([]);
    expect(w.rec.calls.filter((call) => call.model === "obstacleEvent")).toEqual([]);
    expect(w.io._rooms.size).toBe(0);
  });

  test("control: the same fixture accepts a valid payload (severity defaults to MEDIUM)", async () => {
    const w = await createWorld();

    await w.report({ lat: OBS.lat, lon: OBS.lon });

    const stored = await storedObstacles(w.kv);
    expect(stored).toEqual([expect.objectContaining({ lat: OBS.lat, lon: OBS.lon, severity: "MEDIUM", reportingRobotId: "RBT-REPORTER" })]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   INV-4 — rate limiting (allow(): minIntervalMs 500, limit 10 per 60 s, keyed by socket id)
   ═══════════════════════════════════════════════════════════════════════════ */

describe("INV-4 — a second report inside the minimum interval is dropped", () => {
  test("T0 accepted, T0+499 ms dropped silently, T0+500 ms accepted", async () => {
    const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
    const clock = jest.spyOn(Date, "now");
    const w = await createWorld();

    clock.mockReturnValue(T0);
    await w.report({ lat: OBS.lat, lon: OBS.lon });
    expect(await storedObstacles(w.kv)).toHaveLength(1);

    clock.mockReturnValue(T0 + 499);
    await w.report({ lat: OBS.lat + 0.0001, lon: OBS.lon });
    // Dropped: no new record, no reply of any kind.
    expect(await storedObstacles(w.kv)).toHaveLength(1);
    expect(w.reporter.sent.map((message) => message.event)).toEqual(["OBSTACLE_REPORT_ACK"]);

    clock.mockReturnValue(T0 + 500);
    await w.report({ lat: OBS.lat + 0.0002, lon: OBS.lon });
    expect(await storedObstacles(w.kv)).toHaveLength(2);
    expect(w.reporter.sent.map((message) => message.event)).toEqual(["OBSTACLE_REPORT_ACK", "OBSTACLE_REPORT_ACK"]);
    expect(w.rec.calls.filter((call) => call.model === "obstacleEvent" && call.method === "create")).toHaveLength(2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   INV-5 — dashboard isolation (dashboardBroadcast default deny)
   ═══════════════════════════════════════════════════════════════════════════ */

describe("INV-5 — ALERT_CREATED reaches the SUPER_ADMIN room only", () => {
  test("with a campus ADMIN room active, ALERT_CREATED goes to `dashboard` and to no other room", async () => {
    const w = await createWorld();
    w.dashboardBroadcast.memberJoined("campus-A");
    mockDb.robotCampus.set("RBT-REPORTER", "campus-A");

    await w.report({ lat: OBS.lat, lon: OBS.lon, severity: "HIGH" });
    await w.dashboardBroadcast.drain();

    const [alert] = w.io.emittedTo("dashboard", "ALERT_CREATED");
    expect(alert).toEqual(expect.objectContaining({ lat: OBS.lat, lon: OBS.lon, severity: "HIGH", reportingRobotId: "RBT-REPORTER" }));
    expect(roomsReceiving(w.io, "ALERT_CREATED")).toEqual(["dashboard"]);
    expect(w.io.emittedTo(w.dashboardBroadcast.campusRoom("campus-A"), "ALERT_CREATED")).toEqual([]);
    expect(w.io.emit).not.toHaveBeenCalled();
    // ALERT_CREATED is not on the allow-list, so not even a campus lookup was attempted.
    expect(mockDb.calls).toEqual([]);
  });

  test("control: the same harness does observe a campus relay for an allow-listed robot event", async () => {
    const w = await createWorld();
    w.dashboardBroadcast.memberJoined("campus-A");
    mockDb.robotCampus.set("RBT-REPORTER", "campus-A");

    w.dashboardBroadcast.emit(w.io, "ROBOT_UPDATED", { robotId: "RBT-REPORTER" });
    await w.dashboardBroadcast.drain();

    expect(w.io.emittedTo(w.dashboardBroadcast.campusRoom("campus-A"), "ROBOT_UPDATED")).toEqual([{ robotId: "RBT-REPORTER" }]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   INV-6 — acknowledgement contract
   ═══════════════════════════════════════════════════════════════════════════ */

describe("INV-6 — OBSTACLE_REPORT_ACK goes to the reporter only, with { obstacleId, affectedRobots, timestamp }", () => {
  // As implemented: three fields, `affectedRobots` is a COUNT (not a list), and the ack carries
  // no zoneId, version or expiresAt. Recorded as-is; extending it belongs to a later step.
  test("no affected robots: one ack on the reporter socket naming the stored obstacle, count 0", async () => {
    const w = await createWorld({ robots: [{ robotId: "RBT-IDLE" }] });

    await w.report({ lat: OBS.lat, lon: OBS.lon, severity: "LOW" });

    const acks = w.reporter.sent.filter((message) => message.event === "OBSTACLE_REPORT_ACK");
    expect(acks).toHaveLength(1);
    const ack = acks[0].payload;
    expect(Object.keys(ack).sort()).toEqual(["affectedRobots", "obstacleId", "timestamp"]);

    const [stored] = await storedObstacles(w.kv);
    const [alert] = w.io.emittedTo("dashboard", "ALERT_CREATED");
    expect(ack).toEqual({ obstacleId: stored.obstacleId, affectedRobots: 0, timestamp: stored.timestamp });
    expect(alert.obstacleId).toBe(ack.obstacleId);
    expect(roomsReceiving(w.io, "OBSTACLE_REPORT_ACK")).toEqual([]);
  });

  test("one affected robot: affectedRobots is the count 1", async () => {
    const w = await createWorld({ robots: [{ robotId: "RBT-CROSS", plannedPath: ROUTE_NW_SE }, { robotId: "RBT-IDLE" }] });

    await w.report({ lat: OBS.lat, lon: OBS.lon });

    const [ack] = w.reporter.sent.filter((message) => message.event === "OBSTACLE_REPORT_ACK");
    expect(ack.payload.affectedRobots).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   CURRENT BEHAVIOUR — characterisations of known gaps (not requirements)
   ═══════════════════════════════════════════════════════════════════════════ */

describe("CURRENT BEHAVIOUR — known gaps, to be changed by the named owner decision", () => {
  test("CURRENT BEHAVIOUR (changes with OD-1/OD-2): the obstacle's zone is resolved but no zone room is addressed", async () => {
    const w = await createWorld({ robots: [{ robotId: "RBT-IN-ZONE" }] });

    await w.report({ lat: OBS.lat, lon: OBS.lon });

    const [alert] = w.io.emittedTo("dashboard", "ALERT_CREATED");
    expect(alert).toEqual(expect.objectContaining({ zoneId: ZONE.id, zoneName: ZONE.name }));
    const [stored] = await storedObstacles(w.kv);
    expect(stored.zoneId).toBe(ZONE.id);
    // When zone-scoped delivery is approved, this becomes a positive assertion on the
    // (region-qualified) zone room.
    expect([...w.io._rooms.keys()].filter((room) => room.startsWith("zone:"))).toEqual([]);
  });

  test("CURRENT BEHAVIOUR (changes with OD-2): with no plannedPath anywhere, the recipient set is empty", async () => {
    const w = await createWorld({ robots: [{ robotId: "RBT-A" }, { robotId: "RBT-B" }] });

    const result = await w.alertDissemination.processObstacleReport(w.rec.prisma, w.kv, w.io, {
      lat: OBS.lat,
      lon: OBS.lon,
      reportingRobotId: "RBT-A",
    });

    expect(result.affectedRobotIds).toEqual([]);
    expect([...w.io._rooms.keys()].filter((room) => room.startsWith("robot:"))).toEqual([]);
    // Nothing on the current tree seeds `plannedPath`; both robots were enumerated and skipped.
    expect((await w.registry.getRobotState(w.kv, "RBT-A")).plannedPath).toBeUndefined();
  });

  test("CURRENT BEHAVIOUR (changes with OD-2/OD-3): the dissemination-shaped REROUTE_ALERT does not change the simulator's navigation", async () => {
    const w = await createWorld({ robots: [{ robotId: "RBT-CROSS", plannedPath: ROUTE_NW_SE }] });
    await w.report({ lat: OBS.lat, lon: OBS.lon, severity: "HIGH" });

    // The payload the server actually sent to the robot's room.
    const [payload] = w.io.emittedTo("robot:RBT-CROSS", "REROUTE_ALERT");
    expect(Object.keys(payload).sort()).toEqual(["lat", "lon", "obstacleId", "severity", "timestamp", "zoneId"]);

    const { robot, socket } = makeSimulatedRobot("RBT-CROSS");
    const before = JSON.stringify({ activePath: robot.activePath, pathIndex: robot.pathIndex });

    socket.trigger("REROUTE_ALERT", payload);

    expect(JSON.stringify({ activePath: robot.activePath, pathIndex: robot.pathIndex })).toBe(before);
  });

  test("control: the same simulated robot does change navigation for a REROUTE_ALERT carrying newPath", () => {
    const { robot, socket } = makeSimulatedRobot("RBT-CROSS");
    const newPath = [
      { lat: OBS.lat, lon: OBS.lon - 2 * D },
      { lat: OBS.lat + 2 * D, lon: OBS.lon },
    ];

    socket.trigger("REROUTE_ALERT", { newPath, segment: "toPickup" });

    expect(robot.activePath).toEqual(newPath);
    expect(robot.pathIndex).toBe(0);
  });

  test("CURRENT BEHAVIOUR (changes with OD-4): an obstacle lives exactly 300 s of wall clock, then vanishes", async () => {
    const T0 = Date.UTC(2026, 9, 22, 12, 0, 0);
    const clock = jest.spyOn(Date, "now").mockReturnValue(T0);
    const w = await createWorld();

    await w.report({ lat: OBS.lat, lon: OBS.lon });

    const [stored] = await storedObstacles(w.kv);
    expect(stored.timestamp).toBe(T0);
    expect(Date.parse(stored.expiresAt) - stored.timestamp).toBe(300_000);
    const [row] = w.rec.calls.filter((call) => call.model === "obstacleEvent" && call.method === "create");
    expect(row.args.data.expiresAt.getTime()).toBe(T0 + 300_000);

    clock.mockReturnValue(T0 + 299_999);
    expect((await w.ekb.getActiveObstacles(w.kv)).map((o) => o.obstacleId)).toEqual([stored.obstacleId]);

    clock.mockReturnValue(T0 + 300_001);
    expect(await w.ekb.getActiveObstacles(w.kv)).toEqual([]);
  });
});

/**
 * A real VirtualRobot with a fake socket, its listeners registered through the production
 * `_registerHandlers()` so the test exercises the real wiring, mid-route on a three-point path.
 */
function makeSimulatedRobot(robotId) {
  const VirtualRobot = require(`${SRC}/simulation/VirtualRobot`);
  const { createFakeSocket } = require("../../helpers/fakeSocket");
  const socket = createFakeSocket({ id: `socket-${robotId}`, data: {} });
  const robot = new VirtualRobot({
    robotId,
    lat: OBS.lat,
    lon: OBS.lon,
    logger: silentLogger,
    kv: makeFlash(),
    simulated: true,
    socket: undefined,
  });
  robot.socket = socket;
  robot.connected = true;
  robot._registerHandlers();
  robot.activePath = [
    { lat: OBS.lat + D, lon: OBS.lon - D },
    { lat: OBS.lat, lon: OBS.lon },
    { lat: OBS.lat - D, lon: OBS.lon + D },
  ];
  robot.pathIndex = 1;
  return { robot, socket };
}

/* ═══════════════════════════════════════════════════════════════════════════
   FUTURE INVARIANTS — decision-independent defects (test.failing)
   ═══════════════════════════════════════════════════════════════════════════ */

describe("FI-1 — route relevance is direction-independent", () => {
  /** The fixture both tests share: one robot whose straight route passes exactly through OBS. */
  async function relevanceFor(route) {
    const w = await createWorld({ robots: [{ robotId: "RBT-ROUTE", plannedPath: route }] });
    const result = await w.alertDissemination.processObstacleReport(w.rec.prisma, w.kv, w.io, {
      lat: OBS.lat,
      lon: OBS.lon,
      reportingRobotId: "RBT-REPORTER",
    });
    return result.affectedRobotIds;
  }

  test("setup check: a route through the obstacle on the NW→SE bearing is detected", async () => {
    expect(await relevanceFor(ROUTE_NW_SE)).toEqual(["RBT-ROUTE"]);
  });

  // FAILS TODAY: the point obstacle is one SW→NE segment and parallel segments never
  // intersect, so a route through the obstacle on that bearing is missed. When fixed, make
  // this an ordinary `test`.
  test.failing("a route through the obstacle on the SW→NE bearing is detected", async () => {
    expect(await relevanceFor(ROUTE_SW_NE)).toEqual(["RBT-ROUTE"]);
  });
});

describe("FI-2 — a reconnect restores zone-room membership", () => {
  /**
   * First connection, then a disconnect, then a reconnect within the 30 s registry TTL. The
   * reconnect passes the registry's stored zone as `currentZoneId`, exactly as the AUTH handler
   * does (`robot.handler.js`: `assignRobotToZone(…, socket, liveState?.zoneId || null)`).
   */
  async function reconnectWithinTtl() {
    const w = await createWorld();
    const first = w.createFakeSocket({ id: "socket-first", data: { robotId: "RBT-Z" } });
    await w.zoneManager.assignRobotToZone(w.rec.prisma, w.kv, null, "RBT-Z", OBS.lat, OBS.lon, first, null);
    await w.registry.markOffline(w.kv, "RBT-Z", first.id);

    const live = await w.registry.getRobotState(w.kv, "RBT-Z");
    const second = w.createFakeSocket({ id: "socket-second", data: { robotId: "RBT-Z" } });
    await w.zoneManager.assignRobotToZone(w.rec.prisma, w.kv, null, "RBT-Z", OBS.lat, OBS.lon, second, live.zoneId || null);
    return { first, second, live };
  }

  test("setup check: the first connection joins the zone room and the registry keeps the zone across the disconnect", async () => {
    const { first, live } = await reconnectWithinTtl();
    expect(first.join).toHaveBeenCalledWith(ZONE_ROOM);
    expect(live.zoneId).toBe(ZONE.id);
    expect(live.connected).toBe(false);
  });

  // FAILS TODAY: `assignRobotToZone` joins the room only when the zone *changed*, and the
  // registry still holds the same zone, so the new socket is never joined. When fixed, make
  // this an ordinary `test`.
  test.failing("the reconnected socket is joined to the zone room", async () => {
    const { second } = await reconnectWithinTtl();
    expect(second.join).toHaveBeenCalledWith(ZONE_ROOM);
  });
});

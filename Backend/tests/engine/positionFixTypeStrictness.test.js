"use strict";

/**
 * C4 — an unrecognised GPS `fixType` is never an ordinary measured fix.
 *
 * Before: a `position` block whose `fixType` was outside the contract's five values fell
 * through `recordPositionObservation` as an ordinary Observation with no fixType and no
 * uncertainty — indistinguishable from a frame that sent no block. Arrival (`legProgress`)
 * and TASK_COMPLETE verification (`dtaro.handler`) read every non-dead-reckoned position row
 * with no fixType filter, so that row was arrival and completion evidence.
 *
 * Now the block is refused as NO_FIX is: no Observation is written. The chain tests below run
 * frames through the real writer into one in-memory Observation table that the real arrival
 * and completion code then reads, honouring the `where` clauses those readers write.
 */

const positionObservation = require("../../src/services/positionObservation.service");
const legProgress = require("../../src/services/legProgress.service");
const transitions = require("../../src/engine/lifecycle/transitions");
const verification = require("../../src/engine/supervision/verification");
const agentGate = require("../../src/engine/cutover/agentGate");
const { verifyCompletionClaim } = require("../../src/sockets/handlers/dtaro.handler");
const { createFakeSocket } = require("../helpers/fakeSocket");
const silentLogger = require("../mocks/silentLogger");

const AGENT_ROW = "agent-row-1";
const ROBOT = "RBT-1";
const MEASURED = ["2D", "3D", "RTK_FLOAT", "RTK_FIXED"];
const UNKNOWN = ["4D", "3d", "DGPS", "GNSS", "FIX", "", " 3D", 3, 0, true, {}, ["3D"]];

/** One Observation table, read and written with the where-clauses the production code uses. */
function observationTable() {
  const rows = [];
  const matches = (row, where = {}) =>
    (where.agentId === undefined || row.agentId === where.agentId) &&
    (where.kind === undefined || row.kind === where.kind) &&
    (where.deadReckoned === undefined || row.deadReckoned === where.deadReckoned) &&
    (!where.observedAt || where.observedAt.gte === undefined || row.observedAt >= where.observedAt.gte);
  return {
    rows,
    create: jest.fn(async ({ data }) => {
      rows.push({ ...data });
      return data;
    }),
    findFirst: jest.fn(async ({ where }) => rows.filter((r) => matches(r, where)).sort((a, b) => b.observedAt - a.observedAt)[0] || null),
    findMany: jest.fn(async ({ where }) => rows.filter((r) => matches(r, where)).sort((a, b) => a.observedAt - b.observedAt)),
  };
}

/** The writer's store: a physical Robot projected to AGENT_ROW, over `table`. */
const writerStore = (table) => ({
  robot: { findUnique: jest.fn(async () => ({ simulated: false, agent: { id: AGENT_ROW } })) },
  observation: table,
});

let sequence = 1000n;
const frame = (table, { lat, lon, atMs, fix }) =>
  positionObservation.recordPositionObservation(writerStore(table), {
    robotId: ROBOT,
    lat,
    lon,
    agentTimestampMs: atMs,
    sequence: (sequence += 1n),
    ...(fix === undefined ? {} : { fix }),
  });

beforeEach(() => positionObservation.resetPositionObservationState());
afterEach(() => jest.restoreAllMocks());

// ═══════════════════════════════════════════════════════════════════════════
describe("the writer — recognised fix types keep their behaviour", () => {
  test.each(MEASURED)("%s with an accuracy is written with that fixType and uncertainty", async (fixType) => {
    const table = observationTable();
    const out = await frame(table, { lat: 12.9, lon: 77.5, atMs: Date.now(), fix: { fixType, hAccM: 2.1 } });
    expect(out).toMatchObject({ written: true, outcome: "WRITTEN", provenance: "PHYSICAL" });
    expect(table.rows[0]).toMatchObject({ deadReckoned: false, uncertaintyRadiusM: 2.1, value: { fixType, provenance: "PHYSICAL" } });
  });

  test("NO_FIX is refused as before", async () => {
    const table = observationTable();
    const out = await frame(table, { lat: 12.9, lon: 77.5, atMs: Date.now(), fix: { fixType: "NO_FIX", hAccM: 2.1 } });
    expect(out).toMatchObject({ written: false, outcome: "NO_FIX_DECLARED" });
    expect(table.rows).toHaveLength(0);
  });

  test.each([
    ["no block (the contract's block is optional)", undefined],
    ["an explicit null block", null],
  ])("%s is written as before, with no fixType and no invented uncertainty", async (_name, fix) => {
    const table = observationTable();
    const out = await frame(table, { lat: 12.9, lon: 77.5, atMs: Date.now(), fix });
    expect(out.written).toBe(true);
    expect(table.rows[0].value.fixType).toBeUndefined();
    expect(table.rows[0].uncertaintyRadiusM).toBeUndefined();
  });

  test("a dead-reckoned 3D declaration is stored dead-reckoned, as before", async () => {
    const table = observationTable();
    expect((await frame(table, { lat: 12.9, lon: 77.5, atMs: Date.now(), fix: { fixType: "3D", hAccM: 2, deadReckoned: true } })).written).toBe(true);
    expect(table.rows.map((r) => r.deadReckoned)).toEqual([true]);
  });

  test("a dead-reckoned declaration with no fixType is refused INVALID_OBSERVATION, as it already was", async () => {
    // Before C4, `createObservation` refused it (a dead-reckoned position needs an uncertainty
    // radius, which is only read with a recognised type). Same outcome now, refused earlier.
    const out = await frame(observationTable(), { lat: 12.9, lon: 77.5, atMs: Date.now(), fix: { deadReckoned: true } });
    expect(out).toMatchObject({ written: false, outcome: "INVALID_OBSERVATION" });
  });
});

describe("the writer — an unrecognised or malformed fix block is refused", () => {
  test.each(UNKNOWN.map((value) => [JSON.stringify(value), value]))("fixType %s: no Observation", async (_name, fixType) => {
    const table = observationTable();
    const out = await frame(table, { lat: 12.9, lon: 77.5, atMs: Date.now(), fix: { fixType, hAccM: 1.5 } });
    expect(out).toMatchObject({ written: false, outcome: "INVALID_OBSERVATION" });
    expect(out.detail).toMatch(/position\.fixType .* is not one of NO_FIX\|2D\|3D\|RTK_FLOAT\|RTK_FIXED/);
    expect(table.create).not.toHaveBeenCalled();
  });

  test("an unknown fixType is refused even when it also claims dead reckoning", async () => {
    const table = observationTable();
    const out = await frame(table, { lat: 12.9, lon: 77.5, atMs: Date.now(), fix: { fixType: "DR", deadReckoned: true } });
    expect(out).toMatchObject({ written: false, outcome: "INVALID_OBSERVATION" });
  });

  test.each([
    ["a block with an accuracy but no fixType", { hAccM: 2 }, /declares no fixType/],
    ["an empty block", {}, /declares no fixType/],
    ["a string block", "3D", /not an object/],
    ["a number block", 3, /not an object/],
    ["an array block", ["3D"], /not an object/],
  ])("%s: refused", async (_name, fix, detail) => {
    const table = observationTable();
    const out = await frame(table, { lat: 12.9, lon: 77.5, atMs: Date.now(), fix });
    expect(out).toMatchObject({ written: false, outcome: "INVALID_OBSERVATION" });
    expect(out.detail).toMatch(detail);
    expect(table.rows).toHaveLength(0);
  });

  test("the telemetry handler passes the block as sent, so a malformed one is not mistaken for an absent one", () => {
    const source = require("fs").readFileSync(require("path").join(__dirname, "../../src/sockets/handlers/telemetry.handler.js"), "utf8");
    expect(source).toContain("fix: payload && payload.position !== undefined ? payload.position : null,");
    expect(source).not.toContain('payload.position && typeof payload.position === "object" ? payload.position : null');
  });

  test("the refusal detail does not echo an arbitrarily long value", async () => {
    const out = await frame(observationTable(), { lat: 12.9, lon: 77.5, atMs: Date.now(), fix: { fixType: "X".repeat(500) } });
    expect(out.detail.length).toBeLessThan(120);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the chain — unknown fixType → Observation → arrival / custody: not accepted", () => {
  const OLD_RADIUS = process.env.VERIFY_ARRIVAL_RADIUS_M;
  beforeAll(() => {
    process.env.VERIFY_ARRIVAL_RADIUS_M = "25";
  });
  afterAll(() => {
    if (OLD_RADIUS === undefined) delete process.env.VERIFY_ARRIVAL_RADIUS_M;
    else process.env.VERIFY_ARRIVAL_RADIUS_M = OLD_RADIUS;
  });

  const PICKUP = { stopType: "PICKUP", sequence: 1, lat: 12.9, lon: 77.5 };
  const DROP = { stopType: "DROP", sequence: 2, lat: 12.905, lon: 77.505 };
  const commitment = { commitmentId: "c-1", agentId: AGENT_ROW, legId: "leg-row-1", fence: 7n, grantedAt: new Date(0), releasedAt: null };
  const legEnRoutePickup = { id: "leg-row-1", legId: "L1", state: "EN_ROUTE_PICKUP", version: 3, stops: [PICKUP, DROP] };

  /** `legProgress`'s store over the same Observation table the writer filled. */
  const arrivalStore = (table) => {
    const tx = {
      $queryRawUnsafe: async () => [{ now: new Date() }],
      commitment: { findUnique: async () => commitment },
      leg: { findUnique: async () => legEnRoutePickup },
      observation: table,
      outbox: { findFirst: async () => null },
    };
    return { commitment: { findFirst: async () => commitment }, $transaction: async (fn) => fn(tx) };
  };

  const appliedEvents = () => {
    const events = [];
    jest.spyOn(transitions, "apply").mockImplementation(async (_tx, input) => {
      events.push(input.event);
      return { outcome: transitions.OUTCOME.APPLIED, from: input.leg.state, to: "AT_PICKUP", event: input.event };
    });
    return events;
  };

  async function driveToPickup(lastFix) {
    const table = observationTable();
    const now = Date.now();
    // A valid fix 111 m short of the pickup, then a fix at the pickup carrying `lastFix`.
    await frame(table, { lat: 12.901, lon: 77.5, atMs: now - 4000, fix: { fixType: "3D", hAccM: 1.5 } });
    const atPickup = await frame(table, { lat: 12.90005, lon: 77.5, atMs: now - 2000, fix: lastFix });
    const events = appliedEvents();
    const out = await legProgress.onPositionFix({ prisma: arrivalStore(table), agentRowId: AGENT_ROW, snapshot: { resolve: () => null, values: {} } });
    return { table, atPickup, out, events };
  }

  test("control: a recognised 3D fix at the pickup verifies the arrival", async () => {
    const run = await driveToPickup({ fixType: "3D", hAccM: 1.5 });
    expect(run.out && run.out.event).toBe(transitions.EVENT.ARRIVAL_VERIFIED);
  });

  test.each(["4D", "DGPS", "3d", 3])("fixType %p at the pickup: no arrival, no transition, so no custody admission", async (fixType) => {
    const run = await driveToPickup({ fixType, hAccM: 1.5 });
    expect(run.atPickup.written).toBe(false);
    // Only the valid far fix is evidence; the unknown one was never promoted into the table.
    expect(run.table.rows).toHaveLength(1);
    expect(run.out).toBeNull();
    // `onPositionFix` admits a held custody report only after an APPLIED arrival; none applied.
    expect(run.events).toEqual([]);
  });

  test("a malformed block at the pickup (no fixType) does not verify the arrival either", async () => {
    const run = await driveToPickup({ hAccM: 1.5 });
    expect(run.out).toBeNull();
    expect(run.events).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the chain — unknown fixType → Observation → TASK_COMPLETE verification: not accepted", () => {
  const VERIFY_V1 = Object.freeze({
    VERIFY_ARRIVAL_RADIUS_M: "25",
    VERIFY_TRACK_MIN_FIX_RATE: "10",
    VERIFY_TRACK_MIN_CORRIDOR_FRACTION: "0.8",
    VERIFY_TRACK_MAX_GAP_SECONDS: "10",
    VERIFY_CORRIDOR_HALF_WIDTH_M: "30",
    VERIFY_MAX_SPEED_MS: "8.33",
  });
  const ENV_BEFORE = { ...process.env };
  beforeEach(() => {
    process.env.ENGINE_ENABLED = "true";
    Object.assign(process.env, VERIFY_V1);
  });
  afterAll(() => {
    for (const key of [...Object.keys(VERIFY_V1), "ENGINE_ENABLED"]) {
      if (ENV_BEFORE[key] === undefined) delete process.env[key];
      else process.env[key] = ENV_BEFORE[key];
    }
  });

  const snapshot = {
    resolve: (name) => (name === "cutover.engine_enabled" ? true : name === "security.position_plausibility_tolerance" ? 1.2 : null),
    values: new Map(),
  };
  const START = Object.freeze({ lat: 12.9081, lon: 77.5012 });
  const DROP = Object.freeze({ lat: 12.90862, lon: 77.50172 });

  /** An 80 m drive that ends at the drop, one fix every 2 s ending 2 s ago; `fixFor(i)` per frame. */
  async function drive(fixFor) {
    const table = observationTable();
    const now = Date.now();
    for (let i = 0; i <= 28; i += 1) {
      const t = i / 28;
      await frame(table, {
        lat: START.lat + (DROP.lat - START.lat) * t,
        lon: START.lon + (DROP.lon - START.lon) * t,
        atMs: now - 58_000 + i * 2000,
        fix: fixFor(i),
      });
    }
    return table;
  }

  async function claim(table) {
    const evidence = [];
    const prisma = {
      agent: { findUnique: async ({ where }) => (where.agentId === ROBOT ? { id: AGENT_ROW, agentId: ROBOT } : null) },
      commitment: {
        findFirst: async () => ({ commitmentId: "CMT-1", agentId: AGENT_ROW, legId: "leg-1", fence: 5n, grantedAt: new Date(Date.now() - 60_000), releasedAt: null }),
      },
      // §2.8 — LEG-1's Mission discharges TSK-1, the Task the claim names (F2's binding).
      leg: {
        findUnique: async ({ select } = {}) =>
          select && select.mission
            ? { mission: { tasks: [{ taskId: "TSK-1" }] } }
            : { id: "leg-1", legId: "LEG-1", purpose: "DELIVERY", state: "AT_DROP" },
      },
      stop: { findMany: async () => [{ sequence: 2, stopType: "DROP", lat: DROP.lat, lon: DROP.lon }] },
      observation: table,
      outbox: { findFirst: async () => ({ payload: { stopSequence: [{ sequence: 2, path: [START, DROP] }] } }) },
      verificationEvidence: {
        create: async ({ data }) => {
          evidence.push(data);
          return data;
        },
      },
    };
    const socket = createFakeSocket();
    socket.data.robotId = ROBOT;
    socket.data.isAuthed = true;
    agentGate.bind(socket, { agentId: ROBOT, shardId: "SHARD-1", regionId: "RGN-1", resolvedAtMs: Date.now() });
    const result = await verifyCompletionClaim({
      prisma,
      log: silentLogger,
      robotId: ROBOT,
      taskId: "TSK-1",
      payload: { taskId: "TSK-1", lat: DROP.lat, lon: DROP.lon },
      config: snapshot,
      socket,
    });
    return { result, evidence };
  }

  test("control: a full 3D track to the drop is graded SUFFICIENT", async () => {
    const { result, evidence } = await claim(await drive(() => ({ fixType: "3D", hAccM: 1.5 })));
    expect(result.outcome).toBe(verification.OUTCOME.SUFFICIENT);
    expect(evidence[0]).toMatchObject({ outcome: "SUFFICIENT", trackFixCount: 29 });
  });

  test("valid fixes, then unknown-fixType fixes for the last 20 m: the unknown ones are not evidence and the claim fails", async () => {
    const table = await drive((i) => (i <= 18 ? { fixType: "3D", hAccM: 1.5 } : { fixType: "DGPS", hAccM: 0.5 }));
    expect(table.rows).toHaveLength(19);
    expect(table.rows.every((row) => row.value.fixType === "3D")).toBe(true);
    const { result, evidence } = await claim(table);
    expect(result.outcome).toBe(verification.OUTCOME.INSUFFICIENT);
    expect(evidence[0]).toMatchObject({ outcome: "INSUFFICIENT", trackFixCount: 19 });
  });

  test("a track made only of unknown-fixType frames verifies nothing", async () => {
    const table = await drive(() => ({ fixType: "4D", hAccM: 0.5 }));
    expect(table.rows).toHaveLength(0);
    const { result } = await claim(table);
    expect(result.outcome).not.toBe(verification.OUTCOME.SUFFICIENT);
  });
});

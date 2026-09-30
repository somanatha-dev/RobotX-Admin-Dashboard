/**
 * P2B-2 — an offer response is applied only while the offer is still open.
 *
 * `offers.applyAccept / applyReject / applyDefer` write the Leg conditionally on its version,
 * which defeats a *concurrent* write but not a *late* one: before P2B-2 a second
 * `OFFER_ACCEPT` after departure reset the Leg to ACCEPTED, and a late `OFFER_REJECT`
 * re-queued a Leg the agent was driving. The guard is §4.4's own table: a response answers
 * the state with an `AGENT_ACK` row (OFFERED), before the offer's `notValidAfter`, and an
 * ACCEPT must pass that row's `FENCE_MATCHES_OFFER_UNEXPIRED` guard.
 *
 * The store here is stateful, so a duplicate meets the Leg the first response left behind.
 */

const { registerOfferHandlers, awaitingResponse } = require("../../../src/sockets/handlers/offer.handler");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { createTestKv } = require("../../helpers/testKv");
const agentGate = require("../../../src/engine/cutover/agentGate");
const silentLogger = require("../../mocks/silentLogger");

function liveSnapshot() {
  return {
    resolve: (name) => (name === "cutover.engine_enabled" ? true : null),
    values: new Map([
      ["execute.start_grace", 300],
      ["sla.assignment_deadline", 900],
      ["plan.commitment_horizon", 900],
      ["dispatch.nack_cooloff", 120],
    ]),
  };
}

const ENGINE_BEFORE = process.env.ENGINE_ENABLED;
beforeAll(() => {
  process.env.ENGINE_ENABLED = "true";
});
afterAll(() => {
  process.env.ENGINE_ENABLED = ENGINE_BEFORE;
});

/**
 * A stateful store: one agent, one Leg, commitments by id, and the OFFER outbox rows.
 */
function world({ legState = "OFFERED", expiresInMs = 60_000 } = {}) {
  const state = {
    leg: { id: "leg-1", legId: "LEG-1", version: 4, state: legState, mission: { tasks: [] } },
    commitments: new Map([
      ["CMT-1", { commitmentId: "CMT-1", agentId: "agent-1", legId: "leg-1", fence: 5n, version: 0, releasedAt: null }],
      ["CMT-OTHER", { commitmentId: "CMT-OTHER", agentId: "agent-2", legId: "leg-1", fence: 5n, version: 0, releasedAt: null }],
    ]),
    offers: new Map([["CMT-1", { notValidAfter: new Date(Date.now() + expiresInMs), payload: { stopSequence: [] } }]]),
  };

  const prisma = createMockPrisma();
  prisma.agent.findUnique = jest.fn(async () => ({ id: "agent-1", agentId: "RBT-1", fenceCounter: 5n }));
  prisma.commitment = {
    findUnique: jest.fn(async ({ where }) => {
      const row = state.commitments.get(where.commitmentId);
      return row ? { ...row } : null;
    }),
    update: jest.fn(async ({ where, data }) => {
      const row = state.commitments.get(where.commitmentId);
      Object.assign(row, data);
      return { ...row };
    }),
  };
  prisma.leg.findUnique = jest.fn(async () => ({ ...state.leg }));
  prisma.leg.updateMany = jest.fn(async ({ where, data }) => {
    if (where.id !== state.leg.id || where.version !== state.leg.version) return { count: 0 };
    Object.assign(state.leg, data);
    return { count: 1 };
  });
  prisma.outbox.findFirst = jest.fn(async ({ where }) => state.offers.get(where.commitmentId) || null);
  prisma.observation.create = jest.fn(async () => ({}));
  prisma.$queryRawUnsafe.mockResolvedValue([{ now: new Date() }]);
  prisma.task.findFirst = jest.fn(async () => null);
  return { state, prisma };
}

async function connect(prisma) {
  const { kv } = await createTestKv();
  const io = createFakeIo();
  const socket = createFakeSocket();
  socket.data.robotId = "RBT-1";
  socket.data.isAuthed = true;
  agentGate.bind(socket, { agentId: "RBT-1", shardId: "SHARD-1", regionId: "RGN-1", resolvedAtMs: Date.now() });
  registerOfferHandlers(io, socket, {
    prisma,
    kv,
    logger: silentLogger,
    config: { leaseDurationSeconds: 60, nackCooloffSeconds: 120 },
    appLocals: { config: liveSnapshot() },
  });
  return socket;
}

/** Fire one response and let its transaction settle. */
async function respond(socket, event, payload) {
  socket.trigger(event, payload);
  await new Promise((resolve) => setTimeout(resolve, 30));
}

const UNTIL = () => Date.now() + 300_000;

describe("an open offer is answered normally", () => {
  test.each([
    ["OFFER_ACCEPT", {}, "ACCEPTED"],
    ["OFFER_REJECT", { reason: "NO_MOTOR_LINK" }, "QUEUED"],
    ["OFFER_DEFER", { reason: "CHARGING", until: UNTIL() }, "PLANNED"],
  ])("%s from OFFERED applies", async (event, extra, to) => {
    const { state, prisma } = world();
    const socket = await connect(prisma);
    await respond(socket, event, { commitmentId: "CMT-1", fence: "5", ...extra });
    expect(state.leg.state).toBe(to);
  });
});

describe("a duplicate is harmless", () => {
  test("duplicate ACCEPT: the second one writes nothing", async () => {
    const { state, prisma } = world();
    const socket = await connect(prisma);
    await respond(socket, "OFFER_ACCEPT", { commitmentId: "CMT-1", fence: "5" });
    const version = state.leg.version;
    const commitmentWrites = prisma.commitment.update.mock.calls.length;
    await respond(socket, "OFFER_ACCEPT", { commitmentId: "CMT-1", fence: "5" });
    expect(state.leg).toMatchObject({ state: "ACCEPTED", version });
    expect(prisma.commitment.update.mock.calls.length).toBe(commitmentWrites);
  });

  test.each([
    ["OFFER_REJECT", { reason: "X" }],
    ["OFFER_DEFER", { reason: "X", until: UNTIL() }],
  ])("duplicate %s: the second one writes nothing", async (event, extra) => {
    const { state, prisma } = world();
    const socket = await connect(prisma);
    await respond(socket, event, { commitmentId: "CMT-1", fence: "5", ...extra });
    const snapshot = { ...state.leg };
    const writes = prisma.leg.updateMany.mock.calls.length;
    await respond(socket, event, { commitmentId: "CMT-1", fence: "5", ...extra });
    expect(state.leg).toEqual(snapshot);
    expect(prisma.leg.updateMany.mock.calls.length).toBe(writes);
  });
});

describe("a late response cannot move a Leg that has moved on", () => {
  test("ACCEPT after REJECT: the released commitment is not revived", async () => {
    const { state, prisma } = world();
    const socket = await connect(prisma);
    await respond(socket, "OFFER_REJECT", { commitmentId: "CMT-1", fence: "5", reason: "X" });
    await respond(socket, "OFFER_ACCEPT", { commitmentId: "CMT-1", fence: "5" });
    expect(state.leg.state).toBe("QUEUED");
    expect(state.commitments.get("CMT-1").releasedAt).not.toBeNull();
  });

  test("REJECT after ACCEPT: the accepted Leg is not re-queued and its commitment is not released", async () => {
    const { state, prisma } = world();
    const socket = await connect(prisma);
    await respond(socket, "OFFER_ACCEPT", { commitmentId: "CMT-1", fence: "5" });
    await respond(socket, "OFFER_REJECT", { commitmentId: "CMT-1", fence: "5", reason: "X" });
    expect(state.leg.state).toBe("ACCEPTED");
    expect(state.commitments.get("CMT-1").releasedAt).toBeNull();
  });

  test.each(["EN_ROUTE_PICKUP", "LOADED", "EN_ROUTE_DROP", "RELEASED", "SETTLED"])(
    "a response while the Leg is %s writes nothing",
    async (legState) => {
      for (const [event, extra] of [
        ["OFFER_ACCEPT", {}],
        ["OFFER_REJECT", { reason: "X" }],
        ["OFFER_DEFER", { reason: "X", until: UNTIL() }],
      ]) {
        const { state, prisma } = world({ legState });
        const socket = await connect(prisma);
        await respond(socket, event, { commitmentId: "CMT-1", fence: "5", ...extra });
        expect(state.leg.state).toBe(legState);
        expect(prisma.leg.updateMany).not.toHaveBeenCalled();
        expect(prisma.commitment.update).not.toHaveBeenCalled();
      }
    },
  );

  test.each(["OFFER_ACCEPT", "OFFER_REJECT", "OFFER_DEFER"])("%s after the offer expired writes nothing", async (event) => {
    const { state, prisma } = world({ expiresInMs: -1_000 });
    const socket = await connect(prisma);
    await respond(socket, event, { commitmentId: "CMT-1", fence: "5", reason: "X", until: UNTIL() });
    expect(state.leg.state).toBe("OFFERED");
    expect(prisma.leg.updateMany).not.toHaveBeenCalled();
  });

  test("a response to a reassigned Leg (its commitment released, a new one offered) writes nothing", async () => {
    const { state, prisma } = world();
    state.commitments.get("CMT-1").releasedAt = new Date();
    state.commitments.set("CMT-2", { commitmentId: "CMT-2", agentId: "agent-2", legId: "leg-1", fence: 6n, version: 0, releasedAt: null });
    const socket = await connect(prisma);
    await respond(socket, "OFFER_ACCEPT", { commitmentId: "CMT-1", fence: "5" });
    expect(state.leg.state).toBe("OFFERED");
    expect(prisma.leg.updateMany).not.toHaveBeenCalled();
  });
});

describe("identity and fence stay mandatory", () => {
  test.each([
    ["stale fence", { commitmentId: "CMT-1", fence: "4" }],
    ["another agent's commitment", { commitmentId: "CMT-OTHER", fence: "5" }],
    ["unknown commitment", { commitmentId: "CMT-NOPE", fence: "5" }],
    ["no fence", { commitmentId: "CMT-1" }],
  ])("%s writes nothing", async (_name, payload) => {
    const { state, prisma } = world();
    const socket = await connect(prisma);
    await respond(socket, "OFFER_ACCEPT", payload);
    expect(state.leg.state).toBe("OFFERED");
    expect(prisma.leg.updateMany).not.toHaveBeenCalled();
  });

  test("an offer with no OFFER row on record is not answerable", async () => {
    const { state, prisma } = world();
    state.offers.clear();
    const socket = await connect(prisma);
    await respond(socket, "OFFER_ACCEPT", { commitmentId: "CMT-1", fence: "5" });
    expect(state.leg.state).toBe("OFFERED");
  });
});

describe("reconnect / redelivery", () => {
  test("the same ACCEPT from the old socket and the new one is applied once", async () => {
    const { state, prisma } = world();
    const before = await connect(prisma);
    const after = await connect(prisma);
    await respond(before, "OFFER_ACCEPT", { commitmentId: "CMT-1", fence: "5" });
    const version = state.leg.version;
    await respond(after, "OFFER_ACCEPT", { commitmentId: "CMT-1", fence: "5" });
    expect(state.leg).toMatchObject({ state: "ACCEPTED", version });
    expect(prisma.leg.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("awaitingResponse reads §4.4's table", () => {
  test("only OFFERED awaits a response", async () => {
    const { prisma } = world();
    const commitment = { commitmentId: "CMT-1", fence: 5n };
    const storeTime = new Date();
    for (const legState of ["QUEUED", "PLANNED", "ACCEPTED", "EN_ROUTE_PICKUP", "SETTLED", "WITHDRAWN"]) {
      const out = await awaitingResponse(prisma, { event: "OFFER_ACCEPT", leg: { state: legState }, commitment, fence: "5", storeTime });
      expect(out).toEqual({ ok: false, reason: `NOT_AWAITING_RESPONSE:${legState}` });
    }
    const open = await awaitingResponse(prisma, { event: "OFFER_ACCEPT", leg: { state: "OFFERED" }, commitment, fence: "5", storeTime });
    expect(open).toEqual({ ok: true, reason: null });
  });

  test("ACCEPT evaluates the ACK row's guard: an expired offer reports OFFER_EXPIRED", async () => {
    const { prisma, state } = world({ expiresInMs: -1 });
    const out = await awaitingResponse(prisma, {
      event: "OFFER_ACCEPT",
      leg: { state: "OFFERED" },
      commitment: { commitmentId: "CMT-1", fence: 5n },
      fence: "5",
      storeTime: new Date(),
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/OFFER_EXPIRED/);
    expect(state.leg.state).toBe("OFFERED");
  });
});

/**
 * RB-1 — the cold-start shard identity race.
 *
 * On a fresh V1 start an agent authenticates before the index maintainer places it in a
 * shard, so its session carries no shard identity until the heartbeat's 15 s refresh. A round
 * could offer it work inside that window, and its `OFFER_ACCEPT` / `COMMAND_ACK` were refused
 * as `SHARD_IDENTITY_UNRESOLVED` and dropped without a word: the OFFER expired
 * (`NO_ACK_WITHIN_OFFER_TTL`) and was withdrawn and replanned (measured on the V1 launcher,
 * 2026-10-04).
 *
 * `agentGate.assessResolvingIdentity` re-reads the identity once, from `ShardMembership`, when
 * and only when the refusal is the identity one, then asks `assess()` again. These tests pin
 * both directions: the placed agent's answer is now applied, and an agent the store does not
 * place is still refused — and the refusal is now logged.
 */

const fs = require("fs");
const path = require("path");
const agentGate = require("../../../src/engine/cutover/agentGate");
const { registerOfferHandlers } = require("../../../src/sockets/handlers/offer.handler");
const { registerCommandHandlers } = require("../../../src/sockets/handlers/command.handler");
const { createFakeSocket, createFakeIo } = require("../../helpers/fakeSocket");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { createTestKv } = require("../../helpers/testKv");

const { REFUSAL } = agentGate;
const ON = { ENGINE_ENABLED: "true" };
const NOW = 1_800_000_000_000;

function liveSnapshot() {
  return {
    resolve: (name, scope) => (name === "cutover.engine_enabled" && scope && scope.region === "RGN-1" ? true : null),
    values: new Map([
      ["execute.start_grace", 300],
      ["sla.assignment_deadline", 900],
      ["plan.commitment_horizon", 900],
      ["dispatch.nack_cooloff", 120],
    ]),
  };
}

/**
 * The durable record `resolveIdentity` reads: the agent, its live membership (or none — the
 * commissioned-but-unplaced state), and the shard's region.
 */
function store({ placed = true, shardRegion = "RGN-1" } = {}) {
  const prisma = createMockPrisma();
  prisma.agent.findUnique = jest.fn(async () => ({ id: "agent-1", agentId: "RBT-1", authorityEpoch: 0n, fenceCounter: 5n }));
  prisma.shardMembership = {
    findFirst: jest.fn(async () => (placed ? { agentId: "agent-1", shardId: "SHARD-1", supersededAt: null } : null)),
  };
  prisma.shard.findUnique = jest.fn(async () => ({ shardId: "SHARD-1", regionId: shardRegion }));
  return prisma;
}

function authedSocket(identity) {
  const socket = createFakeSocket();
  socket.data.robotId = "RBT-1";
  socket.data.isAuthed = true;
  agentGate.bind(socket, identity);
  return socket;
}

const FRESH = () => ({ agentId: "RBT-1", shardId: "SHARD-1", regionId: "RGN-1", resolvedAtMs: NOW });

/* ═══════════════════════════════════════════════════════════════════════════
   The gate itself
   ═══════════════════════════════════════════════════════════════════════════ */

describe("assessResolvingIdentity — retries only the identity refusals", () => {
  test("COLD START: unresolved at AUTH, placed since → re-read once and allowed", async () => {
    const prisma = store();
    const socket = authedSocket(null);
    expect(agentGate.assess({ socket, snapshot: liveSnapshot(), env: ON, nowMs: NOW }).refusal).toBe(
      REFUSAL.SHARD_IDENTITY_UNRESOLVED,
    );

    const verdict = await agentGate.assessResolvingIdentity(prisma, { socket, snapshot: liveSnapshot(), env: ON, nowMs: NOW });

    expect(verdict).toMatchObject({
      allowed: true,
      refusal: null,
      shardId: "SHARD-1",
      reresolved: true,
      firstRefusal: REFUSAL.SHARD_IDENTITY_UNRESOLVED,
    });
    // Bound through the existing mechanism, so the next event needs no read at all.
    expect(agentGate.identityOf(socket)).toMatchObject({ shardId: "SHARD-1", regionId: "RGN-1", resolvedAtMs: NOW });
    expect(prisma.shardMembership.findFirst).toHaveBeenCalledTimes(1);
  });

  test("STALE identity → re-read once and allowed with a fresh timestamp", async () => {
    const prisma = store();
    const socket = authedSocket({ ...FRESH(), resolvedAtMs: NOW - agentGate.DEFAULT_MAX_AGE_MS - 1 });

    const verdict = await agentGate.assessResolvingIdentity(prisma, { socket, snapshot: liveSnapshot(), env: ON, nowMs: NOW });

    expect(verdict).toMatchObject({ allowed: true, reresolved: true, firstRefusal: REFUSAL.SHARD_IDENTITY_STALE });
    expect(agentGate.identityOf(socket).resolvedAtMs).toBe(NOW);
  });

  test("FAIL CLOSED: no live ShardMembership → still refused, nothing invented", async () => {
    const prisma = store({ placed: false });
    const socket = authedSocket(null);

    const verdict = await agentGate.assessResolvingIdentity(prisma, { socket, snapshot: liveSnapshot(), env: ON, nowMs: NOW });

    expect(verdict).toMatchObject({
      allowed: false,
      refusal: REFUSAL.SHARD_IDENTITY_UNRESOLVED,
      shardId: null,
      reresolved: true,
    });
    expect(agentGate.identityOf(socket)).toBeNull();
  });

  test("FAIL CLOSED: a stale identity whose membership is gone is not kept alive", async () => {
    const prisma = store({ placed: false });
    const socket = authedSocket({ ...FRESH(), resolvedAtMs: NOW - agentGate.DEFAULT_MAX_AGE_MS - 1 });

    const verdict = await agentGate.assessResolvingIdentity(prisma, { socket, snapshot: liveSnapshot(), env: ON, nowMs: NOW });

    expect(verdict.allowed).toBe(false);
    expect(agentGate.identityOf(socket)).toBeNull();
  });

  test("FAIL CLOSED: re-resolved into a shard whose region is not cut over → SHARD_NOT_ENABLED", async () => {
    const prisma = store({ shardRegion: "RGN-DARK" });
    const socket = authedSocket(null);

    const verdict = await agentGate.assessResolvingIdentity(prisma, { socket, snapshot: liveSnapshot(), env: ON, nowMs: NOW });

    expect(verdict).toMatchObject({ allowed: false, refusal: REFUSAL.SHARD_NOT_ENABLED, reresolved: true });
  });

  test("a store error keeps the first verdict and the previous binding", async () => {
    const prisma = store();
    prisma.shardMembership.findFirst = jest.fn(async () => {
      throw new Error("connection reset");
    });
    const stale = { ...FRESH(), resolvedAtMs: NOW - agentGate.DEFAULT_MAX_AGE_MS - 1 };
    const socket = authedSocket(stale);

    const verdict = await agentGate.assessResolvingIdentity(prisma, { socket, snapshot: liveSnapshot(), env: ON, nowMs: NOW });

    expect(verdict).toMatchObject({ allowed: false, refusal: REFUSAL.SHARD_IDENTITY_STALE, reresolved: false });
    expect(agentGate.identityOf(socket)).toBe(stale);
  });

  test.each([
    ["PROCESS_NOT_ENABLED", { env: { ENGINE_ENABLED: "false" } }, (s) => s],
    ["SESSION_NOT_AUTHENTICATED", {}, (s) => Object.assign(s, { data: { ...s.data, isAuthed: false } })],
    ["CONFIGURATION_UNAVAILABLE", { snapshot: null }, (s) => s],
  ])("no retry for %s: re-reading the membership cannot change it", async (refusal, override, shape) => {
    const prisma = store();
    const socket = shape(authedSocket(FRESH()));

    const verdict = await agentGate.assessResolvingIdentity(prisma, {
      socket,
      snapshot: liveSnapshot(),
      env: ON,
      nowMs: NOW,
      ...override,
    });

    expect(verdict).toMatchObject({ allowed: false, refusal, reresolved: false });
    expect(prisma.shardMembership.findFirst).not.toHaveBeenCalled();
  });

  test("no retry for SHARD_NOT_ENABLED on a fresh identity", async () => {
    const prisma = store();
    const socket = authedSocket({ ...FRESH(), regionId: "RGN-DARK" });

    const verdict = await agentGate.assessResolvingIdentity(prisma, { socket, snapshot: liveSnapshot(), env: ON, nowMs: NOW });

    expect(verdict).toMatchObject({ allowed: false, refusal: REFUSAL.SHARD_NOT_ENABLED, reresolved: false });
    expect(prisma.shardMembership.findFirst).not.toHaveBeenCalled();
  });

  test("an allowed first verdict reads nothing", async () => {
    const prisma = store();
    const socket = authedSocket(FRESH());

    const verdict = await agentGate.assessResolvingIdentity(prisma, { socket, snapshot: liveSnapshot(), env: ON, nowMs: NOW });

    expect(verdict).toMatchObject({ allowed: true, reresolved: false, firstRefusal: null });
    expect(prisma.agent.findUnique).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The handlers that dropped the answer
   ═══════════════════════════════════════════════════════════════════════════ */

const ENGINE_BEFORE = process.env.ENGINE_ENABLED;
beforeAll(() => {
  process.env.ENGINE_ENABLED = "true";
});
afterAll(() => {
  process.env.ENGINE_ENABLED = ENGINE_BEFORE;
});

function recordingLogger() {
  const lines = { warn: [], info: [], error: [] };
  return {
    lines,
    info: (message, detail) => lines.info.push({ message, detail }),
    warn: (message, detail) => lines.warn.push({ message, detail }),
    error: (message, detail) => lines.error.push({ message, detail }),
    debug: () => {},
  };
}

/** The gate's own refusal lines, apart from unrelated read-model warnings. */
const gateRefusals = (logger) => logger.lines.warn.filter((line) => /refused by the agent gate/.test(line.message));

/** One agent, one OFFERED Leg, one open OFFER — the shape `offerResponseGuard` uses. */
function offerWorld(options) {
  const prisma = store(options);
  const state = { leg: { id: "leg-1", legId: "LEG-1", version: 4, state: "OFFERED", mission: { tasks: [] } } };
  const commitment = { commitmentId: "CMT-1", agentId: "agent-1", legId: "leg-1", fence: 5n, version: 0, releasedAt: null };
  prisma.commitment = {
    findUnique: jest.fn(async () => ({ ...commitment })),
    update: jest.fn(async ({ data }) => Object.assign(commitment, data)),
  };
  prisma.leg.findUnique = jest.fn(async () => ({ ...state.leg }));
  prisma.leg.updateMany = jest.fn(async ({ where, data }) => {
    if (where.version !== state.leg.version) return { count: 0 };
    Object.assign(state.leg, data);
    return { count: 1 };
  });
  prisma.outbox.findFirst = jest.fn(async () => ({ notValidAfter: new Date(Date.now() + 60_000), payload: { stopSequence: [] } }));
  prisma.observation.create = jest.fn(async () => ({}));
  prisma.$queryRawUnsafe.mockResolvedValue([{ now: new Date() }]);
  prisma.task.findFirst = jest.fn(async () => null);
  return { prisma, state };
}

async function connectOffer(prisma, logger) {
  const { kv } = await createTestKv();
  // AUTH ran before the index maintainer placed the agent: no identity on the session.
  const socket = authedSocket(null);
  registerOfferHandlers(createFakeIo(), socket, {
    prisma,
    kv,
    logger,
    config: { leaseDurationSeconds: 60, nackCooloffSeconds: 120 },
    appLocals: { config: liveSnapshot() },
  });
  return socket;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("OFFER_ACCEPT / REJECT / DEFER from an agent placed after AUTH", () => {
  test.each([
    ["OFFER_ACCEPT", {}, "ACCEPTED"],
    ["OFFER_REJECT", { reason: "NO_MOTOR_LINK" }, "QUEUED"],
    ["OFFER_DEFER", { reason: "CHARGING", until: Date.now() + 300_000 }, "PLANNED"],
  ])("REGRESSION — %s is applied, not dropped", async (event, extra, to) => {
    const { prisma, state } = offerWorld();
    const logger = recordingLogger();
    const socket = await connectOffer(prisma, logger);

    socket.trigger(event, { commitmentId: "CMT-1", fence: "5", ...extra });
    await settle();

    expect(state.leg.state).toBe(to);
    expect(gateRefusals(logger)).toEqual([]);
    expect(agentGate.identityOf(socket)).toMatchObject({ shardId: "SHARD-1" });
  });

  test("FAIL CLOSED: an agent with no membership is still refused, and the refusal is logged", async () => {
    const { prisma, state } = offerWorld({ placed: false });
    const logger = recordingLogger();
    const socket = await connectOffer(prisma, logger);

    socket.trigger("OFFER_ACCEPT", { commitmentId: "CMT-1", fence: "5" });
    await settle();

    expect(state.leg.state).toBe("OFFERED");
    expect(prisma.leg.updateMany).not.toHaveBeenCalled();
    expect(logger.lines.warn).toEqual([
      {
        message: "OFFER_ACCEPT refused by the agent gate",
        detail: {
          robotId: "RBT-1",
          refusal: REFUSAL.SHARD_IDENTITY_UNRESOLVED,
          firstRefusal: REFUSAL.SHARD_IDENTITY_UNRESOLVED,
          reresolved: true,
        },
      },
    ]);
  });
});

function ackWorld(options) {
  const prisma = store(options);
  const row = { id: "OBX-1", agentId: "agent-1", state: "DELIVERED", fence: 1n, authorityEpoch: 0n, command: "OFFER", commitmentId: "CMT-1" };
  prisma.outbox.findUnique = jest.fn(async () => ({ ...row }));
  prisma.outbox.updateMany = jest.fn(async ({ data }) => {
    Object.assign(row, data);
    return { count: 1 };
  });
  prisma.$queryRawUnsafe.mockResolvedValue([{ now: new Date() }]);
  return { prisma, row };
}

async function connectCommand(prisma, logger) {
  const { kv } = await createTestKv();
  const socket = authedSocket(null);
  registerCommandHandlers(createFakeIo(), socket, { prisma, kv, logger, appLocals: { config: liveSnapshot() } });
  return socket;
}

describe("COMMAND_ACK for an outbox row, from an agent placed after AUTH", () => {
  test("REGRESSION — the OFFER's ACK settles the row", async () => {
    const { prisma, row } = ackWorld();
    const logger = recordingLogger();
    const socket = await connectCommand(prisma, logger);

    socket.trigger("COMMAND_ACK", { outboxId: "OBX-1", robotId: "RBT-1", fence: "1", authorityEpoch: "0" });
    await settle();

    expect(row.state).toBe("ACKED");
    expect(logger.lines.warn).toEqual([]);
    expect(logger.lines.info.map((line) => line.message)).toContain("COMMAND_ACK (outbox)");
  });

  test("FAIL CLOSED: an agent with no membership does not settle the row, and the refusal is logged", async () => {
    const { prisma, row } = ackWorld({ placed: false });
    const logger = recordingLogger();
    const socket = await connectCommand(prisma, logger);

    socket.trigger("COMMAND_ACK", { outboxId: "OBX-1", robotId: "RBT-1", fence: "1" });
    await settle();

    expect(row.state).toBe("DELIVERED");
    expect(prisma.outbox.updateMany).not.toHaveBeenCalled();
    expect(logger.lines.warn).toEqual([
      {
        message: "COMMAND_ACK (outbox) refused by the agent gate",
        detail: {
          robotId: "RBT-1",
          outboxId: "OBX-1",
          refusal: REFUSAL.SHARD_IDENTITY_UNRESOLVED,
          firstRefusal: REFUSAL.SHARD_IDENTITY_UNRESOLVED,
          reresolved: true,
        },
      },
    ]);
  });

  test("a legacy command ACK (no outboxId) never consults the gate or the membership", async () => {
    const { prisma } = ackWorld();
    prisma.command = { findUnique: jest.fn(async () => null), update: jest.fn() };
    const logger = recordingLogger();
    const socket = await connectCommand(prisma, logger);

    socket.trigger("COMMAND_ACK", { commandId: "CMD-1" });
    await settle();

    expect(prisma.shardMembership.findFirst).not.toHaveBeenCalled();
    expect(logger.lines.warn).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The fence an outbox COMMAND_ACK must carry
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A mission row is issued under its commitment's fence (the `Outbox_fence_scope_columns` CHECK
 * makes `fence` NOT NULL on every COMMITMENT row), and the agent echoes it. An ACK that does not
 * echo it — omitted, null, malformed, or another row's — must not settle the row: a settled
 * OFFER row silences §11.4's NO_ACK_WITHIN_OFFER_TTL withdrawal, and a settled RECALL/WITHDRAW
 * row releases the dashboard's assignment. The agent-scope row (SHARD_MIGRATE) carries no
 * commitment fence by construction and is guarded by its authority epoch instead.
 */
function fenceWorld() {
  const prisma = store();
  const mission = (id, command, commitmentId, fence, agentId = "agent-1") => ({
    id, agentId, state: "DELIVERED", command, commandClass: "MISSION", fenceScope: "COMMITMENT",
    commitmentId, fence, authorityEpoch: null, fenceFloor: null,
  });
  // The shape `shard/membership.js` writes: no commitment, no fence, the epoch it advanced to.
  const migrate = (id, authorityEpoch, fenceFloor, agentId = "agent-1") => ({
    id, agentId, state: "DELIVERED", command: "SHARD_MIGRATE", commandClass: "AGENT", fenceScope: "AGENT",
    commitmentId: null, fence: null, authorityEpoch, fenceFloor,
  });
  const rows = {
    "OBX-OFFER": mission("OBX-OFFER", "OFFER", "CMT-1", 5n),
    // The withdrawal of CMT-1's offer, at the advanced fence — the newer authority.
    "OBX-WITHDRAW": mission("OBX-WITHDRAW", "WITHDRAW", "CMT-1", 6n),
    "OBX-RECALL": mission("OBX-RECALL", "RECALL", "CMT-2", 7n),
    "OBX-OTHER": mission("OBX-OTHER", "OFFER", "CMT-9", 9n, "agent-2"),
    "OBX-MIGRATE": migrate("OBX-MIGRATE", 3n, 7n),
    // The next migration of the same agent — the newer agent-scope authority.
    "OBX-MIGRATE-NEXT": migrate("OBX-MIGRATE-NEXT", 4n, 8n),
    "OBX-MIGRATE-OTHER": migrate("OBX-MIGRATE-OTHER", 3n, 2n, "agent-2"),
  };
  prisma.outbox.findUnique = jest.fn(async ({ where }) => (rows[where.id] ? { ...rows[where.id] } : null));
  prisma.outbox.updateMany = jest.fn(async ({ where, data }) => {
    const row = rows[where.id];
    if (!row || where.state.notIn.includes(row.state)) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  // The stand-down read model's first read: proof that a settled RECALL/WITHDRAW reached it.
  prisma.commitment = { findUnique: jest.fn(async () => null) };
  prisma.$queryRawUnsafe.mockResolvedValue([{ now: new Date() }]);
  return { prisma, rows };
}

async function fenceConnection() {
  const world = fenceWorld();
  const logger = recordingLogger();
  const io = createFakeIo();
  const { kv } = await createTestKv();
  const socket = authedSocket(null);
  registerCommandHandlers(io, socket, { prisma: world.prisma, kv, logger, appLocals: { config: liveSnapshot() } });
  // Spaced past the handler's own COMMAND_ACK rate limit (`minIntervalMs: 100`), so a second
  // ACK in one test is judged by the handler rather than dropped by the limiter.
  const ack = async (payload) => {
    socket.trigger("COMMAND_ACK", { robotId: "RBT-1", timestamp: NOW, ...payload });
    await new Promise((resolve) => setTimeout(resolve, 120));
  };
  /** The handler's own verdict lines, in order. */
  const verdicts = () =>
    logger.lines.info.filter((line) => line.message === "COMMAND_ACK (outbox)").map(({ detail }) => detail);
  return { ...world, io, logger, ack, verdicts };
}

describe("COMMAND_ACK (outbox) — a mission row is settled only by its own fence", () => {
  test("VALID: the echoed fence settles the row exactly as before (string as delivered, or a JSON integer)", async () => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-OFFER", fence: "5", authorityEpoch: null });
    expect(world.rows["OBX-OFFER"].state).toBe("ACKED");
    expect(world.rows["OBX-OFFER"].ackedAt).toBeInstanceOf(Date);
    expect(world.verdicts()).toEqual([
      { robotId: "RBT-1", outboxId: "OBX-OFFER", acked: true, reason: null, command: "OFFER", commitmentId: "CMT-1" },
    ]);
    // An OFFER is not a stand-down: the read model is not touched.
    expect(world.prisma.commitment.findUnique).not.toHaveBeenCalled();

    await world.ack({ outboxId: "OBX-RECALL", fence: 7 });
    expect(world.rows["OBX-RECALL"].state).toBe("ACKED");
    expect(world.logger.lines.warn).toEqual([]);
  });

  test.each([
    ["missing", {}, "ACK_WITHOUT_FENCE"],
    ["null", { fence: null }, "ACK_WITHOUT_FENCE"],
  ])("FAIL CLOSED: a %s fence does not settle the row", async (_name, fence, reason) => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-OFFER", authorityEpoch: null, ...fence });
    expect(world.rows["OBX-OFFER"].state).toBe("DELIVERED");
    expect(world.prisma.outbox.updateMany).not.toHaveBeenCalled();
    expect(world.verdicts()).toEqual([{ robotId: "RBT-1", outboxId: "OBX-OFFER", acked: false, reason }]);
  });

  test("FAIL CLOSED: a fenceless ACK of a RECALL neither settles it nor releases the assignment", async () => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-RECALL" });
    expect(world.rows["OBX-RECALL"].state).toBe("DELIVERED");
    expect(world.prisma.commitment.findUnique).not.toHaveBeenCalled();
    expect(world.io.roomEmits("dashboard")).toEqual([]);
    expect(world.verdicts()).toEqual([{ robotId: "RBT-1", outboxId: "OBX-RECALL", acked: false, reason: "ACK_WITHOUT_FENCE" }]);
  });

  test.each([
    ["a non-numeric string", "abc"],
    ["an empty string", ""],
    ["a hex string (BigInt would read it as 5)", "0x5"],
    ["a padded string (BigInt would read it as 5)", " 5"],
    ["a decimal-point string", "5.0"],
    ["a negative string", "-5"],
    ["an exponent string", "5e0"],
    ["a fractional number", 5.5],
    ["a negative number", -5],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
    ["a boolean", true],
    ["an object", { value: "5" }],
    ["an array", ["5"]],
  ])("FAIL CLOSED: a malformed fence — %s — does not settle the row", async (_name, fence) => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-OFFER", fence });
    expect(world.rows["OBX-OFFER"].state).toBe("DELIVERED");
    expect(world.prisma.outbox.updateMany).not.toHaveBeenCalled();
    expect(world.verdicts()).toEqual([{ robotId: "RBT-1", outboxId: "OBX-OFFER", acked: false, reason: "ACK_FENCE_MALFORMED" }]);
  });

  test.each([
    ["stale (below the row's)", "4"],
    ["the newer withdrawal's", "6"],
    ["zero — never allocated (allocateFence starts at 1)", "0"],
    ["another commitment's", "7"],
  ])("FAIL CLOSED: a %s fence does not settle the row", async (_name, fence) => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-OFFER", fence });
    expect(world.rows["OBX-OFFER"].state).toBe("DELIVERED");
    expect(world.prisma.outbox.updateMany).not.toHaveBeenCalled();
    expect(world.verdicts()).toEqual([
      { robotId: "RBT-1", outboxId: "OBX-OFFER", acked: false, reason: "ACK_CARRIES_A_DIFFERENT_FENCE" },
    ]);
  });

  test("FAIL CLOSED: an ACK for the wrong command or commitment settles nothing", async () => {
    const world = await fenceConnection();
    // Another agent's row, with that row's own fence.
    await world.ack({ outboxId: "OBX-OTHER", fence: "9" });
    // CMT-2's RECALL fence against CMT-1's WITHDRAW.
    await world.ack({ outboxId: "OBX-WITHDRAW", fence: "7" });
    // A row the store never wrote.
    await world.ack({ outboxId: "OBX-NOPE", fence: "5" });

    expect(world.verdicts().map(({ outboxId, acked, reason }) => ({ outboxId, acked, reason }))).toEqual([
      { outboxId: "OBX-OTHER", acked: false, reason: "ACK_FROM_ANOTHER_AGENT" },
      { outboxId: "OBX-WITHDRAW", acked: false, reason: "ACK_CARRIES_A_DIFFERENT_FENCE" },
      { outboxId: "OBX-NOPE", acked: false, reason: "UNKNOWN_OUTBOX_ROW" },
    ]);
    expect(world.rows["OBX-OTHER"].state).toBe("DELIVERED");
    expect(world.rows["OBX-WITHDRAW"].state).toBe("DELIVERED");
    expect(world.prisma.outbox.updateMany).not.toHaveBeenCalled();
    expect(world.prisma.commitment.findUnique).not.toHaveBeenCalled();
  });

  test("DUPLICATE: a repeated valid ACK is ignored as before — one settlement, one stand-down", async () => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-RECALL", fence: "7" });
    await world.ack({ outboxId: "OBX-RECALL", fence: "7" });

    expect(world.rows["OBX-RECALL"].state).toBe("ACKED");
    expect(world.prisma.outbox.updateMany).toHaveBeenCalledTimes(1);
    expect(world.prisma.commitment.findUnique).toHaveBeenCalledTimes(1);
    expect(world.verdicts().map(({ acked, reason }) => ({ acked, reason }))).toEqual([
      { acked: true, reason: null },
      { acked: false, reason: "ALREADY_ACKED" },
    ]);
  });

  test("REPLAY: after a newer fence exists, the old ACK settles nothing — with its fence, without it, or retargeted", async () => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-OFFER", fence: "5" });
    expect(world.rows["OBX-OFFER"].state).toBe("ACKED");

    // The withdrawal at fence 6 is outstanding. Replays of the old acknowledgement:
    await world.ack({ outboxId: "OBX-OFFER", fence: "5" }); // verbatim
    await world.ack({ outboxId: "OBX-WITHDRAW", fence: "5" }); // retargeted at the newer row
    await world.ack({ outboxId: "OBX-WITHDRAW" }); // retargeted with the fence stripped

    expect(world.rows["OBX-WITHDRAW"].state).toBe("DELIVERED");
    expect(world.prisma.commitment.findUnique).not.toHaveBeenCalled();
    expect(world.verdicts().slice(1).map(({ outboxId, acked, reason }) => ({ outboxId, acked, reason }))).toEqual([
      { outboxId: "OBX-OFFER", acked: false, reason: "ALREADY_ACKED" },
      { outboxId: "OBX-WITHDRAW", acked: false, reason: "ACK_CARRIES_A_DIFFERENT_FENCE" },
      { outboxId: "OBX-WITHDRAW", acked: false, reason: "ACK_WITHOUT_FENCE" },
    ]);

    // The withdrawal's own acknowledgement still settles it, and stands the assignment down.
    await world.ack({ outboxId: "OBX-WITHDRAW", fence: "6" });
    expect(world.rows["OBX-WITHDRAW"].state).toBe("ACKED");
    expect(world.prisma.commitment.findUnique).toHaveBeenCalledTimes(1);
  });

  test("FAIL CLOSED: a mission row the store holds without a fence cannot be acknowledged at all", async () => {
    const world = await fenceConnection();
    world.rows["OBX-OFFER"].fence = null;
    await world.ack({ outboxId: "OBX-OFFER", fence: "5" });
    expect(world.rows["OBX-OFFER"].state).toBe("DELIVERED");
    expect(world.verdicts()).toEqual([{ robotId: "RBT-1", outboxId: "OBX-OFFER", acked: false, reason: "ROW_CARRIES_NO_FENCE" }]);
  });
});

describe("COMMAND_ACK (outbox) — the agent-scope exception: no commitment fence, guarded by the epoch", () => {
  test.each([
    ["fence null, as VirtualRobot echoes it", { fence: null, authorityEpoch: "3" }],
    ["fence omitted", { authorityEpoch: "3" }],
  ])("SHARD_MIGRATE ACK with %s settles the row (unchanged)", async (_name, payload) => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-MIGRATE", ...payload });
    expect(world.rows["OBX-MIGRATE"].state).toBe("ACKED");
    expect(world.verdicts()).toEqual([
      { robotId: "RBT-1", outboxId: "OBX-MIGRATE", acked: true, reason: null, command: "SHARD_MIGRATE", commitmentId: null },
    ]);
  });

  test.each([
    ["a boolean", true],
    ["an object", { value: "1" }],
    ["a non-numeric string", "abc"],
  ])("FAIL CLOSED: a SHARD_MIGRATE ACK whose fence is present but malformed — %s — is refused", async (_name, fence) => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-MIGRATE", fence, authorityEpoch: "3" });
    expect(world.rows["OBX-MIGRATE"].state).toBe("DELIVERED");
    expect(world.verdicts()[0]).toMatchObject({ acked: false, reason: "ACK_FENCE_MALFORMED" });
  });

  test("a SHARD_MIGRATE ACK carrying another epoch is still refused (unchanged)", async () => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-MIGRATE", fence: null, authorityEpoch: "2" });
    expect(world.rows["OBX-MIGRATE"].state).toBe("DELIVERED");
    expect(world.verdicts()[0]).toMatchObject({ acked: false, reason: "ACK_CARRIES_A_DIFFERENT_AUTHORITY_EPOCH" });
  });
});

/**
 * An agent-scope row is issued under the agent's `authority_epoch` (§10.3.1 row 2; the
 * `Outbox_fence_scope_columns` CHECK makes it NOT NULL on every AGENT row), delivered as
 * `String(row.authorityEpoch)` and echoed by the agent. It is that row's fence: an ACK that does
 * not echo it — omitted, null, malformed, or another epoch — must not settle the row.
 */
describe("COMMAND_ACK (outbox) — an agent-scope row is settled only by its own authority epoch", () => {
  test("VALID: the echoed epoch settles the row (string as delivered, or a JSON integer), with no stand-down", async () => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-MIGRATE", fence: null, authorityEpoch: "3" });
    await world.ack({ outboxId: "OBX-MIGRATE-NEXT", authorityEpoch: 4 });

    expect(world.rows["OBX-MIGRATE"].state).toBe("ACKED");
    expect(world.rows["OBX-MIGRATE-NEXT"].state).toBe("ACKED");
    expect(world.verdicts().map(({ acked, reason, command }) => ({ acked, reason, command }))).toEqual([
      { acked: true, reason: null, command: "SHARD_MIGRATE" },
      { acked: true, reason: null, command: "SHARD_MIGRATE" },
    ]);
    // SHARD_MIGRATE is not a stand-down: the assignment read model is untouched.
    expect(world.prisma.commitment.findUnique).not.toHaveBeenCalled();
    expect(world.io.roomEmits("dashboard")).toEqual([]);
  });

  test.each([
    ["missing", { fence: null }, "ACK_WITHOUT_AUTHORITY_EPOCH"],
    ["null", { fence: null, authorityEpoch: null }, "ACK_WITHOUT_AUTHORITY_EPOCH"],
    ["missing, with the fence also omitted", {}, "ACK_WITHOUT_AUTHORITY_EPOCH"],
  ])("FAIL CLOSED: a %s epoch does not settle the row, and nothing stands down", async (_name, payload, reason) => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-MIGRATE", ...payload });
    expect(world.rows["OBX-MIGRATE"].state).toBe("DELIVERED");
    expect(world.prisma.outbox.updateMany).not.toHaveBeenCalled();
    expect(world.prisma.commitment.findUnique).not.toHaveBeenCalled();
    expect(world.io.roomEmits("dashboard")).toEqual([]);
    expect(world.verdicts()).toEqual([{ robotId: "RBT-1", outboxId: "OBX-MIGRATE", acked: false, reason }]);
  });

  test.each([
    ["a non-numeric string", "abc"],
    ["an empty string", ""],
    ["a hex string (BigInt would read it as 3)", "0x3"],
    ["a padded string (BigInt would read it as 3)", " 3"],
    ["a decimal-point string", "3.0"],
    ["a negative string", "-3"],
    ["an exponent string", "3e0"],
    ["a fractional number", 3.5],
    ["a negative number", -3],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
  ])("FAIL CLOSED: a malformed epoch — %s — does not settle the row", async (_name, authorityEpoch) => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-MIGRATE", fence: null, authorityEpoch });
    expect(world.rows["OBX-MIGRATE"].state).toBe("DELIVERED");
    expect(world.prisma.outbox.updateMany).not.toHaveBeenCalled();
    expect(world.verdicts()).toEqual([
      { robotId: "RBT-1", outboxId: "OBX-MIGRATE", acked: false, reason: "ACK_AUTHORITY_EPOCH_MALFORMED" },
    ]);
  });

  test.each([
    ["a boolean", true],
    ["an object", { value: "3" }],
    ["an array", ["3"]],
  ])("FAIL CLOSED: an epoch of the wrong type — %s — is dropped by the schema before any write", async (_name, authorityEpoch) => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-MIGRATE", fence: null, authorityEpoch });
    expect(world.rows["OBX-MIGRATE"].state).toBe("DELIVERED");
    expect(world.prisma.outbox.findUnique).not.toHaveBeenCalled();
    expect(world.prisma.outbox.updateMany).not.toHaveBeenCalled();
  });

  test.each([
    ["stale (below the row's)", "2"],
    ["newer (the next migration's)", "4"],
    ["wrong", "9"],
    ["zero — the agent's epoch before any migration", "0"],
  ])("FAIL CLOSED: a %s epoch does not settle the row", async (_name, authorityEpoch) => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-MIGRATE", fence: null, authorityEpoch });
    expect(world.rows["OBX-MIGRATE"].state).toBe("DELIVERED");
    expect(world.prisma.outbox.updateMany).not.toHaveBeenCalled();
    expect(world.verdicts()).toEqual([
      { robotId: "RBT-1", outboxId: "OBX-MIGRATE", acked: false, reason: "ACK_CARRIES_A_DIFFERENT_AUTHORITY_EPOCH" },
    ]);
  });

  test("FAIL CLOSED: an epoch ACK for the wrong agent, the wrong command or no row settles nothing", async () => {
    const world = await fenceConnection();
    // Another agent's migration, with that row's own epoch.
    await world.ack({ outboxId: "OBX-MIGRATE-OTHER", fence: null, authorityEpoch: "3" });
    // The older migration's epoch against the newer migration.
    await world.ack({ outboxId: "OBX-MIGRATE-NEXT", fence: null, authorityEpoch: "3" });
    // An agent-scope ACK aimed at a mission row: an epoch is not a fence.
    await world.ack({ outboxId: "OBX-OFFER", fence: null, authorityEpoch: "3" });
    // A row the store never wrote.
    await world.ack({ outboxId: "OBX-NOPE", fence: null, authorityEpoch: "3" });

    expect(world.verdicts().map(({ outboxId, acked, reason }) => ({ outboxId, acked, reason }))).toEqual([
      { outboxId: "OBX-MIGRATE-OTHER", acked: false, reason: "ACK_FROM_ANOTHER_AGENT" },
      { outboxId: "OBX-MIGRATE-NEXT", acked: false, reason: "ACK_CARRIES_A_DIFFERENT_AUTHORITY_EPOCH" },
      { outboxId: "OBX-OFFER", acked: false, reason: "ACK_WITHOUT_FENCE" },
      { outboxId: "OBX-NOPE", acked: false, reason: "UNKNOWN_OUTBOX_ROW" },
    ]);
    expect(world.prisma.outbox.updateMany).not.toHaveBeenCalled();
  });

  test("DUPLICATE: a repeated valid epoch ACK is ignored as before — one settlement", async () => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-MIGRATE", fence: null, authorityEpoch: "3" });
    await world.ack({ outboxId: "OBX-MIGRATE", fence: null, authorityEpoch: "3" });

    expect(world.rows["OBX-MIGRATE"].state).toBe("ACKED");
    expect(world.prisma.outbox.updateMany).toHaveBeenCalledTimes(1);
    expect(world.verdicts().map(({ acked, reason }) => ({ acked, reason }))).toEqual([
      { acked: true, reason: null },
      { acked: false, reason: "ALREADY_ACKED" },
    ]);
  });

  test("REPLAY: after a newer migration exists, the old ACK settles nothing — verbatim, retargeted, or stripped", async () => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-MIGRATE", fence: null, authorityEpoch: "3" });

    await world.ack({ outboxId: "OBX-MIGRATE", fence: null, authorityEpoch: "3" });
    await world.ack({ outboxId: "OBX-MIGRATE-NEXT", fence: null, authorityEpoch: "3" });
    await world.ack({ outboxId: "OBX-MIGRATE-NEXT", fence: null });

    expect(world.rows["OBX-MIGRATE-NEXT"].state).toBe("DELIVERED");
    expect(world.verdicts().slice(1).map(({ outboxId, reason }) => ({ outboxId, reason }))).toEqual([
      { outboxId: "OBX-MIGRATE", reason: "ALREADY_ACKED" },
      { outboxId: "OBX-MIGRATE-NEXT", reason: "ACK_CARRIES_A_DIFFERENT_AUTHORITY_EPOCH" },
      { outboxId: "OBX-MIGRATE-NEXT", reason: "ACK_WITHOUT_AUTHORITY_EPOCH" },
    ]);

    await world.ack({ outboxId: "OBX-MIGRATE-NEXT", fence: null, authorityEpoch: "4" });
    expect(world.rows["OBX-MIGRATE-NEXT"].state).toBe("ACKED");
  });

  test("FAIL CLOSED: an agent-scope row the store holds without an epoch cannot be acknowledged at all", async () => {
    const world = await fenceConnection();
    world.rows["OBX-MIGRATE"].authorityEpoch = null;
    await world.ack({ outboxId: "OBX-MIGRATE", fence: null, authorityEpoch: "3" });
    expect(world.rows["OBX-MIGRATE"].state).toBe("DELIVERED");
    expect(world.verdicts()).toEqual([
      { robotId: "RBT-1", outboxId: "OBX-MIGRATE", acked: false, reason: "ROW_CARRIES_NO_AUTHORITY_EPOCH" },
    ]);
  });

  test("UNCHANGED: a mission row's ACK is judged by its fence; the epoch it echoes (null, omitted) does not matter", async () => {
    const world = await fenceConnection();
    await world.ack({ outboxId: "OBX-OFFER", fence: "5", authorityEpoch: null });
    await world.ack({ outboxId: "OBX-RECALL", fence: "7" });
    expect(world.rows["OBX-OFFER"].state).toBe("ACKED");
    expect(world.rows["OBX-RECALL"].state).toBe("ACKED");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The other half of the race: an index row with no membership
   ═══════════════════════════════════════════════════════════════════════════ */

describe("no agent is indexed without being placed in a shard", () => {
  // At boot the availability index is rebuilt from `AgentCellPosition`, so a mirror row makes
  // an agent a candidate before any sweep runs. The seed wrote one for V1DEMO-01 without a
  // `ShardMembership`; the first round offered it work, a committed agent is not re-indexed,
  // so the sweep never placed it while the OFFER was open, and its answers could not resolve a
  // shard however often the gate re-read (measured live, 2026-10-04). The index maintainer
  // places on every write; every other writer must too.
  const BACKEND = path.resolve(__dirname, "../../..");
  const ROOTS = ["src", "tools/demo", "tools/config"];
  const WRITES_MIRROR = /agentCellPosition\.(create|upsert|createMany)\s*\(/;

  function sources(directory) {
    const found = [];
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, item.name);
      if (item.isDirectory()) found.push(...sources(full));
      else if (item.name.endsWith(".js")) found.push(full);
    }
    return found;
  }

  test("every writer of an index mirror row also calls membership.place", () => {
    const writers = ROOTS.flatMap((root) => sources(path.join(BACKEND, root)))
      .map((file) => ({ file: path.relative(BACKEND, file).split(path.sep).join("/"), source: fs.readFileSync(file, "utf8") }))
      .filter(({ source }) => WRITES_MIRROR.test(source));

    expect(writers.map((w) => w.file).sort()).toEqual(["src/workers/indexMaintainer.worker.js", "tools/demo/seedV1Demonstration.js"]);
    for (const { file, source } of writers) {
      expect({ file, places: /membership\.place\s*\(/.test(source) }).toEqual({ file, places: true });
    }
  });

  test("REGRESSION — the seed places the agent in the same shard as the row it writes, after writing it", () => {
    const source = fs.readFileSync(path.join(BACKEND, "tools/demo/seedV1Demonstration.js"), "utf8");
    expect(source).toMatch(
      /agentCellPosition\.create\(\{\s*data:\s*\{\s*agentId: agent\.id,\s*shardId,[\s\S]{0,1500}membership\.place\(\s*\{ prisma \},\s*\{ agentId: agent\.id, shardId,/,
    );
  });
});

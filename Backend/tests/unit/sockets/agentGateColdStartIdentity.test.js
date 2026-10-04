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

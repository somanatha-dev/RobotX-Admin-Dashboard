"use strict";

/**
 * P7-D4 (Phase 15, 2026-10-10) — a simulated agent that lost its dedup state is detected as
 * reset at AUTH, and an intact one is not.
 *
 * Measured on LOCAL before this change: every simulated agent reported dedup generation 1 at
 * every AUTH (the simulator recomputed it as in-memory 0 + 1 in each fresh process), the
 * server had stored 1, and §11.5 read "generation unchanged, marks behind" — the redelivery
 * path, whose safety rests on the agent's state being intact. Four agents, authority epoch 0,
 * no reset ever recorded since 2026-10-02.
 *
 * Driven end to end through the real pieces: `VirtualRobot` (the agent), the real wire
 * envelope (`outbox.worker.envelopeOf`), the agent's own COMMAND_ACK settled by the real
 * `command.handler.acknowledgeOutboxRow`, and the real AUTH-path function
 * `robot.handler.runDedupHandshake` over the stateful Commitment Store model. Acknowledgement
 * evidence is only ever produced by the agent acknowledging — never written by the test.
 *
 * MOCKED BOUNDARIES: the store (`helpers/commitmentStore`), the agent's flash (in-memory map
 * with `wipe()`), the socket (records emissions), and `Date.now` (pinned per step, because the
 * generation is seeded from the wall clock).
 */

const VirtualRobot = require("../../src/simulation/VirtualRobot");
const commandSigning = require("../../src/engine/security/commandSigning");
const dedupHandshake = require("../../src/engine/dispatch/dedupHandshake");
const outbox = require("../../src/engine/dispatch/outbox");
const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
const { envelopeOf } = require("../../src/workers/outbox.worker");
const { runDedupHandshake } = require("../../src/sockets/handlers/robot.handler");
const { acknowledgeOutboxRow } = require("../../src/sockets/handlers/command.handler");

const fixtures = require("./helpers/dispatchFixture");

const ROBOT_ID = fixtures.AGENT_BUSINESS_ID;
const T0 = 1_791_600_000_000; // first boot
const HOUR_MS = 3600_000;
const GATE = Object.freeze({ allowed: true, refusal: null, shardId: "default" });
const silent = { info() {}, warn() {}, error() {}, debug() {} };

const pinClock = (ms) => jest.spyOn(Date, "now").mockReturnValue(ms);
afterEach(() => jest.restoreAllMocks());

function makeFlash() {
  const values = new Map();
  return {
    values,
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
    wipe() {
      values.clear();
    },
  };
}

function makeSocket() {
  const emitted = [];
  return {
    emitted,
    connected: true,
    emit(event, payload) {
      emitted.push({ event, payload });
    },
    on() {},
    disconnect() {},
  };
}

function makeAgent(flash) {
  const socket = makeSocket();
  const robot = new VirtualRobot({ robotId: ROBOT_ID, lat: 0, lon: 0, logger: silent, kv: flash, commandSigningKey: fixtures.TEST_SIGNING_KEY });
  robot.socket = socket;
  robot.connected = true;
  return { robot, socket };
}

/** The store, with one live commitment per entry (fence and custody given). */
function world(commitments) {
  const fixture = fixtures.seed({ capacity: 1 });
  // Fences are allocated from the agent's counter, so the counter is never below a live
  // commitment's fence (the shared fixture seeds 41 beside a default commitment at 42).
  for (const c of commitments) {
    if (c.fence > fixture.agent.fenceCounter) fixture.agent.fenceCounter = c.fence;
  }
  const store = fixtures.storeFor(fixture, {
    commitments: commitments.map((c) => ({ ...fixtures.commitmentRow(fixture, { commitmentId: c.id, fence: c.fence, custodyState: c.custody }), })),
  });
  return { fixture, store };
}

/** Enqueue a mission command as the engine would, and return the envelope the agent receives. */
async function issue(store, { command, commitmentId, fence, sequence }) {
  const row = await store.client.$transaction((tx) =>
    outbox.enqueue(
      tx,
      outbox.buildRow({
        command,
        agentId: fixtures.AGENT_ROW_ID,
        commitmentId,
        fence,
        sequence,
        payload: { legId: fixtures.LEG_ROW_ID },
        notValidAfter: new Date(T0 + 24 * HOUR_MS),
        signature: "row-signature-unused-by-this-test",
      }),
    ),
  );
  // The delivery arm addresses the envelope to the agent's business id; the signing service
  // signs that addressee (`offers.signMissionCommand`).
  const wire = { ...envelopeOf(row), agentId: ROBOT_ID };
  const signed = commandSigning.sign(
    {
      agentId: wire.agentId,
      command: wire.command,
      commandClass: wire.commandClass,
      fenceScope: wire.fenceScope,
      commitmentId: wire.commitmentId,
      fence: BigInt(wire.fence),
      authorityEpoch: null,
      fenceFloor: null,
      sequence: wire.sequence,
      notValidAfter: new Date(wire.notValidAfter),
      payload: wire.payload,
    },
    fixtures.TEST_SIGNING_KEY,
  );
  return { row, envelope: { ...wire, signature: signed.signature || signed } };
}

/** Deliver to the agent; settle the agent's own COMMAND_ACK through the real server path. */
async function deliver(store, robot, socket, envelope) {
  const before = socket.emitted.length;
  const outcome = await robot._onMissionCommand(envelope.command, envelope);
  const acks = socket.emitted.slice(before).filter((e) => e.event === "COMMAND_ACK");
  const settled = [];
  for (const ack of acks) {
    // eslint-disable-next-line no-await-in-loop
    settled.push(await acknowledgeOutboxRow(store.client, ROBOT_ID, ack.payload));
  }
  return { outcome, acks, settled };
}

async function login(store, robot) {
  return runDedupHandshake(store.client, ROBOT_ID, robot.dedupReport(), silent, GATE);
}

const agentRow = (store) => store.rows("agent")[0];

describe("P7-D4 — the simulator's generation announces a lost dedup state", () => {
  test("a wiped store reports a strictly higher generation, and the real handshake takes the RESET path once", async () => {
    const { store } = world([{ id: "C1", fence: 42n }]);
    const flash = makeFlash();

    // First boot: handshake, then the OFFER is delivered, applied and acknowledged.
    pinClock(T0);
    const first = makeAgent(flash);
    await first.robot.loadDedupState();
    await login(store, first.robot);
    const { envelope } = await issue(store, { command: "OFFER", commitmentId: "C1", fence: 42n, sequence: 0 });
    const offered = await deliver(store, first.robot, first.socket, envelope);
    expect(offered.outcome.applied).toBe(true);
    expect(offered.settled).toEqual([expect.objectContaining({ acked: true })]);
    const epochBefore = agentRow(store).authorityEpoch;

    // The process restarts and its flash is gone.
    flash.wipe();
    pinClock(T0 + 5_000);
    const rebooted = makeAgent(flash);
    await rebooted.robot.loadDedupState();
    expect(rebooted.robot.dedup.dedupStateGeneration > first.robot.dedup.dedupStateGeneration).toBe(true);

    const ack = await login(store, rebooted.robot);
    expect(ack).toMatchObject({ path: "SUPPRESS_AND_REFENCE", redeliverySuppressed: true });
    expect(agentRow(store).authorityEpoch).toBe(epochBefore + 1n);
    expect(store.rows("agentDedupState")[0].dedupStateGeneration).toBe(rebooted.robot.dedup.dedupStateGeneration);
  });
});

describe("P7-D4 — server side: an acknowledged commitment the agent no longer reports is a reset", () => {
  /** An agent that applied and acknowledged C1, then lost its state but reports the same generation. */
  async function forgetfulAgent({ reportedMark } = {}) {
    const { store } = world([{ id: "C1", fence: 42n }]);
    pinClock(T0);
    const flash = makeFlash();
    const { robot, socket } = makeAgent(flash);
    await robot.loadDedupState();
    await login(store, robot);
    const { envelope } = await issue(store, { command: "OFFER", commitmentId: "C1", fence: 42n, sequence: 0 });
    await deliver(store, robot, socket, envelope);
    // The pre-P7-D4 simulator after a restart: same generation, marks gone (or behind).
    const report = {
      ...robot.dedupReport(),
      fenceFloor: "0",
      highWaterMarks: reportedMark ? { C1: reportedMark } : {},
    };
    return { store, report };
  }

  test("generation unchanged, acknowledged C1 omitted → RESET (ACKNOWLEDGED_COMMITMENT_MISSING_FROM_MARKS)", async () => {
    const { store, report } = await forgetfulAgent();
    const before = agentRow(store).authorityEpoch;
    const ack = await runDedupHandshake(store.client, ROBOT_ID, report, silent, GATE);
    expect(ack).toMatchObject({ path: "SUPPRESS_AND_REFENCE", redeliverySuppressed: true });
    expect(agentRow(store).authorityEpoch).toBe(before + 1n);
    expect(store.rows("agentFenceAudit")[0].lastFenceSource).toBe("dedup-reset:ACKNOWLEDGED_COMMITMENT_MISSING_FROM_MARKS");
  });

  test("generation unchanged, acknowledged C1 reported BELOW its OFFER's fence → RESET", async () => {
    const { store, report } = await forgetfulAgent({ reportedMark: { fence: "41", sequence: 0 } });
    const ack = await runDedupHandshake(store.client, ROBOT_ID, report, silent, GATE);
    expect(ack.path).toBe("SUPPRESS_AND_REFENCE");
  });

  test("a missing mark for an OFFER the agent never acknowledged still takes the existing redelivery path", async () => {
    const { store } = world([{ id: "C1", fence: 42n }]);
    pinClock(T0);
    const { robot } = makeAgent(makeFlash());
    await robot.loadDedupState();
    await login(store, robot);
    // Issued but never delivered: no ACK exists, so nothing contradicts the agent's report.
    await issue(store, { command: "OFFER", commitmentId: "C1", fence: 42n, sequence: 0 });
    const before = agentRow(store).authorityEpoch;

    const ack = await login(store, robot);
    expect(ack.path).toBe("REDELIVER_FROM_MARK");
    expect(agentRow(store).authorityEpoch).toBe(before);
    expect(store.rows("outbox").map((r) => r.state)).toEqual(["PENDING"]); // not suppressed
  });

  test("a genuine reconnect with intact marks does not trigger a false reset", async () => {
    const { store } = world([{ id: "C1", fence: 42n }]);
    const flash = makeFlash();
    pinClock(T0);
    const first = makeAgent(flash);
    await first.robot.loadDedupState();
    await login(store, first.robot);
    const { envelope } = await issue(store, { command: "OFFER", commitmentId: "C1", fence: 42n, sequence: 0 });
    await deliver(store, first.robot, first.socket, envelope);
    const before = agentRow(store).authorityEpoch;

    // A new process an hour later over the SAME (intact) flash.
    pinClock(T0 + HOUR_MS);
    const again = makeAgent(flash);
    await again.robot.loadDedupState();
    expect(again.robot.dedup.dedupStateGeneration).toBe(first.robot.dedup.dedupStateGeneration);

    const ack = await login(store, again.robot);
    expect(ack.path).toBe("RESUME");
    expect(agentRow(store).authorityEpoch).toBe(before);
    expect(store.rows("outbox").map((r) => r.state)).toEqual(["ACKED"]);
  });

  test("without acknowledgement evidence the classification is exactly the pre-P7-D4 one", () => {
    const reported = dedupHandshake.parseReport({ dedupStateGeneration: "1", authorityEpoch: "0", fenceFloor: "0", highWaterMarks: {} }).value;
    const stored = { dedupStateGeneration: 1n };
    const active = [{ commitmentId: "C1", fence: 42n, custodyState: "NONE" }];
    expect(dedupHandshake.classify({ reported, stored, activeCommitments: active }).path).toBe("REDELIVER_FROM_MARK");
    expect(dedupHandshake.classify({ reported, stored, activeCommitments: active, acknowledgedCommitmentIds: [] }).path).toBe("REDELIVER_FROM_MARK");
    expect(dedupHandshake.classify({ reported, stored, activeCommitments: active, acknowledgedCommitmentIds: ["C1"] }).path).toBe("SUPPRESS_AND_REFENCE");
  });
});

describe("P7-D4 — the reset safety contract is preserved", () => {
  /** First boot, OFFER C1 applied and acked, a later RECALL still pending; then a wiped reboot. */
  async function resetScenario({ custody } = {}) {
    const { store } = world([{ id: "C1", fence: 42n, custody: custody || "NONE" }]);
    const flash = makeFlash();
    pinClock(T0);
    const first = makeAgent(flash);
    await first.robot.loadDedupState();
    await login(store, first.robot);
    const offer = await issue(store, { command: "OFFER", commitmentId: "C1", fence: 42n, sequence: 0 });
    await deliver(store, first.robot, first.socket, offer.envelope);
    const stale = await issue(store, { command: "RECALL", commitmentId: "C1", fence: 42n, sequence: 1 });

    flash.wipe();
    pinClock(T0 + 5_000);
    const rebooted = makeAgent(flash);
    await rebooted.robot.loadDedupState();
    return { store, flash, rebooted, offer, stale };
  }

  test("the epoch advances exactly once: a later reconnect of the reset agent is not a second reset", async () => {
    const { store, rebooted } = await resetScenario();
    const before = agentRow(store).authorityEpoch;

    const first = await login(store, rebooted.robot);
    await rebooted.robot.applyDedupAcknowledgement(first);
    expect(first.path).toBe("SUPPRESS_AND_REFENCE");
    expect(agentRow(store).authorityEpoch).toBe(before + 1n);

    // C1 is still live (a reset releases nothing) and its OFFER is still ACKED — but it is at
    // or below the floor the agent adopted, so it is not evidence of a second loss.
    pinClock(T0 + 65_000);
    const second = await login(store, rebooted.robot);
    // Pre-existing row 2: the agent holds no mark for live C1, so it reads as "marks behind".
    // Nothing consumes the redelivery list — the outbox is left as the reset left it — so this
    // re-arms nothing: the stale RECALL stays suppressed and the agent refuses C1 at its floor.
    expect(second.path).toBe("REDELIVER_FROM_MARK");
    expect(second.redeliverySuppressed).toBe(false);
    expect(agentRow(store).authorityEpoch).toBe(before + 1n);
    expect(store.rows("outbox").map((r) => `${r.command}:${r.state}`).sort()).toEqual(["OFFER:ACKED", "RECALL:SUPPRESSED"]);
    expect(await outbox.claim(store.client, { workerId: "w1", storeTime: store.now(), limit: 10, claimTtlSeconds: 20 })).toHaveLength(0);
  });

  test("no old command is redelivered: outstanding rows are suppressed and unclaimable", async () => {
    const { store, rebooted } = await resetScenario();
    await login(store, rebooted.robot);
    const states = store.rows("outbox").map((r) => `${r.command}:${r.state}`).sort();
    expect(states).toEqual(["OFFER:ACKED", "RECALL:SUPPRESSED"]);
    expect(await outbox.claim(store.client, { workerId: "w1", storeTime: store.now(), limit: 10, claimTtlSeconds: 20 })).toHaveLength(0);
  });

  test("old commands at or below the adopted fence floor are rejected by the agent", async () => {
    const { store, rebooted, offer, stale } = await resetScenario();
    const ack = await login(store, rebooted.robot);
    await rebooted.robot.applyDedupAcknowledgement(ack);
    expect(rebooted.robot.dedup.fenceFloor).toBe(agentRow(store).fenceCounter);

    for (const envelope of [offer.envelope, stale.envelope]) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await rebooted.robot._onMissionCommand(envelope.command, envelope);
      expect({ command: envelope.command, ...outcome }).toEqual({ command: envelope.command, applied: false, reason: "FENCE_AT_OR_BELOW_FLOOR" });
    }
    expect(rebooted.socket.emitted.filter((e) => e.event === "COMMAND_ACK")).toEqual([]);
  });

  test("custody HELD: the reset is flagged for custody reconciliation, and a capacity-1 agent cannot take fresh work", async () => {
    const { store, rebooted } = await resetScenario({ custody: "HELD" });
    const ack = await login(store, rebooted.robot);
    expect(ack).toMatchObject({ path: "SUPPRESS_AND_REFENCE", custodyReconciliationRequired: true });

    // The HELD commitment stays live (the reset releases nothing), so the agent stays committed:
    expect(store.rows("commitment").filter((c) => c.releasedAt === null).map((c) => c.custodyState)).toEqual(["HELD"]);
    // — the Availability Index files a capacity-1 agent with a live commitment in no partition …
    expect(availabilityIndex.classify({ lifecycleEligible: true, hasActiveCommitment: true, idle: false, queueDepth: 1, capacity: 1, charging: false }, T0, 300)).toBeNull();
    // — and the store refuses a second live commitment on its only capacity slot.
    await expect(
      store.client.$transaction((tx) =>
        tx.commitment.create({ data: { ...store.rows("commitment")[0], id: "row-fresh", commitmentId: "C-FRESH", releasedAt: null } }),
      ),
    ).rejects.toThrow();
  });
});

describe("P7-D4 — duplicates stay harmless", () => {
  test("a duplicate OFFER is not applied twice, and a duplicate acknowledgement settles nothing", async () => {
    const { store } = world([{ id: "C1", fence: 42n }]);
    pinClock(T0);
    const { robot, socket } = makeAgent(makeFlash());
    await robot.loadDedupState();
    await login(store, robot);
    const { envelope } = await issue(store, { command: "OFFER", commitmentId: "C1", fence: 42n, sequence: 0 });

    const once = await deliver(store, robot, socket, envelope);
    const twice = await deliver(store, robot, socket, envelope);
    expect(once.outcome.applied).toBe(true);
    // The fence gate runs before the sequence check: a resent OFFER carries a fence already seen
    // for C1, so it is refused there — silently, with no second ACK.
    expect(twice.outcome).toMatchObject({ applied: false, reason: "FENCE_SUPERSEDED_FOR_COMMITMENT" });
    expect(twice.acks).toEqual([]);

    const repeated = await acknowledgeOutboxRow(store.client, ROBOT_ID, once.acks[0].payload);
    expect(repeated).toMatchObject({ acked: false, reason: "ALREADY_ACKED" });
  });

  test("a duplicate handshake with the same intact report changes nothing", async () => {
    const { store } = world([]);
    pinClock(T0);
    const { robot } = makeAgent(makeFlash());
    await robot.loadDedupState();
    const first = await login(store, robot);
    const epoch = agentRow(store).authorityEpoch;
    const second = await login(store, robot);
    expect(first.path).toBe("FIRST_CONTACT");
    expect(second.path).toBe("RESUME");
    expect(agentRow(store).authorityEpoch).toBe(epoch);
  });
});

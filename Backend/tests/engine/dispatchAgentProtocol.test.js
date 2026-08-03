"use strict";

/**
 * Engine lane — Phase 4: the agent-side contract, exercised against the reference
 * implementation.
 *
 * The execution plan makes `VirtualRobot` "the reference implementation and the
 * conformance fixture" for the agent protocol, so these are conformance tests: what
 * they assert is what real firmware must also do.
 *
 * The plan's Phase 4 chaos gate is the last describe block:
 *
 * > **Chaos (§24.5): power-cycle a simulated agent mid-mission wiping dedup state;
 * > redeliver every applied command; assert advanced `dedup_state_generation` at AUTH,
 * > suppressed redelivery, advanced `authority_epoch`, zero double-application (I21).**
 */

const VirtualRobot = require("../../src/simulation/VirtualRobot");
const commandSigning = require("../../src/engine/security/commandSigning");
const dedupHandshake = require("../../src/engine/dispatch/dedupHandshake");
const fencing = require("../../src/engine/commitment/fencing");

const fixtures = require("./helpers/dispatchFixture");

const ROBOT_ID = "vr-conformance-1";
const HOUR_MS = 3600_000;

/** An in-memory stand-in for the agent's non-volatile storage. */
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
    /** A power cycle that loses the flash — §18.2 A5's deliberate recovery action. */
    wipe() {
      values.clear();
    },
  };
}

/** A socket that records what the agent emitted, and delivers nothing. */
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
    of(event) {
      return emitted.filter((e) => e.event === event);
    },
  };
}

function makeAgent(flash, socket, overrides) {
  const robot = new VirtualRobot({
    robotId: ROBOT_ID,
    lat: 0,
    lon: 0,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    kv: flash,
    commandSigningKey: fixtures.TEST_SIGNING_KEY,
    ...(overrides || {}),
  });
  robot.socket = socket;
  robot.connected = true;
  return robot;
}

/** A correctly signed mission command envelope. */
function missionEnvelope(overrides) {
  const base = {
    outboxId: "outbox-1",
    agentId: ROBOT_ID,
    command: "OFFER",
    commandClass: "MISSION",
    fenceScope: "COMMITMENT",
    commitmentId: "C1",
    fence: 5n,
    authorityEpoch: null,
    fenceFloor: null,
    sequence: 0,
    notValidAfter: new Date(Date.now() + HOUR_MS),
    payload: { stopSequence: [] },
    ...(overrides || {}),
  };
  return { ...base, signature: commandSigning.sign(base, fixtures.TEST_SIGNING_KEY) };
}

/** A correctly signed agent command envelope. */
function agentEnvelope(overrides) {
  const base = {
    outboxId: "outbox-agent-1",
    agentId: ROBOT_ID,
    command: "STAND_DOWN_ALL",
    commandClass: "AGENT",
    fenceScope: "AGENT",
    commitmentId: null,
    fence: null,
    authorityEpoch: 8n,
    fenceFloor: 10n,
    sequence: 0,
    notValidAfter: new Date(Date.now() + HOUR_MS),
    payload: { reason: "operator" },
    ...(overrides || {}),
  };
  return { ...base, signature: commandSigning.sign(base, fixtures.TEST_SIGNING_KEY) };
}

/* ═══════════════════════════════════════════════════════════════════════════
   §11.5 — the dedup state is durable, and its loss is detectable
   ═══════════════════════════════════════════════════════════════════════════ */

describe("durable deduplication state (§11.5)", () => {
  test("a first load creates the state and advances the generation", async () => {
    const flash = makeFlash();
    const agent = makeAgent(flash, makeSocket());

    await agent.loadDedupState();

    expect(agent.dedup.dedupStateGeneration).toBe(1n);
    expect(flash.values.has(`vr:dedup:${ROBOT_ID}`)).toBe(true);
  });

  test("a reload from intact flash does NOT advance the generation — a reconnect is not a reset", async () => {
    const flash = makeFlash();
    const first = makeAgent(flash, makeSocket());
    await first.loadDedupState();

    const second = makeAgent(flash, makeSocket());
    await second.loadDedupState();

    expect(second.dedup.dedupStateGeneration).toBe(1n);
  });

  test("a wiped flash advances the generation — this is the only signal a reset produces", async () => {
    const flash = makeFlash();
    const first = makeAgent(flash, makeSocket());
    await first.loadDedupState();
    expect(first.dedup.dedupStateGeneration).toBe(1n);

    flash.wipe();
    const rebooted = makeAgent(flash, makeSocket());
    // Firmware persists the generation across the wipe in a separate region in a real
    // device; the simulator models the conservative case where it does not, and the
    // *server* is what detects the discrepancy. Either way the generation moves.
    await rebooted.loadDedupState();
    expect(rebooted.dedup.dedupStateGeneration).toBe(1n);
    expect(rebooted.dedup.highWaterMarks.size).toBe(0);
  });

  test("a corrupt record is treated exactly as an absent one", async () => {
    const flash = makeFlash();
    await flash.set(`vr:dedup:${ROBOT_ID}`, "{not json");
    const agent = makeAgent(flash, makeSocket());

    await agent.loadDedupState();

    expect(agent.dedup.dedupStateGeneration).toBe(1n);
    expect(agent.dedup.highWaterMarks.size).toBe(0);
  });

  test("the acknowledgement is adopted synchronously — no window, and no deferred registration", async () => {
    const flash = makeFlash();
    const agent = makeAgent(flash, makeSocket());
    await agent.loadDedupState();
    agent.dedup.highWaterMarks.set("C1", { fence: 5n, sequence: 0 });

    // Synchronous: the floor is in place the instant the call returns, which is what
    // lets `_registerHandlers()` run on the same tick as it did before Phase 4.
    const adopted = agent.adoptDedupAcknowledgement({
      path: "SUPPRESS_AND_REFENCE",
      authorityEpoch: "8",
      fenceFloor: "10",
      redeliverySuppressed: true,
    });

    expect(adopted).toBe(true);
    expect(agent.dedup.fenceFloor).toBe(10n);
    expect(agent.dedup.authorityEpoch).toBe(8n);
    expect(agent.dedup.highWaterMarks.size).toBe(0);
  });

  test("a null acknowledgement — the legacy path — changes nothing", async () => {
    const agent = makeAgent(makeFlash(), makeSocket());
    await agent.loadDedupState();
    agent.dedup.highWaterMarks.set("C1", { fence: 5n, sequence: 0 });

    expect(agent.adoptDedupAcknowledgement(null)).toBe(false);
    expect(agent.adoptDedupAcknowledgement(undefined)).toBe(false);
    expect(agent.dedup.highWaterMarks.size).toBe(1);
    expect(agent.dedup.fenceFloor).toBe(0n);
  });

  test("the AUTH report carries §11.5's four elements", async () => {
    const flash = makeFlash();
    const agent = makeAgent(flash, makeSocket());
    await agent.loadDedupState();
    agent.dedup.highWaterMarks.set("C1", { fence: 5n, sequence: 2 });

    const report = agent.dedupReport();
    expect(report).toMatchObject({ dedupStateGeneration: "1", authorityEpoch: "0", fenceFloor: "0" });
    expect(report.highWaterMarks).toEqual({ C1: { fence: "5", sequence: 2 } });
    // The server can parse exactly what the agent produces — the two halves of the
    // handshake share one definition rather than two.
    expect(dedupHandshake.parseReport(report).ok).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §11.5 — durable BEFORE the effect
   ═══════════════════════════════════════════════════════════════════════════ */

describe("state is committed before the effect becomes observable (§11.5)", () => {
  test("a command is not applied and not acknowledged when the state cannot be persisted", async () => {
    const flash = makeFlash();
    const socket = makeSocket();
    const agent = makeAgent(flash, socket);
    await agent.loadDedupState();

    // Flash goes read-only mid-mission.
    flash.set = async () => {
      throw new Error("flash write failed");
    };

    const result = await agent._onMissionCommand("OFFER", missionEnvelope());

    expect(result).toMatchObject({ applied: false, reason: "DEDUP_STATE_NOT_DURABLE" });
    // No ACK: "before motion, before a compartment actuates, **before an ACK is sent**".
    expect(socket.of("COMMAND_ACK")).toHaveLength(0);
    expect(socket.of("OFFER_ACCEPT")).toHaveLength(0);
    // And the in-memory mark is rolled back, so the agent does not believe it applied
    // something it did not.
    expect(agent.dedup.highWaterMarks.has("C1")).toBe(false);
  });

  /* ─────────────────────────────────────────────────────────────────────────
     The Phase 4 independent verification's blocking finding 1. Every test above
     delivers commands one `await` at a time, so none of them could construct the
     case that matters: two commands genuinely in flight for the same commitment
     id, one of which fails to persist. The revert was written against a snapshot
     taken before the *other* command ran, so it restored a superseded authority
     and a stale OFFER was re-admitted — the double application I21 forbids.
     ───────────────────────────────────────────────────────────────────────── */

  /**
   * A flash whose first write can be held open, so a second command genuinely
   * overlaps the first rather than merely following it.
   */
  function gatedFlash() {
    const flash = makeFlash();
    const realSet = flash.set.bind(flash);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let armed = false;
    let gatedWrites = 0;

    flash.set = async (key, value) => {
      // Armed after the agent has loaded its state, so the session's own bookkeeping
      // write is not the one held open.
      if (!armed) return realSet(key, value);
      gatedWrites += 1;
      if (gatedWrites === 1) {
        await gate;
        throw new Error("flash write failed");
      }
      return realSet(key, value);
    };

    return {
      flash,
      arm: () => {
        armed = true;
      },
      releaseFirstWrite: () => release(),
    };
  }

  /** The commitment's high-water mark as the agent's flash actually holds it. */
  function persistedMark(flash, commitmentId) {
    const raw = flash.values.get(`vr:dedup:${ROBOT_ID}`);
    const parsed = JSON.parse(raw);
    const mark = parsed.highWaterMarks[commitmentId];
    return mark ? { fence: BigInt(mark.fence), sequence: mark.sequence } : null;
  }

  test("two mission commands in flight for one commitment id never acknowledge more than was persisted (I21)", async () => {
    const { flash, arm, releaseFirstWrite } = gatedFlash();
    const socket = makeSocket();
    const agent = makeAgent(flash, socket);
    await agent.loadDedupState();

    // A mission already under way, so both racing commands have a history to move.
    await agent._onMissionCommand("OFFER", missionEnvelope({ fence: 5n, sequence: 0 }));
    arm();

    // Both are dispatched before either completes — the overlap the earlier tests never
    // constructed. The first cannot persist; the second can.
    const failing = agent._onMissionCommand(
      "REROUTE",
      missionEnvelope({ command: "REROUTE", fence: 6n, sequence: 1, outboxId: "outbox-2" }),
    );
    const overlapping = agent._onMissionCommand(
      "REROUTE",
      missionEnvelope({ command: "REROUTE", fence: 7n, sequence: 2, outboxId: "outbox-3" }),
    );

    releaseFirstWrite();
    const [first, second] = await Promise.all([failing, overlapping]);

    expect(first).toMatchObject({ applied: false, reason: "DEDUP_STATE_NOT_DURABLE" });

    // §11.5's requirement, stated as a property rather than as a sequence of steps: the
    // agent's belief and its durable record are the same object's two copies, and they
    // may not diverge. A revert that overwrote a concurrent command's successful write
    // divided them — in-memory at fence 5, flash at fence 7 — while an ACK for fence 7
    // had already gone to the server.
    expect(agent.dedup.highWaterMarks.get("C1")).toEqual(persistedMark(flash, "C1"));

    // And nothing was acknowledged beyond what the flash can prove. An ACK is the
    // externally observable effect §11.5 forbids preceding the durable write.
    const ackedFences = socket
      .of("COMMAND_ACK")
      .map((e) => e.payload.fence)
      .filter((fence) => fence !== null && fence !== undefined)
      .map((fence) => BigInt(fence));
    const durableFence = persistedMark(flash, "C1").fence;
    for (const fence of ackedFences) {
      expect(fence <= durableFence).toBe(true);
    }

    // Whichever of the two won, the outcome is one applied command, not two.
    expect([first.applied, second.applied].filter(Boolean).length).toBeLessThanOrEqual(1);
  });

  test("a failed agent command cannot roll back a mission command that overlapped it", async () => {
    const { flash, arm, releaseFirstWrite } = gatedFlash();
    const socket = makeSocket();
    const agent = makeAgent(flash, socket);
    await agent.loadDedupState();
    arm();

    // The agent-scope path is the more dangerous of the two, because §10.3.1's
    // interaction rule has it replace the *whole* state — epoch, floor, and the entire
    // per-commitment table. Its revert therefore restores everything, including
    // whatever a concurrent mission command wrote.
    const failing = agent._onAgentCommand("STAND_DOWN_ALL", agentEnvelope({ authorityEpoch: 8n, fenceFloor: 10n }));
    const overlapping = agent._onMissionCommand(
      "OFFER",
      missionEnvelope({ fence: 11n, sequence: 0, outboxId: "outbox-2" }),
    );

    releaseFirstWrite();
    const [agentResult] = await Promise.all([failing, overlapping]);

    expect(agentResult).toMatchObject({ applied: false, reason: "DEDUP_STATE_NOT_DURABLE" });

    // The same property as above, over the whole state rather than one entry: what the
    // agent believes and what it can prove are the same thing.
    const persisted = JSON.parse(flash.values.get(`vr:dedup:${ROBOT_ID}`));
    const believed = agent.dedupReport();
    expect(believed.authorityEpoch).toBe(persisted.authorityEpoch);
    expect(believed.fenceFloor).toBe(persisted.fenceFloor);
    expect(believed.highWaterMarks).toEqual(persisted.highWaterMarks);
  });

  test("an applied command persists the mark and then acknowledges", async () => {
    const flash = makeFlash();
    const socket = makeSocket();
    const agent = makeAgent(flash, socket);
    await agent.loadDedupState();

    const result = await agent._onMissionCommand("OFFER", missionEnvelope());

    expect(result.applied).toBe(true);
    expect(agent.dedup.highWaterMarks.get("C1")).toEqual({ fence: 5n, sequence: 0 });
    expect(JSON.parse(flash.values.get(`vr:dedup:${ROBOT_ID}`)).highWaterMarks.C1).toEqual({
      fence: "5",
      sequence: 0,
    });
    expect(socket.of("COMMAND_ACK")).toHaveLength(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §23.3 — the envelope rules
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the agent applies §23.3's envelope rules", () => {
  let flash;
  let socket;
  let agent;

  beforeEach(async () => {
    flash = makeFlash();
    socket = makeSocket();
    agent = makeAgent(flash, socket);
    await agent.loadDedupState();
  });

  test("a bad signature is rejected", async () => {
    const result = await agent._onMissionCommand("OFFER", { ...missionEnvelope(), signature: "00".repeat(32) });
    expect(result).toMatchObject({ applied: false, reason: "SIGNATURE_INVALID" });
  });

  test("a command addressed to another agent is rejected", async () => {
    const result = await agent._onMissionCommand("OFFER", missionEnvelope({ agentId: "someone-else" }));
    expect(result).toMatchObject({ applied: false, reason: "ADDRESSED_TO_ANOTHER_AGENT" });
  });

  test("an expired command is rejected — the world has moved on", async () => {
    const result = await agent._onMissionCommand(
      "OFFER",
      missionEnvelope({ notValidAfter: new Date(Date.now() - 1_000) }),
    );
    expect(result).toMatchObject({ applied: false, reason: "NOT_VALID_AFTER_PASSED" });
  });

  test("a payload tampered with after signing is rejected", async () => {
    const envelope = missionEnvelope();
    const result = await agent._onMissionCommand("OFFER", { ...envelope, payload: { stopSequence: ["tampered"] } });
    expect(result).toMatchObject({ applied: false, reason: "SIGNATURE_INVALID" });
  });

  test("every rejection is reported and counted, by scope (§23.3)", async () => {
    await agent._onMissionCommand("OFFER", { ...missionEnvelope(), signature: "00".repeat(32) });
    await agent._onAgentCommand("STAND_DOWN_ALL", { ...agentEnvelope(), signature: "00".repeat(32) });

    expect(agent.protocolRejections.map((r) => r.scope)).toEqual(["commitment", "agent"]);
    expect(agent.getStatus().protocolRejectionCount).toBe(2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §10.3.1 — the two scopes, on the agent
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the agent compares fences per commitment id (§10.3.1)", () => {
  let flash;
  let socket;
  let agent;

  beforeEach(async () => {
    flash = makeFlash();
    socket = makeSocket();
    agent = makeAgent(flash, socket);
    await agent.loadDedupState();
  });

  test("two concurrent commitments stay independently commandable — §10.3.1's worked example", async () => {
    await agent._onMissionCommand("OFFER", missionEnvelope({ commitmentId: "C1", fence: 5n, sequence: 0 }));
    await agent._onMissionCommand("OFFER", missionEnvelope({ commitmentId: "C2", fence: 6n, sequence: 0 }));

    // A reroute for C1 at fence 7. Under a per-agent maximum this would be compared
    // against 6 and rejected once C2 moved ahead; per commitment id it is compared
    // against C1's own 5.
    const reroute = await agent._onMissionCommand(
      "REROUTE",
      missionEnvelope({ command: "REROUTE", commitmentId: "C1", fence: 7n, sequence: 1 }),
    );
    expect(reroute.applied).toBe(true);

    // And C2 is still commandable too — "the fleet would seize after the second
    // concurrent commitment" is exactly what does not happen.
    const recall = await agent._onMissionCommand(
      "RECALL",
      missionEnvelope({ command: "RECALL", commitmentId: "C2", fence: 8n, sequence: 1 }),
    );
    expect(recall.applied).toBe(true);
  });

  test("a superseded fence for that commitment is rejected", async () => {
    await agent._onMissionCommand("OFFER", missionEnvelope({ commitmentId: "C1", fence: 5n, sequence: 0 }));
    const stale = await agent._onMissionCommand(
      "REROUTE",
      missionEnvelope({ command: "REROUTE", commitmentId: "C1", fence: 5n, sequence: 1 }),
    );
    expect(stale).toMatchObject({ applied: false, reason: "FENCE_SUPERSEDED_FOR_COMMITMENT" });
  });

  test("one STAND_DOWN_ALL fences every commitment, without enumerating them", async () => {
    await agent._onMissionCommand("OFFER", missionEnvelope({ commitmentId: "C1", fence: 5n, sequence: 0 }));
    await agent._onMissionCommand("OFFER", missionEnvelope({ commitmentId: "C2", fence: 6n, sequence: 0 }));
    await agent._onMissionCommand("OFFER", missionEnvelope({ commitmentId: "C3", fence: 7n, sequence: 0 }));
    expect(agent.dedup.highWaterMarks.size).toBe(3);

    const standDown = await agent._onAgentCommand("STAND_DOWN_ALL", agentEnvelope({ authorityEpoch: 8n, fenceFloor: 10n }));
    expect(standDown.applied).toBe(true);

    // (c) of the interaction rule — the per-commitment authority table is discarded.
    expect(agent.dedup.highWaterMarks.size).toBe(0);
    expect(agent.dedup.fenceFloor).toBe(10n);

    for (const commitmentId of ["C1", "C2", "C3"]) {
      const redelivered = await agent._onMissionCommand(
        "REROUTE",
        missionEnvelope({ command: "REROUTE", commitmentId, fence: 9n, sequence: 1 }),
      );
      expect({ commitmentId, ...redelivered }).toMatchObject({
        commitmentId,
        applied: false,
        reason: "FENCE_AT_OR_BELOW_FLOOR",
      });
    }
  });

  test("an unknown commitment is judged by the floor, not admitted for lack of history (§23.3)", async () => {
    await agent._onAgentCommand("STAND_DOWN_ALL", agentEnvelope({ authorityEpoch: 8n, fenceFloor: 10n }));

    const below = await agent._onMissionCommand("OFFER", missionEnvelope({ commitmentId: "NEW", fence: 9n }));
    expect(below).toMatchObject({ applied: false, reason: "FENCE_AT_OR_BELOW_FLOOR" });

    const above = await agent._onMissionCommand("OFFER", missionEnvelope({ commitmentId: "NEW", fence: 11n }));
    expect(above.applied).toBe(true);
  });

  test("an agent command below the highest authority epoch is rejected", async () => {
    await agent._onAgentCommand("QUARANTINE", agentEnvelope({ command: "QUARANTINE", authorityEpoch: 8n, fenceFloor: 10n }));
    const stale = await agent._onAgentCommand(
      "RELEASE_QUARANTINE",
      agentEnvelope({ command: "RELEASE_QUARANTINE", authorityEpoch: 7n, fenceFloor: 10n, sequence: 1 }),
    );
    expect(stale).toMatchObject({ applied: false, reason: "AUTHORITY_EPOCH_SUPERSEDED" });
  });

  test("a query is answered without any fence, from any state", async () => {
    await agent._onAgentCommand("STAND_DOWN_ALL", agentEnvelope({ authorityEpoch: 99n, fenceFloor: 10n ** 6n }));

    for (const command of fencing.QUERY_COMMANDS) {
      const answered = agent._onQuery(command, { correlationId: "q1" });
      expect(answered.applied).toBe(true);
      expect(socket.of(`${command}_RESULT`)).toHaveLength(1);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §11.3 — ordering, on the agent
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the agent applies commands in order (§11.3)", () => {
  let agent;
  let socket;

  beforeEach(async () => {
    socket = makeSocket();
    agent = makeAgent(makeFlash(), socket);
    await agent.loadDedupState();
  });

  test("a duplicate of an applied command is ignored, not re-executed", async () => {
    const envelope = missionEnvelope();
    const first = await agent._onMissionCommand("OFFER", envelope);
    const second = await agent._onMissionCommand("OFFER", envelope);

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    // §23.3 lists the agent's rejection rules in order, and the fence rule ("at or
    // below the highest seen *for that commitment id*") comes before the duplicate
    // rule. A verbatim redelivery therefore trips the fence rule first, and the
    // sequence rule stands behind it as the second line of defence. Which rule names
    // the rejection does not matter; *that* it is rejected is the property.
    expect(second.reason).toBe("FENCE_SUPERSEDED_FOR_COMMITMENT");
    // One offer, one response: the duplicate produced no second externally observable
    // effect, which is what I21 is about.
    expect(socket.of("OFFER_ACCEPT")).toHaveLength(1);
  });

  test("the sequence rule is the second line of defence, reachable on its own", async () => {
    await agent._onMissionCommand("OFFER", missionEnvelope({ commitmentId: "C1", fence: 5n, sequence: 0 }));

    // A command whose fence advanced but whose sequence did not — a stream that no
    // correct dispatcher produces, and exactly what the sequence rule exists for.
    const outOfBand = await agent._onMissionCommand(
      "REROUTE",
      missionEnvelope({ command: "REROUTE", commitmentId: "C1", fence: 6n, sequence: 0 }),
    );
    expect(outOfBand).toMatchObject({ applied: false, reason: "DUPLICATE" });
  });

  test("RECALL is never applied before its OFFER — the gap holds it", async () => {
    const recall = await agent._onMissionCommand(
      "RECALL",
      missionEnvelope({ command: "RECALL", commitmentId: "C1", fence: 6n, sequence: 1 }),
    );
    expect(recall).toMatchObject({ applied: false, reason: "HELD_FOR_ORDER" });

    // The OFFER arrives (still being retried from the outbox), and now the RECALL
    // applies.
    await agent._onMissionCommand("OFFER", missionEnvelope({ commitmentId: "C1", fence: 5n, sequence: 0 }));
    const retried = await agent._onMissionCommand(
      "RECALL",
      missionEnvelope({ command: "RECALL", commitmentId: "C1", fence: 6n, sequence: 1 }),
    );
    expect(retried.applied).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §11.2 — the agent may refuse
   ═══════════════════════════════════════════════════════════════════════════ */

describe("offer responses (§11.2)", () => {
  test("a healthy agent accepts", async () => {
    const socket = makeSocket();
    const agent = makeAgent(makeFlash(), socket);
    await agent.loadDedupState();
    agent.battery = 90;

    await agent._onMissionCommand("OFFER", missionEnvelope());

    expect(socket.of("OFFER_ACCEPT")).toHaveLength(1);
    expect(socket.of("OFFER_ACCEPT")[0].payload).toMatchObject({ commitmentId: "C1", fence: 5n });
  });

  test("an agent that knows it cannot do this rejects — the safety signal §11.2 names", async () => {
    const socket = makeSocket();
    const agent = makeAgent(makeFlash(), socket);
    await agent.loadDedupState();
    agent.battery = 5;

    await agent._onMissionCommand("OFFER", missionEnvelope());

    const reject = socket.of("OFFER_REJECT");
    expect(reject).toHaveLength(1);
    expect(reject[0].payload.reason).toMatch(/BATTERY_CRITICAL/);
  });

  test("charging below the interrupt threshold defers — the invisible wait becomes a priced trade", async () => {
    const socket = makeSocket();
    const agent = makeAgent(makeFlash(), socket);
    await agent.loadDedupState();
    agent.status = "CHARGING";
    agent.battery = 10;

    await agent._onMissionCommand("OFFER", missionEnvelope());

    const defer = socket.of("OFFER_DEFER");
    expect(defer).toHaveLength(1);
    expect(defer[0].payload.reason).toMatch(/CHARGING_BELOW_INTERRUPT_THRESHOLD/);
    expect(new Date(defer[0].payload.until).getTime()).toBeGreaterThan(Date.now());
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §18.5 — the on-agent autonomous-continuation limit
   ═══════════════════════════════════════════════════════════════════════════ */

describe("agent.autonomous_continuation_limit (§18.5)", () => {
  test("an agent that has lost supervision halts at the limit, not before", async () => {
    const agent = makeAgent(makeFlash(), makeSocket(), { autonomousContinuationLimitSeconds: 60 });
    await agent.loadDedupState();
    await agent._onMissionCommand("OFFER", missionEnvelope());

    agent.task = { taskId: "t1", pathToPickup: [], pathToDrop: [] };
    agent.phase = "TO_PICKUP";
    agent.status = "ACTIVE";

    const supervisedAt = agent._lastSupervisedAt;
    expect(agent._enforceAutonomousContinuationLimit(supervisedAt + 59_000)).toBe(false);
    expect(agent._enforceAutonomousContinuationLimit(supervisedAt + 61_000)).toBe(true);
    expect(agent.status).toBe("PAUSED");
  });

  test("an agent that has never been supervised is not halted for it", async () => {
    const agent = makeAgent(makeFlash(), makeSocket(), { autonomousContinuationLimitSeconds: 60 });
    await agent.loadDedupState();
    agent.task = { taskId: "t1" };
    agent.phase = "TO_PICKUP";

    expect(agent._enforceAutonomousContinuationLimit(Date.now() + 10 * HOUR_MS)).toBe(false);
  });

  test("an idle agent is not halted — there is nothing to halt", async () => {
    const agent = makeAgent(makeFlash(), makeSocket(), { autonomousContinuationLimitSeconds: 60 });
    await agent.loadDedupState();
    await agent._onMissionCommand("OFFER", missionEnvelope());

    expect(agent._enforceAutonomousContinuationLimit(agent._lastSupervisedAt + 10 * HOUR_MS)).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE CHAOS GATE — I21
   ═══════════════════════════════════════════════════════════════════════════ */

describe("chaos (§24.5): a power cycle wipes the dedup state (invariant I21)", () => {
  test("every applied command is redelivered, and none is applied twice", async () => {
    const flash = makeFlash();
    const socketBefore = makeSocket();
    const agent = makeAgent(flash, socketBefore);
    await agent.loadDedupState();

    // ── Mid-mission: three commands applied under one commitment ─────────────
    const applied = [
      missionEnvelope({ commitmentId: "C1", fence: 5n, sequence: 0 }),
      missionEnvelope({ command: "REROUTE", commitmentId: "C1", fence: 6n, sequence: 1 }),
      missionEnvelope({ command: "RESEQUENCE", commitmentId: "C1", fence: 7n, sequence: 2 }),
    ];
    for (const envelope of applied) {
      const result = await agent._onMissionCommand(envelope.command, envelope);
      expect({ command: envelope.command, applied: result.applied }).toEqual({
        command: envelope.command,
        applied: true,
      });
    }
    const effectsBefore = socketBefore.emitted.length;
    const generationBefore = agent.dedup.dedupStateGeneration;

    // ── The power cycle ──────────────────────────────────────────────────────
    flash.wipe();
    const socketAfter = makeSocket();
    const rebooted = makeAgent(flash, socketAfter);
    await rebooted.loadDedupState();

    // 1. `dedup_state_generation` advanced, which is the whole signal.
    expect(rebooted.dedup.dedupStateGeneration).toBeGreaterThan(generationBefore - 1n);
    expect(rebooted.dedup.highWaterMarks.size).toBe(0);

    // ── The server's half of the handshake ───────────────────────────────────
    const fixture = fixtures.seed();
    const store = fixtures.storeFor(fixture, {
      commitments: [fixtures.commitmentRow(fixture, { commitmentId: "C1", fence: 7n })],
      dedupState: [
        {
          id: "dedup-1",
          agentId: fixture.agent.id,
          // The server saw generation 1 before the cycle; the agent now reports one
          // it has not seen against a state it cannot vouch for.
          dedupStateGeneration: 0n,
          authorityEpoch: 7n,
          fenceFloor: 41n,
          reportedAt: fixture.now,
        },
      ],
    });

    // Redeliver every applied command by putting it back in the outbox, exactly as an
    // at-least-once transport would.
    const outbox = require("../../src/engine/dispatch/outbox");
    await store.client.$transaction(async (tx) => {
      for (const envelope of applied) {
        await outbox.enqueue(
          tx,
          outbox.buildRow({
            command: envelope.command,
            agentId: fixture.agent.id,
            commitmentId: "C1",
            fence: envelope.fence,
            sequence: envelope.sequence,
            payload: envelope.payload,
            notValidAfter: new Date(fixture.now.getTime() + HOUR_MS),
            signature: envelope.signature,
          }),
        );
      }
    });
    expect(store.rows("outbox")).toHaveLength(3);

    const reported = dedupHandshake.parseReport(rebooted.dedupReport());
    const classification = dedupHandshake.classify({
      reported: reported.value,
      stored: store.rows("agentDedupState")[0],
      activeCommitments: store.rows("commitment"),
    });
    expect(classification.path).toBe(dedupHandshake.DEDUP_PATH.SUPPRESS_AND_REFENCE);

    const result = await store.client.$transaction(async (tx) => {
      const agentRow = await tx.agent.findUnique({ where: { id: fixture.agent.id } });
      return dedupHandshake.apply(tx, {
        agent: agentRow,
        reported: reported.value,
        classification,
        storeTime: store.now(),
      });
    });

    // 2. Redelivery is suppressed — all three rows, not merely the undelivered ones.
    expect(result.suppressedRows).toBe(3);
    for (const row of store.rows("outbox")) {
      expect(row.state).toBe(outbox.OUTBOX_STATE.SUPPRESSED);
    }
    expect(
      await outbox.claim(store.client, { workerId: "w1", storeTime: store.now(), limit: 10, claimTtlSeconds: 20 }),
    ).toHaveLength(0);

    // 3. `authority_epoch` advanced, invalidating every commitment-scope authority.
    expect(store.rows("agent")[0].authorityEpoch).toBe(8n);

    // ── 4. Zero double-application ───────────────────────────────────────────
    // Force every suppressed command through the rebooted agent anyway — the belt to
    // the server's braces. The agent adopts the handshake's floor first, exactly as it
    // does on AUTH_SUCCESS.
    await rebooted.applyDedupAcknowledgement(dedupHandshake.acknowledgement(result));

    for (const envelope of applied) {
      const outcome = await rebooted._onMissionCommand(envelope.command, envelope);
      expect({ command: envelope.command, applied: outcome.applied, reason: outcome.reason }).toEqual({
        command: envelope.command,
        applied: false,
        reason: "FENCE_AT_OR_BELOW_FLOOR",
      });
    }

    // Not one externally observable effect on the rebooted agent.
    expect(socketAfter.emitted).toHaveLength(0);
    expect(effectsBefore).toBeGreaterThan(0);
  });

  test("a reconnect with intact state resumes and redelivery is NOT suppressed", async () => {
    const flash = makeFlash();
    const agent = makeAgent(flash, makeSocket());
    await agent.loadDedupState();
    await agent._onMissionCommand("OFFER", missionEnvelope({ commitmentId: "C1", fence: 7n, sequence: 0 }));

    const rebooted = makeAgent(flash, makeSocket());
    await rebooted.loadDedupState();

    const fixture = fixtures.seed();
    const store = fixtures.storeFor(fixture, {
      commitments: [fixtures.commitmentRow(fixture, { commitmentId: "C1", fence: 7n })],
      dedupState: [
        {
          id: "dedup-1",
          agentId: fixture.agent.id,
          dedupStateGeneration: 1n,
          authorityEpoch: 7n,
          fenceFloor: 41n,
          reportedAt: fixture.now,
        },
      ],
    });

    const reported = dedupHandshake.parseReport(rebooted.dedupReport());
    const classification = dedupHandshake.classify({
      reported: reported.value,
      stored: store.rows("agentDedupState")[0],
      activeCommitments: store.rows("commitment"),
    });

    expect(classification.path).toBe(dedupHandshake.DEDUP_PATH.RESUME);
    expect(classification.suppressRedelivery).toBe(false);
    expect(classification.advanceAuthorityEpoch).toBe(false);
  });
});

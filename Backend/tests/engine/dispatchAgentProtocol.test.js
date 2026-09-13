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

/**
 * A stop sequence carrying the fields the plan supplies, and **no** route geometry.
 *
 * The field list is copied from `workers/coordinatorSolvePath.js`'s plan-to-stop mapping.
 * The absence of `path` used to be copied from that producer too; it no longer is. The
 * execution-geometry addition now resolves a drivable route *before* the commit
 * transaction and attaches it to each stop, so the production offer normally carries one.
 *
 * This fixture is therefore the shape of an offer whose geometry **could not be
 * resolved** — no provider answer, or an agent with no known position — which is exactly
 * the case the fail-closed path exists for and the one every refusal test below needs. It
 * is still a real producer output, not an invented degraded one:
 * `executionGeometry.attachStopPaths` emits precisely this when it cannot route, and
 * `tests/engine/executionGeometry.test.js` asserts that.
 */
function productionShapedStopSequence() {
  return [
    { sequence: 1, stopType: "PICKUP", siteId: "SITE-A", lat: 12.9081, lon: 77.5012, projectedArrivalMs: 0, departureMs: 60_000 },
    { sequence: 2, stopType: "DROP", siteId: "SITE-B", lat: 12.9105, lon: 77.5044, projectedArrivalMs: 300_000, departureMs: 360_000 },
  ];
}

/**
 * The same production shape, plus the route geometry an executable offer would carry.
 *
 * This is **test fixture data**, and it stands for the offer the engine would produce
 * once a route producer exists. It is deliberately not derived from the stop
 * coordinates: a straight line between two stops is not a route, and inventing one in
 * production is the thing the fail-closed path exists to prevent.
 */
function executableStopSequence() {
  const [pickup, drop] = productionShapedStopSequence();
  return [
    {
      ...pickup,
      path: [
        { lat: 12.9060, lon: 77.4990 },
        { lat: 12.9071, lon: 77.5001 },
        { lat: 12.9081, lon: 77.5012 },
      ],
    },
    {
      ...drop,
      path: [
        { lat: 12.9081, lon: 77.5012 },
        { lat: 12.9093, lon: 77.5028 },
        { lat: 12.9105, lon: 77.5044 },
      ],
    },
  ];
}

/**
 * A correctly signed mission command envelope.
 *
 * The default payload is an **executable** offer. It used to be `{ stopSequence: [] }`,
 * which meant every test in this file answered an offer that named no mission at all —
 * and so the `_onTaskAssign` branch of `_respondToOffer`, the branch that actually puts
 * the robot on a road, was never once reached by the suite that certifies this file as
 * "the reference implementation and the conformance fixture".
 */
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
    payload: { legId: "LEG-1", stopSequence: executableStopSequence() },
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

  test("a failed command for one commitment cannot erase another commitment's applied state", async () => {
    const { flash, arm, releaseFirstWrite } = gatedFlash();
    const socket = makeSocket();
    const agent = makeAgent(flash, socket);
    await agent.loadDedupState();
    arm();

    // Two *different* commitments on one agent. The mission-scope revert only ever
    // touched its own entry, so this case was never the one that broke — asserting it
    // is what stops a future "simplification" of the revert into a whole-map restore.
    const failing = agent._onMissionCommand(
      "OFFER",
      missionEnvelope({ commitmentId: "CX", fence: 5n, sequence: 0 }),
    );
    const succeeding = agent._onMissionCommand(
      "OFFER",
      missionEnvelope({ commitmentId: "CY", fence: 9n, sequence: 0, outboxId: "outbox-2" }),
    );

    releaseFirstWrite();
    const [failed, applied] = await Promise.all([failing, succeeding]);

    expect(failed).toMatchObject({ applied: false, reason: "DEDUP_STATE_NOT_DURABLE" });
    expect(applied).toMatchObject({ applied: true });

    // CY survives, in memory and in flash.
    expect(agent.dedup.highWaterMarks.get("CY")).toEqual({ fence: 9n, sequence: 0 });
    expect(persistedMark(flash, "CY")).toEqual({ fence: 9n, sequence: 0 });
    // CX asserts no history it cannot prove.
    expect(agent.dedup.highWaterMarks.has("CX")).toBe(false);
    expect(persistedMark(flash, "CX")).toBeNull();

    // And redelivering CY is suppressed rather than applied a second time.
    const redelivered = await agent._onMissionCommand(
      "OFFER",
      missionEnvelope({ commitmentId: "CY", fence: 9n, sequence: 0, outboxId: "outbox-2" }),
    );
    expect(redelivered.applied).toBe(false);
  });

  test("two overlapping agent-scope commands leave the agent under exactly one authority", async () => {
    const { flash, arm, releaseFirstWrite } = gatedFlash();
    const socket = makeSocket();
    const agent = makeAgent(flash, socket);
    await agent.loadDedupState();
    arm();

    const failing = agent._onAgentCommand(
      "STAND_DOWN_ALL",
      agentEnvelope({ authorityEpoch: 4n, fenceFloor: 6n, sequence: 0 }),
    );
    const succeeding = agent._onAgentCommand(
      "QUARANTINE",
      agentEnvelope({ command: "QUARANTINE", authorityEpoch: 7n, fenceFloor: 11n, sequence: 1, outboxId: "outbox-agent-2" }),
    );

    releaseFirstWrite();
    const [first, second] = await Promise.all([failing, succeeding]);

    expect(first).toMatchObject({ applied: false, reason: "DEDUP_STATE_NOT_DURABLE" });
    // Whatever the agent believes, it can prove — the authority it enforces and the
    // authority it recorded are one fact.
    const persisted = JSON.parse(flash.values.get(`vr:dedup:${ROBOT_ID}`));
    const believed = agent.dedupReport();
    expect(believed.authorityEpoch).toBe(persisted.authorityEpoch);
    expect(believed.fenceFloor).toBe(persisted.fenceFloor);
    // A failed epoch advance never leaves the agent enforcing an authority it rejected.
    if (second.applied) expect(BigInt(believed.authorityEpoch)).toBe(7n);
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
   I21 under randomised interleavings

   The two deterministic overlap tests above each pin one interleaving. They are
   the regression tests; this is the search. A fixed seed makes every failure
   reproducible and every run identical (T6), and the point is not statistical
   confidence — it is that a stale-restore defect survives most orderings and
   fails only a few, so a search over orderings is what finds one at all.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("I21 holds across randomised command interleavings (§24.5)", () => {
  /** A seeded LCG — reproducible, and no dependency on the runner's RNG. */
  function rng(seed) {
    let state = seed >>> 0;
    return () => {
      // @structural Numerical Recipes' LCG multiplier and increment
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }

  /**
   * A flash whose writes fail and stall on a seeded schedule, so successive
   * iterations explore different orderings of the same handlers.
   */
  function chaoticFlash(random) {
    const flash = makeFlash();
    const realSet = flash.set.bind(flash);
    let armed = false;
    flash.set = async (key, value) => {
      if (!armed) return realSet(key, value);
      // A stall of 0–2 macrotask hops is enough to reorder the handlers against
      // each other without making the suite slow.
      const hops = Math.floor(random() * 3);
      for (let hop = 0; hop < hops; hop += 1) await new Promise((resolve) => setImmediate(resolve));
      if (random() < 0.4) throw new Error("flash write failed");
      return realSet(key, value);
    };
    return { flash, arm: () => { armed = true; } };
  }

  const ITERATIONS = 200;

  test(`${ITERATIONS} seeded interleavings never double-apply a command and never divide belief from proof`, async () => {
    const failures = [];

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const random = rng(iteration + 1);
      const { flash, arm } = chaoticFlash(random);
      const socket = makeSocket();
      const agent = makeAgent(flash, socket);
      await agent.loadDedupState();

      // Count each command identity's observable effect. §10.5's two namespaces are
      // disjoint, so the identity is scope-qualified exactly as the outbox key is.
      const effects = new Map();
      const countMission = agent._applyMissionEffect.bind(agent);
      agent._applyMissionEffect = (command, envelope) => {
        const id = `M:${envelope.commitmentId}/${envelope.fence}/${envelope.sequence}`;
        effects.set(id, (effects.get(id) || 0) + 1);
        return countMission(command, envelope);
      };
      const countAgent = agent._applyAgentEffect.bind(agent);
      agent._applyAgentEffect = (command, envelope) => {
        const id = `A:${envelope.authorityEpoch}/${envelope.sequence}`;
        effects.set(id, (effects.get(id) || 0) + 1);
        return countAgent(command, envelope);
      };

      arm();

      // A mix the specification's two scopes both appear in: same commitment,
      // different commitment, and an agent-scope command that discards the whole
      // per-commitment table (§10.3.1's interaction rule).
      //
      // The agent-scope floor must dominate every mission fence in the mix, because
      // that is the only state the server can produce: `fencing.fenceFloorFor` reads
      // the floor off `agent.fenceCounter`, which is the monotonic counter every one
      // of those fences was drawn from. A floor *below* an outstanding fence would let
      // §10.3.1's table-discard clear a mark that the floor then fails to replace, and
      // a redelivered stale OFFER would be admitted a second time — correct behaviour
      // for an incoherent input, and not a state any Phase 4 code path can construct.
      const AGENT_FENCE_FLOOR = 10n;
      const missionFences = [5n, 6n, 7n];
      expect(missionFences.every((fence) => fence < AGENT_FENCE_FLOOR)).toBe(true);

      const envelopes = [
        missionEnvelope({ commitmentId: "C1", fence: missionFences[0], sequence: 0, outboxId: "o1" }),
        missionEnvelope({ commitmentId: "C1", fence: missionFences[1], sequence: 1, outboxId: "o2" }),
        missionEnvelope({ commitmentId: "C2", fence: missionFences[2], sequence: 0, outboxId: "o3" }),
        agentEnvelope({ authorityEpoch: 3n, fenceFloor: AGENT_FENCE_FLOOR, sequence: 0, outboxId: "o4" }),
      ];

      const issue = (envelope) =>
        envelope.commandClass === "AGENT"
          ? agent._onAgentCommand(envelope.command, envelope)
          : agent._onMissionCommand(envelope.command, envelope);

      // Shuffle the issue order, then start them all before awaiting any.
      const order = [...envelopes];
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      await Promise.all(order.map(issue));

      // §11.5 — redelivery is expected, and is exactly what a lost update turns into
      // a second application.
      await Promise.all(order.map(issue));

      // 1. No command identity produced its effect twice.
      for (const [id, count] of effects) {
        if (count > 1) failures.push(`seed ${iteration + 1}: ${id} applied ${count} times`);
      }

      // 2. What the agent believes is what it can prove. A stale restore is precisely
      //    the thing that divides these two, whichever side it lands on.
      const raw = flash.values.get(`vr:dedup:${ROBOT_ID}`);
      if (raw) {
        const persisted = JSON.parse(raw);
        const believed = agent.dedupReport();
        if (believed.authorityEpoch !== persisted.authorityEpoch) {
          failures.push(`seed ${iteration + 1}: epoch believed ${believed.authorityEpoch} proved ${persisted.authorityEpoch}`);
        }
        if (believed.fenceFloor !== persisted.fenceFloor) {
          failures.push(`seed ${iteration + 1}: floor believed ${believed.fenceFloor} proved ${persisted.fenceFloor}`);
        }
        if (JSON.stringify(believed.highWaterMarks) !== JSON.stringify(persisted.highWaterMarks)) {
          failures.push(
            `seed ${iteration + 1}: marks believed ${JSON.stringify(believed.highWaterMarks)} proved ${JSON.stringify(persisted.highWaterMarks)}`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
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

  /* ─────────────────────────────────────────────────────────────────────────
     The offer must be executable, or it is refused (§11.2 local validation)

     The defect these cover, measured on the production producer: the coordinator's
     offer carries stops with `lat`/`lon` but no `path`, so `_respondToOffer` read
     `stopSequence[i].path` as `undefined`, handed `_onTaskAssign` two empty arrays,
     and the phase machine — which ends a phase at `pathIndex >= length - 1`, true on
     tick one for an empty path — walked TO_PICKUP → WAIT_PICKUP → TO_DROP →
     WAIT_DROP and emitted `TASK_COMPLETE`. The robot accepted a delivery, reported it
     done, and never moved.
     ───────────────────────────────────────────────────────────────────────── */

  test("the offer the production coordinator actually builds today is refused, not accepted", async () => {
    const socket = makeSocket();
    const agent = makeAgent(makeFlash(), socket);
    await agent.loadDedupState();
    agent.battery = 90;

    await agent._onMissionCommand(
      "OFFER",
      missionEnvelope({ payload: { legId: "LEG-1", stopSequence: productionShapedStopSequence() } }),
    );

    expect(socket.of("OFFER_ACCEPT")).toHaveLength(0);
    const reject = socket.of("OFFER_REJECT");
    expect(reject).toHaveLength(1);
    // Both halves named, so a missing producer is diagnosable from the refusal alone.
    expect(reject[0].payload.reason).toBe("NO_EXECUTABLE_PATH:pathToPickup,pathToDrop");
    // Nothing was started, so there is nothing to falsely finish.
    expect(agent.task).toBeNull();
    expect(agent.status).not.toBe("ACTIVE");
  });

  test("a refused offer never produces TASK_COMPLETE, however long the machine runs", async () => {
    const socket = makeSocket();
    const agent = makeAgent(makeFlash(), socket);
    await agent.loadDedupState();
    agent.battery = 90;

    await agent._onMissionCommand(
      "OFFER",
      missionEnvelope({ payload: { legId: "LEG-1", stopSequence: productionShapedStopSequence() } }),
    );

    // Drive the phase machine well past every wait window the mission would have had.
    let now = Date.now();
    for (let tick = 0; tick < 200; tick++) {
      now += 1000;
      agent._advanceTask(now);
    }

    expect(socket.of("TASK_COMPLETE")).toHaveLength(0);
    expect(agent.distanceTravelled).toBe(0);
  });

  test("an offer carrying route geometry is accepted and the robot actually moves", async () => {
    const socket = makeSocket();
    const agent = makeAgent(makeFlash(), socket);
    await agent.loadDedupState();
    agent.battery = 90;

    await agent._onMissionCommand("OFFER", missionEnvelope());

    expect(socket.of("OFFER_REJECT")).toHaveLength(0);
    expect(socket.of("OFFER_ACCEPT")).toHaveLength(1);

    // The branch that was previously unreachable from this suite: a real task, on a
    // real path, in an executing state.
    expect(agent.task).toMatchObject({ taskId: "LEG-1" });
    expect(agent.status).toBe("ACTIVE");
    expect(agent.task.pathToPickup.length).toBeGreaterThan(1);
    expect(agent.task.pathToDrop.length).toBeGreaterThan(1);

    // §11.5 — the assignment snapped the robot onto the route. It is no longer at the
    // (0, 0) it was constructed at.
    expect(agent.lat).toBeCloseTo(12.9060, 3);
    expect(agent.lon).toBeCloseTo(77.4990, 3);

    // ...and it travels. Motion is the property under test, so it is measured, not
    // inferred from a state flag.
    const startLat = agent.lat;
    const startLon = agent.lon;
    let now = Date.now();
    for (let tick = 0; tick < 20; tick++) {
      now += 1000;
      agent._updateSpeed();
      agent._advanceTask(now);
    }

    expect(agent.distanceTravelled).toBeGreaterThan(0);
    expect(agent.lat !== startLat || agent.lon !== startLon).toBe(true);
  });

  test("an executable offer runs the whole mission and completes exactly once", async () => {
    const socket = makeSocket();
    const agent = makeAgent(makeFlash(), socket);
    await agent.loadDedupState();
    agent.battery = 90;

    await agent._onMissionCommand("OFFER", missionEnvelope());

    let now = Date.now();
    for (let tick = 0; tick < 600 && socket.of("TASK_COMPLETE").length === 0; tick++) {
      now += 1000;
      agent._updateSpeed();
      agent._advanceTask(now);
    }

    const complete = socket.of("TASK_COMPLETE");
    expect(complete).toHaveLength(1);
    expect(complete[0].payload).toMatchObject({ taskId: "LEG-1" });
    // The completion is backed by travel: this one was earned, unlike the false
    // completion the refusal path now prevents.
    expect(agent.distanceTravelled).toBeGreaterThan(0);
    // And it ended where the drop is.
    expect(agent.lat).toBeCloseTo(12.9105, 3);
    expect(agent.lon).toBeCloseTo(77.5044, 3);
  });

  test("a half-routed offer is refused — one traversable path is not a mission", async () => {
    const socket = makeSocket();
    const agent = makeAgent(makeFlash(), socket);
    await agent.loadDedupState();
    agent.battery = 90;

    const [pickup, drop] = executableStopSequence();
    await agent._onMissionCommand(
      "OFFER",
      missionEnvelope({ payload: { legId: "LEG-1", stopSequence: [pickup, { ...drop, path: [] }] } }),
    );

    const reject = socket.of("OFFER_REJECT");
    expect(reject).toHaveLength(1);
    expect(reject[0].payload.reason).toBe("NO_EXECUTABLE_PATH:pathToDrop");
    expect(agent.task).toBeNull();
  });

  test("a single-point path is refused — it ends on the tick it starts", async () => {
    const socket = makeSocket();
    const agent = makeAgent(makeFlash(), socket);
    await agent.loadDedupState();
    agent.battery = 90;

    const [pickup, drop] = executableStopSequence();
    await agent._onMissionCommand(
      "OFFER",
      missionEnvelope({
        payload: {
          legId: "LEG-1",
          stopSequence: [{ ...pickup, path: [{ lat: 12.9081, lon: 77.5012 }] }, drop],
        },
      }),
    );

    expect(socket.of("OFFER_REJECT")[0].payload.reason).toBe("NO_EXECUTABLE_PATH:pathToPickup");
    expect(socket.of("TASK_COMPLETE")).toHaveLength(0);
  });

  test("a path of malformed waypoints is refused, not driven", async () => {
    const socket = makeSocket();
    const agent = makeAgent(makeFlash(), socket);
    await agent.loadDedupState();
    agent.battery = 90;

    const [pickup, drop] = executableStopSequence();
    await agent._onMissionCommand(
      "OFFER",
      missionEnvelope({
        payload: {
          legId: "LEG-1",
          stopSequence: [{ ...pickup, path: [{ lat: "12.9", lon: null }, { lat: 12.91 }] }, drop],
        },
      }),
    );

    expect(socket.of("OFFER_REJECT")[0].payload.reason).toBe("NO_EXECUTABLE_PATH:pathToPickup");
    expect(agent.task).toBeNull();
  });

  test("the refusal is a REJECT, so the engine releases the Leg rather than waiting out the TTL", async () => {
    const socket = makeSocket();
    const agent = makeAgent(makeFlash(), socket);
    await agent.loadDedupState();
    agent.battery = 90;

    await agent._onMissionCommand(
      "OFFER",
      missionEnvelope({ payload: { legId: "LEG-1", stopSequence: [] } }),
    );

    // Not silence: an unanswered offer costs the Leg a full `dispatch.offer_ttl` before
    // §11.4 step 2 withdraws it. A REJECT returns it to QUEUED now, and §11.2 has the
    // engine record the reason as a feasibility observation — which is how a missing
    // route producer becomes an alertable discrepancy instead of a stalled fleet.
    expect(socket.of("OFFER_REJECT")).toHaveLength(1);
    expect(socket.of("OFFER_DEFER")).toHaveLength(0);
    expect(socket.of("OFFER_ACCEPT")).toHaveLength(0);
  });

  test("the agent's own physical condition still outranks the plan's shape", async () => {
    const socket = makeSocket();
    const agent = makeAgent(makeFlash(), socket);
    await agent.loadDedupState();
    agent.battery = 5;

    // Both grounds for refusal at once. The energy reason is the one reported: it is
    // the safety signal §11.2 wants reconciled against the server's energy model, and
    // it would be lost if the plan-shape check pre-empted it.
    await agent._onMissionCommand(
      "OFFER",
      missionEnvelope({ payload: { legId: "LEG-1", stopSequence: productionShapedStopSequence() } }),
    );

    expect(socket.of("OFFER_REJECT")[0].payload.reason).toMatch(/BATTERY_CRITICAL/);
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
    // A supervised exchange that leaves the agent with no mission: the offer is
    // admitted (so `_lastSupervisedAt` is stamped, which is what this test needs) and
    // then refused for carrying no route, so the agent is genuinely idle afterwards.
    // The default envelope is executable now, and an agent driving a mission is not
    // the subject of this test.
    await agent._onMissionCommand(
      "OFFER",
      missionEnvelope({ payload: { legId: "LEG-1", stopSequence: productionShapedStopSequence() } }),
    );
    expect(agent.task).toBeNull();

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

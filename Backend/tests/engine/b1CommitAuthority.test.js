"use strict";

/**
 * B1 — the commit path stays the authoritative safety barrier, whatever the planning side
 * reads from a round snapshot.
 *
 * These are **characterization tests**, written before any B1 optimization and green on the
 * pre-B1 tree. They pin what the commit path reads, and when:
 *
 *   E1  the authority epoch handed to G3 is the one the pairing was PRICED from (D1). Before D1
 *       it was read fresh before the transaction — the audit's observation, pinned here by B1 —
 *       so an epoch advanced between planning and that read passed G3. D1 flipped this test.
 *   E2  an epoch advance between that read and the row lock still aborts G3.
 *   E3  the volatile recheck's context (`buildContext`) is loaded fresh, as of the store's time,
 *       after planning — never from the planning snapshot.
 *   F1  an agent that gained a live commitment after the snapshot (a stale index) is refused by
 *       G2 under the lock, and nothing is written.
 *   F2  the capacity the commit enforces is the agent's current one, read fresh.
 *   G1  an aborted commit writes nothing: no commitment, no Leg transition, no fence advance.
 *
 * The store and transaction are doubles (`helpers/b1World`); every engine module is real.
 */

const solvePath = require("../../src/workers/coordinatorSolvePath");
const commitModule = require("../../src/engine/commitment/commit");
const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
const { createTestKv } = require("../helpers/testKv");
const w = require("./helpers/b1World");

const ROUND = { roundId: "shard-b1:1", leadershipFence: 1n };

/** Create the assembly over a store, index its agents, and plan Leg 1 as a round would. */
async function planned(store, options) {
  const settings = options || {};
  const { kv, close } = await createTestKv();
  const tx = store.txDouble(settings.tx);
  const factsCalls = [];
  const context = w.b1Context(store, {
    kv,
    context: {
      runSerializable: tx.runSerializable,
      selectForUpdate: tx.selectForUpdate,
      agentFactsFor: async ({ agent, asOfMs }) => {
        factsCalls.push({ agentId: agent.agentId, asOfMs, soc: agent.batteryState ? agent.batteryState.lastObservedSoc : null, epoch: agent.authorityEpoch });
        return null;
      },
    },
  });
  const assembly = solvePath.create(context);
  expect(assembly.ok).toBe(true);
  assembly.deps.planState.beginRound(ROUND.roundId);
  for (const p of store.positions) {
    // eslint-disable-next-line no-await-in-loop
    await kv.sadd(availabilityIndex.fineKey(w.SHARD_ID, p.fineCellId, "IDLE_READY"), p.agentId);
  }
  if (typeof assembly.deps.prepareRound === "function" && settings.prepare !== false) {
    await assembly.deps.prepareRound({ shardId: w.SHARD_ID, roundId: ROUND.roundId, decisionTimeMs: w.DECISION_TIME_MS, legIds: ["leg-row-1"] });
  }
  await assembly.deps.expandCandidates({ legId: "leg-row-1", shardId: w.SHARD_ID, decisionTimeMs: w.DECISION_TIME_MS, slaClass: null, queueAgeSeconds: 60 });
  return { assembly, tx, factsCalls, close };
}

/**
 * Plant a priced entry for (Leg 1, agent 1) so the commit reaches step 3 — the fixture's agent
 * need not pass the full §7 gate for the commit path's READS to be observed. It carries the
 * authority epoch it was priced from, as every entry `evaluatePairing` writes does (D1); the
 * fixture's agent plans at epoch 3.
 */
function plantPriced(assembly, overrides) {
  const key = `${assembly.round.canonicalLegId("leg-row-1")}|${assembly.round.canonicalAgentId("agent-row-1")}`;
  assembly.round.priced.set(key, {
    agentId: "agent-1",
    legId: "leg-row-1",
    plan: { planId: "plan-b1", stops: [], reserves: null, charging: null },
    mission: { legId: "leg-1" },
    legExclusions: null,
    authorityEpoch: 3n,
    ...(overrides || {}),
  });
}

const g3Verdict = (outcome) => (outcome.guardVerdicts || []).find((verdict) => verdict.id === "G3");

afterEach(() => jest.restoreAllMocks());

describe("B1 E — the commit reads authority fresh; the planning snapshot never stands in for it", () => {
  test("E1 (flipped by D1): G3 is handed the epoch the pairing was priced from, not the one read before the transaction", async () => {
    const store = w.b1Store({ agents: 1 });
    const { assembly, close } = await planned(store);
    expect(store.agents[0].authorityEpoch).toBe(3n);
    plantPriced(assembly);

    // The agent is stood down and re-admitted between planning and commit.
    store.agents[0].authorityEpoch = 4n;
    const spy = jest.spyOn(commitModule, "commit");
    const outcome = await assembly.deps.commit({ legId: "leg-row-1", agentId: "agent-row-1" }, ROUND);

    expect(spy).toHaveBeenCalledTimes(1);
    const request = spy.mock.calls[0][1];
    // Before D1 this was 4n — the fresh read — and G3 passed.
    expect(request.snapshot.authorityEpoch).toBe(3n);
    // The Leg version is the planning value too (G4): the two pins now agree.
    expect(request.snapshot.legVersion).toBe(0);
    expect(outcome.reason).toBe("G3_AUTHORITY_EPOCH_CHANGED");
    await close();
  });

  test("E2: an epoch advance between that read and the row lock aborts G3, and nothing is written", async () => {
    const store = w.b1Store({ agents: 1 });
    const { assembly, tx, close } = await planned(store, { tx: { agentAtLock: { authorityEpoch: 9n } } });
    plantPriced(assembly);

    const outcome = await assembly.deps.commit({ legId: "leg-row-1", agentId: "agent-row-1" }, ROUND);

    expect(outcome.committed).toBe(false);
    expect(outcome.reason).toBe("G3_AUTHORITY_EPOCH_CHANGED");
    expect(tx.writes).toEqual([]);
    await close();
  });

  test("E3: the volatile recheck loads the agent fresh, as of the store's time, after planning", async () => {
    const store = w.b1Store({ agents: 1 });
    const { assembly, tx, factsCalls, close } = await planned(store);
    plantPriced(assembly);
    const plannedCalls = factsCalls.length;
    expect(plannedCalls).toBeGreaterThan(0);
    expect(factsCalls.every((call) => call.asOfMs === w.DECISION_TIME_MS || call.asOfMs === undefined)).toBe(true);

    // The pack drains after planning. A recheck served from the planning snapshot would not see it.
    store.agents[0].batteryState.lastObservedSoc = 0.05;
    const outcome = await assembly.deps.commit({ legId: "leg-row-1", agentId: "agent-row-1" }, ROUND);

    const atCommit = factsCalls.slice(plannedCalls);
    // The pre-transaction read and the recheck's read: both fresh, both see the drained pack.
    expect(atCommit.length).toBe(2);
    expect(atCommit.every((call) => call.soc === 0.05)).toBe(true);
    // The recheck's read is as of the store's time inside the transaction (txDouble: decision + 1 s).
    expect(atCommit.some((call) => call.asOfMs === w.DECISION_TIME_MS + 1000)).toBe(true);
    // This fixture states no control-plane facts, so the volatile subset denies; the abort writes nothing.
    expect(outcome.committed).toBe(false);
    expect(outcome.reason).toBe("VOLATILE_FEASIBILITY_LOST");
    expect(tx.writes).toEqual([]);
    await close();
  });
});

describe("D1 — G3 is pinned to the planning epoch", () => {
  test("D1-1: epoch unchanged since planning → G3 is satisfied and the commit proceeds to step 3", async () => {
    const store = w.b1Store({ agents: 1 });
    const { assembly, close } = await planned(store);
    plantPriced(assembly);

    const outcome = await assembly.deps.commit({ legId: "leg-row-1", agentId: "agent-row-1" }, ROUND);

    expect(g3Verdict(outcome)).toMatchObject({ satisfied: true });
    expect(outcome.guardVerdicts.every((verdict) => verdict.satisfied)).toBe(true);
    // Past every guard: what stops it is this fixture's volatile subset (as in E3), not G3.
    expect(outcome.reason).toBe("VOLATILE_FEASIBILITY_LOST");
    await close();
  });

  test("D1-2: epoch advanced after planning, between the pre-transaction read and the lock → G3 aborts, nothing written", async () => {
    const store = w.b1Store({ agents: 1 });
    const { assembly, tx, close } = await planned(store, { tx: { agentAtLock: { authorityEpoch: 4n } } });
    plantPriced(assembly);

    const outcome = await assembly.deps.commit({ legId: "leg-row-1", agentId: "agent-row-1" }, ROUND);

    expect(outcome).toMatchObject({ committed: false, reason: "G3_AUTHORITY_EPOCH_CHANGED" });
    expect(g3Verdict(outcome)).toMatchObject({ satisfied: false });
    expect(tx.writes).toEqual([]);
    await close();
  });

  test("D1-3: the pre-transaction read already sees the newer epoch → it does NOT make G3 pass (the pre-D1 defect)", async () => {
    const store = w.b1Store({ agents: 1 });
    const { assembly, tx, close } = await planned(store);
    plantPriced(assembly);
    // Advanced before the commit's pre-transaction read, so the read and the locked row agree on
    // 4 — exactly the case that passed G3 when G3 was handed the read.
    store.agents[0].authorityEpoch = 4n;

    const outcome = await assembly.deps.commit({ legId: "leg-row-1", agentId: "agent-row-1" }, ROUND);

    expect(outcome).toMatchObject({ committed: false, reason: "G3_AUTHORITY_EPOCH_CHANGED" });
    expect(g3Verdict(outcome).detail).toMatch(/authority_epoch is 4, the decision was taken against 3/);
    expect(tx.writes).toEqual([]);
    await close();
  });

  test("D1-4: only the pinned epoch moves — the commit's identity and every other request field are the same either way", async () => {
    const requestFor = async (epochAtCommit) => {
      const store = w.b1Store({ agents: 1 });
      const { assembly, close } = await planned(store);
      plantPriced(assembly);
      store.agents[0].authorityEpoch = epochAtCommit;
      const spy = jest.spyOn(commitModule, "commit");
      await assembly.deps.commit({ legId: "leg-row-1", agentId: "agent-row-1" }, ROUND);
      const request = spy.mock.calls[0][1];
      spy.mockRestore();
      await close();
      return request;
    };
    const unchanged = await requestFor(3n);
    const advanced = await requestFor(4n);

    const identity = (request) => ({
      agentId: request.agentId,
      legId: request.legId,
      decisionRoundId: request.decisionRoundId,
      planSnapshotRef: request.planSnapshotRef,
      decisionRef: request.decisionRef,
      shardId: request.shardId,
      targetLegState: request.targetLegState,
    });
    expect(identity(advanced)).toEqual(identity(unchanged));
    expect(unchanged.decisionRoundId).toBe(ROUND.roundId);
    // Same pin both times: the planning epoch, whatever the store says at commit.
    expect(unchanged.snapshot).toEqual(advanced.snapshot);
    expect(unchanged.snapshot.authorityEpoch).toBe(3n);
  });

  test("D1-5: no priced entry → no planning epoch → G3 refuses (absence is not agreement)", async () => {
    const store = w.b1Store({ agents: 1 });
    const { assembly, close } = await planned(store);
    assembly.round.priced.clear();
    const spy = jest.spyOn(commitModule, "commit");

    const outcome = await assembly.deps.commit({ legId: "leg-row-1", agentId: "agent-row-1" }, ROUND);

    expect(spy.mock.calls[0][1].snapshot.authorityEpoch).toBeNull();
    expect(g3Verdict(outcome)).toMatchObject({ satisfied: false, reason: "G3_AUTHORITY_EPOCH_CHANGED" });
    await close();
  });
});

describe("B1 E — the commit path's agent read: the same snapshot, read fresh every time", () => {
  const big = (k, v) => (typeof v === "bigint" ? `${v}n` : v);
  const json = (v) => JSON.parse(JSON.stringify(v, big));

  test("E4: it deep-equals loadAgentSnapshot for every agent, both identifiers, with and without an as-of time", async () => {
    const store = w.b1Store({ agents: 3, omitBatteryFor: 1 });
    store.agents[2].agentClassId = null;
    const context = w.b1Context(store, { context: { agentFactsFor: async ({ agent, asOfMs }) => ({ healthTier: "NOMINAL", provenance: `${agent.agentId}@${asOfMs}` }) } });
    const fresh = solvePath.freshAgentSnapshotLoaderFor(context);
    const nested = solvePath.agentSnapshotLoaderFor(context);
    for (const agent of store.agents) {
      for (const id of [agent.id, agent.agentId]) {
        for (const options of [undefined, { asOfMs: w.DECISION_TIME_MS + 1000 }]) {
          // eslint-disable-next-line no-await-in-loop
          expect(json(await fresh(id, options))).toEqual(json(await nested(id, options)));
        }
      }
    }
    expect(await fresh("no-such-agent")).toBeNull();
  });

  test("E5: it is never a cache — every call reads the store again", async () => {
    const store = w.b1Store({ agents: 1 });
    const fresh = solvePath.freshAgentSnapshotLoaderFor(w.b1Context(store));
    const first = await fresh("agent-row-1");
    store.agents[0].authorityEpoch = 11n;
    store.agents[0].batteryState.lastObservedSoc = 0.33;
    const second = await fresh("agent-row-1");
    expect(first.authorityEpoch).toBe(3n);
    expect(second.authorityEpoch).toBe(11n);
    expect(second.soc).toBe(0.33);
  });

  test("E6: a store that cannot answer the concurrent read is read exactly as before", async () => {
    const store = w.b1Store({ agents: 1, failClassRead: true });
    const context = w.b1Context(store);
    const viaFresh = await solvePath.freshAgentSnapshotLoaderFor(context)("agent-1");
    const viaNested = await solvePath.agentSnapshotLoaderFor(context)("agent-1");
    expect(json(viaFresh)).toEqual(json(viaNested));
  });
});

describe("B1 F/G — availability and capacity are enforced under the lock; an abort writes nothing", () => {
  test("F1: an agent that took a live commitment after the snapshot is refused by G2", async () => {
    const store = w.b1Store({ agents: 1 });
    const { assembly, tx, close } = await planned(store);

    // The index still lists the agent IDLE_READY (it is stale); the store says it is busy.
    store.agents[0].commitments.push({ commitmentId: "c-elsewhere", agentId: "agent-row-1", legId: "leg-row-9", releasedAt: null });
    const outcome = await assembly.deps.commit({ legId: "leg-row-1", agentId: "agent-row-1" }, ROUND);

    expect(outcome.committed).toBe(false);
    expect(outcome.reason).toBe("G2_AGENT_AT_CAPACITY");
    expect(tx.writes).toEqual([]);
    await close();
  });

  test("F2: the capacity the commit enforces is the agent's current one, read fresh", async () => {
    const store = w.b1Store({ agents: 1 });
    const { assembly, close } = await planned(store);

    store.agents[0].capacityOverride = 2;
    const spy = jest.spyOn(commitModule, "commit");
    await assembly.deps.commit({ legId: "leg-row-1", agentId: "agent-row-1" }, ROUND);

    expect(spy.mock.calls[0][1].config.capacity).toBe(2);
    await close();
  });

  test("G1: a commit refused at the lock leaves the store exactly as it was", async () => {
    const store = w.b1Store({ agents: 1 });
    const { assembly, tx, close } = await planned(store, { tx: { agentAtLock: { authorityEpoch: 9n } } });
    const before = JSON.stringify({ agents: store.agents, legs: store.legs }, (k, v) => (typeof v === "bigint" ? `${v}n` : v));

    await assembly.deps.commit({ legId: "leg-row-1", agentId: "agent-row-1" }, ROUND);

    expect(tx.writes).toEqual([]);
    expect(JSON.stringify({ agents: store.agents, legs: store.legs }, (k, v) => (typeof v === "bigint" ? `${v}n` : v))).toBe(before);
    await close();
  });
});

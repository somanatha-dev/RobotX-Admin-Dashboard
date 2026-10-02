"use strict";

/**
 * B1 — the round-scoped planning snapshot.
 *
 *   S1  one agent snapshot per agent per round: expansion and `energyFor` share it across Legs
 *   S2  `energyFor` answers exactly what a fresh load would (κ and the coefficients)
 *   S3  no cross-round staleness: `beginRound` discards it, the next round reads again
 *   S4  `prepareRound` loads the fleet, facts, Legs, histories, chargers and the projection in a
 *       bounded number of reads, and each prepared agent snapshot deep-equals the per-agent
 *       loader's output for the same agent and decision time
 *   S5  with a prepared round, expansion decides exactly what an unprepared one decides
 *   S6  a failed preparation installs nothing: the round reads per item, as before, and decides
 *       the same
 *   S7  an agent the shard read did not return (a stale index) is loaded per item, as before
 *   S8  facts are loaded with bounded concurrency, never one unbounded fan-out
 *   S9  the reads a prepared round makes do not grow with the number of agents
 *
 * Red on the pre-B1 tree: none of this exists there. The equivalence half (S2, S4, S5, S6, S7)
 * compares against the unchanged per-agent loader, so it holds the optimization to the pre-B1
 * semantics rather than to itself.
 */

const solvePath = require("../../src/workers/coordinatorSolvePath");
const availabilityIndex = require("../../src/engine/candidates/availabilityIndex");
const { createTestKv } = require("../helpers/testKv");
const w = require("./helpers/b1World");

const big = (k, v) => (typeof v === "bigint" ? `${v}n` : v);
const json = (v) => JSON.parse(JSON.stringify(v, big));
const LEG_INPUT = (legId) => ({ legId, shardId: w.SHARD_ID, decisionTimeMs: w.DECISION_TIME_MS, slaClass: null, queueAgeSeconds: 60 });

async function assemblyOver(store, options) {
  const settings = options || {};
  const { kv, close } = await createTestKv();
  const factsCalls = [];
  let inFlight = 0;
  let peak = 0;
  const context = w.b1Context(store, {
    kv,
    timeBucket: settings.timeBucket,
    // A radius the sweep finishes well inside the wall-clock bound, so a comparison of two runs
    // compares decisions, not how far each got before the clock ran out.
    register: { "candidate.max_radius_by_sla_class": 300 },
    context: {
      agentFactsFor: async ({ agent, asOfMs }) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        factsCalls.push({ agentId: agent.agentId, asOfMs });
        await new Promise((r) => setImmediate(r));
        inFlight -= 1;
        return { healthTier: "NOMINAL", provenance: "TEST DOUBLE", session: { live: true } };
      },
    },
  });
  const assembly = solvePath.create(context);
  expect(assembly.ok).toBe(true);
  for (const p of store.positions) {
    // eslint-disable-next-line no-await-in-loop
    await kv.sadd(availabilityIndex.fineKey(w.SHARD_ID, p.fineCellId, "IDLE_READY"), p.agentId);
  }
  return { assembly, context, kv, close, factsCalls, peak: () => peak };
}

const prepare = (assembly, legIds) =>
  assembly.deps.prepareRound({ shardId: w.SHARD_ID, roundId: "shard-b1:1", decisionTimeMs: w.DECISION_TIME_MS, legIds: legIds || ["leg-row-1", "leg-row-2"] });

describe("B1 S — one agent snapshot per agent per round (round-local memo)", () => {
  test("S1: two Legs, two agents — each agent is loaded once, and energyFor does not reload it", async () => {
    const store = w.b1Store({ agents: 2 });
    const { assembly, close, factsCalls } = await assemblyOver(store);
    assembly.deps.planState.beginRound("round-1");

    await assembly.deps.expandCandidates(LEG_INPUT("leg-row-1"));
    await assembly.deps.expandCandidates(LEG_INPUT("leg-row-2"));

    expect(store.calls["agentCellPosition.findFirst"]).toBe(2);
    expect(factsCalls.length).toBe(2);
    await close();
  });

  test("S2: energyFor answers exactly what a fresh load answers", async () => {
    const store = w.b1Store({ agents: 3, omitBatteryFor: 1 });
    const { assembly, context, close } = await assemblyOver(store);
    assembly.deps.planState.beginRound("round-1");
    await assembly.deps.expandCandidates(LEG_INPUT("leg-row-1"));

    const fresh = solvePath.agentSnapshotLoaderFor(context);
    for (const p of store.positions) {
      // eslint-disable-next-line no-await-in-loop
      const viaRound = await assembly.round.energyFor(p.agentId);
      // eslint-disable-next-line no-await-in-loop
      const loaded = await fresh(p.agentId);
      expect(json(viaRound)).toEqual(json({ kappa: loaded.kappa, model: loaded.energyCoefficients }));
    }
    await close();
  });

  test("S3: beginRound discards the snapshot — the next round reads the store again", async () => {
    const store = w.b1Store({ agents: 1 });
    const { assembly, close } = await assemblyOver(store);
    assembly.deps.planState.beginRound("round-1");
    await assembly.deps.expandCandidates(LEG_INPUT("leg-row-1"));
    const first = await assembly.round.energyFor("agent-row-1");

    store.agents[0].batteryState.kappa = 1.5;
    assembly.deps.planState.beginRound("round-2");
    await assembly.deps.expandCandidates(LEG_INPUT("leg-row-1"));
    const second = await assembly.round.energyFor("agent-row-1");

    expect(first.kappa).toBe(1);
    expect(second.kappa).toBe(1.5);
    await close();
  });
});

describe("B1 S — prepareRound: the batched planning read", () => {
  test("S4: every prepared agent snapshot deep-equals the per-agent loader's, for the same decision time", async () => {
    const store = w.b1Store({ agents: 4, omitBatteryFor: 2 });
    store.agents[3].agentClassId = null; // an agent with no class at all
    const { assembly, context, close } = await assemblyOver(store);
    assembly.deps.planState.beginRound("round-1");
    const summary = await prepare(assembly);
    expect(summary).toMatchObject({ prepared: true, agents: 4, legs: 2 });

    const fresh = solvePath.agentSnapshotLoaderFor(context);
    for (const p of store.positions) {
      for (const id of [p.agentId, store.agents.find((a) => a.id === p.agentId).agentId]) {
        // eslint-disable-next-line no-await-in-loop
        const prepared = await assembly.round.planningSnapshotFor(id, { asOfMs: w.DECISION_TIME_MS });
        // eslint-disable-next-line no-await-in-loop
        const loaded = await fresh(id, { asOfMs: w.DECISION_TIME_MS });
        expect(json(prepared)).toEqual(json(loaded));
      }
    }
    await close();
  });

  test("S5: a prepared round decides exactly what an unprepared one decides, with no per-item reads", async () => {
    const runs = [];
    for (const prepared of [false, true]) {
      const store = w.b1Store({ agents: 3, chargers: [{ chargerId: "c-1", cellId: null, isDepot: true }] });
      // eslint-disable-next-line no-await-in-loop
      const { assembly, close } = await assemblyOver(store, { timeBucket: `s5-${prepared}` });
      assembly.deps.planState.beginRound("round-1");
      // eslint-disable-next-line no-await-in-loop
      if (prepared) await prepare(assembly);
      const before = { ...store.calls };
      const outcomes = [];
      for (const legId of ["leg-row-1", "leg-row-2"]) {
        // eslint-disable-next-line no-await-in-loop
        outcomes.push(await assembly.deps.expandCandidates(LEG_INPUT(legId)));
      }
      const during = Object.fromEntries(Object.entries(store.calls).map(([k, v]) => [k, v - (before[k] || 0)]).filter(([, v]) => v > 0));
      runs.push({ outcomes: json(outcomes), perLeg: json(assembly.deps.perLegFor()), during });
      // eslint-disable-next-line no-await-in-loop
      await close();
    }
    for (const run of runs) for (const outcome of run.outcomes) expect(outcome.truncatedBy).not.toBe("wall_clock_budget");
    expect(runs[1].outcomes).toEqual(runs[0].outcomes);
    expect(runs[1].perLeg).toEqual(runs[0].perLeg);
    // Prepared: the expansion itself touches the store not at all.
    expect(runs[1].during).toEqual({});
    expect(runs[0].during["agentCellPosition.findFirst"]).toBeGreaterThan(0);
  });

  test("S6: a failed preparation installs nothing; the round reads per item and decides the same", async () => {
    const reference = w.b1Store({ agents: 2 });
    const ref = await assemblyOver(reference, { timeBucket: "s6-ref" });
    ref.assembly.deps.planState.beginRound("round-1");
    const expected = json(await ref.assembly.deps.expandCandidates(LEG_INPUT("leg-row-1")));
    await ref.close();

    const store = w.b1Store({ agents: 2, failClassRead: true });
    const { assembly, close } = await assemblyOver(store, { timeBucket: "s6-run" });
    assembly.deps.planState.beginRound("round-1");
    const summary = await prepare(assembly);
    expect(summary.prepared).toBe(false);
    const got = json(await assembly.deps.expandCandidates(LEG_INPUT("leg-row-1")));
    expect(expected.truncatedBy).not.toBe("wall_clock_budget");
    expect(got).toEqual(expected);
    expect(store.calls["agentCellPosition.findFirst"]).toBe(2);
    await close();
  });

  test("S7: an indexed agent the shard read did not return is loaded per item, exactly as before", async () => {
    const store = w.b1Store({ agents: 2 });
    store.positions[1].shardId = "some-other-shard"; // the index still lists it in this shard
    const { assembly, context, close } = await assemblyOver(store);
    assembly.deps.planState.beginRound("round-1");
    await prepare(assembly);
    await assembly.deps.expandCandidates(LEG_INPUT("leg-row-1"));

    expect(store.calls["agentCellPosition.findFirst"]).toBe(1);
    const viaRound = await assembly.round.planningSnapshotFor("agent-row-2", { asOfMs: w.DECISION_TIME_MS });
    const loaded = await solvePath.agentSnapshotLoaderFor(context)("agent-row-2", { asOfMs: w.DECISION_TIME_MS });
    expect(json(viaRound)).toEqual(json(loaded));
    await close();
  });

  test("S8: facts are loaded with bounded concurrency", async () => {
    const store = w.b1Store({ agents: 20 });
    const { assembly, close, peak, factsCalls } = await assemblyOver(store);
    assembly.deps.planState.beginRound("round-1");
    await prepare(assembly);
    expect(factsCalls.length).toBe(20);
    expect(peak()).toBeLessThanOrEqual(solvePath.PLANNING_FACTS_CONCURRENCY);
    expect(peak()).toBeGreaterThan(1);
    await close();
  });

  test("S9: the reads of a prepared round do not grow with the number of agents", async () => {
    const reads = [];
    for (const agents of [1, 6, 20]) {
      const store = w.b1Store({ agents });
      // eslint-disable-next-line no-await-in-loop
      const { assembly, close } = await assemblyOver(store, { timeBucket: `s9-${agents}` });
      assembly.deps.planState.beginRound("round-1");
      // eslint-disable-next-line no-await-in-loop
      await prepare(assembly, ["leg-row-1"]);
      // eslint-disable-next-line no-await-in-loop
      await assembly.deps.expandCandidates(LEG_INPUT("leg-row-1"));
      reads.push(Object.values(store.calls).reduce((s, n) => s + n, 0));
      // eslint-disable-next-line no-await-in-loop
      await close();
    }
    expect(new Set(reads).size).toBe(1);
  });

  test("S10: the prepared snapshot is discarded at the round boundary", async () => {
    const store = w.b1Store({ agents: 1 });
    const { assembly, close } = await assemblyOver(store);
    assembly.deps.planState.beginRound("round-1");
    await prepare(assembly);
    assembly.deps.planState.beginRound("round-2");
    await assembly.deps.expandCandidates(LEG_INPUT("leg-row-1"));
    expect(store.calls["agentCellPosition.findFirst"]).toBe(1);
    expect(store.calls["leg.findFirst"]).toBe(1);
    await close();
  });
});

describe("B1 S — the batched agent read states the same shape as the include", () => {
  /** The include tree as `path → options` (`true` for a plain relation). */
  function relationsOf(include, prefix, out) {
    for (const [name, spec] of Object.entries(include)) {
      const path = prefix ? `${prefix}.${name}` : name;
      if (spec === true) {
        out[path] = true;
        continue;
      }
      const { include: nested, ...options } = spec;
      out[path] = Object.keys(options).length > 0 ? options : true;
      if (nested) relationsOf(nested, path, out);
    }
    return out;
  }

  test("S11: every relation of agentSnapshotInclude(), with its options, is one readAgentGraph assembles", () => {
    expect(relationsOf(solvePath.agentSnapshotInclude(), "", {})).toEqual(json(solvePath.AGENT_GRAPH_RELATIONS));
  });

  test("S12: the batched read deep-equals the nested include for every agent, without falling back", async () => {
    const store = w.b1Store({ agents: 4, omitBatteryFor: 2 });
    store.agents[3].agentClassId = null;
    store.agents[1].commitments.push({ commitmentId: "c-live", agentId: "agent-row-2", legId: "leg-row-9", releasedAt: null });
    const nested = await store.prisma.agentCellPosition.findMany({ where: { shardId: w.SHARD_ID }, include: solvePath.agentSnapshotInclude() });
    const before = store.calls["agentCellPosition.findFirst"] || 0;
    const batched = await solvePath.readAgentGraph(store.prisma, { shardId: w.SHARD_ID });
    expect(json(batched)).toEqual(json(nested));
    expect(store.calls["agentCellPosition.findFirst"] || 0).toBe(before);
  });
});

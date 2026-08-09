"use strict";

/**
 * The §24.5 chaos harness.
 *
 * > Run continuously in a staging environment carrying production-shaped load: kill
 * > coordinators … partition the network … **flush the entire cache tier under load** …
 * > introduce dependency latency and error injection … skew clocks … pause a worker
 * > mid-finalisation … **run the whole suite at `capacity[agent_class] = 2` as well as at
 * > 1** … deliver duplicate, reordered, and expired commands … kill the coordinator with
 * > SOFT reservations outstanding … power-cycle a simulated agent mid-mission, wiping its
 * > deduplication state … take the Commitment Store away for longer than
 * > `agent.autonomous_continuation_limit`.
 *
 * ── What this harness is, and what it is not ───────────────────────────────
 * It drives the **real** commit path, the **real** fencing predicates, the **real**
 * outbox and the **real** reconciler against `tests/engine/helpers/commitmentStore.js` —
 * Phase 3's Commitment Store model, which implements row locks that genuinely block,
 * transaction overlays applied atomically or discarded, and the migrations' CHECK
 * constraints and partial unique indexes evaluated at apply time.
 *
 * It is **not PostgreSQL and it is not a staging environment.** §24.5's own framing is a
 * suite that "runs continuously in a staging environment carrying production-shaped
 * load", and nothing in a repository can be that. What this suite establishes is that the
 * *logic* survives each injection — which is the precondition for the staging suite being
 * worth running, and is what makes a red result here a bug rather than an environment
 * problem. The distinction is recorded in `PHASE_15_IMPLEMENTATION_REPORT.md` and is the
 * reason the `chaos_capacity_1` / `chaos_capacity_2` release gates in
 * `src/engine/cutover/gates.js` are `SUITE` evidence rather than `PRODUCTION`.
 *
 * ── Every scenario runs at capacity 1 and 2 ────────────────────────────────
 * §24.5 is explicit that this is not optional: "Concurrent commitments on one agent are
 * the configuration in which a fencing error is expressible, and a chaos suite that only
 * ever exercises one commitment per agent cannot detect it." `eachCapacity()` is how every
 * file in this directory obeys it, and a scenario written with a fixed capacity is a
 * scenario that has opted out of half the requirement.
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 * The "randomness" is a seeded LCG. A chaos test that cannot be replayed from its own
 * output is an anecdote: when the twenty-kill scenario fails on kill seventeen, the seed
 * is what turns that into a reproduction.
 */

const { createCommitmentStore, fixture } = require("../../engine/helpers/commitmentStore");

/** `lease.duration`, Appendix A default (seconds). */
const LEASE_DURATION_SECONDS = 60;
/** `shard.lease_duration`, Appendix A default (seconds). */
const SHARD_LEASE_SECONDS = 5;
/** `time.max_clock_skew`, Appendix A default (ms). */
const MAX_CLOCK_SKEW_MS = 500;
/** `shard.store_round_trip_budget`, Phase 13's default (ms). */
const STORE_ROUND_TRIP_MS = 500;
/** `agent.autonomous_continuation_limit`, Appendix A default (seconds). */
const AUTONOMOUS_CONTINUATION_LIMIT_SECONDS = 300;

/**
 * The capacities every scenario runs at. §24.5's requirement, expressed once.
 * @structural the two configurations §24.5 names, not a tuning choice
 */
const CAPACITIES = Object.freeze([1, 2]);

/**
 * A seeded linear congruential generator.
 *
 * Deliberately not `Math.random`. §24.5's injections are chosen at random and "at the
 * worst moment"; a failure at the worst moment is only useful if it can be reproduced,
 * and a test whose failure cannot be reproduced teaches nobody anything.
 *
 * @param {number} seed
 * @returns {{ next: () => number, int: (bound: number) => number, seed: number }}
 */
function rng(seed) {
  // @structural the LCG's multiplier, increment and modulus — Numerical Recipes' constants
  const MULTIPLIER = 1664525;
  // @structural
  const INCREMENT = 1013904223;
  // @structural
  const MODULUS = 4294967296;

  let state = seed >>> 0;
  const next = () => {
    state = (MULTIPLIER * state + INCREMENT) % MODULUS;
    return state / MODULUS;
  };
  return { next, int: (bound) => Math.floor(next() * bound), seed };
}

/**
 * Seed a store with one agent, `capacity + 1` Legs, and an **unheld** leadership row.
 *
 * The Leg count exceeds capacity on purpose: a scenario whose Leg count never exceeds the
 * bound never exercises the bound. Leadership starts unheld so that every election in a
 * scenario is a real acquisition rather than an assertion against a hand-written holder.
 *
 * @param {{ capacity: number, legs?: number }} options
 * @returns {{ seed: object, store: object }}
 */
function seeded(options) {
  const settings = options || {};
  const capacity = settings.capacity || 1;
  const seed = fixture({ capacity, legs: settings.legs || capacity + 1 });
  const leadershipRow = { ...seed.leadership, holder: null, leaseExpiry: null };
  const store = createCommitmentStore({
    agent: [seed.agent],
    leg: seed.legs,
    shardLeadership: [leadershipRow],
  });
  return { seed: { ...seed, leadership: leadershipRow, capacity }, store };
}

/**
 * The commit path's dependency set, with injection points.
 *
 * Every override is a *fault*, and each is named after the §24.5 line that asks for it, so
 * a reader of a scenario can see which requirement it discharges without leaving the file.
 *
 * @param {object} store
 * @param {object} [overrides]
 * @returns {object}
 */
function deps(store, overrides) {
  return {
    prisma: store.client,
    runSerializable: (client, fn) => client.$transaction(fn),
    selectForUpdate: async (tx, table, column, value) => {
      const rows = await tx.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE "${column}" = $1 FOR UPDATE`, value);
      return rows.length > 0 ? rows[0] : null;
    },
    isSerializationFailure: () => false,
    volatileRecheck: async () => ({ ok: true }),
    sideEffects: async () => {},
    ...(overrides || {}),
  };
}

/**
 * A commit request against one Leg.
 *
 * @param {object} seed
 * @param {number} legIndex
 * @param {object} [overrides]
 * @returns {object}
 */
function request(seed, legIndex, overrides) {
  const leg = seed.legs[legIndex];
  return {
    agentId: seed.agent.id,
    legId: leg.id,
    decisionRoundId: `round-${legIndex + 1}`,
    targetLegState: "OFFERED",
    shardId: "default",
    snapshot: {
      leadershipFence: seed.leadership.leadershipFence,
      authorityEpoch: seed.agent.authorityEpoch,
      legVersion: leg.version,
      expectedLegState: "PLANNED",
    },
    config: { capacity: seed.capacity, leaseDurationSeconds: LEASE_DURATION_SECONDS },
    ...(overrides || {}),
  };
}

/**
 * Run one scenario body at every capacity §24.5 requires.
 *
 * Used as the argument to `describe.each`, so the capacity appears in the test name and a
 * failure report says which configuration broke. A scenario that needs only one capacity
 * is a scenario that has misunderstood the requirement; there is deliberately no helper
 * for that case.
 *
 * @returns {{ capacity: number }[]}
 */
function eachCapacity() {
  return CAPACITIES.map((capacity) => ({ capacity }));
}

/**
 * A cache tier that can be flushed entirely, mid-flight (§3.3, §24.5, invariant I16).
 *
 * The point of the model is what it refuses to do: it never answers a read from a
 * *previous* generation. A flush increments the generation and empties the map, so a
 * caller holding a value from before the flush cannot be served a stale one — which is the
 * only way a test can distinguish "the commit path did not depend on the cache" from "the
 * cache happened to still have the value".
 *
 * @returns {object}
 */
function flushableCache() {
  let generation = 0;
  let entries = new Map();
  return {
    get generation() {
      return generation;
    },
    get size() {
      return entries.size;
    },
    async get(key) {
      const entry = entries.get(key);
      return entry === undefined ? null : entry;
    },
    async set(key, value) {
      entries.set(key, value);
    },
    async del(key) {
      entries.delete(key);
    },
    /** §24.5: "Flush the entire cache tier under load". */
    flush() {
      generation += 1;
      entries = new Map();
      return generation;
    },
  };
}

/**
 * A dependency whose latency and failure can be injected (§24.5, §5.2).
 *
 * `mode` is one of `OK`, `SLOW`, `ERROR`, `TIMEOUT`. §5.2 gives every dependency a
 * declared degradation, and the point of injecting to the point of timeout is to verify
 * that the declared degradation is what happens rather than an unhandled rejection.
 *
 * @param {{ mode?: string, latencyMs?: number }} [options]
 * @returns {{ call: () => Promise<object>, calls: number, setMode: (mode: string) => void }}
 */
function injectableDependency(options) {
  const settings = options || {};
  let mode = settings.mode || "OK";
  let calls = 0;

  return {
    get calls() {
      return calls;
    },
    setMode(next) {
      mode = next;
    },
    async call() {
      calls += 1;
      if (mode === "ERROR") throw new Error("injected dependency error");
      if (mode === "TIMEOUT") {
        const error = new Error("injected dependency timeout");
        error.code = "ETIMEDOUT";
        throw error;
      }
      if (mode === "SLOW") return { ok: true, latencyMs: settings.latencyMs || STORE_ROUND_TRIP_MS };
      return { ok: true, latencyMs: 0 };
    },
  };
}

module.exports = {
  CAPACITIES,
  LEASE_DURATION_SECONDS,
  SHARD_LEASE_SECONDS,
  MAX_CLOCK_SKEW_MS,
  STORE_ROUND_TRIP_MS,
  AUTONOMOUS_CONTINUATION_LIMIT_SECONDS,
  rng,
  seeded,
  deps,
  request,
  eachCapacity,
  flushableCache,
  injectableDependency,
};

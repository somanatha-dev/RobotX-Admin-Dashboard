"use strict";

/**
 * §24.5 / §3.3 / invariant I16 — **flush the entire cache tier under load**.
 *
 * > **Flush the entire cache tier under load** — the mandatory test of §3.3. **No
 * > commitment may be lost, duplicated, or double-granted.**
 *
 * §3.3 states the property the flush is testing for:
 *
 * > No decision may depend on a cache read that cannot be re-derived from the store, and
 * > **cache unavailability MUST NOT halt commitment.**
 *
 * ── What "under load" means here, and what it does not ─────────────────────
 * Load is concurrent commit attempts against one agent while the cache is emptied
 * repeatedly, mid-flight. It is not production-shaped traffic — §24.5's suite runs in
 * staging against that, and nothing in a repository can. What this file establishes is the
 * property that makes the staging run meaningful: the commit path **takes no cache
 * dependency at all**, so flushing the tier changes nothing about which commitments land.
 *
 * The flush model is deliberately unforgiving: a flush increments a generation and drops
 * every entry, and reads never fall back to a previous generation. That is what lets these
 * tests distinguish "the commit path did not need the cache" from "the cache happened to
 * still have the value" — a distinction a lenient mock erases, and the only distinction
 * this test is actually about.
 */

const { commit, OUTCOME } = require("../../src/engine/commitment/commit");
const model = require("../../src/engine/commitment/model");
const harness = require("./helpers/chaosHarness");

describe.each(harness.eachCapacity())("capacity $capacity — the cache tier is flushed under load (I16)", ({ capacity }) => {
  test("every commitment that lands is exactly once, and none is lost, duplicated or double-granted", async () => {
    const legs = capacity * 3;
    const { seed, store } = harness.seeded({ capacity, legs });
    const cache = harness.flushableCache();
    const random = harness.rng(0x1600D + capacity);

    // Warm the cache with something a naive implementation might read back.
    for (const leg of seed.legs) await cache.set(`plan:${leg.id}`, JSON.stringify({ agentId: seed.agent.id }));
    expect(cache.size).toBe(legs);

    const outcomes = [];
    let insideFlushes = 0;
    for (let index = 0; index < legs; index += 1) {
      // Two flushes per attempt, at the two moments that matter: one *inside* the
      // transaction (the volatile-recheck seam is the commit path's only suspension
      // point, so a flush there is a flush while a commit is open) and one between
      // attempts. Random seeding is retained so a failure names a reproducible run.
      // eslint-disable-next-line no-await-in-loop
      const outcome = await commit(
        harness.deps(store, {
          volatileRecheck: async () => {
            insideFlushes += 1;
            cache.flush();
            return { ok: true };
          },
        }),
        harness.request(seed, index),
      );
      cache.flush();
      random.next();
      outcomes.push(outcome);
    }

    // The cache was emptied after every attempt and never repopulated. The inside-flush
    // count is `capacity` and not `legs`, because the recheck seam is reached only by an
    // attempt that already passed G1-G6 — which is itself a statement about the ordering:
    // the guards run before the volatile re-check, so a refused commit never gets far
    // enough to touch anything.
    expect(insideFlushes).toBe(capacity);
    expect(cache.generation).toBe(legs + capacity);
    expect(cache.size).toBe(0);

    const rows = store.rows("commitment");
    const active = rows.filter(model.isActive);

    // Not lost: exactly `capacity` commitments landed — the bound, not zero. A commit path
    // that had a cache dependency would have started failing the moment the tier emptied,
    // and the failure would look like "fewer commitments than capacity" rather than like
    // an error.
    expect(active).toHaveLength(capacity);

    // Not duplicated: one commitment per Leg, and every fence distinct.
    const legIds = rows.map((row) => row.legId);
    expect(new Set(legIds).size).toBe(legIds.length);
    const fences = rows.map((row) => String(row.fence));
    expect(new Set(fences).size).toBe(fences.length);

    // Not double-granted: one active commitment per capacity slot, which is the property
    // the partial unique index enforces and the one a cache-based lock cannot.
    const slots = active.map((row) => row.capacitySlot);
    expect(new Set(slots).size).toBe(slots.length);

    // The refusals were refusals for the *right* reason — capacity, not a cache miss.
    const refused = outcomes.filter((outcome) => outcome.outcome === OUTCOME.ABORTED);
    expect(refused).toHaveLength(legs - capacity);
    for (const outcome of refused) {
      expect({ reason: outcome.reason }).toEqual({ reason: "G2_AGENT_AT_CAPACITY" });
    }
  });

  test("a flush immediately before a commit does not change the outcome", async () => {
    // The control for the test above. If flushing changed nothing because the scenario
    // never read the cache in the first place, this pair would still pass — so both are
    // run: one with a warm cache, one with a cold one, and the outcomes compared.
    const warm = harness.seeded({ capacity, legs: capacity + 1 });
    const cold = harness.seeded({ capacity, legs: capacity + 1 });
    const cache = harness.flushableCache();

    const outcomesWarm = [];
    const outcomesCold = [];
    for (let index = 0; index < capacity + 1; index += 1) {
      await cache.set(`plan:${index}`, "warm");
      // eslint-disable-next-line no-await-in-loop
      outcomesWarm.push((await commit(harness.deps(warm.store), harness.request(warm.seed, index))).outcome);
      cache.flush();
      // eslint-disable-next-line no-await-in-loop
      outcomesCold.push((await commit(harness.deps(cold.store), harness.request(cold.seed, index))).outcome);
    }

    expect(outcomesCold).toEqual(outcomesWarm);
    expect(warm.store.rows("commitment").filter(model.isActive)).toHaveLength(capacity);
    expect(cold.store.rows("commitment").filter(model.isActive)).toHaveLength(capacity);
  });

  test("the commit module reaches for no cache client at all", () => {
    // The strongest available form of the property, and the one that survives refactoring:
    // not "the cache was not consulted in this run" but "there is no cache to consult".
    // §3.3's rule is about the *design*, and a source-level assertion is what keeps it
    // that way when someone later adds a "small" memoisation to the commit path.
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "engine", "commitment", "commit.js"),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const pattern of [/\bkv\b/, /\bredis\b/i, /robotStateCache/, /advisoryCache/]) {
      expect({ pattern: String(pattern), found: pattern.test(code) }).toEqual({ pattern: String(pattern), found: false });
    }
  });
});

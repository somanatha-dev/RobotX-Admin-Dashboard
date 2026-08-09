"use strict";

/**
 * Per-cell-cluster candidate sharing (§6.5). **Tier 1.**
 *
 * > Where a batch contains many Legs in the same neighbourhood, candidate sets are
 * > computed once per **cell cluster** and shared across those Legs, so the routing
 * > matrix is built once for the union. This is the dominant performance
 * > optimisation in dense bursts (§20.4).
 *
 * Two independent pieces, kept separate because they answer different questions:
 *
 *   1. **`clusterLegs()`** — which Legs, in one batch, are "in the same
 *      neighbourhood"? Answered by coarse-cell membership: two Legs whose origin
 *      falls in the same coarse cell (§3.6's ~5–10 km regional-sweep unit) share a
 *      cluster. This is a cheap, deterministic partition rather than a clustering
 *      algorithm — the coarse cell already exists as the tier-4 sweep unit, so
 *      reusing it here introduces no second spatial primitive.
 *   2. **`sharedIndexReader()`** — a `{ kv }`-shaped object whose `smembers` memoises
 *      by key for its own lifetime. `candidates/expansion.js` takes `kv` as an
 *      injected dependency and performs no caching of its own (§6's L4 modules stay
 *      pure per call); this is what lets a caller run `expansion.expandCandidates()`
 *      once per Leg in a cluster while the underlying Availability Index reads for
 *      cells the cluster's Legs have in common happen only once. It memoises reads
 *      only — `sadd`/`srem` pass straight through, so an index write mid-round (a
 *      genuine agent state change) is never masked by a stale cached read for a key
 *      no one re-reads until the next round.
 *
 * Nothing here decides *how many* Legs form one cluster's routing-matrix union
 * (that is the routing client's batching concern, Phase 9's B1 dependency) —
 * this module only removes the redundant Availability Index reads, which is the
 * part squarely inside Phase 9's boundary.
 */

const cells = require("../spatial/cells");
const { compareStrings, canonicalSort } = require("../determinism/ordering");

/**
 * Partition a batch of pending Legs into clusters by their origin coarse cell.
 *
 * @param {Array<{ legId: string, originLat: number, originLon: number }>} legs
 * @returns {{ clusters: Array<{ coarseCellId: string, legIds: string[] }>,
 *             legToCoarseCellId: Record<string, string> }}
 */
function clusterLegs(legs) {
  const byCoarseCell = new Map();
  const legToCoarseCellId = {};

  for (const leg of legs || []) {
    if (!leg || typeof leg.legId !== "string") continue;
    const fineCellId = cells.cellForPoint(leg.originLat, leg.originLon, cells.RESOLUTION.FINE);
    const coarseCellId = cells.coarseParentOf(fineCellId);

    legToCoarseCellId[leg.legId] = coarseCellId;
    const bucket = byCoarseCell.get(coarseCellId) || [];
    bucket.push(leg.legId);
    byCoarseCell.set(coarseCellId, bucket);
  }

  const clusters = canonicalSort(
    [...byCoarseCell.entries()].map(([coarseCellId, legIds]) => ({
      coarseCellId,
      legIds: [...legIds].sort(compareStrings),
    })),
    (a, b) => compareStrings(a.coarseCellId, b.coarseCellId),
  );

  return { clusters, legToCoarseCellId };
}

/**
 * Wrap a `kv` client so that `smembers` reads are memoised by key for the returned
 * object's lifetime — intended to be constructed once per round (or once per
 * cluster) and passed to every `expansion.expandCandidates()` call that follows.
 *
 * @param {object} kv the underlying `{ get, set, sadd, srem, smembers, ... }` client
 * @returns {object} a same-shaped client with a memoising `smembers`
 */
function sharedIndexReader(kv) {
  if (!kv || typeof kv.smembers !== "function") {
    throw new TypeError("sharedIndexReader requires a kv client exposing smembers()");
  }

  const cache = new Map(); // key -> Promise<string[]>

  return Object.freeze({
    ...kv,
    smembers(key) {
      const cacheKey = String(key);
      let pending = cache.get(cacheKey);
      if (!pending) {
        pending = Promise.resolve(kv.smembers(key));
        cache.set(cacheKey, pending);
      }
      return pending;
    },
    /**
     * Not part of the `kv` contract — a diagnostic for tests and SLIs that want to
     * confirm reuse actually happened, per §6.5's own performance claim.
     */
    sharedReadCount() {
      return cache.size;
    },
  });
}

module.exports = {
  clusterLegs,
  sharedIndexReader,
};

"use strict";

/**
 * The charger-reachability precompute (§20.3 item 3).
 *
 * The plan names it in one line — *"Charger-reachability precomputation on each
 * projection publication"* — and both halves of that line are load-bearing.
 *
 * **"Precomputation"**, because §20.3 identifies the return-leg query population as the
 * one that does not benefit from the approach-query cache:
 *
 * > approach queries are anchored on mission origins, which cluster heavily around
 * > restaurants, depots, and pickup points, whereas projected mission-end positions are
 * > mission-specific and spread across the whole delivery surface.
 *
 * > Entries are precomputed for every populated cell in the region on projection
 * > publication, so the steady-state path is a lookup rather than a query.
 *
 * **"On each projection publication"**, because the cache key carries
 * `charger_availability_version`. A new projection does not invalidate the old entries —
 * it makes them unreachable, since no round will ever build a key naming a superseded
 * version again. That is deliberate: an entry computed against one projection is never
 * silently applied under another, and expiry rather than invalidation is what makes
 * that guarantee hold without a delete sweep that could partially fail.
 *
 * ── What this worker is not ────────────────────────────────────────────────
 * It is **not** a scheduler tick. There is no interval: the trigger is a publication,
 * and running it on a timer would recompute entries against a projection nothing has
 * asked for while leaving a freshly published one cold for up to one interval.
 *
 * ── The routing seam ───────────────────────────────────────────────────────
 * The routing engine's selection is blocking decision **B1** and is still open. This
 * worker therefore takes `route(cellId, profileKey, timeBucket)` as an injected
 * dependency and knows nothing else about it — the seam §6.2 names as the mitigation
 * for B1 slipping: "the cell-pair cache interface can be developed against a stub".
 *
 * ── Built, tested, and not started ─────────────────────────────────────────
 * Nothing in `server.js` calls `onProjectionPublished()`. Phase 15 owns production
 * scheduling, which is the disposition Phases 4, 5, and 6 gave their own workers.
 *
 * Tier 1 by path (`src/workers/` default). Its output is Tier 0's input.
 */

const cache = require("../engine/routing/chargerReachabilityCache");
const schedulerClient = require("../engine/energy/chargingSchedulerClient");

/**
 * How long a precomputed entry lives.
 *
 * Entries are keyed by projection version, so a stale entry is unreachable rather than
 * wrong, and the TTL is purely a storage-reclamation control: it evicts the entries of
 * superseded projections that no round will ever key into again.
 * @structural the cache's storage-reclamation window, not a behavioural threshold
 */
const ENTRY_TTL_SECONDS = 7_200;

/**
 * Run the precompute for one newly published projection.
 *
 * @param {object} deps `{ kv, route, prisma, onError }`
 * @param {object} input
 * @param {object} input.projection the raw projection as the Scheduler published it
 * @param {string[]} input.cellIds every populated cell in the region
 * @param {Array<{profileKey: string, energyWhPerMetre: number, speedMetresPerSecond: number}>} input.profiles
 * @param {string|number} input.timeBucket
 * @param {number} input.k `route.charger_reachability_k`
 * @param {number} input.intraCellOffsetM `route.intra_cell_offset_m`
 * @returns {Promise<{ ok: boolean, projectionVersion: *|null, written: number,
 *                     failed: number, problems: string[] }>}
 */
async function onProjectionPublished(deps, input) {
  const source = input || {};

  // The projection is validated at the boundary before anything is computed against it.
  // A projection with no version cannot key an entry, and an entry that cannot name its
  // projection is one §20.3 forbids reusing at all — so the failure belongs here, once,
  // rather than at every cell.
  const consumed = schedulerClient.consumeProjection(source.projection);
  if (!consumed.ok) {
    return { ok: false, projectionVersion: null, written: 0, failed: 0, problems: consumed.problems };
  }

  const mirrored = await mirrorProjection(deps, consumed.projection);

  const result = await cache.precompute(deps, {
    projectionVersion: consumed.projection.version,
    cellIds: source.cellIds || [],
    profiles: source.profiles || [],
    timeBucket: source.timeBucket,
    k: source.k,
    intraCellOffsetM: source.intraCellOffsetM,
    ttlSeconds: source.ttlSeconds || ENTRY_TTL_SECONDS,
  });

  return {
    ok: result.failed === 0 && result.problems.length === 0,
    projectionVersion: consumed.projection.version,
    written: result.written,
    failed: result.failed,
    mirrored,
    problems: result.problems,
  };
}

/**
 * Mirror the pinned projection at `engine:charger:proj:{version}`.
 *
 * The mirror is a **cache**, not the authority: `ChargerAvailabilityProjection` is the
 * durable, immutable row, and a round that cannot read the mirror falls back to the
 * database. §3.3's cache-authority rule admits no other arrangement, and the mirror
 * exists only so that every worker in a shard reads a version once rather than once per
 * round.
 *
 * @param {object} deps `{ kv }`
 * @param {object} projection a validated projection
 * @returns {Promise<boolean>}
 */
async function mirrorProjection(deps, projection) {
  if (!deps || !deps.kv || typeof deps.kv.set !== "function") return false;
  try {
    await deps.kv.set(cache.projectionKey(projection.version), JSON.stringify(projection), { ex: ENTRY_TTL_SECONDS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist a published projection as the immutable row a round pins against.
 *
 * Insert-only. A projection that could be updated after a round consumed it would make
 * that round unreplayable, and the uniqueness of `version` is what makes the pin mean
 * anything. A duplicate version is reported rather than merged: two different payloads
 * under one version is a Scheduler defect, and silently keeping either one would make
 * two rounds claiming the same pin disagree.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input
 * @returns {Promise<{ ok: boolean, created: boolean, reason: string|null }>}
 */
async function persistProjection(deps, input) {
  const prisma = deps && deps.prisma;
  if (!prisma) return { ok: false, created: false, reason: "no prisma client supplied" };

  const consumed = schedulerClient.consumeProjection(input && input.projection);
  if (!consumed.ok) return { ok: false, created: false, reason: consumed.problems.join("; ") };

  const existing = await prisma.chargerAvailabilityProjection.findUnique({
    where: { version: Number(consumed.projection.version) },
  });
  if (existing) {
    return {
      ok: true,
      created: false,
      reason: `version ${consumed.projection.version} is already published; the projection is immutable (§14.5)`,
    };
  }

  await prisma.chargerAvailabilityProjection.create({
    data: {
      version: Number(consumed.projection.version),
      publishedAt: new Date(consumed.projection.publishedAtMs),
      publishedBy: (input && input.publishedBy) || null,
      horizonEnd: consumed.projection.horizonEndMs ? new Date(consumed.projection.horizonEndMs) : null,
      regionId: (input && input.regionId) || null,
      payload: input.projection,
    },
  });

  return { ok: true, created: true, reason: null };
}

module.exports = {
  ENTRY_TTL_SECONDS,
  onProjectionPublished,
  mirrorProjection,
  persistProjection,
};

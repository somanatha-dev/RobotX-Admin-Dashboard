"use strict";

/**
 * The charger-reachability cache (§20.3 item 3) — **Tier 0**.
 *
 * > **There are two per-candidate routing populations, not one**, and the second is as
 * > large as the first … **Return-leg queries** from each candidate's *projected
 * > mission-end position* to a candidate charger, required to evaluate `E_return` for
 * > F34/F35 (§14.5).
 *
 * > The second population is easy to overlook because it is implied by a feasibility
 * > constraint rather than requested by the cost model, and it does not benefit from the
 * > first population's caching: approach queries are anchored on mission origins, which
 * > cluster heavily around restaurants, depots, and pickup points, whereas projected
 * > mission-end positions are mission-specific and spread across the whole delivery
 * > surface.
 *
 * ── The key, and the one field in it that is load-bearing ──────────────────
 * > keyed `(destination_cell, mobility_profile, time_bucket, charger_availability_version)`
 * > and yielding the nearest `k` chargers with travel time and energy, ordered.
 *
 * > Including `charger_availability_version` in the key is what makes the entry safe to
 * > reuse: an entry computed against one availability projection is never silently
 * > applied under another, which preserves both the reserve's meaning and replay
 * > determinism (§14.5, §9.6).
 *
 * `key()` refuses to build a key without the projection version rather than defaulting
 * one, and `assertVersionInKey()` is available to a caller that wants the property
 * checked rather than trusted. This is the same discipline F35 applies at the gate: a
 * reachability verdict that cannot name its projection cannot be replayed.
 *
 * ── The cell quantisation and its correction ───────────────────────────────
 * > The key is the *destination cell*, not the exact mission-end point, so it reuses the
 * > same cell-quantisation trick as item 2 with an intra-cell offset correction.
 *
 * The correction is applied **pessimistically**: `route.intra_cell_offset_m` is added to
 * the cached distance, never subtracted. A reserve computed from an optimistic
 * cell-centre distance is a reserve that does not cover the walk from the cell edge, and
 * the whole point of `E_return` is that it holds at the bad end of its uncertainty.
 *
 * ── Hit rate is an SLI, not a statistic ────────────────────────────────────
 * > Target cache hit rates in steady state: > 95 % for the cell-pair cache and > 90 %
 * > for the charger-reachability cache. Both are reported separately and both are
 * > alertable, because a sustained drop in either translates directly into round-time
 * > growth, and a drop confined to one of them has a different cause and a different
 * > fix.
 *
 * `Counters` accumulates hits and misses so the round can emit them; the threshold is
 * `route.charger_reachability_min_hit_rate`.
 *
 * Tier 0 by module path (`tierAssertions.js` names this file explicitly, because
 * `src/engine/routing/` otherwise defaults to Tier 1 and this entry is what F35 reads).
 * Decision path (T6): no clock, no randomness, no store — the kv client is injected.
 */

/** @structural the plan's own key prefix */
// PHASE 15 — the entry's charger order is part of what §9.6 replays, so its tie-break is the
// engine's own host-independent comparison rather than `localeCompare`. See `buildEntry`.
const { compareStrings } = require("../determinism/ordering");

const KEY_PREFIX = "engine:charger:reach";

/** @structural the plan's own projection-mirror key prefix */
const PROJECTION_KEY_PREFIX = "engine:charger:proj";

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Build the cache key. Every component is required.
 *
 * @param {object} parts
 * @param {string} parts.cellId destination cell
 * @param {string} parts.profileKey mobility profile
 * @param {string|number} parts.timeBucket
 * @param {string|number} parts.projectionVersion `charger_availability_version`
 * @returns {{ ok: boolean, key: string|null, reason: string|null }}
 */
function key(parts) {
  const source = parts || {};
  const missing = ["cellId", "profileKey", "timeBucket", "projectionVersion"].filter(
    (name) => source[name] === undefined || source[name] === null || source[name] === "",
  );

  if (missing.length > 0) {
    return {
      ok: false,
      key: null,
      reason:
        `the charger-reachability key is missing ${missing.join(", ")}. §20.3 item 3 keys the entry on ` +
        "(destination_cell, mobility_profile, time_bucket, charger_availability_version); an entry computed " +
        "against one projection must never be silently applied under another",
    };
  }

  return {
    ok: true,
    key: `${KEY_PREFIX}:${source.cellId}:${source.profileKey}:${source.timeBucket}:${source.projectionVersion}`,
    reason: null,
  };
}

/** The pinned projection's own mirror key. @param {string|number} version @returns {string} */
function projectionKey(version) {
  return `${PROJECTION_KEY_PREFIX}:${version}`;
}

/**
 * Check that a key names the projection an entry is about to be used under.
 *
 * Offered as an assertion because the failure is silent: an entry read under the wrong
 * version answers plausibly and wrongly, and the wrongness only surfaces as a stranded
 * agent.
 *
 * @param {string} cacheKey
 * @param {string|number} projectionVersion
 * @returns {{ ok: boolean, reason: string|null }}
 */
function assertVersionInKey(cacheKey, projectionVersion) {
  if (typeof cacheKey !== "string" || cacheKey === "") return { ok: false, reason: "no cache key supplied" };
  if (projectionVersion === undefined || projectionVersion === null) return { ok: false, reason: "no projection version supplied" };
  const suffix = `:${projectionVersion}`;
  if (!cacheKey.startsWith(`${KEY_PREFIX}:`) || !cacheKey.endsWith(suffix)) {
    return {
      ok: false,
      reason:
        `key "${cacheKey}" does not name charger availability version ${String(projectionVersion)}. Reusing an ` +
        "entry across projections destroys both the reserve's meaning and replay determinism (§20.3, §9.6)",
    };
  }
  return { ok: true, reason: null };
}

/**
 * The nearest-k entry, with the intra-cell offset already applied.
 *
 * @param {object} input
 * @param {Array<object>} input.chargers routing results, nearest first
 * @param {number} input.k `route.charger_reachability_k`
 * @param {number} input.intraCellOffsetM `route.intra_cell_offset_m`
 * @param {number} input.energyWhPerMetre the profile's marginal return-leg consumption
 * @param {number} input.speedMetresPerSecond the profile's return-leg speed
 * @param {string|number} input.projectionVersion
 * @returns {{ ok: boolean, entry: object|null, problems: string[] }}
 */
function buildEntry(input) {
  const source = input || {};
  const problems = [];

  if (!Array.isArray(source.chargers)) problems.push("no charger routing results supplied");
  if (!Number.isInteger(source.k) || source.k < 1) problems.push("route.charger_reachability_k is unresolved");
  if (!isNumber(source.intraCellOffsetM) || source.intraCellOffsetM < 0) problems.push("route.intra_cell_offset_m is unresolved");
  if (!isNumber(source.energyWhPerMetre) || source.energyWhPerMetre <= 0) problems.push("the profile's return-leg Wh per metre is unresolved");
  if (!isNumber(source.speedMetresPerSecond) || source.speedMetresPerSecond <= 0) problems.push("the profile's return-leg speed is unresolved");
  if (source.projectionVersion === undefined || source.projectionVersion === null) problems.push("the projection version is unresolved");

  if (problems.length > 0) return { ok: false, entry: null, problems };

  const chargers = source.chargers
    .filter((charger) => charger && typeof charger.chargerId === "string" && isNumber(charger.distanceM) && isNumber(charger.travelSeconds))
    .map((charger) => {
      // Pessimistic in both dimensions: the offset lengthens the route and the extra
      // route takes time. Applying it to distance alone would leave an arrival time
      // that the projection's availability window is then checked against too early.
      const distanceM = charger.distanceM + source.intraCellOffsetM;
      const travelSeconds = charger.travelSeconds + source.intraCellOffsetM / source.speedMetresPerSecond;
      return Object.freeze({
        chargerId: charger.chargerId,
        chargerClass: charger.chargerClass ?? null,
        isDepot: charger.isDepot === true,
        distanceM,
        travelSeconds,
        energyWh: distanceM * source.energyWhPerMetre,
        intraCellOffsetM: source.intraCellOffsetM,
      });
    })
    // `compareStrings`, not `localeCompare`: this sort decides which chargers survive the
    // `slice(0, k)` below, so two hosts with different ICU collation could truncate a tie
    // differently and produce two different entries under one cache key — a §9.6 replay defect
    // that would surface only as an unexplained diff. `determinism/ordering`'s header states
    // the rule; this call site is now one of the places that follows it.
    .sort((a, b) => a.distanceM - b.distanceM || compareStrings(a.chargerId, b.chargerId))
    .slice(0, source.k);

  return {
    ok: true,
    entry: Object.freeze({
      projectionVersion: source.projectionVersion,
      profileKey: source.profileKey ?? null,
      cellId: source.cellId ?? null,
      timeBucket: source.timeBucket ?? null,
      k: source.k,
      // `truncated` is what tells `eReturn.js` that "no admissible charger in the
      // entry" might mean "none within k" rather than "none at all". k bounds the entry
      // size, not the constraint (§20.3 item 3).
      truncated: source.chargers.length > source.k,
      chargers: Object.freeze(chargers),
    }),
    problems: [],
  };
}

/**
 * Read an entry. A cache failure is a miss, never an answer (§3.3, invariant I16).
 *
 * @param {object} deps `{ kv }`
 * @param {object} parts the key components
 * @returns {Promise<{ hit: boolean, entry: object|null, key: string|null, reason: string }>}
 */
async function read(deps, parts) {
  const built = key(parts);
  if (!built.ok) return { hit: false, entry: null, key: null, reason: built.reason };
  if (!deps || !deps.kv || typeof deps.kv.get !== "function") {
    return { hit: false, entry: null, key: built.key, reason: "no cache client supplied" };
  }

  let raw;
  try {
    raw = await deps.kv.get(built.key);
  } catch {
    return { hit: false, entry: null, key: built.key, reason: "cache read failed" };
  }
  if (raw === null || raw === undefined) return { hit: false, entry: null, key: built.key, reason: "miss" };

  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { hit: false, entry: null, key: built.key, reason: "cache entry is unreadable" };
  }

  // Belt and braces against a key built elsewhere: the entry states the version it was
  // computed under, and a mismatch is a miss rather than a plausible wrong answer.
  if (String(parsed.projectionVersion) !== String(parts.projectionVersion)) {
    return { hit: false, entry: null, key: built.key, reason: "the entry names a different charger availability version" };
  }

  return { hit: true, entry: parsed, key: built.key, reason: "hit" };
}

/**
 * Write an entry.
 *
 * @param {object} deps `{ kv }`
 * @param {object} parts
 * @param {object} entry
 * @param {number} [ttlSeconds]
 * @returns {Promise<boolean>}
 */
async function write(deps, parts, entry, ttlSeconds) {
  const built = key(parts);
  if (!built.ok) return false;
  if (!deps || !deps.kv || typeof deps.kv.set !== "function") return false;
  try {
    await deps.kv.set(built.key, JSON.stringify(entry), ttlSeconds ? { ex: ttlSeconds } : undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * Precompute entries for every populated cell on projection publication.
 *
 * > Entries are precomputed for every populated cell in the region on projection
 * > publication, so the steady-state path is a lookup rather than a query.
 *
 * The routing calls are injected as `route(cellId, profileKey)` so that this module
 * carries no dependency on the routing engine, whose selection is blocking decision B1
 * and is still open. The interface is the seam §6.2 recommends developing against a
 * stub, and it is the only thing this precompute needs from it.
 *
 * @param {object} deps `{ kv, route }`
 * @param {object} input
 * @returns {Promise<{ written: number, failed: number, problems: string[] }>}
 */
async function precompute(deps, input) {
  const source = input || {};
  const problems = [];
  let written = 0;
  let failed = 0;

  if (!deps || typeof deps.route !== "function") {
    return { written: 0, failed: 0, problems: ["no routing client supplied to the charger-reachability precompute"] };
  }
  if (source.projectionVersion === undefined || source.projectionVersion === null) {
    return { written: 0, failed: 0, problems: ["the precompute needs the projection version it is computing against (§20.3 item 3)"] };
  }

  for (const cellId of source.cellIds || []) {
    for (const profile of source.profiles || []) {
      let routed;
      try {
        routed = await deps.route(cellId, profile.profileKey, source.timeBucket);
      } catch (error) {
        failed += 1;
        problems.push(`routing failed for cell ${String(cellId)} profile ${String(profile.profileKey)}: ${error.message}`);
        continue;
      }

      const built = buildEntry({
        chargers: routed,
        k: source.k,
        intraCellOffsetM: source.intraCellOffsetM,
        energyWhPerMetre: profile.energyWhPerMetre,
        speedMetresPerSecond: profile.speedMetresPerSecond,
        projectionVersion: source.projectionVersion,
        profileKey: profile.profileKey,
        cellId,
        timeBucket: source.timeBucket,
      });

      if (!built.ok) {
        failed += 1;
        problems.push(...built.problems);
        continue;
      }

      const stored = await write(
        deps,
        { cellId, profileKey: profile.profileKey, timeBucket: source.timeBucket, projectionVersion: source.projectionVersion },
        built.entry,
        source.ttlSeconds,
      );
      if (stored) written += 1;
      else failed += 1;
    }
  }

  return { written, failed, problems };
}

/**
 * Hit-rate accounting for the §20.3 SLI.
 */
class Counters {
  constructor() {
    this.hits = 0;
    this.misses = 0;
  }

  /** @param {boolean} hit */
  record(hit) {
    if (hit) this.hits += 1;
    else this.misses += 1;
  }

  /** @returns {number|null} */
  hitRate() {
    const total = this.hits + this.misses;
    return total === 0 ? null : this.hits / total;
  }

  /**
   * @param {number} minimum `route.charger_reachability_min_hit_rate`
   * @returns {{ ok: boolean|null, hitRate: number|null, minimum: number|null }}
   */
  assessAgainst(minimum) {
    const rate = this.hitRate();
    if (rate === null || !isNumber(minimum)) return { ok: null, hitRate: rate, minimum: isNumber(minimum) ? minimum : null };
    return { ok: rate >= minimum, hitRate: rate, minimum };
  }
}

module.exports = {
  KEY_PREFIX,
  PROJECTION_KEY_PREFIX,
  key,
  projectionKey,
  assertVersionInKey,
  buildEntry,
  read,
  write,
  precompute,
  Counters,
};

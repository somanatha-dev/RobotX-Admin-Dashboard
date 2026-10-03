"use strict";

/**
 * The cell-pair travel-time cache (§20.3 item 2) — **Tier 1**, decision path input.
 *
 * > **Cell-pair travel-time cache** for approach and linehaul, keyed `(origin_cell,
 * > destination_cell, mobility_profile, time_bucket)`. **Within-cell error is bounded by
 * > the cell diameter and is corrected by an intra-cell offset term.** The cache is small
 * > relative to a point-pair cache; **its hit rate is a property of the declared spatial
 * > model and the deployment's traffic, and is measured against the target below rather
 * > than assumed from the cell size.**
 *
 * ── Why that sentence was amended, and what it costs this module (D3) ───────
 * §20.3 previously read *"Because cells are ~200–500 m, the cache is small … and its hit
 * rate is high"* — an **argument**, whose premise ADR-35 removed when FINE became H3
 * resolution 11 (≈49.6 m across). A conclusion left standing on a deleted premise is
 * worse than no claim, so RD-2026-09-14-01 D3 amended §20.3 rather than only §3.6.
 *
 * The consequence is measurable and is **not currently discharged**: at resolution 11 the
 * RNSIT cell-pair space grows from 9 to 2 025 — roughly **225×** — for the same traffic.
 * That is a *cost* statement, not a correctness one, and nothing in this module's logic
 * depends on it. But **§20.3's >95 % target may not be reported as met on the strength of
 * the old sentence**; it has to be measured. `tools/verify/spatialCacheHitRate.js` is that
 * measurement and `docs/spatial/` carries its result.
 *
 * The key is unchanged, and deliberately so. An H3 index encodes its own resolution, so a
 * pair keyed under the previous model can never be *hit* by a lookup under this one — the
 * tokens differ. Stale entries are orphans that expire, never wrong answers, which is why
 * a spatial cutover invalidates the key space rather than versioning the key.
 *
 * This is the first of §20.3's two routing populations — approach and linehaul queries,
 * anchored on mission origins that cluster heavily around restaurants, depots, and pickup
 * points. The second population, return-leg queries to chargers, has its own cache with its
 * own key and its own budget line (`routing/chargerReachabilityCache.js`, Tier 0), because
 * mission-end positions do not cluster and would poison this cache's hit rate.
 *
 * ── Why the correction is applied in one direction only ────────────────────
 * `route.intra_cell_offset_m` is **added** to the cached distance and to the derived travel
 * time, never subtracted. A quantised distance that is optimistic produces an ETA the plan
 * cannot meet and an energy estimate the reserve does not cover; one that is pessimistic
 * costs a little search quality. The asymmetry of those two outcomes is the whole argument,
 * and it is the same one `chargerReachabilityCache.js` makes about `E_return`.
 *
 * ── Hit rate is an SLI ─────────────────────────────────────────────────────
 * > Target cache hit rates in steady state: **> 95 %** for the cell-pair cache and > 90 %
 * > for the charger-reachability cache. Both are reported separately and both are
 * > alertable, because a sustained drop in either translates directly into round-time
 * > growth, and a drop confined to one of them has a different cause and a different fix.
 *
 * `Counters` accumulates hits and misses so a round can emit them against
 * `route.cell_pair_min_hit_rate`.
 *
 * ── The cache is never an authority ────────────────────────────────────────
 * A read error is a miss and a write failure is silent. A miss falls through to the
 * injected router, and a router failure is reported to the caller rather than answered with
 * a guess — §5.2 gives the Routing Service a hard timeout and a declared degradation
 * (cached matrices, then a geometric bound × detour factor with the mission radius reduced
 * to `route.degraded_max_radius`), and choosing among those is the round's decision, not
 * this module's.
 *
 * Determinism: no clock, no randomness. The time bucket arrives as an input, derived from
 * the round's pinned decision time, because a cache keyed on a locally-read clock would
 * return different entries to two workers in the same round.
 */

/** @structural the plan's own key prefix */
const KEY_PREFIX = "engine:route:cell";

/** The four key components §20.3 item 2 names. @structural §20.3's own key */
const KEY_FIELDS = Object.freeze(["originCell", "destCell", "profileKey", "timeBucket"]);

/**
 * The per-hop terrain §14.2's climb, regeneration and stop-start terms are evaluated over.
 * Carried on the entry; required by `plan/timeline.project`, not here — see `buildEntry`.
 * @structural the terrain fields of §14.2's equation, stated per traversal
 */
const TERRAIN_FIELDS = Object.freeze(["climbM", "descentM", "stopStartCycles"]);

/**
 * What the endpoints of a cached traversal were.
 *
 * `CELL_REPRESENTATIVE` is the §20.3 entry this cache was built for: the router answered
 * between the two cells' representative points, so the real endpoints are up to a cell away
 * and `route.intra_cell_offset_m` corrects for that. It is the default for every entry that
 * does not say otherwise.
 *
 * `EXACT_POINTS` is an entry whose router answered between the request's **exact**
 * coordinates (`originPoint` / `destPoint`). There is no quantisation left to correct, so the
 * offset is not added — adding it would price a distance nobody travels. It is honoured only
 * when the request itself carried both points, because the key is then point-specific; an
 * entry merely *claiming* exactness under a cell key is still corrected.
 *
 * @structural the vocabulary, not a tunable
 */
const ENDPOINT_BASIS = Object.freeze({
  CELL_REPRESENTATIVE: "CELL_REPRESENTATIVE",
  EXACT_POINTS: "EXACT_POINTS",
});

/**
 * Coordinates are keyed at 1e-7° (≈1 cm).
 * @structural decimal places of a WGS-84 coordinate in the key — a representation precision
 * (≈1 cm on the ground), not a behavioural tolerance
 */
const POINT_KEY_DECIMALS = 7;

/**
 * The fewest points a traversal's geometry can have: one point has no direction and is no
 * traversal at all (`VirtualRobot.isTraversablePath` applies the same floor).
 * @structural a polyline's minimum vertex count
 */
const MIN_PATH_POINTS = 2;

function isPoint(value) {
  return Boolean(value) && isNumber(value.lat) && isNumber(value.lon);
}

function pointToken(point) {
  return `${point.lat.toFixed(POINT_KEY_DECIMALS)},${point.lon.toFixed(POINT_KEY_DECIMALS)}`;
}

/** Whether a request names exact endpoints for both ends of the hop. */
function hasExactEndpoints(parts) {
  return Boolean(parts) && isPoint(parts.originPoint) && isPoint(parts.destPoint);
}

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
 * @returns {{ ok: boolean, key: string|null, reason: string|null }}
 */
function key(parts) {
  const source = parts || {};
  const missing = KEY_FIELDS.filter(
    (name) => source[name] === undefined || source[name] === null || source[name] === "",
  );

  if (missing.length > 0) {
    return {
      ok: false,
      key: null,
      reason:
        `the cell-pair key is missing ${missing.join(", ")}. §20.3 item 2 keys the entry on ` +
        "(origin_cell, destination_cell, mobility_profile, time_bucket); an entry computed under one " +
        "mobility profile or one congestion bucket must never be silently applied under another",
    };
  }

  // An exact-endpoint request is keyed on its points as well as its cells: two pickups in one
  // cell are two different traversals once the router answers between exact coordinates, and
  // a cell-only key would hand one of them the other's route. A cell-only request keys
  // exactly as before.
  const exact = hasExactEndpoints(source) ? `:${pointToken(source.originPoint)}>${pointToken(source.destPoint)}` : "";

  return {
    ok: true,
    key: `${KEY_PREFIX}:${source.originCell}:${source.destCell}:${source.profileKey}:${source.timeBucket}${exact}`,
    reason: null,
  };
}

/**
 * Build a cache entry from a router result.
 *
 * The travel-time *distribution* is carried, not only the point estimate: §8.4 prices
 * `p_late` "from the ETA predictive distribution, not the point estimate", and a cache that
 * stored only a mean would make punctuality unpriceable for every cached pair — which is
 * every pair in steady state.
 *
 * ── E-8: terrain is a property of the traversal, so it is carried here ─────
 * §14.2 states the climb and regeneration terms as `Σ max(0, Δh)` **over the leg**, and
 * `β_stop_start · n_stop_start_cycles` as *"acceleration cycles"* along it. All three are
 * properties of the path between two points, exactly as `distanceM` is — so they belong on
 * the hop the router answers with, and the `route(parts)` contract is **six** fields.
 *
 * They were previously carried as `planBuilder`'s `terrainByStop`, a map keyed by the
 * *sequenced* stop number. `insertChargingStop` re-sequences every stop when it evaluates
 * an insertion position, so that key shifted under §13.4 and each stop after the inserted
 * one read its neighbour's terrain — a silently wrong physical profile, not a refusal.
 * Keying by the hop removes the failure mode rather than guarding it: `hopsForSequence` is
 * re-run per variant, so an inserted charging stop gets its own approach hop with its own
 * elevation change.
 *
 * **Carried, not required.** The three original fields are what makes a row a usable cache
 * entry at all, and they stay mandatory. Terrain is a *decision-path* requirement, and it is
 * enforced where the decision is made — `plan/timeline.project` refuses a hop without it,
 * before any plan is built or priced. Requiring it here instead would additionally refuse
 * every row written by `tools/routing/b1Benchmark.js`, which measures engine latency and
 * cache hit rate and builds no plan; a benchmark that cached nothing would report a hit rate
 * of zero and read as an engine result. A value that *is* supplied is still validated: a
 * negative climb is refused rather than stored.
 *
 * @param {object} input `{ distanceM, travelSeconds, travelSdSeconds, climbM, descentM,
 *   stopStartCycles, profileKey, timeBucket }`
 * @returns {{ ok: boolean, entry: object|null, missing: string[] }}
 */
function buildEntry(input) {
  const source = input || {};
  const missing = [];

  if (!isNumber(source.distanceM) || source.distanceM < 0) missing.push("distanceM");
  if (!isNumber(source.travelSeconds) || source.travelSeconds < 0) missing.push("travelSeconds");
  if (!isNumber(source.travelSdSeconds) || source.travelSdSeconds < 0) missing.push("travelSdSeconds");

  // Present-but-invalid is a refusal; absent is carried as `null` for `timeline.project` to
  // refuse at the decision path. The two are kept distinct precisely so that "the router
  // returned a negative climb" never reads as "the router said nothing".
  for (const field of TERRAIN_FIELDS) {
    const value = source[field];
    if (value === null || value === undefined) continue;
    if (!isNumber(value) || value < 0) missing.push(field);
  }
  if (missing.length > 0) return { ok: false, entry: null, missing };

  // An exact-endpoint traversal also carries its geometry — the points the router measured
  // `distanceM` over — so the route that is priced is the route that is later driven and
  // drawn, read from one entry rather than recomputed. Carried only together with the basis
  // that makes it meaningful; a cell-representative entry keeps exactly its eight fields.
  const exact =
    source.endpointBasis === ENDPOINT_BASIS.EXACT_POINTS &&
    Array.isArray(source.path) &&
    source.path.length >= MIN_PATH_POINTS &&
    source.path.every(isPoint);

  return {
    ok: true,
    entry: Object.freeze({
      distanceM: source.distanceM,
      travelSeconds: source.travelSeconds,
      travelSdSeconds: source.travelSdSeconds,
      climbM: source.climbM ?? null,
      descentM: source.descentM ?? null,
      stopStartCycles: source.stopStartCycles ?? null,
      profileKey: source.profileKey ?? null,
      timeBucket: source.timeBucket ?? null,
      ...(exact
        ? {
            endpointBasis: ENDPOINT_BASIS.EXACT_POINTS,
            path: Object.freeze(source.path.map((point) => Object.freeze({ lat: point.lat, lon: point.lon }))),
          }
        : {}),
    }),
    missing: [],
  };
}

/**
 * The intra-cell offset settings for one entry: unchanged for a cell-representative entry,
 * and zero ends for an exact-endpoint entry the request was keyed on (see `ENDPOINT_BASIS`).
 *
 * @param {object} entry
 * @param {object} parts the request
 * @param {object} settings `{ intraCellOffsetM, speedMetresPerSecond, ends }`
 * @returns {object}
 */
function offsetSettingsFor(entry, parts, settings) {
  const exact = entry && entry.endpointBasis === ENDPOINT_BASIS.EXACT_POINTS && hasExactEndpoints(parts);
  return exact ? { ...settings, ends: 0 } : settings;
}

/**
 * Apply §20.3's intra-cell offset correction, pessimistically.
 *
 * Two offsets are added — one at each end of the pair — because the quantisation error is
 * present at the origin and at the destination independently. The travel time is inflated
 * by the offset at the profile's own speed, so the correction is dimensionally a time and
 * not a fudge factor.
 *
 * @param {object} entry
 * @param {object} input `{ intraCellOffsetM, speedMetresPerSecond, ends }`
 * @returns {{ ok: boolean, corrected: object|null, missing: string[] }}
 */
function applyIntraCellOffset(entry, input) {
  const source = input || {};
  const missing = [];

  if (!entry) missing.push("entry");
  if (!isNumber(source.intraCellOffsetM) || source.intraCellOffsetM < 0) missing.push("route.intra_cell_offset_m");
  if (!isNumber(source.speedMetresPerSecond) || source.speedMetresPerSecond <= 0) {
    missing.push("speedMetresPerSecond");
  }
  if (missing.length > 0) return { ok: false, corrected: null, missing };

  // @structural both ends of a cell pair carry the quantisation, so the default is 2
  const ends = isNumber(source.ends) ? source.ends : 2;
  const offsetM = source.intraCellOffsetM * ends;

  // Terrain passes through untouched. The offset is a **horizontal** quantisation — §20.3
  // corrects for the distance between a cell's centre and the real endpoint — and there is
  // no elevation change to attribute to it. Inflating climb by a plausible gradient here
  // would be inventing terrain for ground the router never traversed.
  return {
    ok: true,
    corrected: Object.freeze({
      ...entry,
      distanceM: entry.distanceM + offsetM,
      travelSeconds: entry.travelSeconds + offsetM / source.speedMetresPerSecond,
      intraCellOffsetM: offsetM,
      correctionDirection: "ADDED",
    }),
    missing: [],
  };
}

/**
 * Read one cell pair, falling through to the injected router on a miss.
 *
 * @param {object} deps `{ kv, route, counters }`
 * @param {object} parts the key components
 * @param {object} [options] `{ ttlSeconds, intraCellOffsetM, speedMetresPerSecond }`
 * @returns {Promise<{ ok: boolean, entry: object|null, hit: boolean, reason: string|null }>}
 */
async function read(deps, parts, options) {
  const source = deps || {};
  const settings = options || {};
  const built = key(parts);
  if (!built.ok) return { ok: false, entry: null, hit: false, reason: built.reason };

  if (source.kv && typeof source.kv.get === "function") {
    try {
      const raw = await source.kv.get(built.key);
      if (raw) {
        if (source.counters) source.counters.hit();
        const entry = JSON.parse(raw);
        const corrected = applyIntraCellOffset(entry, offsetSettingsFor(entry, parts, settings));
        return corrected.ok
          ? { ok: true, entry: corrected.corrected, hit: true, reason: null }
          : { ok: true, entry, hit: true, reason: null };
      }
    } catch {
      // A cache error is a miss, never a verdict (I16).
    }
  }

  if (source.counters) source.counters.miss();
  if (typeof source.route !== "function") {
    return { ok: false, entry: null, hit: false, reason: "no router is available and the entry is not cached" };
  }

  let routed;
  try {
    routed = await source.route(parts);
  } catch (error) {
    return {
      ok: false,
      entry: null,
      hit: false,
      reason: `the Routing Service failed: ${error && error.message}. §5.2 declares this dependency's ` +
        "degradation — cached matrices, then a geometric bound × detour factor with the mission radius " +
        "reduced to route.degraded_max_radius — and choosing among those is the round's decision",
    };
  }

  const entry = buildEntry(routed);
  if (!entry.ok) return { ok: false, entry: null, hit: false, reason: `router result missing ${entry.missing.join(", ")}` };

  await write(source, parts, entry.entry, settings.ttlSeconds);

  const corrected = applyIntraCellOffset(entry.entry, offsetSettingsFor(entry.entry, parts, settings));
  return {
    ok: true,
    entry: corrected.ok ? corrected.corrected : entry.entry,
    hit: false,
    reason: null,
  };
}

/**
 * Write one entry. A write failure is silent, for the same reason a read error is a miss.
 *
 * @param {object} deps `{ kv }`
 * @param {object} parts
 * @param {object} entry
 * @param {number} ttlSeconds
 * @returns {Promise<boolean>}
 */
async function write(deps, parts, entry, ttlSeconds) {
  const source = deps || {};
  if (!source.kv || typeof source.kv.set !== "function") return false;
  const built = key(parts);
  if (!built.ok) return false;
  try {
    await source.kv.set(built.key, JSON.stringify(entry), "EX", ttlSeconds);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the hops for an ordered stop sequence: the travel **into** each stop.
 *
 * The first hop is the approach from the agent's release position; the rest are the
 * linehaul. Returned in stop order so `plan/timeline.project()` can consume it directly.
 *
 * ── Exact endpoints, when the composition's router routes between them ──────
 * With `exactEndpoints: true` each hop also names its exact endpoints — the agent's
 * `originPoint` for the approach, then each stop's own `lat`/`lon` — so a router that
 * routes between coordinates rather than cell representatives (the V1 demonstration's
 * campus network) is asked about the traversal that will actually be driven. A hop whose
 * endpoint has no coordinate is asked about cells alone and keeps the §20.3 correction.
 * Without the flag every request is exactly the cell-pair request it always was.
 *
 * @param {object} deps `{ kv, route, counters }`
 * @param {object} input `{ originCell, originPoint?, exactEndpoints?, stops, profileKey, timeBucket, options }`
 * @returns {Promise<{ ok: boolean, hops: object[], misses: number, problems: string[] }>}
 */
async function hopsFor(deps, input) {
  const source = input || {};
  const stops = source.stops || [];
  const hops = [];
  const problems = [];
  let misses = 0;
  const exact = source.exactEndpoints === true;

  let originCell = source.originCell;
  let originPoint = exact && isPoint(source.originPoint) ? source.originPoint : null;
  for (const stop of stops) {
    const destPoint = exact && isPoint(stop) ? { lat: stop.lat, lon: stop.lon } : null;
    const parts = { originCell, destCell: stop.cellId, profileKey: source.profileKey, timeBucket: source.timeBucket };
    if (originPoint && destPoint) {
      parts.originPoint = originPoint;
      parts.destPoint = destPoint;
    }
    const result = await read(deps, parts, source.options);
    if (!result.ok) {
      problems.push(`stop ${String(stop.sequence)}: ${result.reason}`);
      hops.push(null);
    } else {
      if (!result.hit) misses += 1;
      hops.push(result.entry);
    }
    originCell = stop.cellId;
    originPoint = destPoint;
  }

  return { ok: problems.length === 0, hops, misses, problems };
}

/**
 * Hit and miss counters for §20.3's SLI.
 */
class Counters {
  constructor() {
    this.hits = 0;
    this.misses = 0;
  }

  hit() {
    this.hits += 1;
  }

  miss() {
    this.misses += 1;
  }

  /**
   * @param {number} minimumHitRate `route.cell_pair_min_hit_rate`
   * @returns {{ hits: number, misses: number, hitRate: number|null, belowTarget: boolean|null }}
   */
  report(minimumHitRate) {
    const total = this.hits + this.misses;
    const hitRate = total === 0 ? null : this.hits / total;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate,
      belowTarget: hitRate === null || !isNumber(minimumHitRate) ? null : hitRate < minimumHitRate,
    };
  }
}

module.exports = {
  KEY_PREFIX,
  KEY_FIELDS,
  TERRAIN_FIELDS,
  ENDPOINT_BASIS,
  hasExactEndpoints,
  key,
  buildEntry,
  applyIntraCellOffset,
  read,
  write,
  hopsFor,
  Counters,
};

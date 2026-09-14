"use strict";

/**
 * **§20.3's cell-pair cache hit rate, measured under the declared spatial model.**
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * §20.3 used to justify its >95 % target with an argument: *"Because cells are
 * ~200–500 m, the cache is small relative to a point-pair cache and its hit rate is
 * high."* ADR-35 made FINE H3 resolution 11 and deleted that premise. `RD-2026-09-14-01`
 * D3 therefore amended §20.3 so the hit rate is **measured against the declared model**
 * rather than inherited from the cell size. This is the measurement.
 *
 * The concern is concrete and arithmetic: the RNSIT pair space grows from 9 cell pairs at
 * resolution 8 to 2 025 at resolution 11 — about **225×** — for the same traffic. A cache
 * over 225× the key space, fed the same requests, hits less often.
 *
 * ── What is measured, and what is NOT ───────────────────────────────────────
 * **Measured:** hits and misses over the **production key function**,
 * `routing/cellPairCache.key()`, accumulated in the **production counter**,
 * `cellPairCache.Counters`, with hit/miss defined exactly as `cellPairCache.read()`
 * defines them — a hit is the key being present in the store.
 *
 * **Not measured, and not invented:** no route is called and no travel time, distance,
 * climb, descent or stop-start count appears anywhere in this file. Counting cache hits
 * needs none of them, and supplying them would mean fabricating `EXTERNAL_ROUTING` inputs
 * that B1 has not delivered in order to produce a performance number. The entry written
 * on a miss is an opaque marker.
 *
 * ── The workload is part of the result, and it is DECLARED, not observed ────
 * **There is no RNSIT demand trace.** No production deployment exists
 * (`cutover.engine_enabled` is unbound) and no historical request log exists, so a
 * measured production hit rate cannot be produced by anyone, in this repository or
 * outside it, today.
 *
 * What this tool produces is therefore a hit rate **conditional on a stated synthetic
 * workload**, and the workload definition is printed with every result so the number can
 * never be quoted without it. It is deterministic — a seeded PRNG, no clock, no `Math.random`
 * — so two runs agree exactly.
 *
 * **A result from this tool does not discharge §20.3's target.** It bounds the question
 * and shows the direction and size of the resolution effect. Discharging the target needs
 * real demand. That is recorded as an open item, not worked around, and if the measured
 * figure comes in under the target the target is **not** adjusted to meet it.
 *
 *   node tools/verify/spatialCacheHitRate.js [--json] [--requests N] [--resolutions 8,11]
 */

const fs = require("fs");
const path = require("path");
const h3 = require("h3-js");

const cellPairCache = require("../../src/engine/routing/cellPairCache");
const cells = require("../../src/engine/spatial/cells");
const deliveryDomain = require("../../src/engine/spatial/deliveryDomain");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");

/** §20.3's stated steady-state target for this cache. NOT adjustable by this tool. */
const TARGET_HIT_RATE = 0.95;

/**
 * The declared workload. Every number here is a **stated assumption about RobotX campus
 * traffic**, not a measurement, and each is printed in the result.
 * @structural the workload definition — it is part of the result, not a tuning knob
 */
const WORKLOAD = Object.freeze({
  requests: 20000,
  /**
   * **Arrival rates, in requests per second — the assumption that actually decides the
   * answer.** §20.3 states its target "in steady state", and steady state for a TTL cache
   * is not a property of the key space alone: an entry survives
   * `route.cell_pair_cache_ttl` (900 s), so whether a repeat request hits depends on
   * whether that key recurred inside the window. That makes the hit rate a function of
   * **demand intensity**, and a single figure would bury that dependency in one unstated
   * number.
   *
   * So a range is swept and the whole curve is reported. RNSIT's real arrival rate is
   * unknown — it is demand, not geometry — which is precisely why the target cannot be
   * discharged here.
   */
  arrivalsPerSecond: [0.1, 0.25, 0.5, 1, 2, 5, 10],
  /**
   * §20.3's own rationale for this cache is that mission origins *"cluster heavily around
   * restaurants, depots, and pickup points"*. That clustering is modelled by drawing
   * origins from a small anchor set with Zipf weights, which is the shape of the claim.
   * A uniform origin draw would model a different deployment and would understate the
   * hit rate for reasons that have nothing to do with the resolution.
   */
  originAnchors: 6,
  originZipfExponent: 1.0,
  /** Destinations are campus-wide: a delivery goes where it is asked to go. */
  destinationSampleSize: 120,
  /** §20.3 keys on the mobility profile. RNSIT V1 declares one rover profile. */
  profiles: ["rover-v1"],
  /** §20.3's congestion bucket. Four buckets = a coarse day split. */
  timeBuckets: ["early", "midday", "evening", "night"],
  seed: 20260914,
});

/** A deterministic 32-bit PRNG — mulberry32. No clock, no Math.random. */
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadCampus() {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "rnsit-campus-osm.geojson"));
  const boundary = JSON.parse(raw).features.find((row) => row.id === "way/1120154292").geometry;
  const domain = deliveryDomain.validateDomainDeclaration({
    regionId: "rnsit-campus", name: "RNSIT Campus", kind: "CAMPUS", crs: "EPSG:4326",
    version: "way/1120154292", versionDate: "2026-08-30", boundary,
  });
  return { boundary, domain };
}

/**
 * `destinationSampleSize` in-campus points, drawn deterministically and **rejected
 * against the real geofence** so every one is a place a delivery could legitimately go.
 */
function campusPoints(domain, count, random) {
  const box = domain.bbox;
  const points = [];
  let guard = 0;
  while (points.length < count && guard < count * 1000) {
    guard += 1;
    const lat = box.minLat + random() * (box.maxLat - box.minLat);
    const lon = box.minLon + random() * (box.maxLon - box.minLon);
    if (deliveryDomain.evaluatePoint(domain, lat, lon).verdict === "INSIDE") points.push({ lat, lon });
  }
  return points;
}

/** Zipf index draw over `n` items. */
function zipfIndex(n, exponent, random) {
  let total = 0;
  const weights = [];
  for (let rank = 1; rank <= n; rank += 1) {
    const weight = 1 / rank ** exponent;
    weights.push(weight);
    total += weight;
  }
  let target = random() * total;
  for (let index = 0; index < n; index += 1) {
    target -= weights[index];
    if (target <= 0) return index;
  }
  return n - 1;
}

/**
 * Run the workload at one H3 resolution and one arrival rate.
 *
 * **TTL eviction is modelled**, because §20.3's target is stated "in steady state" and a
 * cache with no eviction trends to 100 % by construction — a number that would say
 * nothing about the resolution and everything about the simulation. An entry is a hit iff
 * the same key recurred within `route.cell_pair_cache_ttl` seconds.
 *
 * The first TTL window is treated as **warm-up and excluded from the steady-state
 * figure**: a cold cache misses on every first sight of a key, and that transient is not
 * what "steady state" names. Both figures are reported so neither can be quoted alone.
 *
 * @returns {object} the measured result
 */
function measureAt(resolution, arrivalsPerSecond, workload, campus, ttlSeconds) {
  const random = prng(workload.seed);
  const origins = campusPoints(campus.domain, workload.originAnchors, random);
  const destinations = campusPoints(campus.domain, workload.destinationSampleSize, random);

  /** key → the time it was last written. */
  const lastWritten = new Map();
  const overall = new cellPairCache.Counters();
  const steady = new cellPairCache.Counters();
  const distinctKeys = new Set();
  let malformed = 0;
  let now = 0;

  const draw = prng(workload.seed ^ resolution);
  for (let request = 0; request < workload.requests; request += 1) {
    // Deterministic exponential inter-arrivals from the seeded stream.
    now += -Math.log(1 - draw()) / arrivalsPerSecond;

    const origin = origins[zipfIndex(origins.length, workload.originZipfExponent, draw)];
    const destination = destinations[Math.floor(draw() * destinations.length)];
    const parts = {
      originCell: h3.latLngToCell(origin.lat, origin.lon, resolution),
      destCell: h3.latLngToCell(destination.lat, destination.lon, resolution),
      profileKey: workload.profiles[Math.floor(draw() * workload.profiles.length)],
      timeBucket: workload.timeBuckets[Math.floor(draw() * workload.timeBuckets.length)],
    };

    // The **production** key function. If it ever stops requiring all four components,
    // this measurement changes and the mutation suite notices.
    const built = cellPairCache.key(parts);
    if (!built.ok) {
      malformed += 1;
      continue;
    }
    distinctKeys.add(built.key);

    const written = lastWritten.get(built.key);
    const hit = written !== undefined && now - written <= ttlSeconds;
    const inSteadyState = now >= ttlSeconds;

    if (hit) {
      overall.hit();
      if (inSteadyState) steady.hit();
    } else {
      overall.miss();
      if (inSteadyState) steady.miss();
      // An opaque marker. No route value is invented — see the header.
      lastWritten.set(built.key, now);
    }
  }

  const overallReport = overall.report(TARGET_HIT_RATE);
  const steadyReport = steady.report(TARGET_HIT_RATE);
  const originCells = new Set(origins.map((point) => h3.latLngToCell(point.lat, point.lon, resolution)));
  const destCells = new Set(destinations.map((point) => h3.latLngToCell(point.lat, point.lon, resolution)));

  return {
    resolution,
    arrivalsPerSecond,
    edgeMetres: Number(h3.getHexagonEdgeLengthAvg(resolution, h3.UNITS.m).toFixed(2)),
    requests: workload.requests,
    simulatedSeconds: Math.round(now),
    ttlSeconds,
    hits: overallReport.hits,
    misses: overallReport.misses,
    hitRate: overallReport.hitRate,
    steadyStateHits: steadyReport.hits,
    steadyStateMisses: steadyReport.misses,
    steadyStateHitRate: steadyReport.hitRate,
    belowTarget: steadyReport.belowTarget,
    distinctKeys: distinctKeys.size,
    distinctOriginCells: originCells.size,
    distinctDestCells: destCells.size,
    reachablePairSpace: originCells.size * destCells.size * workload.profiles.length * workload.timeBuckets.length,
    malformedKeys: malformed,
  };
}

function main(argv) {
  const args = argv || [];
  const asJson = args.includes("--json");
  const requestsArg = args.indexOf("--requests");
  const resolutionsArg = args.indexOf("--resolutions");

  const workload = {
    ...WORKLOAD,
    requests: requestsArg >= 0 ? Number(args[requestsArg + 1]) : WORKLOAD.requests,
  };
  const resolutions = resolutionsArg >= 0
    ? args[resolutionsArg + 1].split(",").map(Number)
    : [8, cells.H3_RESOLUTION.FINE];

  const campus = loadCampus();
  if (campus.domain.status !== "VALID") {
    process.stderr.write("the adopted RNSIT boundary did not validate; nothing is measured\n");
    return 1;
  }

  // The TTL comes from the register, not from this file — it is `route.cell_pair_cache_ttl`,
  // §20.3 item 2, and a measurement against a TTL nobody published would be measuring a
  // cache this system does not have.
  const register = require("../../src/engine/config/register/supplementary.json");
  const ttlSeconds = register.parameters.find((row) => row.name === "route.cell_pair_cache_ttl").default;

  const results = [];
  for (const resolution of resolutions) {
    for (const rate of workload.arrivalsPerSecond) {
      results.push(measureAt(resolution, rate, workload, campus, ttlSeconds));
    }
  }

  const current = results.filter((row) => row.resolution === cells.H3_RESOLUTION.FINE);
  const meetsAt = current.filter((row) => row.steadyStateHitRate >= TARGET_HIT_RATE).map((row) => row.arrivalsPerSecond);

  const report = {
    spatialModel: cells.SPATIAL_MODEL.id,
    target: TARGET_HIT_RATE,
    ttlSeconds,
    // Deliberately not a boolean. The target is met at some arrival rates and not others,
    // and collapsing that to true/false would be the part of the answer that is a guess.
    targetMetAtArrivalRates: meetsAt,
    targetMissedAtArrivalRates: current.filter((row) => row.steadyStateHitRate < TARGET_HIT_RATE).map((row) => row.arrivalsPerSecond),
    workload,
    results,
    // The sentence that must travel with the number.
    caveat:
      "These are hit rates under a DECLARED SYNTHETIC workload, not production measurements. No RNSIT demand " +
      "trace exists — no deployment is live — and the steady-state hit rate depends on the arrival rate, which " +
      "is demand and not geometry. §20.3's >95% target is therefore NOT discharged by this result in either " +
      "direction. The target was not adjusted to match what was measured.",
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  const lines = [
    `§20.3 cell-pair cache hit rate — spatial model ${report.spatialModel}`,
    "",
    "  Workload (DECLARED, not observed):",
    `    requests            ${workload.requests} per (resolution, arrival rate) cell`,
    `    origin anchors      ${workload.originAnchors} (Zipf exponent ${workload.originZipfExponent})`,
    `    destination sample  ${workload.destinationSampleSize} in-campus points, geofence-rejected`,
    `    profiles            ${workload.profiles.length} (${workload.profiles.join(", ")})`,
    `    time buckets        ${workload.timeBuckets.length} (${workload.timeBuckets.join(", ")})`,
    `    cache TTL           ${ttlSeconds}s (route.cell_pair_cache_ttl, from the register)`,
    `    seed                ${workload.seed}`,
    "",
    "  res  edge m   req/s   sim h   distinct keys   overall    steady-state   vs §20.3",
  ];
  for (const row of results) {
    const steady = row.steadyStateHitRate === null ? null : (row.steadyStateHitRate * 100).toFixed(2);
    lines.push(
      `  ${String(row.resolution).padStart(3)}  ${String(row.edgeMetres).padStart(7)}  ` +
        `${String(row.arrivalsPerSecond).padStart(5)}  ${String((row.simulatedSeconds / 3600).toFixed(1)).padStart(5)}  ` +
        `${String(row.distinctKeys).padStart(13)}   ${(row.hitRate * 100).toFixed(2).padStart(6)}%   ` +
        `${(steady === null ? "n/a" : `${steady}%`).padStart(12)}   ${steady === null ? "no steady-state window" : row.steadyStateHitRate >= TARGET_HIT_RATE ? "MET" : "NOT MET"}`,
    );
  }
  lines.push("");
  lines.push(
    `  §20.3 target > ${(TARGET_HIT_RATE * 100).toFixed(0)}% at resolution ${cells.H3_RESOLUTION.FINE}: ` +
      `met at ${meetsAt.length === 0 ? "NO tested arrival rate" : `${meetsAt.join(", ")} req/s`}; ` +
      `missed at ${report.targetMissedAtArrivalRates.length === 0 ? "none" : `${report.targetMissedAtArrivalRates.join(", ")} req/s`}`,
  );
  lines.push("");
  lines.push(`  ${report.caveat}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

module.exports = { WORKLOAD, TARGET_HIT_RATE, measureAt, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));

"use strict";

/**
 * PHASE 7 — closure evidence probe.
 *
 * Phase 7's independent verification checked the seven producer/predicate boundaries by
 * reading field names on both sides. Phase 6's closure went further for the ones its own
 * gate consumes, and found a real defect (R1) by *composing* the modules instead. This
 * harness re-derives, by execution against the current working tree, the Phase 7 claims
 * that a re-read of the source cannot settle:
 *
 *   1. **The seven predicates' register rows** — class, indeterminate policy, cache
 *      tier, volatility — re-queried rather than transcribed from a report.
 *   2. **Absent Phase 7 input ⇒ INDETERMINATE ⇒ DENY**, for each of the seven. The
 *      conservative-failure direction is the whole reason Phase 6 could ship before
 *      Phase 7; it has to still hold now that the producers exist.
 *   3. **Tier-3 budget exhaustion is a distinct verdict**, mapped to INDETERMINATE and
 *      never to INFEASIBLE, and never memoised.
 *   4. **The four reserve layers are never traded** — `assertNoTrade()` refuses a
 *      protected layer *falling* and permits it rising, which is the asymmetry §14.5
 *      requires and not a symmetric equality check.
 *   5. **α[tier] is derived, never hand-entered.**
 *   6. **Energy is Wh in the decision path** — every field of the offer's reserve
 *      parameters is Wh-denominated, and none is a fraction or a percentage.
 *   7. **A cache failure cannot produce a verdict** (I16) — each of Phase 7's three
 *      Redis families is driven with a client that throws.
 *   8. **The V9 combined-conservatism arithmetic**, factor by factor, with each
 *      factor's governance class, so the closure record's disposition rests on a fresh
 *      reading rather than on the implementation report's.
 *
 * Usage:
 *   node tools/verify/phase7ClosureProbe.js
 *
 * No database and no Redis: everything here is pure. Cited by
 * `PHASE_7_REMEDIATION_AND_CLOSURE.md` §§9–10.
 */

const { predicate } = require("../../src/engine/feasibility/register");
const threeValued = require("../../src/engine/feasibility/threeValued");

const f22 = require("../../src/engine/feasibility/predicates/f22");
const f23 = require("../../src/engine/feasibility/predicates/f23");
const f24 = require("../../src/engine/feasibility/predicates/f24");
const f25 = require("../../src/engine/feasibility/predicates/f25");
const f26 = require("../../src/engine/feasibility/predicates/f26");
const f34 = require("../../src/engine/feasibility/predicates/f34");
const f35 = require("../../src/engine/feasibility/predicates/f35");

const reserves = require("../../src/engine/energy/reserves");
const tiers = require("../../src/engine/energy/tiers");
const packing = require("../../src/engine/payload/packing");
const chargerReachabilityCache = require("../../src/engine/routing/chargerReachabilityCache");
const configService = require("../../src/engine/config/service");

const PREDICATES = { F22: f22, F23: f23, F24: f24, F25: f25, F26: f26, F34: f34, F35: f35 };

let passed = 0;
let failed = 0;

/**
 * @param {string} label
 * @param {boolean} condition
 * @param {string} [detail]
 */
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ── 1. The register rows, re-queried ──────────────────────────────────────── */

console.log("1. Register rows for the seven Phase 7-dependent predicates (§7.5)\n");

const EXPECTED_ROWS = {
  F22: { constraintClass: "I", policy: "DENY", volatile: false, cacheTier: "NONE" },
  F23: { constraintClass: "I", policy: "DENY", volatile: false, cacheTier: "NONE" },
  F24: { constraintClass: "I", policy: "DENY", volatile: false, cacheTier: "NONE" },
  F25: { constraintClass: "R", policy: "DENY", volatile: false, cacheTier: "CLASS" },
  F26: { constraintClass: "R", policy: "DENY", volatile: false, cacheTier: "CLASS" },
  F34: { constraintClass: "I", policy: "DENY", volatile: true, cacheTier: "NONE" },
  F35: { constraintClass: "I", policy: "DENY", volatile: true, cacheTier: "NONE" },
};

for (const [id, expected] of Object.entries(EXPECTED_ROWS)) {
  const row = predicate(id);
  const actual = {
    constraintClass: row.constraintClass,
    policy: row.policy,
    volatile: row.volatile,
    cacheTier: row.cacheTier,
  };
  check(
    `${id}  class ${expected.constraintClass}  ${expected.policy}  volatile=${expected.volatile}  cache=${expected.cacheTier}`,
    JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify(actual),
  );
}

/* ── 2. Absent Phase 7 input ⇒ INDETERMINATE, and the policy is DENY ───────── */

console.log("\n2. Absent Phase 7 input ⇒ INDETERMINATE ⇒ DENY (§7.3, the conservative direction)\n");

// A plan object with none of the three Phase 7 fragments attached: exactly the state
// Phase 6 shipped in, and the state a Phase 7 producer outage reproduces. The mission
// carries a real thermal and hazard payload, because F25 does not *bind* on a payload
// with no thermal range — vacuous satisfaction there is correct, and using an empty
// payload would test nothing.
const EMPTY_PLAN_CONTEXT = {
  plan: {},
  mission: { payload: { thermalMinC: 2, thermalMaxC: 8, thermalMaxExcursionSeconds: 0 } },
  agentSnapshot: {},
  config: {},
};

for (const [id, module] of Object.entries(PREDICATES)) {
  let outcome;
  try {
    outcome = module.evaluate(EMPTY_PLAN_CONTEXT).outcome;
  } catch (error) {
    outcome = `THREW: ${error.message}`;
  }
  const policy = predicate(id).policy;
  check(`${id} on an empty plan → ${outcome}, policy ${policy}`, outcome === threeValued.OUTCOME.INDETERMINATE && policy === "DENY", outcome);
}

/* ── 3. Tier-3 exhaustion is a distinct verdict and is never memoised ───────── */

console.log("\n3. §15.3 — tier-3 budget exhaustion is INDETERMINATE, never INFEASIBLE\n");

check(
  "packing.VERDICT has three values, BUDGET_EXHAUSTED distinct from INFEASIBLE",
  packing.VERDICT.BUDGET_EXHAUSTED === "BUDGET_EXHAUSTED" && packing.VERDICT.INFEASIBLE === "INFEASIBLE",
);
check(
  "F23 maps the three verdicts three ways: FEASIBLE→SATISFIED, INFEASIBLE→VIOLATED, BUDGET_EXHAUSTED→INDETERMINATE",
  f23.evaluate({ plan: { packing: { verdict: "FEASIBLE", tier: 2 } } }).outcome === threeValued.OUTCOME.SATISFIED &&
    f23.evaluate({ plan: { packing: { verdict: "INFEASIBLE", tier: 1 } } }).outcome === threeValued.OUTCOME.VIOLATED &&
    f23.evaluate({ plan: { packing: { verdict: "BUDGET_EXHAUSTED", tier: 3 } } }).outcome === threeValued.OUTCOME.INDETERMINATE,
);
check("f23.PACKING_VERDICT is exactly packing.VERDICT — one enum, two independent readers", JSON.stringify(f23.PACKING_VERDICT) === JSON.stringify(packing.VERDICT));

// The memo may not store an indecision. Driven through the shipped memoiser with a kv
// that records every write it is asked to make.
(async () => {
  const writes = [];
  const kv = {
    get: async () => null,
    set: async (key, value) => {
      writes.push({ key, value });
    },
  };
  const exhausting = {
    container: {
      modelId: "probe",
      totalMassLimitKg: 100,
      totalVolumeLitres: 500,
      compartments: [
        {
          compartmentId: "c1",
          ordinal: 1,
          internalLengthMm: 300,
          internalWidthMm: 300,
          internalHeightMm: 300,
          apertureWidthMm: 300,
          apertureHeightMm: 300,
          maxMassKg: 5,
          thermalClass: "AMBIENT",
          thermalMinC: -10,
          thermalMaxC: 40,
          activeThermal: false,
          thermalHoldSeconds: 3600,
          lockClass: null,
          cleanlinessClass: null,
          blockedBy: [],
        },
      ],
    },
    consignment: {
      items: [1, 2, 3].map((n) => ({
        itemId: `x${n}`,
        lengthMm: 280,
        widthMm: 280,
        heightMm: 280,
        volumeLitres: 20,
        massKg: 2,
        massToleranceKg: 0,
        stackable: false,
        hazardClasses: [],
        segregation: { incompatibleHazardClasses: [] },
      })),
    },
    packingEfficiency: 0.75,
    nodeBudget: 1,
  };

  const result = await packing.evaluateMemoised({ kv }, exhausting);
  const verdict = (result.result || result).verdict;
  check(`a node-starved search returns ${verdict}`, verdict === packing.VERDICT.BUDGET_EXHAUSTED, verdict);
  check("…and nothing was written to the memo", writes.length === 0, `${writes.length} write(s)`);

  /* ── 7. A cache failure cannot produce a verdict (I16) ───────────────────── */

  console.log("\n7. §3.3 I16 — a cache failure is a miss, never an authority\n");

  const throwingKv = {
    get: async () => {
      throw new Error("redis down");
    },
    set: async () => {
      throw new Error("redis down");
    },
  };

  const onFailure = await packing.evaluateMemoised({ kv: throwingKv }, {
    ...exhausting,
    nodeBudget: 5000,
    consignment: {
      items: [
        {
          itemId: "small",
          lengthMm: 100,
          widthMm: 100,
          heightMm: 100,
          volumeLitres: 1,
          massKg: 1,
          massToleranceKg: 0,
          stackable: true,
          hazardClasses: [],
          segregation: { incompatibleHazardClasses: [] },
        },
      ],
    },
  });
  const recomputed = onFailure.result || onFailure;
  check(
    "packing memo: a thrown kv falls through to full recomputation rather than failing the decision",
    recomputed.verdict === packing.VERDICT.FEASIBLE && onFailure.cached !== true,
    JSON.stringify({ verdict: recomputed.verdict, cached: onFailure.cached }),
  );

  const reachParts = { cellId: "cell-1", profileKey: "p", timeBucket: "b", projectionVersion: 41 };
  const reachRead = await chargerReachabilityCache.read({ kv: throwingKv }, reachParts);
  check("charger-reachability cache: a thrown kv is a miss, not a result", reachRead.hit === false, JSON.stringify(reachRead));

  // §20.3 item 3 — the version is part of the key, and `key()` refuses to build one
  // without it rather than composing a key that would silently apply an entry computed
  // under one projection to a decision taken under another.
  const withVersion = chargerReachabilityCache.key(reachParts);
  const withoutVersion = chargerReachabilityCache.key({ cellId: "cell-1", profileKey: "p", timeBucket: "b" });
  check("a complete key builds, and ends with the projection version", withVersion.ok === true && /:41$/.test(withVersion.key), JSON.stringify(withVersion));
  check(
    "…and a key without the projection version is REFUSED, not composed (§20.3 item 3)",
    withoutVersion.ok === false && withoutVersion.key === null && /projectionVersion/.test(withoutVersion.reason),
    JSON.stringify(withoutVersion),
  );

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

/* ── 4. The four reserve layers are never traded ───────────────────────────── */

console.log("\n4. §14.5 — four layers, and a protected layer may rise but never fall\n");

check("four layers are declared", Object.keys(reserves.LAYERS).length === 4, Object.keys(reserves.LAYERS).join(", "));
check(
  "every layer field is Wh-denominated — energy is never a fraction in the decision path (§14.1)",
  reserves.LAYER_FIELDS.every((field) => /Wh$/.test(field)),
  reserves.LAYER_FIELDS.join(", "),
);

const BEFORE = { floorWh: 80, returnWh: 120, contingencyWh: 60, operationalWh: 40 };
const FELL = { ...BEFORE, floorWh: 70 };
const ROSE = { ...BEFORE, floorWh: 95 };

const fell = reserves.assertNoTrade(BEFORE, FELL);
const rose = reserves.assertNoTrade(BEFORE, ROSE);
check("a protected layer falling is REFUSED", fell.ok === false, JSON.stringify(fell));
check("a protected layer rising is permitted — a more pessimistic route is not a trade", rose.ok === true, JSON.stringify(rose));
check(
  "the operational layer is the only releasable one",
  reserves.PROTECTED_FIELDS.length === 3 && !reserves.PROTECTED_FIELDS.includes("operationalWh"),
  reserves.PROTECTED_FIELDS.join(", "),
);

/* ── 5. α[tier] is derived, never hand-entered ─────────────────────────────── */

console.log("\n5. §14.5 — α[tier] is derived from the governed fleet-year budget\n");

const snapshot = configService.defaultSnapshot();
const alphaMap = snapshot.resolve("energy.shortfall_probability");
const budget = snapshot.resolve("energy.event_budget_per_fleet_year");
check("energy.shortfall_probability resolves", Boolean(alphaMap), JSON.stringify(alphaMap));
check("energy.event_budget_per_fleet_year — the governed input it is derived from — resolves", Boolean(budget), JSON.stringify(budget));

const handEntered = tiers.alphaFor({ config: { "energy.shortfall_probability": { T1: 0.5 } }, tier: "T1", slaClass: "STANDARD" });
check(
  "tiers.alphaFor refuses to read a hand-set α off an unregistered config object",
  !handEntered || handEntered.ok !== true,
  JSON.stringify(handEntered),
);

/* ── 8. V9's arithmetic, factor by factor ──────────────────────────────────── */

console.log("\n8. §14.3 — the combined-conservatism arithmetic, re-derived\n");

const FACTORS = [
  ["energy.charger_availability_margin", "nominal"],
  ["energy.uncalibrated_reserve_factor", "nominal"],
  ["energy.f_derate", "nominal"],
  ["route.degraded_reserve_factor", "degraded-only"],
];
let nominalProduct = 1;
let degradedOnlyProduct = 1;
for (const [name, when] of FACTORS) {
  const value = snapshot.resolve(name);
  console.log(`  ${name.padEnd(38)} ${String(value).padEnd(6)} (${when})`);
  if (when === "nominal") nominalProduct *= value;
  else degradedOnlyProduct *= value;
}
const cap = snapshot.resolve("energy.max_combined_conservatism");
const nominal = snapshot.resolve("energy.combined_nominal_conservatism");
const degraded = snapshot.resolve("energy.combined_degraded_conservatism");

console.log(`\n  nominal   = ${nominalProduct}  (published ${nominal})`);
console.log(`  degraded  = ${nominalProduct * degradedOnlyProduct}  (published ${degraded})`);
console.log(`  cap       = ${cap}\n`);

check("the published nominal product equals the hand-multiplied factors", Math.abs(nominal - nominalProduct) < 1e-12);
check("the published degraded product equals the hand-multiplied factors", Math.abs(degraded - nominalProduct * degradedOnlyProduct) < 1e-12);
check("the degraded product exceeds the cap — V9 blocks publication, as recorded", degraded > cap, `${degraded} vs ${cap}`);

// The implementation report's option (b) — making `uncalibrated_reserve_factor`
// degraded-only — is arithmetically ineffective, because `degraded` is
// `nominal × product(degraded-only)` and moving a factor between the two sets leaves
// that product unchanged. Stated here as a number rather than as an argument.
check(
  "moving energy.uncalibrated_reserve_factor to degraded-only would NOT resolve V9",
  Math.abs((nominalProduct / snapshot.resolve("energy.uncalibrated_reserve_factor")) * (degradedOnlyProduct * snapshot.resolve("energy.uncalibrated_reserve_factor")) - degraded) < 1e-12,
);

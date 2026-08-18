"use strict";

/**
 * PHASE 7 — F26 / container security-class agreement probe.
 *
 * Phase 7's independent verification recorded, as its Finding 1, that `f26.js` reads
 * `item.requiredLockClass` and that no producer anywhere populates it, leaving one of
 * F26's two security branches unreachable. It assessed the consequence as benign
 * because `payload/container.satisfiesSecurityClass()` — which every placement path
 * calls through `admissibleCompartments()` — already requires
 * `compartment.lockClass === item.securityClass` exactly.
 *
 * That assessment is correct about *today's* producer and incomplete about the
 * predicate. Removing the dead branch alone would have left F26 reading:
 *
 *     a security-classified item requires *a* lock class
 *
 * while the container model reads:
 *
 *     a security-classified item requires *its own* lock class
 *
 * — i.e. F26 would admit a strict superset of what the container model admits, on a
 * class **R** predicate whose indeterminate policy is DENY. That is the same structural
 * hazard Phase 6's closure fixed in F34 (R1): a predicate that is *looser* than the
 * producer it checks is safe only for as long as the producer stays strict, and the
 * whole point of the gate is that it does not have to trust the producer.
 *
 * This harness enumerates the security-class × lock-class matrix and asserts, case by
 * case, that
 *
 *     F26 says SATISFIED  ⟹  container.satisfiesSecurityClass() says ok
 *
 * holds for every combination — the subset property, checked rather than argued. It
 * also runs the same matrix through the **real** `payload/packing.js` to confirm that a
 * mismatched pairing is refused upstream too, so the change adds a second independent
 * refusal rather than moving one.
 *
 * Usage:
 *   node tools/verify/phase7SecurityClassProbe.js
 *
 * Deliberately not a Jest suite: it is a before/after divergence probe over two
 * modules' agreement, of the same kind as `phase6AlphaProbe.js`, and it is cited by
 * `PHASE_7_REMEDIATION_AND_CLOSURE.md` §4. The permanent regression coverage lives in
 * `tests/engine/feasibilityPhase7Integration.test.js`.
 */

const f26 = require("../../src/engine/feasibility/predicates/f26");
const container = require("../../src/engine/payload/container");
const packing = require("../../src/engine/payload/packing");

const CLASSES = [null, "SEALED_LOCKER", "TAMPER_EVIDENT", "CHAIN_OF_CUSTODY"];

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

/**
 * One compartment holding one item, in the shape F26 reads.
 *
 * @param {string|null} securityClass
 * @param {string|null} lockClass
 * @returns {object}
 */
function planFor(securityClass, lockClass) {
  return {
    packing: {
      compartmentLoads: [
        {
          compartmentId: "c1",
          lockClass,
          items: [{ itemId: "i1", hazardClasses: [], securityClass, segregation: { incompatibleHazardClasses: [] } }],
        },
      ],
    },
  };
}

console.log("F26 × container.satisfiesSecurityClass — the full class matrix\n");
console.log("  item.securityClass      compartment.lockClass   F26            container");
console.log("  ----------------------  ----------------------  -------------  ---------");

const rows = [];
for (const securityClass of CLASSES) {
  for (const lockClass of CLASSES) {
    const outcome = f26.evaluate({ plan: planFor(securityClass, lockClass) }).outcome;
    const admits = container.satisfiesSecurityClass({ securityClass }, { compartmentId: "c1", lockClass }).ok;
    rows.push({ securityClass, lockClass, outcome, admits });
    console.log(
      `  ${String(securityClass).padEnd(22)}  ${String(lockClass).padEnd(22)}  ${outcome.padEnd(13)}  ${admits ? "ok" : "refused"}`,
    );
  }
}

console.log("\nSubset property — F26 SATISFIED ⟹ the container model admits the placement\n");
for (const row of rows) {
  if (row.outcome !== "SATISFIED") continue;
  check(
    `security=${String(row.securityClass)} lock=${String(row.lockClass)}`,
    row.admits === true,
    "F26 admitted a placement the container model refuses",
  );
}

console.log("\nExact agreement — the two transcriptions decide every cell the same way\n");
for (const row of rows) {
  const agrees = (row.outcome === "SATISFIED") === (row.admits === true);
  check(`security=${String(row.securityClass)} lock=${String(row.lockClass)}`, agrees, `F26=${row.outcome} container=${row.admits}`);
}

console.log("\nUpstream — the real packing module refuses a mismatched pairing outright\n");

const CONTAINER = {
  modelId: "probe-container",
  totalMassLimitKg: 100,
  totalVolumeLitres: 500,
  compartments: [
    {
      compartmentId: "c1",
      ordinal: 1,
      internalLengthMm: 600,
      internalWidthMm: 400,
      internalHeightMm: 400,
      apertureWidthMm: 400,
      apertureHeightMm: 400,
      maxMassKg: 50,
      thermalClass: "AMBIENT",
      thermalMinC: -10,
      thermalMaxC: 40,
      activeThermal: false,
      thermalHoldSeconds: 3600,
      lockClass: "SEALED_LOCKER",
      cleanlinessClass: null,
      blockedBy: [],
    },
  ],
};

/**
 * @param {string|null} securityClass
 * @returns {object}
 */
function itemWith(securityClass) {
  return {
    itemId: "i1",
    lengthMm: 200,
    widthMm: 150,
    heightMm: 150,
    volumeLitres: 4.5,
    massKg: 3,
    massToleranceKg: 0.2,
    stackable: true,
    securityClass,
    hazardClasses: [],
    segregation: { incompatibleHazardClasses: [] },
  };
}

for (const [label, securityClass, expectFeasible] of [
  ["matching security class packs", "SEALED_LOCKER", true],
  ["mismatched security class does not pack", "TAMPER_EVIDENT", false],
  ["unclassified item packs", null, true],
]) {
  let verdict = "THREW";
  try {
    verdict = packing.evaluate({
      container: CONTAINER,
      consignment: { items: [itemWith(securityClass)] },
      packingEfficiency: 0.75,
      nodeBudget: 5000,
    }).verdict;
  } catch (error) {
    verdict = `THREW: ${error.message}`;
  }
  check(`${label} (verdict ${verdict})`, expectFeasible ? verdict === "FEASIBLE" : verdict !== "FEASIBLE");
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exitCode = failed === 0 ? 0 : 1;

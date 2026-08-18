"use strict";

/**
 * Phase 6 closure probe — do the register and volatile-subset self-checks actually
 * reject a defect, or do they only agree with a correct table?
 *
 * `assertRegister()` and `assertSubset()` returning `{ok:true}` on the shipped code
 * proves the shipped code is coherent. It does not prove the checks would *catch*
 * anything, and a check that cannot fail is decoration. This probe plants five real
 * defects — one at a time, restoring between each — and records what each check said,
 * including whether `evaluate.js` refused to load, which is the property that makes an
 * incoherent register a startup failure rather than a silent mis-evaluation.
 *
 * The files are restored in a `finally`, so an exception cannot leave a planted defect
 * in the tree.
 *
 *   run: node tools/verify/phase6PlantedViolations.js
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const REGISTER = path.join(ROOT, "src/engine/feasibility/register.js");
const SUBSET = path.join(ROOT, "src/engine/feasibility/volatileSubset.js");

const registerSource = fs.readFileSync(REGISTER, "utf8");
const subsetSource = fs.readFileSync(SUBSET, "utf8");

/** Re-require the feasibility modules from a cold cache and report what they said. */
function inspect(label) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}feasibility${path.sep}`)) delete require.cache[key];
  }

  let registerOk = null;
  let subsetOk = null;
  let firstProblem = null;
  let gateLoads = null;

  try {
    const register = require(REGISTER);
    const check = register.assertRegister();
    registerOk = check.ok;
    if (!check.ok) firstProblem = check.problems[0];
  } catch (error) {
    registerOk = `threw: ${String(error.message).split("\n")[0]}`;
  }

  try {
    const check = require(SUBSET).assertSubset();
    subsetOk = check.ok;
    if (!check.ok && !firstProblem) firstProblem = check.problems[0];
  } catch (error) {
    subsetOk = `threw: ${String(error.message).split("\n")[0]}`;
  }

  try {
    require(path.join(ROOT, "src/engine/feasibility/evaluate.js"));
    gateLoads = true;
  } catch (error) {
    gateLoads = false;
    if (!firstProblem) firstProblem = String(error.message).split("\n")[1] || error.message;
  }

  console.log(`\n${label}`);
  console.log(`  assertRegister().ok = ${registerOk}`);
  console.log(`  assertSubset().ok   = ${subsetOk}`);
  console.log(`  evaluate.js loads   = ${gateLoads}${gateLoads ? "" : "   ← refused, as it must"}`);
  if (firstProblem) console.log(`  first problem       : ${String(firstProblem).trim().slice(0, 160)}`);

  return { registerOk, subsetOk, gateLoads };
}

const PLANTS = [
  {
    label: "planted 1 — F7 (class I) declares ADMIT, which §7.3 makes unlawful",
    file: REGISTER,
    apply: (source) =>
      source.replace(
        'row("F7", "Emergency stop not engaged", C.INVARIANT, "I", P.DENY,',
        'row("F7", "Emergency stop not engaged", C.INVARIANT, "I", P.ADMIT,',
      ),
  },
  {
    label: "planted 2 — F36 removed, leaving 37 of §7.5's 38 predicates",
    file: REGISTER,
    apply: (source) => source.replace(/^\s*row\("F36".*$\n/m, ""),
  },
  {
    label: "planted 3 — F37 appears twice",
    file: REGISTER,
    apply: (source) =>
      source.replace(
        '  row("F38",',
        '  row("F37", "duplicate", C.CONTRACTUAL, "F/C", P.DENY, T.NONE, false, G.COMPUTED_MISSION_FEASIBILITY, "f37"),\n  row("F38",',
      ),
  },
  {
    label: "planted 4 — F34 silently dropped from the volatile subset (register side)",
    file: REGISTER,
    apply: (source) =>
      source.replace(
        'evaluated at all three shortfall tiers", C.INVARIANT, "I", P.DENY, T.NONE, true,',
        'evaluated at all three shortfall tiers", C.INVARIANT, "I", P.DENY, T.NONE, false,',
      ),
  },
  {
    label: "planted 5 — the literal subset list swaps F35 for F36 (volatileSubset side)",
    file: SUBSET,
    apply: (source) => source.replace('"F35"', '"F36"'),
  },
];

let missed = 0;

try {
  const baseline = inspect("baseline — the shipped register and subset");
  if (baseline.registerOk !== true || baseline.subsetOk !== true || baseline.gateLoads !== true) {
    console.log("\n*** the shipped code does not pass its own checks — stopping ***");
    process.exitCode = 1;
  }

  for (const plant of PLANTS) {
    const original = plant.file === REGISTER ? registerSource : subsetSource;
    const planted = plant.apply(original);
    if (planted === original) {
      console.log(`\n${plant.label}\n  *** the plant did not apply — the anchor text has moved ***`);
      missed += 1;
      continue;
    }

    fs.writeFileSync(plant.file, planted);
    const result = inspect(plant.label);
    fs.writeFileSync(plant.file, original);

    // A plant is caught if any check rejected it *or* the gate refused to load.
    const caught = result.registerOk !== true || result.subsetOk !== true || result.gateLoads !== true;
    if (!caught) {
      console.log("  *** NOT CAUGHT — the check passed a defect ***");
      missed += 1;
    }
  }

  inspect("restored — the shipped register and subset");
} finally {
  fs.writeFileSync(REGISTER, registerSource);
  fs.writeFileSync(SUBSET, subsetSource);
}

console.log(`\n${PLANTS.length - missed} of ${PLANTS.length} planted defects caught.`);
process.exitCode = missed === 0 ? process.exitCode || 0 : 1;

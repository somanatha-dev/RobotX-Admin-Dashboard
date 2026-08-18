"use strict";

/**
 * Phase 6 closure probe — does F34's verdict agree with `energy/tiers.js`'s verdict?
 *
 * F34 deliberately re-derives its own α[tier] targets rather than reading the `target`
 * field the producer already computed: it must not take the threshold from the module
 * whose output it is checking. That independence is only safe while the two
 * transcriptions of `energy.shortfall_probability` agree on how the map is indexed.
 *
 * This probe compares **verdicts**, not internal reads, across every map shape the
 * parameter could plausibly be published in. For each shape it picks a shortfall
 * probability that sits between the two candidate α values, so the two modules can only
 * agree if they resolved the same target.
 *
 *   run: node tools/verify/phase6AlphaProbe.js
 */

const tiers = require("../../src/engine/energy/tiers");
const f34 = require("../../src/engine/feasibility/predicates/f34");

const SLA_CLASS = "CRITICAL";

const SHAPES = [
  {
    label: "flat tier-keyed (what config/derived.js publishes, per Appendix A indexedBy:[tier])",
    map: { T1: 1e-2, T2: 1e-5, T3: 1e-7 },
    // Comfortably inside every target: both modules must call this feasible.
    probabilities: { T1: 1e-3, T2: 1e-6, T3: 1e-8 },
  },
  {
    label: "SLA-class-keyed (the shape energy/tiers.js documents as winning)",
    map: { T1: 1e-2, T2: 1e-5, T3: 1e-7, [SLA_CLASS]: { T1: 1e-4, T2: 1e-6, T3: 1e-9 } },
    // Between the class target (1e-4) and the fleet default (1e-2): infeasible under
    // the class target, feasible under the default. The two can only agree if they
    // resolved the same α.
    probabilities: { T1: 1e-3, T2: 1e-7, T3: 1e-10 },
  },
  {
    label: "tier-then-class (the transposed shape — neither module's declared contract)",
    map: { T1: { [SLA_CLASS]: 1e-4 }, T2: { [SLA_CLASS]: 1e-6 }, T3: { [SLA_CLASS]: 1e-9 } },
    probabilities: { T1: 1e-3, T2: 1e-7, T3: 1e-10 },
  },
];

let divergences = 0;

for (const shape of SHAPES) {
  const config = { "energy.shortfall_probability": shape.map };

  // The producer's own verdict, computed from Wh rather than supplied probabilities, so
  // that the probabilities below are the ones it would itself have published.
  const producer = tiers.evaluate({
    usableWh: 700,
    distribution: { meanWh: 200, sdWh: 20 },
    layers: { floorWh: 80, returnWh: 120, contingencyWh: 40, operationalWh: 0 },
    config,
    slaClass: SLA_CLASS,
  });

  // The predicate's verdict on a fragment carrying the chosen probabilities.
  const verdict = f34.evaluate({
    mission: { slaClass: SLA_CLASS },
    plan: { energy: { tierProbabilities: shape.probabilities } },
    config,
  });

  // What each module concluded about the *same* α resolution question.
  const producerResolved = producer.ok;
  const predicateResolved = verdict.outcome !== "INDETERMINATE";

  // A tier-by-tier comparison of the target each module used, recovered from output.
  const producerTargets = producerResolved
    ? Object.fromEntries(producer.tiers.map((row) => [row.tier, row.target]))
    : null;
  const predicateTargets =
    verdict.outcome === "SATISFIED"
      ? verdict.required.alpha
      : verdict.outcome === "VIOLATED"
        ? { [verdict.required.tier]: verdict.required.alpha }
        : null;

  const agreeOnResolvability = producerResolved === predicateResolved;
  let agreeOnTargets = true;
  if (producerTargets && predicateTargets) {
    for (const tier of Object.keys(predicateTargets)) {
      if (producerTargets[tier] !== predicateTargets[tier]) agreeOnTargets = false;
    }
  }

  const ok = agreeOnResolvability && agreeOnTargets;
  if (!ok) divergences += 1;

  console.log(`\n${shape.label}`);
  console.log(`  energy/tiers.js : ok=${producerResolved} targets=${JSON.stringify(producerTargets)}`);
  console.log(`  f34.js          : outcome=${verdict.outcome} targets=${JSON.stringify(predicateTargets)}`);
  console.log(`  ${ok ? "AGREE" : "*** DIVERGE ***"}`);
}

console.log(`\n${divergences} divergence(s) across ${SHAPES.length} map shapes.`);
process.exitCode = divergences === 0 ? 0 : 1;

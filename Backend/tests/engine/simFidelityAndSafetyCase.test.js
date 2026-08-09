"use strict";

/**
 * Engine lane — the simulator's one-sided fidelity gate (§24.4) and the safety case
 * assembled from queries (§24.7).
 *
 * Both are release gates, and both have the same characteristic failure mode: producing
 * confidence rather than evidence. §24.4 says it outright — "an unvalidated simulator is a
 * release gate that produces confidence rather than evidence" — and §24.7's whole design is
 * to stop the safety case being "a documentation exercise". The tests below are therefore
 * mostly about what each refuses to claim.
 */

const fs = require("fs");
const path = require("path");

const fidelity = require("../../tools/simFidelity/validate");
const safetyCase = require("../../tools/safetyCase/assemble");
const feasibilityRegister = require("../../src/engine/feasibility/register");
const invariantChecker = require("../../src/engine/observability/invariantChecker");
const service = require("../../src/engine/config/service");

/** A study with one slice per model, at a given signed relative bias. */
function studyAt(bias) {
  const models = {};
  for (const model of fidelity.MODELS) {
    models[model.id] = {
      slices: [{ slice: { zone: "z1", agentClass: "c1", bucket: "peak" }, realisedMean: 100, simulatedMean: 100 * (1 + bias) }],
    };
  }
  return { models };
}

describe("§24.4 — the fidelity gate is one-sided, because the risk is", () => {
  test("an optimistic bias beyond the bound FAILS, and names the slice", () => {
    // Optimistic means "flatters the engine", which for every safety-relevant model here is
    // the simulator being *below* reality: faster, hungrier-for-less, failing less often.
    const result = fidelity.validate({ study: studyAt(-0.20), maxOptimisticBias: 0.05 });

    expect(result.ok).toBe(false);
    expect(result.mayDischargeTierZero).toBe(false);
    const energy = result.results.find((row) => row.id === "ENERGY_CONSUMPTION");
    expect(energy.verdict).toBe(fidelity.VERDICT.OPTIMISTIC_BIAS_EXCEEDED);
    expect(energy.detail).toMatch(/optimistic by 20\.0 %/);
    expect(energy.detail).toMatch(/"zone":"z1"/);
  });

  test("a PESSIMISTIC bias of the same magnitude does NOT fail", () => {
    // The asymmetry is the whole point. §24.4: "Simulator bias in the pessimistic direction
    // costs approvals; bias in the optimistic direction costs incidents." A two-sided gate
    // here would fail exactly the simulators that are safe to trust.
    const result = fidelity.validate({ study: studyAt(0.20), maxOptimisticBias: 0.05 });

    expect(result.ok).toBe(true);
    const energy = result.results.find((row) => row.id === "ENERGY_CONSUMPTION");
    expect(energy.verdict).toBe(fidelity.VERDICT.PESSIMISTIC);
    expect(energy.detail).toMatch(/Reported, not failed/);
  });

  test("a bias within the bound passes and may discharge a Tier 0 obligation", () => {
    const result = fidelity.validate({ study: studyAt(-0.01), maxOptimisticBias: 0.05 });
    expect(result.ok).toBe(true);
    expect(result.mayDischargeTierZero).toBe(true);
  });

  test("the WORST slice decides, never the mean", () => {
    // §24.4 requires the comparison "per zone, agent class, and time bucket" precisely so a
    // systematically optimistic depot cannot disappear into a population that is fine on
    // average. A mean over these three slices is −0.01; the worst is −0.30.
    const study = {
      models: {
        ENERGY_CONSUMPTION: {
          slices: [
            { slice: { zone: "healthy-a" }, realisedMean: 100, simulatedMean: 114 },
            { slice: { zone: "healthy-b" }, realisedMean: 100, simulatedMean: 113 },
            { slice: { zone: "the-depot" }, realisedMean: 100, simulatedMean: 70 },
          ],
        },
      },
    };
    const result = fidelity.validate({ study, maxOptimisticBias: 0.05 });

    expect(result.ok).toBe(false);
    const energy = result.results.find((row) => row.id === "ENERGY_CONSUMPTION");
    expect(energy.worstSlice.slice).toEqual({ zone: "the-depot" });
  });

  test("an unmeasured model is NOT a pass, and blocks the Tier 0 discharge", () => {
    const result = fidelity.validate({ study: { models: {} }, maxOptimisticBias: 0.05 });

    // `ok` is true — nothing exceeded the bound, because nothing was measured — and that is
    // exactly why `mayDischargeTierZero` exists as a separate answer. A caller that only
    // read `ok` would conclude the simulator was validated.
    expect(result.ok).toBe(true);
    expect(result.mayDischargeTierZero).toBe(false);
    expect(result.results.every((row) => row.verdict === fidelity.VERDICT.NOT_MEASURED)).toBe(true);
    expect(fidelity.formatReport(result)).toMatch(/MAY NOT discharge a Tier 0 verification obligation/);
  });

  test("a scenario with no real-world counterpart is UNVALIDATABLE, and says so", () => {
    // §24.4: "Scenarios with no real-world counterpart are labelled as such … so that no one
    // later reads an unvalidatable scenario as validated." Most of §18's failure catalogue
    // is exactly this — it cannot be observed often enough to validate against, which is
    // why it is simulated in the first place.
    const study = {
      models: {
        FAILURE_RATE: { unvalidatable: true, unvalidatableReason: "simultaneous multi-agent failure has never occurred" },
      },
    };
    const result = fidelity.validate({ study, maxOptimisticBias: 0.05 });
    const failure = result.results.find((row) => row.id === "FAILURE_RATE");

    expect(failure.verdict).toBe(fidelity.VERDICT.UNVALIDATABLE);
    expect(failure.detail).toMatch(/never occurred/);
    expect(result.mayDischargeTierZero).toBe(false);
  });

  test("the three models §24.4 names explicitly are all marked safety-relevant", () => {
    // "Bias beyond `sim.max_optimistic_bias` on any safety-relevant model — energy, charge,
    // failure — fails the simulator's own release gate."
    for (const id of ["ENERGY_CONSUMPTION", "CHARGE_DURATION", "FAILURE_RATE"]) {
      expect({ id, safetyRelevant: fidelity.MODEL_BY_ID[id].safetyRelevant }).toEqual({ id, safetyRelevant: true });
    }
  });

  test("the bound comes from the register, and it is Safety-class", () => {
    const entry = service.loadRegister().entries.get("sim.max_optimistic_bias");
    expect(entry.changeClass).toBe("SAFETY");
    expect(fidelity.validate({ study: { models: {} } }).bound).toBe(entry.default);
  });

  test("a slice with no comparable pair of means is not silently scored", () => {
    const study = { models: { ENERGY_CONSUMPTION: { slices: [{ slice: {}, realisedMean: 0, simulatedMean: 50 }] } } };
    const result = fidelity.validate({ study, maxOptimisticBias: 0.05 });
    expect(result.results.find((row) => row.id === "ENERGY_CONSUMPTION").verdict).toBe(fidelity.VERDICT.NOT_MEASURED);
  });
});

describe("§24.7 — the safety case is a query, not a document", () => {
  const assembled = safetyCase.assemble();

  test("it assembles, and every reference into the shipped registers resolves", () => {
    expect(assembled.problems).toEqual([]);
    expect(assembled.ok).toBe(true);
    expect(assembled.rows.length).toBeGreaterThanOrEqual(12);
  });

  test("classes and policies are READ from the constraint register, never restated", () => {
    // The property that makes the case unable to go stale: reclassify a predicate and the
    // case changes on the next assembly, without anyone editing a document.
    for (const row of assembled.rows) {
      for (const constraint of row.constraints) {
        const live = feasibilityRegister.predicate(constraint.id);
        expect({ id: constraint.id, class: constraint.constraintClass }).toEqual({
          id: constraint.id,
          class: live.constraintClass,
        });
        expect({ id: constraint.id, waivable: constraint.waivable }).toEqual({
          id: constraint.id,
          waivable: !["I", "R", "F"].includes(live.constraintClass),
        });
      }
    }
  });

  test("a hazard naming a predicate that does not exist FAILS assembly", () => {
    // Not a footnote. A safety case whose mitigation does not exist is worse than no safety
    // case, because it is believed.
    const resolved = safetyCase.resolveHazard(
      { id: "H-TEST", title: "planted", mitigatedByPredicates: ["F99"], monitoredByInvariants: [] },
      {},
    );
    expect(resolved.problems[0]).toMatch(/F99/);
    expect(resolved.problems[0]).toMatch(/worse than no safety case/);
  });

  test("a hazard naming an invariant with no implemented check FAILS assembly", () => {
    const resolved = safetyCase.resolveHazard(
      { id: "H-TEST", title: "planted", mitigatedByPredicates: [], monitoredByInvariants: ["I99"] },
      {},
    );
    expect(resolved.problems[0]).toMatch(/I99/);
    expect(resolved.problems[0]).toMatch(/An invariant nobody checks is a comment/);
  });

  test("a hazard with no mitigation at all FAILS assembly", () => {
    // An enumerated hazard with no mitigation is a hazard that has been noticed and not
    // addressed, which is a worse state than one nobody enumerated.
    const resolved = safetyCase.resolveHazard(
      { id: "H-TEST", title: "planted", mitigatedByPredicates: [], monitoredByInvariants: [] },
      {},
    );
    expect(resolved.problems[0]).toMatch(/neither a mitigating constraint nor a monitoring invariant/);
  });

  test("the hand-written input carries hazards and NO evidence", () => {
    // The structural guarantee. If `hazards.json` carried a class, a status or a gate
    // result, the case would be prose again — and the prose would be the thing that goes
    // stale.
    const parsed = JSON.parse(fs.readFileSync(safetyCase.HAZARDS_FILE, "utf8"));

    // The key set is the guarantee, and it is asserted exactly rather than as a subset: an
    // added field is a field the assembler would not read, which is how evidence creeps
    // back into the hand-written half.
    for (const hazard of parsed.hazards) {
      expect(Object.keys(hazard).sort()).toEqual(
        ["description", "id", "mitigatedByPredicates", "monitoredByInvariants", "section", "severity", "title"].sort(),
      );
      // The two evidence-bearing fields carry *identifiers only*. A class, a policy or a
      // status here would be a second copy of a register that can disagree with it.
      for (const predicateId of hazard.mitigatedByPredicates) expect(predicateId).toMatch(/^F\d+$/);
      for (const invariantId of hazard.monitoredByInvariants) expect(invariantId).toMatch(/^I\d+$/);
    }

    // Descriptions are prose and may quote the specification — H12's names `authoriseEnable`
    // and the word GREEN, for instance — so a string sweep over the whole file would be a
    // check on English rather than on structure. The structure is what matters.
    expect(parsed.hazards.length).toBeGreaterThanOrEqual(12);
  });

  test("the rendered document says it is generated, and names every source it read", () => {
    const rendered = safetyCase.render(assembled);
    expect(rendered).toMatch(/\*\*This file is generated\. Do not edit it\.\*\*/);
    expect(rendered).toMatch(/feasibility\/register\.js/);
    expect(rendered).toMatch(/observability\/invariantChecker\.js/);
    expect(rendered).toMatch(/cutover\/gates\.js/);
    // The gate table travels with it, so "which hazards are mitigated" and "which evidence
    // exists" are read side by side rather than from two places.
    expect(rendered).toMatch(/## Verification evidence — the §24 release gates/);
    expect(rendered).toMatch(/NOT_EVALUATED` blocks the cutover exactly as/);
  });

  test("H12 — the hazard this phase itself creates — is enumerated", () => {
    // Cutting a fleet over before its evidence exists is a hazard, and a safety case that
    // omitted the one its own phase introduced would be exactly the documentation exercise
    // §24.7 rejects.
    const row = assembled.rows.find((entry) => entry.hazard.id === "H12");
    expect(row).toBeTruthy();
    expect(row.hazard.title).toMatch(/before its verification evidence exists/);
    expect(row.hazard.description).toMatch(/authoriseEnable/);
  });

  test("every invariant the case monitors is one the checker actually implements", () => {
    const implemented = new Set(Object.keys(invariantChecker.CHECKS));
    for (const row of assembled.rows) {
      for (const invariant of row.invariants) {
        expect({ id: invariant.id, implemented: implemented.has(invariant.id) }).toEqual({ id: invariant.id, implemented: true });
      }
    }
  });

  test("the generated document on disk is current", () => {
    // A generated artefact that has drifted from its generator is worse than none. This
    // fails if someone edits `hazards.json` or a register without re-running the assembler.
    const onDisk = fs.readFileSync(path.join(__dirname, "..", "..", "..", "docs", "safety-case", "SAFETY_CASE.md"), "utf8");
    expect(onDisk).toBe(safetyCase.render(assembled));
  });
});

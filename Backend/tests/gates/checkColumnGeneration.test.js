"use strict";

/**
 * Gates lane — §21.6's column-generation release gate.
 *
 * The gate exists because of one sentence in §21.6: "an exact solve over a poor column set
 * produces an exact but poor result, and no in-round signal reveals it." Every other gate in
 * this lane catches something a test could also catch. This one catches something that, by
 * construction, nothing else can see — which is why §21.6 makes it a release gate and not a
 * periodic report, and why `PHASE_11_INDEPENDENT_VERIFICATION.md` Finding 1 treated "wired as a
 * release gate" being untrue as a real finding rather than a documentation slip.
 *
 * Each test plants the specific way the gate could be silently defeated: a generation change
 * with no measurement, a budget change dressed as a config edit, a regression inside the
 * measurement, and an unreadable change set.
 */

const gate = require("../../tools/gates/checkColumnGeneration");

/** A `counterfactual.run()` pair. Values are in milli-CU, as `run()` emits them. */
const reportWith = (baselineGap, candidateGap, maxRegressionCU) => ({
  baseline: { columnGenerationGapMilliCU: baselineGap },
  candidate: { columnGenerationGapMilliCU: candidateGap },
  maxRegressionCU,
});

/** A git runner that answers from a fixture instead of the real repository. */
const gitReturning = (responses) => (args) => {
  const key = args.join(" ");
  for (const [prefix, value] of Object.entries(responses)) {
    if (key.startsWith(prefix)) return value;
  }
  throw new Error(`unexpected git invocation: ${key}`);
};

describe("THE GATE DOES NOT FIRE on changes §21.6 does not name", () => {
  test("an unrelated change is NOT_REQUIRED and passes", () => {
    const result = gate.checkColumnGeneration({ changed: ["Backend/src/engine/energy/wear.js", "README.md"] });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("NOT_REQUIRED");
    expect(result.trigger.required).toBe(false);
  });

  test("a change to the solver itself is not a change to generation", () => {
    // §21.6's distinction, and the whole reason the gate is narrow: the solve makes *selection*
    // exact. Selection is not what this gate guards, and widening it to the solver would make
    // the gate fire so often that it would be routed around.
    const result = gate.checkColumnGeneration({ changed: ["Backend/src/engine/solve/minCostFlow.js"] });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("NOT_REQUIRED");
  });

  test("touching the register without moving either budget does not fire", () => {
    const registerNow = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "..", gate.REGISTER_PATH),
      "utf8",
    );
    const result = gate.checkColumnGeneration({
      changed: [gate.REGISTER_PATH],
      base: "HEAD",
      git: gitReturning({ show: registerNow }),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("NOT_REQUIRED");
  });
});

describe("THE GATE FAILS on each way a generation regression could ship unmeasured", () => {
  test.each(gate.GATED_SOURCE_PATHS)("%s changed with no evaluator report", (module) => {
    const result = gate.checkColumnGeneration({ changed: [module] });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("REPORT_REQUIRED");
    expect(result.trigger.reasons.join(" ")).toContain(module);
  });

  test.each(gate.GATED_PARAMETERS)("%s moved, dressed as an ordinary register edit", (parameter) => {
    // The subtle one. §21.6: "a budget change is a heuristic change in effect", and a budget cut
    // is how a generation heuristic is most easily degraded without touching a line of its code.
    const before = JSON.stringify([{ name: parameter, default: 1 }]);
    const result = gate.checkColumnGeneration({
      changed: [gate.REGISTER_PATH],
      base: "HEAD",
      git: gitReturning({ show: before }),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("REPORT_REQUIRED");
    expect(result.trigger.reasons.join(" ")).toContain(parameter);
  });

  test("a measured regression beyond the allowance blocks the release", () => {
    // The gate's actual verdict, delegated to `counterfactual.gate()` unchanged: the candidate's
    // column-generation gap is 500 milli-CU wider than the baseline's against a zero allowance.
    const result = gate.checkColumnGeneration({
      changed: ["Backend/src/engine/plan/columnBuilder.js"],
      report: reportWith("1000", "1500", 0),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("REGRESSION");
    expect(result.verdict.regressionMilliCU).toBe("500");
    expect(result.verdict.parameter).toBe("solve.max_generation_gap_regression");
  });

  test("an unmeasured report is refused rather than waved through", () => {
    const result = gate.checkColumnGeneration({
      changed: ["Backend/src/engine/plan/columnBuilder.js"],
      report: reportWith(null, null, 0),
    });

    expect(result.ok).toBe(false);
    expect(result.verdict.reason).toBe("NO_MEASUREMENT");
  });

  test("an unresolvable change set fails closed", () => {
    // Not knowing what changed is strictly weaker than knowing, so it cannot license a weaker
    // verdict. A shallow CI clone is the realistic way this happens.
    const result = gate.checkColumnGeneration({
      base: "origin/main",
      git: () => {
        throw new Error("fatal: bad revision");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.trigger.indeterminate).toBe(true);
    expect(result.trigger.required).toBe(true);
  });
});

describe("THE GATE PASSES a generation change that measured clean", () => {
  test("a gap that did not widen is admitted", () => {
    const result = gate.checkColumnGeneration({
      changed: ["Backend/src/engine/plan/columnBuilder.js"],
      report: reportWith("1000", "900", 0),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("PASS");
  });

  test("a widening inside the allowance is admitted", () => {
    // The allowance is `solve.max_generation_gap_regression`, in CU; 1 CU admits 1000 milli-CU.
    const result = gate.checkColumnGeneration({
      changed: ["Backend/src/engine/plan/columnBuilder.js"],
      report: reportWith("1000", "1500", 1),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("PASS");
  });
});

describe("the gate's own wiring", () => {
  test("it is invoked by an npm script — the defect Phase 11 Finding 1 recorded", () => {
    // Finding 1 was not that the gate logic was wrong; it was that "wired as a release gate" was
    // untrue because nothing ran it. This test is what makes that statement true and keeps it so.
    const scripts = require("../../package.json").scripts;

    expect(scripts["gate:columngen"]).toContain("tools/gates/checkColumnGeneration.js");
    expect(scripts.gates).toContain("gate:columngen");
  });

  test("the report names every §21.6 gated change so the reader is told what to produce", () => {
    const text = gate.formatReport(gate.checkColumnGeneration({ changed: ["Backend/src/engine/plan/column.js"] }));

    expect(text).toContain("FAIL");
    expect(text).toContain("plan.max_columns_per_round");
    expect(text).toContain("plan.max_bundle_size");
  });
});

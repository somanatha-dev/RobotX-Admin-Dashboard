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

/**
 * The trigger's own semantics, isolated from whatever release decisions the repository happens
 * to carry today. Tests that mean "this path fires the gate" pass `classifications: []` so they
 * keep meaning that after a decision is recorded; the recorded decisions get their own block.
 */
const unclassified = (options) => ({ classifications: [], ...options });

describe("THE GATE FAILS on each way a generation regression could ship unmeasured", () => {
  test.each(gate.GATED_SOURCE_PATHS)("%s changed with no evaluator report", (module) => {
    const result = gate.checkColumnGeneration(unclassified({ changed: [module] }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("REPORT_REQUIRED");
    expect(result.trigger.reasons.join(" ")).toContain(module);
  });

  test.each(gate.GATED_PARAMETERS)("%s moved, dressed as an ordinary register edit", (parameter) => {
    // The subtle one. §21.6: "a budget change is a heuristic change in effect", and a budget cut
    // is how a generation heuristic is most easily degraded without touching a line of its code.
    const before = JSON.stringify([{ name: parameter, default: 1 }]);
    const result = gate.checkColumnGeneration(unclassified({
      changed: [gate.REGISTER_PATH],
      base: "HEAD",
      git: gitReturning({ show: before }),
    }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("REPORT_REQUIRED");
    expect(result.trigger.reasons.join(" ")).toContain(parameter);
  });

  test("a measured regression beyond the allowance blocks the release", () => {
    // The gate's actual verdict, delegated to `counterfactual.gate()` unchanged: the candidate's
    // column-generation gap is 500 milli-CU wider than the baseline's against a zero allowance.
    const result = gate.checkColumnGeneration(unclassified({
      changed: ["Backend/src/engine/plan/columnBuilder.js"],
      report: reportWith("1000", "1500", 0),
    }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe("REGRESSION");
    expect(result.verdict.regressionMilliCU).toBe("500");
    expect(result.verdict.parameter).toBe("solve.max_generation_gap_regression");
  });

  test("an unmeasured report is refused rather than waved through", () => {
    const result = gate.checkColumnGeneration(unclassified({
      changed: ["Backend/src/engine/plan/columnBuilder.js"],
      report: reportWith(null, null, 0),
    }));

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
    const result = gate.checkColumnGeneration(unclassified({
      changed: ["Backend/src/engine/plan/columnBuilder.js"],
      report: reportWith("1000", "900", 0),
    }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("PASS");
  });

  test("a widening inside the allowance is admitted", () => {
    // The allowance is `solve.max_generation_gap_regression`, in CU; 1 CU admits 1000 milli-CU.
    const result = gate.checkColumnGeneration(unclassified({
      changed: ["Backend/src/engine/plan/columnBuilder.js"],
      report: reportWith("1000", "1500", 1),
    }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("PASS");
  });
});

describe("THE GATE CAN SEE THE CHANGE SET IT IS GIVEN", () => {
  // Every test above hands `changed:` an explicit list, which bypasses `changedPaths()`
  // entirely. That is how the parser defect below survived a green suite: the gate was
  // wired into `npm run gates` and into CI, ran on every build, and could not recognise a
  // single worktree path — so it reported NOT_REQUIRED on a tree with `columnBuilder.js`
  // modified in it. These tests drive the real parser.

  test("an unstaged modification is recognised — the whole path, not the path minus its first character", () => {
    // `git status --porcelain` writes `XY<space><path>`, and an unset status character is a
    // SPACE: an unstaged modification reads `" M Backend/…"`. Trimming the line before
    // slicing the 3-character status field eats the first character of every such path.
    const paths = gate.parsePorcelain(" M Backend/src/engine/plan/columnBuilder.js\n");

    expect(paths).toEqual(["Backend/src/engine/plan/columnBuilder.js"]);
    expect(paths[0].startsWith("Backend/")).toBe(true);
  });

  test.each([
    [" M Backend/src/engine/plan/columnBuilder.js", "Backend/src/engine/plan/columnBuilder.js", "unstaged modification"],
    ["M  Backend/src/engine/plan/column.js", "Backend/src/engine/plan/column.js", "staged modification"],
    ["MM Backend/src/engine/plan/consolidation.js", "Backend/src/engine/plan/consolidation.js", "staged and then modified"],
    ["?? Backend/src/engine/plan/multiLegColumn.js", "Backend/src/engine/plan/multiLegColumn.js", "untracked"],
    ["A  Backend/src/engine/plan/columnBuilder.js", "Backend/src/engine/plan/columnBuilder.js", "added"],
    ['R  Backend/src/engine/plan/old.js -> Backend/src/engine/plan/columnBuilder.js', "Backend/src/engine/plan/columnBuilder.js", "renamed — the destination carries the code"],
  ])("%s parses to %s (%s)", (line, expected) => {
    expect(gate.parsePorcelain(`${line}\n`)).toEqual([expected]);
  });

  test("a real worktree status makes the gate FIRE, end to end through changedPaths", () => {
    // The composition the defect broke: porcelain text → parser → gated-path comparison →
    // verdict. Asserted through `checkColumnGeneration` rather than through the parser
    // alone, because the parser being right is only interesting if the comparison sees it.
    const porcelain = [
      " M Backend/prisma/schema.prisma",
      " M Backend/src/engine/plan/columnBuilder.js",
      "?? PHASE_11_REMEDIATION_AND_CLOSURE.md",
      "",
    ].join("\n");

    const result = gate.checkColumnGeneration({ git: gitReturning({ status: porcelain }) });

    expect(result.trigger.paths).toContain("Backend/src/engine/plan/columnBuilder.js");
    expect(result.ok).toBe(false);
    expect(result.status).toBe("REPORT_REQUIRED");
  });

  test("a worktree that touches nothing gated still passes — the gate stays narrow", () => {
    const porcelain = " M Backend/src/engine/solve/minCostFlow.js\n M README.md\n";
    const result = gate.checkColumnGeneration({ git: gitReturning({ status: porcelain }) });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("NOT_REQUIRED");
    // Both paths intact: the failure mode was silent truncation, so the count is not enough.
    expect(result.trigger.paths).toEqual(["Backend/src/engine/solve/minCostFlow.js", "README.md"]);
  });

  test("committed changes against a base and worktree changes are both seen", () => {
    // A gate that read only one of the two is evaded by not committing, or by committing.
    const result = gate.changedPaths({
      base: "origin/main",
      git: gitReturning({
        diff: "Backend/src/engine/plan/column.js\n",
        status: " M Backend/src/engine/plan/columnBuilder.js\n",
      }),
    });

    expect(result.paths.sort()).toEqual([
      "Backend/src/engine/plan/column.js",
      "Backend/src/engine/plan/columnBuilder.js",
    ]);
  });
});

describe("A RELEASE-OWNER CLASSIFICATION IS PINNED TO CONTENT, AND IS NOT A WAIVER", () => {
  // §21.6's trigger is a *path* proxy for four surfaces, so a change can land in a gated file
  // and touch none of them. `PHASE_11_REMEDIATION_AND_CLOSURE.md` BLOCKER-1 assigned that call
  // to a human. These tests are the reason a human's call cannot become a general bypass: every
  // one of them plants a way the mechanism could be turned into one.

  const CLASSIFIED = "Backend/src/engine/plan/columnBuilder.js";
  const BASE = "748372cb054fbeda3e22d7c4813ad763ef76a199";
  const CURRENT = "78fa8756381cd013d5cebf2e58895c84e4963fd6";

  const record = (overrides) => ({
    id: "RD-TEST-01",
    recorded: "2026-08-18",
    owner: "release owner",
    section: "§21.6",
    path: CLASSIFIED,
    baseBlob: BASE,
    currentBlob: CURRENT,
    surfacesAffected: [],
    rationale: "wires an existing guard; alters no §21.6 surface",
    ...overrides,
  });

  /** git answering the two object-name queries the matcher makes. */
  const gitBlobs = (base, current) =>
    gitReturning({ "rev-parse": `${base}\n`, "hash-object": `${current}\n` });

  test("a record matching BOTH blob names suppresses its own path's trigger", () => {
    const result = gate.checkColumnGeneration({
      changed: [CLASSIFIED],
      classifications: [record()],
      git: gitBlobs(BASE, CURRENT),
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("NOT_REQUIRED");
    expect(result.trigger.classified).toHaveLength(1);
    expect(result.trigger.classified[0].id).toBe("RD-TEST-01");
  });

  test("MUTATION — one byte of drift in the classified file re-raises the gate", () => {
    // The property the whole mechanism rests on. If a classification survived an edit it would
    // be a standing exemption for the file, which is exactly what it must not be.
    const drifted = "0000000000000000000000000000000000000000";
    const result = gate.checkColumnGeneration({
      changed: [CLASSIFIED],
      classifications: [record()],
      git: gitBlobs(BASE, drifted),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("REPORT_REQUIRED");
    expect(result.trigger.classified).toHaveLength(0);
    // And it says so, rather than reading as a file nobody ever classified.
    expect(result.trigger.reasons.join(" ")).toContain("RD-TEST-01");
    expect(result.trigger.reasons.join(" ")).toContain(drifted);
  });

  test("MUTATION — a different base re-raises the gate, so a rebase cannot inherit a decision", () => {
    // The subtler half. Pinning only the post-change content would let the same record discharge
    // a *different* diff that happened to land on the same bytes from somewhere else.
    const result = gate.checkColumnGeneration({
      changed: [CLASSIFIED],
      classifications: [record()],
      git: gitBlobs("1111111111111111111111111111111111111111", CURRENT),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("REPORT_REQUIRED");
    expect(result.trigger.reasons.join(" ")).toContain("but the base is now");
  });

  test("a record that CONCEDES a §21.6 surface is invalid and classifies nothing", () => {
    // The clause that keeps this a classification rather than a waiver: conceding a surface
    // means §21.6 applies, and §21.6 is discharged by a corpus, never by a decision record.
    const result = gate.checkColumnGeneration({
      changed: [CLASSIFIED],
      classifications: [],
      git: gitBlobs(BASE, CURRENT),
    });
    expect(result.ok).toBe(false);

    expect(gate.classificationProblem(record({ surfacesAffected: ["the pruning rule"] }))).toContain("§21.6 surface");
  });

  test("a record cannot suppress a BUDGET move — there is no proxy there to misclassify", () => {
    // `plan.max_columns_per_round` changing value *is* the heuristic change (§21.6). The record
    // below is valid and names a gated path; it must not touch the budget verdict.
    const before = JSON.stringify([{ name: "plan.max_columns_per_round", default: 1 }]);
    const result = gate.checkColumnGeneration({
      changed: [CLASSIFIED, gate.REGISTER_PATH],
      base: "HEAD",
      classifications: [record()],
      git: gitReturning({ "rev-parse": `${BASE}\n`, "hash-object": `${CURRENT}\n`, show: before }),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("REPORT_REQUIRED");
    expect(result.trigger.reasons.join(" ")).toContain("plan.max_columns_per_round");
  });

  test("a record for one gated path does not cover another", () => {
    const result = gate.checkColumnGeneration({
      changed: ["Backend/src/engine/plan/column.js"],
      classifications: [record()],
      git: gitBlobs(BASE, CURRENT),
    });

    expect(result.ok).toBe(false);
    expect(result.trigger.reasons.join(" ")).toContain("Backend/src/engine/plan/column.js");
  });

  test("git failing to name the blobs classifies nothing — the matcher fails closed", () => {
    const result = gate.checkColumnGeneration({
      changed: [CLASSIFIED],
      classifications: [record()],
      git: () => {
        throw new Error("fatal: bad object");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.trigger.reasons.join(" ")).toContain("could not be resolved from git");
  });

  test.each([
    [{ id: "" }, "`id` is missing or empty"],
    [{ owner: undefined }, "`owner` is missing or empty"],
    [{ rationale: "  " }, "`rationale` is missing or empty"],
    [{ section: "§9.3" }, "not \"§21.6\""],
    [{ path: "Backend/src/engine/solve/minCostFlow.js" }, "not one of this gate's column-generation modules"],
    [{ baseBlob: "748372c" }, "not a full 40-character git object name"],
    [{ currentBlob: "not-a-sha" }, "not a full 40-character git object name"],
    [{ currentBlob: BASE }, "there is no change to classify"],
    [{ surfacesAffected: undefined }, "missing or not an array"],
  ])("an invalid record is refused: %j", (overrides, expected) => {
    expect(gate.classificationProblem(record(overrides))).toContain(expected);
  });

  test("an unreadable decision document is rejected, and suppresses nothing", () => {
    const loaded = gate.loadClassifications({
      list: () => ["broken.json", "valid.json"],
      read: (file) => (file === "broken.json" ? "{ not json" : JSON.stringify(record())),
    });

    expect(loaded.records).toHaveLength(1);
    expect(loaded.rejected).toHaveLength(1);
    expect(loaded.rejected[0].file).toBe("broken.json");
  });

  test("a rejected document is named in the output when a gated module changed", () => {
    const text = gate.formatReport(
      gate.checkColumnGeneration({
        changed: [CLASSIFIED],
        classifications: [],
        git: gitBlobs(BASE, CURRENT),
      }),
    );
    expect(text).toContain("FAIL");

    // …and an applied classification is printed on a passing run, so a decision that suppressed
    // a release gate can never be invisible to the person reading the gate's output.
    const passing = gate.formatReport(
      gate.checkColumnGeneration({ changed: [CLASSIFIED], classifications: [record()], git: gitBlobs(BASE, CURRENT) }),
    );
    expect(passing).toContain("release-owner classification");
    expect(passing).toContain("RD-TEST-01");
    expect(passing).toContain("§21.6 surfaces affected: none");
  });

  test("an indeterminate change set consults no classification at all", () => {
    // A record pins a path. With no known path set there is nothing to pin, and the
    // fail-closed branch must not be reachable through a decision document.
    const result = gate.checkColumnGeneration({
      base: "origin/main",
      classifications: [record()],
      git: () => {
        throw new Error("fatal: bad revision");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.trigger.indeterminate).toBe(true);
    expect(result.trigger.classified).toEqual([]);
  });
});

describe("the decisions this repository actually carries", () => {
  test("every recorded release decision is structurally valid", () => {
    // A decision document that silently classifies nothing is the failure a reader should not
    // have to go looking for. This is the check that keeps the directory honest.
    const loaded = gate.loadClassifications();
    expect(loaded.rejected).toEqual([]);
  });

  test("RD-2026-08-18-01 classifies columnBuilder.js and concedes no §21.6 surface", () => {
    const decision = gate.loadClassifications().records.find((entry) => entry.id === "RD-2026-08-18-01");

    expect(decision).toBeDefined();
    expect(decision.path).toBe("Backend/src/engine/plan/columnBuilder.js");
    expect(decision.section).toBe("§21.6");
    expect(decision.surfacesAffected).toEqual([]);
    expect(decision.baseBlob).not.toBe(decision.currentBlob);
    expect(gate.classificationProblem(decision)).toBeNull();
  });

  test("the §21.6 gate itself was not narrowed to accommodate any decision", () => {
    // The four gated modules and both gated budgets, unchanged. A classification changes
    // whether the *trigger* fires for one pinned blob; it removes nothing from this list.
    expect(gate.GATED_SOURCE_PATHS).toEqual([
      "Backend/src/engine/plan/columnBuilder.js",
      "Backend/src/engine/plan/column.js",
      "Backend/src/engine/plan/multiLegColumn.js",
      "Backend/src/engine/plan/consolidation.js",
    ]);
    expect(gate.GATED_PARAMETERS).toEqual(["plan.max_columns_per_round", "plan.max_bundle_size"]);
  });
});

describe("the gate's own wiring", () => {
  test("it is invoked by an npm script — the defect Phase 11 Finding 1 recorded", () => {
    // Finding 1 was not that the gate logic was wrong; it was that "wired as a release gate" was
    // untrue because nothing ran it. This test is what makes that statement true and keeps it so.
    const scripts = require("../../package.json").scripts;

    expect(scripts["gate:columngen"]).toContain("tools/gates/checkColumnGeneration.js");
    expect(scripts.gates).toContain("gate:columngen");
    // `npm run verify` is `gates && test`, so the release command reaches the gate.
    expect(scripts.verify).toContain("gates");
  });

  test("CI runs it on every pull request, with a --base, and fails the job when it fails", () => {
    // "A gate exists in a CLI" is not "CI executes it". Read the workflow, not the intention.
    const workflow = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "..", ".github", "workflows", "ci.yml"),
      "utf8",
    );

    expect(workflow).toContain("npm run gate:columngen");
    // §21.6 gates a *change*, and a change is a diff against a base. Without one the CI
    // checkout — clean by construction — would report NOT_REQUIRED on every single run.
    expect(workflow).toMatch(/gate:columngen[^\n]*--base/);
  });

  test("the CLI exits NON-ZERO on a gated change with no report, and zero otherwise", () => {
    // The property a release process actually depends on. `gate()` returning `ok: false` is
    // worth nothing if the process that ran it exits 0.
    const { spawnSync } = require("child_process");
    const cli = require("path").join(__dirname, "..", "..", "tools", "gates", "checkColumnGeneration.js");

    // `plan/column.js`, not `plan/columnBuilder.js`: the latter carries a recorded release-owner
    // classification (RD-2026-08-18-01) and the real CLI reads real decisions. Using it here
    // would be asserting the absence of a decision that exists.
    const fired = spawnSync(process.execPath, [cli, "--changed", "Backend/src/engine/plan/column.js"], {
      encoding: "utf8",
    });
    expect(fired.status).toBe(1);
    expect(fired.stdout).toContain("REPORT_REQUIRED");

    const quiet = spawnSync(process.execPath, [cli, "--changed", "Backend/src/engine/solve/minCostFlow.js"], {
      encoding: "utf8",
    });
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toContain("NOT_REQUIRED");
  });

  test("the CLI exits non-zero on a MEASURED regression, through --report", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { spawnSync } = require("child_process");

    const reportPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "columngen-")), "run.json");
    fs.writeFileSync(reportPath, JSON.stringify(reportWith("1000", "1500", 0)), "utf8");

    const cli = path.join(__dirname, "..", "..", "tools", "gates", "checkColumnGeneration.js");
    const run = spawnSync(
      process.execPath,
      [cli, "--report", reportPath, "--changed", "Backend/src/engine/plan/column.js"],
      { encoding: "utf8" },
    );

    expect(run.status).toBe(1);
    expect(run.stdout).toContain("REGRESSION");
  });

  test("the report names every §21.6 gated change so the reader is told what to produce", () => {
    const text = gate.formatReport(gate.checkColumnGeneration({ changed: ["Backend/src/engine/plan/column.js"] }));

    expect(text).toContain("FAIL");
    expect(text).toContain("plan.max_columns_per_round");
    expect(text).toContain("plan.max_bundle_size");
  });
});

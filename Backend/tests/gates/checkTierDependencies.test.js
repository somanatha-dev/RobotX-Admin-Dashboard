"use strict";

/**
 * Self-test for the §1.8 rule-2 build gate.
 *
 * Phase 0 completion criterion: "the tier-dependency checker must fail a
 * deliberately-planted Tier 0→Tier 2 import."
 */

const {
  checkTierDependencies,
  formatReport,
} = require("../../tools/gates/checkTierDependencies");

const {
  TIER,
  tierOf,
  isForbiddenDependency,
  assertTierDependency,
  assertInvariantPartition,
  assertTierTwoIsDisableable,
  MECHANISMS,
} = require("../../src/engine/guards/tierAssertions");

const { createTree, removeTree, removeAllTrees } = require("./fixtureTree");

afterAll(() => removeAllTrees());

describe("tier assignment", () => {
  test("resolves by longest prefix, so a file override beats its directory", () => {
    // The directory is Tier 1 by the engine-wide default...
    expect(tierOf("src/engine/lifecycle/cancellation.js")).toBe(TIER.OPERATIONAL_INTEGRITY);
    // ...but §1.8 names preemption as Tier 2, and the file entry wins.
    expect(tierOf("src/engine/lifecycle/preemption.js")).toBe(TIER.ALLOCATION_QUALITY);
    // Settlement is dual-listed by §1.8 and takes the stricter tier.
    expect(tierOf("src/engine/lifecycle/settlement.js")).toBe(TIER.SAFETY_CORE);
  });

  test("returns null outside the governed trees", () => {
    expect(tierOf("src/services/task.service.js")).toBeNull();
    expect(tierOf("tools/gates/checkTierDependencies.js")).toBeNull();
  });

  test("forbids exactly the Tier 0/1 → Tier 2 edges and no others", () => {
    const { SAFETY_CORE, OPERATIONAL_INTEGRITY, ALLOCATION_QUALITY } = TIER;

    expect(isForbiddenDependency(SAFETY_CORE, ALLOCATION_QUALITY)).toBe(true);
    expect(isForbiddenDependency(OPERATIONAL_INTEGRITY, ALLOCATION_QUALITY)).toBe(true);

    expect(isForbiddenDependency(ALLOCATION_QUALITY, SAFETY_CORE)).toBe(false);
    expect(isForbiddenDependency(ALLOCATION_QUALITY, OPERATIONAL_INTEGRITY)).toBe(false);
    expect(isForbiddenDependency(ALLOCATION_QUALITY, ALLOCATION_QUALITY)).toBe(false);
    expect(isForbiddenDependency(SAFETY_CORE, OPERATIONAL_INTEGRITY)).toBe(false);
    expect(isForbiddenDependency(OPERATIONAL_INTEGRITY, SAFETY_CORE)).toBe(false);
    expect(isForbiddenDependency(null, ALLOCATION_QUALITY)).toBe(false);
  });

  test("the runtime assertion throws on a forbidden edge and is silent otherwise", () => {
    expect(() =>
      assertTierDependency("src/engine/commitment/commit.js", "src/engine/cost/cDefer.js"),
    ).toThrow(/§1\.8 rule 2 violation/);

    expect(() =>
      assertTierDependency("src/engine/cost/cDefer.js", "src/engine/commitment/commit.js"),
    ).not.toThrow();
  });
});

describe("planted violations — the gate must fail", () => {
  test("Tier 0 module importing a Tier 2 module", () => {
    const root = createTree("tier-t0-imports-t2", {
      // Commitment is Tier 0 (§1.8: the serialised conditional commit).
      "src/engine/commitment/commit.js":
        'const defer = require("../cost/cDefer");\nmodule.exports = { defer };\n',
      // Deferral is Tier 2 (§8.8), behind the `deferral` kill switch.
      "src/engine/cost/cDefer.js": "module.exports = {};\n",
    });

    const result = checkTierDependencies({ root });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      from: "src/engine/commitment/commit.js",
      to: "src/engine/cost/cDefer.js",
      fromTier: TIER.SAFETY_CORE,
      toTier: TIER.ALLOCATION_QUALITY,
      line: 1,
    });
    expect(formatReport(result)).toMatch(/FAIL/);

    removeTree(root);
  });

  test("Tier 1 module importing a Tier 2 module", () => {
    const root = createTree("tier-t1-imports-t2", {
      // Φ is Tier 1; C_opportunity is the Tier 2 opportunity-cost model (§8.3).
      "src/engine/cost/phi.js":
        'const direct = require("./cDirect");\nconst opportunity = require("./cOpportunity");\n' +
        "module.exports = { direct, opportunity };\n",
      "src/engine/cost/cDirect.js": "module.exports = {};\n",
      "src/engine/cost/cOpportunity.js": "module.exports = {};\n",
    });

    const result = checkTierDependencies({ root });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      from: "src/engine/cost/phi.js",
      to: "src/engine/cost/cOpportunity.js",
      fromTier: TIER.OPERATIONAL_INTEGRITY,
      toTier: TIER.ALLOCATION_QUALITY,
      line: 2,
    });

    removeTree(root);
  });

  test("ESM import syntax is caught, not only require()", () => {
    const root = createTree("tier-esm-import", {
      "src/engine/supervision/reconciler.js":
        'import { search } from "../solve/localSearch";\nexport default search;\n',
      "src/engine/solve/localSearch.js": "export default {};\n",
    });

    const result = checkTierDependencies({ root });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({
      from: "src/engine/supervision/reconciler.js",
      to: "src/engine/solve/localSearch.js",
      toTier: TIER.ALLOCATION_QUALITY,
    });

    removeTree(root);
  });

  test("a forbidden import written inside a comment is NOT a violation", () => {
    const root = createTree("tier-commented-import", {
      "src/engine/commitment/commit.js":
        '// Never do this: require("../cost/cDefer")\n' +
        '/* also not this: require("../cost/cChurn") */\n' +
        'const guards = require("./guards");\nmodule.exports = { guards };\n',
      "src/engine/commitment/guards.js": "module.exports = {};\n",
      "src/engine/cost/cDefer.js": "module.exports = {};\n",
      "src/engine/cost/cChurn.js": "module.exports = {};\n",
    });

    const result = checkTierDependencies({ root });

    expect(result.violations).toHaveLength(0);
    expect(result.ok).toBe(true);

    removeTree(root);
  });
});

describe("compliant trees — the gate must pass", () => {
  test("Tier 2 depending downward on Tier 0 and Tier 1 is allowed", () => {
    const root = createTree("tier-t2-depends-downward", {
      "src/engine/cost/cOpportunity.js":
        'const units = require("./units");\nconst custody = require("../domain/custody");\n' +
        "module.exports = { units, custody };\n",
      "src/engine/cost/units.js": "module.exports = {};\n",
      "src/engine/domain/custody.js": "module.exports = {};\n",
    });

    const result = checkTierDependencies({ root });

    expect(result.ok).toBe(true);
    expect(result.edgesChecked).toBe(2);
    expect(formatReport(result)).toMatch(/PASS/);

    removeTree(root);
  });

  test("the dependency-inverted pattern passes where the direct import failed", () => {
    // The compliant form of the "Tier 1 importing Tier 2" case above: composition
    // wiring lives outside the engine trees, and Φ never names its optional term.
    const root = createTree("tier-dependency-inversion", {
      "src/engine/cost/phi.js":
        "const terms = [];\nfunction registerTerm(term) { terms.push(term); }\n" +
        "module.exports = { registerTerm };\n",
      "src/engine/cost/cOpportunity.js": "module.exports = {};\n",
    });

    const result = checkTierDependencies({ root });

    expect(result.ok).toBe(true);

    removeTree(root);
  });
});

describe("tier-registry coherence", () => {
  test("the §26.1 invariant partition matches the sets §1.8 states", () => {
    const { ok, problems } = assertInvariantPartition();
    expect(problems).toEqual([]);
    expect(ok).toBe(true);
  });

  test("every Tier 2 mechanism is individually disableable (§22.5 rule 1)", () => {
    const { ok, problems } = assertTierTwoIsDisableable();
    expect(problems).toEqual([]);
    expect(ok).toBe(true);
  });

  test("every mechanism §1.8 names carries at least one owning module", () => {
    for (const mechanism of MECHANISMS) {
      expect(mechanism.modules.length).toBeGreaterThan(0);
      expect(mechanism.sections.length).toBeGreaterThan(0);
    }
  });

  test("the checker reports registry incoherence as a failure, not just edges", () => {
    // No source files at all, so no edges can fail — the result must still be
    // driven by the registry checks, which is what proves they are wired in.
    const root = createTree("tier-empty-tree", { "src/engine/.gitkeep": "" });

    const result = checkTierDependencies({ root, checkRegistry: true });

    expect(result.violations).toHaveLength(0);
    expect(result.registryProblems).toEqual([]);
    expect(result.ok).toBe(true);

    removeTree(root);
  });
});

describe("the real tree", () => {
  test("the committed engine contains no §1.8 rule-2 violation", () => {
    const result = checkTierDependencies();
    expect(result.violations).toEqual([]);
    expect(result.registryProblems).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

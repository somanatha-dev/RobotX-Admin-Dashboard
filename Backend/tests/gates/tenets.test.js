"use strict";

/**
 * Self-test for the design-tenet build gate and the runtime feasibility brand.
 *
 * Phase 0 checklist item: "Implement `src/engine/guards/tenets.js` — build-time
 * assertions for T1 (type separation) and T6 (no wall-clock reads in the decision
 * path)."
 */

const {
  brandFeasible,
  isFeasible,
  assertFeasible,
  feasibilityEvidence,
  checkTenets,
  formatTenetReport,
  DECISION_PATH_SCOPE,
  COST_EVALUATION_SCOPE,
} = require("../../src/engine/guards/tenets");

const { createTree, removeTree, removeAllTrees } = require("./fixtureTree");

afterAll(() => removeAllTrees());

describe("T1 — the runtime feasibility brand", () => {
  const evidence = { configVersion: "v1", snapshotId: "round-7", verdicts: {} };

  test("a branded candidate passes the assertion and carries its evidence", () => {
    const candidate = brandFeasible({ agentId: "a1", legId: "l1" }, evidence);

    expect(isFeasible(candidate)).toBe(true);
    expect(assertFeasible(candidate)).toBe(candidate);
    expect(feasibilityEvidence(candidate)).toMatchObject({
      configVersion: "v1",
      snapshotId: "round-7",
    });
  });

  test("an unbranded candidate is refused — cost cannot see it", () => {
    expect(isFeasible({ agentId: "a1" })).toBe(false);
    expect(() => assertFeasible({ agentId: "a1" }, "cost/phi.js")).toThrow(
      /T1 violation in cost\/phi\.js/,
    );
  });

  test("the brand does not survive a spread or a JSON round-trip", () => {
    // This is why the brand is a Symbol. A candidate reconstructed after the gate
    // ran — through serialisation, a cache, or an innocent `{ ...candidate }` —
    // is no longer evidence that the gate admitted *this* object, and must not be
    // priced as though it were.
    const candidate = brandFeasible({ agentId: "a1" }, evidence);

    expect(isFeasible({ ...candidate })).toBe(false);
    expect(isFeasible(JSON.parse(JSON.stringify(candidate)))).toBe(false);
  });

  test("the brand cannot be re-declared or overwritten once applied", () => {
    const candidate = brandFeasible({ agentId: "a1" }, evidence);
    expect(() => brandFeasible(candidate, { configVersion: "forged" })).toThrow();
  });

  test("branding requires both an object candidate and its verdict evidence", () => {
    expect(() => brandFeasible(null, evidence)).toThrow(TypeError);
    expect(() => brandFeasible("candidate", evidence)).toThrow(TypeError);
    expect(() => brandFeasible({ agentId: "a1" }, null)).toThrow(TypeError);
  });

  test("non-objects and null are never feasible", () => {
    for (const value of [null, undefined, 0, "", "candidate", false]) {
      expect(isFeasible(value)).toBe(false);
    }
  });
});

describe("T1 — planted violations of type separation", () => {
  test("a cost module taking a candidate without asserting the brand", () => {
    const root = createTree("tenet-t1-unasserted", {
      "src/engine/cost/phi.js":
        "function evaluate(candidate, config) {\n  return candidate.distanceM * config.rate;\n}\n" +
        "module.exports = { evaluate };\n",
    });

    const result = checkTenets({ root });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      tenet: "T1",
      file: "src/engine/cost/phi.js",
      line: 1,
    });
    expect(result.violations[0].detail).toMatch(/assertFeasible/);
    expect(formatTenetReport(result)).toMatch(/FAIL/);

    removeTree(root);
  });

  test("an arrow-function solver entry point taking columns", () => {
    const root = createTree("tenet-t1-arrow", {
      "src/engine/solve/minCostFlow.js":
        "const solve = (columns) => columns.length;\nmodule.exports = { solve };\n",
    });

    const result = checkTenets({ root });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({
      tenet: "T1",
      file: "src/engine/solve/minCostFlow.js",
    });

    removeTree(root);
  });

  test("a module outside the cost-evaluation scope is not subject to T1", () => {
    const root = createTree("tenet-t1-out-of-scope", {
      "src/engine/candidates/expansion.js":
        "function rank(candidates) {\n  return candidates;\n}\nmodule.exports = { rank };\n",
    });

    const result = checkTenets({ root });

    expect(result.violations.filter((v) => v.tenet === "T1")).toEqual([]);

    removeTree(root);
  });

  test("asserting the brand clears the violation", () => {
    const root = createTree("tenet-t1-asserted", {
      "src/engine/cost/phi.js":
        'const { assertFeasible } = require("../guards/tenets");\n' +
        "function evaluate(candidate, config) {\n  assertFeasible(candidate, \"cost/phi.js\");\n" +
        "  return candidate.distanceM * config.rate;\n}\nmodule.exports = { evaluate };\n",
    });

    const result = checkTenets({ root });

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);

    removeTree(root);
  });

  test("an explicit exemption pragma is honoured", () => {
    const root = createTree("tenet-t1-exempt", {
      "src/engine/cost/signDiscipline.js":
        "// @tenet-T1-exempt: asserts sign bounds on an already-priced plan, never admits one\n" +
        "function checkSigns(plan) {\n  return plan;\n}\nmodule.exports = { checkSigns };\n",
    });

    const result = checkTenets({ root });

    expect(result.violations).toEqual([]);

    removeTree(root);
  });
});

describe("T6 — planted violations of decision-path determinism", () => {
  test("a wall-clock read inside the decision path", () => {
    const root = createTree("tenet-t6-wall-clock", {
      "src/engine/cost/cDelay.js":
        "function delayCost(leg) {\n  const now = Date.now();\n  return now - leg.dueAt;\n}\n" +
        "module.exports = { delayCost };\n",
    });

    const result = checkTenets({ root });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      tenet: "T6",
      file: "src/engine/cost/cDelay.js",
      line: 2,
    });
    expect(result.violations[0].detail).toMatch(/Date\.now\(\)/);

    removeTree(root);
  });

  test("every prohibited non-deterministic source is caught", () => {
    const root = createTree("tenet-t6-all-sources", {
      "src/engine/solve/budgets.js":
        "function f() {\n" +
        "  const a = new Date();\n" +
        "  const b = performance.now();\n" +
        "  const c = process.hrtime.bigint();\n" +
        "  const d = process.uptime();\n" +
        "  const e = Math.random();\n" +
        "  const g = randomUUID();\n" +
        "  const h = randomBytes(16);\n" +
        "  return [a, b, c, d, e, g, h];\n}\nmodule.exports = { f };\n",
    });

    const result = checkTenets({ root });

    const names = result.violations.map((v) => v.detail.match(/reads (\S+)/)[1]);
    expect(names).toEqual([
      "new",
      "performance.now()",
      "process.hrtime()",
      "process.uptime()",
      "Math.random()",
      "crypto.randomUUID()",
      "crypto.randomBytes()",
    ]);

    removeTree(root);
  });

  test("Date.UTC is deterministic and is not flagged", () => {
    const root = createTree("tenet-t6-date-utc", {
      "src/engine/plan/timeline.js":
        "function bucketOf(year, month, day) {\n  return Date.UTC(year, month, day);\n}\n" +
        "module.exports = { bucketOf };\n",
    });

    const result = checkTenets({ root });

    expect(result.violations).toEqual([]);

    removeTree(root);
  });

  test("a clock read outside the decision path is not a T6 violation", () => {
    const root = createTree("tenet-t6-out-of-scope", {
      // L2 supervision legitimately reads a clock; T6 governs the decision path.
      "src/engine/supervision/leases.js":
        "function expired(lease) {\n  return lease.expiresAt < Date.now();\n}\n" +
        "module.exports = { expired };\n",
    });

    const result = checkTenets({ root });

    expect(result.violations).toEqual([]);

    removeTree(root);
  });

  test("the declared decision-path exclusions are honoured", () => {
    const root = createTree("tenet-t6-exclusions", {
      // snapshot.js is where the round's pinned time is *captured*; it is the one
      // module in the decision-path trees that must read a clock.
      "src/engine/determinism/snapshot.js":
        "function pin() {\n  return { pinnedAt: Date.now() };\n}\nmodule.exports = { pin };\n",
      "src/engine/energy/chargingSchedulerClient.js":
        "function fetchAt() {\n  return new Date();\n}\nmodule.exports = { fetchAt };\n",
    });

    const result = checkTenets({ root });

    expect(result.violations).toEqual([]);

    removeTree(root);
  });

  test("an explicit exemption pragma is honoured", () => {
    const root = createTree("tenet-t6-exempt", {
      "src/engine/solve/cadence.js":
        "function tick() {\n" +
        "  // @tenet-T6-exempt: cadence scheduling is outside the priced decision, and the\n" +
        "  // pinned round clock is taken from the snapshot before any scoring begins\n" +
        "  return Date.now();\n}\nmodule.exports = { tick };\n",
    });

    const result = checkTenets({ root });

    expect(result.violations).toEqual([]);

    removeTree(root);
  });

  test("a clock read written inside a comment is not code", () => {
    const root = createTree("tenet-t6-commented", {
      "src/engine/cost/cDirect.js":
        "// Never call Date.now() here — time comes from the pinned snapshot.\n" +
        "function cost(plan, snapshot) {\n  return snapshot.now - plan.startAt;\n}\n" +
        "module.exports = { cost };\n",
    });

    const result = checkTenets({ root });

    // `plan` is a candidate-shaped parameter in a cost module, so T1 still applies;
    // what must NOT appear is a T6 violation from the comment.
    expect(result.violations.filter((v) => v.tenet === "T6")).toEqual([]);

    removeTree(root);
  });
});

describe("scope declarations", () => {
  test("the cost-evaluation scope is where cost is computed", () => {
    expect(COST_EVALUATION_SCOPE).toContain("src/engine/cost/");
    expect(COST_EVALUATION_SCOPE).toContain("src/engine/solve/");
  });

  test("the decision path covers the L4 trees plus the energy predictors", () => {
    expect([...DECISION_PATH_SCOPE].sort()).toEqual([
      "src/engine/candidates/",
      "src/engine/cost/",
      "src/engine/determinism/",
      "src/engine/energy/",
      "src/engine/feasibility/",
      "src/engine/plan/",
      "src/engine/solve/",
    ]);
  });
});

describe("the real tree", () => {
  test("the committed source satisfies T1 and T6", () => {
    const result = checkTenets();
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.filesChecked).toBeGreaterThan(0);
  });
});

"use strict";

/**
 * Self-test for the parameter-register build gate.
 *
 * Phase 0 completion criterion: "the parameter-register checker must fail a planted
 * bare constant."
 */

const {
  checkParameterRegister,
  loadRegister,
  formatReport,
} = require("../../tools/gates/checkParameterRegister");

const { createTree, removeTree, removeAllTrees } = require("./fixtureTree");

afterAll(() => removeAllTrees());

/**
 * A register file shaped the way Phase 1 will seed it from Appendix A and §8.10.
 */
const REGISTER_FIXTURE = JSON.stringify(
  {
    parameters: [
      {
        name: "supervise.stall_time",
        unit: "ms",
        range: [1000, 600000],
        scope: "agent_class",
        class: "Operational",
        owner: "supervision",
        calibrationStatus: "PROVISIONAL",
      },
      {
        name: "energy.cu_per_wh",
        unit: "CU/Wh",
        range: [0, 10],
        scope: "global",
        class: "Economic",
        owner: "cost",
        calibrationStatus: "PROVISIONAL",
      },
    ],
  },
  null,
  2,
);

const withRegister = (files) => ({
  "src/engine/config/register/parameters.json": REGISTER_FIXTURE,
  ...files,
});

describe("planted violations — the gate must fail", () => {
  test("a bare behavioural constant", () => {
    const root = createTree(
      "param-bare-constant",
      withRegister({
        "src/engine/supervision/timers.js":
          "const STALL_MS = 30000;\nmodule.exports = { STALL_MS };\n",
      }),
    );

    const result = checkParameterRegister({ root });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      file: "src/engine/supervision/timers.js",
      line: 1,
      literal: "30000",
      kind: "bare-constant",
    });
    expect(formatReport(result)).toMatch(/FAIL/);

    removeTree(root);
  });

  test("an @param annotation naming an entry the register does not publish", () => {
    const root = createTree(
      "param-unknown-entry",
      withRegister({
        "src/engine/supervision/leases.js":
          "// @param supervise.lease_duration\nconst LEASE_MS = 45000;\nmodule.exports = { LEASE_MS };\n",
      }),
    );

    const result = checkParameterRegister({ root });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({
      kind: "unknown-register-entry",
      literal: "45000",
    });
    expect(result.violations[0].detail).toMatch(/supervise\.lease_duration/);

    removeTree(root);
  });

  test("a @structural exemption that states no reason", () => {
    const root = createTree(
      "param-unexplained-exemption",
      withRegister({
        "src/engine/dispatch/sequence.js":
          "// @structural\nconst WINDOW = 64;\nmodule.exports = { WINDOW };\n",
      }),
    );

    const result = checkParameterRegister({ root });

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({
      kind: "unexplained-exemption",
      literal: "64",
    });

    removeTree(root);
  });

  test("several constants across several modules are all reported", () => {
    const root = createTree(
      "param-multiple",
      withRegister({
        "src/engine/energy/reserves.js": "const FLOOR = 0.2;\nconst RETURN = 0.3;\n",
        "src/engine/candidates/expansion.js": "const RADIUS_M = 5000;\n",
      }),
    );

    const result = checkParameterRegister({ root });

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.literal).sort()).toEqual(["0.2", "0.3", "5000"]);
    // Reported in a stable order so the gate's output is diffable.
    expect(result.violations.map((v) => v.file)).toEqual([
      "src/engine/candidates/expansion.js",
      "src/engine/energy/reserves.js",
      "src/engine/energy/reserves.js",
    ]);

    removeTree(root);
  });

  test("hex, exponent and separator forms are not an escape hatch", () => {
    const root = createTree(
      "param-numeric-forms",
      withRegister({
        "src/engine/dispatch/escalation.js":
          "const A = 0xff;\nconst B = 1e3;\nconst C = 30_000;\nmodule.exports = { A, B, C };\n",
      }),
    );

    const result = checkParameterRegister({ root });

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.literal)).toEqual(["0xff", "1e3", "30_000"]);

    removeTree(root);
  });
});

describe("compliant sources — the gate must pass", () => {
  test("a constant registered and annotated with its register entry", () => {
    const root = createTree(
      "param-registered",
      withRegister({
        "src/engine/supervision/timers.js":
          "// Default only; the resolved value comes from the Config Service at run time.\n" +
          "// @param supervise.stall_time\nconst STALL_MS_DEFAULT = 30000;\n" +
          "module.exports = { STALL_MS_DEFAULT };\n",
      }),
    );

    const result = checkParameterRegister({ root });

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.registeredCount).toBe(2);
    expect(formatReport(result)).toMatch(/PASS/);

    removeTree(root);
  });

  test("@structural with a stated reason, on the literal's own line", () => {
    const root = createTree(
      "param-structural-reason",
      withRegister({
        "src/engine/domain/work.js":
          "const STOPS_PER_LEG = 2; // @structural a Leg has exactly two Stops (§2.4)\n" +
          "module.exports = { STOPS_PER_LEG };\n",
      }),
    );

    const result = checkParameterRegister({ root });

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);

    removeTree(root);
  });

  test("0 and 1 need no annotation; -1 lexes as unary minus on 1", () => {
    const root = createTree(
      "param-structural-values",
      withRegister({
        "src/engine/determinism/ordering.js":
          "function compare(a, b) {\n  if (a === b) return 0;\n  return a < b ? -1 : 1;\n}\n" +
          "module.exports = { compare };\n",
      }),
    );

    const result = checkParameterRegister({ root });

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);

    removeTree(root);
  });

  test("numbers inside comments and string literals are not code", () => {
    const root = createTree(
      "param-numbers-in-text",
      withRegister({
        "src/engine/observability/decisionRecord.js":
          "// Tier A records are bounded at roughly 4 KB each (§21.2).\n" +
          '/* The audit measured 10 TB/day/region at full fidelity. */\n' +
          'const KIND = "tier-a-v2";\nmodule.exports = { KIND };\n',
      }),
    );

    const result = checkParameterRegister({ root });

    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);

    removeTree(root);
  });

  test("build-time guard modules are out of scope", () => {
    const root = createTree(
      "param-guards-excluded",
      withRegister({
        "src/engine/guards/somethingBuildTime.js": "const N = 512;\nmodule.exports = { N };\n",
      }),
    );

    const result = checkParameterRegister({ root });

    expect(result.violations).toEqual([]);
    expect(result.filesChecked).toBe(0);

    removeTree(root);
  });
});

describe("register loading", () => {
  test("an absent register directory yields an empty register rather than throwing", () => {
    const root = createTree("param-no-register", {
      "src/engine/cost/units.js": "module.exports = {};\n",
    });

    const { names, files } = loadRegister(root);

    expect(names.size).toBe(0);
    expect(files).toEqual([]);

    removeTree(root);
  });

  test("entries are read from every JSON file in the register directory", () => {
    const root = createTree("param-multi-file-register", {
      "src/engine/config/register/parameters.json": REGISTER_FIXTURE,
      "src/engine/config/register/cost.json": JSON.stringify([{ name: "cost.cu_per_currency_unit" }]),
    });

    const { names, files } = loadRegister(root);

    expect(names.has("supervise.stall_time")).toBe(true);
    expect(names.has("cost.cu_per_currency_unit")).toBe(true);
    expect(files).toHaveLength(2);

    removeTree(root);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   RULE 2 — a name asked *of* the register must exist in it

   `ConfigSnapshot.resolve(name)` answers `undefined` for an unknown name — the same
   shape it answers for a registered entry whose value is `null`. So a misspelled
   parameter reads at runtime as "an input the owner has not supplied yet". Three of
   them shipped in the coordinator's composition root and survived 166 green suites,
   because the composition test's own fixture overrode the same misspellings (§M.1).
   ═══════════════════════════════════════════════════════════════════════════ */

describe("rule 2 — unregistered register reads", () => {
  test("a planted misspelling in src/workers is caught — where all three actually were", () => {
    // The scope assertion, and it is the load-bearing one. Rule 1 scans `src/engine`
    // only; every one of the three defects was in `src/workers`, which that scan has
    // never covered. A rule 2 inheriting rule 1's include list would be green on the exact
    // tree that produced the finding.
    const root = createTree("param-read-workers", {
      "src/engine/config/register/parameters.json": REGISTER_FIXTURE,
      "src/workers/composer.js": 'const v = resolve(snapshot, "supervise.stall_tyme", scope);\n',
    });

    const result = checkParameterRegister({ root });

    expect(result.violations).toEqual([
      expect.objectContaining({
        file: "src/workers/composer.js",
        line: 1,
        kind: "unregistered-parameter-read",
      }),
    ]);
    expect(result.ok).toBe(false);

    removeTree(root);
  });

  test("all three call shapes the composition root uses are scanned", () => {
    const root = createTree("param-read-shapes", {
      "src/engine/config/register/parameters.json": REGISTER_FIXTURE,
      "src/workers/shapes.js":
        'const a = snapshot.resolve("energy.uncertainty_inflation", scope);\n' +
        'const b = resolve(snapshot, "energy.projection_max_age", scope);\n' +
        'const c = config.get("commitment.lease_duration");\n',
    });

    const result = checkParameterRegister({ root });

    expect(result.violations.map((row) => row.line).sort()).toEqual([1, 2, 3]);

    removeTree(root);
  });

  test("a registered name, a doc comment, `path.resolve` and `Map.get` are not violations", () => {
    const root = createTree("param-read-clean", {
      "src/engine/config/register/parameters.json": REGISTER_FIXTURE,
      "src/workers/clean.js":
        "/**\n * Mentions supervise.not_a_parameter in prose, and even\n" +
        ' * `resolve(snapshot, "supervise.also_not_one")` in a code sample.\n */\n' +
        'const a = resolve(snapshot, "supervise.stall_time", scope);\n' +
        'const b = path.resolve(__dirname, "..", "tools");\n' +
        'const c = terms.get("C_opportunity");\n' +
        "const d = config.get(dynamicName);\n",
    });

    const result = checkParameterRegister({ root });

    // Comments are stripped before the scan, `path.resolve` puts its literal in the
    // second position where the member-call pattern does not look, `Map.get` is not
    // `config.get`, and a dynamic name is not a literal at all.
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);

    removeTree(root);
  });
});

describe("the real tree", () => {
  test("the committed engine contains no bare behavioural constant", () => {
    const result = checkParameterRegister();
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("every register read in the committed tree names a published entry", () => {
    const result = checkParameterRegister();

    expect(result.violations.filter((row) => row.kind === "unregistered-parameter-read")).toEqual([]);
    // And rule 2 genuinely scans wider than rule 1 — the composition root included.
    expect(result.readFilesChecked).toBeGreaterThan(result.filesChecked);
  });
});

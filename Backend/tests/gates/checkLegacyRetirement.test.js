"use strict";

/**
 * Gates lane — "the legacy decision path is removed from the build, not merely bypassed".
 *
 * The gate exists because "deleted" is a property of one commit and "absent" is a property
 * of the build. The most likely way this cutover is undone is not a revert; it is a
 * well-meaning re-addition during an incident. Every test below plants exactly that.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const gate = require("../../tools/gates/checkLegacyRetirement");

/**
 * Build a throwaway tree with the given repo-relative files, and no retired module unless
 * one is planted.
 */
function treeWith(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "robotx-legacy-"));
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents, "utf8");
  }
  return root;
}

describe("THE GATE FAILS on each way the legacy path could come back", () => {
  test("a retired module restored under its own name", () => {
    const root = treeWith({
      "src/services/taskAssignment.service.js": "module.exports = { selectNearestRobot: () => null };\n",
    });
    const result = gate.checkLegacyRetirement({ root });

    expect(result.ok).toBe(false);
    expect(result.violations[0].kind).toBe("module-restored");
    // The failure names the replacement, so the next engineer is told what to use rather
    // than only what they may not.
    expect(result.violations[0].detail).toMatch(/src\/engine\/candidates/);
  });

  test("an import of a retired module, in code rather than in a comment", () => {
    const root = treeWith({
      "src/services/other.service.js": 'const { recoverActiveTasks } = require("./taskRecovery.service");\n',
    });
    const result = gate.checkLegacyRetirement({ root });

    expect(result.ok).toBe(false);
    expect(result.violations[0].kind).toBe("import-of-retired-module");
    expect(result.violations[0].file).toBe("src/services/other.service.js");
    expect(result.violations[0].line).toBe(1);
  });

  test("an import in server.js — the file that is in neither scanned tree", () => {
    // `server.js` sits outside `src/` and `tools/`, and it is precisely the file that used
    // to call the boot-time recovery pass. A gate that scanned only the trees would have
    // missed the one import that actually existed.
    const root = treeWith({
      "server.js": 'const { recoverActiveTasks } = require("./src/services/taskRecovery.service");\n',
    });
    expect(gate.checkLegacyRetirement({ root }).violations[0].file).toBe("server.js");
  });

  test("a retired symbol redefined inside the surviving task.service.js", () => {
    const root = treeWith({
      "src/services/task.service.js": [
        "async function _processAssignment(prisma, taskId) {",
        "  return null;",
        "}",
        "module.exports = { _processAssignment };",
      ].join("\n"),
    });
    const result = gate.checkLegacyRetirement({ root });

    expect(result.ok).toBe(false);
    expect(result.violations[0].kind).toBe("retired-symbol-defined");
    expect(result.violations[0].detail).toMatch(/setImmediate with no owner/);
  });

  test("every retired symbol is caught, not just the first", () => {
    const root = treeWith({
      "src/services/task.service.js": [
        "function seedTaskKeys() {}",
        "const legacyDetachedAssignment = () => {};",
        "async function _finalizeAssignment() {}",
      ].join("\n"),
    });
    const found = gate.checkLegacyRetirement({ root }).violations.map((violation) => violation.detail);
    expect(found).toHaveLength(3);
  });
});

describe("THE GATE PASSES what it should — history is not a violation", () => {
  test("a comment discussing a retired module is not an import", () => {
    // Every phase report and several module headers discuss these names at length. A gate
    // that could not tell a historical note from a call site would force the history to be
    // erased, which is a worse outcome than the one it prevents.
    const root = treeWith({
      "src/services/task.service.js": [
        "/**",
        ' * Phase 15 removed `require("./taskAssignment.service")` and its `_processAssignment`.',
        " * The replacement is src/engine/candidates/**.",
        " */",
        "// legacyDetachedAssignment is gone; see the header.",
        "module.exports = {};",
      ].join("\n"),
    });
    expect(gate.checkLegacyRetirement({ root }).ok).toBe(true);
  });

  test("a string that merely mentions a retired symbol is not a definition", () => {
    const root = treeWith({
      "src/services/task.service.js": 'const note = "legacyDetachedAssignment was retired at Phase 15";\nmodule.exports = { note };\n',
    });
    expect(gate.checkLegacyRetirement({ root }).ok).toBe(true);
  });

  test("a same-named symbol in a DIFFERENT file is not flagged — the scan is per-file by design", () => {
    // `RETIRED_SYMBOLS` is keyed by the file that used to define them. A project-wide ban on
    // the identifier `seedTaskKeys` would be a different and much blunter rule, and would
    // fail correct code in an unrelated module.
    const root = treeWith({ "src/services/unrelated.js": "function seedTaskKeys() {}\nmodule.exports = { seedTaskKeys };\n" });
    expect(gate.checkLegacyRetirement({ root }).ok).toBe(true);
  });
});

describe("the two strip modes, and why they differ", () => {
  test("import detection keeps string literals — a module specifier IS a literal", () => {
    // The bug this test pins: `codeOnly()` blanks literal *contents*, so scanning for
    // `require("…/taskRecovery.service")` with it finds nothing at all and the gate passes
    // while the import sits in plain sight. It was found exactly that way.
    const source = 'const x = require("./src/services/taskRecovery.service");';
    expect(gate.findImports(source, "src/services/taskRecovery.service.js")).toHaveLength(1);
  });

  test("it matches every spelling of the specifier", () => {
    for (const specifier of [
      'require("./taskAssignment.service")',
      "require('../services/taskAssignment.service.js')",
      'require( "./src/services/taskAssignment.service" )',
    ]) {
      expect({ specifier, found: gate.findImports(specifier, "src/services/taskAssignment.service.js").length }).toEqual({
        specifier,
        found: 1,
      });
    }
  });

  test("symbol detection matches definitions, not calls", () => {
    expect(gate.findDefinitions("function _processAssignment() {}", "_processAssignment")).toHaveLength(1);
    expect(gate.findDefinitions("const _processAssignment = () => {};", "_processAssignment")).toHaveLength(1);
    expect(gate.findDefinitions("async function _processAssignment() {}", "_processAssignment")).toHaveLength(1);
    // A call to a symbol that no longer exists is a reference error at runtime, and is
    // caught by the import check when it arrives via an import. The useful thing to refuse
    // here is the re-introduction of the thing itself.
    expect(gate.findDefinitions("_processAssignment(prisma, id);", "_processAssignment")).toHaveLength(0);
  });
});

describe("the real tree", () => {
  test("passes — the four modules are gone, unimported, and no symbol is redefined", () => {
    const result = gate.checkLegacyRetirement();
    expect(result.violations).toEqual([]);
    expect(result.retiredModules).toBe(4);
    expect(result.filesChecked).toBeGreaterThan(200);
  });

  test("every retired module names what replaced it", () => {
    // The gate doubles as documentation of the cutover, and a replacement that is not named
    // is a retirement nobody can act on.
    for (const retired of gate.RETIRED_MODULES) {
      expect({ file: retired.file, hasReplacement: Boolean(retired.replacedBy) }).toEqual({
        file: retired.file,
        hasReplacement: true,
      });
      expect(fs.existsSync(path.join(__dirname, "..", "..", retired.file))).toBe(false);
    }
  });

  test("it is a BUILD gate — `npm run gates` runs it", () => {
    // Unlike the calibration gate. This one asserts a property of the code, which a commit
    // introduced and a commit can fix, so blocking the build is the right response.
    const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")).scripts;
    expect(scripts.gates).toMatch(/gate:legacy/);
  });
});

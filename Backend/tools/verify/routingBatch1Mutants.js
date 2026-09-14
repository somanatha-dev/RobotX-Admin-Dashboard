"use strict";

/**
 * ROUTING BATCH 1 — mutation testing for the production routing producer.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Every property this batch claims is a **negative**: never a straight-line distance, never
 * the engine's own duration, never a dropped buffer, never a shared cache entry across two
 * buckets, never an off-campus endpoint, never a fabricated terrain zero. A negative is
 * exactly the kind of claim a suite can assert while actually resting on something else, so
 * each mutant below breaks one property deliberately and the suite is re-run.
 *
 * KILLED means at least one test failed. SURVIVED means the suite stayed green over provably
 * wrong code — a gap in the tests, reported as one and never explained away.
 * NOT_APPLICABLE means the anchor no longer matches exactly once, which is an **unrun check**
 * rather than a passing one; it exits non-zero for the same reason a survivor does, so this
 * file cannot rot into a set of no-ops that all report success.
 *
 * ── How it runs ─────────────────────────────────────────────────────────────
 *   node tools/verify/routingBatch1Mutants.js [--json]
 *
 * Each mutant is a literal substitution on disk, restored afterwards on every exit path
 * including a crash and a Ctrl-C. A harness that can leave a mutant in the tree is worse
 * than no harness.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const BACKEND_ROOT = path.join(__dirname, "..", "..");

const ROUTER = "src/engine/routing/productionRouter.js";
const MODEL = "src/engine/routing/campusTravelModel.js";
const PROJECTION = "src/engine/routing/cellProjection.js";
const CACHE = "src/engine/routing/cellPairCache.js";
const CONTRACT = "tools/routing/adapters/contract.js";

/**
 * The twelve mutants this batch is required to kill, each named by the property it breaks.
 * @structural the mutant catalogue, not tunable values
 */
const MUTANTS = Object.freeze([
  {
    id: "M1",
    property: "distanceM is the ROUTED distance, never a straight line",
    file: ROUTER,
    from: "    return { distanceM: answer.distanceM };",
    to:
      "    const h3m = require(\"h3-js\");\n" +
      "    const cm = require(\"../spatial/cells\");\n" +
      "    const o = cm.centreOfCell(request.originCell);\n" +
      "    const d = cm.centreOfCell(request.destCell);\n" +
      "    return { distanceM: h3m.greatCircleDistance([o.lat, o.lon], [d.lat, d.lon], \"m\") };",
  },
  {
    id: "M2",
    property: "the RobotX operational travel buffer is applied",
    file: MODEL,
    from: "  const travelSeconds = baseTravelSeconds + operationalBufferSeconds;",
    to: "  const travelSeconds = baseTravelSeconds;",
  },
  {
    id: "M3",
    property: "the buffer is 15 s per 100 m, as the owner declared",
    file: MODEL,
    from: "  const operationalBufferSeconds = (source.distanceM * source.bufferSecondsPer100m) / BUFFER_DISTANCE_UNIT_M;",
    to: "  const operationalBufferSeconds = (source.distanceM * 9) / BUFFER_DISTANCE_UNIT_M;",
  },
  {
    id: "M4",
    property: "the profile's speed determines the base travel term",
    file: MODEL,
    from: "  const baseTravelSeconds = source.distanceM / source.speedMetresPerSecond;",
    to: "  const baseTravelSeconds = source.distanceM / 1.4;",
  },
  {
    id: "M5",
    property: "timeBucket is part of the cache key",
    file: CACHE,
    from: '    key: `${KEY_PREFIX}:${source.originCell}:${source.destCell}:${source.profileKey}:${source.timeBucket}`,',
    to: '    key: `${KEY_PREFIX}:${source.originCell}:${source.destCell}:${source.profileKey}`,',
  },
  {
    id: "M6",
    property: "profileKey is part of the cache key",
    file: CACHE,
    from: '    key: `${KEY_PREFIX}:${source.originCell}:${source.destCell}:${source.profileKey}:${source.timeBucket}`,',
    to: '    key: `${KEY_PREFIX}:${source.originCell}:${source.destCell}:${source.timeBucket}`,',
  },
  {
    id: "M7",
    property: "an endpoint outside the serviceable region is refused",
    file: PROJECTION,
    from: "      if (verdict.status !== SERVICEABILITY.INSIDE) {",
    to: "      if (false) {",
  },
  {
    id: "M8",
    property: "a malformed or unroutable engine answer is refused, never read as a route",
    file: ROUTER,
    from: '    if (!answer || answer.status !== "OK") {',
    to: "    if (false) {",
  },
  {
    id: "M9",
    property: "missing production terrain is NOT converted to zero",
    file: ROUTER,
    from: "  if (typeof seam !== \"function\") {\n    throw new RouteRefusedError(refusal, `${what} has no declared source. ${why}`);\n  }",
    to:
      "  if (typeof seam !== \"function\") {\n" +
      "    const zeroed = {};\n" +
      "    for (const field of fields) zeroed[field] = 0;\n" +
      "    return { values: zeroed, provenance: FIELD_PROVENANCE.PRODUCTION_DECLARED };\n" +
      "  }",
  },
  {
    id: "M10",
    property: "an unknown travel-time spread is NOT converted to zero (N29)",
    file: MODEL,
    from: "  const travelSdSeconds = operationalBufferSeconds * source.sdBufferMultiple;",
    to: "  const travelSdSeconds = 0;",
  },
  {
    id: "M11",
    property: "no randomness enters the travel time",
    file: MODEL,
    from: "  const travelSeconds = baseTravelSeconds + operationalBufferSeconds;",
    to: "  const travelSeconds = baseTravelSeconds + operationalBufferSeconds * (1 + Math.random());",
  },
  {
    id: "M12",
    property: "a hosted service (Mapbox/Google/public OSRM) cannot be the production router",
    file: CONTRACT,
    from: "  if (HOSTED_HOSTS.some((hosted) => host === hosted || host.endsWith(`.${hosted}`))) {",
    to: "  if (false) {",
  },
]);

/** The suites a mutant is judged against. */
const SUITES = Object.freeze(["routingProductionSeam", "routingB1Adapters", "routingInProcessCache"]);

function read(relative) {
  return fs.readFileSync(path.join(BACKEND_ROOT, relative), "utf8");
}

function write(relative, contents) {
  fs.writeFileSync(path.join(BACKEND_ROOT, relative), contents);
}

/**
 * Run the suites. Exit code 0 means every test passed — i.e. the mutant SURVIVED.
 *
 * @returns {{ passed: boolean, output: string }}
 */
function runSuites() {
  try {
    const output = execFileSync(
      process.execPath,
      [path.join(BACKEND_ROOT, "node_modules", "jest", "bin", "jest.js"), "--runInBand", "--forceExit", ...SUITES],
      { cwd: BACKEND_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 },
    );
    return { passed: true, output };
  } catch (error) {
    return { passed: false, output: `${error.stdout || ""}${error.stderr || ""}` };
  }
}

/** The failing test count jest reported, for the record. */
function failedCount(output) {
  const match = /Tests:\s+(\d+) failed/.exec(output || "");
  return match ? Number(match[1]) : null;
}

function main(argv) {
  const asJson = (argv || []).includes("--json");
  const originals = new Map();
  const results = [];

  const restore = () => {
    for (const [relative, contents] of originals) {
      try {
        write(relative, contents);
      } catch {
        /* best effort */
      }
    }
  };
  process.on("exit", restore);
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });

  for (const mutant of MUTANTS) {
    const original = read(mutant.file);
    if (!originals.has(mutant.file)) originals.set(mutant.file, original);

    const occurrences = original.split(mutant.from).length - 1;
    if (occurrences !== 1) {
      results.push({
        id: mutant.id,
        property: mutant.property,
        file: mutant.file,
        verdict: "NOT_APPLICABLE",
        detail:
          `the anchor matched ${occurrences} time(s) in ${mutant.file}, not exactly once. The mutant was NOT ` +
          "applied and NOTHING is claimed about this property — a mutant whose anchor has drifted is an unrun " +
          "check, not a passing one",
        failedTests: null,
      });
      continue;
    }

    write(mutant.file, original.split(mutant.from).join(mutant.to));
    const run = runSuites();
    write(mutant.file, original);

    results.push({
      id: mutant.id,
      property: mutant.property,
      file: mutant.file,
      verdict: run.passed ? "SURVIVED" : "KILLED",
      failedTests: run.passed ? 0 : failedCount(run.output),
      detail: run.passed
        ? "the suite stayed GREEN over provably wrong code. This is a gap in the tests, not a property that holds"
        : "at least one test failed, so the property is actually asserted",
    });
  }

  const killed = results.filter((entry) => entry.verdict === "KILLED").length;
  const survived = results.filter((entry) => entry.verdict === "SURVIVED").length;
  const notApplicable = results.filter((entry) => entry.verdict === "NOT_APPLICABLE").length;

  const report = { total: results.length, killed, survived, notApplicable, results };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const lines = ["ROUTING BATCH 1 mutation testing — production routing producer", ""];
    for (const entry of results) {
      lines.push(`  ${entry.verdict.padEnd(15)} ${entry.id}  ${entry.property}`);
      if (entry.verdict !== "KILLED") lines.push(`                  ${entry.detail}`);
    }
    lines.push("");
    lines.push(`  ${killed} KILLED, ${survived} SURVIVED, ${notApplicable} NOT_APPLICABLE, of ${results.length}.`);
    if (survived > 0) lines.push("  A SURVIVOR IS A REAL GAP. It is reported here rather than described as a pass.");
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  return survived === 0 && notApplicable === 0 ? 0 : 1;
}

module.exports = { MUTANTS, SUITES, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

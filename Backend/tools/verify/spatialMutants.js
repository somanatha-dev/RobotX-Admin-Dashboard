"use strict";

/**
 * **Mutation testing for the D1 two-layer spatial model** (`RD-2026-09-14-01`, ADR-35).
 *
 * Nearly every claim this work makes is a **negative**: an indexed cell confers no
 * delivery-domain membership, an absent conjunct is never read as true, an outside point
 * is never authorised, no polygon is evaluated inside a round, no historical token is
 * reinterpreted, no privacy exemption was widened. A negative is exactly the kind of
 * claim a green suite can rest on something else entirely — so each one is broken here
 * deliberately and the suite is re-run.
 *
 * Mechanics are `batch2Mutants.js`'s, deliberately unchanged: a literal substitution that
 * must match **exactly once**, restored on every exit path including a crash, and a
 * drifted anchor reported as `NOT_APPLICABLE` rather than silently skipped — because a
 * mutant that no longer applies is an unrun check, not a passing one.
 *
 * **A semantic no-op does not count.** §18's rule, and it is not theoretical here: the
 * previous batch had two mutants survive because swapping a containment mode changed
 * nothing once centres were re-tested downstream. Every mutant below was checked to
 * produce genuinely wrong behaviour, not merely different source.
 *
 *   node tools/verify/spatialMutants.js [--json]
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const BACKEND_ROOT = path.join(__dirname, "..", "..");

const CELLS = "src/engine/spatial/cells.js";
const DOMAIN = "src/engine/spatial/deliveryDomain.js";
const BOUNDARY = "src/engine/spatial/regionBoundary.js";
const SOLVE_PATH = "src/workers/coordinatorSolvePath.js";
const CELL_PAIR_CACHE = "src/engine/routing/cellPairCache.js";
const REGISTER = "src/engine/config/register/supplementary.json";
const SURROGATE = "src/engine/privacy/surrogateKeys.js";
const TASK_SERVICE = "src/services/task.service.js";
const VALIDATORS = "src/engine/config/validators.js";

/** The suites that are supposed to notice. */
const SUITES = Object.freeze([
  "tests/engine/spatialDeliveryDomain.test.js",
  "tests/engine/spatialRnsitCover.test.js",
  "tests/engine/spatialIntakeGeofencePin.test.js",
  "tests/engine/candidatesSpatialH3.test.js",
  "tests/engine/spatialRegionBoundary.test.js",
  "tests/engine/coordinatorSolvePathComposition.test.js",
  "tests/engine/privacySurrogateKeys.test.js",
  "tests/engine/configValidators.test.js",
]);

/**
 * The mutant catalogue, each named by the property it breaks. The ten properties
 * `RD-2026-09-14-01`'s testing instruction names are marked with the clause they come
 * from; the rest carry the resolution-11 model forward.
 * @structural the mutant catalogue, not tunable values
 */
const MUTANTS = Object.freeze([
  // ── D2 — the declared resolution ─────────────────────────────────────────
  {
    id: "S1",
    property: "FINE is resolution 11 — reverting to the previous model must not go unnoticed",
    file: CELLS,
    from: "  FINE: 11, // @structural ADR-35",
    to: "  FINE: 8, // @structural ADR-35",
  },
  {
    id: "S2",
    property: "FINE is not resolution 10 — the resolution that strands rnsit-canara-bank",
    file: CELLS,
    from: "  FINE: 11, // @structural ADR-35",
    to: "  FINE: 10, // @structural ADR-35",
  },

  // ── D1 — the conjunction (instruction: "removing the geofence conjunct") ──
  {
    id: "S3",
    property: "the delivery-domain conjunct is part of serviceability — removing it must fail",
    file: SOLVE_PATH,
    from: "      const conjuncts = [assigned, inDeliveryDomain, routable];",
    to: "      const conjuncts = [assigned, routable];",
  },
  // instruction: "defaulting absent domain to true"
  {
    id: "S4",
    property: "an ABSENT domain verdict is never read as true",
    file: SOLVE_PATH,
    from: "      const inDeliveryDomain = deliveryDomain.pinnedMembership(stop.geofenceResult);",
    to: "      const inDeliveryDomain = deliveryDomain.pinnedMembership(stop.geofenceResult) ?? true;",
  },
  // instruction: "accepting outside point"
  {
    id: "S5",
    property: "a point the pinned verdict says is OUTSIDE is never accepted",
    file: DOMAIN,
    from: "  if (pinned === GEOFENCE_VERDICT.OUTSIDE) return false;",
    to: "  if (pinned === GEOFENCE_VERDICT.OUTSIDE) return true;",
  },
  // instruction: "confusing H3 index membership with serviceability"
  {
    id: "S6",
    property: "an ASSIGNED cell alone does not make a stop serviceable — index membership is not a domain claim",
    file: SOLVE_PATH,
    from:
      "      if (conjuncts.some((value) => value === false)) return { ...projected, serviceable: false };\n" +
      "      if (conjuncts.every((value) => value === true)) return { ...projected, serviceable: true };\n" +
      "      return projected;",
    to:
      "      if (assigned === true) return { ...projected, serviceable: true };\n" +
      "      return projected;",
  },
  // instruction: "using live polygon geometry at coordinator time" (ADR-28)
  {
    id: "S7",
    property: "the coordinator evaluates NO polygon geometry — it consumes a pinned verdict (ADR-28)",
    file: SOLVE_PATH,
    from: "      const inDeliveryDomain = deliveryDomain.pinnedMembership(stop.geofenceResult);",
    to:
      "      const inDeliveryDomain = deliveryDomain.verdictFor(snapshot && snapshot.deliveryDomain, stop.lat, stop.lon)" +
      '.verdict === "INSIDE" ? true : undefined;',
  },
  // instruction: "boundary overlap does not authorise an outside point"
  {
    id: "S8",
    property: "the geofence is evaluated on the COORDINATE, never derived from the cell",
    file: TASK_SERVICE,
    from: "    const verdict = deliveryDomain.evaluatePoint(domain, stop.lat, stop.lon);",
    to:
      "    const centre = Number.isFinite(stop.lat) && Number.isFinite(stop.lon)\n" +
      "      ? require(\"h3-js\").cellToLatLng(cells.cellForPoint(stop.lat, stop.lon, cells.RESOLUTION.FINE))\n" +
      "      : [stop.lat, stop.lon];\n" +
      "    const verdict = deliveryDomain.evaluatePoint(domain, centre[0], centre[1]);",
  },

  // ── D4 — historical identity (instruction: "reinterpretation of historical tokens") ──
  {
    id: "S9",
    property: "enforcement point 2 — coarseParentOf refuses a foreign-model token rather than coercing it",
    file: CELLS,
    // Anchored on the **real** enforcement point. It used to be anchored on a wrapper
    // predicate (`isFineCell`) that had no production caller; that wrapper was removed
    // in the A-2 correction, and a mutant aimed at dead code proves nothing about the
    // running system.
    from: "  if (resolutionOfH3Cell(id) !== RESOLUTION.FINE) {\n    throw new Error(`coarseParentOf: \"${id}\" is not a fine-resolution H3 cell`);",
    to: "  if (false && resolutionOfH3Cell(id) !== RESOLUTION.FINE) {\n    throw new Error(`coarseParentOf: \"${id}\" is not a fine-resolution H3 cell`);",
  },
  // instruction: "accepting foreign resolution"
  {
    id: "S10",
    property: "resolution identity is decided from the token — any H3 cell is NOT a fine cell",
    file: CELLS,
    from: "  if (res === H3_RESOLUTION.FINE) return RESOLUTION.FINE;\n  if (res === H3_RESOLUTION.COARSE) return RESOLUTION.COARSE;\n  return null;",
    to: "  if (res === H3_RESOLUTION.COARSE) return RESOLUTION.COARSE;\n  return RESOLUTION.FINE;",
  },
  {
    id: "S11",
    property: "V-10 rejects a cell published at the wrong resolution",
    file: BOUNDARY,
    from: "  const actual = h3.getResolution(cellId);\n  if (actual !== expectedH3) {",
    to: "  const actual = h3.getResolution(cellId);\n  if (false && actual !== expectedH3) {",
  },
  // instruction: "bypassing model-version identity"
  {
    id: "S12",
    property: "the spatial-model identity is DERIVED from the resolutions, never asserted",
    file: CELLS,
    from: "  id: `H3-F${H3_RESOLUTION.FINE}-C${H3_RESOLUTION.COARSE}`,",
    to: '  id: "H3-F8-C5",',
  },

  // ── §20.3 — cache identity (instruction: "weakening cache invalidation") ──
  {
    id: "S13",
    property: "timeBucket is part of the routing cache identity",
    file: CELL_PAIR_CACHE,
    from: "    key: `${KEY_PREFIX}:${source.originCell}:${source.destCell}:${source.profileKey}:${source.timeBucket}`,",
    to: "    key: `${KEY_PREFIX}:${source.originCell}:${source.destCell}:${source.profileKey}`,",
  },
  {
    id: "S14",
    property: "the mobility profile is part of the routing cache identity",
    file: CELL_PAIR_CACHE,
    from: "    key: `${KEY_PREFIX}:${source.originCell}:${source.destCell}:${source.profileKey}:${source.timeBucket}`,",
    to: "    key: `${KEY_PREFIX}:${source.originCell}:${source.destCell}:${source.timeBucket}`,",
  },

  // ── D5 — the two quantities stay separate ────────────────────────────────
  {
    id: "S15",
    property: "the intra-cell offset is NOT collapsed onto the geometric cell diameter (D5)",
    file: REGISTER,
    from: '      "default": 250,\n      "range": {\n        "min": 0,\n        "max": 2000\n      },',
    to: '      "default": 58,\n      "range": {\n        "min": 0,\n        "max": 2000\n      },',
  },
  {
    id: "S16",
    property: "the intra-cell offset is at least the fine-cell diameter — omitting it under-corrects a reserve",
    file: REGISTER,
    from: '      "default": 250,\n      "range": {\n        "min": 0,\n        "max": 2000\n      },',
    to: '      "default": 0,\n      "range": {\n        "min": 0,\n        "max": 2000\n      },',
  },

  // ── §23.7 (instruction: "widening privacy exemption") ────────────────────
  {
    id: "S17",
    property: "§23.7's derived-quantity enumeration is closed — a seventh spatial field cannot be exempted silently",
    file: SURROGATE,
    from: '  "routingNodeId",\n]);',
    to: '  "routingNodeId",\n  "preciseCellPosition",\n]);',
  },

  // ── D7 — attestation is reported, never inferred ─────────────────────────
  {
    id: "S18",
    property: "an unsigned development artefact is never reported as the attested owner declaration",
    file: DOMAIN,
    from: "  const attested = base.status === regionBoundary.BOUNDARY_STATUS.VALID && attestationGaps.length === 0;",
    to: "  const attested = base.status === regionBoundary.BOUNDARY_STATUS.VALID;",
  },
  {
    id: "S19",
    property: "A7 refuses a malformed published delivery-domain declaration at publish",
    file: VALIDATORS,
    from: "  if (verdict.status !== regionBoundary.BOUNDARY_STATUS.VALID) {",
    to: "  if (false && verdict.status !== regionBoundary.BOUNDARY_STATUS.VALID) {",
  },

  // ── D1 — the pin must actually reach the round ───────────────────────────
  {
    id: "S20",
    property: "the stop projection carries the pinned verdict out of the database — a pin nothing reads is not a pin",
    file: SOLVE_PATH,
    from: "        geofenceResult: stop.geofenceResult ?? null,",
    to: "        // geofenceResult intentionally dropped by the mutant",
  },
  {
    id: "S21",
    property: "intake PINS the verdict — a producer that writes nothing leaves the round undecidable",
    file: TASK_SERVICE,
    from: "        geofenceResult: verdict.verdict,",
    to: "        // geofenceResult intentionally not written by the mutant",
  },
  {
    id: "S22",
    property: "planInputFor actually calls serviceabilityFor — removing the call site must fail",
    file: SOLVE_PATH,
    // The audit of 2026-09-14 found this exact mutation would have SURVIVED: the test at
    // the time asserted only `every(s => s.serviceable === undefined)`, which raw
    // `leg.stops` satisfy just as well. A seam whose removal no test notices is a seam
    // that is not integration-tested, however many unit tests the function itself has.
    from: "        stops: serviceabilityFor(snapshot)(leg.stops),",
    to: "        stops: leg.stops,",
  },
]);

function read(relative) {
  return fs.readFileSync(path.join(BACKEND_ROOT, relative), "utf8");
}

function write(relative, contents) {
  fs.writeFileSync(path.join(BACKEND_ROOT, relative), contents);
}

/** Exit code 0 means every test passed — i.e. the mutant SURVIVED. */
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

function failedCount(output) {
  const match = /Tests:\s+(\d+) failed/.exec(output || "");
  return match ? Number(match[1]) : null;
}

function main(argv) {
  const asJson = (argv || []).includes("--json");
  const only = new Set((argv || []).filter((value) => /^S\d+$/u.test(value)));
  const originals = new Map();
  const results = [];

  const restore = () => {
    for (const [relative, contents] of originals) {
      try { write(relative, contents); } catch { /* best effort */ }
    }
  };
  process.on("exit", restore);
  process.on("SIGINT", () => { restore(); process.exit(130); });

  for (const mutant of MUTANTS) {
    if (only.size > 0 && !only.has(mutant.id)) continue;
    const original = read(mutant.file);
    if (!originals.has(mutant.file)) originals.set(mutant.file, original);

    const occurrences = original.split(mutant.from).length - 1;
    if (occurrences !== 1) {
      results.push({
        id: mutant.id,
        property: mutant.property,
        file: mutant.file,
        verdict: "NOT_APPLICABLE",
        failedTests: null,
        detail:
          `the anchor matched ${occurrences} time(s) in ${mutant.file}, not exactly once. The mutant was NOT ` +
          "applied and NOTHING is claimed about this property",
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
    const lines = ["RD-2026-09-14-01 mutation testing — the D1 two-layer spatial model", ""];
    for (const entry of results) {
      lines.push(`  ${entry.verdict.padEnd(15)} ${entry.id.padEnd(4)} ${entry.property}`);
      if (entry.verdict === "KILLED") lines.push(`${" ".repeat(22)}${entry.failedTests} test(s) failed`);
      else lines.push(`${" ".repeat(22)}${entry.detail}`);
    }
    lines.push("");
    lines.push(`  ${killed} KILLED, ${survived} SURVIVED, ${notApplicable} NOT_APPLICABLE, of ${results.length}.`);
    if (survived > 0) lines.push("  A SURVIVOR IS A REAL GAP. It is reported here rather than described as a pass.");
    process.stdout.write(`${lines.join("\n")}\n`);
  }

  return survived === 0 && notApplicable === 0 ? 0 : 1;
}

module.exports = { MUTANTS, SUITES, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));

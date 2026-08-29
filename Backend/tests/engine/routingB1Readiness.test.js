"use strict";

/**
 * Engine lane — **B1's readiness gate** (`tools/routing/b1Readiness.js`) and the **D3 speed
 * model contract** (`domain/mobilityModel.js`).
 *
 * ── The property under test ───────────────────────────────────────────────
 * A benchmark that exits 0 while four of its five steps cannot run is a benchmark that reads
 * green. `b1Benchmark.js`'s three verdicts cannot say why a row is unmeasured; the gate's five
 * states can, and the one this repository is actually in is `BLOCKED` — an external decision,
 * not an engineering backlog item.
 *
 * These tests assert three things and nothing more:
 *
 *   1. **With nothing supplied — the repository's real state — every blocked step reports
 *      `BLOCKED` and names the decision and its owner.** Not `NOT_MEASURED`, not `PASS`.
 *   2. **A run made while Step 1 is blocked is marked inadmissible as Step 3 evidence.** This
 *      is what stops a stub run being quoted later as though it measured a candidate.
 *   3. **Supplying the decisions releases exactly the steps they release, and no others.**
 *      Asserted with fixtures, which is the only way to exercise the released branch — and
 *      **a fixture is not a decision**: no test here declares an operating region, a fleet
 *      speed, an extract vintage or a refresh cadence for this deployment.
 *
 * No test selects, ranks or recommends an engine, and none produces a latency figure.
 */

const readiness = require("../../tools/routing/b1Readiness");
const cells = require("../../src/engine/spatial/cells");
const mobilityModel = require("../../src/engine/domain/mobilityModel");
const regionBoundary = require("../../src/engine/spatial/regionBoundary");
const { SEED_SPATIAL_MAP } = require("../../prisma/seed");

const { READINESS } = readiness;

const stepOf = (report, number) => report.steps.find((entry) => entry.step === number);

/**
 * A complete set of operator answers, used only to exercise the *released* branch.
 *
 * Every value is a fixture. The region is a 1° square on the equator, the speed model's
 * entries are the literal string "fixture" rather than numbers, and the extract names a
 * snapshot that does not exist. Nothing here is proposed for this deployment, and the gate's
 * answer to the real repository — nothing supplied — is asserted first, in the block above.
 */
const FIXTURE = Object.freeze({
  region: {
    regionId: "TEST-FIXTURE-NOT-A-REGION",
    name: "test fixture",
    kind: "METRO_SERVICE_AREA",
    crs: "EPSG:4326",
    version: "fixture-1",
    versionDate: "2026-08-01",
    boundary: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
  },
  // A real H3 index at §3.6's FINE band, minted from an arbitrary equator point. Written as a
  // call rather than as a literal so it cannot drift from `H3_RESOLUTION.FINE`, and so nobody
  // reads a pasted token as a place.
  cover: { fineCells: [{ cellId: cells.cellForPoint(0, 0, cells.RESOLUTION.FINE), zoneId: "z1" }], cardinalityException: "fixture, not a deployment" },
  // V-12's input. Present because the check now runs unconditionally: a fixture that omitted it
  // was previously accepted as a complete D1 answer, which is the defect this pass reproduced.
  // The one charger sits in the one cell the cover publishes.
  chargers: [{ chargerId: "FIXTURE-CHARGER", cellId: cells.cellForPoint(0, 0, cells.RESOLUTION.FINE) }],
  mobility: [
    {
      modelId: "FIXTURE-CLASS",
      traversalDomain: "SIDEWALK_GRAPH",
      permissionSet: {},
      kinematicLimits: {},
      envelopeConstraints: {},
      dimensionalFootprint: {},
      speedModel: { roadClass: "fixture", gradient: "fixture", surface: "fixture", payloadMass: "fixture", congestion: "fixture", weather: "fixture" },
    },
  ],
  extract: {
    identity: "fixture-extract",
    source: "fixture",
    vintage: "2026-08-01",
    refreshCadenceDays: 30,
    recontractionDowntimeBudgetSeconds: 600,
    // V-13's two inputs. The region above is the unit square [0,0]–[1,1], so a box one degree
    // outside it covers that plus the stated margin generously. Both are fixture values sized
    // to the fixture geometry; neither is a margin, a box or an extract proposed for any
    // deployment, and the gate still supplies no value for either of its own.
    bbox: { minLon: -1, minLat: -1, maxLon: 2, maxLat: 2 },
    marginDegrees: 0.05,
  },
});

/** The FIXTURE region, validated — what `assess()` hands `assessD8` so V-13 can run. */
const FIXTURE_REGION = regionBoundary.validateRegionDeclaration(FIXTURE.region);

describe("the repository's real state — nothing supplied", () => {
  const report = readiness.assess({ config: null, asOf: "2026-08-09" });

  test("the overall gate is BLOCKED, and no engine is selected", () => {
    expect(report.overall).toBe(READINESS.BLOCKED);
    expect(report.engineSelected).toBe(false);
  });

  test("D1, D3 and D8 are each BLOCKED and each names its owner — they are decisions, not tasks", () => {
    expect(report.decisions.D1).toMatchObject({ status: READINESS.BLOCKED, owner: "Operations + Commercial" });
    expect(report.decisions.D3).toMatchObject({ status: READINESS.BLOCKED, owner: "Product + Fleet Engineering" });
    expect(report.decisions.D8).toMatchObject({ status: READINESS.BLOCKED, owner: "Operations" });
  });

  test("Steps 1, 3, 4 and 5 are BLOCKED — not NOT_MEASURED, and certainly not PASS", () => {
    for (const number of [1, 3, 4, 5]) {
      expect({ step: number, status: stepOf(report, number).status }).toEqual({ step: number, status: READINESS.BLOCKED });
    }
    expect(report.steps.some((entry) => entry.status === READINESS.FAIL)).toBe(false);
  });

  test("each blocked step names the decision that blocks it, in the exact terms the brief asks for", () => {
    expect(stepOf(report, 1).blockedBy).toEqual(["D1", "D3"]);
    expect(stepOf(report, 1).note).toMatch(/BLOCKED — authoritative operating region unavailable/u);
    expect(stepOf(report, 1).note).toMatch(/fleet mobility\/speed model unavailable/u);
    expect(stepOf(report, 3).blockedBy).toEqual(["D1", "D3"]);
    expect(stepOf(report, 4).blockedBy).toEqual(["D1", "D8"]);
    expect(stepOf(report, 4).note).toMatch(/extract vintage\/refresh decision unavailable/u);
  });

  test("Step 2 is the one released step, and it is PASS on work that exists", () => {
    // ADR-33 released it; revision 5 implemented it. It is region-agnostic by construction, so
    // D1 never held it — recording that as PASS is what makes the other four BLOCKED credible.
    expect(stepOf(report, 2).status).toBe(READINESS.PASS);
    expect(stepOf(report, 2).blockedBy).toEqual([]);
    expect(report.candidates.implemented).toEqual(["osrm", "valhalla", "graphhopper"]);
    expect(report.candidates.notImplemented).toEqual(["inhouse"]);
    expect(report.candidates.deployed).toEqual([]);
  });

  test("Step 5 selects nothing, and says a capability fact is not a recommendation", () => {
    expect(stepOf(report, 5).note).toMatch(/No engine is selected, ranked or recommended/u);
    expect(stepOf(report, 5).note).toMatch(/capability fact about a candidate is not a recommendation/u);
  });

  test("A BENCHMARK RUN NOW IS NOT ADMISSIBLE AS STEP 3 EVIDENCE", () => {
    // The single assertion that makes the whole gate worth having: it is what stops a number
    // produced against a stub, on a build machine, over no extract, being quoted later as the
    // evidence B1's decision was made on.
    expect(report.stepEvidenceAdmissible).toBe(false);
    expect(readiness.format(report)).toMatch(/would NOT be admissible as B1 Step 3 evidence/u);
  });

  test("the report is a pure function of its inputs — two runs are byte-identical", () => {
    // A readiness report that changed because it ran at a different minute would not be
    // reproducible, and §9.6's determinism discipline applies to a tool's output too.
    const again = readiness.assess({ config: null, asOf: "2026-08-09" });
    expect(JSON.stringify(again)).toEqual(JSON.stringify(report));
  });
});

describe("D3 — the speed model, classified rather than assumed", () => {
  test("THE SEEDED MODEL IS A STUB, and is reported as one", () => {
    // The exact object `prisma/seed.js` writes: an object, so every "is it declared?" check
    // passes, containing nothing a routing engine could weight an edge with. That is the
    // failure mode this classification exists for — a stub that reads as present is more
    // dangerous than an absent field, because absence is at least visible.
    const seeded = { modelId: "MOB-SIDEWALK-DEFAULT", speedModel: { note: "Populated by the routing integration in Phases 7–9 (blocking decision B1)" } };
    const status = mobilityModel.speedModelStatus(seeded);
    expect(status.status).toBe(mobilityModel.SPEED_MODEL_STATUS.STUB);
    expect(status.missing).toEqual(mobilityModel.SPEED_MODEL_FACTORS);
  });

  test("`validateModel` still accepts it — the §2.2 structural contract is unchanged", () => {
    // ADR-33 rider 2 makes `validateModel()` the check the Phase 8 client calls before it
    // keys, and that contract is not altered here. The stricter question is a separate one.
    const seeded = {
      modelId: "MOB-SIDEWALK-DEFAULT",
      traversalDomain: "SIDEWALK_GRAPH",
      permissionSet: {},
      speedModel: { note: "…" },
      kinematicLimits: {},
      envelopeConstraints: {},
      dimensionalFootprint: {},
    };
    expect(mobilityModel.validateModel(seeded)).toEqual([]);
    // …but it is NOT routable, and the message names D3 and its owner rather than a fix.
    const routing = mobilityModel.validateRoutingReadiness(seeded);
    expect(routing.routable).toBe(false);
    expect(routing.problems.join("\n")).toMatch(/NOT ROUTABLE — STUB/u);
    expect(routing.problems.join("\n")).toMatch(/decision D3 \(Product \+ Fleet Engineering\)/u);
    expect(routing.problems.join("\n")).toMatch(/No speed is chosen here, no default is substituted/u);
  });

  test("an incomplete model names exactly which §2.2 factors it does not address", () => {
    const partial = mobilityModel.speedModelStatus({ modelId: "X", speedModel: { roadClass: {}, gradient: {} } });
    expect(partial.status).toBe(mobilityModel.SPEED_MODEL_STATUS.INCOMPLETE);
    expect(partial.declared).toEqual(["roadClass", "gradient"]);
    expect(partial.missing).toEqual(["surface", "payloadMass", "congestion", "weather"]);
  });

  test("an absent or non-object speed model is ABSENT, not silently empty", () => {
    expect(mobilityModel.speedModelStatus({ modelId: "X" }).status).toBe(mobilityModel.SPEED_MODEL_STATUS.ABSENT);
    expect(mobilityModel.speedModelStatus({ modelId: "X", speedModel: [] }).status).toBe(mobilityModel.SPEED_MODEL_STATUS.ABSENT);
    expect(mobilityModel.speedModelStatus({ modelId: "X", speedModel: 1.5 }).status).toBe(mobilityModel.SPEED_MODEL_STATUS.ABSENT);
  });

  test("the factor list is §2.2's own six, and the module supplies a value for none of them", () => {
    expect(mobilityModel.SPEED_MODEL_FACTORS).toEqual(["roadClass", "gradient", "surface", "payloadMass", "congestion", "weather"]);
    // The property that keeps this module on the right side of D3: it exports no number at
    // all. A speed, a gradient response or a congestion coefficient could only arrive here as
    // one, so "no numeric export" is the mechanical form of "no speed model is invented here".
    const numericExports = Object.entries(mobilityModel).filter(([, value]) => typeof value === "number");
    expect(numericExports).toEqual([]);
    // …and classification reports which factors are addressed without reading their values:
    // a factor declared as an opaque object is DECLARED, and its contents are never inspected.
    const opaque = Object.fromEntries(mobilityModel.SPEED_MODEL_FACTORS.map((factor) => [factor, { supplied: "by D3" }]));
    expect(mobilityModel.speedModelStatus({ modelId: "X", speedModel: opaque }).status).toBe(mobilityModel.SPEED_MODEL_STATUS.DECLARED);
  });
});

describe("D8 — extract metadata, hardened without a value being chosen", () => {
  // The region is supplied because V-13 needs one to size the extract against. Without it the
  // gate reports BLOCKED on D1 rather than a verdict about the extract, which is the point of
  // F1's discharge and is asserted directly further down.
  const assess = (extract, asOf) => readiness.assessD8({ extract }, { asOf, region: FIXTURE_REGION });

  test("no extract metadata is BLOCKED, and the message says why there is nowhere to record one", () => {
    expect(assess(undefined).status).toBe(READINESS.BLOCKED);
    expect(assess(undefined).problems.join("\n")).toMatch(/mapVersion defaults to 0 and is explicitly not a foreign key/u);
  });

  test("each missing D8 field is BLOCKED and is named as a decision rather than a derivation", () => {
    const complete = FIXTURE.extract;
    // `bbox` and `marginDegrees` join the list because V-13 reads them and nothing did before
    // (F1). They are required the same way the other five are: named, and never defaulted.
    for (const field of ["identity", "source", "vintage", "refreshCadenceDays", "recontractionDowntimeBudgetSeconds", "bbox", "marginDegrees"]) {
      const result = assess({ ...complete, [field]: undefined });
      expect({ field, status: result.status }).toEqual({ field, status: READINESS.BLOCKED });
      expect({ field, named: result.problems.join("\n").includes(`extract.${field}`) }).toEqual({ field, named: true });
    }
  });

  describe("R-3 — a placeholder is not a named source", () => {
    // PHASE 15 residual pass. `PLACEHOLDER_TOKENS` lived in `adapters/contract.js` and was
    // applied only to `normaliseDeployment`'s four fields, so `deployment.extract: "tbd"` was
    // refused while D8's own `extract.source: "tbd"` reported PASS — one question, two rules.
    // `identity` is what every Step 3 and Step 4 measurement is attributed to; `source` is the
    // answer to "where did this snapshot come from, and how would a re-cut be reproduced?".
    const PLACEHOLDERS = ["tbd", "TBD", "Tbd", "  tbd  ", "TBD.", "tbd .", "todo", "unknown", "UNKNOWN", "placeholder", "n/a", "N/A", "pending", "unspecified", "?", "-", "--", "xxx", "fixme"];

    test.each([["identity"], ["source"]])("extract.%s refuses every placeholder token, in every case and spacing", (field) => {
      const accepted = PLACEHOLDERS.filter((token) => assess({ ...FIXTURE.extract, [field]: token }, "2026-08-09").status !== READINESS.BLOCKED);
      expect(accepted).toEqual([]);
      // …and the message names the field and sends the reader to Operations, not to a code change.
      const result = assess({ ...FIXTURE.extract, [field]: "tbd" }, "2026-08-09");
      expect(result.problems.join("\n")).toMatch(new RegExp(`extract\\.${field} is "tbd", which is a placeholder`, "u"));
      expect(result.problems.join("\n")).toMatch(/Naming it is Operations'; nothing is inferred or defaulted here/u);
    });

    test("an empty or whitespace-only source is still the ABSENCE message, not the placeholder one", () => {
      // Two different defects with two different remedies: nothing was supplied, versus a
      // non-answer was. A8 established the first; this must not swallow it into the second.
      for (const blank of ["", "   ", "\t\n"]) {
        const result = assess({ ...FIXTURE.extract, source: blank }, "2026-08-09");
        expect(result.status).toBe(READINESS.BLOCKED);
        expect(result.problems.join("\n")).toMatch(/extract\.source is required — where the snapshot came from/u);
        expect(result.problems.join("\n")).not.toMatch(/is a placeholder rather than a named answer/u);
      }
    });

    test("LEGITIMATE SOURCES ARE UNAFFECTED — the rule refuses non-answers, not formats", () => {
      // The failure this must not become is a validator with opinions about how a source is
      // spelled. A URL, a file name, a vendor and a ticket reference are all answers.
      for (const source of [
        "Geofabrik europe-latest.osm.pbf, cut 2026-08-01",
        "https://download.geofabrik.de/europe-latest.osm.pbf",
        "internal mirror osm-mirror-01:/snapshots/2026-08-01",
        "OSM planet, ticket OPS-1183",
        "unknown-roads-survey-2026",
        "N/A-WEST depot survey",
      ]) {
        expect({ source, status: assess({ ...FIXTURE.extract, source }, "2026-08-09").status }).toEqual({ source, status: READINESS.PASS });
      }
      // "unknown-roads-survey-2026" and "N/A-WEST depot survey" are the ones that matter: the
      // comparison is against the WHOLE trimmed field, never a substring of it.
    });

    test("D8's other five fields are not judged by the placeholder rule", () => {
      // The rule is scoped to the two fields whose contract is a NAMED SOURCE. `vintage` is
      // already an ISO calendar date and the three numbers are already numbers, so widening it
      // to them would add nothing; the point of recording the scope is that it is a scope.
      expect(assess({ ...FIXTURE.extract, vintage: "tbd" }, "2026-08-09").problems.join("\n")).toMatch(/extract\.vintage is required as an ISO calendar date/u);
      expect(assess({ ...FIXTURE.extract, vintage: "tbd" }, "2026-08-09").problems.join("\n")).not.toMatch(/is a placeholder rather than a named answer/u);
    });

    test("the placeholder authority is ONE rule, shared — not a second copy of the token list", () => {
      // The defect underneath R-3 is two authorities for one question. The gate must be using
      // the adapter layer's own predicate, so that a token added there is refused here too.
      // eslint-disable-next-line global-require
      const contract = require("../../tools/routing/adapters/contract");
      expect(contract.isPlaceholder("TBD.")).toBe(true);
      expect(contract.isPlaceholder("Geofabrik europe-latest")).toBe(false);
      const spy = jest.spyOn(contract, "isPlaceholder");
      assess({ ...FIXTURE.extract, source: "tbd" }, "2026-08-09");
      expect(spy).toHaveBeenCalledWith("tbd");
      spy.mockRestore();
    });
  });

  test("a vintage that is not an ISO date is refused, and is never inferred from a file timestamp", () => {
    expect(assess({ ...FIXTURE.extract, vintage: "August 2026" }).problems.join("\n")).toMatch(/never inferred from a file timestamp/u);
  });

  test("a STALE extract FAILS against its own stated cadence — it does not quietly pass", () => {
    // The failure this guards is silent by construction: a stale extract still answers every
    // query, and answers them over a map the region no longer has.
    const stale = assess(FIXTURE.extract, "2026-10-01");
    expect(stale.status).toBe(READINESS.FAIL);
    expect(stale.problems.join("\n")).toMatch(/61 days old against a stated refresh cadence of 30 days/u);
  });

  test("a fresh extract passes; with no evaluation date staleness is NOT_MEASURED, never PASS", () => {
    expect(assess(FIXTURE.extract, "2026-08-09").status).toBe(READINESS.PASS);
    expect(assess(FIXTURE.extract, undefined).status).toBe(READINESS.NOT_MEASURED);
  });

  test("A VINTAGE IN THE FUTURE FAILS — it does not clear every cadence forever", () => {
    // The staleness comparison was one-sided (`ageDays > cadence`), so a vintage dated after
    // the evaluation date produced a negative age, cleared any cadence, and reported PASS. One
    // mistyped year would have pinned the extract permanently fresh and the check that exists
    // because a stale extract "answers every query" would never have fired again.
    const future = assess({ ...FIXTURE.extract, vintage: "2062-08-01" }, "2026-08-09");
    expect(future.status).toBe(READINESS.FAIL);
    expect(future.problems.join("\n")).toMatch(/13141 days AFTER the evaluation date 2026-08-09/u);
    expect(future.problems.join("\n")).toMatch(/cannot be cut from a map that does not exist yet/u);
    // The boundary: the evaluation date itself is age 0 and is not the future.
    expect(assess({ ...FIXTURE.extract, vintage: "2026-08-09" }, "2026-08-09").status).toBe(READINESS.PASS);
    // …and one day after it is.
    expect(assess({ ...FIXTURE.extract, vintage: "2026-08-10" }, "2026-08-09").status).toBe(READINESS.FAIL);
  });

  test("a vintage that matches YYYY-MM-DD and is not a calendar date is refused — one date authority", () => {
    // `2026-02-31` matched the local regex, parsed to a rolled-over March date, and reported
    // PASS with an age computed against a day that does not exist — while the same string as
    // `region.versionDate` was refused by `regionBoundary.isIsoDate` two functions away. D8 now
    // uses that same authority.
    expect(regionBoundary.isIsoDate("2026-02-31")).toBe(false);
    expect(assess({ ...FIXTURE.extract, vintage: "2026-02-31" }, "2026-08-09").status).toBe(READINESS.BLOCKED);
    expect(assess({ ...FIXTURE.extract, vintage: "2026-13-01" }, "2026-08-09").status).toBe(READINESS.BLOCKED);
    expect(assess({ ...FIXTURE.extract, vintage: "0000-00-00" }, "2026-08-09").status).toBe(READINESS.BLOCKED);
    // A real leap day in a real leap year is a date and is accepted.
    expect(assess({ ...FIXTURE.extract, vintage: "2028-02-29" }, "2028-03-01").status).toBe(READINESS.PASS);
    // …and the same day in a non-leap year is not.
    expect(assess({ ...FIXTURE.extract, vintage: "2027-02-29" }, "2027-03-01").status).toBe(READINESS.BLOCKED);
  });

  describe("V-13 — F1's discharge: the check that was implemented, tested and called by nothing", () => {
    // B1_ROUTING_ENGINE_DECISION_PREPARATION.md §11 F1: `validateExtractMargin()` existed, was
    // exported, had three unit tests and NO production caller, and `assessD8` never read
    // `extract.bbox` or `extract.marginDegrees` — so "a deployment could supply an extract whose
    // bounding box does not cover the region, and D8 would report PASS". These assert the caller.

    test("AN EXTRACT THAT DOES NOT COVER THE REGION FAILS D8 — this is the defect F1 named", () => {
      const tight = { ...FIXTURE.extract, bbox: { minLon: 0.4, minLat: 0.4, maxLon: 0.6, maxLat: 0.6 } };
      const result = assess(tight, "2026-08-09");
      expect(result.status).toBe(READINESS.FAIL);
      expect(result.problems.join("\n")).toMatch(/V-13 extract\.bbox\.minLon is 0\.4/u);
      expect(result.problems.join("\n")).toMatch(/EXTRACT_MISS rather than a route/u);
    });

    test("the failure direction is exact — short on ONE edge fails on exactly that edge", () => {
      // The margin is 0.05 and the region is [0,0]–[1,1], so maxLat must reach 1.05.
      const short = { ...FIXTURE.extract, bbox: { minLon: -0.05, minLat: -0.05, maxLon: 1.05, maxLat: 1.04 } };
      const result = assess(short, "2026-08-09");
      expect(result.status).toBe(READINESS.FAIL);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toMatch(/V-13 extract\.bbox\.maxLat is 1\.04, which does not cover the region's maxLat of 1\.05/u);
      // Exactly meeting the bound is coverage, not a failure: the check refuses under-coverage.
      expect(assess({ ...short, bbox: { ...short.bbox, maxLat: 1.05 } }, "2026-08-09").status).toBe(READINESS.PASS);
    });

    test("V-13 CANNOT PASS BY DEFAULT — a complete extract with no region is BLOCKED on D1, never PASS", () => {
      // The dangerous outcome would be a check that reports a pass when it did not run. Every
      // extract field is present here; the only absent input is D1's geometry.
      const noRegion = readiness.assessD8({ extract: FIXTURE.extract }, { asOf: "2026-08-09" });
      expect(noRegion.status).toBe(READINESS.BLOCKED);
      expect(noRegion.problems.join("\n")).toMatch(/V-13 cannot run: there is no valid region geometry/u);
      // An INVALID region is not a valid region either, and is likewise not a pass.
      const invalid = regionBoundary.validateRegionDeclaration({ regionId: "X", name: "X" });
      expect(readiness.assessD8({ extract: FIXTURE.extract }, { asOf: "2026-08-09", region: invalid }).status).toBe(READINESS.BLOCKED);
    });

    test("a malformed bbox is refused rather than coerced", () => {
      const bad = (bbox) => assess({ ...FIXTURE.extract, bbox }, "2026-08-09").status;
      expect(bad({ minLon: NaN, minLat: -1, maxLon: 2, maxLat: 2 })).toBe(READINESS.BLOCKED);
      expect(bad({ minLon: -Infinity, minLat: -1, maxLon: 2, maxLat: 2 })).toBe(READINESS.BLOCKED);
      expect(bad({ minLon: "-1", minLat: -1, maxLon: 2, maxLat: 2 })).toBe(READINESS.BLOCKED);
      expect(bad({ minLon: -1, minLat: -1, maxLon: 2 })).toBe(READINESS.BLOCKED);
      // Inside-out: a box whose min exceeds its max would "cover" everything by comparison.
      expect(bad({ minLon: 2, minLat: 2, maxLon: -1, maxLat: -1 })).toBe(READINESS.BLOCKED);
      expect(bad([])).toBe(READINESS.BLOCKED);
      expect(assess({ ...FIXTURE.extract, marginDegrees: -0.1 }, "2026-08-09").status).toBe(READINESS.BLOCKED);
      expect(assess({ ...FIXTURE.extract, marginDegrees: NaN }, "2026-08-09").status).toBe(READINESS.BLOCKED);
      expect(assess({ ...FIXTURE.extract, marginDegrees: "0.05" }, "2026-08-09").status).toBe(READINESS.BLOCKED);
      // Zero is a real answer — "cut to the bounding box exactly" — and is accepted as one.
      expect(assess({ ...FIXTURE.extract, marginDegrees: 0 }, "2026-08-09").status).toBe(READINESS.PASS);
    });

    test("the validator is ACTUALLY CALLED — proven by observing the module, not by reading it", () => {
      // "Implemented and tested" is what F1 already was. The property under test is that the
      // production path reaches it, so the spy is on the module `b1Readiness` requires.
      const spy = jest.spyOn(regionBoundary, "validateExtractMargin");
      readiness.assess({ config: FIXTURE, asOf: "2026-08-09" });
      expect(spy).toHaveBeenCalled();
      const [call] = spy.mock.calls;
      expect(call[0].extract).toBe(FIXTURE.extract);
      expect(call[0].region.status).toBe(regionBoundary.BOUNDARY_STATUS.VALID);
      spy.mockRestore();
    });
  });
});

describe("supplying the decisions releases exactly the steps they release", () => {
  test("D1 + D3 alone release Step 1 and Step 3 to NOT_MEASURED — and leave Step 4 BLOCKED on D8", () => {
    const report = readiness.assess({ config: { region: FIXTURE.region, cover: FIXTURE.cover, chargers: FIXTURE.chargers, mobility: FIXTURE.mobility }, asOf: "2026-08-09" });
    expect(report.decisions.D1.status).toBe(READINESS.PASS);
    expect(report.decisions.D3.status).toBe(READINESS.PASS);
    expect(report.decisions.D8.status).toBe(READINESS.BLOCKED);

    // Released, but nothing has been measured — which is the honest state and is not a pass.
    expect(stepOf(report, 1).status).toBe(READINESS.NOT_CONFIGURED);
    expect(stepOf(report, 3).status).toBe(READINESS.NOT_MEASURED);
    expect(stepOf(report, 4).status).toBe(READINESS.BLOCKED);
    expect(stepOf(report, 4).blockedBy).toEqual(["D8"]);
    // Step 5 stays blocked in every case until 1, 3 and 4 carry recorded evidence.
    expect(stepOf(report, 5).status).toBe(READINESS.BLOCKED);
    expect(report.overall).toBe(READINESS.BLOCKED);
  });

  test("all three supplied still does not make Step 5 a PASS — selection is a decision, not an output", () => {
    const report = readiness.assess({ config: FIXTURE, asOf: "2026-08-09" });
    expect([report.decisions.D1.status, report.decisions.D3.status, report.decisions.D8.status]).toEqual([READINESS.PASS, READINESS.PASS, READINESS.PASS]);
    expect(stepOf(report, 5).status).toBe(READINESS.BLOCKED);
    expect(report.engineSelected).toBe(false);
    // No step may report PASS on evidence that was never recorded.
    expect(stepOf(report, 3).status).toBe(READINESS.NOT_MEASURED);
    expect(stepOf(report, 4).status).toBe(READINESS.NOT_MEASURED);
  });

  test("a stub speed model in an otherwise complete answer FAILS D3 and re-blocks Step 1", () => {
    const stubbed = { ...FIXTURE, mobility: [{ ...FIXTURE.mobility[0], speedModel: { note: "TBD" } }] };
    const report = readiness.assess({ config: stubbed, asOf: "2026-08-09" });
    expect(report.decisions.D3.status).toBe(READINESS.FAIL);
    expect(stepOf(report, 1).status).toBe(READINESS.BLOCKED);
    expect(stepOf(report, 1).blockedBy).toEqual(["D3"]);
    expect(report.stepEvidenceAdmissible).toBe(false);
  });

  test("TWO MODELS UNDER ONE modelId COLLIDE ON THEIR PROFILE KEY, and D3 FAILS — C4", () => {
    // The property is of the SET, not of any one model: both models here are individually
    // routable, so `validateRoutingReadiness()` cannot see it. The profile key names one
    // contraction hierarchy per region and is the first component of every §20.3 cache key, so
    // two models under one key share both — one model's edge costs served for the other.
    // `MobilityModel.modelId` is `@unique` in the schema, but a ROUTING_B1_DEPLOYMENT module is
    // a hand-written file the durable store never sees, and it is the only input assessD3 reads.
    const twin = { ...FIXTURE.mobility[0], dimensionalFootprint: { widthMm: "fixture" } };
    const report = readiness.assess({ config: { ...FIXTURE, mobility: [FIXTURE.mobility[0], twin] }, asOf: "2026-08-09" });

    expect(report.decisions.D3.models.every((model) => model.routable)).toBe(true);
    expect(report.decisions.D3.status).toBe(READINESS.FAIL);
    expect(report.decisions.D3.problems.join("\n")).toMatch(/derive the same routing profile key/u);
    expect(report.decisions.D3.problems.join("\n")).toMatch(/§38\.7 C4/u);
    // …and a colliding set must not release Step 1.
    expect(stepOf(report, 1).status).toBe(READINESS.BLOCKED);
    expect(stepOf(report, 1).blockedBy).toEqual(["D3"]);
    expect(report.stepEvidenceAdmissible).toBe(false);
  });

  test("two DISTINCT models key distinctly and D3 passes — the check refuses collisions, not plurality", () => {
    const second = { ...FIXTURE.mobility[0], modelId: "FIXTURE-CLASS-2" };
    const report = readiness.assess({ config: { ...FIXTURE, mobility: [FIXTURE.mobility[0], second] }, asOf: "2026-08-09" });
    expect(report.decisions.D3.status).toBe(READINESS.PASS);
    expect(report.decisions.D3.models.map((model) => model.profileKey)).toEqual([
      "FIXTURE-CLASS:SIDEWALK_GRAPH:unloaded",
      "FIXTURE-CLASS-2:SIDEWALK_GRAPH:unloaded",
    ]);
  });

  test("an invalid region FAILS D1 rather than blocking it — somebody answered, and the answer is unusable", () => {
    const swapped = { ...FIXTURE, region: { ...FIXTURE.region, boundary: { type: "Polygon", coordinates: [[[12.9, 100.5], [12.9, 100.6], [13, 100.6], [12.9, 100.5]]] } } };
    const report = readiness.assess({ config: swapped, asOf: "2026-08-09" });
    expect(report.decisions.D1.status).toBe(READINESS.FAIL);
    expect(report.decisions.D1.problems.join("\n")).toMatch(/not a latitude/u);
  });

  test("TWO OVERLAPPING REGIONS FAIL D1 — the region under assessment is always in V-11's set", () => {
    // The seam documents `regions?` as "the OTHER region declarations, for V-11 disjointness",
    // and `assessD1` read `source.regions.map(...)` *instead of* the declaration rather than
    // beside it. So supplying one neighbour handed `validateRegionsDisjoint` a single region —
    // and a single region cannot overlap. Two regions sharing half their area reported D1 PASS
    // with zero problems: the check was called, and was a no-op in the exact configuration it
    // exists for.
    const overlapping = { ...FIXTURE.region, regionId: "FIXTURE-NEIGHBOUR", name: "neighbour", boundary: { type: "Polygon", coordinates: [[[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5], [0.5, 0.5]]] } };
    const report = readiness.assess({ config: { ...FIXTURE, regions: [overlapping] }, asOf: "2026-08-09" });
    expect(report.decisions.D1.status).toBe(READINESS.FAIL);
    expect(report.decisions.D1.problems.join("\n")).toMatch(/V-11 regions .* overlap/u);
    expect(report.decisions.D1.problems.join("\n")).toMatch(/FIXTURE-NEIGHBOUR/u);
    // …and Step 1 is re-blocked, because an overlapping region is not a released D1.
    expect(stepOf(report, 1).status).toBe(READINESS.BLOCKED);
    expect(report.stepEvidenceAdmissible).toBe(false);
  });

  test("a DISJOINT neighbour still passes — V-11 refuses overlap, not plurality", () => {
    const disjoint = { ...FIXTURE.region, regionId: "FIXTURE-FAR", name: "far", boundary: { type: "Polygon", coordinates: [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]] } };
    expect(readiness.assess({ config: { ...FIXTURE, regions: [disjoint] }, asOf: "2026-08-09" }).decisions.D1.status).toBe(READINESS.PASS);
  });

  test("AN EDGE-ADJACENT NEIGHBOUR IS DISJOINT — R-2, at the production authority path", () => {
    // A2's fix made V-11 reachable from `assessD1` for the first time, and the first thing an
    // operator supplying two genuinely adjacent regions would have met is a FAIL. Regions that
    // abut share no area, so no Agent and no Leg is in two of them; the geometry contract is
    // asserted in spatialRegionBoundary.test.js and this asserts the gate reads it.
    const abutting = { ...FIXTURE.region, regionId: "FIXTURE-ABUTTING", name: "abutting", boundary: { type: "Polygon", coordinates: [[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]] } };
    const report = readiness.assess({ config: { ...FIXTURE, regions: [abutting] }, asOf: "2026-08-09" });
    expect(report.decisions.D1).toMatchObject({ status: READINESS.PASS, problems: [] });

    // …and one degree of genuine shared interior on the same pair is still a FAIL. The change is
    // to what "overlap" means, not to whether V-11 fires.
    const intruding = { ...abutting, regionId: "FIXTURE-INTRUDING", boundary: { type: "Polygon", coordinates: [[[0.9, 0], [2, 0], [2, 1], [0.9, 1], [0.9, 0]]] } };
    const spoiled = readiness.assess({ config: { ...FIXTURE, regions: [intruding] }, asOf: "2026-08-09" });
    expect(spoiled.decisions.D1.status).toBe(READINESS.FAIL);
    expect(spoiled.decisions.D1.problems.join("\n")).toMatch(/V-11 regions .* overlap — they share area, not merely a boundary/su);
    expect(stepOf(spoiled, 1).status).toBe(READINESS.BLOCKED);
  });

  describe("R-1 — a malformed entry in regions[] is REPORTED, never dropped", () => {
    // PHASE 15 residual pass. `validateRegionsDisjoint` filters its argument to the entries whose
    // status is VALID — it can only compare geometry it has — and `assessD1` folded in the
    // DISJOINTNESS problems and never the neighbours' own declaration problems. So a malformed
    // entry vanished before V-11 saw the set and D1 reported PASS with zero problems over a
    // collection containing unusable data: the same shape as A2, one layer further out.
    //
    // Every malformed input below is built by this block rather than perturbed from FIXTURE, so
    // what is asserted is that the gate refuses inputs this test invented — not that it refuses
    // a fixture somebody already arranged to fail.
    const ring = (minLon, minLat, maxLon, maxLat) => [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]];
    const neighbour = (regionId, coordinates) => ({
      regionId,
      name: `neighbour — not an operating region (${regionId})`,
      kind: "METRO_SERVICE_AREA",
      crs: "EPSG:4326",
      version: "r1-fixture",
      versionDate: "2026-08-09",
      boundary: { type: "Polygon", coordinates },
    });
    const FAR = neighbour("R1-FAR", [ring(20, 20, 21, 21)]);
    const d1Of = (regions) => readiness.assess({ config: { ...FIXTURE, regions }, asOf: "2026-08-09" }).decisions.D1;

    test("the controls — an absent, empty, or well-formed regions[] is unaffected", () => {
      // The property that keeps this fix from being a widening: legitimate collections behave
      // exactly as they did. `regions?` is optional in the seam and its absence is still absence.
      expect(d1Of(undefined)).toMatchObject({ status: READINESS.PASS, problems: [] });
      expect(d1Of([])).toMatchObject({ status: READINESS.PASS, problems: [] });
      expect(d1Of([FAR])).toMatchObject({ status: READINESS.PASS, problems: [] });
      expect(d1Of([FAR, neighbour("R1-FAR-2", [ring(30, 30, 31, 31)])])).toMatchObject({ status: READINESS.PASS, problems: [] });
    });

    test.each([
      ["1 · malformed geometry — a ring of three positions", [neighbour("R1-RING", [[[5, 5], [6, 5], [5, 5]]])], /regions\[0\] does not validate.*RFC 7946/su],
      ["2 · no region identifier", [{ ...neighbour("R1-NOID", [ring(5, 5, 6, 6)]), regionId: undefined }], /regions\[0\] does not validate.*regionId is required/su],
      ["3 · malformed coordinates — a [lat, lon] file", [neighbour("R1-SWAP", [[[5, 500], [6, 500], [6, 501], [5, 500]]])], /regions\[0\] does not validate.*not a latitude/su],
      ["3b · a coordinate that is not a number", [neighbour("R1-NAN", [[[5, 5], ["6", 5], [6, 6], [5, 5]]])], /regions\[0\] does not validate.*two finite numbers/su],
      ["4 · a null entry", [null], /regions\[0\] is empty \(null or undefined\)/u],
      ["4b · an undefined entry", [undefined], /regions\[0\] is empty \(null or undefined\)/u],
      ["5 · a non-object entry — a string", ["R1-STRING"], /regions\[0\] does not validate.*a region declaration must be an object/su],
      ["5b · a non-object entry — a number", [7], /regions\[0\] does not validate.*a region declaration must be an object/su],
      ["7 · all entries invalid", [null, 7, { regionId: "R1-BARE" }], /regions\[0\] is empty[\s\S]*regions\[1\][\s\S]*regions\[2\]/u],
    ])("%s cannot disappear — D1 FAILS and names the slot", (_label, regions, pattern) => {
      const d1 = d1Of(regions);
      expect(d1.status).toBe(READINESS.FAIL);
      expect(d1.problems.join("\n")).toMatch(pattern);
    });

    test("6 · a mixed collection is reported entry by entry — the valid ones are not what saves it", () => {
      const d1 = d1Of([FAR, null, neighbour("R1-BAD", [[[5, 5], [6, 5], [5, 5]]])]);
      expect(d1.status).toBe(READINESS.FAIL);
      // The slot index is the operator's own array index, so the message points at the entry.
      expect(d1.problems.join("\n")).toMatch(/regions\[1\] is empty/u);
      expect(d1.problems.join("\n")).toMatch(/regions\[2\] does not validate/u);
      // …and the well-formed entry at [0] is not blamed for its neighbours.
      expect(d1.problems.join("\n")).not.toMatch(/regions\[0\]/u);
    });

    test("A MALFORMED ENTRY DOES NOT SUPPRESS V-11 — a real overlap beside it is still caught", () => {
      // The narrow reading of R-1 was "an unusable neighbour is silently not compared", not
      // "V-11 is off". Both must hold at once: the unusable entry is reported AND the comparison
      // still runs over the entries that are usable.
      const overlapping = neighbour("R1-OVERLAP", [ring(0.5, 0.5, 1.5, 1.5)]);
      const d1 = d1Of([null, overlapping]);
      expect(d1.status).toBe(READINESS.FAIL);
      expect(d1.problems.join("\n")).toMatch(/regions\[0\] is empty/u);
      expect(d1.problems.join("\n")).toMatch(/V-11 regions .*"R1-OVERLAP".* overlap/su);
    });

    test("regions[] that is not an array at all is a wrong answer, not an absence", () => {
      // The same defect one level up: a mistyped collection was read as "no neighbours", which
      // switches V-11 off for exactly the deployment it exists for. §4.1 rule 3 — state is never
      // inferred from the absence of data — and the seam writes the key `regions?`, so omitting
      // it is the way to say there are none.
      for (const regions of [null, 7, "R1-STRING", { "R1-KEYED": {} }, true]) {
        const d1 = d1Of(regions);
        expect({ regions: String(regions), status: d1.status }).toEqual({ regions: String(regions), status: READINESS.FAIL });
        expect(d1.problems.join("\n")).toMatch(/V-11 regions must be an array of region declarations/u);
      }
    });

    test("a malformed neighbour re-blocks Step 1 and keeps a benchmark inadmissible", () => {
      // A defect that only changed a message would be worth little. D1 not passing is what holds
      // Step 1, and Step 1 not being released is what marks a run inadmissible as Step 3 evidence.
      const report = readiness.assess({ config: { ...FIXTURE, regions: [null] }, asOf: "2026-08-09" });
      expect(report.decisions.D1.status).toBe(READINESS.FAIL);
      expect(stepOf(report, 1).status).toBe(READINESS.BLOCKED);
      expect(stepOf(report, 1).blockedBy).toEqual(["D1"]);
      expect(report.stepEvidenceAdmissible).toBe(false);
      expect(report.overall).toBe(READINESS.BLOCKED);
    });
  });

  test("re-declaring the assessed region inside regions[] is reported as a duplicate, not compared with itself", () => {
    // The fail-closed direction on the other branch: §3.5 makes region → shard a function, so
    // one id naming two declarations is undefined rather than redundant. Both branches produce
    // a problem; neither produces a pass.
    const report = readiness.assess({ config: { ...FIXTURE, regions: [FIXTURE.region] }, asOf: "2026-08-09" });
    expect(report.decisions.D1.status).toBe(READINESS.FAIL);
    expect(report.decisions.D1.problems.join("\n")).toMatch(/re-declares "TEST-FIXTURE-NOT-A-REGION", the region under assessment/u);
  });

  test("V-12 RUNS UNCONDITIONALLY — an absent charger catalogue is an absence, never a pass", () => {
    // This was guarded by `Array.isArray(source.chargers) && source.cover`, so a deployment
    // that supplied no catalogue skipped V-12 in silence and D1 reported PASS. `chargers` is
    // not optional in the seam (`regions?` and `cardinalityException?` carry the question mark;
    // `chargers` does not) and §14.5 makes it E_return's population.
    for (const chargers of [undefined, null, { "CHG-1": "cell" }, "CHG-1", 7]) {
      const report = readiness.assess({ config: { ...FIXTURE, chargers }, asOf: "2026-08-09" });
      expect({ chargers: JSON.stringify(chargers) || String(chargers), status: report.decisions.D1.status }).toEqual({
        chargers: JSON.stringify(chargers) || String(chargers),
        status: READINESS.FAIL,
      });
      expect(report.decisions.D1.problems.join("\n")).toMatch(/V-12 cannot run/u);
    }
    // A charger outside the cover is still caught, and a charger inside it still passes.
    const outside = readiness.assess({ config: { ...FIXTURE, chargers: [{ chargerId: "CHG-OUT", cellId: cells.cellForPoint(40, 40, cells.RESOLUTION.FINE) }] }, asOf: "2026-08-09" });
    expect(outside.decisions.D1.status).toBe(READINESS.FAIL);
    expect(outside.decisions.D1.problems.join("\n")).toMatch(/V-12 charger "CHG-OUT".*not in this region's cover/su);
    expect(readiness.assess({ config: FIXTURE, asOf: "2026-08-09" }).decisions.D1.status).toBe(READINESS.PASS);
  });

  test("A BENCHMARK RUN IS NOT ADMISSIBLE WHILE NO CANDIDATE IS DEPLOYED — Step 1 NOT_CONFIGURED is not release", () => {
    // The flag asked only whether Steps 1 and 3 were not BLOCKED, and Step 1 has a fifth state:
    // NOT_CONFIGURED — "D1 and D3 are supplied; no candidate deployment is configured yet". So
    // with the decisions answered and nothing deployed and no hierarchy built, it read `true`.
    // That was reachable: `adapters/index.js` calls any module passed to `--engine ./x.js`
    // AVAILABLE on the strength of a `matrix()` function, so a hand-written adapter is measured
    // — and those numbers would have been called admissible Step 3 evidence.
    const report = readiness.assess({ config: FIXTURE, asOf: "2026-08-09" });
    expect([report.decisions.D1.status, report.decisions.D3.status, report.decisions.D8.status]).toEqual([READINESS.PASS, READINESS.PASS, READINESS.PASS]);
    expect(stepOf(report, 1).status).toBe(READINESS.NOT_CONFIGURED);
    expect(report.candidates.deployed).toEqual([]);
    expect(report.stepEvidenceAdmissible).toBe(false);
    expect(readiness.format(report)).toMatch(/would NOT be admissible as B1 Step 3 evidence/u);
    // The narrowing is one-directional: nothing here turns a BLOCKED step into anything else.
    expect(stepOf(report, 5).status).toBe(READINESS.BLOCKED);
    expect(report.overall).not.toBe(READINESS.PASS);
    expect(report.engineSelected).toBe(false);
  });

  test("the seeded map is not a region, and supplying it as one is refused", () => {
    // The trap §36.1.2 names: `SEED_SPATIAL_MAP` declares `RGN-BLR`, "Bengaluru operating
    // region", and it is TEST/SEED data with no geometry at all. Promoting it would manufacture
    // D1, so the gate must refuse it rather than accept a named region as an answer.
    const asRegion = { regionId: SEED_SPATIAL_MAP.regions[0].id, name: SEED_SPATIAL_MAP.regions[0].name };
    const report = readiness.assess({ config: { region: asRegion }, asOf: "2026-08-09" });
    expect(report.decisions.D1.status).toBe(READINESS.FAIL);
    expect(report.decisions.D1.problems.join("\n")).toMatch(/V-1 field 3: boundary is required/u);
  });
});

describe("the CLI", () => {
  test("prints the gate and exits 0 — a missing decision is not a build failure", () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    const code = readiness.main([]);
    const printed = log.mock.calls.map((call) => String(call[0])).join("\n");
    log.mockRestore();

    expect(code).toBe(0);
    expect(printed).toMatch(/OVERALL: BLOCKED/u);
    expect(printed).toMatch(/EXTERNAL DECISIONS — none of these is an engineering task/u);
    expect(printed).toMatch(/NO ENGINE IS SELECTED, RANKED OR RECOMMENDED BY THIS TOOL/u);
  });
});

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
  },
});

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
  const assess = (extract, asOf) => readiness.assessD8({ extract }, { asOf });

  test("no extract metadata is BLOCKED, and the message says why there is nowhere to record one", () => {
    expect(assess(undefined).status).toBe(READINESS.BLOCKED);
    expect(assess(undefined).problems.join("\n")).toMatch(/mapVersion defaults to 0 and is explicitly not a foreign key/u);
  });

  test("each missing D8 field is BLOCKED and is named as a decision rather than a derivation", () => {
    const complete = FIXTURE.extract;
    for (const field of ["identity", "source", "vintage", "refreshCadenceDays", "recontractionDowntimeBudgetSeconds"]) {
      const result = assess({ ...complete, [field]: undefined });
      expect({ field, status: result.status }).toEqual({ field, status: READINESS.BLOCKED });
      expect({ field, named: result.problems.join("\n").includes(`extract.${field}`) }).toEqual({ field, named: true });
    }
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
});

describe("supplying the decisions releases exactly the steps they release", () => {
  test("D1 + D3 alone release Step 1 and Step 3 to NOT_MEASURED — and leave Step 4 BLOCKED on D8", () => {
    const report = readiness.assess({ config: { region: FIXTURE.region, cover: FIXTURE.cover, mobility: FIXTURE.mobility }, asOf: "2026-08-09" });
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

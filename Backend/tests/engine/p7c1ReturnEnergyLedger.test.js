"use strict";

/**
 * P7-C1 — TSK-816's E_return, traced and pinned.
 *
 * Step 2 (test-only) traced the ledger. Step 3 then priced the return leg between exact points
 * (`p7c1ExactReturnLeg.test.js`); the real path below now asserts the corrected ledger, and the
 * Step 2 (pre-fix) ledger is reconstructed through the same pure `eReturn.evaluate` from the
 * candidate Step 2 measured, so both stay visible side by side:
 *
 *                     route        raw Wh   ×1.4375   E_return   surplus     F34
 *   Step 2 (before)   565.55 m     44.84    once      64.46 Wh   −13.95 Wh   INDETERMINATE → DENY
 *   Step 3 (after)     65.71 m      5.21    once       7.49 Wh   +43.02 Wh   SATISFIED (T1 p 0.0047)
 *
 * What Step 2 established, and Step 3 did not change:
 *   · E_return = distance × Wh/m × inflation, computed ONCE, in `energy/eReturn.evaluate`.
 *   · The inflation is 1.15 × 1.25 = 1.4375 because the basis is DEPOT_ONLY: no fresh charger
 *     availability projection is pinned, so §14.5's fallback applies
 *     `energy.charger_availability_margin` AND `energy.uncalibrated_reserve_factor`.
 *   · `energy.combined_nominal_conservatism` is a PUBLISHED product only — read by the
 *     publish-time cap checks and diagnostics — and is never multiplied into an energy figure.
 *   · E_mission carries no margin at all (κ = 1).
 *   · F34 is INDETERMINATE when the return reserve is unreachable (no E_return layer → the
 *     reserve stack cannot compose → no tier probabilities → null energy fragment), and VIOLATED
 *     only when the reserve composes and a tier is over budget.
 *
 * MOCKED BOUNDARY: `phase7World`'s in-memory store seeded from real LOCAL rows, a pinned
 * clock, and spies that only OBSERVE (each calls the original and returns its result).
 */

const fs = require("fs");
const path = require("path");

const eReturn = require("../../src/engine/energy/eReturn");
const consumption = require("../../src/engine/energy/consumption");
const schedulerClient = require("../../src/engine/energy/chargingSchedulerClient");
const simulatedAgentState = require("../../src/simulation/simulatedAgentState");
const configService = require("../../src/engine/config/service");
const f34 = require("../../src/engine/feasibility/predicates/f34");
const feasibilityRegister = require("../../src/engine/feasibility/register");
const { applyPolicy } = require("../../src/engine/feasibility/threeValued");
const fixture = require("../fixtures/phase7/local-2026-10-09.json");
const w = require("./helpers/phase7World");

jest.setTimeout(60_000);

const DT = w.TSK816.assignRoundMs;
const AGENT = "SIM-0A8C043FFE67";
const DEPOT = "V1DEMO-DEPOT-01";
const DEV_CHARGER = "DEV-SIM-RNSIT-MBA-01";
const CHARGER_CELLS = new Set(["8b6014510498fff", "8b6014510496fff"]);

/**
 * The depot candidate Step 2 measured under the cell-pair return pricing (before Step 3):
 * 65.55 m routed between cell representatives + 2 × 250 m `route.intra_cell_offset_m`.
 */
const PRE_FIX_DEPOT_CANDIDATE = Object.freeze({
  chargerId: DEPOT,
  chargerClass: "STANDARD",
  isDepot: true,
  distanceM: 565.5544769965213,
  travelSeconds: 413.800655118422,
  energyWh: 44.84039067615276,
});

/** The four robots as the store held them at 13:44:13.786Z (as `phase7AssignmentQuality` B1). */
function tsk816Fleet(socOfAgent) {
  return [
    { robotId: AGENT, at: { lat: 12.901151, lon: 77.517575 }, socFraction: socOfAgent ?? 0.29, status: "IDLE", positionAgeMs: 351 },
    {
      robotId: "SIM-1ABF21512BE5", at: { lat: 12.900817, lon: 77.518043 }, socFraction: 0.362, status: "PAUSED", positionAgeMs: 350,
      openCommitments: [{ legId: "leg-of-TSK-1790958521622-254", leaseExpiry: new Date("2026-10-02T16:53:35.042Z") }],
    },
    {
      robotId: "SIM-CFE1E46B2002", at: { lat: 12.900411, lon: 77.518715 }, socFraction: 0.62, status: "PAUSED", positionAgeMs: 349,
      openCommitments: [{ legId: "leg-of-TSK-1790960698218-551", leaseExpiry: new Date("2026-10-02T17:29:19.351Z") }],
    },
    { robotId: "SIM-9F6F88D84EBD", at: { lat: 12.90032004, lon: 77.51870238 }, socFraction: 0.95, status: "IDLE", positionAgeMs: 1360 },
  ];
}

/** Run the decision with observe-only spies on E_return, E_mission and projection consumption. */
async function decideObserved(scenario) {
  const eReturnCalls = [];
  const missionCalls = [];
  const consumed = [];
  const originals = { evaluate: eReturn.evaluate, mission: consumption.missionEnergyWh, consume: schedulerClient.consumeProjection };
  const spies = [
    jest.spyOn(eReturn, "evaluate").mockImplementation((input) => {
      const result = originals.evaluate(input);
      eReturnCalls.push({ input, result });
      return result;
    }),
    jest.spyOn(consumption, "missionEnergyWh").mockImplementation((model, profiles, kappa) => {
      const result = originals.mission(model, profiles, kappa);
      missionCalls.push({ model, profiles, kappa, result });
      return result;
    }),
    jest.spyOn(schedulerClient, "consumeProjection").mockImplementation((raw) => {
      const result = originals.consume(raw);
      consumed.push({ raw, result });
      return result;
    }),
  ];
  try {
    const out = await w.decide(scenario);
    return { out, eReturnCalls, missionCalls, consumed };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** The pack every LOCAL SIM declares, and SIM-0A8C's SoC at decision time. */
const PACK_WH = 500;
const SOC = 0.29;

/** SIM-0A8C's eReturn call: the only priced plan whose starting usable energy is its 29 % of 500 Wh. */
function callOf(observed, soc) {
  const mine = observed.eReturnCalls.filter((entry) => Math.abs(entry.input.usableWh - PACK_WH * (soc ?? SOC)) < 1e-9);
  expect(mine).toHaveLength(1);
  return mine[0];
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. The real decision: every intermediate value of SIM-0A8C's E_return
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-C1 — TSK-816, SIM-0A8C: the E_return ledger, value by value", () => {
  let observed;
  let call; // SIM-0A8C's eReturn.evaluate call
  let depot; // its depot candidate

  beforeAll(async () => {
    observed = await decideObserved({ decisionTimeMs: DT, robots: tsk816Fleet() });
    call = callOf(observed);
    depot = call.input.candidates.find((row) => row.chargerId === DEPOT);
  });

  test("observing changes nothing: the decision is the one the code makes — SIM-0A8C, now feasible under exact return pricing", () => {
    expect(observed.out.winner).toBe(AGENT);
    expect(observed.out.candidates.find((entry) => entry.agentId === AGENT)).toMatchObject({ rejected: false });
  });

  test("inputs: usable 145 Wh = 500 Wh × 0.29 (SoH, f_temp and f_derate all 1); floor 25 Wh; margins 1.15 and 1.25", () => {
    expect(call.input.usableWh).toBeCloseTo(PACK_WH * SOC, 10);
    expect(call.input.floorWh).toBe(25);
    expect(call.input.availabilityMargin).toBe(1.15);
    expect(call.input.uncalibratedReserveFactor).toBe(1.25);
    expect(call.input.projectionMaxAgeSeconds).toBe(120);
  });

  test("route: the depot return hop is priced between the drop stop and the depot — 65.71 m, no offset", () => {
    const returnHops = observed.out.routeCalls
      .filter((entry) => entry.ok && entry.stops.length === 1 && CHARGER_CELLS.has(entry.stops[0].cellId))
      .map((entry) => entry.hops[0]);
    const hop = returnHops.find((entry) => Math.abs(entry.distanceM - depot.distanceM) < 1e-9);
    expect(hop.intraCellOffsetM).toBe(0);
    expect(hop.exact).toBe(true);
    expect(depot.distanceM).toBeCloseTo(65.7059, 3);
    expect(depot.isDepot).toBe(true);
    // The development charger is priced exactly too (359.54 m; 862.03 m before) and is not a depot.
    expect(call.input.candidates.find((row) => row.chargerId === DEV_CHARGER)).toMatchObject({ isDepot: false });
  });

  test("Wh per metre = (β_aux + β_move) / speed = 0.111 Wh/s ÷ 1.4 m/s — the simulator's own active drain, no margin", () => {
    const coefficients = simulatedAgentState.simulatedEnergyCoefficients(PACK_WH);
    const activeWhPerSecond = coefficients.betaAux + coefficients.betaMoveTime;
    expect(activeWhPerSecond).toBeCloseTo(0.111, 12); // 0.0444 %/2 s of 500 Wh
    expect(depot.energyWh / depot.distanceM).toBeCloseTo(activeWhPerSecond / 1.4, 12);
    // The same rate the pre-fix candidate was priced at: only the distance changed.
    expect(PRE_FIX_DEPOT_CANDIDATE.energyWh / PRE_FIX_DEPOT_CANDIDATE.distanceM).toBeCloseTo(activeWhPerSecond / 1.4, 12);
    expect(depot.energyWh).toBeCloseTo(5.2095, 3);
  });

  test("basis DEPOT_ONLY → inflation 1.15 × 1.25 = 1.4375, applied exactly ONCE: 5.21 Wh → 7.49 Wh", () => {
    const { result } = call;
    expect(result.basis).toBe("DEPOT_ONLY");
    expect(result.degradation).toMatchObject({ mode: "DEPOT_ONLY_RETURN_TARGETS", appliedFactor: 1.25 });
    // Depot-only admits depots only: the development charger is not even considered.
    expect(result.verdict.considered.map((row) => row.chargerId)).toEqual([DEPOT]);
    expect(result.verdict.chargerId).toBe(DEPOT);

    const ratio = result.verdict.eReturnWh / depot.energyWh;
    expect(ratio).toBeCloseTo(1.15 * 1.25, 12);
    expect(result.verdict.eReturnWh).toBeCloseTo(7.4887, 3);
    // Not 1.15 alone, and not either factor twice.
    for (const doubled of [1.15, 1.4375 * 1.4375, 1.4375 * 1.15, 1.4375 * 1.25]) expect(Math.abs(ratio - doubled)).toBeGreaterThan(1e-3);
  });

  test("E_mission carries no margin: κ = 1, and 69.49 Wh is moveTime + dwell + aux of the simulated coefficients", () => {
    const mission = observed.missionCalls.find((entry) => Math.abs(entry.result.wh - call.input.missionWh) < 1e-12);
    expect(mission.kappa).toBe(1);
    const [leg] = mission.result.legs;
    const [profile] = mission.profiles;
    const coefficients = simulatedAgentState.simulatedEnergyCoefficients(PACK_WH);
    expect(leg.terms.moveTime).toBeCloseTo(coefficients.betaMoveTime * profile.movingSeconds, 9);
    expect(leg.terms.dwell).toBeCloseTo(coefficients.betaDwell * profile.dwellSeconds, 9);
    expect(leg.terms.aux).toBeCloseTo(coefficients.betaAux * profile.totalSeconds, 9);
    expect(mission.result.wh).toBeCloseTo(leg.terms.bracket, 12);
    expect(call.input.missionWh).toBeCloseTo(69.4945, 3);
  });

  test("surplus = 145 − 69.49 − 25 − 7.49 = +43.02 Wh: the depot is reachable and the E_return layer exists", () => {
    const { input, result } = call;
    expect(result.verdict.surplusWh).toBeCloseTo(input.usableWh - input.missionWh - input.floorWh - result.verdict.eReturnWh, 12);
    expect(result.verdict.surplusWh).toBeCloseTo(43.0168, 3);
    expect(result.verdict.reachable).toBe(true);
    expect(eReturn.returnLayerWh(result.verdict)).toMatchObject({ ok: true, returnWh: result.verdict.eReturnWh });
  });

  test("F34 is SATISFIED: the reserve stack composes and every tier holds (binding T1, p 0.0047 < 0.01)", () => {
    expect(observed.out.denials[AGENT]).toBeUndefined();
    const evidence = observed.out.tierBInput.candidates.find((row) => row.agentId === AGENT);
    const f34Row = evidence.predicateResults.find((row) => row.predicateId === "F34");
    expect(f34Row).toMatchObject({ outcome: "SATISFIED", inputSource: "PLAN", indeterminatePolicy: null });
    expect(f34Row.observed.bindingTier).toBe("T1");
    expect(f34Row.observed.tiers.find((row) => row.tier === "T1").probability).toBeCloseTo(0.0047135, 6);
  });

  test("BEFORE (Step 2): the same evaluation over the pre-fix 565.55 m candidate — 64.46 Wh, surplus −13.95 Wh, unreachable", () => {
    const before = eReturn.evaluate({ ...call.input, candidates: [PRE_FIX_DEPOT_CANDIDATE] });
    expect(before.basis).toBe("DEPOT_ONLY");
    expect(before.verdict.eReturnWh / PRE_FIX_DEPOT_CANDIDATE.energyWh).toBeCloseTo(1.4375, 12);
    expect(before.verdict.eReturnWh).toBeCloseTo(64.4581, 3);
    expect(before.verdict.surplusWh).toBeCloseTo(-13.9526, 3);
    expect(before.verdict.reachable).toBe(false);
    expect(eReturn.returnLayerWh(before.verdict)).toMatchObject({ ok: false, returnWh: null });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. Would production have pinned a projection? Same basis, same numbers.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-C1 — the replay's null projection is a harness artefact, and production reaches the same E_return", () => {
  const row = fixture.rows.ChargerAvailabilityProjection[0];
  // The fixture's timestamps are UTC without a zone suffix (as `phase7World.reviveRow` reads them).
  const utc = (text) => new Date(`${text}Z`);
  const raw = (publishedAt) => ({ version: row.version, publishedAt, horizonEnd: utc(row.horizonEnd), chargers: row.payload.chargers });

  let input;
  beforeAll(async () => {
    const observed = await decideObserved({ decisionTimeMs: DT, robots: tsk816Fleet() });
    input = callOf(observed).input;
    // HARNESS ARTEFACT, not production behaviour: `phase7World` copies rows with
    // `structuredClone`, which under Jest is Node's outer-realm global, so the projection's
    // `publishedAt` is a Date from another realm — `[object Date]`, but `instanceof Date` is
    // false inside the test sandbox — and `consumeProjection` (which tests `instanceof Date`)
    // refuses it. A real Prisma row's Date is of the code's own realm.
    expect(observed.consumed.length).toBeGreaterThan(0);
    for (const entry of observed.consumed) {
      expect(Object.prototype.toString.call(entry.raw.publishedAt)).toBe("[object Date]");
      expect(entry.raw.publishedAt instanceof Date).toBe(false);
      expect(entry.result.problems).toEqual(["the projection states no publication time, so its staleness cannot be measured (§14.5)"]);
    }
  });

  test("with a same-realm Date, as a real Prisma row carries, the projection is pinned — and is 8.4 days stale against a 120 s maximum", () => {
    const consumed = schedulerClient.consumeProjection(raw(utc(row.publishedAt)));
    expect(consumed.ok).toBe(true);
    const freshness = eReturn.staleness(consumed.projection, input.decisionTimeMs, input.projectionMaxAgeSeconds);
    expect(freshness.fresh).toBe(false);
    // 1791553453786 − 1790825206502 ms = 728 247.284 s ≈ 8.43 days, against 120 s.
    expect(freshness.ageSeconds).toBeCloseTo(728247.284, 3);
  });

  test("so production takes the same DEPOT_ONLY basis and the same E_return, for a different stated reason", () => {
    const pinned = schedulerClient.consumeProjection(raw(utc(row.publishedAt))).projection;
    const replayed = eReturn.evaluate(input);
    const production = eReturn.evaluate({ ...input, projection: pinned });
    expect(production.basis).toBe("DEPOT_ONLY");
    expect(production.verdict.eReturnWh).toBe(replayed.verdict.eReturnWh);
    expect(production.verdict.surplusWh).toBe(replayed.verdict.surplusWh);
    expect(replayed.degradation.reason).toBe("no charger availability projection is pinned into this round");
    expect(production.degradation.reason).toMatch(/^the projection is \d+(\.\d+)? s old, beyond energy\.charger_projection_max_age$/);
  });

  test("COUNTERFACTUAL — a fresh projection showing the depot reservable: PINNED basis, 1.15 only", () => {
    const fresh = schedulerClient.consumeProjection({
      version: 99,
      publishedAt: new Date(input.decisionTimeMs - 60_000),
      horizonEnd: new Date(input.decisionTimeMs + 3_600_000),
      chargers: [{ chargerId: DEPOT, isDepot: true, intervals: [{ state: "RESERVABLE", fromMs: input.decisionTimeMs - 60_000, untilMs: input.decisionTimeMs + 3_600_000 }] }],
    }).projection;
    // After (exact): 5.21 Wh × 1.15 = 5.99 Wh, surplus +44.51 Wh.
    const after = eReturn.evaluate({ ...input, projection: fresh });
    expect(after.basis).toBe("PINNED_PROJECTION");
    expect(after.verdict.eReturnWh / input.candidates.find((entry) => entry.chargerId === DEPOT).energyWh).toBeCloseTo(1.15, 12);
    expect(after.verdict.eReturnWh).toBeCloseTo(5.9910, 3);
    expect(after.verdict.surplusWh).toBeCloseTo(44.5145, 3);
    // Before (Step 2, cell pair): 44.84 Wh × 1.15 = 51.57 Wh, still unreachable by 1.06 Wh.
    const before = eReturn.evaluate({ ...input, candidates: [PRE_FIX_DEPOT_CANDIDATE], projection: fresh });
    expect(before.verdict.eReturnWh).toBeCloseTo(51.5664, 3);
    expect(before.verdict.surplusWh).toBeCloseTo(-1.0610, 3);
    expect(before.verdict.reachable).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. The published 1.4375 is a declaration, not a multiplier
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-C1 — energy.combined_nominal_conservatism is published, never applied", () => {
  test("it is the declared product 1.15 × 1.25 × 1.00 of three factors that each compensate something different", () => {
    const snapshot = configService.defaultSnapshot();
    const evidence = snapshot.derivationEvidence.conservatism;
    expect(evidence.factors.nominal).toEqual({
      "energy.charger_availability_margin": 1.15,
      "energy.uncalibrated_reserve_factor": 1.25,
      "energy.f_derate": 1,
    });
    expect(snapshot.values.get("energy.combined_nominal_conservatism")).toBeCloseTo(1.4375, 12);
    expect(evidence.duplicateCompensations).toEqual([]);
  });

  test("no source file multiplies it into an energy figure: it is read only by derivation, validation and the cap check", () => {
    const SRC = path.resolve(__dirname, "../../src");
    const readers = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js") && /combined_nominal_conservatism|COMBINED\.NOMINAL/.test(fs.readFileSync(full, "utf8"))) {
          readers.push(path.relative(SRC, full).split(path.sep).join("/"));
        }
      }
    };
    walk(SRC);
    expect(readers.sort()).toEqual(["engine/config/derived.js", "engine/config/validators.js", "engine/energy/usable.js"]);
    // usable.js reads it only in `declaredConservatism` (the published products and their cap);
    // `usableWh` divides by f_derate alone.
    const usableSource = fs.readFileSync(path.join(SRC, "engine/energy/usable.js"), "utf8");
    expect(usableSource).toMatch(/const wh = \(source\.packNominalWh \* source\.soh \* source\.fTemp \* source\.soc\) \/ source\.fDerate;/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. Why INDETERMINATE and not VIOLATED
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-C1 — F34's outcome follows from whether a return reserve exists at all", () => {
  const ALPHA = { T1: 0.01, T2: 0.00001, T3: 1.0958904109589041e-7 };
  const config = { get: (name) => (name === "energy.shortfall_probability" ? ALPHA : undefined) };

  test("a null energy fragment is INDETERMINATE (no tier is evaluated), and DENY then denies it for indeterminacy", () => {
    const result = f34.evaluate({ plan: { energy: null, energyUnresolved: ["E_return: insufficient energy"] }, mission: {}, config });
    expect(result).toMatchObject({ outcome: "INDETERMINATE", observed: null, inputSource: "PLAN" });
    expect(result.reason).toBe("the plan's energy projection could not be built: E_return: insufficient energy");
    const resolution = applyPolicy(result, feasibilityRegister.predicate("F34"));
    expect(resolution).toMatchObject({ admitted: false, deniedForIndeterminacy: true });
  });

  test("tier probabilities over budget are VIOLATED — the branch a reachable return reserve leads to", () => {
    const result = f34.evaluate({ plan: { energy: { tierProbabilities: { T1: 0.0258, T2: 0.0000096, T3: 3.7e-9 } } }, mission: {}, config });
    expect(result).toMatchObject({ outcome: "VIOLATED", observed: expect.objectContaining({ bindingTier: "T1" }) });
  });

  test("real path, SIM-0A8C at 20 %: the depot is unreachable, so F34 is INDETERMINATE and DENY denies it", async () => {
    const observed = await decideObserved({ decisionTimeMs: DT, robots: tsk816Fleet(0.2).filter((r) => r.robotId === AGENT) });
    const { result } = callOf(observed, 0.2);
    expect(result.verdict.reachable).toBe(false);
    const [denial] = observed.out.denials[AGENT];
    expect(denial).toMatchObject({ predicateId: "F34", observed: null });
    expect(denial.reason).toMatch(/^the plan's energy projection could not be built: E_return: insufficient energy to return to charger V1DEMO-DEPOT-01/);
    const evidence = observed.out.tierBInput.candidates.find((row) => row.agentId === AGENT);
    expect(evidence.predicateResults.find((row) => row.predicateId === "F34")).toMatchObject({ outcome: "INDETERMINATE", indeterminatePolicy: "DENY" });
  });

  test("real path, SIM-0A8C at 28 %: the depot is reachable, the tiers are evaluated, and F34 is VIOLATED on T1 (p 0.0215 > 0.01)", async () => {
    const observed = await decideObserved({ decisionTimeMs: DT, robots: tsk816Fleet(0.28).filter((r) => r.robotId === AGENT) });
    const { result } = callOf(observed, 0.28);
    expect(result.verdict.reachable).toBe(true);
    const evidence = observed.out.tierBInput.candidates.find((row) => row.agentId === AGENT);
    const f34Row = evidence.predicateResults.find((row) => row.predicateId === "F34");
    expect(f34Row).toMatchObject({ outcome: "VIOLATED", indeterminatePolicy: null });
    expect(f34Row.observed.bindingTier).toBe("T1");
    expect(f34Row.observed.probability).toBeCloseTo(0.0214849, 6);
  });
});

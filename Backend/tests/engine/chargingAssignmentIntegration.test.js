"use strict";

/**
 * Phase C (charging lifecycle) — assignment and charging through the REAL decision path.
 *
 * `phase7World` runs the real Availability Index maintainer with the real charging classifier,
 * the real V1 composition (campus router, agent facts, simulated energy seams), expansion, the
 * §7 gate (F09, F18, F34 …) and the Plan Builder, over LOCAL fixture rows; only the store, the
 * clock and the commit are doubled. The Leg is the real TSK-1791553228180-816 delivery.
 *
 * What these scenarios establish, with the engine contract untouched:
 *   1. a task is refused to a low-energy robot (F34) and given to a feasible one;
 *   2. with no feasible robot the Leg stays unassigned and the denial is recorded per robot;
 *   3/4. F34's combined test — mission energy + the return to a reachable charger + the reserve
 *      floor (+ its contingency tier) within the usable energy — admits a robot that can finish and
 *      reach a charger, and refuses one that cannot;
 *   5. charger-bound (QUEUED/ACTIVE reservation), charging (CHARGING report), operator-held
 *      (PAUSED) and faulted (ERROR) robots receive no work;
 *   6. a reservation taken AFTER the index was built still keeps the robot out (F18 at the gate);
 *   7. after charging (reservation RELEASED, IDLE at 80 %) the robot is assignable again.
 *
 *   D. (step D) `E_return` prices the return against the charger set a FRESH projection publishes,
 *      and falls back to the depot (DEPOT_ONLY) when the projection is stale.
 *
 * The commit (§10.3.2) and its volatile re-verification are in `commitTimeRecheck.test.js`.
 */

const w = require("./helpers/phase7World");

jest.setTimeout(120_000);

const DT = w.TSK816.assignRoundMs;
const A = { lat: 12.901151, lon: 77.517575 }; // SIM-0A8C's LOCAL position, near TSK-816's pickup
const B = { lat: 12.900817, lon: 77.518043 }; // SIM-1ABF's LOCAL position
const robot = (robotId, at, overrides) => ({ robotId, cloneOf: "SIM-0A8C043FFE67", at, socFraction: 0.9, ...(overrides || {}) });

const byAgent = (out) => Object.fromEntries(out.candidates.map((row) => [row.agentId, row]));
const bindingOf = (out, robotId) => (byAgent(out)[robotId] || {}).bindingPredicateId || null;
const indexedAs = (out, robotId) => (out.indexed.find((row) => row.agentId === robotId) || {}).availabilityClass || null;

describe("1–2. energy feasibility chooses among robots, and says why", () => {
  test("a low-energy robot is refused (F34) and the task goes to a feasible one", async () => {
    const out = await w.decide({ decisionTimeMs: DT, robots: [robot("SIM-LOW", A, { socFraction: 0.12 }), robot("SIM-FIT", B, { socFraction: 0.9 })] });
    expect(out.outcome).toBe("ASSIGNED");
    expect(out.winner).toBe("SIM-FIT");
    expect(bindingOf(out, "SIM-LOW")).toBe("F34");
  });

  test("no feasible robot: nothing is assigned, and each robot's denial names F34", async () => {
    const out = await w.decide({ decisionTimeMs: DT, robots: [robot("SIM-LOW-1", A, { socFraction: 0.12 }), robot("SIM-LOW-2", B, { socFraction: 0.1 })] });
    expect(out.outcome).not.toBe("ASSIGNED");
    expect(out.winner).toBeNull();
    expect(bindingOf(out, "SIM-LOW-1")).toBe("F34");
    expect(bindingOf(out, "SIM-LOW-2")).toBe("F34");
  });
});

describe("3–4. F34 is the combined test: finish the delivery AND reach a charger, keeping the reserve", () => {
  test("40 % (commissioned 15 % reserve): the robot can finish TSK-816 and still reach the depot above its floor — assigned", async () => {
    const out = await w.decide({ decisionTimeMs: DT, robots: [robot("SIM-EDGE", A, { socFraction: 0.4 })] });
    expect(out.outcome).toBe("ASSIGNED");
    expect(out.winner).toBe("SIM-EDGE");
    expect(bindingOf(out, "SIM-EDGE")).toBeNull();
  });

  test("30 % (commissioned 15 % reserve): it could not finish and reach a charger with its reserve — not assigned (F34)", async () => {
    const out = await w.decide({ decisionTimeMs: DT, robots: [robot("SIM-EDGE", A, { socFraction: 0.3 })] });
    expect(out.winner).toBeNull();
    expect(bindingOf(out, "SIM-EDGE")).toBe("F34");
  });
});

describe("5. charger-bound, charging, held and faulted robots receive no work", () => {
  test.each([
    ["queued for a plug (QUEUED reservation)", { reservations: [{ robotId: "SIM-X", state: "QUEUED" }] }, {}],
    ["holding a plug / driving to the charger (ACTIVE reservation)", { reservations: [{ robotId: "SIM-X", state: "ACTIVE" }] }, {}],
    ["reporting CHARGING", {}, { liveState: { status: "CHARGING", lat: A.lat, lon: A.lon, battery: 90 } }],
    ["operator-held (PAUSED)", {}, { status: "PAUSED" }],
    ["faulted (ERROR)", {}, { status: "ERROR" }],
  ])("%s: the other robot gets the task", async (_label, scenario, overrides) => {
    const out = await w.decide({
      decisionTimeMs: DT,
      robots: [robot("SIM-X", A, { socFraction: 0.95, ...overrides }), robot("SIM-OTHER", B, { socFraction: 0.9 })],
      ...scenario,
    });
    expect(out.outcome).toBe("ASSIGNED");
    expect(out.winner).toBe("SIM-OTHER");
  });

  test("a reservation keeps the robot out of the index entirely (not merely priced worse)", async () => {
    const out = await w.decide({
      decisionTimeMs: DT,
      robots: [robot("SIM-X", A, { socFraction: 0.95 }), robot("SIM-OTHER", B, { socFraction: 0.9 })],
      reservations: [{ robotId: "SIM-X", state: "ACTIVE" }],
    });
    expect(indexedAs(out, "SIM-X")).toBeNull();
    expect(indexedAs(out, "SIM-OTHER")).toBe("IDLE_READY");
  });
});

describe("6. a charging transition racing the round cannot double-book the robot", () => {
  test("a reservation taken after the index listed the robot as available: F18 refuses it at the gate", async () => {
    const out = await w.decide({
      decisionTimeMs: DT,
      robots: [robot("SIM-RACE", A, { socFraction: 0.95 }), robot("SIM-OTHER", B, { socFraction: 0.6 })],
      afterIndex: ({ addReservation }) => addReservation({ robotId: "SIM-RACE", state: "QUEUED", fromAgoMs: 1 }),
    });
    expect(indexedAs(out, "SIM-RACE")).toBe("IDLE_READY"); // the index did not see it…
    expect(out.winner).toBe("SIM-OTHER"); // …the gate did
    expect(bindingOf(out, "SIM-RACE")).toBe("F18");
  });
});

describe("7. after charging, the robot returns to the pool", () => {
  test("reservation RELEASED, reporting IDLE at 80 %: assignable again", async () => {
    const out = await w.decide({
      decisionTimeMs: DT,
      robots: [robot("SIM-CHARGED", A, { socFraction: 0.8, liveState: { status: "IDLE", lat: A.lat, lon: A.lon, battery: 80 } })],
      reservations: [{ robotId: "SIM-CHARGED", state: "RELEASED", fromAgoMs: 900_000, untilInMs: -1000 }],
    });
    expect(indexedAs(out, "SIM-CHARGED")).toBe("IDLE_READY");
    expect(out.winner).toBe("SIM-CHARGED");
  });
});

describe("B. the commissioned reserve is F34's floor (owner decision 2026-10-12)", () => {
  test("30 % with the commissioned 15 % reserve: finishing TSK-816 and returning would breach the reserve — not assigned (F34)", async () => {
    const out = await w.decide({ decisionTimeMs: DT, robots: [robot("SIM-RES", A, { socFraction: 0.3, batteryReservePct: 15 })] });
    expect(out.winner).toBeNull();
    expect(bindingOf(out, "SIM-RES")).toBe("F34");
  });

  test("the same robot at 30 % with a 5 % reserve is assigned: the reserve alone made the difference", async () => {
    const out = await w.decide({ decisionTimeMs: DT, robots: [robot("SIM-RES", A, { socFraction: 0.3, batteryReservePct: 5 })] });
    expect(out.winner).toBe("SIM-RES");
  });

  test("with the 15 % reserve kept, enough charge (40 %) is assigned", async () => {
    const out = await w.decide({ decisionTimeMs: DT, robots: [robot("SIM-RES", A, { socFraction: 0.4, batteryReservePct: 15 })] });
    expect(out.winner).toBe("SIM-RES");
    expect(bindingOf(out, "SIM-RES")).toBeNull();
  });

  test("the floor the engine is handed is 15 % of the 500 Wh pack plus the fixed reserve (0 Wh by default) — counted once", () => {
    const composition = require("../../src/services/v1DemonstrationComposition");
    const simulatedAgentState = require("../../src/simulation/simulatedAgentState");
    const seams = composition.createV1DemonstrationComposition({ prisma: {}, kv: null, snapshot: () => ({ values: new Map() }), env: { ENABLE_VIRTUAL_SIMULATOR: "true", V1_DEMONSTRATION_COMPOSITION: "true" } });
    const snapshot = (pct) => ({ provenance: simulatedAgentState.PROVENANCE, energyModel: { packNominalWh: 500 }, batteryReservePct: pct });
    expect(seams.agentEnergyDeclarationsFor(snapshot(15)).reserveFloorWh).toBeCloseTo(75, 9);
    expect(seams.agentEnergyDeclarationsFor(snapshot(null)).reserveFloorWh).toBeCloseTo(25, 9);
  });

  test("an undeclared reserve keeps the simulator's 5 % floor", async () => {
    const out = await w.decide({ decisionTimeMs: DT, robots: [robot("SIM-RES", A, { socFraction: 0.3, batteryReservePct: null })] });
    expect(out.winner).toBe("SIM-RES");
  });
});

describe("B. TSK-816's assigning round under the commissioned reserve (the recorded replays use `asRecorded`)", () => {
  test("SIM-0A8C at 29 % now breaches its 15 % reserve (F34); the task goes to SIM-9F6F — the winner the round actually recorded", async () => {
    const out = await w.decide({
      decisionTimeMs: DT,
      robots: [
        { robotId: "SIM-0A8C043FFE67", at: A, socFraction: 0.29, status: "IDLE", positionAgeMs: 351 },
        { robotId: "SIM-9F6F88D84EBD", at: { lat: 12.90032004, lon: 77.51870238 }, socFraction: 0.95, status: "IDLE", positionAgeMs: 1360 },
      ],
    });
    expect(bindingOf(out, "SIM-0A8C043FFE67")).toBe("F34");
    expect(out.winner).toBe(w.TSK816.recordedWinner);
  });
});

describe("D. E_return prices the return against the published, reachable charger set — not always the depot", () => {
  // The development scheduler's own projection, in its own shape (`devChargingScheduler.projectionPayload`),
  // published `ageSeconds` before the round. `energy.charger_projection_max_age` is 120 s.
  const devChargingScheduler = require("../../src/simulation/devChargingScheduler");
  const fixture = require("../fixtures/phase7/local-2026-10-09.json");
  const DEPOT = fixture.rows.Charger.find((row) => row.chargerId === "V1DEMO-DEPOT-01");
  // TEST-ONLY STAND-IN for a second published charger: the fixture's superseded DEV-SIM row (a
  // real Charger row of LOCAL, `isDepot: false`). No station is activated and no coordinate is
  // invented; this only shows the engine considers whatever the projection publishes.
  const SECOND = fixture.rows.Charger.find((row) => row.chargerId === "DEV-SIM-RNSIT-MBA-01");
  const HORIZON_S = 7200;
  const published = (ageSeconds, chargers, version = 90) => {
    const atMs = DT - ageSeconds * 1000;
    return {
      id: `projection-${version}`,
      version,
      publishedAt: new Date(atMs),
      publishedBy: devChargingScheduler.PUBLISHER,
      horizonEnd: new Date(atMs + HORIZON_S * 1000),
      regionId: null,
      createdAt: new Date(atMs),
      payload: devChargingScheduler.projectionPayload({ nowMs: atMs, horizonSeconds: HORIZON_S, chargers }),
    };
  };
  const occupied = (ageSeconds) => {
    const atMs = DT - ageSeconds * 1000;
    return [{ fromMs: atMs, untilMs: atMs + HORIZON_S * 1000, state: "OCCUPIED" }];
  };
  const reachOf = async (projections) => {
    const out = await w.decide({ decisionTimeMs: DT, robots: [robot("SIM-X", A)], projections });
    return { out, reach: out.priced["SIM-X"] ? out.priced["SIM-X"].returnReach : null };
  };

  test("today (no fresh projection): DEPOT_ONLY — the depot, inflated by the uncalibrated reserve factor", async () => {
    const { out, reach } = await reachOf([published(121, [{ row: DEPOT, plugCount: 3 }])]);
    expect(reach).toMatchObject({ basis: "DEPOT_ONLY", chargerId: "V1DEMO-DEPOT-01", reachable: true, projectionVersion: null });
    expect(reach.considered.map((row) => row.chargerId)).toEqual(["V1DEMO-DEPOT-01"]);
    expect(out.winner).toBe("SIM-X");
  });

  test("a fresh projection of the active estate (the depot): PINNED — the same depot, priced at 1/1.25 of the fallback", async () => {
    const stale = (await reachOf([published(121, [{ row: DEPOT, plugCount: 3 }])])).reach;
    const { out, reach } = await reachOf([published(30, [{ row: DEPOT, plugCount: 3 }])]);
    expect(reach).toMatchObject({ basis: "PINNED_PROJECTION", chargerId: "V1DEMO-DEPOT-01", reachable: true, projectionVersion: 90 });
    // `energy.uncalibrated_reserve_factor` = 1.25 is the fallback's price, not the projection's.
    expect(stale.eReturnWh / reach.eReturnWh).toBeCloseTo(1.25, 9);
    // A Charger row the projection does not publish is considered and NOT admitted.
    expect(reach.considered.find((row) => row.chargerId === "DEV-SIM-RNSIT-MBA-01")).toMatchObject({
      admitted: false,
      reason: "the projection does not cover this charger",
    });
    expect(out.winner).toBe("SIM-X");
  });

  test("the depot OCCUPIED through the arrival, nothing else published: no viable charger — not assigned, and no silent fallback to the depot", async () => {
    const { out, reach } = await reachOf([published(30, [{ row: DEPOT, plugCount: 3, intervals: occupied(30) }])]);
    // No plan energy can be built: F34 refuses by name, with the reason the return found no charger.
    expect(reach).toBeNull();
    expect(out.winner).toBeNull();
    expect(bindingOf(out, "SIM-X")).toBe("F34");
    expect(out.denials["SIM-X"][0].reason).toMatch(/no charger admitted from the mission end/);
  });

  test("two published chargers, the depot OCCUPIED: the return is priced to the other (the active set, not the depot)", async () => {
    const { out, reach } = await reachOf([
      published(30, [
        { row: DEPOT, plugCount: 3, intervals: occupied(30) },
        { row: SECOND, plugCount: 1 },
      ]),
    ]);
    expect(reach).toMatchObject({ basis: "PINNED_PROJECTION", chargerId: "DEV-SIM-RNSIT-MBA-01", reachable: true });
    expect(reach.considered.find((row) => row.chargerId === "V1DEMO-DEPOT-01")).toMatchObject({ admitted: false });
    expect(out.winner).toBe("SIM-X");
  });

  test("the same two chargers in a STALE projection: DEPOT_ONLY never considers the other", async () => {
    const { reach } = await reachOf([published(121, [{ row: DEPOT, plugCount: 3 }, { row: SECOND, plugCount: 1 }])]);
    expect(reach).toMatchObject({ basis: "DEPOT_ONLY", chargerId: "V1DEMO-DEPOT-01" });
    expect(reach.considered.map((row) => row.chargerId)).toEqual(["V1DEMO-DEPOT-01"]);
  });
});

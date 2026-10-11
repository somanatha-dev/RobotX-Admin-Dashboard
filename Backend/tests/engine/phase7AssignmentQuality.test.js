"use strict";

/**
 * Phase 7 — assignment quality on the REAL decision path (investigation, 2026-10-09/10).
 *
 * Every scenario runs `helpers/phase7World.decide`: the published LOCAL configuration, the
 * real V1 composition (RNSIT campus router, agent facts, simulated energy), the real index
 * maintainer, and the real `coordinatorSolvePath` deps driven through the real
 * `solve/round.plan`. MOCKED BOUNDARIES: the store (in-memory Prisma double seeded with real
 * LOCAL rows), the wall clock (pinned), and the commit (not run). No candidate and no winner is
 * injected anywhere: a robot wins only by being indexed, discovered, admitted and priced.
 *
 * Expectations are taken from the engine's documented rules, and each test names its basis:
 *   DOCUMENTED — a rule stated in the code/specification the engine implements;
 *   RECORDED   — what the live engine persisted in DecisionRecordA for a real decision;
 *   COUNTERFACTUAL — a labelled what-if on one named input; not a statement of policy.
 * None of them asserts "the nearest robot must win".
 */

const fs = require("fs");
const w = require("./helpers/phase7World");

jest.setTimeout(60_000);

const DT = w.TSK816.assignRoundMs;
const P = w.POINTS;
const CANARA = { ...P["rnsit-canara-bank"], label: "Canara Bank" };
const FOOD_COURT = { ...P["rnsit-food-court"], label: "RNSIT Food Court" };
const PUC = { ...P["rnsit-pre-university-college"], label: "RNSIT Pre-University College" };
const DELIVERY = { pickup: CANARA, drop: FOOD_COURT };

/** Two network vertices around Pre-University College whose straight-line and route orders disagree. */
const STRAIGHT_NEAR_ROUTE_FAR = { lat: 12.9011397, lon: 77.5179013 }; // 120 m straight, 386 m by route
const STRAIGHT_FAR_ROUTE_NEAR = { lat: 12.9022097, lon: 77.5191573 }; // 206 m straight, 212 m by route

const evidence = [];
const big = (k, v) => (typeof v === "bigint" ? `${v}` : v);
const json = (value) => JSON.parse(JSON.stringify(value, big));

function record(id, title, basis, expected, out, extra) {
  evidence.push(
    json({
      id,
      title,
      basis,
      expected,
      actual: { outcome: out.outcome, winner: out.winner },
      indexed: out.indexed.map((row) => row.agentId),
      candidates: out.candidates,
      priced: out.priced,
      denials: Object.fromEntries(
        Object.entries(out.denials).map(([agentId, rows]) => [agentId, rows.map((row) => ({ predicateId: row.predicateId, reason: row.reason }))]),
      ),
      straightLineToPickupM: out.straightLineToPickupM,
      approachRouteM: approachRoutes(out),
      ...(extra || {}),
    }),
  );
}

/** The approach hop (agent → pickup) the router priced, per agent position. */
function approachRoutes(out) {
  const rows = {};
  for (const call of out.routeCalls) {
    if (!call.originPoint || !call.ok || !call.hops[0]) continue;
    rows[`${call.originPoint.lat.toFixed(6)},${call.originPoint.lon.toFixed(6)}`] = Math.round(call.hops[0].distanceM);
  }
  return rows;
}

const byAgent = (out) => Object.fromEntries(out.candidates.map((row) => [row.agentId, row]));
const binding = (out, agentId) => (byAgent(out)[agentId] || {}).bindingPredicateId || null;
const gamma = (out, agentId) => {
  const row = byAgent(out)[agentId];
  return row && row.gammaMilliCU !== null ? BigInt(row.gammaMilliCU) : null;
};

afterAll(() => {
  if (process.env.P7_EVIDENCE) fs.writeFileSync(process.env.P7_EVIDENCE, `${JSON.stringify(evidence, null, 1)}\n`);
});

/* ═══════════════════════════════════════════════════════════════════════════
   B. The observed decision — TSK-1791553228180-816, replayed from decision-time inputs
   ═══════════════════════════════════════════════════════════════════════════ */

/** The four robots as the store held them at 13:44:13.786Z (Observation, Telemetry, Robot, Commitment). */
function tsk816Fleet(changes) {
  const c = changes || {};
  return [
    { robotId: "SIM-0A8C043FFE67", at: { lat: 12.901151, lon: 77.517575 }, socFraction: 0.29, status: "IDLE", positionAgeMs: 351, ...(c["SIM-0A8C043FFE67"] || {}) },
    {
      robotId: "SIM-1ABF21512BE5",
      at: { lat: 12.900817, lon: 77.518043 },
      socFraction: 0.362,
      status: "PAUSED",
      positionAgeMs: 350,
      openCommitments: [{ legId: "leg-of-TSK-1790958521622-254", leaseExpiry: new Date("2026-10-02T16:53:35.042Z") }],
      ...(c["SIM-1ABF21512BE5"] || {}),
    },
    {
      robotId: "SIM-CFE1E46B2002",
      at: { lat: 12.900411, lon: 77.518715 },
      socFraction: 0.62,
      status: "PAUSED",
      positionAgeMs: 349,
      openCommitments: [{ legId: "leg-of-TSK-1790960698218-551", leaseExpiry: new Date("2026-10-02T17:29:19.351Z") }],
      ...(c["SIM-CFE1E46B2002"] || {}),
    },
    { robotId: "SIM-9F6F88D84EBD", at: { lat: 12.90032004, lon: 77.51870238 }, socFraction: 0.95, status: "IDLE", positionAgeMs: 1360, ...(c["SIM-9F6F88D84EBD"] || {}) },
  ];
}

describe("B — TSK-816 replay (RECORDED)", () => {
  // P7-C1 Step 3 (2026-10-10) — the return-to-charger leg is now priced between exact points.
  // DecisionRecordA for TSK-816 (winner SIM-9F6F, γ 748 531, SIM-0A8C bound by F34) was taken
  // under the earlier cell-pair return pricing, which added 2 × 250 m to a 65.6 m return
  // (`p7c1ReturnEnergyLedger.test.js` keeps that ledger). The replay still reproduces every
  // recorded INPUT and SIM-9F6F's γ exactly; what changes is SIM-0A8C's feasibility, and with it
  // the winner (`p7c1ExactReturnLeg.test.js` pins the before/after values).
  test("B1: the assigning round reproduces the recorded inputs and SIM-9F6F's γ; under exact return pricing SIM-0A8C is now feasible and wins", async () => {
    const out = await w.decide({ decisionTimeMs: DT, robots: tsk816Fleet() });
    record("B1", "TSK-816 assigning round, replayed under exact return pricing (P7-C1)", "RECORDED", { winner: "SIM-0A8C043FFE67", recordedWinner: "SIM-9F6F88D84EBD", gammaMilliCU: { "SIM-9F6F88D84EBD": "748531", "SIM-0A8C043FFE67": "742773" } }, out);

    expect(out.outcome).toBe("ASSIGNED");
    // Recorded under the pre-P7-C1 pricing; reproduced unchanged where the change does not reach.
    expect(w.TSK816.recordedWinner).toBe("SIM-9F6F88D84EBD");
    expect(String(gamma(out, "SIM-9F6F88D84EBD"))).toBe(w.TSK816.recordedGammaMilliCU);
    // Changed by the corrected return leg: SIM-0A8C passes F34 and prices lower.
    expect(binding(out, "SIM-0A8C043FFE67")).toBeNull();
    expect(String(gamma(out, "SIM-0A8C043FFE67"))).toBe("742773");
    expect(out.winner).toBe("SIM-0A8C043FFE67");
    // The recorded decision considered exactly two candidates; the two PAUSED robots holding
    // Oct-2 commitments were never indexed, so the expansion could not discover them.
    expect(out.candidates.map((row) => row.agentId).sort()).toEqual(["SIM-0A8C043FFE67", "SIM-9F6F88D84EBD"]);
    expect(out.indexed.map((row) => row.agentId).sort()).toEqual(["SIM-0A8C043FFE67", "SIM-9F6F88D84EBD"]);
    // The recorded winner was the FARTHEST of the four by straight line…
    const straight = out.straightLineToPickupM;
    expect(Math.max(...Object.values(straight))).toBe(straight["SIM-9F6F88D84EBD"]);
    // …and the robot that now wins is the nearest — by straight line and by the priced route.
    expect(Math.min(...Object.values(straight))).toBe(straight["SIM-0A8C043FFE67"]);
  });

  test("B2: the earlier round (13:40:28Z, before SIM-9F6F existed) — recorded NO_FEASIBLE on F34; under exact return pricing SIM-0A8C is assigned", async () => {
    const fleet = tsk816Fleet({ "SIM-0A8C043FFE67": { socFraction: 0.3 } }).filter((r) => r.robotId !== "SIM-9F6F88D84EBD");
    const out = await w.decide({ decisionTimeMs: w.TSK816.firstRoundMs, robots: fleet });
    record("B2", "TSK-816 first round (13:40:28Z), under exact return pricing (P7-C1)", "RECORDED", { outcome: "ASSIGNED", recordedOutcome: "NO_FEASIBLE_CANDIDATE" }, out);
    // Recorded (pre-P7-C1): NO_FEASIBLE_CANDIDATE, SIM-0A8C bound by F34 — 442 such rounds.
    expect(out.outcome).toBe("ASSIGNED");
    expect(out.winner).toBe("SIM-0A8C043FFE67");
    expect(binding(out, "SIM-0A8C043FFE67")).toBeNull();
  });

  test("B3: the return-to-charger leg is priced between the drop stop and the charger — no 500 m quantisation offset (P7-C1)", async () => {
    const out = await w.decide({ decisionTimeMs: DT, robots: tsk816Fleet() });
    // Before P7-C1 the return leg was a cell-pair question, so §20.3's offset applied at both
    // ends (2 × 250 m = 500 m on a 65.6 m route) and F34 rejected SIM-0A8C on E_return. It is now
    // asked between the drop stop and each charger's own coordinates.
    const chargerCells = new Set(["8b6014510498fff", "8b6014510496fff"]);
    const returnCalls = out.routeCalls.filter((call) => call.ok && call.stops.length === 1 && chargerCells.has(call.stops[0].cellId));
    expect(returnCalls.length).toBeGreaterThan(0);
    for (const call of returnCalls) {
      expect(call.originPoint).not.toBeNull();
      expect(call.hops[0].intraCellOffsetM).toBe(0);
      expect(call.hops[0].exact).toBe(true);
    }
    const depot = returnCalls.map((call) => call.hops[0]).reduce((a, b) => (a.distanceM < b.distanceM ? a : b));
    record("B3", "The return-to-charger leg, priced between exact points", "RECORDED", { intraCellOffsetM: 0 }, out, {
      nearestChargerReturnHop: { pricedDistanceM: Math.round(depot.distanceM), intraCellOffsetM: depot.intraCellOffsetM },
    });
    expect(depot.distanceM).toBeLessThan(100);
    expect(out.denials["SIM-0A8C043FFE67"]).toBeUndefined();
  });

  test("B4 COUNTERFACTUAL: with the Oct-2 commitments released and both robots IDLE, the ranking is by route, not straight line", async () => {
    const out = await w.decide({
      decisionTimeMs: DT,
      robots: tsk816Fleet({
        "SIM-1ABF21512BE5": { status: "IDLE", openCommitments: [] },
        "SIM-CFE1E46B2002": { status: "IDLE", openCommitments: [] },
      }),
    });
    record("B4", "TSK-816 if the stale Oct-2 commitments had been released (counterfactual)", "COUNTERFACTUAL", { indexed: 4 }, out);
    expect(out.indexed).toHaveLength(4);
    expect(out.outcome).toBe("ASSIGNED");
    // Whatever wins, it is the cheapest feasible γ among the priced candidates (§8.1).
    const priced = out.candidates.filter((row) => !row.rejected).map((row) => BigInt(row.gammaMilliCU));
    expect(gamma(out, out.winner)).toBe(priced.reduce((a, b) => (a < b ? a : b)));
  });

  // P7-C1 Step 3 — measured before the change: 40.2 % with the published 250 m offset, 29.7 %
  // with a 25 m one, because the return leg carried 2 × the offset. It no longer carries any.
  test("B5 COUNTERFACTUAL (measurement): the quantisation offset no longer reaches the return leg, and SIM-0A8C needs just under 29 %", async () => {
    /** The lowest state of charge (0.5 % resolution) at which SIM-0A8C passes the gate for this Leg. */
    async function minimumFeasibleSoc(configOverrides) {
      const feasibleAt = async (soc) => {
        const out = await w.decide({
          decisionTimeMs: DT,
          robots: tsk816Fleet({ "SIM-0A8C043FFE67": { socFraction: soc } }).filter((r) => r.robotId === "SIM-0A8C043FFE67"),
          configOverrides,
        });
        return { feasible: binding(out, "SIM-0A8C043FFE67") === null && out.outcome === "ASSIGNED", out };
      };
      let lo = 0.2;
      let hi = 0.95;
      expect((await feasibleAt(hi)).feasible).toBe(true);
      while (hi - lo > 0.005) {
        const mid = Math.round(((lo + hi) / 2) * 1000) / 1000;
        if ((await feasibleAt(mid)).feasible) hi = mid; // eslint-disable-line no-await-in-loop
        else lo = mid;
      }
      return hi;
    }
    const published = await minimumFeasibleSoc(undefined);
    const cellScale = await minimumFeasibleSoc({ "route.intra_cell_offset_m": 25 });
    const at29 = await w.decide({ decisionTimeMs: DT, robots: tsk816Fleet(), configOverrides: { "route.intra_cell_offset_m": 25 } });
    record("B5", "Minimum SoC for SIM-0A8C on TSK-816: published offset (250 m) vs cell-scale (25 m), exact return pricing", "COUNTERFACTUAL", { offsetIrrelevant: true }, at29, {
      minimumFeasibleSoc: { publishedOffset250m: published, cellScaleOffset25m: cellScale },
    });
    // The return leg is exact, so the offset cannot move the threshold any more.
    expect(cellScale).toBe(published);
    // Measured: F34 VIOLATED on T1 at 28 % (p 0.0215), SATISFIED at 29 % (p 0.0047).
    expect(published).toBeGreaterThan(0.28);
    expect(published).toBeLessThanOrEqual(0.29);
    expect(binding(at29, "SIM-0A8C043FFE67")).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   C. The matrix
   ═══════════════════════════════════════════════════════════════════════════ */

describe("C — assignment-quality matrix", () => {
  test("C1 DOCUMENTED: two identical eligible robots — the one with the shorter priced route wins", async () => {
    const out = await w.decide({
      decisionTimeMs: DT,
      robots: [w.sim("SIM-NEAR", P["rnsit-cyber-security-department"]), w.sim("SIM-FAR", P["rnsit-innovation-center"])],
      leg: DELIVERY,
    });
    record("C1", "Two identical robots, one clearly nearer", "DOCUMENTED (§8.1 min γ; approach time and distance enter C_direct)", { winner: "SIM-NEAR" }, out);
    expect(out.outcome).toBe("ASSIGNED");
    expect(out.winner).toBe("SIM-NEAR");
    expect(gamma(out, "SIM-NEAR") < gamma(out, "SIM-FAR")).toBe(true);
  });

  test("C2 DOCUMENTED: the nearer robot loses on energy (F34) and the farther one is assigned", async () => {
    const out = await w.decide({
      decisionTimeMs: DT,
      robots: [w.sim("SIM-NEAR", P["rnsit-cyber-security-department"], { socFraction: 0.25 }), w.sim("SIM-FAR", P["rnsit-innovation-center"])],
      leg: DELIVERY,
    });
    record("C2", "Nearer robot with insufficient battery", "DOCUMENTED (§7.5 F34, §14.5)", { winner: "SIM-FAR", rejected: { "SIM-NEAR": "F34" } }, out);
    expect(binding(out, "SIM-NEAR")).toBe("F34");
    expect(out.winner).toBe("SIM-FAR");
  });

  test("C3 DOCUMENTED: the nearer robot lacks a required capability (F21)", async () => {
    const out = await w.decide({
      decisionTimeMs: DT,
      robots: [
        w.sim("SIM-NEAR", P["rnsit-cyber-security-department"]),
        w.sim("SIM-FAR", P["rnsit-innovation-center"], { capabilities: { max_payload_mass: 20 } }),
      ],
      leg: { ...DELIVERY, requirements: [{ name: "max_payload_mass", comparator: "AT_LEAST", value: 15 }] },
    });
    record("C3", "Nearer robot lacks capability (payload 10 kg < 15 kg required)", "DOCUMENTED (§7.5 F21)", { winner: "SIM-FAR", rejected: { "SIM-NEAR": "F21" } }, out);
    expect(binding(out, "SIM-NEAR")).toBe("F21");
    expect(out.winner).toBe("SIM-FAR");
  });

  describe("C4 DOCUMENTED: the nearer robot is busy, committed, unavailable, stale or unhealthy", () => {
    const cases = [
      ["busy (live commitment on another Leg)", { openCommitments: [{ legId: "some-other-leg" }] }, "NOT_INDEXED"],
      ["PAUSED (operator stop or charging dock)", { status: "PAUSED" }, "F3"],
      ["ERROR", { status: "ERROR" }, "F8"],
      ["offline (isOnline=false)", { isOnline: false }, "F13"],
      // First authored as F13; the gate stops at its first denial (`evaluateCandidate` without
      // collectAll) and F7 — the e-stop reading's 10 s staleness budget — precedes F13.
      ["stale (last heartbeat and position 120 s old)", { lastSeenAgeMs: 120_000, positionAgeMs: 120_000 }, "F7"],
    ];
    test.each(cases)("%s → excluded; the farther robot is assigned", async (label, change, expected) => {
      const out = await w.decide({
        decisionTimeMs: DT,
        robots: [w.sim("SIM-NEAR", P["rnsit-cyber-security-department"], change), w.sim("SIM-FAR", P["rnsit-innovation-center"])],
        leg: DELIVERY,
      });
      record(`C4:${label}`, `Nearer robot ${label}`, "DOCUMENTED (§6.3 index partitions; §7.5 F3/F8/F13)", { winner: "SIM-FAR", nearer: expected }, out);
      expect(out.winner).toBe("SIM-FAR");
      if (expected === "NOT_INDEXED") {
        expect(out.indexed.map((row) => row.agentId)).not.toContain("SIM-NEAR");
        expect(byAgent(out)["SIM-NEAR"]).toBeUndefined();
      } else {
        expect(out.denials["SIM-NEAR"].map((row) => row.predicateId)).toContain(expected);
      }
    });
  });

  test("C5 DOCUMENTED: identical robots at the same point — equal γ, the §9.6 tie-break (agent id) decides, independent of insertion order", async () => {
    const at = P["rnsit-cyber-security-department"];
    const forward = await w.decide({ decisionTimeMs: DT, robots: [w.sim("SIM-TIE-A", at), w.sim("SIM-TIE-B", at)], leg: DELIVERY });
    const reverse = await w.decide({ decisionTimeMs: DT, robots: [w.sim("SIM-TIE-B", at), w.sim("SIM-TIE-A", at)], leg: DELIVERY });
    record("C5", "Exact tie", "DOCUMENTED (§9.6 req. 3: duty cycle, health tier, then agent id)", { winner: "SIM-TIE-A" }, forward, { reverseOrderWinner: reverse.winner });
    expect(gamma(forward, "SIM-TIE-A")).toBe(gamma(forward, "SIM-TIE-B"));
    expect(forward.winner).toBe("SIM-TIE-A");
    expect(reverse.winner).toBe("SIM-TIE-A");
  });

  describe("C6 DOCUMENTED: missing, stale or contradictory telemetry", () => {
    test("no position Observation → never indexed, never a candidate", async () => {
      const out = await w.decide({
        decisionTimeMs: DT,
        robots: [w.sim("SIM-NEAR", P["rnsit-cyber-security-department"], { positionAgeMs: null }), w.sim("SIM-FAR", P["rnsit-innovation-center"])],
        leg: DELIVERY,
      });
      record("C6a", "Nearer robot has no position Observation", "DOCUMENTED (Step 5: a frame without timestamp writes no Observation; indexMaintainer.assembleRecord)", { winner: "SIM-FAR", nearer: "NOT_INDEXED" }, out);
      expect(out.indexed.map((row) => row.agentId)).toEqual(["SIM-FAR"]);
      expect(out.winner).toBe("SIM-FAR");
    });

    test("no BatteryState → excluded before pricing (LB unresolved): reported only as truncatedBy, the agent id is not in the top-N", async () => {
      const out = await w.decide({
        decisionTimeMs: DT,
        robots: [w.sim("SIM-NEAR", P["rnsit-cyber-security-department"], { noBattery: true }), w.sim("SIM-FAR", P["rnsit-innovation-center"])],
        leg: DELIVERY,
      });
      record("C6b", "Nearer robot has no BatteryState", "DOCUMENTED (expansion §6.1/§6.4: an unresolved LB is excluded and reported)", { winner: "SIM-FAR", truncatedBy: "lower_bound_unresolved" }, out, {
        truncatedBy: out.decision && out.decision.truncatedBy,
      });
      expect(out.winner).toBe("SIM-FAR");
      // Never an assumed charge: the robot is not priced at all…
      expect(out.indexed.map((row) => row.agentId)).toContain("SIM-NEAR");
      expect(byAgent(out)["SIM-NEAR"]).toBeUndefined();
      // …and the only trace on the Tier A path is the truncation flag, not the agent's id.
      expect(out.decision.truncatedBy).toBe("lower_bound_unresolved");
    });

    test("contradictory: the live registry says IDLE, the persisted status says PAUSED → the engine reads PAUSED (F3)", async () => {
      const out = await w.decide({
        decisionTimeMs: DT,
        robots: [
          w.sim("SIM-NEAR", P["rnsit-cyber-security-department"], { status: "PAUSED", liveState: { status: "IDLE", battery: 90, lastHeartbeat: DT - 500 } }),
          w.sim("SIM-FAR", P["rnsit-innovation-center"]),
        ],
        leg: DELIVERY,
      });
      record("C6c", "Live KV status IDLE vs persisted PAUSED (the pre-Phase-6 dashboard showed the KV value)", "DOCUMENTED (agentFacts: F3 from Robot.status)", { winner: "SIM-FAR", nearer: "F3" }, out);
      expect(out.denials["SIM-NEAR"].map((row) => row.predicateId)).toContain("F3");
      expect(out.winner).toBe("SIM-FAR");
    });
  });

  test("C7 DOCUMENTED: straight-line nearer but route-farther loses to the route-nearer robot", async () => {
    const out = await w.decide({
      decisionTimeMs: DT,
      robots: [w.sim("SIM-STRAIGHT-NEAR", STRAIGHT_NEAR_ROUTE_FAR), w.sim("SIM-ROUTE-NEAR", STRAIGHT_FAR_ROUTE_NEAR)],
      leg: { pickup: PUC, drop: FOOD_COURT },
    });
    record("C7", "Straight-line vs route distance disagree", "DOCUMENTED (V1 priced route = campus network route, 2026-10-03)", { winner: "SIM-ROUTE-NEAR" }, out);
    expect(out.straightLineToPickupM["SIM-STRAIGHT-NEAR"] < out.straightLineToPickupM["SIM-ROUTE-NEAR"]).toBe(true);
    expect(out.winner).toBe("SIM-ROUTE-NEAR");
  });

  describe("C8 DOCUMENTED: a candidate rejected by each important gate", () => {
    const released = (agentRowId) => ({
      id: "released-row",
      commitmentId: "commitment-released",
      agentId: agentRowId,
      kind: "HARD",
      fence: 1n,
      leaseExpiry: new Date(DT - 60_000),
      custodyState: "NONE",
      version: 2,
      grantedAt: new Date(DT - 300_000),
      releasedAt: new Date(DT - 30_000),
      capacitySlot: 0,
    });
    const cases = [
      ["F3 operator hold / charging dock", { robot: { status: "PAUSED" } }, "F3"],
      ["F8 blocking fault", { robot: { status: "ERROR" } }, "F8"],
      ["F9 marginal health tier (ISSUES)", { robot: { status: "ISSUES" } }, "F9"],
      ["F13 session not live", { robot: { isOnline: false } }, "F13"],
      ["F20 NACK cooloff on this Leg", { priorOnLeg: true }, "F20"],
      ["F21 capability", { leg: { requirements: [{ name: "custody_transfer_capable", comparator: "EQUALS", value: true }] } }, "F21"],
      ["F34 energy", { robot: { socFraction: 0.2 } }, "F34"],
      ["F19 leg deadline already passed", { leg: { queueAgeMs: 2 * 3600_000 } }, "F19"],
    ];
    test.each(cases)("%s", async (label, change, expected) => {
      const robot = w.sim("SIM-GATED", P["rnsit-cyber-security-department"], change.robot || {});
      const out = await w.decide({
        decisionTimeMs: DT,
        robots: [robot],
        leg: { ...DELIVERY, ...(change.leg || {}) },
        priorCommitmentsOnLeg: change.priorOnLeg ? [released("agent-row-SIM-GATED")] : [],
      });
      record(`C8:${label}`, `Single robot, ${label}`, "DOCUMENTED (§7.5)", { outcome: "NO_FEASIBLE_CANDIDATE", denial: expected }, out);
      expect(out.outcome).toBe("NO_FEASIBLE_CANDIDATE");
      expect(out.denials["SIM-GATED"].map((row) => row.predicateId)).toContain(expected);
    });
  });

  test("C9 DOCUMENTED: every candidate infeasible → NO_FEASIBLE_CANDIDATE, no assignment", async () => {
    const out = await w.decide({
      decisionTimeMs: DT,
      robots: [
        w.sim("SIM-A", P["rnsit-cyber-security-department"], { socFraction: 0.15 }),
        w.sim("SIM-B", P["rnsit-innovation-center"], { status: "PAUSED" }),
        w.sim("SIM-C", P["rns-first-grade-college"], { isOnline: false }),
      ],
      leg: DELIVERY,
    });
    record("C9", "All candidates infeasible", "DOCUMENTED (round.plan NO_FEASIBLE_CANDIDATE)", { outcome: "NO_FEASIBLE_CANDIDATE" }, out);
    expect(out.outcome).toBe("NO_FEASIBLE_CANDIDATE");
    expect(out.winner).toBeNull();
    expect(out.candidates.every((row) => row.rejected)).toBe(true);
  });

  test("C10 DOCUMENTED: identical inputs and configuration produce the identical decision", async () => {
    const scenario = () => ({
      decisionTimeMs: DT,
      robots: [w.sim("SIM-NEAR", P["rnsit-cyber-security-department"]), w.sim("SIM-FAR", P["rnsit-innovation-center"])],
      leg: DELIVERY,
    });
    const runs = [];
    for (let i = 0; i < 3; i += 1) runs.push(await w.decide(scenario())); // eslint-disable-line no-await-in-loop
    const replayA = await w.decide({ decisionTimeMs: DT, robots: tsk816Fleet() });
    const replayB = await w.decide({ decisionTimeMs: DT, robots: tsk816Fleet() });
    record("C10", "Repeatability", "DOCUMENTED (§9.6 determinism)", { identical: true }, runs[0], {
      gammas: runs.map((run) => run.candidates.map((row) => `${row.agentId}:${row.gammaMilliCU}`)),
      replayGammas: [replayA, replayB].map((run) => run.candidates.map((row) => `${row.agentId}:${row.gammaMilliCU ?? row.bindingPredicateId}`)),
    });
    for (const run of runs.slice(1)) {
      expect(run.winner).toBe(runs[0].winner);
      expect(json(run.candidates)).toEqual(json(runs[0].candidates));
    }
    expect(json(replayB.candidates)).toEqual(json(replayA.candidates));
  });
});

"use strict";

/**
 * The V1 run gate (`tools/demo/v1RunReport.js`) — each invariant is planted and must fail,
 * so a green run report means the run held it, not that the check could not fire.
 */

const report = require("../../tools/demo/v1RunReport");

const verdict = (agentId, legId, feasible = true) => ({ agentId, legId, feasible, denials: feasible ? [] : [{ id: "F34" }] });

function cleanRun() {
  return {
    tasks: [
      { taskId: "T1", status: "COMPLETED", robotId: "R1", legId: "L1" },
      { taskId: "T2", status: "PENDING", robotId: null, legId: "L2" },
      { taskId: "T3", status: "ASSIGNED", robotId: "R2", legId: "L3" },
    ],
    legs: [
      { legId: "L1", state: "SETTLED" },
      { legId: "L2", state: "QUEUED" },
      { legId: "L3", state: "EN_ROUTE_DROP" },
    ],
    commitments: [
      { commitmentId: "c1", agentId: "R1", legId: "L1", releasedAt: new Date() },
      { commitmentId: "c3", agentId: "R2", legId: "L3", releasedAt: null },
    ],
    queueRows: [{ legId: "L2", state: "QUEUED" }],
    verifications: [{ legId: "L1", outcome: "SUFFICIENT" }],
    gateVerdicts: [verdict("R1", "L1"), verdict("R2", "L3"), verdict("R3", "L2", false)],
    capacity: 1,
  };
}

const ids = (result) => result.violations.map((row) => row.id).sort();

describe("v1RunReport.checkInvariants", () => {
  test("a clean run holds every invariant and classifies each task", () => {
    const result = report.checkInvariants(cleanRun());
    expect(result.violations).toEqual([]);
    expect(result.outcomes).toEqual({ T1: "COMPLETED", T2: "WAITING", T3: "IN_FLIGHT" });
  });

  test("I1 — two live commitments on one Leg", () => {
    const run = cleanRun();
    run.commitments.push({ commitmentId: "c4", agentId: "R3", legId: "L3", releasedAt: null });
    run.gateVerdicts.push(verdict("R3", "L3"));
    expect(ids(report.checkInvariants(run))).toContain("I1");
  });

  test("I2 — an agent over capacity", () => {
    const run = cleanRun();
    run.tasks.push({ taskId: "T4", status: "ASSIGNED", robotId: "R2", legId: "L4" });
    run.legs.push({ legId: "L4", state: "ACCEPTED" });
    run.commitments.push({ commitmentId: "c5", agentId: "R2", legId: "L4", releasedAt: null });
    run.gateVerdicts.push(verdict("R2", "L4"));
    expect(ids(report.checkInvariants(run))).toEqual(["I2"]);
  });

  test("I3 — a commitment the gate never passed is an impossible assignment", () => {
    const run = cleanRun();
    run.gateVerdicts = run.gateVerdicts.filter((row) => row.agentId !== "R2");
    run.gateVerdicts.push(verdict("R2", "L3", false));
    expect(ids(report.checkInvariants(run))).toEqual(["I3"]);
  });

  test("I4 — a task with no Leg state that explains it is lost", () => {
    const run = cleanRun();
    run.queueRows = []; // L2 QUEUED but no queue row: nobody will ever pick it up
    const result = report.checkInvariants(run);
    expect(ids(result)).toEqual(["I4"]);
    expect(result.outcomes.T2).toBe("LOST");
  });

  test("a terminally failed Leg is FAILED, not lost", () => {
    const run = cleanRun();
    run.legs[1] = { legId: "L2", state: "CANCELLED" };
    run.queueRows = [];
    const result = report.checkInvariants(run);
    expect(result.violations).toEqual([]);
    expect(result.outcomes.T2).toBe("FAILED");
  });

  test("I5 — COMPLETED without a SETTLED Leg, or without a SUFFICIENT verification", () => {
    const run = cleanRun();
    run.legs[0] = { legId: "L1", state: "RELEASED" };
    run.verifications = [];
    const result = report.checkInvariants(run);
    expect(result.violations.filter((row) => row.id === "I5")).toHaveLength(2);
  });

  test("I6 — a live commitment left on a settled Leg is an orphan", () => {
    const run = cleanRun();
    run.commitments[0] = { ...run.commitments[0], releasedAt: null };
    expect(ids(report.checkInvariants(run))).toContain("I6");
  });

  test("I7 — a Leg settled by a robot other than the one the Task names", () => {
    const run = cleanRun();
    run.tasks[0] = { ...run.tasks[0], robotId: "R9" };
    expect(ids(report.checkInvariants(run))).toEqual(["I7"]);
  });
});

describe("v1RunReport.summarise", () => {
  test("rejections are counted once per agent × Leg, by predicate and by pre-gate refusal", () => {
    const summary = report.summarise({
      gateVerdicts: [verdict("R3", "L2", false), verdict("R3", "L2", false), verdict("R1", "L1")],
      expansionRefusals: [
        { agentId: "R9", legId: "L2", refusal: "MISSING_HOP" },
        { agentId: "R9", legId: "L2", refusal: "MISSING_HOP" },
      ],
      events: { OFFER: 3, OFFER_ACCEPT: 2, OFFER_REJECT: 1 },
      commitments: [{ agentId: "R1" }, { agentId: "R1" }, { agentId: "R2" }],
      outcomes: { T1: "COMPLETED", T2: "WAITING" },
    });
    expect(summary).toMatchObject({
      candidatePairs: 2,
      feasiblePairs: 1,
      rejectedPairs: 1,
      rejectedByPredicate: { F34: 1 },
      refusedBeforeGate: { MISSING_HOP: 1 },
      offersDelivered: 3,
      accepts: 2,
      rejects: 1,
      agentsUsed: 2,
      completed: 1,
      waiting: 1,
    });
  });
});

describe("v1RunReport — a queue row nobody will pick up is not 'waiting'", () => {
  test("a QUEUED Leg whose queue row is SOLVED is lost", () => {
    const run = cleanRun();
    run.queueRows = [{ legId: "L2", state: "SOLVED" }];
    const result = report.checkInvariants(run);
    expect(result.outcomes.T2).toBe("LOST");
    expect(ids(result)).toEqual(["I4"]);
  });

  test("a Leg in a §4.7 recovery state is RECOVERING, not lost", () => {
    const run = cleanRun();
    run.legs[1] = { legId: "L2", state: "REASSIGNING" };
    run.queueRows = [];
    const result = report.checkInvariants(run);
    expect(result.outcomes.T2).toBe("RECOVERING");
    expect(result.violations).toEqual([]);
  });
});

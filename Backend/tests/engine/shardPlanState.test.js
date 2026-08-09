"use strict";

/**
 * §2.6 / invariant I18 — SOFT reservations are round-local coordinator state, and there
 * is no third case.
 */

const planState = require("../../src/engine/shard/planState");
const fixture = require("./helpers/roundFixture");
const { toMilliCU } = require("../../src/engine/determinism/fixedPoint");

describe("§2.6 — a SOFT reservation has no durable home, and the refusal is structural", () => {
  test("JSON.stringify of a reservation THROWS rather than silently persisting it", () => {
    const reservation = planState.makeReservation({ legId: "L1", agentId: "A1" });
    expect(() => JSON.stringify(reservation)).toThrow(planState.SoftReservationPersistenceError);
    expect(() => JSON.stringify(reservation)).toThrow(/There is no third case/);
  });

  test("a reservation nested inside a log line or a Json column also throws", () => {
    const state = planState.create({ shardId: "s1" });
    state.declareAgent({ agentId: "A1", capacity: 1, hardCommitmentCount: 0 });
    state.reserve({ legId: "L1", agentId: "A1" });

    expect(() => JSON.stringify({ context: { reservation: state.reservationFor("L1") } })).toThrow(
      planState.SoftReservationPersistenceError,
    );
  });

  test("snapshotForRecord is the sanctioned seam — counts and identities, never reservations", () => {
    const state = planState.create({ shardId: "s1" });
    state.beginRound("r1");
    state.declareAgent({ agentId: "A1", capacity: 2, hardCommitmentCount: 0 });
    state.reserve({ legId: "L2", agentId: "A1" });
    state.reserve({ legId: "L1", agentId: "A1" });

    const snapshot = state.snapshotForRecord();
    expect(() => JSON.stringify(snapshot)).not.toThrow();
    expect(snapshot).toMatchObject({
      shardId: "s1",
      roundId: "r1",
      softReservationCount: 2,
      legsReserved: ["L1", "L2"],
      agentsWithReservations: ["A1"],
    });
    expect(snapshot.durability).toMatch(/round-local coordinator memory/);
  });

  test("the durable consequence of planning is the Leg's STATE, never its binding", () => {
    const state = planState.create({ shardId: "s1" });
    state.declareAgent({ agentId: "A1", capacity: 1, hardCommitmentCount: 0 });
    const reserved = state.reserve({ legId: "L1", agentId: "A1" });

    expect(reserved.durableEffect).toMatchObject({
      entity: "Leg",
      legId: "L1",
      targetState: "PLANNED",
      registersTimer: "commit.hardening_deadline",
    });
    // The provisional agent is deliberately absent from the durable effect.
    expect(Object.keys(reserved.durableEffect)).not.toContain("agentId");
  });

  test("assertNeverPersisted checks the store and names what it checked", async () => {
    const prisma = fixture.memoryPrisma();
    const verdict = await planState.assertNeverPersisted({ prisma });

    expect(verdict.ok).toBe(true);
    expect(verdict.checked).toHaveLength(2);
    expect(verdict.checked[0]).toMatch(/Commitment.kind/);
  });

  test("assertNeverPersisted FAILS when a non-HARD commitment exists (I18's schema backstop bypassed)", async () => {
    const prisma = { ...fixture.memoryPrisma(), commitment: { async count() { return 3; } } };
    const verdict = await planState.assertNeverPersisted(prisma.workQueue ? { prisma } : { prisma });

    expect(verdict.ok).toBe(false);
    expect(verdict.findings[0]).toMatch(/SOFT reservation in the Commitment Store/);
  });
});

describe("§2.6 — round-loop capacity accounting", () => {
  test("HARD commitments and this round's SOFT reservations both consume capacity", () => {
    const state = planState.create({ shardId: "s1" });
    state.declareAgent({ agentId: "A1", capacity: 2, hardCommitmentCount: 1 });

    expect(state.remainingCapacity("A1")).toBe(1);
    expect(state.reserve({ legId: "L1", agentId: "A1" }).ok).toBe(true);
    expect(state.remainingCapacity("A1")).toBe(0);

    const refused = state.reserve({ legId: "L2", agentId: "A1" });
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toBe(planState.REFUSAL.NO_CAPACITY);
  });

  test("two Legs in ONE round cannot both plan onto an agent with one free slot", () => {
    const state = planState.create({ shardId: "s1" });
    state.declareAgent({ agentId: "A1", capacity: 1, hardCommitmentCount: 0 });

    expect(state.reserve({ legId: "L1", agentId: "A1" }).ok).toBe(true);
    expect(state.reserve({ legId: "L2", agentId: "A1" }).ok).toBe(false);
  });

  test("an undeclared agent has no capacity — the round's pinned snapshot is the only source", () => {
    const state = planState.create({ shardId: "s1" });
    const refused = state.reserve({ legId: "L1", agentId: "ghost" });

    expect(refused.refusal).toBe(planState.REFUSAL.UNKNOWN_AGENT);
    expect(state.remainingCapacity("ghost")).toBe(0);
  });

  test("a released reservation returns its slot, and the revision is counted", () => {
    const state = planState.create({ shardId: "s1" });
    state.declareAgent({ agentId: "A1", capacity: 1, hardCommitmentCount: 0 });
    state.reserve({ legId: "L1", agentId: "A1", gammaMilliCU: toMilliCU(10) });

    expect(state.release("L1").released.agentId).toBe("A1");
    expect(state.remainingCapacity("A1")).toBe(1);
    expect(state.snapshotForRecord().revisions).toBe(1);
  });

  test("one Leg cannot hold two reservations", () => {
    const state = planState.create({ shardId: "s1" });
    state.declareAgent({ agentId: "A1", capacity: 1, hardCommitmentCount: 0 });
    state.declareAgent({ agentId: "A2", capacity: 1, hardCommitmentCount: 0 });
    state.reserve({ legId: "L1", agentId: "A1" });

    expect(state.reserve({ legId: "L1", agentId: "A2" }).refusal).toBe(planState.REFUSAL.ALREADY_RESERVED);
  });
});

describe("§2.6 / §19.5 — reservations are round-local, and reconstructed never recovered", () => {
  test("beginRound clears every reservation — none survives into a round that did not take it", () => {
    const state = planState.create({ shardId: "s1" });
    state.beginRound("r1");
    state.declareAgent({ agentId: "A1", capacity: 1, hardCommitmentCount: 0 });
    state.reserve({ legId: "L1", agentId: "A1" });
    expect(state.size).toBe(1);

    const cleared = state.beginRound("r2");
    expect(cleared).toEqual({ carried: 0, cleared: 1 });
    expect(state.size).toBe(0);
    expect(state.roundId).toBe("r2");
  });

  test("a Leg PLANNED with no live commitment returns to QUEUED", () => {
    const plan = planState.reconstructionPlan({
      plannedLegs: [
        { legId: "L2", state: "PLANNED", hasLiveCommitment: false },
        { legId: "L1", state: "PLANNED", hasLiveCommitment: false },
      ],
    });

    expect(plan.requeue).toEqual(["L1", "L2"]);
    expect(plan.leftAlone).toEqual([]);
    expect(plan.note).toMatch(/reconstructed, never recovered/);
  });

  test("a Leg PLANNED WITH a live commitment is left alone — guard G1 settles the late commit", () => {
    const plan = planState.reconstructionPlan({
      plannedLegs: [
        { legId: "L1", state: "PLANNED", hasLiveCommitment: true },
        { legId: "L2", state: "PLANNED", hasLiveCommitment: false },
      ],
    });

    expect(plan.requeue).toEqual(["L2"]);
    expect(plan.leftAlone[0]).toMatchObject({ legId: "L1" });
    expect(plan.leftAlone[0].because).toMatch(/re-planning here would double-commit it/);
  });

  test("nothing is read from any store — the reconstruction is a pure function of durable Leg rows", () => {
    // The argument is the whole point: there is no serialisation format to recover from,
    // so the failover path cannot depend on one existing.
    const plan = planState.reconstructionPlan({ plannedLegs: [] });
    expect(plan).toEqual({ requeue: [], leftAlone: [], note: expect.stringMatching(/no fence is needed/) });
  });
});

describe("the plan state is per shard, not per process", () => {
  test("two shards do not share a capacity ledger", () => {
    const a = planState.create({ shardId: "s1" });
    const b = planState.create({ shardId: "s2" });
    a.declareAgent({ agentId: "A1", capacity: 1, hardCommitmentCount: 0 });
    b.declareAgent({ agentId: "A1", capacity: 1, hardCommitmentCount: 0 });

    expect(a.reserve({ legId: "L1", agentId: "A1" }).ok).toBe(true);
    expect(b.reserve({ legId: "L2", agentId: "A1" }).ok).toBe(true);
    expect(a.size).toBe(1);
    expect(b.size).toBe(1);
  });
});

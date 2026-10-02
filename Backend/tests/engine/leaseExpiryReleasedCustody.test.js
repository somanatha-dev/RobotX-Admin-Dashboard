"use strict";

/**
 * F-1 (V1 final E2E, 2026-10-02) — a delivered Leg must never be dispatched again because its
 * lease lapsed while its verification was insufficient.
 *
 * Measured live on `server.js`: the robot delivered and its custody RELEASED was applied; a
 * ~60 s database outage dropped telemetry, so L1 verification came back INSUFFICIENT
 * (`TRACK_CONTINUITY`) and nothing settled; the robot, finished, stopped renewing; the
 * reconciler's expired-lease repair ran `LEASE_EXPIRY_RECOVERY`, and `assessRecovery` sent
 * custody RELEASED down the custody-NONE path (`holdsGoods` is false for it) — reassign,
 * requeue, re-offer — and a second robot carried out a delivery that had already happened.
 *
 * The invariant pinned here:
 *
 *   goods RELEASED + verification INSUFFICIENT + lease expired ⇒ no second delivery.
 *
 * The Leg stays in RELEASED, awaiting verification under §4.4's evidence-insufficient row and
 * its own `VERIFICATION_ESCALATION` deadline; the commitment stays live until settlement
 * releases it. And the custody-NONE case still reassigns.
 */

const custody = require("../../src/engine/domain/custody");
const expiryActions = require("../../src/engine/supervision/expiryActions");
const leases = require("../../src/engine/supervision/leases");
const verification = require("../../src/engine/supervision/verification");
const settlement = require("../../src/engine/lifecycle/settlement");
const transitions = require("../../src/engine/lifecycle/transitions");
const legMachine = require("../../src/engine/lifecycle/legMachine");

const fixtures = require("./helpers/dispatchFixture");
const lifecycleModel = require("./helpers/lifecycleModel");

const S = legMachine.LEG_STATE;

/** The config the production composer builds (`leaderWorkers.expiryHandlerConfig`). */
const CONFIG = Object.freeze({
  deadlineSecondsFor: (entityType, state) => {
    const spec = legMachine.deadlineFor(state);
    if (!spec || spec.projected === true) return undefined;
    return 300;
  },
  maxReassignmentsPerLeg: 3,
  incumbentCooloffSeconds: 300,
  reassignBudgetSeconds: 600,
  maxDeliveryDelaySeconds: 30,
  nackCooloffSeconds: 60,
  etaTolerance: 1.3,
  signingKey: fixtures.TEST_SIGNING_KEY,
  regionId: "region-1",
});

/**
 * A store holding one Leg with one live HARD commitment (fence 42) whose lease has expired.
 *
 * @returns {Promise<{ store: object, fixture: object }>}
 */
async function assignedAndExpired() {
  const fixture = fixtures.seed();
  const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture, { fence: 42n })] });
  await store.client.agent.update({ where: { id: fixtures.AGENT_ROW_ID }, data: { fenceCounter: 42n } });
  await store.client.commitment.update({
    where: { commitmentId: "commitment-c1" },
    data: { leaseExpiry: new Date(fixture.now.getTime() - 60_000) },
  });
  return { store, fixture };
}

async function setLeg(store, data) {
  await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data });
  return store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
}

/**
 * Run the registered `LEASE_EXPIRY_RECOVERY` handler for the commitment — the same handler the
 * reconciler's `recover` (P1.4) runs — inside a transaction on the store model.
 */
async function expireLease(store) {
  const commitment = await store.client.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });
  const events = [];
  const result = await store.client.$transaction((tx) =>
    expiryActions.handlers({}).LEASE_EXPIRY_RECOVERY({
      tx,
      prisma: store.client,
      entity: commitment,
      storeTime: store.now(),
      config: CONFIG,
      record: (event, detail) => events.push({ event, detail }),
      timer: {
        entityType: "COMMITMENT",
        entityId: commitment.commitmentId,
        state: String(commitment.fence),
        attempts: 0,
        dueAt: commitment.leaseExpiry,
        createdAt: commitment.leaseExpiry,
        shardId: null,
      },
    }),
  );
  return { result, events };
}

/** Everything a second dispatch would have to write. */
async function snapshot(store) {
  return {
    leg: await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } }),
    commitments: JSON.parse(JSON.stringify(store.rows("commitment"), (k, v) => (typeof v === "bigint" ? String(v) : v))),
    outbox: store.rows("outbox").length,
    agentFence: store.rows("agent")[0].fenceCounter,
  };
}

/** A dense L1 track (a fix every 10 s for 10 min) with one unexplained 90 s gap. */
function trackWithGap(start) {
  const fixes = [];
  for (let second = 0; second <= 600; second += 10) {
    if (second > 300 && second < 390) continue; // the telemetry outage
    fixes.push({ at: new Date(start.getTime() + second * 1000), lat: 12.9, lon: 77.6 + (second / 600) * 0.002 });
  }
  return fixes;
}

function completionClaim(track) {
  return {
    requiredLevel: "L1",
    completionClaimed: true,
    claimedPosition: { lat: 12.9, lon: 77.602 },
    stopPosition: { lat: 12.9, lon: 77.602 },
    arrivalRadiusM: 50,
    track: {
      track,
      legDurationSeconds: 600,
      minFixRatePerMinute: 2,
      corridor: [
        { lat: 12.9, lon: 77.6 },
        { lat: 12.9, lon: 77.602 },
      ],
      corridorHalfWidthM: 30,
      minCorridorFraction: 0.85,
      maxGapSeconds: 60,
      maxSpeedMs: 10,
    },
  };
}

describe("F-1 — assessRecovery: custody RELEASED is held for verification, never reassigned", () => {
  test("RELEASED → AWAIT_VERIFICATION, the Leg stays where it is", () => {
    const assessment = leases.assessRecovery({ leg: { state: S.RELEASED, custodyState: "RELEASED" } });
    expect(assessment).toEqual({
      outcome: leases.RECOVERY_OUTCOME.AWAIT_VERIFICATION,
      legState: S.RELEASED,
      reason: "CUSTODY_RELEASED_AWAITING_VERIFICATION",
      obstructionClass: null,
      externalEscalation: false,
    });
  });

  test("no evidence about the incumbent changes it — an unreachable agent still does not reassign", () => {
    for (const agentReachable of [true, false, undefined]) {
      const assessment = leases.assessRecovery({
        leg: { state: S.RELEASED, custodyState: "RELEASED" },
        agentReachable,
        obstructionClass: "BLOCKING_CRITICAL",
      });
      expect({ agentReachable, outcome: assessment.outcome, legState: assessment.legState }).toEqual({
        agentReachable,
        outcome: leases.RECOVERY_OUTCOME.AWAIT_VERIFICATION,
        legState: S.RELEASED,
      });
    }
  });

  test("§4.4's lease-expiry row reports the same target — the Leg does not move", () => {
    expect(transitions.leaseExpiryTarget({ custodyState: "RELEASED", leg: { state: S.RELEASED } })).toBe(S.RELEASED);
    expect(transitions.leaseExpiryTarget({ custodyState: "RELEASED" })).toBe(S.RELEASED);
  });

  test("the custody states that hold no goods and were never delivered still reassign", () => {
    // RELEASED is the only exception: NONE and PENDING_TRANSFER carry nothing and delivered
    // nothing, so a lapse there is still §4.7's scheduling problem.
    for (const custodyState of ["NONE", "PENDING_TRANSFER"]) {
      expect(custody.holdsGoods(custodyState)).toBe(false);
      expect(leases.assessRecovery({ leg: { state: S.ACCEPTED, custodyState } })).toMatchObject({
        outcome: leases.RECOVERY_OUTCOME.REASSIGN,
        legState: S.REASSIGNING,
        reason: "CUSTODY_NONE",
      });
    }
  });
});

describe("F-1 — the measured sequence: delivered, verification INSUFFICIENT, lease expired ⇒ no second delivery", () => {
  test("lease expiry on a released, unverified Leg creates no commitment, writes nothing and keeps the Leg RELEASED", async () => {
    const { store, fixture } = await assignedAndExpired();

    // 1–3. Assigned (one live HARD commitment at fence 42), custody obtained, goods released.
    await setLeg(store, { state: S.LOADED, custodyState: "HELD" });
    await setLeg(store, { state: S.AT_DROP, custodyState: "HELD" });
    const released = await setLeg(store, { state: S.RELEASED, custodyState: "RELEASED" });

    // 4. Verification INSUFFICIENT because the track has an unexplained gap — and so
    //    settlement refuses, which is why the commitment is still live when the lease lapses.
    const verdict = verification.verify(completionClaim(trackWithGap(fixture.now)));
    expect(verdict.outcome).toBe(verification.OUTCOME.INSUFFICIENT);
    expect(verdict.failures).toEqual([verification.FAILURE.TRACK_CONTINUITY]);
    const commitment = await store.client.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });
    const refused = await store.client.$transaction((tx) =>
      settlement.settle(tx, { leg: released, commitment, verification: verdict, manifests: [], storeTime: store.now() }),
    );
    expect(refused.reason).toBe("VERIFICATION_NOT_SUFFICIENT");

    // 5–6. The lease expires and recovery runs.
    const before = await snapshot(store);
    const { result, events } = await expireLease(store);
    const after = await snapshot(store);

    expect(result).toEqual({ disposition: expiryActions.DISPOSITION.NOTHING_TO_DO, outcome: "AWAITING_VERIFICATION:RELEASED" });
    expect(events.find((entry) => entry.event === "timer.lease_expiry_recovery").detail).toMatchObject({
      custodyState: "RELEASED",
      outcome: leases.RECOVERY_OUTCOME.AWAIT_VERIFICATION,
      legState: S.RELEASED,
    });

    // 7. No new commitment, and the incumbent's is neither released nor re-fenced.
    expect(after.commitments).toHaveLength(1);
    expect(after.commitments[0].releasedAt).toBeNull();
    expect(after.agentFence).toBe(before.agentFence);
    // 8. Held in RELEASED, not moved toward the queue — and not even version-bumped, so the
    //    Leg's own VERIFICATION_ESCALATION deadline is neither cancelled nor pushed back.
    expect(after.leg.state).toBe(S.RELEASED);
    expect(after.leg.custodyState).toBe("RELEASED");
    expect(after.leg.version).toBe(released.version);
    // 9. Nothing was sent to any agent: no RECALL, no new OFFER.
    expect(after).toEqual(before);
  });

  test("repeated reconciler sweeps over the same expired lease stay no-ops", async () => {
    const { store } = await assignedAndExpired();
    const released = await setLeg(store, { state: S.RELEASED, custodyState: "RELEASED" });
    const before = await snapshot(store);

    for (let sweep = 0; sweep < 5; sweep += 1) {
      // eslint-disable-next-line no-await-in-loop
      const { result } = await expireLease(store);
      expect(result.disposition).toBe(expiryActions.DISPOSITION.NOTHING_TO_DO);
    }

    expect(await snapshot(store)).toEqual(before);
    expect((await snapshot(store)).leg.version).toBe(released.version);
  });

  test("the hold is not a dead end: sufficient evidence arriving later still settles the Leg", async () => {
    const { store, fixture } = await assignedAndExpired();
    await setLeg(store, { state: S.RELEASED, custodyState: "RELEASED" });
    await expireLease(store);

    const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
    const commitment = await store.client.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });
    const full = completionClaim(trackWithGap(fixture.now));
    full.track.track = [...full.track.track, ...[310, 320, 330, 340, 350, 360, 370, 380].map((second) => ({
      at: new Date(fixture.now.getTime() + second * 1000),
      lat: 12.9,
      lon: 77.6 + (second / 600) * 0.002,
    }))];
    const sufficient = verification.verify(full);
    expect(sufficient.outcome).toBe(verification.OUTCOME.SUFFICIENT);

    const settled = await store.client.$transaction((tx) =>
      settlement.settle(tx, { leg, commitment, verification: sufficient, manifests: [], storeTime: store.now() }),
    );
    expect(settled.outcome).toBe(settlement.OUTCOME.SETTLED);
    const after = await snapshot(store);
    expect(after.leg.state).toBe(S.SETTLED);
    expect(after.commitments).toHaveLength(1);
    expect(after.commitments[0].releasedAt).not.toBeNull();
  });
});

describe("F-1 control — a Leg whose custody was never obtained is still reassigned on lease expiry", () => {
  test("custody NONE: the incumbent's commitment is released, re-fenced and recalled, and the Leg is REASSIGNING", async () => {
    const { store } = await assignedAndExpired();
    await setLeg(store, { state: S.ACCEPTED, custodyState: "NONE" });

    const { result, events } = await expireLease(store);
    const after = await snapshot(store);

    expect(result).toEqual({ disposition: expiryActions.DISPOSITION.TRANSITIONED, outcome: "REASSIGNED:commitment-c1" });
    expect(events.find((entry) => entry.event === "timer.lease_expiry_recovery").detail).toMatchObject({
      outcome: leases.RECOVERY_OUTCOME.REASSIGN,
      reason: "CUSTODY_NONE",
    });
    expect(after.leg.state).toBe(S.REASSIGNING);
    expect(after.commitments[0].releasedAt).not.toBeNull();
    expect(after.agentFence).toBe(43n);
    expect(store.rows("outbox").map((row) => row.command)).toEqual(["RECALL"]);
  });

  test("custody HELD (goods aboard, not delivered) still takes §4.7's physical-recovery path, unchanged", async () => {
    const { store } = await assignedAndExpired();
    await setLeg(store, { state: S.EN_ROUTE_DROP, custodyState: "HELD", obstructionClass: "CLEAR" });

    const { result } = await expireLease(store);
    const after = await snapshot(store);

    expect(result.disposition).toBe(expiryActions.DISPOSITION.TRANSITIONED);
    expect(after.leg.state).toBe(S.STRANDED_SAFE);
    expect(after.commitments[0].releasedAt).toBeNull();
    expect(store.rows("outbox")).toHaveLength(0);
  });
});

describe("F-1 — over the lifecycle model, no reachable state reassigns a delivered Leg", () => {
  test("every state with custody RELEASED has its Leg in RELEASED or SETTLED (the shipped capacity-1 search)", () => {
    // The same search `lifecycleModelCheck.test.js` pins (capacity 1, 2 Legs, depth 12), over
    // the shipped transition table and guards. Before the fix it reached 38 states with a
    // custody-RELEASED Leg in REASSIGNING; the property is that it reaches none.
    const shape = { capacity: 1, legs: 2, depth: 12 };
    const start = lifecycleModel.initialState(shape);
    const seen = new Set([lifecycleModel.key(start)]);
    const frontier = [{ state: start, depth: 0 }];
    const offending = [];
    while (frontier.length > 0) {
      const node = frontier.pop();
      for (const leg of node.state.legs) {
        if (leg.custodyState === "RELEASED" && leg.state !== S.RELEASED && leg.state !== S.SETTLED) {
          offending.push(lifecycleModel.key(node.state));
        }
      }
      if (node.depth >= shape.depth) continue;
      for (const successor of lifecycleModel.successors(node.state, shape)) {
        const k = lifecycleModel.key(successor.state);
        if (seen.has(k)) continue;
        seen.add(k);
        frontier.push({ state: successor.state, depth: node.depth + 1 });
      }
    }
    expect(seen.size).toBeGreaterThan(5000);
    expect(offending).toEqual([]);
  });
});

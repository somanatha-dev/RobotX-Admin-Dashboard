"use strict";

/**
 * Charging lifecycle step F — a robot whose state changes AFTER it was indexed cannot slip into a
 * commitment: §10.3.2's commit re-verifies the volatile subset of feasibility under the row locks.
 *
 * The REAL decision path (`phase7World`: the index maintainer, the V1 composition, the §7 gate, the
 * plan builder, the solve) and the REAL commit (`assembly.deps.commit` → `commitment/commit.js` →
 * `feasibility/volatileSubset`), over LOCAL fixture rows; only the store, the clock and the
 * transaction are doubled (`scenario.commit` — every write is recorded, none applied). The Leg is
 * the real TSK-1791553228180-816 delivery.
 *
 * Two windows:
 *   · after the index, before the decision (`afterIndex`) — the gate reads fresh state;
 *   · after the decision, before the commit (`commit.between`) — only the volatile subset
 *     (F7, F8, F10, F13, F14, F16, F17, F18, F20, F34, F35) is re-checked, by §10.3.2's own list.
 *
 * GAPS found and pinned here (frozen engine 78b4712; the decisions are the owner's, see the
 * charging-lifecycle report): in the second window an operator PAUSE (F3, not in the volatile
 * subset) and a battery drain (F34 re-checks the memoised plan's planning-time energy) still commit.
 * The simulated robot's own OFFER check refuses the drained case (`energy.belowFloor`, §11.2);
 * nothing refuses the paused one before the robot answers the OFFER.
 */

const w = require("./helpers/phase7World");

jest.setTimeout(120_000);

const DT = w.TSK816.assignRoundMs;
const A = { lat: 12.901151, lon: 77.517575 }; // SIM-0A8C's LOCAL position, near TSK-816's pickup
const ID = "SIM-C";
const robot = () => ({ robotId: ID, cloneOf: "SIM-0A8C043FFE67", at: A, socFraction: 0.9 });
const COMMIT_WRITES = ["agent.update", "commitment.create", "leg.updateMany", "agentFenceAudit.upsert", "outbox.create"];

const change = {
  queued: (x) => x.addReservation({ robotId: ID, state: "QUEUED" }),
  active: (x) => x.addReservation({ robotId: ID, state: "ACTIVE" }),
  charging: (x) => x.setLiveState(ID, { status: "CHARGING", lat: A.lat, lon: A.lon, battery: 90 }),
  faulted: (x) => {
    x.robotRow(ID).status = "ERROR";
  },
  paused: (x) => {
    x.robotRow(ID).status = "PAUSED";
  },
  drained: (x) => {
    x.batteryRow(ID).lastObservedSoc = 0.12;
    x.robotRow(ID).battery = 12;
  },
};

const commitAfter = (between) => w.decide({ decisionTimeMs: DT, robots: [robot()], commit: { between } });

describe("control: nothing changes between the decision and the commit", () => {
  test("the assignment commits: commitment, Leg transition and the OFFER in one transaction", async () => {
    const out = await commitAfter(undefined);
    expect(out.winner).toBe(ID);
    expect(out.committed).toMatchObject({ outcome: "COMMITTED", committed: true });
    for (const write of COMMIT_WRITES) expect(out.committed.writes).toContain(write);
  });
});

describe("after the decision, before the commit: the volatile re-check refuses, and nothing is written", () => {
  test.each([
    ["newly queued for a plug (QUEUED reservation)", change.queued, "F18"],
    ["newly holding a plug (ACTIVE reservation)", change.active, "F18"],
    ["reporting CHARGING", change.charging, "F18"],
    ["faulted (ERROR)", change.faulted, "F8"],
  ])("%s → ABORTED (%s)", async (_label, between, predicateId) => {
    const out = await commitAfter(between);
    expect(out.winner).toBe(ID); // the round decided before the change
    expect(out.committed).toMatchObject({ outcome: "ABORTED", committed: false, reason: "VOLATILE_FEASIBILITY_LOST" });
    expect(out.committed.detail).toMatch(new RegExp(`^${predicateId} is VIOLATED at commit time`));
    expect(out.committed.writes).toEqual([]);
  });
});

describe("after the index, before the decision: the gate reads fresh state and refuses", () => {
  test.each([
    ["queued for a plug", (x) => x.addReservation({ robotId: ID, state: "QUEUED" }), "F18"],
    ["faulted", ({ store }) => { store.rowsOf("robot").find((r) => r.robotId === ID).status = "ERROR"; }, "F8"],
    ["paused by the operator", ({ store }) => { store.rowsOf("robot").find((r) => r.robotId === ID).status = "PAUSED"; }, "F3"],
    [
      "drained to 12 %",
      ({ store }) => {
        store.rowsOf("batteryState").find((r) => r.id === `battery-${ID}`).lastObservedSoc = 0.12;
        store.rowsOf("robot").find((r) => r.robotId === ID).battery = 12;
      },
      "F34",
    ],
  ])("%s → not assigned (%s), although the index still lists it", async (_label, afterIndex, predicateId) => {
    const out = await w.decide({ decisionTimeMs: DT, robots: [robot()], afterIndex });
    expect(out.indexed).toEqual([{ agentId: ID, availabilityClass: "IDLE_READY" }]);
    expect(out.winner).toBeNull();
    expect(out.denials[ID][0].predicateId).toBe(predicateId);
  });
});

describe("Gap B CLOSED — the commit re-checks energy on the battery, pack and reserve as they are NOW", () => {
  // Before the closure these committed: F34/F35 read the memoised plan's planning-time energy.
  test("drained to 12 % after the decision → ABORTED by the fresh energy check, and nothing is written", async () => {
    const out = await commitAfter(change.drained);
    expect(out.winner).toBe(ID);
    expect(out.committed).toMatchObject({ outcome: "ABORTED", committed: false, reason: "VOLATILE_FEASIBILITY_LOST" });
    expect(out.committed.detail).toMatch(/^F3[45] is (VIOLATED|INDETERMINATE) at commit time/);
    expect(out.committed.writes).toEqual([]);
  });

  test("the commissioned reserve raised after the decision (90 % SoC, reserve now 85 %) → ABORTED: the reserve is re-read", async () => {
    const out = await commitAfter((x) => {
      x.robotRow(ID).batteryReservePct = 85;
    });
    expect(out.committed).toMatchObject({ outcome: "ABORTED", reason: "VOLATILE_FEASIBILITY_LOST" });
    expect(out.committed.detail).toMatch(/^F3[45] is (VIOLATED|INDETERMINATE) at commit time/);
    expect(out.committed.writes).toEqual([]);
  });

  test("the battery reading gone after the decision → ABORTED (fail closed: no reading, no energy, F34 denies)", async () => {
    const out = await commitAfter((x) => {
      x.batteryRow(ID).lastObservedSoc = null;
      x.robotRow(ID).battery = null;
    });
    expect(out.committed).toMatchObject({ outcome: "ABORTED", reason: "VOLATILE_FEASIBILITY_LOST" });
    expect(out.committed.writes).toEqual([]);
  });

  test("a small drain that still leaves the mission feasible (90 % → 80 %) → COMMITTED: normal assignments are unaffected", async () => {
    const out = await commitAfter((x) => {
      x.batteryRow(ID).lastObservedSoc = 0.8;
      x.robotRow(ID).battery = 80;
    });
    expect(out.committed).toMatchObject({ outcome: "COMMITTED", committed: true });
    for (const write of COMMIT_WRITES) expect(out.committed.writes).toContain(write);
  });
});

describe("Gap A — paused after the decision: the commit itself is unchanged; the ACCEPT is where it is refused", () => {
  test("the commit proceeds (F3 is not in §10.3.2's frozen volatile subset) — the server refuses the robot's ACCEPT (offerAcceptAdmission.test.js) and the robot rejects the OFFER (heldRobotRefusesOffer.test.js)", async () => {
    const out = await commitAfter(change.paused);
    expect(out.committed).toMatchObject({ outcome: "COMMITTED", committed: true });
  });
});

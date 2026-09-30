"use strict";

/**
 * P1.4 — a simulated unit whose commitment is WITHDRAWn or RECALLed stays in service.
 *
 * The engine releases the commitment when it withdraws or recalls it (§4.7's custody-NONE
 * protocol). The simulator used to answer both with `_applyStop` — status PAUSED, "so
 * RESUME can pick it back up" — but nothing resumes a retired commitment, and under §23.5
 * enforcement a PAUSED unit can never report itself back to IDLE. Measured live: the robot
 * withdrawn after the boot-time OFFER race was held out by F3 for the rest of the run.
 */

const VirtualRobot = require("../../../src/simulation/VirtualRobot");

function makeFlash() {
  const values = new Map();
  return {
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async set(key, value) { values.set(key, value); return "OK"; },
    async del(key) { values.delete(key); },
  };
}

async function executingAgent(commitmentId) {
  const agent = new VirtualRobot({
    robotId: "vr-withdraw-1",
    lat: 12.9,
    lon: 77.5,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    kv: makeFlash(),
  });
  await agent.loadDedupState();
  agent._activeCommitment = { commitmentId, fence: 2n };
  agent.task = { taskId: "t1", pathToPickup: [], pathToDrop: [] };
  agent.phase = "TO_PICKUP";
  agent.status = "ACTIVE";
  agent.speed = 1.4;
  return agent;
}

describe("WITHDRAW / RECALL of the unit's own commitment returns it to service (P1.4)", () => {
  for (const command of ["WITHDRAW", "RECALL"]) {
    test(`${command} of the active commitment → mission abandoned, IDLE, commitment retired`, async () => {
      const agent = await executingAgent("C1");
      agent._applyMissionEffect(command, { commitmentId: "C1" });

      expect(agent.status).toBe("IDLE");
      expect(agent.speed).toBe(0);
      expect(agent.task).toBeFalsy();
      expect(agent._activeCommitment).toBeNull();
      expect(agent.dedup.tombstones.has("C1")).toBe(true);
    });
  }

  test("a WITHDRAW for a commitment the unit is not executing leaves its current mission alone", async () => {
    const agent = await executingAgent("C1");
    agent.offers.set("C2", { commitmentId: "C2" });
    agent._applyMissionEffect("WITHDRAW", { commitmentId: "C2" });

    expect(agent.status).toBe("ACTIVE");
    expect(agent.task).toMatchObject({ taskId: "t1" });
    expect(agent._activeCommitment).toMatchObject({ commitmentId: "C1" });
    expect(agent.offers.has("C2")).toBe(false);
    expect(agent.dedup.tombstones.has("C2")).toBe(true);
  });

  test("ABORT_MISSION still halts in place (unchanged)", async () => {
    const agent = await executingAgent("C1");
    agent._applyMissionEffect("ABORT_MISSION", { commitmentId: "C1" });
    expect(agent.status).toBe("PAUSED");
    expect(agent._activeCommitment).toBeNull();
  });
});

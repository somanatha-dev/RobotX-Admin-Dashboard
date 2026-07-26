const { computeCosts } = require("../../../src/services/costEvaluator.service");
const { setRobotState } = require("../../../src/services/robotRegistry.service");
const { createTestKv } = require("../../helpers/testKv");

describe("costEvaluator.service — DTARO cost function", () => {
  let kv;

  beforeEach(async () => {
    ({ kv } = await createTestKv());
  });

  test("closer, fuller-battery, less-utilized robot wins with default weights", async () => {
    await setRobotState(kv, "R1", { battery: 90, utilization: 0.1 });
    await setRobotState(kv, "R2", { battery: 90, utilization: 0.1 });

    const candidates = [
      { robotId: "R1", distanceM: 100, durationSec: 60, battery: 90, zoneId: null },
      { robotId: "R2", distanceM: 5000, durationSec: 900, battery: 90, zoneId: null },
    ];

    const results = await computeCosts(kv, candidates);
    const winner = results.reduce((a, b) => (a.cost <= b.cost ? a : b));
    expect(winner.robotId).toBe("R1");
  });

  test("battery term dominates a low-battery candidate even when nearer", async () => {
    await setRobotState(kv, "NEAR_LOW_BATTERY", { battery: 21, utilization: 0 });
    await setRobotState(kv, "FAR_FULL_BATTERY", { battery: 100, utilization: 0 });

    const candidates = [
      { robotId: "NEAR_LOW_BATTERY", distanceM: 50, durationSec: 30, battery: 21, zoneId: null },
      { robotId: "FAR_FULL_BATTERY", distanceM: 3000, durationSec: 400, battery: 100, zoneId: null },
    ];

    const results = await computeCosts(kv, candidates);
    const near = results.find((r) => r.robotId === "NEAR_LOW_BATTERY");
    const far = results.find((r) => r.robotId === "FAR_FULL_BATTERY");

    // Battery component must reflect the inverted (1 - battery/100) formula.
    expect(near.components.B).toBeCloseTo(1 - 21 / 100, 4);
    expect(far.components.B).toBeCloseTo(0, 4);
  });

  test("zone-locality term (Z) prefers same-zone robot when pickup zone is known", async () => {
    await setRobotState(kv, "SAME_ZONE", { battery: 80, utilization: 0, zoneId: "zone-A" });
    await setRobotState(kv, "OTHER_ZONE", { battery: 80, utilization: 0, zoneId: "zone-B" });

    const candidates = [
      { robotId: "SAME_ZONE", distanceM: 1000, durationSec: 100, battery: 80, zoneId: "zone-A" },
      { robotId: "OTHER_ZONE", distanceM: 1000, durationSec: 100, battery: 80, zoneId: "zone-B" },
    ];

    const results = await computeCosts(kv, candidates, undefined, "zone-A");
    const same = results.find((r) => r.robotId === "SAME_ZONE");
    const other = results.find((r) => r.robotId === "OTHER_ZONE");

    expect(same.components.Z).toBe(0);
    expect(other.components.Z).toBe(1);
    expect(same.cost).toBeLessThan(other.cost);
  });

  test("Z is neutral (0 for everyone) when pickup zone is unknown", async () => {
    await setRobotState(kv, "A", { battery: 80, utilization: 0, zoneId: "zone-A" });
    await setRobotState(kv, "B", { battery: 80, utilization: 0, zoneId: "zone-B" });

    const candidates = [
      { robotId: "A", distanceM: 1000, durationSec: 100, battery: 80, zoneId: "zone-A" },
      { robotId: "B", distanceM: 1000, durationSec: 100, battery: 80, zoneId: "zone-B" },
    ];

    const results = await computeCosts(kv, candidates, undefined, null);
    expect(results.every((r) => r.components.Z === 0)).toBe(true);
  });

  test("utilization term penalizes a busier robot", async () => {
    await setRobotState(kv, "IDLE_ROBOT", { battery: 80, utilization: 0 });
    await setRobotState(kv, "BUSY_ROBOT", { battery: 80, utilization: 0.9 });

    const candidates = [
      { robotId: "IDLE_ROBOT", distanceM: 1000, durationSec: 100, battery: 80, zoneId: null },
      { robotId: "BUSY_ROBOT", distanceM: 1000, durationSec: 100, battery: 80, zoneId: null },
    ];

    const results = await computeCosts(kv, candidates);
    const idle = results.find((r) => r.robotId === "IDLE_ROBOT");
    const busy = results.find((r) => r.robotId === "BUSY_ROBOT");
    expect(idle.cost).toBeLessThan(busy.cost);
    expect(busy.components.U).toBeCloseTo(0.9, 4);
  });

  test("normalize() gives every candidate 0.5 when all distances/durations are equal (no division by zero)", async () => {
    await setRobotState(kv, "X", { battery: 80, utilization: 0 });
    await setRobotState(kv, "Y", { battery: 80, utilization: 0 });

    const candidates = [
      { robotId: "X", distanceM: 500, durationSec: 200, battery: 80, zoneId: null },
      { robotId: "Y", distanceM: 500, durationSec: 200, battery: 80, zoneId: null },
    ];

    const results = await computeCosts(kv, candidates);
    for (const r of results) {
      expect(r.components.D).toBe(0.5);
      expect(r.components.T).toBe(0.5);
    }
  });

  test("empty candidate list returns empty result", async () => {
    const results = await computeCosts(kv, []);
    expect(results).toEqual([]);
  });

  test("custom weights override defaults", async () => {
    await setRobotState(kv, "A", { battery: 50, utilization: 0 });
    await setRobotState(kv, "B", { battery: 50, utilization: 0 });

    const candidates = [
      { robotId: "A", distanceM: 100, durationSec: 900, battery: 50, zoneId: null },
      { robotId: "B", distanceM: 5000, durationSec: 30, battery: 50, zoneId: null },
    ];

    // Weight travel-time (T) heavily, distance (D) at zero — B should now win
    // despite being much farther away, because it has the shorter ETA.
    const results = await computeCosts(kv, candidates, { w1: 0, w2: 0, w3: 0, w4: 1, w5: 0 });
    const winner = results.reduce((a, b) => (a.cost <= b.cost ? a : b));
    expect(winner.robotId).toBe("B");
  });
});

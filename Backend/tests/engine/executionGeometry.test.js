/**
 * Execution geometry — the drivable route an offer's stops carry (P0-11).
 *
 * Two properties are load-bearing and both are asserted here rather than left to review:
 *
 *   1. **It never invents a line.** When the provider cannot answer, the stop carries no
 *      `path`, so `VirtualRobot.assessExecutability` refuses the offer by name and the Leg
 *      returns to QUEUED. A straight-line substitute would defeat that refusal and put a
 *      robot "driving" through buildings.
 *   2. **It is not a routing source.** It produces one polyline; §5's `route` contract the
 *      coordinator's composition declares is six fields. The last group asserts the
 *      composition's refusal is unchanged by this module's existence.
 */

const executionGeometry = require("../../src/services/executionGeometry.service");

const AGENT = { lat: 12.9075, lon: 77.5005 };
const PICKUP = { sequence: 0, stopType: "PICKUP", lat: 12.9081, lon: 77.5012 };
const DROP = { sequence: 1, stopType: "DROP", lat: 12.9095, lon: 77.5031 };

/** A provider that answers with a real-shaped polyline between the two points. */
function provider({ answers = null, fails = [] } = {}) {
  return jest.fn(async ({ from, to, profile }) => {
    if (fails.includes(profile)) throw new Error(`${profile} unavailable`);
    if (answers) return answers({ from, to, profile });
    return {
      points: [
        { lat: from.lat, lon: from.lon },
        { lat: (from.lat + to.lat) / 2, lon: (from.lon + to.lon) / 2 },
        { lat: to.lat, lon: to.lon },
      ],
      distanceMeters: 240,
      durationSec: 180,
    };
  });
}

describe("attachStopPaths — the sequence the agent actually drives", () => {
  test("routes agent → pickup, then pickup → drop", async () => {
    const directions = provider();
    const result = await executionGeometry.attachStopPaths({
      from: AGENT,
      stops: [PICKUP, DROP],
      directions,
    });

    expect(result.routed).toBe(2);
    expect(directions).toHaveBeenNthCalledWith(1, expect.objectContaining({ from: AGENT, to: { lat: PICKUP.lat, lon: PICKUP.lon } }));
    expect(directions).toHaveBeenNthCalledWith(2, expect.objectContaining({
      from: { lat: PICKUP.lat, lon: PICKUP.lon },
      to: { lat: DROP.lat, lon: DROP.lon },
    }));
  });

  test("the attached path is the [{lat, lon}] shape the agent's phase machine walks", async () => {
    const result = await executionGeometry.attachStopPaths({ from: AGENT, stops: [PICKUP, DROP], directions: provider() });

    for (const stop of result.stops) {
      expect(Array.isArray(stop.path)).toBe(true);
      expect(stop.path.length).toBeGreaterThanOrEqual(2);
      for (const point of stop.path) {
        expect(typeof point.lat).toBe("number");
        expect(typeof point.lon).toBe("number");
      }
    }
  });

  test("every field the offer already carried survives untouched", async () => {
    const result = await executionGeometry.attachStopPaths({ from: AGENT, stops: [PICKUP, DROP], directions: provider() });
    expect(result.stops[0]).toEqual(expect.objectContaining(PICKUP));
    expect(result.stops[1]).toEqual(expect.objectContaining(DROP));
  });

  test("records which provider profile produced each line", async () => {
    const result = await executionGeometry.attachStopPaths({
      from: AGENT,
      stops: [PICKUP, DROP],
      directions: provider({ fails: ["driving"] }),
    });
    expect(result.stops[0].pathProfile).toBe("walking");
  });

  test("falls through the profiles in order rather than giving up on the first", async () => {
    const directions = provider({ fails: ["driving", "walking"] });
    const result = await executionGeometry.attachStopPaths({ from: AGENT, stops: [PICKUP], directions });
    expect(result.routed).toBe(1);
    expect(result.stops[0].pathProfile).toBe("cycling");
  });
});

describe("attachStopPaths — absence is absence, never a fabricated line", () => {
  test("a stop whose leg cannot be routed carries no path key at all", async () => {
    const directions = provider({ fails: ["driving", "walking", "cycling"] });
    const result = await executionGeometry.attachStopPaths({ from: AGENT, stops: [PICKUP, DROP], directions });

    expect(result.routed).toBe(0);
    expect(result.unroutable).toEqual([0, 1]);
    expect(result.stops[0]).not.toHaveProperty("path");
    expect(result.stops[1]).not.toHaveProperty("path");
  });

  test("a one-point 'route' is refused — it completes a mission during which nothing moved", async () => {
    const directions = provider({ answers: ({ to }) => ({ points: [{ lat: to.lat, lon: to.lon }], distanceMeters: 0 }) });
    const result = await executionGeometry.attachStopPaths({ from: AGENT, stops: [PICKUP], directions });
    expect(result.stops[0]).not.toHaveProperty("path");
  });

  test("a route with a non-numeric coordinate is refused rather than passed through", async () => {
    const directions = provider({
      answers: () => ({ points: [{ lat: "12.9", lon: null }, { lat: 12.91, lon: 77.5 }], distanceMeters: 10 }),
    });
    const result = await executionGeometry.attachStopPaths({ from: AGENT, stops: [PICKUP], directions });
    expect(result.stops[0]).not.toHaveProperty("path");
  });

  test("an agent with no known position routes nothing and calls no provider", async () => {
    const directions = provider();
    const result = await executionGeometry.attachStopPaths({ from: { lat: null, lon: null }, stops: [PICKUP], directions });
    expect(directions).not.toHaveBeenCalled();
    expect(result.routed).toBe(0);
  });

  test("one unroutable hop does not withhold geometry for the rest of the plan", async () => {
    let call = 0;
    const directions = jest.fn(async ({ from, to }) => {
      call += 1;
      if (call <= 3) throw new Error("no route"); // all three profiles fail for hop 1
      return { points: [{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }], distanceMeters: 5 };
    });

    const result = await executionGeometry.attachStopPaths({ from: AGENT, stops: [PICKUP, DROP], directions });
    expect(result.unroutable).toEqual([0]);
    expect(result.stops[1].path).toHaveLength(2);
  });
});

describe("execution geometry is not the §5 routing source", () => {
  test("the coordinator's declared contract still names `route` as unresolved", () => {
    const coordinatorPipeline = require("../../src/workers/coordinatorPipeline");
    expect(coordinatorPipeline.REQUIREMENT_IDS).toContain("route");
  });

  test("it produces a polyline, not the six-field route contract", async () => {
    const result = await executionGeometry.attachStopPaths({ from: AGENT, stops: [PICKUP], directions: provider() });
    const stop = result.stops[0];
    // What it does supply.
    expect(stop.path).toBeDefined();
    // What a traversal source must supply, and this does not.
    expect(stop.travelSdSeconds).toBeUndefined();
    expect(stop.terrain).toBeUndefined();
    expect(stop.timeBucket).toBeUndefined();
    expect(stop.speedMetresPerSecond).toBeUndefined();
  });
});

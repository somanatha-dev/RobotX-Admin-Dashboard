"use strict";

/**
 * The simulated-route containment issue, and the smallest correction, tested IN ISOLATION.
 *
 * `v1DemonstrationComposition.networksFrom` builds the simulator's network without
 * `containment`. The candidate correction is to pass `routeContainment.createRouteContainment`
 * of the pinned declaration, as `physicalRouter` and `chargerRoute` already do. That changes
 * commanded routes, so it is NOT applied: these tests build both networks side by side through
 * `tools/campus/simRouteContainmentProbe.js` and pin what the correction would and would not
 * change. See also `dtaroCampusBoundaryRegression.test.js` (another session), whose
 * `test.failing` records the same gap on the live composition.
 */

const fs = require("fs");
const path = require("path");

const { probe } = require("../../tools/campus/simRouteContainmentProbe");

jest.setTimeout(120_000);

const result = probe();

describe("the issue, measured on the live (uncontained) simulator network", () => {
  test("routes reach up to 8.1 m outside the boundary", () => {
    expect(result.live.maxOutsideM).toBeCloseTo(8.1, 1);
  });

  test("every route that leaves the boundary starts or ends at Playground 2, and every Playground 2 route leaves it", () => {
    const pg2 = "supplemental:rnsit-playground-2";
    expect(result.live.pairsLeavingBoundary).toBe((result.endpoints - 1) * 2);
    for (const p of result.pairsDetail.filter((x) => x.live.outsideM > 0)) expect([p.from, p.to]).toContain(pg2);
  });
});

describe("the correction (contained network), not applied", () => {
  test("no pair is refused and no route leaves the boundary", () => {
    expect(result.contained.refused).toEqual([]);
    expect(result.contained.pairsLeavingBoundary).toBe(0);
    expect(result.contained.maxOutsideM).toBe(0);
  });

  test("it changes only the routes that left the boundary; every other route is identical", () => {
    for (const p of result.pairsDetail) {
      if (p.live.outsideM > 0) continue;
      expect(p.contained.distanceM).toBe(p.live.distanceM);
    }
    expect(result.contained.unchangedPairs).toBe(result.pairs - result.live.pairsLeavingBoundary);
  });

  test("the changed routes get shorter, not longer (PU College ⇄ Playground 2: 410 m → 388 m)", () => {
    for (const c of result.contained.lengthChange) expect(c.containedM).toBeLessThanOrEqual(c.liveM);
    const pu = result.contained.lengthChange.find((c) => /pre-university/.test(c.from) && /playground-2/.test(c.to));
    expect(pu).toEqual(expect.objectContaining({ liveM: 410, containedM: 388 }));
  });

  test("it has not been applied: the live composition still builds its network without containment", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../../src/services/v1DemonstrationComposition.js"), "utf8");
    const call = source.slice(source.indexOf("campusTraversalNetwork.createCampusTraversalNetwork({"));
    expect(call.slice(0, call.indexOf("})")).includes("containment")).toBe(false);
  });
});

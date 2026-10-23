"use strict";

/**
 * The adopted DTARO cross-zone recipient policy (`src/services/dtaroRecipientPolicy.js`):
 * same-zone robots, plus same-region robots whose REMAINING commanded route meets the obstacle.
 * Pure function; the obstacle footprint is the alert's own (`dtaroZoneAlert.cellFootprint`).
 */

const h3 = require("h3-js");

const { selectRecipients, REASON } = require("../../../src/services/dtaroRecipientPolicy");
const { cellFootprint } = require("../../../src/services/dtaroZoneAlert.service");

const OBSTACLE_CELL = h3.latLngToCell(12.9005, 77.518, 11);
const [OB_LAT, OB_LON] = h3.cellToLatLng(OBSTACLE_CELL);
const obstacle = { regionId: "rnsit", zoneId: "rnsit-z-south", footprint: cellFootprint(OBSTACLE_CELL) };

/** A straight route through the obstacle cell's centre, west → east, and one well clear of it. */
const through = [{ lat: OB_LAT, lon: OB_LON - 0.001 }, { lat: OB_LAT, lon: OB_LON + 0.001 }];
const clear = [{ lat: OB_LAT + 0.002, lon: OB_LON - 0.001 }, { lat: OB_LAT + 0.002, lon: OB_LON + 0.001 }];
/** The same through-route, but the robot is already past the obstacle: only the part ahead counts. */
const passed = [{ lat: OB_LAT, lon: OB_LON + 0.0005 }, { lat: OB_LAT, lon: OB_LON + 0.001 }];

describe("dtaroRecipientPolicy.selectRecipients", () => {
  test("a robot in the obstacle's zone is warned whatever its route (today's zone room)", () => {
    const r = selectRecipients({ obstacle, robots: [{ robotId: "A", regionId: "rnsit", zoneId: "rnsit-z-south", remainingRoute: clear }] });
    expect(r).toEqual({
      sameZone: ["A"],
      crossZone: [],
      notNotified: [],
      // The route is evaluated and recorded for a same-zone robot too, but does not decide.
      decisions: [{ robotId: "A", relation: "SAME_ZONE", routeIntersects: false, selected: true, reason: REASON.SAME_ZONE }],
    });
  });

  test("a robot in another zone is warned when its remaining route meets the obstacle", () => {
    const r = selectRecipients({ obstacle, robots: [{ robotId: "B", regionId: "rnsit", zoneId: "rnsit-z-west", remainingRoute: through }] });
    expect(r.crossZone).toEqual(["B"]);
  });

  test("…and not when its route is clear, or the obstacle is already behind it", () => {
    const r = selectRecipients({
      obstacle,
      robots: [
        { robotId: "C", regionId: "rnsit", zoneId: "rnsit-z-west", remainingRoute: clear },
        { robotId: "D", regionId: "rnsit", zoneId: "rnsit-z-east", remainingRoute: passed },
      ],
    });
    expect(r.crossZone).toEqual([]);
    expect(r.notNotified).toEqual([
      { robotId: "C", reason: REASON.ROUTE_CLEAR },
      { robotId: "D", reason: REASON.ROUTE_CLEAR },
    ]);
  });

  test("region isolation: a robot in another region is never warned, even with a route through the obstacle", () => {
    const r = selectRecipients({
      obstacle,
      robots: [
        { robotId: "J", regionId: "jssate", zoneId: "rnsit-z-south", remainingRoute: through },
        { robotId: "K", regionId: "jssate", zoneId: "jssate-z1", remainingRoute: through },
      ],
    });
    expect(r.sameZone).toEqual([]);
    expect(r.crossZone).toEqual([]);
    expect(r.notNotified.map((n) => n.reason)).toEqual([REASON.OTHER_REGION, REASON.OTHER_REGION]);
  });

  test("the reporter is excluded; a robot with no route is not cross-zone; one in no zone is judged by its route", () => {
    const r = selectRecipients({
      obstacle,
      reporterRobotId: "R",
      robots: [
        { robotId: "R", regionId: "rnsit", zoneId: "rnsit-z-south", remainingRoute: through },
        { robotId: "N", regionId: "rnsit", zoneId: "rnsit-z-west", remainingRoute: null },
        { robotId: "O", regionId: "rnsit", zoneId: null, remainingRoute: through },
      ],
    });
    expect(r.sameZone).toEqual([]);
    expect(r.crossZone).toEqual(["O"]);
    expect(r.notNotified).toEqual([
      { robotId: "N", reason: REASON.NO_REMAINING_ROUTE },
      { robotId: "R", reason: REASON.REPORTER },
    ]);
  });

  test("deterministic: the same robots in any order give the same, sorted answer", () => {
    const robots = [
      { robotId: "z", regionId: "rnsit", zoneId: "rnsit-z-west", remainingRoute: through },
      { robotId: "a", regionId: "rnsit", zoneId: "rnsit-z-south", remainingRoute: clear },
      { robotId: "m", regionId: "rnsit", zoneId: "rnsit-z-east", remainingRoute: through },
    ];
    const one = selectRecipients({ obstacle, robots });
    const two = selectRecipients({ obstacle, robots: [...robots].reverse() });
    expect(one).toEqual(two);
    expect(one).toMatchObject({ sameZone: ["a"], crossZone: ["m", "z"], notNotified: [] });
    expect(one.decisions.map((d) => [d.robotId, d.relation, d.selected, d.reason])).toEqual([
      ["a", "SAME_ZONE", true, REASON.SAME_ZONE],
      ["m", "OTHER_ZONE", true, REASON.ROUTE_CROSSES_OBSTACLE],
      ["z", "OTHER_ZONE", true, REASON.ROUTE_CROSSES_OBSTACLE],
    ]);
  });

  test("every robot considered gets exactly one decision, with its reason", () => {
    const r = selectRecipients({
      obstacle,
      reporterRobotId: "R",
      robots: [
        { robotId: "R", regionId: "rnsit", zoneId: "rnsit-z-south", remainingRoute: through },
        { robotId: "S", regionId: "rnsit", zoneId: "rnsit-z-south", remainingRoute: null },
        { robotId: "X", regionId: "rnsit", zoneId: "rnsit-z-west", remainingRoute: through },
        { robotId: "C", regionId: "rnsit", zoneId: "rnsit-z-west", remainingRoute: clear },
        { robotId: "I", regionId: "rnsit", zoneId: "rnsit-z-west", remainingRoute: null },
        { robotId: "J", regionId: "jssate", zoneId: "jssate-z1", remainingRoute: through },
      ],
    });
    expect(r.decisions.map((d) => [d.robotId, d.relation, d.routeIntersects, d.selected, d.reason])).toEqual([
      ["C", "OTHER_ZONE", false, false, REASON.ROUTE_CLEAR],
      ["I", "OTHER_ZONE", null, false, REASON.NO_REMAINING_ROUTE],
      ["J", "OTHER_REGION", null, false, REASON.OTHER_REGION],
      ["R", "REPORTER", null, false, REASON.REPORTER],
      ["S", "SAME_ZONE", null, true, REASON.SAME_ZONE],
      ["X", "OTHER_ZONE", true, true, REASON.ROUTE_CROSSES_OBSTACLE],
    ]);
  });

  test("an UNKNOWN route (could not be read, or no usable geometry) is alerted conservatively; an idle robot is not", () => {
    const r = selectRecipients({
      obstacle,
      robots: [
        { robotId: "U", regionId: "rnsit", zoneId: "rnsit-z-west", remainingRoute: null, routeUnknown: true },
        { robotId: "I", regionId: "rnsit", zoneId: "rnsit-z-west", remainingRoute: null, routeUnknown: false },
        // Region isolation wins over the conservative rule: another region is never alerted.
        { robotId: "J", regionId: "jssate", zoneId: "rnsit-z-west", remainingRoute: null, routeUnknown: true },
        // A known route decides; `routeUnknown` only applies when there is no route to judge.
        { robotId: "C", regionId: "rnsit", zoneId: "rnsit-z-west", remainingRoute: clear, routeUnknown: true },
      ],
    });
    expect(r.crossZone).toEqual(["U"]);
    expect(r.decisions.map((d) => [d.robotId, d.selected, d.reason, d.routeIntersects])).toEqual([
      ["C", false, REASON.ROUTE_CLEAR, false],
      ["I", false, REASON.NO_REMAINING_ROUTE, null],
      ["J", false, REASON.OTHER_REGION, null],
      ["U", true, REASON.ROUTE_UNKNOWN, null],
    ]);
  });

  test("a reused zone id in another region is still another region: never a recipient", () => {
    const r = selectRecipients({
      obstacle,
      robots: [{ robotId: "Z", regionId: "jssate", zoneId: obstacle.zoneId, remainingRoute: through }],
    });
    expect(r.sameZone).toEqual([]);
    expect(r.crossZone).toEqual([]);
    expect(r.decisions).toEqual([{ robotId: "Z", relation: "OTHER_REGION", routeIntersects: null, selected: false, reason: REASON.OTHER_REGION }]);
  });

  test("route endpoints and boundaries: a route ENDING on the footprint edge or vertex is a crossing", () => {
    const [v0, v1] = obstacle.footprint;
    const mid = { lat: (v0.lat + v1.lat) / 2, lon: (v0.lon + v1.lon) / 2 };
    const outward = { lat: mid.lat + (mid.lat - OB_LAT) * 3, lon: mid.lon + (mid.lon - OB_LON) * 3 };
    const robots = [
      { robotId: "E", regionId: "rnsit", zoneId: "rnsit-z-west", remainingRoute: [outward, mid] },
      { robotId: "V", regionId: "rnsit", zoneId: "rnsit-z-west", remainingRoute: [{ lat: v0.lat + 0.001, lon: v0.lon }, v0] },
      // A zero-length route (a robot at the end of its corridor) inside the footprint.
      { robotId: "Z", regionId: "rnsit", zoneId: "rnsit-z-west", remainingRoute: [{ lat: OB_LAT, lon: OB_LON }, { lat: OB_LAT, lon: OB_LON }] },
    ];
    expect(selectRecipients({ obstacle, robots }).crossZone).toEqual(["E", "V", "Z"]);
  });

  test("an obstacle without a resolved region, zone or footprint is refused", () => {
    expect(() => selectRecipients({ obstacle: { regionId: "rnsit", zoneId: null, footprint: [] }, robots: [] })).toThrow(TypeError);
  });
});

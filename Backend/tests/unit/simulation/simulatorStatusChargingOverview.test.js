"use strict";

/**
 * `GET /api/simulator/status` carries the charging estate and each queued robot's place in its
 * queue (Phase B / dashboard), merged into the robot's own `charging` view — and a failing
 * overview never takes the status down with it.
 */

jest.mock("../../../src/db/prisma");

const controller = require("../../../src/controllers/simulator.controller");

function call(sim) {
  const req = { app: { locals: { virtualSimulator: sim } } };
  let body = null;
  const res = { status() { return this; }, json(payload) { body = payload; return this; } };
  controller.getStatus(req, res, (e) => { throw e; });
  // `asyncHandler` does not return its promise: wait for the response to be written.
  return (async () => {
    for (let i = 0; i < 100 && body === null; i += 1) await new Promise((resolve) => setImmediate(resolve));
    return body;
  })();
}

const status = () => ({
  enabled: true,
  robots: [
    { robotId: "SIM-1", charging: { phase: "WAITING", reservationState: "QUEUED", stationId: "V1DEMO-DEPOT-01" } },
    { robotId: "SIM-2", charging: { phase: null } },
  ],
});

test("the overview's stations are attached and a queued robot gets its queue position and wait", async () => {
  const body = await call({
    getStatus: status,
    chargingOverview: async () => ({
      stations: [{ chargerId: "V1DEMO-DEPOT-01", plugCount: 3, active: 3, queued: 1 }],
      robots: { "SIM-1": { stationName: "V1 depot", queuePosition: 1, estimatedWaitS: 120 } },
      provenance: "DEVELOPMENT_SIMULATION",
    }),
  });
  expect(body.charging.stations).toHaveLength(1);
  expect(body.robots[0].charging).toMatchObject({ phase: "WAITING", queuePosition: 1, estimatedWaitS: 120, stationName: "V1 depot" });
  expect(body.robots[1].charging).toEqual({ phase: null });
});

test("an overview that fails leaves the robots' status intact and says charging is unknown", async () => {
  const body = await call({ getStatus: status, chargingOverview: async () => { throw new Error("db down"); } });
  expect(body.charging).toBeNull();
  expect(body.robots).toEqual(status().robots);
});

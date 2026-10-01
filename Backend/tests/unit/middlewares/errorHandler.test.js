"use strict";

/**
 * `middlewares/errorHandler.js` logs a database error's `code` and `meta`.
 *
 * Before, the simulator-creation 500 logged four stack lines that all read "Invalid
 * `tx.robot.create()` invocation"; the line saying which column did not exist was dropped.
 * The response body must not change — `meta` is for the server log, not the caller.
 */

// jest.config.js maps the handler's `../config/logger` to this stand-in; spy on the instance
// the handler actually holds.
const logger = require("../../mocks/silentLogger");
const errorHandler = require("../../../src/middlewares/errorHandler");

function run(err) {
  const res = {
    status: jest.fn(function status() { return this; }),
    json: jest.fn(function json() { return this; }),
  };
  errorHandler(err, { method: "POST", originalUrl: "/api/simulator/robot" }, res, () => {});
  return res;
}

beforeEach(() => { jest.spyOn(logger, "error"); });

test("a Prisma P2022 is logged with its code and the column it names; the response is unchanged", () => {
  const err = new Error("\nInvalid `tx.robot.create()` invocation in\nrobot.service.js:224:34\n\nThe column `Robot.statusBeforeOffline` does not exist in the current database.");
  err.code = "P2022";
  err.meta = { modelName: "Robot", column: "Robot.statusBeforeOffline" };

  const res = run(err);

  expect(res.status).toHaveBeenCalledWith(500);
  expect(res.json).toHaveBeenCalledWith({ message: "Internal Server Error" });
  const [line, fields] = logger.error.mock.calls[0];
  expect(line).toBe("[POST /api/simulator/robot] Internal Server Error");
  expect(fields.status).toBe(500);
  expect(fields.code).toBe("P2022");
  expect(fields.meta).toEqual({ modelName: "Robot", column: "Robot.statusBeforeOffline" });
});

test("an error with no code or meta logs neither key", () => {
  const err = new Error("Invalid locationId");
  err.status = 400;

  const res = run(err);

  expect(res.json).toHaveBeenCalledWith({ message: "Invalid locationId" });
  const [, fields] = logger.error.mock.calls[0];
  expect(fields).not.toHaveProperty("code");
  expect(fields).not.toHaveProperty("meta");
});

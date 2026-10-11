"use strict";

/**
 * Refuse an operator action on a retired robot (409 `ROBOT_RETIRED`).
 *
 * A retired robot keeps its `Robot` row — that is what preserves its history — so every
 * per-robot endpoint that used to answer "Unknown robotId" after a hard delete would now
 * act on it: issue a pairing code, send a command, declare a state of charge, clear a
 * fault, lift a pairing lockout, edit its specification. Mounted ahead of each of those
 * handlers, and ahead of the quarantine-override gate, so a refused request records no
 * override authorisation for a unit that is out of service.
 *
 * An unknown robot passes through: the handler's own 404 (or, for pairing issuance, its
 * creation path) answers it, as before. The check is a read, not a lock; a retirement that
 * commits after it is caught by the layers that matter — AUTH refuses the unit, and the
 * engine's F2 and G3 refuse to assign it.
 */

const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const { toStringOrNull } = require("../utils/parse");
const policy = require("../services/robotRetirementPolicy");

/**
 * @param {{ from?: "params" | "body" }} [options] where the robot id is read from
 * @returns {Function} express middleware
 */
function refuseRetiredRobot(options) {
  const from = options && options.from === "body" ? "body" : "params";

  return asyncHandler(async (req, res, next) => {
    const robotId = toStringOrNull(from === "body" ? req.body?.robotId : req.params?.robotId);
    if (!robotId) return next();

    const robot = await getPrisma().robot.findUnique({
      where: { robotId },
      select: policy.lifecycleSelect(),
    });
    if (!policy.isRetiredRobot(robot)) return next();

    return res.status(409).json({
      ok: false,
      error: "Conflict",
      code: policy.ROBOT_RETIRED,
      refusal: policy.ROBOT_RETIRED,
      message: `Unit ${robotId} is retired. A retired unit cannot be paired, commanded or reconfigured.`,
    });
  });
}

module.exports = { refuseRetiredRobot };

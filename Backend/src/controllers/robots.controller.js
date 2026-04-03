const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const robotService = require("../services/robot.service");

const commissionRobot = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const robot = await robotService.commissionRobot(prisma, req.body);
  res.json({ ok: true, robot });
});

const listRobots = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const robots = await robotService.listRobots(prisma, req.query);
  res.json({ ok: true, robots });
});

module.exports = {
  commissionRobot,
  listRobots,
};

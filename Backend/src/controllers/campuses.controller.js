const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const campusService = require("../services/campus.service");

const listCampuses = asyncHandler(async (_req, res) => {
  const prisma = getPrisma();
  const campuses = await campusService.listCampuses(prisma);
  res.json({ ok: true, campuses });
});

const createCampus = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const campus = await campusService.createCampus(prisma, req.body);
  res.json({ ok: true, campus });
});

module.exports = {
  listCampuses,
  createCampus,
};

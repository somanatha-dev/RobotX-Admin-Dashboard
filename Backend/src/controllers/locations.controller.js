const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const locationService = require("../services/location.service");

const listLocations = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const locations = await locationService.listLocations(prisma, {
    parentId: req.query.parentId,
    type: req.query.type,
  });
  res.json({ ok: true, locations });
});

const createLocation = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const location = await locationService.createLocation(prisma, req.body);
  res.json({ ok: true, location });
});

const listDescendants = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

  const ids = await locationService.collectDescendantLocationIds(prisma, id);
  res.json({ ok: true, ids });
});

module.exports = {
  listLocations,
  createLocation,
  listDescendants,
};

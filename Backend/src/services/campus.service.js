const { toStringOrNull, toNumberOrNull } = require("../utils/parse");

async function listCampuses(prisma) {
  return prisma.campus.findMany({ orderBy: [{ name: "asc" }] });
}

async function createCampus(prisma, body) {
  const code = toStringOrNull(body?.code);
  const name = toStringOrNull(body?.name);
  const centerLat = toNumberOrNull(body?.centerLat);
  const centerLon = toNumberOrNull(body?.centerLon);

  if (!code || !name) {
    const err = new Error("code and name are required");
    err.status = 400;
    throw err;
  }

  if (centerLat === null || centerLon === null) {
    const err = new Error("centerLat and centerLon are required");
    err.status = 400;
    throw err;
  }

  return prisma.campus.create({
    data: {
      code,
      name,
      centerLat,
      centerLon,
    },
  });
}

module.exports = {
  listCampuses,
  createCampus,
};

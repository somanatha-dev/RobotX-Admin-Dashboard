const { toStringOrNull, toNumberOrNull } = require("../utils/parse");

async function collectDescendantLocationIds(prisma, rootId) {
  const ids = [];
  const queue = [rootId];
  const seen = new Set();

  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);

    const children = await prisma.location.findMany({
      where: { parentId: id },
      select: { id: true },
    });

    for (const child of children) queue.push(child.id);
  }

  return ids;
}

async function listLocations(prisma, { parentId, type }) {
  const where = {};
  if (typeof parentId === "string" && parentId) where.parentId = parentId;
  if (typeof type === "string" && type) where.type = type;

  return prisma.location.findMany({
    where,
    orderBy: [{ name: "asc" }],
  });
}

async function createLocation(prisma, body) {
  const name = toStringOrNull(body?.name);
  const type = toStringOrNull(body?.type);
  const parentId = toStringOrNull(body?.parentId);
  const slug = toStringOrNull(body?.slug);
  const lat = toNumberOrNull(body?.lat);
  const lon = toNumberOrNull(body?.lon);

  if (!name || !type) {
    const err = new Error("name and type are required");
    err.status = 400;
    throw err;
  }

  if (parentId) {
    const parent = await prisma.location.findUnique({
      where: { id: parentId },
      select: { id: true },
    });
    if (!parent) {
      const err = new Error("Invalid parentId");
      err.status = 400;
      throw err;
    }
  }

  // Idempotent behavior: the schema enforces @@unique([name, parentId]).
  // If a matching location already exists, reuse it.
  const existing = await prisma.location.findFirst({
    where: {
      name,
      ...(parentId ? { parentId } : { parentId: null }),
    },
  });
  if (existing) return existing;

  try {
    return await prisma.location.create({
      data: {
        name,
        type,
        parentId,
        slug,
        lat,
        lon,
      },
    });
  } catch (e) {
    // In case of a race, fall back to returning the existing record.
    const raced = await prisma.location.findFirst({
      where: {
        name,
        ...(parentId ? { parentId } : { parentId: null }),
      },
    });
    if (raced) return raced;
    throw e;
  }
}

module.exports = {
  collectDescendantLocationIds,
  listLocations,
  createLocation,
};

const jwt = require("jsonwebtoken");

const { getPrisma } = require("../db/prisma");

function isUuid(value) {
  if (typeof value !== "string") return false;
  // Accept UUID v1-v5; Prisma UUID columns require a valid UUID string.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

// Verifies a raw JWT and resolves it to the current user, or null if the
// token is missing/invalid/expired/unknown. Shared by the HTTP `authUser`
// middleware and the Socket.IO dashboard connection gate so both surfaces
// enforce identical rules.
async function verifyUserToken(token) {
  if (!token || !process.env.JWT_SECRET) return null;

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?.id || !isUuid(decoded.id)) return null;

    const prisma = getPrisma();
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        email: true,
        role: true
      }
    });

    return user || null;
  } catch {
    return null;
  }
}

async function authUser(req, res, next) {
  const cookieToken = req.cookies?.token;
  const header = req.headers.authorization;
  const bearerToken = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : null;

  const token = cookieToken || bearerToken;

  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ message: "Server misconfigured" });
  }

  const user = await verifyUserToken(token);
  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  // Attach minimal data
  req.user = user;

  next();
}

module.exports = {
  authUser,
  verifyUserToken
};
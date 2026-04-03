function normalizeOrigin(origin) {
  if (!origin) return null;
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

function isLocalhostOrigin(origin) {
  const norm = normalizeOrigin(origin);
  if (!norm) return false;
  try {
    const { hostname } = new URL(norm);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function getAllowedOrigins() {
  // Allowlist for production-like deployments
  return [process.env.FRONTEND_URL].filter(Boolean);
}

function isOriginAllowed(origin) {
  // Non-browser clients (curl/postman) often have no Origin
  if (!origin) return true;

  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  if (!isProd && isLocalhostOrigin(origin)) return true;

  const norm = normalizeOrigin(origin);
  if (!norm) return false;
  return getAllowedOrigins().includes(norm);
}

function corsOriginDelegate(origin, callback) {
  const allowed = isOriginAllowed(origin);
  callback(null, allowed);
}

module.exports = {
  corsOriginDelegate,
  isOriginAllowed,
  getAllowedOrigins,
};

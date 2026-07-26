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
  // No Origin header is only ever sent by non-browser callers (curl,
  // server-to-server, Node socket.io-client robot connections) — real
  // browsers always attach Origin to cross-origin fetch/XHR/WebSocket
  // handshakes. Those non-browser callers never enforce or depend on the
  // CORS response headers this function drives, and every operational
  // surface is independently authenticated downstream regardless (REST via
  // `authUser`, dashboard sockets via JWT, robot sockets via AUTH/pairing).
  // So denying here closes the no-Origin bypass (F29/F2) as defense-in-depth
  // without weakening or requiring any change to those flows.
  if (!origin) return false;

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
};

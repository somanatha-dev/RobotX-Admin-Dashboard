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
  // `authUser`, dashboard sockets via JWT, robot sockets via the §23.2
  // certificate binding, or pairing where mTLS is not yet required).
  // So denying here closes the no-Origin bypass (F29/F2) as defense-in-depth
  // without weakening or requiring any change to those flows.
  //
  // PHASE 14 (§23.2) — this remains true, and is worth restating now that the agent
  // handshake is certificate-bound: an agent connection carries no Origin, is refused
  // by this function, and is unaffected by that refusal, because its authentication is
  // mutual TLS and not a browser-enforced header. CORS protects the *dashboard* surface
  // from a hostile page; it has never protected and does not protect the agent surface,
  // and conflating the two is how a deployment comes to believe an origin allowlist is
  // an authentication control.
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

// PHASE 14 (§23.2) — the TLS termination posture, read once and reported once.
//
// The server does not terminate mutual TLS itself in the shipped configuration: a
// deployment terminates at a load balancer and forwards the validated peer certificate,
// or it runs `https.createServer` with `requestCert: true` in front of this app. Both are
// deployment topology rather than application code, and the thing the application must
// do — and, before this phase, did not — is *state which posture it believes it is in*
// and refuse to be wrong about it quietly.
//
// `AGENT_MTLS_REQUIRED=true` is the assertion that a terminator is in place and is
// forwarding certificates. `robot.handler.js` then refuses any agent session that arrives
// without one. A deployment that sets the flag without the terminator loses its whole
// fleet at once and loudly, which is the correct failure: the alternative — accepting
// agents unauthenticated while believing mTLS is on — is the failure nobody notices.
function tlsPosture() {
  const required = String(process.env.AGENT_MTLS_REQUIRED || "").toLowerCase() === "true";
  return {
    agentMtlsRequired: required,
    // Where TLS is terminated ahead of this process, the peer certificate arrives in this
    // header. Named explicitly rather than scanned for, because a wildcard scan over
    // headers is a wildcard an attacker can also write to.
    forwardedCertificateHeader: "x-client-cert",
    note: required
      ? "AGENT_MTLS_REQUIRED is set: an agent session without a valid, unrevoked client certificate is refused (§23.2)."
      : "AGENT_MTLS_REQUIRED is not set: a presented certificate is still validated and bound, and pairing remains " +
        "available as the commissioning bootstrap. This is the staged posture the Phase 15 cutover ends.",
  };
}

module.exports = {
  corsOriginDelegate,
  isOriginAllowed,
  tlsPosture,
};

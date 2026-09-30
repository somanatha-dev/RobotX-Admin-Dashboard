const { toStringOrNull } = require("../../utils/parse");
const { allow } = require("../rateLimit");
const agentProbe = require("../../services/agentProbe.service");
const {
  getRobotSocket,
  setRobotSocket,
  deleteRobotSocket,
  disconnectSocket,
} = require("../robotSockets");
const crypto = require("crypto");
const { z } = require("zod");
const { markOnline, markOffline, getRobotState, setRobotState } = require("../../services/robotRegistry.service");
const { assignRobotToZone } = require("../../services/zoneManager.service");
const { DB_FLUSH_INTERVAL_MS } = require("../../config/liveness.constants");
const robotStateCache = require("../../cache/robotStateCache");
// PHASE 15 remediation (D-6) — the cutover switch is a conjunction, and this handler now
// reads both halves through the one module that owns the question. See agentGate.js for
// why the shard identity is resolved at AUTH rather than per event.
const agentGate = require("../../engine/cutover/agentGate");
const commitmentLeaseRenewal = require("../../services/commitmentLeaseRenewal.service");

// Per-robot throttle for the HEARTBEAT path's Postgres write, mirroring the
// same gate in telemetry.handler.js. Per-process and in-memory (same pattern
// as sockets/rateLimit.js), bounded by fleet size rather than by tick rate.
//
// Without this gate, HEARTBEAT issued an unconditional `prisma.robot.update`
// on every beat. Since VirtualRobot._tick() emits HEARTBEAT and TELEMETRY on
// the SAME 2-second tick, that meant 30 full-row writes per robot per minute —
// completely defeating the telemetry handler's flush gate, which had reduced
// its own writes to ~4/min. Aggregate write volume to `Robot` was unchanged;
// it had only moved handlers.
const lastHeartbeatDbFlushAt = new Map();

async function markRobotOnline(prisma, robotId, socketId) {
  const row = await prisma.robot.update({
    where: { robotId },
    data: {
      isOnline: true,
      socketId,
      lastSeenAt: new Date(),
    },
  });
  robotStateCache.set(robotId, { isOnline: true });

  // P1.4 (LF-1) — a server-observed reconnect undoes the server's own disconnect write. The
  // `OFFLINE` below was written by `markRobotOffline`, which kept the status it replaced;
  // restoring exactly that — and only while the row is still `OFFLINE` — never raises the
  // health tier (§23.5): an `ERROR` or `PAUSED` robot comes back `ERROR` or `PAUSED`. The
  // agent's own telemetry still cannot raise it. Before this, a robot that disconnected once
  // stayed `OFFLINE` for good under enforcement (F9 denied it; `clear-fault` refuses
  // `OFFLINE`); measured live, a simulator stop/start left the whole fleet unassignable.
  if (row && row.status === "OFFLINE" && row.statusBeforeOffline) {
    const restored = await prisma.robot.updateMany({
      where: { robotId, status: "OFFLINE", statusBeforeOffline: row.statusBeforeOffline },
      data: { status: row.statusBeforeOffline, statusBeforeOffline: null },
    });
    if (restored && restored.count === 1) {
      robotStateCache.set(robotId, { status: row.statusBeforeOffline });
      return { ...row, status: row.statusBeforeOffline, statusBeforeOffline: null };
    }
  }
  return row;
}

async function markRobotOffline(prisma, robotId) {
  const data = {
    isOnline: false,
    status: "OFFLINE",
    // Clear the socket binding too — leaving a dead socket id on the row
    // makes it look like a live handle to anything reading the column.
    socketId: null,
  };

  // P1.4 (LF-1) — keep the status this write replaces, for `markRobotOnline` to restore.
  // Conditional on the status just read, so a concurrent status change is never recorded
  // as the one replaced; a row already `OFFLINE` keeps what it remembered.
  const current = await prisma.robot.findUnique({ where: { robotId }, select: { status: true } });
  if (current && typeof current.status === "string" && current.status !== "OFFLINE") {
    const written = await prisma.robot.updateMany({
      where: { robotId, status: current.status },
      data: { ...data, statusBeforeOffline: current.status },
    });
    if (written && written.count === 1) {
      robotStateCache.set(robotId, { isOnline: false, status: "OFFLINE" });
      return { ...current, ...data, statusBeforeOffline: current.status };
    }
  }

  const row = await prisma.robot.update({ where: { robotId }, data });
  robotStateCache.set(robotId, { isOnline: false, status: "OFFLINE" });
  return row;
}

// Brute-force lockout thresholds (F32): after this many failed pairing-code
// attempts for a robotId (tracked across reconnects/sockets, since the
// counter key is keyed by robotId not socket.id), reject all further pairing
// attempts for that robotId until the lockout TTL elapses or an operator
// clears it via the admin unlock endpoint.
const PAIRING_LOCKOUT_THRESHOLD = 5;
const PAIRING_LOCKOUT_TTL_SEC = 3600;

// PHASE 4 — §11.5's session-establishment handshake.
//
//   > On every session establishment the agent reports its **deduplication high-water
//   > mark**: `dedup_state_generation`, `authority_epoch`, `fence_floor`, and the
//   > per-commitment high-water pairs for every commitment it believes it holds. The
//   > server compares this against the Commitment Store and takes one of three paths.
//
// Two conditions gate it, and both are deliberate:
//
//   1. `ENGINE_ENABLED`. The handshake's third path *writes* — it suppresses outbox
//      rows and advances an agent's `authority_epoch` — and the Phase 0 master switch
//      exists so that no engine write path is reachable before the Phase 15 cutover.
//   2. The agent actually reporting a dedup state. Its absence means "this agent does
//      not speak the protocol", which is the legacy fleet, and legacy AUTH must remain
//      byte-for-byte what it was. A *malformed* report is different and is logged: an
//      agent that speaks the protocol and got it wrong is a defect to surface.
//
// A robot with no projected `Agent` row is also a no-op: Phase 2's backfill is what
// creates the projection, and inventing one here would be a second backfill.
const clockModule = require("../../engine/commitment/clock");
const dedupHandshake = require("../../engine/dispatch/dedupHandshake");

// PHASE 14 — §23.2's mutual TLS, certificate-bound sessions, and capability attestation.
const sessionBinding = require("../../engine/security/sessionBinding");
const attestation = require("../../engine/security/attestation");

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 14 — §23.2. The agent handshake becomes certificate-bound.
//
//   > Mutual TLS with per-device certificates, private keys in a secure element where the
//   > hardware provides one, automated rotation, and revocation checked at session
//   > establishment **and** periodically during long sessions.
//
//   > Session establishment binds `(agent_id, certificate, session_id)`; a session cannot
//   > act for another agent.
//
// ── Why this is additive rather than a replacement, today ───────────────────
// The plan's own risk note for this phase is "changes the agent handshake; requires
// coordinated firmware rollout", and the implementation rule for every phase is that
// backwards compatibility is maintained. A server that could only speak the new handshake
// would disconnect every un-updated device at the moment of deploy — including the
// simulated fleet, which is the substrate every other phase's tests run on.
//
// So there are three states, and which one applies is a deployment decision, not a code
// change:
//
//   1. **No certificate presented, `AGENT_MTLS_REQUIRED` unset.** Legacy pairing and
//      session-token AUTH, byte-for-byte as before. This is what the simulator uses.
//   2. **A certificate is presented.** It is validated and bound whether or not mTLS is
//      required. A device that speaks the new protocol gets the new guarantees
//      immediately; there is no window in which a real certificate is ignored.
//   3. **`AGENT_MTLS_REQUIRED=true`.** An absent or invalid certificate is refused. This
//      is the end state, staged per deployment once the fleet has rotated.
//
// ── Pairing is retained *only* as a commissioning bootstrap ─────────────────
// The plan's row says exactly that. In state 3 the pairing branch is unreachable for a
// steady-state connection: `refusePairingUnderMtls()` refuses it by name rather than by
// falling through, because a bootstrap path that silently still works is not a bootstrap
// path — it is a second authentication scheme nobody is monitoring.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long a `SESSION_REKEY` command stays valid (§23.3's `not_valid_after`).
 *
 * Short by design. A rekey that surfaced twenty minutes late would rotate a binding the
 * server has already replaced, and §23.3's whole argument for expiry is that "the world
 * has moved on" — which is more true of a session command than of a mission offer.
 */
const REKEY_VALIDITY_MS = 60_000;

/**
 * Is this stored `session:{agentId}` value a §23.2 certificate binding rather than a
 * legacy bearer token? — PHASE 14 remediation (P14-R8).
 *
 * The two share one Redis key. A binding is a JSON object carrying a fingerprint and a
 * session id; a token is an opaque string. Telling them apart is what stops the first
 * being compared as though it were the second — see the call site for why that mattered.
 *
 * @param {unknown} stored the raw value read from the cache
 * @returns {boolean}
 */
function isCertificateBinding(stored) {
  if (stored === null || stored === undefined) return false;
  if (typeof stored === "object") return typeof stored.fingerprint === "string" && typeof stored.sessionId === "string";
  if (typeof stored !== "string") return false;
  // A bearer token is a UUID and never starts with `{`; parsing is attempted only for a
  // value that is shaped like an object, so an ordinary token costs no parse.
  if (stored.trimStart()[0] !== "{") return false;
  try {
    const parsed = JSON.parse(stored);
    return Boolean(parsed) && typeof parsed.fingerprint === "string" && typeof parsed.sessionId === "string";
  } catch {
    return false;
  }
}

/** Is mutual TLS mandatory for agent sessions in this deployment? */
function mtlsRequired() {
  return String(process.env.AGENT_MTLS_REQUIRED || "").toLowerCase() === "true";
}

/**
 * The peer certificate the TLS terminator validated, however it reached us.
 *
 * Three shapes, because three deployments are normal: Node terminating TLS itself
 * (`getPeerCertificate()`), a reverse proxy forwarding the PEM in a header, and a test
 * or simulator supplying one through the Socket.IO auth payload.
 *
 * A proxy-forwarded header is trusted **only** because the proxy is inside the trust
 * boundary and strips any client-supplied copy — the same assumption `X-Forwarded-For`
 * already rests on in `rateLimitHttp.js`. A deployment whose proxy does not strip it has
 * a misconfiguration this code cannot detect, which is why state 3 exists and why the
 * header name is explicit rather than a wildcard scan.
 *
 * @param {object} socket
 * @param {object} [auth] the AUTH payload
 * @returns {*} something `sessionBinding.fingerprint()` understands, or null
 */
function peerCertificateOf(socket, auth) {
  const raw = socket?.request?.socket;
  if (raw && typeof raw.getPeerCertificate === "function") {
    const certificate = raw.getPeerCertificate();
    if (certificate && (certificate.raw || certificate.fingerprint256)) return certificate;
  }

  const forwarded = socket?.handshake?.headers?.["x-client-cert"];
  if (typeof forwarded === "string" && forwarded.includes("BEGIN CERTIFICATE")) {
    return decodeURIComponent(forwarded.replace(/\\n/g, "\n"));
  }

  const supplied = socket?.handshake?.auth?.certificate ?? (auth && auth.certificate);
  return supplied || null;
}

/**
 * Establish the `(agent_id, certificate, session_id)` binding, or decide that this
 * connection is a legacy one.
 *
 * @param {object} deps `{ prisma, kv, config, log }`
 * @param {object} input `{ socket, robotId, auth, now }`
 * @returns {Promise<{ mode: "MTLS"|"LEGACY", ok: boolean, refusal: string|null,
 *                     detail: string|null, binding: object|null }>}
 */
async function establishCertificateSession(deps, input) {
  const source = input || {};
  const certificate = peerCertificateOf(source.socket, source.auth);

  if (!certificate && !mtlsRequired()) {
    return { mode: "LEGACY", ok: true, refusal: null, detail: null, binding: null };
  }

  const now = source.now instanceof Date ? source.now : new Date();
  const established = await sessionBinding.establish(deps, {
    agentId: source.robotId,
    certificate,
    sessionId: source.socket.id,
    now,
    recheckIntervalSeconds: configNumber(deps.config, "security.certificate_revocation_recheck_interval"),
    sessionMaxAgeSeconds: configNumber(deps.config, "security.session_max_age"),
  });

  return { mode: "MTLS", ...established };
}

/**
 * Read a numeric configuration value from the process's pinned snapshot.
 *
 * @param {object} config
 * @param {string} name
 * @returns {number|undefined}
 */
function configNumber(config, name) {
  const values = config?.values;
  const value = values instanceof Map ? values.get(name) : values?.[name];
  return Number.isFinite(value) ? Number(value) : undefined;
}

/**
 * §23.2 / §23.5 — a capability claim arriving on the agent's own data plane is rejected
 * entirely, and the rejection is a security event.
 *
 * The AUTH payload is a `passthrough()` schema, which is exactly the gap such a claim
 * would arrive through: an agent that added `capabilities: ["hazmat_certified"]` to its
 * AUTH would, before this phase, have had the field silently ignored — which is safe
 * today only because nothing read it, and would stop being safe the first time something
 * did.
 *
 * @param {object} payload
 * @param {string} robotId
 * @param {object} log
 * @returns {Array<object>} the claims found, for the caller to count
 */
function rejectCapabilityClaims(payload, robotId, log) {
  const claims = attestation.findCapabilityClaims(payload);
  if (claims.length === 0) return claims;

  log.warn?.("capability claim arriving via the agent data plane — rejected entirely (§23.2)", {
    robotId,
    paths: claims.map((claim) => claim.path),
    detail:
      "capabilities derive from the commissioning record plus a signed firmware/hardware attestation. A compromised " +
      "agent claiming hazmat_certified must not thereby become eligible for hazmat work.",
  });
  return claims;
}

/**
 * §11.5's deduplication handshake.
 *
 * PHASE 15 remediation (D-6) — this is an engine **write** path: it suppresses outbox rows
 * and advances the agent's `authority_epoch`. It therefore reads both halves of the cutover
 * switch, not just the process half. Before this change it ran for every shard whenever the
 * deployment-wide `ENGINE_ENABLED` was true — including shards the staging order had
 * deliberately not reached, whose agents would have had an authority epoch advanced by an
 * engine that was not the decision path for them.
 *
 * The verdict is passed in rather than computed here, because the caller has already
 * resolved and bound the shard identity as part of AUTH and a second resolution would be a
 * second answer.
 *
 * @param {object} prisma
 * @param {string} robotId
 * @param {*} reportedDedupState
 * @param {object} log
 * @param {{ allowed: boolean, refusal: string|null, shardId: string|null }} gate
 * @returns {Promise<object|null>}
 */
async function runDedupHandshake(prisma, robotId, reportedDedupState, log, gate) {
  if (!gate || gate.allowed !== true) {
    if (reportedDedupState !== undefined && reportedDedupState !== null) {
      log.info?.("AUTH dedup handshake skipped — the engine is not the decision path for this agent's shard", {
        robotId,
        shardId: gate ? gate.shardId : null,
        refusal: gate ? gate.refusal : "NO_VERDICT",
      });
    }
    return null;
  }
  if (reportedDedupState === undefined || reportedDedupState === null) return null;

  const parsed = dedupHandshake.parseReport(reportedDedupState);
  if (!parsed.ok) {
    log.warn("AUTH dedup report rejected", { robotId, reason: parsed.reason });
    return { path: null, error: parsed.reason };
  }

  try {
    const agent = await prisma.agent.findUnique({ where: { agentId: robotId } });
    if (!agent) return null;

    const applied = await prisma.$transaction(async (tx) => {
      const storeTime = await clockModule.readStoreTime(tx);
      const stored = await tx.agentDedupState.findUnique({ where: { agentId: agent.id } });
      const activeCommitments = await tx.commitment.findMany({
        where: { agentId: agent.id, releasedAt: null },
      });

      const classification = dedupHandshake.classify({
        reported: parsed.value,
        stored,
        activeCommitments,
      });

      const result = await dedupHandshake.apply(tx, {
        agent,
        reported: parsed.value,
        classification,
        storeTime,
      });

      return { result, classification };
    });

    if (dedupHandshake.isGenerationAdvance(applied.classification)) {
      // §11.5's monitoring requirement: "a rising rate across a class indicates
      // non-volatile storage that is not actually durable — a defect that is invisible
      // in every other signal."
      log.warn("agent dedup_state_generation advanced", {
        robotId,
        path: applied.classification.path,
        suppressedRows: applied.result.suppressedRows,
      });
    }

    return dedupHandshake.acknowledgement(applied.result);
  } catch (e) {
    log.error("AUTH dedup handshake failed", { robotId, message: e?.message });
    return { path: null, error: "HANDSHAKE_FAILED" };
  }
}

function registerRobotHandlers(io, socket, { prisma, kv, logger, appLocals }) {
  const log = logger || console;

  // PHASE 14 remediation (P14-R1) — the pinned configuration snapshot, from the express
  // app's locals, supplied by `socket.server.js`.
  //
  // This function previously reached for `io?.engine?.config || socket?.request?.app?.
  // locals?.config`. **Neither exists.** `io.engine` is the Engine.IO server and has no
  // `config`; `socket.request` is the raw upgrade request, which never passes through the
  // express app, so it has no `app` property at all. Both were therefore always
  // `undefined`, and every `configNumber()` call below returned `undefined` in every
  // deployment — so `security.session_max_age` never bounded a session and
  // `security.certificate_revocation_recheck_interval` never spaced a re-check. Read at
  // call time rather than captured, so a republished snapshot is picked up.
  const configOf = () => appLocals?.config ?? socket?.request?.app?.locals?.config ?? null;

  async function isPairingLocked(robotId) {
    try {
      return Boolean(await kv.get(`pairingLocked:${robotId}`));
    } catch {
      return false;
    }
  }

  async function lockPairing(robotId) {
    try {
      await kv.set(`pairingLocked:${robotId}`, "1", { ex: PAIRING_LOCKOUT_TTL_SEC });
    } catch {
      // ignore
    }
  }

  async function recordPairingAttempt(robotId) {
    try {
      // kv.incr is atomic (Redis INCR) — safe under concurrent AUTH attempts.
      const attempts = await kv.incr(`pairingAttempts:${robotId}`, { ex: 300 });
      if (attempts >= PAIRING_LOCKOUT_THRESHOLD) {
        await lockPairing(robotId);
      }
      return attempts;
    } catch {
      return 0;
    }
  }

  async function clearPairingAttempts(robotId) {
    try {
      await kv.del(`pairingAttempts:${robotId}`);
    } catch {
      // ignore
    }
  }

  const authSchema = z
    .object({
      robotId: z.string().min(1),
      token: z.union([z.string(), z.number()]).optional().nullable().transform((v) => (v === null || v === undefined ? v : String(v))),
      pairingCode: z.union([z.string(), z.number()]).optional().nullable().transform((v) => (v === null || v === undefined ? v : String(v))),
      // PHASE 4 — §11.5's session-establishment handshake. Optional, and its absence
      // is the legacy path: an agent that does not speak the protocol authenticates
      // exactly as before. `passthrough()` already admitted unknown keys, so declaring
      // it here narrows nothing; it documents the field and keeps the shape in one
      // place.
      dedupState: z.unknown().optional().nullable(),
      // PHASE 14 — §23.2. Declared for the same reason `dedupState` is: `passthrough()`
      // already admitted it, so naming it narrows nothing and keeps the shape in one
      // place. In a real deployment the certificate arrives from the TLS layer, not from
      // the payload; this accepts the simulator's and a test's.
      certificate: z.unknown().optional().nullable(),
    })
    .passthrough();

  socket.on("AUTH", async (payload) => {
    try {
      if (!allow(socket, "AUTH", { limit: 5, windowMs: 60_000, minIntervalMs: 100 })) return;

      const parsed = authSchema.safeParse(payload || {});
      if (!parsed.success) return socket.disconnect(true);
      const auth = parsed.data;

      const robotId = toStringOrNull(auth?.robotId);
      const pairingCode = toStringOrNull(auth?.pairingCode);
      const token = toStringOrNull(auth?.token);
      if (!robotId) return socket.disconnect(true);

      // P2B-2 — one socket speaks for one robot. An already-authenticated socket that AUTHs
      // again as a *different* robot is refused and closed: it would otherwise join the second
      // robot's room while still sitting in the first's, receiving both robots' commands.
      // Re-AUTH as the same robot (a client re-sending AUTH) is unaffected.
      if (socket.data.isAuthed === true && socket.data.robotId && socket.data.robotId !== robotId) {
        log.warn?.("AUTH refused — this socket is already authenticated as another robot", {
          boundRobotId: socket.data.robotId,
          requestedRobotId: robotId,
          socketId: socket.id,
        });
        return socket.disconnect(true);
      }

      // Reject unknown robots (must be commissioned in DB). This is the one
      // DB read AUTH needs — its result seeds robotStateCache so the
      // TELEMETRY hot path never needs its own per-tick read (see
      // cache/robotStateCache.js for why).
      const robot = await prisma.robot.findUnique({
        where: { robotId },
        select: { id: true, status: true, isOnline: true, lat: true, lon: true, battery: true },
      });
      if (!robot) return socket.disconnect(true);
      robotStateCache.set(robotId, {
        id: robot.id,
        status: robot.status,
        isOnline: robot.isOnline,
        lat: robot.lat,
        lon: robot.lon,
        battery: robot.battery,
      });

      // PHASE 14 — §23.2 / §23.5. A capability claim on the AUTH payload is rejected
      // entirely, before anything else is done with the payload.
      rejectCapabilityClaims(payload, robotId, log);

      // PHASE 14 — §23.2's certificate-bound session. Runs before the pairing and
      // session-token branches so that a presented certificate is never ignored in favour
      // of a weaker credential that happens to also be present.
      const certificateSession = await establishCertificateSession(
        { prisma, kv, config: configOf(), log },
        { socket, robotId, auth, now: new Date() },
      );

      if (!certificateSession.ok) {
        log.warn("Agent session refused by §23.2", {
          robotId,
          socketId: socket.id,
          refusal: certificateSession.refusal,
          detail: certificateSession.detail,
        });
        return socket.disconnect(true);
      }

      if (certificateSession.mode === "MTLS") {
        // The `session:` namespace is retained and its *contents* replaced: it held a
        // bearer token that was on its own sufficient to authenticate, and now holds a
        // binding that is meaningless without the certificate whose fingerprint it names.
        // Reusing the namespace rather than minting a second one means a deployment
        // cannot end up with both schemes alive at once.
        await kv.set(sessionBinding.sessionKey(robotId), JSON.stringify(certificateSession.binding), {
          ex: Math.max(1, Math.round((certificateSession.binding.expiresAtMs - certificateSession.binding.establishedAtMs) / 1000)) || 86400,
        });
        socket.data.certificateBinding = certificateSession.binding;
      }

      const [storedSession, storedCode] = certificateSession.mode === "MTLS"
        ? [null, null]
        : await Promise.all([kv.get(`session:${robotId}`), kv.get(`pairing:${robotId}`)]);

      // PHASE 14 remediation (P14-R8) — the `session:` namespace holds two different
      // kinds of thing, and only one of them is a credential.
      //
      // §23.2's binding replaced the bearer token *in the same key*, on the argument that
      // reusing the namespace stops a deployment running both schemes at once. What it
      // actually produced was a type confusion: an agent that established an mTLS session
      // wrote a JSON binding into `session:{agentId}`, and this legacy branch then
      // compared that JSON **as a shared secret** against a caller-supplied `token`. The
      // binding is not a secret — it names a certificate fingerprint, which is public —
      // so anyone who learned it could authenticate as that agent without a certificate,
      // by presenting it as a token, whenever `AGENT_MTLS_REQUIRED` was false.
      //
      // A stored value that is a binding is therefore refused as a token rather than
      // compared. The agent falls through to the pairing branch, which is the correct
      // answer for a certificate-bound agent that has connected without its certificate.
      const sessionToken = isCertificateBinding(storedSession) ? null : storedSession;
      if (sessionToken === null && storedSession !== null && storedSession !== undefined) {
        log.warn("Stored session value is a certificate binding, not a bearer token — refused as a credential (§23.2)", {
          robotId,
          socketId: socket.id,
        });
      }

      let nextToken = null;

      // An mTLS session is authenticated by the certificate and skips both weaker
      // branches entirely — §23.2's "a session cannot act for another agent" is the
      // binding's property, and re-deriving it from a bearer token would reintroduce the
      // credential the binding replaces.
      if (certificateSession.mode === "MTLS") {
        // Nothing to do: the binding above is the authentication.
      } else if (sessionToken && token && token === sessionToken) {
        // Reconnect path: valid existing session token.
        nextToken = sessionToken;
        // Refresh TTL on successful reconnect
        await kv.set(`session:${robotId}`, nextToken, { ex: 86400 });
      } else {
        // PHASE 14 — §23.2: "Pairing and commissioning are privileged control-plane
        // operations." Where mTLS is required, pairing is a commissioning bootstrap and
        // nothing else, so a steady-state connection reaching this branch is refused **by
        // name** rather than by falling through to a code comparison. A bootstrap path
        // that silently still authenticates is not a bootstrap path; it is a second
        // authentication scheme nobody is monitoring.
        if (mtlsRequired()) {
          log.warn("Pairing refused — AGENT_MTLS_REQUIRED is set and pairing is a commissioning bootstrap only (§23.2)", {
            robotId,
            socketId: socket.id,
          });
          return socket.disconnect(true);
        }

        // Brute-force lockout (F32): reject immediately, before comparing codes,
        // regardless of which socket is attempting.
        if (await isPairingLocked(robotId)) {
          log.warn("Pairing rejected — robot locked out after repeated failed attempts", {
            robotId,
            socketId: socket.id,
          });
          return socket.disconnect(true);
        }

        // Fallback: pairing check
        if (!storedCode || !pairingCode || storedCode !== pairingCode) {
          const attempts = await recordPairingAttempt(robotId);
          if (attempts >= PAIRING_LOCKOUT_THRESHOLD) {
            log.warn("Pairing brute-force limit hit — robot locked out", { robotId, socketId: socket.id, attempts });
          }
          return socket.disconnect(true);
        }
        // After first successful pairing, mint a session token.
        nextToken = crypto.randomUUID();
        await kv.set(`session:${robotId}`, nextToken, { ex: 86400 });
      }

      // Replace old connection (auto-reconnect safe).
      const previous = getRobotSocket(robotId);
      setRobotSocket(robotId, socket);
      socket.data.robotId = robotId;
      socket.data.isAuthed = true;

      // PHASE 15 remediation (D-6) — resolve this agent's authoritative shard identity
      // **once**, here, and cache it on the socket.
      //
      // Every engine-facing decision this session goes on to make asks "is the engine the
      // decision path for *this shard*", and §22.4 stages that answer per shard. Resolving
      // it per event would put two indexed queries on the telemetry hot path; resolving it
      // never — which is what the code did before — made the staged rollout mean nothing on
      // the agent-facing side. AUTH is the right place: it is once per session, it already
      // performs several durable reads, and a migration invalidates the session anyway
      // (§19.2 advances the authority epoch, so the agent must re-AUTH to adopt it).
      //
      // A failure to resolve is **not** fatal to the connection: an agent that has never
      // been placed in a shard (§3.5's commissioned-but-unplaced state) still authenticates,
      // still sends telemetry, and is still refused every engine write path — which is the
      // correct disposition for an agent no shard owns.
      try {
        agentGate.bind(socket, await agentGate.resolveIdentity(prisma, robotId, Date.now()));
      } catch (e) {
        agentGate.bind(socket, null);
        log.warn?.("shard identity could not be resolved at AUTH — engine paths refused for this session (§3.5)", {
          robotId,
          message: e?.message,
        });
      }

      // Bind socket -> robot mapping for best-effort cleanup.
      await kv.set(`socket:${socket.id}`, robotId, { ex: 3600 });

      await markRobotOnline(prisma, robotId, socket.id);

      // After DB state is updated to the new socketId, it's safe to disconnect the previous socket.
      if (previous && previous.id !== socket.id) {
        disconnectSocket(previous);
      }

      // delete pairing after success (if any)
      if (storedCode) {
        await kv.del(`pairing:${robotId}`);
        await clearPairingAttempts(robotId);
      }

      // PHASE 4 — §11.5's deduplication handshake, before AUTH_SUCCESS.
      //
      // Before, because §11.5's third path *suppresses redelivery* and advances the
      // agent's authority epoch, and an agent told "you are authenticated" before that
      // has landed could begin acting on state the server is about to invalidate. The
      // handshake result rides on AUTH_SUCCESS so the agent adopts the new epoch and
      // fence floor in the same message that admits it.
      const dedupOutcome = await runDedupHandshake(
        prisma,
        robotId,
        auth.dedupState,
        log,
        agentGate.assess({ socket, snapshot: configOf(), nowMs: Date.now() }),
      );

      // PHASE 14 — the session's own description travels with the admission. An agent
      // must be able to tell which scheme authenticated it: a device that believes it is
      // certificate-bound while the server admitted it on a pairing code is a device
      // whose operator cannot answer a security question about it.
      const sessionDescriptor =
        certificateSession.mode === "MTLS"
          ? {
              mode: "MTLS",
              sessionId: certificateSession.binding.sessionId,
              fingerprint: certificateSession.binding.fingerprint,
              keyStorage: certificateSession.binding.keyStorage,
              expiresAt: certificateSession.binding.expiresAtMs ? new Date(certificateSession.binding.expiresAtMs).toISOString() : null,
            }
          : { mode: "LEGACY", sessionId: socket.id, fingerprint: null, keyStorage: null, expiresAt: null };

      socket.emit("AUTH_SUCCESS", { robotId, token: nextToken, dedup: dedupOutcome, session: sessionDescriptor });
      // Backward compatible alias
      socket.emit("AUTH_OK", { robotId, token: nextToken, dedup: dedupOutcome, session: sessionDescriptor });
      // Dashboard-only UI event — scoped to the room instead of every socket.
      io.to("dashboard").emit("robot_online", { robotId });

      // DTARO: join dedicated robot room for targeted commands
      socket.join(`robot:${robotId}`);

      // DTARO: update registry with online + auth state
      await markOnline(kv, robotId, socket);

      // Join the live-robot index. This is the ONLY place a robot enters it as
      // a consequence of actually being connected — commissioning and task
      // recovery also add members, but a robot that authenticates by any other
      // route (a real unit reconnecting, a fleet re-added after a Redis flush)
      // was previously absent from the set for its entire session. That made
      // /health's online count wrong and, more seriously, made
      // alertDissemination's obstacle fan-out skip the robot entirely — so a
      // robot driving straight at an obstacle was never rerouted.
      try {
        if (typeof kv.sadd === "function") await kv.sadd("robots:all", robotId);
      } catch { /* index membership is best-effort */ }

      // DTARO: assign robot to zone based on last known position
      try {
        const liveState = await getRobotState(kv, robotId);
        const lat = typeof liveState?.lat === "number" ? liveState.lat : null;
        const lon = typeof liveState?.lon === "number" ? liveState.lon : null;
        if (lat !== null && lon !== null) {
          await assignRobotToZone(prisma, kv, io, robotId, lat, lon, socket, liveState?.zoneId || null);
        }
      } catch {
        // zone assignment is non-critical — never block auth
      }

      log.info("Robot AUTH success", {
        robotId,
        socketId: socket.id,
        mode: sessionToken && token === sessionToken ? "session" : "pairing",
      });
    } catch (e) {
      log.error("AUTH handler failed", e);
      try {
        socket.disconnect(true);
      } catch {
        // ignore
      }
    }
  });

  // Heartbeat is lightweight: the live liveness signal goes to Redis on every
  // beat, while the durable `Robot.lastSeenAt` mirror is throttled to
  // DB_FLUSH_INTERVAL_MS. The offline sweep (socket.server.js) reads the Redis
  // signal first and only falls back to the throttled DB column, so detection
  // stays accurate without a write per beat — see config/liveness.constants.js
  // for the flush-interval/cutoff invariant this relies on.
  async function handleHeartbeat(eventName, payload) {
    try {
      if (!allow(socket, eventName, { limit: 10, windowMs: 5_000, minIntervalMs: 100 })) return;
      const robotId = toStringOrNull(socket.data.robotId);
      if (!robotId) return;

      const nowMs = Date.now();

      // PHASE 14 — §23.2's periodic revocation check and session rekey. Rides the
      // heartbeat because the heartbeat is the one event that proves the socket is alive;
      // it is a no-op for a legacy session, which holds no binding.
      if (socket.data.certificateBinding) {
        maybeRekeySession().catch((e) => log.warn?.("session revocation check failed", { message: e?.message }));
      }

      // Live signal — every beat, Redis only.
      // §12.2 — a heartbeat naming the agent's commitment and fence renews that commitment's
      // lease (engine path only). Not awaited on the liveness path, and its failure is only
      // logged: a missed renewal is retried by the next beat, well inside the lease.
      if (payload && typeof payload === "object" && typeof payload.commitmentId === "string") {
        const snapshot = appLocals && appLocals.config ? appLocals.config : null;
        if (agentGate.mayAct({ socket, snapshot, nowMs })) {
          commitmentLeaseRenewal
            .renewFromHeartbeat({ prisma, robotId, evidence: payload, snapshot })
            .then((outcome) => {
              // NOT_DUE is the routine answer for most beats; anything else is worth a line.
              if (outcome && outcome.reason !== "NOT_DUE") log.info?.("commitment lease renewal", { robotId, ...outcome });
            })
            .catch((e) => log.warn?.("commitment lease renewal failed", { robotId, message: e?.message }));
        }
      }

      try {
        await setRobotState(kv, robotId, { lastHeartbeat: nowMs, connected: true });
      } catch {
        // non-critical — the throttled DB write below is the durable fallback
      }

      const lastFlush = lastHeartbeatDbFlushAt.get(robotId) || 0;
      if (nowMs - lastFlush < DB_FLUSH_INTERVAL_MS) return;

      // Record the flush time before awaiting so concurrent beats for the same
      // robot can't both slip past the gate while the write is in flight.
      lastHeartbeatDbFlushAt.set(robotId, nowMs);

      // Opportunistic cleanup so decommissioned robots don't accumulate
      // forever (same pattern as sockets/rateLimit.js).
      if (lastHeartbeatDbFlushAt.size > 50_000) {
        for (const [id, ts] of lastHeartbeatDbFlushAt) {
          if (nowMs - ts > DB_FLUSH_INTERVAL_MS * 10) lastHeartbeatDbFlushAt.delete(id);
        }
      }

      await prisma.robot.update({ where: { robotId }, data: { lastSeenAt: new Date(nowMs) } });

      // PHASE 15 remediation (D-6) — refresh the cached shard identity on the same
      // throttle as the durable liveness mirror.
      //
      // The *primary* mechanism that keeps this binding honest is invalidation: a migration
      // advances the agent's authority epoch and the composition root disconnects the
      // session, so the identity is re-resolved on reconnect. This is the backstop for a
      // session that outlives its invalidation, and it rides the throttle that already
      // exists rather than adding a cadence of its own — one extra indexed read per agent
      // per `legacy.liveness.db_flush_interval_ms`, against a freshness bound of twice that
      // (`agentGate.DEFAULT_MAX_AGE_MS`), so one missed refresh does not sever a healthy
      // session while two do.
      try {
        agentGate.bind(socket, await agentGate.resolveIdentity(prisma, robotId, Date.now()));
      } catch {
        // Leave the previous binding in place: it carries its own `resolvedAtMs` and
        // `assess()` refuses it once it passes the freshness bound. Dropping it here would
        // convert a transient store blip into an immediate engine outage for this agent,
        // and re-resolving it is exactly what the next beat does.
      }
    } catch {
      // ignore
    }
  }

  // P2B-2 — the answer to a server-initiated PROBE (`services/agentProbe.service.js`), the
  // round trip §7.5 F14 requires. Recorded only for an outstanding probe on this socket.
  socket.on(agentProbe.RESULT_EVENT, async (payload) => {
    try {
      if (!allow(socket, agentProbe.RESULT_EVENT, { limit: 30, windowMs: 60_000, minIntervalMs: 50 })) return;
      const recorded = await agentProbe.recordProbeResult({ kv, socket, payload, nowMs: Date.now() });
      if (recorded.outcome !== agentProbe.OUTCOME.RECORDED) {
        log.debug?.("PROBE_RESULT not recorded", { robotId: recorded.robotId, outcome: recorded.outcome });
      }
    } catch (e) {
      log.warn?.("PROBE_RESULT handler failed", { message: e?.message });
    }
  });

  socket.on("HEARTBEAT", (payload) => handleHeartbeat("HEARTBEAT", payload));
  // Backward compatible alias.
  socket.on("heartbeat", (payload) => handleHeartbeat("heartbeat", payload));

  // ── PHASE 14 — §23.2: `SESSION_REKEY` becomes operational ──────────────────
  //
  // The command has existed in §10.3.1's agent-scope table since Phase 3 and `VirtualRobot`
  // has accepted it since Phase 4, but nothing issued one. Two triggers do now, and both
  // are conditions the *server* observes:
  //
  //   1. The binding has passed `security.session_max_age`.
  //   2. The periodic revocation re-check is due and the certificate still passes — a
  //      rekey is the cheapest way to refresh a binding whose evidence has been renewed.
  //
  // It rides on the heartbeat rather than a timer: the heartbeat is the one event that
  // proves the socket is alive, and issuing a rekey to a socket that has silently died
  // would rotate a binding nothing will ever acknowledge.
  //
  // The command envelope is built and signed by the dispatch layer (`dispatch/offers.js`
  // for the mission scope, `shard/membership.js` for the agent scope); what this handler
  // owns is *when* a rekey is warranted and what the new binding becomes once the agent
  // acknowledges. Splitting it that way is what keeps one envelope shape in the system.
  async function maybeRekeySession() {
    const binding = socket.data.certificateBinding;
    if (!binding) return;

    const now = new Date();
    const expired = Number.isFinite(binding.expiresAtMs) && binding.expiresAtMs !== null && now.getTime() >= binding.expiresAtMs;
    if (!expired && !sessionBinding.dueForRecheck(binding, now)) return;

    // PHASE 14 remediation (P14-R9) — §23.2's "a session cannot act for another agent",
    // checked where the binding is *used* and not only where it was established.
    //
    // `sessionBinding.assertBound()` is the module's own answer to "may this socket speak
    // for this agent id", and its header says it is "checked on every command delivery,
    // not only at establishment". Until this remediation it had no production caller at
    // all: the guard was written, tested, and never run. The socket carries the agent id,
    // so the three-way comparison is a defence-in-depth check rather than the only thing
    // standing between an attacker and another agent's session — but a guard nothing
    // calls is a guard nobody will notice has stopped working.
    // `now` is deliberately **not** passed. `assertBound()` would otherwise refuse an
    // expired session, and an expired session is precisely the case this function exists
    // to *rekey* rather than to drop — trigger 1 above. What is checked here is the
    // three-component identity, which is what "cannot act for another agent" means.
    const bound = sessionBinding.assertBound(binding, {
      agentId: socket.data.robotId,
      sessionId: binding.sessionId,
      fingerprint: binding.fingerprint,
    });
    if (!bound.ok) {
      log.warn("Agent session binding no longer holds — session terminated (§23.2)", {
        robotId: socket.data.robotId,
        refusal: bound.refusal,
      });
      try { await kv.del(sessionBinding.sessionKey(socket.data.robotId)); } catch { /* best effort */ }
      socket.disconnect(true);
      return;
    }

    const config = configOf();
    const rechecked = await sessionBinding.recheck({ prisma }, binding, {
      now,
      recheckIntervalSeconds: configNumber(config, "security.certificate_revocation_recheck_interval"),
    });

    if (rechecked.action === "TERMINATE") {
      // §23.2's periodic half, at the moment it bites. A revoked certificate inside a
      // live session ends the session; it does not wait for the next reconnect.
      log.warn("Agent session terminated by periodic revocation check (§23.2)", {
        robotId: socket.data.robotId,
        refusal: rechecked.refusal,
      });
      try { await kv.del(sessionBinding.sessionKey(socket.data.robotId)); } catch { /* best effort */ }
      socket.disconnect(true);
      return;
    }

    socket.data.certificateBinding = rechecked.binding;

    if (!expired) {
      // The certificate is still good and the check window has simply rolled over. Persist
      // the refreshed binding and say nothing to the agent: a rekey the agent did not need
      // is an authority-epoch churn nobody asked for.
      try {
        await kv.set(sessionBinding.sessionKey(socket.data.robotId), JSON.stringify(rechecked.binding), { ex: 86400 });
      } catch { /* the DB remains authoritative for the certificate */ }
      return;
    }

    socket.emit("SESSION_REKEY", sessionBinding.rekeyCommandPayload({
      sessionId: socket.id,
      reason: "SESSION_MAX_AGE",
      notValidAfter: new Date(now.getTime() + REKEY_VALIDITY_MS),
    }));
  }

  socket.on("SESSION_REKEY_ACK", async (payload) => {
    try {
      if (!allow(socket, "SESSION_REKEY_ACK", { limit: 10, windowMs: 60_000, minIntervalMs: 100 })) return;
      const binding = socket.data.certificateBinding;
      if (!binding) return;

      const config = configOf();
      const rotated = await sessionBinding.rekey({ prisma }, binding, {
        // The agent proposes a session id; the **agent id is not a parameter**, so a rekey
        // cannot change which agent this session speaks for. That would be a privilege
        // escalation wearing the name of a maintenance operation.
        sessionId: toStringOrNull(payload?.sessionId) || socket.id,
        now: new Date(),
        recheckIntervalSeconds: configNumber(config, "security.certificate_revocation_recheck_interval"),
        sessionMaxAgeSeconds: configNumber(config, "security.session_max_age"),
      });

      if (!rotated.ok) {
        log.warn("SESSION_REKEY refused", { robotId: socket.data.robotId, refusal: rotated.refusal });
        socket.disconnect(true);
        return;
      }

      socket.data.certificateBinding = rotated.binding;
      await kv.set(sessionBinding.sessionKey(socket.data.robotId), JSON.stringify(rotated.binding), { ex: 86400 });
      log.info("Agent session rekeyed", { robotId: socket.data.robotId, sessionId: rotated.binding.sessionId });
    } catch (e) {
      log.error?.("SESSION_REKEY_ACK failed", { message: e?.message });
    }
  });

  socket.on("disconnect", () => {
    // Best-effort: mark offline only if this socket is still the active one.
    (async () => {
      try {
        const boundRobotId = toStringOrNull(socket.data.robotId) || (await kv.get(`socket:${socket.id}`));
        if (!boundRobotId) return;

        await kv.del(`socket:${socket.id}`);

        // If DB already points to a different socket, a newer connection replaced this one.
        const dbRow = await prisma.robot.findUnique({
          where: { robotId: boundRobotId },
          select: { socketId: true },
        });
        if (dbRow && dbRow.socketId && dbRow.socketId !== socket.id) return;

        // Extra safety: ignore stale sockets that are no longer current.
        const current = getRobotSocket(boundRobotId);
        if (current && current.id !== socket.id) return;

        deleteRobotSocket(boundRobotId, socket);

        await markRobotOffline(prisma, boundRobotId);
        // DTARO: update registry offline state
        await markOffline(kv, boundRobotId);

        // Leave the live-robot index. Previously members were only ever
        // removed on decommission, so the set monotonically over-counted and
        // obstacle dissemination kept fanning out to long-gone robots.
        try {
          if (typeof kv.srem === "function") await kv.srem("robots:all", boundRobotId);
        } catch { /* index membership is best-effort */ }
        // Dashboard-only UI event — scoped to the room instead of every socket.
        io.to("dashboard").emit("robot_offline", { robotId: boundRobotId });
      } catch {
        // ignore
      }
    })();

    log.info("Socket disconnected", { socketId: socket.id });
  });
}

module.exports = {
  registerRobotHandlers,
  // Exported for the LF-1 tests (P1.4); AUTH and disconnect remain their only callers.
  markRobotOnline,
  markRobotOffline,
};

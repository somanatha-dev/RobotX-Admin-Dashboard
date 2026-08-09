"use strict";

/**
 * Agent authentication: mTLS, per-device certificates, and the session binding
 * (§23.2) — **Tier 1**.
 *
 * > Mutual TLS with per-device certificates, private keys in a secure element where the
 * > hardware provides one, automated rotation, and revocation checked at session
 * > establishment **and** periodically during long sessions.
 *
 * > Session establishment binds `(agent_id, certificate, session_id)`; a session cannot
 * > act for another agent. It additionally carries the agent's **deduplication
 * > high-water mark and `dedup_state_generation`** (§11.5), which the server evaluates
 * > before delivering any command. The handshake is authenticated by the same
 * > certificate, so a reported state reset cannot be forged by a third party to force an
 * > `authority_epoch` advance.
 *
 * ── What this module owns, and what it deliberately does not ────────────────
 * It owns the *decision*: given a presented certificate, an agent id, and the store's
 * record of that certificate, may this session exist, for whom, and until when. It is a
 * pure function of its inputs plus two small store reads, which is what makes the rule
 * testable without a TLS listener.
 *
 * It does **not** terminate TLS. Termination is `server.js`'s (and, in a real
 * deployment, the load balancer's) job; what arrives here is the peer certificate the
 * terminator already validated against the CA chain. The split matters because the two
 * failure modes are different: a chain that does not validate is a connection that never
 * reaches the application, while a chain that validates and a certificate that has been
 * *revoked* is a connection that must be refused **here**, by consulting the store.
 * A deployment that terminates TLS at a proxy and forgets to forward the client
 * certificate would otherwise silently authenticate nobody, so `establish()` refuses an
 * absent certificate rather than treating it as "not using mTLS".
 *
 * ── The three failures this is written against ──────────────────────────────
 *   1. **A session acting for another agent.** The binding is checked on every command
 *      delivery, not only at establishment: `assertBound()` is the one function that
 *      answers "may this socket speak for this agent id", and it compares all three
 *      components. §23.1's spoofed-identity row is the threat.
 *   2. **A revoked certificate surviving inside a long session.** A revocation checked
 *      only at establishment is a revocation that does not take effect until the agent
 *      next reconnects — which, for a unit that stays connected for weeks, is never.
 *      `dueForRecheck()` and `recheck()` are the periodic half §23.2 requires, and the
 *      worker that drives them is `workers/certificateRotation.worker.js`.
 *   3. **A forged state reset.** §11.5's generation advance is a *write* triggered by an
 *      agent's own report. Binding the handshake to the certificate is what stops a
 *      third party forcing one; `establish()` therefore returns the binding that
 *      `robot.handler.js` requires **before** it runs the dedup handshake, not after.
 *
 * ── Where the session lives ─────────────────────────────────────────────────
 * The binding is live state and lives in the cache (`session:{agentId}`), replacing the
 * bearer token that key held before. The **certificate** — its status, its revocation,
 * its rotation lineage — is durable and lives in `AgentCertificate`. That split is
 * §3.3's cache-authority rule applied to authentication: a cache miss costs a store read
 * and never a wrong answer, and a cache that claimed a revoked certificate was live
 * would be a cache promoted to an authority.
 */

const crypto = require("crypto");

/**
 * §23.2 — "private keys in a secure element where the hardware provides one".
 *
 * Recorded per certificate rather than assumed per fleet, because a mixed fleet is the
 * normal case and "where the hardware provides one" is a per-device fact. `UNKNOWN` is a
 * distinct value from `SOFTWARE`: a device that has not reported its key storage is not
 * the same as one that has reported software storage, and treating the first as the
 * second would over-report a security posture nobody measured.
 * @structural the key-storage classes
 */
const KEY_STORAGE = Object.freeze({
  SECURE_ELEMENT: "SECURE_ELEMENT",
  SOFTWARE: "SOFTWARE",
  UNKNOWN: "UNKNOWN",
});

const KEY_STORAGES = Object.freeze(Object.values(KEY_STORAGE));

/** The lifecycle of a per-device certificate. @structural the certificate states */
const CERTIFICATE_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  /** Rotated out by a successor; still valid for its remaining overlap window. */
  SUPERSEDED: "SUPERSEDED",
  /** Withdrawn. Never accepted again, whatever its validity window says. */
  REVOKED: "REVOKED",
});

const CERTIFICATE_STATUSES = Object.freeze(Object.values(CERTIFICATE_STATUS));

/**
 * Every reason a session may be refused. Enumerated so the refusal is countable by
 * reason: §23.3's "every rejection is reported and counted, by scope" is the same
 * discipline one layer down, and a single `false` would make an operational spike in
 * expired certificates indistinguishable from an attack.
 * @structural the refusal vocabulary
 */
const REFUSAL = Object.freeze({
  NO_CERTIFICATE: "NO_CERTIFICATE",
  UNKNOWN_CERTIFICATE: "UNKNOWN_CERTIFICATE",
  CERTIFICATE_REVOKED: "CERTIFICATE_REVOKED",
  CERTIFICATE_EXPIRED: "CERTIFICATE_EXPIRED",
  CERTIFICATE_NOT_YET_VALID: "CERTIFICATE_NOT_YET_VALID",
  /** The certificate is genuine and belongs to a different agent. */
  CERTIFICATE_AGENT_MISMATCH: "CERTIFICATE_AGENT_MISMATCH",
  SESSION_AGENT_MISMATCH: "SESSION_AGENT_MISMATCH",
  SESSION_FINGERPRINT_MISMATCH: "SESSION_FINGERPRINT_MISMATCH",
  SESSION_EXPIRED: "SESSION_EXPIRED",
});

/**
 * The certificate fingerprint: SHA-256 over the DER encoding.
 *
 * The fingerprint, never the PEM, is what the binding and the store compare. A PEM
 * string comparison would be defeated by re-wrapping the same certificate at a different
 * line length, and would put a public key in every log line that reports a mismatch.
 *
 * @param {string|Buffer|{ raw?: Buffer, fingerprint256?: string }} certificate a PEM
 *   string, a DER buffer, or Node's `TLSSocket#getPeerCertificate()` object
 * @returns {string|null} lower-case hex, or null when nothing was presented
 */
function fingerprint(certificate) {
  if (!certificate) return null;

  if (typeof certificate === "object" && !Buffer.isBuffer(certificate)) {
    if (Buffer.isBuffer(certificate.raw)) {
      return crypto.createHash("sha256").update(certificate.raw).digest("hex");
    }
    if (typeof certificate.fingerprint256 === "string" && certificate.fingerprint256 !== "") {
      return certificate.fingerprint256.replace(/:/g, "").toLowerCase();
    }
    return null;
  }

  const der = Buffer.isBuffer(certificate) ? certificate : pemToDer(String(certificate));
  if (!der) return null;
  return crypto.createHash("sha256").update(der).digest("hex");
}

/**
 * Decode a PEM certificate body to DER.
 *
 * @param {string} pem
 * @returns {Buffer|null}
 */
function pemToDer(pem) {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  if (!match) return null;
  return Buffer.from(match[1].replace(/\s+/g, ""), "base64");
}

/**
 * Assess a stored certificate against the clock and its own status.
 *
 * Order matters and is deliberate: **revocation is checked before expiry**. A revoked
 * certificate that has also expired must report `CERTIFICATE_REVOKED`, because the two
 * have different operational meanings — one is a routine rotation the fleet handles
 * itself, the other is a device somebody withdrew, and reporting the second as the first
 * would bury a security event inside a maintenance metric.
 *
 * @param {object|null} row an `AgentCertificate` row
 * @param {object} context `{ now, agentId }`
 * @returns {{ ok: boolean, refusal: string|null, detail: string|null }}
 */
function assessCertificate(row, context) {
  const settings = context || {};
  const now = settings.now instanceof Date ? settings.now : new Date();

  if (!row) {
    return {
      ok: false,
      refusal: REFUSAL.UNKNOWN_CERTIFICATE,
      detail: "no commissioned certificate matches this fingerprint; a certificate the fleet does not know is not an identity (§23.2)",
    };
  }
  if (row.status === CERTIFICATE_STATUS.REVOKED) {
    return { ok: false, refusal: REFUSAL.CERTIFICATE_REVOKED, detail: row.revocationReason || "the certificate is revoked" };
  }
  if (settings.agentId !== undefined && settings.agentId !== null && String(row.agentId) !== String(settings.agentId)) {
    return {
      ok: false,
      refusal: REFUSAL.CERTIFICATE_AGENT_MISMATCH,
      detail: "this certificate belongs to another agent; a session cannot act for an agent it does not hold the key of (§23.2)",
    };
  }
  if (row.notBefore instanceof Date && now.getTime() < row.notBefore.getTime()) {
    return { ok: false, refusal: REFUSAL.CERTIFICATE_NOT_YET_VALID, detail: `valid from ${row.notBefore.toISOString()}` };
  }
  if (row.notAfter instanceof Date && now.getTime() >= row.notAfter.getTime()) {
    return { ok: false, refusal: REFUSAL.CERTIFICATE_EXPIRED, detail: `expired at ${row.notAfter.toISOString()}` };
  }

  return { ok: true, refusal: null, detail: null };
}

/**
 * Establish a session: the `(agent_id, certificate, session_id)` binding of §23.2.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input
 * @param {string} input.agentId the id the connecting party claims
 * @param {*} input.certificate the peer certificate the TLS terminator validated
 * @param {string} input.sessionId
 * @param {Date} input.now
 * @param {number} input.recheckIntervalSeconds `security.certificate_revocation_recheck_interval`
 * @param {number} [input.sessionMaxAgeSeconds] `security.session_max_age`
 * @returns {Promise<{ ok: boolean, refusal: string|null, detail: string|null, binding: object|null }>}
 */
async function establish(deps, input) {
  const source = input || {};
  const now = source.now instanceof Date ? source.now : new Date();
  const print = fingerprint(source.certificate);

  if (!print) {
    return {
      ok: false,
      refusal: REFUSAL.NO_CERTIFICATE,
      detail:
        "no client certificate was presented. §23.2 requires mutual TLS with per-device certificates; an absent " +
        "certificate is refused rather than treated as 'not using mTLS', because a proxy that terminates TLS and " +
        "forgets to forward the peer certificate would otherwise authenticate nobody and report success.",
      binding: null,
    };
  }

  const row = await deps.prisma.agentCertificate.findUnique({ where: { fingerprint: print } });
  const assessment = assessCertificate(row, { now, agentId: source.agentId });
  if (!assessment.ok) {
    return { ...assessment, binding: null };
  }

  return {
    ok: true,
    refusal: null,
    detail: null,
    binding: {
      agentId: String(source.agentId),
      fingerprint: print,
      sessionId: String(source.sessionId),
      certificateId: row.id,
      keyStorage: row.keyStorage || KEY_STORAGE.UNKNOWN,
      establishedAtMs: now.getTime(),
      lastRevocationCheckAtMs: now.getTime(),
      nextRevocationCheckAtMs: now.getTime() + toMillis(source.recheckIntervalSeconds),
      expiresAtMs: source.sessionMaxAgeSeconds ? now.getTime() + toMillis(source.sessionMaxAgeSeconds) : null,
    },
  };
}

/**
 * Seconds → milliseconds, tolerating an unset value.
 *
 * @param {number|undefined|null} seconds
 * @returns {number}
 */
function toMillis(seconds) {
  /** @structural milliseconds per second */
  const MS_PER_SECOND = 1000;
  return Number.isFinite(seconds) ? Number(seconds) * MS_PER_SECOND : 0;
}

/**
 * May this session act for this agent id?
 *
 * All three components are compared. Two would be enough to catch an accident; three is
 * what catches the attack, because the interesting case is a *genuine* session for
 * agent A being replayed to issue an instruction about agent B.
 *
 * @param {object|null} binding
 * @param {object} claim `{ agentId, sessionId, fingerprint, now }`
 * @returns {{ ok: boolean, refusal: string|null }}
 */
function assertBound(binding, claim) {
  const settings = claim || {};
  if (!binding) return { ok: false, refusal: REFUSAL.NO_CERTIFICATE };

  if (String(binding.agentId) !== String(settings.agentId)) {
    return { ok: false, refusal: REFUSAL.SESSION_AGENT_MISMATCH };
  }
  if (settings.sessionId !== undefined && String(binding.sessionId) !== String(settings.sessionId)) {
    return { ok: false, refusal: REFUSAL.SESSION_AGENT_MISMATCH };
  }
  if (settings.fingerprint !== undefined && settings.fingerprint !== null && binding.fingerprint !== settings.fingerprint) {
    return { ok: false, refusal: REFUSAL.SESSION_FINGERPRINT_MISMATCH };
  }
  const now = settings.now instanceof Date ? settings.now.getTime() : Number(settings.now);
  if (Number.isFinite(now) && Number.isFinite(binding.expiresAtMs) && binding.expiresAtMs !== null && now >= binding.expiresAtMs) {
    return { ok: false, refusal: REFUSAL.SESSION_EXPIRED };
  }

  return { ok: true, refusal: null };
}

/**
 * Is this session due its periodic revocation check?
 *
 * @param {object} binding
 * @param {Date|number} now
 * @returns {boolean}
 */
function dueForRecheck(binding, now) {
  if (!binding) return false;
  const at = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(at)) return false;
  return !Number.isFinite(binding.nextRevocationCheckAtMs) || at >= binding.nextRevocationCheckAtMs;
}

/**
 * Re-check a live session's certificate against the store — §23.2's "and periodically
 * during long sessions".
 *
 * Returns the *action*, never performs it: the caller owns the socket and is the only
 * thing that can close it. Separating the verdict from the disconnection is what lets
 * the rule be tested without a socket, and what lets the worker apply the same verdict
 * across a fleet.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} binding
 * @param {object} input `{ now, recheckIntervalSeconds }`
 * @returns {Promise<{ ok: boolean, refusal: string|null, action: "KEEP"|"TERMINATE", binding: object }>}
 */
async function recheck(deps, binding, input) {
  const source = input || {};
  const now = source.now instanceof Date ? source.now : new Date();

  const row = await deps.prisma.agentCertificate.findUnique({ where: { fingerprint: binding.fingerprint } });
  const assessment = assessCertificate(row, { now, agentId: binding.agentId });

  if (!assessment.ok) {
    return { ok: false, refusal: assessment.refusal, action: "TERMINATE", binding };
  }

  return {
    ok: true,
    refusal: null,
    action: "KEEP",
    binding: {
      ...binding,
      lastRevocationCheckAtMs: now.getTime(),
      nextRevocationCheckAtMs: now.getTime() + toMillis(source.recheckIntervalSeconds),
    },
  };
}

/**
 * Rotate a session onto a new session id — the payload half of the `SESSION_REKEY`
 * agent command (§10.3.1).
 *
 * The agent id is **not** a parameter. A rekey that could change which agent a session
 * speaks for would be a privilege escalation wearing the name of a maintenance
 * operation, so the new binding inherits the agent id from the old one and the
 * certificate is re-assessed rather than assumed.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} binding the current binding
 * @param {object} input `{ sessionId, certificate, now, recheckIntervalSeconds, sessionMaxAgeSeconds }`
 * @returns {Promise<{ ok: boolean, refusal: string|null, binding: object|null }>}
 */
async function rekey(deps, binding, input) {
  const source = input || {};
  if (!binding) return { ok: false, refusal: REFUSAL.NO_CERTIFICATE, binding: null };

  const presented = source.certificate === undefined ? null : source.certificate;
  const nextFingerprint = presented === null ? binding.fingerprint : fingerprint(presented);

  const established = await establish(deps, {
    agentId: binding.agentId,
    certificate: presented === null ? { fingerprint256: binding.fingerprint } : presented,
    sessionId: source.sessionId,
    now: source.now,
    recheckIntervalSeconds: source.recheckIntervalSeconds,
    sessionMaxAgeSeconds: source.sessionMaxAgeSeconds,
  });

  if (!established.ok) return { ok: false, refusal: established.refusal, binding: null };

  return {
    ok: true,
    refusal: null,
    binding: { ...established.binding, fingerprint: nextFingerprint, rekeyedFromSessionId: binding.sessionId },
  };
}

/**
 * The `SESSION_REKEY` command payload for a binding.
 *
 * Built here and signed by the caller: this module knows what a rekey *is*, and
 * `commandSigning.js` knows how a command is bound to its addressee. Keeping the two
 * apart is what stops a second, subtly different envelope appearing.
 *
 * @param {object} input `{ sessionId, notValidAfter, reason }`
 * @returns {object}
 */
function rekeyCommandPayload(input) {
  const source = input || {};
  return {
    sessionId: String(source.sessionId),
    reason: source.reason ?? "ROTATION",
    notValidAfter: source.notValidAfter instanceof Date ? source.notValidAfter.toISOString() : source.notValidAfter ?? null,
  };
}

/**
 * The cache key a binding lives under.
 *
 * The `session:` namespace is **retained and its contents replaced**: it held a bearer
 * token that was, on its own, sufficient to authenticate; it now holds a binding that is
 * meaningless without the certificate whose fingerprint it names. Reusing the namespace
 * rather than minting a new one means a deployment cannot end up with both alive at once.
 *
 * @param {string} agentId
 * @returns {string}
 */
function sessionKey(agentId) {
  return `session:${agentId}`;
}

/**
 * Certificates approaching expiry, for the rotation worker.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ nowMs, leadTimeSeconds, take }`
 * @returns {Promise<object[]>}
 */
async function dueForRotation(deps, input) {
  const source = input || {};
  const horizon = new Date(source.nowMs + toMillis(source.leadTimeSeconds));
  return deps.prisma.agentCertificate.findMany({
    where: { status: CERTIFICATE_STATUS.ACTIVE, notAfter: { lt: horizon } },
    select: { id: true, agentId: true, fingerprint: true, notAfter: true, keyStorage: true },
    orderBy: { notAfter: "asc" },
    /** @structural a page size, not a threshold: the worker pages until the query is empty */
    take: Number.isFinite(source.take) ? source.take : 200,
  });
}

module.exports = {
  KEY_STORAGE,
  KEY_STORAGES,
  CERTIFICATE_STATUS,
  CERTIFICATE_STATUSES,
  REFUSAL,
  fingerprint,
  pemToDer,
  assessCertificate,
  establish,
  assertBound,
  dueForRecheck,
  recheck,
  rekey,
  rekeyCommandPayload,
  sessionKey,
  dueForRotation,
};

"use strict";

/**
 * Engine lane — Phase 14: mutual TLS, per-device certificates, and the session binding
 * (§23.2).
 *
 * Three properties, and each has a failure this file plants:
 *
 *   1. A session cannot act for another agent.
 *   2. A revoked certificate does not survive inside a long session.
 *   3. A rekey cannot change which agent a session speaks for.
 */

const crypto = require("crypto");

const sessionBinding = require("../../src/engine/security/sessionBinding");

const NOW = new Date("2026-08-09T12:00:00.000Z");

/** A self-signed certificate is not needed: the store keys on the fingerprint. */
const CERT_A = { raw: Buffer.from("certificate-for-agent-a") };
const CERT_B = { raw: Buffer.from("certificate-for-agent-b") };

const FINGERPRINT_A = sessionBinding.fingerprint(CERT_A);
const FINGERPRINT_B = sessionBinding.fingerprint(CERT_B);

function certificateRow(overrides) {
  return {
    id: "cert-a",
    fingerprint: FINGERPRINT_A,
    agentId: "AGT-1",
    status: sessionBinding.CERTIFICATE_STATUS.ACTIVE,
    keyStorage: sessionBinding.KEY_STORAGE.SECURE_ELEMENT,
    notBefore: new Date("2026-01-01T00:00:00.000Z"),
    notAfter: new Date("2027-01-01T00:00:00.000Z"),
    revokedAt: null,
    revocationReason: null,
    ...overrides,
  };
}

function storeOf(rows) {
  const table = rows || [certificateRow()];
  return {
    prisma: {
      agentCertificate: {
        async findUnique({ where }) {
          return table.find((row) => row.fingerprint === where.fingerprint) || null;
        },
        async findMany() {
          return table;
        },
        async updateMany() {
          return { count: table.length };
        },
      },
    },
    table,
  };
}

describe("§23.2 — the fingerprint is what is compared, never the PEM", () => {
  test("a DER buffer, a Node peer-certificate object, and a PEM all yield the same fingerprint", () => {
    const der = Buffer.from("certificate-for-agent-a");
    const pem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64")}\n-----END CERTIFICATE-----`;

    expect(sessionBinding.fingerprint(der)).toBe(FINGERPRINT_A);
    expect(sessionBinding.fingerprint({ raw: der })).toBe(FINGERPRINT_A);
    // Re-wrapping the same certificate at a different line length must not change the
    // answer — which is exactly what a PEM string comparison would get wrong.
    const rewrapped = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/(.{8})/g, "$1\n")}\n-----END CERTIFICATE-----`;
    expect(sessionBinding.fingerprint(pem)).toBe(sessionBinding.fingerprint(rewrapped));
  });

  test("a colon-separated fingerprint256 is normalised", () => {
    const digest = crypto.createHash("sha256").update("x").digest("hex");
    const colonised = digest.match(/.{2}/g).join(":").toUpperCase();
    expect(sessionBinding.fingerprint({ fingerprint256: colonised })).toBe(digest);
  });

  test("nothing presented yields null rather than a fabricated identity", () => {
    expect(sessionBinding.fingerprint(null)).toBeNull();
    expect(sessionBinding.fingerprint({})).toBeNull();
  });
});

describe("§23.2 — establishment", () => {
  test("a valid certificate binds (agent_id, certificate, session_id)", async () => {
    const { prisma } = storeOf();
    const result = await sessionBinding.establish({ prisma }, {
      agentId: "AGT-1",
      certificate: CERT_A,
      sessionId: "sock-1",
      now: NOW,
      recheckIntervalSeconds: 900,
      sessionMaxAgeSeconds: 86400,
    });

    expect(result.ok).toBe(true);
    expect(result.binding).toMatchObject({
      agentId: "AGT-1",
      fingerprint: FINGERPRINT_A,
      sessionId: "sock-1",
      keyStorage: "SECURE_ELEMENT",
    });
    expect(result.binding.nextRevocationCheckAtMs).toBe(NOW.getTime() + 900_000);
    expect(result.binding.expiresAtMs).toBe(NOW.getTime() + 86_400_000);
  });

  test("an absent certificate is refused, not treated as 'not using mTLS'", async () => {
    const { prisma } = storeOf();
    const result = await sessionBinding.establish({ prisma }, { agentId: "AGT-1", certificate: null, sessionId: "s", now: NOW });

    expect(result).toMatchObject({ ok: false, refusal: sessionBinding.REFUSAL.NO_CERTIFICATE });
    // The failure this refusal exists for: a proxy that terminates TLS and forgets to
    // forward the peer certificate would otherwise authenticate nobody and report success.
    expect(result.detail).toMatch(/forgets to forward the peer certificate/);
  });

  test("a certificate the fleet does not know is not an identity", async () => {
    const { prisma } = storeOf();
    const result = await sessionBinding.establish({ prisma }, { agentId: "AGT-1", certificate: CERT_B, sessionId: "s", now: NOW });
    expect(result.refusal).toBe(sessionBinding.REFUSAL.UNKNOWN_CERTIFICATE);
  });

  test("a genuine certificate belonging to another agent is refused", async () => {
    const { prisma } = storeOf([certificateRow({ fingerprint: FINGERPRINT_B, agentId: "AGT-2" })]);
    const result = await sessionBinding.establish({ prisma }, { agentId: "AGT-1", certificate: CERT_B, sessionId: "s", now: NOW });
    expect(result.refusal).toBe(sessionBinding.REFUSAL.CERTIFICATE_AGENT_MISMATCH);
  });

  test("revocation is reported before expiry, because the two mean different things", async () => {
    // A revoked *and* expired certificate must report REVOKED: one is a routine rotation
    // the fleet handles itself, the other is a device somebody withdrew, and reporting the
    // second as the first buries a security event inside a maintenance metric.
    const { prisma } = storeOf([
      certificateRow({ status: "REVOKED", revokedAt: new Date("2026-02-01T00:00:00Z"), notAfter: new Date("2026-03-01T00:00:00Z") }),
    ]);
    const result = await sessionBinding.establish({ prisma }, { agentId: "AGT-1", certificate: CERT_A, sessionId: "s", now: NOW });
    expect(result.refusal).toBe(sessionBinding.REFUSAL.CERTIFICATE_REVOKED);
  });

  test("an expired and a not-yet-valid certificate are distinguished", async () => {
    const expired = storeOf([certificateRow({ notAfter: new Date("2026-03-01T00:00:00Z") })]);
    const early = storeOf([certificateRow({ notBefore: new Date("2027-01-01T00:00:00Z") })]);

    expect((await sessionBinding.establish(expired, { agentId: "AGT-1", certificate: CERT_A, sessionId: "s", now: NOW })).refusal).toBe(
      sessionBinding.REFUSAL.CERTIFICATE_EXPIRED,
    );
    expect((await sessionBinding.establish(early, { agentId: "AGT-1", certificate: CERT_A, sessionId: "s", now: NOW })).refusal).toBe(
      sessionBinding.REFUSAL.CERTIFICATE_NOT_YET_VALID,
    );
  });
});

describe("§23.2 — a session cannot act for another agent", () => {
  const binding = {
    agentId: "AGT-1",
    fingerprint: FINGERPRINT_A,
    sessionId: "sock-1",
    expiresAtMs: NOW.getTime() + 3600_000,
  };

  test("all three components are compared", () => {
    expect(sessionBinding.assertBound(binding, { agentId: "AGT-1", sessionId: "sock-1", fingerprint: FINGERPRINT_A, now: NOW }).ok).toBe(true);
    // The interesting case is not an accident: it is a *genuine* session for agent A being
    // replayed to issue an instruction about agent B.
    expect(sessionBinding.assertBound(binding, { agentId: "AGT-2", sessionId: "sock-1", fingerprint: FINGERPRINT_A }).refusal).toBe(
      sessionBinding.REFUSAL.SESSION_AGENT_MISMATCH,
    );
    expect(sessionBinding.assertBound(binding, { agentId: "AGT-1", sessionId: "sock-9", fingerprint: FINGERPRINT_A }).refusal).toBe(
      sessionBinding.REFUSAL.SESSION_AGENT_MISMATCH,
    );
    expect(sessionBinding.assertBound(binding, { agentId: "AGT-1", sessionId: "sock-1", fingerprint: FINGERPRINT_B }).refusal).toBe(
      sessionBinding.REFUSAL.SESSION_FINGERPRINT_MISMATCH,
    );
  });

  test("an expired session is refused", () => {
    const later = new Date(binding.expiresAtMs + 1);
    expect(sessionBinding.assertBound(binding, { agentId: "AGT-1", now: later }).refusal).toBe(sessionBinding.REFUSAL.SESSION_EXPIRED);
  });

  test("no binding at all is refused, never admitted by default", () => {
    expect(sessionBinding.assertBound(null, { agentId: "AGT-1" })).toMatchObject({ ok: false });
  });
});

describe("§23.2 — 'and periodically during long sessions'", () => {
  const binding = {
    agentId: "AGT-1",
    fingerprint: FINGERPRINT_A,
    sessionId: "sock-1",
    nextRevocationCheckAtMs: NOW.getTime() + 900_000,
    expiresAtMs: null,
  };

  test("a session is due only once its interval has elapsed", () => {
    expect(sessionBinding.dueForRecheck(binding, NOW)).toBe(false);
    expect(sessionBinding.dueForRecheck(binding, new Date(binding.nextRevocationCheckAtMs))).toBe(true);
    // A binding with no scheduled check is due immediately — unknown is never permission.
    expect(sessionBinding.dueForRecheck({ ...binding, nextRevocationCheckAtMs: undefined }, NOW)).toBe(true);
  });

  test("a certificate revoked mid-session terminates it", async () => {
    const { prisma } = storeOf([certificateRow({ status: "REVOKED", revokedAt: NOW, revocationReason: "device stolen" })]);
    const result = await sessionBinding.recheck({ prisma }, binding, { now: NOW, recheckIntervalSeconds: 900 });

    expect(result).toMatchObject({ ok: false, action: "TERMINATE", refusal: sessionBinding.REFUSAL.CERTIFICATE_REVOKED });
  });

  test("a still-valid certificate rolls the check window forward", async () => {
    const { prisma } = storeOf();
    const at = new Date(NOW.getTime() + 900_000);
    const result = await sessionBinding.recheck({ prisma }, binding, { now: at, recheckIntervalSeconds: 900 });

    expect(result.action).toBe("KEEP");
    expect(result.binding.lastRevocationCheckAtMs).toBe(at.getTime());
    expect(result.binding.nextRevocationCheckAtMs).toBe(at.getTime() + 900_000);
  });
});

describe("§23.2 — SESSION_REKEY", () => {
  test("a rekey keeps the agent id and re-assesses the certificate", async () => {
    const { prisma } = storeOf();
    const binding = { agentId: "AGT-1", fingerprint: FINGERPRINT_A, sessionId: "sock-1", expiresAtMs: null };

    const rotated = await sessionBinding.rekey({ prisma }, binding, {
      sessionId: "sock-2",
      now: NOW,
      recheckIntervalSeconds: 900,
      sessionMaxAgeSeconds: 86400,
    });

    expect(rotated.ok).toBe(true);
    expect(rotated.binding).toMatchObject({ agentId: "AGT-1", sessionId: "sock-2", rekeyedFromSessionId: "sock-1" });
  });

  test("a rekey against a since-revoked certificate is refused", async () => {
    const { prisma } = storeOf([certificateRow({ status: "REVOKED", revokedAt: NOW })]);
    const binding = { agentId: "AGT-1", fingerprint: FINGERPRINT_A, sessionId: "sock-1", expiresAtMs: null };

    const rotated = await sessionBinding.rekey({ prisma }, binding, { sessionId: "sock-2", now: NOW });
    expect(rotated).toMatchObject({ ok: false, refusal: sessionBinding.REFUSAL.CERTIFICATE_REVOKED, binding: null });
  });

  test("the rekey payload carries its own expiry (§23.3)", () => {
    const payload = sessionBinding.rekeyCommandPayload({ sessionId: "sock-2", notValidAfter: NOW });
    expect(payload).toEqual({ sessionId: "sock-2", reason: "ROTATION", notValidAfter: NOW.toISOString() });
  });

  test("the session cache key is the retired bearer token's namespace, reused deliberately", () => {
    // Reusing the namespace rather than minting a second one means a deployment cannot end
    // up with both authentication schemes alive at once.
    expect(sessionBinding.sessionKey("AGT-1")).toBe("session:AGT-1");
  });
});

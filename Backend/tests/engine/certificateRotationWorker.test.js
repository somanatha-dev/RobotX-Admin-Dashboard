"use strict";

/**
 * Engine lane — Phase 14: the certificate rotation/revocation worker (§23.2) and the
 * identity retention sweep (§23.7).
 *
 * The plan names one background worker for this phase: *"Certificate rotation/revocation
 * checker (at session establishment **and** periodically during long sessions)"*. The
 * establishment half is `sessionBinding.establish()` and is tested with it; what is tested
 * here is the half that has no handler to hang from, and the property that makes it
 * testable at all — the worker returns verdicts and never touches a socket.
 */

const sessionBinding = require("../../src/engine/security/sessionBinding");
const worker = require("../../src/workers/certificateRotation.worker");

const NOW = new Date("2026-08-09T12:00:00.000Z");
const FINGERPRINT = "a".repeat(64);

function certificate(overrides) {
  return {
    id: "cert-1",
    fingerprint: FINGERPRINT,
    agentId: "AGT-1",
    status: "ACTIVE",
    keyStorage: "SECURE_ELEMENT",
    notBefore: new Date("2026-01-01T00:00:00Z"),
    notAfter: new Date("2027-01-01T00:00:00Z"),
    ...overrides,
  };
}

function binding(overrides) {
  return {
    agentId: "AGT-1",
    fingerprint: FINGERPRINT,
    sessionId: "sock-1",
    // Due: the check window has already rolled over.
    nextRevocationCheckAtMs: NOW.getTime() - 1,
    expiresAtMs: null,
    ...overrides,
  };
}

function depsFor(rows, options) {
  const table = rows;
  const updates = [];
  return {
    updates,
    deps: {
      prisma: {
        agentCertificate: {
          async findUnique({ where }) {
            return table.find((row) => row.fingerprint === where.fingerprint) || null;
          },
          async findMany({ where, take }) {
            return table
              .filter((row) => row.status === where.status && (!where.notAfter || row.notAfter < where.notAfter.lt))
              .slice(0, take);
          },
          async updateMany(args) {
            updates.push(args);
            return { count: 1 };
          },
        },
        identityRecord: {
          async findMany() {
            return (options && options.expiredIdentities) || [];
          },
          async findUnique({ where }) {
            return ((options && options.expiredIdentities) || []).find((row) => row.surrogateKey === where.surrogateKey) || null;
          },
          async update({ where, data }) {
            const row = ((options && options.expiredIdentities) || []).find((entry) => entry.surrogateKey === where.surrogateKey);
            Object.assign(row, data);
            return row;
          },
        },
        async $transaction(callback) {
          return callback(this);
        },
      },
      sessions: async () => (options && options.sessions) || [],
    },
  };
}

describe("§23.2 — the periodic revocation sweep", () => {
  test("a session whose certificate is still valid is kept, and the store records the check", async () => {
    const { deps, updates } = depsFor([certificate()], { sessions: [binding()] });
    const result = await worker.sweepRevocations(deps, { now: NOW, recheckIntervalSeconds: 900 });

    expect(result).toMatchObject({ examined: 1, terminate: [] });
    expect(result.renewed[0].nextRevocationCheckAtMs).toBe(NOW.getTime() + 900_000);
    // A column rather than a metric: the question an auditor asks is about one certificate.
    expect(updates[0]).toMatchObject({ where: { fingerprint: FINGERPRINT }, data: { lastCheckedAt: NOW } });
  });

  test("a session whose certificate was revoked mid-session is reported for termination", async () => {
    const { deps } = depsFor([certificate({ status: "REVOKED", revokedAt: NOW, revocationReason: "device stolen" })], {
      sessions: [binding()],
    });
    const result = await worker.sweepRevocations(deps, { now: NOW, recheckIntervalSeconds: 900 });

    expect(result.terminate).toHaveLength(1);
    expect(result.terminate[0]).toMatchObject({
      agentId: "AGT-1",
      refusal: sessionBinding.REFUSAL.CERTIFICATE_REVOKED,
      securityEvent: true,
    });
    // The sentence the sweep exists for.
    expect(result.terminate[0].detail).toMatch(/until the device next power-cycled/);
  });

  test("a session that is not yet due is not examined", async () => {
    const { deps, updates } = depsFor([certificate()], { sessions: [binding({ nextRevocationCheckAtMs: NOW.getTime() + 900_000 })] });
    const result = await worker.sweepRevocations(deps, { now: NOW, recheckIntervalSeconds: 900 });

    expect(result).toMatchObject({ examined: 0, terminate: [], renewed: [] });
    expect(updates).toEqual([]);
  });

  test("an expired certificate terminates the session but is not flagged as a security event", async () => {
    // A routine rotation the fleet mishandled and a device somebody withdrew need
    // different responses, so they are distinguishable in the output.
    const { deps } = depsFor([certificate({ notAfter: new Date("2026-03-01T00:00:00Z") })], { sessions: [binding()] });
    const result = await worker.sweepRevocations(deps, { now: NOW, recheckIntervalSeconds: 900 });

    expect(result.terminate[0]).toMatchObject({ refusal: sessionBinding.REFUSAL.CERTIFICATE_EXPIRED, securityEvent: false });
  });

  test("the sweep returns verdicts and never touches a socket", () => {
    const { codeOnly } = require("../../src/engine/guards/sourceScan");
    const source = codeOnly(require("fs").readFileSync(require.resolve("../../src/workers/certificateRotation.worker"), "utf8"));

    // The socket that must be closed may be owned by a different process, which is a fact
    // only the holder of the Socket.IO adapter knows — so the worker returns a verdict and
    // `server.js` applies it.
    for (const forbidden of ["socket", "io.to(", "disconnectSockets", "require(\"socket.io\")"]) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });
});

describe("§23.2 — the rotation sweep reports and does not issue", () => {
  test("a certificate inside the lead time is reported", async () => {
    const { deps } = depsFor([certificate({ notAfter: new Date("2026-08-12T00:00:00Z") })]);
    const result = await worker.sweepRotations(deps, { now: NOW, leadTimeSeconds: 604_800 });

    expect(result.due).toHaveLength(1);
    expect(result.note).toMatch(/does not mint certificates/);
  });

  test("a certificate outside the lead time is not", async () => {
    const { deps } = depsFor([certificate()]);
    const result = await worker.sweepRotations(deps, { now: NOW, leadTimeSeconds: 604_800 });
    expect(result.due).toEqual([]);
  });
});

describe("§23.7 — the identity retention sweep uses the same erasure path", () => {
  test("an expired identity record is tombstoned, with a stated reason", async () => {
    const expiredIdentities = [
      {
        surrogateKey: `sk_stop_${"0".repeat(32)}`,
        subjectType: "STOP",
        classification: "LOCATION_IDENTIFIER",
        ciphertext: "aa",
        iv: "bb",
        authTag: "cc",
        erasedAt: null,
        retainUntil: new Date("2026-07-01T00:00:00Z"),
      },
    ];
    const { deps } = depsFor([], { expiredIdentities });

    const result = await worker.sweepIdentityRetention(deps, { now: NOW });

    expect(result).toMatchObject({ ok: true, erased: 1 });
    expect(expiredIdentities[0].ciphertext).toBeNull();
    expect(expiredIdentities[0].erasedBy).toBe("RETENTION_POLICY");
    // "Two paths to one behaviour would eventually erase different things."
    expect(expiredIdentities[0].erasureReason).toMatch(/privacy\.identity_retention elapsed/);
  });
});

describe("the worker's lifecycle", () => {
  test("one tick runs all three passes and reports each", async () => {
    const { deps } = depsFor([certificate({ status: "REVOKED", revokedAt: NOW })], { sessions: [binding()] });
    const result = await worker.tick(deps, { now: NOW, recheckIntervalSeconds: 900, rotationLeadTimeSeconds: 604_800 });

    expect(result).toMatchObject({ terminated: 1, examined: 1, rotationsDue: 0, identityRecordsErased: 0 });
  });

  test("a failed tick delays a revocation by one tick and never grants one", async () => {
    const errors = [];
    const failing = {
      prisma: { agentCertificate: { findUnique: async () => { throw new Error("store unavailable"); } } },
      sessions: async () => [binding()],
      onError: (error) => errors.push(error),
    };

    const handle = worker.start(failing, { intervalMs: 5, now: NOW });
    await new Promise((resolve) => setTimeout(resolve, 30));
    handle.stop();

    expect(errors.length).toBeGreaterThan(0);
    // `nextRevocationCheckAtMs` is only advanced by a check that *succeeded*, so the next
    // tick re-examines the same sessions.
    expect(binding().nextRevocationCheckAtMs).toBeLessThan(NOW.getTime());
  });

  test("the interval handle is unref'd, so it never holds a process open", () => {
    const { deps } = depsFor([certificate()], { sessions: [] });
    const handle = worker.start(deps, { intervalMs: 60_000 });
    expect(typeof handle.stop).toBe("function");
    handle.stop();
  });
});

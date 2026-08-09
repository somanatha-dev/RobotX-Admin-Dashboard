"use strict";

/**
 * Engine lane — Phase 14: capability attestation (§23.2) and the capability row of §23.5.
 *
 * > A compromised agent claiming `hazmat_certified` must not thereby become eligible for
 * > hazmat work; this is precisely the kind of privilege escalation an untyped,
 * > self-declared capability field enables.
 *
 * The plan's testing requirement for this phase opens with exactly that: *"Unit: capability
 * claimed via telemetry is rejected entirely (§23.2)."*
 */

const crypto = require("crypto");

const attestation = require("../../src/engine/security/attestation");
const capability = require("../../src/engine/domain/capability");

const SIGNER = "an-attestation-signing-secret-long-enough";
const NOW = new Date("2026-08-09T12:00:00.000Z");

function manifest(overrides) {
  return {
    agentId: "AGT-1",
    issuedAt: "2026-08-01T00:00:00.000Z",
    notAfter: "2026-12-01T00:00:00.000Z",
    firmwareVersion: "4.2.1",
    hardwareRevision: "rev-C",
    secureElement: true,
    capabilities: [{ name: "hazmat_certified", kind: "CERTIFIED", value: true, issuer: "NCA", validUntil: "2027-01-01T00:00:00.000Z" }],
    ...overrides,
  };
}

describe("§23.2 — a capability claim from the agent's data plane is rejected entirely", () => {
  test("every refused origin is refused, and each is a security event", () => {
    for (const origin of attestation.REFUSED_ORIGIN) {
      const verdict = attestation.admitClaim({ name: "hazmat_certified", origin });
      expect({ origin, admitted: verdict.admitted, securityEvent: verdict.securityEvent }).toEqual({
        origin,
        admitted: false,
        securityEvent: true,
      });
      expect(verdict.reason).toMatch(/must not thereby become eligible for hazmat work/);
    }
  });

  test("an unknown origin is refused too — unknown is never permission", () => {
    const verdict = attestation.admitClaim({ name: "cold_chain", origin: "SOMEWHERE" });
    expect(verdict).toMatchObject({ admitted: false, securityEvent: false });
    expect(verdict.reason).toMatch(/Unknown is never permission/);
  });

  test("the three admissible origins are admitted", () => {
    for (const origin of attestation.ORIGINS) {
      expect(attestation.admitClaim({ name: "cold_chain", origin }).admitted).toBe(true);
    }
  });

  test("a capability-shaped field is found wherever it is nested in a passthrough payload", () => {
    const claims = attestation.findCapabilityClaims({
      robotId: "AGT-1",
      lat: 1,
      telemetry: { extras: [{ capabilities: ["hazmat_certified"] }] },
      certifications: ["cold_chain"],
    });

    expect(claims.map((claim) => claim.path).sort()).toEqual(["certifications", "telemetry.extras[0].capabilities"]);
  });

  test("an ordinary telemetry payload trips nothing", () => {
    expect(attestation.findCapabilityClaims({ robotId: "AGT-1", lat: 51.5, lon: -0.1, battery: 80, speed: 1.2 })).toEqual([]);
  });
});

describe("§23.2 — attestation verification", () => {
  const signed = (over) => {
    const body = manifest(over);
    return { manifest: body, signature: attestation.sign(body, SIGNER) };
  };

  test("a correctly signed, unexpired manifest verifies", () => {
    const { manifest: body, signature } = signed();
    const result = attestation.verify({ manifest: body, signature, key: SIGNER, agentId: "AGT-1", now: NOW, maxAgeSeconds: 2_592_000 });

    expect(result).toMatchObject({ outcome: attestation.VERIFICATION.VALID, ok: true });
    expect(result.manifestHash).toBe(attestation.manifestHash(body));
  });

  test("a tampered manifest fails signature verification", () => {
    const { manifest: body, signature } = signed();
    const tampered = { ...body, capabilities: [...body.capabilities, { name: "clearance", kind: "BOOLEAN", value: true }] };
    expect(attestation.verify({ manifest: tampered, signature, key: SIGNER, now: NOW }).outcome).toBe(attestation.VERIFICATION.SIGNATURE_INVALID);
  });

  test("a manifest lifted from another device is refused — the agent id is inside the signature", () => {
    const { manifest: body, signature } = signed();
    // Presenting AGT-1's genuine, correctly-signed manifest as AGT-2. In a fleet of
    // identical hardware this is the normal attack, not an exotic one.
    expect(attestation.verify({ manifest: body, signature, key: SIGNER, agentId: "AGT-2", now: NOW }).outcome).toBe(
      attestation.VERIFICATION.AGENT_MISMATCH,
    );
  });

  test("an expired manifest is EXPIRED, not merely invalid — the two need different responses", () => {
    const { manifest: body, signature } = signed({ notAfter: "2026-03-01T00:00:00.000Z" });
    expect(attestation.verify({ manifest: body, signature, key: SIGNER, now: NOW }).outcome).toBe(attestation.VERIFICATION.EXPIRED);
  });

  test("a manifest older than security.attestation_max_age is stale, even with no notAfter", () => {
    const { manifest: body, signature } = signed({ issuedAt: "2025-01-01T00:00:00.000Z", notAfter: null });
    const result = attestation.verify({ manifest: body, signature, key: SIGNER, now: NOW, maxAgeSeconds: 2_592_000 });

    expect(result.outcome).toBe(attestation.VERIFICATION.EXPIRED);
    expect(result.detail).toMatch(/serviced and reflashed/);
  });

  test("no signer key is UNKNOWN_SIGNER rather than a silent pass", () => {
    const { manifest: body, signature } = signed();
    expect(attestation.verify({ manifest: body, signature, key: null, now: NOW }).outcome).toBe(attestation.VERIFICATION.UNKNOWN_SIGNER);
  });

  test("a manifest naming no agent is MALFORMED", () => {
    expect(attestation.verify({ manifest: { capabilities: [] }, signature: "00", key: SIGNER, now: NOW }).outcome).toBe(
      attestation.VERIFICATION.MALFORMED,
    );
  });

  test("Ed25519 signing and verification round-trips", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const body = manifest();
    const signature = attestation.sign(body, privateKey, "ED25519");

    expect(attestation.verify({ manifest: body, signature, key: publicKey, algorithm: "ED25519", now: NOW }).ok).toBe(true);
    expect(
      attestation.verify({ manifest: { ...body, firmwareVersion: "9.9.9" }, signature, key: publicKey, algorithm: "ED25519", now: NOW }).ok,
    ).toBe(false);
  });

  test("the manifest hash is order-independent, so a dispute compares digests", () => {
    const a = attestation.manifestHash({ agentId: "AGT-1", firmwareVersion: "1", hardwareRevision: "r" });
    const b = attestation.manifestHash({ hardwareRevision: "r", firmwareVersion: "1", agentId: "AGT-1" });
    expect(a).toBe(b);
  });
});

describe("§23.2 — building the authoritative capability set", () => {
  test("commissioned and attested capabilities are admitted and labelled with their origin", () => {
    const result = attestation.capabilitiesFrom({
      commissioned: [{ name: "cold_chain", kind: "BOOLEAN", value: true }],
      attestation: manifest(),
    });

    expect(result.rejected).toEqual([]);
    expect(result.capabilities.map((entry) => [entry.name, entry.source])).toEqual([
      ["cold_chain", "COMMISSIONING_RECORD"],
      ["hazmat_certified", "FIRMWARE_ATTESTATION"],
    ]);
    // The Tier 0 gate's own assertion passes over the result, which is what makes this a
    // boundary rather than a hope.
    expect(() => capability.assertAttested({ capabilities: result.capabilities })).not.toThrow();
  });

  test("a commissioned entry claiming a telemetry origin is rejected and never enters the bundle", () => {
    const result = attestation.capabilitiesFrom({
      commissioned: [{ name: "hazmat_certified", kind: "BOOLEAN", value: true, origin: "TELEMETRY" }],
    });

    expect(result.capabilities).toEqual([]);
    expect(result.rejected[0]).toMatchObject({ name: "hazmat_certified", origin: "TELEMETRY", securityEvent: true });
  });
});

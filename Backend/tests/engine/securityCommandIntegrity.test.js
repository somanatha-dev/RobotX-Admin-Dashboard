"use strict";

/**
 * Engine lane — Phase 14: command integrity completed (§23.3).
 *
 * Phase 4 shipped the envelope and signed it with HMAC, recording a promise:
 *
 * > Phase 14 owns mTLS, per-device certificates, and hardware-backed keys (§23.2); it
 * > replaces the *key material and algorithm*, not the envelope.
 *
 * These tests hold Phase 14 to that promise in both directions — the envelope is
 * unchanged, and the algorithm is genuinely new — and cover the plan's stated integration
 * requirement: *"expired `not_valid_after` command rejected"*.
 */

const crypto = require("crypto");

const commandSigning = require("../../src/engine/security/commandSigning");
const fencing = require("../../src/engine/commitment/fencing");

const HMAC_KEY = "a-command-signing-key-of-sufficient-length";

function envelope(overrides) {
  return {
    agentId: "AGT-1",
    command: "OFFER",
    commandClass: fencing.commandClassOf("OFFER"),
    fenceScope: fencing.fenceScopeOf("OFFER"),
    commitmentId: "CMT-1",
    fence: 7n,
    authorityEpoch: null,
    fenceFloor: null,
    sequence: 3,
    notValidAfter: new Date("2026-08-09T12:10:00.000Z"),
    payload: { legId: "LEG-1" },
    ...overrides,
  };
}

describe("§23.3 — the envelope Phase 4 fixed is byte-for-byte unchanged", () => {
  test("the signed field set is exactly the eleven fields Phase 4 declared", () => {
    expect([...commandSigning.SIGNED_FIELDS]).toEqual([
      "agentId",
      "command",
      "commandClass",
      "fenceScope",
      "commitmentId",
      "fence",
      "authorityEpoch",
      "fenceFloor",
      "sequence",
      "notValidAfter",
      "payload",
    ]);
  });

  test("the canonical form does not depend on the order the object was built in", () => {
    const built = envelope();
    const reversed = Object.fromEntries(Object.entries(built).reverse());
    expect(commandSigning.canonicalise(reversed)).toBe(commandSigning.canonicalise(built));
  });

  test("an HMAC signature made before this phase still verifies", () => {
    // The regression this guards: Phase 4's deployed agents hold a key and a canonical
    // form. Changing either without changing the version would silently stop every one of
    // them from accepting a command.
    const signature = commandSigning.sign(envelope(), HMAC_KEY);
    expect(commandSigning.verify(envelope(), signature, HMAC_KEY)).toBe(true);
    expect(commandSigning.sign(envelope(), HMAC_KEY, { algorithm: "HMAC_SHA256" })).toBe(signature);
  });
});

describe("§23.2 / §23.3 — the asymmetric scheme", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");

  test("an Ed25519 signature verifies against the public key alone", () => {
    // The property HMAC cannot have: the fleet can verify without holding anything that
    // would let it forge. A compromised device yields no signing capability.
    const signature = commandSigning.sign(envelope(), privateKey, { algorithm: "ED25519" });
    expect(commandSigning.verify(envelope(), signature, publicKey, { algorithm: "ED25519" })).toBe(true);
  });

  test("a tampered envelope fails, including one that only changes the addressee", () => {
    const signature = commandSigning.sign(envelope(), privateKey, { algorithm: "ED25519" });
    expect(commandSigning.verify(envelope({ agentId: "AGT-2" }), signature, publicKey, { algorithm: "ED25519" })).toBe(false);
    expect(commandSigning.verify(envelope({ fence: 8n }), signature, publicKey, { algorithm: "ED25519" })).toBe(false);
  });

  test("an unrecognised algorithm label is refused rather than defaulted", () => {
    // A typo that silently downgraded the scheme would still produce a signature that
    // verifies, which is the worst possible outcome for a security control.
    expect(() => commandSigning.algorithmOf({ algorithm: "HMAC" })).toThrow(/is not one of HMAC_SHA256, ED25519/);
    expect(commandSigning.verify(envelope(), "00", HMAC_KEY, { algorithm: "HMAC" })).toBe(false);
  });

  test("the default is still HMAC, so no Phase 4 caller changes behaviour", () => {
    expect(commandSigning.algorithmOf(undefined)).toBe(commandSigning.ALGORITHM.HMAC_SHA256);
  });
});

describe("§23.3 — the two envelope rejection rules, counted by scope", () => {
  const NOW = new Date("2026-08-09T12:00:00.000Z");

  test("an expired command is rejected — the delayed-delivery defence", () => {
    const signed = { ...envelope(), signature: commandSigning.sign(envelope(), HMAC_KEY) };
    const late = new Date("2026-08-09T12:20:00.000Z");

    const verdict = commandSigning.admitEnvelope(signed, { agentId: "AGT-1", now: late, key: HMAC_KEY });
    expect(verdict).toMatchObject({ accepted: false, reason: "NOT_VALID_AFTER_PASSED" });
    // "A mission offer that surfaces twenty minutes late must not be executed, because the
    // world has moved on."
    expect(verdict.scope).toBe("COMMITMENT");
  });

  test("a command addressed to a different agent is rejected", () => {
    const signed = { ...envelope(), signature: commandSigning.sign(envelope(), HMAC_KEY) };
    expect(commandSigning.admitEnvelope(signed, { agentId: "AGT-2", now: NOW, key: HMAC_KEY }).reason).toBe("ADDRESSED_TO_ANOTHER_AGENT");
  });

  test("every rejection carries its scope, including one whose command field was tampered with", () => {
    // Deriving the scope after the fact from the command name would fail for exactly the
    // envelopes whose command field is the thing that was altered.
    const tampered = { ...envelope({ command: "NOT_A_COMMAND" }), signature: "00" };
    expect(commandSigning.admitEnvelope(tampered, { agentId: "AGT-1", now: NOW, key: HMAC_KEY })).toMatchObject({
      accepted: false,
      reason: "SIGNATURE_INVALID",
      scope: "UNKNOWN_COMMAND",
    });
  });

  test("an agent-scope command reports the agent scope", () => {
    const agentEnvelope = envelope({ command: "QUARANTINE", commandClass: "AGENT", fenceScope: "AGENT", commitmentId: null, fence: null, authorityEpoch: 4n, fenceFloor: 2n });
    const signed = { ...agentEnvelope, signature: commandSigning.sign(agentEnvelope, HMAC_KEY) };
    expect(commandSigning.admitEnvelope(signed, { agentId: "AGT-1", now: NOW, key: HMAC_KEY })).toMatchObject({ accepted: true, scope: "AGENT" });
  });

  test("an Ed25519-signed command is admitted through the same envelope rules", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const signed = { ...envelope(), signature: commandSigning.sign(envelope(), privateKey, { algorithm: "ED25519" }) };

    expect(commandSigning.admitEnvelope(signed, { agentId: "AGT-1", now: NOW, key: publicKey, algorithm: "ED25519" })).toMatchObject({
      accepted: true,
    });
  });
});

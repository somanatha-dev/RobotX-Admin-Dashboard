"use strict";

/**
 * Engine lane — Phase 14: surrogate keys and the identifying/derived separation (§23.7).
 *
 * The section's own sentence is that "stating the separation as a principle is not enough
 * to implement it", so these tests hold the register to the two properties that make it a
 * mechanism rather than a convention: the key is stable and unenumerable, and the scan
 * catches an identifying field wherever it is hidden.
 */

const crypto = require("crypto");

const surrogateKeys = require("../../src/engine/privacy/surrogateKeys");
const identityStore = require("../../src/engine/privacy/identityStore");

const SECRET = "a-surrogate-secret-of-sufficient-length";
const KEY = crypto.createHash("sha256").update("identity-store-test-key").digest();

describe("§23.7 — the surrogate key is stable, typed, and not enumerable", () => {
  test("the same natural id yields the same key, every time and across spellings", () => {
    const one = surrogateKeys.surrogateKey({ subjectType: "STOP", naturalId: "12 Acacia Avenue", secret: SECRET });
    const again = surrogateKeys.surrogateKey({ subjectType: "STOP", naturalId: "  12   Acacia   Avenue ", secret: SECRET });

    expect(one).toBe(again);
    // Stability is the property §23.7 requires: without it the same destination looks
    // like two destinations to every aggregation, and the identity store accumulates a
    // row per decision.
    expect(surrogateKeys.isSurrogateKey(one)).toBe(true);
  });

  test("the subject type is part of the digest, so a Task and a Stop never collide", () => {
    const asStop = surrogateKeys.surrogateKey({ subjectType: "STOP", naturalId: "12 Acacia Avenue", secret: SECRET });
    const asTask = surrogateKeys.surrogateKey({ subjectType: "TASK", naturalId: "12 Acacia Avenue", secret: SECRET });

    expect(asStop).not.toBe(asTask);
    // Without this, erasing a Task would tombstone a Stop.
    expect(surrogateKeys.subjectTypeOf(asStop)).toBe("STOP");
    expect(surrogateKeys.subjectTypeOf(asTask)).toBe("TASK");
  });

  test("a different secret yields a different key — the digest is keyed, not a hash of the address", () => {
    const mine = surrogateKeys.surrogateKey({ subjectType: "STOP", naturalId: "12 Acacia Avenue", secret: SECRET });
    const theirs = surrogateKeys.surrogateKey({ subjectType: "STOP", naturalId: "12 Acacia Avenue", secret: `${SECRET}-other` });
    expect(mine).not.toBe(theirs);
  });

  test("an unkeyed or short secret is refused rather than defaulted", () => {
    // The whole security value of the construction: an unkeyed sha256 over an address is
    // reversible by enumeration, because the space of real addresses is small.
    expect(() => surrogateKeys.surrogateKey({ subjectType: "STOP", naturalId: "x", secret: null })).toThrow(/reversible by enumeration/);
    expect(() => surrogateKeys.surrogateKey({ subjectType: "STOP", naturalId: "x", secret: "short" })).toThrow(/does not resist enumeration/);
  });

  test("an untyped key is refused — a resolver cannot apply the right access policy without one", () => {
    expect(() => surrogateKeys.surrogateKey({ subjectType: "PERSON", naturalId: "x", secret: SECRET })).toThrow(/is not one of TASK, STOP, PAYLOAD/);
  });

  test("normalisation is conservative: two genuinely different premises never merge", () => {
    // A false identity *merge* is worse than a duplicate: it would let one erasure
    // request tombstone somebody else's record.
    const a = surrogateKeys.surrogateKey({ subjectType: "STOP", naturalId: "12 Acacia Avenue", secret: SECRET });
    const b = surrogateKeys.surrogateKey({ subjectType: "STOP", naturalId: "12a Acacia Avenue", secret: SECRET });
    expect(a).not.toBe(b);
  });
});

describe("§23.7 — the identifying-field register", () => {
  test("it catches the obvious names and the ones that do not look identifying", () => {
    for (const name of ["address", "pickupAddress", "pickup_address", "recipientName", "lat", "lon", "label", "doorCode"]) {
      expect({ name, identifying: surrogateKeys.isIdentifyingField(name) }).toEqual({ name, identifying: true });
    }
  });

  test("the mechanism's own vocabulary is exempt, and so is §21.6's shadowLabel", () => {
    // Without the exemptions the scan would flag the very columns that fix the problem,
    // and would flag a shadow run's name because it happens to end in "label".
    for (const name of ["identityKey", "surrogateKeys", "fineCell", "zoneId", "routingNodeId", "shadowLabel"]) {
      expect({ name, identifying: surrogateKeys.isIdentifyingField(name) }).toEqual({ name, identifying: false });
    }
  });

  test("a short register name is matched only on equality, so `lat` does not match `translation`", () => {
    expect(surrogateKeys.isIdentifyingField("translation")).toBe(false);
    expect(surrogateKeys.isIdentifyingField("lat")).toBe(true);
  });

  test("the scan finds an identifying field nested inside an array inside an object", () => {
    const found = surrogateKeys.scan({
      roundId: "r1",
      candidates: [{ agentId: "A1", stops: [{ stopId: "S1", label: "12 Acacia Avenue" }] }],
    });
    expect(found).toEqual([{ path: "candidates[0].stops[0].label", field: "label" }]);
  });

  test("a field that is present and null is not a finding — that is the state a Phase 15 drop leaves", () => {
    expect(surrogateKeys.scan({ label: null, lat: null })).toEqual([]);
  });

  test("assertNonIdentifying names every offending path", () => {
    expect(() => surrogateKeys.assertNonIdentifying({ stop: { label: "x", lat: 1 } }, "a Tier A record")).toThrow(
      /a Tier A record holds identifying value\(s\) at stop\.label, stop\.lat/,
    );
  });
});

describe("§23.7 — the derived quantities are exactly the six the section enumerates", () => {
  test("derive() returns the six keys and nothing else, nulling what no resolver supplied", () => {
    const derived = surrogateKeys.derive({ lat: 1, lon: 2 }, { fineCell: () => "cell-a", zoneId: () => "zone-1" });
    expect(Object.keys(derived).sort()).toEqual([...surrogateKeys.DERIVED_QUANTITIES].sort());
    expect(derived).toMatchObject({ fineCell: "cell-a", zoneId: "zone-1", routingNodeId: null, geofenceResult: null });
  });

  test("a resolver that returns free text is refused — that is where an address would re-enter", () => {
    expect(() => surrogateKeys.derive({}, { zoneId: () => "x".repeat(200) })).toThrow(/not free text, which is where an address would re-enter/);
  });

  test("reference() produces a record the scan passes", () => {
    const reference = surrogateKeys.reference({
      subjectType: "STOP",
      naturalId: "12 Acacia Avenue",
      secret: SECRET,
      identifying: { label: "12 Acacia Avenue", lat: 51.5, lon: -0.1 },
      resolvers: { fineCell: () => "cell-a", routingNodeId: () => "node-42" },
    });

    expect(surrogateKeys.scan(reference)).toEqual([]);
    expect(reference.identityKey).toBe(surrogateKeys.surrogateKey({ subjectType: "STOP", naturalId: "12 Acacia Avenue", secret: SECRET }));
  });
});

describe("§23.7 — the identity store seals, classifies, and tombstones", () => {
  test("the sealed fields round-trip and the ciphertext is not the plaintext", () => {
    const sealed = identityStore.seal({ label: "12 Acacia Avenue", recipientName: "A. Person" }, KEY);
    expect(sealed.ciphertext).not.toMatch(/Acacia/);
    expect(identityStore.unseal(sealed, KEY)).toEqual({ label: "12 Acacia Avenue", recipientName: "A. Person" });
  });

  test("an edited ciphertext fails to decrypt rather than decrypting to something else", () => {
    const sealed = identityStore.seal({ label: "12 Acacia Avenue" }, KEY);

    // The tamper is an XOR against the final byte rather than a literal `ff`. `seal()` uses a
    // random IV, so the ciphertext differs every run, and overwriting the last byte with `ff`
    // was a **no-op whenever that byte was already `ff`** — leaving an untampered ciphertext
    // that `unseal()` then correctly decrypted, so the assertion failed. Measured over 50 000
    // trials it landed on `ff` at very close to 1-in-256, which is exactly the arithmetic and
    // not a defect in the cipher. Recorded with this fix in
    // `PHASE_15_B1_ROUTING_DECISION_REPORT.md` §16 and applied by the pre-Phase-16
    // reconciliation. XOR guarantees the byte changes, so the tamper can never be a no-op and
    // the test is strictly stronger than the one it replaces.
    const last = sealed.ciphertext.slice(-2);
    const flipped = (parseInt(last, 16) ^ 0xff).toString(16).padStart(2, "0");
    const tampered = { ...sealed, ciphertext: `${sealed.ciphertext.slice(0, -2)}${flipped}` };

    expect(tampered.ciphertext).not.toBe(sealed.ciphertext);
    expect(() => identityStore.unseal(tampered, KEY)).toThrow();
  });

  test("classification takes the record's strictest field", () => {
    expect(identityStore.classificationOf({ label: "x" })).toBe(identityStore.CLASSIFICATION.LOCATION_IDENTIFIER);
    expect(identityStore.classificationOf({ label: "x", recipientName: "y" })).toBe(identityStore.CLASSIFICATION.DIRECT_IDENTIFIER);
    expect(identityStore.classificationOf({ payloadDescription: "x" })).toBe(identityStore.CLASSIFICATION.PAYLOAD_DESCRIPTOR);
  });

  test("a key of the wrong length is refused", () => {
    expect(() => identityStore.requireEncryptionKey(Buffer.alloc(16))).toThrow(/requires exactly 32/);
    expect(() => identityStore.requireEncryptionKey(null)).toThrow(/encryption at rest/);
  });

  test("resolve() refuses without an actor, a role, and a reason", async () => {
    await expect(identityStore.resolve({ prisma: {} }, "sk_stop_" + "0".repeat(32), { actorId: "ops-1" })).rejects.toThrow(
      /requires an actor, a role, and a reason/,
    );
  });
});

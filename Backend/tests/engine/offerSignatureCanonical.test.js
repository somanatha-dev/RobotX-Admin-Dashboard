/**
 * P2B-2 — the OFFER signature can be verified by an agent from the wire alone.
 *
 * The backend signs the envelope in memory (BigInt fences, a Date expiry, a payload not yet
 * through JSON); the agent sees only JSON. `tools/verify/wireCanonical.js` is an
 * independent implementation of the canonical form that reads only the wire, and
 * `tools/verify/pi_canonical_reference.py` is the same in Python with the Pi's three stated
 * assumptions. Both must reproduce what the backend signed, through the real production
 * path (`attachStopPaths` → `enqueueOffer` → outbox row → JSON storage → `envelopeOf` →
 * addressee rewrite → JSON).
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const wire = require("../../tools/verify/wireCanonical");
const { TEST_VECTOR_KEY, buildWireOffer } = require("../../tools/verify/p2bOfferSignature");
const commandSigning = require("../../src/engine/security/commandSigning");

const VECTOR_PATH = path.join(__dirname, "../../../docs/contracts/fixtures/offer-signature-test-vector.json");
const PY_REFERENCE = path.join(__dirname, "../../tools/verify/pi_canonical_reference.py");

const randomKey = () => crypto.randomBytes(32).toString("hex");

describe("the wire alone reproduces the backend's signature", () => {
  test("a fresh key, the real OFFER path: the wire-only canonicaliser verifies", async () => {
    const key = randomKey();
    const { wireEnvelope } = await buildWireOffer({ key, storeTime: new Date() });
    expect(wire.verifyFromWire(wireEnvelope, key).ok).toBe(true);
    expect(wire.verifyFromWire(wireEnvelope, randomKey()).ok).toBe(false);
  });

  test("the reference agent (VirtualRobot's reconstruction, via commandSigning.verify) agrees", async () => {
    const key = randomKey();
    const { wireEnvelope: e } = await buildWireOffer({ key, storeTime: new Date() });
    const verified = commandSigning.verify(
      {
        agentId: e.agentId,
        command: e.command,
        commandClass: e.commandClass,
        fenceScope: e.fenceScope,
        commitmentId: e.commitmentId,
        fence: e.fence === null ? null : BigInt(e.fence),
        authorityEpoch: e.authorityEpoch === null ? null : BigInt(e.authorityEpoch),
        fenceFloor: e.fenceFloor === null ? null : BigInt(e.fenceFloor),
        sequence: e.sequence,
        notValidAfter: new Date(e.notValidAfter),
        payload: e.payload,
      },
      e.signature,
      key,
    );
    expect(verified).toBe(true);
  });

  test("the committed test vector still matches what the backend produces (no drift)", async () => {
    const vector = JSON.parse(fs.readFileSync(VECTOR_PATH, "utf8"));
    const { wireText } = await buildWireOffer({ key: TEST_VECTOR_KEY, storeTime: new Date("2026-09-24T10:00:00.000Z") });
    expect(wireText).toBe(vector.wire);
    const verdict = wire.verifyFromWire(JSON.parse(vector.wire), vector.key);
    expect(verdict).toMatchObject({ ok: true, canonical: vector.canonical, expected: vector.signature });
  });
});

describe("the canonical form, pinned (the Pi's three assumptions, answered)", () => {
  let vector;
  let parts;
  beforeAll(() => {
    vector = JSON.parse(fs.readFileSync(VECTOR_PATH, "utf8"));
    parts = Object.fromEntries(vector.canonical.split("\u001f").map((part) => [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)]));
  });

  test("1a. the envelope's notValidAfter is UNQUOTED ISO-8601 with milliseconds", () => {
    expect(parts.notValidAfter).toBe("2026-09-24T10:00:20.000Z");
  });

  test("1b. but payload.offerExpiry — a string inside the payload — IS quoted", () => {
    expect(parts.payload).toContain('"offerExpiry":"2026-09-24T10:00:20.000Z"');
  });

  test("1c. envelope fence is unquoted integer digits; payload.fence stays a quoted string", () => {
    expect(parts.fence).toBe("42");
    expect(parts.payload).toContain('"fence":"42"');
  });

  test("2a. keys are sorted at every depth INSIDE the payload", () => {
    expect(parts.payload.indexOf('"commitmentId"')).toBeLessThan(parts.payload.indexOf('"energyReserveParams"'));
    expect(parts.payload).toContain('{"marginFraction":0.1,"reserveFloorWh":50,"residualCv":5e-7,"returnLegWh":12.5}');
  });

  test("2b. the ENVELOPE fields are NOT sorted: they are the fixed signed-field order", () => {
    expect(Object.keys(parts)).toEqual(wire.SIGNED_FIELDS);
    expect(Object.keys(parts)).not.toEqual([...wire.SIGNED_FIELDS].sort());
  });

  test("2c. outboxId and signature are on the wire but not signed", () => {
    expect(parts).not.toHaveProperty("outboxId");
    expect(parts).not.toHaveProperty("signature");
  });

  test("3. the key is the UTF-8 bytes of COMMAND_SIGNING_KEY (a multi-byte key signs as its UTF-8 bytes)", () => {
    const canonical = "x";
    const key = "ключ-подписи-длиннее-тридцати-двух-байт";
    expect(wire.hmacHex(canonical, key)).toBe(crypto.createHmac("sha256", Buffer.from(key, "utf8")).update(canonical).digest("hex"));
  });

  test("scalars are rendered the ECMAScript way: 5e-7 (not 5e-07), raw non-ASCII (not \\u-escaped)", () => {
    expect(parts.payload).toContain("5e-7");
    expect(parts.payload).toContain("ಬ್ಲಾಕ್");
    expect(parts.payload).not.toContain("\\u0cac");
  });
});

describe("a wrong reading fails verification — each assumption is load-bearing", () => {
  let vector;
  let envelope;
  beforeAll(() => {
    vector = JSON.parse(fs.readFileSync(VECTOR_PATH, "utf8"));
    envelope = JSON.parse(vector.wire);
  });
  const signs = (canonical) => wire.hmacHex(canonical, vector.key) === vector.signature;

  test("quoting notValidAfter breaks it", () => {
    expect(signs(vector.canonical.replace("notValidAfter=2026", 'notValidAfter="2026').replace(".000Z\u001f", '.000Z"\u001f'))).toBe(false);
  });
  test("quoting the envelope fence breaks it", () => {
    expect(signs(vector.canonical.replace("fence=42", 'fence="42"'))).toBe(false);
  });
  test("sorting the envelope fields breaks it", () => {
    const sorted = vector.canonical.split("\u001f").sort().join("\u001f");
    expect(signs(sorted)).toBe(false);
  });
  test("a tampered payload value breaks it", () => {
    const tampered = { ...envelope, payload: { ...envelope.payload, taskId: "TSK-OTHER" } };
    expect(wire.verifyFromWire(tampered, vector.key).ok).toBe(false);
  });
  test("readdressing the envelope breaks it", () => {
    expect(wire.verifyFromWire({ ...envelope, agentId: "robotx-other" }, vector.key).ok).toBe(false);
  });
});

describe("the Python reference (the Pi's language) reproduces the vector", () => {
  const python = ["python", "python3", "py"].find((cmd) => spawnSync(cmd, ["--version"], { encoding: "utf8" }).status === 0);
  (python ? test : test.skip)("pi_canonical_reference.py PASSes on the committed vector, and naive json.dumps does not", () => {
    const run = spawnSync(python, [PY_REFERENCE, VECTOR_PATH], { encoding: "utf8" });
    expect(run.stdout).toContain("reference signature == backend signature : True");
    expect(run.stdout).toContain("naive json.dumps rendering differs       : True");
    expect(run.status).toBe(0);
  });
});

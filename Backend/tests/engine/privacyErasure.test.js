"use strict";

/**
 * Engine lane — Phase 14: erasure, and **the build gate §23.7 nominates** (§24.3).
 *
 * > The build gate enforces the separation. The reconstruction-equivalence gate (§24.3)
 * > is run additionally over a corpus in which erasure has been applied, and MUST still
 * > reproduce Tier B byte-for-byte. A field whose erasure changes a replayed cost is, by
 * > that test, an identifying field that was wrongly admitted into the decision path.
 *
 * A gate that cannot fail is not a gate, so this file plants an identifying field that
 * *is* consumed by the reconstruction and asserts the erased run catches it — the same
 * discipline `reconstructionEquivalence.test.js` applies to its own divergences.
 */

const crypto = require("crypto");

const erasure = require("../../src/engine/privacy/erasure");
const identityStore = require("../../src/engine/privacy/identityStore");
const surrogateKeys = require("../../src/engine/privacy/surrogateKeys");
const replay = require("../../tools/replay/replayDecision");

const SECRET = "a-surrogate-secret-of-sufficient-length";
const KEY = crypto.createHash("sha256").update("identity-store-test-key").digest();

/** A minimal in-memory `IdentityRecord` table with the transaction shape `apply()` needs. */
function memoryStore(rows) {
  const table = [...(rows || [])];
  const client = {
    identityRecord: {
      async findUnique({ where }) {
        return table.find((row) => row.surrogateKey === where.surrogateKey) || null;
      },
      async findMany({ where }) {
        return table.filter(
          (row) =>
            (where.subjectType === undefined || row.subjectType === where.subjectType) &&
            (where.subjectId === undefined || row.subjectId === where.subjectId) &&
            (where.erasedAt === undefined || row.erasedAt === where.erasedAt) &&
            (where.retainUntil === undefined || (row.retainUntil !== null && row.retainUntil < where.retainUntil.lt)),
        );
      },
      async update({ where, data }) {
        const row = table.find((entry) => entry.surrogateKey === where.surrogateKey);
        Object.assign(row, data);
        return row;
      },
      async create({ data }) {
        table.push({ ...data });
        return data;
      },
    },
    async $transaction(callback) {
      return callback(client);
    },
    __table: table,
  };
  return client;
}

function record(overrides) {
  return {
    surrogateKey: surrogateKeys.surrogateKey({ subjectType: "STOP", naturalId: "12 Acacia Avenue", secret: SECRET }),
    subjectType: "STOP",
    subjectId: "STOP-1",
    classification: "LOCATION_IDENTIFIER",
    fieldNames: ["label"],
    ...identityStore.seal({ label: "12 Acacia Avenue" }, KEY),
    erasedAt: null,
    erasedBy: null,
    erasureReason: null,
    retainUntil: new Date(2_000_000),
    ...overrides,
  };
}

describe("§23.7 — an erasure request is validated before it destroys anything", () => {
  test("it refuses a request with no reason", () => {
    const validation = erasure.validateRequest({ by: "SUBJECT", subjectType: "STOP", subjectId: "S1", requestedBy: "ops-1" });
    expect(validation.ok).toBe(false);
    expect(validation.problems.join(" ")).toMatch(/records its reason/);
  });

  test("it refuses a request with no actor — an irreversible operation with no actor is indistinguishable from an attack", () => {
    const validation = erasure.validateRequest({ by: "SUBJECT", subjectType: "STOP", subjectId: "S1", reason: "request" });
    expect(validation.ok).toBe(false);
    expect(validation.problems.join(" ")).toMatch(/indistinguishable from an attack/);
  });

  test("a retention sweep needs no actor — nobody requested it", () => {
    expect(erasure.validateRequest({ by: "RETENTION", reason: "retention elapsed" }).ok).toBe(true);
  });

  test("an IDENTITY_KEY request must name a surrogate key, not an address", () => {
    const validation = erasure.validateRequest({ by: "IDENTITY_KEY", identityKey: "12 Acacia Avenue", requestedBy: "ops-1", reason: "r" });
    expect(validation.ok).toBe(false);
  });
});

describe("§23.7 — erasure tombstones the identity and leaves the technical record", () => {
  test("the row survives, the ciphertext does not, and the key still resolves to a tombstone", async () => {
    const prisma = memoryStore([record()]);
    const appended = [];

    const result = await erasure.apply(
      { prisma, audit: async (tx, event) => appended.push(event) },
      { by: "SUBJECT", subjectType: "STOP", subjectId: "STOP-1", requestedBy: "ops-1", reason: "data subject request 41", at: new Date(1000) },
    );

    expect(result).toMatchObject({ ok: true, erased: 1 });

    const row = prisma.__table[0];
    // "The surrogate key survives as an opaque token that no longer resolves to a person."
    expect(row.surrogateKey).toBe(record().surrogateKey);
    expect(row.erasedAt).toEqual(new Date(1000));
    expect(row.ciphertext).toBeNull();
    expect(row.iv).toBeNull();
    expect(row.authTag).toBeNull();
    // The names stay: they are not values, and they are what lets the report say what was
    // erased without decrypting anything.
    expect(row.fieldNames).toEqual(["label"]);
  });

  test("the erasure is itself audited — the trail survives the erasure intact", async () => {
    const prisma = memoryStore([record()]);
    const appended = [];
    await erasure.apply(
      { prisma, audit: async (tx, event) => appended.push(event) },
      { by: "SUBJECT", subjectType: "STOP", subjectId: "STOP-1", requestedBy: "ops-1", reason: "data subject request 41" },
    );

    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ actorId: "ops-1", subjectType: "ERASURE_REQUEST", reason: "data subject request 41" });
    expect(appended[0].payload.identityKeys).toEqual([record().surrogateKey]);
  });

  test("erasing twice is not an error, and does not report a second erasure", async () => {
    const prisma = memoryStore([record()]);
    const request = { by: "SUBJECT", subjectType: "STOP", subjectId: "STOP-1", requestedBy: "ops-1", reason: "r" };

    await erasure.apply({ prisma }, request);
    const again = await erasure.apply({ prisma }, request);

    expect(again).toMatchObject({ erased: 0, alreadyErased: 1 });
  });

  test("`put` never re-populates an erased record — a re-run backfill cannot undo an erasure", async () => {
    const prisma = memoryStore([record({ erasedAt: new Date(1), ciphertext: null, iv: null, authTag: null })]);

    const stored = await identityStore.put(
      { prisma },
      { subjectType: "STOP", naturalId: "12 Acacia Avenue", fields: { label: "12 Acacia Avenue" }, secret: SECRET, encryptionKey: KEY },
    );

    expect(stored).toMatchObject({ erased: true, created: false });
    expect(prisma.__table[0].ciphertext).toBeNull();
  });

  test("the plan is available without erasing, and reports what would go", async () => {
    const prisma = memoryStore([record()]);
    const planned = await erasure.plan({ prisma }, { by: "SUBJECT", subjectType: "STOP", subjectId: "STOP-1", requestedBy: "ops-1", reason: "r" });

    expect(planned.targets).toEqual([
      { identityKey: record().surrogateKey, subjectType: "STOP", classification: "LOCATION_IDENTIFIER", alreadyErased: false },
    ]);
    expect(prisma.__table[0].ciphertext).not.toBeNull();
  });

  test("redact() marks identifying fields ERASED and keeps the technical ones", () => {
    const redacted = erasure.redact({
      legId: "LEG-1",
      lowerBoundMilliCU: "4000",
      stop: { stopId: "S1", label: "12 Acacia Avenue", fineCell: "cell-a" },
    });

    expect(redacted).toEqual({
      legId: "LEG-1",
      lowerBoundMilliCU: "4000",
      stop: { stopId: "S1", label: surrogateKeys.ERASED, fineCell: "cell-a" },
    });
  });

  test("a tombstoned surrogate key is reported as ERASED, and the reader is told so", () => {
    const key = record().surrogateKey;
    const redacted = erasure.redact({ identityKey: key }, [key]);
    expect(redacted).toEqual({ identityKey: key, identityStatus: surrogateKeys.ERASED });
  });
});

describe("§23.7 / §24.3 — THE BUILD GATE: the erased corpus still reproduces Tier B", () => {
  test("the shipped corpus carries no identifying field, so erasure is a no-op on replay", () => {
    const result = replay.runCorpus({ erased: true });

    expect(result.ok).toBe(true);
    expect(result.erased).toBe(true);
    expect(result.withTierB).toBe(result.checked);
    // The positive statement, not merely the absence of a failure: the pinned inputs held
    // nothing to erase, which is the schema rule §23.7 makes binding, measured rather
    // than asserted.
    expect(result.erasedFields).toEqual([]);
  });

  test("THE GATE FAILS on a field whose erasure changes a replayed cost", () => {
    // The realistic plant: F33 is the geofence predicate, and its `observed` block is a
    // free-form pass-through that lands verbatim in Tier B. A predicate recording the raw
    // address there instead of the geofence *result* is precisely the defect §23.7 hunts,
    // and it is invisible to review because the field is called "observed".
    const entry = JSON.parse(JSON.stringify(replay.loadCorpus()[0]));
    const candidate = entry.reconstructionInput.candidates[0];
    candidate.predicateResults = candidate.predicateResults || [];
    candidate.predicateResults.push({
      predicateId: "F33",
      outcome: "PASS",
      observed: { label: "12 Acacia Avenue" },
      required: null,
      inputSource: "MAP",
      observationAgeMs: 10,
      indeterminatePolicy: "DENY",
    });

    // The stored Tier B is what the decision actually recorded, so it is rebuilt from the
    // *unerased* input. Comparing an erased reconstruction against it is exactly the
    // gate's question: did erasure change the bytes?
    entry.tierB = require("../../src/engine/observability/tierB").toRow(
      replay.reconstructTierB(replay.reviveMilliCU(entry.reconstructionInput)),
      { writtenBecause: "SAMPLED" },
    );

    const clean = replay.runCorpus({ corpus: [entry] });
    expect(clean.ok).toBe(true);

    const erased = replay.runCorpus({ corpus: [entry], erased: true });
    expect(erased.ok).toBe(false);
    expect(erased.failures[0].equivalence.differingSections).toEqual(["feasibility"]);
    expect(erased.failures[0].erasureDefect).toMatch(/WAS an input to its cost/);
    expect(erased.erasedFields.map((field) => field.field)).toContain("label");
  });

  test("the CLI's --erased run exits zero on the shipped corpus", () => {
    const { execFileSync } = require("child_process");
    const path = require("path");
    const root = path.join(__dirname, "..", "..");

    // Throws on a non-zero exit, so reaching the assertion is the assertion.
    const out = execFileSync(process.execPath, [path.join(root, "tools", "replay", "replayDecision.js"), "--erased"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(out).toMatch(/ERASED corpus/);
    expect(out).toMatch(/PASS/);
  });
});

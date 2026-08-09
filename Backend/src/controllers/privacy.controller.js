const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const { z } = require("zod");

const erasure = require("../engine/privacy/erasure");
const surrogateKeys = require("../engine/privacy/surrogateKeys");
const auditStream = require("../engine/observability/auditStream");

// PHASE 14 — §23.7's erasure surface.
//
//   > support for erasure requests without destroying the audit trail's integrity —
//   > achieved by separating identifying fields from the technical record and erasing
//   > only the former.
//
// ── What this endpoint does and does not touch ───────────────────────────────
// It tombstones `IdentityRecord` rows. It does not touch a decision record, an input
// snapshot, a commitment, a Leg, or the audit stream — and the response says so
// explicitly rather than leaving the caller to assume it, because "what is lost after
// erasure is stated rather than discovered" is §23.7's own requirement and the person
// filing the request is usually the person who will later be asked what survived.
//
// ── Two-step by default ──────────────────────────────────────────────────────
// `POST /api/privacy/erasure` with `dryRun: true` (the default when the field is
// absent) returns the plan without erasing. Erasure is irreversible and its blast
// radius is a query the caller cannot easily run themselves; making the destructive
// call an explicit `dryRun: false` costs one round trip and removes the class of
// mistake where a mistyped subject id erases the wrong record.

const requestSchema = z
  .object({
    by: z.enum(["IDENTITY_KEY", "SUBJECT"]),
    identityKey: z.string().optional().nullable(),
    subjectType: z.enum([...surrogateKeys.SUBJECT_TYPES]).optional().nullable(),
    subjectId: z.string().optional().nullable(),
    reason: z.string().min(1),
    dryRun: z.boolean().optional(),
  })
  .strict();

// POST /api/privacy/erasure
const requestErasure = asyncHandler(async (req, res) => {
  const prisma = getPrisma();

  const parsed = requestSchema.safeParse(req.body || {});
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: "Invalid erasure request",
      detail: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`),
    });
    return;
  }

  const body = parsed.data;
  const dryRun = body.dryRun !== false;

  const request = {
    by: body.by,
    identityKey: body.identityKey ?? null,
    subjectType: body.subjectType ?? null,
    subjectId: body.subjectId ?? null,
    reason: body.reason,
    // The authenticated operator, taken from the session rather than the body. A
    // requester id a caller could supply is a requester id a caller could supply
    // somebody else's.
    requestedBy: req.user?.id ?? null,
    requestedByRole: req.user?.role ?? null,
    at: new Date(),
  };

  const validation = erasure.validateRequest(request);
  if (!validation.ok) {
    res.status(400).json({ ok: false, error: "Invalid erasure request", detail: validation.problems });
    return;
  }

  if (dryRun) {
    const planned = await erasure.plan({ prisma }, request);
    res.json({
      ok: true,
      dryRun: true,
      targets: planned.targets,
      note:
        "nothing was erased. Re-send with dryRun: false to tombstone these identity records. Erasure is " +
        "irreversible; the technical record, the decision records, the input snapshots and the audit stream are " +
        "untouched by it and continue to replay identically (§23.7).",
    });
    return;
  }

  const result = await erasure.apply(
    {
      prisma,
      // The audit append runs inside the same transaction as the tombstones: an erasure
      // whose audit event failed to write is, from the trail's point of view, one that
      // never happened — and §23.7 requires the trail to survive the erasure intact.
      audit: (tx, event) => auditStream.append({ prisma: tx }, event),
    },
    request,
  );

  res.json({
    ok: result.ok,
    dryRun: false,
    erased: result.erased,
    alreadyErased: result.alreadyErased,
    targets: result.targets,
    note: result.note,
  });
});

// GET /api/privacy/erasure/:identityKey — what a surrogate key resolves to now.
//
// Deliberately does **not** return the identifying fields. It answers the one question a
// dispute turns on: does this key still resolve to a person, or has it been erased? That
// is the answer §23.7 says must be "visible to whoever later reads such a record".
// Reading the fields themselves goes through `identityStore.resolve()`, which requires a
// reason and audits the access; it is not an operator-facing HTTP surface.
const identityStatus = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const identityKey = String(req.params?.identityKey || "");

  if (!surrogateKeys.isSurrogateKey(identityKey)) {
    res.status(400).json({ ok: false, error: "Not a surrogate key" });
    return;
  }

  const row = await prisma.identityRecord.findUnique({
    where: { surrogateKey: identityKey },
    select: { surrogateKey: true, subjectType: true, classification: true, fieldNames: true, erasedAt: true, retainUntil: true },
  });

  if (!row) {
    res.status(404).json({ ok: false, status: "NOT_FOUND", identityKey });
    return;
  }

  res.json({
    ok: true,
    identityKey: row.surrogateKey,
    status: row.erasedAt ? surrogateKeys.ERASED : "RESOLVABLE",
    subjectType: row.subjectType,
    classification: row.classification,
    // Names, never values. A field name is not identifying, and returning the list is
    // what lets an erasure report say what was erased without decrypting anything.
    fieldNames: row.fieldNames,
    erasedAt: row.erasedAt,
    retainUntil: row.retainUntil,
  });
});

module.exports = {
  requestErasure,
  identityStatus,
};

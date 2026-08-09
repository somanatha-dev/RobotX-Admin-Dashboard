"use strict";

/**
 * Erasure (§23.7) — **Tier 1**.
 *
 * > **Erasure tombstones the identity record and leaves the technical record intact.**
 * > The surrogate key survives as an opaque token that no longer resolves to a person.
 * > Replay therefore still reproduces the identical allocation and identical
 * > per-candidate costs — because the erased fields were never inputs to them — while
 * > the erased content is genuinely unrecoverable.
 *
 * ── The sentence in there that does the work ────────────────────────────────
 * *"because the erased fields were never inputs to them"* is a claim about the rest of
 * the codebase, not about this module. This module cannot make it true; it can only
 * make it **checkable**, which is why `eraseCorpusEntry()` exists beside `apply()`:
 *
 * > The reconstruction-equivalence gate (§24.3) is run additionally over a corpus in
 * > which erasure has been applied, and MUST still reproduce Tier B byte-for-byte. A
 * > field whose erasure changes a replayed cost is, by that test, an identifying field
 * > that was wrongly admitted into the decision path — which is the defect this rule
 * > exists to catch, and it is caught at build rather than at the first erasure request.
 *
 * So the same function that services a real erasure request is the one the build gate
 * runs over the golden corpus. Two implementations would let the gate pass while the
 * production path erased something else.
 *
 * ── What is deliberately *not* erased ───────────────────────────────────────
 * The audit trail. §23.7 requires "support for erasure requests without destroying the
 * audit trail's integrity", and the erasure itself is an audited event: a hash-chained
 * `AuditEvent` naming the surrogate keys tombstoned, the requester, and the reason. An
 * erasure that erased its own record of having happened would be indistinguishable from
 * a deletion nobody authorised.
 *
 * Nor the decision records, the snapshots, or the commitments. That is the whole design:
 * they never held an identifying value to begin with (`surrogateKeys.js`).
 */

const identityStore = require("./identityStore");
const surrogateKeys = require("./surrogateKeys");

/** What an erasure request may name as its subject. */
const REQUEST_BY = Object.freeze({
  /** One surrogate key, already known to the requester. */
  IDENTITY_KEY: "IDENTITY_KEY",
  /** Every identity record attached to one technical row — a Task, a Stop, a payload. */
  SUBJECT: "SUBJECT",
  /** Retention expiry: an erasure nobody requested, on §23.7's shorter clock. */
  RETENTION: "RETENTION",
});

const REQUEST_BYS = Object.freeze(Object.values(REQUEST_BY));

/**
 * Validate an erasure request.
 *
 * A reason is mandatory. An erasure is irreversible, and an irreversible operation with
 * no recorded reason is one nobody can later distinguish from an attack.
 *
 * @param {object} request
 * @returns {{ ok: boolean, problems: string[] }}
 */
function validateRequest(request) {
  const source = request || {};
  const problems = [];

  if (!REQUEST_BYS.includes(source.by)) {
    problems.push(`"by" must be one of ${REQUEST_BYS.join(", ")}`);
  }
  if (source.by === REQUEST_BY.IDENTITY_KEY && !surrogateKeys.isSurrogateKey(source.identityKey)) {
    problems.push("an IDENTITY_KEY request names a surrogate key");
  }
  if (source.by === REQUEST_BY.SUBJECT && (!source.subjectType || !source.subjectId)) {
    problems.push("a SUBJECT request names a subject type and a subject id");
  }
  if (source.by !== REQUEST_BY.RETENTION && !source.requestedBy) {
    problems.push("an erasure records who requested it — an irreversible operation with no actor is indistinguishable from an attack (§23.7)");
  }
  if (!source.reason) {
    problems.push("an erasure records its reason");
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Which identity records a request would tombstone, without tombstoning them.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} request
 * @returns {Promise<{ ok: boolean, problems: string[], targets: object[] }>}
 */
async function plan(deps, request) {
  const validation = validateRequest(request);
  if (!validation.ok) return { ok: false, problems: validation.problems, targets: [] };

  const source = request || {};
  let rows;

  if (source.by === REQUEST_BY.IDENTITY_KEY) {
    const row = await deps.prisma.identityRecord.findUnique({ where: { surrogateKey: source.identityKey } });
    rows = row ? [row] : [];
  } else if (source.by === REQUEST_BY.SUBJECT) {
    rows = await deps.prisma.identityRecord.findMany({
      where: { subjectType: source.subjectType, subjectId: String(source.subjectId) },
    });
  } else {
    rows = await identityStore.expired(deps, { nowMs: source.nowMs, take: source.take });
  }

  return {
    ok: true,
    problems: [],
    targets: rows.map((row) => ({
      identityKey: row.surrogateKey,
      subjectType: row.subjectType,
      classification: row.classification ?? null,
      alreadyErased: Boolean(row.erasedAt),
    })),
  };
}

/**
 * Apply an erasure.
 *
 * The tombstones and the audit event are written in **one transaction**. §4.1 rule 5's
 * discipline applies here for the same reason it applies to a dispatch: an erasure whose
 * audit event failed to write is an erasure that, from the audit trail's point of view,
 * never happened — and §23.7's requirement is precisely that the trail survive the
 * erasure intact.
 *
 * @param {object} deps `{ prisma, audit }` — `audit` appends to the hash-chained stream
 *   and is called with a transaction client
 * @param {object} request
 * @returns {Promise<object>} the report
 */
async function apply(deps, request) {
  const validation = validateRequest(request);
  if (!validation.ok) return { ok: false, problems: validation.problems, erased: 0, targets: [] };

  const source = request || {};
  const at = source.at instanceof Date ? source.at : new Date();
  const intended = await plan(deps, request);

  const outcome = await deps.prisma.$transaction(async (tx) => {
    const results = [];
    for (const target of intended.targets) {
      // eslint-disable-next-line no-await-in-loop
      const result = await identityStore.tombstone(tx, target.identityKey, {
        erasedBy: source.requestedBy ?? "RETENTION_POLICY",
        reason: source.reason,
        at,
      });
      results.push({ ...target, ...result });
    }

    if (typeof deps.audit === "function") {
      await deps.audit(tx, {
        eventType: "OPERATOR_ACTION",
        actorId: source.requestedBy ?? "RETENTION_POLICY",
        actorRole: source.requestedByRole ?? null,
        subjectType: "ERASURE_REQUEST",
        subjectId: source.identityKey ?? String(source.subjectId ?? source.by),
        reason: source.reason,
        payload: {
          by: source.by,
          identityKeys: results.filter((row) => row.tombstoned).map((row) => row.identityKey),
          alreadyErased: results.filter((row) => row.alreadyErased).length,
        },
        recordedAtMs: at.getTime(),
      });
    }

    return results;
  });

  return {
    ok: true,
    problems: [],
    erased: outcome.filter((row) => row.tombstoned).length,
    alreadyErased: outcome.filter((row) => row.alreadyErased).length,
    targets: outcome,
    // §23.7 — "What is lost after erasure is stated rather than discovered."
    note:
      "the identity records are tombstoned and their surrogate keys survive as opaque tokens. Every decision record, " +
      "input snapshot and commitment referencing them is untouched and still replays identically; what a replayed " +
      "decision can no longer render is a human-readable destination, which the Explanation API marks ERASED (§23.7).",
  };
}

/**
 * Render a record for a reader after erasure: identifying fields become the `ERASED`
 * marker, everything technical is untouched.
 *
 * @param {*} record
 * @param {Set<string>|string[]} [erasedKeys] surrogate keys known to be tombstoned
 * @returns {*} a copy
 */
function redact(record, erasedKeys) {
  const erased = erasedKeys instanceof Set ? erasedKeys : new Set(erasedKeys || []);

  const walk = (node) => {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) return node.map(walk);
    if (node instanceof Date) return node;
    if (typeof node !== "object") return node;

    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (surrogateKeys.isIdentifyingField(key) && value !== null && value !== undefined) {
        out[key] = surrogateKeys.ERASED;
        continue;
      }
      // A surrogate key that names a tombstoned record is *kept* — it is the opaque
      // token §23.7 says survives — and the reader is told it no longer resolves.
      if (key === "identityKey" && erased.has(value)) {
        out[key] = value;
        out.identityStatus = surrogateKeys.ERASED;
        continue;
      }
      out[key] = walk(value);
    }
    return out;
  };

  return walk(record);
}

/**
 * The build gate's erasure: apply erasure to a replay-corpus entry's *inputs*.
 *
 * The simulation is faithful because erasure's only effect on a technical record is
 * that any identifying value it holds stops resolving. So: walk the reconstruction
 * input, replace every identifying field with the `ERASED` marker, and hand the result
 * to the same reconstruction the unerased gate uses.
 *
 * If the entry held no identifying field — the state §23.7's schema rule requires — the
 * reconstruction is byte-identical and the gate passes. If it held one *and the cost
 * path read it*, the reconstruction diverges and the gate names the field. That is the
 * defect being hunted, caught at build.
 *
 * @param {object} entry a corpus entry `{ tierA, tierB, reconstructionInput }`
 * @returns {{ entry: object, erasedFields: Array<{ path: string, field: string }> }}
 */
function eraseCorpusEntry(entry) {
  const source = entry || {};
  const erasedFields = [
    ...surrogateKeys.scan(source.reconstructionInput, "reconstructionInput"),
    ...surrogateKeys.scan(source.tierA, "tierA"),
  ];

  return {
    entry: {
      ...source,
      name: source.name === undefined ? undefined : `${source.name} (erased)`,
      tierA: redact(source.tierA),
      reconstructionInput: redact(source.reconstructionInput),
      // Untouched: the stored Tier B is what the reconstruction is compared *against*.
      // Redacting it too would compare two redactions and prove nothing.
      tierB: source.tierB,
    },
    erasedFields,
  };
}

/**
 * Apply `eraseCorpusEntry` across a whole corpus.
 *
 * @param {object[]} corpus
 * @returns {{ corpus: object[], erasedFields: Array<object> }}
 */
function eraseCorpus(corpus) {
  const erasedFields = [];
  const out = [];
  for (const entry of corpus || []) {
    const result = eraseCorpusEntry(entry);
    out.push(result.entry);
    for (const field of result.erasedFields) erasedFields.push({ name: entry.name, ...field });
  }
  return { corpus: out, erasedFields };
}

module.exports = {
  REQUEST_BY,
  REQUEST_BYS,
  validateRequest,
  plan,
  apply,
  redact,
  eraseCorpusEntry,
  eraseCorpus,
};

"use strict";

/**
 * The hash-chained audit stream (§21.7) — **Tier 1**.
 *
 * > **Audit stream** — separate, append-only, hash-chained, longer retention: operator
 * > actions, overrides, config changes, quarantine decisions, constraint relaxations,
 * > manual assignments, cancellations. **Non-repudiation matters when a decision is
 * > disputed months later.**
 *
 * ── Why a chain rather than an append-only table ────────────────────────────
 * "Append-only" is a property of how a table is *used*; a chain is a property of the
 * data itself. The distinction is the whole point when the disputed action is an
 * operator override and the party best placed to remove the record is the operator.
 *
 * Each event's `hash` covers its own content **and its predecessor's hash**, so altering
 * any event breaks every link after it. That catches edits. It does not, on its own,
 * catch a *removal* — so the sequence is dense and starts at zero, and a missing ordinal
 * is as visible as a broken link. Two properties, because neither alone catches both
 * failures, and a tamper-evidence scheme that catches one of two attacks is a scheme that
 * will be defeated by the other one.
 *
 * ── Exactly which removals those two properties catch, and which they do not ─
 * The pair above was written as though it covered every removal. It does not, and the
 * difference was found by deleting rows on a live PostgreSQL rather than by reading this
 * file (`tools/verify/phase11LiveDatabase.js`). Stated precisely:
 *
 *   · **A removal from the MIDDLE** leaves a hole. `verify()` reports it as a gap, and the
 *     event after the hole also fails its `previousHash` check. Caught twice.
 *   · **A removal from the HEAD** leaves the new first event carrying a `previousHash`
 *     where `null` is expected, and — with `expectedFirstSequence` — a first ordinal that
 *     is not zero. Caught twice.
 *   · **A removal from the TAIL is not detectable from the stream alone, by
 *     construction.** A truncated chain is indistinguishable from a chain that was never
 *     longer: every remaining link verifies, and the sequence is still dense. Worse, the
 *     freed ordinal is *reused* — `append()` reads the tail and takes the next number —
 *     so deleting the last event and appending a replacement yields a chain that verifies
 *     completely clean.
 *
 * Detecting truncation needs an anchor the attacker does not hold: a high-water mark
 * recorded elsewhere. `verify()` therefore accepts `expectedLastSequence`, and reports a
 * shortfall as a **truncation** rather than as a gap, because the two have different
 * remedies — a gap is a hole to investigate, a truncation is evidence that the tail was
 * removed and that everything after the anchor is unaccounted for.
 *
 * Nothing in this repository holds such an anchor yet: publishing the high-water mark to
 * a store outside this table is a deployment decision, and §21.7 does not name one. What
 * this module owes is that the limit is stated rather than implied away, and that a
 * caller who *does* hold an anchor can use it. Both are true here; neither was before.
 *
 * ── Why this module is separate from the decision record ───────────────────
 * §21.7 says "separate", and the separation is not filing. A decision record answers
 * *why the engine chose this*; an audit event answers *who changed the rules and when*.
 * They have different retention, different readers, and — critically — different trust
 * requirements: a decision record may be reconstructed by replay (§21.2), and an audit
 * event may not be reconstructed by anything, because the thing it attests to is exactly
 * the human action that no deterministic function reproduces.
 *
 * ── Appending is serialised, and the serialisation is the database's ────────
 * A chain has one tail. Two concurrent appends that both read sequence `n` would both
 * write `n + 1`, and the unique index on `(streamId, sequence)` refuses the second —
 * which is the correct outcome and the reason the constraint exists rather than a lock.
 * `append()` surfaces the collision to the caller to retry rather than swallowing it: a
 * silently dropped audit event is the failure this whole module exists to prevent.
 */

const crypto = require("crypto");

const { canonicalJson } = require("../determinism/ordering");

/** @structural the chain's digest algorithm */
const DIGEST_ALGORITHM = "sha256";

/** The stream every fleet-wide action lands on. @structural the global stream's name */
const GLOBAL_STREAM = "global";

/**
 * §21.7's enumerated event types, plus the two this phase itself produces.
 * Matches `AuditEvent_event_type_known`.
 */
const EVENT_TYPE = Object.freeze({
  OPERATOR_ACTION: "OPERATOR_ACTION",
  OVERRIDE: "OVERRIDE",
  CONFIG_CHANGE: "CONFIG_CHANGE",
  QUARANTINE: "QUARANTINE",
  CONSTRAINT_RELAXATION: "CONSTRAINT_RELAXATION",
  MANUAL_ASSIGNMENT: "MANUAL_ASSIGNMENT",
  CANCELLATION: "CANCELLATION",
  /** §18.5 rule 1 — mode entry and exit are events, written to this stream. */
  DEGRADED_MODE: "DEGRADED_MODE",
  /**
   * §21.2 — "the shedding is itself recorded as a counted event". It lands here rather
   * than only in a counter because it is a loss of evidence, and a loss of evidence
   * belongs in the record that cannot itself be quietly lost.
   */
  TIER_B_SHEDDING: "TIER_B_SHEDDING",
});

const EVENT_TYPES = Object.freeze(Object.values(EVENT_TYPE));

/**
 * The bytes an event's hash is taken over.
 *
 * The predecessor's hash is the first field, so a chain cannot be re-rooted by
 * recomputing one event in isolation. `canonicalJson` fixes key order, so the digest
 * does not depend on how the object happened to be built.
 *
 * @param {object} event
 * @returns {string}
 */
function payloadToDigest(event) {
  return canonicalJson({
    previousHash: event.previousHash ?? null,
    streamId: event.streamId,
    sequence: String(event.sequence),
    eventType: event.eventType,
    actorId: event.actorId ?? null,
    actorRole: event.actorRole ?? null,
    subjectType: event.subjectType ?? null,
    subjectId: event.subjectId ?? null,
    reason: event.reason ?? null,
    payload: event.payload ?? null,
    recordedAtMs: event.recordedAtMs ?? null,
  });
}

/**
 * The hash of one event.
 *
 * @param {object} event
 * @returns {string}
 */
function hashOf(event) {
  return crypto.createHash(DIGEST_ALGORITHM).update(payloadToDigest(event)).digest("hex");
}

/**
 * Build the next event in a chain.
 *
 * @param {object} input
 * @param {string} input.streamId
 * @param {object|null} input.previous the previous event, or null for the first
 * @param {string} input.eventType one of `EVENT_TYPE`
 * @param {string} [input.actorId]
 * @param {string} [input.actorRole]
 * @param {string} [input.subjectType]
 * @param {string} [input.subjectId]
 * @param {string} [input.reason]
 * @param {object} [input.payload]
 * @param {number} input.recordedAtMs
 * @returns {object} the `AuditEvent` row shape, hashed
 */
function link(input) {
  const source = input || {};
  if (!EVENT_TYPES.includes(source.eventType)) {
    throw new TypeError(
      `"${source.eventType}" is not one of the audit stream's event types. An append-only stream that accepts ` +
        "an unrecognised type accepts an event nobody defined the meaning of, which is the one thing a " +
        "non-repudiation record may not do (§21.7).",
    );
  }

  const sequence = source.previous ? BigInt(source.previous.sequence) + 1n : 0n;
  const body = {
    streamId: String(source.streamId),
    sequence,
    eventType: source.eventType,
    actorId: source.actorId ?? null,
    actorRole: source.actorRole ?? null,
    subjectType: source.subjectType ?? null,
    subjectId: source.subjectId ?? null,
    reason: source.reason ?? null,
    payload: source.payload ?? null,
    previousHash: source.previous ? source.previous.hash : null,
    recordedAtMs: source.recordedAtMs,
  };

  return { ...body, hash: hashOf(body), recordedAt: new Date(source.recordedAtMs) };
}

/**
 * Append one event to a stream.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input as `link()`, without `previous`
 * @returns {Promise<{ ok: boolean, event: object|null, collided: boolean }>}
 */
async function append(deps, input) {
  const source = input || {};
  const streamId = String(source.streamId || GLOBAL_STREAM);

  const previous = await deps.prisma.auditEvent.findFirst({
    where: { streamId },
    orderBy: { sequence: "desc" },
  });

  const event = link({ ...source, streamId, previous });
  const { recordedAtMs, ...row } = event;

  try {
    const stored = await deps.prisma.auditEvent.create({ data: row });
    return { ok: true, event: stored, collided: false };
  } catch (error) {
    // The unique index on `(streamId, sequence)` refused a concurrent append. This is
    // the correct outcome — a chain has one tail — and it is surfaced rather than
    // swallowed, because a silently dropped audit event is the failure this module
    // exists to prevent. The caller retries; the sequence is re-read.
    const collided = Boolean(error && (error.code === "P2002" || /unique/i.test(String(error.message))));
    if (!collided) throw error;
    return { ok: false, event: null, collided: true, detail: "another writer took this sequence; re-read the tail and retry" };
  }
}

/**
 * Verify a chain: every link, the density of the sequence, and — when the caller holds an
 * anchor — that the tail is where the anchor says it is.
 *
 * @param {object[]} events in ascending sequence order
 * @param {object} [options]
 * @param {bigint|string|number} [options.expectedFirstSequence] the ordinal the stream
 *   must begin at. Pass `0` when reading a whole stream; omit for a window.
 * @param {bigint|string|number} [options.expectedLastSequence] a high-water mark recorded
 *   OUTSIDE this table. Without one, a truncated tail is indistinguishable from a chain
 *   that was never longer — see the module header.
 * @returns {{ ok: boolean, checked: number, brokenLinks: object[], gaps: object[],
 *             truncations: object[], firstSequence: string|null, lastSequence: string|null }}
 */
function verify(events, options) {
  const settings = options || {};
  const rows = [...(events || [])].sort((a, b) => (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0));
  const brokenLinks = [];
  const gaps = [];
  const truncations = [];

  let expectedPrevious = null;
  let expectedSequence = rows.length > 0 ? BigInt(rows[0].sequence) : 0n;

  for (const row of rows) {
    const sequence = BigInt(row.sequence);

    if (sequence !== expectedSequence) {
      // A gap is a *removal*, which a broken link alone would not catch: deleting the
      // tail of a chain leaves every remaining link intact.
      gaps.push({ expected: expectedSequence.toString(), found: sequence.toString() });
      expectedSequence = sequence;
    }

    if ((row.previousHash ?? null) !== expectedPrevious) {
      brokenLinks.push({
        sequence: sequence.toString(),
        expectedPreviousHash: expectedPrevious,
        foundPreviousHash: row.previousHash ?? null,
        why: "this event does not follow the one before it — the chain was edited or reordered",
      });
    }

    const recomputed = hashOf({
      streamId: row.streamId,
      sequence,
      eventType: row.eventType,
      actorId: row.actorId ?? null,
      actorRole: row.actorRole ?? null,
      subjectType: row.subjectType ?? null,
      subjectId: row.subjectId ?? null,
      reason: row.reason ?? null,
      payload: row.payload ?? null,
      previousHash: row.previousHash ?? null,
      recordedAtMs: row.recordedAt instanceof Date ? row.recordedAt.getTime() : row.recordedAtMs,
    });

    if (recomputed !== row.hash) {
      brokenLinks.push({
        sequence: sequence.toString(),
        expectedHash: recomputed,
        foundHash: row.hash,
        why: "this event's own content does not match its hash — it was altered in place",
      });
    }

    expectedPrevious = row.hash;
    expectedSequence = sequence + 1n;
  }

  const firstSequence = rows.length > 0 ? BigInt(rows[0].sequence) : null;
  const lastSequence = rows.length > 0 ? BigInt(rows[rows.length - 1].sequence) : null;

  // A HEAD removal. The `previousHash` check above already catches it, but only as a
  // broken link — which reads as "the chain was edited" when what happened is that its
  // beginning was deleted. Naming it makes the density claim in the header true rather
  // than incidentally satisfied.
  if (settings.expectedFirstSequence !== undefined && settings.expectedFirstSequence !== null) {
    const expectedFirst = BigInt(settings.expectedFirstSequence);
    if (firstSequence === null || firstSequence !== expectedFirst) {
      truncations.push({
        end: "HEAD",
        expected: expectedFirst.toString(),
        found: firstSequence === null ? null : firstSequence.toString(),
        why: "the stream does not begin where it must — its opening events were removed",
      });
    }
  }

  // A TAIL removal, which nothing inside the stream can reveal: every remaining link
  // verifies and the sequence is still dense. Only an anchor recorded elsewhere detects it.
  if (settings.expectedLastSequence !== undefined && settings.expectedLastSequence !== null) {
    const expectedLast = BigInt(settings.expectedLastSequence);
    if (lastSequence === null || lastSequence < expectedLast) {
      truncations.push({
        end: "TAIL",
        expected: expectedLast.toString(),
        found: lastSequence === null ? null : lastSequence.toString(),
        why:
          "the stream ends before the recorded high-water mark: the tail was removed, and every event after the " +
          "anchor is unaccounted for. A truncated chain is otherwise indistinguishable from a shorter one.",
      });
    }
  }

  return {
    ok: brokenLinks.length === 0 && gaps.length === 0 && truncations.length === 0,
    checked: rows.length,
    brokenLinks,
    gaps,
    truncations,
    // Stated so a caller can record it as the anchor for the next verification.
    firstSequence: firstSequence === null ? null : firstSequence.toString(),
    lastSequence: lastSequence === null ? null : lastSequence.toString(),
    tailIsAnchored: settings.expectedLastSequence !== undefined && settings.expectedLastSequence !== null,
  };
}

/**
 * Read and verify a whole stream.
 *
 * A whole-stream read must begin at ordinal zero, so that check is applied by default —
 * the caller does not have to know to ask for it, and a stream whose opening events were
 * deleted is named as a HEAD truncation rather than reported as an ambiguous broken link.
 * A windowed read (`take`) is not a whole stream and is exempt.
 *
 * `expectedLastSequence` is never defaulted, because the database cannot supply it: the
 * anchor has to come from outside the table it is anchoring. Passing one is what makes a
 * TAIL truncation detectable at all.
 *
 * @param {object} deps `{ prisma }`
 * @param {string} streamId
 * @param {object} [options] `{ take, expectedFirstSequence, expectedLastSequence }`
 * @returns {Promise<object>}
 */
async function verifyStream(deps, streamId, options) {
  const settings = options || {};
  const windowed = Number.isFinite(settings.take);

  const events = await deps.prisma.auditEvent.findMany({
    where: { streamId: String(streamId) },
    orderBy: { sequence: "asc" },
    ...(windowed ? { take: settings.take } : {}),
  });

  const expectedFirstSequence =
    settings.expectedFirstSequence !== undefined
      ? settings.expectedFirstSequence
      : windowed || events.length === 0
        ? null
        : 0n;

  return {
    streamId: String(streamId),
    ...verify(events, { expectedFirstSequence, expectedLastSequence: settings.expectedLastSequence }),
  };
}

module.exports = {
  DIGEST_ALGORITHM,
  GLOBAL_STREAM,
  EVENT_TYPE,
  EVENT_TYPES,
  payloadToDigest,
  hashOf,
  link,
  append,
  verify,
  verifyStream,
};

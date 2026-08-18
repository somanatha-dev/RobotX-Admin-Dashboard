"use strict";

/**
 * The transactional outbox (§11.1) — the mechanism that makes §4.1 rule 5 structural.
 *
 * > The audit identifies the baseline's most consequential dispatch defect: the task
 * > is committed to the database *before* dispatch is attempted, the dispatch result
 * > is discarded, the exception is swallowed, and there is no acknowledgement — so a
 * > correct decision can produce no physical effect with no signal, recoverable only
 * > by a server restart.
 *
 * The remedy, in three parts, all of which live here or in `outbox.worker.js`:
 *
 * > 1. The commit transaction writes the Commitment and an **outbox row** atomically
 * >    (§10.3 step 5). Either both exist or neither does. There is no window in which
 * >    a commitment exists without a pending dispatch obligation.
 * > 2. Dispatcher workers claim outbox rows, deliver, and mark them delivered.
 * >    Delivery is at-least-once; the agent deduplicates on `(commitment_id, sequence,
 * >    fence)` for mission commands and on `(agent_id, sequence, authority_epoch)` for
 * >    agent commands (§10.5), against the **durable** deduplication state of §11.5.
 * > 3. An undelivered outbox row past its delivery deadline escalates (§11.4). Outbox
 * >    depth and oldest-undelivered-age are primary SLIs — a rising value is direct
 * >    evidence that commitments are not reaching agents.
 *
 * ── Why `enqueue` refuses a non-transaction client ──────────────────────────
 * §4.1 rule 5 is not "write the row soon"; it is "write the row in the *same
 * transaction* as the state transition and fence advance that authorise it":
 *
 * > A reconciler that bumps a fence and then separately issues a recall can emit that
 * > recall before the bump commits, or after the bump has been rolled back —
 * > producing a duplicate stand-down, or a command carrying an authority that does
 * > not exist. Binding the command to the transaction removes both cases by
 * > construction.
 *
 * A function that accepted the base client would let a caller satisfy the letter of
 * "route it through the outbox" while breaking the rule the outbox exists to enforce.
 * `enqueue` therefore takes a transaction client and asserts it is one.
 *
 * ── What this module never does ─────────────────────────────────────────────
 * It never delivers. It never reads a socket, an `io` server, or the cache — the
 * commit path's freedom from cache dependency (invariant I16) extends here, because a
 * row that could not be written when Redis was down would be a commitment without a
 * dispatch obligation. Delivery is `workers/outbox.worker.js` plus
 * `services/commandDispatcher.service.js`.
 *
 * Tier 0 (T0-09). Invariants I5, I16, I19, I21.
 */

const fencing = require("../commitment/fencing");
const idempotency = require("../commitment/idempotency");
const clock = require("../commitment/clock");

/**
 * The row's lifecycle. Constrained by `Outbox_state_known` in the migration, so an
 * unknown state cannot be written by any path — not by this module and not by a
 * future one.
 *
 * @structural the enumerated states of the outbox row, mirrored by the CHECK constraint
 */
const OUTBOX_STATE = Object.freeze({
  /** Written in the authorising transaction; awaiting a worker. */
  PENDING: "PENDING",
  /** Leased by one worker for delivery. The lease has an expiry (§11.1 note). */
  CLAIMED: "CLAIMED",
  /** The transport accepted it for an agent session that existed. */
  DELIVERED: "DELIVERED",
  /** The agent acknowledged it. Terminal, and the only *successful* terminal. */
  ACKED: "ACKED",
  /** §11.4 step 2 — delivered (or not) but unacknowledged past `dispatch.offer_ttl`. */
  UNACKNOWLEDGED: "UNACKNOWLEDGED",
  /** §23.3 — `not_valid_after` passed. "The world has moved on." */
  EXPIRED: "EXPIRED",
  /** §11.5 path 3 — the agent's dedup state was reset; redelivery is suppressed. */
  SUPPRESSED: "SUPPRESSED",
  /** Bounded retry exhausted (§11.3). Escalated, never discarded. */
  FAILED: "FAILED",
});

/** States from which no further delivery attempt may be made. */
const TERMINAL_STATES = Object.freeze([
  OUTBOX_STATE.ACKED,
  OUTBOX_STATE.EXPIRED,
  OUTBOX_STATE.SUPPRESSED,
  OUTBOX_STATE.FAILED,
]);

/**
 * States a row may hold while it is still an outstanding dispatch obligation.
 *
 * `UNACKNOWLEDGED` is one of them. It is not a terminal state and it is not a
 * discharged obligation: §11.4 step 2 says the engine must *act* on it — "withdraw
 * offer at an advanced commitment fence, release the commitment, mark agent
 * `dispatch_unresponsive`, re-plan the Leg excluding it" — and until that action has
 * been performed the commitment is still held, the Leg is still `OFFERED`, and the
 * agent may still be holding an offer it never answered.
 *
 * Excluding it from this list, as the first cut of this module did, made an
 * unanswered offer invisible to three things at once: the depth SLI §11.1 calls
 * primary evidence "that commitments are not reaching agents", the `not_valid_after`
 * sweep, and §11.5's reset-path suppression — so a fleet whose agents had stopped
 * answering would have reported an outbox depth of zero. That was the observation
 * disappearing precisely when it mattered, which is the failure class §12.1 exists to
 * eliminate.
 */
const OUTSTANDING_STATES = Object.freeze([
  OUTBOX_STATE.PENDING,
  OUTBOX_STATE.CLAIMED,
  OUTBOX_STATE.DELIVERED,
  OUTBOX_STATE.UNACKNOWLEDGED,
]);

/**
 * The subset of outstanding states in which the row is still a **delivery**
 * obligation — a message a worker may claim, deliver, or expire.
 *
 * `UNACKNOWLEDGED` is deliberately absent. Once the ack deadline has passed the
 * question is no longer "can this be delivered?" but "has the authority it carried
 * been withdrawn?", and a row in that state leaves it only by the §11.4 step-2 action
 * (to `FAILED`) or by §11.5's suppression (to `SUPPRESSED`). Expiring it on
 * `not_valid_after` instead would discharge the *bookkeeping* while leaving the
 * commitment held — a row that looks finished and an agent that was never told.
 */
const DELIVERY_OBLIGATION_STATES = Object.freeze([
  OUTBOX_STATE.PENDING,
  OUTBOX_STATE.CLAIMED,
  OUTBOX_STATE.DELIVERED,
]);

/**
 * @param {string} state
 * @returns {boolean}
 */
function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

/**
 * @param {string} state
 * @returns {boolean}
 */
function isOutstanding(state) {
  return OUTSTANDING_STATES.includes(state);
}

/**
 * Is this object a transaction client rather than the base Prisma client?
 *
 * The distinguishing property is the absence of `$transaction`: Prisma's interactive
 * transaction client does not expose it, and the base client does. Checked rather
 * than trusted, because the whole value of the outbox rests on the row landing in the
 * caller's transaction.
 *
 * @param {unknown} tx
 * @returns {boolean}
 */
function isTransactionClient(tx) {
  return Boolean(tx) && typeof tx === "object" && typeof tx.outbox === "object" && typeof tx.$transaction !== "function";
}

/**
 * Build an outbox row from a command, enforcing §10.3.1's scope discipline.
 *
 * The scope is looked up in `fencing.js`'s normative table rather than passed in, so
 * there is exactly one place in the system that decides which fence guards which
 * command. A query is refused outright: §10.3.1 row 3 makes queries side-effect-free
 * and unfenced, and enqueuing one for durable, fenced, sequenced delivery would give
 * it exactly the properties the table denies it.
 *
 * @param {object} input
 * @param {string} input.command the §10.3.1 command name
 * @param {string} input.agentId the `Agent.id` this command is addressed to
 * @param {string} [input.commitmentId] required for a mission command, refused for an agent command
 * @param {bigint|number|string} [input.fence] the commitment fence, mission commands only
 * @param {bigint|number|string} [input.authorityEpoch] agent commands only
 * @param {bigint|number|string} [input.fenceFloor] agent commands only (§10.3.1 interaction rule)
 * @param {number} input.sequence the per-scope ordering counter (§11.3)
 * @param {object} input.payload the command body
 * @param {Date} input.notValidAfter §23.3
 * @param {string} input.signature §23.3
 * @returns {object} the row, ready for `enqueue`
 */
function buildRow(input) {
  const source = input || {};
  const scope = fencing.fenceScopeOf(source.command);

  if (scope === null) {
    throw new Error(
      `"${source.command}" is a query (§10.3.1 row 3): side-effect-free, always answered, never fenced. ` +
        "Enqueuing it for durable fenced sequenced delivery would give it the authority the table denies it.",
    );
  }

  if (typeof source.agentId !== "string" || source.agentId === "") {
    throw new TypeError("every outbox row names the agent it is addressed to; delivery is by agent identity (§11.3)");
  }
  if (!Number.isInteger(source.sequence) || source.sequence < 0) {
    throw new TypeError(`sequence must be a non-negative integer; received ${String(source.sequence)} (§11.3)`);
  }
  if (!(source.notValidAfter instanceof Date) || Number.isNaN(source.notValidAfter.getTime())) {
    throw new TypeError(
      "every command carries not_valid_after (§23.3): a mission offer that surfaces twenty minutes late must not " +
        "be executed, because the world has moved on",
    );
  }
  if (typeof source.signature !== "string" || source.signature === "") {
    throw new TypeError("every command carries a signature over the whole payload including the agent id (§23.3)");
  }
  if (source.payload === null || typeof source.payload !== "object") {
    throw new TypeError("an outbox row carries its command's payload as an object");
  }

  const isMission = scope === fencing.FENCE_SCOPE.COMMITMENT;

  if (isMission) {
    if (typeof source.commitmentId !== "string" || source.commitmentId === "") {
      throw new TypeError(
        `"${source.command}" is a mission command and is fenced per commitment id (§10.3.1 row 1); it cannot be ` +
          "addressed to an agent alone",
      );
    }
    if (source.fence === undefined || source.fence === null) {
      throw new TypeError(`"${source.command}" is a mission command and MUST carry its commitment's fence (§10.3.1)`);
    }
  } else {
    if (source.commitmentId !== undefined && source.commitmentId !== null) {
      throw new TypeError(
        `"${source.command}" is an agent command (§10.3.1 row 2). Naming a commitment would invite the agent to ` +
          "compare it against that commitment's history rather than against its authority epoch",
      );
    }
    if (source.authorityEpoch === undefined || source.authorityEpoch === null) {
      throw new TypeError(`"${source.command}" is an agent command and MUST carry the agent's authority_epoch (§10.3.1)`);
    }
    if (source.fenceFloor === undefined || source.fenceFloor === null) {
      throw new TypeError(
        `"${source.command}" is an agent command and MUST carry fence_floor alongside authority_epoch. Without it ` +
          "the agent cannot invalidate the mission authorities this command supersedes, and one STAND_DOWN_ALL " +
          "would leave every commitment still commandable (§10.3.1 interaction rule)",
      );
    }
  }

  const idempotencyKey = idempotency.idempotencyKeyFor(
    isMission
      ? { command: source.command, commitmentId: source.commitmentId, sequence: source.sequence, fence: source.fence }
      : {
          command: source.command,
          agentId: source.agentId,
          sequence: source.sequence,
          authorityEpoch: source.authorityEpoch,
        },
  );

  return Object.freeze({
    idempotencyKey,
    agentId: source.agentId,
    commitmentId: isMission ? source.commitmentId : null,
    commandClass: fencing.commandClassOf(source.command),
    command: source.command,
    fenceScope: scope,
    fence: isMission ? BigInt(source.fence) : null,
    authorityEpoch: isMission ? null : BigInt(source.authorityEpoch),
    fenceFloor: isMission ? null : BigInt(source.fenceFloor),
    sequence: source.sequence,
    payload: source.payload,
    notValidAfter: source.notValidAfter,
    signature: source.signature,
    state: OUTBOX_STATE.PENDING,
    attempts: 0,
  });
}

/**
 * §11.1 step 1 / §10.3.2 step 5 — write the row **in the caller's transaction**.
 *
 * Idempotent on `idempotencyKey` (§10.5): a retried enqueue of the same command in a
 * retried transaction observes its own prior row rather than creating a second
 * dispatch obligation for one authority.
 *
 * @param {object} tx a Prisma **transaction** client
 * @param {object} row from `buildRow`
 * @returns {Promise<object>} the persisted row
 */
async function enqueue(tx, row) {
  if (!isTransactionClient(tx)) {
    throw new TypeError(
      "the outbox row MUST be written inside the transaction that authorises the command (§4.1 rule 5, §11.1). " +
        "A row written afterwards can be emitted before its authorising write commits, or after that write has been " +
        "rolled back — producing a duplicate stand-down, or a command carrying an authority that does not exist.",
    );
  }

  const existing = await tx.outbox.findUnique({ where: { idempotencyKey: row.idempotencyKey } });
  if (existing) return existing;

  return tx.outbox.create({ data: { ...row } });
}

/**
 * §11.4 step 1's precondition — is this row still worth delivering?
 *
 * @param {object} row
 * @param {Date} storeTime the Commitment Store's clock (§10.6)
 * @returns {{ deliverable: boolean, reason: string|null }}
 */
function assessDeliverability(row, storeTime) {
  if (!row) return { deliverable: false, reason: "NO_ROW" };
  if (isTerminal(row.state)) return { deliverable: false, reason: `TERMINAL_${row.state}` };
  if (clock.hasPassed(row.notValidAfter, storeTime)) {
    return { deliverable: false, reason: "NOT_VALID_AFTER_PASSED" };
  }
  return { deliverable: true, reason: null };
}

/**
 * Claim up to `limit` deliverable rows for one worker.
 *
 * The claim is a **conditional** write — `state = PENDING` (or a `CLAIMED` row whose
 * claim lease has expired) — so two workers racing for the same row produce one
 * winner and one no-op, without a distributed lock. The cache-held claim key of the
 * plan's Redis row is advisory on top of this, never instead of it (§3.3's
 * cache-authority rule; invariant I16).
 *
 * ── Why the candidate window is wider than the batch ────────────────────────
 * `isRetryDue` (§11.3's backoff, supplied by the worker) can decline a candidate that
 * has already been attempted. Candidates arrive oldest-first, and the oldest rows are
 * precisely the ones most likely to be inside a backoff interval — so a window equal to
 * the batch size would let a cohort of backing-off rows sit at the head of the queue and
 * starve the never-attempted rows behind them, converting one agent's outage into a
 * fleet-wide delivery stall. Over-reading by a bounded multiple keeps the pass's cost
 * bounded while leaving ready work reachable past a backlog of deferred work.
 *
 * @param {object} prisma the base client
 * @param {object} input
 * @param {string} input.workerId
 * @param {Date} input.storeTime
 * @param {number} input.limit
 * @param {number} input.claimTtlSeconds how long the claim lease lasts
 * @param {(row: object) => boolean} [input.isRetryDue] §11.3's retry pacing. Consulted
 *   for `PENDING` rows only: a `CLAIMED` row is reclaimed on its **lease** expiring,
 *   which is the mechanism that bounds how long a dead worker's rows are invisible, and
 *   pacing it a second time would delay recovery from a crash rather than a rejection.
 *   Absent, every candidate is due — which is the pre-§11.3 behaviour and is why the
 *   worker always supplies it.
 * @returns {Promise<object[]>} the rows this worker now owns
 */
async function claim(prisma, input) {
  const settings = input || {};
  const { workerId, storeTime, limit, claimTtlSeconds } = settings;

  if (typeof workerId !== "string" || workerId === "") {
    throw new TypeError("a claim names the worker that holds it, so an expired claim can be attributed (§11.1)");
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`claim batch size must be a positive integer; received ${String(limit)}`);
  }

  const claimExpiresAt = clock.deadlineFrom(storeTime, claimTtlSeconds);
  const isRetryDue = typeof settings.isRetryDue === "function" ? settings.isRetryDue : () => true;

  const candidates = await prisma.outbox.findMany({
    where: {
      OR: [
        { state: OUTBOX_STATE.PENDING },
        // A claim whose lease expired: the worker that held it is presumed gone.
        // Reclaiming is safe because delivery is at-least-once by construction and
        // the agent deduplicates (§10.5, §11.5).
        { state: OUTBOX_STATE.CLAIMED, claimExpiresAt: { lt: storeTime } },
      ],
      notValidAfter: { gt: storeTime },
    },
    orderBy: [{ createdAt: "asc" }, { sequence: "asc" }],
    take: limit * CANDIDATE_WINDOW_MULTIPLE,
  });

  const claimed = [];
  for (const candidate of candidates) {
    if (claimed.length >= limit) break;
    // §11.3 — a row inside its backoff interval is not a candidate this pass. Skipped
    // rather than claimed-and-released, so the attempt counter and the claim lease both
    // stay meaningful.
    if (candidate.state === OUTBOX_STATE.PENDING && !isRetryDue(candidate)) continue;

    const result = await prisma.outbox.updateMany({
      where: {
        id: candidate.id,
        state: candidate.state,
        // Guard the reclaim against the original holder having renewed in between.
        ...(candidate.state === OUTBOX_STATE.CLAIMED ? { claimedAt: candidate.claimedAt } : {}),
      },
      data: {
        state: OUTBOX_STATE.CLAIMED,
        claimedBy: workerId,
        claimedAt: storeTime,
        claimExpiresAt,
      },
    });
    if (result.count === 1) {
      claimed.push({
        ...candidate,
        state: OUTBOX_STATE.CLAIMED,
        claimedBy: workerId,
        claimedAt: storeTime,
        claimExpiresAt,
      });
    }
  }

  return claimed;
}

/**
 * Record a delivery attempt's outcome. Conditional on the row still being claimed by
 * this worker, so a worker whose claim lapsed and was reclaimed cannot overwrite the
 * new holder's progress.
 *
 * @param {object} prisma
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.workerId
 * @param {boolean} input.delivered
 * @param {Date} input.storeTime
 * @param {string} [input.error]
 * @returns {Promise<number>} rows updated: 1 on success, 0 when the claim had lapsed
 */
async function recordAttempt(prisma, input) {
  const settings = input || {};
  const result = await prisma.outbox.updateMany({
    where: { id: settings.id, claimedBy: settings.workerId, state: OUTBOX_STATE.CLAIMED },
    data: settings.delivered
      ? {
          state: OUTBOX_STATE.DELIVERED,
          deliveredAt: settings.storeTime,
          attempts: { increment: 1 },
          lastError: null,
        }
      : {
          // Back to PENDING: retry is the worker's loop, bounded by the escalation
          // ladder rather than by an unbounded local retry (§11.3).
          state: OUTBOX_STATE.PENDING,
          claimedBy: null,
          claimedAt: null,
          claimExpiresAt: null,
          attempts: { increment: 1 },
          lastError: settings.error || "UNDELIVERED",
        },
  });
  return result.count;
}

/**
 * Move a row to a terminal state.
 *
 * @param {object} client a base or transaction client
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.state one of `TERMINAL_STATES` or `UNACKNOWLEDGED`
 * @param {Date} input.storeTime
 * @param {string} [input.detail]
 * @returns {Promise<number>}
 */
async function settleRow(client, input) {
  const settings = input || {};
  if (settings.state !== OUTBOX_STATE.UNACKNOWLEDGED && !isTerminal(settings.state)) {
    throw new RangeError(`"${String(settings.state)}" is not a settlement state for an outbox row`);
  }
  const result = await client.outbox.updateMany({
    where: { id: settings.id, state: { notIn: TERMINAL_STATES } },
    data: {
      state: settings.state,
      ...(settings.state === OUTBOX_STATE.ACKED ? { ackedAt: settings.storeTime } : {}),
      ...(settings.detail ? { lastError: settings.detail } : {}),
    },
  });
  return result.count;
}

/**
 * §11.5 path 3 — *"Suppress redelivery entirely."*
 *
 * Every outstanding obligation for this agent becomes `SUPPRESSED` in the same
 * transaction that advances the agent's `authority_epoch`, because:
 *
 * > Redelivering into an agent whose dedup table is empty is the one action
 * > guaranteed to cause the double execution the protocol forbids.
 *
 * @param {object} tx a transaction client
 * @param {object} input
 * @param {string} input.agentId
 * @param {string} input.reason
 * @returns {Promise<number>} rows suppressed
 */
async function suppressOutstandingForAgent(tx, input) {
  if (!isTransactionClient(tx)) {
    throw new TypeError(
      "suppression accompanies the authority_epoch advance that justifies it and MUST share its transaction " +
        "(§4.1 rule 5, §11.5)",
    );
  }
  const settings = input || {};
  const result = await tx.outbox.updateMany({
    where: { agentId: settings.agentId, state: { in: OUTSTANDING_STATES } },
    data: { state: OUTBOX_STATE.SUPPRESSED, lastError: settings.reason || "DEDUP_STATE_RESET" },
  });
  return result.count;
}

/**
 * Expire rows whose `not_valid_after` has passed without acknowledgement (§23.3).
 *
 * @param {object} prisma
 * @param {Date} storeTime
 * @returns {Promise<number>}
 */
async function expirePastValidity(prisma, storeTime) {
  const result = await prisma.outbox.updateMany({
    // `DELIVERY_OBLIGATION_STATES`, not `OUTSTANDING_STATES`: see that constant's note.
    // A row awaiting its §11.4 step-2 withdrawal is not discharged by its own envelope
    // going stale.
    where: { state: { in: DELIVERY_OBLIGATION_STATES }, notValidAfter: { lte: storeTime } },
    data: { state: OUTBOX_STATE.EXPIRED, lastError: "NOT_VALID_AFTER_PASSED" },
  });
  return result.count;
}

/**
 * §11.1 item 3 — *"Outbox depth and oldest-undelivered-age are primary SLIs — a
 * rising value is direct evidence that commitments are not reaching agents."*
 *
 * Phase 11 owns the metric set and its export surface; this returns the two numbers
 * so that the drain worker can emit them from the day the outbox exists rather than
 * from the day the observability phase lands.
 *
 * @param {object} prisma
 * @param {Date} storeTime
 * @returns {Promise<{ depth: number, oldestUndeliveredAgeSeconds: number, unacknowledged: number }>}
 */
async function readSli(prisma, storeTime) {
  const depth = await prisma.outbox.count({ where: { state: { in: OUTSTANDING_STATES } } });

  // "Undelivered" is read off `deliveredAt`, not off the state name. A row that was
  // delivered and never acknowledged is a *different* SLI — it is counted separately
  // below, because an agent that received an offer and said nothing is a different
  // failure from an agent that never received it (§11.4), and one number cannot page
  // the right team for both.
  const oldest = await prisma.outbox.findMany({
    where: { state: { in: OUTSTANDING_STATES }, deliveredAt: null },
    orderBy: { createdAt: "asc" },
    take: 1,
  });

  const unacknowledged = await prisma.outbox.count({
    where: { state: OUTBOX_STATE.UNACKNOWLEDGED },
  });

  const ageSeconds =
    oldest.length > 0
      ? Math.max(0, Math.floor((storeTime.getTime() - new Date(oldest[0].createdAt).getTime()) / MILLIS_PER_SECOND))
      : 0;

  return { depth, oldestUndeliveredAgeSeconds: ageSeconds, unacknowledged };
}

/** @structural milliseconds per second — a unit conversion, not a threshold */
const MILLIS_PER_SECOND = 1000;

/**
 * How many batches' worth of candidates one claim pass reads before filtering them
 * through §11.3's backoff. See `claim`'s note on starvation.
 * @structural the claim query's over-read, expressed in batches
 */
const CANDIDATE_WINDOW_MULTIPLE = 4;

module.exports = {
  CANDIDATE_WINDOW_MULTIPLE,
  OUTBOX_STATE,
  TERMINAL_STATES,
  OUTSTANDING_STATES,
  DELIVERY_OBLIGATION_STATES,
  isTerminal,
  isOutstanding,
  isTransactionClient,
  buildRow,
  enqueue,
  assessDeliverability,
  claim,
  recordAttempt,
  settleRow,
  suppressOutstandingForAgent,
  expirePastValidity,
  readSli,
};

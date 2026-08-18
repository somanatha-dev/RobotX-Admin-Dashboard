"use strict";

/**
 * The outbox drain worker (§11.1 item 2, §11.3, §11.4).
 *
 * > Dispatcher workers claim outbox rows, deliver, and mark them delivered. Delivery
 * > is at-least-once; the agent deduplicates on `(commitment_id, sequence, fence)` for
 * > mission commands and on `(agent_id, sequence, authority_epoch)` for agent commands
 * > (§10.5), against the **durable** deduplication state specified in §11.5.
 *
 * One pass is: claim → deliver → record → escalate → expire → emit SLIs. Each is
 * idempotent, so a worker killed at any point leaves work another worker (or the same
 * one after restart) picks up. That is not a bonus property; it is the requirement,
 * because a claim held by a dead process is exactly the "stuck with no owner" class
 * §12.1 exists to eliminate — which is why claims carry an expiry and expired claims
 * are reclaimable.
 *
 * ── Why the expiry sweep runs last, not first ───────────────────────────────
 * An `OFFER`'s `not_valid_after` **is** its offer TTL (`offers.enqueueOffer` sets them
 * to the same instant, deliberately, so the transport cannot deliver an offer the
 * engine has already withdrawn). Sweeping expiries before escalating therefore moved
 * every unanswered offer to the terminal `EXPIRED` state in the very pass its TTL
 * lapsed — and §11.4 step 2, whose trigger is exactly "no ACK within
 * `dispatch.offer_ttl`", then found nothing to act on. The commitment stayed held, the
 * Leg stayed `OFFERED`, and the ladder's substantive rung could never be reached.
 *
 * Nothing is lost by the reorder, because the expiry sweep was never what stopped a
 * stale command being sent: `outbox.claim` filters on `notValidAfter > now` and
 * `assessDeliverability` re-checks it immediately before the transport call. The sweep
 * is bookkeeping over rows nobody will deliver, and bookkeeping belongs after the
 * decisions it records.
 *
 * ── This worker is built, tested, and not started ───────────────────────────
 * `ENGINE_ENABLED` is false and Phase 15 is what moves engine workers "from shadow to
 * production scheduling". Nothing in `server.js` calls `start()`. The worker is
 * exercised directly by its tests through `drainOnce`, which is also the shape the
 * Phase 10 coordinator will drive it in.
 *
 * ── Every collaborator is injected ──────────────────────────────────────────
 * The worker owns no client, no socket server, and no clock. It receives them, which
 * is what lets `drainOnce` be tested against a store model with real blocking row
 * locks rather than against a mock that agrees with whatever it is told.
 *
 * Tier 0 by path (`src/workers/outbox.worker.js`). Invariants I5, I16, I21.
 */

const clock = require("../engine/commitment/clock");
const escalation = require("../engine/dispatch/escalation");
const offers = require("../engine/dispatch/offers");
const outbox = require("../engine/dispatch/outbox");

/**
 * How many rows one pass claims. Bounded so a backlog is drained in bounded passes
 * rather than in one unbounded transaction, and so the oldest-undelivered-age SLI
 * moves during recovery instead of after it.
 * @structural the drain batch size; a work-partitioning constant, not a threshold
 */
const CLAIM_BATCH = 64;

/**
 * How long a claim lease lasts, as a multiple of the retry window. Derived rather than
 * registered: the lease exists only to bound how long a dead worker's rows are
 * invisible, and tying it to the window the ladder already governs means one parameter
 * moves both.
 * @structural the claim lease, expressed as a multiple of dispatch.retry_window
 */
const CLAIM_TTL_MULTIPLE = 2;

/**
 * The two advisory cache keys the plan names.
 *
 * **Advisory** is the whole specification of them (§3.3's cache-authority rule): the
 * database is authoritative for both facts, and losing either key costs an operator a
 * fast read, never a command. They are written **here**, in the worker, rather than in
 * `dispatch/**`, for two reasons:
 *
 *   1. No module under `src/engine/dispatch/` imports the cache, and a test asserts it.
 *      That is invariant I16 as a structural property — "cache loss cannot lose,
 *      duplicate, or double-grant a commitment" — and it would be weakened by an
 *      import that a later change could quietly make load-bearing.
 *   2. The offer mirror is written at **delivery**, not at enqueue. Writing it at
 *      enqueue would put a cache write inside the commit transaction: an external
 *      side effect before the write that authorises it commits, which is precisely
 *      what §4.1 rule 5 forbids.
 *
 * Every write is wrapped and every failure is swallowed. A cache that is down must not
 * stop a command reaching an agent.
 */
const CLAIM_KEY = (workerId) => `engine:outbox:claim:${workerId}`;
const OFFER_KEY = (commitmentId) => `engine:offer:${commitmentId}`;

/**
 * @param {object|null|undefined} cache a `kv`-shaped client, or nothing
 * @param {string} key
 * @param {string} value
 * @param {number} ttlSeconds
 */
async function writeAdvisory(cache, key, value, ttlSeconds) {
  if (!cache || typeof cache.set !== "function") return false;
  try {
    await cache.set(key, value, { ex: Math.max(1, Math.ceil(ttlSeconds)) });
    return true;
  } catch {
    // Advisory. Loss degrades an operator's fast read, never a dispatch.
    return false;
  }
}

/**
 * Run one drain pass.
 *
 * @param {object} deps
 * @param {object} deps.prisma
 * @param {(agentId: string, envelope: object) => Promise<{ delivered: boolean, detail?: string }>} deps.deliver
 *   the transport arm — `services/commandDispatcher.service.js` in production
 * @param {() => Promise<Date>} deps.readStoreTime
 * @param {(event: string, detail: object) => void} [deps.record] SLI and escalation sink
 * @param {{ set: Function }} [deps.advisoryCache] the two advisory mirrors; entirely
 *   optional, and every write to it is best-effort (see `writeAdvisory`)
 * @param {(fn: (tx: object) => Promise<*>) => Promise<*>} [deps.runInTransaction] the
 *   transaction the §11.4 step-2 withdrawal is written in. Optional, and its absence is
 *   a *reduced* posture rather than a silent one: without it a timed-out offer is marked
 *   `UNACKNOWLEDGED` and stays an outstanding obligation, visible to the SLI, until a
 *   pass that does have the seam performs the withdrawal
 * @param {object} config resolved parameters
 * @param {number} config.retryWindowSeconds `dispatch.retry_window`
 * @param {number} config.offerTtlSeconds `dispatch.offer_ttl`
 * @param {number} config.unresponsiveStrikes `health.unresponsive_strikes`
 * @param {number} config.systemicThreshold `dispatch.systemic_threshold`
 * @param {number} [config.maxDeliveryDelaySeconds] `dispatch.max_delivery_delay`, the
 *   `not_valid_after` the `WITHDRAW` itself carries
 * @param {number} [config.nackCooloffSeconds] `dispatch.nack_cooloff`
 * @param {string|Buffer} [config.signingKey] §23.3 — the key the `WITHDRAW` is signed with
 * @param {string} workerId
 * @returns {Promise<object>} a summary of the pass
 */
async function drainOnce(deps, config, workerId) {
  requireDeps(deps);
  const settings = config || {};
  const storeTime = await deps.readStoreTime();
  const record = typeof deps.record === "function" ? deps.record : () => {};

  const claimTtlSeconds = settings.retryWindowSeconds * CLAIM_TTL_MULTIPLE;
  const claimed = await outbox.claim(deps.prisma, {
    workerId,
    storeTime,
    limit: CLAIM_BATCH,
    claimTtlSeconds,
    // §11.3 — "Retries use bounded exponential backoff with jitter." The policy lives in
    // `escalation.js`, which already owns the schedule; the worker is what applies it,
    // because the claim is where a retry is either taken or deferred. Passing it as a
    // predicate rather than importing `escalation` into `outbox.js` keeps the store
    // module free of the ladder that reads it (the dependency runs the other way).
    isRetryDue: (row) =>
      escalation.isRetryDue({ row, storeTime, retryWindowSeconds: settings.retryWindowSeconds }),
  });

  // Advisory mirror of what this worker holds. The database already holds
  // `claimedBy`/`claimExpiresAt`, which is what the reclaim path reads.
  if (claimed.length > 0) {
    await writeAdvisory(
      deps.advisoryCache,
      CLAIM_KEY(workerId),
      JSON.stringify({ ids: claimed.map((row) => row.id), claimedAt: storeTime.toISOString() }),
      claimTtlSeconds,
    );
  }

  const summary = { claimed: claimed.length, delivered: 0, undelivered: 0, escalated: 0, withdrawn: 0, expired: 0 };

  for (const row of claimed) {
    const deliverability = outbox.assessDeliverability(row, storeTime);
    if (!deliverability.deliverable) {
      await outbox.settleRow(deps.prisma, {
        id: row.id,
        state: outbox.OUTBOX_STATE.EXPIRED,
        storeTime,
        detail: deliverability.reason,
      });
      continue;
    }

    let outcome;
    try {
      outcome = await deps.deliver(row.agentId, envelopeOf(row));
    } catch (error) {
      // §11.3 — "Bounded retry with escalation, **not silent retry**." A transport
      // exception is an undelivered attempt with a recorded cause, never a swallowed
      // one; the baseline's swallowed dispatch exception is the defect §11.1 names.
      outcome = { delivered: false, detail: error && error.message ? error.message : "DELIVERY_THREW" };
    }

    const applied = await outbox.recordAttempt(deps.prisma, {
      id: row.id,
      workerId,
      delivered: Boolean(outcome && outcome.delivered),
      storeTime,
      error: outcome && outcome.detail,
    });

    if (applied !== 1) {
      // The claim lapsed and another worker took the row. Not an error: at-least-once
      // delivery plus agent-side dedup is what makes the overlap harmless.
      record("outbox.claim_lapsed", { id: row.id, workerId });
      continue;
    }

    if (outcome && outcome.delivered) {
      summary.delivered += 1;
      if (row.command === "OFFER" && row.commitmentId) {
        // Advisory mirror of the offer's TTL, written at delivery. The authoritative
        // deadline is `Outbox.notValidAfter`, which the expiry sweep and the escalation
        // ladder both read from the store.
        const remainingSeconds = (new Date(row.notValidAfter).getTime() - storeTime.getTime()) / MILLIS_PER_SECOND;
        if (remainingSeconds > 0) {
          await writeAdvisory(
            deps.advisoryCache,
            OFFER_KEY(row.commitmentId),
            JSON.stringify({ outboxId: row.id, expiresAt: new Date(row.notValidAfter).toISOString() }),
            remainingSeconds,
          );
        }
      }
    } else {
      summary.undelivered += 1;
    }
  }

  const ladder = await escalateOutstanding(deps, settings, storeTime, record);
  summary.escalated = ladder.escalated;
  summary.withdrawn = ladder.withdrawn;

  // §23.3 — a command past `not_valid_after` is not retried, it is expired. "The world
  // has moved on." Last in the pass; see the module header for why.
  summary.expired = await outbox.expirePastValidity(deps.prisma, storeTime);
  if (summary.expired > 0) record("outbox.expired", { count: summary.expired });

  const sli = await outbox.readSli(deps.prisma, storeTime);
  record("outbox.sli", sli);

  return { ...summary, ...sli, storeTime };
}

/**
 * §11.4 step 2's action, performed — *"withdraw offer at an advanced commitment fence,
 * release the commitment, mark agent `dispatch_unresponsive`, re-plan the Leg excluding
 * it."*
 *
 * The whole of it is one transaction, because the fence advance and the `WITHDRAW` that
 * carries it are §4.1 rule 5's worked example. The outbox row's own terminal transition
 * joins that transaction for the same reason: a row marked discharged in a transaction
 * that then rolled back would be a withdrawal nobody performed and nobody would retry.
 *
 * Every path is convergent — the row leaves `UNACKNOWLEDGED` on success, and stays
 * there for the next pass on transient failure. A row can therefore neither be lost nor
 * retried forever against a Leg that has moved on.
 *
 * @param {object} deps
 * @param {object} settings
 * @param {object} row the outbox row that reached step 2
 * @param {Date} storeTime
 * @returns {Promise<{ withdrawn: boolean, detail: string }>}
 */
async function performWithdrawal(deps, settings, row, storeTime) {
  return deps.runInTransaction(async (tx) => {
    const commitment = await tx.commitment.findUnique({ where: { commitmentId: row.commitmentId } });

    // The offer is moot: something already released this commitment, or the Leg has
    // moved on under a path that owns it (an ACCEPT that raced the deadline, a
    // reconciler repair). Withdrawing would advance a fence for authority nobody holds.
    if (!commitment || (commitment.releasedAt !== null && commitment.releasedAt !== undefined)) {
      await outbox.settleRow(tx, {
        id: row.id,
        state: outbox.OUTBOX_STATE.FAILED,
        storeTime,
        detail: "COMMITMENT_ALREADY_RELEASED",
      });
      return { withdrawn: false, detail: "COMMITMENT_ALREADY_RELEASED" };
    }

    const leg = await tx.leg.findUnique({ where: { id: commitment.legId } });
    if (!leg || leg.state !== offers.LEG_STATE.OFFERED) {
      await outbox.settleRow(tx, {
        id: row.id,
        state: outbox.OUTBOX_STATE.FAILED,
        storeTime,
        detail: `OFFER_SUPERSEDED_LEG_STATE_${leg ? leg.state : "MISSING"}`,
      });
      return { withdrawn: false, detail: "OFFER_SUPERSEDED" };
    }

    const agent = await tx.agent.findUnique({ where: { id: commitment.agentId } });
    if (!agent) {
      await outbox.settleRow(tx, {
        id: row.id,
        state: outbox.OUTBOX_STATE.FAILED,
        storeTime,
        detail: "AGENT_MISSING",
      });
      return { withdrawn: false, detail: "AGENT_MISSING" };
    }

    await offers.withdrawExpiredOffer(tx, {
      commitment,
      agent,
      leg,
      storeTime,
      reason: "OFFER_TTL_EXPIRED",
      maxDeliveryDelaySeconds: settings.maxDeliveryDelaySeconds,
      nackCooloffSeconds: settings.nackCooloffSeconds,
      signingKey: settings.signingKey,
    });

    // Terminal, and terminal as `FAILED` rather than `EXPIRED`: this obligation did not
    // merely go stale, it was superseded by an authority the engine issued, and §11.3's
    // "exhaustion escalates rather than being discarded" is what `FAILED` records.
    await outbox.settleRow(tx, {
      id: row.id,
      state: outbox.OUTBOX_STATE.FAILED,
      storeTime,
      detail: "WITHDRAWN_AT_ADVANCED_FENCE",
    });

    return { withdrawn: true, detail: "WITHDRAWN_AT_ADVANCED_FENCE" };
  });
}

/**
 * Walk the outstanding rows, place each on §11.4's ladder, and perform step 2.
 *
 * Steps 1 and 2 are per row; step 3 is per agent; step 4 is per shard. The worker
 * performs steps 1 and 2 — the retry, which is the next pass, and the withdrawal, which
 * is `offers.withdrawExpiredOffer` run in the worker's own transaction. Step 3's
 * availability-index removal and step 4's degraded-mode entry are recorded as
 * directives, because their owners are Phase 9's index and Phase 12's mode register
 * respectively, and building either of them here would be building a second one.
 *
 * ── Why step 2 is performed and not merely reported ─────────────────────────
 * §11.4's rungs are actions, not observations. A ladder that stops at "mark the row"
 * leaves the commitment held, the capacity slot occupied, and the Leg `OFFERED`
 * forever — the shape of every defect in the audit's "stuck `ASSIGNED`" family, arrived
 * at from inside the mechanism that was supposed to prevent it. The fence advance and
 * the `WITHDRAW` it authorises are written together (§4.1 rule 5); what belongs to a
 * later phase is *re-planning* the freed Leg, which the round already does for any Leg
 * in `QUEUED`.
 *
 * @param {object} deps
 * @param {object} settings
 * @param {Date} storeTime
 * @param {Function} record
 * @returns {Promise<{ escalated: number, withdrawn: number }>}
 */
async function escalateOutstanding(deps, settings, storeTime, record) {
  const outstanding = await deps.prisma.outbox.findMany({
    where: { state: { in: outbox.OUTSTANDING_STATES } },
    orderBy: { createdAt: "asc" },
    take: CLAIM_BATCH,
  });

  let escalated = 0;
  let withdrawn = 0;
  const unresponsiveAgents = new Set();

  for (const row of outstanding) {
    const verdict = escalation.assessRow({
      row,
      storeTime,
      retryWindowSeconds: settings.retryWindowSeconds,
      offerTtlSeconds: settings.offerTtlSeconds,
    });

    if (verdict.step === escalation.ESCALATION_STEP.NONE) continue;
    escalated += 1;

    if (verdict.step === escalation.ESCALATION_STEP.WITHDRAW) {
      // The mark first, unconditionally and in its own statement: it is what §11.4
      // step 2 means by "mark agent `dispatch_unresponsive`", it is the evidence step 3
      // counts, and it must survive a withdrawal that fails. `UNACKNOWLEDGED` is an
      // outstanding state, so the row stays visible to the depth SLI and to §11.5's
      // suppression until the withdrawal actually lands.
      await outbox.settleRow(deps.prisma, {
        id: row.id,
        state: outbox.OUTBOX_STATE.UNACKNOWLEDGED,
        storeTime,
        detail: verdict.reason,
      });
      unresponsiveAgents.add(row.agentId);

      const withdrawal = await withdrawIfOwed(deps, settings, row, storeTime, record);
      if (withdrawal.withdrawn) withdrawn += 1;

      record("dispatch.escalation", {
        step: verdict.step,
        action: verdict.action,
        outboxId: row.id,
        agentId: row.agentId,
        commitmentId: row.commitmentId,
        reason: verdict.reason,
        withdrawal: withdrawal.detail,
      });
      continue;
    }

    record("dispatch.escalation", {
      step: verdict.step,
      action: verdict.action,
      outboxId: row.id,
      agentId: row.agentId,
      reason: verdict.reason,
      // Reported with the same jitter the claim path enforces, so the logged schedule
      // and the applied schedule are one number rather than two that can disagree.
      backoffSeconds: escalation.backoffSeconds({
        attempts: row.attempts,
        retryWindowSeconds: settings.retryWindowSeconds,
        jitterFraction: escalation.jitterFractionFor(row.id),
      }),
      retryDueAt: escalation.retryDueAt({ row, retryWindowSeconds: settings.retryWindowSeconds }),
    });
  }

  for (const agentId of unresponsiveAgents) {
    const recentOffers = await deps.prisma.outbox.findMany({
      where: { agentId, command: "OFFER" },
      orderBy: { createdAt: "desc" },
      take: settings.unresponsiveStrikes,
    });
    const verdict = escalation.assessAgent({ recentOffers, strikes: settings.unresponsiveStrikes });
    if (verdict.step === escalation.ESCALATION_STEP.AGENT_HEALTH) {
      record("dispatch.escalation", {
        step: verdict.step,
        action: verdict.action,
        agentId,
        consecutive: verdict.consecutive,
        reason: verdict.reason,
        ownedBy: "Phase 9 — candidates/availabilityIndex.js",
      });
    }
  }

  if (unresponsiveAgents.size > 0) {
    const totalAgents = await deps.prisma.agent.count();
    const verdict = escalation.assessShard({
      unresponsiveAgents: unresponsiveAgents.size,
      totalAgents,
      systemicThreshold: settings.systemicThreshold,
    });
    if (verdict.step === escalation.ESCALATION_STEP.SYSTEMIC) {
      record(
        "dispatch.escalation",
        escalation.systemicDirective({ fraction: verdict.fraction, threshold: settings.systemicThreshold }),
      );
    }
  }

  return { escalated, withdrawn };
}

/**
 * Is a withdrawal owed for this row, and can this worker perform it?
 *
 * Three outcomes, all of them recorded rather than silent:
 *
 *   - **Not owed.** Only an `OFFER` grants an authority a `WITHDRAW` supersedes. A
 *     `RECALL` or a `REROUTE` that goes unanswered is a delivery failure, not an
 *     outstanding offer, so the row goes terminal (`FAILED`) instead of accumulating
 *     forever in a state whose exit is an action that does not apply to it.
 *   - **Owed but unperformable.** No `runInTransaction` seam was supplied. The row
 *     stays `UNACKNOWLEDGED` — outstanding, counted, alertable — and a later pass with
 *     the seam wired performs it. Reduced posture, loudly.
 *   - **Owed and performed.** `performWithdrawal`, in one transaction.
 *
 * @param {object} deps
 * @param {object} settings
 * @param {object} row
 * @param {Date} storeTime
 * @param {Function} record
 * @returns {Promise<{ withdrawn: boolean, detail: string }>}
 */
async function withdrawIfOwed(deps, settings, row, storeTime, record) {
  if (row.command !== "OFFER" || !row.commitmentId) {
    await outbox.settleRow(deps.prisma, {
      id: row.id,
      state: outbox.OUTBOX_STATE.FAILED,
      storeTime,
      detail: "UNACKNOWLEDGED_AND_NOT_AN_OFFER",
    });
    return { withdrawn: false, detail: "NO_OFFER_TO_WITHDRAW" };
  }

  if (typeof deps.runInTransaction !== "function") {
    return { withdrawn: false, detail: "NO_TRANSACTION_SEAM_ROW_REMAINS_OUTSTANDING" };
  }

  try {
    return await performWithdrawal(deps, settings, row, storeTime);
  } catch (error) {
    // Left `UNACKNOWLEDGED` on purpose: the next pass finds it again, because
    // `assessRow` still returns step 2 for a row past its ack deadline. A failure here
    // is retried, never absorbed (§11.3).
    record("dispatch.withdrawal_failed", {
      outboxId: row.id,
      agentId: row.agentId,
      commitmentId: row.commitmentId,
      message: error && error.message,
    });
    return { withdrawn: false, detail: "WITHDRAWAL_FAILED_RETRY_NEXT_PASS" };
  }
}

/**
 * The wire envelope for one outbox row — §23.3's field set, verbatim.
 *
 * BigInt fences are rendered as decimal strings, because JSON has no BigInt and a
 * silent coercion to Number would lose precision above 2^53 while appearing to work
 * for every test fence anyone would write by hand.
 *
 * @param {object} row
 * @returns {object}
 */
function envelopeOf(row) {
  return {
    outboxId: row.id,
    command: row.command,
    commandClass: row.commandClass,
    fenceScope: row.fenceScope,
    agentId: row.agentId,
    commitmentId: row.commitmentId === undefined ? null : row.commitmentId,
    fence: row.fence === null || row.fence === undefined ? null : String(row.fence),
    authorityEpoch:
      row.authorityEpoch === null || row.authorityEpoch === undefined ? null : String(row.authorityEpoch),
    fenceFloor: row.fenceFloor === null || row.fenceFloor === undefined ? null : String(row.fenceFloor),
    sequence: row.sequence,
    notValidAfter:
      row.notValidAfter instanceof Date ? row.notValidAfter.toISOString() : new Date(row.notValidAfter).toISOString(),
    signature: row.signature,
    payload: row.payload,
  };
}

/**
 * @param {object} deps
 */
function requireDeps(deps) {
  if (!deps || !deps.prisma) throw new TypeError("the outbox worker needs a store client");
  if (typeof deps.deliver !== "function") {
    throw new TypeError(
      "the outbox worker needs a delivery arm. It never reaches for a socket itself: §11.3 requires delivery to " +
        "route by agent identity through a session registry that works across workers, and a worker holding its " +
        "own socket table would reintroduce the process-local delivery the audit already found",
    );
  }
  if (typeof deps.readStoreTime !== "function") {
    throw new TypeError("deadlines are judged against the Commitment Store's clock, never a worker's (§10.6)");
  }
}

/**
 * A running drain loop. Returned handle stops it.
 *
 * @param {object} deps as `drainOnce`
 * @param {object} config as `drainOnce`, plus `intervalMs`
 * @param {string} workerId
 * @returns {{ stop: () => void }}
 */
function start(deps, config, workerId) {
  requireDeps(deps);
  const settings = config || {};
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await drainOnce(deps, settings, workerId);
    } catch (error) {
      if (typeof deps.record === "function") {
        deps.record("outbox.drain_failed", { workerId, message: error && error.message });
      }
    }
  };

  const timer = setInterval(tick, settings.intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Read the store's clock through a client, for callers assembling `deps`.
 *
 * @param {object} prisma
 * @returns {Promise<Date>}
 */
function storeTimeReader(prisma) {
  return () => clock.readStoreTime(prisma);
}

/** @structural milliseconds per second — a unit conversion, not a threshold */
const MILLIS_PER_SECOND = 1000;

module.exports = {
  CLAIM_BATCH,
  CLAIM_TTL_MULTIPLE,
  CLAIM_KEY,
  OFFER_KEY,
  drainOnce,
  escalateOutstanding,
  withdrawIfOwed,
  performWithdrawal,
  envelopeOf,
  start,
  storeTimeReader,
};

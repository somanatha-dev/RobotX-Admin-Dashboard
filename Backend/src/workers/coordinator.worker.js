"use strict";

/**
 * The Assignment Coordinator (§3.2, §3.4, §9) — the shard round loop.
 *
 * > | Assignment Coordinator | Owns the round loop for one shard; **the only writer of
 * > HARD commitments in that shard**; holds the shard's round-local SOFT reservation
 * > state (§2.6) | L3 (commit) + L4 (plan state) | leader-elected; plan state in memory,
 * > reconstructed on failover | one active per shard |
 *
 * This worker is the owner the audit found missing. §5.2 item C6 of the execution plan
 * describes what it replaces: *"`setImmediate` detached background assignment with no
 * owner, timeout, retry, or observability"* → *"Supervised round loop owned by the shard
 * coordinator"*. Each of those four words is a property of this file:
 *
 *   - **Owner** — one leader-elected loop per shard, named in every `Round` row it writes.
 *   - **Timeout** — `solve.time_budget`, enforced by `solve/budgets.js`, anytime.
 *   - **Retry** — a Leg that a round does not assign stays `QUEUED` and is claimed by the
 *     next round. Nothing is lost by a round that fails, because nothing was removed from
 *     the queue that was not settled.
 *   - **Observability** — a `Round` row per round and a decision record per Leg, whatever
 *     the outcome, including the outcome "nothing was assigned, and here is why".
 *
 * ── The order of operations, and the two places it must not be reordered ────
 *
 * ```
 *   leadership → claim batch → snapshot → round.plan (L4) → commit (L3) → settle queue → record
 * ```
 *
 *   1. **Leadership before anything else.** §10.3.2 guard G1 fences the commit itself, so
 *      a stale leader cannot write; but a stale leader that *planned* would still consume
 *      routing budget and emit decision records for a shard it does not own. The check is
 *      cheap and it is first.
 *   2. **Settle the queue after the commit, never before.** A queue row moved to `SOLVED`
 *      before its commit landed would be a Leg removed from the queue with no commitment
 *      to show for it — the audit's "stuck at PENDING with no record" reproduced one layer
 *      down. Rows are claimed (visibly, with the round id) and settled only once the
 *      commit outcome is known.
 *
 * ── Failover: reconstructed, never recovered ────────────────────────────────
 * `resumeAfterFailover()` implements §19.5 exactly: Legs in `PLANNED` with no live HARD
 * commitment return to `QUEUED`; Legs in `PLANNED` *with* one are left alone, because an
 * agent has been told and guard G1 settles the previous leader's late in-flight commit.
 * No SOFT reservation is read from anywhere, because none was ever written.
 *
 * ── Built, tested, and not started ─────────────────────────────────────────
 * `ENGINE_ENABLED` is false; Phase 15 owns production scheduling. Nothing in `server.js`
 * calls `start()` — the same disposition every worker since Phase 4 has carried.
 *
 * Tier 1 by path (`src/workers/`). Invariants I3, I10, I18.
 */

const clock = require("../engine/commitment/clock");
const leadership = require("../engine/shard/leadership");
const snapshotModel = require("../engine/determinism/snapshot");
const cadence = require("../engine/solve/cadence");
const budgetModel = require("../engine/solve/budgets");
const planStateModel = require("../engine/shard/planState");
const round = require("../engine/solve/round");
const intake = require("../engine/intake/intake");
const legMachine = require("../engine/lifecycle/legMachine");
// PHASE 11 — §21.2's Tier A/Tier B writer. Phase 10 assembled a partial Tier A record
// inline here and said so; the complete §21.2 shape, the sampler, and the pinned input
// snapshot now belong to one module, and this worker calls it rather than restating it.
const decisionRecord = require("../engine/observability/decisionRecord");
const sampling = require("../engine/observability/sampling");

/** @structural milliseconds per second — a unit conversion, not a threshold */
const MS_PER_SECOND = 1000;

/**
 * The liveness key's time-to-live, as a multiple of the round window. Two windows, so a
 * loop that is merely slow does not look dead while a loop that has stopped does.
 * @structural the liveness TTL, expressed in round windows rather than as a threshold
 */
const LIVENESS_TTL_WINDOWS = 2;

/** Redis keys this worker owns. Both advisory (§3.3). @structural the key scheme */
const KEY = Object.freeze({
  /** Advisory queue mirror for a fast peek. **The database is authoritative.** */
  queue: (shardId) => `engine:queue:${shardId}`,
  /** Liveness only — never a lock, and never consulted for correctness. */
  currentRound: (shardId) => `engine:round:${shardId}:current`,
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** The lazily-created per-process Tier B write budget, keyed by nothing: one per process. */
let processRecordBudget = null;

/**
 * The Tier B write budget this process uses when the composition root injects none.
 *
 * Created once and reused, because §21.2 states the budget "per shard per minute" and a
 * budget rebuilt each round would reset the count every window — the bound would exist
 * in the code and never bind in practice, which is the failure mode worth guarding
 * against most: it looks correct in a unit test and admits unbounded volume in an
 * incident.
 *
 * @param {object} [observability] `{ writeBudgetPerMinute, reservoirSize }`
 * @returns {object}
 */
function defaultRecordBudget(observability) {
  if (processRecordBudget === null) {
    const settings = observability || {};
    processRecordBudget = sampling.createBudget({
      writeBudgetPerMinute: settings.writeBudgetPerMinute,
      reservoirSize: settings.reservoirSize,
    });
  }
  return processRecordBudget;
}

/**
 * Read the shard's queue state — depth, the SLA classes waiting, and the head of the
 * queue — from the **database**, which is authoritative.
 *
 * @param {object} deps `{ prisma }`
 * @param {string} shardId
 * @param {Date} storeTime
 * @returns {Promise<object>}
 */
async function readQueueState(deps, shardId, storeTime) {
  const where = {
    shardId,
    state: intake.QUEUE_STATE.QUEUED,
    OR: [{ availableAt: null }, { availableAt: { lte: storeTime } }],
  };

  const depth = await deps.prisma.workQueue.count({ where });
  const head = await deps.prisma.workQueue.findMany({
    where,
    orderBy: [{ priority: "asc" }, { enqueuedAt: "asc" }],
    take: isNumber(deps.peekLimit) ? deps.peekLimit : depth,
  });

  return {
    depth,
    head,
    slaClassesWaiting: [...new Set(head.map((row) => row.slaClass).filter(Boolean))],
  };
}

/**
 * Publish the advisory Redis mirror. Never read for correctness; a failure is a no-op.
 *
 * §3.3's cache-authority rule applies in full: this key exists so an operator surface can
 * peek at queue depth without a database round trip, and losing it costs nothing but that
 * convenience.
 *
 * @param {object} deps `{ kv }`
 * @param {string} shardId
 * @param {object} state
 * @returns {Promise<void>}
 */
async function publishQueueMirror(deps, shardId, state) {
  if (!deps.kv) return;
  try {
    await deps.kv.set(
      KEY.queue(shardId),
      JSON.stringify({ depth: state.depth, slaClassesWaiting: state.slaClassesWaiting }),
      { ex: deps.mirrorTtlSeconds },
    );
  } catch {
    // Advisory. The database is authoritative and the round already has its answer.
  }
}

/**
 * Claim a batch of queue rows for this round.
 *
 * The claim is a **conditional** write on `(id, state, version)`, so two coordinators
 * racing — which leadership makes impossible, and which this does not rely on it for —
 * produce one winner and one no-op without a distributed lock. The same discipline
 * `dispatch/outbox.claim()` uses for delivery obligations.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ shardId, roundId, storeTime, limit }`
 * @returns {Promise<object[]>} the rows this round now owns
 */
async function claimBatch(deps, input) {
  const candidates = await deps.prisma.workQueue.findMany({
    where: {
      shardId: input.shardId,
      state: intake.QUEUE_STATE.QUEUED,
      OR: [{ availableAt: null }, { availableAt: { lte: input.storeTime } }],
    },
    orderBy: [{ priority: "asc" }, { enqueuedAt: "asc" }],
    take: input.limit,
  });

  const claimed = [];
  for (const row of candidates) {
    // Captured before the write, not read back after it. The version this round holds is
    // the one it is about to install, and re-reading the row's own field afterwards would
    // make the claim's identity depend on whether the client returned a copy or a live
    // reference — a difference that is invisible until settlement silently matches
    // nothing and the batch is stranded in `CLAIMED`.
    const observedVersion = row.version;
    const claimedVersion = observedVersion + 1;

    // eslint-disable-next-line no-await-in-loop
    const result = await deps.prisma.workQueue.updateMany({
      where: { id: row.id, state: intake.QUEUE_STATE.QUEUED, version: observedVersion },
      data: {
        state: intake.QUEUE_STATE.CLAIMED,
        claimedByRoundId: input.roundId,
        claimedAt: input.storeTime,
        roundsConsidered: row.roundsConsidered + 1,
        version: claimedVersion,
      },
    });
    if (result.count === 1) {
      claimed.push({
        ...row,
        state: intake.QUEUE_STATE.CLAIMED,
        roundsConsidered: row.roundsConsidered + 1,
        claimedByRoundId: input.roundId,
        claimedAt: input.storeTime,
        version: claimedVersion,
      });
    }
  }

  return claimed;
}

/**
 * Settle the claimed rows against the round's per-Leg decisions.
 *
 * Assigned and deferred Legs leave the queue; everything else returns to `QUEUED` for the
 * next round. **Returning is the default**, and deliberately so: a Leg whose outcome this
 * function does not recognise must not be silently dropped, because a dropped Leg is
 * exactly the failure the whole phase exists to remove.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ claimed, result, storeTime }`
 * @returns {Promise<{ settled: number, requeued: number }>}
 */
async function settleBatch(deps, input) {
  const byLeg = new Map((input.result.decisions || []).map((row) => [String(row.legId), row]));
  let settled = 0;
  let requeued = 0;

  for (const row of input.claimed) {
    const decision = byLeg.get(String(row.legId));
    const leaves =
      decision &&
      (decision.outcome === round.LEG_OUTCOME.ASSIGNED || decision.outcome === round.LEG_OUTCOME.DEFERRED);

    // A Leg that was assigned but whose commit aborted stays in the queue: §10.3.2 —
    // "Any guard failure aborts the transaction and returns the pairing to the next round
    // with the cause recorded."
    const committed = (input.result.committed || []).some((entry) => String(entry.legId) === String(row.legId));
    const keeps = leaves && (decision.outcome === round.LEG_OUTCOME.DEFERRED || committed);

    // eslint-disable-next-line no-await-in-loop
    await deps.prisma.workQueue.updateMany({
      where: { id: row.id, version: row.version },
      data: keeps
        ? {
            state: intake.QUEUE_STATE.SOLVED,
            settledAt: input.storeTime,
            version: row.version + 1,
            ...(decision.outcome === round.LEG_OUTCOME.DEFERRED
              ? {
                  consecutiveDeferrals: row.consecutiveDeferrals + 1,
                  firstDeferredAt: row.firstDeferredAt || input.storeTime,
                }
              : {}),
          }
        : {
            state: intake.QUEUE_STATE.QUEUED,
            claimedByRoundId: null,
            claimedAt: null,
            version: row.version + 1,
          },
    });

    if (keeps) settled += 1;
    else requeued += 1;
  }

  return { settled, requeued };
}

/**
 * Write the `Round` row, the pinned `InputSnapshot`, and one Tier A decision record per
 * Leg — with Tier B where the sampler selects it.
 *
 * ── What changed at Phase 11, and why it is a delegation rather than an edit ─
 * Phase 10 assembled a partial Tier A record in this function and disclosed it as
 * partial: the leadership fence and the outcome were populated, and §21.2's remaining
 * sections were left `null` rather than fabricated. Phase 11 owns the complete shape,
 * the two tiers, the sampler, and the input snapshot, and all four now live behind
 * `observability/decisionRecord.writeRound()`.
 *
 * The delegation matters beyond tidiness. §21.2 requires the sampling draw to be taken
 * once, from the decision id, and recorded with the record; a coordinator that built its
 * own record and a writer that built another would give the two a chance to disagree
 * about which decisions were sampled, and the reconstruction-equivalence gate would then
 * be comparing populations rather than content.
 *
 * The `Round` row stays here: it is the round's own entity (§9), not a decision record,
 * and Phase 10 owns it.
 *
 * @param {object} deps `{ prisma, recordBudget }`
 * @param {object} input `{ shardId, roundId, result, storeTime, snapshot, cadenceVerdict,
 *   leadershipFence, instanceId, observability, perLeg, versions, trigger }`
 * @returns {Promise<object>} the writer's report
 */
async function recordRound(deps, input) {
  const result = input.result;

  await deps.prisma.round.create({
    data: {
      roundId: input.roundId,
      shardId: input.shardId,
      decisionTime: new Date(result.decisionTimeMs),
      leadershipFence: input.leadershipFence === undefined || input.leadershipFence === null ? null : BigInt(input.leadershipFence),
      coordinatorInstance: input.instanceId ?? null,
      snapshotRefs: input.snapshot ? { snapshotId: input.snapshot.snapshotId ?? null, pins: input.snapshot.pins ?? null } : null,
      seed: input.snapshot ? input.snapshot.seed ?? null : null,
      cadenceRegime: input.cadenceVerdict ? input.cadenceVerdict.regime : null,
      windowMs: input.cadenceVerdict ? input.cadenceVerdict.windowMs : null,
      regime: result.regime,
      budgets: {
        budgetLimited: result.budgets.budgetLimited,
        exceeded: result.budgets.exceeded.map((row) => ({ bound: row.bound, behaviour: row.behaviour })),
        counters: result.budgets.counters,
        wallClock: result.budgets.wallClock,
      },
      legCount: result.decisions.length,
      columnCount: result.columns.kept,
      agentCount: new Set(result.assignments.map((row) => row.agentId)).size,
      outcome: {
        outcome: result.outcome,
        note: result.note,
        assigned: result.assignments.length,
        deferred: result.deferrals.length,
        committed: (result.committed || []).length,
        aborted: (result.aborted || []).length,
        partitions: result.partitions.length,
        partitionMerges: result.partitionMerges.length,
      },
      // §9.3: reported separately, never summed. Carried as strings because int64
      // milli-CU does not survive a JSON number.
      //
      // I20: `result.searchGapMilliCU` is `null` when the round proved no search bound,
      // and `Round.searchGapMilliCU` is `String?` precisely so that absence is
      // representable. `String(null)` would write the four characters `"null"` into that
      // column — a value `metrics.js` would then read back through `BigInt(...)` and
      // throw on, and which no reader could tell from a real figure. The column is left
      // NULL instead, which is what "this round reported no bound" already means to every
      // consumer: `checkI20` skips it, and `metrics.search_gap` excludes it from the
      // median rather than counting it as zero.
      searchGapMilliCU: result.searchGapMilliCU === null || result.searchGapMilliCU === undefined
        ? null
        : String(result.searchGapMilliCU),
      lpIpGapMilliCU: String(result.lpIpGapMilliCU),
      completedAt: input.storeTime,
    },
  });

  // §21.2 in full — the pinned `InputSnapshot`, one Tier A per Leg with every section,
  // and Tier B where the deterministic sampler or the bounded exemption list selects it.
  // The budget is the shard's, held across rounds by the caller, because
  // `observability.tier_b_write_budget` is stated per shard per minute and a per-round
  // budget would reset it every few hundred milliseconds.
  const observability = input.observability || {};

  return decisionRecord.writeRound(deps, {
    // The coordinator knows the round's identity authoritatively — it minted it — so it
    // supplies it rather than depending on the L4 result to echo it back. The result
    // does carry both, and they agree; taking the coordinator's is what keeps the
    // `Round` row and its decision records provably about the same round.
    round: { ...result, roundId: input.roundId, shardId: input.shardId },
    context: {
      shardId: input.shardId,
      leadershipFence: input.leadershipFence,
      coordinatorInstance: input.instanceId,
      snapshot: input.snapshot,
      versions: input.versions,
      trigger: input.trigger,
      compactTopN: observability.compactTopN,
      // Per-Leg material the round does not carry: the Leg's SLA metadata, the candidate
      // summaries for the compact top-N, the rejection histogram §7.7 folded at decision
      // time, and — where the caller has it — the Tier B sections. Supplied by the
      // composition root rather than reassembled here, so this worker stays the thing
      // that runs a round and not a second place the record's shape is decided.
      perLeg: input.perLeg || {},
    },
    // The shard's budget, or this process's. Falling back here as well as at the call
    // site means `recordRound` can be exercised directly — by a test, or by a recovery
    // path — without silently writing Tier B against no budget at all.
    budget: deps.recordBudget || defaultRecordBudget(observability),
    config: {
      sampleRate: observability.sampleRate,
      compactTopN: observability.compactTopN,
      fullRetentionDays: observability.fullRetentionDays,
      tierBRetentionDays: observability.tierBRetentionDays,
      snapshotRetentionDays: observability.snapshotRetentionDays,
      tierARecordBytes: observability.tierARecordBytes,
    },
    nowMs: input.storeTime instanceof Date ? input.storeTime.getTime() : result.decisionTimeMs,
  });
}

/**
 * One round, end to end.
 *
 * @param {object} deps
 * @param {object} deps.prisma
 * @param {object} [deps.kv]
 * @param {object} deps.planState a `shard/planState.js` instance for this shard
 * @param {(input: object) => Promise<object>} deps.expandCandidates
 * @param {(agentId: string, legId: string, candidate: object) => object} deps.pricedCandidateFor
 * @param {(assignment: object, roundResult: object) => Promise<object>} deps.commit
 * @param {(leg: object) => object} [deps.deferPriceFor] Tier 2, injected
 * @param {object} input `{ shardId, config, killSwitches, instanceId, nowMs }`
 * @returns {Promise<object>}
 */
async function runRound(deps, input) {
  const source = input || {};
  const shardId = source.shardId || leadership.DEFAULT_SHARD_ID;
  const config = source.config || {};

  /* ── 1. Leadership, before any work is done on this shard's behalf ──────── */
  // The store's clock, not this worker's (§10.6). Read first because the leadership
  // margin is measured against it: a coordinator comparing its lease to its own wall
  // clock would extend its own authority by exactly its own skew.
  const storeTime = await clock.readStoreTime(deps.prisma);

  const shardLeadership = await leadership.readLeadership(deps.prisma, shardId);
  const stop = leadership.shouldStopCommitting({
    leaseExpiry: shardLeadership ? shardLeadership.leaseExpiry : null,
    storeTime,
    maxClockSkewMillis: config.maxClockSkewMillis,
    storeRoundTripMillis: config.storeRoundTripMillis,
  });
  if (stop.shouldStop) {
    // Refusing to plan, not merely refusing to commit. Guard G1 fences the commit
    // itself, so a stale leader could not write in any case; but one that planned would
    // still spend routing budget and emit decision records for a shard it does not own.
    return Object.freeze({ ran: false, reason: "NOT_LEADER", detail: stop.reason, marginMillis: stop.marginMillis, shardId });
  }

  /* ── 1b. Work the lifecycle handed back ─────────────────────────────────── */
  // A Leg returned to QUEUED after its first assignment (a rejected or expired OFFER, a
  // reassignment) still had its queue row SOLVED, so no round ever claimed it again.
  // Injected by the composition (`coordinatorSolvePath.create`); contained — a failure here
  // costs this round the returned Legs, never the round.
  if (typeof deps.requeueReturnedLegs === "function") {
    try {
      await deps.requeueReturnedLegs({ shardId, storeTime });
    } catch (error) {
      if (typeof deps.record === "function") {
        deps.record("coordinator.requeue_failed", { shardId, message: error && error.message });
      }
    }
  }

  /* ── 2. Cadence: the window and the batch cap (§9.2) ────────────────────── */
  const queueState = await readQueueState(deps, shardId, storeTime);
  await publishQueueMirror(deps, shardId, queueState);

  const cadenceVerdict = cadence.windowFor({
    queueDepth: queueState.depth,
    feasibleSupply: isNumber(source.feasibleSupply) ? source.feasibleSupply : 0,
    slaClassesWaiting: queueState.slaClassesWaiting,
    slaBudgetsSeconds: source.slaBudgetsSeconds,
    config,
  });

  if (queueState.depth === 0) {
    return Object.freeze({ ran: false, reason: "QUEUE_EMPTY", shardId, cadenceVerdict });
  }

  /* ── 3. Pin the round's inputs (§9.6 requirements 4–7) ──────────────────── */
  // The clock is read here, once, through the one module §9.6 permits to read one —
  // and never inside the round, which is why `solve/` passes the T6 scan.
  const decisionTimeMs = isNumber(source.nowMs) ? source.nowMs : snapshotModel.captureDecisionTime();
  const roundId = `${shardId}:${decisionTimeMs}`;
  const seed = snapshotModel.deriveSeed(roundId);

  deps.planState.beginRound(roundId);

  // The instant the round *started running here*, read from the local clock — deliberately
  // not `decisionTimeMs`.
  //
  // `decisionTimeMs` is an **input** (§9.6 requirement 4), and a caller that pins it pins it
  // to the *store's* clock, which §10.6 makes the authority for anything durable. Measuring
  // elapsed time as `Date.now() − decisionTimeMs` therefore subtracts one clock's instant
  // from another's, and charges the difference to §9.4's solve budget: at this config's own
  // tolerated `maxClockSkewMillis` of 1 000 ms, a skew four times the entire 250 ms
  // `solve.time_budget` is *within specification* and would exhaust the budget before the
  // first candidate is expanded. The round would then return its trivial incumbent — every
  // Leg deferred, nothing assigned — on a shard whose only fault was a clock a second out.
  //
  // Two clocks, two jobs: the store's instant decides *what the round sees* (and is pinned,
  // recorded, and replayed); the local clock measures *how long the round has taken*. This
  // read is in the worker, outside the decision path, exactly as before — §9.6 requirement 4
  // is about what the decision depends on, and no decision depends on this.
  const startedAtMs = Date.now();
  const budgets = budgetModel.create({
    config: {
      maxLegsPerRound: cadenceVerdict.maxLegsThisRound,
      maxEvaluatedPerLeg: config.maxEvaluatedPerLeg,
      maxColumnsPerRound: config.maxColumnsPerRound,
      branchNodeBudget: config.branchNodeBudget,
      timeBudgetMs: config.timeBudgetMs,
    },
    // The injected clock reference §9.4's wall-clock bound needs. It lives here, in the
    // worker, rather than inside `solve/`, which is what keeps the decision path free of
    // a clock literal (T6).
    elapsedMs: () => (typeof source.elapsedMs === "function" ? source.elapsedMs() : Date.now() - startedAtMs),
  });

  /* ── 4. Claim the batch ─────────────────────────────────────────────────── */
  const claimed = await claimBatch(deps, {
    shardId,
    roundId,
    storeTime,
    limit: cadenceVerdict.maxLegsThisRound,
  });

  if (claimed.length === 0) {
    return Object.freeze({ ran: false, reason: "NOTHING_CLAIMED", shardId, roundId, cadenceVerdict });
  }

  const snapshot = source.snapshot ?? { snapshotId: roundId, pins: source.pins ?? null, seed };

  /* ── 5–7. Plan (L4), commit (L3), and record ────────────────────────────── */
  let result;
  try {
    result = await round.execute(
      {
        expandCandidates: deps.expandCandidates,
        pricedCandidateFor: deps.pricedCandidateFor,
        planState: deps.planState,
        budgets,
        deferPriceFor: deps.deferPriceFor,
        commit: deps.commit,
      },
      {
        roundId,
        shardId,
        decisionTimeMs,
        legs: claimed.map((row) => ({
          legId: row.legId,
          priority: row.priority,
          purpose: row.purpose,
          slaClass: row.slaClass,
          expansionInput: (deps.expansionInputFor && deps.expansionInputFor(row)) || {},
        })),
        config,
        killSwitches: source.killSwitches || {},
        snapshot,
        // The fence read at step 1, pinned for §10.3.2's G1 — never re-read at commit.
        leadershipFence: shardLeadership ? shardLeadership.leadershipFence : null,
      },
    );
  } catch (error) {
    // A round that throws must still return its batch to the queue. Otherwise a defect in
    // the decision path becomes the audit's original failure — work claimed by a round
    // that vanished, visible nowhere, owned by nobody.
    //
    // Except a Leg this round already committed before it threw: its commitment and OFFER
    // are durable (§10.3.2 is one transaction per pairing), so returning it to the queue
    // would have the next round assign it a second time while the first agent executes it.
    for (const row of claimed) {
      // eslint-disable-next-line no-await-in-loop
      const held = await deps.prisma.commitment.count({ where: { legId: row.legId, releasedAt: null } });
      // eslint-disable-next-line no-await-in-loop
      await deps.prisma.workQueue.updateMany({
        where: { id: row.id, version: row.version },
        data:
          held > 0
            ? { state: intake.QUEUE_STATE.SOLVED, settledAt: storeTime, version: row.version + 1 }
            : { state: intake.QUEUE_STATE.QUEUED, claimedByRoundId: null, claimedAt: null, version: row.version + 1 },
      });
    }
    throw error;
  }

  const settlement = await settleBatch(deps, { claimed, result, storeTime });

  const recorded = await recordRound(
    {
      ...deps,
      // §21.2's write budget is per shard per minute. A coordinator that created one per
      // round would reset it every window and the bound would never bind; one created
      // here, lazily, survives for the life of the process, which is the life of the
      // leadership it holds.
      recordBudget: deps.recordBudget || defaultRecordBudget(source.observability),
    },
    {
      shardId,
      roundId,
      result,
      storeTime,
      snapshot,
      cadenceVerdict,
      leadershipFence: shardLeadership ? shardLeadership.leadershipFence : null,
      instanceId: source.instanceId,
      observability: source.observability,
      versions: source.versions,
      trigger: source.trigger,
      perLeg: source.perLeg,
    },
  );

  // Liveness only. Never a lock — leadership is (§19.5) and the commit's guard G1 is; a
  // Redis key that a partitioned coordinator could still hold would be exactly the
  // cache-carried exclusivity §3.1 removes.
  if (deps.kv) {
    try {
      await deps.kv.set(KEY.currentRound(shardId), JSON.stringify({ roundId, decisionTimeMs }), {
        ex: Math.max(1, Math.ceil((cadenceVerdict.windowMs * LIVENESS_TTL_WINDOWS) / MS_PER_SECOND)),
      });
    } catch {
      // Advisory.
    }
  }

  return Object.freeze({ ran: true, shardId, roundId, cadenceVerdict, result, settlement, recorded });
}

/**
 * Return to the queue every Leg the lifecycle put back into QUEUED after it had been
 * assigned — its queue row still says SOLVED, and a SOLVED row is never claimed.
 *
 * The Leg's state is the authority (§4.3); the queue row is this coordinator's work list,
 * so the row follows the Leg. A Leg that still holds a live commitment is left alone: that
 * is not returned work, whatever its state says.
 *
 * Measured on the V1 failure run (2026-09-23): a rejected OFFER and a reassignment after a
 * robot vanished each left a Leg in QUEUED with a SOLVED row, unserved for the rest of the
 * run while three robots stood idle.
 *
 * @param {object} deps `{ prisma }`
 * @param {{ shardId: string, storeTime: Date }} input
 * @returns {Promise<{ requeued: number }>}
 */
async function requeueReturnedLegs(deps, input) {
  const { shardId } = input || {};
  const returned = await deps.prisma.leg.findMany({
    where: {
      state: legMachine.LEG_STATE.QUEUED,
      workQueueEntry: { is: { shardId, state: intake.QUEUE_STATE.SOLVED } },
      commitments: { none: { releasedAt: null } },
    },
    select: { id: true },
  });

  let requeued = 0;
  for (const leg of returned) {
    // eslint-disable-next-line no-await-in-loop
    const result = await deps.prisma.workQueue.updateMany({
      where: { legId: leg.id, shardId, state: intake.QUEUE_STATE.SOLVED },
      data: { state: intake.QUEUE_STATE.QUEUED, claimedByRoundId: null, claimedAt: null, settledAt: null },
    });
    requeued += result.count;
  }
  return { requeued };
}

/**
 * §19.5 — the new leader's first act.
 *
 * @param {object} deps `{ prisma }`
 * @param {string} shardId
 * @returns {Promise<object>}
 */
async function resumeAfterFailover(deps, shardId) {
  const planned = await deps.prisma.leg.findMany({
    where: { state: "PLANNED" },
    include: { commitments: { where: { releasedAt: null } } },
  });

  const reconstruction = planStateModel.reconstructionPlan({
    plannedLegs: planned.map((leg) => ({
      legId: leg.id,
      state: leg.state,
      hasLiveCommitment: (leg.commitments || []).length > 0,
    })),
  });

  for (const legId of reconstruction.requeue) {
    // eslint-disable-next-line no-await-in-loop
    const leg = planned.find((row) => row.id === legId);
    // eslint-disable-next-line no-await-in-loop
    await deps.prisma.leg.updateMany({
      where: { id: legId, version: leg.version, state: "PLANNED" },
      data: { state: "QUEUED", version: leg.version + 1 },
    });
    // eslint-disable-next-line no-await-in-loop
    await deps.prisma.workQueue.updateMany({
      where: { legId, shardId },
      data: { state: intake.QUEUE_STATE.QUEUED, claimedByRoundId: null, claimedAt: null },
    });
  }

  return { shardId, ...reconstruction };
}

/**
 * Start the loop.
 *
 * Not called from `server.js`: `ENGINE_ENABLED` is false and Phase 15 owns moving engine
 * workers from shadow to production scheduling.
 *
 * @param {object} deps as `runRound`
 * @param {object} config `{ shardId, tickMs, ... }`
 * @returns {{ stop: () => void }}
 */
function start(deps, config) {
  const settings = config || {};
  let stopped = false;
  // One round at a time. `setInterval` does not wait for an async tick, so a round that ran
  // longer than the window used to overlap the next one — and the two shared this
  // assembly's per-round state (`planState.beginRound` resets it, `round.legs` is keyed by
  // Leg). On the V1 demonstration path (2026-09-23) that interleaving threw inside a round
  // that had already committed a Leg; the throw path returned the whole batch to the queue,
  // and a later round offered the same Leg to a second robot while the first was carrying
  // it. §19.3's "exactly one active Coordinator per shard" is about rounds, not processes.
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await runRound(deps, settings);
    } catch (error) {
      if (typeof deps.record === "function") {
        deps.record("coordinator.round_failed", { shardId: settings.shardId, message: error && error.message });
      }
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(tick, settings.tickMs || settings.config?.windowMinMs || MS_PER_SECOND);
  if (typeof timer.unref === "function") timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

module.exports = {
  KEY,
  MS_PER_SECOND,
  LIVENESS_TTL_WINDOWS,
  defaultRecordBudget,
  readQueueState,
  publishQueueMirror,
  claimBatch,
  settleBatch,
  recordRound,
  requeueReturnedLegs,
  runRound,
  resumeAfterFailover,
  start,
};

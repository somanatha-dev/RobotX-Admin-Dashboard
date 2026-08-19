"use strict";

/**
 * The shard supervisor (§19.2, §19.3, §19.5) — **Tier 1**.
 *
 * The plan's row for this worker names three jobs: **lease renewal, failover detection,
 * membership migration one agent at a time**. They are three separate passes here for the
 * same reason the Invariant Checker's three are separate — each has a different failure
 * disposition, and fusing them would give the most fragile one the power to stop the
 * others:
 *
 *   1. `renewalPass()` — hold the lease, or stand for election, or step down. Runs first
 *      and unconditionally, because everything below it is only lawful for a leader.
 *   2. `failoverPass()` — on a *fresh* acquisition, run the full §19.5 reconciliation and
 *      only then promote the session to one that may commit.
 *   3. `sizingPass()` — evaluate both §3.5 bounds and record the binding one.
 *   4. `migrationPass()` — perform **at most one** migration per tick, against the durable
 *      `ShardRebalance` intent the control plane recorded.
 *
 * ── Why the migration pass moves one agent per tick ─────────────────────────
 * §19.2 says migration proceeds "one at a time". A loop inside one tick would satisfy the
 * letter — each migration is still its own transaction — and lose the point: the pacing is
 * what keeps a rebalance from advancing several hundred `authority_epoch`s inside one
 * scheduling quantum, aborting every round in flight through guard G3 and producing a
 * burst of fence rejections that invariant I5's verification reads as a rising baseline.
 * One per tick, paced by `shard.migration_min_interval`, is the mechanism rather than the
 * decoration.
 *
 * ── Why the failover pass cannot be skipped ─────────────────────────────────
 * `election.promote()` is the only thing that sets `mayCommit`, and it demands a completed
 * reconciliation. A supervisor that omitted the failover pass would therefore never
 * produce a session the coordinator may commit under — the failure mode is "this shard
 * never resumes", which is loud, rather than "this shard resumed on half-written state",
 * which is not.
 *
 * ── Built, tested, and not started ─────────────────────────────────────────
 * `server.js` calls `start()` **only** when `ENGINE_ENABLED` is true, which it is not
 * until Phase 15 stages it per shard. The wiring exists because the plan's Phase 13 row
 * names `server.js`'s coordinator lifecycle as a file to modify; the gate exists because
 * every engine worker since Phase 4 has shipped unscheduled.
 */

const election = require("../engine/shard/election");
const failover = require("../engine/shard/failover");
const membership = require("../engine/shard/membership");
const shardModel = require("../engine/shard/shardModel");
const sizing = require("../engine/shard/sizing");

/**
 * Default renewal cadence, in milliseconds. Overridden from `shard.renewal_interval`.
 * @structural the loop's fallback cadence when no configuration is supplied
 */
const DEFAULT_INTERVAL_MS = 1500;

/** @structural milliseconds per second */
const MS_PER_SECOND = 1000;

/**
 * The advisory key the plan's Redis row reserves.
 *
 * > New: `engine:shard:leader:{shardId}` (**advisory hint only**; the consensus store is
 * > authoritative).
 * @structural the cache key shape
 */
const LEADER_HINT_KEY_PREFIX = "engine:shard:leader:";

/**
 * TTL on the advisory hint, in seconds.
 *
 * Deliberately short — a hint that outlived the lease it mirrors would tell a reader a
 * dead coordinator was leading, which is worse than telling it nothing. Its expiry costs a
 * database read, which is the whole reason a cached value is permitted to expire (§3.3).
 * @structural the hint's refresh horizon, not a behavioural threshold
 */
const LEADER_HINT_TTL_SECONDS = 30;

/**
 * §19.2 — at most this many agents migrate per tick.
 *
 * One. Not a tuning parameter and therefore not a register entry: it is the specification's
 * own word ("one at a time") expressed as a constant, and a deployment that wanted two
 * would be asking for the bulk reassignment §19.2 forbids.
 * @structural §19.2's "one at a time", as a number
 */
const MIGRATIONS_PER_TICK = 1;

/**
 * The pass every other pass is conditional on: hold the lease, take it, or let it go.
 *
 * @param {object} deps `{ store, now }`
 * @param {object} context `{ session, shardId, candidateId, storeTime, leaseDurationSeconds,
 *                            maxClockSkewMillis, storeRoundTripMillis }`
 * @returns {Promise<{ session: object, transition: string }>}
 */
async function renewalPass(deps, context) {
  const settings = context || {};
  const store = deps.store;
  const current = settings.session || election.followerSession(settings);

  if (current.state === election.LEADERSHIP_STATE.FOLLOWER) {
    const session = await election.acquire(store, {
      shardId: settings.shardId,
      candidateId: settings.candidateId,
      storeTime: settings.storeTime,
      leaseDurationSeconds: settings.leaseDurationSeconds,
    });
    return {
      session,
      transition: session.state === election.LEADERSHIP_STATE.LEADER ? "ACQUIRED" : "STILL_FOLLOWER",
    };
  }

  if (current.state === election.LEADERSHIP_STATE.STEPPING_DOWN) {
    // A stepping-down session releases what it can and returns to being a candidate. It
    // does not attempt to re-acquire in the same tick: the release advances the fence, and
    // re-acquiring immediately would advance it twice for one leadership change and give
    // a standby no window at all.
    const outcome = await election.release(store, current, { storeTime: settings.storeTime });
    return { session: outcome.session, transition: outcome.released ? "RELEASED" : "STOOD_DOWN_WITHOUT_RELEASE" };
  }

  const renewed = await election.renew(store, current, {
    storeTime: settings.storeTime,
    leaseDurationSeconds: settings.leaseDurationSeconds,
    maxClockSkewMillis: settings.maxClockSkewMillis,
    storeRoundTripMillis: settings.storeRoundTripMillis,
  });

  return {
    session: renewed,
    transition:
      renewed.state === election.LEADERSHIP_STATE.STEPPING_DOWN
        ? renewed.lastRefusal
          ? "LOST_LEASE"
          : "MARGIN_EXHAUSTED"
        : "RENEWED",
  };
}

/**
 * §19.5's reconciliation, run once per acquisition and never skipped.
 *
 * ── `reconcileConfig` and `maxPasses` are overrides, not dependencies ────────
 * Neither is supplied by `server.js`, and that is deliberate rather than an omission of the
 * kind P13-R1 and P13-R8 were. §12.4's own configuration lives with the **injected sweep**
 * — `server.js` binds `reconciler.sweep` with `sla.assignment_deadline`,
 * `health.unresponsive_strikes` and `energy.deviation_tolerance` already applied, and lets
 * this function's `shardId` win over them — so the sweep cannot be reached unconfigured by
 * any caller, which a settings key passed through this seam would not have guaranteed.
 * `maxPasses` falls back to `failover.DEFAULT_MAX_PASSES`, which is a loop bound rather
 * than a tuning parameter and has no register entry.
 *
 * `tests/engine/shardSchema.test.js` asserts that the binding carries all three values, so
 * the arrangement is checked rather than merely described.
 *
 * @param {object} deps `{ prisma, reconcile }`
 * @param {object} context `{ session, storeTime, reconcileConfig?, maxPasses? }`
 * @returns {Promise<{ session: object, result: object|null, ran: boolean }>}
 */
async function failoverPass(deps, context) {
  const settings = context || {};
  const session = settings.session;

  if (!session || session.state !== election.LEADERSHIP_STATE.LEADER) {
    return { session, result: null, ran: false };
  }
  if (session.reconciled === true) return { session, result: null, ran: false };

  const result = await failover.run(deps, {
    shardId: session.shardId,
    storeTime: settings.storeTime,
    reconcileConfig: settings.reconcileConfig,
    maxPasses: settings.maxPasses,
  });

  // Recorded whether or not it completed. A failover that ran out of passes is a fact the
  // shard row should carry: it is the difference between "this leader has not reconciled
  // yet" and "this leader tried and could not".
  await failover.persist(deps, { shardId: session.shardId, result, at: settings.storeTime });

  if (!result.complete) {
    // The session stays un-promoted, so `mayCommit` stays false and the coordinator runs
    // no round. Loud, and the right kind of loud.
    return { session, result, ran: true };
  }

  return { session: election.promote(session, result), result, ran: true };
}

/**
 * §3.5's two bounds, evaluated and recorded.
 *
 * Runs for a leader only. Both bounds are properties of the shard rather than of the
 * process, but the *write* is the single writer's: two coordinators recording sizing
 * verdicts for one shard would be two writers to a row, which is the thing §19.3 exists to
 * prevent, arrived at through a monitoring surface.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} context `{ session, storeTime, config, measurement }`
 * @returns {Promise<object|null>}
 */
async function sizingPass(deps, context) {
  const settings = context || {};
  const session = settings.session;
  if (!session || session.state !== election.LEADERSHIP_STATE.LEADER) return null;

  const config = settings.config || {};
  const measurement = settings.measurement || {};

  const shard = await shardModel.readShard(deps, session.shardId);
  if (!shard) return null;

  const evaluation = sizing.evaluate({
    serialCommit: {
      // The **observed** membership, not the configured maximum: §3.5's bound is about the
      // shard as it is, and reporting it against `shard.max_agents` would report the
      // headroom of a shard nobody is running.
      agents: shard.agentCount,
      missionRatePerAgentHour: config.missionRatePerAgentHour,
      txnPerMissionLifecycle: config.txnPerMissionLifecycle,
      commitTxnServiceTimeMs: config.commitTxnServiceTimeMs,
      maxSerialUtilisation: config.maxSerialUtilisation,
    },
    roundWallClock: {
      observedRoundWallClockP99Ms: measurement.roundWallClockP99Ms,
      roundWallClockBudgetMs: config.roundWallClockBudgetMs,
      samples: measurement.samples,
      minSamples: measurement.minSamples,
    },
  });

  await deps.prisma.shard.update({
    where: { shardId: session.shardId },
    data: sizing.toShardUpdate(evaluation, settings.storeTime),
  });

  return evaluation;
}

/**
 * The refusals that make a plan **un-executable** rather than merely blocked this tick.
 *
 * Both mean the target shard can no longer receive members. Retrying either forever would
 * hold the source shard out of service indefinitely, which is precisely the stranding the
 * durable intent was introduced to eliminate — so the intent is cancelled with the reason
 * and the shard goes back to serving. The agents that did not move are still where they
 * were, which is why cancelling is safe as well as terminating.
 * @structural the refusals that terminate an intent rather than retry it
 */
const FATAL_MIGRATION_REFUSALS = Object.freeze([
  membership.REFUSAL.TARGET_UNKNOWN,
  membership.REFUSAL.TARGET_NOT_ACCEPTING,
]);

/**
 * At most one migration per tick (§19.2), against the **durable** rebalance intent.
 *
 * Takes the plan rather than computing it, because *which* agents move where is a
 * control-plane decision — a split, a merge, a redistricting — and a supervisor that chose
 * for itself would be rebalancing a shard nobody asked it to rebalance. What the supervisor
 * owns is the **pacing**: one move, no sooner than `shard.migration_min_interval` after the
 * last.
 *
 * ── Where the plan comes from, and why it is not a settings key ──────────────
 * It used to be `settings.plan`, fixed at boot. Nothing ever set it, so this pass returned
 * `{ skipped: "NO_PLAN" }` on every tick of every deployment while
 * `POST /api/shards/:id/rebalance` moved shards to DRAINING and returned plans into HTTP
 * response bodies that were their only copy (P13-R4). It now reads
 * `ShardRebalance` — scoped to **this** shard as the source, which is what stops one
 * shard's coordinator executing another's — so the plan survives a restart, survives a
 * leadership handoff, and is executed by whichever process currently holds the lease.
 *
 * ── Why progress is recomputed rather than counted ──────────────────────────
 * What remains outstanding is derived every tick from current membership, so a process
 * that dies between a committed migration and its bookkeeping resumes correctly and no
 * agent is moved twice. `shardModel.outstandingMoves()` states that argument in full.
 *
 * @param {object} deps `{ prisma, runSerializable, selectForUpdate }`
 * @param {object} context `{ session, storeTime, minIntervalMs, commandTtlSeconds,
 *                            signingKey, movedBy }`
 * @returns {Promise<object>}
 */
async function migrationPass(deps, context) {
  const settings = context || {};
  const session = settings.session;

  if (!session || session.state !== election.LEADERSHIP_STATE.LEADER || session.mayCommit !== true) {
    return { migrated: 0, skipped: "NOT_A_COMMITTING_LEADER", outcomes: [] };
  }

  const rebalance = await shardModel.readOpenRebalance(deps.prisma, session.shardId);
  if (!rebalance) return { migrated: 0, skipped: "NO_OPEN_REBALANCE", outcomes: [] };

  const members = await membership.membersOf(deps.prisma, { shardId: session.shardId });
  const progress = shardModel.outstandingMoves({
    rebalance,
    currentMemberAgentIds: new Set(members.map((member) => String(member.agentId))),
  });

  // Nothing left to do. Terminalising here rather than only after a successful move is
  // what closes the crash window: a process that died between the last migration and its
  // bookkeeping arrives here on the next tick and finishes the job.
  if (progress.outstanding.length === 0) {
    const closed = await shardModel.closeRebalance(deps, {
      rebalance,
      state: shardModel.REBALANCE_STATE.COMPLETED,
      at: settings.storeTime,
      closedReason:
        `every planned move is resolved: ${rebalance.completedMoves} migrated, ${progress.resolved} no longer ` +
        `members of this shard, ${progress.blockedAgentIds.length} retired unmoved. Shard restored to ` +
        `${rebalance.restoreState} (§19.2).`,
    });
    return { migrated: 0, skipped: "PLAN_EXHAUSTED", rebalanceId: rebalance.id, closed, outcomes: [] };
  }

  // §19.2's pacing, timed from the **durable** last move rather than from an in-memory
  // value. In-memory would reset on every restart and every leadership change, which are
  // exactly the moments a fleet is least able to absorb a burst of `authority_epoch`
  // advances — and G3 aborts a round for every one of them.
  const minInterval = Number.isFinite(settings.minIntervalMs) ? settings.minIntervalMs : 0;
  const lastMoveAtMs = rebalance.lastMoveAt ? new Date(rebalance.lastMoveAt).getTime() : null;
  const since = lastMoveAtMs === null ? Number.POSITIVE_INFINITY : settings.storeTime.getTime() - lastMoveAtMs;
  if (since < minInterval) {
    return {
      migrated: 0,
      skipped: "PACED",
      waitedMs: since,
      minIntervalMs: minInterval,
      rebalanceId: rebalance.id,
      remaining: progress.outstanding.length,
      outcomes: [],
    };
  }

  // §23.3 — a command with no signature is one an attacker, or an innocent misrouted
  // queue, can synthesise. `commandSigning.sign` refuses an absent key and
  // `clock.deadlineFrom` refuses an absent TTL, both by throwing; a throw here would be
  // swallowed by the interval callback and present as a supervisor that never migrates.
  // Refused as a *reported* skip instead, so the reason reaches `GET /api/shards` and an
  // operator, and the intent stays open and cancellable rather than half-executed.
  if (!settings.signingKey || !Number.isFinite(settings.commandTtlSeconds) || settings.commandTtlSeconds <= 0) {
    return {
      migrated: 0,
      skipped: "NO_COMMAND_CREDENTIALS",
      rebalanceId: rebalance.id,
      remaining: progress.outstanding.length,
      detail:
        "§19.2's handoff enqueues a signed, time-bounded SHARD_MIGRATE (§23.3, §11.1). Without a signing key and a " +
        "positive command TTL this pass would either throw every tick or write an unsigned command; it does " +
        "neither. The intent stays open and can be cancelled through POST /api/shards/:id/rebalance.",
      outcomes: [],
    };
  }

  const outcomes = [];
  const effects = [];
  for (const move of progress.outstanding.slice(0, MIGRATIONS_PER_TICK)) {
    // eslint-disable-next-line no-await-in-loop
    const outcome = await membership.migrate(deps, {
      agentId: move.agentId,
      targetShardId: move.targetShardId,
      reason: move.reason,
      movedBy: settings.movedBy || "shardSupervisor",
      storeTime: settings.storeTime,
      commandTtlSeconds: settings.commandTtlSeconds,
      signingKey: settings.signingKey,
      allowCustodyTransfer: move.allowCustodyTransfer === true,
      // §19.3 — the fence this session believes it holds, re-read inside the migration's
      // own transaction. A coordinator superseded between choosing this move and
      // performing it must not advance an `authority_epoch`.
      leadershipGuard: {
        shardId: session.shardId,
        holder: session.candidateId,
        leadershipFence: session.leadershipFence,
      },
    });
    outcomes.push(outcome);

    if (outcome.ok) {
      // eslint-disable-next-line no-await-in-loop
      effects.push(await shardModel.recordRebalanceMove(deps, { rebalance, at: settings.storeTime }));
      continue;
    }

    if (outcome.refusal === membership.REFUSAL.HOLDS_CUSTODY) {
      // §2.5 — an accountable transfer, not an implicit one. Retire the move so the intent
      // can terminate, and record which agent and why: a shard held out of service by an
      // agent carrying a parcel is the failure mode of retrying this forever.
      // eslint-disable-next-line no-await-in-loop
      effects.push(
        await shardModel.blockRebalanceMove(deps, {
          rebalance,
          agentId: move.agentId,
          refusal: outcome.refusal,
          detail: outcome.detail,
          at: settings.storeTime,
        }),
      );
      continue;
    }

    if (FATAL_MIGRATION_REFUSALS.includes(outcome.refusal)) {
      // eslint-disable-next-line no-await-in-loop
      effects.push(
        await shardModel.closeRebalance(deps, {
          rebalance,
          state: shardModel.REBALANCE_STATE.CANCELLED,
          at: settings.storeTime,
          closedReason: `${outcome.refusal}: ${outcome.detail || "the plan can no longer be carried out"}`,
        }),
      );
    }
    // Everything else — a concurrent membership change, a superseded fence — is transient
    // by construction and is simply retried on the next tick.
  }

  const migrated = outcomes.filter((outcome) => outcome.ok).length;
  return {
    migrated,
    skipped: null,
    rebalanceId: rebalance.id,
    remaining: Math.max(0, progress.outstanding.length - migrated),
    effects,
    outcomes,
  };
}

/**
 * Publish the advisory leadership hint (§3.3, and the plan's Redis row).
 *
 * **The consensus store is authoritative and this is a hint**, and two properties keep
 * that honest rather than merely stated. It returns rather than throws on a cache failure
 * — losing the hint costs visibility, never correctness — and **nothing in this worker
 * ever reads it back**. A supervisor that cached its own leadership and then trusted the
 * cache would have promoted the cache tier to an authority over the one fact §19.3 is
 * least able to tolerate being wrong about.
 *
 * The payload is deliberately not the session. A reader that needed the session needs the
 * store, and a mirror rich enough to make decisions from is a mirror somebody will make
 * decisions from.
 *
 * @param {object} deps `{ kv }`
 * @param {object} input `{ session, nowMs }`
 * @returns {Promise<{ published: boolean, reason: string|null }>}
 */
async function publishLeaderHint(deps, input) {
  const settings = input || {};
  const session = settings.session;
  if (!deps || !deps.kv || !session) return { published: false, reason: "NO_CACHE_OR_SESSION" };

  try {
    await deps.kv.set(
      `${LEADER_HINT_KEY_PREFIX}${session.shardId}`,
      JSON.stringify({
        shardId: session.shardId,
        holder: session.state === election.LEADERSHIP_STATE.LEADER ? session.candidateId : null,
        // A string: the fence is a BigInt, and JSON has no representation for one that
        // survives a round trip.
        leadershipFence:
          session.leadershipFence === null || session.leadershipFence === undefined
            ? null
            : String(session.leadershipFence),
        mayCommit: session.mayCommit === true,
        at: settings.nowMs,
        authority: "the consensus store; this key is advisory (§3.3)",
      }),
      { ex: LEADER_HINT_TTL_SECONDS },
    );
    return { published: true, reason: null };
  } catch (error) {
    return { published: false, reason: error && error.message ? error.message : "CACHE_WRITE_FAILED" };
  }
}

/**
 * One full tick: renewal, then failover, then sizing, then at most one migration.
 *
 * The order is not arbitrary. Renewal decides whether this process is the leader at all;
 * failover decides whether it may act; sizing and migration are actions. Running any of
 * them before renewal would be acting on a leadership belief one tick out of date, which
 * over a lease duration is the whole vulnerability window §19.5 is written about.
 *
 * @param {object} deps
 * @param {object} context
 * @returns {Promise<object>}
 */
async function runOnce(deps, context) {
  const settings = context || {};
  const storeTime = settings.storeTime || new Date(typeof deps.now === "function" ? deps.now() : Date.now());

  const renewal = await renewalPass(deps, { ...settings, storeTime });
  const recovery = await failoverPass(deps, { ...settings, storeTime, session: renewal.session });
  const sizingResult = await sizingPass(deps, { ...settings, storeTime, session: recovery.session });
  // Unconditional. It used to be gated on `settings.plan`, a key nothing in production ever
  // set, so the pass never ran anywhere — the consumer half of P13-R4. The plan now lives
  // in `ShardRebalance` and the pass decides for itself whether there is one.
  const migration = await migrationPass(deps, { ...settings, storeTime, session: recovery.session });

  const hint = await publishLeaderHint(deps, { session: recovery.session, nowMs: storeTime.getTime() });

  return {
    storeTimeMs: storeTime.getTime(),
    session: recovery.session,
    transition: renewal.transition,
    failover: recovery.result,
    failoverRan: recovery.ran,
    sizing: sizingResult,
    migration,
    leaderHintPublished: hint.published,
    // The one question a coordinator asks this worker, answered in one place rather than
    // reconstructed from the four passes above.
    mayRunRound: recovery.session ? recovery.session.mayCommit === true : false,
  };
}

/**
 * The socket messages one tick produces, for a caller holding an `io`.
 *
 * Returned rather than emitted: this worker takes no Socket.IO dependency, matching every
 * engine worker since Phase 4. `SHARD_MIGRATE` itself is **not** here — it is an
 * agent-scope command and reaches its agent through the outbox and the drain worker
 * (§11.1), never through a broadcast. What is here is the dashboard's view of the same
 * events.
 *
 * @param {object} tick a `runOnce()` result
 * @returns {Array<{ event: string, payload: object }>}
 */
function socketMessages(tick) {
  const messages = [];
  const session = tick && tick.session;
  if (!session) return messages;

  if (tick.transition === "ACQUIRED" || tick.transition === "RELEASED" || tick.transition === "LOST_LEASE") {
    messages.push({
      event: "SHARD_LEADERSHIP_CHANGED",
      payload: {
        shardId: session.shardId,
        holder: session.state === election.LEADERSHIP_STATE.LEADER ? session.candidateId : null,
        leadershipFence: session.leadershipFence === null || session.leadershipFence === undefined ? null : String(session.leadershipFence),
        transition: tick.transition,
        at: tick.storeTimeMs,
      },
    });
  }

  for (const outcome of (tick.migration && tick.migration.outcomes) || []) {
    if (!outcome.ok) continue;
    messages.push({
      event: "SHARD_MIGRATED",
      payload: {
        agentId: outcome.agentId,
        fromShardId: outcome.fromShardId,
        toShardId: outcome.toShardId,
        authorityEpoch: String(outcome.authorityEpochAfter),
        at: tick.storeTimeMs,
      },
    });
  }

  return messages;
}

/**
 * Start the supervisor loop.
 *
 * @param {object} deps `{ prisma, store, reconcile, runSerializable, selectForUpdate, now, onError }`
 * @param {object} [context]
 * @returns {{ stop: () => void }}
 */
function start(deps, context) {
  const settings = context || {};
  const intervalMs = Number.isFinite(settings.intervalMs)
    ? settings.intervalMs
    : Number.isFinite(settings.renewalIntervalSeconds)
      ? settings.renewalIntervalSeconds * MS_PER_SECOND
      : DEFAULT_INTERVAL_MS;

  // The store is asserted **once, at start**, rather than on every tick. §19.5's
  // prohibition is about the deployment, not about the request, and a check that ran per
  // tick would be a check somebody could be tempted to make non-fatal.
  election.assertConsensusStore(deps.store);

  // ── The rest of the contract, asserted in the same place and for a sharper reason ──
  //
  // Every dependency below is reached from inside the interval callback, whose `.catch`
  // deliberately swallows a failed tick so one lost renewal cannot take the process down
  // (§19.3). That disposition is right for a *transient* failure and catastrophic for a
  // *structural* one: a missing dependency throws on every tick forever, the session
  // variable is never reassigned, and the supervisor sits in a follower loop logging a
  // tick error while looking alive. A composition that cannot work must therefore fail
  // here, at boot, where a deployment sees it — not once per tick, where nothing does.
  //
  // This assertion exists because that is precisely what happened: `server.js` supplied
  // four of the seven dependencies, and no test caught it because every test injects all
  // of them.
  const missing = [];
  if (!deps || !deps.prisma) missing.push("prisma (the store client)");
  if (!deps || typeof deps.reconcile !== "function") {
    missing.push("reconcile (§12.4's sweep — §19.5 forbids resuming rounds without it)");
  }
  if (!deps || typeof deps.runSerializable !== "function") {
    missing.push("runSerializable (§19.2's handoff opens the transaction the epoch advance lives in)");
  }
  if (!deps || typeof deps.selectForUpdate !== "function") {
    missing.push("selectForUpdate (§10.3.2 step 1's explicit row lock, taken on the migrating agent)");
  }
  if (missing.length > 0) {
    throw new TypeError(
      `the shard supervisor cannot start without ${missing.join("; ")}. A tick that throws is swallowed by design, ` +
        "so an incomplete composition would present as a live supervisor that never leads, never reconciles, and " +
        "never migrates. It is refused here instead.",
    );
  }
  if (!Number.isFinite(settings.leaseDurationSeconds) || settings.leaseDurationSeconds <= 0) {
    throw new RangeError(
      "the shard supervisor needs `shard.lease_duration` as a positive number of seconds. It sizes the leadership " +
        "lease every acquisition and renewal is written against (§19.5); without it `tryAcquire` cannot compute a " +
        "lease expiry and no leader is ever elected.",
    );
  }

  let session = election.followerSession({ shardId: settings.shardId, candidateId: settings.candidateId });

  const handle = setInterval(() => {
    runOnce(deps, { ...settings, session })
      .then((tick) => {
        session = tick.session;
        if (typeof settings.onTick === "function") settings.onTick(tick);
      })
      .catch((error) => {
        // A failed tick loses one renewal. It must not take the process down: the lease
        // will lapse on its own and a standby will take the shard, which is the designed
        // response to a coordinator that has stopped working (§19.3). Crashing here would
        // convert a recoverable failover into an outage of whatever else this process
        // hosts.
        if (deps && typeof deps.onError === "function") deps.onError(error);
      });
  }, intervalMs);

  if (typeof handle.unref === "function") handle.unref();

  return {
    stop() {
      clearInterval(handle);
    },
    /** The current session, for a shutdown drain that needs to release it. */
    session() {
      return session;
    },
  };
}

/**
 * Release leadership as part of a graceful shutdown (§19.3's availability argument).
 *
 * Separate from `stop()` because they are different acts: `stop()` ends the loop in this
 * process, and this hands the shard to a standby. A shutdown that only stopped the loop
 * would leave the shard unled until the lease lapsed — correct, but a full
 * `shard.lease_duration` of avoidable unavailability on every rolling deploy.
 *
 * @param {object} deps `{ store }`
 * @param {object} session
 * @param {object} input `{ storeTime }`
 * @returns {Promise<object>}
 */
async function drain(deps, session, input) {
  if (!session || session.state === election.LEADERSHIP_STATE.FOLLOWER) {
    return { released: false, refusal: "NOT_LEADER", session };
  }
  const outcome = await election.release(deps.store, session, { storeTime: (input || {}).storeTime });
  return { released: outcome.released, refusal: outcome.refusal, session: outcome.session };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  MIGRATIONS_PER_TICK,
  FATAL_MIGRATION_REFUSALS,
  LEADER_HINT_KEY_PREFIX,
  LEADER_HINT_TTL_SECONDS,
  renewalPass,
  failoverPass,
  sizingPass,
  migrationPass,
  publishLeaderHint,
  runOnce,
  socketMessages,
  start,
  drain,
  // Re-exported so a caller does not need a second import to read the vocabulary this
  // worker's own results are expressed in.
  LEADERSHIP_STATE: election.LEADERSHIP_STATE,
  SHARD_STATE: shardModel.SHARD_STATE,
};

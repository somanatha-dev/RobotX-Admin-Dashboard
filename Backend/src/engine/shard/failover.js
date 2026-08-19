"use strict";

/**
 * Failover — what a new leader does before it runs a round (§19.5) — **Tier 1**.
 *
 * > **On leadership acquisition**, the new leader runs a full reconciliation of the shard
 * > before resuming rounds. Resuming first and reconciling later invites acting on state
 * > the previous leader left half-written. Reconciliation has two distinct jobs, matching
 * > the two kinds of state (§2.6):
 * >
 * > - **Recover the durable state.** HARD commitments, leases, custody, and outbox rows
 * >   survived the failover and are authoritative. The new leader reads them, resolves any
 * >   half-written transition through the ordinary conditional-write discipline, and
 * >   re-establishes supervision.
 * > - **Reconstruct the volatile state.** SOFT reservations did not survive and are not
 * >   expected to. Legs found in `PLANNED` with no HARD commitment are returned to
 * >   `QUEUED` and re-planned in the first round. This is a *recomputation*, not a repair
 * >   […] The count of Legs reconstructed this way is emitted as a failover metric,
 * >   distinguishable from the reconciler's genuine orphan repairs (§12.4), so that an
 * >   expected consequence of failover is never mistaken for a defect signal.
 *
 * ── This module writes almost nothing, and that is the design ───────────────
 * Both jobs above are performed by machinery that already exists and is already the owner
 * of the write:
 *
 *   - The durable half is `supervision/reconciler.sweep()` — §12.4's nine divergence
 *     classes, each repaired by a conditional write, each recorded as a
 *     `ReconcilerRepair` row.
 *   - The volatile half is **the same sweep's orphan scan**, which Phase 5 already wrote
 *     to distinguish `EXPECTED_POST_FAILOVER` orphans (a Leg in `PLANNED` with no live
 *     commitment) from `DEFECT` orphans, and to requeue the first with aging credit.
 *
 * Re-implementing either here would give the shard two requeue paths with two versions of
 * the timer obligations §4.5 attaches, and the second one would be the one nobody
 * maintained. What this module adds is the three things the sweep cannot supply on its
 * own:
 *
 *   1. **An inventory of the durable state before anything is touched**, so a leader can
 *      say what it inherited rather than only what it repaired.
 *   2. **Completion**, in the sense §19.5 means: the sweep is batched, so a shard with
 *      more post-failover orphans than one batch is *not* reconciled after one pass.
 *      `run()` iterates until the reconstruction is exhausted or a bound is reached, and
 *      reports `complete: false` if it is not. `election.promote()` refuses to resume
 *      rounds on an incomplete result.
 *   3. **The failover metric, separated at the source.** The reconstructed count is read
 *      out of the sweep's own `EXPECTED_POST_FAILOVER` counter and reported as its own
 *      quantity, never summed into the repair rate. It is deliberately **not** written as
 *      a `ReconcilerRepair` row of a new category: §12.4's repair rate is an alertable
 *      SLI, and adding an expected-by-construction event to it would raise that SLI on
 *      every ordinary failover.
 *
 * ── Nothing is recovered ────────────────────────────────────────────────────
 * `shard/planState.reconstructionPlan()` is the pure statement of the volatile half, and
 * this module uses it to *predict* what the sweep will requeue so that prediction and
 * outcome can be compared. No SOFT reservation is read from any store, because none was
 * ever written to one (invariant I18).
 *
 * ── No clock ────────────────────────────────────────────────────────────────
 * Time is supplied. A failover is an event with a recorded instant, and a module that
 * read its own clock would timestamp the recovery with the moment the code happened to
 * run rather than the moment the leadership changed.
 */

const planState = require("./planState");
const shardModel = require("./shardModel");

/**
 * The durable categories §19.5 names as surviving a failover. Reported as an inventory,
 * not as repairs — the repairs are the reconciler's.
 * @structural the inventory's category vocabulary
 */
const DURABLE_CATEGORY = Object.freeze({
  HARD_COMMITMENTS: "HARD_COMMITMENTS",
  LEASES: "LEASES",
  CUSTODY: "CUSTODY",
  OUTBOX: "OUTBOX",
  TIMERS: "TIMERS",
});

/**
 * The custody states that hold goods, mirroring `domain/custody`'s `holdsGoods`
 * partition. `DISPUTED` is in the set for the reason §2.5 puts it there: "Unknown is
 * never permission (T2). Disputed evidence means the engine does not know where the goods
 * are, and 'does not know' resolves to 'may be holding'."
 *
 * Re-declared rather than imported for the same reason the Invariant Checker re-declares
 * its vocabulary: this module reports what a new leader *inherited*, and a report that
 * read its own partition from the module that maintains custody would inherit that
 * module's mistake and report a clean shard. `assertCustodyVocabularyAgrees()` compares
 * the two at build time, so independence at runtime costs nothing in drift.
 * @structural the custody states that hold goods (§2.5)
 */
const HOLDING_CUSTODY_STATES = Object.freeze(["DISPUTED", "HELD"]);

/**
 * The Leg state §19.5 names as the volatile half's subject.
 * @structural the state a SOFT reservation left behind
 */
const PLANNED = "PLANNED";

/**
 * The default bound on reconciliation passes.
 *
 * A bound rather than an unbounded loop, because "reconcile until nothing changes" is a
 * loop a persistent divergence turns into a leader that never resumes. Exceeding it
 * reports `complete: false`, which is a shard that needs an operator — the honest
 * outcome, and a much better one than a silent spin.
 * @structural the loop bound; exceeding it is reported, never defaulted away
 */
const DEFAULT_MAX_PASSES = 8;

/**
 * Which Legs belong to this shard?
 *
 * `Leg` carries no `shardId` column, deliberately: §3.5 routes a Leg to a shard **at
 * intake**, and the durable record of that routing decision is its `WorkQueue` row. This
 * function reads that record first and falls back to the Leg's mission region resolved
 * through the published map — which is the same rule intake applied, re-applied to a Leg
 * that predates the queue.
 *
 * In a single-shard deployment (no `Shard` rows published) every Leg belongs to the one
 * shard, and the function says so rather than returning an empty set: a failover that
 * reconciled nothing because it could not attribute anything would be a failover that
 * reported success having done nothing.
 *
 * ── The map is the **ownership** map, not the routing map ───────────────────
 * `shardModel.regionShardMap()` answers "where does a *new* Leg go" and therefore excludes
 * shards that admit no work. This function asks a different question — "which shard owns
 * the work already here" — and using the routing map for it was wrong in two directions,
 * both of which a working rebalance makes reachable, because a rebalance's whole job is to
 * put a shard into DRAINING:
 *
 *   - the DRAINING shard's own leader attributed **none** of its region's Legs to itself,
 *     so §19.5's reconciliation ran over an empty set for the shard most likely to be
 *     holding half-written state; and
 *   - with every published shard DRAINING the routing map was empty, which read as "no map
 *     is published" — the single-shard branch — and every leader would then reconcile the
 *     whole fleet. That is a second writer (§19.3) originating inside this phase.
 *
 * `readRegionOwnershipMap` is empty only when no shard has been published at all, which is
 * the one condition the single-shard branch is actually about.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ shardId, shardByRegionId? }`
 * @returns {Promise<{ scoped: boolean, legIds: Set<string>|null, note: string }>}
 */
async function legsInShard(deps, input) {
  const settings = input || {};
  const shardId = String(settings.shardId);

  const map = settings.shardByRegionId || (await shardModel.readRegionOwnershipMap(deps));
  const published = Boolean(map) && Object.keys(map).length > 0;

  if (!published) {
    return {
      scoped: false,
      legIds: null,
      note:
        "no region→shard map is published, so this is the single-shard deployment and every Leg belongs to this " +
        "shard (§3.5). Scoping to an empty set would report a successful failover that reconciled nothing.",
    };
  }

  const legIds = new Set();

  const queued = await deps.prisma.workQueue.findMany({ where: { shardId }, select: { legId: true } });
  for (const row of queued) legIds.add(row.legId);

  // The fallback: a Leg whose queue row is gone, or that predates the queue. Its shard is
  // its mission's region resolved through the same map intake used.
  //
  // Two queries rather than one relation filter, deliberately: a `where: { mission: {…} }`
  // join is a query shape the store models in tests only if the double implements
  // relations, and a failover query that only works against a particular double is a
  // failover query nobody can check. Two indexed reads are cheap on a path that runs once
  // per leadership change.
  const regionsHere = Object.keys(map).filter((regionId) => map[regionId] === shardId);
  if (regionsHere.length > 0) {
    const missions = await deps.prisma.mission.findMany({
      where: { regionId: { in: regionsHere } },
      select: { id: true },
    });
    if (missions.length > 0) {
      const legs = await deps.prisma.leg.findMany({
        where: { missionId: { in: missions.map((mission) => mission.id) } },
        select: { id: true },
      });
      for (const leg of legs) legIds.add(leg.id);
    }
  }

  return {
    scoped: true,
    legIds,
    note: `scoped by the WorkQueue routing record and by the mission regions this shard owns (${regionsHere.join(", ") || "none"})`,
  };
}

/**
 * The durable state the new leader inherits (§19.5's first job), read before anything is
 * repaired.
 *
 * An inventory rather than a repair list. Its value is that it is taken *before* the
 * sweep: a leader that reported only what it repaired could not distinguish "there was
 * nothing wrong" from "there was nothing here".
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ shardId, storeTime, scope }`
 * @returns {Promise<object>}
 */
async function inventory(deps, input) {
  const settings = input || {};
  const scope = settings.scope || (await legsInShard(deps, settings));
  const legFilter = scope.scoped ? { legId: { in: [...scope.legIds] } } : {};
  const legIdFilter = scope.scoped ? { id: { in: [...scope.legIds] } } : {};

  // HARD commitments — authoritative, survived, and the reason a Leg in PLANNED may not
  // simply be requeued (§19.5: "an agent has been told").
  const hardCommitments = await deps.prisma.commitment.count({ where: { ...legFilter, releasedAt: null } });

  // Leases: how many of those commitments' leases have already lapsed. Not repaired here
  // — §12.2's expiry handling owns that — but counted, because a new leader inheriting a
  // shard whose leases all lapsed during the outage is in a materially different position
  // from one inheriting a healthy shard.
  const lapsedLeases = await deps.prisma.commitment.count({
    where: { ...legFilter, releasedAt: null, leaseExpiry: { lte: settings.storeTime } },
  });

  // Custody — §19.5 names it among the durable state, and §2.5 makes it the one category
  // whose divergence is an operator event rather than a requeue.
  const custodyHeld = await deps.prisma.leg.count({
    where: { ...legIdFilter, custodyState: { in: [...HOLDING_CUSTODY_STATES] } },
  });

  // Outbox rows: dispatch obligations written in the authorising transaction (§11.1) that
  // the previous leader's drain worker may not have delivered.
  //
  // **Fleet-wide, and labelled as such.** `Outbox` carries an `agentId` and no `shardId`,
  // so scoping this to the shard would mean an `IN` list of every member agent — five
  // thousand of them at §3.5's upper bound — on the one code path that runs while a shard
  // has no leader. The number is still worth having, and reporting it as the shard's when
  // it is the fleet's is the kind of quiet wrong answer an incident is decided on, so it
  // says which it is instead.
  const outboxOutstanding = await deps.prisma.outbox.count({
    where: { state: { in: ["PENDING", "CLAIMED", "DELIVERED"] } },
  });
  const outboxStaleClaims = await deps.prisma.outbox.count({
    where: { state: "CLAIMED", claimExpiresAt: { lte: settings.storeTime } },
  });

  // Timers: durable by construction (§4.5), so supervision is re-established by reading
  // them rather than by re-registering them. The overdue count is what tells a new leader
  // whether the outage outlived its own supervision.
  //
  // Scoped by `Timer.shardId`, which §12.4's own repairs stamp — so unlike the outbox this
  // one *can* be a statement about this shard, and is. In the single-shard deployment
  // (no published map) the scope is the fleet and both are the same set.
  const timerScope = scope.scoped ? { shardId: String(settings.shardId) } : {};
  const timersPending = await deps.prisma.timer.count({ where: { ...timerScope, timerState: "PENDING" } });
  const timersOverdue = await deps.prisma.timer.count({
    where: { ...timerScope, timerState: "PENDING", dueAt: { lte: settings.storeTime } },
  });

  return Object.freeze({
    shardId: String(settings.shardId),
    scope: { scoped: scope.scoped, legCount: scope.scoped ? scope.legIds.size : null, note: scope.note },
    [DURABLE_CATEGORY.HARD_COMMITMENTS]: { active: hardCommitments, scope: scope.scoped ? "SHARD" : "FLEET" },
    [DURABLE_CATEGORY.LEASES]: { lapsed: lapsedLeases, scope: scope.scoped ? "SHARD" : "FLEET" },
    [DURABLE_CATEGORY.CUSTODY]: { holding: custodyHeld, scope: scope.scoped ? "SHARD" : "FLEET" },
    [DURABLE_CATEGORY.OUTBOX]: {
      outstanding: outboxOutstanding,
      staleClaims: outboxStaleClaims,
      // Always the fleet, in every deployment. `Outbox` has no `shardId` column.
      scope: "FLEET",
      note:
        "fleet-wide: Outbox carries an agentId and no shardId, and an IN list of every member agent is not a query " +
        "for the path that runs while a shard has no leader. Reported as the fleet's rather than presented as this " +
        "shard's.",
    },
    [DURABLE_CATEGORY.TIMERS]: { pending: timersPending, overdue: timersOverdue, scope: scope.scoped ? "SHARD" : "FLEET" },
    note:
      "an inventory, not a repair list. Every category here is repaired by its own owner — §12.4's reconciler, " +
      "§11.1's drain worker, §4.5's timer worker — and a second implementation in the failover path would be the " +
      "one nobody maintained. Each category states whether its count is this shard's or the fleet's: a number " +
      "reported as the shard's when it is the fleet's is a quiet wrong answer an incident gets decided on.",
  });
}

/**
 * §19.5's volatile half, as a prediction.
 *
 * Reads the Legs in `PLANNED` and asks `planState.reconstructionPlan()` — the pure
 * statement of the procedure — which of them are to be requeued and which are to be left
 * alone. Nothing is written: the sweep performs the requeue, and this exists so the
 * outcome can be compared against a prediction made from the durable rows alone.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ shardId, scope }`
 * @returns {Promise<{ requeue: string[], leftAlone: object[], note: string }>}
 */
async function planReconstruction(deps, input) {
  const settings = input || {};
  const scope = settings.scope || (await legsInShard(deps, settings));
  const legIdFilter = scope.scoped ? { id: { in: [...scope.legIds] } } : {};

  const planned = await deps.prisma.leg.findMany({
    where: { ...legIdFilter, state: PLANNED },
    select: { id: true, legId: true, state: true },
  });

  const withCommitments = [];
  for (const leg of planned) {
    // eslint-disable-next-line no-await-in-loop
    const active = await deps.prisma.commitment.count({ where: { legId: leg.id, releasedAt: null } });
    withCommitments.push({ legId: leg.id, state: leg.state, hasLiveCommitment: active > 0 });
  }

  return planState.reconstructionPlan({ plannedLegs: withCommitments });
}

/**
 * The reconstructed-Leg count from one reconciliation pass.
 *
 * Read out of the orphan scan's own `EXPECTED_POST_FAILOVER` counter, which Phase 5 wrote
 * for exactly this purpose. Extracted here rather than summed into the repair total,
 * because §19.5's sentence is that the two must be *distinguishable*.
 *
 * @param {object} sweepResult a `reconciler.sweep()` result
 * @returns {{ reconstructed: number, defectOrphans: number, otherRepairs: number }}
 */
function separateReconstruction(sweepResult) {
  const results = (sweepResult && sweepResult.results) || [];
  const orphanScan = results.find((row) => row && row.counts && row.category === "ORPHAN_LEG");

  const reconstructed = orphanScan ? Number(orphanScan.counts.EXPECTED_POST_FAILOVER || 0) : 0;
  const defectOrphans = orphanScan ? Number(orphanScan.counts.DEFECT || 0) : 0;
  const total = Number((sweepResult && sweepResult.total) || 0);

  return {
    reconstructed,
    defectOrphans,
    // Everything the sweep repaired that was not a post-failover reconstruction. This is
    // the number that belongs in §12.4's repair-rate SLI; `reconstructed` is not.
    otherRepairs: Math.max(0, total - reconstructed),
  };
}

/**
 * Run the full reconciliation a new leader owes before its first round.
 *
 * @param {object} deps
 * @param {object} deps.prisma
 * @param {(config: object) => Promise<object>} deps.reconcile the §12.4 sweep, injected.
 *   **Required.** See below.
 * @param {object} input
 * @param {string} input.shardId
 * @param {Date} input.storeTime
 * @param {object} [input.reconcileConfig] passed through to the sweep
 * @param {number} [input.maxPasses]
 * @returns {Promise<object>}
 */
async function run(deps, input) {
  if (!deps || typeof deps.reconcile !== "function") {
    throw new TypeError(
      "failover requires the §12.4 reconciliation sweep (§19.5). It is injected rather than imported so that the " +
        "shard has exactly one implementation of a requeue and one set of §4.5 timer obligations attached to it — " +
        'and because "the new leader runs a full reconciliation of the shard before resuming rounds" is only true ' +
        "if the thing it runs is the reconciliation the rest of the system means by that word. A failover " +
        "permitted to run without one would resume rounds on state the previous leader left half-written, which " +
        "is the outcome §19.5 opens by naming.",
    );
  }

  const settings = input || {};
  const shardId = String(settings.shardId);
  const maxPasses = Number.isInteger(settings.maxPasses) && settings.maxPasses > 0 ? settings.maxPasses : DEFAULT_MAX_PASSES;

  const scope = await legsInShard(deps, settings);
  const before = await inventory(deps, { ...settings, scope });
  const predicted = await planReconstruction(deps, { ...settings, scope });

  const passes = [];
  let reconstructed = 0;
  let defectOrphans = 0;
  let otherRepairs = 0;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    // eslint-disable-next-line no-await-in-loop
    const sweep = await deps.reconcile({ ...(settings.reconcileConfig || {}), shardId });
    const separated = separateReconstruction(sweep);

    reconstructed += separated.reconstructed;
    defectOrphans += separated.defectOrphans;
    otherRepairs += separated.otherRepairs;
    passes.push({ pass, total: Number(sweep.total || 0), ...separated });

    // The sweep is batched; a pass that repaired nothing is a pass that found nothing
    // left, which is the only evidence "full" can mean here.
    if (Number(sweep.total || 0) === 0) break;
  }

  const remaining = await planReconstruction(deps, { ...settings, scope });
  const complete = remaining.requeue.length === 0;

  return Object.freeze({
    shardId,
    atMs: settings.storeTime.getTime(),
    // The gate `election.promote()` demands. False when the sweep ran out of passes with
    // reconstruction still outstanding — a shard that needs an operator, said plainly.
    complete,
    inventory: before,
    reconstruction: Object.freeze({
      // §19.5's metric, and the one field of this whole result that must never be added
      // to §12.4's repair rate.
      reconstructedLegCount: reconstructed,
      predictedRequeue: predicted.requeue.length,
      leftAloneWithCommitment: predicted.leftAlone.length,
      stillOutstanding: remaining.requeue.length,
      note: predicted.note,
    }),
    repairs: Object.freeze({
      defectOrphans,
      otherRepairs,
      note:
        "the reconciler's genuine repairs (§12.4), reported apart from the reconstruction. A defect orphan is a " +
        "Leg past PLANNED with nothing holding it, which failover does not explain; a post-failover orphan is a " +
        "Leg in PLANNED whose SOFT reservation died with its leader, which failover explains completely.",
    }),
    passes,
    passesUsed: passes.length,
    maxPasses,
    // The seam Phase 12's Invariant Checker records as missing: I3 counts a `PLANNED` Leg
    // held only in coordinator memory as a *separately counted* orphan, and needs to know
    // which those are. After a failover the answer is definitively **none** — every SOFT
    // reservation died with the previous leader — and stating it is what turns I3's
    // "absence recorded in detail" into an answer.
    softReservedLegIds: [],
    sentence: complete
      ? `shard ${shardId} reconciled in ${passes.length} pass(es): ${reconstructed} Leg(s) reconstructed after ` +
        `failover, ${defectOrphans} defect orphan(s) repaired. Rounds may resume.`
      : `shard ${shardId} is NOT reconciled after ${passes.length} pass(es): ${remaining.requeue.length} Leg(s) ` +
        "still await reconstruction. Rounds must not resume (§19.5).",
  });
}

/**
 * Record the failover on the shard row.
 *
 * `roundsResumableAt` is written **only** on a complete reconciliation, and is the durable
 * form of §19.5's ordering: a coordinator that restarted between reconciling and resuming
 * reads it and knows it need not reconcile again, and a coordinator whose reconciliation
 * did not complete finds it null and does not resume.
 *
 * ── Why this is an `updateMany` and not an `update` ─────────────────────────
 * A `Shard` row is *published configuration* — it carries a foreign key to a `Region`, and
 * §3.5's region→shard map is a thing an operator publishes rather than a thing a coordinator
 * creates. The **single-shard deployment therefore has no `Shard` row at all**, which this
 * module already treats as a legal state everywhere else: `legsInShard()` says so in as many
 * words ("no region→shard map is published, so this is the single-shard deployment and every
 * Leg belongs to this shard").
 *
 * `update()` raises P2025 when it matches nothing. In the single-shard deployment that threw
 * out of `failoverPass()` **after** the reconciliation had already run, and because the
 * supervisor's interval callback swallows a failed tick (correctly — one lost renewal must
 * not take the process down), the session was never promoted and the loop re-entered as a
 * follower forever, re-running the full §12.4 sweep on every tick. The failure mode was a
 * coordinator that reconciled continuously and never resumed a round.
 *
 * `updateMany` matches nothing and writes nothing, which is the right answer: there is no row
 * to record the failover on, and inventing one would fabricate a region→shard mapping no
 * operator published. The outcome is reported rather than hidden, so a caller can tell "the
 * failover was recorded" from "there was nowhere to record it".
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ shardId, result, at }`
 * @returns {Promise<{ persisted: boolean, shardId: string, note: string|null }>}
 */
async function persist(deps, input) {
  const settings = input || {};
  const result = settings.result || {};
  const shardId = String(settings.shardId);

  const outcome = await deps.prisma.shard.updateMany({
    where: { shardId },
    data: {
      lastLeadershipChangeAt: settings.at,
      lastFailoverAt: settings.at,
      lastFailoverReconstructedLegs: result.reconstruction ? result.reconstruction.reconstructedLegCount : null,
      lastFailoverRecoveredCommitments:
        result.inventory && result.inventory[DURABLE_CATEGORY.HARD_COMMITMENTS]
          ? result.inventory[DURABLE_CATEGORY.HARD_COMMITMENTS].active
          : null,
      roundsResumableAt: result.complete === true ? settings.at : null,
    },
  });

  const persisted = Number(outcome.count || 0) > 0;
  return Object.freeze({
    persisted,
    shardId,
    note: persisted
      ? null
      : `no Shard row for "${shardId}" — the single-shard deployment (§3.5). The reconciliation ran and its result ` +
        "stands; there is simply no published shard row to record it on, and creating one would invent a " +
        "region→shard mapping no operator published.",
  });
}

/**
 * Build-time: does the locally-declared custody vocabulary still agree with the domain's?
 *
 * The same trade the Invariant Checker makes, made for the same reason and checked the
 * same way. Independence at runtime is what makes the inventory a report about the shard
 * rather than a report about `domain/custody.js`; this comparison is what keeps that from
 * costing drift.
 *
 * @param {readonly string[]} domainHoldingStates from `domain/custody`
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertCustodyVocabularyAgrees(domainHoldingStates) {
  const declared = [...HOLDING_CUSTODY_STATES].sort();
  const domain = [...(domainHoldingStates || [])].sort();
  const problems = [];

  if (declared.join(",") !== domain.join(",")) {
    problems.push(
      `failover's locally-declared holding-custody states [${declared.join(", ")}] have drifted from ` +
        `domain/custody's [${domain.join(", ")}]. The local copy exists so the inventory is independent of the ` +
        "module that maintains custody; it is not licence for the two to disagree.",
    );
  }

  return { ok: problems.length === 0, problems };
}

module.exports = {
  DURABLE_CATEGORY,
  HOLDING_CUSTODY_STATES,
  DEFAULT_MAX_PASSES,
  legsInShard,
  inventory,
  planReconstruction,
  separateReconstruction,
  run,
  persist,
  assertCustodyVocabularyAgrees,
};

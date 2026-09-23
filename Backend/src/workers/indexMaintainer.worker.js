"use strict";

/**
 * The Availability Index maintainer (§6.2's Background-workers row): "Index
 * maintainer (consumes observations, moves agents between cells and availability
 * classes)."
 *
 * ── What this worker assembles, and what it deliberately does not ───────────
 * `candidates/availabilityIndex.js` is pure — it classifies a `state` object into
 * §6.2's four partitions and writes the result, but it reads no store itself. This
 * worker is where the store reads happen: the agent's lifecycle and class
 * (`Agent`), its active commitment count (`Commitment.releasedAt IS NULL`, the same
 * predicate Phase 3's capacity slot allocation is built on), and its latest
 * reported position (`Observation` where `kind = "position"`, §2.7).
 *
 * Two inputs §6.2's classification needs are **not** assembled here, and are taken
 * as injected functions instead of a guessed query:
 *
 *   - **Charging state and projected free time** — whether an agent is currently
 *     charging, whether that session is interruptible, and when a busy agent is
 *     projected to free up. These are the Charging Scheduler's (§14.6, §14.7), which
 *     this worker does not own the read path for. Supplied as
 *     `deps.chargingStatusFor(agentId)`.
 *
 *     **BATCH 2 — the default is now an absence, not a negative.** It returned
 *     "not charging" when omitted, and the sentence that used to stand here claimed
 *     that only *narrowed* an agent's partition. It did the reverse: "not charging"
 *     plus "no commitments" is `IDLE_READY`, §6.3's first-searched partition. The
 *     classifier now answers in three states — `known: false` (nobody owns the
 *     answer), `waiting: true` (queued for a plug), or a positive charging verdict —
 *     and `assembleRecord` declines to index an agent in either of the first two. An
 *     unwired deployment now indexes **nothing**, which is the honest degradation:
 *     with no Charging Scheduler (blocking decision B2) there is no authority on
 *     whether any agent may leave a charger.
 *   - **Capability and container classes** — §6.2's secondary indices. These come
 *     from the `CapabilityBundle`/`ContainerModel` Phase 2 landed, whose exact
 *     relation shape this phase does not re-derive. Supplied as `deps.
 *     capabilityAndContainerClassesFor(agentId)`; defaults to `[]` for both, which
 *     only means the secondary index carries nothing for that agent — the primary
 *     fine/coarse/class index is unaffected.
 *
 * ── Idempotence ───────────────────────────────────────────────────────────────
 * Each sweep recomputes every agent's *current* record from durable state and
 * diffs it against the durable mirror (`AgentCellPosition`) via `applyPosition()`,
 * which itself only issues the Redis commands for keys that actually changed. A
 * re-run after a crash mid-sweep reprocesses every agent and converges to the same
 * index — nothing here accumulates.
 *
 * ── Started at BATCH 2, and exactly what that does and does not mean ────────
 * Step 5 supplied this worker's *input* — the telemetry path now writes the
 * `kind = "position"` Observations it reads (`services/positionObservation.service.js`),
 * where before there was no production writer at all and `AgentCellPosition` was
 * consequently empty. Supplying an input was not clearing the blocker, and the blocker
 * registered against this worker in `workers/registry.js` was the charging classifier and
 * its widening default (described above).
 *
 * That classifier now exists — `services/chargingStatus.service.js` — and it reads the
 * Charging Scheduler's own durable artefact (`ChargerReservation`), not a simulator
 * variable, a socket state or a `Robot.status` column. With it supplied, the worker is
 * started from the composition root and its registry row is `SCHEDULED`.
 *
 * **What starting it does not mean.** The classifier is authoritative only for agents a
 * Charging Scheduler actually covers, and the only scheduler that exists is the
 * development simulation publisher (`simulation/devChargingScheduler.js`). For every
 * physical agent it answers `known: false` and this worker indexes nothing — which is the
 * same set of rows the index held before Batch 2 (none), reached honestly rather than by
 * the worker being switched off. B2 is still open; §14.7 still has no production
 * publisher; no V1 stop condition moves because this worker runs.
 *
 * ── The second classifier is still absent, and is NOT fabricated ────────────
 * `capabilityAndContainerClassesFor` has no producer and Batch 2 did not invent one.
 * Activation was assessed against it rather than assumed past it:
 *
 *   * §6.2's capability-class and container-class **vocabularies are undeclared** — no
 *     module, register entry or document states what string names a class — so any
 *     derivation from `CapabilityBundle`/`ContainerModel` would be a taxonomy this batch
 *     invented and later readers would trust.
 *   * **No production consumer reads the secondary index.** `candidates/expansion.js` is
 *     the only caller of `candidatesInFineCell`/`candidatesInCoarseCell` and passes no
 *     `filters` argument at any of its three call sites, so `capabilityKey`/`containerKey`
 *     are written and never queried.
 *   * **No feasibility predicate reads the fields.** F21 matches a requested chassis
 *     through §2.3's typed algebra on the agent's *bundle*, which
 *     `agentSnapshotLoaderFor` carries whole (`capabilityBundle`, `containerModel`) —
 *     `capabilityClasses` and `containerClasses` reach the snapshot and nothing consumes
 *     them.
 *
 * So the documented `[]` default stands, it is inert rather than narrowing, and it is
 * recorded as an open gap rather than closed by a guess.
 *
 * Tier 1 by path (`src/workers/` default). Outside `guards/tenets.js`'s
 * `DECISION_PATH_SCOPE` (that scope is `src/engine/**`, not `src/workers/**`), so —
 * unlike `candidates/expansion.js` — this file may read a wall clock; index
 * maintenance is a background reconciliation loop, not a round's decision path.
 */

const { getPrisma } = require("../db/prisma");
const availabilityIndex = require("../engine/candidates/availabilityIndex");
const { defaultSnapshot } = require("../engine/config/service");
const cells = require("../engine/spatial/cells");
const hierarchy = require("../engine/spatial/hierarchy");
const membership = require("../engine/shard/membership");

/**
 * The sweep interval. The index is advisory (§3.3, I16) and feasibility is
 * re-verified at commit regardless, so staleness here costs candidate-search
 * quality, never correctness — a few seconds of lag is cheap to tolerate and buys
 * a batched read against `Observation` rather than one query per heartbeat.
 * @structural the maintainer's cadence; a batching choice, not a behavioural threshold
 */
const SWEEP_INTERVAL_MS = 5_000;

/**
 * @param {*} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Assemble the `positionRecord()` input for one agent from durable state.
 *
 * @param {object} deps `{ prisma, snapshot, chargingStatusFor, capabilityAndContainerClassesFor }`
 * @param {string} agentId the `Agent.id` primary key
 * @param {number} nowMs
 * @returns {Promise<object|null>} `positionRecord()` input, or null when the agent
 *   has no position observation yet (nothing to index)
 */
/**
 * The shard that owns this agent — **read, never assumed.**
 *
 * ── The defect this replaces ───────────────────────────────────────────────
 * `assembleRecord` returned a hard-coded `shardId: "default"`, annotated *"static
 * single-shard, per Phase 3's ShardLeadership precedent ahead of Phase 13"*. Phase 13
 * landed. The constant then did two things, both wrong on any deployment whose shard is
 * not literally named `default`:
 *
 *   1. `sweepAgents` wrote the KV availability index under `engine:idx:default:…`, while
 *      `candidates/expansion.expandCandidates` searches it under **the round's own**
 *      shard — so no coordinator could discover any agent; and
 *   2. `applyPosition`'s mirror upsert rewrote `AgentCellPosition.shardId` to `"default"`,
 *      **overwriting the published shard on the durable row**, which also emptied
 *      `coordinatorSolvePath.expandCandidatesFor`'s `fleetBestCase` query.
 *
 * So one sweep made a correctly-seeded fleet invisible and corrupted the column that said
 * where it was. The shard was on the row being read the whole time.
 *
 * ── The order, and why absence is not `"default"` ──────────────────────────
 * The durable mirror first: it is what intake resolved and what the published `Shard`
 * table agreed to, and re-deriving it would let this worker disagree with the row it is
 * about to write. Failing that, the agent's region through the `Shard` table, under the
 * same ACTIVE/REBALANCING admission rule `intake.resolveShardFor` applies — stated here
 * rather than imported, for the reason `intake.js` gives for not importing `shardModel`.
 *
 * An agent that resolves to neither is **not indexed**, and that is the fail-closed
 * direction this module already takes elsewhere: §3.3 I16 makes the index advisory and
 * feasibility is re-verified at commit, so an agent missing from the index costs candidate
 * quality and never correctness — while an agent indexed under the *wrong* shard is
 * invisible to its own coordinator and visible to somebody else's.
 *
 * @param {object} prisma
 * @param {{ id: string, regionId: string|null }} agent
 * @returns {Promise<string|null>}
 */
/**
 * The region an observed position lies in, **by published assignment** (§3.6) — the fine
 * cell of the position, resolved in the pinned spatial index. `null` when the map is
 * absent or the cell is unassigned; never a point-in-polygon test.
 *
 * Why it exists: an agent commissioned from the dashboard carries no `Agent.regionId`
 * (`legacyRobot.robotToAgent` receives none), so `resolveAgentShardId` returned null and
 * the agent was **never indexed** — a live, reporting robot that no round could discover.
 * Measured 2026-09-23 on the V1 demonstration path. Its region is not unknown: it is where
 * the robot is, in the map the rest of the engine already trusts.
 *
 * @param {object} snapshot the pinned configuration
 * @param {{ lat: number, lon: number }} position
 * @returns {string|null} a `Region.id`
 */
function regionForObservedPosition(snapshot, position) {
  if (!snapshot || !snapshot.spatial || !position) return null;
  if (!isFiniteNumber(position.lat) || !isFiniteNumber(position.lon)) return null;
  try {
    const cellId = cells.cellForPoint(position.lat, position.lon, cells.RESOLUTION.FINE);
    const resolved = hierarchy.indexMap(snapshot.spatial).resolve(cellId);
    return resolved.assigned === true && resolved.regionId ? resolved.regionId : null;
  } catch {
    return null;
  }
}

async function resolveAgentShardId(prisma, agent, observedRegionId) {
  const mirror = await prisma.agentCellPosition.findUnique({
    where: { agentId: agent.id },
    select: { shardId: true },
  });
  if (mirror && typeof mirror.shardId === "string" && mirror.shardId !== "") return mirror.shardId;

  // The declared region wins; an agent nobody placed in a region is placed by where it was
  // observed, in the published map (see `regionForObservedPosition`).
  const regionId = agent.regionId || observedRegionId || null;
  if (!regionId) return null;
  const shards = await prisma.shard.findMany({
    where: { regionId },
    orderBy: { shardId: "asc" },
    select: { shardId: true, state: true },
  });
  const admitting = shards.find((row) => row.state === "ACTIVE" || row.state === "REBALANCING");
  return admitting ? admitting.shardId : null;
}

async function assembleRecord(deps, agentId, nowMs) {
  const prisma = deps.prisma;

  const [agent, latestPosition, activeCommitmentCount] = await Promise.all([
    prisma.agent.findUnique({
      where: { id: agentId },
      // `regionId` is read because `resolveAgentShardId` needs it when no mirror row
      // exists yet — the first sweep after commissioning.
      select: { id: true, agentId: true, lifecycleState: true, agentClassId: true, capacityOverride: true, regionId: true },
    }),
    prisma.observation.findFirst({
      where: { agentId, kind: "position" },
      orderBy: { observedAt: "desc" },
      select: { value: true, observedAt: true },
    }),
    prisma.commitment.count({ where: { agentId, releasedAt: null } }),
  ]);

  if (!agent || !latestPosition) return null;

  const position = latestPosition.value || {};
  if (!isFiniteNumber(position.lat) || !isFiniteNumber(position.lon)) return null;

  // STEP 5 — the instant the **agent** measured this position, carried out of the
  // Observation rather than taken from the sweep.
  //
  // The row is refused when it is unreadable, and this is the fail-closed direction rather
  // than the tidy one: `AgentCellPosition.observedAtMs` is documented as "when the position
  // this row reflects was observed (§2.7) — distinct from `updatedAt`, which is when the
  // row was written", and `coordinatorSolvePath.agentSnapshotLoaderFor` copies it straight
  // onto the agent snapshot the engine reasons over. Substituting anything for it would
  // publish a freshness the fleet never reported.
  const observedAtMs = new Date(latestPosition.observedAt).getTime();
  if (!Number.isFinite(observedAtMs)) return null;

  // ── BATCH 2 — the charging classifier, and the default that is now an absence ──
  //
  // This read `{ charging: false, … }` when no classifier was supplied, and that default
  // was the registered blocker on this worker: `availabilityIndex.classify` reads an agent
  // with no commitments and `charging: false` as `IDLE_READY`, the partition §6.3 searches
  // FIRST — so an agent parked on a charger was offered work ahead of a genuinely idle one.
  // The header two screens up claimed the defaults "only *narrow* … never widen"; the code
  // did the opposite, and the code is what runs.
  //
  // The replacement is not the mirror-image default. Flipping it to `charging: true` would
  // fabricate a session for every agent nobody can answer for, which is the same defect
  // pointing the other way. `services/chargingStatus.service.js` answers in THREE states and
  // this is where the third one is honoured: an agent whose charging state is **unknown**,
  // and an agent **queued** for a plug, are both left out of the index entirely.
  //
  // Both are narrowings, and both are free: §3.3 I16 makes the index advisory and
  // feasibility is re-verified at commit, so an agent missing from the index costs candidate
  // quality and never correctness. An agent wrongly *in* it costs correctness.
  const charging =
    typeof deps.chargingStatusFor === "function"
      ? await deps.chargingStatusFor(agent.id)
      : { known: false, charging: false, chargingInterruptible: false, waiting: false, projectedFreeAtMs: null };

  // `known === false` is "nobody owns the answer for this agent" — §14.7 gives charging
  // state to the Charging Scheduler and B2 has not produced one for the physical fleet. It
  // is NOT "not charging", and the difference is the whole point of this change.
  //
  // Read as an explicit `!== true` rather than `=== false`, so a classifier that returns
  // the old three-field shape — or any object that simply does not carry the field — is
  // treated as an absence rather than as permission.
  if (charging.known !== true) return null;
  // Docked, holding a place in the charging queue. Not charging, and not available either:
  // `classify()` has no vocabulary for "waiting at a charger", so the narrowing is applied
  // here rather than by misreporting it through `charging`.
  if (charging.waiting === true) return null;

  const secondary =
    typeof deps.capabilityAndContainerClassesFor === "function"
      ? await deps.capabilityAndContainerClassesFor(agent.id)
      : { capabilityClasses: [], containerClasses: [] };

  const snapshot = deps.snapshot || defaultSnapshot();
  let capacity = null;
  if (agent.capacityOverride !== null && agent.capacityOverride !== undefined) {
    capacity = agent.capacityOverride;
  } else if (agent.agentClassId) {
    const resolved = snapshot.resolve("capacity", { agent_class: agent.agentClassId }, { index: agent.agentClassId });
    if (typeof resolved === "number" && Number.isFinite(resolved)) capacity = resolved;
  }

  const finishingSoonHorizonSeconds = snapshot.resolve("candidate.finishing_soon_horizon", {}) ?? null;

  // The owning shard, from the durable row or the published `Shard` table. An agent
  // whose shard cannot be established is not indexed at all — see `resolveAgentShardId`.
  const shardId = await resolveAgentShardId(prisma, agent, regionForObservedPosition(snapshot, position));
  if (shardId === null) return null;

  return {
    agentId: agent.id,
    shardId,
    lat: position.lat,
    lon: position.lon,
    // Carried alongside the record `positionRecord()` builds rather than inside it:
    // `availabilityIndex` is Tier 1 and pure, its record is the Redis index key material,
    // and a timestamp is neither. The durable mirror needs it; the index does not.
    observedAtMs,
    capabilityClasses: secondary.capabilityClasses,
    containerClasses: secondary.containerClasses,
    decisionTimeMs: nowMs,
    finishingSoonHorizonSeconds,
    state: {
      lifecycleEligible: agentIsLifecycleEligible(agent.lifecycleState),
      hasActiveCommitment: activeCommitmentCount > 0,
      idle: activeCommitmentCount === 0,
      queueDepth: activeCommitmentCount,
      capacity,
      charging: Boolean(charging.charging),
      chargingInterruptible: Boolean(charging.chargingInterruptible),
      projectedFreeAtMs: isFiniteNumber(charging.projectedFreeAtMs) ? charging.projectedFreeAtMs : null,
    },
  };
}

/**
 * Local mirror of `domain/agent.isLifecycleEligible`, avoided as a direct import so
 * this worker does not have to construct a full `Agent` domain object just to ask
 * one question; the eligibility table itself is small enough to inline and is
 * cross-checked against `domain/agent.js` by `tests/engine/indexMaintainer.test.js`.
 *
 * @param {string} lifecycleState
 * @returns {boolean}
 */
function agentIsLifecycleEligible(lifecycleState) {
  return lifecycleState === "ACTIVE";
}

/**
 * One sweep: recompute and apply every given agent's index placement.
 *
 * @param {object} deps `{ prisma, kv, snapshot, now, chargingStatusFor,
 *   capabilityAndContainerClassesFor, onError }`
 * @param {string[]} agentIds
 * @returns {Promise<{ processed: number, indexed: number, removed: number, failed: number }>}
 */
async function sweepAgents(deps, agentIds) {
  const prisma = deps.prisma || getPrisma();
  const nowMs = typeof deps.now === "function" ? deps.now() : Date.now();

  let processed = 0;
  let indexed = 0;
  let removed = 0;
  let failed = 0;

  for (const agentId of agentIds) {
    processed += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      const assembled = await assembleRecord({ ...deps, prisma }, agentId, nowMs);
      // eslint-disable-next-line no-await-in-loop
      const previousRow = await prisma.agentCellPosition.findUnique({ where: { agentId } });
      const previous = previousRow && {
        agentId: previousRow.agentId,
        shardId: previousRow.shardId,
        fineCellId: previousRow.fineCellId,
        coarseCellId: previousRow.coarseCellId,
        availabilityClass: previousRow.availabilityClass,
        capabilityClasses: previousRow.capabilityClasses,
        containerClasses: previousRow.containerClasses,
      };

      const next = assembled ? availabilityIndex.positionRecord(assembled) : { ok: true, record: null, problems: [] };
      if (!next.ok) {
        failed += 1;
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await availabilityIndex.applyPosition({ kv: deps.kv }, previous, next.record);

      if (next.record) {
        // STEP 5 — the Observation's own `observedAt`, not the sweep's clock.
        //
        // This read `BigInt(nowMs)` in both branches, so every mirror row claimed to have
        // been measured at the instant the sweep happened to run. On a 5 s sweep that
        // republished a five-minute-old fix as a five-second-old one every five seconds:
        // the column can never have gone stale, because the loop refreshed it. Freshness
        // is the one thing this column exists to record (§2.7), and a value that is
        // renewed by the act of reading it is not a measurement.
        const observedAtMs = BigInt(assembled.observedAtMs);
        // eslint-disable-next-line no-await-in-loop
        await prisma.agentCellPosition.upsert({
          where: { agentId },
          create: {
            agentId,
            shardId: next.record.shardId,
            lat: next.record.lat,
            lon: next.record.lon,
            fineCellId: next.record.fineCellId,
            coarseCellId: next.record.coarseCellId,
            availabilityClass: next.record.availabilityClass,
            capabilityClasses: next.record.capabilityClasses,
            containerClasses: next.record.containerClasses,
            observedAtMs,
          },
          update: {
            shardId: next.record.shardId,
            lat: next.record.lat,
            lon: next.record.lon,
            fineCellId: next.record.fineCellId,
            coarseCellId: next.record.coarseCellId,
            availabilityClass: next.record.availabilityClass,
            capabilityClasses: next.record.capabilityClasses,
            containerClasses: next.record.containerClasses,
            observedAtMs,
          },
        });

        // §3.5's initial placement, at the moment the agent's shard is first established.
        // `shard/membership.place` existed and **had no caller**: no agent ever had a
        // `ShardMembership`, so `agentGate.resolveIdentity` bound no shard at AUTH and every
        // OFFER_ACCEPT/REJECT/DEFER was dropped as SHARD_IDENTITY_UNRESOLVED — an agent that
        // accepted its offer was withdrawn for not answering (measured on the V1
        // demonstration path, 2026-09-23). Idempotent: an agent already a member of this
        // shard is left as it is, and one that belongs to a *different* shard is refused
        // (a move is `migrate()`'s, with its epoch advance), never silently re-placed.
        //
        // Contained: the index write above has succeeded, and a placement failure must not
        // un-index an agent that is discoverable. It is reported, and the next sweep retries.
        try {
          await membership.place(
            { prisma },
            { agentId, shardId: next.record.shardId, at: new Date(nowMs), movedBy: "indexMaintainer:initial-placement" },
          );
        } catch (error) {
          if (typeof deps.onError === "function") deps.onError(error, agentId);
        }
        indexed += 1;
      } else if (previousRow) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.agentCellPosition.delete({ where: { agentId } });
        removed += 1;
      }
    } catch (error) {
      failed += 1;
      if (deps && typeof deps.onError === "function") deps.onError(error, agentId);
    }
  }

  return { processed, indexed, removed, failed };
}

/**
 * One full sweep over every lifecycle-eligible agent.
 *
 * @param {object} deps as `sweepAgents`
 * @returns {Promise<object>}
 */
async function sweepOnce(deps) {
  const prisma = deps.prisma || getPrisma();
  const agents = await prisma.agent.findMany({
    where: { lifecycleState: "ACTIVE" },
    select: { id: true },
  });
  return sweepAgents(deps, agents.map((agent) => agent.id));
}

/**
 * Cold Index rebuild (§18.5, B3): reconstruct Redis from `AgentCellPosition` alone,
 * without touching `Observation` — the durable mirror already carries a current,
 * indexable record per agent, which is exactly what a Redis rebuild needs and is
 * cheaper than re-deriving every record from the raw observation log.
 *
 * @param {object} deps `{ prisma, kv }`
 * @returns {Promise<{ ok: boolean, indexed: number, skipped: number, failed: number }>}
 */
async function rebuildIndexFromMirror(deps) {
  const prisma = deps.prisma || getPrisma();
  const rows = await prisma.agentCellPosition.findMany();
  const records = rows.map((row) =>
    Object.freeze({
      agentId: row.agentId,
      shardId: row.shardId,
      lat: row.lat,
      lon: row.lon,
      fineCellId: row.fineCellId,
      coarseCellId: row.coarseCellId,
      availabilityClass: row.availabilityClass,
      capabilityClasses: row.capabilityClasses,
      containerClasses: row.containerClasses,
    }),
  );
  return availabilityIndex.rebuildFromRecords({ kv: deps.kv }, records);
}

/**
 * Start the periodic sweep, **after** rebuilding the index from the durable mirror.
 *
 * ── Why the rebuild has to happen here ─────────────────────────────────────
 * `availabilityIndex.applyPosition` writes a **delta**: it compares the keys implied by
 * the previous mirror row against the keys implied by the new one and adds only what
 * changed. That is correct while the index is warm, and it is silently wrong the moment
 * the index is cold — an empty Redis, a flushed one, a process with Redis disabled, or a
 * freshly-seeded deployment. The mirror row already matches what the sweep computes, so
 * `toAdd` is empty, the sweep reports `indexed: 1`, and **nothing is written**. The index
 * then stays empty until an agent happens to move, and `expansion.expandCandidates` finds
 * no candidate in any cell, for any shard, for as long as the fleet sits still.
 *
 * `rebuildIndexFromMirror` is the shipped answer to exactly that — the Cold Index rebuild.
 * It was written, exported, tested, and **called from nowhere in `src/` or `server.js`**:
 * a producer that exists and no composition root uses, which is the defect family this
 * programme has now hit at least six times.
 *
 * It runs here rather than at the two `server.js` call sites so there is one place to
 * forget rather than two, and it runs *before* the first periodic sweep so the first round
 * after a restart searches a populated index.
 *
 * A failed rebuild is reported and does not prevent the sweep starting: the index is
 * advisory (§3.3 I16) and feasibility is re-verified at commit, so a cold index costs
 * candidate quality and never correctness — refusing to start the maintainer would cost
 * both.
 *
 * @param {object} deps as `sweepOnce`
 * @param {{ intervalMs?: number, rebuildOnStart?: boolean }} [options] `rebuildOnStart`
 *   defaults to true; pass false only where the caller has already rebuilt
 * @returns {{ stop: () => void }}
 */
function start(deps, options) {
  const intervalMs = (options && options.intervalMs) || SWEEP_INTERVAL_MS;

  if (!options || options.rebuildOnStart !== false) {
    rebuildIndexFromMirror(deps).catch((error) => {
      if (deps && typeof deps.onError === "function") deps.onError(error, null);
    });
  }

  const handle = setInterval(() => {
    sweepOnce(deps).catch((error) => {
      if (deps && typeof deps.onError === "function") deps.onError(error, null);
    });
  }, intervalMs);

  if (typeof handle.unref === "function") handle.unref();

  return {
    stop() {
      clearInterval(handle);
    },
  };
}

module.exports = {
  SWEEP_INTERVAL_MS,
  assembleRecord,
  regionForObservedPosition,
  agentIsLifecycleEligible,
  sweepAgents,
  sweepOnce,
  rebuildIndexFromMirror,
  start,
};

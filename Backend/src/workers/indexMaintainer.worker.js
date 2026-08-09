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
 *     projected to free up. These live in mission progress and the energy model
 *     (§12.3, §14.6), which this phase does not own the read path for. Supplied as
 *     `deps.chargingStatusFor(agentId)`; defaults to "not charging, not finishing
 *     soon" when omitted, which only *narrows* an agent's partition (never widens
 *     it into `IDLE_READY`), so an unwired deployment degrades to fewer indexed
 *     agents rather than a wrong classification.
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
 * ── Built, tested, and not started ───────────────────────────────────────────
 * Nothing in `server.js` calls `start()`. Phase 15 owns production scheduling, the
 * same disposition every worker since Phase 4 has carried while `ENGINE_ENABLED`
 * is false.
 *
 * Tier 1 by path (`src/workers/` default). Outside `guards/tenets.js`'s
 * `DECISION_PATH_SCOPE` (that scope is `src/engine/**`, not `src/workers/**`), so —
 * unlike `candidates/expansion.js` — this file may read a wall clock; index
 * maintenance is a background reconciliation loop, not a round's decision path.
 */

const { getPrisma } = require("../db/prisma");
const availabilityIndex = require("../engine/candidates/availabilityIndex");
const { defaultSnapshot } = require("../engine/config/service");

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
async function assembleRecord(deps, agentId, nowMs) {
  const prisma = deps.prisma;

  const [agent, latestPosition, activeCommitmentCount] = await Promise.all([
    prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, agentId: true, lifecycleState: true, agentClassId: true, capacityOverride: true },
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

  const charging =
    typeof deps.chargingStatusFor === "function"
      ? await deps.chargingStatusFor(agent.id)
      : { charging: false, chargingInterruptible: false, projectedFreeAtMs: null };

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

  return {
    agentId: agent.id,
    shardId: "default", // static single-shard, per Phase 3's ShardLeadership precedent ahead of Phase 13
    lat: position.lat,
    lon: position.lon,
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
            observedAtMs: BigInt(nowMs),
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
            observedAtMs: BigInt(nowMs),
          },
        });
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
 * Start the periodic sweep.
 *
 * @param {object} deps as `sweepOnce`
 * @param {{ intervalMs?: number }} [options]
 * @returns {{ stop: () => void }}
 */
function start(deps, options) {
  const intervalMs = (options && options.intervalMs) || SWEEP_INTERVAL_MS;

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
  agentIsLifecycleEligible,
  sweepAgents,
  sweepOnce,
  rebuildIndexFromMirror,
  start,
};

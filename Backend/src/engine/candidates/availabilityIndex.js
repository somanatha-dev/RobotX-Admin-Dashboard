"use strict";

/**
 * The Availability Index (§6.2). **Tier 1.**
 *
 * > A live spatial index over assignable agents, maintained by the Agent State
 * > Service and rebuildable from the observation log.
 *
 * ── The four partitions ───────────────────────────────────────────────────────
 * `IDLE_READY`, `CHARGING_INTERRUPTIBLE`, `FINISHING_SOON` (projected free within
 * `candidate.finishing_soon_horizon`), `QUEUE_CAPACITY_AVAILABLE`. §6.2:
 * "Partitioning by class means the common case — find ready agents nearby — touches
 * only the smallest partition." `classify()` below assigns exactly one class per
 * agent, in the priority order that keeps that common case cheapest: an agent
 * already `IDLE_READY` is never also carried in a busier partition.
 *
 * ── Index keys and storage ────────────────────────────────────────────────────
 * `(shard, coarse_cell, fine_cell, availability_class)`, stored as Redis SETs of
 * agent id, plus two secondary indices (capability class, container class) so a
 * mission needing a refrigerated locker never enumerates an agent that cannot
 * possibly satisfy it (§6.2). **Loss must be survivable — index staleness costs
 * quality, never correctness, because feasibility is re-verified at commit** (§3.3,
 * I16), which is why every write here goes through `kv` (advisory, fail-open) and
 * `rebuildFromRecords()` exists to reconstruct the whole index from durable state
 * on Cold Index (§18.5, B3).
 *
 * `AgentCellPosition` (Prisma) is the durable mirror this rebuilds from — Redis
 * alone is not the source of truth for *where an agent currently is indexed*, only
 * for the hot-path lookup.
 *
 * This module performs no Prisma I/O itself, by the same discipline
 * `feasibility/cache.js` states: `kv` is injected, not imported, which keeps the
 * module pure enough to test and keeps a transport dependency out of Tier 1. The
 * worker that actually reads `Observation` rows and the `Commitment`/`Agent` tables
 * to assemble a position record is `src/workers/indexMaintainer.worker.js`.
 */

const cells = require("../spatial/cells");
const { compareStrings } = require("../determinism/ordering");

/** §6.2's four availability classes, in the priority order `classify()` applies. */
const AVAILABILITY_CLASS = Object.freeze({
  IDLE_READY: "IDLE_READY",
  QUEUE_CAPACITY_AVAILABLE: "QUEUE_CAPACITY_AVAILABLE",
  CHARGING_INTERRUPTIBLE: "CHARGING_INTERRUPTIBLE",
  FINISHING_SOON: "FINISHING_SOON",
});

const AVAILABILITY_CLASSES = Object.freeze(Object.values(AVAILABILITY_CLASS));

/** @structural the specification's own key prefix (§6.2's Redis changes) */
const KEY_PREFIX = "engine:idx";

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isAvailabilityClass(value) {
  return typeof value === "string" && AVAILABILITY_CLASSES.includes(value);
}

/**
 * `engine:idx:{shard}:{fineCell}:{availClass}` — §6.2's fine-cell/class partition.
 *
 * @param {string} shardId
 * @param {string} fineCellId
 * @param {string} availabilityClass
 * @returns {string}
 */
function fineKey(shardId, fineCellId, availabilityClass) {
  return `${KEY_PREFIX}:${shardId}:${fineCellId}:${availabilityClass}`;
}

/**
 * `engine:idx:{shard}:{coarseCell}:{availClass}` — the regional sweep unit, tier 4.
 *
 * @param {string} shardId
 * @param {string} coarseCellId
 * @param {string} availabilityClass
 * @returns {string}
 */
function coarseKey(shardId, coarseCellId, availabilityClass) {
  return `${KEY_PREFIX}:${shardId}:${coarseCellId}:${availabilityClass}`;
}

/**
 * Secondary index: which agents (fleet/shard-wide) declare a capability class.
 *
 * @param {string} shardId
 * @param {string} capabilityClass
 * @returns {string}
 */
function capabilityKey(shardId, capabilityClass) {
  return `${KEY_PREFIX}:cap:${shardId}:${capabilityClass}`;
}

/**
 * Secondary index: which agents (fleet/shard-wide) carry a container class.
 *
 * @param {string} shardId
 * @param {string} containerClass
 * @returns {string}
 */
function containerKey(shardId, containerClass) {
  return `${KEY_PREFIX}:container:${shardId}:${containerClass}`;
}

/**
 * Classify one agent's current state into §6.2's partition, or `null` when the
 * agent should not be indexed at all (not lifecycle-eligible, or busy with no
 * near-term or spare capacity).
 *
 * The priority order is deliberate, not incidental: an agent that is genuinely
 * `IDLE_READY` is never also filed under a busier class, which is what keeps the
 * common-case lookup restricted to the smallest partition (§6.2).
 *
 * ── Charging is checked before readiness, and why ────────────────────────────
 * §6.3 places `CHARGING_INTERRUPTIBLE` at **tier 5** — "considered when tiers 0–4
 * yield no acceptable option" — so a charging agent must not appear in any class
 * tiers 1–4 search (`expansion.READY_CLASSES`). It previously could: this function
 * tested `idle` first, and `indexMaintainer.worker.js` derives `idle` from the
 * commitment count alone, so a robot parked on a charger with no commitments
 * classified `IDLE_READY` and was offered work at tier 1 ahead of a genuinely idle
 * one. A robot whose charging session may **not** be interrupted is worse still:
 * it cannot leave the charger at all, so it is not indexed, which is the narrowing
 * direction the maintainer's own defaults follow ("only *narrow* eligibility, never
 * fabricate it") and which the index's advisory nature (§3.3, I16) makes free —
 * feasibility is re-verified at commit regardless.
 *
 * `QUEUE_CAPACITY_AVAILABLE` likewise requires an active commitment. §6.3 tier 0
 * defines the class by what it is for — "agents **already committed** to a
 * compatible nearby Leg with spare queue capacity" — and without that precondition
 * every uncommitted agent with a configured `capacity` satisfied `queueDepth <
 * capacity` and landed here rather than in its own true class.
 *
 * @param {object} state
 * @param {boolean} state.lifecycleEligible from `domain/agent.isLifecycleEligible`
 * @param {boolean} state.hasActiveCommitment whether the agent currently holds any
 *   HARD commitment
 * @param {boolean} [state.idle] true when the agent is executing nothing at all
 * @param {boolean} [state.charging] true when the agent is currently charging
 * @param {boolean} [state.chargingInterruptible] true when that charging session
 *   may be interrupted for a new assignment
 * @param {number} [state.queueDepth] current committed-Leg count
 * @param {number} [state.capacity] `capacity[agent_class]`
 * @param {number} [state.projectedFreeAtMs] the agent's projected free time
 * @param {number} decisionTimeMs the round's pinned decision time — never a clock
 *   read (T6)
 * @param {number} finishingSoonHorizonSeconds `candidate.finishing_soon_horizon`
 * @returns {string|null}
 */
function classify(state, decisionTimeMs, finishingSoonHorizonSeconds) {
  const source = state || {};

  if (!source.lifecycleEligible) return null;

  // Charging with no interruption permitted: the agent cannot leave the charger,
  // so it belongs to no partition at all (§6.3 tier 5 admits only the
  // *interruptible* half of charging).
  if (source.charging && !source.chargingInterruptible) return null;

  if (!source.hasActiveCommitment && source.idle && !source.charging) return AVAILABILITY_CLASS.IDLE_READY;

  if (
    source.hasActiveCommitment &&
    typeof source.queueDepth === "number" &&
    typeof source.capacity === "number" &&
    source.queueDepth < source.capacity
  ) {
    return AVAILABILITY_CLASS.QUEUE_CAPACITY_AVAILABLE;
  }

  if (source.charging && source.chargingInterruptible) return AVAILABILITY_CLASS.CHARGING_INTERRUPTIBLE;

  if (
    typeof source.projectedFreeAtMs === "number" &&
    typeof decisionTimeMs === "number" &&
    typeof finishingSoonHorizonSeconds === "number" &&
    source.projectedFreeAtMs >= decisionTimeMs &&
    source.projectedFreeAtMs - decisionTimeMs <= finishingSoonHorizonSeconds * 1000 // @structural ms per second
  ) {
    return AVAILABILITY_CLASS.FINISHING_SOON;
  }

  return null;
}

/**
 * Build a position record: where an agent is indexed right now, computed from a raw
 * observation and the H3 wrapper. Pure — no I/O.
 *
 * @param {object} input
 * @param {string} input.agentId
 * @param {string} input.shardId
 * @param {number} input.lat
 * @param {number} input.lon
 * @param {string[]} [input.capabilityClasses]
 * @param {string[]} [input.containerClasses]
 * @param {object} input.state as `classify()`'s `state` parameter
 * @param {number} input.decisionTimeMs
 * @param {number} input.finishingSoonHorizonSeconds
 * @returns {{ ok: boolean, record: object|null, problems: string[] }}
 */
function positionRecord(input) {
  const source = input || {};
  const problems = [];

  if (typeof source.agentId !== "string" || source.agentId.length === 0) problems.push("agentId");
  if (typeof source.shardId !== "string" || source.shardId.length === 0) problems.push("shardId");
  if (typeof source.lat !== "number" || typeof source.lon !== "number") problems.push("lat/lon");
  if (problems.length > 0) return { ok: false, record: null, problems };

  const availabilityClass = classify(source.state, source.decisionTimeMs, source.finishingSoonHorizonSeconds);
  if (availabilityClass === null) {
    return { ok: true, record: null, problems: [] };
  }

  const fineCellId = cells.cellForPoint(source.lat, source.lon, cells.RESOLUTION.FINE);
  const coarseCellId = cells.coarseParentOf(fineCellId);

  return {
    ok: true,
    record: Object.freeze({
      agentId: source.agentId,
      shardId: source.shardId,
      lat: source.lat,
      lon: source.lon,
      fineCellId,
      coarseCellId,
      availabilityClass,
      capabilityClasses: [...(source.capabilityClasses || [])].sort(compareStrings),
      containerClasses: [...(source.containerClasses || [])].sort(compareStrings),
    }),
    problems: [],
  };
}

/**
 * @param {object} deps `{ kv }`
 * @returns {boolean}
 */
function hasKv(deps) {
  return Boolean(deps && deps.kv && typeof deps.kv.sadd === "function" && typeof deps.kv.srem === "function");
}

/**
 * Every key one position record participates in.
 *
 * @param {object} record as `positionRecord()`'s output
 * @returns {string[]}
 */
function keysFor(record) {
  if (!record) return [];
  const keys = [
    fineKey(record.shardId, record.fineCellId, record.availabilityClass),
    coarseKey(record.shardId, record.coarseCellId, record.availabilityClass),
  ];
  for (const capabilityClass of record.capabilityClasses || []) keys.push(capabilityKey(record.shardId, capabilityClass));
  for (const containerClass of record.containerClasses || []) keys.push(containerKey(record.shardId, containerClass));
  return keys;
}

/**
 * Move an agent from its previous indexed position (if any) to its next one.
 *
 * Both `SREM` and `SADD` are issued only for the keys that actually changed, so an
 * agent reporting the same cell and class on every heartbeat costs one comparison
 * and no Redis round trip (§20's "the common case is cheap" discipline applied to
 * the index itself).
 *
 * @param {object} deps `{ kv }`
 * @param {object|null} previous a prior `positionRecord()` output, or null for a
 *   first-time placement
 * @param {object|null} next the new `positionRecord()` output, or null when the
 *   agent should be removed from the index entirely (no longer indexable)
 * @returns {Promise<{ ok: boolean, added: string[], removed: string[] }>}
 */
async function applyPosition(deps, previous, next) {
  if (!hasKv(deps)) return { ok: false, added: [], removed: [] };

  const previousKeys = new Set(keysFor(previous));
  const nextKeys = new Set(keysFor(next));

  const toRemove = [...previousKeys].filter((key) => !nextKeys.has(key));
  const toAdd = [...nextKeys].filter((key) => !previousKeys.has(key));

  try {
    if (previous && toRemove.length > 0) {
      await Promise.all(toRemove.map((key) => deps.kv.srem(key, previous.agentId)));
    }
    if (next && toAdd.length > 0) {
      await Promise.all(toAdd.map((key) => deps.kv.sadd(key, next.agentId)));
    }
    return { ok: true, added: toAdd, removed: toRemove };
  } catch {
    // The index is advisory — a write failure narrows candidate search, it never
    // fabricates a candidate, and feasibility is re-verified at commit regardless
    // (§3.3, I16).
    return { ok: false, added: [], removed: [] };
  }
}

/**
 * Remove an agent from the index entirely — equivalent to `applyPosition(deps,
 * previous, null)`, named separately for the lifecycle-exit call site.
 *
 * @param {object} deps `{ kv }`
 * @param {object} previous
 * @returns {Promise<{ ok: boolean, added: string[], removed: string[] }>}
 */
async function removePosition(deps, previous) {
  return applyPosition(deps, previous, null);
}

/**
 * §6.6: agents within a cell ordered by `agent_id`, from whichever secondary
 * indices `filters` names, intersected in process. Cell-level membership is local
 * by construction (T9), so an in-process intersection over it costs nothing a
 * Redis-side `SINTER` would not have — and it keeps the `kv` contract to the three
 * primitives every other engine cache module already uses.
 *
 * @param {object} deps `{ kv }`
 * @param {string} key a `fineKey()` or `coarseKey()`
 * @param {object} [filters]
 * @param {string} [filters.shardId] required when `capabilityClass`/`containerClass` given
 * @param {string} [filters.capabilityClass]
 * @param {string} [filters.containerClass]
 * @returns {Promise<string[]>} canonically ordered agent ids
 */
async function membersOf(deps, key, filters) {
  if (!deps || !deps.kv || typeof deps.kv.smembers !== "function") return [];

  let members;
  try {
    members = await deps.kv.smembers(key);
  } catch {
    return [];
  }

  let ids = new Set((members || []).map(String));

  const applied = filters || {};
  if (applied.capabilityClass && applied.shardId) {
    const capMembers = await deps.kv.smembers(capabilityKey(applied.shardId, applied.capabilityClass)).catch(() => []);
    const capSet = new Set((capMembers || []).map(String));
    ids = new Set([...ids].filter((id) => capSet.has(id)));
  }
  if (applied.containerClass && applied.shardId) {
    const containerMembers = await deps.kv
      .smembers(containerKey(applied.shardId, applied.containerClass))
      .catch(() => []);
    const containerSet = new Set((containerMembers || []).map(String));
    ids = new Set([...ids].filter((id) => containerSet.has(id)));
  }

  return [...ids].sort(compareStrings);
}

/**
 * §6.3 tier 1–2: agents in one fine cell and class.
 *
 * @param {object} deps `{ kv }`
 * @param {string} shardId
 * @param {string} fineCellId
 * @param {string} availabilityClass
 * @param {object} [filters]
 * @returns {Promise<string[]>}
 */
function candidatesInFineCell(deps, shardId, fineCellId, availabilityClass, filters) {
  return membersOf(deps, fineKey(shardId, fineCellId, availabilityClass), { shardId, ...filters });
}

/**
 * §6.3 tier 4: the regional coarse-cell sweep.
 *
 * @param {object} deps `{ kv }`
 * @param {string} shardId
 * @param {string} coarseCellId
 * @param {string} availabilityClass
 * @param {object} [filters]
 * @returns {Promise<string[]>}
 */
function candidatesInCoarseCell(deps, shardId, coarseCellId, availabilityClass, filters) {
  return membersOf(deps, coarseKey(shardId, coarseCellId, availabilityClass), { shardId, ...filters });
}

/**
 * Cold Index rebuild (§18.5, B3): reconstruct the index from durable state, not
 * from Redis, because Redis is what was just lost. Idempotent — re-running it over
 * the same records converges to the same index, since every write is keyed by the
 * record's own current cell/class rather than accumulated.
 *
 * `records` is pre-assembled by the caller (the index maintainer worker, which owns
 * the `Observation`/`Commitment`/`Agent` join `AgentCellPosition` mirrors) via
 * `positionRecord()`; this function performs no Prisma I/O itself.
 *
 * @param {object} deps `{ kv }`
 * @param {Array<object|null>} records `positionRecord()` outputs (or nulls, for
 *   agents that resolved to "not indexable" — recorded in `skipped`)
 * @returns {Promise<{ ok: boolean, indexed: number, skipped: number, failed: number }>}
 */
async function rebuildFromRecords(deps, records) {
  let indexed = 0;
  let skipped = 0;
  let failed = 0;

  // Canonical order (agent id) so a rebuild's write sequence is deterministic —
  // not load-bearing for correctness (the index is advisory, §3.3), but it keeps
  // a replayed rebuild's Redis command trace reproducible for diagnosis.
  const ordered = [...(records || [])].sort((a, b) =>
    compareStrings((a && a.agentId) || "", (b && b.agentId) || ""),
  );

  for (const record of ordered) {
    if (!record) {
      skipped += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await applyPosition(deps, null, record);
    if (result.ok) indexed += 1;
    else failed += 1;
  }

  return { ok: failed === 0, indexed, skipped, failed };
}

module.exports = {
  AVAILABILITY_CLASS,
  AVAILABILITY_CLASSES,
  KEY_PREFIX,
  isAvailabilityClass,
  fineKey,
  coarseKey,
  capabilityKey,
  containerKey,
  classify,
  positionRecord,
  keysFor,
  applyPosition,
  removePosition,
  candidatesInFineCell,
  candidatesInCoarseCell,
  rebuildFromRecords,
};

"use strict";

/**
 * Feasibility caching and invalidation (§7.6) — **Tier 0**.
 *
 * > Full feasibility evaluation for 200 candidates per Leg across a large batch is
 * > expensive. Three levels of caching, **each with an explicit invalidation rule**.
 *
 * ── The three levels, and the key each is keyed by ─────────────────────────
 *
 * | Level | Predicates | Redis key | Invalidated by |
 * |---|---|---|---|
 * | 1 Agent-invariant | F1–F12 | `engine:feas:agent:{agentId}` | any change to lifecycle, health, capability, firmware, or certification |
 * | 2 Agent×MissionClass | F21, F25, F26, F28, F29 | `engine:feas:class:{agentClass}:{missionClass}:{zone}` | config or map version change |
 * | 3 Mission-specific | the rest | not cached | — ordered last and short-circuit early |
 *
 * The register is the authority for which predicate sits at which level; this module
 * reads `cacheTier` from it rather than re-listing the membership, so adding a
 * predicate cannot leave the two lists disagreeing.
 *
 * ── Invalidation is by stamp, not by hope ───────────────────────────────────
 * §7.6 states each level's invalidation rule as an *event* ("any change to lifecycle,
 * health, capability, firmware, or certification"). Implementing that as a delete-on-
 * write from every writer would work exactly as long as every writer remembered, and
 * would fail silently the first time one did not — the failure mode being a stale
 * *positive*, which is the one that matters.
 *
 * So the rule is inverted into a **validity stamp** the reader checks: every entry
 * records the versions it was computed under, and a read is a hit only when the
 * caller's current stamps match. A writer that forgets to invalidate now produces a
 * miss rather than a stale hit, because the stamp it forgot to bump is the stamp the
 * reader compares. This is the same discipline §4.5 applies to timers keyed on an
 * entity's own version, for the same reason.
 *
 * A TTL is applied underneath as a backstop, never as the primary mechanism.
 *
 * ── The negative cache, and why its TTL is derived from the reason ─────────
 * > **A negative cache is maintained for infeasible pairings** keyed by the reason,
 * > with a TTL matched to the reason's volatility: a capability mismatch is stable for
 * > the agent's configuration lifetime, while an energy shortfall is valid only until
 * > the next state update. **Caching a rejection with the wrong TTL is a correctness
 * > hazard, so the TTL MUST be derived from the reason rather than set globally.**
 *
 * `negativeTtlSeconds()` derives it from the *rejecting predicate*, which is the
 * machine-readable form of "the reason". Predicates in the §10.3.2 volatile subset are
 * **never** negatively cached at all: their inputs change on every state update, so no
 * TTL is short enough to be principled, and the honest answer is to re-evaluate.
 *
 * ── No clock, no store ──────────────────────────────────────────────────────
 * This module is in the decision path (T6), so it reads no clock: `nowMs` is supplied.
 * The kv client is injected rather than imported, which keeps the module pure enough
 * to test and keeps Tier 0 free of a transport dependency.
 */

const { CACHE_TIER, predicate } = require("./register");

/** §7.6 / the plan's Redis changes. @structural the specification's own key prefixes */
const KEY_PREFIX = Object.freeze({
  AGENT: "engine:feas:agent",
  CLASS: "engine:feas:class",
  NEGATIVE: "engine:feas:neg",
});

/**
 * The stamps §7.6 level 1 names: "any change to lifecycle, health, capability,
 * firmware, or certification".
 * @structural the specification's own invalidation triggers
 */
const AGENT_STAMPS = Object.freeze([
  "lifecycleVersion",
  "healthVersion",
  "capabilityVersion",
  "firmwareVersion",
  "certificationVersion",
]);

/**
 * The stamps §7.6 level 2 names: "invalidated by config or map version change".
 * @structural the specification's own invalidation triggers
 */
const CLASS_STAMPS = Object.freeze(["configVersion", "mapVersion"]);

/**
 * Level-1 key: `engine:feas:agent:{agentId}`.
 *
 * @param {string} agentId
 * @returns {string}
 */
function agentKey(agentId) {
  return `${KEY_PREFIX.AGENT}:${agentId}`;
}

/**
 * Level-2 key: `engine:feas:class:{agentClass}:{missionClass}:{zone}`.
 *
 * @param {string} agentClassId
 * @param {string} missionClass
 * @param {string} zoneId
 * @returns {string}
 */
function classKey(agentClassId, missionClass, zoneId) {
  return `${KEY_PREFIX.CLASS}:${agentClassId}:${missionClass}:${zoneId}`;
}

/**
 * Negative-cache key: `engine:feas:neg:{pairKey}`.
 *
 * The pair key is `(agentId, legId)` — the pairing, which is what was rejected. A key
 * on the agent alone would suppress the agent for every Leg, and a key on the Leg
 * alone would suppress the Leg for every agent; both are wrong in the same way.
 *
 * @param {string} agentId
 * @param {string} legId
 * @returns {string}
 */
function negativeKey(agentId, legId) {
  return `${KEY_PREFIX.NEGATIVE}:${agentId}:${legId}`;
}

/**
 * Collect the stamps that govern a cache level from a snapshot.
 *
 * @param {readonly string[]} names
 * @param {object} source
 * @returns {object|null} null when any stamp is missing — an entry that cannot state
 *   what it was computed under cannot be validated, so it is not written
 */
function stampsFrom(names, source) {
  const stamps = {};
  for (const name of names) {
    const value = source ? source[name] : undefined;
    if (value === undefined || value === null) return null;
    stamps[name] = String(value);
  }
  return stamps;
}

/**
 * Do two stamp sets agree on every governing version?
 *
 * @param {object|null} entryStamps
 * @param {object|null} currentStamps
 * @returns {boolean}
 */
function stampsMatch(entryStamps, currentStamps) {
  if (!entryStamps || !currentStamps) return false;
  const keys = Object.keys(currentStamps);
  if (keys.length !== Object.keys(entryStamps).length) return false;
  return keys.every((key) => entryStamps[key] === currentStamps[key]);
}

/**
 * Derive a negative-cache TTL from the rejecting predicate (§7.6).
 *
 * The predicate *is* the machine-readable reason, and its §7.6 cache tier is the
 * machine-readable volatility of that reason:
 *
 *   - **volatile subset** — never cached. Its inputs change on every state update, so
 *     no TTL is principled; re-evaluating is the honest answer.
 *   - **agent-invariant** — stable for the agent's configuration lifetime.
 *   - **class** — stable until a config or map version change.
 *   - **mission-specific** — stable only for this mission's parameters.
 *
 * Returns `null` for "do not cache", which callers must treat as a refusal rather
 * than as a zero TTL.
 *
 * @param {string} predicateId
 * @param {object} config resolved configuration view
 * @returns {number|null} TTL in seconds, or null to refuse caching
 */
function negativeTtlSeconds(predicateId, config) {
  const entry = predicate(predicateId);
  if (!entry) return null;

  // The correctness hazard §7.6 names, closed structurally: a volatile predicate's
  // rejection is valid only until the next state update, and this module cannot know
  // when that is.
  if (entry.volatile) return null;

  const ttls = config ? readTtlMap(config) : undefined;
  if (!ttls) return null;

  const ttl = ttls[entry.cacheTier];
  return typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0 ? ttl : null;
}

/**
 * @param {object|Map} config
 * @returns {object|undefined}
 */
function readTtlMap(config) {
  const name = "feasibility.negative_cache_ttl";
  if (config instanceof Map) return config.get(name);
  if (typeof config.get === "function") return config.get(name);
  return config[name];
}

/* ═══════════════════════════════════════════════════════════════════════════
   Read and write
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Build an entry for storage.
 *
 * @param {object} verdicts predicateId → predicate result
 * @param {object} stamps
 * @param {number} nowMs the pinned decision time — never a clock read (T6)
 * @returns {object}
 */
function entry(verdicts, stamps, nowMs) {
  return { verdicts, stamps, writtenAtMs: nowMs };
}

/**
 * Read a cached level-1 or level-2 result, honouring the stamp check.
 *
 * @param {object} deps `{ kv }` — `kv.get(key)` returning a JSON string or null
 * @param {string} key
 * @param {object} currentStamps
 * @returns {Promise<{ hit: boolean, verdicts: object|null, reason: string }>}
 */
async function read(deps, key, currentStamps) {
  if (!deps || !deps.kv || typeof deps.kv.get !== "function") {
    return { hit: false, verdicts: null, reason: "no cache client supplied" };
  }

  let raw;
  try {
    raw = await deps.kv.get(key);
  } catch {
    // A cache failure is never a feasibility answer. §10.4 and invariant I16 make the
    // cache non-authoritative; a read error is a miss.
    return { hit: false, verdicts: null, reason: "cache read failed" };
  }

  if (raw === null || raw === undefined) return { hit: false, verdicts: null, reason: "miss" };

  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { hit: false, verdicts: null, reason: "cache entry is unreadable" };
  }

  if (!stampsMatch(parsed && parsed.stamps, currentStamps)) {
    // The invalidation rule, applied by the reader. A writer that forgot to invalidate
    // lands here as a miss rather than as a stale positive.
    return { hit: false, verdicts: null, reason: "stamp mismatch — an input governing this level has changed" };
  }

  return { hit: true, verdicts: parsed.verdicts || null, reason: "hit" };
}

/**
 * Write a level-1 or level-2 result.
 *
 * @param {object} deps `{ kv }` — `kv.set(key, value, { ex })`
 * @param {string} key
 * @param {object} verdicts
 * @param {object|null} stamps
 * @param {number} nowMs
 * @param {number|null} ttlSeconds
 * @returns {Promise<boolean>} whether the entry was written
 */
async function write(deps, key, verdicts, stamps, nowMs, ttlSeconds) {
  if (!deps || !deps.kv || typeof deps.kv.set !== "function") return false;
  // An entry that cannot state what it was computed under cannot be validated on read,
  // so it is not written at all rather than written unvalidatable.
  if (!stamps) return false;

  try {
    await deps.kv.set(key, JSON.stringify(entry(verdicts, stamps, nowMs)), ttlSeconds ? { ex: ttlSeconds } : undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a rejection in the negative cache, if its reason permits caching at all.
 *
 * @param {object} deps `{ kv }`
 * @param {{ agentId: string, legId: string, predicateId: string }} rejection
 * @param {object} config
 * @param {number} nowMs
 * @returns {Promise<{ cached: boolean, ttlSeconds: number|null, reason: string }>}
 */
async function recordRejection(deps, rejection, config, nowMs) {
  const ttlSeconds = negativeTtlSeconds(rejection.predicateId, config);

  if (ttlSeconds === null) {
    return {
      cached: false,
      ttlSeconds: null,
      reason:
        `${rejection.predicateId} is in the volatile subset or has no derived TTL; its rejection is ` +
        "valid only until the next state update, and caching it with a guessed TTL is the " +
        "correctness hazard §7.6 forbids",
    };
  }

  if (!deps || !deps.kv || typeof deps.kv.set !== "function") {
    return { cached: false, ttlSeconds, reason: "no cache client supplied" };
  }

  try {
    await deps.kv.set(
      negativeKey(rejection.agentId, rejection.legId),
      JSON.stringify({ predicateId: rejection.predicateId, atMs: nowMs }),
      { ex: ttlSeconds },
    );
    return { cached: true, ttlSeconds, reason: "cached" };
  } catch {
    return { cached: false, ttlSeconds, reason: "cache write failed" };
  }
}

/**
 * Look up a negative-cache entry for a pairing.
 *
 * @param {object} deps `{ kv }`
 * @param {string} agentId
 * @param {string} legId
 * @returns {Promise<{ rejected: boolean, predicateId: string|null }>}
 */
async function readRejection(deps, agentId, legId) {
  if (!deps || !deps.kv || typeof deps.kv.get !== "function") return { rejected: false, predicateId: null };
  try {
    const raw = await deps.kv.get(negativeKey(agentId, legId));
    if (raw === null || raw === undefined) return { rejected: false, predicateId: null };
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { rejected: true, predicateId: (parsed && parsed.predicateId) || null };
  } catch {
    return { rejected: false, predicateId: null };
  }
}

/**
 * Which predicates a given cache level covers, read from the register.
 *
 * @param {string} cacheTier one of `CACHE_TIER`
 * @returns {string[]}
 */
function predicatesAt(cacheTier) {
  const { PREDICATES } = require("./register");
  return PREDICATES.filter((entryRow) => entryRow.cacheTier === cacheTier).map((entryRow) => entryRow.id);
}

module.exports = {
  KEY_PREFIX,
  CACHE_TIER,
  AGENT_STAMPS,
  CLASS_STAMPS,
  agentKey,
  classKey,
  negativeKey,
  stampsFrom,
  stampsMatch,
  negativeTtlSeconds,
  entry,
  read,
  write,
  recordRejection,
  readRejection,
  predicatesAt,
};

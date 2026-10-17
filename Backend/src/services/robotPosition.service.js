"use strict";

/**
 * A robot's latest **measured** position, with its age, quality and provenance — the
 * `position` object the dashboard reads beside the legacy `lat`/`lon`.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `lat`/`lon` on `robot:update`, `GET /api/robots/state` and the `Robot` row are the robot's
 * last known coordinates. A TELEMETRY frame that omits them (the Pi omits them whenever it has
 * no fresh fix) used to be completed from the previous value and re-published with the frame's
 * fresh liveness, so a fix hours old was shown exactly as a live one. Those fields are kept for
 * existing clients, but they are no longer refreshed by a frame without coordinates, and this
 * object says what they are: when the fix was measured, how good it was, who measured it, and
 * whether it is fresh.
 *
 * ── Source ─────────────────────────────────────────────────────────────────
 * Only the §2.7 position `Observation` — the record `positionObservation.recordPositionObservation`
 * writes from a frame's own coordinates and its agent timestamp. Never the fallback, never the
 * commissioning Location, never a re-stamped value. A KV copy (`position:{robotId}`) is written
 * beside each accepted Observation so the telemetry path does not read the store per frame; on a
 * miss (a restart) the newest Observation is read once and copied.
 *
 * ── Freshness ──────────────────────────────────────────────────────────────
 * `connectivity.max_heartbeat_age` — the budget F16 holds the same Observation to for dispatch
 * (`agentFacts.service`, `safetyRelevantObservations.position`). `fresh` is therefore the same
 * answer the engine gives, and a fix that is not fresh here is not fresh for assignment either.
 * A dead-reckoned position is never fresh (§2.7: prohibited for safety constraints).
 *
 * This module decides nothing. It describes; the engine's own predicates decide.
 */

const { safeJsonParse } = require("../utils/json");
const positionObservation = require("./positionObservation.service");

/** The freshness budget F16 applies to a position. @structural a parameter name */
const FRESHNESS_PARAMETER = "connectivity.max_heartbeat_age";

/**
 * How long the KV copy is kept. The Observation is the durable record; this is a cache of its
 * newest row, re-read from the store after it expires. @structural
 */
const POSITION_STATE_TTL_SEC = 48 * 3600;

/** At most one store read per robot per this interval when the KV copy is missing. @structural */
const STORE_LOOKUP_INTERVAL_MS = 60_000;

/** @structural the three answers to "where is it?" */
const STATUS = Object.freeze({
  /** A measured fix within the freshness budget. */
  LIVE: "LIVE",
  /** A measured fix exists, older than the budget (or dead-reckoned). */
  STALE: "STALE",
  /** No measured fix on record. */
  UNKNOWN: "UNKNOWN",
});

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** @param {string} robotId */
function positionKey(robotId) {
  return `position:${robotId}`;
}

/**
 * The freshness budget in milliseconds: the pinned configuration's value, else the register's.
 * @param {object|null} snapshot
 * @returns {number|null}
 */
function freshnessBoundMsFrom(snapshot) {
  const seconds = positionObservation.resolvedPositiveParameter(snapshot || null, FRESHNESS_PARAMETER);
  return isNumber(seconds) ? seconds * 1000 : null;
}

/**
 * The stored shape, from a `recordPositionObservation` success result.
 * @param {string} robotId
 * @param {object} result
 * @returns {object|null}
 */
function recordFromWrite(robotId, result) {
  if (!result || result.written !== true || !result.position) return null;
  const p = result.position;
  if (!isNumber(p.lat) || !isNumber(p.lon) || !isNumber(result.observedAtMs)) return null;
  return {
    robotId,
    lat: p.lat,
    lon: p.lon,
    observedAtMs: result.observedAtMs,
    fixType: typeof p.fixType === "string" ? p.fixType : null,
    hAccM: isNumber(p.hAccM) ? p.hAccM : null,
    provenance: typeof result.provenance === "string" ? result.provenance : null,
    deadReckoned: p.deadReckoned === true,
  };
}

/**
 * The stored shape, from a position `Observation` row.
 * @param {string} robotId
 * @param {object|null} row `{ value, observedAt, uncertaintyRadiusM, deadReckoned }`
 * @returns {object|null}
 */
function recordFromObservation(robotId, row) {
  if (!row || !row.value || typeof row.value !== "object") return null;
  const observedAtMs = new Date(row.observedAt).getTime();
  if (!isNumber(row.value.lat) || !isNumber(row.value.lon) || !isNumber(observedAtMs)) return null;
  return {
    robotId,
    lat: row.value.lat,
    lon: row.value.lon,
    observedAtMs,
    fixType: typeof row.value.fixType === "string" ? row.value.fixType : null,
    hAccM: isNumber(row.uncertaintyRadiusM) ? row.uncertaintyRadiusM : null,
    provenance: typeof row.value.provenance === "string" ? row.value.provenance : null,
    deadReckoned: row.deadReckoned === true,
  };
}

function validRecord(robotId, record) {
  return Boolean(record) && typeof record === "object" && record.robotId === robotId && isNumber(record.lat) && isNumber(record.lon) && isNumber(record.observedAtMs);
}

/**
 * Keep the robot's newest measured position. Called only after its Observation was written.
 * @param {object} kv
 * @param {object} record from `recordFromWrite`
 */
async function rememberMeasuredPosition(kv, record) {
  if (!kv || !record) return;
  await kv.set(positionKey(record.robotId), JSON.stringify(record), { ex: POSITION_STATE_TTL_SEC });
}

/** robotId → when the store was last asked, per process, bounded by fleet size. */
const lastStoreLookup = new Map();

/**
 * The robot's newest measured position, or null when it has none. KV first; on a miss, the
 * newest position Observation (at most once per `STORE_LOOKUP_INTERVAL_MS` per robot), copied
 * back to KV.
 *
 * @param {{ prisma?: object, kv?: object, robotId: string, nowMs?: number, cached?: string|null }} input
 *   `cached`: the raw KV value when the caller has already read it in a batch
 * @returns {Promise<object|null>}
 */
async function latestMeasuredPosition(input) {
  const { prisma, kv, robotId } = input || {};
  if (!robotId) return null;
  const nowMs = input && isNumber(input.nowMs) ? input.nowMs : Date.now();

  let raw = input && Object.prototype.hasOwnProperty.call(input, "cached") ? input.cached : undefined;
  if (raw === undefined && kv) {
    try {
      raw = await kv.get(positionKey(robotId));
    } catch {
      raw = null;
    }
  }
  const stored = safeJsonParse(raw);
  if (validRecord(robotId, stored)) return stored;

  if (!prisma || !prisma.observation) return null;
  const last = lastStoreLookup.get(robotId);
  if (last !== undefined && nowMs - last < STORE_LOOKUP_INTERVAL_MS) return null;
  lastStoreLookup.set(robotId, nowMs);
  if (lastStoreLookup.size > 50_000) lastStoreLookup.clear();

  const row = await prisma.observation.findFirst({
    // `Agent.agentId` is the robot's code (`legacyRobot.robotToAgent`).
    where: { kind: positionObservation.POSITION_KIND, agent: { agentId: robotId } },
    orderBy: { observedAt: "desc" },
    select: { value: true, observedAt: true, uncertaintyRadiusM: true, deadReckoned: true },
  });
  const record = recordFromObservation(robotId, row);
  if (record && kv) {
    try {
      await rememberMeasuredPosition(kv, record);
    } catch {
      // the store answered; the cache is an optimisation
    }
  }
  return record;
}

/**
 * The `position` object a client reads.
 *
 * @param {object|null} record the robot's newest measured position, or null
 * @param {{ nowMs?: number, freshnessBoundMs?: number|null, acceptedFixTypes?: string[]|null }} [options]
 * @returns {object}
 */
function describePosition(record, options) {
  const settings = options || {};
  const nowMs = isNumber(settings.nowMs) ? settings.nowMs : Date.now();
  const boundMs = isNumber(settings.freshnessBoundMs) ? settings.freshnessBoundMs : null;

  if (!record) {
    return {
      status: STATUS.UNKNOWN,
      measured: false,
      fresh: false,
      lat: null,
      lon: null,
      observedAt: null,
      observedAtMs: null,
      ageMs: null,
      fixType: null,
      hAccM: null,
      provenance: null,
      deadReckoned: false,
      qualified: null,
      freshnessBoundMs: boundMs,
    };
  }

  const ageMs = Math.max(0, nowMs - record.observedAtMs);
  // No budget, no freshness: an unbounded age is not a fresh one.
  const fresh = record.deadReckoned !== true && boundMs !== null && ageMs <= boundMs;
  return {
    status: fresh ? STATUS.LIVE : STATUS.STALE,
    measured: true,
    fresh,
    lat: record.lat,
    lon: record.lon,
    observedAt: new Date(record.observedAtMs).toISOString(),
    observedAtMs: record.observedAtMs,
    ageMs,
    fixType: record.fixType,
    hAccM: record.hAccM,
    provenance: record.provenance,
    deadReckoned: record.deadReckoned === true,
    // The physical-evidence bar (`positionObservation.isQualifiedPhysicalFix`); not applicable
    // to a simulated fix, which is graded by its own provenance.
    qualified:
      record.provenance === positionObservation.PROVENANCE.PHYSICAL
        ? positionObservation.isQualifiedPhysicalFix(record, settings.acceptedFixTypes || null)
        : null,
    freshnessBoundMs: boundMs,
  };
}

/** Test seam. */
function resetRobotPositionState() {
  lastStoreLookup.clear();
}

module.exports = {
  FRESHNESS_PARAMETER,
  POSITION_STATE_TTL_SEC,
  STORE_LOOKUP_INTERVAL_MS,
  STATUS,
  positionKey,
  freshnessBoundMsFrom,
  recordFromWrite,
  recordFromObservation,
  rememberMeasuredPosition,
  latestMeasuredPosition,
  describePosition,
  resetRobotPositionState,
};

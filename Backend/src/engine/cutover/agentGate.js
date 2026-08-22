"use strict";

/**
 * May this agent-facing path act as the engine, for the shard this session belongs to?
 * — **Tier 0 by consequence** (it stands in front of commitment releases, outbox
 * settlement and authority-epoch advances).
 *
 * ── The defect this module exists to close (D-6) ────────────────────────────
 * `cutover/enabled.js` was written because the cutover switch has **two halves** and
 * `process.env.ENGINE_ENABLED === "true"` had been "scattered across" the codebase:
 *
 *   1. `processEnabled()` — does this *process* participate in the engine at all?
 *   2. `configEnabled()`  — is *this shard* cut over (`cutover.engine_enabled`, region scope)?
 *
 * §22.4 item 4 and the execution plan both stage the cutover **per shard**, and
 * `cutover/stage.js` goes to considerable lengths to enforce that ordering. Phase 15
 * converted exactly one call site — `services/task.service.js`, the intake path — and left
 * every socket handler reading only the process half. Three of those guard engine *write*
 * paths, so during a staged rollout (which *requires* a deployment-wide
 * `ENGINE_ENABLED=true`) the agent-facing writes were live for **every** shard, including
 * the ones the staging order had deliberately not reached. `stage.js`'s five refusals
 * governed the intake path and not the agent path.
 *
 * The remedy is not "add `forShard` to six handlers". Six independently-written
 * conjunctions is how the first scattering happened. This module is the single decision,
 * and it answers a slightly larger question than `enabled.forShard()` does, because a
 * socket brings two facts a config snapshot does not:
 *
 *     ENGINE_ENABLED  ∧  session is authenticated  ∧  shard identity is known and fresh
 *                     ∧  a configuration is loaded ∧  that configuration enables this shard
 *
 * Every one of those is a *refusal* when absent. There is no branch in this file that
 * reaches "allowed" through a missing input.
 *
 * ── Where the shard identity comes from, and why it is not a per-event lookup ─
 * §3.5 makes shard membership an explicit durable fact: `ShardMembership` maps an agent to
 * a shard, `Shard` maps that shard to its region (1:1 — one shard owns one operating
 * region), and `cutover.engine_enabled` resolves at **region** scope because §22.2's
 * hierarchy has no shard level.
 *
 * Resolving that per socket event would put two indexed queries on the telemetry hot path,
 * which at fleet scale is a cost the staging order does not justify. So the identity is
 * resolved **once, at AUTH**, cached on `socket.data`, and refreshed on the heartbeat's
 * existing throttled pass. Three things keep the cache honest:
 *
 *   - **Migration invalidates the session, not the cache entry.** A migration advances the
 *     agent's `authority_epoch`, which voids every mission authority it holds (§19.2). An
 *     agent in that state must re-AUTH to adopt the new epoch (§11.5's handshake rides on
 *     `AUTH_SUCCESS`), so the composition root disconnects a migrated agent's sockets and
 *     the identity is re-resolved on reconnect. Push, once per migration — not poll, once
 *     per event.
 *   - **A bounded freshness window.** Defence in depth for a session that outlives its
 *     invalidation: an identity older than `maxAgeMs` is refused as `SHARD_IDENTITY_STALE`
 *     rather than trusted. Fail closed.
 *   - **The epoch is carried.** The identity records the `authority_epoch` it was resolved
 *     against, so a caller that *does* hold a fresher epoch (the command ACK path already
 *     compares one) can detect a superseded binding without a second query.
 *
 * ── Fail closed, and why the direction is not symmetric ─────────────────────
 * `enabled.js` states the asymmetry and it applies here unchanged: "the failure mode of a
 * wrong `true` is a shard running the engine nobody authorised, and the failure mode of a
 * wrong `false` is a shard that assigns nothing and says so loudly." Every unknown in this
 * file therefore resolves to a named refusal.
 */

const enabled = require("./enabled");

/**
 * The key the resolved identity is cached under on `socket.data`.
 * @structural the socket-data key, named once so no handler spells it itself
 */
const SOCKET_DATA_KEY = "engineShard";

/**
 * How stale a cached shard identity may be before it is refused.
 *
 * Not a threshold on a measured quantity and not a tuning knob: it is the outer bound on
 * how long a session may keep acting on a shard mapping nobody has re-read, and it is set
 * to twice the heartbeat's durable-mirror throttle (`legacy.liveness.db_flush_interval_ms`
 * = 15 s) so that one missed refresh does not sever a healthy session while two do. The
 * *primary* correctness mechanism is the migration invalidation described above; this is
 * the backstop for a session that outlives it.
 *
 * @structural the freshness backstop, expressed in refresh intervals rather than as a
 *   tuned threshold
 */
const DEFAULT_MAX_AGE_MS = 30_000;

/**
 * Why a request to act as the engine was refused. Named rather than boolean, because
 * "the engine is off" and "this shard has not been cut over yet" are different
 * operational states and an operator reading a log at 3 a.m. needs the difference.
 *
 * @structural the refusal taxonomy
 */
const REFUSAL = Object.freeze({
  /** `ENGINE_ENABLED` is not true for this process. */
  PROCESS_NOT_ENABLED: "PROCESS_NOT_ENABLED",
  /** The socket has not completed AUTH. An unauthenticated session names no agent. */
  SESSION_NOT_AUTHENTICATED: "SESSION_NOT_AUTHENTICATED",
  /** No shard identity is cached: the agent has never been placed, or AUTH did not resolve one. */
  SHARD_IDENTITY_UNRESOLVED: "SHARD_IDENTITY_UNRESOLVED",
  /** A shard identity is cached but older than the freshness bound. */
  SHARD_IDENTITY_STALE: "SHARD_IDENTITY_STALE",
  /**
   * The identity names a shard but no operating region.
   *
   * ── The fail-open this closes, found by the §19 hostile pass ─────────────
   * `cutover.engine_enabled` resolves at **region** scope (§22.2 has no shard level), and
   * `enabled.configEnabled()` builds its context as `if (regionId) context.region = regionId`
   * — so a null region yields an **empty context**, which resolves the parameter at *global*
   * scope. A deployment holding a global `cutover.engine_enabled = true` would therefore
   * enable a region-less shard: the answer to "is the whole deployment cut over" returned in
   * place of the answer to "is this shard cut over", which is the exact substitution the
   * per-shard staging exists to prevent.
   *
   * `Shard.regionId` is NOT NULL, so this should be unreachable through the data — but
   * `resolveIdentity()` sets `regionId: null` when the `Shard` read *throws*, which makes a
   * transient store blip a fail-open. Refusing by name is the only defensible direction: an
   * identity that cannot name a region cannot have the question asked about it.
   */
  SHARD_REGION_UNRESOLVED: "SHARD_REGION_UNRESOLVED",
  /** No published configuration snapshot is available to resolve the shard half against. */
  CONFIGURATION_UNAVAILABLE: "CONFIGURATION_UNAVAILABLE",
  /** Both halves asked; `cutover.engine_enabled` is not true for this shard's region. */
  SHARD_NOT_ENABLED: "SHARD_NOT_ENABLED",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Resolve an agent's authoritative shard identity from the durable record.
 *
 * `ShardMembership` is the authority (§3.5): an agent with no live membership row belongs
 * to **no** shard, which is a real state — commissioned but not yet placed — and is
 * deliberately not defaulted to `leadership.DEFAULT_SHARD_ID`. Defaulting here would
 * silently place every unplaced agent in whichever shard happens to be cut over first,
 * which is precisely the staging violation this module exists to prevent.
 *
 * @param {object} prisma a Prisma client or transaction client
 * @param {string} robotId the socket's agent identity (`Agent.agentId`, the business key)
 * @param {number} nowMs
 * @returns {Promise<{ agentRowId: string, agentId: string, shardId: string,
 *   regionId: string|null, authorityEpoch: string|null, resolvedAtMs: number }|null>}
 */
async function resolveIdentity(prisma, robotId, nowMs) {
  if (!prisma || !isNonEmptyString(robotId)) return null;

  const agent = await prisma.agent.findUnique({ where: { agentId: String(robotId) } });
  if (!agent) return null;

  const membership = await prisma.shardMembership.findFirst({
    where: { agentId: String(agent.id), supersededAt: null },
    orderBy: { movedAt: "desc" },
  });
  if (!membership || !isNonEmptyString(membership.shardId)) return null;

  // §3.5: one shard owns one operating region, and `cutover.engine_enabled` resolves at
  // region scope. A shard row that names no region cannot have the shard half resolved
  // against it, so the identity carries `regionId: null` and `assess()` refuses — rather
  // than resolving the parameter at global scope, which would answer a question about the
  // whole deployment as though it were a question about this shard.
  let regionId = null;
  try {
    const shard = await prisma.shard.findUnique({ where: { shardId: String(membership.shardId) } });
    regionId = shard && isNonEmptyString(shard.regionId) ? shard.regionId : null;
  } catch {
    regionId = null;
  }

  return {
    agentRowId: String(agent.id),
    agentId: String(agent.agentId),
    shardId: String(membership.shardId),
    regionId,
    authorityEpoch:
      agent.authorityEpoch === undefined || agent.authorityEpoch === null ? null : String(agent.authorityEpoch),
    resolvedAtMs: Number.isFinite(nowMs) ? nowMs : Date.now(),
  };
}

/**
 * Cache a resolved identity on the socket.
 *
 * @param {object} socket
 * @param {object|null} identity a `resolveIdentity()` result
 * @returns {object|null} the identity that was bound
 */
function bind(socket, identity) {
  if (!socket) return null;
  if (!socket.data) socket.data = {};
  socket.data[SOCKET_DATA_KEY] = identity || null;
  return socket.data[SOCKET_DATA_KEY];
}

/**
 * Drop a socket's cached identity, so the next assessment refuses until it is re-resolved.
 *
 * @param {object} socket
 * @returns {void}
 */
function invalidate(socket) {
  if (socket && socket.data) socket.data[SOCKET_DATA_KEY] = null;
}

/**
 * The cached identity, or null.
 *
 * @param {object} socket
 * @returns {object|null}
 */
function identityOf(socket) {
  const cached = socket && socket.data ? socket.data[SOCKET_DATA_KEY] : null;
  return cached || null;
}

/**
 * The whole question, answered once.
 *
 * Pure: every input is passed in, including the clock, so the staging tests can assert
 * each refusal without mutating `process.env` or waiting on a timer.
 *
 * @param {object} input
 * @param {object} input.socket the agent's session
 * @param {object|null} [input.snapshot] the published configuration snapshot
 * @param {object} [input.env] defaults to `process.env`
 * @param {number} [input.nowMs]
 * @param {number} [input.maxAgeMs] freshness bound; defaults to `DEFAULT_MAX_AGE_MS`
 * @returns {{ allowed: boolean, refusal: string|null, shardId: string|null,
 *   regionId: string|null, agentId: string|null }}
 */
function assess(input) {
  const source = input || {};
  const socket = source.socket || null;
  const nowMs = Number.isFinite(source.nowMs) ? source.nowMs : Date.now();
  const maxAgeMs = Number.isFinite(source.maxAgeMs) && source.maxAgeMs > 0 ? source.maxAgeMs : DEFAULT_MAX_AGE_MS;

  const refuse = (refusal, identity) =>
    Object.freeze({
      allowed: false,
      refusal,
      shardId: identity ? identity.shardId : null,
      regionId: identity ? identity.regionId : null,
      agentId: identity ? identity.agentId : null,
    });

  // 1. The process half. Cheapest, and the one that is false on every deployment that has
  //    not begun the cutover at all.
  if (!enabled.processEnabled(source.env)) return refuse(REFUSAL.PROCESS_NOT_ENABLED, null);

  // 2. The session. An unauthenticated socket names no agent, so it cannot name a shard,
  //    so there is no shard whose staging decision could authorise it.
  if (!socket || !socket.data || socket.data.isAuthed !== true) {
    return refuse(REFUSAL.SESSION_NOT_AUTHENTICATED, null);
  }

  // 3. The shard identity, and its freshness.
  const identity = identityOf(socket);
  if (!identity || !isNonEmptyString(identity.shardId)) return refuse(REFUSAL.SHARD_IDENTITY_UNRESOLVED, identity);
  if (!Number.isFinite(identity.resolvedAtMs) || nowMs - identity.resolvedAtMs > maxAgeMs) {
    return refuse(REFUSAL.SHARD_IDENTITY_STALE, identity);
  }

  // 4. The region the shard half is resolved AT. Checked before the snapshot is consulted,
  //    because a missing region does not make the answer `false` — it makes the question a
  //    different one. See `SHARD_REGION_UNRESOLVED`.
  if (!isNonEmptyString(identity.regionId)) return refuse(REFUSAL.SHARD_REGION_UNRESOLVED, identity);

  // 5. A configuration to resolve the shard half against. `configEnabled()` would answer
  //    `false` for a null snapshot on its own; it is separated here so the refusal an
  //    operator sees distinguishes "this shard is not staged yet" from "this process never
  //    loaded a configuration", which are different incidents with different responses.
  const snapshot = source.snapshot || null;
  if (!snapshot || typeof snapshot.resolve !== "function") {
    return refuse(REFUSAL.CONFIGURATION_UNAVAILABLE, identity);
  }

  // 6. The shard half itself, through the module that owns the parameter and its scope.
  if (!enabled.configEnabled(snapshot, { shardId: identity.shardId, regionId: identity.regionId })) {
    return refuse(REFUSAL.SHARD_NOT_ENABLED, identity);
  }

  return Object.freeze({
    allowed: true,
    refusal: null,
    shardId: identity.shardId,
    regionId: identity.regionId,
    agentId: identity.agentId,
  });
}

/**
 * `assess()` reduced to the boolean the call sites want.
 *
 * @param {object} input as `assess`
 * @returns {boolean}
 */
function mayAct(input) {
  return assess(input).allowed === true;
}

module.exports = {
  SOCKET_DATA_KEY,
  DEFAULT_MAX_AGE_MS,
  REFUSAL,
  resolveIdentity,
  bind,
  invalidate,
  identityOf,
  assess,
  mayAct,
};

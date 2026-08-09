"use strict";

/**
 * The shard model (§3.5) — **Tier 1**.
 *
 * > An **AssignmentShard** owns a set of Agents and the Legs whose work is served by
 * > them, partitioned by **OperatingRegion** (a site, campus, depot catchment, or metro
 * > service area).
 * >
 * > - Every Agent belongs to exactly one shard at a time. Shard membership changes are
 * >   explicit, transactional handoffs, never inferred from position drift.
 * > - Every Leg is routed to exactly one shard at intake, determined by its first Stop's
 * >   region.
 *
 * This module is the vocabulary and the map. It declares the shard states, validates a
 * set of shard definitions against the properties §3.5 requires of them, and builds the
 * **region → shard map** that `intake/intake.js` routes against. It owns no leadership
 * (that is `election.js`), no membership writes (that is `membership.js`), and no sizing
 * arithmetic (that is `sizing.js`).
 *
 * ── Region → shard is a function, and that is the whole design ──────────────
 * "Every Leg is routed to exactly one shard at intake, determined by its first Stop's
 * region" is only well defined if at most one shard owns a region. `Shard.regionId` is
 * therefore unique at the schema, and `validateDefinitions()` refuses a definition set
 * that would break it here, at publish, rather than at the first Leg intake cannot route.
 *
 * The consequence is deliberate and is §3.5's own: a hot shard is not split by adding a
 * second shard inside its region. It is split by **redistricting** — the region becomes
 * two regions, each with its shard, and the zones redistrict with it (§3.6). §3.5 states
 * the reasoning: "A boundary that proves costly is evidence that the region definition is
 * wrong — the correct fix is redistricting, not global search."
 *
 * ── Draining is a routing decision, not a liveness one ──────────────────────
 * A DRAINING shard is still led, still commits, still supervises, and still dispatches.
 * What it stops doing is *accepting new Legs*, because §19.2's rebalance moves its agents
 * away one at a time and new work routed to it would be queued against a coordinator that
 * is giving away the supply to serve it. That distinction lives in `admitsNewWork()` and
 * nowhere else, so no caller has to re-derive it.
 *
 * ── No clock, no randomness ─────────────────────────────────────────────────
 * Every time value is supplied. A shard's state is a fact with a recorded time; a module
 * that read its own clock would make the record disagree with the operation that caused
 * it.
 */

const leadership = require("./leadership");

/**
 * §3.5 — the shard states. The migration's `Shard_state_known` CHECK is the schema
 * backstop for this list.
 * @structural the shard-state vocabulary
 */
const SHARD_STATE = Object.freeze({
  /** Serving, accepting new Legs, holding leadership. */
  ACTIVE: "ACTIVE",
  /** Serving and accepting, while agents are migrating in or out (§19.2). */
  REBALANCING: "REBALANCING",
  /** Serving the work it holds; accepting none. The state a shard being merged away is in. */
  DRAINING: "DRAINING",
  /** No agents, no Legs, no leadership. Retained so its decision records still name a shard. */
  RETIRED: "RETIRED",
});

/** @structural the ordered state list, for surfaces that enumerate it */
const SHARD_STATES = Object.freeze(Object.values(SHARD_STATE));

/**
 * The states that admit a new Leg at intake.
 *
 * REBALANCING is included and DRAINING is not, and the asymmetry is the point: a
 * rebalancing shard is gaining or losing agents but still owns its region, while a
 * draining shard is being emptied and its region reassigned. Routing to the second
 * produces a queue nothing will drain — §3.4's "stuck at PENDING with no record of the
 * failure", arrived at through the topology instead of through the scheduler.
 * @structural the routing-admissible state set
 */
const ADMITS_NEW_WORK = Object.freeze([SHARD_STATE.ACTIVE, SHARD_STATE.REBALANCING]);

/**
 * §3.5's two bounds, by the name the `Shard.bindingBound` column carries.
 * @structural the sizing-bound vocabulary
 */
const BINDING_BOUND = Object.freeze({
  ROUND_WALL_CLOCK: "ROUND_WALL_CLOCK",
  SERIAL_COMMIT: "SERIAL_COMMIT",
  NEITHER_EVALUATED: "NEITHER_EVALUATED",
});

/**
 * §3.5 / §19.2 — why a membership row exists. CHECK-constrained in the migration.
 * @structural the membership-reason vocabulary
 */
const MEMBERSHIP_REASON = Object.freeze({
  /** The initial placement. Supersedes no authority, so it advances no epoch. */
  COMMISSIONING: "COMMISSIONING",
  /** §19.2 — a hot shard redistricted into two; agents move to the new one. */
  REBALANCE_SPLIT: "REBALANCE_SPLIT",
  /** §19.2 — quiet shards merged; agents move to the survivor. */
  REBALANCE_MERGE: "REBALANCE_MERGE",
  /** §3.5 — a region boundary changed and the agent's region changed with it. */
  REDISTRICTING: "REDISTRICTING",
  /** An operator-directed move, audited to the operator. */
  OPERATOR: "OPERATOR",
});

/**
 * The reason that is exempt from advancing `authority_epoch`, matching the migration's
 * `ShardMembership_migration_advances_epoch` CHECK.
 * @structural the one reason with no prior authority to supersede
 */
const PLACEMENT_REASON = MEMBERSHIP_REASON.COMMISSIONING;

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Does this shard state admit a new Leg at intake?
 *
 * @param {string} state
 * @returns {boolean}
 */
function admitsNewWork(state) {
  return ADMITS_NEW_WORK.includes(state);
}

/**
 * Is this a state the shard vocabulary defines?
 *
 * Unknown is never permission (T2): an unrecognised state is refused rather than treated
 * as ACTIVE, because a state nobody defined the routing rule for is a state nobody
 * decided the routing rule for.
 *
 * @param {unknown} state
 * @returns {boolean}
 */
function isShardState(state) {
  return typeof state === "string" && SHARD_STATES.includes(state);
}

/**
 * Validate one shard definition — the shape the Config Service publishes and the `Shard`
 * table stores.
 *
 * @param {object} definition `{ shardId, regionId, state? }`
 * @returns {string[]} problems, empty when the definition is admissible
 */
function validateDefinition(definition) {
  const source = definition || {};
  const problems = [];

  if (!isNonEmptyString(source.shardId)) {
    problems.push("a shard definition names its shard id; §3.5 makes the shard the unit of scaling, failure isolation, leader election, and configuration scope, and each of those needs a name");
  }
  if (!isNonEmptyString(source.regionId)) {
    problems.push(
      `shard "${String(source.shardId)}" names no OperatingRegion. §3.5 partitions shards by region, and a shard ` +
        "with no region is one no Leg can be routed to: intake resolves a Leg's shard from its first Stop's region.",
    );
  }
  if (source.state !== undefined && source.state !== null && !isShardState(source.state)) {
    problems.push(
      `shard "${String(source.shardId)}" declares state "${String(source.state)}", which is not one of ` +
        `${SHARD_STATES.join(", ")}. Intake admits work to ACTIVE and REBALANCING and refuses the rest; a state ` +
        "outside the vocabulary would fall through that decision without anyone having made it.",
    );
  }

  return problems;
}

/**
 * Validate a whole definition set — the properties that are about the *set* rather than
 * about any member.
 *
 * Two are enforced, and both are §3.5's:
 *
 *   - **One shard per region.** Otherwise intake's "determined by its first Stop's
 *     region" names a choice with no rule to resolve it, and `Ω_terminal` — a maximum
 *     over prices within the search region (§6.4) — would no longer bound anything either
 *     shard could reach.
 *   - **Unique shard ids.** Every other table in the schema carries a plain `shardId`
 *     string; two shards sharing one would silently merge their queues, their decision
 *     records, and their leadership.
 *
 * @param {object[]} definitions
 * @returns {{ ok: boolean, problems: string[] }}
 */
function validateDefinitions(definitions) {
  const list = Array.isArray(definitions) ? definitions : [];
  const problems = [];

  const byRegion = new Map();
  const seenShardIds = new Set();

  for (const definition of list) {
    problems.push(...validateDefinition(definition));

    const shardId = definition && definition.shardId;
    const regionId = definition && definition.regionId;

    if (isNonEmptyString(shardId)) {
      if (seenShardIds.has(shardId)) {
        problems.push(
          `shard id "${shardId}" is defined twice. Every table in the schema carries a plain shardId string, so two ` +
            "definitions sharing one would merge two shards' queues, decision records, and leadership into one name.",
        );
      }
      seenShardIds.add(shardId);
    }

    if (isNonEmptyString(regionId)) {
      const existing = byRegion.get(regionId);
      if (existing !== undefined && existing !== shardId) {
        problems.push(
          `region "${regionId}" is claimed by both "${existing}" and "${String(shardId)}". §3.5 routes every Leg to ` +
            "exactly one shard determined by its first Stop's region, so region → shard must be a function. A hot " +
            "shard is split by redistricting the region into two, not by adding a second shard inside it.",
        );
      } else {
        byRegion.set(regionId, shardId);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * The published region → shard map, in the shape `intake.resolveShard` consumes.
 *
 * Draining and retired shards are **excluded**, so a Leg whose region is draining is
 * refused at intake with a reason rather than admitted to a queue that is being emptied.
 * The exclusion is here rather than in intake because it is a property of the shard, and
 * duplicating it at the routing site would give two places one answer to disagree over.
 *
 * @param {object[]} shards
 * @returns {Record<string, string>}
 */
function regionShardMap(shards) {
  const map = {};
  for (const shard of Array.isArray(shards) ? shards : []) {
    if (!shard || !isNonEmptyString(shard.regionId) || !isNonEmptyString(shard.shardId)) continue;
    if (!admitsNewWork(shard.state)) continue;
    map[shard.regionId] = shard.shardId;
  }
  return map;
}

/**
 * Read every shard from the durable table.
 *
 * @param {object} deps `{ prisma }`
 * @returns {Promise<object[]>}
 */
async function readShards(deps) {
  return deps.prisma.shard.findMany({ orderBy: { shardId: "asc" } });
}

/**
 * Read one shard by its identity.
 *
 * @param {object} deps `{ prisma }`
 * @param {string} shardId
 * @returns {Promise<object|null>}
 */
async function readShard(deps, shardId) {
  return deps.prisma.shard.findUnique({ where: { shardId: String(shardId) } });
}

/**
 * The published map, read from the durable table.
 *
 * Returns an **empty object when no shard has been defined**, which is the signal
 * `intake.resolveShard` reads as "single-shard deployment". That is not a fallback bolted
 * on for convenience: until a region → shard map exists there is exactly one shard, every
 * agent is in it, and refusing every Leg for the absence of configuration would be a
 * refusal for a property of the deployment rather than of the work.
 *
 * @param {object} deps `{ prisma }`
 * @returns {Promise<Record<string, string>>}
 */
async function readRegionShardMap(deps) {
  return regionShardMap(await readShards(deps));
}

/**
 * Create a shard and the leadership row guard G1 reads, in one transaction.
 *
 * The two are created together because the foreign key requires it and because the
 * requirement is real: `leadership.advanceFence()` refuses to create a leadership row
 * implicitly, on the grounds that "a missing row is not an advanced fence". A shard that
 * existed without one would be a shard against which every commit aborts for a reason
 * that names neither the shard nor the missing row.
 *
 * Idempotent: a second call for the same shard returns the existing rows unchanged, so a
 * re-run of a control-plane operation is safe.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ shardId, regionId, state?, createdAt }`
 * @returns {Promise<{ created: boolean, shard: object }>}
 */
async function ensureShard(deps, input) {
  const source = input || {};
  const problems = validateDefinition(source);
  if (problems.length > 0) {
    throw new Error(`refusing to create a shard from an invalid definition: ${problems.join("; ")}`);
  }

  const shardId = String(source.shardId);

  const existing = await deps.prisma.shard.findUnique({ where: { shardId } });
  if (existing) return { created: false, shard: existing };

  return deps.prisma.$transaction(async (tx) => {
    // The leadership row first: the shard's foreign key references it, and Phase 3's
    // `ensureShard` is idempotent so a shard re-created against an existing leadership
    // record inherits that record's fence rather than resetting it. Resetting it would
    // move a monotone counter backwards, which is the one thing G1 cannot tolerate.
    await leadership.ensureShard(tx, { shardId });

    const raced = await tx.shard.findUnique({ where: { shardId } });
    if (raced) return { created: false, shard: raced };

    const shard = await tx.shard.create({
      data: {
        shardId,
        regionId: String(source.regionId),
        state: source.state || SHARD_STATE.ACTIVE,
        drainingSince: (source.state || SHARD_STATE.ACTIVE) === SHARD_STATE.DRAINING ? source.createdAt || null : null,
      },
    });

    return { created: true, shard };
  });
}

/**
 * Move a shard between states, recording the drain instant the schema's
 * `Shard_draining_is_timed` CHECK requires.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ shardId, state, at }`
 * @returns {Promise<object>} the updated row
 */
async function setState(deps, input) {
  const source = input || {};
  if (!isShardState(source.state)) {
    throw new Error(
      `"${String(source.state)}" is not a shard state (§3.5). Unknown is never permission: a state outside the ` +
        "vocabulary has no routing rule, no leadership rule, and no place in the §3.5 sizing report.",
    );
  }

  return deps.prisma.shard.update({
    where: { shardId: String(source.shardId) },
    data: {
      state: source.state,
      // The CHECK requires the two to move together. Setting it here rather than leaving
      // it to the caller is what stops a drain that nobody timed.
      drainingSince: source.state === SHARD_STATE.DRAINING ? source.at || null : null,
    },
  });
}

/**
 * The read-only projection `GET /api/shards` renders, given a shard row, its leadership
 * record, and its sizing evaluation.
 *
 * Assembled here so the controller composes rather than computes: a surface that derived
 * "is this shard led" from its own reading of the lease would be a second implementation
 * of leadership, and the two would eventually disagree during exactly the incident the
 * surface exists for.
 *
 * @param {object} input `{ shard, leadership, sizing, nowMs }`
 * @returns {object}
 */
function describe(input) {
  const source = input || {};
  const shard = source.shard || {};
  const record = source.leadership || null;

  return Object.freeze({
    shardId: shard.shardId ?? null,
    regionId: shard.regionId ?? null,
    state: shard.state ?? null,
    admitsNewWork: admitsNewWork(shard.state),
    drainingSince: shard.drainingSince ?? null,
    agentCount: shard.agentCount ?? null,
    leadership: record
      ? {
          holder: record.holder ?? null,
          // The fence guard G1 compares against. Reported as a string: it is a BigInt,
          // and JSON has no representation for one that survives a round trip.
          leadershipFence: record.leadershipFence === undefined || record.leadershipFence === null
            ? null
            : String(record.leadershipFence),
          leaseExpiry: record.leaseExpiry ?? null,
          lastAdvancedBy: record.lastAdvancedBy ?? null,
          lastAdvancedAt: record.lastAdvancedAt ?? null,
        }
      : null,
    sizing: source.sizing || null,
    failover: {
      lastLeadershipChangeAt: shard.lastLeadershipChangeAt ?? null,
      lastFailoverAt: shard.lastFailoverAt ?? null,
      // §19.5 — "distinguishable from the reconciler's genuine orphan repairs (§12.4), so
      // that an expected consequence of failover is never mistaken for a defect signal".
      reconstructedLegs: shard.lastFailoverReconstructedLegs ?? null,
      recoveredCommitments: shard.lastFailoverRecoveredCommitments ?? null,
      roundsResumableAt: shard.roundsResumableAt ?? null,
      roundsResumable: shard.roundsResumableAt !== null && shard.roundsResumableAt !== undefined,
    },
  });
}

module.exports = {
  SHARD_STATE,
  SHARD_STATES,
  ADMITS_NEW_WORK,
  BINDING_BOUND,
  MEMBERSHIP_REASON,
  PLACEMENT_REASON,
  DEFAULT_SHARD_ID: leadership.DEFAULT_SHARD_ID,
  admitsNewWork,
  isShardState,
  validateDefinition,
  validateDefinitions,
  regionShardMap,
  readShards,
  readShard,
  readRegionShardMap,
  ensureShard,
  setState,
  describe,
};

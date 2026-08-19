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
 * ── It also owns §19.2's rebalance intent, and that is a state-machine job ───
 * A rebalance moves a shard between states and must eventually move it back. Since the
 * only correct place to decide "what does this shard go back to" is the same place that
 * decided "what does it go to", the intent's lifecycle lives here beside `SHARD_STATE`
 * rather than in the controller that opens it or the worker that executes it — neither of
 * which is present for the whole of it. The intent is durable (`ShardRebalance`) because
 * the control plane, the executor, and the restorer are three different call stacks and,
 * across a restart or a leadership handoff, three different processes.
 *
 * The invariant this module is now responsible for: **no terminal disposition of a
 * rebalance leaves its source shard in a state that admits no work.** `closeRebalance()`
 * restores the shard before it closes the intent, and the migration's
 * `ShardRebalance_restore_state_admits_work` CHECK makes it unrepresentable for the
 * recorded restore target to be anything else.
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
 * §19.2's rebalance lifecycle, by the name the `ShardRebalance.state` column carries.
 * CHECK-constrained in `20260819090000_shard_rebalance_intent`.
 *
 * Four states and not more. The temptation is a FAILED state, and it is refused for the
 * reason this whole table exists: a terminal state that is not "the shard is serving
 * again" is a terminal state a shard can be stranded in. A rebalance that cannot proceed
 * is CANCELLED **with a reason**, and the source shard goes back to serving — which is
 * the honest outcome, because the agents that did not move are still where they were.
 * @structural the rebalance-intent state vocabulary
 */
const REBALANCE_STATE = Object.freeze({
  /** Recorded; no agent has moved yet. */
  PENDING: "PENDING",
  /** At least one agent has moved; more remain. */
  EXECUTING: "EXECUTING",
  /** Every planned move has been performed, retired, or overtaken by events. */
  COMPLETED: "COMPLETED",
  /** Withdrawn — by an operator, or because the plan can no longer be carried out. */
  CANCELLED: "CANCELLED",
});

/**
 * The states in which the supervisor may still act on an intent, and in which the partial
 * unique index makes it exclusive per source shard.
 * @structural the open-intent state set
 */
const REBALANCE_OPEN_STATES = Object.freeze([REBALANCE_STATE.PENDING, REBALANCE_STATE.EXECUTING]);

/** @structural the terminal-intent state set */
const REBALANCE_TERMINAL_STATES = Object.freeze([REBALANCE_STATE.COMPLETED, REBALANCE_STATE.CANCELLED]);

/**
 * The membership reasons a rebalance may cite — every one except COMMISSIONING.
 *
 * COMMISSIONING is `membership.place()`'s reason and is exempt from advancing
 * `authority_epoch` because it supersedes no authority. An intent citing it would request
 * moves that `ShardMembership_migration_advances_epoch` then refuses, one agent at a time,
 * forever — an intent that can never complete, which is the class of state this table was
 * added to eliminate.
 * @structural the rebalance-reason vocabulary, matching the migration's CHECK
 */
const REBALANCE_REASONS = Object.freeze(
  Object.values(MEMBERSHIP_REASON).filter((reason) => reason !== MEMBERSHIP_REASON.COMMISSIONING),
);

/** Why the supervisor did not act on an intent this tick. @structural refusal labels */
const REBALANCE_REFUSAL = Object.freeze({
  ALREADY_OPEN: "A_REBALANCE_IS_ALREADY_OPEN_FOR_THIS_SHARD",
  NOT_OPEN: "NO_OPEN_REBALANCE_FOR_THIS_SHARD",
  EMPTY_PLAN: "THE_PLAN_CONTAINS_NO_MOVE",
});

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
 * The region → shard map for **attribution**, which is a different question from routing.
 *
 * `regionShardMap()` answers "where does a *new* Leg go", so it excludes shards that admit
 * no work. This one answers "which shard *owns* the work already in this region", and the
 * answer does not change because the shard stopped accepting more: a draining shard still
 * serves the work it holds, still holds leadership, and still reconciles on failover
 * (`admitsNewWork`'s own note says so).
 *
 * Two things went wrong when `failover.legsInShard()` used the routing map for this, and
 * both became reachable the moment the rebalance began actually draining shards:
 *
 *   - a DRAINING shard's new leader attributed **none** of its region's Legs to itself, so
 *     §19.5's reconciliation ran over an empty set for exactly the shard that was mid-
 *     rebalance and most likely to hold half-written state; and
 *   - if every published shard was DRAINING the routing map was *empty*, which
 *     `legsInShard` reads as "no map is published, so this is the single-shard deployment"
 *     — and every shard's leader would then reconcile the whole fleet. That is a second
 *     writer (§19.3), arrived at from inside this phase rather than from §12.4's.
 *
 * RETIRED shards are included deliberately: `SHARD_STATE.RETIRED` is documented as
 * "retained so its decision records still name a shard", and attribution is exactly the
 * kind of record that means.
 *
 * @param {object[]} shards
 * @returns {Record<string, string>}
 */
function regionOwnershipMap(shards) {
  const map = {};
  for (const shard of Array.isArray(shards) ? shards : []) {
    if (!shard || !isNonEmptyString(shard.regionId) || !isNonEmptyString(shard.shardId)) continue;
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
 * The attribution map, read from the durable table. See `regionOwnershipMap`.
 *
 * Empty **only** when no shard has been published at all, which is the honest signal for
 * the single-shard deployment. A fleet whose every shard happens to be draining is still a
 * multi-shard fleet.
 *
 * @param {object} deps `{ prisma }`
 * @returns {Promise<Record<string, string>>}
 */
async function readRegionOwnershipMap(deps) {
  return regionOwnershipMap(await readShards(deps));
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

/* ═══════════════════════════════════════════════════════════════════════════
   §19.2's durable rebalance intent

   The control plane records one; the shard supervisor executes it, one agent per
   tick; whoever terminalises it restores the source shard to a serving state. The
   three are in different call stacks, and after a restart or a leadership handoff
   in different processes, which is why the intent is a row rather than a value in
   an HTTP response.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Is this a rebalance state the vocabulary defines?
 *
 * @param {unknown} state
 * @returns {boolean}
 */
function isRebalanceState(state) {
  return typeof state === "string" && Object.values(REBALANCE_STATE).includes(state);
}

/**
 * The state a source shard is restored to when its intent terminalises.
 *
 * Recorded at creation rather than derived at closure, and the difference matters: by the
 * time an intent closes, the shard's state is the one *this rebalance* put it in
 * (DRAINING or REBALANCING), so a closure that read the current state would restore the
 * drain it is supposed to be ending.
 *
 * A shard that already admits work is restored to exactly what it was. Anything else —
 * including a shard found DRAINING because an earlier, un-executable rebalance stranded it
 * — is restored to ACTIVE, because ACTIVE is the only forward state that is not the strand.
 * The migration's `ShardRebalance_restore_state_admits_work` CHECK is the schema's
 * statement of the same rule.
 *
 * @param {string} currentState
 * @returns {string}
 */
function restoreStateFor(currentState) {
  return admitsNewWork(currentState) ? currentState : SHARD_STATE.ACTIVE;
}

/**
 * The shard state a rebalance of this size puts the source shard into.
 *
 * A shard giving away every member is DRAINING and must stop accepting new Legs; one
 * giving away some is REBALANCING and still serves. The asymmetry is `admitsNewWork`'s and
 * is stated there.
 *
 * @param {object} input `{ moveCount, memberCount }`
 * @returns {string}
 */
function rebalanceShardState(input) {
  const source = input || {};
  const moves = Number(source.moveCount || 0);
  const members = Number(source.memberCount || 0);
  return moves >= members && members > 0 ? SHARD_STATE.DRAINING : SHARD_STATE.REBALANCING;
}

/**
 * The open intent for a shard, or null.
 *
 * Scoped by `sourceShardId` and by nothing else. That scope is what keeps one shard's
 * coordinator from executing another shard's rebalance — §19.3's single writer, applied to
 * the one control-plane operation that writes across a shard boundary.
 *
 * @param {object} client a Prisma client or transaction client
 * @param {string} shardId the **source** shard
 * @returns {Promise<object|null>}
 */
async function readOpenRebalance(client, shardId) {
  return client.shardRebalance.findFirst({
    where: { sourceShardId: String(shardId), state: { in: [...REBALANCE_OPEN_STATES] } },
    orderBy: { requestedAt: "asc" },
  });
}

/**
 * Record a rebalance intent and move the source shard, in one transaction.
 *
 * The two are indivisible for the reason every other pairing in this codebase is: a shard
 * moved to DRAINING without an intent is the stranding P13-R4 describes, and an intent
 * without the state change is a rebalance that keeps admitting the work it is giving its
 * agents away to serve.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ shard, targetShardId, plan, reason, requestedBy, at, detail }`
 * @returns {Promise<{ ok: boolean, refusal: string|null, rebalance: object|null, shard: object|null }>}
 */
async function openRebalance(deps, input) {
  const source = input || {};
  const shard = source.shard || {};
  const shardId = String(shard.shardId);
  const moves = (source.plan && source.plan.moves) || [];

  if (moves.length === 0) {
    // Refused before anything durable happens. An intent with no move would take the shard
    // out of a serving state for a plan with nothing in it, and nothing would ever put it
    // back — the same stranding, reached through an empty membership set.
    return { ok: false, refusal: REBALANCE_REFUSAL.EMPTY_PLAN, rebalance: null, shard: null };
  }
  if (!REBALANCE_REASONS.includes(source.reason)) {
    throw new TypeError(
      `"${String(source.reason)}" is not a rebalance reason. One of: ${REBALANCE_REASONS.join(", ")}. ` +
        "COMMISSIONING is place()'s reason and is excluded on purpose: it is exempt from advancing " +
        "authority_epoch, so an intent citing it would request moves the schema then refuses forever.",
    );
  }

  const existing = await readOpenRebalance(deps.prisma, shardId);
  if (existing) {
    return { ok: false, refusal: REBALANCE_REFUSAL.ALREADY_OPEN, rebalance: existing, shard: null };
  }

  const nextState = rebalanceShardState({ moveCount: moves.length, memberCount: source.memberCount });

  try {
    return await openRebalanceTransaction(deps, source, shardId, moves, nextState);
  } catch (error) {
    // The partial unique index is the real enforcement, and it fires when two requests pass
    // the re-read below in the same instant. Reported as the refusal it is rather than
    // escaping as a 23505 the controller would render as a 500: nothing durable is wrong —
    // one request won, and the other is being told so.
    if (error && (error.code === "P2002" || error.code === "23505")) {
      const raced = await readOpenRebalance(deps.prisma, shardId);
      return { ok: false, refusal: REBALANCE_REFUSAL.ALREADY_OPEN, rebalance: raced, shard: null };
    }
    throw error;
  }
}

/**
 * `openRebalance`'s transaction, separated so the unique-index race has one place to be
 * caught and the happy path stays readable.
 *
 * @param {object} deps
 * @param {object} source
 * @param {string} shardId
 * @param {object[]} moves
 * @param {string} nextState
 * @returns {Promise<object>}
 */
async function openRebalanceTransaction(deps, source, shardId, moves, nextState) {
  const shard = source.shard || {};

  return deps.prisma.$transaction(async (tx) => {
    // Re-read inside the transaction. The index is what actually enforces exclusivity —
    // this makes the ordinary case a reported refusal rather than a constraint violation
    // the caller has to decode.
    const raced = await readOpenRebalance(tx, shardId);
    if (raced) return { ok: false, refusal: REBALANCE_REFUSAL.ALREADY_OPEN, rebalance: raced, shard: null };

    const rebalance = await tx.shardRebalance.create({
      data: {
        sourceShardId: shardId,
        targetShardId: String(source.targetShardId),
        state: REBALANCE_STATE.PENDING,
        reason: source.reason,
        restoreState: restoreStateFor(shard.state),
        plan: source.plan,
        plannedMoves: moves.length,
        completedMoves: 0,
        blocked: null,
        requestedBy: String(source.requestedBy || "control-plane"),
        requestedAt: source.at,
        detail: source.detail === undefined ? null : source.detail,
      },
    });

    const updated = await tx.shard.update({
      where: { shardId },
      data: {
        state: nextState,
        drainingSince: nextState === SHARD_STATE.DRAINING ? source.at : null,
      },
    });

    return { ok: true, refusal: null, rebalance, shard: updated };
  });
}

/**
 * Which of an intent's planned moves are still outstanding?
 *
 * Derived from the truth — who is *currently* a member of the source shard — rather than
 * counted off a column. That is what makes execution idempotent and crash-safe: a process
 * that dies between a committed migration and its bookkeeping resumes correctly, because
 * the agent it moved is no longer a member and therefore no longer outstanding. A counter
 * would have to be advanced in the migration's own transaction or be wrong, and
 * `membership.migrate()` owns that transaction.
 *
 * `completedMoves` is therefore a **statistic**, never the control variable.
 *
 * @param {object} input `{ rebalance, currentMemberAgentIds }`
 * @returns {{ outstanding: object[], blockedAgentIds: string[], resolved: number }}
 */
function outstandingMoves(input) {
  const source = input || {};
  const rebalance = source.rebalance || {};
  const moves = (rebalance.plan && rebalance.plan.moves) || [];
  const members = source.currentMemberAgentIds instanceof Set
    ? source.currentMemberAgentIds
    : new Set(source.currentMemberAgentIds || []);
  const blocked = new Set(((rebalance.blocked && rebalance.blocked.agentIds) || []).map(String));

  const outstanding = moves.filter((move) => members.has(String(move.agentId)) && !blocked.has(String(move.agentId)));

  return {
    outstanding,
    blockedAgentIds: [...blocked],
    // Everything the plan named that is no longer a member of the source shard: moved by
    // this intent, moved by an operator, or decommissioned. All three are "nothing left to
    // do for this agent", and none of them is a reason to keep the shard draining.
    resolved: moves.length - outstanding.length - blocked.size,
  };
}

/**
 * Record that one planned move committed.
 *
 * A conditional write on the intent still being open, so a move that lands after an
 * operator cancelled the intent updates nothing rather than reopening it.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ rebalance, at }`
 * @returns {Promise<{ recorded: boolean }>}
 */
async function recordRebalanceMove(deps, input) {
  const source = input || {};
  const rebalance = source.rebalance || {};

  const outcome = await deps.prisma.shardRebalance.updateMany({
    where: { id: String(rebalance.id), state: { in: [...REBALANCE_OPEN_STATES] } },
    data: {
      state: REBALANCE_STATE.EXECUTING,
      completedMoves: { increment: 1 },
      // Set once, on the first move. `startedAt` answers "how long has this rebalance been
      // running", and a value rewritten on every move answers "when did the last one
      // happen" — which `lastMoveAt` already does.
      ...(rebalance.startedAt ? {} : { startedAt: source.at }),
      lastMoveAt: source.at,
    },
  });
  return { recorded: Number(outcome.count || 0) > 0 };
}

/**
 * Retire one agent from an intent's plan, with the reason it will not be moved.
 *
 * §2.5 makes migrating an agent that holds goods an accountable transfer rather than an
 * implicit one, so `membership.migrate()` refuses it unless it is asked for explicitly.
 * Without this, that refusal would repeat every tick and the intent would never terminate —
 * a shard held out of service by an agent carrying a parcel. Retiring the move lets the
 * intent complete and says, durably, which agents it did not move and why.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ rebalance, agentId, refusal, detail, at }`
 * @returns {Promise<{ blocked: boolean, agentIds: string[] }>}
 */
async function blockRebalanceMove(deps, input) {
  const source = input || {};
  const rebalance = source.rebalance || {};
  const previous = (rebalance.blocked && rebalance.blocked.agentIds) || [];
  const reasons = (rebalance.blocked && rebalance.blocked.reasons) || {};

  const agentId = String(source.agentId);
  const agentIds = previous.includes(agentId) ? [...previous] : [...previous, agentId];

  const outcome = await deps.prisma.shardRebalance.updateMany({
    where: { id: String(rebalance.id), state: { in: [...REBALANCE_OPEN_STATES] } },
    data: {
      blocked: {
        agentIds,
        reasons: { ...reasons, [agentId]: { refusal: source.refusal || null, detail: source.detail || null, at: source.at } },
      },
    },
  });

  return { blocked: Number(outcome.count || 0) > 0, agentIds };
}

/**
 * Terminalise an intent and restore the source shard to a serving state.
 *
 * ── The ordering is the crash-safety argument ───────────────────────────────
 * The shard is restored **first**, inside the same transaction, and only then is the
 * intent closed. Both orderings are correct when the transaction commits; they differ when
 * the process dies mid-way, and only this one is safe. Closing first would leave a window
 * in which no open intent exists and the shard is still DRAINING — which is exactly
 * P13-R4's stranding, recreated by a crash. This way the intent stays open, the next tick
 * finds nothing outstanding, and it closes again. `closeRebalance` is idempotent for that
 * reason and not by accident.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ rebalance, state, closedReason, at }`
 * @returns {Promise<{ closed: boolean, shardRestoredTo: string|null }>}
 */
async function closeRebalance(deps, input) {
  const source = input || {};
  const rebalance = source.rebalance || {};
  const state = source.state;

  if (!REBALANCE_TERMINAL_STATES.includes(state)) {
    throw new TypeError(
      `"${String(state)}" is not a terminal rebalance state. Closing an intent is what restores the source shard to ` +
        `a serving state, so it may only be closed into one of: ${REBALANCE_TERMINAL_STATES.join(", ")}.`,
    );
  }

  const restoreTo = isShardState(rebalance.restoreState) && admitsNewWork(rebalance.restoreState)
    ? rebalance.restoreState
    : SHARD_STATE.ACTIVE;

  return deps.prisma.$transaction(async (tx) => {
    // The shard first — see the header. Conditional on it still being in a state this
    // rebalance put it in, so a shard an operator has since moved elsewhere is not
    // dragged back.
    const restored = await tx.shard.updateMany({
      where: { shardId: String(rebalance.sourceShardId), state: { in: [SHARD_STATE.DRAINING, SHARD_STATE.REBALANCING] } },
      data: { state: restoreTo, drainingSince: null },
    });

    const closed = await tx.shardRebalance.updateMany({
      where: { id: String(rebalance.id), state: { in: [...REBALANCE_OPEN_STATES] } },
      data: { state, closedAt: source.at, closedReason: source.closedReason || null },
    });

    return {
      closed: Number(closed.count || 0) > 0,
      shardRestoredTo: Number(restored.count || 0) > 0 ? restoreTo : null,
    };
  });
}

/**
 * The projection of an open intent that `GET /api/shards` renders.
 *
 * @param {object|null} rebalance
 * @returns {object|null}
 */
function describeRebalance(rebalance) {
  if (!rebalance) return null;
  const moves = (rebalance.plan && rebalance.plan.moves) || [];
  const blocked = (rebalance.blocked && rebalance.blocked.agentIds) || [];

  return Object.freeze({
    id: rebalance.id ?? null,
    sourceShardId: rebalance.sourceShardId ?? null,
    targetShardId: rebalance.targetShardId ?? null,
    state: rebalance.state ?? null,
    reason: rebalance.reason ?? null,
    restoreState: rebalance.restoreState ?? null,
    plannedMoves: rebalance.plannedMoves ?? moves.length,
    completedMoves: rebalance.completedMoves ?? 0,
    blockedAgentIds: blocked,
    requestedBy: rebalance.requestedBy ?? null,
    requestedAt: rebalance.requestedAt ?? null,
    startedAt: rebalance.startedAt ?? null,
    lastMoveAt: rebalance.lastMoveAt ?? null,
    closedAt: rebalance.closedAt ?? null,
    closedReason: rebalance.closedReason ?? null,
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
    // §19.2's open intent, if any. Reported beside the state it caused, because a shard
    // reading DRAINING with no visible reason is the state P13-R4 left behind and the one
    // an operator most needs an explanation for.
    rebalance: describeRebalance(source.rebalance || null),
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
  REBALANCE_STATE,
  REBALANCE_OPEN_STATES,
  REBALANCE_TERMINAL_STATES,
  REBALANCE_REASONS,
  REBALANCE_REFUSAL,
  DEFAULT_SHARD_ID: leadership.DEFAULT_SHARD_ID,
  admitsNewWork,
  isShardState,
  isRebalanceState,
  restoreStateFor,
  rebalanceShardState,
  validateDefinition,
  validateDefinitions,
  regionShardMap,
  regionOwnershipMap,
  readShards,
  readShard,
  readRegionShardMap,
  readRegionOwnershipMap,
  ensureShard,
  setState,
  readOpenRebalance,
  openRebalance,
  outstandingMoves,
  recordRebalanceMove,
  blockRebalanceMove,
  closeRebalance,
  describeRebalance,
  describe,
};

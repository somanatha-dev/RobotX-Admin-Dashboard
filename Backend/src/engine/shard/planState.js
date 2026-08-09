"use strict";

/**
 * The coordinator's round-local plan state — SOFT reservations (§2.6) — **Tier 1**.
 *
 * > **Decision: a SOFT reservation is round-local coordinator state and MUST NOT be
 * > written to the Commitment Store. A HARD commitment is durable. There is no third
 * > case.**
 *
 * > | Home | Assignment Coordinator's in-memory plan state for the shard | Commitment
 * > Store, durable |
 * > | On coordinator failover | **Reconstructed, never recovered** (§19.5) | Recovered |
 *
 * This module is that "in-memory plan state for the shard", and it is written so that
 * the durability rule is **structural** rather than a convention a future contributor
 * might not know about:
 *
 *   - The reservation objects carry a `toJSON` that **throws**. Any accidental
 *     `JSON.stringify` of plan state — into a log line, a cache write, a Prisma `Json`
 *     column — fails loudly at the moment of the mistake rather than silently persisting
 *     a forbidden fact. `snapshotForRecord()` exists for the one legitimate need, and it
 *     emits counts and identities, never the reservation objects themselves.
 *   - `assertNeverPersisted()` is offered so a test can assert the property against a
 *     real store rather than against this module's intentions.
 *
 * ── Why it must not be durable, in the specification's own arithmetic ───────
 * > A SOFT reservation is revised by the churn mechanism on a rolling horizon, so its
 * > write rate is the *re-planning* rate — rounds per second times planned Legs — not
 * > the mission rate. Persisting it would put an entire optimisation loop inside the
 * > serialised, exactly-once per-shard section, and the shard would exceed its own
 * > commit-transaction budget by more than an order of magnitude (§3.5, §20.2).
 *
 * §3.5's `k_txn ≈ 2.05` is the number this module protects: "**SOFT reservations
 * contribute zero**, because they are never written — this is the single largest term
 * the design removes from the serial section, and the reason the bound is satisfiable at
 * all."
 *
 * ── What *is* durable during planning ───────────────────────────────────────
 * > **What is durable during planning is the Leg's own state,** not its provisional
 * > binding. A Leg enters `PLANNED` with one durable write and one durable timer for its
 * > hardening deadline; the identity of the provisionally selected agent then changes as
 * > often as the optimiser wishes at no durable cost.
 *
 * So `reserve()` returns the fact that a Leg should be moved to `PLANNED`, and the
 * caller — the round — performs that one durable write. This module performs none.
 *
 * ── Losing it is safe, and `reconstructionPlan()` is why ────────────────────
 * > On failover the new leader finds Legs in `PLANNED` with no HARD commitment, returns
 * > them to `QUEUED`, and re-plans them in its first round (§19.5). The cost is one round
 * > of planning work. Because no agent was ever told anything, no physical state can
 * > disagree with the database, and no fence is needed to make this safe.
 *
 * `reconstructionPlan()` is that procedure as a pure function of the durable rows, so a
 * new leader's first act is derived from the store rather than from anything it inherited
 * — which is the difference between *reconstruction* and *recovery*, and the reason this
 * module has no serialisation format to recover from.
 *
 * ── Capacity accounting ─────────────────────────────────────────────────────
 * > | Capacity accounting | Against the coordinator's plan state, within the round loop |
 * > Against the durable `capacity[agent_class]` constraint, enforced by the commit
 * > transaction and a schema constraint (§10.3) |
 *
 * `remainingCapacity()` is the round-loop half. It counts HARD commitments the agent
 * already holds *plus* SOFT reservations this round has taken, so two Legs in one round
 * cannot both plan onto an agent with one free slot. The durable half still runs at
 * commit and is authoritative; this one exists so the solver does not propose an
 * allocation the commit will certainly reject.
 *
 * Tier 1. Invariant I18. No clock, no store, no randomness.
 */

/** Why a reservation attempt failed. @structural refusal labels */
const REFUSAL = Object.freeze({
  NO_CAPACITY: "AGENT_CAPACITY_EXHAUSTED_IN_PLAN_STATE",
  ALREADY_RESERVED: "LEG_ALREADY_RESERVED_THIS_ROUND",
  UNKNOWN_AGENT: "AGENT_NOT_IN_PLAN_STATE",
});

/**
 * The error a serialisation attempt raises. Named so a test can assert on the class
 * rather than on a message substring.
 */
class SoftReservationPersistenceError extends Error {
  /**
   * @param {string} site
   */
  constructor(site) {
    super(
      `${site}: a SOFT reservation was serialised. §2.6 is categorical — "a SOFT reservation is round-local ` +
        'coordinator state and MUST NOT be written to the Commitment Store … There is no third case" — and ' +
        "invariant I18 is the register entry for it. Persisting one would put the re-planning rate inside the " +
        "shard's serialised commit section, which §3.5's sizing arithmetic depends on it not being, and would " +
        "persist a decision that has by construction produced no effect in the physical world. Use " +
        "snapshotForRecord() if a decision record needs to describe the plan state; it emits counts and " +
        "identities, never reservations.",
    );
    this.name = "SoftReservationPersistenceError";
  }
}

/**
 * One SOFT reservation. Frozen, and refuses to serialise.
 *
 * @param {object} input `{ legId, agentId, roundId, gammaMilliCU, columnIdentity }`
 * @returns {object}
 */
function makeReservation(input) {
  const source = input || {};
  const reservation = {
    legId: String(source.legId),
    agentId: String(source.agentId),
    roundId: source.roundId === undefined ? null : String(source.roundId),
    // The price the reservation was taken at, so the round can compare a revision
    // against it (§8.9's C_churn reads this difference). A BigInt, which is a second,
    // independent reason `JSON.stringify` on this object cannot succeed.
    gammaMilliCU: typeof source.gammaMilliCU === "bigint" ? source.gammaMilliCU : null,
    columnIdentity: source.columnIdentity === undefined ? null : String(source.columnIdentity),
    kind: "SOFT",
    toJSON() {
      throw new SoftReservationPersistenceError("planState reservation");
    },
  };
  return Object.freeze(reservation);
}

/**
 * Create the plan state for one shard.
 *
 * A factory rather than a module-level singleton: the coordinator holds one per shard it
 * leads, and a module-global would make two shards in one process share a capacity
 * ledger — which is the same class of defect as the baseline's process-local reservation
 * map, arrived at from the opposite direction.
 *
 * @param {object} input
 * @param {string} input.shardId
 * @returns {object} the plan state
 */
function create(input) {
  const source = input || {};
  const shardId = String(source.shardId);

  /** agentId → { capacity, hardHeld } */
  const agents = new Map();
  /** legId → reservation */
  const byLeg = new Map();
  /** agentId → Set<legId> */
  const byAgent = new Map();

  let roundId = null;
  let revisions = 0;

  /**
   * Declare an agent's capacity and its already-held HARD commitments for this round.
   *
   * Both come from the round's pinned snapshot, never from a live read: §9.6 requirement
   * 5 makes agent state an immutable input, and a capacity that changed mid-round would
   * make the round's own allocation depend on when each candidate happened to be
   * evaluated.
   *
   * @param {object} declaration `{ agentId, capacity, hardCommitmentCount }`
   * @returns {void}
   */
  function declareAgent(declaration) {
    const entry = declaration || {};
    agents.set(String(entry.agentId), {
      capacity: Number.isInteger(entry.capacity) ? entry.capacity : 1,
      hardHeld: Number.isInteger(entry.hardCommitmentCount) ? entry.hardCommitmentCount : 0,
    });
  }

  /**
   * §2.6's round-loop capacity accounting: durable commitments plus this round's SOFT
   * reservations, against the agent class's capacity.
   *
   * @param {string} agentId
   * @returns {number} free slots, never negative
   */
  function remainingCapacity(agentId) {
    const entry = agents.get(String(agentId));
    if (!entry) return 0;
    const soft = (byAgent.get(String(agentId)) || new Set()).size;
    return Math.max(0, entry.capacity - entry.hardHeld - soft);
  }

  /**
   * Take a SOFT reservation.
   *
   * @param {object} request `{ legId, agentId, gammaMilliCU, columnIdentity }`
   * @returns {{ ok: boolean, refusal: string|null, reservation: object|null,
   *             durableEffect: object|null }}
   */
  function reserve(request) {
    const entry = request || {};
    const legId = String(entry.legId);
    const agentId = String(entry.agentId);

    if (!agents.has(agentId)) {
      return { ok: false, refusal: REFUSAL.UNKNOWN_AGENT, reservation: null, durableEffect: null };
    }
    if (byLeg.has(legId)) {
      return { ok: false, refusal: REFUSAL.ALREADY_RESERVED, reservation: null, durableEffect: null };
    }
    if (remainingCapacity(agentId) <= 0) {
      return { ok: false, refusal: REFUSAL.NO_CAPACITY, reservation: null, durableEffect: null };
    }

    const reservation = makeReservation({ ...entry, roundId });
    byLeg.set(legId, reservation);
    if (!byAgent.has(agentId)) byAgent.set(agentId, new Set());
    byAgent.get(agentId).add(legId);

    return {
      ok: true,
      refusal: null,
      reservation,
      // The one durable consequence of planning, per §2.6: the Leg's own state, not its
      // binding. Returned as a *description* for the caller to perform, because a Tier 1
      // decision-layer module that wrote to the store would be an L4 module with an
      // external effect, which §3.1's layering forbids outright.
      durableEffect: Object.freeze({
        entity: "Leg",
        legId,
        targetState: "PLANNED",
        registersTimer: "commit.hardening_deadline",
        note:
          "the provisional agent is deliberately absent from this effect: §2.6 makes the Leg's state durable " +
          "during planning and its binding not",
      }),
    };
  }

  /**
   * Release a reservation — the ordinary outcome when a later round prefers a different
   * agent, or when the commit that would have hardened it aborted.
   *
   * @param {string} legId
   * @returns {{ ok: boolean, released: object|null }}
   */
  function release(legId) {
    const key = String(legId);
    const reservation = byLeg.get(key);
    if (!reservation) return { ok: false, released: null };
    byLeg.delete(key);
    const set = byAgent.get(reservation.agentId);
    if (set) {
      set.delete(key);
      if (set.size === 0) byAgent.delete(reservation.agentId);
    }
    revisions += 1;
    return { ok: true, released: reservation };
  }

  /**
   * Begin a round. Reservations do **not** survive it: §2.6 calls them "round-local",
   * and a reservation carried into a round that did not take it would be a plan nobody
   * priced.
   *
   * @param {string} nextRoundId
   * @returns {{ carried: number, cleared: number }}
   */
  function beginRound(nextRoundId) {
    const cleared = byLeg.size;
    byLeg.clear();
    byAgent.clear();
    agents.clear();
    revisions = 0;
    roundId = String(nextRoundId);
    return { carried: 0, cleared };
  }

  /**
   * What a decision record may say about the plan state (§21.2).
   *
   * Counts and identities only — never the reservation objects, which cannot be
   * serialised at all. This is the deliberate seam: the record describes the plan state
   * without the plan state ever becoming a durable artefact.
   *
   * @returns {object}
   */
  function snapshotForRecord() {
    return Object.freeze({
      shardId,
      roundId,
      softReservationCount: byLeg.size,
      agentsWithReservations: [...byAgent.keys()].sort(),
      legsReserved: [...byLeg.keys()].sort(),
      revisions,
      durability: "NONE — round-local coordinator memory (§2.6, invariant I18)",
    });
  }

  /**
   * @param {string} legId
   * @returns {object|null}
   */
  function reservationFor(legId) {
    return byLeg.get(String(legId)) || null;
  }

  return Object.freeze({
    shardId,
    declareAgent,
    remainingCapacity,
    reserve,
    release,
    beginRound,
    snapshotForRecord,
    reservationFor,
    get size() {
      return byLeg.size;
    },
    get roundId() {
      return roundId;
    },
  });
}

/**
 * §19.5 — the new leader's reconstruction procedure, as a pure function of the durable
 * rows it can read.
 *
 * > On failover the new leader finds Legs in `PLANNED` with no HARD commitment, returns
 * > them to `QUEUED`, and re-plans them in its first round.
 *
 * Two properties are load-bearing and are why this is a function rather than a query
 * written inline in the worker:
 *
 *   - **A Leg in `PLANNED` *with* a live HARD commitment is left alone.** Its agent has
 *     been told; returning it to `QUEUED` would re-plan work that is already dispatched,
 *     and the previous leader's in-flight commit landing late is precisely guard G1's
 *     case (§10.3.2) — the fence, not this procedure, is what settles it.
 *   - **Nothing is recovered.** No reservation is reconstructed from anything; the
 *     reservations are simply gone, and the Legs they described re-enter the queue. The
 *     cost is one round of planning work, which is the price §2.6 states.
 *
 * @param {object} input
 * @param {Array<{ legId: string, state: string, hasLiveCommitment: boolean }>} input.plannedLegs
 * @returns {{ requeue: string[], leftAlone: object[], note: string }}
 */
function reconstructionPlan(input) {
  const source = input || {};
  const requeue = [];
  const leftAlone = [];

  for (const leg of source.plannedLegs || []) {
    if (leg && leg.hasLiveCommitment === true) {
      leftAlone.push(
        Object.freeze({
          legId: String(leg.legId),
          because:
            "a HARD commitment exists, so an agent has been told. Guard G1's leadership fence settles a late " +
            "in-flight commit from the previous leader (§10.3.2); re-planning here would double-commit it.",
        }),
      );
      continue;
    }
    requeue.push(String(leg.legId));
  }

  requeue.sort();

  return {
    requeue,
    leftAlone,
    note:
      "reconstructed, never recovered (§2.6, §19.5). No SOFT reservation was read from any store, because none " +
      "was ever written to one. Because no agent was ever told anything, no physical state can disagree with the " +
      "database, and no fence is needed to make this safe.",
  };
}

/**
 * Prove, against a real store, that no SOFT reservation was persisted (invariant I18).
 *
 * Offered here so the property is asserted against the database rather than against this
 * module's intentions. It checks the two places a SOFT reservation could plausibly have
 * been written — the Commitment table's `kind`, and the work queue's own columns — and
 * reports what it checked as well as what it found, so a passing result names its own
 * scope instead of implying an exhaustive search.
 *
 * @param {object} deps `{ prisma }`
 * @returns {Promise<{ ok: boolean, checked: string[], findings: string[] }>}
 */
async function assertNeverPersisted(deps) {
  const checked = [];
  const findings = [];

  checked.push("Commitment.kind — the §2.6 table that has a HARD-only CHECK constraint");
  const nonHard = await deps.prisma.commitment.count({ where: { NOT: { kind: "HARD" } } });
  if (nonHard > 0) {
    findings.push(
      `${nonHard} Commitment rows are not HARD. Invariant I18's schema backstop (the kind = 'HARD' CHECK) has ` +
        "been bypassed or dropped; every one of those rows is a SOFT reservation in the Commitment Store.",
    );
  }

  checked.push("WorkQueue — the durable queue row carries no provisional-agent column by construction");
  const columns = Object.keys((await deps.prisma.workQueue.findFirst()) || {});
  const forbidden = columns.filter((name) => /agent/i.test(name));
  if (forbidden.length > 0) {
    findings.push(
      `WorkQueue carries agent-shaped column(s) [${forbidden.join(", ")}]. A provisional agent recorded on the ` +
        "queue row is a SOFT reservation under a different table name (§2.6).",
    );
  }

  return { ok: findings.length === 0, checked, findings };
}

module.exports = {
  REFUSAL,
  SoftReservationPersistenceError,
  makeReservation,
  create,
  reconstructionPlan,
  assertNeverPersisted,
};

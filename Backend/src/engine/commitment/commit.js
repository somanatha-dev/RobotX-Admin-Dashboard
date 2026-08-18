"use strict";

/**
 * The commit procedure (§10.3.2) — the correctness core's centre.
 *
 * > Commitment is the smallest and most safety-critical part of the engine: the moment
 * > a decision becomes a binding claim on a physical machine. Everything before it is
 * > retryable and side-effect-free; everything after it is at-least-once and
 * > idempotent. **Only this step must be exactly once.**
 *
 * > **Requirement:** for every agent, at every instant, the set of HARD commitments
 * > MUST have cardinality ≤ `capacity[agent]`, under every failure mode including
 * > worker crash, network partition, cache loss, leader change, duplicate request, and
 * > clock skew.
 *
 * ── The seven steps, and where each is ─────────────────────────────────────
 *
 *   1. Read the agent row `FOR UPDATE`; read the Leg row `FOR UPDATE`  → `lockRows`
 *   2. Verify guards G1–G6, every one aborting                         → `guards.js`
 *   3. Re-verify the **volatile subset** of feasibility                → `volatileRecheck` seam
 *   4. Allocate the fence, advance `fence_counter`, insert the
 *      Commitment, update the Leg state and version                    → `applyCommit`
 *   5. Insert the outbox row **in the same transaction**               → `sideEffects` seam (Phase 4)
 *   6. Insert the decision-record reference                            → `decisionRef` input (Phase 11)
 *   7. Commit
 *
 * > Any guard failure aborts the transaction and returns the pairing to the next round
 * > with the cause recorded. **No partial state is possible.**
 *
 * ── Commit applies to HARD commitments only ─────────────────────────────────
 * > SOFT reservations are round-local coordinator state and never enter this
 * > transaction (§2.6); this is what keeps the serialised section proportional to the
 * > mission rate rather than to the re-planning rate (§3.5).
 *
 * ── Two seams, and why they are seams rather than stubs ─────────────────────
 * Steps 3 and 5 belong to phases that have not landed. Both are represented as
 * **required injected dependencies**, not as optional hooks with permissive defaults:
 *
 *   - `volatileRecheck` — Phase 6 supplies the enumerated volatile subset (F7, F8,
 *     F10, F13, F14, F16, F17, F18, F20, F34, F35). Until then a caller must supply
 *     one explicitly. Its **absence is refused**, because a re-check that silently
 *     passes when nobody registered it is exactly the "informal bypass under latency
 *     pressure" §7.1 names as a predicted failure mode.
 *   - `sideEffects` — the outbox writer, run *inside* this transaction, which is
 *     §4.1 rule 5: "No external side effect precedes the guarded write that authorises
 *     it." **Phase 4 makes this required**, symmetrically with `volatileRecheck`.
 *     Phase 3 admitted its absence because no dispatcher existed to write a row for;
 *     now one does, and §10.3.2 step 5 is unconditional — "Insert the outbox row for
 *     dispatch **in the same transaction**". A commit that writes no dispatch
 *     obligation produces a commitment no agent will ever hear about, which is §11.1's
 *     named defect arrived at from the inside. This is also the only place Phase 4's
 *     gate — "no command reaches an agent except via an outbox row written in the
 *     authorising transaction" — can be enforced rather than reviewed.
 *
 * ── What this module never does ─────────────────────────────────────────────
 * It never touches `Agent.authorityEpoch` (§10.3.2 step 4, invariant I19), never reads
 * a worker's wall clock (§10.6), never consults the cache (§10.4, invariant I16), and
 * never writes anything of kind other than HARD (§2.6, invariant I18).
 *
 * Tier 0 (T0-05). Invariants I1, I5, I6, I9, I16, I18, I19.
 */

const { ABORT_REASON, evaluateGuards } = require("./guards");
const clock = require("./clock");
const fencing = require("./fencing");
const idempotency = require("./idempotency");
const leases = require("./leases");
const model = require("./model");
const leadership = require("../shard/leadership");

/** The outcome kinds a commit attempt can produce. @structural outcome labels */
const OUTCOME = Object.freeze({
  COMMITTED: "COMMITTED",
  ALREADY_COMMITTED: "ALREADY_COMMITTED",
  ABORTED: "ABORTED",
});

/**
 * Build an abort result. Carries every guard verdict, not only the failing one, so the
 * decision record can state what was checked as well as what failed.
 *
 * @param {string} reason
 * @param {string} detail
 * @param {object[]} [verdicts]
 * @returns {object}
 */
function aborted(reason, detail, verdicts) {
  return Object.freeze({
    outcome: OUTCOME.ABORTED,
    committed: false,
    reason,
    detail,
    guardVerdicts: Object.freeze(verdicts || []),
    commitment: null,
  });
}

/**
 * Step 1 — the two explicit row locks.
 *
 * Ordering is fixed: **agent first, then Leg**, for every commit in the system. Two
 * transactions that take the same two locks in opposite orders deadlock; a fixed global
 * order removes the possibility rather than relying on the database to detect it. Agent
 * before Leg because the agent is the resource whose exclusivity is the invariant.
 *
 * @param {object} deps
 * @param {object} tx
 * @param {{ agentId: string, legId: string }} request
 * @returns {Promise<{ agent: object|null, leg: object|null }>}
 */
async function lockRows(deps, tx, request) {
  const agent = await deps.selectForUpdate(tx, "Agent", "id", request.agentId);
  const leg = await deps.selectForUpdate(tx, "Leg", "id", request.legId);
  return { agent, leg };
}

/**
 * Steps 4–6, applied once every guard has passed.
 *
 * @param {object} deps
 * @param {object} tx
 * @param {object} context
 * @returns {Promise<object>} the commitment row
 */
async function applyCommit(deps, tx, context) {
  const { request, agent, leg, storeTime, capacity, activeCommitments, commitmentId } = context;

  // Step 4a — allocate the commitment-scope fence and advance the counter.
  const fence = fencing.allocateFence(agent.fenceCounter);
  if (!fencing.isStrictAdvance(agent.fenceCounter, fence)) {
    throw new Error(`fence allocation did not advance the counter for agent ${request.agentId} (invariant I6)`);
  }

  const capacitySlot = model.lowestFreeSlot(activeCommitments, capacity);
  if (capacitySlot === null) {
    // G2 already excluded this; reaching it means the guard and the slot allocator
    // disagree, which is a defect rather than a race.
    throw new Error(
      `no free capacity slot for agent ${request.agentId} at capacity ${capacity} although G2 passed (invariant I1)`,
    );
  }

  const lease = leases.grant({ storeTime, leaseDurationSeconds: context.leaseDurationSeconds });

  const commitment = {
    commitmentId,
    agentId: request.agentId,
    legId: request.legId,
    kind: model.COMMITMENT_KIND.HARD,
    fence,
    leaseExpiry: lease.expiresAt,
    custodyState: leg.custodyState,
    planSnapshotRef: request.planSnapshotRef === undefined ? null : request.planSnapshotRef,
    decisionRef: request.decisionRef === undefined ? null : request.decisionRef,
    version: 0,
    grantedAt: lease.grantedAt,
    releasedAt: null,
    capacitySlot,
  };

  // I18's application-side half. The CHECK constraint is the half that cannot be
  // bypassed; this one produces a message that names the rule.
  model.refuseSoftPersistence(commitment);

  const problems = model.validateCommitment(commitment);
  if (problems.length > 0) {
    throw new Error(`refusing to persist a malformed commitment: ${problems.join("; ")}`);
  }

  // §10.3.2 step 4 — advance `fence_counter`. **`authority_epoch` is not touched**,
  // which is what lets G3 guard on it across several commits in one round (I19).
  await tx.agent.update({
    where: { id: request.agentId },
    data: { fenceCounter: fence },
  });

  const created = await tx.commitment.create({ data: commitment });

  // §4.1 rule 2 — every transition is a conditional write on the entity's version.
  // The `version` in the `where` clause is the condition; G4 already checked it under
  // the row lock, and this is the second, unconditional-write-proof line.
  const legUpdate = await tx.leg.updateMany({
    where: { id: request.legId, version: leg.version },
    data: { state: request.targetLegState, version: leg.version + 1 },
  });
  if (legUpdate.count !== 1) {
    throw new Error(
      `the conditional write on Leg ${request.legId} at version ${leg.version} matched ${legUpdate.count} rows; ` +
        "an unconditional write would have produced the baseline's silent cancellation reversion (§4.1 rule 2)",
    );
  }

  // Invariant I6's persisted high-water mark, written in the same transaction that
  // advances the counter — so the audit's two sources are written atomically and a
  // disagreement between them is genuine evidence rather than a write-ordering artefact.
  await tx.agentFenceAudit.upsert({
    where: { agentId: request.agentId },
    create: {
      agentId: request.agentId,
      fenceHighWater: fence,
      epochHighWater: BigInt(agent.authorityEpoch),
      lastFenceSource: commitmentId,
      observedAt: storeTime,
    },
    update: {
      fenceHighWater: fence,
      epochHighWater: BigInt(agent.authorityEpoch),
      lastFenceSource: commitmentId,
      observedAt: storeTime,
    },
  });

  return created;
}

/**
 * Commit one (Leg, Agent) pairing.
 *
 * @param {object} deps injected collaborators
 * @param {object} deps.prisma the Prisma client
 * @param {(client: object, fn: Function, options?: object) => Promise<*>} deps.runSerializable
 * @param {(tx: object, table: string, column: string, value: string) => Promise<object|null>} deps.selectForUpdate
 * @param {(error: unknown) => boolean} deps.isSerializationFailure
 * @param {(context: object) => Promise<{ ok: boolean, reason?: string, detail?: string }>} deps.volatileRecheck
 *   §10.3.2 step 3. **Required** — see the module header.
 * @param {(tx: object, context: object) => Promise<void>} [deps.sideEffects] §10.3.2 step 5.
 *
 * @param {object} request
 * @param {string} request.agentId
 * @param {string} request.legId
 * @param {string} request.decisionRoundId
 * @param {string} request.targetLegState the §4.3 state the Leg enters on commit
 * @param {string} [request.planSnapshotRef]
 * @param {string} [request.decisionRef]
 * @param {string} [request.shardId]
 * @param {object} request.snapshot the round's pinned values: `leadershipFence`,
 *   `authorityEpoch`, `legVersion`, `expectedLegState`
 * @param {object} request.config resolved parameters: `capacity`, `leaseDurationSeconds`
 * @returns {Promise<object>} the outcome
 */
async function commit(deps, request) {
  if (!deps || typeof deps.volatileRecheck !== "function") {
    throw new TypeError(
      "commit requires a volatile-subset re-check (§10.3.2 step 3). The baseline validates battery and health " +
        "before the reservation and never re-checks them at finalisation, so an agent that drains below threshold " +
        "or faults during the routing window is still bound. Phase 6 supplies the enumerated subset; a re-check " +
        "that silently passes when nobody registered it is the informal bypass §7.1 predicts.",
    );
  }
  if (typeof deps.sideEffects !== "function") {
    throw new TypeError(
      "commit requires an outbox writer (§10.3.2 step 5, §11.1, §4.1 rule 5). Step 5 is unconditional: the " +
        "commitment and its dispatch obligation are written in one transaction, so that 'either both exist or " +
        "neither does'. A commit permitted to write no obligation produces a commitment that reaches no agent " +
        "with no signal — the defect §11.1 opens by naming — and would leave Phase 4's gate ('no command reaches " +
        "an agent except via an outbox row written in the authorising transaction') as a matter of review rather " +
        "than of construction.",
    );
  }

  const config = request.config || {};
  const capacity = config.capacity;
  const leaseDurationSeconds = config.leaseDurationSeconds;
  const commitmentId = idempotency.commitmentIdFor({
    legId: request.legId,
    agentId: request.agentId,
    decisionRoundId: request.decisionRoundId,
  });

  try {
    return await deps.runSerializable(deps.prisma, async (tx) => {
      // §10.5 — commit is idempotent on `commitment_id`. A retry observes its own
      // prior commitment and succeeds rather than allocating a second fence.
      const existing = await tx.commitment.findUnique({ where: { commitmentId } });
      if (existing) {
        return Object.freeze({
          outcome: OUTCOME.ALREADY_COMMITTED,
          committed: true,
          reason: null,
          detail: "a commitment with this identity already exists; the retry is the same commit (§10.5)",
          guardVerdicts: Object.freeze([]),
          commitment: existing,
        });
      }

      // Step 1 — the two explicit row locks, always agent then Leg.
      const { agent, leg } = await lockRows(deps, tx, request);
      if (!agent) return aborted(...await diagnoseMissingRow(tx, "Agent", "agentId", request.agentId));
      if (!leg) return aborted(...await diagnoseMissingRow(tx, "Leg", "legId", request.legId));

      const shardLeadership = await leadership.readLeadership(tx, request.shardId);

      const activeCommitments = await tx.commitment.findMany({
        where: { agentId: request.agentId, releasedAt: null },
      });

      // Step 2 — the guard set. Every guard is evaluated; none short-circuits.
      const guardResult = evaluateGuards({
        leadership: shardLeadership,
        agent,
        leg,
        activeCommitmentCount: activeCommitments.length,
        capacity,
        snapshot: request.snapshot,
      });
      if (!guardResult.ok) {
        const first = guardResult.failures[0];
        return aborted(first.reason, first.detail, guardResult.verdicts);
      }

      const storeTime = await clock.readStoreTime(tx);

      // Step 3 — re-verify the volatile subset of feasibility, under the row locks.
      const recheck = await deps.volatileRecheck({
        tx,
        agent,
        leg,
        storeTime,
        snapshot: request.snapshot,
        commitmentId,
      });
      if (!recheck || recheck.ok !== true) {
        return aborted(
          (recheck && recheck.reason) || ABORT_REASON.VOLATILE_FEASIBILITY_LOST,
          (recheck && recheck.detail) ||
            "a predicate in the volatile subset no longer holds at commit time (§10.3.2 step 3)",
          guardResult.verdicts,
        );
      }

      // Steps 4 and 6.
      const commitment = await applyCommit(deps, tx, {
        request,
        agent,
        leg,
        storeTime,
        capacity,
        activeCommitments,
        commitmentId,
        leaseDurationSeconds,
      });

      // Step 5 — the outbox row, written in this transaction (§4.1 rule 5, §11.1).
      //
      // The row ids handed to the writer come from the **locked rows**, never from
      // `request`: `agent.id` and `leg.id` are what the FK columns reference, and a
      // caller that passed a business identifier would otherwise propagate it into the
      // outbox rather than being caught at the lock.
      await deps.sideEffects(tx, {
        request,
        agent,
        leg,
        commitment,
        storeTime,
        fence: commitment.fence,
        agentRowId: agent.id,
        legRowId: leg.id,
      });

      // Step 7 — commit, by returning.
      return Object.freeze({
        outcome: OUTCOME.COMMITTED,
        committed: true,
        reason: null,
        detail: null,
        guardVerdicts: Object.freeze(guardResult.verdicts),
        commitment,
      });
    });
  } catch (error) {
    if (deps.isSerializationFailure && deps.isSerializationFailure(error)) {
      // Not a guard failure, but the same disposition: nothing was written, and the
      // pairing returns to the next round with the cause recorded (§10.3.2).
      return aborted(
        ABORT_REASON.SERIALIZATION_FAILURE,
        "the store declined to serialise this transaction against a concurrent one; no state was written",
      );
    }
    if (isCapacityConstraintViolation(error)) {
      // The schema backstop fired. Reaching here means application logic was defective
      // and the database caught it — which is the arrangement §10.3.2 asks for, and
      // which must be loud rather than silent.
      return aborted(
        ABORT_REASON.CAPACITY_CONSTRAINT_VIOLATED,
        `the §10.3.2 schema backstop rejected this commit (invariant I1): ${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * Why was the row not there?
 *
 * §2.1 gives an Agent two identifiers — `Agent.id`, the primary key the Commitment's
 * foreign key references, and `Agent.agentId`, the stable business identifier — and a
 * Leg likewise. `commit()` takes the **primary keys**, because that is what it locks
 * and what it writes. A caller that passes the business identifier produces a lookup
 * miss that is indistinguishable, from the abort alone, from an agent that genuinely
 * does not exist — and the two need opposite responses.
 *
 * This runs only on the failure path, so the extra indexed read costs nothing in the
 * nominal case, and it converts a confusing `AGENT_NOT_FOUND` into a message that
 * names the mistake. Every test fixture in the suite sets the two identifiers equal,
 * so no test could have caught this by accident; that is precisely why it is checked
 * rather than left to review.
 *
 * @param {object} tx
 * @param {"Agent"|"Leg"} table
 * @param {"agentId"|"legId"} businessColumn
 * @param {string} value
 * @returns {Promise<[string, string]>} the abort reason and its detail
 */
async function diagnoseMissingRow(tx, table, businessColumn, value) {
  const model = table === "Agent" ? tx.agent : tx.leg;
  const notFound = table === "Agent" ? ABORT_REASON.AGENT_NOT_FOUND : ABORT_REASON.LEG_NOT_FOUND;

  let byBusinessKey = null;
  try {
    byBusinessKey = await model.findUnique({ where: { [businessColumn]: value } });
  } catch {
    // A store that cannot answer the diagnostic question still gets the plain answer.
    byBusinessKey = null;
  }

  if (!byBusinessKey) {
    return [notFound, `${table} ${value} does not exist`];
  }

  const misuse =
    table === "Agent" ? ABORT_REASON.AGENT_ID_IS_A_BUSINESS_KEY : ABORT_REASON.LEG_ID_IS_A_BUSINESS_KEY;
  return [
    misuse,
    `no ${table} row has id "${value}", but one has ${businessColumn} "${value}" — its id is "${byBusinessKey.id}". ` +
      `commit() takes ${table}.id, the primary key the Commitment's foreign key references (§2.1); passing the ` +
      "business identifier would otherwise abort as a missing row and be retried forever against a defect no " +
      "round can repair",
  ];
}

/** @structural PostgreSQL's unique-violation SQLSTATE */
const UNIQUE_VIOLATION = "23505";

/** @structural Prisma's own error code for a unique-constraint violation */
const PRISMA_UNIQUE_VIOLATION = "P2002";

/** @structural the partial unique index of §10.3.2 */
const CAPACITY_SLOT_INDEX = "Commitment_agent_capacity_slot_active_key";

/** @structural the column both halves of the capacity backstop are keyed on */
const CAPACITY_SLOT_COLUMN = "capacitySlot";

/** @structural the wording the slot-bound trigger raises with, and nothing else does */
const SLOT_TRIGGER_WORDING = "capacity slot";

/**
 * Does this value — a Prisma `meta.target`, which is an array of column names or a
 * single one — name the capacity slot?
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function namesTheCapacitySlot(value) {
  if (value === undefined || value === null) return false;
  const entries = Array.isArray(value) ? value : [value];
  return entries.some((entry) => String(entry).includes(CAPACITY_SLOT_COLUMN));
}

/**
 * Did the capacity backstop — the partial unique index or the slot-bound trigger —
 * reject this write?
 *
 * ── Why this is matched on four shapes rather than one ──────────────────────
 * The three ways the backstop can fire produce three *different* error objects, and
 * this was established by executing each of them against PostgreSQL 18.3 through the
 * Prisma 5.22 driver rather than by reading the driver's documentation:
 *
 *   1. `tx.commitment.create` hitting the partial unique index — the shape the commit
 *      path actually produces — is a `PrismaClientKnownRequestError` with
 *      `code === "P2002"` and `meta.target === ["agentId", "capacitySlot"]`. **The
 *      index's name never appears anywhere in it**, and neither does the SQLSTATE.
 *   2. The same violation through `$executeRawUnsafe` is `code === "P2010"` with the
 *      SQLSTATE in `meta.code` and the offending key in `meta.message`.
 *   3. The slot-bound trigger is a `PrismaClientUnknownRequestError` carrying no code
 *      at all — only the `RAISE EXCEPTION` text inside `message`.
 *
 * Matching on the constraint name alone therefore classified case 3 and missed cases
 * 1 and 2, which meant `commit()` re-threw a raw driver error instead of returning the
 * graceful `CAPACITY_CONSTRAINT_VIOLATED` abort §10.3.2 asks for. Nothing was ever
 * persisted — the database still refused the write — so this was a reporting defect
 * rather than a safety one, but the abort is what returns the pairing to the next round
 * with a cause, and a thrown driver error does not.
 *
 * A unique violation on `commitmentId` is deliberately **not** classified here: it is an
 * idempotency-key collision, not a capacity violation, and the two need different
 * responses.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isCapacityConstraintViolation(error) {
  if (!error) return false;
  const message = typeof error.message === "string" ? error.message : "";
  const meta = error.meta || {};

  // The index named outright, and the trigger's own wording. Nothing else in the
  // schema raises either.
  if (message.includes(CAPACITY_SLOT_INDEX)) return true;
  if (message.includes(SLOT_TRIGGER_WORDING)) return true;

  // Shape 1 — Prisma's model API. The columns reach `meta.target`; the index name does
  // not reach anything.
  if (error.code === PRISMA_UNIQUE_VIOLATION && namesTheCapacitySlot(meta.target)) return true;

  // Shape 2 — the raw-SQL path. The SQLSTATE lands in `meta.code` beneath Prisma's own
  // `P2010`, so the outer code must not shadow it.
  const sqlState = meta.code || error.code;
  if (sqlState === UNIQUE_VIOLATION && (namesTheCapacitySlot(meta.message) || message.includes(CAPACITY_SLOT_COLUMN))) {
    return true;
  }

  return false;
}

module.exports = {
  OUTCOME,
  ABORT_REASON,
  commit,
  lockRows,
  applyCommit,
  diagnoseMissingRow,
  isCapacityConstraintViolation,
};

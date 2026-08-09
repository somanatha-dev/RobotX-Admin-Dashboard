"use strict";

/**
 * The Intake API (§3.4, §3.2) — **Tier 1**, mechanism T1-06. The request path.
 *
 * > **Request path (synchronous, milliseconds).** `Intake API` validates, checks
 * > admission and quota, resolves the shard, writes the Leg into the durable work
 * > queue, and returns an accepted response carrying the task id, an idempotency echo,
 * > the queue position, and an **honest predicted assignment window** derived from
 * > current queue depth and supply. **The response MUST NOT imply an assignment has
 * > occurred.**
 *
 * > The baseline returns HTTP 200 carrying a `PENDING` row with no indication of whether
 * > any agent exists; a caller cannot distinguish "working on it" from "will never
 * > happen." Here, the contract is explicit: intake succeeded, assignment is in progress,
 * > and the outcome will arrive by event and is queryable by id.
 *
 * ── Why this module exists at all, stated as the defect it removes ──────────
 * > The decoupling matters because these have opposite requirements. Intake must be
 * > fast, horizontally scalable, and available. The round must be serialised,
 * > consistent, and deterministic. **Fusing them — the baseline's `setImmediate` detach
 * > — produces an unsupervised background computation with no owner, no timeout, no
 * > retry, and no observability**, which is the root cause of the audit's "stuck at
 * > PENDING with no record of the failure" behaviour.
 *
 * The whole of this module is the first half of the replacement. Its last act is a
 * durable `WorkQueue` row; `solve/round.js` — driven by `workers/coordinator.worker.js`
 * — is the owner that reads it. Between the two there is no closure, no timer, and no
 * process-local state, which is what makes the work survivable across a restart.
 *
 * ── The honest window is the hard part, and it is honest about being unable ─
 * `predictAssignmentWindow()` refuses to quote a window when there is no feasible supply
 * to serve the Leg. §3.4's whole complaint about the baseline is that the caller cannot
 * tell "working on it" from "will never happen", and a confidently-rendered window
 * computed from a queue that nothing is draining reproduces that defect with more
 * decimal places. So the window carries its own `basis`, and one of the permitted bases
 * is *"there is currently no feasible supply; no assignment time can be predicted"*.
 *
 * ── Idempotence at the boundary, not only at commit ─────────────────────────
 * §10.5 makes the commit idempotent on `commitment_id`. That is the wrong layer to catch
 * a client that retried its HTTP POST: by the time a duplicate reaches commit it has
 * already produced a second Leg competing for the same work. The idempotency key is
 * therefore derived (or echoed) here and carried on the queue row under a unique
 * constraint, so a retried submission is answered with **the original acceptance** —
 * same queue position, same window — rather than admitted twice.
 *
 * ── What this module never does ─────────────────────────────────────────────
 * It never selects an agent, never evaluates feasibility, never prices anything, and
 * never writes a Commitment. It is L2 by §3.1's layering ("Intake API … L2 …
 * stateless"), and the single durable write it performs is the queue row.
 *
 * Determinism: every time value arrives as an argument. This module is outside
 * `guards/tenets.js`'s decision-path scope — intake is not a round — but it takes its
 * clock from the caller anyway, because the predicted window it quotes is scored against
 * the realised assignment later (§21.5) and a prediction whose own timestamp cannot be
 * reproduced cannot be scored.
 */

const crypto = require("crypto");

const admission = require("./admission");
const purposeModel = require("../domain/purpose");
const leadership = require("../shard/leadership");

/** @structural milliseconds per second — a unit conversion, not a threshold */
const MS_PER_SECOND = 1000;

/** @structural the digest the idempotency key is derived with */
const DIGEST_ALGORITHM = "sha256";

/** @structural hex characters of the digest retained in the key */
const KEY_LENGTH = 32;

/** @structural the field separator inside a derived idempotency key */
const FIELD_SEPARATOR = "";

/** The outcomes an intake attempt can produce. @structural outcome labels */
const OUTCOME = Object.freeze({
  ACCEPTED: "ACCEPTED",
  DUPLICATE: "DUPLICATE",
  DECLINED: "DECLINED",
  INVALID: "INVALID",
});

/**
 * What a predicted window is derived from. Carried in the response so the caller can
 * tell a measured projection from an admission that none is available.
 * @structural the enumerated bases of a predicted window
 */
const WINDOW_BASIS = Object.freeze({
  /** Queue depth and the shard's configured round cadence. */
  QUEUE_AND_CADENCE: "QUEUE_AND_CADENCE",
  /** §9.2's saturated regime: feasible supply is zero. No window is quoted. */
  NO_FEASIBLE_SUPPLY: "NO_FEASIBLE_SUPPLY",
  /** The inputs the projection needs were not supplied. No window is quoted. */
  INSUFFICIENT_INFORMATION: "INSUFFICIENT_INFORMATION",
});

/** The queue-row states. Mirrors the migration's `WorkQueue_state_known` CHECK. @structural */
const QUEUE_STATE = Object.freeze({
  QUEUED: "QUEUED",
  CLAIMED: "CLAIMED",
  SOLVED: "SOLVED",
  SHED: "SHED",
  WITHDRAWN: "WITHDRAWN",
});

/**
 * §20.5's shed order, second key: SLA classes ranked most urgent first. The rank
 * becomes part of the queue row's `priority`, which is what makes the queue a
 * *priority* queue rather than a FIFO. Unknown classes rank after every known one —
 * conservative, since an unrecognised class must not out-rank a contracted one.
 * @structural the SLA-class ordinal used for queue ordering
 */
const SLA_CLASS_RANK = Object.freeze({
  critical: 0,
  express: 1,
  standard: 2, // @structural SLA-class ordinal
  economy: 3, // @structural SLA-class ordinal
  bulk: 4, // @structural SLA-class ordinal
});

/** @structural the rank an unrecognised SLA class receives — after every known one */
const UNKNOWN_SLA_RANK = 9;

/**
 * Purpose ordinal for queue ordering. Custodial work sorts ahead of everything:
 * §2.4 makes it the discharge of an obligation that already exists physically, and
 * §20.5 forbids shedding it, so ordering it behind speculative work would be
 * inconsistent with both.
 * @structural the purpose ordinal used for queue ordering
 */
const PURPOSE_RANK = Object.freeze({
  RECOVERY: 0,
  TRANSFER: 0,
  MAINTENANCE_TRANSIT: 1,
  PRIMARY: 2, // @structural purpose ordinal
  EXERCISE: 3, // @structural purpose ordinal
  REPOSITION: 3, // @structural purpose ordinal
});

/** @structural the ordinal-packing multiplier: purpose is the major key, SLA class the minor */
const PURPOSE_RANK_STRIDE = 100;

/** @structural the rank an unrecognised purpose receives */
const UNKNOWN_PURPOSE_RANK = 9;

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * The queue row's sort key. Lower sorts first.
 *
 * Derived, never operator-entered: §20.5's shed order is published configuration and
 * this is the same order applied to *serving* rather than to shedding. Two orders over
 * one fact — one for who is shed first and one for who is served first — would
 * eventually disagree, and the disagreement would be invisible until load arrived.
 *
 * @param {object} input `{ purpose, slaClass }`
 * @returns {number}
 */
function priorityFor(input) {
  const source = input || {};
  const purposeRank = Object.prototype.hasOwnProperty.call(PURPOSE_RANK, source.purpose)
    ? PURPOSE_RANK[source.purpose]
    : UNKNOWN_PURPOSE_RANK;
  const slaRank = Object.prototype.hasOwnProperty.call(SLA_CLASS_RANK, String(source.slaClass))
    ? SLA_CLASS_RANK[String(source.slaClass)]
    : UNKNOWN_SLA_RANK;
  return purposeRank * PURPOSE_RANK_STRIDE + slaRank;
}

/**
 * Derive an idempotency key, or echo the caller's.
 *
 * A caller-supplied key is used verbatim after being namespaced, because the caller is
 * the only party that knows which two submissions it considers the same request. With
 * none supplied, the key is derived from the identity of the work itself — tenant, Leg,
 * and the caller's own external reference — so that a client that retries without a key
 * is still protected against double submission of the *same* work while remaining able
 * to submit genuinely different work.
 *
 * @param {object} input `{ tenantId, legId, externalRef, idempotencyKey }`
 * @returns {{ key: string, echoed: boolean }}
 */
function idempotencyKeyFor(input) {
  const source = input || {};
  if (isNonEmptyString(source.idempotencyKey)) {
    return { key: `client:${source.idempotencyKey}`, echoed: true };
  }
  const parts = [
    "derived",
    String(source.tenantId ?? ""),
    String(source.legId ?? ""),
    String(source.externalRef ?? ""),
  ];
  const digest = crypto
    .createHash(DIGEST_ALGORITHM)
    .update(parts.join(FIELD_SEPARATOR))
    .digest("hex")
    .slice(0, KEY_LENGTH);
  return { key: `derived:${digest}`, echoed: false };
}

/**
 * §3.5 — "Every Leg is routed to exactly one shard at intake, determined by its first
 * Stop's region."
 *
 * Stated as a function of the first Stop rather than of the requester, the agent, or the
 * drop point, because those three can disagree and the specification names exactly one of
 * them.
 *
 * ── The two cases, and why they resolve differently ─────────────────────────
 * The behaviour turns on whether a **region→shard map has been published**, not on
 * whether the Leg happens to carry a region:
 *
 *   - **A map is published** (a multi-shard deployment). The region is then load-bearing,
 *     and a Leg whose first Stop names no region, or names one the map does not cover, is
 *     **refused**. Routing it to a fallback shard would hand it to a coordinator that owns
 *     none of the agents able to serve it, and it would then age on the §17.4 ladder
 *     against a shard that was never able to help — a starvation that looks like a queue.
 *   - **No map is published** (a single-shard deployment). There is exactly one shard,
 *     every agent is in it, and `leadership.DEFAULT_SHARD_ID` is the identity every phase
 *     since 3 has already used for it. Refusing here would decline every Leg in a
 *     deployment where the region is not yet a deployed concept, which is a refusal for
 *     the absence of configuration rather than for any property of the work.
 *
 * The distinction is recorded in the result (`resolvedBy`) rather than inferred, so a
 * decision record shows whether a Leg's shard was chosen by its region or by there being
 * only one.
 *
 * ── PHASE 13 — the map now has a source, and shards now have states ─────────
 * The map is `shard/shardModel.readRegionShardMap()`, built from the durable `Shard`
 * table, and it **omits shards that do not admit new work** — a shard being drained
 * during a §19.2 rebalance, or retired. That omission would otherwise present as "region
 * not in the map", which is a redistricting the Config Service has not published and is a
 * materially different operational fact. `notAdmittingRegions` is therefore passed
 * alongside the map so a draining region is refused *by its own name*: the work is
 * declined either way, and the operator reading the refusal needs to know whether to
 * publish a map or to wait for a drain.
 *
 * This function remains **pure**. `resolveShardFor()` below is the one that reads the
 * store, and the separation is deliberate: the routing rule is a function of published
 * configuration and must replay identically (T6), which it cannot do if it queries.
 *
 * @param {object} input
 * @param {object} [input.firstStop] `{ regionId }` — from the Leg's first Stop
 * @param {string} [input.regionId] an explicitly resolved region, where the caller has one
 * @param {Record<string,string>} [input.shardByRegionId] the published region→shard map
 * @param {Record<string,string>} [input.notAdmittingRegions] region → state, for shards
 *   that exist but do not currently admit work
 * @returns {{ ok: boolean, shardId: string|null, regionId: string|null, resolvedBy: string|null,
 *             reason: string|null }}
 */
function resolveShard(input) {
  const source = input || {};
  const regionId = source.regionId ?? (source.firstStop && source.firstStop.regionId) ?? null;
  const map = source.shardByRegionId || null;
  const notAdmitting = source.notAdmittingRegions || {};
  const mapPublished = Boolean(map) && Object.keys(map).length > 0;

  if (!mapPublished) {
    return {
      ok: true,
      shardId: leadership.DEFAULT_SHARD_ID,
      regionId,
      resolvedBy: "SINGLE_SHARD_DEPLOYMENT",
      reason: null,
    };
  }

  if (!isNonEmptyString(regionId)) {
    return {
      ok: false,
      shardId: null,
      regionId: null,
      resolvedBy: null,
      reason:
        "a region→shard map is published, but the Leg's first Stop names no OperatingRegion, so no shard owns " +
        "it (§3.5). Routing it to a default shard would hand it to a coordinator that owns none of the agents " +
        "able to serve it, and it would then age on the §17.4 ladder against a shard that was never able to help.",
    };
  }

  const mapped = map[regionId];
  if (!isNonEmptyString(mapped)) {
    // §3.5 / §19.2 — the shard exists but is being emptied. A different fact from an
    // unmapped region, and one an operator resolves differently: this one is waited out,
    // the other is published.
    if (isNonEmptyString(notAdmitting[regionId])) {
      return {
        ok: false,
        shardId: null,
        regionId,
        resolvedBy: null,
        reason:
          `region "${regionId}" is owned by a shard in state ${notAdmitting[regionId]}, which does not admit new ` +
          "work (§3.5, §19.2). Its agents are migrating away one at a time; queueing more work against it would " +
          "queue against a coordinator that is giving away the supply to serve it. The region is not unmapped — " +
          "it is draining, and the work should be re-submitted once the rebalance publishes its successor.",
      };
    }
    return {
      ok: false,
      shardId: null,
      regionId,
      resolvedBy: null,
      reason:
        `region "${regionId}" is not in the published region→shard map, so no shard owns this Leg (§3.5). A ` +
        "region that exists operationally but not in the map is a redistricting the Config Service has not " +
        "published; admitting the work against a guess would put it in a queue no coordinator drains.",
    };
  }

  return { ok: true, shardId: mapped, regionId, resolvedBy: "REGION_MAP", reason: null };
}

/**
 * PHASE 13 — `resolveShard`, with the published map read from the durable `Shard` table.
 *
 * The one impure wrapper, kept separate from the rule it applies so the rule stays
 * replayable. A caller that already holds the map (a round, replaying against a pinned
 * snapshot) calls `resolveShard` directly and never touches the store; a caller serving a
 * live submission calls this.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input as `resolveShard`, minus the map
 * @returns {Promise<object>} as `resolveShard`
 */
async function resolveShardFor(deps, input) {
  const source = input || {};
  const shards = await deps.prisma.shard.findMany({ orderBy: { shardId: "asc" } });

  const shardByRegionId = {};
  const notAdmittingRegions = {};
  for (const shard of shards) {
    if (!shard || !shard.regionId || !shard.shardId) continue;
    // The same admission rule `shardModel.admitsNewWork` states, applied here without
    // importing it — this module is Tier 1 and `shardModel` is Tier 1, so the import
    // would be legal; it is avoided because `intake.js` must keep working when no `Shard`
    // table row exists at all, and a hard dependency on the shard model would make the
    // single-shard deployment's routing depend on a module it never needs.
    if (shard.state === "ACTIVE" || shard.state === "REBALANCING") shardByRegionId[shard.regionId] = shard.shardId;
    else notAdmittingRegions[shard.regionId] = shard.state;
  }

  return resolveShard({ ...source, shardByRegionId, notAdmittingRegions });
}

/**
 * §3.4's honest predicted assignment window.
 *
 * The projection is deliberately coarse and deliberately labelled. It is the number of
 * rounds the Leg's queue position implies, multiplied by the shard's current round
 * window, offset from the moment of intake. What makes it honest is not its precision
 * but its three refusals:
 *
 *   - **No supply, no window.** With zero feasible agents the shard is in §9.2's
 *     saturated regime and the next round will solve against nothing. Quoting a window
 *     derived from queue depth alone would be the baseline's defect with a number
 *     attached.
 *   - **Missing inputs, no window.** A projection needs the cadence and the queue
 *     position; absent either, `INSUFFICIENT_INFORMATION` is returned rather than a
 *     default.
 *   - **At-risk is stated, not hidden.** When the projected assignment falls beyond the
 *     class's `sla.assignment_deadline`, the response says so. The work is still
 *     admitted — §17.4's ladder, not this projection, is what acts on it — but the
 *     caller is told at the moment it can still act.
 *
 * @param {object} input
 * @param {number} input.receivedAtMs
 * @param {number} input.queuePosition 1-based: this Leg's place in the shard's queue
 * @param {number} input.windowMs the shard's current round window (`solve/cadence.js`)
 * @param {number} input.maxLegsPerRound `solve.max_legs_per_round`
 * @param {number} [input.feasibleSupply] agents currently available in the shard
 * @param {number} [input.slaBudgetSeconds] `sla.assignment_deadline` for the class
 * @returns {object} the window, always carrying its own `basis`
 */
function predictAssignmentWindow(input) {
  const source = input || {};

  const unavailable = (basis, sentence) =>
    Object.freeze({
      basis,
      earliestMs: null,
      expectedMs: null,
      latestMs: null,
      roundsAhead: null,
      atRisk: null,
      sentence,
    });

  if (isNumber(source.feasibleSupply) && source.feasibleSupply <= 0) {
    return unavailable(
      WINDOW_BASIS.NO_FEASIBLE_SUPPLY,
      "accepted and queued, but no assignment time can be predicted: no agent is currently available to this " +
        "shard. The work is not lost — it is queued and will be solved by the first round with supply — but a " +
        "window derived from queue depth alone would be a guess presented as a projection.",
    );
  }

  if (!isNumber(source.receivedAtMs) || !isNumber(source.queuePosition) || !isNumber(source.windowMs)) {
    return unavailable(
      WINDOW_BASIS.INSUFFICIENT_INFORMATION,
      "accepted and queued. No assignment window is quoted: the shard's round cadence or queue position was " +
        "not available at intake, and a default would be indistinguishable from a measured projection.",
    );
  }

  const perRound = isNumber(source.maxLegsPerRound) && source.maxLegsPerRound > 0 ? source.maxLegsPerRound : 1;
  // A Leg at position p is solved by round ceil(p / legs-per-round). Position 1 is the
  // next round, which is `windowMs` away — never zero, because the batch window must
  // elapse before any round runs (§9.2).
  const roundsAhead = Math.max(1, Math.ceil(source.queuePosition / perRound));

  const earliestMs = source.receivedAtMs + source.windowMs;
  const expectedMs = source.receivedAtMs + roundsAhead * source.windowMs;
  // The upper edge allows for one round producing no assignment for this Leg — the
  // ordinary outcome when a nearer Leg wins the agent it wanted — which is why it is a
  // round beyond the expectation rather than a confidence interval this module has no
  // distribution to derive.
  const latestMs = expectedMs + source.windowMs;

  const atRisk = isNumber(source.slaBudgetSeconds)
    ? expectedMs - source.receivedAtMs > source.slaBudgetSeconds * MS_PER_SECOND
    : null;

  return Object.freeze({
    basis: WINDOW_BASIS.QUEUE_AND_CADENCE,
    earliestMs,
    expectedMs,
    latestMs,
    roundsAhead,
    atRisk,
    sentence:
      `accepted and queued at position ${source.queuePosition}; assignment is expected within ` +
      `${Math.round((latestMs - source.receivedAtMs) / MS_PER_SECOND)} s. This is a projection from queue depth ` +
      "and round cadence, not a commitment: no agent has been selected." +
      (atRisk === true
        ? " It exceeds this class's assignment budget, so the anti-starvation ladder (§17.4) is expected to act on it."
        : ""),
  });
}

/**
 * Validate a submission. Structural only — this is not the feasibility gate.
 *
 * @param {object} request
 * @returns {{ ok: boolean, problems: string[] }}
 */
function validate(request) {
  const source = request || {};
  const problems = [];

  if (!isNonEmptyString(source.legId)) problems.push("legId is required — the Leg is the decision index (§1.4)");
  if (!purposeModel.isPurpose(source.purpose)) {
    problems.push(
      `purpose "${String(source.purpose)}" is not a Leg purpose (§2.4). It is set at creation and never mutated, ` +
        "and cancellation, preemption, and admission control all read it.",
    );
  }
  if (source.slaClass !== null && source.slaClass !== undefined && !isNonEmptyString(source.slaClass)) {
    problems.push("slaClass, when supplied, must be a non-empty string");
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Write the durable queue row — the request path's last act (§3.2, §3.4).
 *
 * Idempotent on `idempotencyKey`: a retried submission finds its own prior row and is
 * answered with the original acceptance. That is checked *before* the insert rather than
 * relying on the unique constraint's violation, so the ordinary duplicate costs one
 * indexed read instead of a rolled-back transaction — but the constraint remains the
 * backstop for the concurrent case, which is why the insert is still wrapped.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} row the queue row's fields
 * @returns {Promise<{ created: boolean, row: object }>}
 */
async function enqueue(deps, row) {
  const prisma = deps.prisma;

  const existing = await prisma.workQueue.findUnique({ where: { idempotencyKey: row.idempotencyKey } });
  if (existing) return { created: false, row: existing };

  try {
    const created = await prisma.workQueue.create({ data: row });
    return { created: true, row: created };
  } catch (error) {
    // The unique constraint fired: a concurrent submission of the same key won the race.
    // Its row is the answer, exactly as the pre-check's would have been.
    const raced = await prisma.workQueue.findUnique({ where: { idempotencyKey: row.idempotencyKey } });
    if (raced) return { created: false, row: raced };
    throw error;
  }
}

/**
 * This Leg's 1-based position in its shard's queue, by the same order the round claims
 * in: priority, then time of arrival.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} row the queue row just written
 * @returns {Promise<number>}
 */
async function queuePositionOf(deps, row) {
  const ahead = await deps.prisma.workQueue.count({
    where: {
      shardId: row.shardId,
      state: QUEUE_STATE.QUEUED,
      OR: [
        { priority: { lt: row.priority } },
        { priority: row.priority, enqueuedAt: { lt: row.enqueuedAt } },
      ],
    },
  });
  return ahead + 1;
}

/**
 * The whole §3.4 request path: validate, admit, deduplicate, resolve the shard, enqueue
 * durably, and answer with a contract that does not imply an assignment.
 *
 * @param {object} deps `{ prisma, kv? }`
 * @param {object} request
 * @param {string} request.legId the `Leg.id` this submission concerns
 * @param {string} request.purpose
 * @param {string} [request.slaClass]
 * @param {string} [request.tenantId]
 * @param {string} [request.taskId] echoed back; not used for routing
 * @param {string} [request.idempotencyKey]
 * @param {string} [request.externalRef]
 * @param {number} request.receivedAtMs
 * @param {object} [request.shardResolution] as `resolveShard`
 * @param {boolean} [request.resolveShardFromStore] PHASE 13 — read the published
 *   region→shard map from the `Shard` table rather than taking it from the caller
 * @param {object} [request.admissionInputs] as `admission.assess`
 * @param {object} [request.cadence] `{ windowMs, maxLegsPerRound, feasibleSupply, slaBudgetSeconds }`
 * @returns {Promise<object>} the §3.4 response
 */
async function admit(deps, request) {
  const source = request || {};

  const validated = validate(source);
  if (!validated.ok) {
    return Object.freeze({
      outcome: OUTCOME.INVALID,
      accepted: false,
      assigned: false,
      taskId: source.taskId ?? null,
      legId: source.legId ?? null,
      problems: validated.problems,
      reason: "VALIDATION_FAILED",
      sentence: validated.problems.join("; "),
    });
  }

  const assessed = admission.assess({
    ...(source.admissionInputs || {}),
    purpose: source.purpose,
    slaClass: source.slaClass ?? null,
    tenantId: source.tenantId ?? null,
  });

  if (!assessed.admitted) {
    // Declined *at intake with an honest reason* (§20.5), before anything durable is
    // written. Nothing to withdraw, nothing to reconcile, and the caller can act now.
    return Object.freeze({
      outcome: OUTCOME.DECLINED,
      accepted: false,
      assigned: false,
      taskId: source.taskId ?? null,
      legId: source.legId,
      verdict: assessed.verdict,
      reason: assessed.reason,
      sentence: assessed.sentence,
      controls: assessed.controls,
    });
  }

  // PHASE 13 — a caller serving a live submission asks the store for the published map;
  // one replaying against a pinned snapshot passes the map it already holds. Opt-in
  // rather than default, so every existing caller's behaviour is unchanged and a replay
  // can never acquire a store read it did not have when the decision was first made
  // (§9.6 requirement 5, T6).
  const shard = source.resolveShardFromStore === true
    ? await resolveShardFor(deps, source.shardResolution || {})
    : resolveShard({ ...(source.shardResolution || {}) });
  if (!shard.ok) {
    return Object.freeze({
      outcome: OUTCOME.DECLINED,
      accepted: false,
      assigned: false,
      taskId: source.taskId ?? null,
      legId: source.legId,
      verdict: admission.VERDICT.DECLINE,
      reason: "SHARD_UNRESOLVED",
      sentence: shard.reason,
    });
  }

  const key = idempotencyKeyFor({
    tenantId: source.tenantId,
    legId: source.legId,
    externalRef: source.externalRef,
    idempotencyKey: source.idempotencyKey,
  });

  const cadence = source.cadence || {};
  const enqueuedAt = new Date(source.receivedAtMs);

  const { created, row } = await enqueue(deps, {
    legId: source.legId,
    shardId: shard.shardId,
    idempotencyKey: key.key,
    purpose: source.purpose,
    slaClass: source.slaClass ?? null,
    tenantId: source.tenantId ?? null,
    priority: priorityFor({ purpose: source.purpose, slaClass: source.slaClass }),
    state: QUEUE_STATE.QUEUED,
    availableAt: isNumber(source.availableAtMs) ? new Date(source.availableAtMs) : null,
    enqueuedAt,
  });

  const queuePosition = await queuePositionOf(deps, row);

  const window = predictAssignmentWindow({
    receivedAtMs: source.receivedAtMs,
    queuePosition,
    windowMs: cadence.windowMs,
    maxLegsPerRound: cadence.maxLegsPerRound,
    feasibleSupply: cadence.feasibleSupply,
    slaBudgetSeconds: cadence.slaBudgetSeconds,
  });

  // Stored so the prediction can be scored against the realised assignment (§21.5). A
  // window that is never compared to reality is a reassurance, not a prediction. Only
  // on first acceptance: a duplicate must be answered with the *original* quote, not
  // re-quoted against a queue that has moved on.
  if (created) {
    await deps.prisma.workQueue.update({
      where: { id: row.id },
      data: { predictedWindow: window },
    });
  }

  return Object.freeze({
    outcome: created ? OUTCOME.ACCEPTED : OUTCOME.DUPLICATE,
    // §3.4 — "The response MUST NOT imply an assignment has occurred." These two fields
    // are separate for exactly that reason: `accepted` is true, `assigned` is false, and
    // no rendering of this object can conflate them.
    accepted: true,
    assigned: false,
    taskId: source.taskId ?? null,
    legId: source.legId,
    shardId: shard.shardId,
    idempotencyKey: key.key,
    idempotencyKeyEchoed: key.echoed,
    queuePosition,
    predictedAssignmentWindow: created ? window : row.predictedWindow ?? window,
    state: row.state,
    sentence:
      created
        ? "intake succeeded and assignment is in progress. The outcome will arrive by event and is queryable by id."
        : "this submission was already accepted under the same idempotency key; the original acceptance is returned unchanged.",
  });
}

module.exports = {
  MS_PER_SECOND,
  OUTCOME,
  WINDOW_BASIS,
  QUEUE_STATE,
  SLA_CLASS_RANK,
  PURPOSE_RANK,
  priorityFor,
  idempotencyKeyFor,
  resolveShard,
  resolveShardFor,
  predictAssignmentWindow,
  validate,
  enqueue,
  queuePositionOf,
  admit,
};

/**
 * Task Service — the §3.4 request path.
 *
 * ── PHASE 15 — the legacy assignment path is gone ───────────────────────────
 * The execution plan's Phase 15 row retires "the legacy assignment path in
 * `task.service.js`", and its completion criterion is that the legacy decision path is
 * "**removed from the build, not merely bypassed**". This file is where that criterion is
 * most visible, so what left and what stayed are both stated.
 *
 * **Removed.** `_processAssignment` (greedy per-arrival selection through
 * `taskAssignment.service.js`), `_finalizeAssignment` (the bind-and-dispatch
 * transaction), `legacyDetachedAssignment` (the unsupervised `setImmediate` that §5.2
 * item C6 names as the root cause of "stuck at PENDING with no record of the failure"),
 * `seedTaskKeys` (the Redis writes that made the cache the source of truth for an
 * assignment), `getRoutesWithDistance` and `pathDistanceMeters` (the post-hoc route
 * measurement §13.1 replaces with a plan built *before* the choice), and the
 * `robotReserve:*` retry loop that was the only exclusivity mechanism this path had.
 * `tools/gates/checkLegacyRetirement.js` fails the build if any of them returns.
 *
 * **Kept, deliberately, until the retention window closes.** `rerouteTask` and the
 * `straightLineRoute` fallback it uses. Rerouting an in-flight legacy `Task` is not the
 * assignment path — it is an operator action on work already committed — and the plan
 * retires the `taskPath:*` / `robotTaskState:*` keys it reads "**after cutover**", not at
 * it. Deleting it here would strand every mission in flight across the cutover.
 * `docs/runbooks/cutover.md` names this as the last legacy surface and the condition
 * under which it goes.
 *
 * ── What `assignTask` does now, and what it refuses ────────────────────────
 * One path. Validate, create the `Task` row, map it to the domain (§2.4), and admit it to
 * the round through `engine/intake/intake.js`. There is no branch, no detach, and no
 * background computation: the request path's last act is a durable `WorkQueue` row and
 * the round path's first act is to read it, so no work depends on process-local state.
 *
 * When the engine is **not** live for the resolved shard, the request is **refused** with
 * 503 rather than queued. This is where the post-cutover world differs sharply from the
 * strangler world, and the difference is deliberate: with the legacy dispatcher out of the
 * build, admitting work to a shard whose coordinator is not running would recreate exactly
 * the defect the architecture exists to eliminate — a task accepted, durably recorded, and
 * never decided, with no component responsible for noticing (§12.1). A 503 naming the
 * state is honest; a queue nobody drains is not.
 *
 * ── The two halves of "is the engine live" ─────────────────────────────────
 * `engine/cutover/enabled.js` owns the conjunction (process `ENGINE_ENABLED` AND the
 * shard's `cutover.engine_enabled` binding). This file asks it rather than reading the
 * environment, so a shard that has not been staged is refused here for the same reason,
 * and with the same words, as it is everywhere else.
 */

const { toStringOrNull, toNumberOrNull } = require("../utils/parse");
const crypto = require("crypto");
const { directionsWithDistance } = require("./mapbox.service");
const { dispatchRerouteAlert } = require("./commandDispatcher.service");
const { safeJsonParse } = require("../utils/json");
const logger = require("../config/logger");
const intake = require("../engine/intake/intake");
const cadence = require("../engine/solve/cadence");
const cutoverEnabled = require("../engine/cutover/enabled");
const { taskToWork } = require("../engine/domain/mappers/legacyTask");
const { PURPOSES } = require("../engine/domain/purpose");
// PHASE 14 — §23.7's separation, applied by the production intake path.
const identityStore = require("../engine/privacy/identityStore");
const surrogateKeys = require("../engine/privacy/surrogateKeys");
const cells = require("../engine/spatial/cells");
// The §2.3 RequirementSet a submission produces, and the chassis vocabulary it names.
// Shared with commissioning so a task asking for a rover and a unit commissioned as one
// are speaking about the same token — two spellings of "rover" would be a filter that
// silently matches nothing.
const robotSpecification = require("./robotSpecification");
// REMEDIAL PHASE T1-04 — §4.5's deadline for the `QUEUED` state a newly admitted Leg is
// created in, and §17.4's ladder, which owns the rung timing that deadline is armed at.
const clock = require("../engine/commitment/clock");
const ladder = require("../engine/fairness/ladder");
const legEntryDeadline = require("../engine/cutover/legEntryDeadline");
const legMachine = require("../engine/lifecycle/legMachine");
const timers = require("../engine/supervision/timers");
const privacyKeys = require("../config/privacyKeys");

/**
 * Is the engine the decision path for the shard this request resolves to?
 *
 * Both halves, from one place (`engine/cutover/enabled.js`). Callers pass the published
 * configuration snapshot and the shard; a caller that passes neither gets `false`, which
 * is the right answer for a caller that cannot say which shard it means.
 *
 * @param {{ config?: object|null, regionId?: string|null, shardId?: string|null }} [context]
 * @returns {boolean}
 */
function engineEnabled(context) {
  const settings = context || {};
  return cutoverEnabled.forShard({
    snapshot: settings.config || null,
    shard: { regionId: settings.regionId || null, shardId: settings.shardId || null },
  });
}

/**
 * PHASE 14 — §23.7: seal the identifying values of one submission into the identity
 * store and write back the surrogate keys.
 *
 * ── Why here, and why on the write rather than after it ─────────────────────
 * §23.7's rule is that the *technical* record holds a stable surrogate key and the
 * derived, non-identifying quantities, and that the identifying values live in a
 * separate, access-controlled store. `backfillIdentities.js` applies that rule to rows
 * that already exist; nothing applied it to rows this system creates, which meant the
 * separation held for history and not for anything the fleet did next. This is the
 * missing producer.
 *
 * ── Fail closed, and why that is safe here ──────────────────────────────────
 * A missing secret throws rather than skipping. A skip would produce exactly the state
 * §23.7 exists to prevent — an address in `Stop.label` with no identity record, no key,
 * and no erasure route — and it would do so silently, at the one moment the address is
 * in hand. It is safe to throw because this function is only reached from `assignTask`,
 * *after* its cutover gate: while the engine is not live for a shard the request is
 * already refused with 503, so the hard dependency lands at the same cutover that makes
 * the path reachable at all.
 *
 * ── Which derived quantities are written, and which are honestly not ────────
 * `fineCell` only. It is a pure function of the coordinate (`spatial/cells.js`), which is
 * what §3.4's "no routing provider is consulted on the request path" permits. The other
 * five §23.7 quantities — the zone, the geofence result, the access-window class, the
 * service-time cohort, the routing-graph node — are products of the round, not of the
 * submission: each needs the routing graph, the geofence service or the service-time
 * model, and inventing one here would be a derived quantity nothing derived. They are
 * left null, and `PHASE_14_REMEDIATION_AND_CLOSURE.md` records the boundary and its owner
 * rather than leaving it to be discovered.
 *
 * @param {object} prisma
 * @param {object} input `{ task, work, privacyKeys }`
 * @returns {Promise<{ stops: number, ends: number }>}
 */
async function sealIdentities(prisma, input) {
  const source = input || {};
  const work = source.work || {};
  const task = source.task || {};

  const keys = source.privacyKeys || privacyKeys.fromEnvironment();

  let stops = 0;
  for (const stop of work.stops || []) {
    const natural = stopNaturalId(stop);
    if (natural === null) continue;

    // eslint-disable-next-line no-await-in-loop
    const stored = await identityStore.put(
      { prisma },
      {
        subjectType: surrogateKeys.SUBJECT_TYPE.STOP,
        naturalId: natural,
        fields: identifyingFieldsOf(stop),
        subjectId: stop.stopId,
        secret: keys.secret,
        encryptionKey: keys.encryptionKey,
      },
    );

    // eslint-disable-next-line no-await-in-loop
    await prisma.stop.update({
      where: { id: stop.id },
      data: {
        identityKey: stored.identityKey,
        ...(Number.isFinite(stop.lat) && Number.isFinite(stop.lon)
          ? { fineCell: cells.cellForPoint(stop.lat, stop.lon, cells.RESOLUTION.FINE) }
          : {}),
      },
    });
    stops += 1;
  }

  // Two keys for the Task, never one: `pickup` and `drop` are two different premises, and
  // a single key over both would make an erasure request for either erase the other.
  const ends = [
    { column: "originIdentityKey", natural: task.pickup, fields: { label: task.pickup, lat: task.pickupLat, lon: task.pickupLon } },
    { column: "destinationIdentityKey", natural: task.drop, fields: { label: task.drop, lat: task.dropLat, lon: task.dropLon } },
  ];

  const data = {};
  for (const end of ends) {
    if (typeof end.natural !== "string" || end.natural.trim() === "") continue;
    // eslint-disable-next-line no-await-in-loop
    const stored = await identityStore.put(
      { prisma },
      {
        subjectType: surrogateKeys.SUBJECT_TYPE.TASK,
        naturalId: end.natural,
        fields: end.fields,
        subjectId: task.taskId,
        secret: keys.secret,
        encryptionKey: keys.encryptionKey,
      },
    );
    data[end.column] = stored.identityKey;
  }

  if (Object.keys(data).length > 0) {
    await prisma.task.update({ where: { id: task.id }, data });
  }

  return { stops, ends: Object.keys(data).length };
}

/**
 * The identifying fields a freshly mapped Stop carries.
 *
 * @param {object} stop
 * @returns {object}
 */
function identifyingFieldsOf(stop) {
  const fields = {};
  if (stop.label !== null && stop.label !== undefined) fields.label = stop.label;
  if (Number.isFinite(stop.lat)) fields.lat = stop.lat;
  if (Number.isFinite(stop.lon)) fields.lon = stop.lon;
  return fields;
}

/**
 * The natural identifier a Stop's surrogate key is derived from.
 *
 * The label where there is one, else the coordinate pair — **identical** to
 * `backfillIdentities.stopNaturalId()`, and identical on purpose: a Stop backfilled
 * yesterday and a Stop created today must resolve to the same identity record, or one
 * erasure request would have to be filed twice for one address.
 *
 * @param {object} stop
 * @returns {string|null}
 */
function stopNaturalId(stop) {
  if (typeof stop.label === "string" && stop.label.trim() !== "") return stop.label;
  if (Number.isFinite(stop.lat) && Number.isFinite(stop.lon)) return `${stop.lat},${stop.lon}`;
  return null;
}

/**
 * REMEDIAL PHASE T1-04 — arm the §4.5 deadline of the `QUEUED` state a newly admitted Leg
 * is created in, and record its absolute instant on `Leg.slaDeadline`.
 *
 * Two writes, one transaction, one clock read, one resolved budget — see the block above
 * the `Leg.slaDeadline` update for why the column and the timer must be derived from the
 * same two values rather than computed independently.
 *
 * ── Why this is not `legEntryDeadline.superviseEntry` ──────────────────────
 * That module exists for the same obligation and is the right one for the four paths it
 * names — but every one of those enters a state by a **conditional write**, so it keys the
 * timer on `leg.version + 1` and cancels the exited state's deadline first. Neither
 * applies here: this Leg has just been created, it has no prior state to cancel, and its
 * version is the one the row carries. Keying on `version + 1` would arm a deadline that
 * `timers.assessFire` discards as stale on its very first pass — supervision that looks
 * present in the table and is inert in production.
 *
 * ── Why the first deadline is rung 1's boundary, not the whole budget ──────
 * §4.3 gives `QUEUED` the exit deadline `sla.assignment_deadline`, and §26.1's I13
 * instrument calls that same value "the ladder's **total** budget". §17.4 then triggers
 * each of its eight rungs on a *fraction* of it — 25 %, 40 %, 55 % and so on. A timer
 * armed at the whole budget therefore fires once, at 100 %, with all eight rungs already
 * behind it: the ladder would record every rung at once and go straight to its terminal
 * decision, having widened nothing. Every rung between "widen the radius" and "ask a
 * person" would exist and never run.
 *
 * So the first deadline is rung 1's boundary and the ladder re-arms itself at each
 * subsequent one (`expiryActions.escalationLadder`'s `deadlineSecondsOverride`).
 * `sla.assignment_deadline` is unchanged in meaning and is still the value the ladder
 * divides — what changed is that the timer now ticks at the rungs inside it.
 * `lifecycle/taskMachine.js` already recorded where that decision belongs: the ladder is
 * "whose step timing is (T1-04). Named here, owned there."
 *
 * A deployment whose ladder fractions do not resolve falls back to §4.3's register entry
 * unchanged, so a mis-published ladder costs the schedule and never the supervision.
 *
 * @param {object} tx the transaction that created the Leg (§4.5)
 * @param {object} input
 * @param {string} input.legId
 * @param {string|null} [input.shardId]
 * @param {{ get: (name: string) => any }|null} [input.values] the published `values` map
 * @returns {Promise<object|null>} the registered timer, or null when it could not be armed
 */
async function superviseQueuedEntry(tx, input) {
  const state = legMachine.LEG_STATE.QUEUED;
  const spec = legMachine.deadlineFor(state);
  if (!spec) return null;

  const leg = await tx.leg.findUnique({ where: { id: input.legId } });
  if (!leg || leg.state !== state) return null;

  // Already supervised — a retried submission converging on the same Leg. `timers.register`
  // is unique on its key and would converge too; checking first keeps the retry from
  // depending on a unique-violation path.
  const existing = await tx.timer.count({
    where: { entityType: timers.ENTITY_TYPE.LEG, entityId: leg.id, timerState: timers.TIMER_STATE.PENDING },
  });
  if (existing > 0) return null;

  const budgetSeconds = legEntryDeadline.deadlineSecondsFrom(input.values, state);
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) {
    // §22.1 admits no behavioural constant outside the register, least of all one invented
    // at the moment supervision is being armed. An unresolvable deadline is reported and
    // the Leg is left for `checkI4` to surface, which is the honest failure: a deadline
    // armed on a guessed budget supervises nothing correctly and looks like it does.
    logger.error("Could not arm the §4.5 QUEUED deadline: sla.assignment_deadline did not resolve", {
      legId: leg.legId,
      parameter: spec.parameter,
      consequence:
        "the Leg is queued with no deadline, so §17.4's escalation ladder has no trigger for it (invariant I4)",
    });
    return null;
  }

  const armedSeconds = ladder.firstBoundarySecondsFrom(input.values, budgetSeconds) ?? budgetSeconds;
  const storeTime = await clock.readStoreTime(tx);

  // ── The `Leg.slaDeadline` producer ──────────────────────────────────────────
  //
  // §4.3 gives Leg state `QUEUED` the exit deadline `sla.assignment_deadline`, and §4.5
  // registers that deadline in the transaction that enters the state. The *absolute
  // instant* of that exit deadline is what `Leg.slaDeadline` holds, and until now nothing
  // wrote it: `domain/mappers/legacyTask.taskToWork()` sets it to `null` — correctly, it
  // is a pure mapper with neither a clock nor a configuration snapshot — and no other
  // production path touched the column. §17.4's triage comparator
  // (`fairness/operatorCapacity.compareForTriage`) reads it as its third key, "SLA breach
  // proximity", so an unpopulated column made that key inert: every Leg sorted as
  // "proximity unknown" and a dispatcher facing forty escalations got custody and
  // obstruction, then arrival order.
  //
  // ── Why it is computed here and from exactly these two values ──────────────
  // `storeTime` and `budgetSeconds` are the same two quantities the timer below is armed
  // from, so the instant this column names and the instant the ladder actually advances
  // on cannot disagree. Deriving the column anywhere else — from `receivedAtMs`, from a
  // worker's wall clock, or from a second resolution of the parameter — would be a second
  // answer to one question, and §17.4 sorts by this one while §4.5 fires on that one.
  //
  // **`budgetSeconds`, never `armedSeconds`.** `armedSeconds` is rung 1's boundary — 25 %
  // of the budget by §17.4's own table — because the ladder re-arms itself at each
  // subsequent rung. A deadline written from it would declare every Leg in breach at a
  // quarter of its actual assignment budget, and the triage order that reads it would be
  // wrong in the direction that looks urgent.
  //
  // ── Written once, at creation, and never moved ─────────────────────────────
  // This is below the "already supervised" guard, so a retried submission converging on
  // the same Leg returns before reaching it and the deadline is not recomputed against a
  // later clock. It is also below the budget guard, so an unresolvable parameter leaves
  // the column `null` rather than a guessed instant (§22.1) — null is what the comparator
  // already treats as "proximity unknown, sort last", which is the honest reading.
  //
  // Only the creation path reaches this function. A Leg that re-enters `QUEUED` later —
  // an offer rejected or withdrawn (§11.2, `cutover/legEntryDeadline.superviseEntry`) —
  // deliberately keeps the deadline it was admitted with: restarting the assignment
  // budget on requeue would let a Leg cycle through offers indefinitely while its
  // anti-starvation clock was reset each time, which is the guarantee §17.4 exists to
  // make unbreakable.
  await tx.leg.update({
    where: { id: leg.id },
    data: { slaDeadline: clock.deadlineFrom(storeTime, budgetSeconds) },
  });

  return timers.register(tx, {
    entityType: timers.ENTITY_TYPE.LEG,
    entityId: leg.id,
    state,
    entity: leg,
    dueAt: timers.deadlineFrom(storeTime, armedSeconds),
    armedSeconds,
    handler: spec.onExpiry,
    payload: {
      armedBy: "task.service.admitToRound",
      // Recorded so a reader of the row can tell a rung boundary from the whole budget
      // without re-deriving the ladder, and so `timers.armedSecondsOf`'s default re-arm
      // is understood to be a rung interval rather than an assignment deadline.
      ladderBudgetSeconds: budgetSeconds,
      ladderRungArming: armedSeconds !== budgetSeconds,
    },
    shardId: input.shardId === null ? undefined : input.shardId,
  });
}

/**
 * PHASE 10 — §3.4's request path, for a legacy `Task` row.
 *
 * The bridge is `domain/mappers/legacyTask.taskToWork()` (Phase 2), which maps one legacy
 * Task to exactly one Mission, one `PRIMARY` Leg, and two Stops with deterministic ids —
 * §2.4's own "the model collapses to the simple case with no overhead". The ids being
 * deterministic is what makes this idempotent: a retried submission materialises the same
 * Leg and the intake's own unique key answers with the original acceptance.
 *
 * This function lives here rather than inside `src/engine/intake/` deliberately: the
 * engine's intake takes a `Leg.id` and knows nothing about the legacy `Task` shape, and
 * teaching it that shape would give a Tier 1 module a dependency that retires at Phase 15.
 *
 * @param {object} prisma
 * @param {object} pending the freshly created legacy Task row
 * @param {object} options `{ cadenceConfig, admissionInputs, receivedAtMs }`
 * @returns {Promise<object>} the §3.4 response
 */
async function admitToRound(prisma, pending, options = {}) {
  const work = taskToWork(pending, { regionId: options.regionId ?? null });

  // Materialised idempotently: the ids are a pure function of `Task.taskId`, so a retry
  // converges on the same rows rather than creating a second Leg for one request.
  //
  // ── The Mission is connected to its Task, and it was not ──────────────────
  //
  // §2.8 draws `Task >──< Mission`, and §2.4 puts the RequirementSet, the payload
  // specification, the SLA class and the tenant on the **Task**. `legLoaderFor` in
  // `workers/coordinatorSolvePath.js` reads all four *through that relation* — its own
  // comment says "the decision path reads them through this relation or not at all" — and
  // `taskAttributesFor` returns `undefined` for every one of them when the Mission has no
  // Tasks.
  //
  // Nothing connected them. `taskToWork` is a pure mapper and correctly produces no
  // relation write, and this was the only place that could make it, so every Mission the
  // running system created had an empty `tasks` list. The consequence was not a missing
  // field: F21 (requirements), F22 (payload) and F25 (tenant) each denied on an input that
  // was populated on a row the query did not reach — a class I predicate denying for lack
  // of data that existed. Connecting here is what makes a declared payload and a requested
  // agent class reach the gate at all.
  //
  // `connect` on both branches, because the upsert converges rather than creates on a
  // retry, and a connect that only ran on `create` would leave a retried submission's
  // Mission unlinked. Prisma's implicit join table makes a repeated connect idempotent.
  const connectTask = { tasks: { connect: { id: pending.id } } };
  await prisma.mission.upsert({
    where: { id: work.mission.id },
    create: { ...work.mission, ...connectTask },
    update: connectTask,
  });

  // ── REMEDIAL PHASE T1-04 — the Leg and its §4.5 deadline, in one transaction ─
  //
  // Everything here except the `superviseQueuedEntry` call is unchanged. What changed is
  // that the Leg upsert now shares a transaction with the deadline that supervises it,
  // because until this phase **nothing armed a QUEUED deadline for a newly admitted
  // Leg at all**, and that absence had two consequences that only look separate:
  //
  //   · **Invariant I4** — "Every non-terminal state has a deadline, and the deadline is
  //     registered in the transaction that enters the state." `invariantChecker.checkI4`
  //     reports every such Leg as `NO_PENDING_TIMER`. `supervision/reconciler.js` repairs
  //     orphaned Legs but explicitly skips `QUEUED` and `DEFERRED` ("it is not an orphan
  //     — it is queued"), so nothing downstream ever repaired it either.
  //   · **§17.4's anti-starvation ladder had no runtime trigger.** The ladder runs from
  //     `ESCALATION_LADDER`, which is §4.3's *on expiry* action for `QUEUED`. A Leg with
  //     no `QUEUED` deadline never expires, so the handler never fires, so the ladder
  //     never advances — for exactly the customer work it exists to protect. Composing
  //     the ladder into the timer worker without this would have produced a mechanism
  //     that is present, tested, and unreachable.
  //
  // §4.5's sentence is "in the transaction that enters the state", so the write and the
  // deadline commit together: a crash between them is what leaves a queued Leg nobody
  // supervises, which is the state this is here to make unrepresentable.
  await prisma.$transaction(async (tx) => {
    await tx.leg.upsert({ where: { id: work.leg.id }, create: work.leg, update: {} });
    await superviseQueuedEntry(tx, {
      legId: work.leg.id,
      shardId: options.shardId ?? null,
      values: options.configValues,
    });
  });

  for (const stop of work.stops) {
    await prisma.stop.upsert({ where: { id: stop.id }, create: stop, update: {} });
  }

  // PHASE 14 — §23.7's separation, applied at the moment the identifying values are
  // first written rather than by a migration afterwards. Before this, the only writer of
  // `Stop.identityKey` was `tools/migrate/backfillIdentities.js`, so every Stop the
  // running system created had no identity record, no surrogate key, and therefore no
  // route by which an erasure request could reach it.
  await sealIdentities(prisma, { task: pending, work, privacyKeys: options.privacyKeys });

  const receivedAtMs = typeof options.receivedAtMs === "number" ? options.receivedAtMs : Date.now();
  const config = options.cadenceConfig || {};

  // The window quoted to the caller is the one the next round will actually use, taken
  // from the same `solve/cadence.js` the coordinator reads. Two independent notions of
  // the round window — one for quoting and one for running — would make the prediction
  // wrong by construction rather than by circumstance.
  const verdict = cadence.windowFor({
    queueDepth: options.queueDepth ?? 0,
    feasibleSupply: options.feasibleSupply ?? 0,
    slaClassesWaiting: options.slaClassesWaiting || [],
    slaBudgetsSeconds: options.slaBudgetsSeconds,
    config,
  });

  return intake.admit(
    { prisma },
    {
      legId: work.leg.id,
      taskId: pending.taskId,
      purpose: PURPOSES.PRIMARY.name,
      slaClass: options.slaClass ?? null,
      tenantId: options.tenantId ?? null,
      idempotencyKey: options.idempotencyKey,
      externalRef: pending.taskId,
      receivedAtMs,
      shardResolution: { regionId: options.regionId ?? null, shardByRegionId: options.shardByRegionId },
      admissionInputs: options.admissionInputs || {},
      cadence: {
        windowMs: verdict.windowMs,
        maxLegsPerRound: verdict.maxLegsThisRound,
        feasibleSupply: options.feasibleSupply,
        slaBudgetSeconds: options.slaBudgetSeconds,
      },
    },
  );
}

async function readRobotLive(kv, robotId) {
  if (!kv) return null;
  try {
    const raw = await kv.get(`robot:${robotId}`);
    return safeJsonParse(raw);
  } catch {
    return null;
  }
}

function straightLineRoute({ from, to, points = 40 } = {}) {
  if (!from || !to) return null;
  const fromLat = typeof from.lat === "number" ? from.lat : null;
  const fromLon = typeof from.lon === "number" ? from.lon : null;
  const toLat = typeof to.lat === "number" ? to.lat : null;
  const toLon = typeof to.lon === "number" ? to.lon : null;
  if (fromLat === null || fromLon === null || toLat === null || toLon === null) return null;
  const n = Math.max(2, Math.min(200, Math.floor(points)));
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1);
    out.push({ lat: fromLat + (toLat - fromLat) * t, lon: fromLon + (toLon - fromLon) * t });
  }
  return out;
}

/**
 * §15.1's payload declaration, as a submission states it.
 *
 * ── Why a tolerance is required rather than defaulted ───────────────────────
 * §15.1: *"Mass is specified with a **tolerance**, because declared masses are frequently
 * wrong: feasibility uses the upper bound of the tolerance and energy estimation uses the
 * expectation."* `engine/payload/spec.itemMassForFeasibilityKg` returns `null` for an item
 * with a mass and no tolerance, which makes the load-state projection report a problem and
 * F22 deny — so a defaulted tolerance is not a convenience, it is the difference between
 * a payload the gate can reason about and one it cannot.
 *
 * Defaulting it to zero would be worse than refusing: it declares perfect precision on
 * behalf of somebody who declared nothing, and feasibility would then admit a plan on a
 * bound nobody stated. The submitter states both, or states neither.
 *
 * ── A task with no payload is legitimate ────────────────────────────────────
 * `{ ok: true, spec: null }` — a repositioning or inspection task carries nothing, and
 * refusing it would be inventing a requirement. What is refused is a *partial*
 * declaration, which is a submitter who meant to state a payload and did not finish.
 *
 * @param {unknown} input
 * @returns {{ ok: boolean, spec: object|null, problems: string[] }}
 */
function parsePayloadDeclaration(input) {
  if (input === undefined || input === null) return { ok: true, spec: null, problems: [] };
  if (typeof input !== "object" || Array.isArray(input)) {
    // Refused, not ignored. A caller that sent `payload: "7.5kg"` meant to declare a
    // payload; accepting the submission without one would put a parcel on a robot the gate
    // never checked the mass against, and the caller would have no way to know.
    return {
      ok: false,
      spec: null,
      problems: ["payload must be an object stating massKg and massToleranceKg."],
    };
  }

  const massKg = toNumberOrNull(input.massKg);
  const massToleranceKg = toNumberOrNull(input.massToleranceKg);
  const itemCount = toNumberOrNull(input.itemCount);
  const description = toStringOrNull(input.description);

  if (massKg === null && massToleranceKg === null) return { ok: true, spec: null, problems: [] };

  const problems = [];
  if (massKg === null) problems.push("payload.massKg is required when a payload is declared.");
  else if (massKg <= 0) problems.push("payload.massKg must be greater than zero.");
  else if (massKg > 5000) problems.push("payload.massKg must be at most 5000 kg.");

  if (massToleranceKg === null) {
    problems.push(
      "payload.massToleranceKg is required: §15.1 specifies mass with a tolerance, and feasibility " +
        "uses the upper bound of that tolerance. A payload with no tolerance cannot be gated.",
    );
  } else if (massToleranceKg < 0) {
    problems.push("payload.massToleranceKg must not be negative.");
  } else if (massKg !== null && massToleranceKg > massKg) {
    problems.push("payload.massToleranceKg must not exceed the declared mass.");
  }

  if (itemCount !== null && (!Number.isInteger(itemCount) || itemCount < 1)) {
    problems.push("payload.itemCount must be a positive whole number.");
  }

  if (problems.length > 0) return { ok: false, spec: null, problems };

  return {
    ok: true,
    spec: {
      massKg,
      massToleranceKg,
      ...(itemCount === null ? {} : { itemCount }),
      ...(description === null ? {} : { shapeClass: description }),
    },
    problems: [],
  };
}

/**
 * Public API — §3.4's request path. One path, no branch.
 *
 * Validate, create the `Task` row, and admit it to the round. The response carries the
 * §3.4 contract: task id, idempotency echo, queue position, and a predicted assignment
 * window that does not imply an assignment has occurred.
 *
 * Refuses with 503 when the engine is not live for the resolved shard — see the file
 * header for why refusing beats queueing now that the legacy dispatcher is out of the
 * build.
 *
 * `task.robotId` — the legacy "assign me this specific robot" field — is **no longer
 * honoured**, and the response says so rather than ignoring it silently. A
 * caller-nominated agent bypasses candidate generation, the feasibility gate and the
 * solve together, and §7.1's rule is absolute: the gate "is evaluated before cost and is
 * never traded against it". The supported way to force an agent is §23.6's override
 * discipline — scoped, reasoned, audited, and refused outright for class I, R and F —
 * which Phase 14 shipped. No new capability is added here to replace the field; Phase 15
 * ships no new capability at all.
 */
async function assignTask(prisma, task, { kv, io, ...options } = {}) {
  let taskId = toStringOrNull(task?.taskId || task?.id);
  const nominatedAgentId = toStringOrNull(task?.robotId);
  const pickup      = toStringOrNull(task?.pickup);
  const drop        = toStringOrNull(task?.drop);

  if (!pickup || !drop) {
    const err = new Error("pickup and drop are required");
    err.status = 400;
    throw err;
  }

  if (!taskId) {
    const suffix = crypto.randomInt(100, 1000);
    taskId = `TSK-${Date.now()}-${suffix}`;
  }

  const pickupLat = toNumberOrNull(task?.pickupLat);
  const pickupLon = toNumberOrNull(task?.pickupLon);
  const dropLat   = toNumberOrNull(task?.dropLat);
  const dropLon   = toNumberOrNull(task?.dropLon);

  if (pickupLat === null || pickupLon === null || dropLat === null || dropLon === null) {
    const err = new Error("pickupLat/pickupLon/dropLat/dropLon are required");
    err.status = 400;
    throw err;
  }

  // ── The payload, and the agent class the submitter is asking for ──────────
  //
  // Both are validated here, before the cutover gate and before any row is written, for
  // the same reason the gate is checked before the row: a submission that cannot be
  // admitted must leave nothing behind.
  const payload = parsePayloadDeclaration(task?.payload);
  if (!payload.ok) {
    const err = new Error(`Invalid payload: ${payload.problems.join(" ")}`);
    err.status = 400;
    err.problems = payload.problems;
    throw err;
  }

  // The requested agent class. `requestedChassisType` is the additive, explicit task-side
  // field the architecture needed: §2.4's Task carries a RequirementSet and §2.3's algebra
  // matches it, so the *request* is a chassis token and the *matching* is F21's — no new
  // predicate, no candidate filter of its own, and nothing hard-coded about which unit
  // goes. An unrecognised token is refused rather than dropped: silently ignoring it would
  // send a drone mission to a rover.
  const requestedRaw = toStringOrNull(task?.requestedChassisType ?? task?.requestedClass);
  const requestedChassisType = robotSpecification.normaliseChassisType(requestedRaw);
  if (requestedRaw !== null && requestedChassisType === null) {
    const err = new Error(
      `requestedChassisType must be one of ${robotSpecification.CHASSIS_TYPES.join(", ")}`,
    );
    err.status = 400;
    throw err;
  }

  const requirements = robotSpecification.requirementSetFor({
    chassisType: requestedChassisType,
    payloadMassKg: payload.spec ? payload.spec.massKg : null,
  });

  // ── The cutover gate, checked before anything is written ──────────────────
  //
  // Before the row, not after it. A refused request that had already created a PENDING
  // `Task` would leave exactly the artefact §12.1 objects to: a durable record of work
  // that no component owns. The caller gets a 503 and the database is untouched.
  const posture = cutoverEnabled.describe({
    snapshot: options.config || null,
    shard: { regionId: options.regionId || null, shardId: options.shardId || null },
  });
  if (!posture.live) {
    const err = new Error(
      `the assignment engine is not live for this shard: ${posture.consequence}`,
    );
    err.status = 503;
    err.code = "ENGINE_NOT_LIVE";
    err.posture = posture;
    throw err;
  }

  // §15.1's task-side payload specification, materialised before the Task so the Task can
  // reference it. `specId` is a pure function of the task id, so a retried submission
  // converges on the same row rather than minting a second specification for one parcel —
  // the same idempotence `taskToWork` gives the Mission, Leg and Stops.
  let payloadSpecId = null;
  if (payload.spec) {
    const stored = await prisma.payloadSpec.upsert({
      where: { specId: `PLD-${taskId}` },
      create: { specId: `PLD-${taskId}`, ...payload.spec },
      update: payload.spec,
    });
    payloadSpecId = stored.id;
  }

  // Create the PENDING task. Fast and synchronous: no routing provider is consulted on
  // the request path (§3.4), because the plan that will be routed is built inside the
  // round, before the choice, from the same artefact the cost model scores (§13.1).
  const pending = await prisma.task.create({
    data: {
      taskId,
      pickup,
      pickupLat,
      pickupLon,
      drop,
      dropLat,
      dropLon,
      status: "PENDING",
      // §2.4's own columns, populated by the submission that states them. `requirements`
      // is left **null** when the submitter stated none: `[]` would assert "this task has
      // no requirements", and null is "nobody stated any" — F21 reads the two differently
      // and only one of them is true here.
      ...(requirements.length > 0 ? { requirements } : {}),
      ...(payloadSpecId ? { payloadSpecId } : {}),
    },
    include: { robot: { select: { robotId: true } }, payloadSpec: true },
  });

  // Notify dashboard so the UI shows the PENDING card with spinner right away.
  try {
    io?.to("dashboard")?.emit("TASK_CREATED", { ...pending, robot: null });
  } catch { /* ignore */ }

  // ── §3.4's request path ───────────────────────────────────────────────────
  //
  // The request path's last act is a durable `WorkQueue` row, and the round path's
  // first act is to read it. Between the two there is no closure, no timer, and no
  // process-local state, which is what makes the work survivable across a restart —
  // and what makes "stuck at PENDING with no record of the failure" unrepresentable:
  // a waiting Leg is a queue row with a position, an age, and a state.
  const admitted = await admitToRound(prisma, pending, {
    receivedAtMs: options.receivedAtMs,
    cadenceConfig: options.cadenceConfig,
    admissionInputs: options.admissionInputs,
    queueDepth: options.queueDepth,
    feasibleSupply: options.feasibleSupply,
    slaClass: options.slaClass,
    slaBudgetSeconds: options.slaBudgetSeconds,
    tenantId: options.tenantId,
    idempotencyKey: options.idempotencyKey,
    regionId: options.regionId,
    shardByRegionId: options.shardByRegionId,
    shardId: options.shardId,
    // T1-04 — the published `values` map, so the `QUEUED` deadline is armed from
    // `sla.assignment_deadline` and §17.4's rung-1 fraction rather than from a constant.
    // The whole snapshot is already here for the cutover gate above; this reads one map
    // off it rather than resolving configuration a second way.
    configValues: options.config && options.config.values ? options.config.values : null,
  });

  // The legacy `{ ...task }` shape every existing caller reads is still present, and the
  // §3.4 contract arrives beside it under `intake`. The plan supersedes the old response
  // contract here (`docs/runbooks/cutover.md` carries the API version note); the legacy
  // fields are retained through the retention window so a consumer that has not migrated
  // reads a task row rather than a 500.
  //
  // `ignoredFields` is how a dropped input is reported rather than swallowed. A caller
  // still sending `robotId` learns that it had no effect, in the response, at the moment
  // it had no effect — not weeks later when someone notices the robot it named was never
  // the one that went.
  const ignoredFields = nominatedAgentId
    ? [
        {
          field: "robotId",
          value: nominatedAgentId,
          reason:
            "caller-nominated agents are not honoured: selection runs through candidate generation, the " +
            "feasibility gate and the solve (§6, §7, §9). Use the §23.6 override to force an agent.",
        },
      ]
    : [];

  return Object.assign({}, pending, { intake: admitted, ignoredFields });
}

/**
 * Reroute an in-progress task from the robot's current position.
 * Called when the operator selects REROUTE in the Decision Required modal.
 */
async function rerouteTask(prisma, taskId, { kv, io } = {}) {
  const task = await prisma.task.findUnique({
    where: { taskId },
    include: { robot: { select: { robotId: true, lat: true, lon: true } } },
  });
  if (!task) { const e = new Error("Task not found"); e.status = 404; throw e; }
  if (!task.robot) { const e = new Error("No robot assigned to task"); e.status = 400; throw e; }

  const robotId = task.robot.robotId;

  // Get robot's current live position from Redis, fall back to DB
  const live = await readRobotLive(kv, robotId);
  const curLat = typeof live?.lat === "number" ? live.lat
    : typeof task.robot.lat === "number" ? task.robot.lat : null;
  const curLon = typeof live?.lon === "number" ? live.lon
    : typeof task.robot.lon === "number" ? task.robot.lon : null;
  if (curLat === null || curLon === null) {
    const e = new Error("Robot has no known position"); e.status = 400; throw e;
  }

  // Determine which segment the robot is currently navigating
  let segment = "toPickup";
  let targetCoord = { lat: task.pickupLat, lon: task.pickupLon };
  try {
    const rawState = kv ? await kv.get(`robotTaskState:${robotId}`) : null;
    const state = safeJsonParse(rawState);
    if (state?.phase === "TO_DROP" || state?.segment === "toDrop") {
      segment = "toDrop";
      targetCoord = { lat: task.dropLat, lon: task.dropLon };
    }
  } catch { /* ignore */ }

  // Compute fresh Mapbox route from current position
  const from = { lat: curLat, lon: curLon };
  let newPoints = null;
  for (const profile of ["driving", "walking", "cycling"]) {
    try {
      const r = await directionsWithDistance({ from, to: targetCoord, profile });
      newPoints = r.points;
      logger.info(`[Reroute] ${profile} route OK — ${newPoints.length} pts, task ${taskId}`);
      break;
    } catch (e) {
      logger.warn(`[Reroute] ${profile} failed — ${e?.message}`);
    }
  }
  // Straight-line fallback
  if (!newPoints) {
    newPoints = straightLineRoute({ from, to: targetCoord, points: 100 });
    logger.warn(`[Reroute] Using straight-line fallback for task ${taskId}`);
  }
  if (!newPoints) {
    const e = new Error("Cannot compute reroute path"); e.status = 502; throw e;
  }

  // Update Redis task path cache with the new segment
  if (kv) {
    try {
      const rawPath = await kv.get(`taskPath:${taskId}`);
      const cached = safeJsonParse(rawPath) || {};
      const updated = { ...cached, [segment]: newPoints };
      await kv.set(`taskPath:${taskId}`, JSON.stringify(updated), { ex: 86400 });
    } catch { /* non-critical */ }

    // Reset pathIndex so robot starts the new path from index 0
    try {
      const rawState = await kv.get(`robotTaskState:${robotId}`);
      const state = safeJsonParse(rawState);
      if (state) {
        state.pathIndex = 0;
        await kv.set(`robotTaskState:${robotId}`, JSON.stringify(state), { ex: 86400 });
      }
    } catch { /* non-critical */ }
  }

  // Notify dashboard — useRobotStream listens for TASK_UPDATED with action REROUTED
  try {
    io?.to("dashboard")?.emit("TASK_UPDATED", {
      taskId,
      robotId,
      action: "REROUTED",
      segment,
      newPath: newPoints,
    });
  } catch { /* ignore */ }

  // Send REROUTE_ALERT to the robot socket with the full new path
  try {
    await dispatchRerouteAlert(io, robotId, {
      taskId,
      segment,
      newPath: newPoints,
    });
  } catch { /* non-critical — robot will use existing path if not reached */ }

  logger.info(`[Reroute] Task ${taskId} rerouted — ${newPoints.length} pts, segment=${segment}`);
  return { taskId, robotId, segment, points: newPoints.length };
}

module.exports = {
  assignTask,
  rerouteTask,
  straightLineRoute,
  admitToRound,
  engineEnabled,
  parsePayloadDeclaration,
};

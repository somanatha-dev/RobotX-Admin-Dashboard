"use strict";

/**
 * STEP 5 — the position Observation writer.
 *
 * ── What was missing, exactly ────────────────────────────────────────────────
 * The canonical telemetry path (`sockets/handlers/telemetry.handler.js`) updated Redis,
 * the `Robot` row and the `Telemetry` history table. The Assignment Engine reads none of
 * those: its position input is `AgentCellPosition`, produced by
 * `workers/indexMaintainer.worker.js`, which derives it from `Observation` rows of
 * `kind = "position"` (§2.7, §6.2). **Nothing in production wrote one.** `observation.create`
 * existed at exactly one call site — `offer.handler.js`'s §11.2 feasibility observation on a
 * rejected offer — so `AgentCellPosition` was empty for the same reason a pipe with no
 * source is dry.
 *
 * This module is that source, and it is deliberately the *smallest* thing that can be:
 * it creates no second Observation model, no second identity model, no second cell
 * implementation and no second index. It resolves an `Agent.id`, validates the frame
 * against §2.7's own contract, and appends one row.
 *
 * ── The agent-measured timestamp is mandatory and is never substituted ───────
 * §2.7, restated by `engine/domain/observation.createObservation`:
 *
 *   > `observedAt` — when the **agent** measured it — is mandatory and is never defaulted
 *   > to the receipt time. Defaulting it would silently make every observation maximally
 *   > fresh at exactly the moment the link degraded, which is the failure this whole
 *   > section exists to prevent.
 *
 * So a frame that carries no `timestamp` produces **no Observation at all**. It does not
 * produce one stamped `Date.now()`. That is a deliberate, load-bearing refusal and it has a
 * cost that is stated rather than hidden: an agent whose firmware does not yet send
 * `timestamp` is not indexed, and therefore is not a candidate. The alternative — stamping
 * receipt time — would make a silent agent look like a perfectly fresh one, which is
 * precisely the permissive-default cliff §2.7 exists to remove.
 *
 * The wire field is `timestamp`, in epoch milliseconds. That is not a new contract: it is
 * the field `VirtualRobot._emitTelemetry` has sent since Step 4, alongside its per-robot
 * monotonic `sequence`. Physical firmware sends the same two fields; there is one telemetry
 * contract, not one per kind of agent.
 *
 * ── Simulated and physical evidence are distinguishable, and the pipeline is one ──
 * A simulated agent's frame travels the *same* handler, produces the *same* `kind:
 * "position"` Observation, is indexed by the *same* worker into the *same*
 * `AgentCellPosition` row, and is read by the *same* Assignment Engine snapshot loader.
 * That identity is the entire point: a simulator that exercised a different path would
 * exercise nothing.
 *
 * What differs is one field inside `Observation.value`: `provenance`, which is
 * `"PHYSICAL"` or `"SIMULATED"`. It is chosen as the mechanism because it is the smallest
 * one that already exists —
 *
 *   * **not a new `source` value.** §2.7's provenance vocabulary is a closed set of five
 *     (`OBSERVATION_SOURCE`), and adding a sixth would be inventing a specification value.
 *     Both kinds of agent are `AGENT_REPORT`, which is what they are: an assertion by the
 *     thing being measured.
 *   * **not a new `kind`.** `indexMaintainer` queries `kind = "position"`; a second kind
 *     would be a second pipeline, which is the one thing this step is told not to build.
 *   * **not a column on `AgentCellPosition`.** That table is engine input, and
 *     `tests/engine/simulationBoundary.test.js` holds — structurally — that the engine
 *     cannot see the discriminator. A column there would hand it one.
 *   * **not a migration.** `Observation.value` is `Json` and this adds a key to it.
 *
 * A physical-evidence gate therefore asks `isPhysicalEvidence(row)` (or, in SQL,
 * `value->>'provenance' = 'PHYSICAL'`) and gets a definite answer. **An observation whose
 * provenance cannot be established is not written**, so there is no third state that a
 * reader could mistake for physical.
 *
 * ── Why this module lives in `src/services/` and not in `src/engine/` ────────
 * Because it reads `Robot.simulated` through `simulationPolicy`, and the boundary test
 * forbids that anywhere under `src/engine/` or `src/workers/`. It is a *labelling*
 * boundary, the same category `services/robotProjection.js` occupies, and it is registered
 * on that test's allow-list rather than hidden from its detector.
 */

const observation = require("../engine/domain/observation");
const simulationPolicy = require("../simulation/simulationPolicy");
const { toStringOrNull } = require("../utils/parse");

/**
 * §2.7's `kind` for a position fact, and the exact string
 * `indexMaintainer.worker.assembleRecord` filters on. Exported so the two cannot drift by
 * one of them being edited.
 */
const POSITION_KIND = "position";

/**
 * The two provenances a position Observation may carry. Closed set: a value outside it is
 * not written, because "unknown provenance" must never be readable as "physical".
 * @structural evidence-provenance labels
 */
const PROVENANCE = Object.freeze({
  PHYSICAL: "PHYSICAL",
  SIMULATED: "SIMULATED",
});

/**
 * Why a frame did or did not become an Observation. Returned rather than logged, so the
 * caller decides the log level and a test can assert the reason rather than a side effect.
 * @structural outcome labels
 */
const OUTCOME = Object.freeze({
  WRITTEN: "WRITTEN",
  /** The frame reported no usable lat/lon of its own. */
  NO_REPORTED_POSITION: "NO_REPORTED_POSITION",
  /** No agent-measured `timestamp`. Never substituted with receipt time — see the header. */
  NO_AGENT_TIMESTAMP: "NO_AGENT_TIMESTAMP",
  /** No `Agent` row projects this `Robot`. Nothing to attribute the observation to. */
  AGENT_NOT_PROJECTED: "AGENT_NOT_PROJECTED",
  /** The `Robot` row could not say whether it is simulated. Fail closed; write nothing. */
  PROVENANCE_UNDETERMINED: "PROVENANCE_UNDETERMINED",
  /** §2.7: a repeated or regressing sequence is a replay, not a fresher fact. */
  STALE_SEQUENCE: "STALE_SEQUENCE",
  /** The frame is stamped no later than one already accepted for this agent. */
  STALE_OBSERVED_AT: "STALE_OBSERVED_AT",
  /**
   * `createObservation` refused the record, or (C4) the frame's `position` block declared no
   * recognised fix quality. The reason is carried in `detail`.
   */
  INVALID_OBSERVATION: "INVALID_OBSERVATION",
  /**
   * P2B-2 — stamped further in the future than `time.max_clock_skew` allows. An agent clock
   * running fast would otherwise make a stale fix look fresh to every freshness reader.
   */
  CLOCK_AHEAD: "CLOCK_AHEAD",
  /** P2B-2 — the frame itself declared `position.fixType: "NO_FIX"`; its lat/lon are not a fix. */
  NO_FIX_DECLARED: "NO_FIX_DECLARED",
});

/**
 * The register parameter that bounds how far ahead of the server's clock an agent-stamped
 * observation may be (§10.6), and its declared default — read from the register itself so
 * no number is restated here.
 * @structural a parameter name
 */
const MAX_CLOCK_SKEW_PARAMETER = "time.max_clock_skew";
let declaredSkewDefault;
function declaredMaxClockSkewMs() {
  if (declaredSkewDefault === undefined) {
    declaredSkewDefault = null;
    try {
      const register = require("../engine/config/register/appendixA.json");
      const walk = (node) => {
        if (declaredSkewDefault !== null || !node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach(walk);
        if (node.name === MAX_CLOCK_SKEW_PARAMETER && Number.isFinite(node.default)) {
          declaredSkewDefault = node.default;
          return;
        }
        Object.values(node).forEach(walk);
      };
      walk(register);
    } catch {
      declaredSkewDefault = null;
    }
  }
  return declaredSkewDefault;
}

/**
 * The skew bound in force: the pinned configuration's value, else the register's declared
 * default. Null only if neither exists, in which case no bound can be applied and the frame
 * is refused rather than admitted unbounded.
 *
 * @param {object|null} snapshot the pinned configuration, when the caller has one
 * @returns {number|null}
 */
function maxClockSkewMsFrom(snapshot) {
  if (snapshot && typeof snapshot.resolve === "function") {
    try {
      const value = snapshot.resolve(MAX_CLOCK_SKEW_PARAMETER, {});
      if (Number.isFinite(value) && value > 0) return value;
    } catch {
      // fall through to the declared default
    }
  }
  return declaredMaxClockSkewMs();
}

/** The fix types the P2A contract's optional `position` block may declare. @structural */
const FIX_TYPES = Object.freeze(["NO_FIX", "2D", "3D", "RTK_FLOAT", "RTK_FIXED"]);

/**
 * C4 — why a present `position` block cannot be admitted, or null when it can.
 *
 * The block is optional; when it is sent, its `fixType` is the contract's declaration of what
 * kind of measurement the lat/lon are (`docs/contracts/PHYSICAL_ROBOTX_BACKEND_CONTRACT.md`).
 * A value outside `FIX_TYPES` — another word, another case, a number — declares a quality
 * nothing here defines, so it is not admitted as a measurement. Nor is a block that declares
 * no `fixType` at all. (A dead-reckoned declaration without one was already refused: §2.7
 * requires its uncertainty radius, and that radius is only read alongside a recognised type.)
 *
 * @param {unknown} fix the frame's `position` value, known not to be null/undefined
 * @returns {string|null}
 */
function fixBlockProblem(fix) {
  if (typeof fix !== "object" || Array.isArray(fix)) return "the `position` block is not an object";
  const declared = fix.fixType;
  if (declared === undefined || declared === null) return "the `position` block declares no fixType";
  if (!FIX_TYPES.includes(declared)) {
    return `position.fixType ${JSON.stringify(String(declared).slice(0, 32))} is not one of ${FIX_TYPES.join("|")}`;
  }
  return null;
}

/**
 * How long a resolved `robotId → { Agent.id, provenance }` binding is trusted.
 *
 * Both facts are effectively immutable for a row's lifetime — the `Agent` projection is
 * 1:1 and created with the `Robot`, and `Robot.simulated` is written once at creation and
 * has no update path. The TTL is not about them changing; it is so that a decommission and
 * re-commission under the same `robotId` cannot be served from a stale binding for the
 * life of the process, without this module having to be invalidated by every writer that
 * touches the two tables. One indexed read per robot per minute is the price.
 * @structural a cache lifetime, not a behavioural threshold
 */
const BINDING_TTL_MS = 60_000;

/**
 * Cap on both per-process maps, swept oldest-first when exceeded. Bounded by fleet size in
 * normal operation — the same pattern `telemetry.handler.js`'s `lastDbFlushAt` and
 * `sockets/rateLimit.js` use.
 * @structural a memory bound
 */
const MAX_TRACKED_ROBOTS = 50_000;

/** robotId -> { agentRowId, provenance, resolvedAtMs } */
const bindings = new Map();

/** robotId -> { observedAtMs, sequence } — the newest position accepted for this agent. */
const highWaterMarks = new Map();

/**
 * @param {Map} map
 */
function capped(map) {
  if (map.size <= MAX_TRACKED_ROBOTS) return;
  // Map iteration is insertion-ordered, so this drops the least recently *inserted*.
  const excess = map.size - MAX_TRACKED_ROBOTS;
  let dropped = 0;
  for (const key of map.keys()) {
    map.delete(key);
    dropped += 1;
    if (dropped >= excess) break;
  }
}

/**
 * Read the agent's own measurement instant off a telemetry frame.
 *
 * One field, `timestamp`, in epoch milliseconds — the field `VirtualRobot` already emits
 * and the field physical firmware is required to emit. A numeric string is accepted
 * because the socket transport does not guarantee the JSON type of a scalar; anything else
 * is `null`, and `null` means no Observation.
 *
 * @param {object|null|undefined} payload
 * @returns {number|null}
 */
function agentTimestampFrom(payload) {
  const raw = payload && payload.timestamp;
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * Read the agent's per-frame monotonic ordinal, when it sends one.
 *
 * Optional by the schema (`Observation.sequence` is `BigInt?`) and by §2.7, which uses it
 * "for ordering and replay detection". An agent that sends none is ordered by `observedAt`
 * alone, which is weaker — two frames in the same millisecond are indistinguishable — and
 * that weakening is the agent's, not this module's.
 *
 * @param {object|null|undefined} payload
 * @returns {bigint|null}
 */
function sequenceFrom(payload) {
  const raw = payload && payload.sequence;
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 0 ? BigInt(raw) : null;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return BigInt(raw.trim());
  if (typeof raw === "bigint") return raw >= 0n ? raw : null;
  return null;
}

/**
 * Resolve `Robot.robotId` → `{ Agent.id, provenance }`, through the relationships that
 * already exist.
 *
 * **No second identity model.** `Agent.agentId` is seeded from `Robot.robotId` by Phase 2's
 * backfill and the projection is 1:1 (`Agent.robotDbId` is `@unique`), which is exactly
 * what `offer.handler.resolveAgent` relies on. This reads it from the `Robot` side in one
 * query because it needs `simulated` from the same row, and two queries could disagree.
 *
 * An absent `Agent` means the robot has not been projected. That is a reason to record no
 * observation, never a reason to create an Agent — inventing one here would put a fleet
 * participant into the engine's world that no commissioning act created.
 *
 * @param {object} prisma
 * @param {string} robotId
 * @param {number} nowMs
 * @returns {Promise<{ agentRowId: string, provenance: string }|null>}
 */
async function resolveBinding(prisma, robotId, nowMs) {
  const cached = bindings.get(robotId);
  if (cached && nowMs - cached.resolvedAtMs < BINDING_TTL_MS) {
    return { agentRowId: cached.agentRowId, provenance: cached.provenance };
  }

  const row = await prisma.robot.findUnique({
    where: { robotId },
    select: { simulated: true, agent: { select: { id: true } } },
  });

  if (!row) return null;

  // Fail closed on an unreadable discriminator. `Robot.simulated` is `Boolean
  // @default(false)` and NOT nullable, so `undefined` here means the read narrowed the
  // `select` — the same developer error `robotProjection.toPublicRobot` throws on — and
  // answering "PHYSICAL" for it would label simulator output as physical evidence.
  if (typeof row.simulated !== "boolean") return null;
  if (!row.agent || !row.agent.id) return null;

  const provenance = simulationPolicy.isSimulatedRobot(row) ? PROVENANCE.SIMULATED : PROVENANCE.PHYSICAL;
  bindings.set(robotId, { agentRowId: row.agent.id, provenance, resolvedAtMs: nowMs });
  capped(bindings);
  return { agentRowId: row.agent.id, provenance };
}

/**
 * Seed this process's ordering high-water mark from the durable log.
 *
 * Without it, a restart would forget what it had accepted and admit an older frame into
 * the append-only log. It is one indexed read (`@@index([agentId, kind, observedAt])`) the
 * first time a robot is seen, and it is deliberately a *seed* rather than a per-frame
 * query: the per-frame authority is the in-process mark, because a durable read per
 * telemetry frame is exactly the cost the telemetry path was optimised to remove.
 *
 * @param {object} prisma
 * @param {string} robotId
 * @param {string} agentRowId
 * @returns {Promise<{ observedAtMs: number, sequence: bigint|null }|null>}
 */
async function seedHighWaterMark(prisma, robotId, agentRowId) {
  const existing = highWaterMarks.get(robotId);
  if (existing) return existing;

  const latest = await prisma.observation.findFirst({
    where: { agentId: agentRowId, kind: POSITION_KIND },
    orderBy: { observedAt: "desc" },
    select: { observedAt: true, sequence: true },
  });

  const mark = latest
    ? {
        observedAtMs: new Date(latest.observedAt).getTime(),
        sequence: latest.sequence === null || latest.sequence === undefined ? null : BigInt(latest.sequence),
      }
    : { observedAtMs: null, sequence: null };

  highWaterMarks.set(robotId, mark);
  capped(highWaterMarks);
  return mark;
}

/**
 * Record one accepted telemetry position as a canonical §2.7 Observation.
 *
 * ── What the caller has already established, and what this still checks ─────
 * The caller (`telemetry.handler.js`) has authenticated the socket, rejected any capability
 * claim, and run §23.5's position and energy trust boundaries. This function re-checks
 * nothing about trust — it would be a second, divergent copy of that policy — and checks
 * everything about *provenance and ordering*, which is its own contract.
 *
 * @param {object} prisma
 * @param {object} input
 * @param {string} input.robotId the legacy `Robot.robotId` the socket authenticated as
 * @param {number|null} input.lat the position **as reported in this frame**, never a
 *   fallback to the last known one — a stale position under a fresh agent timestamp is a
 *   fabricated measurement
 * @param {number|null} input.lon
 * @param {number|null} input.agentTimestampMs from `agentTimestampFrom(payload)`
 * @param {bigint|null} [input.sequence] from `sequenceFrom(payload)`
 * @returns {Promise<{ written: boolean, outcome: string, provenance: string|null,
 *   agentRowId: string|null, observedAtMs: number|null, detail: string|null }>}
 */
async function recordPositionObservation(prisma, input) {
  const source = input || {};
  const robotId = toStringOrNull(source.robotId);
  const refuse = (outcome, detail) => ({
    written: false,
    outcome,
    provenance: null,
    agentRowId: null,
    observedAtMs: null,
    detail: detail || null,
  });

  if (!robotId) return refuse(OUTCOME.AGENT_NOT_PROJECTED, "no robotId");

  const lat = source.lat;
  const lon = source.lon;
  if (typeof lat !== "number" || !Number.isFinite(lat) || typeof lon !== "number" || !Number.isFinite(lon)) {
    return refuse(OUTCOME.NO_REPORTED_POSITION);
  }

  const observedAtMs = source.agentTimestampMs;
  if (typeof observedAtMs !== "number" || !Number.isFinite(observedAtMs) || observedAtMs <= 0) {
    return refuse(
      OUTCOME.NO_AGENT_TIMESTAMP,
      "the frame carried no agent-measured `timestamp`; §2.7 forbids substituting the server's receipt time",
    );
  }

  const nowMs = Date.now();

  // P2B-2 — §10.6's skew bound, applied to the agent's clock. A measurement cannot be taken
  // after it was received; one stamped beyond the bound is refused, never clamped (clamping
  // would be the server inventing the measurement instant).
  const skewMs = Number.isFinite(source.maxClockSkewMs) ? source.maxClockSkewMs : maxClockSkewMsFrom(null);
  if (!Number.isFinite(skewMs)) {
    return refuse(OUTCOME.CLOCK_AHEAD, "no time.max_clock_skew bound is available; an unbounded agent clock is not admitted");
  }
  if (observedAtMs > nowMs + skewMs) {
    return refuse(OUTCOME.CLOCK_AHEAD, `observedAt ${observedAtMs} is ${observedAtMs - nowMs} ms ahead of the server (bound ${skewMs} ms)`);
  }

  // P2B-2 — the contract's optional fix-quality block. Absent, nothing changes. A declared
  // NO_FIX means the lat/lon are not a measurement; a horizontal accuracy becomes the
  // Observation's uncertainty radius.
  //
  // C4 — a block that is present but does not declare a recognised quality is refused, the
  // same way NO_FIX is: no Observation, so it reaches no arrival, completion or custody
  // evidence. Before, it fell through as an ordinary measured fix with no fixType, which is
  // indistinguishable from a frame that sent no block at all. Unknown stays unknown.
  const fix = source.fix === undefined || source.fix === null ? null : source.fix;
  const fixProblem = fix === null ? null : fixBlockProblem(fix);
  if (fixProblem) return refuse(OUTCOME.INVALID_OBSERVATION, fixProblem);
  if (fix && fix.fixType === "NO_FIX") return refuse(OUTCOME.NO_FIX_DECLARED);
  const uncertaintyRadiusM =
    fix && FIX_TYPES.includes(fix.fixType) && Number.isFinite(fix.hAccM) && fix.hAccM > 0 ? fix.hAccM : null;
  // Gate 1 — the declared fix type travels with the position (F10's confidence mapping reads
  // it), and an agent-declared dead-reckoned position is stored as one (§2.7): extrapolation
  // is admissible for cost, never for a safety constraint.
  const fixType = fix && FIX_TYPES.includes(fix.fixType) ? fix.fixType : null;
  const deadReckoned = Boolean(fix && fix.deadReckoned === true);

  const binding = await resolveBinding(prisma, robotId, nowMs);
  if (!binding) return refuse(OUTCOME.AGENT_NOT_PROJECTED);
  if (binding.provenance !== PROVENANCE.PHYSICAL && binding.provenance !== PROVENANCE.SIMULATED) {
    return refuse(OUTCOME.PROVENANCE_UNDETERMINED);
  }

  const sequence = source.sequence === undefined ? null : source.sequence;
  const mark = await seedHighWaterMark(prisma, robotId, binding.agentRowId);

  // §2.7's ordering contract, asked of the module that owns it. `advancesSequence` answers
  // false for a candidate with no sequence at all, so it is consulted only when the agent
  // supplied one — an agent that sends none is ordered by `observedAt` below, and must not
  // be refused for declining an optional field.
  if (sequence !== null && mark.sequence !== null) {
    if (!observation.advancesSequence({ sequence }, { sequence: mark.sequence })) {
      return refuse(OUTCOME.STALE_SEQUENCE, `sequence ${sequence} does not advance ${mark.sequence}`);
    }
  }

  // Equal instants are refused as well as earlier ones: two frames stamped the same
  // millisecond carry no evidence that the second is newer, and admitting both would let
  // the index's `orderBy observedAt desc` pick between them by physical row order.
  if (mark.observedAtMs !== null && observedAtMs <= mark.observedAtMs) {
    return refuse(OUTCOME.STALE_OBSERVED_AT, `observedAt ${observedAtMs} is not after ${mark.observedAtMs}`);
  }

  let record;
  try {
    record = observation.createObservation({
      agentId: binding.agentRowId,
      kind: POSITION_KIND,
      value: { lat, lon, provenance: binding.provenance, ...(fixType ? { fixType } : {}) },
      observedAt: observedAtMs,
      deadReckoned,
      // §23.5 makes an agent report untrusted input; `AGENT_REPORT` is what it is, for a
      // simulated agent exactly as for a physical one. The two are told apart by
      // `value.provenance`, not by a sixth source the specification does not define.
      source: observation.OBSERVATION_SOURCE.AGENT_REPORT,
      sequence,
      uncertaintyRadiusM,
    });
  } catch (error) {
    return refuse(OUTCOME.INVALID_OBSERVATION, error && error.message);
  }

  await prisma.observation.create({
    data: {
      agentId: record.agentId,
      kind: record.kind,
      value: record.value,
      observedAt: record.observedAt,
      source: record.source,
      // `receivedAt` is deliberately left to the column's `@default(now())`. It is "when
      // the server accepted it", which is what the database's clock is authoritative for,
      // and passing the null `createObservation` returns for an unspecified value would be
      // writing over a non-nullable column.
      sequence: record.sequence,
      deadReckoned: record.deadReckoned,
      ...(record.uncertaintyRadiusM === null ? {} : { uncertaintyRadiusM: record.uncertaintyRadiusM }),
    },
  });

  highWaterMarks.set(robotId, { observedAtMs, sequence: sequence === null ? mark.sequence : sequence });
  capped(highWaterMarks);

  return {
    written: true,
    outcome: OUTCOME.WRITTEN,
    provenance: binding.provenance,
    agentRowId: binding.agentRowId,
    observedAtMs,
    detail: null,
  };
}

/**
 * Is this stored Observation admissible as **physical** evidence?
 *
 * Stated as a function so a gate asks the question rather than remembering the encoding,
 * on the same argument `observation.isAdmissibleFor` is stated that way. Strictly
 * positive: anything that is not explicitly `PHYSICAL` — a simulated row, a row from
 * before this writer existed, a row whose `value` is not an object — is **not** physical
 * evidence. An absent label is not a physical one.
 *
 * @param {{ value?: unknown }|null|undefined} row an `Observation` row as stored
 * @returns {boolean}
 */
function isPhysicalEvidence(row) {
  const value = row && row.value;
  if (!value || typeof value !== "object") return false;
  return value.provenance === PROVENANCE.PHYSICAL;
}

/**
 * Is this stored Observation simulator output?
 *
 * The complement of `isPhysicalEvidence` only for rows this writer produced; a row with no
 * provenance at all is neither, which is the honest answer for a row nobody labelled.
 *
 * @param {{ value?: unknown }|null|undefined} row
 * @returns {boolean}
 */
function isSimulatedEvidence(row) {
  const value = row && row.value;
  if (!value || typeof value !== "object") return false;
  return value.provenance === PROVENANCE.SIMULATED;
}

/**
 * Drop everything remembered about one robot: its resolved binding and its ordering
 * high-water mark.
 *
 * Called from `robots.controller.deleteRobot`, beside `robotStateCache.del`, because
 * decommissioning is the one event that invalidates both. The binding would expire on its
 * own TTL; **the high-water mark would not**, so a `robotId` re-commissioned after a
 * decommission would be measured against the previous unit's newest timestamp and have its
 * telemetry refused until it overtook a mark belonging to a robot that no longer exists.
 *
 * @param {string} robotId
 */
function forget(robotId) {
  bindings.delete(robotId);
  highWaterMarks.delete(robotId);
}

/** Test seam — both per-process maps are module state, and a test needs them clean. */
function resetPositionObservationState() {
  bindings.clear();
  highWaterMarks.clear();
}

/**
 * P2B-2 — the provenance of the evidence a robot's reports constitute, for another writer of
 * that robot's reports (the reported-SoC writer). The same binding this module resolves for
 * its own writes, so there is still exactly one place outside the allow-listed policy that
 * asks the question, and it asks `simulationPolicy`.
 *
 * @param {object} prisma
 * @param {string} robotId
 * @returns {Promise<string|null>} `PHYSICAL`, `SIMULATED`, or null when undeterminable
 */
async function provenanceOf(prisma, robotId) {
  const code = toStringOrNull(robotId);
  if (!code) return null;
  const binding = await resolveBinding(prisma, code, Date.now());
  return binding ? binding.provenance : null;
}

module.exports = {
  POSITION_KIND,
  FIX_TYPES,
  MAX_CLOCK_SKEW_PARAMETER,
  maxClockSkewMsFrom,
  provenanceOf,
  PROVENANCE,
  OUTCOME,
  BINDING_TTL_MS,
  agentTimestampFrom,
  sequenceFrom,
  recordPositionObservation,
  isPhysicalEvidence,
  isSimulatedEvidence,
  forget,
  resetPositionObservationState,
};

"use strict";

/**
 * The **DEVELOPMENT SIMULATION** Charging Scheduler (§14.7) — the publishing half.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS NOT
 * ══════════════════════════════════════════════════════════════════════════════
 * §1.6 puts the Charging Scheduler **outside the assignment engine's boundary**, and
 * blocking decision B2 records that "a conformant publisher must be built or stubbed".
 * This module is a **development publisher for the simulated fleet only**. It is stated
 * here, once, in the terms the rest of the programme uses:
 *
 *   * It is **not physical charger evidence.** No row this module writes describes a
 *     charger anybody has installed, powered, metered or surveyed.
 *   * It does **not** establish production charger readiness, charger availability,
 *     Safety approval, or any of V1's stop conditions S-3 … S-7. It closes none of them
 *     and is not offered as progress against any of them.
 *   * It does **not** calibrate anything. No β coefficient, no state of health, no κ, no
 *     rated power measurement is produced or implied by running it.
 *   * `sim:fidelity` stays `NOT_MEASURED`. Agreement between this scheduler and the
 *     simulated agent is coherence between two halves of one program, which §24.4's gate
 *     is explicitly not about.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * SCOPE — who this scheduler may act on, and why it cannot reach a physical unit
 * ══════════════════════════════════════════════════════════════════════════════
 * This module **never reads `Robot.simulated`**, and that is deliberate rather than
 * incidental. `tests/engine/simulationBoundary.test.js` holds an exact allow-list of the
 * files permitted to read the discriminator, and its own header forbids the obvious
 * workaround: *"writing the same code without a token this detector matches would leave a
 * reader of the discriminator that the allow-list does not know about, which is worse than
 * a listed one."*
 *
 * So scope is not re-derived here. It is **inherited** from the one gate that already
 * owns it:
 *
 *     SimulationEngine.addRobot()
 *       → simulationPolicy.maySpawnVirtualRobot(row)      ← reads the discriminator
 *       → a VirtualRobot exists  ⟹  the row is simulated
 *
 * Every entry point below is driven by `SimulationEngine` on behalf of a `VirtualRobot`
 * it manages, and a `VirtualRobot` exists only for a row the database itself says is
 * simulated. There is no socket event, no HTTP route and no queue through which a
 * physical agent can reach this scheduler, because there is no *inbound* request path at
 * all — the only callers are in-process and hold the roster.
 *
 * The read side (`services/chargingStatus.service.js`) inherits the same scope, as an
 * injected `inScope` predicate rather than as a database flag it re-reads.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT IT PUBLISHES INTO — the existing schema, nothing new
 * ══════════════════════════════════════════════════════════════════════════════
 * No model, column, migration, enum or vocabulary is added by this batch. Three existing
 * tables carry everything:
 *
 *   | Fact                              | Where it lives                                  |
 *   |-----------------------------------|-------------------------------------------------|
 *   | the charger itself                | `Charger` (§5.2)                                |
 *   | plug capacity + reservable window | `ChargerAvailabilityProjection.payload` (§14.5)  |
 *   | queue position and plug occupancy | `ChargerReservation.state` (§14.7)              |
 *   | the target SoC in force           | `ChargerReservation.targetSoc` (§14.6)          |
 *
 * `ChargerAvailabilityProjection` is the Scheduler's **own** published artefact —
 * versioned, immutable, and carrying `publishedBy`, which is where this scheduler names
 * itself as a development publisher. That column already exists for exactly this purpose;
 * a new `Charger.simulated` boolean was considered and rejected, because
 * `tests/engine/energySchema.test.js` asserts the Phase 7 migration's `CREATE TABLE
 * "Charger"` block is byte-identical to Prisma's generation from the model, so any column
 * added here would have forced an edit to a structural test in order to accommodate this
 * batch. Reusing a column that already means the right thing is strictly better than
 * adding one and weakening the check that would have caught it.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * DETERMINISM
 * ══════════════════════════════════════════════════════════════════════════════
 * No `Math.random()`, and no clock read anywhere in this file: every entry point takes
 * `nowMs`. FIFO order is `(reservedFrom, reservationId)` — a total order over durable
 * columns, so two processes reading the same queue promote the same robot. The charging
 * *duration* is not decided here at all; it is the protected `engine/energy/chargeCurve`
 * integral, evaluated by the agent.
 */

const chargeCurve = require("../engine/energy/chargeCurve");
const {
  CHARGE_POWER_CURVE,
  CHARGE_CHARGER_CLASS,
  CHARGE_CURVE_INTEGRATION_STEPS,
  PACK_NOMINAL_WH,
} = require("./constants");

/**
 * The development declaration for the simulated fleet's ONE charger, as a frozen record.
 *
 * ── P7-D3 Step 0 (owner decision, 2026-10-10): the depot IS the simulated fleet's charger ──
 * Until this decision the scheduler declared its own charger, `DEV-SIM-RNSIT-MBA-01`
 * (centroid of OSM way/204638943, `isDepot: false`), while the V1 demonstration seeds a
 * depot, `V1DEMO-DEPOT-01` (`isDepot: true`, no plugs, no reservations). §14.5's
 * `E_return` therefore priced every return to the depot — the only admissible target under
 * the DEPOT_ONLY fallback, and not even covered by this scheduler's projection under the
 * pinned basis — while the simulator reserved the other charger. The owner chose Option B
 * of the P7-D3 audit: one charger, the depot, shared by the engine and the simulator.
 *
 * ── What this record declares, and what it deliberately does not ──────────
 *   * `chargerId` — the depot's business id, the same one `tools/demo/seedV1Demonstration.js`
 *     and `tools/deploy/bootstrapV1Environment.js` create. The ROW is theirs: this module
 *     reads it and never creates or writes it (`provision`), so the depot's region, cell,
 *     coordinate and `isDepot` are exactly what the seed declared. No location is stated
 *     here at all.
 *   * `plugCount` — the owner's development decision: three simultaneous plugs. It is a
 *     simulation capacity, published only in this scheduler's own projection, and asserts
 *     nothing about installed hardware.
 *   * `chargerClass` — `STANDARD`, the only class `simulation/constants.CHARGE_POWER_CURVE`
 *     characterises. `provision` refuses a depot row of any other class rather than
 *     charging on a curve nobody declared for it.
 *   * `ratedPowerW` — **deliberately null.** A nameplate rating is a measured fact about
 *     installed hardware and nobody has supplied one.
 *   * Nothing here says the depot is physically installed, powered, metered, surveyed or
 *     commissioned; the projection's `evidence` block says the opposite, in the durable row.
 *
 * @structural the owner's development charger declaration, not a tunable
 */
const DEVELOPMENT_CHARGER = Object.freeze({
  chargerId: "V1DEMO-DEPOT-01",
  name: "V1 demonstration depot — the simulated fleet's development charger",
  chargerClass: CHARGE_CHARGER_CLASS,
  plugCount: 3,
  ratedPowerW: null,
  locationProvenance:
    "the V1 demonstration depot row's own coordinate (tools/demo/seedV1Demonstration.js, " +
    "tools/deploy/bootstrapV1Environment.js) — NOT a surveyed charger position",
});

/**
 * Chargers this scheduler declared before the P7-D3 Step 0 decision. Reservations still live
 * at one of them are released as `CHARGER_SUPERSEDED` (`reconcile`, `requestPlug`): left
 * alone, the agent-wide "already holds a live reservation" check would keep returning the old
 * charger, and no pass scoped to the declared charger would ever expire it. The rows
 * themselves are left in place — deleting a charger is not this module's to do.
 * @structural the superseded development estate, by business id
 */
const SUPERSEDED_CHARGER_IDS = Object.freeze(["DEV-SIM-RNSIT-MBA-01"]);

/**
 * The value written to `ChargerAvailabilityProjection.publishedBy`.
 *
 * This is the structural statement that the estate this projection describes is
 * development simulation configuration. A reader that wants to know whether a charger is
 * backed by physical evidence asks who published its availability, and the answer for
 * every charger in this projection is "a development simulator".
 *
 * @structural the publisher's own identity, not a tunable
 */
const PUBLISHER = "development-simulation-charging-scheduler";

/**
 * The three states a reservation moves through, and the two that hold a live claim.
 *
 * `ACTIVE` is the schema's own default and already means "the agent holds this charger"
 * to `diagnostics.controller`, so it keeps that meaning: a plug is occupied. `QUEUED` and
 * `RELEASED` are added *as values of the existing `state` column* — no enum, no column,
 * no migration.
 *
 * @structural the reservation lifecycle, not a tunable
 */
const RESERVATION_STATE = Object.freeze({
  QUEUED: "QUEUED",
  ACTIVE: "ACTIVE",
  RELEASED: "RELEASED",
});

/** The states that occupy the agent — it may not be offered work in either. */
const LIVE_STATES = Object.freeze([RESERVATION_STATE.QUEUED, RESERVATION_STATE.ACTIVE]);

/**
 * Why a reservation ended. Recorded in `externalId` — the column §14.7 gives the
 * Scheduler for "the Scheduler's own identifier", which is the only free text this table
 * offers and is the Scheduler's to spend.
 *
 * @structural the release reasons, not tunables
 */
const RELEASE_REASON = Object.freeze({
  TARGET_REACHED: "TARGET_REACHED",
  AGENT_RELEASED: "AGENT_RELEASED",
  STALE_EXPIRED: "STALE_EXPIRED",
  DEREGISTERED: "DEREGISTERED",
  /** P7-D3 Step 0 — held at a charger this scheduler no longer declares (`SUPERSEDED_CHARGER_IDS`). */
  CHARGER_SUPERSEDED: "CHARGER_SUPERSEDED",
});

/**
 * P7-D3 Step 2 — why a restarted agent may not adopt the live reservation it finds
 * (`reservationForRecovery`). Every one is a refusal: the agent charges on nothing, drives to
 * nothing, and the row is left for the pass that owns it (`reconcile` expires and supersedes).
 * @structural the recovery refusals, not tunables
 */
const RECOVERY_REFUSAL = Object.freeze({
  /** The window has closed (`reservedUntil` is not after now); `reconcile` releases it. */
  EXPIRED: "EXPIRED",
  /** At a charger in `SUPERSEDED_CHARGER_IDS`; `reconcile` and `requestPlug` release it. */
  SUPERSEDED_CHARGER: "SUPERSEDED_CHARGER",
  /** At no charger, or one this scheduler neither declares nor supersedes. Not this module's to release. */
  FOREIGN_CHARGER: "FOREIGN_CHARGER",
  /** The declared depot row is absent or fails `depotProblems`. */
  CHARGER_UNUSABLE: "CHARGER_UNUSABLE",
  /** More than one live row for the agent — never chosen between. */
  MULTIPLE_LIVE: "MULTIPLE_LIVE",
  /** The row's window or target is not a value this scheduler writes. */
  MALFORMED: "MALFORMED",
  /** The reservation or charger could not be read. */
  UNREADABLE: "UNREADABLE",
});

/**
 * The longest a single session could legitimately occupy a plug, **derived from the
 * declared curve rather than chosen.**
 *
 * A reservation window has to be finite: an ACTIVE row with no end is a plug that leaks
 * when a process dies mid-session, and `reconcile()` needs a bound to expire against. But
 * a hand-picked timeout would be a behavioural constant nobody registered, and picking it
 * too short would evict a charging robot.
 *
 * So it is computed, once, as the worst case the declared inputs admit: a full 0 → 100 %
 * charge at the **coldest temperature the declared derating table covers**, where the
 * derating factor is at its minimum and the charge therefore takes longest. Every input
 * is `simulation/constants`' own, and the integral is the protected
 * `engine/energy/chargeCurve` — the same one the agent charges on, so the bound cannot
 * drift away from the behaviour it bounds.
 *
 * If the curve refuses (a configuration gap), this returns `null` and `requestPlug`
 * refuses to enqueue rather than inventing a window. That is the fail-closed direction:
 * a scheduler that cannot say when a plug is due back is a scheduler that should not be
 * handing plugs out.
 *
 * @param {number} packNominalWh the pack a full charge is measured against
 * @returns {{ ok: boolean, seconds: number|null, tempC: number|null, missing: string[] }}
 */
function sessionHorizonSeconds(packNominalWh) {
  const table = CHARGE_POWER_CURVE.temperatureDerating;
  if (!Array.isArray(table) || table.length === 0) {
    return { ok: false, seconds: null, tempC: null, missing: ["chargePowerCurve.temperatureDerating"] };
  }
  // The declared point with the smallest derating factor — the slowest charge the table
  // admits. Ties break on the lower temperature so the choice is total and reproducible.
  const worst = table.reduce((slowest, point) => {
    if (!slowest) return point;
    if (point.y < slowest.y) return point;
    if (point.y === slowest.y && point.x < slowest.x) return point;
    return slowest;
  }, null);

  const integrated = chargeCurve.timeToChargeSeconds({
    curve: CHARGE_POWER_CURVE,
    fromSoc: 0,
    toSoc: 1,
    tempC: worst.x,
    chargerClass: DEVELOPMENT_CHARGER.chargerClass,
    packUsableWh: packNominalWh,
    steps: CHARGE_CURVE_INTEGRATION_STEPS,
  });

  if (!integrated.ok || !(integrated.seconds > 0)) {
    return { ok: false, seconds: null, tempC: worst.x, missing: integrated.missing || [] };
  }
  return { ok: true, seconds: Math.ceil(integrated.seconds), tempC: worst.x, missing: [] };
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Is this Prisma declining an insert because the row already exists?
 *
 * Narrow on purpose: `P2002` is the unique-constraint code, and a broader match would
 * swallow a foreign-key or check-constraint rejection as though it were a duplicate. The
 * message fallback exists because a `$queryRaw` path surfaces the SQLSTATE rather than the
 * Prisma code.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isUniqueViolation(error) {
  if (!error) return false;
  if (error.code === "P2002" || error.code === "23505") return true;
  return typeof error.message === "string" && /unique constraint/i.test(error.message);
}

/**
 * Run one serializable transaction, turning PostgreSQL's refusal to serialise it into a
 * **result** rather than an exception.
 *
 * ── Found on a live database, and only there ────────────────────────────────
 * The in-memory store the unit suite uses runs its callback against the same object, so
 * every "concurrent" request in jest actually ran to completion one after another. Against
 * real PostgreSQL, five simultaneous `requestPlug` calls produced `40001` — "could not
 * serialize access" — and this module let it escape as a crash. Concurrency was the one
 * thing that path existed to handle, and it was the one thing no test could reach.
 *
 * ── Why this reports rather than retries ────────────────────────────────────
 * `db/prisma.runSerializable` states the rule for this codebase: it "deliberately performs
 * **no retry**. A retry loop here would need a bound, and a bound is a behavioural constant
 * that would have to be registered, owned, and calibrated (§22.1)." The same reasoning
 * applies one layer up, so a serialisation failure is returned as `retryable: true` and the
 * caller decides. The caller is a simulated agent's tick, which asks again on its next tick
 * — a bounded, observable retry that belongs to the agent rather than a hidden loop here.
 *
 * `isSerializationFailure` is **injected** for the same reason `runSerializable` is: no
 * module under `src/simulation/` may import a database dependency, and
 * `tests/engine/simulationBoundary.test.js` holds that structurally. Absent, a
 * serialisation failure is simply rethrown — the honest degradation, since this module
 * then cannot tell one apart from any other error and must not guess.
 *
 * @param {object} deps `{ prisma, runSerializable, isSerializationFailure }`
 * @param {(tx: object) => Promise<*>} fn
 * @param {object} onConflict the result to return when the transaction could not serialise
 * @returns {Promise<*>}
 */
async function serialized(deps, fn, onConflict) {
  try {
    return await deps.runSerializable(deps.prisma, fn);
  } catch (error) {
    const detects = typeof deps.isSerializationFailure === "function" ? deps.isSerializationFailure : null;
    // Prisma wraps `40001` as P2034 with its own message, so the injected SQLSTATE check is
    // paired with the client's own code. Both are narrow: anything else is a real error and
    // is rethrown rather than reported as a conflict somebody can retry past.
    const conflicted =
      (detects && detects(error)) ||
      error.code === "P2034" ||
      (typeof error.message === "string" && /write conflict or a deadlock|could not serialize/i.test(error.message));
    if (!conflicted) throw error;
    return { ...onConflict, retryable: true, problems: [`the transaction could not be serialised: ${error.message}`] };
  }
}

/**
 * The reservation's durable identifier — deterministic, so a retry cannot mint a second
 * one for the same logical session.
 *
 * `reservationId` is `@unique`, so this is the database-level backstop behind the
 * in-transaction "does this agent already hold a live reservation" check: even if two
 * callers somehow raced past that check, only one `INSERT` survives. The ordinal is the
 * count of reservations this agent has already had at this charger, which makes a *new*
 * session after a completed one a genuinely new id rather than a collision.
 *
 * @param {string} agentRowId `Agent.id`
 * @param {number} ordinal
 * @returns {string}
 */
function reservationIdFor(agentRowId, ordinal) {
  return `${DEVELOPMENT_CHARGER.chargerId}:${agentRowId}:${ordinal}`;
}

/**
 * Why the depot row cannot be charged at, or `[]` when it can.
 *
 * Each condition is one the engine or the simulator depends on: the engine's DEPOT_ONLY
 * `E_return` admits only `isDepot` rows (so a non-depot would not be the engine's target),
 * `chargerCandidatesFor` routes only to a row with a cell, P7-C1 prices the return to the
 * row's own coordinate, and the charge curve is declared only for `STANDARD`.
 *
 * @param {object|null} charger the `Charger` row, or null
 * @returns {string[]}
 */
function depotProblems(charger) {
  const id = DEVELOPMENT_CHARGER.chargerId;
  if (!charger) {
    return [
      `charger "${id}" is not declared in this deployment. It is the V1 demonstration depot, created by ` +
        "tools/demo/seedV1Demonstration.js or tools/deploy/bootstrapV1Environment.js; this scheduler reads it " +
        "and never creates it, so no plug is granted until it exists",
    ];
  }
  const problems = [];
  if (charger.isDepot !== true) {
    problems.push(`charger "${id}" is not a depot, so the engine's DEPOT_ONLY return target would not be the charger the simulator reserves`);
  }
  if (!isNumber(charger.latitude) || !isNumber(charger.longitude)) {
    problems.push(`charger "${id}" states no coordinate, and this scheduler does not invent one`);
  }
  if (typeof charger.cellId !== "string" || charger.cellId === "") {
    problems.push(`charger "${id}" states no cell, so the engine cannot route a return to it (§20.3 item 3)`);
  }
  if (charger.chargerClass !== DEVELOPMENT_CHARGER.chargerClass) {
    problems.push(
      `charger "${id}" is class "${String(charger.chargerClass)}", but the simulator's charge curve is declared only for ` +
        `"${DEVELOPMENT_CHARGER.chargerClass}"`,
    );
  }
  return problems;
}

/**
 * Read the depot row, and publish the projection that declares its development plug capacity.
 *
 * P7-D3 Step 0: the row is the V1 seed's and is never created or written here (see
 * `DEVELOPMENT_CHARGER`). Running this twice publishes a second projection **only** when the
 * declared estate has actually changed — the
 * projection table is documented as insert-only and immutable ("rows are inserted, never
 * updated"), so republishing an identical payload on every boot would be version churn
 * that makes the version meaningless as a cache key (§20.3 item 3).
 *
 * @param {object} deps `{ prisma }`
 * @param {{ nowMs: number }} input
 * @returns {Promise<{ ok: boolean, chargerDbId: string|null, projectionVersion: number|null,
 *                     published: boolean, problems: string[] }>}
 */
async function provision(deps, input) {
  const prisma = deps && deps.prisma;
  const nowMs = input && input.nowMs;
  if (!prisma) return { ok: false, chargerDbId: null, projectionVersion: null, published: false, problems: ["no prisma client"] };
  if (!isNumber(nowMs)) {
    return { ok: false, chargerDbId: null, projectionVersion: null, published: false, problems: ["nowMs is required — this module reads no clock"] };
  }

  const horizon = sessionHorizonSeconds(PACK_NOMINAL_WH);
  if (!horizon.ok) {
    return {
      ok: false,
      chargerDbId: null,
      projectionVersion: null,
      published: false,
      problems: [
        "the declared charge curve does not admit a full-charge duration, so no reservable window can be " +
          `stated: ${horizon.missing.join(", ")}`,
      ],
    };
  }

  // P7-D3 Step 0 — the depot row is the V1 seed's, read and never written. A depot that is
  // absent, not a depot, unplaced or of an uncharacterised class is refused by name, and no
  // projection is published, so no plug is granted: the scheduler must not invent a charger,
  // a coordinate or a cell, and must not charge at a row the engine would not return to.
  const charger = await prisma.charger.findUnique({ where: { chargerId: DEVELOPMENT_CHARGER.chargerId } });
  const unusable = depotProblems(charger);
  if (unusable.length > 0) {
    return { ok: false, chargerDbId: charger ? charger.id : null, projectionVersion: null, published: false, problems: unusable };
  }

  const payload = projectionPayload({ nowMs, horizonSeconds: horizon.seconds, charger });

  const latest = await prisma.chargerAvailabilityProjection.findFirst({
    where: { publishedBy: PUBLISHER },
    orderBy: { version: "desc" },
  });

  // "Changed" compares only the declared estate — the charger set and its capacity — not
  // the horizon's end instant, which moves with every boot and would otherwise publish a
  // new version on each restart.
  const unchanged =
    latest &&
    JSON.stringify(estateOf(latest.payload)) === JSON.stringify(estateOf(payload));

  if (unchanged) {
    return { ok: true, chargerDbId: charger.id, projectionVersion: latest.version, published: false, problems: [] };
  }

  const highest = await prisma.chargerAvailabilityProjection.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
  const version = (highest ? highest.version : 0) + 1;

  await prisma.chargerAvailabilityProjection.create({
    data: {
      version,
      publishedAt: new Date(nowMs),
      publishedBy: PUBLISHER,
      horizonEnd: new Date(nowMs + horizon.seconds * 1000), // @structural ms per second
      payload,
    },
  });

  return { ok: true, chargerDbId: charger.id, projectionVersion: version, published: true, problems: [] };
}

/**
 * The declared estate, for the change comparison above — the part of a payload that is a
 * statement about the world rather than about when it was published.
 *
 * @param {object} payload
 * @returns {object}
 */
function estateOf(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  return {
    publisher: source.publisher || null,
    chargers: (Array.isArray(source.chargers) ? source.chargers : []).map((entry) => ({
      chargerId: entry.chargerId,
      chargerClass: entry.chargerClass,
      plugCount: entry.plugCount,
      isDepot: entry.isDepot,
      latitude: entry.latitude,
      longitude: entry.longitude,
    })),
  };
}

/**
 * The projection payload — in `chargingSchedulerClient.consumeProjection`'s own shape,
 * plus the one field this scheduler needs that §14.5's engine-side client does not read.
 *
 * `plugCount` rides on the charger entry rather than in a table column because the
 * projection *is* the Scheduler's published statement about per-charger reservable
 * capacity, which is precisely what a plug count is. `consumeProjection` ignores unknown
 * fields, so nothing on the engine side changes shape.
 *
 * The `evidence` block states, inside the durable artefact itself, what the artefact is
 * not. A reader who finds this projection in a database months from now should not have
 * to locate this file to learn that.
 *
 * P7-D3 Step 0: the charger entry's identity, coordinate and `isDepot` are the depot row's
 * own (`input.charger`), so the projection cannot disagree with the row the engine reads;
 * only the development plug count and the reservable window are this scheduler's.
 *
 * @param {{ nowMs: number, horizonSeconds: number, charger: object }} input
 * @returns {object}
 */
function projectionPayload(input) {
  const untilMs = input.nowMs + input.horizonSeconds * 1000; // @structural ms per second
  return {
    publisher: PUBLISHER,
    evidence: {
      kind: "DEVELOPMENT_SIMULATION",
      physicalChargerEvidence: false,
      note:
        "Development simulation configuration. No charger described here is installed, powered, metered or " +
        "surveyed. This projection establishes no production charger readiness and discharges no V1 stop " +
        "condition (S-3 … S-7) and no Safety obligation.",
      locationProvenance: DEVELOPMENT_CHARGER.locationProvenance,
      ratedPowerW: null,
      ratedPowerNote:
        "no nameplate rating has been supplied by the owner; charge power is the declared P_charge(SoC) curve and " +
        "is a modelling input, not an equipment specification",
    },
    chargers: [
      {
        chargerId: input.charger.chargerId,
        chargerClass: input.charger.chargerClass,
        cellId: null,
        isDepot: input.charger.isDepot === true,
        latitude: input.charger.latitude,
        longitude: input.charger.longitude,
        plugCount: DEVELOPMENT_CHARGER.plugCount,
        intervals: [{ fromMs: input.nowMs, untilMs, state: "RESERVABLE" }],
      },
    ],
  };
}

/**
 * The plug capacity in force, read from the **published projection** rather than from the
 * module constant.
 *
 * Deliberately the durable artefact and not `DEVELOPMENT_CHARGER.plugCount`: the capacity
 * that governs is the one the Scheduler published, and reading the constant would mean a
 * running deployment silently changed capacity the moment somebody edited a source file.
 * Fail-closed — an unreadable or absent projection yields no capacity, and the caller
 * grants no plug.
 *
 * @param {object} deps `{ prisma }`
 * @returns {Promise<{ ok: boolean, plugCount: number|null, version: number|null, reason: string|null }>}
 */
async function publishedCapacity(deps) {
  const projection = await deps.prisma.chargerAvailabilityProjection.findFirst({
    where: { publishedBy: PUBLISHER },
    orderBy: { version: "desc" },
  });
  if (!projection) {
    return { ok: false, plugCount: null, version: null, reason: "no availability projection has been published by this scheduler" };
  }
  const payload = projection.payload && typeof projection.payload === "object" ? projection.payload : {};
  const entry = (Array.isArray(payload.chargers) ? payload.chargers : []).find(
    (charger) => charger && charger.chargerId === DEVELOPMENT_CHARGER.chargerId,
  );
  if (!entry || !Number.isInteger(entry.plugCount) || entry.plugCount < 0) {
    return {
      ok: false,
      plugCount: null,
      version: projection.version,
      reason: `projection version ${projection.version} states no plug count for ${DEVELOPMENT_CHARGER.chargerId}`,
    };
  }
  return { ok: true, plugCount: entry.plugCount, version: projection.version, reason: null };
}

/**
 * P7-D3 Step 0 — release the live reservations held at a superseded charger
 * (`SUPERSEDED_CHARGER_IDS`), optionally for one agent only.
 *
 * Each row is released by a conditional write on its own id and a live state, so two passes
 * racing over the same row release it once. The window is closed at the release instant, and
 * never at or before `reservedFrom` (the table's CHECK). The superseded charger rows are not
 * touched.
 *
 * @param {object} tx a transaction client
 * @param {{ agentId?: string }} scope
 * @param {number} nowMs
 * @returns {Promise<number>} how many reservations were released
 */
async function releaseSupersededReservations(tx, scope, nowMs) {
  const retired = await tx.charger.findMany({ where: { chargerId: { in: [...SUPERSEDED_CHARGER_IDS] } } });
  if (!Array.isArray(retired) || retired.length === 0) return 0;

  const live = await tx.chargerReservation.findMany({
    where: { ...(scope || {}), chargerDbId: { in: retired.map((row) => row.id) }, state: { in: LIVE_STATES } },
  });
  let released = 0;
  for (const row of live) {
    const fromMs = row.reservedFrom instanceof Date ? row.reservedFrom.getTime() : Date.parse(row.reservedFrom);
    // eslint-disable-next-line no-await-in-loop
    const result = await tx.chargerReservation.updateMany({
      where: { id: row.id, state: { in: LIVE_STATES } },
      data: {
        state: RESERVATION_STATE.RELEASED,
        externalId: RELEASE_REASON.CHARGER_SUPERSEDED,
        reservedUntil: new Date(Math.max(nowMs, (isNumber(fromMs) ? fromMs : nowMs) + 1)),
      },
    });
    released += result && isNumber(result.count) ? result.count : 0;
  }
  return released;
}

/**
 * The agent's live reservation, if it holds one. `null` is a definite "holds none" — the
 * caller must have established that the agent is in scope before reading this as "not
 * charging".
 *
 * @param {object} deps `{ prisma }`
 * @param {string} agentRowId
 * @returns {Promise<object|null>}
 */
async function liveReservationFor(deps, agentRowId) {
  return deps.prisma.chargerReservation.findFirst({
    where: { agentId: agentRowId, state: { in: LIVE_STATES } },
    orderBy: [{ reservedFrom: "asc" }, { reservationId: "asc" }],
  });
}

/**
 * P7-D3 Step 2 — the live reservation a restarted agent may adopt, or why it may not.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * A simulator restart rebuilds every agent IDLE, with no charging state. The reservation row
 * survives, and the engine keeps excluding the agent (F18 denies against its window), but an agent
 * above the critical level never asked for a plug again, so it neither drove to the charger nor
 * charged: it was stranded until the window expired (D3-3).
 *
 * ── What this is ────────────────────────────────────────────────────────────
 * A **read**: it writes nothing, takes no lock and grants nothing, so calling it any number of
 * times cannot create, extend, reorder or release a reservation. The agent's queue position, the
 * plug count and the window stay exactly what `requestPlug`/`promote` made them.
 *
 * ADOPTABLE only when ALL hold:
 *   · exactly one live (QUEUED or ACTIVE) row for the agent;
 *   · it is at the declared charger, and that row passes `depotProblems`;
 *   · its window is still open (`reservedUntil` after `nowMs`) and starts before it ends;
 *   · its `targetSoc` is null or a fraction in (0, 1].
 * Anything else is REFUSED by name (`RECOVERY_REFUSAL`) and the row is left alone: `reconcile`
 * expires a closed window and releases a superseded charger's rows; a foreign charger's row is not
 * this module's to release.
 *
 * @param {object} deps `{ prisma }`
 * @param {{ agentRowId: string, nowMs: number }} input
 * @returns {Promise<{ verdict: "NONE" }
 *   | { verdict: "ADOPTABLE", reservation: { reservationId: string, state: string, targetSoc: number|null,
 *       reservedFromMs: number, reservedUntilMs: number }, charger: { chargerId: string, lat: number, lon: number } }
 *   | { verdict: "REFUSED", refusal: string, reservationId: string|null, problems: string[] }>}
 */
async function reservationForRecovery(deps, input) {
  const source = input || {};
  const refuse = (refusal, problem, reservationId = null) =>
    Object.freeze({ verdict: "REFUSED", refusal, reservationId, problems: [problem] });
  if (!deps || !deps.prisma || typeof source.agentRowId !== "string" || source.agentRowId === "" || !isNumber(source.nowMs)) {
    return refuse(RECOVERY_REFUSAL.UNREADABLE, "prisma, agentRowId and nowMs are required");
  }

  let live;
  let depot;
  try {
    live = await deps.prisma.chargerReservation.findMany({
      where: { agentId: source.agentRowId, state: { in: LIVE_STATES } },
      orderBy: [{ reservedFrom: "asc" }, { reservationId: "asc" }],
    });
    depot = await deps.prisma.charger.findUnique({ where: { chargerId: DEVELOPMENT_CHARGER.chargerId } });
  } catch (error) {
    return refuse(RECOVERY_REFUSAL.UNREADABLE, `the reservation could not be read: ${error && error.message}`);
  }

  if (!Array.isArray(live) || live.length === 0) return Object.freeze({ verdict: "NONE" });
  if (live.length > 1) {
    return refuse(RECOVERY_REFUSAL.MULTIPLE_LIVE, `the agent holds ${live.length} live reservations (${live.map((row) => row.reservationId).join(", ")})`);
  }
  const row = live[0];

  const unusable = depotProblems(depot);
  if (unusable.length > 0) return refuse(RECOVERY_REFUSAL.CHARGER_UNUSABLE, unusable.join("; "), row.reservationId);

  if (row.chargerDbId !== depot.id) {
    let held = null;
    try {
      held = row.chargerDbId ? await deps.prisma.charger.findUnique({ where: { id: row.chargerDbId } }) : null;
    } catch (error) {
      return refuse(RECOVERY_REFUSAL.UNREADABLE, `the reserved charger could not be read: ${error && error.message}`, row.reservationId);
    }
    if (held && SUPERSEDED_CHARGER_IDS.includes(held.chargerId)) {
      return refuse(RECOVERY_REFUSAL.SUPERSEDED_CHARGER, `reserved at the superseded charger "${held.chargerId}"`, row.reservationId);
    }
    return refuse(
      RECOVERY_REFUSAL.FOREIGN_CHARGER,
      `reserved at ${held ? `charger "${held.chargerId}"` : "no charger (chargerDbId is unset or names no row)"}, which this scheduler does not declare`,
      row.reservationId,
    );
  }

  const fromMs = row.reservedFrom instanceof Date ? row.reservedFrom.getTime() : NaN;
  const untilMs = row.reservedUntil instanceof Date ? row.reservedUntil.getTime() : NaN;
  if (!isNumber(fromMs) || !isNumber(untilMs) || !(untilMs > fromMs)) {
    return refuse(RECOVERY_REFUSAL.MALFORMED, "the reservation's window is not a closed interval", row.reservationId);
  }
  if (!(untilMs > source.nowMs)) {
    return refuse(RECOVERY_REFUSAL.EXPIRED, `the reservation's window closed at ${new Date(untilMs).toISOString()}`, row.reservationId);
  }
  const targetSoc = row.targetSoc === null || row.targetSoc === undefined ? null : row.targetSoc;
  if (targetSoc !== null && !(isNumber(targetSoc) && targetSoc > 0 && targetSoc <= 1)) {
    return refuse(RECOVERY_REFUSAL.MALFORMED, `the reservation's targetSoc ${String(targetSoc)} is not a fraction in (0, 1]`, row.reservationId);
  }

  return Object.freeze({
    verdict: "ADOPTABLE",
    reservation: Object.freeze({ reservationId: row.reservationId, state: row.state, targetSoc, reservedFromMs: fromMs, reservedUntilMs: untilMs }),
    charger: Object.freeze({ chargerId: depot.chargerId, lat: depot.latitude, lon: depot.longitude }),
  });
}

/**
 * Ask for a plug. Idempotent, durable, and FIFO-fair.
 *
 * ── The three properties, and where each is enforced ────────────────────────
 *   1. **Idempotent.** A retry of the same logical request returns the reservation that
 *      already exists, with `created: false`. Enforced twice: by the in-transaction check
 *      for a live reservation, and — if two callers ever raced past it — by
 *      `reservationId`'s unique index.
 *   2. **At most `plugCount` charging.** Enforced by counting `ACTIVE` rows *inside* a
 *      SERIALIZABLE transaction that first takes a row lock on the charger, so the count
 *      and the insert cannot interleave with another caller's. The count is compared
 *      against the **published** capacity, never against a constant.
 *   3. **No starvation.** A request always enters the queue at the back
 *      (`reservedFrom = nowMs`) and promotion always takes the front
 *      (`ORDER BY reservedFrom, reservationId`). A later arrival can only be promoted
 *      ahead of an earlier one if the earlier one has left the queue.
 *
 * A request is **never** granted `ACTIVE` directly when the queue is non-empty, even if a
 * plug is free: that would let a new arrival overtake a waiting robot in the window
 * between a release and the next promotion. It is enqueued and then promoted by the same
 * ordering everybody else is subject to.
 *
 * @param {object} deps `{ prisma, runSerializable, selectForUpdate }`
 * @param {{ agentRowId: string, targetSoc: number|null, nowMs: number }} input
 * @returns {Promise<{ ok: boolean, created: boolean, reservation: object|null, problems: string[] }>}
 */
async function requestPlug(deps, input) {
  const source = input || {};
  const problems = [];
  if (!deps || !deps.prisma) problems.push("no prisma client");
  if (typeof source.agentRowId !== "string" || source.agentRowId === "") problems.push("agentRowId is required");
  if (!isNumber(source.nowMs)) problems.push("nowMs is required — this module reads no clock");
  if (problems.length > 0) return { ok: false, created: false, reservation: null, problems };

  const horizon = sessionHorizonSeconds(PACK_NOMINAL_WH);
  if (!horizon.ok) {
    return {
      ok: false,
      created: false,
      reservation: null,
      problems: [
        `no reservable window can be stated from the declared charge curve (${horizon.missing.join(", ")}), so no ` +
          "plug is granted. A reservation with no end is a plug that leaks when a process dies mid-session",
      ],
    };
  }

  const capacity = await publishedCapacity(deps);
  if (!capacity.ok) {
    return { ok: false, created: false, reservation: null, problems: [capacity.reason] };
  }

  const runSerializable = deps.runSerializable;
  const selectForUpdate = deps.selectForUpdate;
  if (typeof runSerializable !== "function" || typeof selectForUpdate !== "function") {
    return {
      ok: false,
      created: false,
      reservation: null,
      problems: ["runSerializable and selectForUpdate are required — the plug count cannot be enforced without them"],
    };
  }

  return serialized(deps, async (tx) => {
    // §10.3.2 step 1's "explicit row lock, not an optimistic read", on the charger: it is
    // the resource whose occupancy is being counted, so it is the row every concurrent
    // requester must queue behind.
    const charger = await tx.charger.findUnique({ where: { chargerId: DEVELOPMENT_CHARGER.chargerId } });
    if (!charger) {
      return { ok: false, created: false, reservation: null, problems: ["the development charger has not been provisioned"] };
    }
    await selectForUpdate(tx, "Charger", "id", charger.id);

    // P7-D3 Step 0 — a live reservation at a superseded charger is released first. Otherwise
    // the agent-wide check below would return it as this agent's plug, and the agent would
    // keep "holding" the old charger.
    await releaseSupersededReservations(tx, { agentId: source.agentRowId }, source.nowMs);

    const held = await tx.chargerReservation.findMany({
      where: { agentId: source.agentRowId, state: { in: LIVE_STATES } },
      orderBy: [{ reservedFrom: "asc" }, { reservationId: "asc" }],
    });
    // P7-D3 Step 2 — a live reservation at any other charger (one whose row was deleted, so
    // `chargerDbId` is null, or one this scheduler neither declares nor supersedes) is not this
    // agent's plug here. It used to be returned as "existing", so the agent drove to the depot and
    // drew current there without occupying a depot plug. It is neither adopted nor joined by a
    // second reservation; it is not this module's to release.
    const elsewhere = held.filter((row) => row.chargerDbId !== charger.id);
    if (elsewhere.length > 0) {
      return {
        ok: false,
        created: false,
        reservation: null,
        problems: [
          `the agent holds a live reservation (${elsewhere.map((row) => row.reservationId).join(", ")}) at a charger ` +
            `this scheduler does not declare; it is not adopted as a plug at ${DEVELOPMENT_CHARGER.chargerId}, and no ` +
            "second reservation is granted beside it",
        ],
      };
    }
    const existing = held[0] || null;
    if (existing) {
      return { ok: true, created: false, reservation: existing, problems: [] };
    }

    const ordinal = await tx.chargerReservation.count({
      where: { agentId: source.agentRowId, chargerDbId: charger.id },
    });

    try {
      const created = await tx.chargerReservation.create({
        data: {
          reservationId: reservationIdFor(source.agentRowId, ordinal),
          agentId: source.agentRowId,
          chargerDbId: charger.id,
          reservedFrom: new Date(source.nowMs),
          reservedUntil: new Date(source.nowMs + horizon.seconds * 1000), // @structural ms per second
          targetSoc: isNumber(source.targetSoc) ? source.targetSoc : null,
          state: RESERVATION_STATE.QUEUED,
          projectionVersion: capacity.version,
        },
      });
      return { ok: true, created: true, reservation: created, problems: [] };
    } catch (error) {
      // ── The unique index fired, and that is a SUCCESS, not a failure ─────────
      //
      // `reservationId` is `@unique` and derived deterministically, so two callers that
      // both got past the "does this agent already hold a live reservation" check above —
      // which is possible whenever the row lock does not actually serialise them — compute
      // the *same* id and only one `INSERT` survives. The loser has not failed to get a
      // plug; it has discovered that its own request already exists.
      //
      // Found by a test that issued five genuinely concurrent requests for one agent: the
      // index correctly prevented the duplicate row and the rejection then propagated as a
      // thrown error, so the caller saw a crash where the truth was "you are already in the
      // queue". A backstop whose firing is an unhandled exception is only half a backstop.
      //
      // Re-read rather than reconstructed: the surviving row is the authority on what the
      // reservation's window and target are, and the loser must adopt them rather than
      // report the values it would have written.
      if (!isUniqueViolation(error)) throw error;
      const winner = await tx.chargerReservation.findFirst({
        where: { agentId: source.agentRowId, state: { in: LIVE_STATES } },
        orderBy: [{ reservedFrom: "asc" }, { reservationId: "asc" }],
      });
      if (winner) return { ok: true, created: false, reservation: winner, problems: [] };
      // The unique index fired but no live row is visible — the winner was released
      // between the two statements. Nothing is invented here; the caller asks again.
      return {
        ok: false,
        created: false,
        reservation: null,
        problems: ["a concurrent request for this agent's reservation completed and was released; ask again"],
      };
    }
  }, { ok: false, created: false, reservation: null });
}

/**
 * One scheduling pass: fill every free plug from the front of the queue.
 *
 * Runs under the same charger row lock as `requestPlug`, so a promotion and a new arrival
 * cannot both decide that the same plug is free. The loop promotes at most
 * `plugCount − active` robots and re-reads nothing optimistically: the ACTIVE count is
 * taken once inside the lock and decremented as promotions are made.
 *
 * @param {object} deps `{ prisma, runSerializable, selectForUpdate }`
 * @param {{ nowMs: number }} input
 * @returns {Promise<{ ok: boolean, promoted: string[], active: number, queued: number,
 *                     plugCount: number|null, problems: string[] }>}
 */
async function promote(deps, input) {
  const nowMs = input && input.nowMs;
  if (!isNumber(nowMs)) {
    return { ok: false, promoted: [], active: 0, queued: 0, plugCount: null, problems: ["nowMs is required"] };
  }

  const capacity = await publishedCapacity(deps);
  if (!capacity.ok) {
    return { ok: false, promoted: [], active: 0, queued: 0, plugCount: null, problems: [capacity.reason] };
  }

  const horizon = sessionHorizonSeconds(PACK_NOMINAL_WH);
  if (!horizon.ok) {
    return { ok: false, promoted: [], active: 0, queued: 0, plugCount: capacity.plugCount, problems: ["no reservable window can be stated"] };
  }

  return serialized(deps, async (tx) => {
    const charger = await tx.charger.findUnique({ where: { chargerId: DEVELOPMENT_CHARGER.chargerId } });
    if (!charger) {
      return { ok: false, promoted: [], active: 0, queued: 0, plugCount: capacity.plugCount, problems: ["the development charger has not been provisioned"] };
    }
    await deps.selectForUpdate(tx, "Charger", "id", charger.id);

    let active = await tx.chargerReservation.count({
      where: { chargerDbId: charger.id, state: RESERVATION_STATE.ACTIVE },
    });

    const free = capacity.plugCount - active;
    const promoted = [];

    if (free > 0) {
      // FIFO: the longest-waiting first. `reservationId` breaks ties so the order is
      // total — two rows sharing a millisecond must still have one answer, and without
      // the tiebreak the database is free to return either.
      const waiting = await tx.chargerReservation.findMany({
        where: { chargerDbId: charger.id, state: RESERVATION_STATE.QUEUED },
        orderBy: [{ reservedFrom: "asc" }, { reservationId: "asc" }],
        take: free,
      });

      for (const reservation of waiting) {
        // eslint-disable-next-line no-await-in-loop
        await tx.chargerReservation.update({
          where: { id: reservation.id },
          data: {
            state: RESERVATION_STATE.ACTIVE,
            // The session's own window starts when current begins to flow. `reservedFrom`
            // is left at the *enqueue* instant deliberately: it is the FIFO key and the
            // durable record of how long this robot waited, and overwriting it would erase
            // the evidence that the queue was fair.
            reservedUntil: new Date(nowMs + horizon.seconds * 1000), // @structural ms per second
          },
        });
        promoted.push(reservation.agentId);
        active += 1;
      }
    }

    const queued = await tx.chargerReservation.count({
      where: { chargerDbId: charger.id, state: RESERVATION_STATE.QUEUED },
    });

    return { ok: true, promoted, active, queued, plugCount: capacity.plugCount, problems: [] };
  }, { ok: false, promoted: [], active: 0, queued: 0, plugCount: capacity.plugCount });
}

/**
 * Release the agent's live reservation, freeing its plug, and immediately fill the plug
 * from the front of the queue.
 *
 * Idempotent: an agent with no live reservation is not an error, it is a release that has
 * already happened. Releasing is the **only** way a plug is freed, which is what makes
 * "charging completion releases the plug" a property of one code path rather than of
 * several that must agree.
 *
 * @param {object} deps `{ prisma, runSerializable, selectForUpdate }`
 * @param {{ agentRowId: string, nowMs: number, reason?: string }} input
 * @returns {Promise<{ ok: boolean, released: boolean, promoted: string[], problems: string[] }>}
 */
async function release(deps, input) {
  const source = input || {};
  if (typeof source.agentRowId !== "string" || source.agentRowId === "" || !isNumber(source.nowMs)) {
    return { ok: false, released: false, promoted: [], problems: ["agentRowId and nowMs are required"] };
  }
  const reason = Object.values(RELEASE_REASON).includes(source.reason) ? source.reason : RELEASE_REASON.AGENT_RELEASED;

  const releaseOutcome = await serialized(deps, async (tx) => {
    const charger = await tx.charger.findUnique({ where: { chargerId: DEVELOPMENT_CHARGER.chargerId } });
    if (!charger) return false;
    await deps.selectForUpdate(tx, "Charger", "id", charger.id);

    const live = await tx.chargerReservation.findMany({
      where: { agentId: source.agentRowId, chargerDbId: charger.id, state: { in: LIVE_STATES } },
    });
    if (live.length === 0) return false;

    await tx.chargerReservation.updateMany({
      where: { id: { in: live.map((entry) => entry.id) } },
      data: {
        state: RESERVATION_STATE.RELEASED,
        // The window is closed at the release instant, so a released row can never be
        // read as still occupying the plug by anything that looks at the interval rather
        // than the state. `reservedUntil > reservedFrom` is a CHECK constraint, so a
        // release in the same millisecond as the request still has to advance by one.
        reservedUntil: new Date(Math.max(source.nowMs, live[0].reservedFrom.getTime() + 1)),
        externalId: reason,
      },
    });
    return true;
  }, { ok: false, released: false, promoted: [] });

  // A release that could not serialise released nothing, and must not be reported as
  // though it had: the plug is still held, and the caller has to ask again. Promoting on
  // top of it would hand out a plug on the strength of a transaction that rolled back.
  if (releaseOutcome && releaseOutcome.retryable === true) return { ...releaseOutcome, ok: false };

  const filled = await promote(deps, { nowMs: source.nowMs });
  return { ok: true, released: releaseOutcome === true, promoted: filled.promoted || [], problems: filled.problems || [] };
}

/**
 * Restart and crash reconciliation.
 *
 * ── The defect this exists to prevent ───────────────────────────────────────
 * A process that dies with three robots ACTIVE leaves three occupied plugs and no
 * in-memory state. Without this pass the charger is permanently full: every subsequent
 * request queues behind reservations whose agents are gone. That is the "reservation
 * leak" and "stale reservation considered active indefinitely" failure, and it is why
 * the reservation window is finite and derived rather than open-ended.
 *
 * Expiry is on the **durable window**, not on a heartbeat: a reservation whose
 * `reservedUntil` has passed has, by its own published terms, stopped being a claim. The
 * window is the worst-case full charge at the coldest declared temperature, so expiring
 * against it cannot evict a session that is still legitimately running.
 *
 * P7-D3 Step 0 adds one pass, run first and independently of the depot's presence: live
 * reservations at a superseded charger are released (`CHARGER_SUPERSEDED`). A process that
 * booted on the old estate left them, and no pass scoped to the declared charger would ever
 * expire them.
 *
 * @param {object} deps `{ prisma, runSerializable, selectForUpdate }`
 * @param {{ nowMs: number }} input
 * @returns {Promise<{ ok: boolean, expired: number, superseded: number, promoted: string[], problems: string[] }>}
 */
async function reconcile(deps, input) {
  const nowMs = input && input.nowMs;
  if (!isNumber(nowMs)) return { ok: false, expired: 0, superseded: 0, promoted: [], problems: ["nowMs is required"] };

  const supersededOutcome = await serialized(
    deps,
    (tx) => releaseSupersededReservations(tx, {}, nowMs),
    { ok: false, expired: 0, superseded: 0, promoted: [] },
  );
  if (supersededOutcome && supersededOutcome.retryable === true) return { ...supersededOutcome, ok: false };
  const superseded = typeof supersededOutcome === "number" ? supersededOutcome : 0;

  const expiryOutcome = await serialized(deps, async (tx) => {
    const charger = await tx.charger.findUnique({ where: { chargerId: DEVELOPMENT_CHARGER.chargerId } });
    if (!charger) return 0;
    await deps.selectForUpdate(tx, "Charger", "id", charger.id);

    const result = await tx.chargerReservation.updateMany({
      where: {
        chargerDbId: charger.id,
        state: { in: LIVE_STATES },
        reservedUntil: { lt: new Date(nowMs) },
      },
      data: { state: RESERVATION_STATE.RELEASED, externalId: RELEASE_REASON.STALE_EXPIRED },
    });
    return result.count;
  }, { ok: false, expired: 0, superseded, promoted: [] });

  if (expiryOutcome && expiryOutcome.retryable === true) return { ...expiryOutcome, ok: false };

  const filled = await promote(deps, { nowMs });
  return {
    ok: true,
    expired: typeof expiryOutcome === "number" ? expiryOutcome : 0,
    superseded,
    promoted: filled.promoted || [],
    problems: filled.problems || [],
  };
}

/**
 * The charger's current occupancy, for diagnostics and verification.
 *
 * @param {object} deps `{ prisma }`
 * @returns {Promise<{ chargerId: string, plugCount: number|null, active: number, queued: number,
 *                     projectionVersion: number|null, queue: object[] }>}
 */
async function status(deps) {
  const capacity = await publishedCapacity(deps);
  const charger = await deps.prisma.charger.findUnique({ where: { chargerId: DEVELOPMENT_CHARGER.chargerId } });
  if (!charger) {
    return { chargerId: DEVELOPMENT_CHARGER.chargerId, plugCount: capacity.plugCount, active: 0, queued: 0, projectionVersion: capacity.version, queue: [] };
  }
  const live = await deps.prisma.chargerReservation.findMany({
    where: { chargerDbId: charger.id, state: { in: LIVE_STATES } },
    orderBy: [{ reservedFrom: "asc" }, { reservationId: "asc" }],
  });
  return {
    chargerId: DEVELOPMENT_CHARGER.chargerId,
    plugCount: capacity.plugCount,
    active: live.filter((entry) => entry.state === RESERVATION_STATE.ACTIVE).length,
    queued: live.filter((entry) => entry.state === RESERVATION_STATE.QUEUED).length,
    projectionVersion: capacity.version,
    queue: live.map((entry) => ({
      reservationId: entry.reservationId,
      agentId: entry.agentId,
      state: entry.state,
      reservedFromMs: entry.reservedFrom.getTime(),
      reservedUntilMs: entry.reservedUntil.getTime(),
      targetSoc: entry.targetSoc,
    })),
  };
}

module.exports = {
  DEVELOPMENT_CHARGER,
  SUPERSEDED_CHARGER_IDS,
  PUBLISHER,
  RESERVATION_STATE,
  LIVE_STATES,
  RELEASE_REASON,
  RECOVERY_REFUSAL,
  sessionHorizonSeconds,
  reservationIdFor,
  depotProblems,
  projectionPayload,
  provision,
  publishedCapacity,
  liveReservationFor,
  reservationForRecovery,
  requestPlug,
  promote,
  release,
  reconcile,
  status,
};

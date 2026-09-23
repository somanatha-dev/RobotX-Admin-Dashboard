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
// §20.3 item 3's spatial identity for the declared charger. Used only to derive the H3
// cell the row's own declared coordinate falls in — see `DEVELOPMENT_CHARGER_CELL_ID`.
const cells = require("../engine/spatial/cells");
const {
  CHARGE_POWER_CURVE,
  CHARGE_CHARGER_CLASS,
  CHARGE_CURVE_INTEGRATION_STEPS,
  PACK_NOMINAL_WH,
} = require("./constants");

/**
 * The owner's development declaration, as one frozen record.
 *
 * ── Every field's provenance, because none of it is measured ────────────────
 *   * `chargerId` / `name` — reserved development identifiers. The `DEV-SIM-` prefix is
 *     not a discriminator the code branches on; it is a label so that a human reading a
 *     `Charger` table can tell at a glance that this row is not an installed asset. The
 *     structural statement that it is development configuration is
 *     `ChargerAvailabilityProjection.publishedBy`, below.
 *   * `latitude` / `longitude` — the **centroid of OSM `way/204638943`** ("RNSIT MBA
 *     block") in `rnsit-campus-osm.geojson`, the extract the owner adopted unmodified
 *     (RD-2026-08-30-01). It is a derivation from an adopted document, traceable to a way
 *     id, and it is **not a surveyed charger position**. The owner said "near MBA Block";
 *     nobody has said *where* near, and this module does not invent a bay.
 *   * `plugCount` — the owner's development decision: three simultaneous plugs.
 *   * `chargerClass` — `STANDARD`, because that is the only class
 *     `simulation/constants.CHARGE_POWER_CURVE` characterises and the class the simulated
 *     agent already charges on. Naming a class with no curve would make
 *     `chargeCurve.chargePowerW` refuse, which is its stated behaviour for "a class nobody
 *     has characterised".
 *   * `ratedPowerW` — **deliberately null.** The curve declares power as a function of
 *     SoC; a nameplate rating is a separate measured fact about installed hardware and
 *     nobody has supplied one. Writing the curve's 2000 W plateau here would turn a
 *     modelling assumption into an equipment specification.
 *   * `isDepot` — **false.** §14.5 makes depots "the fixed infrastructure whose
 *     availability does not depend on any round's output" and `eReturn` falls back to
 *     them. A development row marked `isDepot` would enter that fallback set, which is a
 *     production seam this batch must not feed.
 *
 * @structural the owner's development charger declaration, not a tunable
 */
const DEVELOPMENT_CHARGER = Object.freeze({
  chargerId: "DEV-SIM-RNSIT-MBA-01",
  name: "Development simulation charger — near MBA Block, RNSIT",
  chargerClass: CHARGE_CHARGER_CLASS,
  plugCount: 3,
  latitude: 12.9009017,
  longitude: 77.519021,
  ratedPowerW: null,
  isDepot: false,
  locationProvenance:
    "centroid of OSM way/204638943 (RNSIT MBA block) in rnsit-campus-osm.geojson — NOT a surveyed charger position",
});

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
/**
 * The H3 fine cell the declared charger's own coordinate falls in (§20.3 item 3).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `Charger.cellId` was never written, so the row this module provisions carried a
 * latitude and a longitude and **no cell**. `workers/coordinatorSolvePath.chargerCandidatesFor`
 * skips exactly that row — *"charger … states no cell and cannot be routed to (§20.3 item 3)"* —
 * because the routing seam is keyed on cell pairs and a charger with no cell cannot be
 * routed to. The consequence was not a missing charging option: with no admissible
 * charger, `eReturn` resolves no return leg, `reserves.compose` refuses, `plan.energy`
 * comes out `null`, and **F34 and F35 deny for every agent**. So the development estate
 * was published, declared, and invisible to the one consumer that needed it.
 *
 * ── Why deriving it invents nothing ────────────────────────────────────────
 * The cell is a **pure function of the coordinate this module already declares**, taken
 * with `spatial/cells.cellForPoint` — the same function `Stop.fineCell` and
 * `AgentCellPosition.fineCellId` are derived with, so the charger lands in the same index
 * the expansion searches rather than in a second notion of "where". No position is
 * asserted: the coordinate's provenance is unchanged and still says what it is (the
 * centroid of OSM `way/204638943`, **not** a surveyed charger bay).
 *
 * `isDepot` stays `false` and is deliberately untouched. §14.5 makes depots the fixed
 * infrastructure `eReturn` falls back to, and a development row must not enter that
 * fallback set; this charger is admissible only while this module's own
 * `ChargerAvailabilityProjection` is pinned and fresh, which is the honest scope for a
 * development estate.
 *
 * @structural the declared charger's spatial identity, derived from its own coordinate
 */
const DEVELOPMENT_CHARGER_CELL_ID = cells.cellForPoint(
  DEVELOPMENT_CHARGER.latitude,
  DEVELOPMENT_CHARGER.longitude,
  cells.RESOLUTION.FINE,
);

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
 * Create or update the development charger row, and publish the projection that declares
 * its plug capacity.
 *
 * Idempotent by `chargerId`. Running it twice changes no charger field and publishes a
 * second projection **only** when the declared estate has actually changed — the
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

  const charger = await prisma.charger.upsert({
    where: { chargerId: DEVELOPMENT_CHARGER.chargerId },
    create: {
      chargerId: DEVELOPMENT_CHARGER.chargerId,
      chargerClass: DEVELOPMENT_CHARGER.chargerClass,
      ratedPowerW: DEVELOPMENT_CHARGER.ratedPowerW,
      latitude: DEVELOPMENT_CHARGER.latitude,
      longitude: DEVELOPMENT_CHARGER.longitude,
      // §20.3 item 3 — derived from the two columns beside it, never asserted separately.
      cellId: DEVELOPMENT_CHARGER_CELL_ID,
      isDepot: DEVELOPMENT_CHARGER.isDepot,
    },
    update: {
      chargerClass: DEVELOPMENT_CHARGER.chargerClass,
      ratedPowerW: DEVELOPMENT_CHARGER.ratedPowerW,
      latitude: DEVELOPMENT_CHARGER.latitude,
      longitude: DEVELOPMENT_CHARGER.longitude,
      cellId: DEVELOPMENT_CHARGER_CELL_ID,
      isDepot: DEVELOPMENT_CHARGER.isDepot,
    },
  });

  const payload = projectionPayload({ nowMs, horizonSeconds: horizon.seconds });

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
 * @param {{ nowMs: number, horizonSeconds: number }} input
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
        chargerId: DEVELOPMENT_CHARGER.chargerId,
        chargerClass: DEVELOPMENT_CHARGER.chargerClass,
        cellId: null,
        isDepot: DEVELOPMENT_CHARGER.isDepot,
        latitude: DEVELOPMENT_CHARGER.latitude,
        longitude: DEVELOPMENT_CHARGER.longitude,
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

    const existing = await tx.chargerReservation.findFirst({
      where: { agentId: source.agentRowId, state: { in: LIVE_STATES } },
      orderBy: [{ reservedFrom: "asc" }, { reservationId: "asc" }],
    });
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
 * @param {object} deps `{ prisma, runSerializable, selectForUpdate }`
 * @param {{ nowMs: number }} input
 * @returns {Promise<{ ok: boolean, expired: number, promoted: string[], problems: string[] }>}
 */
async function reconcile(deps, input) {
  const nowMs = input && input.nowMs;
  if (!isNumber(nowMs)) return { ok: false, expired: 0, promoted: [], problems: ["nowMs is required"] };

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
  }, { ok: false, expired: 0, promoted: [] });

  if (expiryOutcome && expiryOutcome.retryable === true) return { ...expiryOutcome, ok: false };

  const filled = await promote(deps, { nowMs });
  return {
    ok: true,
    expired: typeof expiryOutcome === "number" ? expiryOutcome : 0,
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
  DEVELOPMENT_CHARGER_CELL_ID,
  PUBLISHER,
  RESERVATION_STATE,
  LIVE_STATES,
  RELEASE_REASON,
  sessionHorizonSeconds,
  reservationIdFor,
  projectionPayload,
  provision,
  publishedCapacity,
  liveReservationFor,
  requestPlug,
  promote,
  release,
  reconcile,
  status,
};

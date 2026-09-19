"use strict";

/**
 * The **production routing producer** — the thing that was missing.
 *
 * `routing/cellPairCache.read` falls through to `deps.route(parts)` on a miss and reports
 * *"no router is available and the entry is not cached"* without it.
 * `workers/coordinatorPipeline.js:289-301` names that seam as requirement `route`, class
 * `EXTERNAL_ROUTING`, with the contract stated verbatim:
 *
 *     async ({ originCell, destCell, profileKey, timeBucket })
 *       => { distanceM, travelSeconds, travelSdSeconds, climbM, descentM, stopStartCycles }
 *
 * every one finite and non-negative. **This module is that function.** It composes pieces
 * that already exist rather than building a parallel architecture: a B1 adapter for the
 * engine call, `cellProjection` for N27's cell → coordinate seam, `campusServiceability`
 * for domain membership, and `campusTravelModel` for the owner's declared V1 arithmetic.
 * It introduces no second routing interface, no second cell-pair abstraction, no second
 * timeline and no second route contract.
 *
 * ── Where each of the six fields actually comes from ───────────────────────
 *
 *   `distanceM`         the self-hosted engine's measured path length. `PRODUCTION_EXTERNAL`.
 *                       Never a straight-line distance, never a cell-centre separation,
 *                       never a constant — `adapters/osrm.js` refuses a Table response with
 *                       no `distances` block rather than deriving one from a duration.
 *
 *   `travelSeconds`     the **owner's** V1 model over that distance, not the engine's
 *                       duration. `PRODUCTION_DECLARED`. See `campusTravelModel.js` for
 *                       why the engine's `foot`-profile duration is deliberately discarded.
 *
 *   `travelSdSeconds`   the declared V1 operational uncertainty, derived from the same
 *                       buffer so no second constant is invented. `PRODUCTION_DECLARED`,
 *                       source name `DECLARED_V1_OPERATIONAL_UNCERTAINTY` (N29).
 *
 *   `climbM`/`descentM` **no producer exists.** OSRM returns no elevation at all, and
 *                       `simulation/simulatedEnergy.js:77-79` records that there is no
 *                       elevation source anywhere in this deployment. Refused.
 *
 *   `stopStartCycles`   **no producer exists.** `coordinatorPipeline.js:332-334` states it
 *                       outright: *"no shortlisted engine returns stop-start cycles — so
 *                       like travelSdSeconds this needs a declared source, and selecting an
 *                       engine does not by itself close it."* Refused.
 *
 * ── Why the last two are refused and not derived ──────────────────────────
 * Both are seams here, and both are empty. The temptations were specific and both were
 * declined:
 *
 *   * **elevation from a gradient assumption** — inflating climb by a plausible slope is
 *     inventing terrain for ground the router never surveyed. `cellPairCache.js:193-196`
 *     refuses the same thing for the intra-cell offset and states the reason;
 *   * **stop-start cycles from OSRM's `intersections`** — the `route` service with
 *     `steps=true` really does return them, and counting them would produce a plausible
 *     number. But an intersection is not an acceleration cycle: §14.2's term is
 *     `β_stop_start · n_stop_start_cycles` over *"acceleration cycles"*, and most
 *     intersections on a campus footway are traversed without stopping. Mapping one onto
 *     the other is a modelling choice nobody has declared, and a declared source is what
 *     the contract asks for. A count that looks like evidence and is not is worse than a
 *     refusal, because the refusal is visible.
 *
 * The consequence is honest and is the whole point: **a production route from this router
 * is refused until a terrain source and a stop-start source are declared.** `plan/timeline.project`
 * would refuse the hop anyway (E-8) — refusing here means nothing half-formed is even cached.
 *
 * ── PRODUCTION vs DEVELOPMENT, and the one rule that matters ──────────────
 * Every field carries a provenance. In `PRODUCTION` mode a value whose provenance is
 * `DEVELOPMENT_SIMULATION` is **refused outright**, so a simulated number cannot leave this
 * module wearing production clothes. That check is made at the producer rather than at the
 * consumer deliberately: `cellPairCache.buildEntry` freezes a fixed eight-field shape and
 * drops everything else, so a provenance label attached to a route result does **not**
 * survive into the cache. A label that does not survive cannot be the control. Refusing to
 * emit the value is the control.
 *
 * This is the same discipline `services/positionObservation.service.js` applies to
 * `PHYSICAL` / `SIMULATED`, and the mapping onto that existing two-way axis is stated in
 * `EVIDENCE_AXIS` below so this is a refinement of the repository's vocabulary rather than
 * a competing one.
 *
 * ── What this module does NOT do ──────────────────────────────────────────
 * No Mapbox, no Google, no hosted routing service — `contract.assertSelfHosted` refuses all
 * six public hosts by canonical name and this module cannot reach an engine except through
 * an adapter that has passed it. No traffic feed. No clock (`timeBucket` is the caller's,
 * from the round's pinned decision time). No randomness. No cache of its own — `cellPairCache`
 * is the cache and this is what it falls through to. No §5.2 degradation ladder: choosing
 * among degraded estimators is the round's decision, and a router that quietly substituted a
 * geometric bound would be making it.
 *
 * ── Determinism (R10, §9.6) ───────────────────────────────────────────────
 * The same request produces a bit-identical result on every run: one destination per call,
 * no unordered iteration, no sampling, no `Math.random`, no clock read.
 */

const { travelTimeFor, DECLARED_SPREAD_SOURCE } = require("./campusTravelModel");
const { ProjectionError } = require("./cellProjection");

/**
 * Where one route field's value came from.
 *
 * Three labels, because two would force a declared operational policy and an external
 * measurement into the same bucket and they are not the same kind of claim: one is a number
 * somebody chose and owns, the other is a number an engine measured.
 * @structural routing-field provenance labels
 */
const FIELD_PROVENANCE = Object.freeze({
  /** Measured by the self-hosted routing engine against real OSM geometry. */
  PRODUCTION_EXTERNAL: "PRODUCTION_EXTERNAL",
  /** A declared operational model or policy, owned and recorded. Not measured. */
  PRODUCTION_DECLARED: "PRODUCTION_DECLARED",
  /** Produced by the simulator. Never admissible as production evidence. */
  DEVELOPMENT_SIMULATION: "DEVELOPMENT_SIMULATION",
});

/**
 * How each of the three maps onto the repository's existing two-way evidence axis
 * (`services/positionObservation.service.js` `PROVENANCE`), so this vocabulary refines that
 * one instead of competing with it. The rule that axis encodes — *"unknown provenance must
 * never be readable as physical"* — is the rule enforced below.
 * @structural the mapping onto §2.7's existing evidence axis
 */
const EVIDENCE_AXIS = Object.freeze({
  PRODUCTION_EXTERNAL: "PHYSICAL",
  PRODUCTION_DECLARED: "PHYSICAL",
  DEVELOPMENT_SIMULATION: "SIMULATED",
});

/**
 * Which mode this router is composed in.
 * @structural the router's own operating modes
 */
const ROUTER_MODE = Object.freeze({
  /** Only `PRODUCTION_*` provenance may be emitted. A simulation value is refused. */
  PRODUCTION: "PRODUCTION",
  /** `DEVELOPMENT_SIMULATION` values are permitted and are labelled as such. */
  DEVELOPMENT: "DEVELOPMENT",
});

/**
 * Why a route was refused. Additive to `adapters/contract.ROUTE_STATUS` rather than a
 * replacement: the adapter's six conditions are about the engine, and these are about the
 * inputs the engine never sees.
 * @structural the router's own refusal reasons
 */
const ROUTE_REFUSAL = Object.freeze({
  MALFORMED_REQUEST: "MALFORMED_REQUEST",
  OUTSIDE_SERVICEABLE_REGION: "OUTSIDE_SERVICEABLE_REGION",
  NOT_ROUTABLE: "NOT_ROUTABLE",
  ENGINE_REFUSED: "ENGINE_REFUSED",
  NO_SPEED: "NO_SPEED",
  NO_TERRAIN_SOURCE: "NO_TERRAIN_SOURCE",
  NO_STOP_START_SOURCE: "NO_STOP_START_SOURCE",
  SIMULATION_IN_PRODUCTION: "SIMULATION_IN_PRODUCTION",
  MODEL_REFUSED: "MODEL_REFUSED",
});

/**
 * §9.6 item 4's bucket: `hour_of_week`, 0–167, Sunday 00:00 local being 0 — the same
 * convention `plan/timeline.hourOfWeek` computes and the only one this system has.
 * @structural the number of hours in a week, which is the bucket's cardinality
 */
const TIME_BUCKET_COUNT = 168;

/** An error carrying the refusal reason, so a caller can branch without parsing a message. */
class RouteRefusedError extends Error {
  /**
   * @param {string} refusal one of `ROUTE_REFUSAL`
   * @param {string} reason
   * @param {object} [detail]
   */
  constructor(refusal, reason, detail) {
    super(reason);
    this.name = "RouteRefusedError";
    this.refusal = refusal;
    this.reason = reason;
    this.detail = detail || null;
  }
}

/** @param {unknown} value @returns {boolean} */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** @param {unknown} value @returns {boolean} */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate the four key components, and the bucket's range.
 *
 * The bucket is validated rather than merely required because `cellPairCache.key` accepts
 * any non-empty value and interpolates it into the key. A caller that passed a millisecond
 * timestamp would produce a key that is unique per round, a hit rate of zero, and a cache
 * that silently does nothing — which reads as a slow engine rather than as a defect.
 *
 * @param {object} parts
 * @returns {{ originCell: string, destCell: string, profileKey: string, timeBucket: number }}
 * @throws {RouteRefusedError}
 */
function normaliseRouteRequest(parts) {
  const source = parts || {};
  const problems = [];

  if (!isNonEmptyString(source.originCell)) problems.push("originCell must be a non-empty cell token");
  if (!isNonEmptyString(source.destCell)) problems.push("destCell must be a non-empty cell token");
  if (!isNonEmptyString(source.profileKey)) {
    problems.push(
      "profileKey must be a non-empty string — `domain/mobilityModel.routingProfileKey(model, { loaded })`. " +
        "ADR-33 rider 2: the caller MUST have validated the model first, because routingProfileKey() is total and " +
        "yields unknown:unknown:* for a broken model, so two differently-broken models would share cache entries",
    );
  }
  if (!Number.isInteger(source.timeBucket) || source.timeBucket < 0 || source.timeBucket >= TIME_BUCKET_COUNT) {
    problems.push(
      `timeBucket must be an integer hour-of-week in 0…${TIME_BUCKET_COUNT - 1} (Sunday 00:00 local = 0), received ` +
        `${JSON.stringify(source.timeBucket)}. It is the caller's, derived from the round's pinned decision time via ` +
        "`plan/timeline.hourOfWeek` — a router that derived one would be reading a clock, and a caller that passed a " +
        "timestamp would mint a unique cache key per round and silently disable the cache",
    );
  }

  if (problems.length > 0) {
    throw new RouteRefusedError(ROUTE_REFUSAL.MALFORMED_REQUEST, `invalid route request:\n  - ${problems.join("\n  - ")}`, { problems });
  }

  return {
    originCell: source.originCell,
    destCell: source.destCell,
    profileKey: source.profileKey,
    timeBucket: source.timeBucket,
  };
}

/**
 * Read a declared seam that may be absent, classifying "absent" as a named refusal rather
 * than as a zero.
 *
 * @param {object} input `{ seam, request, refusal, fields, what, why }`
 * @returns {{ values: object, provenance: string }}
 * @throws {RouteRefusedError}
 */
async function readDeclaredSeam(input) {
  const { seam, request, refusal, fields, what, why } = input;

  if (typeof seam !== "function") {
    throw new RouteRefusedError(refusal, `${what} has no declared source. ${why}`);
  }

  let answer;
  try {
    answer = await seam(request);
  } catch (error) {
    throw new RouteRefusedError(refusal, `${what} source failed: ${error && error.message}`);
  }
  if (!answer || typeof answer !== "object") {
    throw new RouteRefusedError(refusal, `${what} source returned ${JSON.stringify(answer)} rather than a value. ${why}`);
  }

  const values = {};
  for (const field of fields) {
    const value = answer[field];
    if (!isFiniteNumber(value) || value < 0) {
      throw new RouteRefusedError(
        refusal,
        `${what} source returned ${JSON.stringify(value)} for ${field}; a finite non-negative number is required and ` +
          "an absent one is never coerced to 0 (§4.1 rule 3 — state is not inferred from the absence of data)",
      );
    }
    values[field] = value;
  }

  const provenance = answer.provenance;
  if (!Object.prototype.hasOwnProperty.call(FIELD_PROVENANCE, provenance)) {
    throw new RouteRefusedError(
      refusal,
      `${what} source returned provenance ${JSON.stringify(provenance)}; it must be one of ` +
        `${Object.keys(FIELD_PROVENANCE).join(", ")}. A value with no stated provenance cannot be told apart from a ` +
        "fabricated one, which is the whole reason the label exists",
    );
  }

  return { values, provenance };
}

/**
 * Build the production router.
 *
 * @param {object} config
 *   * `adapter` — a B1 adapter exposing `matrix(request)`; **required**.
 *   * `projection` — from `cellProjection.createCellProjection`; **required**. Its serviceability
 *     check is routing-local: it refuses a cell whose derived representative coordinate is off
 *     the operating region. This router neither produces nor recomputes the delivery-domain
 *     verdict for a destination — that is the intake-pinned `Stop.geofenceResult` (D1 / ADR-28),
 *     consumed by the round through `deliveryDomain.pinnedMembership`.
 *   * `travelModel` — `{ bufferSecondsPer100m, sdBufferMultiple }`, resolved from the
 *     register by `campusTravelModel.resolveModelParameters`; **required**.
 *   * `speedFor(profileKey)` — metres per second for that routing profile; **required**.
 *     D3 for a physical fleet; the simulator's commissioned specification for a simulated
 *     agent, in which case `speedProvenance` must say so.
 *   * `speedProvenance` — one of `FIELD_PROVENANCE`; **required**.
 *   * `terrainSource(request)` — `{ climbM, descentM, provenance }`; optional and, while no
 *     elevation source exists, absent.
 *   * `stopStartSource(request)` — `{ stopStartCycles, provenance }`; likewise.
 *   * `mode` — one of `ROUTER_MODE`; defaults to `PRODUCTION`, which is the fail-closed
 *     direction: a composition that forgot to say is treated as production and refuses
 *     simulation values.
 * @returns {object}
 */
function createProductionRouter(config) {
  const source = config || {};
  const mode = source.mode === ROUTER_MODE.DEVELOPMENT ? ROUTER_MODE.DEVELOPMENT : ROUTER_MODE.PRODUCTION;
  const problems = [];

  if (!source.adapter || typeof source.adapter.matrix !== "function") {
    problems.push(
      "adapter is required and must expose matrix(request) — a B1 adapter built against a SELF-HOSTED engine. " +
        "No router is constructed here and no engine is selected: engine selection is B1 Step 5, on recorded evidence",
    );
  }
  if (!source.projection || typeof source.projection.project !== "function") {
    problems.push("projection is required — cellProjection.createCellProjection(), which checks every coordinate against the serviceable region");
  }
  if (!source.travelModel || !isFiniteNumber(source.travelModel.bufferSecondsPer100m) || !isFiniteNumber(source.travelModel.sdBufferMultiple)) {
    problems.push("travelModel { bufferSecondsPer100m, sdBufferMultiple } is required — resolve it with campusTravelModel.resolveModelParameters(snapshot, scope)");
  }
  if (typeof source.speedFor !== "function") {
    problems.push(
      "speedFor(profileKey) -> metres per second is required. It is D3 (Product + Fleet Engineering) for a physical " +
        "fleet and this module invents no speed: `coordinatorPipeline.js:315-322` records that the only MobilityModel " +
        "in this repository is a seed whose speedModel is a note deferring to D3",
    );
  }
  if (!Object.prototype.hasOwnProperty.call(FIELD_PROVENANCE, source.speedProvenance)) {
    problems.push(`speedProvenance is required and must be one of ${Object.keys(FIELD_PROVENANCE).join(", ")}`);
  }
  if (mode === ROUTER_MODE.PRODUCTION && source.speedProvenance === FIELD_PROVENANCE.DEVELOPMENT_SIMULATION) {
    problems.push(
      "speedProvenance is DEVELOPMENT_SIMULATION and mode is PRODUCTION. A simulated speed produces a simulated ETA, " +
        "and a simulated ETA presented as a production travel time is exactly the masquerade the provenance " +
        "vocabulary exists to prevent. Compose in DEVELOPMENT mode, or supply D3's measured speed",
    );
  }

  if (problems.length > 0) {
    throw new RouteRefusedError(ROUTE_REFUSAL.MALFORMED_REQUEST, `the production router cannot be composed:\n  - ${problems.join("\n  - ")}`, { problems });
  }

  const { adapter, projection, travelModel, speedFor, speedProvenance, terrainSource, stopStartSource } = source;

  /**
   * Refuse a value whose provenance is not admissible in this mode.
   *
   * @param {string} field @param {string} provenance
   * @throws {RouteRefusedError}
   */
  function assertAdmissible(field, provenance) {
    if (mode === ROUTER_MODE.PRODUCTION && provenance === FIELD_PROVENANCE.DEVELOPMENT_SIMULATION) {
      throw new RouteRefusedError(
        ROUTE_REFUSAL.SIMULATION_IN_PRODUCTION,
        `${field} was produced with ${FIELD_PROVENANCE.DEVELOPMENT_SIMULATION} provenance and this router is composed ` +
          `in ${ROUTER_MODE.PRODUCTION} mode. Simulation output is never production evidence (§23.5, ADR-31). ` +
          "The refusal is made here, at the producer, because `cellPairCache.buildEntry` freezes a fixed field set " +
          "and a provenance label attached to the result would not survive into the cache — a label that does not " +
          "survive cannot be the control",
      );
    }
  }

  /**
   * Ask the engine for one origin→destination pair.
   *
   * `matrix()` is used rather than a new adapter method, so the existing B1 adapters serve
   * the production seam unchanged and there is one engine interface rather than two.
   *
   * @param {object} request normalised
   * @returns {Promise<{ distanceM: number }>}
   * @throws {RouteRefusedError}
   */
  async function measureDistance(request) {
    let answers;
    try {
      answers = await adapter.matrix({
        originCellId: request.originCell,
        destCellIds: [request.destCell],
        profileKey: request.profileKey,
        timeBucket: request.timeBucket,
      });
    } catch (error) {
      // There is deliberately **no** `ProjectionError` branch here. The adapter calls
      // `projectCell` itself, but `contract.project` wraps that call and converts any throw
      // into an `AdapterError`, so a `ProjectionError` can never surface from `matrix()` —
      // a branch for it would be a guard that cannot fire, which is the shape this
      // programme has repeatedly found written, tested, and never reached. Both endpoints
      // are projected by `route()` *before* this function is called, and that is where a
      // projection failure is classified.
      //
      // An adapter throw carries `status` from `contract.ROUTE_STATUS` — a timeout, a
      // malformed response, an unreachable engine, or a point that is not on the cut graph.
      // Every one is a refusal, never a guess: §5.2's degradation ladder is the round's
      // decision and not this module's.
      //
      // The split below is load-bearing and is not cosmetic. `NO_ROUTE` and `EXTRACT_MISS`
      // are findings about the *request* — these two points are not connected, or this
      // coordinate is off the graph — while a timeout, a malformed body and an unreachable
      // process are findings about the *engine*. §18.3 B6's uniform-treatment rule only
      // makes sense if a caller can tell them apart, and reporting an extract miss as an
      // engine failure would send somebody to restart a healthy router.
      const status = (error && error.status) || null;
      const isRequestFinding = status === "NO_ROUTE" || status === "EXTRACT_MISS";
      throw new RouteRefusedError(
        isRequestFinding ? ROUTE_REFUSAL.NOT_ROUTABLE : ROUTE_REFUSAL.ENGINE_REFUSED,
        isRequestFinding
          ? `no route from "${request.originCell}" to "${request.destCell}" under profile "${request.profileKey}": ` +
            `${status} — ${error && error.message}. The destination may be inside the serviceable region and still ` +
            "be unreachable on the routing graph; those are different findings and this one is the second"
          : `the routing engine did not answer: ${error && error.message}${status ? ` [${status}]` : ""}`,
        { status },
      );
    }

    if (!Array.isArray(answers) || answers.length !== 1) {
      throw new RouteRefusedError(
        ROUTE_REFUSAL.ENGINE_REFUSED,
        `the adapter answered ${Array.isArray(answers) ? answers.length : "a non-array"} for one requested destination`,
      );
    }

    const answer = answers[0];
    if (!answer || answer.status !== "OK") {
      throw new RouteRefusedError(
        answer && (answer.status === "NO_ROUTE" || answer.status === "EXTRACT_MISS") ? ROUTE_REFUSAL.NOT_ROUTABLE : ROUTE_REFUSAL.ENGINE_REFUSED,
        `no route from "${request.originCell}" to "${request.destCell}" under profile "${request.profileKey}": ` +
          `${(answer && answer.status) || "no answer"}${answer && answer.reason ? ` — ${answer.reason}` : ""}. ` +
          "The destination may be inside the serviceable region and still be unreachable on the routing graph; " +
          "those are different findings and this one is the second",
        { status: (answer && answer.status) || null },
      );
    }
    if (!isFiniteNumber(answer.distanceM) || answer.distanceM < 0) {
      throw new RouteRefusedError(ROUTE_REFUSAL.ENGINE_REFUSED, `the adapter returned ${JSON.stringify(answer.distanceM)} for distanceM`);
    }
    return { distanceM: answer.distanceM };
  }

  return Object.freeze({
    mode,

    /**
     * **The `deps.route(parts)` seam.** `cellPairCache.read` calls exactly this.
     *
     * @param {object} parts `{ originCell, destCell, profileKey, timeBucket }`
     * @returns {Promise<object>} the six contract fields, plus a non-contract `provenance`
     *   block that `cellPairCache.buildEntry` will drop — it is for the caller's audit
     *   record, never for the cache.
     * @throws {RouteRefusedError}
     */
    async route(parts) {
      const request = normaliseRouteRequest(parts);

      // Both endpoints are projected *before* the engine is called. A cell that cannot be
      // shown to be inside the serviceable region is refused here rather than routed and
      // filtered afterwards, so no engine call is ever made for a destination outside the
      // operational domain.
      let origin;
      let destination;
      try {
        origin = projection.project(request.originCell);
        destination = projection.project(request.destCell);
      } catch (error) {
        if (error instanceof ProjectionError) {
          throw new RouteRefusedError(
            error.refusal === "OUTSIDE_SERVICEABLE_REGION" ? ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION : ROUTE_REFUSAL.MALFORMED_REQUEST,
            error.reason,
            { refusal: error.refusal },
          );
        }
        throw error;
      }

      const { distanceM } = await measureDistance(request);

      const speedMetresPerSecond = speedFor(request.profileKey);
      if (!isFiniteNumber(speedMetresPerSecond) || speedMetresPerSecond <= 0) {
        throw new RouteRefusedError(
          ROUTE_REFUSAL.NO_SPEED,
          `no speed is available for routing profile "${request.profileKey}". For a physical fleet this is D3 ` +
            "(Product + Fleet Engineering) and no plausible value is substituted; §25.4 makes inventing one a " +
            "commissioning-gate violation — \"a heterogeneous fleet with copy-pasted parameters will make " +
            "confidently wrong cross-class comparisons, which is worse than not comparing at all\"",
        );
      }
      assertAdmissible("speedMetresPerSecond", speedProvenance);

      const modelled = travelTimeFor({
        distanceM,
        speedMetresPerSecond,
        bufferSecondsPer100m: travelModel.bufferSecondsPer100m,
        sdBufferMultiple: travelModel.sdBufferMultiple,
      });
      if (!modelled.ok) {
        throw new RouteRefusedError(ROUTE_REFUSAL.MODEL_REFUSED, `the V1 campus travel model refused:\n  - ${modelled.problems.join("\n  - ")}`);
      }

      const seamRequest = Object.freeze({ ...request, distanceM, origin, destination });

      const terrain = await readDeclaredSeam({
        seam: terrainSource,
        request: seamRequest,
        refusal: ROUTE_REFUSAL.NO_TERRAIN_SOURCE,
        fields: ["climbM", "descentM"],
        what: "hop terrain (climbM / descentM)",
        why:
          "§14.2 evaluates `β_climb · Σ max(0, Δh)` and its regeneration counterpart OVER THE TRAVERSAL, so terrain " +
          "is a property of the hop the router answers with. **OSRM returns no elevation at all**, and " +
          "`simulation/simulatedEnergy.js:77-79` records that there is no elevation source anywhere in this " +
          "deployment. It is NOT defaulted to flat: `plan/timeline.project` refuses a hop without it because " +
          "treating an unsurveyed hop as flat understates mission energy, and a gradient assumed here would be " +
          "terrain invented for ground nobody surveyed. A legitimate source is a campus survey, a DEM, or robot " +
          "measurements — supplied, never assumed",
      });
      assertAdmissible("climbM / descentM", terrain.provenance);

      const stopStart = await readDeclaredSeam({
        seam: stopStartSource,
        request: seamRequest,
        refusal: ROUTE_REFUSAL.NO_STOP_START_SOURCE,
        fields: ["stopStartCycles"],
        what: "stopStartCycles",
        why:
          "§14.2's `β_stop_start · n_stop_start_cycles` counts ACCELERATION CYCLES along the traversal. " +
          "`coordinatorPipeline.js:332-334`: \"no shortlisted engine returns stop-start cycles — so like " +
          "travelSdSeconds this needs a declared source, and selecting an engine does not by itself close it.\" " +
          "OSRM's `route` service does return `intersections`, and counting them would yield a plausible number — " +
          "but an intersection traversed without stopping is not an acceleration cycle, and equating the two is a " +
          "modelling choice nobody has declared. A distance heuristic is likewise not what the term means",
      });
      assertAdmissible("stopStartCycles", stopStart.provenance);

      return Object.freeze({
        // ── the six contract fields ──
        distanceM,
        travelSeconds: modelled.travelSeconds,
        travelSdSeconds: modelled.travelSdSeconds,
        climbM: terrain.values.climbM,
        descentM: terrain.values.descentM,
        stopStartCycles: stopStart.values.stopStartCycles,

        // ── audit only: `cellPairCache.buildEntry` drops everything below this line ──
        provenance: Object.freeze({
          mode,
          distanceM: FIELD_PROVENANCE.PRODUCTION_EXTERNAL,
          travelSeconds: FIELD_PROVENANCE.PRODUCTION_DECLARED,
          travelSdSeconds: FIELD_PROVENANCE.PRODUCTION_DECLARED,
          travelSdSource: DECLARED_SPREAD_SOURCE,
          climbM: terrain.provenance,
          descentM: terrain.provenance,
          stopStartCycles: stopStart.provenance,
          speedMetresPerSecond: speedProvenance,
          evidenceAxis: Object.freeze({
            distanceM: EVIDENCE_AXIS[FIELD_PROVENANCE.PRODUCTION_EXTERNAL],
            travelSeconds: EVIDENCE_AXIS[FIELD_PROVENANCE.PRODUCTION_DECLARED],
            climbM: EVIDENCE_AXIS[terrain.provenance],
            stopStartCycles: EVIDENCE_AXIS[stopStart.provenance],
          }),
        }),
        terms: modelled.terms,
        endpoints: Object.freeze({ origin, destination }),
        // The identity this answer was computed under, echoed back so a caller writing an
        // audit record never has to trust that the request it sent is the one that was served.
        identity: Object.freeze({ ...request }),
      });
    },

    /**
     * What this router is, for a decision record or an adapter description.
     * @returns {string}
     */
    describe() {
      return (
        `RobotX production routing producer, mode ${mode}. distanceM from the self-hosted engine via ` +
        `${adapter.id || "an adapter"}; travelSeconds and travelSdSeconds from the owner's declared V1 campus model ` +
        `(buffer ${travelModel.bufferSecondsPer100m} s per 100 m, spread source ${DECLARED_SPREAD_SOURCE}); ` +
        `terrain ${typeof terrainSource === "function" ? "from a declared source" : "UNAVAILABLE — routes are refused"}; ` +
        `stopStartCycles ${typeof stopStartSource === "function" ? "from a declared source" : "UNAVAILABLE — routes are refused"}. ` +
        projection.describe()
      );
    },
  });
}

module.exports = {
  FIELD_PROVENANCE,
  EVIDENCE_AXIS,
  ROUTER_MODE,
  ROUTE_REFUSAL,
  TIME_BUCKET_COUNT,
  RouteRefusedError,
  normaliseRouteRequest,
  createProductionRouter,
};

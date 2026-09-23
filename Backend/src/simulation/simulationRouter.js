"use strict";

/**
 * The **DEVELOPMENT_SIMULATION routing producer** — the `route(parts)` seam for the V1
 * demonstration, and for nothing else.
 *
 * ── Why this module exists, and why it is not in `engine/routing/` ─────────
 * `routing/cellPairCache.read` falls through to `deps.route(parts)` on a miss, and
 * `workers/coordinatorPipeline.js` names that seam as requirement `route`, class
 * `EXTERNAL_ROUTING`, with the contract stated verbatim:
 *
 *     async ({ originCell, destCell, profileKey, timeBucket })
 *       => { distanceM, travelSeconds, travelSdSeconds, climbM, descentM, stopStartCycles }
 *
 * `routing/productionRouter.js` is that function **for production**, and it correctly
 * refuses today: OSRM returns no elevation, no shortlisted engine returns stop-start
 * cycles, and it will not invent either. That refusal is right and this module does not
 * touch it — `productionRouter.js` is unchanged, its `SIMULATION_IN_PRODUCTION` check is
 * unchanged, and nothing here is registered as a B1 adapter.
 *
 * What blocks the **demonstration** is a different thing. The V1 demonstration runs
 * simulated robots (`Robot.simulated = true`, `simulation/simulationPolicy.js`), and a
 * simulated robot's traversal happens in the simulator's own world. That world's geometry
 * is knowable — it is `VirtualRobot`'s — so a route through it can be *computed* rather
 * than invented. This module computes it, and labels every field as what it is.
 *
 * It lives in `src/simulation/` and not beside `productionRouter.js` deliberately. The
 * repository already keeps each simulation-side counterpart of an engine module here —
 * `simulatedEnergy.js` is the simulator's side of `engine/energy/consumption`,
 * `simulatedEnvironment.js` of the ambient model — and a simulated router sitting in the
 * directory the production routing seam lives in is precisely the confusion this whole
 * slice exists to prevent.
 *
 * ── The safety boundary is enforced HERE, at the producer ──────────────────
 * `cellPairCache.buildEntry` freezes a fixed eight-field entry and **drops** everything
 * else, so a `provenance` block attached to a route result does not survive into the
 * cache. `productionRouter.js` already states the consequence and it applies with more
 * force to this module: *a label that does not survive cannot be the control.* So the
 * control is refusal to produce, and it is checked twice:
 *
 *   1. **at construction** — `simulationPolicy.isSimulatorEnabled(env)` must be true, the
 *      mode must be stated explicitly as `DEVELOPMENT`, and every agent this router may
 *      serve must be `Robot.simulated === true`;
 *   2. **at every call** — the deployment is re-read, so a process that turns the
 *      simulator off stops getting simulated routes rather than keeping a router it
 *      constructed while it was on.
 *
 * Unlike `createProductionRouter`, whose default mode is `PRODUCTION` because that is *its*
 * fail-closed direction, this constructor has **no default mode at all**: a composition
 * that did not say is refused. The two defaults point the same way — away from a simulated
 * number being read as a production one.
 *
 * ── Where each of the six fields comes from ────────────────────────────────
 *
 *   `distanceM`        the great-circle distance between the two cells' projected
 *                      coordinates, via `utils/distance.haversineMeters` — **the same
 *                      function `VirtualRobot._stepAlongPath` advances on**. It is the
 *                      simulator's own measure of ground covered, not a routing engine's.
 *                      See `DISTANCE_IS_A_LOWER_BOUND` below: this is the *optimistic*
 *                      direction and is stated rather than dressed up.
 *
 *   `travelSeconds`    the owner's declared V1 campus travel model,
 *                      `routing/campusTravelModel.travelTimeFor`, over that distance. The
 *                      same arithmetic the production router uses — one formula, one
 *                      place — evaluated at a **simulated** speed, which is what makes the
 *                      answer simulated.
 *
 *   `travelSdSeconds`  the same model's declared spread, `DECLARED_SPREAD_SOURCE`
 *                      (`DECLARED_V1_OPERATIONAL_UNCERTAINTY`), carried under this
 *                      module's own source name so a reader can never mistake a simulated
 *                      spread for the production declaration.
 *
 *   `climbM`/`descentM`  **zero, and that is a measurement of the simulator, not of
 *                      RNSIT.** See `SIMULATED_TERRAIN_BASIS`.
 *
 *   `stopStartCycles`  one per hop. See `SIMULATED_STOP_START_BASIS`.
 *
 * ── Determinism (R10, §9.6) ───────────────────────────────────────────────
 * No clock, no randomness, no `Math.random`, no unordered iteration. `OBSTACLE_PROBABILITY`
 * exists in the simulator and is deliberately **not** modelled here: a router that sampled
 * it would answer differently on two workers in the same round.
 */

const { haversineMeters } = require("../utils/distance");
const simulationPolicy = require("./simulationPolicy");
const { SPEED_BASE_MS } = require("./constants");

const {
  travelTimeFor,
  DECLARED_SPREAD_SOURCE,
} = require("../engine/routing/campusTravelModel");
const { ProjectionError } = require("../engine/routing/cellProjection");
const {
  FIELD_PROVENANCE,
  EVIDENCE_AXIS,
  ROUTER_MODE,
  ROUTE_REFUSAL,
  RouteRefusedError,
  normaliseRouteRequest,
} = require("../engine/routing/productionRouter");

/**
 * Why a simulated route was refused, beyond the reasons `productionRouter.ROUTE_REFUSAL`
 * already names. Additive, for the same reason that one is additive to the adapter
 * contract's: these are about *who is executing*, which the production router's list has
 * no reason to describe.
 * @structural this producer's own refusal reasons
 */
const SIMULATION_REFUSAL = Object.freeze({
  /** The process is not running the simulator, so nothing here may be produced at all. */
  NOT_A_SIMULATED_DEPLOYMENT: "NOT_A_SIMULATED_DEPLOYMENT",
  /** An agent this router was asked to serve is not a simulated unit. */
  NOT_A_SIMULATED_AGENT: "NOT_A_SIMULATED_AGENT",
  /** A caller tried to have this producer's output labelled as production evidence. */
  PRODUCTION_PROVENANCE_CLAIMED: "PRODUCTION_PROVENANCE_CLAIMED",
});

/**
 * The declared source name every field this module produces is attributed to.
 *
 * It **names the production declaration it reuses** rather than replacing it, so a reader
 * who meets this string in a decision record, a log or the composed context can see both
 * that the arithmetic is the owner's V1 model and that the number is simulated. The two
 * halves are not separable: a bare `DECLARED_V1_OPERATIONAL_UNCERTAINTY` here would read
 * as the production declaration, which is exactly the masquerade the provenance vocabulary
 * exists to prevent.
 * @structural the declared simulation provenance name, not a tunable value
 */
const SIMULATED_SPREAD_SOURCE = `${FIELD_PROVENANCE.DEVELOPMENT_SIMULATION}:${DECLARED_SPREAD_SOURCE}`;

/**
 * The declared source name for the hop terrain this module produces, for
 * `coordinatorPipeline`'s `hop terrain (climbM / descentM / stopStartCycles)` requirement.
 * @structural the declared simulation terrain source name
 */
const SIMULATED_TERRAIN_SOURCE = `${FIELD_PROVENANCE.DEVELOPMENT_SIMULATION}:SIMULATOR_PLANAR_GEOMETRY`;

/**
 * **Why the simulated climb and descent are zero, and why that is not "assuming a flat
 * campus".**
 *
 * `VirtualRobot._stepAlongPath` advances the agent by `haversineMeters` over a list of
 * `{ lat, lon }` waypoints. There is no z coordinate anywhere in `src/simulation/`: not on
 * a waypoint, not on the agent, not in the telemetry frame, not in `simulatedEnvironment`.
 * A traversal in the simulated world therefore accumulates exactly **0 m** of climb and
 * **0 m** of descent — that is a property of the simulator, measurable by reading it, in
 * the same way `simulatedEnergy` reads `stopStartCycles` off the thing doing the stopping.
 *
 * It is **not** a statement about RNSIT's terrain, and it must never be read as one.
 * `simulation/simulatedEnergy.js` and `VirtualRobot._legProfileForTick` both refuse to pass
 * `0` into §14.2's model for exactly that reason — *"passing 0 would assert a flat campus,
 * which is unknown"* — and those refusals are correct and unchanged, because they are
 * modelling a **physical** leg. This module is modelling a **simulated** one, where the
 * elevation profile is not unknown: it is zero by construction.
 *
 * The discipline that keeps those two facts apart is provenance, and it is enforced by
 * refusal: this value is produced only in a simulated deployment, for a simulated agent,
 * and `productionRouter.js` still has no terrain source and still refuses a production
 * route. Nothing here closes the physical terrain gap.
 * @structural the stated basis of this producer's terrain values
 */
const SIMULATED_TERRAIN_BASIS =
  "DEVELOPMENT_SIMULATION. The simulated world has no elevation dimension — VirtualRobot " +
  "advances over {lat, lon} waypoints by haversine and no z coordinate exists anywhere in " +
  "src/simulation/ — so a simulated traversal accumulates exactly zero climb and zero " +
  "descent. This is a measurement of the simulator, NOT a claim that the RNSIT campus is " +
  "flat, and it is not admissible as a physical terrain measurement. No elevation source " +
  "exists in this deployment and routing/productionRouter.js still refuses without one.";

/** The simulated hop's climb, in metres. @structural see `SIMULATED_TERRAIN_BASIS` */
const SIMULATED_CLIMB_M = 0;

/** The simulated hop's descent, in metres. @structural see `SIMULATED_TERRAIN_BASIS` */
const SIMULATED_DESCENT_M = 0;

/**
 * **Why one stop-start cycle per hop.**
 *
 * `VirtualRobot._legProfileForTick` defines a cycle as *"a move that follows a stop"* and
 * counts it at the transition. In the simulated phase machine every hop ends at a stop the
 * agent holds at — `PICKUP_WAIT_MS`, `DROP_WAIT_MS`, or the charging dwell — before the
 * next hop begins moving. So exactly one stop-start cycle is attributable to each hop, by
 * the simulator's own definition of the count.
 *
 * **This is a floor and it is the optimistic direction.** The simulator also stops on
 * obstacle events (`OBSTACLE_PROBABILITY`, per tick while ACTIVE), and those stops are real
 * cycles that this number omits. They are omitted because they are *stochastic*: §9.6's
 * determinism requirement means two workers pricing the same hop in the same round must get
 * the same answer, and sampling an obstacle probability here would break that. Under-counting
 * cycles under-states energy, which is the direction that strands a vehicle — so this value
 * is admissible **only** because it is DEVELOPMENT_SIMULATION output that is never
 * production evidence, and it is stated here rather than presented as conservative.
 * @structural the stated basis of this producer's stop-start count
 */
const SIMULATED_STOP_START_BASIS =
  "DEVELOPMENT_SIMULATION. One cycle per hop: VirtualRobot counts a stop-start cycle as a " +
  "move following a stop, and every simulated hop ends at a stop the agent holds at before " +
  "the next hop starts. It is a FLOOR — obstacle-induced stops are stochastic and are not " +
  "modelled here because §9.6 requires two workers to price the same hop identically — so " +
  "it under-states cycles, and therefore energy. Admissible only as simulation output.";

/** The simulated hop's acceleration cycles. @structural see `SIMULATED_STOP_START_BASIS` */
const SIMULATED_STOP_START_CYCLES = 1;

/**
 * **Why the distance is a lower bound, stated rather than hidden.**
 *
 * The simulated agent drives `activePath`, which `services/executionGeometry.service`
 * populates from a provider polyline when one is available; a polyline between two points
 * is never shorter than the great circle between them. When no polyline is available the
 * agent has no path at all and refuses the offer. So the great-circle distance this module
 * computes is the *minimum* ground a simulated traversal could cover, and it is optimistic
 * in the same direction as the stop-start floor.
 *
 * It is used anyway, and the reason is that the alternative is worse: a detour factor
 * chosen here would be a number nobody declared, applied to make the estimate look
 * defensible. §20.3's intra-cell offset is added on top by `cellPairCache` in the
 * pessimistic direction, and the honest statement of the residual is this one.
 * @structural the stated basis of this producer's distance
 */
const DISTANCE_IS_A_LOWER_BOUND =
  "DEVELOPMENT_SIMULATION. Great-circle distance between the two cells' projected " +
  "coordinates, computed with utils/distance.haversineMeters — the same function " +
  "VirtualRobot._stepAlongPath advances on, so it is the simulator's own geometry. It is a " +
  "LOWER BOUND on the ground a simulated traversal covers, because the agent drives a " +
  "polyline when one exists. No detour factor is applied: none has been declared, and " +
  "inventing one to make the estimate look defensible is the fabrication this producer exists " +
  "to avoid making.";

/**
 * The simulated fleet's nominal speed, in metres per second, when a composition supplies
 * none.
 *
 * `simulation/constants.SPEED_BASE_MS` — the simulated class's own declared base speed,
 * which `VirtualRobot` already runs on. It is **not** D3's fleet measurement and is never
 * presented as one: a physical fleet's speed is `speedFor` on the production router and
 * this module cannot supply it.
 * @structural the simulator's own declared nominal speed, reused rather than restated
 */
const SIMULATED_NOMINAL_SPEED_MS = SPEED_BASE_MS;

/** @param {unknown} value @returns {boolean} */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Is this process running the simulator? Re-read on every route, never cached.
 *
 * @param {object|undefined} env
 * @throws {RouteRefusedError}
 */
function assertSimulatedDeployment(env) {
  if (simulationPolicy.isSimulatorEnabled(env)) return;
  throw new RouteRefusedError(
    SIMULATION_REFUSAL.NOT_A_SIMULATED_DEPLOYMENT,
    `this is the DEVELOPMENT_SIMULATION routing producer and ${simulationPolicy.SIMULATOR_ENV_VAR} is not "true" ` +
      `for this process (or ${simulationPolicy.LEGACY_DISABLE_ENV_VAR} is set). Simulation output is never ` +
      "production evidence (§23.5, ADR-31), and a simulated travel time read as a production one assigns real " +
      "work on invented numbers. The production seam is routing/productionRouter.js, which refuses until a " +
      "terrain source and a stop-start source are declared — that refusal is correct and this module does not " +
      "relax it",
  );
}

/**
 * May this router serve that agent?
 *
 * The predicate is `simulationPolicy.maySpawnVirtualRobot`, reused verbatim rather than
 * restated, so "this agent is simulated" means the same thing to the router as it does to
 * the thing that decides whether the agent exists at all. A second predicate here would be
 * a second answer to one question, which is the defect `simulationPolicy.js` was written
 * to end.
 *
 * @param {{ robotId?: string, simulated?: unknown }|null|undefined} robot
 * @param {object|undefined} env
 * @throws {RouteRefusedError}
 */
function assertSimulatedAgent(robot, env) {
  // The deployment first, so `maySpawnVirtualRobot`'s only reachable refusal below is
  // `ROBOT_NOT_SIMULATED`. Ordering it the other way would leave a branch for
  // `SIMULATOR_DISABLED` that can only be reached by a path that has already thrown — a
  // guard that cannot fire, which is the shape this programme keeps finding written.
  assertSimulatedDeployment(env);

  const verdict = simulationPolicy.maySpawnVirtualRobot(robot, { env });
  if (verdict.allowed) return;

  throw new RouteRefusedError(
    SIMULATION_REFUSAL.NOT_A_SIMULATED_AGENT,
    `agent "${String(robot && robot.robotId)}" is not a simulated unit — simulationPolicy.isSimulatedRobot() ` +
      "answered false — so the DEVELOPMENT_SIMULATION routing producer may not answer for it. This module " +
      "never reads the discriminator column itself; it asks the one module that owns that decision, which is " +
      "why `tests/engine/simulationBoundary.test.js`'s allow-list does not have to grow for it. " +
      "A physical unit's traversal happens in the world, not in the " +
      "simulator, and this module knows nothing about the world: its distance is the simulator's geometry, its " +
      "terrain is the simulator's absent elevation dimension and its stop-start count is the simulator's phase " +
      "machine. Route a physical agent through routing/productionRouter.js, which refuses until D1/D3/D8 supply " +
      "what it needs",
    { robotId: (robot && robot.robotId) || null },
  );
}

/**
 * Build the DEVELOPMENT_SIMULATION routing producer.
 *
 * @param {object} config
 *   * `projection` — from `routing/cellProjection.createCellProjection`; **required**. It
 *     is what refuses a cell whose representative coordinate is outside the declared
 *     serviceable campus boundary, and it is the same instrument the production router
 *     uses. No second boundary test is written here.
 *   * `travelModel` — `{ bufferSecondsPer100m, sdBufferMultiple }` from
 *     `routing/campusTravelModel.resolveModelParameters`; **required**.
 *   * `agents` — the rows this router may serve, each shaped like `Robot`
 *     (`{ robotId, simulated }`); **required and non-empty**. Every one must be
 *     `simulated === true`.
 *   * `mode` — must be stated, and must be `ROUTER_MODE.DEVELOPMENT`. There is no default.
 *   * `speedFor(profileKey)` — metres per second; optional. Absent, the simulated class's
 *     own `SIMULATED_NOMINAL_SPEED_MS` is used, which is a declared simulator constant and
 *     not a fleet measurement.
 *   * `env` — defaults to `process.env`; injected so a test need not mutate it.
 * @returns {object}
 * @throws {RouteRefusedError}
 */
function createSimulationRouter(config) {
  const source = config || {};
  const env = source.env;
  const problems = [];

  // Checked first and on its own: a composition built in a non-simulated process is not a
  // malformed request, it is a request that must not exist.
  assertSimulatedDeployment(env);

  if (source.mode !== ROUTER_MODE.DEVELOPMENT) {
    problems.push(
      `mode must be stated explicitly as "${ROUTER_MODE.DEVELOPMENT}" and was ${JSON.stringify(source.mode)}. ` +
        "There is deliberately no default: createProductionRouter defaults to PRODUCTION because that is its " +
        "fail-closed direction, and a producer of simulated values has no safe default at all",
    );
  }
  if (!source.projection || typeof source.projection.project !== "function") {
    problems.push(
      "projection is required — routing/cellProjection.createCellProjection(), which checks every projected " +
        "coordinate against the declared serviceable region and refuses one outside it. An endpoint off the " +
        "campus is refused here exactly as it is for a production route",
    );
  }
  if (
    !source.travelModel ||
    !isFiniteNumber(source.travelModel.bufferSecondsPer100m) ||
    !isFiniteNumber(source.travelModel.sdBufferMultiple)
  ) {
    problems.push(
      "travelModel { bufferSecondsPer100m, sdBufferMultiple } is required — resolve it with " +
        "routing/campusTravelModel.resolveModelParameters(snapshot, scope). The owner's declared V1 arithmetic is " +
        "reused rather than restated, so the demonstration and production compute travel time the same way",
    );
  }
  if (!Array.isArray(source.agents) || source.agents.length === 0) {
    problems.push(
      "agents is required and must be a non-empty list of the rows this router may serve, each shaped like " +
        "Robot ({ robotId, simulated }). It is what makes \"only simulated execution\" checkable at composition " +
        "time rather than at the four-field route seam, which carries no agent identity at all",
    );
  }
  if (
    source.speedProvenance !== undefined &&
    source.speedProvenance !== FIELD_PROVENANCE.DEVELOPMENT_SIMULATION
  ) {
    problems.push(
      `speedProvenance was ${JSON.stringify(source.speedProvenance)}. This producer emits ` +
        `${FIELD_PROVENANCE.DEVELOPMENT_SIMULATION} and nothing else; it cannot be given a production label, ` +
        "because the number it would be attached to was computed from the simulator's geometry",
    );
  }
  if (source.speedFor !== undefined && typeof source.speedFor !== "function") {
    problems.push("speedFor, when supplied, must be a function (profileKey) -> metres per second");
  }

  if (problems.length > 0) {
    throw new RouteRefusedError(
      ROUTE_REFUSAL.MALFORMED_REQUEST,
      `the simulation router cannot be composed:\n  - ${problems.join("\n  - ")}`,
      { problems },
    );
  }

  // Every agent, now, at composition — not lazily on the first route. A roster containing
  // one physical unit refuses the whole composition, because the seam `cellPairCache` calls
  // carries no agent identity and a per-call check therefore cannot exist.
  for (const agent of source.agents) assertSimulatedAgent(agent, env);

  const { projection, travelModel } = source;
  const agents = Object.freeze(
    source.agents.map((agent) => String((agent && agent.robotId) || "")).slice().sort(),
  );
  const speedFor =
    typeof source.speedFor === "function" ? source.speedFor : () => SIMULATED_NOMINAL_SPEED_MS;

  return Object.freeze({
    mode: ROUTER_MODE.DEVELOPMENT,
    /** Every field this producer emits carries this, and only this. */
    provenance: FIELD_PROVENANCE.DEVELOPMENT_SIMULATION,
    /** The agent ids this router will answer for, sorted. */
    agents,

    /**
     * **The `deps.route(parts)` seam.** `cellPairCache.read` calls exactly this.
     *
     * Deliberately **no** `matrix(request)` method: `tools/routing/adapters/index.js`
     * decides whether a module is a measurable B1 candidate by asking for one, and
     * `productionRouter.createProductionRouter` requires one of its adapter. Without it
     * this object cannot be mistaken for either, which is a structural refusal rather than
     * a documented intention.
     *
     * @param {object} parts `{ originCell, destCell, profileKey, timeBucket }`
     * @returns {Promise<object>} the six contract fields, plus a non-contract `provenance`
     *   block that `cellPairCache.buildEntry` will drop.
     * @throws {RouteRefusedError}
     */
    async route(parts) {
      // Re-read, every call. A process that turns the simulator off stops producing
      // simulated routes, rather than keeping the ones a warm router would still answer.
      assertSimulatedDeployment(env);

      const request = normaliseRouteRequest(parts);

      let origin;
      let destination;
      try {
        origin = projection.project(request.originCell);
        destination = projection.project(request.destCell);
      } catch (error) {
        if (error instanceof ProjectionError) {
          throw new RouteRefusedError(
            error.refusal === "OUTSIDE_SERVICEABLE_REGION"
              ? ROUTE_REFUSAL.OUTSIDE_SERVICEABLE_REGION
              : ROUTE_REFUSAL.MALFORMED_REQUEST,
            error.reason,
            { refusal: error.refusal },
          );
        }
        throw error;
      }

      const distanceM = haversineMeters(origin.lat, origin.lon, destination.lat, destination.lon);
      if (!isFiniteNumber(distanceM) || distanceM < 0) {
        throw new RouteRefusedError(
          ROUTE_REFUSAL.NOT_ROUTABLE,
          `the simulated geometry produced ${JSON.stringify(distanceM)} metres between "${request.originCell}" ` +
            `and "${request.destCell}"`,
        );
      }

      const speedMetresPerSecond = speedFor(request.profileKey);
      if (!isFiniteNumber(speedMetresPerSecond) || speedMetresPerSecond <= 0) {
        throw new RouteRefusedError(
          ROUTE_REFUSAL.NO_SPEED,
          `no simulated speed is available for routing profile "${request.profileKey}". The simulated class's own ` +
            `nominal speed is ${SIMULATED_NOMINAL_SPEED_MS} m/s (simulation/constants.SPEED_BASE_MS) and is used ` +
            "when a composition supplies none; a supplied speedFor that answers with something else is refused " +
            "rather than replaced, because silently substituting one would hide a broken composition",
        );
      }

      const modelled = travelTimeFor({
        distanceM,
        speedMetresPerSecond,
        bufferSecondsPer100m: travelModel.bufferSecondsPer100m,
        sdBufferMultiple: travelModel.sdBufferMultiple,
      });
      if (!modelled.ok) {
        throw new RouteRefusedError(
          ROUTE_REFUSAL.MODEL_REFUSED,
          `the V1 campus travel model refused:\n  - ${modelled.problems.join("\n  - ")}`,
        );
      }

      // Named `simulatedProvenance` and not `simulated`: `tests/engine/simulationBoundary.test.js`
      // scans `src/` for reads of the discriminator column by token, and a local called
      // `simulated` would register as one. Evading that detector with a differently-spelled
      // read would be worse than a listed one — so the name is changed because this is not
      // a read of the column at all, and the detector is right to say so.
      const simulatedProvenance = FIELD_PROVENANCE.DEVELOPMENT_SIMULATION;

      return Object.freeze({
        // ── the six contract fields ──
        distanceM,
        travelSeconds: modelled.travelSeconds,
        travelSdSeconds: modelled.travelSdSeconds,
        climbM: SIMULATED_CLIMB_M,
        descentM: SIMULATED_DESCENT_M,
        stopStartCycles: SIMULATED_STOP_START_CYCLES,

        // ── audit only: `cellPairCache.buildEntry` drops everything below this line,
        //    which is why the control is the refusals above and not this block ──
        provenance: Object.freeze({
          mode: ROUTER_MODE.DEVELOPMENT,
          distanceM: simulatedProvenance,
          travelSeconds: simulatedProvenance,
          travelSdSeconds: simulatedProvenance,
          travelSdSource: SIMULATED_SPREAD_SOURCE,
          climbM: simulatedProvenance,
          descentM: simulatedProvenance,
          stopStartCycles: simulatedProvenance,
          speedMetresPerSecond: simulatedProvenance,
          terrainSource: SIMULATED_TERRAIN_SOURCE,
          evidenceAxis: Object.freeze({
            distanceM: EVIDENCE_AXIS[simulatedProvenance],
            travelSeconds: EVIDENCE_AXIS[simulatedProvenance],
            travelSdSeconds: EVIDENCE_AXIS[simulatedProvenance],
            climbM: EVIDENCE_AXIS[simulatedProvenance],
            descentM: EVIDENCE_AXIS[simulatedProvenance],
            stopStartCycles: EVIDENCE_AXIS[simulatedProvenance],
          }),
        }),
        basis: Object.freeze({
          distanceM: DISTANCE_IS_A_LOWER_BOUND,
          terrain: SIMULATED_TERRAIN_BASIS,
          stopStartCycles: SIMULATED_STOP_START_BASIS,
        }),
        terms: modelled.terms,
        endpoints: Object.freeze({ origin, destination }),
        identity: Object.freeze({ ...request }),
      });
    },

    /**
     * Re-assert that one agent may be served, for a caller holding a row this router was
     * not composed with.
     *
     * @param {object} robot
     * @throws {RouteRefusedError}
     */
    assertAgent(robot) {
      assertSimulatedAgent(robot, env);
    },

    /**
     * What this router is, for a decision record or a log line.
     * @returns {string}
     */
    describe() {
      return (
        "RobotX DEVELOPMENT_SIMULATION routing producer. NOT a production router and NOT a B1 adapter: it " +
        "exposes no matrix(), it is absent from tools/routing/adapters, and every field it emits is " +
        `${FIELD_PROVENANCE.DEVELOPMENT_SIMULATION}. distanceM is the simulator's own haversine geometry; ` +
        `travelSeconds and travelSdSeconds are the owner's declared V1 campus model (buffer ` +
        `${travelModel.bufferSecondsPer100m} s per 100 m, spread source ${SIMULATED_SPREAD_SOURCE}) at a ` +
        `simulated speed; climb/descent are ${SIMULATED_CLIMB_M} m because the simulated world has no elevation ` +
        `dimension; stopStartCycles is ${SIMULATED_STOP_START_CYCLES} per hop by the simulator's own definition. ` +
        `Serves ${agents.length} simulated agent(s). ` +
        projection.describe()
      );
    },
  });
}

/**
 * The context fragment a **V1 demonstration** composition root spreads into the settings
 * `workers/coordinatorSolvePath.contextFor` reads.
 *
 * This is the wiring, and it is deliberately the narrowest thing that can be called one:
 * three of `coordinatorPipeline`'s `EXTERNAL_ROUTING` requirements are satisfied by naming
 * what this producer supplies, and **nothing else in the context is touched**. No solver
 * input, no Safety parameter, no register binding, no cost term. A composition root that
 * spreads this fragment still refuses on everything else it is missing, and
 * `gate:composition` is unmoved.
 *
 * It is not imported by anything in the production composition path, and it cannot be: the
 * router it builds refuses to be constructed in a process that is not running the simulator.
 *
 * @param {object} config as `createSimulationRouter`
 * @returns {{ route: Function, hopTerrainSource: string, travelTimeSpread: string,
 *             speedMetresPerSecondFor: Function, router: object }}
 */
function demonstrationRoutingSeam(config) {
  const router = createSimulationRouter(config);
  const source = config || {};
  const speedFor =
    typeof source.speedFor === "function" ? source.speedFor : () => SIMULATED_NOMINAL_SPEED_MS;

  return Object.freeze({
    /** `coordinatorPipeline` requirement `route`. */
    route: (parts) => router.route(parts),
    /** `coordinatorPipeline` requirement `hop terrain (climbM / descentM / stopStartCycles)`. */
    hopTerrainSource: SIMULATED_TERRAIN_SOURCE,
    /** `coordinatorPipeline` requirement `travelSdSeconds source (N29)`. */
    travelTimeSpread: SIMULATED_SPREAD_SOURCE,
    /**
     * `coordinatorPipeline` requirement `speedMetresPerSecond (per routing profile)`, which
     * `cellPairCache.applyIntraCellOffset` also reads to price §20.3's quantisation.
     */
    speedMetresPerSecondFor: (profileKey) => speedFor(profileKey),
    router,
  });
}

module.exports = {
  SIMULATION_REFUSAL,
  SIMULATED_SPREAD_SOURCE,
  SIMULATED_TERRAIN_SOURCE,
  SIMULATED_TERRAIN_BASIS,
  SIMULATED_STOP_START_BASIS,
  DISTANCE_IS_A_LOWER_BOUND,
  SIMULATED_CLIMB_M,
  SIMULATED_DESCENT_M,
  SIMULATED_STOP_START_CYCLES,
  SIMULATED_NOMINAL_SPEED_MS,
  createSimulationRouter,
  demonstrationRoutingSeam,
};

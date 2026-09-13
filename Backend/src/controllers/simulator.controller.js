const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const simulatedRobotService = require("../services/simulatedRobot.service");
// STEP 3 — one public Robot shape, shared with the physical robot endpoints. This
// controller used to strip the owner and attach the specification by hand; both are now
// `robotProjection`'s, so the simulated-creation response and the robot list cannot
// disagree about what a robot payload contains.
const robotProjection = require("../services/robotProjection");
// One writer for the `robot:{id}` live-state key, shared with the physical commissioning
// controller. Two writers of one key shape is one that drifts.
const { writeRobotLiveState } = require("./robots.controller");

function getSimulator(req, res) {
  const sim = req.app?.locals?.virtualSimulator;
  if (!sim) {
    res.status(503).json({ error: "Virtual robot simulator is not initialised" });
    return null;
  }
  return sim;
}

const getStatus = asyncHandler(async (req, res) => {
  const sim = req.app?.locals?.virtualSimulator;
  if (!sim) return res.status(503).json({ error: "Simulator not initialised" });
  res.json(sim.getStatus());
});

// POST /api/simulator/start — (re)start the engine and every robot it holds.
//
// STEP 4: `start` now reports how many robots are actually running, because it now actually
// starts them. It used to set a flag: a fleet stopped by `POST /stop` stayed dead through
// the next `POST /start`, while `GET /status` reported `started: true` and the dashboard
// therefore labelled every simulated unit RUNNING.
const startSimulator = asyncHandler(async (req, res) => {
  const sim = getSimulator(req, res);
  if (!sim) return;
  const outcome = await sim.start();
  res.json({ ok: true, start: outcome ?? null, status: sim.getStatus() });
});

const stopSimulator = asyncHandler(async (req, res) => {
  const sim = getSimulator(req, res);
  if (!sim) return;
  sim.stop();
  res.json({ ok: true });
});

const resetSimulator = asyncHandler(async (req, res) => {
  const sim = getSimulator(req, res);
  if (!sim) return;
  sim.reset();
  res.json({ ok: true, status: sim.getStatus() });
});

// PATCH /api/simulator/config — apply the closed set of simulator tunables.
//
// ── STEP 4: this used to answer `{ ok: true }` unconditionally ────────────────
// `setConfig` was a no-op, so every request was discarded and every response said it had
// succeeded. A misspelled field, an out-of-range value and a correct request were
// indistinguishable to the caller, which is why an operator could not make a demo
// repeatable: there was nothing to discover, only something to conclude.
//
// The engine now validates against a closed nine-parameter set and returns the problems,
// so a refusal is a 400 that names the field. Protected robot identity and specification
// fields are refused by name — they are properties of the `Robot` row, written at
// commissioning, and a simulator tuning endpoint that could write them would be a second
// commissioning API without the role gate the first one has.
const setConfig = asyncHandler(async (req, res) => {
  const sim = getSimulator(req, res);
  if (!sim) return;

  const outcome = sim.setConfig(req.body || {});

  // An engine that has not been updated to return a verdict (a test double, say) is not
  // treated as a refusal — but it is not reported as a success either, because nothing
  // here knows what it did.
  if (!outcome || typeof outcome !== "object") {
    return res.json({ ok: true, applied: null, detail: "the simulator reported no configuration verdict" });
  }

  if (outcome.ok === false) {
    return res.status(400).json({
      error: "INVALID_SIMULATOR_CONFIG",
      detail: "The simulator configuration was refused; nothing was changed.",
      problems: outcome.problems || [],
    });
  }

  res.json({
    ok: true,
    config: outcome.config,
    // Stated separately because they are different promises: one has already taken effect
    // on the running fleet, the other will take effect for robots created next.
    appliedLive: outcome.appliedLive || [],
    appliesToNewRobots: outcome.appliesToNewRobots || [],
    robotsUpdated: outcome.robotsUpdated || 0,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/simulator/robot — create exactly ONE simulated robot per request.
//
// ── Why a dedicated endpoint rather than a flag on commissioning ─────────────
// Because the two flows are different acts with different authorities. Physical
// commissioning records a device somebody bought and installed: the operator names it,
// and it later proves who it is by pairing. Simulated creation provisions a test agent:
// the *server* names it, no hardware will ever claim it, and only a SUPER_ADMIN may ask
// for one. Expressing the second as a boolean on the first is what let
// `POST /api/robots { simulated: true }` create simulated units with no record of who
// made them and no role check at all.
//
// ── One robot per request. Not a count, not a fleet ──────────────────────────
// There is no `count` parameter and no batch form; the service refuses a body that carries
// one. A SUPER_ADMIN builds up SIM-001, SIM-002, SIM-003… by sending this request three
// times — there is no limit on how many they may have, and equally no single request that
// can make several. The `SimulationEngine` manages an arbitrary number of `VirtualRobot`s,
// which is a runtime capability and not a creation API.
//
// ── The response never claims more than happened ─────────────────────────────
// Two independent facts, reported separately:
//
//   * the Robot row was created — that is what the 201 is about;
//   * whether a `VirtualRobot` is actually running — that is `simulator.running`.
//
// With `ENABLE_VIRTUAL_SIMULATOR` unset (the default since Step 1), the row is created and
// **nothing is running**, so the response says `running: false` with the engine's own
// refusal reason. It does not fabricate `isOnline`, and it does not report a simulator as
// started because a request to start one was made. `status` names the two outcomes so a
// caller does not have to infer the distinction from a boolean it might not read.
// ─────────────────────────────────────────────────────────────────────────────
const createSimulatedRobot = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const kv = req.app?.locals?.kv;
  const io = req.app?.locals?.io;

  // The creator is the authenticated operator, full stop. `authUser` has already resolved
  // the session to a `User` row and `requireElevatedRole()` has already established that
  // its role is SUPER_ADMIN; the body is not consulted for identity, and the service
  // refuses a body that tries to supply one.
  const robot = await simulatedRobotService.createSimulatedRobot(prisma, req.body, {
    ownerId: req.user?.id ?? null,
  });

  // ── Start the simulation through the one funnel that may construct one ─────
  //
  // `SimulationEngine.addRobot` re-reads the row and applies `simulationPolicy` to it, so
  // this call site cannot talk it into spawning anything: it returns a verdict, and the
  // verdict is what the response reports. The engine remains the only module that
  // constructs a VirtualRobot, and `tests/engine/simulationBoundary.test.js` holds that —
  // strictly enough that it flagged the sentence this comment replaced, which merely
  // *mentioned* the constructor.
  const virtualSimulator = req.app?.locals?.virtualSimulator;
  let simulator = { running: false, reason: "SIMULATOR_NOT_INITIALISED" };

  if (virtualSimulator && typeof virtualSimulator.addRobot === "function") {
    try {
      const verdict = await virtualSimulator.addRobot({
        robotId: robot.robotId,
        lat: typeof robot.lat === "number" ? robot.lat : null,
        lon: typeof robot.lon === "number" ? robot.lon : null,
        simulated: true,
      });
      simulator = {
        running: verdict?.started === true,
        reason: verdict?.started === true ? null : verdict?.reason || "UNKNOWN",
      };
    } catch (e) {
      // The Robot row is committed; a simulator that failed to start is reported as not
      // running rather than turned into a 500 the caller would retry — a retry would
      // create a *second* robot while the caller believed the first had failed entirely.
      (req.app?.locals?.logger || console).warn(
        `[simulator] addRobot failed for ${robot.robotId}: ${e?.message}`,
      );
      simulator = { running: false, reason: "ADD_ROBOT_THREW" };
    }
  }

  // Redis live state + the dashboard event, exactly as physical commissioning does. Both
  // report `isOnline` from the row, which is `false`: a created row is not a session, and
  // a simulated agent earns its online state by connecting and authenticating, the same
  // way hardware does.
  try {
    await writeRobotLiveState(kv, robot, { exSeconds: 15 });
  } catch {
    // ignore KV failures
  }

  const livePayload = {
    robotId: robot.robotId,
    lat: robot.lat,
    lon: robot.lon,
    battery: robot.battery,
    status: robot.status || "IDLE",
    speed: robot.speed || 0,
    isOnline: robot.isOnline === true,
    simulated: robot.simulated === true,
  };

  try {
    io?.to("dashboard")?.emit("ROBOT_COMMISSIONED", {
      ...livePayload,
      locationId: robot.locationId || null,
      campusId: robot.campusId || null,
      name: robot.name || null,
    });
  } catch {
    // ignore
  }

  // ── What is deliberately absent from this response ────────────────────────
  // The creator. The caller *is* the creator — it is their own session id, so telling them
  // adds nothing — and keeping operator identity off the robot projection is what stops
  // it from leaking through the surfaces that echo robot payloads onward
  // (`ROBOT_COMMISSIONED` above, the list overlay, telemetry). `robotProjection` removes
  // it for every robot response, not just this one, which is the STEP 3 change: the leak
  // this hand-written strip closed here was still open on `GET /api/robots/state`.
  res.status(201).json({
    ok: true,
    status: simulator.running ? "RUNNING" : "PERSISTED_NOT_RUNNING",
    robot: robotProjection.toPublicRobot(robot),
    simulator,
  });
});

module.exports = {
  getStatus,
  startSimulator,
  stopSimulator,
  resetSimulator,
  setConfig,
  createSimulatedRobot,
};

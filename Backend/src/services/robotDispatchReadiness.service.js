"use strict";

/**
 * Why a robot is — or is not — ready to be offered work, as one operator-facing answer.
 * `GET /api/diagnostics/readiness/:robotId`.
 *
 * ── Visible and connected are not ready ────────────────────────────────────
 * A robot on the map is a `Robot` row. A connected one has an authenticated socket. Neither is a
 * candidate: the round only considers an agent the availability index holds, and only offers work
 * to one that passes every §7.5 predicate. This report keeps those layers apart:
 *
 *   visible     the row exists and is not retired
 *   connected   an authenticated, live socket
 *   lifecycle   F2 — only ACTIVE is ever considered
 *   indexed     an AgentCellPosition row: what the round can discover at all
 *   position    the newest MEASURED fix, its age and quality (`robotPosition`)
 *   readiness   the agent's own report of what would make it refuse an offer (`agentReadiness`)
 *   engine      every agent-level predicate, evaluated as the round would, ALL of them
 *
 * ── The engine section ─────────────────────────────────────────────────────
 * The agent is read through the round's own mapper (`coordinatorSolvePath.agentSnapshotFrom`) and
 * the same composed facts provider (`app.locals.engineSeams`), then evaluated by
 * `feasibility/evaluate.evaluateCandidate` with `collectAll` — the gate's documented diagnostic
 * mode, whose verdict is identical to the short-circuit one. The normal assignment path is not
 * touched: it still stops at the first denial, and nothing here is recorded or acted on.
 *
 * Only the three agent-level groups (identity/lifecycle, safety/health, connectivity) are reported
 * as this robot's gates. A predicate in them that needs a mission to answer, and every predicate in
 * the other four groups (availability, capability/payload, spatial, computed mission feasibility:
 * route, energy, timing), is listed as decided per task — a robot that passes every gate here can
 * still be refused for a particular task.
 */

const coordinatorSolvePath = require("../workers/coordinatorSolvePath");
const evaluate = require("../engine/feasibility/evaluate");
const { PREDICATES, GROUP } = require("../engine/feasibility/register");
const robotRetirementPolicy = require("./robotRetirementPolicy");
const simulationPolicy = require("../simulation/simulationPolicy");
const robotPosition = require("./robotPosition.service");
const agentReadiness = require("./agentReadiness.service");
const { POLICY: PHYSICAL_POLICY } = require("./fleetProviders/physicalPolicy");
const { safeJsonParse } = require("../utils/json");

/** @structural the register's agent-level groups */
const AGENT_GROUPS = Object.freeze([GROUP.IDENTITY_AND_LIFECYCLE, GROUP.SAFETY_AND_HEALTH, GROUP.CONNECTIVITY_AND_COMMANDABILITY]);

/** @structural the input sources a mission-dependent verdict names */
const MISSION_INPUT_SOURCES = Object.freeze(["MISSION", "PLAN"]);

/**
 * Does this verdict depend on a mission the diagnostic does not have? Read from the verdict itself:
 * an absent/indeterminate answer that names the mission, its plan, its Leg, its SLA class or its
 * environment (F10's threshold is per mission environment — `environment "null"` here) as the
 * missing input. An agent-side absence (no localisation, no session, no latch) is never one.
 */
function needsTask(verdict) {
  if (!verdict || verdict.outcome === "SATISFIED" || verdict.outcome === "VIOLATED") return false;
  if (MISSION_INPUT_SOURCES.includes(verdict.inputSource)) return true;
  const text = `${verdict.reason || ""} ${JSON.stringify(verdict.missing || "")}`.toLowerCase();
  return /\bmission\b|\bplan\b|\bleg\b|sla.class|environment "null"/.test(text);
}

/**
 * @param {object} input
 * @param {object} input.prisma
 * @param {object} [input.kv]
 * @param {object|null} [input.snapshot] the pinned configuration (`app.locals.config`)
 * @param {object|null} [input.seams] the composed coordinator seams (`app.locals.engineSeams`)
 * @param {object|null} [input.physicalPolicy] `app.locals.physicalFleetPolicy`
 * @param {string} input.robotId
 * @param {number} [input.nowMs]
 * @returns {Promise<object|null>} null when no such robot
 */
async function assessDispatchReadiness(input) {
  const { prisma, kv, snapshot, seams, physicalPolicy, robotId } = input || {};
  const nowMs = input && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();

  const agentInclude = coordinatorSolvePath.agentSnapshotInclude().agent.include;
  const robot = await prisma.robot.findUnique({ where: { robotId }, include: { agent: { include: agentInclude } } });
  if (!robot) return null;
  const agent = robot.agent || null;

  const cell = agent ? await prisma.agentCellPosition.findUnique({ where: { agentId: agent.id } }) : null;
  const freshnessBoundMs = robotPosition.freshnessBoundMsFrom(snapshot || null);
  const declared = physicalPolicy && typeof physicalPolicy.robotFor === "function" ? physicalPolicy.robotFor(robotId) : null;

  const record = await robotPosition.latestMeasuredPosition({ prisma, kv, robotId, nowMs });
  const position = robotPosition.describePosition(record, {
    nowMs,
    freshnessBoundMs,
    acceptedFixTypes: physicalPolicy && physicalPolicy.localisation ? physicalPolicy.localisation.acceptedFixTypes : null,
  });
  const readiness = agentReadiness.describeReadiness(
    agentReadiness.assessReadiness({
      state: kv ? await agentReadiness.readReadiness(kv, robotId).catch(() => null) : null,
      robotId,
      socketId: robot.socketId || null,
      asOfMs: nowMs,
      freshnessBoundMs,
    }),
    { required: declared ? physicalPolicy.readiness === PHYSICAL_POLICY.AGENT_REPORT_REQUIRED : null },
  );
  let batteryProvenance = null;
  if (kv) {
    const live = safeJsonParse(await kv.get(`robot:${robotId}`).catch(() => null));
    batteryProvenance = live && typeof live.batteryProvenance === "string" ? live.batteryProvenance : null;
  }

  const engine = await evaluateAgentGates({ prisma, kv, snapshot, seams, agent, cell, nowMs });

  const lifecycleState = agent ? agent.lifecycleState : null;
  const connected = robot.isOnline === true && typeof robot.socketId === "string" && robot.socketId !== "";
  const blockers = [];
  if (!agent) blockers.push({ code: "NO_AGENT", detail: "the robot has no engine Agent row" });
  else if (lifecycleState !== "ACTIVE") {
    blockers.push({
      code: "LIFECYCLE_NOT_ACTIVE",
      detail: `lifecycle ${lifecycleState}: only ACTIVE agents are considered (F2). A physical unit becomes ACTIVE only when the owner's physical fleet declaration is applied at boot`,
    });
  }
  if (!connected) blockers.push({ code: "NOT_CONNECTED", detail: "no live authenticated connection" });
  if (agent && !cell) {
    blockers.push({
      code: "NOT_INDEXED",
      detail: "not in the availability index, so no round can discover it (needs ACTIVE, a measured position, a known charging/availability state and a shard)",
    });
  }
  if (!position.measured) blockers.push({ code: "NO_MEASURED_POSITION", detail: "no measured position fix on record" });
  else if (!position.fresh) {
    blockers.push({ code: "POSITION_STALE", detail: `the newest measured fix is ${Math.round(position.ageMs / 1000)} s old (bound ${Math.round((freshnessBoundMs || 0) / 1000)} s; F16)` });
  }
  for (const code of readiness.current ? readiness.blockers : []) blockers.push({ code: `AGENT_NOT_READY:${code}`, detail: "reported by the agent" });
  if (readiness.required === true && !readiness.current) blockers.push({ code: "READINESS_NOT_REPORTED", detail: readiness.reason });
  for (const gate of engine.agentGates) {
    if (!gate.passed && !gate.needsTask) blockers.push({ code: gate.predicateId, detail: `${gate.title}: ${gate.reason || gate.outcome}` });
  }

  return {
    robotId,
    simulated: simulationPolicy.isSimulatedRobot(robot),
    asOf: new Date(nowMs).toISOString(),
    visible: !robotRetirementPolicy.isRetiredRobot(robot),
    connected,
    status: robot.status,
    lifecycleState,
    indexed: Boolean(cell),
    position,
    readiness,
    batteryProvenance,
    engine: { evaluated: engine.evaluated, reason: engine.reason, agentGates: engine.agentGates, decidedPerTask: engine.decidedPerTask },
    // Necessary, never sufficient: route, energy, payload and timing are decided per task.
    dispatchReady: blockers.length === 0 && engine.evaluated,
    blockers,
    note:
      "dispatchReady means no robot-level blocker was found. Each offer is still decided per task by the " +
      "engine (route, energy, payload, timing), and the robot itself may refuse it.",
  };
}

/**
 * Every agent-level predicate, evaluated with `collectAll` against the agent as the round reads it.
 * @returns {Promise<{ evaluated: boolean, reason: string|null, agentGates: object[], decidedPerTask: string[] }>}
 */
async function evaluateAgentGates({ prisma, kv, snapshot, seams, agent, cell, nowMs }) {
  const perTask = PREDICATES.filter((row) => !AGENT_GROUPS.includes(row.group)).map((row) => row.id);
  const none = (reason) => ({ evaluated: false, reason, agentGates: [], decidedPerTask: perTask });
  if (!agent) return none("the robot has no engine Agent row");
  if (!seams || typeof seams.agentFactsFor !== "function") {
    return none("the engine's composition is not running in this process (ENGINE_ENABLED, or no fleet composition): no facts provider to evaluate with");
  }

  // The agent row as the index mirror carries it — or, for an agent the index does not hold, with
  // no position at all (which is itself what F16 and the index then report).
  const positionRow = cell
    ? { ...cell, agent }
    : {
        agentId: agent.id,
        shardId: null,
        lat: null,
        lon: null,
        fineCellId: null,
        coarseCellId: null,
        availabilityClass: null,
        capabilityClasses: [],
        containerClasses: [],
        observedAtMs: null,
        agent,
      };

  let outcome;
  try {
    const agentSnapshot = await coordinatorSolvePath.agentSnapshotFrom(
      { prisma, kv, snapshot: () => snapshot, agentFactsFor: seams.agentFactsFor, environmentFor: seams.environmentFor },
      positionRow,
      nowMs,
    );
    // The gate's own config view: the pinned snapshot resolved at the agent's class scope, as the
    // round resolves it (`coordinatorSolvePath.evaluateExactFor`, `gateScope`), minus the SLA class
    // only a task supplies.
    const scope = { sla_class: null, agent_class: agentSnapshot ? agentSnapshot.agentClassId ?? null : null };
    const config = {
      get: (name) => {
        if (!snapshot || typeof snapshot.resolve !== "function") return undefined;
        try {
          return snapshot.resolve(name, scope);
        } catch {
          return undefined;
        }
      },
    };
    outcome = evaluate.evaluateCandidate({ agentSnapshot, mission: null, plan: null, config, decisionTimeMs: nowMs }, { collectAll: true });
  } catch (error) {
    return none(`the agent could not be evaluated: ${error && error.message}`);
  }

  const denied = new Set(outcome.denials.map((denial) => denial.predicateId));
  const agentGates = PREDICATES.filter((row) => AGENT_GROUPS.includes(row.group)).map((row) => {
    const verdict = outcome.verdicts[row.id] || null;
    return {
      predicateId: row.id,
      title: row.name,
      group: row.group,
      outcome: verdict ? verdict.outcome : null,
      passed: Boolean(verdict) && !denied.has(row.id),
      needsTask: needsTask(verdict),
      reason: verdict ? verdict.reason || null : null,
    };
  });
  return { evaluated: true, reason: null, agentGates, decidedPerTask: perTask };
}

module.exports = { AGENT_GROUPS, assessDispatchReadiness, needsTask };

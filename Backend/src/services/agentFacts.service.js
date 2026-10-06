"use strict";

/**
 * The **agent-facts provider** — the seam that supplies the §7.5 agent facts the snapshot
 * loader cannot read from a column, for BOTH kinds of agent.
 *
 * ── Two halves, kept apart ─────────────────────────────────────────────────
 *
 *   1. **Derived from real rows — both simulated and physical.** Every agent has a Robot
 *      row kept current by its socket and telemetry, and a position Observation stream:
 *        · F13 session        ← `Robot.isOnline`, `Robot.lastSeenAt`
 *        · F9 health tier     ← `Robot.status` (§16.4's order, see `HEALTH_TIER_BY_STATUS`)
 *        · F16 observations   ← the latest `position` Observation, budget
 *                                `connectivity.max_heartbeat_age`
 *        · F18 reservations   ← live `ChargerReservation` rows
 *      These are real for the physical RobotX the moment its telemetry arrives.
 *
 *   2. **Control-plane facts** — commissioning, hold, firmware, calibrations, e-stop,
 *      faults, localisation, reliability, advisories, zone authorisation, maintenance. No
 *      table carries them. For a simulated unit `simulation/simulatedAgentState` states
 *      them (DEVELOPMENT_SIMULATION). For a physical unit they stay **absent** and the
 *      predicates deny by name — `PHYSICAL_CONTROL_PLANE_FACTS` lists exactly what the
 *      physical RobotX's control-plane provider must supply. Nothing is defaulted.
 *
 * The engine never sees which kind of agent it is evaluating: this provider hands back the
 * same field names for both, and a missing field is simply missing.
 */

const logger = require("../config/logger");
const { getRobotState } = require("./robotRegistry.service");
const { getProbeProofAtOrBefore } = require("./agentProbe.service");
const simulationPolicy = require("../simulation/simulationPolicy");
const simulatedAgentState = require("../simulation/simulatedAgentState");

/**
 * `Robot.status` → §16.4's tier (`predicates/f09.HEALTH_TIER_ORDER`). The same ordering as
 * `telemetry.handler.HEALTH_TIER`: ERROR/OFFLINE admit no work, ISSUES/PAUSED reduced work,
 * IDLE/ACTIVE/CHARGING unrestricted. NOMINAL rather than FULL for the healthy states —
 * nothing in the legacy status vocabulary can attest the top tier.
 * @structural the legacy status → tier mapping
 */
const HEALTH_TIER_BY_STATUS = Object.freeze({
  OFFLINE: "QUARANTINED",
  ERROR: "QUARANTINED",
  ISSUES: "MARGINAL",
  PAUSED: "MARGINAL",
  CHARGING: "NOMINAL",
  IDLE: "NOMINAL",
  ACTIVE: "NOMINAL",
});

/** Reservation states that hold an agent's time (`devChargingScheduler.LIVE_STATES`). */
const LIVE_RESERVATION_STATES = Object.freeze(["QUEUED", "ACTIVE"]);

/**
 * The control-plane facts a PHYSICAL agent needs from its own provider before §7.5 can
 * admit it. Absent today by design; listed so the integration work is a checklist.
 * @structural
 */
const PHYSICAL_CONTROL_PLANE_FACTS = Object.freeze([
  "commissioning (F1)",
  "operatorHold (F3)",
  "firmwareVersion attested (F5)",
  "calibrations (F6)",
  "emergencyStop observation (F7)",
  "faults (F8)",
  "localisation confidence + corroboration (F10)",
  "reliability / intervention rate (F11)",
  "advisories (F12)",
  "session.lastHeartbeatAckAt — an acknowledged server round trip (F14); the PROBE boundary exists (P2B-2), the agent must answer it",
  "authorisedZoneIds (F27)",
  "maintenance intervals (F36)",
  "ambientC / packC from telemetry (§14.2)",
]);

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * @param {object} settings
 * @param {object} settings.prisma
 * @param {string} [settings.tenantId] the deployment's single tenant, when it has one
 * @returns {(input: { agent: object, config: (name: string) => * }) => Promise<object|null>}
 */
function createAgentFactsProvider(settings) {
  const { prisma, kv, tenantId } = settings || {};
  // Gate 1 — the physical provider connects the control-plane half itself; it says so here so
  // the gap is not announced for a robot whose facts it is about to supply.
  const physicalControlPlaneConnected = Boolean(settings && settings.physicalControlPlaneConnected);
  if (!prisma) throw new TypeError("createAgentFactsProvider requires prisma");

  return async function agentFactsFor(input) {
    const { agent, config, asOfMs } = input || {};
    // Facts as of the decision they are for: nothing observed after it (T6).
    const asOf = Number.isFinite(asOfMs) ? new Date(asOfMs) : null;
    const notAfter = (at) => at && (!asOf || new Date(at).getTime() <= asOf.getTime());
    if (!agent || !agent.id) return null;
    const robot = agent.robot || null;
    if (!robot) return null;

    // The agent's region: declared on the Agent, else the region of the shard the index
    // maintainer placed it in (`indexMaintainer.regionForObservedPosition`) — the same
    // published assignment, read back rather than recomputed.
    //
    // B1 — a caller that has already read those two rows for this agent (its
    // `AgentCellPosition.shardId`, and that Shard's `regionId`, or `null` for no Shard row)
    // hands them over as `placement`, and they are not read a second time: two sequential
    // round trips per agent, on the coordinator's planning read and on both of its commit-path
    // reads. Without it, they are read here, as before.
    let regionId = agent.regionId || null;
    if (!regionId) {
      const placement = input && input.placement;
      if (placement && placement.agentId === agent.id && typeof placement.shardId === "string") {
        regionId = placement.regionId ?? null;
      } else {
        const mirror = await prisma.agentCellPosition.findUnique({ where: { agentId: agent.id }, select: { shardId: true } });
        const shard = mirror ? await prisma.shard.findUnique({ where: { shardId: mirror.shardId }, select: { regionId: true } }) : null;
        regionId = shard ? shard.regionId : null;
      }
    }

    const [position, reservations, zones] = await Promise.all([
      prisma.observation.findFirst({
        where: { agentId: agent.id, kind: "position", ...(asOf ? { observedAt: { lte: asOf } } : {}) },
        orderBy: { observedAt: "desc" },
      }),
      prisma.chargerReservation.findMany({
        where: { agentId: agent.id, state: { in: [...LIVE_RESERVATION_STATES] } },
        orderBy: { reservedFrom: "asc" },
      }),
      regionId ? prisma.zone.findMany({ where: { regionId }, select: { id: true } }) : [],
    ]);

    const heartbeatAgeSeconds = typeof config === "function" ? config("connectivity.max_heartbeat_age") : undefined;

    // The last heartbeat, from the liveness store every HEARTBEAT updates — not
    // `Robot.lastSeenAt`, which is flushed on a 15 s throttle and so read as stale against
    // F13's 10 s budget a third of the time. The DB mirror is the fallback when no live
    // state is held (a restarted process, a store without `kv`).
    // Each candidate is admitted only if it is not after the decision time.
    const candidates = [robot.lastSeenAt || null];
    // P2B-2 — F14's proof: the server's own receipt time of a PROBE_RESULT
    // (`agentProbe.service`), admitted only while the socket that answered is still this
    // robot's socket. A reconnect therefore starts with no proof; nothing is defaulted.
    // F7-A: the proof is the probe subsystem's own key, not a registry field.
    // F7-B (H5): the newest proof at or before the decision time, so an answer recorded just
    // after it does not hide the one that proved the link at it.
    let lastHeartbeatAckAt;
    if (kv) {
      try {
        const [live, probe] = await Promise.all([
          getRobotState(kv, robot.robotId),
          getProbeProofAtOrBefore(kv, robot.robotId, asOf ? asOf.getTime() : undefined),
        ]);
        const beat = live && Number(live.lastHeartbeat);
        if (Number.isFinite(beat)) candidates.push(new Date(beat));
        const probed = probe && Number(probe.lastProbeAckAt);
        if (Number.isFinite(probed) && probe.lastProbeSocketId && probe.lastProbeSocketId === robot.socketId) {
          const at = new Date(probed);
          if (notAfter(at)) lastHeartbeatAckAt = at;
        }
      } catch {
        // The mirror stands; the store's absence is not evidence of anything.
      }
    }

    // An accepted position report arrived over the same authenticated session, so it is
    // liveness evidence too — and, unlike the single live beat, it is kept, so the newest one
    // not after the decision time can always be found.
    if (position) candidates.push(position.observedAt);
    const lastHeartbeatAt =
      candidates
        .filter(notAfter)
        .map((at) => new Date(at))
        .sort((a, b) => b.getTime() - a.getTime())[0] || null;

    const facts = {
      session: {
        live: robot.isOnline === true,
        lastHeartbeatAt,
        ...(lastHeartbeatAckAt ? { lastHeartbeatAckAt } : {}),
      },
      healthTier: HEALTH_TIER_BY_STATUS[robot.status] ?? null,
      safetyRelevantObservations: position
        ? {
            position: {
              stalenessBudgetMs: isNumber(heartbeatAgeSeconds) ? heartbeatAgeSeconds * 1000 : undefined,
              // The same instant, in the shape `cost/cRisk`'s staleness term reads (F16 reads
              // `observation.observedAt`); one row, two readers.
              observedAtMs: new Date(position.observedAt).getTime(),
              observation: {
                value: position.value,
                observedAt: position.observedAt,
                source: position.source,
                deadReckoned: false,
              },
            },
          }
        : undefined,
      reservations: reservations.map((row) => ({
        subsystem: "CHARGING",
        reservationId: row.reservationId,
        from: row.reservedFrom,
        until: row.reservedUntil,
      })),
      // F4 — a single-tenant deployment's agents belong to its one tenant. A tenant stated
      // on the Agent row is never overridden.
      tenantId: agent.tenantId ?? tenantId ?? undefined,
    };

    if (!simulationPolicy.isSimulatedRobot(robot)) {
      // PHYSICAL: the control-plane half is not connected yet. The predicates deny by
      // name; `PHYSICAL_CONTROL_PLANE_FACTS` is the list to connect.
      if (!physicalControlPlaneConnected) announcePhysicalGap(robot.robotId);
      return { ...facts, provenance: "PHYSICAL_DERIVED_ONLY" };
    }

    const simulated = simulatedAgentState.simulatedAgentFacts({
      robot: { ...robot, lastSeenAt: lastHeartbeatAt },
      regionZoneIds: zones.map((zone) => zone.id),
    });
    const { sessionOverlay, environmentAt, ...controlPlane } = simulated;
    return {
      ...facts,
      ...controlPlane,
      session: { ...facts.session, ...sessionOverlay },
      environmentAt,
      provenance: simulatedAgentState.PROVENANCE,
    };
  };
}

/**
 * Log, once per process, which control-plane facts a physical agent is still missing.
 *
 * @param {string} robotId
 */
const announced = new Set();
function announcePhysicalGap(robotId) {
  if (announced.has(robotId)) return;
  announced.add(robotId);
  logger.warn(
    `[agentFacts] physical robot ${robotId}: no control-plane provider is connected, so §7.5 will ` +
      `deny it by name until these are supplied: ${PHYSICAL_CONTROL_PLANE_FACTS.join("; ")}`,
  );
}

module.exports = {
  HEALTH_TIER_BY_STATUS,
  LIVE_RESERVATION_STATES,
  PHYSICAL_CONTROL_PLANE_FACTS,
  createAgentFactsProvider,
  announcePhysicalGap,
};

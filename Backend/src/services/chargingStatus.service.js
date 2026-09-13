"use strict";

/**
 * `chargingStatusFor` — the Availability Index maintainer's charging classifier (§6.2).
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THE DEFECT THIS REPLACES
 * ══════════════════════════════════════════════════════════════════════════════
 * `workers/indexMaintainer.worker.js` has always taken this classifier as an injected
 * function, and until now nothing supplied one. Its fallback was:
 *
 *     { charging: false, chargingInterruptible: false, projectedFreeAtMs: null }
 *
 * and its own header claimed that its defaults "only *narrow* an agent's partition (never
 * widen it into `IDLE_READY`)". The code did the opposite. `availabilityIndex.classify`
 * reads `!hasActiveCommitment && idle && !charging` as `IDLE_READY` — the largest
 * partition, searched first at §6.3 tier 1 — so an agent parked on a charger with no
 * commitments was offered work ahead of a genuinely idle one. The contract and the code
 * disagreed, and the code is what runs. That is the registered blocker on the worker.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THREE STATES, NOT TWO — and why `known` had to exist
 * ══════════════════════════════════════════════════════════════════════════════
 * The obvious repair is to flip the default to `charging: true`. That is the same defect
 * pointing the other way: it fabricates a charging session for every agent nobody can
 * answer for, and a fabricated `true` is no more true than a fabricated `false`. §4.1's
 * rule is that an unestablished fact is neither.
 *
 * So this classifier answers with **three** states and the caller fails closed on the
 * third:
 *
 *   | `known` | `charging` | `waiting` | meaning                                        |
 *   |---------|------------|-----------|------------------------------------------------|
 *   | `false` | —          | —         | **nobody can answer.** Not indexed.             |
 *   | `true`  | `true`     | `false`   | current is flowing at a plug. Not indexed (§6.3 tier 5 admits only the interruptible half). |
 *   | `true`  | `false`    | `true`    | docked, queued for a plug. Not indexed.         |
 *   | `true`  | `false`    | `false`   | authoritatively **not** charging. Indexable.    |
 *
 * Only the fourth row lets an agent into the index, and it is the only row backed by a
 * positive statement from the owning service. The other three all narrow.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT MAKES ROW FOUR AUTHORITATIVE, AND WHY SCOPE IS INJECTED
 * ══════════════════════════════════════════════════════════════════════════════
 * "This agent holds no reservation" only means "this agent is not charging" if somebody
 * owns the answer for that agent. §14.7 gives that ownership to the Charging Scheduler,
 * and **no Charging Scheduler exists for the physical fleet** — B2 is open. For a physical
 * agent the honest answer is therefore row one, and this module must never produce row
 * four for one.
 *
 * The scope test is `inScope(agentRowId)`, **injected**, and it is injected rather than
 * derived here for a specific reason. The only durable fact that separates the two fleets
 * is `Robot.simulated`, and `tests/engine/simulationBoundary.test.js` holds an exact
 * allow-list of the files permitted to read it — this file is not on it, the test is
 * protected, and the test's own header forbids the workaround of reading the flag without
 * writing a token its detector matches. So this module does not read the discriminator by
 * any route. It receives a scope predicate from the composition root, which obtains it
 * from `SimulationEngine`'s roster — a roster every member of which passed
 * `simulationPolicy.maySpawnVirtualRobot`, the allow-listed gate that *is* the discriminator's
 * reader. Scope is inherited from the existing gate, not re-derived beside it.
 *
 * A missing `inScope` is not "everything is in scope". It is row one for every agent,
 * which is what an unwired deployment should get.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * THIS IS A PROJECTION READER, NOT A SECOND SOURCE OF TRUTH
 * ══════════════════════════════════════════════════════════════════════════════
 * Every answer comes from `ChargerReservation` — the durable artefact §14.7 makes the
 * Scheduler's. Nothing here reads a `VirtualRobot` field, a Socket.IO connection state, a
 * `Robot.status` column, or any in-memory simulator variable. The agent's own opinion of
 * whether it is charging is not consulted, because the agent is not the authority on
 * whether it holds a plug — the scheduler that granted it is.
 */

const devChargingScheduler = require("../simulation/devChargingScheduler");

/**
 * The classifier's own answer shape, as the worker consumes it.
 *
 * `charging`, `chargingInterruptible` and `projectedFreeAtMs` are exactly the three fields
 * `availabilityIndex.classify` already reads — the worker's contract is **extended** with
 * `known` and `waiting`, never altered. A consumer that ignored the two new fields would
 * behave as it did before; the worker does not ignore them, and that is what closes the
 * widening.
 */
const UNKNOWN = Object.freeze({
  known: false,
  charging: false,
  chargingInterruptible: false,
  waiting: false,
  projectedFreeAtMs: null,
  reason: null,
});

/**
 * @param {string} reason
 * @returns {object}
 */
function unknown(reason) {
  return Object.freeze({ ...UNKNOWN, reason });
}

/**
 * Build the classifier the index maintainer is composed with.
 *
 * @param {object} deps
 * @param {object} deps.prisma
 * @param {(agentRowId: string) => (boolean|Promise<boolean>)} deps.inScope the scope
 *   predicate — see the header. Absent means nothing is in scope.
 * @param {(error: Error, agentRowId: string) => void} [deps.onError]
 * @returns {(agentRowId: string) => Promise<object>}
 */
function createChargingStatusReader(deps) {
  const prisma = deps && deps.prisma;
  const inScope = deps && deps.inScope;
  const onError = deps && deps.onError;

  return async function chargingStatusFor(agentRowId) {
    if (!prisma) return unknown("no prisma client is available to read the reservation projection");
    if (typeof inScope !== "function") {
      return unknown(
        "no charging-scope predicate was supplied. §14.7 gives charging state to the Charging Scheduler, and an " +
          "agent no scheduler covers has no authoritative charging state (B2)",
      );
    }
    if (typeof agentRowId !== "string" || agentRowId === "") return unknown("no agent id");

    try {
      // The scope predicate is keyed on the agent's **business** identifier, because that
      // is what the simulator's roster holds (`Robot.robotId`, from which `Agent.agentId`
      // is seeded), while the worker calls this with the `Agent` primary key. The join is
      // done here rather than making the caller do it, so there is one place the two
      // identifiers are reconciled — `coordinatorSolvePath.agentSnapshotLoaderFor` names
      // conflating them as a defect worth a diagnostic of its own.
      const agent = await prisma.agent.findUnique({
        where: { id: agentRowId },
        select: { id: true, agentId: true, robot: { select: { robotId: true } } },
      });
      if (!agent) return unknown("no such agent");

      const covered = await inScope({
        agentRowId: agent.id,
        agentId: agent.agentId,
        robotId: agent.robot ? agent.robot.robotId : null,
      });

      if (covered !== true) {
        return unknown(
          "no Charging Scheduler covers this agent, so whether it is charging is unestablished. The physical " +
            "fleet's Charging Scheduler is blocking decision B2 and does not exist; a development scheduler's " +
            "silence about an agent it does not manage is not a statement that the agent is free",
        );
      }

      const reservation = await devChargingScheduler.liveReservationFor({ prisma }, agent.id);

      if (!reservation) {
        // Row four — the only widening answer, and it is a positive statement: the
        // scheduler that owns every charger this agent can reach holds no live claim on
        // it.
        return Object.freeze({
          known: true,
          charging: false,
          chargingInterruptible: false,
          waiting: false,
          projectedFreeAtMs: null,
          reason: null,
        });
      }

      if (reservation.state === devChargingScheduler.RESERVATION_STATE.QUEUED) {
        return Object.freeze({
          known: true,
          charging: false,
          // Docked and waiting for a plug. Reported as its own state rather than folded
          // into `charging`, because it is not charging and saying so would be the
          // fabricated `true` this module exists to avoid. The worker declines to index
          // it on `waiting` alone — a robot holding a place in a charging queue cannot
          // take a mission, and `availabilityIndex.classify` has no vocabulary for that,
          // so the narrowing is applied by the caller rather than smuggled through a
          // field that means something else.
          waiting: true,
          chargingInterruptible: false,
          projectedFreeAtMs: null,
          reason: null,
        });
      }

      return Object.freeze({
        known: true,
        charging: true,
        waiting: false,
        // §14.6 permits interruption only when all three of its conditions are **stated**,
        // and condition (b) is "the Charging Scheduler confirms the interruption does not
        // breach the fleet's projected availability floor". This scheduler publishes no
        // availability floor and confirms nothing, and §14.7 is explicit that an unstated
        // condition is not a satisfied one: "agents already charging continue to
        // completion; no interruption is permitted". `false` here is that rule, not a
        // placeholder.
        chargingInterruptible: false,
        // A projected free time would be the charge curve integrated from the agent's
        // present state of charge to its target. The present state of charge is not
        // available from an authoritative source: `BatteryState.lastObservedSoc` is not
        // written by the telemetry path (STEP 5 keeps telemetry out of `BatteryState`
        // precisely so a κ of 1 stays a declared default rather than a measurement), and
        // the agent's self-reported battery is the agent's opinion. So it is null, and
        // `classify` reads a null `projectedFreeAtMs` as "no FINISHING_SOON claim" —
        // which is the narrowing direction.
        projectedFreeAtMs: null,
        reason: null,
      });
    } catch (error) {
      if (typeof onError === "function") onError(error, agentRowId);
      // A read that failed is a read that established nothing. Returning "not charging"
      // here would make a transient database error widen the index.
      return unknown(`the reservation projection could not be read: ${error && error.message}`);
    }
  };
}

module.exports = { UNKNOWN, createChargingStatusReader };

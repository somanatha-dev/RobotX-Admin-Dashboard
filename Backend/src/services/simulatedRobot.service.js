"use strict";

/**
 * Simulated robot creation — the service behind `POST /api/simulator/robot`.
 *
 * ── What this module is ─────────────────────────────────────────────────────
 * The *ownership and identity* half of creating a simulated unit. It owns exactly two
 * things that the physical path has no equivalent of:
 *
 *   1. **Who created the unit.** Derived from the authenticated operator by the
 *      controller and passed in; never read from a request body, here or anywhere.
 *   2. **What the unit is called.** Server-generated, because a client that chose a
 *      simulated robot's identity could collide with a physical unit's id or encode
 *      something about the operator into it.
 *
 * ── What it used to own, wrongly ────────────────────────────────────────────
 * A third thing: "one operator may own one simulated robot at a time", backed by a
 * partial unique index. That was a misreading of the requirement. One SUPER_ADMIN may
 * have **many** simulated robots and there is no per-operator limit, so the index is
 * dropped (`20260912120000_drop_one_simulated_per_owner`) and every trace of the rule is
 * gone from this file — the pre-check, the conflict error, and the P2002 branch that
 * translated it. `simulationOwnerId` remains as creator metadata.
 *
 * Everything else — the Robot row, the `AgentClass`, the specification model rows, the
 * `Agent` projection, the location validation — is `robot.service`'s
 * `createRobotWithProjection`, unchanged and unduplicated. A simulated unit is the same
 * `Robot` with the same `Agent` and the same class; that is the property the whole
 * simulation design rests on, and it would be lost the moment this file grew its own
 * creation transaction.
 *
 * ── What this module deliberately does NOT do ───────────────────────────────
 *   * It does not create a fleet. There is no count, no loop, and no batch: one call
 *     creates exactly one robot. A SUPER_ADMIN builds a fleet of simulated units by
 *     making the request again, which is a different thing from an API that can make
 *     several at once.
 *   * It does not mint a pairing code. `pairing:{robotId}` is the physical AUTH
 *     handshake's artefact; a simulated agent authenticates with the `session:{robotId}`
 *     key the `SimulationEngine` seeds through `VirtualRobot.commission()`, and giving a
 *     simulated unit a pairing code would put a physical credential on a row no hardware
 *     will ever claim.
 *   * It does not construct a `VirtualRobot`. Starting the simulation is
 *     `SimulationEngine.addRobot`'s job and it remains the single construction site.
 */

const crypto = require("crypto");

const robotService = require("./robot.service");
const { toStringOrNull } = require("../utils/parse");

/** The identifier prefix simulated units are created under. */
const SIMULATED_ID_PREFIX = "SIM-";

/**
 * How many times to regenerate an id after a `robotId` collision.
 *
 * Three is generous: a collision requires two of 2^48 values to coincide. It exists
 * because the generated id is checked by a database constraint rather than by hope, and a
 * loop bound is what stops "vanishingly unlikely" from becoming "hangs forever".
 */
const ID_ATTEMPTS = 3;

/**
 * Generate a globally unique identifier for a simulated unit.
 *
 * ── Why random and not derived ──────────────────────────────────────────────
 * The two things this id must not be are stated as requirements: it must not encode the
 * owner's `User.id`, and it must not be a second robot identity system. So it is the same
 * kind of value `Robot.robotId` already holds — a short opaque string in the deployment's
 * existing `PREFIX-SUFFIX` shape — carrying no information about anybody. 48 bits of
 * `crypto.randomBytes` entropy, and the `Robot.robotId` unique constraint is what actually
 * decides whether it is free.
 *
 * The `SIM-` prefix is legible, not semantic: `Robot.simulated` is the fact, and nothing
 * in the system parses this string to decide anything.
 *
 * @returns {string}
 */
function generateSimulatedRobotId() {
  return `${SIMULATED_ID_PREFIX}${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

/**
 * The identifiers a Prisma unique-constraint violation names, as a list.
 *
 * ── Why `meta` only, and never the message ──────────────────────────────────
 * Because a `P2002` message is not a description of the violation — it is a rendered
 * error report that embeds a **source code frame** from the call site. The frame for a
 * failing `robot.create` contains the surrounding lines of `robot.service.js`, which
 * mention `robotId`. So a message-substring test for `"robotId"` returns true for *any*
 * unique violation raised from that call site, whatever actually collided. `meta.target`
 * is structured and says exactly what did.
 *
 * ── What Prisma actually reports, established against a live server ─────────
 * `{ modelName: "Robot", target: ["<column>"] }` — the **column list**, not the index
 * name, and that holds even for an index created by raw SQL that Prisma does not know
 * exists. That was worth measuring rather than assuming: this function once looked for an
 * index name, the unit test's fake obligingly raised an index name, and the two agreed
 * with each other while neither agreed with PostgreSQL.
 *
 * Only one unique constraint is now reachable from the creation path —
 * `UNIQUE ("robotId")` — but the classification stays structural rather than becoming
 * "any P2002 is an identifier collision", because a future constraint on this table would
 * otherwise be silently retried three times and reported as an allocation failure.
 *
 * @param {unknown} error
 * @returns {string[]}
 */
function uniqueViolationTargets(error) {
  if (!error || error.code !== "P2002") return [];
  const raw = error.meta?.target ?? error.meta?.constraint ?? null;
  if (Array.isArray(raw)) return raw.map((entry) => String(entry));
  if (typeof raw === "string" && raw) return [raw];
  return [];
}

/**
 * Did this error come from `Robot.robotId` already being taken?
 *
 * Covers both forms the collision can take: the service layer's own pre-check (a 409
 * carrying `ROBOT_ID_TAKEN`) and the database's unique constraint, which is what answers
 * when two requests generate the same identifier concurrently.
 *
 * Exported so `tools/verify/step2SimulatedOwnership.js` can assert the **shipped**
 * predicate against a real PostgreSQL violation, rather than restating it. A predicate
 * verified only against a hand-written fake is a predicate verified against its author's
 * belief about Prisma — which is precisely the defect the note above records.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isRobotIdConflictError(error) {
  if (error?.code === "ROBOT_ID_TAKEN") return true;
  return uniqueViolationTargets(error).includes("robotId");
}

/**
 * Create exactly one simulated Robot, recording the operator who created it.
 *
 * ── One request, one robot, any number of times ─────────────────────────────
 * There is no per-operator limit and nothing here counts what the caller already has.
 * The same SUPER_ADMIN may call this repeatedly and receive SIM-A, SIM-B, SIM-C…, each a
 * separate `Robot` row with the same `simulationOwnerId`. What "exactly one" constrains
 * is the *request*: a single call creates a single robot, and there is no count, no loop
 * and no batch form by which one call could create several.
 *
 * ── The concurrency argument ────────────────────────────────────────────────
 * Two simultaneous requests from one operator are both valid and both succeed, producing
 * two distinct robots. The only thing they can contend over is the generated identifier,
 * and that contention is resolved by `UNIQUE ("robotId")` and the retry loop below —
 * which is a collision between two drawn values, not between two operators' intentions.
 *
 * @param {object} prisma
 * @param {object} body the creation request (no robotId, no simulated, no owner, no count)
 * @param {{ ownerId: string }} context the authenticated operator
 * @returns {Promise<object>} the created Robot row with its specification includes
 */
async function createSimulatedRobot(prisma, body, context) {
  const ownerId = toStringOrNull(context?.ownerId);
  if (!ownerId) {
    // Not a 400. Reaching here without an authenticated operator means the route lost its
    // `authUser` middleware, which is a server fault, and answering "bad request" would
    // send the caller looking for a mistake in their payload.
    const err = new Error("Simulated robot creation requires an authenticated operator");
    err.status = 500;
    err.code = "NO_SIMULATION_OWNER";
    throw err;
  }

  const request = body && typeof body === "object" ? body : {};

  // ── Fields a caller may not supply, refused by name ───────────────────────
  //
  // Rejected rather than ignored, which is the convention `updateRobot` already sets:
  // "a silently dropped `battery: 100` would leave the caller believing it took effect."
  // Here the stakes are higher — a silently ignored `simulationOwnerId` would leave a
  // caller believing it had created a robot under another operator's account, and the
  // clear refusal is what tells them the server never entertained it.
  if (request.simulationOwnerId !== undefined) {
    const err = new Error(
      "simulationOwnerId is not a request field. The owner of a simulated robot is the " +
        "authenticated operator, derived from the session, and cannot be chosen by the caller.",
    );
    err.status = 400;
    err.code = "OWNER_NOT_CALLER_SUPPLIED";
    throw err;
  }
  if (request.robotId !== undefined) {
    const err = new Error(
      "robotId is not a request field for a simulated robot. The server generates it, so " +
        "that it cannot collide with a physical unit's identifier or encode anything about " +
        "the operator.",
    );
    err.status = 400;
    err.code = "ROBOT_ID_NOT_CALLER_SUPPLIED";
    throw err;
  }
  if (request.count !== undefined) {
    const err = new Error(
      "count is not a request field. This endpoint creates exactly one simulated robot per " +
        "request. There is no fleet creation API — to create several, send the request " +
        "several times.",
    );
    err.status = 400;
    err.code = "NO_FLEET_CREATION";
    throw err;
  }
  if (request.simulated !== undefined) {
    const err = new Error(
      "simulated is not a request field here. Every robot created through this endpoint is " +
        "simulated; that is what the endpoint is.",
    );
    err.status = 400;
    err.code = "SIMULATED_IS_IMPLICIT";
    throw err;
  }

  let lastIdConflict = null;
  for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
    const robotCode = generateSimulatedRobotId();
    try {
      // eslint-disable-next-line no-await-in-loop
      return await robotService.createRobotWithProjection(prisma, request, {
        robotCode,
        simulated: true,
        simulationOwnerId: ownerId,
      });
    } catch (error) {
      // A generated id that was already taken — by a physical unit or another simulated
      // one. `createRobotWithProjection`'s own pre-check answers this as a 409 carrying
      // `ROBOT_ID_TAKEN`; the database's unique constraint answers it as a P2002. Both
      // mean "try another id", and neither is the caller's problem.
      //
      // Every OTHER error is rethrown untouched. In particular a unique violation on some
      // other column is NOT swallowed into this retry: it would be an unrelated constraint
      // that retrying cannot satisfy, and burning three identifiers before reporting a 503
      // would hide it.
      if (isRobotIdConflictError(error)) {
        lastIdConflict = error;
        // eslint-disable-next-line no-continue
        continue;
      }
      throw error;
    }
  }

  const err = new Error(
    `Could not allocate a free simulated robot identifier after ${ID_ATTEMPTS} attempts`,
  );
  err.status = 503;
  err.code = "ROBOT_ID_ALLOCATION_FAILED";
  err.cause = lastIdConflict;
  throw err;
}

module.exports = {
  SIMULATED_ID_PREFIX,
  generateSimulatedRobotId,
  createSimulatedRobot,
  // Exported for the live-database verifier, which asserts this against a real PostgreSQL
  // violation. See `uniqueViolationTargets` for why that matters.
  isRobotIdConflictError,
};

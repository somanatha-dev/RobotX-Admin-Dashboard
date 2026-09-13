"use strict";

/**
 * The public shape of a `Robot` row — the one projection every robot-returning HTTP
 * response goes through.
 *
 * ── Why this exists as a module rather than a helper in one controller ──────
 * Before STEP 3 the projection was a private `withSpecification` in
 * `robots.controller.js`, and `simulator.controller.js` had its own hand-rolled copy of
 * the same idea (spread the row, strip the owner, attach the specification). Two writers
 * of one shape is one that drifts, and the halves it can drift on are exactly the two
 * this step is about: whether the caller is told the unit is simulated, and whether the
 * caller is told who owns it.
 *
 * So there is one function, and both controllers call it.
 *
 * ── The two facts this projection is responsible for ────────────────────────
 *
 *   1. **`simulated` is always present and always a boolean.** The UI has to be able to
 *      label a unit PHYSICAL or SIMULATED, and a field that is sometimes absent forces it
 *      to guess. Guessing here means rendering a simulated unit as hardware.
 *
 *   2. **`simulationOwnerId` is never present.** Ownership is an authorisation fact the
 *      server decides with; it is a `User.id`, and it is not a property of the robot that
 *      any consumer of a robot payload has business reading. §23.7's identity isolation
 *      makes leaking it a privacy defect rather than an untidiness, and the leak vector is
 *      precisely the one that was open: a Prisma `include` returns every scalar on the
 *      row, so `GET /api/robots/state` was returning the operator's user id for every
 *      simulated unit to every authenticated caller, without anybody having written a line
 *      of code to do it.
 *
 * Stripping is done here — once, at the projection — rather than by narrowing every
 * query's `select`, because a `select` is a list somebody extends and this is a list
 * somebody would have to delete from.
 */

const robotSpecification = require("./robotSpecification");
const simulationPolicy = require("../simulation/simulationPolicy");

/**
 * Columns that exist on the row and must not travel with a robot payload.
 *
 * Named as data rather than destructured inline so the structural test in
 * `tests/engine/simulationBoundary.test.js` has one place to point at, and so adding a
 * second such column later is an edit to a list rather than a new idea.
 */
const INTERNAL_ONLY_FIELDS = Object.freeze(["simulationOwnerId"]);

/**
 * Remove the internal-only columns from a Robot row, and nothing else.
 *
 * The narrow half of the projection, for the one response that must not have a
 * specification attached: `POST /api/robots/commission` (the pairing flow) reads its row
 * without `SPECIFICATION_INCLUDE`, so `specificationOf` would answer "all null" — which
 * reads as *unconfigured* rather than as *not joined*, and inventing that for a
 * fully-configured unit is the same kind of fabrication the guard below refuses.
 *
 * It shares this module's one list of internal fields, so the two entry points differ
 * only in whether they join the specification; they cannot differ on what is stripped.
 *
 * @param {object|null|undefined} robot
 * @returns {object|null|undefined}
 */
function stripInternalFields(robot) {
  if (!robot || typeof robot !== "object") return robot;
  const projected = { ...robot };
  for (const field of INTERNAL_ONLY_FIELDS) delete projected[field];
  return projected;
}

/**
 * Project one `Robot` row into the shape an API response may carry.
 *
 * ── Why a missing `simulated` throws instead of defaulting to `false` ───────
 * Because defaulting would be a fabrication, and this programme has already paid for one:
 * commissioning used to write `isOnline: true` on a unit that had never connected, and
 * that invented fact travelled all the way into the feasibility gate. `Robot.simulated` is
 * `Boolean @default(false)` and **not nullable**, so every real row has one. A row
 * reaching here without it did not come from the database missing a value — it came from
 * a read site whose `select` omitted the column, and answering "PHYSICAL" for it would
 * render a simulated unit as hardware with no error anywhere.
 *
 * The throw is therefore aimed at the developer who narrows a query, not at a runtime
 * condition a deployment can be in.
 *
 * @param {object|null|undefined} robot a Robot row, read with its scalars
 * @returns {object|null|undefined} the same row, projected
 */
function toPublicRobot(robot) {
  if (!robot || typeof robot !== "object") return robot;

  if (!("simulated" in robot)) {
    throw new Error(
      "robotProjection.toPublicRobot: the Robot row has no `simulated` column. It is a " +
        "non-nullable column, so this means the read that produced this row used a " +
        "`select` that omitted it. Include it: a robot payload that cannot say whether " +
        "the unit is simulated renders a simulated unit as physical hardware.",
    );
  }

  const projected = stripInternalFields(robot);

  // `simulationPolicy.isSimulatedRobot` is the single reader of the discriminator, and it
  // is strict (`=== true`, never truthiness) for the reason its own file states. Using it
  // here rather than re-deriving keeps the API's answer and the simulator's answer the
  // same answer.
  projected.simulated = simulationPolicy.isSimulatedRobot(robot);

  // One place, so the list endpoint, the dashboard state endpoint, the edit response and
  // the simulated-creation response cannot disagree about what a unit is configured as.
  // `specificationOf` returns nulls for anything unset rather than defaults — a unit
  // commissioned before the specification existed renders as unconfigured, which is what
  // it is.
  projected.specification = robotSpecification.specificationOf(robot);

  return projected;
}

/**
 * Project a list of rows. A thin wrapper, so a call site cannot map with the wrong
 * function or forget the map entirely on one of the two branches of a `kv`-or-not fork.
 *
 * @param {Array<object>} robots
 * @returns {Array<object>}
 */
function toPublicRobots(robots) {
  return Array.isArray(robots) ? robots.map(toPublicRobot) : [];
}

module.exports = {
  INTERNAL_ONLY_FIELDS,
  stripInternalFields,
  toPublicRobot,
  toPublicRobots,
};

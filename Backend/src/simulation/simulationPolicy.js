/**
 * The simulation policy — the one place that decides whether a VirtualRobot may exist.
 *
 * ── Why this module exists at all ───────────────────────────────────────────
 * Before it, the answer to "does this Robot row get a simulated agent?" was spread across
 * three places that each answered "yes" for their own reason: server boot re-hydrated a
 * VirtualRobot for *every* `Robot` row, the commissioning controller started one for every
 * unit it created, and `VirtualRobot.commission()` wrote a `session:{robotId}` key for
 * whatever id it was handed. A physical robot therefore acquired a simulated twin by
 * default, and that twin minted credentials over the physical unit's own.
 *
 * The decision is now a function of one explicit fact — `Robot.simulated` — evaluated
 * here, and the three call sites ask rather than decide. That is what makes the property
 * checkable: there is exactly one predicate to read, and a future call site that forgets
 * to ask is visible as a call site that does not import this module.
 *
 * ── The two conditions, and why both ────────────────────────────────────────
 * A VirtualRobot may be instantiated only when **both** hold:
 *
 *   1. The simulator is enabled for this process (`ENABLE_VIRTUAL_SIMULATOR=true`).
 *      Deployment-scoped. Off unless a deployment says otherwise, so a production process
 *      that nobody configured runs no simulated agents at all.
 *   2. The target row is explicitly `simulated === true`. Row-scoped. So even with the
 *      simulator on, the physical half of a hybrid fleet is untouched.
 *
 * Neither condition subsumes the other: (1) alone would let a simulator-enabled process
 * adopt physical robots, which is the defect this replaces; (2) alone would run simulated
 * agents inside a benchmark or production process that never asked for them.
 *
 * ── Strict equality, never truthiness ───────────────────────────────────────
 * `simulated === true`, not `!!robot.simulated`. A row read with a `select` that omitted
 * the column yields `undefined`, and `undefined` must mean "not established", which fails
 * closed — physical. Coercion would make a missing column indistinguishable from a
 * negative answer only by luck, and would make a string `"false"` mean *true*.
 */

/** The environment variable that enables the simulator for a process. */
const SIMULATOR_ENV_VAR = "ENABLE_VIRTUAL_SIMULATOR";

/**
 * The legacy benchmark kill switch, still honoured.
 *
 * It predates this module and is only ever an *off* switch, so it cannot reintroduce the
 * default-on behaviour: with the default now off, `DISABLE_VIRTUAL_SIMULATOR=true` is
 * redundant rather than contradictory. It is kept so `.env.benchmark` and the capacity
 * runbooks keep meaning what they say, and it wins over `ENABLE_VIRTUAL_SIMULATOR=true`
 * because a kill switch that can be overridden is not a kill switch.
 */
const LEGACY_DISABLE_ENV_VAR = "DISABLE_VIRTUAL_SIMULATOR";

/** `true` only for the exact string, case-insensitively. Everything else is false. */
function isTrue(value) {
  return String(value === undefined || value === null ? "" : value).trim().toLowerCase() === "true";
}

/**
 * Is the virtual simulator enabled for this process?
 *
 * **Default: false.** Simulation is opt-in. An unset variable, an empty one, `"0"`, `"yes"`
 * and a typo all mean disabled, because the only reading that is safe when the operator's
 * intent is unclear is "run no simulated agents".
 *
 * @param {object} [env] defaults to `process.env`; injected so a test need not mutate it
 * @returns {boolean}
 */
function isSimulatorEnabled(env) {
  const source = env || process.env;
  if (isTrue(source[LEGACY_DISABLE_ENV_VAR])) return false;
  return isTrue(source[SIMULATOR_ENV_VAR]);
}

/**
 * Is this Robot row a simulated unit?
 *
 * The single reader of `Robot.simulated`. Takes the row (or anything shaped like it) and
 * answers only for an explicit `true`.
 *
 * @param {{ simulated?: unknown }|null|undefined} robot
 * @returns {boolean}
 */
function isSimulatedRobot(robot) {
  return Boolean(robot) && robot.simulated === true;
}

/**
 * May a VirtualRobot be instantiated for this row, in this process?
 *
 * Returns a *reason* on refusal rather than a bare boolean, because both refusals are
 * things an operator will need explained: "I commissioned a robot and no simulator
 * appeared" has two very different causes, and a log line that names which one saves the
 * next person from turning the wrong knob.
 *
 * @param {{ robotId?: string, simulated?: unknown }|null|undefined} robot
 * @param {{ env?: object, enabled?: boolean }} [options] `enabled` overrides the env read,
 *   for a simulator instance that was constructed with an explicit posture
 * @returns {{ allowed: boolean, reason: string|null }}
 */
function maySpawnVirtualRobot(robot, options = {}) {
  const enabled =
    typeof options.enabled === "boolean" ? options.enabled : isSimulatorEnabled(options.env);

  if (!enabled) {
    return { allowed: false, reason: "SIMULATOR_DISABLED" };
  }
  if (!isSimulatedRobot(robot)) {
    return { allowed: false, reason: "ROBOT_NOT_SIMULATED" };
  }
  return { allowed: true, reason: null };
}

/**
 * Normalise a caller-supplied `simulated` value at a creation boundary.
 *
 * Strict on purpose. `undefined`/`null` mean "not stated" and resolve to `false`; a real
 * boolean is taken as given; **anything else is an error**, not a coercion. A silently
 * coerced `"false"` (truthy as a string) would commission a physical unit as simulated,
 * and a silently coerced `"true"` dropped to `false` would leave an operator believing
 * they had created a simulated unit that will never start. Both are worse than a 400.
 *
 * @param {unknown} value
 * @returns {{ ok: true, simulated: boolean } | { ok: false, problem: string }}
 */
function normaliseSimulatedInput(value) {
  if (value === undefined || value === null) return { ok: true, simulated: false };
  if (typeof value === "boolean") return { ok: true, simulated: value };
  return {
    ok: false,
    problem:
      "simulated must be a boolean (true for a simulated unit, false or omitted for a " +
      "physical one). It is not coerced from strings or numbers, because a mis-read value " +
      "would either credential a physical robot from the simulator or create a simulated " +
      "unit that never starts.",
  };
}

module.exports = {
  SIMULATOR_ENV_VAR,
  LEGACY_DISABLE_ENV_VAR,
  isSimulatorEnabled,
  isSimulatedRobot,
  maySpawnVirtualRobot,
  normaliseSimulatedInput,
};

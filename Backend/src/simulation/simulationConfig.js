/**
 * The simulator's runtime configuration — a closed set of nine numbers.
 *
 * ── Why this is nine numbers and not a framework ─────────────────────────────
 * `SimulationEngine.setConfig` was a no-op with a comment reserving it for "future runtime
 * configuration", and `PATCH /api/simulator/config` returned `{ ok: true }` having done
 * nothing. Two things were wrong with that: a demo could not be made repeatable, and an
 * endpoint that answers `ok` for a request it discarded is worse than one that answers 501.
 *
 * The temptation is to fix it with a configuration system. This is deliberately not one.
 * There is no schema language, no register entry, no persistence, no inheritance and no
 * per-robot override: there is one frozen list of parameter names, a range for each, and a
 * function that either returns a clean object or says which field was wrong. The
 * *parameter register* (`engine/config/**`) is where this system keeps behavioural
 * constants that decisions depend on, and nothing here is one — these are properties of a
 * test fixture, which is what the simulator is.
 *
 * ── The two categories, and why the distinction is load-bearing ──────────────
 * `LIVE` parameters can be applied to a robot that is already running, because they
 * describe what it will do *next*: the tick period, and the obstacle rate.
 *
 * `INITIAL` parameters cannot, because they describe where a robot *started*: its battery,
 * its position, its speed model's centre, its random seed. Applying those to a running
 * robot would rewrite history — a robot at 43 % would jump to 100 % and the telemetry
 * stream would show a charge that never happened, which is precisely the class of
 * fabrication this programme has removed twice. So they take effect for robots added
 * afterwards, and `setConfig`'s answer says so rather than leaving the caller to assume.
 *
 * ── What may never be set from here ──────────────────────────────────────────
 * Identity and specification. Not because a caller would abuse it, but because the fields
 * below are *facts about a Robot row* that the database owns: which unit this is, whether
 * it is a simulated unit at all, who created it, what chassis it has. A simulator
 * configuration endpoint that could write them would be a second, unauthenticated
 * commissioning API — and one of them, the simulation discriminator, is the single fact
 * that keeps physical hardware from acquiring a simulated twin. It is refused by name
 * rather than merely absent from the tunable list, so the refusal is a stated property
 * with a test on it, not a consequence of an allow-list nobody re-reads.
 */

/**
 * Parameters that may be changed for a robot that is already running.
 * @type {ReadonlyArray<string>}
 */
const LIVE_PARAMETERS = Object.freeze(["telemetryIntervalMs", "obstacleProbability"]);

/**
 * Parameters that describe a robot's starting conditions and therefore apply only to
 * robots created after they are set.
 * @type {ReadonlyArray<string>}
 */
const INITIAL_PARAMETERS = Object.freeze([
  "speedBaseMs",
  "speedJitter",
  "initialBattery",
  "randomSeed",
  "startLat",
  "startLon",
]);

/**
 * Fields a configuration request may never carry, refused **by name** so the message says
 * what kind of mistake was made rather than merely that the name is unknown.
 *
 * ── Why the operator-ownership field is not in this list ─────────────────────
 * Every field outside the tunable set is already refused — the set is closed, and
 * `normaliseConfig` rejects an unrecognised name rather than ignoring it. So this list adds
 * a better *message*, never the refusal itself, and it is therefore free to be incomplete.
 *
 * It deliberately omits the column recording which operator created a simulated robot.
 * `tests/engine/simulationBoundary.test.js` asserts that **no file under `src/simulation`
 * names that column at all** — "ownership is not a fleet fact and has no business on the
 * wire" — and that is a property worth more than a nicer error string. Naming it here to
 * refuse it would be the first crack in a boundary whose whole value is that it has none.
 * The closed set refuses it regardless, and `virtualRobotBehaviour.test.js` asserts that
 * refusal by name from the test side, where naming it is not a boundary violation.
 *
 * Listed as strings rather than as an object shape so this file states the names without
 * reading any of them off a row.
 * @type {ReadonlyArray<string>}
 */
const PROTECTED_FIELDS = Object.freeze([
  "robotId",
  "id",
  "simulated",
  "name",
  "chassisType",
  "specification",
  "locationId",
  "campusId",
  "battery",
  "isOnline",
  "status",
  "sessionToken",
  "commandSigningKey",
]);

/**
 * The admissible range for each tunable. `integer` where a fractional value would be
 * meaningless (a tick period) and free otherwise.
 *
 * The lower bound on `telemetryIntervalMs` is the one worth explaining: 100 ms is not a
 * physical limit but a self-inflicted-denial-of-service one. Every tick emits a HEARTBEAT
 * and a TELEMETRY frame, and the server's own rate limiter admits 50 TELEMETRY frames per
 * 5 seconds with a 100 ms minimum interval (`sockets/rateLimit.js`), so a simulator
 * configured below that would have its own frames silently dropped and would look broken
 * for a reason the operator could not see from either side.
 */
const RANGES = Object.freeze({
  telemetryIntervalMs: { min: 100, max: 60_000, integer: true },
  obstacleProbability: { min: 0, max: 1, integer: false },
  speedBaseMs: { min: 0, max: 40, integer: false },
  speedJitter: { min: 0, max: 20, integer: false },
  initialBattery: { min: 1, max: 100, integer: false },
  randomSeed: { min: 0, max: 4_294_967_295, integer: true },
  startLat: { min: -90, max: 90, integer: false },
  startLon: { min: -180, max: 180, integer: false },
});

/** Every name this module accepts. */
const TUNABLE_PARAMETERS = Object.freeze([...LIVE_PARAMETERS, ...INITIAL_PARAMETERS]);

/**
 * Validate and normalise a configuration request.
 *
 * Fails closed on every doubt, and reports **all** problems rather than the first. A
 * caller tuning a demo is usually setting several values at once, and returning one
 * problem per round trip turns a two-field mistake into two failed requests.
 *
 * Unknown names are refused rather than ignored. An ignored name is the failure mode this
 * function exists to remove: the old endpoint accepted `{ tickMs: 500 }`, answered `ok`,
 * and changed nothing, so the operator concluded the simulator was broken rather than that
 * the field was misspelled.
 *
 * @param {unknown} input the request body
 * @returns {{ ok: true, config: object, live: string[], initial: string[] }
 *          | { ok: false, problems: string[] }}
 */
function normaliseConfig(input) {
  if (input === undefined || input === null) return { ok: true, config: {}, live: [], initial: [] };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, problems: ["the configuration must be a JSON object"] };
  }

  const problems = [];
  const config = {};

  for (const [key, value] of Object.entries(input)) {
    if (PROTECTED_FIELDS.includes(key)) {
      problems.push(
        `${key} is a protected robot identity/specification field and can never be set through the ` +
          "simulator configuration. It is a property of the Robot row, written at commissioning.",
      );
      continue;
    }

    const range = RANGES[key];
    if (!range) {
      problems.push(
        `${key} is not a simulator parameter. The tunable set is closed: ${TUNABLE_PARAMETERS.join(", ")}.`,
      );
      continue;
    }

    // Strings are not coerced. A configuration value arriving as `"2000"` means the caller
    // built the request from form fields without converting them, and quietly accepting it
    // would make `"abc"` — which coerces to NaN — indistinguishable from a real number.
    if (typeof value !== "number" || !Number.isFinite(value)) {
      problems.push(`${key} must be a finite number (received ${describe(value)}); values are not coerced`);
      continue;
    }
    if (range.integer && !Number.isInteger(value)) {
      problems.push(`${key} must be a whole number (received ${value})`);
      continue;
    }
    if (value < range.min || value > range.max) {
      problems.push(`${key} must be between ${range.min} and ${range.max} (received ${value})`);
      continue;
    }

    config[key] = value;
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    config,
    live: LIVE_PARAMETERS.filter((name) => name in config),
    initial: INITIAL_PARAMETERS.filter((name) => name in config),
  };
}

/**
 * A short, safe description of a rejected value for the problem message. The value itself
 * is not echoed for objects — a message is a log line, and echoing an arbitrary body into
 * one is how request content ends up somewhere it was not meant to go.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  if (type === "object") return "an object";
  if (type === "string") return "a string";
  return String(value);
}

module.exports = {
  LIVE_PARAMETERS,
  INITIAL_PARAMETERS,
  TUNABLE_PARAMETERS,
  PROTECTED_FIELDS,
  RANGES,
  normaliseConfig,
};

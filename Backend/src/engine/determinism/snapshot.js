"use strict";

/**
 * Round input pinning (§9.6 requirements 4–7).
 *
 * > **`decision_time` is an input.** No component reads a wall clock during
 * > evaluation. All time-dependent quantities are computed relative to the round's
 * > single timestamp.
 *
 * > **Snapshot isolation of inputs.** A round evaluates against an immutable snapshot
 * > of agent state, config, prices, forecast, model versions, and the charger
 * > availability projection, captured at round start and referenced by version in the
 * > decision record. Late-arriving telemetry affects the next round, not the current
 * > one. Without this, replay is impossible.
 *
 * This module is **the one place in the decision path permitted to read a clock**,
 * and it is excluded from the T6 build assertion for exactly that reason: this is
 * where the round's time is *captured*, once, and turned into an input. Every other
 * module in `candidates · feasibility · cost · plan · solve · determinism · energy`
 * fails the build if it reads `Date.now()` (`src/engine/guards/tenets.js`).
 *
 * The charger availability projection is pinned for a second reason beyond replay: it
 * is what breaks the `E_return` circularity (§14.5). A constraint evaluated against a
 * *live* view of an availability that the current round is itself changing would be
 * neither deterministic nor well-defined. Pinning the previous round's projection
 * makes the constraint evaluable, makes it replayable, and makes its staleness a
 * measurable quantity rather than a hidden one.
 */

const crypto = require("crypto");

const { canonicalJson } = require("./ordering");

/** @structural bytes of the round-id digest used to seed the deterministic PRNG */
const SEED_BYTES = 8;

/** @structural digest slice start */
const SEED_OFFSET = 0;

const DIGEST_ALGORITHM = "sha256";

/**
 * Every version a round MUST pin. A snapshot missing one of these is refused:
 * a decision that cannot name the inputs it was taken against cannot be replayed,
 * and a decision that cannot be replayed cannot be explained (§21.2, §24.3).
 */
const REQUIRED_PINS = Object.freeze([
  "roundId",
  "decisionTime",
  "configVersion",
  "codeVersion",
  "killSwitchState",
]);

/**
 * Versions that are pinned when the mechanism producing them exists. Each names the
 * phase that starts supplying it, so an absent pin is a known gap rather than an
 * oversight. `assertReplayable()` requires all of them.
 */
const DEFERRED_PINS = Object.freeze({
  agentStateVersion: "Phase 10 — the round's pinned agent-state snapshot",
  priceSnapshotVersion: "Phase 8 — the λ_zone price surface published by Capacity Pricing",
  forecastVersion: "Phase 8 — the forecast the pricing estimate consumes",
  chargerProjectionVersion: "Phase 7 — the pinned charger availability projection (§14.5)",
  modelVersions: "Phase 7/8 — consumption, service-time, and reliability model artefacts",
});

/**
 * Read the wall clock once, at round start, and turn it into an input.
 *
 * This function exists so that the read is a named, greppable, single-site event
 * rather than an incidental `Date.now()` somewhere inside scoring. Callers outside
 * the round loop pass their own timestamp instead.
 *
 * @returns {number} epoch milliseconds
 */
function captureDecisionTime() {
  return Date.now();
}

/**
 * Derive a round's random seed deterministically from its id (§9.6 requirement 7).
 *
 * Where a randomised algorithm is genuinely useful — sampling which columns to
 * generate — the seed is derived from the round id and recorded, so the sampling
 * replays. Unseeded randomness in the decision path is prohibited and fails the
 * tenet gate.
 *
 * @param {string} roundId
 * @returns {string} hex seed, recorded in the decision record
 */
function deriveSeed(roundId) {
  if (typeof roundId !== "string" || roundId === "") {
    throw new TypeError("deriveSeed requires the round id; an unseeded decision path is prohibited (§9.6)");
  }
  return crypto
    .createHash(DIGEST_ALGORITHM)
    .update(roundId)
    .digest()
    .subarray(SEED_OFFSET, SEED_BYTES)
    .toString("hex");
}

/**
 * Deep-freeze a plain object graph so a pinned snapshot cannot be mutated mid-round.
 *
 * @param {*} value
 * @returns {*}
 */
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * Capture an immutable, content-addressed snapshot of a round's inputs.
 *
 * @param {object} inputs
 * @param {string} inputs.roundId
 * @param {number} inputs.decisionTime epoch ms — an input, never read from a clock
 *   during evaluation
 * @param {number|string} inputs.configVersion the single config version the round observes
 * @param {string} inputs.codeVersion
 * @param {Record<string, boolean>} inputs.killSwitchState every switch state, pinned
 *   because a switch state that is not recorded silently breaks replay (§22.5 rule 4)
 * @param {string|null} [inputs.activeRegime] pinned so a decision taken under a winter
 *   regime replays under it (§22.2)
 * @param {*} [inputs.agentStateVersion]
 * @param {*} [inputs.priceSnapshotVersion]
 * @param {*} [inputs.forecastVersion]
 * @param {*} [inputs.chargerProjectionVersion]
 * @param {*} [inputs.chargerProjectionPublishedAt]
 * @param {object} [inputs.modelVersions]
 * @param {object} [inputs.resolvedValues] the config values the round actually used —
 *   §21.2 requires the decision record to store these, not merely the version
 * @returns {object} frozen snapshot carrying `hash` and `seed`
 */
function captureSnapshot(inputs) {
  const missing = REQUIRED_PINS.filter(
    (pin) => inputs[pin] === undefined || inputs[pin] === null || inputs[pin] === "",
  );
  if (missing.length > 0) {
    throw new Error(
      `round snapshot is missing required pin(s): ${missing.join(", ")}. A round evaluates against ` +
        "an immutable snapshot referenced by version in the decision record; without it, replay is " +
        "impossible (§9.6 requirements 5 and 6).",
    );
  }
  if (typeof inputs.decisionTime !== "number" || !Number.isFinite(inputs.decisionTime)) {
    throw new TypeError("round snapshot requires a finite decisionTime in epoch milliseconds (§9.6 requirement 4)");
  }

  const body = {
    roundId: String(inputs.roundId),
    decisionTime: inputs.decisionTime,
    configVersion: inputs.configVersion,
    codeVersion: inputs.codeVersion,
    killSwitchState: { ...inputs.killSwitchState },
    activeRegime: inputs.activeRegime === undefined ? null : inputs.activeRegime,
    agentStateVersion: inputs.agentStateVersion === undefined ? null : inputs.agentStateVersion,
    priceSnapshotVersion: inputs.priceSnapshotVersion === undefined ? null : inputs.priceSnapshotVersion,
    forecastVersion: inputs.forecastVersion === undefined ? null : inputs.forecastVersion,
    chargerProjectionVersion:
      inputs.chargerProjectionVersion === undefined ? null : inputs.chargerProjectionVersion,
    chargerProjectionPublishedAt:
      inputs.chargerProjectionPublishedAt === undefined ? null : inputs.chargerProjectionPublishedAt,
    modelVersions: inputs.modelVersions ? { ...inputs.modelVersions } : null,
    resolvedValues: inputs.resolvedValues ? { ...inputs.resolvedValues } : null,
  };

  const seed = deriveSeed(body.roundId);
  const hash = crypto.createHash(DIGEST_ALGORITHM).update(canonicalJson({ ...body, seed })).digest("hex");

  return deepFreeze({ ...body, seed, hash });
}

/**
 * Is this object a snapshot produced by `captureSnapshot`, unmodified?
 *
 * @param {object} snapshot
 * @returns {boolean}
 */
function isIntact(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || typeof snapshot.hash !== "string") return false;
  const { hash, ...body } = snapshot;
  const recomputed = crypto.createHash(DIGEST_ALGORITHM).update(canonicalJson(body)).digest("hex");
  return recomputed === hash;
}

/**
 * Assert that a snapshot pins everything a replay needs, including the versions whose
 * producers arrive in later phases.
 *
 * @param {object} snapshot
 * @returns {{ ok: boolean, missing: string[], detail: Record<string, string> }}
 */
function assertReplayable(snapshot) {
  const missing = [];
  const detail = {};
  for (const pin of REQUIRED_PINS) {
    if (snapshot[pin] === undefined || snapshot[pin] === null) missing.push(pin);
  }
  for (const [pin, owner] of Object.entries(DEFERRED_PINS)) {
    if (snapshot[pin] === undefined || snapshot[pin] === null) {
      missing.push(pin);
      detail[pin] = owner;
    }
  }
  return { ok: missing.length === 0, missing, detail };
}

/**
 * Do two snapshots describe the same round inputs? The acceptance test of §9.6 —
 * "replaying any stored decision record MUST reproduce the identical allocation and
 * identical per-candidate costs, byte-for-byte" — starts by establishing this.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function sameInputs(a, b) {
  return Boolean(a) && Boolean(b) && a.hash === b.hash;
}

module.exports = {
  REQUIRED_PINS,
  DEFERRED_PINS,
  DIGEST_ALGORITHM,
  captureDecisionTime,
  deriveSeed,
  captureSnapshot,
  isIntact,
  assertReplayable,
  sameInputs,
  deepFreeze,
};

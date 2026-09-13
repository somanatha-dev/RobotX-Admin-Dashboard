"use strict";

/**
 * Energy provisioning — the commissioning-time producer for `EnergyModelParams` and
 * `BatteryState`.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * Both tables have existed since Phase 7 and, until this module, **nothing in `src/`
 * created a row in either one**. `energyCalibration.worker` upserts a `BatteryState` at
 * settlement, which presupposes a mission that already ran; `tools/verify/v1CorePath.js`
 * creates one inside a disposable harness. So a freshly commissioned unit had no κ, no
 * pack state and no parameter row at all, and every energy predicate refused for the
 * unhelpful reason that the row was absent rather than that the physics was unknown.
 *
 * ── What this module does NOT do: invent physics ────────────────────────────
 * This is the part to read before changing anything here. The rows it writes are
 * **deliberately almost entirely null**, and each null is a refusal to fabricate:
 *
 *   | Column | Written | Why |
 *   |---|---|---|
 *   | `kappa` | `1` | §14.2's identity. "Consumes exactly what the class model predicts" is the correct *prior* for an agent that has flown no missions — it is not a calibration result. |
 *   | `kappaSampleCount` | `0` | **The value that makes the κ above honest.** `kappa: 1` with a positive sample count would assert that missions were observed and came out at unity. Zero says: nothing has been measured yet. The pair is the whole point; neither number means anything without the other. |
 *   | `socThroughput` / `cycleCount` | `0` | A pack that has done nothing has cycled nothing. These are counters this module starts, not quantities it estimates. |
 *   | `soh` | **`null`** | State of health is a *measurement*. A new pack is conventionally 1.0, and writing 1.0 here would be a fabricated physical calibration that §14.5's usable-energy model would then reason from. Null keeps `energy/usable.js` refusing, which is the correct behaviour for a pack nobody has characterised. |
 *   | `internalResistanceMilliOhm` and friends | `null` | Measurements. Same argument. |
 *   | every `beta*` coefficient | **`null`** | §14.2's coefficients are *fitted* from dynamometer or fleet data. None has been declared for this deployment. `legEnergyWh` therefore returns `{ ok: false, missing: [...] }` and names them, which is exactly right. |
 *   | `betaThermal` / `betaPayloadThermal` | **`null`** | Curves, not constants, and equally unfitted. |
 *   | `residualCv` | **`null`** | The schema's own comment says why: *"Null until the model has been fitted: a fabricated dispersion produces three fabricated tier probabilities and F34 admits or rejects on them."* |
 *   | `fittedAt` | `null` | Nothing has been fitted. The column is the honest record of that. |
 *
 * ── Then why write the `EnergyModelParams` row at all? ──────────────────────
 * Because an absent row and an unfitted row are different facts, and the second is the
 * true one. With no row, `legEnergyWh` reports `missing: ["energyModelParams"]` — which
 * reads as a plumbing defect. With this row, it reports `missing: ["beta_dist",
 * "beta_mass", …]` — which is the actual state of the world and names precisely what an
 * owner has to supply. The row also gives a future fit somewhere to land at
 * `modelVersion: 1` instead of racing to create one.
 *
 * **This changes no verdict.** Every predicate that refused before refuses now, for the
 * same reason, because a null coefficient fails `isNumber` exactly as an absent model
 * does. That property is asserted by test, not assumed.
 *
 * ── Why only simulated units ────────────────────────────────────────────────
 * `BatteryState.lastObservedSoc` is, by its name and its consumers, an **observation**.
 * For a simulated unit the simulator *is* the robot, so the state of charge declared at
 * creation is that pack's actual state — the same argument `VirtualRobot.commission()`
 * already makes for writing the live-state key, and it is sound for the same reason.
 * For a physical unit it is not: nobody has connected to the hardware, and recording an
 * operator's typed number as an observed state of charge would be fabricated telemetry.
 *
 * So the producer is called from the **one shared commissioning transaction** and is
 * gated there on the `simulated` discriminator that transaction already carries. That is
 * integration, not a parallel registration path: there is no second endpoint, no second
 * transaction, no simulator-only table and no seed script. A physical unit is left with
 * no `BatteryState`, which is the fail-closed state it is in today and which this module
 * deliberately does not change.
 *
 * ── Idempotent by construction ──────────────────────────────────────────────
 * Both writes are upserts keyed on the columns the schema already makes unique
 * (`BatteryState.agentId`, `EnergyModelParams(agentClassId, modelVersion)`), and both
 * update branches are **empty**. Re-running commissioning therefore converges on the same
 * rows and — the part that matters — cannot overwrite a κ that calibration has since
 * moved, or a coefficient set somebody has since fitted. Provisioning establishes an
 * initial state; it never re-establishes one.
 */

/** The `EnergyModelParams` version a freshly commissioned class is provisioned at. */
const INITIAL_MODEL_VERSION = 1;

/**
 * §14.2's identity multiplier — "consumes exactly what the class model predicts".
 * @structural the specification's own identity, not a tunable value
 */
const KAPPA_IDENTITY = 1;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Convert a declared initial state of charge from percent to the fraction the engine
 * reads.
 *
 * `BatteryState.lastObservedSoc` is a fraction in [0, 1] — `energy/usable.js` validates
 * `soc < 0 || soc > 1` — while the commissioning form asks for a percentage, because that
 * is what an operator reads off a charger. The conversion happens here, once, rather than
 * at each caller.
 *
 * Returns `null` for anything unusable, and a null state of charge is stored as null: a
 * pack whose level was not stated does not have one, and defaulting it to full is the
 * single most consequential fabrication available in this file.
 *
 * @param {unknown} percent
 * @returns {number|null}
 */
function socFractionFrom(percent) {
  if (!isNumber(percent)) return null;
  if (percent < 0 || percent > 100) return null;
  // @structural percentage to fraction
  return percent / 100;
}

/**
 * Provision one commissioned agent's energy rows.
 *
 * Called inside the caller's transaction, so the rows commit with the `Robot`, the
 * `AgentClass` and the `Agent` or not at all — a unit whose Agent exists but whose pack
 * state does not is not a state worth admitting.
 *
 * @param {object} tx a Prisma transaction client
 * @param {object} input
 * @param {string} input.agentRowId `Agent.id` — the FK `BatteryState.agentId` points at
 * @param {string} input.agentClassRowId `AgentClass.id` — the FK `EnergyModelParams` uses
 * @param {number|null} input.initialBatteryPct the operator's declared state of charge
 * @param {Date} [input.at] the commissioning instant
 * @returns {Promise<{ batteryState: object, energyModelParams: object,
 *                     socFraction: number|null }>}
 */
async function provisionAgentEnergyState(tx, input) {
  const source = input || {};
  const agentRowId = source.agentRowId;
  const agentClassRowId = source.agentClassRowId;

  if (typeof agentRowId !== "string" || agentRowId === "") {
    throw new TypeError("provisionAgentEnergyState requires the Agent row id BatteryState keys on");
  }
  if (typeof agentClassRowId !== "string" || agentClassRowId === "") {
    throw new TypeError(
      "provisionAgentEnergyState requires the AgentClass row id EnergyModelParams keys on",
    );
  }

  const at = source.at instanceof Date ? source.at : new Date();
  const socFraction = socFractionFrom(source.initialBatteryPct);

  // ── The pack's initial state ──────────────────────────────────────────────
  //
  // `update: {}` is not an oversight. Provisioning is a create-if-absent: a second call
  // must not reset a κ that `energyCalibration.worker` has moved, nor overwrite a state
  // of charge the running agent has since reported. Idempotence here means "converges on
  // the same row", not "rewrites the row".
  const batteryState = await tx.batteryState.upsert({
    where: { agentId: agentRowId },
    create: {
      agentId: agentRowId,
      // §14.2's prior, with the sample count that keeps it honest. See the table above:
      // these two are written together or the first one lies.
      kappa: KAPPA_IDENTITY,
      kappaSampleCount: 0,
      kappaUpdatedAt: null,
      // Counters this module starts at zero, not estimates.
      socThroughput: 0,
      cycleCount: 0,
      // Not measured. Left null so §14.5's usable-energy model keeps refusing rather than
      // reasoning from a state of health nobody characterised.
      soh: null,
      internalResistanceMilliOhm: null,
      baselineResistanceMilliOhm: null,
      resistanceTrendPerCycle: null,
      // Legitimate only because the caller has established the unit is simulated — the
      // simulator is the pack, so its declared level is that pack's real level.
      lastObservedSoc: socFraction,
      lastObservedAt: socFraction === null ? null : at,
    },
    update: {},
  });

  // ── The class's (as yet unfitted) parameter row ───────────────────────────
  //
  // Every coefficient null, `fittedAt` null. This records that the class exists and has
  // no fit, which is a different and truer statement than the absence of a row.
  const energyModelParams = await tx.energyModelParams.upsert({
    where: {
      agentClassId_modelVersion: {
        agentClassId: agentClassRowId,
        modelVersion: INITIAL_MODEL_VERSION,
      },
    },
    create: {
      agentClassId: agentClassRowId,
      modelVersion: INITIAL_MODEL_VERSION,
      betaDist: null,
      betaMass: null,
      betaClimb: null,
      betaRegen: null,
      betaMoveTime: null,
      betaStopStart: null,
      betaDwell: null,
      betaAux: null,
      etaRegen: null,
      betaThermal: null,
      betaPayloadThermal: null,
      stressCurves: null,
      // The schema's own comment is the argument: a fabricated dispersion produces three
      // fabricated tier probabilities and F34 admits or rejects on them.
      residualCv: null,
      fittedAt: null,
    },
    update: {},
  });

  return { batteryState, energyModelParams, socFraction };
}

module.exports = {
  INITIAL_MODEL_VERSION,
  KAPPA_IDENTITY,
  socFractionFrom,
  provisionAgentEnergyState,
};

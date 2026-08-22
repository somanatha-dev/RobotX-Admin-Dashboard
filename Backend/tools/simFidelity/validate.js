"use strict";

/**
 * The simulator's own release gate — §24.4's **one-sided** fidelity validation.
 *
 * > **The simulator itself MUST be validated against physical reality, and the validation
 * > is a release gate on the simulator.** The simulator gates the release of the engine, so
 * > an unvalidated simulator is a release gate that produces confidence rather than
 * > evidence — and its characteristic failure is not randomness but *optimism*: a
 * > simulator whose agents traverse slightly faster, consume slightly less, and fail
 * > slightly less often than real ones will systematically approve an engine that is
 * > systematically too aggressive, and every one of its runs will look clean.
 *
 * > **The gate is one-sided, because the risk is.** Simulator bias in the pessimistic
 * > direction costs approvals; bias in the optimistic direction costs incidents. Bias
 * > beyond `sim.max_optimistic_bias` on any safety-relevant model — energy, charge,
 * > failure — **fails the simulator's own release gate**, and until it is fixed the
 * > simulator may not be used to discharge a Tier 0 verification obligation (§1.8).
 *
 * ── The three things this tool refuses to do ───────────────────────────────
 *
 * 1. **It never treats a pessimistic bias as a failure.** A simulator whose agents are
 *    slower and hungrier than real ones approves fewer engines than it should. That costs
 *    throughput and nothing else. `verdict()` therefore compares one-signed for every
 *    safety-relevant model, and the sign convention is declared per model rather than
 *    assumed — "optimistic" means *faster* for travel time and *less* for energy, and a
 *    tool that got that backwards would fail exactly the simulators it should pass.
 *
 * 2. **It never reports an unvalidated model as validated.** A model with no realised
 *    counterpart returns `UNVALIDATABLE`, not `PASS`. §24.4:
 *
 *    > Scenarios with no real-world counterpart are labelled as such. Most of §18's
 *    > failure catalogue cannot be observed in production often enough to validate
 *    > against, which is precisely why it is simulated. For those, the simulator's claim
 *    > is about the *engine's response* to a stipulated stimulus, not about the stimulus's
 *    > realism, and the distinction is recorded with the result **so that no one later
 *    > reads an unvalidatable scenario as validated**.
 *
 * 3. **It never averages a bias across zones, classes and time buckets.** §24.4 requires
 *    the comparison "per zone, agent class, and time bucket", and a fleet-wide mean is
 *    exactly how a systematically optimistic depot disappears into a population that is
 *    fine on average. The gate fails on the **worst** slice, and names it.
 *
 * ── Where the realised data comes from ─────────────────────────────────────
 * §21.5's calibration loop already collects realised outcomes per predictor and slice.
 * §24.4's own sentence is "The instrument exists; this points it at the simulator." This
 * tool therefore takes realised and simulated distributions in the shape
 * `observability/calibration.js` produces, and adds nothing to the collection path.
 *
 * Usage:
 *   node tools/simFidelity/validate.js --input <file.json> [--json]
 *   node tools/simFidelity/validate.js            (reports that no study exists yet)
 * Exit code 0 when every safety-relevant model passes or is honestly unvalidatable,
 * 1 when any exceeds `sim.max_optimistic_bias`.
 */

const fs = require("fs");
const path = require("path");

const service = require("../../src/engine/config/service");
const calibration = require("../../src/engine/observability/calibration");

/** @structural the verdicts a model can receive */
const VERDICT = Object.freeze({
  PASS: "PASS",
  OPTIMISTIC_BIAS_EXCEEDED: "OPTIMISTIC_BIAS_EXCEEDED",
  /** Pessimistic beyond the bound. Reported, never fatal — see the header. */
  PESSIMISTIC: "PESSIMISTIC",
  /** No realised counterpart exists. Never a pass. */
  UNVALIDATABLE: "UNVALIDATABLE",
  /** A study was supplied but this model was absent from it. */
  NOT_MEASURED: "NOT_MEASURED",
});

/**
 * The models §24.4 names, with the sign that makes a bias *optimistic* and whether the
 * model is safety-relevant.
 *
 * The sign column is the part a reader should check first. "Optimistic" is not a property
 * of the number's sign; it is a property of which direction flatters the engine, and it
 * differs per model. A simulator that under-predicts travel time is optimistic; one that
 * under-predicts *available* energy is pessimistic. Getting this table backwards would
 * produce a gate that fails safe simulators and passes dangerous ones, which is why every
 * row states it explicitly rather than deriving it.
 */
const MODELS = Object.freeze([
  {
    id: "TRAVEL_TIME",
    predictor: calibration.PREDICTOR.TRAVEL_TIME,
    safetyRelevant: true,
    optimisticWhen: "SIMULATED_BELOW_REALISED",
    note: "a simulated agent that arrives sooner than a real one approves tighter windows than the fleet can meet",
  },
  {
    id: "SERVICE_TIME",
    predictor: calibration.PREDICTOR.SERVICE_TIME,
    safetyRelevant: false,
    optimisticWhen: "SIMULATED_BELOW_REALISED",
    note: "affects throughput and SLA attainment; not a safety window",
  },
  {
    id: "ENERGY_CONSUMPTION",
    predictor: calibration.PREDICTOR.ENERGY,
    safetyRelevant: true,
    optimisticWhen: "SIMULATED_BELOW_REALISED",
    note: "§24.4 names energy explicitly — a simulator that consumes less than reality approves reserves that strand agents",
  },
  {
    id: "CHARGE_DURATION",
    predictor: calibration.PREDICTOR.ENERGY,
    safetyRelevant: true,
    optimisticWhen: "SIMULATED_BELOW_REALISED",
    note: "§24.4 names charge explicitly — a charge that completes sooner in simulation approves schedules the chargers cannot deliver",
  },
  {
    id: "FAILURE_RATE",
    predictor: calibration.PREDICTOR.FAILURE_PROBABILITY,
    safetyRelevant: true,
    optimisticWhen: "SIMULATED_BELOW_REALISED",
    note: "§24.4 names failure explicitly — fewer simulated failures approve less recovery capacity than the fleet needs",
  },
  {
    id: "INTERVENTION_RATE",
    predictor: calibration.PREDICTOR.FAILURE_PROBABILITY,
    safetyRelevant: true,
    optimisticWhen: "SIMULATED_BELOW_REALISED",
    note: "an under-modelled intervention rate understates the operator load a rollout creates",
  },
  {
    id: "DISCONNECT_RATE",
    predictor: calibration.PREDICTOR.FAILURE_PROBABILITY,
    safetyRelevant: true,
    optimisticWhen: "SIMULATED_BELOW_REALISED",
    note: "fewer simulated disconnects understate how often supervision is lost",
  },
]);

const MODEL_BY_ID = Object.freeze(
  MODELS.reduce((index, model) => {
    index[model.id] = model;
    return index;
  }, Object.create(null)),
);

/**
 * The relative bias of a simulated distribution against a realised one, on one slice.
 *
 * Relative rather than absolute, because the bound is a ratio and because a 30-second bias
 * on a two-minute leg and on a two-hour mission are not the same finding.
 *
 * @param {{ simulatedMean: number, realisedMean: number }} slice
 * @returns {number|null} positive when the simulator is *above* the realised value
 */
function relativeBias(slice) {
  if (!slice || typeof slice.simulatedMean !== "number" || typeof slice.realisedMean !== "number") return null;
  if (!Number.isFinite(slice.simulatedMean) || !Number.isFinite(slice.realisedMean) || slice.realisedMean === 0) return null;
  return (slice.simulatedMean - slice.realisedMean) / Math.abs(slice.realisedMean);
}

/**
 * Is a bias optimistic for this model, and by how much?
 *
 * @param {object} model a `MODELS` row
 * @param {number} bias signed relative bias
 * @returns {number} the optimistic magnitude; 0 or negative when pessimistic
 */
function optimisticMagnitude(model, bias) {
  return model.optimisticWhen === "SIMULATED_BELOW_REALISED" ? -bias : bias;
}

/**
 * Judge one model against its slices.
 *
 * @param {object} model
 * @param {{ slices?: object[], unvalidatable?: boolean, unvalidatableReason?: string }} study
 * @param {number} maxOptimisticBias
 * @returns {object}
 */
function judgeModel(model, study, maxOptimisticBias) {
  if (!study) {
    return {
      id: model.id,
      safetyRelevant: model.safetyRelevant,
      verdict: VERDICT.NOT_MEASURED,
      worstSlice: null,
      detail: "the study supplied no data for this model. A model nobody measured is not a model that passed.",
    };
  }

  if (study.unvalidatable === true) {
    return {
      id: model.id,
      safetyRelevant: model.safetyRelevant,
      verdict: VERDICT.UNVALIDATABLE,
      worstSlice: null,
      detail:
        study.unvalidatableReason ||
        "no real-world counterpart exists for this model. §24.4: the simulator's claim here is about the " +
          "engine's *response* to a stipulated stimulus, not about the stimulus's realism.",
    };
  }

  const slices = Array.isArray(study.slices) ? study.slices : [];
  const judged = slices
    .map((slice) => {
      const bias = relativeBias(slice);
      return bias === null ? null : { ...slice, bias, optimistic: optimisticMagnitude(model, bias) };
    })
    .filter(Boolean);

  if (judged.length === 0) {
    return {
      id: model.id,
      safetyRelevant: model.safetyRelevant,
      verdict: VERDICT.NOT_MEASURED,
      worstSlice: null,
      detail: "the study supplied slices but none carried a comparable pair of means.",
    };
  }

  // The worst slice, never the mean. §24.4 requires the comparison per zone, agent class
  // and time bucket precisely so a systematically optimistic depot cannot disappear into a
  // population that is fine on average.
  const worst = judged.reduce((champion, slice) => (slice.optimistic > champion.optimistic ? slice : champion));

  if (worst.optimistic > maxOptimisticBias) {
    return {
      id: model.id,
      safetyRelevant: model.safetyRelevant,
      verdict: VERDICT.OPTIMISTIC_BIAS_EXCEEDED,
      worstSlice: worst,
      detail:
        `optimistic by ${(worst.optimistic * 100).toFixed(1)} % on slice ` +
        `${JSON.stringify(worst.slice || worst.key || {})}, against a bound of ${(maxOptimisticBias * 100).toFixed(1)} %. ` +
        model.note,
    };
  }

  // Pessimistic beyond the bound is reported and is **not** a failure. The asymmetry is
  // §24.4's, and it is the whole point of the gate being one-sided.
  if (-worst.optimistic > maxOptimisticBias) {
    return {
      id: model.id,
      safetyRelevant: model.safetyRelevant,
      verdict: VERDICT.PESSIMISTIC,
      worstSlice: worst,
      detail:
        `pessimistic by ${(-worst.optimistic * 100).toFixed(1)} %. Reported, not failed: bias in the pessimistic ` +
        "direction costs approvals, and bias in the optimistic direction costs incidents.",
    };
  }

  return {
    id: model.id,
    safetyRelevant: model.safetyRelevant,
    verdict: VERDICT.PASS,
    worstSlice: worst,
    detail: `worst slice is optimistic by ${(worst.optimistic * 100).toFixed(1)} %, within the bound.`,
  };
}

/**
 * Run the gate over a study.
 *
 * @param {{ study?: object, maxOptimisticBias?: number }} [options]
 * @returns {{ ok: boolean, mayDischargeTierZero: boolean, results: object[], bound: number,
 *   counts: object }}
 */
function validate(options) {
  const settings = options || {};
  const bound =
    settings.maxOptimisticBias === undefined
      ? service.defaultSnapshot().resolve("sim.max_optimistic_bias")
      : settings.maxOptimisticBias;

  const study = (settings.study && settings.study.models) || {};
  const results = MODELS.map((model) => judgeModel(model, study[model.id], bound));

  const counts = results.reduce(
    (tally, result) => {
      tally[result.verdict] = (tally[result.verdict] || 0) + 1;
      return tally;
    },
    Object.create(null),
  );

  const failed = results.filter(
    (result) => result.safetyRelevant && result.verdict === VERDICT.OPTIMISTIC_BIAS_EXCEEDED,
  );

  // §24.4 / §1.8: until the bias is fixed, the simulator "may not be used to discharge a
  // Tier 0 verification obligation". That is a stronger and more specific statement than
  // "the gate failed", so it is returned separately — a caller that only checks `ok` still
  // gets the right answer, and one that needs the §1.8 sentence has it.
  const unmeasured = results.filter(
    (result) => result.safetyRelevant && (result.verdict === VERDICT.NOT_MEASURED || result.verdict === VERDICT.UNVALIDATABLE),
  );

  return {
    ok: failed.length === 0,
    mayDischargeTierZero: failed.length === 0 && unmeasured.length === 0,
    bound,
    results,
    counts,
    failed,
    unmeasured,
  };
}

/**
 * Render for a terminal.
 *
 * @param {ReturnType<typeof validate>} result
 * @returns {string}
 */
function formatReport(result) {
  const header = `simulator fidelity gate (§24.4) — one-sided, bound ${(result.bound * 100).toFixed(1)} % optimistic`;
  const rows = result.results.map(
    (row) => `  ${row.verdict.padEnd(26)} ${row.id.padEnd(20)} ${row.safetyRelevant ? "SAFETY " : "       "} ${row.detail}`,
  );

  const tail = result.ok
    ? result.mayDischargeTierZero
      ? "\n  PASS — every safety-relevant model is validated within the bound; the simulator may discharge a Tier 0 obligation."
      : "\n  PASS on measured models, but one or more safety-relevant models are unmeasured or unvalidatable, so the " +
        "simulator MAY NOT discharge a Tier 0 verification obligation (§24.4, §1.8)."
    : `\n  FAIL — ${result.failed.length} safety-relevant model(s) exceed the optimistic bound. Until fixed, the ` +
      "simulator may not be used to discharge a Tier 0 verification obligation (§24.4, §1.8).";

  return `${header}\n${rows.join("\n")}${tail}`;
}

module.exports = { VERDICT, MODELS, MODEL_BY_ID, relativeBias, optimisticMagnitude, judgeModel, validate, formatReport };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const inputFlag = argv.indexOf("--input");
  let study = null;
  if (inputFlag !== -1 && argv[inputFlag + 1]) {
    study = JSON.parse(fs.readFileSync(path.resolve(argv[inputFlag + 1]), "utf8"));
  }

  const result = validate({ study });
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
    if (!study) {
      process.stdout.write(
        "\n  No study was supplied (--input <file.json>). Every model reports NOT_MEASURED, which is the honest\n" +
          "  state before the first fidelity study against realised production data — not a pass. §24.4 requires the\n" +
          "  study to be re-run on a cadence and after any fleet change, so an absent one is a standing finding.\n",
      );
    }
  }
  /**
   * The exit code is `mayDischargeTierZero`, not `ok`.
   *
   * `ok` asks only "did any model I measured come back optimistically biased?", and with no
   * study at all the answer is no — so this process exited **0** while all seven models,
   * five of them safety-relevant, reported `NOT_MEASURED`. The text above said so plainly
   * and the exit code contradicted it, which means every automated caller — a CI lane, the
   * release chain, a pre-cutover script — read "the fidelity gate passed".
   *
   * §24.4 is the standard being applied, and it is one-sided in both directions: an
   * unmeasured safety-relevant model may not discharge a Tier 0 obligation any more than a
   * biased one may. `mayDischargeTierZero` is the field that already encodes exactly that,
   * and the comment at its definition anticipated this caller. It is now the caller it
   * anticipated.
   */
  process.exitCode = result.mayDischargeTierZero ? 0 : 1;
}

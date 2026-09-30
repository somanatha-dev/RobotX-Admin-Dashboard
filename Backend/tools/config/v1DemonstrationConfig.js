"use strict";

/**
 * The V1 **DEMONSTRATION** configuration — the thirteen ranking-only register values, and
 * nothing else.
 *
 * ── What this is, stated before anything else ──────────────────────────────
 * **This is not production calibration and must never be published to a production
 * deployment.** Every number below is a *declared placeholder* chosen so that a V1
 * demonstration can price and rank candidates at all. None of them is measured, none is
 * derived from an accounting record, and none is proposed as the value the fleet should
 * eventually run on. §22.4's word for that is `PROVISIONAL`, and the thirteen register
 * entries are marked `PROVISIONAL` with `awaitsBy: 2026-09-26` for exactly this reason:
 *
 * > Tier 1 and Tier 2 parameters may launch `PROVISIONAL`, but each must name the data it
 * > awaits and a date by which it will be re-derived. This is what distinguishes "we chose
 * > a starting point deliberately" from "nobody has looked at this."
 *
 * Each entry's `awaits` text in `src/engine/config/register/*.json` is **unchanged**. That
 * text names the measurement that replaces the placeholder, and rewriting it to describe
 * the placeholder instead would erase the one record of what is still owed.
 *
 * ── Which thirteen, and why exactly these ──────────────────────────────────
 * `workers/coordinatorPipeline.requirements()` reports fifteen `REGISTER_UNRESOLVED`
 * inputs. Two of them — `energy.model_residual_cv` and `energy.reserve_floor_wh` — are
 * **Safety-class (Tier 0)**, and §22.4 admits no provisional route for those at all:
 *
 * > No Tier 0 parameter — every Safety-class entry in Appendix A — may be `PROVISIONAL` or
 * > `UNCALIBRATED` at launch.
 *
 * They are Safety's own decision and value (owner checklist rows **A6a** and **D-1**), they
 * are **deliberately absent from this file**, and `assertNoSafetyParameter()` below fails
 * loudly if either ever appears here. `cutover.engine_enabled` is likewise absent: binding
 * it is the owner's cutover act (**S-5**), not a demonstration input.
 *
 * The remaining thirteen are the set the owner checklist's row **A6** already classifies as
 * legitimately bindable for V1 — *"for these 13, a declared PROVISIONAL value with a named
 * author is enough for V1; production calibration is not required"*. They are
 * **ranking-only**: each is a price or a prior that the cost terms read to *order*
 * candidates. None of them is a feasibility bound, a reserve, a safety margin or an
 * admissibility limit, so a wrong value here produces a worse ranking, never an unsafe
 * admission.
 *
 * ── The accounting basis, so every number is auditable ─────────────────────
 * One basis, stated once, applied to all thirteen:
 *
 *     **1 CU ≡ one second of agent time.**
 *
 * That is not invented here. `cost.lambda_time` is registered at `1 CU·s⁻¹` — the
 * register's own published `PROVISIONAL` default — so a second of agent time already costs
 * one CU on the scale the engine runs on, and expressing the other prices against it keeps
 * the thirteen mutually consistent without asserting a currency, a tariff or a contract.
 * Every `basis` string below reads as "this many seconds of agent time", and a reader can
 * check the arithmetic against the register without leaving the repository.
 *
 * It is a *demonstration* accounting and it is not defensible as a production one: nothing
 * measured a stop, a pack, a tyre or a breach. What it is defensible as is a deliberate,
 * internally consistent starting point — which is precisely the claim `PROVISIONAL` makes.
 *
 * @see docs/v1/V1_OWNER_ACTION_CHECKLIST.md row A6 (the thirteen), A6a and D-1 (the two
 *   Safety rows this file refuses to touch)
 */

/**
 * The date every one of the thirteen must be re-derived by (§22.4's "a date by which it
 * will be re-derived"). Mirrored into each register entry's `awaitsBy`.
 */
const AWAITS_BY = "2026-09-26";

/**
 * The note recorded on the `ConfigVersion` row, so an operator reading
 * `GET /api/config/versions` — or `listVersions()` — sees what this version is before
 * seeing any value it carries.
 */
const DEMONSTRATION_NOTE =
  "V1 DEMONSTRATION CONFIGURATION — NOT PRODUCTION CALIBRATION. Binds the 13 ranking-only " +
  "register parameters of owner-checklist row A6 as declared PROVISIONAL placeholders on the " +
  `stated basis "1 CU = 1 second of agent time" (cost.lambda_time = 1 CU/s), each re-derived by ${AWAITS_BY}. ` +
  "No value here is measured, derived from an accounting record, or proposed as production " +
  "calibration. The two Safety-class rows (energy.model_residual_cv, energy.reserve_floor_wh) are " +
  "NOT bound — they are Safety's own decision (A6a/D-1). cutover.engine_enabled is NOT bound — " +
  "that is the owner's cutover act (S-5). Publishing this version does not make the engine executable.";

/**
 * Parameters this file must never bind, and why. Asserted rather than commented, because a
 * comment does not fail a build.
 */
const REFUSED = Object.freeze({
  "energy.model_residual_cv":
    "Safety-class (Tier 0). §22.4 admits no PROVISIONAL value for it and §22.3 forbids an " +
    "automated process from choosing one. Owner checklist A6a — Safety's own decision and value.",
  "energy.reserve_floor_wh":
    "Safety-class (Tier 0). §14.5's first reserve layer. Owner checklist A6a — Safety's own " +
    "decision and value; no placeholder, no range, no stand-in.",
  "cutover.engine_enabled":
    "Binding it declares the engine is the decision path for a region. That is the owner's " +
    "cutover act (S-5, checklist D-2), and a demonstration configuration may not take it.",
});

/**
 * The thirteen, in the order `SOLVE_PATH_REGISTER_INPUTS` declares them.
 *
 * `value` is the demonstration placeholder. `basis` states where the number came from on
 * the 1 CU = 1 s scale — it is the sentence a demonstrator has to be able to defend, and it
 * never claims a measurement. `shape` is recorded where the value's form is not simply the
 * register's declared type, so the choice is visible rather than inferred.
 *
 * @structural the demonstration binding set; its membership is the finding, not a tunable
 */
const PARAMETERS = Object.freeze([
  {
    name: "plan.service_time_prior",
    level: "global",
    value: 60,
    basis:
      "60 s — a one-minute stop. Bound as a SCALAR rather than the register's declared `map` type, " +
      "deliberately: `plan/timeline.serviceTimeFor` requires a finite number and " +
      "`workers/coordinatorSolvePath` passes the resolved value straight to it, so a per-stop-type map " +
      "would resolve and then be refused one seam later. `serviceTimeModel.worker.priorFor` accepts " +
      "either form. The per-stop-type priors §13.2 actually wants are what the unchanged `awaits` text " +
      "names, and they arrive with the first fitted cohorts.",
  },
  {
    name: "cost.energy.cu_per_wh",
    level: "global",
    value: 0.5,
    basis:
      "0.5 CU/Wh — one watt-hour priced at half a second of agent time. Chosen so the energy term is " +
      "visible in a ranking without dominating it; the tariff this awaits is an accounting figure and " +
      "is not asserted here.",
  },
  {
    name: "cost.wear.cu_per_metre",
    level: "global",
    value: 0.02,
    basis:
      "0.02 CU/m — one metre of ordinary travel priced at 2% of the ~1 s a 1 m/s agent spends covering " +
      "it. Keeps distance wear an order of magnitude below the time it consumes.",
  },
  {
    name: "cost.failure.cu",
    level: "global",
    value: 3600,
    basis:
      "3600 CU — one hour of agent time per failure. §8.4 requires a stated consequence price; this " +
      "states one on the demonstration scale and awaits the measured recovery expense.",
  },
  {
    name: "cost.staleness.cu_per_second_age",
    level: "global",
    value: 0.05,
    basis:
      "0.05 CU/s of observation age, so a one-minute-old observation carries ~3 CU of penalty — enough " +
      "that a fresh agent outranks a stale one at equal cost, which is the ordering §2.7 asks for.",
  },
  {
    name: "cost.energy_consequence",
    level: "global",
    value: Object.freeze({ T1: 300, T2: 1800, T3: 7200 }),
    basis:
      "5 min / 30 min / 2 h of agent time for a contingency diversion, a recovery mission and an " +
      "in-service immobilisation. §14.5 and `cost/cRisk` both insist these are not the same event and " +
      "must not share a price, so the three are separated by a factor of 6 and then 4 rather than " +
      "carrying one blended figure. Keys are the register's declared T1/T2/T3.",
    shape: "map keyed by §14.5 tier (T1, T2, T3)",
  },
  {
    name: "cost.sla.cu_per_second_late",
    level: "global",
    value: 1,
    basis:
      "1 CU/s — lateness priced at exactly the agent-time rate `cost.lambda_time` already carries, so a " +
      "second late costs a second of fleet capacity. The contract terms this awaits are a tenant " +
      "negotiation and are not asserted here.",
  },
  {
    name: "cost.sla.breach_penalty",
    level: "global",
    value: 1800,
    basis:
      "1800 CU — half an hour of agent time as the step cost at the deadline. Large enough that §8.7's " +
      "discontinuity is visible in a ranking, small enough that it does not swamp every other term.",
  },
  {
    name: "lifecycle.cu_per_actuator_cycle",
    level: "global",
    value: Object.freeze({ LIFT: 2, DOOR: 0.5, LATCH: 0.1 }),
    basis:
      "2 / 0.5 / 0.1 CU per cycle. The register's own description requires these to differ by orders of " +
      "magnitude — *\"a lift cycle and a latch cycle differ by orders of magnitude in both cost and rated " +
      "life\"* — so they are ordered rather than equalised. Keys are `cost/cLifecycle.ACTUATOR_KINDS`.",
    shape: "map keyed by actuator kind (LIFT, DOOR, LATCH)",
  },
  {
    name: "lifecycle.cu_per_braking_event",
    level: "global",
    value: 0.2,
    basis: "0.2 CU per braking event — a fifth of a second of agent time per stop, the pad-wear half of §8.5's tyre_and_brake_cost.",
  },
  {
    name: "lifecycle.cu_per_gradient_metre",
    level: "global",
    value: 0.06,
    basis:
      "0.06 CU/m — three times `cost.wear.cu_per_metre`, because §8.5 names gradient exposure as its own " +
      "argument precisely on the grounds that a metre under gradient consumes life faster than a metre " +
      "on the flat. The multiple is a demonstration ordering, not a measured ratio.",
  },
  {
    name: "lifecycle.cu_per_thermal_stress_second",
    level: "global",
    value: 0.01,
    basis:
      "0.01 CU/s at the reference thermal stress — 1% of agent time, the drive/electronics/enclosure " +
      "share. The mission's actual stress enters as a measured multiplier over this rate, not as part of it.",
  },
  {
    name: "cost.battery.cu_per_equivalent_cycle",
    level: "global",
    value: 900,
    basis:
      "900 CU per equivalent full cycle — fifteen minutes of agent time, the same span " +
      "`cost.aging.reference_period` already carries. Pack replacement cost over rated cycle count is " +
      "what this awaits; it is an accounting figure and is not asserted here.",
  },
]);

/**
 * **V1 execution parameters** — the POLICY/TUNED-class values the V1 demonstration needs to
 * *run* a round, kept apart from the thirteen ranking-only ones above (whose membership is
 * a derivation the tests assert). Neither is Safety-class. Both are V1_DEMONSTRATION
 * declarations, re-derived by `AWAITS_BY` like the thirteen.
 *
 * @structural the demonstration's execution bindings
 */
const EXECUTION_PARAMETERS = Object.freeze([
  {
    name: "candidate.max_radius_by_sla_class",
    level: "global",
    value: 700,
    basis:
      "700 m — the next 100 m above the adopted RNSIT boundary's longest chord (624 m, measured from " +
      "way/1120154292). Every robot on the campus is discoverable for every pickup on it, and the §6.3 " +
      "k-ring stops there. Unbounded, a demonstration-sized fleet never reaches candidate.target_feasible " +
      "(12), the ring runs until the wall clock expires (~100 000 cells) and every Leg ends BUDGET_TRUNCATED.",
  },
  {
    name: "plan.commitment_horizon",
    level: "global",
    value: 1800,
    basis:
      "1800 s — the next half-hour above the longest campus delivery a STANDARD simulated unit can be " +
      "committed to: 2 × 624 m (the boundary's longest chord) + 2 × 250 m (route.intra_cell_offset_m per hop) " +
      "at the preset's 1.5 m/s, plus 2 × 60 s service (plan.service_time_prior) ≈ 1285 s. The 900 s default " +
      "rejected ordinary cross-campus deliveries by F17 for the whole slow-robot class (measured: 979 s plan).",
  },
  {
    name: "solve.time_budget",
    level: "global",
    value: 2000,
    basis:
      "2000 ms — the register's own maximum for the round's wall-clock budget. The 250 ms default expired " +
      "before the fourth agent of a five-robot fleet was evaluated (each evaluation reads the store), so the " +
      "nearest robot was never considered. Production tunes this against measured evaluation latency.",
  },
  {
    name: "cost.opportunity.value_horizon",
    level: "global",
    value: 3600,
    basis:
      "3600 s — publish-time validator V1 requires it to exceed plan.commitment_horizon (1800 s) + " +
      "plan.max_admissible_mission_duration (600 s) = 2400 s; the next hour above that. Read only by " +
      "pricing/vTerminal (Tier 2 opportunity pricing), which the V1 Tier 1 composition does not run.",
  },
  {
    name: "sla.assignment_deadline",
    level: "global",
    value: 3600,
    basis:
      "3600 s — the demonstration's promise that queued work is assigned within the hour. The 900 s " +
      "default is armed into Leg.slaDeadline, which F19 reads as the delivery deadline and subtracts the " +
      "plan's duration from (~15 min per conservative V1 plan), so a Leg that waited behind a busy fleet " +
      "for two minutes could never be started again: measured 2026-09-23, 10 robots × 20 tasks, two Legs " +
      "stranded in QUEUED with seven robots idle, every candidate denied by F19. A Product (CONTRACTUAL) " +
      "value, not Safety; the promise per SLA class is what the register's awaits text names.",
  },
  {
    name: "reliability.max_intervention_rate",
    level: "global",
    value: Object.freeze({ DELIVERY: 0.1 }),
    basis:
      "0.1 interventions per DELIVERY mission — the V1 demonstration's acceptance bound: an agent needing a " +
      "human more than once in ten deliveries is not admitted. An Ops policy statement (POLICY class), not a " +
      "measurement; F11 compares each agent's own rate (or its cohort prior) against it.",
  },
]);

/**
 * The execution bindings, in `config/service.publish`'s shape.
 *
 * @returns {Array<{ level: string, key: string, name: string, value: * }>}
 */
function executionBindings() {
  return EXECUTION_PARAMETERS.map((row) => ({ level: row.level, key: "", name: row.name, value: row.value }));
}

/**
 * §12.5 completion verification thresholds — V1_DEMONSTRATION values, as the environment
 * variables `dtaro.handler` and `legProgress.service` read. Without them verification is
 * skipped and no Leg is ever settled. Used by `tools/demo/runV1Assignment.js` and
 * `tools/demo/startV1Server.js`, so the proof run and the server verify identically.
 * @structural V1 demonstration declarations, not measurements
 */
const VERIFICATION_THRESHOLDS = Object.freeze({
  VERIFY_ARRIVAL_RADIUS_M: "25", // one FINE (res-11) cell edge
  VERIFY_TRACK_MIN_FIX_RATE: "10", // fixes/min; telemetry is 30/min
  VERIFY_TRACK_MIN_CORRIDOR_FRACTION: "0.8",
  VERIFY_TRACK_MAX_GAP_SECONDS: "10", // five telemetry intervals
  VERIFY_CORRIDOR_HALF_WIDTH_M: "30",
  VERIFY_MAX_SPEED_MS: "8.33", // simulation/constants.SPEED_MAX_MS
});

/** The thirteen names, sorted, for assertions and reports. */
const PARAMETER_NAMES = Object.freeze(PARAMETERS.map((row) => row.name).slice().sort());

/**
 * The bindings, in the `{ level, key, name, value }` shape `config/service.publish` takes.
 *
 * All thirteen are bound at **global** scope. Every one of them lists `global` among its
 * register scopes, and a demonstration has one region, so a narrower binding would assert a
 * scoping decision the deployment has not made.
 *
 * @returns {Array<{ level: string, key: string, name: string, value: * }>}
 */
function bindings() {
  return PARAMETERS.map((row) => ({ level: row.level, key: "", name: row.name, value: row.value }));
}

/**
 * Refuse to build a binding set that touches a parameter this file may not bind.
 *
 * The three names in `REFUSED` are the ones a future edit is most likely to add "to make the
 * probe go green", and each of them is somebody else's decision. This turns that edit into a
 * failure rather than a silent publish.
 *
 * @param {Array<{ name: string }>} [candidate] defaults to this file's own bindings
 * @throws {Error} naming the parameter and whose decision it is
 */
function assertNoSafetyParameter(candidate) {
  const rows = candidate || bindings();
  for (const row of rows) {
    const reason = REFUSED[row && row.name];
    if (reason) {
      throw new Error(
        `the V1 demonstration configuration may not bind ${row.name}: ${reason} ` +
          "Remove the binding; do not relax this check.",
      );
    }
  }
}

module.exports = {
  AWAITS_BY,
  DEMONSTRATION_NOTE,
  REFUSED,
  PARAMETERS,
  PARAMETER_NAMES,
  EXECUTION_PARAMETERS,
  VERIFICATION_THRESHOLDS,
  executionBindings,
  bindings,
  assertNoSafetyParameter,
};

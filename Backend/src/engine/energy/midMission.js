"use strict";

/**
 * Mid-mission energy management (§14.8) — **Tier 0**.
 *
 * > Monitored continuously (§12.3). When realised consumption diverges beyond
 * > `energy.deviation_tolerance`, the engine re-evaluates feasibility with the observed
 * > efficiency and acts **while action is still possible**.
 *
 * | Projection | Tier | Action |
 * |---|---|---|
 * | Reserves intact | — | Continue; update `κ(a)` |
 * | Contingency eroded but return reserve intact | **T1** | Continue; pre-reserve a charger; alert; count against the T1 budget |
 * | Return reserve threatened, pre-custody | **T2** | Abort and reassign; divert to charger; count against the T2 budget |
 * | Return reserve threatened, custody `HELD` | **T2** | Attempt a diversion to the nearest safe drop or transfer point; if none, escalate for physical recovery **before** the agent immobilises; count against the T2 budget |
 * | Below floor projected imminently | **T3** | Controlled stop at the safest reachable location; page operations; count against the T3 budget |
 *
 * ── Why the tiers here are literally F34's tiers ───────────────────────────
 * > The projection tiers here are **the same tiers as the F34 feasibility constraint**
 * > (§14.5), so the realised frequency of each row is directly comparable against that
 * > tier's budgeted rate — which is what makes invariant I17 verifiable from
 * > operational data rather than only in simulation.
 *
 * This module therefore imports `TIERS` from `tiers.js` rather than restating them. Two
 * tables would drift, and a drift would break exactly the comparison I17 depends on:
 * "realised T2 events per fleet-year" would no longer be measuring the same event that
 * `energy.event_budget_per_fleet_year[T2]` budgets.
 *
 * ── A controlled stop is still a T3 event ──────────────────────────────────
 * > A T3 event that was *reached by controlled stop* is still a T3 event for budget
 * > purposes. … Counting it otherwise would let the fleet consume its immobilisation
 * > budget invisibly.
 *
 * So `countsAgainstBudget` is `true` on the T3 row unconditionally. Choosing where to
 * stop reduces the *consequence* — and is priced as such in `cost.energy_consequence[T3]`
 * — but it does not make the event not have happened.
 *
 * ── The ordering principle ─────────────────────────────────────────────────
 * > an agent that stops where it *chose* to stop is a recoverable inconvenience; an
 * > agent that stops where its battery *ran out* may be blocking a road, a fire exit, or
 * > a rail crossing. The engine MUST always prefer the former, and MUST make that
 * > decision early enough to have the choice.
 *
 * "Early enough to have the choice" is why the rows are evaluated against **projected**
 * remaining energy at mission end rather than against the current reading, and why the
 * T2 rows act while the return reserve is *threatened* rather than once it is breached.
 *
 * This module is L2 supervision, not the decision path: it is listed in
 * `guards/tenets.js`'s `DECISION_PATH_EXCLUSIONS` because it runs on telemetry arrival
 * rather than inside a round.
 */

const { TIERS } = require("./tiers");

const TIER_BY_NAME = Object.freeze(
  TIERS.reduce((index, row) => {
    index[row.tier] = row;
    return index;
  }, Object.create(null)),
);

/**
 * §14.8's five rows, in the order the table states them. The first row carries no tier
 * because nothing has been consumed.
 * @structural the specification's own mid-mission table
 */
const ROW = Object.freeze({
  RESERVES_INTACT: "RESERVES_INTACT",
  CONTINGENCY_ERODED: "CONTINGENCY_ERODED",
  RETURN_THREATENED_PRE_CUSTODY: "RETURN_THREATENED_PRE_CUSTODY",
  RETURN_THREATENED_CUSTODY_HELD: "RETURN_THREATENED_CUSTODY_HELD",
  FLOOR_IMMINENT: "FLOOR_IMMINENT",
});

/**
 * The action column, verbatim.
 * @structural the specification's own action column
 */
const ACTION = Object.freeze({
  CONTINUE_AND_UPDATE_KAPPA: "Continue; update κ(a)",
  PRE_RESERVE_AND_ALERT: "Continue; pre-reserve a charger; alert",
  ABORT_AND_REASSIGN: "Abort and reassign; divert to charger",
  DIVERT_TO_SAFE_DROP_OR_ESCALATE:
    "Attempt a diversion to the nearest safe drop or transfer point; if none, escalate for physical recovery before the agent immobilises",
  CONTROLLED_STOP_AND_PAGE: "Controlled stop at the safest reachable location; page operations",
});

/**
 * The table itself. `custody` narrows the two T2 rows; `null` means the row does not
 * discriminate on custody.
 * @structural the specification's own row → tier → action mapping
 */
const ROWS = Object.freeze([
  Object.freeze({ row: ROW.RESERVES_INTACT, tier: null, custody: null, action: ACTION.CONTINUE_AND_UPDATE_KAPPA, countsAgainstBudget: false }),
  Object.freeze({ row: ROW.CONTINGENCY_ERODED, tier: "T1", custody: null, action: ACTION.PRE_RESERVE_AND_ALERT, countsAgainstBudget: true }),
  Object.freeze({ row: ROW.RETURN_THREATENED_PRE_CUSTODY, tier: "T2", custody: "PRE_CUSTODY", action: ACTION.ABORT_AND_REASSIGN, countsAgainstBudget: true }),
  Object.freeze({ row: ROW.RETURN_THREATENED_CUSTODY_HELD, tier: "T2", custody: "HELD", action: ACTION.DIVERT_TO_SAFE_DROP_OR_ESCALATE, countsAgainstBudget: true }),
  Object.freeze({ row: ROW.FLOOR_IMMINENT, tier: "T3", custody: null, action: ACTION.CONTROLLED_STOP_AND_PAGE, countsAgainstBudget: true }),
]);

const ROW_BY_NAME = Object.freeze(
  ROWS.reduce((index, row) => {
    index[row.row] = row;
    return index;
  }, Object.create(null)),
);

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Does realised consumption diverge beyond `energy.deviation_tolerance`?
 *
 * This is the trigger, not the assessment. §12.3's `assessEnergyDeviation()` fires the
 * same comparison as a supervision signal; the two are kept as separate calls rather
 * than one because they answer different questions — that one asks whether to *look*,
 * this one asks *what to do*. Both read the same parameter, so they cannot disagree
 * about when a deviation has occurred.
 *
 * @param {object} input
 * @param {number} input.predictedWh
 * @param {number} input.realisedWh
 * @param {number} input.deviationTolerance `energy.deviation_tolerance`
 * @returns {{ diverged: boolean, deviation: number|null }}
 */
function hasDiverged(input) {
  const source = input || {};
  if (!isNumber(source.predictedWh) || source.predictedWh <= 0) return { diverged: false, deviation: null };
  if (!isNumber(source.realisedWh)) return { diverged: false, deviation: null };
  if (!isNumber(source.deviationTolerance) || source.deviationTolerance <= 0) return { diverged: false, deviation: null };

  const deviation = (source.realisedWh - source.predictedWh) / source.predictedWh;
  // One-sided, matching §12.3: consuming *less* than predicted is a calibration
  // observation, not a mid-mission energy event.
  return { diverged: deviation > source.deviationTolerance, deviation };
}

/**
 * Select the §14.8 row for a projected end state.
 *
 * The projection is of energy **remaining at mission end**, recomputed with the
 * observed efficiency. Rows are tested from most severe to least, because the table's
 * conditions are nested in the same way §14.5's tiers are: a projection below the floor
 * is also below floor-plus-return, and reporting the milder row would understate the
 * event and mis-charge the budget.
 *
 * @param {object} input
 * @param {number} input.projectedRemainingWh energy left at projected mission end
 * @param {object} input.layers the reserve stack in force
 * @param {string} input.custodyState the §2.5 custody state
 * @returns {{ ok: boolean, row: object|null, tier: object|null, margins: object|null,
 *             reason: string|null }}
 */
function assess(input) {
  const source = input || {};
  const layers = source.layers;

  if (!isNumber(source.projectedRemainingWh)) {
    return { ok: false, row: null, tier: null, margins: null, reason: "no projected remaining energy supplied" };
  }
  if (!layers || !isNumber(layers.floorWh) || !isNumber(layers.returnWh) || !isNumber(layers.contingencyWh)) {
    return { ok: false, row: null, tier: null, margins: null, reason: "the reserve stack is unresolved (§14.5)" };
  }

  const floor = layers.floorWh;
  const floorPlusReturn = floor + layers.returnWh;
  const floorPlusReturnPlusContingency = floorPlusReturn + layers.contingencyWh;

  const margins = Object.freeze({
    aboveFloorWh: source.projectedRemainingWh - floor,
    aboveReturnWh: source.projectedRemainingWh - floorPlusReturn,
    aboveContingencyWh: source.projectedRemainingWh - floorPlusReturnPlusContingency,
  });

  let selected;
  if (source.projectedRemainingWh < floor) {
    selected = ROW_BY_NAME[ROW.FLOOR_IMMINENT];
  } else if (source.projectedRemainingWh < floorPlusReturn) {
    // The custody split is the whole reason §14.8 gives the T2 event two rows: an agent
    // holding goods cannot simply abort, because aborting with custody `HELD` strands
    // the goods as well as the agent (§4.7, invariant I7).
    selected =
      source.custodyState === "HELD"
        ? ROW_BY_NAME[ROW.RETURN_THREATENED_CUSTODY_HELD]
        : ROW_BY_NAME[ROW.RETURN_THREATENED_PRE_CUSTODY];
  } else if (source.projectedRemainingWh < floorPlusReturnPlusContingency) {
    selected = ROW_BY_NAME[ROW.CONTINGENCY_ERODED];
  } else {
    selected = ROW_BY_NAME[ROW.RESERVES_INTACT];
  }

  return {
    ok: true,
    row: selected,
    tier: selected.tier ? TIER_BY_NAME[selected.tier] : null,
    margins,
    reason: null,
  };
}

/**
 * The budget-counting tuple an event produces.
 *
 * §14.8 requires each row to be "counted against its tier budget", and I17 is verified
 * by comparing those counts against `energy.event_budget_per_fleet_year[tier]`. The
 * tuple is returned rather than written, so the counter lives with the observability
 * store (Phase 11) rather than inside a physics module.
 *
 * `reachedByControlledStop` is carried but does **not** suppress the count — §14.8 is
 * explicit that a controlled stop is still a T3 event, and this field exists so the
 * consequence can be priced differently while the event rate stays honest.
 *
 * @param {object} assessment a result from `assess()`
 * @param {object} [context]
 * @returns {object|null}
 */
function budgetEvent(assessment, context) {
  if (!assessment || !assessment.ok || !assessment.row || !assessment.row.countsAgainstBudget) return null;
  const source = context || {};
  return Object.freeze({
    kind: "energy_tier_event",
    tier: assessment.row.tier,
    row: assessment.row.row,
    event: assessment.tier ? assessment.tier.event : null,
    consequence: assessment.tier ? assessment.tier.consequence : null,
    agentId: source.agentId ?? null,
    legId: source.legId ?? null,
    commitmentId: source.commitmentId ?? null,
    custodyState: source.custodyState ?? null,
    reachedByControlledStop: source.reachedByControlledStop === true,
    // Always true when the row counts. Stated as a field rather than left implicit so a
    // future caller cannot quietly pass `false`.
    countsAgainstBudget: true,
    marginsWh: assessment.margins,
    observedAt: source.observedAt ?? null,
  });
}

module.exports = {
  ROW,
  ACTION,
  ROWS,
  ROW_BY_NAME,
  TIER_BY_NAME,
  hasDiverged,
  assess,
  budgetEvent,
};

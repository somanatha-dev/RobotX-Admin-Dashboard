"use strict";

/**
 * **F38 — Plan validity: a complete, executable plan exists with all stops sequenced
 * within their time windows.** Class F. Indeterminate: `DENY`.
 *
 * > The union of all the above; **a candidate is feasible only if an actual plan
 * > exists**.
 *
 * ── The predicate that closes the register ──────────────────────────────────
 * Every other predicate answers a question about some *aspect* of a pairing. F38 asks
 * the question they collectively presuppose: is there actually an executable plan
 * here? A candidate can satisfy all 37 others against a plan object that is
 * incoherent — stops out of order, a stop the timeline never reaches, a window that
 * closed before the projected arrival — because each of the others reads the part of
 * the plan it needs and no one of them reads the whole.
 *
 * §13 makes the plan the single artefact feasibility and cost share, so its structural
 * validity has to be checked somewhere, and §7.5 puts the check last: it is the most
 * expensive, and the cheap predicates will already have rejected most candidates.
 *
 * ── Four conditions ─────────────────────────────────────────────────────────
 *   1. **Complete** — the plan exists and holds at least the stops a Leg requires.
 *      `domain/work.js` states the arity: a Leg is a *sequence* of Stops, and one stop
 *      is a degenerate sequence with nowhere to go.
 *   2. **Sequenced** — stop sequence numbers are strictly increasing, with no
 *      duplicates. A plan with two stops at the same position is not executable and is
 *      also not orderable, so every downstream projection over it is ambiguous.
 *   3. **Timeline monotone** — projected arrivals never move backwards. A timeline that
 *      goes back in time is a projection defect, and admitting it would let a plan
 *      "save" time by arriving before it departed.
 *   4. **Within windows** — every stop's projected arrival lies inside its own time
 *      window. Half-open `[windowStart, windowEnd)`, consistent with F18 and F30.
 *
 * ── What F38 deliberately does not re-check ────────────────────────────────
 * It does not re-evaluate energy, payload, or routing feasibility. Those are F22–F35's,
 * and repeating them here would produce two verdicts that can disagree — and a
 * rejection tuple naming F38 when the real binding constraint was F34, which would
 * corrupt the binding-constraint distribution §7.7 exists to produce.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");
const { STOPS_IN_A_POINT_TO_POINT_LEG, isStopType } = require("../../domain/work");

const REQUIRED = "a complete, sequenced, executable plan with every stop inside its time window";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const plan = (context && context.plan) || null;

  if (!plan) {
    return tv.absent("the candidate plan", {
      required: REQUIRED,
      reason: "a candidate is feasible only if an actual plan exists (§7.5 F38)",
    });
  }

  const stops = plan.stops;
  if (stops === undefined) {
    return tv.absent("the plan's stops", { required: REQUIRED, inputSource: "PLAN" });
  }
  if (stops === null || !Array.isArray(stops)) {
    return tv.indeterminate({ required: REQUIRED, inputSource: "PLAN", reason: "the plan's stop list is unreadable" });
  }

  // ── 1. Complete ───────────────────────────────────────────────────────────
  if (stops.length < STOPS_IN_A_POINT_TO_POINT_LEG) {
    return tv.violated({
      observed: { stopCount: stops.length },
      required: { minimumStops: STOPS_IN_A_POINT_TO_POINT_LEG },
      inputSource: "PLAN",
      margin: stops.length - STOPS_IN_A_POINT_TO_POINT_LEG,
      marginUnit: tv.MARGIN_UNIT.COUNT,
      reason:
        `the plan holds ${stops.length} stop(s). A Leg is a contiguous sequence of Stops (§2.4); one ` +
        "stop is a degenerate sequence with nowhere to go",
    });
  }

  let previousSequence = null;
  let previousArrivalMs = null;
  let tightestSlackMs = null;

  for (const stop of stops) {
    if (!stop || typeof stop !== "object") {
      return tv.indeterminate({ required: REQUIRED, inputSource: "PLAN", reason: "the plan holds a stop that is not an object" });
    }

    if (!isStopType(stop.stopType)) {
      return tv.violated({
        observed: { stopSequence: stop.sequence === undefined ? null : stop.sequence, stopType: String(stop.stopType) },
        required: REQUIRED,
        inputSource: "PLAN",
        reason: `the plan holds a stop of type "${String(stop.stopType)}", which §2.4 does not define`,
      });
    }

    // ── 2. Sequenced ────────────────────────────────────────────────────────
    if (!tv.isNumber(stop.sequence)) {
      return tv.indeterminate({
        required: REQUIRED,
        inputSource: "PLAN",
        reason: "a stop carries no readable sequence number; the plan is not orderable",
      });
    }
    if (previousSequence !== null && stop.sequence <= previousSequence) {
      return tv.violated({
        observed: { stopSequence: stop.sequence, previousSequence },
        required: REQUIRED,
        inputSource: "PLAN",
        reason:
          `stop sequence ${stop.sequence} does not advance on ${previousSequence}. A plan with two ` +
          "stops at one position is neither executable nor orderable, so every projection over it is ambiguous",
      });
    }
    previousSequence = stop.sequence;

    // ── 3. Timeline monotone ────────────────────────────────────────────────
    const arrivalMs = tv.epochMs(stop.projectedArrivalMs);
    if (arrivalMs === null) {
      return tv.absent(`the projected arrival at stop ${stop.sequence}`, {
        required: REQUIRED,
        inputSource: "PLAN",
        reason: "a stop the timeline never reaches makes the plan incomplete rather than merely imprecise",
      });
    }
    if (previousArrivalMs !== null && arrivalMs < previousArrivalMs) {
      return tv.violated({
        observed: { stopSequence: stop.sequence, projectedArrivalMs: arrivalMs, previousArrivalMs },
        required: REQUIRED,
        inputSource: "PLAN",
        margin: arrivalMs - previousArrivalMs,
        marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
        reason:
          `the projected arrival at stop ${stop.sequence} precedes the previous stop's. A timeline ` +
          "that goes back in time would let a plan save time by arriving before it departed",
      });
    }
    previousArrivalMs = arrivalMs;

    // ── 4. Within windows ───────────────────────────────────────────────────
    const windowStartMs = tv.epochMs(stop.windowStart);
    const windowEndMs = tv.epochMs(stop.windowEnd);

    if (windowStartMs !== null && arrivalMs < windowStartMs) {
      // Arriving early is only a violation where the stop cannot be waited at; a plan
      // that states a wait is the Plan Builder's way of resolving this, and it moves
      // the projected arrival rather than leaving it early.
      if (stop.waitPermitted !== true) {
        return tv.violated({
          observed: { stopSequence: stop.sequence, projectedArrivalMs: arrivalMs, windowStartMs },
          required: { windowStartMs, windowEndMs },
          inputSource: "PLAN",
          margin: arrivalMs - windowStartMs,
          marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
          reason: `the projected arrival at stop ${stop.sequence} precedes its time window and waiting is not permitted there`,
        });
      }
    }

    if (windowEndMs !== null) {
      const slackMs = windowEndMs - arrivalMs;
      if (arrivalMs >= windowEndMs) {
        return tv.violated({
          observed: { stopSequence: stop.sequence, projectedArrivalMs: arrivalMs, windowEndMs },
          required: { windowStartMs, windowEndMs },
          inputSource: "PLAN",
          margin: slackMs,
          marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
          reason: `the projected arrival at stop ${stop.sequence} is after its time window closes (§7.5 F38)`,
        });
      }
      if (tightestSlackMs === null || slackMs < tightestSlackMs) tightestSlackMs = slackMs;
    }
  }

  return tv.satisfied({
    observed: { stopCount: stops.length, tightestWindowSlackMs: tightestSlackMs },
    required: REQUIRED,
    inputSource: "PLAN",
    margin: tightestSlackMs,
    marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
  });
}

module.exports = { evaluate };

"use strict";

/**
 * **F32 — Site access prerequisites obtainable (gate, dock, lift, door credential).**
 * Class F. Indeterminate: **`DENY_UNLESS_ENVELOPE`.**
 *
 * > An agent that cannot get in cannot deliver.
 *
 * ── The only `DENY_UNLESS_ENVELOPE` predicate in the register ───────────────
 * §7.3 permits this policy for "Class F where a conservative bound exists", and F32 is
 * where one does. If a lift credential cannot be confirmed, the mission is not
 * necessarily infeasible — it may be feasible in a *reduced envelope*: deliver to the
 * ground-floor reception instead of the twelfth floor, or to the gatehouse instead of
 * the loading dock. That reduced variant is a real, conservative fallback that can be
 * evaluated, which is exactly the condition the policy names.
 *
 * The predicate itself does not construct the reduced envelope. It cannot: building an
 * alternative plan is the Plan Builder's work (§13), and doing it here would put plan
 * construction inside the feasibility gate. What this module does is report
 * `INDETERMINATE` with the specific unobtainable prerequisite named, and
 * `threeValued.applyPolicy()` consults the caller's `envelopeFeasible` answer. **Absent
 * an answer, it denies** — the policy's own name read literally.
 *
 * ── Obtainable, not held ────────────────────────────────────────────────────
 * §7.5 says *obtainable*, and the distinction is deliberate. An agent need not already
 * hold a door code at decision time; it needs the code to be issuable before it
 * arrives. A prerequisite is therefore:
 *
 *   - `HELD`         — already in the agent's credential set. Satisfied.
 *   - `OBTAINABLE`   — issuable before the projected arrival. Satisfied.
 *   - `UNOBTAINABLE` — cannot be issued. Violated.
 *   - anything else  — Indeterminate, and the envelope policy applies.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

/**
 * The prerequisite dispositions §7.5 F32's "obtainable" implies.
 * @structural prerequisite availability labels
 */
const AVAILABILITY = Object.freeze({
  HELD: "HELD",
  OBTAINABLE: "OBTAINABLE",
  UNOBTAINABLE: "UNOBTAINABLE",
});

const REQUIRED = "every site access prerequisite held or obtainable before projected arrival";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const plan = (context && context.plan) || null;
  if (!plan) return tv.absent("the candidate plan", { required: REQUIRED });

  const stops = plan.stops;
  if (stops === undefined) {
    return tv.absent("the plan's stops", { required: REQUIRED, inputSource: "PLAN" });
  }
  if (stops === null || !Array.isArray(stops)) {
    return tv.indeterminate({ required: REQUIRED, inputSource: "PLAN", reason: "the plan's stop list is unreadable" });
  }

  for (const stop of stops) {
    const prerequisites = stop && stop.accessPrerequisites;

    // A stop with no access constraints is not a gap: most stops are kerbside and
    // require nothing. The explicit empty array and `null` both mean "none required";
    // `undefined` means nobody established what this site requires.
    if (prerequisites === undefined) {
      return tv.absent(`the access prerequisites for stop ${String(stop && stop.sequence)}`, {
        required: REQUIRED,
        inputSource: "CONTROL_PLANE",
      });
    }
    if (prerequisites === null) continue;
    if (!Array.isArray(prerequisites)) {
      return tv.indeterminate({
        observed: { stopSequence: stop.sequence === undefined ? null : stop.sequence },
        required: REQUIRED,
        inputSource: "CONTROL_PLANE",
        reason: "a stop's access-prerequisite list is unreadable",
      });
    }

    for (const prerequisite of prerequisites) {
      const kind = prerequisite && prerequisite.kind;
      const availability = prerequisite && prerequisite.availability;

      if (availability === AVAILABILITY.HELD || availability === AVAILABILITY.OBTAINABLE) continue;

      if (availability === AVAILABILITY.UNOBTAINABLE) {
        return tv.violated({
          observed: {
            stopSequence: stop.sequence === undefined ? null : stop.sequence,
            prerequisite: kind === undefined ? null : kind,
            availability,
          },
          required: REQUIRED,
          inputSource: "CONTROL_PLANE",
          reason: `the ${String(kind)} prerequisite at stop ${String(stop.sequence)} cannot be obtained — an agent that cannot get in cannot deliver (§7.5 F32)`,
        });
      }

      // The DENY_UNLESS_ENVELOPE case. The unobtainable prerequisite is named so the
      // caller can ask the Plan Builder for a reduced-envelope variant that avoids it
      // — ground-floor reception instead of the twelfth floor, gatehouse instead of
      // the loading dock.
      return tv.indeterminate({
        observed: {
          stopSequence: stop.sequence === undefined ? null : stop.sequence,
          prerequisite: kind === undefined ? null : kind,
          availability: availability === undefined ? null : String(availability),
        },
        required: REQUIRED,
        inputSource: "CONTROL_PLANE",
        reason:
          `the ${String(kind)} prerequisite at stop ${String(stop.sequence)} could not be confirmed ` +
          "obtainable. Under DENY_UNLESS_ENVELOPE this denies unless a reduced-envelope variant of " +
          "the mission is feasible under pessimistic assumptions (§7.3, §7.5 F32)",
      });
    }
  }

  return tv.satisfied({
    observed: { stopsChecked: stops.length },
    required: REQUIRED,
    inputSource: "CONTROL_PLANE",
  });
}

module.exports = { evaluate, AVAILABILITY };

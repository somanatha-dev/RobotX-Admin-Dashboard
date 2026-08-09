"use strict";

/**
 * **F37 — Deadline feasibility: earliest feasible completion ≤ hard deadline.**
 * Class F/C, governed as **C**. Indeterminate: `DENY` **when hard**.
 *
 * > Hard **only where the deadline is contractually hard**; otherwise it is priced by
 * > `C_delay` rather than gating, because **refusing to serve a late task is usually
 * > worse than serving it late**.
 *
 * ── The predicate that mostly declines to gate ─────────────────────────────
 * This is the only row in the register whose default behaviour is to *not* bind, and
 * the reasoning is an economic argument rather than a safety one. A task with a soft
 * 14:00 target that can only be completed at 14:20 should be assigned and delivered
 * twenty minutes late. Gating it produces an unassigned task that is delivered never,
 * which is worse for the customer, worse for the SLA, and worse for the fleet's
 * utilisation. §8.7's `C_delay` prices the lateness, and pricing is the correct
 * mechanism because it lets a twenty-minute overrun lose to a five-minute one without
 * either being excluded.
 *
 * So the predicate reads the deadline's **hardness** first, and a soft deadline is
 * `SATISFIED` regardless of the projection — with the shortfall reported in the
 * observed tuple, so the near-miss telemetry still sees it.
 *
 * ── What makes a deadline hard ──────────────────────────────────────────────
 * Contractual hardness is a property of the task's SLA contract, recorded upstream —
 * a customs window, a surgical delivery, a regulated chain-of-custody handover. It is
 * never inferred here from the deadline's proximity or from the SLA class's name: an
 * engine that decided for itself which deadlines were hard would be writing contract
 * terms.
 *
 * A task that states a deadline without stating whether it is hard is
 * `INDETERMINATE` — under class C's `DENY` that rejects, which is the conservative
 * reading and also the one that surfaces the missing contract metadata rather than
 * silently choosing the permissive interpretation.
 *
 * ── Governed as class C ─────────────────────────────────────────────────────
 * §7.5 gives F37 two classes, `F/C`. The register governs it as **C** — the half that
 * carries an external obligation — so the mandatory-DENY check runs against the class
 * whose breach has a counterparty.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

const REQUIRED = "earliest feasible completion no later than a contractually hard deadline";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const mission = (context && context.mission) || null;
  const plan = (context && context.plan) || null;

  if (!mission) return tv.absent("the mission", { required: REQUIRED });

  const deadlineMs = tv.epochMs(mission.deadlineMs);

  // No deadline at all: nothing to be late for.
  if (deadlineMs === null) {
    return tv.satisfied({
      observed: { deadlineMs: null },
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason: "the task states no deadline; F37 does not bind",
    });
  }

  const hard = mission.deadlineIsContractuallyHard;
  if (hard === undefined || hard === null) {
    return tv.indeterminate({
      observed: { deadlineMs },
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason:
        "the task states a deadline without stating whether it is contractually hard. Hardness is a " +
        "contract term recorded upstream, never inferred here from proximity or SLA class name — an " +
        "engine that decided which deadlines were hard would be writing contract terms (§7.5 F37)",
    });
  }

  if (!plan) return tv.absent("the candidate plan", { required: REQUIRED });

  const completionMs = tv.epochMs(
    plan.earliestFeasibleCompletionMs !== undefined && plan.earliestFeasibleCompletionMs !== null
      ? plan.earliestFeasibleCompletionMs
      : plan.projectedEndMs,
  );

  if (completionMs === null) {
    return tv.absent("the plan's earliest feasible completion", {
      observed: { deadlineMs, hard: hard === true },
      required: REQUIRED,
      inputSource: "PLAN",
    });
  }

  const marginMs = deadlineMs - completionMs;

  // ── Soft: priced, not gated ───────────────────────────────────────────────
  if (hard !== true) {
    return tv.satisfied({
      observed: { deadlineMs, hard: false, earliestFeasibleCompletionMs: completionMs, shortfallMs: marginMs < 0 ? -marginMs : 0 },
      required: REQUIRED,
      inputSource: "PLAN",
      margin: marginMs,
      marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
      reason:
        marginMs < 0
          ? "the deadline is soft and will be missed; §8.7's C_delay prices the lateness rather than " +
            "gating, because refusing to serve a late task is usually worse than serving it late (§7.5 F37)"
          : null,
    });
  }

  // ── Hard: gated ───────────────────────────────────────────────────────────
  if (completionMs > deadlineMs) {
    return tv.violated({
      observed: { deadlineMs, hard: true, earliestFeasibleCompletionMs: completionMs },
      required: { deadlineMs },
      inputSource: "PLAN",
      margin: marginMs,
      marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
      reason:
        `the earliest feasible completion is ${-marginMs} ms after a contractually hard deadline ` +
        "(§7.5 F37)",
    });
  }

  return tv.satisfied({
    observed: { deadlineMs, hard: true, earliestFeasibleCompletionMs: completionMs },
    required: { deadlineMs },
    inputSource: "PLAN",
    margin: marginMs,
    marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
  });
}

module.exports = { evaluate };

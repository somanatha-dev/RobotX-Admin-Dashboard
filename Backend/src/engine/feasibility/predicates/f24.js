"use strict";

/**
 * **F24 — Centre-of-gravity envelope satisfied for every loading state.** Class I.
 * Indeterminate: `DENY`.
 *
 * > Tipping risk on gradients and in turns.
 *
 * ── "Every loading state", and why that is more than "every stop" ───────────
 * F22 iterates the plan's stops. F24 iterates its *loading states*, and the two are
 * not the same sequence: loading and unloading at a single stop passes through
 * intermediate configurations, and a plan that is stable before and after a stop can
 * be unstable during it. §15.4 makes the load state a projection along the plan for
 * exactly this reason, and the CoG check consumes each state rather than each stop.
 *
 * ── Why this is separate from F22 rather than folded into it ────────────────
 * Mass and balance fail independently and are fixed differently. An agent within its
 * mass limit can still be outside its CoG envelope — a single heavy item in the
 * rearmost compartment is the standard case — and the remedy is a different placement,
 * not a lighter load. Merging the two would report "payload infeasible" for both and
 * make the binding-constraint distribution of §7.7 useless for the one operational
 * question it exists to answer.
 *
 * ── The envelope is the container model's; the projection is Phase 7's ──────
 * `ContainerModel.cogEnvelope` (§15.2) declares the permissible region.
 * `engine/payload/loadState.js` (Phase 7) projects the CoG at each loading state
 * against it. This predicate reads the per-state verdict and the margin, and denies on
 * the first state outside the envelope. Computing a centre of gravity here would put a
 * second mass-distribution model in the feasibility gate.
 *
 * Tier 0 (T0-01, T0-04).
 */

const tv = require("../threeValued");

const REQUIRED = "centre of gravity inside the declared envelope at every loading state (§15.2)";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const plan = (context && context.plan) || null;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });
  if (!plan) return tv.absent("the candidate plan", { required: REQUIRED });

  const envelope = agent.containerModel && agent.containerModel.cogEnvelope;
  if (envelope === undefined || envelope === null) {
    return tv.absent("the container model's CoG envelope", {
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason:
        "the agent's container model declares no centre-of-gravity envelope. An undeclared envelope " +
        "is not an unbounded one (§15.2)",
    });
  }

  const states = plan.loadState;
  if (states === undefined) {
    return tv.absent("the plan's per-state load projection (§15.4)", {
      required: REQUIRED,
      inputSource: "PLAN",
      reason:
        "no loading-state projection is attached to this plan. §15.4's projection is " +
        "engine/payload/loadState.js (Phase 7); computing a centre of gravity here would put a " +
        "second mass-distribution model in the feasibility gate",
    });
  }
  if (states === null || !Array.isArray(states) || states.length === 0) {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "PLAN",
      reason: "the loading-state projection is empty or unreadable; the CoG envelope cannot be checked",
    });
  }

  let tightestMargin = null;

  for (const state of states) {
    const cog = state && state.cog;

    if (!cog || typeof cog !== "object") {
      return tv.indeterminate({
        observed: { stopSequence: state ? state.sequence : null },
        required: REQUIRED,
        inputSource: "PLAN",
        reason: "a loading state carries no projected centre of gravity; tipping risk cannot be bounded",
      });
    }

    if (cog.withinEnvelope === undefined || cog.withinEnvelope === null) {
      return tv.indeterminate({
        observed: { stopSequence: state.sequence === undefined ? null : state.sequence },
        required: REQUIRED,
        inputSource: "PLAN",
        reason: "the projected centre of gravity states no envelope verdict",
      });
    }

    if (cog.withinEnvelope !== true) {
      return tv.violated({
        observed: {
          stopSequence: state.sequence === undefined ? null : state.sequence,
          longitudinalMm: cog.longitudinalMm === undefined ? null : cog.longitudinalMm,
          lateralMm: cog.lateralMm === undefined ? null : cog.lateralMm,
          heightMm: cog.heightMm === undefined ? null : cog.heightMm,
        },
        required: REQUIRED,
        inputSource: "PLAN",
        margin: tv.isNumber(cog.envelopeMarginMm) ? cog.envelopeMarginMm : null,
        marginUnit: tv.MARGIN_UNIT.METRES,
        reason:
          `the centre of gravity is outside the declared envelope at loading state ` +
          `${String(state.sequence)} — tipping risk on gradients and in turns (§7.5 F24, §15.2)`,
      });
    }

    if (tv.isNumber(cog.envelopeMarginMm)) {
      if (tightestMargin === null || cog.envelopeMarginMm < tightestMargin) tightestMargin = cog.envelopeMarginMm;
    }
  }

  return tv.satisfied({
    observed: { loadingStatesChecked: states.length, tightestEnvelopeMarginMm: tightestMargin },
    required: REQUIRED,
    inputSource: "PLAN",
    margin: tightestMargin,
    marginUnit: tv.MARGIN_UNIT.METRES,
  });
}

module.exports = { evaluate };

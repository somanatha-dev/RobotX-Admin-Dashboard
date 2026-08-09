"use strict";

/**
 * **F15 — Link quality sufficient for the mission's supervision requirement.**
 * Class P. Indeterminate: `ADMIT_WITH_PENALTY`.
 *
 * > Missions requiring continuous supervision or teleoperation fallback need a link
 * > budget; a mission in a known dead zone requires an agent certified for autonomous
 * > operation there.
 *
 * ── The requirement is the mission's, not the agent's ───────────────────────
 * The same link quality is sufficient for one mission and insufficient for another,
 * because what varies is the *supervision mode* the mission demands. Three modes, and
 * the predicate reads which one applies before it reads any signal strength:
 *
 *   - `AUTONOMOUS`            — no continuous link required. The link budget does not
 *     gate; a dead zone is acceptable **if** the agent is certified for autonomous
 *     operation there, which is the second half of §7.5's sentence.
 *   - `CONTINUOUS_SUPERVISION` — a link budget applies throughout.
 *   - `TELEOP_FALLBACK`        — a link budget applies, because the fallback is only a
 *     fallback if it can be invoked.
 *
 * ── The dead-zone clause ────────────────────────────────────────────────────
 * A mission whose route crosses a known dead zone is not simply a low-link mission: it
 * is one where the link will be *absent* for a stretch, and no margin on average
 * quality substitutes for certification to operate without it. That is why the
 * certification check is a separate branch rather than a lower threshold.
 *
 * `connectivity.max_deadzone_extension` bounds how far a certified agent may extend
 * into one; beyond it, even a certified agent is barred, because certification
 * attests to operating without a link, not to operating without one indefinitely.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

/**
 * §7.5 F15's supervision modes.
 * @structural the specification's own supervision-requirement labels
 */
const SUPERVISION = Object.freeze({
  AUTONOMOUS: "AUTONOMOUS",
  CONTINUOUS_SUPERVISION: "CONTINUOUS_SUPERVISION",
  TELEOP_FALLBACK: "TELEOP_FALLBACK",
});

const REQUIRED = "link quality sufficient for the mission's supervision requirement";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const mission = (context && context.mission) || null;
  const plan = (context && context.plan) || null;
  const config = context && context.config;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });
  if (!mission) return tv.absent("the mission", { required: REQUIRED });

  const supervision = mission.supervisionRequirement;
  if (supervision === undefined || supervision === null) {
    return tv.absent("the mission's supervision requirement", { required: REQUIRED, inputSource: "CONTROL_PLANE" });
  }
  if (!Object.prototype.hasOwnProperty.call(SUPERVISION, supervision)) {
    return tv.indeterminate({
      observed: String(supervision),
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      reason: `supervision requirement "${String(supervision)}" is not one of ${Object.keys(SUPERVISION).join(", ")}`,
    });
  }

  // ── The dead-zone clause ──────────────────────────────────────────────────
  const deadZoneM = plan && plan.route ? plan.route.deadZoneExtentM : undefined;
  if (tv.isNumber(deadZoneM) && deadZoneM > 0) {
    const maxExtensionM = tv.readParameter(config, "connectivity.max_deadzone_extension");
    if (!tv.isNumber(maxExtensionM)) {
      return tv.absent("connectivity.max_deadzone_extension", {
        observed: { deadZoneExtentM: deadZoneM },
        required: REQUIRED,
        inputSource: "CONFIG",
      });
    }

    const certified = agent.autonomousDeadZoneCertified;
    if (certified === undefined) {
      return tv.absent("the agent's autonomous dead-zone certification", {
        observed: { deadZoneExtentM: deadZoneM },
        required: REQUIRED,
        inputSource: "CONTROL_PLANE",
      });
    }
    if (certified !== true) {
      return tv.violated({
        observed: { deadZoneExtentM: deadZoneM, autonomousCertified: false },
        required: { autonomousCertified: true },
        inputSource: "CONTROL_PLANE",
        reason:
          "the route crosses a known dead zone and the agent is not certified for autonomous " +
          "operation there. No margin on average link quality substitutes for that certification (§7.5 F15)",
      });
    }
    if (deadZoneM > maxExtensionM) {
      return tv.violated({
        observed: { deadZoneExtentM: deadZoneM, autonomousCertified: true },
        required: { maxDeadZoneExtentM: maxExtensionM },
        inputSource: "CONFIG",
        margin: maxExtensionM - deadZoneM,
        marginUnit: tv.MARGIN_UNIT.METRES,
        reason:
          `the dead-zone extent ${deadZoneM} m exceeds connectivity.max_deadzone_extension ` +
          `(${maxExtensionM} m). Certification attests to operating without a link, not to doing so ` +
          "indefinitely (§7.5 F15)",
      });
    }
  }

  // ── The link budget ───────────────────────────────────────────────────────
  if (supervision === SUPERVISION.AUTONOMOUS) {
    return tv.satisfied({
      observed: { supervision, linkBudgetApplies: false },
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
    });
  }

  const minQuality = tv.readIndexedParameter(config, "link.min_quality", supervision);
  if (!tv.isNumber(minQuality)) {
    return tv.absent(`link.min_quality for supervision requirement "${supervision}"`, {
      required: REQUIRED,
      inputSource: "CONFIG",
    });
  }

  const observed = agent.session && agent.session.linkQuality;
  if (!tv.isNumber(observed)) {
    // The declared policy's case: admitted with the uncertainty penalty and a shrunk
    // envelope, not denied. An unmeasured link on a supervised mission is a priced
    // risk, which is what class P and ADMIT_WITH_PENALTY together mean.
    return tv.indeterminate({
      observed: { supervision, linkQuality: null },
      required: { minQuality },
      inputSource: "SENSOR",
      reason: "no link-quality measurement is available for a mission that requires a link budget (§7.5 F15)",
    });
  }

  const margin = observed - minQuality;

  if (observed < minQuality) {
    return tv.violated({
      observed: { supervision, linkQuality: observed },
      required: { minQuality },
      inputSource: "SENSOR",
      margin,
      marginUnit: tv.MARGIN_UNIT.RATIO,
      reason: `link quality ${observed} is below the ${minQuality} required for ${supervision} (§7.5 F15)`,
    });
  }

  return tv.satisfied({
    observed: { supervision, linkQuality: observed },
    required: { minQuality },
    inputSource: "SENSOR",
    margin,
    marginUnit: tv.MARGIN_UNIT.RATIO,
  });
}

module.exports = { evaluate, SUPERVISION };

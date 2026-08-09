"use strict";

/**
 * **F6 — Calibration and certification valid at projected mission end.** Class R.
 * Indeterminate: `DENY`.
 *
 * > Sensor calibration or a handling certificate expiring mid-mission is a compliance
 * > and safety breach; **checking at decision time is insufficient**.
 *
 * The temporal point is the entire predicate. A certificate with four minutes left
 * passes every "is it valid now" test and fails the mission it was checked for. §2.3
 * states the same rule for the capability algebra — "Certified capabilities MUST be
 * checked against *mission end time*, not decision time" — and `domain/capability.js`
 * takes the mission end as an argument precisely so this predicate can supply it.
 *
 * ── The mission end is an input, never a clock read ─────────────────────────
 * `plan.projectedEndMs` comes from the plan being evaluated, which is pinned in the
 * round's snapshot (§9.6). A predicate that read the wall clock and added an estimate
 * would be non-replayable (T6) and would also answer a different question on every
 * evaluation of the same candidate.
 *
 * ── Two sources, one rule ───────────────────────────────────────────────────
 * Certifications are `CERTIFIED`-kind capabilities in the attested bundle (§2.3);
 * calibrations are per-agent records with their own expiry. Both are checked against
 * the same instant. A calibration record with **no** stated expiry is `INDETERMINATE`,
 * for the reason `capability.js` gives about certifications: a record with no expiry
 * is not valid forever, it is a record whose expiry nobody wrote down.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");
const { CAPABILITY_KIND, MATCH, indexBundle, validityAt } = require("../../domain/capability");

const REQUIRED = "every calibration and certification valid at projected mission end";

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const plan = (context && context.plan) || null;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });

  const missionEndMs = tv.epochMs(plan && plan.projectedEndMs);
  if (missionEndMs === null) {
    return tv.absent("the plan's projected mission end", {
      required: REQUIRED,
      reason:
        "the projected mission end is absent, so validity cannot be checked at the instant §7.5 F6 " +
        "requires. Checking at decision time instead is the defect this predicate exists to remove",
    });
  }

  // ── Certifications, from the attested capability bundle (§2.3) ────────────
  const certified = [...indexBundle(agent.capabilityBundle).values()].filter(
    (capability) => capability.kind === CAPABILITY_KIND.CERTIFIED,
  );

  for (const capability of certified) {
    const validity = validityAt(capability, missionEndMs);
    if (validity === MATCH.VIOLATED) {
      const untilMs = tv.epochMs(capability.validUntil);
      return tv.violated({
        observed: { certification: capability.name, validUntil: capability.validUntil || null },
        required: { validAtEpochMs: missionEndMs },
        inputSource: "CONTROL_PLANE",
        margin: untilMs === null ? null : untilMs - missionEndMs,
        marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
        reason: `certification "${capability.name}" is not valid at projected mission end (§2.3, §7.5 F6)`,
      });
    }
    if (validity === MATCH.INDETERMINATE) {
      return tv.indeterminate({
        observed: { certification: capability.name, validUntil: capability.validUntil || null },
        required: { validAtEpochMs: missionEndMs },
        inputSource: "CONTROL_PLANE",
        reason:
          `certification "${capability.name}" states no readable validity window. A certification ` +
          "with no expiry is not valid forever; it is a record whose expiry nobody wrote down (§2.3)",
      });
    }
  }

  // ── Calibrations ──────────────────────────────────────────────────────────
  const calibrations = agent.calibrations;
  if (calibrations === undefined) {
    return tv.absent("the agent's calibration records", {
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
    });
  }

  const list = Array.isArray(calibrations) ? calibrations : [];
  for (const calibration of list) {
    const name = calibration && calibration.name ? String(calibration.name) : "<unnamed>";
    const validUntilMs = tv.epochMs(calibration && calibration.validUntil);

    if (validUntilMs === null) {
      return tv.indeterminate({
        observed: { calibration: name, validUntil: (calibration && calibration.validUntil) || null },
        required: { validAtEpochMs: missionEndMs },
        inputSource: "CONTROL_PLANE",
        reason:
          `calibration "${name}" states no readable expiry. Sensor calibration without a recorded ` +
          "expiry cannot be shown valid at mission end (§7.5 F6)",
      });
    }

    if (validUntilMs < missionEndMs) {
      return tv.violated({
        observed: { calibration: name, validUntilEpochMs: validUntilMs },
        required: { validAtEpochMs: missionEndMs },
        inputSource: "CONTROL_PLANE",
        // Negative: how far short of the mission end the calibration expires.
        margin: validUntilMs - missionEndMs,
        marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
        reason:
          `calibration "${name}" expires before projected mission end. A calibration expiring ` +
          "mid-mission is a compliance and safety breach (§7.5 F6)",
      });
    }
  }

  // The tightest remaining margin across both sources, so the near-miss sketch of
  // §7.7 records how close this agent is to falling out rather than only that it did.
  const margins = [
    ...certified.map((capability) => tv.epochMs(capability.validUntil)),
    ...list.map((calibration) => tv.epochMs(calibration && calibration.validUntil)),
  ]
    .filter((value) => value !== null)
    .map((value) => value - missionEndMs);

  return tv.satisfied({
    observed: { certifications: certified.length, calibrations: list.length },
    required: { validAtEpochMs: missionEndMs },
    inputSource: "CONTROL_PLANE",
    margin: margins.length === 0 ? null : Math.min(...margins),
    marginUnit: tv.MARGIN_UNIT.MILLISECONDS,
  });
}

module.exports = { evaluate };

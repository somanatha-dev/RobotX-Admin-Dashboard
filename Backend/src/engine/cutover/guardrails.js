"use strict";

/**
 * Pre-declared SLI guardrails and automatic rollback (§22.3, §22.4 item 4) — **Tier 1**.
 *
 * > 4. **Stage by shard**, monitored against **pre-declared** SLI guardrails, with
 * >    automatic rollback. (§22.4)
 *
 * > **Tuned** … Shadow-mode evaluation, then staged rollout by shard with automatic
 * > rollback on SLI regression. (§22.3)
 *
 * ── "Pre-declared" is the whole mechanism, and it is enforced ───────────────
 * A guardrail chosen after the data is in is not a guardrail; it is a rationalisation.
 * `declare()` therefore stamps the declaration with the instant it was made and the
 * person who made it, and `assess()` **refuses** to evaluate an observation window that
 * began before its guardrails were declared. That refusal is the point of this module.
 * Without it, "we staged against SLI guardrails" degrades into "we looked at the
 * dashboards afterwards and they seemed fine", which is how a regression ships.
 *
 * ── Automatic rollback is one-directional, and that is a §22.3 requirement ──
 * §22.3 places the cutover in the **Structural** change class ("shard boundaries,
 * capacity limits, agent-class definitions … change management with a rehearsed rollback
 * plan") and states an absolute rule one row above it:
 *
 * > **No automated tuner may modify a Safety-class parameter.** This is an absolute
 * > rule. An optimiser permitted to reduce its own safety margins in pursuit of
 * > throughput will do exactly that, and it will be locally correct every time.
 *
 * The tension is real and is resolved rather than papered over. An automatic process
 * that could *enable* a shard would be an automated process making the highest-blast-
 * radius change in the system. An automatic process that can only *disable* one is the
 * rollback §22.4 explicitly asks for. So `permittedAutomaticAction()` admits exactly one
 * transition — live → not live — and `assertOneDirectional()` throws if a caller tries
 * to route an enable through the automatic path. Enabling a shard is
 * `cutover/stage.js`'s `authoriseEnable()`, which requires a second approver.
 *
 * ── A guardrail needs a sample size, or it is a coin toss ───────────────────
 * Every declaration carries `minSamples`. A p99.9 target evaluated over 40 observations
 * has not been evaluated; it has been guessed at, and a rollback triggered by that guess
 * is an outage caused by the safety mechanism. `assess()` reports such a window as
 * `INSUFFICIENT_EVIDENCE`, which neither proceeds nor rolls back — it holds, and holding
 * is a distinct verdict for the same reason `NOT_EVALUATED` is a distinct gate status.
 *
 * ── No clock ────────────────────────────────────────────────────────────────
 * Every instant is supplied. A module that read its own clock would let a rollback
 * decision disagree with the observation window it claims to have evaluated.
 */

const { compareStrings } = require("../determinism/ordering");

/** @structural milliseconds per second */
const MS_PER_SECOND = 1000;

/** @structural the direction in which an SLI regresses */
const DIRECTION = Object.freeze({
  /** The observed value must stay at or below the threshold (latency, error rate). */
  AT_MOST: "AT_MOST",
  /** The observed value must stay at or above the threshold (attainment, hit rate). */
  AT_LEAST: "AT_LEAST",
});

/** @structural what an assessment concludes */
const VERDICT = Object.freeze({
  /** Every guardrail held over a sufficient window: the stage may advance. */
  PROCEED: "PROCEED",
  /** The window is too small, or too young, to conclude anything. Stay, do not advance. */
  HOLD: "HOLD",
  /** At least one guardrail regressed: disable this shard now. */
  ROLL_BACK: "ROLL_BACK",
});

/** @structural why a guardrail could not be concluded */
const INCONCLUSIVE = Object.freeze({
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE",
  NOT_OBSERVED: "NOT_OBSERVED",
});

/**
 * The transitions the automatic controller may perform. Exactly one, deliberately.
 * @structural the automatic action set; its size is the §22.3 rule, not a tuning choice
 */
const AUTOMATIC_ACTIONS = Object.freeze(["DISABLE"]);

/**
 * Validate and stamp a guardrail set.
 *
 * @param {{ shardId: string, declaredBy: string, declaredAtMs: number,
 *   observationWindowSeconds: number, guardrails: object[] }} input
 * @returns {{ shardId: string, declaredBy: string, declaredAtMs: number,
 *   observationWindowSeconds: number, guardrails: object[] }}
 */
function declare(input) {
  const source = input || {};
  const shardId = source.shardId ? String(source.shardId) : "";
  if (!shardId) throw new Error("a guardrail declaration names the shard it governs");
  if (!source.declaredBy) {
    throw new Error(
      "a guardrail declaration names who declared it. §22.3 puts the cutover in the Structural change " +
        "class, and an unowned declaration cannot be part of change management.",
    );
  }
  if (typeof source.declaredAtMs !== "number" || !Number.isFinite(source.declaredAtMs)) {
    throw new Error("a guardrail declaration carries the instant it was declared, so 'pre-declared' is checkable");
  }
  if (typeof source.observationWindowSeconds !== "number" || source.observationWindowSeconds <= 0) {
    throw new Error("a guardrail declaration carries the observation window it is evaluated over");
  }

  const guardrails = Array.isArray(source.guardrails) ? source.guardrails : [];
  if (guardrails.length === 0) {
    throw new Error(
      "a guardrail declaration with no guardrails is a stage with no guardrails. §22.4 item 4 requires " +
        "the staging to be monitored, so an empty set is refused rather than defaulted.",
    );
  }

  const seen = new Set();
  const normalised = guardrails.map((raw) => {
    const guardrail = raw || {};
    const id = guardrail.id ? String(guardrail.id) : "";
    if (!id) throw new Error("every guardrail names the SLI it watches");
    if (seen.has(id)) throw new Error(`guardrail declared twice: ${id}`);
    seen.add(id);
    if (!Object.values(DIRECTION).includes(guardrail.direction)) {
      throw new Error(`guardrail ${id} must declare a direction (${Object.values(DIRECTION).join(" | ")})`);
    }
    if (typeof guardrail.threshold !== "number" || !Number.isFinite(guardrail.threshold)) {
      throw new Error(`guardrail ${id} must declare a numeric threshold`);
    }
    if (typeof guardrail.minSamples !== "number" || guardrail.minSamples <= 0) {
      throw new Error(
        `guardrail ${id} must declare minSamples. A tail target concluded from a handful of observations ` +
          "produces a rollback caused by the safety mechanism rather than by a regression.",
      );
    }
    return Object.freeze({
      id,
      direction: guardrail.direction,
      threshold: guardrail.threshold,
      minSamples: guardrail.minSamples,
      unit: guardrail.unit || null,
      parameter: guardrail.parameter || null,
      rationale: guardrail.rationale || null,
    });
  });

  normalised.sort((a, b) => compareStrings(a.id, b.id));

  return Object.freeze({
    shardId,
    declaredBy: String(source.declaredBy),
    declaredAtMs: source.declaredAtMs,
    observationWindowSeconds: source.observationWindowSeconds,
    guardrails: Object.freeze(normalised),
  });
}

/**
 * Did one guardrail hold?
 *
 * @param {object} guardrail a normalised declaration entry
 * @param {{ value?: number, samples?: number }|undefined} observation
 * @returns {{ id: string, held: boolean|null, reason: string|null, observed: number|null, samples: number }}
 */
function assessOne(guardrail, observation) {
  if (!observation || typeof observation.value !== "number" || !Number.isFinite(observation.value)) {
    return { id: guardrail.id, held: null, reason: INCONCLUSIVE.NOT_OBSERVED, observed: null, samples: 0 };
  }
  const samples = typeof observation.samples === "number" ? observation.samples : 0;
  if (samples < guardrail.minSamples) {
    return {
      id: guardrail.id,
      held: null,
      reason: INCONCLUSIVE.INSUFFICIENT_EVIDENCE,
      observed: observation.value,
      samples,
    };
  }
  const held =
    guardrail.direction === DIRECTION.AT_MOST
      ? observation.value <= guardrail.threshold
      : observation.value >= guardrail.threshold;
  return { id: guardrail.id, held, reason: null, observed: observation.value, samples };
}

/**
 * Assess a staged shard's observation window against its pre-declared guardrails.
 *
 * @param {object} declaration the output of `declare()`
 * @param {{ windowStartedAtMs: number, windowEndedAtMs: number, observations: object }} window
 * @returns {{ verdict: string, shardId: string, findings: object[], breached: object[],
 *   inconclusive: object[], elapsedSeconds: number, refusal: string|null }}
 */
function assess(declaration, window) {
  const observed = window || {};
  const startedAtMs = observed.windowStartedAtMs;
  const endedAtMs = observed.windowEndedAtMs;

  /**
   * ── Both endpoints are instants, not merely of type `number` ────────────────
   *
   * PHASE 15 remediation (P15-E1, second site). This read `typeof … !== "number"`, and
   * `typeof NaN === "number"`. Every comparison against `NaN` is false, so a window with a
   * `NaN` endpoint switched off **both** of this function's own rules rather than failing
   * either: `startedAtMs < declaration.declaredAtMs` was false, so the pre-declaration
   * refusal — *"the refusal this module exists for"*, two screens down — never fired; and
   * `elapsedSeconds < declaration.observationWindowSeconds` was false, so a window of no
   * length satisfied the length requirement. A shard with no breached guardrail then
   * reported `PROCEED`.
   *
   * The production composition supplies finite endpoints today (`server.js` builds them
   * from `declaration.declaredAtMs`, which `declare()` validates, and `Date.now()`), so this
   * was latent rather than live. It is fixed rather than recorded because it is permissive:
   * the sibling finding at `evidence.js`'s PRODUCTION branch is the identical mechanism and
   * *was* reachable, and a fail-open on a path nobody reaches today is a fail-open waiting
   * for the caller that does.
   */
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    throw new Error(
      "an assessment names the observation window it evaluated, by both endpoints, as finite instants. " +
        "`NaN` and `Infinity` are refused rather than compared: every comparison against them is false, so " +
        "an unusable endpoint would silently switch off both the pre-declaration ordering refusal and the " +
        "window-length requirement instead of failing them.",
    );
  }

  // The refusal this module exists for. A window that opened before its guardrails were
  // declared cannot discharge "pre-declared", and letting it would make the discipline
  // decorative.
  if (startedAtMs < declaration.declaredAtMs) {
    return {
      verdict: VERDICT.HOLD,
      shardId: declaration.shardId,
      findings: [],
      breached: [],
      inconclusive: [],
      elapsedSeconds: Math.max(0, (endedAtMs - startedAtMs) / MS_PER_SECOND),
      refusal:
        "the observation window opened before the guardrails were declared. §22.4 item 4 requires " +
        "pre-declared guardrails; a window evaluated against guardrails chosen after it began is not evidence.",
    };
  }

  const observations = observed.observations || {};
  const findings = declaration.guardrails.map((guardrail) => {
    const result = assessOne(guardrail, observations[guardrail.id]);
    return { ...result, direction: guardrail.direction, threshold: guardrail.threshold, unit: guardrail.unit };
  });

  const breached = findings.filter((finding) => finding.held === false);
  const inconclusive = findings.filter((finding) => finding.held === null);
  const elapsedSeconds = Math.max(0, (endedAtMs - startedAtMs) / MS_PER_SECOND);

  let verdict;
  if (breached.length > 0) {
    // A regression is conclusive even if some other guardrail lacks samples: a breach is
    // evidence, and waiting for the rest of the window while a shard misbehaves is the
    // failure the automatic rollback exists to prevent.
    verdict = VERDICT.ROLL_BACK;
  } else if (inconclusive.length > 0 || elapsedSeconds < declaration.observationWindowSeconds) {
    verdict = VERDICT.HOLD;
  } else {
    verdict = VERDICT.PROCEED;
  }

  return {
    verdict,
    shardId: declaration.shardId,
    findings,
    breached,
    inconclusive,
    elapsedSeconds,
    refusal: null,
  };
}

/**
 * The action the automatic controller may take for a verdict — and nothing else.
 *
 * @param {string} verdict
 * @returns {string|null} `"DISABLE"` or null
 */
function permittedAutomaticAction(verdict) {
  return verdict === VERDICT.ROLL_BACK ? AUTOMATIC_ACTIONS[0] : null;
}

/**
 * Refuse an automatic action that is not a rollback.
 *
 * Called by the controller before it writes anything. The message names the rule rather
 * than the symptom, because the next person to reach for this path will be trying to
 * automate the enable and should be told why they may not.
 *
 * @param {string} action
 * @returns {true}
 */
function assertOneDirectional(action) {
  if (!AUTOMATIC_ACTIONS.includes(action)) {
    throw new Error(
      `the automatic staged-rollout controller may only ${AUTOMATIC_ACTIONS.join("/")} a shard, not "${action}". ` +
        "§22.3: no automated process may make the change that raises risk; enabling a shard is an operator " +
        "action with a second approver (cutover/stage.js authoriseEnable).",
    );
  }
  return true;
}

module.exports = {
  DIRECTION,
  VERDICT,
  INCONCLUSIVE,
  AUTOMATIC_ACTIONS,
  declare,
  assessOne,
  assess,
  permittedAutomaticAction,
  assertOneDirectional,
};

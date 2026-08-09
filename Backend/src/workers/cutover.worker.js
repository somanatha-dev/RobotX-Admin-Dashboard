"use strict";

/**
 * The staged-rollout controller (§22.4 item 4, execution plan Phase 15) — **Tier 1**.
 *
 * > 4. **Stage by shard**, monitored against pre-declared SLI guardrails, with automatic
 * >    rollback.
 *
 * One pass is: for every shard currently live, collect its SLI window, assess it against
 * the guardrails that were declared *before* it was taken live, and — if any regressed —
 * roll that shard back, publish the reverted binding, and write the audit event. It never
 * enables anything. `guardrails.assertOneDirectional()` is called on the way through, so
 * a future change that tried to automate the enable fails loudly at the one place that
 * would have to be edited.
 *
 * ── Why the controller re-reads the declaration rather than caching it ──────
 * The declaration is the evidence that the guardrails were pre-declared. A controller
 * holding its own copy in memory would survive a restart with a copy nobody can audit,
 * and would evaluate a shard against guardrails that no longer match the published ones.
 * It is therefore supplied per pass by `deps.declarationFor(shardId)`.
 *
 * ── A rollback that cannot be published is still reported ───────────────────
 * If `deps.publish` throws, the pass records the failure and re-raises through
 * `deps.onError`. It deliberately does **not** swallow it and report a rollback that did
 * not happen: the whole value of an automatic rollback is that its record and its effect
 * agree.
 *
 * ── No clock ────────────────────────────────────────────────────────────────
 * The pass takes `nowMs`. A controller that read its own clock could assess a window it
 * did not observe.
 */

const guardrails = require("../engine/cutover/guardrails");
const stage = require("../engine/cutover/stage");

/**
 * Default cadence, in milliseconds. Overridden from `cutover.guardrail_check_interval`.
 * @structural the loop's fallback cadence when no configuration is supplied
 */
const DEFAULT_INTERVAL_MS = 30000;

/** @structural milliseconds per second */
const MS_PER_SECOND = 1000;

/**
 * Assess one live shard and, if it regressed, roll it back.
 *
 * @param {object} deps `{ publish, audit, declarationFor, observationsFor, onRollback }`
 * @param {object} shard `{ shardId, regionId, state }`
 * @param {{ nowMs: number }} context
 * @returns {Promise<{ shardId: string, verdict: string, rolledBack: boolean, assessment: object|null,
 *   skipped: string|null }>}
 */
async function assessShard(deps, shard, context) {
  const shardId = String(shard.shardId);
  const declaration = await deps.declarationFor(shardId);
  if (!declaration) {
    // A live shard with no declaration is itself a finding: it means something took the
    // shard live outside `stage.authoriseEnable`, which refuses exactly this. It is
    // surfaced, not defaulted to "no guardrails, therefore fine".
    return {
      shardId,
      verdict: guardrails.VERDICT.HOLD,
      rolledBack: false,
      assessment: null,
      skipped:
        "live with no pre-declared guardrails. stage.authoriseEnable refuses this, so the shard was " +
        "enabled outside the authorised path (§22.4 item 4).",
    };
  }

  const window = await deps.observationsFor(shardId, declaration);
  const assessment = guardrails.assess(declaration, window);

  const action = guardrails.permittedAutomaticAction(assessment.verdict);
  if (!action) {
    return { shardId, verdict: assessment.verdict, rolledBack: false, assessment, skipped: null };
  }
  guardrails.assertOneDirectional(action);

  const authorisation = stage.authoriseRollback({
    shard,
    automatic: true,
    reason:
      `automatic rollback: ${assessment.breached.length} pre-declared SLI guardrail(s) regressed — ` +
      assessment.breached.map((finding) => `${finding.id}=${finding.observed} (${finding.direction} ${finding.threshold})`).join(", "),
    assessment,
    requestedAtMs: context.nowMs,
  });

  if (!authorisation.authorised) {
    throw new Error(`automatic rollback for ${shardId} was refused: ${authorisation.refusal.message}`);
  }

  await deps.publish(authorisation.action);
  if (typeof deps.audit === "function") await deps.audit(stage.auditEventFor(authorisation.action));
  if (typeof deps.onRollback === "function") deps.onRollback(authorisation.action, assessment);

  return { shardId, verdict: assessment.verdict, rolledBack: true, assessment, skipped: null };
}

/**
 * One controller pass over every live shard.
 *
 * @param {object} deps
 * @param {{ nowMs?: number }} [context]
 * @returns {Promise<{ assessed: number, rolledBack: number, held: number, proceeded: number, results: object[] }>}
 */
async function runOnce(deps, context) {
  const settings = context || {};
  const nowMs = typeof settings.nowMs === "number" ? settings.nowMs : Date.now();
  const shards = await deps.liveShards();

  const results = [];
  for (const shard of shards) {
    // Sequential on purpose: a rollback publishes a configuration version, and two
    // concurrent publishes would race for the same version pointer (§22.1 rule 4).
    // eslint-disable-next-line no-await-in-loop
    results.push(await assessShard(deps, shard, { nowMs }));
  }

  return {
    assessed: results.length,
    rolledBack: results.filter((result) => result.rolledBack).length,
    held: results.filter((result) => result.verdict === guardrails.VERDICT.HOLD).length,
    proceeded: results.filter((result) => result.verdict === guardrails.VERDICT.PROCEED).length,
    results,
  };
}

/**
 * Start the controller.
 *
 * @param {object} deps
 * @param {{ intervalMs?: number, checkIntervalSeconds?: number }} [context]
 * @returns {{ stop: () => void }}
 */
function start(deps, context) {
  const settings = context || {};
  const intervalMs = Number.isFinite(settings.intervalMs)
    ? settings.intervalMs
    : Number.isFinite(settings.checkIntervalSeconds)
      ? settings.checkIntervalSeconds * MS_PER_SECOND
      : DEFAULT_INTERVAL_MS;

  const handle = setInterval(() => {
    runOnce(deps, settings).catch((error) => {
      // A failed pass loses one window of guardrail evaluation and must not take the
      // process down — but it is never silent, because a controller nobody knows has
      // stopped assessing is worse than one that has stopped.
      if (deps && typeof deps.onError === "function") deps.onError(error);
    });
  }, intervalMs);

  if (typeof handle.unref === "function") handle.unref();

  return {
    stop() {
      clearInterval(handle);
    },
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  assessShard,
  runOnce,
  start,
  VERDICT: guardrails.VERDICT,
};

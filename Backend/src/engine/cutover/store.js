"use strict";

/**
 * Where a cutover's evidence lives — **Tier 1**.
 *
 * Two questions the staged-rollout controller has to answer on every pass, and neither
 * gets a new table:
 *
 *   1. **Which guardrails were pre-declared for this shard, and when?** Read back from
 *      the **audit stream**. §21.7 makes that stream "append-only, hash-chained, longer
 *      retention: operator actions, overrides, config changes, quarantine decisions,
 *      constraint relaxations, manual assignments, cancellations. Non-repudiation matters
 *      when a decision is disputed months later." A pre-declaration is exactly that kind
 *      of fact, and putting it anywhere else would give the cutover the one record in the
 *      system that could be edited without leaving a link in a chain. It also makes
 *      "pre-declared" verifiable after the fact by anyone with the audit table, rather
 *      than only by the process that happened to hold it in memory.
 *
 *   2. **What did this shard's SLIs do over the observation window?** Read from the SLI
 *      store through `observability/sli.js`. §3.3's cache-authority rule applies and
 *      costs nothing: an SLI is a monitoring quantity, and if the window cannot be read
 *      the guardrail is reported `NOT_OBSERVED`, which holds rather than proceeding. A
 *      missing window must never read as a passing one, and the direction of that failure
 *      is the reason this module returns absence rather than defaults.
 *
 * ── The declaration is read, never re-derived ──────────────────────────────
 * `declarationFor` returns exactly what was written at enable time, re-validated through
 * `guardrails.declare()` so that a corrupted or truncated payload is refused rather than
 * partially honoured. A controller that reconstructed a declaration from current
 * configuration would evaluate the shard against the guardrails someone wishes had been
 * declared.
 *
 * ── No clock ────────────────────────────────────────────────────────────────
 * Every instant is supplied.
 */

const guardrails = require("./guardrails");
const sli = require("../observability/sli");

/** Audit event types this module reads. Written by `stage.auditEventFor`. */
const EVENT = Object.freeze({
  ENABLED: "CUTOVER_SHARD_ENABLED",
  ROLLED_BACK: "CUTOVER_SHARD_ROLLED_BACK",
});

/**
 * The most recent cutover audit event for a shard, of either kind.
 *
 * Both kinds, not just the enable: a shard that was enabled and then rolled back is not
 * live, and reading only enables would resurrect a stale declaration for it.
 *
 * @param {object} deps `{ prisma }`
 * @param {string} shardId
 * @returns {Promise<object|null>}
 */
async function latestCutoverEvent(deps, shardId) {
  return deps.prisma.auditEvent.findFirst({
    where: { subjectType: "SHARD", subjectId: String(shardId), eventType: { in: [EVENT.ENABLED, EVENT.ROLLED_BACK] } },
    orderBy: { sequence: "desc" },
  });
}

/**
 * The pre-declared guardrails governing a shard that is currently live.
 *
 * Returns null when the shard has no enable event, when its latest event is a rollback
 * (it is not live, so there is nothing to assess), or when the recorded declaration does
 * not re-validate.
 *
 * @param {object} deps `{ prisma }`
 * @param {string} shardId
 * @returns {Promise<object|null>}
 */
async function declarationFor(deps, shardId) {
  const event = await latestCutoverEvent(deps, shardId);
  if (!event || event.eventType !== EVENT.ENABLED) return null;

  const recorded = event.payload && event.payload.guardrails;
  if (!recorded) return null;

  try {
    return guardrails.declare(recorded);
  } catch {
    // A declaration that no longer validates is not silently repaired. The controller
    // reports the shard as live-without-guardrails, which is a finding, and which is the
    // honest reading of a record nobody can evaluate.
    return null;
  }
}

/**
 * Observe a shard's SLI window against a declaration.
 *
 * Each guardrail's `id` is an `sli.TARGETS` id; the statistic is taken from that target's
 * own row, so a guardrail on a p99.9 target is evaluated at p99.9 and cannot be quietly
 * downgraded to a p99 by whoever declared it (§20.1's category-error warning).
 *
 * A guardrail naming an id that is not a §20.1 target is reported as unobserved rather
 * than guessed at. The alternative — reading it as a raw counter — would let a typo
 * produce a permanently passing guardrail.
 *
 * @param {object} deps `{ kv }`
 * @param {string} shardId
 * @param {object} declaration
 * @param {{ windowStartedAtMs: number, windowEndedAtMs: number }} window
 * @returns {Promise<{ windowStartedAtMs: number, windowEndedAtMs: number, observations: object,
 *   instances: string[] }>}
 */
async function observationsFor(deps, shardId, declaration, window) {
  const { merged, instances } = await sli.collect(deps, shardId);
  const observations = {};

  for (const guardrail of declaration.guardrails) {
    const target = sli.TARGET_BY_ID[guardrail.id];
    if (!target) continue;
    const measured = sli.statisticOf(merged, guardrail.id, target.statistic);
    if (measured.value === null) continue;
    observations[guardrail.id] = { value: measured.value, samples: measured.count, bound: measured.bound };
  }

  return {
    windowStartedAtMs: window.windowStartedAtMs,
    windowEndedAtMs: window.windowEndedAtMs,
    observations,
    instances,
  };
}

/**
 * Shards whose configuration binding currently makes them live.
 *
 * Read from the shard table and filtered through the published snapshot, so the answer is
 * the same one `cutover/enabled.js` gives every other caller. A controller with its own
 * notion of "live" would assess a set that differs from the set that is running.
 *
 * @param {object} deps `{ prisma }`
 * @param {{ snapshot: object|null, env?: object }} context
 * @returns {Promise<object[]>}
 */
async function liveShards(deps, context) {
  const enabled = require("./enabled");
  const rows = await deps.prisma.shard.findMany({
    select: { shardId: true, regionId: true, state: true, agentCount: true },
  });
  return rows.filter((shard) =>
    enabled.forShard({ snapshot: context.snapshot || null, shard, env: context.env }),
  );
}

module.exports = { EVENT, latestCutoverEvent, declarationFor, observationsFor, liveShards };

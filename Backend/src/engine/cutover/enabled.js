"use strict";

/**
 * Is the engine the decision path? — **Tier 0 by consequence**.
 *
 * ── What Phase 15 changed about this question ───────────────────────────────
 * Before this phase, `process.env.ENGINE_ENABLED === "true"` was scattered across
 * fourteen call sites, and its meaning was "is the engine allowed to act". After this
 * phase the question has a second half, because the execution plan's Phase 15 row
 * states the cutover as a *per-shard* one:
 *
 * > **Configuration updates** — `ENGINE_ENABLED=true` **per shard**, staged
 *
 * and §1.2 of the plan states the rule the staging must obey:
 *
 * > **No partial cutover.** Because Tier 0 is indivisible (§1.8), the cutover switches
 * > the whole decision path at once, **per shard**, with rollback. There is no state in
 * > which half the commitment core is live.
 *
 * A process-scoped environment variable cannot express "shard A is live and shard B is
 * not", and a deployment that split the fleet by *process* would put two coordinators
 * for the same region in disagreement about which path owns it. So the switch is now
 * two things that are ANDed, and both are named here so that no caller re-derives the
 * conjunction:
 *
 *   1. **`ENGINE_ENABLED` (process, environment).** Does this process participate in
 *      the engine at all — may it stand for election, drain an outbox, run a round?
 *      This is a deployment fact, it is what `server.js` reads to decide whether to
 *      start a worker, and it is unchanged from Phase 0.
 *   2. **`cutover.engine_enabled` (shard, configuration).** Is the engine the decision
 *      path *for this shard*? This is the staged one. It is resolved through the Config
 *      Service at `region` scope — §22.2's own alias for a shard, since one shard owns
 *      one operating region (§3.5) — so staging a shard is publishing a binding, which
 *      makes it versioned, audited, explainable, and revertible by the same machinery
 *      every other parameter change uses.
 *
 * ── The honest statement of what "off" now means ────────────────────────────
 * Phase 15's completion criterion is "legacy decision path **removed from the build**,
 * not merely bypassed", and this phase carries it out: `taskAssignment.service.js`,
 * `costEvaluator.service.js`, `robotValidator.service.js` and `taskRecovery.service.js`
 * are deleted, and `task.service.js` no longer contains a selection path.
 *
 * The consequence must not be discovered during an incident: **after this build,
 * `cutover.engine_enabled = false` for a shard does not mean "the legacy dispatcher
 * serves that shard". It means that shard has no decision path** — intake still
 * accepts and durably queues work, and nothing assigns it until the engine is enabled
 * again or the previous artefact is redeployed. That is a deliberate, plan-mandated
 * property, not an oversight, and `docs/runbooks/rollback.md` is written around it.
 * `describe()` below returns it in words for exactly this reason: an operator reading a
 * health endpoint at 3 a.m. gets the consequence, not just the boolean.
 *
 * ── No clock, no environment read below `processEnabled()` ──────────────────
 * Every other function takes its inputs. `forShard` is a pure function of (snapshot,
 * shard, process flag), which is what lets the staging tests assert the conjunction
 * without mutating `process.env` around every case.
 */

/** The register entry the per-shard half of the switch resolves. */
const PARAMETER = "cutover.engine_enabled";

/**
 * What it means for a shard to be disabled, in words, once and for all.
 *
 * Hoisted to a named constant rather than built inside `describe()` because
 * `cutover/stage.js` states it on every rollback, and a rollback is issued from wherever
 * the operator happens to be — a machine whose own `ENGINE_ENABLED` says nothing about
 * the shard being rolled back. Deriving the sentence from ambient process state there
 * produced the *process* consequence for a *shard* action, which is the wrong sentence at
 * the worst moment.
 */
const SHARD_HAS_NO_DECISION_PATH =
  "this shard has NO decision path: intake still validates, admits and durably queues work, and " +
  "nothing drains that queue. The legacy dispatcher was removed from the build at Phase 15, so " +
  "this state is a stop, not a fallback — see docs/runbooks/rollback.md.";

/**
 * What it means to have asked the per-shard question without naming a shard's region.
 *
 * PHASE 15 remediation (P15-R5). Kept apart from `SHARD_HAS_NO_DECISION_PATH` because the
 * two are different incidents: one says *this shard is not staged yet*, and the other says
 * *the caller did not say which shard it meant, so no staging decision applies to it*. An
 * operator reading the first looks at the staging order; an operator reading the second
 * looks at the caller.
 */
const REGION_UNRESOLVED =
  "no operating region was named, so the per-shard cutover question has no subject and is refused. " +
  "`cutover.engine_enabled` resolves at region scope (§22.2's alias for a shard, §3.5); answering a " +
  "caller that named no region from a *global* binding would substitute 'is the whole deployment cut " +
  "over' for 'is this shard cut over', which is the substitution per-shard staging exists to prevent.";

/** How a shard's decision path is described, for logs, health, and the audit. */
const DECISION_PATH = Object.freeze({
  /** The engine owns this shard: rounds run, commitments are written, commands are emitted. */
  ENGINE: "ENGINE",
  /** No decision path. Intake still queues durably; nothing drains the queue. */
  NONE: "NONE",
});

/**
 * The process half of the switch: the deployment's `ENGINE_ENABLED`.
 *
 * @param {object} [env] defaults to `process.env`
 * @returns {boolean}
 */
function processEnabled(env) {
  const source = env || process.env;
  return String(source.ENGINE_ENABLED || "").toLowerCase() === "true";
}

/**
 * Resolve the per-shard half from a published configuration snapshot.
 *
 * Resolution is by `region`, not by a `shard` level: §22.2's hierarchy has no shard
 * level, and `config/resolver.js` records the mapping (`shard` → `region`) as one of its
 * two standing conventions. Adding a level here would be an architecture change.
 *
 * A snapshot that cannot resolve the entry at all — an unseeded register, a caller that
 * passed something that is not a snapshot — yields `false`. Failing closed is the only
 * defensible direction: the failure mode of a wrong `true` is a shard running the engine
 * nobody authorised, and the failure mode of a wrong `false` is a shard that assigns
 * nothing and says so loudly.
 *
 * ── A caller that names no region gets `false`, not the global binding ──────
 * PHASE 15 remediation (P15-R5). This function used to build its context as
 * `if (regionId) context.region = regionId`, so a caller with no region resolved
 * `cutover.engine_enabled` at **global** scope — and the register admits a global binding
 * (`scopes: ["global", "region"]`). A deployment holding a global `true` therefore
 * answered *"is the whole deployment cut over"* to a caller that asked *"is **this shard**
 * cut over"*, which is precisely the substitution the per-shard staging exists to prevent.
 *
 * It was reachable and it was permissive. `services/task.service.js` takes the region from
 * the **request body**, so the way for a caller to be admitted onto a shard the staging
 * order had not reached was to omit `regionId` — and that module's own docstring claimed
 * the opposite: *"a caller that passes neither gets `false`, which is the right answer for
 * a caller that cannot say which shard it means."*
 *
 * This is the same defect `agentGate.SHARD_REGION_UNRESOLVED` closes for an agent session
 * (D-13), one module along, and it is closed here rather than at each caller for the reason
 * D-13 gives: a missing region does not make the answer `false`, it makes the question a
 * different one — so the *question* is refused, at the single place that owns it.
 *
 * A global binding is still readable by anything that legitimately asks a deployment-wide
 * question; `processEnabled()` is that question, and it is a different function.
 *
 * @param {object|null} snapshot a Config Service snapshot
 * @param {{ regionId?: string|null, shardId?: string|null }} shard
 * @returns {boolean}
 */
function configEnabled(snapshot, shard) {
  if (!snapshot || typeof snapshot.resolve !== "function") return false;
  const regionId = shard && shard.regionId ? String(shard.regionId).trim() : "";
  if (regionId === "") return false;
  try {
    return snapshot.resolve(PARAMETER, { region: regionId }) === true;
  } catch {
    return false;
  }
}

/**
 * The conjunction — the single answer every caller should ask for.
 *
 * @param {{ snapshot?: object|null, shard?: object|null, env?: object }} input
 * @returns {boolean}
 */
function forShard(input) {
  const settings = input || {};
  return processEnabled(settings.env) && configEnabled(settings.snapshot || null, settings.shard || {});
}

/**
 * The same answer, with the operational consequence spelled out.
 *
 * Returned by `GET /api/health` and written into the audit on every stage and every
 * rollback, so that "which path is serving this shard" is never inferred from the
 * absence of a log line.
 *
 * @param {{ snapshot?: object|null, shard?: object|null, env?: object }} input
 * @returns {{ shardId: string|null, regionId: string|null, processEnabled: boolean,
 *   configEnabled: boolean, live: boolean, decisionPath: string, consequence: string }}
 */
function describe(input) {
  const settings = input || {};
  const shard = settings.shard || {};
  const processHalf = processEnabled(settings.env);
  const configHalf = configEnabled(settings.snapshot || null, shard);
  const live = processHalf && configHalf;

  let consequence;
  if (live) {
    consequence =
      "the engine is the decision path for this shard: rounds run, commitments are written under " +
      "the two fencing scopes, and commands are emitted through the outbox.";
  } else if (!processHalf) {
    consequence =
      "this process does not participate in the engine (ENGINE_ENABLED is not true), so it starts " +
      "no coordinator, drains no outbox, and runs no round. It still serves the request path. " +
      "The legacy dispatcher was removed from the build at Phase 15 and is not a fallback.";
  } else if (!shard.regionId) {
    // PHASE 15 remediation (P15-R5) — named separately from "not staged", because the
    // caller is the thing to look at rather than the staging order.
    consequence = REGION_UNRESOLVED;
  } else {
    consequence = SHARD_HAS_NO_DECISION_PATH;
  }

  return {
    shardId: shard.shardId || null,
    regionId: shard.regionId || null,
    processEnabled: processHalf,
    configEnabled: configHalf,
    live,
    decisionPath: live ? DECISION_PATH.ENGINE : DECISION_PATH.NONE,
    consequence,
  };
}

module.exports = {
  PARAMETER,
  SHARD_HAS_NO_DECISION_PATH,
  REGION_UNRESOLVED,
  DECISION_PATH,
  processEnabled,
  configEnabled,
  forShard,
  describe,
};

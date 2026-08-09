"use strict";

/**
 * Shadow mode (§21.6) — **Tier 1**.
 *
 * > **Shadow mode.** A candidate configuration, model, or algorithm runs on live inputs
 * > in parallel with production, producing decisions that are **recorded and never
 * > executed**. Differences are analysed offline. This is the only safe way to change a
 * > cost coefficient in a system whose decisions have physical consequences, and it
 * > **MUST exist before the first tuning change is contemplated**.
 *
 * That last clause is why this module lands at Phase 11 rather than beside the first
 * tuning change: Phase 16 enables every Tier 2 mechanism "one at a time, each behind its
 * own switch, **each validated in shadow mode before it is trusted**" (§1.8 rule 3). A
 * shadow facility built at the same time as the change it is meant to validate would be
 * a facility built by the person who wants the change to pass.
 *
 * ── "Never executed" is structural here, not a convention ───────────────────
 * The single most important property of a shadow run is that it cannot move a robot.
 * Three mechanisms enforce it, and none of them is "the caller remembers":
 *
 *   1. **`run()` calls `round.plan()`, never `round.execute()`.** §3.1 makes `plan()`
 *      entirely L4 — "deterministic, side-effect-free, replayable" — and `execute()` is
 *      the only function in that module that crosses into L3. The shadow path simply
 *      does not contain the crossing.
 *   2. **`assertNoEffects()` refuses a dependency bundle that could cause one.** Passing
 *      `commit`, `dispatch`, `outbox` or a `prisma` write client to a shadow run throws
 *      before any planning happens. A shadow run handed a commit function would be a
 *      production run with a different label.
 *   3. **Its records are marked in two independent places** — the `shadow:` decision-id
 *      prefix and `DecisionRecordA.shadowLabel` — so a shadow decision can never be
 *      mistaken for a production one by a query that forgets one of them, and no
 *      `Commitment.decisionRef` can ever resolve to one, because no commitment exists.
 *
 * ── What "live inputs" means, exactly ──────────────────────────────────────
 * The candidate runs against the **production round's pinned snapshot** (§9.6
 * requirement 5), not against a fresh read. Anything else would make a difference
 * between the two runs attributable to input drift rather than to the candidate, which
 * is precisely the comparison the mode exists to make. `compare()` refuses a pair whose
 * snapshot hashes differ, rather than reporting an agreement rate computed over two
 * different worlds.
 */

const { canonicalJson, compareStrings } = require("../determinism/ordering");
const { compare: compareMilliCU, subtract } = require("../determinism/fixedPoint");

/**
 * Dependency names a shadow run may never be given. Each is a way to reach the world.
 * @structural the refusal list; naming an effect is not a threshold
 */
const FORBIDDEN_DEPENDENCIES = Object.freeze([
  "commit",
  "dispatch",
  "outbox",
  "record",
  "planState",
  "emit",
  "publish",
]);

/**
 * Thrown when a shadow run is handed something that could reach the world.
 */
class ShadowSideEffectError extends Error {
  constructor(message) {
    super(message);
    this.name = "ShadowSideEffectError";
  }
}

/**
 * Refuse a dependency bundle that could cause an effect.
 *
 * @param {object} deps
 * @returns {{ ok: true }}
 * @throws {ShadowSideEffectError}
 */
function assertNoEffects(deps) {
  const present = FORBIDDEN_DEPENDENCIES.filter((name) => deps && deps[name] !== undefined && deps[name] !== null);
  if (present.length > 0) {
    throw new ShadowSideEffectError(
      `a shadow run was given ${present.join(", ")}. §21.6: shadow decisions are "recorded and never executed". ` +
        "A run holding a commit, a dispatch, or the coordinator's plan state is a production run with a " +
        "different label, and the whole point of the mode is that it cannot become one by accident.",
    );
  }
  return { ok: true };
}

/**
 * Run one candidate against a production round's pinned inputs.
 *
 * @param {object} deps
 * @param {(input: object) => Promise<object>} deps.expandCandidates the round's own
 *   expansion, bound to the **pinned** snapshot
 * @param {(agentId: string, legId: string, candidate: object) => object} deps.pricedCandidateFor
 *   the candidate pricer, bound to the **candidate** configuration under test
 * @param {object} deps.round the `solve/round.js` module, injected so this module holds
 *   no static dependency on the decision path it is observing
 * @param {object} input
 * @param {object} input.production the production round's frozen result
 * @param {object} input.snapshot the production round's pinned snapshot
 * @param {object} input.candidateConfig the configuration under test
 * @param {object} input.killSwitches the switch states under test
 * @param {string} input.label the candidate's name, recorded with every shadow decision
 * @param {object} input.budgets a `solve/budgets.js` tracker for the shadow run
 * @returns {Promise<object>}
 */
async function run(deps, input) {
  assertNoEffects(deps);

  const source = input || {};
  const production = source.production || {};

  const shadowResult = await deps.round.plan(
    {
      expandCandidates: deps.expandCandidates,
      pricedCandidateFor: deps.pricedCandidateFor,
      // No plan state: a SOFT reservation is round-local coordinator memory (§2.6) and a
      // shadow run has no standing to hold one. `round.plan()` tolerates its absence and
      // records `reserved: true` with a null reservation, which is the honest shape for
      // a run that reserves nothing.
      planState: null,
      budgets: source.budgets,
      deferPriceFor: deps.deferPriceFor,
    },
    {
      roundId: production.roundId,
      shardId: production.shardId,
      // The production round's own decision time, not a fresh clock read. A shadow run
      // at a different instant is not a comparison of two candidates; it is a comparison
      // of two moments.
      decisionTimeMs: production.decisionTimeMs,
      legs: source.legs || [],
      config: source.candidateConfig || {},
      killSwitches: source.killSwitches || {},
      snapshot: source.snapshot,
    },
  );

  return Object.freeze({
    label: source.label,
    executed: false,
    roundId: production.roundId,
    shardId: production.shardId,
    decisionTimeMs: production.decisionTimeMs,
    snapshotHash: source.snapshot ? (source.snapshot.hash ?? null) : null,
    result: shadowResult,
  });
}

/**
 * The agreement report §21.6 says the differences are analysed from.
 *
 * @param {object} input
 * @param {object} input.production the production round result
 * @param {object} input.shadow a `run()` result
 * @param {string} [input.productionSnapshotHash]
 * @returns {object}
 */
function compare(input) {
  const source = input || {};
  const production = source.production || {};
  const shadow = source.shadow || {};
  const shadowResult = shadow.result || {};

  const productionHash = source.productionSnapshotHash ?? null;
  if (productionHash !== null && shadow.snapshotHash !== null && productionHash !== shadow.snapshotHash) {
    return Object.freeze({
      ok: false,
      reason:
        "the two runs used different pinned snapshots, so any difference between them is attributable to input " +
        "drift rather than to the candidate. §21.6's comparison is only meaningful over identical live inputs " +
        "(§9.6 requirement 5).",
      productionSnapshotHash: productionHash,
      shadowSnapshotHash: shadow.snapshotHash,
    });
  }

  const productionByLeg = new Map((production.decisions || []).map((row) => [String(row.legId), row]));
  const shadowByLeg = new Map((shadowResult.decisions || []).map((row) => [String(row.legId), row]));

  const legIds = [...new Set([...productionByLeg.keys(), ...shadowByLeg.keys()])].sort(compareStrings);

  const differences = [];
  let agreed = 0;

  for (const legId of legIds) {
    const left = productionByLeg.get(legId) || null;
    const right = shadowByLeg.get(legId) || null;
    const sameOutcome = left && right && left.outcome === right.outcome;
    const sameAgent = left && right && (left.agentId ?? null) === (right.agentId ?? null);

    if (sameOutcome && sameAgent) {
      agreed += 1;
      continue;
    }

    differences.push({
      legId,
      production: left ? { outcome: left.outcome, agentId: left.agentId ?? null } : null,
      shadow: right ? { outcome: right.outcome, agentId: right.agentId ?? null } : null,
      // Which half changed. An outcome flip and an agent swap are different findings:
      // the first says the candidate changed *whether* work is done, the second only
      // *by whom*, and conflating them would hide the more serious of the two.
      kind: !sameOutcome ? "OUTCOME" : "AGENT",
    });
  }

  const objectiveDelta =
    typeof production.budgets?.incumbent?.objectiveMilliCU === "bigint" &&
    typeof shadowResult.budgets?.incumbent?.objectiveMilliCU === "bigint"
      ? subtract(shadowResult.budgets.incumbent.objectiveMilliCU, production.budgets.incumbent.objectiveMilliCU)
      : null;

  return Object.freeze({
    ok: true,
    label: shadow.label ?? null,
    roundId: production.roundId ?? null,
    legs: legIds.length,
    agreed,
    agreementRate: legIds.length === 0 ? null : agreed / legIds.length,
    differences,
    // Negative means the candidate priced the same work more cheaply. Reported in
    // integer milli-CU, never as a percentage: §1.3's units apply to a comparison of
    // two allocations exactly as they apply to one.
    objectiveDeltaMilliCU: objectiveDelta === null ? null : objectiveDelta.toString(),
    objectiveDeltaFavoursCandidate: objectiveDelta === null ? null : compareMilliCU(objectiveDelta, 0n) < 0,
    regimeChanged: (production.regime ?? null) !== (shadowResult.regime ?? null),
    note:
      "shadow decisions are recorded and never executed (§21.6). An agreement rate is a description, not a " +
      "verdict: a candidate that agrees everywhere has changed nothing, and one that disagrees often may be " +
      "right. The evaluator (§21.6, tools/evaluator/counterfactual.js) is what scores which.",
  });
}

/**
 * A stable digest of an agreement report, so two runs of the same comparison are
 * recognisably the same report.
 *
 * @param {object} report
 * @returns {string}
 */
function digest(report) {
  return canonicalJson(report);
}

module.exports = {
  FORBIDDEN_DEPENDENCIES,
  ShadowSideEffectError,
  assertNoEffects,
  run,
  compare,
  digest,
};

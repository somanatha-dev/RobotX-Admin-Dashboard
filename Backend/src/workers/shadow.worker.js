"use strict";

/**
 * The shadow-mode runner (§21.6).
 *
 * > A candidate configuration, model, or algorithm runs on live inputs in parallel with
 * > production, **producing decisions that are recorded and never executed**.
 *
 * ── What this worker adds over `observability/shadow.js` ────────────────────
 * The module holds the run and the comparison, both pure. This worker holds the two
 * things that need a store and a clock: it reads the production round's **pinned**
 * `InputSnapshot` so the candidate is evaluated against the same world, and it writes
 * the shadow decisions with `shadowLabel` set so they are visible to an analyst and
 * invisible to every production read.
 *
 * ── Why it re-reads the snapshot rather than trusting the caller ────────────
 * A shadow comparison is only meaningful over identical inputs (§9.6 requirement 5), and
 * the cheapest way to get that wrong is to pass "the current state" to the candidate
 * while production ran against a snapshot taken moments earlier. Reading the stored
 * snapshot makes the identity structural: `shadow.compare()` then refuses any pair whose
 * snapshot hashes differ, so the mistake cannot produce a plausible-looking report.
 *
 * ── Never executed, three times over ───────────────────────────────────────
 * `shadow.assertNoEffects()` refuses a dependency bundle containing `commit`,
 * `dispatch`, `outbox`, `record`, or `planState`; the run calls `round.plan()`, which
 * §3.1 makes side-effect-free; and the records it writes are marked in the decision id
 * and in a column. None of the three is "the operator remembers".
 *
 * ── Built, tested, and not started ─────────────────────────────────────────
 * Nothing in `server.js` calls `start()`. Phase 15 owns production scheduling. §1.8 rule
 * 3 requires each Tier 2 mechanism to be "validated in shadow mode before it is trusted",
 * so this is the facility Phase 16 turns on before it turns anything else on.
 *
 * Tier 1 by path (`src/workers/`).
 */

const shadow = require("../engine/observability/shadow");
const decisionRecord = require("../engine/observability/decisionRecord");
const sampling = require("../engine/observability/sampling");

/**
 * How often the runner picks up recent rounds. Shadow mode is a comparison over stored
 * rounds, not a live parallel path, so it runs behind production rather than beside it —
 * which is also what keeps it off the round's critical path entirely.
 * @structural the runner's cadence; a batching choice, not a behavioural threshold
 */
const RUN_INTERVAL_MS = 60_000;

/**
 * How many rounds one pass replays under the candidate.
 * @structural the pass's batch size
 */
const BATCH = 25;

/**
 * Run one candidate over one stored round and record the comparison.
 *
 * @param {object} deps `{ prisma, round, expandCandidates, pricedCandidateFor, budgetsFor }`
 * @param {object} input `{ storedRound, label, candidateConfig, legs, nowMs, recordDecisions }`
 * @returns {Promise<object>}
 */
async function runOne(deps, input) {
  const source = input || {};
  const stored = source.storedRound || {};

  const snapshotRow = await deps.prisma.inputSnapshot.findFirst({ where: { roundId: stored.roundId } });
  if (!snapshotRow) {
    return {
      ok: false,
      roundId: stored.roundId,
      reason: "NO_SNAPSHOT",
      detail:
        "the production round's pinned inputs are gone, so a candidate run against current state would be a " +
        "comparison of two moments rather than of two candidates (§9.6 requirement 5).",
    };
  }

  const snapshot = {
    roundId: snapshotRow.roundId,
    decisionTime: snapshotRow.decisionTime instanceof Date ? snapshotRow.decisionTime.getTime() : snapshotRow.decisionTime,
    configVersion: snapshotRow.configVersion,
    codeVersion: snapshotRow.codeVersion,
    activeRegime: snapshotRow.activeRegime,
    killSwitchState: snapshotRow.killSwitchState,
    hash: snapshotRow.hash,
    seed: snapshotRow.seed,
    pins: snapshotRow.pins,
  };

  // Deliberately a *fresh* dependency bundle rather than the coordinator's: the shadow
  // run must not be able to reach anything the coordinator can.
  const result = await shadow.run(
    {
      round: deps.round,
      expandCandidates: deps.expandCandidates,
      pricedCandidateFor: deps.pricedCandidateFor,
      deferPriceFor: deps.deferPriceFor,
    },
    {
      production: source.production || { roundId: stored.roundId, shardId: stored.shardId, decisionTimeMs: snapshot.decisionTime },
      snapshot,
      candidateConfig: source.candidateConfig,
      killSwitches: snapshot.killSwitchState || {},
      label: source.label,
      legs: source.legs || [],
      budgets: typeof deps.budgetsFor === "function" ? deps.budgetsFor(stored) : undefined,
    },
  );

  const report = shadow.compare({
    production: source.production || {},
    shadow: result,
    productionSnapshotHash: snapshotRow.hash,
  });

  if (source.recordDecisions !== false && result.result) {
    // Recorded and never executed. `writeRound` is given the shadow label, which sets
    // both the `shadow:` decision-id prefix and the column every production read filters
    // on. No commit was performed and none can be: `shadow.run()` refused to accept one.
    await decisionRecord.writeRound(deps, {
      round: { ...result.result, committed: [], aborted: [] },
      context: {
        shardId: stored.shardId,
        snapshot,
        shadowLabel: source.label,
        perLeg: source.perLeg || {},
      },
      budget: source.budget || sampling.createBudget({ writeBudgetPerMinute: 0, reservoirSize: 0 }),
      config: source.config || {},
      nowMs: source.nowMs,
    });
  }

  return { ok: true, roundId: stored.roundId, label: source.label, report };
}

/**
 * One pass over the most recent rounds.
 *
 * @param {object} deps as `runOne`
 * @param {object} context `{ label, candidateConfig, shardId, batch, legsFor, productionFor }`
 * @returns {Promise<object>}
 */
async function runOnce(deps, context) {
  const settings = context || {};
  const nowMs = typeof deps.now === "function" ? deps.now() : Date.now();

  const rounds = await deps.prisma.round.findMany({
    where: settings.shardId ? { shardId: settings.shardId } : {},
    orderBy: { decisionTime: "desc" },
    take: Number.isFinite(settings.batch) ? settings.batch : BATCH,
  });

  const reports = [];
  for (const storedRound of rounds) {
    // eslint-disable-next-line no-await-in-loop
    reports.push(
      await runOne(deps, {
        storedRound,
        label: settings.label,
        candidateConfig: settings.candidateConfig,
        legs: typeof settings.legsFor === "function" ? await settings.legsFor(storedRound) : [],
        production: typeof settings.productionFor === "function" ? await settings.productionFor(storedRound) : null,
        perLeg: settings.perLeg,
        config: settings.recordConfig,
        budget: settings.budget,
        recordDecisions: settings.recordDecisions,
        nowMs,
      }),
    );
  }

  const compared = reports.filter((row) => row.ok && row.report && row.report.ok);
  const agreements = compared.map((row) => row.report.agreementRate).filter((rate) => rate !== null);

  return {
    label: settings.label,
    executed: false,
    rounds: rounds.length,
    compared: compared.length,
    meanAgreementRate: agreements.length === 0 ? null : agreements.reduce((sum, rate) => sum + rate, 0) / agreements.length,
    reports,
  };
}

/**
 * Start the runner.
 *
 * @param {object} deps as `runOnce`, plus `onError`
 * @param {object} [context]
 * @returns {{ stop: () => void }}
 */
function start(deps, context) {
  const intervalMs = (context && context.intervalMs) || RUN_INTERVAL_MS;

  const handle = setInterval(() => {
    runOnce(deps, context).catch((error) => {
      // A failed shadow pass costs a comparison and nothing else — by construction it
      // cannot have changed anything in the world.
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
  RUN_INTERVAL_MS,
  BATCH,
  runOne,
  runOnce,
  start,
};

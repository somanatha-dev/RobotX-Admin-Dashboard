"use strict";

/**
 * B1 measurement tooling — summarise a `roundTrace.js` trace. **Test-only.**
 *
 * For every coordinator round that executed after the latency flip it reports wall time, the
 * in-budget span (claim → end of the solve), Prisma operations, the DB critical path (the
 * union of operation intervals, so concurrent reads count once) in RTT-equivalents, KV calls
 * and their critical path, and per-stage spans. Categories are assigned from the call site.
 *
 * Usage:  node tools/verify/b1/analyseTrace.js <trace.jsonl> <effectiveRttMs> [--json out.json]
 * As a module: `analyse(lines, effectiveRttMs)`.
 */

const fs = require("fs");

const CATEGORIES = [
  ["claim", /claimBatch/],
  ["settle", /settleBatch/],
  ["prepare", /readPlanning|prepareRound|Object\.prepare\b|\bprepare\b/],
  ["commitTx", /\[tx\]/],
  ["commitReads", /commitFor|buildContext|coordinatorSolvePath\.js:\d+ (?:Object\.)?commit\b|freshAgentSnapshot/],
  ["record", /writeRound|recordRound|decisionRecord|tierA|surrogate/],
  ["agentLoads", /loadAgentSnapshot|agentFactsFor|agentFacts\.service|energyFor|planningSnapshotFor|agentSnapshotFrom/],
  ["perLeg", /loadLeg|expandCandidates/],
  ["charger", /chargerCandidatesFor|pinnedChargerProjection/],
  ["preBudget", /readQueueState|recoverOrphanedClaims|requeueReturnedLegs|runRound|readLeadership|readStoreTime/],
];

function categoryOf(op) {
  const site = op.site || "";
  for (const [name, pattern] of CATEGORIES) if (pattern.test(site)) return name;
  return "other";
}

function union(intervals) {
  const iv = [...intervals].sort((a, b) => a[0] - b[0]);
  let busy = 0;
  let cs = null;
  let ce = null;
  for (const [s, e] of iv) {
    if (ce === null || s > ce) {
      if (ce !== null) busy += ce - cs;
      cs = s;
      ce = e;
    } else ce = Math.max(ce, e);
  }
  if (ce !== null) busy += ce - cs;
  return busy;
}

const span = (rows) => (rows.length === 0 ? 0 : Math.max(...rows.map((o) => o.t0 + o.ms)) - Math.min(...rows.map((o) => o.t0)));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s[s.length >> 1];
};

/**
 * @param {object[]} lines parsed trace lines
 * @param {number} rtt effective RTT in ms (for RTT-equivalents); 0 → reported as null
 */
function analyse(lines, rtt) {
  const flip = lines.find((e) => e.k === "flip");
  const flipT = flip ? flip.t : 0;
  const byRound = new Map();
  for (const e of lines) {
    if (e.r === null || e.r === undefined) continue;
    if (!byRound.has(e.r)) byRound.set(e.r, []);
    byRound.get(e.r).push(e);
  }
  const rounds = [];
  for (const [r, ev] of byRound) {
    const exec = ev.find((e) => e.k === "exit" && e.stage === "round.execute");
    const start = ev.find((e) => e.k === "round");
    if (!exec || !start || start.t < flipT) continue;
    const ops = ev.filter((e) => e.k === "op");
    const kv = ev.filter((e) => e.k === "kv");
    const exits = ev.filter((e) => e.k === "exit");
    const t1 = Math.max(...ev.map((e) => (e.t0 ?? e.t) + (e.ms || 0)));
    const claimOps = ops.filter((o) => categoryOf(o) === "claim");
    const budgetStart = claimOps.length ? Math.min(...claimOps.map((o) => o.t0)) : null;
    const solves = exits.filter((e) => e.stage === "minCostFlow.solve");
    const solveEnd = solves.length ? Math.max(...solves.map((e) => e.t0 + e.ms)) : null;
    const byCat = {};
    for (const o of ops) {
      const c = categoryOf(o);
      (byCat[c] = byCat[c] || []).push(o);
    }
    const stageSpan = (stage) => exits.filter((e) => e.stage === stage).reduce((s, e) => s + e.ms, 0);
    const dbBusy = union(ops.map((o) => [o.t0, o.t0 + o.ms]));
    const inBudgetOps = budgetStart && solveEnd ? ops.filter((o) => o.t0 >= budgetStart && o.t0 <= solveEnd) : [];
    const inBudgetKv = budgetStart && solveEnd ? kv.filter((k) => k.t0 >= budgetStart && k.t0 <= solveEnd) : [];
    rounds.push({
      r,
      wallMs: t1 - start.t,
      inBudgetMs: budgetStart && solveEnd ? solveEnd - budgetStart : null,
      outcome: exec.outcome,
      budgetLimited: exec.outcome === "BUDGET_LIMITED",
      assignments: exec.assignments,
      committed: exits.filter((e) => e.stage === "commit.commit" && e.committed === true).length,
      // A commit that returned an abort carries its reason; one that threw (a transaction
      // timeout, a lost connection) returned nothing and is counted as THREW.
      commitAborts: exits
        .filter((e) => e.stage === "commit.commit" && (e.committed === false || e.ok === false))
        .map((e) => (e.ok === false ? "THREW" : e.reason)),
      commitMs: exits.filter((e) => e.stage === "commit.commit").map((e) => Math.round(e.ms)),
      feasibleCandidates: exits.filter((e) => e.stage === "expansion.expandCandidates").reduce((s, e) => s + (e.candidates || 0), 0),
      agentsEvaluated: exits.filter((e) => e.stage === "expansion.expandCandidates").reduce((s, e) => s + (e.agentsEvaluated || 0), 0),
      truncatedBy: exits.filter((e) => e.stage === "expansion.expandCandidates").map((e) => e.truncatedBy || null),
      ops: ops.length,
      dbCriticalMs: dbBusy,
      dbRttEq: rtt > 0 ? dbBusy / rtt : null,
      inBudgetOps: inBudgetOps.length,
      inBudgetDbRttEq: rtt > 0 ? union(inBudgetOps.map((o) => [o.t0, o.t0 + o.ms])) / rtt : null,
      kvCalls: kv.length,
      kvKeys: kv.reduce((s, k) => s + (k.keys || 1), 0),
      inBudgetKvCalls: inBudgetKv.length,
      kvCriticalMs: union(kv.map((k) => [k.t0, k.t0 + k.ms])),
      stages: {
        claimMs: span(byCat.claim || []),
        prepareMs: span(byCat.prepare || []),
        expansionMs: stageSpan("expansion.expandCandidates"),
        solveMs: stageSpan("minCostFlow.solve"),
        commitMs: stageSpan("commit.commit"),
        settleMs: span(byCat.settle || []),
        recordMs: stageSpan("decisionRecord.writeRound"),
      },
      opsByCategory: Object.fromEntries(
        Object.entries(byCat).map(([c, rows]) => [c, { ops: rows.length, criticalMs: Math.round(union(rows.map((o) => [o.t0, o.t0 + o.ms]))) }]),
      ),
    });
  }
  return {
    flip: flip ? { oneWay: flip.oneWay, kvDelay: flip.kvDelay } : null,
    rounds,
    summary: {
      roundsExecuted: rounds.length,
      budgetLimited: rounds.filter((x) => x.budgetLimited).length,
      budgetLimitedWithFeasible: rounds.filter((x) => x.budgetLimited && x.feasibleCandidates > 0).length,
      committed: rounds.reduce((s, x) => s + x.committed, 0),
      commitAborts: rounds.flatMap((x) => x.commitAborts),
      medianWallMs: median(rounds.map((x) => x.wallMs)),
      medianInBudgetMs: median(rounds.filter((x) => x.inBudgetMs !== null).map((x) => x.inBudgetMs)),
      medianOps: median(rounds.map((x) => x.ops)),
      medianDbRttEq: median(rounds.filter((x) => x.dbRttEq !== null).map((x) => x.dbRttEq)),
      medianInBudgetDbRttEq: median(rounds.filter((x) => x.inBudgetDbRttEq !== null).map((x) => x.inBudgetDbRttEq)),
      medianKvCalls: median(rounds.map((x) => x.kvCalls)),
      medianStages: Object.fromEntries(
        ["claimMs", "prepareMs", "expansionMs", "solveMs", "commitMs", "settleMs", "recordMs"].map((k) => [k, median(rounds.map((x) => x.stages[k]))]),
      ),
    },
  };
}

if (require.main === module) {
  const [file, rttArg] = process.argv.slice(2);
  const out = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;
  const lines = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const result = analyse(lines, Number(rttArg || 0));
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result.summary, null, 1));
  for (const x of result.rounds) {
    console.log(
      `r${x.r} ${x.outcome} wall ${x.wallMs.toFixed(0)} inBudget ${x.inBudgetMs === null ? "-" : x.inBudgetMs.toFixed(0)} ` +
        `ops ${x.ops} dbRTT ${x.dbRttEq === null ? "-" : x.dbRttEq.toFixed(1)} inBudgetRTT ${x.inBudgetDbRttEq === null ? "-" : x.inBudgetDbRttEq.toFixed(1)} ` +
        `kv ${x.kvCalls} committed ${x.committed} feasible ${x.feasibleCandidates} ${JSON.stringify(x.stages)}`,
    );
  }
}

module.exports = { analyse, categoryOf, union };

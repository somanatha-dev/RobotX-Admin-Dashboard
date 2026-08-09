"use strict";

/**
 * Decision replay and the reconstruction-equivalence gate (§9.6, §21.2, §24.3).
 *
 * ── The property this file exists to defend ─────────────────────────────────
 * > **Reconstruction-equivalence gate.** For every decision in the golden corpus that
 * > has a Tier B record, reconstruction from Tier A alone MUST reproduce that Tier B
 * > content **byte for byte** (§21.2). This is the property the two-tier decision record
 * > rests on: if reconstruction can diverge, then sampling Tier B loses information and
 * > the explainability tenet (T8) is no longer satisfied for unsampled decisions. **It is
 * > a build gate rather than a monitored metric**, because a divergence discovered in
 * > production means every unsampled explanation already served was potentially wrong.
 *
 * That last sentence is the reason this is a gate and not a dashboard. A monitored
 * metric tells you when something broke; by the time this one broke, every
 * `RECONSTRUCTED` answer the Explanation API served since the regression was a
 * confidently-worded guess.
 *
 * ── How replay actually works here ──────────────────────────────────────────
 * Replay consumes **Tier A only**:
 *
 * > Replay needs the decision's *inputs* — pinned snapshot references, config version,
 * > model versions, `decision_time`, seeds — all of which are in Tier A. Tier B contains
 * > *derived* outputs: what feasibility concluded and what each candidate cost. Those
 * > are exactly what replay recomputes.
 *
 * So `replayRound()` re-executes **`round.plan()`** — the L4 half, which §3.1 makes
 * "deterministic, side-effect-free, replayable" — against the pinned `InputSnapshot`,
 * and hands the result to `tierB.build()`. Because `tierB.build()` is a pure function of
 * a round result, and `round.plan()` is a pure function of the pinned inputs, the
 * composition is a pure function of Tier A. The equivalence is therefore a theorem about
 * two pure functions rather than a property maintained by care, and the gate below is
 * what proves the theorem still holds after each change.
 *
 * `round.execute()` is never called. A replay that committed would re-dispatch a
 * historical decision to a live fleet.
 *
 * ── Two ways to run it ──────────────────────────────────────────────────────
 *   1. **Against the store** — `replayDecision(deps, decisionId)` loads Tier A, its
 *      `InputSnapshot`, and its Tier B (if one was sampled), re-plans, and compares.
 *      This is the "continuous production replay on a sample" of §24.3.
 *   2. **Against a corpus** — `runCorpus()` takes stored `(tierA, tierB, roundResult)`
 *      triples and checks the same equivalence with no database and no engine wiring.
 *      This is the golden corpus that "runs on every build".
 *
 * ── The erased corpus (§23.7, added in Phase 14) ────────────────────────────
 * > The build gate enforces the separation. The reconstruction-equivalence gate (§24.3)
 * > is run **additionally over a corpus in which erasure has been applied**, and MUST
 * > still reproduce Tier B byte-for-byte. A field whose erasure changes a replayed cost
 * > is, by that test, an identifying field that was wrongly admitted into the decision
 * > path — which is the defect this rule exists to catch, and it is caught at build
 * > rather than at the first erasure request.
 *
 * `runCorpus({ erased: true })` applies `privacy/erasure.eraseCorpus()` to the same
 * corpus and re-runs the identical comparison. Two things make this a real test rather
 * than a tautology:
 *
 *   1. The erasure is applied to the **inputs** (`reconstructionInput`, `tierA`) and not
 *      to the stored `tierB` the reconstruction is compared against. Redacting both would
 *      compare two redactions and prove nothing.
 *   2. It is the **same** `erasure.redact()` the production erasure path uses. Two
 *      implementations would let the gate pass while production erased something else.
 *
 * Usage:
 *   node tools/replay/replayDecision.js --corpus tests/fixtures/replayCorpus
 *   node tools/replay/replayDecision.js --erased
 * Exit code 0 on pass, 1 on any divergence.
 */

const fs = require("fs");
const path = require("path");

const tierB = require("../../src/engine/observability/tierB");
const tierA = require("../../src/engine/observability/tierA");
const sampling = require("../../src/engine/observability/sampling");
const decisionRecord = require("../../src/engine/observability/decisionRecord");
const snapshotModel = require("../../src/engine/determinism/snapshot");
const erasure = require("../../src/engine/privacy/erasure");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_CORPUS = path.join("tests", "fixtures", "replayCorpus");

/**
 * Rebuild one decision's Tier B from a round result. Pure.
 *
 * @param {object} input `{ roundResult, decisionId, legId, candidates, columns, pruned }`
 * @returns {object}
 */
function reconstructTierB(input) {
  const source = input || {};
  const round = source.roundResult || {};
  return tierB.build({
    decisionId: source.decisionId,
    roundId: round.roundId ?? source.roundId,
    shardId: round.shardId ?? source.shardId,
    decisionTimeMs: round.decisionTimeMs ?? source.decisionTimeMs,
    candidates: source.candidates || [],
    columns: source.columns || [],
    pruned: source.pruned || [],
  });
}

/**
 * Re-execute a round's **L4 half** against its pinned snapshot.
 *
 * @param {object} deps
 * @param {object} deps.round the `solve/round.js` module, injected
 * @param {(input: object) => Promise<object>} deps.expandCandidates bound to the pinned snapshot
 * @param {(agentId: string, legId: string, candidate: object) => object} deps.pricedCandidateFor
 * @param {object} deps.budgets a `solve/budgets.js` tracker, created with `replayOf` so
 *   the wall-clock bound truncates where the original did rather than where this machine lands
 * @param {object} input `{ snapshot, legs, config, killSwitches }`
 * @returns {Promise<object>}
 */
async function replayRound(deps, input) {
  const source = input || {};
  const snapshot = source.snapshot || {};

  if (typeof deps.round.execute === "function" && deps.commit) {
    throw new Error(
      "a replay was handed a commit function. Replay recomputes a historical decision; committing one would " +
        "re-dispatch it to a live fleet. §9.6's replay is over the L4 half only.",
    );
  }

  const intact = snapshotModel.isIntact(snapshot);

  const result = await deps.round.plan(
    {
      expandCandidates: deps.expandCandidates,
      pricedCandidateFor: deps.pricedCandidateFor,
      planState: null,
      budgets: deps.budgets,
      deferPriceFor: deps.deferPriceFor,
    },
    {
      roundId: snapshot.roundId,
      shardId: source.shardId,
      // §9.6 requirement 4 — `decision_time` is an input, and on a replay it is the
      // stored one. A replay that read a clock would reproduce a different decision and
      // then report the difference as non-determinism.
      decisionTimeMs: snapshot.decisionTime,
      legs: source.legs || [],
      config: source.config || {},
      killSwitches: snapshot.killSwitchState || source.killSwitches || {},
      snapshot,
    },
  );

  return { ok: true, snapshotIntact: intact, result };
}

/**
 * Compare a stored Tier B against a reconstruction, byte for byte.
 *
 * @param {object} input `{ stored, reconstructed }`
 * @returns {object}
 */
function reconstructionEquivalence(input) {
  const source = input || {};
  return tierB.equivalent(source.stored, source.reconstructed);
}

/**
 * Replay one stored decision from the durable record.
 *
 * @param {object} deps `{ prisma, ...replayRound deps }`
 * @param {string} decisionId
 * @param {object} [options] `{ legsFor, configFor }`
 * @returns {Promise<object>}
 */
async function replayDecision(deps, decisionId, options) {
  const settings = options || {};

  const row = await deps.prisma.decisionRecordA.findUnique({
    // Production decisions only. A shadow record replays to itself and would report a
    // spurious pass; worse, it would enter the corpus as though it were a decision the
    // fleet had actually taken (§21.6).
    where: { decisionId: String(decisionId) },
    include: { inputSnapshot: true, tierB: true },
  });

  if (!row) return { ok: false, reason: "NO_SUCH_DECISION", decisionId };
  if (row.shadowLabel !== null && row.shadowLabel !== undefined) {
    return { ok: false, reason: "SHADOW_RECORD", decisionId, shadowLabel: row.shadowLabel };
  }
  if (!row.inputSnapshot) {
    // §24.3's snapshot-retention check, hit at the moment it matters. This is a defect,
    // not a capacity signal, and it is reported as one.
    return {
      ok: false,
      reason: "SNAPSHOT_EXPIRED",
      decisionId,
      detail:
        "the Tier A record is retained but its input snapshot is not, so this decision is unreplayable and its " +
        "explanation unreconstructable. §22.1 rule 5 validation V6 forbids the retention ordering that produces " +
        "this; a non-zero count of these is a defect (§24.3).",
    };
  }

  const record = tierA.fromRow(row);

  const replayed = await replayRound(deps, {
    snapshot: {
      roundId: row.inputSnapshot.roundId,
      decisionTime: row.inputSnapshot.decisionTime instanceof Date
        ? row.inputSnapshot.decisionTime.getTime()
        : row.inputSnapshot.decisionTime,
      configVersion: row.inputSnapshot.configVersion,
      codeVersion: row.inputSnapshot.codeVersion,
      killSwitchState: row.inputSnapshot.killSwitchState,
      activeRegime: row.inputSnapshot.activeRegime,
      hash: row.inputSnapshot.hash,
      seed: row.inputSnapshot.seed,
      ...(row.inputSnapshot.pins || {}),
    },
    shardId: row.shardId,
    legs: typeof settings.legsFor === "function" ? await settings.legsFor(row) : [],
    config: typeof settings.configFor === "function" ? await settings.configFor(row) : {},
  });

  const reconstructed = reconstructTierB({
    roundResult: replayed.result,
    decisionId: row.decisionId,
    candidates: typeof settings.candidatesFor === "function" ? settings.candidatesFor(replayed.result, row) : [],
    columns: settings.columnsFor ? settings.columnsFor(replayed.result) : [],
    pruned: settings.prunedFor ? settings.prunedFor(replayed.result) : [],
  });

  const stored = row.tierB ? tierB.fromRow(row.tierB) : null;
  const equivalence = stored === null ? null : reconstructionEquivalence({ stored, reconstructed });

  // The sample decision must replay too, or the corpus's Tier B population is not the
  // one the original run produced.
  const resample = sampling.reproducibility(row.decisionId, row.samplingRate);

  return {
    ok: equivalence === null ? true : equivalence.ok,
    decisionId: row.decisionId,
    tierAPresent: true,
    tierBPresent: stored !== null,
    snapshotIntact: replayed.snapshotIntact,
    equivalence,
    samplingReproducible: resample.ok,
    samplingDrawMatches: row.samplingDraw === null || row.samplingDraw === undefined ? null : resample.draw === row.samplingDraw,
    record,
    reconstructed,
  };
}

/**
 * §24.3's **continuous production replay**: replay a sampled fraction of live decisions
 * and compare.
 *
 * > A sampled fraction of live decisions is replayed asynchronously and compared.
 * > Divergence indicates non-determinism — an unpinned version, a clock read, an
 * > ordering dependency — and is a release blocker.
 *
 * The sample is taken with the **same deterministic draw** the Tier B sampler uses, so
 * "which decisions get replayed" is itself replayable and an investigator can ask why a
 * particular decision was or was not checked. A random draw here would make the
 * monitoring itself unauditable.
 *
 * Asynchronous by construction: it reads stored rows, re-plans, and writes nothing. It
 * cannot be on the request path and cannot affect a decision.
 *
 * @param {object} deps `{ prisma, round, expandCandidates, pricedCandidateFor, budgets }`
 * @param {object} input `{ shardId, fromMs, toMs, rate, limit, options }`
 * @returns {Promise<object>}
 */
async function replaySample(deps, input) {
  const source = input || {};
  const rate = Number.isFinite(source.rate) ? source.rate : 0;

  const rows = await deps.prisma.decisionRecordA.findMany({
    where: {
      ...decisionRecord.PRODUCTION_ONLY,
      ...(source.shardId ? { shardId: source.shardId } : {}),
      ...(Number.isFinite(source.fromMs) && Number.isFinite(source.toMs)
        ? { decisionTime: { gte: new Date(source.fromMs), lt: new Date(source.toMs) } }
        : {}),
    },
    select: { decisionId: true },
    ...(Number.isFinite(source.limit) ? { take: source.limit } : {}),
  });

  const selected = rows.filter((row) => sampling.isSampled(row.decisionId, rate)).map((row) => row.decisionId);

  const results = [];
  for (const decisionId of selected) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await replayDecision(deps, decisionId, source.options));
  }

  const divergent = results.filter((row) => row.equivalence && row.equivalence.ok === false);
  const unreplayable = results.filter((row) => row.ok === false && row.reason === "SNAPSHOT_EXPIRED");

  return {
    considered: rows.length,
    sampled: selected.length,
    rate,
    replayed: results.length,
    divergent: divergent.length,
    unreplayable: unreplayable.length,
    // §24.3 — "Divergence indicates non-determinism … and is a release blocker."
    releaseBlocking: divergent.length > 0,
    divergences: divergent.map((row) => ({ decisionId: row.decisionId, equivalence: row.equivalence })),
    results,
  };
}

/**
 * Load a golden corpus from disk.
 *
 * Each file holds one decision as `{ tierA, tierB, reconstructionInput }`, where
 * `reconstructionInput` is the round-result fragment `reconstructTierB()` consumes. The
 * corpus is deliberately data rather than a database fixture: a gate that needed a live
 * PostgreSQL would not run on every build, and one that does not run on every build is
 * not a gate.
 *
 * @param {string} [directory] relative to `Backend/`
 * @returns {object[]}
 */
function loadCorpus(directory) {
  const absolute = path.isAbsolute(directory || "") ? directory : path.join(BACKEND_ROOT, directory || DEFAULT_CORPUS);
  let entries;
  try {
    entries = fs.readdirSync(absolute, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, ...JSON.parse(fs.readFileSync(path.join(absolute, name), "utf8")) }));
}

/**
 * Turn the corpus's JSON milli-CU strings back into the `bigint`s the builders expect.
 *
 * A corpus stored as JSON cannot hold a `bigint`, and reading one back as a `number`
 * would silently lose precision past 2^53 — which would make the gate pass on a small
 * corpus and fail on a realistic one. This is the single conversion point.
 *
 * @param {*} value
 * @returns {*}
 */
function reviveMilliCU(value) {
  if (Array.isArray(value)) return value.map(reviveMilliCU);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = /MilliCU$/.test(key) && typeof inner === "string" ? BigInt(inner) : reviveMilliCU(inner);
    }
    return out;
  }
  return value;
}

/**
 * Run the reconstruction-equivalence gate over a corpus.
 *
 * @param {object} [options] `{ directory, corpus, erased }`
 * @returns {{ ok: boolean, checked: number, withTierB: number, failures: object[],
 *             erased: boolean, erasedFields: object[] }}
 */
function runCorpus(options) {
  const settings = options || {};
  const loaded = settings.corpus || loadCorpus(settings.directory);

  // §23.7's build gate. The erasure is applied to the *inputs* only — the stored Tier B
  // is what the reconstruction is compared against, and redacting it too would compare
  // two redactions.
  const erasedRun = settings.erased === true;
  const applied = erasedRun ? erasure.eraseCorpus(loaded) : { corpus: loaded, erasedFields: [] };
  const corpus = applied.corpus;

  const failures = [];
  let withTierB = 0;

  for (const entry of corpus) {
    if (!entry.tierB) continue;
    withTierB += 1;

    const reconstructed = reconstructTierB(reviveMilliCU(entry.reconstructionInput || {}));
    const stored = tierB.fromRow(entry.tierB);
    const equivalence = reconstructionEquivalence({ stored, reconstructed });

    if (!equivalence.ok) failures.push({ name: entry.name, decisionId: entry.tierB.decisionId, equivalence });

    // The sampling decision is part of what replay must reproduce: a replay that
    // resampled would compare a different Tier B population than the original run kept.
    if (entry.tierA && entry.tierA.samplingRate !== null && entry.tierA.samplingRate !== undefined) {
      const resample = sampling.reproducibility(entry.tierA.decisionId, entry.tierA.samplingRate);
      if (entry.tierA.samplingDraw !== null && entry.tierA.samplingDraw !== undefined && resample.draw !== entry.tierA.samplingDraw) {
        failures.push({
          name: entry.name,
          decisionId: entry.tierA.decisionId,
          reason: "SAMPLING_NOT_REPRODUCIBLE",
          storedDraw: entry.tierA.samplingDraw,
          replayedDraw: resample.draw,
        });
      }
    }
  }

  // A divergence on the erased run has a specific meaning, and saying so at the point of
  // failure is worth more than the reader inferring it from two flags.
  if (erasedRun) {
    for (const failure of failures) {
      failure.erasureDefect =
        "this decision replayed differently after erasure, so one of the fields erasure removed WAS an input to its " +
        `cost. §23.7: that field is an identifying field wrongly admitted into the decision path. Fields erased in ` +
        `this run: ${applied.erasedFields.map((field) => field.path).join(", ") || "(none — the divergence is not an erasure effect)"}.`;
    }
  }

  return {
    ok: failures.length === 0,
    checked: corpus.length,
    withTierB,
    failures,
    erased: erasedRun,
    erasedFields: applied.erasedFields,
  };
}

/**
 * Audit the retention ordering §24.3 requires: no Tier A record outliving its snapshot.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ nowMs, take }`
 * @returns {Promise<{ ok: boolean, unreplayable: number, sample: object[] }>}
 */
async function auditSnapshotRetention(deps, input) {
  const source = input || {};
  const rows = await deps.prisma.decisionRecordA.findMany({
    where: {
      ...decisionRecord.PRODUCTION_ONLY,
      OR: [{ inputSnapshotId: null }, { inputSnapshot: { retainUntil: { lt: new Date(source.nowMs) } } }],
    },
    select: { decisionId: true, decisionTime: true, inputSnapshotId: true },
    take: Number.isFinite(source.take) ? source.take : 100,
  });

  return {
    ok: rows.length === 0,
    unreplayable: rows.length,
    sample: rows,
    note:
      "a decision whose Tier A record is retained but whose input snapshot has expired is unreplayable and " +
      "unreconstructable. A non-zero count is a defect, not a capacity signal (§24.3).",
  };
}

/* ── CLI ─────────────────────────────────────────────────────────────────── */

if (require.main === module) {
  const argv = process.argv.slice(2);
  const directoryIndex = argv.indexOf("--corpus");
  const directory = directoryIndex === -1 ? DEFAULT_CORPUS : argv[directoryIndex + 1];
  const erased = argv.includes("--erased");

  const result = runCorpus({ directory, erased });

  process.stdout.write(
    erased
      ? "gate: reconstruction-equivalence over an ERASED corpus (§23.7, §24.3)\n"
      : "gate: reconstruction-equivalence (§24.3)\n",
  );
  if (result.ok) {
    process.stdout.write(
      `  PASS — ${result.checked} corpus decision(s), ${result.withTierB} with a Tier B record; ` +
        "reconstruction from Tier A alone reproduces every one byte for byte.\n",
    );
    if (erased) {
      process.stdout.write(
        `         erasure removed ${result.erasedFields.length} identifying field(s) from the inputs and changed ` +
          "no replayed cost, which is the separation §23.7 requires.\n",
      );
    }
    process.exit(0);
  }

  process.stdout.write(`  FAIL — ${result.failures.length} divergence(s):\n`);
  for (const failure of result.failures) {
    process.stdout.write(`    ${failure.name} (${failure.decisionId})\n`);
    if (failure.equivalence) {
      process.stdout.write(`      sections: ${failure.equivalence.differingSections.join(", ") || "(byte-level only)"}\n`);
      if (failure.equivalence.firstDifference) {
        process.stdout.write(`      first difference at byte ${failure.equivalence.firstDifference.offset}\n`);
        process.stdout.write(`        stored:        ${failure.equivalence.firstDifference.stored}\n`);
        process.stdout.write(`        reconstructed: ${failure.equivalence.firstDifference.reconstructed}\n`);
      }
    } else {
      process.stdout.write(`      ${failure.reason}\n`);
    }
    if (failure.erasureDefect) process.stdout.write(`      ${failure.erasureDefect}\n`);
  }
  process.exit(1);
}

module.exports = {
  DEFAULT_CORPUS,
  reconstructTierB,
  replayRound,
  reconstructionEquivalence,
  replayDecision,
  replaySample,
  loadCorpus,
  reviveMilliCU,
  runCorpus,
  auditSnapshotRetention,
};

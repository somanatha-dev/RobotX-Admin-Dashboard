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

/* ── P7-D5 D5 — what a replay result is allowed to claim ─────────────────────
 *
 * A replay used to report `ok: true` whenever it found nothing to compare, so a decision
 * with no Tier B — about 99 % of them at the default sample rate — "passed" a check that
 * never ran. And an unpinned snapshot (stored hash `""`, `decisionRecord.snapshotRow`)
 * read as `snapshotIntact: false` exactly as a tampered one does. Each fact is now named,
 * and `ok` is `true` only for a verification that actually happened. */

/** The pinned input snapshot, as replay finds it. */
const SNAPSHOT_STATE = Object.freeze({
  /** The stored hash recomputes from the stored body. */
  INTACT: "INTACT",
  /** No hash was ever recorded: the round ran unpinned (`coordinator.snapshot_unpinned`). Not tampering. */
  UNPINNED: "UNPINNED",
  /** A hash was recorded and the stored body no longer produces it. */
  HASH_MISMATCH: "HASH_MISMATCH",
});

/**
 * The decision's Tier B, as replay finds it. `tierBWritten` is history — a Tier B WAS
 * written — and retention is the row's existence (`tierB.worker.expireTierB`, P7-D5 D1).
 * An absent row of a written Tier B is expired or otherwise missing; it is never evidence
 * of tampering.
 */
const TIER_B_STATE = Object.freeze({
  RETAINED: "RETAINED",
  WRITTEN_NOT_RETAINED: "WRITTEN_NOT_RETAINED",
  NEVER_WRITTEN: "NEVER_WRITTEN",
});

/** The verdict, and `ok`'s value for each: true / false / null (nothing established either way). */
const REPLAY_STATUS = Object.freeze({
  /** Stored Tier B equals the reconstruction from complete replay inputs, against an intact snapshot. */
  VERIFIED: "VERIFIED",
  /** Stored Tier B was compared and differs from the reconstruction. */
  DIVERGENT: "DIVERGENT",
  /** The snapshot's recorded hash does not recompute. */
  SNAPSHOT_HASH_MISMATCH: "SNAPSHOT_HASH_MISMATCH",
  /** Nothing contradicts the record, and nothing was verified — see `reasons`. */
  UNVERIFIED: "UNVERIFIED",
});

/** Why a result is not `VERIFIED` (also carried, as caveats, beside the other verdicts). */
const UNVERIFIED_REASON = Object.freeze({
  SNAPSHOT_UNPINNED: "SNAPSHOT_UNPINNED",
  TIER_B_WRITTEN_NOT_RETAINED: "TIER_B_WRITTEN_NOT_RETAINED",
  TIER_B_NEVER_WRITTEN: "TIER_B_NEVER_WRITTEN",
  REPLAY_INPUTS_INCOMPLETE: "REPLAY_INPUTS_INCOMPLETE",
  /**
   * P7-D5 D2 — the snapshot does not show that the round read only the configuration it pins:
   * its `configEvidence` says MISMATCH or INCOMPLETE, or it carries none (written before D2,
   * or by a composition with no evidence provider). The pinned values are then not proven to
   * be the ones the decision used.
   */
  CONFIG_EVIDENCE_NOT_CONSISTENT: "CONFIG_EVIDENCE_NOT_CONSISTENT",
});

/** P7-D5 D2 — the evidence state a snapshot without `configEvidence` is read as. */
const CONFIG_EVIDENCE_NOT_RECORDED = "NOT_RECORDED";

const SUPPLIED = "SUPPLIED";
const NOT_SUPPLIED = "NOT_SUPPLIED";

/**
 * Classify a rebuilt snapshot. A missing or empty hash is UNPINNED, never a mismatch: the
 * writer stores `""` precisely when it refused to invent a hash.
 *
 * @param {object} snapshot
 * @returns {string} a `SNAPSHOT_STATE`
 */
function snapshotStateOf(snapshot) {
  if (!snapshot || typeof snapshot.hash !== "string" || snapshot.hash === "") return SNAPSHOT_STATE.UNPINNED;
  return snapshotModel.isIntact(snapshot) ? SNAPSHOT_STATE.INTACT : SNAPSHOT_STATE.HASH_MISMATCH;
}

/**
 * Classify a Tier A row's Tier B.
 *
 * @param {object} row a `DecisionRecordA` row with `tierB` included
 * @returns {string} a `TIER_B_STATE`
 */
function tierBStateOf(row) {
  if (row && row.tierB) return TIER_B_STATE.RETAINED;
  return row && row.tierBWritten === true ? TIER_B_STATE.WRITTEN_NOT_RETAINED : TIER_B_STATE.NEVER_WRITTEN;
}

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

  const snapshotState = snapshotStateOf(snapshot);

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

  // `ok` here says only that the L4 half ran; what it proves is `replayDecision`'s verdict.
  return { ok: true, snapshotIntact: snapshotState === SNAPSHOT_STATE.INTACT, snapshotState, result };
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
 * P7-D5 D5 — the result states what was established, never more:
 *   · `status` — `VERIFIED` (`ok: true`): an intact snapshot, a retained Tier B, complete
 *     replay inputs, and a byte-identical reconstruction. `DIVERGENT` /
 *     `SNAPSHOT_HASH_MISMATCH` (`ok: false`): a problem was found. `UNVERIFIED`
 *     (`ok: null`): nothing contradicts the record and nothing was verified; `reasons` says
 *     why (unpinned snapshot, Tier B not retained or never written, incomplete inputs).
 *   · `snapshotState`, `tierBState`, `replayInputs` — each fact on its own.
 *   · `reproducibility` — whether a complete deterministic replay was possible at all.
 * The early refusals are unchanged: `NO_SUCH_DECISION`, `SHADOW_RECORD`, `SNAPSHOT_EXPIRED`
 * (`ok: false`, `reason`).
 *
 * @param {object} deps `{ prisma, ...replayRound deps }`
 * @param {string} decisionId
 * @param {object} [options] `{ legsFor, configFor, candidatesFor, columnsFor, prunedFor }`
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

  // What the caller supplied. The snapshot pins configuration, code and switches; the Legs,
  // the round configuration, the planning seams (agent state, chargers, routing) and the
  // Tier B reconstruction come from the caller and are not pinned (P7-D5 D5).
  const legs = typeof settings.legsFor === "function" ? await settings.legsFor(row) : [];
  const config = typeof settings.configFor === "function" ? await settings.configFor(row) : {};
  const replayInputs = {
    legs: Array.isArray(legs) && legs.length > 0 ? SUPPLIED : NOT_SUPPLIED,
    config: typeof settings.configFor === "function" ? SUPPLIED : NOT_SUPPLIED,
    planningSeams: typeof deps.expandCandidates === "function" && typeof deps.pricedCandidateFor === "function" ? SUPPLIED : NOT_SUPPLIED,
    candidates: typeof settings.candidatesFor === "function" ? SUPPLIED : NOT_SUPPLIED,
  };
  const inputsComplete = Object.values(replayInputs).every((value) => value === SUPPLIED);

  const snapshot = {
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
    // P7-D5 — `captureSnapshot` hashes the resolved values, and `snapshotRow` stores them in
    // their own column, not in `pins`. Without this the rebuilt body lacks a hashed key and a
    // genuinely intact snapshot reads as tampered.
    resolvedValues: row.inputSnapshot.resolvedValues ?? null,
    ...(row.inputSnapshot.pins || {}),
  };

  const replayed = await replayRound(deps, {
    snapshot,
    shardId: row.shardId,
    legs,
    config,
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

  const snapshotState = replayed.snapshotState;
  const tierBState = tierBStateOf(row);

  // Caveats on any verdict, and the whole reason for UNVERIFIED.
  const reasons = [];
  if (snapshotState === SNAPSHOT_STATE.UNPINNED) reasons.push(UNVERIFIED_REASON.SNAPSHOT_UNPINNED);
  if (tierBState === TIER_B_STATE.WRITTEN_NOT_RETAINED) reasons.push(UNVERIFIED_REASON.TIER_B_WRITTEN_NOT_RETAINED);
  if (tierBState === TIER_B_STATE.NEVER_WRITTEN) reasons.push(UNVERIFIED_REASON.TIER_B_NEVER_WRITTEN);
  if (!inputsComplete) reasons.push(UNVERIFIED_REASON.REPLAY_INPUTS_INCOMPLETE);
  // P7-D5 D2 — read from the hashed body (`pins.configEvidence`), so it is as trustworthy as
  // the snapshot state says; on a HASH_MISMATCH that verdict already takes precedence.
  const configEvidence = snapshot.configEvidence && typeof snapshot.configEvidence === "object" ? snapshot.configEvidence : null;
  const configEvidenceState = configEvidence && typeof configEvidence.state === "string" ? configEvidence.state : CONFIG_EVIDENCE_NOT_RECORDED;
  if (configEvidenceState !== "CONSISTENT") reasons.push(UNVERIFIED_REASON.CONFIG_EVIDENCE_NOT_CONSISTENT);

  // Precedence: a snapshot that does not recompute discredits everything built on it; then a
  // comparison that failed; VERIFIED only with nothing left to qualify it. A divergence is
  // reported even when inputs were incomplete — a false alarm is the safe error here.
  let status;
  if (snapshotState === SNAPSHOT_STATE.HASH_MISMATCH) status = REPLAY_STATUS.SNAPSHOT_HASH_MISMATCH;
  else if (equivalence !== null && !equivalence.ok) status = REPLAY_STATUS.DIVERGENT;
  else if (reasons.length === 0 && equivalence !== null && equivalence.ok) status = REPLAY_STATUS.VERIFIED;
  else status = REPLAY_STATUS.UNVERIFIED;

  // §9.6's deterministic replay needs every version pinned AND the inputs bound to them. The
  // deferred pins (agent state, prices, forecast, charger projection, models) have no producer
  // yet, so a verified configuration hash never implies this.
  const pinCheck = snapshotModel.assertReplayable(snapshot);

  return {
    // true: VERIFIED. false: a problem was established. null: nothing was established.
    ok: status === REPLAY_STATUS.VERIFIED ? true : status === REPLAY_STATUS.UNVERIFIED ? null : false,
    status,
    reasons,
    decisionId: row.decisionId,
    tierAPresent: true,
    // Retained now — the row exists. `tierBWritten` is history, carried as stored.
    tierBPresent: stored !== null,
    tierBWritten: row.tierBWritten === true,
    tierBState,
    snapshotIntact: replayed.snapshotIntact,
    snapshotState,
    configEvidenceState,
    configMismatches: configEvidence && Array.isArray(configEvidence.mismatches) ? configEvidence.mismatches : [],
    replayInputs,
    reproducibility: {
      completeDeterministicReplay:
        snapshotState === SNAPSHOT_STATE.INTACT && pinCheck.ok && inputsComplete && configEvidenceState === "CONSISTENT",
      allVersionsPinned: pinCheck.ok,
      missingPins: pinCheck.missing,
      note:
        "a verified snapshot hash pins configuration, code and kill switches only; agent state, charger state and " +
        "routing reach the replay through caller-supplied inputs and are not pinned",
    },
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
    // P7-D5 D5 — what the sample actually established, so an all-unverified run cannot read as clean.
    verified: results.filter((row) => row.status === REPLAY_STATUS.VERIFIED).length,
    unverified: results.filter((row) => row.status === REPLAY_STATUS.UNVERIFIED).length,
    snapshotHashMismatch: results.filter((row) => row.status === REPLAY_STATUS.SNAPSHOT_HASH_MISMATCH).length,
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

    // ── PHASE 14 remediation (P14-R13) — §23.7's *first* bullet, which this gate did
    // not enforce ──────────────────────────────────────────────────────────
    //
    // §23.7 states two things and this gate implemented one of them:
    //
    //   > **No decision record or input snapshot stores an identifying value directly.**
    //   > … The build gate enforces the separation. The reconstruction-equivalence gate
    //   > is run additionally over a corpus in which erasure has been applied, and MUST
    //   > still reproduce Tier B byte-for-byte.
    //
    // The byte-for-byte half catches a field whose erasure *changes a replayed cost*. It
    // does not catch a field that is merely **stored**: a street address planted into a
    // Tier A section that no cost reads was demonstrated during this remediation to be
    // reported by this gate (`erasedFields` went from 0 to 1) and to **pass** it. The
    // storage rule was therefore enforced by nothing at build — `checkIdentityIsolation`
    // is a static scan of four module *sources* for field names, not a check of any
    // record's content.
    //
    // Scoped to `tierA`, deliberately. §23.7's rule binds "decision records and input
    // snapshots"; `reconstructionInput` is the replay harness's own input bundle and is
    // not one, so an identifying field there is reported and not failed on.
    const storedInARecord = applied.erasedFields.filter((field) => String(field.path || "").startsWith("tierA"));
    for (const field of storedInARecord) {
      failures.push({
        name: field.name,
        decisionId: null,
        reason: "IDENTIFYING_VALUE_STORED_IN_A_DECISION_RECORD",
        path: field.path,
        field: field.field,
        erasureDefect:
          `the Tier A record holds an identifying value at "${field.path}". §23.7: "No decision record or input ` +
          'snapshot stores an identifying value directly. Both store a stable surrogate key into a separate, ' +
          'access-controlled identity store, plus the derived, non-identifying quantities the decision actually ' +
          'consumed." This is caught here even though erasing it changed no replayed cost — a value that is stored ' +
          "is a value that leaks, whether or not any arithmetic read it.",
      });
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
  SNAPSHOT_STATE,
  TIER_B_STATE,
  REPLAY_STATUS,
  UNVERIFIED_REASON,
  snapshotStateOf,
  tierBStateOf,
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

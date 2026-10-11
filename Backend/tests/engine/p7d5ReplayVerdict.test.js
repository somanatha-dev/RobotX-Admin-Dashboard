"use strict";

/**
 * P7-D5 D5 — a replay result states what it established, and never more.
 *
 * Found (P7-D5 evidence completeness audit, 2026-10-11), and re-verified before this change:
 *   · `replayDecision` returned `ok: equivalence === null ? true : …`, so every decision with
 *     no Tier B — ~99 % at the default 1 % sample rate — "passed" a comparison that never ran;
 *   · an unpinned snapshot (the writer stores hash `""` when it refuses to invent one) read as
 *     `snapshotIntact: false`, exactly like a tampered one;
 *   · nothing said that a verified configuration hash does not pin agent state, chargers or
 *     routing, which reach replay only through caller-supplied inputs.
 *
 * The snapshots here come from the real writer path — `coordinator.pinRoundInputs` →
 * `decisionRecord.snapshotRow` — through a JSON round trip, as PostgreSQL returns them.
 *
 * MOCKED BOUNDARY: the store (a `findUnique` returning one row with its includes), and
 * `round.plan`, which replay calls and never `execute`.
 */

const replay = require("../../tools/replay/replayDecision");
const coordinator = require("../../src/workers/coordinator.worker");
const configService = require("../../src/engine/config/service");
const decisionRecord = require("../../src/engine/observability/decisionRecord");
const snapshotModel = require("../../src/engine/determinism/snapshot");
const tierB = require("../../src/engine/observability/tierB");

const { REPLAY_STATUS, SNAPSHOT_STATE, TIER_B_STATE, UNVERIFIED_REASON } = replay;

const SHARD = "shard-a";
const DECISION_TIME_MS = 1000;
const ROUND_ID = `${SHARD}:${DECISION_TIME_MS}`;
const DECISION_ID = `${ROUND_ID}:L1`;
const CANDIDATES = [{ agentId: "A1", rejected: false, gammaMilliCU: 5n, breakdown: { cDirect: 5n } }];

const throughJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** P7-D5 D2 — the evidence of a round that read only its pinned configuration. */
const CONSISTENT_EVIDENCE = { state: "CONSISTENT", pinnedVersion: 7, mismatches: [], problems: [] };

/**
 * An `InputSnapshot` row as the writer stores it and PostgreSQL returns it: pinned at round
 * start, then sealed with the round's configuration evidence (`coordinator.sealRoundSnapshot`).
 */
function storedSnapshot({ pinned, evidence = CONSISTENT_EVIDENCE }) {
  const round = { roundId: ROUND_ID, decisionTimeMs: DECISION_TIME_MS, seed: snapshotModel.deriveSeed(ROUND_ID) };
  const pinnedInputs = coordinator.pinRoundInputs(
    { configSnapshot: () => configService.buildSnapshot({ version: 7 }), ...(pinned ? { codeVersion: "git:abc1234" } : {}) },
    round,
  );
  expect(pinnedInputs.pinned).toBe(pinned);
  const sealed = evidence === null ? pinnedInputs.snapshot : coordinator.sealRoundSnapshot(pinnedInputs, evidence);
  const row = decisionRecord.snapshotRow({ snapshot: sealed, roundId: ROUND_ID, shardId: SHARD, decisionTimeMs: DECISION_TIME_MS });
  return { ...throughJson(row), decisionTime: new Date(DECISION_TIME_MS) };
}

/** The stored Tier B for `CANDIDATES`, as a row. */
function storedTierB() {
  return throughJson(tierB.toRow(tierB.build({ decisionId: DECISION_ID, roundId: ROUND_ID, shardId: SHARD, decisionTimeMs: DECISION_TIME_MS, candidates: CANDIDATES }), { writtenBecause: "SAMPLED" }));
}

/**
 * Replay one decision.
 *
 * @param {object} spec
 * @param {object} spec.snapshot the stored snapshot row
 * @param {object|null} spec.tierBRow the retained Tier B row, or null
 * @param {boolean} spec.tierBWritten Tier A's history flag
 * @param {boolean} [spec.complete] supply every replay input (default true)
 * @param {object[]} [spec.reconstructed] the candidates the reconstruction yields (default `CANDIDATES`)
 */
async function run(spec) {
  const complete = spec.complete !== false;
  const row = {
    decisionId: DECISION_ID,
    roundId: ROUND_ID,
    shardId: SHARD,
    decisionTime: new Date(DECISION_TIME_MS),
    shadowLabel: null,
    samplingRate: 0.01,
    samplingDraw: null,
    tierBWritten: spec.tierBWritten,
    tierBReason: spec.tierBWritten ? "SAMPLED" : null,
    inputSnapshot: spec.snapshot,
    tierB: spec.tierBRow,
  };
  const deps = {
    prisma: { decisionRecordA: { findUnique: async () => row } },
    round: {
      plan: async () => ({ roundId: ROUND_ID, shardId: SHARD, decisionTimeMs: DECISION_TIME_MS, decisions: [{ legId: "L1" }] }),
      execute: async () => {
        throw new Error("replay must never cross into L3");
      },
    },
    ...(complete ? { expandCandidates: async () => ({ candidates: [] }), pricedCandidateFor: () => null } : {}),
  };
  const options = complete
    ? { legsFor: () => [{ legId: "L1" }], configFor: () => ({}), candidatesFor: () => spec.reconstructed || CANDIDATES }
    : { candidatesFor: () => spec.reconstructed || CANDIDATES };
  return replay.replayDecision(deps, DECISION_ID, options);
}

describe("P7-D5 D5 — each verdict, from the real writer's snapshots", () => {
  test("VERIFIED: intact snapshot, retained Tier B, complete inputs, identical reconstruction → ok true", async () => {
    const result = await run({ snapshot: storedSnapshot({ pinned: true }), tierBRow: storedTierB(), tierBWritten: true });
    expect(result).toMatchObject({
      ok: true,
      status: REPLAY_STATUS.VERIFIED,
      reasons: [],
      snapshotState: SNAPSHOT_STATE.INTACT,
      snapshotIntact: true,
      tierBState: TIER_B_STATE.RETAINED,
      tierBPresent: true,
      tierBWritten: true,
    });
    expect(result.equivalence.ok).toBe(true);
  });

  test("…and still NOT a complete deterministic replay: the configuration hash pins no agent, charger or routing state", async () => {
    const result = await run({ snapshot: storedSnapshot({ pinned: true }), tierBRow: storedTierB(), tierBWritten: true });
    expect(result.reproducibility.completeDeterministicReplay).toBe(false);
    expect(result.reproducibility.allVersionsPinned).toBe(false);
    expect(result.reproducibility.missingPins).toEqual(
      expect.arrayContaining(["agentStateVersion", "priceSnapshotVersion", "forecastVersion", "chargerProjectionVersion", "modelVersions"]),
    );
    expect(result.reproducibility.note).toMatch(/agent state, charger state and routing/);
  });

  test("DIVERGENT: a retained Tier B the reconstruction does not reproduce → ok false", async () => {
    const result = await run({
      snapshot: storedSnapshot({ pinned: true }),
      tierBRow: storedTierB(),
      tierBWritten: true,
      reconstructed: [{ agentId: "A1", rejected: false, gammaMilliCU: 6n, breakdown: { cDirect: 6n } }],
    });
    expect(result).toMatchObject({ ok: false, status: REPLAY_STATUS.DIVERGENT, snapshotState: SNAPSHOT_STATE.INTACT });
    expect(result.equivalence.ok).toBe(false);
  });

  test("expired Tier B (written, not retained) → UNVERIFIED, ok null — never a failure, never tampering", async () => {
    const result = await run({ snapshot: storedSnapshot({ pinned: true }), tierBRow: null, tierBWritten: true });
    expect(result).toMatchObject({
      ok: null,
      status: REPLAY_STATUS.UNVERIFIED,
      reasons: [UNVERIFIED_REASON.TIER_B_WRITTEN_NOT_RETAINED],
      snapshotState: SNAPSHOT_STATE.INTACT,
      tierBState: TIER_B_STATE.WRITTEN_NOT_RETAINED,
      tierBPresent: false,
      tierBWritten: true,
      equivalence: null,
    });
  });

  test("never-written Tier B (unsampled) → UNVERIFIED, ok null", async () => {
    const result = await run({ snapshot: storedSnapshot({ pinned: true }), tierBRow: null, tierBWritten: false });
    expect(result).toMatchObject({
      ok: null,
      status: REPLAY_STATUS.UNVERIFIED,
      reasons: [UNVERIFIED_REASON.TIER_B_NEVER_WRITTEN],
      tierBState: TIER_B_STATE.NEVER_WRITTEN,
      tierBWritten: false,
    });
  });

  test("UNPINNED snapshot (stored hash \"\") → UNVERIFIED, not a hash mismatch, even with an equivalent Tier B", async () => {
    const snapshot = storedSnapshot({ pinned: false });
    expect(snapshot.hash).toBe("");
    const result = await run({ snapshot, tierBRow: storedTierB(), tierBWritten: true });
    expect(result).toMatchObject({
      ok: null,
      status: REPLAY_STATUS.UNVERIFIED,
      reasons: [UNVERIFIED_REASON.SNAPSHOT_UNPINNED],
      snapshotState: SNAPSHOT_STATE.UNPINNED,
      snapshotIntact: false,
    });
    expect(result.equivalence.ok).toBe(true);
  });

  test("a genuine hash mismatch (edited resolved value) → SNAPSHOT_HASH_MISMATCH, ok false, even when Tier B matches", async () => {
    const snapshot = storedSnapshot({ pinned: true });
    snapshot.resolvedValues = { ...snapshot.resolvedValues, "candidate.max_evaluated": 1 };
    const result = await run({ snapshot, tierBRow: storedTierB(), tierBWritten: true });
    expect(result).toMatchObject({ ok: false, status: REPLAY_STATUS.SNAPSHOT_HASH_MISMATCH, snapshotState: SNAPSHOT_STATE.HASH_MISMATCH });
    expect(result.equivalence.ok).toBe(true);
  });

  test.each([
    ["an edited pin", (s) => ({ ...s, pins: { ...s.pins, configVersion: 8 } })],
    ["pins removed", (s) => ({ ...s, pins: null })],
    ["an edited seed", (s) => ({ ...s, seed: "0000000000000000" })],
    ["an edited hash", (s) => ({ ...s, hash: "f".repeat(64) })],
  ])("%s → SNAPSHOT_HASH_MISMATCH", async (label, edit) => {
    const result = await run({ snapshot: edit(storedSnapshot({ pinned: true })), tierBRow: storedTierB(), tierBWritten: true });
    expect(result.status).toBe(REPLAY_STATUS.SNAPSHOT_HASH_MISMATCH);
  });

  test("incomplete replay inputs → UNVERIFIED with REPLAY_INPUTS_INCOMPLETE, and each missing input named", async () => {
    const result = await run({ snapshot: storedSnapshot({ pinned: true }), tierBRow: storedTierB(), tierBWritten: true, complete: false });
    expect(result).toMatchObject({
      ok: null,
      status: REPLAY_STATUS.UNVERIFIED,
      reasons: [UNVERIFIED_REASON.REPLAY_INPUTS_INCOMPLETE],
      replayInputs: { legs: "NOT_SUPPLIED", config: "NOT_SUPPLIED", planningSeams: "NOT_SUPPLIED", candidates: "SUPPLIED" },
    });
  });

  test("a stored Tier B with Tier A's flag still false (orphaned write) is RETAINED and the flag is reported as stored", async () => {
    const result = await run({ snapshot: storedSnapshot({ pinned: true }), tierBRow: storedTierB(), tierBWritten: false });
    expect(result).toMatchObject({ status: REPLAY_STATUS.VERIFIED, tierBState: TIER_B_STATE.RETAINED, tierBWritten: false });
  });
});

describe("P7-D5 D5 — ok is true only for VERIFIED, across every combination", () => {
  const snapshots = [
    ["INTACT", () => storedSnapshot({ pinned: true })],
    ["UNPINNED", () => storedSnapshot({ pinned: false })],
    ["HASH_MISMATCH", () => ({ ...storedSnapshot({ pinned: true }), seed: "0000000000000000" })],
  ];
  const tierBs = [
    ["RETAINED", () => storedTierB(), true],
    ["WRITTEN_NOT_RETAINED", () => null, true],
    ["NEVER_WRITTEN", () => null, false],
  ];
  const cases = [];
  for (const [snapshotLabel, snapshot] of snapshots) {
    for (const [tierBLabel, tierBRow, written] of tierBs) {
      for (const complete of [true, false]) {
        for (const equal of [true, false]) cases.push([snapshotLabel, tierBLabel, complete, equal, snapshot, tierBRow, written]);
      }
    }
  }

  test.each(cases)("snapshot %s, Tier B %s, inputs complete %p, reconstruction equal %p", async (snapshotLabel, tierBLabel, complete, equal, snapshot, tierBRow, written) => {
    const result = await run({
      snapshot: snapshot(),
      tierBRow: tierBRow(),
      tierBWritten: written,
      complete,
      reconstructed: equal ? CANDIDATES : [{ agentId: "A2", rejected: false, gammaMilliCU: 9n, breakdown: { cDirect: 9n } }],
    });
    const shouldVerify = snapshotLabel === "INTACT" && tierBLabel === "RETAINED" && complete && equal;
    expect(result.ok === true).toBe(shouldVerify);
    expect(result.status === REPLAY_STATUS.VERIFIED).toBe(shouldVerify);
    expect(result.snapshotState).toBe(snapshotLabel);
    expect(result.tierBState).toBe(tierBLabel);
    // A missing Tier B is never itself a failure verdict.
    if (tierBLabel !== "RETAINED" && snapshotLabel !== "HASH_MISMATCH") expect(result.ok).toBeNull();
  });
});

describe("P7-D5 D5 — classifiers and the sample report", () => {
  test("snapshotStateOf: no snapshot, null or empty hash are UNPINNED; only a recorded hash can mismatch", () => {
    expect(replay.snapshotStateOf(null)).toBe(SNAPSHOT_STATE.UNPINNED);
    expect(replay.snapshotStateOf({ hash: null })).toBe(SNAPSHOT_STATE.UNPINNED);
    expect(replay.snapshotStateOf({ hash: "" })).toBe(SNAPSHOT_STATE.UNPINNED);
    expect(replay.snapshotStateOf({ hash: "abc" })).toBe(SNAPSHOT_STATE.HASH_MISMATCH);
    const captured = snapshotModel.captureSnapshot({ roundId: "r", decisionTime: 1, configVersion: 1, codeVersion: "c", killSwitchState: {} });
    expect(replay.snapshotStateOf({ ...captured })).toBe(SNAPSHOT_STATE.INTACT);
  });

  test("tierBStateOf reads retention from the row and history from the flag", () => {
    expect(replay.tierBStateOf({ tierB: {}, tierBWritten: true })).toBe(TIER_B_STATE.RETAINED);
    expect(replay.tierBStateOf({ tierB: null, tierBWritten: true })).toBe(TIER_B_STATE.WRITTEN_NOT_RETAINED);
    expect(replay.tierBStateOf({ tierB: null, tierBWritten: false })).toBe(TIER_B_STATE.NEVER_WRITTEN);
  });

  test("replaySample tallies what was established: an all-unverified sample is neither clean nor release-blocking", async () => {
    const snapshot = storedSnapshot({ pinned: true });
    const prisma = {
      decisionRecordA: {
        findMany: async () => [{ decisionId: "d1" }, { decisionId: "d2" }],
        findUnique: async ({ where }) => ({
          decisionId: where.decisionId,
          shardId: SHARD,
          shadowLabel: null,
          samplingRate: null,
          tierBWritten: where.decisionId === "d1",
          inputSnapshot: snapshot,
          tierB: null,
        }),
      },
    };
    const result = await replay.replaySample({ prisma, round: { plan: async () => ({ decisions: [] }) } }, { rate: 1 });
    expect(result).toMatchObject({ replayed: 2, verified: 0, unverified: 2, snapshotHashMismatch: 0, divergent: 0, releaseBlocking: false });
  });
});

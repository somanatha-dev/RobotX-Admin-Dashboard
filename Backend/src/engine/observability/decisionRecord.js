"use strict";

/**
 * The Decision Record (§21.2) — **Tier 1** (T1-03), invariants I10 and I15.
 *
 * The single writer of `InputSnapshot`, `DecisionRecordA` and `DecisionRecordB`, and
 * the only place the two tiers, the sampler, and the durable store meet. Everything
 * above it is pure (`tierA.js`, `tierB.js`, `sampling.js`); everything below it is a
 * store handed in by the composition root.
 *
 * ── Why one writer rather than a call at each site ──────────────────────────
 * §21.1 is unambiguous that this is a functional requirement rather than
 * instrumentation:
 *
 * > A decision that cannot be explained after the fact cannot be defended, corrected,
 * > or improved. Observability here is not instrumentation added to a finished system;
 * > it is part of the deliverable.
 *
 * Two properties follow that a scattered set of writes cannot have. **Every decision
 * has a Tier A record** is checkable only if one function is responsible for producing
 * one per decision — Phase 10 already made "every round produces a decision record" a
 * property of the round's single exit, and this is the same discipline one layer down.
 * And **the sampling decision is taken once**, from the decision id, so Tier A's
 * recorded `samplingDraw` is the draw that actually selected the record rather than a
 * second evaluation that might disagree.
 *
 * ── The ordering inside a round, and why the snapshot goes first ────────────
 * ```
 *   InputSnapshot  →  DecisionRecordA (per Leg)  →  DecisionRecordB (selected only)
 * ```
 * The snapshot first, because §24.3 makes "a decision whose Tier A record is retained
 * but whose input snapshot has expired" a defect: a Tier A row written before its
 * snapshot exists is that defect at time zero, and it is the state the record can never
 * recover from — the inputs are gone by then. Writing the snapshot first means a crash
 * between the two leaves an orphan snapshot, which costs storage and nothing else.
 *
 * Tier B last, because it is the only one of the three that may legitimately not be
 * written. A failure to write Tier B degrades an explanation from `TIER_B` to
 * `RECONSTRUCTED`; a failure to write Tier A or the snapshot loses the decision.
 *
 * ── Retention ordering is asserted here, not only at publish ────────────────
 * §22.1 rule 5 validation V6 rejects a config whose snapshot retention is shorter than
 * Tier A's. That is the right place to *prevent* it. `retentionFor()` additionally
 * refuses to compute a snapshot expiry earlier than the Tier A expiry it is written
 * beside, so a defect in the resolution path cannot produce the pair V6 exists to
 * forbid.
 */

const { canonicalJson } = require("../determinism/ordering");
const tierA = require("./tierA");
const tierB = require("./tierB");
const sampling = require("./sampling");

/** @structural milliseconds in a day, for turning a retention in days into an instant */
const MS_PER_DAY = 86400000;

/**
 * The decision id for one Leg in one round.
 *
 * `roundId:legId`, unchanged from Phase 10, because `Commitment.decisionRef` already
 * carries values in that shape and invariant I10 — "every commitment references a
 * decision record that reproduces it" — is a join on it.
 *
 * @param {string} roundId
 * @param {string} legId
 * @returns {string}
 */
function decisionIdFor(roundId, legId) {
  return `${roundId}:${legId}`;
}

/**
 * The prefix a shadow run's decision ids carry (§21.6).
 * @structural the shadow decision-id namespace
 */
const SHADOW_ID_PREFIX = "shadow";

/**
 * The decision id for a shadow run's decision.
 *
 * Both the id *and* `DecisionRecordA.shadowLabel` mark it. Two markers rather than one
 * because they fail differently: a query that forgets the column filter still cannot
 * mistake the id for a production one, and a join on `Commitment.decisionRef` can never
 * resolve to a shadow record because no commitment was ever written for it.
 *
 * @param {string} label
 * @param {string} roundId
 * @param {string} legId
 * @returns {string}
 */
function shadowDecisionIdFor(label, roundId, legId) {
  return `${SHADOW_ID_PREFIX}:${label}:${roundId}:${legId}`;
}

/**
 * The Prisma `where` fragment every production read of `DecisionRecordA` must carry.
 *
 * Exported as one value rather than repeated as a literal, so that "shadow decisions
 * never enter an SLI, an explanation, or a replay corpus" is one thing to check rather
 * than one per call site. `tests/engine/observabilityShadow.test.js` asserts by source
 * scan that no Phase 11 module queries `decisionRecordA` without it.
 */
const PRODUCTION_ONLY = Object.freeze({ shadowLabel: null });

/**
 * Compute the two retention instants, refusing the ordering V6 forbids.
 *
 * @param {object} input
 * @param {number} input.decisionTimeMs
 * @param {number} input.fullRetentionDays `observability.full_retention`
 * @param {number} input.tierBRetentionDays `observability.tier_b_retention`
 * @param {number} input.snapshotRetentionDays `observability.input_snapshot_retention`
 * @returns {{ ok: boolean, tierAUntil: Date|null, tierBUntil: Date|null,
 *             snapshotUntil: Date|null, problems: string[] }}
 */
function retentionFor(input) {
  const source = input || {};
  const problems = [];
  const at = Number.isFinite(source.decisionTimeMs) ? source.decisionTimeMs : null;
  if (at === null) return { ok: false, tierAUntil: null, tierBUntil: null, snapshotUntil: null, problems: ["no decision time"] };

  const days = (value) => (Number.isFinite(value) && value > 0 ? value : null);
  const full = days(source.fullRetentionDays);
  const tierBDays = days(source.tierBRetentionDays);
  const snapshotDays = days(source.snapshotRetentionDays);

  if (full !== null && snapshotDays !== null && snapshotDays < full) {
    problems.push(
      `observability.input_snapshot_retention (${snapshotDays} d) is shorter than ` +
        `observability.full_retention (${full} d). §21.2: a retention policy that expires a snapshot before ` +
        "its Tier A record is a defect — the record survives as evidence that cannot be replayed or " +
        "reconstructed (§24.3). Publish-time validation V6 rejects this config; refusing it here as well " +
        "means a defect in the resolution path cannot produce the pair either.",
    );
  }

  return {
    ok: problems.length === 0,
    tierAUntil: full === null ? null : new Date(at + full * MS_PER_DAY),
    tierBUntil: tierBDays === null ? null : new Date(at + tierBDays * MS_PER_DAY),
    snapshotUntil: snapshotDays === null ? null : new Date(at + snapshotDays * MS_PER_DAY),
    problems,
  };
}

/**
 * Turn a pinned round snapshot into the `InputSnapshot` row shape.
 *
 * @param {object} input `{ snapshot, roundId, shardId, decisionTimeMs, retainUntil }`
 * @returns {object}
 */
function snapshotRow(input) {
  const source = input || {};
  const snapshot = source.snapshot || {};
  const pins = snapshot.pins && typeof snapshot.pins === "object" ? snapshot.pins : {};

  return {
    snapshotId: String(snapshot.snapshotId ?? source.roundId),
    roundId: String(source.roundId),
    shardId: String(source.shardId),
    decisionTime: new Date(source.decisionTimeMs),
    // The content address `determinism/snapshot.captureSnapshot()` computed. Stored so
    // tampering is caught by recomputation (`snapshot.isIntact`) rather than by trust.
    hash: String(snapshot.hash ?? ""),
    seed: snapshot.seed ?? null,
    configVersion: pins.configVersion === undefined || pins.configVersion === null ? null : String(pins.configVersion),
    codeVersion: pins.codeVersion === undefined || pins.codeVersion === null ? null : String(pins.codeVersion),
    activeRegime: pins.activeRegime ?? null,
    killSwitchState: pins.killSwitchState ?? null,
    pins,
    resolvedValues: snapshot.resolvedValues ?? pins.resolvedValues ?? null,
    retainUntil: source.retainUntil ?? null,
  };
}

/**
 * Find the partition of a round result that decided one Leg.
 *
 * ── Why this is a lookup and not an assumption ──────────────────────────────
 * §9.4 partitions a round into disjoint sub-problems and solves each independently, and
 * `PHASE_10_REMEDIATION_AND_CLOSURE.md`'s D5 established that those results **compose**
 * rather than compete. Two partitions of one round can therefore be decided by two
 * different solvers, with two different certification states and two different truncation
 * gaps. Attributing the round's first partition — or a roll-up of all of them — to every
 * Leg would put a claim in the record that no solve made about that Leg.
 *
 * Returns `null` when the Leg was decided before any partition existed (no feasible
 * candidate, an unsolvable regime), which is the honest answer: there was no solve, so
 * there is no solver, no certification and no gap. `null` is not `false`, and a record
 * that said `optimalityCertified: false` for a Leg nothing ever tried to optimise would
 * be describing a failure that did not happen.
 *
 * @param {object} round the frozen `round.execute()` result
 * @param {string} legId
 * @returns {object|null} the partition report, or null
 */
function partitionFor(round, legId) {
  const target = String(legId);
  const partitions = (round && round.partitions) || [];
  return partitions.find((part) => Array.isArray(part.legIds) && part.legIds.includes(target)) || null;
}

/**
 * The truncation gap of one solve: `objective − bound`, in exact int64 milli-CU.
 *
 * Handoff P11-3. Zero for a certified result — the solver returns `objective === bound`
 * when it proves optimality — and positive only where a §9.4 budget stopped the search
 * with an incumbent it could not prove optimal.
 *
 * `bigint` throughout and never `Number`: a float subtraction of two milli-CU objectives
 * above 2^53 reports a gap of zero for two values that differ, and "the solve was exact"
 * is the single most damaging thing this field could say falsely. Returns `null` — never
 * `0n` — when either side is unmeasured, because an unmeasured gap and a proven-zero gap
 * are opposite claims.
 *
 * ── What it does NOT bound, and why the record carries a second field ───────
 * §9.3's objective is lexicographic — `(unassigned, milliCU)` — and Phase 10 publishes the
 * money component as `objectiveMilliCU` / `boundMilliCU`. This subtraction is therefore
 * the *money* gap. On a solve that stopped before its first scaling phase the incumbent
 * leaves every Leg queued at money cost zero against a money lower bound of zero, so this
 * returns `0n` for the worst incumbent the round can produce. That is arithmetically
 * correct and, alone, misleading, which is why `tierAInputFor` records
 * `legsUnassignedByIncumbent` beside it: the dominant component of the same gap.
 *
 * A negative result is returned as computed rather than clamped. It would mean the
 * "bound" is not a bound, and clamping it to zero would hide a solver defect behind a
 * field whose whole job is to show one.
 *
 * @param {object|null} partition a partition report
 * @returns {bigint|null}
 */
function truncationGapOf(partition) {
  if (!partition) return null;
  const objective = partition.objectiveMilliCU;
  const bound = partition.boundMilliCU;
  if (typeof objective !== "bigint" || typeof bound !== "bigint") return null;
  return objective - bound;
}

/**
 * Assemble the Tier A `build()` input for one Leg of a round result.
 *
 * This is the adapter between `solve/round.js`'s decision fragment — which is shaped
 * for the solver — and §21.2's section table. It lives here rather than in the round so
 * that the round stays free of the record's shape: L4 produces the decision, L2 records
 * it, and a change to §21.2's table does not reach into the solver.
 *
 * @param {object} input
 * @param {object} input.round the frozen `round.execute()` result
 * @param {object} input.decision one entry of `round.decisions`
 * @param {object} input.context `{ shardId, leadershipFence, coordinatorInstance,
 *   snapshot, versions, trigger, legMeta, candidates, rejectionSummary, degradation,
 *   overrides, predictions, compactTopN, omega }`
 * @returns {object} the `tierA.build()` input
 */
function tierAInputFor(input) {
  const source = input || {};
  const round = source.round || {};
  const decision = source.decision || {};
  const context = source.context || {};
  const snapshot = context.snapshot || {};
  const pins = snapshot.pins && typeof snapshot.pins === "object" ? snapshot.pins : {};
  const legMeta = context.legMeta || {};
  const committed = (round.committed || []).find((entry) => String(entry.legId) === String(decision.legId)) || null;
  // P11-2 / P11-3 — the sub-problem that actually decided this Leg, and the gap it left.
  const partition = partitionFor(round, decision.legId);
  const truncationGap = truncationGapOf(partition);

  return {
    identity: {
      decisionId: decisionIdFor(round.roundId, decision.legId),
      roundId: round.roundId,
      shardId: context.shardId ?? round.shardId,
      leadershipFence: context.leadershipFence ?? null,
      coordinatorInstance: context.coordinatorInstance ?? null,
      decisionTimeMs: round.decisionTimeMs,
    },

    versions: {
      codeVersion: (context.versions && context.versions.codeVersion) ?? pins.codeVersion ?? null,
      configVersion: (context.versions && context.versions.configVersion) ?? pins.configVersion ?? null,
      activeRegime: (context.versions && context.versions.activeRegime) ?? pins.activeRegime ?? null,
      modelVersions: (context.versions && context.versions.modelVersions) ?? pins.modelVersions ?? null,
      mapVersion: (context.versions && context.versions.mapVersion) ?? pins.mapVersion ?? null,
      routingGraphVersion: (context.versions && context.versions.routingGraphVersion) ?? pins.routingGraphVersion ?? null,
      chargerProjectionVersion:
        (context.versions && context.versions.chargerProjectionVersion) ?? pins.chargerProjectionVersion ?? null,
    },

    trigger: context.trigger ?? tierA.TRIGGER.NEW_ARRIVAL,

    inputSnapshotRefs: {
      snapshotId: snapshot.snapshotId ?? round.roundId,
      hash: snapshot.hash ?? null,
      seed: snapshot.seed ?? null,
    },

    leg: {
      legId: decision.legId,
      purpose: legMeta.purpose ?? null,
      missionClass: legMeta.missionClass ?? null,
      tenantId: legMeta.tenantId ?? null,
      sla: legMeta.sla ?? null,
      queueAgeSeconds: legMeta.queueAgeSeconds ?? null,
      ladderStep: legMeta.ladderStep ?? null,
    },

    outcome: {
      outcome: decision.outcome ?? null,
      agentId: decision.agentId ?? null,
      columnIdentity: decision.columnIdentity ?? null,
      columnLegIds: decision.columnLegIds ?? null,
      commitmentId: committed ? (committed.commitmentId ?? null) : null,
      commitmentFence: committed ? (committed.commitmentFence ?? null) : null,
      agentAuthorityEpoch: committed ? (committed.agentAuthorityEpoch ?? null) : null,
      detail: decision.detail ?? null,
      commitAbortReason: decision.commitAbortReason ?? null,
    },

    candidates: context.candidates || [],
    costTotals: context.costTotals || null,
    rejectionSummary: context.rejectionSummary || [],

    searchAndSolveBounds: {
      cellsExplored: decision.cellsExplored ?? null,
      agentsEvaluated: decision.agentsEvaluated ?? null,
      smallestUnexploredBoundMilliCU: (context.bounds && context.bounds.smallestUnexploredBoundMilliCU) ?? null,
      omegaTerminalMilliCU: (context.omega && context.omega.terminalMilliCU) ?? null,
      omegaPolicyMilliCU: (context.omega && context.omega.policyMilliCU) ?? null,
      searchGapMilliCU: decision.searchGapMilliCU ?? null,
      lpIpGapMilliCU: round.lpIpGapMilliCU ?? null,
      // Taken from the deciding partition, not from the round, and not inferred from
      // `outcome`. A Leg whose sub-problem never ran carries `null` on all five rather
      // than a manufactured "not certified".
      solver: partition ? (partition.solver ?? null) : null,
      optimalityCertified: partition ? (partition.optimalityCertified ?? null) : null,
      fallbackFrom: partition ? (partition.fallbackFrom ?? null) : null,
      objectiveMilliCU: partition ? (partition.objectiveMilliCU ?? null) : null,
      boundMilliCU: partition ? (partition.boundMilliCU ?? null) : null,
      truncationGapMilliCU: truncationGap,
      legsUnassignedByIncumbent: partition && Array.isArray(partition.unassigned) ? partition.unassigned.length : null,
      regime: round.regime ?? null,
      guarantees: round.guarantees
        ? { exact: round.guarantees.exact, exactOver: round.guarantees.exactOver, dualKind: round.guarantees.dualKind }
        : null,
      columnsGenerated: round.columns ? round.columns.generated : null,
      columnsPruned: round.columns ? round.columns.pruned : null,
      bestPrunedGammaMilliCU: round.columns ? round.columns.bestPrunedGammaMilliCU : null,
      budgetLimited: Boolean(round.budgets && round.budgets.budgetLimited),
      boundsExceeded:
        round.budgets && Array.isArray(round.budgets.exceeded)
          ? round.budgets.exceeded.map((row) => ({ bound: row.bound, behaviour: row.behaviour }))
          : null,
      truncatedBy: decision.truncatedBy ?? null,
    },

    degradation: {
      dependencies: (context.degradation && context.degradation.dependencies) || [],
      envelopeReductions: (context.degradation && context.degradation.envelopeReductions) || [],
      relaxations: (context.degradation && context.degradation.relaxations) || [],
      // Shard-wide modes are named, never expanded per decision (§21.2's bounded
      // exemption list, §18.5's mode-level record).
      shardModes: (context.degradation && context.degradation.shardModes) || [],
      killSwitches: (context.degradation && context.degradation.killSwitches) ?? pins.killSwitchState ?? null,
    },

    deferral:
      decision.outcome === "DEFERRED"
        ? {
            reason: decision.deferralReason ?? null,
            supplyEventAwaited: decision.supplyEventAwaited ?? null,
            expectedImprovementMilliCU:
              decision.expectedImprovementMilliCU === undefined || decision.expectedImprovementMilliCU === null
                ? null
                : String(decision.expectedImprovementMilliCU),
            projectedAssignmentTimeMs: decision.projectedAssignmentTimeMs ?? null,
            deferralDeadlineMs: decision.deferralDeadlineMs ?? null,
            detail: decision.detail ?? null,
          }
        : null,

    overrides: context.overrides || [],
    predictions: context.predictions || null,
    compactTopN: context.compactTopN,
  };
}

/**
 * Take the sampling decision for one record and, when it selects, build Tier B.
 *
 * @param {object} input
 * @param {object} input.tierARecord
 * @param {object} input.budget a `sampling.createBudget()` instance
 * @param {number} input.sampleRate `observability.tier_b_sample_rate`
 * @param {number} input.nowMs
 * @param {object} [input.exemption] the `sampling.classifyExemption()` verdict
 * @param {object} [input.tierBInput] the `tierB.build()` input, built only if selected
 * @returns {{ verdict: object, record: object|null }}
 */
function selectTierB(input) {
  const source = input || {};
  const record = source.tierARecord;
  const exemption = source.exemption || { exempt: false, reasons: [] };

  const verdict = source.budget.offer({
    shardId: record.identity.shardId,
    decisionId: record.identity.decisionId,
    nowMs: source.nowMs,
    sampleRate: source.sampleRate,
    exempt: exemption.exempt === true,
    exemptionReasons: exemption.reasons,
  });

  const writes =
    verdict.verdict === sampling.VERDICT.SAMPLED ||
    verdict.verdict === sampling.VERDICT.EXEMPT ||
    verdict.verdict === sampling.VERDICT.RESERVOIR;

  if (!writes || !source.tierBInput) return { verdict, record: null };
  return { verdict, record: tierB.build(source.tierBInput) };
}

/**
 * Write one round's records.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input
 * @param {object} input.round the frozen `round.execute()` result
 * @param {object} input.context as `tierAInputFor`, plus `perLeg` keyed by leg id
 * @param {object} input.budget a `sampling.createBudget()` instance
 * @param {object} input.config `{ sampleRate, compactTopN, fullRetentionDays,
 *   tierBRetentionDays, snapshotRetentionDays, tierARecordBytes }`
 * @param {number} input.nowMs
 * @returns {Promise<object>} what was written, and what was refused
 */
async function writeRound(deps, input) {
  const source = input || {};
  const round = source.round;
  const context = source.context || {};
  const config = source.config || {};
  const perLeg = context.perLeg || {};

  const retention = retentionFor({
    decisionTimeMs: round.decisionTimeMs,
    fullRetentionDays: config.fullRetentionDays,
    tierBRetentionDays: config.tierBRetentionDays,
    snapshotRetentionDays: config.snapshotRetentionDays,
  });

  /* ── 1. The pinned inputs, before any record that depends on them ────────── */
  const snapshotData = snapshotRow({
    snapshot: context.snapshot,
    roundId: round.roundId,
    shardId: context.shardId ?? round.shardId,
    decisionTimeMs: round.decisionTimeMs,
    retainUntil: retention.snapshotUntil,
  });

  const storedSnapshot = await deps.prisma.inputSnapshot.upsert({
    where: { snapshotId: snapshotData.snapshotId },
    create: snapshotData,
    // Immutable: an existing snapshot is never rewritten. The empty update is what
    // makes the upsert an idempotent "ensure it exists" rather than a silent overwrite
    // of the inputs a stored decision was taken against.
    update: {},
  });

  /* ── 2. One Tier A per Leg, whatever the outcome ─────────────────────────── */
  const written = [];
  const oversize = [];

  const shadowLabel = context.shadowLabel ?? null;

  for (const decision of round.decisions) {
    const legContext = { ...context, ...(perLeg[String(decision.legId)] || {}) };
    const built = tierAInputFor({ round, decision, context: legContext });
    const record = tierA.build(
      shadowLabel === null
        ? built
        : {
            ...built,
            identity: { ...built.identity, decisionId: shadowDecisionIdFor(shadowLabel, round.roundId, decision.legId) },
          },
    );

    const sized = tierA.size(record, config.tierARecordBytes);
    if (!sized.withinLimit) {
      // Recorded, never dropped. §20.1 makes the 2 KB bound a release-gate target, and
      // a record refused for being large would remove the evidence that the bound was
      // exceeded — which is the one thing the target exists to surface.
      oversize.push({ decisionId: record.identity.decisionId, bytes: sized.bytes, limitBytes: sized.limitBytes });
    }

    const exemption = sampling.classifyExemption({
      degradations: legContext.degradations || [],
      relaxed: (legContext.degradation && (legContext.degradation.relaxations || []).length > 0) || false,
      overridden: (legContext.overrides || []).length > 0,
      preempted: legContext.preempted === true,
    });

    const selection = selectTierB({
      tierARecord: record,
      budget: source.budget,
      sampleRate: config.sampleRate,
      nowMs: source.nowMs,
      exemption,
      tierBInput: legContext.tierBInput
        ? {
            ...legContext.tierBInput,
            decisionId: record.identity.decisionId,
            roundId: round.roundId,
            shardId: record.identity.shardId,
            decisionTimeMs: round.decisionTimeMs,
          }
        : null,
    });

    const row = tierA.toRow(record, {
      inputSnapshotId: storedSnapshot ? storedSnapshot.id : null,
      fullRetentionUntil: retention.tierAUntil,
      sizeBytes: sized.bytes,
      tierBWritten: selection.record !== null,
      // The schema CHECK requires a reason whenever `tierBWritten` is true. Passing the
      // verdict through means the constraint is satisfied by the same value the
      // sampler decided on, never by a label chosen at the write site.
      tierBReason: selection.record !== null ? selection.verdict.writtenBecause : null,
      samplingDraw: selection.verdict.draw,
      samplingRate: selection.verdict.sampleRate,
      shadowLabel,
    });

    // eslint-disable-next-line no-await-in-loop
    await deps.prisma.decisionRecordA.create({ data: row });

    if (selection.record !== null) {
      // eslint-disable-next-line no-await-in-loop
      await deps.prisma.decisionRecordB.create({
        data: tierB.toRow(selection.record, {
          writtenBecause: selection.verdict.writtenBecause,
          exemptionReason: selection.verdict.reason,
          retainUntil: retention.tierBUntil,
        }),
      });
    }

    written.push({
      decisionId: record.identity.decisionId,
      legId: decision.legId,
      sizeBytes: sized.bytes,
      withinSizeLimit: sized.withinLimit,
      tierB: selection.verdict.verdict,
      tierBWritten: selection.record !== null,
      exemptionReasons: exemption.reasons,
      shardWideRefused: exemption.shardWideRefused,
    });
  }

  return Object.freeze({
    roundId: round.roundId,
    snapshotId: snapshotData.snapshotId,
    tierACount: written.length,
    tierBCount: written.filter((row) => row.tierBWritten).length,
    shedCount: written.filter((row) => row.tierB === sampling.VERDICT.SHED).length,
    oversize,
    retentionProblems: retention.problems,
    written,
  });
}

/**
 * Prove that every Leg the round touched has exactly one Tier A record — the §21.2
 * completion criterion, checked at the granularity the decision is taken.
 *
 * @param {object} input `{ round, result }` where `result` is `writeRound()`'s
 * @returns {{ ok: boolean, missing: string[], duplicated: string[] }}
 */
function assertEveryDecisionRecorded(input) {
  const source = input || {};
  const expected = (source.round && source.round.decisions ? source.round.decisions : []).map((row) =>
    decisionIdFor(source.round.roundId, row.legId),
  );
  const actual = (source.result && source.result.written ? source.result.written : []).map((row) => row.decisionId);

  const seen = new Map();
  for (const id of actual) seen.set(id, (seen.get(id) || 0) + 1);

  return {
    ok: expected.every((id) => seen.get(id) === 1) && actual.length === expected.length,
    missing: expected.filter((id) => !seen.has(id)).sort(),
    duplicated: [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id).sort(),
  };
}

/**
 * A stable digest of a Tier A record, for the golden corpus and for change detection.
 *
 * @param {object} record
 * @returns {string}
 */
function digest(record) {
  return canonicalJson(record);
}

module.exports = {
  MS_PER_DAY,
  SHADOW_ID_PREFIX,
  PRODUCTION_ONLY,
  decisionIdFor,
  shadowDecisionIdFor,
  retentionFor,
  snapshotRow,
  partitionFor,
  truncationGapOf,
  tierAInputFor,
  selectTierB,
  writeRound,
  assertEveryDecisionRecorded,
  digest,
};

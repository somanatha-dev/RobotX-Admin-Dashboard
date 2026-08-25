"use strict";

/**
 * `GET /api/health/invariants` and `GET /api/health/modes` (§26, §18.5).
 *
 * ── Why the register needs a surface at all ─────────────────────────────────
 * §26.1 gives each status a response — `ENFORCED` is silence, `VIOLATED` is a page whose
 * SLI target is exactly zero, `SUSPENDED` is a counted, time-boxed event that is
 * deliberately *not* a page. Those responses are only actionable if an operator can see,
 * during an incident, which of the three each invariant is in **and why**. A register
 * whose contents are only visible in a metrics pipeline is a register the on-call engineer
 * reads for the first time while deciding whether to roll back.
 *
 * ── Read-only, and reading a stored verdict rather than re-running one ──────
 * Neither route runs a check. They read the `InvariantStatus` rows the worker persisted,
 * for two reasons that matter more than cost. A full pass is a table scan per invariant,
 * and putting that behind an HTTP request puts it on the availability path — the same
 * argument §3.4 makes for keeping the round path off the request path. And a status
 * computed per request would differ between two operators reloading the page during the
 * same incident, which is exactly when they need to be looking at the same thing.
 *
 * The response therefore states `checkedAt` per invariant and a `staleness` block up front:
 * a stored verdict is only as good as its age, and a surface that presented a ten-minute-old
 * `ENFORCED` as current would be the observability failure this phase exists to prevent.
 *
 * ── Every suspension names its mode, on the wire as well as in the table ────
 * §18.5 rule 2 and §26.1 both require it, and the API is where the requirement is actually
 * consumed: "I2 is SUSPENDED" is an alarming sentence on its own and an unremarkable one
 * next to "authorised by Custodial Operation, entered 4 minutes ago because the Commitment
 * Store is unavailable, time-boxed to 15".
 */

const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const modeRegister = require("../engine/degraded/modeRegister");
const invariantChecker = require("../engine/observability/invariantChecker");
const transitions = require("../engine/degraded/transitions");
const { INVARIANT_TIERS, TIER_NAMES } = require("../engine/guards/tierAssertions");
// PHASE 15 — the cutover posture and the worker registry, as operator surfaces.
const cutoverEnabled = require("../engine/cutover/enabled");
const cutoverGates = require("../engine/cutover/gates");
const cutoverStage = require("../engine/cutover/stage");
const workerRegistry = require("../workers/registry");

/** @structural the query parameter's default shard */
const DEFAULT_SHARD = "default";

/** @structural milliseconds per second */
const MS_PER_SECOND = 1000;

/**
 * @param {object} req
 * @returns {string}
 */
function shardOf(req) {
  return req.query && req.query.shard ? String(req.query.shard) : DEFAULT_SHARD;
}

/**
 * GET /api/health/invariants
 *
 * Per-invariant status, with the mode that authorised any suspension.
 */
const invariants = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const shardId = shardOf(req);
  const nowMs = Date.now();

  const [rows, openModes] = await Promise.all([
    prisma.invariantStatus.findMany({
      where: { shardId, subjectType: "SHARD" },
      orderBy: { invariantId: "asc" },
    }),
    transitions.openRows({ prisma }, shardId),
  ]);

  const activeModes = openModes.map((row) => row.mode);
  const byId = new Map(rows.map((row) => [row.invariantId, row]));

  // Driven by §26.1's register rather than by what happens to be in the table, so an
  // invariant the checker has never reported on appears as *unreported* rather than being
  // silently absent. "We have never checked this" and "this is fine" are different
  // sentences, and only one of them is reassuring.
  const invariantRows = modeRegister.INVARIANTS.map((invariantId) => {
    const stored = byId.get(invariantId) || null;
    const expected = modeRegister.resolveBehaviour(invariantId, activeModes);

    return {
      invariantId,
      status: stored ? stored.status : null,
      reported: Boolean(stored),
      checkedAt: stored ? stored.checkedAt : null,
      ageSeconds: stored ? Math.round((nowMs - new Date(stored.checkedAt).getTime()) / MS_PER_SECOND) : null,
      violationCount: stored ? stored.violationCount : null,
      // §26.1: "every suspension names the mode that authorised it".
      authorisingMode: stored ? stored.authorisingMode : null,
      instrument: stored ? stored.instrument : null,
      detail: stored ? stored.detail : null,
      // What §26.2 says this invariant's behaviour *should* be under the modes currently
      // open. Returned beside the observed status so a mismatch — a `VIOLATED` where the
      // matrix says `S`, which is the specific failure the plan's testing row names — is
      // visible on the wire rather than only in a test.
      expected: {
        behaviour: expected.status,
        authorisedBy: expected.authorisedBy,
        vacuous: expected.vacuous,
        note: expected.note,
      },
      matchesMatrix: stored ? matchesMatrix(stored.status, expected.status) : null,
      tier: invariantTierOf(invariantId),
    };
  });

  const violated = invariantRows.filter((row) => row.status === invariantChecker.STATUS.VIOLATED);
  const suspended = invariantRows.filter((row) => row.status === invariantChecker.STATUS.SUSPENDED);
  const unreported = invariantRows.filter((row) => row.reported === false);

  return res.json({
    shardId,
    section: "§26",
    activeModes,
    summary: {
      total: invariantRows.length,
      enforced: invariantRows.filter((row) => row.status === invariantChecker.STATUS.ENFORCED).length,
      violated: violated.length,
      suspended: suspended.length,
      unreported: unreported.length,
      // The SLI §26.1 gives a target of exactly zero — counted over `VIOLATED` rows **only**.
      //
      // A suspended check keeps its findings deliberately (`checkOne` retains them, because on
      // mode exit they are the reconciliation input §18.5 requires), so summing
      // `violationCount` across every row made this SLI non-zero for the whole of a Commitment
      // Store outage: I2 SUSPENDED, one row per expired lease, target zero. That is precisely
      // the "paging continuously for a condition the design already anticipates" §26.1 created
      // the third status to prevent, reintroduced one aggregation later.
      //
      // The suspended findings are still reported — under their own name, where they cannot be
      // mistaken for violations.
      invariantViolations: violated.reduce((sum, row) => sum + (row.violationCount || 0), 0),
      suspendedFindings: suspended.reduce((sum, row) => sum + (row.violationCount || 0), 0),
      // A register with unreported invariants is not a green register. Stated as its own
      // field so a dashboard cannot render "0 violated" as "all clear".
      complete: unreported.length === 0,
      matrixDisagreements: invariantRows.filter((row) => row.matchesMatrix === false).map((row) => row.invariantId),
    },
    invariants: invariantRows,
  });
});

/**
 * Does an observed status agree with §26.2's cell?
 *
 * `D` and `E` cells both expect the invariant to be *verified*, so either `ENFORCED` or
 * `VIOLATED` is a consistent observation — the matrix says whether verification happens,
 * not what it will find. An `S` cell expects `SUSPENDED` and nothing else, and observing a
 * `VIOLATED` where the matrix says `S` is the disagreement the plan's testing row calls out
 * by name.
 *
 * @param {string} observed
 * @param {string} expected a `modeRegister.BEHAVIOUR` value
 * @returns {boolean}
 */
function matchesMatrix(observed, expected) {
  if (expected === modeRegister.BEHAVIOUR.SUSPENDED) return observed === invariantChecker.STATUS.SUSPENDED;
  return observed === invariantChecker.STATUS.ENFORCED || observed === invariantChecker.STATUS.VIOLATED;
}

/**
 * The obligation tier an invariant belongs to (§1.8, §26.1), so an operator triaging a page
 * can tell a safety-core violation from an operational-integrity one without a lookup.
 *
 * @param {string} invariantId
 * @returns {number|null}
 */
function invariantTierOf(invariantId) {
  const tier = INVARIANT_TIERS[invariantId];
  return tier === undefined ? null : { tier, name: TIER_NAMES[tier] };
}

/**
 * GET /api/health/modes
 *
 * The shard's open degraded modes, their envelopes, their time boxes, and the register
 * itself — so an operator can see what a mode *would* do before one is entered.
 */
const modes = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const shardId = shardOf(req);
  const nowMs = Date.now();

  const open = await transitions.openRows({ prisma }, shardId);
  const recent = await prisma.degradedModeEvent.findMany({
    where: { shardId, exitedAt: { not: null } },
    orderBy: { exitedAt: "desc" },
    take: 20,
  });

  const openRows = open.map((row) => {
    const box = modeRegister.evaluateTimeBox(
      { mode: row.mode, timeBox: { expiresAtMs: row.timeBoxExpiresAt ? new Date(row.timeBoxExpiresAt).getTime() : null } },
      nowMs,
    );
    return {
      mode: row.mode,
      cause: row.cause,
      enteringComponent: row.enteringComponent,
      enteredAt: row.enteredAt,
      activeForMs: nowMs - new Date(row.enteredAt).getTime(),
      suspendedInvariants: row.suspendedInvariants,
      degradedInvariants: row.degradedInvariants,
      exitCriterion: row.exitCriterion,
      envelope: row.envelope,
      timeBox: {
        expiresAt: row.timeBoxExpiresAt,
        expired: box.expired,
        remainingMs: box.remainingMs,
        // §26.1: a suspension is "itself alertable if it persists beyond the mode's bound".
        alertable: box.alertable && (row.suspendedInvariants || []).length > 0,
        reason: box.reason,
      },
    };
  });

  return res.json({
    shardId,
    section: "§18.5",
    degraded: openRows.length > 0,
    // Read from the same durable rows every consumer reads. `engine:mode:{shard}` mirrors
    // this and is never its source (§3.3).
    authority: "DegradedModeEvent",
    open: openRows,
    commandsSuspended: modeRegister.commandsSuspended(openRows.map((row) => row.mode)),
    commitsSuspended: modeRegister.commitsSuspended(openRows.map((row) => row.mode)),
    recentlyExited: recent.map((row) => ({
      mode: row.mode,
      enteredAt: row.enteredAt,
      exitedAt: row.exitedAt,
      durationMs: row.durationMs,
      exitReason: row.exitReason,
      exitingComponent: row.exitingComponent,
      restoredInvariants: row.suspendedInvariants,
    })),
    // The register itself. §18.5's whole argument is that the modes are named in advance;
    // publishing them is what lets an operator read what Custodial Operation will do before
    // the Commitment Store fails rather than during.
    register: modeRegister.MODE_NAMES.map((mode) => {
      const declared = modeRegister.modeOf(mode);
      return {
        mode,
        section: declared.section,
        enteredWhen: declared.enteredWhen,
        entryTrigger: declared.entryTrigger,
        envelope: declared.envelope,
        suspendsInvariants: declared.suspendsInvariants,
        exitWhen: declared.exitWhen,
      };
    }),
  });
});

/**
 * GET /api/health/cutover — **PHASE 15**.
 *
 * Which shards the engine is the decision path for, in what order the rest are staged, and
 * which §24 release gates are green. Three facts that an operator currently has to
 * assemble from three places, and that during an incident they will assemble wrongly.
 *
 * ── Why the consequence is on the wire, not just the boolean ────────────────
 * After the cutover, `live: false` for a shard does **not** mean "the legacy dispatcher is
 * serving it" — the legacy path was removed from the build, not bypassed. That sentence is
 * the single most important thing this endpoint says, and it is said per shard, in words,
 * by `cutover/enabled.describe()`, because a reader who infers it from a `false` will infer
 * the pre-cutover meaning.
 *
 * ── Release-gate evidence is read, never asserted here ─────────────────────
 * The gate table is rendered with whatever evidence has been filed. A gate with no evidence
 * shows `NOT_EVALUATED`, which blocks exactly as `RED` does but is deliberately a different
 * word: "we ran the soak test and it failed" and "nobody ran the soak test" are not the
 * same fact and must not read the same at 3 a.m.
 */
const cutover = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const snapshot = req.app?.locals?.config || null;

  const shards = await prisma.shard.findMany({
    select: { shardId: true, regionId: true, state: true, agentCount: true },
  });

  const postures = shards.map((shard) => cutoverEnabled.describe({ snapshot, shard }));
  const liveShardIds = postures.filter((posture) => posture.live).map((posture) => posture.shardId);

  // Evidence is not manufactured here. Nothing in this process files release-gate
  // evidence, so the table renders as NOT_EVALUATED unless a caller supplies it — which is
  // the honest state and is what refuses a cutover in `stage.authoriseEnable`.
  //
  // ── This view is advisory, and says so ────────────────────────────────────
  // `docs/runbooks/cutover.md` prerequisite 2 points an operator here, so the one thing
  // this endpoint must never do is disagree with the authorisation it is standing in for.
  //
  // PHASE 15 remediation (P15-C1). This call used to pass **no context at all**, and the
  // comment here justified it: "a request handler holds neither [a source digest nor an age
  // bound] … omitting them can only make this view more permissive than the real decision,
  // never less."
  //
  // Half of that was wrong in each direction. A request handler does hold a clock and does
  // know the bound the release tooling uses, so two of the three were always available; and
  // omitting the source digest makes BUILD/SUITE records *inadmissible*, which is less
  // permissive, not more. What made the sentence worth re-reading is that this endpoint had
  // already named `"evidence age bound"` as one of the two things that make an evaluation
  // authoritative — while `evidence.admit()` enforced only the other one. The advisory view
  // named the gap that the authoritative path had.
  //
  // The correction is therefore in the honest direction rather than the convenient one:
  // `admit()` now refuses a record it cannot age, so an evidence-bearing call here renders
  // `RED [AGE_BOUND_REQUIRED]` instead of a silently unbounded `GREEN`. This view still does
  // not invent an age bound — how stale a soak may be is the release tooling's decision and
  // a register question, not a request handler's — and it still names what it did not check.
  // What has changed is that not checking it can no longer look like having checked it.
  const releaseEvidence = req.app?.locals?.releaseEvidence || {};
  const gateResult = cutoverGates.evaluate(releaseEvidence, { nowMs: Date.now() });

  return res.json({
    section: "execution plan, Phase 15",
    processEnabled: cutoverEnabled.processEnabled(),
    parameter: cutoverEnabled.PARAMETER,
    shards: postures,
    live: liveShardIds.length,
    total: shards.length,
    stagingPlan: cutoverStage.plan(shards),
    releaseGates: {
      /**
       * False by construction. The authoritative evaluation is the one
       * `stage.authoriseEnable()` performs at the moment of the cutover, with the source
       * digest and age bound this handler cannot supply.
       */
      authoritative: false,
      notCheckedHere: ["sourceDigest binding", "evidence age bound"],
      counts: gateResult.counts,
      // The same context as the count above. Evaluating the table twice under two different
      // contexts would let `counts` and `blocking` disagree about the same evidence.
      blocking: cutoverGates.blockers(releaseEvidence, { nowMs: Date.now() }).map((gate) => ({
        id: gate.id,
        status: gate.status,
        section: gate.section,
        evidence: gate.evidence,
        statement: gate.statement,
      })),
      all: gateResult.results,
    },
    workers: workerRegistry.report({ running: req.app?.locals?.engineWorkers?.running || [] }),
  });
});

module.exports = {
  invariants,
  modes,
  cutover,
  matchesMatrix,
};

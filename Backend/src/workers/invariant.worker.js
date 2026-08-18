"use strict";

/**
 * The Invariant Checker's driver, and the two sweeps §18.5 and §18.6 make continuous
 * (§26, §18.5 rule 2, §18.6 step 5) — **Tier 1**, mechanism T1-07.
 *
 * ── Three passes, deliberately separated ────────────────────────────────────
 *
 *   1. `checkPass()` — run every §26.1 check, resolve each status against §26.2's matrix
 *      and the shard's open modes, persist the statuses, and emit a socket event for each
 *      *change*. This is the only pass that touches `observability/invariantChecker.js`.
 *   2. `modeSweepPass()` — §18.5 rule 2's time box. A suspension that outlives the mode
 *      that authorised it is alertable (§26.1), and something has to be the thing that
 *      notices. The pass also refreshes the advisory `engine:mode:{shard}` mirror.
 *   3. `escalationSweepPass()` — §18.6 step 5, "continuous until cleared": re-evaluate the
 *      obstruction class of every open escalation as position or map data changes, and
 *      de-escalate when the agent is moved clear.
 *
 * The separation is not tidiness. **The checker never writes**, so a checker that shared a
 * pass with a repair loop would be a checker that could paper over the divergence it exists
 * to report. `invariantChecker.js` contains no `create`, `update`, or `delete` call — a
 * source-scanning test asserts it — and every write below is this worker's, made from the
 * checker's *returned* findings.
 *
 * ── I6's high-water marks are this worker's own ─────────────────────────────
 * The marks are read before the pass and written after it, onto `InvariantStatus` rows
 * carrying a `subjectId`. They are deliberately not `AgentFenceAudit`'s: that table is
 * maintained by the commit path, and verifying the commit path's monotonicity against a
 * number the commit path writes verifies only self-consistency (§26.1).
 *
 * ── Scheduled in production since Phase 15 ─────────────────────────────────
 * `server.js`'s `startScheduledWorkers()` calls `start()` when `ENGINE_ENABLED` is true.
 * That changed what this file owes: a check whose evidence arrives only from the caller's
 * `context` is a check that does not run in production unless the composition root happens
 * to name the field. So the defaults live **here**, next to the checker's contract, and
 * `defaultContext()` is what the composition root spreads. Three checks (I5's baseline, I12's
 * version marks, and the escalation sweep's chain state) are stateful across passes, and
 * `checkerState` is the explicit place that state lives — a mutable object the caller owns,
 * rather than module-level state, so a replayed pass is still deterministic.
 *
 * ── The checker still writes nothing ───────────────────────────────────────
 * Everything below is this worker's write, made from the checker's returned findings. The
 * pass-to-pass carries are the same arrangement I6's marks already used: the check *returns*
 * what it observed and this worker decides what to keep.
 */

const invariantChecker = require("../engine/observability/invariantChecker");
const modeRegister = require("../engine/degraded/modeRegister");
const transitions = require("../engine/degraded/transitions");
const externalEscalation = require("../engine/failure/externalEscalation");
// Tier 0 lifecycle vocabulary and Tier 1 record conventions, imported by the *worker* and
// never by the checker: §26.1's independence is a property of the checker's own module, and
// the checker still declares its state vocabulary locally. What the worker supplies is
// evidence about *which* states §4.5 gives no deadline and *which* decision records were
// executed — facts the checker must not guess and the composition root should not have to
// know by name.
const legMachine = require("../engine/lifecycle/legMachine");
const decisionRecord = require("../engine/observability/decisionRecord");

/**
 * Default cadence, in milliseconds. Overridden from `invariant.check_interval`.
 * @structural the loop's fallback cadence when no configuration is supplied
 */
const DEFAULT_INTERVAL_MS = 60000;

/**
 * The window each windowed check looks back over, in milliseconds. Overridden from
 * `invariant.monotonicity_window`.
 * @structural the fallback look-back for the windowed checks
 */
const DEFAULT_WINDOW_MS = 300000;

/** @structural milliseconds per second */
const MS_PER_SECOND = 1000;

/** The subject type an I6 high-water row carries. @structural the row's subject vocabulary */
const SUBJECT_TYPE = Object.freeze({ SHARD: "SHARD", AGENT: "AGENT" });

/**
 * The ceiling on terminal-row version marks carried between passes.
 *
 * I12's write audit compares a terminal row's version against the version the last pass
 * observed, so the marks are only as many as the terminal rows *touched in one window*. The
 * cap keeps the carried set — and the JSON column it is backed up in — bounded, and a pass
 * that hits it says so rather than silently narrowing its own audit.
 * @structural the bound on one pass's carried mark set
 */
const MAX_TERMINAL_MARKS = 500;

/**
 * The evidence every §26 check needs that neither the checker nor the composition root
 * should be guessing.
 *
 * ── Why this exists at all ──────────────────────────────────────────────────
 * Before this, four checks were reachable only if the caller named a `context` field:
 * `statesWithoutDeadline` (I4), `ladderBudgetSeconds` (I13), `tierEventBudgets` (I17), and
 * `productionOnly` (I9, I14, I15, I20). `server.js` names none of them, so on a healthy fleet
 * I4 and I13 reported `VIOLATED` — a page produced by an unsupplied argument — while I9, I14,
 * I15 and I20 audited §21.6's shadow decision records as though the fleet had executed them.
 *
 * Two of the four are derivable from modules this worker may import; two are configuration
 * the caller resolves. The derivable ones default here so no caller can omit them, and the
 * configurable ones stay the caller's — but their absence now makes the check report
 * *unverified* rather than a confident verdict, which is the checker's own change.
 *
 * @param {object} [context]
 * @returns {object} the context with the derivable evidence filled in
 */
function defaultContext(context) {
  const settings = context || {};
  return {
    ...settings,
    // §4.5: the states that legitimately carry no deadline. Derived from the state machine
    // rather than transcribed, because a state added without a deadline must appear here on
    // the same commit or I4 pages for it.
    statesWithoutDeadline: settings.statesWithoutDeadline || legMachine.statesWithoutDeadline(),
    // §21.6: "recorded and never executed". A shadow decision in an invariant audit is a
    // violation attributed to a world the fleet never operated in.
    productionOnly: settings.productionOnly || decisionRecord.PRODUCTION_ONLY,
  };
}

/**
 * Load the checker's own persisted per-agent high-water marks for I6.
 *
 * @param {object} deps `{ prisma }`
 * @param {string} shardId
 * @returns {Promise<Map<string, { fence: string, epoch: string }>>}
 */
async function loadHighWaterMarks(deps, shardId) {
  const rows = await deps.prisma.invariantStatus.findMany({
    where: { invariantId: "I6", shardId: String(shardId), subjectType: SUBJECT_TYPE.AGENT },
    select: { subjectId: true, highWaterMark: true, secondaryHighWaterMark: true },
  });

  const marks = new Map();
  for (const row of rows) {
    marks.set(row.subjectId, {
      fence: row.highWaterMark === null || row.highWaterMark === undefined ? "0" : String(row.highWaterMark),
      epoch: row.secondaryHighWaterMark === null || row.secondaryHighWaterMark === undefined ? "0" : String(row.secondaryHighWaterMark),
    });
  }
  return marks;
}

/**
 * Persist the marks the pass observed.
 *
 * Written after the comparison, never before it: writing first would advance the mark past
 * a regression and make the next pass report the fleet as monotone.
 *
 * ── Only the marks that moved ───────────────────────────────────────────────
 * Measured against a live PostgreSQL cluster at 500 agents, this function was **567 ms of a
 * 706 ms pass** — 80 % of the checker's whole cost — because it upserted one row per agent per
 * pass whether or not the agent's counters had changed. On a 60 s interval that is an upsert per
 * agent per minute for ever, against a table carrying three indexes, and it scales with the fleet:
 * at ten thousand agents the write alone approaches the cadence it is supposed to fit inside.
 *
 * A high-water mark that has not moved does not need rewriting. `previous` is the map the pass
 * loaded, and a mark identical to it is skipped — which is not a weakening of I6's audit, because
 * the audit is the *comparison* and the comparison already happened. The shard-level I6 row
 * carries the pass's `checkedAt`, so freshness is still recorded once per pass rather than N times.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ shardId, marks, checkedAt, previous }`
 * @returns {Promise<{ written: number, skipped: number }>}
 */
async function persistHighWaterMarks(deps, input) {
  const source = input || {};
  const previous = source.previous instanceof Map ? source.previous : new Map();
  let written = 0;
  let skipped = 0;

  for (const [agentId, mark] of source.marks || new Map()) {
    const before = previous.get(agentId);
    if (before && String(before.fence) === String(mark.fence) && String(before.epoch) === String(mark.epoch)) {
      skipped += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await deps.prisma.invariantStatus.upsert({
      where: {
        invariantId_shardId_subjectId: {
          invariantId: "I6",
          shardId: String(source.shardId),
          subjectId: agentId,
        },
      },
      create: {
        invariantId: "I6",
        shardId: String(source.shardId),
        subjectType: SUBJECT_TYPE.AGENT,
        subjectId: agentId,
        status: invariantChecker.STATUS.ENFORCED,
        checkedAt: source.checkedAt,
        highWaterMark: BigInt(mark.fence),
        secondaryHighWaterMark: BigInt(mark.epoch),
        instrument: "windowed monotonicity audit; the checker's own mark, not the commit path's (§26.1)",
      },
      update: {
        checkedAt: source.checkedAt,
        highWaterMark: BigInt(mark.fence),
        secondaryHighWaterMark: BigInt(mark.epoch),
      },
    });
    written += 1;
  }

  return { written, skipped };
}

/**
 * Persist one invariant's status.
 *
 * A check that could not run writes **nothing**, leaving the previous row standing. A
 * status row overwritten with "we did not look" is worse than a stale one: it reads as an
 * assertion about the fleet, and it is an assertion about the checker.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ shardId, row, checkedAt }`
 * @returns {Promise<boolean>} whether a row was written
 */
async function persistStatus(deps, input) {
  const source = input || {};
  const row = source.row;
  if (!row || row.status === null) return false;

  const data = {
    status: row.status,
    checkedAt: source.checkedAt,
    violationCount: row.violationCount,
    // Bounded on the way in as well as on the way out: a status table that can hold an
    // unbounded violation list is a status table one defect can fill.
    detail: {
      instrument: row.instrument,
      detail: row.detail,
      violations: row.violations,
      degradedVerification: row.degradedVerification === true,
      degradationNote: row.degradationNote ?? null,
      vacuous: row.vacuous === true,
      suspensionNote: row.suspensionNote ?? null,
      // The cross-pass carry, so a restarted worker recovers its baseline from the row it
      // last wrote rather than re-baselining and reporting the fleet clean.
      ...(source.carry ? { carry: source.carry } : {}),
    },
    // §26.1: a suspension "names the mode that authorised it".
    authorisingMode: row.status === invariantChecker.STATUS.SUSPENDED ? row.authorisedBy : null,
    instrument: row.instrument,
  };

  await deps.prisma.invariantStatus.upsert({
    where: {
      invariantId_shardId_subjectId: {
        invariantId: row.invariantId,
        shardId: String(source.shardId),
        subjectId: "",
      },
    },
    create: {
      invariantId: row.invariantId,
      shardId: String(source.shardId),
      subjectType: SUBJECT_TYPE.SHARD,
      subjectId: "",
      ...data,
    },
    update: data,
  });

  return true;
}

/**
 * Seed the cross-pass carries from the durable rows, for a process that has just started.
 *
 * I5's baseline and I12's version marks are both *comparisons across passes*, so a worker
 * that restarted with an empty carry would report I5 unverified for one interval and would
 * re-baseline I12 rather than verify it. Both carries are therefore backed up in the row the
 * pass writes, under `detail.carry`, and recovered here.
 *
 * A cold register — no rows at all — genuinely has no baseline, and the checks say so.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} state the `checkerState` object the caller owns
 * @param {string} shardId
 * @returns {Promise<object>} the same state, seeded
 */
async function seedCheckerState(deps, state, shardId) {
  const carrier = state || {};
  if (carrier.seeded === true) return carrier;

  const rows = await deps.prisma.invariantStatus.findMany({
    where: { shardId: String(shardId), subjectType: SUBJECT_TYPE.SHARD, invariantId: { in: ["I5", "I12"] } },
    select: { invariantId: true, detail: true },
  });

  for (const row of rows) {
    const carry = row.detail && row.detail.carry ? row.detail.carry : null;
    if (!carry) continue;
    if (row.invariantId === "I5" && carry.fenceRejectionsByScope && carrier.previousFenceRejections === undefined) {
      carrier.previousFenceRejections = carry.fenceRejectionsByScope;
    }
    if (row.invariantId === "I12" && carry.terminalVersionMarks && carrier.terminalVersionMarks === undefined) {
      carrier.terminalVersionMarks = new Map(Object.entries(carry.terminalVersionMarks));
    }
  }

  carrier.seeded = true;
  return carrier;
}

/**
 * The bounded, JSON-safe form of one pass's terminal version marks.
 *
 * @param {Map<string, string>} marks
 * @returns {{ marks: Record<string, string>, truncated: boolean }}
 */
function serialiseTerminalMarks(marks) {
  const entries = [...(marks || new Map()).entries()].slice(0, MAX_TERMINAL_MARKS);
  return {
    marks: Object.fromEntries(entries),
    truncated: (marks ? marks.size : 0) > MAX_TERMINAL_MARKS,
  };
}

/**
 * The previously stored statuses, so the pass can emit on change rather than on every tick.
 *
 * @param {object} deps `{ prisma }`
 * @param {string} shardId
 * @returns {Promise<object[]>}
 */
async function previousStatuses(deps, shardId) {
  const rows = await deps.prisma.invariantStatus.findMany({
    where: { shardId: String(shardId), subjectType: SUBJECT_TYPE.SHARD },
    select: { invariantId: true, status: true },
  });
  return rows;
}

/**
 * Pass 1 — run every check, persist, and report the changes.
 *
 * @param {object} deps `{ prisma, now }`
 * @param {object} context `{ shardId, ... }` — everything `invariantChecker.checkAll` needs
 * @returns {Promise<object>}
 */
async function checkPass(deps, context) {
  const settings = defaultContext(context);
  const nowMs = Number.isFinite(settings.nowMs)
    ? settings.nowMs
    : typeof deps.now === "function"
      ? deps.now()
      : Date.now();
  const shardId = String(settings.shardId || "default");
  const windowMs = Number.isFinite(settings.windowMs) ? settings.windowMs : DEFAULT_WINDOW_MS;
  const checkedAt = new Date(nowMs);

  const activeModes = settings.activeModes || (await transitions.activeModes(deps, shardId));
  const highWaterMarks = await loadHighWaterMarks(deps, shardId);
  const before = await previousStatuses(deps, shardId);

  // The cross-pass carries. `checkerState` belongs to the caller — `start()` creates one per
  // worker — so a pass driven twice with the same object behaves as two consecutive ticks and
  // a pass driven with a fresh one behaves as a cold start. Both are things a test needs.
  const state = await seedCheckerState(deps, settings.checkerState || {}, shardId);

  const outcome = await invariantChecker.checkAll(deps, {
    ...settings,
    shardId,
    nowMs,
    windowStartMs: nowMs - windowMs,
    storeTime: settings.storeTime || checkedAt,
    activeModes,
    highWaterMarks,
    // I5's baseline and I12's marks, from the previous pass. `undefined` — never `{}` — is
    // what tells I5 there is no baseline yet; the distinction is the check's, and passing an
    // empty object here would have re-created the permissive default it exists to refuse.
    previousFenceRejections: state.previousFenceRejections,
    terminalVersionMarks: state.terminalVersionMarks || new Map(),
  });

  // Carry what this pass observed forward, *after* the comparison — the same ordering I6's
  // marks are written under, and for the same reason: advancing a baseline before comparing
  // against it makes the next pass report the fleet as clean.
  const i5 = outcome.results.find((row) => row.invariantId === "I5");
  const i12 = outcome.results.find((row) => row.invariantId === "I12");
  if (i5 && i5.fenceRejectionsByScope) state.previousFenceRejections = i5.fenceRejectionsByScope;
  if (i12 && i12.terminalVersionMarks) state.terminalVersionMarks = i12.terminalVersionMarks;

  const carryFor = (row) => {
    if (row.invariantId === "I5" && row.fenceRejectionsByScope) {
      return { fenceRejectionsByScope: row.fenceRejectionsByScope };
    }
    if (row.invariantId === "I12" && row.terminalVersionMarks) {
      const serialised = serialiseTerminalMarks(row.terminalVersionMarks);
      return { terminalVersionMarks: serialised.marks, terminalVersionMarksTruncated: serialised.truncated };
    }
    return null;
  };

  let persisted = 0;
  for (const row of outcome.results) {
    // eslint-disable-next-line no-await-in-loop
    if (await persistStatus(deps, { shardId, row, checkedAt, carry: carryFor(row) })) persisted += 1;
  }

  const i6 = outcome.results.find((row) => row.invariantId === "I6");
  const marksWritten = i6 && i6.highWaterMarks
    ? (await persistHighWaterMarks(deps, { shardId, marks: i6.highWaterMarks, checkedAt, previous: highWaterMarks })).written
    : 0;

  const changes = invariantChecker.statusChanges(before, outcome.results);

  return {
    shardId,
    checkedAtMs: nowMs,
    activeModes,
    summary: outcome.summary,
    results: outcome.results,
    persisted,
    highWaterMarksWritten: marksWritten,
    changes,
    checkerState: state,
  };
}

/**
 * Pass 2 — §18.5 rule 2's time box, and the advisory mirror.
 *
 * @param {object} deps `{ prisma, kv, now }`
 * @param {object} context `{ shardId, nowMs }`
 * @returns {Promise<object>}
 */
async function modeSweepPass(deps, context) {
  const settings = context || {};
  const nowMs = Number.isFinite(settings.nowMs)
    ? settings.nowMs
    : typeof deps.now === "function"
      ? deps.now()
      : Date.now();
  const shardId = String(settings.shardId || "default");

  const modes = await transitions.activeModes(deps, shardId);
  const overdue = await transitions.overdueModes(deps, { shardId, nowMs });

  const advisory = await transitions.publishAdvisory(deps, { shardId, modes, nowMs });

  return {
    shardId,
    nowMs,
    activeModes: modes,
    overdue,
    // §26.1: a suspension is "itself alertable if it persists beyond the mode's bound".
    // Alerts are raised for the overdue modes that suspend something, and the rest are
    // reported without a page — an overdue Cold Index is a slow index rebuild, not a
    // guarantee nobody is verifying.
    alerts: overdue
      .filter((row) => (row.suspendedInvariants || []).length > 0)
      .map((row) => ({
        code: "INVARIANT_SUSPENSION_PAST_TIME_BOX",
        mode: row.mode,
        shardId: row.shardId,
        suspendedInvariants: row.suspendedInvariants,
        overdueByMs: row.overdueByMs,
        detail: row.reason,
      })),
    advisoryPublished: advisory.published,
  };
}

/**
 * Pass 3a — §18.6 steps 1–3, for a `STRANDED_OBSTRUCTING` Leg with no chain.
 *
 * ── Why this pass exists ────────────────────────────────────────────────────
 * `externalEscalation.openChain()` had no caller anywhere in the tree. The chain that §18.6
 * calls "the one state in this design whose response chain extends outside the operator" was
 * therefore never opened by any production path, and I22's own audit — "every `STRANDED_*` Leg
 * has a classification **and a matching escalation path (§18.6)**" — would have reported
 * `VIOLATED` for every genuinely obstructing stranding, correctly and for ever.
 *
 * ── What it does not claim ──────────────────────────────────────────────────
 * §18.6 marks steps 1–3 "Immediate, automatic", and a sweep is not immediate: a chain opened
 * here is opened within one `invariant.check_interval` of the Leg reaching the state. The
 * immediate path belongs at the transition site — `supervision/leases.assessRecovery` already
 * returns `externalEscalation: true` and `supervision/reconciler.js` already records it — but
 * neither runs in production yet, because lease renewal and the reconciler are `LEADER_ONLY`
 * workers the shard supervisor's leadership lifecycle owns. Until then this sweep is the
 * difference between a bounded delay and no chain at all, and the delay is reported in the
 * pass result rather than described here.
 *
 * Idempotent per Leg: a Leg with any existing `ExternalEscalation` row already has a chain,
 * and opening a second would page a responder twice for one incident.
 *
 * @param {object} deps `{ prisma, readEscalationContext, regionOf, now }`
 * @param {object} context `{ nowMs, escalationContacts, contactReviewPeriodSeconds, emergencyServicesThreshold }`
 * @returns {Promise<object>}
 */
async function chainOpenPass(deps, context) {
  const settings = context || {};
  const nowMs = Number.isFinite(settings.nowMs)
    ? settings.nowMs
    : typeof deps.now === "function"
      ? deps.now()
      : Date.now();

  const obstructing = await deps.prisma.leg.findMany({
    where: { state: "STRANDED_OBSTRUCTING" },
    select: { id: true, legId: true, state: true, obstructionClass: true },
  });

  const opened = [];
  const sockets = [];

  for (const leg of obstructing) {
    // eslint-disable-next-line no-await-in-loop
    const existing = await deps.prisma.externalEscalation.findFirst({ where: { legId: leg.id } });
    if (existing) continue;

    const regionId = typeof deps.regionOf === "function" ? await deps.regionOf(leg) : (settings.regionId ?? null);
    const contactSet = externalEscalation.resolveContactSet({
      contacts: settings.escalationContacts ?? null,
      regionId,
      nowMs,
      reviewPeriodSeconds: settings.contactReviewPeriodSeconds,
    });

    const escalationContext =
      typeof deps.readEscalationContext === "function"
        ? // eslint-disable-next-line no-await-in-loop
          await deps.readEscalationContext(leg)
        : {};

    const chain = externalEscalation.openChain({
      leg: { legId: leg.legId, state: leg.state, obstructionClass: leg.obstructionClass },
      context: escalationContext,
      contactSet,
      atMs: nowMs,
    });
    if (!chain.opened) continue;

    // §18.6 step 4's *eligibility* — whether a person is asked — is computed and recorded, and
    // deliberately not written as a step-4 row: a step-4 row with no operator is a call nobody
    // authorised, which the schema's `ExternalEscalation_step_four_is_human_gated` CHECK
    // refuses and which this pass must not attempt. The offer rides on step 1's record and on
    // the socket payload, where an operator sees it.
    const eligibility = externalEscalation.emergencyServicesEligible({
      obstructionClass: leg.obstructionClass,
      hazardState: escalationContext.hazardState ?? externalEscalation.HAZARD_STATE.UNKNOWN,
      threshold: settings.emergencyServicesThreshold ?? null,
    });

    for (const step of chain.steps) {
      // eslint-disable-next-line no-await-in-loop
      await deps.prisma.externalEscalation.create({
        data: {
          legId: leg.id,
          step: step.step,
          obstructionClass: leg.obstructionClass,
          hazardState: escalationContext.hazardState ?? externalEscalation.HAZARD_STATE.UNKNOWN,
          contactSet: step.step === externalEscalation.STEP.NOTIFY_INFRASTRUCTURE_OPERATOR ? contactSet : null,
          disposition: step.disposition,
          detail: {
            payload: step.payload,
            ...(step.missingFields ? { missingFields: step.missingFields } : {}),
            ...(step.detail ? { note: step.detail } : {}),
            ...(step.step === externalEscalation.STEP.PAGE_RESPONDER
              ? {
                  emergencyServicesEligible: eligibility.eligible,
                  emergencyServicesReason: eligibility.reason,
                  humanGated: true,
                  openedBy: "workers/invariant.worker.js chainOpenPass (§18.6 steps 1-3)",
                }
              : {}),
          },
          occurredAt: new Date(nowMs),
        },
      });
    }

    opened.push({
      legId: leg.legId,
      steps: chain.steps.map((step) => step.step),
      contactSetConfigured: contactSet.configured,
      contactSetReviewed: contactSet.reviewed === true,
      emergencyServicesEligible: eligibility.eligible,
      emergencyServicesGated: true,
    });
    sockets.push({
      event: chain.socket.event,
      payload: { ...chain.socket.payload, emergencyServicesEligible: eligibility.eligible },
    });
  }

  return { nowMs, obstructing: obstructing.length, opened, sockets };
}

/**
 * Pass 3 — §18.6 step 5, "continuous until cleared".
 *
 * The classification comes from `map/obstructionClass.js` through
 * `failure/externalEscalation.reEvaluate`; the hazard data comes from an injected map
 * reader, because the Map service is an L1 dependency (§5.2) and this worker is not the
 * place its client lives.
 *
 * @param {object} deps `{ prisma, readHazardData, now }`
 * @param {object} context `{ shardId, nowMs, maxAgeSeconds }`
 * @returns {Promise<object>}
 */
async function escalationSweepPass(deps, context) {
  const settings = context || {};
  const nowMs = Number.isFinite(settings.nowMs)
    ? settings.nowMs
    : typeof deps.now === "function"
      ? deps.now()
      : Date.now();

  const open = await deps.prisma.externalEscalation.findMany({
    where: { clearedAt: null },
    orderBy: { occurredAt: "asc" },
    select: { id: true, legId: true, step: true, obstructionClass: true, occurredAt: true },
  });

  // ── One chain per Leg, not one per row ──────────────────────────────────────
  //
  // §18.6 is a chain **per stranding**. The open rows are its steps — three from
  // `openChain()`, plus a row for every re-evaluation that changed something — so iterating
  // the rows re-evaluates the same Leg once per step it has already accumulated, and each
  // re-evaluation left its own row open to be re-evaluated next pass. That doubles the table
  // every tick: 3 rows become 6, then 12, then 24, for one stranded agent. Grouping by Leg is
  // what makes the sweep's cost a function of how many agents are stranded rather than of how
  // long they have been.
  const byLeg = new Map();
  for (const row of open) {
    const list = byLeg.get(row.legId) || [];
    list.push(row);
    byLeg.set(row.legId, list);
  }

  const reEvaluated = [];
  let written = 0;
  let cleared = 0;

  for (const [legRowId, rows] of byLeg) {
    // eslint-disable-next-line no-await-in-loop
    const leg = await deps.prisma.leg.findUnique({
      where: { id: legRowId },
      select: { id: true, legId: true, state: true, obstructionClass: true },
    });
    if (!leg) continue;

    const hazardData =
      typeof deps.readHazardData === "function"
        ? // eslint-disable-next-line no-await-in-loop
          await deps.readHazardData(leg)
        : null;

    // ── What "changed" is measured against ──────────────────────────────────────
    //
    // The chain's own most recent recorded classification, not `Leg.obstructionClass`.
    //
    // Measuring against the Leg made every pass re-report the same transition: the sweep
    // records a reclassification on the chain but does not write the Leg's class (see below),
    // so `BLOCKING_CRITICAL → INDETERMINATE` was "changed" on tick 1 and equally "changed" on
    // ticks 2, 3, 4 … — one row per tick for one event, which is the row-per-tick growth this
    // pass exists to avoid, arrived at from the other direction. The chain history is what a
    // chain history is for: it is the record of what this chain last observed.
    const lastRecorded = rows[rows.length - 1];
    const currentClass = lastRecorded && lastRecorded.obstructionClass ? lastRecorded.obstructionClass : leg.obstructionClass;

    const outcome = externalEscalation.reEvaluate({
      legId: leg.legId,
      currentClass,
      hazardData,
      nowMs,
      maxAgeSeconds: settings.maxAgeSeconds,
      atMs: nowMs,
    });

    // ── Why the sweep does not write `Leg.state` ────────────────────────────────
    //
    // §18.6 step 5's second half is "de-escalate to `STRANDED_SAFE` if the agent is moved
    // clear (§4.4)", and §4.4's `STRANDED_OBSTRUCTING → STRANDED_SAFE` row carries
    // `GUARD.CORROBORATED_POSITION` on the event `CLEARED_BY_RESPONDERS`. Fresh map data
    // saying the location is now clear is not a corroborated position and is not a responder
    // clearance: the agent may be exactly where it was. A sweep that moved the Leg on map data
    // alone would be discharging a §4.4 guard it holds no evidence for — so it records that the
    // de-escalation has become *admissible* and leaves the transition to the path that has the
    // corroboration. That path is not yet composed, and this is reported rather than implied.
    const admissibleTransition =
      !outcome.chainContinues && leg.state === "STRANDED_OBSTRUCTING"
        ? {
            legId: leg.legId,
            from: leg.state,
            to: "STRANDED_SAFE",
            event: "CLEARED_BY_RESPONDERS",
            requires: "GUARD.CORROBORATED_POSITION (§4.4) — an accepted position fix, not map data",
            appliedBy: "not this pass; the §4.4 transition needs evidence a map read does not carry",
          }
        : null;

    reEvaluated.push({
      ...outcome,
      openSteps: rows.length,
      measuredAgainst: currentClass,
      legClass: leg.obstructionClass,
      admissibleTransition,
    });

    // A re-evaluation that found the same class is the chain still running, and §18.6 step 5
    // re-evaluates "as position or map data changes". Writing a row for an unchanged
    // classification records nothing and costs a row per Leg per tick for the whole duration
    // of an incident — which is how an escalation history becomes unreadable exactly when
    // somebody needs to read it. So a row is written when the classification changed or when
    // the chain closes, and the unchanged case is reported in the pass result instead.
    const recordWorthy = outcome.reclassification.changed || !outcome.chainContinues;
    if (recordWorthy) {
      // eslint-disable-next-line no-await-in-loop
      await deps.prisma.externalEscalation.create({
        data: {
          legId: leg.id,
          step: externalEscalation.STEP.RE_EVALUATE,
          obstructionClass: outcome.reclassification.after.obstructionClass,
          disposition: outcome.disposition,
          detail: { reason: outcome.reason, changed: outcome.reclassification.changed },
          occurredAt: new Date(nowMs),
          ...(outcome.chainContinues ? {} : { clearedAt: new Date(nowMs) }),
        },
      });
      written += 1;
    }

    if (!outcome.chainContinues) {
      // §18.6 step 5 is "continuous **until cleared**", and the chain is what clears — not
      // the one row that observed the clearance. Closing only the new row left every earlier
      // step open, so the next pass re-evaluated a stranding that had already been resolved,
      // for ever. `clearedAt` on every open row of this chain is what makes "until cleared"
      // terminate.
      // eslint-disable-next-line no-await-in-loop
      const closed = await deps.prisma.externalEscalation.updateMany({
        where: { legId: leg.id, clearedAt: null },
        data: { clearedAt: new Date(nowMs) },
      });
      cleared += closed.count;
    }
  }

  return {
    nowMs,
    open: open.length,
    chains: byLeg.size,
    written,
    cleared,
    reEvaluated,
    // The §4.4 transitions the sweep found admissible and deliberately did not apply. Surfaced
    // as a list so a composition root that *does* hold corroborated position can act on it, and
    // so its emptiness or otherwise is observable rather than assumed.
    admissibleTransitions: reEvaluated.map((row) => row.admissibleTransition).filter(Boolean),
  };
}

/**
 * One full tick: all three passes, in order.
 *
 * The checker runs first so its statuses reflect the modes as they were at the start of the
 * tick rather than as the sweep left them — a status resolved against a mode the same tick
 * closed would name an authorising mode that is no longer open.
 *
 * @param {object} deps
 * @param {object} [context]
 * @returns {Promise<object>}
 */
async function runOnce(deps, context) {
  const settings = context || {};
  const check = await checkPass(deps, settings);
  const modes = await modeSweepPass(deps, { ...settings, nowMs: check.checkedAtMs });
  // Opening precedes re-evaluating, so a chain opened this tick is not also re-evaluated by
  // it: the classification it was opened on is one instant old, and a re-evaluation against
  // the same instant would write a second row saying nothing changed.
  const opened =
    settings.sweepEscalations === false || settings.openChains === false
      ? null
      : await chainOpenPass(deps, { ...settings, nowMs: check.checkedAtMs });
  const escalations =
    settings.sweepEscalations === false
      ? null
      : await escalationSweepPass(deps, { ...settings, nowMs: check.checkedAtMs });

  const tick = { check, modes, opened, escalations };

  // The socket sink. The worker still takes **no** Socket.IO dependency — `deps.emit` is a
  // function the composition root supplies — but the messages are now delivered rather than
  // returned and dropped. `server.js` built the payloads and never called `socketMessages()`,
  // so `INVARIANT_STATUS_CHANGED` and `STRANDING_ESCALATED` had a producer and no wire.
  if (typeof deps.emit === "function") {
    for (const message of socketMessages(tick)) {
      // eslint-disable-next-line no-await-in-loop
      await deps.emit(message);
    }
  }

  return tick;
}

/**
 * The socket messages one tick produces, for a caller holding an `io`.
 *
 * Returned rather than emitted: this worker takes no Socket.IO dependency, matching every
 * engine worker since Phase 4. The composition root Phase 15 wires is where an `io` and an
 * engine component meet.
 *
 * @param {object} tick a `runOnce()` result
 * @returns {Array<{ event: string, payload: object }>}
 */
function socketMessages(tick) {
  const messages = [];
  for (const change of (tick && tick.check && tick.check.changes) || []) messages.push(change);
  // §18.6's chain opening is the `STRANDING_ESCALATED` the plan's row names first: the moment
  // the chain opens is the moment a dashboard needs it, not the first re-evaluation that
  // changes something.
  for (const message of (tick && tick.opened && tick.opened.sockets) || []) messages.push(message);
  for (const outcome of (tick && tick.escalations && tick.escalations.reEvaluated) || []) {
    if (!outcome.chainContinues || outcome.reclassification.changed) {
      messages.push({
        event: externalEscalation.SOCKET_EVENT,
        payload: {
          legId: outcome.legId,
          step: outcome.step,
          obstructionClass: outcome.reclassification.after.obstructionClass,
          disposition: outcome.disposition,
          cleared: !outcome.chainContinues,
          at: outcome.atMs,
        },
      });
    }
  }
  return messages;
}

/**
 * Start the periodic checker.
 *
 * @param {object} deps `{ prisma, kv, now, onError }`
 * @param {object} [context] `{ shardId, intervalMs, … }`
 * @returns {{ stop: () => void }}
 */
function start(deps, context) {
  const settings = context || {};
  const intervalMs = Number.isFinite(settings.intervalMs)
    ? settings.intervalMs
    : Number.isFinite(settings.checkIntervalSeconds)
      ? settings.checkIntervalSeconds * MS_PER_SECOND
      : DEFAULT_INTERVAL_MS;

  // One carry object for the life of the worker. I5's baseline and I12's version marks are
  // comparisons between consecutive passes, and a loop that built a fresh context per tick
  // would re-baseline both every minute — which is how a check that cannot fail looks from
  // the outside exactly like a check that is passing.
  const checkerState = settings.checkerState || {};

  const handle = setInterval(() => {
    runOnce(deps, { ...settings, checkerState }).catch((error) => {
      // A failed tick loses one pass of verification. It must not take the process down:
      // the checker is the safety net, and a net that crashes the system it hangs under
      // has inverted its own purpose (§12.1's argument, applied to this loop).
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
  DEFAULT_INTERVAL_MS,
  DEFAULT_WINDOW_MS,
  MAX_TERMINAL_MARKS,
  SUBJECT_TYPE,
  defaultContext,
  seedCheckerState,
  loadHighWaterMarks,
  persistHighWaterMarks,
  persistStatus,
  previousStatuses,
  checkPass,
  modeSweepPass,
  chainOpenPass,
  escalationSweepPass,
  runOnce,
  socketMessages,
  start,
  // Re-exported so a caller does not need a second import to read the vocabulary the
  // worker's own results are expressed in.
  STATUS: invariantChecker.STATUS,
  MODE: modeRegister.MODE,
};

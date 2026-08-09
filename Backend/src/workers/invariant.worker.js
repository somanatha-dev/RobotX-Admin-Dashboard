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
 * ── Built, tested, and not started ─────────────────────────────────────────
 * Nothing in `server.js` calls `start()`. Phase 15 owns production scheduling — the
 * disposition every engine worker since Phase 4 has carried.
 */

const invariantChecker = require("../engine/observability/invariantChecker");
const modeRegister = require("../engine/degraded/modeRegister");
const transitions = require("../engine/degraded/transitions");
const externalEscalation = require("../engine/failure/externalEscalation");

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
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ shardId, marks, checkedAt }`
 * @returns {Promise<{ written: number }>}
 */
async function persistHighWaterMarks(deps, input) {
  const source = input || {};
  let written = 0;

  for (const [agentId, mark] of source.marks || new Map()) {
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

  return { written };
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
  const settings = context || {};
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

  const outcome = await invariantChecker.checkAll(deps, {
    ...settings,
    shardId,
    nowMs,
    windowStartMs: nowMs - windowMs,
    storeTime: settings.storeTime || checkedAt,
    activeModes,
    highWaterMarks,
  });

  let persisted = 0;
  for (const row of outcome.results) {
    // eslint-disable-next-line no-await-in-loop
    if (await persistStatus(deps, { shardId, row, checkedAt })) persisted += 1;
  }

  const i6 = outcome.results.find((row) => row.invariantId === "I6");
  const marksWritten = i6 && i6.highWaterMarks
    ? (await persistHighWaterMarks(deps, { shardId, marks: i6.highWaterMarks, checkedAt })).written
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
    select: { id: true, legId: true, step: true, obstructionClass: true },
  });

  const reEvaluated = [];
  for (const row of open) {
    // eslint-disable-next-line no-await-in-loop
    const leg = await deps.prisma.leg.findUnique({
      where: { id: row.legId },
      select: { id: true, legId: true, state: true, obstructionClass: true },
    });
    if (!leg) continue;

    const hazardData =
      typeof deps.readHazardData === "function"
        ? // eslint-disable-next-line no-await-in-loop
          await deps.readHazardData(leg)
        : null;

    const outcome = externalEscalation.reEvaluate({
      legId: leg.legId,
      currentClass: leg.obstructionClass,
      hazardData,
      nowMs,
      maxAgeSeconds: settings.maxAgeSeconds,
      atMs: nowMs,
    });

    reEvaluated.push(outcome);

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
  }

  return { nowMs, open: open.length, reEvaluated };
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
  const escalations =
    settings.sweepEscalations === false
      ? null
      : await escalationSweepPass(deps, { ...settings, nowMs: check.checkedAtMs });

  return { check, modes, escalations };
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

  const handle = setInterval(() => {
    runOnce(deps, settings).catch((error) => {
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
  SUBJECT_TYPE,
  loadHighWaterMarks,
  persistHighWaterMarks,
  persistStatus,
  previousStatuses,
  checkPass,
  modeSweepPass,
  escalationSweepPass,
  runOnce,
  socketMessages,
  start,
  // Re-exported so a caller does not need a second import to read the vocabulary the
  // worker's own results are expressed in.
  STATUS: invariantChecker.STATUS,
  MODE: modeRegister.MODE,
};

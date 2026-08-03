"use strict";

/**
 * `GET /api/legs/:legId/supervision` — the operator visibility the plan names for
 * Phase 5: *"current state, deadline, owning timer"*.
 *
 * ── Why this endpoint exists at all ─────────────────────────────────────────
 * §4.5 makes every non-terminal state carry a durable timer, and §12.1 explains what
 * that is for: no state may persist because nobody owns its progression. An operator
 * looking at a Leg that seems stuck needs to answer one question — *what is supposed to
 * happen next, and when* — and before this endpoint that answer lived only in a database
 * nobody on call queries by hand. A supervision mechanism whose state cannot be read is
 * one operators learn to distrust, and a distrusted mechanism gets worked around.
 *
 * ── It reads; it never repairs ──────────────────────────────────────────────
 * An operator endpoint that could *fire* a timer, or force a transition, would be a
 * command path outside the outbox and outside the §4.4 guards — precisely what §4.1
 * rule 5 forbids and what §23.6's manual-override discipline governs. Repairs go through
 * the reconciler; this shows what the reconciler and the timer worker are going to do.
 *
 * ── Engine-owned data, read through the legacy auth surface ─────────────────
 * The route sits behind the same `authUser` middleware every other `/api` route uses, so
 * it inherits the existing authentication and authorisation rather than inventing a
 * second one (§23.4).
 */

const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const legMachine = require("../engine/lifecycle/legMachine");
const timers = require("../engine/supervision/timers");

/**
 * Shape one timer for the response. BigInt is rendered as a decimal string, for the same
 * reason the dispatch envelope does it: JSON has no BigInt, and a silent coercion to
 * Number would appear to work for every version anyone would write by hand.
 *
 * @param {object} timer
 * @returns {object}
 */
function presentTimer(timer) {
  return {
    timerKey: timer.timerKey,
    state: timer.state,
    entityVersion: String(timer.entityVersion),
    dueAt: timer.dueAt,
    handler: timer.handler,
    timerState: timer.timerState,
    attempts: timer.attempts,
    firedAt: timer.firedAt,
    resolvedAt: timer.resolvedAt,
    lastOutcome: timer.lastOutcome,
  };
}

/**
 * GET /api/legs/:legId/supervision
 *
 * `legId` is the **business** identifier (`Leg.legId`), not the row id: it is what a
 * decision record, an offer payload, and an operator's incident notes all carry.
 */
const getSupervision = asyncHandler(async (req, res) => {
  const prisma = getPrisma();
  const legId = String(req.params.legId || "");

  const leg = await prisma.leg.findUnique({ where: { legId } });
  if (!leg) {
    return res.status(404).json({ error: "Leg not found", legId });
  }

  const allTimers = await prisma.timer.findMany({
    where: { entityType: timers.ENTITY_TYPE.LEG, entityId: leg.id },
    orderBy: { dueAt: "asc" },
  });

  const pending = allTimers.filter((timer) => timer.timerState === timers.TIMER_STATE.PENDING);

  // The **owning** timer is the pending one keyed on the Leg's *current* version. A
  // pending timer on an older version is not supervising this state — it will be
  // discarded when it fires (§4.5) — and presenting it as the owner would tell an
  // operator that a state was supervised when it was not.
  const owning =
    pending.find((timer) => BigInt(timer.entityVersion) === BigInt(leg.version) && timer.state === leg.state) || null;

  const deadline = legMachine.deadlineFor(leg.state);
  const terminal = legMachine.isTerminal(leg.state);

  return res.json({
    legId: leg.legId,
    missionId: leg.missionId,
    purpose: leg.purpose,
    state: leg.state,
    custodyState: leg.custodyState,
    version: leg.version,
    obstructionClass: leg.obstructionClass,
    cancelRequestedAt: leg.cancelRequestedAt,
    startNotBefore: leg.startNotBefore,
    slaDeadline: leg.slaDeadline,

    supervision: {
      terminal,
      // §4.3's own deadline column for this state, so an operator sees which parameter
      // governs it and can look up its owner in the register (§22).
      deadline: deadline
        ? { parameter: deadline.parameter, onExpiry: deadline.onExpiry, projected: deadline.projected === true }
        : null,
      // The one §4.5 obligation, answered directly: is this state supervised right now?
      supervised: terminal ? null : Boolean(owning),
      owningTimer: owning ? presentTimer(owning) : null,
      // Timers pending on a superseded version. Ordinarily present and ordinarily
      // harmless — §4.5's whole point is that they are discarded on fire — and shown
      // because an operator reading "supervised: false" needs to see whether the reason
      // is "no timer" or "a timer for a version that has moved on".
      staleTimers: pending.filter((timer) => timer !== owning).map(presentTimer),
      history: allTimers
        .filter((timer) => timer.timerState !== timers.TIMER_STATE.PENDING)
        .map(presentTimer),
    },
  });
});

module.exports = { getSupervision, presentTimer };

"use strict";

/**
 * Degraded-mode entry and exit (§18.5) — **Tier 0**, mechanism T0-11.
 *
 * `modeRegister.js` declares *what* the six modes are and what each does to each
 * invariant. This module performs the transition: it opens and closes the durable
 * `DegradedModeEvent` row, refuses an exit whose criterion has not been met, and produces
 * the three side-channel payloads a transition owes — the audit event (§18.5 rule 1), the
 * advisory Redis broadcast, and the dashboard socket event.
 *
 * ── The durable row is the authority; Redis is a hint ───────────────────────
 * §3.3's assignment of roles is not suspended by the thing it describes. The
 * `DegradedModeEvent` stream is where a shard's mode history lives, and
 * `engine:mode:{shard}` is an advisory mirror for readers that would otherwise poll the
 * database on every request. `publishAdvisory()` therefore returns rather than throws on
 * a cache failure — losing the mirror costs visibility, never correctness — and nothing
 * in this module ever *reads* the mode back from the cache to decide anything.
 *
 * That restraint is rule 3 applied to this module's own implementation. A mode register
 * that cached its own state and then trusted the cache would have promoted the cache tier
 * to an authority in the course of implementing the rule that forbids it.
 *
 * ── Entry is idempotent per (shard, mode) ───────────────────────────────────
 * A shard already in Custodial Operation that observes a second Commitment Store failure
 * has not entered a second mode; it is still in the first. `enter()` therefore returns the
 * open row unchanged rather than opening another, and the partial unique index on
 * `(shardId, mode) WHERE "exitedAt" IS NULL` is the schema's backstop for the same
 * property. Two open rows for one mode would make "time spent in each mode" — an SLI —
 * double-count, and would leave an exit closing an arbitrary one of them.
 *
 * ── Several modes can be open at once ───────────────────────────────────────
 * A routing outage during an overload is not a novel condition, and §26.2's matrix is
 * written per mode rather than per *combination* precisely so the resolution rule can be
 * stated once. `activeModes()` returns the set; `modeRegister.resolveBehaviour()` resolves
 * a status across it.
 *
 * ── Custodial Operation's exit is two-step, and the second step is the point ─
 * > **On recovery**, the shard runs a full reconciliation before resuming rounds […]
 * > Only then is I2 restored to `ENFORCED`.
 *
 * `exit()` refuses a Custodial Operation exit whose evidence does not include a completed
 * reconciliation, and `mayResumeRounds()` is the query the coordinator asks before its
 * first round back. A mode that exited on "the store answered a health check" would
 * restore I2 while the divergence the outage created was still unreconciled — which is
 * exactly the window in which a mission that exceeded its autonomy limit is still
 * unaccounted for.
 *
 * ── No clock ────────────────────────────────────────────────────────────────
 * Time is supplied. A transition is an event with a recorded time, and a module that read
 * its own clock would make the record disagree with the round that observed the failure.
 */

const modeRegister = require("./modeRegister");

/**
 * The dashboard-facing socket events this phase adds (§18.5, plan row "Socket.IO
 * changes"). Declared here as the contract rather than as string literals at the emit
 * site, so the Frontend's contract and the emitter cannot drift.
 * @structural the wire event names
 */
const SOCKET_EVENT = Object.freeze({
  ENTERED: "DEGRADED_MODE_ENTERED",
  EXITED: "DEGRADED_MODE_EXITED",
});

/** The advisory key §18.5's plan row reserves. @structural the cache key shape */
const ADVISORY_KEY_PREFIX = "engine:mode:";

/**
 * TTL on the advisory mirror, in seconds.
 *
 * Short enough that a coordinator that died holding a mode does not leave a stale
 * "we are degraded" banner up indefinitely, and long enough that a reader between
 * refreshes sees the mode rather than a gap. Its expiry costs a database read, which is
 * the whole reason a cached value is permitted to expire at all (§3.3).
 * @structural the advisory mirror's refresh horizon, not a behavioural threshold
 */
const ADVISORY_TTL_SECONDS = 120;

/**
 * The key one shard's advisory mode broadcast lands on.
 *
 * @param {string} shardId
 * @returns {string}
 */
function advisoryKey(shardId) {
  return `${ADVISORY_KEY_PREFIX}${String(shardId)}`;
}

/**
 * The open (un-exited) mode rows for a shard.
 *
 * @param {object} deps `{ prisma }`
 * @param {string} shardId
 * @returns {Promise<object[]>}
 */
async function openRows(deps, shardId) {
  return deps.prisma.degradedModeEvent.findMany({
    where: { shardId: String(shardId), exitedAt: null },
    orderBy: { enteredAt: "asc" },
  });
}

/**
 * The names of the modes a shard is currently in.
 *
 * @param {object} deps `{ prisma }`
 * @param {string} shardId
 * @returns {Promise<string[]>}
 */
async function activeModes(deps, shardId) {
  const rows = await openRows(deps, shardId);
  return rows.map((row) => row.mode);
}

/**
 * Enter a mode.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input as `modeRegister.entryEvent()`
 * @returns {Promise<{ entered: boolean, alreadyOpen: boolean, row: object, event: object }>}
 */
async function enter(deps, input) {
  const source = input || {};
  const event = modeRegister.entryEvent(source);

  const existing = await deps.prisma.degradedModeEvent.findFirst({
    where: { shardId: event.shardId, mode: event.mode, exitedAt: null },
  });

  if (existing) {
    // Not an error and not a second entry. The shard is already in this mode; the second
    // observation is corroboration, and re-opening would double-count the SLI.
    return { entered: false, alreadyOpen: true, row: existing, event };
  }

  const row = await deps.prisma.degradedModeEvent.create({
    data: {
      shardId: event.shardId,
      mode: event.mode,
      cause: event.cause,
      enteringComponent: event.enteringComponent,
      suspendedInvariants: event.suspendedInvariants,
      degradedInvariants: event.degradedInvariants,
      enteredAt: new Date(event.enteredAtMs),
      timeBoxExpiresAt: event.timeBox.expiresAtMs === null ? null : new Date(event.timeBox.expiresAtMs),
      exitCriterion: event.exitWhen,
      envelope: event.envelope,
      detail: event.detail,
    },
  });

  return { entered: true, alreadyOpen: false, row, event };
}

/**
 * §18.5's exit criteria, as a gate over the evidence a caller supplies.
 *
 * Every mode's criterion is checked, not only Custodial Operation's, because "exit when
 * the condition clears" is a criterion too and an exit taken while the condition holds is
 * a shard that will re-enter within the minute — flapping, which reads to an operator as
 * noise rather than as the two real transitions it is.
 *
 * @param {string} mode
 * @param {object} evidence
 * @returns {{ ok: boolean, reason: string }}
 */
function exitCriterionMet(mode, evidence) {
  const declared = modeRegister.modeOf(mode);
  const source = evidence || {};

  switch (declared.name) {
    case modeRegister.MODE.CUSTODIAL_OPERATION:
      // The two-step exit. Both halves, never either.
      if (source.storeAvailable !== true) {
        return { ok: false, reason: "the Commitment Store has not returned (§18.3 B1)" };
      }
      if (source.reconciliationComplete !== true) {
        return {
          ok: false,
          reason:
            "the store has returned but full reconciliation has not completed. §18.5: agent-reported " +
            "commitment sets are compared against the store, custody is audited, and any mission that " +
            "exceeded its autonomy limit is routed through the ordinary recovery path (§4.7). " +
            "**Only then** is I2 restored to ENFORCED.",
        };
      }
      return { ok: true, reason: "the store returned and full reconciliation completed" };

    case modeRegister.MODE.UNSUPERVISED_COMMITMENT:
      if (source.timerStoreAvailable !== true) {
        return { ok: false, reason: "the timer store has not recovered (§18.3 B4)" };
      }
      if (source.timerStateCrossAuditClean !== true) {
        return {
          ok: false,
          reason:
            "the timer store recovered but the timer/state cross-audit is not clean. §18.5 requires both, " +
            "because a recovered store with missing timers is I4 still unverifiable.",
        };
      }
      return { ok: true, reason: "the timer store recovered and the cross-audit is clean" };

    case modeRegister.MODE.RESTRICTED_OPERATION:
      // §7.4 step 4 / §18.5: recovery **or** an operator acknowledgement past the box.
      if (source.indeterminacyRecovered === true) {
        return { ok: true, reason: "the indeterminate fraction recovered below the threshold (§7.4)" };
      }
      if (source.operatorAcknowledged === true) {
        return {
          ok: true,
          reason: "degraded.max_duration elapsed and an operator acknowledged continuation (§7.4 step 4)",
        };
      }
      return {
        ok: false,
        reason: "neither the indeterminate fraction has recovered nor has an operator acknowledged",
      };

    case modeRegister.MODE.DEGRADED_ROUTING:
      return source.routingAvailable === true
        ? { ok: true, reason: "the Routing Service recovered" }
        : { ok: false, reason: "the Routing Service has not recovered (§18.3 B5/B6)" };

    case modeRegister.MODE.COLD_INDEX:
      return source.indexRebuilt === true
        ? { ok: true, reason: "the availability index was rebuilt from the observation log" }
        : { ok: false, reason: "the index has not finished rebuilding from the observation log (§18.3 B3)" };

    case modeRegister.MODE.SHED_LOAD:
      return source.queueDelayWithinBudget === true
        ? { ok: true, reason: "queue delay returned within budget" }
        : { ok: false, reason: "queue delay is still outside budget (§18.3 B19, §20.5)" };

    default:
      // Unreachable: `modeOf` throws on an unregistered name. Present because an exit
      // that fell through to "permitted" would be the one default worth never having.
      return { ok: false, reason: `no exit criterion is defined for ${declared.name}` };
  }
}

/**
 * Exit a mode, if its criterion is met.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ shardId, mode, atMs, evidence, exitingComponent }`
 * @returns {Promise<{ exited: boolean, reason: string, row: object|null, event: object|null }>}
 */
async function exit(deps, input) {
  const source = input || {};
  const mode = modeRegister.modeOf(source.mode).name;

  const row = await deps.prisma.degradedModeEvent.findFirst({
    where: { shardId: String(source.shardId), mode, exitedAt: null },
  });

  if (!row) {
    return { exited: false, reason: `${mode} is not open on shard ${source.shardId}`, row: null, event: null };
  }

  const criterion = exitCriterionMet(mode, source.evidence);
  if (!criterion.ok) {
    return { exited: false, reason: criterion.reason, row, event: null };
  }

  const event = modeRegister.exitEvent({
    entry: { ...row, enteredAtMs: row.enteredAt instanceof Date ? row.enteredAt.getTime() : null },
    atMs: source.atMs,
    reason: criterion.reason,
    exitingComponent: source.exitingComponent,
  });

  const updated = await deps.prisma.degradedModeEvent.updateMany({
    where: { id: row.id, exitedAt: null },
    data: {
      exitedAt: new Date(event.exitedAtMs),
      exitReason: event.reason,
      exitingComponent: event.exitingComponent,
      durationMs: event.durationMs,
    },
  });

  if (updated.count !== 1) {
    // Another writer closed it first. Reported rather than retried: the mode is closed,
    // which is the outcome that was wanted, and a second close would produce a second
    // exit event for one entry.
    return { exited: false, reason: "another writer closed this mode first", row, event: null };
  }

  return { exited: true, reason: criterion.reason, row, event };
}

/**
 * §18.5's Custodial Operation recovery gate, as a query the coordinator asks before its
 * first round back.
 *
 * > **On recovery**, the shard runs a full reconciliation **before resuming rounds**.
 *
 * @param {object} deps `{ prisma }`
 * @param {string} shardId
 * @returns {Promise<{ mayResume: boolean, blockedBy: string[], reason: string|null }>}
 */
async function mayResumeRounds(deps, shardId) {
  const open = await activeModes(deps, shardId);
  const blocking = open.filter((mode) => modeRegister.modeOf(mode).envelope.noCommits === true);

  if (blocking.length === 0) {
    return { mayResume: true, blockedBy: [], reason: null };
  }

  return {
    mayResume: false,
    blockedBy: blocking,
    reason:
      `${blocking.join(", ")} is still open. §18.5 requires a full reconciliation to complete before rounds ` +
      "resume; the mode closes when that reconciliation has run, and not when the store answers a health check.",
  };
}

/**
 * Modes whose time box has expired, for the periodic alertable-suspension sweep.
 *
 * §26.1: a suspension is "explicit, authorised by a named mode, scoped to specific
 * invariants, time-boxed, **and itself alertable if it persists beyond the mode's
 * bound**". This is the query behind that last clause.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ shardId, nowMs }`
 * @returns {Promise<object[]>}
 */
async function overdueModes(deps, input) {
  const source = input || {};
  const rows = await openRows(deps, source.shardId);
  const overdue = [];

  for (const row of rows) {
    const box = modeRegister.evaluateTimeBox(
      {
        mode: row.mode,
        timeBox: {
          expiresAtMs: row.timeBoxExpiresAt instanceof Date ? row.timeBoxExpiresAt.getTime() : null,
        },
      },
      source.nowMs,
    );
    if (box.expired) {
      overdue.push({
        id: row.id,
        shardId: row.shardId,
        mode: row.mode,
        enteredAt: row.enteredAt,
        suspendedInvariants: row.suspendedInvariants,
        overdueByMs: box.remainingMs === null ? null : -box.remainingMs,
        alertable: box.alertable,
        reason: box.reason,
      });
    }
  }

  return overdue;
}

/**
 * The advisory broadcast payload — what a reader needs without a database round trip.
 *
 * Deliberately not the whole envelope: a reader that needed the envelope needs the
 * authority, and a mirror rich enough to make decisions from is a mirror somebody will
 * make decisions from.
 *
 * @param {object} input `{ shardId, modes, nowMs }`
 * @returns {object}
 */
function advisoryPayload(input) {
  const source = input || {};
  const modes = Array.isArray(source.modes) ? source.modes : [];
  return {
    shardId: String(source.shardId),
    modes,
    degraded: modes.length > 0,
    suspendedInvariants: [
      ...new Set(modes.flatMap((mode) => [...modeRegister.suspensionsFor(mode)])),
    ].sort(),
    commandsSuspended: modeRegister.commandsSuspended(modes).suspended,
    commitsSuspended: modeRegister.commitsSuspended(modes).suspended,
    at: Number.isFinite(source.nowMs) ? source.nowMs : null,
    authority: "DegradedModeEvent — this mirror is advisory (§3.3)",
  };
}

/**
 * Mirror a shard's mode set to `engine:mode:{shard}`.
 *
 * @param {object} deps `{ kv }`
 * @param {object} input as `advisoryPayload`
 * @returns {Promise<{ published: boolean, detail: string|null }>}
 */
async function publishAdvisory(deps, input) {
  if (!deps || !deps.kv || typeof deps.kv.set !== "function") {
    return { published: false, detail: "no advisory cache configured" };
  }
  const payload = advisoryPayload(input);
  try {
    await deps.kv.set(advisoryKey(payload.shardId), JSON.stringify(payload), { ex: ADVISORY_TTL_SECONDS });
    return { published: true, detail: null };
  } catch (error) {
    // A failed mirror costs visibility and never correctness: every consumer that must be
    // right reads the durable row.
    return { published: false, detail: `advisory publish failed: ${error && error.message}` };
  }
}

/**
 * The dashboard socket payload for an entry or an exit.
 *
 * @param {object} event an `entryEvent()` or `exitEvent()` payload
 * @returns {{ event: string, payload: object }}
 */
function socketMessage(event) {
  const isEntry = Object.prototype.hasOwnProperty.call(event || {}, "enteredAtMs");
  return {
    event: isEntry ? SOCKET_EVENT.ENTERED : SOCKET_EVENT.EXITED,
    payload: isEntry
      ? {
          shardId: event.shardId,
          mode: event.mode,
          cause: event.cause,
          enteringComponent: event.enteringComponent,
          suspendedInvariants: event.suspendedInvariants,
          degradedInvariants: event.degradedInvariants,
          timeBoxExpiresAt: event.timeBox.expiresAtMs,
          exitWhen: event.exitWhen,
          at: event.enteredAtMs,
        }
      : {
          shardId: event.shardId,
          mode: event.mode,
          reason: event.reason,
          exitingComponent: event.exitingComponent,
          durationMs: event.durationMs,
          restoredInvariants: event.restoredInvariants,
          at: event.exitedAtMs,
        },
  };
}

module.exports = {
  SOCKET_EVENT,
  ADVISORY_KEY_PREFIX,
  ADVISORY_TTL_SECONDS,
  advisoryKey,
  openRows,
  activeModes,
  enter,
  exit,
  exitCriterionMet,
  mayResumeRounds,
  overdueModes,
  advisoryPayload,
  publishAdvisory,
  socketMessage,
};

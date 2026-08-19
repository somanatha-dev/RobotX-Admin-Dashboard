"use strict";

/**
 * The certificate rotation and revocation checker (§23.2), and the identity-store
 * retention sweep (§23.7).
 *
 * The plan's Phase 14 row names one background worker — *"Certificate rotation/revocation
 * checker (at session establishment **and** periodically during long sessions)"* — and
 * this is it. The parenthesis is the reason it exists: session establishment is a
 * handler's job and `sessionBinding.establish()` does it there, but "periodically during
 * long sessions" has no handler to hang from. A unit that connects once and stays
 * connected for three weeks never re-authenticates, so without a periodic sweep its
 * revocation takes effect at the next power cycle — which is to say, not at all.
 *
 * Three passes, in this order and for these reasons:
 *
 *   1. **Revocation.** Every live session whose `nextRevocationCheckAtMs` has passed is
 *      re-assessed against the store. A session whose certificate is now revoked,
 *      expired, or missing is **terminated**, and the termination is a security event.
 *      First, because it is the pass whose delay has a security cost.
 *   2. **Rotation.** Certificates within `security.certificate_rotation_lead_time` of
 *      expiry are reported for reissue. The worker does **not** mint certificates: that
 *      is the CA's job and a control-plane operation, and a fleet service that could
 *      issue its own device identities would be a fleet service that an attacker who
 *      reached it could issue device identities from.
 *   3. **Identity retention (§23.7).** Identity records past
 *      `privacy.identity_retention` are tombstoned through the same `erasure.apply()` the
 *      operator-facing request uses. Two paths to one behaviour would eventually erase
 *      different things.
 *
 * ── The verdicts are returned, never applied to a socket here ───────────────
 * `sweepRevocations()` returns the list of sessions to terminate and the caller closes
 * them. A worker that reached into the socket layer would be a worker that cannot be
 * tested without one, and — more importantly — the socket that must be closed may be
 * owned by a different process, which is a fact only the caller with the Socket.IO
 * adapter knows.
 *
 * ── Built, tested, and not started ─────────────────────────────────────────
 * `server.js` starts this worker only when `ENGINE_ENABLED` is true — the disposition
 * every engine worker since Phase 4 has carried, and the one Phase 15 stages.
 *
 * Tier 1 by path (`src/workers/`).
 */

const sessionBinding = require("../engine/security/sessionBinding");
const erasure = require("../engine/privacy/erasure");
// PHASE 14 remediation (P14-R6) — §23.6's override-rate design signal.
const override = require("../engine/security/override");

/**
 * How often the worker ticks. Deliberately **not** the revocation interval itself: the
 * interval is per session and is compared against each binding's own
 * `nextRevocationCheckAtMs`, so the tick only has to be frequent enough not to add
 * material delay to it. One minute keeps the added latency small against the 900 s
 * default without waking a large fleet's worth of reads every few seconds.
 * @structural the sweep cadence; the per-session interval is the registered parameter
 */
const TICK_INTERVAL_MS = 60_000;

/**
 * How many sessions one revocation pass examines. A bound rather than the whole fleet,
 * so a large deployment's pass is a series of short queries instead of one long one.
 * @structural a page size, not a threshold
 */
const REVOCATION_BATCH = 500;

/**
 * Re-check the sessions that are due, and report the ones to terminate.
 *
 * @param {object} deps `{ prisma, sessions }` — `sessions` yields live bindings, which is
 *   the socket layer's knowledge, injected rather than reached for
 * @param {object} input `{ now, recheckIntervalSeconds, batch }`
 * @returns {Promise<{ examined: number, terminate: object[], renewed: object[] }>}
 */
async function sweepRevocations(deps, input) {
  const source = input || {};
  const now = source.now instanceof Date ? source.now : new Date();
  const batch = Number.isFinite(source.batch) ? source.batch : REVOCATION_BATCH;

  const live = typeof deps.sessions === "function" ? await deps.sessions({ now, limit: batch }) : [];
  const due = live.filter((binding) => sessionBinding.dueForRecheck(binding, now)).slice(0, batch);

  const terminate = [];
  const renewed = [];

  for (const binding of due) {
    // eslint-disable-next-line no-await-in-loop
    const result = await sessionBinding.recheck(deps, binding, { now, recheckIntervalSeconds: source.recheckIntervalSeconds });
    if (result.action === "TERMINATE") {
      terminate.push({
        agentId: binding.agentId,
        sessionId: binding.sessionId,
        fingerprint: binding.fingerprint,
        refusal: result.refusal,
        securityEvent: result.refusal === sessionBinding.REFUSAL.CERTIFICATE_REVOKED,
        detail:
          "a live session's certificate no longer passes §23.2's checks. Terminating it here is the 'and periodically " +
          "during long sessions' half of the rule: an establishment-only check would let this session run until the " +
          "device next power-cycled.",
      });
      continue;
    }
    renewed.push(result.binding);
  }

  // The store's own record of when each certificate was last examined. A column rather
  // than a metric, because the question an auditor asks is about one certificate.
  for (const binding of renewed) {
    // eslint-disable-next-line no-await-in-loop
    await deps.prisma.agentCertificate.updateMany({
      where: { fingerprint: binding.fingerprint },
      data: { lastCheckedAt: now },
    });
  }

  return { examined: due.length, terminate, renewed };
}

/**
 * Report the certificates approaching expiry.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ now, leadTimeSeconds, take }`
 * @returns {Promise<{ due: object[], note: string }>}
 */
async function sweepRotations(deps, input) {
  const source = input || {};
  const now = source.now instanceof Date ? source.now : new Date();

  const due = await sessionBinding.dueForRotation(deps, {
    nowMs: now.getTime(),
    leadTimeSeconds: source.leadTimeSeconds,
    take: source.take,
  });

  return {
    due,
    note:
      "these certificates are inside security.certificate_rotation_lead_time of expiry and are reported for reissue. " +
      "This worker does not mint certificates: issuing device identities is the CA's job, and a fleet service able to " +
      "issue its own would be one an attacker who reached it could issue identities from (§23.2).",
  };
}

/**
 * Tombstone identity records whose own, shorter retention has expired (§23.7).
 *
 * @param {object} deps `{ prisma, audit }`
 * @param {object} input `{ now, take }`
 * @returns {Promise<object>}
 */
async function sweepIdentityRetention(deps, input) {
  const source = input || {};
  const now = source.now instanceof Date ? source.now : new Date();

  return erasure.apply(deps, {
    by: erasure.REQUEST_BY.RETENTION,
    reason:
      "privacy.identity_retention elapsed. §23.7 requires retention limits for identifying fields that are distinct " +
      "from — and shorter than — the operational retention of the decision's technical content.",
    nowMs: now.getTime(),
    take: source.take,
    at: now,
  });
}

/**
 * §23.6 — override rates per operator and per predicate, evaluated as a **design signal**.
 *
 * ── Why this pass exists — PHASE 14 remediation (P14-R6) ────────────────────
 * §23.6's fifth row is "Override rates are monitored per operator and per predicate", and
 * the plan's Phase 14 checklist repeats it as its own item. `security/override.js` has
 * always had `rates()` and `breaches()`, correctly shaped and unit-tested — and until this
 * remediation **nothing in the repository called either of them.** The three registered
 * parameters they read (`security.override_rate_window` and the two thresholds) had no
 * consumer, so the monitoring half of the rule was a pure function nobody ran.
 *
 * It lives here because this worker is already Phase 14's periodic security-and-privacy
 * pass — §23.2's revocation sweep and §23.7's retention sweep — and because a rate over a
 * window is a periodic evaluation by nature. It has the tick, the store, and the
 * registered parameters in hand; a fourth place with all three would be a fourth place to
 * keep in step.
 *
 * ── Why the finding is *reported* and nothing is done to the operator ───────
 * > A high rate is a signal that a constraint is miscalibrated or that an operator needs
 * > support — both actionable, neither punitive by default.
 *
 * The pass therefore returns findings and lets the caller surface them. It takes no action
 * against an actor, it does not restrict anyone's authority, and it writes nothing back:
 * a monitor that quietly narrowed a role would be exactly the punitive default §23.6
 * refuses.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ now, windowSeconds, perOperator, perPredicate, take }`
 * @returns {Promise<{ measured: object, breaches: object, windowFrom: Date|null }>}
 */
async function sweepOverrideRates(deps, input) {
  const source = input || {};
  const now = source.now instanceof Date ? source.now : new Date();

  if (!deps || !deps.prisma || !deps.prisma.overrideAudit) {
    return { measured: override.rates([]), breaches: { ok: true, findings: [] }, windowFrom: null };
  }

  /** @structural milliseconds per second */
  const MS_PER_SECOND = 1000;
  // An unset window means "no window", and the honest evaluation of a rate with no window
  // is none at all — not "all of history", which would make the count grow without bound
  // and cross any threshold eventually.
  if (!Number.isFinite(source.windowSeconds) || Number(source.windowSeconds) <= 0) {
    return { measured: override.rates([]), breaches: { ok: true, findings: [] }, windowFrom: null };
  }
  const windowFrom = new Date(now.getTime() - Number(source.windowSeconds) * MS_PER_SECOND);

  const events = await deps.prisma.overrideAudit.findMany({
    where: { recordedAt: { gte: windowFrom, lte: now } },
    select: { actorId: true, actionClass: true, predicateId: true, granted: true },
    /** @structural a page size, not a threshold */
    take: Number.isFinite(source.take) ? source.take : 5000,
  });

  const measured = override.rates(events);
  return {
    measured,
    breaches: override.breaches(measured, { perOperator: source.perOperator, perPredicate: source.perPredicate }),
    windowFrom,
  };
}

/**
 * One tick: all four passes.
 *
 * @param {object} deps
 * @param {object} [context]
 * @returns {Promise<object>}
 */
async function tick(deps, context) {
  const settings = context || {};
  const now = settings.now instanceof Date ? settings.now : new Date();

  const revocations = await sweepRevocations(deps, {
    now,
    recheckIntervalSeconds: settings.recheckIntervalSeconds,
    batch: settings.revocationBatch,
  });
  const rotations = await sweepRotations(deps, { now, leadTimeSeconds: settings.rotationLeadTimeSeconds, take: settings.rotationBatch });
  const retention = await sweepIdentityRetention(deps, { now, take: settings.retentionBatch });
  const overrides = await sweepOverrideRates(deps, {
    now,
    windowSeconds: settings.overrideRateWindowSeconds,
    perOperator: settings.overrideRateThresholdPerOperator,
    perPredicate: settings.overrideRateThresholdPerPredicate,
  });

  return {
    at: now,
    terminated: revocations.terminate.length,
    terminate: revocations.terminate,
    examined: revocations.examined,
    rotationsDue: rotations.due.length,
    identityRecordsErased: retention.erased ?? 0,
    overrideRates: overrides.measured,
    overrideRateFindings: overrides.breaches.findings,
  };
}

/**
 * Start the periodic sweep.
 *
 * @param {object} deps as `tick`, plus `onError` and an optional `onTerminate`
 * @param {object} [context]
 * @returns {{ stop: () => void }}
 */
function start(deps, context) {
  const settings = context || {};
  const intervalMs = Number.isFinite(settings.intervalMs) ? settings.intervalMs : TICK_INTERVAL_MS;

  const handle = setInterval(() => {
    tick(deps, settings)
      .then((result) => {
        if (result.terminate.length > 0 && typeof deps.onTerminate === "function") deps.onTerminate(result.terminate);
        // §23.6's design signal, surfaced rather than acted on (P14-R6).
        if (result.overrideRateFindings.length > 0 && typeof deps.onOverrideRateFinding === "function") {
          deps.onOverrideRateFinding(result.overrideRateFindings);
        }
      })
      .catch((error) => {
        // A failed sweep delays a revocation by one tick; it never grants one. The next
        // tick re-examines the same sessions, because `nextRevocationCheckAtMs` is only
        // advanced by a check that succeeded.
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
  TICK_INTERVAL_MS,
  REVOCATION_BATCH,
  sweepRevocations,
  sweepRotations,
  sweepIdentityRetention,
  sweepOverrideRates,
  tick,
  start,
};

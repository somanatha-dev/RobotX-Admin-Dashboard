"use strict";

/**
 * RBAC — platform-administration changes (accounts, campus assignments, the campus → region
 * link) committed together with their audit event, or not at all.
 *
 * The event lands on the hash-chained `AuditEvent` stream (§21.7) as an OPERATOR_ACTION, the
 * type the stream already defines for operator actions; `payload.action` names which one.
 * Appending inside the same transaction is what makes "the account exists" imply "its
 * creation is on the record". Two concurrent appends collide on the chain's
 * `(streamId, sequence)` index, which aborts the transaction; the whole unit is retried from
 * the start, so a retry re-reads both the data and the chain tail.
 *
 * Never put a password, hash, token or PIN in `payload`.
 */

const auditStream = require("../engine/observability/auditStream");

const MAX_ATTEMPTS = 3;

class AuditCollision extends Error {}

/**
 * @param {object} prisma
 * @param {(tx: object) => Promise<{ result: *, event: object }>} work returns the result and
 *   the audit event: `{ actorId, actorRole, subjectType, subjectId, reason?, payload }`
 * @returns {Promise<*>} the result
 */
async function withAudit(prisma, work) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const { result, event } = await work(tx);
        const appended = await auditStream.append(
          { prisma: tx },
          {
            eventType: auditStream.EVENT_TYPE.OPERATOR_ACTION,
            actorId: event.actorId,
            actorRole: event.actorRole,
            subjectType: event.subjectType,
            subjectId: event.subjectId,
            reason: event.reason ?? null,
            payload: event.payload,
            recordedAtMs: Date.now(),
          },
        );
        if (!appended.ok) throw new AuditCollision("audit chain tail moved; retrying");
        return result;
      });
    } catch (error) {
      lastError = error;
      if (!(error instanceof AuditCollision)) throw error;
    }
  }
  const err = new Error("The change could not be recorded on the audit stream; nothing was changed. Retry.");
  err.status = 503;
  err.cause = lastError;
  throw err;
}

module.exports = { withAudit, AuditCollision };

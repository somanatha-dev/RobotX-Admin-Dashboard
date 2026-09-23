"use strict";

/**
 * §12.2 commitment-lease renewal from an agent's **commitment-scoped heartbeat**.
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 * `supervision/leases.renew` existed and **had no caller**. Every commitment was granted a
 * `lease.duration` (60 s) lease at commit and nothing ever extended it, so any mission
 * longer than one lease — every campus delivery at a robot's walking pace — expired
 * mid-drive, went to REASSIGNING and was re-offered while the first agent was still
 * carrying it (measured on the V1 demonstration path, 2026-09-23).
 *
 * §12.2 names the evidence and `leases.renew` checks it: a heartbeat that **names the
 * commitment and its fence**. A bare ping proves the link, not the mission, and renews
 * nothing. The agent's own heartbeat carries `{ commitmentId, fence }` while it holds an
 * accepted mission (the simulator does; the physical RobotX must send the same).
 *
 * Renewal is attempted only once half the lease has elapsed, so a 2 s heartbeat does not
 * become a 2 s write; the lease is still extended well before it can lapse.
 */

const leases = require("../engine/supervision/leases");
const clock = require("../engine/commitment/clock");

const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;

/**
 * @param {object} input
 * @param {object} input.prisma
 * @param {string} input.robotId the authenticated socket's robot code (`Agent.agentId`)
 * @param {{ commitmentId?: string, fence?: string|number }} input.evidence the heartbeat body
 * @param {object} input.snapshot the pinned configuration (`lease.duration`)
 * @returns {Promise<{ renewed: boolean, reason: string|null }>}
 */
async function renewFromHeartbeat(input) {
  const { prisma, robotId, evidence, snapshot } = input || {};
  if (!prisma || !isNonEmptyString(robotId)) return { renewed: false, reason: "NO_AGENT" };
  if (!evidence || !isNonEmptyString(evidence.commitmentId)) return { renewed: false, reason: "UNSCOPED_HEARTBEAT" };

  let leaseDurationSeconds;
  try {
    leaseDurationSeconds = snapshot && typeof snapshot.resolve === "function" ? snapshot.resolve("lease.duration", {}) : undefined;
  } catch {
    leaseDurationSeconds = undefined;
  }
  if (!Number.isFinite(leaseDurationSeconds) || leaseDurationSeconds <= 0) {
    return { renewed: false, reason: "LEASE_DURATION_UNRESOLVED" };
  }

  const agent = await prisma.agent.findUnique({ where: { agentId: robotId }, select: { id: true } });
  if (!agent) return { renewed: false, reason: "NO_AGENT" };

  return prisma.$transaction(async (tx) => {
    const commitment = await tx.commitment.findUnique({ where: { commitmentId: evidence.commitmentId } });
    // Another agent's commitment is never renewed on this agent's word.
    if (!commitment || commitment.agentId !== agent.id) return { renewed: false, reason: "NOT_THIS_AGENTS_COMMITMENT" };

    const storeTime = await clock.readStoreTime(tx);
    const remainingMs = commitment.leaseExpiry ? new Date(commitment.leaseExpiry).getTime() - storeTime.getTime() : 0;
    if (remainingMs > (leaseDurationSeconds * 1000) / 2) return { renewed: false, reason: "NOT_DUE" };

    const outcome = await leases.renew(tx, {
      commitment,
      evidence: { commitmentId: evidence.commitmentId, fence: evidence.fence },
      storeTime,
      leaseDurationSeconds,
    });
    return { renewed: outcome.outcome === leases.RENEWAL_OUTCOME.RENEWED, reason: outcome.reason || null };
  });
}

module.exports = { renewFromHeartbeat };

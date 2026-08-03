/**
 * Offer responses from the agent (§11.2) — `OFFER_ACCEPT`, `OFFER_REJECT`,
 * `OFFER_DEFER`.
 *
 * > Dispatch is an **offer**, and the agent MUST respond. This is the second
 * > structural gap: the baseline has no `TASK_REJECT` event, so an agent cannot
 * > decline, and the one deferral it can perform — holding an assignment while
 * > charging — is invisible to the server, leaving the task `ASSIGNED` for up to half
 * > an hour with no signal, timeout, or alert.
 *
 * ── Inert until the engine is on ────────────────────────────────────────────
 * These events only ever arrive in answer to an `OFFER`, and an `OFFER` only ever
 * exists as an outbox row written by a commit. With `ENGINE_ENABLED` false no commit
 * runs, so this handler is registered and never fires. The switch is still checked
 * first, because "it cannot happen" is not a reason to leave a write path open — the
 * whole point of the Phase 0 master switch is that the engine is provably inert until
 * Phase 15 turns it on per shard.
 *
 * ── Every response is a transaction ─────────────────────────────────────────
 * Each disposition releases a commitment, moves a Leg, or renews a lease — and the
 * Leg write is conditional on the Leg's own version (§4.1 rule 2). Doing that outside
 * a transaction would let a response and a concurrent reconciler repair interleave into
 * a state neither intended.
 */

const { toStringOrNull } = require("../../utils/parse");
const { allow } = require("../rateLimit");
const { z } = require("zod");

const clockModule = require("../../engine/commitment/clock");
const observation = require("../../engine/domain/observation");
const offers = require("../../engine/dispatch/offers");

/** Requests per window, mirroring the other agent-facing handlers' posture. */
const RESPONSE_RATE = Object.freeze({ limit: 30, windowMs: 60_000, minIntervalMs: 50 });

const responseSchema = z
  .object({
    commitmentId: z.string().min(1),
    fence: z.union([z.string(), z.number()]),
    reason: z.string().optional().nullable(),
    until: z.union([z.string(), z.number()]).optional().nullable(),
  })
  .passthrough();

function engineEnabled() {
  return process.env.ENGINE_ENABLED === "true";
}

/**
 * Resolve the Agent row backing a robot socket.
 *
 * A socket authenticates as a `Robot` (the legacy identity); the engine reasons about
 * an `Agent`. Phase 2's backfill made the projection 1:1 through `Agent.agentId`, so
 * the lookup is by that column — and an absent Agent row means this robot has not been
 * projected, which is a reason to ignore the response rather than to invent one.
 *
 * @param {object} prisma
 * @param {string} robotId
 * @returns {Promise<object|null>}
 */
async function resolveAgent(prisma, robotId) {
  if (!robotId) return null;
  return prisma.agent.findUnique({ where: { agentId: robotId } });
}

function registerOfferHandlers(io, socket, { prisma, kv, logger, config } = {}) {
  const log = logger || console;
  const settings = config || {};

  /**
   * The shared preamble: authenticate, resolve, match the response against the offer
   * the engine actually made, and lock the rows the disposition will write.
   *
   * @param {string} event
   * @param {object} payload
   * @param {(tx: object, context: object) => Promise<object>} apply
   */
  async function handle(event, payload, apply) {
    try {
      if (!engineEnabled()) return;
      if (!allow(socket, event, RESPONSE_RATE)) return;
      if (!socket.data?.isAuthed) return;

      const parsed = responseSchema.safeParse(payload || {});
      if (!parsed.success) {
        log.warn(`${event} rejected — malformed payload`, { robotId: socket.data?.robotId });
        return;
      }

      const robotId = toStringOrNull(socket.data.robotId);
      const agent = await resolveAgent(prisma, robotId);
      if (!agent) return;

      const result = await prisma.$transaction(async (tx) => {
        const storeTime = await clockModule.readStoreTime(tx);

        const matched = await offers.matchResponse(tx, {
          commitmentId: parsed.data.commitmentId,
          fence: parsed.data.fence,
          agentId: agent.id,
        });
        if (!matched.ok) {
          return { outcome: offers.OUTCOME.IGNORED, reason: matched.reason };
        }

        const leg = await tx.leg.findUnique({ where: { id: matched.commitment.legId } });
        if (!leg) return { outcome: offers.OUTCOME.IGNORED, reason: "LEG_NOT_FOUND" };

        return apply(tx, { agent, commitment: matched.commitment, leg, storeTime, data: parsed.data });
      });

      if (result.outcome === offers.OUTCOME.APPLIED) {
        // The dashboard is the only listener; robots have no reason to receive it.
        io.to("dashboard").emit("OFFER_RESPONSE", {
          robotId,
          commitmentId: parsed.data.commitmentId,
          response: event,
          legState: result.legState || null,
        });
      }

      log.info(`${event} handled`, {
        robotId,
        commitmentId: parsed.data.commitmentId,
        outcome: result.outcome,
        reason: result.reason || null,
      });
    } catch (e) {
      log.error(`${event} handler failed`, { message: e?.message });
    }
  }

  socket.on("OFFER_ACCEPT", (payload) =>
    handle("OFFER_ACCEPT", payload, (tx, context) =>
      offers.applyAccept(tx, {
        commitment: context.commitment,
        leg: context.leg,
        storeTime: context.storeTime,
        leaseDurationSeconds: settings.leaseDurationSeconds,
        // §12.2 — renewal takes commitment-scoped positive evidence, which is exactly
        // what the response carries. A generic acknowledgement renews nothing.
        evidence: { commitmentId: context.data.commitmentId, fence: context.data.fence },
      }),
    ),
  );

  socket.on("OFFER_REJECT", (payload) =>
    handle("OFFER_REJECT", payload, async (tx, context) => {
      const result = await offers.applyReject(tx, {
        commitment: context.commitment,
        leg: context.leg,
        storeTime: context.storeTime,
        reason: context.data.reason,
        nackCooloffSeconds: settings.nackCooloffSeconds,
      });

      // §11.2 — "reason recorded as a **feasibility observation** and reconciled
      // against the server's view". §2.7's Observation table is append-only and is the
      // place a fact about the physical world belongs; a log line would not be
      // reconcilable.
      if (result.outcome === offers.OUTCOME.APPLIED && result.feasibilityObservation) {
        await tx.observation.create({
          data: {
            agentId: context.agent.id,
            kind: result.feasibilityObservation.kind,
            value: {
              commitmentId: result.feasibilityObservation.commitmentId,
              reason: result.feasibilityObservation.reason,
            },
            observedAt: result.feasibilityObservation.observedAt,
            // §2.7's provenance vocabulary. `AGENT_REPORT` and not `SENSOR`: a
            // rejection is the agent's *assertion* about its own feasibility, and
            // §23.5 makes agent-reported data untrusted input — accepted here for
            // restricting the agent, never for expanding its eligibility.
            source: observation.OBSERVATION_SOURCE.AGENT_REPORT,
          },
        });
      }

      return result;
    }),
  );

  socket.on("OFFER_DEFER", (payload) =>
    handle("OFFER_DEFER", payload, (tx, context) =>
      offers.applyDefer(tx, {
        commitment: context.commitment,
        leg: context.leg,
        storeTime: context.storeTime,
        until: context.data.until,
        reason: context.data.reason,
      }),
    ),
  );

  void kv;
}

module.exports = {
  registerOfferHandlers,
  resolveAgent,
};

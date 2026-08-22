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

// PHASE 15 remediation (D-6) — both halves of the cutover switch, from the one module that
// owns the question. This handler releases a commitment, moves a Leg and renews a lease:
// running it on a shard the staging order has not reached would be the engine acting as the
// decision path for a shard nobody authorised it for.
const agentGate = require("../../engine/cutover/agentGate");
// PHASE 15 remediation (X2a) — §4.5's deadline for the state each disposition enters.
// `offers.js` writes the Leg conditionally on its version and does not run §4.4's table, so
// before this every accepted, rejected and deferred offer left the Leg in a non-terminal
// state with no pending timer — invariant I4's violation, on the path the cutover makes
// live. See `cutover/legEntryDeadline.js` for why this arms the deadline rather than
// routing the write through `transitions.apply`.
const legEntryDeadline = require("../../engine/cutover/legEntryDeadline");

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

function registerOfferHandlers(io, socket, { prisma, kv, logger, config, appLocals } = {}) {
  const log = logger || console;
  const settings = config || {};

  // The pinned configuration snapshot, read at call time (P14-R1). `config` above is this
  // handler's own dispatch settings and is a different object; the shard half of the
  // cutover switch resolves against the published snapshot, which only `appLocals` carries.
  const configOf = () => appLocals?.config ?? null;

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
      if (!allow(socket, event, RESPONSE_RATE)) return;

      // Both halves plus the session, in one call. `assess()` refuses an unauthenticated
      // socket by name, so the separate `isAuthed` check it replaced is not lost.
      //
      // Read once and held for the whole disposition: the same published version decides
      // that this shard may act and supplies the deadline the entered state is armed with,
      // which is §22.1 rule 4's "a process observes exactly one version" applied to one
      // agent response rather than to a round.
      const snapshot = configOf();
      const gate = agentGate.assess({ socket, snapshot, nowMs: Date.now() });
      if (!gate.allowed) return;

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

        const applied = await apply(tx, {
          agent,
          commitment: matched.commitment,
          leg,
          storeTime,
          data: parsed.data,
        });

        // ── PHASE 15 remediation (X2a) — §4.5's deadline for the entered state ──
        //
        // In this transaction, on the applied path only. An `IGNORED` or `REFUSED`
        // disposition wrote no Leg state, so there is no entry to supervise and cancelling
        // the `OFFERED` deadline for one would remove supervision from a Leg that is still
        // legitimately offered.
        //
        // The consequence of its absence, for the record: an `ACCEPTED` Leg with no
        // `execute.start_grace` deadline is an agent that accepted and then went silent
        // and is never probed and never reassigned. All three dispositions are armed, not
        // just the accept, because §4.5's obligation is about the *state*, not about which
        // event produced it — and supervising two of three is how the next divergence
        // starts.
        if (applied.outcome === offers.OUTCOME.APPLIED && applied.legState) {
          await legEntryDeadline.superviseEntry(tx, {
            leg,
            state: applied.legState,
            storeTime,
            deadlineSeconds: legEntryDeadline.deadlineSecondsFrom(snapshot && snapshot.values, applied.legState),
            event,
            shardId: gate.shardId,
          });
        }

        return applied;
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

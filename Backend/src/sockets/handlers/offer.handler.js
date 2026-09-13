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
// The legacy read model. A **projection** of the authoritative commitment onto the columns
// the existing UI reads — it decides nothing, runs only after the decision exists, and
// writes no row the engine reasons from. See the module header for the four rules that
// keep it a projection and the test that asserts them structurally.
const assignmentProjection = require("../../services/assignmentProjection.service");

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
   * Publish an accepted assignment to the surfaces built against the legacy schema.
   *
   * Three effects, in the order a reader needs them, none of which touches the authority:
   *
   *   1. **The read model** — `Task.robotId`, `Task.status`, `Robot.currentTaskId`, so the
   *      Units list, the Tasks list and the dashboard stop rendering an assigned task as
   *      PENDING with no robot.
   *   2. **`TASK_ASSIGNED`** — the event the frontend has never stopped subscribing to,
   *      carrying `pathToPickup` and `pathToDrop` read back from the offer the agent was
   *      actually sent. What disappeared at the cutover was this producer, not the
   *      contract, so the event name and every field of it are unchanged.
   *   3. **The route cache** — `taskPath:*` and `robotTaskState:*`, which `rerouteTask`
   *      reads and `cancelTask` deletes. Completing an existing contract, not adding one.
   *
   * ── Every failure here is contained ─────────────────────────────────────────
   * Wrapped whole. The assignment has already been made and durably recorded; a read model
   * that cannot be written is a screen that is out of date, and turning that into a thrown
   * handler would turn a display defect into a lost agent response.
   *
   * @param {{ commitmentId: string, legRowId: string|null, robotId: string }} input
   */
  async function publishAssignment(input) {
    try {
      const projected = await assignmentProjection.projectAcceptedAssignment(prisma, {
        legRowId: input.legRowId,
        robotCode: input.robotId,
      });

      if (!projected.projected) {
        log.warn("assignment read model not projected", {
          robotId: input.robotId,
          commitmentId: input.commitmentId,
          reason: projected.reason,
        });
      }

      if (!projected.task) return;

      // The legacy status change, for the Tasks list and the dashboard cards. Emitted even
      // when the route is absent: "assigned to RBT-1000" is true and useful on its own,
      // and withholding it because no line can be drawn would hide the assignment.
      if (projected.projected) {
        io.to("dashboard").emit("TASK_UPDATED", {
          taskId: projected.task.taskId,
          robotId: input.robotId,
          status: assignmentProjection.PROJECTED_STATUS,
          timestamp: Date.now(),
        });
      }

      const route = await assignmentProjection.offeredRouteFor(prisma, input.commitmentId);
      if (!route) {
        // No geometry on the offer the agent was sent. The agent will have refused it by
        // name; saying so here is what keeps a blank map from looking like a map bug.
        log.warn("offer carried no execution geometry; no TASK_ASSIGNED emitted", {
          robotId: input.robotId,
          commitmentId: input.commitmentId,
          taskId: projected.task.taskId,
        });
        return;
      }

      const payload = assignmentProjection.taskAssignedPayload({
        task: projected.task,
        robotId: input.robotId,
        route,
      });
      if (payload) io.to("dashboard").emit("TASK_ASSIGNED", payload);

      await assignmentProjection.writeRouteCache(kv, {
        taskId: projected.task.taskId,
        robotId: input.robotId,
        route,
      });
    } catch (e) {
      log.error("assignment read model failed", { commitmentId: input.commitmentId, message: e?.message });
    }
  }

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

        // The Leg row this disposition applied to, carried out of the transaction so the
        // read model can resolve the Task without re-reading the commitment. Added here
        // rather than in `offers.js` because it is this handler's need, and widening an
        // engine module's return shape for a socket handler's convenience is how a Tier 0
        // contract acquires callers it was not written for.
        return { ...applied, legRowId: leg.id };
      });

      if (result.outcome === offers.OUTCOME.APPLIED) {
        // The dashboard is the only listener; robots have no reason to receive it.
        io.to("dashboard").emit("OFFER_RESPONSE", {
          robotId,
          commitmentId: parsed.data.commitmentId,
          response: event,
          legState: result.legState || null,
        });

        // ── The legacy read model, and the route handoff ────────────────────
        //
        // **After** the authoritative transaction has committed, and outside it. Both
        // properties are load-bearing: running before the commit would let a read model
        // describe a decision that had not been taken, and running inside the transaction
        // would let a projection failure roll back an assignment the engine had made.
        //
        // Only on ACCEPT. A rejected or deferred offer produced no assignment for the
        // legacy columns to reflect, and projecting one would be a screen showing a
        // binding that does not exist.
        if (event === "OFFER_ACCEPT" && result.legState === offers.LEG_STATE.ACCEPTED) {
          await publishAssignment({
            commitmentId: parsed.data.commitmentId,
            legRowId: result.legRowId || null,
            robotId,
          });
        }
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

}

module.exports = {
  registerOfferHandlers,
  resolveAgent,
};

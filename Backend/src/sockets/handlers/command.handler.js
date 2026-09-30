const { toStringOrNull } = require("../../utils/parse");
const { allow } = require("../rateLimit");
const { z } = require("zod");

const clockModule = require("../../engine/commitment/clock");
const outbox = require("../../engine/dispatch/outbox");
// PHASE 15 remediation (D-6) — both halves of the cutover switch, from the one module that
// owns the question. Settling an outbox row is an engine write.
const agentGate = require("../../engine/cutover/agentGate");

// PHASE 4 — §11.1 item 2: "Dispatcher workers claim outbox rows, deliver, and mark
// them delivered." The mark that closes the loop is the agent's acknowledgement, and
// without it every delivered row sits in `DELIVERED` until the escalation ladder
// withdraws it — which is the correct behaviour for an agent that genuinely said
// nothing and the wrong behaviour for one that answered.
//
// The event is shared with the legacy operator-command path deliberately: §11.2 lists
// `COMMAND_ACK (extended)` rather than a new event, so an agent implements one
// acknowledgement. The two are told apart by which key the payload carries —
// `commandId` for a legacy `Command` row, `outboxId` for an engine command — and a
// payload carrying both acknowledges both, which is the honest reading of an agent
// that applied both.
const outboxAckSchema = z
  .object({
    outboxId: z.string().min(1),
    // The agent echoes the fence it applied the command under, so an acknowledgement
    // generated under a superseded authority cannot close a row that superseded it.
    fence: z.union([z.string(), z.number()]).optional().nullable(),
    authorityEpoch: z.union([z.string(), z.number()]).optional().nullable(),
  })
  .passthrough();

/**
 * Acknowledge one outbox row.
 *
 * Conditional on the row still naming this agent and still being non-terminal, so a
 * late acknowledgement of a row the ladder already withdrew is counted and ignored
 * rather than resurrecting a withdrawn offer.
 *
 * @param {object} prisma
 * @param {string} robotId
 * @param {object} data
 * @returns {Promise<{ acked: boolean, reason: string|null }>}
 */
async function acknowledgeOutboxRow(prisma, robotId, data) {
  const agent = await prisma.agent.findUnique({ where: { agentId: robotId } });
  if (!agent) return { acked: false, reason: "NO_AGENT_PROJECTION" };

  const row = await prisma.outbox.findUnique({ where: { id: data.outboxId } });
  if (!row) return { acked: false, reason: "UNKNOWN_OUTBOX_ROW" };
  if (row.agentId !== agent.id) return { acked: false, reason: "ACK_FROM_ANOTHER_AGENT" };
  if (outbox.isTerminal(row.state)) return { acked: false, reason: `ALREADY_${row.state}` };

  if (data.fence !== undefined && data.fence !== null && row.fence !== null && row.fence !== undefined) {
    if (BigInt(data.fence) !== BigInt(row.fence)) return { acked: false, reason: "ACK_CARRIES_A_DIFFERENT_FENCE" };
  }
  if (
    data.authorityEpoch !== undefined &&
    data.authorityEpoch !== null &&
    row.authorityEpoch !== null &&
    row.authorityEpoch !== undefined
  ) {
    if (BigInt(data.authorityEpoch) !== BigInt(row.authorityEpoch)) {
      return { acked: false, reason: "ACK_CARRIES_A_DIFFERENT_AUTHORITY_EPOCH" };
    }
  }

  const storeTime = await clockModule.readStoreTime(prisma);
  const count = await outbox.settleRow(prisma, { id: row.id, state: outbox.OUTBOX_STATE.ACKED, storeTime });
  return { acked: count === 1, reason: count === 1 ? null : "ROW_MOVED" };
}

function registerCommandHandlers(io, socket, { prisma, kv, logger, appLocals }) {
  const log = logger || console;

  // The pinned configuration snapshot, read at call time so a republished version reaches
  // an already-connected socket (P14-R1). Threaded from `socket.server.js`.
  const configOf = () => appLocals?.config ?? null;

  const ackSchema = z.object({ commandId: z.string().min(1) }).passthrough();

  socket.on("COMMAND_ACK", async (payload) => {
    try {
      if (!allow(socket, "COMMAND_ACK", { limit: 20, windowMs: 60_000, minIntervalMs: 100 })) return;

      // The engine half, when the payload names an outbox row.
      //
      // PHASE 15 remediation (D-6) — gated on **both** halves of the cutover switch. This
      // read used to be `process.env.ENGINE_ENABLED === "true" && socket.data?.isAuthed`,
      // which is the process half plus the session and no shard at all: during a staged
      // rollout it settled outbox rows for every shard, including ones the staging order
      // had not reached. `agentGate.assess()` folds the session check in, so the
      // conjunction is one call rather than a partial one reassembled here.
      const gate = agentGate.assess({ socket, snapshot: configOf(), nowMs: Date.now() });
      if (gate.allowed) {
        const engineAck = outboxAckSchema.safeParse(payload || {});
        if (engineAck.success) {
          const robotId = toStringOrNull(socket.data.robotId);
          const result = await acknowledgeOutboxRow(prisma, robotId, engineAck.data).catch((e) => ({
            acked: false,
            reason: e?.message || "ACK_FAILED",
          }));
          log.info("COMMAND_ACK (outbox)", { robotId, outboxId: engineAck.data.outboxId, ...result });
        }
      }

      const parsed = ackSchema.safeParse(payload || {});
      if (!parsed.success) return;

      const commandId = toStringOrNull(parsed.data.commandId);
      if (!commandId) return;

      const now = new Date();
      const existing = await prisma.command.findUnique({
        where: { id: commandId },
        select: { id: true, issuedAt: true, robotId: true, status: true },
      });
      if (!existing) return;

      // P2B-2 — only the robot a command was issued to may acknowledge it. `Command.robotId`
      // is the `Robot.id` row key; the socket speaks for `socket.data.robotId` (the code it
      // authenticated as). Before this, any authenticated robot could mark another robot's
      // STOP as acknowledged and silence the retry that would have re-delivered it.
      const ackingRobotCode = toStringOrNull(socket.data?.robotId);
      if (!ackingRobotCode) return;
      const ackingRobot = await prisma.robot.findUnique({ where: { robotId: ackingRobotCode }, select: { id: true } });
      if (!ackingRobot || ackingRobot.id !== existing.robotId) {
        log.warn?.("COMMAND_ACK ignored — the command was not issued to this robot", {
          robotId: ackingRobotCode,
          commandId,
        });
        return;
      }

      await prisma.command.update({
        where: { id: commandId },
        data: {
          status: "ACK",
          executedAt: now,
        },
      });

      const responseTimeMs = Math.max(0, now.getTime() - new Date(existing.issuedAt).getTime());

      // Store for quick lookups (TTL 24h)
      try {
        await kv?.set?.(`cmd:rt:${commandId}`, String(responseTimeMs), { ex: 86400 });
      } catch {
        // ignore
      }

      // Persist via existing Event table (no schema changes required)
      try {
        await prisma.event.create({
          data: {
            robotId: existing.robotId,
            type: "INFO",
            message: `COMMAND_ACK ${commandId} responseTimeMs=${responseTimeMs}`,
          },
        });
      } catch {
        // ignore
      }

      try {
        await kv?.del?.(`cmdretry:${commandId}`);
      } catch {
        // ignore
      }

      // Dashboard-only UI event — robots never listen for it. Was a global
      // io.emit (every connected socket, robots included); scoping to the
      // room avoids O(N) fan-out to sockets with no reason to receive it.
      io.to("dashboard").emit("COMMAND_STATUS", { commandId, status: "ACK", responseTimeMs });
    } catch (e) {
      // If the command row doesn't exist (or belongs to another robot), ignore.
      log.error("COMMAND_ACK handler failed", e);
    }
  });
}

module.exports = {
  registerCommandHandlers,
  acknowledgeOutboxRow,
};

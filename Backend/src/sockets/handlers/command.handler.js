const { toStringOrNull } = require("../../utils/parse");
const { allow } = require("../rateLimit");
const { z } = require("zod");

function registerCommandHandlers(io, socket, { prisma, kv, logger }) {
  const log = logger || console;

  const ackSchema = z.object({ commandId: z.string().min(1) }).passthrough();

  socket.on("COMMAND_ACK", async (payload) => {
    try {
      if (!allow(socket, "COMMAND_ACK", { limit: 20, windowMs: 60_000, minIntervalMs: 100 })) return;
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

      io.emit("COMMAND_STATUS", { commandId, status: "ACK", responseTimeMs });
    } catch (e) {
      // If the command row doesn't exist (or belongs to another robot), ignore.
      log.error("COMMAND_ACK handler failed", e);
    }
  });
}

module.exports = {
  registerCommandHandlers,
};

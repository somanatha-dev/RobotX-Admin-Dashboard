const asyncHandler = require("../utils/asyncHandler");
const { getPrisma } = require("../db/prisma");
const userAccount = require("../services/userAccount.service");
const dashboardBroadcast = require("../sockets/dashboardBroadcast");

// RBAC — campus administrator accounts. Every route here is SUPER_ADMIN only (users.routes.js),
// and the actor is always the verified session's account.

function actorOf(req) {
  return { id: req.user.id, role: req.user.role };
}

// GET /api/users
const listUsers = asyncHandler(async (_req, res) => {
  res.json({ ok: true, users: await userAccount.listAccounts(getPrisma()) });
});

// POST /api/users — `{ email, password, campusId }` → a new ADMIN of that campus.
const createAdmin = asyncHandler(async (req, res) => {
  const user = await userAccount.createAdmin(getPrisma(), req.body, actorOf(req));
  res.status(201).json({ ok: true, user });
});

// PATCH /api/users/:id — `{ campusId?, disabled? }` for an ADMIN account.
const updateAdmin = asyncHandler(async (req, res) => {
  const { account, changed } = await userAccount.updateAdmin(getPrisma(), req.params.id, req.body, actorOf(req));
  // The account's open dashboard sockets were scoped to what it was. Tell them why, then
  // disconnect them: the dashboard's UNAUTHORIZED handler re-reads `/api/auth/me` and either
  // signs out (disabled: 401 ACCOUNT_DISABLED) or clears its campus data and reconnects into
  // the new scope. A disconnect without the event left the page silently without live data.
  if (changed) {
    try {
      const io = req.app?.locals?.io;
      const room = dashboardBroadcast.userRoom(account.id);
      io?.to(room).emit("UNAUTHORIZED", account.disabled
        ? { message: "Your access has been revoked", code: "ACCOUNT_DISABLED" }
        : { message: "Your access changed", code: "ACCESS_CHANGED" });
      await io?.in(room).disconnectSockets(true);
    } catch {
      // The periodic re-check in socket.server.js closes them within a minute regardless.
    }
  }
  res.json({ ok: true, user: account });
});

module.exports = { listUsers, createAdmin, updateAdmin };

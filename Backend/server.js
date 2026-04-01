const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const Redis = require("ioredis");
const { PrismaClient } = require("@prisma/client");
require("dotenv").config();

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const prisma = new PrismaClient();
const redis = new Redis({
  host: "127.0.0.1",
  port: 6379
});

const toNumberOrNull = (v) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const toStringOrNull = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};

async function collectDescendantLocationIds(rootId) {
  const ids = [];
  const queue = [rootId];
  const seen = new Set();

  while (queue.length) {
    const id = queue.shift();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);

    const children = await prisma.location.findMany({
      where: { parentId: id },
      select: { id: true },
    });
    for (const c of children) queue.push(c.id);
  }

  return ids;
}

app.get("/api/locations", async (req, res) => {
  try {
    const { parentId, type } = req.query;
    const where = {};
    if (typeof parentId === "string") where.parentId = parentId;
    if (typeof type === "string") where.type = type;

    const locations = await prisma.location.findMany({
      where,
      orderBy: [{ name: "asc" }],
    });

    res.json({ ok: true, locations });
  } catch (e) {
    console.error("GET /api/locations failed", e);
    res.status(500).json({ ok: false, error: "Failed to fetch locations" });
  }
});

app.post("/api/locations", async (req, res) => {
  try {
    const name = toStringOrNull(req.body?.name);
    const type = toStringOrNull(req.body?.type);
    const parentId = toStringOrNull(req.body?.parentId);
    const slug = toStringOrNull(req.body?.slug);
    const lat = toNumberOrNull(req.body?.lat);
    const lon = toNumberOrNull(req.body?.lon);

    if (!name || !type) {
      return res.status(400).json({ ok: false, error: "name and type are required" });
    }

    if (parentId) {
      const parent = await prisma.location.findUnique({ where: { id: parentId }, select: { id: true } });
      if (!parent) return res.status(400).json({ ok: false, error: "Invalid parentId" });
    }

    const location = await prisma.location.create({
      data: {
        name,
        type,
        parentId,
        slug,
        lat,
        lon,
      },
    });

    res.json({ ok: true, location });
  } catch (e) {
    console.error("POST /api/locations failed", e);
    res.status(500).json({ ok: false, error: "Failed to create location" });
  }
});

app.get("/api/locations/:id/descendants", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing id" });

    const ids = await collectDescendantLocationIds(id);
    res.json({ ok: true, ids });
  } catch (e) {
    console.error("GET /api/locations/:id/descendants failed", e);
    res.status(500).json({ ok: false, error: "Failed to fetch descendants" });
  }
});

// Commission/register robots (locationId is mandatory)
app.post("/api/robots", async (req, res) => {
  try {
    const robotCode = toStringOrNull(req.body?.robotId);
    const locationId = toStringOrNull(req.body?.locationId);
    const campusId = toStringOrNull(req.body?.campusId);

    const lat = toNumberOrNull(req.body?.lat);
    const lon = toNumberOrNull(req.body?.lon);

    if (!robotCode || !locationId) {
      return res.status(400).json({ ok: false, error: "robotId and locationId are required" });
    }

    const location = await prisma.location.findUnique({ where: { id: locationId }, select: { id: true } });
    if (!location) return res.status(400).json({ ok: false, error: "Invalid locationId" });

    if (campusId) {
      const campus = await prisma.campus.findUnique({ where: { id: campusId }, select: { id: true } });
      if (!campus) return res.status(400).json({ ok: false, error: "Invalid campusId" });
    }

    const robot = await prisma.robot.upsert({
      where: { robotId: robotCode },
      create: {
        robotId: robotCode,
        locationId,
        campusId,
        lat,
        lon,
        isOnline: false,
      },
      update: {
        locationId,
        campusId,
        lat,
        lon,
      },
      include: { location: true, campus: true, currentTask: true },
    });

    res.json({ ok: true, robot });
  } catch (e) {
    console.error("POST /api/robots failed", e);
    res.status(500).json({ ok: false, error: "Failed to register robot" });
  }
});

// REST: fetch robots for map/dashboard
// - Global mode: pass locationId (+ includeDescendants=true)
// - Campus mode: pass campusId
app.get("/api/robots", async (req, res) => {
  try {
    const { locationId, includeDescendants, campusId, isOnline, status } = req.query;

    const where = {};
    if (campusId) {
      where.campusId = String(campusId);
    } else if (locationId) {
      const rootId = String(locationId);
      const wantDesc = String(includeDescendants || "true") === "true";
      if (wantDesc) {
        const ids = await collectDescendantLocationIds(rootId);
        where.locationId = { in: ids };
      } else {
        where.locationId = rootId;
      }
    }

    if (typeof isOnline === "string") where.isOnline = isOnline === "true";
    if (status) where.status = String(status);

    const robots = await prisma.robot.findMany({
      where,
      include: {
        campus: true,
        location: true,
        currentTask: true,
      },
      orderBy: [{ isOnline: "desc" }, { lastSeenAt: "desc" }],
    });

    res.json({ ok: true, robots });
  } catch (e) {
    console.error("GET /api/robots failed", e);
    res.status(500).json({ ok: false, error: "Failed to fetch robots" });
  }
});

app.get("/api/campuses", async (_req, res) => {
  try {
    const campuses = await prisma.campus.findMany({ orderBy: [{ name: "asc" }] });
    res.json({ ok: true, campuses });
  } catch (e) {
    console.error("GET /api/campuses failed", e);
    res.status(500).json({ ok: false, error: "Failed to fetch campuses" });
  }
});

app.post("/api/campuses", async (req, res) => {
  try {
    const code = toStringOrNull(req.body?.code);
    const name = toStringOrNull(req.body?.name);
    const centerLat = toNumberOrNull(req.body?.centerLat);
    const centerLon = toNumberOrNull(req.body?.centerLon);

    if (!code || !name) {
      return res.status(400).json({ ok: false, error: "code and name are required" });
    }
    if (centerLat === null || centerLon === null) {
      return res.status(400).json({ ok: false, error: "centerLat and centerLon are required" });
    }

    const campus = await prisma.campus.create({
      data: {
        code,
        name,
        centerLat,
        centerLon,
      },
    });

    res.json({ ok: true, campus });
  } catch (e) {
    console.error("POST /api/campuses failed", e);
    res.status(500).json({ ok: false, error: "Failed to create campus" });
  }
});


// ✅ Redis connection logs
redis.on("connect", () => {
  console.log("🔥 Redis connected");
});

redis.on("ready", () => {
  console.log("✅ Redis ready");
});

redis.on("error", (err) => {
  console.log("❌ Redis error:", err);
});

redis.on("close", () => {
  console.log("⚠️ Redis connection closed");
});

// 🔥 SOCKET CONNECTION
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // ROBOT SENDS DATA
  socket.on("telemetry", async (data) => {
    try {
      const robotCode = toStringOrNull(data?.robotId);
      if (!robotCode) return;

      // keep last-known state in Redis for ultra-fast reads
      await redis.set(`robot:${robotCode}`, JSON.stringify(data));
      await redis.set(`socket:${socket.id}`, robotCode);

      const now = new Date();
      const lat = toNumberOrNull(data?.lat);
      const lon = toNumberOrNull(data?.lon);
      const speed = toNumberOrNull(data?.speed);
      const battery = toNumberOrNull(data?.battery);

      // Robots must be commissioned first (locationId is mandatory)
      const existing = await prisma.robot.findUnique({ where: { robotId: robotCode }, select: { id: true } });
      if (!existing) {
        io.emit("robot_unregistered", { robotId: robotCode });
        return;
      }

      const robotRow = await prisma.robot.update({
        where: { robotId: robotCode },
        data: {
          isOnline: true,
          socketId: socket.id,
          lastSeenAt: now,
          ...(lat === null ? {} : { lat }),
          ...(lon === null ? {} : { lon }),
          speed,
          battery,
        },
      });

      // Store high-frequency stream (you can throttle later if needed)
      await prisma.telemetry.create({
        data: {
          robotId: robotRow.id,
          lat,
          lon,
          speed,
          battery,
          createdAt: now,
        },
      });

      // Emit enriched update (robot row + currentTask) so the frontend can draw
      const robot = await prisma.robot.findUnique({
        where: { robotId: robotCode },
        include: { currentTask: true, campus: true, location: true },
      });

      io.emit("robot_update", {
        ...data,
        robot,
      });
    } catch (e) {
      console.error("telemetry handler failed", e);
    }
  });

  // ADMIN CREATES TASK
  socket.on("assign_task", async (task) => {
    try {
      const taskId = toStringOrNull(task?.taskId || task?.id);
      const robotCode = toStringOrNull(task?.robotId);
      const pickup = toStringOrNull(task?.pickup);
      const drop = toStringOrNull(task?.drop);
      if (!taskId || !robotCode || !pickup || !drop) {
        return;
      }

      const pickupLat = toNumberOrNull(task?.pickupLat);
      const pickupLon = toNumberOrNull(task?.pickupLon);
      const dropLat = toNumberOrNull(task?.dropLat);
      const dropLon = toNumberOrNull(task?.dropLon);
      // Task coords are mandatory (map correctness)
      if (pickupLat === null || pickupLon === null || dropLat === null || dropLon === null) {
        return;
      }

      const robotRow = await prisma.robot.findUnique({ where: { robotId: robotCode }, select: { id: true } });
      if (!robotRow) {
        io.emit("task_error", { taskId, robotId: robotCode, error: "Robot not commissioned" });
        return;
      }

      // Create task (id is uuid; taskId is your external id)
      const created = await prisma.task.create({
        data: {
          taskId,
          robotId: robotRow.id,
          pickup,
          pickupLat,
          pickupLon,
          drop,
          dropLat,
          dropLon,
          status: "ASSIGNED",
        },
        include: {
          robot: true,
        },
      });

      // Set as current task for that robot (strict 1:1)
      await prisma.robot.update({
        where: { id: robotRow.id },
        data: {
          currentTaskId: created.id,
          status: "ACTIVE",
        },
      });

      io.emit("task_assigned", created);
    } catch (e) {
      console.error("assign_task handler failed", e);
    }
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    // Best-effort: mark robot offline if we know which one was bound to this socket.
    (async () => {
      try {
        const robotCode = await redis.get(`socket:${socket.id}`);
        if (!robotCode) return;
        await redis.del(`socket:${socket.id}`);
        await prisma.robot.update({
          where: { robotId: robotCode },
          data: { isOnline: false },
        });
        io.emit("robot_offline", { robotId: robotCode });
      } catch (e) {
        // ignore
      }
    })();
  });
});

server.listen(3000, () => {
  console.log("Server running on 3000");
});
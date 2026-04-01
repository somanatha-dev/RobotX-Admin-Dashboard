const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const Redis = require("ioredis");
const { PrismaClient } = require("@prisma/client");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const prisma = new PrismaClient();
const redis = new Redis({
  host: "127.0.0.1",
  port: 6379
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
    await redis.set(`robot:${data.robotId}`, JSON.stringify(data));

    io.emit("robot_update", data);
  });

  // ADMIN CREATES TASK
  socket.on("assign_task", async (task) => {
    await prisma.task.create({
      data: task
    });

    io.emit("task_assigned", task);
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
  });
});

server.listen(3000, () => {
  console.log("Server running on 3000");
});
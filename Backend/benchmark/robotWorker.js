"use strict";

// Child process: owns a slice of the simulated fleet. Connects each robotId
// as a real socket.io-client (same AUTH -> TELEMETRY/HEARTBEAT wire protocol
// VirtualRobot.js uses), reports aggregate counters to the parent every
// second, and — for the small set of designated probe robots — reports the
// exact Date.now() a TELEMETRY frame was sent so the parent's dashboard
// socket can compute end-to-end telemetry->broadcast latency.

const { io: ioClient } = require("socket.io-client");

const sockets = new Map();
const authed = new Set();
let counters = { telemetrySent: 0, heartbeatSent: 0, taskAssignReceived: 0, taskCompleteSent: 0 };

function tokenFor(robotId) {
  return `bench-${robotId}`;
}

function startRobot(robotId, cfg, probeSet) {
  const socket = ioClient(cfg.serverUrl, {
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1500,
    reconnectionDelayMax: 8000,
    timeout: 20000,
    forceNew: true,
  });
  sockets.set(robotId, socket);

  let lat = 12.9023 + (Math.random() - 0.5) * 0.01;
  let lon = 77.5186 + (Math.random() - 0.5) * 0.01;
  let battery = 70 + Math.random() * 30;
  let currentTaskId = null;
  let timer = null;

  socket.on("connect", () => {
    socket.emit("AUTH", { robotId, token: tokenFor(robotId) });
  });

  socket.on("AUTH_SUCCESS", () => {
    authed.add(robotId);
    if (!timer) {
      const jitter = Math.floor(Math.random() * cfg.tickMs);
      setTimeout(() => {
        tick();
        timer = setInterval(tick, cfg.tickMs);
      }, jitter);
    }
  });

  socket.on("AUTH_REQUIRED", () => {
    socket.emit("AUTH", { robotId, token: tokenFor(robotId) });
  });

  socket.on("TASK_ASSIGN", (payload) => {
    counters.taskAssignReceived++;
    const taskId = payload?.taskId;
    if (!taskId) return;
    currentTaskId = taskId;
    const completeAfter = 4000 + Math.random() * 6000;
    setTimeout(() => {
      try {
        socket.emit("TASK_COMPLETE", { taskId, timestamp: Date.now() });
        counters.taskCompleteSent++;
      } catch { /* ignore */ }
      currentTaskId = null;
    }, completeAfter);
  });

  socket.on("disconnect", () => {
    authed.delete(robotId);
  });

  socket.on("connect_error", () => { /* transient — reconnection handles it */ });

  function tick() {
    if (!socket.connected) return;
    lat += (Math.random() - 0.5) * 0.00006;
    lon += (Math.random() - 0.5) * 0.00006;
    battery = Math.max(15, battery - 0.01);
    const status = currentTaskId ? "ACTIVE" : "IDLE";
    const speed = currentTaskId ? 5.5 + Math.random() : 0;

    try {
      socket.emit("HEARTBEAT");
      counters.heartbeatSent++;
    } catch { /* ignore */ }

    const sentAt = Date.now();
    try {
      socket.emit("TELEMETRY", { robotId, lat, lon, battery, speed, status, distanceTravelled: 0 });
      counters.telemetrySent++;
    } catch { /* ignore */ }

    if (probeSet.has(robotId)) {
      process.send({ type: "probeSent", robotId, sentAt });
    }
  }
}

process.on("message", (msg) => {
  if (msg?.type === "start") {
    const cfg = msg.config;
    const probeSet = new Set(cfg.probeRobotIds || []);
    const staggerMs = cfg.connectStaggerMs || 30;
    cfg.robotIds.forEach((robotId, idx) => {
      setTimeout(() => startRobot(robotId, cfg, probeSet), idx * staggerMs);
    });

    setInterval(() => {
      process.send({
        type: "stats",
        authedCount: authed.size,
        total: cfg.robotIds.length,
        ...counters,
      });
      counters = { telemetrySent: 0, heartbeatSent: 0, taskAssignReceived: 0, taskCompleteSent: 0 };
    }, cfg.reportIntervalMs || 1000);
  } else if (msg?.type === "stop") {
    for (const s of sockets.values()) {
      try { s.disconnect(); } catch { /* ignore */ }
    }
    setTimeout(() => process.exit(0), 200);
  }
});

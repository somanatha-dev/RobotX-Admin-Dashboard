const io = require("socket.io-client");

const socket = io("http://localhost:3000");

setInterval(() => {
  socket.emit("telemetry", {
    robotId: "RBT-001",
    lat: 12.97 + Math.random() * 0.001,
    lon: 77.59 + Math.random() * 0.001,
    battery: Math.floor(Math.random() * 100)
  });
}, 2000);
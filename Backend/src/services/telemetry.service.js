async function saveTelemetry(prisma, robotRowId, payload, now) {
  const lat = payload.lat;
  const lon = payload.lon;
  const speed = payload.speed;
  const battery = payload.battery;

  return prisma.telemetry.create({
    data: {
      robotId: robotRowId,
      lat,
      lon,
      speed,
      battery,
      createdAt: now,
    },
  });
}

module.exports = {
  saveTelemetry,
};

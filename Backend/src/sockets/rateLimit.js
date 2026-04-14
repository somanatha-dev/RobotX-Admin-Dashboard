// Global per-socket+event debounce (per requirement).
const lastEvent = new Map();

function allow(socket, key, { limit, windowMs, minIntervalMs } = {}) {
  if (!socket || !key) return true;

  // Hard minimum spacing between events.
  const minMs = typeof minIntervalMs === "number" && minIntervalMs > 0 ? minIntervalMs : 0;
  if (minMs) {
    const now = Date.now();
    const k = `${socket.id}:${key}`;
    const last = lastEvent.get(k);
    if (last && now - last < minMs) return false;
    lastEvent.set(k, now);

    // Simple opportunistic cleanup.
    if (lastEvent.size > 50_000) {
      for (const [mk, ts] of lastEvent) {
        if (now - ts > 60_000) lastEvent.delete(mk);
      }
    }
  }

  const l = typeof limit === "number" && limit > 0 ? limit : 10;
  const w = typeof windowMs === "number" && windowMs > 0 ? windowMs : 1000;

  const store = (socket.data.__rl = socket.data.__rl || {});
  const now = Date.now();
  const entry = store[key];

  if (!entry || now - entry.start > w) {
    store[key] = { start: now, count: 1 };
    return true;
  }

  entry.count += 1;
  return entry.count <= l;
}

module.exports = {
  allow,
};

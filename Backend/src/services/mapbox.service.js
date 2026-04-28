const { decodePolyline } = require("../utils/polylineDecode");

function getMapboxToken() {
  const t1 = typeof process.env.MAPBOX_TOKEN === "string" ? process.env.MAPBOX_TOKEN.trim() : "";
  const t2 = typeof process.env.MAPBOX_ACCESS_TOKEN === "string" ? process.env.MAPBOX_ACCESS_TOKEN.trim() : "";
  const token = t1 || t2;
  return token || null;
}

function assertToken() {
  const token = getMapboxToken();
  if (!token) {
    const err = new Error("Mapbox token not configured (set MAPBOX_TOKEN)");
    err.status = 503;
    throw err;
  }
  return token;
}

function toCoordString(coords) {
  // coords: [{ lon, lat }]
  return coords
    .map((c) => `${Number(c.lon)},${Number(c.lat)}`)
    .join(";");
}

async function fetchJson(url, { method = "GET", body, signal } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg = (json && (json.message || json.error || json.code)) || text || res.statusText;
    const err = new Error(`Mapbox request failed (${res.status}): ${msg}`);
    err.status = 502;
    throw err;
  }

  return json;
}

async function matrixDurationsToDestination({ origins, destination, profile = "driving" }) {
  // origins: [{lon,lat}], destination: {lon,lat}
  const token = assertToken();

  const coords = origins.concat([destination]);
  const coordStr = toCoordString(coords);

  const sources = origins.map((_, i) => String(i)).join(";");
  const destIdx = String(origins.length);

  const url = `https://api.mapbox.com/directions-matrix/v1/mapbox/${encodeURIComponent(profile)}/${coordStr}?sources=${sources}&destinations=${destIdx}&annotations=duration&access_token=${encodeURIComponent(token)}`;

  const json = await fetchJson(url);

  const durations = json?.durations;
  // durations: [ [dest0], [dest0], ... ]
  if (!Array.isArray(durations)) return origins.map(() => null);

  return durations.map((row) => {
    const d = Array.isArray(row) ? row[0] : null;
    return typeof d === "number" && Number.isFinite(d) ? d : null;
  });
}

async function directionsPolyline({ from, to, profile = "driving" }) {
  const token = assertToken();

  const coords = `${Number(from.lon)},${Number(from.lat)};${Number(to.lon)},${Number(to.lat)}`;

  const url = `https://api.mapbox.com/directions/v5/mapbox/${encodeURIComponent(profile)}/${coords}?geometries=polyline&overview=full&access_token=${encodeURIComponent(token)}`;

  const json = await fetchJson(url);
  const route = json?.routes?.[0];
  const geometry = route?.geometry;
  if (!geometry || typeof geometry !== "string") {
    const err = new Error("Directions API returned no polyline geometry");
    err.status = 502;
    throw err;
  }

  const points = decodePolyline(geometry, { precision: 5 });
  if (!Array.isArray(points) || points.length < 2) {
    const err = new Error("Directions API returned an empty route");
    err.status = 502;
    throw err;
  }

  return points;
}

module.exports = {
  matrixDurationsToDestination,
  directionsPolyline,
};

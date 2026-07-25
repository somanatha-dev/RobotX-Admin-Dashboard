/**
 * Mapbox Directions & Matrix service.
 *
 * Uses `geometries=geojson` to get GeoJSON LineString coordinates directly —
 * no polyline encoding/decoding, no precision mismatch, no silent empty routes.
 *
 * Route profile priority (tried in order until one succeeds):
 *   1. driving   — real road network, works for any two points in Bengaluru
 *   2. walking   — pedestrian paths, good for campus short routes
 *   3. cycling   — fallback if the above two fail for any reason
 */

const logger = require("../config/logger");

function getMapboxToken() {
  const t1 = typeof process.env.MAPBOX_TOKEN        === "string" ? process.env.MAPBOX_TOKEN.trim()        : "";
  const t2 = typeof process.env.MAPBOX_ACCESS_TOKEN === "string" ? process.env.MAPBOX_ACCESS_TOKEN.trim() : "";
  return t1 || t2 || null;
}

function assertToken() {
  const token = getMapboxToken();
  if (!token) {
    const err = new Error("Mapbox token not configured — set MAPBOX_TOKEN in Backend/.env");
    err.status = 503;
    throw err;
  }
  return token;
}

async function fetchJson(url) {
  const res  = await fetch(url);
  const text = await res.text().catch(() => "");
  let json   = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  if (!res.ok) {
    const msg = (json && (json.message || json.error || json.code)) || res.statusText;
    const err = new Error(`Mapbox ${res.status}: ${msg}`);
    err.status = 502;
    err.mapboxCode = json?.code || null;
    throw err;
  }
  return json;
}

/**
 * Fetch a Directions route using GeoJSON geometry (no polyline decoding).
 * Returns { points: [{lat,lon}], distanceMeters, durationSec }.
 *
 * @param {{ lat: number, lon: number }} from
 * @param {{ lat: number, lon: number }} to
 * @param {string} profile  driving | walking | cycling
 */
async function directionsWithDistance({ from, to, profile = "driving" }) {
  const token = assertToken();

  // Mapbox expects longitude,latitude (note: lon first)
  const coords = `${Number(from.lon)},${Number(from.lat)};${Number(to.lon)},${Number(to.lat)}`;

  // geometries=geojson — returns real GeoJSON coordinates, no encoding/decoding
  // overview=full      — full route geometry (not simplified)
  // steps=false        — we only need the shape, not turn-by-turn
  const url = [
    `https://api.mapbox.com/directions/v5/mapbox/${encodeURIComponent(profile)}/${coords}`,
    `?geometries=geojson`,
    `&overview=full`,
    `&steps=false`,
    `&access_token=${encodeURIComponent(token)}`,
  ].join("");

  const json  = await fetchJson(url);
  const route = json?.routes?.[0];

  if (!route) {
    const err = new Error(`No route returned by Mapbox (profile=${profile}, code=${json?.code})`);
    err.status = 502;
    err.mapboxCode = json?.code || null;
    throw err;
  }

  const geometry = route.geometry;

  // GeoJSON LineString: { type: "LineString", coordinates: [[lon, lat], ...] }
  if (!geometry || geometry.type !== "LineString" || !Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2) {
    const err = new Error(`Mapbox returned empty/invalid GeoJSON geometry (profile=${profile})`);
    err.status = 502;
    throw err;
  }

  // Convert [lon, lat] → { lat, lon }
  const points = geometry.coordinates.map(([lon, lat]) => ({
    lat: Number(lat),
    lon: Number(lon),
  }));

  const distanceMeters = typeof route.distance === "number" && Number.isFinite(route.distance)
    ? route.distance
    : null;
  const durationSec = typeof route.duration === "number" && Number.isFinite(route.duration)
    ? route.duration
    : null;

  logger.info(`[Mapbox] ${profile} route: ${points.length} pts, ${distanceMeters ? (distanceMeters / 1000).toFixed(2) + " km" : "?"}, ${durationSec ? Math.round(durationSec / 60) + " min" : "?"}`);

  return { points, distanceMeters, durationSec };
}

/**
 * Convenience wrapper for internal use (returns only points array).
 */
async function directionsPolyline({ from, to, profile = "driving" }) {
  const { points } = await directionsWithDistance({ from, to, profile });
  return points;
}

/**
 * Mapbox Matrix API — durations from multiple origins to one destination.
 * Used by DTARO for nearest-robot selection.
 */
async function matrixDurationsToDestination({ origins, destination, profile = "driving" }) {
  const token = assertToken();

  const coords = [...origins, destination]
    .map((c) => `${Number(c.lon)},${Number(c.lat)}`)
    .join(";");

  const sources = origins.map((_, i) => String(i)).join(";");
  const destIdx = String(origins.length);

  const url = [
    `https://api.mapbox.com/directions-matrix/v1/mapbox/${encodeURIComponent(profile)}/${coords}`,
    `?sources=${sources}`,
    `&destinations=${destIdx}`,
    `&annotations=duration`,
    `&access_token=${encodeURIComponent(token)}`,
  ].join("");

  const json = await fetchJson(url);

  const durations = json?.durations;
  if (!Array.isArray(durations)) return origins.map(() => null);

  return durations.map((row) => {
    const d = Array.isArray(row) ? row[0] : null;
    return typeof d === "number" && Number.isFinite(d) ? d : null;
  });
}

module.exports = {
  matrixDurationsToDestination,
  directionsPolyline,
  directionsWithDistance,
};

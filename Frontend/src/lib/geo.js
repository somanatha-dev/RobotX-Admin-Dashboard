export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function toRad(deg) {
  return (deg * Math.PI) / 180;
}

export function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function interpolateLngLat(a, b, t) {
  const tt = clamp(t, 0, 1);
  return [lerp(a[0], b[0], tt), lerp(a[1], b[1], tt)];
}

export function haversineMeters(a, b) {
  const R = 6371000;
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const dLat = lat2 - lat1;
  const dLon = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearingDeg(from, to) {
  const lon1 = toRad(from[0]);
  const lat1 = toRad(from[1]);
  const lon2 = toRad(to[0]);
  const lat2 = toRad(to[1]);
  const dLon = lon2 - lon1;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const brng = toDeg(Math.atan2(y, x));
  return (brng + 360) % 360;
}

export function metersToLngLatDelta(metersX, metersY, atLat) {
  const latMeters = 111320;
  const lngMeters = 111320 * Math.cos(toRad(atLat));
  return [metersX / lngMeters, metersY / latMeters];
}

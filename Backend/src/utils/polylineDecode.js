// Polyline (Google/Mapbox) decoder for precision=1e5 ("polyline").
// Returns array of { lat, lon }.

function decodePolyline(str, { precision = 5 } = {}) {
  const s = typeof str === "string" ? str : "";
  const factor = Math.pow(10, precision);

  let index = 0;
  let lat = 0;
  let lon = 0;
  const out = [];

  while (index < s.length) {
    let result = 0;
    let shift = 0;
    let b;

    // lat
    do {
      b = s.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < s.length);

    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;

    // lon
    result = 0;
    shift = 0;
    do {
      b = s.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && index < s.length);

    const dlon = (result & 1) ? ~(result >> 1) : (result >> 1);
    lon += dlon;

    out.push({ lat: lat / factor, lon: lon / factor });
  }

  return out;
}

module.exports = {
  decodePolyline,
};

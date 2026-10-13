/**
 * The charging glyph drawn inside a station badge, rasterised here rather than loaded.
 *
 * Mapbox style images are wiped by every style load, so the icon has to be re-added from
 * code each time; building it as RGBA pixels keeps that one synchronous `addImage` with no
 * network fetch, no `<canvas>` and no SVG decode — and lets the tests check it under Node.
 * The glyph is a lightning bolt in white with a thin dark rim, so it reads on every state
 * colour the badge can take.
 */

export const STATION_ICON_ID = 'robotx-charging-bolt';

/** The bolt outline in unit coordinates (0…1, y down). */
const BOLT = Object.freeze([
  [0.58, 0.06],
  [0.24, 0.56],
  [0.47, 0.56],
  [0.38, 0.94],
  [0.76, 0.42],
  [0.53, 0.42],
  [0.64, 0.06],
]);

function inside(x, y, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** The bolt scaled about its centre (for the rim). */
const scaled = (k) => BOLT.map(([x, y]) => [0.5 + (x - 0.5) * k, 0.5 + (y - 0.5) * k]);

/**
 * @param {number} size   pixels per side (drawn at `pixelRatio` 2, so 40 → a 20 px icon)
 * @returns {{ width: number, height: number, data: Uint8Array }}
 */
export function boltIconImage(size = 40) {
  const data = new Uint8Array(size * size * 4);
  const rim = scaled(1.18);
  const SS = 4; // 4×4 supersampling for clean edges
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let fill = 0;
      let edge = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (inside(x, y, BOLT)) fill += 1;
          else if (inside(x, y, rim)) edge += 1;
        }
      }
      const n = SS * SS;
      const a = (fill + edge) / n;
      if (a === 0) continue;
      // White where the bolt is, dark slate on the rim; premultiplication is Mapbox's job.
      const w = fill / (fill + edge);
      const o = (py * size + px) * 4;
      data[o] = Math.round(255 * w + 15 * (1 - w));
      data[o + 1] = Math.round(255 * w + 23 * (1 - w));
      data[o + 2] = Math.round(255 * w + 42 * (1 - w));
      data[o + 3] = Math.round(255 * a * (w + (1 - w) * 0.55));
    }
  }
  return { width: size, height: size, data };
}

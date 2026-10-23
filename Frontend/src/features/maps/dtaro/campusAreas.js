/**
 * Campus AREAS — a visual reading aid, never an operational zone.
 *
 * The published spatial map decides alert routing, and today it has ONE zone per region, so
 * the operational zone layer cannot divide a campus into parts. This module answers a
 * different question — "what is this part of campus?" — from the campus's own classified
 * geometry (`resolveCampusDefinition(...).features`): only features with an explicit polygon
 * outline in the source data, grouped by the importer's own classification.
 *
 * What it will not do:
 *   · invent an outline, merge features into a made-up region, or buffer a point into an area;
 *   · rename a feature beyond its source name (an unnamed cricket/football ground stays a
 *     "Sports ground", even if a "Playground" point exists elsewhere);
 *   · decide anything — nothing routes, alerts or assigns from these areas.
 *
 * Generic: rules read classification and names, never a campus id.
 */

export const AREA_GROUP = Object.freeze({
  SPORTS: 'SPORTS',
  FOOD: 'FOOD',
  MAIN: 'MAIN',
  EVENTS: 'EVENTS',
  HOUSING: 'HOUSING',
  PARKING: 'PARKING',
  ACADEMIC: 'ACADEMIC',
});

/**
 * Pastel fills (ColorBrewer Set2, a colour-blind-conscious qualitative set), the darker outline
 * each is drawn with, and a darker still label colour that reads on a light basemap (a mid-tone
 * label on a white halo was too faint in the browser). Order is the legend order.
 */
export const AREA_GROUP_META = Object.freeze({
  [AREA_GROUP.SPORTS]: { label: 'Sports', fill: '#66c2a5', line: '#2f8a6e', text: '#1d5e4a' },
  [AREA_GROUP.FOOD]: { label: 'Canteen', fill: '#fc8d62', line: '#c4552d', text: '#9a3412' },
  [AREA_GROUP.MAIN]: { label: 'Main Building', fill: '#8da0cb', line: '#4d63a0', text: '#334a87' },
  [AREA_GROUP.EVENTS]: { label: 'Auditorium', fill: '#e78ac3', line: '#b4508f', text: '#8a2c69' },
  [AREA_GROUP.HOUSING]: { label: 'Hostels', fill: '#a6d854', line: '#6f9b23', text: '#4a6b12' },
  [AREA_GROUP.PARKING]: { label: 'Parking', fill: '#b3b3b3', line: '#6b7280', text: '#374151' },
  [AREA_GROUP.ACADEMIC]: { label: 'Academic blocks', fill: '#e5c494', line: '#a8844c', text: '#6b4f22' },
});

const isPolygon = (f) => f?.geometry?.type === 'Polygon' || f?.geometry?.type === 'MultiPolygon';
const nameOf = (f) => (typeof f?.name === 'string' ? f.name.trim() : '');

/**
 * The area group a classified feature belongs to, and the label it is shown with — or null.
 * `label: null` means the area is tinted but not labelled (the campus layer names it already).
 */
export function areaFor(feature) {
  if (!isPolygon(feature)) return null;
  const kind = feature.kind;
  const category = feature.category;
  const name = nameOf(feature);

  if (category === 'SPORTS') return { group: AREA_GROUP.SPORTS, label: name || null };
  if (kind === 'BUILDING' && /canteen|food court|cafeteria/i.test(name)) return { group: AREA_GROUP.FOOD, label: name };
  if (kind === 'BUILDING' && /main building/i.test(name)) return { group: AREA_GROUP.MAIN, label: name };
  if (/auditorium|theatre|theater/i.test(name)) return { group: AREA_GROUP.EVENTS, label: name };
  if (category === 'RESIDENTIAL' || /hostel/i.test(name)) return { group: AREA_GROUP.HOUSING, label: name || null };
  if (/parking/i.test(name)) return { group: AREA_GROUP.PARKING, label: name };
  if (kind === 'BUILDING' && category === 'ACADEMIC') return { group: AREA_GROUP.ACADEMIC, label: null };
  return null;
}

/**
 * Every visual area of a campus, from its classified features.
 *
 * @param {{ features?: object[] }} definition `resolveCampusDefinition(...)`
 * @returns {object[]} `{ key, group, label, sourceId, geometry, fill, line }`
 */
export function campusAreasFor(definition) {
  const areas = [];
  for (const feature of definition?.features || []) {
    const area = areaFor(feature);
    if (!area) continue;
    const meta = AREA_GROUP_META[area.group];
    areas.push({
      key: `area/${feature.id}`,
      group: area.group,
      label: area.label,
      sourceId: feature.sourceId || feature.id,
      verification: feature.verification || null,
      geometry: feature.geometry,
      fill: meta.fill,
      line: meta.line,
      text: meta.text,
    });
  }
  return areas;
}

/** The legend rows: one per group present, with how many outlines it has. */
export function areaLegendRows(areas) {
  const counts = new Map();
  for (const area of areas) counts.set(area.group, (counts.get(area.group) || 0) + 1);
  return Object.keys(AREA_GROUP_META)
    .filter((group) => counts.has(group))
    .map((group) => ({ group, ...AREA_GROUP_META[group], count: counts.get(group) }));
}

/**
 * What an operator might look for and the campus data does not hold as an outline — stated
 * rather than drawn. `points` are named point-only locations (no boundary to draw).
 */
export function missingAreaNotes(definition) {
  const features = definition?.features || [];
  const notes = [];
  if (!features.some((f) => /library/i.test(nameOf(f)))) notes.push('Library — not in this campus’s data');
  const playgroundOutlines = features.filter((f) => isPolygon(f) && /playground/i.test(nameOf(f)));
  const playgroundPoints = features.filter((f) => f?.geometry?.type === 'Point' && /playground/i.test(nameOf(f)));
  if (playgroundOutlines.length === 0 && playgroundPoints.length > 0) {
    notes.push(`Playgrounds — ${playgroundPoints.length} verified point${playgroundPoints.length === 1 ? '' : 's'}, no outline`);
  }
  const canteens = features.filter((f) => isPolygon(f) && /canteen/i.test(nameOf(f)));
  if (canteens.length > 1) notes.push(`${canteens.length} separate buildings are named “Canteen” in the source data`);
  return notes;
}

/** GeoJSON for the area fill/outline source. */
export function areaFeatureCollection(areas) {
  return {
    type: 'FeatureCollection',
    features: areas.map((a) => ({
      type: 'Feature',
      id: a.key,
      properties: { key: a.key, group: a.group, fill: a.fill, line: a.line },
      geometry: a.geometry,
    })),
  };
}

/** One label point per labelled area (vertex average of its outer ring). */
export function areaLabelCollection(areas) {
  const features = [];
  for (const a of areas) {
    if (!a.label) continue;
    const ring = a.geometry?.type === 'Polygon' ? a.geometry.coordinates[0] : a.geometry?.coordinates?.[0]?.[0];
    if (!Array.isArray(ring) || ring.length < 4) continue;
    const pts = ring.slice(0, -1);
    const lon = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const lat = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    features.push({
      type: 'Feature',
      id: a.key,
      properties: { key: a.key, group: a.group, label: a.label, text: a.text },
      geometry: { type: 'Point', coordinates: [lon, lat] },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SUPPLEMENTAL CAMPUS IMPORT — user-supplied locations join the campus model
 *
 *      OSM extract ──► osmCampusImport ──┐
 *                                        ├──► CAMPUS SEMANTIC MODEL ──► layers
 *      user locations ──► THIS MODULE ──┘         (campusRegistry)        search
 *                                                                         details
 *                                                                         camera
 *
 * Two sources, one model. Neither dataset can edit the other: the OSM extract
 * and the supplemental file are both read-only inputs, and where they disagree
 * the disagreement is REPORTED rather than resolved by overwriting one of them.
 *
 * ── What a user-supplied point is, and is not ─────────────────────────────
 * It is someone who knows this campus saying "that thing is here". That fills
 * gaps no open dataset covers — this campus's main gate, its playgrounds, its
 * newer departments — and it is the weakest provenance the system carries,
 * because it is the only input with no external record behind it. Every feature
 * emitted here is `provenance: USER_SUPPLIED`, `verification: NOT_VERIFIED`,
 * and the UI says both.
 *
 * ── A point is a location, not a building (§3) ────────────────────────────
 * Every feature in this dataset is `geometryRole: POINT_LOCATION`. Nothing here
 * fabricates a footprint, a rectangle, an extent, a height or a floor count
 * from a coordinate — and the schema now refuses a POINT_LOCATION that carries
 * a `renderHeight`, so it cannot happen by accident later either. When real
 * polygon geometry arrives, the feature keeps its `id` and swaps its geometry
 * and role; its label, search entry and selection state all survive (§23).
 *
 * Pure module: no React, no Mapbox — loadable under plain Node.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import {
  CAMPUS_CATEGORY,
  CAMPUS_FEATURE_KIND,
  GEOMETRY_ROLE,
  LABEL_PRIORITY,
  PROVENANCE,
  VERIFICATION,
} from '../campusSchema.js';
import { categoryFromName, metresBetween, pointInPolygon } from '../osm/osmCampusImport.js';

export const SUPPLEMENTAL_DATASET_ORIGIN = 'User-supplied campus locations';
export const SUPPLEMENTAL_DATASET_CRS =
  'WGS84 (EPSG:4326), lon/lat order — verified against the supplied file';

/**
 * Which supplied file this is, and whose campus it describes.
 *
 * All three vary per campus and none is a property of the importer, so all three
 * come from the registry entry:
 *
 *   file        the artefact, named in every feature's `source` string
 *   campus      the campus CODE — the trust disclaimer names it, because
 *               "not official RNSIT data" says more than "not official campus
 *               data", and it has to say the right institution once there is
 *               more than one
 *   campusName  the campus's full name, whose words are stopwords for
 *               duplicate detection — see `significantTokens`
 *
 * @param {string|null} file        e.g. `rnsit-campus-supplemental.geojson`
 * @param {string|null} campus      e.g. `RNSIT`
 * @param {string|null} campusName  e.g. `RNS Institute of Technology`
 */
export function supplementalDataset(file, campus, campusName) {
  const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return Object.freeze({
    file: clean(file),
    campus: clean(campus),
    campusName: clean(campusName),
    origin: SUPPLEMENTAL_DATASET_ORIGIN,
    crs: SUPPLEMENTAL_DATASET_CRS,
  });
}

/** The generic descriptor, for a collection imported outside a registered campus. */
export const SUPPLEMENTAL_DATASET = supplementalDataset(null, null, null);

export function supplementalSourceString(id, dataset = SUPPLEMENTAL_DATASET) {
  const ds = dataset || SUPPLEMENTAL_DATASET;
  const file = ds.file ? ` — ${ds.file}` : '';
  const owner = ds.campus ? `not official ${ds.campus} data` : 'not official campus data';
  return (
    `${ds.origin}${file} (${id}). ` +
    `Supplied from local knowledge; not surveyed, ${owner}, not verified.`
  );
}

// ── The supplied vocabulary, mapped onto the campus contract ────────────────
//
// The dataset uses its own `kind` words — SPORTS, PARKING, DEPARTMENT — which
// are not kinds in `campusSchema.CAMPUS_FEATURE_KIND`; in this model they are
// CATEGORIES of a FACILITY. Mapping them is a translation, not a reinterpretation,
// and the supplied word is preserved verbatim on every feature as `sourceKind`
// so nothing the user wrote is lost.
//
// `major` drives the label band, and follows the operational hierarchy in the
// brief: a gate matters more to a fleet than a bank does.

const KIND_RULES = Object.freeze({
  GATE: {
    kind: CAMPUS_FEATURE_KIND.GATE,
    category: CAMPUS_CATEGORY.ACCESS,
    major: true,
    note: 'A way on or off the site — the highest operational importance of anything in this dataset.',
  },
  DEPARTMENT: {
    kind: CAMPUS_FEATURE_KIND.FACILITY,
    category: CAMPUS_CATEGORY.ACADEMIC,
    major: true,
    note: 'A department is a place people are sent to, so it labels with the buildings rather than below them.',
  },
  SPORTS: {
    kind: CAMPUS_FEATURE_KIND.FACILITY,
    category: CAMPUS_CATEGORY.SPORTS,
    major: false,
    note: 'A ground known only as a point — drawn as a compact POI, never as an invented pitch outline.',
  },
  PARKING: {
    kind: CAMPUS_FEATURE_KIND.FACILITY,
    category: CAMPUS_CATEGORY.OPERATIONAL,
    major: false,
    note: 'An operational location; its extent is unknown and is not drawn.',
  },
  FACILITY: {
    kind: CAMPUS_FEATURE_KIND.FACILITY,
    category: CAMPUS_CATEGORY.UNCLASSIFIED,
    major: false,
    note: 'A campus facility.',
  },
});

/** How a supplied `kind` word maps onto the contract. Exported for the report and tests. */
export function kindRuleFor(sourceKind) {
  return KIND_RULES[String(sourceKind || '').trim().toUpperCase()] || null;
}

// ── Reconciliation with the OSM extract (§6) ────────────────────────────────

export const RECONCILIATION = Object.freeze({
  /** Same name, close enough: one real place with two records. Not drawn twice. */
  MERGED_WITH_OSM: 'MERGED_WITH_OSM',
  /** Close to an OSM feature of the same category but a DIFFERENT name. Both drawn, disclosed. */
  POSSIBLE_DUPLICATE: 'POSSIBLE_DUPLICATE',
  /** Nothing comparable nearby. */
  DISTINCT: 'DISTINCT',
});

/**
 * Two records describe one place when they agree on the NAME and are close
 * enough that they cannot be two different things with that name.
 *
 * Distance alone is not enough and is the trap here: this campus has an OSM
 * "Canteen" 41 m from the supplied "RNSIT Food Court", and an OSM "Motorcycle
 * parking" 52 m from the supplied "RNSIT Parking Lot". Merging on proximity
 * would silently assert that a food court IS that canteen — a claim the data
 * does not support. Requiring the name to match as well means the rule fires
 * only where identity is actually evidenced.
 */
export const MERGE_RADIUS_M = 60;

/**
 * Close enough to be worth an operator's attention, without asserting identity.
 * Both features are drawn and both are searchable; the details card says a
 * nearby record may describe the same place, and leaves the judgement to a
 * person who can go and look.
 */
export const PROXIMITY_RADIUS_M = 60;

function normaliseName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Words that carry no identity ON ANY CAMPUS. "X Block" and "X Department"
 * share two tokens and describe nothing in common, so matching on them would
 * make almost every pair of features look related.
 */
const GENERIC_NAME_STOPWORDS = Object.freeze([
  'the', 'of', 'and', 'a', 'an', 'block', 'building', 'department',
  'centre', 'center', 'campus', 'college', 'institute', 'technology',
  'academy', 'school', 'university', 'lot', 'area', 'new', 'old',
]);

/**
 * The stopwords for ONE campus: the generic list, plus the campus's own name.
 *
 * The campus's own name is the strongest false signal there is — every second
 * feature on a site is called "<campus> something", so treating those tokens as
 * identity would flag half the dataset as possible duplicates of the other half.
 * It used to be handled by hard-coding `rnsit` and `rns` into the shared list,
 * which is a fact about one campus living in code every campus runs. It is now
 * derived from the dataset's own `campus` code and `campusName`, so campus #2
 * and campus #100 get the same treatment without an edit here.
 */
function stopwordsFor(dataset) {
  const set = new Set(GENERIC_NAME_STOPWORDS);
  for (const source of [dataset?.campus, dataset?.campusName]) {
    for (const token of normaliseName(source).split(' ')) {
      if (token) set.add(token);
    }
  }
  return set;
}

function significantTokens(name, stopwords) {
  const stop = stopwords || new Set(GENERIC_NAME_STOPWORDS);
  return new Set(
    normaliseName(name)
      .split(' ')
      .filter((t) => t.length > 2 && !stop.has(t))
  );
}

/**
 * Is there real evidence these two records might be the same place?
 *
 * Proximity alone is not evidence — on a 24-acre site with 54 features, almost
 * everything is within 60 m of something. Two independent signals qualify:
 *
 *   1. a shared significant word ("Parking Lot" / "Motorcycle parking"), or
 *   2. the same specific category — SPORTS, COMMERCIAL, ACADEMIC and so on.
 *
 * Both require the OSM feature to be NAMED. An unnamed footprint has no
 * identity to be a duplicate OF, and flagging one would tell an operator that
 * two records may describe the same place when only one of them describes
 * anything at all.
 *
 * UNCLASSIFIED never matches UNCLASSIFIED: "neither of these is classified" is
 * an absence of information, not a similarity between them.
 */
function possibleDuplicateEvidence(supplementalName, supplementalCategory, osmFeature, stopwords) {
  if (!osmFeature?.name || osmFeature.nameIsDescriptive) return null;

  const a = significantTokens(supplementalName, stopwords);
  const b = significantTokens(osmFeature.name, stopwords);
  for (const t of a) {
    if (b.has(t)) return `both names contain "${t}"`;
  }

  if (
    supplementalCategory &&
    supplementalCategory !== CAMPUS_CATEGORY.UNCLASSIFIED &&
    supplementalCategory === osmFeature.category
  ) {
    return `both are classified ${supplementalCategory}`;
  }

  return null;
}

/** Mean of a polygon ring / the point itself — the same anchor the label layer uses. */
function anchorOf(geometry) {
  if (geometry?.type === 'Point') return geometry.coordinates;
  const ring =
    geometry?.type === 'Polygon'
      ? geometry.coordinates?.[0]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates?.[0]?.[0]
        : geometry?.type === 'LineString'
          ? geometry.coordinates
          : null;
  if (!Array.isArray(ring) || ring.length === 0) return null;
  const closed =
    ring.length > 2 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const p of pts) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    sx += p[0];
    sy += p[1];
    n += 1;
  }
  return n === 0 ? null : [sx / n, sy / n];
}

// ── Boundary containment (§7) ───────────────────────────────────────────────

export const CONTAINMENT = Object.freeze({
  INSIDE: 'INSIDE',
  OUTSIDE: 'OUTSIDE',
  /**
   * Within `BOUNDARY_UNCERTAINTY_M` of the perimeter, on either side.
   *
   * This band exists because the boundary itself is unverified OSM geometry. A
   * point 1 m outside an unverified line is not evidence that the thing is off
   * campus — it is evidence that we do not know. Reporting that as a hard
   * OUTSIDE would dress up the boundary's own uncertainty as a fact about the
   * feature.
   */
  UNCERTAIN: 'UNCERTAIN',
});

export const BOUNDARY_UNCERTAINTY_M = 25;

/** Shortest distance in metres from a point to a polygon's outer ring. */
export function metresToPolygonEdge(point, geometry) {
  const ring =
    geometry?.type === 'Polygon'
      ? geometry.coordinates?.[0]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates?.[0]?.[0]
        : null;
  if (!Array.isArray(point) || !Array.isArray(ring) || ring.length < 2) return Infinity;

  const kx = 111320 * Math.cos((point[1] * Math.PI) / 180);
  const ky = 110574;
  const px = point[0] * kx;
  const py = point[1] * ky;

  let best = Infinity;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const ax = ring[i][0] * kx;
    const ay = ring[i][1] * ky;
    const bx = ring[i + 1][0] * kx;
    const by = ring[i + 1][1] * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

/**
 * Classify a point against the campus boundary.
 *
 * An OUTSIDE point is never discarded (§7). A main gate is outside the
 * perimeter almost by definition — that is what a gate is — and a nearby
 * facility is still worth showing an operator. It is classified, labelled and
 * reported, not deleted and not quietly promoted to an internal campus feature.
 */
export function classifyContainment(point, boundaryGeometry) {
  if (!boundaryGeometry) {
    return { containment: CONTAINMENT.UNCERTAIN, metresFromBoundary: null, reason: 'no campus boundary to test against' };
  }
  const inside = pointInPolygon(point, boundaryGeometry);
  const edge = metresToPolygonEdge(point, boundaryGeometry);
  const signed = Math.round((inside ? -1 : 1) * edge);

  if (edge <= BOUNDARY_UNCERTAINTY_M) {
    return {
      containment: CONTAINMENT.UNCERTAIN,
      metresFromBoundary: signed,
      reason: `${Math.round(edge)} m from an unverified campus boundary — too close to call`,
    };
  }
  return {
    containment: inside ? CONTAINMENT.INSIDE : CONTAINMENT.OUTSIDE,
    metresFromBoundary: signed,
    reason: inside ? `${Math.round(edge)} m inside the campus boundary` : `${Math.round(edge)} m outside the campus boundary`,
  };
}

// ── Label priority (§15) ────────────────────────────────────────────────────

/**
 * Where a supplemental POI's label sits in the zoom hierarchy.
 *
 * Nothing here claims PRIMARY. That band is the campus's own name, and a POI
 * label rendered in its upcased, letter-spaced treatment would be exactly the
 * "giant label" the brief rules out. A gate is distinguished by its MARKER —
 * larger, ringed, drawn above the other points — while its text stays in the
 * ordinary secondary band, which is already visible at the campus overview
 * framing (zoom 16.6 against a 15.5 threshold).
 */
function labelPriorityFor(rule) {
  return rule.major ? LABEL_PRIORITY.SECONDARY : LABEL_PRIORITY.DETAIL;
}

// ── Import ──────────────────────────────────────────────────────────────────

export const SUPPLEMENTAL_EXCLUSION = Object.freeze({
  UNKNOWN_KIND: 'UNKNOWN_KIND',
  BAD_GEOMETRY: 'BAD_GEOMETRY',
  DUPLICATE_ID: 'DUPLICATE_ID',
});

/**
 * Turn the supplemental FeatureCollection into campus features, reconciled
 * against already-imported OSM features.
 *
 * @param {object} collection            the supplemental GeoJSON
 * @param {object} [options]
 * @param {object[]} [options.osmFeatures]   already-imported OSM campus features
 * @param {object} [options.boundary]        the campus BOUNDARY feature
 * @returns {{
 *   features: object[],
 *   excluded: Array<{id: string, name: string|null, reason: string, detail: string}>,
 *   merges: Array<{supplementalId: string, osmId: string, name: string, metres: number}>,
 *   possibleDuplicates: Array<{supplementalId: string, osmId: string, supplementalName: string, osmName: string, metres: number}>,
 *   coLocations: Array<{id: string, withId: string}>,
 *   containment: Array<{id: string, name: string, containment: string, metresFromBoundary: number|null}>,
 * }}
 */
export function importSupplementalCampus(
  collection,
  { osmFeatures = [], boundary = null, dataset = SUPPLEMENTAL_DATASET } = {}
) {
  const source = Array.isArray(collection?.features) ? collection.features : [];

  const excluded = [];
  const merges = [];
  const possibleDuplicates = [];
  const coLocations = [];
  const containmentReport = [];

  /** This campus's own name words, which carry no identity here. */
  const stopwords = stopwordsFor(dataset);

  // OSM features that a point could plausibly BE. Roads, paths and the
  // boundary are excluded: a point is never "the same place" as a line.
  const comparable = osmFeatures.filter(
    (f) =>
      f?.kind === CAMPUS_FEATURE_KIND.BUILDING ||
      f?.kind === CAMPUS_FEATURE_KIND.FACILITY ||
      f?.kind === CAMPUS_FEATURE_KIND.LANDMARK ||
      f?.kind === CAMPUS_FEATURE_KIND.GATE
  );

  const staged = [];
  const seenIds = new Set();

  for (const [i, sf] of source.entries()) {
    const props = sf?.properties || {};
    const id = typeof props.id === 'string' && props.id.trim() ? props.id.trim() : null;
    const name = typeof props.name === 'string' && props.name.trim() ? props.name.trim() : null;
    const where = id || `features[${i}]`;

    if (!id || !name) {
      excluded.push({
        id: where,
        name,
        reason: SUPPLEMENTAL_EXCLUSION.BAD_GEOMETRY,
        detail: 'a supplemental location needs both an id and a name',
      });
      continue;
    }
    if (seenIds.has(id)) {
      excluded.push({ id, name, reason: SUPPLEMENTAL_EXCLUSION.DUPLICATE_ID, detail: 'id already used in this dataset' });
      continue;
    }

    // Points only, in this dataset and in this pass. A polygon arriving here
    // later is a geometry upgrade and needs its own reviewed handling — it must
    // not slip through as though it were a location.
    if (sf?.geometry?.type !== 'Point' || !Array.isArray(sf.geometry.coordinates)) {
      excluded.push({
        id,
        name,
        reason: SUPPLEMENTAL_EXCLUSION.BAD_GEOMETRY,
        detail: `expected a Point location, got ${JSON.stringify(sf?.geometry?.type)}`,
      });
      continue;
    }

    const rule = kindRuleFor(props.kind);
    if (!rule) {
      excluded.push({
        id,
        name,
        reason: SUPPLEMENTAL_EXCLUSION.UNKNOWN_KIND,
        detail: `no rule for kind ${JSON.stringify(props.kind)} — add one rather than guessing`,
      });
      continue;
    }

    // The supplied `kind` fixes the category for GATE, SPORTS, PARKING and
    // DEPARTMENT — those words already say what the thing is. A plain FACILITY
    // does not, so the name is consulted using the SAME rule table the OSM
    // importer uses (`categoryFromName`), not a second copy of it. Where no
    // rule matches, the feature stays UNCLASSIFIED rather than being guessed at,
    // and every feature records which of the two decided it.
    const derived =
      rule.category === CAMPUS_CATEGORY.UNCLASSIFIED ? categoryFromName(name) : null;
    const category = derived && derived.category !== CAMPUS_CATEGORY.UNCLASSIFIED ? derived.category : rule.category;
    const categoryBasis = derived && derived.category !== CAMPUS_CATEGORY.UNCLASSIFIED
      ? `the supplied name — ${derived.from}`
      : `the supplied kind "${props.kind}"`;

    seenIds.add(id);
    staged.push({ sf, id, name, props, rule, category, categoryBasis });
  }

  // ── Reconcile against OSM ────────────────────────────────────────────────
  const features = [];

  for (const s of staged) {
    const point = s.sf.geometry.coordinates;

    let merged = null;
    let nearMiss = null;
    for (const o of comparable) {
      const a = anchorOf(o.geometry);
      if (!a) continue;
      const d = metresBetween(point, a);
      if (normaliseName(o.name) === normaliseName(s.name)) {
        if (d <= MERGE_RADIUS_M && (!merged || d < merged.metres)) {
          merged = { osm: o, metres: Math.round(d) };
        }
      } else if (d <= PROXIMITY_RADIUS_M) {
        const evidence = possibleDuplicateEvidence(s.name, s.category, o, stopwords);
        if (evidence && (!nearMiss || d < nearMiss.metres)) {
          nearMiss = { osm: o, metres: Math.round(d), evidence };
        }
      }
    }

    const containment = classifyContainment(point, boundary?.geometry);
    containmentReport.push({
      id: s.id,
      name: s.name,
      containment: containment.containment,
      metresFromBoundary: containment.metresFromBoundary,
    });

    if (s.props.coLocatedWith) {
      coLocations.push({ id: s.id, withId: String(s.props.coLocatedWith) });
    }

    // ── MERGED: one place, two records, one marker ─────────────────────────
    //
    // The supplemental record does NOT become a second feature. It is attached
    // to the OSM feature that already represents this place as an additional
    // provenance record, so the map draws one thing and the card can show both
    // sources. Nothing is moved: the OSM geometry stays exactly where it was.
    if (merged) {
      merges.push({ supplementalId: s.id, osmId: merged.osm.sourceId, name: s.name, metres: merged.metres });
      continue;
    }

    if (nearMiss) {
      possibleDuplicates.push({
        supplementalId: s.id,
        osmId: nearMiss.osm.sourceId,
        supplementalName: s.name,
        osmName: nearMiss.osm.name,
        metres: nearMiss.metres,
      });
    }

    features.push(buildFeature(s, { containment, nearMiss, dataset }));
  }

  // ── Co-location: two records, one place, one marker (§5) ─────────────────
  //
  // RNS FIRST GRADE COLLEGE and RNS Evening College are supplied at the SAME
  // coordinate, and the dataset says so explicitly via `coLocatedWith`. Two
  // markers stacked pixel-for-pixel would be a rendering artefact, not
  // information. So the dependent record keeps its identity, its search entry
  // and its details, and surrenders only its marker and its label to the
  // feature it declares itself co-located with.
  const byId = new Map(features.map((f) => [f.id, f]));
  for (const f of features) {
    if (!f.coLocatedWith) continue;
    const host = byId.get(f.coLocatedWith);
    if (!host) {
      f.metadata = { ...f.metadata, 'Co-located with': `${f.coLocatedWith} (not present in this dataset)` };
      continue;
    }
    f.rendersOwnMarker = false;
    f.labelled = false;
    f.metadata = { ...f.metadata, 'Co-located with': host.name };
    host.coLocatedFeatures = [...(host.coLocatedFeatures || []), { id: f.id, name: f.name }];
    host.metadata = {
      ...host.metadata,
      'Also at this location': (host.coLocatedFeatures || []).map((c) => c.name).join(' · '),
    };
  }

  return { features, excluded, merges, possibleDuplicates, coLocations, containment: containmentReport };
}

function buildFeature(s, { containment, nearMiss, dataset }) {
  const { sf, id, name, props, rule, category, categoryBasis } = s;

  const metadata = {
    'Supplied as': `${props.kind} (user-supplied classification)`,
    'Classified from': categoryBasis,
    Coordinates: `${sf.geometry.coordinates[1]}, ${sf.geometry.coordinates[0]}`,
    'Geometry known': 'Point location only — no footprint, extent or height in this dataset',
    'Campus boundary': `${containment.containment} — ${containment.reason}`,
  };

  // Access properties are carried through as UNKNOWN rather than dropped (§8):
  // an absent field reads as "nobody thought about it", an explicit UNKNOWN
  // reads as "this is a known gap", and only the second one gets filled in.
  for (const [key, label] of [
    ['accessType', 'Access type'],
    ['vehicleAccess', 'Vehicle access'],
    ['pedestrianAccess', 'Pedestrian access'],
  ]) {
    if (props[key]) metadata[label] = String(props[key]);
  }

  if (nearMiss) {
    metadata['Possible duplicate'] =
      `"${nearMiss.osm.name}" from OpenStreetMap is ${nearMiss.metres} m away — ${nearMiss.evidence}. ` +
      'These may be the same place, or this may sit within it. Nothing here has confirmed either, ' +
      'so both are shown and neither has been moved.';
  }

  return {
    id,
    name,
    shortName: null,
    kind: rule.kind,
    category,
    labelPriority: labelPriorityFor(rule),
    labelled: true,
    /** Cleared for a co-located dependent — see the co-location pass. */
    rendersOwnMarker: true,
    nameIsDescriptive: false,

    geometry: sf.geometry,
    geometryRole: GEOMETRY_ROLE.POINT_LOCATION,

    ...(props.coLocatedWith ? { coLocatedWith: String(props.coLocatedWith) } : {}),

    provenance: PROVENANCE.USER_SUPPLIED,
    verification: VERIFICATION.NOT_VERIFIED,
    verifiedOn: null,
    source: supplementalSourceString(id, dataset),
    sourceId: id,
    sourceKind: props.kind,
    sourceTags: Object.freeze({ ...props }),

    containment: containment.containment,
    metresFromBoundary: containment.metresFromBoundary,

    metadata,
  };
}

/**
 * Attach merged supplemental records to the OSM features that already
 * represent them, without moving or altering the OSM geometry.
 *
 * Returns a NEW array; the input features are not mutated, so the OSM import
 * stays exactly what its own module produced (§22).
 */
export function applyMergesToOsmFeatures(osmFeatures, merges, supplementalCollection) {
  if (!Array.isArray(merges) || merges.length === 0) return osmFeatures;

  const bySourceId = new Map();
  for (const m of merges) bySourceId.set(m.osmId, m);

  const supplied = new Map(
    (supplementalCollection?.features || []).map((f) => [f.properties?.id, f])
  );

  return osmFeatures.map((f) => {
    const m = bySourceId.get(f.sourceId);
    if (!m) return f;

    const sf = supplied.get(m.supplementalId);
    return {
      ...f,
      // Geometry, provenance and verification are untouched: this feature is
      // still the OSM record it was. The supplemental record is corroboration
      // recorded alongside it, not a replacement for it.
      corroboratedBy: {
        id: m.supplementalId,
        name: m.name,
        provenance: PROVENANCE.USER_SUPPLIED,
        metres: m.metres,
      },
      metadata: {
        ...f.metadata,
        'Also recorded as': `"${m.name}" (user-supplied location, ${m.metres} m away, unverified)`,
      },
      sourceTags: sf ? Object.freeze({ ...f.sourceTags, __supplemental: sf.properties }) : f.sourceTags,
    };
  });
}

// ── Report (§28) ────────────────────────────────────────────────────────────

export function describeSupplementalImport(
  collection,
  { osmFeatures = [], boundary = null, dataset = SUPPLEMENTAL_DATASET } = {}
) {
  const r = importSupplementalCampus(collection, { osmFeatures, boundary, dataset });
  const source = Array.isArray(collection?.features) ? collection.features : [];

  const byContainment = (c) => r.containment.filter((x) => x.containment === c).map((x) => x.name);

  return {
    sourceFeatures: source.length,
    imported: r.features.length,
    excluded: r.excluded.length,
    mergedWithOsm: r.merges.length,
    possibleDuplicates: r.possibleDuplicates.length,
    coLocated: r.coLocations.length,
    inside: byContainment(CONTAINMENT.INSIDE),
    outside: byContainment(CONTAINMENT.OUTSIDE),
    uncertain: byContainment(CONTAINMENT.UNCERTAIN),
    byKind: r.features.reduce((acc, f) => {
      acc[f.sourceKind] = (acc[f.sourceKind] || 0) + 1;
      return acc;
    }, {}),
    markersDrawn: r.features.filter((f) => f.rendersOwnMarker).length,
    names: r.features.map((f) => f.name),
  };
}

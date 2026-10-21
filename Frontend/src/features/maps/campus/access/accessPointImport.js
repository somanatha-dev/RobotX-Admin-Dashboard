/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ACCESS-POINT REGISTER IMPORT — the only door from a candidate to a location
 *
 *      <campus>-campus-access-candidates.geojson  ──►  importAccessPoints  ──►  features
 *      (Backend tools/campus/accessCandidates.js)        (verified only)
 *
 * The register proposes where a footprint-only destination (ECE Department, Main
 * Building, …) could be served from: points on the sidewalk graph facing each
 * building, generated from geometry and checked with the engine's own routing
 * instruments. A generated point is a SUGGESTION. It may face a blank wall, a
 * locked door or a fence, and nothing in the data can tell.
 *
 * ── The rule this module exists to enforce ────────────────────────────────
 * Only an entry a PERSON has confirmed on site becomes a campus feature:
 *
 *   status `verified`, with review { by, on: YYYY-MM-DD, method }   → admitted
 *   status `candidate` / `needs_review`                               → pending
 *   status `rejected`                                                 → rejected
 *   anything malformed, off campus, for an unknown building, or
 *   claiming `verified` without a review                              → invalid
 *   a display name the operator could confuse: one a declared location
 *   or another building's access point already uses, or a footprint
 *   name several buildings share (RNSIT maps two "Canteen"s) with no
 *   `review.label` — every entry in the clash                        → invalid
 *
 * Pickup and drop are chosen by display name, so the names offered must be unique.
 *
 * The one exception is explicit and development-only (`developmentCandidates.js`): with
 * VITE_UNVERIFIED_CAMPUS_LOCATIONS=true in a non-production build, the `candidate` entries of
 * configured buildings are offered as "<building> — point <n> (unverified)", NOT_VERIFIED.
 *
 * Being inside the boundary, on the sidewalk, close to the building or routable
 * admits nothing. An admitted point carries `provenance: DERIVED_ACCESS_POINT`
 * (the coordinate was computed) and the verification its own review earned —
 * VERIFIED_BY_USER for an owner's site check, VERIFIED for a survey — never the
 * campus's blanket record, which does not cover this provenance.
 *
 * Pure module: no React, no Mapbox — loadable under plain Node by the tests.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import {
  CAMPUS_FEATURE_KIND,
  GEOMETRY_ROLE,
  PROVENANCE,
  VERIFICATION,
} from '../campusSchema.js';
import { pointInPolygon } from '../osm/osmCampusImport.js';
import { VERIFICATION_METHOD } from '../verification/campusVerification.js';

/** The register's status vocabulary (Backend `accessCandidates.STATUS`). */
export const ACCESS_STATUS = Object.freeze({
  CANDIDATE: 'candidate',
  NEEDS_REVIEW: 'needs_review',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
});

const PENDING = new Set([ACCESS_STATUS.CANDIDATE, ACCESS_STATUS.NEEDS_REVIEW]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const isArea = (geometry) => geometry?.type === 'Polygon' || geometry?.type === 'MultiPolygon';

/** Dataset metadata for the register file. */
export function accessPointDataset(file, campus) {
  return Object.freeze({
    file,
    campus,
    origin: `Access-point register (${file}) — generated candidates, admitted only when verified on site`,
  });
}

/** Why a review cannot verify anything, or [] when it can. */
export function reviewProblems(review) {
  if (!review || typeof review !== 'object') return ['no review { by, on, method } — nobody has confirmed it'];
  const problems = [];
  if (typeof review.by !== 'string' || !review.by.trim()) problems.push('review.by must name who checked it');
  if (typeof review.on !== 'string' || !ISO_DATE.test(review.on)) problems.push('review.on must be a YYYY-MM-DD date');
  if (!Object.values(VERIFICATION_METHOD).includes(review.method)) {
    problems.push(`review.method must be one of ${Object.values(VERIFICATION_METHOD).join(', ')}`);
  }
  if (review.label !== undefined && (typeof review.label !== 'string' || !review.label.trim())) {
    problems.push('review.label, when present, must be a non-empty name for this access point');
  }
  return problems;
}

/** How two display names are compared: case, surrounding and repeated whitespace ignored. */
const nameKey = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * @param {object|null} collection the register (a GeoJSON FeatureCollection)
 * @param {{ campusId: string, osmFeatures: object[], boundary: object|null, dataset?: object,
 *           declaredNames?: string[], developmentCandidateBuildings?: string[] }} context
 *   `declaredNames`: the names of the campus's declared point locations, which an admitted access
 *   point may not repeat. `developmentCandidateBuildings`: footprint ids whose UNVERIFIED
 *   `candidate` entries are offered too — only ever non-empty in development mode
 *   (`developmentCandidates.js`); absent or empty, only verified entries are admitted.
 * @returns {{ features: object[], pending: object[], rejected: object[], invalid: object[] }}
 */
export function importAccessPoints(
  collection,
  { campusId, osmFeatures, boundary, dataset, declaredNames, developmentCandidateBuildings }
) {
  const features = [];
  const pending = [];
  const rejected = [];
  const invalid = [];
  const boundaryGeometry = boundary?.geometry || null;
  const buildings = new Map((osmFeatures || []).filter((f) => isArea(f?.geometry)).map((f) => [f.id, f]));
  // How many footprints carry each name: RNSIT maps two different buildings as "Canteen".
  const footprintsNamed = new Map();
  for (const b of buildings.values()) footprintsNamed.set(nameKey(b.name), (footprintsNamed.get(nameKey(b.name)) || 0) + 1);
  const declared = new Set((declaredNames || []).map(nameKey));
  const developmentBuildings = new Set(developmentCandidateBuildings || []);
  const admittedIds = new Set();
  const labelsByBuilding = new Map();
  const accepted = [];

  // Each entry's position among its building's entries, in register order — the "point <n>" of a
  // development candidate's name. Stable while the register is: regeneration keeps file order.
  const ordinal = new Map();
  const perBuilding = new Map();
  for (const entry of collection?.features || []) {
    const b = entry?.properties?.buildingFeatureId;
    perBuilding.set(b, (perBuilding.get(b) || 0) + 1);
    ordinal.set(entry, perBuilding.get(b));
  }

  /** Where the entry is, and which footprint it serves — the checks every admitted entry passes. */
  const placeOf = (entry, props) => {
    const problems = [];
    if (typeof props.id !== 'string' || !props.id.trim()) problems.push('id is required');
    else if (admittedIds.has(props.id)) problems.push(`id "${props.id}" is already admitted`);
    if (props.campusId !== campusId) problems.push(`belongs to campus ${JSON.stringify(props.campusId)}, not ${campusId}`);
    const [lon, lat] = entry?.geometry?.type === 'Point' ? entry.geometry.coordinates || [] : [];
    if (!finite(lat) || !finite(lon)) problems.push('not a Point with finite [lon, lat] coordinates');
    else if (!boundaryGeometry || !pointInPolygon([lon, lat], boundaryGeometry)) problems.push('outside the campus boundary');
    const building = buildings.get(props.buildingFeatureId) || null;
    if (!building || building.sourceId !== props.buildingSourceId) {
      problems.push(`names no footprint of this campus (${props.buildingSourceId} / ${props.buildingFeatureId})`);
    }
    return { problems, building, lon, lat };
  };

  for (const entry of collection?.features || []) {
    const props = entry?.properties || {};
    const row = {
      id: props.id ?? null,
      status: props.status ?? null,
      buildingFeatureId: props.buildingFeatureId ?? null,
      buildingName: props.buildingName ?? null,
    };

    if (props.status === ACCESS_STATUS.REJECTED) {
      rejected.push({ ...row, reasons: props.review ? ['rejected on review'] : [...(props.rejections || [])] });
      continue;
    }
    // Development mode only: an unverified `candidate` of a configured building. Never a
    // `needs_review` entry, never a rejected one, and never recorded as verified.
    if (props.status === ACCESS_STATUS.CANDIDATE && developmentBuildings.has(props.buildingFeatureId)) {
      const { problems, building, lon, lat } = placeOf(entry, props);
      if (problems.length) {
        invalid.push({ ...row, problems });
        continue;
      }
      admittedIds.add(props.id);
      accepted.push({
        props,
        row,
        building,
        lon,
        lat,
        unverified: true,
        name: `${building.name} — point ${ordinal.get(entry)} (unverified)`,
      });
      continue;
    }
    if (PENDING.has(props.status)) {
      pending.push({ ...row, flags: [...(props.flags || [])] });
      continue;
    }

    const { problems, building, lon, lat } = placeOf(entry, props);
    if (props.status !== ACCESS_STATUS.VERIFIED) problems.unshift(`unknown status ${JSON.stringify(props.status)}`);
    problems.push(...reviewProblems(props.review));

    // Two verified points for one building need two names, or the form offers one name twice.
    const label = props.review?.label?.trim() || null;
    if (building) {
      const labels = labelsByBuilding.get(building.id) || [];
      if (labels.includes(nameKey(label))) {
        problems.push(
          `${building.name} already has a verified access point${label ? ` labelled "${label}"` : ''} — give each one a distinct review.label`
        );
      }
      // A building whose name another footprint shares cannot be told apart by that name.
      if (!label && (footprintsNamed.get(nameKey(building.name)) || 0) > 1) {
        problems.push(
          `"${building.name}" names ${footprintsNamed.get(nameKey(building.name))} footprints on this campus — ` +
            'a verified access point for one of them needs a distinct review.label'
        );
      }
    }

    if (problems.length) {
      invalid.push({ ...row, problems });
      continue;
    }

    admittedIds.add(props.id);
    labelsByBuilding.set(building.id, [...(labelsByBuilding.get(building.id) || []), nameKey(label)]);
    accepted.push({ props, row, building, lon, lat, name: label ? `${building.name} — ${label}` : building.name });
  }

  // Display names are what the operator chooses by, so each must be unique across the campus:
  // never a declared location's name, and never another building's. Every entry in a clash is
  // refused — keeping the first would let one name mean whichever building happened to be listed
  // first.
  const buildingsByName = new Map();
  for (const a of accepted) {
    const key = nameKey(a.name);
    buildingsByName.set(key, new Set([...(buildingsByName.get(key) || []), a.building.id]));
  }
  for (const a of accepted) {
    const { props, row, building, lon, lat, name, unverified } = a;
    const key = nameKey(name);
    const clash = [];
    if (declared.has(key)) clash.push(`"${name}" is already the name of a declared location`);
    const sharing = [...buildingsByName.get(key)].filter((id) => id !== building.id);
    if (sharing.length) clash.push(`"${name}" would also name an access point of ${sharing.join(', ')}`);
    if (clash.length) {
      invalid.push({ ...row, problems: [...clash, 'give it a distinct review.label'] });
      continue;
    }
    const common = {
      id: props.id,
      name,
      shortName: null,
      kind: CAMPUS_FEATURE_KIND.OPERATIONAL_POINT,
      category: building.category,
      labelPriority: 3,
      labelled: true,
      rendersOwnMarker: true,
      nameIsDescriptive: false,
      geometry: { type: 'Point', coordinates: [lon, lat] },
      geometryRole: GEOMETRY_ROLE.POINT_LOCATION,
      provenance: PROVENANCE.DERIVED_ACCESS_POINT,
      sourceId: props.id,
      servesFeatureId: building.id,
    };
    if (unverified) {
      // Offered for development and testing only. NOT_VERIFIED, with no reviewer and no date:
      // nothing here claims anyone has been to this point.
      features.push({
        ...common,
        verification: VERIFICATION.NOT_VERIFIED,
        verifiedOn: null,
        unverifiedCandidate: true,
        source:
          `Access-point register — ${dataset?.file || 'access candidates'} (${props.id}), ` +
          `${props.derivation?.method || 'derived'}, UNVERIFIED development candidate`,
        metadata: {
          'Serves': `${building.name} (${building.sourceId})`,
          'Derived by': String(props.derivation?.method || 'unknown'),
          'Status': 'UNVERIFIED candidate — offered only in development mode; not checked on site',
        },
      });
      continue;
    }
    const survey = props.review.method === VERIFICATION_METHOD.SURVEY;
    features.push({
      ...common,
      verification: survey ? VERIFICATION.VERIFIED : VERIFICATION.VERIFIED_BY_USER,
      verifiedOn: props.review.on,
      verifiedBy: props.review.by.trim(),
      verificationMethod: props.review.method,
      source:
        `Access-point register — ${dataset?.file || 'access candidates'} (${props.id}), ` +
        `${props.derivation?.method || 'derived'}, confirmed on site`,
      metadata: {
        'Serves': `${building.name} (${building.sourceId})`,
        'Derived by': String(props.derivation?.method || 'unknown'),
        'Confirmed': `${props.review.by.trim()} on ${props.review.on} — ${props.review.method}`,
        ...(props.review.note ? { 'Review note': String(props.review.note) } : {}),
      },
    });
  }

  return { features, pending, rejected, invalid };
}

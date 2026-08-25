/**
 * ═══════════════════════════════════════════════════════════════════════════
 * OPERATIONAL SEMANTICS — which campus features the FLEET has business with
 *
 *   campus feature  ──►  deriveOperationalProfile()  ──►  { operationalRole,
 *                                                           operationalPriority,
 *                                                           labelRank, poiScale,
 *                                                           access? }
 *
 * ── The distinction this module draws (§3C) ───────────────────────────────
 * Not "important vs unimportant". A campus map needs the statue and the
 * fountain: an operator navigates BY them. The question here is different — is
 * this a place a robot is SENT TO or THROUGH? A gate, a parking apron, a food
 * court, a department: yes. A memorial: no. Only the first group earns
 * operational prominence — a larger marker, a label that wins a collision,
 * survival in Operations mode.
 *
 * ── Derivation, not assertion (§4) ────────────────────────────────────────
 * Every role below is read off fields the feature ALREADY DECLARES — its kind,
 * its category, the `kind` word the supplemental dataset supplied, or an OSM
 * tag. Nothing is decided by position, by size, or by a hard-coded feature id,
 * and every profile records `operationalBasis` so the derivation shows up in
 * the details card instead of passing as source data.
 *
 * The one stage that reads a NAME reuses the same rule table the OSM importer
 * already uses for categories, for the same reason it does: OSM asserts
 * "Canteen", and concluding from that name that the building serves food is
 * reading the source, not guessing at it. Delete every name rule and the map is
 * still geographically correct — every feature simply becomes role NONE.
 *
 * ── What is deliberately empty ────────────────────────────────────────────
 * `CHARGING_POINT` and `DOCKING_STATION` have rules and ZERO features. No
 * dataset here says where a charger or a dock is, and this module will not
 * decide that a parking apron is probably where robots dock. The rules exist so
 * that the day such a record arrives, supporting it is one row in the table
 * below — asserted by test, which fails if anything ever starts claiming one
 * without a source.
 *
 * Pure module: no React, no Mapbox — loadable under plain Node.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import {
  ACCESS_STATE,
  CAMPUS_CATEGORY,
  CAMPUS_FEATURE_KIND,
  GATE_ACCESS_CHANNELS,
  GATE_STATUS,
  OPERATIONAL_ROLE,
  operationalPriorityFor,
  unknownGateAccess,
} from '../campusSchema.js';

// ── Rule tables ──────────────────────────────────────────────────────────────

/** The `kind` word the supplemental dataset supplies → an operational role. */
const SOURCE_KIND_ROLE = Object.freeze({
  GATE: OPERATIONAL_ROLE.GATE,
  DEPARTMENT: OPERATIONAL_ROLE.DEPARTMENT,
  PARKING: OPERATIONAL_ROLE.PARKING,
  /** Declared, unused: no supplemental record uses either word today. */
  CHARGING: OPERATIONAL_ROLE.CHARGING_POINT,
  DOCKING: OPERATIONAL_ROLE.DOCKING_STATION,
});

/** An OSM `amenity` value → an operational role. */
const AMENITY_ROLE = Object.freeze({
  parking: OPERATIONAL_ROLE.PARKING,
  motorcycle_parking: OPERATIONAL_ROLE.PARKING,
  bicycle_parking: OPERATIONAL_ROLE.PARKING,
  food_court: OPERATIONAL_ROLE.FOOD_SERVICE,
  fast_food: OPERATIONAL_ROLE.FOOD_SERVICE,
  cafe: OPERATIONAL_ROLE.FOOD_SERVICE,
  restaurant: OPERATIONAL_ROLE.FOOD_SERVICE,
  canteen: OPERATIONAL_ROLE.FOOD_SERVICE,
  bank: OPERATIONAL_ROLE.SERVICE_POINT,
  library: OPERATIONAL_ROLE.SERVICE_POINT,
  post_office: OPERATIONAL_ROLE.SERVICE_POINT,
  /** Declared, unused: the extract carries no charging station. */
  charging_station: OPERATIONAL_ROLE.CHARGING_POINT,
});

/**
 * Name rules, applied ONLY where every tag was silent — the same discipline
 * `osmCampusImport.NAME_CATEGORY_RULES` follows. Ordered; first match wins.
 */
const NAME_ROLE_RULES = Object.freeze([
  Object.freeze({ pattern: /\b(canteen|cafeteria|mess|cafe|food ?court)\b/i, role: OPERATIONAL_ROLE.FOOD_SERVICE }),
  Object.freeze({ pattern: /\b(parking)\b/i, role: OPERATIONAL_ROLE.PARKING }),
  Object.freeze({ pattern: /\b(department|dept)\b/i, role: OPERATIONAL_ROLE.DEPARTMENT }),
  Object.freeze({ pattern: /\b(bank|atm|library|office|administration|admin|reception)\b/i, role: OPERATIONAL_ROLE.SERVICE_POINT }),
]);

/** Categories that make a NAMED building a delivery destination. */
const CATEGORY_ROLE = Object.freeze({
  [CAMPUS_CATEGORY.ACADEMIC]: OPERATIONAL_ROLE.DEPARTMENT,
  [CAMPUS_CATEGORY.ADMINISTRATIVE]: OPERATIONAL_ROLE.SERVICE_POINT,
  [CAMPUS_CATEGORY.COMMERCIAL]: OPERATIONAL_ROLE.SERVICE_POINT,
});

/** Kinds that can be an operational destination at all. */
const DESTINATION_KINDS = new Set([
  CAMPUS_FEATURE_KIND.BUILDING,
  CAMPUS_FEATURE_KIND.FACILITY,
  CAMPUS_FEATURE_KIND.OPERATIONAL_POINT,
]);

export const OPERATIONAL_BASIS = Object.freeze({
  KIND: 'KIND',
  SUPPLIED_KIND: 'SUPPLIED_KIND',
  OSM_TAG: 'OSM_TAG',
  SOURCE_NAME: 'SOURCE_NAME',
  CATEGORY: 'CATEGORY',
  NONE: 'NONE',
});

/**
 * How much bigger than an ordinary campus POI this marker draws.
 *
 * Bounded on purpose. §3B asks for a gate that is recognisable WITHOUT being
 * huge, and a marker that outgrows the robot it sits beside is a defect: the
 * robot is the object an operator is reading. 1.45× a 4.5px dot is ~6.5px.
 */
const POI_SCALE = Object.freeze({
  GATE: 1.45,
  DOCKING_STATION: 1.3,
  CHARGING_POINT: 1.3,
  PICKUP_DROP_POINT: 1.3,
  PARKING: 1.15,
  FOOD_SERVICE: 1.15,
  DEPARTMENT: 1.15,
  SERVICE_POINT: 1.05,
  NONE: 1,
});

// ── Gate access ──────────────────────────────────────────────────────────────

/**
 * Source access words → the schema's vocabulary.
 *
 * Every gate on this campus supplies `UNKNOWN` for every channel, so nothing
 * below fires today. It exists because the alternative — reading an OSM
 * `motor_vehicle=no` and silently dropping it — is how a routing-relevant fact
 * gets lost, and because a translation table is the correct place for the
 * decision that OSM's `private` is RESTRICTED rather than PROHIBITED.
 */
const ACCESS_WORD = Object.freeze({
  YES: ACCESS_STATE.ALLOWED,
  ALLOWED: ACCESS_STATE.ALLOWED,
  DESIGNATED: ACCESS_STATE.ALLOWED,
  PERMISSIVE: ACCESS_STATE.ALLOWED,
  PRIVATE: ACCESS_STATE.RESTRICTED,
  CUSTOMERS: ACCESS_STATE.RESTRICTED,
  DESTINATION: ACCESS_STATE.RESTRICTED,
  RESTRICTED: ACCESS_STATE.RESTRICTED,
  NO: ACCESS_STATE.PROHIBITED,
  PROHIBITED: ACCESS_STATE.PROHIBITED,
  UNKNOWN: ACCESS_STATE.UNKNOWN,
});

const GATE_STATUS_WORD = Object.freeze({
  OPEN: GATE_STATUS.OPEN,
  CLOSED: GATE_STATUS.CLOSED,
  LOCKED: GATE_STATUS.CLOSED,
  MANNED: GATE_STATUS.MANNED,
  ATTENDED: GATE_STATUS.MANNED,
  UNKNOWN: GATE_STATUS.UNKNOWN,
});

/** Which source keys, in order of precedence, answer for each traffic class. */
const ACCESS_SOURCE_KEYS = Object.freeze({
  vehicle: ['vehicleAccess', 'motor_vehicle', 'vehicle', 'motorcar'],
  pedestrian: ['pedestrianAccess', 'foot'],
  service: ['serviceAccess', 'hgv', 'goods'],
  emergency: ['emergencyAccess', 'emergency'],
});

function readWord(table, raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return table[raw.trim().toUpperCase()] || null;
}

/**
 * Read a gate's access rules off whatever the source actually said.
 *
 * Returns every channel explicitly, defaulting to UNKNOWN. `known` reports
 * whether ANY channel carries real information, so the UI can say "access rules
 * not recorded" once instead of printing four UNKNOWNs (§3B).
 */
export function deriveGateAccess(feature) {
  const tags = feature?.sourceTags || {};
  const access = unknownGateAccess();
  const basis = {};

  for (const channel of GATE_ACCESS_CHANNELS) {
    for (const key of ACCESS_SOURCE_KEYS[channel]) {
      const mapped = readWord(ACCESS_WORD, tags[key]);
      if (mapped) {
        access[channel] = mapped;
        if (mapped !== ACCESS_STATE.UNKNOWN) basis[channel] = `${key}=${tags[key]}`;
        break;
      }
    }
  }

  // A generic `access=*` answers for every channel that said nothing specific.
  const generic = readWord(ACCESS_WORD, tags.access ?? tags.accessType);
  if (generic && generic !== ACCESS_STATE.UNKNOWN) {
    for (const channel of GATE_ACCESS_CHANNELS) {
      if (access[channel] === ACCESS_STATE.UNKNOWN) {
        access[channel] = generic;
        basis[channel] = `access=${tags.access ?? tags.accessType}`;
      }
    }
  }

  const status = readWord(GATE_STATUS_WORD, tags.gateStatus ?? tags.barrier_status ?? tags.status);
  if (status) access.status = status;

  const known =
    access.status !== GATE_STATUS.UNKNOWN ||
    GATE_ACCESS_CHANNELS.some((c) => access[c] !== ACCESS_STATE.UNKNOWN);

  return { access, known, basis };
}

// ── Role derivation ──────────────────────────────────────────────────────────

function tagValue(tags, key) {
  const v = tags?.[key];
  return typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null;
}

/**
 * What operational role does this feature play, and on what evidence?
 *
 * @returns {{ role: string, basis: string, from: string|null }}
 */
export function deriveOperationalRole(feature) {
  const kind = feature?.kind;

  // 1. A gate is a gate because the model says it is one. Nothing else needed.
  if (kind === CAMPUS_FEATURE_KIND.GATE) {
    return { role: OPERATIONAL_ROLE.GATE, basis: OPERATIONAL_BASIS.KIND, from: 'kind=GATE' };
  }

  // Circulation, ground and the campus record itself are not destinations. A
  // road is how a robot gets somewhere, never the somewhere.
  if (!DESTINATION_KINDS.has(kind)) {
    return { role: OPERATIONAL_ROLE.NONE, basis: OPERATIONAL_BASIS.NONE, from: null };
  }

  // A feature the source never named has no identity to be a destination FOR.
  // "Unnamed building" is not somewhere a task can be addressed to (§4).
  if (feature?.nameIsDescriptive) {
    return { role: OPERATIONAL_ROLE.NONE, basis: OPERATIONAL_BASIS.NONE, from: null };
  }

  // 2. The word the supplemental dataset itself supplied.
  const supplied = String(feature?.sourceKind || '').trim().toUpperCase();
  if (supplied && SOURCE_KIND_ROLE[supplied]) {
    return {
      role: SOURCE_KIND_ROLE[supplied],
      basis: OPERATIONAL_BASIS.SUPPLIED_KIND,
      from: `supplied kind "${feature.sourceKind}"`,
    };
  }

  // 3. An OSM tag that names a use.
  const tags = feature?.sourceTags || {};
  for (const key of ['amenity', 'shop', 'office']) {
    const value = tagValue(tags, key);
    if (value && AMENITY_ROLE[value]) {
      return { role: AMENITY_ROLE[value], basis: OPERATIONAL_BASIS.OSM_TAG, from: `${key}=${value}` };
    }
  }

  // 4. The name the source itself asserts.
  const name = typeof feature?.name === 'string' ? feature.name : '';
  for (const rule of NAME_ROLE_RULES) {
    if (rule.pattern.test(name)) {
      return {
        role: rule.role,
        basis: OPERATIONAL_BASIS.SOURCE_NAME,
        from: `name "${name}" — derived from the name, not from a tag`,
      };
    }
  }

  // 5. The semantic category the importer already settled.
  const byCategory = CATEGORY_ROLE[feature?.category];
  if (byCategory) {
    return { role: byCategory, basis: OPERATIONAL_BASIS.CATEGORY, from: `category=${feature.category}` };
  }

  return { role: OPERATIONAL_ROLE.NONE, basis: OPERATIONAL_BASIS.NONE, from: null };
}

/**
 * The full operational profile for one feature.
 *
 * Never mutates. Returns the fields to merge onto the feature; the caller (the
 * registry, at the merge point) decides whether to apply them.
 */
export function deriveOperationalProfile(feature) {
  const { role, basis, from } = deriveOperationalRole(feature);
  const priority = operationalPriorityFor(role);

  const profile = {
    operationalRole: role,
    operationalPriority: priority,
    operationalBasis: basis,
    /** The exact evidence, carried so the details card can show the derivation. */
    operationalFrom: from,
    /**
     * Label collision rank — LOWER WINS. Mapbox drops the higher `symbol-sort-key`
     * when two labels overlap, so this is what makes the gate survive a
     * collision with an unnamed facility rather than the other way round (§3K).
     */
    labelRank: priority,
    poiScale: POI_SCALE[role] ?? 1,
  };

  if (feature?.kind === CAMPUS_FEATURE_KIND.GATE) {
    const { access, known, basis: accessBasis } = deriveGateAccess(feature);
    profile.access = access;
    profile.accessKnown = known;
    profile.accessBasis = accessBasis;
  }

  return profile;
}

/**
 * Apply operational profiles across a feature list.
 *
 * Returns a NEW array of NEW objects; geometry is passed through by reference,
 * so no coordinate is copied, rounded or moved (§3P).
 */
export function applyOperationalProfiles(features) {
  const list = Array.isArray(features) ? features : [];
  return list.map((f) => {
    const profile = deriveOperationalProfile(f);
    const metadata = { ...f.metadata };

    if (profile.operationalRole !== OPERATIONAL_ROLE.NONE) {
      metadata['Operational role'] = profile.operationalFrom
        ? `${humaniseRole(profile.operationalRole)} — from ${profile.operationalFrom}`
        : humaniseRole(profile.operationalRole);
    }
    if (profile.access) {
      metadata['Gate access'] = profile.accessKnown
        ? GATE_ACCESS_CHANNELS.map((c) => `${c}: ${profile.access[c]}`).join(' · ')
        : 'Not recorded — vehicle, pedestrian, service and emergency access are all UNKNOWN for this gate';
    }

    return { ...f, ...profile, metadata };
  });
}

function humaniseRole(role) {
  return String(role || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

// ── "Where is this unit?" answered in campus terms (§3N) ─────────────────────

/**
 * The nearest NAMED campus feature to a position, with the distance.
 *
 * ── Why the distance is never omitted ─────────────────────────────────────
 * "Nearest: CSE Department" alone is a claim an operator will read as "the
 * robot is at CSE". With "· 84 m" beside it, it is what it actually is: a
 * measurement between two coordinates the map already holds. §3N forbids
 * inventing data, and a proximity presented without its magnitude is exactly
 * that — a derived number dressed as a location.
 *
 * Descriptive names ("Unnamed building") are skipped: they identify nothing, so
 * they cannot orient anybody.
 *
 * @param {object[]} features  validated campus features
 * @param {[number,number]|null} point  `[lon, lat]`
 * @param {(geometry: object) => ([number,number]|null)} anchorOf
 *        how to derive a comparable point from a geometry — injected so this
 *        module stays free of any dependency on the layer code.
 * @returns {null | { id: string, name: string, metres: number, role: string }}
 */
export function nearestNamedFeature(features, point, anchorOf) {
  if (!Array.isArray(features) || !Array.isArray(point) || typeof anchorOf !== 'function') return null;

  const kx = 111320 * Math.cos((point[1] * Math.PI) / 180);
  const ky = 110574;

  let best = null;
  for (const f of features) {
    if (!f || f.nameIsDescriptive || f.kind === CAMPUS_FEATURE_KIND.BOUNDARY) continue;
    // Roads and paths are how a unit gets somewhere, not somewhere it is — and
    // their anchor is a midpoint that can be a hundred metres from the bit the
    // robot is actually on, which would make the number meaningless.
    if (f.kind === CAMPUS_FEATURE_KIND.ROAD || f.kind === CAMPUS_FEATURE_KIND.PATH) continue;

    const anchor = anchorOf(f.geometry);
    if (!Array.isArray(anchor)) continue;
    const d = Math.hypot((point[0] - anchor[0]) * kx, (point[1] - anchor[1]) * ky);
    if (best === null || d < best.metres) {
      best = { id: f.id, name: f.name, metres: d, role: f.operationalRole || OPERATIONAL_ROLE.NONE };
    }
  }
  return best;
}

/** Counts by role, for the report and the architecture tests. */
export function describeOperationalModel(features) {
  const byRole = {};
  for (const f of Array.isArray(features) ? features : []) {
    const role = f?.operationalRole || OPERATIONAL_ROLE.NONE;
    byRole[role] = (byRole[role] || 0) + 1;
  }
  return {
    byRole,
    operational: Object.entries(byRole)
      .filter(([role]) => role !== OPERATIONAL_ROLE.NONE)
      .reduce((n, [, count]) => n + count, 0),
  };
}

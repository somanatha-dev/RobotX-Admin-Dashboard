/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAMPUS VERIFICATION — who checked this campus, when, and what that covers
 *
 *      OSM extract        ──► importOsmCampus        ─┐
 *                                                     ├─► applyCampusVerification
 *      supplemental file  ──► importSupplemental     ─┘            │
 *                                                                  ▼
 *                                                       features that carry BOTH
 *                                                       where they came from AND
 *                                                       who confirmed them
 *
 * ── Why this is a separate module and not a field in the importers ────────
 * An importer cannot verify anything. It reads a file and classifies it; it has
 * never been to Bengaluru. If `osmCampusImport` emitted VERIFIED_BY_USER, then
 * "verified" would mean "loaded", and the distinction the whole schema is built
 * around would be gone — which is exactly how a provenance model dies. So the
 * importers keep emitting `NOT_VERIFIED` (asserted by their own tests), and a
 * verification is a SEPARATE, DATED, ATTRIBUTED RECORD applied afterwards, at
 * the one merge point, by this module.
 *
 * That also makes the check auditable. There is one object below saying who
 * checked what and when. Revoking it is deleting that object; widening it is
 * editing one field. Neither requires touching a single feature.
 *
 * ── What this module will not do (§3P) ────────────────────────────────────
 *   • It does not touch geometry. The emitted feature's `geometry` is the SAME
 *     OBJECT as the input's — asserted by test.
 *   • It does not touch provenance, `source`, `sourceId` or `sourceTags`. The
 *     original record survives intact: a feature that came from OpenStreetMap
 *     still says OpenStreetMap after the owner confirms it. Where it came from
 *     and who checked it are two facts and both are kept (§3A).
 *   • It does not mutate its input. It returns a new array of new objects.
 *   • It does not promote anything to `VERIFIED`. An owner's confirmation is
 *     `VERIFIED_BY_USER`; only a survey or a site plan earns the other word,
 *     and no such source exists for RNSIT.
 *   • It does not verify what the record does not cover. A feature whose
 *     provenance is outside `covers` is returned untouched.
 *
 * Pure module: no React, no Mapbox — loadable under plain Node by the tests.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { PROVENANCE, VERIFICATION } from '../campusSchema.js';

/**
 * How a check was carried out. Not decoration: an operator reading "verified"
 * is entitled to know whether that meant a GNSS receiver or a person who works
 * on the site saying "yes, that is where the gate is".
 */
export const VERIFICATION_METHOD = Object.freeze({
  /** Georeferenced site plan / survey / RTK walk-around. Nothing here holds this. */
  SURVEY: 'SURVEY',
  /**
   * The project owner confirming features against the campus they operate on —
   * first-hand knowledge of the physical site, not an instrument reading.
   */
  OWNER_SITE_CHECK: 'OWNER_SITE_CHECK',
});

/**
 * The verification record for RNSIT.
 *
 * `covers` is the load-bearing field. The owner confirmed the CAMPUS FEATURES —
 * the imported geometry and the supplied locations. That is what this record
 * claims and it is all it claims. The seeded `Campus.centerLat/centerLon`
 * database row is deliberately NOT in it: it is a record in this repository's
 * own database, not a place anybody walked to, and the map already cross-checks
 * it against the boundary (`centreWithinBoundary`) rather than asserting it.
 */
export const CAMPUS_VERIFICATION = Object.freeze({
  RNSIT: Object.freeze({
    campus: 'RNSIT',
    verifiedBy: 'Project owner',
    verifiedOn: '2026-08-23',
    method: VERIFICATION_METHOD.OWNER_SITE_CHECK,
    covers: Object.freeze([PROVENANCE.OPEN_DATA_IMPORT, PROVENANCE.USER_SUPPLIED]),
    statement:
      'The project owner has personally checked these campus locations and features against the ' +
      'RNS Institute of Technology site. This is a first-hand confirmation by the person who ' +
      'operates the fleet here — it is not a georeferenced survey, and nothing in this system ' +
      'claims one.',
    /** Said out loud so a later reader does not have to infer the boundary of the claim. */
    doesNotCover: Object.freeze([
      'The seeded campus centre in the database (Campus.centerLat / centerLon) — a repository ' +
        'record, cross-checked against the imported boundary rather than confirmed on site.',
      'Metre-level positional accuracy of the imported footprints. The owner confirmed WHAT ' +
        'each feature is and WHERE it is on the campus; the vertices are still OpenStreetMap\'s.',
      'Drawn building heights. No source carries a measured height and confirming a location ' +
        'does not measure one — see `heightBasis` on every building.',
      'Gate access rules — vehicle, pedestrian, service, emergency, opening status. All ' +
        'explicitly UNKNOWN; a confirmed location is not a confirmed access policy.',
    ]),
  }),
});

/** The verification record for a campus code, or null if nobody has checked it. */
export function campusVerificationFor(code) {
  return CAMPUS_VERIFICATION[String(code || '').trim()] || null;
}

/** Human sentence for a verification state, used by the details card and the notice. */
export const VERIFICATION_LABEL = Object.freeze({
  VERIFIED: 'Verified — survey',
  VERIFIED_BY_USER: 'Verified by project owner',
  NOT_VERIFIED: 'Not verified',
});

/**
 * Apply a verification record to imported campus features.
 *
 * @param {object[]} features  imported campus features (any provenance)
 * @param {object|null} record a `CAMPUS_VERIFICATION` entry, or null for none
 * @returns {{ features: object[], verified: number, skipped: number }}
 *          `features` is a NEW array; unverified entries are the ORIGINAL
 *          objects, so a campus with no record costs nothing at all.
 */
export function applyCampusVerification(features, record) {
  const list = Array.isArray(features) ? features : [];
  if (!record) return { features: list, verified: 0, skipped: list.length };

  const covers = new Set(Array.isArray(record.covers) ? record.covers : []);
  let verified = 0;
  let skipped = 0;

  const out = list.map((f) => {
    // Outside the record's scope, or already carrying a stronger claim than
    // this record makes. Neither is upgraded and neither is downgraded.
    if (!covers.has(f?.provenance) || f?.verification === VERIFICATION.VERIFIED) {
      skipped += 1;
      return f;
    }

    verified += 1;
    return {
      ...f,
      // Untouched, and named here so the omission is visible rather than
      // implied: geometry, provenance, source, sourceId and sourceTags all
      // travel through the spread exactly as they arrived (§3P).
      verification: VERIFICATION.VERIFIED_BY_USER,
      verifiedBy: record.verifiedBy,
      verifiedOn: record.verifiedOn,
      verificationMethod: record.method,
      metadata: {
        ...f.metadata,
        'Campus verification': `Confirmed by ${record.verifiedBy} on ${record.verifiedOn} — ${
          record.method === VERIFICATION_METHOD.SURVEY ? 'survey' : 'first-hand check of the site'
        }. The geometry's original source is unchanged.`,
      },
    };
  });

  return { features: out, verified, skipped };
}

/** Summary for the on-map notice and the architecture tests. */
export function describeCampusVerification(features, record) {
  const list = Array.isArray(features) ? features : [];
  const byState = {};
  for (const f of list) {
    const state = f?.verification || 'MISSING';
    byState[state] = (byState[state] || 0) + 1;
  }
  return {
    record: record || null,
    total: list.length,
    byState,
    ownerVerified: byState[VERIFICATION.VERIFIED_BY_USER] || 0,
    surveyed: byState[VERIFICATION.VERIFIED] || 0,
    unverified: byState[VERIFICATION.NOT_VERIFIED] || 0,
  };
}

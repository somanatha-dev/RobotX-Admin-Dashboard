/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DEVELOPMENT CANDIDATE LOCATIONS — unverified access points, for development only
 *
 * The production rule is unchanged: a register entry becomes a task location only when a
 * person has verified it on site (`accessPointImport.js`). This module is the one, explicit
 * exception, for building and testing the software before those site reviews exist:
 *
 *   VITE_UNVERIFIED_CAMPUS_LOCATIONS=true   (e.g. in Frontend/.env.development.local)
 *
 * When — and only when — that flag is set in a NON-production build, the `candidate`
 * entries of the buildings listed below are offered too, named
 * "<building> — point <n> (unverified)" and recorded NOT_VERIFIED. Nothing else changes:
 * `needs_review` and `rejected` entries stay out, coordinates are the register's own, the
 * unique-name rule applies, and a production build (`vite build`, NODE_ENV=production)
 * ignores the flag entirely.
 *
 * These points are generated suggestions on the sidewalk network facing each building. They
 * are NOT certified delivery points: nobody has confirmed a robot can stop there or that the
 * entrance is reachable (docs/runbooks/campus-access-point-review.md).
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** The opt-in flag. Vite exposes only VITE_-prefixed variables to the browser. */
export const DEVELOPMENT_CANDIDATE_FLAG = 'VITE_UNVERIFIED_CAMPUS_LOCATIONS';

/**
 * The buildings whose `candidate` entries development mode offers, by campus. The six RNSIT
 * departments whose candidates carry no review flag. The canteens, Main Building, auditorium
 * and Canara Bank footprint are deliberately absent: their candidates need a judgement
 * (duplicate names, flags) before anyone should be able to pick them.
 */
export const DEVELOPMENT_CANDIDATE_BUILDINGS = Object.freeze({
  RNSIT: Object.freeze([
    'osm-way-204638929', // CSE, ISE & CSDS Department
    'osm-way-204638932', // ECE Department
    'osm-way-204638941', // RNSIT Mec and EEE Department
    'osm-way-204638943', // RNSIT MBA block
    'osm-way-1486312656', // RNSIT Civil and AIML Block
    'osm-way-1224941276', // RNS International School
  ]),
});

/** Is this a production build or process? Then the flag is ignored, whatever its value. */
function isProduction(env) {
  return env?.PROD === true || env?.PROD === 'true' || env?.MODE === 'production' || env?.NODE_ENV === 'production';
}

/**
 * Is development mode on for this environment?
 *
 * @param {object} env `import.meta.env` under Vite; `process.env` under plain Node
 * @returns {boolean}
 */
export function developmentCandidatesEnabled(env) {
  return env?.[DEVELOPMENT_CANDIDATE_FLAG] === 'true' && !isProduction(env);
}

/**
 * The building ids development mode offers for a campus in this environment — [] when it is off.
 *
 * @param {string} campusId
 * @param {object} env
 * @returns {string[]}
 */
export function developmentCandidateBuildingsFor(campusId, env) {
  return developmentCandidatesEnabled(env) ? [...(DEVELOPMENT_CANDIDATE_BUILDINGS[campusId] || [])] : [];
}

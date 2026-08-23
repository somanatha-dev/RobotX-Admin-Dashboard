/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CAMPUS CAMERA — framings for a place, and the rule that only one wins
 *
 * Two things live here, and they are related:
 *
 *   1. CAMERA MODES (§28) — Overview / Operations / Follow / Reset. Framings,
 *      not effects; each one is chosen for what an operator can DO from it.
 *   2. THE SEQUENCER (§51) — the single mechanism that guarantees rapid filter
 *      changes converge on the LATEST target instead of leaving two flights
 *      fighting over the camera.
 *
 * ── Why bearing stays at 0 ────────────────────────────────────────────────
 * A rotated campus view photographs better. It also means north is no longer
 * screen-up, so an operator matching the map against the physical site has to
 * do the rotation in their head, and every robot heading has to be re-read
 * against a moved reference. §27 settles it: operational usefulness wins. Tilt
 * buys real depth information; a default bearing buys a nicer screenshot. The
 * operator can still rotate freely — this is only where the camera lands.
 *
 * Pure module: no React, no Mapbox.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const CAMPUS_CAMERA_MODE = Object.freeze({
  /** The whole campus in frame — the default arrival framing. */
  OVERVIEW: 'OVERVIEW',
  /** Closer and more tilted: the active operational area, buildings resolvable. */
  OPERATIONS: 'OPERATIONS',
  /** Track the selected robot, keeping the 3D environment around it. */
  FOLLOW: 'FOLLOW',
});

export const CAMPUS_CAMERA_MODE_ORDER = Object.freeze([
  CAMPUS_CAMERA_MODE.OVERVIEW,
  CAMPUS_CAMERA_MODE.OPERATIONS,
  CAMPUS_CAMERA_MODE.FOLLOW,
]);

export const CAMPUS_CAMERA_MODE_LABEL = Object.freeze({
  OVERVIEW: 'Overview',
  OPERATIONS: 'Operations',
  FOLLOW: 'Follow',
});

/**
 * Framings. `zoom` is where the camera settles; `pitch` is applied on arrival,
 * never during a long flight (see ARCHITECTURE.md — a pitched flight across
 * many zoom levels with terrain enabled ends pointing at atmosphere).
 */
export const CAMPUS_CAMERA_PRESETS = Object.freeze({
  OVERVIEW: Object.freeze({ zoom: 16.6, pitch: 48, bearing: 0 }),
  OPERATIONS: Object.freeze({ zoom: 17.8, pitch: 58, bearing: 0 }),
  FOLLOW: Object.freeze({ zoom: 18.2, pitch: 55, bearing: 0 }),
});

export function campusCameraFor(mode) {
  return CAMPUS_CAMERA_PRESETS[mode] || CAMPUS_CAMERA_PRESETS.OVERVIEW;
}

/**
 * The camera-command sequencer.
 *
 * Every camera command takes a token. A command may only touch the map while
 * its token is still the newest one issued. Selecting India → Karnataka →
 * Bengaluru → RNSIT in under a second issues four commands; the first three
 * are superseded before their deferred stages (the tilt, the campus reveal)
 * ever run, so the camera converges on RNSIT rather than tilting toward
 * Karnataka after arriving at the campus.
 *
 * Deterministic and side-effect free, so the convergence rule is a unit test
 * rather than something judged by watching a map.
 */
export function createCameraSequencer() {
  let issued = 0;
  // Set by `cancel`, cleared by the next `begin`. Without it, cancelling would
  // leave the newly-incremented number looking like a live token, so a reset
  // that is meant to stop all camera work would hand one out.
  let revoked = false;

  return {
    /** Claim the camera. Every earlier token is superseded from this moment. */
    begin() {
      issued += 1;
      revoked = false;
      return issued;
    },
    /** May a deferred stage of `token` still act? */
    isCurrent(token) {
      return !revoked && token === issued && token > 0;
    },
    /** Supersede everything outstanding without issuing a usable token. */
    cancel() {
      issued += 1;
      revoked = true;
    },
    get current() {
      return issued;
    },
  };
}

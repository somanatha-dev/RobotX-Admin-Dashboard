/**
 * The simulator's pseudo-random source — one deterministic stream per robot.
 *
 * ── Why the global `Math.random()` was not good enough ───────────────────────
 * Two of the simulator's behaviours drew from it: the speed model's per-tick jitter and
 * the obstacle report. Both are non-critical in the sense that nothing decides anything
 * safety-relevant from them, and neither was *wrong*. But `Math.random()` is one stream
 * shared by the whole process, and that has two consequences a demo and a test both care
 * about:
 *
 *   1. **Runs are not reproducible.** A movement trace that cannot be replayed cannot be
 *      compared, so "the robot behaved oddly at 14:02" is not a report anyone can act on.
 *   2. **Robots are coupled through the generator.** Draw order decides who gets which
 *      number, so adding a third simulated robot changes the second one's speed trace —
 *      the robots share mutable state, which is exactly what §3's independence requirement
 *      forbids. It is invisible coupling: no field is shared, but the sequence is.
 *
 * One stream per robot, seeded from the robot's own identifier, removes both. SIM-A's
 * numbers are the same whether it runs alone or alongside four others, and the same today
 * as tomorrow.
 *
 * ── What this is not ────────────────────────────────────────────────────────
 * Not a cryptographic generator, and never to be used as one — `crypto.randomUUID()`
 * remains what mints a session token. This is for simulation jitter, where the
 * requirement is reproducibility, not unpredictability.
 */

/**
 * FNV-1a, 32-bit. Turns a robot identifier into a seed.
 *
 * Chosen because it is short, has no dependencies and — the property that matters here —
 * gives visibly different seeds for the near-identical strings this system actually uses.
 * `SIM-000000000001` and `SIM-000000000002` differ in one character, and a weaker mixer
 * would hand them adjacent seeds and therefore near-identical first draws, which would
 * make two robots look synchronised on a dashboard.
 *
 * @param {string} text
 * @returns {number} an unsigned 32-bit integer
 */
function hashSeed(text) {
  const source = String(text === undefined || text === null ? "" : text);
  // @structural FNV-1a 32-bit offset basis and prime
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Mulberry32 — a 32-bit PRNG with a 2^32 period.
 *
 * The period is the reason to state the choice rather than reach for something larger: a
 * robot drawing twice per 2-second tick exhausts 2^32 draws after roughly 136 years of
 * continuous simulation, so the period is not a constraint on any run this will see. What
 * it buys instead is a generator whose entire state is one integer, which is what makes
 * `forkSeed` below meaningful and what makes a stream cheap enough to give every robot
 * its own.
 *
 * @param {number|string} seed a number used directly, or any string hashed by `hashSeed`
 * @returns {() => number} successive values in [0, 1)
 */
function createRandom(seed) {
  let state = (typeof seed === "number" && Number.isFinite(seed) ? seed : hashSeed(seed)) >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    // @structural 2^32, to map a uint32 onto [0, 1)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A seed for one named sub-stream of a parent seed.
 *
 * Speed jitter and obstacle reports draw from **separate** streams rather than taking
 * turns on one. Sharing a stream would reintroduce the coupling this module exists to
 * remove, one level down: an obstacle report consumes a draw, so whether one happened on
 * tick 40 would decide which jitter value tick 41 sees. Separate streams mean the speed
 * trace is the same whether or not an obstacle was reported, which is what makes a
 * movement test independent of an obstacle test.
 *
 * @param {number|string} seed
 * @param {string} label the sub-stream's name
 * @returns {number}
 */
function forkSeed(seed, label) {
  const base = typeof seed === "number" && Number.isFinite(seed) ? seed : hashSeed(seed);
  return (base ^ hashSeed(label)) >>> 0;
}

module.exports = { hashSeed, createRandom, forkSeed };

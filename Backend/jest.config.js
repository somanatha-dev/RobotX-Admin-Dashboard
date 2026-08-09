/**
 * Jest configuration for the RobotX backend.
 *
 * Three lanes, added in Phase 0 of the next-generation assignment engine
 * programme. Lanes exist so a phase can run the suite that governs it without
 * paying for the others, and so CI can report which lane broke:
 *
 *   legacy  — the existing dispatcher's unit and integration suites. These stay
 *             green through every phase until the Phase 15 cutover; a phase that
 *             reddens this lane has changed behaviour it was not asked to change.
 *   gates   — self-tests for the build gates. Each plants a deliberate violation
 *             and asserts the gate catches it. A gate that cannot fail is not a
 *             gate, so these tests are what make the other two lanes trustworthy.
 *   engine  — tests for `src/engine/**`. Empty of behaviour in Phase 0 by design;
 *             it currently holds the scaffolding and tier-registry assertions.
 *
 * PHASE 15 adds the two lanes §24 names as release gates, and gives each its own lane
 * rather than folding it into `engine` for a reason that is about honesty rather than
 * tidiness: both are slow, and a slow test inside a fast lane is a test somebody
 * eventually skips.
 *
 *   chaos   — §24.5's fault-injection suite. Every scenario runs at capacity 1 **and 2**,
 *             which §24.5 requires because "a chaos suite that only ever exercises one
 *             commitment per agent cannot detect" a fencing error.
 *   scale   — §24.6's scale, locality, soak and overload suites, measured against §20.1's
 *             targets. §20.1 calls that table "requirements for the release gate, not
 *             aspirations", and this lane is where that is a fact rather than a sentence.
 *
 * `npm test` runs all five. `npm run release:gates` runs the two new ones together with
 * the build gates, which is the set `src/engine/cutover/gates.js` expects evidence from.
 *
 * ── The legacy lane after the cutover ──────────────────────────────────────
 * The lane's original charter was "these stay green through every phase until the Phase 15
 * cutover; a phase that reddens this lane has changed behaviour it was not asked to
 * change." Phase 15 **is** that cutover, and it removed the legacy decision path from the
 * build. What remains in the lane is everything the cutover did not retire — auth, CORS,
 * the KV facade, the command round trip, telemetry, the simulator — and its charter is
 * unchanged for those: they are the surfaces the engine inherited rather than replaced.
 *
 * Run one lane with `npm run test:legacy` / `test:gates` / `test:engine` /
 * `test:chaos` / `test:scale`.
 */

const baseLane = {
  testEnvironment: "node",
  rootDir: __dirname,
  setupFiles: ["<rootDir>/tests/setup/env.js"],
  moduleNameMapper: {
    "^(\\.\\.?/)+config/logger$": "<rootDir>/tests/mocks/silentLogger.js",
  },
  testTimeout: 10000,
  clearMocks: true,
  restoreMocks: true,
};

module.exports = {
  rootDir: __dirname,
  verbose: false,
  collectCoverageFrom: [
    "src/**/*.js",
    "!src/simulation/**",
    "!src/config/logger.js",
  ],
  coverageDirectory: "<rootDir>/coverage",
  projects: [
    {
      ...baseLane,
      displayName: "legacy",
      testMatch: [
        "<rootDir>/tests/unit/**/*.test.js",
        "<rootDir>/tests/integration/**/*.test.js",
      ],
    },
    {
      ...baseLane,
      displayName: "gates",
      testMatch: ["<rootDir>/tests/gates/**/*.test.js"],
    },
    {
      ...baseLane,
      displayName: "engine",
      testMatch: ["<rootDir>/tests/engine/**/*.test.js"],
    },
    {
      ...baseLane,
      displayName: "chaos",
      testMatch: ["<rootDir>/tests/chaos/**/*.test.js"],
      // Fault injection drives real transactions through a store model with blocking
      // locks, and the coordinator-kill scenario runs thirty of them. The default 10 s is
      // a unit-test budget; raising it here is what stops a future engineer "fixing" a
      // timeout by shrinking the injection count.
      testTimeout: 120000,
    },
    {
      ...baseLane,
      displayName: "scale",
      testMatch: ["<rootDir>/tests/scale/**/*.test.js"],
      // The locality and soak profiles are measurements, not assertions about a mock, and
      // a measurement that is cut short is a measurement that is wrong.
      testTimeout: 300000,
    },
  ],
};

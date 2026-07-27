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
 * Run one lane with `npm run test:legacy` / `test:gates` / `test:engine`.
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
  ],
};

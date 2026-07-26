/** Jest configuration for RobotX backend. */
module.exports = {
  testEnvironment: "node",
  rootDir: __dirname,
  testMatch: ["<rootDir>/tests/**/*.test.js"],
  setupFiles: ["<rootDir>/tests/setup/env.js"],
  moduleNameMapper: {
    "^(\\.\\.?/)+config/logger$": "<rootDir>/tests/mocks/silentLogger.js",
  },
  testTimeout: 10000,
  clearMocks: true,
  restoreMocks: true,
  collectCoverageFrom: [
    "src/**/*.js",
    "!src/simulation/**",
    "!src/config/logger.js",
  ],
  coverageDirectory: "<rootDir>/coverage",
  verbose: false,
};

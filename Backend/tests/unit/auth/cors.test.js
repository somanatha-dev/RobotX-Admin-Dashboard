const { isOriginAllowed } = require("../../../src/config/cors");

describe("config/cors — isOriginAllowed (F29/F2 no-Origin bypass closed)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    process.env.FRONTEND_URL = originalEnv.FRONTEND_URL;
  });

  test("denies requests with no Origin header at all", () => {
    expect(isOriginAllowed(undefined)).toBe(false);
    expect(isOriginAllowed(null)).toBe(false);
    expect(isOriginAllowed("")).toBe(false);
  });

  test("allows localhost origins outside production", () => {
    process.env.NODE_ENV = "development";
    expect(isOriginAllowed("http://localhost:5173")).toBe(true);
    expect(isOriginAllowed("http://127.0.0.1:5173")).toBe(true);
  });

  test("denies localhost origins in production", () => {
    process.env.NODE_ENV = "production";
    expect(isOriginAllowed("http://localhost:5173")).toBe(false);
  });

  test("allows FRONTEND_URL exactly", () => {
    process.env.NODE_ENV = "production";
    process.env.FRONTEND_URL = "https://app.robotx.test";
    expect(isOriginAllowed("https://app.robotx.test")).toBe(true);
  });

  test("denies an origin not on the allowlist", () => {
    process.env.NODE_ENV = "production";
    process.env.FRONTEND_URL = "https://app.robotx.test";
    expect(isOriginAllowed("https://evil.example.com")).toBe(false);
  });

  test("denies a malformed origin string", () => {
    expect(isOriginAllowed("not-a-url")).toBe(false);
  });
});

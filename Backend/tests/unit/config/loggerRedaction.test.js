"use strict";

/**
 * H7 — a pairing code never reaches a log line.
 *
 * The code is a credential for its 300 s life: whoever presents it with the robotId becomes that
 * robot. No request carries one today (it travels only in the `POST /commission` response, which
 * is not logged), so these tests pin the redaction for the day one does:
 *
 *   * the HTTP request line: body, query string, and the URL itself (the query used to be
 *     printed inside it unredacted);
 *   * the dev printer's metadata;
 *   * the production (pino) path, which used to pass metadata through unredacted.
 *
 * The suite's `moduleNameMapper` replaces `config/logger` with a silent mock for every relative
 * require. The real module is loaded here by absolute path, which the mapper does not match.
 */

const path = require("path");

const LOGGER = path.join(__dirname, "../../../src/config/logger.js");
const CODE = "482913";

function loadLogger({ production = false, pino } = {}) {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = production ? "production" : "test";
  let logger;
  jest.isolateModules(() => {
    if (pino) jest.doMock("pino", () => pino);
    logger = require(LOGGER);
  });
  process.env.NODE_ENV = original;
  return logger;
}

function captureStdout(fn) {
  const out = [];
  const spyOut = jest.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const spyErr = jest.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  try {
    fn();
  } finally {
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
  return out.join("");
}

describe("H7 — the HTTP request log", () => {
  test("a pairingCode in the body is redacted", () => {
    const logger = loadLogger();
    const out = captureStdout(() =>
      logger.http({ method: "POST", path: "/api/robots/commission", originalUrl: "/api/robots/commission", query: {}, body: { robotId: "RBT-2000", pairingCode: CODE } }),
    );
    expect(out).toContain("RBT-2000");
    expect(out).toContain("[redacted]");
    expect(out).not.toContain(CODE);
  });

  test("a pairingCode in a query string is redacted, and the URL is printed without its query", () => {
    const logger = loadLogger();
    const req = {
      method: "GET",
      path: "/api/robots/RBT-2000/pairing",
      originalUrl: `/api/robots/RBT-2000/pairing?pairingCode=${CODE}`,
      query: { pairingCode: CODE },
      body: {},
    };
    const res = { statusCode: 200 };
    const out = captureStdout(() => {
      logger.http(req);
      logger.httpEnd(req, res, 3);
    });
    expect(out).toContain("/api/robots/RBT-2000/pairing");
    expect(out).not.toContain(CODE);
  });

  test("the existing redactions still hold (token, password, pin), case-insensitively", () => {
    const logger = loadLogger();
    const out = captureStdout(() =>
      logger.http({ method: "POST", path: "/x", originalUrl: "/x", query: {}, body: { Token: "tok-secret-1", password: "pw-secret-2", PIN: "9988", PairingCode: CODE } }),
    );
    for (const secret of ["tok-secret-1", "pw-secret-2", "9988", CODE]) expect(out).not.toContain(secret);
  });
});

describe("H7 — log metadata", () => {
  test("development printer: a pairingCode in metadata is redacted", () => {
    const logger = loadLogger();
    const out = captureStdout(() => logger.info("pairing attempt", { robotId: "RBT-2000", pairingCode: CODE }));
    expect(out).toContain("RBT-2000");
    expect(out).not.toContain(CODE);
  });

  test("production (pino): metadata is redacted with the same rule; Errors still pass through", () => {
    const calls = [];
    const fakeBase = {};
    for (const level of ["debug", "info", "warn", "error"]) fakeBase[level] = (obj, msg) => calls.push({ level, obj, msg });
    const pino = Object.assign(() => fakeBase, { stdTimeFunctions: { isoTime: () => "" } });

    const logger = loadLogger({ production: true, pino });
    logger.child("robots").warn("pairing attempt", { robotId: "RBT-2000", pairingCode: CODE, nested: { token: "tok-1" } });
    const error = new Error("boom");
    logger.error("failed", error);

    expect(calls[0].obj).toEqual({ module: "robots", robotId: "RBT-2000", pairingCode: "[redacted]", nested: { token: "[redacted]" } });
    expect(JSON.stringify(calls)).not.toContain(CODE);
    expect(calls[1].obj.err).toBe(error);
  });
});

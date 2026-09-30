"use strict";

/**
 * P0-D — an invalid §23.7 secret refuses the boot of an engine process, instead of
 * surfacing at the first task as a 500 that leaves a PENDING Task, a QUEUED Leg with no
 * queue row, and unsealed Stops behind (measured by the 2026-09-27 enablement audit).
 *
 * The contract enforced is the existing one, not a new one: `assertValid` calls the same
 * validators the write path calls — `surrogateKeys.requireSecret` (16-byte floor) and
 * `identityStore.requireEncryptionKey` (via `fromEnvironment`).
 */

const fs = require("fs");
const path = require("path");

const privacyKeys = require("../../../src/config/privacyKeys");
const surrogateKeys = require("../../../src/engine/privacy/surrogateKeys");

const KEY_HEX = "22".repeat(32);
const env = (secret, key = KEY_HEX) => ({ PRIVACY_SURROGATE_SECRET: secret, PRIVACY_IDENTITY_KEY: key });

describe("privacyKeys.assertValid — the boot-time check", () => {
  test("accepts a secret the write path accepts", () => {
    expect(() => privacyKeys.assertValid(env("a-surrogate-secret-of-plenty-of-bytes"))).not.toThrow();
  });

  test("enforces requireSecret's floor exactly: 16 bytes pass, 15 are refused", () => {
    expect(() => privacyKeys.assertValid(env("x".repeat(16)))).not.toThrow();
    expect(() => surrogateKeys.requireSecret("x".repeat(16))).not.toThrow();

    expect(() => privacyKeys.assertValid(env("x".repeat(15)))).toThrow(/PRIVACY_SURROGATE_SECRET is invalid: .*15 bytes; below 16/);
    expect(() => surrogateKeys.requireSecret("x".repeat(15))).toThrow(RangeError);
  });

  test("the 12-byte secret the audit reproduced the orphaned rows with is refused", () => {
    expect(() => privacyKeys.assertValid(env("audit-secret"))).toThrow(/12 bytes/);
  });

  test("an unset secret or identity key is refused, naming the variable", () => {
    expect(() => privacyKeys.assertValid(env(""))).toThrow(/PRIVACY_SURROGATE_SECRET is unset/);
    expect(() => privacyKeys.assertValid(env("a-surrogate-secret-of-plenty-of-bytes", ""))).toThrow(/PRIVACY_IDENTITY_KEY is unset/);
  });

  test("an identity key of the wrong length is refused by the store's own check", () => {
    expect(() => privacyKeys.assertValid(env("a-surrogate-secret-of-plenty-of-bytes", "22".repeat(16)))).toThrow(/requires exactly 32/);
  });
});

describe("server.js runs the check first, and only for an engine process", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../server.js"), "utf8");
  const body = source.slice(source.indexOf("async function start()"));

  test("before any connection is made", () => {
    const check = body.indexOf("privacyKeys.assertValid()");
    const connect = body.indexOf("connectPrismaWithRetry(");
    expect(check).toBeGreaterThan(-1);
    expect(connect).toBeGreaterThan(-1);
    expect(check).toBeLessThan(connect);
  });

  test("gated on the process half of the engine switch", () => {
    expect(body).toMatch(/if \(cutoverEnabled\.processEnabled\(\)\) \{\s*try \{\s*privacyKeys\.assertValid\(\);/);
  });
});

"use strict";

/**
 * Boot-time validation of the two signing secrets.
 *
 * Before: `JWT_SECRET` was checked only per request (a 500 on every authenticated route),
 * and `COMMAND_SIGNING_KEY` only when the first command was signed. Now `server.js` refuses
 * to start, naming the variable and never its value.
 *
 * The rule is the project's existing one, not a new one: both are HMAC-SHA256 keys, and
 * `commandSigning.MINIMUM_KEY_BYTES` (32) is the floor `requireKey` already enforces.
 *
 * The second block boots the **real** `server.js` in a child process. The child loads
 * `.env` first and then removes or overrides the variable under test, so a value in `.env`
 * cannot mask a missing one. Every child is pointed at a closed local port, never at a
 * hosted database: a refused boot exits before connecting, and an admitted boot is stopped
 * at its first connection attempt.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const bootSecrets = require("../../../src/config/bootSecrets");
const commandSigning = require("../../../src/engine/security/commandSigning");

const BACKEND = path.join(__dirname, "../../..");
const GOOD_JWT = "jwt-secret-for-boot-tests-0123456789abcdef";
const GOOD_KEY = "command-signing-key-for-boot-tests-0123456789";

describe("bootSecrets — the rule", () => {
  test("uses the command-signing module's own minimum, which is 32 bytes", () => {
    expect(bootSecrets.MINIMUM_KEY_BYTES).toBe(commandSigning.MINIMUM_KEY_BYTES);
    expect(bootSecrets.MINIMUM_KEY_BYTES).toBe(32);
  });

  test("valid secrets pass, engine on or off", () => {
    expect(bootSecrets.problems({ JWT_SECRET: GOOD_JWT }, { engineEnabled: false })).toEqual([]);
    expect(bootSecrets.problems({ JWT_SECRET: GOOD_JWT, COMMAND_SIGNING_KEY: GOOD_KEY }, { engineEnabled: true })).toEqual([]);
  });

  test("a missing or blank JWT_SECRET is refused by name", () => {
    for (const value of [undefined, "", "   "]) {
      expect(() => bootSecrets.assertValid({ JWT_SECRET: value }, { engineEnabled: false })).toThrow(/JWT_SECRET is unset/);
    }
  });

  test("COMMAND_SIGNING_KEY is required when the engine runs", () => {
    expect(() => bootSecrets.assertValid({ JWT_SECRET: GOOD_JWT }, { engineEnabled: true })).toThrow(/COMMAND_SIGNING_KEY is unset/);
  });

  test("COMMAND_SIGNING_KEY is not required with the engine off, but is validated when set", () => {
    expect(() => bootSecrets.assertValid({ JWT_SECRET: GOOD_JWT }, { engineEnabled: false })).not.toThrow();
    expect(() => bootSecrets.assertValid({ JWT_SECRET: GOOD_JWT, COMMAND_SIGNING_KEY: "short" }, { engineEnabled: false })).toThrow(
      /COMMAND_SIGNING_KEY is shorter than 32 bytes/,
    );
  });

  test("the floor is exact: 32 bytes pass, 31 are refused, for both secrets", () => {
    const at = "x".repeat(32);
    const below = "x".repeat(31);
    expect(bootSecrets.problems({ JWT_SECRET: at, COMMAND_SIGNING_KEY: at }, { engineEnabled: true })).toEqual([]);
    expect(() => bootSecrets.assertValid({ JWT_SECRET: below }, { engineEnabled: false })).toThrow(/JWT_SECRET is shorter than 32 bytes/);
    expect(() => bootSecrets.assertValid({ JWT_SECRET: at, COMMAND_SIGNING_KEY: below }, { engineEnabled: true })).toThrow(
      /COMMAND_SIGNING_KEY is shorter than 32 bytes/,
    );
  });

  test("bytes are counted in UTF-8, as requireKey counts them", () => {
    const multiByte = "é".repeat(16); // 16 characters, 32 bytes
    expect(bootSecrets.problems({ JWT_SECRET: multiByte }, { engineEnabled: false })).toEqual([]);
  });

  test("both problems are reported together, and no message carries a value", () => {
    const secret = "short-jwt-VALUE-7f3a";
    const key = "short-key-VALUE-9c1e";
    let message = "";
    try {
      bootSecrets.assertValid({ JWT_SECRET: secret, COMMAND_SIGNING_KEY: key }, { engineEnabled: true });
    } catch (e) {
      message = e.message;
      expect(e.code).toBe("BOOT_SECRETS_INVALID");
    }
    expect(message).toMatch(/JWT_SECRET/);
    expect(message).toMatch(/COMMAND_SIGNING_KEY/);
    expect(message).not.toContain(secret);
    expect(message).not.toContain(key);
  });
});

describe("server.js runs the check before anything connects", () => {
  test("it is the first check in start(), ahead of the privacy secrets and the database", () => {
    const source = fs.readFileSync(path.join(BACKEND, "server.js"), "utf8");
    const body = source.slice(source.indexOf("async function start()"));
    const check = body.indexOf("bootSecrets.assertValid(process.env, { engineEnabled: cutoverEnabled.processEnabled() })");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(body.indexOf("privacyKeys.assertValid()"));
    expect(check).toBeLessThan(body.indexOf("connectPrismaWithRetry("));
  });
});

/**
 * Boot the real server.js with `overrides` applied after `.env` has loaded (`null` deletes a
 * variable). Resolves when the process exits, or — for a boot that gets past the secrets —
 * when it reaches its first database connection attempt, at which point it is killed.
 */
function boot(overrides) {
  // `@prisma/client` re-injects any `.env` variable that is absent when it is first required,
  // so it is loaded (and cached) before the overrides are applied — otherwise a deleted
  // secret would quietly come back from `.env` and the "missing" case would test nothing.
  const script = [
    'require("./src/config/env");',
    'require("@prisma/client");',
    "const o = JSON.parse(process.env.BOOT_TEST_OVERRIDES);",
    "for (const [k, v] of Object.entries(o)) { if (v === null) delete process.env[k]; else process.env[k] = v; }",
    'require("./server.js");',
  ].join("\n");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", script], {
      cwd: BACKEND,
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://boot-test@127.0.0.1:1/never",
        DATABASE_URL_LOCAL: "postgresql://boot-test@127.0.0.1:1/never",
        REDIS_ENABLED: "false",
        PORT: "0",
        HOST: "127.0.0.1",
        BOOT_TEST_OVERRIDES: JSON.stringify(overrides),
      },
    });
    let output = "";
    let reachedDatabase = false;
    const collect = (chunk) => {
      output += chunk.toString();
      if (!reachedDatabase && /Prisma connect failed/.test(output)) {
        reachedDatabase = true;
        child.kill();
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("exit", (code) => resolve({ code, output, reachedDatabase }));
  });
}

describe("a real server.js boot", () => {
  jest.setTimeout(60_000);

  test("missing JWT_SECRET: refused before any connection, naming the variable", async () => {
    const run = await boot({ JWT_SECRET: null, ENGINE_ENABLED: "false" });
    expect(run.code).toBe(1);
    expect(run.reachedDatabase).toBe(false);
    expect(run.output).toMatch(/Refusing to start: signing secrets are not usable: JWT_SECRET is unset/);
  });

  test("missing COMMAND_SIGNING_KEY on an engine process: refused, naming the variable", async () => {
    const run = await boot({ JWT_SECRET: GOOD_JWT, COMMAND_SIGNING_KEY: null, ENGINE_ENABLED: "true" });
    expect(run.code).toBe(1);
    expect(run.reachedDatabase).toBe(false);
    expect(run.output).toMatch(/COMMAND_SIGNING_KEY is unset/);
  });

  test("too-short secrets: refused, and neither value appears anywhere in the output", async () => {
    const shortJwt = "tooshort-JWT-a91c";
    const shortKey = "tooshort-KEY-5d2e";
    const run = await boot({ JWT_SECRET: shortJwt, COMMAND_SIGNING_KEY: shortKey, ENGINE_ENABLED: "true" });
    expect(run.code).toBe(1);
    expect(run.output).toMatch(/JWT_SECRET is shorter than 32 bytes/);
    expect(run.output).toMatch(/COMMAND_SIGNING_KEY is shorter than 32 bytes/);
    expect(run.output).not.toContain(shortJwt);
    expect(run.output).not.toContain(shortKey);
  });

  test("valid secrets: the boot passes the check and proceeds to the database", async () => {
    const run = await boot({ JWT_SECRET: GOOD_JWT, COMMAND_SIGNING_KEY: GOOD_KEY, ENGINE_ENABLED: "false" });
    expect(run.reachedDatabase).toBe(true);
    expect(run.output).not.toMatch(/signing secrets are not usable/);
    expect(run.output).not.toContain(GOOD_JWT);
    expect(run.output).not.toContain(GOOD_KEY);
  });
});

"use strict";

/**
 * F4 — boot-time validation of the six §12.5 completion verification thresholds.
 *
 * Before: an engine process booted with any of them missing or unusable, and the failure
 * surfaced only at the point of use — every `TASK_COMPLETE` held `NOT_CONFIGURED`, no arrival
 * ever verified. Now `server.js` refuses to start an engine process, naming every variable at
 * fault and never a value. With the engine off nothing changes.
 *
 * The rule is the consumers' own (finite and > 0), so the first block also pins the module's
 * names and predicate to the readers that actually grade a completion.
 *
 * The last block boots the **real** `server.js` in a child process, in the shape
 * `bootSecretsValidation.test.js` established: `.env` loads first, then the variables under
 * test are removed or overridden, and every child points at a closed local port, so a refused
 * boot exits before connecting and an admitted one is stopped at its first connection attempt.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const thresholds = require("../../../src/config/verificationThresholds");
const legProgress = require("../../../src/services/legProgress.service");
const { VERIFICATION_THRESHOLDS: V1 } = require("../../../tools/config/v1DemonstrationConfig");

const BACKEND = path.join(__dirname, "../../..");
const ON = { engineEnabled: true };
const OFF = { engineEnabled: false };

/** The V1 launcher's own values — the configuration every live gate runs with. */
const valid = () => ({ ...V1 });

describe("verificationThresholds — the six names are the ones the graders read", () => {
  test("exactly the six variables `dtaro.handler` grades a completion with, in its order", () => {
    const source = fs.readFileSync(path.join(BACKEND, "src/sockets/handlers/dtaro.handler.js"), "utf8");
    const reader = source.slice(source.indexOf("function readVerificationThresholds"));
    const read = [...reader.slice(0, reader.indexOf("return {")).matchAll(/process\.env\.(VERIFY_[A-Z_]+)/g)].map((m) => m[1]);
    expect(read).toEqual([...thresholds.NAMES]);
  });

  test("the V1 launcher supplies all six, and nothing else under VERIFY_", () => {
    expect(Object.keys(V1).sort()).toEqual([...thresholds.NAMES].sort());
  });

  test("whatever the boot check admits, the arrival reader also admits (never a stall after a clean boot)", () => {
    const candidates = ["25", "0.5", "8.33", "1", "0", "-1", "", "abc", "0x19", "2.5e1", " 25", "Infinity", "NaN"];
    const before = process.env.VERIFY_ARRIVAL_RADIUS_M;
    try {
      for (const value of candidates) {
        const admitted = thresholds.problems({ ...valid(), VERIFY_ARRIVAL_RADIUS_M: value }, ON).length === 0;
        process.env.VERIFY_ARRIVAL_RADIUS_M = value;
        if (admitted) expect({ value, radius: legProgress.arrivalRadiusM() }).toEqual({ value, radius: Number(value) });
      }
    } finally {
      if (before === undefined) delete process.env.VERIFY_ARRIVAL_RADIUS_M;
      else process.env.VERIFY_ARRIVAL_RADIUS_M = before;
    }
  });
});

describe("verificationThresholds — the rule, per variable", () => {
  test("the V1 launcher's configuration is accepted", () => {
    expect(thresholds.problems(valid(), ON)).toEqual([]);
    expect(() => thresholds.assertValid(valid(), ON)).not.toThrow();
  });

  test("integers and decimals are both accepted", () => {
    const env = valid();
    for (const name of thresholds.NAMES) env[name] = "0.25";
    expect(thresholds.problems(env, ON)).toEqual([]);
    for (const name of thresholds.NAMES) env[name] = "40";
    expect(thresholds.problems(env, ON)).toEqual([]);
  });

  const UNSET = /is unset; it has no default\./;
  const NOT_DECIMAL = /is not a plain decimal number\./;
  const NOT_POSITIVE = /must be greater than zero\./;
  const cases = [
    ["missing", undefined, UNSET],
    ["null", null, UNSET],
    ["empty", "", UNSET],
    ["blank", "   ", UNSET],
    ["non-numeric", "abc", NOT_DECIMAL],
    ["NaN", "NaN", NOT_DECIMAL],
    ["Infinity", "Infinity", NOT_DECIMAL],
    ["negative", "-5", NOT_DECIMAL],
    ["hex (Number() reads 25)", "0x19", NOT_DECIMAL],
    ["exponent (Number() reads 25)", "2.5e1", NOT_DECIMAL],
    ["padded (Number() reads 25)", " 25 ", NOT_DECIMAL],
    ["trailing point", "25.", NOT_DECIMAL],
    ["zero", "0", NOT_POSITIVE],
    ["zero decimal", "0.0", NOT_POSITIVE],
  ];

  for (const name of thresholds.NAMES) {
    test.each(cases)(`${name}: %s is refused by name`, (_label, value, expected) => {
      const env = valid();
      if (value === undefined) delete env[name];
      else env[name] = value;

      const found = thresholds.problems(env, ON);
      expect(found).toHaveLength(1);
      expect(found[0].startsWith(`${name} `)).toBe(true);
      expect(found[0]).toMatch(expected);
      expect(() => thresholds.assertValid(env, ON)).toThrow(expect.objectContaining({ code: "VERIFICATION_THRESHOLDS_INVALID" }));
    });
  }

  test("every problem is reported together, each naming its variable and none carrying a value", () => {
    const env = {
      VERIFY_ARRIVAL_RADIUS_M: "0",
      VERIFY_TRACK_MIN_FIX_RATE: "abc-VALUE-1f",
      VERIFY_TRACK_MIN_CORRIDOR_FRACTION: "",
      // VERIFY_TRACK_MAX_GAP_SECONDS absent
      VERIFY_CORRIDOR_HALF_WIDTH_M: "-30",
      VERIFY_MAX_SPEED_MS: "8.33",
    };
    let error;
    try {
      thresholds.assertValid(env, ON);
    } catch (e) {
      error = e;
    }
    expect(error.code).toBe("VERIFICATION_THRESHOLDS_INVALID");
    for (const name of thresholds.NAMES.slice(0, 5)) expect(error.message).toContain(name);
    expect(error.message).not.toContain("VERIFY_MAX_SPEED_MS");
    expect(error.message).not.toContain("abc-VALUE-1f");
    expect(error.message).not.toContain("-30");
    expect(thresholds.problems(env, ON)).toHaveLength(5);
  });

  test("engine off: nothing is required and nothing is checked — current behaviour", () => {
    expect(thresholds.problems({}, OFF)).toEqual([]);
    expect(thresholds.problems({ VERIFY_ARRIVAL_RADIUS_M: "abc" }, OFF)).toEqual([]);
    expect(thresholds.problems({}, undefined)).toEqual([]);
    expect(() => thresholds.assertValid({}, OFF)).not.toThrow();
  });
});

describe("server.js runs the check before anything connects", () => {
  test("in start(), for an engine process, after the signing secrets and before the database", () => {
    const source = fs.readFileSync(path.join(BACKEND, "server.js"), "utf8");
    const body = source.slice(source.indexOf("async function start()"));
    const check = body.indexOf("verificationThresholds.assertValid(process.env, { engineEnabled: cutoverEnabled.processEnabled() })");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(body.indexOf("bootSecrets.assertValid("));
    expect(check).toBeLessThan(body.indexOf("connectPrismaWithRetry("));
  });
});

/**
 * Boot the real server.js with `overrides` applied after `.env` has loaded (`null` deletes a
 * variable). Resolves when the process exits, or — for a boot that gets past the checks —
 * when it reaches its first database connection attempt, at which point it is killed.
 */
function boot(overrides) {
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

const SECRETS = {
  JWT_SECRET: "jwt-secret-for-boot-tests-0123456789abcdef",
  COMMAND_SIGNING_KEY: "command-signing-key-for-boot-tests-0123456789",
};
const absent = () => Object.fromEntries(thresholds.NAMES.map((name) => [name, null]));

describe("a real server.js boot", () => {
  jest.setTimeout(60_000);

  test("engine on, all six missing: refused before any connection, naming every variable", async () => {
    const run = await boot({ ...SECRETS, ENGINE_ENABLED: "true", ...absent() });
    expect(run.code).toBe(1);
    expect(run.reachedDatabase).toBe(false);
    expect(run.output).toMatch(/Refusing to start the engine: completion verification thresholds are not usable/);
    for (const name of thresholds.NAMES) expect(run.output).toContain(`${name} is unset`);
  });

  test("engine on, one invalid value: refused, and the value appears nowhere in the output", async () => {
    const run = await boot({ ...SECRETS, ENGINE_ENABLED: "true", ...valid(), VERIFY_TRACK_MAX_GAP_SECONDS: "-7777" });
    expect(run.code).toBe(1);
    expect(run.reachedDatabase).toBe(false);
    expect(run.output).toMatch(/VERIFY_TRACK_MAX_GAP_SECONDS is not a plain decimal number/);
    expect(run.output).not.toContain("-7777");
  });

  test("engine on, the V1 launcher's six: the boot passes the check and proceeds to the database", async () => {
    const run = await boot({ ...SECRETS, ENGINE_ENABLED: "true", ...valid() });
    expect(run.output).not.toMatch(/verification thresholds are not usable/);
    expect(run.reachedDatabase).toBe(true);
  });

  test("engine off, all six missing: unchanged — the boot proceeds to the database", async () => {
    const run = await boot({ ...SECRETS, ENGINE_ENABLED: "false", ...absent() });
    expect(run.output).not.toMatch(/verification thresholds are not usable/);
    expect(run.reachedDatabase).toBe(true);
  });
});

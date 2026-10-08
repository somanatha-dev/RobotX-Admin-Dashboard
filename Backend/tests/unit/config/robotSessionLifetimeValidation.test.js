"use strict";

/**
 * H1 — a paired robot's session lifetime is configurable, bounded, and long enough by default
 * for a Pi to be powered off for days and still reconnect on its stored token.
 *
 * Before: `SESSION_TTL_SEC = 86400`, fixed. The lifetime slides only while the token is used,
 * so a Pi off for more than 24 h was refused at its next boot, discarded its token and needed
 * a new pairing code.
 *
 * The last block boots the real `server.js` in a child process, in the shape
 * `socketTimingValidation.test.js` uses (a closed database port, so an admitted boot is
 * stopped at its first connection attempt and a refused one exits before it).
 */

const path = require("path");
const { spawn } = require("child_process");

const robotSessionLifetime = require("../../../src/config/robotSessionLifetime");
const robotSession = require("../../../src/services/robotSession.service");

const BACKEND = path.join(__dirname, "../../..");
const DAY_SEC = 86_400;

describe("robotSessionLifetime — the rule", () => {
  test("the default is 30 days: a robot may be powered off for weeks and still reconnect", () => {
    expect(robotSessionLifetime.resolve({})).toBe(30 * DAY_SEC);
    expect(robotSessionLifetime.DEFAULT_SEC).toBeGreaterThan(7 * DAY_SEC);
    expect(robotSessionLifetime.resolve({ ROBOT_SESSION_TTL_SEC: "  " })).toBe(robotSessionLifetime.DEFAULT_SEC); // blank = unset
  });

  test("a plain integer of seconds within 1 h – 90 days overrides it, bounds included", () => {
    expect(robotSessionLifetime.resolve({ ROBOT_SESSION_TTL_SEC: "604800" })).toBe(7 * DAY_SEC);
    expect(robotSessionLifetime.resolve({ ROBOT_SESSION_TTL_SEC: "3600" })).toBe(robotSessionLifetime.MIN_SEC);
    expect(robotSessionLifetime.resolve({ ROBOT_SESSION_TTL_SEC: String(90 * DAY_SEC) })).toBe(robotSessionLifetime.MAX_SEC);
  });

  test("there is no infinite session: anything above 90 days is refused, never clamped", () => {
    for (const tooLong of [String(90 * DAY_SEC + 1), "31536000", "999999999999"]) {
      const { ttlSec, problems } = robotSessionLifetime.evaluate({ ROBOT_SESSION_TTL_SEC: tooLong });
      expect(ttlSec).toBeNull();
      expect(problems[0]).toMatch(/between 3600 and 7776000 seconds/);
    }
  });

  test("too short is refused too: below an hour a robot would re-pair after any short outage", () => {
    expect(() => robotSessionLifetime.resolve({ ROBOT_SESSION_TTL_SEC: "3599" })).toThrow(/between 3600 and 7776000 seconds/);
  });

  test("a malformed value is refused rather than coerced, and the error never echoes it", () => {
    for (const bad of ["0", "-5", "5.5", "0x1388", "5e5", " 86400", "forever", "Infinity"]) {
      const { ttlSec, problems } = robotSessionLifetime.evaluate({ ROBOT_SESSION_TTL_SEC: bad });
      expect(ttlSec).toBeNull();
      expect(problems).toEqual(["ROBOT_SESSION_TTL_SEC must be a plain positive integer of seconds."]);
    }
    let error;
    try {
      robotSessionLifetime.resolve({ ROBOT_SESSION_TTL_SEC: "forever" });
    } catch (e) {
      error = e;
    }
    expect(error.code).toBe("ROBOT_SESSION_TTL_INVALID");
    expect(error.message).not.toMatch(/forever/);
  });
});

describe("robotSession service — the lifetime is the configured one, at both writes", () => {
  const ORIGINAL = process.env.ROBOT_SESSION_TTL_SEC;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ROBOT_SESSION_TTL_SEC;
    else process.env.ROBOT_SESSION_TTL_SEC = ORIGINAL;
  });

  function rowStore() {
    const rows = new Map();
    return {
      rows,
      upsert: jest.fn(async ({ where, create, update }) => {
        rows.set(where.robotDbId, rows.has(where.robotDbId) ? { ...rows.get(where.robotDbId), ...update } : create);
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const row = rows.get(where.robotDbId);
        if (!row || row.tokenHash !== where.tokenHash || !(row.expiresAt > where.expiresAt.gt)) return { count: 0 };
        rows.set(where.robotDbId, { ...row, ...data });
        return { count: 1 };
      }),
    };
  }

  test("pairing records an expiry one configured lifetime ahead (default 30 days)", async () => {
    delete process.env.ROBOT_SESSION_TTL_SEC;
    const store = rowStore();
    const now = new Date("2026-10-08T00:00:00Z");
    await robotSession.recordIssued({ robotSession: store }, "row-1", "token-a", now);
    expect(store.rows.get("row-1").expiresAt.getTime() - now.getTime()).toBe(30 * DAY_SEC * 1000);
    expect(robotSession.sessionTtlSec()).toBe(30 * DAY_SEC);
  });

  test("an override applies to issue and to every slide (validate / renewLive)", async () => {
    process.env.ROBOT_SESSION_TTL_SEC = String(7 * DAY_SEC);
    const store = rowStore();
    const issued = new Date("2026-10-08T00:00:00Z");
    await robotSession.recordIssued({ robotSession: store }, "row-1", "token-a", issued);
    expect(store.rows.get("row-1").expiresAt.getTime() - issued.getTime()).toBe(7 * DAY_SEC * 1000);

    // Six days powered off, then the stored token is presented: admitted, and slid a full lifetime.
    const sixDaysLater = new Date(issued.getTime() + 6 * DAY_SEC * 1000);
    expect(await robotSession.validate({ robotSession: store }, "row-1", "token-a", sixDaysLater)).toBe(true);
    expect(store.rows.get("row-1").expiresAt.getTime() - sixDaysLater.getTime()).toBe(7 * DAY_SEC * 1000);
  });

  test("the lifetime is still finite: a token unused for longer than it is refused", async () => {
    process.env.ROBOT_SESSION_TTL_SEC = String(7 * DAY_SEC);
    const store = rowStore();
    const issued = new Date("2026-10-08T00:00:00Z");
    await robotSession.recordIssued({ robotSession: store }, "row-1", "token-a", issued);
    const eightDaysLater = new Date(issued.getTime() + 8 * DAY_SEC * 1000);
    expect(await robotSession.validate({ robotSession: store }, "row-1", "token-a", eightDaysLater)).toBe(false);
  });

  test("the fixed 24 h export is gone, so no caller can keep using it by accident", () => {
    expect(robotSession.SESSION_TTL_SEC).toBeUndefined();
  });
});

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

const SECRETS = { JWT_SECRET: "jwt-secret-for-boot-tests-0123456789abcdef", ENGINE_ENABLED: "false" };

describe("a real server.js boot", () => {
  jest.setTimeout(60_000);

  test("the default lifetime is admitted and logged; the boot goes on to the database", async () => {
    const result = await boot({ ...SECRETS, ROBOT_SESSION_TTL_SEC: null });
    expect(result.output).toMatch(/Robot session lifetime/);
    expect(result.output).toMatch(/2592000/);
    expect(result.output).not.toMatch(/Robot session lifetime is not usable/);
    expect(result.reachedDatabase).toBe(true);
  });

  test("an unbounded lifetime is refused before anything connects", async () => {
    const result = await boot({ ...SECRETS, ROBOT_SESSION_TTL_SEC: "31536000" });
    expect(result.output).toMatch(/Refusing to start: Robot session lifetime is not usable/);
    expect(result.reachedDatabase).toBe(false);
    expect(result.code).not.toBe(0);
  });
});

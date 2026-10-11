"use strict";

/**
 * Phase 6 hardening of the LOCAL guards (docs/runbooks/environments.md):
 *
 *   1. a present-but-empty ROBOTX_ENV is refused, not read as "not LOCAL";
 *   2. `npm run prisma:local` runs only an allow-list of Prisma commands, refused before any
 *      configuration loads, with no shell;
 *   3. `prisma/seed.js` runs `requireLocalTarget` before it creates a client;
 *   4. the benchmark's TRUNCATE path (`benchmark/orchestrator.js`) runs only against a
 *      disposable loopback database — never the canonical LOCAL one.
 *
 * Every target is unreachable: loopback port 1, or a host under the reserved `.invalid` domain,
 * so even a guard failure could reach nothing. No test reads or prints the real LOCAL file.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { checkEnvironment, requireLocalTarget, requireDisposableTarget } = require("../../../src/config/environmentGuard");
const { classify } = require("../../../tools/env/prismaCommandPolicy");

const BACKEND = path.join(__dirname, "../../..");
const SECRET = "s3cr3t-password-value";
const UNREACHABLE = `postgresql://u:${SECRET}@127.0.0.1:1/robotx`;
const REMOTE = `postgresql://o:${SECRET}@db.phase6.invalid:5432/robotx`;

let dir;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "localguards-")); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function configFile(lines) {
  const file = path.join(dir, `cfg-${Math.random().toString(36).slice(2)}.dotenv`);
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

/** Run a Backend script with a controlled environment; resolves { code, out }. */
function run(args, envPatch = {}, { remove = [] } = {}) {
  const env = { ...process.env, ...envPatch };
  for (const key of ["ROBOTX_ENV", "DATABASE_URL", "REDIS_URL", "REDIS_ENABLED", ...remove]) {
    if (!(key in envPatch)) delete env[key];
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: BACKEND, env });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { child.kill(); resolve({ code: "TIMEOUT", out }); }, 40_000);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

describe("ROBOTX_ENV present but empty is a refusal, not an absence", () => {
  test.each([[""], ["   "]])("checkEnvironment refuses ROBOTX_ENV=%j", (value) => {
    const result = checkEnvironment({ ROBOTX_ENV: value, DATABASE_URL: REMOTE });
    expect(result.active).toBe(true);
    expect(result.problems.join(" ")).toMatch(/set but empty/);
  });

  test("an ABSENT ROBOTX_ENV is still inactive (a deployment and the test suite are unchanged)", () => {
    expect(checkEnvironment({ DATABASE_URL: REMOTE })).toEqual({ active: false, problems: [], summary: null });
  });

  test("requireLocalTarget refuses an empty ROBOTX_ENV without printing the credential", () => {
    const errors = [];
    let exitCode = null;
    const target = requireLocalTarget({ ROBOTX_ENV: "", DATABASE_URL: UNREACHABLE }, { error: (m) => errors.push(m), exit: (c) => { exitCode = c; } });
    expect(target).toBeNull();
    expect(exitCode).toBe(78);
    expect(errors.join("\n")).not.toContain(SECRET);
  });

  test("server.js refuses a process-level empty ROBOTX_ENV even though its configuration file declares LOCAL (exit 78)", async () => {
    const file = configFile(["ROBOTX_ENV=LOCAL", `DATABASE_URL=${UNREACHABLE}`]);
    const { code, out } = await run(["server.js"], {
      ROBOTX_ENV_FILE: file,
      ROBOTX_ENV: "",
      DATABASE_URL: REMOTE,
      PORT: "0",
      HOST: "127.0.0.1",
      ENGINE_ENABLED: "false",
      ENABLE_VIRTUAL_SIMULATOR: "false",
    });
    expect(code).toBe(78);
    expect(out).toContain("set but empty");
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("Prisma");
  }, 45_000);
});

describe("prisma:local — the command allow-list", () => {
  test.each([
    [["migrate", "status"]],
    [["migrate", "status", "--schema", "prisma/schema.prisma"]],
    [["--schema=prisma/schema.prisma", "migrate", "status"]],
    [["--schema", "prisma/schema.prisma", "migrate", "status"]],
    [["validate"]],
    [["format", "--check"]],
    [["generate"]],
    [["version"]],
    [["--version"]],
    [["-v"]],
    [["--help"]],
    [["db", "pull", "--print"]],
    [["migrate", "diff", "--from-url", UNREACHABLE, "--to-schema-datamodel", "prisma/schema.prisma", "--script"]],
  ])("allows %j", (args) => {
    expect(classify(args).allowed).toBe(true);
  });

  test.each([
    [["migrate", "reset"]],
    [["migrate", "reset", "--force"]],
    [["--schema", "prisma/schema.prisma", "migrate", "reset"]],
    [["migrate", "RESET"]],
    [["MIGRATE", "RESET"]],
    [["migrate", "--force", "reset"]],
    [["migrate", "status", "reset"]],
    [["migrate", "status", "--force-reset"]],
    [["db", "push"]],
    [["db", "push", "--accept-data-loss"]],
    [["db", "push", "--force-reset"]],
    [["--accept-data-loss", "db", "push"]],
    [["db", "execute", "--file", "x.sql"]],
    [["db", "execute", "--stdin"]],
    [["db", "seed"]],
    [["db", "pull"]],
    [["migrate", "deploy"]],
    [["migrate", "dev"]],
    [["migrate", "dev", "--create-only"]],
    [["migrate", "resolve", "--applied", "x"]],
    [["migrate", "diff", "--from-migrations", "prisma/migrations", "--shadow-database-url", UNREACHABLE, "--to-schema-datamodel", "x"]],
    [["studio"]],
    [["init"]],
    [["debug"]],
    [["migrate"]],
    [["db"]],
    [[]],
    [["status", "migrate"]],
    [["migrate", "status", "&&", "prisma", "migrate", "reset"]],
    [["migrate", "status", ";", "db", "push"]],
  ])("refuses %j", (args) => {
    const verdict = classify(args);
    expect(verdict.allowed).toBe(false);
    expect(typeof verdict.reason).toBe("string");
  });

  test("migrate deploy — the runbook's reviewed path — is admitted only with --confirm-database, which Prisma never sees", () => {
    for (const args of [["migrate", "deploy", "--confirm-database", "robotx"], ["--confirm-database=robotx", "migrate", "deploy"]]) {
      const verdict = classify(args);
      expect(verdict.allowed).toBe(true);
      expect(verdict.requiresConfirmedDatabase).toBe(true);
      expect(verdict.confirmDatabase).toBe("robotx");
      expect(verdict.prismaArgs).toEqual(["migrate", "deploy"]);
    }
    expect(classify(["migrate", "deploy", "--confirm-database"]).allowed).toBe(false);
    // The confirmation never launders a destructive word.
    expect(classify(["migrate", "reset", "--confirm-database", "robotx"]).allowed).toBe(false);
    expect(classify(["migrate", "deploy", "--confirm-database", "robotx", "--force-reset"]).allowed).toBe(false);
  });
});

describe("prisma:local — the wrapper refuses before anything loads", () => {
  const WRAPPER = path.join("tools", "env", "withLocalEnv.js");

  test.each([
    [["npx", "prisma", "migrate", "reset", "--force"]],
    [["npx", "prisma", "db", "push", "--accept-data-loss"]],
    [["npx", "prisma", "db", "seed"]],
    [["prisma", "migrate", "deploy"]],
    [["npx", "prisma", "migrate", "status", "&&", "npx", "prisma", "migrate", "reset"]],
  ])("refuses %j with exit 77, loading no configuration and starting no Prisma", async (args) => {
    // A configuration that WOULD pass the LOCAL guard, so the refusal is the policy's alone.
    const file = configFile(["ROBOTX_ENV=LOCAL", `DATABASE_URL=${UNREACHABLE}`]);
    const { code, out } = await run([WRAPPER, ...args], { ROBOTX_ENV_FILE: file });
    expect(code).toBe(77);
    expect(out).toContain("REFUSED");
    expect(out).not.toContain("[env] LOCAL");
    expect(out).not.toContain("Prisma schema loaded");
    expect(out).not.toContain(SECRET);
  }, 45_000);

  test("refuses any command that is not the Prisma CLI (exit 64)", async () => {
    const { code, out } = await run([WRAPPER, "node", "-e", "console.log(process.env.DATABASE_URL)"], {
      ROBOTX_ENV_FILE: configFile(["ROBOTX_ENV=LOCAL", `DATABASE_URL=${UNREACHABLE}`]),
    });
    expect(code).toBe(64);
    expect(out).not.toContain(SECRET);
  }, 45_000);

  test("refuses an allowed command when the configuration does not declare LOCAL (exit 78)", async () => {
    const { code, out } = await run([WRAPPER, "npx", "prisma", "migrate", "status"], {
      ROBOTX_ENV_FILE: configFile([`DATABASE_URL=${UNREACHABLE}`]),
    });
    expect(code).toBe(78);
    expect(out).not.toContain("Prisma schema loaded");
    expect(out).not.toContain(SECRET);
  }, 45_000);

  test("migrate deploy confirming a DIFFERENT database is refused after the guard, before Prisma starts (exit 77)", async () => {
    const file = configFile(["ROBOTX_ENV=LOCAL", `DATABASE_URL=${UNREACHABLE}`]);
    const { code, out } = await run([WRAPPER, "npx", "prisma", "migrate", "deploy", "--confirm-database", "robotx_other"], { ROBOTX_ENV_FILE: file });
    expect(code).toBe(77);
    expect(out).toContain('to the LOCAL database "robotx"');
    expect(out).not.toContain("Prisma schema loaded");
    expect(out).not.toContain(SECRET);
  }, 45_000);

  test("migrate deploy confirming the target runs Prisma without the wrapper's flag (and reaches nothing: port 1)", async () => {
    const file = configFile(["ROBOTX_ENV=LOCAL", `DATABASE_URL=${UNREACHABLE}`]);
    const { code, out } = await run([WRAPPER, "npx", "prisma", "migrate", "deploy", "--confirm-database", "robotx"], {
      ROBOTX_ENV_FILE: file,
      CHECKPOINT_DISABLE: "1",
    });
    expect(out).toContain("Prisma schema loaded");
    expect(out).not.toMatch(/unknown or unexpected option|--confirm-database/);
    expect(out).toMatch(/P1001|Can't reach database server|127\.0\.0\.1:1/);
    expect(code).not.toBe(0);
    expect(code).not.toBe(77);
  }, 60_000);

  test("runs an allowed command (migrate status) against the declared LOCAL database, without a shell", async () => {
    const file = configFile(["ROBOTX_ENV=LOCAL", `DATABASE_URL=${UNREACHABLE}`]);
    // CHECKPOINT_DISABLE: no Prisma usage ping leaves the machine during a test.
    const { code, out } = await run([WRAPPER, "npx", "prisma", "migrate", "status"], { ROBOTX_ENV_FILE: file, CHECKPOINT_DISABLE: "1" });
    // Prisma itself ran (it printed its schema line) and then could not reach port 1.
    expect(out).toContain("[env] LOCAL: database 127.0.0.1:1/robotx");
    expect(out).toContain("Prisma schema loaded");
    expect(out).toMatch(/P1001|Can't reach database server|127\.0\.0\.1:1/);
    expect(code).not.toBe(0);
    expect(code).not.toBe(77);
  }, 60_000);
});

describe("prisma/seed.js — requireLocalTarget before any client", () => {
  test("refuses without ROBOTX_ENV=LOCAL (exit 78), creating no client", async () => {
    const { code, out } = await run(["prisma/seed.js"], { ROBOTX_ENV_FILE: configFile([`DATABASE_URL=${UNREACHABLE}`]) });
    expect(code).toBe(78);
    expect(out).toContain("REFUSED: this script writes to a database");
    expect(out).not.toContain("seeding started");
    expect(out).not.toContain(SECRET);
  }, 45_000);

  test("refuses a remote target even when LOCAL is declared (exit 78)", async () => {
    const { code, out } = await run(["prisma/seed.js"], { ROBOTX_ENV_FILE: configFile(["ROBOTX_ENV=LOCAL", `DATABASE_URL=${REMOTE}`]) });
    expect(code).toBe(78);
    expect(out).not.toContain("seeding started");
    expect(out).not.toContain(SECRET);
  }, 45_000);

  test("importing the module (as three engine tests do) runs no guard and creates no client", () => {
    const seed = require("../../../prisma/seed");
    expect(seed.SEED_SPATIAL_MAP.cells.length).toBeGreaterThan(0);
  });
});

describe("requireDisposableTarget — tools that destroy data never touch the canonical LOCAL database", () => {
  const CANONICAL = `postgresql://robotx_dev:${SECRET}@127.0.0.1:5433/robotx?schema=public`;
  function check(url) {
    const errors = [];
    let exitCode = null;
    const target = requireDisposableTarget({ DATABASE_URL: url }, { canonicalUrls: [CANONICAL], error: (m) => errors.push(m), exit: (c) => { exitCode = c; } });
    return { target, exitCode, text: errors.join("\n") };
  }

  test.each([
    ["the canonical URL itself", CANONICAL],
    ["another loopback spelling of it", `postgresql://other:pw@localhost:5433/robotx`],
    ["IPv6 loopback", `postgresql://other:pw@[::1]:5433/robotx?connection_limit=20`],
  ])("refuses %s (exit 78, no credential printed)", (_label, url) => {
    const { target, exitCode, text } = check(url);
    expect(target).toBeNull();
    expect(exitCode).toBe(78);
    expect(text).toContain("canonical LOCAL database");
    expect(text).not.toContain(SECRET);
  });

  test("refuses a non-loopback database", () => {
    const { target, exitCode, text } = check(REMOTE);
    expect(target).toBeNull();
    expect(exitCode).toBe(78);
    expect(text).not.toContain(SECRET);
  });

  test.each([[""], ["not a url"]])("refuses DATABASE_URL=%j", (url) => {
    expect(check(url).exitCode).toBe(78);
  });

  test("admits a disposable loopback database (the benchmark's own)", () => {
    expect(check("postgresql://bench:bench@localhost:5433/robotx_bench?connection_limit=20")).toEqual({
      target: { database: "robotx_bench" },
      exitCode: null,
      text: "",
    });
  });

  test("benchmark/orchestrator.js refuses the canonical LOCAL database before creating any client (exit 78)", async () => {
    // A home directory of the test's own whose LOCAL file names an unreachable "canonical" database.
    const home = fs.mkdtempSync(path.join(dir, "home-"));
    const canonical = `postgresql://robotx_dev:${SECRET}@127.0.0.1:1/robotx_canonical_probe`;
    fs.mkdirSync(path.join(home, "robotx-secrets"));
    fs.writeFileSync(path.join(home, "robotx-secrets", "robotx-local.env"), `ROBOTX_ENV=LOCAL\nDATABASE_URL=${canonical}\n`);
    const { code, out } = await run(["benchmark/orchestrator.js", "10"], {
      HOME: home,
      USERPROFILE: home,
      BENCH_DATABASE_URL: canonical.replace("127.0.0.1", "localhost"),
      BENCH_STAGE: "phase6-guard-probe",
    });
    expect(code).toBe(78);
    expect(out).toContain("canonical LOCAL database");
    expect(out).not.toContain(SECRET);
    expect(fs.existsSync(path.join(BACKEND, "benchmark", "results", "phase6-guard-probe"))).toBe(false);
  }, 45_000);
});

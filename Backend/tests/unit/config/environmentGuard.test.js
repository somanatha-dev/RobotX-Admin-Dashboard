"use strict";

/**
 * The LOCAL environment guard and the configuration-file resolution (docs/runbooks/environments.md).
 *
 * LOCAL development runs against a copy of production data on this machine. A process that
 * declares ROBOTX_ENV=LOCAL must therefore never reach a cloud database or a hosted Redis —
 * whatever a stray process variable or an old worktree `.env` says. A deployment, which does
 * not set ROBOTX_ENV, is untouched.
 *
 * The last block boots the real `server.js` with a Neon-shaped DATABASE_URL whose host is under
 * the reserved `.invalid` domain, so even a guard failure could reach nothing.
 */

const path = require("path");
const { spawn } = require("child_process");

const fs = require("fs");
const os = require("os");

const { checkEnvironment, assertEnvironment, requireLocalTarget } = require("../../../src/config/environmentGuard");
// The pure resolver — requiring src/config/env.js would load a configuration file into this process.
const { resolveEnvFile, BACKEND_ENV_FILE, LOCAL_ENV_FILE } = require("../../../src/config/envFile");

const BACKEND = path.join(__dirname, "../../..");
const SECRET = "s3cr3t-password-value";
const NEON = `postgresql://owner:${SECRET}@ep-example-123456.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`;
const LOCAL_DB = `postgresql://robotx_dev:${SECRET}@127.0.0.1:5433/robotx?schema=public`;

describe("environmentGuard — inactive without ROBOTX_ENV", () => {
  test("a deployment or test process that does not declare LOCAL is not checked", () => {
    expect(checkEnvironment({ DATABASE_URL: NEON }).active).toBe(false);
    // Phase 6: only an ABSENT ROBOTX_ENV is "not checked". A present-but-blank one used to read
    // as absent, which let a process-level `ROBOTX_ENV=` switch the guard off while the LOCAL
    // file still loaded its database; it is now a refusal (tests/unit/config/localWriteGuards.test.js).
    const blank = checkEnvironment({ ROBOTX_ENV: "  ", DATABASE_URL: NEON });
    expect(blank.active).toBe(true);
    expect(blank.problems.join(" ")).toMatch(/set but empty/);
  });

  test("an unknown ROBOTX_ENV is refused rather than guessed at", () => {
    const r = checkEnvironment({ ROBOTX_ENV: "PRODUCTION", DATABASE_URL: NEON });
    expect(r.active).toBe(true);
    expect(r.problems).toHaveLength(1);
  });
});

describe("environmentGuard — LOCAL", () => {
  test("a loopback database with Redis off is admitted", () => {
    const r = checkEnvironment({ ROBOTX_ENV: "LOCAL", DATABASE_URL: LOCAL_DB, REDIS_ENABLED: "false", REDIS_URL: "" });
    expect(r.problems).toEqual([]);
    expect(r.summary).toBe("database 127.0.0.1:5433/robotx, Redis off");
  });

  test.each(["localhost", "127.0.0.1", "[::1]"])("loopback host %s is admitted", (host) => {
    const r = checkEnvironment({ ROBOTX_ENV: "local", DATABASE_URL: `postgresql://u:p@${host}:5433/robotx` });
    expect(r.problems).toEqual([]);
  });

  test("a Neon DATABASE_URL is refused, and the message carries no credential", () => {
    const r = checkEnvironment({ ROBOTX_ENV: "LOCAL", DATABASE_URL: NEON });
    expect(r.problems).toEqual(["DATABASE_URL points at a Neon host; LOCAL accepts a loopback database only"]);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(JSON.stringify(r)).not.toContain("ep-example");
  });

  test("any other remote database host is refused", () => {
    const r = checkEnvironment({ ROBOTX_ENV: "LOCAL", DATABASE_URL: "postgresql://u:p@db.example.com:5432/x" });
    expect(r.problems[0]).toMatch(/non-loopback host/);
  });

  test("a missing or unparsable DATABASE_URL is refused — LOCAL never falls back to another database", () => {
    expect(checkEnvironment({ ROBOTX_ENV: "LOCAL" }).problems[0]).toMatch(/not set/);
    expect(checkEnvironment({ ROBOTX_ENV: "LOCAL", DATABASE_URL: "not a url" }).problems[0]).toMatch(/not a valid URL/);
  });

  test("a hosted REDIS_URL is refused even with REDIS_ENABLED=false (it feeds the KV and the Socket.IO adapter)", () => {
    const hosted = `redis://default:${SECRET}@redis-12345.c1.us-east-1-2.ec2.cloud.redislabs.com:12345`;
    for (const enabled of ["true", "false", undefined]) {
      const r = checkEnvironment({ ROBOTX_ENV: "LOCAL", DATABASE_URL: LOCAL_DB, REDIS_ENABLED: enabled, REDIS_URL: hosted });
      expect(r.problems).toEqual(["REDIS_URL points at a non-loopback host; LOCAL accepts a loopback Redis only"]);
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
  });

  test("a loopback Redis is admitted", () => {
    const r = checkEnvironment({ ROBOTX_ENV: "LOCAL", DATABASE_URL: LOCAL_DB, REDIS_ENABLED: "true", REDIS_URL: "redis://127.0.0.1:6379" });
    expect(r.problems).toEqual([]);
    expect(r.summary).toMatch(/Redis loopback$/);
  });

  test("assertEnvironment exits 78 on a refusal and logs no credential", () => {
    const lines = [];
    let code = null;
    assertEnvironment({ ROBOTX_ENV: "LOCAL", DATABASE_URL: NEON }, {
      log: (m) => lines.push(m), error: (m) => lines.push(m), exit: (c) => { code = c; },
    });
    expect(code).toBe(78);
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  test("assertEnvironment logs the admitted target and the file it came from", () => {
    const lines = [];
    assertEnvironment({ ROBOTX_ENV: "LOCAL", DATABASE_URL: LOCAL_DB, REDIS_ENABLED: "false" }, {
      loadedFrom: "C:/somewhere/robotx-local.env", log: (m) => lines.push(m), exit: () => { throw new Error("must not exit"); },
    });
    expect(lines).toEqual(["[env] LOCAL: database 127.0.0.1:5433/robotx, Redis off; configuration from C:/somewhere/robotx-local.env"]);
  });
});

describe("requireLocalTarget — scripts that write to a database", () => {
  const io = () => {
    const out = { lines: [], code: null };
    out.error = (m) => out.lines.push(m);
    out.exit = (c) => { out.code = c; };
    return out;
  };

  test("an absent ROBOTX_ENV is a refusal, not a pass", () => {
    const o = io();
    expect(requireLocalTarget({ DATABASE_URL: LOCAL_DB }, o)).toBeNull();
    expect(o.code).toBe(78);
  });

  test("LOCAL with a Neon database is refused without printing the credential", () => {
    const o = io();
    expect(requireLocalTarget({ ROBOTX_ENV: "LOCAL", DATABASE_URL: NEON }, o)).toBeNull();
    expect(o.code).toBe(78);
    expect(o.lines.join("\n")).not.toContain(SECRET);
  });

  test("LOCAL with a loopback database returns the target, never a credential", () => {
    const o = io();
    const target = requireLocalTarget({ ROBOTX_ENV: "LOCAL", DATABASE_URL: LOCAL_DB }, o);
    expect(o.code).toBeNull();
    expect(target).toEqual({ host: "127.0.0.1", port: "5433", database: "robotx" });
  });
});

describe("prisma/seed-pin.js — disabled unless explicitly requested", () => {
  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "seedpin-")); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  // A configuration file of the test's own, so nothing comes from the machine's real LOCAL file.
  function run(fileLines, args = []) {
    const file = path.join(dir, `cfg-${Math.random().toString(36).slice(2)}.env`);
    fs.writeFileSync(file, fileLines.join("\n"));
    const env = { ...process.env, ROBOTX_ENV_FILE: file, SEED_ADMIN_PIN: "123456" };
    for (const k of ["ROBOTX_ENV", "DATABASE_URL", "REDIS_URL", "REDIS_ENABLED"]) delete env[k];
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["prisma/seed-pin.js", ...args], { cwd: BACKEND, env });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      const timer = setTimeout(() => { child.kill(); resolve({ code: "TIMEOUT", out }); }, 20_000);
      child.on("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
  }
  // Port 1 on loopback: nothing listens, so even a guard failure could write nowhere.
  const UNREACHABLE = `DATABASE_URL=postgresql://u:${SECRET}@127.0.0.1:1/robotx`;

  test("refuses without ROBOTX_ENV=LOCAL (exit 78)", async () => {
    const { code, out } = await run([UNREACHABLE]);
    expect(code).toBe(78);
    expect(out).toContain("REFUSED: this script writes to a database");
    expect(out).not.toContain(SECRET);
  }, 30_000);

  test("refuses a Neon target even when LOCAL is declared (exit 78)", async () => {
    const { code, out } = await run(["ROBOTX_ENV=LOCAL", `DATABASE_URL=postgresql://o:${SECRET}@ep-x.aws.neon.tech.invalid/neondb`]);
    expect(code).toBe(78);
    expect(out).not.toContain(SECRET);
  }, 30_000);

  test("--apply without a matching --confirm-database writes nothing (exit 1)", async () => {
    const { code, out } = await run(["ROBOTX_ENV=LOCAL", UNREACHABLE], ["--apply", "--confirm-database", "some-other-db"]);
    expect(code).toBe(1);
    expect(out).toContain("--apply requires --confirm-database robotx");
    expect(out).not.toContain(SECRET);
  }, 30_000);
});

describe("env — which configuration file loads", () => {
  const home = path.join(path.sep, "home", "dev");
  const local = path.join(home, LOCAL_ENV_FILE);

  test("ROBOTX_ENV_FILE wins, and a missing one is an error rather than a fallback", () => {
    expect(resolveEnvFile({ env: { ROBOTX_ENV_FILE: "/x/a.env" }, exists: () => true, homedir: home })).toBe("/x/a.env");
    expect(() => resolveEnvFile({ env: { ROBOTX_ENV_FILE: "/x/a.env" }, exists: () => false, homedir: home })).toThrow(/does not exist/);
  });

  test("Backend/.env is used when present (older worktrees)", () => {
    expect(resolveEnvFile({ env: {}, exists: (p) => p === BACKEND_ENV_FILE || p === local, homedir: home })).toBe(BACKEND_ENV_FILE);
  });

  test("otherwise the LOCAL file outside the repository", () => {
    expect(resolveEnvFile({ env: {}, exists: (p) => p === local, homedir: home })).toBe(local);
  });

  test("no file at all loads nothing (a deployment sets its variables itself)", () => {
    expect(resolveEnvFile({ env: {}, exists: () => false, homedir: home })).toBeNull();
  });
});

describe("server.js — the guard runs before anything connects", () => {
  function boot(env) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["server.js"], {
        cwd: BACKEND,
        env: { ...process.env, PORT: "0", HOST: "127.0.0.1", ENGINE_ENABLED: "false", ...env },
      });
      let out = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { out += d; });
      const timer = setTimeout(() => { child.kill(); resolve({ code: "TIMEOUT", out }); }, 20_000);
      child.on("exit", (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
  }

  test("ROBOTX_ENV=LOCAL with a Neon-shaped DATABASE_URL exits 78 without printing it", async () => {
    // `.invalid` is reserved (RFC 2606) and never resolves, so a guard failure could reach nothing.
    const neonShaped = `postgresql://owner:${SECRET}@ep-guard-test.aws.neon.tech.invalid/neondb?sslmode=require`;
    const { code, out } = await boot({ ROBOTX_ENV: "LOCAL", DATABASE_URL: neonShaped, REDIS_URL: "", REDIS_ENABLED: "false" });
    expect(code).toBe(78);
    expect(out).toContain("REFUSED to start the LOCAL environment");
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("Prisma");
  }, 30_000);
});

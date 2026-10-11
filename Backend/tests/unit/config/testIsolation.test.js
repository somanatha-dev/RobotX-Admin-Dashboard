"use strict";

/**
 * Test isolation from every real database (docs/runbooks/environments.md).
 *
 * Before this, a Jest process loaded the developer's real configuration file — Backend/.env
 * or %USERPROFILE%\robotx-secrets\robotx-local.env — through `src/config/env.js`, and so
 * inherited the canonical LOCAL `DATABASE_URL`. No test used an unmocked client, so nothing
 * was written, but one forgotten `jest.mock` would have written test fixtures into `robotx`.
 *
 * Now `tests/setup/env.js` names an empty, tracked configuration file and an unreachable
 * database, and `src/config/envFile.js` refuses to fall back to a developer's file in any
 * NODE_ENV=test process. These tests pin all three, plus the one thing that must not change:
 * an ordinary development start still loads the LOCAL file.
 *
 * Secret values are compared as booleans so a failure can never print one.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const dotenv = require("dotenv");

const { ISOLATED_ENV_FILE, UNREACHABLE_DATABASE_URL } = require("../../setup/isolation");
const { resolveEnvFile, BACKEND_ENV_FILE, LOCAL_ENV_FILE } = require("../../../src/config/envFile");

const BACKEND = path.join(__dirname, "../../..");

describe("a test process is isolated from every real configuration file and database", () => {
  test("it names the tracked, empty isolation file — and env.js loads that file and nothing else", () => {
    expect(process.env.ROBOTX_ENV_FILE).toBe(ISOLATED_ENV_FILE);
    const assignments = dotenv.parse(fs.readFileSync(ISOLATED_ENV_FILE));
    expect(Object.keys(assignments)).toEqual([]);

    const { loadedFrom } = require("../../../src/config/env");
    expect(loadedFrom).toBe(ISOLATED_ENV_FILE);
  });

  test("its database URL is the unreachable one, and no LOCAL identity is declared", () => {
    expect(process.env.DATABASE_URL).toBe(UNREACHABLE_DATABASE_URL);
    const url = new URL(process.env.DATABASE_URL);
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.port).toBe("1");
    expect(process.env.ROBOTX_ENV).toBeUndefined();
  });

  test("nothing from this machine's real LOCAL file reached the process", () => {
    const real = path.join(os.homedir(), LOCAL_ENV_FILE);
    // A machine without the file (CI) has nothing that could leak.
    if (!fs.existsSync(real)) return;
    const values = dotenv.parse(fs.readFileSync(real));
    for (const key of ["DATABASE_URL", "ROBOTX_ENV", "SHARD_ID", "COMMAND_SIGNING_KEY", "PRIVACY_IDENTITY_KEY", "JWT_SECRET"]) {
      if (!values[key]) continue;
      // Boolean, so a failure names the key and never prints the value.
      expect({ key, leaked: process.env[key] === values[key] }).toEqual({ key, leaked: false });
    }
  });

  test("a NODE_ENV=test process never falls back to Backend/.env or the LOCAL file", () => {
    const home = path.join(path.sep, "home", "dev");
    const everyFileExists = () => true;
    expect(resolveEnvFile({ env: { NODE_ENV: "test" }, exists: everyFileExists, homedir: home })).toBeNull();
    // An explicit file still wins — that is how the setup names the isolation file.
    expect(resolveEnvFile({ env: { NODE_ENV: "test", ROBOTX_ENV_FILE: "/x/t.env" }, exists: everyFileExists, homedir: home })).toBe("/x/t.env");
  });

  test("an unmocked database client fails at once instead of reaching a database", async () => {
    // The application's own client path. Loopback port 1 refuses the connection immediately.
    const db = require("../../../src/db/prisma");
    const started = Date.now();
    let failure = null;
    try {
      await db.getPrisma().$queryRaw`SELECT 1`;
    } catch (error) {
      failure = error;
    } finally {
      await db.disconnectPrisma().catch(() => {});
    }
    expect(failure).not.toBeNull();
    expect(String(failure.message)).toMatch(/127\.0\.0\.1:1|Can't reach database server/);
    expect(Date.now() - started).toBeLessThan(9_000);
  }, 15_000);
});

describe("an ordinary development start still loads the LOCAL file", () => {
  // Backend/.env takes precedence when present (older worktrees), so the check only applies
  // to a checkout without one — which is the main checkout this rule exists for.
  const runIfNoBackendEnv = fs.existsSync(BACKEND_ENV_FILE) ? test.skip : test;

  runIfNoBackendEnv("with no NODE_ENV=test and no ROBOTX_ENV_FILE, env.js loads ~/robotx-secrets/robotx-local.env", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "robotx-home-"));
    try {
      const file = path.join(home, LOCAL_ENV_FILE);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "ROBOTX_ISOLATION_MARKER=dev-file-loaded\nDATABASE_URL=postgresql://marker@127.0.0.1:1/marker\n");

      const env = { ...process.env, HOME: home, USERPROFILE: home };
      for (const key of ["NODE_ENV", "ROBOTX_ENV_FILE", "DATABASE_URL", "ROBOTX_ENV", "ROBOTX_ISOLATION_MARKER"]) delete env[key];

      const script =
        "const { loadedFrom } = require('./src/config/env');" +
        "process.stdout.write('\\nRESULT ' + JSON.stringify({ loadedFrom, marker: process.env.ROBOTX_ISOLATION_MARKER }));";
      const out = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["-e", script], { cwd: BACKEND, env });
        let text = "";
        child.stdout.on("data", (d) => { text += d; });
        child.stderr.on("data", (d) => { text += d; });
        child.on("error", reject);
        child.on("exit", () => resolve(text));
      });
      const line = out.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
      expect(line).toBeDefined();
      const result = JSON.parse(line.slice("RESULT ".length));
      expect(result).toEqual({ loadedFrom: file, marker: "dev-file-loaded" });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});

#!/usr/bin/env node
/**
 * Run the Prisma CLI against the LOCAL database — and only the commands that cannot change it
 * (docs/runbooks/environments.md).
 *
 *   npm run prisma:local -- migrate status
 *   node tools/env/withLocalEnv.js npx prisma migrate status
 *
 * Three refusals, in this order, each before the next step runs:
 *   1. anything but the Prisma CLI (this used to run any command with the LOCAL configuration);
 *   2. a Prisma command outside `prismaCommandPolicy.js`'s allow-list (`migrate reset`,
 *      `db push`, `db seed`, `db execute`, `migrate dev`, `studio`, …) — decided from the
 *      arguments alone, before any configuration is loaded, so a refused command never sees a
 *      database URL;
 *   3. a configuration that does not declare ROBOTX_ENV=LOCAL with a loopback database and Redis;
 *   4. `migrate deploy` without `--confirm-database <name>` naming the target database.
 *
 * The CLI runs as `node <prisma>/build/index.js` with no shell, so an argument can never be read
 * as a second command (`&&` under cmd.exe).
 */
const { spawnSync } = require("child_process");
const path = require("path");

const policy = require("./prismaCommandPolicy");

const BACKEND = path.join(__dirname, "..", "..");

function refuse(code, lines) {
  for (const line of lines) console.error(`[prisma:local] ${line}`);
  process.exit(code);
}

let args = process.argv.slice(2);
if (args[0] === "npx" && args[1] === "prisma") args = args.slice(2);
else if (args[0] === "prisma") args = args.slice(1);
else {
  refuse(64, [
    "REFUSED: this wrapper runs only the Prisma CLI.",
    "usage: npm run prisma:local -- <prisma command>   (e.g. migrate status)",
  ]);
}

const verdict = policy.classify(args);
if (!verdict.allowed) {
  // 77 = EX_NOPERM. Nothing has been loaded or contacted.
  refuse(77, [
    `REFUSED: ${verdict.reason}.`,
    "The LOCAL database is the canonical copy of production data; prisma:local runs only commands that cannot change it.",
  ]);
}

const { loadedFrom } = require(path.join(BACKEND, "src", "config", "env"));
const guard = require(path.join(BACKEND, "src", "config", "environmentGuard"));
if (!guard.checkEnvironment(process.env).active) {
  refuse(78, ["REFUSED: prisma:local runs only in the declared LOCAL environment (ROBOTX_ENV=LOCAL)."]);
}
guard.assertEnvironment(process.env, { loadedFrom });

if (verdict.requiresConfirmedDatabase) {
  const target = decodeURIComponent(new URL(process.env.DATABASE_URL.trim()).pathname.replace(/^\//, ""));
  if (verdict.confirmDatabase !== target) {
    refuse(77, [
      `REFUSED: ${args.join(" ")} applies pending migrations to the LOCAL database "${target}".`,
      `Review them, then repeat with ${policy.CONFIRM_FLAG} ${target}. Nothing was run.`,
    ]);
  }
}

let cli;
try {
  cli = require.resolve("prisma/build/index.js", { paths: [BACKEND] });
} catch (error) {
  refuse(1, [`could not find the Prisma CLI: ${error.message}`]);
}

// `prismaArgs`: the wrapper's own --confirm-database removed; Prisma would reject it.
const result = spawnSync(process.execPath, [cli, ...verdict.prismaArgs], { cwd: BACKEND, env: process.env, stdio: "inherit" });
if (result.error) refuse(1, [`could not run prisma: ${result.error.message}`]);
process.exit(result.status === null ? 1 : result.status);

/**
 * Which Prisma CLI commands `npm run prisma:local` may run against the LOCAL database
 * (docs/runbooks/environments.md). The LOCAL database is the canonical copy of production
 * data, so the wrapper permits inspection and code generation, and one writing command —
 * `migrate deploy`, the runbook's reviewed path for a new migration — only with
 * `--confirm-database <name>` matching the target. Nothing that resets, pushes, seeds or runs SQL.
 *
 * An ALLOW-list, not a deny-list: a command or spelling this file does not name is refused,
 * so a new Prisma subcommand, an alias or an unexpected argument order fails closed. A second,
 * independent check refuses any argument that names a destructive operation wherever it
 * appears, so the two would both have to be wrong for one to get through.
 *
 * Pure: it reads only the argument list. The wrapper calls it before loading any configuration.
 */

/** Flags that consume the next argument as their value (`--schema prisma/x.prisma`). */
const VALUE_FLAGS = new Set([
  "--schema",
  "--from-url",
  "--to-url",
  "--from-schema-datamodel",
  "--to-schema-datamodel",
  "--from-schema-datasource",
  "--to-schema-datasource",
  "--from-migrations",
  "--to-migrations",
  "--shadow-database-url",
  "--generator",
  "--composite-type-depth",
  "--name",
  "-n",
  "--url",
  "--file",
  "--output",
  "--port",
  "-p",
  "--browser",
]);

/**
 * Words that name a destructive or writing operation. Refused wherever they appear, in any
 * case and with or without leading dashes or an `=value` suffix.
 */
const DESTRUCTIVE_WORDS = new Set([
  "reset", // migrate reset — drops the database
  "push", // db push — rewrites the schema, may drop data
  "execute", // db execute — arbitrary SQL
  "seed", // db seed — writes rows
  // `deploy` is not here: `migrate deploy` is the runbook's reviewed path for applying a new
  // migration to LOCAL (environments.md §5), admitted only with --confirm-database (below).
  "dev", // migrate dev — may reset, then applies migrations and seeds
  "resolve", // migrate resolve — rewrites migration history
  "studio", // an interactive editor that writes rows
  "force-reset",
  "accept-data-loss",
  "shadow-database-url", // the shadow database is wiped; never point it anywhere through LOCAL
  "init",
  "debug", // prints environment details
]);

/** [command, subcommand] pairs that may run, with an extra condition where one is needed. */
const ALLOWED = [
  { words: [], onlyFlags: ["--version", "-v", "--help", "-h"], label: "version / help" },
  { words: ["version"], label: "version" },
  { words: ["validate"], label: "validate" },
  { words: ["format"], label: "format" },
  { words: ["generate"], label: "generate" },
  { words: ["migrate", "status"], label: "migrate status" },
  { words: ["migrate", "diff"], label: "migrate diff" },
  { words: ["db", "pull"], requiresFlag: "--print", label: "db pull --print" },
  // Applies reviewed, pending migrations — it changes the LOCAL schema, so it needs the same
  // deliberate act `seed-pin.js --apply` does: the wrapper checks the name against the target.
  { words: ["migrate", "deploy"], requiresConfirmedDatabase: true, label: "migrate deploy --confirm-database <db>" },
];

/** The wrapper's own flag; never passed to Prisma. */
const CONFIRM_FLAG = "--confirm-database";

/**
 * Remove the wrapper's `--confirm-database <name>` (or `=name`) from the arguments.
 * @param {string[]} args
 * @returns {{ args: string[], confirmDatabase: string|null }}
 */
function takeConfirmation(args) {
  const rest = [];
  let confirmDatabase = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === CONFIRM_FLAG) {
      confirmDatabase = i + 1 < args.length ? String(args[i + 1]) : "";
      i += 1;
    } else if (arg.startsWith(`${CONFIRM_FLAG}=`)) {
      confirmDatabase = arg.slice(CONFIRM_FLAG.length + 1);
    } else {
      rest.push(arg);
    }
  }
  return { args: rest, confirmDatabase };
}

function normalise(arg) {
  return String(arg).toLowerCase().replace(/^-+/, "").split("=")[0];
}

/**
 * @param {string[]} args the arguments after `prisma`, possibly with the wrapper's --confirm-database
 * @returns {{ allowed: true, command: string, prismaArgs: string[], confirmDatabase: string|null,
 *   requiresConfirmedDatabase: boolean } | { allowed: false, reason: string }}
 *   `prismaArgs` is what Prisma receives (the confirmation removed). When
 *   `requiresConfirmedDatabase`, the caller must check `confirmDatabase` against the target.
 */
function classify(args) {
  if (!Array.isArray(args)) return { allowed: false, reason: "no arguments" };
  const { args: list, confirmDatabase } = takeConfirmation(args.map(String));

  const destructive = list.find((arg) => DESTRUCTIVE_WORDS.has(normalise(arg)));
  if (destructive !== undefined) {
    return { allowed: false, reason: `"${destructive}" names an operation that writes to or drops the database` };
  }

  const positionals = [];
  const flags = [];
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (arg.startsWith("-")) {
      const name = arg.split("=")[0];
      flags.push(name);
      if (!arg.includes("=") && VALUE_FLAGS.has(name)) i += 1; // its value is not a command word
      continue;
    }
    positionals.push(arg);
  }

  for (const rule of ALLOWED) {
    if (positionals.length !== rule.words.length) continue;
    if (!rule.words.every((word, index) => positionals[index] === word)) continue;
    if (rule.onlyFlags && (flags.length === 0 || !flags.every((f) => rule.onlyFlags.includes(f)))) continue;
    if (rule.requiresFlag && !flags.includes(rule.requiresFlag)) {
      return { allowed: false, reason: `${rule.words.join(" ")} is allowed only with ${rule.requiresFlag} (it would overwrite schema.prisma)` };
    }
    if (rule.requiresConfirmedDatabase && !confirmDatabase) {
      return { allowed: false, reason: `${rule.words.join(" ")} changes the LOCAL schema and needs ${CONFIRM_FLAG} <database name>` };
    }
    return {
      allowed: true,
      command: rule.label,
      prismaArgs: list,
      confirmDatabase,
      requiresConfirmedDatabase: Boolean(rule.requiresConfirmedDatabase),
    };
  }

  const shown = positionals.length ? positionals.join(" ") : "(no command)";
  return {
    allowed: false,
    reason: `"${shown}" is not on the allow-list. Allowed: ${ALLOWED.map((r) => r.label).join(", ")}`,
  };
}

module.exports = { classify, ALLOWED, DESTRUCTIVE_WORDS, CONFIRM_FLAG };

"use strict";

/**
 * Phase 2 — schema and migration.
 *
 * Three properties, each of which the phase's completion criteria name:
 *
 *   1. **The migration is additive.** "Additive-only DDL (no drops)". A `DROP`, a
 *      `RENAME`, or a re-type of an existing column anywhere in the file fails.
 *   2. **The migration agrees with the schema.** The hand-written SQL is compared
 *      statement-by-statement against the SQL Prisma itself generates for
 *      `schema.prisma`. This needs no database — `prisma migrate diff
 *      --from-empty --to-schema-datamodel` produces it offline — so the check runs
 *      in CI and on any developer machine, and the migration cannot silently drift
 *      from the models.
 *   3. **The schema agrees with the specification.** Every §4.3 Leg state, §2.4
 *      purpose, §2.5 custody state, §4.3 obstruction class, and §2.1 lifecycle state
 *      appears in its enum, in both directions: an enum value with no §-defined
 *      meaning fails just as loudly as a missing one.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const agent = require("../../src/engine/domain/agent");
const custody = require("../../src/engine/domain/custody");
const purpose = require("../../src/engine/domain/purpose");
const work = require("../../src/engine/domain/work");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const SCHEMA_PATH = path.join(BACKEND_ROOT, "prisma", "schema.prisma");
const MIGRATION_PATH = path.join(
  BACKEND_ROOT,
  "prisma",
  "migrations",
  "20260728140000_domain_model_and_spatial_hierarchy",
  "migration.sql",
);

const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
const migration = fs.readFileSync(MIGRATION_PATH, "utf8");

/** Strip `--` comments so a phrase in prose is never mistaken for a statement. */
function sqlOnly(source) {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

const migrationSql = sqlOnly(migration);

/** Split SQL into statements, keeping `$$ … $$` function bodies intact. */
function statements(source) {
  const out = [];
  let current = "";
  let inDollarQuote = false;
  for (const line of source.split("\n")) {
    if (line.includes("$$")) inDollarQuote = !inDollarQuote || line.split("$$").length % 2 === 0 ? !inDollarQuote : inDollarQuote;
    current += `${line}\n`;
    if (!inDollarQuote && line.trimEnd().endsWith(";")) {
      const trimmed = current.trim();
      if (trimmed) out.push(trimmed.replace(/\s+/g, " "));
      current = "";
    }
  }
  return out;
}

/** The tables Phase 2 creates. */
const PHASE_2_TABLES = Object.freeze([
  "Region",
  "Site",
  "CellAssignment",
  "MobilityModel",
  "EnergyModel",
  "ContainerModel",
  "Compartment",
  "CapabilityBundle",
  "Capability",
  "AgentClass",
  "Agent",
  "PayloadSpec",
  "PayloadManifest",
  "Mission",
  "Leg",
  "Stop",
  "Commitment",
  "Observation",
  "DecisionRecordA",
  "_MissionToTask",
]);

const PHASE_2_ENUMS = Object.freeze([
  "LifecycleState",
  "LegPurpose",
  "LegState",
  "CustodyState",
  "ObstructionClass",
]);

describe("the migration is additive", () => {
  test("it drops nothing", () => {
    expect(migrationSql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TYPE)\b/i);
  });

  test("it renames nothing", () => {
    expect(migrationSql).not.toMatch(/\bRENAME\b/i);
  });

  test("it re-types no existing column", () => {
    expect(migrationSql).not.toMatch(/\bALTER\s+COLUMN\b/i);
  });

  test("the only pre-existing tables it alters are Zone and Task", () => {
    const altered = new Set(
      [...migrationSql.matchAll(/ALTER TABLE "([A-Za-z_]+)"/g)].map((match) => match[1]),
    );
    const preExisting = [...altered].filter((table) => !PHASE_2_TABLES.includes(table));
    expect(preExisting.sort()).toEqual(["Task", "Zone"]);
  });

  test("every column it adds to Zone and Task is nullable or defaulted", () => {
    const addColumns = [...migrationSql.matchAll(/ADD COLUMN\s+"([A-Za-z]+)"\s+([^,;]+)/g)];
    expect(addColumns.length).toBeGreaterThan(0);
    for (const [, column, definition] of addColumns) {
      const notNullWithoutDefault = /NOT NULL/i.test(definition) && !/DEFAULT/i.test(definition);
      expect({ column, notNullWithoutDefault }).toEqual({ column, notNullWithoutDefault: false });
    }
  });

  test("it extends TaskStatus rather than replacing it", () => {
    expect(migrationSql).not.toMatch(/CREATE TYPE "TaskStatus"/);
    const added = [...migrationSql.matchAll(/ALTER TYPE "TaskStatus" ADD VALUE '([A-Z_]+)'/g)].map((m) => m[1]);
    expect(added.sort()).toEqual([
      "AT_RISK",
      "IN_EXECUTION",
      "PLANNABLE",
      "RECEIVED",
      "REJECTED",
      "SUSPENDED",
      "VERIFYING",
      "WAITING",
    ]);
  });

  test("the six legacy TaskStatus values are untouched", () => {
    for (const legacyValue of work.LEGACY_TASK_STATUSES) {
      expect(migrationSql).not.toMatch(new RegExp(`ALTER TYPE "TaskStatus" ADD VALUE '${legacyValue}'`));
    }
    expect(schema).toMatch(/enum TaskStatus[\s\S]*PENDING[\s\S]*ASSIGNED[\s\S]*IN_PROGRESS/);
  });
});

describe("the migration agrees with schema.prisma", () => {
  // Prisma's own generated SQL for the full datamodel, obtained offline.
  const generated = execFileSync(
    process.execPath,
    [
      path.join(BACKEND_ROOT, "node_modules", "prisma", "build", "index.js"),
      "migrate",
      "diff",
      "--from-empty",
      "--to-schema-datamodel",
      SCHEMA_PATH,
      "--script",
    ],
    { cwd: BACKEND_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );

  const generatedStatements = statements(sqlOnly(generated));
  const migrationStatements = statements(migrationSql);

  // ── Columns added by *later* migrations ──────────────────────────────────
  //
  // `prisma migrate diff --from-empty` generates the schema as it stands **now**,
  // while this migration is a historical artefact that necessarily predates every
  // additive change made after it. Phase 3 adds `Commitment.capacitySlot`, so the
  // generated `CREATE TABLE "Commitment"` carries a column this file correctly does
  // not.
  //
  // Comparing them naively would make this test fail on every future additive
  // column — which would be a test that re-baselines itself out of existence rather
  // than one that detects drift. The comparison therefore subtracts exactly the
  // columns that a migration dated after this one adds, read from those migrations
  // rather than hard-coded, and compares the remainder verbatim. Drift in anything
  // this migration *does* declare still fails.
  const MIGRATIONS_ROOT = path.join(BACKEND_ROOT, "prisma", "migrations");
  const THIS_MIGRATION = "20260728140000_domain_model_and_spatial_hierarchy";

  const columnsAddedLater = new Map();
  for (const directory of fs.readdirSync(MIGRATIONS_ROOT).sort()) {
    if (directory <= THIS_MIGRATION) continue;
    const file = path.join(MIGRATIONS_ROOT, directory, "migration.sql");
    if (!fs.existsSync(file)) continue;
    for (const [, table, column] of fs
      .readFileSync(file, "utf8")
      // `\s+`, not a single space: Prisma's own generated style — which every migration
      // in this tree copies — is `ADD COLUMN     "x"` with five. A single-space pattern
      // matched nothing, so this subtraction was silently inert until Phase 11 became
      // the first later migration to add a column to a table this one creates.
      .matchAll(/ALTER TABLE "([A-Za-z_]+)" ADD COLUMN\s+"([A-Za-z_]+)"/g)) {
      if (!columnsAddedLater.has(table)) columnsAddedLater.set(table, new Set());
      columnsAddedLater.get(table).add(column);
    }
  }

  // The same subtraction, for indexes. A later phase that adds a column to a table this
  // migration created usually indexes it too, and the generated output carries both —
  // so subtracting only the column would leave the index to fail this comparison for
  // exactly the reason the subtraction exists to excuse.
  const indexesAddedLater = new Set();
  const constraintsAddedLater = new Set();
  for (const directory of fs.readdirSync(MIGRATIONS_ROOT).sort()) {
    if (directory <= THIS_MIGRATION) continue;
    const file = path.join(MIGRATIONS_ROOT, directory, "migration.sql");
    if (!fs.existsSync(file)) continue;
    const sql = fs.readFileSync(file, "utf8");
    for (const [, name] of sql.matchAll(/CREATE (?:UNIQUE )?INDEX "([A-Za-z0-9_]+)"/g)) indexesAddedLater.add(name);
    // A later-added column that is a foreign key brings its constraint with it.
    for (const [, name] of sql.matchAll(/ADD CONSTRAINT "([A-Za-z0-9_]+)"/g)) constraintsAddedLater.add(name);
  }

  const addedByALaterMigration = (statement) =>
    [...indexesAddedLater].some((name) => statement.includes(`INDEX "${name}"`)) ||
    [...constraintsAddedLater].some((name) => statement.includes(`ADD CONSTRAINT "${name}"`));

  /** Remove later-added column definitions from a generated CREATE TABLE. */
  const asOfThisMigration = (statement, table) => {
    const later = columnsAddedLater.get(table);
    if (!later || !statement.startsWith(`CREATE TABLE "${table}"`)) return statement;
    let result = statement;
    for (const column of later) {
      result = result.replace(new RegExp(`\\s*"${column}"[^,]*,`), "");
    }
    return result;
  };

  const relevant = (list, table) =>
    list.filter(
      (statement) =>
        statement.startsWith(`CREATE TABLE "${table}"`) ||
        statement.includes(`ON "${table}"(`) ||
        statement.startsWith(`ALTER TABLE "${table}" ADD CONSTRAINT "${table}_`),
    );

  test.each(PHASE_2_TABLES)("%s: every generated statement appears verbatim in the migration", (table) => {
    const expected = relevant(generatedStatements, table).filter((statement) => !addedByALaterMigration(statement));
    expect(expected.length).toBeGreaterThan(0);
    for (const statement of expected) {
      expect(migrationStatements).toContain(asOfThisMigration(statement, table));
    }
  });

  test("the later-migration subtraction is doing real work, not silently matching everything", () => {
    // If this ever empties, the subtraction above has become a no-op and the test
    // that uses it is weaker than it looks. Phase 3 adds `Commitment.capacitySlot`.
    expect(columnsAddedLater.get("Commitment")).toEqual(new Set(["capacitySlot"]));
  });

  test("the migration adds no table schema.prisma does not declare", () => {
    const created = [...migrationSql.matchAll(/CREATE TABLE "([A-Za-z_]+)"/g)].map((match) => match[1]);
    expect(created.sort()).toEqual([...PHASE_2_TABLES].sort());
  });

  test("every Phase 2 enum is created with exactly the values schema.prisma declares", () => {
    for (const name of PHASE_2_ENUMS) {
      const fromMigration = migrationSql.match(new RegExp(`CREATE TYPE "${name}" AS ENUM \\(([^)]*)\\)`));
      const fromGenerated = generated.match(new RegExp(`CREATE TYPE "${name}" AS ENUM \\(([^)]*)\\)`));
      expect({ name, values: fromMigration && fromMigration[1] }).toEqual({ name, values: fromGenerated && fromGenerated[1] });
    }
  });
});

describe("the schema agrees with the specification", () => {
  const enumValues = (name) => {
    const match = migrationSql.match(new RegExp(`CREATE TYPE "${name}" AS ENUM \\(([^)]*)\\)`));
    return match ? match[1].split(",").map((value) => value.trim().replace(/'/g, "")) : [];
  };

  test("LegPurpose ⟷ §2.4, in both directions", () => {
    expect(enumValues("LegPurpose").sort()).toEqual([...purpose.PURPOSE_NAMES].sort());
  });

  test("LegState ⟷ §4.3, in both directions", () => {
    expect(enumValues("LegState").sort()).toEqual([...work.LEG_STATE_NAMES].sort());
  });

  test("CustodyState ⟷ §2.5, in both directions", () => {
    expect(enumValues("CustodyState").sort()).toEqual([...custody.CUSTODY_STATE_NAMES].sort());
  });

  test("ObstructionClass ⟷ §4.3, in both directions", () => {
    expect(enumValues("ObstructionClass").sort()).toEqual([...work.OBSTRUCTION_CLASS_NAMES].sort());
  });

  test("LifecycleState ⟷ §2.1, in both directions", () => {
    expect(enumValues("LifecycleState").sort()).toEqual([...agent.LIFECYCLE_STATE_NAMES].sort());
  });

  test("TaskStatus carries every §4.2 state", () => {
    const declared = schema.match(/enum TaskStatus \{([\s\S]*?)\}/)[1];
    for (const state of work.TASK_STATE_NAMES) {
      expect(declared).toMatch(new RegExp(`\\b${state}\\b`));
    }
  });
});

describe("schema backstops", () => {
  test("§2.6 / I18 — a CHECK constraint admits HARD commitments only", () => {
    expect(migrationSql).toMatch(/ALTER TABLE "Commitment"\s+ADD CONSTRAINT "Commitment_kind_hard_only" CHECK \("kind" = 'HARD'\)/);
  });

  test("§2.7 — Observation refuses UPDATE at the database", () => {
    expect(migrationSql).toMatch(/CREATE TRIGGER "Observation_append_only"\s+BEFORE UPDATE ON "Observation"/);
    expect(migrationSql).toMatch(/observation_is_append_only/);
  });

  test("§21.2 — DecisionRecordA refuses UPDATE at the database", () => {
    expect(migrationSql).toMatch(/CREATE TRIGGER "DecisionRecordA_immutable"\s+BEFORE UPDATE ON "DecisionRecordA"/);
  });

  test("every RAISE EXCEPTION format string matches its argument count", () => {
    // A placeholder/argument mismatch turns a backstop into a runtime error of a
    // different kind, which is how a backstop silently stops backstopping.
    const blocks = [...migration.matchAll(/RAISE EXCEPTION\s+'([^']*)',([^;]*);/g)];
    expect(blocks.length).toBeGreaterThan(0);
    // Split at top-level commas only: `COALESCE(OLD."x", NEW."x")` is one argument,
    // and a naive split would count it as two.
    const topLevelArguments = (source) => {
      const parts = [];
      let depth = 0;
      let current = "";
      for (const character of source) {
        if (character === "(") depth += 1;
        if (character === ")") depth -= 1;
        if (character === "," && depth === 0) {
          parts.push(current);
          current = "";
          continue;
        }
        current += character;
      }
      parts.push(current);
      return parts.filter((part) => part.trim().length > 0);
    };

    for (const [, format, args] of blocks) {
      const placeholders = (format.match(/%/g) || []).length;
      const argumentCount = topLevelArguments(args).length;
      expect({ format, placeholders, argumentCount }).toEqual({ format, placeholders, argumentCount: placeholders });
    }
  });
});

describe("the Commitment table carries every §2.6 field", () => {
  const commitment = migrationSql.match(/CREATE TABLE "Commitment" \(([\s\S]*?)\);/)[1];

  test.each([
    ["commitmentId", "the idempotency and correlation key"],
    ["agentId", "the binding"],
    ["legId", "the binding"],
    ["fence", "the commitment-scope fencing token"],
    ["leaseExpiry", "the lease"],
    ["custodyState", "§2.5"],
    ["planSnapshotRef", "the committed plan"],
    ["decisionRef", "§21.2"],
    ["version", "optimistic concurrency"],
  ])("%s — %s", (column) => {
    expect(commitment).toMatch(new RegExp(`"${column}"`));
  });

  test("the fence is a BIGINT, not an INTEGER", () => {
    expect(commitment).toMatch(/"fence" BIGINT NOT NULL/);
  });
});

describe("the Agent table carries every field the plan's migration (a) names", () => {
  const agentTable = migrationSql.match(/CREATE TABLE "Agent" \(([\s\S]*?)\);/)[1];

  test.each([
    "agentId",
    "agentClassId",
    "authorityEpoch",
    "fenceCounter",
    "regionId",
    "homeDepotId",
    "lifecycleState",
    "capacityOverride",
  ])("%s", (column) => {
    expect(agentTable).toMatch(new RegExp(`"${column}"`));
  });

  test("both fencing counters are BIGINT and default to zero", () => {
    expect(agentTable).toMatch(/"authorityEpoch" BIGINT NOT NULL DEFAULT 0/);
    expect(agentTable).toMatch(/"fenceCounter" BIGINT NOT NULL DEFAULT 0/);
  });

  test("the 1:1 projection to the legacy Robot row is unique", () => {
    expect(migrationSql).toMatch(/CREATE UNIQUE INDEX "Agent_robotDbId_key" ON "Agent"\("robotDbId"\)/);
  });
});

describe("referential integrity", () => {
  test("a durable Commitment cannot be destroyed by deleting what it references", () => {
    expect(migrationSql).toMatch(/"Commitment_agentId_fkey"[^;]*ON DELETE RESTRICT/);
    expect(migrationSql).toMatch(/"Commitment_legId_fkey"[^;]*ON DELETE RESTRICT/);
  });

  test("decommissioning a Robot still works — its Agent projection cascades", () => {
    expect(migrationSql).toMatch(/"Agent_robotDbId_fkey"[^;]*ON DELETE CASCADE/);
  });

  test("a Mission's Legs and a Leg's Stops cascade with their parent", () => {
    expect(migrationSql).toMatch(/"Leg_missionId_fkey"[^;]*ON DELETE CASCADE/);
    expect(migrationSql).toMatch(/"Stop_legId_fkey"[^;]*ON DELETE CASCADE/);
  });

  test("every foreign key names a table the schema declares", () => {
    const references = [...migrationSql.matchAll(/REFERENCES "([A-Za-z_]+)"\(/g)].map((match) => match[1]);
    expect(references.length).toBeGreaterThan(0);
    for (const table of new Set(references)) {
      const declaredHere = PHASE_2_TABLES.includes(table);
      const declaredEarlier = ["Robot", "Task", "Zone"].includes(table);
      expect({ table, declared: declaredHere || declaredEarlier }).toEqual({ table, declared: true });
    }
  });
});

describe("Redis and Socket.IO are untouched", () => {
  test("the plan specifies no Redis write and no socket event for this phase, and the migration makes none", () => {
    // A schema migration cannot write Redis or emit an event; the assertion is that
    // the phase's new key prefixes are *reserved and unwritten*, which is what the
    // plan's "New key prefixes reserved (not yet written)" row states.
    const engineRoot = path.join(BACKEND_ROOT, "src", "engine");
    const walk = (absolute) => {
      let found = [];
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        const child = path.join(absolute, entry.name);
        if (entry.isDirectory()) found = found.concat(walk(child));
        else if (entry.name.endsWith(".js")) found.push(child);
      }
      return found;
    };

    for (const file of walk(path.join(engineRoot, "domain")).concat(walk(path.join(engineRoot, "spatial")))) {
      const source = fs.readFileSync(file, "utf8");
      expect({ file, writesRedis: /kv\.(set|del|sadd|srem|hset)\s*\(/.test(source) }).toEqual({ file, writesRedis: false });
      expect({ file, emits: /\.emit\s*\(/.test(source) }).toEqual({ file, emits: false });
    }
  });
});

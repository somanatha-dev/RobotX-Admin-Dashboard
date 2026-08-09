"use strict";

/**
 * Engine lane — Phase 6: the migration, the register additions, and the tier mapping.
 *
 * The migration is cross-checked against Prisma's own generated SQL, so the
 * hand-written file and `schema.prisma` cannot silently disagree. What Prisma cannot
 * express — the five CHECK constraints — is asserted as written, and its *absence* from
 * the generated output is asserted too, so a reviewer can tell a hand-written addition
 * from an echo. The same discipline Phases 2, 4, and 5 applied to theirs.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const register = require("../../src/engine/feasibility/register");
const { MARGIN_UNIT } = require("../../src/engine/feasibility/threeValued");
const { tierOf, TIER, MECHANISMS } = require("../../src/engine/guards/tierAssertions");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const MIGRATION = fs.readFileSync(
  path.join(BACKEND_ROOT, "prisma", "migrations", "20260804120000_feasibility_rejection_telemetry", "migration.sql"),
  "utf8",
);
const SCHEMA = fs.readFileSync(path.join(BACKEND_ROOT, "prisma", "schema.prisma"), "utf8");

let generated = null;
function generatedSql() {
  if (generated === null) {
    generated = execFileSync(
      process.execPath,
      [
        path.join(BACKEND_ROOT, "node_modules", "prisma", "build", "index.js"),
        "migrate",
        "diff",
        "--from-empty",
        "--to-schema-datamodel",
        path.join(BACKEND_ROOT, "prisma", "schema.prisma"),
        "--script",
      ],
      { cwd: BACKEND_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
  }
  return generated;
}

function block(sql, header) {
  const start = sql.indexOf(header);
  if (start === -1) return null;
  const end = sql.indexOf("\n);", start);
  return sql.slice(start, end + 3);
}

/** Collapse whitespace so formatting differences do not read as drift. */
function normalise(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

/* ═══════════════════════════════════════════════════════════════════════════
   The two tables
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the Phase 6 migration", () => {
  test.each([["RejectionAggregate"], ["NearMissSketch"]])(
    "%s matches Prisma's own generated SQL for the model",
    (table) => {
      const header = `CREATE TABLE "${table}" (`;
      const fromMigration = block(MIGRATION, header);
      const fromPrisma = block(generatedSql(), header);

      expect(fromMigration).not.toBeNull();
      expect(fromPrisma).not.toBeNull();
      expect(normalise(fromMigration)).toBe(normalise(fromPrisma));
    },
  );

  test("both models exist in the schema", () => {
    expect(SCHEMA).toMatch(/model RejectionAggregate \{/);
    expect(SCHEMA).toMatch(/model NearMissSketch \{/);
  });

  test("is additive only — nothing is dropped, renamed, or re-typed", () => {
    // Rollback safety: the whole migration is reversible by DROP TABLE on the two new
    // tables, with no data loss outside them.
    //
    // Checked against the *statements*, with `--` comments stripped: the migration's
    // header describes that rollback in prose, and a check that read the prose would
    // fail on the file explaining why it is safe.
    const statements = MIGRATION.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

    expect(statements).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(statements).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(statements).not.toMatch(/\bALTER\s+COLUMN\b/i);
    expect(statements).not.toMatch(/\bRENAME\b/i);
    // The only ALTERs are the CHECK constraints on the tables this migration creates.
    const alters = statements.match(/ALTER TABLE "(\w+)"/g) || [];
    for (const alter of alters) {
      expect(["RejectionAggregate", "NearMissSketch"]).toContain(alter.match(/"(\w+)"/)[1]);
    }
  });

  test("the unique keys are what make an at-least-once flush idempotent", () => {
    // Upsert-and-add against a non-unique key would silently inflate exactly the SLI
    // these tables exist to make trustworthy.
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX "RejectionAggregate_shardId_zoneId_missionClass_legPurpose_p_key"/,
    );
    expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX "NearMissSketch_shardId_predicateId_marginUnit_bucketStart_key"/);
  });

  test("the aggregation key carries every dimension §7.7 names, plus the F34 tier", () => {
    const unique = MIGRATION.match(/CREATE UNIQUE INDEX "RejectionAggregate_[^"]+" ON "RejectionAggregate"\(([^)]+)\)/);
    expect(unique).not.toBeNull();
    for (const column of ["zoneId", "missionClass", "legPurpose", "predicateId", "tier"]) {
      expect(unique[1]).toContain(`"${column}"`);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The hand-written CHECK constraints
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the schema backstops", () => {
  test("Prisma generates none of them — they are hand-written, not echoes", () => {
    expect(generatedSql()).not.toMatch(/RejectionAggregate_predicateId_is_registered/);
    expect(generatedSql()).not.toMatch(/NearMissSketch_marginUnit_is_enumerated/);
  });

  test("a predicate id is constrained to the 38 the register publishes", () => {
    expect(MIGRATION).toMatch(/RejectionAggregate_predicateId_is_registered/);
    expect(MIGRATION).toMatch(/NearMissSketch_predicateId_is_registered/);

    // The pattern in the migration must admit exactly F1…F38 and nothing else. Checked
    // against the register rather than against a transcription of it.
    const pattern = MIGRATION.match(/CHECK \("predicateId" ~ '(\^[^']+\$)'\)/);
    expect(pattern).not.toBeNull();
    const regex = new RegExp(pattern[1]);

    for (const entry of register.PREDICATES) expect(regex.test(entry.id)).toBe(true);
    for (const rejected of ["F0", "F39", "F100", "G1", "f7", "F", ""]) expect(regex.test(rejected)).toBe(false);
  });

  test("a margin unit is constrained to the enumerated set the engine publishes", () => {
    const constraint = MIGRATION.match(/CHECK \("marginUnit" IN \(([^)]+)\)\)/);
    expect(constraint).not.toBeNull();

    const allowed = constraint[1].split(",").map((value) => value.trim().replace(/'/g, ""));
    // Exactly `threeValued.MARGIN_UNIT` — a sketch written under an unrecognised
    // dimension would produce a quantile with no interpretation (§7.7).
    expect(allowed.sort()).toEqual(Object.values(MARGIN_UNIT).sort());
  });

  test("bucket windows are constrained to be non-empty and ordered", () => {
    expect(MIGRATION).toMatch(/RejectionAggregate_bucket_window_is_ordered/);
    expect(MIGRATION).toMatch(/NearMissSketch_bucket_window_is_ordered/);
    expect(MIGRATION).toMatch(/CHECK \("bucketEnd" > "bucketStart"\)/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The parameter register
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the Phase 6 configuration updates", () => {
  const REGISTER_DIRECTORY = path.join(BACKEND_ROOT, "src", "engine", "config", "register");

  function allParameters() {
    const parameters = [];
    for (const file of fs.readdirSync(REGISTER_DIRECTORY)) {
      if (!file.endsWith(".json")) continue;
      const parsed = JSON.parse(fs.readFileSync(path.join(REGISTER_DIRECTORY, file), "utf8"));
      parameters.push(...(parsed.parameters || parsed));
    }
    return parameters;
  }

  test("every parameter the plan names for this phase resolves", () => {
    const byName = new Map(allParameters().map((parameter) => [parameter.name, parameter]));
    for (const name of [
      "feasibility.systemic_indeterminacy_threshold",
      "degraded.max_duration",
      "degraded.max_last_known_age",
      "degraded.reserve_factor",
      "degraded.max_mission_scope",
      "cost.uncertainty_penalty",
    ]) {
      expect(byName.has(name)).toBe(true);
    }
  });

  test("every parameter the 38 predicates read is registered", () => {
    // A threshold a predicate reads but the register does not publish is a behavioural
    // constant outside the register in all but name (§22.1 rule 1).
    const registered = new Set(allParameters().map((parameter) => parameter.name));
    const predicatesDirectory = path.join(BACKEND_ROOT, "src", "engine", "feasibility");

    const read = new Set();
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".js")) {
          const source = fs.readFileSync(full, "utf8");
          for (const match of source.matchAll(/read(?:Indexed)?Parameter\(\s*[\w.]+\s*,\s*"([^"]+)"/g)) {
            read.add(match[1]);
          }
        }
      }
    };
    walk(predicatesDirectory);

    const unregistered = [...read].filter((name) => !registered.has(name)).sort();
    expect(unregistered).toEqual([]);
  });

  test("the new Safety-class parameters state an owner and a calibration status", () => {
    const byName = new Map(allParameters().map((parameter) => [parameter.name, parameter]));
    for (const name of ["degraded.reserve_factor", "degraded.max_mission_scope", "health.required_tier", "localisation.min_confidence"]) {
      const parameter = byName.get(name);
      expect(parameter).toBeDefined();
      expect(parameter.owner).toBeTruthy();
      expect(parameter.calibrationStatus).toBeTruthy();
      expect(parameter.section).toBeTruthy();
      // §22.4: an uncalibrated parameter says what it awaits, so it cannot quietly
      // become permanent.
      if (parameter.calibrationStatus !== "DERIVED") expect(parameter.awaits).toBeTruthy();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Tier placement
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§1.8 — tier placement of the Phase 6 surface", () => {
  test("every feasibility module is Tier 0", () => {
    for (const modulePath of [
      "src/engine/feasibility/evaluate.js",
      "src/engine/feasibility/register.js",
      "src/engine/feasibility/threeValued.js",
      "src/engine/feasibility/systemicGuard.js",
      "src/engine/feasibility/cache.js",
      "src/engine/feasibility/volatileSubset.js",
      "src/engine/feasibility/rejectionTelemetry.js",
      "src/engine/feasibility/predicates/f34.js",
    ]) {
      expect(tierOf(modulePath)).toBe(TIER.SAFETY_CORE);
    }
  });

  test("T0-01 and T0-02's named modules now exist", () => {
    // The tier registry named these before the code existed; Phase 6 is where the
    // inventory and the tree converge.
    const named = MECHANISMS.filter((mechanism) => ["T0-01", "T0-02"].includes(mechanism.id)).flatMap(
      (mechanism) => mechanism.modules,
    );
    for (const modulePath of named) {
      const full = path.join(BACKEND_ROOT, modulePath);
      expect(fs.existsSync(full)).toBe(true);
    }
  });

  test("the predicates directory holds exactly the 38 the register names", () => {
    const directory = path.join(BACKEND_ROOT, "src", "engine", "feasibility", "predicates");
    const files = fs.readdirSync(directory).filter((name) => name.endsWith(".js")).sort();
    expect(files).toHaveLength(38);

    const expected = register.PREDICATES.map((entry) => `${entry.module}.js`).sort();
    expect(files).toEqual(expected);
  });
});

"use strict";

/**
 * Engine lane — Phase 12: the migration, module presence, tier placement, the register
 * entries, and the phase boundary.
 *
 * The migration is cross-checked against Prisma's own generated SQL, so the hand-written
 * file and `schema.prisma` cannot silently disagree — the discipline every phase since 2
 * has applied to its own. What Prisma cannot express — the ten hand-written CHECK
 * constraints and the partial unique index — is asserted as written, and its *absence*
 * from the generated output is asserted too, so a reviewer can tell a hand-written
 * addition from an echo.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { tierOf, TIER, MECHANISMS } = require("../../src/engine/guards/tierAssertions");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const MIGRATION_DIR = "20260807090000_degraded_modes_failure_handling_invariants";
const MIGRATION = fs.readFileSync(path.join(BACKEND_ROOT, "prisma", "migrations", MIGRATION_DIR, "migration.sql"), "utf8");
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

const normalise = (text) => text.replace(/\s+/g, " ").trim();

const NEW_TABLES = ["DegradedModeEvent", "InvariantStatus", "ExternalEscalation"];

describe("Phase 12 migration — the three new tables match Prisma's own generated SQL", () => {
  test.each(NEW_TABLES.map((table) => [table]))("%s's CREATE TABLE is byte-identical to the generated one", (table) => {
    const header = `CREATE TABLE "${table}" (`;
    const mine = block(MIGRATION, header);
    const theirs = block(generatedSql(), header);

    expect(mine).not.toBeNull();
    expect(theirs).not.toBeNull();
    expect(normalise(mine)).toBe(normalise(theirs));
  });

  test("every index and the one foreign key are present, matching the generated output", () => {
    const statements = [
      'CREATE INDEX "DegradedModeEvent_shardId_enteredAt_idx" ON "DegradedModeEvent"("shardId", "enteredAt");',
      'CREATE INDEX "DegradedModeEvent_shardId_exitedAt_idx" ON "DegradedModeEvent"("shardId", "exitedAt");',
      'CREATE INDEX "DegradedModeEvent_mode_idx" ON "DegradedModeEvent"("mode");',
      'CREATE INDEX "InvariantStatus_shardId_status_idx" ON "InvariantStatus"("shardId", "status");',
      'CREATE INDEX "InvariantStatus_status_checkedAt_idx" ON "InvariantStatus"("status", "checkedAt");',
      'CREATE INDEX "InvariantStatus_invariantId_checkedAt_idx" ON "InvariantStatus"("invariantId", "checkedAt");',
      'CREATE UNIQUE INDEX "InvariantStatus_invariantId_shardId_subjectId_key" ON "InvariantStatus"("invariantId", "shardId", "subjectId");',
      'CREATE INDEX "ExternalEscalation_legId_occurredAt_idx" ON "ExternalEscalation"("legId", "occurredAt");',
      'CREATE INDEX "ExternalEscalation_step_idx" ON "ExternalEscalation"("step");',
      'CREATE INDEX "ExternalEscalation_clearedAt_idx" ON "ExternalEscalation"("clearedAt");',
      'ALTER TABLE "ExternalEscalation" ADD CONSTRAINT "ExternalEscalation_legId_fkey" FOREIGN KEY ("legId") REFERENCES "Leg"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    ];
    for (const statement of statements) {
      expect({ statement, inMigration: MIGRATION.includes(statement) }).toEqual({ statement, inMigration: true });
      expect({ statement, inGenerated: generatedSql().includes(statement) }).toEqual({ statement, inGenerated: true });
    }
  });

  test("the ten CHECK constraints are hand-written — present here and ABSENT from Prisma's output", () => {
    const checks = [
      "DegradedModeEvent_mode_known",
      "DegradedModeEvent_exit_is_evidenced",
      "InvariantStatus_invariant_known",
      "InvariantStatus_status_known",
      "InvariantStatus_suspension_names_its_mode",
      "InvariantStatus_violation_count_non_negative",
      "InvariantStatus_subject_type_known",
      "ExternalEscalation_step_in_range",
      "ExternalEscalation_step_four_is_human_gated",
      "ExternalEscalation_disposition_known",
    ];
    for (const name of checks) {
      expect({ name, inMigration: MIGRATION.includes(name) }).toEqual({ name, inMigration: true });
      // Prisma cannot express a CHECK. Asserting the absence is what proves these are
      // genuine hand-written additions rather than an echo of the generated file.
      expect({ name, inGenerated: generatedSql().includes(name) }).toEqual({ name, inGenerated: false });
    }
  });

  test("the partial unique index is hand-written too — Prisma cannot express a WHERE clause", () => {
    expect(MIGRATION).toMatch(
      /CREATE UNIQUE INDEX "DegradedModeEvent_one_open_per_shard_mode"\s+ON "DegradedModeEvent"\("shardId", "mode"\) WHERE "exitedAt" IS NULL;/,
    );
    expect(generatedSql()).not.toContain("DegradedModeEvent_one_open_per_shard_mode");
  });

  test("the mode vocabulary is closed at the schema, matching modeRegister.MODE_NAMES", () => {
    const modeRegister = require("../../src/engine/degraded/modeRegister");
    const check = /CHECK \("mode" IN \(([^)]*)\)\)/.exec(MIGRATION)[1];
    const inSql = check.split(",").map((value) => value.trim().replace(/'/g, "")).sort();
    expect(inSql).toEqual([...modeRegister.MODE_NAMES].sort());
  });

  test("the invariant vocabulary is closed at the schema, matching §26.1's twenty-two", () => {
    const modeRegister = require("../../src/engine/degraded/modeRegister");
    const check = /CHECK \("invariantId" IN \(([^)]*)\)\)/.exec(MIGRATION)[1];
    const inSql = check.split(",").map((value) => value.trim().replace(/'/g, "")).sort();
    expect(inSql).toEqual([...modeRegister.INVARIANTS].sort());
  });

  test("the status vocabulary is closed at three, matching invariantChecker.STATUS", () => {
    const invariantChecker = require("../../src/engine/observability/invariantChecker");
    const check = /CHECK \("status" IN \(([^)]*)\)\)/.exec(MIGRATION)[1];
    const inSql = check.split(",").map((value) => value.trim().replace(/'/g, "")).sort();
    expect(inSql).toEqual(Object.values(invariantChecker.STATUS).sort());
  });

  test("the disposition vocabulary is closed at the schema, matching externalEscalation.DISPOSITION", () => {
    const externalEscalation = require("../../src/engine/failure/externalEscalation");
    const check = /CHECK \("disposition" IN \(([^)]*)\)\)/.exec(MIGRATION)[1];
    const inSql = check.split(",").map((value) => value.trim().replace(/'/g, "")).sort();
    expect(inSql).toEqual(Object.values(externalEscalation.DISPOSITION).sort());
  });

  test("step 4's human gate is enforced at the schema as well as in the code", () => {
    // Three enforcement points, none of which is "the caller remembers": the absence of a
    // code path in `openChain`, the refusal in `confirmEmergencyServices`, and this.
    expect(MIGRATION).toMatch(/CHECK \("step" <> 4 OR "operatorId" IS NOT NULL\)/);
  });

  test("a suspension cannot be stored without the mode that authorised it, in both directions", () => {
    expect(MIGRATION).toMatch(/"status" <> 'SUSPENDED' OR "authorisingMode" IS NOT NULL/);
    expect(MIGRATION).toMatch(/"status" = 'SUSPENDED' OR "authorisingMode" IS NULL/);
  });

  test("an exit cannot be stored without its evidence", () => {
    expect(MIGRATION).toMatch(/"exitedAt" IS NULL OR \("exitReason" IS NOT NULL AND "exitingComponent" IS NOT NULL\)/);
  });

  test("the migration is additive only — no DROP, no ALTER COLUMN", () => {
    const sqlOnly = MIGRATION.split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(/^\s*DROP\s/im.test(sqlOnly)).toBe(false);
    expect(/ALTER COLUMN/i.test(sqlOnly)).toBe(false);
    for (const statement of sqlOnly.match(/ALTER TABLE[^;]*;/gi) || []) {
      expect({ statement, additive: /ADD (COLUMN|CONSTRAINT)/i.test(statement) }).toEqual({ statement, additive: true });
    }
  });

  test("`Leg` gains a back-relation only, and therefore no column", () => {
    const model = /model Leg \{[\s\S]*?\n\}/.exec(SCHEMA)[0];
    expect(model).toMatch(/externalEscalations ExternalEscalation\[\]/);
    // A back-relation adds no column, so no ALTER TABLE on `Leg` appears anywhere.
    expect(MIGRATION).not.toMatch(/ALTER TABLE "Leg"/);
  });

  test("`suspendedInvariants` is an array, so an empty set is a recorded value", () => {
    const model = /model DegradedModeEvent \{[\s\S]*?\n\}/.exec(SCHEMA)[0];
    expect(model).toMatch(/suspendedInvariants String\[\]/);
    expect(model).toMatch(/degradedInvariants String\[\]/);
    // §18.5 rule 1's three mandatory fields are NOT NULL rather than optional. The `?`
    // is what the assertion is about: a mode entered for no recorded reason cannot be
    // exited on evidence either.
    expect(model).toMatch(/cause\s+String\s*\r?\n/);
    expect(model).toMatch(/enteringComponent String\s*\r?\n/);
    expect(model).not.toMatch(/cause\s+String\?/);
    expect(model).not.toMatch(/enteringComponent String\?/);
  });
});

describe("Phase 12 module tree", () => {
  const ENGINE = path.join(BACKEND_ROOT, "src", "engine");

  const OWNED = {
    degraded: ["modeRegister.js", "transitions.js"],
    failure: ["agentFailures.js", "catalogue.js", "externalEscalation.js", "infraFailures.js"],
    map: ["obstructionClass.js"],
  };

  test.each(Object.entries(OWNED))("%s/ holds exactly the modules the plan names", (directory, files) => {
    expect(fs.readdirSync(path.join(ENGINE, directory)).filter((name) => name.endsWith(".js")).sort()).toEqual([...files].sort());
  });

  test("the checker, its worker, and the two REST files exist", () => {
    for (const file of [
      "src/engine/observability/invariantChecker.js",
      "src/workers/invariant.worker.js",
      "src/controllers/health.controller.js",
      "src/routes/health.routes.js",
    ]) {
      expect({ file, exists: fs.existsSync(path.join(BACKEND_ROOT, file)) }).toEqual({ file, exists: true });
    }
  });

  test("`degraded/`, `failure/`, and `map/` resolve to Tier 0 — the safety core", () => {
    for (const [directory, files] of Object.entries(OWNED)) {
      for (const name of files) {
        expect({ module: `${directory}/${name}`, tier: tierOf(`src/engine/${directory}/${name}`) }).toEqual({
          module: `${directory}/${name}`,
          tier: TIER.SAFETY_CORE,
        });
      }
    }
  });

  test("the checker and its worker resolve to Tier 1 — operational integrity (T1-07)", () => {
    expect(tierOf("src/engine/observability/invariantChecker.js")).toBe(TIER.OPERATIONAL_INTEGRITY);
    expect(tierOf("src/workers/invariant.worker.js")).toBe(TIER.OPERATIONAL_INTEGRITY);
  });

  test("TIERS.md's T0-10, T0-11 and T1-07 rows name the modules this phase actually built", () => {
    // All three rows were declared in Phase 0 against modules that did not exist yet. This
    // is the phase that has to make the declaration true.
    const tiers = fs.readFileSync(path.join(ENGINE, "TIERS.md"), "utf8");
    for (const module of [
      "src/engine/map/obstructionClass.js",
      "src/engine/failure/externalEscalation.js",
      "src/engine/degraded/modeRegister.js",
      "src/engine/failure/catalogue.js",
      "src/engine/observability/invariantChecker.js",
      "src/workers/invariant.worker.js",
    ]) {
      expect({ module, named: tiers.includes(module) }).toEqual({ module, named: true });
      expect({ module, exists: fs.existsSync(path.join(BACKEND_ROOT, module)) }).toEqual({ module, exists: true });
    }
  });

  test("every module the three mechanism rows name now exists", () => {
    for (const id of ["T0-10", "T0-11", "T1-07"]) {
      const mechanism = MECHANISMS.find((row) => row.id === id);
      for (const module of mechanism.modules) {
        expect({ id, module, exists: fs.existsSync(path.join(BACKEND_ROOT, module)) }).toEqual({ id, module, exists: true });
      }
    }
  });

  // Phase 13 has landed: `shard/` now holds Phase 3's leadership record, Phase 10's plan
  // state, and Phase 13's six. The boundary narrows to Phase 14's `security/` and
  // `privacy/` modules, which is the property worth keeping — the same discipline every
  // earlier phase's version of this assertion followed.
  test("shard/ holds exactly what Phases 3, 10 and 13 own", () => {
    const files = fs.readdirSync(path.join(ENGINE, "shard")).filter((name) => name.endsWith(".js")).sort();
    expect(files).toEqual(
      ["crossRegion.js", "election.js", "failover.js", "leadership.js", "membership.js", "planState.js", "shardModel.js", "sizing.js"],
    );
    expect(fs.existsSync(path.join(BACKEND_ROOT, "src", "workers", "shardSupervisor.worker.js"))).toBe(true);
  });

  // Phase 14 has landed: `security/` now holds Phase 4's command signing and Phase 14's
  // four, and `privacy/` holds Phase 14's three. The boundary narrows to `fairness/`,
  // which is §17.4's own phase's — the same discipline every earlier phase's version of
  // this assertion followed.
  test("security/ and privacy/ hold exactly what Phases 4 and 14 own", () => {
    const security = fs.readdirSync(path.join(ENGINE, "security")).filter((name) => name.endsWith(".js")).sort();
    expect(security).toEqual(["attestation.js", "commandSigning.js", "override.js", "sessionBinding.js", "trustBoundaries.js"]);

    const privacy = fs.readdirSync(path.join(ENGINE, "privacy")).filter((name) => name.endsWith(".js")).sort();
    expect(privacy).toEqual(["erasure.js", "identityStore.js", "surrogateKeys.js"]);
  });

  // REMEDIAL PHASE T1-04. This asserted `fairness/` was **empty**, which was the boundary
  // while §17.4's ladder had no owning phase. The remedial phase has run and the three
  // modules `guards/tierAssertions.js` names for T1-04 are on disk, so the boundary moves
  // rather than disappearing: `fairness/` now holds **exactly** those three and nothing
  // else. `dutyCycle.js` (§17.2, T2-10) and `repositioning.js` (§17.3) are Tier 2 and
  // Phase 16's — an assertion that only checked the three were *present* would let either
  // arrive here unnoticed, which is the drift the empty-directory assertion prevented.
  test("fairness/ holds exactly T1-04's three §17.4 modules — no Tier 2 fairness module yet", () => {
    expect(
      fs.readdirSync(path.join(ENGINE, "fairness")).filter((name) => name.endsWith(".js")).sort(),
    ).toEqual(["agentStarvation.js", "ladder.js", "operatorCapacity.js"]);
  });

  // PHASE 15 — "All engine workers move from shadow to production scheduling." The
  // assertion flips: the Invariant Checker is now started by `server.js`, inside the
  // `ENGINE_ENABLED` gate, and `src/workers/registry.js` is where its disposition is
  // declared. `app.js` still starts nothing — the Express app must remain startable in a
  // test or a migration without acquiring a background loop.
  test("the Phase 12 worker is scheduled from server.js and never from app.js", () => {
    const server = fs.readFileSync(path.join(BACKEND_ROOT, "server.js"), "utf8");
    const app = fs.readFileSync(path.join(BACKEND_ROOT, "src", "app.js"), "utf8");
    expect(server.includes("invariant.worker")).toBe(true);
    expect(app.includes("invariant.worker")).toBe(false);

    const registry = require("../../src/workers/registry");
    expect(registry.WORKER_BY_ID.invariant.readiness).toBe(registry.READINESS.SCHEDULED);
  });
});

describe("the Phase 12 register entries", () => {
  const service = require("../../src/engine/config/service");
  const { entries } = service.loadRegister();
  const snapshot = service.defaultSnapshot();

  test("every parameter §18 and §26 read is registered and resolves", () => {
    const named = [
      // Already registered by Phase 1 from Appendix A; asserted here because Phase 12 is
      // the first phase to actually read them.
      "degraded.max_duration",
      "degraded.max_last_known_age",
      "degraded.max_mission_scope",
      "degraded.reserve_factor",
      "agent.autonomous_continuation_limit",
      "connectivity.max_deadzone_extension",
      "supervise.max_timer_lag",
      "route.degraded_max_radius",
      "route.degraded_reserve_factor",
      "ops.stranded_safe_response_target",
      "ops.stranded_restrictive_response_target",
      "ops.stranded_obstructing_response_target",
      // Added by this phase.
      "map.obstruction_class_max_age",
      "failure.poison_quarantine_threshold",
      "ops.external_escalation_contacts",
      "ops.escalation_contact_review_period",
      "ops.emergency_services_hazard_threshold",
      "invariant.check_interval",
      "invariant.monotonicity_window",
    ];
    for (const name of named) {
      expect({ name, registered: entries.has(name) }).toEqual({ name, registered: true });
    }
  });

  test("the two contact-set parameters are `required` and seeded null, not fabricated", () => {
    // A fabricated contact is worse than a recorded absence: the chain would report success
    // into a number nobody answers.
    for (const name of ["ops.external_escalation_contacts", "ops.emergency_services_hazard_threshold"]) {
      const entry = entries.get(name);
      expect({ name, required: entry.required, default: entry.default }).toEqual({ name, required: true, default: null });
      expect(snapshot.resolve(name)).toBeNull();
    }
  });

  test("the map staleness budget is Safety-class, because it decides whether the §18.6 chain opens", () => {
    expect(entries.get("map.obstruction_class_max_age").changeClass).toBe("SAFETY");
  });

  test("no register entry was redefined", () => {
    expect(service.loadRegister({ reload: true }).duplicates).toEqual([]);
  });
});

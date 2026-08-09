"use strict";

/**
 * Engine lane — Phase 9: the migration, module presence, and tier placement.
 *
 * The migration is cross-checked against Prisma's own generated SQL, so the
 * hand-written file and `schema.prisma` cannot silently disagree — the same
 * discipline Phases 2, 4, 5, 6, 7, and 8 applied to theirs. What Prisma cannot
 * express — the two hand-written CHECK constraints — is asserted as written, and
 * its *absence* from the generated output is asserted too, so a reviewer can tell
 * a hand-written addition from an echo.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { tierOf, TIER } = require("../../src/engine/guards/tierAssertions");
const { DECISION_PATH_SCOPE } = require("../../src/engine/guards/tenets");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const MIGRATION = fs.readFileSync(
  path.join(
    BACKEND_ROOT,
    "prisma",
    "migrations",
    "20260805100000_candidate_generation_and_availability_index",
    "migration.sql",
  ),
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
   The migration
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the Phase 9 migration", () => {
  test("AgentCellPosition matches Prisma's own generated SQL for the model", () => {
    const header = `CREATE TABLE "AgentCellPosition" (`;
    const fromMigration = block(MIGRATION, header);
    const fromPrisma = block(generatedSql(), header);

    expect(fromMigration).not.toBeNull();
    expect(fromPrisma).not.toBeNull();
    expect(normalise(fromMigration)).toBe(normalise(fromPrisma));
  });

  test("the model exists in schema.prisma with the Agent back-relation", () => {
    expect(SCHEMA).toMatch(/model AgentCellPosition \{/);
    expect(SCHEMA).toMatch(/cellPosition\s+AgentCellPosition\?/);
  });

  test("the four indexes and the foreign key are present, matching Prisma's own generated SQL", () => {
    for (const line of [
      'CREATE UNIQUE INDEX "AgentCellPosition_agentId_key" ON "AgentCellPosition"("agentId");',
      'CREATE INDEX "AgentCellPosition_shardId_fineCellId_availabilityClass_idx" ON "AgentCellPosition"("shardId", "fineCellId", "availabilityClass");',
      'CREATE INDEX "AgentCellPosition_shardId_coarseCellId_availabilityClass_idx" ON "AgentCellPosition"("shardId", "coarseCellId", "availabilityClass");',
      'CREATE INDEX "AgentCellPosition_availabilityClass_idx" ON "AgentCellPosition"("availabilityClass");',
      'ALTER TABLE "AgentCellPosition" ADD CONSTRAINT "AgentCellPosition_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    ]) {
      expect(MIGRATION).toContain(line);
      expect(generatedSql()).toContain(line);
    }
  });

  test("the two hand-written CHECK constraints exist and are genuinely hand-written (absent from Prisma's output)", () => {
    const checks = [
      'CHECK ("availabilityClass" IN (\'IDLE_READY\', \'QUEUE_CAPACITY_AVAILABLE\', \'CHARGING_INTERRUPTIBLE\', \'FINISHING_SOON\'));',
      'CHECK ("lat" >= -90 AND "lat" <= 90 AND "lon" >= -180 AND "lon" <= 180);',
    ];
    for (const check of checks) {
      expect(MIGRATION).toContain(check);
      expect(generatedSql()).not.toContain(check);
    }
  });

  test("additive only — no DROP, no ALTER COLUMN on an existing table", () => {
    expect(MIGRATION).not.toMatch(/DROP TABLE/i);
    expect(MIGRATION).not.toMatch(/DROP COLUMN/i);
    expect(MIGRATION).not.toMatch(/ALTER COLUMN/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Module presence
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Phase 9's own modules are all present", () => {
  test.each([
    "src/engine/candidates/availabilityIndex.js",
    "src/engine/candidates/expansion.js",
    "src/engine/candidates/lowerBound.js",
    "src/engine/candidates/omega.js",
    "src/engine/candidates/ordering.js",
    "src/engine/candidates/clusterShare.js",
    "src/engine/candidates/admissibilityGate.js",
    "src/workers/indexMaintainer.worker.js",
  ])("%s exists", (modulePath) => {
    expect(fs.existsSync(path.join(BACKEND_ROOT, modulePath))).toBe(true);
  });

  test("the H3 wrapper (B5) landed inside Phase 2's spatial/cells.js, not a parallel module", () => {
    const cellsSource = fs.readFileSync(path.join(BACKEND_ROOT, "src", "engine", "spatial", "cells.js"), "utf8");
    for (const exportName of ["cellForPoint", "coarseParentOf", "fineChildrenOf", "diskAround", "ringAt", "greatCircleMetres"]) {
      expect(cellsSource).toMatch(new RegExp(exportName));
    }
  });

  test("h3-js is a declared dependency (B5)", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, "package.json"), "utf8"));
    expect(packageJson.dependencies["h3-js"]).toBeTruthy();
  });

  test("the diagnostics endpoint and worker are wired", () => {
    const routes = fs.readFileSync(path.join(BACKEND_ROOT, "src", "routes", "diagnostics.routes.js"), "utf8");
    expect(routes).toMatch(/\/candidates\/:legId/);
    const controller = fs.readFileSync(
      path.join(BACKEND_ROOT, "src", "controllers", "diagnostics.controller.js"),
      "utf8",
    );
    expect(controller).toMatch(/getLegCandidates/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Tier placement
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§1.8 — tier placement of the Phase 9 surface", () => {
  test("every candidates/ module is Tier 1 by the engine-wide default (§1.8 names no candidate-generation mechanism as Tier 0 or Tier 2)", () => {
    for (const modulePath of [
      "src/engine/candidates/availabilityIndex.js",
      "src/engine/candidates/expansion.js",
      "src/engine/candidates/lowerBound.js",
      "src/engine/candidates/omega.js",
      "src/engine/candidates/ordering.js",
      "src/engine/candidates/clusterShare.js",
      "src/engine/candidates/admissibilityGate.js",
    ]) {
      expect(tierOf(modulePath)).toBe(TIER.OPERATIONAL_INTEGRITY);
    }
  });

  test("candidates/ was already in the T6 decision-path scope ahead of Phase 9 (Phase 0's own anticipation)", () => {
    expect(DECISION_PATH_SCOPE).toContain("src/engine/candidates/");
  });

  test("no candidates/ module imports a Tier 2 module (§1.8 rule 2) — specifically, omega.js never imports pricing/", () => {
    const omegaSource = fs.readFileSync(
      path.join(BACKEND_ROOT, "src", "engine", "candidates", "omega.js"),
      "utf8",
    );
    expect(omegaSource).not.toMatch(/require\(["'].*pricing/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Build gates
   ═══════════════════════════════════════════════════════════════════════════ */

describe("build gates pass over the Phase 9 surface", () => {
  test("tenets: T1 (n/a — candidates/ is not in COST_EVALUATION_SCOPE) and T6 (no wall-clock read) both clean", () => {
    // eslint-disable-next-line global-require
    const tenets = require("../../src/engine/guards/tenets");
    const result = tenets.checkTenets({ root: BACKEND_ROOT, include: ["src"] });
    const candidatesViolations = result.violations.filter((violation) => violation.file.startsWith("src/engine/candidates/"));
    expect(candidatesViolations).toEqual([]);
  });

  test("parameter register gate: every numeric literal in candidates/ is annotated or structurally exempt", () => {
    // eslint-disable-next-line global-require
    const { checkParameterRegister } = require("../../tools/gates/checkParameterRegister");
    const result = checkParameterRegister({ root: BACKEND_ROOT });
    const candidatesViolations = (result.violations || []).filter((violation) =>
      (violation.file || "").startsWith("src/engine/candidates/"),
    );
    expect(candidatesViolations).toEqual([]);
  });

  test("tier-dependency gate: no forbidden edge originates in candidates/", () => {
    // eslint-disable-next-line global-require
    const { checkTierDependencies } = require("../../tools/gates/checkTierDependencies");
    const result = checkTierDependencies({ root: BACKEND_ROOT });
    const candidatesViolations = (result.violations || []).filter((violation) =>
      (violation.from || "").startsWith("src/engine/candidates/"),
    );
    expect(candidatesViolations).toEqual([]);
  });
});

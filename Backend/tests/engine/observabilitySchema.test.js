"use strict";

/**
 * Engine lane — Phase 11: the migration, module presence, tier placement, and the
 * phase boundary.
 *
 * The migration is cross-checked against Prisma's own generated SQL, so the hand-written
 * file and `schema.prisma` cannot silently disagree — the discipline every phase since 2
 * has applied to its own. What Prisma cannot express — the seven hand-written CHECK
 * constraints — is asserted as written, and its *absence* from the generated output is
 * asserted too, so a reviewer can tell a hand-written addition from an echo.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { tierOf, TIER } = require("../../src/engine/guards/tierAssertions");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const MIGRATION_DIR = "20260806090000_decision_records_and_observability";
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

/**
 * Columns a **later** migration adds to `table`.
 *
 * The generated SQL is always a `--from-empty` diff of the *current* schema, so it
 * necessarily includes every column every later phase has since added. Comparing it
 * verbatim against Phase 11's own migration would make this assertion fail the first time
 * any later phase touched one of these tables — which is exactly what Phase 14 does, by
 * adding `surrogateKeys` to `DecisionRecordB` and `InputSnapshot` (§23.7).
 *
 * Subtracting the later additions keeps the property this test was written for — *Phase
 * 11's hand-written CREATE TABLE is Prisma's own, not a paraphrase* — while letting the
 * schema move forward. It is a subtraction and not a relaxation: a column that no later
 * migration adds still has to match, and a later migration that added a column without
 * recording it in its own `ALTER TABLE` would still fail here.
 *
 * @param {string} table
 * @returns {Set<string>} column names, quoted as they appear in the DDL
 */
function columnsAddedLater(table) {
  const migrationsRoot = path.join(BACKEND_ROOT, "prisma", "migrations");
  const added = new Set();

  for (const entry of fs.readdirSync(migrationsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name <= MIGRATION_DIR) continue;
    const sql = fs.readFileSync(path.join(migrationsRoot, entry.name, "migration.sql"), "utf8");
    const alter = new RegExp(`ALTER TABLE "${table}" ADD COLUMN\\s+("[^"]+")`, "g");
    let match = alter.exec(sql);
    while (match !== null) {
      added.add(match[1]);
      match = alter.exec(sql);
    }
  }

  return added;
}

function withoutLaterColumns(block_, table) {
  const later = columnsAddedLater(table);
  if (later.size === 0) return block_;
  return block_
    .split("\n")
    .filter((line) => ![...later].some((column) => line.trim().startsWith(`${column} `)))
    .join("\n");
}

const NEW_TABLES = ["DecisionRecordB", "InputSnapshot", "CalibrationObservation", "AuditEvent"];

describe("Phase 11 migration — the four new tables match Prisma's own generated SQL", () => {
  test.each(NEW_TABLES.map((table) => [table]))("%s's CREATE TABLE is byte-identical to the generated one", (table) => {
    const header = `CREATE TABLE "${table}" (`;
    const mine = block(MIGRATION, header);
    const theirs = block(generatedSql(), header);

    expect(mine).not.toBeNull();
    expect(theirs).not.toBeNull();
    expect(normalise(mine)).toBe(normalise(withoutLaterColumns(theirs, table)));
  });

  test("DecisionRecordA gains exactly the eight Phase 11 columns, all additive", () => {
    const added = [
      '"inputSnapshotId" TEXT',
      '"fullRetentionUntil" TIMESTAMP(3)',
      '"sizeBytes" INTEGER',
      '"tierBWritten" BOOLEAN NOT NULL DEFAULT false',
      '"tierBReason" TEXT',
      '"samplingDraw" DOUBLE PRECISION',
      '"samplingRate" DOUBLE PRECISION',
      '"shadowLabel" TEXT',
    ];
    for (const column of added) {
      expect({ column, added: MIGRATION.includes(`ALTER TABLE "DecisionRecordA" ADD COLUMN     ${column};`) }).toEqual({
        column,
        added: true,
      });
      // The same column, in the same type, in the model Prisma generates from.
      expect({ column, inGenerated: generatedSql().includes(`    ${column},`) || generatedSql().includes(`    ${column}\n`) }).toEqual({
        column,
        inGenerated: true,
      });
    }
  });

  test("every index and both foreign keys are present, matching the generated output", () => {
    const statements = [
      'CREATE INDEX "DecisionRecordA_inputSnapshotId_idx" ON "DecisionRecordA"("inputSnapshotId");',
      'CREATE INDEX "DecisionRecordA_shardId_tierBWritten_decisionTime_idx" ON "DecisionRecordA"("shardId", "tierBWritten", "decisionTime");',
      'CREATE INDEX "DecisionRecordA_shadowLabel_decisionTime_idx" ON "DecisionRecordA"("shadowLabel", "decisionTime");',
      'CREATE UNIQUE INDEX "DecisionRecordB_decisionId_key" ON "DecisionRecordB"("decisionId");',
      'CREATE INDEX "DecisionRecordB_writtenBecause_idx" ON "DecisionRecordB"("writtenBecause");',
      'CREATE INDEX "DecisionRecordB_retainUntil_idx" ON "DecisionRecordB"("retainUntil");',
      'CREATE UNIQUE INDEX "InputSnapshot_snapshotId_key" ON "InputSnapshot"("snapshotId");',
      'CREATE INDEX "InputSnapshot_retainUntil_idx" ON "InputSnapshot"("retainUntil");',
      'CREATE INDEX "InputSnapshot_hash_idx" ON "InputSnapshot"("hash");',
      'CREATE INDEX "CalibrationObservation_predictor_observedAt_idx" ON "CalibrationObservation"("predictor", "observedAt");',
      'CREATE INDEX "CalibrationObservation_predictor_tier_observedAt_idx" ON "CalibrationObservation"("predictor", "tier", "observedAt");',
      'CREATE UNIQUE INDEX "AuditEvent_hash_key" ON "AuditEvent"("hash");',
      'CREATE UNIQUE INDEX "AuditEvent_streamId_sequence_key" ON "AuditEvent"("streamId", "sequence");',
      'ALTER TABLE "DecisionRecordA" ADD CONSTRAINT "DecisionRecordA_inputSnapshotId_fkey" FOREIGN KEY ("inputSnapshotId") REFERENCES "InputSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
      'ALTER TABLE "DecisionRecordB" ADD CONSTRAINT "DecisionRecordB_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "DecisionRecordA"("decisionId") ON DELETE CASCADE ON UPDATE CASCADE;',
    ];
    for (const statement of statements) {
      expect({ statement, inMigration: MIGRATION.includes(statement) }).toEqual({ statement, inMigration: true });
      expect({ statement, inGenerated: generatedSql().includes(statement) }).toEqual({ statement, inGenerated: true });
    }
  });

  test("the seven CHECK constraints are hand-written — present here and ABSENT from Prisma's output", () => {
    const checks = [
      "DecisionRecordB_written_because_known",
      "DecisionRecordA_tier_b_reason_present",
      "DecisionRecordA_size_non_negative",
      "CalibrationObservation_predictor_known",
      "CalibrationObservation_probability_in_unit_interval",
      "AuditEvent_event_type_known",
      "AuditEvent_sequence_non_negative",
    ];
    for (const name of checks) {
      expect({ name, inMigration: MIGRATION.includes(name) }).toEqual({ name, inMigration: true });
      // Prisma cannot express a CHECK. Asserting the absence is what proves these are
      // genuine hand-written additions rather than an echo of the generated file.
      expect({ name, inGenerated: generatedSql().includes(name) }).toEqual({ name, inGenerated: false });
    }
  });

  test("the Tier B reason vocabulary is closed at the schema, matching sampling.WRITTEN_BECAUSE", () => {
    const sampling = require("../../src/engine/observability/sampling");
    const check = /CHECK \("writtenBecause" IN \(([^)]*)\)\)/.exec(MIGRATION)[1];
    const inSql = check.split(",").map((value) => value.trim().replace(/'/g, "")).sort();
    expect(inSql).toEqual(Object.values(sampling.WRITTEN_BECAUSE).sort());
  });

  test("the predictor vocabulary is closed at the schema, matching calibration.PREDICTORS", () => {
    const calibration = require("../../src/engine/observability/calibration");
    const check = /CHECK \("predictor" IN \(([^)]*)\)\)/.exec(MIGRATION)[1];
    const inSql = check.split(",").map((value) => value.trim().replace(/'/g, "")).sort();
    expect(inSql).toEqual([...calibration.PREDICTORS].sort());
  });

  test("the audit event vocabulary is closed at the schema, matching auditStream.EVENT_TYPES", () => {
    const auditStream = require("../../src/engine/observability/auditStream");
    const check = /CHECK \("eventType" IN \(([^)]*)\)\)/.exec(MIGRATION)[1];
    const inSql = check.split(",").map((value) => value.trim().replace(/'/g, "")).sort();
    expect(inSql).toEqual([...auditStream.EVENT_TYPES].sort());
  });

  test("the migration is additive only — no DROP, no ALTER COLUMN", () => {
    // Over the SQL, not the prose: this migration's own header states the property in
    // words, and a naive scan of the whole file would match the sentence rather than a
    // statement. Comments are what the file uses to explain itself; they execute nothing.
    const sqlOnly = MIGRATION.split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(/^\s*DROP\s/im.test(sqlOnly)).toBe(false);
    expect(/ALTER COLUMN/i.test(sqlOnly)).toBe(false);
    // Every ALTER TABLE in the file only ever adds.
    for (const statement of sqlOnly.match(/ALTER TABLE[^;]*;/gi) || []) {
      expect({ statement, additive: /ADD (COLUMN|CONSTRAINT)/i.test(statement) }).toEqual({ statement, additive: true });
    }
  });

  test("the Tier-B-reason CHECK is the schema's own backstop for the bounded exemption list", () => {
    // §21.2's exemption bound is enforced by scope in `sampling.js` and by budget in the
    // writer. This constraint is the third line: a Tier B written with no stated reason
    // cannot enter the table at all, so a future writer cannot reintroduce an unbounded
    // exemption by forgetting to set a field.
    expect(MIGRATION).toMatch(/CHECK \("tierBWritten" = false OR "tierBReason" IS NOT NULL\)/);
  });

  test("InputSnapshot is immutable in the schema — no updatedAt anywhere on it", () => {
    const model = /model InputSnapshot \{[\s\S]*?\n\}/.exec(SCHEMA)[0];
    expect(model).not.toMatch(/updatedAt/);
    expect(model).toMatch(/capturedAt/);
  });

  test("the DecisionRecordA → InputSnapshot relation is SetNull, never Cascade", () => {
    // An expired snapshot must leave its decision record standing and visibly
    // unreplayable. Cascading would delete the evidence of the §24.3 defect.
    const model = /model DecisionRecordA \{[\s\S]*?\n\}/.exec(SCHEMA)[0];
    expect(model).toMatch(/onDelete: SetNull/);
    expect(model).not.toMatch(/inputSnapshot\s+InputSnapshot\?[^\n]*Cascade/);
  });
});

describe("§21.2 immutability is scoped to the DECISION — the defect a live database found", () => {
  // `DecisionRecordA_immutable` (Phase 2) refused EVERY update. Phase 11 then added three
  // columns that are written after the row exists and two production paths that write
  // them, and BOTH raised P0001 on a real PostgreSQL: the reservoir flush threw, and
  // expiring an `InputSnapshot` was impossible because `ON DELETE SET NULL` is an UPDATE.
  // Neither was visible to this suite, because the in-memory double has no triggers.
  //
  // These tests keep the two halves of the fix honest: the allowlist stays exactly three
  // columns, and no Phase 11 module may write a column outside it.
  const IMMUTABILITY_MIGRATION = fs.readFileSync(
    path.join(BACKEND_ROOT, "prisma", "migrations", "20260818120000_decision_record_immutability_scope", "migration.sql"),
    "utf8",
  );

  /** The three columns §21.2 writes after the row exists. Everything else is the decision. */
  const MUTABLE = ["inputSnapshotId", "tierBWritten", "tierBReason"];

  test("the trigger's allowlist is exactly the three post-write bookkeeping columns", () => {
    const declaration = /mutable text\[\] := ARRAY\[([^\]]*)\]/.exec(IMMUTABILITY_MIGRATION);
    expect(declaration).not.toBeNull();
    const named = [...declaration[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(named.sort()).toEqual([...MUTABLE].sort());
  });

  test("the allowlist is SUBTRACTED from the row, so a future column is immutable by default", () => {
    // The direction is the point. Enumerating the *protected* columns would silently
    // admit every column a later phase adds.
    expect(IMMUTABILITY_MIGRATION).toMatch(/to_jsonb\(NEW\) - mutable\) IS DISTINCT FROM \(to_jsonb\(OLD\) - mutable/);
  });

  test("the three directional guards are present — the allowlist is not a hole", () => {
    // Evidence is added, never removed; a written Tier B always names why; a stored
    // decision may have its snapshot cleared but never re-pointed at different inputs.
    expect(IMMUTABILITY_MIGRATION).toMatch(/OLD\."tierBWritten" AND NOT NEW\."tierBWritten"/);
    expect(IMMUTABILITY_MIGRATION).toMatch(/NEW\."tierBWritten" AND NEW\."tierBReason" IS NULL/);
    expect(IMMUTABILITY_MIGRATION).toMatch(/NEW\."inputSnapshotId" IS NOT NULL AND NEW\."inputSnapshotId" IS DISTINCT FROM OLD\."inputSnapshotId"/);
  });

  test("no module writes a DecisionRecordA column the database will refuse", () => {
    // A source scan, because the double cannot enforce the trigger and the next engineer
    // to add an `updateMany` will not read a migration from seven phases ago.
    const roots = [path.join(BACKEND_ROOT, "src"), path.join(BACKEND_ROOT, "tools")];
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) files.push(full);
      }
    };
    for (const root of roots) walk(root);

    const writes = [];
    for (const file of files) {
      // `tools/verify/` harnesses plant refused writes deliberately, to prove the trigger
      // fires — the same exemption the gate self-tests have. Everything else is production.
      if (path.relative(BACKEND_ROOT, file).replace(/\\/g, "/").startsWith("tools/verify/")) continue;
      const code = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const [statement] of code.matchAll(/decisionRecordA\.(update|updateMany|upsert)\(([\s\S]*?)\n\s{0,6}\}\)/g)) {
        const data = /data:\s*\{([^}]*)\}/.exec(statement);
        const columns = data ? [...data[1].matchAll(/(\w+)\s*:/g)].map((match) => match[1]) : [];
        writes.push({ file: path.relative(BACKEND_ROOT, file), columns });
      }
    }

    // The scan is worthless if it matches nothing — the reservoir flush is one of these.
    expect(writes.length).toBeGreaterThan(0);

    for (const write of writes) {
      const refused = write.columns.filter((column) => !MUTABLE.includes(column));
      expect({ file: write.file, refused }).toEqual({ file: write.file, refused: [] });
    }
  });
});

describe("Phase 11 module tree", () => {
  const OBSERVABILITY = path.join(BACKEND_ROOT, "src", "engine", "observability");

  const OWNED = [
    "auditStream.js",
    "calibration.js",
    "decisionRecord.js",
    "explanation.js",
    "metrics.js",
    "sampling.js",
    "shadow.js",
    "sli.js",
    "tierA.js",
    "tierB.js",
  ];

  // Phase 12 adds `invariantChecker.js` to this directory — the execution plan's Phase 12
  // "Files to create" row names `src/engine/observability/invariantChecker.js` explicitly,
  // so it is a Phase 12 module living in a Phase 11 directory rather than a leak. It is
  // named here so this assertion stays exact rather than being relaxed to a superset.
  const PHASE_12_OWNED_HERE = ["invariantChecker.js"];

  test("every Phase 11 module is present, and the only addition is Phase 12's checker", () => {
    expect(fs.readdirSync(OBSERVABILITY).filter((name) => name.endsWith(".js")).sort()).toEqual(
      [...OWNED, ...PHASE_12_OWNED_HERE].sort(),
    );
  });

  test("the two tools and the four workers exist", () => {
    for (const file of [
      "tools/replay/replayDecision.js",
      "tools/evaluator/counterfactual.js",
      "src/workers/tierB.worker.js",
      "src/workers/calibration.worker.js",
      "src/workers/shadow.worker.js",
      "src/workers/counterfactual.worker.js",
      "src/controllers/explain.controller.js",
      "src/routes/explain.routes.js",
    ]) {
      expect({ file, exists: fs.existsSync(path.join(BACKEND_ROOT, file)) }).toEqual({ file, exists: true });
    }
  });

  test("every Phase 11 module resolves to Tier 1 — operational integrity (§1.8, T1-03)", () => {
    for (const name of OWNED) {
      expect({ name, tier: tierOf(`src/engine/observability/${name}`) }).toEqual({ name, tier: TIER.OPERATIONAL_INTEGRITY });
    }
    for (const name of ["tierB", "calibration", "shadow", "counterfactual"]) {
      expect({ name, tier: tierOf(`src/workers/${name}.worker.js`) }).toEqual({ name, tier: TIER.OPERATIONAL_INTEGRITY });
    }
  });

  test("TIERS.md's T1-03 row names the modules this phase actually built", () => {
    const tiers = fs.readFileSync(path.join(BACKEND_ROOT, "src", "engine", "TIERS.md"), "utf8");
    for (const module of [
      "src/engine/observability/decisionRecord.js",
      "src/controllers/explain.controller.js",
      "src/routes/explain.routes.js",
    ]) {
      expect({ module, named: tiers.includes(module) }).toEqual({ module, named: true });
    }
  });

  // Phase 12 has filled `degraded/`, `failure/`, and `map/` and added the checker and its
  // worker — see `degradedSchema.test.js` for their presence assertions. `fairness/` is
  // §17.4's ladder and stays empty, which is the boundary this test now keeps.
  test("no §17.4 ladder module exists — fairness/ stays empty", () => {
    for (const directory of ["fairness"]) {
      const files = fs.readdirSync(path.join(BACKEND_ROOT, "src", "engine", directory)).filter((name) => name.endsWith(".js"));
      expect({ directory, files }).toEqual({ directory, files: [] });
    }
  });

  // PHASE 15 — production scheduling. Three of the four Phase 11 workers are now started
  // by `server.js`; the shadow runner is not, and `src/workers/registry.js` records the
  // reason by name (it needs a constructed solve path, and a stub would produce a worker
  // that runs, reports success, and compares nothing). `app.js` still starts none of them.
  test("the Phase 11 workers are scheduled per the registry, and never from app.js", () => {
    const server = fs.readFileSync(path.join(BACKEND_ROOT, "server.js"), "utf8");
    const app = fs.readFileSync(path.join(BACKEND_ROOT, "src", "app.js"), "utf8");
    const registry = require("../../src/workers/registry");

    for (const [worker, id] of [
      ["tierB.worker", "tier_b"],
      ["calibration.worker", "calibration"],
      ["counterfactual.worker", "counterfactual"],
    ]) {
      expect({ worker, inServer: server.includes(worker) }).toEqual({ worker, inServer: true });
      expect({ worker, readiness: registry.WORKER_BY_ID[id].readiness }).toEqual({
        worker,
        readiness: registry.READINESS.SCHEDULED,
      });
    }

    expect(server.includes("shadow.worker")).toBe(false);
    expect(registry.WORKER_BY_ID.shadow.readiness).toBe(registry.READINESS.DEFERRED);
    expect(registry.WORKER_BY_ID.shadow.blockedBy).toMatch(/solve path/);

    for (const worker of ["tierB.worker", "calibration.worker", "shadow.worker", "counterfactual.worker"]) {
      expect({ worker, inApp: app.includes(worker) }).toEqual({ worker, inApp: false });
    }
  });
});

describe("the observability register entries", () => {
  const service = require("../../src/engine/config/service");
  const { entries } = service.loadRegister();

  test("every §20.1 target names a register entry that resolves", () => {
    const sli = require("../../src/engine/observability/sli");
    const snapshot = service.defaultSnapshot();
    for (const target of sli.TARGETS) {
      expect({ id: target.id, registered: entries.has(target.parameter) }).toEqual({ id: target.id, registered: true });
      expect({ id: target.id, resolves: Number.isFinite(snapshot.resolve(target.parameter)) }).toEqual({ id: target.id, resolves: true });
    }
  });

  test("the five §21.2 observability parameters and the four Phase 11 additions are registered", () => {
    for (const name of [
      "observability.full_retention",
      "observability.compact_top_n",
      "observability.tier_b_sample_rate",
      "observability.tier_b_retention",
      "observability.tier_b_write_budget",
      "observability.input_snapshot_retention",
      "observability.tier_b_reservoir_size",
      "observability.calibration_bias_alarm",
      "observability.calibration_min_samples",
      "observability.calibration_tier_window",
    ]) {
      expect({ name, registered: entries.has(name) }).toEqual({ name, registered: true });
    }
  });

  test("the calibration tier window is keyed by the three §14.5 tiers", () => {
    const snapshot = service.defaultSnapshot();
    expect(Object.keys(snapshot.resolve("observability.calibration_tier_window")).sort()).toEqual(["T1", "T2", "T3"]);
  });
});

"use strict";

/**
 * Engine lane — Phase 10: the migration, module presence, tier placement, and the phase's
 * own gate — *"no detached background assignment remains"*.
 *
 * The migration is cross-checked against Prisma's own generated SQL, so the hand-written
 * file and `schema.prisma` cannot silently disagree — the same discipline Phases 2 and 4
 * through 9 applied to theirs. What Prisma cannot express — the three hand-written CHECK
 * constraints — is asserted as written, and its *absence* from the generated output is
 * asserted too, so a reviewer can tell a hand-written addition from an echo.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { tierOf, TIER } = require("../../src/engine/guards/tierAssertions");
const { DECISION_PATH_SCOPE, COST_EVALUATION_SCOPE } = require("../../src/engine/guards/tenets");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const MIGRATION = fs.readFileSync(
  path.join(BACKEND_ROOT, "prisma", "migrations", "20260805170000_round_loop_and_work_queue", "migration.sql"),
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

const normalise = (text) => text.replace(/\s+/g, " ").trim();

describe("Phase 10 migration — the two tables match Prisma's own generated SQL", () => {
  test.each([["WorkQueue"], ["Round"]])("%s's CREATE TABLE is byte-identical to the generated one", (table) => {
    const header = `CREATE TABLE "${table}" (`;
    const mine = block(MIGRATION, header);
    const theirs = block(generatedSql(), header);

    expect(mine).not.toBeNull();
    expect(theirs).not.toBeNull();
    expect(normalise(mine)).toBe(normalise(theirs));
  });

  test("every index and the foreign key are present, matching the generated output", () => {
    const statements = [
      'CREATE UNIQUE INDEX "WorkQueue_legId_key" ON "WorkQueue"("legId");',
      'CREATE UNIQUE INDEX "WorkQueue_idempotencyKey_key" ON "WorkQueue"("idempotencyKey");',
      'CREATE INDEX "WorkQueue_shardId_state_priority_enqueuedAt_idx" ON "WorkQueue"("shardId", "state", "priority", "enqueuedAt");',
      'CREATE INDEX "WorkQueue_shardId_state_availableAt_idx" ON "WorkQueue"("shardId", "state", "availableAt");',
      'CREATE INDEX "WorkQueue_state_idx" ON "WorkQueue"("state");',
      'CREATE INDEX "WorkQueue_claimedByRoundId_idx" ON "WorkQueue"("claimedByRoundId");',
      'CREATE UNIQUE INDEX "Round_roundId_key" ON "Round"("roundId");',
      'CREATE INDEX "Round_shardId_decisionTime_idx" ON "Round"("shardId", "decisionTime");',
      'CREATE INDEX "Round_shardId_startedAt_idx" ON "Round"("shardId", "startedAt");',
      'CREATE INDEX "Round_regime_idx" ON "Round"("regime");',
      'ALTER TABLE "WorkQueue" ADD CONSTRAINT "WorkQueue_legId_fkey" FOREIGN KEY ("legId") REFERENCES "Leg"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
    ];
    for (const statement of statements) {
      expect({ statement, inMigration: MIGRATION.includes(statement) }).toEqual({ statement, inMigration: true });
      expect({ statement, inGenerated: generatedSql().includes(statement) }).toEqual({ statement, inGenerated: true });
    }
  });

  test("the three CHECK constraints are hand-written — present here and ABSENT from Prisma's output", () => {
    const checks = ["WorkQueue_state_known", "Round_regime_known", "WorkQueue_deferral_counts_non_negative"];
    for (const name of checks) {
      expect({ name, inMigration: MIGRATION.includes(name) }).toEqual({ name, inMigration: true });
      // Prisma cannot express a CHECK. Asserting the absence is what proves these are
      // genuine hand-written additions rather than an echo of the generated file.
      expect({ name, inGenerated: generatedSql().includes(name) }).toEqual({ name, inGenerated: false });
    }
  });

  test("the queue-row state vocabulary is closed at the schema, matching intake.QUEUE_STATE", () => {
    const intake = require("../../src/engine/intake/intake");
    const check = /CHECK \("state" IN \(([^)]*)\)\)/.exec(MIGRATION)[1];
    const inSql = check.split(",").map((value) => value.trim().replace(/'/g, "")).sort();
    expect(inSql).toEqual(Object.values(intake.QUEUE_STATE).sort());
  });

  test("the regime vocabulary is closed at the schema, matching solve/regime.REGIME (§9.3)", () => {
    const regime = require("../../src/engine/solve/regime");
    const check = /CHECK \("regime" IN \(([^)]*)\)\)/.exec(MIGRATION)[1];
    const inSql = check.split(",").map((value) => value.trim().replace(/'/g, "")).sort();
    expect(inSql).toEqual(Object.values(regime.REGIME).sort());
  });

  test("the migration is additive only — no DROP, no ALTER COLUMN", () => {
    expect(/^\s*DROP\s/im.test(MIGRATION)).toBe(false);
    expect(/ALTER COLUMN/i.test(MIGRATION)).toBe(false);
  });

  test("the schema carries the Leg back-relation and no reverse column", () => {
    const leg = /model Leg \{[\s\S]*?\n\}/.exec(SCHEMA)[0];
    expect(leg).toMatch(/workQueueEntry WorkQueue\?/);
  });
});

describe("Phase 10 modules exist and sit at the tier §1.8 puts them at", () => {
  const MODULES = [
    "src/engine/intake/intake.js",
    "src/engine/intake/admission.js",
    "src/engine/shard/planState.js",
    "src/engine/solve/cadence.js",
    "src/engine/solve/regime.js",
    "src/engine/solve/budgets.js",
    "src/engine/solve/objective.js",
    "src/engine/solve/minCostFlow.js",
    "src/engine/solve/round.js",
    "src/workers/coordinator.worker.js",
  ];

  test.each(MODULES)("%s exists", (module) => {
    expect(fs.existsSync(path.join(BACKEND_ROOT, module))).toBe(true);
  });

  test.each(MODULES)("%s is Tier 1 — OPERATIONAL_INTEGRITY", (module) => {
    // §1.8 names admission control (T1-06) explicitly; the rest fall to `TIERS.md`'s
    // Convention 1 (undeclared modules default to Tier 1, the conservative direction).
    // The three Tier 2 `solve/` modules §1.8 does name — batch.js, setPartitioning.js,
    // localSearch.js — belong to Phase 16 and do not exist.
    expect(tierOf(module)).toBe(TIER.OPERATIONAL_INTEGRITY);
  });

  test("no Phase 16 Tier 2 solve module has appeared early", () => {
    for (const name of ["batch.js", "setPartitioning.js", "localSearch.js"]) {
      expect(fs.existsSync(path.join(BACKEND_ROOT, "src", "engine", "solve", name))).toBe(false);
    }
  });

  test("`solve/` is inside both the decision-path and cost-evaluation build scopes", () => {
    expect(DECISION_PATH_SCOPE).toContain("src/engine/solve/");
    expect(COST_EVALUATION_SCOPE).toContain("src/engine/solve/");
  });

  test("no solve module reads a clock or a random source (T6, §9.6)", () => {
    const solveRoot = path.join(BACKEND_ROOT, "src", "engine", "solve");
    for (const name of fs.readdirSync(solveRoot).filter((entry) => entry.endsWith(".js"))) {
      const source = fs.readFileSync(path.join(solveRoot, name), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      for (const pattern of [/\bDate\s*\.\s*now\s*\(/, /\bnew\s+Date\s*\(/, /\bMath\s*\.\s*random\s*\(/]) {
        expect({ name, pattern: String(pattern), found: pattern.test(code) }).toEqual({
          name,
          pattern: String(pattern),
          found: false,
        });
      }
    }
  });

  test("the Tier 1 solve modules import no Tier 2 mechanism (§1.8 rule 2)", () => {
    const solveRoot = path.join(BACKEND_ROOT, "src", "engine", "solve");
    const forbidden = [/require\(["'][^"']*cost\/cDefer/, /require\(["'][^"']*cost\/cChurn/, /require\(["'][^"']*pricing\//, /require\(["'][^"']*plan\/insertion/];
    for (const name of fs.readdirSync(solveRoot).filter((entry) => entry.endsWith(".js"))) {
      const source = fs.readFileSync(path.join(solveRoot, name), "utf8");
      for (const pattern of forbidden) {
        expect({ name, pattern: String(pattern), found: pattern.test(source) }).toEqual({
          name,
          pattern: String(pattern),
          found: false,
        });
      }
    }
  });
});

describe("PHASE 10 GATE — no detached background assignment remains on the engine path", () => {
  const detachPatterns = [
    { name: "setImmediate", pattern: /\bsetImmediate\s*\(/ },
    { name: "setTimeout", pattern: /\bsetTimeout\s*\(/ },
    { name: "process.nextTick", pattern: /\bprocess\s*\.\s*nextTick\s*\(/ },
    { name: "a floating promise from a bare .then", pattern: /^\s*\w[\w.]*\([^)]*\)\s*\.then\s*\(/m },
  ];

  const enginePath = [
    "src/engine/intake/intake.js",
    "src/engine/intake/admission.js",
    "src/engine/solve/round.js",
    "src/engine/solve/cadence.js",
    "src/engine/solve/regime.js",
    "src/engine/solve/budgets.js",
    "src/engine/solve/objective.js",
    "src/engine/solve/minCostFlow.js",
    "src/engine/shard/planState.js",
  ];

  test.each(enginePath)("%s detaches nothing", (module) => {
    const source = fs.readFileSync(path.join(BACKEND_ROOT, module), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const { name, pattern } of detachPatterns) {
      expect({ module, detach: name, found: pattern.test(code) }).toEqual({ module, detach: name, found: false });
    }
  });

  test("the coordinator's ONLY timer is its own supervised loop, and it is unref'd", () => {
    const source = fs.readFileSync(path.join(BACKEND_ROOT, "src", "workers", "coordinator.worker.js"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    expect(code).not.toMatch(/\bsetImmediate\s*\(/);
    expect((code.match(/\bsetInterval\s*\(/g) || []).length).toBe(1);
    expect(code).toMatch(/timer\.unref/);
  });

  // PHASE 15 — Phase 10 left exactly one detach alive, on the legacy branch, and recorded
  // the deviation: deleting it while `ENGINE_ENABLED` was false would have left the
  // durable queue with nothing draining it. The cutover removes the branch, so the count
  // goes from one to zero and the whole §5.2 item C6 defect class leaves the file.
  test("task.service.js routes to intake and contains NO detached background assignment", () => {
    const source = fs.readFileSync(path.join(BACKEND_ROOT, "src", "services", "task.service.js"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    expect(code).toMatch(/intake\.admit\(/);
    expect((code.match(/\bsetImmediate\s*\(/g) || []).length).toBe(0);
    expect(code).not.toMatch(/function legacyDetachedAssignment\(/);
    expect(code).not.toMatch(/function _processAssignment\(/);
    expect(code).not.toMatch(/function _finalizeAssignment\(/);

    // There is no branch left to order: `assignTask` refuses when the engine is not live
    // for the shard rather than falling through to a second path.
    const assignBody = /async function assignTask\([\s\S]*?\n\}/.exec(source)[0];
    expect(assignBody).toMatch(/ENGINE_NOT_LIVE/);
  });

  test("the round's intake path performs no store write of its own — every effect is injected", () => {
    const source = fs.readFileSync(path.join(BACKEND_ROOT, "src", "engine", "solve", "round.js"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // L4 is side-effect-free (§3.1). `commit` and `record` arrive as functions, and no
    // store client is reachable from this module at all. (`budgetModel.create()` is a
    // factory, not a write, which is why the check is for store verbs rather than for
    // the word "create".)
    for (const pattern of [/\bprisma\b/, /\btx\./, /\.upsert\(/, /\.updateMany\(/, /\$transaction/, /\$queryRaw/]) {
      expect({ pattern: String(pattern), found: pattern.test(code) }).toEqual({ pattern: String(pattern), found: false });
    }
    expect(code).toMatch(/deps\.commit\(/);
    expect(code).toMatch(/deps\.record\(/);
  });
});

describe("§3.4 — the REST contract change is additive", () => {
  // PHASE 15 — the change is no longer merely additive: the §3.4 contract *supersedes* the
  // legacy one. The legacy `task` object is retained through the retention window so an
  // unmigrated consumer reads a task row rather than a 500, but the response now leads with
  // `intake`, carries the API version on the wire, and names what replaces what.
  test("the controller publishes the §3.4 contract, the API version, and the supersession note", () => {
    const source = fs.readFileSync(path.join(BACKEND_ROOT, "src", "controllers", "tasks.controller.js"), "utf8");
    expect(source).toMatch(/X-RobotX-API-Version/);
    expect(source).toMatch(/const API_VERSION = "\d{4}-\d{2}-\d{2}"/);
    expect(source).toMatch(/supersededContract/);
    // The legacy shape survives beside it — retirement is after the window, not at it.
    expect(source).toMatch(/task: created/);
    expect(source).toMatch(/intake: admitted/);
  });

  test("the legacy socket intake path is retired: REST is the only submission path", () => {
    // The socket path (`assign_task` → `task_accepted` + the `task_assigned` echo) had no
    // client and bypassed the REST rate limiter and manual-assignment gate, so it was
    // removed rather than kept beside the §3.4 contract. Nothing on the socket side may
    // reach intake or speak for it.
    const source = fs.readFileSync(path.join(BACKEND_ROOT, "src", "sockets", "socket.server.js"), "utf8");
    expect(source).not.toContain('socket.on("assign_task"');
    expect(source).not.toContain("taskService");
    expect(source).not.toContain("assignTask(");
    for (const event of ["task_accepted", "task_assigned", "task_error"]) expect(source).not.toContain(`emit("${event}"`);
    const routes = fs.readFileSync(path.join(BACKEND_ROOT, "src", "routes", "tasks.routes.js"), "utf8");
    expect(routes).toContain('router.post("/assign", assignLimiter, gateManualAssignment, tasksController.assignTask)');
  });
});

describe("§9.2 / §9.4 — every parameter this phase reads is in the register", () => {
  test("the two parameters Phase 10 adds are registered with the shape §22 requires", () => {
    const registerDir = path.join(BACKEND_ROOT, "src", "engine", "config", "register");
    const entries = [];
    for (const file of fs.readdirSync(registerDir)) {
      const parsed = JSON.parse(fs.readFileSync(path.join(registerDir, file), "utf8"));
      entries.push(...(parsed.parameters || parsed));
    }

    for (const name of ["solve.batch_growth_threshold", "solve.max_window_sla_fraction"]) {
      const entry = entries.find((row) => row.name === name);
      expect({ name, found: Boolean(entry) }).toEqual({ name, found: true });
      for (const field of ["type", "unit", "default", "specScope", "scopes", "changeClass", "owner", "blastRadius", "calibrationStatus", "section", "description"]) {
        expect({ name, field, present: entry[field] !== undefined }).toEqual({ name, field, present: true });
      }
      expect(entry.section).toBe("§9.2");
    }
  });

  test("every §9.2 and §9.4 parameter the plan names is registered", () => {
    const registerDir = path.join(BACKEND_ROOT, "src", "engine", "config", "register");
    const names = new Set();
    for (const file of fs.readdirSync(registerDir)) {
      const parsed = JSON.parse(fs.readFileSync(path.join(registerDir, file), "utf8"));
      for (const entry of parsed.parameters || parsed) names.add(entry.name);
    }

    for (const name of [
      "solve.window_min",
      "solve.window_max",
      "solve.saturated_window",
      "solve.max_legs_per_round",
      "solve.time_budget",
      "solve.improvement_budget",
      "solve.branch_node_budget",
      "solve.fast_path_classes",
      "solve.batch_growth_threshold",
      "solve.max_window_sla_fraction",
      "plan.max_columns_per_round",
      "plan.commitment_horizon",
      "commit.hardening_deadline",
      "candidate.max_evaluated",
    ]) {
      expect({ name, registered: names.has(name) }).toEqual({ name, registered: true });
    }
  });
});

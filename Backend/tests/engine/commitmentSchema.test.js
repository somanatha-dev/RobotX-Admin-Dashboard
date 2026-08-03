"use strict";

/**
 * Phase 3 — the schema backstops (§10.3.2) as written, not as described.
 *
 * > **Database-enforced invariants:** two schema constraints MUST exist as
 * > backstops, so that **even a defective code path cannot violate them silently**:
 * >
 * >   - A partial unique index (or equivalent) enforcing at most
 * >     `capacity[agent_class]` active commitments per agent.
 * >   - A constraint admitting only HARD commitments into the table, so that a SOFT
 * >     reservation cannot be persisted by any code path (invariant I18).
 * >
 * > Application logic and schema constraints are independent lines of defence, and
 * > the schema one is the one that cannot be bypassed by a new call site.
 *
 * The behaviour of those constraints is exercised in `commitmentTransaction.test.js`
 * against the store model. This suite checks the DDL itself: that the statements are
 * present, that the migration is additive, and that it agrees with `schema.prisma`
 * statement-for-statement against Prisma's own generated SQL — the same discipline
 * Phase 2 established, so a migration cannot drift from the models without a red test.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(BACKEND_ROOT, "..");
const SCHEMA_PATH = path.join(BACKEND_ROOT, "prisma", "schema.prisma");
const MIGRATION_PATH = path.join(
  BACKEND_ROOT,
  "prisma",
  "migrations",
  "20260729120000_commitment_core",
  "migration.sql",
);
const PHASE_2_MIGRATION_PATH = path.join(
  BACKEND_ROOT,
  "prisma",
  "migrations",
  "20260728140000_domain_model_and_spatial_hierarchy",
  "migration.sql",
);

const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
const migration = fs.readFileSync(MIGRATION_PATH, "utf8");
const phase2Migration = fs.readFileSync(PHASE_2_MIGRATION_PATH, "utf8");

function sqlOnly(source) {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

const migrationSql = sqlOnly(migration);

function statements(source) {
  const out = [];
  let current = "";
  let inDollarQuote = false;
  for (const line of source.split("\n")) {
    if (line.includes("$$")) inDollarQuote = !inDollarQuote;
    current += `${line}\n`;
    if (!inDollarQuote && line.trimEnd().endsWith(";")) {
      const trimmed = current.trim();
      if (trimmed) out.push(trimmed.replace(/\s+/g, " "));
      current = "";
    }
  }
  return out;
}

/** The tables Phase 3 creates. */
const PHASE_3_TABLES = Object.freeze(["ShardLeadership", "AgentFenceAudit"]);

/* ═══════════════════════════════════════════════════════════════════════════
   Additivity
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the Phase 3 migration is additive", () => {
  test("it drops nothing", () => {
    expect(migrationSql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TYPE)\b/i);
  });

  test("it renames nothing and re-types nothing", () => {
    expect(migrationSql).not.toMatch(/\bRENAME\b/i);
    expect(migrationSql).not.toMatch(/\bALTER\s+COLUMN\b/i);
  });

  test("the only pre-existing table it alters is Commitment", () => {
    const altered = new Set(
      [...migrationSql.matchAll(/ALTER TABLE "([A-Za-z_]+)"/g)].map((match) => match[1]),
    );
    expect([...altered].sort()).toEqual(["Commitment"]);
  });

  test("the column it adds to Commitment is NOT NULL with a default, so no backfill is required", () => {
    const addColumn = /ALTER TABLE "Commitment" ADD COLUMN "capacitySlot" INTEGER NOT NULL DEFAULT 0;/;
    expect(migrationSql).toMatch(addColumn);
  });

  test("it does not restate Phase 2's HARD-only CHECK — that constraint already exists", () => {
    expect(phase2Migration).toMatch(/ADD CONSTRAINT "Commitment_kind_hard_only" CHECK \("kind" = 'HARD'\)/);
    expect(migrationSql).not.toMatch(/Commitment_kind_hard_only/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Agreement with schema.prisma
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the migration agrees with schema.prisma", () => {
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

  const relevant = (list, table) =>
    list.filter(
      (statement) =>
        statement.startsWith(`CREATE TABLE "${table}"`) ||
        statement.includes(`ON "${table}"(`) ||
        statement.startsWith(`ALTER TABLE "${table}" ADD CONSTRAINT "${table}_`),
    );

  test.each(PHASE_3_TABLES)("%s: every generated statement appears verbatim in the migration", (table) => {
    const expected = relevant(generatedStatements, table);
    expect(expected.length).toBeGreaterThan(0);
    for (const statement of expected) {
      expect(migrationStatements).toContain(statement);
    }
  });

  test("the migration creates exactly the two tables the plan names", () => {
    const created = [...migrationSql.matchAll(/CREATE TABLE "([A-Za-z_]+)"/g)].map((match) => match[1]);
    expect(created.sort()).toEqual([...PHASE_3_TABLES].sort());
  });

  test("Prisma's generated SQL carries the capacitySlot column, so schema and migration agree on it", () => {
    expect(generated).toMatch(/"capacitySlot" INTEGER NOT NULL DEFAULT 0/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The capacity backstop (I1)
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the capacity backstop (§10.3.2, invariant I1)", () => {
  test("is a PARTIAL UNIQUE index, predicated on the commitment still being active", () => {
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX "Commitment_agent_capacity_slot_active_key"\s+ON "Commitment"\("agentId", "capacitySlot"\)\s+WHERE "releasedAt" IS NULL;/,
    );
  });

  test("the index is keyed on (agent, slot), which is what generalises it beyond capacity 1", () => {
    const index = /CREATE UNIQUE INDEX "Commitment_agent_capacity_slot_active_key"[\s\S]*?;/.exec(migrationSql)[0];
    expect(index).toContain('"agentId", "capacitySlot"');
  });

  test("the slot's lower bound is a CHECK constraint, not application logic", () => {
    expect(migrationSql).toMatch(
      /ADD CONSTRAINT "Commitment_capacity_slot_non_negative" CHECK \("capacitySlot" >= 0\)/,
    );
  });

  test("the slot's upper bound is a trigger against the agent's durable capacity", () => {
    expect(migrationSql).toMatch(/CREATE OR REPLACE FUNCTION "commitment_capacity_slot_in_bounds"\(\) RETURNS trigger/);
    expect(migrationSql).toMatch(
      /CREATE TRIGGER "Commitment_capacity_slot_in_bounds"\s+BEFORE INSERT OR UPDATE ON "Commitment"/,
    );
  });

  test("the trigger reads COALESCE(capacityOverride, 1) — the durable record and the register default", () => {
    expect(migrationSql).toMatch(/SELECT COALESCE\("capacityOverride", 1\) INTO "effective_capacity"/);
  });

  test("the trigger does not COUNT — counting would reopen the interleaving the index closes", () => {
    const body = /CREATE OR REPLACE FUNCTION "commitment_capacity_slot_in_bounds"[\s\S]*?\$\$ LANGUAGE plpgsql;/.exec(
      migrationSql,
    )[0];
    expect(body).not.toMatch(/\bCOUNT\s*\(/i);
  });

  test("the trigger exempts released commitments, matching the index's predicate", () => {
    const body = /CREATE OR REPLACE FUNCTION "commitment_capacity_slot_in_bounds"[\s\S]*?\$\$ LANGUAGE plpgsql;/.exec(
      migrationSql,
    )[0];
    expect(body).toMatch(/IF NEW\."releasedAt" IS NOT NULL THEN\s+RETURN NEW;/);
  });

  test("every RAISE EXCEPTION format string matches its argument count", () => {
    const raises = [...migrationSql.matchAll(/RAISE EXCEPTION\s+'((?:[^']|'')*)'([^;]*);/g)];
    expect(raises.length).toBeGreaterThan(0);
    for (const [, format, args] of raises) {
      const placeholders = (format.match(/%/g) || []).length;
      const supplied = args.trim() === "" ? 0 : args.split(",").filter((part) => part.trim() !== "").length;
      expect({ format: format.slice(0, 40), placeholders, supplied }).toEqual({
        format: format.slice(0, 40),
        placeholders,
        supplied,
      });
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   ShardLeadership and AgentFenceAudit
   ═══════════════════════════════════════════════════════════════════════════ */

describe("ShardLeadership (§19.5) — guard G1's subject", () => {
  test.each([
    ["shardId", /"shardId" TEXT NOT NULL/],
    ["leadershipFence", /"leadershipFence" BIGINT NOT NULL DEFAULT 0/],
    ["holder", /"holder" TEXT/],
    ["leaseExpiry", /"leaseExpiry" TIMESTAMP\(3\)/],
  ])("carries %s", (_name, pattern) => {
    const table = /CREATE TABLE "ShardLeadership"[\s\S]*?\);/.exec(migrationSql)[0];
    expect(table).toMatch(pattern);
  });

  test("the leadership fence is a BIGINT, not an INTEGER", () => {
    const table = /CREATE TABLE "ShardLeadership"[\s\S]*?\);/.exec(migrationSql)[0];
    expect(table).toMatch(/"leadershipFence" BIGINT/);
    expect(table).not.toMatch(/"leadershipFence" INTEGER/);
  });

  test("one row per shard is enforced by a unique index", () => {
    expect(migrationSql).toMatch(/CREATE UNIQUE INDEX "ShardLeadership_shardId_key" ON "ShardLeadership"\("shardId"\)/);
  });

  test("the migration seeds the single static row the plan's cycle-C1 resolution requires", () => {
    expect(migrationSql).toMatch(/INSERT INTO "ShardLeadership"[\s\S]*?ON CONFLICT \("shardId"\) DO NOTHING;/);
  });

  test("the seeded fence starts above zero, so 'no leadership' is distinguishable from 'unmoved'", () => {
    const insert = /INSERT INTO "ShardLeadership"[\s\S]*?ON CONFLICT/.exec(migrationSql)[0];
    expect(insert).toMatch(/'default',\s*\n?\s*1,/);
  });

  test("the insert is idempotent, so a re-applied migration cannot reset a fence", () => {
    expect(migrationSql).toMatch(/ON CONFLICT \("shardId"\) DO NOTHING/);
  });
});

describe("AgentFenceAudit (§26 invariant I6)", () => {
  test.each([
    ["agentId", /"agentId" TEXT NOT NULL/],
    ["fenceHighWater", /"fenceHighWater" BIGINT NOT NULL DEFAULT 0/],
    ["epochHighWater", /"epochHighWater" BIGINT NOT NULL DEFAULT 0/],
  ])("carries %s", (_name, pattern) => {
    const table = /CREATE TABLE "AgentFenceAudit"[\s\S]*?\);/.exec(migrationSql)[0];
    expect(table).toMatch(pattern);
  });

  test("both high-water marks are BIGINT, matching the counters they audit", () => {
    const table = /CREATE TABLE "AgentFenceAudit"[\s\S]*?\);/.exec(migrationSql)[0];
    expect(table).not.toMatch(/HighWater" INTEGER/);
  });

  test("one audit row per agent", () => {
    expect(migrationSql).toMatch(/CREATE UNIQUE INDEX "AgentFenceAudit_agentId_key" ON "AgentFenceAudit"\("agentId"\)/);
  });

  test("it is a second, separately-written record — not a view over Agent", () => {
    // The point of the high-water mark is that it disagrees with `Agent` when a
    // counter has gone backwards. A view could never disagree.
    expect(migrationSql).not.toMatch(/CREATE VIEW/i);
    expect(schema).toMatch(/model AgentFenceAudit \{/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The schema and the specification
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the schema carries what Phase 3 needs and nothing more", () => {
  test("Commitment.capacitySlot is declared in schema.prisma with the same default", () => {
    const commitment = /model Commitment \{[\s\S]*?\n\}/.exec(schema)[0];
    expect(commitment).toMatch(/capacitySlot\s+Int\s+@default\(0\)/);
  });

  test("the partial index is documented in the schema as living in migration SQL", () => {
    const commitment = /model Commitment \{[\s\S]*?\n\}/.exec(schema)[0];
    expect(commitment).toMatch(/Prisma cannot\s*\/\/\/ express a partial index/);
  });

  // Phase 4 landed `Outbox` and `AgentDedupState`; Phase 5 lands `Timer`,
  // `ReconcilerRepair`, and `VerificationEvidence`. The assertion narrows by exactly what
  // each landed phase owns rather than being deleted — the same discipline the
  // engine-tree ownership assertion follows. A Phase 6+ table appearing early still
  // fails, which is the property worth keeping.
  test("no Phase 6+ table appears — no RejectionAggregate, no NearMissSketch, no EnergyModelParams", () => {
    for (const table of ["RejectionAggregate", "NearMissSketch", "EnergyModelParams", "BatteryState", "Charger"]) {
      expect({ table, present: new RegExp(`model ${table} \\{`).test(schema) }).toEqual({ table, present: false });
    }
  });

  test("Phase 4's two tables are the only ones it added", () => {
    for (const table of ["Outbox", "AgentDedupState"]) {
      expect({ table, present: new RegExp(`model ${table} \\{`).test(schema) }).toEqual({ table, present: true });
    }
  });

  test("Phase 5's three tables are present", () => {
    for (const table of ["Timer", "ReconcilerRepair", "VerificationEvidence"]) {
      expect({ table, present: new RegExp(`model ${table} \\{`).test(schema) }).toEqual({ table, present: true });
    }
  });

  test("the formal model the plan names exists and states its own capacity configurations", () => {
    const tla = fs.readFileSync(path.join(REPO_ROOT, "formal", "commitment.tla"), "utf8");
    expect(tla).toMatch(/MODULE commitment/);
    expect(tla).toMatch(/Capacity <- 1/);
    expect(tla).toMatch(/Capacity <- 2/);
    expect(tla).toMatch(/Capacity <- 3/);
    expect(tla).toMatch(/AtMostCapacity/);
    expect(tla).toMatch(/AllActiveCommandable/);
  });
});

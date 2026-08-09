"use strict";

/**
 * Engine lane — Phase 13: the migration, module presence, tier placement, the register
 * entries, and the phase boundary.
 *
 * The migration is cross-checked against Prisma's own generated SQL, so the hand-written
 * file and `schema.prisma` cannot silently disagree — the discipline every phase since 2
 * has applied to its own. What Prisma cannot express — the fifteen hand-written CHECK
 * constraints and the partial unique index — is asserted as written, and its *absence*
 * from the generated output is asserted too, so a reviewer can tell a hand-written
 * addition from an echo.
 *
 * One assertion here is worth more than the rest: **`ShardLeadership` is unchanged.**
 * Phase 3's whole resolution of the near-circular dependency was that Phase 13 would
 * replace the static row with real election and "G1's code does not change". That claim is
 * about the database as much as about the source, so this file asserts that the migration
 * contains no `ALTER TABLE "ShardLeadership"` at all.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { tierOf, TIER, MECHANISMS, MODULE_TIERS } = require("../../src/engine/guards/tierAssertions");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const ENGINE = path.join(BACKEND_ROOT, "src", "engine");
const MIGRATION_DIR = "20260808090000_sharding_leadership_single_writer";
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

const NEW_TABLES = ["Shard", "ShardMembership", "CrossRegionSaga", "TransferPoint"];

describe("Phase 13 migration — the four new tables match Prisma's own generated SQL", () => {
  test.each(NEW_TABLES.map((table) => [table]))("%s's CREATE TABLE is byte-identical to the generated one", (table) => {
    const header = `CREATE TABLE "${table}" (`;
    const mine = block(MIGRATION, header);
    const theirs = block(generatedSql(), header);

    expect(mine).not.toBeNull();
    expect(theirs).not.toBeNull();
    expect(normalise(mine)).toBe(normalise(theirs));
  });

  test("every index and every foreign key is present, matching the generated output", () => {
    const statements = [
      'CREATE UNIQUE INDEX "Shard_shardId_key" ON "Shard"("shardId");',
      'CREATE UNIQUE INDEX "Shard_regionId_key" ON "Shard"("regionId");',
      'CREATE INDEX "Shard_state_idx" ON "Shard"("state");',
      'CREATE INDEX "Shard_bindingBound_idx" ON "Shard"("bindingBound");',
      'CREATE INDEX "ShardMembership_shardId_movedAt_idx" ON "ShardMembership"("shardId", "movedAt");',
      'CREATE INDEX "ShardMembership_agentId_movedAt_idx" ON "ShardMembership"("agentId", "movedAt");',
      'CREATE INDEX "ShardMembership_supersededAt_idx" ON "ShardMembership"("supersededAt");',
      'CREATE UNIQUE INDEX "CrossRegionSaga_sagaId_key" ON "CrossRegionSaga"("sagaId");',
      'CREATE UNIQUE INDEX "CrossRegionSaga_missionId_key" ON "CrossRegionSaga"("missionId");',
      'CREATE INDEX "CrossRegionSaga_state_idx" ON "CrossRegionSaga"("state");',
      'CREATE INDEX "CrossRegionSaga_heldAtTransferPointId_idx" ON "CrossRegionSaga"("heldAtTransferPointId");',
      'CREATE INDEX "CrossRegionSaga_openedAt_idx" ON "CrossRegionSaga"("openedAt");',
      'CREATE UNIQUE INDEX "TransferPoint_transferPointId_key" ON "TransferPoint"("transferPointId");',
      'CREATE INDEX "TransferPoint_upstreamRegionId_downstreamRegionId_idx" ON "TransferPoint"("upstreamRegionId", "downstreamRegionId");',
      'CREATE INDEX "TransferPoint_custodianType_idx" ON "TransferPoint"("custodianType");',
      'CREATE INDEX "TransferPoint_siteId_idx" ON "TransferPoint"("siteId");',
      'ALTER TABLE "Shard" ADD CONSTRAINT "Shard_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;',
      'ALTER TABLE "Shard" ADD CONSTRAINT "Shard_shardId_fkey" FOREIGN KEY ("shardId") REFERENCES "ShardLeadership"("shardId") ON DELETE RESTRICT ON UPDATE CASCADE;',
      'ALTER TABLE "ShardMembership" ADD CONSTRAINT "ShardMembership_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
      'ALTER TABLE "ShardMembership" ADD CONSTRAINT "ShardMembership_shardId_fkey" FOREIGN KEY ("shardId") REFERENCES "Shard"("shardId") ON DELETE RESTRICT ON UPDATE CASCADE;',
      'ALTER TABLE "CrossRegionSaga" ADD CONSTRAINT "CrossRegionSaga_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
      'ALTER TABLE "CrossRegionSaga" ADD CONSTRAINT "CrossRegionSaga_heldAtTransferPointId_fkey" FOREIGN KEY ("heldAtTransferPointId") REFERENCES "TransferPoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;',
      'ALTER TABLE "TransferPoint" ADD CONSTRAINT "TransferPoint_upstreamRegionId_fkey" FOREIGN KEY ("upstreamRegionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;',
      'ALTER TABLE "TransferPoint" ADD CONSTRAINT "TransferPoint_downstreamRegionId_fkey" FOREIGN KEY ("downstreamRegionId") REFERENCES "Region"("id") ON DELETE RESTRICT ON UPDATE CASCADE;',
      'ALTER TABLE "TransferPoint" ADD CONSTRAINT "TransferPoint_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;',
    ];
    for (const statement of statements) {
      expect({ statement, inMigration: MIGRATION.includes(statement) }).toEqual({ statement, inMigration: true });
      expect({ statement, inGenerated: generatedSql().includes(statement) }).toEqual({ statement, inGenerated: true });
    }
  });

  // The load-bearing assertion of this file. Phase 3 resolved the near-circular
  // dependency on the promise that "G1's code does not change", and that promise is about
  // the table as much as about the function.
  test("no existing table is altered — `ShardLeadership` above all", () => {
    expect(MIGRATION).not.toMatch(/ALTER TABLE "ShardLeadership"/);
    const alters = [...MIGRATION.matchAll(/ALTER TABLE "(\w+)"/g)].map((match) => match[1]);
    expect([...new Set(alters)].sort()).toEqual(NEW_TABLES.slice().sort());
    expect(MIGRATION).not.toMatch(/\bDROP\b/);
    expect(MIGRATION).not.toMatch(/ALTER COLUMN/);
  });

  test("guard G1's read is unchanged — `readLeadership`'s SQL is the statement Phase 3 shipped", () => {
    const source = fs.readFileSync(path.join(ENGINE, "shard", "leadership.js"), "utf8");
    expect(source).toContain(
      'SELECT "shardId", "leadershipFence", "holder", "leaseExpiry" FROM "ShardLeadership" WHERE "shardId" = $1 FOR SHARE',
    );
    // And `commit.js` — the module that calls it — was not touched by this phase.
    const commitSource = fs.readFileSync(path.join(ENGINE, "commitment", "commit.js"), "utf8");
    expect(commitSource).toContain("await leadership.readLeadership(tx, request.shardId)");
    expect(commitSource).not.toMatch(/PHASE 13|shardModel|election|failover/);
  });
});

describe("the hand-written constraints Prisma cannot express", () => {
  const CHECKS = [
    "Shard_state_known",
    "Shard_binding_bound_known",
    "Shard_agent_count_non_negative",
    "Shard_draining_is_timed",
    "ShardMembership_migration_advances_epoch",
    "ShardMembership_epochs_non_negative",
    "ShardMembership_move_changes_shard",
    "ShardMembership_reason_known",
    "CrossRegionSaga_state_known",
    "CrossRegionSaga_compensation_is_explicit",
    "CrossRegionSaga_hold_is_timed",
    "TransferPoint_custodian_type_known",
    "TransferPoint_unattended_is_modelled",
    "TransferPoint_capacity_positive",
    "TransferPoint_joins_two_regions",
  ];

  test.each(CHECKS.map((name) => [name]))("%s is written by hand and is absent from Prisma's output", (name) => {
    expect({ name, inMigration: MIGRATION.includes(name) }).toEqual({ name, inMigration: true });
    // The half that proves it is a genuine addition rather than an echo of the generated
    // file. A CHECK that appeared in both would be one Prisma already wrote.
    expect({ name, inGenerated: generatedSql().includes(name) }).toEqual({ name, inGenerated: false });
  });

  test("the partial unique index is written by hand and is absent from Prisma's output", () => {
    expect(MIGRATION).toContain('CREATE UNIQUE INDEX "ShardMembership_one_current_per_agent"');
    expect(MIGRATION).toContain('ON "ShardMembership"("agentId") WHERE "supersededAt" IS NULL');
    expect(generatedSql()).not.toContain("ShardMembership_one_current_per_agent");
  });

  test("§19.6's custodian requirement is at the schema, not only in code", () => {
    // `custodianType`, `custodianId` and `capacity` are NOT NULL in the generated table,
    // which is what makes "a defined custodian" a property of the row rather than of
    // every writer's diligence.
    const table = block(generatedSql(), 'CREATE TABLE "TransferPoint" (');
    expect(table).toMatch(/"custodianType" TEXT NOT NULL/);
    expect(table).toMatch(/"custodianId" TEXT NOT NULL/);
    expect(table).toMatch(/"capacity" INTEGER NOT NULL/);
    // And the conditional half §19.6 states for an unattended location.
    expect(MIGRATION).toMatch(
      /TransferPoint_unattended_is_modelled[\s\S]*?"custodianType" <> 'MODELLED_UNATTENDED' OR \("securityProperties" IS NOT NULL AND "capacity" > 0\)/,
    );
  });

  test("§19.2's epoch advance is at the schema, with the placement exemption stated", () => {
    expect(MIGRATION).toMatch(
      /ShardMembership_migration_advances_epoch[\s\S]*?"fromShardId" IS NULL OR "authorityEpochAfter" > "authorityEpochBefore"/,
    );
  });
});

describe("Phase 13's schema shape", () => {
  test("Shard.regionId is unique — region → shard is a function (§3.5)", () => {
    const model = /model Shard \{[\s\S]*?\n\}/.exec(SCHEMA)[0];
    expect(model).toMatch(/regionId String @unique/);
  });

  test("Shard's leadership record is a foreign key, so a shard with no fence cannot exist", () => {
    expect(MIGRATION).toContain(
      'ALTER TABLE "Shard" ADD CONSTRAINT "Shard_shardId_fkey" FOREIGN KEY ("shardId") REFERENCES "ShardLeadership"("shardId")',
    );
  });

  test("Agent gains no `currentShardId` column — membership is a transactional record, not a pointer", () => {
    const model = /model Agent \{[\s\S]*?\n\}/.exec(SCHEMA)[0];
    // Comments stripped: this asserts a property of the *columns*, and the doc comment
    // above the back-relation names the column it deliberately did not add.
    const columns = model
      .split("\n")
      .filter((line) => !line.trim().startsWith("///") && !line.trim().startsWith("//"))
      .join("\n");
    expect(columns).not.toMatch(/currentShardId/);
    expect(columns).not.toMatch(/shardId\s+String/);
    // A back-relation only, which adds no column.
    expect(columns).toMatch(/shardMemberships ShardMembership\[\]/);
  });

  test("ShardMembership records both epochs, so G3's fencing has something to be checked against", () => {
    const model = /model ShardMembership \{[\s\S]*?\n\}/.exec(SCHEMA)[0];
    expect(model).toMatch(/authorityEpochBefore BigInt/);
    expect(model).toMatch(/authorityEpochAfter\s+BigInt/);
  });
});

describe("Phase 13 module tree and tier placement", () => {
  const MODULES = [
    "src/engine/shard/shardModel.js",
    "src/engine/shard/election.js",
    "src/engine/shard/failover.js",
    "src/engine/shard/sizing.js",
    "src/engine/shard/membership.js",
    "src/engine/shard/crossRegion.js",
    "src/workers/shardSupervisor.worker.js",
  ];

  test.each(MODULES.map((module) => [module]))("%s exists", (module) => {
    expect(fs.existsSync(path.join(BACKEND_ROOT, module))).toBe(true);
  });

  test("crossRegion.js is Tier 2 and everything else Phase 13 adds is Tier 1", () => {
    expect(tierOf("src/engine/shard/crossRegion.js")).toBe(TIER.ALLOCATION_QUALITY);
    for (const module of MODULES.filter((name) => !name.endsWith("crossRegion.js"))) {
      expect({ module, tier: tierOf(module) }).toEqual({ module, tier: TIER.OPERATIONAL_INTEGRITY });
    }
  });

  test("T2-13's module row is satisfied by this phase, and no MODULE_TIERS row was added", () => {
    const mechanism = MECHANISMS.find((row) => row.id === "T2-13");
    expect(mechanism.modules).toEqual(["src/engine/shard/crossRegion.js"]);
    expect(mechanism.killSwitch).toBe("cross_region_candidacy");
    expect(mechanism.degradesTo).toBe("Region-local only");
    expect(fs.existsSync(path.join(BACKEND_ROOT, mechanism.modules[0]))).toBe(true);
    // Phase 0 declared the path prefix table; Phase 13 adds no row to it.
    const shardRows = MODULE_TIERS.filter(([prefix]) => prefix.startsWith("src/engine/shard/"));
    expect(shardRows.map(([prefix]) => prefix)).toEqual(["src/engine/shard/crossRegion.js"]);
  });

  // §1.8 rule 2, enforced for this phase's own most tempting violation. `crossRegion.js`
  // is the Tier 2 mechanism, and the natural place to call it from is intake — which is
  // Tier 1 and must run with the file deleted.
  test("nothing imports crossRegion.js — the dependency is inverted (§1.8 rule 2, §22.5 rule 1)", () => {
    const importers = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) {
          const source = fs.readFileSync(full, "utf8");
          if (/require\((["'])[^"']*crossRegion\1\)/.test(source)) importers.push(path.relative(BACKEND_ROOT, full));
        }
      }
    };
    walk(path.join(BACKEND_ROOT, "src"));
    expect(importers).toEqual([]);
  });

  test("crossRegion.js imports intake, and intake does not import it", () => {
    const cross = fs.readFileSync(path.join(ENGINE, "shard", "crossRegion.js"), "utf8");
    const intake = fs.readFileSync(path.join(ENGINE, "intake", "intake.js"), "utf8");
    expect(cross).toMatch(/require\("\.\.\/intake\/intake"\)/);
    expect(intake).not.toMatch(/crossRegion/);
  });

  test("the Phase 13 worker is started from server.js only under ENGINE_ENABLED", () => {
    const server = fs.readFileSync(path.join(BACKEND_ROOT, "server.js"), "utf8");
    const app = fs.readFileSync(path.join(BACKEND_ROOT, "src", "app.js"), "utf8");
    expect(server).toContain("shardSupervisor");
    expect(app).not.toContain("shardSupervisor");
    // The gate, asserted as a gate rather than assumed: the `start()` call is inside the
    // `engineEnabled` branch, and there is exactly one such call.
    const gateIndex = server.indexOf("if (engineEnabled) {");
    const startIndex = server.indexOf("shardSupervisor.start(");
    expect(gateIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeGreaterThan(gateIndex);
    expect(server.split("shardSupervisor.start(").length - 1).toBe(1);
  });

  // Phase 14 has landed. What this file keeps asserting is the property it was written
  // for: Phase 13's `commit.js` promise. Phase 14 touches neither `commit.js` nor
  // `ShardLeadership`, and a security phase reaching into the commit path would be
  // exactly the kind of drift these boundary assertions exist to catch.
  test("Phase 14 did not touch the commit path — commit.js names no §23 identifier", () => {
    const commit = fs.readFileSync(path.join(ENGINE, "commitment", "commit.js"), "utf8");
    for (const identifier of ["sessionBinding", "attestation", "trustBoundaries", "override", "surrogateKeys", "identityStore", "erasure"]) {
      expect({ identifier, present: commit.includes(identifier) }).toEqual({ identifier, present: false });
    }
  });

  test("no §17.4 ladder module exists — fairness/ stays empty", () => {
    expect(fs.readdirSync(path.join(ENGINE, "fairness")).filter((name) => name.endsWith(".js"))).toEqual([]);
  });
});

describe("the Phase 13 register entries", () => {
  const service = require("../../src/engine/config/service");
  const { entries } = service.loadRegister();
  const snapshot = service.defaultSnapshot();

  test("every parameter §3.5, §19 and §24.6 read is registered and resolves", () => {
    const named = [
      // Registered by Phase 1 from Appendix A; asserted here because Phase 13 is the first
      // phase to actually elect a leader against them.
      "shard.lease_duration",
      "commit.max_serial_utilisation",
      "time.max_clock_skew",
      "shard.max_agents",
      "shard.mission_rate_per_agent_hour",
      "shard.txn_per_mission_lifecycle",
      "shard.commit_txn_service_time",
      "perf.round_wall_clock_p99",
      // Phase 13's own six.
      "shard.renewal_interval",
      "shard.store_round_trip_budget",
      "shard.migration_min_interval",
      "shard.min_agents",
      "shard.locality_max_round_time_divergence",
      "crossregion.downstream_binding_eta_confidence",
    ];
    for (const name of named) {
      expect({ name, registered: entries.has(name) }).toEqual({ name, registered: true });
      expect({ name, resolvable: snapshot.resolve(name) !== undefined }).toEqual({ name, resolvable: true });
    }
  });

  test("the six new entries carry every §22.1 rule-2 field", () => {
    for (const name of [
      "shard.renewal_interval",
      "shard.store_round_trip_budget",
      "shard.migration_min_interval",
      "shard.min_agents",
      "shard.locality_max_round_time_divergence",
      "crossregion.downstream_binding_eta_confidence",
    ]) {
      const entry = entries.get(name);
      for (const field of ["type", "unit", "scopes", "owner", "description", "changeClass", "blastRadius", "section", "calibrationStatus"]) {
        expect({ name, field, present: entry[field] !== undefined && entry[field] !== null }).toEqual({ name, field, present: true });
      }
      expect(Object.prototype.hasOwnProperty.call(entry, "default")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(entry, "range")).toBe(true);
    }
  });

  test("`shard.store_round_trip_budget` is SAFETY-class — it sizes the window a coordinator may still believe it leads", () => {
    expect(entries.get("shard.store_round_trip_budget").changeClass).toBe("SAFETY");
  });

  test("the defaults satisfy A4's renewal-margin coupling — a seeded register is a publishable one", () => {
    const result = service.validateCandidate({});
    expect(result.result.blocking.filter((item) => item.id === "A4")).toEqual([]);
  });
});

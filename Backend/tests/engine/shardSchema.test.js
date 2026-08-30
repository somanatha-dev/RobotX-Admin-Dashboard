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

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 13 REMEDIATION — the rebalance intent's own migration (P13-R4)

   Held to exactly the standard the Phase 13 migration is held to, and to one
   more: it must not have disturbed the Phase 13 migration at all. That is what
   makes "additive" a checked property rather than a claim in a comment.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the ShardRebalance migration — durable §19.2 intent, added without touching what shipped", () => {
  const REMEDIATION_DIR = "20260819090000_shard_rebalance_intent";
  const REMEDIATION = fs.readFileSync(path.join(BACKEND_ROOT, "prisma", "migrations", REMEDIATION_DIR, "migration.sql"), "utf8");

  test("its CREATE TABLE is byte-identical to Prisma's own generated one", () => {
    const header = 'CREATE TABLE "ShardRebalance" (';
    expect(normalise(block(REMEDIATION, header))).toBe(normalise(block(generatedSql(), header)));
  });

  test("every index and foreign key matches the generated output", () => {
    for (const statement of [
      'CREATE INDEX "ShardRebalance_sourceShardId_state_idx" ON "ShardRebalance"("sourceShardId", "state");',
      'CREATE INDEX "ShardRebalance_state_idx" ON "ShardRebalance"("state");',
      'ALTER TABLE "ShardRebalance" ADD CONSTRAINT "ShardRebalance_sourceShardId_fkey" FOREIGN KEY ("sourceShardId") REFERENCES "Shard"("shardId") ON DELETE RESTRICT ON UPDATE CASCADE;',
      'ALTER TABLE "ShardRebalance" ADD CONSTRAINT "ShardRebalance_targetShardId_fkey" FOREIGN KEY ("targetShardId") REFERENCES "Shard"("shardId") ON DELETE RESTRICT ON UPDATE CASCADE;',
    ]) {
      expect({ statement, inMigration: REMEDIATION.includes(statement) }).toEqual({ statement, inMigration: true });
      expect({ statement, inGenerated: generatedSql().includes(statement) }).toEqual({ statement, inGenerated: true });
    }
  });

  // **The load-bearing assertion of this block.** The alternative shape — a
  // `rebalanceTargetShardId` column on `Shard` — would have forced either an edit to an
  // already-applied migration (Prisma checksum drift everywhere it has been applied) or a
  // weakening of the byte-equality assertion at the top of this file. A separate table
  // costs neither, and this is the proof rather than the claim.
  test("**the Phase 13 migration is untouched**: `Shard` gains no column, and only one new table is created", () => {
    expect(MIGRATION).not.toContain("ShardRebalance");
    expect(REMEDIATION).not.toMatch(/ALTER TABLE "Shard"\s+ADD COLUMN/);
    expect(REMEDIATION).not.toMatch(/ALTER TABLE "ShardLeadership"/);
    expect(REMEDIATION).not.toMatch(/ALTER COLUMN/);
    expect(REMEDIATION).not.toMatch(/\bDROP\b/);

    // Statements only. The header prose names `CREATE TABLE "Shard"` while explaining why
    // it is deliberately *not* re-issued here, and an assertion about DDL that a comment
    // can fail is an assertion about prose.
    const statements = REMEDIATION.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    const created = [...statements.matchAll(/CREATE TABLE "(\w+)"/g)].map((match) => match[1]);
    expect(created).toEqual(["ShardRebalance"]);
    const altered = [...new Set([...statements.matchAll(/ALTER TABLE "(\w+)"/g)].map((match) => match[1]))];
    expect(altered).toEqual(["ShardRebalance"]);

    // And the shape that makes that possible: two back-relations on `Shard`, which add no
    // column, so its generated CREATE TABLE is unchanged.
    const model = /model Shard \{[\s\S]*?\n\}/.exec(SCHEMA)[0];
    expect(model).toMatch(/rebalancesOut ShardRebalance\[\] @relation\("ShardRebalanceSource"\)/);
    expect(model).toMatch(/rebalancesIn\s+ShardRebalance\[\] @relation\("ShardRebalanceTarget"\)/);
    expect(block(generatedSql(), 'CREATE TABLE "Shard" (')).not.toContain("rebalance");
  });

  const REBALANCE_CHECKS = [
    "ShardRebalance_state_known",
    "ShardRebalance_moves_between_two_shards",
    "ShardRebalance_reason_known",
    "ShardRebalance_restore_state_admits_work",
    "ShardRebalance_plan_is_not_empty",
    "ShardRebalance_completed_within_plan",
    "ShardRebalance_terminal_is_timed",
  ];

  test.each(REBALANCE_CHECKS.map((name) => [name]))("%s is written by hand and is absent from Prisma's output", (name) => {
    expect({ name, inMigration: REMEDIATION.includes(name) }).toEqual({ name, inMigration: true });
    expect({ name, inGenerated: generatedSql().includes(name) }).toEqual({ name, inGenerated: false });
  });

  test("at most one open intent per source shard, as a partial unique index", () => {
    expect(REMEDIATION).toContain('CREATE UNIQUE INDEX "ShardRebalance_one_open_per_source"');
    expect(REMEDIATION).toContain(`ON "ShardRebalance"("sourceShardId") WHERE "state" IN ('PENDING', 'EXECUTING')`);
    expect(generatedSql()).not.toContain("ShardRebalance_one_open_per_source");
  });

  // The schema's own statement of "no shard can be stranded": whatever terminal disposition
  // this row reaches, the state it restores its source shard to is one that admits work.
  test("**the restore target is constrained to a serving state** — stranding is unrepresentable", () => {
    expect(REMEDIATION).toMatch(
      /ShardRebalance_restore_state_admits_work[\s\S]*?"restoreState" IN \('ACTIVE', 'REBALANCING'\)/,
    );
  });

  test("COMMISSIONING is excluded from the reason vocabulary — a rebalance is never a placement", () => {
    expect(REMEDIATION).toMatch(
      /ShardRebalance_reason_known[\s\S]*?"reason" IN \('REBALANCE_SPLIT', 'REBALANCE_MERGE', 'REDISTRICTING', 'OPERATOR'\)/,
    );
    const shardModel = require("../../src/engine/shard/shardModel");
    expect(shardModel.REBALANCE_REASONS).not.toContain("COMMISSIONING");
    expect([...shardModel.REBALANCE_REASONS].sort()).toEqual(
      Object.values(shardModel.MEMBERSHIP_REASON).filter((reason) => reason !== "COMMISSIONING").sort(),
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

  /* PHASE 13 REMEDIATION — the composition itself, asserted at the only layer that can see
   * it (P13-R8, P13-R9, P13-R11, P13-R12).
   *
   * Every defect this remediation found on the production path had the same shape: a key
   * the supervisor or one of its callees reads, and that `server.js` did not supply. Not
   * one was visible to a unit test, because every unit test injects the value. The
   * composition root has no unit test — it is a boot script — so these read it.
   *
   * The strongest of them is the last: a **mistyped register name** resolves to `undefined`
   * exactly like an omitted key, and produces exactly the same silent failure.
   */
  describe("the shard supervisor's composition in server.js", () => {
    const server = fs.readFileSync(path.join(BACKEND_ROOT, "server.js"), "utf8");
    // The `shardSupervisor.start(` call and everything up to the log line after it.
    const callSite = server.slice(server.indexOf("shardSupervisor.start("), server.indexOf("Shard coordinator standing for election"));

    test.each([
      ["runSerializable", "§19.2's handoff opens the transaction the epoch advance lives in"],
      ["selectForUpdate", "§10.3.2 step 1's row lock on the migrating agent"],
      ["reconcile", "§19.5 refuses to resume rounds without §12.4's sweep"],
      ["leaseDurationSeconds", "without it tryAcquire throws and no leader is ever elected"],
      ["maxClockSkewMillis", "§19.5's renewal margin"],
      ["storeRoundTripMillis", "§19.5's renewal margin"],
      ["minIntervalMs", "§19.2's migration pacing"],
      ["commandTtlSeconds", "§23.3's not_valid_after on the SHARD_MIGRATE command"],
      ["signingKey", "§23.3 — an unsigned command is one an attacker can synthesise"],
      ["config", "§3.5's two sizing bounds; without it both report unevaluated"],
      ["onTick", "the wire for SHARD_LEADERSHIP_CHANGED and SHARD_MIGRATED"],
    ])("supplies `%s` — %s", (key) => {
      // `key:` or the shorthand `key,` — both supply it, and a check that accepted only the
      // first would fail for a style choice rather than for a missing dependency.
      expect({ key, supplied: new RegExp(`\\b${key}\\s*[:,]`).test(callSite) }).toEqual({ key, supplied: true });
    });

    test("the §12.4 sweep is given its own configuration, not only a shardId", () => {
      // `failover.run()` calls `deps.reconcile({ ...reconcileConfig, shardId })`. With no
      // `assignmentDeadlineSeconds` the orphan requeue reaches `timers.deadlineFrom(…,
      // undefined)`, which throws — so §19.5's reconciliation died on the first Leg it had
      // to reconstruct, which is the one case a failover exists for.
      for (const key of ["assignmentDeadlineSeconds", "unresponsiveStrikes", "energyDeviationTolerance"]) {
        expect({ key, supplied: callSite.includes(`${key}:`) }).toEqual({ key, supplied: true });
      }
      // …and the caller's own `shardId` still wins, because `failover.run()` scopes it.
      expect(callSite).toMatch(/energyDeviationTolerance[\s\S]*?\.\.\.sweepConfig/);
    });

    test("the sizing pass is given all four inputs §3.5's serial-commit bound needs", () => {
      for (const key of ["missionRatePerAgentHour", "txnPerMissionLifecycle", "commitTxnServiceTimeMs", "maxSerialUtilisation"]) {
        expect({ key, supplied: callSite.includes(`${key}:`) }).toEqual({ key, supplied: true });
      }
    });

    // **The one that catches a typo.** A misspelt register name resolves to `undefined`,
    // which is indistinguishable at the call site from an omitted key and produces the same
    // silent failure — a supervisor that logs a tick error and otherwise looks alive.
    test("every parameter name server.js reads is registered and resolves", () => {
      const service = require("../../src/engine/config/service");
      const snapshot = service.defaultSnapshot();
      const names = [...new Set([...callSite.matchAll(/finite\("([^"]+)"\)/g)].map((match) => match[1]))];

      expect(names.length).toBeGreaterThanOrEqual(9);
      for (const name of names) {
        expect({ name, resolves: Number.isFinite(snapshot.values.get(name)) }).toEqual({ name, resolves: true });
      }
    });

    test("the signing key is read from the environment and never defaulted", () => {
      // The same posture `SHARD_CONSENSUS_REPLICATION` is read with: the code will not
      // invent an operator's declaration. There is no `|| "..."` fallback here, and there
      // must not be — a default signing key is a key an attacker also has.
      expect(callSite).toContain("signingKey: process.env.COMMAND_SIGNING_KEY");
      expect(callSite).not.toMatch(/COMMAND_SIGNING_KEY\s*\|\|/);
    });
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

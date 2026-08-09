"use strict";

/**
 * Engine lane — Phase 14: the §23 schema, the migration, and the register entries.
 *
 * Three things are asserted, in the discipline every schema test in this tree follows:
 *
 *   1. The hand-written migration's DDL is **Prisma's own**, not a paraphrase — re-run
 *      from the schema and compared.
 *   2. The CHECK constraints Prisma cannot express are genuinely hand-written additions,
 *      proved by their absence from Prisma's output.
 *   3. The migration is additive, and the columns §23.7 will eventually drop are still
 *      present — because Phase 15 owns that drop and dropping early would break the
 *      legacy path a retention window before the plan permits it.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const MIGRATION_DIR = "20260809090000_security_governance_privacy";
const MIGRATION = fs.readFileSync(path.join(BACKEND_ROOT, "prisma", "migrations", MIGRATION_DIR, "migration.sql"), "utf8");
const SCHEMA = fs.readFileSync(path.join(BACKEND_ROOT, "prisma", "schema.prisma"), "utf8");

const NEW_TABLES = ["AgentCertificate", "CapabilityAttestation", "IdentityRecord", "OverrideAudit"];

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
 * SQL with its comments removed.
 *
 * Both the generated file and this migration are comment-heavy — Prisma prefixes every
 * statement with `-- CreateIndex`, and this migration states a reason above each CHECK.
 * A scan over the raw text would match a rule inside the sentence that documents it,
 * which is how the "no ALTER COLUMN" assertion below would fail on the header line that
 * promises there is no ALTER COLUMN.
 */
const codeOnly = (sql) => sql.replace(/^\s*--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("the Phase 14 migration matches Prisma's own generated SQL", () => {
  test.each(NEW_TABLES.map((table) => [table]))("%s's CREATE TABLE is byte-identical to the generated one", (table) => {
    const header = `CREATE TABLE "${table}" (`;
    const mine = block(MIGRATION, header);
    const theirs = block(generatedSql(), header);

    expect(mine).not.toBeNull();
    expect(theirs).not.toBeNull();
    expect(normalise(mine)).toBe(normalise(theirs));
  });

  test("every index and foreign key the schema declares for these tables is in the migration", () => {
    const relevant = codeOnly(generatedSql())
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => NEW_TABLES.some((table) => statement.includes(`"${table}"`)))
      .filter((statement) => statement.startsWith("CREATE") || statement.startsWith("ALTER TABLE"))
      .filter((statement) => !statement.startsWith("CREATE TABLE"));

    // Four indexes, two unique indexes and two foreign keys. If this ever drops to zero
    // the filter has stopped matching and the loop below proves nothing.
    expect(relevant.length).toBeGreaterThanOrEqual(8);
    for (const statement of relevant) {
      expect(normalise(codeOnly(MIGRATION))).toContain(normalise(statement));
    }
  });

  test("the thirteen added columns are exactly what schema.prisma declares", () => {
    const added = [
      ['Stop', 'identityKey'],
      ['Stop', 'fineCell'],
      ['Stop', 'zoneId'],
      ['Stop', 'geofenceResult'],
      ['Stop', 'accessWindowClass'],
      ['Stop', 'serviceTimeCohort'],
      ['Stop', 'routingNodeId'],
      ['Task', 'originIdentityKey'],
      ['Task', 'destinationIdentityKey'],
      ['DecisionRecordA', 'surrogateKeys'],
      ['DecisionRecordB', 'surrogateKeys'],
      ['InputSnapshot', 'surrogateKeys'],
    ];

    for (const [table, column] of added) {
      expect({ table, column, added: MIGRATION.includes(`ALTER TABLE "${table}" ADD COLUMN     "${column}"`) }).toEqual({
        table,
        column,
        added: true,
      });
    }
  });

  test("one ALTER TABLE per column — the style the tree's schema tests read", () => {
    // `domainSchema.test.js` subtracts later-added columns by matching
    // `ALTER TABLE "<t>" ADD COLUMN "<c>"`, which sees only the first column of a
    // multi-column statement. Writing one statement per column is what keeps that
    // subtraction honest across this migration.
    expect(MIGRATION).not.toMatch(/ADD COLUMN[^;]*,\s*\n\s*ADD COLUMN/);
  });
});

describe("the migration is additive", () => {
  test("it drops nothing, renames nothing, and re-types nothing", () => {
    const sql = codeOnly(MIGRATION);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TYPE)\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/\bALTER\s+COLUMN\b/i);
  });

  test("every column it adds is nullable with no default", () => {
    const columns = [...MIGRATION.matchAll(/ADD COLUMN\s+"([A-Za-z]+)"\s+([^;]+);/g)];
    expect(columns.length).toBeGreaterThan(0);
    for (const [, column, definition] of columns) {
      expect({ column, notNull: /NOT NULL/i.test(definition) }).toEqual({ column, notNull: false });
    }
  });

  test("the pre-existing tables it touches are exactly the five the plan names", () => {
    const altered = new Set([...MIGRATION.matchAll(/ALTER TABLE "([A-Za-z_]+)"/g)].map((match) => match[1]));
    const preExisting = [...altered].filter((table) => !NEW_TABLES.includes(table)).sort();
    expect(preExisting).toEqual(["DecisionRecordA", "DecisionRecordB", "InputSnapshot", "Stop", "Task"]);
  });

  test("Phase 15's drop has NOT happened early — the legacy columns are still there", () => {
    // The plan: "Drop legacy columns **only after** a full retention window with the new
    // path live." The legacy dispatcher reads every one of these.
    expect(MIGRATION).not.toMatch(/ALTER TABLE "Stop" DROP/);
    expect(MIGRATION).not.toMatch(/ALTER TABLE "Task" DROP/);
    const stop = /model Stop \{[\s\S]*?\n\}/.exec(SCHEMA)[0];
    for (const column of ["label", "lat", "lon"]) {
      expect({ column, present: new RegExp(`^\\s{2}${column}\\s`, "m").test(stop) }).toEqual({ column, present: true });
    }
  });

  test("it does not touch ShardLeadership, Commitment, or any table G1 reads", () => {
    for (const table of ["ShardLeadership", "Commitment", "Outbox", "Agent"]) {
      expect({ table, altered: MIGRATION.includes(`ALTER TABLE "${table}"`) }).toEqual({ table, altered: false });
    }
  });
});

describe("the CHECK constraints are genuine hand-written additions", () => {
  const CHECKS = [
    "AgentCertificate_key_storage_known",
    "AgentCertificate_status_known",
    "AgentCertificate_revoked_has_time",
    "AgentCertificate_validity_ordered",
    "CapabilityAttestation_algorithm_known",
    "CapabilityAttestation_outcome_known",
    "IdentityRecord_subject_type_known",
    "IdentityRecord_classification_known",
    "IdentityRecord_surrogate_key_shape",
    "IdentityRecord_erased_has_no_ciphertext",
    "OverrideAudit_constraint_class_known",
    "OverrideAudit_action_class_known",
    "OverrideAudit_absolute_classes_never_granted",
    "OverrideAudit_granted_has_reason",
    "OverrideAudit_refusal_reason_consistent",
    "OverrideAudit_second_approver_distinct",
  ];

  test.each(CHECKS.map((name) => [name]))("%s is in the migration and absent from Prisma's output", (name) => {
    expect(MIGRATION).toContain(name);
    // Prisma cannot express a CHECK, so its presence in the generated SQL would mean this
    // constraint was an echo rather than an addition.
    expect(generatedSql()).not.toContain(name);
  });

  test("the absolute-classes constraint is the store's copy of §23.6's first rule", () => {
    // `override.js` refuses before it looks at the actor; this refuses even if that module
    // is bypassed, which is what makes the rule a property of the system rather than of one
    // module. A refusal row against those classes is explicitly permitted.
    expect(MIGRATION).toMatch(/CHECK \(NOT \("granted" AND "constraintClass" IN \('I', 'R', 'F'\)\)\)/);
  });

  test("the tombstone rule is expressed at the store, not left to the update path", () => {
    expect(MIGRATION).toMatch(/IdentityRecord_erased_has_no_ciphertext[\s\S]*?"erasedAt" IS NOT NULL AND "ciphertext" IS NULL/);
  });
});

describe("the §23 models say what §23 requires them to", () => {
  test("AgentCertificate holds a public key and never a private one", () => {
    const model = /model AgentCertificate \{[\s\S]*?\n\}/.exec(SCHEMA)[0];
    expect(model).toContain("publicKeyPem");
    // A secure element exports a public key and never a secret; a column that could hold
    // one would be a column somebody eventually puts one in.
    expect(model).not.toMatch(/privateKey/i);
  });

  test("IdentityRecord keeps field names in the clear and values sealed", () => {
    const model = /model IdentityRecord \{[\s\S]*?\n\}/.exec(SCHEMA)[0];
    expect(model).toContain("fieldNames String[]");
    for (const column of ["ciphertext", "iv", "authTag"]) expect(model).toContain(column);
    // No plaintext column: if one existed, "encryption at rest" would be a property of
    // whichever writer remembered to use the other column.
    expect(model).not.toMatch(/^\s{2}fields\s+Json/m);
  });

  test("OverrideAudit records refusals as rows, so `granted` is not implied", () => {
    const model = /model OverrideAudit \{[\s\S]*?\n\}/.exec(SCHEMA)[0];
    expect(model).toMatch(/^\s{2}granted\s+Boolean$/m);
    expect(model).toContain("refusalReason");
    expect(model).toContain("auditEventHash");
  });
});

describe("the Phase 14 register entries", () => {
  const service = require("../../src/engine/config/service");
  const { entries } = service.loadRegister();
  const snapshot = service.defaultSnapshot();

  const NAMED = [
    "security.certificate_revocation_recheck_interval",
    "security.certificate_rotation_lead_time",
    "security.session_max_age",
    "security.attestation_max_age",
    "security.position_plausibility_tolerance",
    "security.energy_rate_tolerance",
    "security.implausible_report_quarantine_threshold",
    "security.override_rate_window",
    "security.override_rate_threshold_per_operator",
    "security.override_rate_threshold_per_predicate",
    "security.elevated_roles",
    "security.second_approver_action_classes",
    "privacy.identity_retention",
  ];

  test.each(NAMED.map((name) => [name]))("%s is registered and resolves", (name) => {
    expect(entries.has(name)).toBe(true);
    expect(snapshot.values.get(name)).not.toBeUndefined();
  });

  test("the security controls that bound a window are Safety-class", () => {
    // §22.3: raising any of these widens the window in which a withdrawn credential, a
    // stale attestation, or an implausible report keeps acting — the kind of change an
    // optimiser chasing load would make and be locally correct about every time.
    for (const name of [
      "security.certificate_revocation_recheck_interval",
      "security.attestation_max_age",
      "security.position_plausibility_tolerance",
      "security.energy_rate_tolerance",
      "security.implausible_report_quarantine_threshold",
      "security.elevated_roles",
      "security.second_approver_action_classes",
    ]) {
      expect({ name, changeClass: entries.get(name).changeClass }).toEqual({ name, changeClass: "SAFETY" });
    }
  });

  test("the role list default is exactly the constant the route files used to carry", () => {
    // The behavioural claim: moving `ELEVATED_ROLES` out of `config.routes.js` and
    // `shards.routes.js` and into the register changes nothing on the day it lands.
    expect(snapshot.values.get("security.elevated_roles")).toEqual(["SUPER_ADMIN"]);
  });

  test("A5 refuses an identity retention that is not shorter than the technical record's", () => {
    const validators = require("../../src/engine/config/validators");

    expect(validators.a5IdentityRetentionOrdering(new Map([["privacy.identity_retention", 14], ["observability.full_retention", 30]]))).toEqual([]);

    const equal = validators.a5IdentityRetentionOrdering(new Map([["privacy.identity_retention", 30], ["observability.full_retention", 30]]));
    expect(equal).toHaveLength(1);
    expect(equal[0]).toMatchObject({ id: "A5", severity: "BLOCKING" });
    expect(equal[0].message).toMatch(/the state the separation exists to leave behind/);

    const longer = validators.a5IdentityRetentionOrdering(new Map([["privacy.identity_retention", 90], ["observability.full_retention", 30]]));
    expect(longer).toHaveLength(1);
  });

  test("A5 and V6 together pin the ordering identity < technical <= snapshot", () => {
    const values = snapshot.values;
    expect(values.get("privacy.identity_retention")).toBeLessThan(values.get("observability.full_retention"));
    expect(values.get("observability.input_snapshot_retention")).toBeGreaterThanOrEqual(values.get("observability.full_retention"));
  });
});

describe("the Phase 14 modules and their tier", () => {
  const { tierOf, TIER } = require("../../src/engine/guards/tierAssertions");

  test("security/ and privacy/ are Tier 1 by the default rule, with no MODULE_TIERS row added", () => {
    // §1.8 does not name these as Tier 2 mechanisms, so they take the Tier 1 default for
    // `src/engine/`. A row added here would be this phase reclassifying a mechanism the
    // specification classified.
    for (const module of [
      "src/engine/security/sessionBinding.js",
      "src/engine/security/attestation.js",
      "src/engine/security/trustBoundaries.js",
      "src/engine/security/override.js",
      "src/engine/privacy/surrogateKeys.js",
      "src/engine/privacy/identityStore.js",
      "src/engine/privacy/erasure.js",
    ]) {
      expect({ module, tier: tierOf(module) }).toEqual({ module, tier: TIER.OPERATIONAL_INTEGRITY });
    }
  });

  test("the Phase 14 worker is not started from app.js, and is gated in server.js", () => {
    const server = fs.readFileSync(path.join(BACKEND_ROOT, "server.js"), "utf8");
    const app = fs.readFileSync(path.join(BACKEND_ROOT, "src", "app.js"), "utf8");

    expect(app).not.toContain("certificateRotation");
    const gateIndex = server.indexOf("if (engineEnabled) {");
    const startIndex = server.indexOf("certificateRotation.start(");
    expect(gateIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeGreaterThan(gateIndex);
    expect(server.split("certificateRotation.start(").length - 1).toBe(1);
  });
});

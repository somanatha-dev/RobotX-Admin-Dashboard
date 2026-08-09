"use strict";

/**
 * Engine lane — Phase 4: the migration, the §23.3 envelope, and the parameters.
 *
 * The migration is cross-checked against Prisma's own generated SQL wherever Prisma
 * can generate it, so the hand-written file and `schema.prisma` cannot silently
 * disagree. What Prisma cannot express — the four CHECK constraints — is asserted as
 * written, and its *absence* from the generated output is asserted too, so a future
 * reviewer can tell a hand-written addition from an echo.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const commandSigning = require("../../src/engine/security/commandSigning");
const fencing = require("../../src/engine/commitment/fencing");
const outbox = require("../../src/engine/dispatch/outbox");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const MIGRATION = fs.readFileSync(
  path.join(BACKEND_ROOT, "prisma", "migrations", "20260730090000_dispatch_and_agent_protocol", "migration.sql"),
  "utf8",
);
const SCHEMA = fs.readFileSync(path.join(BACKEND_ROOT, "prisma", "schema.prisma"), "utf8");

let generated = null;
function generatedSql() {
  if (generated === null) {
    // Prisma's CLI entry point directly, rather than through `npx` — the same route
    // Phase 2's drift check uses, and the one that works on every platform without a
    // shell.
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

/* ═══════════════════════════════════════════════════════════════════════════
   The migration is Prisma's own SQL plus annotated hand-written additions
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the Phase 4 migration cannot disagree with schema.prisma", () => {
  jest.setTimeout(60_000);

  test.each(["Outbox", "AgentDedupState"])("the %s CREATE TABLE is byte-identical to Prisma's own", (table) => {
    const header = `CREATE TABLE "${table}" (`;
    expect(block(MIGRATION, header)).toBe(block(generatedSql(), header));
  });

  test("every index and foreign key the schema declares appears verbatim", () => {
    const statements = generatedSql()
      .split("\n")
      .filter((line) => /^(CREATE (UNIQUE )?INDEX|ALTER TABLE) "(Outbox|AgentDedupState)"/.test(line));

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect({ statement, present: MIGRATION.includes(statement) }).toEqual({ statement, present: true });
    }
  });

  test("the plan's named index — (state, notValidAfter) — exists", () => {
    expect(MIGRATION).toContain('CREATE INDEX "Outbox_state_notValidAfter_idx" ON "Outbox"("state", "notValidAfter")');
  });

  test("the four CHECK constraints are hand-written — Prisma generates none of them", () => {
    const sql = generatedSql();
    for (const constraint of [
      "Outbox_command_class_known",
      "Outbox_fence_scope_columns",
      "Outbox_sequence_non_negative",
      "Outbox_state_known",
      "AgentDedupState_counters_non_negative",
    ]) {
      expect({ constraint, inMigration: MIGRATION.includes(constraint) }).toEqual({ constraint, inMigration: true });
      expect({ constraint, inGenerated: sql.includes(constraint) }).toEqual({ constraint, inGenerated: false });
    }
  });

  test("the migration is additive — no DROP, no RENAME, no ALTER COLUMN", () => {
    expect(MIGRATION).not.toMatch(/\bDROP\b/i);
    expect(MIGRATION).not.toMatch(/\bRENAME\b/i);
    expect(MIGRATION).not.toMatch(/ALTER COLUMN/i);
  });

  test("no pre-existing table gains a column — the two relations are back-relations only", () => {
    const alters = MIGRATION.match(/^ALTER TABLE "(\w+)"/gm) || [];
    for (const alter of alters) {
      expect(alter).toMatch(/"(Outbox|AgentDedupState)"/);
    }
  });

  test("the state CHECK enumerates exactly the module's own state set", () => {
    const declared = MIGRATION.slice(MIGRATION.indexOf("Outbox_state_known"));
    for (const state of Object.values(outbox.OUTBOX_STATE)) {
      expect({ state, inCheck: declared.includes(`'${state}'`) }).toEqual({ state, inCheck: true });
    }
    // And nothing beyond it, so the constraint and the enum cannot drift apart.
    const quoted = declared.slice(0, declared.indexOf("));")).match(/'[A-Z_]+'/g) || [];
    expect(new Set(quoted.map((q) => q.slice(1, -1)))).toEqual(new Set(Object.values(outbox.OUTBOX_STATE)));
  });

  test("the command-class CHECK admits MISSION and AGENT, and never QUERY", () => {
    expect(MIGRATION).toMatch(/"commandClass" IN \('MISSION', 'AGENT'\)/);
    expect(fencing.COMMAND_CLASS.QUERY).toBe("QUERY");
    const declared = MIGRATION.slice(
      MIGRATION.indexOf("Outbox_command_class_known"),
      MIGRATION.indexOf("Outbox_fence_scope_columns"),
    );
    expect(declared).not.toContain("'QUERY'");
  });
});

describe("schema.prisma declares Phase 4's two tables and nothing more", () => {
  test("both models exist with the plan's named fields", () => {
    const outboxModel = /model Outbox \{[\s\S]*?\n\}/.exec(SCHEMA)[0];
    for (const field of [
      "idempotencyKey",
      "agentId",
      "commitmentId",
      "commandClass",
      "fenceScope",
      "fence",
      "authorityEpoch",
      "fenceFloor",
      "sequence",
      "payload",
      "notValidAfter",
      "signature",
      "state",
      "attempts",
      "claimedBy",
      "claimedAt",
      "deliveredAt",
    ]) {
      expect({ field, present: new RegExp(`\\n\\s+${field}\\s`).test(outboxModel) }).toEqual({ field, present: true });
    }

    const dedupModel = /model AgentDedupState \{[\s\S]*?\n\}/.exec(SCHEMA)[0];
    for (const field of ["agentId", "dedupStateGeneration", "authorityEpoch", "fenceFloor", "reportedAt"]) {
      expect({ field, present: new RegExp(`\\n\\s+${field}\\s`).test(dedupModel) }).toEqual({ field, present: true });
    }
  });

  test("the outbox references a commitment by its idempotency key, not by its row id", () => {
    // `Commitment.commitmentId` is the correlation key "across every subsystem" (§2.6),
    // and it is what every command carries on the wire. Referencing the surrogate row
    // id instead would force a join to answer "which commitment is this command for".
    expect(SCHEMA).toMatch(/commitment\s+Commitment\?\s+@relation\(fields: \[commitmentId\], references: \[commitmentId\]/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §23.3 — the command envelope
   ═══════════════════════════════════════════════════════════════════════════ */

describe("command signing (§23.3)", () => {
  const KEY = "a-test-signing-key-of-at-least-thirty-two-bytes";

  function envelope(overrides) {
    return {
      agentId: "agent-1",
      command: "OFFER",
      commandClass: "MISSION",
      fenceScope: "COMMITMENT",
      commitmentId: "C1",
      fence: 5n,
      authorityEpoch: null,
      fenceFloor: null,
      sequence: 0,
      notValidAfter: new Date("2026-07-30T10:00:00.000Z"),
      payload: { plan: "p1" },
      ...(overrides || {}),
    };
  }

  test("§23.3's field set is exactly what the signature covers", () => {
    expect(commandSigning.SIGNED_FIELDS).toEqual([
      "agentId",
      "command",
      "commandClass",
      "fenceScope",
      "commitmentId",
      "fence",
      "authorityEpoch",
      "fenceFloor",
      "sequence",
      "notValidAfter",
      "payload",
    ]);
  });

  test("changing any signed field invalidates the signature", () => {
    const signature = commandSigning.sign(envelope(), KEY);
    const mutations = {
      agentId: "agent-2",
      command: "RECALL",
      commitmentId: "C2",
      fence: 6n,
      sequence: 1,
      notValidAfter: new Date("2026-07-30T11:00:00.000Z"),
      payload: { plan: "p2" },
    };
    for (const [field, value] of Object.entries(mutations)) {
      expect({ field, verified: commandSigning.verify(envelope({ [field]: value }), signature, KEY) }).toEqual({
        field,
        verified: false,
      });
    }
  });

  test("the canonical form is independent of key order — two builders sign identically", () => {
    const a = commandSigning.sign(envelope({ payload: { alpha: 1, beta: 2 } }), KEY);
    const b = commandSigning.sign(envelope({ payload: { beta: 2, alpha: 1 } }), KEY);
    expect(a).toBe(b);
  });

  test("a BigInt fence and its decimal string sign identically — the wire and the store agree", () => {
    expect(commandSigning.canonicalValue(5n)).toBe("5");
    expect(commandSigning.canonicalValue(null)).toBe("null");
    // …and the string "null" is distinguishable from absence.
    expect(commandSigning.canonicalValue("null")).toBe('"null"');
  });

  test("a key shorter than 32 bytes is refused rather than used", () => {
    expect(() => commandSigning.sign(envelope(), "short")).toThrow(/does not\s+carry the secrecy/);
    expect(() => commandSigning.sign(envelope(), "")).toThrow(/requires a key/);
  });

  test("an unknown command cannot be signed into existence", () => {
    expect(() => commandSigning.sign(envelope({ command: "SELF_DESTRUCT" }), KEY)).toThrow(/absent from the §10.3.1/);
  });

  test("admitEnvelope applies the three envelope rules in §23.3's order", () => {
    const signed = { ...envelope(), signature: commandSigning.sign(envelope(), KEY) };
    const before = new Date("2026-07-30T09:00:00.000Z");
    const after = new Date("2026-07-30T11:00:00.000Z");

    // PHASE 14 — the verdict gained a `scope`. §23.3's "Every rejection is reported and
    // counted, **by scope**" needs the dimension at the point of refusal, and deriving it
    // afterwards from the command name would fail for exactly the envelopes whose command
    // field is the thing that was tampered with.
    expect(commandSigning.admitEnvelope(signed, { agentId: "agent-1", now: before, key: KEY })).toEqual({
      accepted: true,
      reason: null,
      scope: "COMMITMENT",
    });
    expect(commandSigning.admitEnvelope(signed, { agentId: "agent-2", now: before, key: KEY }).reason).toBe(
      "ADDRESSED_TO_ANOTHER_AGENT",
    );
    expect(commandSigning.admitEnvelope(signed, { agentId: "agent-1", now: after, key: KEY }).reason).toBe(
      "NOT_VALID_AFTER_PASSED",
    );
    expect(commandSigning.admitEnvelope(signed, { agentId: "agent-1", now: before, key: "wrong-key-but-long-enough-yes" })
      .reason).toBe("SIGNATURE_INVALID");
  });

  test("verification is constant-time and never throws on malformed input", () => {
    for (const bad of [undefined, null, "", "zz", "0".repeat(63)]) {
      expect(commandSigning.verify(envelope(), bad, KEY)).toBe(false);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §22 — the parameters this phase consumes, through the real Config Service
   ═══════════════════════════════════════════════════════════════════════════ */

describe("parameter-register integration (§22, invariant I15)", () => {
  const configService = require("../../src/engine/config/service");
  const snapshot = configService.defaultSnapshot();

  // The plan's "Configuration updates" row for Phase 4, verbatim.
  const PHASE_4_PARAMETERS = [
    ["dispatch.offer_ttl", { agent_class: "porter-2" }, "s", "POLICY"],
    ["dispatch.retry_window", {}, "s", "TUNED"],
    ["dispatch.nack_cooloff", {}, "s", "POLICY"],
    ["dispatch.systemic_threshold", {}, "ratio", "POLICY"],
    ["dispatch.max_delivery_delay", {}, "s", "STRUCTURAL"],
    ["agent.dedup_retention", { agent_class: "porter-2" }, "s", "SAFETY"],
    ["health.unresponsive_strikes", { agent_class: "porter-2" }, "count", "POLICY"],
  ];

  test.each(PHASE_4_PARAMETERS)(
    "%s resolves through the Config Service with its Appendix A unit and change class",
    (name, context, unit, changeClass) => {
      const explanation = snapshot.explain(name, context);
      expect({ name, source: explanation.source }).not.toEqual({ name, source: "unknown-parameter" });
      expect({ name, unit: explanation.unit, changeClass: explanation.changeClass }).toEqual({
        name,
        unit,
        changeClass,
      });
      expect(explanation.value).not.toBeNull();
    },
  );

  test("§11.5's retention constraint holds at the seeded defaults", () => {
    // "Retention: `agent.dedup_retention` ≥ `dispatch.offer_ttl` +
    // `dispatch.max_delivery_delay`. Below the sum, a redelivered command outlives the
    // state that would reject it."
    const retention = snapshot.resolve("agent.dedup_retention", { agent_class: "porter-2" });
    const ttl = snapshot.resolve("dispatch.offer_ttl", { agent_class: "porter-2" });
    const maxDelay = snapshot.resolve("dispatch.max_delivery_delay", {});
    expect(retention).toBeGreaterThanOrEqual(ttl + maxDelay);
  });

  test("no dispatch module hard-codes one of these values — each is an input", () => {
    // The parameter gate already refuses a bare literal anywhere in `src/engine`. This
    // asserts the narrower property: every Phase 4 entry point takes its durations as
    // arguments, so a caller cannot get a default the Config Service never resolved.
    for (const [module, source] of Object.entries({
      offers: fs.readFileSync(path.join(BACKEND_ROOT, "src", "engine", "dispatch", "offers.js"), "utf8"),
      escalation: fs.readFileSync(path.join(BACKEND_ROOT, "src", "engine", "dispatch", "escalation.js"), "utf8"),
    })) {
      expect({ module, reachesForConfig: /require\(.*config\/service/.test(source) }).toEqual({
        module,
        reachesForConfig: false,
      });
      expect({ module, reachesForEnv: /process\.env/.test(source) }).toEqual({ module, reachesForEnv: false });
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The Phase 4 gate, as a structural property
   ═══════════════════════════════════════════════════════════════════════════ */

describe("no command reaches an agent except from an outbox row (§4.1 rule 5)", () => {
  const dispatcher = fs.readFileSync(
    path.join(BACKEND_ROOT, "src", "services", "commandDispatcher.service.js"),
    "utf8",
  );

  test("the delivery arm emits only what an outbox envelope names", () => {
    // The engine's delivery function emits `envelope.command`, so the set of engine
    // events it can produce is exactly the §10.3.1 table — it has no literal event
    // name of its own.
    const arm = dispatcher.slice(dispatcher.indexOf("async function deliverOutboxCommand"));
    expect(arm).toContain("io.to(room).emit(envelope.command, envelope)");
  });

  test("no §10.3.1 command name is emitted by any legacy helper", () => {
    const legacy = dispatcher.slice(0, dispatcher.indexOf("PHASE 4 — the outbox's delivery arm"));
    for (const command of [...fencing.MISSION_COMMANDS, ...fencing.AGENT_COMMANDS]) {
      expect({ command, emittedByLegacy: legacy.includes(`"${command}"`) }).toEqual({
        command,
        emittedByLegacy: false,
      });
    }
  });

  test("the legacy events are still the legacy events — none carries a fence", () => {
    for (const legacyEvent of ["TASK_ASSIGN", "REROUTE_ALERT", "COMMAND", "STOP"]) {
      expect(dispatcher).toContain(`"${legacyEvent}"`);
      expect([...fencing.MISSION_COMMANDS, ...fencing.AGENT_COMMANDS]).not.toContain(legacyEvent);
    }
  });

  test("no dispatch module imports the cache — cache loss cannot lose a command (I16)", () => {
    const dispatchDir = path.join(BACKEND_ROOT, "src", "engine", "dispatch");
    for (const file of fs.readdirSync(dispatchDir).filter((f) => f.endsWith(".js"))) {
      const source = fs.readFileSync(path.join(dispatchDir, file), "utf8");
      expect({ file, importsCache: /require\(.*(cache\/kv|ioredis)/.test(source) }).toEqual({
        file,
        importsCache: false,
      });
    }
  });
});

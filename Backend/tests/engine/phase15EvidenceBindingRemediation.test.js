"use strict";

/**
 * Engine lane — the current-tree Phase 15 re-audit's evidence-binding findings.
 *
 * ── What these three findings have in common ───────────────────────────────
 * The previous current-tree audit closed six findings of the form *"a real producer, a real
 * consumer, and nothing joining them"*. These three are the next layer of the same thing:
 * **a rule that is stated, tested, and enforced only when the caller happens to supply the
 * input it is enforced against.**
 *
 * Every one of them was invisible to a green suite for the same reason, and it is not the
 * reason the previous six were. Each protection *is* tested — `evidence.admit()` has a
 * staleness test, `guardrails.declare()` has an empty-set test — and each test passes,
 * because each test supplies the field. What no test asked was what happens when a caller
 * does not, and the answer was: the check does not run, nothing says so, and the request is
 * authorised.
 *
 *   P15-C1  `evidence.admit()` read `nowMs` and `maxAgeMs` through `typeof` guards, so a
 *           caller that omitted either got no staleness check and no future-stamp check.
 *           `stage.authoriseEnable()` forwarded both as `undefined` when its request did not
 *           carry them, and `requestedAtMs` is also what the guardrail pre-declaration is
 *           ordered against — so one missing field switched off three protections and took
 *           a shard live on a three-year-old rollback rehearsal.
 *
 *   P15-C2  `stage.authoriseEnable()` checked that a guardrail declaration *existed* and
 *           that its `shardId` matched, and nothing else. `cutover/store.declarationFor`
 *           re-validates through `guardrails.declare()` and returns null when that throws —
 *           so a declaration the write side accepted was refused by the read side, and the
 *           controller reported the shard as "live with no pre-declared guardrails" on every
 *           pass for ever. Live, unguarded, and unrollbackable-by-the-controller.
 *
 *   P15-C3  `evidence.admit()` adjudicates `runnable` and `rehearsal` in a branch the
 *           PRODUCTION kind returns before reaching, so either flag on a PRODUCTION row
 *           would be silently ignored. A trap rather than a live defect, and one
 *           `simulator_fidelity` is a single plausible edit away from.
 *
 * The assertions below are written to fail if the *absence* of an input stops being
 * refused, which is the property none of the previous tests had.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const auditStream = require("../../src/engine/observability/auditStream");
const cutoverStore = require("../../src/engine/cutover/store");
const evidence = require("../../src/engine/cutover/evidence");
const gates = require("../../src/engine/cutover/gates");
const guardrails = require("../../src/engine/cutover/guardrails");
const stage = require("../../src/engine/cutover/stage");
const configService = require("../../src/engine/config/service");

const BACKEND_ROOT = path.join(__dirname, "..", "..");

/** P15-F1 — the authoritative parameter source the authority resolves its bounds from. */
const REGISTER = configService.loadRegister({ reload: true });
const PARAMETER_VALUES = Object.freeze({
  get: (name) => (REGISTER.entries.get(name) || {}).default,
});

const NOW = Date.UTC(2026, 7, 23, 12, 0, 0);
const HOUR = 3600000;
const DAY = 24 * HOUR;
const YEAR = 365 * DAY;
const DIGEST = "a".repeat(64);

/** A complete, well-formed rollback-rehearsal record, produced at the instant given. */
function rehearsalRecord(producedAtMs) {
  return {
    gateId: "rollback_rehearsed",
    producedAtMs,
    producer: "operator tooling",
    owner: "release-manager",
    pass: true,
    rehearsal: {
      environment: { id: "staging-1", production: false },
      configVersion: "17",
      automaticRollbackFired: true,
      steps: Object.fromEntries(evidence.REHEARSAL_STEPS.map((step) => [step, true])),
    },
    approval: { recordedBy: "alice", approvedBy: "bob" },
  };
}

/** An admissible, passing record for any gate, produced a second before `NOW`. */
function greenRecord(gate) {
  if (gate.evidence === gates.EVIDENCE.BUILD || gate.evidence === gates.EVIDENCE.SUITE) {
    return {
      gateId: gate.id,
      producedAtMs: NOW - 1000,
      producer: "tools/release/collectEvidence.js",
      run: { command: gate.command, exitCode: 0, build: { sourceDigest: DIGEST } },
      build: { sourceDigest: DIGEST },
    };
  }
  if (gate.evidence === gates.EVIDENCE.PRODUCTION) {
    return {
      gateId: gate.id,
      producedAtMs: NOW - 1000,
      producer: "observability",
      owner: "sre-oncall",
      pass: true,
      observation: { windowStartedAtMs: NOW - 40 * DAY, windowEndedAtMs: NOW, source: "prod-metrics" },
    };
  }
  const record = {
    gateId: gate.id,
    producedAtMs: NOW - 1000,
    producer: "operator tooling",
    owner: "release-manager",
    pass: true,
    approval: { recordedBy: "alice", approvedBy: "bob" },
  };
  if (gate.runnable === true) {
    record.corroboratingRun = { command: gate.command, exitCode: 0, build: { sourceDigest: DIGEST } };
  }
  if (gate.rehearsal === true) record.rehearsal = rehearsalRecord(NOW - 1000).rehearsal;
  return record;
}

/** The whole table, green — so a single gate's freshness is the only thing under test. */
function greenTable() {
  const table = {};
  for (const gate of gates.RELEASE_GATES) table[gate.id] = greenRecord(gate);
  return table;
}

/** A guardrail declaration `guardrails.declare()` accepts. */
function validDeclaration(overrides) {
  return guardrails.declare({
    shardId: "shard-1",
    declaredBy: "release-manager",
    declaredAtMs: NOW - DAY,
    observationWindowSeconds: 3600,
    guardrails: [
      {
        id: "commit_latency_p99",
        direction: "AT_MOST",
        threshold: 250,
        minSamples: 100,
        unit: "ms",
        rationale: "the pre-declared bound for this stage",
      },
    ],
    ...overrides,
  });
}

/** A complete `authoriseEnable` request. Individual fields are removed per test. */
function enableRequest(overrides) {
  return {
    shard: { shardId: "shard-1", regionId: "region-alpha", state: "ACTIVE" },
    allShards: [{ shardId: "shard-1", regionId: "region-alpha", state: "ACTIVE", agentCount: 1 }],
    liveShardIds: [],
    releaseEvidence: greenTable(),
    killSwitchState: {},
    declaration: validDeclaration(),
    requestedBy: "alice",
    approvedBy: "bob",
    reason: "stage the least-loaded shard first",
    requestedAtMs: NOW,
    sourceDigest: DIGEST,
    evidenceMaxAgeMs: DAY,
    // P15-F1 — this fixture used to state `soak: DAY`, a **24-hour** bound against a register
    // value of 72, and nothing refused it because nothing compared it to anything. A request
    // may no longer state the bound; the authority resolves it from the register, so the soak
    // gate here is now judged against 72 h. The 40-day window `greenRecord` builds satisfies
    // both the old bound and the real one, which is why this is a strictly stricter fixture
    // and not a re-tuned one.
    parameterValues: PARAMETER_VALUES,
    ...overrides,
  };
}

const completeContext = { nowMs: NOW, maxAgeMs: DAY, sourceDigest: DIGEST, minObservationMs: { shadow_agreement: 14 * DAY, soak: DAY } };

// ─────────────────────────────────────────────────────────────────────────────
// P15-C1 — the binding context is whole, or there is no judgement
// ─────────────────────────────────────────────────────────────────────────────

describe("P15-C1 — evidence.admit() refuses a record it cannot age", () => {
  const gate = gates.GATE_BY_ID.rollback_rehearsed;

  test("the control: a complete context admits a fresh record and refuses a stale one", () => {
    expect(evidence.admit(gate, rehearsalRecord(NOW - 1000), completeContext)).toMatchObject({
      admissible: true,
      pass: true,
    });
    expect(evidence.admit(gate, rehearsalRecord(NOW - 3 * YEAR), completeContext)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.STALE,
    });
  });

  test("an omitted age bound is refused, not treated as an unbounded one", () => {
    // The defect: this returned `{ admissible: true, pass: true }` for a three-year-old
    // rehearsal, because the staleness branch was guarded on `typeof maxAgeMs === "number"`.
    const verdict = evidence.admit(gate, rehearsalRecord(NOW - 3 * YEAR), { nowMs: NOW, sourceDigest: DIGEST });
    expect(verdict.admissible).toBe(false);
    expect(verdict.code).toBe(evidence.INADMISSIBLE.AGE_BOUND_REQUIRED);
  });

  test("an omitted evaluation instant is refused — it disabled the future-stamp check too", () => {
    const verdict = evidence.admit(gate, rehearsalRecord(NOW + YEAR), { maxAgeMs: DAY, sourceDigest: DIGEST });
    expect(verdict.admissible).toBe(false);
    expect(verdict.code).toBe(evidence.INADMISSIBLE.EVALUATION_INSTANT_REQUIRED);
  });

  test("a bound that is not a usable duration is refused rather than silently ignored", () => {
    // `Number("banana")` is NaN, `typeof NaN === "number"`, and every comparison against NaN
    // is false — so a typed bound that did not parse was indistinguishable from no bound.
    for (const bound of [Number.NaN, Number.POSITIVE_INFINITY, -1, "86400000", null]) {
      const verdict = evidence.admit(gate, rehearsalRecord(NOW - 3 * YEAR), {
        nowMs: NOW,
        maxAgeMs: bound,
        sourceDigest: DIGEST,
      });
      expect(verdict.admissible).toBe(false);
      expect(verdict.code).toBe(evidence.INADMISSIBLE.AGE_BOUND_REQUIRED);
    }
  });

  test("a zero bound is a bound — brutal, but stated, so it is honoured rather than refused", () => {
    const verdict = evidence.admit(gate, rehearsalRecord(NOW - 1000), { nowMs: NOW, maxAgeMs: 0, sourceDigest: DIGEST });
    expect(verdict.code).toBe(evidence.INADMISSIBLE.STALE);
  });

  test("the requirement holds for every evidence kind, not only the ones carrying a digest", () => {
    // This is the half that matters most: PRODUCTION and ORGANISATIONAL records carry no
    // source digest by construction, so for those six gates the age bound is the *only*
    // binding to the system being shipped.
    for (const gateRow of gates.RELEASE_GATES) {
      const verdict = evidence.admit(gateRow, greenRecord(gateRow), { nowMs: NOW, sourceDigest: DIGEST });
      expect(verdict.admissible).toBe(false);
      expect(verdict.code).toBe(evidence.INADMISSIBLE.AGE_BOUND_REQUIRED);
    }
  });

  test("gates.evaluate() reports the refusal as RED with its reason, not as NOT_EVALUATED", () => {
    const result = gates.evaluate({ rollback_rehearsed: rehearsalRecord(NOW - 3 * YEAR) }, { nowMs: NOW, sourceDigest: DIGEST });
    const row = result.results.find((entry) => entry.id === "rollback_rehearsed");
    expect(row.status).toBe(gates.STATUS.RED);
    expect(row.inadmissibleCode).toBe(evidence.INADMISSIBLE.AGE_BOUND_REQUIRED);
    // RED and NOT_EVALUATED stay distinct: an incident review must be able to tell a record
    // nobody could rely on from a gate nobody ran.
    expect(result.counts.NOT_EVALUATED).toBe(gates.RELEASE_GATES.length - 1);
  });
});

describe("P15-C1 — stage.authoriseEnable() refuses an incomplete request by name", () => {
  test("the control: a complete request with a complete green table is authorised", () => {
    const result = stage.authoriseEnable(enableRequest());
    expect(result.authorised).toBe(true);
    expect(result.action.binding).toEqual({
      level: "region",
      key: "region-alpha",
      name: "cutover.engine_enabled",
      value: true,
    });
  });

  test.each([
    ["evidenceMaxAgeMs", "evidenceMaxAgeMs"],
    ["requestedAtMs", "requestedAtMs"],
    ["sourceDigest", "sourceDigest"],
  ])("omitting %s refuses the cutover and the refusal names the missing field", (field) => {
    const request = enableRequest();
    delete request[field];
    const result = stage.authoriseEnable(request);
    expect(result.authorised).toBe(false);
    expect(result.refusal.code).toBe(stage.REFUSAL.EVIDENCE_CONTEXT_INCOMPLETE);
    expect(result.refusal.message).toContain(field);
  });

  test("a bound that does not parse is refused exactly as an absent one is", () => {
    for (const bound of [Number.NaN, -1, "one day"]) {
      const result = stage.authoriseEnable(enableRequest({ evidenceMaxAgeMs: bound }));
      expect(result.authorised).toBe(false);
      expect(result.refusal.code).toBe(stage.REFUSAL.EVIDENCE_CONTEXT_INCOMPLETE);
    }
  });

  test("the refusal is EVIDENCE_CONTEXT_INCOMPLETE, not RELEASE_GATE_NOT_GREEN", () => {
    // The distinction is the finding's other half. Reporting a caller's omission as a
    // failed release sends the next operator to look at the release rather than at their
    // own request, and the previous behaviour — judging against nothing — would have read
    // as a green release rather than as either.
    const request = enableRequest();
    delete request.evidenceMaxAgeMs;
    expect(stage.authoriseEnable(request).refusal.code).not.toBe(stage.REFUSAL.RELEASE_GATE_NOT_GREEN);
  });

  test("THE DEFECT: a three-year-old rehearsal no longer authorises a production cutover", () => {
    // Reproduction, before the fix: `authorised: true`, with a binding of
    // cutover.engine_enabled=true for region-alpha.
    const table = greenTable();
    table.rollback_rehearsed = rehearsalRecord(NOW - 3 * YEAR);

    const withoutBound = enableRequest({ releaseEvidence: table });
    delete withoutBound.evidenceMaxAgeMs;
    expect(stage.authoriseEnable(withoutBound).authorised).toBe(false);

    // And with the bound supplied it is refused for the right reason — the fix must reject
    // the stale record, not merely reject the request shape.
    const withBound = stage.authoriseEnable(enableRequest({ releaseEvidence: table }));
    expect(withBound.authorised).toBe(false);
    expect(withBound.refusal.code).toBe(stage.REFUSAL.RELEASE_GATE_NOT_GREEN);
    expect(withBound.refusal.message).toContain("rollback_rehearsed");
  });

  test("omitting requestedAtMs also switched off the pre-declaration ordering check", () => {
    // One missing field, three protections. The guardrails here are declared a year *after*
    // the request, which "pre-declared" forbids — and the ordering check was itself guarded
    // on `typeof source.requestedAtMs === "number"`.
    const late = validDeclaration({ declaredAtMs: NOW + YEAR });
    const request = enableRequest({ declaration: late });
    delete request.requestedAtMs;
    expect(stage.authoriseEnable(request).authorised).toBe(false);

    // With the instant supplied, the ordering check is the one that fires.
    const ordered = stage.authoriseEnable(enableRequest({ declaration: late }));
    expect(ordered.authorised).toBe(false);
    expect(ordered.refusal.code).toBe(stage.REFUSAL.GUARDRAILS_NOT_DECLARED);
    expect(ordered.refusal.message).toContain("the wrong way round");
  });
});

describe("P15-C1 — tools/release/verdict.js refuses a bound that does not parse", () => {
  const run = (args) => {
    try {
      execFileSync(process.execPath, [path.join(BACKEND_ROOT, "tools", "release", "verdict.js"), ...args], {
        cwd: BACKEND_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { exitCode: 0, stderr: "" };
    } catch (error) {
      return { exitCode: error.status, stderr: String(error.stderr || "") };
    }
  };

  test("a non-numeric --max-age-hours exits non-zero and says why", () => {
    const result = run(["--max-age-hours", "banana"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--max-age-hours");
  });

  test("a negative --max-age-hours is refused too", () => {
    expect(run(["--max-age-hours", "-3"]).exitCode).toBe(2);
  });

  test("the control: a numeric bound is accepted and the tool goes on to judge the table", () => {
    // Exit 1 is the *verdict* — the table is not green on this tree — and not the argument
    // refusal, which is exit 2. The distinction is what proves the parse check did not
    // simply reject everything.
    expect(run(["--max-age-hours", "24"]).exitCode).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P15-C2 — the declaration the write side accepts is the one the read side reads
// ─────────────────────────────────────────────────────────────────────────────

describe("P15-C2 — authoriseEnable validates the guardrail declaration it is handed", () => {
  test("a declaration guardrails.declare() refuses does not authorise a cutover", () => {
    // The exact shape that reproduced it: the right shardId, a past timestamp, nothing else.
    const handBuilt = { shardId: "shard-1", declaredAtMs: NOW - DAY };
    const result = stage.authoriseEnable(enableRequest({ declaration: handBuilt }));
    expect(result.authorised).toBe(false);
    expect(result.refusal.code).toBe(stage.REFUSAL.GUARDRAILS_NOT_DECLARED);
  });

  test("an empty guardrail set is refused — a stage with no guardrails is not a monitored stage", () => {
    const empty = { shardId: "shard-1", declaredBy: "rm", declaredAtMs: NOW - DAY, observationWindowSeconds: 3600, guardrails: [] };
    // The read side has always refused this by name; the write side did not ask.
    expect(() => guardrails.declare(empty)).toThrow(/no guardrails is a stage with no guardrails/);
    expect(stage.authoriseEnable(enableRequest({ declaration: empty })).authorised).toBe(false);
  });

  test.each([
    ["no declarer", { declaredBy: undefined }],
    ["no observation window", { observationWindowSeconds: undefined }],
    ["a guardrail with no threshold", { guardrails: [{ id: "x", direction: "AT_MOST", minSamples: 10 }] }],
    ["a guardrail with no minSamples", { guardrails: [{ id: "x", direction: "AT_MOST", threshold: 1 }] }],
    ["a guardrail with no direction", { guardrails: [{ id: "x", threshold: 1, minSamples: 10 }] }],
  ])("%s is refused", (_label, overrides) => {
    const declaration = {
      shardId: "shard-1",
      declaredBy: "rm",
      declaredAtMs: NOW - DAY,
      observationWindowSeconds: 3600,
      guardrails: [{ id: "commit_latency_p99", direction: "AT_MOST", threshold: 250, minSamples: 100 }],
      ...overrides,
    };
    const result = stage.authoriseEnable(enableRequest({ declaration }));
    expect(result.authorised).toBe(false);
    expect(result.refusal.code).toBe(stage.REFUSAL.GUARDRAILS_NOT_DECLARED);
  });

  test("THE ROUND TRIP: what the action carries is what the reader will accept", () => {
    // This is the assertion the defect existed for. `auditEventFor` writes
    // `action.guardrailDeclaration` into §21.7's stream, and `store.declarationFor` reads it
    // back **through `guardrails.declare()`**. Before the fix the write side could emit
    // something that call throws on, and the controller then reported the shard as "live
    // with no pre-declared guardrails" on every pass, for ever.
    const result = stage.authoriseEnable(enableRequest());
    expect(result.authorised).toBe(true);

    const recorded = stage.auditEventFor(result.action).payload.guardrails;
    expect(recorded).not.toBeNull();
    // The reader's exact call, on the exact payload. It must not throw.
    const reread = guardrails.declare(recorded);
    expect(reread.shardId).toBe("shard-1");
    expect(reread.guardrails).toHaveLength(1);
    expect(reread.guardrails[0].id).toBe("commit_latency_p99");
  });

  test("the action carries the NORMALISED declaration, so the two sides cannot drift", () => {
    // Passed in unsorted and with a stray field; what comes out is `declare()`'s own shape.
    const messy = {
      shardId: "shard-1",
      declaredBy: "rm",
      declaredAtMs: NOW - DAY,
      observationWindowSeconds: 3600,
      unexpectedField: "ignored",
      guardrails: [
        { id: "zzz_last", direction: "AT_MOST", threshold: 2, minSamples: 5 },
        { id: "aaa_first", direction: "AT_LEAST", threshold: 1, minSamples: 5 },
      ],
    };
    const result = stage.authoriseEnable(enableRequest({ declaration: messy }));
    expect(result.authorised).toBe(true);
    const carried = result.action.guardrailDeclaration;
    expect(carried.guardrails.map((entry) => entry.id)).toEqual(["aaa_first", "zzz_last"]);
    expect(carried.unexpectedField).toBeUndefined();
  });

  test("a declaration for a different shard is still refused, and says which", () => {
    const other = validDeclaration({ shardId: "shard-9" });
    const result = stage.authoriseEnable(enableRequest({ declaration: other }));
    expect(result.authorised).toBe(false);
    expect(result.refusal.code).toBe(stage.REFUSAL.GUARDRAILS_NOT_DECLARED);
    expect(result.refusal.message).toContain("shard-9");
  });

  test("an absent declaration is refused with the original message, not the validator's", () => {
    const request = enableRequest();
    delete request.declaration;
    const result = stage.authoriseEnable(request);
    expect(result.authorised).toBe(false);
    expect(result.refusal.message).toContain("no pre-declared SLI guardrails");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P15-C3 — a flag only one branch reads may only appear where that branch runs
// ─────────────────────────────────────────────────────────────────────────────

describe("P15-C3 — the gate table cannot declare a flag its adjudicator will ignore", () => {
  test("the table as shipped is well formed", () => {
    expect(gates.assertGates()).toBe(true);
  });

  test("every runnable or rehearsal gate is ORGANISATIONAL", () => {
    for (const gate of gates.RELEASE_GATES) {
      if (gate.runnable === true || gate.rehearsal === true) {
        expect(gate.evidence).toBe(gates.EVIDENCE.ORGANISATIONAL);
      }
    }
  });

  test("PRODUCTION evidence returns before the branch that reads either flag", () => {
    // The mechanism, asserted directly rather than inferred from the table: a PRODUCTION
    // record with neither a corroborating run nor a rehearsal is admitted on its window
    // alone. That is correct for a PRODUCTION gate and is exactly why such a gate must never
    // carry a flag promising more.
    const production = gates.RELEASE_GATES.find((gate) => gate.evidence === gates.EVIDENCE.PRODUCTION);
    const verdict = evidence.admit(production, greenRecord(production), completeContext);
    expect(verdict.admissible).toBe(true);
    expect(verdict.pass).toBe(true);
  });

  test("simulator_fidelity is the row this guard exists for, and it is unflagged", () => {
    // PRODUCTION evidence that already names a runnable command — one plausible edit from
    // a gate that looks stronger and is weaker.
    const gate = gates.GATE_BY_ID.simulator_fidelity;
    expect(gate.evidence).toBe(gates.EVIDENCE.PRODUCTION);
    expect(gate.command).toContain("simFidelity");
    expect(gate.runnable).toBeUndefined();
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// P15-C4 — the audit vocabulary the cutover writes is the one the store enforces
// ─────────────────────────────────────────────────────────────────────────────

describe("P15-C4 — a cutover audit event can actually be written", () => {
  test("both cutover event types are in the audit stream's vocabulary", () => {
    // The defect: neither was, so `auditStream.append()` refused every cutover event by
    // name and the CHECK constraint refused it again underneath.
    expect(Object.values(auditStream.EVENT_TYPE)).toContain("CUTOVER_SHARD_ENABLED");
    expect(Object.values(auditStream.EVENT_TYPE)).toContain("CUTOVER_SHARD_ROLLED_BACK");
  });

  test("the writer and the reader take the names from that one vocabulary", () => {
    // Root cause: three copies of a vocabulary, and the copy that decided was the database.
    // `stage.auditEventFor` and `store.EVENT` agreed with each other and disagreed with it.
    expect(cutoverStore.EVENT.ENABLED).toBe(auditStream.EVENT_TYPE.CUTOVER_SHARD_ENABLED);
    expect(cutoverStore.EVENT.ROLLED_BACK).toBe(auditStream.EVENT_TYPE.CUTOVER_SHARD_ROLLED_BACK);

    const enableEvent = stage.auditEventFor({ type: "ENABLE", shardId: "s", requestedBy: "a", reason: "r", requestedAtMs: NOW });
    const rollbackEvent = stage.auditEventFor({ type: "ROLLBACK", shardId: "s", requestedBy: "a", reason: "r", automatic: true, requestedAtMs: NOW });
    expect(enableEvent.eventType).toBe(cutoverStore.EVENT.ENABLED);
    expect(rollbackEvent.eventType).toBe(cutoverStore.EVENT.ROLLED_BACK);
  });

  test("every type the application declares is admitted by the database CHECK constraint", () => {
    // THE DRIFT GUARD. This is the assertion whose absence let the defect exist: the
    // application's vocabulary and the constraint that enforces it were free to disagree,
    // and did, for the entire life of the cutover machinery.
    //
    // Read from the migration chain rather than from a live connection so it runs in the
    // engine lane. The constraint is stated in exactly one migration at a time; the latest
    // one that mentions it is the one in force.
    const migrationsDir = path.join(BACKEND_ROOT, "prisma", "migrations");
    const mentioning = fs
      .readdirSync(migrationsDir)
      .filter((name) => fs.existsSync(path.join(migrationsDir, name, "migration.sql")))
      .filter((name) =>
        fs.readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8").includes("AuditEvent_event_type_known"),
      )
      .sort();
    expect(mentioning.length).toBeGreaterThan(0);

    const latest = fs.readFileSync(path.join(migrationsDir, mentioning[mentioning.length - 1], "migration.sql"), "utf8");
    // The ADD CONSTRAINT body, which is the list actually in force after the chain applies.
    const body = latest.slice(latest.lastIndexOf("ADD CONSTRAINT"));
    const admitted = new Set([...body.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]));

    for (const type of Object.values(auditStream.EVENT_TYPE)) {
      expect(admitted.has(type)).toBe(true);
    }
    // And the converse, so the constraint cannot quietly admit a type nothing declares.
    for (const type of admitted) {
      expect(Object.values(auditStream.EVENT_TYPE)).toContain(type);
    }
  });

  test("append() accepts a cutover event's shape rather than refusing it by type", async () => {
    // No database here — the type check is the part that refused, and it happens before any
    // query. A store that throws on `findFirst` proves the type was accepted.
    const event = stage.auditEventFor({
      type: "ENABLE",
      shardId: "s",
      regionId: "r",
      requestedBy: "alice",
      approvedBy: "bob",
      reason: "stage",
      requestedAtMs: NOW,
      guardrailDeclaration: null,
    });
    const reached = { query: false };
    const prisma = {
      auditEvent: {
        findFirst: async () => {
          reached.query = true;
          throw new Error("REACHED_THE_STORE");
        },
      },
    };
    await expect(auditStream.append({ prisma }, { ...event, streamId: "t" })).rejects.toThrow("REACHED_THE_STORE");
    expect(reached.query).toBe(true);
  });

  test("the event carries the instant it was authorised, so `recordedAt` is a real date", () => {
    // The second half of P15-C4, and the reason the first half was not enough. `link()`
    // builds `recordedAt` as `new Date(source.recordedAtMs)`; with no instant that is
    // `new Date(undefined)` — an Invalid Date, which PostgreSQL refuses. So even once the
    // vocabulary admitted the event, it still could not be written.
    for (const action of [
      { type: "ENABLE", shardId: "s", requestedBy: "a", reason: "r", requestedAtMs: NOW },
      { type: "ROLLBACK", shardId: "s", requestedBy: null, automatic: true, reason: "r", requestedAtMs: NOW },
    ]) {
      const event = stage.auditEventFor(action);
      expect(Number.isFinite(event.recordedAtMs)).toBe(true);
      expect(Number.isNaN(new Date(event.recordedAtMs).getTime())).toBe(false);
      // The authorisation's clock, not the writer's: the two differ by however long the
      // publish took, and §21.7 records when the action was authorised.
      expect(event.recordedAtMs).toBe(NOW);
    }
  });

  test("an action with no instant is refused rather than stamped with the writer's clock", () => {
    // Refused, not defaulted to `Date.now()`. An audit event is a non-repudiation record;
    // a plausible number in place of a missing fact is the failure §21.7 exists to prevent.
    for (const requestedAtMs of [undefined, null, Number.NaN, "now"]) {
      expect(() =>
        stage.auditEventFor({ type: "ENABLE", shardId: "s", requestedBy: "a", reason: "r", requestedAtMs }),
      ).toThrow(/requestedAtMs/);
    }
  });

  test("an authorised action always carries what the audit event needs", () => {
    // The producer and the consumer, checked together: whatever `authoriseEnable` and
    // `authoriseRollback` emit must be writable, or the round trip breaks again one layer up.
    const enable = stage.authoriseEnable(enableRequest());
    expect(enable.authorised).toBe(true);
    expect(() => stage.auditEventFor(enable.action)).not.toThrow();

    const rollback = stage.authoriseRollback({
      shard: { shardId: "shard-1", regionId: "region-alpha" },
      reason: "guardrail breach",
      automatic: true,
      requestedAtMs: NOW,
    });
    expect(rollback.authorised).toBe(true);
    expect(() => stage.auditEventFor(rollback.action)).not.toThrow();
  });

  test("an unrecognised type is still refused — the vocabulary was widened, not removed", () => {
    const prisma = { auditEvent: { findFirst: async () => null } };
    return expect(
      auditStream.append({ prisma }, { streamId: "t", eventType: "CUTOVER_SHARD_MAYBE", subjectId: "s" }),
    ).rejects.toThrow(/not one of the audit stream's event types/);
  });
});

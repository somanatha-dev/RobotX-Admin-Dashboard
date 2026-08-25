"use strict";

/**
 * Engine lane — release-gate evidence, and the attacks it must refuse.
 *
 * ── The defect these tests pin ─────────────────────────────────────────────
 * `cutover/gates.js` shipped a table of twenty-three blocking gates and an `evaluate()`
 * that read `record.pass === true`. Nothing in the repository produced a record:
 * `req.app.locals.releaseEvidence` was read in two places and assigned in none, no evidence
 * file existed, and the only producers were test fixtures. So the release gate — the
 * mechanism the whole phase exists to install — was discharged by whatever object the caller
 * of `stage.authoriseEnable()` happened to hold.
 *
 * The attack that established it was six lines and it authorised a real cutover. It is the
 * first test below, and it must stay failing forever.
 *
 * Every test here plants a defect and asserts the mechanism catches it, in the style of the
 * gates lane: a gate that cannot fail is not a gate, and neither is an evidence rule that
 * cannot refuse.
 */

const evidence = require("../../src/engine/cutover/evidence");
const gates = require("../../src/engine/cutover/gates");
const guardrails = require("../../src/engine/cutover/guardrails");
const stage = require("../../src/engine/cutover/stage");
const killSwitches = require("../../src/engine/config/killSwitches");
const configService = require("../../src/engine/config/service");

const NOW = 1_800_000_000_000;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** The tree the run records below claim to have run against. */
const DIGEST = "a1b2c3d4".repeat(8);

/**
 * The authoritative parameter source, as `stage.authoriseEnable()` requires it (P15-F1).
 *
 * The **real** register, not a stub: the whole content of P15-F1 is that the observation
 * bound is the register's and not the caller's, so a fixture that hand-rolled its own
 * accessor would be the defect wearing the fix's clothes. What the two windowed gates
 * require here is therefore whatever `release.soak_duration` and
 * `cutover.shadow_agreement_window` say, and a test below pins that it is 72 h and 14 days.
 */
const REGISTER = configService.loadRegister({ reload: true });
const PARAMETER_VALUES = Object.freeze({
  get: (name) => (REGISTER.entries.get(name) || {}).default,
});

/** The *adjudicator's* context — `evidence.admit()` and `gates.evaluate()` still take the bound. */
const CONTEXT = Object.freeze({
  nowMs: NOW,
  maxAgeMs: 24 * HOUR,
  sourceDigest: DIGEST,
  minObservationMs: { shadow_agreement: 14 * DAY, soak: 72 * HOUR },
});

/**
 * The *authority's* request context. P15-F1 — `minObservationMs` is absent by contract and
 * `parameterValues` is present: `authoriseEnable` resolves the requirement itself.
 */
const REQUEST_CONTEXT = Object.freeze({
  requestedAtMs: NOW,
  evidenceMaxAgeMs: CONTEXT.maxAgeMs,
  sourceDigest: DIGEST,
  parameterValues: PARAMETER_VALUES,
});

const BUILD_GATE = gates.GATE_BY_ID.tier_dependencies;
const SUITE_GATE = gates.GATE_BY_ID.scale_targets;
const PRODUCTION_GATE = gates.GATE_BY_ID.shadow_agreement;
const ORGANISATIONAL_GATE = gates.GATE_BY_ID.rollback_rehearsed;
const RUNNABLE_ORGANISATIONAL_GATE = gates.GATE_BY_ID.calibration_safety_derived;

function runRecordFor(gate, overrides) {
  return {
    gateId: gate.id,
    producedAtMs: NOW - HOUR,
    producer: "tools/release/collectEvidence.js",
    run: { command: gate.command, exitCode: 0, startedAtMs: NOW - 2 * HOUR, finishedAtMs: NOW - HOUR },
    build: { sourceDigest: DIGEST },
    ...(overrides || {}),
  };
}

function productionRecordFor(gate, overrides) {
  return {
    gateId: gate.id,
    producedAtMs: NOW - HOUR,
    producer: "shadow worker",
    pass: true,
    owner: "SRE",
    observation: { windowStartedAtMs: NOW - 21 * DAY, windowEndedAtMs: NOW - HOUR, source: "staging fleet" },
    ...(overrides || {}),
  };
}

/** A rehearsal that actually happened: every runbook §5 step, in staging. */
const VALID_REHEARSAL = Object.freeze({
  environment: { id: "staging-eu-west", production: false },
  configVersion: "v2026.08.22-3",
  shardId: "staging-1",
  rehearsedAtMs: NOW - 2 * HOUR,
  automaticRollbackFired: true,
  steps: Object.freeze({
    cutover: true,
    automatic_rollback: true,
    no_decision_path_confirmed: true,
    artefact_rollback: true,
    recutover: true,
    recorded: true,
  }),
});

function organisationalRecordFor(gate, overrides) {
  const record = {
    gateId: gate.id,
    producedAtMs: NOW - HOUR,
    producer: "runbook rehearsal",
    pass: true,
    owner: "Safety",
    approval: { recordedBy: "operator-a", approvedBy: "operator-b" },
    ...(overrides || {}),
  };
  // D-7 — a rehearsal-flagged gate needs the rehearsal itself, so the helper supplies a
  // complete one for the same reason it supplies a corroborating run: this builds *admissible*
  // evidence, and a case that wants the record incomplete says so explicitly by passing
  // `rehearsal` in its overrides (including as null).
  if (gate.rehearsal === true && !("rehearsal" in (overrides || {}))) {
    record.rehearsal = VALID_REHEARSAL;
  }
  if (gate.runnable === true && !record.corroboratingRun) {
    record.corroboratingRun = {
      command: gate.command,
      exitCode: 0,
      startedAtMs: NOW - 2 * HOUR,
      finishedAtMs: NOW - HOUR,
      build: { sourceDigest: DIGEST },
    };
  }
  return record;
}

describe("THE ORIGINAL ATTACK — a hand-typed boolean must never close a gate", () => {
  test("`{ pass: true }` for every gate in the table authorises nothing", () => {
    // Verbatim the attack that worked before the remediation.
    const fabricated = {};
    for (const gate of gates.RELEASE_GATES) {
      fabricated[gate.id] = { pass: true, detail: "looks fine to me", source: "trust me" };
    }

    const evaluation = gates.evaluate(fabricated, CONTEXT);
    expect(evaluation.ok).toBe(false);
    expect(evaluation.counts.GREEN).toBe(0);
    expect(evaluation.counts.RED).toBe(gates.RELEASE_GATES.length);

    // And it is refused at the place that matters, not merely reported.
    const shard = { shardId: "s1", regionId: "r1", state: "ACTIVE", agentCount: 1 };
    const outcome = stage.authoriseEnable({
      shard,
      allShards: [shard],
      liveShardIds: [],
      releaseEvidence: fabricated,
      killSwitchState: killSwitches.defaultState(),
      declaration: guardrails.declare({
        shardId: "s1",
        declaredBy: "operator-a",
        declaredAtMs: NOW - HOUR,
        observationWindowSeconds: 3600,
        guardrails: [{ id: "round_wall_clock", direction: "AT_MOST", threshold: 100, minSamples: 500 }],
      }),
      requestedBy: "operator-a",
      approvedBy: "operator-b",
      reason: "ship it",
      ...REQUEST_CONTEXT,
    });

    expect(outcome.authorised).toBe(false);
    expect(outcome.refusal.code).toBe(stage.REFUSAL.RELEASE_GATE_NOT_GREEN);
  });

  test("an empty evidence set is NOT_EVALUATED, and NOT_EVALUATED blocks", () => {
    const evaluation = gates.evaluate({}, CONTEXT);
    expect(evaluation.counts.NOT_EVALUATED).toBe(gates.RELEASE_GATES.length);
    expect(evaluation.ok).toBe(false);
    // Distinct from RED, and blocking all the same. The distinction is what lets an incident
    // review tell "we ran it and it failed" from "nobody ran it".
    expect(gates.blockers({}, CONTEXT)).toHaveLength(gates.RELEASE_GATES.length);
  });
});

describe("BUILD and SUITE gates — a run record, or nothing", () => {
  test("a well-formed run record with a zero exit discharges the gate", () => {
    const verdict = evidence.admit(BUILD_GATE, runRecordFor(BUILD_GATE), CONTEXT);
    expect(verdict).toMatchObject({ admissible: true, pass: true });
  });

  test("a non-zero exit is RED however the record labels itself", () => {
    const record = runRecordFor(BUILD_GATE);
    record.run.exitCode = 1;
    const verdict = evidence.admit(BUILD_GATE, record, CONTEXT);
    expect(verdict).toMatchObject({ admissible: true, pass: false });
  });

  test("PLANTED — a record claiming pass over a failing exit code is refused outright", () => {
    // The forgery this rule exists for: a producer that reports success for a command that
    // failed. `pass` is derived from the exit code, never read, so the contradiction is
    // visible rather than believed.
    const record = runRecordFor(BUILD_GATE, { pass: true });
    record.run.exitCode = 2;
    expect(evidence.admit(BUILD_GATE, record, CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.PASS_CONTRADICTS_EXIT_CODE,
    });
  });

  test("PLANTED — evidence from a different command cannot discharge this gate", () => {
    const record = runRecordFor(SUITE_GATE);
    record.run.command = "npm run gate:tiers";
    expect(evidence.admit(SUITE_GATE, record, CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.COMMAND_MISMATCH,
    });
  });

  test("PLANTED — a record filed against the wrong gate is refused, not silently re-homed", () => {
    const record = runRecordFor(BUILD_GATE);
    expect(evidence.admit(SUITE_GATE, record, CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.GATE_ID_MISMATCH,
    });
  });

  test("PLANTED — an assertion with no run at all is refused", () => {
    expect(evidence.admit(BUILD_GATE, { gateId: BUILD_GATE.id, producedAtMs: NOW, producer: "me", pass: true }, CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.RUN_RECORD_REQUIRED,
    });
  });

  test("PLANTED — a run with no exit code is refused; the exit code is the unphrasable part", () => {
    const record = runRecordFor(BUILD_GATE);
    delete record.run.exitCode;
    expect(evidence.admit(BUILD_GATE, record, CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.EXIT_CODE_MISSING,
    });
  });

  test("PLANTED — a gate that passed on a different tree is refused (restore-the-file attack)", () => {
    // Satisfy the gate, collect the evidence, restore the offending file. Without the digest
    // binding, the record still reads green against the restored tree.
    const record = runRecordFor(BUILD_GATE, { build: { sourceDigest: "a".repeat(64) } });
    record.run.build = { sourceDigest: "a".repeat(64) };
    expect(evidence.admit(BUILD_GATE, record, { ...CONTEXT, sourceDigest: "b".repeat(64) })).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.SOURCE_DIGEST_MISMATCH,
    });
  });

  test("PLANTED — omitting the digest from the CONTEXT does not disable the binding", () => {
    /**
     * The fail-open this closes was in the first version of the fix, found by re-auditing it
     * rather than by a test. The check read `if (nonEmpty(at.sourceDigest)) { … }`, so a
     * caller who simply left the field out got no binding and any run record was admitted.
     * `stage.authoriseEnable()` passes the field straight through from its request, which
     * made the omission reachable at the one call site whose whole job is to be the
     * authority. Judging a run record without knowing which tree is not a weaker check.
     */
    const record = runRecordFor(BUILD_GATE);
    expect(evidence.admit(BUILD_GATE, record, { nowMs: NOW, maxAgeMs: 24 * HOUR })).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.SOURCE_DIGEST_REQUIRED,
    });

    // Same rule for an organisational gate's corroborating run.
    const attestation = organisationalRecordFor(RUNNABLE_ORGANISATIONAL_GATE);
    expect(
      evidence.admit(RUNNABLE_ORGANISATIONAL_GATE, attestation, { nowMs: NOW, maxAgeMs: 24 * HOUR }),
    ).toMatchObject({ admissible: false, code: evidence.INADMISSIBLE.SOURCE_DIGEST_REQUIRED });
  });

  test("PLANTED — a run record carrying no digest at all is refused when a tree is being assessed", () => {
    expect(evidence.admit(BUILD_GATE, runRecordFor(BUILD_GATE), { ...CONTEXT, sourceDigest: "c".repeat(64) })).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.SOURCE_DIGEST_MISMATCH,
    });
  });

  test("PLANTED — stale evidence is refused, and evidence from the future more so", () => {
    expect(
      evidence.admit(BUILD_GATE, runRecordFor(BUILD_GATE, { producedAtMs: NOW - 40 * DAY }), CONTEXT),
    ).toMatchObject({ admissible: false, code: evidence.INADMISSIBLE.STALE });

    expect(
      evidence.admit(BUILD_GATE, runRecordFor(BUILD_GATE, { producedAtMs: NOW + HOUR }), CONTEXT),
    ).toMatchObject({ admissible: false, code: evidence.INADMISSIBLE.PRODUCED_IN_THE_FUTURE });
  });

  test("PLANTED — an anonymous or undated record is refused", () => {
    expect(evidence.admit(BUILD_GATE, runRecordFor(BUILD_GATE, { producer: "" }), CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.SELF_ASSERTED,
    });
    expect(evidence.admit(BUILD_GATE, runRecordFor(BUILD_GATE, { producedAtMs: undefined }), CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.SELF_ASSERTED,
    });
  });
});

describe("PRODUCTION gates — a build may not close one, by construction", () => {
  test("a real observation window over a real duration discharges the gate", () => {
    expect(evidence.admit(PRODUCTION_GATE, productionRecordFor(PRODUCTION_GATE), CONTEXT)).toMatchObject({
      admissible: true,
      pass: true,
    });
  });

  test("PLANTED — a run record cannot discharge a PRODUCTION gate", () => {
    // The one thing the evidence taxonomy exists to prevent: CI closing a gate that requires
    // the fleet to have operated.
    const record = productionRecordFor(PRODUCTION_GATE);
    record.run = { command: PRODUCTION_GATE.command, exitCode: 0 };
    expect(evidence.admit(PRODUCTION_GATE, record, CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.BUILD_CANNOT_CLOSE,
    });
  });

  test("PLANTED — a fourteen-day claim over four minutes of traffic is refused by arithmetic", () => {
    const record = productionRecordFor(PRODUCTION_GATE, {
      observation: { windowStartedAtMs: NOW - 4 * 60 * 1000, windowEndedAtMs: NOW, source: "staging fleet" },
    });
    expect(evidence.admit(PRODUCTION_GATE, record, CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.OBSERVATION_WINDOW_TOO_SHORT,
    });
  });

  test("PLANTED — a soak shorter than release.soak_duration is refused", () => {
    const soak = gates.GATE_BY_ID.soak;
    const record = productionRecordFor(soak, {
      observation: { windowStartedAtMs: NOW - 8 * HOUR, windowEndedAtMs: NOW, source: "soak rig" },
    });
    expect(evidence.admit(soak, record, CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.OBSERVATION_WINDOW_TOO_SHORT,
    });
  });

  test("PLANTED — a missing duration bound refuses the gate rather than unbounding it", () => {
    // If `release.soak_duration` vanished from the register, the soak gate must go red, not
    // become satisfiable by any window at all.
    const soak = gates.GATE_BY_ID.soak;
    const record = productionRecordFor(soak, {
      observation: { windowStartedAtMs: NOW - 1000, windowEndedAtMs: NOW, source: "soak rig" },
    });
    expect(evidence.admit(soak, record, { nowMs: NOW, maxAgeMs: 24 * HOUR, minObservationMs: {} })).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.OBSERVATION_WINDOW_REQUIRED,
    });
  });

  test("PLANTED — an unowned production record is refused", () => {
    expect(evidence.admit(PRODUCTION_GATE, productionRecordFor(PRODUCTION_GATE, { owner: "" }), CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.OWNER_REQUIRED,
    });
  });

  test("PLANTED — an inverted window is refused", () => {
    const record = productionRecordFor(PRODUCTION_GATE, {
      observation: { windowStartedAtMs: NOW, windowEndedAtMs: NOW - DAY, source: "staging fleet" },
    });
    expect(evidence.admit(PRODUCTION_GATE, record, CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.OBSERVATION_WINDOW_TOO_SHORT,
    });
  });
});

describe("ORGANISATIONAL gates — two people, and where checkable, the check", () => {
  test("a recorded and separately approved act discharges the gate", () => {
    expect(evidence.admit(ORGANISATIONAL_GATE, organisationalRecordFor(ORGANISATIONAL_GATE), CONTEXT)).toMatchObject({
      admissible: true,
      pass: true,
    });
  });

  test("PLANTED — one person cannot attest to their own work", () => {
    const record = organisationalRecordFor(ORGANISATIONAL_GATE, {
      approval: { recordedBy: "operator-a", approvedBy: "operator-a" },
    });
    expect(evidence.admit(ORGANISATIONAL_GATE, record, CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.APPROVER_NOT_DISTINCT,
    });
  });

  test("PLANTED — an unapproved attestation is refused", () => {
    const record = organisationalRecordFor(ORGANISATIONAL_GATE, { approval: { recordedBy: "operator-a" } });
    expect(evidence.admit(ORGANISATIONAL_GATE, record, CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.APPROVER_REQUIRED,
    });
  });

  test("PLANTED — an attestation cannot outrank the check it is about", () => {
    // Two signatures saying every Safety-class parameter is DERIVED, while
    // `npm run gate:calibration` exits 1. §22.4 predicts exactly this pressure.
    const record = organisationalRecordFor(RUNNABLE_ORGANISATIONAL_GATE, {
      corroboratingRun: {
        command: RUNNABLE_ORGANISATIONAL_GATE.command,
        exitCode: 1,
        startedAtMs: NOW - 2 * HOUR,
        finishedAtMs: NOW - HOUR,
      },
    });
    expect(evidence.admit(RUNNABLE_ORGANISATIONAL_GATE, record, CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.PASS_CONTRADICTS_EXIT_CODE,
    });
  });

  test("PLANTED — a runnable organisational gate with no corroborating run is refused", () => {
    const record = organisationalRecordFor(RUNNABLE_ORGANISATIONAL_GATE);
    delete record.corroboratingRun;
    expect(evidence.admit(RUNNABLE_ORGANISATIONAL_GATE, record, CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.RUN_RECORD_REQUIRED,
    });
  });

  test("the calibration gate is exactly this shape today, and today it is RED", () => {
    // Not a hypothetical. 39 Safety-class parameters are PROVISIONAL or UNCALIBRATED, so no
    // admissible record for this gate can exist until they are derived.
    const { checkCalibration } = require("../../tools/gates/checkCalibration");
    const result = checkCalibration();
    expect(result.ok).toBe(false);
    expect(result.blocking.length).toBeGreaterThan(0);
  });
});

describe("D-7 / ADR-34 — the bootstrap circularity, and the purpose that resolves it", () => {
  /**
   * ── The circularity, still demonstrated ────────────────────────────────────
   * `rollback_rehearsed` is discharged by rehearsing the rollback. `docs/runbooks/rollback.md`
   * §5 step 1 states what a discharging rehearsal must begin with:
   *
   * > Take a **staging** shard live through the full §3 of `cutover.md`, including the
   * > pre-declaration.
   *
   * Taking any shard live goes through `stage.authoriseEnable()`, which refuses while any
   * blocking gate is not GREEN — and `rollback_rehearsed` is a blocking gate. So the
   * rehearsal requires a cutover, and the cutover requires the rehearsal.
   *
   * ── What ADR-34 changed, and what it deliberately did not ──────────────────
   * The gate is **not** weakened, made non-blocking, or waivable — `gates.js` still has no
   * `WAIVED` status, for the reason it gives. What changed is that `authoriseEnable()` had
   * been answering one question for two different acts: a production cutover and a
   * *rehearsal*, which exists to produce the very evidence the gate is about. "You may not
   * take a shard live until the rollback has been rehearsed" is right for the first and
   * circular for the second.
   *
   * So the act now names its purpose. `PRODUCTION` is the default and is unchanged — the
   * first test below is the original pin, and it still refuses by exactly this gate.
   * `REHEARSAL` excludes exactly the one gate it produces, and only against a declared
   * non-production environment.
   */
  test("PRODUCTION is unchanged: every other gate green, and the cutover is still refused", () => {
    const evidenceSet = {};
    for (const gate of gates.RELEASE_GATES) {
      if (gate.id === "rollback_rehearsed") continue; // the gate the rehearsal would discharge
      if (gate.evidence === gates.EVIDENCE.BUILD || gate.evidence === gates.EVIDENCE.SUITE) {
        evidenceSet[gate.id] = runRecordFor(gate);
      } else if (gate.evidence === gates.EVIDENCE.PRODUCTION) {
        evidenceSet[gate.id] = productionRecordFor(gate);
      } else {
        evidenceSet[gate.id] = organisationalRecordFor(gate);
      }
    }

    const shard = { shardId: "staging-1", regionId: "staging", state: "ACTIVE", agentCount: 1 };
    const outcome = stage.authoriseEnable({
      shard,
      allShards: [shard],
      liveShardIds: [],
      releaseEvidence: evidenceSet,
      killSwitchState: killSwitches.defaultState(),
      declaration: guardrails.declare({
        shardId: "staging-1",
        declaredBy: "operator-a",
        declaredAtMs: NOW - HOUR,
        observationWindowSeconds: 3600,
        guardrails: [{ id: "round_wall_clock", direction: "AT_MOST", threshold: 100, minSamples: 500 }],
      }),
      requestedBy: "operator-a",
      approvedBy: "operator-b",
      reason: "rehearsal step 1: take a staging shard live",
      ...REQUEST_CONTEXT,
    });

    expect(outcome.authorised).toBe(false);
    // Refused by exactly one gate, and it is the one the rehearsal exists to discharge.
    expect(outcome.refusal.detail.map((row) => row.id)).toEqual(["rollback_rehearsed"]);
    expect(outcome.refusal.detail[0].status).toBe(gates.STATUS.NOT_EVALUATED);
  });

  /* ── The resolution ─────────────────────────────────────────────────────── */

  /** Every gate but `rollback_rehearsed`, discharged by admissible evidence. */
  function everythingButTheRehearsalGate() {
    const evidenceSet = {};
    for (const gate of gates.RELEASE_GATES) {
      if (gate.id === "rollback_rehearsed") continue;
      if (gate.evidence === gates.EVIDENCE.BUILD || gate.evidence === gates.EVIDENCE.SUITE) {
        evidenceSet[gate.id] = runRecordFor(gate);
      } else if (gate.evidence === gates.EVIDENCE.PRODUCTION) {
        evidenceSet[gate.id] = productionRecordFor(gate);
      } else {
        evidenceSet[gate.id] = organisationalRecordFor(gate);
      }
    }
    return evidenceSet;
  }

  /** A staging cutover request, minus whatever the case under test is varying. */
  function rehearsalRequest(overrides) {
    const shard = { shardId: "staging-1", regionId: "staging", state: "ACTIVE", agentCount: 1 };
    return {
      shard,
      allShards: [shard],
      liveShardIds: [],
      releaseEvidence: everythingButTheRehearsalGate(),
      killSwitchState: killSwitches.defaultState(),
      declaration: guardrails.declare({
        shardId: "staging-1",
        declaredBy: "operator-a",
        declaredAtMs: NOW - HOUR,
        observationWindowSeconds: 3600,
        guardrails: [{ id: "round_wall_clock", direction: "AT_MOST", threshold: 100, minSamples: 500 }],
      }),
      requestedBy: "operator-a",
      approvedBy: "operator-b",
      reason: "rehearsal step 1: take a staging shard live",
      ...REQUEST_CONTEXT,
      purpose: stage.PURPOSE.REHEARSAL,
      environment: { id: "staging-eu-west", production: false },
      ...(overrides || {}),
    };
  }

  test("REGRESSION — a REHEARSAL against a declared non-production environment is authorised", () => {
    const outcome = stage.authoriseEnable(rehearsalRequest());

    expect(outcome.authorised).toBe(true);
    expect(outcome.action.purpose).toBe(stage.PURPOSE.REHEARSAL);
    expect(outcome.action.environment).toEqual({ id: "staging-eu-west", production: false });
    // The exclusion is recorded on the action with the status it had, so an audit reads
    // "this gate was set aside and here is what it said" rather than never seeing the row.
    expect(outcome.action.gatesSetAside).toEqual([
      { id: "rollback_rehearsed", status: gates.STATUS.NOT_EVALUATED },
    ]);
  });

  test("the exclusion set is exactly one gate, and it is the one the rehearsal produces", () => {
    // A widened exclusion set would need its own ADR. Asserted as data so widening it is a
    // failing test rather than an extra clause nobody reviews.
    expect(stage.REHEARSAL_EXCLUDED_GATES).toEqual(["rollback_rehearsed"]);
  });

  test("a production cutover never sets a gate aside, whatever else is true of it", () => {
    // `gatesSetAside` is empty for PRODUCTION by construction, so a non-empty list is proof
    // of a rehearsal rather than a label claiming to be one.
    const outcome = stage.authoriseEnable(
      rehearsalRequest({
        purpose: stage.PURPOSE.PRODUCTION,
        environment: null,
        releaseEvidence: {
          ...everythingButTheRehearsalGate(),
          rollback_rehearsed: organisationalRecordFor(gates.GATE_BY_ID.rollback_rehearsed, {
            rehearsal: VALID_REHEARSAL,
          }),
        },
      }),
    );
    expect(outcome.authorised).toBe(true);
    expect(outcome.action.purpose).toBe(stage.PURPOSE.PRODUCTION);
    expect(outcome.action.gatesSetAside).toEqual([]);
    expect(outcome.action.environment).toBeNull();
  });

  /* ── §11 — attacking the rehearsal ───────────────────────────────────────── */

  test("PLANTED: a rehearsal that declares no environment is refused", () => {
    expect(stage.authoriseEnable(rehearsalRequest({ environment: null }))).toMatchObject({
      authorised: false,
      refusal: { code: stage.REFUSAL.REHEARSAL_REQUIRES_NON_PRODUCTION },
    });
  });

  test("PLANTED: a 'rehearsal' in production is a production cutover with a label on it", () => {
    // The attack the whole purpose mechanism has to survive: claim REHEARSAL, run it
    // against production, and collect the gate exclusion.
    expect(
      stage.authoriseEnable(rehearsalRequest({ environment: { id: "prod-eu", production: true } })),
    ).toMatchObject({
      authorised: false,
      refusal: { code: stage.REFUSAL.REHEARSAL_REQUIRES_NON_PRODUCTION },
    });
    // An environment that merely omits the flag is refused too: the declaration is explicit
    // or it is absent, and `production: undefined` is absent.
    expect(stage.authoriseEnable(rehearsalRequest({ environment: { id: "prod-eu" } })).authorised).toBe(false);
  });

  test("PLANTED: an unrecognised purpose is refused rather than defaulted to production", () => {
    // A typo must not silently become an authorisation, and — more to the point — an
    // invented purpose must not inherit the smaller gate set.
    for (const purpose of ["WAIVED", "REHEARSE", "rehearsal"]) {
      const outcome = stage.authoriseEnable(rehearsalRequest({ purpose }));
      expect({ purpose, authorised: outcome.authorised }).toEqual({ purpose, authorised: false });
      expect({ purpose, code: outcome.refusal.code }).toEqual({ purpose, code: stage.REFUSAL.UNKNOWN_PURPOSE });
    }
  });

  test("PLANTED: a rehearsal does not excuse any other gate", () => {
    // Drop one unrelated gate's evidence. The rehearsal purpose must not carry it.
    const evidenceSet = everythingButTheRehearsalGate();
    delete evidenceSet.chaos_capacity_2;

    const outcome = stage.authoriseEnable(rehearsalRequest({ releaseEvidence: evidenceSet }));
    expect(outcome.authorised).toBe(false);
    expect(outcome.refusal.detail.map((row) => row.id)).toEqual(["chaos_capacity_2"]);
  });

  test("PLANTED: a rehearsal does not excuse the ship state, the second approver, or the guardrails", () => {
    // Each of the other four refusals, still refusing under REHEARSAL.
    expect(
      stage.authoriseEnable(rehearsalRequest({ killSwitchState: { opportunity_cost_term: false } })).refusal.code,
    ).toBe(stage.REFUSAL.TIER_TWO_NOT_AT_SHIP_STATE);

    expect(stage.authoriseEnable(rehearsalRequest({ approvedBy: "operator-a" })).refusal.code).toBe(
      stage.REFUSAL.NO_SECOND_APPROVER,
    );

    expect(stage.authoriseEnable(rehearsalRequest({ automated: true })).refusal.code).toBe(
      stage.REFUSAL.NO_SECOND_APPROVER,
    );

    expect(stage.authoriseEnable(rehearsalRequest({ declaration: null })).refusal.code).toBe(
      stage.REFUSAL.GUARDRAILS_NOT_DECLARED,
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   D-7 / ADR-34 — the rehearsal's own evidence must be checkable
   ═══════════════════════════════════════════════════════════════════════════ */


describe("the rehearsal record — making the rehearsal performable did not make it forgeable", () => {
  const REHEARSAL_GATE = gates.GATE_BY_ID.rollback_rehearsed;

  test("the gate declares itself discharged by a rehearsal", () => {
    expect(REHEARSAL_GATE.rehearsal).toBe(true);
    expect(REHEARSAL_GATE.blocking).toBe(true);
    expect(REHEARSAL_GATE.evidence).toBe(gates.EVIDENCE.ORGANISATIONAL);
  });

  test("a complete rehearsal record, with two signatures, discharges it", () => {
    expect(
      evidence.admit(REHEARSAL_GATE, organisationalRecordFor(REHEARSAL_GATE, { rehearsal: VALID_REHEARSAL }), CONTEXT),
    ).toMatchObject({ admissible: true, pass: true });
  });

  test("PLANTED: two signatures and no rehearsal — the forgery the runbook names", () => {
    // "Do not resolve this by filing an attestation for a rehearsal that has not happened."
    // Before this remediation that record was admissible, because ORGANISATIONAL asked only
    // for a recorder and a distinct approver.
    const bare = organisationalRecordFor(REHEARSAL_GATE, { rehearsal: null });
    expect(evidence.admit(REHEARSAL_GATE, bare, CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.REHEARSAL_RECORD_REQUIRED,
    });
  });

  test("PLANTED: a rehearsal claiming a production environment", () => {
    const record = organisationalRecordFor(REHEARSAL_GATE, {
      rehearsal: { ...VALID_REHEARSAL, environment: { id: "prod-eu", production: true } },
    });
    expect(evidence.admit(REHEARSAL_GATE, record, CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.REHEARSAL_NOT_IN_A_REHEARSAL_ENVIRONMENT,
    });
  });

  test("PLANTED: a rehearsal whose environment is unnamed", () => {
    const record = organisationalRecordFor(REHEARSAL_GATE, {
      rehearsal: { ...VALID_REHEARSAL, environment: { production: false } },
    });
    expect(evidence.admit(REHEARSAL_GATE, record, CONTEXT).code).toBe(
      evidence.INADMISSIBLE.REHEARSAL_NOT_IN_A_REHEARSAL_ENVIRONMENT,
    );
  });

  test("PLANTED: a rehearsal that does not say which configuration it exercised", () => {
    const record = organisationalRecordFor(REHEARSAL_GATE, {
      rehearsal: { ...VALID_REHEARSAL, configVersion: "" },
    });
    expect(evidence.admit(REHEARSAL_GATE, record, CONTEXT).code).toBe(
      evidence.INADMISSIBLE.REHEARSAL_CONFIGURATION_UNIDENTIFIED,
    );
  });

  test("PLANTED: each missing step is refused, and named — including the one §22.5 predicts", () => {
    for (const step of evidence.REHEARSAL_STEPS) {
      const steps = { ...VALID_REHEARSAL.steps, [step]: false };
      const record = organisationalRecordFor(REHEARSAL_GATE, { rehearsal: { ...VALID_REHEARSAL, steps } });
      const verdict = evidence.admit(REHEARSAL_GATE, record, CONTEXT);
      expect({ step, code: verdict.code }).toEqual({ step, code: evidence.INADMISSIBLE.REHEARSAL_INCOMPLETE });
      // The refusal names the step, so "five of six" is never an acceptable summary.
      expect(verdict.detail).toContain(step);
    }
  });

  test("PLANTED: an omitted step is the same finding as a step reported false", () => {
    const steps = { ...VALID_REHEARSAL.steps };
    delete steps.artefact_rollback;
    const record = organisationalRecordFor(REHEARSAL_GATE, { rehearsal: { ...VALID_REHEARSAL, steps } });
    expect(evidence.admit(REHEARSAL_GATE, record, CONTEXT).code).toBe(evidence.INADMISSIBLE.REHEARSAL_INCOMPLETE);
  });

  test("PLANTED: a rollback triggered by calling the API rather than by the controller", () => {
    // The runbook is explicit: "What is under test is the controller, not the API."
    const record = organisationalRecordFor(REHEARSAL_GATE, {
      rehearsal: { ...VALID_REHEARSAL, automaticRollbackFired: false },
    });
    expect(evidence.admit(REHEARSAL_GATE, record, CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.REHEARSAL_NOT_AUTOMATIC,
    });
  });

  test("PLANTED: a rehearsal recorded and approved by the same person", () => {
    const record = organisationalRecordFor(REHEARSAL_GATE, {
      rehearsal: VALID_REHEARSAL,
      approval: { recordedBy: "operator-a", approvedBy: "operator-a" },
    });
    expect(evidence.admit(REHEARSAL_GATE, record, CONTEXT).code).toBe(
      evidence.INADMISSIBLE.APPROVER_NOT_DISTINCT,
    );
  });

  test("PLANTED: a stale rehearsal is not a rehearsal of the system being shipped", () => {
    // The generic ageing rule applies to the rehearsal record like any other, so a rehearsal
    // cannot be filed once and cited forever.
    const record = organisationalRecordFor(REHEARSAL_GATE, {
      rehearsal: VALID_REHEARSAL,
      producedAtMs: NOW - 30 * DAY,
    });
    expect(evidence.admit(REHEARSAL_GATE, record, CONTEXT)).toMatchObject({
      admissible: false,
      code: evidence.INADMISSIBLE.STALE,
    });
  });

  test("PLANTED: a rehearsal record filed against a different gate", () => {
    const record = organisationalRecordFor(REHEARSAL_GATE, { rehearsal: VALID_REHEARSAL, gateId: "soak" });
    expect(evidence.admit(REHEARSAL_GATE, record, CONTEXT).code).toBe(evidence.INADMISSIBLE.GATE_ID_MISMATCH);
  });

  test("PLANTED: a truthy value is not a rehearsal record", () => {
    for (const value of [true, "yes", 1]) {
      const record = organisationalRecordFor(REHEARSAL_GATE, { rehearsal: value });
      const verdict = evidence.admit(REHEARSAL_GATE, record, CONTEXT);
      expect({ value: String(value), admissible: verdict.admissible }).toEqual({
        value: String(value),
        admissible: false,
      });
    }
  });
});

describe("the producer — a collection whose tree moved is void", () => {
  /**
   * Found by running the real thing: a full collection takes ~25 minutes, and files edited
   * during that window produced records claiming a tree state the later gates never ran
   * against. The verdict refused all seventeen with `SOURCE_DIGEST_MISMATCH` — the right
   * outcome, reached for a reason an operator could not distinguish from a stale artefact.
   */
  test("PLANTED — a tree that changes mid-collection voids every record", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const collector = require("../../tools/release/collectEvidence");

    // A throwaway tree the runner mutates while "running" the gates.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "robotx-collect-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "tools"), { recursive: true });
    fs.mkdirSync(path.join(root, "tests"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.js"), "module.exports = 1;\n");

    let runs = 0;
    const collected = collector.collect({
      only: "build",
      cwd: root,
      runner: (command) => {
        // Somebody commits between gate one and gate two.
        if (++runs === 1) fs.writeFileSync(path.join(root, "src", "a.js"), "module.exports = 2;\n");
        return { command, exitCode: 0, startedAtMs: 1, finishedAtMs: 2, tail: "" };
      },
    });

    expect(collected.treeStable).toBe(false);
    expect(collected.ok).toBe(false);
    expect(collected.sourceDigestBefore).not.toBe(collected.sourceDigestAfter);

    // And the stamped records are unusable against any tree, not merely against this one.
    const record = collected.evidence.tier_dependencies;
    expect(record.build.sourceDigest).toMatch(/^VOID:tree-changed-during-collection:/);
    expect(
      evidence.admit(gates.GATE_BY_ID.tier_dependencies, record, {
        nowMs: record.producedAtMs + 1,
        maxAgeMs: 24 * HOUR,
        sourceDigest: collected.sourceDigestAfter,
      }),
    ).toMatchObject({ admissible: false, code: evidence.INADMISSIBLE.SOURCE_DIGEST_MISMATCH });
  });

  test("a stable tree produces records that bind to it", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const collector = require("../../tools/release/collectEvidence");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "robotx-collect-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.js"), "module.exports = 1;\n");

    const collected = collector.collect({
      only: "build",
      cwd: root,
      runner: (command) => ({ command, exitCode: 0, startedAtMs: 1, finishedAtMs: 2, tail: "" }),
    });

    expect(collected.treeStable).toBe(true);
    expect(collected.ok).toBe(true);

    const record = collected.evidence.tier_dependencies;
    expect(
      evidence.admit(gates.GATE_BY_ID.tier_dependencies, record, {
        nowMs: record.producedAtMs + 1,
        maxAgeMs: 24 * HOUR,
        sourceDigest: collected.sourceDigest,
      }),
    ).toMatchObject({ admissible: true, pass: true });
  });

  test("the producer emits no PRODUCTION or ORGANISATIONAL evidence, ever", () => {
    const collector = require("../../tools/release/collectEvidence");
    const collected = collector.collect({
      only: "all",
      runner: (command) => ({ command, exitCode: 0, startedAtMs: 1, finishedAtMs: 2, tail: "" }),
    });

    for (const gateId of Object.keys(collected.evidence)) {
      const gate = gates.GATE_BY_ID[gateId];
      expect({ gateId, kind: gate.evidence }).toEqual(
        expect.objectContaining({ kind: expect.stringMatching(/^(BUILD|SUITE)$/) }),
      );
    }
    // The two runnable organisational gates appear only as corroboration.
    expect(Object.keys(collected.corroboration).sort()).toEqual([
      "calibration_safety_derived",
      "safety_case_assembled",
    ]);
  });
});

describe("the table itself", () => {
  test("every gate is blocking, and every one is adjudicated by a known kind", () => {
    for (const gate of gates.RELEASE_GATES) {
      expect(gate.blocking).toBe(true);
      expect(Object.values(evidence.KINDS)).toContain(gate.evidence);
    }
  });

  test("the evidence kinds cannot drift from the admission rules", () => {
    expect(Object.keys(gates.EVIDENCE).sort()).toEqual(Object.keys(evidence.KINDS).sort());
    expect(gates.assertGates()).toBe(true);
  });

  test("evidence filed against a gate that does not exist is counted, not ignored", () => {
    const evaluation = gates.evaluate({ no_such_gate: { pass: true } }, CONTEXT);
    expect(evaluation.unknownEvidence).toEqual(["no_such_gate"]);
    expect(evaluation.ok).toBe(false);
  });

  test("the duration bounds come from the register, not from a constant in the module", () => {
    const service = require("../../src/engine/config/service");
    const register = service.loadRegister({ reload: true });
    const values = { get: (name) => (register.entries.get(name) || {}).default };
    const resolved = evidence.resolveMinObservationMs(values);

    expect(resolved.shadow_agreement).toBe(register.entries.get("cutover.shadow_agreement_window").default * DAY);
    expect(resolved.soak).toBe(register.entries.get("release.soak_duration").default * HOUR);

    // A register that cannot answer yields no bound, which reddens the gate.
    expect(evidence.resolveMinObservationMs({ get: () => undefined })).toEqual({});
  });
});

describe("a GREEN that is not a proof — model_check_capacity_1_2_3 (blocker B-M)", () => {
  /**
   * PHASE 15, pass 3 verification. The gate's statement is that the commitment protocol
   * and the lifecycle are model-checked **exhaustively** at capacity 1, 2 and 3. Its
   * evidence is the exit code of `npm run test:engine -- ModelCheck`, and that lane
   * exits 0 — so the gate reads GREEN.
   *
   * After P15-E5 corrected `lifecycleModel.check()`, the very suite that produces the
   * exit code asserts `exhaustive: false` for the lifecycle at all three shipped
   * capacities. The gate is therefore GREEN on a run that proves its central claim
   * false. These tests pin the annotation that says so; without them the most
   * misleading row in the release table is also its most reassuring one.
   */
  const MODEL_CHECK = "model_check_capacity_1_2_3";
  const runRecord = (gateId, command, exitCode) => ({
    gateId,
    producedAtMs: NOW - 1000,
    producer: "tools/release/collectEvidence.js",
    build: { sourceDigest: DIGEST, fileCount: 1 },
    run: {
      command,
      exitCode,
      startedAtMs: NOW - 5000,
      finishedAtMs: NOW - 1000,
      build: { sourceDigest: DIGEST, fileCount: 1 },
    },
  });
  const rowFor = (gateId, evidenceTable) =>
    gates.evaluate(evidenceTable, CONTEXT).results.find((row) => row.id === gateId);

  test("the gate declares that its command does not establish its statement", () => {
    expect(gates.GATE_BY_ID[MODEL_CHECK].establishedByCommand).toBe(false);
    expect(typeof gates.GATE_BY_ID[MODEL_CHECK].notEstablishedReason).toBe("string");
  });

  test("a passing run is GREEN but is annotated NOT PROVEN", () => {
    const row = rowFor(MODEL_CHECK, {
      [MODEL_CHECK]: runRecord(MODEL_CHECK, "npm run test:engine -- ModelCheck", 0),
    });
    expect(row.status).toBe(gates.STATUS.GREEN);
    expect(row.notEstablished).toEqual(expect.stringContaining("exhaustive"));
  });

  test("the annotation never converts a refusal — a failing run is still RED", () => {
    const row = rowFor(MODEL_CHECK, {
      [MODEL_CHECK]: runRecord(MODEL_CHECK, "npm run test:engine -- ModelCheck", 1),
    });
    expect(row.status).toBe(gates.STATUS.RED);
    expect(row.notEstablished).toBeNull();
  });

  test("no other gate carries the annotation, so it cannot be read as decoration", () => {
    const annotated = gates.RELEASE_GATES.filter((gate) => gate.establishedByCommand === false).map((gate) => gate.id);
    expect(annotated).toEqual([MODEL_CHECK]);

    const control = rowFor("determinism_replay", {
      determinism_replay: runRecord("determinism_replay", "npm run test:engine -- determinism", 0),
    });
    expect(control.status).toBe(gates.STATUS.GREEN);
    expect(control.notEstablished).toBeNull();
  });

  test("the discharging suite asserts the negation of the gate's statement", () => {
    // The reason the annotation exists, pinned against the checker itself rather than
    // against a document: a search that is depth-truncated is not an exhaustive one.
    const lifecycle = require("./helpers/lifecycleModel");
    const result = lifecycle.check({ capacity: 1, legs: 2, depth: 12 });
    expect(result.exhaustive).toBe(false);
    expect(result.depthTruncated).toBe(true);
    expect(gates.GATE_BY_ID[MODEL_CHECK].statement).toEqual(expect.stringContaining("exhaustively"));
  });
});

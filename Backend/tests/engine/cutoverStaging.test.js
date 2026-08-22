"use strict";

/**
 * Engine lane — the per-shard cutover: the switch, the release gates, the staging order,
 * and the five refusals.
 *
 * The module under test is the one that decides whether the engine becomes the fleet's
 * decision path. Everything asserted below is a *refusal*, because that is what the module
 * is for: the enabling half is a config binding anyone could write, and the value of
 * `stage.authoriseEnable` is entirely in what it declines to authorise.
 */

const service = require("../../src/engine/config/service");
const enabled = require("../../src/engine/cutover/enabled");
const gates = require("../../src/engine/cutover/gates");
const guardrails = require("../../src/engine/cutover/guardrails");
const stage = require("../../src/engine/cutover/stage");
const killSwitches = require("../../src/engine/config/killSwitches");

const NOW = 1_800_000_000_000;

/**
 * Every blocking gate green — the only evidence set that lets an enable through.
 *
 * ── PHASE 15 REMEDIATION — this fixture used to be the whole attack ────────
 * It read, in full:
 *
 *     evidence[gate.id] = { pass: true, detail: "test fixture", source: "cutoverStaging.test.js" };
 *
 * and it worked, because `gates.evaluate()` read `record.pass === true` and asked nothing
 * else. The same six lines typed by an operator authorised a real cutover: twenty-three
 * blocking gates closed by twenty-three hand-written booleans, no run behind any of them.
 * The fixture was not wrong about the module; the module was wrong.
 *
 * It now builds records `cutover/evidence.js` will actually admit — a run record with a
 * matching command and a zero exit for each `BUILD`/`SUITE` gate, an observation window for
 * each `PRODUCTION` gate, two distinct signatures for each `ORGANISATIONAL` one. That makes
 * this helper considerably more annoying to write, which is the point: the cost of
 * constructing admissible evidence is the cost the mechanism is supposed to impose.
 */
/** The tree the run records below claim to have run against. */
const DIGEST = "f1e2d3c4".repeat(8);

function admissibleEvidenceFor(gate, options) {
  const at = (options && options.producedAtMs) || NOW - 60_000;
  const base = { gateId: gate.id, producedAtMs: at, producer: "cutoverStaging.test.js" };

  if (gate.evidence === gates.EVIDENCE.BUILD || gate.evidence === gates.EVIDENCE.SUITE) {
    return {
      ...base,
      run: { command: gate.command, exitCode: 0, startedAtMs: at - 1000, finishedAtMs: at },
      build: { sourceDigest: DIGEST },
    };
  }

  if (gate.evidence === gates.EVIDENCE.PRODUCTION) {
    // Long enough to satisfy the longest declared window (`shadow_agreement`, 14 days).
    return {
      ...base,
      pass: true,
      owner: "SRE",
      observation: {
        windowStartedAtMs: at - 21 * 24 * 3600 * 1000,
        windowEndedAtMs: at,
        source: "staging fleet",
      },
    };
  }

  const record = {
    ...base,
    pass: true,
    owner: "Safety",
    approval: { recordedBy: "operator-a", approvedBy: "operator-b" },
  };
  // D-7 / ADR-34 — a rehearsal-flagged gate is discharged by the rehearsal itself, so
  // `allGreen()` must build one. Strictly more work than the two signatures it used to
  // supply, which is the same direction the D-3 remediation took this helper: evidence a
  // test can type in one line is evidence the contract is not asking enough of.
  if (gate.rehearsal === true) {
    record.rehearsal = {
      environment: { id: "staging-eu-west", production: false },
      configVersion: "v2026.08.22-3",
      shardId: "staging-1",
      rehearsedAtMs: at - 2 * 3600 * 1000,
      automaticRollbackFired: true,
      steps: {
        cutover: true,
        automatic_rollback: true,
        no_decision_path_confirmed: true,
        artefact_rollback: true,
        recutover: true,
        recorded: true,
      },
    };
  }
  if (gate.runnable === true) {
    record.corroboratingRun = {
      command: gate.command,
      exitCode: 0,
      startedAtMs: at - 1000,
      finishedAtMs: at,
      build: { sourceDigest: DIGEST },
    };
  }
  return record;
}

function allGreen(options) {
  return gates.RELEASE_GATES.reduce((evidence, gate) => {
    evidence[gate.id] = admissibleEvidenceFor(gate, options);
    return evidence;
  }, {});
}

/**
 * The context `authoriseEnable` needs to age and bind evidence. The duration bounds are the
 * registered ones; without them `evidence.js` refuses the two windowed gates rather than
 * treating an unbounded window as satisfied.
 */
function evidenceContext() {
  return {
    evidenceMaxAgeMs: 24 * 3600 * 1000,
    // Mandatory: `evidence.admit()` refuses a run record when no tree is named to judge it
    // against, because judging one without knowing which tree is no check at all.
    sourceDigest: DIGEST,
    minObservationMs: { shadow_agreement: 14 * 24 * 3600 * 1000, soak: 72 * 3600 * 1000 },
  };
}

function declarationFor(shardId, atMs) {
  return guardrails.declare({
    shardId,
    declaredBy: "operator-a",
    declaredAtMs: atMs === undefined ? NOW - 1000 : atMs,
    observationWindowSeconds: 3600,
    guardrails: [
      { id: "commit_transaction_p999", direction: guardrails.DIRECTION.AT_MOST, threshold: 100, minSamples: 5000, unit: "ms" },
      { id: "round_wall_clock", direction: guardrails.DIRECTION.AT_MOST, threshold: 250, minSamples: 500, unit: "ms" },
    ],
  });
}

const SHARDS = Object.freeze([
  { shardId: "shard-small", regionId: "eu-west", agentCount: 40, state: "ACTIVE" },
  { shardId: "shard-mid", regionId: "eu-east", agentCount: 900, state: "ACTIVE" },
  { shardId: "shard-large", regionId: "us-east", agentCount: 12000, state: "ACTIVE" },
]);

function enableRequest(overrides) {
  const shard = (overrides && overrides.shard) || SHARDS[0];
  return {
    shard,
    allShards: SHARDS,
    liveShardIds: [],
    releaseEvidence: allGreen(),
    killSwitchState: killSwitches.defaultState(),
    declaration: declarationFor(shard.shardId),
    requestedBy: "operator-a",
    approvedBy: "operator-b",
    reason: "staged cutover, step 1",
    requestedAtMs: NOW,
    ...evidenceContext(),
    ...(overrides || {}),
  };
}

describe("the switch is a conjunction, and 'off' has a consequence", () => {
  const live = () =>
    service.buildSnapshot({
      bindings: [{ level: "region", key: "eu-west", name: enabled.PARAMETER, value: true }],
    });

  test("both halves are required: the process flag AND the shard's published binding", () => {
    expect(enabled.forShard({ snapshot: live(), shard: SHARDS[0], env: { ENGINE_ENABLED: "true" } })).toBe(true);
    // Same process, an unstaged shard.
    expect(enabled.forShard({ snapshot: live(), shard: SHARDS[1], env: { ENGINE_ENABLED: "true" } })).toBe(false);
    // Same binding, a process that does not participate.
    expect(enabled.forShard({ snapshot: live(), shard: SHARDS[0], env: { ENGINE_ENABLED: "false" } })).toBe(false);
  });

  test("it fails closed on anything that is not a resolvable snapshot", () => {
    // The direction matters and is asymmetric: a wrong `true` is a shard running the engine
    // nobody authorised; a wrong `false` is a shard that assigns nothing and says so.
    for (const snapshot of [null, undefined, {}, { resolve: null }]) {
      expect(enabled.configEnabled(snapshot, SHARDS[0])).toBe(false);
    }
  });

  test("describe() states the post-cutover consequence in words, not just a boolean", () => {
    const off = enabled.describe({ snapshot: live(), shard: SHARDS[1], env: { ENGINE_ENABLED: "true" } });
    expect(off.live).toBe(false);
    expect(off.decisionPath).toBe(enabled.DECISION_PATH.NONE);
    // The single most important sentence this module produces. An operator who infers the
    // pre-cutover meaning from a bare `false` will believe the legacy dispatcher is serving
    // the shard, and it is not in the build.
    expect(off.consequence).toMatch(/NO decision path/);
    expect(off.consequence).toMatch(/removed from the build/);

    const on = enabled.describe({ snapshot: live(), shard: SHARDS[0], env: { ENGINE_ENABLED: "true" } });
    expect(on.decisionPath).toBe(enabled.DECISION_PATH.ENGINE);
  });

  test("the parameter is registered at region scope, STRUCTURAL, and says why it is not SAFETY", () => {
    const entry = service.loadRegister().entries.get(enabled.PARAMETER);
    expect(entry).toBeTruthy();
    expect(entry.scopes).toContain("region");
    // STRUCTURAL rather than SAFETY, deliberately: §22.3 forbids an automated process from
    // changing a Safety-class parameter, and §22.4's automatic rollback must be able to set
    // this false. The asymmetry is enforced in code instead, and the entry says so.
    expect(entry.changeClass).toBe("STRUCTURAL");
    expect(entry.description).toMatch(/automatic rollback/);
    expect(entry.description).toMatch(/assertOneDirectional/);
  });
});

describe("the §24 release-gate table", () => {
  test("NOT_EVALUATED blocks exactly as RED does, and is a distinct word", () => {
    const none = gates.evaluate({});
    expect(none.counts.NOT_EVALUATED).toBe(gates.RELEASE_GATES.length);
    expect(gates.blockers({})).toHaveLength(gates.RELEASE_GATES.length);

    const failed = gates.evaluate({ soak: { pass: false, detail: "leaked" } });
    expect(failed.results.find((row) => row.id === "soak").status).toBe(gates.STATUS.RED);
    // Both block. They are different words because "we ran it and it failed" and "nobody
    // ran it" are different facts, and an incident review needs to tell them apart.
    expect(gates.blockers({ soak: { pass: false } }).map((row) => row.id)).toContain("soak");
  });

  test("evidence filed against an unknown gate id is reported, never ignored", () => {
    // Evidence counted against a gate that does not exist is evidence that was never
    // counted, and silently dropping it is how a gate ends up green on paper.
    const result = gates.evaluate({ ...allGreen(), soke_test: { pass: true } });
    expect(result.unknownEvidence).toEqual(["soke_test"]);
    expect(result.ok).toBe(false);
  });

  test("every gate declares its section, its statement, and how it is discharged", () => {
    expect(gates.assertGates()).toBe(true);
    for (const gate of gates.RELEASE_GATES) {
      expect({ id: gate.id, hasSection: Boolean(gate.section) }).toEqual({ id: gate.id, hasSection: true });
      expect({ id: gate.id, hasStatement: Boolean(gate.statement) }).toEqual({ id: gate.id, hasStatement: true });
      expect(Object.values(gates.EVIDENCE)).toContain(gate.evidence);
    }
  });

  test("the organisational and production gates are not build-closable, and are named", () => {
    // The split is not bookkeeping. §22.4 names the organisational failure mode as "the most
    // likely way this design fails in practice"; a table that let a build close a gate
    // requiring a human would be that failure implemented.
    const notBuildClosable = gates.RELEASE_GATES.filter(
      (gate) => gate.evidence === gates.EVIDENCE.PRODUCTION || gate.evidence === gates.EVIDENCE.ORGANISATIONAL,
    ).map((gate) => gate.id);

    expect(notBuildClosable).toEqual(
      expect.arrayContaining([
        "calibration_safety_derived",
        "shadow_agreement",
        "soak",
        "simulator_fidelity",
        "invariants_enforced",
        "rollback_rehearsed",
        "safety_case_assembled",
      ]),
    );
    for (const id of notBuildClosable) expect(gates.BUILD_CLOSABLE).not.toContain(id);
  });

  test("there is no WAIVED status", () => {
    // §23.6 makes class I, R and F unwaivable. A gate that could be waived would be a route
    // around the predicates those classes protect.
    expect(Object.values(gates.STATUS)).toEqual(["GREEN", "RED", "NOT_EVALUATED"]);
  });
});

describe("the staging order is least-blast-radius-first, and it is enforced", () => {
  test("shards are ordered by ascending agent count, ties broken deterministically", () => {
    const ordered = stage.stagingOrder([...SHARDS].reverse());
    expect(ordered.map((shard) => shard.shardId)).toEqual(["shard-small", "shard-mid", "shard-large"]);

    const tied = stage.stagingOrder([
      { shardId: "b", agentCount: 10 },
      { shardId: "a", agentCount: 10 },
    ]);
    expect(tied.map((shard) => shard.shardId)).toEqual(["a", "b"]);
  });

  test("the plan names each step's predecessors, so it can be published before the cutover starts", () => {
    const planned = stage.plan(SHARDS);
    expect(planned.steps.map((step) => step.shardId)).toEqual(["shard-small", "shard-mid", "shard-large"]);
    expect(planned.steps[2].predecessors).toEqual(["shard-small", "shard-mid"]);
    expect(planned.totalAgents).toBe(40 + 900 + 12000);
  });

  test("skipping the order is refused, and the escape requires a reason", () => {
    const skipped = stage.authoriseEnable(enableRequest({ shard: SHARDS[2] }));
    expect(skipped.authorised).toBe(false);
    expect(skipped.refusal.code).toBe(stage.REFUSAL.STAGING_ORDER_SKIPPED);
    expect(skipped.refusal.detail).toEqual(["shard-small", "shard-mid"]);

    const overridden = stage.authoriseEnable(
      enableRequest({ shard: SHARDS[2], options: { overrideOrder: "shard-small is mid-incident" } }),
    );
    expect(overridden.authorised).toBe(true);
    // Recorded as a skip, not as a normal step.
    expect(overridden.action.orderOverride).toEqual({
      skipped: ["shard-small", "shard-mid"],
      reason: "shard-small is mid-incident",
    });
  });
});

describe("the five refusals", () => {
  test("1 — a blocking release gate that is not GREEN refuses, and names the missing evidence", () => {
    const request = enableRequest();
    delete request.releaseEvidence.soak;
    request.releaseEvidence.rollback_rehearsed = { pass: false, detail: "never rehearsed" };

    const outcome = stage.authoriseEnable(request);
    expect(outcome.authorised).toBe(false);
    expect(outcome.refusal.code).toBe(stage.REFUSAL.RELEASE_GATE_NOT_GREEN);
    expect(outcome.refusal.message).toMatch(/soak \(NOT_EVALUATED\)/);
    expect(outcome.refusal.message).toMatch(/rollback_rehearsed \(RED\)/);
  });

  test("2 — a Tier 2 mechanism already enabled refuses (§1.8 rule 3's ship state)", () => {
    const state = { ...killSwitches.defaultState(), batch_solving: false };
    const outcome = stage.authoriseEnable(enableRequest({ killSwitchState: state }));

    expect(outcome.authorised).toBe(false);
    expect(outcome.refusal.code).toBe(stage.REFUSAL.TIER_TWO_NOT_AT_SHIP_STATE);
    expect(outcome.refusal.detail).toEqual(["batch_solving"]);
    // Phase 16 is what enables them, one at a time, each behind its own gate. Cutting over
    // with one already on would make those gates retrospective.
    expect(outcome.refusal.message).toMatch(/one at a time/);
  });

  test("3 — one person cannot approve their own cutover, and no automated process may enable", () => {
    const solo = stage.authoriseEnable(enableRequest({ approvedBy: "operator-a" }));
    expect(solo.refusal.code).toBe(stage.REFUSAL.NO_SECOND_APPROVER);

    const missing = stage.authoriseEnable(enableRequest({ approvedBy: null }));
    expect(missing.refusal.code).toBe(stage.REFUSAL.NO_SECOND_APPROVER);

    const automated = stage.authoriseEnable(enableRequest({ automated: true }));
    expect(automated.refusal.code).toBe(stage.REFUSAL.NO_SECOND_APPROVER);
    expect(automated.refusal.message).toMatch(/no automated process makes the change that raises risk/);
  });

  test("4 — guardrails must exist, be for this shard, and predate the request", () => {
    expect(stage.authoriseEnable(enableRequest({ declaration: null })).refusal.code).toBe(
      stage.REFUSAL.GUARDRAILS_NOT_DECLARED,
    );
    expect(stage.authoriseEnable(enableRequest({ declaration: declarationFor("shard-other") })).refusal.code).toBe(
      stage.REFUSAL.GUARDRAILS_NOT_DECLARED,
    );

    // Stamped after the request. "Pre-declared" is an ordering, and this is the wrong way
    // round — the case that makes the discipline real rather than decorative.
    const late = stage.authoriseEnable(
      enableRequest({ declaration: declarationFor("shard-small", NOW + 60_000) }),
    );
    expect(late.refusal.code).toBe(stage.REFUSAL.GUARDRAILS_NOT_DECLARED);
    expect(late.refusal.message).toMatch(/wrong way round/);
  });

  test("5 — a draining or retired shard may not be taken live", () => {
    for (const state of ["DRAINING", "RETIRED", "REBALANCING"]) {
      const outcome = stage.authoriseEnable(enableRequest({ shard: { ...SHARDS[0], state } }));
      expect({ state, code: outcome.refusal.code }).toEqual({ state, code: stage.REFUSAL.SHARD_NOT_ELIGIBLE });
    }
  });

  test("an authorised enable produces a publishable region-scoped binding", () => {
    const outcome = stage.authoriseEnable(enableRequest());
    expect(outcome.authorised).toBe(true);
    expect(outcome.action.binding).toEqual({
      level: "region",
      key: "eu-west",
      name: enabled.PARAMETER,
      value: true,
    });
    expect(outcome.action.orderPosition).toBe(1);
    expect(outcome.action.approvedBy).toBe("operator-b");
  });
});

describe("rollback is never refused, and carries its consequence", () => {
  test("it needs only a reason", () => {
    const outcome = stage.authoriseRollback({
      shard: SHARDS[0],
      reason: "commit p99.9 regressed",
      requestedBy: "operator-a",
      requestedAtMs: NOW,
    });

    expect(outcome.authorised).toBe(true);
    expect(outcome.action.binding.value).toBe(false);
    // Stated on every rollback, because it is the fact an operator most needs and is least
    // likely to have in mind at the moment they need it.
    expect(outcome.action.consequence).toMatch(/NO decision path/);
  });

  test("an unexplained rollback is refused — the only thing that is", () => {
    const outcome = stage.authoriseRollback({ shard: SHARDS[0] });
    expect(outcome.authorised).toBe(false);
    expect(outcome.refusal.code).toBe(stage.REFUSAL.NO_REASON_GIVEN);
  });

  test("the audit event carries the pre-declaration, which is what makes 'pre-declared' checkable later", () => {
    const authorisation = stage.authoriseEnable(enableRequest());
    const event = stage.auditEventFor(authorisation.action);

    expect(event.eventType).toBe("CUTOVER_SHARD_ENABLED");
    expect(event.subjectId).toBe("shard-small");
    expect(event.payload.approvedBy).toBe("operator-b");
    // The declaration travels into the append-only hash-chained stream. Nowhere else in the
    // system can the ordering be verified after the fact.
    expect(event.payload.guardrails.declaredAtMs).toBe(NOW - 1000);
    expect(event.payload.guardrails.guardrails).toHaveLength(2);
  });
});

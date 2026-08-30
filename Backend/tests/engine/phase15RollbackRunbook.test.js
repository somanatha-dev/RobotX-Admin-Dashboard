"use strict";

/**
 * Engine lane — the two facts `docs/runbooks/rollback.md` states that a code change could
 * silently invalidate.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────
 * `docs/` is outside the source-digest scope by design (`tools/release/sourceDigest.js`), so
 * **no gate detects a runbook drifting from the API it documents.** That is recorded as
 * **P15-F7a** and deliberately not fixed: digest-scoping `docs/` would void a ~25-minute
 * evidence collection on every prose edit, and a prose-parsing gate is an unmaintained future
 * false green. Neither of those is what this file is.
 *
 * This file pins **two constants the runbook enumerates**, so that renaming or restructuring
 * either one fails here with the runbook named, instead of leaving an operator to discover it
 * during an incident. It parses no prose and reads no markdown.
 *
 * ── The two, and the defects they close (V-10, 2026-08-30) ──────────────────
 * Phase 15's closure checklist carried **V-10** — *"`docs/runbooks/rollback.md`'s procedure
 * executed against the current API"* — as `NOT EVALUATED`, status **UNKNOWN**, with the note
 * that no pass had ever done it. It was executed on 2026-08-30 and found five defects. Two of
 * them are mechanically checkable and are checked here:
 *
 *   1. **§2 step 1 published one binding.** The runbook said *"Publish
 *      `authorisation.action.binding`"*. A configuration version is a **complete set** —
 *      `config/service.publish()` writes exactly `snapshot.declaredBindings` and inherits
 *      nothing, and `config.controller.publishVersion` defaults `bindings` to `[]`. Followed
 *      literally, the manual Rollback A reverted **every other parameter in the deployment**
 *      to its register default: a fleet-wide configuration change issued by the one control
 *      whose entire justification is that it touches one shard. `rollbackPublisher` solved
 *      exactly this for the automatic path and the runbook did not carry it across — and
 *      `SUPERSEDES_AN_UNPINNED_VERSION`'s refusal message routes an operator *into* the manual
 *      procedure, so the two met.
 *
 *   2. **§5 never named the six rehearsal step keys.** The record table said *"each of the six
 *      steps above, named individually"* and gave no names, so a record filed from the runbook
 *      alone is refused `REHEARSAL_INCOMPLETE` — on `rollback_rehearsed`, which is
 *      ORGANISATIONAL evidence that no build can close (**B-O**).
 *
 * Neither assertion below passes on the tree as the runbook described it.
 */

const configService = require("../../src/engine/config/service");
const enabled = require("../../src/engine/cutover/enabled");
const evidence = require("../../src/engine/cutover/evidence");
const rollbackPublisher = require("../../src/engine/cutover/rollbackPublisher");
const stage = require("../../src/engine/cutover/stage");

/** The region being rolled back, and one that must be left entirely alone. */
const ROLLED_BACK = "rgn-a";
const UNTOUCHED = "rgn-b";

/**
 * A stand-in for the version in force: this shard's cutover binding, a second shard's, and
 * one ordinary parameter bound away from its default so that "reverted to the register
 * default" is observable rather than inferred.
 *
 * `sla.assignment_deadline` is used because it is registered, region-scoped and numeric, and
 * because it is the same parameter the P15-E2 live-database run used to catch the composition
 * root reading the wrong version — the divergence is legible in the same terms.
 */
const PARAMETER_UNDER_TEST = "sla.assignment_deadline";
const BOUND_VALUE = 300;

const IN_FORCE_BINDINGS = Object.freeze([
  { level: "region", key: ROLLED_BACK, name: enabled.PARAMETER, value: true },
  { level: "region", key: UNTOUCHED, name: enabled.PARAMETER, value: true },
  { level: "region", key: ROLLED_BACK, name: PARAMETER_UNDER_TEST, value: BOUND_VALUE },
  { level: "region", key: UNTOUCHED, name: PARAMETER_UNDER_TEST, value: BOUND_VALUE },
]);

/** The authorisation an operator holds at §2 step 1, from the shipped authority. */
function rollbackAction() {
  const authorisation = stage.authoriseRollback({
    shard: { shardId: "shard-a", regionId: ROLLED_BACK },
    reason: "V-10 runbook trace",
    requestedBy: "operator",
    requestedAtMs: 1_760_000_000_000,
  });
  expect(authorisation.authorised).toBe(true);
  return authorisation.action;
}

function resolutionOf(bindings) {
  const snapshot = configService.buildSnapshot({ bindings });
  return {
    rolledBackLive: snapshot.resolve(enabled.PARAMETER, { region: ROLLED_BACK }),
    untouchedLive: snapshot.resolve(enabled.PARAMETER, { region: UNTOUCHED }),
    rolledBackDeadline: snapshot.resolve(PARAMETER_UNDER_TEST, { region: ROLLED_BACK }),
    untouchedDeadline: snapshot.resolve(PARAMETER_UNDER_TEST, { region: UNTOUCHED }),
  };
}

describe("rollback.md §2.1 — a version is a complete set, and the manual publish must say so", () => {
  test("the in-force set resolves as expected before anything is published", () => {
    expect(resolutionOf([...IN_FORCE_BINDINGS])).toEqual({
      rolledBackLive: true,
      untouchedLive: true,
      rolledBackDeadline: BOUND_VALUE,
      untouchedDeadline: BOUND_VALUE,
    });
  });

  test("PLANTED — the runbook's old instruction is a fleet-wide configuration change", () => {
    // Exactly what "Publish `authorisation.action.binding`" produced: one binding, nothing
    // else restated. The shard is disabled, and so is everything else about the deployment.
    const asWritten = resolutionOf([rollbackAction().binding]);

    expect(asWritten.rolledBackLive).toBe(false);

    // The other shard's cutover binding is gone. It resolves to the register default, and
    // whatever that default is, it is not "the value an operator put in force".
    expect(asWritten.untouchedLive).not.toBe(true);

    // And an ordinary parameter, in both regions, has silently moved off the value in force.
    expect(asWritten.rolledBackDeadline).not.toBe(BOUND_VALUE);
    expect(asWritten.untouchedDeadline).not.toBe(BOUND_VALUE);
  });

  test("the documented carry-forward disables one region and moves nothing else", () => {
    const action = rollbackAction();
    const published = rollbackPublisher.bindingsWithRegionDisabled(
      IN_FORCE_BINDINGS,
      action.binding.key,
    );

    expect(resolutionOf(published)).toEqual({
      rolledBackLive: false,
      untouchedLive: true,
      rolledBackDeadline: BOUND_VALUE,
      untouchedDeadline: BOUND_VALUE,
    });
  });

  test("the region's own binding is replaced, not appended — one answer per (level, key, name)", () => {
    // A resolver handed two bindings for the same triple has two answers, and which one it
    // returns is an implementation detail nobody should be relying on during a rollback.
    const published = rollbackPublisher.bindingsWithRegionDisabled(
      IN_FORCE_BINDINGS,
      ROLLED_BACK,
    );
    const forRolledBack = published.filter(
      (binding) =>
        binding.name === enabled.PARAMETER && binding.level === "region" && binding.key === ROLLED_BACK,
    );
    expect(forRolledBack).toEqual([
      { level: "region", key: ROLLED_BACK, name: enabled.PARAMETER, value: false },
    ]);
  });

  test("the manual recipe and the automatic publisher agree on the set, field for field", () => {
    // §2.1 tells an operator to build the set with the same exported function the automatic
    // path uses, so the two rollbacks leave the deployment in one state rather than two. If
    // that function stops being the publisher's own, this fails and the runbook is wrong.
    const action = rollbackAction();
    const manual = rollbackPublisher.bindingsWithRegionDisabled(IN_FORCE_BINDINGS, action.binding.key);

    // The publisher admits this action, so the recipe's inputs are the ones it would accept.
    expect(rollbackPublisher.assertDisableOnly(action)).toEqual({ ok: true, code: null, message: null });
    expect(manual).toContainEqual(action.binding);
  });
});

describe("rollback.md §5 — the rehearsal record's step keys, as the runbook now names them", () => {
  /**
   * The table under "The rehearsal record". A key added, removed or renamed here without the
   * runbook moving with it means an operator files a record from the runbook and is refused
   * `REHEARSAL_INCOMPLETE` on a gate no build can close.
   */
  const RUNBOOK_STEP_KEYS = [
    "cutover",
    "automatic_rollback",
    "no_decision_path_confirmed",
    "artefact_rollback",
    "recutover",
    "recorded",
  ];

  test("evidence.REHEARSAL_STEPS is exactly the six keys docs/runbooks/rollback.md §5 lists", () => {
    expect([...evidence.REHEARSAL_STEPS]).toEqual(RUNBOOK_STEP_KEYS);
  });

  test("a record naming every step the runbook lists clears REHEARSAL_INCOMPLETE", () => {
    // Not that the record is admissible — it is not, and it should not be, because this
    // suite files no environment and no approvals. What is asserted is narrower and is the
    // point: following the runbook's step table is no longer refused *for the steps*.
    const gate = { id: "rollback_rehearsed", rehearsal: true };
    const record = {
      kind: evidence.KINDS.ATTESTATION,
      gateId: gate.id,
      pass: true,
      rehearsal: {
        environment: { id: "staging-1", production: false },
        configVersion: "42",
        steps: Object.fromEntries(RUNBOOK_STEP_KEYS.map((step) => [step, true])),
        automaticRollbackFired: true,
      },
      approval: { recordedBy: "operator", approvedBy: "release-owner" },
    };

    const verdict = evidence.admit(gate, record, { nowMs: Date.now() });
    expect(verdict.code).not.toBe(evidence.INADMISSIBLE.REHEARSAL_INCOMPLETE);
  });
});

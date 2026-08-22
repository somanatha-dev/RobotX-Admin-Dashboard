"use strict";

/**
 * Gates lane — the §22.4 calibration **launch** gate.
 *
 * Every test in this lane plants a deliberate violation and asserts the gate catches it. A
 * gate that cannot fail is not a gate, so these tests are what make the gate trustworthy.
 *
 * This one has an extra obligation the other five do not: it must be shown to be a *launch*
 * gate and not a build gate. Those are different things — one blocks a commit, the other
 * blocks a fleet — and the distinction is asserted rather than described, because it is the
 * distinction that keeps the build green while the cutover stays mechanically impossible.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const gate = require("../../tools/gates/checkCalibration");
const gates = require("../../src/engine/cutover/gates");
const stage = require("../../src/engine/cutover/stage");
const killSwitches = require("../../src/engine/config/killSwitches");

/** Write a throwaway register directory containing exactly the entries given. */
function registerWith(parameters) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "robotx-calibration-"));
  fs.writeFileSync(
    path.join(directory, "test.json"),
    JSON.stringify({ source: "test fixture", note: "planted", parameters }, null, 2),
    "utf8",
  );
  return directory;
}

const WELL_FORMED = Object.freeze({
  name: "test.threshold",
  type: "integer",
  unit: "ms",
  default: 10,
  range: { min: 1, max: 100 },
  specScope: "global",
  scopes: ["global"],
  changeClass: "TUNED",
  owner: "Eng",
  blastRadius: "region",
  calibrationStatus: "DERIVED",
  section: "§20.1",
  requiredBy: "a module that reads it",
  description: "a well-formed entry",
});

describe("THE GATE FAILS on the violations it exists to catch", () => {
  test("a Safety-class parameter that is PROVISIONAL blocks", () => {
    const directory = registerWith([
      { ...WELL_FORMED, name: "safety.margin", changeClass: "SAFETY", calibrationStatus: "PROVISIONAL", awaits: "a measurement" },
    ]);
    const result = gate.checkCalibration({ directory });

    expect(result.ok).toBe(false);
    expect(result.blocking).toHaveLength(1);
    expect(result.blocking[0].kind).toBe(gate.FINDING.SAFETY_NOT_DERIVED);
    expect(result.blocking[0].name).toBe("safety.margin");
    // The awaited data is carried into the finding, so the report says what is missing
    // rather than only that something is.
    expect(result.blocking[0].awaits).toBe("a measurement");
  });

  test("a Safety-class parameter that is UNCALIBRATED blocks", () => {
    const directory = registerWith([
      { ...WELL_FORMED, name: "safety.floor", changeClass: "SAFETY", calibrationStatus: "UNCALIBRATED" },
    ]);
    expect(gate.checkCalibration({ directory }).blocking[0].kind).toBe(gate.FINDING.SAFETY_NOT_DERIVED);
  });

  test("a Safety-class parameter claiming DERIVED with no stated source blocks", () => {
    // §22.4 defines DERIVED as "from a stated accounting or measured source". A status field
    // can be edited without the derivation existing, and a *claim* is more dangerous than an
    // admission: `PROVISIONAL` tells a reader to be careful and this does not.
    const directory = registerWith([
      { ...WELL_FORMED, name: "safety.claimed", changeClass: "SAFETY", calibrationStatus: "DERIVED", section: null, requiredBy: null },
    ]);
    const result = gate.checkCalibration({ directory });
    expect(result.ok).toBe(false);
    expect(result.blocking[0].kind).toBe(gate.FINDING.SAFETY_DERIVATION_NOT_STATED);
  });

  test("an unrecognised calibration status blocks", () => {
    const directory = registerWith([{ ...WELL_FORMED, name: "odd.status", calibrationStatus: "PROBABLY_FINE" }]);
    expect(gate.checkCalibration({ directory }).blocking[0].kind).toBe(gate.FINDING.UNKNOWN_STATUS);
  });
});

describe("THE GATE PASSES what it should, and reports the rest as advisory", () => {
  test("a Safety-class parameter that is DERIVED with a stated source passes", () => {
    const directory = registerWith([
      { ...WELL_FORMED, name: "safety.derived", changeClass: "SAFETY", derivation: "replacement cost over rated life" },
    ]);
    expect(gate.checkCalibration({ directory }).ok).toBe(true);
  });

  test("a NON-Safety PROVISIONAL entry does not block — §22.4's launch gate is stated per tier", () => {
    const directory = registerWith([
      { ...WELL_FORMED, name: "tuned.window", calibrationStatus: "PROVISIONAL", awaits: "measured arrival rate" },
    ]);
    const result = gate.checkCalibration({ directory });
    expect(result.ok).toBe(true);
    expect(result.advisory).toEqual([]);
  });

  test("a PROVISIONAL entry naming no awaited data is advisory, not blocking", () => {
    // §22.4: "Tier 1 and Tier 2 parameters may launch PROVISIONAL, but each must name the
    // data it awaits." A quality signal, not a launch blocker.
    const directory = registerWith([{ ...WELL_FORMED, name: "tuned.vague", calibrationStatus: "PROVISIONAL" }]);
    const result = gate.checkCalibration({ directory });
    expect(result.ok).toBe(true);
    expect(result.advisory[0].kind).toBe(gate.FINDING.PROVISIONAL_WITHOUT_AWAITS);
  });

  test("a NON-Safety DERIVED entry with no stated source is advisory, not blocking", () => {
    const directory = registerWith([{ ...WELL_FORMED, name: "tuned.claimed", section: null, requiredBy: null }]);
    const result = gate.checkCalibration({ directory });
    expect(result.ok).toBe(true);
    expect(result.advisory[0].kind).toBe(gate.FINDING.DERIVATION_NOT_STATED);
  });
});

describe("it is a LAUNCH gate, not a build gate — and the difference is enforced", () => {
  test("`npm run gates` does not run it", () => {
    // Deliberate. A red result here is not a commit to revert; it is work ops, finance and
    // safety have not done, and §22.4 predicts what happens if the pressure is applied to
    // the wrong place: "the engine ships with placeholder coefficients, its early decisions
    // are indefensible when questioned, operators begin overriding it within weeks".
    const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")).scripts;
    expect(scripts.gates).not.toMatch(/gate:calibration/);
    expect(scripts["gate:calibration"]).toBe("node tools/gates/checkCalibration.js");

    // It IS part of the release-gate run, which is the set the cutover needs evidence from.
    //
    // ── PHASE 15 REMEDIATION — asserted as a property, not as a substring ──
    // This used to read `expect(scripts["release:gates"]).toMatch(/gate:calibration/)`, and
    // a substring match on a shell conjunction is a weak proxy for "the release run covers
    // this gate": it passes when the command is present and says nothing about whether its
    // result is ever *judged*. It also could not survive `release:gates` becoming a single
    // aggregator, which is what the remediation made it — the old conjunction exited 0 with
    // six blocking gates never evaluated.
    //
    // The property is now checked where it lives: `calibration_safety_derived` is a blocking
    // row in the gate table, the release verdict reports every blocking row, and the
    // evidence collector runs this gate's declared command.
    const gates = require("../../src/engine/cutover/gates");
    const collectEvidence = require("../../tools/release/collectEvidence");

    const row = gates.GATE_BY_ID.calibration_safety_derived;
    expect(row.blocking).toBe(true);
    expect(row.command).toBe("npm run gate:calibration");
    expect(scripts["release:gates"]).toMatch(/tools\/release\/verdict\.js/);

    // The collector runs it. `runner` is injected so this asserts the wiring without paying
    // for a real gate run.
    const ran = [];
    collectEvidence.collect({
      only: "build",
      runner: (command) => {
        ran.push(command);
        return { command, exitCode: 0, startedAtMs: 1, finishedAtMs: 2, tail: "" };
      },
    });
    expect(ran).toContain("npm run gate:calibration");
  });

  test("a build cannot close it — the attestation needs two people AND the check to pass", () => {
    // §22.4's gate is ORGANISATIONAL: only the calibration owner can say a value was derived.
    // `collectEvidence` therefore files this gate's run as *corroboration*, never as evidence,
    // and `evidence.js` refuses a record that carries a run for an organisational gate.
    const gates = require("../../src/engine/cutover/gates");
    const collectEvidence = require("../../tools/release/collectEvidence");

    const collected = collectEvidence.collect({
      only: "build",
      runner: (command) => ({ command, exitCode: 0, startedAtMs: 1, finishedAtMs: 2, tail: "" }),
    });
    expect(collected.evidence.calibration_safety_derived).toBeUndefined();
    expect(collected.corroboration.calibration_safety_derived).toBeDefined();

    // And the corroboration alone discharges nothing.
    const evaluation = gates.evaluate(
      { calibration_safety_derived: collected.corroboration.calibration_safety_derived },
      { nowMs: 3 },
    );
    expect(evaluation.results.find((r) => r.id === "calibration_safety_derived").status).toBe(gates.STATUS.RED);
  });

  test("it blocks the thing it is a gate on: no shard can be enabled while it is red", () => {
    // The mechanical consequence, asserted rather than described. `calibration_safety_derived`
    // is a blocking row in the release-gate table, so `authoriseEnable` refuses while it is
    // not GREEN — which is what "hard launch gate" means and what "build gate" does not.
    const evidence = gates.RELEASE_GATES.reduce((all, row) => {
      all[row.id] = { pass: row.id !== "calibration_safety_derived" };
      return all;
    }, {});

    const outcome = stage.authoriseEnable({
      shard: { shardId: "s", regionId: "r", state: "ACTIVE" },
      allShards: [{ shardId: "s", regionId: "r", agentCount: 1, state: "ACTIVE" }],
      liveShardIds: [],
      releaseEvidence: evidence,
      killSwitchState: killSwitches.defaultState(),
      declaration: { shardId: "s", declaredAtMs: 1, guardrails: [] },
      requestedBy: "a",
      approvedBy: "b",
      reason: "attempt",
      requestedAtMs: 2,
    });

    expect(outcome.authorised).toBe(false);
    expect(outcome.refusal.code).toBe(stage.REFUSAL.RELEASE_GATE_NOT_GREEN);
    expect(outcome.refusal.message).toMatch(/calibration_safety_derived \(RED\)/);
  });

  test("the gate's evidence kind is ORGANISATIONAL, so no build can close it", () => {
    const row = gates.GATE_BY_ID.calibration_safety_derived;
    expect(row.evidence).toBe(gates.EVIDENCE.ORGANISATIONAL);
    expect(gates.BUILD_CLOSABLE).not.toContain("calibration_safety_derived");
  });
});

describe("the shipped register's actual state, recorded rather than glossed", () => {
  test("the gate is currently RED, and every finding is a Safety-class parameter awaiting data", () => {
    // This test does NOT assert a pass. It asserts the shape of the failure, so that the
    // day the calibration owner closes it, the change is visible here rather than silent —
    // and so that the count in `PHASE_15_IMPLEMENTATION_REPORT.md` cannot drift from the
    // code.
    const result = gate.checkCalibration();
    expect(result.ok).toBe(false);

    // Every blocking finding is the same kind: a Safety-class value nobody has derived.
    // None is `SAFETY_DERIVATION_NOT_STATED`, which would be a claim rather than an
    // admission and would be a more serious finding.
    const kinds = new Set(result.blocking.map((finding) => finding.kind));
    expect([...kinds]).toEqual([gate.FINDING.SAFETY_NOT_DERIVED]);

    // Each names an owner and the data it awaits, which is what makes the list actionable
    // by the named calibration owner (§22.4) rather than a wall of red.
    for (const finding of result.blocking) {
      expect({ name: finding.name, hasOwner: Boolean(finding.owner) }).toEqual({ name: finding.name, hasOwner: true });
    }

    // The report's figure. If a parameter is derived, this fails and both are updated
    // together — which is the point.
    expect(result.blocking).toHaveLength(39);
    expect(result.safetyTotal).toBe(54);
  });
});

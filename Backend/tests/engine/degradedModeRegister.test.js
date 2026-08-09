"use strict";

/**
 * Engine lane — Phase 12: the degraded-mode register (§18.5) and the §26.2 matrix.
 *
 * §18.5's whole argument is that a degraded mode is "a **named**, entered, exited, and
 * recorded state of a shard, not an emergent condition". A test suite for it is therefore
 * mostly a suite about the *declaration*: that the six modes are the six, that the four
 * governing rules hold over every one of them rather than over the one somebody
 * remembered, and that the matrix an operator reads and the matrix the checker reads are
 * the same statement.
 *
 * Every assertion this file makes against the specification is transcribed here
 * independently rather than read out of the module under test — a test that asked
 * `modeRegister` what the matrix says and then checked it against `modeRegister` would
 * pass on any matrix at all.
 */

const fs = require("fs");
const path = require("path");

const modeRegister = require("../../src/engine/degraded/modeRegister");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const SPEC = fs.readFileSync(path.join(REPO_ROOT, "NEXT_GENERATION_ASSIGNMENT_ENGINE.md"), "utf8");

describe("§18.5 — the six named modes", () => {
  test("the register carries exactly the six modes §18.5's table names, and no seventh", () => {
    expect([...modeRegister.MODE_NAMES].sort()).toEqual(
      [
        "COLD_INDEX",
        "CUSTODIAL_OPERATION",
        "DEGRADED_ROUTING",
        "RESTRICTED_OPERATION",
        "SHED_LOAD",
        "UNSUPERVISED_COMMITMENT",
      ].sort(),
    );
  });

  test("§18.5's table in the frozen specification has six rows, and they are these six", () => {
    // Read from the specification rather than asserted from memory: the count is the thing
    // most likely to drift silently if a mode were ever added.
    const start = SPEC.indexOf("### 18.5 The degraded-mode register");
    const end = SPEC.indexOf("Four rules govern every mode", start);
    const table = SPEC.slice(start, end);
    const names = [...table.matchAll(/^\| \*\*([^*]+)\*\* \|/gm)].map((match) => match[1].trim());
    expect(names).toHaveLength(6);
    expect(names.map((name) => name.toUpperCase().replace(/ /g, "_")).sort()).toEqual([...modeRegister.MODE_NAMES].sort());
  });

  test("every mode declares an entry condition, an envelope, a suspension set, and an exit", () => {
    for (const mode of modeRegister.MODE_NAMES) {
      const declared = modeRegister.modeOf(mode);
      expect({ mode, enteredWhen: Boolean(declared.enteredWhen) }).toEqual({ mode, enteredWhen: true });
      expect({ mode, envelope: typeof declared.envelope }).toEqual({ mode, envelope: "object" });
      expect({ mode, suspends: Array.isArray(declared.suspendsInvariants) }).toEqual({ mode, suspends: true });
      expect({ mode, exitWhen: Boolean(declared.exitWhen) }).toEqual({ mode, exitWhen: true });
    }
  });

  test("an unregistered mode name throws rather than resolving to null", () => {
    // Returning null would let an unnamed mode propagate, which is the emergent condition
    // §18.5 exists to forbid.
    expect(() => modeRegister.modeOf("PANIC_MODE")).toThrow(/not one of §18.5's six named degraded modes/);
    expect(modeRegister.isMode("PANIC_MODE")).toBe(false);
  });
});

describe("the four governing rules", () => {
  test("rule 1 — an entry event carries cause, entering component, and the suspension set", () => {
    const event = modeRegister.entryEvent({
      mode: modeRegister.MODE.CUSTODIAL_OPERATION,
      shardId: "shard-a",
      cause: "Commitment Store health check failed (B1)",
      enteringComponent: "failure/infraFailures",
      atMs: 1000,
      maxDurationMs: 900000,
    });

    expect(event.cause).toBeTruthy();
    expect(event.enteringComponent).toBe("failure/infraFailures");
    expect(event.suspendedInvariants).toEqual(["I2"]);
  });

  test("rule 1 — an entry with no cause, no entering component, or no time is refused", () => {
    const base = { mode: modeRegister.MODE.COLD_INDEX, shardId: "shard-a", cause: "c", enteringComponent: "x", atMs: 1 };
    expect(() => modeRegister.entryEvent({ ...base, cause: undefined })).toThrow(/without a cause/);
    expect(() => modeRegister.entryEvent({ ...base, enteringComponent: undefined })).toThrow(/without an entering component/);
    expect(() => modeRegister.entryEvent({ ...base, atMs: undefined })).toThrow(/without a time/);
  });

  test("rule 1 — a mode that suspends nothing records an empty set rather than omitting it", () => {
    // "Suspended nothing" and "nobody wrote it down" are different facts, and only the
    // first one is reassuring.
    const event = modeRegister.entryEvent({
      mode: modeRegister.MODE.COLD_INDEX,
      shardId: "shard-a",
      cause: "cache tier unreachable (B3)",
      enteringComponent: "failure/infraFailures",
      atMs: 1000,
    });
    expect(event.suspendedInvariants).toEqual([]);
  });

  test("rule 1 — an exit event carries its evidence and the time in mode, which is an SLI", () => {
    const entry = modeRegister.entryEvent({
      mode: modeRegister.MODE.SHED_LOAD,
      shardId: "shard-a",
      cause: "queue depth past capacity (B19)",
      enteringComponent: "intake/admission",
      atMs: 1000,
      maxDurationMs: 900000,
    });
    const exit = modeRegister.exitEvent({ entry, atMs: 61000, reason: "queue delay within budget", exitingComponent: "intake/admission" });

    expect(exit.durationMs).toBe(60000);
    expect(exit.restoredInvariants).toEqual([]);
    expect(() => modeRegister.exitEvent({ entry, atMs: 61000, reason: "", exitingComponent: "x" })).toThrow(/without stating the evidence/);
  });

  test("rule 2 — the suspension set comes from the declaration and there is no API to add to it", () => {
    expect(modeRegister.suspensionsFor(modeRegister.MODE.CUSTODIAL_OPERATION)).toEqual(["I2"]);
    expect(modeRegister.suspensionsFor(modeRegister.MODE.UNSUPERVISED_COMMITMENT)).toEqual(["I4"]);
    // `suspensionsFor` is unary. A second parameter by which a caller could contribute a
    // suspension is what §18.5 rule 2 forbids — "No invariant is ever suspended implicitly
    // by a component finding it inconvenient" — so its arity is the assertion.
    expect(modeRegister.suspensionsFor.length).toBe(1);
  });

  test("rule 2 — every mode is time-boxed, and an uncomputable box is treated as expired", () => {
    const entry = modeRegister.entryEvent({
      mode: modeRegister.MODE.CUSTODIAL_OPERATION,
      shardId: "shard-a",
      cause: "B1",
      enteringComponent: "x",
      atMs: 1000,
      maxDurationMs: 5000,
    });

    expect(modeRegister.evaluateTimeBox(entry, 4000).expired).toBe(false);
    expect(modeRegister.evaluateTimeBox(entry, 7000).expired).toBe(true);
    expect(modeRegister.evaluateTimeBox(entry, 7000).alertable).toBe(true);

    // A box with no computable expiry is expired, not unbounded — an unbounded degraded
    // mode is precisely what rule 2 forbids.
    const unboxed = modeRegister.entryEvent({
      mode: modeRegister.MODE.COLD_INDEX,
      shardId: "shard-a",
      cause: "B3",
      enteringComponent: "x",
      atMs: 1000,
    });
    expect(modeRegister.evaluateTimeBox(unboxed, 2000).expired).toBe(true);
  });

  test("rule 3 — no mode's envelope can promote the cache tier to an authority", () => {
    expect(modeRegister.assertNoCacheAuthority()).toEqual({ ok: true, problems: [] });

    // And the check does real work: a planted field fails it.
    const planted = { ...modeRegister.MODES[modeRegister.MODE.COLD_INDEX].envelope, readLeasesFromCache: true };
    const offending = modeRegister.CACHE_AUTHORITY_FIELDS.filter((field) => field in planted);
    expect(offending).toEqual(["readLeasesFromCache"]);
  });

  test("rule 4 — no mode's envelope can relax a class I or R constraint", () => {
    expect(modeRegister.assertRelaxesNoConstraint()).toEqual({ ok: true, problems: [] });

    // Every reserve knob is a named *multiplier parameter*, which can only enlarge. A
    // divisor, or a bare reserve value, is a relaxation wearing a tightening name.
    for (const mode of modeRegister.MODE_NAMES) {
      for (const key of Object.keys(modeRegister.MODES[mode].envelope)) {
        if (/reserve/i.test(key)) {
          expect({ mode, key }).toEqual({ mode, key: expect.stringMatching(/MultiplierParameter$/) });
        }
      }
    }
  });

  test("every structural assertion the register makes about itself passes", () => {
    expect(modeRegister.assertRegister()).toEqual({ ok: true, problems: [] });
  });
});

describe("§26.2 — the matrix, transcribed independently from the specification", () => {
  /**
   * The matrix as §26.2 writes it, read out of the frozen document itself. Parsing the
   * specification rather than restating it is what makes this a *cross-check* of the
   * module rather than a second copy of it.
   */
  const specMatrix = (() => {
    const start = SPEC.indexOf("### 26.2 Invariant behaviour under degraded modes");
    const end = SPEC.indexOf("Three properties of this matrix are load-bearing", start);
    const table = SPEC.slice(start, end);

    const rows = {};
    for (const line of table.split("\n")) {
      const match = /^\| (I\d+)[^|]*\|(.*)\|\s*$/.exec(line);
      if (!match) continue;
      const cells = match[2].split("|").map((cell) => cell.trim());
      // The columns, in §26.2's own order.
      const modes = [
        "RESTRICTED_OPERATION",
        "CUSTODIAL_OPERATION",
        "UNSUPERVISED_COMMITMENT",
        "DEGRADED_ROUTING",
        "COLD_INDEX",
        "SHED_LOAD",
      ];
      rows[match[1]] = Object.fromEntries(
        modes.map((mode, index) => {
          const cell = cells[index] || "";
          // Cells read `E`, `**S**`, `**D**`, or a letter followed by an em-dash note.
          const symbol = /\*\*([ESD])\*\*/.exec(cell) || /^([ESD])\b/.exec(cell);
          return [mode, symbol ? symbol[1] : null];
        }),
      );
    }
    return rows;
  })();

  test("the specification's table parses into 22 rows × 6 columns", () => {
    expect(Object.keys(specMatrix)).toHaveLength(22);
    for (const [invariant, row] of Object.entries(specMatrix)) {
      for (const [mode, symbol] of Object.entries(row)) {
        expect({ invariant, mode, symbol }).toEqual({ invariant, mode, symbol: expect.stringMatching(/^[ESD]$/) });
      }
    }
  });

  test("every one of the 132 cells matches the specification", () => {
    const disagreements = [];
    for (const invariant of modeRegister.INVARIANTS) {
      for (const mode of modeRegister.MODE_NAMES) {
        const mine = modeRegister.behaviourOf(invariant, mode).status;
        const theirs = specMatrix[invariant][mode];
        if (mine !== theirs) disagreements.push(`${invariant}@${mode}: register says ${mine}, §26.2 says ${theirs}`);
      }
    }
    expect(disagreements).toEqual([]);
  });

  test("exactly two cells are suspensions, and they are I2 under Custodial and I4 under Unsupervised", () => {
    const outcome = modeRegister.assertSuspensionsAreExactlyTheTwo();
    expect(outcome.ok).toBe(true);
    expect(outcome.suspensions).toEqual([
      { invariant: "I2", mode: "CUSTODIAL_OPERATION" },
      { invariant: "I4", mode: "UNSUPERVISED_COMMITMENT" },
    ]);
  });

  test("no mode suspends a safety invariant — I1, I7, I8, I9, I17, I19 are E in every column", () => {
    expect(modeRegister.assertNoSafetyInvariantSuspended()).toEqual({ ok: true, problems: [] });
  });

  test("the suspension sets and the matrix are the same statement", () => {
    expect(modeRegister.assertMatrixMatchesSuspensionSets()).toEqual({ ok: true, problems: [] });
  });

  test("the vacuous cells under Custodial Operation are marked as such rather than claiming enforcement", () => {
    // §26.2: "an invariant that holds because the operation it governs is not occurring is
    // genuinely satisfied, but it is satisfied for a reason worth recording — it means the
    // guarantee returns automatically on mode exit rather than requiring repair."
    for (const invariant of ["I1", "I4", "I5", "I9", "I10", "I21"]) {
      const cell = modeRegister.behaviourOf(invariant, modeRegister.MODE.CUSTODIAL_OPERATION);
      expect({ invariant, status: cell.status, vacuous: cell.vacuous }).toEqual({
        invariant,
        status: modeRegister.BEHAVIOUR.ENFORCED,
        vacuous: true,
      });
    }
  });
});

describe("resolving a status across several open modes", () => {
  test("a suspension beats a degradation beats enforcement, and names its mode", () => {
    const both = modeRegister.resolveBehaviour("I2", ["UNSUPERVISED_COMMITMENT", "CUSTODIAL_OPERATION"]);
    expect(both.status).toBe(modeRegister.BEHAVIOUR.SUSPENDED);
    expect(both.authorisedBy).toBe("CUSTODIAL_OPERATION");

    const degraded = modeRegister.resolveBehaviour("I2", ["UNSUPERVISED_COMMITMENT", "COLD_INDEX"]);
    expect(degraded.status).toBe(modeRegister.BEHAVIOUR.DEGRADED);
    expect(degraded.authorisedBy).toBe("UNSUPERVISED_COMMITMENT");

    expect(modeRegister.resolveBehaviour("I2", []).status).toBe(modeRegister.BEHAVIOUR.ENFORCED);
    expect(modeRegister.resolveBehaviour("I2", []).authorisedBy).toBeNull();
  });

  test("a safety invariant stays enforced no matter how many modes are open at once", () => {
    for (const invariant of modeRegister.NEVER_DEGRADED_INVARIANTS) {
      const resolved = modeRegister.resolveBehaviour(invariant, [...modeRegister.MODE_NAMES]);
      expect({ invariant, status: resolved.status }).toEqual({ invariant, status: modeRegister.BEHAVIOUR.ENFORCED });
    }
  });
});

describe("Custodial Operation, in detail (§18.5)", () => {
  const custodial = modeRegister.MODES[modeRegister.MODE.CUSTODIAL_OPERATION];

  test("no commits and no commands — both, and the reason names the fence", () => {
    expect(custodial.envelope.noCommits).toBe(true);
    expect(custodial.envelope.noCommands).toBe(true);

    const commands = modeRegister.commandsSuspended([modeRegister.MODE.CUSTODIAL_OPERATION]);
    expect(commands.suspended).toBe(true);
    expect(commands.byMode).toBe("CUSTODIAL_OPERATION");
    expect(commands.reason).toMatch(/fence that cannot be advanced durably provides none of the protection/);
  });

  test("it is the only mode that stops commands, and the only one that stops commits", () => {
    for (const mode of modeRegister.MODE_NAMES) {
      const stopsCommands = modeRegister.commandsSuspended([mode]).suspended;
      const stopsCommits = modeRegister.commitsSuspended([mode]).suspended;
      const expected = mode === modeRegister.MODE.CUSTODIAL_OPERATION;
      expect({ mode, stopsCommands, stopsCommits }).toEqual({ mode, stopsCommands: expected, stopsCommits: expected });
    }
  });

  test("in-flight missions continue under the agent's own autonomy limit, not the server's supervision", () => {
    // "**This bound is the safety property that replaces server-side supervision**, it is
    // enforced on the agent rather than by the server, and it is therefore unaffected by
    // any server-side outage."
    expect(custodial.envelope.agentAutonomyLimitParameter).toBe("agent.autonomous_continuation_limit");
    expect(custodial.envelope.intakeContinues).toBe(true);
  });

  test("recovery requires a full reconciliation before rounds resume", () => {
    expect(custodial.envelope.reconciliationRequiredBeforeRounds).toBe(true);
    expect(custodial.exitWhen).toMatch(/reconciliation/);
  });

  test("Unsupervised Commitment stops hardening, which is the load-bearing half of B4", () => {
    expect(modeRegister.hardeningStopped([modeRegister.MODE.UNSUPERVISED_COMMITMENT])).toEqual({
      stopped: true,
      byMode: "UNSUPERVISED_COMMITMENT",
    });
    expect(modeRegister.hardeningStopped([modeRegister.MODE.COLD_INDEX]).stopped).toBe(false);
  });

  test("Cold Index suspends nothing, because correctness never depended on the cache (I16)", () => {
    const coldIndex = modeRegister.MODES[modeRegister.MODE.COLD_INDEX];
    expect(coldIndex.suspendsInvariants).toEqual([]);
    expect(coldIndex.envelope.correctnessUnaffected).toBe(true);
    expect(modeRegister.behaviourOf("I16", modeRegister.MODE.COLD_INDEX).note).toMatch(/this mode \*\*is\*\* the test of I16/);
  });
});

"use strict";

/**
 * Engine lane — **P15-F1**: the minimum observation window belongs to the register, and the
 * caller may not state it.
 *
 * ── The finding ────────────────────────────────────────────────────────────
 * P15-E4 closed the *degenerate* values of `request.minObservationMs` and left the class
 * open. It refuses `0`, `NaN`, `±Infinity`, a string and `null`; it admits **any positive
 * finite number, however small**, because `evidence.admit()` can only ask whether a bound is
 * usable — it cannot ask whether it is *the* bound. Measured against the shipped modules
 * before this remediation, with `release.soak_duration = 72` hours and
 * `cutover.shadow_agreement_window = 14` days in the register:
 *
 *     *** ADMITTED + PASS ***  soak: window 2 000 ms, caller bound 1 000 ms
 *     *** ADMITTED + PASS ***  soak: window 1 ms,     caller bound 0.5 ms
 *     *** ADMITTED + PASS ***  shadow_agreement: window 1 000 ms, caller bound 1 000 ms
 *
 * A gate whose entire content is *"72 hours of production soak"* was discharged by a
 * one-second window, by adding one field to the request object. It was not hypothetical:
 * `tools/verify/phase15EvidenceBinding.js` supplied `soak: DAY` — 24 hours against 72 — and
 * its 17/17 green included a soak gate judged against a third of the required duration.
 *
 * ── The authority boundary this suite pins ─────────────────────────────────
 *
 *     authoriseEnable(request)
 *         → request.parameterValues            (the authoritative parameter source)
 *         → evidence.resolveMinObservationMs   (gate → registered parameter → duration)
 *         → evidence.admit                     (the adjudicator)
 *         → the release decision
 *
 * and **not** `request.minObservationMs → evidence.admit`, which is what it was.
 *
 * Every attack below is one of the mandate's cases A … M. The controls come first, because a
 * refusal from a fixture that could never have been authorised proves nothing: the honest
 * request must be authorised, and the register must be measured rather than assumed to say
 * 72 hours and 14 days.
 */

const evidence = require("../../src/engine/cutover/evidence");
const gates = require("../../src/engine/cutover/gates");
const guardrails = require("../../src/engine/cutover/guardrails");
const stage = require("../../src/engine/cutover/stage");
const configService = require("../../src/engine/config/service");

const NOW = Date.UTC(2026, 7, 25, 9, 0, 0);
const HOUR = 3600000;
const DAY = 24 * HOUR;
const DIGEST = "f".repeat(64);

/** The shipped register, read once. Nothing below hard-codes what it says. */
const REGISTER = configService.loadRegister({ reload: true });
const PARAMETER_VALUES = Object.freeze({
  get: (name) => (REGISTER.entries.get(name) || {}).default,
});

/** What the register actually requires, derived rather than typed. */
const AUTHORITATIVE = Object.freeze(evidence.resolveMinObservationMs(PARAMETER_VALUES));

const PRODUCTION_GATES = gates.RELEASE_GATES.filter((gate) => gate.evidence === gates.EVIDENCE.PRODUCTION);
const WINDOWED = Object.keys(evidence.MIN_OBSERVATION_PARAMETER).sort();

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/**
 * A green table. `windows` maps a gate id to that gate's observation window; every other
 * PRODUCTION gate gets a 60-day one, which clears every registered bound with room to spare.
 *
 * Per-gate rather than one window for the whole table, deliberately: `soak` requires hours
 * and `shadow_agreement` requires days, so a single shared window cannot put one of them
 * just below its bound while leaving the other admissible — and "which gate went red" is
 * the whole assertion in half the cases below.
 */
function greenTable(windows) {
  const table = {};
  for (const gate of gates.RELEASE_GATES) {
    if (gate.evidence === gates.EVIDENCE.BUILD || gate.evidence === gates.EVIDENCE.SUITE) {
      table[gate.id] = {
        gateId: gate.id,
        producedAtMs: NOW - 1000,
        producer: "tools/release/collectEvidence.js",
        run: { command: gate.command, exitCode: 0, build: { sourceDigest: DIGEST } },
        build: { sourceDigest: DIGEST },
      };
      continue;
    }
    if (gate.evidence === gates.EVIDENCE.PRODUCTION) {
      const window = (windows || {})[gate.id] || { windowStartedAtMs: NOW - 60 * DAY, windowEndedAtMs: NOW };
      table[gate.id] = {
        gateId: gate.id,
        producedAtMs: NOW - 1000,
        producer: "observability",
        owner: "sre-oncall",
        pass: true,
        observation: { source: "prod-metrics", ...window },
      };
      continue;
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
    if (gate.rehearsal === true) {
      record.rehearsal = {
        environment: { id: "staging-1", production: false },
        configVersion: "17",
        automaticRollbackFired: true,
        steps: Object.fromEntries(evidence.REHEARSAL_STEPS.map((step) => [step, true])),
      };
    }
    table[gate.id] = record;
  }
  return table;
}

/** A window of exactly `ms`, closing now. */
function windowOf(ms) {
  return { windowStartedAtMs: NOW - ms, windowEndedAtMs: NOW };
}

function enableRequest(overrides) {
  return {
    shard: { shardId: "shard-1", regionId: "region-alpha", state: "ACTIVE" },
    allShards: [{ shardId: "shard-1", regionId: "region-alpha", state: "ACTIVE", agentCount: 1 }],
    liveShardIds: [],
    releaseEvidence: greenTable(),
    killSwitchState: {},
    declaration: guardrails.declare({
      shardId: "shard-1",
      declaredBy: "release-manager",
      declaredAtMs: NOW - DAY,
      observationWindowSeconds: 3600,
      guardrails: [{ id: "commit_latency_p99", direction: "AT_MOST", threshold: 250, minSamples: 100, unit: "ms" }],
    }),
    requestedBy: "alice",
    approvedBy: "bob",
    reason: "stage the least-loaded shard first",
    requestedAtMs: NOW,
    sourceDigest: DIGEST,
    evidenceMaxAgeMs: DAY,
    parameterValues: PARAMETER_VALUES,
    ...overrides,
  };
}

/** The rows a refusal named, by gate id. */
function refusedGates(outcome) {
  return outcome.refusal.detail.map((row) => row.id).sort();
}

/* ── controls — without these every refusal below is vacuous ──────────────── */

describe("P15-F1 controls — the register is measured, and the honest request is authorised", () => {
  test("the authoritative requirement is the register's, and it is 72 h / 14 days", () => {
    // Derived from the register file, then checked against the figures §24.6 and §21.6 state,
    // so this test fails if either the parameter or the transcription moves.
    expect(REGISTER.entries.get("release.soak_duration").default).toBe(72);
    expect(REGISTER.entries.get("release.soak_duration").unit).toBe("hours");
    expect(REGISTER.entries.get("cutover.shadow_agreement_window").default).toBe(14);
    expect(REGISTER.entries.get("cutover.shadow_agreement_window").unit).toBe("days");

    expect(AUTHORITATIVE).toEqual({ soak: 72 * HOUR, shadow_agreement: 14 * DAY });
  });

  test("the gates the register bounds are exactly soak and shadow_agreement", () => {
    expect(WINDOWED).toEqual(["shadow_agreement", "soak"]);
  });

  test("CONTROL — a complete request with honest windows is authorised", () => {
    expect(stage.authoriseEnable(enableRequest()).authorised).toBe(true);
  });

  test("CONTROL — the authority does not over-refuse: 73 h of soak and 15 days of shadow pass", () => {
    const outcome = stage.authoriseEnable(
      enableRequest({
        releaseEvidence: greenTable({ soak: windowOf(73 * HOUR), shadow_agreement: windowOf(15 * DAY) }),
      }),
    );
    expect(outcome.authorised).toBe(true);
  });
});

/* ── A … E, G … J — the caller may not state the bound, in either direction ─ */

describe("P15-F1 — a request that states minObservationMs is refused, whatever it states", () => {
  /**
   * Cases A, B, C, D, E, G, H, I, J of the mandate, plus the shapes P15-E4 already refused
   * one layer down. Every one of them is refused **at the authority, by name**, before the
   * value reaches the adjudicator at all.
   *
   * Note case D. The mandate says a caller bound *equal* to the authoritative one "MAY PASS
   * only if all other requirements are satisfied" — `may`, not `must`. It does not pass here,
   * and that is requirement 8 taken literally: *"A caller-supplied larger value must also NOT
   * replace the authoritative requirement. The authority owns the requirement."* A bound that
   * happens to agree with the register today is still a bound the request declared, and an
   * authority that accepts an agreeing one has conceded that the number is the caller's — the
   * next caller states a smaller one, and the register moving to 96 h silently stops applying
   * to every request that had hard-coded 72. The test immediately below is the half of case D
   * that matters: the *same request* with the field removed is authorised, so nothing about a
   * genuine 72-hour soak has been made unpassable.
   */
  test.each([
    ["A — soak, 1 ms against an authoritative 72 h", { soak: 1 }],
    ["B — soak, 1 000 ms against an authoritative 72 h", { soak: 1000 }],
    ["C — soak, 24 h against an authoritative 72 h", { soak: 24 * HOUR }],
    ["D — soak, exactly the authoritative 72 h", { soak: 72 * HOUR }],
    ["D′ — soak, 100 days: larger does not replace either", { soak: 100 * DAY }],
    ["E — shadow_agreement, 1 ms against an authoritative 14 days", { shadow_agreement: 1 }],
    ["G — a bound of zero", { soak: 0, shadow_agreement: 0 }],
    ["H — a bound of NaN", { soak: NaN, shadow_agreement: NaN }],
    ["I — a bound of Infinity", { soak: Infinity }],
    ["I′ — a bound of −Infinity", { soak: -Infinity }],
    ["J — a negative bound", { soak: -1, shadow_agreement: -1 }],
    ["a numeric string", { soak: "1000" }],
    ["null bounds", { soak: null, shadow_agreement: null }],
    ["an empty object — the field is present and says nothing", {}],
  ])("%s is refused by name", (_case, bound) => {
    const outcome = stage.authoriseEnable(enableRequest({ minObservationMs: bound }));

    expect(outcome.authorised).toBe(false);
    expect(outcome.refusal.code).toBe(stage.REFUSAL.OBSERVATION_BOUND_NOT_THE_CALLERS);
    // The refusal names the field and the parameters that own it, so the operator's next
    // action is "supply parameterValues" and not "look at the release".
    expect(outcome.refusal.message).toMatch(/minObservationMs/);
    expect(outcome.refusal.message).toMatch(/release\.soak_duration/);
    expect(outcome.refusal.message).toMatch(/cutover\.shadow_agreement_window/);
    expect(outcome.refusal.detail).toMatchObject({ field: "minObservationMs" });
  });

  test("the field is refused even when its value is `undefined` — presence is the test", () => {
    // The realistic producer is a spread: `{ ...adjudicatorContext }` from a fixture that
    // holds the adjudicator's own context. A `typeof`-shaped guard would let that through
    // whenever the value happened to be undefined, which is the exact off-switch shape
    // P15-C1, P15-E1, P15-E3 and P15-E4 were each an instance of.
    const outcome = stage.authoriseEnable(enableRequest({ minObservationMs: undefined }));
    expect(outcome.refusal.code).toBe(stage.REFUSAL.OBSERVATION_BOUND_NOT_THE_CALLERS);
  });

  test("D, the other half — the identical request without the field is authorised", () => {
    const stated = enableRequest({ minObservationMs: { soak: 72 * HOUR, shadow_agreement: 14 * DAY } });
    expect(stage.authoriseEnable(stated).authorised).toBe(false);

    const request = { ...stated };
    delete request.minObservationMs;
    expect(stage.authoriseEnable(request).authorised).toBe(true);
  });

  test("no other refusal is produced first — the shard, reason and purpose are all valid", () => {
    // Guards against the case the mandate warns about: a refusal that happens for an
    // unrelated reason proves nothing about the protection under test.
    const outcome = stage.authoriseEnable(enableRequest({ minObservationMs: { soak: 1 } }));
    expect(outcome.refusal.code).not.toBe(stage.REFUSAL.SHARD_NOT_ELIGIBLE);
    expect(outcome.refusal.code).not.toBe(stage.REFUSAL.NO_REASON_GIVEN);
    expect(outcome.refusal.code).not.toBe(stage.REFUSAL.EVIDENCE_CONTEXT_INCOMPLETE);
    expect(outcome.action).toBeNull();
  });
});

/* ── F, M — with nothing stated, the register is what applies ─────────────── */

describe("P15-F1 case F — omitting the bound evaluates the authoritative register, not nothing", () => {
  test("a 71 h soak is refused as TOO_SHORT, naming 72 h — the register's number, applied", () => {
    const outcome = stage.authoriseEnable(
      enableRequest({ releaseEvidence: greenTable({ soak: windowOf(71 * HOUR) }) }),
    );

    expect(outcome.authorised).toBe(false);
    expect(outcome.refusal.code).toBe(stage.REFUSAL.RELEASE_GATE_NOT_GREEN);
    expect(refusedGates(outcome)).toEqual(["soak"]);

    const row = outcome.refusal.detail[0];
    /**
     * `TOO_SHORT`, not `REQUIRED`. The distinction is the whole of case M.
     *
     * Substitute `source.minObservationMs` back for the register resolution and this window
     * is *still* refused — but as `OBSERVATION_WINDOW_REQUIRED`, because the caller states
     * nothing and the bound then resolves to nothing. "Refused" is therefore not evidence
     * that the register was consulted; "refused *for being 71 hours against 72*" is.
     */
    expect(row.inadmissibleCode).toBe(evidence.INADMISSIBLE.OBSERVATION_WINDOW_TOO_SHORT);
    expect(row.detail).toMatch(/requires 72h/);
  });

  test("a 73 h soak passes — so the bound is 72 h and not 'any window is refused'", () => {
    const outcome = stage.authoriseEnable(
      enableRequest({ releaseEvidence: greenTable({ soak: windowOf(73 * HOUR) }) }),
    );
    expect(outcome.authorised).toBe(true);
  });

  test("a 13-day shadow window is refused as TOO_SHORT and a 15-day one passes", () => {
    const short = stage.authoriseEnable(
      enableRequest({ releaseEvidence: greenTable({ shadow_agreement: windowOf(13 * DAY) }) }),
    );
    expect(refusedGates(short)).toEqual(["shadow_agreement"]);
    expect(short.refusal.detail[0].inadmissibleCode).toBe(evidence.INADMISSIBLE.OBSERVATION_WINDOW_TOO_SHORT);

    const long = stage.authoriseEnable(
      enableRequest({ releaseEvidence: greenTable({ shadow_agreement: windowOf(15 * DAY) }) }),
    );
    expect(long.authorised).toBe(true);
  });

  test("M — a one-second window on both windowed gates is refused for their own durations", () => {
    // The measured pre-fix attack, with the caller's bound now impossible to supply.
    const outcome = stage.authoriseEnable(
      enableRequest({
        releaseEvidence: greenTable({ soak: windowOf(1000), shadow_agreement: windowOf(1000) }),
      }),
    );
    expect(outcome.authorised).toBe(false);
    expect(refusedGates(outcome)).toEqual(WINDOWED);
    for (const row of outcome.refusal.detail) {
      expect(row.inadmissibleCode).toBe(evidence.INADMISSIBLE.OBSERVATION_WINDOW_TOO_SHORT);
    }
  });

  test("the two unregistered PRODUCTION gates are untouched — no bound was invented for them", () => {
    // `invariants_enforced` and `simulator_fidelity` have no registered duration. The fix
    // must not have given them one: they require a real window, and nothing more.
    const unbounded = PRODUCTION_GATES.filter((gate) => !WINDOWED.includes(gate.id)).map((gate) => gate.id);
    expect(unbounded.sort()).toEqual(["invariants_enforced", "simulator_fidelity"]);

    const windows = Object.fromEntries(unbounded.map((id) => [id, windowOf(1000)]));
    expect(stage.authoriseEnable(enableRequest({ releaseEvidence: greenTable(windows) })).authorised).toBe(true);
  });
});

/* ── K, L — the authoritative source itself fails closed ──────────────────── */

describe("P15-F1 cases K and L — missing or invalid authoritative data fails closed", () => {
  test("K — an absent parameter source refuses the request by name, not the gates", () => {
    const request = enableRequest();
    delete request.parameterValues;

    const outcome = stage.authoriseEnable(request);
    expect(outcome.authorised).toBe(false);
    expect(outcome.refusal.code).toBe(stage.REFUSAL.EVIDENCE_CONTEXT_INCOMPLETE);
    expect(outcome.refusal.message).toMatch(/parameterValues/);
    // Reported as a missing dependency rather than as an unpassable release — the operator
    // is sent to their request, which is where the defect is.
    expect(outcome.refusal.detail.join(" ")).toMatch(/parameterValues/);
  });

  test.each([
    ["null", null],
    ["an empty object", {}],
    ["a plain map with no `get`", { soak: 72 * HOUR }],
    ["a string", "release.soak_duration=72"],
    ["a number", 72],
    ["`get` that is not a function", { get: 72 * HOUR }],
  ])("K — a parameter source that is %s is refused, never defaulted", (_name, values) => {
    const outcome = stage.authoriseEnable(enableRequest({ parameterValues: values }));
    expect(outcome.authorised).toBe(false);
    expect(outcome.refusal.code).toBe(stage.REFUSAL.EVIDENCE_CONTEXT_INCOMPLETE);
  });

  test("K — a source that answers nothing leaves the two windowed gates inadmissible", () => {
    // The register is readable and simply does not hold the parameters. That is not the
    // request's defect, so the request is judged — and the two gates the missing parameters
    // bound go RED. Missing is not zero and is not unlimited: a 60-day window does not
    // discharge them.
    const outcome = stage.authoriseEnable(enableRequest({ parameterValues: { get: () => undefined } }));

    expect(outcome.authorised).toBe(false);
    expect(outcome.refusal.code).toBe(stage.REFUSAL.RELEASE_GATE_NOT_GREEN);
    expect(refusedGates(outcome)).toEqual(WINDOWED);
    for (const row of outcome.refusal.detail) {
      expect(row.inadmissibleCode).toBe(evidence.INADMISSIBLE.OBSERVATION_WINDOW_REQUIRED);
    }
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["a numeric string", "72"],
    ["null", null],
    ["a boolean", true],
    ["an object", { hours: 72 }],
  ])("L — a register value of %s is not a bound: both gates stay inadmissible", (_name, value) => {
    const outcome = stage.authoriseEnable(enableRequest({ parameterValues: { get: () => value } }));

    expect(outcome.authorised).toBe(false);
    expect(refusedGates(outcome)).toEqual(WINDOWED);
    for (const row of outcome.refusal.detail) {
      expect(row.inadmissibleCode).toBe(evidence.INADMISSIBLE.OBSERVATION_WINDOW_REQUIRED);
    }
  });

  test("L — a register value of 0 does not read as 'no requirement' at the producer either", () => {
    // Both sides of the producer/consumer pair, pinned together, for the reason P15-E4 gives:
    // a guard on one side is how the two came to disagree in the first place.
    expect(evidence.resolveMinObservationMs({ get: () => 0 })).toEqual({});
    expect(evidence.resolveMinObservationMs({ get: () => undefined })).toEqual({});
  });

  /**
   * ── The authority must not fabricate a bound, even a failing one (mutant MU3) ──
   *
   * Found by the P15-F1 mutation attack. Replace the resolution with
   *
   *     minObservationMs = { soak: 0, shadow_agreement: 0, ...resolveMinObservationMs(…) }
   *
   * — a missing parameter defaulting to zero instead of being omitted — and the whole
   * P15-F1 suite still passed, 239/239. The cutover was still refused, because
   * `evidence.admit()` independently refuses a bound of `0`; the mutant was caught by the
   * *consumer's* guard and by nothing on the producing side.
   *
   * That is defence in depth working, and it is also the exact asymmetry this programme has
   * now found four times (P15-C1's age bound, P15-E4's zero bound, P15-F1 itself): a guard on
   * one side of a producer/consumer pair, with no test standing behind the other. Relax the
   * consumer — which P15-E4 shows is a live possibility, since that guard did not exist until
   * this phase — and the fabricated zero becomes a soak gate any window discharges.
   *
   * It also puts a number the register never stated into the record an operator reads. The
   * shipped authority reports `(got undefined)` — *nothing resolved* — for a parameter that is
   * absent and for one that holds an unusable value alike, because `resolveMinObservationMs`
   * omits both; that merging is deliberate and documented, and both states fail closed
   * identically. `(got 0)` is a third thing, and it is a claim about the register that is
   * false: it says the register answered zero when the register did not answer at all.
   *
   * So the producing side is pinned here, at the authority boundary rather than on the
   * helper: the authority resolves the bound or it does not, and it never supplies one on the
   * register's behalf.
   */
  test("an unresolvable parameter yields no bound — the authority never fabricates a zero", () => {
    const absent = stage.authoriseEnable(enableRequest({ parameterValues: { get: () => undefined } }));
    const zero = stage.authoriseEnable(enableRequest({ parameterValues: { get: () => 0 } }));

    // Both fail closed, and both fail closed on the same two rows.
    expect(refusedGates(absent)).toEqual(WINDOWED);
    expect(refusedGates(zero)).toEqual(WINDOWED);

    // And in both the authority reports that nothing resolved, rather than reporting a value
    // it invented. A `(got 0)` here is the fabricated bound, and it is what MU3 produces.
    for (const outcome of [absent, zero]) {
      for (const row of outcome.refusal.detail) {
        expect(row.detail).toMatch(/did not resolve to a positive duration \(got undefined\)/);
        expect(row.detail).not.toMatch(/\(got 0\)/);
      }
    }
  });

  test("a parameter source that throws refuses the request rather than judging half a table", () => {
    const outcome = stage.authoriseEnable(
      enableRequest({
        parameterValues: {
          get() {
            throw new Error("the configuration snapshot is not loaded");
          },
        },
      }),
    );

    expect(outcome.authorised).toBe(false);
    expect(outcome.refusal.code).toBe(stage.REFUSAL.PARAMETER_REGISTER_UNREADABLE);
    expect(outcome.refusal.message).toMatch(/not loaded/);
  });

  test("one parameter present and the other absent refuses exactly one gate", () => {
    // The four states stay four. This is the one that would collapse first if a default were
    // ever introduced: a register that has lost `release.soak_duration` must redden `soak`
    // and leave `shadow_agreement` green, not take the whole table down and not invent 72.
    const outcome = stage.authoriseEnable(
      enableRequest({
        parameterValues: {
          get: (name) => (name === "release.soak_duration" ? undefined : PARAMETER_VALUES.get(name)),
        },
      }),
    );

    expect(refusedGates(outcome)).toEqual(["soak"]);
    expect(outcome.refusal.detail[0].inadmissibleCode).toBe(evidence.INADMISSIBLE.OBSERVATION_WINDOW_REQUIRED);
  });
});

/* ── the authority boundary, asserted structurally ────────────────────────── */

describe("P15-F1 — the authority boundary itself", () => {
  test("a REHEARSAL is bound by the register too — the exclusion set is one gate and it is not these", () => {
    // ADR-34 sets aside exactly `rollback_rehearsed`. Neither windowed gate is excluded, so a
    // rehearsal cannot be the way a short soak reaches a live shard.
    expect(stage.REHEARSAL_EXCLUDED_GATES).toEqual(["rollback_rehearsed"]);
    for (const gateId of WINDOWED) expect(stage.REHEARSAL_EXCLUDED_GATES).not.toContain(gateId);

    const outcome = stage.authoriseEnable(
      enableRequest({
        purpose: stage.PURPOSE.REHEARSAL,
        environment: { id: "staging-eu-west", production: false },
        releaseEvidence: greenTable({ soak: windowOf(1000) }),
      }),
    );
    expect(outcome.authorised).toBe(false);
    expect(refusedGates(outcome)).toEqual(["soak"]);
  });

  test("a rehearsal may not state the bound either", () => {
    const outcome = stage.authoriseEnable(
      enableRequest({
        purpose: stage.PURPOSE.REHEARSAL,
        environment: { id: "staging-eu-west", production: false },
        minObservationMs: { soak: 1000 },
      }),
    );
    expect(outcome.refusal.code).toBe(stage.REFUSAL.OBSERVATION_BOUND_NOT_THE_CALLERS);
  });

  test("the module source no longer reads the bound from the request", () => {
    /**
     * A structural assertion, and it earns its place: every behavioural test above passes
     * against an implementation that resolves from the register *and also* honours a
     * caller's bound when one slips past the guard. This one fails if the pass-through
     * comes back in any form, which is the mutation the mandate asks to be caught.
     */
    const source = require("fs").readFileSync(require.resolve("../../src/engine/cutover/stage"), "utf8");
    const body = source.slice(source.indexOf("function authoriseEnable"), source.indexOf("function authoriseRollback"));

    // The resolution is present and it is the register's.
    expect(body).toMatch(/evidence\.resolveMinObservationMs\(\s*source\.parameterValues\s*\)/);
    // And `source.minObservationMs` appears nowhere except in the refusal that rejects it.
    const reads = body.split("\n").filter((line) => /source\.minObservationMs/.test(line) && !/^\s*(\*|\/\/)/.test(line));
    expect(reads.map((line) => line.trim())).toEqual([
      '{ field: "minObservationMs", supplied: source.minObservationMs },',
    ]);
  });

  test("the adjudicator still takes a bound — the authority is what stopped taking one", () => {
    // `evidence.admit()` and `gates.evaluate()` keep their context contract unchanged. This
    // is deliberate: `tools/release/verdict.js` resolves from the register and passes the
    // result in, and that path was never the defect. Nothing here narrowed it.
    const record = {
      gateId: "soak",
      producedAtMs: NOW - 1000,
      producer: "observability",
      owner: "sre-oncall",
      pass: true,
      observation: { source: "prod-metrics", ...windowOf(73 * HOUR) },
    };
    const context = { nowMs: NOW, maxAgeMs: DAY, sourceDigest: DIGEST, minObservationMs: AUTHORITATIVE };
    expect(evidence.admit(gates.GATE_BY_ID.soak, record, context)).toMatchObject({ admissible: true, pass: true });
  });

  test("no threshold moved: the register's two values are exactly what the fix applies", () => {
    // The closure criterion "no threshold is changed", asserted rather than promised.
    expect(AUTHORITATIVE.soak).toBe(REGISTER.entries.get("release.soak_duration").default * HOUR);
    expect(AUTHORITATIVE.shadow_agreement).toBe(
      REGISTER.entries.get("cutover.shadow_agreement_window").default * DAY,
    );
  });
});

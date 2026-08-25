"use strict";

/**
 * Engine lane — the third current-tree Phase 15 re-audit's findings (P15-E1, E2, E3).
 *
 * ── What these three have in common, and how it differs from the last four ──
 * The previous pass closed four findings of the form *"a rule enforced only when the caller
 * happens to supply the input it is enforced against"*, and wrote that its lesson was:
 *
 * > A protection guarded by `typeof x === "number"` is a protection with an off switch, and
 * > the off switch is "omit the argument."
 *
 * It then fixed four of those guards and left three standing. These are the three, and two of
 * them have a sharper off switch than omission: **`typeof NaN === "number"`**. A caller need
 * not omit anything. It supplies a value of the right type that every comparison is false
 * against, and the check does not fail — it does not run.
 *
 *   P15-E1  `evidence.admit()`'s PRODUCTION branch read both observation-window endpoints
 *           through `typeof … === "number"`. `duration <= 0` and `duration < required` are
 *           both false for `NaN`, so a record carrying `{ windowStartedAtMs: NaN,
 *           windowEndedAtMs: NaN, pass: true }` was admitted and passed — for all four
 *           PRODUCTION gates, which are exactly the four this programme has classified pass
 *           after pass as *not closable by any commit in this repository*. Measured: an
 *           honest one-second soak was refused and a `NaN` one was not.
 *
 *   P15-E2  `rollbackPublisher.create()` documents `versionInForce` as *"the payload of the
 *           currently **pinned** configuration version"*; `server.js` supplied
 *           `findFirst({ orderBy: { version: "desc" } })`, the **latest published** one.
 *           Those differ whenever a version is published without being pinned, which
 *           `config.controller.publishVersion` supports by design. A payload alone cannot
 *           say which version it is, which is why nothing could see the disagreement.
 *
 *   P15-E3  the same `typeof`/`NaN` shape in `guardrails.assess()`, where it switched off
 *           both the pre-declaration ordering refusal — *"the refusal this module exists
 *           for"* — and the window-length requirement, and returned `PROCEED`.
 *
 * Every assertion below fails on the unremediated tree.
 */

const evidence = require("../../src/engine/cutover/evidence");
const gates = require("../../src/engine/cutover/gates");
const guardrails = require("../../src/engine/cutover/guardrails");
const rollbackPublisher = require("../../src/engine/cutover/rollbackPublisher");
const stage = require("../../src/engine/cutover/stage");
const configService = require("../../src/engine/config/service");

const NOW = Date.UTC(2026, 7, 24, 12, 0, 0);
const HOUR = 3600000;
const DAY = 24 * HOUR;
const DIGEST = "e".repeat(64);

/**
 * P15-F1 — the authoritative parameter source. The **real** register, deliberately: the
 * finding is that a caller could state the bound, so a fixture that states it through a stub
 * would reproduce the defect rather than exercise the fix.
 */
const REGISTER = configService.loadRegister({ reload: true });
const PARAMETER_VALUES = Object.freeze({
  get: (name) => (REGISTER.entries.get(name) || {}).default,
});

const CONTEXT = Object.freeze({
  nowMs: NOW,
  maxAgeMs: DAY,
  sourceDigest: DIGEST,
  minObservationMs: { shadow_agreement: 14 * DAY, soak: 72 * HOUR },
});

const PRODUCTION_GATES = gates.RELEASE_GATES.filter((gate) => gate.evidence === gates.EVIDENCE.PRODUCTION);

/** An admissible PRODUCTION record whose window is whatever the caller names. */
function productionRecord(gateId, window) {
  return {
    gateId,
    producedAtMs: NOW - 1000,
    producer: "observability",
    owner: "sre-oncall",
    pass: true,
    observation: { source: "prod-metrics", ...window },
  };
}

function rehearsal() {
  return {
    environment: { id: "staging-1", production: false },
    configVersion: "17",
    automaticRollbackFired: true,
    steps: Object.fromEntries(evidence.REHEARSAL_STEPS.map((step) => [step, true])),
  };
}

function greenRecord(gate, window) {
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
    return productionRecord(gate.id, window || { windowStartedAtMs: NOW - 40 * DAY, windowEndedAtMs: NOW });
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
  if (gate.rehearsal === true) record.rehearsal = rehearsal();
  return record;
}

function greenTable(window) {
  const table = {};
  for (const gate of gates.RELEASE_GATES) table[gate.id] = greenRecord(gate, window);
  return table;
}

function validDeclaration(overrides) {
  return guardrails.declare({
    shardId: "shard-1",
    declaredBy: "release-manager",
    declaredAtMs: NOW - DAY,
    observationWindowSeconds: 3600,
    guardrails: [{ id: "commit_latency_p99", direction: "AT_MOST", threshold: 250, minSamples: 100, unit: "ms" }],
    ...overrides,
  });
}

function enableRequest(window) {
  return {
    shard: { shardId: "shard-1", regionId: "region-alpha", state: "ACTIVE" },
    allShards: [{ shardId: "shard-1", regionId: "region-alpha", state: "ACTIVE", agentCount: 1 }],
    liveShardIds: [],
    releaseEvidence: greenTable(window),
    killSwitchState: {},
    declaration: validDeclaration(),
    requestedBy: "alice",
    approvedBy: "bob",
    reason: "stage the least-loaded shard first",
    requestedAtMs: NOW,
    sourceDigest: DIGEST,
    evidenceMaxAgeMs: DAY,
    // P15-F1 — no `minObservationMs`. The authority resolves it from the register.
    parameterValues: PARAMETER_VALUES,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// P15-E1 — an observation window is an interval, not two values of type number
// ─────────────────────────────────────────────────────────────────────────────

describe("P15-E1 — evidence.admit() refuses a PRODUCTION window it cannot measure", () => {
  const gate = gates.GATE_BY_ID.soak;

  test("the honest fixture is admitted, so every refusal below is about the window alone", () => {
    const verdict = evidence.admit(
      gate,
      productionRecord("soak", { windowStartedAtMs: NOW - 40 * DAY, windowEndedAtMs: NOW }),
      CONTEXT,
    );
    expect(verdict).toMatchObject({ admissible: true, pass: true });
  });

  test.each([
    ["both endpoints NaN", { windowStartedAtMs: NaN, windowEndedAtMs: NaN }],
    ["the end NaN", { windowStartedAtMs: NOW - 40 * DAY, windowEndedAtMs: NaN }],
    ["the start NaN", { windowStartedAtMs: NaN, windowEndedAtMs: NOW }],
    ["the end Infinity", { windowStartedAtMs: 0, windowEndedAtMs: Infinity }],
    ["the start -Infinity", { windowStartedAtMs: -Infinity, windowEndedAtMs: NOW }],
    ["numeric strings", { windowStartedAtMs: String(NOW - 40 * DAY), windowEndedAtMs: String(NOW) }],
    ["a null endpoint", { windowStartedAtMs: null, windowEndedAtMs: NOW }],
    ["an absent endpoint", { windowEndedAtMs: NOW }],
  ])("%s is refused, not compared", (_name, window) => {
    const verdict = evidence.admit(gate, productionRecord("soak", window), CONTEXT);
    expect(verdict.admissible).toBe(false);
    expect(verdict.code).toBe(evidence.INADMISSIBLE.OBSERVATION_WINDOW_REQUIRED);
    expect(verdict.pass).toBe(false);
  });

  test("the defect: an honest short window is refused and a NaN one was not", () => {
    // This pair is the whole finding. Before the remediation the first of these refused and
    // the second was admitted-and-passing — the check was absent exactly for the malformed
    // record and present for the honest one.
    const honest = evidence.admit(
      gate,
      productionRecord("soak", { windowStartedAtMs: NOW - 1000, windowEndedAtMs: NOW }),
      CONTEXT,
    );
    expect(honest.code).toBe(evidence.INADMISSIBLE.OBSERVATION_WINDOW_TOO_SHORT);

    const malformed = evidence.admit(gate, productionRecord("soak", { windowStartedAtMs: NaN, windowEndedAtMs: NaN }), CONTEXT);
    expect(malformed.admissible).toBe(false);
    expect(malformed.pass).toBe(false);
  });

  test("the requirement holds for every PRODUCTION gate, not only the two with a minimum", () => {
    // `soak` and `shadow_agreement` have a MIN_OBSERVATION_PARAMETER entry;
    // `invariants_enforced` and `simulator_fidelity` do not, and their only duration rule is
    // `duration <= 0` — which is the one NaN slipped past most quietly.
    for (const gate of PRODUCTION_GATES) {
      const verdict = evidence.admit(gate, productionRecord(gate.id, { windowStartedAtMs: NaN, windowEndedAtMs: NaN }), CONTEXT);
      expect({ id: gate.id, code: verdict.code }).toEqual({
        id: gate.id,
        code: evidence.INADMISSIBLE.OBSERVATION_WINDOW_REQUIRED,
      });
    }
    expect(PRODUCTION_GATES.map((gate) => gate.id).sort()).toEqual([
      "invariants_enforced",
      "shadow_agreement",
      "simulator_fidelity",
      "soak",
    ]);
  });

  test("a window that closes after the instant it is read is refused", () => {
    const verdict = evidence.admit(
      gates.GATE_BY_ID.invariants_enforced,
      productionRecord("invariants_enforced", { windowStartedAtMs: NOW - 40 * DAY, windowEndedAtMs: NOW + DAY }),
      CONTEXT,
    );
    expect(verdict.admissible).toBe(false);
    expect(verdict.code).toBe(evidence.INADMISSIBLE.OBSERVATION_WINDOW_REQUIRED);
    expect(verdict.detail).toMatch(/has not finished has not been observed/);
  });

  test("a window ending exactly now is admitted — the bound is not off by one", () => {
    const verdict = evidence.admit(
      gates.GATE_BY_ID.invariants_enforced,
      productionRecord("invariants_enforced", { windowStartedAtMs: NOW - 40 * DAY, windowEndedAtMs: NOW }),
      CONTEXT,
    );
    expect(verdict).toMatchObject({ admissible: true, pass: true });
  });

  test("the honest bounds still bind: a 71-hour soak is short and a 73-hour one is not", () => {
    const short = evidence.admit(
      gates.GATE_BY_ID.soak,
      productionRecord("soak", { windowStartedAtMs: NOW - 71 * HOUR, windowEndedAtMs: NOW }),
      CONTEXT,
    );
    expect(short.code).toBe(evidence.INADMISSIBLE.OBSERVATION_WINDOW_TOO_SHORT);

    const long = evidence.admit(
      gates.GATE_BY_ID.soak,
      productionRecord("soak", { windowStartedAtMs: NOW - 73 * HOUR, windowEndedAtMs: NOW }),
      CONTEXT,
    );
    expect(long).toMatchObject({ admissible: true, pass: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P15-E4 — the minimum-observation bound is caller-supplied, and zero is not a bound
// ─────────────────────────────────────────────────────────────────────────────

describe("P15-E4 — a minimum window of zero does not discharge a gate whose content is a duration", () => {
  const WINDOWED = Object.keys(evidence.MIN_OBSERVATION_PARAMETER);
  const oneMillisecond = { windowStartedAtMs: NOW - 1, windowEndedAtMs: NOW };

  test("the two windowed gates are the ones the register bounds", () => {
    expect(WINDOWED.sort()).toEqual(["shadow_agreement", "soak"]);
  });

  test.each([
    ["zero", 0],
    ["NaN", NaN],
    ["negative", -1],
    ["Infinity", Infinity],
    ["a numeric string", "259200000"],
    ["null", null],
  ])("a bound of %s is refused, so a one-millisecond window discharges nothing", (_name, bound) => {
    for (const gateId of WINDOWED) {
      const verdict = evidence.admit(gates.GATE_BY_ID[gateId], productionRecord(gateId, oneMillisecond), {
        ...CONTEXT,
        minObservationMs: { [gateId]: bound },
      });
      expect({ gateId, code: verdict.code }).toEqual({
        gateId,
        code: evidence.INADMISSIBLE.OBSERVATION_WINDOW_REQUIRED,
      });
    }
  });

  test("an absent bound is still refused — the P15-C1-era behaviour is unchanged", () => {
    const verdict = evidence.admit(gates.GATE_BY_ID.soak, productionRecord("soak", oneMillisecond), {
      ...CONTEXT,
      minObservationMs: {},
    });
    expect(verdict.code).toBe(evidence.INADMISSIBLE.OBSERVATION_WINDOW_REQUIRED);
  });

  test("a real bound still bounds: the honest short window is TOO_SHORT, not UNBOUNDED", () => {
    const verdict = evidence.admit(gates.GATE_BY_ID.soak, productionRecord("soak", oneMillisecond), CONTEXT);
    expect(verdict.code).toBe(evidence.INADMISSIBLE.OBSERVATION_WINDOW_TOO_SHORT);
  });

  test("the legitimate producer can never emit a zero or non-finite bound", () => {
    // The guard existed on the producing side and not on the consuming side, which is how
    // the two came to disagree. Both are pinned here so neither can drift alone.
    for (const bad of [0, -1, NaN, Infinity, "72", null, undefined]) {
      const resolved = evidence.resolveMinObservationMs({ get: () => bad });
      expect(resolved).toEqual({});
    }
    const good = evidence.resolveMinObservationMs({ get: (name) => (name === "release.soak_duration" ? 72 : 14) });
    expect(good.soak).toBe(72 * HOUR);
    expect(good.shadow_agreement).toBe(14 * DAY);
  });

  test("the defect, at the authority: a request cannot bring its own zero bound", () => {
    // P15-F1 strengthened this. A request may no longer state the bound *at all*, so the
    // zero never reaches the adjudicator and the refusal names the field rather than the
    // gates. The original assertion — that a one-millisecond window discharges neither
    // windowed gate — is made immediately below, now against the register's own bound.
    const request = enableRequest({ windowStartedAtMs: NOW - 1, windowEndedAtMs: NOW });
    request.minObservationMs = { shadow_agreement: 0, soak: 0 };
    const outcome = stage.authoriseEnable(request);
    expect(outcome.authorised).toBe(false);
    expect(outcome.refusal.code).toBe(stage.REFUSAL.OBSERVATION_BOUND_NOT_THE_CALLERS);
  });

  test("and with no bound stated, the register's own refuses that same window", () => {
    const outcome = stage.authoriseEnable(enableRequest({ windowStartedAtMs: NOW - 1, windowEndedAtMs: NOW }));
    expect(outcome.authorised).toBe(false);
    expect(outcome.refusal.code).toBe(stage.REFUSAL.RELEASE_GATE_NOT_GREEN);
    expect(outcome.refusal.detail.map((row) => row.id)).toEqual(expect.arrayContaining(WINDOWED));
  });

  test("a caller-supplied bound may only ever be stricter, never looser", () => {
    // A bound for a gate the register does not bound is still honoured — that direction is
    // safe, and refusing it would be refusing extra caution.
    const verdict = evidence.admit(
      gates.GATE_BY_ID.invariants_enforced,
      productionRecord("invariants_enforced", { windowStartedAtMs: NOW - HOUR, windowEndedAtMs: NOW }),
      { ...CONTEXT, minObservationMs: { invariants_enforced: 14 * DAY } },
    );
    expect(verdict.code).toBe(evidence.INADMISSIBLE.OBSERVATION_WINDOW_TOO_SHORT);
  });
});

describe("P15-E1 — stage.authoriseEnable() is the call this reached", () => {
  test("a fully green table with honest windows authorises", () => {
    expect(stage.authoriseEnable(enableRequest()).authorised).toBe(true);
  });

  test.each([
    ["NaN", { windowStartedAtMs: NaN, windowEndedAtMs: NaN }],
    ["Infinity", { windowStartedAtMs: 0, windowEndedAtMs: Infinity }],
    ["not yet closed", { windowStartedAtMs: NOW - 40 * DAY, windowEndedAtMs: NOW + 40 * DAY }],
  ])("a %s observation window does not take a shard live", (_name, window) => {
    const outcome = stage.authoriseEnable(enableRequest(window));
    expect(outcome.authorised).toBe(false);
    expect(outcome.refusal.code).toBe(stage.REFUSAL.RELEASE_GATE_NOT_GREEN);
    // Every PRODUCTION gate, and only those: the rest of the table is untouched.
    expect(outcome.refusal.detail.map((row) => row.id).sort()).toEqual(PRODUCTION_GATES.map((gate) => gate.id).sort());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P15-E2 — the automatic rollback's base configuration
// ─────────────────────────────────────────────────────────────────────────────

describe("P15-E2 — the rollback publisher reads the version in force", () => {
  const REGION = "region-alpha";

  function action() {
    return stage.authoriseRollback({
      shard: { shardId: "shard-1", regionId: REGION },
      automatic: true,
      reason: "a pre-declared SLI guardrail regressed",
      requestedAtMs: NOW,
    }).action;
  }

  function publisherOver(reading) {
    const published = [];
    const pinned = [];
    const instance = rollbackPublisher.create({
      versionInForce: async () => reading,
      publish: async (request) => {
        published.push(request);
        return { version: 42 };
      },
      pin: async (version, publishedBy) => pinned.push({ version, publishedBy }),
    });
    return { instance, published, pinned };
  }

  const payload = Object.freeze({
    bindings: [{ level: "region", key: REGION, name: "cutover.engine_enabled", value: true }],
    killSwitchState: {},
    regimes: [],
  });

  test("a reading that is a bare payload is refused, not read as one", async () => {
    // The pre-remediation shape. It is refused rather than accepted because a payload cannot
    // say which version it is — which is precisely how the composition root came to supply
    // the wrong one without anything noticing.
    const { instance, published, pinned } = publisherOver(payload);
    const outcome = await instance.publishRollback(action());
    expect(outcome.published).toBe(false);
    expect(outcome.refusal.code).toBe(rollbackPublisher.REFUSAL.VERSION_IN_FORCE_UNREADABLE);
    expect(published).toHaveLength(0);
    expect(pinned).toHaveLength(0);
  });

  test.each([
    ["no version", { latestVersion: 7, payload }],
    ["no latestVersion", { version: 7, payload }],
    ["no payload", { version: 7, latestVersion: 7 }],
    ["a non-integer version", { version: 7.5, latestVersion: 7.5, payload }],
    ["a payload that is not an object", { version: 7, latestVersion: 7, payload: "bindings" }],
  ])("a reading with %s is refused", async (_name, reading) => {
    const { instance, published } = publisherOver(reading);
    const outcome = await instance.publishRollback(action());
    expect(outcome.refusal.code).toBe(rollbackPublisher.REFUSAL.VERSION_IN_FORCE_UNREADABLE);
    expect(published).toHaveLength(0);
  });

  test("the version in force being the latest is the ordinary case, and it publishes", async () => {
    const { instance, published, pinned } = publisherOver({ version: 7, latestVersion: 7, payload });
    const outcome = await instance.publishRollback(action());
    expect(outcome).toMatchObject({ published: true, version: 42, pinned: true });
    expect(published[0].bindings).toContainEqual({
      level: "region",
      key: REGION,
      name: "cutover.engine_enabled",
      value: false,
    });
    expect(pinned).toEqual([{ version: 42, publishedBy: rollbackPublisher.PUBLISHER }]);
  });

  test("an unpinned successor is refused rather than superseded in either direction", async () => {
    const { instance, published, pinned } = publisherOver({ version: 7, latestVersion: 8, payload });
    const outcome = await instance.publishRollback(action());
    expect(outcome.published).toBe(false);
    expect(outcome.refusal.code).toBe(rollbackPublisher.REFUSAL.SUPERSEDES_AN_UNPINNED_VERSION);
    expect(published).toHaveLength(0);
    expect(pinned).toHaveLength(0);
  });

  test("that refusal names both versions, the remedy, and the cost of refusing", async () => {
    // A control that refuses at 3 a.m. and does not say what to do about it is a control
    // nobody can act on, and the cost — the shard stays live — must not have to be inferred.
    const { instance } = publisherOver({ version: 7, latestVersion: 8, payload });
    const { message } = (await instance.publishRollback(action())).refusal;
    expect(message).toMatch(/v7 is in force/);
    expect(message).toMatch(/v8 is the latest published/);
    expect(message).toMatch(/pin it or supersede it/);
    expect(message).toMatch(/THE SHARD REMAINS LIVE/);
  });

  test("nothing pinned is still its own refusal, distinct from the two above", async () => {
    const { instance, published } = publisherOver(null);
    const outcome = await instance.publishRollback(action());
    expect(outcome.refusal.code).toBe(rollbackPublisher.REFUSAL.NO_VERSION_IN_FORCE);
    expect(published).toHaveLength(0);
  });

  test("the three refusals are distinct codes — an incident review can tell them apart", () => {
    const codes = [
      rollbackPublisher.REFUSAL.NO_VERSION_IN_FORCE,
      rollbackPublisher.REFUSAL.VERSION_IN_FORCE_UNREADABLE,
      rollbackPublisher.REFUSAL.SUPERSEDES_AN_UNPINNED_VERSION,
    ];
    expect(new Set(codes).size).toBe(3);
  });

  test("the production reader resolves the pin, not the highest version", async () => {
    // A store double, because what is under test is *which rows are read* and in what
    // relationship — the live equivalent is tools/verify/phase15VersionInForce.js, group A.
    const versions = { 7: { payload: { values: { marker: "in-force" } } }, 8: { payload: { values: { marker: "unpinned" } } } };
    const prisma = {
      configActiveVersion: { findUnique: async () => ({ id: rollbackPublisher.ACTIVE_VERSION_ID, version: 7 }) },
      configVersion: {
        findUnique: async ({ where }) => versions[where.version] || null,
        findFirst: async () => ({ version: 8 }),
      },
    };
    const reading = await rollbackPublisher.versionInForceReader({ prisma });
    expect(reading).toEqual({ version: 7, latestVersion: 8, payload: { values: { marker: "in-force" } } });
  });

  test("the production reader returns null when nothing is pinned", async () => {
    const prisma = {
      configActiveVersion: { findUnique: async () => null },
      configVersion: { findUnique: async () => ({ payload: {} }), findFirst: async () => ({ version: 8 }) },
    };
    expect(await rollbackPublisher.versionInForceReader({ prisma })).toBeNull();
  });

  test("the pin's singleton key is the one the Config Service writes", () => {
    // If these ever diverge the reader silently finds no pin and every rollback refuses with
    // NO_VERSION_IN_FORCE — a fail-closed direction, but for a reason nobody could diagnose.
    const service = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "src", "engine", "config", "service.js"),
      "utf8",
    );
    expect(service).toMatch(new RegExp(`SINGLETON_PIN_ID\\s*=\\s*"${rollbackPublisher.ACTIVE_VERSION_ID}"`));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P15-E3 — the guardrail assessment's own window
// ─────────────────────────────────────────────────────────────────────────────

describe("P15-E3 — guardrails.assess() refuses a window it cannot measure", () => {
  const declaration = validDeclaration();

  test.each([
    ["both NaN", { windowStartedAtMs: NaN, windowEndedAtMs: NaN }],
    ["the start NaN", { windowStartedAtMs: NaN, windowEndedAtMs: NOW }],
    ["the end NaN", { windowStartedAtMs: NOW - HOUR, windowEndedAtMs: NaN }],
    ["Infinity", { windowStartedAtMs: -Infinity, windowEndedAtMs: Infinity }],
  ])("a %s window throws rather than assessing", (_name, window) => {
    expect(() => guardrails.assess(declaration, { ...window, observations: {} })).toThrow(/finite instants/);
  });

  test("the defect: a NaN window used to satisfy BOTH of assess()'s own rules at once", () => {
    // With `typeof` guards this returned PROCEED — the pre-declaration refusal did not fire
    // (`NaN < declaredAtMs` is false) and the window-length requirement did not fire
    // (`NaN < observationWindowSeconds` is false). Both rules, off, from one bad value.
    expect(() =>
      guardrails.assess(declaration, {
        windowStartedAtMs: NaN,
        windowEndedAtMs: NaN,
        observations: { commit_latency_p99: { value: 100, samples: 5000 } },
      }),
    ).toThrow();
  });

  test("the pre-declaration refusal still fires on a real window", () => {
    const outcome = guardrails.assess(declaration, {
      windowStartedAtMs: declaration.declaredAtMs - HOUR,
      windowEndedAtMs: NOW,
      observations: {},
    });
    expect(outcome.verdict).toBe(guardrails.VERDICT.HOLD);
    expect(outcome.refusal).toMatch(/pre-declared/);
  });

  test("a healthy window over a satisfied guardrail still PROCEEDs — nothing was tightened", () => {
    const outcome = guardrails.assess(declaration, {
      windowStartedAtMs: declaration.declaredAtMs,
      windowEndedAtMs: declaration.declaredAtMs + 2 * HOUR,
      observations: { commit_latency_p99: { value: 120, samples: 5000 } },
    });
    expect(outcome.verdict).toBe(guardrails.VERDICT.PROCEED);
  });

  test("a breach over a healthy window still rolls back", () => {
    const outcome = guardrails.assess(declaration, {
      windowStartedAtMs: declaration.declaredAtMs,
      windowEndedAtMs: declaration.declaredAtMs + 2 * HOUR,
      observations: { commit_latency_p99: { value: 900, samples: 5000 } },
    });
    expect(outcome.verdict).toBe(guardrails.VERDICT.ROLL_BACK);
  });
});

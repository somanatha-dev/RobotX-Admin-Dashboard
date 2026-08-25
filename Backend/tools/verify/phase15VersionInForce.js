"use strict";

/**
 * Live verification of the Phase 15 third-pass remediation (P15-E1, P15-E2, P15-E3).
 *
 * Two of the three findings this harness pins were invisible to the whole suite for the same
 * reason: the thing that was wrong was **which row the composition root read**, and the only
 * way to tell one row from another is to have both of them in a real database.
 *
 *   - **P15-E2** — `server.js` handed `rollbackPublisher` the *latest published* configuration
 *     version where the module's contract, its header and `docs/runbooks/rollback.md` all say
 *     *the version in force*. Those differ exactly when a version has been published without
 *     being pinned, which `config.controller.publishVersion` supports by design
 *     (`if (body.pin !== false)`). Group A builds that divergence and drives the shipped
 *     automatic rollback through it.
 *
 *   - **P15-E1** — `evidence.admit()`'s PRODUCTION branch read its observation-window
 *     endpoints through `typeof … === "number"`, which admits `NaN`. Group B files the four
 *     PRODUCTION gates with malformed windows and puts the resulting table to
 *     `stage.authoriseEnable()` — the authority, not the adjudicator.
 *
 *   - **P15-E3** — the same shape in `guardrails.assess()`, checked in group C.
 *
 * Disposable PostgreSQL only. The harness refuses a Neon host and the default port by name.
 *
 * Usage:
 *   DATABASE_URL=postgresql://…@127.0.0.1:55439/robotx_p15c node tools/verify/phase15VersionInForce.js
 */

const { PrismaClient } = require("@prisma/client");

const configService = require("../../src/engine/config/service");
const evidence = require("../../src/engine/cutover/evidence");
const gates = require("../../src/engine/cutover/gates");
const guardrails = require("../../src/engine/cutover/guardrails");
const rollbackPublisher = require("../../src/engine/cutover/rollbackPublisher");
const stage = require("../../src/engine/cutover/stage");

let prisma = null;

const P = "p15vif";
const REGION = `${P}-region`;
const SHARD_ID = `${P}-shard`;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const DIGEST = "c".repeat(64);

/** P15-F1 — the authoritative parameter source `stage.authoriseEnable()` resolves bounds from. */
const REGISTER = configService.loadRegister({ reload: true });
const PARAMETER_VALUES = Object.freeze({
  get: (name) => (REGISTER.entries.get(name) || {}).default,
});

/** The Safety-class parameter whose cap V9 enforces; both values below stay under it. */
const SAFETY_PARAMETER = "route.degraded_reserve_factor";
const APPROVALS = [
  { approverId: "alice", approvedAt: new Date().toISOString() },
  { approverId: "bob", approvedAt: new Date().toISOString() },
];

const results = [];

function record(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
  process.stdout.write(`  ${ok ? "PASS" : "FAIL"}  ${id.padEnd(4)} ${title}\n${detail ? `          ${detail}\n` : ""}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(id, title, fn) {
  try {
    record(id, title, true, await fn());
  } catch (error) {
    record(id, title, false, error && error.message);
  }
}

// ── evidence fixtures ────────────────────────────────────────────────────────

function rehearsal() {
  return {
    environment: { id: `${P}-staging`, production: false },
    configVersion: "1",
    automaticRollbackFired: true,
    steps: Object.fromEntries(evidence.REHEARSAL_STEPS.map((step) => [step, true])),
  };
}

function greenRecord(gate, nowMs, productionObservation) {
  if (gate.evidence === gates.EVIDENCE.BUILD || gate.evidence === gates.EVIDENCE.SUITE) {
    return {
      gateId: gate.id,
      producedAtMs: nowMs - 1000,
      producer: "tools/release/collectEvidence.js",
      run: { command: gate.command, exitCode: 0, build: { sourceDigest: DIGEST } },
      build: { sourceDigest: DIGEST },
    };
  }
  if (gate.evidence === gates.EVIDENCE.PRODUCTION) {
    return {
      gateId: gate.id,
      producedAtMs: nowMs - 1000,
      producer: "observability",
      owner: "sre-oncall",
      pass: true,
      observation: {
        source: "prod-metrics",
        ...(productionObservation || { windowStartedAtMs: nowMs - 40 * DAY, windowEndedAtMs: nowMs }),
      },
    };
  }
  const row = {
    gateId: gate.id,
    producedAtMs: nowMs - 1000,
    producer: "operator tooling",
    owner: "release-manager",
    pass: true,
    approval: { recordedBy: "alice", approvedBy: "bob" },
  };
  if (gate.runnable === true) {
    row.corroboratingRun = { command: gate.command, exitCode: 0, build: { sourceDigest: DIGEST } };
  }
  if (gate.rehearsal === true) row.rehearsal = rehearsal();
  return row;
}

function table(nowMs, productionObservation) {
  const out = {};
  for (const gate of gates.RELEASE_GATES) out[gate.id] = greenRecord(gate, nowMs, productionObservation);
  return out;
}

function declaration(nowMs) {
  return guardrails.declare({
    shardId: SHARD_ID,
    declaredBy: "release-manager",
    declaredAtMs: nowMs - DAY,
    observationWindowSeconds: 3600,
    guardrails: [{ id: "commit_latency_p99", direction: "AT_MOST", threshold: 250, minSamples: 100, unit: "ms" }],
  });
}

function enableRequest(nowMs, productionObservation) {
  return {
    shard: { shardId: SHARD_ID, regionId: REGION, state: "ACTIVE" },
    allShards: [{ shardId: SHARD_ID, regionId: REGION, state: "ACTIVE", agentCount: 1 }],
    liveShardIds: [],
    releaseEvidence: table(nowMs, productionObservation),
    killSwitchState: {},
    declaration: declaration(nowMs),
    requestedBy: "alice",
    approvedBy: "bob",
    reason: "stage the least-loaded shard first",
    requestedAtMs: nowMs,
    sourceDigest: DIGEST,
    evidenceMaxAgeMs: DAY,
    // P15-F1 — the bound is the register's. The request states none; the authority resolves it.
    parameterValues: PARAMETER_VALUES,
  };
}

// ── configuration fixtures ───────────────────────────────────────────────────

function bindings(safetyValue, deadline, cutover) {
  return [
    { level: "global", name: SAFETY_PARAMETER, value: safetyValue },
    { level: "global", name: "sla.assignment_deadline", value: deadline },
    { level: "region", key: REGION, name: "cutover.engine_enabled", value: cutover },
  ];
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  if (!url) throw new Error("DATABASE_URL is required");
  if (/neon\.tech/i.test(url) || /:5432\//.test(url)) {
    throw new Error("refusing to run against a shared or default-port instance; use a disposable cluster");
  }
  prisma = new PrismaClient({ datasources: { db: { url } } });

  process.stdout.write("\nPHASE 15 — version-in-force and observation-window verification\n\n");

  // ══ A. P15-E2 — the automatic rollback's base configuration ═════════════════
  process.stdout.write("A. P15-E2 — which configuration version the automatic rollback carries forward\n");

  // `ConfigVersion` is immutable once published (§22.1 rule 3), so the fixture builds
  // forward from whatever the database already holds rather than deleting anything.
  const inForce = await configService.publish(prisma, {
    publishedBy: "alice",
    approvals: APPROVALS,
    bindings: bindings(1.05, 300, true),
    note: `${P} — the reviewed configuration, put in force`,
  });
  await configService.pinVersion(prisma, null, inForce.version, "alice");

  const candidate = await configService.publish(prisma, {
    publishedBy: "bob",
    approvals: APPROVALS,
    bindings: bindings(1.11, 900, true),
    note: `${P} — a candidate published for review and DELIBERATELY NOT PINNED`,
  });

  await check(
    "A1",
    "the fixture is the state the defect needs: a published version that is not the one in force",
    async () => {
      const pin = await prisma.configActiveVersion.findUnique({ where: { id: rollbackPublisher.ACTIVE_VERSION_ID } });
      const latest = await prisma.configVersion.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
      assert(pin.version === inForce.version, `pinned is v${pin.version}, expected v${inForce.version}`);
      assert(latest.version === candidate.version, `latest is v${latest.version}, expected v${candidate.version}`);
      assert(pin.version !== latest.version, "pinned and latest agree, so this fixture proves nothing");
      return `in force v${pin.version} (sla=300, ${SAFETY_PARAMETER}=1.05); latest v${latest.version} (sla=900, 1.11), unpinned`;
    },
  );

  await check("A2", "the shipped reader returns the version IN FORCE, not the latest", async () => {
    const reading = await rollbackPublisher.versionInForceReader({ prisma });
    assert(reading, "the reader returned nothing while a version is pinned");
    assert(
      reading.version === inForce.version && reading.latestVersion === candidate.version,
      `the reader reports in-force v${reading.version} / latest v${reading.latestVersion}`,
    );
    const payload = reading.payload;
    assert(
      payload.values["sla.assignment_deadline"] === 300,
      `the reader returned sla.assignment_deadline=${payload.values["sla.assignment_deadline"]}; the version in force holds 300`,
    );
    assert(
      payload.values[SAFETY_PARAMETER] === 1.05,
      `the reader returned ${SAFETY_PARAMETER}=${payload.values[SAFETY_PARAMETER]}; the version in force holds 1.05`,
    );
    return "sla.assignment_deadline=300, route.degraded_reserve_factor=1.05 — the pinned payload";
  });

  await check(
    "A3",
    "the pre-fix producer returns the unpinned candidate — the defect, reproduced against this same database",
    async () => {
      // Verbatim from `server.js` before this remediation.
      const latest = await prisma.configVersion.findFirst({ orderBy: { version: "desc" }, select: { payload: true } });
      const payload = latest && latest.payload;
      assert(payload.values["sla.assignment_deadline"] === 900, "the pre-fix read did not return the candidate");
      return (
        `findFirst({ orderBy: { version: "desc" } }) → sla.assignment_deadline=900, ` +
        `${SAFETY_PARAMETER}=${payload.values[SAFETY_PARAMETER]} — a version nobody put in force`
      );
    },
  );

  function livePublisher() {
    return rollbackPublisher.create({
      versionInForce: () => rollbackPublisher.versionInForceReader({ prisma }),
      publish: (request) => configService.publish(prisma, request),
      pin: (version, publishedBy) => configService.pinVersion(prisma, null, version, publishedBy),
    });
  }

  function rollbackAction() {
    const authorisation = stage.authoriseRollback({
      shard: { shardId: SHARD_ID, regionId: REGION },
      automatic: true,
      reason: "automatic rollback: commit_latency_p99 regressed against its pre-declared guardrail",
      requestedAtMs: Date.now(),
    });
    assert(authorisation.authorised, "the rollback was refused by the authority");
    return authorisation.action;
  }

  await check(
    "A4",
    "while an unpinned successor exists the rollback REFUSES rather than superseding it either way",
    async () => {
      const outcome = await livePublisher().publishRollback(rollbackAction());
      assert(!outcome.published, `the rollback published v${outcome.version} over an unpinned candidate`);
      assert(
        outcome.refusal.code === rollbackPublisher.REFUSAL.SUPERSEDES_AN_UNPINNED_VERSION,
        `refused with ${outcome.refusal.code}: ${outcome.refusal.message}`,
      );
      assert(/THE SHARD REMAINS LIVE/.test(outcome.refusal.message), "the refusal does not state its cost");
      return `${outcome.refusal.code} — names v${candidate.version} and the remedy`;
    },
  );

  await check("A5", "the unpinned candidate was NOT promoted, and nothing new was published", async () => {
    const pin = await prisma.configActiveVersion.findUnique({ where: { id: rollbackPublisher.ACTIVE_VERSION_ID } });
    const latest = await prisma.configVersion.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
    assert(pin.version === inForce.version, `v${pin.version} is in force, expected v${inForce.version}`);
    assert(latest.version === candidate.version, `v${latest.version} is latest — the refused rollback published anyway`);
    const row = await prisma.configVersion.findUnique({ where: { version: pin.version } });
    assert(row.payload.values["sla.assignment_deadline"] === 300, "the in-force configuration moved");
    assert(row.payload.values[SAFETY_PARAMETER] === 1.05, `${SAFETY_PARAMETER} moved in force`);
    return `still v${pin.version} in force (sla=300, ${SAFETY_PARAMETER}=1.05); latest still v${latest.version}`;
  });

  // ── the same rollback, once an operator has resolved the candidate ─────────
  await configService.pinVersion(prisma, null, candidate.version, "carol");
  let rolledBackVersion = null;

  await check(
    "A6",
    "once the candidate is resolved the rollback fires and carries the in-force set forward",
    async () => {
      const outcome = await livePublisher().publishRollback(rollbackAction());
      assert(outcome.published && outcome.pinned, `the rollback did not publish and pin: ${JSON.stringify(outcome.refusal)}`);
      rolledBackVersion = outcome.version;
      return `published v${outcome.version} and pinned it`;
    },
  );

  await check("A7", "the published version is the one in force, disabled — and nothing else moved", async () => {
    const pin = await prisma.configActiveVersion.findUnique({ where: { id: rollbackPublisher.ACTIVE_VERSION_ID } });
    assert(pin.version === rolledBackVersion, `v${pin.version} is in force, expected v${rolledBackVersion}`);
    const row = await prisma.configVersion.findUnique({ where: { version: pin.version } });
    const values = row.payload.values || {};
    // v11 is what an operator pinned, so v11's values are what "in force" now means.
    assert(values["sla.assignment_deadline"] === 900, `sla.assignment_deadline is ${values["sla.assignment_deadline"]}`);
    assert(values[SAFETY_PARAMETER] === 1.11, `${SAFETY_PARAMETER} is ${values[SAFETY_PARAMETER]}`);
    const binding = (row.payload.bindings || []).find(
      (entry) => entry.name === "cutover.engine_enabled" && String(entry.key) === REGION,
    );
    assert(binding && binding.value === false, `the region binding is ${JSON.stringify(binding)}, not a disable`);
    return `v${pin.version}: carried v${candidate.version}'s set forward unchanged, cutover.engine_enabled(${REGION})=false`;
  });

  await check("A8", "a reading with no version numbers is refused rather than read as a payload", async () => {
    const publisher = rollbackPublisher.create({
      // The pre-remediation shape: a bare payload, which cannot say which version it is.
      versionInForce: async () => ({ bindings: [], killSwitchState: {}, regimes: [] }),
      publish: async () => { throw new Error("a publish must not be attempted on an unreadable reading"); },
      pin: async () => { throw new Error("a pin must not be attempted on an unreadable reading"); },
    });
    const outcome = await publisher.publishRollback(rollbackAction());
    assert(!outcome.published, "a bare payload was published");
    assert(
      outcome.refusal.code === rollbackPublisher.REFUSAL.VERSION_IN_FORCE_UNREADABLE,
      `refused with ${outcome.refusal.code}`,
    );
    return outcome.refusal.code;
  });

  await check("A9", "nothing is pinned → the rollback refuses by name rather than inventing a base set", async () => {
    const publisher = rollbackPublisher.create({
      versionInForce: async () => null,
      publish: async () => { throw new Error("a publish must not be attempted with no version in force"); },
      pin: async () => { throw new Error("a pin must not be attempted with no version in force"); },
    });
    const authorisation = stage.authoriseRollback({
      shard: { shardId: SHARD_ID, regionId: REGION },
      automatic: true,
      reason: "guardrail breach",
      requestedAtMs: Date.now(),
    });
    const outcome = await publisher.publishRollback(authorisation.action);
    assert(!outcome.published, "the rollback published with no version in force");
    assert(
      outcome.refusal.code === rollbackPublisher.REFUSAL.NO_VERSION_IN_FORCE,
      `refused with ${outcome.refusal.code}`,
    );
    return outcome.refusal.code;
  });

  // ══ B. P15-E1 — the PRODUCTION observation window, at the authority ═════════
  process.stdout.write("\nB. P15-E1 — a PRODUCTION gate's observation window, judged by stage.authoriseEnable\n");

  const nowMs = Date.now();
  const production = gates.RELEASE_GATES.filter((gate) => gate.evidence === gates.EVIDENCE.PRODUCTION);

  await check("B1", "the honest fixture authorises — so every refusal below is about the window", async () => {
    const outcome = stage.authoriseEnable(enableRequest(nowMs));
    assert(outcome.authorised, outcome.authorised ? "" : `refused: ${outcome.refusal.code} — ${outcome.refusal.message}`);
    return `authorised with a 40-day window on all ${production.length} PRODUCTION gates`;
  });

  for (const [id, title, window] of [
    ["B2", "a NaN … NaN window does not authorise a cutover", { windowStartedAtMs: NaN, windowEndedAtMs: NaN }],
    ["B3", "an Infinity endpoint does not authorise a cutover", { windowStartedAtMs: 0, windowEndedAtMs: Infinity }],
    ["B4", "a string endpoint does not authorise a cutover", { windowStartedAtMs: "0", windowEndedAtMs: "1" }],
    [
      "B5",
      "a window that has not closed yet does not authorise a cutover",
      { windowStartedAtMs: nowMs - 40 * DAY, windowEndedAtMs: nowMs + 40 * DAY },
    ],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await check(id, title, async () => {
      const outcome = stage.authoriseEnable(enableRequest(nowMs, window));
      assert(!outcome.authorised, `AUTHORISED with window ${JSON.stringify(window)}`);
      assert(
        outcome.refusal.code === stage.REFUSAL.RELEASE_GATE_NOT_GREEN,
        `refused with ${outcome.refusal.code}, expected RELEASE_GATE_NOT_GREEN`,
      );
      const named = outcome.refusal.detail.map((row) => row.id).sort();
      const expected = production.map((gate) => gate.id).sort();
      assert(
        JSON.stringify(named) === JSON.stringify(expected),
        `the refusal names ${named.join(", ")}; every PRODUCTION gate should be red: ${expected.join(", ")}`,
      );
      return `refused — all ${production.length} PRODUCTION gates RED: ${named.join(", ")}`;
    });
  }

  await check("B6", "each PRODUCTION gate names the window as the reason, not something else", async () => {
    const evaluation = gates.evaluate(table(nowMs, { windowStartedAtMs: NaN, windowEndedAtMs: NaN }), {
      nowMs,
      maxAgeMs: DAY,
      sourceDigest: DIGEST,
      minObservationMs: { shadow_agreement: 14 * DAY, soak: 72 * HOUR },
    });
    for (const gate of production) {
      const row = evaluation.results.find((entry) => entry.id === gate.id);
      assert(
        row.inadmissibleCode === evidence.INADMISSIBLE.OBSERVATION_WINDOW_REQUIRED,
        `${gate.id} refused with ${row.inadmissibleCode}`,
      );
    }
    return `${production.length} × OBSERVATION_WINDOW_REQUIRED`;
  });

  await check("B7", "the honest short window is still refused for its own reason — the bound was not widened", async () => {
    const evaluation = gates.evaluate(table(nowMs, { windowStartedAtMs: nowMs - 1000, windowEndedAtMs: nowMs }), {
      nowMs,
      maxAgeMs: DAY,
      sourceDigest: DIGEST,
      minObservationMs: { shadow_agreement: 14 * DAY, soak: 72 * HOUR },
    });
    const soak = evaluation.results.find((entry) => entry.id === "soak");
    assert(
      soak.inadmissibleCode === evidence.INADMISSIBLE.OBSERVATION_WINDOW_TOO_SHORT,
      `soak refused with ${soak.inadmissibleCode}`,
    );
    return soak.detail;
  });

  // ══ C. P15-E3 — the guardrail assessment's own window ═══════════════════════
  process.stdout.write("\nC. P15-E3 — guardrails.assess() and its observation window\n");

  await check("C1", "a NaN window is refused rather than silently satisfying both of assess()'s rules", async () => {
    const declared = declaration(nowMs);
    let threw = null;
    try {
      guardrails.assess(declared, { windowStartedAtMs: NaN, windowEndedAtMs: NaN, observations: {} });
    } catch (error) {
      threw = error;
    }
    assert(threw, "assess() accepted a NaN window");
    assert(/finite instants/.test(threw.message), `refused with an unrelated message: ${threw.message}`);
    return "refused by name";
  });

  await check("C2", "the pre-declaration ordering refusal still fires on a real window", async () => {
    const declared = declaration(nowMs);
    const outcome = guardrails.assess(declared, {
      windowStartedAtMs: declared.declaredAtMs - HOUR,
      windowEndedAtMs: nowMs,
      observations: {},
    });
    assert(outcome.verdict === guardrails.VERDICT.HOLD, `verdict was ${outcome.verdict}`);
    assert(outcome.refusal && /pre-declared/.test(outcome.refusal), "the pre-declaration refusal did not fire");
    return "HOLD — the window opened before the guardrails were declared";
  });

  await check("C3", "a healthy window over a satisfied guardrail still PROCEEDs — nothing was made stricter", async () => {
    const declared = declaration(nowMs);
    const outcome = guardrails.assess(declared, {
      windowStartedAtMs: declared.declaredAtMs,
      windowEndedAtMs: declared.declaredAtMs + 2 * HOUR,
      observations: { commit_latency_p99: { value: 120, samples: 5000 } },
    });
    assert(outcome.verdict === guardrails.VERDICT.PROCEED, `verdict was ${outcome.verdict}: ${JSON.stringify(outcome.findings)}`);
    return "PROCEED";
  });

  const passed = results.filter((entry) => entry.ok).length;
  process.stdout.write(`\n${"═".repeat(78)}\nPHASE 15 version-in-force verification: ${passed}/${results.length} passed\n${"═".repeat(78)}\n`);
  await prisma.$disconnect();
  process.exitCode = passed === results.length ? 0 : 1;
}

main().catch(async (error) => {
  process.stderr.write(`\nHARNESS FAILED: ${error && error.message}\n`);
  if (prisma) await prisma.$disconnect();
  process.exitCode = 1;
});

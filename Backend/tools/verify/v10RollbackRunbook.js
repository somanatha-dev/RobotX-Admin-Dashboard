"use strict";

/**
 * Live verification of `docs/runbooks/rollback.md` §2.1 — Phase 15 closure item **V-10**.
 *
 * ── What V-10 is, and why this file is separate from the jest suite ─────────
 * `PHASE_15_CLOSURE_CHECKLIST.md` §C carried **V-10** — *"`docs/runbooks/rollback.md`'s
 * procedure executed against the current API"* — as `NOT EVALUATED`, status **UNKNOWN**, with
 * the note that no pass had ever executed it. It was executed on 2026-08-30. The defect that
 * mattered was §2 step 1, which read, in full:
 *
 *     1. Publish `authorisation.action.binding` (`cutover.engine_enabled = false`, region scope).
 *
 * A configuration version is a **complete set**. `config/service.publish()` writes exactly
 * `snapshot.declaredBindings` and inherits nothing from the version in force, and
 * `config.controller.publishVersion` defaults `bindings` to `[]`. So the manual Rollback A —
 * the one `rollbackPublisher`'s `SUPERSEDES_AN_UNPINNED_VERSION` refusal explicitly routes an
 * operator to — reverted **every other parameter in the deployment** to its register default,
 * as a side effect of disabling one shard. That is the same fleet-wide change
 * `bindingsWithRegionDisabled` was written to prevent on the automatic path, and the runbook
 * did not carry it across.
 *
 * `tests/engine/phase15RollbackRunbook.test.js` asserts the binding arithmetic through
 * `configService.buildSnapshot`, which is pure and in-memory. **That is not the claim the
 * runbook makes.** The runbook tells an operator to publish and pin, and what it promises is
 * about what a *running process* then resolves — which involves `publish()` writing
 * `ConfigScopeBinding` rows, `pinVersion()` moving the singleton pointer, and
 * `loadPinnedSnapshot()` reading them back out. This harness drives that, on a real
 * PostgreSQL instance, in the order the runbook gives, and reads the answer back from the
 * database rather than from the object it just built.
 *
 * It runs the discarded instruction too (group B). A verification that only exercises the
 * corrected procedure establishes that the correction works, not that the thing it replaced
 * was wrong — and P15-F1's lesson was that you have not reproduced anything until you have
 * built the BEFORE variant.
 *
 * Disposable PostgreSQL only. The harness refuses a Neon host and the default port by name:
 * it publishes configuration versions and moves the active-version pin, which are the two
 * writes that would matter most on shared infrastructure.
 *
 * Usage:
 *   DATABASE_URL=postgresql://…@127.0.0.1:55436/robotx_v10 node tools/verify/v10RollbackRunbook.js
 */

const { PrismaClient } = require("@prisma/client");

const configService = require("../../src/engine/config/service");
const enabled = require("../../src/engine/cutover/enabled");
const rollbackPublisher = require("../../src/engine/cutover/rollbackPublisher");
const stage = require("../../src/engine/cutover/stage");

let prisma = null;

const P = "v10rb";
const ROLLED_BACK = `${P}-region-a`;
const UNTOUCHED = `${P}-region-b`;
const SHARD_ID = `${P}-shard-a`;

/**
 * The ordinary, non-Safety parameter that stands for "everything else in the deployment".
 * Region-scoped (§22.2), `TUNED`, and bound away from its register default in both regions,
 * so "reverted to the default" is a fact read out of the database rather than an inference.
 */
const PARAMETER_UNDER_TEST = "solve.time_budget";
const BOUND_VALUE = 180;

/**
 * The binding that makes any of this publishable at all — and the reason group B has the
 * shape it does.
 *
 * `cutover.md` §1 states it: *"defaults are not a publishable configuration.
 * `config/service.publish()` refuses them"*. On this tree the refusal is **V9**: the
 * register's default `route.degraded_reserve_factor` (1.4) puts combined degraded energy
 * conservatism at 2.01 against `energy.max_combined_conservatism` = 1.6. Every publish here
 * therefore has to carry this binding, including the fixture — and, crucially, including the
 * BEFORE variant, which is how the live run turned out to be worth doing.
 */
const CONSERVATISM_PARAMETER = "route.degraded_reserve_factor";
const CONSERVATISM_VALUE = 1.05;

const REGISTER = configService.loadRegister({ reload: true });
const REGISTER_DEFAULT = (REGISTER.entries.get(PARAMETER_UNDER_TEST) || {}).default;

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

/** The in-force binding set: two live regions, and one ordinary parameter bound in both. */
function inForceBindings() {
  return [
    { level: "global", name: CONSERVATISM_PARAMETER, value: CONSERVATISM_VALUE },
    { level: "region", key: ROLLED_BACK, name: enabled.PARAMETER, value: true },
    { level: "region", key: UNTOUCHED, name: enabled.PARAMETER, value: true },
    { level: "region", key: ROLLED_BACK, name: PARAMETER_UNDER_TEST, value: BOUND_VALUE },
    { level: "region", key: UNTOUCHED, name: PARAMETER_UNDER_TEST, value: BOUND_VALUE },
  ];
}

/**
 * What a process running against this database would resolve — the whole point.
 *
 * `loadPinnedSnapshot` is the reader every running process uses (`server.js`'s `snapshotOf`,
 * `config.controller.currentSnapshot`). Reading through it, rather than through the snapshot
 * `publish()` returned, is what makes this a verification of the deployment's state instead
 * of a restatement of the request.
 */
async function postureFromTheDatabase() {
  const snapshot = await configService.loadPinnedSnapshot({ prisma, kv: null });
  assert(snapshot, "no version is pinned — loadPinnedSnapshot returned null");
  return {
    version: snapshot.version,
    rolledBack: enabled.describe({
      snapshot,
      shard: { shardId: SHARD_ID, regionId: ROLLED_BACK },
      env: { ENGINE_ENABLED: "true" },
    }),
    untouched: enabled.describe({
      snapshot,
      shard: { shardId: `${P}-shard-b`, regionId: UNTOUCHED },
      env: { ENGINE_ENABLED: "true" },
    }),
    rolledBackDeadline: snapshot.resolve(PARAMETER_UNDER_TEST, { region: ROLLED_BACK }),
    untouchedDeadline: snapshot.resolve(PARAMETER_UNDER_TEST, { region: UNTOUCHED }),
  };
}

/** The authorisation §2's code block produces. Nothing here is invented for the harness. */
function authorisedRollback() {
  const authorisation = stage.authoriseRollback({
    shard: { shardId: SHARD_ID, regionId: ROLLED_BACK },
    reason: "V-10 live verification of docs/runbooks/rollback.md §2.1",
    requestedBy: "v10-harness-operator",
    requestedAtMs: Date.now(),
  });
  assert(authorisation.authorised, `the authority refused: ${JSON.stringify(authorisation.refusal)}`);
  return authorisation.action;
}

async function publishAndPin(bindings, note) {
  const published = await configService.publish(prisma, {
    publishedBy: "v10-harness-operator",
    approvals: APPROVALS,
    bindings,
    note,
  });
  await configService.pinVersion(prisma, null, published.version, "v10-harness-operator");
  return published;
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  if (!url) throw new Error("DATABASE_URL is required");
  if (/neon\.tech/i.test(url) || /:5432\//.test(url)) {
    throw new Error(
      "refusing to run against a shared or default-port instance; this harness publishes configuration " +
        "versions and moves the active-version pin, and is for a disposable cluster only",
    );
  }
  prisma = new PrismaClient({ datasources: { db: { url } } });

  process.stdout.write("\nV-10 — docs/runbooks/rollback.md §2.1 against a live database\n\n");

  assert(
    REGISTER_DEFAULT !== BOUND_VALUE,
    `the fixture is inert: ${PARAMETER_UNDER_TEST}'s register default is already ${BOUND_VALUE}, so ` +
      "'reverted to the default' would be indistinguishable from 'carried forward'",
  );

  // ══ A. The version in force ════════════════════════════════════════════════
  process.stdout.write("A. The deployment before the rollback\n");

  let baseVersion = null;

  await check("A1", "two regions live, one ordinary parameter bound in both, published and pinned", async () => {
    const published = await publishAndPin(inForceBindings(), "V-10 fixture — the version in force");
    baseVersion = published.version;
    const posture = await postureFromTheDatabase();
    assert(posture.rolledBack.live === true, "region A is not live");
    assert(posture.untouched.live === true, "region B is not live");
    assert(posture.rolledBackDeadline === BOUND_VALUE, `region A resolves ${posture.rolledBackDeadline}`);
    assert(posture.untouchedDeadline === BOUND_VALUE, `region B resolves ${posture.untouchedDeadline}`);
    return `v${posture.version} — both regions ENGINE, ${PARAMETER_UNDER_TEST}=${BOUND_VALUE} (default ${REGISTER_DEFAULT})`;
  });

  await check("A2", "versionInForceReader reports the pinned version, the latest, and its payload", async () => {
    const reading = await rollbackPublisher.versionInForceReader({ prisma });
    assert(reading, "versionInForceReader returned null with a version pinned");
    assert(reading.version === baseVersion, `reports v${reading.version}, pinned is v${baseVersion}`);
    assert(reading.version === reading.latestVersion, "pinned and latest diverge in the fixture");
    assert(Array.isArray(reading.payload.bindings), "the payload carries no bindings array");
    return `v${reading.version} (latest v${reading.latestVersion}), ${reading.payload.bindings.length} declared bindings`;
  });

  // ══ B. The instruction the runbook used to give ════════════════════════════
  //
  // The BEFORE variant. Without it this harness would establish that the corrected procedure
  // works and say nothing about whether the thing it replaced was actually wrong.
  process.stdout.write("\nB. BEFORE — \"Publish `authorisation.action.binding`\", exactly as §2 step 1 said\n");

  await check("B1", "the literal instruction is refused — but NOT for dropping four bindings", async () => {
    // This is the finding the live run produced and the in-memory test could not: the
    // one-binding publish does not simply succeed. It is refused — by **V9**, an energy
    // conservatism cap, because dropping the whole set took `route.degraded_reserve_factor`
    // back to a register default that is over the cap.
    //
    // That is a guard by coincidence, not by design. It fires on this tree because of what
    // one default happens to be; it says nothing about the *four other* bindings that were
    // also dropped; and an operator reads a message about degraded energy conservatism at
    // the moment they were trying to stop a shard.
    const action = authorisedRollback();
    let findings = null;
    try {
      await publishAndPin([action.binding], "V-10 BEFORE variant — one binding, as the runbook said");
    } catch (error) {
      assert(error instanceof configService.ConfigValidationError, `threw ${error && error.name}`);
      findings = error.findings.filter((f) => f.severity === "BLOCKING" || f.severity === "blocking");
    }
    assert(findings, "the one-binding publish was accepted outright");
    const ids = [...new Set(findings.map((f) => f.id))];
    assert(ids.includes("V9"), `refused by ${ids.join(", ")}, expected V9`);
    assert(
      !findings.some((f) => new RegExp(UNTOUCHED).test(f.message) || new RegExp(PARAMETER_UNDER_TEST).test(f.message)),
      "a finding does name a dropped binding — then the refusal is about the right thing after all",
    );
    return `refused by ${ids.join(", ")} — "${findings[0].message.slice(0, 96)}…"; no finding names ${UNTOUCHED} or ${PARAMETER_UNDER_TEST}`;
  });

  await check("B2", "PLANTED: resolving that refusal the obvious way makes it publish and pin", async () => {
    // What an operator does next, under incident pressure, with a message naming exactly one
    // parameter: bind the parameter the message names. The publish is then accepted.
    const action = authorisedRollback();
    const published = await publishAndPin(
      [{ level: "global", name: CONSERVATISM_PARAMETER, value: CONSERVATISM_VALUE }, action.binding],
      "V-10 BEFORE variant — one binding plus the one V9 asked for",
    );
    return `accepted and pinned as v${published.version}; safetyClassChanges=${JSON.stringify(published.safetyClassChanges)}`;
  });

  await check("B3", "PLANTED: the shard is disabled — which is why nobody would look further", async () => {
    const posture = await postureFromTheDatabase();
    assert(posture.rolledBack.live === false, "the target shard is still live");
    assert(posture.rolledBack.decisionPath === enabled.DECISION_PATH.NONE, "decisionPath is not NONE");
    return "region A: live=false, decisionPath=NONE — the operator's intended effect, achieved";
  });

  await check("B4", "PLANTED: and the OTHER shard lost its binding — a fleet-wide change", async () => {
    const posture = await postureFromTheDatabase();
    assert(posture.untouched.live !== true, "region B survived, so the BEFORE variant is not reproduced");
    return `region B: live=${posture.untouched.live}, decisionPath=${posture.untouched.decisionPath} — nobody asked for this`;
  });

  await check("B5", "PLANTED: and every other parameter reverted to its register default", async () => {
    const posture = await postureFromTheDatabase();
    assert(
      posture.rolledBackDeadline === REGISTER_DEFAULT && posture.untouchedDeadline === REGISTER_DEFAULT,
      `resolved A=${posture.rolledBackDeadline} B=${posture.untouchedDeadline}, expected the default ${REGISTER_DEFAULT}`,
    );
    return `${PARAMETER_UNDER_TEST}: ${BOUND_VALUE} → ${REGISTER_DEFAULT} in both regions, silently`;
  });

  // ══ C. §2.1 as it now reads ════════════════════════════════════════════════
  process.stdout.write("\nC. AFTER — §2.1's recipe, run verbatim\n");

  await check("C1", "restore the fixture, so C starts where B started", async () => {
    const published = await publishAndPin(inForceBindings(), "V-10 fixture — restored for group C");
    baseVersion = published.version;
    const posture = await postureFromTheDatabase();
    assert(posture.rolledBack.live && posture.untouched.live, "the fixture did not restore");
    return `v${posture.version} — both regions live again`;
  });

  await check("C2", "the recipe publishes and pins, and the target shard has no decision path", async () => {
    const action = authorisedRollback();
    const reading = await rollbackPublisher.versionInForceReader({ prisma });
    const published = await publishAndPin(
      rollbackPublisher.bindingsWithRegionDisabled(reading.payload.bindings, action.binding.key),
      `ROLLBACK A — ${action.shardId}. ${action.reason}`,
    );
    const posture = await postureFromTheDatabase();
    assert(posture.version === published.version, `pinned v${posture.version}, published v${published.version}`);
    assert(posture.rolledBack.live === false, "the target shard is still live");
    assert(
      posture.rolledBack.consequence === enabled.SHARD_HAS_NO_DECISION_PATH,
      "the consequence is not the one §2 step 3 tells the operator to look for",
    );
    return `v${published.version} — region A: live=false, decisionPath=NONE, and the §2 step 3 sentence`;
  });

  await check("C3", "the other shard is untouched — still live, still ENGINE", async () => {
    const posture = await postureFromTheDatabase();
    assert(posture.untouched.live === true, `region B is live=${posture.untouched.live}`);
    assert(posture.untouched.decisionPath === enabled.DECISION_PATH.ENGINE, "region B lost its decision path");
    return "region B: live=true, decisionPath=ENGINE";
  });

  await check("C4", "every other parameter still resolves to the value that was in force", async () => {
    const posture = await postureFromTheDatabase();
    assert(
      posture.rolledBackDeadline === BOUND_VALUE && posture.untouchedDeadline === BOUND_VALUE,
      `resolved A=${posture.rolledBackDeadline} B=${posture.untouchedDeadline}, expected ${BOUND_VALUE}`,
    );
    return `${PARAMETER_UNDER_TEST}=${BOUND_VALUE} in both regions — carried forward, not reverted`;
  });

  await check("C5", "one binding per (level, key, name) reaches the database — not two answers", async () => {
    // Read the rows themselves, not the resolution. A duplicated triple resolves to
    // *something*, and which one is an implementation detail nobody should discover here.
    const version = await prisma.configVersion.findFirst({
      orderBy: { version: "desc" },
      select: { id: true, version: true },
    });
    const rows = await prisma.configScopeBinding.findMany({
      where: { configVersionId: version.id, parameterName: enabled.PARAMETER, scopeKey: ROLLED_BACK },
      select: { value: true, scopeLevel: true },
    });
    assert(rows.length === 1, `${rows.length} bindings for (region, ${ROLLED_BACK}, ${enabled.PARAMETER})`);
    assert(rows[0].value.value === false, `the surviving binding is ${JSON.stringify(rows[0].value)}`);
    return `v${version.version}: exactly 1 row, value=false, scope=${rows[0].scopeLevel}`;
  });

  await check("C6", "the manual set equals the set the automatic publisher would have written", async () => {
    // §2.1's claim in one assertion: the two rollbacks leave the deployment in one state.
    // The automatic path calls `bindingsWithRegionDisabled` on `versionInForceReader`'s
    // payload; the runbook now tells the operator to do the same, and this is that equality
    // driven through the real reader.
    const restored = await publishAndPin(inForceBindings(), "V-10 fixture — restored for C6");
    const action = authorisedRollback();
    const reading = await rollbackPublisher.versionInForceReader({ prisma });
    assert(reading.version === restored.version, "the reader disagrees with the pin");

    const manual = rollbackPublisher.bindingsWithRegionDisabled(reading.payload.bindings, action.binding.key);

    let automatic = null;
    const publisher = rollbackPublisher.create({
      versionInForce: () => rollbackPublisher.versionInForceReader({ prisma }),
      publish: (request) => {
        automatic = request.bindings;
        return configService.publish(prisma, { ...request, approvals: [] });
      },
      pin: (version, publishedBy) => configService.pinVersion(prisma, null, version, publishedBy),
    });
    const outcome = await publisher.publishRollback(action);
    assert(outcome.published && outcome.pinned, `the automatic publish failed: ${JSON.stringify(outcome.refusal)}`);

    const canonical = (list) => JSON.stringify([...list].map((b) => [b.level, String(b.key), b.name, b.value]).sort());
    assert(canonical(manual) === canonical(automatic), "the manual recipe and the publisher disagree on the set");
    return `${manual.length} bindings, identical field for field to the automatic publish (v${outcome.version})`;
  });

  // ══ Z. Cleanup ═════════════════════════════════════════════════════════════
  process.stdout.write("\nZ. Cleanup\n");

  await check("Z1", "the fixture versions cannot be deleted — the database says so, not this file", async () => {
    // The first draft of this harness deleted them, and PostgreSQL refused:
    //
    //   P0001  ConfigVersion is immutable once published (§22.1 rule 3). Publish a new
    //          version instead of DELETE on version 1.
    //
    // Kept as a check rather than quietly worked around. It is the reason the group A/C
    // fixtures build *forward* instead of resetting, and it is a property no in-memory
    // double would have shown: `service.publish()` has no delete path to disagree with.
    const mine = await prisma.configVersion.findFirst({
      where: { publishedBy: "v10-harness-operator" },
      select: { id: true, version: true },
    });
    assert(mine, "the harness published nothing, so there is nothing to assert immutability about");
    let refusal = null;
    try {
      await prisma.configVersion.delete({ where: { id: mine.id } });
    } catch (error) {
      refusal = error && error.message;
    }
    assert(refusal && /immutable once published/.test(refusal), `the delete was not refused: ${refusal}`);
    return `v${mine.version}: DELETE refused — "ConfigVersion is immutable once published (§22.1 rule 3)"`;
  });

  await check("Z2", "no version is left in force — the pin this harness moved is cleared", async () => {
    // The pin is a pointer, not a version, and it is the one thing here that *is* mutable.
    // A harness that walked away leaving the deployment pinned to its own fixture would have
    // changed the thing it was measuring.
    await prisma.configActiveVersion.deleteMany({ where: { id: rollbackPublisher.ACTIVE_VERSION_ID } });
    const snapshot = await configService.loadPinnedSnapshot({ prisma, kv: null });
    assert(snapshot === null, `a version is still in force: v${snapshot && snapshot.version}`);

    const versions = await prisma.configVersion.count({ where: { publishedBy: "v10-harness-operator" } });
    const automatic = await prisma.configVersion.count({ where: { publishedBy: rollbackPublisher.PUBLISHER } });
    return `pin cleared; ${versions} operator + ${automatic} automatic fixture version(s) retained by §22.1 rule 3`;
  });

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length} / ${results.length} passed\n`);
  if (failed.length > 0) {
    process.stdout.write(`FAILED: ${failed.map((r) => r.id).join(", ")}\n`);
  }
  return failed.length === 0 ? 0 : 1;
}

main()
  .then(async (code) => {
    if (prisma) await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error) => {
    process.stderr.write(`\nHARNESS ERROR: ${error && error.stack}\n`);
    if (prisma) await prisma.$disconnect();
    process.exit(2);
  });

"use strict";

/**
 * PHASE 15 current-tree re-audit — live-PostgreSQL verification of the six findings.
 *
 * ── Why a second harness rather than more checks in the first ──────────────
 * `tools/verify/phase15LiveDatabase.js` is the evidence for D-5 and D-6 and it is left
 * exactly as it was, so the earlier claim stays reproducible against the tree that made it.
 * This file is the evidence for the findings the current-tree re-audit added, and every
 * check in it fails on the unremediated tree.
 *
 * ── What these checks are for, specifically ────────────────────────────────
 * Every one of the six findings is a **composition** defect: a real producer, a real
 * consumer, and nothing joining them. A unit test cannot see one, because a unit test *is*
 * the missing join — it constructs the dependency and hands it over. So each group below
 * drives the shipped modules with the dependencies the shipped composition root builds, and
 * against a real database, because three of the six turn on what a real query returns:
 *
 *   A  the pull half of §22.1 rule 4 — a published, pinned version reaching a reader (R2)
 *   B  the automatic rollback publishing a binding that actually disables a shard (R1)
 *   C  §18.5 Custodial Operation stopping a command, from real `DegradedModeEvent` rows (R3)
 *   D  §4.5's deadline on the Leg states entered outside §4.4 (X2a, X2b)
 *   E  the shard→region read the timer worker's composer now performs (R6)
 *   F  the intake path's cutover question, against a real snapshot holding a global binding (R5)
 *   G  the findings this exercise did NOT fix, reproduced so the handoff stays true
 *
 * ── A note on the register ─────────────────────────────────────────────────
 * `service.publish()` refuses the register's **own defaults**: validator V9 computes a
 * combined degraded energy conservatism of 2.0125 against `energy.max_combined_conservatism`
 * of 1.6, because `route.degraded_reserve_factor` is Safety-class, PROVISIONAL, and awaiting
 * B8. So every publish below binds it explicitly. That is a harness accommodation and it is
 * also a finding in its own right, recorded in the report: **a deployment cannot publish its
 * first configuration version from register defaults**, which means it cannot stage any
 * shard, which is a consequence of B8 sharper than "the calibration gate is red".
 *
 * Usage:
 *   DATABASE_URL=postgresql://pgverify@127.0.0.1:55436/robotx_p15b \
 *     node tools/verify/phase15CurrentTree.js
 *
 * NEVER point this at the shared Neon instance or at the default 5432 cluster; it refuses
 * both by name.
 */

const { PrismaClient } = require("@prisma/client");

const commandDispatcher = require("../../src/services/commandDispatcher.service");
const configPropagation = require("../../src/engine/cutover/configPropagation");
const configService = require("../../src/engine/config/service");
const degradedTransitions = require("../../src/engine/degraded/transitions");
const enabled = require("../../src/engine/cutover/enabled");
const legEntryDeadline = require("../../src/engine/cutover/legEntryDeadline");
const legMachine = require("../../src/engine/lifecycle/legMachine");
const modeRegister = require("../../src/engine/degraded/modeRegister");
const rollbackPublisher = require("../../src/engine/cutover/rollbackPublisher");
const stage = require("../../src/engine/cutover/stage");
const timers = require("../../src/engine/supervision/timers");

/** Prefix for every row this harness creates, so cleanup is exact. */
const P = "p15ct";

/** The region that gets staged, and one that never does. */
const LIVE_REGION = `${P}-region-live`;
const DARK_REGION = `${P}-region-dark`;
const SHARD_ID = `${P}-shard-a`;

/**
 * The one binding every publish here must carry — see the header. Bound, not defaulted, and
 * emphatically not a calibration value: it exists so the harness can publish at all.
 */
const V9_ACCOMMODATION = Object.freeze({
  level: "global",
  key: "",
  name: "route.degraded_reserve_factor",
  value: 1.1,
});

let prisma = null;
const results = [];

function record(id, title, ok, detail) {
  results.push({ id, title, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}  ${title}`);
  if (detail) console.log(`          ${detail}`);
}

async function accepted(id, title, fn) {
  try {
    const detail = await fn();
    record(id, title, true, detail);
  } catch (error) {
    record(id, title, false, `threw: ${String(error && error.message).slice(0, 400)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Publish a configuration version and pin it. Returns the version number.
 *
 * The approval is not ceremony either: `route.degraded_reserve_factor` is **Safety-class**,
 * so binding it at all engages §22.3's two-person rule and `checkSafetyApproval` refuses a
 * single identity. Two distinct identities are supplied, which is what an operator would
 * have to do — and it is why the automatic rollback in group B is only permissible because
 * `cutover.engine_enabled` is STRUCTURAL and *unchanged* Safety-class values are not
 * "changes".
 */
async function publishAndPin(bindings, publishedBy) {
  const published = await configService.publish(prisma, {
    publishedBy,
    approvals: [{ approverId: `${publishedBy}-reviewer`, approvedAt: new Date().toISOString() }],
    bindings: [V9_ACCOMMODATION, ...bindings],
  });
  await configService.pinVersion(prisma, null, published.version, publishedBy);
  return published.version;
}

const stagedBinding = (value) => ({ level: "region", key: LIVE_REGION, name: enabled.PARAMETER, value });

async function purge() {
  for (const sql of [
    `DELETE FROM "Timer" WHERE "entityId" IN (SELECT "id" FROM "Leg" WHERE "legId" LIKE '${P}%')`,
    `DELETE FROM "Leg" WHERE "legId" LIKE '${P}%'`,
    `DELETE FROM "Mission" WHERE "missionId" LIKE '${P}%'`,
    `DELETE FROM "DegradedModeEvent" WHERE "shardId" LIKE '${P}%'`,
    `DELETE FROM "ShardMembership" WHERE "id" LIKE '${P}%'`,
    `DELETE FROM "Agent" WHERE "agentId" LIKE '${P}%'`,
    `DELETE FROM "Shard" WHERE "shardId" LIKE '${P}%'`,
    `DELETE FROM "ShardLeadership" WHERE "shardId" LIKE '${P}%'`,
    `DELETE FROM "Region" WHERE "regionId" LIKE '${P}%'`,
    // `ConfigVersion` is deliberately NOT purged: the store refuses it. §22.1 rule 3 makes a
    // published version immutable and a database trigger enforces it, which check F1b
    // exercises. So this harness is written to work from whatever version is already in
    // force rather than from version 1.
  ]) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch { /* best effort */ }
  }
}

/** A Leg in `OFFERED`, with its `OFFERED` deadline armed, as a delivered offer leaves it. */
async function offeredLeg(suffix) {
  const mission = await prisma.mission.create({
    data: { id: `${P}-m-${suffix}`, missionId: `${P}-mission-${suffix}` },
  });
  const leg = await prisma.leg.create({
    data: {
      id: `${P}-l-${suffix}`,
      legId: `${P}-leg-${suffix}`,
      missionId: mission.id,
      sequence: 0,
      purpose: "PRIMARY",
      state: "OFFERED",
      custodyState: "NONE",
      version: 0,
    },
  });
  await prisma.$transaction((tx) =>
    timers.register(tx, {
      entityType: timers.ENTITY_TYPE.LEG,
      entityId: leg.id,
      state: "OFFERED",
      entity: leg,
      dueAt: new Date(Date.now() + 20_000),
      armedSeconds: 20,
      handler: legMachine.deadlineFor("OFFERED").onExpiry,
      shardId: SHARD_ID,
    }),
  );
  return leg;
}

async function main() {
  const url = process.env.DATABASE_URL || "";
  if (/neon\.tech/i.test(url) || /:5432\//.test(url)) {
    throw new Error(`refusing to run against ${url} — this harness is for a disposable cluster only`);
  }
  prisma = new PrismaClient({ datasources: { db: { url } } });

  console.log("PHASE 15 current-tree re-audit — live PostgreSQL verification");
  console.log(`  database: ${url.replace(/:[^:@]*@/, ":***@")}`);
  const version = await prisma.$queryRawUnsafe("SELECT version() AS v");
  console.log(`  ${version[0].v}\n`);

  try {
    /* ── fixture ─────────────────────────────────────────────────────────── */
    console.log("── fixture ──");
    await accepted("F1", "purge, then seed the Region → Shard graph", async () => {
      await purge();
      await prisma.region.create({ data: { id: `${P}-r-live`, regionId: LIVE_REGION, name: "Live" } });
      await prisma.region.create({ data: { id: `${P}-r-dark`, regionId: DARK_REGION, name: "Dark" } });
      await prisma.shardLeadership.create({
        data: { shardId: SHARD_ID, leadershipFence: 1n, holder: "host:1", leaseExpiry: new Date(Date.now() + 3600_000) },
      });
      await prisma.shard.create({
        data: { id: `${P}-s-a`, shardId: SHARD_ID, regionId: `${P}-r-live`, state: "ACTIVE", agentCount: 3 },
      });
      const versions = await prisma.configVersion.count();
      return `Region → Shard seeded; ${versions} configuration version(s) already published on this database`;
    });

    await accepted("F1b", "a published ConfigVersion cannot be deleted — §22.1 rule 3, enforced by the store", async () => {
      // Found while writing this harness: the purge above could not remove the versions an
      // earlier run had published, because the *database* refuses it. That is the rule
      // working, and it is worth a check of its own — an immutability that only the
      // application enforces is one a `psql` session walks around.
      const existing = await prisma.configVersion.findFirst({ orderBy: { version: "asc" } });
      if (!existing) return "no version published yet on this database; the trigger is exercised by A1 onward";
      let refused = null;
      try {
        await prisma.$executeRawUnsafe(`DELETE FROM "ConfigVersion" WHERE "version" = ${existing.version}`);
      } catch (error) {
        refused = (error.meta || {}).code || null;
      }
      assert(refused === "P0001", `expected a raised exception (P0001), got ${refused}`);
      const still = await prisma.configVersion.findUnique({ where: { version: existing.version } });
      assert(still, "the refused DELETE removed the row anyway");
      return `SQLSTATE P0001 and version ${existing.version} survives — "ConfigVersion is immutable once published"`;
    });

    await accepted("F2", "the register's OWN DEFAULTS are not a publishable configuration (B8)", async () => {
      // Not an accommodation being explained away — a measured property of the tree, and the
      // reason every publish below carries one extra binding. It is also a sharper statement
      // of the calibration blocker than `gate:calibration` gives.
      const bare = configService.validateCandidate({ bindings: [] });
      assert(bare.result.blocking.length > 0, "expected the defaults-only candidate to be refused");
      const v9 = bare.result.blocking.find((f) => f.id === "V9");
      assert(v9, `expected V9, got ${bare.result.blocking.map((f) => f.id).join(", ")}`);
      const withBinding = configService.validateCandidate({ bindings: [V9_ACCOMMODATION] });
      assert(withBinding.result.blocking.length === 0, "the accommodation does not make the candidate publishable");
      return `V9 refuses register defaults; ${V9_ACCOMMODATION.name}=${V9_ACCOMMODATION.value} makes a publish possible`;
    });

    /* ── A. P15-R2 — the pull half of pull-with-pin ──────────────────────── */
    console.log("\n── A. P15-R2 — a published version reaches a running process ──");

    const locals = { config: null };
    let propagatorState = { currentVersion: null };
    const pull = () =>
      configPropagation.refreshOnce(
        { load: () => configService.loadPinnedSnapshot({ prisma }), apply: (s) => { locals.config = s; } },
        propagatorState,
      );

    await accepted("A1", "a staged shard is live once the first version is published and pulled", async () => {
      const v = await publishAndPin([stagedBinding(true)], "operator-a");
      const outcome = await pull();
      assert(outcome.changed === true, `expected the first pull to adopt a version, got ${JSON.stringify(outcome)}`);
      assert(locals.config.version === v, `adopted ${locals.config.version}, published ${v}`);
      const live = enabled.forShard({
        snapshot: locals.config,
        shard: { shardId: SHARD_ID, regionId: LIVE_REGION },
        env: { ENGINE_ENABLED: "true" },
      });
      assert(live === true, "the staged shard is not live after its binding was published and pinned");
      return `version ${v} adopted; forShard(${LIVE_REGION}) = true`;
    });

    await accepted("A2", "an unstaged region is not live under the same version", async () => {
      const live = enabled.forShard({
        snapshot: locals.config,
        shard: { shardId: `${P}-shard-b`, regionId: DARK_REGION },
        env: { ENGINE_ENABLED: "true" },
      });
      assert(live === false, "an unstaged region resolved live");
      return `forShard(${DARK_REGION}) = false`;
    });

    await accepted("A3", "a NEW pinned version is adopted, and the same reader changes its answer", async () => {
      // The whole finding, end to end. Before this remediation `app.locals.config` was
      // assigned once at boot and by nothing else, so this second version would have been
      // published, pinned, and never observed: a shard could not be rolled back — or staged
      // — without restarting every process.
      const before = locals.config.version;
      const v = await publishAndPin([stagedBinding(false)], "operator-a");
      assert(v > before, "the second publish did not advance the version");

      const outcome = await pull();
      assert(outcome.changed === true, `the pull did not adopt version ${v}: ${JSON.stringify(outcome)}`);
      const live = enabled.forShard({
        snapshot: locals.config,
        shard: { shardId: SHARD_ID, regionId: LIVE_REGION },
        env: { ENGINE_ENABLED: "true" },
      });
      assert(live === false, "the shard is still live after a version that disables it was pinned");
      return `version ${before} → ${v}; forShard(${LIVE_REGION}) true → false, same reader`;
    });

    await accepted("A4", "an unchanged pin is not re-applied — the version is the unit", async () => {
      const outcome = await pull();
      assert(outcome.changed === false && outcome.reason === "UNCHANGED", JSON.stringify(outcome));
      return `reason=${outcome.reason} at version ${outcome.version}`;
    });

    await accepted("A5", "a failed pull keeps the version in hand rather than losing the configuration", async () => {
      const held = locals.config;
      const errors = [];
      const outcome = await configPropagation.refreshOnce(
        {
          load: async () => {
            throw new Error("store unreachable");
          },
          apply: (s) => { locals.config = s; },
          onError: (e) => errors.push(e),
        },
        propagatorState,
      );
      assert(outcome.reason === "LOAD_FAILED", JSON.stringify(outcome));
      assert(locals.config === held, "a failed pull replaced the snapshot");
      assert(errors.length === 1, "a failed pull was silent");
      return "snapshot unchanged, one error reported — never a downgrade, never fatal";
    });

    /* ── B. P15-R1 — the automatic rollback publishes ────────────────────── */
    console.log("\n── B. P15-R1 — an automatic rollback takes the shard out of service ──");

    await accepted("B1", "re-stage the shard so there is something to roll back", async () => {
      const v = await publishAndPin(
        [stagedBinding(true), { level: "region", key: DARK_REGION, name: "dispatch.retry_window", value: 45 }],
        "operator-a",
      );
      await pull();
      assert(
        enabled.forShard({ snapshot: locals.config, shard: { shardId: SHARD_ID, regionId: LIVE_REGION }, env: { ENGINE_ENABLED: "true" } }),
        "the shard is not live",
      );
      return `version ${v}: ${LIVE_REGION} staged, and an unrelated binding present to watch`;
    });

    let rolledBackVersion = null;
    await accepted("B2", "the publisher writes and PINS a version that disables exactly this region", async () => {
      // Driven through the same object `server.js` builds, with the real Config Service.
      const publisher = rollbackPublisher.create({
        // PHASE 15 remediation (P15-E2) — the production reader, not a local re-derivation.
        // This used to be `findFirst({ orderBy: { version: "desc" } })`, copied from the
        // composition root, which returned the LATEST published version rather than the one
        // IN FORCE. The two differ whenever a version has been published without being
        // pinned, and this harness never built that state, so it could not see it. Calling
        // the shipped reader is what makes this check about production rather than about a
        // fixture; the divergent state has its own group in phase15VersionInForce.js.
        versionInForce: () => rollbackPublisher.versionInForceReader({ prisma }),
        publish: (request) => configService.publish(prisma, request),
        pin: (v, by) => configService.pinVersion(prisma, null, v, by),
      });

      const authorisation = stage.authoriseRollback({
        shard: { shardId: SHARD_ID, regionId: LIVE_REGION },
        automatic: true,
        reason: "a pre-declared SLI guardrail regressed",
        requestedAtMs: Date.now(),
      });
      assert(authorisation.authorised, "the rollback was refused");

      const outcome = await publisher.publishRollback(authorisation.action);
      assert(outcome.published, `publish refused: ${JSON.stringify(outcome.refusal)}`);
      rolledBackVersion = outcome.version;

      const pinRow = await prisma.configActiveVersion.findFirst();
      assert(pinRow && pinRow.version === outcome.version, `pinned ${pinRow && pinRow.version}, published ${outcome.version}`);
      return `version ${outcome.version} published by \`${rollbackPublisher.PUBLISHER}\` and pinned`;
    });

    await accepted("B3", "after the pull, the shard's live check answers FALSE — the rollback took effect", async () => {
      // Before this remediation the controller reported `rolledBack: 1`, wrote the audit
      // event, and left this assertion false: the shard stayed live, and because
      // `store.declarationFor` returns null once the latest event is a rollback, it was
      // never assessed against its guardrails again.
      await pull();
      assert(locals.config.version === rolledBackVersion, `reader is on ${locals.config.version}, expected ${rolledBackVersion}`);
      const live = enabled.forShard({
        snapshot: locals.config,
        shard: { shardId: SHARD_ID, regionId: LIVE_REGION },
        env: { ENGINE_ENABLED: "true" },
      });
      assert(live === false, "the rolled-back shard is still live");
      return `forShard(${LIVE_REGION}) = false at version ${rolledBackVersion}`;
    });

    await accepted("B4", "every other binding survived the rollback — a per-shard control made no fleet-wide change", async () => {
      const ttl = locals.config.resolve("dispatch.retry_window", { region: DARK_REGION });
      assert(ttl === 45, `the unrelated region binding was lost: dispatch.retry_window = ${ttl}`);
      const reserve = locals.config.resolve("route.degraded_reserve_factor", {});
      assert(reserve === V9_ACCOMMODATION.value, `the global binding was lost: ${reserve}`);
      return "the unrelated region binding and the global binding are both intact";
    });

    await accepted("B5", "the published version records itself as automated, and names the mechanism", async () => {
      const row = await prisma.configVersion.findUnique({ where: { version: rolledBackVersion } });
      assert(row.publishedBy === rollbackPublisher.PUBLISHER, `publishedBy = ${row.publishedBy}`);
      assert(Array.isArray(row.safetyClassChanges) && row.safetyClassChanges.length === 0,
        `an automated publish changed Safety-class parameters: ${JSON.stringify(row.safetyClassChanges)}`);
      return `publishedBy=${row.publishedBy}; safetyClassChanges=[] (§22.3 holds)`;
    });

    await accepted("B6", "PLANTED — a rollback carrying an ENABLE is refused, and writes nothing", async () => {
      const before = await prisma.configVersion.count();
      const publisher = rollbackPublisher.create({
        // Well-formed as a reading, so the refusal below is about the ACTION being an
        // ENABLE and not about the version reading — a fixture that is refused for the
        // wrong reason proves nothing about the rule under test (P15-E2).
        versionInForce: async () => ({ version: 1, latestVersion: 1, payload: { bindings: [] } }),
        publish: async () => {
          throw new Error("publish must not be reached");
        },
        pin: async () => {
          throw new Error("pin must not be reached");
        },
      });
      const outcome = await publisher.publishRollback({
        type: stage.ACTION.ROLLBACK,
        shardId: SHARD_ID,
        regionId: LIVE_REGION,
        binding: { level: "region", key: LIVE_REGION, name: enabled.PARAMETER, value: true },
      });
      assert(!outcome.published, "an enable was published");
      assert(outcome.refusal.code === rollbackPublisher.REFUSAL.BINDING_NOT_A_DISABLE, outcome.refusal.code);
      const after = await prisma.configVersion.count();
      assert(after === before, `the refused publish still wrote a version (${before} → ${after})`);
      return `refused ${outcome.refusal.code}; ConfigVersion count unchanged at ${after}`;
    });

    /* ── C. P15-R3 — §18.5 Custodial Operation ───────────────────────────── */
    console.log("\n── C. P15-R3 — a real degraded mode stops a real command ──");

    const emitted = [];
    const io = {
      in: () => ({ fetchSockets: async () => [{ id: "sock-1" }] }),
      to: () => ({ emit: (event, envelope) => emitted.push({ event, envelope }) }),
    };
    // Bound exactly as `server.js` binds it — the whole point of the check.
    const productionArm = commandDispatcher.outboxDeliveryArm(io, {
      activeModes: () => degradedTransitions.activeModes({ prisma }, SHARD_ID),
    });

    await accepted("C1", "with no mode open, the arm delivers", async () => {
      const outcome = await productionArm(`${P}-agent`, { command: "STOP" });
      assert(outcome.delivered === true, JSON.stringify(outcome));
      return `delivered; ${emitted.length} emit(s)`;
    });

    await accepted("C2", "with CUSTODIAL_OPERATION open in the STORE, the same arm refuses", async () => {
      // The mode is entered through the shipped module against the real table, so what the
      // arm reads is a row PostgreSQL returned rather than an array a test wrote.
      await degradedTransitions.enter(
        { prisma },
        {
          shardId: SHARD_ID,
          mode: modeRegister.MODE.CUSTODIAL_OPERATION,
          cause: "harness: the commitment store is unavailable",
          enteringComponent: "tools/verify/phase15CurrentTree.js",
          atMs: Date.now(),
        },
      );
      const open = await degradedTransitions.activeModes({ prisma }, SHARD_ID);
      assert(open.includes(modeRegister.MODE.CUSTODIAL_OPERATION), `open modes: ${JSON.stringify(open)}`);

      const before = emitted.length;
      const outcome = await productionArm(`${P}-agent`, { command: "STOP" });
      assert(outcome.delivered === false, `the command was delivered under ${modeRegister.MODE.CUSTODIAL_OPERATION}`);
      assert(outcome.detail === `COMMANDS_SUSPENDED:${modeRegister.MODE.CUSTODIAL_OPERATION}`, outcome.detail);
      assert(emitted.length === before, "the command reached the wire anyway");
      return `${outcome.detail}; no emit`;
    });

    await accepted("C3", "PLANTED — the composition root's OLD binding delivers the same command", async () => {
      // The defect, reproduced beside its fix and against the same open mode: with
      // `activeModes: () => []` the command goes out under Custodial Operation. This is what
      // the tree did before this remediation, and no test could see it because the constant
      // was in `server.js`.
      const oldArm = commandDispatcher.outboxDeliveryArm(io, { activeModes: () => [] });
      const before = emitted.length;
      const outcome = await oldArm(`${P}-agent`, { command: "STOP" });
      assert(outcome.delivered === true, "the planted defect did not reproduce");
      assert(emitted.length === before + 1, "no emit was recorded");
      return "the constant empty mode set delivers a command §18.5 forbids — the finding, reproduced";
    });

    await accepted("C4", "once the mode exits, delivery resumes", async () => {
      // §18.5's two-step exit, both halves. The evidence is what the module demands; a
      // shortcut here would exit a mode the specification says may not be exited yet.
      const exited = await degradedTransitions.exit(
        { prisma },
        {
          shardId: SHARD_ID,
          mode: modeRegister.MODE.CUSTODIAL_OPERATION,
          atMs: Date.now(),
          exitingComponent: "tools/verify/phase15CurrentTree.js",
          evidence: { storeAvailable: true, reconciliationComplete: true },
        },
      );
      assert(exited.exited === true, `the mode did not exit: ${exited.reason}`);
      const open = await degradedTransitions.activeModes({ prisma }, SHARD_ID);
      assert(open.length === 0, `modes still open: ${JSON.stringify(open)}`);
      const outcome = await productionArm(`${P}-agent`, { command: "STOP" });
      assert(outcome.delivered === true, JSON.stringify(outcome));
      return "the mode set is read per delivery, so exiting the mode restores it without a restart";
    });

    /* ── D. X2a / X2b — §4.5's deadline outside §4.4 ─────────────────────── */
    console.log("\n── D. X2a / X2b — a Leg state entered outside §4.4 is supervised (I4) ──");

    for (const [state, parameter] of [
      ["ACCEPTED", "execute.start_grace"],
      ["QUEUED", "sla.assignment_deadline"],
      ["PLANNED", "commit.hardening_deadline"],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await accepted(`D-${state}`, `entering ${state} arms ${parameter} and cancels the OFFERED deadline`, async () => {
        const leg = await offeredLeg(state.toLowerCase());
        const storeTime = new Date();

        await prisma.$transaction(async (tx) => {
          const count = await tx.leg.updateMany({
            where: { id: leg.id, version: leg.version },
            data: { state, version: leg.version + 1 },
          });
          assert(count.count === 1, "the conditional Leg write matched no row");
          return legEntryDeadline.superviseEntry(tx, {
            leg,
            state,
            storeTime,
            deadlineSeconds: 600,
            event: "HARNESS",
            shardId: SHARD_ID,
          });
        });

        const rows = await prisma.timer.findMany({ where: { entityId: leg.id } });
        const pending = rows.filter((r) => r.timerState === "PENDING");
        assert(pending.length === 1, `expected one pending timer, found ${pending.length}`);
        assert(pending[0].state === state, `pending timer is for ${pending[0].state}`);
        assert(pending[0].handler === legMachine.deadlineFor(state).onExpiry, `handler ${pending[0].handler}`);
        assert(String(pending[0].entityVersion) === "1", `keyed on version ${pending[0].entityVersion}, expected 1`);
        assert(legEntryDeadline.deadlineParameterFor(state) === parameter, "the parameter came from somewhere else");

        // The state's own §4.5 obligation, judged by the module that judges it in
        // production rather than by counting rows here.
        const unsupervised = await timers.findUnsupervised(prisma, { limit: 100 });
        assert(
          !unsupervised.some((row) => row.entityId === leg.id),
          "findUnsupervised still reports this Leg — I4's violation",
        );
        return `pending ${pending[0].state} timer at version 1; OFFERED cancelled; findUnsupervised clean`;
      });
    }

    await accepted("D-ROLLBACK", "an unresolvable deadline rolls the whole state change back", async () => {
      const leg = await offeredLeg("rollback");
      let threw = null;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.leg.updateMany({ where: { id: leg.id, version: 0 }, data: { state: "ACCEPTED", version: 1 } });
          return legEntryDeadline.superviseEntry(tx, {
            leg,
            state: "ACCEPTED",
            storeTime: new Date(),
            deadlineSeconds: undefined,
            event: "HARNESS",
          });
        });
      } catch (error) {
        threw = error;
      }
      assert(threw, "the transaction committed with no deadline");
      assert(/execute\.start_grace did not resolve/.test(threw.message), threw.message);

      const after = await prisma.leg.findUnique({ where: { id: leg.id } });
      assert(after.state === "OFFERED" && after.version === 0, `Leg moved anyway: ${after.state} v${after.version}`);
      const pending = await prisma.timer.findMany({ where: { entityId: leg.id, timerState: "PENDING" } });
      assert(pending.length === 1 && pending[0].state === "OFFERED", "the OFFERED deadline was cancelled by a rolled-back write");
      return "state=OFFERED version=0; the OFFERED deadline survives — nothing half-applied";
    });

    await accepted("D-PLANTED", "PLANTED — skipping the deadline leaves the Leg unsupervised, and it is DETECTED", async () => {
      // The unremediated behaviour, planted: write the state and register nothing. This is
      // what `offers.applyAccept` did on every accepted offer.
      const leg = await offeredLeg("planted");
      await prisma.$transaction(async (tx) => {
        await tx.leg.updateMany({ where: { id: leg.id, version: 0 }, data: { state: "ACCEPTED", version: 1 } });
        await timers.cancelFor(tx, {
          entityType: timers.ENTITY_TYPE.LEG,
          entityId: leg.id,
          storeTime: new Date(),
          reason: "EXITED_OFFERED",
        });
      });
      const unsupervised = await timers.findUnsupervised(prisma, { limit: 200 });
      const found = unsupervised.some((row) => row.entityId === leg.id);
      assert(found, "an ACCEPTED Leg with no pending timer was NOT reported — the detector is broken too");

      // And restoring supervision clears it, so the detector is not simply always-true.
      const current = await prisma.leg.findUnique({ where: { id: leg.id } });
      await prisma.$transaction((tx) =>
        legEntryDeadline.superviseEntry(tx, {
          leg: { ...current, version: current.version - 1 },
          state: "ACCEPTED",
          storeTime: new Date(),
          deadlineSeconds: 600,
          event: "HARNESS_REPAIR",
        }),
      );
      const again = await timers.findUnsupervised(prisma, { limit: 200 });
      assert(!again.some((row) => row.entityId === leg.id), "supervision was restored and the Leg is still reported");
      return "findUnsupervised reports the planted Leg (I4) and stops once the deadline is armed";
    });

    /* ── E. P15-R6 — the shard → region read ─────────────────────────────── */
    console.log("\n── E. P15-R6 — the timer worker's operating region ──");

    await accepted("E1", "the two 'region ids' are DIFFERENT strings, so this check is not vacuous", async () => {
      // The same class of trap as the earlier harness's A1, and it caught this exercise's own
      // first attempt at the fix: `Shard.regionId` is a **foreign key to `Region.id`** (a
      // uuid), while `Region.regionId` is the operator-facing identifier. A fixture that used
      // one value for both could not tell them apart, and getting it wrong yields
      // `NO_CONTACT_CONFIGURED` — a silent no-op, not a crash.
      const row = await prisma.shard.findUnique({ where: { shardId: SHARD_ID }, select: { regionId: true } });
      assert(row && row.regionId, "the shard row carries no region");
      const region = await prisma.region.findUnique({ where: { id: row.regionId } });
      assert(row.regionId !== region.regionId, "this database cannot distinguish the two, so the check is vacuous");
      return `Shard.regionId='${row.regionId}' (a Region row id) ≠ Region.regionId='${region.regionId}'`;
    });

    await accepted("E2", "the composer's read resolves through `Region` to the identifier an operator authors", async () => {
      // §18.6's contact set is a map an operator writes, keyed by the region they know. The
      // read below is exactly the one `server.js` performs.
      const row = await prisma.shard.findUnique({
        where: { shardId: SHARD_ID },
        select: { region: { select: { regionId: true } } },
      });
      const resolved = row && row.region && row.region.regionId;
      assert(resolved === LIVE_REGION, `resolved '${resolved}', expected '${LIVE_REGION}'`);

      // And it is the key `resolveContactSet` actually looks up, so the join is checked
      // rather than assumed.
      const externalEscalation = require("../../src/engine/failure/externalEscalation");
      const contacts = { [LIVE_REGION]: { owner: "site-security", contacts: ["+00"], reviewedAtMs: Date.now() } };
      const matched = externalEscalation.resolveContactSet({ contacts, regionId: resolved, nowMs: Date.now() });
      assert(matched.configured === true, `the resolved region did not match a configured contact set: ${matched.disposition}`);

      const missed = externalEscalation.resolveContactSet({
        contacts,
        regionId: (await prisma.shard.findUnique({ where: { shardId: SHARD_ID }, select: { regionId: true } })).regionId,
        nowMs: Date.now(),
      });
      assert(missed.configured === false, "the row id matched a contact set, so this check proves nothing");
      return `Region.regionId matches the contact set; Shard.regionId does not (${missed.disposition})`;
    });

    /* ── F. P15-R5 — the intake path's cutover question ──────────────────── */
    console.log("\n── F. P15-R5 — a caller that names no region ──");

    await accepted("F3", "a GLOBAL binding is publishable and resolvable — the deployment shape the defect needs", async () => {
      const v = await publishAndPin(
        [{ level: "global", key: "", name: enabled.PARAMETER, value: true }, stagedBinding(true)],
        "operator-a",
      );
      await pull();
      assert(locals.config.version === v, "the global-binding version was not adopted");
      assert(locals.config.resolve(enabled.PARAMETER, {}) === true, "the global binding does not resolve");
      return `version ${v}: global ${enabled.PARAMETER}=true and ${LIVE_REGION}=true both published`;
    });

    await accepted("F4", "against that snapshot, a caller with no region is REFUSED, not answered globally", async () => {
      const env = { ENGINE_ENABLED: "true" };
      const staged = enabled.forShard({ snapshot: locals.config, shard: { shardId: SHARD_ID, regionId: LIVE_REGION }, env });
      const nameless = enabled.forShard({ snapshot: locals.config, shard: { shardId: "x", regionId: null }, env });
      assert(staged === true, "the staged shard is not live");
      // The finding, stated exactly. `regionId: null` used to resolve at global scope and
      // return the deployment-wide `true`, so omitting the region — which the intake path
      // takes from the **request body** — was a way past the per-shard staging decision.
      assert(nameless === false, "a caller with NO region inherited the global binding — the fail-open");
      const posture = enabled.describe({ snapshot: locals.config, shard: { regionId: null }, env });
      assert(posture.consequence === enabled.REGION_UNRESOLVED, "the refusal does not name the caller");
      return "staged=true; no-region=false, named REGION_UNRESOLVED rather than answered from the global binding";
    });

    await accepted("F5", "NOT A DEFECT, recorded — a region with no binding of its own does inherit the global one", async () => {
      // §22.2's hierarchy: a region binding overrides a global one, and absent a region
      // binding the global applies. So a deployment that publishes a *global* `true` has
      // staged every region at once, which is the opposite of a staged rollout — and it is
      // the operator's own explicit act, not a fail-open. Recorded here because the
      // distinction between this and F4 is the whole of P15-R5, and a reader who conflates
      // them will read F4's fix as broader than it is.
      //
      // The authorised path cannot produce this: `stage.authoriseEnable` emits a binding at
      // `region` scope, never `global`, so a global `true` can only be hand-published.
      const env = { ENGINE_ENABLED: "true" };
      const unstaged = enabled.forShard({ snapshot: locals.config, shard: { shardId: "x", regionId: DARK_REGION }, env });
      assert(unstaged === true, "the resolver's global→region hierarchy has changed");
      const authorised = stage.authoriseEnable({
        shard: { shardId: SHARD_ID, regionId: LIVE_REGION, state: "ACTIVE", agentCount: 3 },
        requestedBy: "a",
        approvedBy: "b",
        reason: "harness",
        evidence: {},
      });
      const binding = authorised.action ? authorised.action.binding : { level: "region" };
      assert(binding.level === "region", `authoriseEnable emitted a ${binding.level}-scope binding`);
      return "an unbound region inherits the global binding (§22.2), and `authoriseEnable` only ever emits region scope";
    });

    /* ── G. What is NOT fixed, reproduced rather than asserted ───────────── */
    console.log("\n── G. Findings this exercise did NOT fix — reproduced, with owners ──");

    await accepted("G1", "FINDING X3 — no §4.2 Task state is written anywhere, so no TASK timer has a producer", async () => {
      const taskTimers = await prisma.timer.count({ where: { entityType: "TASK" } });
      assert(taskTimers === 0, `expected 0 TASK timers, found ${taskTimers}`);
      return (
        `TASK-entity timers in the store after this whole harness: ${taskTimers}. Intake writes the LEGACY ` +
        "`PENDING`, and §4.2 has no transition table at all — so adopting `RECEIVED` would arm " +
        "`intake.validation_budget` on a state with no defined exit. SPECIFICATION blocker, not composition."
      );
    });

    await accepted("G2", "FINDING — the coordinator and shadow workers remain uncomposable (B1)", async () => {
      const leaderWorkers = require("../../src/workers/leaderWorkers");
      const blockers = Object.keys(leaderWorkers.UNCOMPOSABLE);
      assert(blockers.length === 1 && blockers[0] === "coordinator", `UNCOMPOSABLE: ${blockers.join(", ")}`);
      assert(leaderWorkers.UNCOMPOSABLE.coordinator.external === true, "the coordinator's blocker is not marked external");
      const registry = require("../../src/workers/registry");
      const shadow = registry.WORKERS.find((w) => w.id === "shadow");
      assert(shadow && shadow.blockedBy, "the shadow worker no longer declares a blocker");
      return "coordinator [EXTERNAL, B1]; shadow DEFERRED on the same solve path. Unchanged by this exercise.";
    });

    await accepted("G3", "FINDING — `gate:calibration` and the publish validator agree: B8 blocks the cutover", async () => {
      const bare = configService.validateCandidate({ bindings: [] });
      assert(bare.result.blocking.some((f) => f.id === "V9"), "V9 no longer refuses the defaults");
      const launch = bare.result.launchGate || [];
      assert(launch.length > 0, "the launch gate reports nothing against register defaults");
      return `defaults refused by V9; ${launch.length} launch-gate finding(s). Owner: B8 (§22.4's calibration owner).`;
    });

    console.log("\n── cleanup ──");
    await accepted("Z1", "remove every row this harness created", async () => {
      await purge();
      return "clean";
    });
  } finally {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${"═".repeat(78)}`);
    console.log(`PHASE 15 current-tree verification: ${results.length - failed.length}/${results.length} passed`);
    if (failed.length > 0) {
      console.log("FAILED:");
      for (const f of failed) console.log(`  ${f.id}  ${f.title}\n        ${f.detail}`);
    }
    console.log("═".repeat(78));
    await prisma.$disconnect();
    process.exitCode = failed.length === 0 ? 0 : 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

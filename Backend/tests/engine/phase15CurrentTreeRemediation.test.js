"use strict";

/**
 * Engine lane — the current-tree Phase 15 re-audit's six findings, and their fixes.
 *
 * ── Why this suite exists, and what it is guarding against ─────────────────
 * Every finding below is the same shape, and it is the shape this programme has now
 * recorded six times: **a mechanism that is implemented, unit-tested, and not connected to
 * the thing that would make it act.** None of the six was catchable by the suite as it
 * stood, and the reason is uniform — each test constructed the dependency the composition
 * root was failing to supply, and handed it to the function under test.
 *
 * So each test here asks the question the old ones could not: *what does the shipped
 * composition actually pass, and what does the shipped module do with it?* Where the answer
 * is a fact about `server.js` — which no test may require, because Phase 0's scaffold guard
 * forbids it — the assertion is made against the source text and is paired with a
 * behavioural test of the module that text configures. A source-text assertion alone is a
 * proxy; a behavioural assertion alone cannot see a dependency nobody supplies.
 *
 *   P15-R1  the automatic rollback published nothing, so a breaching shard stayed live —
 *           and, because `store.declarationFor` then returns null, was never assessed again.
 *   P15-R2  nothing ever re-read the pinned configuration, so the per-shard cutover switch
 *           could not be actuated on a running process in either direction.
 *   P15-R3  the production delivery arm was bound to a constant empty mode set, so §18.5
 *           Custodial Operation suspended nothing.
 *   P15-R4  the socket intake path read `io.app.locals.config`, which does not exist.
 *   P15-R5  the intake path's cutover check inherited the **global** binding when no region
 *           was named — D-13's substitution, one module along.
 *   P15-R6  the timer worker was composed with no `regionId`, so §18.6's contact set could
 *           never resolve.
 *   X2a/X2b four production paths entered a Leg state and registered no §4.5 deadline (I4).
 */

const fs = require("fs");
const path = require("path");

const commandDispatcher = require("../../src/services/commandDispatcher.service");
const configPropagation = require("../../src/engine/cutover/configPropagation");
const cutoverWorker = require("../../src/workers/cutover.worker");
const enabled = require("../../src/engine/cutover/enabled");
const guardrails = require("../../src/engine/cutover/guardrails");
const legEntryDeadline = require("../../src/engine/cutover/legEntryDeadline");
const legMachine = require("../../src/engine/lifecycle/legMachine");
const leaderWorkers = require("../../src/workers/leaderWorkers");
const modeRegister = require("../../src/engine/degraded/modeRegister");
const offers = require("../../src/engine/dispatch/offers");
const outboxWorker = require("../../src/workers/outbox.worker");
const rollbackPublisher = require("../../src/engine/cutover/rollbackPublisher");
const stage = require("../../src/engine/cutover/stage");
const timers = require("../../src/engine/supervision/timers");

const fixtures = require("./helpers/dispatchFixture");

const BACKEND_ROOT = path.join(__dirname, "..", "..");

/**
 * A file's **code**, with comments removed.
 *
 * Not fussiness. Every fix in this suite carries a comment that quotes the defect it
 * replaced — which is the documentation this programme wants and which makes a naive
 * "the old text is absent" assertion pass or fail for the wrong reason. Stripping comments
 * is what lets the assertion mean "no code does this any more" rather than "nobody wrote
 * about it". The stripping is deliberately crude and only ever used on assertions whose
 * behavioural counterpart is also tested here.
 */
function codeOf(relativePath) {
  const source = fs.readFileSync(path.join(BACKEND_ROOT, relativePath), "utf8");
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const serverSource = () => codeOf("server.js");
const socketServerSource = () => codeOf(path.join("src", "sockets", "socket.server.js"));

const REGION = "region-alpha";

/* ═══════════════════════════════════════════════════════════════════════════
   P15-R5 — the per-shard question is refused without a shard
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P15-R5 — a caller that names no region does not inherit the global binding", () => {
  /**
   * A snapshot holding **both** a global binding and a per-region one, which the register
   * permits (`cutover.engine_enabled` declares `scopes: ["global", "region"]`). This is the
   * deployment shape the defect needs, and no earlier test constructed it.
   */
  const bothScopes = {
    resolve: (name, context) => {
      if (name !== enabled.PARAMETER) return undefined;
      if (context && context.region === REGION) return true;
      if (context && context.region) return false;
      return true; // the global binding
    },
  };
  const env = { ENGINE_ENABLED: "true" };

  test("a staged region is live and an unstaged one is not — the per-shard answer is unchanged", () => {
    expect(enabled.forShard({ snapshot: bothScopes, shard: { shardId: "s1", regionId: REGION }, env })).toBe(true);
    expect(enabled.forShard({ snapshot: bothScopes, shard: { shardId: "s2", regionId: "region-beta" }, env })).toBe(
      false,
    );
  });

  test("a shard with no region is REFUSED, not answered from the deployment-wide binding", () => {
    // Before the fix this returned `true`: the empty resolution context resolved
    // `cutover.engine_enabled` at global scope, so "is the whole deployment cut over"
    // answered "is *this shard* cut over". `services/task.service.js` takes the region from
    // the **request body**, which made "omit regionId" a way onto a shard the staging order
    // had not reached.
    expect(enabled.forShard({ snapshot: bothScopes, shard: { shardId: "s3", regionId: null }, env })).toBe(false);
    expect(enabled.forShard({ snapshot: bothScopes, shard: {}, env })).toBe(false);
  });

  test("every falsy and blank spelling of 'no region' is refused, not just null", () => {
    for (const regionId of [null, undefined, "", "   "]) {
      expect(enabled.configEnabled(bothScopes, { shardId: "s", regionId })).toBe(false);
    }
  });

  test("the refusal names the caller rather than the staging order", () => {
    const posture = enabled.describe({ snapshot: bothScopes, shard: { shardId: "s3", regionId: null }, env });
    expect(posture.live).toBe(false);
    expect(posture.consequence).toBe(enabled.REGION_UNRESOLVED);
    // Distinct from "this shard is not staged yet", which is a different incident.
    expect(posture.consequence).not.toBe(enabled.SHARD_HAS_NO_DECISION_PATH);

    const notStaged = enabled.describe({ snapshot: bothScopes, shard: { shardId: "s2", regionId: "region-beta" }, env });
    expect(notStaged.consequence).toBe(enabled.SHARD_HAS_NO_DECISION_PATH);
  });

  test("the resolution context always carries the region — never an empty object", () => {
    const contexts = [];
    const recording = {
      resolve: (name, context) => {
        contexts.push(context);
        return true;
      },
    };
    enabled.configEnabled(recording, { shardId: "s1", regionId: REGION });
    enabled.configEnabled(recording, { shardId: "s1", regionId: null });
    // Exactly one resolve happened, and it named the region. The null case never reached
    // the snapshot at all, which is the point: the question is refused, not answered.
    expect(contexts).toEqual([{ region: REGION }]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   P15-R4 — the socket intake path's configuration source
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P15-R4 — the socket `assign_task` path reads a snapshot that exists", () => {
  test("`io.app` is never assigned anywhere, so reading through it yielded null for ever", () => {
    const sources = [serverSource(), socketServerSource()];
    for (const source of sources) expect(/\bio\.app\s*=/.test(source)).toBe(false);
    // A Socket.IO server has no `app`. The read failed *closed*, which is why nothing
    // caught it: socket intake simply never worked, on any shard, including a correctly
    // staged one.
    const io = {};
    expect(io?.app?.locals?.config ?? null).toBeNull();
  });

  test("the handler reads `appLocals`, the parameter Phase 14 threaded in for this", () => {
    const source = socketServerSource();
    expect(source).not.toContain("io?.app?.locals?.config");
    expect(source).toMatch(/config:\s*appLocals\?\.config\s*\?\?\s*null/);
    // `appLocals` is a parameter of `initSocketServer`, and the handler is inside it.
    expect(source).toMatch(/function initSocketServer\([^)]*appLocals/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   P15-R3 — §18.5 Custodial Operation on the production delivery arm
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P15-R3 — a suspending degraded mode stops a command at the single exit", () => {
  function ioRecording(emitted) {
    return {
      in: () => ({ fetchSockets: async () => [{ id: "sock-1" }] }),
      to: () => ({ emit: (event, envelope) => emitted.push({ event, envelope }) }),
    };
  }

  const SUSPENDING = modeRegister.MODE.CUSTODIAL_OPERATION;

  test("the mode register does suspend commands in Custodial Operation", () => {
    // Pinned so the test below cannot pass because the *register* stopped suspending.
    expect(modeRegister.commandsSuspended([SUSPENDING]).suspended).toBe(true);
  });

  test("an ASYNCHRONOUS mode accessor is awaited — the real producer is a query", () => {
    // `degraded/transitions.activeModes()` reads `DegradedModeEvent`, so it returns a
    // promise. Before the fix the option was read synchronously, and a promise is not an
    // array, so `commandsSuspended` saw an empty set: a fail-open that looks wired.
    const emitted = [];
    const arm = commandDispatcher.outboxDeliveryArm(ioRecording(emitted), {
      activeModes: async () => [SUSPENDING],
    });
    return arm("agent-1", { command: "STOP" }).then((outcome) => {
      expect(outcome.delivered).toBe(false);
      expect(outcome.detail).toBe(`COMMANDS_SUSPENDED:${SUSPENDING}`);
      expect(emitted).toHaveLength(0);
    });
  });

  test("a synchronous accessor and a plain array still behave exactly as before", async () => {
    const emitted = [];
    const io = ioRecording(emitted);
    expect((await commandDispatcher.outboxDeliveryArm(io, { activeModes: () => [SUSPENDING] })("a", { command: "STOP" })).delivered).toBe(
      false,
    );
    expect((await commandDispatcher.deliverOutboxCommand(io, "a", { command: "STOP" }, { activeModes: [SUSPENDING] })).delivered).toBe(
      false,
    );
    // And the legacy callers, which pass no options at all, are untouched.
    expect((await commandDispatcher.deliverOutboxCommand(io, "a", { command: "STOP" })).delivered).toBe(true);
  });

  test("an accessor that THROWS refuses the delivery rather than escaping or delivering", async () => {
    // A store blip is exactly the condition §18.5 is about. "We could not find out whether
    // commands are suspended" must never resolve to "they are not" — and it must not abort
    // the whole drain pass either.
    const emitted = [];
    const outcome = await commandDispatcher.outboxDeliveryArm(ioRecording(emitted), {
      activeModes: async () => {
        throw new Error("connection reset");
      },
    })("agent-1", { command: "STOP" });

    expect(outcome.delivered).toBe(false);
    expect(outcome.detail).toMatch(/^DEGRADED_MODE_UNREADABLE:/);
    expect(emitted).toHaveLength(0);
  });

  test("the mode set is read PER DELIVERY, so a mode opening mid-pass stops the next row", async () => {
    // The bind-time capture this replaces is what the module's own comment already warned
    // about: "a value captured at bind time would let a command out after Custodial
    // Operation opened."
    const emitted = [];
    let modes = [];
    const arm = commandDispatcher.outboxDeliveryArm(ioRecording(emitted), { activeModes: async () => modes });

    expect((await arm("agent-1", { command: "STOP" })).delivered).toBe(true);
    modes = [SUSPENDING];
    expect((await arm("agent-1", { command: "STOP" })).delivered).toBe(false);
    expect(emitted).toHaveLength(1);
  });

  test("the composition root binds the real producer, not a constant", () => {
    const source = serverSource();
    expect(source).not.toMatch(/activeModes:\s*\(\)\s*=>\s*\[\]/);
    expect(source).toMatch(/activeModes:\s*\(\)\s*=>\s*degradedTransitions\.activeModes\(\{ prisma \}, shardId\)/);
  });

  test("the outbox worker is not handed an `activeModes` it never reads", () => {
    // It was, and its presence beside a real §18.5 gap is most of why the gap read as
    // wired. `requireDeps` does not ask for it and `drainOnce` does not use it.
    const workerSource = codeOf(path.join("src", "workers", "outbox.worker.js"));
    expect(workerSource).not.toMatch(/^\s*activeModes\b/m);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   P15-R2 — the pull half of pull-with-pin
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P15-R2 — a published configuration version reaches a running process", () => {
  function propagator(overrides) {
    const applied = [];
    const errors = [];
    const state = { currentVersion: 1 };
    const deps = {
      load: async () => ({ version: 2, values: new Map() }),
      apply: (snapshot) => applied.push(snapshot),
      onError: (error) => errors.push(error),
      ...(overrides || {}),
    };
    return { deps, state, applied, errors };
  }

  test("a newer pinned version is adopted", async () => {
    const { deps, state, applied } = propagator();
    const result = await configPropagation.refreshOnce(deps, state);
    expect(result).toMatchObject({ changed: true, version: 2 });
    expect(applied).toHaveLength(1);
    expect(state.currentVersion).toBe(2);
  });

  test("the same version is not re-applied — the version is the unit, not the object", async () => {
    const { deps, state, applied } = propagator({ load: async () => ({ version: 1 }) });
    const result = await configPropagation.refreshOnce(deps, state);
    expect(result).toMatchObject({ changed: false, reason: "UNCHANGED" });
    expect(applied).toHaveLength(0);
  });

  test("a load failure keeps the current version and is reported, never fatal and never a downgrade", async () => {
    const { deps, state, applied, errors } = propagator({
      load: async () => {
        throw new Error("store unreachable");
      },
    });
    const result = await configPropagation.refreshOnce(deps, state);
    expect(result).toMatchObject({ changed: false, version: 1, reason: "LOAD_FAILED" });
    expect(applied).toHaveLength(0);
    expect(errors).toHaveLength(1);
    // The process keeps serving on the version it had. Losing a configuration because the
    // store blinked is the one outcome that must not be possible here.
    expect(state.currentVersion).toBe(1);
  });

  test("nothing published is not the same as a version to adopt", async () => {
    const { deps, state, applied } = propagator({ load: async () => null });
    expect(await configPropagation.refreshOnce(deps, state)).toMatchObject({ reason: "NOTHING_PUBLISHED" });
    expect(applied).toHaveLength(0);
  });

  test("an unversioned snapshot is refused rather than installed", async () => {
    const { deps, state, applied, errors } = propagator({ load: async () => ({ values: new Map() }) });
    expect(await configPropagation.refreshOnce(deps, state)).toMatchObject({ reason: "UNVERSIONED", changed: false });
    expect(applied).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  test("a rolled-back binding actually reaches the shard check once it propagates", async () => {
    // The end-to-end statement of the finding, in one test: the same reader, before and
    // after a pull, against the two published versions a rollback produces.
    const staged = { version: 4, resolve: (name, ctx) => (ctx.region === REGION ? true : undefined) };
    const rolledBack = { version: 5, resolve: (name, ctx) => (ctx.region === REGION ? false : undefined) };
    const env = { ENGINE_ENABLED: "true" };
    const shard = { shardId: "s1", regionId: REGION };

    const locals = { config: staged };
    expect(enabled.forShard({ snapshot: locals.config, shard, env })).toBe(true);

    const state = { currentVersion: 4 };
    await configPropagation.refreshOnce(
      { load: async () => rolledBack, apply: (s) => { locals.config = s; } },
      state,
    );

    expect(enabled.forShard({ snapshot: locals.config, shard, env })).toBe(false);
  });

  test("the composition root starts the propagator and stops it on shutdown", () => {
    const source = serverSource();
    expect(source).toMatch(/configPropagator = configPropagation\.start\(/);
    expect(source).toMatch(/load: \(\) => configService\.loadPinnedSnapshot\(\{ prisma, kv \}\)/);
    expect(source).toMatch(/app\.locals\.config = snapshot/);
    expect(source).toMatch(/configPropagator\?\.stop\?\.\(\)/);
  });

  test("the staged-rollout controller reads the current snapshot, not the boot one", () => {
    const source = serverSource();
    expect(source).toMatch(/liveShards: \(\) => cutoverStore\.liveShards\(\{ prisma \}, \{ snapshot: snapshotOf\(\) \}\)/);
  });

  test("the LEADER_ONLY composers resolve configuration at promotion, not at boot", () => {
    // A `values` map captured in `create()` bound every LEADER_ONLY worker to the version
    // the *process* booted on, permanently — so a republished deadline would be adopted by
    // the request path and ignored by the workers.
    //
    // The assertion is on the **value the composer resolved**, not on whether composition
    // succeeded. The first version of this test asserted `ok === true`, and a planted
    // mutation that stopped calling the accessor survived it: every parameter resolved to
    // `undefined` and the composer still returned a handle. A test that cannot tell a
    // resolved configuration from an empty one is not testing the resolution.
    const settingsSeen = [];
    const spy = jest.spyOn(outboxWorker, "start").mockImplementation((deps, settings) => {
      settingsSeen.push(settings);
      return { stop() {} };
    });

    try {
      let current = new Map([["dispatch.retry_window", 30], ["sla.assignment_deadline", 600]]);
      const composerContext = {
        prisma: {},
        io: {},
        values: () => current,
        deliver: async () => ({ delivered: true }),
        runInTransaction: async (fn) => fn({}),
        record: () => {},
        instanceId: "i1",
      };

      leaderWorkers.COMPOSERS.outbox(composerContext).handle.stop();
      expect(settingsSeen[0].retryWindowSeconds).toBe(30);

      // A republish between two promotions.
      current = new Map([["dispatch.retry_window", 60], ["sla.assignment_deadline", 900]]);
      leaderWorkers.COMPOSERS.outbox(composerContext).handle.stop();
      expect(settingsSeen[1].retryWindowSeconds).toBe(60);
      expect(settingsSeen[1].assignmentDeadlineSeconds).toBe(900);

      // And a plain map is still accepted unchanged, which is what every other caller passes.
      leaderWorkers.COMPOSERS.outbox({ ...composerContext, values: current }).handle.stop();
      expect(settingsSeen[2].retryWindowSeconds).toBe(60);
    } finally {
      spy.mockRestore();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   P15-R1 — the automatic rollback publishes the reverted binding
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P15-R1 — an automatic rollback takes a shard out of service", () => {
  const SHARD = Object.freeze({ shardId: "shard-1", regionId: REGION, state: "ACTIVE", agentCount: 3 });

  function rollbackAction(overrides) {
    const authorisation = stage.authoriseRollback({
      shard: SHARD,
      automatic: true,
      reason: "a pre-declared SLI guardrail regressed",
      requestedAtMs: 3000,
    });
    return { ...authorisation.action, ...(overrides || {}) };
  }

  function publisher(overrides) {
    const published = [];
    const pinned = [];
    const deps = {
      // PHASE 15 remediation (P15-E2) — `versionInForce` reports **which** version it read
      // as well as its payload, and `publishRollback` refuses a reading that does not. The
      // fixture is unchanged in substance; what it now also says is that the version it
      // describes is the one in force *and* the latest, which is the state this group is
      // about. The divergent state has its own tests below.
      versionInForce: async () => ({
        version: 8,
        latestVersion: 8,
        payload: {
          bindings: [
            { level: "region", key: REGION, name: enabled.PARAMETER, value: true },
            { level: "region", key: "region-beta", name: enabled.PARAMETER, value: true },
            { level: "global", key: "", name: "dispatch.offer_ttl", value: 45 },
          ],
          killSwitchState: { opportunity_cost_term: true },
          regimes: [],
          spatial: { some: "declaration" },
          shards: [{ shardId: "shard-1" }],
        },
      }),
      publish: async (request) => {
        published.push(request);
        return { version: 9 };
      },
      pin: async (version, publishedBy) => pinned.push({ version, publishedBy }),
      ...(overrides || {}),
    };
    return { instance: rollbackPublisher.create(deps), published, pinned };
  }

  test("it publishes `cutover.engine_enabled = false` for exactly the breaching region", async () => {
    const { instance, published } = publisher();
    const outcome = await instance.publishRollback(rollbackAction());

    expect(outcome).toMatchObject({ published: true, version: 9, pinned: true });
    const bindings = published[0].bindings;
    expect(bindings).toContainEqual({ level: "region", key: REGION, name: enabled.PARAMETER, value: false });
    // Exactly one binding for that (level, key, name) — replaced, not appended, so a
    // resolver is never handed two answers.
    expect(bindings.filter((b) => b.name === enabled.PARAMETER && b.key === REGION)).toHaveLength(1);
  });

  test("every other binding, kill switch, regime, spatial and shard declaration is carried forward", async () => {
    // A configuration version is a complete set. Publishing only the new binding would
    // revert every other parameter to its register default — a fleet-wide change issued by
    // a per-shard control.
    const { instance, published } = publisher();
    await instance.publishRollback(rollbackAction());

    expect(published[0].bindings).toContainEqual({ level: "region", key: "region-beta", name: enabled.PARAMETER, value: true });
    expect(published[0].bindings).toContainEqual({ level: "global", key: "", name: "dispatch.offer_ttl", value: 45 });
    expect(published[0].killSwitchState).toEqual({ opportunity_cost_term: true });
    expect(published[0].spatial).toEqual({ some: "declaration" });
    expect(published[0].shards).toEqual([{ shardId: "shard-1" }]);
  });

  test("it publishes as automated, which §22.3 permits only because the parameter is STRUCTURAL", async () => {
    const { instance, published } = publisher();
    await instance.publishRollback(rollbackAction());
    expect(published[0].automated).toBe(true);
    expect(published[0].publishedBy).toBe(rollbackPublisher.PUBLISHER);
  });

  test("it PINS the version it published — a version nothing observes is not a rollback", async () => {
    const { instance, pinned } = publisher();
    await instance.publishRollback(rollbackAction());
    expect(pinned).toEqual([{ version: 9, publishedBy: rollbackPublisher.PUBLISHER }]);
  });

  test("an ENABLE is refused: only the direction that lowers risk may be automated", async () => {
    const { instance, published } = publisher();
    const outcome = await instance.publishRollback({
      type: stage.ACTION.ENABLE,
      shardId: "shard-1",
      regionId: REGION,
      binding: { level: "region", key: REGION, name: enabled.PARAMETER, value: true },
    });
    expect(outcome.published).toBe(false);
    expect(outcome.refusal.code).toBe(rollbackPublisher.REFUSAL.NOT_A_ROLLBACK);
    expect(published).toHaveLength(0);
  });

  test("a ROLLBACK carrying anything but a disable of the cutover binding is refused", async () => {
    const cases = [
      { level: "region", key: REGION, name: enabled.PARAMETER, value: true },
      { level: "region", key: REGION, name: "dispatch.offer_ttl", value: 0 },
      { level: "global", key: "", name: enabled.PARAMETER, value: false },
      { level: "region", key: "", name: enabled.PARAMETER, value: false },
    ];
    for (const binding of cases) {
      const { instance, published } = publisher();
      // eslint-disable-next-line no-await-in-loop
      const outcome = await instance.publishRollback(rollbackAction({ binding }));
      expect(outcome.published).toBe(false);
      expect(outcome.refusal.code).toBe(rollbackPublisher.REFUSAL.BINDING_NOT_A_DISABLE);
      expect(published).toHaveLength(0);
    }
  });

  test("with no version in force it refuses rather than publishing register defaults", async () => {
    const { instance, published } = publisher({ versionInForce: async () => null });
    const outcome = await instance.publishRollback(rollbackAction());
    expect(outcome.published).toBe(false);
    expect(outcome.refusal.code).toBe(rollbackPublisher.REFUSAL.NO_VERSION_IN_FORCE);
    expect(published).toHaveLength(0);
  });

  test("the controller's pass hands the publisher a real disable, end to end", async () => {
    // The whole chain the finding is about, with the controller driving: breach → authorise
    // → publish → pinned binding. Before the fix the last two steps were a log line.
    const declaration = guardrails.declare({
      shardId: SHARD.shardId,
      declaredBy: "op-a",
      declaredAtMs: 1000,
      observationWindowSeconds: 600,
      guardrails: [
        { id: "commit_transaction_p99", direction: guardrails.DIRECTION.AT_MOST, threshold: 100, minSamples: 10 },
      ],
    });
    const { instance, published, pinned } = publisher();
    const audits = [];

    const pass = await cutoverWorker.runOnce(
      {
        liveShards: async () => [SHARD],
        declarationFor: async () => declaration,
        observationsFor: async () => ({
          windowStartedAtMs: 1000,
          windowEndedAtMs: 2000,
          observations: { commit_transaction_p99: { value: 100000, samples: 500, bound: null } },
          instances: ["i1"],
        }),
        publish: async (action) => {
          const outcome = await instance.publishRollback(action);
          if (!outcome.published) throw new Error(outcome.refusal.code);
        },
        audit: async (event) => audits.push(event),
      },
      { nowMs: 3000 },
    );

    expect(pass.rolledBack).toBe(1);
    expect(published).toHaveLength(1);
    expect(pinned).toHaveLength(1);
    expect(audits[0].eventType).toBe("CUTOVER_SHARD_ROLLED_BACK");
  });

  test("a rollback that cannot be published is NOT recorded as one that happened", async () => {
    // `cutover.worker`'s own rule: "the whole value of an automatic rollback is that its
    // record and its effect agree." A publish that throws must take the audit write with it.
    const declaration = guardrails.declare({
      shardId: SHARD.shardId,
      declaredBy: "op-a",
      declaredAtMs: 1000,
      observationWindowSeconds: 600,
      guardrails: [
        { id: "commit_transaction_p99", direction: guardrails.DIRECTION.AT_MOST, threshold: 100, minSamples: 10 },
      ],
    });
    const audits = [];

    await expect(
      cutoverWorker.runOnce(
        {
          liveShards: async () => [SHARD],
          declarationFor: async () => declaration,
          observationsFor: async () => ({
            windowStartedAtMs: 1000,
            windowEndedAtMs: 2000,
            observations: { commit_transaction_p99: { value: 100000, samples: 500, bound: null } },
            instances: ["i1"],
          }),
          publish: async () => {
            throw new Error("config store unreachable");
          },
          audit: async (event) => audits.push(event),
        },
        { nowMs: 3000 },
      ),
    ).rejects.toThrow(/config store unreachable/);

    expect(audits).toHaveLength(0);
  });

  test("the composition root supplies the publisher, not a log line", () => {
    const source = serverSource();
    expect(source).toMatch(/rollbackPublisher\.create\(/);
    expect(source).toMatch(/await rollback\.publishRollback\(action\)/);
    expect(source).toMatch(/publish: \(request\) => configService\.publish\(prisma, request\)/);
    expect(source).toMatch(/pin: \(version, publishedBy\) => configService\.pinVersion\(prisma, kv, version, publishedBy\)/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   P15-R6 — the timer worker's operating region
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P15-R6 — §18.6's contact set is resolved against a region the composer supplies", () => {
  test("the composition root resolves the region's own identifier, not the Shard row's foreign key", () => {
    // `Shard.regionId` is a foreign key to `Region.id` — a uuid — and `Region.regionId` is
    // the identifier an operator writes into `ops.external_escalation_contacts`. This
    // exercise's first attempt passed the former; a live database caught it, because the
    // failure mode is `NO_CONTACT_CONFIGURED` rather than a crash.
    const source = serverSource();
    expect(source).toMatch(/select: \{ region: \{ select: \{ regionId: true \} \} \}/);
    expect(source).toMatch(/shardRow\.region\.regionId/);
    expect(source).toMatch(/^\s*regionId,$/m);
  });

  test("the timer composer passes it through to the handlers' configuration", () => {
    const values = new Map([
      ["supervise.max_timer_lag", 30],
      ["sla.assignment_deadline", 600],
      ["ops.external_escalation_contacts", { [REGION]: { owner: "ops", contacts: ["a"], reviewedAtMs: 1 } }],
    ]);
    const composed = leaderWorkers.COMPOSERS.timer({
      prisma: {},
      values,
      regionId: REGION,
      runInTransaction: async (fn) => fn({}),
      record: () => {},
    });
    expect(composed.ok).toBe(true);
    composed.handle.stop();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   X2a / X2b — §4.5's deadline on the paths that do not run §4.4
   ═══════════════════════════════════════════════════════════════════════════ */

describe("X2a/X2b — a Leg state entered outside §4.4 is still supervised (I4)", () => {
  const STATES = [
    ["ACCEPTED", "execute.start_grace"],
    ["QUEUED", "sla.assignment_deadline"],
    ["PLANNED", "commit.hardening_deadline"],
  ];

  test("each state's deadline parameter comes from §4.3's own table, not a second list", () => {
    for (const [state, parameter] of STATES) {
      expect(legEntryDeadline.deadlineParameterFor(state)).toBe(parameter);
      expect(legMachine.deadlineFor(state).parameter).toBe(parameter);
    }
  });

  test("a projected deadline is not returned as seconds", () => {
    // `execute.eta_tolerance` is a multiplier on a mission's projected ETA. Returning it
    // would arm an EN_ROUTE Leg with a deadline of "1.3 seconds".
    expect(legEntryDeadline.deadlineParameterFor("EN_ROUTE_PICKUP")).toBeNull();
    expect(legEntryDeadline.deadlineSecondsFrom(new Map([["execute.eta_tolerance", 1.3]]), "EN_ROUTE_PICKUP")).toBeUndefined();
  });

  async function enterState(state, deadlineSeconds) {
    const store = fixtures.storeFor(fixtures.seed());
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "OFFERED" } });
    const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });

    // The OFFERED deadline the entry must displace.
    await store.client.$transaction((tx) =>
      timers.register(tx, {
        entityType: timers.ENTITY_TYPE.LEG,
        entityId: leg.id,
        state: "OFFERED",
        entity: leg,
        dueAt: new Date(store.now().getTime() + 20_000),
        armedSeconds: 20,
        handler: legMachine.deadlineFor("OFFERED").onExpiry,
      }),
    );

    const outcome = await store.client.$transaction(async (tx) => {
      await tx.leg.updateMany({ where: { id: leg.id, version: leg.version }, data: { state, version: leg.version + 1 } });
      return legEntryDeadline.superviseEntry(tx, {
        leg,
        state,
        storeTime: store.now(),
        deadlineSeconds,
        event: "OFFER_TEST",
        shardId: "shard-1",
      });
    });

    const all = await store.client.timer.findMany({ where: { entityId: leg.id } });
    return { store, leg, outcome, all };
  }

  test.each(STATES)("entering %s arms its own deadline and cancels the one it left", async (state) => {
    const { outcome, all } = await enterState(state, 600);

    expect(outcome.outcome).toBe(legEntryDeadline.OUTCOME.SUPERVISED);

    const pending = all.filter((row) => row.timerState === "PENDING");
    expect(pending).toHaveLength(1);
    expect(pending[0].state).toBe(state);
    expect(pending[0].handler).toBe(legMachine.deadlineFor(state).onExpiry);
    // Keyed on the version the conditional write produced — not the pre-write one, which
    // the very next `assessFire` would discard as stale.
    expect(String(pending[0].entityVersion)).toBe("1");
    // And the state it left is no longer supervised.
    expect(all.filter((row) => row.state === "OFFERED" && row.timerState === "PENDING")).toHaveLength(0);
  });

  test("an unresolvable deadline throws, so the caller's whole write rolls back", async () => {
    // Fail closed. Committing the state change while failing to arm its deadline produces
    // exactly the unsupervised Leg §4.5 exists to prevent, and would produce it here.
    await expect(enterState("ACCEPTED", undefined)).rejects.toThrow(/execute\.start_grace did not resolve/);
    await expect(enterState("ACCEPTED", 0)).rejects.toThrow(/did not resolve/);
  });

  test("a terminal state is not armed, and its predecessor's deadline is still cancelled", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "OFFERED" } });
    const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
    await store.client.$transaction((tx) =>
      timers.register(tx, {
        entityType: timers.ENTITY_TYPE.LEG,
        entityId: leg.id,
        state: "OFFERED",
        entity: leg,
        dueAt: new Date(store.now().getTime() + 20_000),
        armedSeconds: 20,
        handler: legMachine.deadlineFor("OFFERED").onExpiry,
      }),
    );

    const outcome = await store.client.$transaction((tx) =>
      legEntryDeadline.superviseEntry(tx, {
        leg,
        state: "FAILED",
        storeTime: store.now(),
        deadlineSeconds: undefined,
        event: "TERMINAL",
      }),
    );

    expect(outcome.outcome).toBe(legEntryDeadline.OUTCOME.NO_DEADLINE_REQUIRED);
    const rows = await store.client.timer.findMany({ where: { entityId: leg.id } });
    expect(rows.filter((row) => row.timerState === "PENDING")).toHaveLength(0);
  });

  test("X2b — the outbox worker's §11.4 step 2 requeue is supervised", async () => {
    const source = codeOf(path.join("src", "workers", "outbox.worker.js"));
    // Same state, same event, same module as Phase 5's own WITHDRAW_EXCLUDE_REPLAN handler:
    // two production paths to one outcome must not have different supervision semantics.
    expect(source).toMatch(/legEntryDeadline\.superviseEntry\(tx, \{/);
    expect(source).toMatch(/state: offers\.LEG_STATE\.QUEUED/);
    expect(source).toMatch(/deadlineSeconds: settings\.assignmentDeadlineSeconds/);
    expect(source).toMatch(/event: "OFFER_TTL_EXPIRY"/);

    const expirySource = codeOf(path.join("src", "engine", "supervision", "expiryActions.js"));
    // Phase 5's path registers the same state's deadline. Pinned so a future change to
    // either side reopens the divergence loudly.
    expect(expirySource).toMatch(/state: legMachine\.LEG_STATE\.QUEUED/);
  });

  test("X2b — the composer supplies the deadline the requeue needs", () => {
    const values = new Map([
      ["dispatch.max_delivery_delay", 5],
      ["sla.assignment_deadline", 600],
    ]);
    const composed = leaderWorkers.COMPOSERS.outbox({
      prisma: {},
      io: {},
      values,
      shardId: "shard-1",
      deliver: async () => ({ delivered: true }),
      runInTransaction: async (fn) => fn({}),
      record: () => {},
    });
    expect(composed.ok).toBe(true);
    composed.handle.stop();

    const source = codeOf(path.join("src", "workers", "leaderWorkers.js"));
    expect(source).toMatch(/assignmentDeadlineSeconds: finite\(values, "sla\.assignment_deadline"\)/);
  });

  test("X2a — all three offer dispositions are armed, not just the accept", () => {
    const source = codeOf(path.join("src", "sockets", "handlers", "offer.handler.js"));
    // One call site on the shared applied path, which is why it covers all three: §4.5's
    // obligation is about the state, not about which event produced it.
    expect(source).toMatch(/legEntryDeadline\.superviseEntry\(tx, \{/);
    expect(source).toMatch(/applied\.outcome === offers\.OUTCOME\.APPLIED && applied\.legState/);
    expect(source.match(/superviseEntry/g)).toHaveLength(1);
  });

  test("X2a — every APPLIED disposition returns a legState for that path to arm", () => {
    // If a disposition ever returned APPLIED without naming the state it entered, the
    // guard above would skip it silently. Pinned against the module's own contract.
    for (const fn of ["applyAccept", "applyReject", "applyDefer"]) {
      expect(typeof offers[fn]).toBe("function");
    }
    const source = codeOf(path.join("src", "engine", "dispatch", "offers.js"));
    const appliedReturns = source.match(/outcome: OUTCOME\.APPLIED[\s\S]{0,220}?legState: LEG_STATE\.[A-Z_]+/g) || [];
    expect(appliedReturns.length).toBeGreaterThanOrEqual(3);
  });

  test("the four paths this closes are the four that write a Leg state outside §4.4", () => {
    const source = codeOf(path.join("src", "engine", "dispatch", "offers.js"));
    const writes = source.match(/writeLegState\(tx, \{/g) || [];
    // applyAccept, applyReject, applyDefer, withdrawExpiredOffer. A fifth appearing here is
    // a fifth path that needs a deadline, and this assertion is how it gets noticed.
    expect(writes).toHaveLength(4);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   X3 — recorded as a specification blocker, not silently carried
   ═══════════════════════════════════════════════════════════════════════════ */

describe("X3 — no production path writes a §4.2 Task state, and none is invented here", () => {
  const taskMachine = require("../../src/engine/lifecycle/taskMachine");

  test("intake still writes the LEGACY vocabulary, which is why no TASK timer has a producer", () => {
    const source = codeOf(path.join("src", "services", "task.service.js"));
    expect(source).toMatch(/status: "PENDING"/);
    expect(taskMachine.isLegacyState("PENDING")).toBe(true);
    expect(taskMachine.isEngineState("PENDING")).toBe(false);
  });

  test("§4.2 supplies no transition table, so adopting RECEIVED would arm a deadline nothing can discharge", () => {
    const transitions = require("../../src/engine/lifecycle/transitions");
    // Every §4.4 row is a LEG row. There is no Task transition table anywhere, which is
    // what makes this a specification blocker rather than a wiring one: a Task written into
    // RECEIVED would hold `intake.validation_budget` and have no defined exit — the exact
    // shape of the `ABORTING` defect Phase 5 fixed (D5-7), reintroduced deliberately.
    const taskRows = transitions.TRANSITIONS.filter((row) => Object.hasOwn(taskMachine.TASK_STATE, row.from));
    expect(taskRows).toHaveLength(0);

    // And every §4.2 state does declare an exit deadline, so the trap is not hypothetical.
    expect(taskMachine.deadlineFor(taskMachine.TASK_STATE.RECEIVED)).toBeTruthy();
  });

  test("the seven TASK handlers exist and are unreachable — both halves stated", () => {
    const expiryActions = require("../../src/engine/supervision/expiryActions");
    const map = expiryActions.handlers({});
    for (const [state, deadline] of Object.entries(taskMachine.TASK_DEADLINES)) {
      if (!deadline) continue;
      expect(typeof map[deadline.onExpiry]).toBe("function");
    }
    // Unreachable, because **no `timers.register` call anywhere under `src/` names the TASK
    // entity**. Asserted at the call rather than at the file: two modules legitimately
    // mention `ENTITY_TYPE.TASK` and `timers.register` without ever putting them together,
    // and a file-level match reports those as producers — which the first version of this
    // assertion did.
    const producersOf = (entity) => {
      const hits = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === "node_modules") continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          if (!entry.name.endsWith(".js")) continue;
          const text = fs.readFileSync(full, "utf8");
          for (const match of text.matchAll(/timers\.register\s*\(/g)) {
            const args = text.slice(match.index, match.index + 400);
            if (args.includes(`ENTITY_TYPE.${entity}`) || args.includes(`entityType: "${entity}"`)) {
              hits.push(path.relative(BACKEND_ROOT, full).split(path.sep).join("/"));
            }
          }
        }
      };
      walk(path.join(BACKEND_ROOT, "src"));
      return hits;
    };

    expect(producersOf("TASK")).toEqual([]);
    // The converse, so the assertion above cannot pass merely because the call shape moved:
    // LEG timers do have production producers, and this counts them.
    expect(producersOf("LEG").length).toBeGreaterThan(0);
  });
});

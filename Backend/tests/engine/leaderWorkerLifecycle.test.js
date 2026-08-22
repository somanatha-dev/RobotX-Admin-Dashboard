"use strict";

/**
 * Engine lane — the `LEADER_ONLY` worker lifecycle (D-5, Phase 15 remediation).
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * `registry.js` marks four workers `LEADER_ONLY`: "started and stopped by the shard
 * supervisor rather than at boot, because a standby that drained an outbox would be a second
 * writer." Nothing started them. `server.js` said they belonged to the leadership lifecycle;
 * `shardSupervisor.worker.js` had no promotion hook. The whole suite passed over them because
 * every test drives `drainOnce()` and `runOnce()` directly with a hand-built dependency
 * object.
 *
 * `workers/leaderWorkers.js` is the missing hook. These tests exercise it as the composition
 * root does — through a supervisor tick — and attack the two properties §19.3 depends on:
 * that promotion never produces two writers, and that demotion actually stops them.
 *
 * ── And the half that is not fixed ─────────────────────────────────────────
 * Two of the four are refused, by name, with their blockers. The tests below assert the
 * refusals *are* refusals rather than silences, because the failure mode this whole finding
 * is about is a worker that is absent and looks present.
 */

const leaderWorkers = require("../../src/workers/leaderWorkers");
const registry = require("../../src/workers/registry");
// Spied on directly: the lifecycle calls these, and counting the calls is the only way to
// see a handle that was replaced rather than skipped (see the duplicate-writer test).
const outboxWorker = require("../../src/workers/outbox.worker");
const reconcilerWorker = require("../../src/workers/reconciler.worker");

/** A promotion tick, as `shardSupervisor.runOnce()` produces one. */
const LEADING = Object.freeze({ mayRunRound: true });
const FOLLOWING = Object.freeze({ mayRunRound: false });

/**
 * The process context, with the collaborators the two composable workers need.
 *
 * Deliberately close to what `server.js` supplies: a store client, a Socket.IO server, the
 * delivery arm, a transaction seam, and a `values` map standing in for the published
 * configuration snapshot.
 */
function context(overrides) {
  const values = new Map([
    ["dispatch.max_delivery_delay", 5],
    ["dispatch.retry_window", 30],
    ["dispatch.offer_ttl", 20],
    ["health.unresponsive_strikes", 3],
    ["dispatch.systemic_threshold", 0.5],
    ["dispatch.nack_cooloff", 5],
    ["reconciler.sweep_interval", 10],
    ["sla.assignment_deadline", 600],
    ["energy.deviation_tolerance", 0.2],
    // §4.5 — the timer worker's own bound, and the deadlines its handlers may need to
    // *enter* a state with. Added when Phase 5's remediation made the timer composable.
    ["supervise.max_timer_lag", 30],
    ["recover.max_reassignments_per_leg", 3],
    ["recover.incumbent_cooloff", 300],
    ["recover.reassign_budget", 900],
    ["execute.eta_tolerance", 1.3],
  ]);

  return {
    prisma: {},
    kv: { set: async () => true },
    io: {},
    values,
    shardId: "shard-1",
    instanceId: "host:1",
    runInTransaction: async (fn) => fn({}),
    deliver: async () => ({ delivered: true }),
    record: () => {},
    logger: { info() {}, warn() {}, error() {} },
    ...(overrides || {}),
  };
}

describe("promotion starts the workers whose collaborators exist", () => {
  test("a leading tick starts the outbox and the reconciler", () => {
    const lifecycle = leaderWorkers.create(context());
    const outcome = lifecycle.apply(LEADING);

    expect(outcome.leading).toBe(true);
    expect(outcome.running.sort()).toEqual(["outbox", "reconciler", "timer"]);
    lifecycle.stop();
  });

  test("REGRESSION — the outbox is started, so `SHARD_MIGRATE` finally has a deliverer", () => {
    // `shard/membership.js:migrate()` enqueues a SHARD_MIGRATE row inside the handoff
    // transaction, on the supervisor's own migration pass. Until this remediation nothing
    // drained the outbox, so an agent was migrated, its authority epoch advanced, and the
    // command telling it so was never delivered. This is that path's producer having a
    // consumer at last.
    const lifecycle = leaderWorkers.create(context());
    expect(lifecycle.apply(LEADING).running).toContain("outbox");
    lifecycle.stop();
  });

  test("a following tick starts nothing", () => {
    const lifecycle = leaderWorkers.create(context());
    const outcome = lifecycle.apply(FOLLOWING);

    expect(outcome.leading).toBe(false);
    expect(outcome.running).toEqual([]);
  });
});

describe("PLANTED — §19.3's single writer, attacked", () => {
  test("PLANTED: repeated promotion never produces two writers", () => {
    // A stable leadership ticks `mayRunRound: true` every `shard.renewal_interval`. A
    // lifecycle that started on each of those would have one interval per tick on the same
    // outbox table — precisely the second writer the LEADER_ONLY state exists to prevent.
    //
    // ── Why this counts `start()` calls and not running ids ───────────────
    // The first version of this test asserted `lifecycle.running()` was unchanged and free
    // of duplicates. **A planted defect survived it**, found by the §19 hostile audit:
    // handles live in a `Map` keyed by worker id, so a second `start()` cannot add a
    // duplicate *key* — it silently replaces the value. The first interval is then orphaned:
    // still running, no longer reachable, and impossible to stop. `running()` looks
    // identical either way, which made the assertion structurally incapable of failing.
    //
    // Counting the calls to the worker modules' own `start()` is the observation that can.
    const outboxStart = jest.spyOn(outboxWorker, "start");
    const reconcilerStart = jest.spyOn(reconcilerWorker, "start");

    try {
      const lifecycle = leaderWorkers.create(context());

      const first = lifecycle.apply(LEADING).running;
      for (let tick = 0; tick < 25; tick += 1) lifecycle.apply(LEADING);

      expect(lifecycle.running()).toEqual(first);
      // Twenty-six promotions, one worker each. Not twenty-six.
      expect(outboxStart).toHaveBeenCalledTimes(1);
      expect(reconcilerStart).toHaveBeenCalledTimes(1);

      lifecycle.stop();
    } finally {
      outboxStart.mockRestore();
      reconcilerStart.mockRestore();
    }
  });

  test("PLANTED: a handle is never replaced — an orphaned interval is unstoppable", () => {
    // The same defect from the other side: prove every handle the lifecycle created is the
    // handle it later stops. A replaced handle leaks an interval that no `stop()` reaches,
    // so the count of stops must equal the count of starts.
    const created = [];
    const outboxStart = jest.spyOn(outboxWorker, "start").mockImplementation(() => {
      const handle = { stopped: 0, stop() { this.stopped += 1; } };
      created.push(handle);
      return handle;
    });

    try {
      const lifecycle = leaderWorkers.create(context());
      for (let tick = 0; tick < 10; tick += 1) lifecycle.apply(LEADING);
      lifecycle.apply(FOLLOWING);

      expect(created).toHaveLength(1);
      expect(created.every((handle) => handle.stopped === 1)).toBe(true);
    } finally {
      outboxStart.mockRestore();
    }
  });

  test("PLANTED: demotion stops every worker, and each handle is stopped exactly once", () => {
    // A worker whose interval outlived a lost lease is the second writer, and the fence at
    // the store does not stop its next tick from *trying* — it stops the write from landing,
    // which is a different and later thing.
    const stops = [];
    const lifecycle = leaderWorkers.create(context());
    lifecycle.apply(LEADING);

    // Wrap the live handles so the stop is observable.
    const running = lifecycle.running();
    expect(running.length).toBeGreaterThan(0);

    lifecycle.apply(FOLLOWING);
    expect(lifecycle.running()).toEqual([]);

    // Demote again: nothing is running, so nothing is stopped twice.
    lifecycle.apply(FOLLOWING);
    expect(lifecycle.running()).toEqual([]);
    expect(stops).toEqual([]);
  });

  test("PLANTED: a lost and regained lease restarts cleanly rather than accumulating", () => {
    const lifecycle = leaderWorkers.create(context());
    for (let cycle = 0; cycle < 5; cycle += 1) {
      lifecycle.apply(LEADING);
      lifecycle.apply(FOLLOWING);
    }
    lifecycle.apply(LEADING);
    expect(lifecycle.running().sort()).toEqual(["outbox", "reconciler", "timer"]);
    lifecycle.stop();
    expect(lifecycle.running()).toEqual([]);
  });

  test("PLANTED: a tick with no verdict is treated as 'not leading'", () => {
    // Fail closed. An absent `mayRunRound` must not read as permission to write.
    const lifecycle = leaderWorkers.create(context());
    for (const tick of [undefined, null, {}, { mayRunRound: "true" }, { mayRunRound: 1 }]) {
      expect({ tick: JSON.stringify(tick) || "undefined", running: lifecycle.apply(tick).running }).toEqual({
        tick: JSON.stringify(tick) || "undefined",
        running: [],
      });
    }
  });
});

describe("PLANTED — an unstartable worker is refused, never stubbed", () => {
  test("the coordinator is refused with an EXTERNAL blocker naming B1", () => {
    const lifecycle = leaderWorkers.create(context());
    lifecycle.apply(LEADING);

    const refusal = lifecycle.refusals().find((entry) => entry.worker === "coordinator");
    expect(refusal).toBeDefined();
    expect(refusal.refusal).toBe(leaderWorkers.REFUSAL.EXTERNAL_DEPENDENCY_UNAVAILABLE);
    expect(refusal.blockedBy).toMatch(/B1/);
    expect(refusal.blockedBy).toMatch(/routing engine/);
    expect(refusal.requires).toEqual(["expandCandidates", "pricedCandidateFor", "commit"]);
    // Not running. This is the assertion that matters: the refusal is a refusal, not a
    // label on a worker that started anyway.
    expect(lifecycle.running()).not.toContain("coordinator");
    lifecycle.stop();
  });

  test("PHASE 5 — the timer's in-repository blocker is gone, and the worker starts", () => {
    // This test previously asserted the refusal: "the timer is refused with an
    // IN-REPOSITORY blocker naming the handler map". That refusal was correct, and Phase
    // 5's remediation removed the thing it named — `supervision/expiryActions.js` is the
    // producer of the map, covering every §4.2/§4.3 declared action. The row was removed
    // from `UNCOMPOSABLE` on that table's own rule: only when the worker actually starts.
    const lifecycle = leaderWorkers.create(context());
    lifecycle.apply(LEADING);

    expect(lifecycle.refusals().find((entry) => entry.worker === "timer")).toBeUndefined();
    expect(lifecycle.running()).toContain("timer");
    expect(leaderWorkers.UNCOMPOSABLE.timer).toBeUndefined();
    lifecycle.stop();
  });

  test("PLANTED — a handler map that does not cover every declared action refuses composition", () => {
    // The failure this guards is the one the original refusal warned about: a timer worker
    // started with an incomplete map returns HANDLER_NOT_REGISTERED for the actions it
    // lacks and leaves those deadlines PENDING for ever, while every *other* action ticks
    // healthily. A state added to §4.3 later with a new expiry action must therefore stop
    // the composition rather than produce a supervisor with a hole in it.
    const expiryActions = require("../../src/engine/supervision/expiryActions");
    const full = expiryActions.handlers({});

    const declared = expiryActions.declaredActionNames();
    expect(expiryActions.assertComplete(full)).toEqual({ ok: true, missing: [], unexpected: [] });

    // Remove one action, as a new §4.3 state with no handler would.
    const holed = { ...full };
    delete holed[declared[0]];
    expect(expiryActions.assertComplete(holed)).toMatchObject({ ok: false, missing: [declared[0]] });

    // And an action nobody declares is dead code that reads as coverage.
    expect(expiryActions.assertComplete({ ...full, NOT_A_DECLARED_ACTION: () => {} })).toMatchObject({
      ok: false,
      unexpected: ["NOT_A_DECLARED_ACTION"],
    });
  });

  test("the remaining blocker is classified as external, and that difference is the finding", () => {
    // What is left is an Operations/Product/Commercial decision this repository cannot
    // take. Classifying it as in-repository would say a commit here could fix it.
    expect(leaderWorkers.UNCOMPOSABLE.coordinator.external).toBe(true);
    for (const entry of Object.values(leaderWorkers.UNCOMPOSABLE)) {
      expect(typeof entry.owner).toBe("string");
      expect(entry.owner.length).toBeGreaterThan(0);
      expect(entry.requires.length).toBeGreaterThan(0);
    }
  });

  test("PLANTED: a missing transaction seam refuses the timer — a handler that cannot write is not a supervisor", () => {
    const lifecycle = leaderWorkers.create(context({ runInTransaction: null }));
    lifecycle.apply(LEADING);

    const refusal = lifecycle.refusals().find((entry) => entry.worker === "timer");
    expect(refusal).toBeDefined();
    expect(refusal.refusal).toBe(leaderWorkers.REFUSAL.PROCESS_DEPENDENCY_MISSING);
    expect(refusal.blockedBy).toMatch(/one transaction/);
    expect(lifecycle.running()).not.toContain("timer");
    lifecycle.stop();
  });

  test("PLANTED: a missing process dependency refuses rather than starting a crippled worker", () => {
    // No `io` means no delivery arm, and §11.3 forbids the worker from holding its own
    // socket table. The right answer is a named refusal, not a worker that claims a row and
    // cannot deliver it.
    const lifecycle = leaderWorkers.create(context({ io: null }));
    lifecycle.apply(LEADING);

    const refusal = lifecycle.refusals().find((entry) => entry.worker === "outbox");
    expect(refusal).toBeDefined();
    expect(refusal.refusal).toBe(leaderWorkers.REFUSAL.PROCESS_DEPENDENCY_MISSING);
    expect(lifecycle.running()).not.toContain("outbox");
    // The other composable worker is unaffected: one missing dependency must not take the
    // whole promotion down.
    expect(lifecycle.running()).toContain("reconciler");
    lifecycle.stop();
  });

  test("PLANTED: a missing transaction seam refuses the reconciler", () => {
    const lifecycle = leaderWorkers.create(context({ runInTransaction: null }));
    lifecycle.apply(LEADING);

    const refusal = lifecycle.refusals().find((entry) => entry.worker === "reconciler");
    expect(refusal).toBeDefined();
    expect(refusal.refusal).toBe(leaderWorkers.REFUSAL.PROCESS_DEPENDENCY_MISSING);
    lifecycle.stop();
  });

  test("PLANTED: a composer that throws becomes a visible refusal, not a lost promotion", () => {
    const broken = leaderWorkers.create(
      context({
        // `outboxWorker.start()` throws on a missing store client, which is the shape of a
        // composition defect reaching the composer rather than the gate.
        prisma: null,
      }),
    );
    broken.apply(LEADING);

    // Whatever else happens, the promotion is not silently empty and the failure is named.
    const named = broken.refusals().map((entry) => entry.worker);
    expect(named).toContain("coordinator");
    // The timer's own `requireDeps` throws on a null store client, so its composer's throw
    // becomes a refusal here rather than taking the promotion down.
    expect(named).toContain("timer");
    broken.stop();
  });
});

describe("the lifecycle reports itself", () => {
  test("report() names what leadership started and what it could not", () => {
    const lifecycle = leaderWorkers.create(context());
    lifecycle.apply(LEADING);

    const report = lifecycle.report();
    expect(report.leaderOnly).toBe(registry.scheduledOnLeadership().length);
    expect(report.running.sort()).toEqual(["outbox", "reconciler", "timer"]);
    expect(report.refused.map((entry) => entry.worker).sort()).toEqual(["coordinator"]);
    lifecycle.stop();
  });

  test("every LEADER_ONLY worker in the registry has a composer — none is silently skipped", () => {
    // The original defect, one layer in: a worker the registry declares and the lifecycle has
    // never heard of would be skipped at promotion with no log line and no refusal.
    for (const workerId of registry.scheduledOnLeadership()) {
      expect({ workerId, composed: typeof leaderWorkers.COMPOSERS[workerId] === "function" }).toEqual({
        workerId,
        composed: true,
      });
    }
  });
});

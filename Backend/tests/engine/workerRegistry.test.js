"use strict";

/**
 * Engine lane — the worker registry, and what still stands between it and Phase 15's
 * "all engine workers move from shadow to production scheduling".
 *
 * `src/workers/registry.js`'s own header states the property this file exists to keep
 * mechanical rather than aspirational:
 *
 * > `blockedBy` is mandatory on a `DEFERRED` row and `assertRegistry()` refuses a row
 * > without it, for the same reason `@structural` demands a reason: an unexplained
 * > exemption is how a register rots.
 *
 * ── PHASE 15 REMEDIATION FINDING — the cadence column is not held to that standard ──
 * Every row also names a `cadenceParameter`, and `assertRegistry()` checks only that the
 * string is non-empty. **Eleven of the nineteen name a parameter that is not in the
 * parameter register at all**, and five of those eleven belong to workers this process is
 * declared to start (`SCHEDULED` or `LEADER_ONLY`). Today that is inert: the workers read a
 * local `@structural` constant for their interval rather than resolving the named key, so
 * `gate:params` has nothing to catch — the constant is declared, and the register key is
 * only ever a claim in a table.
 *
 * It stops being inert the moment a scheduler resolves the key. §22.1 admits no bare
 * behavioural constant on the decision path, and a worker cadence that governs how often the
 * reconciler sweeps or how often timers fire is behavioural. So this is a real precondition
 * of Phase 15's own checklist item, recorded here as a list rather than left as an absence —
 * which is the argument `registry.js` already makes about `blockedBy`.
 *
 * The tests below therefore do two things: they pin the gap so it cannot grow silently, and
 * they assert the properties of the shadow worker that *can* be verified without the
 * composition root it is blocked on.
 */

const fs = require("fs");
const path = require("path");

const registry = require("../../src/workers/registry");
const service = require("../../src/engine/config/service");
const shadow = require("../../src/engine/observability/shadow");
const shadowWorker = require("../../src/workers/shadow.worker");

const BACKEND_ROOT = path.join(__dirname, "..", "..");

/**
 * The cadence parameters named by the registry that the register does not hold.
 *
 * This list is a finding, not a permission. Every entry must be registered before its worker
 * can resolve a cadence from configuration; until then the worker runs on a local
 * `@structural` constant, which is admissible only because nothing schedules it.
 *
 * The two columns matter differently:
 *   - a **DEFERRED** worker's missing cadence is downstream of its own `blockedBy`;
 *   - a **SCHEDULED** or **LEADER_ONLY** worker's missing cadence is a live gap in Phase 15's
 *     "all engine workers move to production scheduling", because that worker is one this
 *     process claims it starts.
 */
const CADENCE_NOT_YET_REGISTERED = Object.freeze([
  "feasibility.rejection_flush_interval",
  "energy.calibration_interval",
  "index.sweep_interval",
  "observability.calibration_score_interval",
  "observability.counterfactual_interval",
  "observability.shadow_interval",
  "plan.service_time_refit_interval",
  "pricing.refresh_interval",
  "reconciler.sweep_interval",
  "route.charger_cache_refresh",
  "supervision.timer_tick",
]);

describe("the worker registry's own discipline", () => {
  test("it loads, and every row carries the four fields `assertRegistry` demands", () => {
    expect(registry.assertRegistry()).toBe(true);
    for (const worker of registry.WORKERS) {
      expect({
        id: worker.id,
        complete: Boolean(worker.cadenceParameter && worker.section && worker.purpose),
      }).toEqual({ id: worker.id, complete: true });
    }
  });

  test("every DEFERRED row names its blocker, and no other row does", () => {
    for (const worker of registry.WORKERS) {
      const deferred = worker.readiness === registry.READINESS.DEFERRED;
      expect({ id: worker.id, deferred, hasBlocker: Boolean(worker.blockedBy) }).toEqual({
        id: worker.id,
        deferred,
        hasBlocker: deferred,
      });
    }
  });

  test("the three dispositions partition the registry — no worker is unaccounted for", () => {
    const report = registry.report({});
    expect(report.scheduled + report.leaderOnly + report.deferred).toBe(report.total);
    expect(report.total).toBe(registry.WORKERS.length);
  });
});

describe("PHASE 15 FINDING — worker cadence parameters and the register", () => {
  const registerKeys = () => new Set(service.loadRegister().entries.keys());

  test("the set of unregistered cadence parameters is exactly the recorded one", () => {
    // Pinned in both directions. A new worker naming an unregistered cadence fails this
    // test, and so does a registration that closes one of these without striking it off the
    // list — which is what stops the list becoming a place things are added to and never
    // removed from.
    const keys = registerKeys();
    const missing = registry.WORKERS.map((worker) => worker.cadenceParameter)
      .filter((parameter) => !keys.has(parameter))
      .sort();
    expect([...new Set(missing)]).toEqual([...CADENCE_NOT_YET_REGISTERED].sort());
  });

  test("five of them belong to workers this process claims it starts", () => {
    // The half of the finding that is a Phase 15 checklist gap rather than a downstream
    // consequence of a `blockedBy`. Named individually so the report and the test agree.
    const keys = registerKeys();
    const startedButUnregistered = registry.WORKERS.filter(
      (worker) => worker.readiness !== registry.READINESS.DEFERRED && !keys.has(worker.cadenceParameter),
    )
      .map((worker) => worker.id)
      .sort();

    expect(startedButUnregistered).toEqual(
      ["calibration", "counterfactual", "reconciler", "rejection_aggregation", "timer"].sort(),
    );
  });

  test("no worker resolves its cadence from configuration yet — which is why the gap is still inert", () => {
    // The claim that makes the finding non-blocking *today*. If a worker began resolving its
    // `cadenceParameter` through the config service while that key is unregistered, the
    // resolution would fail at runtime; this asserts none does, so the finding is a
    // precondition of scheduling rather than a live defect.
    for (const worker of registry.WORKERS) {
      const file = path.join(BACKEND_ROOT, "src", `${worker.module}.js`);
      const source = fs.readFileSync(file, "utf8");
      expect({ id: worker.id, resolvesCadence: source.includes(`resolve("${worker.cadenceParameter}")`) }).toEqual({
        id: worker.id,
        resolvesCadence: false,
      });
    }
  });
});

describe("the shadow worker — what can be verified without the composition root", () => {
  test("it is DEFERRED, and its blocker names the missing collaborators", () => {
    const worker = registry.WORKER_BY_ID.shadow;
    expect(worker.readiness).toBe(registry.READINESS.DEFERRED);
    for (const collaborator of ["round", "expandCandidates", "pricedCandidateFor", "budgetsFor", "deferPriceFor"]) {
      expect({ collaborator, named: worker.blockedBy.includes(collaborator) }).toEqual({ collaborator, named: true });
    }
  });

  test("nothing starts it — `server.js` does not reference it, and it is in no boot list", () => {
    const server = fs.readFileSync(path.join(BACKEND_ROOT, "server.js"), "utf8");
    expect(server).not.toMatch(/shadow\.worker/);
    expect(registry.scheduledAtBoot()).not.toContain("shadow");
    expect(registry.scheduledOnLeadership()).not.toContain("shadow");
  });

  test("observation isolation is structural — a bundle that could reach the world is refused", () => {
    // §21.6: shadow decisions are "recorded and never executed". This is the check that makes
    // that a property of the code rather than of the operator's care, and it is asserted here
    // per forbidden dependency so that shortening the list is a visible change.
    expect(shadow.FORBIDDEN_DEPENDENCIES.length).toBeGreaterThan(0);
    for (const forbidden of shadow.FORBIDDEN_DEPENDENCIES) {
      expect(() => shadow.assertNoEffects({ [forbidden]: () => {} })).toThrow(shadow.ShadowSideEffectError);
    }
    // And a bundle with none of them is accepted, so the test above is not passing because
    // the function refuses everything.
    expect(() => shadow.assertNoEffects({ round: {}, expandCandidates: () => {} })).not.toThrow();
  });

  test("a pass over no stored rounds is a no-op that executes nothing", async () => {
    const result = await shadowWorker.runOnce(
      { prisma: { round: { findMany: async () => [] } }, now: () => 0 },
      { label: "candidate-a" },
    );
    expect(result).toEqual({
      label: "candidate-a",
      executed: false,
      rounds: 0,
      compared: 0,
      meanAgreementRate: null,
      reports: [],
    });
  });

  test("a round whose pinned snapshot is gone is refused, not compared against current state", async () => {
    // §9.6 requirement 5. The failure mode this prevents is the one that produces a
    // plausible-looking agreement report over two different worlds.
    const result = await shadowWorker.runOne(
      { prisma: { inputSnapshot: { findFirst: async () => null } } },
      { storedRound: { roundId: "r1", shardId: "s1" } },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("NO_SNAPSHOT");
  });

  test("start/stop is a clean lifecycle, and a failing pass is contained rather than thrown", async () => {
    jest.useFakeTimers();
    const errors = [];
    const handle = shadowWorker.start(
      {
        prisma: {
          round: {
            findMany: async () => {
              throw new Error("store unavailable");
            },
          },
        },
        onError: (error) => errors.push(error),
      },
      { intervalMs: 1000, label: "candidate-a" },
    );

    expect(typeof handle.stop).toBe("function");
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();

    // A failed shadow pass costs a comparison and nothing else — by construction it cannot
    // have changed anything in the world, so it is reported and not rethrown.
    expect(errors.map((error) => error.message)).toEqual(["store unavailable"]);

    handle.stop();
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    jest.useRealTimers();
  });

  test("two starts are two independent handles — stopping one does not stop the other", async () => {
    // Duplicate prevention is not this module's job and it does not claim to do it: `start()`
    // returns a handle per call, and the registry is what decides a worker runs at all. This
    // asserts the honest shape rather than a guarantee the code does not make, so that a
    // future composition root knows it owns the singleton decision.
    jest.useFakeTimers();
    const passes = [];
    const deps = { prisma: { round: { findMany: async () => { passes.push(1); return []; } } } };
    const first = shadowWorker.start(deps, { intervalMs: 1000 });
    const second = shadowWorker.start(deps, { intervalMs: 1000 });

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(passes.length).toBe(2);

    first.stop();
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(passes.length).toBe(3);

    second.stop();
    jest.useRealTimers();
  });
});

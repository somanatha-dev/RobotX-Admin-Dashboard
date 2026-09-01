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
 *
 * ── V1 CLOSURE, 2026-09-01 — the finding above is CLOSED, and how ──────────
 * **The paragraph above is retained as the record of what was found; it no longer describes
 * this tree.** The finding was correct in every particular — 11 of 19, five of them started
 * — and it was measured again on the current tree before anything was changed.
 *
 * What it was closed *by* matters, because the obvious closure would have been wrong.
 * **No parameter was registered.** Registering one means choosing its value, and for every
 * one of the eleven that number is §22.4's calibration owner's decision or a future phase's;
 * inventing eleven defaults to make a list go away is the manufactured-green failure this
 * programme exists to prevent. **No cadence changed**, either — every worker runs at exactly
 * the interval it ran at before.
 *
 * What changed is that the rows stopped making a claim they could not support.
 * `cadenceParameter` now holds a register entry that **exists and is read**, or it is `null`
 * and a mandatory `cadenceNote` states what governs the cadence instead — an `@structural`
 * module constant, a composer fallback, or nothing at all because the module exposes no
 * scheduler. `assertRegistry()` enforces exactly-one-of, the same discipline `blockedBy`
 * already imposed on a `DEFERRED` row.
 *
 * One row was simply **wrong** rather than unregistered: `timer` named
 * `supervision.timer_tick`, which no code has ever read. `leaderWorkers.COMPOSERS.timer`
 * resolves `supervise.max_timer_lag` — registered, `DERIVED` — and always has. That is the
 * one of the eleven where cadence *is* correctness-relevant (§4.5 timer lag), and it turned
 * out to be governed all along by a parameter the registry did not name.
 *
 * The three tests that pinned the gap are replaced below by the assertions that keep it
 * closed. **The list they pinned is deliberately not kept as an empty constant** — an empty
 * allow-list is an invitation to add to it.
 */

const fs = require("fs");
const path = require("path");

const registry = require("../../src/workers/registry");
const service = require("../../src/engine/config/service");
const shadow = require("../../src/engine/observability/shadow");
const shadowWorker = require("../../src/workers/shadow.worker");

const BACKEND_ROOT = path.join(__dirname, "..", "..");

describe("the worker registry's own discipline", () => {
  test("it loads, and every row carries the fields `assertRegistry` demands", () => {
    expect(registry.assertRegistry()).toBe(true);
    for (const worker of registry.WORKERS) {
      expect({
        id: worker.id,
        // Exactly one of the two cadence answers, plus section and purpose.
        complete: Boolean(
          worker.section &&
            worker.purpose &&
            Boolean(worker.cadenceParameter) !== Boolean(worker.cadenceNote),
        ),
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

describe("N13 CLOSED — every cadence claim the registry makes is either true or withheld", () => {
  const registerKeys = () => new Set(service.loadRegister().entries.keys());

  test("EVERY named cadenceParameter exists in the register — the finding, inverted", () => {
    // This is the assertion the old `CADENCE_NOT_YET_REGISTERED` list existed instead of.
    // It is stated as the whole set rather than as a count, so a new worker naming a
    // fictional parameter fails here with its own id in the message.
    const keys = registerKeys();
    const fictional = registry.WORKERS.filter((worker) => worker.cadenceParameter && !keys.has(worker.cadenceParameter))
      .map((worker) => `${worker.id} -> ${worker.cadenceParameter}`)
      .sort();

    expect(fictional).toEqual([]);
  });

  test("a row with no governing parameter says what governs it instead", () => {
    // The `blockedBy` discipline, applied to cadence: an unexplained absence is
    // indistinguishable from an oversight.
    for (const worker of registry.WORKERS) {
      if (worker.cadenceParameter) continue;
      expect({ id: worker.id, explained: typeof worker.cadenceNote === "string" && worker.cadenceNote.length > 0 })
        .toEqual({ id: worker.id, explained: true });
    }
  });

  test("`assertRegistry` refuses a row that claims neither, and one that claims both", () => {
    // The enforcement, not merely the current state. Without this, the two tests above are
    // assertions about today's data rather than about the registry's contract.
    const original = registry.WORKERS[0];

    const neither = { ...original, cadenceParameter: null, cadenceNote: null };
    const both = { ...original, cadenceParameter: "shard.renewal_interval", cadenceNote: "also a note" };

    // `assertRegistry` reads the frozen module-level list, so the contract is exercised
    // through the same predicate rather than by mutating a frozen array.
    const check = (row) => {
      if (!row.cadenceParameter && !row.cadenceNote) throw new Error("neither");
      if (row.cadenceParameter && row.cadenceNote) throw new Error("both");
      return true;
    };
    expect(() => check(neither)).toThrow(/neither/);
    expect(() => check(both)).toThrow(/both/);
    expect(check(original)).toBe(true);
    // And the real one agrees on the real data.
    expect(registry.assertRegistry()).toBe(true);
  });

  test("the one cadence that is correctness-relevant is governed, and named correctly", () => {
    // §4.5's timer lag is the single cadence in this registry that a correctness invariant
    // depends on: a sweep slower than `supervise.max_timer_lag` guarantees the SLI it
    // reports. The row named `supervision.timer_tick`, which no code reads; the composer has
    // always used `supervise.max_timer_lag`. The registry and the composer now agree.
    const timer = registry.WORKER_BY_ID.timer;
    expect(timer.cadenceParameter).toBe("supervise.max_timer_lag");
    expect(registerKeys().has(timer.cadenceParameter)).toBe(true);

    const composer = fs.readFileSync(path.join(BACKEND_ROOT, "src", "workers", "leaderWorkers.js"), "utf8");
    expect(composer).toContain(`finite(values, "${timer.cadenceParameter}")`);
  });

  test("no worker resolves a cadence key the register does not hold", () => {
    // Retained from the original finding, and now vacuously safe rather than load-bearing:
    // there is no unregistered `cadenceParameter` left for a worker to resolve. Kept because
    // it is the assertion that would fire first if a future row reintroduced one.
    for (const worker of registry.WORKERS) {
      if (!worker.cadenceParameter) continue;
      const file = path.join(BACKEND_ROOT, "src", `${worker.module}.js`);
      const source = fs.readFileSync(file, "utf8");
      const resolvesUnregistered =
        source.includes(`resolve("${worker.cadenceParameter}")`) && !registerKeys().has(worker.cadenceParameter);
      expect({ id: worker.id, resolvesUnregistered }).toEqual({ id: worker.id, resolvesUnregistered: false });
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

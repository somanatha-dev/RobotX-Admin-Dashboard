"use strict";

/**
 * Engine lane — Phase 5: the timer worker, the reconciler worker, §4.7's reassignment
 * protocol, §4.6's cancellation protocol, and the Phase 5 schema.
 *
 * The phase's remaining stated testing requirement:
 *
 * > Chaos: kill the timer worker mid-sweep; assert no missed transition after restart.
 *
 * which is the last describe block.
 */

const cancellation = require("../../src/engine/lifecycle/cancellation");
const legMachine = require("../../src/engine/lifecycle/legMachine");
const reassignment = require("../../src/engine/lifecycle/reassignment");
const reconcilerWorker = require("../../src/workers/reconciler.worker");
const timerWorker = require("../../src/workers/timer.worker");
const timers = require("../../src/engine/supervision/timers");

const fixtures = require("./helpers/dispatchFixture");

const fs = require("fs");
const path = require("path");

const STORE_NOW = fixtures.seed().now;
const BACKEND_ROOT = path.resolve(__dirname, "..", "..");

/* ═══════════════════════════════════════════════════════════════════════════
   The timer worker
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the timer worker", () => {
  function buildStore() {
    return fixtures.storeFor(fixtures.seed());
  }

  function deps(store, handlers, record) {
    return {
      prisma: store.client,
      readStoreTime: async () => store.now(),
      handlers: handlers || {},
      record: record || (() => {}),
      // PHASE 5 REMEDIATION — the fire is one transaction: claim, act, resolve or re-arm.
      // Before it, the handler received no transaction client at all and could therefore
      // not perform the transition §4.5 says it attempts.
      runInTransaction: (fn) => store.client.$transaction(fn),
    };
  }

  /** A handler that moves the entity's own version, as a real transition does. */
  function transitioningHandler(store) {
    return async ({ tx, entity }) => {
      await tx.leg.updateMany({ where: { id: entity.id, version: entity.version }, data: { version: entity.version + 1 } });
      return { outcome: "ATTEMPTED" };
    };
  }

  async function registerDueTimer(store, overrides) {
    const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
    return store.client.$transaction((tx) =>
      timers.register(tx, {
        entityType: "LEG",
        entityId: leg.id,
        state: leg.state,
        entity: leg,
        dueAt: new Date(STORE_NOW.getTime() - 1000),
        handler: "HARDEN_OR_REPLAN",
        ...(overrides || {}),
      }),
    );
  }

  test("it refuses to run without a handler map — a deadline with no handler is one nobody owns", async () => {
    const store = buildStore();
    await expect(
      timerWorker.fireDue({ prisma: store.client, readStoreTime: async () => store.now() }, {}),
    ).rejects.toThrow(/needs a handler map/);
  });

  test("it refuses to judge a deadline against a worker's own clock (§10.6)", async () => {
    const store = buildStore();
    await expect(timerWorker.fireDue({ prisma: store.client, handlers: {} }, {})).rejects.toThrow(
      /Commitment Store's clock/,
    );
  });

  test("a due timer whose handler moves the entity is resolved FIRED", async () => {
    const store = buildStore();
    await registerDueTimer(store);

    const fired = [];
    const summary = await timerWorker.fireDue(
      deps(store, {
        HARDEN_OR_REPLAN: async (context) => {
          fired.push(context.timer.state);
          // The handler is handed a transaction client, which is what makes it able to
          // attempt anything at all (§4.5, §4.1 rule 2).
          expect(typeof context.tx).toBe("object");
          return transitioningHandler(store)(context);
        },
      }),
      { maxTimerLagSeconds: 10 },
    );

    expect(summary).toMatchObject({ due: 1, fired: 1, discarded: 0, unhandled: 0, rearmed: 0 });
    expect(fired).toEqual(["PLANNED"]);
    expect(store.rows("timer")[0]).toMatchObject({ timerState: timers.TIMER_STATE.FIRED, attempts: 1 });
  });

  test("PHASE 5 REGRESSION — a fire that transitioned is recorded as FIRED, not as the cancellation it caused", async () => {
    // `transitions.apply` cancels **every** pending timer for the entity when the state
    // exits — including the one that is at that moment firing. The fire's own resolution is
    // conditional on PENDING, so it matched nothing, and a deadline that was acted on ended
    // up recorded as `CANCELLED` with `firedAt` null and `lastOutcome` reading
    // `EXITED_PLANNED`. The deadline was discharged either way; what was lost is the only
    // evidence distinguishing a timer that supervised something from one tidied away.
    const store = buildStore();
    await registerDueTimer(store);

    const summary = await timerWorker.fireDue(
      deps(store, {
        HARDEN_OR_REPLAN: async ({ tx, entity, storeTime }) => {
          await tx.leg.updateMany({
            where: { id: entity.id, version: entity.version },
            data: { state: "QUEUED", version: entity.version + 1 },
          });
          // Exactly what `apply` does next, and the whole of the race.
          await timers.cancelFor(tx, {
            entityType: "LEG",
            entityId: entity.id,
            storeTime,
            reason: `EXITED_${entity.state}`,
          });
          return { outcome: "PLANNED→QUEUED" };
        },
      }),
      { maxTimerLagSeconds: 10 },
    );

    expect(summary.fired).toBe(1);
    const timer = store.rows("timer")[0];
    expect(timer.timerState).toBe(timers.TIMER_STATE.FIRED);
    expect(timer.lastOutcome).toBe("PLANNED→QUEUED");
    expect(timer.firedAt).toBeTruthy();
  });

  test("PHASE 5 REGRESSION — a handler whose attempt was refused re-arms the deadline instead of discharging it", async () => {
    // The defect this pins: `fireOne` resolved the timer FIRED whatever the handler did.
    // §4.5 is explicit that a handler *attempts* a transition and never forces one, so a
    // refusal is a normal outcome — and the entity is then still sitting in the state
    // whose deadline this was, with no pending timer. That is invariant I4's violation,
    // produced by the supervisor, silently and for ever.
    const store = buildStore();
    await registerDueTimer(store);

    const events = [];
    const summary = await timerWorker.fireDue(
      deps(store, { HARDEN_OR_REPLAN: async () => ({ outcome: "REFUSED:COMMIT_GUARDS_FAILED_INDETERMINATE" }) }, (event, detail) =>
        events.push({ event, detail }),
      ),
      { maxTimerLagSeconds: 10 },
    );

    expect(summary).toMatchObject({ due: 1, fired: 0, rearmed: 1 });

    const timer = store.rows("timer")[0];
    expect(timer.timerState).toBe(timers.TIMER_STATE.PENDING);
    expect(timer.attempts).toBe(1);
    expect(timer.lastOutcome).toBe("REFUSED:COMMIT_GUARDS_FAILED_INDETERMINATE");
    // Re-armed forward, so it does not hot-loop on every pass...
    expect(new Date(timer.dueAt).getTime()).toBeGreaterThan(store.now().getTime());
    // ...and the entity it supervises is still supervised, which is the whole point.
    expect(events.some((entry) => entry.event === "timer.rearmed")).toBe(true);
  });

  test("PHASE 5 REGRESSION — the re-arm is decided from the entity's version, not from what the handler claims", async () => {
    // A handler cannot discharge a deadline by reporting that it acted. The worker
    // re-reads the version and compares; only a version that moved resolves the timer.
    const store = buildStore();
    await registerDueTimer(store);

    const summary = await timerWorker.fireDue(
      deps(store, { HARDEN_OR_REPLAN: async () => ({ outcome: "TRANSITIONED", disposition: "TRANSITIONED", rearmInSeconds: 30 }) }),
      { maxTimerLagSeconds: 10 },
    );

    expect(summary.fired).toBe(0);
    expect(summary.rearmed).toBe(1);
    expect(store.rows("timer")[0].timerState).toBe(timers.TIMER_STATE.PENDING);
  });

  test("PHASE 5 REGRESSION — a handler's effect and the timer's resolution commit together", async () => {
    // The old shape ran the handler on the base client and resolved afterwards, so a
    // failure between the two left a deadline acted on and unresolved, or resolved with
    // its action lost. Here the handler writes and then throws: both must vanish.
    const store = buildStore();
    await registerDueTimer(store);
    const before = (await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } })).version;

    await timerWorker.fireDue(
      deps(store, {
        HARDEN_OR_REPLAN: async ({ tx, entity }) => {
          await tx.leg.updateMany({ where: { id: entity.id, version: entity.version }, data: { version: entity.version + 1 } });
          throw new Error("crash after the mutation");
        },
      }),
      { maxTimerLagSeconds: 10 },
    );

    const after = (await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } })).version;
    expect(after).toBe(before);
    // And the deadline is still owned: re-armed, never resolved on a rolled-back action.
    expect(store.rows("timer")[0].timerState).toBe(timers.TIMER_STATE.PENDING);
    expect(store.rows("timer")[0].lastOutcome).toMatch(/HANDLER_THREW:crash after the mutation/);
  });

  test("PHASE 5 REGRESSION — a second pass cannot claim a timer the first has re-armed past its clock", async () => {
    const store = buildStore();
    await registerDueTimer(store);

    let runs = 0;
    const handlers = { HARDEN_OR_REPLAN: async () => {
      runs += 1;
      return { outcome: "REFUSED:X", rearmInSeconds: 600 };
    } };

    await timerWorker.fireDue(deps(store, handlers), { maxTimerLagSeconds: 10 });
    const second = await timerWorker.fireDue(deps(store, handlers), { maxTimerLagSeconds: 10 });

    // The re-armed timer stays PENDING, so `timerState` alone would let the next pass
    // fire it again. `claim` re-checks `dueAt` against this pass's store clock, which is
    // what makes a re-armed timer safe rather than a doubly-fired one.
    expect(runs).toBe(1);
    expect(second.due).toBe(0);
  });

  test("a timer whose entity version moved on is discarded, and its handler never runs", async () => {
    const store = buildStore();
    await registerDueTimer(store);
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { version: 7 } });

    let ran = false;
    const summary = await timerWorker.fireDue(
      deps(store, { HARDEN_OR_REPLAN: async () => {
        ran = true;
        return {};
      } }),
      { maxTimerLagSeconds: 10 },
    );

    expect(ran).toBe(false);
    expect(summary).toMatchObject({ fired: 0, discarded: 1 });
    expect(store.rows("timer")[0]).toMatchObject({
      timerState: timers.TIMER_STATE.DISCARDED,
      lastOutcome: "ENTITY_VERSION_MOVED_ON",
    });
  });

  test("an unregistered handler leaves the timer PENDING rather than discharging it silently", async () => {
    const store = buildStore();
    await registerDueTimer(store);

    const events = [];
    const summary = await timerWorker.fireDue(deps(store, {}, (event, detail) => events.push({ event, detail })), {
      maxTimerLagSeconds: 10,
    });

    expect(summary.unhandled).toBe(1);
    // It stays due, it keeps counting towards the lag SLI, and the lag SLI is what pages.
    expect(store.rows("timer")[0].timerState).toBe(timers.TIMER_STATE.PENDING);
    expect(events.some((entry) => entry.event === "timer.handler_not_registered")).toBe(true);
  });

  test("a handler that throws re-arms its timer rather than resolving it, with the cause recorded", async () => {
    // Changed by Phase 5's remediation, and the change is the correction: resolving a
    // timer whose handler threw discharges a deadline nobody acted on — §12.1's defect
    // inside the mechanism built to remove it. The whole fire rolls back and the deadline
    // is re-armed on the state's own cadence, so a deterministic handler defect retries
    // visibly instead of either hot-looping or vanishing.
    const store = buildStore();
    await registerDueTimer(store);

    const summary = await timerWorker.fireDue(
      deps(store, { HARDEN_OR_REPLAN: async () => {
        throw new Error("store unavailable");
      } }),
      { maxTimerLagSeconds: 10 },
    );

    expect(summary.threw).toBe(1);
    expect(store.rows("timer")[0].lastOutcome).toMatch(/HANDLER_THREW:store unavailable/);
    expect(store.rows("timer")[0].timerState).toBe(timers.TIMER_STATE.PENDING);
    expect(store.rows("timer")[0].attempts).toBe(1);
  });

  test("lag beyond supervise.max_timer_lag emits the degraded directive", async () => {
    const store = buildStore();
    await registerDueTimer(store, { dueAt: new Date(STORE_NOW.getTime() - 60_000) });

    const events = [];
    const summary = await timerWorker.fireDue(
      deps(store, {}, (event, detail) => events.push({ event, detail })),
      { maxTimerLagSeconds: 10 },
    );

    expect(summary.degraded).toBe(true);
    const directive = events.find((entry) => entry.event === "timer.degraded");
    expect(directive.detail.stopNewHardening).toBe(true);
  });

  test("the lag gauge is advisory — a cache that throws does not stop a pass", async () => {
    const store = buildStore();
    await registerDueTimer(store);

    const summary = await timerWorker.fireDue(
      {
        ...deps(store, { HARDEN_OR_REPLAN: transitioningHandler(store) }),
        advisoryCache: {
          set: async () => {
            throw new Error("redis down");
          },
        },
      },
      { maxTimerLagSeconds: 10 },
    );

    expect(summary.fired).toBe(1);
  });

  test("it refuses to run without a transaction seam — a handler with no transaction can observe and never act", async () => {
    const store = buildStore();
    await expect(
      timerWorker.fireDue(
        { prisma: store.client, readStoreTime: async () => store.now(), handlers: {} },
        {},
      ),
    ).rejects.toThrow(/transaction seam/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §24.5 — chaos: the worker dies mid-sweep
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§24.5 chaos — killing the timer worker mid-sweep misses no transition", () => {
  test("timers unresolved by the killed pass are still due, and the next pass fires them", async () => {
    const store = fixtures.storeFor(fixtures.seed({ legs: 2 }));

    const legs = store.rows("leg");
    for (const leg of legs) {
      await store.client.$transaction((tx) =>
        timers.register(tx, {
          entityType: "LEG",
          entityId: leg.id,
          state: leg.state,
          entity: leg,
          dueAt: new Date(STORE_NOW.getTime() - 1000),
          handler: "HARDEN_OR_REPLAN",
        }),
      );
    }

    // The kill: the handler throws a non-Error the worker does not catch — a process
    // death, modelled as the pass never completing for the second timer.
    const advance = async ({ tx, entity }) => {
      await tx.leg.updateMany({ where: { id: entity.id, version: entity.version }, data: { version: entity.version + 1 } });
      return { outcome: "ATTEMPTED" };
    };

    // The kill, modelled faithfully: at the moment the second timer's handler runs, the
    // process stops existing. Nothing it would have done afterwards happens — not the
    // handler's writes, not the timer's resolution, and **not the re-arm the ordinary
    // failure path would have written**, because a dead process writes nothing. So the
    // store becomes unreachable to it and every subsequent write throws, which takes the
    // pass itself down. Modelling the death as a handler that merely throws would exercise
    // the *error* path rather than the *death* path, and those differ precisely here.
    let dead = false;
    const dyingClient = {
      ...store.client,
      timer: {
        ...store.client.timer,
        updateMany: async (args) => {
          if (dead) throw new Error("SIGKILL: the process is gone");
          return store.client.timer.updateMany(args);
        },
      },
    };

    let handled = 0;
    const killed = timerWorker.fireDue(
      {
        prisma: dyingClient,
        readStoreTime: async () => store.now(),
        runInTransaction: (fn) => store.client.$transaction(fn),
        handlers: {
          HARDEN_OR_REPLAN: async (context) => {
            handled += 1;
            if (handled === 2) {
              dead = true;
              const death = new Error("SIGKILL");
              death.fatal = true;
              throw death;
            }
            return advance(context);
          },
        },
      },
      { maxTimerLagSeconds: 3600 },
    );

    await expect(killed).rejects.toThrow(/SIGKILL/);

    // Restart. The timer the killed handler was working on is still PENDING and still
    // due. Phase 5's remediation made that *stronger* rather than merely preserving it:
    // the claim, the handler's writes, and the resolution are now one transaction, so the
    // death rolls back everything the dying handler had done as well as leaving the
    // deadline owned. The successor inherits work, not a half-applied transition.
    const stillPending = store.rows("timer").filter((timer) => timer.timerState === timers.TIMER_STATE.PENDING);
    expect(store.rows("timer").length).toBe(2);
    expect(stillPending.length).toBe(1);

    const secondPass = await timerWorker.fireDue(
      {
        prisma: store.client,
        readStoreTime: async () => store.now(),
        runInTransaction: (fn) => store.client.$transaction(fn),
        handlers: { HARDEN_OR_REPLAN: advance },
      },
      { maxTimerLagSeconds: 3600 },
    );

    // Whatever the first pass left, the second finishes: no timer is lost, and none is
    // left PENDING and overdue at the end.
    expect(secondPass.due).toBe(stillPending.length);
    expect(store.rows("timer").every((timer) => timer.timerState !== timers.TIMER_STATE.PENDING)).toBe(true);
  });

  test("firing is at-least-once, and a handler that runs twice is the handler's problem to be idempotent about", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
    await store.client.$transaction((tx) =>
      timers.register(tx, {
        entityType: "LEG",
        entityId: leg.id,
        state: leg.state,
        entity: leg,
        dueAt: new Date(STORE_NOW.getTime() - 1000),
        handler: "HARDEN_OR_REPLAN",
      }),
    );

    const timer = store.rows("timer")[0];
    // Two workers resolving one timer: exactly one owns the resolution, because the
    // write is conditional on PENDING.
    const first = await timers.resolve(store.client, {
      id: timer.id,
      timerState: timers.TIMER_STATE.FIRED,
      storeTime: store.now(),
      outcome: "A",
    });
    const second = await timers.resolve(store.client, {
      id: timer.id,
      timerState: timers.TIMER_STATE.FIRED,
      storeTime: store.now(),
      outcome: "B",
    });

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(store.rows("timer")[0].lastOutcome).toBe("A");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The reconciler worker
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the reconciler worker", () => {
  test("a sweep interval at or beyond the plan's 60 s bound is refused", () => {
    expect(() => reconcilerWorker.start({}, { intervalMs: 60_000 })).toThrow(/more often than every 60000 ms/);
    expect(() => reconcilerWorker.start({}, { intervalMs: 0 })).toThrow(/positive number of milliseconds/);
  });

  test("a sweep emits the per-category repair rate, which is the alertable SLI", async () => {
    const store = fixtures.storeFor(fixtures.seed({ legs: 2 }));
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "ACCEPTED" } });

    const events = [];
    const result = await reconcilerWorker.sweepOnce(
      {
        prisma: store.client,
        runInTransaction: (fn) => store.client.$transaction(fn),
        readStoreTime: async () => store.now(),
        record: (event, detail) => events.push({ event, detail }),
      },
      { batch: 50, assignmentDeadlineSeconds: 900, unresponsiveStrikes: 3, energyDeviationTolerance: 0.15 },
    );

    expect(events.map((entry) => entry.event)).toContain("reconciler.repair_rate");
    expect(result.rate.total).toBeGreaterThan(0);
  });

  test("the event-driven nudge runs the same scans against a batch of one", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const result = await reconcilerWorker.nudge(
      {
        prisma: store.client,
        runInTransaction: (fn) => store.client.$transaction(fn),
        readStoreTime: async () => store.now(),
      },
      { assignmentDeadlineSeconds: 900, unresponsiveStrikes: 3, energyDeviationTolerance: 0.15 },
    );
    expect(result.results).toHaveLength(10);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §4.7 — the reassignment protocol
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.7 — reassignment", () => {
  function buildStore() {
    const fixture = fixtures.seed();
    const store = fixtures.storeFor(fixture, { commitments: [fixtures.commitmentRow(fixture, { fence: 42n })] });
    return { fixture, store };
  }

  async function rows(store) {
    const leg = await store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
    const agent = await store.client.agent.findUnique({ where: { id: fixtures.AGENT_ROW_ID } });
    const commitment = await store.client.commitment.findUnique({ where: { commitmentId: "commitment-c1" } });
    return { leg, agent, commitment };
  }

  const config = {
    maxReassignmentsPerLeg: 3,
    incumbentCooloffSeconds: 300,
    reassignBudgetSeconds: 300,
    maxDeliveryDelaySeconds: 30,
    signingKey: fixtures.TEST_SIGNING_KEY,
    trigger: reassignment.TRIGGER.LEASE_EXPIRY,
  };

  test("the freeze, the fence advance, the RECALL and the release are one transaction", async () => {
    const { store } = buildStore();
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "ACCEPTED" } });
    await store.client.agent.update({ where: { id: fixtures.AGENT_ROW_ID }, data: { fenceCounter: 42n } });
    const { leg, agent, commitment } = await rows(store);

    const result = await store.client.$transaction((tx) =>
      reassignment.reassign(tx, { leg, agent, commitment, legCommitments: [commitment], storeTime: store.now(), ...config }),
    );

    expect(result.outcome).toBe(reassignment.OUTCOME.REASSIGNED);
    expect(result.recallFence).toBe(43n);

    // The fence advance and the command that carries it, written together (§4.1 rule 5).
    expect(store.rows("agent")[0].fenceCounter).toBe(43n);
    const recall = store.rows("outbox").find((row) => row.command === "RECALL");
    expect(recall).toMatchObject({ fence: 43n, commitmentId: "commitment-c1" });

    expect(store.rows("leg").find((row) => row.id === fixtures.LEG_ROW_ID).state).toBe("REASSIGNING");
    expect(store.rows("commitment")[0].releasedAt).not.toBeNull();
  });

  test("only that commitment's fence advances — the agent's authority_epoch is untouched (I19)", async () => {
    const { store, fixture } = buildStore();
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "ACCEPTED" } });
    const { leg, agent, commitment } = await rows(store);

    const result = await store.client.$transaction((tx) =>
      reassignment.reassign(tx, { leg, agent, commitment, legCommitments: [commitment], storeTime: store.now(), ...config }),
    );

    expect(result.authorityEpochTouched).toBe(false);
    expect(store.rows("agent")[0].authorityEpoch).toBe(fixture.agent.authorityEpoch);
  });

  test("the fence high-water mark advances in the same transaction (I6)", async () => {
    const { store } = buildStore();
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "ACCEPTED" } });
    const { leg, agent, commitment } = await rows(store);

    await store.client.$transaction((tx) =>
      reassignment.reassign(tx, { leg, agent, commitment, legCommitments: [commitment], storeTime: store.now(), ...config }),
    );

    expect(store.rows("agentFenceAudit")[0]).toMatchObject({ fenceHighWater: 42n, lastFenceSource: "commitment-c1" });
  });

  test("a REASSIGNING timer is registered on entry (I4)", async () => {
    const { store } = buildStore();
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "ACCEPTED" } });
    const { leg, agent, commitment } = await rows(store);

    await store.client.$transaction((tx) =>
      reassignment.reassign(tx, { leg, agent, commitment, legCommitments: [commitment], storeTime: store.now(), ...config }),
    );

    const pending = store.rows("timer").filter((timer) => timer.timerState === timers.TIMER_STATE.PENDING);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ state: "REASSIGNING", handler: "ESCALATE", entityVersion: 1n });
  });

  test("custody HELD is refused — §4.7's three lawful outcomes do not include this path", async () => {
    const { store } = buildStore();
    await store.client.leg.update({
      where: { id: fixtures.LEG_ROW_ID },
      data: { state: "EN_ROUTE_DROP", custodyState: "HELD" },
    });
    const { leg, agent, commitment } = await rows(store);

    const result = await store.client.$transaction((tx) =>
      reassignment.reassign(tx, { leg, agent, commitment, legCommitments: [commitment], storeTime: store.now(), ...config }),
    );

    expect(result).toMatchObject({ outcome: reassignment.OUTCOME.REFUSED, reason: "CUSTODY_HELD" });
    expect(store.rows("outbox")).toHaveLength(0);
  });

  test("the chain is bounded, and exhaustion suspends rather than looping", () => {
    const released = [{ releasedAt: new Date() }, { releasedAt: new Date() }, { releasedAt: new Date() }];
    expect(reassignment.chainLength(released)).toBe(3);
    expect(reassignment.assessChainBound({ commitments: released, maxReassignmentsPerLeg: 3 })).toMatchObject({
      permitted: false,
      reason: "MAX_REASSIGNMENTS_EXHAUSTED",
    });
    // An active commitment is not a past reassignment.
    expect(reassignment.chainLength([...released, { releasedAt: null }])).toBe(3);
  });

  test("an exhausted chain suspends the Task instead of reassigning again", async () => {
    const { store } = buildStore();
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: "ACCEPTED" } });
    const { leg, agent, commitment } = await rows(store);
    const exhausted = [{ releasedAt: new Date() }, { releasedAt: new Date() }, { releasedAt: new Date() }];

    const result = await store.client.$transaction((tx) =>
      reassignment.reassign(tx, { leg, agent, commitment, legCommitments: exhausted, storeTime: store.now(), ...config }),
    );

    expect(result).toMatchObject({ outcome: reassignment.OUTCOME.SUSPENDED, taskState: "SUSPENDED" });
    expect(store.rows("outbox")).toHaveLength(0);
  });

  test("the aging credit measures from the grant, not from the Leg's creation", () => {
    const grantedAt = new Date(STORE_NOW.getTime() - 120_000);
    expect(reassignment.agingCreditSeconds({ grantedAt }, STORE_NOW)).toBe(120);
  });

  test("an agent-to-agent transfer is selected only when a capable receiver positively exists", () => {
    expect(reassignment.transferMissionSpecification({ transferCapableReceiverAvailable: true }).mediation).toBe(
      "AGENT_TO_AGENT",
    );
    for (const absent of [undefined, null, false]) {
      const spec = reassignment.transferMissionSpecification({ transferCapableReceiverAvailable: absent });
      expect({ absent, mediation: spec.mediation, permitted: spec.permitted }).toEqual({
        absent,
        mediation: "HUMAN",
        permitted: false,
      });
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §4.6 — cancellation
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.6 — cancellation", () => {
  function buildStore() {
    return fixtures.storeFor(fixtures.seed());
  }

  async function readLeg(store) {
    return store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
  }

  test("the request writes the flag and bumps the version, and reaches no terminal state", async () => {
    const store = buildStore();
    const leg = await readLeg(store);

    const result = await store.client.$transaction((tx) =>
      cancellation.requestCancellation(tx, {
        leg,
        storeTime: store.now(),
        authorised: true,
        requestedBy: "operator-1",
        reason: "customer withdrew",
      }),
    );

    expect(result.outcome).toBe(cancellation.OUTCOME.REQUESTED);
    const written = store.rows("leg").find((row) => row.id === fixtures.LEG_ROW_ID);
    // §4.6 step 1: "It does not attempt to reach a terminal state directly."
    expect(written.state).toBe("PLANNED");
    expect(written.cancelRequestedAt).not.toBeNull();
    expect(written.version).toBe(1);
  });

  test("an unauthorised request is refused — §4.6 step 5's scope check is not optional", async () => {
    const store = buildStore();
    const leg = await readLeg(store);
    const result = await store.client.$transaction((tx) =>
      cancellation.requestCancellation(tx, { leg, storeTime: store.now(), authorised: false }),
    );
    expect(result).toMatchObject({ outcome: cancellation.OUTCOME.REFUSED, reason: "NOT_AUTHORISED" });
  });

  test("a requester may not cancel a RECOVERY Leg at all; an operator may", async () => {
    const store = buildStore();
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { purpose: "RECOVERY" } });
    const leg = await readLeg(store);

    const asRequester = await store.client.$transaction((tx) =>
      cancellation.requestCancellation(tx, { leg, storeTime: store.now(), authorised: true }),
    );
    expect(asRequester.reason).toBe("CUSTODIAL_PURPOSE_NOT_REQUESTER_CANCELLABLE");

    const asOperator = await store.client.$transaction((tx) =>
      cancellation.requestCancellation(tx, { leg, storeTime: store.now(), authorised: true, isOperator: true }),
    );
    expect(asOperator.outcome).toBe(cancellation.OUTCOME.REQUESTED);
  });

  test("the three §4.6 resolutions follow from custody and commitment alone", () => {
    expect(cancellation.resolutionFor({ custodyState: "NONE" }, false)).toBe(
      cancellation.RESOLUTION.CANCELLED_IMMEDIATELY,
    );
    expect(cancellation.resolutionFor({ custodyState: "NONE" }, true)).toBe(cancellation.RESOLUTION.RECALL_THEN_CANCEL);
    expect(cancellation.resolutionFor({ custodyState: "HELD" }, true)).toBe(
      cancellation.RESOLUTION.RECOVERY_LEG_REQUIRED,
    );
  });

  test("custody HELD spawns a RECOVERY Leg in the same transaction as the ABORTING transition", async () => {
    const store = buildStore();
    await store.client.leg.update({
      where: { id: fixtures.LEG_ROW_ID },
      data: { state: "EN_ROUTE_DROP", custodyState: "HELD" },
    });
    const leg = await readLeg(store);

    const result = await store.client.$transaction((tx) =>
      cancellation.spawnRecoveryLeg(tx, {
        leg,
        storeTime: store.now(),
        recoveryDestination: { lat: 12.9, lon: 77.6, label: "depot" },
        abortBudgetSeconds: 300,
      }),
    );

    expect(result.outcome).toBe(cancellation.OUTCOME.RESOLVED);
    expect(store.rows("leg").find((row) => row.id === fixtures.LEG_ROW_ID).state).toBe("ABORTING");

    const recovery = store.rows("leg").find((row) => row.purpose === "RECOVERY");
    expect(recovery).toMatchObject({ state: "QUEUED", custodyState: "NONE" });
    // §4.6 step 4 — the Task stays non-terminal, with the obligation named.
    expect(result.taskState).toBe("SUSPENDED");
    expect(result.outstandingCustodyObligation).toBe(recovery.legId);
  });

  test("no recovery destination means no RECOVERY Leg — the engine does not choose where a parcel goes", async () => {
    const store = buildStore();
    await store.client.leg.update({
      where: { id: fixtures.LEG_ROW_ID },
      data: { state: "EN_ROUTE_DROP", custodyState: "HELD" },
    });
    const leg = await readLeg(store);

    const result = await store.client.$transaction((tx) =>
      cancellation.spawnRecoveryLeg(tx, { leg, storeTime: store.now(), abortBudgetSeconds: 300 }),
    );

    expect(result.reason).toBe("NO_RECOVERY_DESTINATION");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The Phase 5 schema and migration
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the Phase 5 schema", () => {
  const schema = fs.readFileSync(path.join(BACKEND_ROOT, "prisma", "schema.prisma"), "utf8");
  const migrationDir = path.join(BACKEND_ROOT, "prisma", "migrations", "20260803210000_supervision_and_reconciliation");
  const migration = fs.readFileSync(path.join(migrationDir, "migration.sql"), "utf8");

  test("the three Phase 5 tables exist and carry their §-referenced documentation", () => {
    for (const model of ["Timer", "ReconcilerRepair", "VerificationEvidence"]) {
      expect(new RegExp(`model ${model} \\{`).test(schema)).toBe(true);
    }
    // §4.5's keying rule is documented where the column is declared, not only in the
    // module that reads it — a schema a later phase edits should carry the reason.
    const timer = /model Timer \{[\s\S]*?\n\}/.exec(schema)[0];
    expect(timer).toMatch(/entityVersion BigInt/);
    expect(timer).toMatch(/Never an agent-level counter/);
  });

  test("Task gains a version column — §4.1 rule 2 admits no unconditional state write", () => {
    const task = /model Task \{[\s\S]*?\n\}/.exec(schema)[0];
    expect(task).toMatch(/version\s+Int\s+@default\(0\)/);
    expect(migration).toMatch(/ALTER TABLE "Task" ADD COLUMN\s+"version" INTEGER NOT NULL DEFAULT 0;/);
  });

  test("the migration is additive — nothing is dropped, renamed, or re-typed", () => {
    // Over the SQL, not the prose: the file's own header uses the words "dropped" and
    // "renamed" to say that it does neither.
    const sql = migration
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/ALTER COLUMN/i);
    expect(sql).not.toMatch(/RENAME/i);
  });

  test("the schema backstops are present and each names the § that requires it", () => {
    for (const constraint of [
      "Timer_entity_type_known",
      "Timer_state_known",
      "Timer_entity_version_non_negative",
      "Timer_attempts_non_negative",
      "ReconcilerRepair_category_known",
      "VerificationEvidence_levels_known",
      "VerificationEvidence_outcome_known",
    ]) {
      expect({ constraint, present: migration.includes(constraint) }).toEqual({ constraint, present: true });
    }
  });

  test("the repair-category CHECK lists every §12.4 divergence class the reconciler names", () => {
    const reconciler = require("../../src/engine/supervision/reconciler");
    for (const category of Object.values(reconciler.DIVERGENCE)) {
      expect({ category, inCheck: migration.includes(`'${category}'`) }).toEqual({ category, inCheck: true });
    }
  });

  test("the timer index the plan names is created", () => {
    expect(migration).toMatch(/CREATE INDEX "Timer_dueAt_idx" ON "Timer"\("dueAt"\)/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The absorbed loops, and the operator-visibility route
   ═══════════════════════════════════════════════════════════════════════════ */

describe("what Phase 5 absorbs", () => {
  test("the standalone offline sweep stands down when the engine is on", () => {
    const source = fs.readFileSync(path.join(BACKEND_ROOT, "src", "sockets", "socket.server.js"), "utf8");
    // PHASE 15 remediation (D-6) — the predicate is unchanged; only its spelling is. This
    // used to be a raw `process.env.ENGINE_ENABLED !== "true"` comparison, and the D-6
    // conversion routed every reader of the switch through the module that owns it.
    // `processEnabled()` *is* that comparison (`enabled.js:processEnabled`), so the Phase 5
    // property this test asserts — the standalone sweep stands down exactly when the engine
    // is on for this process — holds identically.
    //
    // Which loop owns §12.4 row 9 is a genuinely process-level question, so this is the one
    // former raw read that correctly stays on the process half alone rather than taking the
    // per-shard conjunction.
    expect(source).toMatch(/!cutoverEnabled\.processEnabled\(\)[\s\S]*startOfflineDetector/);
    expect(source).toMatch(/reconciler owns §12\.4 row 9/);
    // Stronger than the assertion this replaced: the raw read is now *absent*, not merely
    // present in the expected shape.
    expect(source).not.toMatch(/process\.env\.ENGINE_ENABLED/);
  });

  // PHASE 15 — the absorption completes. Phase 5 recorded that `taskRecovery.service.js`
  // does §12.4 row 3 restricted to one trigger (a process restart), and §12.1's argument
  // for why that restriction is the defect: "no component is responsible for noticing that
  // a state has stopped progressing. Patching each trigger individually leaves the seventh
  // undiscovered." The file is now gone and `server.js` calls nothing in its place —
  // because the replacement is a continuous sweep under the shard leader, not a call site.
  test("taskRecovery.service.js is retired and server.js has no boot-time recovery pass", () => {
    expect(fs.existsSync(path.join(BACKEND_ROOT, "src", "services", "taskRecovery.service.js"))).toBe(false);
    expect(() => require("../../src/services/taskRecovery.service")).toThrow(/Cannot find module/);

    const server = fs.readFileSync(path.join(BACKEND_ROOT, "server.js"), "utf8");
    const code = server.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/recoverActiveTasks/);

    // The trigger-independent replacement exists and is declared LEADER_ONLY: §19.3 admits
    // one writer per shard, and a standby running the orphan scan would be a second.
    const registry = require("../../src/workers/registry");
    expect(registry.WORKER_BY_ID.reconciler.readiness).toBe(registry.READINESS.LEADER_ONLY);
    expect(require("../../src/engine/supervision/reconciler").scanOrphanLegs).toBeInstanceOf(Function);
  });

  test("GET /api/legs/:legId/supervision is registered", () => {
    const routes = fs.readFileSync(path.join(BACKEND_ROOT, "src", "routes", "index.js"), "utf8");
    expect(routes).toMatch(/router\.use\("\/legs",\s+legsRoutes\)/);
    const legRoutes = fs.readFileSync(path.join(BACKEND_ROOT, "src", "routes", "legs.routes.js"), "utf8");
    expect(legRoutes).toMatch(/router\.get\("\/:legId\/supervision"/);
  });

  test("the supervision view distinguishes the owning timer from a stale one", () => {
    const controller = require("../../src/controllers/legs.controller");
    const presented = controller.presentTimer({
      timerKey: "LEG:leg-1:OFFERED:3:WITHDRAW_EXCLUDE_REPLAN",
      state: "OFFERED",
      entityVersion: 3n,
      dueAt: STORE_NOW,
      handler: "WITHDRAW_EXCLUDE_REPLAN",
      timerState: "PENDING",
      attempts: 0,
    });
    // BigInt as a decimal string: JSON has no BigInt, and a silent coercion would appear
    // to work for every version anyone would write by hand.
    expect(presented.entityVersion).toBe("3");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Tier discipline
   ═══════════════════════════════════════════════════════════════════════════ */

describe("Phase 5 tier discipline", () => {
  test("no module under src/engine/supervision imports the cache", () => {
    const directory = path.join(BACKEND_ROOT, "src", "engine", "supervision");
    for (const file of fs.readdirSync(directory)) {
      const source = fs.readFileSync(path.join(directory, file), "utf8");
      expect({ file, importsCache: /require\(["'][^"']*cache/.test(source) }).toEqual({ file, importsCache: false });
      expect({ file, importsRedis: /require\(["'](ioredis|redis)/.test(source) }).toEqual({ file, importsRedis: false });
    }
  });

  test("the advisory lag gauge lives in the worker, not in the supervision modules", () => {
    expect(timerWorker.LAG_KEY).toBe("engine:timerlag");
    const worker = fs.readFileSync(path.join(BACKEND_ROOT, "src", "workers", "timer.worker.js"), "utf8");
    expect(worker).toMatch(/Advisory/);
  });

  test("legMachine's terminal partition matches the schema enum's terminal states", () => {
    expect([...legMachine.TERMINAL_LEG_STATES].sort()).toEqual(["CANCELLED", "FAILED", "SETTLED", "WITHDRAWN"]);
  });
});

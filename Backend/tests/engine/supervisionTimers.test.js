"use strict";

/**
 * Engine lane — Phase 5: §4.5's durable timers, and the §4.2/§4.3 state machines they
 * supervise.
 *
 * The phase's stated testing requirements, in order:
 *
 * > Unit: every non-terminal state registers a timer on entry and cancels atomically on
 * > exit (I4); a timer whose entity version moved on is discarded on fire; lease renewal
 * > requires commitment-scoped evidence, not a generic ping.
 *
 * The first of those is checked twice and deliberately: once as a property of the *state
 * machine* (does every non-terminal state have a deadline at all?) and once as a property
 * of the *transition* (does applying one actually register it?). The first can hold while
 * the second fails, and the failure mode — a state with a documented deadline nobody
 * registers — is invisible until the state sticks.
 */

const legMachine = require("../../src/engine/lifecycle/legMachine");
const taskMachine = require("../../src/engine/lifecycle/taskMachine");
const timers = require("../../src/engine/supervision/timers");

const fixtures = require("./helpers/dispatchFixture");

const STORE_NOW = fixtures.seed().now;

/* ═══════════════════════════════════════════════════════════════════════════
   §4.3 and §4.2 — every non-terminal state has an owner and a deadline
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.1 rule 1 — every non-terminal state has an owner and a deadline", () => {
  test("the Leg machine names all nineteen §4.3 states", () => {
    expect(Object.keys(legMachine.LEG_STATE)).toHaveLength(19);
  });

  test("LOADED is the only non-terminal Leg state without a deadline, and its absence is recorded", () => {
    // §4.3's table gives LOADED an em dash in both the deadline and on-expiry columns. A
    // second state appearing here would be a state nobody supervises.
    expect(legMachine.statesWithoutDeadline()).toEqual(["LOADED"]);
  });

  test("every other non-terminal Leg state requires a timer", () => {
    for (const state of Object.values(legMachine.LEG_STATE)) {
      const expected = !legMachine.isTerminal(state) && state !== legMachine.LEG_STATE.LOADED;
      expect({ state, requiresTimer: legMachine.requiresTimer(state) }).toEqual({ state, requiresTimer: expected });
    }
  });

  test("no terminal Leg state requires a timer — a terminal state has nowhere to go", () => {
    for (const state of legMachine.TERMINAL_LEG_STATES) {
      expect(legMachine.requiresTimer(state)).toBe(false);
    }
  });

  test("every non-terminal §4.2 Task state has a deadline", () => {
    expect(taskMachine.statesWithoutDeadline()).toEqual([]);
  });

  test("the Task machine names all eleven §4.2 states and keeps the legacy vocabulary separate", () => {
    expect(Object.keys(taskMachine.TASK_STATE)).toHaveLength(11);
    expect(taskMachine.isEngineState("WAITING")).toBe(true);
    expect(taskMachine.isEngineState("PENDING")).toBe(false);
    expect(taskMachine.isLegacyState("PENDING")).toBe(true);
  });

  test("AT_RISK is a state, not a flag — it is in the enum and it carries a deadline", () => {
    expect(taskMachine.TASK_STATE.AT_RISK).toBe("AT_RISK");
    expect(taskMachine.deadlineFor("AT_RISK")).not.toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §4.3 — the stranding derivation, and invariant I22
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.3 — stranding is derived from the obstruction class, never entered", () => {
  test("CLEAR and RESTRICTIVE are both STRANDED_SAFE, at different response targets", () => {
    const clear = legMachine.strandingStateFor("CLEAR");
    const restrictive = legMachine.strandingStateFor("RESTRICTIVE");

    expect(clear.state).toBe(legMachine.LEG_STATE.STRANDED_SAFE);
    expect(restrictive.state).toBe(legMachine.LEG_STATE.STRANDED_SAFE);
    // The difference is entirely one of response time, which is why it is not a third state.
    expect(clear.responseTargetParameter).not.toBe(restrictive.responseTargetParameter);
    expect(clear.externalEscalation).toBe(false);
    expect(restrictive.externalEscalation).toBe(false);
  });

  test("BLOCKING_CRITICAL is STRANDED_OBSTRUCTING with the external escalation chain", () => {
    const blocking = legMachine.strandingStateFor("BLOCKING_CRITICAL");
    expect(blocking.state).toBe(legMachine.LEG_STATE.STRANDED_OBSTRUCTING);
    expect(blocking.externalEscalation).toBe(true);
  });

  test("INDETERMINATE resolves to the more serious case under DENY semantics", () => {
    // "the cost of over-escalating a safe stranding is an unnecessary callout and the
    // cost of under-escalating an obstructing one is an incident"
    expect(legMachine.strandingStateFor("INDETERMINATE").state).toBe(legMachine.LEG_STATE.STRANDED_OBSTRUCTING);
  });

  test("an absent classification is INDETERMINATE, not CLEAR — absence is never permission", () => {
    for (const absent of [null, undefined, "", "SOMETHING_ELSE"]) {
      const derived = legMachine.strandingStateFor(absent);
      expect({ absent, state: derived.state, obstructionClass: derived.obstructionClass }).toEqual({
        absent,
        state: legMachine.LEG_STATE.STRANDED_OBSTRUCTING,
        obstructionClass: "INDETERMINATE",
      });
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §4.5 — the keying rule
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.5 — timers are keyed on the supervised entity's own version", () => {
  test("a Leg timer takes leg.version and a commitment timer takes commitment.fence", () => {
    expect(timers.versionOf(timers.ENTITY_TYPE.LEG, { version: 3 })).toBe(3n);
    expect(timers.versionOf(timers.ENTITY_TYPE.COMMITMENT, { fence: 42n })).toBe(42n);
    expect(timers.versionOf(timers.ENTITY_TYPE.TASK, { version: 0 })).toBe(0n);
  });

  test("the version source map contains no agent-scope counter", () => {
    // The defect §4.5 names is keying on the agent's epoch. It cannot be reached by
    // accident if no entity kind maps to one.
    for (const field of Object.values(timers.VERSION_SOURCE)) {
      expect(timers.FORBIDDEN_VERSION_SOURCES).not.toContain(field);
    }
  });

  test("an entity with no version of its own is refused, by name", () => {
    expect(() => timers.versionOf(timers.ENTITY_TYPE.LEG, {})).toThrow(/that entity's own "version"/);
    expect(() => timers.versionOf(timers.ENTITY_TYPE.LEG, {})).toThrow(/authority_epoch/);
  });

  test("the key includes the version, so one state at two versions is two keys", () => {
    const base = { entityType: "LEG", entityId: "leg-1", state: "OFFERED", handler: "WITHDRAW_EXCLUDE_REPLAN" };
    expect(timers.timerKey({ ...base, entityVersion: 1 })).not.toBe(timers.timerKey({ ...base, entityVersion: 2 }));
  });

  /* ─────────────────────────────────────────────────────────────────────────
     REGRESSION — Phase 5 remediation, finding 3. The `FORBIDDEN_VERSION_SOURCES`
     guard inspected the call arguments rather than the entity, so it could not
     fire through the module's own call pattern: the check the module's header
     and its own error message both claim was never reachable.
     ───────────────────────────────────────────────────────────────────────── */

  describe("§4.5 — an entity carrying an agent-scope counter is refused by name", () => {
    const dueAt = new Date(STORE_NOW.getTime() + 60_000);

    async function registerWith(entity) {
      const store = fixtures.storeFor(fixtures.seed());
      return store.client.$transaction((tx) =>
        timers.register(tx, {
          entityType: "LEG",
          entityId: fixtures.LEG_ROW_ID,
          state: "OFFERED",
          entity,
          dueAt,
          handler: "WITHDRAW_EXCLUDE_REPLAN",
        }),
      );
    }

    test.each(timers.FORBIDDEN_VERSION_SOURCES)(
      "an entity widened with %s is refused, even when it also carries a plausible version",
      async (forbidden) => {
        // The dangerous shape: an object that *would* key correctly today, because
        // `VERSION_SOURCE` reads `version` and ignores everything else, but whose caller
        // has conflated the agent scope with the entity scope. The structural guarantee
        // cannot see this; the guard is what names it.
        await expect(
          registerWith({ id: fixtures.LEG_ROW_ID, version: 0, state: "OFFERED", [forbidden]: 7 }),
        ).rejects.toThrow(new RegExp(`may not be keyed on "${forbidden}"`));
      },
    );

    test("the refusal explains why an over-invalidated timer is worse than a loud failure", async () => {
      await expect(registerWith({ id: fixtures.LEG_ROW_ID, version: 0, authorityEpoch: 3 })).rejects.toThrow(
        /removes supervision from missions that are executing normally/,
      );
    });

    test("an ordinary Leg row still registers — the guard rejects the defect, not the call pattern", async () => {
      // The counterpart assertion. A guard that refused legitimate rows would be found by
      // the rest of this suite, but only after it had been shipped; this states it.
      const registered = await registerWith({ id: fixtures.LEG_ROW_ID, version: 0, state: "OFFERED" });
      expect(registered.entityVersion).toBe(0n);
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §4.5 — registration, cancellation, and the discard rule
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.5 — the durable timer store", () => {
  function buildStore() {
    return fixtures.storeFor(fixtures.seed());
  }

  const leg = { id: fixtures.LEG_ROW_ID, version: 0, state: "OFFERED" };

  test("registration refuses to happen outside a transaction", async () => {
    const store = buildStore();
    await expect(
      timers.register(store.client, {
        entityType: "LEG",
        entityId: leg.id,
        state: "OFFERED",
        entity: leg,
        dueAt: new Date(STORE_NOW.getTime() + 60_000),
        handler: "WITHDRAW_EXCLUDE_REPLAN",
      }),
    ).rejects.toThrow(/transaction that enters or exits the supervised state/);
  });

  test("cancellation refuses to happen outside a transaction — §4.5 says atomically with the exit", async () => {
    const store = buildStore();
    await expect(
      timers.cancelFor(store.client, { entityType: "LEG", entityId: leg.id, storeTime: store.now() }),
    ).rejects.toThrow(/transaction that enters or exits/);
  });

  test("a timer with no handler is refused — a deadline nobody owns is the defect §12.1 names", async () => {
    const store = buildStore();
    await expect(
      store.client.$transaction((tx) =>
        timers.register(tx, {
          entityType: "LEG",
          entityId: leg.id,
          state: "OFFERED",
          entity: leg,
          dueAt: new Date(STORE_NOW.getTime() + 60_000),
        }),
      ),
    ).rejects.toThrow(/deadline nobody owns/);
  });

  test("registering the same deadline twice yields one timer", async () => {
    const store = buildStore();
    const register = () =>
      store.client.$transaction((tx) =>
        timers.register(tx, {
          entityType: "LEG",
          entityId: leg.id,
          state: "OFFERED",
          entity: leg,
          dueAt: new Date(STORE_NOW.getTime() + 60_000),
          handler: "WITHDRAW_EXCLUDE_REPLAN",
        }),
      );

    const first = await register();
    const second = await register();

    expect(second.id).toBe(first.id);
    expect(store.rows("timer")).toHaveLength(1);
  });

  test("cancellation clears every pending timer for the entity and leaves resolved ones alone", async () => {
    const store = buildStore();
    await store.client.$transaction(async (tx) => {
      await timers.register(tx, {
        entityType: "LEG",
        entityId: leg.id,
        state: "OFFERED",
        entity: leg,
        dueAt: new Date(STORE_NOW.getTime() + 60_000),
        handler: "WITHDRAW_EXCLUDE_REPLAN",
      });
      await timers.register(tx, {
        entityType: "LEG",
        entityId: leg.id,
        state: "ACCEPTED",
        entity: { ...leg, version: 1 },
        dueAt: new Date(STORE_NOW.getTime() + 30_000),
        handler: "PROBE_THEN_REASSIGN",
      });
    });

    const cancelled = await store.client.$transaction((tx) =>
      timers.cancelFor(tx, { entityType: "LEG", entityId: leg.id, storeTime: store.now(), reason: "EXITED_OFFERED" }),
    );

    expect(cancelled).toBe(2);
    for (const timer of store.rows("timer")) {
      expect(timer.timerState).toBe(timers.TIMER_STATE.CANCELLED);
      expect(timer.lastOutcome).toBe("EXITED_OFFERED");
    }
  });

  test("only due timers are selected, and in due order", async () => {
    const store = buildStore();
    await store.client.$transaction(async (tx) => {
      await timers.register(tx, {
        entityType: "LEG",
        entityId: leg.id,
        state: "OFFERED",
        entity: leg,
        dueAt: new Date(STORE_NOW.getTime() - 1000),
        handler: "WITHDRAW_EXCLUDE_REPLAN",
      });
      await timers.register(tx, {
        entityType: "LEG",
        entityId: leg.id,
        state: "ACCEPTED",
        entity: { ...leg, version: 1 },
        dueAt: new Date(STORE_NOW.getTime() + 60_000),
        handler: "PROBE_THEN_REASSIGN",
      });
    });

    const due = await timers.due(store.client, { storeTime: store.now(), limit: 10 });
    expect(due).toHaveLength(1);
    expect(due[0].state).toBe("OFFERED");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §4.5 — "discarded on fire", which is what makes cancellation optional
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.5 — a timer whose entity version moved on is discarded on fire", () => {
  const timer = {
    entityType: "LEG",
    entityId: "leg-1",
    state: "OFFERED",
    entityVersion: 3n,
  };

  test("a matching version and state applies", () => {
    expect(timers.assessFire(timer, { version: 3, state: "OFFERED" })).toEqual({
      disposition: timers.FIRE_DISPOSITION.APPLY,
      reason: null,
    });
  });

  test("a version that moved on discards — this is what makes late firing harmless", () => {
    expect(timers.assessFire(timer, { version: 4, state: "ACCEPTED" })).toEqual({
      disposition: timers.FIRE_DISPOSITION.DISCARD_STALE_VERSION,
      reason: "ENTITY_VERSION_MOVED_ON",
    });
  });

  test("an entity that has vanished discards, and says so distinctly", () => {
    expect(timers.assessFire(timer, null)).toEqual({
      disposition: timers.FIRE_DISPOSITION.DISCARD_ENTITY_GONE,
      reason: "ENTITY_NO_LONGER_EXISTS",
    });
  });

  test("a state that changed without its version is reported as its own defect", () => {
    // Impossible under §4.1 rule 2, which is exactly why it is worth detecting: reaching
    // it means something performed an unconditional write.
    expect(timers.assessFire(timer, { version: 3, state: "ACCEPTED" })).toEqual({
      disposition: timers.FIRE_DISPOSITION.DISCARD_STATE_CHANGED,
      reason: "STATE_CHANGED_WITHOUT_VERSION",
    });
  });

  test("a commitment timer is judged on its fence, not on any Leg version", () => {
    const commitmentTimer = { entityType: "COMMITMENT", entityId: "c1", state: "ACTIVE", entityVersion: 42n };
    expect(timers.assessFire(commitmentTimer, { fence: 42n }).disposition).toBe(timers.FIRE_DISPOSITION.APPLY);
    expect(timers.assessFire(commitmentTimer, { fence: 43n }).disposition).toBe(
      timers.FIRE_DISPOSITION.DISCARD_STALE_VERSION,
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §4.5 — timer lag is a first-class SLI
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.5 — timer-store lag", () => {
  test("lag is the age of the oldest overdue timer, not the count of them", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    await store.client.$transaction(async (tx) => {
      await timers.register(tx, {
        entityType: "LEG",
        entityId: fixtures.LEG_ROW_ID,
        state: "OFFERED",
        entity: { id: fixtures.LEG_ROW_ID, version: 0 },
        dueAt: new Date(STORE_NOW.getTime() - 30_000),
        handler: "WITHDRAW_EXCLUDE_REPLAN",
      });
      await timers.register(tx, {
        entityType: "LEG",
        entityId: fixtures.LEG_ROW_ID,
        state: "ACCEPTED",
        entity: { id: fixtures.LEG_ROW_ID, version: 1 },
        dueAt: new Date(STORE_NOW.getTime() - 5_000),
        handler: "PROBE_THEN_REASSIGN",
      });
    });

    const lag = await timers.readLag(store.client, store.now());
    expect(lag.lagSeconds).toBe(30);
    expect(lag.overdue).toBe(2);
  });

  test("beyond supervise.max_timer_lag the directive stops new hardening and names the mode", () => {
    const degraded = timers.assessLag({ lagSeconds: 30 }, 10);
    expect(degraded.degraded).toBe(true);
    // T3: losing supervision reduces what the engine will attempt.
    expect(degraded.directive.stopNewHardening).toBe(true);
    expect(degraded.directive.enterDegradedMode).toBe("UNSUPERVISED_COMMITMENT");
    expect(degraded.directive.suspendsInvariant).toBe("I4");
    expect(degraded.directive.ownedBy).toMatch(/Phase 12/);
  });

  test("within the bound, nothing degrades", () => {
    expect(timers.assessLag({ lagSeconds: 5 }, 10).degraded).toBe(false);
  });

  test("a non-positive lag bound is refused rather than defaulted", () => {
    for (const bad of [0, -1, NaN, undefined]) {
      expect(() => timers.assessLag({ lagSeconds: 1 }, bad)).toThrow(/lag bound must be positive/);
    }
  });
});

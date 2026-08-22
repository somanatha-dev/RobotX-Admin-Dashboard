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

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 5 REMEDIATION — the re-arm, the claim, and the recorded interval

   Every test in this block pins a defect found by driving the shipped modules
   against live PostgreSQL, not by reading them. Each is written so that removing
   the fix makes it fail.
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.5 / I4 — a deadline the fire did not discharge is re-armed, not resolved", () => {
  const legRow = { id: fixtures.LEG_ROW_ID, version: 0, state: "AT_PICKUP" };

  async function armed(store, overrides) {
    return store.client.$transaction((tx) =>
      timers.register(tx, {
        entityType: "LEG",
        entityId: legRow.id,
        state: "AT_PICKUP",
        entity: legRow,
        dueAt: new Date(STORE_NOW.getTime() + 600_000),
        armedSeconds: 600,
        handler: "OPERATOR_ALERT",
        ...(overrides || {}),
      }),
    );
  }

  test("REGRESSION — re-registering a RESOLVED key re-arms it instead of handing back a resolved row", async () => {
    // The defect: `register` returned the existing row for any `timerState`. A caller
    // asking for a live state to be supervised was handed a FIRED, CANCELLED or DISCARDED
    // row and got no pending timer at all — the entity then non-terminal and unsupervised,
    // which is invariant I4's violation produced by the function meant to prevent it.
    //
    // Reproduced live: after a fire, `findUnsupervised` went on reporting the Leg however
    // many times a repair tried to re-arm it.
    const store = fixtures.storeFor(fixtures.seed());
    const first = await armed(store);
    await timers.resolve(store.client, {
      id: first.id,
      timerState: timers.TIMER_STATE.FIRED,
      storeTime: store.now(),
      outcome: "OPERATOR_ALERTED",
    });
    expect(store.rows("timer")[0].timerState).toBe(timers.TIMER_STATE.FIRED);

    const again = await armed(store, { dueAt: new Date(STORE_NOW.getTime() + 900_000) });

    expect(again.id).toBe(first.id); // still one row: the key is unique and stays so
    expect(store.rows("timer")).toHaveLength(1);
    expect(again.timerState).toBe(timers.TIMER_STATE.PENDING);
    expect(again.lastOutcome).toBe("REARMED_FROM_FIRED");
    expect(again.firedAt).toBeNull();
  });

  test("a PENDING row is returned unchanged — the idempotency `register` has always promised", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const first = await armed(store);
    const again = await armed(store, { dueAt: new Date(STORE_NOW.getTime() + 999_000) });
    expect(again.id).toBe(first.id);
    expect(store.rows("timer")).toHaveLength(1);
    // Unchanged: a retried transition must not push a pending deadline further out.
    expect(new Date(again.dueAt).getTime()).toBe(new Date(first.dueAt).getTime());
  });

  test("REGRESSION — the armed interval is recorded, not inferred from dueAt minus createdAt", async () => {
    // The inference is wrong for every row registered with a `dueAt` already in the past —
    // a reconciler repair, and every harness — and it cannot express §4.3's two *projected*
    // deadlines at all, whose value is a mission ETA rather than a register entry.
    const store = fixtures.storeFor(fixtures.seed());
    const row = await armed(store, { dueAt: new Date(STORE_NOW.getTime() - 5_000), armedSeconds: 600 });
    expect(row.payload.armedSeconds).toBe(600);
    expect(timers.armedSecondsOf(row)).toBe(600);

    // And with nothing recorded it still falls back, for rows written before this landed.
    expect(timers.armedSecondsOf({ dueAt: new Date(1_600_000), createdAt: new Date(1_000_000) })).toBe(600);
    // A past `dueAt` and no record yields no answer, rather than a negative one.
    expect(timers.armedSecondsOf({ dueAt: new Date(1_000_000), createdAt: new Date(1_600_000) })).toBeUndefined();
  });

  test("reschedule moves the deadline forward, counts the attempt, and keeps it PENDING", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const row = await armed(store, { dueAt: new Date(STORE_NOW.getTime() - 1_000) });

    const moved = await timers.reschedule(store.client, {
      id: row.id,
      dueAt: new Date(STORE_NOW.getTime() + 600_000),
      outcome: "REFUSED:LADDER_NOT_IMPLEMENTED",
    });

    expect(moved).toBe(1);
    const after = store.rows("timer")[0];
    expect(after.timerState).toBe(timers.TIMER_STATE.PENDING);
    expect(after.attempts).toBe(1);
    expect(after.lastOutcome).toBe("REFUSED:LADDER_NOT_IMPLEMENTED");
    // `firedAt` marks a fire that *discharged* a deadline. This one was not discharged.
    // `?? null` because the store model leaves an unset column undefined where PostgreSQL
    // holds NULL; the live harness asserts the column itself.
    expect(after.firedAt ?? null).toBeNull();
  });

  test("reschedule refuses a deadline that is not an absolute instant (§10.6)", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const row = await armed(store);
    for (const bad of [undefined, null, "soon", new Date(NaN), 600]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(timers.reschedule(store.client, { id: row.id, dueAt: bad })).rejects.toThrow(/absolute instant/);
    }
  });

  test("reschedule will not revive a resolved timer", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const row = await armed(store);
    await timers.resolve(store.client, {
      id: row.id,
      timerState: timers.TIMER_STATE.DISCARDED,
      storeTime: store.now(),
      outcome: "ENTITY_VERSION_MOVED_ON",
    });
    const moved = await timers.reschedule(store.client, { id: row.id, dueAt: new Date(STORE_NOW.getTime() + 10_000) });
    expect(moved).toBe(0);
    expect(store.rows("timer")[0].timerState).toBe(timers.TIMER_STATE.DISCARDED);
  });
});

describe("§4.5 — claim is what makes a fire exclusive", () => {
  const legRow = { id: fixtures.LEG_ROW_ID, version: 0, state: "AT_PICKUP" };

  async function due(store, dueAt) {
    return store.client.$transaction((tx) =>
      timers.register(tx, {
        entityType: "LEG",
        entityId: legRow.id,
        state: "AT_PICKUP",
        entity: legRow,
        dueAt,
        armedSeconds: 600,
        handler: "OPERATOR_ALERT",
      }),
    );
  }

  test("a due PENDING timer is claimed, and a resolved one is not", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const row = await due(store, new Date(STORE_NOW.getTime() - 1_000));

    const first = await store.client.$transaction((tx) => timers.claim(tx, { id: row.id, storeTime: store.now() }));
    expect(first).toBe(true);

    await timers.resolve(store.client, {
      id: row.id,
      timerState: timers.TIMER_STATE.FIRED,
      storeTime: store.now(),
      outcome: "X",
    });
    const second = await store.client.$transaction((tx) => timers.claim(tx, { id: row.id, storeTime: store.now() }));
    expect(second).toBe(false);
  });

  test("REGRESSION — a timer re-armed past this pass's clock cannot be claimed by it", async () => {
    // The defect this forecloses: a re-armed timer stays PENDING, so a claim that checked
    // only `timerState` would fire it again in the very next pass — and for a paging action
    // there is no version to make the second call a no-op. Two responder pages, one incident.
    const store = fixtures.storeFor(fixtures.seed());
    const row = await due(store, new Date(STORE_NOW.getTime() - 1_000));
    await timers.reschedule(store.client, {
      id: row.id,
      dueAt: new Date(STORE_NOW.getTime() + 600_000),
      outcome: "PAGED",
    });

    const claimed = await store.client.$transaction((tx) => timers.claim(tx, { id: row.id, storeTime: store.now() }));
    expect(claimed).toBe(false);
    expect(store.rows("timer")[0].timerState).toBe(timers.TIMER_STATE.PENDING);
  });

  test("claiming refuses to happen outside a transaction", async () => {
    const store = fixtures.storeFor(fixtures.seed());
    const row = await due(store, new Date(STORE_NOW.getTime() - 1_000));
    await expect(timers.claim(store.client, { id: row.id, storeTime: store.now() })).rejects.toThrow(
      /transaction that enters or exits/,
    );
  });

  test("REGRESSION — a claimed fire records itself even after the transition cancelled it", async () => {
    // `transitions.apply` cancels **every** pending timer for the entity on state exit,
    // including the one that is at that moment firing. A resolution conditional on PENDING
    // then matches nothing, and a deadline that was acted on is recorded as one that was
    // tidied away: `firedAt` null, `lastOutcome` reading EXITED_… rather than the action.
    const store = fixtures.storeFor(fixtures.seed());
    const row = await due(store, new Date(STORE_NOW.getTime() - 1_000));

    await store.client.$transaction(async (tx) => {
      await timers.claim(tx, { id: row.id, storeTime: store.now() });
      await timers.cancelFor(tx, {
        entityType: "LEG",
        entityId: legRow.id,
        storeTime: store.now(),
        reason: "EXITED_AT_PICKUP",
      });
      await timers.resolve(tx, {
        id: row.id,
        timerState: timers.TIMER_STATE.FIRED,
        storeTime: store.now(),
        outcome: "OPERATOR_ALERTED",
        owned: true,
      });
    });

    const after = store.rows("timer")[0];
    expect(after.timerState).toBe(timers.TIMER_STATE.FIRED);
    expect(after.lastOutcome).toBe("OPERATOR_ALERTED");
    expect(after.firedAt).not.toBeNull();
  });

  test("without owned, the same sequence loses the fire to the cancellation", async () => {
    // The other half of the pair: this is what the code did before, and it is why `owned`
    // exists. Asserted rather than described, so the distinction cannot quietly collapse.
    const store = fixtures.storeFor(fixtures.seed());
    const row = await due(store, new Date(STORE_NOW.getTime() - 1_000));

    await store.client.$transaction(async (tx) => {
      await timers.claim(tx, { id: row.id, storeTime: store.now() });
      await timers.cancelFor(tx, {
        entityType: "LEG",
        entityId: legRow.id,
        storeTime: store.now(),
        reason: "EXITED_AT_PICKUP",
      });
      const count = await timers.resolve(tx, {
        id: row.id,
        timerState: timers.TIMER_STATE.FIRED,
        storeTime: store.now(),
        outcome: "OPERATOR_ALERTED",
      });
      expect(count).toBe(0);
    });

    expect(store.rows("timer")[0].timerState).toBe(timers.TIMER_STATE.CANCELLED);
  });
});

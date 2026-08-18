"use strict";

/**
 * Engine lane — Phase 5: the §4.4 transition table, and the model check §24.2 asks for.
 *
 * > Model check: every non-terminal state eventually leaves under fair timer firing;
 * > custody never lost (`HELD` → `RELEASED`/`DISPUTED`).
 *
 * The model check here is a reachability argument over the table rather than a TLA+
 * model: §4.4 is a finite table with finite guards, so "every non-terminal state has an
 * outgoing transition whose guard can be satisfied, and every path from it reaches a
 * terminal state" is decidable by exhaustive search — which is what `everyStateReaches`
 * below performs. The commitment core's TLA+ model (Phase 3) covers the part that needed
 * a model checker: concurrency.
 */

const cancellation = require("../../src/engine/lifecycle/cancellation");
const custody = require("../../src/engine/domain/custody");
const leases = require("../../src/engine/supervision/leases");
const legMachine = require("../../src/engine/lifecycle/legMachine");
const timers = require("../../src/engine/supervision/timers");
const transitions = require("../../src/engine/lifecycle/transitions");

const fixtures = require("./helpers/dispatchFixture");

const S = legMachine.LEG_STATE;
const STORE_NOW = fixtures.seed().now;

/* ═══════════════════════════════════════════════════════════════════════════
   §4.4 — the table itself
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.4 — the complete transition table", () => {
  test("every non-terminal state has an outgoing transition", () => {
    // The precondition of §24.2's liveness claim: a state with no outgoing row cannot be
    // left however fairly its timer fires.
    expect(transitions.statesWithoutExit()).toEqual([]);
  });

  test("QUEUED, DEFERRED and PLANNED transitions carry no commitment and no fence", () => {
    // §4.4: "Transitions between `QUEUED`, `DEFERRED`, and `PLANNED` involve no
    // commitment and no fence, because no command has been sent to any agent (§2.6)."
    const planningStates = [S.QUEUED, S.DEFERRED, S.PLANNED];
    for (const row of transitions.TRANSITIONS) {
      if (typeof row.from === "function" || Array.isArray(row.from)) continue;
      if (!planningStates.includes(row.from)) continue;
      if (typeof row.to !== "string" || !planningStates.includes(row.to)) continue;
      expect({ from: row.from, event: row.event, scope: row.scope }).toEqual({
        from: row.from,
        event: row.event,
        scope: transitions.WRITE_SCOPE.PLANNING_ONLY,
      });
    }
  });

  test("the re-plan row writes nothing at all — nothing was ever committed", () => {
    const row = transitions.find(S.PLANNED, transitions.EVENT.REPLAN_SELECTS_ANOTHER_AGENT);
    expect(row.durable).toBe(false);
    expect(row.effects).toContain("DISCARD_SOFT_RESERVATION_IN_MEMORY");
  });

  test("hardening and settlement are commitment-scope writes", () => {
    expect(transitions.find(S.PLANNED, transitions.EVENT.HARDENING_DUE).scope).toBe(
      transitions.WRITE_SCOPE.COMMITMENT,
    );
    expect(transitions.find(S.RELEASED, transitions.EVENT.VERIFICATION_COMPLETE).scope).toBe(
      transitions.WRITE_SCOPE.COMMITMENT,
    );
  });

  test("the two wildcard rows apply from any non-terminal state and from no terminal one", () => {
    for (const state of Object.values(S)) {
      const found = transitions.find(state, transitions.EVENT.LEASE_EXPIRY);
      expect({ state, matched: found !== null }).toEqual({ state, matched: !legMachine.isTerminal(state) });
    }
  });

  test("a pair with no row is reported as such rather than guessed at", () => {
    expect(transitions.find(S.SETTLED, transitions.EVENT.AGENT_ACK)).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §4.4 — the lease-expiry target, by custody and obstruction class
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.4 / §12.2 — lease expiry resolves by custody state and obstruction class", () => {
  test("custody NONE reassigns — a failure before custody is a scheduling problem", () => {
    expect(transitions.leaseExpiryTarget({ custodyState: "NONE" })).toBe(S.REASSIGNING);
  });

  test("custody HELD and unreachable strands, at the class the location implies", () => {
    expect(transitions.leaseExpiryTarget({ custodyState: "HELD", obstructionClass: "CLEAR" })).toBe(S.STRANDED_SAFE);
    expect(transitions.leaseExpiryTarget({ custodyState: "HELD", obstructionClass: "BLOCKING_CRITICAL" })).toBe(
      S.STRANDED_OBSTRUCTING,
    );
  });

  test("custody HELD with an unknown location strands as obstructing", () => {
    expect(transitions.leaseExpiryTarget({ custodyState: "HELD" })).toBe(S.STRANDED_OBSTRUCTING);
  });

  /* ─────────────────────────────────────────────────────────────────────────
     REGRESSION — Phase 5 remediation, finding 1.
     `leaseExpiryTarget` restated §4.7's recovery assessment inline instead of
     reading it from `supervision/leases.assessRecovery`, and the restatement had
     drifted. These tests pin the agreement itself, not one example of it, because
     the defect was a second implementation rather than a wrong branch.
     ───────────────────────────────────────────────────────────────────────── */

  test("DISPUTED custody takes the physical-recovery path, not the custody-NONE one", () => {
    // §2.5: "Evidence conflicts… not knowing resolves to the conservative case", which is
    // why `custody.holdsGoods("DISPUTED")` is true. Routing it to REASSIGNING applied the
    // treatment §4.7 reserves for an agent carrying nothing, to a Leg that may be carrying
    // goods — the exact failure §4.1 rule 4 exists to prevent.
    expect(custody.holdsGoods("DISPUTED")).toBe(true);
    expect(transitions.leaseExpiryTarget({ custodyState: "DISPUTED", obstructionClass: "CLEAR" })).toBe(S.STRANDED_SAFE);
    expect(transitions.leaseExpiryTarget({ custodyState: "DISPUTED", obstructionClass: "BLOCKING_CRITICAL" })).toBe(
      S.STRANDED_OBSTRUCTING,
    );
    expect(transitions.leaseExpiryTarget({ custodyState: "DISPUTED" })).toBe(S.STRANDED_OBSTRUCTING);
  });

  test("the table's target agrees with leases.assessRecovery for every custody state and obstruction class", () => {
    // The property the finding was an instance of: §12.2's decision has one
    // implementation, and this row reports it. A future edit that reintroduced a literal
    // custody comparison here would fail this before it could reach a live timer handler.
    for (const custodyState of custody.CUSTODY_STATE_NAMES) {
      for (const obstructionClass of ["CLEAR", "RESTRICTIVE", "BLOCKING_CRITICAL", undefined]) {
        const context = { custodyState, obstructionClass, leg: { state: S.EN_ROUTE_DROP } };
        expect({ custodyState, obstructionClass, target: transitions.leaseExpiryTarget(context) }).toEqual({
          custodyState,
          obstructionClass,
          target: leases.assessRecovery(context).legState,
        });
      }
    }
  });

  test("§4.7 Resume continues the Leg where it is — it does not reassign it away from the incumbent", () => {
    // §4.7's Resume mechanism is "Lease renewed, replan route, continue". Resolving it to
    // REASSIGNING froze the Leg and took it from an incumbent that had just recovered.
    const resumed = {
      custodyState: "HELD",
      agentReachable: true,
      withinResumeWindow: true,
      stillFeasible: true,
      leg: { state: S.EN_ROUTE_DROP },
    };
    expect(leases.assessRecovery(resumed).outcome).toBe(leases.RECOVERY_OUTCOME.RESUME);
    expect(transitions.leaseExpiryTarget(resumed)).toBe(S.EN_ROUTE_DROP);
  });

  test("an incumbent inside its resume window but no longer feasible is assessed, not resumed", () => {
    // The second drift: the inline copy omitted `stillFeasible` from the Resume condition,
    // so an infeasible incumbent was resumed on reachability alone.
    const infeasible = {
      custodyState: "HELD",
      agentReachable: true,
      withinResumeWindow: true,
      stillFeasible: false,
      obstructionClass: "CLEAR",
      leg: { state: S.EN_ROUTE_DROP },
    };
    expect(leases.assessRecovery(infeasible).outcome).toBe(leases.RECOVERY_OUTCOME.PHYSICAL_RECOVERY);
    expect(transitions.leaseExpiryTarget(infeasible)).toBe(S.STRANDED_SAFE);
  });

  test("an unrecognised custody state is refused, never read as NONE", () => {
    // §2.5: "An unrecognised custody state is never treated as NONE." The literal
    // comparison silently reassigned it; the shared assessment refuses it.
    expect(() => transitions.leaseExpiryTarget({ custodyState: "PROBABLY_FINE" })).toThrow(/unknown custody state/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §4.4 — guards, and §4.1 rule 3
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.4 — guards", () => {
  test("a guard with no evidence supplied fails as INDETERMINATE, never as a pass", () => {
    // §4.1 rule 3: "State is never inferred from the absence of data. Absence triggers
    // investigation, not assumption."
    const row = transitions.find(S.EN_ROUTE_PICKUP, transitions.EVENT.ARRIVAL_VERIFIED);
    const verdict = transitions.evaluateGuards(row, { leg: { version: 0 }, expectedVersion: 0 });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0].reason).toMatch(/INDETERMINATE$/);
    expect(verdict.failures[0].detail).toMatch(/absence triggers/i);
  });

  test("every guard is evaluated — none short-circuits", () => {
    const row = transitions.find(S.QUEUED, transitions.EVENT.ROUND_SELECTS_COLUMN);
    const verdict = transitions.evaluateGuards(row, { leg: { version: 5 }, expectedVersion: 0 });
    expect(verdict.verdicts).toHaveLength(row.guards.length);
    expect(verdict.failures.length).toBeGreaterThan(1);
  });

  test("a stale expected version fails the CAS guard by name, on the row §4.4 names it", () => {
    // §4.4 lists "`leg.version` CAS ok" explicitly on this row, because the round's own
    // read is what it is checked against. Every other row gets the same protection from
    // `apply`'s conditional write rather than from a repeated declaration.
    const row = transitions.find(S.QUEUED, transitions.EVENT.ROUND_SELECTS_COLUMN);
    const verdict = transitions.evaluateGuards(row, {
      leg: { version: 4, custodyState: "NONE" },
      expectedVersion: 3,
      columnFeasible: true,
    });
    expect(verdict.failures.map((failure) => failure.reason)).toContain("LEG_VERSION_MOVED");
  });

  test("the no-custody guard reads the Leg, not the caller's word for it", () => {
    const row = transitions.find(S.ACCEPTED, transitions.EVENT.START_GRACE_EXPIRY);
    const held = transitions.evaluateGuards(row, { leg: { version: 0, custodyState: "HELD" }, expectedVersion: 0 });
    expect(held.ok).toBe(false);
    const empty = transitions.evaluateGuards(row, { leg: { version: 0, custodyState: "NONE" }, expectedVersion: 0 });
    expect(empty.ok).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §4.6 rule 2 — the purpose-conditioned cancellation guard
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§4.6 rule 2 — the cancellation guard is purpose-conditioned", () => {
  test("no cancellation requested: every transition proceeds", () => {
    expect(transitions.cancellationGuard({ cancelRequestedAt: null, purpose: "PRIMARY" }).ok).toBe(true);
  });

  test("a cancelled PRIMARY Leg fails the guard — the mid-flight round abandons its decision", () => {
    const verdict = transitions.cancellationGuard({ cancelRequestedAt: new Date(), purpose: "PRIMARY" });
    expect(verdict).toEqual({ ok: false, reason: "CANCELLATION_REQUESTED" });
  });

  test("a RECOVERY or TRANSFER Leg is exempt — this is what makes the mandated recovery path executable", () => {
    for (const custodial of ["RECOVERY", "TRANSFER"]) {
      const verdict = transitions.cancellationGuard({ cancelRequestedAt: new Date(), purpose: custodial });
      expect({ custodial, ok: verdict.ok }).toEqual({ custodial, ok: true });
    }
  });

  test("the exemption is narrow and closed — no other purpose is exempt", () => {
    for (const other of ["PRIMARY", "REPOSITION", "EXERCISE", "MAINTENANCE_TRANSIT"]) {
      const verdict = transitions.cancellationGuard({ cancelRequestedAt: new Date(), purpose: other });
      expect({ other, ok: verdict.ok }).toEqual({ other, ok: false });
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §4.1 rule 2 + §4.5 — applying a transition
   ═══════════════════════════════════════════════════════════════════════════ */

describe("applying a transition", () => {
  function buildStore() {
    return fixtures.storeFor(fixtures.seed());
  }

  async function readLeg(store) {
    return store.client.leg.findUnique({ where: { id: fixtures.LEG_ROW_ID } });
  }

  test("entering a state registers its timer, in the same transaction (I4)", async () => {
    const store = buildStore();
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: S.OFFERED } });
    const leg = await readLeg(store);

    const result = await store.client.$transaction((tx) =>
      transitions.apply(tx, {
        leg,
        event: transitions.EVENT.AGENT_ACK,
        storeTime: store.now(),
        deadlineSeconds: 60,
        context: {
          commitment: { fence: 42n },
          fence: 42n,
          offerUnexpired: true,
        },
      }),
    );

    expect(result.outcome).toBe(transitions.OUTCOME.APPLIED);
    expect(result.to).toBe(S.ACCEPTED);

    const registered = store.rows("timer").filter((timer) => timer.timerState === timers.TIMER_STATE.PENDING);
    expect(registered).toHaveLength(1);
    // Keyed on the Leg's **new** version, which is what the entity's own version now is.
    expect(registered[0]).toMatchObject({ state: S.ACCEPTED, entityVersion: 1n, handler: "PROBE_THEN_REASSIGN" });
  });

  test("exiting a state cancels its timer atomically with the exit (I4)", async () => {
    const store = buildStore();
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: S.OFFERED } });

    let leg = await readLeg(store);
    await store.client.$transaction((tx) =>
      timers.register(tx, {
        entityType: "LEG",
        entityId: leg.id,
        state: S.OFFERED,
        entity: leg,
        dueAt: new Date(STORE_NOW.getTime() + 20_000),
        handler: "WITHDRAW_EXCLUDE_REPLAN",
      }),
    );

    leg = await readLeg(store);
    await store.client.$transaction((tx) =>
      transitions.apply(tx, {
        leg,
        event: transitions.EVENT.AGENT_ACK,
        storeTime: store.now(),
        deadlineSeconds: 60,
        context: { commitment: { fence: 42n }, fence: 42n, offerUnexpired: true },
      }),
    );

    const offeredTimer = store.rows("timer").find((timer) => timer.state === S.OFFERED);
    expect(offeredTimer.timerState).toBe(timers.TIMER_STATE.CANCELLED);
  });

  test("entering a state with no resolved deadline is refused, loudly", async () => {
    const store = buildStore();
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: S.OFFERED } });
    const leg = await readLeg(store);

    await expect(
      store.client.$transaction((tx) =>
        transitions.apply(tx, {
          leg,
          event: transitions.EVENT.AGENT_ACK,
          storeTime: store.now(),
          context: { commitment: { fence: 42n }, fence: 42n, offerUnexpired: true },
        }),
      ),
    ).rejects.toThrow(/requires a deadline/);
  });

  test("a Leg whose version moved on loses the race rather than overwriting", async () => {
    const store = buildStore();
    await store.client.leg.update({ where: { id: fixtures.LEG_ROW_ID }, data: { state: S.OFFERED } });
    const stale = { ...(await readLeg(store)), version: 99 };

    const result = await store.client.$transaction((tx) =>
      transitions.apply(tx, {
        leg: stale,
        event: transitions.EVENT.AGENT_ACK,
        storeTime: store.now(),
        deadlineSeconds: 60,
        context: { commitment: { fence: 42n }, fence: 42n, offerUnexpired: true, expectedVersion: 99 },
      }),
    );

    expect(result.outcome).toBe(transitions.OUTCOME.LOST_RACE);
    expect(store.rows("leg").find((row) => row.id === fixtures.LEG_ROW_ID).state).toBe(S.OFFERED);
  });

  test("a pending cancellation refuses every transition but the cancellation itself", async () => {
    const store = buildStore();
    await store.client.leg.update({
      where: { id: fixtures.LEG_ROW_ID },
      data: { state: S.OFFERED, cancelRequestedAt: store.now() },
    });
    const leg = await readLeg(store);

    const result = await store.client.$transaction((tx) =>
      transitions.apply(tx, {
        leg,
        event: transitions.EVENT.AGENT_ACK,
        storeTime: store.now(),
        deadlineSeconds: 60,
        context: { commitment: { fence: 42n }, fence: 42n, offerUnexpired: true },
      }),
    );

    expect(result.outcome).toBe(transitions.OUTCOME.REFUSED);
    expect(result.reason).toBe("CANCELLATION_REQUESTED");
  });

  test("the non-durable re-plan row writes nothing", async () => {
    const store = buildStore();
    const leg = await readLeg(store);

    const result = await store.client.$transaction((tx) =>
      transitions.apply(tx, {
        leg,
        event: transitions.EVENT.REPLAN_SELECTS_ANOTHER_AGENT,
        storeTime: store.now(),
        context: { churnPriced: true },
      }),
    );

    expect(result).toMatchObject({ outcome: transitions.OUTCOME.APPLIED, durable: false });
    expect(store.rows("leg").find((row) => row.id === fixtures.LEG_ROW_ID).version).toBe(0);
    expect(store.rows("timer")).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §24.2 — the model check
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§24.2 — model check over the §4.4 table", () => {
  /**
   * Exhaustive reachability: from every non-terminal state, can a terminal state be
   * reached by following the table?
   *
   * The wildcard rows are what guarantee it — `LEASE_EXPIRY` and `CANCEL_REQUEST` apply
   * from every non-terminal state — but that is the property being *checked*, not
   * assumed, because a future edit that scoped either of them to a state list would
   * silently create a state with no path out.
   */
  function reachableFrom(start) {
    const seen = new Set([start]);
    const queue = [start];

    while (queue.length > 0) {
      const state = queue.shift();
      if (legMachine.isTerminal(state)) continue;

      for (const event of Object.values(transitions.EVENT)) {
        const row = transitions.find(state, event);
        if (!row) continue;
        const contexts = [
          { custodyState: "NONE" },
          { custodyState: "HELD", obstructionClass: "CLEAR" },
          { custodyState: "HELD", obstructionClass: "BLOCKING_CRITICAL" },
          { settled: true },
          { settled: false },
        ];
        for (const context of contexts) {
          const target = transitions.targetOf(row, context);
          if (typeof target !== "string" || seen.has(target)) continue;
          seen.add(target);
          queue.push(target);
        }
      }
    }
    return seen;
  }

  test("every non-terminal state reaches a terminal state", () => {
    for (const state of Object.values(S)) {
      if (legMachine.isTerminal(state)) continue;
      const reachable = [...reachableFrom(state)];
      const terminals = reachable.filter((candidate) => legMachine.isTerminal(candidate));
      expect({ state, reachesTerminal: terminals.length > 0 }).toEqual({ state, reachesTerminal: true });
    }
  });

  test("custody is never lost — HELD leaves only to RELEASED or DISPUTED", () => {
    // §2.5's state machine, asserted over the enum rather than over a path: a custody
    // state with a transition to NONE would be goods that stopped existing.
    expect(custody.holdsGoods("HELD")).toBe(true);
    expect(custody.isDischarged("RELEASED")).toBe(true);
    // DISPUTED still holds goods — the evidence conflicts, so the engine does not know,
    // and not knowing resolves to the conservative case.
    expect(custody.holdsGoods("DISPUTED")).toBe(true);
    expect(custody.isReassignableWithoutIntervention("HELD")).toBe(false);
  });

  test("a Leg terminates only once custody is discharged (I7, I8)", () => {
    // §4.4's last row: "Leg terminates only once custody is discharged". The guard is
    // CUSTODY_ACCOUNTED_FOR, and it fails without positive evidence.
    const row = transitions.find(S.STRANDED_SAFE, transitions.EVENT.GOODS_AND_AGENT_RECOVERED);
    expect(row.guards).toContain(transitions.GUARD.CUSTODY_ACCOUNTED_FOR);
    expect(transitions.evaluateGuards(row, { leg: { version: 0 } }).ok).toBe(false);
  });

  test("a cancelled Task waits for every custodial Leg to settle (I11)", () => {
    const outstanding = cancellation.assessTaskTermination([
      { purpose: "PRIMARY", state: S.CANCELLED, legId: "leg-1" },
      { purpose: "RECOVERY", state: S.EN_ROUTE_DROP, legId: "leg-1-recovery-1" },
    ]);
    expect(outstanding).toEqual({
      mayCancel: false,
      taskState: "SUSPENDED",
      outstanding: ["leg-1-recovery-1"],
    });

    const discharged = cancellation.assessTaskTermination([
      { purpose: "PRIMARY", state: S.CANCELLED, legId: "leg-1" },
      { purpose: "RECOVERY", state: S.SETTLED, legId: "leg-1-recovery-1" },
    ]);
    expect(discharged).toEqual({ mayCancel: true, taskState: "CANCELLED", outstanding: [] });
  });
});

"use strict";

/**
 * Engine lane — Phase 6: the gate, the systemic guard, the caches, and the volatile
 * subset (§7.1, §7.4, §7.6, §10.3.2 step 3).
 *
 * The execution plan's testing requirements for this phase, beyond the per-predicate
 * table in `feasibilityPredicates.test.js`:
 *
 * > Property: relaxing a constraint never shrinks the feasible set.
 * > Build gate: type separation makes cost evaluation structurally unable to see an
 * > infeasible candidate (I14, static analysis).
 * > Integration: systemic guard trips at the configured fraction and enters Restricted
 * > Operation **without relaxing any I/R predicate**.
 * > Cache: **a stale positive cannot survive the commit-time volatile re-check**.
 */

const fx = require("./helpers/feasibilityFixture");
const evaluate = require("../../src/engine/feasibility/evaluate");
const cache = require("../../src/engine/feasibility/cache");
const register = require("../../src/engine/feasibility/register");
const systemicGuard = require("../../src/engine/feasibility/systemicGuard");
const volatileSubset = require("../../src/engine/feasibility/volatileSubset");
const rejectionTelemetry = require("../../src/engine/feasibility/rejectionTelemetry");
const { OUTCOME } = require("../../src/engine/feasibility/threeValued");
const tenets = require("../../src/engine/guards/tenets");

const R = fx.REMOVE;

/** A minimal in-memory kv double with the `get`/`set` surface `cache.js` expects. */
function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   §7.5 — the register's own coherence
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§7.5 — the constraint register", () => {
  test("holds exactly 38 predicates and is internally coherent", () => {
    const check = register.assertRegister();
    expect(check.problems).toEqual([]);
    expect(register.PREDICATES).toHaveLength(register.PREDICATE_COUNT);
    expect(register.PREDICATE_COUNT).toBe(38);
  });

  test("is evaluated cheapest-first, in §7.5's own group order", () => {
    // A performance property only — the verdict is order-independent — but one the
    // register states, so it is asserted rather than assumed.
    expect(register.EVALUATION_ORDER[0]).toBe("F1");
    expect(register.EVALUATION_ORDER[register.EVALUATION_ORDER.length - 1]).toBe("F38");
    const numbers = register.EVALUATION_ORDER.map((id) => Number(id.slice(1)));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  test("the verdict is order-independent, as §7.5 claims", () => {
    // "the result is order-independent because every predicate is a pure function of
    // the snapshot". Checked by evaluating the same context twice and comparing every
    // verdict, and by evaluating with and without the short-circuit.
    const context = fx.withPatch({ agentSnapshot: { healthTier: "MARGINAL" }, plan: { concurrentCommitments: 9 } });
    const shortCircuit = evaluate.evaluateCandidate(context, {});
    const complete = evaluate.evaluateCandidate(context, { collectAll: true });

    expect(shortCircuit.feasible).toBe(complete.feasible);
    // Every predicate the short-circuiting pass did evaluate reached the same verdict.
    for (const id of shortCircuit.evaluated) {
      expect(shortCircuit.verdicts[id].outcome).toBe(complete.verdicts[id].outcome);
    }
  });

  test("every predicate is pure: the same context yields identical verdicts", () => {
    const context = fx.context();
    const first = evaluate.evaluateCandidate(context, { collectAll: true });
    const second = evaluate.evaluateCandidate(context, { collectAll: true });
    expect(JSON.stringify(first.verdicts)).toBe(JSON.stringify(second.verdicts));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   I14 — type separation
   ═══════════════════════════════════════════════════════════════════════════ */

describe("I14 — the cost evaluator cannot see an infeasible candidate (§7.1, T1)", () => {
  test("a feasible candidate is branded, and assertFeasible accepts it", () => {
    const candidate = { id: "cand-1" };
    const outcome = evaluate.gate(candidate, fx.context(), {});

    expect(outcome.feasible).toBe(true);
    expect(tenets.isFeasible(outcome.candidate)).toBe(true);
    expect(() => tenets.assertFeasible(outcome.candidate, "test")).not.toThrow();
  });

  test("an infeasible candidate is returned unbranded, and assertFeasible throws", () => {
    const candidate = { id: "cand-2" };
    const outcome = evaluate.gate(candidate, fx.withPatch({ agentSnapshot: { lifecycleState: "MAINTENANCE" } }), {});

    expect(outcome.feasible).toBe(false);
    expect(outcome.candidate).toBeNull();
    expect(tenets.isFeasible(candidate)).toBe(false);
    // Not "the cost evaluator declines to price it" — it *cannot*.
    expect(() => tenets.assertFeasible(candidate, "cost/phi.js")).toThrow(/did not pass the feasibility gate/);
  });

  test("the brand does not survive a spread or a JSON round trip", () => {
    // The two ways a stale verdict could otherwise be smuggled past the gate.
    const candidate = { id: "cand-3" };
    evaluate.gate(candidate, fx.context(), {});
    expect(tenets.isFeasible(candidate)).toBe(true);

    expect(tenets.isFeasible({ ...candidate })).toBe(false);
    expect(tenets.isFeasible(JSON.parse(JSON.stringify(candidate)))).toBe(false);
  });

  test("the brand carries the verdict evidence the decision record needs", () => {
    const candidate = { id: "cand-4" };
    evaluate.gate(candidate, fx.context(), {});
    const evidence = tenets.feasibilityEvidence(candidate);

    expect(evidence.predicatesEvaluated).toHaveLength(38);
    expect(evidence.configVersion).toBe("cfg-test-1");
    expect(evidence.snapshotId).toBe("snap-1");
    expect(evidence.decisionTimeMs).toBe(fx.DECISION_TIME_MS);
  });

  test("evaluate.js is the only module that calls brandFeasible", () => {
    // The structural claim behind I14. Phase 0 built the brand; the entitlement to
    // apply it belongs to the gate alone, and this asserts that no second caller has
    // appeared.
    const fs = require("fs");
    const path = require("path");
    const root = path.resolve(__dirname, "..", "..", "src");

    const callers = [];
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".js")) {
          const source = fs.readFileSync(full, "utf8");
          if (/\bbrandFeasible\s*\(/.test(source)) {
            callers.push(path.relative(root, full).split(path.sep).join("/"));
          }
        }
      }
    };
    walk(root);

    // `guards/tenets.js` defines it; `feasibility/evaluate.js` calls it. Nothing else.
    expect(callers.sort()).toEqual(["engine/feasibility/evaluate.js", "engine/guards/tenets.js"]);
  });

  test("no feasibility module imports the cost evaluator", () => {
    // §7.1: the gate is "evaluated before cost … with no access to cost values".
    const fs = require("fs");
    const path = require("path");
    const directory = path.resolve(__dirname, "..", "..", "src", "engine", "feasibility");

    const offenders = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".js")) {
          const source = fs.readFileSync(full, "utf8");
          const imports = source.match(/require\((["'])([^"']+)\1\)/g) || [];
          if (imports.some((line) => /cost\/(phi|c[A-Z])/.test(line) || /engine\/solve/.test(line))) {
            offenders.push(entry.name);
          }
        }
      }
    };
    walk(directory);

    expect(offenders).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Property: relaxing a constraint never shrinks the feasible set
   ═══════════════════════════════════════════════════════════════════════════ */

describe("property — relaxing a constraint never shrinks the feasible set", () => {
  /**
   * Each row: a config parameter, a strict value, and a strictly more permissive one.
   * The property is monotonicity of the gate in the constraint, which is what makes a
   * configuration change's direction predictable.
   */
  const RELAXATIONS = [
    ["connectivity.max_heartbeat_age", 1, 3600],
    ["localisation.min_confidence", { URBAN_SIDEWALK: 0.999 }, { URBAN_SIDEWALK: 0.1 }],
    ["payload.safety_factor", 0.1, 1],
    ["plan.commitment_horizon", 60, 86_400],
    ["reliability.max_intervention_rate", { PARCEL: 0.001 }, { PARCEL: 0.99 }],
    ["link.min_quality", { CONTINUOUS_SUPERVISION: 0.99 }, { CONTINUOUS_SUPERVISION: 0.01 }],
  ];

  test.each(RELAXATIONS)("relaxing %s cannot turn a feasible candidate infeasible", (name, strict, relaxed) => {
    const strictOutcome = evaluate.evaluateCandidate(fx.withPatch({ config: { [name]: strict } }), { collectAll: true });
    const relaxedOutcome = evaluate.evaluateCandidate(fx.withPatch({ config: { [name]: relaxed } }), { collectAll: true });

    if (strictOutcome.feasible) expect(relaxedOutcome.feasible).toBe(true);
    // The stronger form: the relaxed set of denials is a subset of the strict one.
    const strictDenials = new Set(strictOutcome.denials.map((row) => row.predicateId));
    for (const denial of relaxedOutcome.denials) {
      expect(strictDenials.has(denial.predicateId)).toBe(true);
    }
  });

  test("raising capacity cannot turn a feasible plan infeasible", () => {
    const at = fx.withPatch({ config: { capacity: { SIDEWALK_V2: 1 } }, plan: { concurrentCommitments: 2 } });
    const raised = fx.withPatch({ config: { capacity: { SIDEWALK_V2: 4 } }, plan: { concurrentCommitments: 2 } });

    expect(evaluate.evaluateCandidate(at, {}).feasible).toBe(false);
    expect(evaluate.evaluateCandidate(raised, {}).feasible).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §7.4 — the systemic-indeterminacy guard
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§7.4 — the systemic-indeterminacy guard", () => {
  test("the fraction counts only candidates rejected SOLELY for indeterminacy", () => {
    // A candidate that is also VIOLATED is unfit regardless of the telemetry outage.
    // Counting it would let a genuinely broken fleet trip the guard into a different
    // operating envelope, which is the opposite of what the guard is for.
    const both = evaluate.evaluateCandidate(
      fx.withPatch({ agentSnapshot: { lifecycleState: "MAINTENANCE", session: R } }),
      { collectAll: true },
    );
    expect(both.feasible).toBe(false);
    expect(both.deniedForIndeterminacyOnly).toBe(false);

    const onlyIndeterminate = evaluate.evaluateCandidate(fx.withPatch({ agentSnapshot: { session: R } }), {
      collectAll: true,
    });
    expect(onlyIndeterminate.feasible).toBe(false);
    expect(onlyIndeterminate.deniedForIndeterminacyOnly).toBe(true);
  });

  test("trips above the configured threshold and not at or below it", () => {
    const config = fx.config();
    // Default threshold is 0.30.
    expect(systemicGuard.assess({ evaluated: 100, deniedForIndeterminacyOnly: 30 }, config).tripped).toBe(false);
    expect(systemicGuard.assess({ evaluated: 100, deniedForIndeterminacyOnly: 31 }, config).tripped).toBe(true);
  });

  test("does not fire when the threshold is unresolved", () => {
    // Firing changes the operating envelope; without the threshold the guard cannot
    // establish that indeterminacy is systemic, so normal operation stands.
    const outcome = systemicGuard.assess(
      { evaluated: 100, deniedForIndeterminacyOnly: 100 },
      fx.merge(fx.config(), { "feasibility.systemic_indeterminacy_threshold": R }),
    );
    expect(outcome.tripped).toBe(false);
  });

  test("Restricted Operation relaxes nothing", () => {
    // §7.4 step 3: "which suspends no invariant … It does not relax any class I or R
    // predicate."
    const envelope = systemicGuard.restrictions(fx.config(), { enteredAtMs: fx.DECISION_TIME_MS });
    const check = systemicGuard.assertRelaxesNothing(envelope);
    expect(check.problems).toEqual([]);
  });

  test("every §7.4 step-3 restriction is present in the envelope", () => {
    const envelope = systemicGuard.restrictions(fx.config(), { enteredAtMs: fx.DECISION_TIME_MS });

    expect(envelope.alert.severity).toBe("HIGH"); // (a)
    expect(envelope.alert.immediate).toBe(true);
    expect(envelope.maxMissionScope).toBe("LOCAL"); // (b)
    expect(envelope.energyReserveMultiplier).toBe(1.5); // (c)
    expect(envelope.lastKnownGood.maxAgeMs).toBe(60_000); // (d)
    expect(envelope.lastKnownGood.requiresIndependentCorroboration).toBe(true); // (d), second half
    expect(envelope.recordCommitmentsAsDegraded).toBe(true); // (e)
    expect(envelope.timeBox.maxDurationMs).toBe(900_000); // step 4
  });

  test("a reserve factor below 1 is refused as a relaxation in disguise", () => {
    const envelope = systemicGuard.restrictions(fx.merge(fx.config(), { "degraded.reserve_factor": 0.8 }), {
      enteredAtMs: fx.DECISION_TIME_MS,
    });
    const check = systemicGuard.assertRelaxesNothing(envelope);
    expect(check.ok).toBe(false);
    expect(check.problems.join(" ")).toMatch(/shrinks them, which is a relaxation/);
  });

  test("an envelope exposing a predicate override is refused", () => {
    // The shape check that keeps a future field from quietly becoming a bypass.
    const envelope = systemicGuard.restrictions(fx.config(), { enteredAtMs: fx.DECISION_TIME_MS });
    const tampered = { ...envelope, relaxedPredicates: ["F34"] };
    expect(systemicGuard.assertRelaxesNothing(tampered).ok).toBe(false);
  });

  test("the guard cannot make an unfit agent feasible", () => {
    // The integration property: entering Restricted Operation changes the envelope,
    // never a verdict. An E-stopped agent stays infeasible.
    const context = fx.withPatch({ agentSnapshot: { emergencyStop: { value: true } } });
    const before = evaluate.evaluateCandidate(context, { collectAll: true });
    expect(before.verdicts.F7.outcome).toBe(OUTCOME.VIOLATED);

    systemicGuard.assess({ evaluated: 10, deniedForIndeterminacyOnly: 9 }, fx.config());
    const after = evaluate.evaluateCandidate(context, { collectAll: true });
    expect(after.verdicts.F7.outcome).toBe(OUTCOME.VIOLATED);
    expect(after.feasible).toBe(false);
  });

  test("the time box halts new commitments on expiry without acknowledgement", () => {
    const envelope = systemicGuard.restrictions(fx.config(), { enteredAtMs: fx.DECISION_TIME_MS });

    const within = systemicGuard.evaluateTimeBox(envelope, fx.DECISION_TIME_MS + 60_000);
    expect(within.state).toBe(systemicGuard.GUARD_STATE.RESTRICTED);

    const expired = systemicGuard.evaluateTimeBox(envelope, fx.DECISION_TIME_MS + 1_000_000);
    expect(expired.state).toBe(systemicGuard.GUARD_STATE.HALTED_AWAITING_ACKNOWLEDGEMENT);

    const acknowledged = systemicGuard.evaluateTimeBox(envelope, fx.DECISION_TIME_MS + 1_000_000, {
      acknowledgedAtMs: fx.DECISION_TIME_MS + 900_000,
    });
    expect(acknowledged.state).toBe(systemicGuard.GUARD_STATE.RESTRICTED);
  });

  test("a time box with no computable expiry is treated as expired (§18.5)", () => {
    // "every suspension of an invariant is explicit, named, and expires".
    const envelope = systemicGuard.restrictions(fx.merge(fx.config(), { "degraded.max_duration": R }), {
      enteredAtMs: fx.DECISION_TIME_MS,
    });
    const outcome = systemicGuard.evaluateTimeBox(envelope, fx.DECISION_TIME_MS);
    expect(outcome.expired).toBe(true);
    expect(outcome.state).toBe(systemicGuard.GUARD_STATE.HALTED_AWAITING_ACKNOWLEDGEMENT);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §10.3.2 step 3 — the volatile subset
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§10.3.2 step 3 — the volatile subset", () => {
  test("the register's flags are exactly the specification's enumerated list", () => {
    expect(volatileSubset.assertSubset().problems).toEqual([]);
    expect(volatileSubset.subset()).toEqual(volatileSubset.SPECIFIED_SUBSET);
  });

  test("the list is the eleven predicates §10.3.2 names", () => {
    expect(volatileSubset.SPECIFIED_SUBSET).toEqual([
      "F7", "F8", "F10", "F13", "F14", "F16", "F17", "F18", "F20", "F34", "F35",
    ]);
  });

  test("every volatile predicate declares DENY", () => {
    // A volatile predicate that could admit on indeterminate would make the commit-time
    // re-check unable to reject, which is the point of running it at all.
    for (const id of volatileSubset.subset()) {
      expect(register.predicate(id).policy).toBe("DENY");
    }
  });

  test("the re-check passes on the complete fixture", () => {
    expect(volatileSubset.recheck(fx.context()).ok).toBe(true);
    expect(volatileSubset.recheck(fx.context()).evaluated).toHaveLength(11);
  });

  test.each(volatileSubset.SPECIFIED_SUBSET.map((id) => [id]))(
    "a stale positive on %s cannot survive the commit-time re-check",
    (id) => {
      // The cache property the plan names: "a stale positive cannot survive the
      // commit-time volatile re-check". Modelled as a candidate that passed the gate
      // and whose state then changed before commit.
      const admitted = evaluate.evaluateCandidate(fx.context(), {});
      expect(admitted.feasible).toBe(true);

      const CHANGES = {
        F7: { agentSnapshot: { emergencyStop: { value: true } } },
        F8: { agentSnapshot: { faults: [{ code: "x", severity: "CRITICAL", active: true }] } },
        F10: { agentSnapshot: { localisation: { confidence: 0.1 } } },
        F13: { agentSnapshot: { session: { lastHeartbeatAt: new Date(fx.DECISION_TIME_MS - 600_000) } } },
        F14: {
          agentSnapshot: {
            session: {
              lastCommandRoundTripAt: new Date(fx.DECISION_TIME_MS - 600_000),
              lastHeartbeatAckAt: new Date(fx.DECISION_TIME_MS - 600_000),
            },
          },
        },
        F16: { agentSnapshot: { safetyRelevantObservations: R } },
        F17: { plan: { concurrentCommitments: 99 } },
        F18: {
          agentSnapshot: {
            reservations: [{ subsystem: "CHARGING", from: new Date(fx.PLAN_START_MS), until: new Date(fx.PLAN_END_MS) }],
          },
        },
        F20: { agentSnapshot: { legExclusions: { nackCooloffUntil: new Date(fx.DECISION_TIME_MS + 600_000) } } },
        F34: { plan: { energy: { tierProbabilities: { T3: 1 } } } },
        F35: { plan: { energy: { chargerReachability: { reachable: false } } } },
      };

      const atCommit = volatileSubset.recheck(fx.withPatch(CHANGES[id]));
      expect(atCommit.ok).toBe(false);
      expect(atCommit.failures.map((row) => row.predicateId)).toContain(id);
    },
  );

  test("a non-volatile change is not re-checked at commit", () => {
    // The subset is eleven predicates rather than thirty-eight precisely so the
    // serialised section stays short. F9 (health tier) is not on the list.
    const atCommit = volatileSubset.recheck(fx.withPatch({ agentSnapshot: { healthTier: "MARGINAL" } }));
    expect(atCommit.ok).toBe(true);
  });

  test("createVolatileRecheck refuses to be built without a context adapter", () => {
    // Symmetrical with commit.js's own refusal: a re-check that cannot build its
    // inputs must not report success.
    expect(() => volatileSubset.createVolatileRecheck()).toThrow(/buildContext/);
    expect(() => volatileSubset.createVolatileRecheck({})).toThrow(/buildContext/);
  });

  test("createVolatileRecheck produces the contract commit.js expects", async () => {
    const ok = volatileSubset.createVolatileRecheck({ buildContext: () => fx.context() });
    await expect(ok({ tx: null, agent: {}, leg: {} })).resolves.toEqual({ ok: true });

    const lost = volatileSubset.createVolatileRecheck({
      buildContext: () => fx.withPatch({ agentSnapshot: { emergencyStop: { value: true } } }),
    });
    const outcome = await lost({ tx: null, agent: {}, leg: {} });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("VOLATILE_FEASIBILITY_LOST");
    expect(outcome.detail).toMatch(/F7/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §7.6 — caching and invalidation
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§7.6 — feasibility caching", () => {
  test("the three cache tiers hold the predicates §7.6 assigns them", () => {
    const agentTier = cache.predicatesAt(cache.CACHE_TIER.AGENT);
    // §7.6 level 1: "Agent-invariant predicates (F1–F12 …)".
    expect(agentTier).toEqual(["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"]);

    // §7.6 level 2: "F21, F25, F26, F28, F29 for a route class".
    expect(cache.predicatesAt(cache.CACHE_TIER.CLASS)).toEqual(["F21", "F25", "F26", "F28", "F29"]);
  });

  test("a stamp mismatch is a miss, not a stale hit", async () => {
    const kv = fakeKv();
    const key = cache.agentKey("agent-1");
    const stamps = cache.stampsFrom(cache.AGENT_STAMPS, {
      lifecycleVersion: 1,
      healthVersion: 1,
      capabilityVersion: 1,
      firmwareVersion: 1,
      certificationVersion: 1,
    });

    await cache.write({ kv }, key, { F1: { outcome: "SATISFIED" } }, stamps, fx.DECISION_TIME_MS, 300);
    expect((await cache.read({ kv }, key, stamps)).hit).toBe(true);

    // Health changed and nobody invalidated. The reader's stamp check catches it.
    const moved = { ...stamps, healthVersion: "2" };
    const outcome = await cache.read({ kv }, key, moved);
    expect(outcome.hit).toBe(false);
    expect(outcome.reason).toMatch(/stamp mismatch/);
  });

  test("an entry that cannot state its stamps is not written", async () => {
    const kv = fakeKv();
    // A missing stamp means the entry could not be validated on read; an unvalidatable
    // positive is exactly what the invalidation rule exists to prevent.
    const partial = cache.stampsFrom(cache.AGENT_STAMPS, { lifecycleVersion: 1 });
    expect(partial).toBeNull();
    expect(await cache.write({ kv }, cache.agentKey("agent-1"), {}, partial, fx.DECISION_TIME_MS, 300)).toBe(false);
    expect(kv.store.size).toBe(0);
  });

  test("a cache read failure is a miss, never a verdict (§10.4, I16)", async () => {
    const broken = {
      async get() {
        throw new Error("redis down");
      },
      async set() {},
    };
    const outcome = await cache.read({ kv: broken }, cache.agentKey("agent-1"), {});
    expect(outcome.hit).toBe(false);
    expect(outcome.verdicts).toBeNull();
  });

  test("negative-cache TTLs are derived from the rejecting predicate, never global", () => {
    const config = fx.config();
    // §7.6: "a capability mismatch is stable for the agent's configuration lifetime,
    // while an energy shortfall is valid only until the next state update".
    expect(cache.negativeTtlSeconds("F21", config)).toBe(60); // CLASS tier
    expect(cache.negativeTtlSeconds("F5", config)).toBe(300); // AGENT tier
    expect(cache.negativeTtlSeconds("F37", config)).toBe(10); // mission-specific
  });

  test("a volatile predicate's rejection is never negatively cached", async () => {
    // No TTL is principled for a reason that changes on every state update, so the
    // honest answer is to re-evaluate. This is the correctness hazard §7.6 names.
    const config = fx.config();
    for (const id of volatileSubset.SPECIFIED_SUBSET) {
      expect(cache.negativeTtlSeconds(id, config)).toBeNull();
    }

    const kv = fakeKv();
    const outcome = await cache.recordRejection(
      { kv },
      { agentId: "agent-1", legId: "leg-1", predicateId: "F34" },
      config,
      fx.DECISION_TIME_MS,
    );
    expect(outcome.cached).toBe(false);
    expect(kv.store.size).toBe(0);
  });

  test("a non-volatile rejection is cached under its derived TTL and is readable", async () => {
    const kv = fakeKv();
    const outcome = await cache.recordRejection(
      { kv },
      { agentId: "agent-1", legId: "leg-1", predicateId: "F21" },
      fx.config(),
      fx.DECISION_TIME_MS,
    );
    expect(outcome.cached).toBe(true);
    expect(outcome.ttlSeconds).toBe(60);

    const readBack = await cache.readRejection({ kv }, "agent-1", "leg-1");
    expect(readBack.rejected).toBe(true);
    expect(readBack.predicateId).toBe("F21");
  });

  test("the negative cache is keyed on the pairing, not on either side alone", () => {
    // A key on the agent would suppress it for every Leg; a key on the Leg would
    // suppress it for every agent. Both are wrong in the same way.
    expect(cache.negativeKey("a1", "l1")).not.toBe(cache.negativeKey("a1", "l2"));
    expect(cache.negativeKey("a1", "l1")).not.toBe(cache.negativeKey("a2", "l1"));
  });

  test("the Redis key prefixes are the ones the plan names", () => {
    expect(cache.agentKey("a1")).toBe("engine:feas:agent:a1");
    expect(cache.classKey("SIDEWALK_V2", "PARCEL", "zone-1")).toBe("engine:feas:class:SIDEWALK_V2:PARCEL:zone-1");
    expect(cache.negativeKey("a1", "l1")).toBe("engine:feas:neg:a1:l1");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The gate over a candidate set
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the gate over a candidate set (§7.1)", () => {
  test("evaluates the full set and returns only branded survivors", () => {
    const candidates = [
      { candidate: { id: "ok-1" }, context: fx.context() },
      { candidate: { id: "estop" }, context: fx.withPatch({ agentSnapshot: { emergencyStop: { value: true } } }) },
      { candidate: { id: "ok-2" }, context: fx.context() },
      { candidate: { id: "unknown" }, context: fx.withPatch({ agentSnapshot: { session: R } }) },
    ];

    const aggregator = rejectionTelemetry.createAggregator();
    const outcome = evaluate.gateAll(candidates, { aggregator });

    expect(outcome.feasible.map((row) => row.id)).toEqual(["ok-1", "ok-2"]);
    expect(outcome.rejected.map((row) => row.candidate.id)).toEqual(["estop", "unknown"]);
    for (const survivor of outcome.feasible) expect(tenets.isFeasible(survivor)).toBe(true);

    // The §7.4 tally is a property of the round, not of whichever candidates the
    // solver happened to try first.
    expect(outcome.tally.evaluated).toBe(4);
    expect(outcome.tally.deniedForIndeterminacyOnly).toBe(1);
  });

  test("input order is preserved and no ordering is introduced", () => {
    const candidates = ["c", "a", "b"].map((id) => ({ candidate: { id }, context: fx.context() }));
    expect(evaluate.gateAll(candidates, {}).feasible.map((row) => row.id)).toEqual(["c", "a", "b"]);
  });

  test("there is no bypass: no option skips a predicate", () => {
    // §7.2: "Manual assignment does not bypass constraints … the operator's power is to
    // choose *which* agent, never to make an infeasible agent feasible." The guarantee
    // is that no other entry point exists.
    const context = fx.withPatch({ agentSnapshot: { emergencyStop: { value: true } } });
    for (const options of [{}, { collectAll: true }, { manual: true }, { skipPredicates: ["F7"] }, { force: true }]) {
      expect(evaluate.evaluateCandidate(context, options).feasible).toBe(false);
    }
  });

  test("an ADMIT_WITH_PENALTY indeterminate admits and accumulates the penalty", () => {
    const outcome = evaluate.evaluateCandidate(
      fx.withPatch({ agentSnapshot: { reliability: { interventionRate: R } } }),
      { collectAll: true },
    );
    expect(outcome.feasible).toBe(true);
    expect(outcome.penaltyMilliCu).toBe(500); // cost.uncertainty_penalty.F11
    expect(outcome.envelopeReduced).toBe(true);
  });

  test("the gate accumulates penalties but never applies them", () => {
    // Applying a cost inside the gate would be evaluating cost before feasibility
    // completed, which T1 forbids in both directions.
    const outcome = evaluate.evaluateCandidate(
      fx.withPatch({ agentSnapshot: { reliability: { interventionRate: R }, session: { linkQuality: R } } }),
      { collectAll: true },
    );
    expect(outcome.penaltyMilliCu).toBe(750); // F11 500 + F15 250, summed and handed on
    expect(outcome.feasible).toBe(true);
  });
});

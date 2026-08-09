"use strict";

/**
 * Engine lane — Phase 12: the Invariant Checker (§26).
 *
 * §26.1's constraint on this module is unusual and it is the constraint most of these tests
 * are about: the checker "runs independently of the code paths that maintain them — a
 * checker sharing logic with the enforcer verifies nothing". So the suite checks three
 * things in roughly equal measure:
 *
 *   1. **Independence**, by source scan. No enforcing module is imported, and the module
 *      performs no writes at all.
 *   2. **Detection**, by planting one defect at a time into an otherwise healthy world and
 *      asserting that exactly the invariant that governs it turns `VIOLATED`. A check that
 *      cannot fail is not a check, which is the same argument the gate self-tests make.
 *   3. **Status resolution**, by driving the same defect under a mode that suspends the
 *      invariant and asserting `SUSPENDED` rather than `VIOLATED` — the specific
 *      distinction §26.1 says the third status exists for.
 */

const fs = require("fs");
const path = require("path");

const invariantChecker = require("../../src/engine/observability/invariantChecker");
const modeRegister = require("../../src/engine/degraded/modeRegister");
const legMachine = require("../../src/engine/lifecycle/legMachine");
const supervisionLeases = require("../../src/engine/supervision/leases");
const { memoryStore, healthyWorld, checkContext } = require("./helpers/degradedFixture");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const SOURCE = fs.readFileSync(path.join(BACKEND_ROOT, "src", "engine", "observability", "invariantChecker.js"), "utf8");

const NOW = 1770000000000;

/**
 * Run the whole pass against a world, optionally mutated.
 *
 * @param {(store: object) => void} [mutate]
 * @param {object} [context]
 * @returns {Promise<object>}
 */
async function run(mutate, context) {
  const prisma = memoryStore(healthyWorld({ nowMs: NOW }));
  if (mutate) mutate(prisma.__store);
  return invariantChecker.checkAll({ prisma }, checkContext({ nowMs: NOW, ...(context || {}) }));
}

/**
 * @param {object} outcome
 * @param {string} invariantId
 * @returns {object}
 */
function of(outcome, invariantId) {
  return outcome.results.find((row) => row.invariantId === invariantId);
}

describe("independence from the enforcing code paths (§26.1)", () => {
  test("imports no enforcing module", () => {
    // The property §26.1 states, checked over the import list rather than trusted. A
    // checker that called `commitment/guards.js` to decide whether I1 holds would be
    // asking the enforcer whether it enforced.
    const imports = [...SOURCE.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
    expect(imports).toEqual(["../degraded/modeRegister"]);

    for (const forbidden of ["commitment/", "supervision/", "dispatch/", "lifecycle/", "intake/", "solve/", "candidates/", "feasibility/"]) {
      expect({ forbidden, imported: imports.some((name) => name.includes(forbidden)) }).toEqual({ forbidden, imported: false });
    }
  });

  test("performs no writes — the checker reports and the worker repairs", () => {
    // A checker that shared a pass with a repair loop could paper over the divergence it
    // exists to report.
    for (const write of [".create(", ".createMany(", ".update(", ".updateMany(", ".upsert(", ".delete(", ".deleteMany("]) {
      expect({ write, present: SOURCE.includes(write) }).toEqual({ write, present: false });
    }
  });

  test("reads no clock", () => {
    // Time is supplied. A check run against a worker's clock and one run against the
    // store's disagree about lease expiry by exactly the skew between them (§10.6).
    for (const source of ["Date.now(", "new Date()", "Math.random("]) {
      expect({ source, present: SOURCE.includes(source) }).toEqual({ source, present: false });
    }
  });

  test("re-declares the §4.3 state vocabulary, and it agrees with the domain model", () => {
    // Independence at runtime, drift detection at build time.
    expect(
      invariantChecker.assertVocabularyAgreesWithDomain({
        TERMINAL_LEG_STATES: legMachine.TERMINAL_LEG_STATES,
        RECOVERY_STATES: supervisionLeases.RECOVERY_STATES,
        STRANDED_STATES: ["STRANDED_SAFE", "STRANDED_OBSTRUCTING"],
      }),
    ).toEqual({ ok: true, problems: [] });
  });

  test("every one of §26.1's twenty-two invariants has a check, and no check invents a twenty-third", () => {
    expect(invariantChecker.assertEveryInvariantIsChecked()).toEqual({ ok: true, problems: [] });
    expect(Object.keys(invariantChecker.CHECKS)).toHaveLength(22);
  });
});

describe("a healthy world reports ENFORCED across the register", () => {
  test("all twenty-two, with no violations and a healthy checker", () => {
    return run().then((outcome) => {
      const notEnforced = outcome.results.filter((row) => row.status !== invariantChecker.STATUS.ENFORCED);
      expect(notEnforced.map((row) => `${row.invariantId}:${row.status}:${row.checkError || ""}`)).toEqual([]);
      expect(outcome.summary.invariantViolations).toBe(0);
      expect(outcome.summary.checkerHealthy).toBe(true);
      expect(outcome.summary.pageWorthy).toBe(false);
    });
  });

  test("every check names the instrument §26.1 gives it", () => {
    return run().then((outcome) => {
      for (const row of outcome.results) {
        expect({ id: row.invariantId, instrument: Boolean(row.instrument) }).toEqual({ id: row.invariantId, instrument: true });
      }
    });
  });
});

describe("each check detects the defect it governs", () => {
  test("I1 — a second active commitment on a capacity-1 agent", async () => {
    const outcome = await run((store) => {
      store.commitment.push({
        id: "commitment-2",
        commitmentId: "CMT-2",
        agentId: "agent-1",
        legId: "leg-1",
        kind: "HARD",
        fence: 8n,
        leaseExpiry: new Date(NOW + 60000),
        releasedAt: null,
        decisionRef: "shard-a:1:LEG-1",
        grantedAt: new Date(NOW - 1000),
      });
    });
    expect(of(outcome, "I1").status).toBe(invariantChecker.STATUS.VIOLATED);
    expect(of(outcome, "I1").violations[0]).toMatchObject({ agentId: "agent-1", held: 2, capacity: 1 });
  });

  test("I2 — an expired lease whose Leg is not in a recovery state", async () => {
    const outcome = await run((store) => {
      store.commitment[0].leaseExpiry = new Date(NOW - 1000);
    });
    expect(of(outcome, "I2").status).toBe(invariantChecker.STATUS.VIOLATED);
    expect(of(outcome, "I2").violations[0].commitmentId).toBe("CMT-1");
  });

  test("I2 — an expired lease whose Leg *is* recovering is not a violation", async () => {
    // I2 reads "has a valid lease **or is in a recovery state**", and the recovery is what
    // the expiry was supposed to produce.
    const outcome = await run((store) => {
      store.commitment[0].leaseExpiry = new Date(NOW - 1000);
      store.leg[0].state = "REASSIGNING";
    });
    expect(of(outcome, "I2").status).toBe(invariantChecker.STATUS.ENFORCED);
  });

  test("I3 — a non-terminal Leg with no commitment, no queue entry, and no SOFT reservation", async () => {
    const outcome = await run((store) => {
      store.commitment.length = 0;
    });
    expect(of(outcome, "I3").status).toBe(invariantChecker.STATUS.VIOLATED);
  });

  test("I3 — a PLANNED orphan is counted separately from a defect orphan", async () => {
    const outcome = await run((store) => {
      store.commitment.length = 0;
      store.leg[0].state = "PLANNED";
    });
    expect(of(outcome, "I3").detail).toMatch(/0 defect orphans, 1 PLANNED orphans/);
  });

  test("I3 — a SOFT reservation in the leader's plan state satisfies the third arm", async () => {
    const outcome = await run(
      (store) => {
        store.commitment.length = 0;
        store.leg[0].state = "PLANNED";
      },
      { softReservedLegIds: ["LEG-1"] },
    );
    expect(of(outcome, "I3").status).toBe(invariantChecker.STATUS.ENFORCED);
  });

  test("I4 — a non-terminal Leg with no pending timer, and a timer keyed on a stale version", async () => {
    const missing = await run((store) => {
      store.timer.length = 0;
    });
    expect(of(missing, "I4").violations[0]).toMatchObject({ legId: "LEG-1", problem: "NO_PENDING_TIMER" });

    const stale = await run((store) => {
      store.timer[0].entityVersion = 2n;
    });
    expect(of(stale, "I4").violations[0].problem).toBe("TIMER_VERSION_STALE");
  });

  test("I4 — a timer keyed on an agent-level counter is caught by name", async () => {
    // §4.5's revised keying: an agent-scope key means any unrelated commit on that agent
    // invalidates this timer, silently removing supervision from a mission that is fine.
    const outcome = await run((store) => {
      store.timer.push({
        id: "timer-2",
        timerKey: "AGENT:agent-1:x:2:handler",
        entityType: "AGENT",
        entityId: "agent-1",
        state: "x",
        entityVersion: 2n,
        timerState: "PENDING",
        dueAt: new Date(NOW + 1000),
      });
    });
    const problems = of(outcome, "I4").violations.map((row) => row.problem);
    expect(problems).toContain("TIMER_KEYED_ON_UNPERMITTED_ENTITY");
  });

  test("I5 — a rising fence-rejection baseline, not a non-zero count", async () => {
    // A rejection is the mechanism *working*. §26.1's instrument is "neither may have a
    // rising baseline", so a steady count is enforced and a rise is the violation.
    const seed = (store) => {
      store.outbox.push({
        id: "ob-1",
        idempotencyKey: "k1",
        agentId: "agent-1",
        command: "OFFER",
        fenceScope: "MISSION",
        state: "FAILED",
        lastError: "FENCE_SUPERSEDED",
        updatedAt: new Date(NOW - 1000),
      });
    };

    const steady = await run(seed, { previousFenceRejections: { MISSION: 1 } });
    expect(of(steady, "I5").status).toBe(invariantChecker.STATUS.ENFORCED);

    const rising = await run(seed, { previousFenceRejections: { MISSION: 0 } });
    expect(of(rising, "I5").status).toBe(invariantChecker.STATUS.VIOLATED);
    expect(of(rising, "I5").violations[0]).toEqual({ scope: "MISSION", previous: 0, current: 1 });
  });

  test("I6 — a fence counter that went backwards against the checker's own mark", async () => {
    const marks = new Map([["AGT-001", { fence: "9", epoch: "2" }]]);
    const outcome = await run(undefined, { highWaterMarks: marks });
    expect(of(outcome, "I6").status).toBe(invariantChecker.STATUS.VIOLATED);
    expect(of(outcome, "I6").violations[0]).toEqual({
      agentId: "AGT-001",
      counter: "fence_counter",
      highWater: "9",
      observed: "7",
    });
  });

  test("I6 — the returned marks advance and never retreat", async () => {
    const marks = new Map([["AGT-001", { fence: "9", epoch: "1" }]]);
    const outcome = await run(undefined, { highWaterMarks: marks });
    // The mark stays at 9 despite observing 7 — writing the observation would advance past
    // the regression and make the next pass report the fleet as monotone.
    expect(of(outcome, "I6").highWaterMarks.get("AGT-001")).toEqual({ fence: "9", epoch: "2" });
  });

  test("I7 — custody HELD with no active commitment: the agent was released holding goods", async () => {
    const outcome = await run((store) => {
      store.leg[0].custodyState = "HELD";
      store.commitment[0].releasedAt = new Date(NOW - 100);
    });
    expect(of(outcome, "I7").status).toBe(invariantChecker.STATUS.VIOLATED);
    expect(of(outcome, "I7").violations[0].severity).toBe("HIGHEST");
    expect(of(outcome, "I7").detail).toMatch(/highest-severity alert/);
  });

  test("I8 — custody HELD with two accountable parties is as much a violation as none", async () => {
    const outcome = await run((store) => {
      store.leg[0].custodyState = "HELD";
      store.commitment.push({ ...store.commitment[0], id: "commitment-2", commitmentId: "CMT-2", fence: 8n });
    });
    expect(of(outcome, "I8").violations[0].problem).toBe("MORE_THAN_ONE_ACCOUNTABLE_PARTY");
  });

  test("I9 — an ASSIGNED decision whose chosen candidate had a binding predicate", async () => {
    const outcome = await run((store) => {
      store.decisionRecordA[0].outcome = { action: "ASSIGNED", chosenBindingPredicateId: "F34" };
    });
    expect(of(outcome, "I9").status).toBe(invariantChecker.STATUS.VIOLATED);
    expect(of(outcome, "I9").violations[0].bindingPredicateId).toBe("F34");
  });

  test("I10 — a commitment with a dangling or absent decision reference", async () => {
    const dangling = await run((store) => {
      store.commitment[0].decisionRef = "shard-a:1:NOPE";
    });
    expect(of(dangling, "I10").violations[0].problem).toBe("DANGLING_DECISION_REFERENCE");

    const absent = await run((store) => {
      store.commitment[0].decisionRef = null;
    });
    expect(of(absent, "I10").violations[0].problem).toBe("NO_DECISION_REFERENCE");
  });

  test("I11 — both clauses: a cancelled PRIMARY Leg executing, and a cancelled Task with an unsettled custodial Leg", async () => {
    const executing = await run((store) => {
      store.leg[0].cancelRequestedAt = new Date(NOW - 5000);
    });
    expect(of(executing, "I11").violations[0].problem).toBe("CANCELLED_PRIMARY_LEG_IN_EXECUTION");

    // Stating I11 over execution alone "would forbid the recovery the design mandates", so
    // the second clause is checked separately.
    const undischarged = await run((store) => {
      store.task[0].status = "CANCELLED";
      store.leg.push({
        id: "leg-2",
        legId: "LEG-2",
        missionId: "mission-1",
        purpose: "RECOVERY",
        state: "EN_ROUTE_PICKUP",
        custodyState: "HELD",
        version: 1,
        cancelRequestedAt: null,
        updatedAt: new Date(NOW),
      });
    });
    expect(of(undischarged, "I11").violations.some((row) => row.problem === "TASK_CANCELLED_WITH_UNSETTLED_CUSTODIAL_LEG")).toBe(true);
  });

  test("I12 — a terminal row whose version moved between two passes", async () => {
    const outcome = await run(
      (store) => {
        store.leg[0].state = "SETTLED";
        store.leg[0].version = 9;
        store.leg[0].updatedAt = new Date(NOW - 100);
      },
      { terminalVersionMarks: new Map([["LEG-1", "8"]]) },
    );
    expect(of(outcome, "I12").violations[0].problem).toBe("TERMINAL_ROW_MODIFIED");
  });

  test("I13 — a queue entry past the ladder budget that no round has ever considered", async () => {
    const outcome = await run((store) => {
      store.workQueue.push({
        id: "wq-1",
        legId: "leg-9",
        shardId: "shard-a",
        state: "QUEUED",
        roundsConsidered: 0,
        enqueuedAt: new Date(NOW - 7200000),
      });
    });
    expect(of(outcome, "I13").violations[0].problem).toBe("QUEUED_PAST_LADDER_BUDGET_AND_NEVER_CONSIDERED");
  });

  test("I13 — an entry that has been considered is progressing, badly but visibly", async () => {
    const outcome = await run((store) => {
      store.workQueue.push({
        id: "wq-1",
        legId: "leg-9",
        shardId: "shard-a",
        state: "QUEUED",
        roundsConsidered: 14,
        enqueuedAt: new Date(NOW - 7200000),
      });
    });
    expect(of(outcome, "I13").status).toBe(invariantChecker.STATUS.ENFORCED);
  });

  test("I14 — a cost recorded for a candidate the gate rejected", async () => {
    const outcome = await run((store) => {
      store.decisionRecordA[0].runnerUpAndTopN = [{ agentId: "AGT-003", gammaMilliCU: "90000", bindingPredicateId: "F12" }];
    });
    expect(of(outcome, "I14").violations[0].problem).toBe("COST_RECORDED_FOR_REJECTED_CANDIDATE");
  });

  test("I15 — a decision with no resolved config version", async () => {
    const outcome = await run((store) => {
      store.decisionRecordA[0].versions = {};
    });
    expect(of(outcome, "I15").violations[0].problem).toBe("NO_RESOLVED_CONFIG_VERSION");
  });

  test("I16 — two active commitments on one Leg is a double grant", async () => {
    const outcome = await run((store) => {
      store.commitment.push({ ...store.commitment[0], id: "commitment-2", commitmentId: "CMT-2", agentId: "agent-2", fence: 1n });
    });
    expect(of(outcome, "I16").violations[0].problem).toBe("LEG_DOUBLE_GRANTED");
  });

  test("I17 — T1 and T2 are scored against their budgets; T3 is deliberately not scored at all", async () => {
    const outcome = await run(
      (store) => {
        for (let n = 0; n < 3; n += 1) {
          store.calibrationObservation.push({
            id: `co-${n}`,
            predictor: "ENERGY_SHORTFALL",
            tier: "T2",
            eventOccurred: true,
            observedAt: new Date(NOW - 1000),
          });
        }
        // A T3 event, which must not be scored by a count at any budget.
        store.calibrationObservation.push({
          id: "co-t3",
          predictor: "ENERGY_SHORTFALL",
          tier: "T3",
          eventOccurred: true,
          observedAt: new Date(NOW - 1000),
        });
      },
      { tierEventBudgets: { T1: 100, T2: 2, T3: 0 } },
    );

    expect(of(outcome, "I17").status).toBe(invariantChecker.STATUS.VIOLATED);
    expect(of(outcome, "I17").violations.map((row) => row.tier)).toEqual(["T2"]);
    // Even with a T3 budget of zero and a T3 event observed, T3 produces no violation:
    // "validating a 1e-7 target by counting its occurrences is a category error".
    expect(of(outcome, "I17").detail).toMatch(/T3 is deliberately not scored by an event count/);
  });

  test("I18 — a SOFT reservation persisted to the Commitment Store", async () => {
    const outcome = await run((store) => {
      store.commitment.push({ ...store.commitment[0], id: "commitment-2", commitmentId: "CMT-2", kind: "SOFT" });
    });
    expect(of(outcome, "I18").violations[0].problem).toBe("SOFT_RESERVATION_PERSISTED");
    expect(of(outcome, "I18").violations[0].detail).toMatch(/invalidates the shard-sizing derivation of §3.5/);
  });

  test("I19 — two commitments on one agent sharing a mission fence", async () => {
    const outcome = await run((store) => {
      store.commitment.push({ ...store.commitment[0], id: "commitment-2", commitmentId: "CMT-2", legId: "leg-2", fence: 7n });
    });
    expect(of(outcome, "I19").violations[0].problem).toBe("SHARED_MISSION_FENCE_ACROSS_COMMITMENTS");
  });

  test("I20 — a combined gap, or a negative one", async () => {
    const combined = await run((store) => {
      store.decisionRecordA[0].searchAndSolveBounds = { combinedGapMilliCU: "500" };
    });
    expect(combined.results.find((row) => row.invariantId === "I20").violations[0].problem).toBe("COMBINED_GAP_REPORTED");

    const negative = await run((store) => {
      store.decisionRecordA[0].searchAndSolveBounds = { searchGapMilliCU: "-1" };
    });
    expect(negative.results.find((row) => row.invariantId === "I20").violations[0].problem).toBe("NEGATIVE_GAP_REPORTED");
  });

  test("I21 — an agent-reported duplicate application, with the dedup advance rate as a signal beside it", async () => {
    const outcome = await run((store) => {
      store.outbox.push({
        id: "ob-2",
        idempotencyKey: "k2",
        agentId: "agent-1",
        command: "OFFER",
        fenceScope: "MISSION",
        state: "ACKED",
        lastError: "DUPLICATE_APPLICATION reported at handshake",
        updatedAt: new Date(NOW - 500),
      });
      store.agentDedupState.push({ id: "ads-1", agentId: "agent-1", dedupStateGeneration: 3n, updatedAt: new Date(NOW - 200) });
    });
    expect(of(outcome, "I21").status).toBe(invariantChecker.STATUS.VIOLATED);
    expect(of(outcome, "I21").violations[0].problem).toBe("COMMAND_APPLIED_MORE_THAN_ONCE");
    // A generation advance is A20's monitored signal, not an I21 violation.
    expect(of(outcome, "I21").detail).toMatch(/1 dedup states advanced/);
  });

  test("I22 — both clauses, including the missing escalation path", async () => {
    const unclassified = await run((store) => {
      store.leg[0].state = "STRANDED_SAFE";
      store.leg[0].obstructionClass = null;
    });
    expect(of(unclassified, "I22").violations[0].problem).toBe("STRANDED_LEG_WITH_NO_CLASSIFICATION");

    const misrouted = await run((store) => {
      store.leg[0].state = "STRANDED_SAFE";
      store.leg[0].obstructionClass = "BLOCKING_CRITICAL";
    });
    expect(of(misrouted, "I22").violations[0].problem).toBe("OBSTRUCTING_STRANDING_HELD_IN_ORDINARY_QUEUE");

    const unescalated = await run((store) => {
      store.leg[0].state = "STRANDED_OBSTRUCTING";
      store.leg[0].obstructionClass = "BLOCKING_CRITICAL";
    });
    expect(of(unescalated, "I22").violations[0].problem).toBe("OBSTRUCTING_STRANDING_WITH_NO_ESCALATION_CHAIN");

    const escalated = await run((store) => {
      store.leg[0].state = "STRANDED_OBSTRUCTING";
      store.leg[0].obstructionClass = "BLOCKING_CRITICAL";
      store.externalEscalation.push({ id: "ee-1", legId: "leg-1", step: 1, disposition: "EMITTED", clearedAt: null, occurredAt: new Date(NOW) });
    });
    expect(of(escalated, "I22").status).toBe(invariantChecker.STATUS.ENFORCED);
  });
});

describe("status resolution against §26.2", () => {
  test("I2's violation reports SUSPENDED under Custodial Operation, not VIOLATED", async () => {
    // The exact distinction §26.1 says the third status exists for: "a routine Commitment
    // Store outage would report every active commitment in the shard as violating I2 for
    // the outage's entire duration, against a target of zero".
    const outcome = await run(
      (store) => {
        store.commitment[0].leaseExpiry = new Date(NOW - 1000);
      },
      { activeModes: [modeRegister.MODE.CUSTODIAL_OPERATION] },
    );

    const i2 = of(outcome, "I2");
    expect(i2.status).toBe(invariantChecker.STATUS.SUSPENDED);
    expect(i2.authorisedBy).toBe(modeRegister.MODE.CUSTODIAL_OPERATION);
    // The findings survive the suspension: on mode exit they are the reconciliation input.
    expect(i2.violationCount).toBeGreaterThan(0);
    // And the suspension is not counted as a violation by the SLI.
    expect(outcome.summary.invariantViolations).toBe(0);
    expect(outcome.summary.pageWorthy).toBe(false);
  });

  test("I4's violation reports SUSPENDED under Unsupervised Commitment", async () => {
    const outcome = await run(
      (store) => {
        store.timer.length = 0;
      },
      { activeModes: [modeRegister.MODE.UNSUPERVISED_COMMITMENT] },
    );
    expect(of(outcome, "I4").status).toBe(invariantChecker.STATUS.SUSPENDED);
    expect(of(outcome, "I4").authorisedBy).toBe(modeRegister.MODE.UNSUPERVISED_COMMITMENT);
  });

  test("a `D` cell still verifies, and records the degradation rather than suppressing the status", () => {
    // §26.2's `D` is "enforced but verified at degraded latency or granularity, **with the
    // degradation recorded**" — a checker that short-circuited on any non-`E` cell would
    // silently stop verifying eleven live guarantees.
    return run(
      (store) => {
        store.commitment[0].leaseExpiry = new Date(NOW - 1000);
      },
      { activeModes: [modeRegister.MODE.UNSUPERVISED_COMMITMENT] },
    ).then((outcome) => {
      const i2 = of(outcome, "I2");
      expect(i2.status).toBe(invariantChecker.STATUS.VIOLATED);
      expect(i2.degradedVerification).toBe(true);
      expect(i2.degradationNote).toMatch(/reconciler sweep rather than timer/);
    });
  });

  test("a safety invariant is never suspended, whatever modes are open", async () => {
    const outcome = await run(
      (store) => {
        store.leg[0].custodyState = "HELD";
        store.commitment[0].releasedAt = new Date(NOW - 100);
      },
      { activeModes: [...modeRegister.MODE_NAMES] },
    );
    expect(of(outcome, "I7").status).toBe(invariantChecker.STATUS.VIOLATED);
    expect(outcome.summary.pageWorthy).toBe(true);
  });

  test("a vacuous cell is marked as such — the guarantee returns on mode exit rather than needing repair", async () => {
    const outcome = await run(undefined, { activeModes: [modeRegister.MODE.CUSTODIAL_OPERATION] });
    expect(of(outcome, "I1").vacuous).toBe(true);
    expect(of(outcome, "I1").vacuousNote).toMatch(/holds vacuously/);
  });
});

describe("a check that could not run", () => {
  test("reports neither ENFORCED nor VIOLATED, and marks the checker unhealthy", async () => {
    // A green register produced by a broken query is indistinguishable from a healthy
    // system and strictly worse than no register.
    const prisma = memoryStore(healthyWorld({ nowMs: NOW }));
    prisma.commitment.groupBy = async () => {
      throw new Error("connection terminated");
    };

    const outcome = await invariantChecker.checkAll({ prisma }, checkContext({ nowMs: NOW }));
    const i1 = of(outcome, "I1");
    expect(i1.status).toBeNull();
    expect(i1.checkError).toMatch(/connection terminated/);
    expect(outcome.summary.checkerHealthy).toBe(false);
    // Two, not one: I1 and I16 both count commitments by `groupBy`, so one broken query
    // takes both checks out. That the *count* is right matters more than which — the
    // summary's job is to distinguish "nothing is wrong" from "we did not look", and it
    // must not under-report how much was not looked at.
    expect(outcome.summary.unchecked).toBe(2);
    expect(of(outcome, "I16").status).toBeNull();
    // The other twenty ran normally: one failed query does not fail the pass.
    expect(outcome.summary.ENFORCED).toBe(20);
  });
});

describe("status changes", () => {
  test("only transitions are emitted, and each names the mode that authorised it", () => {
    const previous = [{ invariantId: "I2", status: "ENFORCED" }, { invariantId: "I7", status: "ENFORCED" }];
    const current = [
      { invariantId: "I2", status: "SUSPENDED", authorisedBy: "CUSTODIAL_OPERATION", violationCount: 3, instrument: "x" },
      { invariantId: "I7", status: "ENFORCED", authorisedBy: null, violationCount: 0, instrument: "y" },
    ];

    const changes = invariantChecker.statusChanges(previous, current);
    expect(changes).toHaveLength(1);
    expect(changes[0].event).toBe("INVARIANT_STATUS_CHANGED");
    expect(changes[0].payload).toMatchObject({ invariantId: "I2", from: "ENFORCED", to: "SUSPENDED", authorisedBy: "CUSTODIAL_OPERATION" });
  });

  test("an invariant reported for the first time is a change from null", () => {
    const changes = invariantChecker.statusChanges([], [{ invariantId: "I1", status: "ENFORCED", violationCount: 0, instrument: "x" }]);
    expect(changes[0].payload.from).toBeNull();
  });
});

describe("the violation list is bounded", () => {
  test("one defect cannot flood a page, and the count stays honest", async () => {
    const outcome = await run((store) => {
      for (let n = 0; n < 120; n += 1) {
        store.leg.push({
          id: `leg-x${n}`,
          legId: `LEG-X${n}`,
          missionId: "mission-1",
          purpose: "PRIMARY",
          state: "STRANDED_SAFE",
          custodyState: "NONE",
          obstructionClass: null,
          version: 1,
          cancelRequestedAt: null,
          updatedAt: new Date(NOW),
        });
      }
    });

    const i22 = of(outcome, "I22");
    expect(i22.violationCount).toBe(120);
    expect(i22.violations).toHaveLength(invariantChecker.MAX_REPORTED_VIOLATIONS);
  });
});

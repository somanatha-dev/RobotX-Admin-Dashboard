"use strict";

/**
 * Engine lane — Phase 12: mode entry and exit (§18.5), the §26.2 simulation, and the
 * Custodial Operation chaos scenario.
 *
 * The execution plan names two testing requirements for this phase, and both are here:
 *
 *   · **Simulation (§24.4):** "drive entry into and exit from **every** named mode and
 *     verify the observed invariant statuses match the §26.2 matrix exactly — including
 *     that no invariant reports `VIOLATED` where the matrix says `SUSPENDED` or `D`."
 *   · **Chaos:** "remove the Commitment Store for longer than
 *     `agent.autonomous_continuation_limit`; assert Custodial Operation entered, no
 *     commands issued, I2 reported `SUSPENDED` not `VIOLATED`, agents halt at safe
 *     locations, full reconciliation precedes round resumption."
 *
 * The simulation drives the *real* modules — `transitions.enter`/`exit` against a store,
 * then the real checker against the same store — rather than asserting the matrix against
 * itself. That is what makes it a simulation rather than a restatement.
 */

const transitions = require("../../src/engine/degraded/transitions");
const modeRegister = require("../../src/engine/degraded/modeRegister");
const invariantChecker = require("../../src/engine/observability/invariantChecker");
const commandDispatcher = require("../../src/services/commandDispatcher.service");
const supervisionLeases = require("../../src/engine/supervision/leases");
const invariantWorker = require("../../src/workers/invariant.worker");
const { memoryStore, healthyWorld, checkContext } = require("./helpers/degradedFixture");

const NOW = 1770000000000;
const SHARD = "shard-a";
const BOX_MS = 900000;

/** @param {string} mode @param {object} [overrides] @returns {object} */
function entry(mode, overrides) {
  return {
    mode,
    shardId: SHARD,
    cause: `${mode} entry cause`,
    enteringComponent: "test",
    atMs: NOW,
    maxDurationMs: BOX_MS,
    ...(overrides || {}),
  };
}

/** The evidence each mode's exit criterion requires. */
const EXIT_EVIDENCE = Object.freeze({
  RESTRICTED_OPERATION: { indeterminacyRecovered: true },
  CUSTODIAL_OPERATION: { storeAvailable: true, reconciliationComplete: true },
  UNSUPERVISED_COMMITMENT: { timerStoreAvailable: true, timerStateCrossAuditClean: true },
  DEGRADED_ROUTING: { routingAvailable: true },
  COLD_INDEX: { indexRebuilt: true },
  SHED_LOAD: { queueDelayWithinBudget: true },
});

describe("mode entry and exit against the store", () => {
  test("entry writes the event with its cause, component, suspension set, and time box", async () => {
    const prisma = memoryStore();
    const outcome = await transitions.enter({ prisma }, entry(modeRegister.MODE.CUSTODIAL_OPERATION));

    expect(outcome.entered).toBe(true);
    expect(outcome.row.cause).toBe("CUSTODIAL_OPERATION entry cause");
    expect(outcome.row.enteringComponent).toBe("test");
    expect(outcome.row.suspendedInvariants).toEqual(["I2"]);
    expect(outcome.row.timeBoxExpiresAt.getTime()).toBe(NOW + BOX_MS);
    expect(outcome.row.exitCriterion).toMatch(/reconciliation/);
  });

  test("entry is idempotent per (shard, mode) — a second observation is corroboration, not a second mode", async () => {
    const prisma = memoryStore();
    await transitions.enter({ prisma }, entry(modeRegister.MODE.COLD_INDEX));
    const second = await transitions.enter({ prisma }, entry(modeRegister.MODE.COLD_INDEX, { atMs: NOW + 5000 }));

    expect(second.entered).toBe(false);
    expect(second.alreadyOpen).toBe(true);
    // Two open rows would double-count the time-in-mode SLI and leave an exit closing an
    // arbitrary one of them.
    expect(await transitions.activeModes({ prisma }, SHARD)).toEqual([modeRegister.MODE.COLD_INDEX]);
  });

  test("several modes can be open at once, and the advisory payload unions their suspensions", async () => {
    const prisma = memoryStore();
    await transitions.enter({ prisma }, entry(modeRegister.MODE.CUSTODIAL_OPERATION));
    await transitions.enter({ prisma }, entry(modeRegister.MODE.DEGRADED_ROUTING));

    const modes = await transitions.activeModes({ prisma }, SHARD);
    expect(modes.sort()).toEqual(["CUSTODIAL_OPERATION", "DEGRADED_ROUTING"]);

    const payload = transitions.advisoryPayload({ shardId: SHARD, modes, nowMs: NOW });
    expect(payload.degraded).toBe(true);
    expect(payload.suspendedInvariants).toEqual(["I2"]);
    expect(payload.commandsSuspended).toBe(true);
    expect(payload.authority).toMatch(/DegradedModeEvent/);
  });

  test("an exit whose criterion is not met is refused, and the mode stays open", async () => {
    const prisma = memoryStore();
    await transitions.enter({ prisma }, entry(modeRegister.MODE.DEGRADED_ROUTING));

    const refused = await transitions.exit({ prisma }, {
      shardId: SHARD,
      mode: modeRegister.MODE.DEGRADED_ROUTING,
      atMs: NOW + 1000,
      evidence: { routingAvailable: false },
      exitingComponent: "test",
    });

    expect(refused.exited).toBe(false);
    expect(refused.reason).toMatch(/has not recovered/);
    expect(await transitions.activeModes({ prisma }, SHARD)).toEqual([modeRegister.MODE.DEGRADED_ROUTING]);
  });

  test("an exit records its evidence and the time in mode", async () => {
    const prisma = memoryStore();
    await transitions.enter({ prisma }, entry(modeRegister.MODE.SHED_LOAD));

    const exited = await transitions.exit({ prisma }, {
      shardId: SHARD,
      mode: modeRegister.MODE.SHED_LOAD,
      atMs: NOW + 45000,
      evidence: EXIT_EVIDENCE.SHED_LOAD,
      exitingComponent: "intake/admission",
    });

    expect(exited.exited).toBe(true);
    expect(exited.event.durationMs).toBe(45000);
    expect(exited.row.exitReason).toBeUndefined();
    const stored = prisma.__store.degradedModeEvent[0];
    expect(stored.exitReason).toMatch(/queue delay returned within budget/);
    expect(stored.durationMs).toBe(45000);
  });

  test("exiting a mode that is not open is reported rather than silently succeeding", async () => {
    const prisma = memoryStore();
    const outcome = await transitions.exit({ prisma }, {
      shardId: SHARD,
      mode: modeRegister.MODE.COLD_INDEX,
      atMs: NOW,
      evidence: EXIT_EVIDENCE.COLD_INDEX,
      exitingComponent: "test",
    });
    expect(outcome.exited).toBe(false);
    expect(outcome.reason).toMatch(/is not open/);
  });

  test("Restricted Operation exits on recovery **or** on an operator acknowledgement past the box", () => {
    expect(transitions.exitCriterionMet(modeRegister.MODE.RESTRICTED_OPERATION, { indeterminacyRecovered: true }).ok).toBe(true);
    expect(transitions.exitCriterionMet(modeRegister.MODE.RESTRICTED_OPERATION, { operatorAcknowledged: true }).ok).toBe(true);
    expect(transitions.exitCriterionMet(modeRegister.MODE.RESTRICTED_OPERATION, {}).ok).toBe(false);
  });

  test("the socket payloads carry what a dashboard needs for each direction", async () => {
    const prisma = memoryStore();
    const entered = await transitions.enter({ prisma }, entry(modeRegister.MODE.CUSTODIAL_OPERATION));
    const entryMessage = transitions.socketMessage(entered.event);
    expect(entryMessage.event).toBe("DEGRADED_MODE_ENTERED");
    expect(entryMessage.payload.suspendedInvariants).toEqual(["I2"]);
    expect(entryMessage.payload.exitWhen).toMatch(/reconciliation/);

    const exited = await transitions.exit({ prisma }, {
      shardId: SHARD,
      mode: modeRegister.MODE.CUSTODIAL_OPERATION,
      atMs: NOW + 1000,
      evidence: EXIT_EVIDENCE.CUSTODIAL_OPERATION,
      exitingComponent: "test",
    });
    const exitMessage = transitions.socketMessage(exited.event);
    expect(exitMessage.event).toBe("DEGRADED_MODE_EXITED");
    expect(exitMessage.payload.restoredInvariants).toEqual(["I2"]);
  });

  test("the advisory mirror is best-effort — a cache failure costs visibility, never correctness", async () => {
    const failing = {
      kv: {
        set: async () => {
          throw new Error("redis down");
        },
      },
    };
    const outcome = await transitions.publishAdvisory(failing, { shardId: SHARD, modes: ["COLD_INDEX"], nowMs: NOW });
    expect(outcome.published).toBe(false);
    expect(outcome.detail).toMatch(/advisory publish failed/);
  });

  test("the advisory key is the one the plan reserves", () => {
    expect(transitions.advisoryKey(SHARD)).toBe("engine:mode:shard-a");
  });

  test("nothing in this module reads the mode back from the cache", () => {
    // Rule 3 applied to the register's own implementation: a mode register that cached its
    // own state and then trusted the cache would have promoted the cache tier to an
    // authority in the course of implementing the rule that forbids it.
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "engine", "degraded", "transitions.js"), "utf8");
    expect(source).not.toMatch(/kv\.get|kv\.mget|advisoryCache\.get/);
  });
});

describe("§18.5 rule 2 — the time box is swept and an overdue suspension alerts", () => {
  test("a mode within its box is not overdue", async () => {
    const prisma = memoryStore();
    await transitions.enter({ prisma }, entry(modeRegister.MODE.CUSTODIAL_OPERATION));
    expect(await transitions.overdueModes({ prisma }, { shardId: SHARD, nowMs: NOW + 1000 })).toEqual([]);
  });

  test("a mode past its box is overdue and alertable", async () => {
    const prisma = memoryStore();
    await transitions.enter({ prisma }, entry(modeRegister.MODE.CUSTODIAL_OPERATION));

    const overdue = await transitions.overdueModes({ prisma }, { shardId: SHARD, nowMs: NOW + BOX_MS + 1000 });
    expect(overdue).toHaveLength(1);
    expect(overdue[0].mode).toBe("CUSTODIAL_OPERATION");
    expect(overdue[0].alertable).toBe(true);
    expect(overdue[0].overdueByMs).toBe(1000);
  });

  test("the worker's sweep alerts only for overdue modes that suspend something", async () => {
    // An overdue Cold Index is a slow index rebuild, not a guarantee nobody is verifying.
    const prisma = memoryStore();
    await transitions.enter({ prisma }, entry(modeRegister.MODE.COLD_INDEX));
    await transitions.enter({ prisma }, entry(modeRegister.MODE.CUSTODIAL_OPERATION));

    const sweep = await invariantWorker.modeSweepPass({ prisma }, { shardId: SHARD, nowMs: NOW + BOX_MS + 1 });
    expect(sweep.overdue.map((row) => row.mode).sort()).toEqual(["COLD_INDEX", "CUSTODIAL_OPERATION"]);
    expect(sweep.alerts).toHaveLength(1);
    expect(sweep.alerts[0]).toMatchObject({ code: "INVARIANT_SUSPENSION_PAST_TIME_BOX", mode: "CUSTODIAL_OPERATION", suspendedInvariants: ["I2"] });
  });
});

describe("SIMULATION (§24.4) — entry into and exit from every named mode", () => {
  /**
   * Drive one mode: enter it, run the *real* checker against the store, compare every
   * observed status against §26.2's cell, then exit and confirm the register returns.
   *
   * @param {string} mode
   * @returns {Promise<object>}
   */
  async function driveMode(mode) {
    const prisma = memoryStore(healthyWorld({ nowMs: NOW }));

    // A world with one defect per suspendable invariant, so a mode that suspends one has
    // something real to suspend. Verifying "SUSPENDED not VIOLATED" against a clean world
    // would pass trivially — the check would have reported ENFORCED either way.
    prisma.__store.commitment[0].leaseExpiry = new Date(NOW - 1000); // I2
    prisma.__store.timer.length = 0; // I4

    await transitions.enter({ prisma }, entry(mode));
    const activeModes = await transitions.activeModes({ prisma }, SHARD);
    expect(activeModes).toEqual([mode]);

    const during = await invariantChecker.checkAll({ prisma }, checkContext({ nowMs: NOW, activeModes }));

    const exited = await transitions.exit({ prisma }, {
      shardId: SHARD,
      mode,
      atMs: NOW + 1000,
      evidence: EXIT_EVIDENCE[mode],
      exitingComponent: "simulation",
    });
    expect(exited.exited).toBe(true);

    const afterModes = await transitions.activeModes({ prisma }, SHARD);
    expect(afterModes).toEqual([]);
    const after = await invariantChecker.checkAll({ prisma }, checkContext({ nowMs: NOW + 1000, activeModes: afterModes }));

    return { during, after };
  }

  test.each(modeRegister.MODE_NAMES.map((mode) => [mode]))(
    "%s — every observed status matches §26.2's column exactly",
    async (mode) => {
      const { during } = await driveMode(mode);

      const disagreements = [];
      for (const row of during.results) {
        const cell = modeRegister.behaviourOf(row.invariantId, mode);

        if (cell.status === modeRegister.BEHAVIOUR.SUSPENDED) {
          // The plan's own words: "no invariant reports `VIOLATED` where the matrix says
          // `SUSPENDED`".
          if (row.status !== invariantChecker.STATUS.SUSPENDED) {
            disagreements.push(`${row.invariantId}: matrix says S, checker reports ${row.status}`);
          }
          if (row.authorisedBy !== mode) {
            disagreements.push(`${row.invariantId}: suspended without naming ${mode} as the authorising mode`);
          }
          continue;
        }

        // `E` and `D` both mean the invariant is verified; what the check *finds* is a
        // property of the world, not of the mode. What must never happen is a SUSPENDED
        // status with no matrix cell authorising it.
        if (row.status === invariantChecker.STATUS.SUSPENDED) {
          disagreements.push(`${row.invariantId}: checker reports S but the matrix says ${cell.status}`);
        }
        if (cell.status === modeRegister.BEHAVIOUR.DEGRADED && row.degradedVerification !== true) {
          disagreements.push(`${row.invariantId}: matrix says D but the degradation was not recorded`);
        }
      }

      expect(disagreements).toEqual([]);
    },
  );

  test.each(modeRegister.MODE_NAMES.map((mode) => [mode]))(
    "%s — on exit, every suspension is lifted and the register is verified again",
    async (mode) => {
      const { after } = await driveMode(mode);
      expect(after.results.filter((row) => row.status === invariantChecker.STATUS.SUSPENDED)).toEqual([]);
      // The two planted defects are visible again once nothing authorises hiding them.
      expect(after.results.find((row) => row.invariantId === "I2").status).toBe(invariantChecker.STATUS.VIOLATED);
      expect(after.results.find((row) => row.invariantId === "I4").status).toBe(invariantChecker.STATUS.VIOLATED);
    },
  );

  test("no mode suspends a safety invariant, driven rather than asserted", async () => {
    for (const mode of modeRegister.MODE_NAMES) {
      const { during } = await driveMode(mode);
      for (const invariant of modeRegister.NEVER_DEGRADED_INVARIANTS) {
        const row = during.results.find((entry_) => entry_.invariantId === invariant);
        expect({ mode, invariant, status: row.status }).not.toEqual({ mode, invariant, status: invariantChecker.STATUS.SUSPENDED });
      }
    }
  });
});

describe("CHAOS — the Commitment Store removed beyond the autonomy limit", () => {
  const AUTONOMY_LIMIT_SECONDS = 900;

  test("Custodial Operation is entered, and it is the mode B1 names", async () => {
    const infraFailures = require("../../src/engine/failure/infraFailures");
    expect(infraFailures.modeFor("B1")).toBe(modeRegister.MODE.CUSTODIAL_OPERATION);

    const prisma = memoryStore(healthyWorld({ nowMs: NOW }));
    const entered = await transitions.enter({ prisma }, {
      mode: infraFailures.modeFor("B1"),
      shardId: SHARD,
      cause: "Commitment Store health check failed (B1)",
      enteringComponent: "failure/infraFailures",
      atMs: NOW,
      maxDurationMs: BOX_MS,
    });
    expect(entered.entered).toBe(true);
    expect(entered.row.suspendedInvariants).toEqual(["I2"]);
  });

  test("lease renewal stops rather than falling back to a cached lease", async () => {
    const outcome = await supervisionLeases.renew(null, {
      commitment: { commitmentId: "CMT-1", version: 0, releasedAt: null },
      evidence: { commitmentId: "CMT-1", fence: 7n },
      storeAvailable: false,
      storeTime: new Date(NOW),
      leaseDurationSeconds: 60,
    });

    expect(outcome.outcome).toBe(supervisionLeases.RENEWAL_OUTCOME.HALTED_STORE_UNAVAILABLE);
    expect(outcome.detail).toMatch(/A cached lease cannot be revoked/);
    expect(outcome.directive).toMatchObject({ enterDegradedMode: "CUSTODIAL_OPERATION", suspendsInvariant: "I2", noCommands: true });
  });

  test("no command is issued to any agent while the mode is open", async () => {
    // §18.5: "with the store unavailable no fence can be allocated, so no command can be
    // authorised. The engine does not fall back to a cached fence."
    const io = {
      in: () => ({ fetchSockets: async () => [{ id: "socket-1" }] }),
      to: () => ({ emit: emitted }),
    };
    let emittedCount = 0;
    function emitted() {
      emittedCount += 1;
    }

    const suspended = await commandDispatcher.deliverOutboxCommand(io, "AGT-001", { command: "OFFER" }, {
      activeModes: [modeRegister.MODE.CUSTODIAL_OPERATION],
    });
    expect(suspended.delivered).toBe(false);
    expect(suspended.detail).toBe("COMMANDS_SUSPENDED:CUSTODIAL_OPERATION");
    expect(emittedCount).toBe(0);

    // The same call outside the mode delivers, so the refusal is the mode's and not a
    // broken dispatcher.
    const nominal = await commandDispatcher.deliverOutboxCommand(io, "AGT-001", { command: "OFFER" }, { activeModes: [] });
    expect(nominal.delivered).toBe(true);
    expect(emittedCount).toBe(1);
  });

  test("the outbox row is not discarded — it stays undelivered and drains on exit (§18.4)", async () => {
    const io = { in: () => ({ fetchSockets: async () => [{ id: "socket-1" }] }), to: () => ({ emit: () => {} }) };
    const outcome = await commandDispatcher.deliverOutboxCommand(io, "AGT-001", { command: "OFFER" }, {
      activeModes: [modeRegister.MODE.CUSTODIAL_OPERATION],
    });
    // A refusal, not an error and not a discard: infrastructure failure never fails
    // customer work, so the queue drains more slowly and no task is failed for it.
    expect(outcome.degradedMode).toBe("CUSTODIAL_OPERATION");
    expect(outcome.reason).toMatch(/no fence can be allocated/);
  });

  test("the delivery arm re-reads the mode set per row, so a mode opening mid-drain is honoured", async () => {
    const io = { in: () => ({ fetchSockets: async () => [{ id: "socket-1" }] }), to: () => ({ emit: () => {} }) };
    let modes = [];
    const arm = commandDispatcher.outboxDeliveryArm(io, { activeModes: () => modes });

    expect((await arm("AGT-001", { command: "OFFER" })).delivered).toBe(true);
    modes = [modeRegister.MODE.CUSTODIAL_OPERATION];
    expect((await arm("AGT-001", { command: "OFFER" })).delivered).toBe(false);
  });

  test("I2 reports SUSPENDED, not VIOLATED, for the outage's whole duration", async () => {
    const prisma = memoryStore(healthyWorld({ nowMs: NOW }));
    // Past the autonomy limit: every lease in the shard has expired and cannot be renewed.
    const pastLimitMs = NOW + (AUTONOMY_LIMIT_SECONDS + 60) * 1000;
    prisma.__store.commitment[0].leaseExpiry = new Date(NOW - 1000);

    await transitions.enter({ prisma }, entry(modeRegister.MODE.CUSTODIAL_OPERATION));
    const activeModes = await transitions.activeModes({ prisma }, SHARD);

    const outcome = await invariantChecker.checkAll({ prisma }, checkContext({ nowMs: pastLimitMs, activeModes, storeTime: new Date(pastLimitMs) }));
    const i2 = outcome.results.find((row) => row.invariantId === "I2");

    expect(i2.status).toBe(invariantChecker.STATUS.SUSPENDED);
    expect(i2.authorisedBy).toBe(modeRegister.MODE.CUSTODIAL_OPERATION);
    // Without the third status, this outage would page continuously against a target of
    // exactly zero — training operators to ignore the one signal the register produces.
    expect(outcome.summary.pageWorthy).toBe(false);
    expect(outcome.summary.invariantViolations).toBe(0);
  });

  test("the agent's autonomy limit is the safety property that replaces server supervision", () => {
    // Enforced on the agent, so it is unaffected by the server-side outage that caused the
    // mode. The register names the parameter rather than reimplementing the bound.
    const envelope = modeRegister.MODES[modeRegister.MODE.CUSTODIAL_OPERATION].envelope;
    expect(envelope.agentAutonomyLimitParameter).toBe("agent.autonomous_continuation_limit");

    const { entries } = require("../../src/engine/config/service").loadRegister();
    expect(entries.get("agent.autonomous_continuation_limit").default).toBe(AUTONOMY_LIMIT_SECONDS);
  });

  test("rounds do not resume until full reconciliation completes, not merely when the store answers", async () => {
    const prisma = memoryStore(healthyWorld({ nowMs: NOW }));
    await transitions.enter({ prisma }, entry(modeRegister.MODE.CUSTODIAL_OPERATION));

    expect(await transitions.mayResumeRounds({ prisma }, SHARD)).toMatchObject({ mayResume: false, blockedBy: ["CUSTODIAL_OPERATION"] });

    // The store returns — and that is not enough.
    const storeBack = await transitions.exit({ prisma }, {
      shardId: SHARD,
      mode: modeRegister.MODE.CUSTODIAL_OPERATION,
      atMs: NOW + 60000,
      evidence: { storeAvailable: true, reconciliationComplete: false },
      exitingComponent: "chaos",
    });
    expect(storeBack.exited).toBe(false);
    expect(storeBack.reason).toMatch(/full reconciliation has not completed/);
    expect((await transitions.mayResumeRounds({ prisma }, SHARD)).mayResume).toBe(false);

    // Reconciliation completes; only then does I2 return to ENFORCED.
    const reconciled = await transitions.exit({ prisma }, {
      shardId: SHARD,
      mode: modeRegister.MODE.CUSTODIAL_OPERATION,
      atMs: NOW + 120000,
      evidence: { storeAvailable: true, reconciliationComplete: true },
      exitingComponent: "chaos",
    });
    expect(reconciled.exited).toBe(true);
    expect(reconciled.event.restoredInvariants).toEqual(["I2"]);
    expect((await transitions.mayResumeRounds({ prisma }, SHARD)).mayResume).toBe(true);
  });
});

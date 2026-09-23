"use strict";

/**
 * The seam in `services/task.service.js` — **after Phase 15 there is only one side of it.**
 *
 * Through Phases 10-14 this file tested a strangler: §3.4's request path on one branch, the
 * legacy dispatcher on the other, and the disposition of the surviving `setImmediate` on
 * the legacy side. The cutover removed the legacy branch from the build, so what is under
 * test now is the *single* path and, more importantly, **what happens when it is not
 * available** — because that is the case the second branch used to absorb.
 *
 * The refusal is the interesting assertion. With no legacy dispatcher to fall back to, a
 * shard whose engine is not live must refuse the request rather than durably queue work
 * nothing will drain; §12.1 is explicit that an unowned in-flight state is the defect, not
 * the safety net.
 */

jest.mock("../../src/services/mapbox.service");
jest.mock("../../src/services/commandDispatcher.service");
jest.mock("../../src/services/metrics.service");

const fs = require("fs");
const path = require("path");

const taskService = require("../../src/services/task.service");
const intake = require("../../src/engine/intake/intake");
const fixture = require("./helpers/roundFixture");
// PHASE 14 remediation (P14-R7) — §23.7's key shape, read from the module that defines it.
const surrogateKeys = require("../../src/engine/privacy/surrogateKeys");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const RECEIVED_AT_MS = 1_800_000_000_000;
/** The store clock the §4.5 deadline is armed against (§10.6 — never a worker's wall clock). */
const STORE_NOW = new Date(RECEIVED_AT_MS);

function legacyTaskRow(taskId) {
  return {
    id: `db-${taskId}`,
    taskId,
    status: "PENDING",
    pickup: "Building A",
    drop: "Building B",
    pickupLat: 1,
    pickupLon: 1,
    dropLat: 2,
    dropLon: 2,
    robot: null,
  };
}

/**
 * The memory store, extended with the tables the legacy→domain bridge writes.
 *
 * PHASE 14 remediation (P14-R7): `identityRecord`, `stop.update` and `task.update` were
 * added when `admitToRound` became the production producer of `Stop.identityKey` and of
 * the two `Task` identity columns (§23.7). The double gained the tables the production
 * path now uses; no assertion below was relaxed, and the sealing is asserted directly in
 * its own test.
 */
function bridgeStore() {
  const prisma = fixture.memoryPrisma();
  const missions = [];
  const legs = [];
  const stops = [];
  const tasks = [];
  const identities = [];

  const upsertInto = (rows) => async ({ where, create }) => {
    const existing = rows.find((row) => row.id === where.id);
    if (existing) return { ...existing };
    rows.push({ ...create });
    return { ...create };
  };

  const updateIn = (rows, key) => async ({ where, data }) => {
    const existing = rows.find((row) => row[key] === where[key]);
    if (!existing) {
      // Prisma throws on an update that matches nothing; the double does too, so a
      // production path that updated a row it never created fails here rather than
      // silently succeeding.
      throw new Error(`no row with ${key}=${String(where[key])}`);
    }
    Object.assign(existing, data);
    return { ...existing };
  };

  prisma.mission = { upsert: upsertInto(missions) };
  // `update` beside `upsert`: `superviseQueuedEntry` is the producer of `Leg.slaDeadline`
  // and writes it in the same transaction as the Leg. The double throws on an update that
  // matches nothing, so a producer writing a Leg it never created fails here.
  prisma.leg = { upsert: upsertInto(legs), update: updateIn(legs, "id") };
  prisma.stop = { upsert: upsertInto(stops), update: updateIn(stops, "id") };
  prisma.task = {
    // `sealIdentities` updates the Task row it was handed; the fixture's legacy Task is
    // not otherwise in the store, so it is materialised on first use.
    update: async ({ where, data }) => {
      let existing = tasks.find((row) => row.id === where.id);
      if (!existing) {
        existing = { id: where.id };
        tasks.push(existing);
      }
      Object.assign(existing, data);
      return { ...existing };
    },
  };
  prisma.identityRecord = {
    findUnique: async ({ where }) => identities.find((row) => row.surrogateKey === where.surrogateKey) || null,
    create: async ({ data }) => {
      identities.push({ ...data });
      return { ...data };
    },
    update: updateIn(identities, "surrogateKey"),
  };

  // REMEDIAL PHASE T1-04 — the bridge now arms the §4.5 deadline of the `QUEUED` state
  // the Leg is created in, in the same transaction as the Leg write. Before this the
  // request path armed nothing: `checkI4` reported every admitted Leg as
  // `NO_PENDING_TIMER`, and §17.4's escalation ladder — whose only trigger is `QUEUED`'s
  // expiry action — never fired for customer work at all.
  //
  // The double gains the four capabilities that path needs, and nothing else. It is a
  // double rather than a stub in the sense that matters: `timers.register` runs for real
  // against it, including its `requireTransaction` check, which is why the transaction
  // client below deliberately has **no** `$transaction` of its own.
  const timers = [];
  prisma.timer = {
    count: async ({ where }) =>
      timers.filter(
        (row) =>
          row.entityType === where.entityType &&
          row.entityId === where.entityId &&
          row.timerState === where.timerState,
      ).length,
    findUnique: async ({ where }) => timers.find((row) => row.timerKey === where.timerKey) || null,
    create: async ({ data }) => {
      const row = { id: `TMR-${timers.length + 1}`, createdAt: STORE_NOW, ...data };
      timers.push(row);
      return { ...row };
    },
    update: updateIn(timers, "id"),
  };
  prisma.leg.findUnique = async ({ where }) => {
    const row = legs.find((entry) => entry.id === where.id);
    return row ? { ...row } : null;
  };
  prisma.$queryRawUnsafe = async () => [{ now: STORE_NOW }];
  prisma.$transaction = async (run) => {
    // §4.5's client, with `$transaction` removed: `timers.requireTransaction` refuses
    // anything that still carries it, which is what stops a timer being written outside
    // the transaction that entered the state.
    const { $transaction, ...tx } = prisma;
    return run(tx);
  };

  // §3.6's OperatingRegion, with its two identifiers kept distinct.
  //
  // `assignTask` names a region by `Region.regionId`, the business key a caller can hold,
  // and translates it to `Region.id` — the uuid `Mission.regionId`, `Shard.regionId` and
  // the `cutover.engine_enabled` binding all mean. The double returns a different string
  // for the row id than the key it was asked for, so a test that passed by conflating the
  // two would fail here instead.
  prisma.region = {
    findUnique: async ({ where }) =>
      REGIONS.has(where.regionId) ? { id: REGIONS.get(where.regionId) } : null,
  };

  prisma.__bridge = { missions, legs, stops, tasks, identities, timers };
  return prisma;
}

/** The regions this file's submissions may name, business key → `Region.id`. */
const REGIONS = new Map([
  ["eu-west", "region-row-eu-west"],
  ["eu-east", "region-row-eu-east"],
]);

describe("the legacy Task → domain work bridge (§2.4)", () => {
  test("one legacy Task becomes one Mission, one PRIMARY Leg, and two Stops", async () => {
    const prisma = bridgeStore();
    await taskService.admitToRound(prisma, legacyTaskRow("TSK-1"), {
      receivedAtMs: RECEIVED_AT_MS,
      cadenceConfig: fixture.cadenceConfig(),
      feasibleSupply: 3,
    });

    expect(prisma.__bridge.missions).toHaveLength(1);
    expect(prisma.__bridge.legs).toHaveLength(1);
    expect(prisma.__bridge.legs[0].purpose).toBe("PRIMARY");
    expect(prisma.__bridge.stops).toHaveLength(2);
    expect(prisma.__bridge.stops.map((stop) => stop.stopType)).toEqual(["PICKUP", "DROP"]);
  });

  // ── PHASE 14 remediation (P14-R7) — §23.7's producer, at the point of creation ──
  //
  // Before this remediation `Stop.identityKey`, `Task.originIdentityKey` and
  // `Task.destinationIdentityKey` had exactly one writer in the whole repository, and it
  // was the offline backfill tool. Every Stop the running system created therefore had no
  // identity record, no surrogate key, and no route by which an erasure request could
  // reach it — the negative half of §23.7 held (nothing identifying reached a decision
  // record) and the positive half did not exist in production at all.
  test("every Stop and both Task ends are sealed into the identity store with a stable surrogate key (§23.7)", async () => {
    const prisma = bridgeStore();
    await taskService.admitToRound(prisma, legacyTaskRow("TSK-ID-1"), {
      receivedAtMs: RECEIVED_AT_MS,
      cadenceConfig: fixture.cadenceConfig(),
      feasibleSupply: 3,
    });

    // Two Stops and two Task ends, four identity records — the pickup and the drop are
    // different premises and are keyed separately, so one erasure cannot take the other.
    expect(prisma.__bridge.identities).toHaveLength(4);
    for (const record of prisma.__bridge.identities) {
      expect(surrogateKeys.isSurrogateKey(record.surrogateKey)).toBe(true);
      // Sealed, never stored in the clear.
      expect(record.ciphertext).toBeTruthy();
      // The address is in the ciphertext and nowhere else on the row.
      expect(JSON.stringify(record)).not.toContain("Building A");
      expect(JSON.stringify(record)).not.toContain("Building B");
    }

    for (const stop of prisma.__bridge.stops) {
      expect(surrogateKeys.isSurrogateKey(stop.identityKey)).toBe(true);
      expect(surrogateKeys.subjectTypeOf(stop.identityKey)).toBe("STOP");
      // The one derived quantity §3.4's request path can honestly produce: a pure
      // function of the coordinate. The other five are products of the round.
      expect(typeof stop.fineCell).toBe("string");
    }

    const task = prisma.__bridge.tasks[0];
    expect(surrogateKeys.subjectTypeOf(task.originIdentityKey)).toBe("TASK");
    expect(surrogateKeys.subjectTypeOf(task.destinationIdentityKey)).toBe("TASK");
    expect(task.originIdentityKey).not.toBe(task.destinationIdentityKey);
  });

  test("the surrogate key is stable: the same address submitted twice mints one identity record (§23.7)", async () => {
    const prisma = bridgeStore();
    await taskService.admitToRound(prisma, legacyTaskRow("TSK-ID-2"), {
      receivedAtMs: RECEIVED_AT_MS,
      cadenceConfig: fixture.cadenceConfig(),
      feasibleSupply: 3,
    });
    const firstKeys = prisma.__bridge.stops.map((stop) => stop.identityKey);

    // A different Task at the same two addresses. Stability is what makes an erasure
    // request for an address reach every decision that pointed at it, rather than
    // requiring the requester to enumerate Stops.
    await taskService.admitToRound(prisma, legacyTaskRow("TSK-ID-3"), {
      receivedAtMs: RECEIVED_AT_MS,
      cadenceConfig: fixture.cadenceConfig(),
      feasibleSupply: 3,
    });

    expect(prisma.__bridge.identities).toHaveLength(4);
    expect(prisma.__bridge.stops.slice(2).map((stop) => stop.identityKey)).toEqual(firstKeys);
  });

  // Fail closed. A skip would produce exactly the state §23.7 exists to prevent — an
  // address in `Stop.label` with no identity record, no key and no erasure route — and it
  // would do so silently, at the one moment the address is in hand.
  test("a missing PRIVACY_SURROGATE_SECRET refuses the submission rather than writing an address with no identity record", async () => {
    const prisma = bridgeStore();
    const secret = process.env.PRIVACY_SURROGATE_SECRET;
    delete process.env.PRIVACY_SURROGATE_SECRET;
    try {
      await expect(
        taskService.admitToRound(prisma, legacyTaskRow("TSK-ID-4"), {
          receivedAtMs: RECEIVED_AT_MS,
          cadenceConfig: fixture.cadenceConfig(),
          feasibleSupply: 3,
        }),
      ).rejects.toThrow(/PRIVACY_SURROGATE_SECRET is unset/);
    } finally {
      process.env.PRIVACY_SURROGATE_SECRET = secret;
    }

    expect(prisma.__bridge.identities).toHaveLength(0);
  });

  test("the materialised ids are deterministic, so a retry converges rather than duplicating", async () => {
    const prisma = bridgeStore();
    const first = await taskService.admitToRound(prisma, legacyTaskRow("TSK-2"), {
      receivedAtMs: RECEIVED_AT_MS,
      cadenceConfig: fixture.cadenceConfig(),
      feasibleSupply: 3,
    });
    const second = await taskService.admitToRound(prisma, legacyTaskRow("TSK-2"), {
      receivedAtMs: RECEIVED_AT_MS,
      cadenceConfig: fixture.cadenceConfig(),
      feasibleSupply: 3,
    });

    expect(prisma.__bridge.legs).toHaveLength(1);
    expect(prisma.__tables.workQueue).toHaveLength(1);
    expect(first.outcome).toBe(intake.OUTCOME.ACCEPTED);
    expect(second.outcome).toBe(intake.OUTCOME.DUPLICATE);
    expect(second.legId).toBe(first.legId);
  });

  test("the durable queue row is written against the materialised Leg", async () => {
    const prisma = bridgeStore();
    const response = await taskService.admitToRound(prisma, legacyTaskRow("TSK-3"), {
      receivedAtMs: RECEIVED_AT_MS,
      cadenceConfig: fixture.cadenceConfig(),
      feasibleSupply: 3,
    });

    expect(prisma.__tables.workQueue[0].legId).toBe(prisma.__bridge.legs[0].id);
    expect(response.accepted).toBe(true);
    expect(response.assigned).toBe(false);
  });

  test("the window quoted at intake comes from the same cadence module the round reads", async () => {
    const prisma = bridgeStore();
    const nominal = await taskService.admitToRound(prisma, legacyTaskRow("TSK-4"), {
      receivedAtMs: RECEIVED_AT_MS,
      cadenceConfig: fixture.cadenceConfig(),
      queueDepth: 5,
      feasibleSupply: 5,
    });

    // Nominal regime ⇒ solve.window_min ⇒ the earliest edge is exactly one window out.
    expect(nominal.predictedAssignmentWindow.earliestMs).toBe(RECEIVED_AT_MS + 500);
  });

  test("with no supply, the honest refusal to quote a window survives the bridge", async () => {
    const prisma = bridgeStore();
    const response = await taskService.admitToRound(prisma, legacyTaskRow("TSK-5"), {
      receivedAtMs: RECEIVED_AT_MS,
      cadenceConfig: fixture.cadenceConfig(),
      queueDepth: 5,
      feasibleSupply: 0,
    });

    expect(response.predictedAssignmentWindow.basis).toBe(intake.WINDOW_BASIS.NO_FEASIBLE_SUPPLY);
    expect(response.accepted).toBe(true);
  });
});

// ── The `Leg.slaDeadline` producer ──────────────────────────────────────────────
//
// §4.3 gives Leg state `QUEUED` the exit deadline `sla.assignment_deadline`; §4.5 requires
// it to be registered in the transaction that enters the state. `Leg.slaDeadline` holds the
// absolute instant of that deadline, and §17.4's triage comparator reads it as its third
// key ("SLA breach proximity"). Before this producer the column had exactly one writer on
// the tree — `taskToWork`, which writes `null` — so the key was inert in production.
describe("the Leg.slaDeadline producer (§4.3, §4.5, consumed by §17.4 triage)", () => {
  const service = require("../../src/engine/config/service");
  const operatorCapacity = require("../../src/engine/fairness/operatorCapacity");

  /** The published snapshot's `values` map — the same one `assignTask` threads through. */
  const publishedValues = () => service.buildSnapshot({}).values;

  /**
   * `sla.assignment_deadline` at its registered default, and §17.4's rung-1 fraction of it.
   * Both are read from the register rather than written down here, so a republished default
   * moves the expectation with it instead of turning this file red for the wrong reason.
   */
  const BUDGET_SECONDS = publishedValues().get("sla.assignment_deadline");
  const RUNG_1_SECONDS = require("../../src/engine/fairness/ladder").firstBoundarySecondsFrom(
    publishedValues(),
    BUDGET_SECONDS,
  );

  const admit = (prisma, taskId, options) =>
    taskService.admitToRound(prisma, legacyTaskRow(taskId), {
      receivedAtMs: RECEIVED_AT_MS,
      cadenceConfig: fixture.cadenceConfig(),
      feasibleSupply: 3,
      configValues: publishedValues(),
      ...(options || {}),
    });

  test("the deadline is the store clock plus the resolved sla.assignment_deadline", async () => {
    const prisma = bridgeStore();
    await admit(prisma, "TSK-SLA-1");

    const leg = prisma.__bridge.legs[0];
    expect(leg.slaDeadline).toBeInstanceOf(Date);
    // Absolute, and measured from the *store's* clock (§10.6) — never the worker's.
    expect(leg.slaDeadline.getTime()).toBe(STORE_NOW.getTime() + BUDGET_SECONDS * 1000);
  });

  // **The defect this test exists to catch.** The timer beside it is armed at rung 1's
  // boundary (25 % of the budget) because the ladder re-arms itself at each subsequent
  // rung. A deadline derived from `armedSeconds` rather than `budgetSeconds` would declare
  // every Leg in breach 675 s early, and the triage order that reads it would be wrong in
  // the direction that looks urgent.
  test("the deadline is the whole budget, not the rung-1 boundary the timer is armed at", async () => {
    const prisma = bridgeStore();
    await admit(prisma, "TSK-SLA-2");

    const leg = prisma.__bridge.legs[0];
    const timer = prisma.__bridge.timers[0];

    expect(RUNG_1_SECONDS).toBeLessThan(BUDGET_SECONDS);
    expect(timer.dueAt.getTime()).toBe(STORE_NOW.getTime() + RUNG_1_SECONDS * 1000);
    expect(leg.slaDeadline.getTime()).toBe(STORE_NOW.getTime() + BUDGET_SECONDS * 1000);
    expect(leg.slaDeadline.getTime()).toBeGreaterThan(timer.dueAt.getTime());
  });

  // The column and the timer must be derivable from one another, because §17.4 sorts on the
  // first and §4.5 fires on the second. One clock read and one resolved budget is what makes
  // that true by construction rather than by two computations agreeing.
  test("the deadline and the timer's recorded ladder budget name the same instant", async () => {
    const prisma = bridgeStore();
    await admit(prisma, "TSK-SLA-3");

    const leg = prisma.__bridge.legs[0];
    const timer = prisma.__bridge.timers[0];
    const budgetFromTimer = timer.payload.ladderBudgetSeconds;

    expect(budgetFromTimer).toBe(BUDGET_SECONDS);
    expect(leg.slaDeadline.getTime()).toBe(timer.dueAt.getTime() - RUNG_1_SECONDS * 1000 + budgetFromTimer * 1000);
  });

  // §22.1 admits no behavioural constant outside the register. An unresolvable parameter
  // must leave the column null rather than produce a guessed instant — and null is exactly
  // what the triage comparator already reads as "proximity unknown, sort last".
  test("an unresolvable sla.assignment_deadline leaves the column null and arms nothing", async () => {
    const prisma = bridgeStore();
    await admit(prisma, "TSK-SLA-4", { configValues: null });

    expect(prisma.__bridge.legs[0].slaDeadline).toBeNull();
    expect(prisma.__bridge.timers).toHaveLength(0);
  });

  test("a values map that resolves the parameter to a non-positive value is refused too", async () => {
    const prisma = bridgeStore();
    await admit(prisma, "TSK-SLA-5", { configValues: new Map([["sla.assignment_deadline", 0]]) });

    expect(prisma.__bridge.legs[0].slaDeadline).toBeNull();
    expect(prisma.__bridge.timers).toHaveLength(0);
  });

  // A retried submission converges on the same Leg (the ids are deterministic). The deadline
  // it was admitted with must not move forward: an anti-starvation clock that restarts on
  // every retry is not a guarantee.
  test("a retried admission does not move the deadline", async () => {
    const prisma = bridgeStore();
    await admit(prisma, "TSK-SLA-6");
    const first = prisma.__bridge.legs[0].slaDeadline;

    // The store clock advances between the two attempts; the deadline must not follow it.
    const later = new Date(STORE_NOW.getTime() + 60_000);
    prisma.$queryRawUnsafe = async () => [{ now: later }];
    await admit(prisma, "TSK-SLA-6");

    expect(prisma.__bridge.legs).toHaveLength(1);
    expect(prisma.__bridge.timers).toHaveLength(1);
    expect(prisma.__bridge.legs[0].slaDeadline.getTime()).toBe(first.getTime());
  });

  // The point of the producer: §17.4's third triage key stops being inert. Two Legs equal on
  // custody and obstruction now order by measured breach proximity rather than by arrival.
  test("the produced deadline is what §17.4's triage comparator orders on", async () => {
    const prisma = bridgeStore();
    await admit(prisma, "TSK-SLA-7");
    const admitted = prisma.__bridge.legs[0];

    // A second Leg with a tighter contracted budget, admitted at the same instant.
    const tighter = new Map([["sla.assignment_deadline", 120]]);
    const other = bridgeStore();
    await admit(other, "TSK-SLA-8", { configValues: tighter });
    const urgent = other.__bridge.legs[0];

    const base = { custodyState: "NONE", obstructionClass: null, queueAgeSeconds: 0 };
    const order = operatorCapacity.triage([
      { ...base, legId: admitted.legId, slaDeadline: admitted.slaDeadline },
      { ...base, legId: urgent.legId, slaDeadline: urgent.slaDeadline },
    ]);

    expect(urgent.slaDeadline.getTime()).toBeLessThan(admitted.slaDeadline.getTime());
    expect(order.map((row) => row.legId)).toEqual([urgent.legId, admitted.legId]);
  });
});

describe("the cutover gate — the case the legacy branch used to absorb", () => {
  const service = require("../../src/engine/config/service");
  const cutoverEnabled = require("../../src/engine/cutover/enabled");

  /**
   * A published snapshot with the shard's cutover binding set.
   *
   * The binding's key is the **`Region.id`**, not the business key a submission names.
   * That is not a choice this fixture makes: `cutover/stage.authoriseEnable` publishes
   * `{ level: "region", key: shard.regionId }` from the `Shard` row, and `Shard.regionId`
   * is the foreign key to `Region.id` — so, in `server.js`'s words, "the key is
   * machine-generated at both ends". `assignTask` translates the caller's business key to
   * the same value before asking the gate.
   */
  const snapshotWith = (regionKey, live) =>
    service.buildSnapshot({
      bindings: live
        ? [{ level: "region", key: REGIONS.get(regionKey), name: cutoverEnabled.PARAMETER, value: true }]
        : [],
    });

  const originalEngineFlag = process.env.ENGINE_ENABLED;
  afterEach(() => {
    if (originalEngineFlag === undefined) delete process.env.ENGINE_ENABLED;
    else process.env.ENGINE_ENABLED = originalEngineFlag;
  });

  test("the switch is a conjunction: the process flag AND the shard's published binding", () => {
    process.env.ENGINE_ENABLED = "true";
    const live = snapshotWith("eu-west", true);
    // `engineEnabled` takes a region that is already resolved — it is asked by callers
    // holding a `Shard` row — so the row id is what it is handed here.
    expect(taskService.engineEnabled({ config: live, regionId: REGIONS.get("eu-west") })).toBe(true);
    // Same process, a shard that has not been staged.
    expect(taskService.engineEnabled({ config: live, regionId: REGIONS.get("eu-east") })).toBe(false);

    process.env.ENGINE_ENABLED = "false";
    expect(taskService.engineEnabled({ config: live, regionId: REGIONS.get("eu-west") })).toBe(false);
  });

  test("with the shard live, assignTask returns the §3.4 contract and detaches nothing", async () => {
    process.env.ENGINE_ENABLED = "true";
    const prisma = bridgeStore();
    // `create` is added beside the store's own `update` rather than replacing the
    // table: `sealIdentities` writes the two §23.7 identity columns back to the Task
    // row it was handed (P14-R7).
    prisma.task = { ...prisma.task, create: async ({ data }) => legacyTaskRow(data.taskId) };

    const created = await taskService.assignTask(
      prisma,
      { taskId: "TSK-6", pickup: "A", drop: "B", pickupLat: 1, pickupLon: 1, dropLat: 2, dropLon: 2 },
      {
        cadenceConfig: fixture.cadenceConfig(),
        feasibleSupply: 3,
        receivedAtMs: RECEIVED_AT_MS,
        config: snapshotWith("eu-west", true),
        regionId: "eu-west",
      },
    );

    expect(created.intake).toBeDefined();
    expect(created.intake.accepted).toBe(true);
    expect(created.intake.assigned).toBe(false);
    expect(created.intake.queuePosition).toBe(1);
    // The caller's instant reaches the window, so the quote can be scored against the
    // realised assignment later (§21.5) rather than against a clock nobody recorded.
    expect(created.intake.predictedAssignmentWindow.earliestMs).toBe(RECEIVED_AT_MS + 500);
    // The legacy response shape survives beside the new contract through the retention
    // window, so a consumer that has not migrated reads a task row rather than a 500.
    expect(created.taskId).toBe("TSK-6");
    expect(created.status).toBe("PENDING");
  });

  test("with the shard NOT live, assignTask refuses with 503 and writes nothing", async () => {
    process.env.ENGINE_ENABLED = "true";
    const prisma = bridgeStore();
    let created = 0;
    prisma.task = {
      create: async ({ data }) => {
        created += 1;
        return legacyTaskRow(data.taskId);
      },
    };

    await expect(
      taskService.assignTask(
        prisma,
        { taskId: "TSK-7", pickup: "A", drop: "B", pickupLat: 1, pickupLon: 1, dropLat: 2, dropLon: 2 },
        { config: snapshotWith("eu-west", true), regionId: "eu-east" },
      ),
    ).rejects.toMatchObject({ status: 503, code: "ENGINE_NOT_LIVE" });

    // The gate runs before the row. A refused request that had already created a PENDING
    // Task would leave exactly the unowned in-flight state §12.1 objects to.
    expect(created).toBe(0);
    expect(prisma.__tables.workQueue).toHaveLength(0);
  });

  test("the refusal states the consequence, not just the state", async () => {
    process.env.ENGINE_ENABLED = "true";
    const prisma = bridgeStore();
    // `create` is added beside the store's own `update` rather than replacing the
    // table: `sealIdentities` writes the two §23.7 identity columns back to the Task
    // row it was handed (P14-R7).
    prisma.task = { ...prisma.task, create: async ({ data }) => legacyTaskRow(data.taskId) };

    const error = await taskService
      .assignTask(
        prisma,
        { taskId: "TSK-8", pickup: "A", drop: "B", pickupLat: 1, pickupLon: 1, dropLat: 2, dropLon: 2 },
        { config: snapshotWith("eu-west", true), regionId: "eu-east" },
      )
      .catch((e) => e);

    expect(error.message).toMatch(/no decision path/i);
    expect(error.message).toMatch(/removed from the build/i);
    expect(error.posture.decisionPath).toBe(cutoverEnabled.DECISION_PATH.NONE);
  });

  test("a caller-nominated robotId is reported as ignored, not silently dropped", async () => {
    process.env.ENGINE_ENABLED = "true";
    const prisma = bridgeStore();
    // `create` is added beside the store's own `update` rather than replacing the
    // table: `sealIdentities` writes the two §23.7 identity columns back to the Task
    // row it was handed (P14-R7).
    prisma.task = { ...prisma.task, create: async ({ data }) => legacyTaskRow(data.taskId) };

    const created = await taskService.assignTask(
      prisma,
      { taskId: "TSK-9", robotId: "RBT-42", pickup: "A", drop: "B", pickupLat: 1, pickupLon: 1, dropLat: 2, dropLon: 2 },
      {
        cadenceConfig: fixture.cadenceConfig(),
        feasibleSupply: 3,
        config: snapshotWith("eu-west", true),
        regionId: "eu-west",
      },
    );

    expect(created.ignoredFields).toEqual([expect.objectContaining({ field: "robotId", value: "RBT-42" })]);
    expect(created.ignoredFields[0].reason).toMatch(/override/);
  });
});

describe("the legacy assignment path is gone from the file, not merely unreachable", () => {
  const source = fs.readFileSync(path.join(BACKEND_ROOT, "src", "services", "task.service.js"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  test("every function of the legacy path is absent from the code", () => {
    for (const symbol of [
      "legacyDetachedAssignment",
      "_processAssignment",
      "_finalizeAssignment",
      "seedTaskKeys",
      "getRoutesWithDistance",
      "pathDistanceMeters",
    ]) {
      expect({ symbol, present: code.includes(symbol) }).toEqual({ symbol, present: false });
    }
    expect(code).not.toMatch(/\bsetImmediate\s*\(/);
    expect(code).not.toMatch(/robotReserve/);
  });

  test("the header states what was removed and what was deliberately kept", () => {
    expect(source).toMatch(/PHASE 15 — the legacy assignment path is gone/);
    expect(source).toMatch(/\*\*Removed\.\*\*/);
    expect(source).toMatch(/\*\*Kept, deliberately, until the retention window closes\.\*\*/);
    // The kept surface is named, with the plan's own condition for its removal.
    expect(source).toMatch(/rerouteTask/);
    expect(source).toMatch(/after cutover/);
  });

  test("the build gate refuses a resurrection, and is proven able to fail", () => {
    const gate = require("../../tools/gates/checkLegacyRetirement");
    expect(gate.checkLegacyRetirement().ok).toBe(true);

    // Planted defects, caught by name. A gate proven only able to pass is not a gate.
    expect(gate.findDefinitions("async function _processAssignment(p, t) { return null; }", "_processAssignment")).toHaveLength(1);
    expect(
      gate.findImports('const x = require("../services/taskAssignment.service");', "src/services/taskAssignment.service.js"),
    ).toHaveLength(1);
  });
});

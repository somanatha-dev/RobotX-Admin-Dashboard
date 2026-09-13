"use strict";

/**
 * BATCH 2 — the development simulated Charging Scheduler, `chargingStatusFor`, and the
 * index maintainer's fail-closed classification.
 *
 * ── What the store double is, and why it is not a jest.fn ───────────────────
 * `tests/helpers/mockPrisma.js` is a table of `jest.fn()`s: a test configures the answer
 * it wants and asserts the call it expects. That is the wrong instrument here. Every
 * property this batch claims — three plugs and not four, FIFO and not LIFO, one
 * reservation per retry, a released plug going to the longest waiter — is a property of
 * **what ends up in the table**, and a double that returns whatever the test told it to
 * cannot establish any of them.
 *
 * So `createChargingStore()` below is a small working store: rows go in, queries read them
 * back, and every assertion is made against the rows rather than against a call log. The
 * one thing it cannot model is PostgreSQL's isolation, which is why `promote` and
 * `requestPlug` take `runSerializable`/`selectForUpdate` as injected dependencies and why
 * the live-database run (`tools/verify/batch2ChargingScheduler.js`) exists as a separate
 * instrument.
 *
 * ── What these tests do NOT claim ──────────────────────────────────────────
 * Nothing here is physical charger evidence, and no V1 stop condition is touched. The
 * scheduler is a development publisher for the simulated fleet; the tests establish that
 * it behaves as one, not that a charger exists.
 */

const devChargingScheduler = require("../../src/simulation/devChargingScheduler");
const chargingStatusService = require("../../src/services/chargingStatus.service");
const indexMaintainer = require("../../src/workers/indexMaintainer.worker");

const { RESERVATION_STATE, RELEASE_REASON, DEVELOPMENT_CHARGER } = devChargingScheduler;

const BENGALURU = { lat: 12.9716, lon: 77.5946 };
const T0 = 1_700_000_000_000;

/* ═══════════════════════════════════════════════════════════════════════════
   A working in-memory store
   ═══════════════════════════════════════════════════════════════════════════ */

/** Does a row satisfy one Prisma `where` clause? Supports `in`, `lt`, and equality. */
function matches(row, where) {
  for (const [field, condition] of Object.entries(where || {})) {
    const value = row[field];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      if (Array.isArray(condition.in) && !condition.in.includes(value)) return false;
      if (condition.lt !== undefined) {
        const left = value instanceof Date ? value.getTime() : value;
        const right = condition.lt instanceof Date ? condition.lt.getTime() : condition.lt;
        if (!(left < right)) return false;
      }
      continue;
    }
    if (value instanceof Date && condition instanceof Date) {
      if (value.getTime() !== condition.getTime()) return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

/** Apply a Prisma `orderBy` (single object or array of them). */
function ordered(rows, orderBy) {
  const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const clause of clauses) {
      const [field, direction] = Object.entries(clause)[0];
      let left = a[field];
      let right = b[field];
      if (left instanceof Date) left = left.getTime();
      if (right instanceof Date) right = right.getTime();
      if (left < right) return direction === "desc" ? 1 : -1;
      if (left > right) return direction === "desc" ? -1 : 1;
    }
    return 0;
  });
  return sorted;
}

function createChargingStore() {
  let sequence = 0;
  const chargers = [];
  const reservations = [];
  const projections = [];
  const agents = [];

  const table = (rows, name) => ({
    rows,
    async findFirst({ where, orderBy } = {}) {
      return ordered(rows.filter((row) => matches(row, where)), orderBy)[0] || null;
    },
    async findMany({ where, orderBy, take } = {}) {
      const found = ordered(rows.filter((row) => matches(row, where)), orderBy);
      return take === undefined ? found : found.slice(0, take);
    },
    async count({ where } = {}) {
      return rows.filter((row) => matches(row, where)).length;
    },
    async create({ data }) {
      sequence += 1;
      // `reservationId @unique` is the durable idempotency backstop, so the store enforces
      // it — a double that silently accepted a duplicate would make the retry test pass
      // for the wrong reason.
      if (name === "chargerReservation" && rows.some((row) => row.reservationId === data.reservationId)) {
        const error = new Error(`Unique constraint failed on the fields: (\`reservationId\`)`);
        error.code = "P2002";
        error.meta = { target: ["reservationId"] };
        throw error;
      }
      if (name === "chargerAvailabilityProjection" && rows.some((row) => row.version === data.version)) {
        const error = new Error("Unique constraint failed on the fields: (`version`)");
        error.code = "P2002";
        throw error;
      }
      const row = { id: `${name}-${sequence}`, ...data };
      rows.push(row);
      return row;
    },
    async update({ where, data }) {
      const row = rows.find((entry) => entry.id === where.id);
      if (!row) throw new Error("record not found");
      Object.assign(row, data);
      return row;
    },
    async updateMany({ where, data }) {
      const affected = rows.filter((row) => matches(row, where));
      for (const row of affected) Object.assign(row, data);
      return { count: affected.length };
    },
    async findUnique({ where }) {
      const [field, value] = Object.entries(where)[0];
      return rows.find((row) => row[field] === value) || null;
    },
    async upsert({ where, create, update }) {
      const [field, value] = Object.entries(where)[0];
      const row = rows.find((entry) => entry[field] === value);
      if (row) {
        Object.assign(row, update);
        return row;
      }
      sequence += 1;
      const next = { id: `${name}-${sequence}`, ...where, ...create };
      rows.push(next);
      return next;
    },
  });

  const client = {
    charger: table(chargers, "charger"),
    chargerReservation: table(reservations, "chargerReservation"),
    chargerAvailabilityProjection: table(projections, "chargerAvailabilityProjection"),
    agent: table(agents, "agent"),
    _chargers: chargers,
    _reservations: reservations,
    _projections: projections,
    _agents: agents,
  };

  return {
    prisma: client,
    // The store has no isolation to model, so `runSerializable` runs the callback against
    // the same client. What it DOES preserve is that the whole callback runs to completion
    // before the next one starts, which is the property the plug count depends on — and
    // the concurrency tests below drive genuinely overlapping promises through it.
    runSerializable: (clientArg, fn) => fn(clientArg),
    selectForUpdate: async () => null,
  };
}

/** Provision the charger and return the deps every scheduler call takes. */
async function provisionedStore(nowMs = T0) {
  const store = createChargingStore();
  const provisioned = await devChargingScheduler.provision({ prisma: store.prisma }, { nowMs });
  expect(provisioned.ok).toBe(true);
  return { ...store, provisioned };
}

/** Register an agent row (and its Robot projection) in the store. */
function addAgent(store, agentRowId, robotId) {
  store.prisma._agents.push({ id: agentRowId, agentId: robotId, robot: { robotId } });
  return agentRowId;
}

/* ═══════════════════════════════════════════════════════════════════════════
   T1 — simulated charger provisioning
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T1 — the development charger is provisioned into the EXISTING schema", () => {
  test("one Charger row, three plugs declared in the published projection", async () => {
    const store = await provisionedStore();

    expect(store.prisma._chargers).toHaveLength(1);
    const charger = store.prisma._chargers[0];
    expect(charger.chargerId).toBe("DEV-SIM-RNSIT-MBA-01");
    expect(charger.chargerClass).toBe("STANDARD");

    // The plug count lives in the Scheduler's own published artefact, not in a column:
    // §14.5 makes the projection the statement of per-charger reservable capacity, and no
    // migration was added by this batch.
    const capacity = await devChargingScheduler.publishedCapacity({ prisma: store.prisma });
    expect(capacity).toMatchObject({ ok: true, plugCount: 3 });
  });

  test("the charger is NOT a depot, so it cannot enter §14.5's E_return fallback set", async () => {
    const store = await provisionedStore();
    expect(store.prisma._chargers[0].isDepot).toBe(false);
  });

  test("no rated power is asserted — a curve is not a nameplate", async () => {
    const store = await provisionedStore();
    expect(store.prisma._chargers[0].ratedPowerW).toBeNull();
    expect(store.prisma._projections[0].payload.evidence.ratedPowerW).toBeNull();
  });

  test("the projection labels itself development simulation and disclaims physical evidence", async () => {
    const store = await provisionedStore();
    const projection = store.prisma._projections[0];

    expect(projection.publishedBy).toBe(devChargingScheduler.PUBLISHER);
    expect(projection.payload.evidence).toMatchObject({
      kind: "DEVELOPMENT_SIMULATION",
      physicalChargerEvidence: false,
    });
    // The disclaimer is inside the durable row, not only in a source comment: a reader who
    // finds this projection in a database months from now must not have to locate a file
    // to learn what it is.
    expect(projection.payload.evidence.note).toMatch(/no production charger readiness|discharges no V1 stop condition/i);
  });

  test("the coordinates are traceable to the adopted campus extract, and say they are not surveyed", async () => {
    const store = await provisionedStore();
    expect(store.prisma._chargers[0].latitude).toBeCloseTo(12.9009017, 6);
    expect(store.prisma._chargers[0].longitude).toBeCloseTo(77.519021, 6);
    expect(DEVELOPMENT_CHARGER.locationProvenance).toMatch(/way\/204638943/);
    expect(DEVELOPMENT_CHARGER.locationProvenance).toMatch(/NOT a surveyed charger position/);
  });

  test("provisioning is idempotent — a second boot publishes no second version", async () => {
    const store = await provisionedStore();
    const again = await devChargingScheduler.provision({ prisma: store.prisma }, { nowMs: T0 + 60_000 });

    expect(again).toMatchObject({ ok: true, published: false });
    expect(store.prisma._projections).toHaveLength(1);
    expect(store.prisma._chargers).toHaveLength(1);
  });

  test("no plug is granted before a projection exists — capacity is read, never assumed", async () => {
    const store = createChargingStore();
    addAgent(store, "agent-1", "SIM-1");

    const verdict = await devChargingScheduler.requestPlug(store, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 });

    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toMatch(/no availability projection/);
    expect(store.prisma._reservations).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   T2 — three-plug concurrency
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T2 — at most three robots charge at once", () => {
  test("three robots all reach ACTIVE", async () => {
    const store = await provisionedStore();
    for (const n of [1, 2, 3]) addAgent(store, `agent-${n}`, `SIM-${n}`);

    for (const n of [1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      await devChargingScheduler.requestPlug(store, { agentRowId: `agent-${n}`, targetSoc: 0.8, nowMs: T0 + n });
      // eslint-disable-next-line no-await-in-loop
      await devChargingScheduler.promote(store, { nowMs: T0 + n });
    }

    const active = store.prisma._reservations.filter((r) => r.state === RESERVATION_STATE.ACTIVE);
    expect(active).toHaveLength(3);
  });

  test("a FOURTH robot waits — it is QUEUED, never ACTIVE", async () => {
    const store = await provisionedStore();
    for (const n of [1, 2, 3, 4]) addAgent(store, `agent-${n}`, `SIM-${n}`);

    for (const n of [1, 2, 3, 4]) {
      // eslint-disable-next-line no-await-in-loop
      await devChargingScheduler.requestPlug(store, { agentRowId: `agent-${n}`, targetSoc: 0.8, nowMs: T0 + n });
      // eslint-disable-next-line no-await-in-loop
      await devChargingScheduler.promote(store, { nowMs: T0 + n });
    }

    const byState = (state) => store.prisma._reservations.filter((r) => r.state === state).map((r) => r.agentId);
    expect(byState(RESERVATION_STATE.ACTIVE).sort()).toEqual(["agent-1", "agent-2", "agent-3"]);
    expect(byState(RESERVATION_STATE.QUEUED)).toEqual(["agent-4"]);
  });

  test("eight simultaneous requests still leave exactly three charging", async () => {
    const store = await provisionedStore();
    const agents = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => addAgent(store, `agent-${n}`, `SIM-${n}`));

    // Genuinely overlapping: every request is started before any is awaited.
    await Promise.all(
      agents.map((agentRowId, index) =>
        devChargingScheduler.requestPlug(store, { agentRowId, targetSoc: 0.8, nowMs: T0 + index }),
      ),
    );
    await devChargingScheduler.promote(store, { nowMs: T0 + 100 });

    expect(store.prisma._reservations.filter((r) => r.state === RESERVATION_STATE.ACTIVE)).toHaveLength(3);
    expect(store.prisma._reservations.filter((r) => r.state === RESERVATION_STATE.QUEUED)).toHaveLength(5);
    expect(store.prisma._reservations).toHaveLength(8);
  });

  test("the count enforced is the PUBLISHED one, not the module constant", async () => {
    // Republishing with a capacity of one must bind immediately. This is what makes the
    // plug count a property of the durable artefact rather than of a source file that
    // could be edited under a running deployment.
    const store = await provisionedStore();
    for (const n of [1, 2, 3]) addAgent(store, `agent-${n}`, `SIM-${n}`);

    store.prisma._projections[0].payload.chargers[0].plugCount = 1;

    for (const n of [1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      await devChargingScheduler.requestPlug(store, { agentRowId: `agent-${n}`, targetSoc: 0.8, nowMs: T0 + n });
    }
    await devChargingScheduler.promote(store, { nowMs: T0 + 10 });

    expect(store.prisma._reservations.filter((r) => r.state === RESERVATION_STATE.ACTIVE)).toHaveLength(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   T3 — FIFO
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T3 — the queue is FIFO and nobody is starved", () => {
  test("the longest-waiting robot is promoted first", async () => {
    const store = await provisionedStore();
    for (const n of [1, 2, 3, 4, 5]) addAgent(store, `agent-${n}`, `SIM-${n}`);

    // Enqueue in a deliberately non-sorted order of ids, so an implementation that
    // ordered by agent id rather than by arrival would produce a different answer.
    const arrival = [["agent-5", T0 + 10], ["agent-3", T0 + 20], ["agent-1", T0 + 30], ["agent-4", T0 + 40], ["agent-2", T0 + 50]];
    for (const [agentRowId, nowMs] of arrival) {
      // eslint-disable-next-line no-await-in-loop
      await devChargingScheduler.requestPlug(store, { agentRowId, targetSoc: 0.8, nowMs });
    }
    await devChargingScheduler.promote(store, { nowMs: T0 + 60 });

    // Arrival order was 5, 3, 1, 4, 2 — so the three EARLIEST arrivals charge, which is
    // 5, 3 and 1. Note that this is neither the numeric order of the ids nor their
    // insertion order in the store, so an implementation ordering by either would fail.
    const active = store.prisma._reservations
      .filter((r) => r.state === RESERVATION_STATE.ACTIVE)
      .map((r) => r.agentId);
    expect(active.sort()).toEqual(["agent-1", "agent-3", "agent-5"]);

    // And the two latest arrivals are the ones still waiting.
    const queued = store.prisma._reservations
      .filter((r) => r.state === RESERVATION_STATE.QUEUED)
      .map((r) => r.agentId);
    expect(queued.sort()).toEqual(["agent-2", "agent-4"]);
  });

  test("a later arrival never overtakes an earlier one when a plug frees", async () => {
    const store = await provisionedStore();
    for (const n of [1, 2, 3, 4, 5]) addAgent(store, `agent-${n}`, `SIM-${n}`);

    for (const n of [1, 2, 3, 4, 5]) {
      // eslint-disable-next-line no-await-in-loop
      await devChargingScheduler.requestPlug(store, { agentRowId: `agent-${n}`, targetSoc: 0.8, nowMs: T0 + n * 10 });
    }
    await devChargingScheduler.promote(store, { nowMs: T0 + 100 });
    // 1, 2, 3 charging; 4 and 5 waiting, in that order.

    await devChargingScheduler.release(store, { agentRowId: "agent-1", nowMs: T0 + 200, reason: RELEASE_REASON.TARGET_REACHED });

    const stateOf = (id) => store.prisma._reservations.find((r) => r.agentId === id && r.state !== RESERVATION_STATE.RELEASED);
    expect(stateOf("agent-4").state).toBe(RESERVATION_STATE.ACTIVE);
    expect(stateOf("agent-5").state).toBe(RESERVATION_STATE.QUEUED);
  });

  test("a robot that asks repeatedly does not move up the queue", async () => {
    const store = await provisionedStore();
    for (const n of [1, 2, 3, 4, 5]) addAgent(store, `agent-${n}`, `SIM-${n}`);

    for (const n of [1, 2, 3, 4, 5]) {
      // eslint-disable-next-line no-await-in-loop
      await devChargingScheduler.requestPlug(store, { agentRowId: `agent-${n}`, targetSoc: 0.8, nowMs: T0 + n * 10 });
    }
    await devChargingScheduler.promote(store, { nowMs: T0 + 100 });

    // agent-5 (last in the queue) asks twenty more times, as a real agent's tick would.
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await devChargingScheduler.requestPlug(store, { agentRowId: "agent-5", targetSoc: 0.8, nowMs: T0 + 300 + i });
    }
    await devChargingScheduler.release(store, { agentRowId: "agent-2", nowMs: T0 + 400 });

    const live = (id) => store.prisma._reservations.find((r) => r.agentId === id && r.state !== RESERVATION_STATE.RELEASED);
    expect(live("agent-4").state).toBe(RESERVATION_STATE.ACTIVE);
    expect(live("agent-5").state).toBe(RESERVATION_STATE.QUEUED);
    // The re-asks created no rows: `reservedFrom` is still the original enqueue instant.
    expect(store.prisma._reservations.filter((r) => r.agentId === "agent-5")).toHaveLength(1);
    expect(live("agent-5").reservedFrom.getTime()).toBe(T0 + 50);
  });

  test("a free plug is not granted directly to a new arrival while others wait", async () => {
    const store = await provisionedStore();
    for (const n of [1, 2, 3, 4, 5]) addAgent(store, `agent-${n}`, `SIM-${n}`);

    for (const n of [1, 2, 3, 4]) {
      // eslint-disable-next-line no-await-in-loop
      await devChargingScheduler.requestPlug(store, { agentRowId: `agent-${n}`, targetSoc: 0.8, nowMs: T0 + n * 10 });
    }
    await devChargingScheduler.promote(store, { nowMs: T0 + 100 });
    // 1, 2, 3 charging; 4 waiting. Free a plug and, in the same instant, a new robot asks.
    store.prisma._reservations.find((r) => r.agentId === "agent-1").state = RESERVATION_STATE.RELEASED;

    await devChargingScheduler.requestPlug(store, { agentRowId: "agent-5", targetSoc: 0.8, nowMs: T0 + 200 });
    await devChargingScheduler.promote(store, { nowMs: T0 + 201 });

    const live = (id) => store.prisma._reservations.find((r) => r.agentId === id && r.state !== RESERVATION_STATE.RELEASED);
    expect(live("agent-4").state).toBe(RESERVATION_STATE.ACTIVE);
    expect(live("agent-5").state).toBe(RESERVATION_STATE.QUEUED);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   T4 — idempotency
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T4 — a retried request creates no second reservation", () => {
  test("ten identical requests produce one row", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");

    const verdicts = [];
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      verdicts.push(await devChargingScheduler.requestPlug(store, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 + i }));
    }

    expect(store.prisma._reservations).toHaveLength(1);
    expect(verdicts.filter((v) => v.created)).toHaveLength(1);
    expect(verdicts.filter((v) => v.ok && !v.created)).toHaveLength(9);
  });

  test("concurrent duplicate requests produce one row", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");

    await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        devChargingScheduler.requestPlug(store, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 + i }),
      ),
    );

    expect(store.prisma._reservations).toHaveLength(1);
  });

  test("reservationId is deterministic, so the unique index is the durable backstop", () => {
    expect(devChargingScheduler.reservationIdFor("agent-1", 0)).toBe("DEV-SIM-RNSIT-MBA-01:agent-1:0");
    expect(devChargingScheduler.reservationIdFor("agent-1", 0)).toBe(devChargingScheduler.reservationIdFor("agent-1", 0));
    // A genuinely NEW session after a completed one is a new id, not a collision.
    expect(devChargingScheduler.reservationIdFor("agent-1", 1)).not.toBe(devChargingScheduler.reservationIdFor("agent-1", 0));
  });

  test("a second session after a completed one is allowed and is a distinct row", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");

    await devChargingScheduler.requestPlug(store, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 });
    await devChargingScheduler.release(store, { agentRowId: "agent-1", nowMs: T0 + 1000, reason: RELEASE_REASON.TARGET_REACHED });
    await devChargingScheduler.requestPlug(store, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 + 2000 });

    expect(store.prisma._reservations).toHaveLength(2);
    expect(store.prisma._reservations.map((r) => r.reservationId)).toEqual([
      "DEV-SIM-RNSIT-MBA-01:agent-1:0",
      "DEV-SIM-RNSIT-MBA-01:agent-1:1",
    ]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   T5 — completion and release
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T5 — completing a charge releases the plug", () => {
  test("release frees the plug and records why", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");

    await devChargingScheduler.requestPlug(store, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 });
    await devChargingScheduler.promote(store, { nowMs: T0 + 1 });
    await devChargingScheduler.release(store, { agentRowId: "agent-1", nowMs: T0 + 5000, reason: RELEASE_REASON.TARGET_REACHED });

    const row = store.prisma._reservations[0];
    expect(row.state).toBe(RESERVATION_STATE.RELEASED);
    expect(row.externalId).toBe(RELEASE_REASON.TARGET_REACHED);
    expect(await devChargingScheduler.liveReservationFor({ prisma: store.prisma }, "agent-1")).toBeNull();
  });

  test("release is idempotent — releasing twice is not an error", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");
    await devChargingScheduler.requestPlug(store, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 });

    const first = await devChargingScheduler.release(store, { agentRowId: "agent-1", nowMs: T0 + 100 });
    const second = await devChargingScheduler.release(store, { agentRowId: "agent-1", nowMs: T0 + 200 });

    expect(first.released).toBe(true);
    expect(second.released).toBe(false);
    expect(second.ok).toBe(true);
  });

  test("a released reservation's window is closed, so no interval reader sees it as live", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");
    await devChargingScheduler.requestPlug(store, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 });
    await devChargingScheduler.release(store, { agentRowId: "agent-1", nowMs: T0 + 5000 });

    const row = store.prisma._reservations[0];
    expect(row.reservedUntil.getTime()).toBe(T0 + 5000);
    // The schema's CHECK requires `reservedUntil > reservedFrom`, so an instantaneous
    // release must still advance by at least a millisecond.
    expect(row.reservedUntil.getTime()).toBeGreaterThan(row.reservedFrom.getTime());
  });

  test("the target SoC rides with the reservation and is never computed by the scheduler", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");
    await devChargingScheduler.requestPlug(store, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 });

    expect(store.prisma._reservations[0].targetSoc).toBe(0.8);

    // A request that carries none writes none — the scheduler does not substitute a value
    // of its own. §14.6: computing a target would transfer ownership of the decision.
    addAgent(store, "agent-2", "SIM-2");
    await devChargingScheduler.requestPlug(store, { agentRowId: "agent-2", targetSoc: null, nowMs: T0 + 1 });
    expect(store.prisma._reservations[1].targetSoc).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   T6 — chargingStatusFor
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T6 — chargingStatusFor answers from the reservation projection", () => {
  const inScopeAlways = async () => true;

  test("an in-scope agent with no reservation is authoritatively NOT charging", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");
    const read = chargingStatusService.createChargingStatusReader({ prisma: store.prisma, inScope: inScopeAlways });

    expect(await read("agent-1")).toMatchObject({ known: true, charging: false, waiting: false });
  });

  test("a QUEUED agent is waiting — not charging, and not ready either", async () => {
    const store = await provisionedStore();
    for (const n of [1, 2, 3, 4]) addAgent(store, `agent-${n}`, `SIM-${n}`);
    for (const n of [1, 2, 3, 4]) {
      // eslint-disable-next-line no-await-in-loop
      await devChargingScheduler.requestPlug(store, { agentRowId: `agent-${n}`, targetSoc: 0.8, nowMs: T0 + n });
    }
    await devChargingScheduler.promote(store, { nowMs: T0 + 10 });

    const read = chargingStatusService.createChargingStatusReader({ prisma: store.prisma, inScope: inScopeAlways });
    expect(await read("agent-4")).toMatchObject({ known: true, charging: false, waiting: true });
  });

  test("an ACTIVE agent is charging, and the session is NOT interruptible", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");
    await devChargingScheduler.requestPlug(store, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 });
    await devChargingScheduler.promote(store, { nowMs: T0 + 1 });

    const read = chargingStatusService.createChargingStatusReader({ prisma: store.prisma, inScope: inScopeAlways });
    // §14.6 condition (b) — the Scheduler confirms the interruption leaves the fleet's
    // availability floor intact. This scheduler publishes no floor and confirms nothing,
    // and §14.7 says an unstated condition is not a satisfied one.
    expect(await read("agent-1")).toMatchObject({ known: true, charging: true, chargingInterruptible: false });
  });

  test("no projected free time is invented — there is no authoritative state of charge", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");
    await devChargingScheduler.requestPlug(store, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 });
    await devChargingScheduler.promote(store, { nowMs: T0 + 1 });

    const read = chargingStatusService.createChargingStatusReader({ prisma: store.prisma, inScope: inScopeAlways });
    expect((await read("agent-1")).projectedFreeAtMs).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   T15 — unknown fails closed
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T15 — an unestablished charging state is never 'ready'", () => {
  test("an OUT-OF-SCOPE agent is unknown, not 'not charging'", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");
    const read = chargingStatusService.createChargingStatusReader({ prisma: store.prisma, inScope: async () => false });

    const verdict = await read("agent-1");
    expect(verdict.known).toBe(false);
    expect(verdict.reason).toMatch(/B2|no Charging Scheduler covers/);
  });

  test("an ABSENT scope predicate makes everything unknown", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");
    const read = chargingStatusService.createChargingStatusReader({ prisma: store.prisma });

    expect((await read("agent-1")).known).toBe(false);
  });

  test("a scope predicate that returns a truthy non-true value is still refused", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");
    const read = chargingStatusService.createChargingStatusReader({ prisma: store.prisma, inScope: async () => "yes" });

    expect((await read("agent-1")).known).toBe(false);
  });

  test("a read failure is unknown, not 'not charging'", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");
    store.prisma.chargerReservation.findFirst = async () => {
      throw new Error("connection reset");
    };
    const read = chargingStatusService.createChargingStatusReader({ prisma: store.prisma, inScope: async () => true });

    const verdict = await read("agent-1");
    expect(verdict.known).toBe(false);
    expect(verdict.charging).toBe(false);
    expect(verdict.reason).toMatch(/could not be read/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   T7 — the index maintainer's classifier behaviour
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T7 — the index maintainer fails closed on charging state", () => {
  /** The maintainer's own reads, for one indexable agent. */
  function maintainerStore() {
    const rows = new Map();
    return {
      rows,
      agent: {
        findUnique: async () => ({ id: "a1", agentId: "RBT-1", lifecycleState: "ACTIVE", agentClassId: null, capacityOverride: 2 }),
        findMany: async () => [{ id: "a1" }],
      },
      observation: {
        findFirst: async () => ({ value: { lat: BENGALURU.lat, lon: BENGALURU.lon, provenance: "SIMULATED" }, observedAt: new Date(T0) }),
      },
      commitment: { count: async () => 0 },
      agentCellPosition: {
        findUnique: async ({ where }) => rows.get(where.agentId) || null,
        upsert: async ({ where, create, update }) => {
          const existing = rows.get(where.agentId);
          const next = existing ? { ...existing, ...update } : { ...create };
          rows.set(where.agentId, next);
          return next;
        },
        delete: async ({ where }) => { rows.delete(where.agentId); },
      },
    };
  }

  const sweep = (prisma, chargingStatusFor) =>
    indexMaintainer.sweepAgents({ prisma, kv: null, chargingStatusFor }, ["a1"]);

  test("NO classifier at all indexes NOTHING — the old default is gone", async () => {
    const prisma = maintainerStore();
    const outcome = await indexMaintainer.sweepAgents({ prisma, kv: null }, ["a1"]);

    expect(outcome).toMatchObject({ processed: 1, indexed: 0 });
    expect(prisma.rows.size).toBe(0);
  });

  test("known:false indexes nothing", async () => {
    const prisma = maintainerStore();
    await sweep(prisma, async () => ({ known: false, charging: false, chargingInterruptible: false, waiting: false, projectedFreeAtMs: null }));
    expect(prisma.rows.size).toBe(0);
  });

  test("a classifier returning the OLD three-field shape is treated as an absence", async () => {
    // The regression guard for this batch's whole point: a producer written against the
    // pre-Batch-2 contract must not be able to widen an agent into IDLE_READY by omission.
    const prisma = maintainerStore();
    await sweep(prisma, async () => ({ charging: false, chargingInterruptible: false, projectedFreeAtMs: null }));
    expect(prisma.rows.size).toBe(0);
  });

  test("waiting:true indexes nothing", async () => {
    const prisma = maintainerStore();
    await sweep(prisma, async () => ({ known: true, charging: false, chargingInterruptible: false, waiting: true, projectedFreeAtMs: null }));
    expect(prisma.rows.size).toBe(0);
  });

  test("a charging, non-interruptible agent indexes nothing (§6.3 tier 5)", async () => {
    const prisma = maintainerStore();
    await sweep(prisma, async () => ({ known: true, charging: true, chargingInterruptible: false, waiting: false, projectedFreeAtMs: null }));
    expect(prisma.rows.size).toBe(0);
  });

  test("known:true + not charging is the ONE verdict that indexes, and it lands IDLE_READY", async () => {
    const prisma = maintainerStore();
    const outcome = await sweep(prisma, async () => ({ known: true, charging: false, chargingInterruptible: false, waiting: false, projectedFreeAtMs: null }));

    expect(outcome).toMatchObject({ processed: 1, indexed: 1, failed: 0 });
    expect(prisma.rows.get("a1")).toMatchObject({ agentId: "a1", availabilityClass: "IDLE_READY" });
  });

  test("an agent that becomes unknown is REMOVED from the mirror", async () => {
    const prisma = maintainerStore();
    await sweep(prisma, async () => ({ known: true, charging: false, chargingInterruptible: false, waiting: false, projectedFreeAtMs: null }));
    expect(prisma.rows.size).toBe(1);

    const outcome = await sweep(prisma, async () => ({ known: false, charging: false, chargingInterruptible: false, waiting: false, projectedFreeAtMs: null }));
    expect(outcome).toMatchObject({ removed: 1 });
    expect(prisma.rows.size).toBe(0);
  });

  test("end to end: a charging robot is not indexed, and is once it finishes", async () => {
    // The two halves joined — the real classifier over the real scheduler, driving the
    // real worker. This is the property Batch 2 exists to establish.
    const store = await provisionedStore();
    addAgent(store, "a1", "RBT-1");
    const prisma = maintainerStore();
    prisma.agent.findUnique = async () => ({ id: "a1", agentId: "RBT-1", lifecycleState: "ACTIVE", agentClassId: null, capacityOverride: 2 });

    const read = chargingStatusService.createChargingStatusReader({ prisma: store.prisma, inScope: async () => true });

    await devChargingScheduler.requestPlug(store, { agentRowId: "a1", targetSoc: 0.8, nowMs: T0 });
    await devChargingScheduler.promote(store, { nowMs: T0 + 1 });
    await sweep(prisma, read);
    expect(prisma.rows.size).toBe(0);

    await devChargingScheduler.release(store, { agentRowId: "a1", nowMs: T0 + 5000, reason: RELEASE_REASON.TARGET_REACHED });
    await sweep(prisma, read);
    expect(prisma.rows.get("a1")).toMatchObject({ availabilityClass: "IDLE_READY" });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   T11 — physical agents
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T11 — a physical agent never receives simulated charging state", () => {
  test("a physical agent is out of scope and is therefore unknown, never 'free'", async () => {
    const store = await provisionedStore();
    addAgent(store, "sim-agent", "SIM-1");
    addAgent(store, "physical-agent", "RBT-PHYS");

    // The scope predicate is the simulator's roster; a physical unit is not in it, because
    // `SimulationEngine.addRobot` refuses to build a VirtualRobot for one.
    const roster = new Set(["SIM-1"]);
    const read = chargingStatusService.createChargingStatusReader({
      prisma: store.prisma,
      inScope: async (subject) => roster.has(subject.robotId),
    });

    expect((await read("sim-agent")).known).toBe(true);
    expect((await read("physical-agent")).known).toBe(false);
  });

  test("the scheduler has no inbound request path a physical agent could reach", () => {
    // Structural. The scope argument rests on there being no socket handler, no HTTP
    // route and no queue through which an arbitrary agent can ask for a plug — the only
    // callers hold the roster. A route added later would show up here.
    const fs = require("fs");
    const path = require("path");
    const root = path.join(__dirname, "..", "..", "src");
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) {
          const source = fs.readFileSync(full, "utf8");
          if (/require\(["'][^"']*devChargingScheduler["']\)/.test(source)) {
            hits.push(path.relative(root, full).replace(/\\/g, "/"));
          }
        }
      }
    };
    walk(root);

    // Exactly three readers: the scheduler's own driver (which holds the roster), the
    // agent (for the release-reason vocabulary), and the status reader the engine's worker
    // is composed with. No controller, no route, no socket handler.
    expect(hits.sort()).toEqual([
      "services/chargingStatus.service.js",
      "simulation/SimulationEngine.js",
      "simulation/VirtualRobot.js",
    ]);
  });

  test("no charging row is written for an agent nobody asked for", async () => {
    const store = await provisionedStore();
    addAgent(store, "physical-agent", "RBT-PHYS");

    const read = chargingStatusService.createChargingStatusReader({
      prisma: store.prisma,
      inScope: async () => false,
    });
    await read("physical-agent");

    expect(store.prisma._reservations).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   T14 — restart / reconciliation
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T14 — a restart does not leak plugs", () => {
  test("a reservation past its published window is expired and the plug is refilled", async () => {
    const store = await provisionedStore();
    for (const n of [1, 2, 3, 4]) addAgent(store, `agent-${n}`, `SIM-${n}`);
    for (const n of [1, 2, 3, 4]) {
      // eslint-disable-next-line no-await-in-loop
      await devChargingScheduler.requestPlug(store, { agentRowId: `agent-${n}`, targetSoc: 0.8, nowMs: T0 + n });
    }
    await devChargingScheduler.promote(store, { nowMs: T0 + 10 });

    const horizon = devChargingScheduler.sessionHorizonSeconds(1000);
    expect(horizon.ok).toBe(true);

    // A process died. Time passes beyond every window.
    const later = T0 + horizon.seconds * 1000 + 60_000;
    const outcome = await devChargingScheduler.reconcile(store, { nowMs: later });

    expect(outcome.expired).toBe(4);
    expect(store.prisma._reservations.every((r) => r.state === RESERVATION_STATE.RELEASED)).toBe(true);
    expect(store.prisma._reservations.every((r) => r.externalId === RELEASE_REASON.STALE_EXPIRED)).toBe(true);
  });

  test("reconcile does NOT expire a session that is still inside its window", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");
    await devChargingScheduler.requestPlug(store, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 });
    await devChargingScheduler.promote(store, { nowMs: T0 + 1 });

    const outcome = await devChargingScheduler.reconcile(store, { nowMs: T0 + 60_000 });

    expect(outcome.expired).toBe(0);
    expect(store.prisma._reservations[0].state).toBe(RESERVATION_STATE.ACTIVE);
  });

  test("the session window is DERIVED from the protected curve, not chosen", () => {
    const horizon = devChargingScheduler.sessionHorizonSeconds(1000);
    const chargeCurve = require("../../src/engine/energy/chargeCurve");
    const constants = require("../../src/simulation/constants");

    // The worst case the declared inputs admit: a full charge at the coldest temperature
    // in the declared derating table.
    const expected = chargeCurve.timeToChargeSeconds({
      curve: constants.CHARGE_POWER_CURVE,
      fromSoc: 0,
      toSoc: 1,
      tempC: -10,
      chargerClass: "STANDARD",
      packUsableWh: 1000,
      steps: constants.CHARGE_CURVE_INTEGRATION_STEPS,
    });

    expect(horizon.tempC).toBe(-10);
    expect(horizon.seconds).toBe(Math.ceil(expected.seconds));
  });

  test("a fresh process reconciles before granting, so a full charger recovers", async () => {
    const store = await provisionedStore();
    for (const n of [1, 2, 3]) addAgent(store, `agent-${n}`, `SIM-${n}`);
    for (const n of [1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      await devChargingScheduler.requestPlug(store, { agentRowId: `agent-${n}`, targetSoc: 0.8, nowMs: T0 + n });
    }
    const promotedAt = T0 + 10;
    await devChargingScheduler.promote(store, { nowMs: promotedAt });

    // The window a session is expired against runs from the instant the plug was GRANTED,
    // not from the instant the robot joined the queue — `promote` re-stamps
    // `reservedUntil` so a robot that waited an hour still gets its full session. So the
    // "process died" instant has to be past `promotedAt + horizon`, and an earlier one
    // correctly expires nothing.
    const horizon = devChargingScheduler.sessionHorizonSeconds(1000);
    const later = promotedAt + horizon.seconds * 1000 + 1;

    addAgent(store, "agent-9", "SIM-9");
    await devChargingScheduler.reconcile(store, { nowMs: later });
    await devChargingScheduler.requestPlug(store, { agentRowId: "agent-9", targetSoc: 0.8, nowMs: later + 1 });
    await devChargingScheduler.promote(store, { nowMs: later + 2 });

    const live = store.prisma._reservations.find((r) => r.agentId === "agent-9");
    expect(live.state).toBe(RESERVATION_STATE.ACTIVE);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   T12 / T13 — disconnect and reconnect
   ═══════════════════════════════════════════════════════════════════════════ */

describe("T12/T13 — a disconnect does not corrupt the queue", () => {
  test("a waiting robot that reconnects keeps its place, it does not go to the back", async () => {
    const store = await provisionedStore();
    for (const n of [1, 2, 3, 4, 5]) addAgent(store, `agent-${n}`, `SIM-${n}`);
    for (const n of [1, 2, 3, 4, 5]) {
      // eslint-disable-next-line no-await-in-loop
      await devChargingScheduler.requestPlug(store, { agentRowId: `agent-${n}`, targetSoc: 0.8, nowMs: T0 + n * 10 });
    }
    await devChargingScheduler.promote(store, { nowMs: T0 + 100 });

    // agent-4 disconnects and reconnects; on reconnect its tick asks again. The
    // reservation is durable, so the request finds it and returns it unchanged.
    const before = store.prisma._reservations.find((r) => r.agentId === "agent-4");
    const verdict = await devChargingScheduler.requestPlug(store, { agentRowId: "agent-4", targetSoc: 0.8, nowMs: T0 + 9999 });

    expect(verdict.created).toBe(false);
    expect(verdict.reservation.reservedFrom.getTime()).toBe(before.reservedFrom.getTime());
    expect(store.prisma._reservations.filter((r) => r.agentId === "agent-4")).toHaveLength(1);
  });

  test("a charging robot that reconnects is still charging — the plug is durable", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");
    await devChargingScheduler.requestPlug(store, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 });
    await devChargingScheduler.promote(store, { nowMs: T0 + 1 });

    const onReconnect = await devChargingScheduler.liveReservationFor({ prisma: store.prisma }, "agent-1");
    expect(onReconnect.state).toBe(RESERVATION_STATE.ACTIVE);

    const read = chargingStatusService.createChargingStatusReader({ prisma: store.prisma, inScope: async () => true });
    expect(await read("agent-1")).toMatchObject({ known: true, charging: true });
  });

  test("a disconnected robot's plug is eventually recovered by its window, not held forever", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");
    await devChargingScheduler.requestPlug(store, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 });
    await devChargingScheduler.promote(store, { nowMs: T0 + 1 });

    const horizon = devChargingScheduler.sessionHorizonSeconds(1000);
    await devChargingScheduler.reconcile(store, { nowMs: T0 + horizon.seconds * 1000 + 2 });

    expect(store.prisma._reservations[0].state).toBe(RESERVATION_STATE.RELEASED);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Determinism, and the boundary this batch must not cross
   ═══════════════════════════════════════════════════════════════════════════ */

describe("determinism and the production boundary", () => {
  test("the scheduler reads no clock and draws no randomness", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "simulation", "devChargingScheduler.js"),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/Date\.now\(\)/);
  });

  test("the same queue promotes the same robot on two independent runs", async () => {
    const run = async () => {
      const store = await provisionedStore();
      for (const n of [1, 2, 3, 4, 5, 6]) addAgent(store, `agent-${n}`, `SIM-${n}`);
      // Every arrival at the SAME instant, so only the tiebreak decides.
      for (const n of [6, 5, 4, 3, 2, 1]) {
        // eslint-disable-next-line no-await-in-loop
        await devChargingScheduler.requestPlug(store, { agentRowId: `agent-${n}`, targetSoc: 0.8, nowMs: T0 });
      }
      await devChargingScheduler.promote(store, { nowMs: T0 + 1 });
      return store.prisma._reservations
        .filter((r) => r.state === RESERVATION_STATE.ACTIVE)
        .map((r) => r.agentId)
        .sort();
    };

    expect(await run()).toEqual(await run());
  });

  test("a serialisation failure is a RESULT, not a crash — and never a grant", async () => {
    // Found on a live database and nowhere else: five simultaneous `requestPlug` calls
    // under real SERIALIZABLE isolation produce `40001`, and this module used to let it
    // escape as an exception. The in-memory store cannot reproduce it — it has no
    // isolation to fail — so the failure is injected here directly.
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");

    const conflicting = {
      ...store,
      runSerializable: async () => {
        const error = new Error("Transaction failed due to a write conflict or a deadlock. Please retry your transaction");
        error.code = "P2034";
        throw error;
      },
      isSerializationFailure: (error) => error && error.code === "P2034",
    };

    const verdict = await devChargingScheduler.requestPlug(conflicting, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 });

    expect(verdict.ok).toBe(false);
    expect(verdict.retryable).toBe(true);
    // The decisive half: a conflict must not read as a grant, and must not have written.
    expect(verdict.reservation).toBeNull();
    expect(verdict.created).toBe(false);
    expect(store.prisma._reservations).toHaveLength(0);
  });

  test("an error that is NOT a serialisation failure still propagates", async () => {
    // The conflict handler is narrow on purpose. A schema error or a lost connection must
    // not be reported as "retryable", because the agent would then retry forever against
    // a fault nobody is told about.
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");

    const broken = {
      ...store,
      runSerializable: async () => { throw new Error("column \"nope\" does not exist"); },
      isSerializationFailure: () => false,
    };

    await expect(
      devChargingScheduler.requestPlug(broken, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 }),
    ).rejects.toThrow(/does not exist/);
  });

  test("a release that could not serialise does NOT report the plug as freed", async () => {
    const store = await provisionedStore();
    addAgent(store, "agent-1", "SIM-1");
    await devChargingScheduler.requestPlug(store, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 });
    await devChargingScheduler.promote(store, { nowMs: T0 + 1 });

    const conflicting = {
      ...store,
      runSerializable: async () => {
        const error = new Error("could not serialize access due to read/write dependencies");
        error.code = "40001";
        throw error;
      },
      isSerializationFailure: (error) => error && error.code === "40001",
    };

    const verdict = await devChargingScheduler.release(conflicting, { agentRowId: "agent-1", nowMs: T0 + 100 });

    expect(verdict.ok).toBe(false);
    expect(verdict.released).toBe(false);
    // The plug is still held, because the transaction rolled back.
    expect(store.prisma._reservations[0].state).toBe(RESERVATION_STATE.ACTIVE);
  });

  test("the batch adds no Prisma model, column or migration", () => {
    const fs = require("fs");
    const path = require("path");
    const root = path.join(__dirname, "..", "..", "prisma");
    const schema = fs.readFileSync(path.join(root, "schema.prisma"), "utf8");

    // The three tables the scheduler publishes into are the Phase 7 ones, unchanged.
    const charger = /model Charger \{[\s\S]*?\n\}/.exec(schema)[0];
    expect(charger).not.toMatch(/\bsimulated\b/);
    expect(charger).not.toMatch(/plugCount/);

    const reservation = /model ChargerReservation \{[\s\S]*?\n\}/.exec(schema)[0];
    expect(reservation).not.toMatch(/plugIndex/);
    expect(reservation).not.toMatch(/\bsimulated\b/);

    // And no migration directory was added for charging.
    const migrations = fs.readdirSync(path.join(root, "migrations")).filter((name) => /charg/i.test(name));
    expect(migrations).toEqual([]);
  });

  test("the registry row that moved names what it does NOT claim", () => {
    const registry = require("../../src/workers/registry");
    const row = registry.WORKER_BY_ID.index_maintainer;

    expect(row.readiness).toBe(registry.READINESS.SCHEDULED);
    expect(row.blockedBy).toBeNull();
    // A SCHEDULED row with no cadence parameter must say what governs it instead.
    expect(row.cadenceNote).toBeTruthy();
  });
});

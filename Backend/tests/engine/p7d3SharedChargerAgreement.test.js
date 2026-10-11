"use strict";

/**
 * P7-D3 Step 0 — one charger for the simulated fleet: the V1 depot.
 *
 * Owner decision (2026-10-10, Option B of the P7-D3 audit): `V1DEMO-DEPOT-01` is the single
 * charging target the assignment engine and the simulator share. Before it, the engine priced
 * every return to the depot (the only admissible target under the DEPOT_ONLY fallback, and not
 * covered by the scheduler's projection under the pinned basis) while the simulator reserved
 * `DEV-SIM-RNSIT-MBA-01`.
 *
 * Pinned here:
 *   · the charger the simulator reserves IS the charger the engine's E_return chooses — under
 *     DEPOT_ONLY and under a fresh pinned projection — even when the superseded development
 *     charger is nearer;
 *   · a live reservation left at the superseded charger is released (`CHARGER_SUPERSEDED`) by
 *     the next plug request and by `reconcile`, so no agent keeps holding it and it does not
 *     count against the depot's plugs;
 *   · plug capacity, FIFO and idempotency hold at the depot;
 *   · neither charger row is written.
 * Untouched by this step and not asserted to change: 1.15 / 1.25, DEPOT_ONLY, projection
 * freshness, exact-coordinate return pricing, ranking, docking/movement, P7-D1, STOP/RESUME.
 *
 * MOCKED BOUNDARY: a small working in-memory store (rows in, queries read them back), the
 * same discipline as `devChargingScheduler.test.js`; `phase7World` for the real decision path.
 */

const devChargingScheduler = require("../../src/simulation/devChargingScheduler");
const chargingStatusService = require("../../src/services/chargingStatus.service");
const eReturn = require("../../src/engine/energy/eReturn");
const schedulerClient = require("../../src/engine/energy/chargingSchedulerClient");
const w = require("./helpers/phase7World");

jest.setTimeout(60_000);

const { RESERVATION_STATE, RELEASE_REASON, DEVELOPMENT_CHARGER } = devChargingScheduler;
const T0 = 1_790_000_000_000;
const DEPOT_ROW = Object.freeze({
  id: "charger-depot",
  chargerId: "V1DEMO-DEPOT-01",
  regionId: "region-rnsit",
  cellId: "8b6014510498fff",
  chargerClass: "STANDARD",
  isDepot: true,
  latitude: 12.900729,
  longitude: 77.517603,
});
const LEGACY_ROW = Object.freeze({
  id: "charger-dev-sim",
  chargerId: "DEV-SIM-RNSIT-MBA-01",
  regionId: null,
  cellId: "8b6014510496fff",
  chargerClass: "STANDARD",
  isDepot: false,
  latitude: 12.9009017,
  longitude: 77.519021,
});

/* ── A small working store ─────────────────────────────────────────────────── */

function matches(row, where) {
  for (const [field, condition] of Object.entries(where || {})) {
    const value = row[field];
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      if (Array.isArray(condition.in) && !condition.in.includes(value)) return false;
      if (condition.lt !== undefined && !(value.getTime() < condition.lt.getTime())) return false;
      continue;
    }
    if (value !== condition) return false;
  }
  return true;
}

function ordered(rows, orderBy) {
  const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const [field, direction] = Object.entries(clause)[0];
      const left = a[field] instanceof Date ? a[field].getTime() : a[field];
      const right = b[field] instanceof Date ? b[field].getTime() : b[field];
      if (left < right) return direction === "desc" ? 1 : -1;
      if (left > right) return direction === "desc" ? -1 : 1;
    }
    return 0;
  });
}

function store({ chargers = [DEPOT_ROW, LEGACY_ROW] } = {}) {
  let sequence = 0;
  const tables = { charger: chargers.map((row) => ({ ...row })), chargerReservation: [], chargerAvailabilityProjection: [], agent: [] };
  const writes = [];
  const table = (name) => {
    const rows = tables[name];
    return {
      async findFirst({ where, orderBy } = {}) { return ordered(rows.filter((row) => matches(row, where)), orderBy)[0] || null; },
      async findMany({ where, orderBy, take } = {}) {
        const found = ordered(rows.filter((row) => matches(row, where)), orderBy);
        return take === undefined ? found : found.slice(0, take);
      },
      async count({ where } = {}) { return rows.filter((row) => matches(row, where)).length; },
      async findUnique({ where }) {
        const [field, value] = Object.entries(where)[0];
        return rows.find((row) => row[field] === value) || null;
      },
      async create({ data }) {
        writes.push({ table: name, op: "create" });
        if (name === "chargerReservation" && rows.some((row) => row.reservationId === data.reservationId)) {
          throw Object.assign(new Error("Unique constraint failed on the fields: (`reservationId`)"), { code: "P2002" });
        }
        sequence += 1;
        const row = { id: `${name}-${sequence}`, ...data };
        rows.push(row);
        return row;
      },
      async update({ where, data }) {
        writes.push({ table: name, op: "update" });
        const row = rows.find((entry) => entry.id === where.id);
        Object.assign(row, data);
        return row;
      },
      async updateMany({ where, data }) {
        writes.push({ table: name, op: "updateMany" });
        const affected = rows.filter((row) => matches(row, where));
        for (const row of affected) Object.assign(row, data);
        return { count: affected.length };
      },
      async upsert() { writes.push({ table: name, op: "upsert" }); throw new Error("no upsert expected"); },
    };
  };
  const prisma = {
    charger: table("charger"),
    chargerReservation: table("chargerReservation"),
    chargerAvailabilityProjection: table("chargerAvailabilityProjection"),
    agent: table("agent"),
  };
  return {
    prisma,
    tables,
    writes,
    deps: { prisma, runSerializable: (client, fn) => fn(client), selectForUpdate: async () => null },
  };
}

/** A live reservation left at the superseded charger by a process that booted on the old estate. */
function legacyReservation(s, agentId, state, fromMs) {
  s.tables.chargerReservation.push({
    id: `legacy-${agentId}`,
    reservationId: `DEV-SIM-RNSIT-MBA-01:${agentId}:0`,
    agentId,
    chargerDbId: LEGACY_ROW.id,
    reservedFrom: new Date(fromMs),
    reservedUntil: new Date(fromMs + 7_200_000),
    targetSoc: 0.8,
    state,
    projectionVersion: 1,
  });
}

const chargerOf = (s, reservation) => s.tables.charger.find((row) => row.id === reservation.chargerDbId).chargerId;

/* ═══════════════════════════════════════════════════════════════════════════
   1. The engine's return target and the simulator's reservation are one charger
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D3 Step 0 — engine and simulator agree on the charger", () => {
  /** The estate as `chargerCandidatesFor` hands it to `eReturn`, nearest first: the superseded charger is NEARER. */
  const candidates = [
    { chargerId: LEGACY_ROW.chargerId, chargerClass: "STANDARD", isDepot: false, distanceM: 40, travelSeconds: 30, energyWh: 3 },
    { chargerId: DEPOT_ROW.chargerId, chargerClass: "STANDARD", isDepot: true, distanceM: 66, travelSeconds: 57, energyWh: 5.21 },
  ];
  const energy = {
    usableWh: 145, missionWh: 69.5, floorWh: 25, availabilityMargin: 1.15, projectionMaxAgeSeconds: 120, uncalibratedReserveFactor: 1.25,
  };

  let s;
  let reserved;
  beforeAll(async () => {
    s = store();
    const provisioned = await devChargingScheduler.provision(s.deps, { nowMs: T0 });
    expect(provisioned.ok).toBe(true);
    const verdict = await devChargingScheduler.requestPlug(s.deps, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 });
    expect(verdict.ok).toBe(true);
    reserved = chargerOf(s, verdict.reservation);
  });

  test("the simulator reserves the depot, never the superseded development charger", () => {
    expect(reserved).toBe("V1DEMO-DEPOT-01");
    expect(reserved).toBe(DEVELOPMENT_CHARGER.chargerId);
    expect(s.tables.chargerReservation.every((row) => row.chargerDbId === DEPOT_ROW.id)).toBe(true);
  });

  test("DEPOT_ONLY (no fresh projection — LOCAL's case): the engine's E_return target is the same charger, ×1.4375 unchanged", () => {
    const out = eReturn.evaluate({ ...energy, candidates, projection: null, decisionTimeMs: T0, projectedEndMs: T0 + 600_000 });
    expect(out.basis).toBe("DEPOT_ONLY");
    expect(out.verdict.chargerId).toBe(reserved);
    expect(out.verdict.eReturnWh / 5.21).toBeCloseTo(1.15 * 1.25, 12);
  });

  test("PINNED (a fresh projection from this scheduler): the engine's target is still the same charger, ×1.15 unchanged", () => {
    const row = s.tables.chargerAvailabilityProjection[s.tables.chargerAvailabilityProjection.length - 1];
    const consumed = schedulerClient.consumeProjection({ version: row.version, publishedAt: row.publishedAt, horizonEnd: row.horizonEnd, chargers: row.payload.chargers });
    expect(consumed.ok).toBe(true);
    // The projection covers the depot only; the superseded charger is not in it.
    expect(consumed.projection.chargers.map((entry) => entry.chargerId)).toEqual(["V1DEMO-DEPOT-01"]);
    const out = eReturn.evaluate({ ...energy, candidates, projection: consumed.projection, decisionTimeMs: T0 + 60_000, projectedEndMs: T0 + 600_000 });
    expect(out.basis).toBe("PINNED_PROJECTION");
    expect(out.verdict.chargerId).toBe(reserved);
    expect(out.verdict.considered.find((entry) => entry.chargerId === LEGACY_ROW.chargerId)).toMatchObject({ admitted: false });
    expect(out.verdict.eReturnWh / 5.21).toBeCloseTo(1.15, 12);
  });

  test("no Charger row is created or written — neither the depot nor the superseded one", () => {
    expect(s.writes.filter((entry) => entry.table === "charger")).toEqual([]);
    expect(s.tables.charger).toEqual([DEPOT_ROW, LEGACY_ROW]);
  });

  test("the real decision path (TSK-816): E_return's chosen charger is the scheduler's declared charger", async () => {
    const calls = [];
    const original = eReturn.evaluate;
    const spy = jest.spyOn(eReturn, "evaluate").mockImplementation((input) => {
      const result = original(input);
      calls.push(result);
      return result;
    });
    try {
      await w.decide({
        decisionTimeMs: w.TSK816.assignRoundMs,
        robots: [{ robotId: "SIM-0A8C043FFE67", at: { lat: 12.901151, lon: 77.517575 }, socFraction: 0.29, status: "IDLE", positionAgeMs: 351 }],
      });
    } finally {
      spy.mockRestore();
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const result of calls) expect(result.verdict.chargerId).toBe(DEVELOPMENT_CHARGER.chargerId);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. Reservations left at the superseded charger
   ═══════════════════════════════════════════════════════════════════════════ */

describe("P7-D3 Step 0 — a reservation left at the superseded charger is released, never inherited", () => {
  test("the next plug request releases it (CHARGER_SUPERSEDED) and reserves the depot instead", async () => {
    const s = store();
    legacyReservation(s, "agent-1", RESERVATION_STATE.ACTIVE, T0 - 3_600_000);
    await devChargingScheduler.provision(s.deps, { nowMs: T0 });

    const verdict = await devChargingScheduler.requestPlug(s.deps, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 });

    expect(verdict).toMatchObject({ ok: true, created: true });
    expect(chargerOf(s, verdict.reservation)).toBe("V1DEMO-DEPOT-01");
    const legacy = s.tables.chargerReservation.find((row) => row.id === "legacy-agent-1");
    expect(legacy).toMatchObject({ state: RESERVATION_STATE.RELEASED, externalId: RELEASE_REASON.CHARGER_SUPERSEDED });
    expect(legacy.reservedUntil.getTime()).toBe(T0); // closed at the release instant, after reservedFrom
    const live = await devChargingScheduler.liveReservationFor(s.deps, "agent-1");
    expect(live.chargerDbId).toBe(DEPOT_ROW.id);
  });

  test("reconcile releases every agent's superseded reservation, idempotently, and touches nothing else", async () => {
    const s = store();
    legacyReservation(s, "agent-1", RESERVATION_STATE.ACTIVE, T0 - 3_600_000);
    legacyReservation(s, "agent-2", RESERVATION_STATE.QUEUED, T0 - 1_800_000);
    s.tables.chargerReservation.push({
      id: "legacy-done", reservationId: "DEV-SIM-RNSIT-MBA-01:agent-3:0", agentId: "agent-3", chargerDbId: LEGACY_ROW.id,
      reservedFrom: new Date(T0 - 9_000_000), reservedUntil: new Date(T0 - 8_000_000), state: RESERVATION_STATE.RELEASED, externalId: RELEASE_REASON.TARGET_REACHED,
    });
    await devChargingScheduler.provision(s.deps, { nowMs: T0 });

    const first = await devChargingScheduler.reconcile(s.deps, { nowMs: T0 });
    const second = await devChargingScheduler.reconcile(s.deps, { nowMs: T0 + 10_000 });

    expect(first).toMatchObject({ ok: true, superseded: 2 });
    expect(second).toMatchObject({ ok: true, superseded: 0 });
    const byId = Object.fromEntries(s.tables.chargerReservation.map((row) => [row.id, row]));
    expect(byId["legacy-agent-1"]).toMatchObject({ state: RESERVATION_STATE.RELEASED, externalId: RELEASE_REASON.CHARGER_SUPERSEDED });
    expect(byId["legacy-agent-2"]).toMatchObject({ state: RESERVATION_STATE.RELEASED, externalId: RELEASE_REASON.CHARGER_SUPERSEDED });
    // An already-released row keeps its own reason.
    expect(byId["legacy-done"]).toMatchObject({ state: RESERVATION_STATE.RELEASED, externalId: RELEASE_REASON.TARGET_REACHED });
    expect(s.tables.charger).toEqual([DEPOT_ROW, LEGACY_ROW]);
  });

  test("reconcile still releases them when the depot row is absent (and grants nothing)", async () => {
    const s = store({ chargers: [LEGACY_ROW] });
    legacyReservation(s, "agent-1", RESERVATION_STATE.ACTIVE, T0 - 3_600_000);

    const outcome = await devChargingScheduler.reconcile(s.deps, { nowMs: T0 });

    expect(outcome).toMatchObject({ superseded: 1 });
    expect(s.tables.chargerReservation[0].state).toBe(RESERVATION_STATE.RELEASED);
    expect((await devChargingScheduler.provision(s.deps, { nowMs: T0 })).ok).toBe(false);
  });

  test("superseded reservations do not occupy the depot's plugs: three legacy ACTIVE rows still leave three depot plugs", async () => {
    const s = store();
    for (const id of ["agent-1", "agent-2", "agent-3"]) legacyReservation(s, id, RESERVATION_STATE.ACTIVE, T0 - 3_600_000);
    await devChargingScheduler.provision(s.deps, { nowMs: T0 });
    await devChargingScheduler.reconcile(s.deps, { nowMs: T0 });

    for (const id of ["agent-4", "agent-5", "agent-6", "agent-7"]) {
      // eslint-disable-next-line no-await-in-loop
      await devChargingScheduler.requestPlug(s.deps, { agentRowId: id, targetSoc: 0.8, nowMs: T0 + 1 });
      // As the simulator's charging client does: a request enqueues, promotion grants.
      // eslint-disable-next-line no-await-in-loop
      await devChargingScheduler.promote(s.deps, { nowMs: T0 + 1 });
    }

    const atDepot = s.tables.chargerReservation.filter((row) => row.chargerDbId === DEPOT_ROW.id);
    expect(atDepot.filter((row) => row.state === RESERVATION_STATE.ACTIVE)).toHaveLength(3);
    expect(atDepot.filter((row) => row.state === RESERVATION_STATE.QUEUED).map((row) => row.agentId)).toEqual(["agent-7"]);
  });

  test("the engine's charging classifier reads the depot reservation, not the superseded one", async () => {
    const s = store();
    s.tables.agent.push({ id: "agent-1", agentId: "SIM-1", robot: { robotId: "SIM-1" } });
    legacyReservation(s, "agent-1", RESERVATION_STATE.ACTIVE, T0 - 3_600_000);
    await devChargingScheduler.provision(s.deps, { nowMs: T0 });
    const read = chargingStatusService.createChargingStatusReader({ prisma: s.prisma, inScope: () => true });

    await devChargingScheduler.reconcile(s.deps, { nowMs: T0 });
    expect(await read("agent-1")).toMatchObject({ known: true, charging: false, waiting: false });

    await devChargingScheduler.requestPlug(s.deps, { agentRowId: "agent-1", targetSoc: 0.8, nowMs: T0 + 1 });
    expect(await read("agent-1")).toMatchObject({ known: true, charging: false, waiting: true });
    await devChargingScheduler.promote(s.deps, { nowMs: T0 + 1 });
    expect(await read("agent-1")).toMatchObject({ known: true, charging: true, chargingInterruptible: false });
  });
});

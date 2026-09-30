"use strict";

/**
 * P1.4 — §12.4 row 5 ("lease expired, not yet processed" → "run the §4.7 recovery path") is
 * composed with its action.
 *
 * `reconciler.scanExpiredLeases` leaves the recovery to `deps.recover`, and the production
 * composer never supplied it; nothing arms a COMMITMENT lease timer either. Measured live, a
 * server restart mid-execution left the Leg at AT_PICKUP / LOADED with a live commitment for
 * good (the reconciler recorded the repair every minute and did nothing), and the robot was
 * never assignable again. The composer now supplies `recover`, which runs the registered
 * LEASE_EXPIRY_RECOVERY handler — the one the timer path runs — with the timer worker's
 * own recovery configuration.
 */

jest.mock("../../src/workers/reconciler.worker", () => {
  const actual = jest.requireActual("../../src/workers/reconciler.worker");
  return { ...actual, start: jest.fn(() => ({ stop: jest.fn() })) };
});

const reconcilerWorker = require("../../src/workers/reconciler.worker");
const expiryActions = require("../../src/engine/supervision/expiryActions");
const { COMPOSERS } = require("../../src/workers/leaderWorkers");

const STORE_NOW = new Date("2026-09-27T13:00:00.000Z");
const VALUES = new Map([
  ["reconciler.sweep_interval", 60],
  ["recover.max_reassignments_per_leg", 3],
  ["recover.incumbent_cooloff", 120],
  ["recover.reassign_budget", 600],
  ["dispatch.max_delivery_delay", 30],
]);

function compose({ commitmentRow, recoverImpl } = {}) {
  const handler = jest.fn(recoverImpl || (async () => ({ disposition: "TRANSITIONED", outcome: "REASSIGNED:c-1" })));
  jest.spyOn(expiryActions, "handlers").mockReturnValue({ LEASE_EXPIRY_RECOVERY: handler });

  const tx = {
    $queryRawUnsafe: jest.fn(async () => [{ now: STORE_NOW }]),
    commitment: { findUnique: jest.fn(async () => commitmentRow) },
  };
  const record = jest.fn();
  const context = {
    prisma: { $queryRawUnsafe: tx.$queryRawUnsafe },
    values: { get: (name) => VALUES.get(name) },
    record,
    runInTransaction: jest.fn(async (fn) => fn(tx)),
    signingKey: "k".repeat(64),
    shardId: "v1demo-shard",
    regionId: "rnsit",
  };
  const composed = COMPOSERS.reconciler(context);
  const deps = reconcilerWorker.start.mock.calls[reconcilerWorker.start.mock.calls.length - 1][0];
  return { composed, deps, handler, tx, record, context };
}

const EXPIRED = {
  id: "row-1",
  commitmentId: "commitment-1",
  legId: "leg-1",
  agentId: "agent-1",
  fence: 2n,
  releasedAt: null,
  leaseExpiry: new Date("2026-09-27T12:47:14.000Z"),
};

afterEach(() => jest.restoreAllMocks());

describe("reconciler row 5 — the lease-expiry repair has its action (P1.4)", () => {
  test("the composed reconciler supplies `recover`", () => {
    const { composed, deps } = compose({ commitmentRow: EXPIRED });
    expect(composed.ok).toBe(true);
    expect(typeof deps.recover).toBe("function");
  });

  test("an expired, unreleased lease runs the registered LEASE_EXPIRY_RECOVERY handler in a transaction", async () => {
    const { deps, handler, context, record } = compose({ commitmentRow: EXPIRED });
    await deps.recover({ commitment: EXPIRED, leg: { id: "leg-1" }, storeTime: STORE_NOW });

    expect(context.runInTransaction).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
    const ctx = handler.mock.calls[0][0];
    expect(ctx.entity).toBe(EXPIRED);
    expect(ctx.storeTime).toEqual(STORE_NOW);
    expect(ctx.timer).toMatchObject({ entityType: "COMMITMENT", entityId: "commitment-1", shardId: "v1demo-shard" });
    // The timer worker's own recovery parameters, from the same register entries.
    expect(ctx.config).toMatchObject({
      signingKey: context.signingKey,
      maxReassignmentsPerLeg: 3,
      incumbentCooloffSeconds: 120,
      reassignBudgetSeconds: 600,
      maxDeliveryDelaySeconds: 30,
      shardId: "v1demo-shard",
      regionId: "rnsit",
    });
    expect(record).toHaveBeenCalledWith("reconciler.lease_expiry_recovered", expect.objectContaining({ commitmentId: "commitment-1", outcome: "REASSIGNED:c-1" }));
  });

  test("a lease renewed since the scan is left alone", async () => {
    const renewed = { ...EXPIRED, leaseExpiry: new Date("2026-09-27T13:00:30.000Z") };
    const { deps, handler } = compose({ commitmentRow: renewed });
    const result = await deps.recover({ commitment: EXPIRED });
    expect(handler).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "LEASE_RENEWED" });
  });

  test("a commitment released since the scan is left alone", async () => {
    const released = { ...EXPIRED, releasedAt: new Date("2026-09-27T12:59:00.000Z") };
    const { deps, handler } = compose({ commitmentRow: released });
    expect(await deps.recover({ commitment: EXPIRED })).toEqual({ outcome: "COMMITMENT_ALREADY_RELEASED" });
    expect(handler).not.toHaveBeenCalled();
  });

  test("a failing recovery is recorded and does not throw out of the sweep", async () => {
    const { deps, record } = compose({
      commitmentRow: EXPIRED,
      recoverImpl: async () => { throw new Error("serialization failure"); },
    });
    await expect(deps.recover({ commitment: EXPIRED })).resolves.toBeNull();
    expect(record).toHaveBeenCalledWith("reconciler.lease_expiry_recovery_failed", { commitmentId: "commitment-1", message: "serialization failure" });
  });
});

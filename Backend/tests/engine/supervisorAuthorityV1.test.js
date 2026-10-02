"use strict";

/**
 * V1 supervisor authority — the regression tests for the fixes Step 1's tests called for.
 *
 *   D  `leadership.renewLease` never moves the stored lease expiry backwards, and
 *      `election.renew` never moves the session's backwards.
 *   C  `election.foldRenewal` / `promoteIfCurrent`: a result for another term changes nothing,
 *      a late failure only withdraws authority, a late success never restores it, and a
 *      reconciliation promotes only the term it ran for.
 *   B  A-2 through the real `shardSupervisor.start()` loop: the lease is kept while a
 *      reconciliation runs, and each way a reconciliation can end — success, longer than a
 *      lease, failure, an incomplete result, a newer fence, a lost lease — leaves commit
 *      permission exactly where the term's evidence puts it.
 *
 * The store is `helpers/commitmentStore` (real blocking row locks) under the real `leadership`,
 * `election` and supervisor code, as in `shardSupervisorTickModel.test.js`.
 */

const election = require("../../src/engine/shard/election");
const failover = require("../../src/engine/shard/failover");
const leadership = require("../../src/engine/shard/leadership");
const shardSupervisor = require("../../src/workers/shardSupervisor.worker");
const { createCommitmentStore, fixture } = require("./helpers/commitmentStore");

const SHARD = "shard-a";
const ME = "coordinator-a";
const OTHER = "coordinator-b";
const LEASE_SECONDS = 5;
const INTERVAL_MS = 1500;
const SKEW_MS = 500;
const STORE_RTT_BUDGET_MS = 500;
const T0 = INTERVAL_MS;
const EPOCH = new Date("2026-10-02T00:00:00.000Z");
const at = (ms) => new Date(EPOCH.getTime() + ms);
const rel = (value) => (value ? new Date(value).getTime() - EPOCH.getTime() : null);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function seededStore() {
  const seed = fixture({ legs: 1 });
  return createCommitmentStore({
    agent: [seed.agent],
    leg: seed.legs,
    shardLeadership: [{ ...seed.leadership, shardId: SHARD, holder: null, leaseExpiry: null }],
    shard: [
      { id: "s-a", shardId: SHARD, regionId: "region-a", state: "ACTIVE", drainingSince: null, agentCount: 1, bindingBound: "NEITHER_EVALUATED" },
    ],
    shardMembership: [],
  });
}

const leaderRow = (store) => store.rows("shardLeadership").find((entry) => entry.shardId === SHARD);

/* ═══════════════════════════════════════════════════════════════════════════
   D — the stored lease expiry is monotonic
   ═══════════════════════════════════════════════════════════════════════════ */

describe("D — renewLease never moves the stored lease expiry backwards", () => {
  async function held() {
    const store = seededStore();
    const acquired = await leadership.tryAcquire(store.client, { shardId: SHARD, holder: ME, storeTime: at(0), leaseDurationSeconds: LEASE_SECONDS });
    expect(acquired.acquired).toBe(true);
    const renew = (storeTimeMs, overrides) =>
      leadership.renewLease(store.client, {
        shardId: SHARD,
        holder: ME,
        expectedFence: acquired.leadershipFence,
        storeTime: at(storeTimeMs),
        leaseDurationSeconds: LEASE_SECONDS,
        ...(overrides || {}),
      });
    return { store, fence: acquired.leadershipFence, renew };
  }

  test("a renewal that extends the lease writes it", async () => {
    const { store, renew } = await held();
    expect(await renew(1500)).toMatchObject({ renewed: true, refusal: null, extended: true });
    expect(rel(leaderRow(store).leaseExpiry)).toBe(6500);
  });

  test("two overlapping renewals, the stale one landing second: the stored expiry stays at the later one", async () => {
    const { store, renew } = await held();
    // The T+1,500 renewal reaches the row lock only after the T+3,000 one has written T+8,000.
    const [stale, fresh] = await Promise.all([new Promise((resolve) => setImmediate(resolve)).then(() => renew(1500)), renew(3000)]);
    expect(fresh).toMatchObject({ renewed: true, extended: true });
    expect(rel(fresh.leaseExpiry)).toBe(8000);
    // Before V1: renewed: true, and the row went back to T+6,500.
    expect(stale).toMatchObject({ renewed: true, refusal: null, extended: false });
    expect(rel(stale.leaseExpiry)).toBe(8000);
    expect(rel(leaderRow(store).leaseExpiry)).toBe(8000);
  });

  test("a stale renewal completing after a newer one, sequentially: nothing is written and the stored expiry is reported", async () => {
    const { store, renew } = await held();
    await renew(3000);
    const before = { ...leaderRow(store) };
    const stale = await renew(1500);
    expect(stale).toMatchObject({ renewed: true, extended: false });
    expect(rel(stale.leaseExpiry)).toBe(8000);
    expect(leaderRow(store)).toEqual(before);
  });

  test("a renewal proposing exactly the stored expiry is not a write either", async () => {
    const { renew } = await held();
    expect(await renew(0)).toMatchObject({ renewed: true, extended: false });
  });

  test("a renewal after fence supersession is refused and leaves the newer leadership untouched", async () => {
    const { store, fence, renew } = await held();
    // The lease lapses and another coordinator takes the shard at fence+1.
    const taken = await leadership.tryAcquire(store.client, { shardId: SHARD, holder: OTHER, storeTime: at(6000), leaseDurationSeconds: LEASE_SECONDS });
    expect(BigInt(taken.leadershipFence)).toBe(BigInt(fence) + 1n);
    const before = { ...leaderRow(store) };

    const late = await renew(4000);
    expect(late).toMatchObject({ renewed: false, refusal: leadership.CAS_REFUSAL.FENCE_SUPERSEDED });
    expect(leaderRow(store)).toEqual(before);
    expect(leaderRow(store).holder).toBe(OTHER);
  });

  test("ownership checks are unchanged: another holder, and a lapsed lease, are still refused", async () => {
    const { renew } = await held();
    expect(await renew(1000, { holder: OTHER })).toMatchObject({ renewed: false, refusal: leadership.CAS_REFUSAL.NOT_THE_HOLDER });
    expect(await renew(5000)).toMatchObject({ renewed: false, refusal: leadership.CAS_REFUSAL.LEASE_LAPSED });
  });

  test("a stale release still never releases newer leadership (the existing CAS)", async () => {
    const { store, fence } = await held();
    const newer = await leadership.tryAcquire(store.client, { shardId: SHARD, holder: ME, storeTime: at(6000), leaseDurationSeconds: LEASE_SECONDS });
    const stale = await leadership.releaseLease(store.client, { shardId: SHARD, holder: ME, expectedFence: fence, storeTime: at(6100) });
    expect(stale).toMatchObject({ released: false, refusal: leadership.CAS_REFUSAL.FENCE_SUPERSEDED });
    expect(String(leaderRow(store).leadershipFence)).toBe(String(newer.leadershipFence));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   C / D — session rules
   ═══════════════════════════════════════════════════════════════════════════ */

describe("C/D — session rules: a late result never restores authority, and the session lease never regresses", () => {
  const leader = (overrides) =>
    Object.freeze({
      shardId: SHARD,
      candidateId: ME,
      state: election.LEADERSHIP_STATE.LEADER,
      leadershipFence: 2n,
      leaseExpiry: at(8000),
      acquiredAtMs: 0,
      lastRenewedAtMs: 3000,
      lastRefusal: null,
      observedHolder: ME,
      mayCommit: false,
      reconciled: false,
      ...(overrides || {}),
    });
  const timing = { leaseDurationSeconds: LEASE_SECONDS, maxClockSkewMillis: SKEW_MS, storeRoundTripMillis: STORE_RTT_BUDGET_MS };
  const storeAnswering = (outcome) => ({ renew: async () => outcome });

  test("election.renew never moves the session's lease expiry backwards, even if the store answers an earlier one", async () => {
    const session = leader({ lastRenewedAtMs: at(3000).getTime() });
    const renewed = await election.renew(storeAnswering({ renewed: true, refusal: null, leadershipFence: 2n, leaseExpiry: at(6500) }), session, {
      ...timing,
      storeTime: at(1500),
    });
    expect(rel(renewed.leaseExpiry)).toBe(8000);
    expect(renewed.lastRenewedAtMs).toBe(at(3000).getTime());
  });

  test("a renewal for another term changes nothing", () => {
    const current = leader({ leadershipFence: 3n });
    expect(election.foldRenewal(current, leader({ leadershipFence: 2n, leaseExpiry: at(99000) }))).toBe(current);
    const follower = election.followerSession({ shardId: SHARD, candidateId: ME });
    expect(election.foldRenewal(follower, leader())).toBe(follower);
  });

  test("a late success extends the current session's lease, never earlier, and keeps its commit permission", () => {
    const current = leader({ reconciled: true, mayCommit: true, leaseExpiry: at(9500) });
    const earlier = election.foldRenewal(current, leader({ leaseExpiry: at(6500), lastRenewedAtMs: 1500, marginMillis: 4000 }));
    expect(rel(earlier.leaseExpiry)).toBe(9500);
    expect(earlier.lastRenewedAtMs).toBe(3000);
    expect(earlier.mayCommit).toBe(true);
    const later = election.foldRenewal(current, leader({ leaseExpiry: at(11000), lastRenewedAtMs: 6000, marginMillis: 4000 }));
    expect(rel(later.leaseExpiry)).toBe(11000);
    expect(later.lastRenewedAtMs).toBe(6000);
  });

  test("a late success never grants commit permission to an unreconciled session", () => {
    const folded = election.foldRenewal(leader(), leader({ mayCommit: true, reconciled: true, leaseExpiry: at(9000) }));
    expect(folded).toMatchObject({ mayCommit: false, reconciled: false });
  });

  test("a late failure for the current term withdraws authority", () => {
    const current = leader({ reconciled: true, mayCommit: true });
    const failed = leader({ state: election.LEADERSHIP_STATE.STEPPING_DOWN, lastRefusal: leadership.CAS_REFUSAL.FENCE_SUPERSEDED, observedFence: 3n });
    expect(election.foldRenewal(current, failed)).toMatchObject({
      state: election.LEADERSHIP_STATE.STEPPING_DOWN,
      mayCommit: false,
      lastRefusal: leadership.CAS_REFUSAL.FENCE_SUPERSEDED,
      observedFence: 3n,
    });
  });

  test("a late success never undoes a step-down", () => {
    const steppingDown = leader({ state: election.LEADERSHIP_STATE.STEPPING_DOWN, lastRefusal: leadership.CAS_REFUSAL.NOT_THE_HOLDER });
    expect(election.foldRenewal(steppingDown, leader({ leaseExpiry: at(99000) }))).toBe(steppingDown);
  });

  test("promoteIfCurrent promotes the current session of the same term, keeping its renewed lease", () => {
    const basis = leader({ leaseExpiry: at(5000) });
    const current = leader({ leaseExpiry: at(9500) });
    const promoted = election.promoteIfCurrent(current, basis, { complete: true });
    expect(promoted).toMatchObject({ mayCommit: true, reconciled: true });
    expect(rel(promoted.leaseExpiry)).toBe(9500);
  });

  test("promoteIfCurrent refuses a superseded term, a stepped-down session and a follower", () => {
    const basis = leader();
    const newer = leader({ leadershipFence: 3n });
    expect(election.promoteIfCurrent(newer, basis, { complete: true })).toBe(newer);
    const down = leader({ state: election.LEADERSHIP_STATE.STEPPING_DOWN });
    expect(election.promoteIfCurrent(down, basis, { complete: true })).toBe(down);
    const follower = election.followerSession({ shardId: SHARD, candidateId: ME });
    expect(election.promoteIfCurrent(follower, basis, { complete: true })).toBe(follower);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   B — A-2 through the real loop
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Run the real `start()` loop. `faults.renew(n, nowMs)` may throw to make a renewal fail at the
 * store; `onReconcile(callIndex, store)` runs as each reconciliation starts.
 */
async function loop(options) {
  const settings = options || {};
  const store = seededStore();
  const base = election.postgresLeadershipStore(store.client, { replicationPosture: "SYNCHRONOUS_QUORUM" });
  const now = () => Date.now() - EPOCH.getTime();
  const latency = { read: 100, tryAcquire: 200, renew: 200, release: 200, ...(settings.latency || {}) };
  const calls = [];
  const wrapped = { ...base };
  for (const op of ["read", "tryAcquire", "renew", "release"]) {
    let n = 0;
    wrapped[op] = async (request) => {
      n += 1;
      const call = { op, n, at: now() };
      calls.push(call);
      await sleep(latency[op]);
      if (op === "renew" && settings.faults && settings.faults.renew) settings.faults.renew(call.n, call.at);
      const result = await base[op](request);
      call.result = { ok: Boolean(result.acquired || result.renewed || result.released), refusal: result.refusal ?? null };
      return result;
    };
  }
  const failoverMs = settings.failoverMs || [0];
  let reconciles = 0;
  const reconcile = async () => {
    const index = reconciles;
    reconciles += 1;
    if (typeof settings.onReconcile === "function") await settings.onReconcile(index, store);
    await sleep(failoverMs[Math.min(index, failoverMs.length - 1)]);
    if (settings.reconcileThrows && settings.reconcileThrows(index)) throw new Error(`reconcile ${index} failed`);
    return { total: 0, results: [] };
  };

  const ticks = [];
  const errors = [];
  const handle = shardSupervisor.start(
    {
      prisma: store.client,
      store: wrapped,
      runSerializable: (client, fn) => client.$transaction(fn),
      selectForUpdate: async () => null,
      reconcile,
      onError: (error) => errors.push({ at: now(), message: error.message }),
    },
    {
      shardId: SHARD,
      candidateId: ME,
      leaseDurationSeconds: LEASE_SECONDS,
      intervalMs: INTERVAL_MS,
      maxClockSkewMillis: SKEW_MS,
      storeRoundTripMillis: STORE_RTT_BUDGET_MS,
      onTick: (tick) =>
        ticks.push({
          at: now(),
          pass: tick.pass || "TICK",
          transition: tick.transition,
          state: tick.session.state,
          fence: tick.session.leadershipFence === null ? null : String(tick.session.leadershipFence),
          mayRunRound: tick.mayRunRound,
        }),
    },
  );

  const probes = [];
  let elapsed = 0;
  while (elapsed < settings.runForMs) {
    const step = Math.min(50, settings.runForMs - elapsed);
    // eslint-disable-next-line no-await-in-loop
    await jest.advanceTimersByTimeAsync(step);
    elapsed += step;
    const s = handle.session();
    const r = leaderRow(store);
    probes.push({
      at: elapsed,
      state: s.state,
      fence: s.leadershipFence === null ? null : String(s.leadershipFence),
      mayCommit: s.mayCommit === true,
      rowFence: String(r.leadershipFence),
      rowHolder: r.holder,
      rowExpiry: rel(r.leaseExpiry),
    });
    if (typeof settings.afterStep === "function") settings.afterStep(elapsed, handle);
  }
  handle.stop();
  return { store, calls, ticks, errors, probes, handle, reconciles: () => reconciles };
}

/** Commit permission must only ever be held on the row's fence, by its holder, before expiry. */
function permissionViolations(run) {
  return run.probes.filter((p) => p.mayCommit && (p.fence !== p.rowFence || p.rowHolder !== ME || p.rowExpiry === null || p.rowExpiry <= p.at));
}

describe("B — A-2: the lease is kept while reconciling, and commit permission follows the term's evidence", () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"], now: EPOCH }));
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("reconciliation succeeds: LEADER without permission while it runs, promoted on the same fence when it completes", async () => {
    const run = await loop({ failoverMs: [3000], runForMs: T0 + 6000 });
    const during = run.probes.filter((p) => p.at > T0 + 300 && p.at < T0 + 3300);
    expect(during.every((p) => p.state === election.LEADERSHIP_STATE.LEADER && p.fence === "2" && !p.mayCommit)).toBe(true);
    expect(run.probes[run.probes.length - 1]).toMatchObject({ state: election.LEADERSHIP_STATE.LEADER, fence: "2", mayCommit: true });
    expect(permissionViolations(run)).toEqual([]);
  });

  test("reconciliation longer than three leases: the lease is renewed throughout, one acquisition, then promoted", async () => {
    const run = await loop({ failoverMs: [16000], runForMs: T0 + 18000 });
    expect(run.calls.filter((c) => c.op === "tryAcquire" && c.result && c.result.ok)).toHaveLength(1);
    const renewals = run.calls.filter((c) => c.op === "renew" && c.result);
    expect(renewals.length).toBeGreaterThanOrEqual(10);
    expect(renewals.every((c) => c.result.ok)).toBe(true);
    expect(run.probes.every((p) => p.rowExpiry === null || p.rowExpiry > p.at)).toBe(true);
    // "1" is the seeded row before the acquisition.
    expect([...new Set(run.probes.map((p) => p.rowFence))]).toEqual(["1", "2"]);
    expect(run.probes[run.probes.length - 1]).toMatchObject({ fence: "2", mayCommit: true });
    expect(permissionViolations(run)).toEqual([]);
  });

  test("reconciliation fails (throws): no permission, the lease is kept, and the next tick reconciles again on the same fence", async () => {
    const run = await loop({ failoverMs: [2000, 500], reconcileThrows: (index) => index === 0, runForMs: T0 + 6000 });
    expect(run.errors.map((e) => e.message)).toEqual(["reconcile 0 failed"]);
    expect(run.reconciles()).toBe(2);
    expect(run.calls.filter((c) => c.op === "tryAcquire")).toHaveLength(1);
    const afterFailure = run.probes.filter((p) => p.at > T0 + 2300 && p.at < T0 + 3000);
    expect(afterFailure.every((p) => p.state === election.LEADERSHIP_STATE.LEADER && p.fence === "2" && !p.mayCommit)).toBe(true);
    expect(run.probes[run.probes.length - 1]).toMatchObject({ fence: "2", mayCommit: true });
    expect(permissionViolations(run)).toEqual([]);
  });

  test("reconciliation returns an incomplete result: never promoted on it; promoted only by a later complete one", async () => {
    const real = failover.run;
    let runs = 0;
    jest.spyOn(failover, "run").mockImplementation(async (...args) => {
      runs += 1;
      const result = await real(...args);
      return runs === 1 ? { ...result, complete: false } : result;
    });
    const run = await loop({ failoverMs: [1000, 500], runForMs: T0 + 6000 });
    const firstTickEnd = run.ticks.find((t) => t.pass === "TICK");
    expect(firstTickEnd).toMatchObject({ transition: "ACQUIRED", mayRunRound: false, fence: "2" });
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(run.probes[run.probes.length - 1]).toMatchObject({ fence: "2", mayCommit: true });
    expect(permissionViolations(run)).toEqual([]);
  });
});

describe("B — A-2: superseded and lost leadership during reconciliation", () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"], now: EPOCH }));
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("a newer fence during reconciliation: no probe ever holds permission, and the newer leadership is left alone", async () => {
    const run = await loop({
      failoverMs: [4000, 500],
      runForMs: T0 + 9000,
      onReconcile: async (index, store) => {
        if (index !== 0) return;
        // Another coordinator takes the shard at fence 3 while ours reconciles.
        setTimeout(() => {
          leadership.advanceFence(store.client, {
            shardId: SHARD,
            holder: OTHER,
            advancedBy: OTHER,
            leaseDurationSeconds: 60,
            storeTime: new Date(Date.now()),
          });
        }, 700);
      },
    });
    // The first boundary after the takeover renews against fence 2 and is refused.
    const refused = run.calls.find((c) => c.op === "renew" && c.result && c.result.refusal === leadership.CAS_REFUSAL.FENCE_SUPERSEDED);
    expect(refused).toBeDefined();
    expect(run.probes.some((p) => p.mayCommit)).toBe(false);
    expect(permissionViolations(run)).toEqual([]);
    // Stepped down, released nothing (the CAS refused the stale release), stood again and was
    // refused by the newer holder's lease. The newer leadership is untouched.
    expect(run.calls.filter((c) => c.op === "release").every((c) => c.result.refusal === leadership.CAS_REFUSAL.FENCE_SUPERSEDED)).toBe(true);
    expect(leaderRow(run.store)).toMatchObject({ holder: OTHER });
    expect(String(leaderRow(run.store).leadershipFence)).toBe("3");
    expect(run.handle.session().state).toBe(election.LEADERSHIP_STATE.FOLLOWER);
  });

  test("the lease lost during reconciliation (every renewal fails at the store): the late reconciliation does not promote", async () => {
    const run = await loop({
      failoverMs: [7000, 500],
      runForMs: T0 + 14000,
      // The store is unreachable for renewals until T0+7,000 — after the lease (T0+5,000) lapsed.
      faults: {
        renew: (n, callAt) => {
          if (callAt < T0 + 7000) throw new Error("store unreachable");
        },
      },
    });
    expect(run.errors.filter((e) => e.message === "store unreachable").length).toBeGreaterThanOrEqual(3);
    // The reconciliation ended at T0+7,300, after the lapse: refused promotion on fence 2.
    expect(run.probes.some((p) => p.fence === "2" && p.mayCommit)).toBe(false);
    // The next renewal is refused LEASE_LAPSED; the term ends and a genuine re-acquisition follows.
    expect(run.calls.some((c) => c.op === "renew" && c.result && c.result.refusal === leadership.CAS_REFUSAL.LEASE_LAPSED)).toBe(true);
    expect(permissionViolations(run)).toEqual([]);
    const final = run.probes[run.probes.length - 1];
    expect(Number(final.fence)).toBeGreaterThan(2);
    expect(final.mayCommit).toBe(true);
  });

  test("stop() during a reconciliation: no tick is reported after it, and the session is still kept for the drain", async () => {
    let stoppedAt = null;
    const run = await loop({
      failoverMs: [3000],
      runForMs: T0 + 6000,
      afterStep: (elapsed, handle) => {
        if (elapsed === T0 + 1000) {
          handle.stop();
          stoppedAt = elapsed;
        }
      },
    });
    expect(run.ticks.filter((t) => t.at > stoppedAt)).toEqual([]);
    // The acquiring tick still finished and its session is the one a drain would release.
    expect(run.handle.session()).toMatchObject({ state: election.LEADERSHIP_STATE.LEADER, leadershipFence: 2n });
  });
});

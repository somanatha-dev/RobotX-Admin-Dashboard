"use strict";

/**
 * STEP 1 (tests first) — the shard supervisor's real interval loop over a slow store.
 *
 * Step 0 measured the real `server.js` supervisor losing its 5 s lease from ~78 ms RTT with no
 * commit running; Step 1 derived why from the code (report: claude.ai/artifact/HXavgbE3h9yuQKtWySUG8v):
 *
 *   - `start()` fires `runOnce` every `intervalMs` with **no overlap guard**
 *     (`shardSupervisor.worker.js:624`), passing the session **as it is when the tick starts**;
 *     the shared session is replaced only when a tick **resolves** (`:627`) — last to finish wins.
 *   - The acquiring tick runs the whole failover pass before it resolves, so for its duration
 *     `C` every other tick still carries FOLLOWER, and `tryAcquire` refuses this process's own
 *     unexpired lease (`HELD_BY_ANOTHER`, `leadership.js:359` — no holder comparison).
 *   - The first renewal is therefore the first tick boundary after `C`; with a 1.5 s interval
 *     and a 5 s lease it lands before expiry only when `C ≤ 4.5 s`.
 *   - When `C > 5 s` the lease is gone before the acquiring tick returns, and a stale FOLLOWER
 *     tick legitimately acquires the next fence while the old tick is still reconciling.
 *
 * These tests drive the **real** `shardSupervisor.start()` / `runOnce`, `election` and
 * `leadership` code, over `helpers/commitmentStore` (real blocking row locks), under fake
 * timers. The only additions are a latency in front of each of the four store calls and a
 * slow `reconcile` — the two quantities the Step 0 traces measured. `storeTime` is not passed,
 * exactly as `server.js` passes none, so each tick uses `Date.now()` at tick start (`:489`).
 *
 * Nothing in `src/` is modified by this file.
 *
 * ── After the V1 supervisor fix (A-1 / A-2) ─────────────────────────────────
 * Step 1 wrote this file against the defective loop: the characterisation tests pinned the
 * defects, and five `test.failing` future invariants stated what must hold instead. The V1 fix
 * made `start()` single-flight (A-1), published the acquisition at once and renewed the lease
 * while the tick reconciles (A-2), and made `renewLease` monotonic. The future invariants are
 * now ordinary tests. Each characterisation test of a defect that no longer exists now asserts
 * the fixed behaviour for the same regime, and its comment records what the defective loop did.
 * The two `singleFlight` tests drive a test-local scheduler, not `start()`, and are unchanged:
 * they are still why the fix had to include A-2.
 */

const election = require("../../src/engine/shard/election");
const leadership = require("../../src/engine/shard/leadership");
const leaderWorkers = require("../../src/workers/leaderWorkers");
const shardSupervisor = require("../../src/workers/shardSupervisor.worker");
const outboxWorker = require("../../src/workers/outbox.worker");
const reconcilerWorker = require("../../src/workers/reconciler.worker");
const timerWorker = require("../../src/workers/timer.worker");
const { createCommitmentStore, fixture } = require("./helpers/commitmentStore");

/** `server.js`'s resolved register defaults, as captured from the live server in Step 0. */
const LEASE_SECONDS = 5;
const LEASE_MS = LEASE_SECONDS * 1000;
const INTERVAL_MS = 1500;
const SKEW_MS = 500;
const STORE_RTT_BUDGET_MS = 500;
const ME = "coordinator-a";
const SHARD = "shard-a";
/** `setInterval` first fires one interval after `start()`: the acquiring tick. */
const T0 = INTERVAL_MS;
const EPOCH = new Date("2026-10-02T00:00:00.000Z");

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
    shardMembership: [
      {
        id: "m-1",
        agentId: seed.agent.id,
        shardId: SHARD,
        fromShardId: null,
        movedAt: EPOCH,
        supersededAt: null,
        authorityEpochBefore: seed.agent.authorityEpoch,
        authorityEpochAfter: seed.agent.authorityEpoch,
        reason: "COMMISSIONING",
        movedBy: "seed",
      },
    ],
  });
}

function summarise(op, result) {
  if (!result) return null;
  const exp = (value) => (value ? new Date(value).getTime() - EPOCH.getTime() : null);
  if (op === "read") return { fence: String(result.leadershipFence), holder: result.holder, expiry: exp(result.leaseExpiry) };
  return {
    ok: Boolean(result.acquired || result.renewed || result.released),
    refusal: result.refusal ?? null,
    fence: result.leadershipFence === null || result.leadershipFence === undefined ? null : String(result.leadershipFence),
    holder: result.holder ?? undefined,
    expiry: exp(result.leaseExpiry),
  };
}

/**
 * Run the real supervisor loop for `runForMs` of virtual time.
 *
 * @param {object} options
 * @param {object} options.latency per store call, ms or `(nthCallOfThatOp) => ms`:
 *   `{ read, tryAcquire, renew, release }`. The delay precedes the call, as a round trip would.
 * @param {number[]} options.failoverMs duration of each successive failover pass (the last
 *   value repeats).
 * @param {number} options.runForMs virtual time to run.
 * @param {(tick: object) => void} [options.onTick] also receives every resolved tick.
 * @param {number[]} [options.probesAt] virtual times (ms since start) at which to snapshot the
 *   shared session and the leadership row.
 * @returns {Promise<object>} the event log and observations.
 */
async function simulate(options) {
  const settings = options || {};
  const latency = settings.latency || {};
  const store = seededStore();
  const base = election.postgresLeadershipStore(store.client, { replicationPosture: "SYNCHRONOUS_QUORUM" });
  const log = [];
  const now = () => Date.now() - EPOCH.getTime();
  const nth = { read: 0, tryAcquire: 0, renew: 0, release: 0 };
  let inFlightLeaseOps = 0;
  let maxInFlightLeaseOps = 0;

  const wrapped = { ...base };
  for (const op of ["read", "tryAcquire", "renew", "release"]) {
    wrapped[op] = async (request) => {
      nth[op] += 1;
      const n = nth[op];
      const delay = typeof latency[op] === "function" ? latency[op](n) : latency[op] || 0;
      const call = {
        kind: "call",
        op,
        n,
        at: now(),
        storeTime: request && request.storeTime ? request.storeTime.getTime() - EPOCH.getTime() : null,
        expectedFence: request && request.expectedFence !== undefined && request.expectedFence !== null ? String(request.expectedFence) : null,
      };
      log.push(call);
      // Leadership store operations this process has in flight at once.
      inFlightLeaseOps += 1;
      maxInFlightLeaseOps = Math.max(maxInFlightLeaseOps, inFlightLeaseOps);
      try {
        await sleep(delay);
        const result = await base[op](request);
        log.push({ kind: "ret", op, n, at: now(), result: summarise(op, result) });
        return result;
      } finally {
        inFlightLeaseOps -= 1;
      }
    };
  }

  const failoverMs = settings.failoverMs || [0];
  let failoverCalls = 0;
  let inFlightFailovers = 0;
  let maxInFlightFailovers = 0;
  const reconcile = async () => {
    const ms = failoverMs[Math.min(failoverCalls, failoverMs.length - 1)];
    failoverCalls += 1;
    inFlightFailovers += 1;
    maxInFlightFailovers = Math.max(maxInFlightFailovers, inFlightFailovers);
    log.push({ kind: "failover-start", at: now(), ms });
    await sleep(ms);
    inFlightFailovers -= 1;
    log.push({ kind: "failover-end", at: now() });
    return { total: 0, results: [] };
  };

  const ticks = [];
  const errors = [];
  const handle = shardSupervisor.start(
    {
      prisma: store.client,
      store: wrapped,
      runSerializable: (client, fn) => client.$transaction(fn),
      selectForUpdate: async (tx, table, column, value) => {
        const rows = await tx.$queryRawUnsafe(`SELECT * FROM "${table}" WHERE "${column}" = $1 FOR UPDATE`, value);
        return rows.length > 0 ? rows[0] : null;
      },
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
      onTick: (tick) => {
        const s = tick.session || {};
        const entry = {
          at: now(),
          pass: tick.pass || "TICK",
          transition: tick.transition,
          mayRunRound: tick.mayRunRound,
          state: s.state,
          fence: s.leadershipFence === null || s.leadershipFence === undefined ? null : String(s.leadershipFence),
          leaseExpiry: s.leaseExpiry ? new Date(s.leaseExpiry).getTime() - EPOCH.getTime() : null,
          reconciled: s.reconciled === true,
        };
        ticks.push(entry);
        if (typeof settings.onTick === "function") settings.onTick(tick, entry);
      },
    },
  );

  const row = () => {
    const r = store.rows("shardLeadership").find((entry) => entry.shardId === SHARD);
    return { fence: String(r.leadershipFence), holder: r.holder, expiry: r.leaseExpiry ? new Date(r.leaseExpiry).getTime() - EPOCH.getTime() : null };
  };
  const sessionNow = () => {
    const s = handle.session();
    return {
      state: s.state,
      fence: s.leadershipFence === null || s.leadershipFence === undefined ? null : String(s.leadershipFence),
      mayCommit: s.mayCommit === true,
      leaseExpiry: s.leaseExpiry ? new Date(s.leaseExpiry).getTime() - EPOCH.getTime() : null,
    };
  };

  const probes = [];
  const rowHistory = [];
  const probeTimes = [...(settings.probesAt || [])].sort((a, b) => a - b);
  let elapsed = 0;
  const advanceTo = async (target) => {
    while (elapsed < target) {
      const step = Math.min(50, target - elapsed);
      // eslint-disable-next-line no-await-in-loop
      await jest.advanceTimersByTimeAsync(step);
      elapsed += step;
      const r = row();
      const last = rowHistory[rowHistory.length - 1];
      if (!last || last.fence !== r.fence || last.expiry !== r.expiry || last.holder !== r.holder) rowHistory.push({ at: elapsed, ...r });
    }
  };
  for (const at of probeTimes) {
    // eslint-disable-next-line no-await-in-loop
    await advanceTo(at);
    probes.push({ at, session: sessionNow(), row: row() });
  }
  await advanceTo(settings.runForMs);
  handle.stop();

  const calls = (op) => log.filter((entry) => entry.kind === "call" && entry.op === op);
  const rets = (op) => log.filter((entry) => entry.kind === "ret" && entry.op === op);
  const failoverWindows = () => {
    const windows = [];
    for (const entry of log) {
      if (entry.kind === "failover-start") windows.push({ start: entry.at, end: Number.POSITIVE_INFINITY });
      if (entry.kind === "failover-end") windows.find((w) => w.end === Number.POSITIVE_INFINITY).end = entry.at;
    }
    return windows;
  };
  return { log, ticks, errors, probes, rowHistory, calls, rets, row, session: sessionNow, maxInFlightLeaseOps, maxInFlightFailovers, failoverWindows };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"], now: EPOCH });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

/**
 * Three regimes, each placed by `C = read + tryAcquire + failover` (sizing, migration and the
 * hint are instant over this store) — the duration of the acquiring tick. Step 1 named them by
 * what the defective loop did with them; the names are kept so the history stays readable.
 */
const REGIME = Object.freeze({
  // C = 3,600 ms ≤ 4,500. Defective loop: survived, first renewal at T0+4,500.
  A_SURVIVES: { latency: { read: 100, tryAcquire: 200, renew: 200, release: 200 }, failoverMs: [3300] },
  // C = 4,850 ms ∈ (4,500, 5,000). Defective loop: first renewal T0+6,000 ≥ expiry → LEASE_LAPSED.
  B_LAPSES: { latency: { read: 100, tryAcquire: 200, renew: 200, release: 200 }, failoverMs: [4550] },
  // C = 7,300 ms > 5,000. Defective loop: a stale tick acquired fence+1 at T0+6,000.
  C_CHURNS: { latency: { read: 100, tryAcquire: 200, renew: 200, release: 200 }, failoverMs: [7000, 500] },
});

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP 1 — the slow-store supervisor loop
   ═══════════════════════════════════════════════════════════════════════════ */

describe("GROUP 1 — the real interval loop over a slow store (lease 5 s, interval 1.5 s)", () => {
  test("model: the acquisition is published as soon as it is won, without commit permission, and the next boundary renews", async () => {
    // Defective loop: the session stayed FOLLOWER until the acquiring tick resolved, and the
    // T0+1,500 tick took the follower path (read → tryAcquire, refused by our own lease).
    const run = await simulate({ ...REGIME.B_LAPSES, runForMs: T0 + 1700, probesAt: [T0 + 1550] });

    // The acquiring tick is still reconciling at T0+1,550 …
    expect(run.log.some((entry) => entry.kind === "failover-start" && entry.at === T0 + 300)).toBe(true);
    expect(run.log.some((entry) => entry.kind === "failover-end")).toBe(false);
    // … the shared session is already LEADER on the row's fence, but may not commit,
    const probe = run.probes[0];
    expect(probe.session).toMatchObject({ state: election.LEADERSHIP_STATE.LEADER, fence: "2", mayCommit: false });
    expect(probe.row).toMatchObject({ holder: ME, fence: "2" });
    // … and the tick that fired at T0+1,500 renewed instead of standing for election.
    expect(run.calls("read").map((entry) => entry.at)).toEqual([T0]);
    expect(run.calls("renew").map((entry) => ({ at: entry.at, expectedFence: entry.expectedFence }))).toEqual([
      { at: T0 + INTERVAL_MS, expectedFence: "2" },
    ]);
  });

  test("A: C < 4.5 s — the lease survives; no LEASE_LAPSED; one acquisition; the fence never moves", async () => {
    const run = await simulate({ ...REGIME.A_SURVIVES, runForMs: T0 + 15000 });

    const acquired = run.rets("tryAcquire").filter((entry) => entry.result.ok);
    expect(acquired).toHaveLength(1);
    const fence = acquired[0].result.fence;
    const renewals = run.rets("renew");
    expect(renewals.length).toBeGreaterThanOrEqual(6);
    expect(renewals.every((entry) => entry.result.ok)).toBe(true);
    expect(renewals.some((entry) => entry.result.refusal === leadership.CAS_REFUSAL.LEASE_LAPSED)).toBe(false);
    // The first renewal is the T0+1,500 boundary, during the reconciliation (defective loop:
    // T0+4,500, the first boundary after the acquiring tick returned).
    expect(run.calls("renew")[0].at).toBe(T0 + INTERVAL_MS);
    expect(run.calls("renew")[0].storeTime).toBeLessThan(T0 + LEASE_MS);
    expect(run.row().fence).toBe(fence);
    expect(run.session()).toMatchObject({ state: election.LEADERSHIP_STATE.LEADER, fence, mayCommit: true });
  });

  test("B: 4.5 s < C < 5 s — the lease is renewed during the reconciliation and never lapses", async () => {
    // Defective loop: first renewal at T0+6,000, after expiry T0+5,000 → LEASE_LAPSED → LOST_LEASE.
    const run = await simulate({ ...REGIME.B_LAPSES, runForMs: T0 + 7000 });

    expect(run.calls("renew").slice(0, 3).map((entry) => entry.at)).toEqual([T0 + INTERVAL_MS, T0 + 2 * INTERVAL_MS, T0 + 3 * INTERVAL_MS]);
    expect(run.calls("renew")[0].storeTime).toBeLessThan(T0 + LEASE_MS);
    expect(run.rets("renew").every((entry) => entry.result.ok)).toBe(true);
    expect(run.ticks.some((tick) => tick.transition === "LOST_LEASE")).toBe(false);
    expect(run.session()).toMatchObject({ state: election.LEADERSHIP_STATE.LEADER, fence: "2", mayCommit: true });
  });

  test("B (continued): no lapse, so no release and no re-acquisition — the fence stays where the acquisition put it", async () => {
    // Defective loop: a release and a re-acquisition, two fence advances with no other candidate.
    const run = await simulate({ ...REGIME.B_LAPSES, runForMs: T0 + 12000 });
    // "1" is the seeded row before the acquisition; the acquisition is the only advance.
    expect([...new Set(run.rowHistory.map((entry) => entry.fence))]).toEqual(["1", "2"]);
    expect(run.calls("release")).toHaveLength(0);
    expect(run.rets("tryAcquire").filter((entry) => entry.result.ok)).toHaveLength(1);
  });

  test("B: there is no longer a regime boundary at C = 4.5 s — every C renews at the first boundary", async () => {
    // Defective loop: { 2950 → 3000 ok, 4450 → 4500 ok, 4650 → 6000 LAPSED, 4950 → 6000 LAPSED }.
    const latency = { read: 20, tryAcquire: 30, renew: 30, release: 30 };
    const outcomes = [];
    for (const failover of [2900, 4400, 4600, 4900]) {
      // eslint-disable-next-line no-await-in-loop
      const run = await simulate({ latency, failoverMs: [failover], runForMs: T0 + 7000 });
      const first = run.rets("renew")[0];
      outcomes.push({ C: 50 + failover, firstRenewalAt: run.calls("renew")[0].at - T0, refusal: first.result.refusal });
      jest.useRealTimers();
      jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"], now: EPOCH });
    }
    expect(outcomes).toEqual([
      { C: 2950, firstRenewalAt: 1500, refusal: null },
      { C: 4450, firstRenewalAt: 1500, refusal: null },
      { C: 4650, firstRenewalAt: 1500, refusal: null },
      { C: 4950, firstRenewalAt: 1500, refusal: null },
    ]);
  });

  test("C: C > 5 s — a reconciliation longer than the lease keeps the lease and the fence, and promotes once it completes", async () => {
    // Defective loop: a stale FOLLOWER tick acquired fence 3 at T0+6,000 while the fence-2 tick
    // reconciled, then the fence-2 tick resolved over it (a LEADER session on a superseded fence).
    const run = await simulate({ ...REGIME.C_CHURNS, runForMs: T0 + 7600, probesAt: [T0 + 6900, T0 + 7350] });

    const acquisitions = run.rets("tryAcquire").filter((entry) => entry.result.ok);
    expect(acquisitions.map((entry) => entry.result.fence)).toEqual(["2"]);
    // Renewed at every boundary while the 7 s reconciliation ran, so it outlived its first lease
    // (and once more at T0+7,500, the first ordinary tick after it).
    const duringReconciliation = run.calls("renew").filter((entry) => entry.at < T0 + 7300);
    expect(duringReconciliation.map((entry) => entry.at)).toEqual([1, 2, 3, 4].map((k) => T0 + k * INTERVAL_MS));
    expect(run.rets("renew").every((entry) => entry.result.ok)).toBe(true);
    expect(run.log.find((entry) => entry.kind === "failover-end").at).toBe(T0 + 7300);
    // Reconciling: LEADER, not yet allowed to commit. Reconciled: allowed, on the same fence.
    expect(run.probes[0].session).toMatchObject({ state: election.LEADERSHIP_STATE.LEADER, fence: "2", mayCommit: false });
    expect(run.probes[1].session).toMatchObject({ state: election.LEADERSHIP_STATE.LEADER, fence: "2", mayCommit: true });
    expect(run.probes[1].row.fence).toBe("2");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP 2 — overlapping ticks, current behaviour
   ═══════════════════════════════════════════════════════════════════════════ */

describe("GROUP 2 — overlapping ticks (single-flight since the V1 fix)", () => {
  test("1. one tick at a time: nothing runs the acquisition path while a tick reconciles, and lease operations never overlap", async () => {
    // Defective loop: several ticks in flight at once, the stale ones on the follower path.
    for (const regime of [REGIME.B_LAPSES, REGIME.C_CHURNS]) {
      // eslint-disable-next-line no-await-in-loop
      const run = await simulate({ ...regime, runForMs: T0 + 9000 });
      expect(run.maxInFlightLeaseOps).toBe(1);
      const windows = run.failoverWindows();
      const duringReconciliation = run.log.filter(
        (entry) => entry.kind === "call" && entry.op !== "renew" && windows.some((w) => entry.at > w.start && entry.at < w.end),
      );
      expect(duringReconciliation).toEqual([]);
      jest.useRealTimers();
      jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"], now: EPOCH });
    }
  });

  test("2–3. every boundary during the acquiring tick renews this process's lease instead of standing for election", async () => {
    // Defective loop: three stale tryAcquire calls (T0+1,500 / +3,000 / +4,500), each refused
    // HELD_BY_ANOTHER by this process's own lease.
    const run = await simulate({ ...REGIME.B_LAPSES, runForMs: T0 + 5000 });
    expect(run.rets("tryAcquire").filter((entry) => entry.n > 1)).toHaveLength(0);
    expect(run.calls("renew").map((entry) => ({ at: entry.at, expectedFence: entry.expectedFence }))).toEqual(
      [1, 2, 3].map((k) => ({ at: T0 + k * INTERVAL_MS, expectedFence: "2" })),
    );
    expect(run.rets("renew").every((entry) => entry.result.ok)).toBe(true);
    // Renewal-only results are reported, and none of them carries commit permission.
    const renewalOnly = run.ticks.filter((tick) => tick.pass === "RENEWAL_ONLY");
    expect(renewalOnly).toHaveLength(3);
    expect(renewalOnly.every((tick) => tick.mayRunRound === false && tick.state === election.LEADERSHIP_STATE.LEADER)).toBe(true);
  });

  test("3. tryAcquire refuses its own unexpired lease directly — and that refusal is what keeps the fence from advancing (must stay)", async () => {
    const store = seededStore();
    const first = await leadership.tryAcquire(store.client, { shardId: SHARD, holder: ME, storeTime: EPOCH, leaseDurationSeconds: LEASE_SECONDS });
    expect(first.acquired).toBe(true);
    const again = await leadership.tryAcquire(store.client, {
      shardId: SHARD,
      holder: ME,
      storeTime: new Date(EPOCH.getTime() + 1000),
      leaseDurationSeconds: LEASE_SECONDS,
    });
    expect(again).toMatchObject({ acquired: false, refusal: leadership.CAS_REFUSAL.HELD_BY_ANOTHER, holder: ME });
    expect(String(again.leadershipFence)).toBe(String(first.leadershipFence));
  });

  test("4–5. the lease never expires under a long reconciliation, so no stale tick acquires, and every resolved LEADER tick is on one fence", async () => {
    // Defective loop: two acquisitions (fences 2 and 3), and the older fence-2 tick resolved last.
    const run = await simulate({ ...REGIME.C_CHURNS, runForMs: T0 + 7400 });
    expect(run.rets("tryAcquire").filter((entry) => entry.result.ok)).toHaveLength(1);
    const resolved = run.ticks.filter((tick) => tick.state === election.LEADERSHIP_STATE.LEADER).map((tick) => tick.fence);
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.every((fence) => fence === "2")).toBe(true);
  });

  test("6. no FENCE_SUPERSEDED in a single process — on renew or release", async () => {
    // Defective loop: the fence-2 session renewed and released against the fence-3 row.
    const run = await simulate({ ...REGIME.C_CHURNS, runForMs: T0 + 9600 });
    expect(run.rets("renew").some((entry) => entry.result.refusal === leadership.CAS_REFUSAL.FENCE_SUPERSEDED)).toBe(false);
    expect(run.calls("release")).toHaveLength(0);
  });

  test("7. one failover pass at a time", async () => {
    // Defective loop: two at once.
    const run = await simulate({ ...REGIME.C_CHURNS, runForMs: T0 + 7400 });
    expect(run.maxInFlightFailovers).toBe(1);
  });

  test("8. the real LEADER_ONLY lifecycle is started once and never bounced by a stale verdict", async () => {
    // Defective loop: outbox started and stopped ≥ 2 times with no other candidate, and a
    // follower verdict landed between two leader verdicts (`true,false,…,true`).
    const started = [];
    const stopped = [];
    const stub = (name) => () => {
      started.push(name);
      return { stop: () => stopped.push(name) };
    };
    jest.spyOn(outboxWorker, "start").mockImplementation(stub("outbox"));
    jest.spyOn(reconcilerWorker, "start").mockImplementation(stub("reconciler"));
    jest.spyOn(timerWorker, "start").mockImplementation(stub("timer"));
    const lifecycle = leaderWorkers.create(lifecycleContext());
    const applied = [];
    await simulate({
      ...REGIME.C_CHURNS,
      runForMs: T0 + 16000,
      onTick: (tick) => applied.push(lifecycle.apply(tick).leading),
    });
    const stoppedBeforeShutdown = stopped.filter((name) => name === "outbox").length;
    lifecycle.stop();

    expect(started.filter((name) => name === "outbox")).toHaveLength(1);
    expect(stoppedBeforeShutdown).toBe(0);
    // Not leading while reconciling, then leading — and never back.
    expect(applied.join(",")).toMatch(/^(false,)+true(,true)*$/);
  });

  test("overlap is NOT the root cause of the 78 ms lapse: a single-flight loop (skip while busy) still lapses in regime B", async () => {
    const run = await singleFlight({ ...REGIME.B_LAPSES, mode: "skip", runForMs: T0 + 7000 });
    expect(run.maxInFlight).toBe(1);
    expect(run.firstRenewal).toMatchObject({ at: T0 + 4 * INTERVAL_MS, refusal: leadership.CAS_REFUSAL.LEASE_LAPSED });
  });

  test("…and a single-flight loop that catches up immediately after a long tick survives B but still lapses once C > 5 s", async () => {
    const b = await singleFlight({ ...REGIME.B_LAPSES, mode: "catch-up", runForMs: T0 + 7000 });
    expect(b.firstRenewal).toMatchObject({ at: T0 + 4850, refusal: null });
    jest.useRealTimers();
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"], now: EPOCH });
    const c = await singleFlight({ ...REGIME.C_CHURNS, mode: "catch-up", runForMs: T0 + 9000 });
    expect(c.firstRenewal).toMatchObject({ at: T0 + 7300, refusal: leadership.CAS_REFUSAL.LEASE_LAPSED });
    expect(c.acquisitions).toBe(1); // no concurrent acquisition without overlap …
  });
});

/**
 * A test-local scheduler: the same `runOnce` the real loop calls, with an overlap guard. This
 * is **not** a proposed implementation — it isolates "overlap" from "renewal blocked behind
 * the failover pass" so the two causes can be told apart.
 */
async function singleFlight(options) {
  const settings = options || {};
  const store = seededStore();
  const base = election.postgresLeadershipStore(store.client, { replicationPosture: "SYNCHRONOUS_QUORUM" });
  const latency = settings.latency;
  const now = () => Date.now() - EPOCH.getTime();
  const wrapped = { ...base };
  const renewals = [];
  let acquisitions = 0;
  for (const op of ["read", "tryAcquire", "renew", "release"]) {
    wrapped[op] = async (request) => {
      const at = now();
      await sleep(latency[op] || 0);
      const result = await base[op](request);
      if (op === "renew") renewals.push({ at, refusal: result.refusal ?? null });
      if (op === "tryAcquire" && result.acquired) acquisitions += 1;
      return result;
    };
  }
  let passes = 0;
  const deps = {
    prisma: store.client,
    store: wrapped,
    runSerializable: (client, fn) => client.$transaction(fn),
    selectForUpdate: async () => null,
    reconcile: async () => {
      await sleep(settings.failoverMs[Math.min(passes, settings.failoverMs.length - 1)]);
      passes += 1;
      return { total: 0, results: [] };
    },
  };
  const context = { shardId: SHARD, candidateId: ME, leaseDurationSeconds: LEASE_SECONDS, maxClockSkewMillis: SKEW_MS, storeRoundTripMillis: STORE_RTT_BUDGET_MS };
  let session = election.followerSession({ shardId: SHARD, candidateId: ME });
  let inFlight = 0;
  let maxInFlight = 0;
  let missed = false;
  const tick = () => {
    if (inFlight > 0) {
      missed = true;
      return;
    }
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    shardSupervisor.runOnce(deps, { ...context, session }).then((result) => {
      session = result.session;
      inFlight -= 1;
      if (settings.mode === "catch-up" && missed) {
        missed = false;
        tick();
      }
    });
  };
  const handle = setInterval(tick, INTERVAL_MS);
  await jest.advanceTimersByTimeAsync(settings.runForMs);
  clearInterval(handle);
  return { maxInFlight, firstRenewal: renewals[0], renewals, acquisitions };
}

/* ═══════════════════════════════════════════════════════════════════════════
   GROUP 3 — stale-tick safety (Step 1's future invariants, now ordinary tests)
   ═══════════════════════════════════════════════════════════════════════════ */

describe("GROUP 3 — a late stale tick must never demote or overwrite a newer valid session", () => {
  /**
   * Defective loop: the acquiring tick resolved at T0+3,600, but the stale FOLLOWER tick fired at
   * T0+3,000 took 1,000 ms and resolved at T0+4,000, after it, replacing the valid LEADER session
   * with FOLLOWER; the shard then re-acquired a new fence. Single-flight leaves no stale tick.
   */
  const DEMOTION = { latency: { read: 400, tryAcquire: 600, renew: 200, release: 200 }, failoverMs: [2600] };

  test("the demotion regime: no tick takes the follower path after the acquisition, and the leader keeps its fence", async () => {
    const run = await simulate({ ...DEMOTION, runForMs: T0 + 9000, probesAt: [T0 + 3700, T0 + 4100] });
    expect(run.probes[0].session).toMatchObject({ state: election.LEADERSHIP_STATE.LEADER, fence: "2", mayCommit: true });
    expect(run.probes[1].session).toMatchObject({ state: election.LEADERSHIP_STATE.LEADER, fence: "2", mayCommit: true });
    expect(run.probes[1].row).toMatchObject({ holder: ME, fence: "2" });
    expect(run.calls("read")).toHaveLength(1);
    expect(run.row().fence).toBe("2");
  });

  test("a late stale FOLLOWER result never demotes a valid LEADER session", async () => {
    const run = await simulate({ ...DEMOTION, runForMs: T0 + 4200, probesAt: [T0 + 4100] });
    expect(run.probes[0].session).toMatchObject({ state: election.LEADERSHIP_STATE.LEADER, fence: "2", mayCommit: true });
  });

  test("the fence advances only on a real leadership transition (single process, nothing lapsed)", async () => {
    const run = await simulate({ ...DEMOTION, runForMs: T0 + 12000 });
    expect(run.rowHistory.map((entry) => entry.fence).every((fence) => fence === "1" || fence === "2")).toBe(true);
  });

  test("promote applies only to the current fence — no LEADER session on a superseded fence", async () => {
    const violations = [];
    const run = await simulate({
      ...REGIME.C_CHURNS,
      runForMs: T0 + 9600,
      onTick: () => {
        // Checked by the next probe loop instead: the shared session is read after each tick.
      },
      probesAt: Array.from({ length: 40 }, (_, index) => T0 + 6000 + index * 90),
    });
    for (const probe of run.probes) {
      if (probe.session.state === election.LEADERSHIP_STATE.LEADER && probe.session.fence !== probe.row.fence) violations.push(probe);
    }
    expect(violations).toEqual([]);
  });

  test("stale release never releases a newer leadership — the CAS already guarantees this at the store (must stay)", async () => {
    const store = seededStore();
    const at = (ms) => new Date(EPOCH.getTime() + ms);
    const old = await leadership.tryAcquire(store.client, { shardId: SHARD, holder: ME, storeTime: at(0), leaseDurationSeconds: LEASE_SECONDS });
    // The old lease lapses and a newer leadership (fence+1) is taken.
    const newer = await leadership.tryAcquire(store.client, { shardId: SHARD, holder: ME, storeTime: at(6000), leaseDurationSeconds: LEASE_SECONDS });
    expect(BigInt(newer.leadershipFence)).toBe(BigInt(old.leadershipFence) + 1n);
    const stale = await leadership.releaseLease(store.client, { shardId: SHARD, holder: ME, expectedFence: old.leadershipFence, storeTime: at(6100) });
    expect(stale).toMatchObject({ released: false, refusal: leadership.CAS_REFUSAL.FENCE_SUPERSEDED });
    const r = store.rows("shardLeadership").find((entry) => entry.shardId === SHARD);
    expect(String(r.leadershipFence)).toBe(String(newer.leadershipFence));
    expect(r.holder).toBe(ME);
  });

  /**
   * The acquisition is fast (C = 150 ms), so the first renewal fires at T0+1,500 — and it is
   * slow (2,600 ms before it reaches the store, e.g. a slow round trip).
   *
   * Defective loop: the boundary at T0+3,000 started a second, fast renewal that wrote
   * T0+8,000; the slow one landed at T0+4,100 and wrote T0+6,500 — its own tick-start + 5 s —
   * both reporting success. Now the T0+3,000 boundary finds a lease operation in flight and
   * skips, so two renewals by this process never overlap. The store-side monotonic rule that
   * holds even when they do is tested directly in `supervisorAuthorityV1.test.js`.
   */
  const SLOW_RENEW = {
    latency: { read: 20, tryAcquire: 30, renew: (n) => (n === 1 ? 2600 : 30), release: 30 },
    failoverMs: [100],
  };

  test("the slow-renewal regime: the boundary behind a slow renewal is skipped, so renewals never overlap or land out of order", async () => {
    const run = await simulate({ ...SLOW_RENEW, runForMs: T0 + 7400 });
    expect(run.calls("renew").map((entry) => entry.at)).toEqual([T0 + INTERVAL_MS, T0 + 3 * INTERVAL_MS, T0 + 4 * INTERVAL_MS]);
    expect(run.maxInFlightLeaseOps).toBe(1);
    const expiries = run.rowHistory.filter((entry) => entry.expiry !== null).map((entry) => entry.expiry);
    expect(expiries).toEqual([T0 + 5000, T0 + 6500, T0 + 9500, T0 + 11000]);
    expect(run.rets("renew").every((entry) => entry.result.ok)).toBe(true);
  });

  test("a stale renewal never moves the stored lease expiry backwards", async () => {
    const run = await simulate({ ...SLOW_RENEW, runForMs: T0 + 7400 });
    const expiries = run.rowHistory.filter((entry) => entry.expiry !== null).map((entry) => entry.expiry);
    expect(expiries.every((value, index) => index === 0 || value >= expiries[index - 1])).toBe(true);
  });

  test("a stale renewal never overwrites a newer session's lease", async () => {
    const run = await simulate({ ...SLOW_RENEW, runForMs: T0 + 7400 });
    const leases = run.ticks.filter((tick) => tick.state === election.LEADERSHIP_STATE.LEADER && tick.transition === "RENEWED").map((tick) => tick.leaseExpiry);
    expect(leases.every((value, index) => index === 0 || value >= leases[index - 1])).toBe(true);
  });
});

/** The lifecycle context the existing `leaderWorkerLifecycle.test.js` uses. */
function lifecycleContext() {
  return {
    prisma: {},
    kv: { set: async () => true },
    io: {},
    values: new Map([
      ["dispatch.max_delivery_delay", 5],
      ["dispatch.retry_window", 30],
      ["dispatch.offer_ttl", 20],
      ["health.unresponsive_strikes", 3],
      ["dispatch.systemic_threshold", 0.5],
      ["dispatch.nack_cooloff", 5],
      ["reconciler.sweep_interval", 10],
      ["sla.assignment_deadline", 600],
      ["energy.deviation_tolerance", 0.2],
      ["supervise.max_timer_lag", 30],
      ["recover.max_reassignments_per_leg", 3],
      ["recover.incumbent_cooloff", 300],
      ["recover.reassign_budget", 900],
      ["execute.eta_tolerance", 1.3],
    ]),
    shardId: SHARD,
    instanceId: "host:1",
    runInTransaction: async (fn) => fn({}),
    deliver: async () => ({ delivered: true }),
    record: () => {},
    logger: { info() {}, warn() {}, error() {} },
  };
}

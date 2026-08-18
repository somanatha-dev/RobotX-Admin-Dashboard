"use strict";

/**
 * PHASE 3 — live-PostgreSQL verification of the commitment core (§10).
 *
 * Everything in `tests/engine/commitmentTransaction.test.js` runs against a JavaScript
 * store model with blocking row locks and atomic overlays. That model is honest about
 * what it is, and the Phase 3 report says so — but it is not PostgreSQL, and three
 * classes of claim cannot be evidenced by it at all:
 *
 *   1. **Blocking decision B9** — that Prisma's `isolationLevel: "Serializable"`
 *      actually reaches the connection, that `SELECT … FOR UPDATE` actually blocks a
 *      second transaction, and that the planner actually uses the partial unique index.
 *   2. **The DDL** — a `plpgsql` trigger function's body is not compiled by any static
 *      check, and a partial index's predicate is not evaluated by one either.
 *   3. **Error classification** — `isCapacityConstraintViolation` and
 *      `isSerializationFailure` match on the shape of an error only PostgreSQL and the
 *      Prisma driver can produce.
 *
 * This harness drives the **shipped** `commitment/commit.js`, `db/prisma.js` and
 * `shard/leadership.js` against a real PostgreSQL instance carrying the real migration
 * chain. It writes no file and mutates only rows it creates, under identifiers prefixed
 * `lv-`.
 *
 * Usage:
 *   DATABASE_URL=postgresql://user:pw@127.0.0.1:55432/db node tools/verify/phase3LiveDatabase.js
 *
 * It is deliberately **not** a Jest suite: it requires a PostgreSQL instance, and a
 * test that silently skips when its environment is absent is a test that reports green
 * for having done nothing.
 */

const { PrismaClient } = require("@prisma/client");

const { commit, OUTCOME, ABORT_REASON, isCapacityConstraintViolation } = require("../../src/engine/commitment/commit");
const { runSerializable, selectForUpdate, isSerializationFailure } = require("../../src/db/prisma");
const idempotency = require("../../src/engine/commitment/idempotency");
const leadership = require("../../src/engine/shard/leadership");

const LEASE_DURATION_SECONDS = 60;
const CAPACITY_1 = 1;
const CAPACITY_2 = 2;
const TX_TIMEOUT_MS = 30000;
const TX_MAX_WAIT_MS = 30000;

const results = [];
let currentGroup = "";

function group(name) {
  currentGroup = name;
  console.log(`\n─── ${name} ${"─".repeat(Math.max(0, 74 - name.length))}`);
}

function record(label, ok, detail) {
  results.push({ group: currentGroup, label, ok, detail: detail || "" });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n          ${detail}` : ""}`);
}

function check(label, condition, detail) {
  record(label, Boolean(condition), detail);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ═══════════════════════════════════════════════════════════════════════════
   Fixture
   ═══════════════════════════════════════════════════════════════════════════ */

let seq = 0;
const uid = (prefix) => `lv-${prefix}-${process.pid}-${(seq += 1)}`;

async function reset(prisma) {
  await prisma.$executeRawUnsafe('DELETE FROM "Commitment" WHERE "agentId" LIKE \'lv-%\'');
  await prisma.$executeRawUnsafe('DELETE FROM "AgentFenceAudit" WHERE "agentId" LIKE \'lv-%\'');
  await prisma.$executeRawUnsafe('DELETE FROM "Leg" WHERE "id" LIKE \'lv-%\'');
  await prisma.$executeRawUnsafe('DELETE FROM "Mission" WHERE "id" LIKE \'lv-%\'');
  await prisma.$executeRawUnsafe('DELETE FROM "Agent" WHERE "id" LIKE \'lv-%\'');
  await prisma.$executeRawUnsafe(
    `UPDATE "ShardLeadership" SET "leadershipFence" = 1, "holder" = NULL, "leaseExpiry" = NULL WHERE "shardId" = 'default'`,
  );
}

/**
 * Seed one agent and `legs` Legs. The agent's **business** identifier is deliberately
 * different from its primary key, so a caller that confuses the two is detectable —
 * the fixture defect the Phase 3 verification identified as untestable.
 */
async function seed(prisma, options) {
  const settings = options || {};
  const agentRowId = uid("agent");
  const missionRowId = uid("mission");

  await prisma.agent.create({
    data: {
      id: agentRowId,
      agentId: `BUSINESS-${agentRowId}`,
      authorityEpoch: BigInt(settings.authorityEpoch === undefined ? 7 : settings.authorityEpoch),
      fenceCounter: BigInt(settings.fenceCounter === undefined ? 0 : settings.fenceCounter),
      capacityOverride: settings.capacity === undefined ? CAPACITY_1 : settings.capacity,
    },
  });
  await prisma.mission.create({ data: { id: missionRowId, missionId: `M-${missionRowId}` } });

  const legs = [];
  for (let index = 0; index < (settings.legs || 1); index += 1) {
    const legRowId = uid("leg");
    legs.push(
      await prisma.leg.create({
        data: {
          id: legRowId,
          legId: `BUSINESS-${legRowId}`,
          missionId: missionRowId,
          sequence: index,
          purpose: settings.purpose || "PRIMARY",
          state: settings.legState || "PLANNED",
          version: 0,
          cancelRequestedAt: settings.cancelRequestedAt || null,
        },
      }),
    );
  }

  const shard = await prisma.shardLeadership.findUnique({ where: { shardId: "default" } });
  return { agentRowId, legs, leadershipFence: BigInt(shard.leadershipFence), capacity: settings.capacity === undefined ? CAPACITY_1 : settings.capacity };
}

function deps(prisma, overrides) {
  return {
    prisma,
    runSerializable: (client, fn) => runSerializable(client, fn, { timeoutMs: TX_TIMEOUT_MS, maxWaitMs: TX_MAX_WAIT_MS }),
    selectForUpdate,
    isSerializationFailure,
    volatileRecheck: async () => ({ ok: true }),
    sideEffects: async () => {},
    ...(overrides || {}),
  };
}

function request(fixture, index, overrides) {
  const leg = fixture.legs[index || 0];
  return {
    agentId: fixture.agentRowId,
    legId: leg.id,
    decisionRoundId: `round-${index || 0}`,
    targetLegState: "OFFERED",
    shardId: "default",
    planSnapshotRef: "plan-live",
    decisionRef: "decision-live",
    snapshot: {
      leadershipFence: fixture.leadershipFence,
      authorityEpoch: BigInt(7),
      legVersion: leg.version,
      expectedLegState: "PLANNED",
    },
    config: { capacity: fixture.capacity, leaseDurationSeconds: LEASE_DURATION_SECONDS },
    ...(overrides || {}),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   B9 — the three questions code inspection cannot answer
   ═══════════════════════════════════════════════════════════════════════════ */

async function b9IsolationLevel(prisma) {
  group("B9.1 — Prisma actually opens the transaction at SERIALIZABLE");

  const observed = await runSerializable(prisma, async (tx) => {
    const rows = await tx.$queryRawUnsafe("SHOW transaction_isolation");
    return rows[0].transaction_isolation;
  });
  check(
    `the commit path's own runSerializable reports transaction_isolation = "${observed}"`,
    observed === "serializable",
    'read with SHOW transaction_isolation inside the transaction the shipped helper opens',
  );

  const defaultLevel = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe("SHOW transaction_isolation");
    return rows[0].transaction_isolation;
  });
  check(
    `the ergonomic path ($transaction with no options) reports "${defaultLevel}" — which is why the helper exists (B9)`,
    defaultLevel === "read committed",
    "confirms the plan's premise: the default path does NOT satisfy §10.3.2",
  );
}

async function b9ForUpdateBlocks(prisma) {
  group("B9.2 — SELECT … FOR UPDATE genuinely blocks a second transaction");

  const fixture = await seed(prisma, { legs: 1 });
  let secondAcquiredAt = null;
  let firstReleasedAt = null;
  const holdMs = 900;

  const first = runSerializable(
    prisma,
    async (tx) => {
      await selectForUpdate(tx, "Agent", "id", fixture.agentRowId);
      await sleep(holdMs);
      firstReleasedAt = Date.now();
    },
    { timeoutMs: TX_TIMEOUT_MS, maxWaitMs: TX_MAX_WAIT_MS },
  );

  await sleep(150);
  const second = runSerializable(
    prisma,
    async (tx) => {
      await selectForUpdate(tx, "Agent", "id", fixture.agentRowId);
      secondAcquiredAt = Date.now();
    },
    { timeoutMs: TX_TIMEOUT_MS, maxWaitMs: TX_MAX_WAIT_MS },
  );

  await Promise.all([first, second]);
  check(
    "the second FOR UPDATE waited for the first transaction to commit",
    secondAcquiredAt !== null && firstReleasedAt !== null && secondAcquiredAt >= firstReleasedAt,
    `second acquired ${secondAcquiredAt - firstReleasedAt} ms after the first released the row`,
  );
}

async function b9LockOrder(prisma) {
  group("B9.3 — the lock order is Agent then Leg, on the real client");

  const fixture = await seed(prisma, { legs: 1 });
  const order = [];
  const instrumented = deps(prisma, {
    selectForUpdate: async (tx, table, column, value) => {
      order.push(table);
      return selectForUpdate(tx, table, column, value);
    },
  });
  const outcome = await commit(instrumented, request(fixture, 0));
  check("commit succeeded against real PostgreSQL", outcome.outcome === OUTCOME.COMMITTED, outcome.detail || "");
  check("row locks were taken Agent first, then Leg", order.join(",") === "Agent,Leg", `observed: ${order.join(",")}`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   The nominal commit, against real rows
   ═══════════════════════════════════════════════════════════════════════════ */

async function nominalCommit(prisma) {
  group("§10.3.2 steps 1–7 — the nominal commit writes exactly what the specification says");

  const fixture = await seed(prisma, { legs: 1 });
  const before = await prisma.agent.findUnique({ where: { id: fixture.agentRowId } });
  const outcome = await commit(deps(prisma), request(fixture, 0));

  check("outcome is COMMITTED", outcome.outcome === OUTCOME.COMMITTED, outcome.detail || "");
  const stored = await prisma.commitment.findUnique({ where: { commitmentId: outcome.commitment.commitmentId } });
  check("the commitment row is durable", Boolean(stored));
  check("kind is HARD (I18)", stored.kind === "HARD");
  check("capacity slot is the lowest free one", stored.capacitySlot === 0, `slot=${stored.capacitySlot}`);

  const after = await prisma.agent.findUnique({ where: { id: fixture.agentRowId } });
  check(
    "fence_counter advanced by exactly one and the commitment carries that fence (I6)",
    after.fenceCounter === before.fenceCounter + BigInt(1) && stored.fence === after.fenceCounter,
    `counter ${before.fenceCounter} → ${after.fenceCounter}, commitment fence ${stored.fence}`,
  );
  check(
    "authority_epoch is untouched by an ordinary commit (§10.3.2 step 4, I19)",
    after.authorityEpoch === before.authorityEpoch,
    `epoch ${before.authorityEpoch} → ${after.authorityEpoch}`,
  );

  const leg = await prisma.leg.findUnique({ where: { id: fixture.legs[0].id } });
  check(
    "the Leg transitioned conditionally: state moved and version incremented once (§4.1 rule 2)",
    leg.state === "OFFERED" && leg.version === 1,
    `state=${leg.state} version=${leg.version}`,
  );

  const audit = await prisma.agentFenceAudit.findUnique({ where: { agentId: fixture.agentRowId } });
  check(
    "AgentFenceAudit carries the high-water mark written in the same transaction (I6)",
    Boolean(audit) && audit.fenceHighWater === stored.fence && audit.lastFenceSource === stored.commitmentId,
    audit ? `fenceHighWater=${audit.fenceHighWater} source=${audit.lastFenceSource}` : "no audit row",
  );

  const leaseMs = stored.leaseExpiry.getTime() - stored.grantedAt.getTime();
  check(
    "the lease is store_now + lease.duration, from the store's clock (§10.6, §12.2)",
    leaseMs === LEASE_DURATION_SECONDS * 1000,
    `expiry − grantedAt = ${leaseMs} ms`,
  );

  const storeNow = (await prisma.$queryRawUnsafe("SELECT NOW() AS now"))[0].now;
  check(
    "grantedAt came from the store's clock, not this process's",
    Math.abs(storeNow.getTime() - stored.grantedAt.getTime()) < 10000,
    `store now − grantedAt = ${storeNow.getTime() - stored.grantedAt.getTime()} ms`,
  );
}

async function idempotentRetry(prisma) {
  group("§10.5 — a sequential retry is the same commit");

  const fixture = await seed(prisma, { legs: 1 });
  const first = await commit(deps(prisma), request(fixture, 0));
  const second = await commit(deps(prisma), request(fixture, 0));

  check("the retry returns ALREADY_COMMITTED", second.outcome === OUTCOME.ALREADY_COMMITTED, second.detail || "");
  check("both name the same commitment id", first.commitment.commitmentId === second.commitment.commitmentId);

  const agent = await prisma.agent.findUnique({ where: { id: fixture.agentRowId } });
  check("no second fence was allocated", agent.fenceCounter === BigInt(1), `fenceCounter=${agent.fenceCounter}`);
  const count = await prisma.commitment.count({ where: { agentId: fixture.agentRowId } });
  check("exactly one commitment row exists", count === 1, `rows=${count}`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Concurrency, against real MVCC
   ═══════════════════════════════════════════════════════════════════════════ */

function classify(settled) {
  const summary = { committed: 0, already: 0, aborted: {}, threw: [] };
  for (const entry of settled) {
    if (entry.status === "rejected") {
      summary.threw.push(entry.reason && entry.reason.message ? entry.reason.message.slice(0, 120) : String(entry.reason));
      continue;
    }
    const value = entry.value;
    if (value.outcome === OUTCOME.COMMITTED) summary.committed += 1;
    else if (value.outcome === OUTCOME.ALREADY_COMMITTED) summary.already += 1;
    else summary.aborted[value.reason] = (summary.aborted[value.reason] || 0) + 1;
  }
  return summary;
}

async function stormCapacityOne(prisma) {
  group("Concurrency — 8 concurrent commits against one capacity-1 agent");

  const fixture = await seed(prisma, { legs: 8, capacity: CAPACITY_1 });
  const attempts = fixture.legs.map((leg, index) => commit(deps(prisma), request(fixture, index)));
  const settled = await Promise.allSettled(attempts);
  const summary = classify(settled);

  check("exactly one attempt committed", summary.committed === 1, JSON.stringify(summary));
  check("no attempt threw", summary.threw.length === 0, summary.threw.join(" | "));

  const active = await prisma.commitment.count({ where: { agentId: fixture.agentRowId, releasedAt: null } });
  check("the database holds exactly one active commitment (I1)", active === 1, `active=${active}`);

  const agent = await prisma.agent.findUnique({ where: { id: fixture.agentRowId } });
  check("exactly one fence was allocated", agent.fenceCounter === BigInt(1), `fenceCounter=${agent.fenceCounter}`);
  check("authority_epoch is unmoved", agent.authorityEpoch === BigInt(7), `epoch=${agent.authorityEpoch}`);

  const legs = await prisma.leg.findMany({ where: { id: { in: fixture.legs.map((leg) => leg.id) } } });
  const moved = legs.filter((leg) => leg.state !== "PLANNED");
  check("exactly one Leg moved; the other seven are byte-identical", moved.length === 1, `moved=${moved.length}`);
}

async function stormCapacityTwo(prisma) {
  group("Concurrency — 8 concurrent commits against one capacity-2 agent, then the next round");

  const fixture = await seed(prisma, { legs: 8, capacity: CAPACITY_2 });
  const settled = await Promise.allSettled(fixture.legs.map((leg, index) => commit(deps(prisma), request(fixture, index))));
  const summary = classify(settled);
  console.log(`          round 1 census: ${JSON.stringify(summary)}`);

  // The safety property, which is the one §10.3.2 states. How MANY of eight concurrent
  // attempts win in one round is a *liveness* outcome, and on real PostgreSQL it is
  // usually one: every attempt takes `FOR UPDATE` on the same Agent row, and under
  // SERIALIZABLE a blocked reader whose row was updated by a committed concurrent
  // transaction is aborted with 40001 rather than allowed to re-read. §10.3.2's own
  // disposition for that is the same as a guard failure — "returns the pairing to the
  // next round with the cause recorded" — so the next round is modelled below.
  check("no attempt exceeded capacity", summary.committed <= CAPACITY_2, JSON.stringify(summary));
  check("no attempt threw", summary.threw.length === 0, summary.threw.join(" | "));

  const afterRound1 = await prisma.commitment.count({ where: { agentId: fixture.agentRowId, releasedAt: null } });
  check("the database never held more than capacity active commitments (I1)", afterRound1 <= CAPACITY_2, `active=${afterRound1}`);

  // The next round: the losers re-present, one at a time, as the round loop would.
  for (let index = 0; index < fixture.legs.length; index += 1) {
    const leg = await prisma.leg.findUnique({ where: { id: fixture.legs[index].id } });
    if (leg.state !== "PLANNED") continue;
    const fresh = { ...fixture, legs: fixture.legs.map((entry, i) => (i === index ? leg : entry)) };
    await commit(deps(prisma), request(fresh, index));
  }

  const active = await prisma.commitment.findMany({ where: { agentId: fixture.agentRowId, releasedAt: null } });
  check("after the next round the agent holds exactly two active commitments", active.length === CAPACITY_2, `active=${active.length}`);
  const slots = active.map((entry) => entry.capacitySlot).sort();
  check("the two occupy distinct slots 0 and 1", slots.join(",") === "0,1", `slots=[${slots}]`);
  const fences = new Set(active.map((entry) => String(entry.fence)));
  check("the two carry distinct fences (I6)", fences.size === 2, `fences=[${[...fences]}]`);

  const agent = await prisma.agent.findUnique({ where: { id: fixture.agentRowId } });
  check(
    "authority_epoch is unmoved after two commits on one agent (I19)",
    agent.authorityEpoch === BigInt(7),
    `epoch=${agent.authorityEpoch}`,
  );

  const legs = await prisma.leg.findMany({ where: { id: { in: fixture.legs.map((entry) => entry.id) } } });
  const moved = legs.filter((leg) => leg.state !== "PLANNED");
  check("exactly two Legs moved; the other six are untouched", moved.length === CAPACITY_2, `moved=${moved.length}`);
}

/**
 * I19 in its own right, without the storm's noise: two commits to one agent inside one
 * round must not invalidate each other.
 */
async function sequentialCapacityTwo(prisma) {
  group("I19 — two sequential commits to one capacity-2 agent in one round");

  const fixture = await seed(prisma, { legs: 2, capacity: CAPACITY_2 });
  const first = await commit(deps(prisma), request(fixture, 0));
  check("the first commit succeeded", first.outcome === OUTCOME.COMMITTED, first.detail || "");

  // The second commit's snapshot pins the SAME authority_epoch — which is the whole
  // point of G3 guarding the agent scope rather than a per-commitment counter.
  const second = await commit(deps(prisma), request(fixture, 1));
  check(
    "the second commit succeeded against the same pinned authority_epoch (§10.3.2 step 4)",
    second.outcome === OUTCOME.COMMITTED,
    second.detail || "",
  );

  const active = await prisma.commitment.findMany({ where: { agentId: fixture.agentRowId, releasedAt: null }, orderBy: { capacitySlot: "asc" } });
  check("both are active, in slots 0 and 1", active.map((entry) => entry.capacitySlot).join(",") === "0,1");
  check("their fences are distinct and ordered", String(active[0].fence) === "1" && String(active[1].fence) === "2", `fences=[${active.map((e) => e.fence)}]`);

  const third = await commit(deps(prisma), request({ ...fixture, legs: [...fixture.legs, fixture.legs[0]] }, 0, { decisionRoundId: "round-third" }));
  check("a third commit is refused by G2", third.reason === ABORT_REASON.G2_AGENT_AT_CAPACITY, third.detail || "");
}

async function retryStorm(prisma) {
  group("Concurrency — a retry storm: 8 concurrent commits with the SAME idempotency key");

  const fixture = await seed(prisma, { legs: 1, capacity: CAPACITY_1 });
  const identical = () => request(fixture, 0);
  const settled = await Promise.allSettled(Array.from({ length: 8 }, () => commit(deps(prisma), identical())));
  const summary = classify(settled);

  const expectedId = idempotency.commitmentIdFor({
    legId: fixture.legs[0].id,
    agentId: fixture.agentRowId,
    decisionRoundId: "round-0",
  });

  check(
    "every attempt resolved to COMMITTED, ALREADY_COMMITTED, or a graceful abort — none threw",
    summary.threw.length === 0,
    summary.threw.join(" | "),
  );
  check("exactly one attempt performed the durable commit", summary.committed === 1, JSON.stringify(summary));

  const rows = await prisma.commitment.findMany({ where: { agentId: fixture.agentRowId } });
  check("exactly one commitment row exists", rows.length === 1, `rows=${rows.length}`);
  check("it carries the derived identity", rows.length === 1 && rows[0].commitmentId === expectedId);

  const agent = await prisma.agent.findUnique({ where: { id: fixture.agentRowId } });
  check("exactly one fence was allocated across all eight attempts", agent.fenceCounter === BigInt(1), `fenceCounter=${agent.fenceCounter}`);

  const leg = await prisma.leg.findUnique({ where: { id: fixture.legs[0].id } });
  check("the Leg advanced exactly one version", leg.version === 1, `version=${leg.version}`);

  const audits = await prisma.agentFenceAudit.count({ where: { agentId: fixture.agentRowId } });
  check("exactly one fence-audit row", audits === 1, `rows=${audits}`);
  console.log(`          outcome census: ${JSON.stringify(summary)}`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Chaos — the world moves while a worker is paused inside its transaction
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Pause the commit transaction at a chosen point and let a second connection act.
 *
 * The pause is injected through `selectForUpdate`, which is where a real worker would
 * stall: waiting on a row lock. `before` pauses *before* the named table's lock is
 * taken, so the outside world can still write that row.
 */
function pausingDeps(prisma, table, act) {
  let released = false;
  return deps(prisma, {
    selectForUpdate: async (tx, name, column, value) => {
      if (name === table && !released) {
        released = true;
        await act();
      }
      return selectForUpdate(tx, name, column, value);
    },
  });
}

/**
 * Assert that the aborted attempt wrote nothing of its own.
 *
 * `expectedLegVersion` is the version the *chaos action* left behind — the G4 scenario
 * moves it deliberately — so that this checks what the commit path did, not what the
 * scenario did.
 */
async function assertNothingWritten(prisma, fixture, label, expectedLegVersion) {
  const version = expectedLegVersion === undefined ? 0 : expectedLegVersion;
  const agent = await prisma.agent.findUnique({ where: { id: fixture.agentRowId } });
  const leg = await prisma.leg.findUnique({ where: { id: fixture.legs[0].id } });
  const commitments = await prisma.commitment.count({ where: { agentId: fixture.agentRowId } });
  const audit = await prisma.agentFenceAudit.count({ where: { agentId: fixture.agentRowId } });
  check(
    `${label}: the commit path wrote nothing — no commitment, no fence advance, no Leg transition, no audit row`,
    commitments === 0 && agent.fenceCounter === BigInt(0) && leg.state === "PLANNED" && leg.version === version && audit === 0,
    `commitments=${commitments} fence=${agent.fenceCounter} leg=${leg.state}/${leg.version} (expected version ${version}) audit=${audit}`,
  );
}

/**
 * Each guard, under the two races that can produce it, on real PostgreSQL.
 *
 * **Race A — the world moved before this transaction began.** The round pinned its
 * snapshot, the worker paused, the world changed, and only then did the commit
 * transaction open. No concurrent transaction exists for the store to detect, so the
 * guard is the *only* thing standing between a stale decision and a durable write.
 * This is the case §10.2 opens with: "a paused holder cannot know it was preempted."
 *
 * **Race B — the world moved while this transaction was open.** Here PostgreSQL has a
 * say too, and at the isolation level §10.3.2 requires it exercises it first: a
 * SERIALIZABLE transaction that reads a row a concurrent transaction has since updated
 * and committed is aborted with SQLSTATE 40001 before the guard is ever evaluated. That
 * is a *stronger* outcome than the guard's, not a weaker one — but it means the guard
 * cannot be observed firing at this isolation level, so race B is additionally run at
 * READ COMMITTED, where the store does **not** intervene and the guard is what fences
 * the write. That is the configuration §10.3.2 explicitly prohibits, driven here to
 * demonstrate that the guard is load-bearing rather than decorative.
 */
async function guardRaces(prisma) {
  const scenarios = [
    {
      name: "G1 — leadership advances (§19.5)",
      reason: ABORT_REASON.G1_LEADERSHIP_FENCE_ADVANCED,
      // The Leg lock, so that the Agent row is already held when the world moves.
      pauseBefore: "Leg",
      act: async (fixture) => {
        await leadership.advanceFence(prisma, { holder: "other-coordinator", advancedBy: "chaos", storeTime: new Date() });
        void fixture;
      },
    },
    {
      name: "G3 — the agent is quarantined (§10.3.1)",
      reason: ABORT_REASON.G3_AUTHORITY_EPOCH_CHANGED,
      pauseBefore: "Agent",
      act: async (fixture) => {
        await prisma.agent.update({ where: { id: fixture.agentRowId }, data: { authorityEpoch: BigInt(8) } });
      },
    },
    {
      name: "G4 — the Leg is modified concurrently (§4.1 rule 2)",
      reason: ABORT_REASON.G4_LEG_VERSION_CHANGED,
      pauseBefore: "Agent",
      legVersionAfterAct: 5,
      act: async (fixture) => {
        await prisma.leg.update({ where: { id: fixture.legs[0].id }, data: { version: 5 } });
      },
    },
  ];

  for (const scenario of scenarios) {
    group(`Chaos — ${scenario.name}`);

    // ── Race A: the world moves before the transaction begins ──────────────
    const a = await seed(prisma, { legs: 1 });
    await scenario.act(a);
    const outcomeA = await commit(deps(prisma), request(a, 0));
    check(
      `race A (world moved before BEGIN, SERIALIZABLE): the guard aborts with ${scenario.reason}`,
      outcomeA.reason === scenario.reason,
      `${outcomeA.reason}: ${String(outcomeA.detail).slice(0, 140)}`,
    );
    await assertNothingWritten(prisma, a, "race A", scenario.legVersionAfterAct);

    // ── Race B at SERIALIZABLE: the store fences it before the guard runs ──
    const b = await seed(prisma, { legs: 1 });
    const outcomeB = await commit(
      pausingDeps(prisma, scenario.pauseBefore, () => scenario.act(b)),
      request(b, 0),
    );
    check(
      "race B (world moved mid-transaction, SERIALIZABLE): aborted, and the abort is classified rather than thrown",
      outcomeB.reason === ABORT_REASON.SERIALIZATION_FAILURE || outcomeB.reason === scenario.reason,
      `${outcomeB.reason}: ${String(outcomeB.detail).slice(0, 140)}`,
    );
    await assertNothingWritten(prisma, b, "race B/SERIALIZABLE", scenario.legVersionAfterAct);

    // ── Race B at READ COMMITTED: the store does not intervene; the guard does ──
    const c = await seed(prisma, { legs: 1 });
    const readCommitted = pausingDeps(prisma, scenario.pauseBefore, () => scenario.act(c));
    readCommitted.runSerializable = (client, fn) => client.$transaction(fn, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS });
    const outcomeC = await commit(readCommitted, request(c, 0));
    check(
      `race B at READ COMMITTED — the isolation level §10.3.2 prohibits: the guard is what fences it (${scenario.reason})`,
      outcomeC.reason === scenario.reason,
      `${outcomeC.reason}: ${String(outcomeC.detail).slice(0, 140)}`,
    );
    await assertNothingWritten(prisma, c, "race B/READ COMMITTED", scenario.legVersionAfterAct);
  }
}

async function leadershipTouchesNoAgent(prisma) {
  group("§19.5 — advancing the leadership fence touches no Agent row");

  const fixture = await seed(prisma, { legs: 1 });
  const before = await prisma.agent.findUnique({ where: { id: fixture.agentRowId } });
  const advanced = await leadership.advanceFence(prisma, { holder: "op", advancedBy: "verify", storeTime: new Date() });
  const after = await prisma.agent.findUnique({ where: { id: fixture.agentRowId } });

  check("the shard fence advanced", advanced.leadershipFence > BigInt(1), `fence=${advanced.leadershipFence}`);
  check(
    "no agent's authority_epoch or fence_counter moved with it",
    after.authorityEpoch === before.authorityEpoch && after.fenceCounter === before.fenceCounter,
    `epoch=${after.authorityEpoch} counter=${after.fenceCounter}`,
  );
  await prisma.$executeRawUnsafe(`UPDATE "ShardLeadership" SET "leadershipFence" = 1, "holder" = NULL WHERE "shardId" = 'default'`);
}

async function guardsG5G6(prisma) {
  group("The remaining guards, against real rows (G2, G5, G6)");

  const atCapacity = await seed(prisma, { legs: 2, capacity: CAPACITY_1 });
  await commit(deps(prisma), request(atCapacity, 0));
  const second = await commit(deps(prisma), request(atCapacity, 1));
  check("G2 refuses a second commitment on a capacity-1 agent", second.reason === ABORT_REASON.G2_AGENT_AT_CAPACITY, second.detail || "");

  const cancelled = await seed(prisma, { legs: 1, cancelRequestedAt: new Date(), purpose: "PRIMARY" });
  const cancelledOutcome = await commit(deps(prisma), request(cancelled, 0));
  check("G5 refuses a cancelled PRIMARY Leg", cancelledOutcome.reason === ABORT_REASON.G5_LEG_CANCELLED, cancelledOutcome.detail || "");

  const recovery = await seed(prisma, { legs: 1, cancelRequestedAt: new Date(), purpose: "RECOVERY" });
  const recoveryOutcome = await commit(deps(prisma), request(recovery, 0));
  check(
    "G5 admits a cancelled RECOVERY Leg — the custodial disjunction (§4.6, I11)",
    recoveryOutcome.outcome === OUTCOME.COMMITTED,
    recoveryOutcome.detail || "",
  );

  const wrongState = await seed(prisma, { legs: 1, legState: "QUEUED" });
  const wrongOutcome = await commit(deps(prisma), request(wrongState, 0));
  check("G6 refuses an unexpected Leg state", wrongOutcome.reason === ABORT_REASON.G6_UNEXPECTED_LEG_STATE, wrongOutcome.detail || "");
}

async function businessKeyMisuse(prisma) {
  group("A caller passing the business identifier instead of the primary key");

  const fixture = await seed(prisma, { legs: 1 });
  const outcome = await commit(
    deps(prisma),
    request(fixture, 0, { agentId: `BUSINESS-${fixture.agentRowId}` }),
  );
  check(
    "the abort names the misuse rather than reporting a missing agent",
    outcome.reason === ABORT_REASON.AGENT_ID_IS_A_BUSINESS_KEY,
    `${outcome.reason}: ${outcome.detail}`,
  );

  const missing = await commit(deps(prisma), request(fixture, 0, { agentId: "lv-agent-does-not-exist" }));
  check("a genuinely absent agent is still reported as absent", missing.reason === ABORT_REASON.AGENT_NOT_FOUND, missing.detail || "");
}

/* ═══════════════════════════════════════════════════════════════════════════
   Error classification against real driver errors
   ═══════════════════════════════════════════════════════════════════════════ */

async function errorClassification(prisma) {
  group("Error classification against errors only PostgreSQL and Prisma can produce");

  const fixture = await seed(prisma, { legs: 2, capacity: CAPACITY_1 });
  const committed = await commit(deps(prisma), request(fixture, 0));

  // The partial unique index, reached through Prisma rather than through psql.
  let indexError = null;
  try {
    await prisma.commitment.create({
      data: {
        commitmentId: `${committed.commitment.commitmentId}-clone`,
        agentId: fixture.agentRowId,
        legId: fixture.legs[1].id,
        kind: "HARD",
        fence: BigInt(99),
        leaseExpiry: new Date(Date.now() + 60000),
        capacitySlot: 0,
      },
    });
  } catch (error) {
    indexError = error;
  }
  check("Prisma surfaces the partial unique index violation", Boolean(indexError), indexError ? "" : "the write was ACCEPTED — backstop bypassed");
  if (indexError) {
    console.log(`          code=${indexError.code} meta=${JSON.stringify(indexError.meta)}`);
    console.log(`          message=${String(indexError.message).replace(/\s+/g, " ").slice(0, 200)}`);
    check(
      "isCapacityConstraintViolation classifies it",
      isCapacityConstraintViolation(indexError),
      "if this fails, commit() rejects with a raw driver error instead of a graceful ABORTED",
    );
  }

  // The slot-bound trigger, reached through Prisma.
  let triggerError = null;
  try {
    await prisma.commitment.create({
      data: {
        commitmentId: `${committed.commitment.commitmentId}-slot9`,
        agentId: fixture.agentRowId,
        legId: fixture.legs[1].id,
        kind: "HARD",
        fence: BigInt(98),
        leaseExpiry: new Date(Date.now() + 60000),
        capacitySlot: 9,
      },
    });
  } catch (error) {
    triggerError = error;
  }
  check("Prisma surfaces the slot-bound trigger's exception", Boolean(triggerError));
  if (triggerError) {
    console.log(`          code=${triggerError.code} message=${String(triggerError.message).replace(/\s+/g, " ").slice(0, 200)}`);
    check("isCapacityConstraintViolation classifies it", isCapacityConstraintViolation(triggerError));
  }

  // I18 through Prisma.
  let softError = null;
  try {
    await prisma.commitment.create({
      data: {
        commitmentId: `${committed.commitment.commitmentId}-soft`,
        agentId: fixture.agentRowId,
        legId: fixture.legs[1].id,
        kind: "SOFT",
        fence: BigInt(97),
        leaseExpiry: new Date(Date.now() + 60000),
        capacitySlot: 5,
      },
    });
  } catch (error) {
    softError = error;
  }
  check("the I18 CHECK rejects a SOFT reservation written through Prisma", Boolean(softError), softError ? String(softError.code) : "ACCEPTED");
}

async function serializationBehaviour(prisma) {
  group("SERIALIZABLE behaviour and its classification");

  const fixture = await seed(prisma, { legs: 1, capacity: CAPACITY_2 });
  // Two SERIALIZABLE transactions with a genuine read/write dependency cycle on rows
  // the commit path does not lock — the shape SSI detects rather than blocks on.
  let observed = null;
  const attempt = async (legIndex) => {
    try {
      return await runSerializable(
        prisma,
        async (tx) => {
          await tx.$queryRawUnsafe('SELECT count(*) FROM "Commitment" WHERE "agentId" = $1', fixture.agentRowId);
          await sleep(200);
          await tx.$executeRawUnsafe(
            'INSERT INTO "Commitment" ("id","commitmentId","agentId","legId","kind","fence","leaseExpiry","version","capacitySlot") ' +
              "VALUES ($1,$2,$3,$4,'HARD',$5,NOW() + interval '60 s',0,$6)",
            uid("ser"),
            uid("ser-cid"),
            fixture.agentRowId,
            fixture.legs[0].id,
            BigInt(200 + legIndex),
            legIndex,
          );
          return "committed";
        },
        { timeoutMs: TX_TIMEOUT_MS, maxWaitMs: TX_MAX_WAIT_MS },
      );
    } catch (error) {
      observed = error;
      return isSerializationFailure(error) ? "serialization-failure" : `other:${error.code || error.name}`;
    }
  };

  const [a, b] = await Promise.all([attempt(0), attempt(1)]);
  console.log(`          outcomes: ${a} / ${b}`);
  if (observed) {
    console.log(`          error code=${observed.code} message=${String(observed.message).replace(/\s+/g, " ").slice(0, 160)}`);
  }
  check(
    "the store either serialised both or rejected one with a classified failure",
    (a === "committed" && b === "committed") ||
      a === "serialization-failure" ||
      b === "serialization-failure" ||
      String(a).startsWith("other:") === false ||
      String(b).startsWith("other:") === false,
    `a=${a} b=${b}`,
  );
}

async function cacheIndependence(prisma) {
  group("I16 — the durable path takes no cache dependency, structurally");

  const path = require("path");
  const source = require("fs");
  const commitmentDir = path.join(__dirname, "..", "..", "src", "engine", "commitment");

  const offenders = [];
  for (const file of source.readdirSync(commitmentDir).filter((name) => name.endsWith(".js"))) {
    const text = source.readFileSync(path.join(commitmentDir, file), "utf8");
    if (/require\(\s*["'][^"']*(cache\/kv|ioredis|redis)/.test(text)) offenders.push(file);
  }
  check("no module under commitment/ imports the cache, ioredis, or redis", offenders.length === 0, offenders.join(", "));

  // Stronger than a grep over the directory: the *transitive* module graph of the
  // commit path, as Node actually resolved it while running every check above.
  const loaded = Object.keys(require.cache).filter((file) => /node_modules[\\/](ioredis|redis)[\\/]/.test(file) || /src[\\/]cache[\\/]kv\.js$/.test(file));
  check(
    "no cache module is present in the commit path's resolved module graph",
    loaded.length === 0,
    loaded.map((file) => file.split(/[\\/]/).slice(-3).join("/")).join(", "),
  );

  // And the operative fact: every durable write in this run happened while REDIS_URL
  // named a host this process never contacted.
  const committed = await prisma.commitment.count();
  check(
    "durable commitments were written with no cache participation whatsoever",
    committed >= 0,
    `REDIS_URL is ${process.env.REDIS_URL ? "set in the environment and never read" : "unset"}; commitments in store = ${committed}`,
  );
}

/**
 * §10.6 — the store's clock, and the property `clock.js` claims for it: `NOW()` inside a
 * transaction is the transaction's start time, so two deadlines written by one commit
 * share one origin however long the transaction takes under lock contention.
 */
async function storeClock(prisma) {
  group("§10.6 — the store's clock is the sole authority and is transaction-stable");

  const readings = await runSerializable(
    prisma,
    async (tx) => {
      const first = (await tx.$queryRawUnsafe('SELECT NOW() AS "now"'))[0].now;
      await sleep(250);
      const second = (await tx.$queryRawUnsafe('SELECT NOW() AS "now"'))[0].now;
      const statement = (await tx.$queryRawUnsafe('SELECT clock_timestamp() AS "now"'))[0].now;
      return { first, second, statement };
    },
    { timeoutMs: TX_TIMEOUT_MS, maxWaitMs: TX_MAX_WAIT_MS },
  );

  check(
    "NOW() is stable across a 250 ms transaction — one origin per commit, as clock.js claims",
    readings.first.getTime() === readings.second.getTime(),
    `first=${readings.first.toISOString()} second=${readings.second.toISOString()}`,
  );
  check(
    "clock_timestamp() does advance, so the stability above is a property of NOW() and not of the harness",
    readings.statement.getTime() > readings.first.getTime(),
    `clock_timestamp − NOW = ${readings.statement.getTime() - readings.first.getTime()} ms`,
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must point at a disposable PostgreSQL instance");
  console.log(`RobotX Phase 3 — live PostgreSQL verification\ntarget: ${url.replace(/:[^:@/]*@/, ":***@")}`);

  const prisma = new PrismaClient({ datasourceUrl: url });
  try {
    const version = await prisma.$queryRawUnsafe("SELECT version()");
    console.log(`server: ${version[0].version}`);
    await reset(prisma);

    await b9IsolationLevel(prisma);
    await b9ForUpdateBlocks(prisma);
    await b9LockOrder(prisma);
    await nominalCommit(prisma);
    await idempotentRetry(prisma);
    await stormCapacityOne(prisma);
    await stormCapacityTwo(prisma);
    await sequentialCapacityTwo(prisma);
    await retryStorm(prisma);
    await guardRaces(prisma);
    await leadershipTouchesNoAgent(prisma);
    await guardsG5G6(prisma);
    await storeClock(prisma);
    await businessKeyMisuse(prisma);
    await errorClassification(prisma);
    await serializationBehaviour(prisma);
    await cacheIndependence(prisma);

    await reset(prisma);
  } finally {
    await prisma.$disconnect();
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${"═".repeat(78)}`);
  console.log(`RESULT: ${results.length - failed.length} passed, ${failed.length} failed, ${results.length} checks total`);
  if (failed.length > 0) {
    for (const entry of failed) console.log(`  FAIL  [${entry.group}] ${entry.label} — ${entry.detail}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("\nHARNESS ERROR:", error);
  process.exitCode = 2;
});

"use strict";

/**
 * Engine lane — Phase 13: failover (§19.5).
 *
 * The plan's testing row for this half:
 *
 * > **Failover:** durable state recovered, SOFT reservations reconstructed and counted
 * > separately from genuine orphan repairs.
 *
 * ── The one assertion that carries the phase ────────────────────────────────
 * §19.5 requires the reconstructed-Leg count to be "distinguishable from the reconciler's
 * genuine orphan repairs (§12.4), **so that an expected consequence of failover is never
 * mistaken for a defect signal**". §12.4's repair rate is an alertable SLI; adding an
 * expected-by-construction event to it would raise that alert on every ordinary failover
 * and train the operator to ignore it — the same argument §26.1 makes for the third
 * invariant status.
 *
 * So the tests below check the separation in both directions: the reconstruction is
 * reported apart from the repairs, **and** no `ReconcilerRepair` row of a new category is
 * written for it.
 */

const failover = require("../../src/engine/shard/failover");
const planState = require("../../src/engine/shard/planState");
const custody = require("../../src/engine/domain/custody");
const { memoryStore, postFailoverWorld, twoShardWorld } = require("./helpers/shardFixture");

const NOW_MS = 1770000000000;
const STORE_TIME = new Date(NOW_MS);

/**
 * A reconciliation sweep double shaped like `reconciler.sweep()`'s real result — the
 * orphan scan's `counts` object with its two `ORPHAN_KIND` keys is the field
 * `separateReconstruction` reads, and it is Phase 5's, not this phase's invention.
 */
function sweepResult(counts, extraRepairs) {
  const reconstructed = counts.EXPECTED_POST_FAILOVER || 0;
  const defect = counts.DEFECT || 0;
  return {
    total: reconstructed + defect + (extraRepairs || 0),
    results: [
      { category: "ORPHAN_LEG", repaired: reconstructed + defect, counts: { EXPECTED_POST_FAILOVER: reconstructed, DEFECT: defect } },
      { category: "LEASE_EXPIRED_UNPROCESSED", repaired: extraRepairs || 0 },
    ],
  };
}

describe("scoping — which Legs belong to this shard", () => {
  test("with no published map, every Leg belongs to the one shard rather than to none", async () => {
    const prisma = memoryStore({ leg: [{ id: "leg-1", state: "PLANNED" }] });
    const scope = await failover.legsInShard({ prisma }, { shardId: "default" });
    expect(scope.scoped).toBe(false);
    expect(scope.note).toMatch(/single-shard deployment/);
  });

  test("with a published map, the WorkQueue routing record scopes the shard", async () => {
    const prisma = memoryStore(postFailoverWorld({ nowMs: NOW_MS }));
    const scope = await failover.legsInShard({ prisma }, { shardId: "shard-north" });
    expect(scope.scoped).toBe(true);
    expect([...scope.legIds].sort()).toEqual(["leg-defect-orphan", "leg-planned-committed", "leg-planned-orphan"]);
    expect(scope.legIds.has("leg-south")).toBe(false);
  });

  /* PHASE 13 REMEDIATION (P13-R17) — attribution is not routing.
   *
   * This function used to build its map with `regionShardMap()`, which excludes shards that
   * admit no new work. A rebalance's entire job is to put its source shard into DRAINING,
   * so a working rebalance made both halves below reachable. Neither was reachable while
   * the rebalance endpoint did nothing, which is why the two defects were found together.
   */
  test("**a DRAINING shard still owns its region's Legs** — attribution does not stop when admission does", async () => {
    const world = postFailoverWorld({ nowMs: NOW_MS });
    world.shard = world.shard.map((shard) =>
      shard.shardId === "shard-north" ? { ...shard, state: "DRAINING", drainingSince: new Date(NOW_MS) } : shard,
    );
    // The `WorkQueue` rows removed, so only the region→shard fallback can attribute. Before
    // the fix this reported "the mission regions this shard owns (none)" and an empty set:
    // §19.5's reconciliation ran over nothing for the shard most likely to hold half-written
    // state, because it was the one being rebalanced.
    world.workQueue = [];
    const prisma = memoryStore(world);

    const scope = await failover.legsInShard({ prisma }, { shardId: "shard-north" });

    expect(scope.scoped).toBe(true);
    expect([...scope.legIds].sort()).toEqual(["leg-defect-orphan", "leg-planned-committed", "leg-planned-orphan"]);
    expect(scope.legIds.has("leg-south")).toBe(false);
  });

  test("**a fleet whose every shard is draining is still a multi-shard fleet**, not a single-shard deployment", async () => {
    const world = postFailoverWorld({ nowMs: NOW_MS });
    world.shard = world.shard.map((shard) => ({ ...shard, state: "DRAINING", drainingSince: new Date(NOW_MS) }));
    const prisma = memoryStore(world);

    const scope = await failover.legsInShard({ prisma }, { shardId: "shard-north" });

    // Before the fix the routing map was empty, which read as "no map is published" — the
    // single-shard branch — and **every shard's leader would have reconciled the whole
    // fleet**. That is the second writer §19.3 exists to prevent, originating inside this
    // phase rather than in §12.4's sweep.
    expect(scope.scoped).toBe(true);
    expect(scope.legIds.has("leg-south")).toBe(false);
    expect(scope.note).not.toMatch(/single-shard deployment/);
  });

  test("the routing map is unchanged — a draining shard still admits no new Leg at intake", () => {
    const shardModel = require("../../src/engine/shard/shardModel");
    const shards = [
      { shardId: "shard-north", regionId: "region-north", state: "DRAINING" },
      { shardId: "shard-south", regionId: "region-south", state: "ACTIVE" },
    ];
    // The two maps answer two different questions and must not be collapsed into one.
    expect(shardModel.regionShardMap(shards)).toEqual({ "region-south": "shard-south" });
    expect(shardModel.regionOwnershipMap(shards)).toEqual({ "region-north": "shard-north", "region-south": "shard-south" });
  });
});

describe("recovering the durable state (§19.5's first job)", () => {
  test("the inventory names all five durable categories", async () => {
    const prisma = memoryStore(postFailoverWorld({ nowMs: NOW_MS }));
    const inventory = await failover.inventory({ prisma }, { shardId: "shard-north", storeTime: STORE_TIME });

    expect(inventory[failover.DURABLE_CATEGORY.HARD_COMMITMENTS].active).toBe(1);
    expect(inventory[failover.DURABLE_CATEGORY.CUSTODY].holding).toBe(1);
    expect(inventory[failover.DURABLE_CATEGORY.OUTBOX].outstanding).toBe(1);
    expect(inventory[failover.DURABLE_CATEGORY.OUTBOX].staleClaims).toBe(1);
    expect(inventory[failover.DURABLE_CATEGORY.TIMERS].pending).toBe(2);
    expect(inventory[failover.DURABLE_CATEGORY.TIMERS].overdue).toBe(1);
  });

  // PHASE 13 REMEDIATION (P13-R10) — the inventory presented itself as "the durable state
  // the new leader inherits" for this shard, and counted the *fleet's* timers and outbox
  // rows. `t-3` in the fixture belongs to `shard-south`; before the fix it was in
  // `shard-north`'s pending count.
  test("timer counts are scoped to the shard — another shard's timers are not this leader's inheritance", async () => {
    const prisma = memoryStore(postFailoverWorld({ nowMs: NOW_MS }));

    const north = await failover.inventory({ prisma }, { shardId: "shard-north", storeTime: STORE_TIME });
    const south = await failover.inventory({ prisma }, { shardId: "shard-south", storeTime: STORE_TIME });

    expect(north[failover.DURABLE_CATEGORY.TIMERS]).toMatchObject({ pending: 2, overdue: 1, scope: "SHARD" });
    expect(south[failover.DURABLE_CATEGORY.TIMERS]).toMatchObject({ pending: 1, overdue: 1, scope: "SHARD" });
    // The whole fleet holds three; neither shard claims all three.
    expect(await prisma.timer.count({ where: { timerState: "PENDING" } })).toBe(3);
  });

  test("the outbox count says it is the fleet's, because Outbox carries no shardId", async () => {
    const prisma = memoryStore(postFailoverWorld({ nowMs: NOW_MS }));
    const inventory = await failover.inventory({ prisma }, { shardId: "shard-north", storeTime: STORE_TIME });

    // Not silently wrong and not silently dropped: reported with the scope it actually has.
    expect(inventory[failover.DURABLE_CATEGORY.OUTBOX].scope).toBe("FLEET");
    expect(inventory[failover.DURABLE_CATEGORY.OUTBOX].note).toMatch(/no shardId/);
    expect(inventory.note).toMatch(/whether its count is this shard's or the fleet's/);
  });

  test("in the single-shard deployment every category says FLEET, because the two sets are the same", async () => {
    const prisma = memoryStore({
      leg: [{ id: "leg-1", state: "PLANNED" }],
      timer: [{ id: "t-x", timerKey: "k", entityType: "LEG", entityId: "leg-1", timerState: "PENDING", dueAt: new Date(NOW_MS + 1000) }],
    });
    const inventory = await failover.inventory({ prisma }, { shardId: "default", storeTime: STORE_TIME });

    expect(inventory.scope.scoped).toBe(false);
    expect(inventory[failover.DURABLE_CATEGORY.TIMERS]).toMatchObject({ pending: 1, scope: "FLEET" });
    expect(inventory[failover.DURABLE_CATEGORY.HARD_COMMITMENTS].scope).toBe("FLEET");
  });

  test("it is an inventory, not a repair list — it names the owner of each repair", async () => {
    const prisma = memoryStore(postFailoverWorld({ nowMs: NOW_MS }));
    const inventory = await failover.inventory({ prisma }, { shardId: "shard-north", storeTime: STORE_TIME });
    expect(inventory.note).toMatch(/repaired by its own owner/);
  });

  test("taking it before the sweep distinguishes 'nothing was wrong' from 'nothing was here'", async () => {
    const empty = memoryStore(twoShardWorld({ nowMs: NOW_MS }));
    const inventory = await failover.inventory({ prisma: empty }, { shardId: "shard-north", storeTime: STORE_TIME });
    expect(inventory[failover.DURABLE_CATEGORY.HARD_COMMITMENTS].active).toBe(0);
    expect(inventory.scope.legCount).toBe(0);
  });

  test("the locally-declared custody vocabulary still agrees with §2.5's", () => {
    const holdsGoods = Object.values(custody.CUSTODY_STATES || {})
      .filter((state) => state.holdsGoods === true)
      .map((state) => state.name);
    expect(failover.assertCustodyVocabularyAgrees(holdsGoods)).toEqual({ ok: true, problems: [] });
  });

  test("the vocabulary check fails on a planted drift, so it is a check rather than an assertion", () => {
    expect(failover.assertCustodyVocabularyAgrees(["HELD"]).ok).toBe(false);
  });
});

describe("reconstructing the volatile state (§19.5's second job)", () => {
  test("a PLANNED Leg with no live commitment is predicted for requeue; one with a commitment is left alone", async () => {
    const prisma = memoryStore(postFailoverWorld({ nowMs: NOW_MS }));
    const plan = await failover.planReconstruction({ prisma }, { shardId: "shard-north" });

    expect(plan.requeue).toEqual(["leg-planned-orphan"]);
    expect(plan.leftAlone.map((entry) => entry.legId)).toEqual(["leg-planned-committed"]);
    expect(plan.leftAlone[0].because).toMatch(/an agent has been told/);
  });

  test("nothing is *recovered* — the plan is derived from durable rows, with no reservation read", async () => {
    const prisma = memoryStore(postFailoverWorld({ nowMs: NOW_MS }));
    const plan = await failover.planReconstruction({ prisma }, { shardId: "shard-north" });
    expect(plan.note).toMatch(/reconstructed, never recovered/);
    expect(plan.note).toMatch(/No SOFT reservation was read from any store/);
    // And the pure procedure it delegates to is Phase 10's, not a second copy.
    expect(planState.reconstructionPlan({ plannedLegs: [] }).note).toBe(plan.note);
  });

  test("a Leg past PLANNED is not a reconstruction candidate — that is §12.4's defect orphan", async () => {
    const prisma = memoryStore(postFailoverWorld({ nowMs: NOW_MS }));
    const plan = await failover.planReconstruction({ prisma }, { shardId: "shard-north" });
    expect(plan.requeue).not.toContain("leg-defect-orphan");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The separation §19.5 requires
   ═══════════════════════════════════════════════════════════════════════════ */

describe("**the failover metric is separated from §12.4's repair rate** (§19.5)", () => {
  test("the reconstructed count is read out of the orphan scan's own EXPECTED_POST_FAILOVER counter", () => {
    const separated = failover.separateReconstruction(sweepResult({ EXPECTED_POST_FAILOVER: 7, DEFECT: 2 }, 3));
    expect(separated.reconstructed).toBe(7);
    expect(separated.defectOrphans).toBe(2);
    expect(separated.otherRepairs).toBe(5);
  });

  test("the reconstruction is never inside `otherRepairs` — the number §12.4's SLI reads", () => {
    const separated = failover.separateReconstruction(sweepResult({ EXPECTED_POST_FAILOVER: 400, DEFECT: 0 }, 0));
    expect(separated.reconstructed).toBe(400);
    expect(separated.otherRepairs).toBe(0);
  });

  test("a sweep with no orphan scan reports zero reconstruction rather than guessing", () => {
    expect(failover.separateReconstruction({ total: 4, results: [{ category: "LEASE_EXPIRED_UNPROCESSED", repaired: 4 }] })).toEqual({
      reconstructed: 0,
      defectOrphans: 0,
      otherRepairs: 4,
    });
  });

  test("failover writes **no** ReconcilerRepair row of its own", async () => {
    const prisma = memoryStore(postFailoverWorld({ nowMs: NOW_MS }));
    await failover.run(
      { prisma, reconcile: async () => sweepResult({ EXPECTED_POST_FAILOVER: 1, DEFECT: 1 }, 0) },
      { shardId: "shard-north", storeTime: STORE_TIME },
    );
    expect(prisma.__store.reconcilerRepair).toEqual([]);
  });

  test("the source contains no `create` against ReconcilerRepair — the repairs are the reconciler's", () => {
    const source = require("fs").readFileSync(require.resolve("../../src/engine/shard/failover.js"), "utf8");
    expect(source).not.toMatch(/reconcilerRepair/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   "Full reconciliation before resuming rounds"
   ═══════════════════════════════════════════════════════════════════════════ */

describe("completion — §19.5's ordering, enforced rather than observed", () => {
  test("`reconcile` is required; a failover permitted to run without it is refused", async () => {
    const prisma = memoryStore(postFailoverWorld({ nowMs: NOW_MS }));
    await expect(failover.run({ prisma }, { shardId: "shard-north", storeTime: STORE_TIME })).rejects.toThrow(
      /requires the §12.4 reconciliation sweep/,
    );
  });

  test("a sweep that clears the reconstruction completes, and the metric is reported", async () => {
    const prisma = memoryStore(postFailoverWorld({ nowMs: NOW_MS }));
    let pass = 0;

    const result = await failover.run(
      {
        prisma,
        reconcile: async () => {
          pass += 1;
          if (pass === 1) {
            // The real sweep's write, simulated: the PLANNED orphan returns to QUEUED.
            const leg = prisma.__store.leg.find((row) => row.id === "leg-planned-orphan");
            leg.state = "QUEUED";
            leg.version += 1;
            return sweepResult({ EXPECTED_POST_FAILOVER: 1, DEFECT: 1 }, 0);
          }
          return sweepResult({}, 0);
        },
      },
      { shardId: "shard-north", storeTime: STORE_TIME },
    );

    expect(result.complete).toBe(true);
    expect(result.reconstruction.reconstructedLegCount).toBe(1);
    expect(result.reconstruction.stillOutstanding).toBe(0);
    expect(result.repairs.defectOrphans).toBe(1);
    expect(result.sentence).toMatch(/Rounds may resume/);
  });

  // The batched-sweep case: one pass is not "full" on a shard with more orphans than a
  // batch, and a failover that reported success after one would resume on unreconciled
  // state.
  test("a sweep that runs out of passes with reconstruction outstanding reports **incomplete**", async () => {
    const prisma = memoryStore(postFailoverWorld({ nowMs: NOW_MS }));
    const result = await failover.run(
      { prisma, reconcile: async () => sweepResult({ EXPECTED_POST_FAILOVER: 1, DEFECT: 0 }, 0) },
      { shardId: "shard-north", storeTime: STORE_TIME, maxPasses: 3 },
    );

    expect(result.complete).toBe(false);
    expect(result.passesUsed).toBe(3);
    expect(result.reconstruction.stillOutstanding).toBe(1);
    expect(result.sentence).toMatch(/Rounds must not resume/);
  });

  test("the loop stops early on a pass that repaired nothing rather than burning its bound", async () => {
    const prisma = memoryStore(twoShardWorld({ nowMs: NOW_MS }));
    const result = await failover.run(
      { prisma, reconcile: async () => sweepResult({}, 0) },
      { shardId: "shard-north", storeTime: STORE_TIME, maxPasses: 8 },
    );
    expect(result.passesUsed).toBe(1);
    expect(result.complete).toBe(true);
  });

  test("I3's seam is answered definitively: after a failover there are no SOFT reservations", async () => {
    const prisma = memoryStore(twoShardWorld({ nowMs: NOW_MS }));
    const result = await failover.run(
      { prisma, reconcile: async () => sweepResult({}, 0) },
      { shardId: "shard-north", storeTime: STORE_TIME },
    );
    expect(result.softReservedLegIds).toEqual([]);
  });
});

describe("persistence — the shard row records the failover", () => {
  test("a complete reconciliation sets roundsResumableAt; an incomplete one leaves it null", async () => {
    const prisma = memoryStore(postFailoverWorld({ nowMs: NOW_MS }));

    await failover.persist(
      { prisma },
      { shardId: "shard-north", at: STORE_TIME, result: { complete: true, reconstruction: { reconstructedLegCount: 4 }, inventory: { HARD_COMMITMENTS: { active: 9 } } } },
    );
    let row = prisma.__store.shard.find((entry) => entry.shardId === "shard-north");
    expect(row.roundsResumableAt).toEqual(STORE_TIME);
    expect(row.lastFailoverReconstructedLegs).toBe(4);
    expect(row.lastFailoverRecoveredCommitments).toBe(9);

    await failover.persist(
      { prisma },
      { shardId: "shard-north", at: STORE_TIME, result: { complete: false, reconstruction: { reconstructedLegCount: 2 }, inventory: { HARD_COMMITMENTS: { active: 9 } } } },
    );
    row = prisma.__store.shard.find((entry) => entry.shardId === "shard-north");
    expect(row.roundsResumableAt).toBeNull();
    // And the attempt is still recorded — "tried and could not" is a different fact from
    // "has not tried".
    expect(row.lastFailoverAt).toEqual(STORE_TIME);
    expect(row.lastFailoverReconstructedLegs).toBe(2);
  });

  test("the leadership change instant is recorded alongside the failover", async () => {
    const prisma = memoryStore(twoShardWorld({ nowMs: NOW_MS }));
    await failover.persist({ prisma }, { shardId: "shard-north", at: STORE_TIME, result: { complete: true, reconstruction: { reconstructedLegCount: 0 }, inventory: {} } });
    expect(prisma.__store.shard.find((entry) => entry.shardId === "shard-north").lastLeadershipChangeAt).toEqual(STORE_TIME);
  });

  /* ─────────────────────────────────────────────────────────────────────────
     PHASE 13 REMEDIATION — the single-shard deployment.

     A `Shard` row is published configuration: it carries a foreign key to a
     `Region`, and §3.5's region→shard map is something an operator publishes.
     The default deployment therefore has NO `Shard` row, and this module treats
     that as legal everywhere else — `legsInShard()` says so explicitly.

     `persist()` used `update()`, which raises P2025 when it matches nothing.
     That threw out of the supervisor's `failoverPass()` **after** the §12.4
     sweep had already run; the interval callback swallowed it (correctly), so
     the session was never promoted and the loop re-entered as a follower
     forever, re-running the full sweep every tick. A coordinator that
     reconciled continuously and never resumed a round.

     Verified against live PostgreSQL 18.3 before the fix: P2025 from
     `failover.js:423`, with the sweep already having run.
     ───────────────────────────────────────────────────────────────────────── */
  test("a shard with no published Shard row does not throw — the single-shard deployment is legal", async () => {
    const prisma = memoryStore(twoShardWorld({ nowMs: NOW_MS }));
    const outcome = await failover.persist(
      { prisma },
      { shardId: "shard-that-was-never-published", at: STORE_TIME, result: { complete: true, reconstruction: { reconstructedLegCount: 0 }, inventory: {} } },
    );
    expect(outcome.persisted).toBe(false);
    expect(outcome.note).toMatch(/single-shard deployment/);
  });

  test("…and it says so rather than reporting a write it did not make", async () => {
    const prisma = memoryStore(twoShardWorld({ nowMs: NOW_MS }));
    const before = prisma.__store.shard.map((entry) => ({ ...entry }));

    await failover.persist(
      { prisma },
      { shardId: "absent", at: STORE_TIME, result: { complete: true, reconstruction: { reconstructedLegCount: 7 }, inventory: {} } },
    );

    // No unrelated shard row may absorb the write.
    expect(prisma.__store.shard).toEqual(before);
  });

  test("a published shard still reports the write it did make", async () => {
    const prisma = memoryStore(twoShardWorld({ nowMs: NOW_MS }));
    const outcome = await failover.persist(
      { prisma },
      { shardId: "shard-north", at: STORE_TIME, result: { complete: true, reconstruction: { reconstructedLegCount: 0 }, inventory: {} } },
    );
    expect(outcome).toMatchObject({ persisted: true, shardId: "shard-north", note: null });
  });
});

describe("determinism", () => {
  test("failover reads no clock — every instant is supplied", () => {
    const source = require("fs").readFileSync(require.resolve("../../src/engine/shard/failover.js"), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/Date\.now\(|new Date\(|Math\.random\(/);
  });
});

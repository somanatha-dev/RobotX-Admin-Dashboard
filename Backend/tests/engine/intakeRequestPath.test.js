"use strict";

/**
 * §3.4's request path and §20.5's admission control — the half of Phase 10 that runs
 * synchronously, in milliseconds, and whose whole job is to be honest.
 */

const intake = require("../../src/engine/intake/intake");
const admission = require("../../src/engine/intake/admission");
const purpose = require("../../src/engine/domain/purpose");
const leadership = require("../../src/engine/shard/leadership");
const fixture = require("./helpers/roundFixture");

const RECEIVED_AT_MS = 1_800_000_000_000;

function request(overrides) {
  return {
    legId: "leg-1",
    taskId: "TSK-1",
    purpose: purpose.PURPOSES.PRIMARY.name,
    slaClass: "standard",
    receivedAtMs: RECEIVED_AT_MS,
    cadence: { windowMs: 500, maxLegsPerRound: 500, feasibleSupply: 4 },
    ...(overrides || {}),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   §20.5 — admission control and backpressure
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§20.5 — custodial purposes are never shed, at any level", () => {
  test.each(purpose.CUSTODIAL_PURPOSES)("%s survives the most severe shed rung", (custodial) => {
    for (let level = 0; level <= admission.MAX_SHED_LEVEL; level += 1) {
      const verdict = admission.shedDecision({ purpose: custodial, slaClass: "bulk", shedLevel: level });
      expect({ level, ok: verdict.ok }).toEqual({ level, ok: true });
      expect(verdict.observed.neverShed).toBe(true);
    }
  });

  test("a custodial Leg is not declined for projected queue delay either", () => {
    const verdict = admission.assess({
      purpose: "RECOVERY",
      slaClass: "bulk",
      shedLevel: admission.MAX_SHED_LEVEL,
      projectedQueueDelaySeconds: 100_000,
      slaBudgetSeconds: 1,
    });
    expect(verdict.admitted).toBe(true);
  });

  test("the ladder never lists a custodial purpose — the refusal is not merely ordering", () => {
    for (const rung of admission.shedLadder()) {
      for (const custodial of purpose.CUSTODIAL_PURPOSES) {
        expect(rung.shedsPurposes).not.toContain(custodial);
      }
    }
  });

  test("MAINTENANCE_TRANSIT is never shed either (§17.4) — no customer is not the same as speculative", () => {
    for (let level = 0; level <= admission.MAX_SHED_LEVEL; level += 1) {
      expect(admission.shedDecision({ purpose: "MAINTENANCE_TRANSIT", shedLevel: level }).ok).toBe(true);
    }
  });
});

describe("§20.5 — shedding is keyed on purpose first, SLA class second", () => {
  test("speculative work sheds at level 1, before any customer class", () => {
    const speculative = admission.shedDecision({ purpose: "REPOSITION", slaClass: "critical", shedLevel: 1 });
    const standard = admission.shedDecision({ purpose: "PRIMARY", slaClass: "bulk", shedLevel: 1 });

    expect(speculative.ok).toBe(false);
    expect(speculative.reason).toBe(admission.REASON.SHED_BY_PURPOSE);
    expect(standard.ok).toBe(true);
  });

  test("low-priority customer classes shed at level 2, higher ones do not", () => {
    expect(admission.shedDecision({ purpose: "PRIMARY", slaClass: "bulk", shedLevel: 2 }).ok).toBe(false);
    expect(admission.shedDecision({ purpose: "PRIMARY", slaClass: "critical", shedLevel: 2 }).ok).toBe(true);
  });

  test("the ladder is a prefix relation — each rung sheds everything below it", () => {
    const ladder = admission.shedLadder();
    for (let index = 1; index < ladder.length; index += 1) {
      for (const shed of ladder[index - 1].shedsPurposes) expect(ladder[index].shedsPurposes).toContain(shed);
      for (const shed of ladder[index - 1].shedsSlaClasses) expect(ladder[index].shedsSlaClasses).toContain(shed);
    }
  });

  test("an unknown purpose is declined, not admitted by default", () => {
    const verdict = admission.assess({ purpose: "SOMETHING_NEW" });
    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toBe(admission.REASON.UNKNOWN_PURPOSE);
  });
});

describe("§20.5 — declines are explicit, never silent", () => {
  test("a tenant over its rate quota is declined with a sentence it can act on", () => {
    const verdict = admission.assess({
      purpose: "PRIMARY",
      tenantId: "t1",
      observedRatePerMinute: 100,
      rateQuotaPerMinute: 100,
    });
    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toBe(admission.REASON.TENANT_RATE_QUOTA);
    expect(verdict.sentence).toMatch(/Retry after the current minute/);
  });

  test("projected queue delay beyond the class budget declines AT INTAKE rather than starving silently", () => {
    const verdict = admission.assess({
      purpose: "PRIMARY",
      slaClass: "express",
      projectedQueueDelaySeconds: 1200,
      slaBudgetSeconds: 900,
    });
    expect(verdict.admitted).toBe(false);
    expect(verdict.sentence).toMatch(/promising a deadline the shard cannot currently meet/);
  });

  test("an absent SLA budget does not decline — a missing parameter is not an outage", () => {
    const verdict = admission.assess({ purpose: "PRIMARY", projectedQueueDelaySeconds: 999_999 });
    expect(verdict.admitted).toBe(true);
  });

  test("a shed verdict and a capacity decline are distinguished, not merged", () => {
    const shed = admission.assess({ purpose: "REPOSITION", shedLevel: 1 });
    const declined = admission.assess({
      purpose: "PRIMARY",
      projectedQueueDelaySeconds: 100,
      slaBudgetSeconds: 10,
    });
    expect(shed.verdict).toBe(admission.VERDICT.SHED);
    expect(declined.verdict).toBe(admission.VERDICT.DECLINE);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   §3.4 — the request path
   ═══════════════════════════════════════════════════════════════════════════ */

describe("§3.4 — the response contract MUST NOT imply an assignment has occurred", () => {
  test("accepted and assigned are separate fields, and assigned is false", async () => {
    const prisma = fixture.memoryPrisma();
    const response = await intake.admit({ prisma }, request());

    expect(response.outcome).toBe(intake.OUTCOME.ACCEPTED);
    expect(response.accepted).toBe(true);
    expect(response.assigned).toBe(false);
    expect(response.sentence).toMatch(/assignment is in progress/);
  });

  test("the response carries all four §3.4 fields", async () => {
    const prisma = fixture.memoryPrisma();
    const response = await intake.admit({ prisma }, request());

    expect(response.taskId).toBe("TSK-1");
    expect(typeof response.idempotencyKey).toBe("string");
    expect(response.queuePosition).toBe(1);
    expect(response.predictedAssignmentWindow.basis).toBe(intake.WINDOW_BASIS.QUEUE_AND_CADENCE);
  });

  test("the durable queue row is the request path's last act", async () => {
    const prisma = fixture.memoryPrisma();
    await intake.admit({ prisma }, request());

    expect(prisma.__tables.workQueue).toHaveLength(1);
    expect(prisma.__tables.workQueue[0]).toMatchObject({ legId: "leg-1", state: "QUEUED" });
  });

  test("queue position reflects the priority order the round claims in, not arrival", async () => {
    const prisma = fixture.memoryPrisma();
    await intake.admit({ prisma }, request({ legId: "leg-bulk", slaClass: "bulk", externalRef: "a" }));
    const urgent = await intake.admit(
      { prisma },
      request({ legId: "leg-critical", slaClass: "critical", externalRef: "b" }),
    );

    expect(urgent.queuePosition).toBe(1);
  });
});

describe("§3.4 — the honest predicted assignment window", () => {
  test("no feasible supply ⇒ NO WINDOW is quoted, with the reason stated", async () => {
    const prisma = fixture.memoryPrisma();
    const response = await intake.admit(
      { prisma },
      request({ cadence: { windowMs: 500, maxLegsPerRound: 500, feasibleSupply: 0 } }),
    );

    expect(response.accepted).toBe(true);
    expect(response.predictedAssignmentWindow.basis).toBe(intake.WINDOW_BASIS.NO_FEASIBLE_SUPPLY);
    expect(response.predictedAssignmentWindow.expectedMs).toBeNull();
    expect(response.predictedAssignmentWindow.sentence).toMatch(/no agent is currently available/);
  });

  test("missing cadence inputs ⇒ no window, rather than a default that looks measured", () => {
    const window = intake.predictAssignmentWindow({ receivedAtMs: RECEIVED_AT_MS, queuePosition: 1 });
    expect(window.basis).toBe(intake.WINDOW_BASIS.INSUFFICIENT_INFORMATION);
    expect(window.earliestMs).toBeNull();
  });

  test("the earliest edge is never the present — the batch window must elapse first", () => {
    const window = intake.predictAssignmentWindow({
      receivedAtMs: RECEIVED_AT_MS,
      queuePosition: 1,
      windowMs: 500,
      maxLegsPerRound: 500,
      feasibleSupply: 3,
    });
    expect(window.earliestMs).toBe(RECEIVED_AT_MS + 500);
    expect(window.roundsAhead).toBe(1);
    expect(window.latestMs).toBeGreaterThan(window.expectedMs);
  });

  test("a deep queue pushes the expectation out by whole rounds", () => {
    const window = intake.predictAssignmentWindow({
      receivedAtMs: RECEIVED_AT_MS,
      queuePosition: 25,
      windowMs: 1000,
      maxLegsPerRound: 10,
      feasibleSupply: 3,
    });
    expect(window.roundsAhead).toBe(3);
    expect(window.expectedMs).toBe(RECEIVED_AT_MS + 3000);
  });

  test("an at-risk projection says so at the moment the caller can still act", () => {
    const window = intake.predictAssignmentWindow({
      receivedAtMs: RECEIVED_AT_MS,
      queuePosition: 100,
      windowMs: 3000,
      maxLegsPerRound: 1,
      feasibleSupply: 3,
      slaBudgetSeconds: 60,
    });
    expect(window.atRisk).toBe(true);
    expect(window.sentence).toMatch(/anti-starvation ladder/);
  });
});

describe("§10.5 at the boundary — idempotence", () => {
  test("a retried submission is answered with the ORIGINAL acceptance, not admitted twice", async () => {
    const prisma = fixture.memoryPrisma();
    const first = await intake.admit({ prisma }, request({ idempotencyKey: "client-key-1" }));
    const second = await intake.admit({ prisma }, request({ idempotencyKey: "client-key-1" }));

    expect(first.outcome).toBe(intake.OUTCOME.ACCEPTED);
    expect(second.outcome).toBe(intake.OUTCOME.DUPLICATE);
    expect(prisma.__tables.workQueue).toHaveLength(1);
    expect(second.sentence).toMatch(/already accepted under the same idempotency key/);
  });

  test("a duplicate is quoted the original window, not re-quoted against a moved queue", async () => {
    const prisma = fixture.memoryPrisma();
    const first = await intake.admit({ prisma }, request({ idempotencyKey: "k" }));
    // Another Leg arrives and lengthens the queue.
    await intake.admit({ prisma }, request({ legId: "leg-2", idempotencyKey: "k2" }));
    const repeat = await intake.admit({ prisma }, request({ idempotencyKey: "k" }));

    expect(repeat.predictedAssignmentWindow).toEqual(first.predictedAssignmentWindow);
  });

  test("a caller-supplied key is echoed and namespaced; a derived one is marked as derived", () => {
    expect(intake.idempotencyKeyFor({ idempotencyKey: "abc" })).toEqual({ key: "client:abc", echoed: true });
    const derived = intake.idempotencyKeyFor({ tenantId: "t", legId: "l", externalRef: "r" });
    expect(derived.echoed).toBe(false);
    expect(derived.key.startsWith("derived:")).toBe(true);
  });

  test("the derived key is a pure function of the work's identity", () => {
    const a = intake.idempotencyKeyFor({ tenantId: "t", legId: "l", externalRef: "r" });
    const b = intake.idempotencyKeyFor({ tenantId: "t", legId: "l", externalRef: "r" });
    const other = intake.idempotencyKeyFor({ tenantId: "t", legId: "l2", externalRef: "r" });
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(other.key);
  });
});

describe("§3.5 — the shard is resolved from the first Stop's region", () => {
  test("a published region→shard map is honoured, and the basis is recorded", () => {
    const resolved = intake.resolveShard({ regionId: "R1", shardByRegionId: { R1: "shard-a" } });
    expect(resolved).toMatchObject({ ok: true, shardId: "shard-a", regionId: "R1", resolvedBy: "REGION_MAP" });
  });

  test("the first Stop's region is read where the caller supplies the Stop rather than the region", () => {
    const resolved = intake.resolveShard({ firstStop: { regionId: "R2" }, shardByRegionId: { R2: "shard-b" } });
    expect(resolved.shardId).toBe("shard-b");
  });

  test("with NO map published, the single-shard identity every prior phase uses is reused", () => {
    const resolved = intake.resolveShard({ regionId: "R1" });
    expect(resolved).toMatchObject({ shardId: leadership.DEFAULT_SHARD_ID, resolvedBy: "SINGLE_SHARD_DEPLOYMENT" });
  });

  test("with a map published, a Leg with NO region is REFUSED rather than defaulted", () => {
    const refused = intake.resolveShard({ shardByRegionId: { R1: "shard-a" } });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/age on the §17.4 ladder against a shard that was never able to help/);
  });

  test("with a map published, an unmapped region is REFUSED rather than guessed", () => {
    const refused = intake.resolveShard({ regionId: "R9", shardByRegionId: { R1: "shard-a" } });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/a queue no coordinator drains/);
  });

  test("an unresolvable shard declines the submission and writes nothing durable", async () => {
    const prisma = fixture.memoryPrisma();
    const response = await intake.admit(
      { prisma },
      request({ shardResolution: { regionId: "R9", shardByRegionId: { R1: "shard-a" } } }),
    );

    expect(response.accepted).toBe(false);
    expect(response.reason).toBe("SHARD_UNRESOLVED");
    expect(prisma.__tables.workQueue).toHaveLength(0);
  });
});

describe("intake validation and priority", () => {
  test("a submission with no purpose is INVALID, and nothing durable is written", async () => {
    const prisma = fixture.memoryPrisma();
    const response = await intake.admit({ prisma }, request({ purpose: undefined }));

    expect(response.outcome).toBe(intake.OUTCOME.INVALID);
    expect(prisma.__tables.workQueue).toHaveLength(0);
  });

  test("a declined submission writes nothing durable either", async () => {
    const prisma = fixture.memoryPrisma();
    const response = await intake.admit(
      { prisma },
      request({ purpose: "REPOSITION", admissionInputs: { shedLevel: 1 } }),
    );

    expect(response.outcome).toBe(intake.OUTCOME.DECLINED);
    expect(prisma.__tables.workQueue).toHaveLength(0);
  });

  test("priority orders custodial ahead of primary ahead of speculative", () => {
    const recovery = intake.priorityFor({ purpose: "RECOVERY", slaClass: "bulk" });
    const primary = intake.priorityFor({ purpose: "PRIMARY", slaClass: "critical" });
    const reposition = intake.priorityFor({ purpose: "REPOSITION", slaClass: "critical" });

    expect(recovery).toBeLessThan(primary);
    expect(primary).toBeLessThan(reposition);
  });

  test("within one purpose, the SLA class orders", () => {
    expect(intake.priorityFor({ purpose: "PRIMARY", slaClass: "critical" })).toBeLessThan(
      intake.priorityFor({ purpose: "PRIMARY", slaClass: "bulk" }),
    );
  });

  test("an unrecognised SLA class ranks after every known one", () => {
    expect(intake.priorityFor({ purpose: "PRIMARY", slaClass: "made-up" })).toBeGreaterThan(
      intake.priorityFor({ purpose: "PRIMARY", slaClass: "bulk" }),
    );
  });
});

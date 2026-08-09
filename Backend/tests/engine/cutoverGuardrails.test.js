"use strict";

/**
 * Engine lane — pre-declared SLI guardrails, the automatic rollback, and the one-directional
 * rule (§22.3, §22.4 item 4).
 *
 * The module's whole value is in three refusals: a declaration that is not pre-declared, a
 * window with too few samples to conclude anything, and an automatic action that is not a
 * rollback. Each is tested here as a refusal rather than as a happy path, because the happy
 * path is a comparison anyone could write.
 */

const guardrails = require("../../src/engine/cutover/guardrails");
const stage = require("../../src/engine/cutover/stage");
const store = require("../../src/engine/cutover/store");
const worker = require("../../src/workers/cutover.worker");
const sli = require("../../src/engine/observability/sli");

const NOW = 1_800_000_000_000;
const HOUR_MS = 3_600_000;

function declaration(overrides) {
  return guardrails.declare({
    shardId: "shard-1",
    declaredBy: "operator-a",
    declaredAtMs: NOW,
    observationWindowSeconds: 3600,
    guardrails: [
      { id: "commit_transaction_p999", direction: guardrails.DIRECTION.AT_MOST, threshold: 100, minSamples: 1000, unit: "ms" },
      { id: "round_wall_clock", direction: guardrails.DIRECTION.AT_MOST, threshold: 250, minSamples: 100, unit: "ms" },
    ],
    ...(overrides || {}),
  });
}

function window(observations, overrides) {
  return {
    windowStartedAtMs: NOW,
    windowEndedAtMs: NOW + HOUR_MS,
    observations,
    ...(overrides || {}),
  };
}

describe("a declaration is validated, stamped and ordered", () => {
  test("it refuses an unowned, unstamped, unwindowed or empty declaration", () => {
    expect(() => guardrails.declare({ shardId: "s" })).toThrow(/who declared it/);
    expect(() => guardrails.declare({ shardId: "s", declaredBy: "a" })).toThrow(/instant it was declared/);
    expect(() => guardrails.declare({ shardId: "s", declaredBy: "a", declaredAtMs: NOW })).toThrow(/observation window/);
    expect(() =>
      guardrails.declare({ shardId: "s", declaredBy: "a", declaredAtMs: NOW, observationWindowSeconds: 60, guardrails: [] }),
    ).toThrow(/no guardrails is a stage with no guardrails/);
  });

  test("every guardrail must declare a sample size", () => {
    // A p99.9 concluded from forty observations has not been concluded; it has been guessed
    // at, and a rollback triggered by that guess is an outage caused by the safety
    // mechanism rather than by a regression.
    expect(() =>
      guardrails.declare({
        shardId: "s",
        declaredBy: "a",
        declaredAtMs: NOW,
        observationWindowSeconds: 60,
        guardrails: [{ id: "x", direction: guardrails.DIRECTION.AT_MOST, threshold: 1 }],
      }),
    ).toThrow(/minSamples/);
  });

  test("guardrails are ordered deterministically, so two declarations of the same set are the same object", () => {
    const forward = guardrails.declare({
      shardId: "s", declaredBy: "a", declaredAtMs: NOW, observationWindowSeconds: 60,
      guardrails: [
        { id: "b", direction: guardrails.DIRECTION.AT_MOST, threshold: 1, minSamples: 1 },
        { id: "a", direction: guardrails.DIRECTION.AT_MOST, threshold: 1, minSamples: 1 },
      ],
    });
    expect(forward.guardrails.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("assessment: the three verdicts, and why HOLD is not a soft pass", () => {
  test("PROCEED requires every guardrail held, enough samples, and an elapsed window", () => {
    const outcome = guardrails.assess(
      declaration(),
      window({
        commit_transaction_p999: { value: 60, samples: 5000 },
        round_wall_clock: { value: 180, samples: 900 },
      }),
    );
    expect(outcome.verdict).toBe(guardrails.VERDICT.PROCEED);
    expect(outcome.breached).toEqual([]);
  });

  test("too few samples HOLDs — it never proceeds and never rolls back", () => {
    const outcome = guardrails.assess(
      declaration(),
      window({
        commit_transaction_p999: { value: 60, samples: 12 },
        round_wall_clock: { value: 180, samples: 900 },
      }),
    );
    expect(outcome.verdict).toBe(guardrails.VERDICT.HOLD);
    expect(outcome.inconclusive.map((finding) => finding.reason)).toContain(guardrails.INCONCLUSIVE.INSUFFICIENT_EVIDENCE);
    // Neither direction. Rolling back on thin evidence is an outage caused by the safety
    // mechanism; proceeding on it is the rollout with no monitoring §22.4 forbids.
    expect(guardrails.permittedAutomaticAction(outcome.verdict)).toBeNull();
  });

  test("a guardrail with no observation at all is NOT_OBSERVED, and holds", () => {
    const outcome = guardrails.assess(declaration(), window({ round_wall_clock: { value: 180, samples: 900 } }));
    expect(outcome.verdict).toBe(guardrails.VERDICT.HOLD);
    expect(outcome.inconclusive[0].reason).toBe(guardrails.INCONCLUSIVE.NOT_OBSERVED);
  });

  test("a breach ROLLS BACK immediately, even while another guardrail is still inconclusive", () => {
    // A regression is conclusive on its own. Waiting for the rest of the window while a
    // shard misbehaves is the failure the automatic rollback exists to prevent.
    const outcome = guardrails.assess(
      declaration(),
      window({
        commit_transaction_p999: { value: 400, samples: 5000 },
        round_wall_clock: { value: 180, samples: 3 },
      }),
    );
    expect(outcome.verdict).toBe(guardrails.VERDICT.ROLL_BACK);
    expect(outcome.breached.map((finding) => finding.id)).toEqual(["commit_transaction_p999"]);
  });

  test("an elapsed window with no breach but nothing observed still holds", () => {
    const outcome = guardrails.assess(declaration(), window({}));
    expect(outcome.verdict).toBe(guardrails.VERDICT.HOLD);
  });

  test("AT_LEAST guardrails are compared the other way round", () => {
    const attainment = guardrails.declare({
      shardId: "shard-1",
      declaredBy: "a",
      declaredAtMs: NOW,
      observationWindowSeconds: 1,
      guardrails: [{ id: "sla_attainment", direction: guardrails.DIRECTION.AT_LEAST, threshold: 0.99, minSamples: 10 }],
    });
    expect(guardrails.assess(attainment, window({ sla_attainment: { value: 0.995, samples: 100 } })).verdict).toBe(
      guardrails.VERDICT.PROCEED,
    );
    expect(guardrails.assess(attainment, window({ sla_attainment: { value: 0.90, samples: 100 } })).verdict).toBe(
      guardrails.VERDICT.ROLL_BACK,
    );
  });
});

describe("the pre-declaration refusal — the point of the whole module", () => {
  test("a window that opened before its guardrails were declared is refused, not evaluated", () => {
    const outcome = guardrails.assess(
      declaration(),
      window({ commit_transaction_p999: { value: 9999, samples: 99999 } }, { windowStartedAtMs: NOW - HOUR_MS }),
    );

    // Not ROLL_BACK, despite a gross breach in the data. The window is not evidence, so it
    // produces no verdict about the shard at all — only a statement about the process.
    expect(outcome.verdict).toBe(guardrails.VERDICT.HOLD);
    expect(outcome.refusal).toMatch(/pre-declared/);
    expect(outcome.breached).toEqual([]);
  });
});

describe("automatic actions are one-directional (§22.3)", () => {
  test("the only automatic action is DISABLE", () => {
    expect(guardrails.AUTOMATIC_ACTIONS).toEqual(["DISABLE"]);
    expect(guardrails.permittedAutomaticAction(guardrails.VERDICT.ROLL_BACK)).toBe("DISABLE");
    expect(guardrails.permittedAutomaticAction(guardrails.VERDICT.PROCEED)).toBeNull();
    expect(guardrails.permittedAutomaticAction(guardrails.VERDICT.HOLD)).toBeNull();
  });

  test("routing an ENABLE through the automatic path throws, and the message names the rule", () => {
    // The next person to reach for this path will be trying to automate the enable, and
    // they should be told why they may not rather than discovering it in review.
    expect(() => guardrails.assertOneDirectional("ENABLE")).toThrow(/no automated process/);
    expect(() => guardrails.assertOneDirectional("ENABLE")).toThrow(/second approver/);
    expect(guardrails.assertOneDirectional("DISABLE")).toBe(true);
  });
});

describe("the staged-rollout controller", () => {
  function controllerDeps(overrides) {
    const published = [];
    const audited = [];
    return {
      published,
      audited,
      deps: {
        liveShards: async () => [{ shardId: "shard-1", regionId: "eu-west", state: "ACTIVE" }],
        declarationFor: async () => declaration(),
        observationsFor: async () => window({ commit_transaction_p999: { value: 400, samples: 5000 } }),
        publish: async (action) => published.push(action),
        audit: async (event) => audited.push(event),
        ...(overrides || {}),
      },
    };
  }

  test("a breach publishes the reverted binding and writes the audit event", async () => {
    const { deps, published, audited } = controllerDeps();
    const summary = await worker.runOnce(deps, { nowMs: NOW + HOUR_MS });

    expect(summary.rolledBack).toBe(1);
    expect(published[0].binding).toEqual({
      level: "region",
      key: "eu-west",
      name: "cutover.engine_enabled",
      value: false,
    });
    expect(published[0].automatic).toBe(true);
    expect(published[0].reason).toMatch(/commit_transaction_p999=400/);
    expect(audited[0].eventType).toBe("CUTOVER_SHARD_ROLLED_BACK");
    expect(audited[0].actorRole).toBe("AUTOMATIC_CONTROLLER");
  });

  test("a healthy shard is neither rolled back nor published", async () => {
    const { deps, published } = controllerDeps({
      observationsFor: async () =>
        window({
          commit_transaction_p999: { value: 60, samples: 5000 },
          round_wall_clock: { value: 180, samples: 900 },
        }),
    });
    const summary = await worker.runOnce(deps, { nowMs: NOW + HOUR_MS });

    expect(summary.rolledBack).toBe(0);
    expect(summary.proceeded).toBe(1);
    expect(published).toEqual([]);
  });

  test("a live shard with NO declaration is reported as a finding, not defaulted to healthy", async () => {
    // `stage.authoriseEnable` refuses exactly this, so a live shard without one was enabled
    // outside the authorised path. Reporting it is the only correct response; treating "no
    // guardrails" as "no breaches" would make the omission invisible.
    const { deps } = controllerDeps({ declarationFor: async () => null });
    const summary = await worker.runOnce(deps, { nowMs: NOW });

    expect(summary.rolledBack).toBe(0);
    expect(summary.results[0].skipped).toMatch(/outside the authorised path/);
  });

  test("a publish that throws is re-raised, never reported as a rollback that happened", async () => {
    // The whole value of an automatic rollback is that its record and its effect agree.
    const { deps } = controllerDeps({
      publish: async () => {
        throw new Error("config service unavailable");
      },
    });
    await expect(worker.runOnce(deps, { nowMs: NOW + HOUR_MS })).rejects.toThrow(/config service unavailable/);
  });
});

describe("the store reads evidence back rather than holding its own copy", () => {
  test("a declaration is read from the audit stream and re-validated", async () => {
    const authorisation = stage.authoriseRollback({ shard: { shardId: "s", regionId: "r" }, reason: "x" });
    expect(authorisation.authorised).toBe(true);

    const prisma = {
      auditEvent: {
        findFirst: async () => ({
          eventType: store.EVENT.ENABLED,
          payload: { guardrails: declaration() },
        }),
      },
    };
    const read = await store.declarationFor({ prisma }, "shard-1");
    expect(read.declaredAtMs).toBe(NOW);
    expect(read.guardrails).toHaveLength(2);
  });

  test("a shard whose latest cutover event is a rollback has no declaration to assess", async () => {
    const prisma = {
      auditEvent: { findFirst: async () => ({ eventType: store.EVENT.ROLLED_BACK, payload: {} }) },
    };
    expect(await store.declarationFor({ prisma }, "shard-1")).toBeNull();
  });

  test("a corrupted declaration is refused rather than partially honoured", async () => {
    const prisma = {
      auditEvent: {
        findFirst: async () => ({ eventType: store.EVENT.ENABLED, payload: { guardrails: { shardId: "shard-1" } } }),
      },
    };
    expect(await store.declarationFor({ prisma }, "shard-1")).toBeNull();
  });

  test("observations take the statistic from §20.1's own row, so a p99.9 cannot be downgraded", async () => {
    // §20.1: "a p99 target on a quantity that bounds a safety window would be a category
    // error". The statistic is read from `sli.TARGET_BY_ID`, never from the declaration, so
    // whoever writes the guardrail cannot quietly relax it.
    expect(sli.TARGET_BY_ID.commit_transaction_p999.statistic).toBe(sli.STATISTIC.P999);

    const observed = await store.observationsFor(
      { kv: null },
      "shard-1",
      declaration(),
      { windowStartedAtMs: NOW, windowEndedAtMs: NOW + HOUR_MS },
    );
    // No kv: nothing is observed, and nothing is invented.
    expect(observed.observations).toEqual({});
    expect(observed.windowStartedAtMs).toBe(NOW);
  });

  test("a guardrail naming an id that is not a §20.1 target is unobserved, not guessed at", async () => {
    const typo = guardrails.declare({
      shardId: "shard-1",
      declaredBy: "a",
      declaredAtMs: NOW,
      observationWindowSeconds: 1,
      guardrails: [{ id: "comit_transaction_p999", direction: guardrails.DIRECTION.AT_MOST, threshold: 1, minSamples: 1 }],
    });
    const observed = await store.observationsFor(
      { kv: null },
      "shard-1",
      typo,
      { windowStartedAtMs: NOW, windowEndedAtMs: NOW + 1 },
    );
    // Reading it as a raw counter would let a typo produce a permanently passing guardrail.
    expect(observed.observations.comit_transaction_p999).toBeUndefined();
    expect(guardrails.assess(typo, observed).verdict).toBe(guardrails.VERDICT.HOLD);
  });
});

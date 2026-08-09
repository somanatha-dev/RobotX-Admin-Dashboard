"use strict";

/**
 * Engine lane — Phase 13: cross-region missions (§19.6) — **Tier 2**, T2-13.
 *
 * The plan's two checklist items for this module:
 *
 * > Implement `shard/crossRegion.js` — decomposition at intake, saga with explicit
 * > compensation
 * > **Require a defined custodian at every transfer point**
 *
 * ── The failure mode the whole section is written against ───────────────────
 * > **The failure mode to design against is goods stranded at a transfer point.** A
 * > transfer point MUST therefore have a defined custodian — a locker, a depot, a staffed
 * > counter — and the saga MUST NOT release custody to an unattended location unless that
 * > location is modelled as a custodian with its own capacity and security properties.
 *
 * Every test in the custodian block below is that sentence taken as an obligation rather
 * than as advice, including the `MODELLED_UNATTENDED` case — which is a *modelling* act,
 * not an escape hatch, and is tested as such.
 */

const crossRegion = require("../../src/engine/shard/crossRegion");
const killSwitches = require("../../src/engine/config/killSwitches");
const { memoryStore, twoShardWorld, transferPoint } = require("./helpers/shardFixture");

const NOW_MS = 1770000000000;

const ENABLED = killSwitches.normaliseState({ cross_region_candidacy: false });
const THROWN = killSwitches.normaliseState({ cross_region_candidacy: true });

const NORTH_SOUTH = transferPoint();

function stops(regions) {
  return regions.map((regionId, index) => ({ stopId: `stop-${index}`, regionId }));
}

/* ═══════════════════════════════════════════════════════════════════════════
   The custodian requirement (§19.6)
   ═══════════════════════════════════════════════════════════════════════════ */

describe("**a defined custodian at every transfer point** (§19.6)", () => {
  test("a depot with an identity and a capacity satisfies the requirement", () => {
    expect(crossRegion.requireCustodian(NORTH_SOUTH)).toEqual({ ok: true, problems: [] });
  });

  test("a transfer point with no custodian type is refused", () => {
    const outcome = crossRegion.requireCustodian({ ...NORTH_SOUTH, custodianType: null });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems[0]).toMatch(/MUST therefore have a defined custodian/);
  });

  test("a custodian kind with no identity is refused — §2.5 makes custody an accountable party", () => {
    const outcome = crossRegion.requireCustodian({ ...NORTH_SOUTH, custodianId: "" });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems[0]).toMatch(/has to say which locker/);
  });

  test("a custodian that can hold nothing is refused at publish rather than at the kerb", () => {
    expect(crossRegion.requireCustodian({ ...NORTH_SOUTH, capacity: 0 }).ok).toBe(false);
    expect(crossRegion.requireCustodian({ ...NORTH_SOUTH, capacity: undefined }).ok).toBe(false);
  });

  // The conditional §19.6 attaches to the one kind it conditionally admits.
  test("an unattended location with no security properties is refused — the label is not a model", () => {
    const outcome = crossRegion.requireCustodian({
      ...NORTH_SOUTH,
      custodianType: crossRegion.CUSTODIAN_TYPE.MODELLED_UNATTENDED,
      securityProperties: null,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems[0]).toMatch(/turn the prohibition off rather than satisfy it/);
  });

  test("an unattended location **that is modelled** is admitted — the specification admits it, conditionally", () => {
    const outcome = crossRegion.requireCustodian({
      ...NORTH_SOUTH,
      custodianType: crossRegion.CUSTODIAN_TYPE.MODELLED_UNATTENDED,
      securityProperties: { access: "PIN", camera: true, tamperAlarm: true },
    });
    expect(outcome).toEqual({ ok: true, problems: [] });
  });

  test("the four custodian kinds are exactly those the migration's CHECK admits", () => {
    expect(Object.values(crossRegion.CUSTODIAN_TYPE)).toEqual(["LOCKER", "DEPOT", "STAFFED_COUNTER", "MODELLED_UNATTENDED"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Decomposition at intake (§19.6)
   ═══════════════════════════════════════════════════════════════════════════ */

describe("decomposition at intake (§19.6)", () => {
  test("a single-region mission is not decomposed and opens no saga", () => {
    const outcome = crossRegion.decompose({ missionId: "m1", stops: stops(["region-north", "region-north"]), transferPoints: [] });
    expect(outcome).toMatchObject({ ok: true, crossRegion: false, regionId: "region-north" });
    expect(outcome.legs).toHaveLength(1);
    expect(outcome.joins).toEqual([]);
    expect(outcome.note).toMatch(/no decomposition, no saga, and no transfer point/);
  });

  test("a two-region mission becomes two Legs joined at one transfer point", () => {
    const outcome = crossRegion.decompose({
      missionId: "m1",
      stops: stops(["region-north", "region-north", "region-south"]),
      transferPoints: [NORTH_SOUTH],
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.crossRegion).toBe(true);
    expect(outcome.legs).toHaveLength(2);
    expect(outcome.joins).toHaveLength(1);
    expect(outcome.joins[0].transferPointId).toBe("TP-NORTH-SOUTH");
    expect(outcome.note).toMatch(/no cross-shard distributed transaction is ever needed/);
  });

  // §19.6 — "The transfer point is a Stop in both Legs".
  test("the transfer point appears as a Stop on **both** Legs", () => {
    const outcome = crossRegion.decompose({
      missionId: "m1",
      stops: stops(["region-north", "region-south"]),
      transferPoints: [NORTH_SOUTH],
    });

    const upstream = outcome.legs[0];
    const downstream = outcome.legs[1];
    expect(upstream.stops[upstream.stops.length - 1]).toMatchObject({ stopType: "TRANSFER", transferPointId: "TP-NORTH-SOUTH" });
    expect(downstream.stops[0]).toMatchObject({ stopType: "TRANSFER", transferPointId: "TP-NORTH-SOUTH" });
    expect(upstream.transferOut.transferPointId).toBe("TP-NORTH-SOUTH");
    expect(downstream.transferIn.transferPointId).toBe("TP-NORTH-SOUTH");
  });

  // §2.4 — "a contiguous sequence of Stops executed by one agent under one commitment".
  test("a mission returning to an earlier region produces a **new** Leg, never a rejoined one", () => {
    const outcome = crossRegion.decompose({
      missionId: "m1",
      stops: stops(["region-north", "region-south", "region-north"]),
      transferPoints: [
        NORTH_SOUTH,
        transferPoint({ id: "tp-2", transferPointId: "TP-SOUTH-NORTH", upstreamRegionId: "region-south", downstreamRegionId: "region-north" }),
      ],
    });

    expect(outcome.legs).toHaveLength(3);
    expect(outcome.legs.map((leg) => leg.regionId)).toEqual(["region-north", "region-south", "region-north"]);
  });

  test("a boundary with no transfer point is refused, naming the failure mode", () => {
    const outcome = crossRegion.decompose({
      missionId: "m1",
      stops: stops(["region-north", "region-south"]),
      transferPoints: [],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems[0]).toMatch(/no transfer point joins region/);
    expect(outcome.problems[0]).toMatch(/handed over nowhere/);
  });

  test("a transfer point that fails the custodian requirement blocks the whole decomposition", () => {
    const outcome = crossRegion.decompose({
      missionId: "m1",
      stops: stops(["region-north", "region-south"]),
      transferPoints: [transferPoint({ custodianId: "" })],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.legs).toEqual([]);
  });

  test("a stop with no region is refused — it belongs to no shard", () => {
    const outcome = crossRegion.decompose({ missionId: "m1", stops: [{ stopId: "s1" }], transferPoints: [] });
    expect(outcome.ok).toBe(false);
    expect(outcome.problems[0]).toMatch(/name no OperatingRegion/);
  });

  test("the choice among candidate transfer points is deterministic, so a decomposition replays (T6)", () => {
    const input = {
      missionId: "m1",
      stops: stops(["region-north", "region-south"]),
      transferPoints: [
        transferPoint({ id: "b", transferPointId: "TP-B" }),
        transferPoint({ id: "a", transferPointId: "TP-A" }),
      ],
    };
    expect(crossRegion.decompose(input)).toEqual(crossRegion.decompose(input));
    expect(crossRegion.decompose(input).joins[0].transferPointId).toBe("TP-A");
  });

  test("decomposition is pure — it reads no store and no clock", () => {
    const source = require("fs").readFileSync(require.resolve("../../src/engine/shard/crossRegion.js"), "utf8");
    const pure = source.slice(source.indexOf("function decompose(input)"), source.indexOf("function stepsFor"));
    expect(pure).not.toMatch(/prisma|Date\.now\(|Math\.random\(/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The saga and its compensation
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the saga (§19.6)", () => {
  function decomposition() {
    return crossRegion.decompose({
      missionId: "mission-n",
      stops: stops(["region-north", "region-south"]),
      transferPoints: [NORTH_SOUTH],
    });
  }

  // §19.6 — "Compensation is explicit per step". Decided at decomposition, so a
  // compensation is never improvised during the incident it is needed for.
  test("every step carries its compensating action, decided in advance", () => {
    const steps = crossRegion.stepsFor(decomposition());
    expect(steps).toHaveLength(2);
    expect(steps[0].compensation).toBe(crossRegion.COMPENSATION.HOLD_AT_TRANSFER_POINT);
    expect(steps[0].compensationDetail).toMatch(/hold at TP-NORTH-SOUTH under custodian DEPOT:DEPOT-42/);
    // The last step has no downstream transfer point, so there is nowhere on its own path
    // to hold — §19.6's other compensating action.
    expect(steps[1].compensation).toBe(crossRegion.COMPENSATION.REDIRECT_UPSTREAM);
  });

  test("only §19.6's two compensating actions exist", () => {
    expect(Object.values(crossRegion.COMPENSATION)).toEqual(["REDIRECT_UPSTREAM", "HOLD_AT_TRANSFER_POINT"]);
  });

  test("a saga is opened durably, carrying its steps and its joins", async () => {
    const prisma = memoryStore(twoShardWorld({ nowMs: NOW_MS }));
    const saga = await crossRegion.openSaga({ prisma }, { sagaId: "SAGA-1", missionId: "mission-n", decomposition: decomposition(), at: new Date(NOW_MS) });

    expect(saga.state).toBe(crossRegion.SAGA_STATE.PLANNED);
    expect(saga.steps.legs).toHaveLength(2);
    expect(saga.steps.steps).toHaveLength(2);
    expect(saga.currentStepIndex).toBe(0);
  });

  test("a saga is refused for a single-region mission — there is nothing to orchestrate", async () => {
    const prisma = memoryStore(twoShardWorld({ nowMs: NOW_MS }));
    const single = crossRegion.decompose({ missionId: "m", stops: stops(["region-north"]), transferPoints: [] });
    await expect(crossRegion.openSaga({ prisma }, { sagaId: "S", missionId: "mission-n", decomposition: single, at: new Date(NOW_MS) })).rejects.toThrow(
      /needs no orchestration/,
    );
  });

  test("advancing to the transfer point records where the goods are and since when", async () => {
    const prisma = memoryStore(twoShardWorld({ nowMs: NOW_MS }));
    await crossRegion.openSaga({ prisma }, { sagaId: "SAGA-1", missionId: "mission-n", decomposition: decomposition(), at: new Date(NOW_MS) });

    const advanced = await crossRegion.advance({ prisma }, { sagaId: "SAGA-1", at: new Date(NOW_MS + 1000), atTransferPointId: "tp-1" });
    expect(advanced.state).toBe(crossRegion.SAGA_STATE.IN_PROGRESS);
    expect(advanced.currentStepIndex).toBe(1);
    // The schema's `CrossRegionSaga_hold_is_timed` CHECK keeps these two together.
    expect(advanced.heldAtTransferPointId).toBe("tp-1");
    expect(advanced.heldSince).toEqual(new Date(NOW_MS + 1000));
  });

  test("the last step completes and closes the saga, releasing the hold", async () => {
    const prisma = memoryStore(twoShardWorld({ nowMs: NOW_MS }));
    await crossRegion.openSaga({ prisma }, { sagaId: "SAGA-1", missionId: "mission-n", decomposition: decomposition(), at: new Date(NOW_MS) });
    await crossRegion.advance({ prisma }, { sagaId: "SAGA-1", at: new Date(NOW_MS + 1000), atTransferPointId: "tp-1" });

    const done = await crossRegion.advance({ prisma }, { sagaId: "SAGA-1", at: new Date(NOW_MS + 2000) });
    expect(done.state).toBe(crossRegion.SAGA_STATE.COMPLETED);
    expect(done.closedAt).toEqual(new Date(NOW_MS + 2000));
    expect(done.heldAtTransferPointId).toBeNull();
    expect(done.heldSince).toBeNull();
  });

  test("compensating records the action decided at decomposition, not one invented now", async () => {
    const prisma = memoryStore(twoShardWorld({ nowMs: NOW_MS }));
    await crossRegion.openSaga({ prisma }, { sagaId: "SAGA-1", missionId: "mission-n", decomposition: decomposition(), at: new Date(NOW_MS) });

    const compensating = await crossRegion.compensate(
      { prisma },
      { sagaId: "SAGA-1", at: new Date(NOW_MS + 5000), reason: "DOWNSTREAM_LEG_INFEASIBLE", transferPoint: NORTH_SOUTH },
    );

    expect(compensating.state).toBe(crossRegion.SAGA_STATE.COMPENSATING);
    expect(compensating.compensation.action).toBe(crossRegion.COMPENSATION.HOLD_AT_TRANSFER_POINT);
    expect(compensating.compensation.decidedAt).toBe("DECOMPOSITION");
    expect(compensating.compensation.custodian).toMatchObject({ transferPointId: "TP-NORTH-SOUTH", type: "DEPOT", id: "DEPOT-42" });
    expect(compensating.heldAtTransferPointId).toBe("tp-1");
  });

  // The one refusal that is the whole point of §19.6's last paragraph.
  test("holding at a transfer point with no defined custodian is **refused**", async () => {
    const prisma = memoryStore(twoShardWorld({ nowMs: NOW_MS }));
    await crossRegion.openSaga({ prisma }, { sagaId: "SAGA-1", missionId: "mission-n", decomposition: decomposition(), at: new Date(NOW_MS) });

    await expect(
      crossRegion.compensate({ prisma }, { sagaId: "SAGA-1", at: new Date(NOW_MS + 5000), transferPoint: { ...NORTH_SOUTH, custodianId: "" } }),
    ).rejects.toThrow(/in transit to nowhere/);

    // And the saga was not moved into COMPENSATING on the way to failing.
    const saga = prisma.__store.crossRegionSaga[0];
    expect(saga.state).toBe(crossRegion.SAGA_STATE.PLANNED);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Late binding (§19.6)
   ═══════════════════════════════════════════════════════════════════════════ */

describe("late binding — the downstream Leg is not hardened early (§19.6)", () => {
  const THRESHOLD = 0.8;

  test("a confident upstream ETA permits hardening", () => {
    expect(crossRegion.mayHarden({ upstreamEtaConfidence: 0.9, threshold: THRESHOLD })).toMatchObject({ mayHarden: true, reason: "UPSTREAM_ETA_CONFIDENT" });
  });

  test("an unconfident one does not", () => {
    expect(crossRegion.mayHarden({ upstreamEtaConfidence: 0.5, threshold: THRESHOLD })).toMatchObject({
      mayHarden: false,
      reason: "UPSTREAM_ETA_NOT_CONFIDENT_ENOUGH",
    });
  });

  // The refusal, not the preference: an unmeasured confidence is not a high one.
  test("**no measurement means no hardening** — it does not default to true", () => {
    expect(crossRegion.mayHarden({ threshold: THRESHOLD })).toMatchObject({ mayHarden: false, reason: "NO_UPSTREAM_ETA_CONFIDENCE" });
    expect(crossRegion.mayHarden({ upstreamEtaConfidence: 0.99 })).toMatchObject({ mayHarden: false, reason: "NO_BINDING_THRESHOLD_CONFIGURED" });
    expect(crossRegion.mayHarden()).toMatchObject({ mayHarden: false });
  });

  test("an upstream Leg already settled at the transfer point needs no prediction", () => {
    expect(crossRegion.mayHarden({ upstreamSettled: true })).toMatchObject({ mayHarden: true, reason: "UPSTREAM_SETTLED_AT_TRANSFER_POINT" });
  });

  test("the threshold is the registered parameter, not a literal", () => {
    const service = require("../../src/engine/config/service");
    const configured = service.defaultSnapshot().resolve("crossregion.downstream_binding_eta_confidence");
    expect(configured).toBe(0.8);
    expect(crossRegion.mayHarden({ upstreamEtaConfidence: configured - 0.01, threshold: configured }).mayHarden).toBe(false);
    expect(crossRegion.mayHarden({ upstreamEtaConfidence: configured, threshold: configured }).mayHarden).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The kill switch, and the tier rule that makes it real
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the `cross_region_candidacy` kill switch (§22.5, T2-13)", () => {
  test("the switch is recognised, and the module names it", () => {
    expect(crossRegion.KILL_SWITCH).toBe("cross_region_candidacy");
    expect(killSwitches.isKnownSwitch(crossRegion.KILL_SWITCH)).toBe(true);
    expect(crossRegion.isEnabled(ENABLED)).toBe(true);
    expect(crossRegion.isEnabled(THROWN)).toBe(false);
  });

  test("with the switch thrown, a cross-region mission is admitted **region-local only**", async () => {
    const prisma = memoryStore(twoShardWorld({ nowMs: NOW_MS }));
    const outcome = await crossRegion.admit(
      { prisma },
      {
        missionId: "mission-n",
        sagaId: "SAGA-1",
        stops: stops(["region-north", "region-south"]),
        transferPoints: [NORTH_SOUTH],
        purpose: "PRIMARY",
        receivedAtMs: NOW_MS,
        killSwitchState: THROWN,
      },
    );

    expect(outcome.crossRegion).toBe(false);
    expect(outcome.degradedBy).toBe("cross_region_candidacy");
    expect(outcome.saga).toBeNull();
    expect(outcome.admissions).toHaveLength(1);
    expect(prisma.__store.crossRegionSaga).toEqual([]);
    // T2-13's stated degradation, and an honest statement of what was lost.
    expect(outcome.problems[0]).toMatch(/The work is not lost; the decomposition is/);
  });

  test("with the switch enabled, each per-region Leg is queued to its own shard", async () => {
    const prisma = memoryStore(twoShardWorld({ nowMs: NOW_MS }));
    const outcome = await crossRegion.admit(
      { prisma },
      {
        missionId: "mission-n",
        sagaId: "SAGA-1",
        stops: stops(["region-north", "region-south"]),
        transferPoints: [NORTH_SOUTH],
        purpose: "PRIMARY",
        receivedAtMs: NOW_MS,
        killSwitchState: ENABLED,
        shardResolution: { shardByRegionId: { "region-north": "shard-north", "region-south": "shard-south" } },
      },
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.crossRegion).toBe(true);
    expect(outcome.admissions.map((admission) => admission.shardId)).toEqual(["shard-north", "shard-south"]);
    expect(prisma.__store.crossRegionSaga).toHaveLength(1);
    expect(outcome.sentence).toMatch(/decomposed into 2 per-region Leg\(s\) joined at 1 transfer point\(s\)/);
  });

  test("an invalid decomposition is reported, and admits nothing", async () => {
    const prisma = memoryStore(twoShardWorld({ nowMs: NOW_MS }));
    const outcome = await crossRegion.admit(
      { prisma },
      { missionId: "m", sagaId: "S", stops: stops(["region-north", "region-south"]), transferPoints: [], receivedAtMs: NOW_MS, killSwitchState: ENABLED },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.admissions).toEqual([]);
    expect(prisma.__store.workQueue).toEqual([]);
  });
});

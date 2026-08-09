"use strict";

/**
 * Engine lane — publish-time validation (§22.1 rule 5).
 *
 * > Invalid configuration is rejected at publish time, not discovered at decision
 * > time. This includes **cross-parameter consistency**, not merely per-parameter
 * > range checks.
 *
 * The matrix below is the completion criterion for Phase 1: every §22.1 rule-5
 * violation has a crafted configuration that triggers it, **and triggers only it**.
 * The second half matters as much as the first — a check that fires on everything
 * tells an operator nothing about what they got wrong, and a check that fires on
 * something else is masking the rule it was written for.
 */

const service = require("../../src/engine/config/service");
const { SEVERITY } = require("../../src/engine/config/validators");

const bind = (name, value, level = "global", key = "") => ({ level, key, name, value });

/**
 * A baseline that passes every blocking check.
 *
 * It differs from the seeded register in exactly one binding: the combined degraded
 * conservatism cap. The specification's own Appendix A defaults — f_derate 1.0,
 * charger_availability_margin 1.15, uncalibrated_reserve_factor 1.25 and
 * route.degraded_reserve_factor 1.40 — compose to 2.0125, above the 1.60 default cap,
 * so the seeded register does not publish. That is V9 working as designed (§14.3
 * anticipates exactly this: "a fleet whose effective energy margin is 1.8× because
 * four people each chose 1.15–1.25"), and raising the cap is an explicit Safety-class
 * decision. The tests below stand it in so that every *other* rule can be tested in
 * isolation; the finding itself is asserted in its own test and escalated in
 * `PHASE_1_IMPLEMENTATION_REPORT.md`.
 */
const BASELINE = [bind("energy.max_combined_conservatism", 2.1)];

const validate = (extra) => service.validateCandidate({ bindings: [...BASELINE, ...(extra || [])] }).result;

const blockingIds = (result) => [...new Set(result.blocking.map((item) => item.id))].sort();

describe("the baseline", () => {
  test("passes every blocking check", () => {
    const result = validate();
    expect(result.blocking).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("still reports §22.4 launch-gate findings, which Phase 15 owns rather than Phase 1", () => {
    const result = validate();
    expect(result.launchGate.length).toBeGreaterThan(0);
    expect(result.launchGate.every((item) => item.severity === SEVERITY.LAUNCH_GATE)).toBe(true);
  });
});

describe("the §22.1 rule-5 matrix — each violation triggers its own check and no other", () => {
  const CASES = [
    {
      id: "V1",
      what: "opportunity value horizon at or below commitment horizon + max mission duration",
      bindings: [bind("cost.opportunity.value_horizon", 900)],
      expect: /silently saturates/,
    },
    {
      id: "V2",
      what: "a C_policy adjustment whose credit ceiling is missing",
      bindings: [bind("policy.max_burn_in_credit", null)],
      expect: /candidate-pruning lower bound admissible/,
    },
    {
      id: "V3",
      what: "the contingency quantile set by hand",
      bindings: [bind("energy.contingency_quantile", 0.95)],
      also: ["A2"],
      expect: /derived as 1 − α\[T1\]|1e-2 tier-1 target/,
    },
    {
      id: "V4",
      what: "a shard sized past the serial commit section",
      bindings: [bind("shard.mission_rate_per_agent_hour", 20)],
      // PHASE 13 — V4 now delegates the inequality to `shard/sizing.js`, which is the one
      // place it is written. The wording is that module's; the arithmetic and the §3.5
      // reasoning it reports are unchanged, and the worked figure it quotes ("about 4 390
      // agents, not 20 000") is §3.5's own example.
      expect: /bound 2 is violated: N·r·k_txn·t_txn/,
    },
    {
      id: "V5",
      what: "dedup retention below offer TTL + max delivery delay",
      bindings: [bind("agent.dedup_retention", 100)],
      expect: /redelivered command can outlive the state that would reject it/,
    },
    {
      id: "V6",
      what: "input-snapshot retention below full record retention",
      bindings: [bind("observability.input_snapshot_retention", 7)],
      expect: /unreplayable/,
    },
    {
      id: "V7",
      what: "an unbounded aging multiplier",
      bindings: [bind("cost.aging.max_multiplier", null)],
      expect: /rejected rather than merely discouraged/,
    },
    {
      id: "V9",
      what: "derating factors compounding past the declared cap",
      bindings: [bind("energy.f_derate", 1.6)],
      expect: /combined nominal energy conservatism/,
    },
    {
      id: "A1",
      what: "λ_min above a class's actual value of time, which makes the pruning bound inadmissible",
      bindings: [bind("cost.lambda_time_floor", 5)],
      expect: /must be a genuine underestimate/,
    },
    {
      id: "A3",
      what: "the migrated legacy liveness coupling inverted",
      bindings: [bind("legacy.liveness.db_flush_interval_ms", 45000)],
      expect: /flap online\/offline forever/,
    },
  ];

  test.each(CASES)("$id — $what", (testCase) => {
    const result = validate(testCase.bindings);
    expect(result.ok).toBe(false);
    expect(blockingIds(result)).toEqual([testCase.id, ...(testCase.also || [])].sort());
    expect(result.blocking.find((item) => item.id === testCase.id).message).toMatch(testCase.expect);
  });
});

describe("V8 — spatial containment (§3.6)", () => {
  test("passes vacuously while no spatial map is published — an absent map is not an invalid one", () => {
    expect(validate()).toMatchObject({ ok: true });
  });

  test("rejects a zone that spans two regions", () => {
    const result = service.validateCandidate({
      bindings: BASELINE,
      spatial: {
        zones: [
          { id: "z1", regionId: "r1" },
          { id: "z1", regionId: "r2" },
        ],
      },
    }).result;
    expect(blockingIds(result)).toEqual(["V8"]);
    expect(result.blocking[0].message).toMatch(/Ω_terminal no longer bounds the prices/);
  });

  test("rejects a fine cell that maps to two zones", () => {
    const result = service.validateCandidate({
      bindings: BASELINE,
      spatial: {
        zones: [{ id: "z1", regionId: "r1" }],
        cells: [
          { cellId: "c1", zoneId: "z1" },
          { cellId: "c1", zoneId: "z2" },
        ],
      },
    }).result;
    expect(blockingIds(result)).toEqual(["V8"]);
    expect(result.blocking[0].message).toMatch(/maps to 2 zones/);
  });

  test("rejects a fine cell that maps to two sites", () => {
    const result = service.validateCandidate({
      bindings: BASELINE,
      spatial: {
        zones: [{ id: "z1", regionId: "r1" }],
        cells: [
          { cellId: "c1", zoneId: "z1", siteId: "s1" },
          { cellId: "c1", zoneId: "z1", siteId: "s2" },
        ],
      },
    }).result;
    expect(blockingIds(result)).toEqual(["V8"]);
    expect(result.blocking[0].message).toMatch(/at most one/);
  });

  test("accepts a well-formed map", () => {
    const result = service.validateCandidate({
      bindings: BASELINE,
      spatial: {
        zones: [
          { id: "z1", regionId: "r1" },
          { id: "z2", regionId: "r1" },
        ],
        cells: [
          { cellId: "c1", zoneId: "z1", siteId: "s1" },
          { cellId: "c2", zoneId: "z2" },
        ],
      },
    }).result;
    expect(result.ok).toBe(true);
  });
});

describe("V10 — calibration status (§22.4)", () => {
  test("the Safety-class gate is reported, not blocking, until a launch-gated publish", () => {
    const reported = validate();
    expect(reported.ok).toBe(true);
    expect(reported.launchGate.some((item) => /Safety-class \(Tier 0\) parameter/.test(item.message))).toBe(true);
  });

  test("becomes blocking when the publish declares itself launch-gated", () => {
    const result = service.validateCandidate({ bindings: BASELINE, enforceLaunchGate: true }).result;
    expect(result.ok).toBe(false);
    expect(blockingIds(result)).toEqual(["V10"]);
    expect(result.blocking[0].message).toMatch(/No Tier 0 parameter may be PROVISIONAL or UNCALIBRATED at launch/);
  });
});

describe("per-parameter checks run before the cross-parameter ones", () => {
  test("a value outside its declared range is rejected with its unit named", () => {
    const result = validate([bind("commit.max_serial_utilisation", 0.95)]);
    expect(result.blocking.some((item) => item.id === "P2")).toBe(true);
    expect(result.blocking.find((item) => item.id === "P2").message).toMatch(/above its valid range maximum 0\.6/);
  });

  test("a non-integer where an integer is declared is rejected", () => {
    const result = validate([bind("dispatch.offer_ttl", 20.5)]);
    expect(result.blocking.find((item) => item.id === "P2").message).toMatch(/is not an integer/);
  });

  test("a binding for a parameter with no register entry is rejected", () => {
    const result = validate([bind("cost.made_up_weight", 3)]);
    expect(result.blocking.find((item) => item.id === "P3").message).toMatch(/No behavioural constant exists/);
  });

  test("a binding at a scope level the parameter does not declare is rejected", () => {
    const result = validate([bind("verify.arrival_radius", 10, "agent", "agent-77")]);
    expect(result.blocking.find((item) => item.id === "P4").message).toMatch(/not among its declared levels/);
  });
});

describe("the seeded register, published as-is", () => {
  test("is rejected by exactly one blocking finding: the compounded degraded conservatism", () => {
    const result = service.validateCandidate({}).result;
    expect(result.ok).toBe(false);
    expect(blockingIds(result)).toEqual(["V9"]);
    expect(result.blocking[0].message).toMatch(/combined degraded energy conservatism 2\.0/);
  });
});

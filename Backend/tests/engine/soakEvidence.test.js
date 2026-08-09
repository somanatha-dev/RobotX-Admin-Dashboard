"use strict";

/**
 * Engine lane — the `soak` gate's evidence collector (`tools/soak/collect.js`).
 *
 * No soak is run here and none is claimed. What these tests establish is that the collector
 * is honest in the two directions that matter: it refuses to call an incomplete record clean,
 * and it genuinely fails a record whose observations are bad. A collector whose failing
 * branches are never exercised would be run for the first time against a multi-day staging
 * run, which is the worst possible moment to discover it reports everything as fine.
 */

const soak = require("../../tools/soak/collect");
const sli = require("../../src/engine/observability/sli");
const service = require("../../src/engine/config/service");

const HOUR_MS = 3_600_000;

/** A config accessor in the shape `sli.attainment()` expects. */
function configAccessor() {
  const snapshot = service.defaultSnapshot();
  return {
    get(parameter) {
      try {
        return snapshot.resolve(parameter);
      } catch {
        return null;
      }
    },
  };
}

/**
 * An SLI snapshot with every §20.1 row observed, including both p99.9 rows.
 *
 * Built through the real registry rather than hand-written, so the shape cannot drift from
 * what a production process would actually publish.
 *
 * `factor` is a multiple of each row's own registered target rather than a fixed
 * millisecond value, because §20.1's rows are not all in milliseconds — one is a ratio
 * bounded at 0.25 — and a flat number would silently miss some rows and not others.
 */
function sliSnapshot(factor) {
  const config = configAccessor();
  const registry = sli.createRegistry();
  for (const target of sli.TARGETS) {
    const value = config.get(target.parameter);
    if (!Number.isFinite(value)) continue;
    // 200 samples so a p99.9 has something to be the tail of.
    for (let index = 0; index < 200; index += 1) registry.observe(`sli.${target.id}`, value * factor);
  }
  return registry.snapshot();
}

/** A healthy invariant summary: 22 checks, all ENFORCED, nothing unchecked. */
function healthyInvariants() {
  return { total: 22, ENFORCED: 22, VIOLATED: 0, SUSPENDED: 0, unchecked: 0, invariantViolations: 0, violatedInvariants: [], checkerHealthy: true };
}

/**
 * A complete, clean run: 4 windows over 80 hours, flat memory, no errors, no violations.
 */
function cleanRun(overrides) {
  const settings = overrides || {};
  const collector = soak.createCollector({
    workload: "production-shaped staging load, 500 Legs/round",
    shardId: "shard-a",
    startedAtMs: 0,
    growthSeries: ["timerTable", "cellPairCache"],
  });

  for (let window = 0; window < 4; window += 1) {
    collector.window({
      atMs: window * 20 * HOUR_MS,
      sli: sliSnapshot(settings.latencyFactor === undefined ? 0.5 : settings.latencyFactor),
      invariants: settings.invariants || healthyInvariants(),
      guardrail: settings.guardrail || { verdict: "PASS" },
      throughput: 1000,
      errors: 0,
      cpuPercent: 30,
      memoryBytes: 100_000_000,
      growth: settings.growth ? settings.growth(window) : { timerTable: 500, cellPairCache: 9000 },
    });
  }

  return collector.finish({ endedAtMs: 80 * HOUR_MS, config: configAccessor() });
}

const derived = { requiredDurationMs: 72 * HOUR_MS, durationDerived: true };

describe("the collector assembles every quantity the gate's evidence has to carry", () => {
  test("a complete run reports all eleven required quantities COLLECTED", () => {
    const record = cleanRun();
    const notCollected = record.collection.filter((row) => row.status === soak.COLLECTION.NOT_COLLECTED);
    expect(notCollected).toEqual([]);
    expect(record.collection.map((row) => row.id).sort()).toEqual(soak.REQUIRED.map((row) => row.id).sort());
  });

  test("the assembled record carries the ten quantities as data, not as a boolean", () => {
    const record = cleanRun();
    expect(record.durationMs).toBe(80 * HOUR_MS);
    expect(record.workload).toMatch(/production-shaped/);
    expect(record.throughput.total).toBe(4000);
    expect(record.errors.total).toBe(0);
    expect(record.cpuPercent.max).toBe(30);
    expect(record.memoryBytes.drift).toBe(0);
    expect(record.invariants.violations).toBe(0);
    expect(record.rollbackSignals).toEqual([]);
    expect(record.growth.map((row) => row.name).sort()).toEqual(["cellPairCache", "timerTable"]);

    // §20.1's two p99.9 rows are present and observed — the tail is the operationally
    // interesting part for a system supervising hardware, and both of these bound a window.
    const tailRows = record.latency.filter((row) => row.boundsSafetyWindow);
    expect(tailRows.map((row) => row.id).sort()).toEqual(["commit_transaction_p999", "decision_to_dispatch_p999"]);
    for (const row of tailRows) expect(row.observed).not.toBeNull();
  });

  test("a clean, long-enough run against a DERIVED duration passes", () => {
    expect(soak.assess(cleanRun(), derived)).toEqual({ verdict: soak.VERDICT.PASS, missing: [], reasons: [] });
  });
});

describe("it refuses to call an incomplete or undefendable record clean", () => {
  test("a run with no CPU or memory samples is INCOMPLETE, not passing", () => {
    const collector = soak.createCollector({ workload: "load", startedAtMs: 0, growthSeries: ["timerTable"] });
    collector.window({ atMs: 0, sli: sliSnapshot(0.5), invariants: healthyInvariants(), throughput: 10, errors: 0, growth: { timerTable: 1 } });
    collector.window({ atMs: HOUR_MS, sli: sliSnapshot(0.5), invariants: healthyInvariants(), throughput: 10, errors: 0, growth: { timerTable: 1 } });
    const record = collector.finish({ endedAtMs: 80 * HOUR_MS, config: configAccessor() });

    const verdict = soak.assess(record, derived);
    expect(verdict.verdict).toBe(soak.VERDICT.INCOMPLETE);
    expect(verdict.missing.sort()).toEqual(["cpu", "memory"]);
  });

  test("an unhealthy invariant checker is INCOMPLETE — 'we did not look' is not 'nothing was wrong'", () => {
    const record = cleanRun({ invariants: { ...healthyInvariants(), unchecked: 3, checkerHealthy: false } });
    const verdict = soak.assess(record, derived);
    expect(verdict.verdict).toBe(soak.VERDICT.INCOMPLETE);
    expect(verdict.missing).toContain("invariantViolations");
  });

  test("a complete record against an UN-DERIVED duration is refused before it is judged", () => {
    // The check `PHASE_15_BLOCKER_RESOLUTION_PLAN.md` §11.2 asks for: `release.soak_duration`
    // is PROVISIONAL, and a run measured against it is a run whose length nobody can defend.
    const verdict = soak.assess(cleanRun(), { requiredDurationMs: 72 * HOUR_MS, durationDerived: false });
    expect(verdict.verdict).toBe(soak.VERDICT.DURATION_TARGET_NOT_DERIVED);
    expect(verdict.reasons[0]).toMatch(/PROVISIONAL/);
  });

  test("release.soak_duration is in fact still PROVISIONAL, which is why that branch is the live one", () => {
    const entry = service.loadRegister().entries.get("release.soak_duration");
    expect(entry).toBeTruthy();
    expect(entry.calibrationStatus).toBe("PROVISIONAL");
    expect(entry.awaits).toBeTruthy();
  });

  test("a run shorter than the required duration is TOO_SHORT", () => {
    const collector = soak.createCollector({ workload: "load", startedAtMs: 0, growthSeries: ["timerTable"] });
    for (let window = 0; window < 2; window += 1) {
      collector.window({
        atMs: window * HOUR_MS,
        sli: sliSnapshot(0.5),
        invariants: healthyInvariants(),
        throughput: 10,
        errors: 0,
        cpuPercent: 10,
        memoryBytes: 1000,
        growth: { timerTable: 5 },
      });
    }
    const record = collector.finish({ endedAtMs: HOUR_MS, config: configAccessor() });
    expect(soak.assess(record, derived).verdict).toBe(soak.VERDICT.TOO_SHORT);
  });
});

describe("it genuinely fails a bad run — the four failing branches, exercised", () => {
  test("an unbounded structure is DRIFTED", () => {
    // §24.6's own four shapes. A timer table that grows every window is the canonical one.
    const record = cleanRun({ growth: (window) => ({ timerTable: 500 * (window + 1), cellPairCache: 9000 }) });
    const verdict = soak.assess(record, derived);
    expect(verdict.verdict).toBe(soak.VERDICT.DRIFTED);
    expect(verdict.reasons[0]).toMatch(/timerTable grew by 300\.0 %/);
  });

  test("an invariant violation is VIOLATED, and names the invariant", () => {
    const record = cleanRun({
      invariants: { ...healthyInvariants(), VIOLATED: 1, ENFORCED: 21, invariantViolations: 2, violatedInvariants: ["I6"] },
    });
    const verdict = soak.assess(record, derived);
    expect(verdict.verdict).toBe(soak.VERDICT.VIOLATED);
    expect(verdict.reasons[0]).toMatch(/I6/);
    expect(verdict.reasons[0]).toMatch(/target is exactly zero/);
  });

  test("a guardrail signal during the run is VIOLATED — the most important output a soak can have", () => {
    const record = cleanRun({ guardrail: { verdict: "ROLL_BACK", breached: ["commit_transaction_p999"] } });
    const verdict = soak.assess(record, derived);
    expect(verdict.verdict).toBe(soak.VERDICT.VIOLATED);
    expect(verdict.reasons.join(" ")).toMatch(/guardrail signal/);
    expect(record.rollbackSignals).toHaveLength(4);
  });

  test("latency that misses a §20.1 target throughout the soak is VIOLATED", () => {
    // 10 000 ms against every target, so every row misses rather than one.
    const record = cleanRun({ latencyFactor: 10 });
    const verdict = soak.assess(record, derived);
    expect(verdict.verdict).toBe(soak.VERDICT.VIOLATED);
    expect(verdict.reasons.join(" ")).toMatch(/missed its §20\.1 target throughout the soak/);
  });
});

describe("drift is the same definition the scale harness uses", () => {
  test("flat is bounded, growth is not, and a run of one window judges nothing", () => {
    // Kept identical on purpose: two soak artefacts produced by different runners have to be
    // comparable, and a second definition of "drift" is how they stop being.
    expect(soak.drift([10, 10, 10])).toBe(0);
    expect(soak.drift([10, 20])).toBe(1);
    expect(soak.drift([10])).toBeNull();
    expect(soak.drift([0, 5])).toBe(Infinity);
  });
});

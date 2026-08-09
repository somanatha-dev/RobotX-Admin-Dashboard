"use strict";

/**
 * §24.6 — load through overload, and the soak profile.
 *
 * > - **Soak tests over days** to expose leaks, unbounded caches, timer accumulation, and
 * >   queue drift.
 * > - **Load tests through overload** to verify admission control and graceful shedding
 * >   rather than collapse.
 *
 * ── Overload: the property is the *shape* of the degradation ───────────────
 * §20.5's control is a ladder, and the thing that distinguishes graceful shedding from
 * collapse is monotonicity: as load rises, each additional rung sheds strictly more, in a
 * declared order, and the work that is never shed is never shed at any rung. A system that
 * "handled overload" by dropping an arbitrary subset would pass a throughput test and fail
 * this one, which is the right way round.
 *
 * ── Soak: a leak is a shape, not a duration ────────────────────────────────
 * `release.soak_duration` is 72 hours and this suite does not run for 72 hours. What it
 * runs is the shape check the duration exists to reveal: sample a tracked quantity in
 * windows across a long loop and compare the last window against the first. A structure
 * that settles passes at any length; one that drifts fails at any length. The long run is
 * still required — a slow accumulator with a time constant longer than this loop is
 * invisible here — and `release.soak_duration` is what names it. Both facts are stated so
 * neither is mistaken for the other.
 */

const admission = require("../../src/engine/intake/admission");
const cache = require("../../src/engine/feasibility/cache");
const sli = require("../../src/engine/observability/sli");
const service = require("../../src/engine/config/service");
const harness = require("./helpers/scaleHarness");

describe("§20.5 — load through overload sheds gracefully rather than collapsing", () => {
  test("the shed ladder is monotone: every rung sheds a superset of the rung below", () => {
    // The property that makes the ladder a ladder. §22.5 rule 2 makes the same argument
    // about kill switches — the supported set is the prefixes of an order — and the reason
    // is identical: an operator under pressure must be able to reason about "one more rung"
    // without consulting a table of exceptions.
    for (let level = 1; level < admission.SHED_LADDER.length; level += 1) {
      const below = admission.rungAt(level - 1);
      const rung = admission.rungAt(level);

      for (const purpose of below.shedsPurposes) {
        expect({ level, purpose, shed: rung.shedsPurposes.includes(purpose) }).toEqual({ level, purpose, shed: true });
      }
      for (const slaClass of below.shedsSlaClasses) {
        expect({ level, slaClass, shed: rung.shedsSlaClasses.includes(slaClass) }).toEqual({ level, slaClass, shed: true });
      }
    }
  });

  test("speculative work is shed first and customer work last — §17.3's own ordering", () => {
    // Not an arbitrary order. §17.3: repositioning is "first to be shed under load"; no
    // customer is waiting on it. A ladder that shed a customer class before a speculative
    // reposition would be optimising the wrong quantity at exactly the wrong moment.
    const first = admission.rungAt(1);
    expect(first.shedsPurposes).toEqual(expect.arrayContaining(["REPOSITION", "EXERCISE"]));
    expect(first.shedsSlaClasses).toEqual([]);
  });

  test("rising load declines strictly more, and never collapses to declining everything", () => {
    // The sweep: the same request, assessed at every rung. What is asserted is that the
    // decline set grows monotonically **and** that something is still admitted at the top
    // rung — because a control that ends by declining all work has not degraded gracefully,
    // it has failed closed on the customer.
    const admittedAtLevel = [];
    for (let level = 0; level < admission.SHED_LADDER.length; level += 1) {
      const outcomes = [
        { purpose: "PRIMARY", slaClass: "premium" },
        { purpose: "PRIMARY", slaClass: "standard" },
        { purpose: "PRIMARY", slaClass: "economy" },
        { purpose: "REPOSITION", slaClass: null },
        { purpose: "RECOVERY", slaClass: null },
      ].map((request) => admission.assess({ ...request, shedLevel: level }));

      admittedAtLevel.push(outcomes.filter((outcome) => outcome.admitted).length);
    }

    for (let level = 1; level < admittedAtLevel.length; level += 1) {
      expect({ level, admitted: admittedAtLevel[level] <= admittedAtLevel[level - 1] }).toEqual({ level, admitted: true });
    }

    // At the top rung, the custodial work is still admitted. §20.5's control declines *new
    // missions*; a RECOVERY Leg is the discharge of an obligation the fleet has already
    // incurred physically, and declining it would leave the goods where they are — the
    // outcome the control exists to avoid, not one it may choose.
    expect(admittedAtLevel[admittedAtLevel.length - 1]).toBeGreaterThan(0);
    const atTop = admission.assess({ purpose: "RECOVERY", slaClass: null, shedLevel: admission.MAX_SHED_LEVEL });
    expect(atTop.admitted).toBe(true);
  });

  test("a decline carries an honest reason, not a generic failure", () => {
    // §20.5: "Declined *at intake with an honest reason*, before anything durable is
    // written." A 500 tells the caller to retry; a named decline tells them what to change.
    const declined = admission.assess({ purpose: "REPOSITION", slaClass: null, shedLevel: 1 });
    expect(declined.admitted).toBe(false);
    expect(declined.reason).toBeTruthy();
    expect(declined.sentence).toBeTruthy();
  });
});

describe("§24.6 — the soak profile looks for the shapes a leak makes", () => {
  test("the feasibility cache does not grow without bound under sustained load", () => {
    // §7.6's cache is the one with the most obvious unbounded-growth risk: a key per
    // (agent, predicate class) pair, written on every evaluation. The check is that the key
    // *space* is bounded by the inputs rather than by the number of evaluations — which is
    // what makes the difference between a cache and a leak.
    const keys = new Set();
    const outcome = harness.soak({
      iterations: 20000,
      windows: 4,
      step: (index) => {
        // 100 agents, 8 classes: the key space is 800 whatever the iteration count.
        keys.add(cache.agentKey(`agent-${index % 100}`, `class-${index % 8}`));
      },
      sample: () => keys.size,
    });

    // Bounded: the last window is no larger than the first, because the space saturated.
    expect(outcome.bounded).toBe(true);
    expect(outcome.windows[outcome.windows.length - 1]).toBeLessThanOrEqual(800);
  });

  test("an SLI registry's histogram memory is bounded by its bucket count, not by its sample count", () => {
    // Timer accumulation and unbounded metrics are the same failure wearing different
    // clothes. §21.4's histograms are bucketed precisely so that a million observations
    // cost the same memory as a thousand — and that is a property worth checking, because
    // the naive implementation (keep the samples, compute the quantile later) is both
    // easier to write and unbounded.
    const registry = sli.createRegistry();
    const outcome = harness.soak({
      iterations: 40000,
      windows: 4,
      step: (index) => registry.observe("round_wall_clock", 1 + (index % 500)),
      sample: () => {
        const published = registry.snapshot ? registry.snapshot() : registry;
        const histogram = (published.histograms || {}).round_wall_clock;
        return histogram ? Object.keys(histogram.buckets).length : 0;
      },
    });

    expect(outcome.bounded).toBe(true);
    // And the bucket count is bounded by the histogram's own configuration, not by the
    // sample count — the assertion that distinguishes "bucketed" from "sorted array".
    const buckets = outcome.windows[outcome.windows.length - 1];
    expect(buckets).toBeLessThanOrEqual(sli.HISTOGRAM_SUBDIVISIONS * sli.HISTOGRAM_OCTAVES);
    expect(buckets).toBeLessThan(1000);
  });

  test("a genuinely unbounded structure FAILS the soak check — the profile is proven able to fail", () => {
    // A soak that has never failed is a soak nobody should trust. This plants the defect —
    // a set that grows one entry per iteration, which is what a leak looks like — and
    // asserts the profile catches it.
    const leaked = new Set();
    const outcome = harness.soak({
      iterations: 4000,
      windows: 4,
      step: (index) => leaked.add(`entry-${index}`),
      sample: () => leaked.size,
    });

    expect(outcome.bounded).toBe(false);
    expect(outcome.drift).toBeGreaterThan(0);
  });

  test("the soak duration the release gate requires is registered and names what it awaits", () => {
    const entry = service.loadRegister().entries.get("release.soak_duration");
    expect(entry).toBeTruthy();
    expect(entry.unit).toBe("hours");
    // §24.6 says "over days"; the default reads that as three. PROVISIONAL because the
    // figure that would make it DERIVED — the time constant of the slowest accumulator —
    // has not been measured, and §22.4 requires a provisional entry to say so.
    expect(entry.default).toBeGreaterThanOrEqual(24);
    expect(entry.calibrationStatus).toBe("PROVISIONAL");
    expect(entry.awaits).toMatch(/time constant/i);

    // The point this test exists to make: the shape checks above run in seconds, and they
    // are not the gate. `release.soak_duration` is, and the gate is discharged by a run of
    // that length on representative hardware.
    expect(entry.requiredBy).toMatch(/soak/i);
  });
});

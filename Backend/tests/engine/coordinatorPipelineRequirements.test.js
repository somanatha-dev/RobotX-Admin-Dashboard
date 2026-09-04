"use strict";

/**
 * V1 / E-7 — the coordinator's solve-path contract, and the refusal that measures it.
 *
 * ── What this replaces ─────────────────────────────────────────────────────
 * `leaderWorkers.COMPOSERS.coordinator()` took no argument and returned a fixed object. It
 * was an **unconditional** refusal: supplying a routing engine, a region and every
 * calibrated value would not have changed its answer by one character, because it never
 * looked at the context it was handed. A refusal that cannot be satisfied is a constant,
 * not a dependency check, and it hid a real distinction — that some of what the coordinator
 * lacks is an external decision and some of it is code nobody has written.
 *
 * ── Why the classes are asserted and the count is not ──────────────────────
 * "Twelve things are missing" is not actionable and it rots the moment one is supplied.
 * **Which class each input is in** is the durable fact, because it says who can close it:
 *
 *   · `EXTERNAL_ROUTING`    — the project owner, on B1's decisions
 *   · `REGISTER_UNRESOLVED` — §22.4's calibration owner; `null` by declaration, and §22.3
 *                             forbids an automated process from choosing the value
 *   · `NO_PRODUCER`         — nobody's withheld decision: missing code against a data
 *                             source nobody has named
 *   · `PROCESS_DEPENDENCY`  — the composition root, at promotion
 *   · `ADMISSIBILITY`       — §6.4's Ω correction, resolved or not
 *
 * The two hand-audits this probe replaces both reported a flat list, and both were wrong in
 * the same direction: they stopped at the routing seam and missed the three `NO_PRODUCER`
 * families entirely. So the tests below assert **that every class is represented and
 * correctly assigned**, and that the probe is genuinely conditional — never that the total
 * is twelve.
 */

const pipeline = require("../../src/workers/coordinatorPipeline");
const leaderWorkers = require("../../src/workers/leaderWorkers");
const service = require("../../src/engine/config/service");

/**
 * A context in which every declared input resolves. Used only to prove conditionality.
 *
 * The snapshot is the **real** `defaultSnapshot()` with the three `UNCALIBRATED` entries
 * overridden in this object alone — not a hand-built stub, because `omega.combinedCorrection`
 * reads more of a snapshot than `resolve()`, and a stub that satisfied the probe while a real
 * snapshot would not is exactly the false green this suite exists to prevent.
 *
 * **The three numbers below are test fixtures and nothing else.** They are not proposals,
 * they are not written to the register, and §22.3 reserves those values for the calibration
 * owner. Any three resolvable values would do; these are merely finite and positive.
 */
function completeContext() {
  const real = service.defaultSnapshot();
  const overrides = {
    "candidate.max_radius_by_sla_class": 2500,
    "plan.service_time_prior": 90,
    "energy.model_residual_cv": 0.15,
  };
  return {
    snapshot: Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      resolve: (name, context, options) =>
        Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : real.resolve(name, context, options),
    }),
    route: async () => ({
      distanceM: 100,
      travelSeconds: 60,
      travelSdSeconds: 6,
      climbM: 3,
      descentM: 1,
      stopStartCycles: 2,
    }),
    travelTimeSpread: { source: "declared-for-this-test" },
    speedMetresPerSecondFor: () => 2.5,
    hopTerrainSource: { source: "declared-for-this-test" },
    environmentFor: () => ({ ambientC: 20, packC: 25 }),
    vehicleMassKgFor: () => 80,
    prisma: {},
    kv: {},
    commit: async () => ({ committed: true }),
    // `omega.combinedCorrection` reads the snapshot; the stub above resolves every name,
    // which is enough for it to succeed.
  };
}

describe("the coordinator's solve-path contract is enumerated, not narrated", () => {
  test("every requirement declares an id, a class, an owner, a reason and a probe", () => {
    expect(pipeline.REQUIREMENTS.length).toBeGreaterThan(0);
    for (const entry of pipeline.REQUIREMENTS) {
      expect({
        id: entry.id,
        complete:
          typeof entry.id === "string" &&
          entry.id.length > 0 &&
          Object.values(pipeline.REQUIREMENT_CLASS).includes(entry.class) &&
          typeof entry.owner === "string" &&
          entry.owner.length > 0 &&
          typeof entry.why === "string" &&
          entry.why.length > 0 &&
          typeof entry.probe === "function",
      }).toEqual({ id: entry.id, complete: true });
    }
  });

  test("ids are unique, and REQUIREMENT_IDS is the whole list in declaration order", () => {
    expect(pipeline.REQUIREMENT_IDS).toEqual(pipeline.REQUIREMENTS.map((entry) => entry.id));
    expect(new Set(pipeline.REQUIREMENT_IDS).size).toBe(pipeline.REQUIREMENT_IDS.length);
  });

  test("`UNCOMPOSABLE.coordinator.requires` is DERIVED from the contract, not restated", () => {
    // The declarative table a build gate reads and the probe a promotion runs must not be
    // able to disagree about what the coordinator needs. They used to be independent: the
    // table listed three collaborators and the composer inspected nothing.
    expect(leaderWorkers.UNCOMPOSABLE.coordinator.requires).toBe(pipeline.REQUIREMENT_IDS);
  });
});

describe("the probe is conditional — the old refusal was not", () => {
  test("an empty context resolves nothing and reports every input as missing", () => {
    const contract = pipeline.requirements({});
    expect(contract.ok).toBe(false);
    expect(contract.missing.map((row) => row.input).sort()).toEqual([...pipeline.REQUIREMENT_IDS].sort());
    expect(contract.satisfied).toEqual([]);
  });

  test("a complete context satisfies every declared input", () => {
    // The assertion the unconditional refusal could not have passed at any price. It does
    // NOT mean the coordinator can start — see the composer test below.
    const contract = pipeline.requirements(completeContext());
    expect(contract.missing).toEqual([]);
    expect(contract.ok).toBe(true);
    expect(contract.satisfied.length).toBe(pipeline.REQUIREMENT_IDS.length);
  });

  test("supplying ONE input moves exactly that input, and nothing else", () => {
    const before = pipeline.requirements({});
    const after = pipeline.requirements({ route: async () => ({}) });

    expect(after.satisfied).toEqual(["route"]);
    expect(before.missing.length - after.missing.length).toBe(1);
    expect(after.missing.some((row) => row.input === "route")).toBe(false);
  });

  test("a snapshot whose `resolve` throws leaves the register inputs unsatisfied", () => {
    // The inner guard, in `resolved()`. Note this does NOT reach `requirements()`'s own
    // catch — `resolved()` swallows the throw and returns `undefined`, so the probe returns
    // `false` cleanly. The next test is the one that reaches the outer catch, and the
    // distinction is why they are two tests: a single test here passed against a mutant
    // that made the outer catch fail-OPEN, which is recorded in the V1 document rather than
    // quietly fixed.
    const hostile = {
      snapshot: {
        resolve: () => {
          throw new Error("register read exploded");
        },
      },
    };
    const contract = pipeline.requirements(hostile);
    for (const name of ["candidate.max_radius_by_sla_class", "plan.service_time_prior", "energy.model_residual_cv"]) {
      expect(contract.missing.some((row) => row.input === name)).toBe(true);
    }
  });

  test("a probe that THROWS counts as not satisfied, never as satisfied", () => {
    // The case where assuming presence is worst: a context whose own property access
    // raises. Every probe reads a property off the context, so a throwing Proxy makes all
    // of them throw and exercises `requirements()`'s own catch — the one place where
    // choosing `ok = true` would silently report a fully-satisfied contract for a context
    // that answers nothing.
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("context access exploded");
        },
        has() {
          throw new Error("context access exploded");
        },
      },
    );

    const contract = pipeline.requirements(hostile);
    expect(contract.ok).toBe(false);
    expect(contract.satisfied).toEqual([]);
    expect(contract.missing.length).toBe(pipeline.REQUIREMENT_IDS.length);
  });
});

describe("the classes are the actionable part, and they are assigned correctly", () => {
  const byId = new Map(pipeline.REQUIREMENTS.map((entry) => [entry.id, entry]));

  test("all five classes are represented — the prior hand-audits saw only two", () => {
    const classes = new Set(pipeline.REQUIREMENTS.map((entry) => entry.class));
    for (const declared of Object.values(pipeline.REQUIREMENT_CLASS)) {
      expect({ class: declared, represented: classes.has(declared) }).toEqual({ class: declared, represented: true });
    }
  });

  test("the three register entries are REGISTER_UNRESOLVED, and are genuinely null in the register", () => {
    // Both halves matter. The classification is a claim about the register, so it is checked
    // against the register rather than asserted: if one of these is ever derived, this test
    // fails and the row must move class rather than quietly staying in a stale list.
    const snapshot = service.defaultSnapshot();
    for (const name of ["candidate.max_radius_by_sla_class", "plan.service_time_prior", "energy.model_residual_cv"]) {
      expect(byId.get(name).class).toBe(pipeline.REQUIREMENT_CLASS.REGISTER_UNRESOLVED);
      expect({ name, entryExists: snapshot.entries.has(name) }).toEqual({ name, entryExists: true });
      expect({ name, resolves: snapshot.resolve(name, { sla_class: null }) }).toEqual({ name, resolves: null });
    }
  });

  test("the two no-producer families are NO_PRODUCER, and are not owned by a decision-maker", () => {
    // The distinction the flat list destroyed: these are not waiting on anyone's decision.
    // Calling them "blocked on B1" would send the owner looking for a decision to make.
    for (const name of ["environment.ambientC / packC", "masses.vehicleMassKg"]) {
      expect(byId.get(name).class).toBe(pipeline.REQUIREMENT_CLASS.NO_PRODUCER);
      expect(byId.get(name).owner).toMatch(/Engineering/);
    }
  });

  /**
   * E-8 — terrain was a third `NO_PRODUCER` family called `terrainByStop`, and that was the
   * wrong class. §14.2 states climb, regeneration and stop-start **over the traversal**, so
   * the routing seam is its producer; the seam simply was not carrying it. The row is
   * `EXTERNAL_ROUTING` now, and its owner is the traversal source, not Engineering.
   */
  test("hop terrain is EXTERNAL_ROUTING — it has a producer, and the producer is the router", () => {
    const row = byId.get("hop terrain (climbM / descentM / stopStartCycles)");
    expect(row.class).toBe(pipeline.REQUIREMENT_CLASS.EXTERNAL_ROUTING);
    expect(row.owner).toMatch(/traversal source/);
    expect(byId.has("terrainByStop")).toBe(false);
    // Every routing row is one contract: the `route` entry names all six fields it returns.
    expect(byId.get("route").why).toMatch(/climbM, descentM, stopStartCycles/);
  });

  test("the Ω correction is checked rather than assumed, and fails closed without a snapshot", () => {
    // §6.4: a bound that omits a negative term is larger than the true cost, not smaller,
    // so pruning would discard cells containing the true optimum while the decision record
    // advertised a proven guarantee. `phase9ProductionPath.js` exists because this once
    // silently did not resolve.
    const omegaRow = byId.get("Ω correction (candidates/omega.combinedCorrection)");
    expect(omegaRow.class).toBe(pipeline.REQUIREMENT_CLASS.ADMISSIBILITY);
    expect(omegaRow.probe({})).toBe(false);
    expect(omegaRow.probe({ snapshot: service.defaultSnapshot() })).toBe(true);
  });
});

describe("COMPOSERS.coordinator refuses with the measured list, and still refuses when it is empty", () => {
  test("with nothing supplied it refuses EXTERNAL, and names what is missing by class", () => {
    const outcome = leaderWorkers.COMPOSERS.coordinator({});

    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe("EXTERNAL_DEPENDENCY_UNAVAILABLE");
    expect(outcome.external).toBe(true);
    expect(outcome.missing.length).toBe(pipeline.REQUIREMENT_IDS.length);
    // The blocker sentence carries the measurement, not only the standing paragraph.
    expect(outcome.blockedBy).toMatch(/MEASURED against this context/);
    expect(outcome.blockedBy).toMatch(/EXTERNAL_ROUTING/);
    expect(outcome.blockedBy).toMatch(/NO_PRODUCER/);
  });

  test("called with NO argument at all it still refuses, rather than throwing", () => {
    // `startAll()` passes the composition context; a composer that threw on an odd context
    // would become a `PROCESS_DEPENDENCY_MISSING` refusal and lose its own diagnosis.
    const outcome = leaderWorkers.COMPOSERS.coordinator();
    expect(outcome.ok).toBe(false);
    expect(outcome.missing.length).toBe(pipeline.REQUIREMENT_IDS.length);
  });

  test("with EVERY input supplied it STILL refuses — and the refusal changes owner", () => {
    // The most important assertion here. A satisfied requirements list is not a started
    // worker: the assembly itself is deliberately unwritten, because with the real inputs
    // absent it would be exercised only by an injected context — *written, tested, and
    // never called*. What changes is the honest attribution: the last obstacle stops being
    // external and becomes this repository's.
    const outcome = leaderWorkers.COMPOSERS.coordinator(completeContext());

    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe(leaderWorkers.REFUSAL.COLLABORATOR_NOT_IMPLEMENTED);
    expect(outcome.external).toBe(false);
    expect(outcome.missing).toEqual([]);
    expect(outcome.blockedBy).toMatch(/assembly itself is still not written/);
    expect(outcome.blockedBy).toMatch(/repository-owned gap rather than an external one/);
  });

  test("the build gate's declarative row is unchanged — gate:composition stays RED", () => {
    // `tools/gates/checkCompositionRoot.js` reads `UNCOMPOSABLE` without constructing a
    // process context. Making the composer conditional must not make the gate conditional:
    // the row is removed when the worker actually starts, which is the rule that table sets
    // for itself.
    expect(leaderWorkers.UNCOMPOSABLE.coordinator).toBeDefined();
    expect(leaderWorkers.UNCOMPOSABLE.coordinator.external).toBe(true);
  });
});

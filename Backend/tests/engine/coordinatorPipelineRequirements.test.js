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
const fs = require("fs");
const path = require("path");

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
  // Every register name the contract declares, given *some* resolvable value so that the
  // probe's conditionality can be exercised. Built from the contract rather than typed out,
  // so a row added to `SOLVE_PATH_REGISTER_INPUTS` cannot leave this fixture silently
  // short and turn a real regression into "one more thing was already missing".
  const overrides = { "candidate.max_radius_by_sla_class": 2500 };
  for (const entry of pipeline.SOLVE_PATH_REGISTER_INPUTS) overrides[entry.name] = 1;
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
    timeBucket: "declared-for-this-test",
    environmentFor: () => ({ ambientC: 20, packC: 25 }),
    vehicleMassKgFor: () => 80,
    failureProbabilityFor: () => ({ probability: 0.01, provenance: "declared-for-this-test" }),
    routeHazardCuFor: () => 0,
    batteryWearInputsFor: () => ({}),
    // §14.5's return-leg Wh per metre. Declared for this test only: no register entry and
    // no schema column carries it, and `chargerReachabilityCache.buildEntry` asks its
    // caller for it — see the requirement's own `why`.
    returnLegEnergyWhPerMetreFor: () => 0.05,
    prisma: {},
    kv: {},
    // V1 composition — `commit` is no longer injected. The assembly builds it from these
    // three, because `createVolatileRecheck`'s `buildContext` adapter now exists.
    runSerializable: async (client, fn) => fn(client),
    selectForUpdate: async () => null,
    signingKey: "declared-for-this-test",
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

  /**
   * The gate's own refusal sentence said **four** no-producer families and named four, while
   * the contract had carried **six** since §N.2 added the return-leg rate. A published count
   * that has gone stale against the list standing beside it is this project's most-repeated
   * defect, and `UNCOMPOSABLE.coordinator.blocker` is read by an operator and printed by
   * `gate:composition` — so it is a false claim published by code, not by prose.
   *
   * The count is asserted **against the contract**, not restated, so the sentence cannot
   * drift from the list again without this failing.
   */
  test("the composition refusal's no-producer count matches the contract it describes", () => {
    const families = pipeline.REQUIREMENTS.filter(
      (row) => row.class === pipeline.REQUIREMENT_CLASS.NO_PRODUCER,
    ).map((row) => row.id);
    expect(families.length).toBe(6);

    const blocker = leaderWorkers.UNCOMPOSABLE.coordinator.blockedBy;
    expect(blocker).toMatch(/\*\*six\*\* input families/);
    expect(blocker).not.toMatch(/\*\*four\*\* input families/);
    // Every family the contract declares is named, not just the ones that fit the sentence.
    expect(blocker).toMatch(/environment\.ambientC/);
    expect(blocker).toMatch(/masses\.vehicleMassKg/);
    expect(blocker).toMatch(/p_fail/);
    expect(blocker).toMatch(/route_hazard_cost/);
    expect(blocker).toMatch(/return-leg Wh\/metre/);
    expect(blocker).toMatch(/battery wear inputs/);
  });

  /**
   * W-A5. The same sentence claimed all six families have **no schema column**. That is
   * false of one: `EnergyModelParams.stressCurves` declares §14.4's vendor curves, and the
   * agent-snapshot loader already put the row on the snapshot — the seam that priced wear
   * named `EnergyModel`, a different table, and never looked.
   *
   * The row stays declared because its **mission** half genuinely has no column. This test
   * pins both halves of that: the claim is gone, and the requirement is not.
   */
  test("the refusal no longer claims §14.4's vendor curves have no column — and the row still stands", () => {
    const blocker = leaderWorkers.UNCOMPOSABLE.coordinator.blockedBy;
    expect(blocker).not.toMatch(/six\*\* input families with \*\*no schema column/);
    expect(blocker).toMatch(/EnergyModelParams\.stressCurves/);
    expect(blocker).toMatch(/mission\*\* half/);

    // The load-bearing negative: reading one column satisfied nothing.
    expect(pipeline.REQUIREMENT_IDS).toContain("battery wear inputs (§14.4)");
    const row = byId.get("battery wear inputs (§14.4)");
    expect(row.class).toBe(pipeline.REQUIREMENT_CLASS.NO_PRODUCER);
    expect(row.probe({})).toBe(false);
    expect(row.why).toMatch(/EnergyModelParams\.stressCurves/);
    expect(row.why).toMatch(/SoC throughput/);
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

  /**
   * SUPERSEDED, and the supersession is the finding — V1 composition, 2026-09-04.
   *
   * This test asserted `COLLABORATOR_NOT_IMPLEMENTED`: *"a satisfied requirements list is
   * not a started worker, because the assembly itself is deliberately unwritten."* That was
   * a true statement about the tree on 2026-09-01 and it is false now — the assembly is
   * `workers/coordinatorSolvePath.js`, and with every declared input satisfied the composer
   * **starts the coordinator**.
   *
   * The assertion is replaced rather than deleted, and what it asserts is the same property
   * one state along: the composer's answer is a *function of its context*, and the only
   * thing between this repository and a running coordinator is now the context.
   */
  test("with EVERY input supplied it composes — the assembly exists and is reached", () => {
    const outcome = leaderWorkers.COMPOSERS.coordinator(completeContext());

    expect(outcome.ok).toBe(true);
    expect(outcome.missing).toBeUndefined();
    expect(typeof outcome.handle.stop).toBe("function");
    // Stopped immediately: this test proves the composition, never that a round ran. There
    // is no database behind that context and no claim is made that one executed.
    outcome.handle.stop();
  });

  test("and on the real register it does NOT compose — no context here can", () => {
    // The other half, and the one that must never quietly flip. `completeContext()`
    // overrides fifteen register entries **in that object alone**; the published register
    // resolves none of them, and no routing source exists at all.
    const outcome = leaderWorkers.COMPOSERS.coordinator({
      snapshot: service.defaultSnapshot(),
      prisma: {},
      kv: {},
      runSerializable: async () => null,
      selectForUpdate: async () => null,
      signingKey: "k",
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toBe(leaderWorkers.REFUSAL.EXTERNAL_DEPENDENCY_UNAVAILABLE);
    expect(outcome.missing.map((row) => row.input)).toEqual(expect.arrayContaining(["route"]));
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

/**
 * E-8b — the composition root's own half of the contract.
 *
 * E-7's table recorded the process dependencies as *"`prisma`, `kv`, `commit` — supplied at
 * promotion"*, and its admissibility row as *"**0 missing** — the Ω correction resolves on
 * the current register"*. Measured against the context `server.js` actually built, both were
 * wrong. `leaderWorkers.create()` was handed `values` — the resolved parameter **map** — and
 * never the **snapshot**, so `snapshot` measured as an unsatisfied PROCESS_DEPENDENCY on an
 * object this process has had all along, and the Ω probe, whose only input is that snapshot,
 * could not resolve either. A real promotion left **twelve** inputs missing, not nine.
 *
 * The map is not a substitute: `resolve(name, { sla_class })` is scope-aware and a flat map
 * cannot answer a per-SLA-class question, which is exactly what
 * `candidate.max_radius_by_sla_class` is.
 */
describe("E-8b — the snapshot the composition root already had", () => {
  const promotionContext = (overrides) => ({
    prisma: {},
    kv: {},
    shardId: "shard-1",
    regionId: "region-1",
    ...(overrides || {}),
  });

  test("an accessor is resolved, so a promotion composes against the version in force", () => {
    const app = { locals: { config: service.defaultSnapshot() } };
    const resolvedSnapshot = pipeline.snapshotFrom({ snapshot: () => app.locals.config });

    expect(resolvedSnapshot).toBe(app.locals.config);
    // P15-R2's property: replacing the snapshot is seen by the next read, not frozen at boot.
    const replacement = service.defaultSnapshot();
    app.locals.config = replacement;
    expect(pipeline.snapshotFrom({ snapshot: () => app.locals.config })).toBe(replacement);
  });

  test("a plain snapshot is still accepted, because that is what every test passes", () => {
    const snapshot = service.defaultSnapshot();
    expect(pipeline.snapshotFrom({ snapshot })).toBe(snapshot);
  });

  test("an accessor that throws is not satisfied — it fails closed, like every other probe", () => {
    const context = promotionContext({
      snapshot: () => {
        throw new Error("the configuration pull loop has not populated app.locals yet");
      },
    });

    expect(pipeline.snapshotFrom(context)).toBeUndefined();
    const missing = pipeline.requirements(context).missing.map((row) => row.input);
    expect(missing).toContain("snapshot");
    expect(missing).toContain("Ω correction (candidates/omega.combinedCorrection)");
  });

  test("without the snapshot, `snapshot` and Ω are BOTH unsatisfied — one cause, two rows", () => {
    const result = pipeline.requirements(promotionContext());

    // `prisma` and `kv` are the only two this context supplies. The counts this test used
    // to pin — twelve missing, then ten with the snapshot — were correct on 2026-09-04
    // against a fourteen-row contract; the V1 composition raised the contract to
    // thirty-three by walking past `planBuilder` into `cost/phi.evaluate`. The **property**
    // E-8b found is what is pinned here instead, because it is the part that can regress:
    // Ω's only input is the snapshot, so the two rows move together and always have.
    expect(result.satisfied).toEqual(["prisma", "kv"]);
    expect(result.missing.map((row) => row.input)).toEqual(
      expect.arrayContaining(["snapshot", "Ω correction (candidates/omega.combinedCorrection)"]),
    );
  });

  test("with it, both close together — and the remainder is external, calibration, or absent", () => {
    const app = { locals: { config: service.defaultSnapshot() } };
    const before = pipeline.requirements(promotionContext());
    const result = pipeline.requirements(promotionContext({ snapshot: () => app.locals.config }));

    expect(result.satisfied).toEqual(
      expect.arrayContaining(["snapshot", "Ω correction (candidates/omega.combinedCorrection)"]),
    );
    // Exactly two rows move — `snapshot` and the Ω check whose only input it is. Supplying
    // one object closes both, which is E-8b's finding stated as an arithmetic property
    // rather than as a count that ages.
    expect(before.missing.length - result.missing.length).toBe(2);

    // `commit` is gone from `PROCESS_DEPENDENCY` — the assembly builds it now rather than
    // requiring it — and what remains there is the three seams the assembly genuinely
    // cannot build for itself. `server.js` supplies all three; this fixture does not, and
    // that is what makes them visible here.
    const processDependencies = result.missing
      .filter((row) => row.class === pipeline.REQUIREMENT_CLASS.PROCESS_DEPENDENCY)
      .map((row) => row.input)
      .sort();
    expect(processDependencies).toEqual(["runSerializable", "selectForUpdate", "signingKey"]);
    expect(result.missing.map((row) => row.input)).not.toContain("commit");
  });

  test("the production composition root passes the snapshot as an accessor", () => {
    // A source pin, in this suite's own idiom: the wiring is in `server.js`, which no unit
    // test boots. Phase 15's repeated finding is that a producer can exist and the
    // composition root simply not use it, and that is invisible to every test of the
    // producer.
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
    expect(source).toMatch(/leaderWorkers\.create\(\{/u);
    expect(source).toMatch(/snapshot:\s*\(\)\s*=>\s*app\.locals\.config,/u);
  });
});

"use strict";

/**
 * Engine lane — Phase 0 scaffolding and guardrails.
 *
 * Phase 0 changes no runtime behaviour. What it must guarantee is that the
 * structures every later phase depends on exist, are complete, and are wired: the
 * module tree, the master switch, the component map, and the decision log.
 */

const fs = require("fs");
const path = require("path");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const REPO_ROOT = path.join(BACKEND_ROOT, "..");
const ENGINE_ROOT = path.join(BACKEND_ROOT, "src", "engine");
const ADR_ROOT = path.join(REPO_ROOT, "docs", "adr");

const readEngineDoc = (name) => fs.readFileSync(path.join(ENGINE_ROOT, name), "utf8");

describe("the ENGINE_ENABLED master switch", () => {
  test("is off in the test environment", () => {
    expect(process.env.ENGINE_ENABLED).toBe("false");
  });

  test("is declared off in every environment file the plan names", () => {
    for (const file of [".env", ".env.benchmark"]) {
      const contents = fs.readFileSync(path.join(BACKEND_ROOT, file), "utf8");
      expect(contents).toMatch(/^ENGINE_ENABLED=false$/m);
    }
  });
});

describe("the engine module tree", () => {
  // One directory per component group of the execution plan's §2 capability
  // inventory. A later phase that needs a location must find it already decided.
  const REQUIRED_DIRECTORIES = [
    "candidates",
    "commitment",
    "config",
    "config/register",
    "cost",
    "degraded",
    "deps",
    "determinism",
    "dispatch",
    "domain",
    "domain/mappers",
    "energy",
    "failure",
    "fairness",
    "feasibility",
    "feasibility/predicates",
    "guards",
    "intake",
    "lifecycle",
    "map",
    "observability",
    "payload",
    "plan",
    "pricing",
    "privacy",
    "reliability",
    "routing",
    "security",
    "shard",
    "solve",
    "spatial",
    "stores",
    "supervision",
  ];

  test.each(REQUIRED_DIRECTORIES)("src/engine/%s exists", (directory) => {
    expect(fs.statSync(path.join(ENGINE_ROOT, directory)).isDirectory()).toBe(true);
  });

  test("the workers directory exists", () => {
    expect(fs.statSync(path.join(BACKEND_ROOT, "src", "workers")).isDirectory()).toBe(true);
  });

  // Phase 0 asserted the engine held *no* runtime code. Each landed phase widens
  // the assertion by exactly what it owns, rather than removing it. A module
  // appearing under `commitment/`, `feasibility/`, `dispatch/` or anywhere else
  // still fails this test, which is the property worth keeping — a later phase's
  // work leaking into an earlier one is caught mechanically rather than in review.
  //
  // Phase 2's additions are the §2 domain model, its legacy mappers, and the §3.6
  // spatial hierarchy. Phase 3's are the §10 commitment core and the minimal §19.5
  // leadership record guard G1 reads. Phase 4's are the §11 dispatch surface and the
  // §23.3 command envelope. Phase 5's are §4.5's durable timers, §12's supervision and
  // reconciliation, and the §4.2/§4.3/§4.4 lifecycle. Everything else remains forbidden
  // — a module under `feasibility/`, `solve/`, or `cost/` beyond Phase 1's two files
  // still fails this test.
  const PHASE_1_OWNED = [
    "config/",
    "cost/units.js",
    "cost/exchangeRates.js",
    "determinism/",
  ];

  const PHASE_2_OWNED = [
    "domain/",
    "spatial/",
  ];

  const PHASE_3_OWNED = [
    "commitment/",
    "shard/leadership.js",
  ];

  const PHASE_4_OWNED = [
    "dispatch/",
    "security/commandSigning.js",
  ];

  // `lifecycle/` is named file-by-file rather than as a directory, for the same reason
  // `shard/`, `security/` and `cutover/` are: §17.3's repositioning and §4.6's preemption are
  // Phase 16's, and both would land in this folder. A directory prefix here would stop this
  // walk catching `lifecycle/preemption.js`, which is precisely the module the boundary
  // exists to refuse.
  const PHASE_5_OWNED = [
    "supervision/",
    "lifecycle/legMachine.js",
    "lifecycle/taskMachine.js",
    "lifecycle/transitions.js",
    "lifecycle/settlement.js",
    "lifecycle/cancellation.js",
    "lifecycle/reassignment.js",
  ];

  // Phase 6's additions are §7's feasibility gate in full: the 38-predicate register,
  // three-valued evaluation, the systemic-indeterminacy guard, the three-tier cache,
  // the §10.3.2 volatile subset, and §7.7's rejection telemetry.
  const PHASE_6_OWNED = [
    "feasibility/",
  ];

  // Phase 7's additions are §14's energy model and §15's payload model, plus the one
  // routing artefact §20.3 item 3 makes a Tier 0 input — the charger-reachability cache.
  // `routing/` is named file-by-file rather than as a directory: the rest of it is
  // Phase 8's and Phase 9's, and a directory prefix here would stop catching their work
  // leaking backwards. `plan/`, `solve/`, `pricing/`, and `cost/` beyond Phase 1's two
  // files remain forbidden.
  const PHASE_7_OWNED = [
    "energy/",
    "payload/",
    "routing/chargerReachabilityCache.js",
  ];

  // Phase 8's additions are §8's cost function in full, §13's Plan Builder, the §8.3
  // pricing clients, and §20.3 item 2's cell-pair travel-time cache. `cost/` opens up
  // beyond Phase 1's two files, and `plan/` and `pricing/` open for the first time.
  // `candidates/` and `solve/` remain forbidden: they are Phase 9's and Phase 10's, and
  // this list is what stops their work leaking backwards.
  const PHASE_8_OWNED = [
    "cost/",
    "plan/",
    "pricing/",
    "routing/cellPairCache.js",
  ];

  // Phase 9's additions are §6's candidate generation in full: the Availability
  // Index, hierarchical expansion, the admissible lower bound and its Ω
  // corrections, canonical ordering, cell-cluster sharing, and the admissibility
  // build gate. `solve/` remains forbidden — it is Phase 10's, and this list is
  // what stops that work leaking backwards.
  const PHASE_9_OWNED = [
    "candidates/",
  ];

  // Phase 10's additions are §9's round loop and solve in full — the adaptive cadence,
  // the regime and its guarantees, the five §9.4 budgets with anytime behaviour, the
  // set-partitioning objective with its deferral variable, the singleton-regime min-cost
  // flow, and the round itself — plus §3.4's intake path and §2.6's round-local plan
  // state. `observability/`, `degraded/`, `failure/`, and `fairness/` remain forbidden:
  // they are Phase 11's and Phase 12's, and this list is what stops their work leaking
  // backwards.
  //
  // `solve/` is named file-by-file rather than as a directory, for the same reason `shard/`,
  // `security/`, `cutover/` and `lifecycle/` are. §9.3's column-regime branch-and-bound, set
  // partitioning and local search are all Phase 16's and all of them would land in this
  // folder; a directory prefix would let `solve/setPartitioning.js`, `solve/branchAndBound.js`
  // or `solve/localSearch.js` appear here unremarked. That risk is highest exactly while
  // Phase 10 is re-opened for §20.2 conformance work, which is when this list is the only
  // mechanical thing standing between the two phases.
  const PHASE_10_OWNED = [
    "intake/",
    "solve/budgets.js",
    "solve/cadence.js",
    "solve/costScaling.js",
    "solve/minCostFlow.js",
    "solve/objective.js",
    "solve/regime.js",
    "solve/round.js",
    "shard/planState.js",
  ];

  // Phase 11's additions are §21's observability surface in full: the two-tier decision
  // record with its deterministic sampler and bounded exemption list, the §21.3
  // Explanation API's answers, the §21.4 metric set, §20.1's SLI targets, §21.5's
  // calibration loop, §21.6's shadow mode, and §21.7's hash-chained audit stream.
  // `degraded/`, `failure/`, `map/`, and `fairness/` remain forbidden — they are Phase
  // 12's, and this list is what stops their work leaking backwards.
  const PHASE_11_OWNED = [
    "observability/",
  ];

  // Phase 12's additions are §18's and §26's: the six named degraded modes with their
  // entry and exit events and their §26.2 matrix, the agent and infrastructure failure
  // catalogues, obstruction classification, §18.6's external escalation chain, and the
  // Invariant Checker. `fairness/` remains forbidden — §17.4's ladder is its own phase's,
  // and this list is what stops that work leaking backwards.
  const PHASE_12_OWNED = [
    "degraded/",
    "failure/",
    "map/",
  ];

  // Phase 13's additions are §3.5's and §19's: the shard model and its region→shard map,
  // leader election over a consensus store, failover's recover-and-reconstruct, the two
  // sizing bounds, the transactional membership handoff, and §19.6's cross-region saga.
  // `shard/` is named file-by-file rather than as a directory: `leadership.js` is Phase
  // 3's and `planState.js` is Phase 10's, and a directory prefix here would stop this
  // walk catching a later phase's work leaking into the same folder.
  const PHASE_13_OWNED = [
    "shard/shardModel.js",
    "shard/election.js",
    "shard/failover.js",
    "shard/sizing.js",
    "shard/membership.js",
    "shard/crossRegion.js",
  ];

  // Phase 14's additions are §23's: the certificate-bound session, capability attestation,
  // the six trust-boundary rows, the override discipline, and the privacy separation.
  // `security/` is named file-by-file for the same reason `shard/` is —
  // `commandSigning.js` is Phase 4's, and a directory prefix would stop this walk catching
  // a Phase 15 module dropped into the same folder. `fairness/` remains forbidden: §17.4's
  // ladder is its own phase's, and this list is what stops that work leaking backwards.
  const PHASE_14_OWNED = [
    "security/sessionBinding.js",
    "security/attestation.js",
    "security/trustBoundaries.js",
    "security/override.js",
    "privacy/surrogateKeys.js",
    "privacy/identityStore.js",
    "privacy/erasure.js",
  ];

  // Phase 15 ships no new *capability* — "No new capability ships in this phase" — but it
  // does ship the cutover machinery itself, which has to live somewhere. `cutover/` is
  // named file-by-file for the same reason `security/` is: a directory prefix would stop
  // this walk catching a Phase 16 module dropped into the same folder. `fairness/` remains
  // forbidden, because §17.4's ladder and §17.3's repositioning are Phase 16's.
  //
  // `routing/inProcessCache.js` is the one exception to "no new capability", and it is
  // named here rather than under Phase 8 deliberately. It is a **B1 prerequisite**, not a
  // Phase 8 deliverable: §20.1 budgets a cached return-leg lookup at < 10 µs and
  // `PHASE_15_B1_ROUTING_DECISION_REPORT.md` §7.1 measured loopback Redis `GET` at
  // p50 304 µs / p99 1 156 µs, so the lookup tier is unbuildable-as-specified independently
  // of which engine B1 selects. It ships no capability — it issues no query, holds no
  // adapter, and implements no part of §5.2's degradation ladder. Phase 8's `client.js`
  // remains absent and remains Phase 8's.
  const PHASE_15_OWNED = [
    "cutover/enabled.js",
    "cutover/gates.js",
    "cutover/guardrails.js",
    "cutover/stage.js",
    "cutover/store.js",
    "routing/inProcessCache.js",
  ];

  const LANDED_PHASE_OWNED = [
    ...PHASE_1_OWNED,
    ...PHASE_2_OWNED,
    ...PHASE_3_OWNED,
    ...PHASE_4_OWNED,
    ...PHASE_5_OWNED,
    ...PHASE_6_OWNED,
    ...PHASE_7_OWNED,
    ...PHASE_8_OWNED,
    ...PHASE_9_OWNED,
    ...PHASE_10_OWNED,
    ...PHASE_11_OWNED,
    ...PHASE_12_OWNED,
    ...PHASE_13_OWNED,
    ...PHASE_14_OWNED,
    ...PHASE_15_OWNED,
  ];

  /**
   * The ownership predicate itself, lifted out of the walk so that the same rule the walk
   * applies to the real tree can be applied to a planted module list below. A guard whose
   * rejection half is never exercised is a guard nobody has seen work.
   */
  const unownedAmong = (modules) =>
    modules.filter(
      (module) => !LANDED_PHASE_OWNED.some((owned) => module === owned || module.startsWith(owned)),
    );

  test("holds runtime code only where a landed phase owns it", () => {
    const runtimeModules = [];
    const walk = (absolute, relative) => {
      for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(absolute, entry.name), childRelative);
        else if (entry.name.endsWith(".js") && !childRelative.startsWith("guards/")) {
          runtimeModules.push(childRelative);
        }
      }
    };
    walk(ENGINE_ROOT, "");
    expect(unownedAmong(runtimeModules)).toEqual([]);
  });

  test("every Phase 10 solve module and Phase 5 lifecycle module on disk is still owned", () => {
    // The other half of the file-by-file change: converting a directory prefix into a list is
    // only safe if the list is complete. This asserts it against the filesystem, so a
    // legitimate Phase 10 or Phase 5 file can never be locked out by an omission here — the
    // walk above would report it, and this test says which list is short.
    for (const directory of ["solve", "lifecycle"]) {
      const onDisk = fs
        .readdirSync(path.join(ENGINE_ROOT, directory))
        .filter((name) => name.endsWith(".js"))
        .map((name) => `${directory}/${name}`);
      expect({ directory, unowned: unownedAmong(onDisk) }).toEqual({ directory, unowned: [] });
    }
  });

  test("a Phase 16 module dropped into solve/ or lifecycle/ is refused", () => {
    // `PHASE_15_INDEPENDENT_VERIFICATION.md` Finding 3: while `solve/` and `lifecycle/` were
    // whole-directory grants, the Phase 16 boundary held in those two folders only because the
    // files did not exist — not because this walk would refuse them. It refuses them now, and
    // this is the proof, planted rather than asserted in prose.
    //
    // §17.4's fairness ladder, §4.6's preemption, and §9.3's column-regime mechanisms (set
    // partitioning, branch and bound, local search) are the five named Phase 16 mechanisms
    // that would plausibly land inside a folder an earlier phase already owns.
    const planted = [
      "solve/setPartitioning.js",
      "solve/branchAndBound.js",
      "solve/localSearch.js",
      "lifecycle/preemption.js",
      "fairness/ladder.js",
    ];
    expect(unownedAmong(planted).sort()).toEqual([...planted].sort());

    // Negative control: the rule that refuses those must still admit the real files, or the
    // test above would pass for the wrong reason — a predicate that refuses everything.
    expect(unownedAmong(["solve/costScaling.js", "lifecycle/transitions.js"])).toEqual([]);
  });

  test("Phase 1's own modules are all present", () => {
    for (const module of [
      "config/service.js",
      "config/resolver.js",
      "config/validators.js",
      "config/derived.js",
      "config/calibrationStatus.js",
      "config/killSwitches.js",
      "config/regimes.js",
      "cost/units.js",
      "cost/exchangeRates.js",
      "determinism/fixedPoint.js",
      "determinism/ordering.js",
      "determinism/snapshot.js",
    ]) {
      expect({ module, exists: fs.existsSync(path.join(ENGINE_ROOT, module)) }).toEqual({ module, exists: true });
    }
  });

  test("Phase 2's own modules are all present", () => {
    for (const module of [
      "domain/agent.js",
      "domain/mobilityModel.js",
      "domain/capability.js",
      "domain/work.js",
      "domain/purpose.js",
      "domain/custody.js",
      "domain/observation.js",
      "domain/mappers/legacyRobot.js",
      "domain/mappers/legacyTask.js",
      "spatial/hierarchy.js",
      "spatial/cells.js",
    ]) {
      expect({ module, exists: fs.existsSync(path.join(ENGINE_ROOT, module)) }).toEqual({ module, exists: true });
    }
  });

  test("Phase 2's backfill tool is present", () => {
    expect(fs.existsSync(path.join(BACKEND_ROOT, "tools", "migrate", "backfillDomain.js"))).toBe(true);
  });

  test("Phase 3's own modules are all present", () => {
    for (const module of [
      "commitment/model.js",
      "commitment/fencing.js",
      "commitment/guards.js",
      "commitment/commit.js",
      "commitment/leases.js",
      "commitment/idempotency.js",
      "commitment/clock.js",
      "shard/leadership.js",
    ]) {
      expect({ module, exists: fs.existsSync(path.join(ENGINE_ROOT, module)) }).toEqual({ module, exists: true });
    }
  });

  test("Phase 3's formal model is present", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "formal", "commitment.tla"))).toBe(true);
  });

  test("Phase 4's own modules are all present", () => {
    for (const module of [
      "dispatch/outbox.js",
      "dispatch/sequence.js",
      "dispatch/offers.js",
      "dispatch/escalation.js",
      "dispatch/dedupHandshake.js",
      "security/commandSigning.js",
    ]) {
      expect({ module, exists: fs.existsSync(path.join(ENGINE_ROOT, module)) }).toEqual({ module, exists: true });
    }
  });

  test("Phase 4's worker and socket handler are present", () => {
    expect(fs.existsSync(path.join(BACKEND_ROOT, "src", "workers", "outbox.worker.js"))).toBe(true);
    expect(fs.existsSync(path.join(BACKEND_ROOT, "src", "sockets", "handlers", "offer.handler.js"))).toBe(true);
  });

  test("Phase 5's own modules are all present", () => {
    for (const module of [
      "supervision/timers.js",
      "supervision/leases.js",
      "supervision/progress.js",
      "supervision/reconciler.js",
      "supervision/verification.js",
      "lifecycle/legMachine.js",
      "lifecycle/taskMachine.js",
      "lifecycle/transitions.js",
      "lifecycle/settlement.js",
      "lifecycle/cancellation.js",
      "lifecycle/reassignment.js",
    ]) {
      expect({ module, exists: fs.existsSync(path.join(ENGINE_ROOT, module)) }).toEqual({ module, exists: true });
    }
  });

  test("Phase 5's workers and its operator-visibility route are present", () => {
    expect(fs.existsSync(path.join(BACKEND_ROOT, "src", "workers", "timer.worker.js"))).toBe(true);
    expect(fs.existsSync(path.join(BACKEND_ROOT, "src", "workers", "reconciler.worker.js"))).toBe(true);
    expect(fs.existsSync(path.join(BACKEND_ROOT, "src", "routes", "legs.routes.js"))).toBe(true);
    expect(fs.existsSync(path.join(BACKEND_ROOT, "src", "controllers", "legs.controller.js"))).toBe(true);
  });

  test("no engine worker is started from server.js — Phase 15 owns that", () => {
    // §15's "All engine workers move from shadow to production scheduling". A worker
    // wired into the bootstrap would be an engine write path reachable with
    // ENGINE_ENABLED false, which is the one thing the master switch exists to prevent.
    const server = fs.readFileSync(path.join(BACKEND_ROOT, "server.js"), "utf8");
    expect(server).not.toMatch(/workers\/outbox\.worker/);
    expect(server).not.toMatch(/workers\/timer\.worker/);
    expect(server).not.toMatch(/workers\/reconciler\.worker/);
  });
});

describe("ARCHITECTURE.md", () => {
  const doc = readEngineDoc("ARCHITECTURE.md");

  test("maps every §3.2 component to a module path", () => {
    const COMPONENTS = [
      "Intake API",
      "Work Queue",
      "Assignment Coordinator",
      "Candidate Service",
      "Feasibility Evaluator",
      "Cost Evaluator",
      "Plan Builder",
      "Column Builder",
      "Solver",
      "Commitment Store",
      "Dispatcher",
      "Supervisor",
      "Reconciler",
      "Agent State Service",
      "Routing Service",
      "Forecast Service",
      "Capacity Pricing Service",
      "Reliability Service",
      "Energy Model Service",
      "Config Service",
      "Decision Log",
      "Explanation API",
      "Simulation Harness",
    ];
    for (const component of COMPONENTS) {
      const row = doc.split("\n").find((line) => line.startsWith(`| ${component} |`));
      expect({ component, mapped: Boolean(row) }).toEqual({ component, mapped: true });
      expect({ component, hasModulePath: /`src\/[^`]+`/.test(row) }).toEqual({
        component,
        hasModulePath: true,
      });
    }
  });

  test("states the L1–L4 layering and the exactly-once property of L3", () => {
    for (const layer of ["L4  DECISION LAYER", "L3  COMMITMENT LAYER", "L2  EXECUTION LAYER", "L1  STATE & ESTIMATION LAYER"]) {
      expect(doc).toContain(layer);
    }
    expect(doc).toMatch(/L1 may be lossy and L4 may be repeated, but L3 must be\s*\n?\s*exactly\s*\n?\s*once/);
  });

  test("records the rules the guardrails enforce, each against its gate", () => {
    expect(doc).toContain("tools/gates/checkTierDependencies.js");
    expect(doc).toContain("tools/gates/checkParameterRegister.js");
    expect(doc).toContain("src/engine/guards/tenets.js");
  });

  test("documents the master switch and its default", () => {
    expect(doc).toContain("ENGINE_ENABLED");
    expect(doc).toMatch(/default `false`/);
  });
});

describe("the ADR log", () => {
  const adrFiles = fs.readdirSync(ADR_ROOT).filter((f) => f.startsWith("ADR-"));

  /**
   * The log holds two classes of record, and `docs/adr/README.md` has always said so:
   *
   *   **01–32** — Appendix C's decisions, recorded verbatim in Phase 0, `Accepted — frozen`.
   *   **33 upward** — *integration* decisions taken under the frozen architecture, which choose
   *     how to meet it rather than what it is, marked `Accepted` and never `frozen`.
   *
   * Until D4 was ratified the second class was empty, so the tests below could treat "every
   * record" and "every frozen record" as the same set. `ADR-33` is the first member of it, and
   * conflating the two would have exactly one of two effects: either an integration record has
   * to falsely claim frozen status, or the Appendix C set stops being checked for completeness.
   * Both are worse than telling the two apart, so the split is made here rather than papered over.
   */
  const integrationOf = (file) => {
    const match = /^ADR-(\d{2})/u.exec(file);
    return match && Number(match[1]) >= 33;
  };
  const frozenFiles = adrFiles.filter((file) => !integrationOf(file));
  const integrationFiles = adrFiles.filter(integrationOf);

  test("records every decision in Appendix C of the frozen specification", () => {
    const spec = fs.readFileSync(
      path.join(REPO_ROOT, "NEXT_GENERATION_ASSIGNMENT_ENGINE.md"),
      "utf8",
    );
    const appendixC = spec.slice(spec.indexOf("## Appendix C"));
    const table = appendixC.slice(0, appendixC.indexOf("\n## ", 1));

    const ids = table
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) => line.split("|")[1].trim())
      .filter((id) => /^\d{2}[a-z]?$/.test(id));

    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("01");
    expect(ids).toContain("32");

    for (const id of ids) {
      const match = adrFiles.find((file) => file.startsWith(`ADR-${id}-`));
      expect({ id, recorded: Boolean(match) }).toEqual({ id, recorded: true });
    }
    // The frozen set is Appendix C's and nothing else: a record numbered 01–32 that Appendix C
    // does not name would be a decision smuggled in as a frozen one.
    expect(frozenFiles).toHaveLength(ids.length);
  });

  test("every Appendix C record is accepted and frozen", () => {
    for (const file of frozenFiles) {
      const contents = fs.readFileSync(path.join(ADR_ROOT, file), "utf8");
      expect({ file, frozen: contents.includes("**Accepted — frozen**") }).toEqual({
        file,
        frozen: true,
      });
      expect(contents).toMatch(/^## Decision$/m);
      expect(contents).toMatch(/^## Rejected$/m);
    }
  });

  test("every integration record is accepted, declares itself as one, and never claims to be frozen", () => {
    for (const file of integrationFiles) {
      const contents = fs.readFileSync(path.join(ADR_ROOT, file), "utf8");
      // Stricter than the frozen class, not looser. An integration record that claimed
      // `Accepted — frozen` would be asserting it cannot be superseded by a later integration
      // decision, which is the one thing README's supersession rule reserves for Appendix C.
      expect({ file, frozen: contents.includes("**Accepted — frozen**") }).toEqual({ file, frozen: false });
      expect({ file, accepted: /\|\s*\*\*Status\*\*\s*\|\s*\*\*Accepted\*\*\s*\|/u.test(contents) }).toEqual({ file, accepted: true });
      expect({ file, declared: /integration decision under a frozen architecture/iu.test(contents) }).toEqual({ file, declared: true });
      expect(contents).toMatch(/^## Decision$/m);
      expect(contents).toMatch(/^## Rejected$/m);
    }
  });

  test("the index lists every record and states the supersession rule", () => {
    const readme = fs.readFileSync(path.join(ADR_ROOT, "README.md"), "utf8");
    for (const file of adrFiles) expect(readme).toContain(file);
    expect(readme).toMatch(/supersed/i);
  });
});

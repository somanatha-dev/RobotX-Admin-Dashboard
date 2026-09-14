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
  // Invariant Checker. `fairness/` remains forbidden — Phase 12's scope is §18 and §26, and
  // §17 is no part of it. §17.4's Tier 1 ladder has no assigned phase (see PHASE_15_OWNED).
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
  // Tier 1 ladder has no assigned phase (see PHASE_15_OWNED), and §17.2/§17.3 are Phase 16's.
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
  // forbidden in its entirety, but for **two different reasons**, and conflating them is what
  // this comment previously did:
  //
  //   §17.2's `dutyCycle.js` and §17.3's `repositioning.js` are Tier 2 (T2-10, T2-11) and are
  //     genuinely **Phase 16's** — `repositioning.js` is named in Phase 16's own Files to create.
  //   §17.4's `ladder.js`, `operatorCapacity.js` and `agentStarvation.js` are **Tier 1** (T1-04,
  //     invariant I13). §1.8 puts the anti-starvation *guarantee* in the ladder, and the execution
  //     plan's §0.2 puts every Tier 1 mechanism in Phases 0–15. They are therefore **not Phase
  //     16's** — they are refused here because the plan assigned them to *no* phase at all, which
  //     is an open programme decision (execution plan §6.3), not a design choice.
  //
  // The refusal is identical; the reason is not, and the tier-split test below pins it so the
  // distinction cannot decay back into "fairness/ is Phase 16's".
  //
  // `routing/inProcessCache.js` is the one exception to "no new capability", and it is
  // named here rather than under Phase 8 deliberately. It is a **B1 prerequisite**, not a
  // Phase 8 deliverable: §20.1 budgets a cached return-leg lookup at < 10 µs and
  // `PHASE_15_B1_ROUTING_DECISION_REPORT.md` §7.1 measured loopback Redis `GET` at
  // p50 304 µs / p99 1 156 µs, so the lookup tier is unbuildable-as-specified independently
  // of which engine B1 selects. It ships no capability — it issues no query, holds no
  // adapter, and implements no part of §5.2's degradation ladder. Phase 8's `client.js`
  // remains absent and remains Phase 8's.
  //
  // `cutover/evidence.js` is Phase 15's for the same reason `cutover/gates.js` is: it is
  // half of one mechanism. `gates.js` says which gates exist; `evidence.js` says what
  // discharges one. Splitting them was the remediation — the table was shipped without the
  // rule, so `evaluate()` read `record.pass === true` and a hand-typed object closed all
  // twenty-three gates. It ships no capability: it issues no query and decides nothing
  // except whether a record may be believed.
  //
  // `cutover/agentGate.js` is Phase 15's on the same argument, one layer out. `enabled.js`
  // says the switch has two halves; `agentGate.js` is where an *agent session* is held to
  // both of them. It was the D-6 remediation: `enabled.js` shipped with one converted call
  // site and every socket handler still reading the process half alone, so during a staged
  // rollout the agent-facing write paths were live on shards the staging order had
  // deliberately not reached. It ships no capability — it resolves a durable membership row
  // and decides nothing except whether a session may act as the engine.
  // `cutover/configPropagation.js`, `cutover/rollbackPublisher.js` and
  // `cutover/legEntryDeadline.js` are the current-tree re-audit's three additions, and each
  // is here on the same argument as `agentGate.js`: it is the missing production half of a
  // Phase 15 mechanism, and it ships no capability.
  //
  //   `configPropagation.js` — §22.1 rule 4's propagation is pull-with-pin, and *nothing
  //     pulled*. `app.locals.config` was assigned once at boot and by nothing else, so a
  //     published `cutover.engine_enabled` binding never reached a running process: the
  //     per-shard cutover could not be actuated, in either direction, without a restart. It
  //     issues no query of its own — `load` and `apply` are injected — and decides nothing
  //     except whether the version it read differs from the one in hand.
  //
  //   `rollbackPublisher.js` — §22.4 item 4's automatic rollback published nothing, so a
  //     breaching shard stayed live and, because `store.declarationFor` then returns null,
  //     was never assessed again. It ships no capability: it restates the version in force
  //     with one region's binding set to false, and refuses anything that is not that.
  //
  //   `legEntryDeadline.js` — §4.5 registers a state's deadline in the transaction that
  //     enters it (I4). Four production paths in `dispatch/offers.js` enter a Leg state
  //     without running §4.4's table and registered none; Phase 5 reproduced two of them
  //     live (X2a, X2b) and routed them here, because one of the two became reachable only
  //     when Phase 15 wired the outbox worker into the composition root. It ships no
  //     capability — the deadline parameter comes from `legMachine`, the duration from the
  //     register, and the write from `supervision/timers`.
  const PHASE_15_OWNED = [
    "cutover/agentGate.js",
    "cutover/configPropagation.js",
    "cutover/enabled.js",
    "cutover/evidence.js",
    "cutover/gates.js",
    "cutover/guardrails.js",
    "cutover/legEntryDeadline.js",
    "cutover/rollbackPublisher.js",
    "cutover/stage.js",
    "cutover/store.js",
    "routing/inProcessCache.js",
  ];

  // ── REMEDIAL PHASE T1-04 — §17.4's anti-starvation escalation ladder ───────
  //
  // Not a numbered phase, and that is the point. §1.8 places the ladder at **Tier 1**
  // ("where the anti-starvation guarantee lives") and the plan's §0.2 says "Phases 0-15
  // deliver Tier 0 + Tier 1. Phase 16 enables Tier 2." — so Phase 16 is excluded — while no
  // authoritative source ever assigned it to one of Phases 0-15. `IMPLEMENTATION_EXECUTION_PLAN.md`
  // §3/§6.3 resolved that by opening a **remedial phase** for it, with prerequisites Phases
  // 11-14 and running parallel with Phase 15.
  //
  // The blocker register recorded the trap this list must not fall into: *"Registration is
  // authorisation, not implementation."* The remedial phase has now run, so these three are
  // owned **and** on disk, and the suite below asserts both halves rather than either alone.
  const REMEDIAL_T1_04_OWNED = [
    "fairness/ladder.js",
    "fairness/operatorCapacity.js",
    "fairness/agentStarvation.js",
  ];

  // ── ROUTING BATCH 1 — the production routing producer ──────────────────────
  //
  // Named file-by-file under `routing/`, for the reason Phase 7's comment gives: a directory
  // prefix here would stop catching Phase 8's `client.js` if it ever leaked backwards, and
  // `client.js` remains absent and remains Phase 8's.
  //
  // These four are **not** Phase 8's routing client and must not be mistaken for it. That
  // client owns §5.2's degradation ladder and §18.3 B6's uniform-treatment rule; nothing
  // here walks a ladder or degrades anything — each module answers one question and refuses
  // when it cannot.
  //
  //   `campusTravelModel.js`  — the owner's declared V1 deterministic campus travel-time
  //     model (2026-09-13): `distanceM / speedMps + distanceM x 15 / 100`, plus the
  //     declared uncertainty policy N29 asks for. It issues no query and holds no state; it
  //     is arithmetic over two registered parameters, stated once so that no caller can
  //     assemble a travel time some other way.
  //
  //   `campusServiceability.js` — whole-region membership by point-in-polygon over a
  //     **supplied** boundary, validated through `spatial/regionBoundary`'s own V-1…V-6. It
  //     declares no boundary, holds no coordinate, and deliberately does NOT consult a cell
  //     cover: the owner's refusal of `containmentOverlapping` and
  //     `containmentOverlappingBbox` (B1_EXTERNAL_INPUT_HANDOFF.md §1.8.4) is standing, and
  //     a point test decides no containment semantics at all.
  //
  //   `cellProjection.js` — N27's `projectCell(cellId) -> { lat, lon }` seam, which
  //     `adapters/contract.js` requires and forbids any adapter to invent. It adds no
  //     coordinate system: the map is `spatial/cells.centreOfCell`, and the one thing it
  //     adds is a serviceability guard, so a cell whose representative coordinate is
  //     outside the committed region is refused rather than routed.
  //
  //   `productionRouter.js` — the `deps.route(parts)` producer named at
  //     `workers/coordinatorPipeline.js:289-301`. It composes the three above with a B1
  //     adapter. It selects no engine (that is B1 Step 5, on recorded evidence), caches
  //     nothing (`cellPairCache` is the cache and this is what it falls through to), and
  //     refuses outright while `climbM`/`descentM`/`stopStartCycles` have no declared
  //     producer — which, on this tree, is always.
  const ROUTING_BATCH_1_OWNED = [
    "routing/campusServiceability.js",
    "routing/campusTravelModel.js",
    "routing/cellProjection.js",
    "routing/productionRouter.js",
  ];

  const LANDED_PHASE_OWNED = [
    ...REMEDIAL_T1_04_OWNED,
    ...ROUTING_BATCH_1_OWNED,
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
    // §4.8's preemption, §17.3's repositioning, and §9.3's column-regime mechanisms (set
    // partitioning, branch and bound, local search) are five genuine Tier 2 / Phase 16
    // mechanisms that would plausibly land inside a folder an earlier phase already owns.
    //
    // `fairness/ladder.js` stood in this list until the pre-Phase-16 reconciliation and has been
    // replaced by `fairness/repositioning.js`. The ladder is Tier 1 (T1-04) — asserting it here
    // as a *Phase 16* module encoded a false tier claim into a machine-checked expectation, which
    // is the most durable way to be wrong. It is still refused by the walk, and the test directly
    // below is what now pins that refusal to its real reason.
    const planted = [
      "solve/setPartitioning.js",
      "solve/branchAndBound.js",
      "solve/localSearch.js",
      "lifecycle/preemption.js",
      "fairness/repositioning.js",
    ];
    expect(unownedAmong(planted).sort()).toEqual([...planted].sort());

    // Negative control: the rule that refuses those must still admit the real files, or the
    // test above would pass for the wrong reason — a predicate that refuses everything.
    expect(unownedAmong(["solve/costScaling.js", "lifecycle/transitions.js"])).toEqual([]);
  });

  describe("§17.4's anti-starvation ladder — T1-04, Tier 1, and owned by no phase", () => {
    // The contradiction this suite exists to prevent recurring: three current documents filed a
    // **Tier 1** mechanism under Phase 16, and one of them was the planted-violation list above.
    // Nothing mechanical distinguished the two populations inside `fairness/`, so the refusal of
    // `ladder.js` read as "Phase 16 owns it" when the truth is "no phase does".
    //
    // Authority chain, none of it invented here:
    //   §1.8            — the §17.4 ladder is Tier 1: "where the anti-starvation guarantee lives"
    //   TIERS.md T1-04  — the three modules, invariant I13
    //   plan §0.2       — "Phases 0-15 deliver Tier 0 + Tier 1. Phase 16 enables Tier 2."
    // Therefore Phase 16 is excluded. Which of Phases 0-15 owns it is NOT determined by any
    // authoritative source and is NOT decided here.
    const LADDER_MODULES = ["fairness/ladder.js", "fairness/operatorCapacity.js", "fairness/agentStarvation.js"];
    const TIER_TWO_FAIRNESS = ["fairness/dutyCycle.js", "fairness/repositioning.js"];

    test("the tier table classifies the ladder Tier 1 and the other fairness modules Tier 2", () => {
      const { TIER, tierOf } = require("../../src/engine/guards/tierAssertions");

      for (const module of LADDER_MODULES) {
        expect({ module, tier: tierOf(`src/engine/${module}`) }).toEqual({
          module,
          tier: TIER.OPERATIONAL_INTEGRITY,
        });
      }
      for (const module of TIER_TWO_FAIRNESS) {
        expect({ module, tier: tierOf(`src/engine/${module}`) }).toEqual({
          module,
          tier: TIER.ALLOCATION_QUALITY,
        });
      }
    });

    test("T1-04 names exactly those three modules and carries I13", () => {
      const { TIER, MECHANISMS } = require("../../src/engine/guards/tierAssertions");
      const t104 = MECHANISMS.find((mechanism) => mechanism.id === "T1-04");

      expect(t104).toBeDefined();
      expect(t104.tier).toBe(TIER.OPERATIONAL_INTEGRITY);
      expect(t104.invariants).toContain("I13");
      expect([...t104.modules].sort()).toEqual(LADDER_MODULES.map((m) => `src/engine/${m}`).sort());
    });

    test("the remedial phase owns the ladder, and all three modules are on disk", () => {
      // REMEDIAL PHASE T1-04. This test asserted the opposite — unowned **and** absent —
      // which was the honest state of an unassigned obligation for as long as it was one.
      // Both halves have moved together, and they must: owned-and-absent is a registration
      // mistaken for an implementation, which is the exact confusion the blocker register
      // names ("Registration is authorisation, not implementation"), and unowned-and-present
      // is work landing with nothing accountable for it.
      //
      // Ownership is the **remedial** phase, not one of Phases 0-15. Nothing here decides
      // which numbered phase owns it, because no authoritative source ever did.
      expect([...REMEDIAL_T1_04_OWNED].sort()).toEqual([...LADDER_MODULES].sort());
      expect(unownedAmong(LADDER_MODULES)).toEqual([]);
      for (const module of LADDER_MODULES) {
        expect({ module, onDisk: fs.existsSync(path.join(ENGINE_ROOT, module)) }).toEqual({
          module,
          onDisk: true,
        });
      }
      // The Tier 2 half of `fairness/` is still Phase 16's and still refused, so the
      // directory has not been opened up by the remedial phase landing inside it.
      expect(unownedAmong(TIER_TWO_FAIRNESS).sort()).toEqual([...TIER_TWO_FAIRNESS].sort());
      for (const module of TIER_TWO_FAIRNESS) {
        expect({ module, onDisk: fs.existsSync(path.join(ENGINE_ROOT, module)) }).toEqual({
          module,
          onDisk: false,
        });
      }
    });

    test("no phase list smuggles the ladder in under a directory prefix", () => {
      // `fairness/` as a bare prefix in any PHASE_*_OWNED list would silently admit all five
      // modules — the Tier 1 three and the Tier 2 two — and defeat both refusals at once.
      // The remedial phase's three entries are named files, which is what keeps this
      // refusal meaningful: a bare `fairness/` prefix would admit all five modules — the
      // Tier 1 three and the Tier 2 two — and defeat the Tier 2 refusal above at a stroke.
      expect(
        LANDED_PHASE_OWNED.filter(
          (owned) => owned.startsWith("fairness") && !REMEDIAL_T1_04_OWNED.includes(owned),
        ),
      ).toEqual([]);
      expect(LANDED_PHASE_OWNED).not.toContain("fairness/");
    });
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

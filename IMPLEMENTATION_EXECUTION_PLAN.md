# RobotX — Implementation Execution Plan

**Document type:** Implementation execution plan (post-architecture-freeze)
**Status:** Active — the plan of record for building the frozen architecture
**Source of truth:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN). This document does not
modify, reinterpret, simplify, or improve that specification. Where this plan and the
specification appear to disagree, the specification wins and this plan is defective.
**Target codebase:** `Backend/` (Node.js 20 · Express 5 · Prisma 5 · PostgreSQL · Redis ·
Socket.IO 4), branch `feature/dashboard`, baseline commit `e558243`
**Audience:** Engineers implementing the engine; tech lead sequencing the work; SRE preparing
infrastructure; QA defining gates

---

## 0. How to read this document

### 0.1 What this plan is, and is not

| This plan does | This plan does not |
|---|---|
| Map every architectural capability onto existing or new code | Redesign any mechanism |
| Sequence the work into phases with hard prerequisites | Propose alternatives to specified algorithms |
| Enumerate schema, Redis, socket, REST, and worker changes | Simplify, defer, or "phase out" any Tier 0 requirement |
| Record where the current implementation differs from the frozen spec | Change the philosophy, units, or invariants |
| Provide a trackable checklist | Generate code |

### 0.2 The phasing rule this plan obeys

The specification states its own staging order in **§1.8 rule 3**, and this plan follows it
rather than inventing one:

> Tier 0 plus Tier 1, at `capacity[agent_class] = 1`, in the singleton regime, with deferral and
> preemption off and `λ_zone` taken from static configured priors, is a **complete, safe,
> shippable engine.** Tier 2 mechanisms are then enabled one at a time, each behind its own
> switch, each validated in shadow mode before it is trusted.

Accordingly: **Phases 0–15 deliver Tier 0 + Tier 1. Phase 16 enables Tier 2.** No phase ships a
Tier 2 mechanism as a dependency of a Tier 0 or Tier 1 guarantee (§1.8 rule 2), and every Tier 2
mechanism lands behind the kill switch that §22.5 requires it to have.

### 0.3 Terminology mapping (existing code → frozen architecture)

The codebase and the specification use different words for overlapping concepts. This mapping is
used consistently throughout the plan and MUST be used in code review.

| Codebase term | Architecture term | Note |
|---|---|---|
| `Robot` | `Agent` (§2.1) | Rename is structural, not cosmetic — Agent carries mobility, energy, container, capability models |
| `Task` (pickup→drop, one robot) | `Task` + `Mission` + one `Leg` + two `Stop`s (§2.4) | Today's Task collapses four architectural entities |
| `Task.status` | `Task` state machine (§4.2) **and** `Leg` state machine (§4.3) | One enum today; two machines in the architecture |
| `robotReserve:*` Redis lock | Advisory cache lock only (§10.4) | Today it is the *sole* exclusivity guarantee; it becomes advisory |
| `Robot.currentTaskId` | HARD `Commitment` row (§2.6) | Today a nullable FK; becomes a durable fenced, leased contract |
| DTARO cost `C(r)` | `Φ(plan)` in CU (§8.1) | Dimensionless min-max → absolute additive CU |
| `Zone` (bbox) | `Zone` (pricing unit, §3.6) | Concept survives, role and containment rules change |
| `ObstacleEvent` / EKB | `route_hazard_cost` input (§8.4) | Feeds cost; distinct from map **obstruction class** (§4.3), which is new |
| `logger.dtaro()` line | Tier A Decision Record (§21.2) | Log line → immutable, replayable record |
| VirtualRobot | Simulated Agent + fleet simulator (§24.4) | Must implement the agent-side protocol contract |

---

## 1. Baseline assessment

### 1.1 What the codebase gives us for free

These are genuine assets. The plan builds on them rather than replacing them.

| Existing asset | File(s) | Architectural role it can serve |
|---|---|---|
| Room-based, adapter-aware dispatch | `Backend/src/services/commandDispatcher.service.js` | Delivery mechanism (§11.3) — already cluster-safe, already rejects process-local socket delivery |
| Socket.IO Redis adapter wiring | `Backend/server.js:45-67` | Cross-worker broadcast, required by §11.3 |
| KV facade with pipelining + fail-closed lock policy | `Backend/src/cache/kv.js` | L1 cache tier (§3.3); the fail-closed policy already matches the cache-authority rule's spirit |
| Hot-path state cache | `Backend/src/cache/robotStateCache.js` | Feasibility predicate cache substrate (§7.6) |
| `Command` model + ACK correlation + retry scheduler | `prisma/schema.prisma:391`, `src/sockets/handlers/command.handler.js`, `src/controllers/robots.controller.js:522-578` | Partial outbox/ACK foundation (§11.1, §11.2) |
| Live-robot index (`robots:all`) | `src/services/robotRegistry.service.js` | Precursor to the Availability Index (§6.2) |
| Zone model + manager | `prisma/schema.prisma:238`, `src/services/zoneManager.service.js` | Zone as pricing unit (§3.6, §8.3) |
| EKB + alert dissemination + route intersection | `src/services/ekb.service.js`, `alertDissemination.service.js`, `routeIntersection.service.js` | `route_hazard_cost` input (§8.4) and obstacle re-plan trigger (§18.2 A8) |
| Task recovery on boot | `src/services/taskRecovery.service.js` | Precursor to the reconciler's orphan scan (§12.4) |
| Offline detector sweep | `src/sockets/socket.server.js:55-119` | Precursor to lease-expiry supervision (§12.2) |
| Benchmark harness (tiered load, cluster, profiling) | `Backend/benchmark/**` | Scale and locality testing (§24.6) |
| Jest suite + mock Prisma/KV/socket helpers | `Backend/tests/**` | Test substrate for every phase |
| Prisma migration discipline | `Backend/prisma/migrations/**` | Schema change control |
| Structured logger with domain channels | `src/config/logger.js` | Tracing and logging (§21.7) |

### 1.2 The structural gap, stated once

The current implementation is, precisely, the baseline the frozen specification was written
against. It is a **greedy, per-arrival, single-task dispatcher with min-max normalised
dimensionless costs, cache-based exclusivity, fire-and-forget dispatch, and no supervision.**
The architecture is a **rolling-horizon batch allocator over Legs with absolute CU costs, durable
two-scope-fenced commitment, transactional outbox dispatch, and durable supervision.**

This is not a refactor. It is a new engine, built alongside the existing one, cut over behind
flags. The plan is organised accordingly:

- **Strangler pattern.** The new engine is built under `Backend/src/engine/**` and runs in shadow
  before it runs in production (§21.6). The legacy path in `task.service.js` remains live and
  untouched until Phase 15's cutover gate.
- **No partial cutover.** Because Tier 0 is indivisible (§1.8), the cutover switches the whole
  decision path at once, per shard, with rollback. There is no state in which half the commitment
  core is live.

---

## 2. Capability inventory

Status codes: **E** = exists and is reusable as-is · **M** = exists, requires modification ·
**N** = completely new · **R** = exists but is replaced/retired

### 2.1 Design philosophy and units (§1)

| Capability | Status | Existing files affected | New files required |
|---|---|---|---|
| Absolute CU cost unit, dimensioned exchange rates (§1.3) | **N** | `src/services/costEvaluator.service.js` (R) | `src/engine/cost/units.js`, `src/engine/cost/exchangeRates.js` |
| Leg-indexed objective (§1.4) | **N** | — | `src/engine/solve/objective.js` |
| Column as unit of proposal (§1.4) | **N** | — | `src/engine/plan/column.js` |
| Design tenets as enforced properties (T1–T10) | **N** | `src/services/robotValidator.service.js` (M) | `src/engine/guards/tenets.js` (build-time assertions) |
| Correctness core / obligation tiering (§1.8) | **N** | — | `src/engine/TIERS.md`, `src/engine/guards/tierAssertions.js` |

### 2.2 Domain model (§2)

| Capability | Status | Existing files affected | New files required |
|---|---|---|---|
| Agent (replacing Robot) with class/mobility/energy/container/capability facets | **M** | `prisma/schema.prisma`, `src/services/robot.service.js`, `src/controllers/robots.controller.js` | `src/engine/domain/agent.js` |
| MobilityModel (§2.2) | **N** | — | `src/engine/domain/mobilityModel.js` |
| CapabilityBundle + typed requirement matching, `custody_transfer_capable` (§2.3) | **N** | — | `src/engine/domain/capability.js` |
| Task / Mission / Leg / Stop separation (§2.4) | **N** | `prisma/schema.prisma`, `src/services/task.service.js` (R) | `src/engine/domain/work.js` |
| Leg `purpose` + `custodial_purposes` / `speculative_purposes` (§2.4) | **N** | `prisma/schema.prisma` | `src/engine/domain/purpose.js` |
| Custody as first-class state (§2.5) | **N** | `prisma/schema.prisma` | `src/engine/domain/custody.js` |
| Commitment / Lease / two fences (§2.6) | **N** | `prisma/schema.prisma` | `src/engine/commitment/model.js` |
| SOFT reservation as round-local memory (§2.6) | **N** | `src/cache/kv.js` (M — `robotReserve:*` retires) | `src/engine/shard/planState.js` |
| Observation with freshness + provenance (§2.7) | **M** | `src/services/robotRegistry.service.js`, `src/sockets/handlers/telemetry.handler.js` | `src/engine/domain/observation.js` |

### 2.3 System architecture (§3)

| Capability | Status | Existing files affected | New files required |
|---|---|---|---|
| L1–L4 layer separation (§3.1) | **N** | — | directory structure under `src/engine/**` + `src/engine/ARCHITECTURE.md` |
| Component catalogue as real modules (§3.2) | **N** | — | one module per component (see phase tables) |
| Store role assignment; cache-authority rule (§3.3) | **M** | `src/cache/kv.js`, `src/db/prisma.js` | `src/engine/stores/roles.js` (documented bindings + guard) |
| Request-path / round-path split (§3.4) | **M** | `src/controllers/tasks.controller.js`, `src/services/task.service.js` (R — `setImmediate` detach removed) | `src/engine/intake/intake.js`, `src/workers/coordinator.worker.js` |
| Shard model + two-bound sizing (§3.5) | **N** | — | `src/engine/shard/shardModel.js`, `src/engine/shard/sizing.js` |
| Spatial hierarchy region/zone/site/cell (§3.6) | **M** | `prisma/schema.prisma`, `src/services/zoneManager.service.js` | `src/engine/spatial/hierarchy.js` |

### 2.4 Lifecycle (§4)

| Capability | Status | Existing files affected | New files required |
|---|---|---|---|
| Task state machine (§4.2) | **M** | `prisma/schema.prisma` (TaskStatus enum) | `src/engine/lifecycle/taskMachine.js` |
| Leg state machine incl. `STRANDED_SAFE`/`STRANDED_OBSTRUCTING` (§4.3) | **N** | `prisma/schema.prisma` | `src/engine/lifecycle/legMachine.js` |
| Complete transition table with guards (§4.4) | **N** | — | `src/engine/lifecycle/transitions.js` |
| Rule 5 — no side effect before its authorising write (§4.1) | **N** | `src/services/commandDispatcher.service.js` (M) | enforced in `src/engine/dispatch/outbox.js` |
| Durable timers keyed on entity version (§4.5) | **N** | — | `src/engine/supervision/timers.js`, `src/workers/timer.worker.js` |
| Purpose-conditioned cancellation (§4.6) | **M** | `src/controllers/tasks.controller.js` | `src/engine/lifecycle/cancellation.js` |
| Reassignment protocol (§4.7) | **N** | — | `src/engine/lifecycle/reassignment.js` |
| Preemption incl. victim disposition (§4.8) | **N** | — | `src/engine/lifecycle/preemption.js` |
| Settlement with custody-before-commitment ordering (§4.9) | **N** | `src/sockets/handlers/dtaro.handler.js` (M — TASK_COMPLETE) | `src/engine/lifecycle/settlement.js` |

### 2.5 Interfaces and dependencies (§5)

| Capability | Status | Existing files affected | New files required |
|---|---|---|---|
| Dependency contracts with budgets + envelope reductions (§5.2) | **N** | — | `src/engine/deps/registry.js`, `src/engine/deps/circuitBreaker.js` |
| Self-hosted routing with contraction hierarchies (§5.2) | **R** | `src/services/mapbox.service.js` (R for hot path) | `src/engine/routing/client.js`, `src/engine/routing/cellPairCache.js`, infra: routing service deployment |
| Map service with obstruction classification (§5.2, §4.3) | **N** | — | `src/engine/map/obstructionClass.js` |
| Charging Scheduler contract (reservations, target SoC, availability projection) (§14.7) | **N** | — | `src/engine/energy/chargingSchedulerClient.js` + external service (out of engine boundary, §1.6) |
| Forecast + Capacity Pricing clients (§8.3.1) | **N** | — | `src/engine/pricing/capacityPricingClient.js`, `src/engine/pricing/forecastClient.js` |

### 2.6 Decision path (§6–§9)

| Capability | Status | Existing files affected | New files required |
|---|---|---|---|
| Availability Index (H3/S2, availability classes) (§6.2) | **M** | `src/services/robotRegistry.service.js` (`robots:all` set) | `src/engine/candidates/availabilityIndex.js` |
| Hierarchical expansion tiers 0–6 (§6.3) | **N** | `src/services/taskAssignment.service.js` (R) | `src/engine/candidates/expansion.js` |
| Admissible lower bound with `Ω_terminal`/`Ω_policy` (§6.4) | **N** | — | `src/engine/candidates/lowerBound.js`, `src/engine/candidates/omega.js` |
| Candidate sizing + determinism (§6.5, §6.6) | **M** | `src/services/taskAssignment.service.js` (R) | `src/engine/candidates/ordering.js` |
| 38-predicate feasibility register, three-valued (§7.3, §7.5) | **M** | `src/services/robotValidator.service.js` (R) | `src/engine/feasibility/predicates/*.js` (38 modules), `src/engine/feasibility/evaluate.js` |
| Systemic-indeterminacy guard (§7.4) | **N** | — | `src/engine/feasibility/systemicGuard.js` |
| Feasibility caching + volatile subset (§7.6, §10.3.2 step 3) | **M** | `src/cache/robotStateCache.js` | `src/engine/feasibility/cache.js`, `src/engine/feasibility/volatileSubset.js` |
| Rejection reporting + streaming aggregation (§7.7) | **M** | `src/config/logger.js` (`logger.dtaro`) | `src/engine/feasibility/rejectionTelemetry.js` |
| `Φ(plan)` cost functional, all terms (§8.1–§8.9) | **R** | `src/services/costEvaluator.service.js` | `src/engine/cost/phi.js` + one module per term |
| Plan Builder (§13.1) | **N** | `src/services/task.service.js` (partial route logic) | `src/engine/plan/planBuilder.js` |
| Insertion / chaining / consolidation (§13.3) | **N** | — | `src/engine/plan/insertion.js` |
| Column Builder (§9.3) | **N** | — | `src/engine/plan/columnBuilder.js` |
| Round cadence + fast path as batch-of-one (§9.2) | **N** | — | `src/engine/solve/cadence.js` |
| Singleton-regime min-cost flow (§9.3) | **N** | — | `src/engine/solve/minCostFlow.js` |
| Column-regime set partitioning + B&B (§9.3) | **N** (Tier 2) | — | `src/engine/solve/setPartitioning.js` |
| Solve size control, anytime behaviour (§9.4) | **N** | — | `src/engine/solve/budgets.js` |
| Post-solve local search (§9.5) | **N** (Tier 2) | — | `src/engine/solve/localSearch.js` |
| Determinism: int64 milli-CU, canonical order, pinned snapshot (§9.6) | **N** | — | `src/engine/determinism/fixedPoint.js`, `src/engine/determinism/snapshot.js` |

### 2.7 Commitment, dispatch, supervision (§10–§12)

| Capability | Status | Existing files affected | New files required |
|---|---|---|---|
| Two fencing scopes + command→scope table (§10.3.1) | **N** | `prisma/schema.prisma` | `src/engine/commitment/fencing.js` |
| Commit transaction, guards G1–G6, SERIALIZABLE (§10.3.2) | **R** | `src/services/task.service.js:249-272` | `src/engine/commitment/commit.js` |
| Schema-enforced capacity + HARD-only constraint (§10.3.2) | **N** | `prisma/migrations/**` | migration SQL (partial unique index + check constraint) |
| Advisory cache lock (§10.4) | **M** | `src/cache/kv.js` (`reserveRobot`) | reused, demoted to advisory |
| Idempotency on commitment/command namespaces (§10.5) | **M** | `src/services/commandDispatcher.service.js` | `src/engine/commitment/idempotency.js` |
| Clock discipline (§10.6) | **N** | — | `src/engine/commitment/clock.js` |
| Transactional outbox (§11.1) | **N** | `prisma/schema.prisma` | `src/engine/dispatch/outbox.js`, `src/workers/outbox.worker.js` |
| Offer semantics ACCEPT/REJECT/DEFER (§11.2) | **N** | `src/sockets/handlers/*.js`, `src/simulation/VirtualRobot.js` | `src/engine/dispatch/offers.js`, `src/sockets/handlers/offer.handler.js` |
| Delivery mechanism, ordering, bounded retry (§11.3) | **M** | `src/services/commandDispatcher.service.js` | — |
| Undelivered/unacked escalation ladder (§11.4) | **N** | — | `src/engine/dispatch/escalation.js` |
| Durable agent-side dedup + generation handshake (§11.5) | **N** | `src/simulation/VirtualRobot.js`, `src/sockets/handlers/robot.handler.js` | `src/engine/dispatch/dedupHandshake.js` |
| Lease renewal/expiry, per commitment (§12.2) | **N** | `src/sockets/socket.server.js` (offline sweep, M) | `src/engine/supervision/leases.js` |
| Progress supervision (§12.3) | **N** | `src/sockets/handlers/telemetry.handler.js` (M) | `src/engine/supervision/progress.js` |
| Reconciliation loop (§12.4) | **M** | `src/services/taskRecovery.service.js` (absorbed) | `src/engine/supervision/reconciler.js`, `src/workers/reconciler.worker.js` |
| Graded completion verification L0–L3 + track plausibility (§12.5) | **N** | `src/sockets/handlers/dtaro.handler.js` (TASK_COMPLETE, M) | `src/engine/supervision/verification.js` |

### 2.8 Physical models (§14–§17)

| Capability | Status | Existing files affected | New files required |
|---|---|---|---|
| Wh consumption model incl. `β_payload_thermal` (§14.2) | **N** | `src/simulation/constants.js` (M) | `src/engine/energy/consumption.js` |
| Usable energy, SoH, derating, combined-conservatism cap (§14.3) | **N** | — | `src/engine/energy/usable.js` |
| Battery wear cost (§14.4) | **N** | — | `src/engine/energy/wear.js` |
| Layered reserves + tiered F34 (§14.5) | **R** | `src/config/dtaro.constants.js` (20%/30% floors) | `src/engine/energy/reserves.js`, `src/engine/energy/tiers.js` |
| `E_return` with pinned charger projection (§14.5) | **N** | — | `src/engine/energy/eReturn.js`, `src/engine/routing/chargerReachabilityCache.js` |
| Charging model, nonlinear curve, target-SoC ownership (§14.6) | **N** | `src/simulation/VirtualRobot.js` (M) | `src/engine/energy/chargeCurve.js` |
| Mid-mission energy management (§14.8) | **N** | `src/sockets/handlers/telemetry.handler.js` (M) | `src/engine/energy/midMission.js` |
| Payload spec, container model, tiered packing (§15) | **N** | `prisma/schema.prisma` | `src/engine/payload/*.js` |
| Reliability metrics + hierarchical Bayesian + health tiers (§16) | **N** | — | `src/engine/reliability/*.js` |
| Duty-cycle regulariser, spatial balancing (§17.1–§17.3) | **N** | `prisma/schema.prisma` (`Robot.utilization`, M) | `src/engine/fairness/dutyCycle.js` |
| Escalation ladder + human capacity model (§17.4) | **N** | — | `src/engine/fairness/ladder.js`, `src/engine/fairness/operatorCapacity.js` |
| Agent starvation + exercise missions (§17.5) | **N** | — | `src/engine/fairness/agentStarvation.js` |

### 2.9 Failure, distribution, performance (§18–§20)

| Capability | Status | Existing files affected | New files required |
|---|---|---|---|
| Agent + infrastructure failure catalogues (§18.2, §18.3) | **M** | scattered try/catch across services | `src/engine/failure/catalogue.js` |
| Degraded-mode register with named modes (§18.5) | **N** | — | `src/engine/degraded/modeRegister.js` |
| External escalation for obstructing strandings (§18.6) | **N** | — | `src/engine/failure/externalEscalation.js` |
| Consistency model bindings (§19.1) | **N** | — | documented in `src/engine/stores/roles.js` |
| Region sharding + migration via `authority_epoch` (§19.2) | **N** | `prisma/schema.prisma` | `src/engine/shard/membership.js` |
| Single-writer coordinator + leader election (§19.3, §19.5) | **N** | `server.js` (M) | `src/engine/shard/leadership.js`, `src/workers/coordinator.worker.js` |
| Cross-region saga (§19.6) | **N** | — | `src/engine/shard/crossRegion.js` |
| Performance targets incl. p99.9 (§20.1) | **M** | `benchmark/**` | `src/engine/observability/sli.js` |
| Routing cost mitigation, two cache populations (§20.3) | **N** | `src/services/mapbox.service.js` (R) | `src/engine/routing/*.js` |
| Admission control + purpose-keyed shedding (§20.5) | **M** | `src/middlewares/rateLimitHttp.js` | `src/engine/intake/admission.js` |

### 2.10 Observability, governance, security, verification (§21–§26)

| Capability | Status | Existing files affected | New files required |
|---|---|---|---|
| Tier A / Tier B decision records (§21.2) | **R** | `src/config/logger.js` (`logger.dtaro`), `src/services/metrics.service.js` | `prisma` models + `src/engine/observability/decisionRecord.js` |
| Explanation API incl. deferral query (§21.3) | **N** | `src/routes/index.js` | `src/routes/explain.routes.js`, `src/controllers/explain.controller.js` |
| Metric set + SLIs (§21.4) | **M** | `src/services/metrics.service.js`, `src/app.js` (`/health`) | `src/engine/observability/metrics.js` |
| Prediction calibration loop (§21.5) | **N** | — | `src/engine/observability/calibration.js` |
| Shadow mode + offline counterfactual evaluator (§21.6) | **N** | — | `src/engine/observability/shadow.js`, `tools/evaluator/**` |
| Config Service: versioned, scoped, publish-time validated (§22) | **R** | `src/config/dtaro.constants.js`, `liveness.constants.js` | `src/engine/config/service.js`, `src/engine/config/validators.js`, `prisma` ConfigVersion model |
| Operating regimes (§22.2) | **N** | — | `src/engine/config/regimes.js` |
| Calibration ownership + status (§22.4) | **N** | — | `src/engine/config/calibrationStatus.js` |
| Kill switches + supported ladder (§22.5) | **N** | — | `src/engine/config/killSwitches.js` |
| mTLS, attestation, signed commands (§23.2, §23.3) | **M** | `src/sockets/handlers/robot.handler.js` (pairing code + session token) | `src/engine/security/attestation.js`, `src/engine/security/commandSigning.js` |
| Manual override discipline (§23.6) | **M** | `src/controllers/robots.controller.js` | `src/engine/security/override.js` |
| Privacy: surrogate keys + erasure (§23.7) | **N** | `prisma/schema.prisma` | `src/engine/privacy/identityStore.js` |
| Invariant register + checker with 3 statuses (§26) | **N** | — | `src/engine/observability/invariantChecker.js`, `src/workers/invariant.worker.js` |
| Verification: model checking, chaos, simulator fidelity, replay (§24) | **M** | `tests/**`, `benchmark/**` | `formal/**` (TLA+), `tests/chaos/**`, `tools/replay/**` |

---

## 3. Phase plan

Sixteen phases. Phases 0–15 deliver Tier 0 + Tier 1; Phase 16 enables Tier 2.

---

### PHASE 0 — Program setup and guardrails

**Purpose.** Establish the structures every later phase depends on — tier tagging, the engine
module tree, the build gates that will refuse defective work — before any behaviour changes.
Nothing in this phase alters runtime behaviour.

**Scope.** Directory scaffolding, tier registry, lint/build gates, ADR log, test lanes, CI wiring.

| Field | Content |
|---|---|
| **Files to modify** | `Backend/package.json` (scripts, deps), `Backend/jest.config.js` (test projects/lanes), `.gitignore` |
| **Files to create** | `Backend/src/engine/ARCHITECTURE.md`, `Backend/src/engine/TIERS.md`, `Backend/src/engine/guards/tierAssertions.js`, `Backend/src/engine/guards/tenets.js`, `Backend/tools/gates/checkTierDependencies.js`, `Backend/tools/gates/checkParameterRegister.js`, `docs/adr/README.md` |
| **Database migrations** | None |
| **Redis changes** | None |
| **Socket.IO changes** | None |
| **REST API changes** | None |
| **Background workers** | None |
| **Configuration updates** | Add `ENGINE_ENABLED=false` (master switch, default off) to `.env`, `.env.benchmark`, `tests/setup/env.js` |
| **Dependencies** | None (start of graph) |
| **Risk level** | **LOW** — additive only |
| **Testing requirements** | Build gate self-tests: tier-dependency checker must fail a deliberately-planted Tier 0→Tier 2 import; parameter-register checker must fail a planted bare constant |
| **Completion criteria** | `npm test` green; both gates run in CI and demonstrably fail on planted violations; `src/engine/TIERS.md` enumerates every §1.8 Tier 0/1/2 mechanism with its owning module path |

**Prerequisites:** none. **Must precede:** all phases. **Parallel with:** nothing (it is the root).

---

### PHASE 1 — Configuration, units, and determinism substrate

**Purpose.** Deliver §22 (Config Service), §1.3 (CU and exchange rates), and §9.6 (determinism)
before any component that consumes a parameter is written — so that no phase ever introduces a
bare constant that has to be retro-registered.

**Scope.** Versioned config store, scope resolution `global → region → zone → site →
agent_class → agent` (§22.2), publish-time cross-parameter validation (§22.1 rule 5), derived
parameters, calibration status, kill-switch registry, operating regimes, CU fixed-point
arithmetic, canonical ordering utilities, round snapshot pinning.

| Field | Content |
|---|---|
| **Files to modify** | `src/config/dtaro.constants.js` (**retire** — values migrate to register), `src/config/liveness.constants.js` (migrate), `src/app.js` (config bootstrap), `server.js` (load pinned version at boot) |
| **Files to create** | `src/engine/config/service.js`, `src/engine/config/resolver.js`, `src/engine/config/validators.js`, `src/engine/config/derived.js`, `src/engine/config/calibrationStatus.js`, `src/engine/config/killSwitches.js`, `src/engine/config/regimes.js`, `src/engine/config/register/*.json` (parameter register, Appendix A + §8.10), `src/engine/cost/units.js`, `src/engine/cost/exchangeRates.js`, `src/engine/determinism/fixedPoint.js`, `src/engine/determinism/ordering.js`, `src/engine/determinism/snapshot.js` |
| **Database migrations** | `ConfigVersion` (id, version, publishedAt, publishedBy, signature, payload JSONB, immutable), `ConfigScopeBinding`, `ParameterRegisterEntry` (name, unit, range, scope, class, owner, calibrationStatus), `OperatingRegime` |
| **Redis changes** | New: `config:active` (pinned version pointer), `config:v:{version}` (materialised resolved set, TTL 1 h). Config is cache-read but **DB-authoritative** (§3.3) |
| **Socket.IO changes** | None |
| **REST API changes** | New `GET /api/config/resolve?param=&scope=` (resolution-explain, §22.2), `GET /api/config/versions`, `POST /api/config/publish` (Safety-class changes require two-person approval, §22.3) — all behind `authUser` + elevated role |
| **Background workers** | None (config change propagation is pull-with-pin) |
| **Configuration updates** | Seed the full Appendix A + §8.10 register with defaults and calibration status; every Safety-class entry starts `PROVISIONAL` and is blocked from production by the Phase 15 gate |
| **Dependencies** | Phase 0 |
| **Risk level** | **MEDIUM** — retiring `dtaro.constants.js` touches `robotValidator.service.js` and `simulation/constants.js`; both must read from the register via a shim until their phases land |
| **Testing requirements** | Unit: scope resolution precedence incl. zone level; derived-parameter computation (`α[tier]`, `Ω_policy`, `energy.contingency_quantile`); every §22.1 rule-5 validation rejects a crafted bad config. Property: fixed-point milli-CU arithmetic is associative and order-independent over shuffled sets. Regression: existing `tests/unit/dtaro/*` still pass through the shim |
| **Completion criteria** | Every constant in `dtaro.constants.js` and `liveness.constants.js` resolvable through the Config Service; publish-time validator rejects each of the eight §22.1 rule-5 violations in a test matrix; `Ω_policy` and `α[tier]` are computed, never hand-entered; resolution-explain returns the supplying scope level for any parameter |

**Prerequisites:** Phase 0 complete. **Must precede:** every phase that reads a parameter (all).
**Parallel with:** nothing — this is the second root.

---

### PHASE 2 — Domain model and schema

**Purpose.** Land §2 (domain model), §3.6 (spatial hierarchy), and the §4.2/§4.3 state
vocabularies in the database. This is the largest single migration in the programme.

**Scope.** Agent, Task/Mission/Leg/Stop, Commitment, Custody, Observation, payload and capability
models, spatial hierarchy, decision-record skeleton. Data is migrated forward from existing
`Robot`/`Task` rows; the legacy columns remain readable until Phase 15.

| Field | Content |
|---|---|
| **Files to modify** | `prisma/schema.prisma` (major), `src/services/robot.service.js`, `src/controllers/robots.controller.js`, `src/controllers/tasks.controller.js` (read-compat only), `prisma/seed.js` |
| **Files to create** | `src/engine/domain/agent.js`, `mobilityModel.js`, `capability.js`, `work.js`, `purpose.js`, `custody.js`, `observation.js`, `src/engine/spatial/hierarchy.js`, `src/engine/spatial/cells.js`, `src/engine/domain/mappers/legacyRobot.js`, `mappers/legacyTask.js` |
| **Database migrations** | **(a)** `Agent` (extends Robot: `agentClass`, `authority_epoch` BIGINT, `fence_counter` BIGINT, `regionId`, `homeDepotId`, `lifecycleState`, `capacity` override). **(b)** `AgentClass`, `MobilityModel`, `EnergyModel`, `ContainerModel`, `Compartment`, `CapabilityBundle`, `Capability`. **(c)** `Mission`, `Leg` (with `purpose` enum, `version` INT, `state` enum, `custodyState` enum), `Stop` (with `stopType`, time window, service-time model ref, payload delta). **(d)** `Commitment` (id, agentId, legId, `fence` BIGINT, leaseExpiry, custodyState, planSnapshotRef, decisionRef, `version`, `kind='HARD'` CHECK). **(e)** `PayloadSpec`, `PayloadManifest`. **(f)** `Region`, `Zone` (extend: `regionId` FK, cell set), `Site`, `CellAssignment`. **(g)** `Observation` (append-only). **(h)** `DecisionRecordA` skeleton. **(i)** New enums: `LegState`, `LegPurpose`, `CustodyState`, `ObstructionClass`, `LifecycleState`. Existing `TaskStatus` extended per §4.2 (`AT_RISK`, `SUSPENDED`, `VERIFYING`, `PLANNABLE`, `RECEIVED`) |
| **Redis changes** | New key prefixes reserved (not yet written): `engine:agent:{id}`, `engine:idx:{shard}:{cell}`, `engine:snapshot:{roundId}`. Legacy `robot:*`, `registry:*` untouched this phase |
| **Socket.IO changes** | None (no behaviour change yet) |
| **REST API changes** | None externally; internal read models updated to join new tables |
| **Background workers** | One-shot backfill job: `tools/migrate/backfillDomain.js` (Robot→Agent, Task→Mission+Leg+2 Stops, `purpose='PRIMARY'`, `custodyState='NONE'`) |
| **Configuration updates** | `capacity[agent_class]` registered with default **1** (§27 item 7); region/zone/site/cell maps published as config (§3.6 — containment by assignment, not geometry) |
| **Dependencies** | Phase 1 |
| **Risk level** | **HIGH** — largest migration; touches every read path. Mitigation: additive-only DDL (no drops), dual-read compatibility layer, backfill is idempotent and re-runnable |
| **Testing requirements** | Migration: forward + rollback on a production-shaped dump; backfill idempotency (run twice → identical state); referential integrity for every FK. Unit: mappers round-trip legacy↔domain. Property: every legacy Task maps to exactly one Mission with exactly one `PRIMARY` Leg and two Stops. Regression: full existing suite green |
| **Completion criteria** | Schema matches §2 and §3.6; backfill converts 100 % of existing rows with zero orphans; `purpose`, `custodyState`, `authority_epoch`, `fence_counter` present and defaulted; spatial containment validator (§22.1) passes on seeded region/zone/cell maps; legacy endpoints unchanged in behaviour |

**Prerequisites:** Phase 1. **Must precede:** Phases 3–13. **Parallel with:** nothing.

---

### PHASE 3 — Commitment core (L3)

**Purpose.** Deliver §10 in full — the correctness core's centre. After this phase, exclusivity is
a durable, fenced, database-enforced property.

**Scope.** Two fencing scopes, commit transaction with guards G1–G6, SERIALIZABLE isolation,
schema backstops, lease grant, idempotency namespaces, clock discipline, advisory-only cache lock.

| Field | Content |
|---|---|
| **Files to modify** | `src/cache/kv.js` (`reserveRobot` demoted to advisory; remove fail-closed *throw* only after the durable path is live — see Risk), `src/db/prisma.js` (SERIALIZABLE-capable client + raw-SQL escape hatch), `src/services/task.service.js` (legacy path left intact but no longer the only writer) |
| **Files to create** | `src/engine/commitment/model.js`, `fencing.js`, `commit.js`, `guards.js`, `leases.js`, `idempotency.js`, `clock.js`, `src/engine/shard/leadership.js` (minimal: single static shard row + fence) |
| **Database migrations** | `Commitment` constraints: partial unique index enforcing ≤ `capacity[agent_class]` active commitments per agent (I1); CHECK constraint admitting HARD only (I18); `ShardLeadership` (shardId, `leadership_fence` BIGINT, holder, leaseExpiry); `AgentFenceAudit` high-water table for I6's windowed audit |
| **Redis changes** | `robotReserve:{agentId}` **retained but advisory** (§10.4) — loss degrades throughput only; the fail-closed throw is removed *after* the durable guard set is proven, not before |
| **Socket.IO changes** | None (dispatch is Phase 4) |
| **REST API changes** | None |
| **Background workers** | None |
| **Configuration updates** | `commit.max_serial_utilisation`, `lease.duration`, `time.max_clock_skew`, `shard.lease_duration`, `capacity[agent_class]` |
| **Dependencies** | Phase 2 |
| **Risk level** | **HIGH** — this is the mechanism whose failure double-commits a physical machine |
| **Testing requirements** | **Model checking (§24.2) is a gate for this phase, not a later one**: at `capacity` 1, 2 and 3, check ≤ capacity HARD commitments under worker pause, leader change, partition, duplicate delivery, reordering; check that commanding/reassigning/settling one commitment leaves another on the same agent commandable (I19); check no commit succeeds under a superseded leadership fence including a transaction spanning the change (G1). Unit: each guard G1–G6 aborts on its own violation and only its own. Integration: concurrent commit storm against one agent yields exactly one winner. Chaos: pause a worker mid-finalisation beyond lease duration, resume, assert abort |
| **Completion criteria** | Commit runs at SERIALIZABLE (or REPEATABLE READ + `FOR UPDATE` on both agent and Leg); all six guards implemented and individually tested; schema constraints reject violations independently of application logic; two-scope fence allocation correct and monotonic; TLA+ (or equivalent) model checked clean at capacity ≥ 2; I1, I5, I6, I18, I19 verifiable |

**Prerequisites:** Phase 2. **Must precede:** Phases 4, 5, 10, 12, 13.
**Parallel with:** Phases 6 and 7 (decision-path track has no dependency on commitment).

> **Near-circular dependency — resolved.** Guard G1 requires `shard.leadership_fence`, which
> belongs to the shard model (Phase 13). Resolution: Phase 3 creates the `ShardLeadership` table
> with a **single static shard row and a manually-advanced fence**, and implements G1 against it.
> Phase 13 replaces the static row with real leader election. G1's code does not change.

---

### PHASE 4 — Dispatch and the agent protocol (L2)

**Purpose.** Deliver §11 — transactional outbox, offer semantics, durable agent-side dedup — and
the §23.3 command-integrity rules that the agent must enforce.

**Scope.** Outbox write inside the commit transaction, outbox drain worker, OFFER/ACCEPT/REJECT/
DEFER, offer TTL and withdrawal, escalation ladder, per-commitment sequence ordering, durable
dedup with `dedup_state_generation` handshake, fence rejection on the agent side.

| Field | Content |
|---|---|
| **Files to modify** | `src/services/commandDispatcher.service.js` (becomes the outbox's delivery arm; every send routed through the outbox — §4.1 rule 5), `src/sockets/handlers/robot.handler.js` (AUTH extended with dedup high-water-mark handshake), `src/sockets/handlers/command.handler.js` (ACK correlation extended to offers), `src/sockets/socket.server.js` (register offer handler), `src/simulation/VirtualRobot.js` (**major** — implements agent-side contract) |
| **Files to create** | `src/engine/dispatch/outbox.js`, `offers.js`, `escalation.js`, `dedupHandshake.js`, `sequence.js`, `src/sockets/handlers/offer.handler.js`, `src/workers/outbox.worker.js`, `src/engine/security/commandSigning.js` |
| **Database migrations** | `Outbox` (id, commitmentId/agentId, commandClass, fenceScope, fence/authorityEpoch, sequence, payload, notValidAfter, signature, state, attempts, claimedBy, claimedAt, deliveredAt) with index on `(state, notValidAfter)`; `AgentDedupState` (agentId, `dedup_state_generation`, authorityEpoch, fenceFloor, reportedAt) |
| **Redis changes** | New: `engine:outbox:claim:{workerId}` (claim lease, advisory), `engine:offer:{commitmentId}` (offer TTL mirror, advisory). Retire nothing |
| **Socket.IO changes** | **New server→agent:** `OFFER`, `WITHDRAW`, `REROUTE`, `RESEQUENCE`, `RECALL`, `RESUME`, `TRANSFER_CUSTODY`, `ABORT_MISSION` (mission scope); `STAND_DOWN_ALL`, `QUARANTINE`, `RELEASE_QUARANTINE`, `ESTOP_CLEAR`, `SHARD_MIGRATE`, `SESSION_REKEY`, `PARAMETER_PUSH` (agent scope); `STATUS_REQUEST`, `PROBE`, `MANIFEST_QUERY` (unfenced queries). **New agent→server:** `OFFER_ACCEPT`, `OFFER_REJECT`, `OFFER_DEFER`, `COMMAND_ACK` (extended), `DEDUP_STATE` (at AUTH). **Legacy `TASK_ASSIGN`/`STOP`/`COMMAND` retained** for the legacy path until Phase 15 cutover |
| **REST API changes** | None |
| **Background workers** | `outbox.worker.js` — claims, delivers, retries with bounded backoff, escalates per §11.4; emits outbox depth and oldest-undelivered-age SLIs |
| **Configuration updates** | `dispatch.offer_ttl`, `retry_window`, `nack_cooloff`, `systemic_threshold`, `max_delivery_delay`, `agent.dedup_retention`, `health.unresponsive_strikes` |
| **Dependencies** | Phase 3 |
| **Risk level** | **HIGH** — protocol change; real-robot firmware must implement the same contract. Mitigation: VirtualRobot is the reference implementation and the conformance fixture |
| **Testing requirements** | Unit: fence rejection per commitment id (not per agent max); `fence_floor` invalidates all mission authorities; unknown-commitment command rejected via `fence_floor`, not admitted for lack of history. Integration: full offer round-trip incl. REJECT and DEFER paths. **Chaos (§24.5): power-cycle a simulated agent mid-mission wiping dedup state; redeliver every applied command; assert advanced `dedup_state_generation` at AUTH, suppressed redelivery, advanced `authority_epoch`, zero double-application (I21).** Ordering: `RECALL` never applied before its `OFFER` |
| **Completion criteria** | No command reaches an agent except via an outbox row written in the authorising transaction; agent dedup durable across restart with generation counter; command→fence-scope table (§10.3.1) implemented exactly; escalation ladder steps 1–4 operational; I21 verifiable |

**Prerequisites:** Phase 3. **Must precede:** Phases 5, 10, 12.
**Parallel with:** Phases 6, 7, 8.

---

### PHASE 5 — Supervision and reconciliation (L2)

**Purpose.** Deliver §12 and §4.5 — the mechanism that makes "stuck forever" structurally
impossible, which is the audit's largest single class of defect.

**Scope.** Durable timer store keyed on entity version, timer worker, per-commitment lease renewal
requiring positive evidence, lease expiry → custody-aware recovery, progress supervision,
reconciliation loop, graded completion verification with the three track-plausibility tests.

| Field | Content |
|---|---|
| **Files to modify** | `src/sockets/socket.server.js` (offline sweep **absorbed** into the reconciler; the standalone `setInterval` retires), `src/services/taskRecovery.service.js` (**absorbed** into reconciler orphan scan; file retires at Phase 15), `src/sockets/handlers/telemetry.handler.js` (feeds progress supervision), `src/sockets/handlers/dtaro.handler.js` (TASK_COMPLETE → verification pipeline) |
| **Files to create** | `src/engine/supervision/timers.js`, `leases.js`, `progress.js`, `reconciler.js`, `verification.js`, `src/engine/lifecycle/legMachine.js`, `taskMachine.js`, `transitions.js`, `src/engine/lifecycle/settlement.js`, `src/workers/timer.worker.js`, `src/workers/reconciler.worker.js` |
| **Database migrations** | `Timer` (id, entityType, entityId, state, entityVersion, dueAt, handler, payload) with index `(dueAt)` — the durable timer store §3.3 requires; `ReconcilerRepair` (category, entityId, action, at) for repair-rate SLIs; `VerificationEvidence` |
| **Redis changes** | New: `engine:timerlag` (SLI gauge). Timers are **DB-authoritative**; Redis is not used for supervision state (cache-authority rule, §3.3) |
| **Socket.IO changes** | Uses `PROBE`, `STATUS_REQUEST`, `MANIFEST_QUERY` from Phase 4; no new events |
| **REST API changes** | New `GET /api/legs/:legId/supervision` (operator visibility: current state, deadline, owning timer) |
| **Background workers** | `timer.worker.js` (fires due timers, at-least-once, idempotent handlers); `reconciler.worker.js` (event-driven + periodic full sweep < 60 s, all nine divergence classes of §12.4) |
| **Configuration updates** | `supervise.stall_time`, `max_timer_lag`, `execute.eta_tolerance`, `start_grace`, `recover.*`, `verify.*` incl. the three track-plausibility thresholds, `agent.autonomous_continuation_limit` |
| **Dependencies** | Phases 3, 4 |
| **Risk level** | **HIGH** — timer keying is a correctness requirement (§4.5): keying on the agent's epoch instead of the entity's own version silently removes supervision from concurrent missions |
| **Testing requirements** | Unit: every non-terminal state registers a timer on entry and cancels atomically on exit (I4); a timer whose entity version moved on is discarded on fire; lease renewal requires commitment-scoped evidence, not a generic ping. Model check: every non-terminal state eventually leaves under fair timer firing; custody never lost (`HELD` → `RELEASED`/`DISPUTED`). Chaos: kill the timer worker mid-sweep; assert no missed transition after restart. Verification: each of the three plausibility tests rejects its own crafted failure and no other |
| **Completion criteria** | Every §4.2/§4.3 deadline has a durable timer; reconciler repairs all nine §12.4 divergences and counts each; repair rate is an alertable SLI; completion verification graded L0–L3 with stated thresholds; settlement enforces custody-release-before-commitment-release (I7); I3, I4, I7, I8, I12, I13 verifiable |

**Prerequisites:** Phases 3, 4. **Must precede:** Phases 10, 12.
**Parallel with:** Phases 6, 7, 8, 9.

---

### PHASE 6 — Feasibility gate (L4)

**Purpose.** Deliver §7 in full — 38 predicates, three-valued logic, systemic guard, caching,
rejection telemetry. This is the largest Tier 0 surface by predicate count.

**Scope.** All 38 predicates as pure functions, per-predicate indeterminate policy, the systemic
guard, three-tier caching with reason-derived TTLs, the enumerated volatile subset, rejection
tuples with streaming aggregation.

| Field | Content |
|---|---|
| **Files to modify** | `src/services/robotValidator.service.js` (**replaced** — retires at Phase 15), `src/cache/robotStateCache.js` (extended for predicate caching), `src/config/logger.js` (`logger.dtaro` superseded by rejection telemetry) |
| **Files to create** | `src/engine/feasibility/evaluate.js`, `threeValued.js`, `systemicGuard.js`, `cache.js`, `volatileSubset.js`, `rejectionTelemetry.js`, `register.js`, and `src/engine/feasibility/predicates/f01..f38.js` (38 modules, one per predicate, each a pure function of `(agentSnapshot, mission, plan, config)`) |
| **Database migrations** | `RejectionAggregate` (shard, zone, missionClass, legPurpose, predicateId, tier, bucket, count) for the binding-constraint distribution; `NearMissSketch` (quantile sketch state per predicate) |
| **Redis changes** | New: `engine:feas:agent:{agentId}` (F1–F12 agent-invariant results, invalidated on lifecycle/health/capability/firmware/cert change), `engine:feas:class:{agentClass}:{missionClass}:{zone}` (tier-2 cache), `engine:feas:neg:{pairKey}` (negative cache, **TTL derived from rejection reason**, never global) |
| **Socket.IO changes** | None |
| **REST API changes** | New `GET /api/diagnostics/rejections?zone=&class=&purpose=` (binding-constraint distribution and near-miss margins — the capacity-planning instrument of §7.7) |
| **Background workers** | Aggregation flusher (folds in-memory histograms to `RejectionAggregate`) |
| **Configuration updates** | `feasibility.systemic_indeterminacy_threshold`, `degraded.max_duration`, `max_last_known_age`, `reserve_factor`, `cost.uncertainty_penalty[predicate]`, per-predicate indeterminate policy (Safety-class for I/R predicates) |
| **Dependencies** | Phase 2 (domain), Phase 7 (F34/F35 need the energy model), Phase 1 (config) |
| **Risk level** | **MEDIUM-HIGH** — breadth, not depth. The risk is a predicate quietly admitting an infeasible pairing |
| **Testing requirements** | Unit: **each of the 38 predicates tested exhaustively at its boundaries, all three outcomes, and its declared indeterminate policy** (§24.1). Property: relaxing a constraint never shrinks the feasible set. Build gate: type separation makes cost evaluation structurally unable to see an infeasible candidate (I14, static analysis). Integration: systemic guard trips at the configured fraction and enters Restricted Operation without relaxing any I/R predicate. Cache: a stale positive cannot survive the commit-time volatile re-check |
| **Completion criteria** | All 38 predicates implemented, pure, individually tested; class I/R predicates all `DENY` on indeterminate; volatile subset is the enumerated list (F7, F8, F10, F13, F14, F16, F17, F18, F20, F34, F35), machine-checkable; rejection aggregation exact over 100 % of decisions; F10 requires independent corroboration; I9, I14 verifiable |

**Prerequisites:** Phases 1, 2, 7. **Must precede:** Phases 8, 10.
**Parallel with:** Phases 3, 4, 5.

---

### PHASE 7 — Energy and payload models

**Purpose.** Deliver §14 and §15 — the physical models that F22–F26 and F34–F35 depend on.
Sequenced before the feasibility gate because those predicates cannot be written without them.

**Scope.** Wh consumption model including payload-thermal, usable energy with SoH and combined
conservatism cap, battery wear, layered reserves, tiered shortfall constraint, `E_return` against
the pinned charger projection, charge curve, mid-mission management, container model, tiered
packing, load state along the plan.

| Field | Content |
|---|---|
| **Files to modify** | `src/simulation/constants.js` and `src/simulation/VirtualRobot.js` (battery model must match the server's — §14.6 requires both sides to reason from identical inputs), `src/config/dtaro.constants.js` (**retired** — the 20 %/30 % floors are replaced, not re-tuned) |
| **Files to create** | `src/engine/energy/consumption.js`, `usable.js`, `wear.js`, `reserves.js`, `tiers.js`, `eReturn.js`, `chargeCurve.js`, `midMission.js`, `chargingSchedulerClient.js`, `src/engine/payload/spec.js`, `container.js`, `packing.js`, `loadState.js`, `custodyEvidence.js`, `src/engine/routing/chargerReachabilityCache.js` |
| **Database migrations** | `EnergyModelParams` per agent class (β coefficients incl. `β_payload_thermal`, κ per agent), `BatteryState` (SoH, internal resistance trend, cycle count), `ChargerAvailabilityProjection` (version, publishedAt, payload, immutable), `Charger`, `ChargerReservation`, `PackingResultCache` |
| **Redis changes** | New: `engine:charger:proj:{version}` (pinned projection mirror), `engine:charger:reach:{cell}:{profile}:{bucket}:{projVersion}` (charger-reachability cache — **projection version in the key**, §20.3 item 3), `engine:pack:{containerConfig}:{itemSignature}` (memoised packing, §15.3 tier 4). Retire `vr:battery:*` semantics into the modelled path |
| **Socket.IO changes** | Offer payload gains `energyReserveParams` and `targetSoc` (§11.2) — consumed by VirtualRobot |
| **REST API changes** | New `GET /api/diagnostics/energy/:agentId` (reserve breakdown, binding tier, margin) |
| **Background workers** | Charger-reachability precomputation on each projection publication (§20.3 item 3); κ(a) EWMA updater at settlement |
| **Configuration updates** | `energy.event_budget_per_fleet_year[T1..T3]` (Safety, fleet-year governed — `α[tier]` derived), `contingency_quantile` (derived), `charger_availability_margin`, `charger_projection_max_age`, `target_soc_max_age`, `target_soc_fallback`, `deviation_tolerance`, `uncalibrated_reserve_factor`, `max_combined_conservatism`, `payload.safety_factor`, `packing_efficiency` |
| **Dependencies** | Phases 1, 2 |
| **Risk level** | **HIGH** — Safety-class parameters; a wrong reserve strands agents. Also depends on an **external Charging Scheduler that does not exist** (see §6.1 Blocking decisions) |
| **Testing requirements** | Unit: consumption model conservation; charge-curve integration against vendor curve fixtures; each of the three F34 tier conditions evaluated independently; `α[tier]` derived from fleet-year budget, never hand-set; contingency quantile derived from `α₁`. Property: energy never increases except while charging; reserve layers never traded. Integration: `E_return` against a pinned projection is deterministic and replayable; projection staleness beyond max age falls back to depot-only. Simulation: T1/T2/T3 event frequencies match budgeted rates in a long simulated run (I17 at T1/T2 timescales) |
| **Completion criteria** | Energy is modelled in Wh, never as a percentage floor; three tiers evaluated simultaneously with binding tier recorded per rejection; combined conservatism computed and capped at publish time; packing tiers 1–4 implemented with `INDETERMINATE`/`DENY` on tier-3 budget exhaustion; target SoC consumed as an input, never computed by the engine |

**Prerequisites:** Phases 1, 2. **Must precede:** Phases 6, 8.
**Parallel with:** Phases 3, 4, 5.

---

### PHASE 8 — Cost function and plan builder (L4)

**Purpose.** Deliver §8 and §13 — `Φ(plan)` in absolute CU with every term, and the Plan Builder
whose output is the single artefact both feasibility and cost consume.

**Scope.** All seven cost terms, sign discipline, Leg-level delay attribution, plan construction
with per-stop timeline/energy/payload projection, insertion evaluation, column pricing.

| Field | Content |
|---|---|
| **Files to modify** | `src/services/costEvaluator.service.js` (**replaced** — min-max normalisation is prohibited by §1.3; retires at Phase 15), `src/services/task.service.js` (route helpers relocate to the Plan Builder) |
| **Files to create** | `src/engine/cost/phi.js`, `cDirect.js`, `cOpportunity.js`, `cRisk.js`, `cLifecycle.js`, `cPolicy.js`, `cDelay.js`, `cDefer.js`, `cChurn.js`, `signDiscipline.js`, `src/engine/plan/planBuilder.js`, `insertion.js`, `column.js`, `columnBuilder.js`, `timeline.js`, `src/engine/pricing/capacityPricingClient.js`, `forecastClient.js`, `src/engine/pricing/vTerminal.js` |
| **Database migrations** | `ServiceTimeModel` (site, stopType, missionClass, hourOfWeek, distribution params — learned per §13.2); `ZonePriceSnapshot` (zone, bucket, λ, version, `Ω_terminal` published alongside) |
| **Redis changes** | New: `engine:price:{version}` (pinned λ_zone surface), `engine:route:cell:{originCell}:{destCell}:{profile}:{bucket}` (cell-pair travel-time cache, §20.3 item 2) |
| **Socket.IO changes** | None |
| **REST API changes** | None (cost is exposed via the Explanation API in Phase 11) |
| **Background workers** | Service-time model fitter (hierarchical shrinkage, §13.2); λ_zone estimator refresh (Capacity Pricing, regional) |
| **Configuration updates** | Full §8.10 register: `cost.cu_per_currency_unit`, `lambda_time[class]`, `lambda_time_floor`, `energy.cu_per_wh`, `wear.cu_per_metre`, `failure.cu[...]`, `energy_consequence[tier]`, `sla.*`, `aging.*` (incl. bounded `max_multiplier`), `opportunity.*` (incl. `value_horizon` > commitment horizon + max mission duration), `policy.max_*_credit` with `Ω_policy` derived |
| **Dependencies** | Phases 1, 2, 6, 7 |
| **Risk level** | **HIGH** — this is the mathematically delicate surface; §8.3's derivation must be implemented exactly (origin-zone integral + same-time terminal difference), not approximated |
| **Testing requirements** | Unit: each term in isolation, with units asserted; `C_opportunity` telescoping identity holds numerically (the two brackets cancel at the intermediate term); the integral is over the **origin zone at fixed position**, never along the route; both relocation evaluations at `t_release`. Property: 10 km mission costs more than 1 km all else equal (a property min-max cannot satisfy); `C_direct`, `C_risk`, `C_lifecycle`, `C_delay`, `C_churn` never negative; `C_opportunity` ≥ `−Ω_terminal`; `C_policy` ≥ `−Ω_policy`. Build gate: `V_terminal` carries no weighting coefficients. Unit: multi-Leg delay attribution — exactly one terminal Leg carries the full term and `M_breach`, upstream Legs carry slack-consumption only. Consistency: `γ(c)` recomputed from `Φ(plan(c)) − Φ(plan₀)` equals the value given to the solver, exactly, in integer milli-CU |
| **Completion criteria** | Every cost in int64 milli-CU; no normalisation anywhere in the path; aging multiplier capped; delay attribution rule implemented; plan is the sole artefact feasibility and cost share; insertion priced as one functional at two plans with no separate insertion model |

**Prerequisites:** Phases 1, 2, 6, 7. **Must precede:** Phases 9, 10.
**Parallel with:** Phases 3, 4, 5 (commitment track).

> **Intra-phase co-dependency (not circular).** The Plan Builder produces plans; `Φ` prices them;
> insertion enumeration calls `Φ`. These are mutually referential and are therefore delivered in
> one phase, with `Φ` depending only on a *finished* plan object and never on the enumerator.

---

### PHASE 9 — Candidate generation and the admissible bound (L4)

**Purpose.** Deliver §6 — hierarchical spatial search with a bound that is provably admissible,
replacing the unordered `LIMIT 100` query.

**Scope.** Availability Index over H3/S2 cells with availability classes, tiers 0–6 expansion,
`LB(a,l)` with `Ω_terminal`/`Ω_policy` corrections, additive CU tolerance, achieved-bound
recording on truncation, canonical determinism, cluster-shared candidate sets.

| Field | Content |
|---|---|
| **Files to modify** | `src/services/taskAssignment.service.js` (**replaced** — retires at Phase 15), `src/services/robotRegistry.service.js` (`robots:all` superseded by the cell-partitioned index) |
| **Files to create** | `src/engine/candidates/availabilityIndex.js`, `expansion.js`, `lowerBound.js`, `omega.js`, `ordering.js`, `clusterShare.js`, `src/engine/spatial/cells.js` (H3 wrapper) |
| **Database migrations** | `AgentCellPosition` (durable mirror for index rebuild); index on `(shardId, coarseCell, fineCell, availabilityClass)` |
| **Redis changes** | New: `engine:idx:{shard}:{fineCell}:{availClass}` (sorted set of agent ids), `engine:idx:{shard}:{coarseCell}` (regional sweep), rebuilt from the observation log on Cold Index (§18.5). **Loss must be survivable** — index staleness costs quality, never correctness, because feasibility is re-verified at commit |
| **Socket.IO changes** | None |
| **REST API changes** | New `GET /api/diagnostics/candidates/:legId` (cells explored, smallest unexplored bound, achieved gap in CU) |
| **Background workers** | Index maintainer (consumes observations, moves agents between cells and availability classes) |
| **Configuration updates** | `candidate.target_feasible`, `max_evaluated`, `max_expansion_tiers`, `max_radius_by_sla_class`, `optimality_tolerance_cu` (**additive**, per §6.4), `finishing_soon_horizon` |
| **Dependencies** | Phases 2, 7, 8 |
| **Risk level** | **MEDIUM-HIGH** — an inadmissible bound silently discards the optimum while advertising a proof |
| **Testing requirements** | **Build gate (§24.1): `LB ≤ γ` checked exhaustively over the configured parameter space — every `C_policy` ceiling, every published λ_zone range, every agent class, every SLA class — and the build fails on any combination admitting `LB > γ`.** Re-run at every config publish. Unit: `Ω_terminal` computed from the same price snapshot the cost function used; `Ω_policy` derived at publish. Property: tolerance is additive and well-defined for negative `C*`. Determinism: identical candidate list for identical inputs across runs and processes. Scale: index lookup cost independent of fleet size (T9) |
| **Completion criteria** | Expansion driven by the pruning rule, not a fixed ring count; achieved bound recorded in CU on every truncation; admissibility is a build gate, not a sampled property; candidate ordering canonical; I20's search-gap half verifiable |

**Prerequisites:** Phases 2, 7, 8. **Must precede:** Phase 10. **Parallel with:** Phases 3, 4, 5.

---

### PHASE 10 — Round loop and solve (L4 → L3)

**Purpose.** Deliver §9 and §3.4's round path — the coordinator loop that ties candidate
generation, feasibility, pricing, solving, and commitment into one supervised round. This phase
replaces the `setImmediate` detached assignment that is the root cause of the audit's "stuck at
PENDING with no record of the failure".

**Scope.** Round cadence with adaptive window, fast path as batch-of-one, singleton-regime min-cost
flow, solve budgets and anytime behaviour, spatial partitioning of oversized batches, commit
integration, decision-record emission. **Deferral variable present but disabled by kill switch;
column regime present but disabled** (both Tier 2, enabled in Phase 16).

| Field | Content |
|---|---|
| **Files to modify** | `src/services/task.service.js` (`assignTask` intake path rewired to enqueue rather than detach; `setImmediate` block **removed**), `src/controllers/tasks.controller.js`, `src/sockets/socket.server.js` (`assign_task` legacy socket path routed to intake) |
| **Files to create** | `src/engine/solve/round.js`, `cadence.js`, `objective.js`, `minCostFlow.js`, `budgets.js`, `regime.js`, `src/engine/intake/intake.js`, `admission.js`, `src/engine/shard/planState.js` (round-local SOFT reservations, **in-memory only**), `src/workers/coordinator.worker.js` |
| **Database migrations** | `WorkQueue` (durable priority queue of pending Legs per shard, §3.2); `Round` (roundId, shardId, decisionTime, snapshotRefs, regime, budgets, outcome) |
| **Redis changes** | New: `engine:queue:{shard}` (advisory queue mirror for fast peek; **DB is authoritative**), `engine:round:{shard}:current` (liveness only). **SOFT reservations are never written to Redis or Postgres** (§2.6, I18) — they live in coordinator process memory |
| **Socket.IO changes** | None new; the round drives Phase 4's offer events |
| **REST API changes** | `POST /api/tasks/assign` response contract changes: returns task id, idempotency echo, queue position, and an **honest predicted assignment window** (§3.4). It MUST NOT imply an assignment has occurred |
| **Background workers** | `coordinator.worker.js` — the shard round loop: collect batch → candidates → feasibility → price → solve → commit → dispatch → record |
| **Configuration updates** | `solve.window_min/max/saturated`, `max_legs_per_round`, `time_budget`, `improvement_budget`, `fast_path_classes`, `plan.max_columns_per_round`, `commitment_horizon`, `hardening_deadline` |
| **Dependencies** | Phases 3, 4, 5, 6, 8, 9 |
| **Risk level** | **HIGH** — the integration point of every prior phase |
| **Testing requirements** | Unit: singleton regime is solved by min-cost flow and reports **zero LP–IP gap**; a round containing any multi-Leg column MUST NOT report exact-integer duals (regime guarantee test, §24.1). Integration: fast path is literally the batch path at a batch of one Leg — enforced by a build-time test, not by review. Determinism: replay of a stored round reproduces the identical allocation and identical per-candidate costs byte-for-byte (§9.6 acceptance test). Anytime: exceeding the time budget returns the incumbent with its bound, never nothing and never a hang. Failover: kill the coordinator with SOFT reservations outstanding; every affected Leg is re-planned, none lost, none double-committed when the previous leader's in-flight commit lands late (guard G1) |
| **Completion criteria** | No detached background assignment anywhere in the path; every round produces a decision record; SOFT reservations round-local and reconstructed (never recovered) on failover; solve is exact in the singleton regime; deferral and column regime present but switched off; I3, I10 verifiable |

**Prerequisites:** Phases 3, 4, 5, 6, 8, 9. **Must precede:** Phases 11, 12, 13, 16.
**Parallel with:** nothing — this is the convergence point.

---

### PHASE 11 — Observability, decision records, explainability

**Purpose.** Deliver §21 — Tier A/Tier B records, the Explanation API, the SLI set, and the
calibration loop. Explainability is a functional requirement (T8), not instrumentation.

**Scope.** Two-tier records with bounded exemption list, reconstruction-by-replay, Explanation API
with source labelling, full metric set, prediction calibration, shadow mode, offline evaluator.

| Field | Content |
|---|---|
| **Files to modify** | `src/services/metrics.service.js` (extended to the §21.4 set), `src/app.js` (`/health` gains SLI surface), `src/config/logger.js` (log-volume discipline: per-candidate detail leaves the log stream), `src/routes/index.js` |
| **Files to create** | `src/engine/observability/decisionRecord.js`, `tierA.js`, `tierB.js`, `sampling.js`, `explanation.js`, `metrics.js`, `sli.js`, `calibration.js`, `shadow.js`, `src/controllers/explain.controller.js`, `src/routes/explain.routes.js`, `tools/replay/replayDecision.js`, `tools/evaluator/counterfactual.js` |
| **Database migrations** | `DecisionRecordA` (complete per §21.2 Tier A table incl. leadership fence, versions, regime, kill-switch state, Ω values, gaps, degradation, deferral reason), `DecisionRecordB` (sampled), `InputSnapshot` (immutable, retained ≥ Tier A), `CalibrationObservation`, `AuditEvent` (hash-chained, §21.7) |
| **Redis changes** | New: `engine:sli:*` (counters/gauges scraped by the metrics endpoint). No decision data in Redis — the Decision Log is durable and append-only (§3.3) |
| **Socket.IO changes** | None |
| **REST API changes** | New `GET /api/explain/:decisionId` (why this agent / why not X / still waiting / **why deferred while a robot sat idle** / what would change it / what it cost / what happened), each answer labelled `TIER_A` \| `TIER_B` \| `RECONSTRUCTED` |
| **Background workers** | Tier B sampler + budget enforcer with reservoir fallback; calibration comparator at settlement; shadow-mode runner; scheduled counterfactual evaluator |
| **Configuration updates** | `observability.full_retention`, `compact_top_n`, `tier_b_sample_rate`, `tier_b_retention`, `tier_b_write_budget`; snapshot retention ≥ Tier A retention (validated at publish) |
| **Dependencies** | Phase 10 |
| **Risk level** | **MEDIUM** — the risk is volume, and the two-tier design is what bounds it |
| **Testing requirements** | **Reconstruction-equivalence build gate (§24.3): for every corpus decision with a Tier B record, reconstruction from Tier A alone reproduces it byte for byte.** Golden replay corpus on every build; continuous production replay on a sample. Sizing: Tier A ≤ 2 KB/decision and `O(1)` in candidate count. Aggregation: binding-constraint histograms exact over 100 % of decisions despite Tier B sampling. Exemption bound: a shard-wide degraded mode does **not** convert to full retention |
| **Completion criteria** | Every decision has a Tier A record; Tier B sampled and budgeted with a bounded exemption list; Explanation API answers all seven queries with source labelling; calibration SLIs live per predictor; shadow mode operational before any coefficient is tuned; I10, I15 verifiable |

**Prerequisites:** Phase 10. **Must precede:** Phases 15, 16 (shadow mode is the Tier 2 gate).
**Parallel with:** Phases 12, 13.

---

### PHASE 12 — Failure handling, degraded modes, invariant checker

**Purpose.** Deliver §18 and §26 — named degraded modes with explicit invariant suspension, the
full failure catalogues, and the independent Invariant Checker with its three statuses.

**Scope.** Degraded-mode register (Restricted Operation, Custodial Operation, Unsupervised
Commitment, Degraded Routing, Cold Index, Shed Load), agent and infrastructure catalogues,
external escalation for obstructing strandings, invariant checker reporting
`ENFORCED`/`VIOLATED`/`SUSPENDED`, the §26.2 matrix.

| Field | Content |
|---|---|
| **Files to modify** | `src/services/commandDispatcher.service.js` (mode-aware: Custodial Operation issues **no commands**), `src/engine/supervision/leases.js` (renewal stops rather than falling back to a cached lease), `src/sockets/handlers/dtaro.handler.js` (ROBOT_FAULT → catalogue), `src/app.js` (`/health` exposes mode + invariant status) |
| **Files to create** | `src/engine/degraded/modeRegister.js`, `transitions.js`, `src/engine/failure/catalogue.js`, `agentFailures.js`, `infraFailures.js`, `externalEscalation.js`, `src/engine/observability/invariantChecker.js`, `src/engine/map/obstructionClass.js`, `src/workers/invariant.worker.js` |
| **Database migrations** | `DegradedModeEvent` (shard, mode, enteredAt, exitedAt, cause, suspendedInvariants[]), `InvariantStatus` (invariantId, shard, status, checkedAt, detail), `ExternalEscalation` (legId, step, contactSet, at, disposition) |
| **Redis changes** | New: `engine:mode:{shard}` (current mode broadcast, advisory — the DB event stream is authoritative) |
| **Socket.IO changes** | Dashboard-facing: `DEGRADED_MODE_ENTERED` / `DEGRADED_MODE_EXITED`, `INVARIANT_STATUS_CHANGED`, `STRANDING_ESCALATED` |
| **REST API changes** | New `GET /api/health/invariants` (per-invariant status with the mode that authorised any suspension), `GET /api/health/modes` |
| **Background workers** | `invariant.worker.js` — continuous verification **independent of the code paths that maintain the invariants** (a checker sharing logic with the enforcer verifies nothing); windowed monotonicity audit for I6 |
| **Configuration updates** | `degraded.*`, `ops.stranded_*_response_target`, `agent.autonomous_continuation_limit`, external escalation contact sets per region with named owner |
| **Dependencies** | Phases 3, 5, 10 |
| **Risk level** | **MEDIUM-HIGH** — modes must never promote the cache to an authority and never relax an I/R constraint |
| **Testing requirements** | Simulation (§24.4): drive entry into and exit from **every** named mode and verify the observed invariant statuses match the §26.2 matrix exactly — including that no invariant reports `VIOLATED` where the matrix says `SUSPENDED` or `D`. Chaos: remove the Commitment Store for longer than `agent.autonomous_continuation_limit`; assert Custodial Operation entered, no commands issued, I2 reported `SUSPENDED` not `VIOLATED`, agents halt at safe locations, full reconciliation precedes round resumption. Unit: obstruction class `INDETERMINATE` resolves to `STRANDED_OBSTRUCTING` |
| **Completion criteria** | Six named modes implemented with entry/exit events and suspension sets; §26.2 matrix reproduced exactly in code and verified in simulation; invariant checker independent and reporting three statuses; external escalation chain implemented with step 4 human-gated; I2, I16, I22 verifiable |

**Prerequisites:** Phases 3, 5, 10. **Must precede:** Phase 15.
**Parallel with:** Phases 11, 13.

---

### PHASE 13 — Sharding, leadership, and the single writer

**Purpose.** Deliver §19 and §3.5 — region sharding, leader-elected single-writer coordinators,
real `shard.leadership_fence`, shard sizing enforcement, agent migration, cross-region sagas.

**Scope.** Shard membership, consensus-backed leases, leadership fence advance on change, failover
reconciliation (recover durable, reconstruct volatile), shard sizing validation, agent migration
via `authority_epoch`, cross-region decomposition at intake.

| Field | Content |
|---|---|
| **Files to modify** | `server.js` (coordinator lifecycle, leadership acquisition, shutdown drain), `src/engine/shard/leadership.js` (static row → real election), `src/engine/intake/intake.js` (shard resolution at intake), `src/engine/commitment/commit.js` (no change to G1 — it already reads the fence) |
| **Files to create** | `src/engine/shard/shardModel.js`, `membership.js`, `election.js`, `failover.js`, `sizing.js`, `crossRegion.js`, `src/workers/shardSupervisor.worker.js` |
| **Database migrations** | `Shard` (id, regionId, state), `ShardMembership` (agentId, shardId, movedAt — transactional handoff, never inferred from position drift), `CrossRegionSaga` (missionId, steps, compensation state), `TransferPoint` |
| **Redis changes** | Socket.IO Redis adapter already present (`server.js:45-67`) — retained and now **required**, not optional. New: `engine:shard:leader:{shardId}` (advisory hint only; the consensus store is authoritative) |
| **Socket.IO changes** | `SHARD_MIGRATE` (agent-scope command from Phase 4) becomes operational |
| **REST API changes** | New `GET /api/shards` (membership, leader, both sizing bounds with the binding one reported), `POST /api/shards/:id/rebalance` (control plane, elevated role) |
| **Background workers** | `shardSupervisor.worker.js` — lease renewal, failover detection, membership migration one agent at a time |
| **Configuration updates** | `shard.lease_duration`, `commit.max_serial_utilisation`, region/shard definitions validated against the §3.5 sizing inequality at publish |
| **Dependencies** | Phases 3, 10 |
| **Risk level** | **HIGH** — split-brain is the failure mode. Mitigation: leadership is enforced at the database by G1, which already shipped in Phase 3 and is unchanged here |
| **Testing requirements** | Chaos: kill coordinators at random and mid-commit; asymmetric partitions (which break naive election); verify the isolated coordinator stops committing and its late commits abort at the store via G1. Model check: no commit succeeds under a superseded leadership fence including a transaction spanning the change. Failover: durable state recovered, SOFT reservations reconstructed and counted separately from genuine orphan repairs. Scale: **the locality test (§24.6)** — identical benchmarks against a shard in a small fleet and a shard in a million-agent fleet produce statistically indistinguishable round times |
| **Completion criteria** | Exactly one active coordinator per shard, enforced by consensus lease **and** by G1; leadership fence advanced on every change; failover reconciles before resuming rounds; both sizing bounds monitored with the binding one reported; migration advances `authority_epoch` per agent; locality test passes |

**Prerequisites:** Phases 3, 10. **Must precede:** Phase 15.
**Parallel with:** Phases 11, 12.

---

### PHASE 14 — Security, governance, and privacy

**Purpose.** Deliver §23 and the remaining §22 governance surface.

**Scope.** mTLS with per-device certificates and hardware-backed keys, capability attestation,
signed commands with `not_valid_after`, authorisation scoping, trust boundaries for agent-reported
data, manual override discipline, PII separation with surrogate keys and erasure.

| Field | Content |
|---|---|
| **Files to modify** | `src/sockets/handlers/robot.handler.js` (pairing code + session token → mTLS + attestation; pairing retained only as a commissioning bootstrap), `src/middlewares/auth_middleware.js` (scoped RBAC/ABAC), `src/controllers/robots.controller.js` (override discipline), `src/config/cors.js`, `server.js` (TLS termination config) |
| **Files to create** | `src/engine/security/attestation.js`, `commandSigning.js`, `sessionBinding.js`, `trustBoundaries.js`, `override.js`, `src/engine/privacy/identityStore.js`, `surrogateKeys.js`, `erasure.js` |
| **Database migrations** | `AgentCertificate`, `CapabilityAttestation` (signed firmware/hardware manifest), `IdentityRecord` (separated PII, tombstone-able), surrogate-key columns replacing direct identifying values on `Stop`, `Task`, `DecisionRecordA/B`, `InputSnapshot`; `OverrideAudit` |
| **Redis changes** | Retire `pairing:*`, `pairingAttempts:*`, `pairingLocked:*` from the steady-state path (retained for commissioning only); `session:*` replaced by certificate-bound sessions |
| **Socket.IO changes** | Handshake requires client certificate; `SESSION_REKEY` operational; every command carries fence scope, fence value, sequence, `not_valid_after`, and a signature over the payload including agent id |
| **REST API changes** | Elevated-role gates on quarantine override, Safety-class config change, bulk cancellation, manual assignment against a Policy constraint; new `POST /api/privacy/erasure` (tombstones identity, leaves technical record replayable) |
| **Background workers** | Certificate rotation/revocation checker (at session establishment **and** periodically during long sessions) |
| **Configuration updates** | Two-person approval sets for Safety-class changes; override rate thresholds per operator and per predicate |
| **Dependencies** | Phases 4, 11 |
| **Risk level** | **MEDIUM-HIGH** — changes the agent handshake; requires coordinated firmware rollout |
| **Testing requirements** | Unit: capability claimed via telemetry is rejected entirely (§23.2); self-reported health accepted for restricting but never for expanding eligibility (§23.5); a completion claim from a kinematically unreachable position is rejected and raises a security event. Integration: expired `not_valid_after` command rejected. **Erasure gate: the reconstruction-equivalence test (§24.3) re-run over a corpus with erasure applied MUST still reproduce Tier B byte-for-byte** — a field whose erasure changes a replayed cost is an identifying field wrongly admitted into the decision path |
| **Completion criteria** | Commands signed and fenced; capabilities attested, never self-declared; overrides scoped, reasoned, audited, hash-chained; erasure works without breaking replay; identifying values never stored directly in decision records or snapshots |

**Prerequisites:** Phases 4, 11. **Must precede:** Phase 15. **Parallel with:** Phases 12, 13.

---

### PHASE 15 — Verification, release gates, and production cutover

**Purpose.** Prove the Tier 0 + Tier 1 engine against §24's gates and cut over from the legacy
path. No new capability ships in this phase.

**Scope.** Complete the verification suite, run the safety case, retire the legacy decision path,
stage the cutover per shard with rollback.

| Field | Content |
|---|---|
| **Files to modify** | `Backend/jest.config.js`, `Backend/package.json`, CI pipeline; **retire** `src/services/taskAssignment.service.js`, `costEvaluator.service.js`, `robotValidator.service.js`, `taskRecovery.service.js`, and the legacy assignment path in `task.service.js` |
| **Files to create** | `formal/commitment.tla`, `formal/lifecycle.tla`, `tests/chaos/**`, `tests/scale/**`, `tools/simFidelity/validate.js`, `docs/safety-case/**`, `docs/runbooks/cutover.md`, `docs/runbooks/rollback.md` |
| **Database migrations** | Drop legacy columns **only after** a full retention window with the new path live (`Robot.currentTaskId` retained as a read-only mirror until then) |
| **Redis changes** | Retire `robotReserve:*` reliance for correctness (it remains advisory); retire `robotTask:*`, `robotTaskState:*`, `taskPath:*` legacy keys after cutover |
| **Socket.IO changes** | Retire legacy `TASK_ASSIGN`, `task_assigned`, `assign_task`, `STOP` once no client depends on them; Frontend updated in the same window (`Frontend/src/features/maps/mapControl/hooks/useRobotStream.js`, `Frontend/src/lib/socket.js`, `AppProvider.jsx`, `MapControl.jsx`) |
| **REST API changes** | Legacy `POST /api/tasks/assign` response contract formally superseded by the §3.4 contract; API version note published to consumers |
| **Background workers** | All engine workers move from shadow to production scheduling |
| **Configuration updates** | `ENGINE_ENABLED=true` per shard, staged; every Safety-class parameter must be `DERIVED` (not `PROVISIONAL`) — this is a hard launch gate (§22.4) |
| **Dependencies** | Phases 11, 12, 13, 14 |
| **Risk level** | **HIGH** — production cutover of the decision path |
| **Testing requirements** | Full §24 suite as release gates: state-machine model checking at capacity 1/2/3; determinism and replay including reconstruction-equivalence; **simulator fidelity validated one-sidedly against realised production distributions before it may discharge any Tier 0 obligation**; chaos suite run at `capacity = 2` as well as 1; cache-tier flush under load with no commitment lost, duplicated, or double-granted; scale and locality tests; soak over days; overload/admission-control tests. Shadow-mode agreement report over ≥ 2 weeks of live traffic |
| **Completion criteria** | Every §24 gate green; every §26 invariant `ENFORCED` in nominal operation with a zero-violation SLI; safety case assembled from queries rather than prose; legacy decision path removed from the build, not merely bypassed; rollback rehearsed |

**Prerequisites:** Phases 11, 12, 13, 14. **Must precede:** Phase 16. **Parallel with:** nothing.

---

### PHASE 16 — Tier 2 enablement (staged)

**Purpose.** Enable the allocation-quality mechanisms, one at a time, each behind its switch, each
validated in shadow before it is trusted (§1.8 rule 3, §27 items 6, 7, 10).

**Scope.** Enable in the reverse of the §22.5 shed ladder, one per staged rollout window.

| Sub-phase | Mechanism | Switch | Gate before enabling |
|---|---|---|---|
| 16a | Opportunity cost from live `λ_zone` (from static priors) | `killswitch.opportunity_cost` | Capacity Pricing Service live; dual-variable calibration recorded with regime |
| 16b | Batch solving beyond batch-of-one | `killswitch.batch_solving` | Round wall-clock within §20.1 at target batch size |
| 16c | Reliability-based gating and pricing | `killswitch.reliability_gating` | Estimator calibrated; attribution quality audited |
| 16d | Multi-Leg columns (bundling/consolidation) | `killswitch.multi_leg_columns` | Column-regime solver + LP–IP gap reporting; **counterfactual evaluator release gate** on the generation heuristic |
| 16e | Chaining (`capacity > 1`) | `capacity[agent_class]` | Chaos suite green at `capacity = 2`; model check green at 2 and 3; fence-rejection counters flat |
| 16f | Cross-region candidacy | `killswitch.cross_region` | Saga compensation tested; transfer-point custodians modelled |
| 16g | Deferral | `killswitch.deferral` | Deferral explanation surface live (§8.8, §21.3); shadow evidence that waiting helps |
| 16h | Preemption | `killswitch.preemption` | Churn and fairness metrics established; victim-disposition table implemented; livelock guards tested |
| 16i | Reposition injection | `killswitch.reposition` | Repositioning Planner integrated; speculative shed order verified |

| Field | Content |
|---|---|
| **Files to modify** | `src/engine/config/killSwitches.js`, `src/engine/solve/regime.js`, `src/engine/solve/round.js` |
| **Files to create** | `src/engine/solve/setPartitioning.js`, `branchAndBound.js`, `localSearch.js`, `src/engine/lifecycle/preemption.js`, `src/engine/fairness/repositioning.js` |
| **Database migrations** | None (schema already supports all of it) |
| **Redis changes** | None |
| **Socket.IO changes** | None |
| **REST API changes** | None |
| **Background workers** | Counterfactual evaluator promoted to a release gate for column-generation changes |
| **Configuration updates** | Each switch flipped per shard with automatic rollback on SLI regression (§22.3 staged rollout) |
| **Dependencies** | Phase 15 |
| **Risk level** | **MEDIUM** per sub-phase — each is independently reversible by construction |
| **Testing requirements** | Per sub-phase: shadow-mode agreement, staged rollout with pre-declared SLI guardrails, automatic rollback. Aging-cap property exercised in simulation (§24.4). Kill-switch ladder rehearsed in staging |
| **Completion criteria** | Each mechanism enabled only after its own gate; every switch exercised in staging on a schedule; unrehearsed switch combinations alert rather than being blocked |

**Prerequisites:** Phase 15. **Must precede:** nothing. **Parallel with:** sub-phases are strictly sequential.

---

## 4. Phase dependency matrix

| Phase | Prerequisites (hard) | May run in parallel with | Strictly after |
|---|---|---|---|
| 0 Setup | — | — | — |
| 1 Config & units | 0 | — | 0 |
| 2 Domain & schema | 1 | — | 1 |
| 3 Commitment core | 2 | 6, 7, 8, 9 | 2 |
| 4 Dispatch & protocol | 3 | 6, 7, 8, 9 | 3 |
| 5 Supervision | 3, 4 | 6, 7, 8, 9 | 4 |
| 6 Feasibility | 1, 2, 7 | 3, 4, 5 | 7 |
| 7 Energy & payload | 1, 2 | 3, 4, 5 | 2 |
| 8 Cost & plan | 1, 2, 6, 7 | 3, 4, 5 | 6 |
| 9 Candidates & bound | 2, 7, 8 | 3, 4, 5 | 8 |
| 10 Round & solve | 3, 4, 5, 6, 8, 9 | — | all of 3–9 |
| 11 Observability | 10 | 12, 13, 14 | 10 |
| 12 Failure & invariants | 3, 5, 10 | 11, 13, 14 | 10 |
| 13 Sharding & leadership | 3, 10 | 11, 12, 14 | 10 |
| 14 Security & privacy | 4, 11 | 12, 13 | 11 |
| 15 Verification & cutover | 11, 12, 13, 14 | — | all |
| 16 Tier 2 enablement | 15 | — | 15 |

### 4.1 Dependency graph

```
                                 ┌──────────┐
                                 │ 0 Setup  │
                                 └────┬─────┘
                                      │
                              ┌───────▼────────┐
                              │ 1 Config/Units │
                              └───────┬────────┘
                                      │
                            ┌─────────▼──────────┐
                            │ 2 Domain & Schema  │
                            └────┬──────────┬────┘
                                 │          │
         COMMITMENT TRACK (L3/L2)│          │DECISION TRACK (L4)
                                 │          │
                        ┌────────▼───┐   ┌──▼──────────────┐
                        │ 3 Commit   │   │ 7 Energy/Payload│
                        │   core     │   └──┬──────────────┘
                        └────┬───────┘      │
                             │              ▼
                        ┌────▼──────┐   ┌───────────────┐
                        │ 4 Dispatch│   │ 6 Feasibility │
                        └────┬──────┘   └───┬───────────┘
                             │              │
                        ┌────▼───────┐  ┌───▼──────────┐
                        │ 5 Supervise│  │ 8 Cost/Plan  │
                        └────┬───────┘  └───┬──────────┘
                             │              │
                             │          ┌───▼────────────┐
                             │          │ 9 Candidates   │
                             │          └───┬────────────┘
                             │              │
                             └──────┬───────┘
                                    │
                          ┌─────────▼──────────┐
                          │ 10 Round & Solve   │  ◄── convergence point
                          └──┬────┬────┬───────┘
                             │    │    │
              ┌──────────────┘    │    └──────────────┐
              │                   │                   │
      ┌───────▼────────┐  ┌───────▼────────┐  ┌───────▼────────┐
      │ 11 Observ.     │  │ 12 Failure/Inv │  │ 13 Shard/Lead  │
      └───────┬────────┘  └───────┬────────┘  └───────┬────────┘
              │                   │                   │
      ┌───────▼────────┐          │                   │
      │ 14 Security    │          │                   │
      └───────┬────────┘          │                   │
              └───────────┬───────┴───────────────────┘
                          │
                ┌─────────▼──────────┐
                │ 15 Verify & Cutover│
                └─────────┬──────────┘
                          │
                ┌─────────▼──────────┐
                │ 16 Tier 2 (staged) │
                └────────────────────┘
```

**Critical path:** 0 → 1 → 2 → 7 → 6 → 8 → 9 → 10 → 13 → 15 → 16.
The commitment track (3 → 4 → 5) is off the critical path *provided* it starts as soon as Phase 2
lands and completes before Phase 10. If it slips, it becomes the critical path.

**Maximum useful parallelism:** two teams after Phase 2 — a **commitment/execution team** (3, 4, 5)
and a **decision-path team** (7, 6, 8, 9) — converging at Phase 10. After Phase 10, three teams
(11, 12, 13) plus 14 behind 11.

### 4.2 Circular dependencies

Four candidate cycles exist. Three are resolved by construction; one is resolved by the
specification itself. **None is left unresolved.**

| # | Apparent cycle | Status | Resolution |
|---|---|---|---|
| C1 | Commit guard **G1** needs `shard.leadership_fence` (Phase 13); Phase 13's leadership needs the commit path (Phase 3) | **Broken** | Phase 3 ships `ShardLeadership` with a single static row and a manually-advanced fence, and implements G1 against it. Phase 13 replaces the row's *management* with real election. **G1's code never changes**, so there is no rework and no window in which leadership is unenforced |
| C2 | `E_return` (§14.5) needs charger availability; charger availability depends on plans that depend on `E_return` | **Broken by the specification** | §14.5 mandates the **pinned previous-round projection** with a stated conservatism margin. This is a frozen architectural decision (ADR 21), not an implementation choice. The implementation pins the projection version into the round snapshot (§9.6 item 5) |
| C3 | Plan Builder needs `Φ` to price insertions; `Φ` evaluates plans | **Not a cycle — intra-phase co-dependency** | Both land in Phase 8. `Φ` depends only on a *completed* plan object and never calls the enumerator; the enumerator calls `Φ`. The dependency is one-directional at module level and is enforced by the Phase 0 tier/import gate |
| C4 | Candidate pruning needs `Ω_terminal` from Capacity Pricing (L1); pricing calibration uses solver duals from the round (L4) | **Broken** | Estimation order is specified (§8.3.1): forecast-driven estimate is primary, duals are **calibration only** and are consumed offline, and static configured priors are the degraded path. Phase 9 depends only on config-supplied priors; live pricing arrives in Phase 16a |

**No unresolved circular dependency exists in the implementation order.**

---

## 5. Migration checklist — current vs. frozen architecture

Complexity: **S** (contained, < 1 week 1 engineer) · **M** (1–3 weeks) · **L** (3–8 weeks) ·
**XL** (> 8 weeks or multi-team). Phase column gives the owning phase.

### 5.1 Decision model and cost

| # | Current implementation | Required implementation | Affected files | Cx | Phase | Risks |
|---|---|---|---|---|---|---|
| D1 | Min-max normalised dimensionless cost `C(r)=w1·D+w2·(1−B)+w3·U+w4·T+w5·Z`, weights summing to 1 | Absolute additive cost in **CU** with dimensioned exchange rates; normalisation **prohibited** (§1.3) | `src/services/costEvaluator.service.js`, `tests/unit/dtaro/costEvaluator.test.js` | **L** | 8 | Every existing weight is meaningless in the new model — they cannot be "converted", only re-derived from accounting figures. Attempting a conversion is the most likely mistake |
| D2 | Greedy, one task at a time, at arrival | Rolling-horizon batch over a Leg set, fast path as batch-of-one | `src/services/task.service.js`, `taskAssignment.service.js` | **XL** | 10 | Latency perception changes; intake contract must state the window honestly |
| D3 | Decision index is (Task, Robot) | Decision index is the **Leg**; Task/Mission are aggregation levels | `prisma/schema.prisma`, all task paths | **XL** | 2, 8 | Delay-cost attribution must follow §8.7 or every SLA exchange rate is miscalibrated by the average Leg count |
| D4 | Objective covers robot→pickup only (drop leg absent from scoring) | Full plan cost: approach, linehaul, service, terminal state, opportunity, risk, lifecycle, delay | `costEvaluator.service.js`, `task.service.js` | **L** | 8 | Not fixable by "adding a distance term" — the model must represent the mission |
| D5 | No opportunity cost, no terminal value | `C_opportunity` as the telescoping decomposition over one primitive `λ_zone` (§8.3.3) | new | **L** | 8 | Implementing it as "shadow-price integral **plus** cost-to-go difference" double-counts — the exact error the spec was revised to remove |
| D6 | Deferral impossible; no candidate ⇒ terminal failure | Deferral is a priced variable `y[l]`; "no agent good enough" is a well-priced outcome | `task.service.js` (FAILED path) | **M** | 10, 16g | Operator perception — must ship with the §8.8 explanation surface |
| D7 | `LIMIT 100` unordered DB query over IDLE robots | Hierarchical cell expansion with a **provably admissible** bound and reported gap in CU | `taskAssignment.service.js:77-86` | **L** | 9 | An inadmissible bound advertises a false proof into decision records and SLIs |
| D8 | Arbitrary tie-breaking (first row returned) | Canonical total order ending in agent id; ties resolve to lower duty cycle, then health tier, then id | `taskAssignment.service.js:184` | **S** | 9 | — |
| D9 | Float costs, `Math.min` over unordered arrays, `Date.now()` reads inside scoring | int64 milli-CU, canonical ordering, `decision_time` as an input, pinned snapshot | `costEvaluator.service.js`, `taskAssignment.service.js` | **M** | 1, 10 | Without this, replay is impossible and every downstream gate is unverifiable |

### 5.2 Commitment, dispatch, supervision

| # | Current implementation | Required implementation | Affected files | Cx | Phase | Risks |
|---|---|---|---|---|---|---|
| C1 | Exclusivity from Redis `SET NX EX` (`kv.reserveRobot`) + `Robot.currentTaskId` FK, transaction at default isolation | Durable conditional write at SERIALIZABLE with guards G1–G6 + schema backstops; cache lock **advisory only** | `src/cache/kv.js:419`, `src/services/task.service.js:249-272` | **XL** | 3 | The single highest-consequence change in the programme. Must not be partially deployed |
| C2 | No fencing token anywhere | Two scopes: agent `authority_epoch` and per-commitment `fence`, compared per commitment id | `prisma/schema.prisma`, all command paths | **L** | 3, 4 | Comparing the commitment fence as a per-agent maximum reintroduces the exact defect the spec's P0-1 revision removed |
| C3 | No lease; `currentTaskId` persists until something clears it | Per-commitment lease with expiry, renewed on **commitment-scoped positive evidence** | `socket.server.js` offline sweep | **L** | 3, 5 | A generic heartbeat must not renew a mission lease |
| C4 | Fire-and-forget dispatch; result discarded; no ACK on TASK_ASSIGN | Transactional outbox written in the commit transaction; mandatory ACK/NACK; offer TTL; withdrawal at advanced fence | `commandDispatcher.service.js`, `task.service.js:316` | **L** | 4 | Requires firmware-side change; VirtualRobot is the reference implementation |
| C5 | Agent has no deduplication state | Durable dedup across restart + `dedup_state_generation` handshake at session establishment | `src/simulation/VirtualRobot.js`, `robot.handler.js` | **L** | 4 | Without durability, at-least-once delivery re-executes after a routine power cycle |
| C6 | `setImmediate` detached background assignment with no owner, timeout, retry, or observability | Supervised round loop owned by the shard coordinator | `src/services/task.service.js:376-386` | **L** | 10 | This line is the root cause of the audit's "stuck at PENDING with no record" — its removal is a completion criterion, not a side effect |
| C7 | No durable timers; one `setInterval` offline sweep | Every non-terminal state registers a durable timer keyed on **its own entity version** | `socket.server.js:55-119` | **L** | 5 | Keying on the agent epoch silently removes supervision from concurrent missions |
| C8 | Boot-time `recoverActiveTasks` only | Continuous reconciler covering all nine §12.4 divergence classes, with counted repairs | `src/services/taskRecovery.service.js` | **M** | 5 | Repair rate must be alerted on, not absorbed |
| C9 | Completion trusted on the agent's assertion | Graded verification L0–L3 with three stated track-plausibility tests | `src/sockets/handlers/dtaro.handler.js:80-135` | **M** | 5 | Thresholds must be set before first false positive, not after |
| C10 | Cancellation writes status unconditionally; no custody concept | Purpose-conditioned guard `cancel_requested_at IS NULL OR purpose ∈ custodial_purposes`; custody-held cancellation spawns a `RECOVERY` Leg | `src/controllers/tasks.controller.js:81-104` | **M** | 5 | The unqualified guard blocks its own mandated recovery path |
| C11 | No reassignment, no preemption | Custody-aware reassignment (three lawful outcomes) and bounded preemption with the §4.8 victim-disposition table | new | **L** | 5, 16h | `custody_transfer_capable` defaults false — most fleets are human-mediated |

### 5.3 Feasibility and physical models

| # | Current implementation | Required implementation | Affected files | Cx | Phase | Risks |
|---|---|---|---|---|---|---|
| F1 | 8 effective checks in `validateRobot`; booleans with fail-open defaults | 38 predicates, three-valued, per-predicate indeterminate policy, `DENY` mandatory for I/R | `src/services/robotValidator.service.js` | **XL** | 6 | Breadth risk; each predicate needs boundary tests in all three outcomes |
| F2 | Missing data reads as permissive (null battery passes; absent health passes) | Unknown is never permission (T2), with the systemic guard preventing a fleet-wide halt | `robotValidator.service.js`, `telemetry.handler.js` | **M** | 6 | Naive fail-closed without the guard turns a telemetry blip into an outage |
| F3 | Instantaneous battery floors: 20 % general, 30 % charge-interrupt | Wh-denominated layered reserves; **three** simultaneous tier conditions with fleet-year-governed budgets | `src/config/dtaro.constants.js`, `robotValidator.service.js` | **XL** | 7 | Safety-class. `α[tier]` must be **derived** from the fleet-year budget, never hand-set |
| F4 | No payload, capability, or container model whatsoever | Full payload spec, compartment model with aperture, tiered packing, per-stop load state | `prisma/schema.prisma` | **L** | 7 | Aperture vs. internal dimension is a distinct and frequently binding constraint |
| F5 | No reliability data; `Event`/`Command` rows written but never aggregated | Hierarchical Bayesian per-agent estimates with attribution; health tiers driving F8/F9/F11 | new | **L** | 7, 16c | Only agent-attributable causes may update the estimate |
| F6 | Mapbox external metered API on the hot path, with a straight-line fallback | **Self-hosted** routing with precomputed hierarchies; two cache populations (cell-pair and charger-reachability) | `src/services/mapbox.service.js`, `task.service.js` | **XL** | 7, 8, 9 | Infrastructure procurement. The spec calls a metered per-request API *architecturally incompatible*, so this is not optional |
| F7 | Localisation trusted from the agent's own report | F10 requires independent corroboration; unavailable corroboration is `INDETERMINATE` | `robotValidator.service.js` | **S** | 6 | Needs at least one corroborating signal to exist per deployment |

### 5.4 Distribution, configuration, observability

| # | Current implementation | Required implementation | Affected files | Cx | Phase | Risks |
|---|---|---|---|---|---|---|
| S1 | No shard concept; every process may assign any robot | Region shards; exactly one active coordinator per shard, enforced by consensus **and** by G1 | `server.js`, all services | **XL** | 13 | Split-brain; mitigated by database-enforced leadership |
| S2 | Redis holds live state, task paths, and the exclusivity lock | Cache tier holds **no** correctness-critical sole copy; release gate flushes it under load | `src/cache/kv.js`, `robotRegistry.service.js` | **L** | 3, 15 | The flush test is a hard gate, not a smoke test |
| S3 | Compile-time constants (`dtaro.constants.js`, `liveness.constants.js`, `DEFAULT_WEIGHTS`) | Versioned, scoped, typed, range-validated config with publish-time cross-parameter validation and derived parameters | `src/config/*.js` | **L** | 1 | Derived parameters must never be hand-entered |
| S4 | `logger.dtaro()` line + `recordAllocation` counters | Tier A record for every decision + sampled Tier B, reconstructible by replay | `src/config/logger.js`, `metrics.service.js` | **L** | 11 | Full-fidelity retention for every decision is ~10 TB/day/region — the two-tier design is what makes T8 affordable |
| S5 | No replay capability | Bit-identical replay from the decision record as a build gate and a continuous production sample | new | **L** | 11 | Depends on every determinism requirement landing in Phases 1 and 10 |
| S6 | `/health` with basic counters | Full §21.4 SLI set + invariant checker with three statuses | `src/app.js`, `metrics.service.js` | **M** | 11, 12 | A checker sharing logic with the enforcer verifies nothing |
| S7 | Pairing code + session token in Redis; commands unsigned | mTLS with per-device certificates, attested capability, signed commands with expiry | `src/sockets/handlers/robot.handler.js` | **L** | 14 | Coordinated firmware rollout |
| S8 | Addresses and recipient details stored directly on Task rows | Surrogate keys into a separable identity store; erasure tombstones identity and leaves records replayable | `prisma/schema.prisma` | **M** | 14 | Verified by re-running reconstruction-equivalence over an erased corpus |
| S9 | VirtualRobot simulates movement and battery only | Simulated agent implementing the full protocol contract; simulator fidelity validated one-sidedly against production | `src/simulation/**` | **L** | 4, 7, 15 | An unvalidated simulator gates releases with false confidence |

---

## 6. Risks, blocking decisions, and pre-work

### 6.1 Blocking integration decisions (not architecture changes)

These are procurement, deployment, and interface decisions the frozen architecture *assumes* but
the codebase does not yet have. Each must be settled before its dependent phase begins. None
changes the architecture; each is an instance of §27's open decisions.

| # | Decision | Blocks | Spec reference | Note |
|---|---|---|---|---|
| B1 | **Self-hosted routing engine** selection and deployment (OSRM / Valhalla / GraphHopper / in-house) with per-profile contraction hierarchies | Phases 7, 8, 9 | §5.2, §27 item 2 | The current Mapbox dependency is explicitly incompatible with the hot path. Longest lead time of any item here |
| B2 | **Charging Scheduler** — the service that owns and publishes reservations, target SoC, and the charger availability projection | Phase 7 | §14.7, §1.6 | It is outside the engine's boundary and does not exist. A conformant publisher must be built or stubbed; the engine must never compute a target SoC |
| B3 | **Consensus store** for shard leadership leases (etcd / Consul / ZooKeeper / DB primitives) | Phase 13 | §19.5, §27 item 4 | Reuse an existing operated store; a non-consensus store cannot provide the guarantee |
| B4 | **Durable timer store** technology | Phase 5 | §3.3 | In-process timers do not survive worker loss — the baseline's structural gap |
| B5 | **Spatial index primitive** (H3 vs S2 vs site-local graph zones) | Phase 9 | §6.2, §27 item 1 | H3 preferred outdoors for uniform k-ring metrics |
| B6 | **Map obstruction classification** data source (`CLEAR`/`RESTRICTIVE`/`BLOCKING_CRITICAL`) | Phases 5, 12 | §4.3, §5.2 | Required for the stranding split; unavailable data resolves to `BLOCKING_CRITICAL` |
| B7 | **Column-regime MIP solver** selection | Phase 16d | §27 item 3b | Not needed for Tier 0/1 — singleton regime uses min-cost flow |
| B8 | **Calibration owner** named, and the fleet-year energy event budgets set by ops/finance/safety | Phases 7, 15 | §22.4, §27 item 8 | A launch gate: no Safety-class parameter may be `PROVISIONAL` at cutover |
| B9 | **PostgreSQL isolation strategy** — Prisma does not expose SERIALIZABLE per-transaction ergonomically; raw SQL or an escape hatch is required for the commit transaction | Phase 3 | §10.3.2 | Verify `FOR UPDATE` + partial unique index behaviour on the target Postgres version |

### 6.2 Programme-level risks

| Risk | Likelihood | Impact | Mitigation (all already specified) |
|---|---|---|---|
| Calibration ships with placeholder coefficients; operators lose trust and override constantly | **High** | **High** | §22.4: named owner, per-parameter calibration status, tiered launch gate, bootstrap sequence, quarterly review. B8 above is the gating decision |
| Partial implementation of Tier 0 reaches production | Medium | **Severe** | §1.8 tiering + Phase 0's tier-dependency build gate + no-partial-cutover rule in Phase 15 |
| Commitment core is "mostly right" and fails only at `capacity > 1` | Medium | **Severe** | Model check and chaos suite run at capacity 1, 2, **and** 3 in Phase 3 — before anything is built on top |
| Feasibility gate acquires an informal bypass under latency pressure | Medium | High | §7.1 type separation as a build-time architectural test (I14), not prose |
| Column-generation heuristic silently degrades allocation quality | Medium | Medium | §21.6: counterfactual evaluator is a **release gate** for any generation change, not a periodic report |
| Simulator is systematically optimistic and over-approves the engine | Medium | High | §24.4 one-sided fidelity gate; the simulator may not discharge a Tier 0 obligation until validated |
| Routing migration (B1) slips and blocks the decision-path track | **High** | High | Start B1 procurement during Phase 0; the cell-pair cache interface can be developed against a stub |
| Firmware rollout for the new agent protocol lags the server | Medium | High | VirtualRobot is the reference implementation and the conformance fixture; legacy events retained until Phase 15 |

---

## 7. IMPLEMENTATION MASTER CHECKLIST

Track progress here. A phase is complete only when **every** box in it is ticked, including its
completion-criteria box.

### Phase 0 — Program setup and guardrails

- [ ] Create `Backend/src/engine/` module tree per §2 of this plan
- [ ] Write `src/engine/ARCHITECTURE.md` mapping every §3.2 component to its module path
- [ ] Write `src/engine/TIERS.md` listing every Tier 0 / Tier 1 / Tier 2 mechanism (§1.8) with owning module
- [ ] Implement `tools/gates/checkTierDependencies.js` — fails on any Tier 0/1 module importing a Tier 2 module
- [ ] Implement `tools/gates/checkParameterRegister.js` — fails on any behavioural constant absent from the register
- [ ] Implement `src/engine/guards/tenets.js` — build-time assertions for T1 (type separation) and T6 (no wall-clock reads in the decision path)
- [ ] Add `ENGINE_ENABLED=false` to `.env`, `.env.benchmark`, `tests/setup/env.js`
- [ ] Add engine test lane to `jest.config.js`; wire both gates into CI
- [ ] Create `docs/adr/` and record ADRs 01–32 from Appendix C as accepted-and-frozen
- [ ] **Gate:** both build gates demonstrably fail on planted violations; full existing suite green

### Phase 1 — Configuration, units, determinism

- [ ] Implement `ConfigVersion`, `ParameterRegisterEntry`, `OperatingRegime` schema + migration
- [ ] Implement `src/engine/config/service.js` (publish, pin, load)
- [ ] Implement `resolver.js` with scope order `global → region → zone → site → agent_class → agent`
- [ ] Implement `derived.js`: `α[tier]`, `Ω_policy`, `energy.contingency_quantile`, combined conservatism
- [ ] Implement `validators.js` — all eight §22.1 rule-5 cross-parameter checks
- [ ] Implement `calibrationStatus.js` (`DERIVED` / `PROVISIONAL` / `UNCALIBRATED`)
- [ ] Implement `killSwitches.js` with the nine switches and the supported monotone ladder (§22.5)
- [ ] Implement `regimes.js` — named, forecast-triggerable, operator-confirmed
- [ ] Seed the parameter register from Appendix A and §8.10 (every entry: unit, range, scope, class, owner, status)
- [ ] Implement `cost/units.js` (CU) and `exchangeRates.js` with explicit dimensions
- [ ] Implement `determinism/fixedPoint.js` (int64 milli-CU, single specified rounding mode)
- [ ] Implement `determinism/ordering.js` (canonical total orders) and `snapshot.js` (round input pinning)
- [ ] Migrate `dtaro.constants.js` and `liveness.constants.js` values into the register behind a shim
- [ ] Add REST: `GET /api/config/resolve`, `GET /api/config/versions`, `POST /api/config/publish`
- [ ] Tests: scope precedence incl. zone; each derived parameter; each rule-5 rejection; fixed-point order-independence
- [ ] **Gate:** no behavioural constant remains outside the register; derived parameters cannot be hand-set

### Phase 2 — Domain model and schema

- [ ] Migration (a): `Agent` fields — `agentClass`, `authority_epoch`, `fence_counter`, `regionId`, `lifecycleState`
- [ ] Migration (b): `AgentClass`, `MobilityModel`, `EnergyModel`, `ContainerModel`, `Compartment`, `CapabilityBundle`, `Capability`
- [ ] Migration (c): `Mission`, `Leg` (`purpose`, `state`, `custodyState`, `version`), `Stop`
- [ ] Migration (d): `Commitment` with `fence`, lease, custody, plan snapshot, decision ref, `version`, HARD-only CHECK
- [ ] Migration (e): `PayloadSpec`, `PayloadManifest`
- [ ] Migration (f): `Region`, `Site`, `Zone.regionId`, `CellAssignment`
- [ ] Migration (g): `Observation` (append-only, with observedAt/receivedAt/source/confidence/sequence)
- [ ] Migration (h): `DecisionRecordA` skeleton
- [ ] Migration (i): enums `LegState`, `LegPurpose`, `CustodyState`, `ObstructionClass`, `LifecycleState`; extend `TaskStatus` per §4.2
- [ ] Implement domain modules: `agent.js`, `work.js`, `purpose.js`, `custody.js`, `capability.js`, `mobilityModel.js`, `observation.js`
- [ ] Implement `spatial/hierarchy.js` — containment **by published assignment**, not query-time geometry
- [ ] Implement legacy mappers (`legacyRobot.js`, `legacyTask.js`) for dual-read compatibility
- [ ] Write and run `tools/migrate/backfillDomain.js` (idempotent)
- [ ] Validate: zone never spans a region; every fine cell maps to exactly one zone and ≤ one site
- [ ] Tests: forward/rollback on a production-shaped dump; backfill idempotency; mapper round-trip; FK integrity
- [ ] **Gate:** 100 % of legacy rows converted with zero orphans; all existing endpoints behaviourally unchanged

### Phase 3 — Commitment core

- [ ] Implement `commitment/fencing.js` — `authority_epoch` and per-commitment `fence` from `fence_counter`
- [ ] Implement the normative command-class → fence-scope table (§10.3.1)
- [ ] Implement `fence_floor` semantics: agent-scope command invalidates all commitment authorities
- [ ] Implement `commitment/commit.js` at SERIALIZABLE (or REPEATABLE READ + `FOR UPDATE` on agent **and** Leg)
- [ ] Implement guard **G1** — leadership fence re-read inside the transaction
- [ ] Implement guard **G2** — active HARD commitment count < `capacity[agent_class]`
- [ ] Implement guard **G3** — agent `authority_epoch` equals snapshot (agent-scope, not per-commitment)
- [ ] Implement guard **G4** — Leg `version` equals snapshot
- [ ] Implement guard **G5** — `cancel_requested_at IS NULL OR purpose ∈ custodial_purposes`
- [ ] Implement guard **G6** — Leg state is the expected one
- [ ] Implement volatile-subset re-check hook (populated in Phase 6)
- [ ] Migration: partial unique index enforcing ≤ capacity active commitments (I1)
- [ ] Migration: CHECK constraint admitting HARD commitments only (I18)
- [ ] Migration: `ShardLeadership` with static row + `leadership_fence`; `AgentFenceAudit`
- [ ] Implement `leases.js` (grant at commit), `idempotency.js` (two disjoint namespaces), `clock.js`
- [ ] Demote `kv.reserveRobot` to advisory (§10.4) — **only after** the durable path passes its gate
- [ ] Formal model: `formal/commitment.tla` — check at capacity 1, 2, **and** 3
- [ ] Tests: each guard aborts on its own violation only; concurrent commit storm yields exactly one winner
- [ ] Chaos: worker paused mid-finalisation beyond lease duration, resumed → commit aborts
- [ ] **Gate:** model check clean at capacity ≥ 2; I1, I5, I6, I18, I19 verifiable; schema constraints reject violations independently of application code

### Phase 4 — Dispatch and agent protocol

- [ ] Migration: `Outbox` table with `(state, notValidAfter)` index; `AgentDedupState`
- [ ] Implement `dispatch/outbox.js` — row written **inside** the commit transaction (§4.1 rule 5)
- [ ] Implement `workers/outbox.worker.js` — claim, deliver, bounded retry, escalate
- [ ] Route **every** server→agent message through the outbox (`commandDispatcher.service.js` becomes the delivery arm)
- [ ] Implement `offers.js` — OFFER content per §11.2 incl. reserve params and target SoC
- [ ] Implement `sockets/handlers/offer.handler.js` — `OFFER_ACCEPT` / `OFFER_REJECT` / `OFFER_DEFER`
- [ ] Implement DEFER semantics: release the HARD commitment, return the Leg to `PLANNED` with start-not-before
- [ ] Implement `escalation.js` — §11.4 steps 1–4 incl. systemic threshold
- [ ] Implement `sequence.js` — per-commitment ordering; `RECALL` never applied before its `OFFER`
- [ ] Implement `security/commandSigning.js` — fence scope, fence value, sequence, `not_valid_after`, signature
- [ ] Implement `dedupHandshake.js` — three server paths for the §11.5 handshake table
- [ ] Extend AUTH to carry `dedup_state_generation`, `authority_epoch`, `fence_floor`, per-commitment high-water marks
- [ ] **VirtualRobot:** durable dedup state persisted before any externally observable effect
- [ ] **VirtualRobot:** reject mission command with `fence ≤ highest_seen[commitment_id]` or `≤ fence_floor`
- [ ] **VirtualRobot:** reject agent command with `authority_epoch < highest_seen_authority`
- [ ] **VirtualRobot:** answer queries (`STATUS_REQUEST`, `PROBE`, `MANIFEST_QUERY`) unfenced
- [ ] **VirtualRobot:** enforce `agent.autonomous_continuation_limit` and halt at safest reachable location
- [ ] Tests: fence compared **per commitment id**, never as a per-agent maximum
- [ ] Chaos: power-cycle a simulated agent wiping dedup state; redeliver applied commands; assert suppression + `authority_epoch` advance + zero double-application (I21)
- [ ] **Gate:** no command reaches an agent except from an outbox row written in its authorising transaction

### Phase 5 — Supervision and reconciliation

- [ ] Migration: `Timer`, `ReconcilerRepair`, `VerificationEvidence`
- [ ] Implement `supervision/timers.js` — keyed on **the supervised entity's own version**, never the agent epoch
- [ ] Implement `workers/timer.worker.js` — at-least-once firing, idempotent handlers, timers attempt not force transitions
- [ ] Implement `lifecycle/legMachine.js` with all §4.3 states incl. `STRANDED_SAFE` / `STRANDED_OBSTRUCTING`
- [ ] Implement `lifecycle/taskMachine.js` per §4.2 incl. `AT_RISK`
- [ ] Implement `lifecycle/transitions.js` — the complete §4.4 table with guards
- [ ] Implement `supervision/leases.js` — per-commitment renewal on commitment-scoped positive evidence only
- [ ] Implement lease expiry → custody-aware recovery assessment (§4.7)
- [ ] Implement `supervision/progress.js` — all five §12.3 signals
- [ ] Implement `supervision/reconciler.js` — all nine §12.4 divergence classes, each counted
- [ ] Distinguish post-failover `PLANNED` orphans from defect orphans in the orphan scan
- [ ] Implement `lifecycle/cancellation.js` — purpose-conditioned guard; custody-held spawns a `RECOVERY` Leg
- [ ] Implement `lifecycle/reassignment.js` — fence advance and recall written in **one** transaction
- [ ] Implement the three lawful custody-`HELD` outcomes incl. `custody_transfer_capable` gating
- [ ] Implement `lifecycle/settlement.js` — custody release strictly before commitment release (I7)
- [ ] Implement `supervision/verification.js` — L0–L3 with the three track-plausibility tests
- [ ] Absorb the offline sweep and `taskRecovery.service.js` into the reconciler
- [ ] Add REST: `GET /api/legs/:legId/supervision`
- [ ] Tests: every non-terminal state registers and cancels a timer (I4); stale-version timer discarded on fire
- [ ] Model check: every non-terminal state eventually leaves; custody never lost
- [ ] **Gate:** reconciler repair rate is an alertable SLI; I3, I4, I7, I8, I12, I13 verifiable

### Phase 6 — Feasibility gate

- [ ] Implement `feasibility/threeValued.js` — `SATISFIED` / `VIOLATED` / `INDETERMINATE` and the four policies
- [ ] Implement predicates **F1–F6** (identity and lifecycle)
- [ ] Implement predicates **F7–F12** (safety and health) — F10 **with independent corroboration**
- [ ] Implement predicates **F13–F16** (connectivity and commandability)
- [ ] Implement predicates **F17–F20** (commitment and availability) — F17 evaluated as a property of the **plan**
- [ ] Implement predicates **F21–F26** (capability and payload)
- [ ] Implement predicates **F27–F33** (spatial, temporal, regulatory)
- [ ] Implement predicates **F34–F38** (computed mission feasibility) — F34 at **all three tiers**
- [ ] Verify every class I and R predicate declares `DENY` on indeterminate
- [ ] Implement `systemicGuard.js` → Restricted Operation, suspending no invariant
- [ ] Implement three-tier `cache.js` with **reason-derived** negative-cache TTLs
- [ ] Implement `volatileSubset.js` as the enumerated machine-checkable list and wire it into commit step 3
- [ ] Implement `rejectionTelemetry.js` — structured tuples, aggregation **before** sampling
- [ ] Record the binding **tier** for F34 rejections
- [ ] Add REST: `GET /api/diagnostics/rejections`
- [ ] Enforce type separation so the cost evaluator cannot receive an infeasible pairing (I14)
- [ ] Tests: all 38 predicates at their boundaries, in all three outcomes, with their declared policy
- [ ] **Gate:** static analysis proves I14; systemic guard trips without relaxing any I/R predicate

### Phase 7 — Energy and payload

- [ ] Implement `energy/consumption.js` with all β terms **including `β_payload_thermal` over `t_occupied(k)`**
- [ ] Implement `energy/usable.js` — SoH, `f_temp`, `f_derate`; publish combined nominal and degraded conservatism
- [ ] Enforce `energy.max_combined_conservatism` at config publish
- [ ] Implement `energy/wear.js` — DoD-weighted cycle cost into `C_lifecycle`
- [ ] Implement `energy/reserves.js` — four layers, never traded against one another
- [ ] Implement `energy/tiers.js` — T1/T2/T3 with `α[tier]` **derived** from fleet-year budgets
- [ ] Implement F34 as three simultaneous conditions with the binding tier recorded
- [ ] Implement `energy/eReturn.js` against the **pinned previous-round** charger availability projection
- [ ] Implement `chargingSchedulerClient.js` — consume reservations, target SoC, projection; **never compute a target**
- [ ] Implement priced-request path to the Scheduler (refusable, recorded)
- [ ] Implement `energy/chargeCurve.js` — nonlinear `P_charge(SoC, T, chargerClass)`
- [ ] Implement `energy/midMission.js` — the five §14.8 rows, each counted against its tier budget
- [ ] Implement charger-reachability cache keyed with `charger_availability_version`
- [ ] Implement `payload/spec.js`, `container.js` (aperture modelled separately), `loadState.js` (per stop)
- [ ] Implement `payload/packing.js` — tiers 1–4; tier-3 budget exhaustion ⇒ `INDETERMINATE`/`DENY`
- [ ] Implement `custodyEvidence.js` — manifest reconciliation at every custody event
- [ ] Align `simulation/constants.js` and VirtualRobot battery behaviour with the server model
- [ ] Add REST: `GET /api/diagnostics/energy/:agentId`
- [ ] Tests: energy conservation; charge-curve integration; each tier condition independently; reserve layers never traded
- [ ] Simulation: realised T1/T2 event rates match budgeted rates
- [ ] **Gate:** no percentage-based energy floor remains anywhere in the decision path

### Phase 8 — Cost function and plan builder

- [ ] Implement `plan/planBuilder.js` — stop sequence, per-stop timeline/energy/payload/custody, terminal state
- [ ] Implement `plan/timeline.js` with uncertainty bands
- [ ] Implement `cost/cDirect.js` — all six time components, energy, wear
- [ ] Implement `pricing/capacityPricingClient.js` and `vTerminal.js` (`V_avail`, `V_terminal`, **no weighting coefficients**)
- [ ] Implement `cost/cOpportunity.js` — origin-zone unavailability integral **plus** same-time terminal difference
- [ ] Verify the telescoping identity numerically in a test (the intermediate term cancels)
- [ ] Implement `cost/cRisk.js` — per-tier energy consequence terms summed separately
- [ ] Implement `cost/cLifecycle.js`, `cost/cPolicy.js` (every adjustment declares a credit ceiling)
- [ ] Implement `cost/cDelay.js` with the §8.7 **Leg attribution rule** (terminal Leg carries the full term and `M_breach`)
- [ ] Implement bounded `aging_multiplier` capped at `cost.aging.max_multiplier`
- [ ] Implement `cost/cDefer.js` (present, switched off) and `cost/cChurn.js`
- [ ] Implement `cost/signDiscipline.js` — assert declared signs and lower bounds at runtime in dev/test
- [ ] Implement `cost/phi.js` — sum over **every** Leg in the plan, including already-committed Legs
- [ ] Implement `plan/insertion.js` and `plan/column.js` — `γ(c) = Φ(plan(c)) − Φ(plan₀) + C_churn`
- [ ] Implement `plan/columnBuilder.js` (singleton columns only for now)
- [ ] Enforce F17 (queue depth) and the commitment horizon as **plan feasibility**, not arc capacity
- [ ] Implement `ServiceTimeModel` fitter with hierarchical shrinkage
- [ ] Implement cell-pair travel-time cache
- [ ] Tests: unit correctness of each term; 10 km > 1 km monotonicity; sign discipline; attribution rule
- [ ] Test: `γ(c)` recomputed from `Φ` equals the solver's value exactly in integer milli-CU
- [ ] **Gate:** no normalisation anywhere in the cost path; `V_terminal` has no weighting coefficients

### Phase 9 — Candidates and admissible bound

- [ ] Implement `spatial/cells.js` (H3/S2 per B5) and `candidates/availabilityIndex.js`
- [ ] Implement the four availability classes incl. `FINISHING_SOON` and `QUEUE_CAPACITY_AVAILABLE`
- [ ] Implement secondary indices on capability class and container class
- [ ] Implement `candidates/expansion.js` — tiers 0–6, driven by the pruning rule not a fixed ring count
- [ ] Implement `candidates/omega.js` — `Ω_terminal` from the round's price snapshot; `Ω_policy` from config publish
- [ ] Implement `candidates/lowerBound.js` — four non-negative components **minus** `Ω_terminal` and `Ω_policy`
- [ ] Implement the pruning rule with an **additive** CU tolerance
- [ ] Record the achieved bound in CU on every budget-truncated search
- [ ] Implement `candidates/ordering.js` (canonical) and `clusterShare.js` (per cell cluster)
- [ ] Implement index rebuild from the observation log (Cold Index path)
- [ ] Add REST: `GET /api/diagnostics/candidates/:legId`
- [ ] **Build gate:** exhaustive `LB ≤ γ` check over the configured parameter space; build fails on any violation
- [ ] Re-run the admissibility check at every config publish
- [ ] Tests: determinism across runs and processes; index cost independent of fleet size
- [ ] **Gate:** admissibility is a build gate, not a sampled property; I20 search-gap half verifiable

### Phase 10 — Round loop and solve

- [ ] Migration: `WorkQueue`, `Round`
- [ ] Implement `intake/intake.js` — validate, admit, deduplicate, resolve shard, enqueue durably
- [ ] Change `POST /api/tasks/assign` to return task id, idempotency echo, queue position, **honest predicted window**
- [ ] **Remove the `setImmediate` detached assignment from `task.service.js`**
- [ ] Implement `intake/admission.js` — purpose-keyed then class-keyed shedding; `custodial_purposes` never shed
- [ ] Implement `solve/cadence.js` — fast / nominal / loaded / saturated windows; early close on material supply change
- [ ] Implement the fast path as **literally** the batch path at `|L| = 1` (enforced by a build-time test)
- [ ] Implement `shard/planState.js` — round-local SOFT reservations, **in memory only**
- [ ] Implement `solve/objective.js` — coverage and exclusivity constraints per §1.4
- [ ] Implement `solve/minCostFlow.js` for the singleton regime
- [ ] Implement `solve/regime.js` — regime determined per round and recorded; never assert a guarantee out of regime
- [ ] Implement `solve/budgets.js` — all five §9.4 bounds with anytime behaviour
- [ ] Implement spatial partitioning that never severs a column spanning a boundary
- [ ] Implement `workers/coordinator.worker.js` — the full round pipeline
- [ ] Wire commit (Phase 3), dispatch (Phase 4), and supervision (Phase 5) into the round
- [ ] Emit a Tier A decision record for every decision incl. deferral reason when deferring
- [ ] Tests: singleton regime reports zero LP–IP gap; multi-Leg column round never reports exact-integer duals
- [ ] Test: replay of a stored round reproduces the allocation and per-candidate costs byte-for-byte
- [ ] Chaos: kill the coordinator with SOFT reservations outstanding — all re-planned, none lost, none double-committed
- [ ] **Gate:** no detached background assignment remains; every round produces a decision record

### Phase 11 — Observability and explainability

- [ ] Migration: `DecisionRecordA`, `DecisionRecordB`, `InputSnapshot`, `CalibrationObservation`, `AuditEvent`
- [ ] Implement Tier A with every §21.2 section incl. leadership fence, regime, kill-switch state, Ω values, both gaps
- [ ] Verify Tier A is `O(1)` in candidate count and ≤ 2 KB per decision
- [ ] Implement Tier B with deterministic sampling seeded from the decision id
- [ ] Implement the **bounded** exemption list — shard-wide degradation recorded at mode level, not per decision
- [ ] Implement `tier_b_write_budget` with reservoir fallback and counted shedding
- [ ] Implement `tools/replay/replayDecision.js`
- [ ] Implement `observability/explanation.js` with `TIER_A` / `TIER_B` / `RECONSTRUCTED` source labelling
- [ ] Add REST `GET /api/explain/:decisionId` answering all seven §21.3 queries incl. the deferral query
- [ ] Implement the full §21.4 metric set across all six groups
- [ ] Implement `observability/calibration.js` — bias, dispersion, probabilistic calibration per tier at its own timescale
- [ ] Implement `observability/shadow.js`
- [ ] Implement `tools/evaluator/counterfactual.js` and wire it as a release gate for column-generation changes
- [ ] Apply log-volume discipline: per-candidate detail leaves the log stream
- [ ] Implement the hash-chained audit stream
- [ ] **Build gate:** reconstruction-equivalence — Tier A alone reproduces Tier B byte for byte
- [ ] Golden replay corpus runs on every build; continuous production replay on a sample
- [ ] **Gate:** aggregate SLIs exact over 100 % of decisions despite Tier B sampling

### Phase 12 — Failure handling, degraded modes, invariants

- [ ] Migration: `DegradedModeEvent`, `InvariantStatus`, `ExternalEscalation`
- [ ] Implement `degraded/modeRegister.js` with all six named modes and the four governing rules
- [ ] Implement **Restricted Operation** (suspends no invariant)
- [ ] Implement **Custodial Operation** — no commits, **no commands**, I2 explicitly suspended, agents autonomous
- [ ] Implement **Unsupervised Commitment**, **Degraded Routing**, **Cold Index**, **Shed Load**
- [ ] Verify no mode promotes the cache to an authority and none relaxes a class I or R constraint
- [ ] Implement `failure/agentFailures.js` — A1–A20 with detection, latency, response, escalation
- [ ] Implement bounded dead-zone lease extension (p95, capped, corroborated exit required)
- [ ] Implement `failure/infraFailures.js` — B1–B20
- [ ] Implement `map/obstructionClass.js`; `INDETERMINATE` resolves to `STRANDED_OBSTRUCTING`
- [ ] Implement `failure/externalEscalation.js` — five steps, step 4 human-gated
- [ ] Implement `observability/invariantChecker.js` — independent of the enforcing code paths
- [ ] Implement all 22 invariant checks with `ENFORCED` / `VIOLATED` / `SUSPENDED`
- [ ] Implement the §26.2 matrix — every invariant × every mode
- [ ] Implement windowed monotonicity audit with persisted high-water mark (I6)
- [ ] Add REST: `GET /api/health/invariants`, `GET /api/health/modes`
- [ ] Simulation: drive entry/exit of every mode; observed statuses match the §26.2 matrix exactly
- [ ] Chaos: Commitment Store removed beyond the autonomy limit — full Custodial Operation behaviour verified
- [ ] **Gate:** invariant-violation SLI is zero in nominal operation; suspensions are explicit, time-boxed, and alertable

### Phase 13 — Sharding and leadership

- [ ] Migration: `Shard`, `ShardMembership`, `CrossRegionSaga`, `TransferPoint`
- [ ] Implement `shard/election.js` on the consensus store (B3)
- [ ] Replace the static leadership row with real election; **G1 unchanged**
- [ ] Implement `shard/failover.js` — recover durable state, **reconstruct** volatile state
- [ ] Emit reconstructed-Leg count as a failover metric, separate from reconciler orphan repairs
- [ ] Implement `shard/sizing.js` — both bounds monitored, binding one reported
- [ ] Enforce the §3.5 sizing inequality at config publish
- [ ] Implement `shard/membership.js` — transactional handoff, one agent at a time, advancing `authority_epoch`
- [ ] Implement `shard/crossRegion.js` — decomposition at intake, saga with explicit compensation
- [ ] Require a defined custodian at every transfer point
- [ ] Add REST: `GET /api/shards`, `POST /api/shards/:id/rebalance`
- [ ] Implement `workers/shardSupervisor.worker.js`
- [ ] Chaos: coordinator kills at random and mid-commit; asymmetric partitions
- [ ] Verify the isolated coordinator stops committing and its late commits abort via G1
- [ ] **Scale gate: the locality test** — indistinguishable round times in a small fleet and a million-agent fleet
- [ ] **Gate:** exactly one active coordinator per shard, enforced by consensus **and** by the database

### Phase 14 — Security, governance, privacy

- [ ] Implement mTLS with per-device certificates; keys in a secure element where available
- [ ] Implement revocation check at session establishment **and** periodically during long sessions
- [ ] Implement `security/sessionBinding.js` — `(agent_id, certificate, session_id)`
- [ ] Implement `security/attestation.js` — capability from commissioning record + signed attestation only
- [ ] Reject any capability claim arriving via telemetry
- [ ] Complete `security/commandSigning.js` — signature over the whole payload including agent id
- [ ] Implement `security/trustBoundaries.js` — the six §23.5 rows incl. asymmetric health trust
- [ ] Implement `security/override.js` — class I/R/F never waivable; scoped, reasoned, audited, second approver
- [ ] Monitor override rates per operator and per predicate as a design signal
- [ ] Implement `privacy/identityStore.js` and `surrogateKeys.js`
- [ ] Migrate decision records and snapshots to hold **only** surrogate keys and derived non-identifying quantities
- [ ] Implement `privacy/erasure.js` — tombstone identity, leave the technical record replayable
- [ ] Add REST: `POST /api/privacy/erasure`
- [ ] **Build gate:** reconstruction-equivalence re-run over an erased corpus still reproduces Tier B byte-for-byte
- [ ] **Gate:** no identifying value is an input to any cost term

### Phase 15 — Verification, gates, cutover

- [ ] Complete `formal/commitment.tla` and `formal/lifecycle.tla`; all §24.2 safety and liveness properties checked
- [ ] Model check at `capacity = 2` and `3`, not only 1
- [ ] Complete the chaos suite (§24.5) and run **the whole suite at `capacity = 2` as well as 1**
- [ ] Cache-tier flush under load: no commitment lost, duplicated, or double-granted (I16)
- [ ] Deliver the fleet simulator covering §18.2/§18.3 injection and every §18.5 mode
- [ ] Implement `tools/simFidelity/validate.js` — per-model distribution comparison against realised data
- [ ] **One-sided fidelity gate**: bias beyond `sim.max_optimistic_bias` on a safety-relevant model fails the simulator
- [ ] Label scenarios with no real-world counterpart as unvalidatable stimuli
- [ ] Scale and performance suite against every §20.1 target, incl. the two p99.9 targets
- [ ] Soak tests over days; overload tests through admission control
- [ ] Run shadow mode against live traffic for ≥ 2 weeks; publish the agreement report
- [ ] Complete calibration: **every Safety-class parameter `DERIVED`, none `PROVISIONAL`**
- [ ] Assemble the safety case (§24.7) from queries over decision records
- [ ] Write `docs/runbooks/cutover.md` and `rollback.md`; rehearse rollback
- [ ] Stage `ENGINE_ENABLED=true` per shard with SLI guardrails and automatic rollback
- [ ] Retire `taskAssignment.service.js`, `costEvaluator.service.js`, `robotValidator.service.js`, `taskRecovery.service.js`
- [ ] Remove the legacy assignment path from `task.service.js`
- [ ] Update Frontend socket contracts (`useRobotStream.js`, `socket.js`, `AppProvider.jsx`, `MapControl.jsx`)
- [ ] Retire legacy socket events and Redis keys after the retention window
- [ ] **Gate:** every §24 gate green; every §26 invariant `ENFORCED`; legacy path removed from the build, not merely bypassed

### Phase 16 — Tier 2 enablement (strictly sequential)

- [ ] **16a** Live `λ_zone` — Capacity Pricing Service live; dual calibration records regime and LP–IP gap
- [ ] **16b** Batch solving — round wall-clock within §20.1 at target batch size
- [ ] **16c** Reliability gating and pricing — estimator calibrated; attribution audited
- [ ] **16d** Multi-Leg columns — column-regime solver, LP–IP gap reported, evaluator gate on the generation heuristic
- [ ] **16e** Chaining (`capacity > 1`) — chaos and model check green at 2 and 3; fence-rejection counters flat
- [ ] **16f** Cross-region candidacy — saga compensation tested
- [ ] **16g** Deferral — explanation surface live; shadow evidence that waiting helps
- [ ] **16h** Preemption — churn/fairness metrics established; victim disposition implemented; livelock guards tested
- [ ] **16i** Reposition injection — planner integrated; speculative shed order verified
- [ ] Exercise every kill switch in staging on a schedule
- [ ] Verify unrehearsed switch combinations alert rather than being blocked
- [ ] **Gate:** each mechanism enabled only after its own gate, with rollback demonstrated

---

## 8. Plan maintenance

This plan is a living document; the specification is not. Changes to this plan are ordinary
engineering decisions. Changes to the specification are permitted **only** when a real
implementation problem is discovered, and require:

1. A written statement of the problem, with the code or test that demonstrates it.
2. Identification of the affected specification sections, invariants, ADRs, and appendices.
3. Approval at the level the affected parameter's change class requires (§22.3) — Safety-class
   changes need safety review and two-person approval.
4. A consistency pass over terminology, equations, invariants, ADRs, diagrams, references, and
   appendices, matching the pass performed at freeze.
5. An entry in `docs/adr/` recording what changed and why the frozen decision could not stand.

Anything that does not meet that bar is implemented as specified.

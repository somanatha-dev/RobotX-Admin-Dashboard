# Engine module map

**Normative source:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §3 (FROZEN).
**Implementation authority:** `IMPLEMENTATION_EXECUTION_PLAN.md` §2 (capability inventory).
**Companion:** [`TIERS.md`](TIERS.md) — obligation tiering and the dependency rule.

This document maps every §3.2 component onto the module path that owns it. A path
listed here that does not exist yet names the module the owning phase MUST create;
the phase column says which phase creates it. Nothing here is a design decision —
every row is a lookup from the frozen specification through the execution plan.

---

## 1. Why the engine is a new tree, not a refactor

The existing implementation is precisely the baseline the frozen specification was
written against: a greedy, per-arrival, single-task dispatcher with min-max
normalised dimensionless costs, cache-based exclusivity, fire-and-forget dispatch,
and no supervision. The architecture is a rolling-horizon batch allocator over Legs
with absolute CU costs, durable two-scope-fenced commitment, transactional outbox
dispatch, and durable supervision.

That is a new engine, and it is built here — under `src/engine/**` — alongside the
existing one, behind the `ENGINE_ENABLED` master switch (default **off**), and cut
over in one step per shard at the Phase 15 gate. The legacy path in
`src/services/task.service.js` stays live and untouched until then.

**No partial cutover.** Because Tier 0 is indivisible (§1.8), the cutover switches
the whole decision path at once, per shard, with rollback. There is no state in
which half the commitment core is live.

---

## 2. Layered view (§3.1)

Four layers separated by **failure semantics** — the property that matters most
under partial failure. A layer may only depend downward.

```
┌─ L4  DECISION LAYER ─────────────────────────────────────────────────────────┐
│  Deterministic, side-effect-free, replayable.                                │
│  Feasibility · Column pricing · Solve · SOFT reservations · Decision records  │
│  Failure semantics: retryable, idempotent, no external effect.               │
├─ L3  COMMITMENT LAYER ───────────────────────────────────────────────────────┤
│  Serialised per shard, durable, fenced.                                      │
│  HARD commitment write · Fence allocation · Outbox write · Lease grant        │
│  Failure semantics: CP — refuses to act when it cannot guarantee exclusivity. │
├─ L2  EXECUTION LAYER ────────────────────────────────────────────────────────┤
│  At-least-once, idempotent, supervised.                                      │
│  Dispatch · Acknowledgement · Lease renewal · Progress ingestion · Recovery   │
│  Failure semantics: retries forever with escalation; never silently drops.    │
├─ L1  STATE & ESTIMATION LAYER ───────────────────────────────────────────────┤
│  Eventually consistent, cache-backed, reconstructible.                       │
│  Live agent state · Spatial index · Routing · Forecast · Prices · Reliability │
│  Failure semantics: AP — degrades to reduced-envelope operation (§18.3).      │
└──────────────────────────────────────────────────────────────────────────────┘
```

**The critical property: L1 may be lossy and L4 may be repeated, but L3 must be
exactly once.** This is the inverse of the baseline, where the cache — an L1
concern — carried the exclusivity guarantee. Concentrating the consistency
requirement into the smallest possible layer, a single conditional write per HARD
commitment, is what allows every other layer to be fast, replicated, and
failure-tolerant.

It is also why SOFT reservations are not durable (§2.6): a SOFT reservation produces
no external effect, so by this layering it belongs in L4, where being lost simply
means being recomputed.

---

## 3. Component catalogue → module path (§3.2)

| Component | Responsibility | Layer | Owning module path | Phase |
|---|---|---|---|---|
| Intake API | Validate, admit, deduplicate, price-check, enqueue | L2 | `src/engine/intake/intake.js`, `src/engine/intake/admission.js` | 10 |
| Work Queue | Durable priority queue of pending Legs per shard | L1/L3 | `src/engine/shard/workQueue.js` | 10 |
| Assignment Coordinator | Owns the round loop for one shard; the only writer of HARD commitments in that shard; holds the shard's round-local SOFT reservation state | L3 + L4 | `src/workers/coordinator.worker.js`, `src/engine/shard/planState.js` | 10 |
| Candidate Service | Spatial and hierarchical candidate discovery with lower-bound pruning | L4 | `src/engine/candidates/availabilityIndex.js`, `expansion.js`, `lowerBound.js`, `omega.js`, `ordering.js` | 9 |
| Feasibility Evaluator | Constraint predicate evaluation, three-valued | L4 | `src/engine/feasibility/evaluate.js`, `threeValued.js`, `systemicGuard.js`, `register.js`, `cache.js`, `volatileSubset.js`, `rejectionTelemetry.js`, `predicates/f01..f38.js` | 6 |
| Cost Evaluator | Direct, opportunity, risk, lifecycle, delay, churn terms | L4 | `src/engine/cost/phi.js` + one module per term (`cDirect.js`, `cOpportunity.js`, `cRisk.js`, `cLifecycle.js`, `cPolicy.js`, `cDelay.js`, `cDefer.js`, `cChurn.js`), `signDiscipline.js` | 8 |
| Plan Builder | Stop sequencing, insertion evaluation, timeline and energy projection | L4 | `src/engine/plan/planBuilder.js`, `timeline.js`, `insertion.js`, `consolidation.js` | 8 |
| Column Builder | Enumerates and prices candidate columns by marginal insertion cost | L4 | `src/engine/plan/columnBuilder.js`, `column.js`, `multiLegColumn.js` | 8 |
| Solver | Set-partitioning solve over columns with deferral variables; degenerates to min-cost flow in the singleton regime | L4 | `src/engine/solve/minCostFlow.js`, `setPartitioning.js`, `objective.js`, `cadence.js`, `budgets.js`, `batch.js`, `localSearch.js` | 10 |
| Commitment Store | Durable HARD commitments, agent authority epochs and fence counters, leases, outbox | L3 | `src/engine/commitment/model.js`, `commit.js`, `guards.js`, `fencing.js`, `leases.js`, `idempotency.js`, `clock.js` | 3 |
| Dispatcher | Outbox drain, delivery, ACK/NACK correlation, retry | L2 | `src/engine/dispatch/outbox.js`, `offers.js`, `escalation.js`, `dedupHandshake.js`, `sequence.js`, `src/workers/outbox.worker.js` | 4 |
| Supervisor | Durable timers for every non-terminal state | L2 | `src/engine/supervision/timers.js`, `leases.js`, `progress.js`, `src/workers/timer.worker.js` | 5 |
| Reconciler | Continuous desired-vs-actual audit and repair | L2 | `src/engine/supervision/reconciler.js`, `verification.js`, `src/workers/reconciler.worker.js` | 5 |
| Agent State Service | Observation ingestion, live state, spatial index maintenance | L1 | `src/engine/domain/observation.js`, `src/engine/spatial/hierarchy.js`, `cells.js` | 2 |
| Routing Service | Travel time, distance, geometry, matrices, elevation | L1 | `src/engine/routing/client.js`, `cellPairCache.js`, `chargerReachabilityCache.js` | 8 |
| Forecast Service | Demand forecast per zone per horizon bucket | L1 | `src/engine/pricing/forecastClient.js` | 8 |
| Capacity Pricing Service | `λ_zone` per zone/time; publishes `Ω_terminal` with each price snapshot | L1 | `src/engine/pricing/capacityPricingClient.js`, `vTerminal.js` | 8 |
| Reliability Service | Per-agent reliability and health-tier estimates | L1 | `src/engine/reliability/**` | 16 |
| Energy Model Service | Consumption/charge prediction and per-agent calibration | L1 | `src/engine/energy/consumption.js`, `usable.js`, `wear.js`, `reserves.js`, `tiers.js`, `eReturn.js`, `chargeCurve.js`, `midMission.js`, `chargingSchedulerClient.js` | 7 |
| Config Service | Versioned, scoped, validated configuration | L1 | `src/engine/config/service.js`, `resolver.js`, `validators.js`, `derived.js`, `calibrationStatus.js`, `killSwitches.js`, `regimes.js`, `register/*.json` | 1 |
| Decision Log | Immutable decision records | L1 | `src/engine/observability/decisionRecord.js` | 11 |
| Explanation API | Human- and machine-readable decision explanation | — | `src/routes/explain.routes.js`, `src/controllers/explain.controller.js` | 11 |
| Simulation Harness | Offline replay, shadow evaluation, scenario testing | — | `src/engine/observability/shadow.js`, `tools/evaluator/**`, `tools/replay/**` | 11, 15 |

### Components the catalogue implies but does not list separately

| Concern | Spec | Owning module path | Phase |
|---|---|---|---|
| Domain model — Agent, Mission, Leg, Stop, Custody, Purpose, Observation | §2 | `src/engine/domain/*.js`, `src/engine/domain/mappers/*.js` | 2 |
| Lifecycle state machines and transition table | §4.2–§4.4 | `src/engine/lifecycle/taskMachine.js`, `legMachine.js`, `transitions.js` | 5 |
| Cancellation, reassignment, preemption, settlement | §4.6–§4.9 | `src/engine/lifecycle/cancellation.js`, `reassignment.js`, `preemption.js`, `settlement.js` | 5, 16 |
| Store role assignment and the cache-authority rule | §3.3 | `src/engine/stores/roles.js` | 3 |
| Shard model, sizing, membership, leadership, cross-region saga | §3.5, §19 | `src/engine/shard/shardModel.js`, `sizing.js`, `membership.js`, `leadership.js`, `crossRegion.js` | 3, 13 |
| Dependency contracts, budgets, circuit breakers | §5.2 | `src/engine/deps/registry.js`, `circuitBreaker.js` | 12 |
| Map obstruction classification | §4.3, §5.2 | `src/engine/map/obstructionClass.js` | 12 |
| Payload spec, container model, tiered packing, custody evidence | §15 | `src/engine/payload/spec.js`, `container.js`, `packing.js`, `loadState.js`, `custodyEvidence.js` | 7 |
| Fairness — duty cycle, ladder, operator capacity, agent starvation, repositioning | §17 | `src/engine/fairness/*.js` | 12, 16 |
| Failure catalogue, degraded-mode register, external escalation | §18 | `src/engine/failure/catalogue.js`, `externalEscalation.js`, `src/engine/degraded/modeRegister.js` | 12 |
| Determinism substrate | §9.6 | `src/engine/determinism/fixedPoint.js`, `ordering.js`, `snapshot.js` | 1 |
| Units and exchange rates | §1.3 | `src/engine/cost/units.js`, `exchangeRates.js` | 1 |
| SLIs, metrics, calibration, invariant checker | §21, §26 | `src/engine/observability/sli.js`, `metrics.js`, `calibration.js`, `invariantChecker.js`, `src/workers/invariant.worker.js` | 11, 12 |
| Security — attestation, command signing, manual override | §23 | `src/engine/security/attestation.js`, `commandSigning.js`, `override.js` | 4, 14 |
| Privacy — surrogate identity store and erasure | §23.7 | `src/engine/privacy/identityStore.js` | 14 |
| Tenet and tier guards | §1.5, §1.8 | `src/engine/guards/tenets.js`, `tierAssertions.js`, `sourceScan.js` | 0 |

---

## 4. Directory tree

Created in full by Phase 0 so that no later phase has to invent a location. A
directory holding only `.gitkeep` is a placeholder whose owning phase has not landed.

```
Backend/
├── src/
│   ├── engine/
│   │   ├── ARCHITECTURE.md          this document
│   │   ├── TIERS.md                 obligation tiering (§1.8)
│   │   ├── candidates/              §6    candidate generation, admissible bound
│   │   ├── commitment/              §10   the correctness core's centre
│   │   ├── config/                  §22   Config Service
│   │   │   └── register/            §22, App A — the parameter register
│   │   ├── cost/                    §8    Φ(plan) in absolute CU
│   │   ├── degraded/                §18.5 named degraded-mode register
│   │   ├── deps/                    §5.2  dependency contracts, circuit breakers
│   │   ├── determinism/             §9.6  fixed point, ordering, snapshot pinning
│   │   ├── dispatch/                §11   transactional outbox, offers, dedup
│   │   ├── domain/                  §2    domain model
│   │   │   └── mappers/                   legacy Robot/Task → domain
│   │   ├── energy/                  §14   energy and charging models
│   │   ├── failure/                 §18   failure catalogue, external escalation
│   │   ├── fairness/                §17   duty cycle, ladder, starvation
│   │   ├── feasibility/             §7    the 38-predicate gate
│   │   │   └── predicates/                f01..f38, one module per predicate
│   │   ├── guards/                  §1.5, §1.8 — build-time tenet and tier guards
│   │   ├── intake/                  §3.4, §20.5 — request path, admission control
│   │   ├── lifecycle/               §4    state machines and transitions
│   │   ├── map/                     §4.3  obstruction classification
│   │   ├── observability/           §21, §26 — records, SLIs, invariant checker
│   │   ├── payload/                 §15   payload, container, packing
│   │   ├── plan/                    §13   Plan Builder, columns, insertion
│   │   ├── pricing/                 §8.3.1 forecast and capacity pricing clients
│   │   ├── privacy/                 §23.7 surrogate identity store
│   │   ├── reliability/             §16   reliability estimation
│   │   ├── routing/                 §5.2, §20.3 — self-hosted routing + caches
│   │   ├── security/                §23   attestation, signing, override
│   │   ├── shard/                   §3.5, §19 — shard model, leadership
│   │   ├── solve/                   §9    the solver
│   │   ├── spatial/                 §3.6  region/zone/site/cell hierarchy
│   │   ├── stores/                  §3.3  store role bindings + cache-authority guard
│   │   └── supervision/             §12   timers, leases, reconciler, verification
│   └── workers/                     background workers (coordinator, outbox,
│                                    timer, reconciler, invariant)
└── tools/
    └── gates/                       build gates run in CI and by `npm run gates`
```

---

## 5. The rules this tree exists to enforce

| Rule | Spec | Enforced by |
|---|---|---|
| No Tier 0 or Tier 1 module depends on a Tier 2 module | §1.8 rule 2 | `tools/gates/checkTierDependencies.js` |
| No behavioural constant outside the parameter register | §22, App A | `tools/gates/checkParameterRegister.js` |
| Cost evaluation is structurally unable to see an infeasible candidate | §1.5 T1, §7.1, I14 | `src/engine/guards/tenets.js` |
| No wall-clock read or unseeded randomness in the decision path | §1.5 T6, §9.6, I10 | `src/engine/guards/tenets.js` |
| A layer may only depend downward | §3.1 | Code review against the Layer column above |
| No side effect before its authorising write | §4.1 rule 5 | `src/engine/dispatch/outbox.js` (Phase 4) |
| The cache tier never holds the only copy of a correctness-critical fact | §3.3, I16 | `src/engine/stores/roles.js` (Phase 3) + the §24.5 cache-flush chaos gate |

---

## 6. The master switch

`ENGINE_ENABLED` (default `false`) is the program-level switch for this tree. While
it is false the engine is inert: no round runs, no commitment is written, no command
is emitted. It stays false through Phase 14. Phase 15 turns it on in shadow mode
first (§21.6), and only then in production, per shard, with rollback.

Nothing under `src/engine/**` may be reached from a request or socket path while
`ENGINE_ENABLED` is false. That is a Phase 15 cutover-gate check, not a Phase 0 one —
in Phase 0 the tree contains no runtime code at all.

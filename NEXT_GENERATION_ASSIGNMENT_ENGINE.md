# Next-Generation Assignment Engine — Engineering Design Specification

**Document type:** Engineering design specification (pre-implementation)
**Status:** Draft for senior engineering review
**Scope:** The assignment engine — the subsystem that decides *which agent performs which
work, when, and under what commitment*, and that guarantees the integrity of that decision
through to settlement.
**Baseline:** `ASSIGNMENT_ENGINE_AUDIT.md` describes the current implementation. This
document is a clean-sheet design. It does not modify, review, or extend that document, and
contains no migration plan, no code, and no pseudocode.
**Audience:** Engineers implementing the engine; SRE owning its availability; operations
owning its policy surface; safety owning its constraint set.

---

## 0. How to read this document

### 0.1 Requirement language

**MUST** — a correctness or safety requirement. Violation is a defect that blocks release.
**SHOULD** — a strong design preference; deviation requires a recorded decision with rationale.
**MAY** — a permitted option, expected to be resolved by the implementing team.

### 0.2 Coverage map

The design brief enumerates seventeen concern areas. They are addressed as follows.

| Brief area | Primary section | Supporting sections |
|---|---|---|
| 1. Design philosophy | §1 | §2, §9 |
| 2. Assignment lifecycle | §4 | §10, §11, §12, §18 |
| 3. Eligibility stage | §7 | §14, §15, §16, §26 |
| 4. Candidate generation | §6 | §20 |
| 5. Cost function | §8 | §13, §14, §16, §17 |
| 6. Mission planning | §13 | §8, §14 |
| 7. Battery strategy | §14 | §8, §13 |
| 8. Payload strategy | §15 | §7, §13 |
| 9. Reliability | §16 | §8, §21 |
| 10. Fairness | §17 | §8 |
| 11. Failure handling | §18 | §4, §12, §19 |
| 12. Distributed architecture | §19 | §3, §10, §20 |
| 13. Performance | §20 | §6, §9 |
| 14. Observability | §21 | §22, §24 |
| 15. Configuration | §22 | Appendix A |
| 16. Security | §23 | §10, §11 |
| 17. Future expansion | §25 | §2 |
| (added) Correctness core & obligation tiering | §1.8 | §22.5, §24, §26 |
| (added) Invariants | §26 | §12, §24 |
| (added) Testing & verification | §24 | §21 |
| (added) Open decisions | §27 | — |
| (added) Future improvements (V2+) | §28 | — |

**Read §1.8 first.** It states which subset of this document must be correct for the engine to
be *safe*, as distinct from the larger set that makes it *good*. A specification of this size
that does not say what must be true first will be implemented partially, in an order nobody
chose deliberately.

### 0.3 Notational conventions

Quantities are written with explicit units. Time is seconds unless stated. Energy is
watt-hours (Wh). Distance is metres. Mass is kilograms. Cost is **CU** (§1.3).
`decision_time` denotes the single logical timestamp at which a decision round is evaluated;
no component reads a wall clock during evaluation (§9.6).

---

## 1. Design Philosophy

### 1.1 The problem, restated from first principles

The naive framing is *"given a task, find the best robot."* This framing is the source of
most defects in greedy dispatchers, including the baseline system, because it is the wrong
problem. Three corrections are required.

**Correction 1 — assignment is resource allocation, not nearest-neighbour search.**
Committing agent `r` to task `t` does not merely incur the cost of executing `t` with `r`.
It removes `r` from the available pool for the duration of the commitment, relocates it to
the drop point, and depletes its energy. The cost of that removal — the *opportunity cost*
— is frequently larger than the direct execution cost. A dispatcher that ignores it will
reliably consume the last agent in a high-demand zone to serve a low-value task in a
low-demand zone, and will do so while appearing locally optimal at every step.

**Correction 2 — the decision is over a set, not a pair.** Tasks arrive in bursts.
Deciding each task independently in arrival order is a greedy approximation to an
assignment problem whose optimum is computable. The greedy approximation's characteristic
failure is *cannibalisation*: two tasks arriving 200 ms apart both select the same
neighbourhood's best agent; the first wins, the second takes a much worse agent, when a
swap would have served both well. The engine MUST therefore decide over a *batch* of tasks
against a *set* of agents, on a rolling horizon.

**Correction 3 — the decision is over a horizon, not an instant.** "Assign now to the best
currently available agent" is not optimal when a materially better agent becomes available
in 40 seconds and the task's deadline is 25 minutes away. Deferral MUST be a first-class
decision outcome, priced against the alternatives rather than treated as failure.

The engine is therefore specified as: **a rolling-horizon, batch, cost-minimising allocator
over a set of pending work and a set of feasible agents, in which deferral is an explicit
option, and every commitment is a leased, fenced, supervised, and revocable contract.**

### 1.2 What "best agent" means

"Best" is meaningless without a stated objective. This engine defines it as:

> The agent whose commitment to this mission produces the **lowest total expected cost to the
> operation over the planning horizon**, where cost includes the direct cost of execution,
> the opportunity cost of the agent's unavailability and relocation, the expected cost of
> failure, the amortised cost of physical wear and energy, and the cost of any resulting
> delay to this and other work — subject to satisfying every hard feasibility constraint
> with a specified confidence.

Four consequences follow, and each is a deliberate departure from the baseline.

**(a) Proximity is an input, not the objective.** The nearest feasible agent is often the
best one, and the design expects this. But it is a *conclusion* of the cost model, not a
premise of it. When the nearest agent is the fleet's only remaining high-reliability unit,
or is 8 % above its energy reserve, or is the sole coverage for an adjacent high-demand
zone, the model MUST be able to prefer a more distant agent, and MUST be able to explain
why.

**(b) "No agent" is a legitimate answer.** If every feasible agent's cost exceeds the cost
of waiting, the correct decision is to wait. This requires costs to be *absolute* (§1.3).

**(c) Optimality is defined, bounded, and measured.** The engine does not claim global
optimality — that would require perfect forecasts. It claims: *exact optimality over the
column set it generated, given its inputs, with two separately bounded and separately
reported approximation gaps — one from candidate-set truncation (§6.4) and one from column
generation (§9.3) — over a horizon and forecast whose accuracy is continuously measured*
(§20.3, §21.5). Both gaps are reported in CU, per decision, and neither is permitted to be
asserted without being computed. An unmeasurable optimality claim is not an engineering
claim, and a claim that conflates two distinct approximations into one number is not a bound.

**(d) Determinism is a requirement, not a side effect.** Given identical inputs, identical
configuration, and identical model versions, the engine MUST produce an identical decision,
bit-for-bit reproducible from its decision record (§9.6). This is not aesthetic: it is the
precondition for regression testing, incident reconstruction, dispute resolution, customer
explanation, and safety certification.

### 1.3 The canonical cost unit, and why min-max normalisation is rejected

**Decision: all cost terms MUST be expressed in a single absolute, physically meaningful,
additive unit. Relative (min-max, rank, or z-score) normalisation of cost terms is
prohibited.**

The canonical unit is the **CU (cost unit)**, defined as:

> **1 CU ≡ the fully-loaded operating cost of one second of committed time of a reference
> agent class**, where the reference class and its cost are configuration
> (`cost.reference_agent_class`, `cost.cu_per_currency_unit`).

Every term in the objective is converted into CU by an **exchange rate with explicit
dimensions** — for example `cost.energy.cu_per_wh` (CU·Wh⁻¹), `cost.wear.cu_per_metre`
(CU·m⁻¹), `cost.sla.cu_per_second_late[class]` (CU·s⁻¹). A "weight" in this engine is
never a dimensionless tuning knob; it is a priced exchange rate traceable to an accounting
figure. This is the mechanism by which the design satisfies "no magic constants": a constant
with a unit, an owner, a valid range, and a derivation is not magic (§22, Appendix A).

Five capabilities depend on absolute units, and all five are unreachable under relative
normalisation:

1. **Deferral.** Comparing "assign now at cost 4 100 CU" against "expected cost of waiting
   one round, 900 CU" requires both to be on the same absolute scale. Under min-max
   normalisation the best candidate always scores exactly 0 regardless of how bad it is, so
   the engine cannot distinguish an excellent option from the least-bad terrible one.
2. **Cross-task comparison.** Batch optimisation sums costs across assignments. Sums of
   per-task-rescaled quantities are meaningless.
3. **Heterogeneous fleets.** A drone-second and a ground-robot-second differ in cost.
   Absolute units make them comparable; rescaling within each candidate set does not.
4. **Scale-invariance defects.** Under min-max, a 5 m versus 10 m spread and a 5 km versus
   400 km spread both produce the vector (0, 1). The engine spends the same trade-off
   budget on an operationally irrelevant difference as on an enormous one.
5. **Sensible degenerate behaviour.** With one candidate, min-max yields the midpoint 0.5
   for every relative term, so the terms silently vanish. Absolute costs behave correctly
   with a single candidate — which is the common case in a sparse fleet.

The engine MUST additionally maintain a **currency view** of every cost. Operators and
finance reason in money; engineers reason in CU; the conversion is a single configured
rate. Decision records carry both.

### 1.4 The objective function

**The decision index is the Leg** (§2.4). Everything the engine assigns, prices, commits,
fences, and settles is a Leg; the Mission and the Task are aggregation levels above it, never
decision variables. Indexing the objective over Missions while assigning Legs would
misattribute delay cost by a factor equal to the average Leg count per Mission, so the
notation is fixed here and used unchanged throughout the document.

For a decision round at `decision_time`, let `L` be the set of pending Legs and `A` the set of
feasible agents.

**The column is the unit of proposal.** A **column** `c` is a triple
`( a(c), L(c), plan(c) )`: one agent, a non-empty set of pending Legs, and one complete
executable plan (§13.1) in which exactly those Legs have been inserted into that agent's
already-committed stop sequence. A column is admitted to the optimisation only if `plan(c)` is
feasible in full (§7, §13.1) — which is where per-agent queue depth `capacity[agent_class]`
(F17) and the commitment horizon (§13.3) are enforced.

Let `Φ(plan)` be the plan-level cost functional of §8, and `plan₀(a)` the agent's currently
committed plan. A column is priced at its **marginal** cost:

```
γ(c) = Φ( plan(c) ) − Φ( plan₀(a(c)) ) + C_churn(c)
```

Let `z[c] ∈ {0,1}` select column `c`, and `y[l] ∈ {0,1}` defer Leg `l` to a later round. The
engine solves:

```
minimise    Σ  γ(c) · z[c]     +     Σ  C_defer[l] · y[l]
            c                       l∈L

subject to        Σ        z[c]  +  y[l]  =  1      for every pending Leg l ∈ L
              c : l ∈ L(c)

                  Σ        z[c]            ≤  1      for every agent a ∈ A
              c : a(c) = a

            z[c] ∈ {0,1},   y[l] ∈ {0,1}
```

Each term of `Φ` is specified in §8; the solve is specified in §9.3. Five structural
properties of this formulation are load-bearing:

- **One column per agent per round.** This is the constraint that makes the formulation
  *valid*, and it is not a restriction on fleet behaviour. Because an agent accepts at most
  one column, and a column is priced as the marginal cost of its own complete plan, the
  objective value of any feasible solution is **exactly** the true total cost of the
  allocation it represents. Pricing two independent arcs into one agent — as a naive
  capacity-`k` flow does — is invalid, because the second Leg's approach begins at the first
  Leg's drop point, both Legs' completion times depend on their sequencing, and the
  commitment duration is not the sum of two independently computed durations. Chaining and
  consolidation are therefore expressed *inside* a column, never as parallel arcs at one
  agent (§9.3, §13.3).
- **`capacity[agent_class]` remains a freely tunable queue depth.** It bounds how many
  commitments an agent may hold concurrently, and it is enforced as a feasibility property of
  `plan(c)` rather than as an arc capacity. Raising it enlarges the space of admissible
  columns; it never introduces a non-separable arc. Queue depth and formulation validity are
  thereby decoupled (§9.3).
- **`y[l]` — the deferral arc.** Deferral is not an exception path or an error; it is a
  variable in the same optimisation with an explicit price (§8.8). "No agent was good enough"
  and "all agents were taken" become the same well-priced outcome rather than two distinct
  terminal failures.
- **`C_delay[l](·)` is convex and increasing in completion time, and grows with the Leg's
  queue age, bounded by `cost.aging.max_multiplier`.** This is where SLA class and business
  priority live. Priority is not a separate mechanism bolted on; it is the shape of this
  function (§8.7). Anti-starvation is **not** this function's job — it is guaranteed
  structurally by the escalation ladder (§17.4), which is why the aging term is permitted to be
  bounded. Its
  attribution from the parent Mission's contract down to the individual Leg is stated in
  §8.7 and is part of the notation, not left to the implementer.
- **`C_churn(c)`** prices the revision of an existing plan. Without it, a rolling-horizon
  re-optimiser oscillates: agents are re-planned every round as forecasts jitter, and nothing
  is ever executed (§4.8, §8.9).

Because `Φ` is evaluated over the agent's *whole* plan, a column that inserts a Leg into an
occupied agent automatically prices the delay it imposes on that agent's already-committed
Legs. Insertion is not a separate mechanism bolted onto the objective; it is the objective
evaluated at two plans (§13.3).

### 1.5 Design tenets

These are the tie-breakers when sections conflict. They are ordered; higher tenets win.

**T1 — Safety constraints are absolute and never priced.** Hard constraints are a boolean
gate evaluated before and independently of cost. No cost value, priority, SLA breach,
executive override, or optimisation objective may admit an infeasible pairing. The cost
function MUST be structurally incapable of seeing an infeasible candidate. (This property
exists in the baseline and is preserved verbatim; it is the baseline's strongest
architectural feature.)

**T2 — Unknown is not permission.** Missing, stale, or unverifiable data MUST NOT be
silently interpreted as satisfying a safety constraint. Every constraint declares its
behaviour on indeterminate input (§7.3). The baseline's fail-open defaults — unknown
battery scored as 100 %, absent health record treated as healthy, expired live-state
yielding the best possible utilisation score — are inverted here, with a mechanism (§7.4)
that prevents the inversion from stranding the fleet during a telemetry outage.

**T3 — Degrade the envelope, not the safety margin.** When a dependency fails, the engine
reduces what it is willing to attempt — shorter missions, larger energy reserves, smaller
search radius, fewer concurrent commitments — and never reduces a safety margin to preserve
throughput (§18.3). Throughput loss is recoverable; a stranded or unsafe agent is not.

**T4 — Every commitment is leased, fenced, and supervised.** No state in this engine is
permitted to persist indefinitely without an owner and a deadline. Every non-terminal state
has a timeout, a durable supervisor, and a defined recovery path. The baseline's family of
"stuck at ASSIGNED forever" defects is structurally impossible under this tenet rather than
individually patched (§4.5, §12).

**T5 — Correctness of exclusivity comes from the durable store, never from a cache.** A
cache lock is an efficiency device that prevents wasted work. The authoritative guarantee
that one physical agent holds one commitment MUST be a conditional write in the durable
store, fenced by a monotonic epoch (§10.3). A design in which cache loss can cause
double-commitment of a physical machine is rejected.

**T6 — Determinism and replayability over cleverness.** Any technique that cannot be
replayed from its decision record — unseeded randomness, wall-clock reads inside scoring,
floating-point summation over unordered sets, unversioned models — is prohibited in the
decision path (§9.6).

**T7 — Learning informs estimation; classical optimisation makes decisions.** Machine
learning is confined to *predicting* quantities (travel time, energy, dwell, demand,
failure probability). The allocation decision itself is made by a transparent,
deterministic, inspectable solver over those predictions. No learned component may relax a
constraint or directly emit an assignment (§25.5).

**T8 — Explainability is a functional requirement.** For every decision the engine MUST be
able to answer: why this agent, why not that agent, which constraint rejected each excluded
agent, what the runner-up was and by what margin, and which configuration and model versions
produced the result (§21.3).

The engine satisfies this in two ways, and the distinction is deliberate rather than a
concession. The **common** questions — the chosen candidate, the runner-up and margin, the
top-N, the binding-constraint histogram, the versions, the applied degradations — are answered
directly from stored data with no recomputation, for every decision without exception. The
**exhaustive** per-candidate, per-predicate detail is answered from stored data when it was
retained, and otherwise by *deterministic reconstruction* from the decision's pinned input
snapshot, which T6 guarantees is byte-identical to what was originally computed. Every answer
declares which path produced it (§21.3).

This is what makes explainability affordable at fleet scale: a fully itemised per-candidate
record for every decision is on the order of 10 TB/day per region (§21.2), and a requirement
that can only be met by an unaffordable mechanism is a requirement that will quietly be
dropped. Reconstruction preserves the substance — the answers are identical, and their
identity is a build-gated property (§24.3) — while bounding what must be stored.

**T9 — Locality is the scalability strategy.** Assignment is intrinsically local: an agent
50 km away is never the answer. The engine's cost MUST scale with *local agent density*,
not with global fleet size. A design whose per-decision work grows with total fleet size
cannot reach millions of agents and is rejected (§19.2, §20.2).

**T10 — Observability of the safety nets themselves.** Every automatic repair, constraint
relaxation, degradation entry, and reconciler correction MUST emit a counted, alertable
event. A safety net that silently absorbs a rising defect rate converts a visible incident
into an invisible one (§12.4, §21.4).

### 1.6 Deliberate non-goals and system boundaries

Scope discipline matters as much as scope coverage. The engine is **not**:

| Not the engine | Owned by | Interface |
|---|---|---|
| A route planner or map service | Routing Service | §5.2 |
| An on-agent navigation or motion-control stack | Agent software | §11 |
| A charger scheduler | Charging Scheduler | §14.7 |
| A demand forecaster | Forecast Service | §5.2 |
| A fleet-sizing or capital-planning tool | Fleet Planning (offline) | consumes §21 data |
| An order-management or customer-facing system | OMS | §5.1 |
| A warehouse/inventory system | WMS | §5.1 |
| A maintenance-execution system | Maintenance | §16.6 |
| A repositioning planner | Repositioning Planner | §17.3 |

The engine consumes these as services with declared contracts, latency budgets,
availability budgets, and specified degradation behaviour (§5.2, §18.3). Two boundaries are
deliberately *soft* because the coupling is too strong to sever:

- **Charging** is scheduled by a separate service, but the engine MUST participate: a
  mission that leaves an agent below its charge trigger includes the mandatory charging leg
  in its cost. The division is stated exactly in §14.7 and is not left to interpretation — the
  Charging Scheduler owns and publishes charger reservations, **target SoC**, and the charger
  availability projection; the engine consumes all three as hard inputs, publishes its
  projected demand, and may submit priced requests that the Scheduler is free to refuse. The
  engine never computes a target SoC or asserts a reservation (§14.6, §14.7).
- **Repositioning** is planned separately, but reposition moves are injected into the engine
  as ordinary low-priority preemptible missions, so that a single optimiser arbitrates
  between serving work and improving coverage (§17.3).

### 1.7 Summary of departures from the baseline

Stated explicitly so that reviewers can locate the disagreements. Each is justified in the
referenced section.

| # | Baseline property | This design | Rationale |
|---|---|---|---|
| 1 | Min-max normalised, dimensionless weighted sum | Absolute additive cost in CU with dimensioned exchange rates | §1.3 |
| 2 | Greedy, single-task, at arrival | Rolling-horizon batch over a task set, with a greedy fast path | §1.1, §9 |
| 3 | Deferral impossible; failure terminal | Deferral is a priced arc in the optimisation; queueing is first-class | §1.4, §8.8 |
| 4 | Objective covers robot→pickup only | Full mission cost, terminal-state value, and opportunity cost | §8, §13 |
| 5 | Straight-line distance dominant (w=0.50), road time a 0.05 tiebreaker | Road-network time and energy as primary; geometry only as an admissible pruning bound | §6.4, §8.2 |
| 6 | Absolute instantaneous battery floor (20 %) | Probabilistic mission energy feasibility with layered reserves in Wh and tiered, fleet-year-composed shortfall budgets | §14 |
| 7 | No payload or capability model | First-class payload, compartment, and capability model, checked per stop | §15, §7.5 |
| 8 | Cache lock is the sole exclusivity guarantee | Durable conditional write under two-scope fencing — a per-agent authority epoch and a per-commitment fence; cache lock is advisory only | §10.3 |
| 9 | Dispatch result discarded, no acknowledgement, agent cannot refuse | Transactional outbox, mandatory ACK/NACK, offer expiry, supervised escalation | §11 |
| 10 | Fail-open on missing safety data | Three-valued constraint logic with per-predicate indeterminate policy and a systemic-outage guard | §7.3, §7.4 |
| 11 | Unbounded, unsupervised non-terminal states | Every state leased, timed, and supervised; a continuous reconciler repairs divergence | §4.5, §12 |
| 12 | Candidate pool truncated at 100 rows, unordered | Hierarchical spatial search with a provably admissible lower bound and a proven optimality gap reported in CU | §6 |
| 13 | Weights are compile-time constants | Versioned, scoped, typed, range-validated configuration with change control | §22 |
| 14 | Completion is a trusted agent assertion | Graded completion verification with custody accounting | §12.5, §15.6 |
| 15 | No reassignment, no preemption | Custody-aware reassignment and bounded preemption with churn pricing | §4.7, §4.8 |

### 1.8 The correctness core, and the tiering of obligations

This specification is large, and every mechanism in it is written in the same voice. That is a
hazard: a document whose thirty-eight feasibility predicates, column generation, deferral,
preemption, churn pricing, approximate-dynamic-programming terminal values, and hierarchical
Bayesian reliability estimation all appear at the same level of obligation will be partially
implemented — its scope guarantees that — and the subset that ships will otherwise be
self-selected by whoever implements it first, with no analysis of whether that subset is safe
on its own.

**The obligations are therefore tiered, and the tiering is normative.** A mechanism's tier
states what its absence or incorrectness costs.

| Tier | Name | If it is wrong | May a release ship without it? |
|---|---|---|---|
| **0** | **Safety core** | A physical incident: a double-commanded machine, a stranded or immobilised agent, lost goods, an unsafe pairing executed | **No.** No agent may be commanded by an engine whose Tier 0 is incomplete |
| **1** | **Operational integrity** | The engine is unsupportable, unauditable, or unbounded in time — it makes decisions nobody can explain, reproduce, or terminate | **No**, for production. A Tier 1 gap is a launch blocker, not a safety event |
| **2** | **Allocation quality** | The engine allocates worse than it could. Nothing physical is at risk | **Yes.** Each is individually disableable (§22.5) |

**Tier 0 — the safety core.** These mechanisms, and only these, are what make it safe to
command a physical machine at all.

- The feasibility gate as a boolean pre-cost gate, structurally incapable of being bypassed
  (T1, §7.1), with its class I and R predicates (§7.5).
- Three-valued evaluation with `DENY` on indeterminate for every class I and R predicate
  (§7.3), and the systemic-indeterminacy guard that stops it from stranding the fleet (§7.4).
- Energy feasibility at all three shortfall tiers, and charger reachability from the mission
  end — F34, F35 (§14.5).
- Payload, capability, and route-permission predicates — F21–F31 (§7.5).
- Exclusivity: the serialised conditional commit with guards G1–G6 and its schema backstops
  (§10.3.2).
- Two-scope fencing (§10.3.1) and durable agent-side deduplication (§11.5).
- Custody as a first-class state, with settlement ordering (§2.5, §4.9).
- Durable timers keyed on each entity's own version (§4.5), and the reconciler (§12).
- The transactional outbox (§11.1).
- Stranding classification and the external escalation chain (§4.3, §18.6).
- The degraded-mode register, with every suspension explicit, named, and time-boxed
  (§18.5, §26.2).

Tier 0 carries invariants **I1, I2, I4, I5, I7, I8, I9, I12, I16, I17, I18, I19, I21, I22**.

**Tier 1 — operational integrity.** Not required for any single mission to be *safe*; required
for the engine to be operable, defensible, and bounded.

- Absolute CU units, dimensioned exchange rates, and the parameter register (§1.3, §22,
  Appendix A).
- Determinism and replayability of every decision (§9.6).
- The Tier A decision record and the Explanation API (§21.2, §21.3).
- The anti-starvation escalation ladder (§17.4) — which is where the anti-starvation
  *guarantee* lives.
- Cancellation (§4.6), reassignment (§4.7), and settlement (§4.9).
- Admission control and backpressure (§20.5).
- The Invariant Checker (§26).

Tier 1 carries invariants **I3, I6, I10, I11, I13, I14, I15**.

**Tier 2 — allocation quality.** Each of these improves the answer. None of them is permitted
to be load-bearing for a Tier 0 or Tier 1 guarantee.

Batch solving (§9.1); multi-Leg columns (§9.3); queue depth `capacity > 1` (§13.3); deferral
(§8.8); preemption (§4.8); the opportunity-cost and terminal-value model (§8.3); churn pricing
(§8.9); post-solve local search (§9.5); reliability-priced risk (§8.4, §16); the duty-cycle
regulariser (§17.2); repositioning (§17.3); consolidation and chaining (§13.3).

Invariant **I20** governs the *claims* Tier 2 makes and MUST hold whenever any of these is
enabled — a quality mechanism may be absent, but it may not lie about its own optimality.

**Three rules follow, and they are the reason for stating the tiers at all.**

1. **Every Tier 2 mechanism MUST be individually disableable**, and every kill switch MUST
   degrade to a Tier 1 behaviour that is itself complete and tested (§22.5). A kill switch that
   degrades to an untested path is not a control.
2. **No Tier 0 or Tier 1 guarantee may depend on a Tier 2 mechanism.** Where the design
   appeared to violate this, the design was changed rather than the rule: anti-starvation is
   guaranteed by the ladder (Tier 1) and not by the aging price (Tier 2), which is why the aging
   multiplier could be safely capped (§8.7, §17.4). Any future dependency of this shape is a
   defect, and the tier assignment is what makes it visible as one.
3. **The staged implementation order is a consequence, not a suggestion.** Tier 0 plus Tier 1,
   at `capacity[agent_class] = 1`, in the singleton regime, with deferral and preemption off and
   `λ_zone` taken from static configured priors, is a **complete, safe, shippable engine** — it
   is strictly better than the baseline on every axis the audit identifies, and every one of its
   guarantees is enforced rather than asserted. Tier 2 mechanisms are then enabled one at a
   time, each behind its own switch, each validated in shadow mode before it is trusted (§21.6,
   §27 item 7).

The release gates of §24 are stated per tier and MUST be read that way: Tier 0 requires model
checking (§24.2) and chaos injection (§24.5); Tier 1 requires the replay and
reconstruction-equivalence gates (§24.3); Tier 2 requires shadow evaluation and counterfactual
measurement (§21.6). A tier's gates are not optional for a release that ships that tier.

---

## 2. Domain Model

The domain model is specified before the pipeline because most baseline limitations are
model limitations, not algorithm limitations: no payload concept, no capability concept, no
task type, no custody, no queue. An engine cannot reason about what its model cannot
represent.

### 2.1 Agent

**`Agent`** replaces "robot" as the primary abstraction so that ground robots, drones,
vehicles, and human couriers are representable without a structural change (§25). An Agent
is the unit of commitment: exactly one commitment stack, exactly one physical identity.

| Facet | Content | Notes |
|---|---|---|
| Identity | Stable agent id, fleet id, tenant id, operating region, home depot | Region determines the assignment shard (§19.2) |
| Class | Agent model, hardware revision, software/firmware version set | Keys all model-specific parameter sets |
| Mobility model | Traversal profile, speed model, kinematic limits, surface/road-class permissions, 2D or 3D | §2.2 |
| Energy model | Pack nominal capacity, chemistry, state of health, consumption coefficients, thermal derating curve, charge-power curve | §14.2 |
| Capability bundle | Set of typed, attested capabilities | §2.3 |
| Payload container model | Ordered compartments with dimensions, mass limits, thermal class, lock class, access constraints | §15.2 |
| Commitment state | Current commitment stack, queue depth capacity, `authority_epoch`, `fence_counter` | §2.6, §10.3 |
| Health state | Graded health tier, active faults, reliability estimates, calibration and certification validity | §16 |
| Lifecycle state | Commissioned / active / quarantined / maintenance / decommissioned | Distinct from operational status |
| Observed state | Position, pose, SoC, velocity, localisation confidence, link quality — each with an observation timestamp and source | §2.7 |
| Accounting state | Cumulative distance, energy throughput, cycle count, duty cycle, actuator cycles, mission counters | §16.2, §17.2 |

Two model decisions warrant justification.

**Lifecycle state is separate from operational status.** The baseline overloads a single
status enum, producing the ambiguity documented in the audit where `PAUSED` means either
"paused" or "charging" depending on a Redis key that may have expired. Here, orthogonal
concerns are orthogonal fields: lifecycle (is this agent in service at all), commitment
(does it hold work), activity (what is it physically doing), connectivity (can we command
it), and health (is it fit). A charging agent is `lifecycle=active`,
`activity=charging`, `commitment=none|reserved_by_charging`. No inference from an expired
cache key is ever required to determine eligibility.

**Capabilities are attested, never self-declared at runtime.** An agent's claim about its
own capability is untrusted input (§23.5). The authoritative capability set is derived from
the commissioning record, the installed hardware manifest, and a signed firmware
attestation. A software update that changes capability MUST update the commissioning record
through the control plane, not through a telemetry field.

### 2.2 MobilityModel

The MobilityModel makes heterogeneous locomotion a parameter rather than a special case.

| Element | Purpose |
|---|---|
| Traversal domain | Which network the agent may use: sidewalk graph, road graph, indoor graph, airspace volume, or a composition |
| Permission set | Road classes, surface types, gradients, kerb heights, stair capability, restricted areas, airspace classes |
| Speed model | Achievable speed as a function of road class, gradient, surface, payload mass, congestion, and weather |
| Kinematic limits | Max speed, acceleration, braking distance (payload-dependent), turning radius, max gradient |
| Envelope constraints | Weather limits, wind limits, temperature limits, visibility limits, time-of-day restrictions |
| Dimensional footprint | Width, height, length — gates passage constraints (doors, lifts, tunnels, bollards) |

The Routing Service is queried *with* a MobilityModel reference, so travel time for a
loaded stair-capable indoor robot and for a drone over the same origin/destination pair are
different queries against different networks — not the same query with a fudge factor.

### 2.3 CapabilityBundle and requirement matching

Capabilities are typed, not string tags, because untyped tags cannot express thresholds and
degrade into a taxonomy nobody maintains.

| Capability kind | Representation | Example requirement |
|---|---|---|
| Boolean | present / absent | `secure_locker`, `stair_climb`, `tow_hitch`, `custody_transfer_capable` |
| Graded | ordered level | `autonomy_level ≥ 3`, `weather_rating ≥ IP54` |
| Quantitative | value with unit | `max_payload_mass ≥ 12 kg`, `cold_chain_min_temp ≤ 2 °C` |
| Enumerated set | set membership | `hazmat_classes ⊇ {UN3480}` |
| Certified | value plus validity window and issuer | `food_handling_cert valid at mission end` |

A mission carries a **RequirementSet** in the same algebra. Matching is set-and-threshold
containment, evaluated as a hard constraint (§7.5). Certified capabilities MUST be checked
against *mission end time*, not decision time — a certification expiring mid-mission is a
compliance breach, and this is a class of defect that only an explicit temporal check
catches.

**`custody_transfer_capable` defaults to `false`, and the default is the realistic case.**
Agent-to-agent physical transfer of goods requires a manipulator, a mutually accessible
compartment interface, or a docking-compatible pair. Most sidewalk delivery robots have none of
these, so for most fleets the `Transfer` recovery outcome of §4.7 collapses into
human-mediated retrieval. Modelling the capability explicitly, and defaulting it off, is what
prevents the recovery machinery from selecting a physically impossible outcome: a `TRANSFER`
Leg's `RequirementSet` includes `custody_transfer_capable` for the receiving agent unless the
transfer is human-mediated, so F21 rejects the impossible pairing rather than the fleet
discovering it at the kerbside.

### 2.4 Work: Task, Mission, Leg, Stop

The baseline conflates task and mission, which forecloses chaining, consolidation, and
multi-modal delivery. This model separates them.

- **Task** — a unit of customer-visible work with a service-level contract. Carries origin,
  destination, payload specification, requirement set, time windows, SLA class, tenant, and
  business priority. A Task is what the customer sees and what the SLA is measured against.
- **Stop** — a located, time-windowed action at a place: pickup, drop, wait, charge,
  inspect, transfer, reposition. Carries a service-time model, access constraints (lift,
  door code, dock, gate), and the payload delta it applies.
- **Leg** — a contiguous sequence of Stops executed by **one** agent under **one**
  commitment. A Leg is the unit of assignment. Every Leg carries a **`purpose`** (below).
- **Mission** — the ordered set of Legs that discharges one or more Tasks, joined at
  **transfer points** where custody passes between agents.

#### Leg purpose

`purpose` is an explicit, durable, first-class attribute of every Leg, set at creation and
never mutated. It exists because several mechanisms in this design need to distinguish *why*
a Leg exists, and leaving that distinction implicit forces each of them to invent its own
test — inconsistently, and in ways that a future call site can quietly get wrong.

| `purpose` | Created by | Cancellable by requester | Preemptible | Notes |
|---|---|---|---|---|
| `PRIMARY` | Intake, from a customer Task (§3.4) | Yes (§4.6) | By class rules (§4.8) | The ordinary case |
| `RECOVERY` | The recovery machinery: return-or-transfer after cancellation with custody held, or after an unrecoverable fault (§4.6, §4.7) | **No** | **Never** | Discharges a custody obligation that already exists |
| `TRANSFER` | The reassignment protocol, to collect goods from an incumbent agent (§4.7) | **No** | **Never** | A `RECOVERY`-class Leg with a custody handoff Stop |
| `REPOSITION` | Repositioning Planner (§17.3) | n/a — no customer | Freely, without penalty | Speculative; first to be shed under load |
| `EXERCISE` | Agent-starvation detection (§17.5) | n/a | Freely | Periodic self-test and proving runs |
| `MAINTENANCE_TRANSIT` | Maintenance interaction (§16.6) | No | No | Transit to a service bay |

Two derived sets are referenced throughout and are defined once here:

- **`custodial_purposes` = {`RECOVERY`, `TRANSFER`}** — Legs whose function is to discharge an
  outstanding physical obligation. These are exempt from the cancellation guard (§4.6), are
  never preemptible (§4.8), and are never shed by admission control (§20.5).
- **`speculative_purposes` = {`REPOSITION`, `EXERCISE`}** — Legs with no customer commitment,
  shed first under load and preemptible without penalty.

Purpose is part of the Leg's durable record, appears in the decision record, and is a
dimension of the rejection and cost telemetry, so "what fraction of this shard's capacity is
going to recovery work" is a query rather than an inference.

For the common single-agent point-to-point delivery, Mission = one Leg = two Stops, and the
model collapses to the simple case with no overhead. The generality exists so that
consolidation (one Leg, many Tasks), chaining (one agent, sequential Legs), and multi-modal
long-haul (many Legs, many agents, transfer points) are the same model rather than three
subsystems (§25.3).

**The unit of assignment is the Leg, and the Leg is also the decision index of the
objective** (§1.4). The engine assigns Legs to Agents. A Task's SLA contract is *decomposed
downward* onto its Legs by the attribution rule of §8.7 — exactly one Leg of a Mission carries
the parent Task's full delay-cost term, and the others carry a slack-consumption term — and
Task-level SLA *outcome* is then computed by aggregating realised times over those Legs at
settlement (§4.9). Attribution downward for pricing and aggregation upward for reporting are
distinct operations, and conflating them double-counts lateness on multi-Leg Missions.

### 2.5 Custody — a first-class concept

**Custody** is possession of physical goods. It is tracked explicitly because it changes
what recovery is *physically possible*, and the baseline system has no representation of it
at all.

| Custody state | Meaning | Recovery semantics on agent failure |
|---|---|---|
| `NONE` | Agent carries nothing for this task | Reassign freely; no physical intervention |
| `PENDING_TRANSFER` | At the pickup, handover in progress | Abort is safe; may require sender re-engagement |
| `HELD` | Agent physically carries the goods | **Reassignment requires physical goods recovery** — a `TRANSFER` Leg or human retrieval (§2.4, §4.7) |
| `RELEASED` | Delivered and confirmed | Task complete pending verification |
| `DISPUTED` | Evidence conflicts | Operator adjudication required; no automatic action |

This distinction is the single most operationally important lifecycle refinement in this
design. A failure before custody is a scheduling problem: cancel, requeue, reassign, done. A
failure after custody is a *physical logistics problem*: the goods are inside a stalled
machine at a location, and no amount of database repair moves them. The engine MUST NOT
model these as the same event, and MUST NOT mark a Task requeueable while custody is `HELD`
(§4.7, §26 invariant I7).

### 2.6 Commitment, Lease, and Epoch

A **Commitment** is the durable contract binding an Agent to a Leg. **Only HARD commitments
exist in the Commitment Store**; the SOFT reservation is a different kind of object entirely,
specified below and deliberately given a different name and a different home.

| Field | Purpose |
|---|---|
| Commitment id | Idempotency and correlation key across every subsystem |
| Agent id, Leg id | The binding |
| Fence | Monotonically increasing integer drawn from the agent's `fence_counter` — the **commitment-scope fencing token** (§10.3). Compared *per commitment id*, never as a single maximum across the agent's concurrent commitments |
| Lease expiry | Absolute time after which the commitment is presumed lost unless renewed |
| Custody state | §2.5 |
| Plan snapshot | The stop sequence, route references, and predicted timeline that were committed |
| Decision reference | Pointer to the decision record that produced it (§21.2) |
| Version | Optimistic-concurrency counter for conditional writes |

#### SOFT reservations versus HARD commitments — and the durability rule

**Decision: a SOFT reservation is round-local coordinator state and MUST NOT be written to the
Commitment Store. A HARD commitment is durable. There is no third case.**

| | SOFT reservation | HARD commitment |
|---|---|---|
| Home | Assignment Coordinator's in-memory plan state for the shard | Commitment Store, durable |
| Architectural layer | L4 — decision layer: retryable, no external effect (§3.1) | L3 — commitment layer: exactly once, fenced |
| Physical effect | **None.** No command has been sent to any agent | An offer has been dispatched; the agent may be moving |
| Fence allocated | No — there is nothing to fence | Yes, at commit (§10.3) |
| Lease | No | Yes (§12.2) |
| Capacity accounting | Against the coordinator's plan state, within the round loop | Against the durable `capacity[agent_class]` constraint, enforced by the commit transaction and a schema constraint (§10.3) |
| Revision cost | `C_churn` only (§8.9) | The reassignment protocol (§4.7) |
| On coordinator failover | **Reconstructed, never recovered** (§19.5) | Recovered; the new leader reconciles against it before resuming rounds |

**Why SOFT must not be durable.** A SOFT reservation is revised by the churn mechanism on a
rolling horizon, so its write rate is the *re-planning* rate — rounds per second times planned
Legs — not the mission rate. Persisting it would put an entire optimisation loop inside the
serialised, exactly-once per-shard section, and the shard would exceed its own commit-transaction
budget by more than an order of magnitude (§3.5, §20.2). It would also be persisting a decision
that has, by construction, produced no effect in the physical world. The layering of §3.1 already
states the correct answer: work with no external effect belongs in L4, where it may be repeated
and recomputed freely.

**What is durable during planning is the Leg's own state,** not its provisional binding. A Leg
enters `PLANNED` with one durable write and one durable timer for its hardening deadline; the
identity of the provisionally selected agent then changes as often as the optimiser wishes at no
durable cost. This preserves supervision (T4), the orphan scan (§12.4), and ladder accounting
(§17.4) without putting re-planning on the durable path.

**Losing a SOFT reservation is safe by construction.** On failover the new leader finds Legs in
`PLANNED` with no HARD commitment, returns them to `QUEUED`, and re-plans them in its first
round (§19.5). The cost is one round of planning work. Because no agent was ever told anything,
no physical state can disagree with the database, and no fence is needed to make this safe.

**SOFT versus HARD is the mechanism for late binding.** A SOFT reservation is a plan: it reserves
capacity in the optimiser's view of the world and may be revised by the next round at the cost of
`C_churn`. A HARD commitment has been dispatched and accepted by the agent, which may already be
moving; revising it requires the explicit reassignment protocol (§4.7). Deferring hardening until
the agent must actually start improves decision quality — later decisions have more information —
while the churn price prevents unbounded oscillation. The hardening deadline is
`commit.hardening_deadline` before the agent must depart, per agent class.

### 2.7 Observations and freshness

**Every fact about the physical world is an Observation, never a bare value.**

| Field | Purpose |
|---|---|
| Value | The measurement |
| Observed at | When the *agent* measured it — not when the server stored it |
| Received at | When the server accepted it — used for link-latency measurement |
| Source | Sensor, agent report, inferred, operator-entered, forecast |
| Confidence / variance | Where the sensor provides it |
| Sequence number | Per-agent monotonic, for ordering and replay detection |

Every consumer of an Observation declares a **staleness budget**. Exceeding it makes the
value `INDETERMINATE`, which is a distinct outcome from "absent" and from "present"
(§7.3). This eliminates by construction the baseline's registry-expiry cliff, in which
several inputs simultaneously degraded to their *most permissive* defaults precisely when an
agent had stopped reporting — that is, when a negative signal was silently read as positive.

Positions additionally carry **dead-reckoning provenance**: a position extrapolated from the
last fix and a velocity is marked as such, with a growing uncertainty radius. Extrapolation
is permitted for cost estimation and prohibited for safety constraints.

### 2.8 Entity relationships

```
Tenant ──< Task ──< Stop
                 └─ RequirementSet, PayloadSpec, SLAContract

Task >──< Mission ──< Leg ──< Stop            (a Mission may discharge several Tasks;
                        │                      a Task may span several Legs)
                        │
                        └── Commitment (HARD only, durable) ──> Agent
                                  │
                                  ├── Lease (expiry)
                                  ├── Fence (commitment-scope, §10.3)
                                  ├── CustodyRecord
                                  └── DecisionRecord ──> ConfigVersion, ModelVersionSet

    SOFT reservations are NOT in this graph: they are round-local Coordinator state
    (§2.6), reconstructed on failover, never persisted.

Agent ──> AgentClass ──> MobilityModel, EnergyModel, ContainerModel, CapabilityBundle
      ──< Observation
      ──> HealthState, ReliabilityEstimate, AccountingState
      ──> OperatingRegion ──> AssignmentShard

OperatingRegion ──< Zone ──< Cell          (containment by published assignment, §3.6)
                ──< Site ──< Cell, GraphZone
```

---

## 3. System Architecture

### 3.1 Layered view

The architecture separates four layers by *failure semantics*, which is the property that
matters most under partial failure. A layer may only depend downward.

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

The critical property: **L1 may be lossy and L4 may be repeated, but L3 must be exactly
once.** This is the inverse of the baseline, where the cache (an L1 concern) carried the
exclusivity guarantee. Concentrating the consistency requirement into the smallest possible
layer — a single conditional write per HARD commitment — is what allows every other layer to
be fast, replicated, and failure-tolerant.

This layering is also the reason SOFT reservations are not durable (§2.6): a SOFT reservation
produces no external effect, so by the definition of this layering it belongs in L4, where
being lost simply means being recomputed. Admitting re-planning traffic into L3 would enlarge
the exactly-once section by the ratio of re-planning rounds to missions, which is precisely
the enlargement this layering exists to prevent.

### 3.2 Component catalogue

| Component | Responsibility | Layer | State | Scaling |
|---|---|---|---|---|
| Intake API | Validate, admit, deduplicate, price-check, enqueue | L2 | stateless | horizontal |
| Work Queue | Durable priority queue of pending Legs per shard | L1/L3 | durable | per shard |
| Assignment Coordinator | Owns the round loop for one shard; the only writer of HARD commitments in that shard; holds the shard's round-local SOFT reservation state (§2.6) | L3 (commit) + L4 (plan state) | leader-elected; plan state in memory, reconstructed on failover | one active per shard |
| Candidate Service | Spatial and hierarchical candidate discovery with lower-bound pruning | L4 | read-only | horizontal |
| Feasibility Evaluator | Constraint predicate evaluation, three-valued | L4 | pure | horizontal |
| Cost Evaluator | Direct, opportunity, risk, lifecycle, delay, churn terms | L4 | pure | horizontal |
| Plan Builder | Stop sequencing, insertion evaluation, timeline and energy projection | L4 | pure | horizontal |
| Column Builder | Enumerates and prices candidate columns (single-Leg and multi-Leg) by marginal insertion cost | L4 | pure | horizontal |
| Solver | Set-partitioning solve over columns with deferral variables; degenerates to min-cost flow in the singleton regime (§9.3) | L4 | pure | horizontal |
| Commitment Store | Durable HARD commitments, agent authority epochs and fence counters, leases, outbox | L3 | durable, authoritative | shard-partitioned |
| Dispatcher | Outbox drain, delivery, ACK/NACK correlation, retry | L2 | stateless workers | horizontal |
| Supervisor | Durable timers for every non-terminal state | L2 | durable timer store | per shard |
| Reconciler | Continuous desired-vs-actual audit and repair | L2 | stateless, leader-gated | per shard |
| Agent State Service | Observation ingestion, live state, spatial index maintenance | L1 | cache + durable log | horizontal |
| Routing Service | Travel time, distance, geometry, matrices, elevation | L1 | cache-heavy | horizontal |
| Forecast Service | Demand forecast per zone per horizon bucket | L1 | batch-computed | regional |
| Capacity Pricing Service | `λ_zone` per zone/time; publishes `Ω_terminal` for the region with each price snapshot (§6.4, §8.3.1) | L1 | derived | regional |
| Reliability Service | Per-agent reliability and health-tier estimates | L1 | batch + streaming | global, replicated |
| Energy Model Service | Consumption/charge prediction and per-agent calibration | L1 | model registry | global, replicated |
| Config Service | Versioned, scoped, validated configuration | L1 | replicated, cached | global |
| Decision Log | Immutable decision records | L1 | append-only durable | global |
| Explanation API | Human- and machine-readable decision explanation | — | read-only | horizontal |
| Simulation Harness | Offline replay, shadow evaluation, scenario testing | — | offline | offline |

### 3.3 Data stores and their assigned roles

Store selection follows from what each guarantee requires, not from convenience.

| Store | Holds | Guarantee required | Why this store |
|---|---|---|---|
| Relational (primary, per shard) | HARD commitments, agent authority epochs and fence counters, leases, custody, tasks, legs, outbox | Serialisable conditional writes, durability, foreign keys | Exclusivity is a transactional invariant (§10.3); nothing else provides it. SOFT reservations are explicitly excluded (§2.6) and their absence is schema-enforced (invariant I18) |
| Durable log / stream | Observations, state transitions, decision events, audit | Ordered, replayable, retained | Enables replay, calibration, and post-hoc analysis; decouples ingestion rate from store latency |
| In-memory / cache tier | Live agent state, spatial index, route cache, prices | Low latency; **loss must be survivable** | Explicitly non-authoritative; reconstructible from the log and next heartbeat within one heartbeat interval |
| Timer store | Supervisor deadlines | Durable, ordered by due time, at-least-once fire | In-process timers do not survive worker loss — the baseline's structural gap |
| Analytical store | Decision records, realised outcomes, calibration data | High-volume append, columnar query | Calibration and tuning are analytical workloads and MUST NOT contend with the decision path |
| Object store | Route geometries, plan snapshots, large evidence payloads | Cheap bulk, content-addressed | Keeps large blobs out of the transactional store; referenced by hash for immutability |

**Mandatory constraint:** the cache tier MUST NOT hold the only copy of any fact required for
correctness. The test is explicit and MUST be part of the release gate: *flush the entire
cache tier under load; no commitment may be lost, duplicated, or double-granted; only latency
and decision quality may degrade* (§24.5).

### 3.4 Request-path versus round-path

Two distinct flows, deliberately decoupled.

**Request path (synchronous, milliseconds).** `Intake API` validates, checks admission and
quota, resolves the shard, writes the Leg into the durable work queue, and returns an
accepted response carrying the task id, an idempotency echo, the queue position, and an
**honest predicted assignment window** derived from current queue depth and supply. The
response MUST NOT imply an assignment has occurred. The baseline returns HTTP 200 carrying a
`PENDING` row with no indication of whether any agent exists; a caller cannot distinguish
"working on it" from "will never happen." Here, the contract is explicit: intake succeeded,
assignment is in progress, and the outcome will arrive by event and is queryable by id.

**Round path (asynchronous, sub-second cadence).** The `Assignment Coordinator` for each
shard runs a continuous loop: collect the batch, discover candidates, evaluate feasibility,
evaluate cost, solve, commit, dispatch, and record. Round cadence is adaptive (§9.2).

The decoupling matters because these have opposite requirements. Intake must be fast,
horizontally scalable, and available. The round must be serialised, consistent, and
deterministic. Fusing them — the baseline's `setImmediate` detach — produces an unsupervised
background computation with no owner, no timeout, no retry, and no observability, which is
the root cause of the audit's "stuck at PENDING with no record of the failure" behaviour.

### 3.5 Shard model

An **AssignmentShard** owns a set of Agents and the Legs whose work is served by them,
partitioned by **OperatingRegion** (a site, campus, depot catchment, or metro service area).

- Every Agent belongs to exactly one shard at a time. Shard membership changes are
  explicit, transactional handoffs, never inferred from position drift.
- Every Leg is routed to exactly one shard at intake, determined by its first Stop's
  region.
- Cross-region work is decomposed at intake into per-shard Legs joined at transfer points,
  orchestrated as a saga (§19.6).

#### Shard sizing: two independent bounds, and the binding one wins

Shard size is bounded by two separate resources, and the specification states both because a
shard sized against only the first will silently violate the second.

**Bound 1 — round wall-clock.** One Coordinator must complete a round within its latency budget
(§20.1). This bound is measured, not derived, and it scales with local mission rate and
candidate counts, not with agent count directly.

**Bound 2 — the serialised commit section.** Every durable transaction against a shard's
Commitment Store is serialised behind that shard's single writer (§19.3). Let

```
r        = missions per agent per hour                  (workload property)
k_txn    = durable transactions per mission lifecycle   (see below)
t_txn    = mean commit-transaction service time         (measured; p99 is bounded at 20 ms, §20.1)
ρ_max    = commit.max_serial_utilisation                (default 0.25)

N_agents  ≤  ρ_max · 3600 / ( r · k_txn · t_txn )
```

`k_txn ≈ 2.05`: one commit (§10.3), one settlement release (§4.9), and a measured allowance of
roughly 0.05 reassignment or recovery transactions per mission (§4.7). **SOFT reservations
contribute zero**, because they are never written (§2.6) — this is the single largest term the
design removes from the serial section, and the reason the bound is satisfiable at all.

Worked at the defaults — `r = 4`, `k_txn = 2.05`, `t_txn = 5 ms`, `ρ_max = 0.25`:

```
N_agents  ≤  0.25 · 3600 / ( 4 · 2.05 · 0.005 )  ≈  21 950 agents
```

which is what justifies the stated target range of **1 000–20 000 agents per shard**. The range
is a consequence of the arithmetic, not a guess. Two properties of this bound MUST be respected
in deployment:

- **It is inversely proportional to mission rate.** A dense urban shard running short hops at
  `r = 20` admits roughly 4 400 agents, not 20 000. Shard size is therefore configured per
  region against that region's measured `r`, and the Config Service rejects a shard definition
  whose product `N · r · k_txn · t_txn` exceeds `ρ_max · 3600` at publish time (§22.1 rule 5).
- **`ρ_max` is a queueing bound, not a capacity bound.** The serial section behaves as an M/D/1
  queue; at `ρ = 0.25` the mean queueing delay is a small fraction of `t_txn`, and the p99 commit
  latency target of §20.1 remains achievable. Sizing to `ρ → 1` would meet a throughput figure
  while destroying the latency target that bounds the leadership-fence vulnerability window
  (§10.3, §19.5).

Both bounds are continuously monitored as SLIs (§21.4), and the *binding* one is reported, so
that a shard split is triggered by whichever resource is actually exhausted.

Shards are the unit of scaling, of failure isolation, of leader election, and of
configuration scope. Because assignment is spatially local (T9), partitioning by region is
near-lossless: the quality sacrificed by refusing to consider an agent in a different region
is negligible, and it is *measured* by an offline evaluator that periodically re-solves
recent rounds with relaxed boundaries and reports the realised gap (§21.5). A boundary that
proves costly is evidence that the region definition is wrong — the correct fix is
redistricting, not global search.

### 3.6 Spatial concepts and their containment

Four spatial units appear across this document, each introduced by the mechanism that needs it:
**region** as the sharding key (§3.5), **site** as a configuration scope (§22.2), **zone** as
the unit prices are keyed by (§8.3), and **cell** as the index and cache key (§6.2, §20.3).
Their relationships are stated once, here, because four scoping units with unstated containment
produce inconsistent configuration scoping in practice — and because the pricing unit was, until
this section, absent from the configuration hierarchy that is supposed to resolve it.

| Unit | Definition | Contained in | Typical cardinality | Primary consumers |
|---|---|---|---|---|
| **OperatingRegion** | The shard boundary: a metro service area, campus, or depot catchment. Every Agent and every Leg belongs to exactly one at a time | — (top of the spatial hierarchy) | 1 per shard | §3.5 sharding, §19.2, config scope |
| **Site** | A bounded place with its own access rules and service-time behaviour: a depot, a campus building, a mall, a warehouse. Indoor and multi-level sites use graph zones rather than geodesic cells (§6.2) | Exactly one region | 10¹–10³ per region | §13.2 service times, §22.2 config scope, access constraints |
| **Zone** | The **pricing and coverage unit**: a contiguous operational area over which supply and demand are aggregated and `λ_zone` is estimated | Exactly one region; a zone MUST NOT straddle a region boundary | 10–200 per region | §8.3 pricing, §17.3 balancing, §7.5 F27 authorisation |
| **Cell** | The **index and cache** unit: a discrete geospatial cell (H3/S2). The generic fine scale is ~200–500 m and the coarse scale ~5–10 km; a bounded deployment MAY adopt a finer fine cell through a **declared spatial model** (see below) | A fine cell lies in exactly one zone **by assignment**, not by geometry | 10³–10⁵ fine cells per region | §6.2 index, §6.4 pruning, §20.3 caches |

Three rules make this usable rather than merely descriptive:

- **Containment is by assignment, not by geometry.** A zone is defined as a *set of fine cells*,
  and a site as a *set of fine cells plus its indoor graph zones*. Deriving containment from
  polygon intersection at query time would make a cell's zone depend on floating-point geometry
  evaluated per round, which is both slow and non-deterministic (T6). The cell→zone and
  cell→site maps are published configuration, versioned, and pinned into the round snapshot like
  any other input (§9.6).
- **A zone never straddles a region.** Were it permitted to, `λ_zone` would be estimated from
  demand served by two independent shards, and the pruning bound's `Ω_terminal` — a maximum over
  prices *within the search region* (§6.4) — would no longer bound anything the shard can
  actually reach. Region redistricting therefore redistricts zones with it, and the Config
  Service rejects a zone definition spanning regions at publish time (§22.1 rule 5).
- **Sites and zones are orthogonal, and deliberately so.** A large depot may be its own zone; a
  small one sits inside a zone with the streets around it. Site is *where service behaviour is
  learned*; zone is *where supply is priced*. Forcing one to nest inside the other would make one
  of the two the wrong shape for its purpose.

#### The declared spatial model

*Amended 2026-09-14 by owner decision `RD-2026-09-14-01` (D3). The generic scales above are
unchanged; what is added is the exemption a bounded deployment may take, and the evidence it
must produce to take it.*

The fine and coarse scales above are the **generic defaults**, and they are sized for a metro
service area. A deployment whose physical extent makes the generic fine scale unsuitable —
a campus of a tenth of a square kilometre cannot be covered by cells a quarter of a kilometre
across — **MAY adopt a finer fine-cell resolution through an explicitly declared spatial
model.**

A declared spatial model MUST name:

- its **indexing primitive**;
- its **fine resolution**;
- its **coarse resolution**;
- the **spatial verification evidence** it requires.

and MUST be verified for **coverage, safety, determinism, performance and privacy** before
publication. A model that has not produced that evidence is not published.

Two limits on the exemption:

- **The 10³–10⁵ fine-cell cardinality band is NOT relaxed by it.** A declared model changes
  the cell *size*, not the cardinality rule. A deployment whose count falls outside the band
  records an explicit `cover.cardinalityException`, which is a statement someone makes rather
  than a consequence of choosing a resolution.
- **A cell remains the index and cache unit and nothing more.** A finer cell does not become
  a delivery-domain boundary: membership of the serviceable region is decided on the exact
  coordinate against published geometry, evaluated at intake and pinned, not derived from
  cell membership. An index cell may overlap the region boundary without conferring
  serviceability on the ground it covers.

---

## 4. Assignment Lifecycle

### 4.1 Design rules for the lifecycle

Four rules generate the state machines below, and each directly answers a class of baseline
defect.

1. **Every non-terminal state has an owner and a deadline.** No state may be entered without
   a durable timer registering its expiry, and the transition on expiry MUST be specified.
2. **Every state transition is a conditional write** on the entity's version and, where the
   agent is involved, on its commitment epoch. Unconditional writes permit the baseline's
   silent cancellation reversion, in which finalisation overwrote `CANCELLED` back to
   `ASSIGNED` without reading the current status.
3. **State is never inferred from the absence of data.** Absence triggers investigation, not
   assumption.
4. **Physical reality outranks the database.** Where the two diverge, the reconciler adjusts
   the database and, when goods or motion are involved, escalates to a human rather than
   assuming its own record is correct.
5. **No external side effect precedes the guarded write that authorises it.** Every command to
   an agent — offer, withdrawal, recall, reroute, stand-down — is emitted **only** by draining
   the outbox, and its outbox row is written in the *same transaction* as the state transition
   and fence advance that authorise it (§10.3.2 step 5, §11.1). No component may send a command
   by any other path.

   This rule exists because two mechanisms — the reconciler (§12.4) and the durable-timer
   supervisor (§4.5) — can independently act on the same entity at overlapping times. Conditional
   writes already ensure that only one of them wins the *state transition*; without this rule
   nothing ensures that the *command* follows the write that won. A reconciler that bumps a fence
   and then separately issues a recall can emit that recall before the bump commits, or after the
   bump has been rolled back — producing a duplicate stand-down, or a command carrying an
   authority that does not exist. Binding the command to the transaction removes both cases by
   construction, and it is why §4.7 step 2 is stated as a single transaction rather than as an
   ordered pair of steps. The dispatch path already had this property; this rule generalises it
   to every producer of commands.

### 4.2 Task state machine

The Task is the customer-visible contract. Its states are deliberately coarse; execution
detail lives on the Leg.

| State | Meaning | Exit deadline |
|---|---|---|
| `RECEIVED` | Accepted by intake, not yet validated | `intake.validation_budget` |
| `REJECTED` | Failed validation or admission (terminal) | — |
| `PLANNABLE` | Validated; decomposed into Legs | immediate |
| `WAITING` | One or more Legs pending assignment | `sla.assignment_deadline` |
| `IN_EXECUTION` | At least one Leg has a HARD commitment | mission timeline + margin |
| `AT_RISK` | Projected to breach its SLA target | escalation ladder (§17.4) |
| `SUSPENDED` | Blocked; awaiting operator or external resolution | `ops.suspension_review_period` |
| `VERIFYING` | Delivered; verification evidence incomplete (§12.5) | `verify.evidence_deadline` |
| `COMPLETED` | Delivered and verified (terminal) | — |
| `CANCELLED` | Cancelled by requester or operator (terminal) | — |
| `FAILED` | Undeliverable after exhausting recovery (terminal) | — |

`AT_RISK` exists as a distinct state, rather than a computed flag, so that risk is
*actionable and alertable* at the point it becomes true, and so that a task's history records
when it became endangered — which is the information an incident review needs.

### 4.3 Leg state machine

The Leg is the unit of assignment and the state machine that carries operational weight.

| State | Meaning | Deadline | On expiry |
|---|---|---|---|
| `QUEUED` | Eligible for the next round | `sla.assignment_deadline` | escalation ladder (§17.4) |
| `DEFERRED` | Round decided to wait; re-enters `QUEUED` next round | `assign.max_deferral_time` | force widen + escalate |
| `PLANNED` | SOFT reservation held in coordinator plan state; revisable at `C_churn` (§2.6) | `commit.hardening_deadline` | harden or re-plan |
| `OFFERED` | Dispatched to agent; awaiting ACK | `dispatch.offer_ttl` | withdraw, exclude agent, re-plan |
| `ACCEPTED` | Agent ACKed; HARD commitment; not yet moving | `execute.start_grace` | probe, then reassign |
| `EN_ROUTE_PICKUP` | Moving to first Stop | projected ETA × `execute.eta_tolerance` | progress probe (§12.3) |
| `AT_PICKUP` | Arrived; servicing | `stop.service_time_limit` | operator alert |
| `LOADED` | Custody `HELD` | — | — |
| `EN_ROUTE_DROP` | Moving to destination | projected ETA × tolerance | progress probe |
| `AT_DROP` | Arrived; servicing | `stop.service_time_limit` | operator alert |
| `RELEASED` | Custody released; evidence pending | `verify.evidence_deadline` | verification escalation |
| `SETTLED` | Leg complete, verified, accounted (terminal) | — | — |
| `ABORTING` | Recovery in progress | `recover.abort_budget` | force to the applicable `STRANDED_*` state |
| `STRANDED_SAFE` | Recovery impossible without physical intervention; the agent is stopped at a location whose obstruction class is `CLEAR` | `ops.stranded_safe_response_target` | page operations |
| `STRANDED_OBSTRUCTING` | As above, but the agent is obstructing a right of way, an emergency route, or a hazardous location | `ops.stranded_obstructing_response_target` | page operations **and** the external escalation chain (§18.6) |
| `REASSIGNING` | Being moved to a different agent | `recover.reassign_budget` | escalate |
| `WITHDRAWN` | Offer withdrawn before acceptance (terminal for that pairing) | — | — |
| `CANCELLED` | Cancelled (terminal) | — | — |
| `FAILED` | Unrecoverable (terminal) | — | — |

The distinction between `OFFERED`, `ACCEPTED`, and `EN_ROUTE_PICKUP` is essential and
absent from the baseline, which conflates all three into `ASSIGNED`. Without it the system
cannot distinguish (a) an agent that never received the assignment, (b) an agent that
received it and is deliberately holding it — the baseline's silent 30-minute charge
deferral — and (c) an agent that is executing normally. These require three different
responses; a single state permits none of them.

The `STRANDED_*` states are first-class states, not errors. In a physical system, some
situations are genuinely unrecoverable by software: an agent with goods aboard, immobilised,
out of communication. Representing that honestly, with an operations SLA attached, is strictly
better than representing it as `ASSIGNED` forever.

**Why stranding is two states and not one.** A robot stopped harmlessly in a car park and a
robot stopped across a tram line, a level crossing, or a fire exit are the same event only to
a database. The second is a public-safety event: its response time is measured in minutes
rather than hours, and its escalation chain includes traffic authorities and emergency
services rather than an operations queue. A single state with a single response target either
over-escalates the first case until operators learn to ignore the alert, or under-escalates
the second — and the second failure mode is the one that ends a deployment.

The distinction is **derived automatically, never operator-entered**, from the obstruction
class of the stopping location supplied by the Map service (§5.2):

| Obstruction class of stopping location | Leg state | Response target | Escalation |
|---|---|---|---|
| `CLEAR` — verge, bay, plaza, off-carriageway | `STRANDED_SAFE` | `ops.stranded_safe_response_target` (default 4 h) | Operations queue |
| `RESTRICTIVE` — footway, shared space, access road; passable but impeding | `STRANDED_SAFE`, with an elevated priority and a shortened target | `ops.stranded_restrictive_response_target` (default 45 min) | Operations queue, paged |
| `BLOCKING_CRITICAL` — carriageway, tram or rail crossing, emergency route, fire exit, dock apron | `STRANDED_OBSTRUCTING` | `ops.stranded_obstructing_response_target` (default 10 min) | Page **plus** the external escalation chain (§18.6) |

Where the obstruction class is unavailable or stale beyond its budget, the classification is
`INDETERMINATE` and resolves to `STRANDED_OBSTRUCTING` under policy `DENY` semantics (T2,
§7.3): an unknown stopping location is treated as the more serious case, because the cost of
over-escalating a safe stranding is an unnecessary callout and the cost of under-escalating an
obstructing one is an incident. This is the same asymmetry that governs self-reported agent
health (§23.5), applied to location.

This distinction also closes a gap the mid-mission energy logic already assumed: §14.8 reasons
explicitly about choosing *where* to stop an agent before it fails, which is only a meaningful
choice if where it stops changes what happens next. It now does, and the obstruction class of
the projected stopping location is an input to that choice rather than a post-hoc observation.

### 4.4 Complete transition table

`⟨guard⟩` denotes a precondition that MUST hold for the transition.

- Transitions that touch only the Leg are conditional writes on `leg.version`.
- Transitions that create, revise, or release a **HARD commitment** are conditional writes on
  `(leg.version, agent.authority_epoch, shard.leadership_fence)` and additionally allocate or
  advance that commitment's own **fence** (§10.3).
- Transitions between `QUEUED`, `DEFERRED`, and `PLANNED` involve **no commitment and no
  fence**, because no command has been sent to any agent (§2.6).

The distinction matters: the agent's `authority_epoch` guards *agent-level* authority and does
not move on ordinary commits, so several commitments may be created against one agent in one
round without invalidating each other. A per-commitment fence guards each mission's own
commands. Conflating the two makes a `capacity > 1` agent uncommandable (§10.3).

| From | Event | To | Guard | Side effects |
|---|---|---|---|---|
| `QUEUED` | round selects a column containing this Leg | `PLANNED` | column feasible (§13.1) ∧ `leg.version` CAS ok | SOFT reservation recorded in coordinator plan state; durable Leg-state write; hardening timer registered; decision record |
| `QUEUED` | round selects defer | `DEFERRED` | — | decision record with defer reason |
| `QUEUED` | assignment deadline | `QUEUED` | ladder step available | relaxation applied and recorded (§17.4) |
| `QUEUED` | ladder exhausted | `FAILED` | — | task `FAILED`, operator notification |
| `DEFERRED` | next round | `QUEUED` | — | — |
| `PLANNED` | re-plan selects a different agent | `PLANNED` | churn priced, no custody | prior SOFT reservation discarded in memory; **no durable write, no fence, no commitment released** — nothing was ever committed |
| `PLANNED` | hardening due | `OFFERED` | feasibility re-verified; commit guards of §10.3 all pass | HARD commitment created with a freshly allocated fence; lease granted; outbox row written in the same transaction |
| `PLANNED` | agent becomes infeasible | `QUEUED` | — | SOFT reservation discarded; cause recorded |
| `PLANNED` | coordinator failover | `QUEUED` | new leader reconciling (§19.5) | reservation reconstructed, not recovered; Leg re-planned in the first round |
| `OFFERED` | agent ACK | `ACCEPTED` | commitment fence matches, offer unexpired | commitment `HARD`; lease renewed |
| `OFFERED` | agent NACK | `QUEUED` | — | commitment released; exclude agent for `dispatch.nack_cooloff`; record reason; health signal |
| `OFFERED` | offer TTL expiry | `WITHDRAWN` → `QUEUED` | — | withdraw command at an advanced commitment fence; commitment released; agent penalised in reliability |
| `ACCEPTED` | departure detected | `EN_ROUTE_PICKUP` | motion corroborated | — |
| `ACCEPTED` | start grace expiry | `REASSIGNING` | no custody | probe, then reassign |
| `EN_ROUTE_PICKUP` | arrival verified | `AT_PICKUP` | geofence + evidence | — |
| `EN_ROUTE_PICKUP` | ETA breach | `EN_ROUTE_PICKUP` | — | re-project, may set task `AT_RISK` |
| `EN_ROUTE_PICKUP` | blocking fault | `ABORTING` | no custody | recovery (§18.2) |
| `AT_PICKUP` | custody acquired | `LOADED` | payload evidence | custody `HELD`, payload state updated |
| `AT_PICKUP` | pickup impossible | `ABORTING` | — | requester notified |
| `LOADED` | departure | `EN_ROUTE_DROP` | — | — |
| `EN_ROUTE_DROP` | arrival verified | `AT_DROP` | geofence + evidence | — |
| `EN_ROUTE_DROP` | blocking fault | `STRANDED_SAFE` or `STRANDED_OBSTRUCTING` | custody `HELD`; state chosen by the obstruction class of the stopping location (§4.3) | **`RECOVERY` Leg required** (§4.7); external escalation if obstructing (§18.6) |
| `AT_DROP` | custody released | `RELEASED` | release evidence | custody `RELEASED` |
| `RELEASED` | verification complete | `SETTLED` | evidence sufficient | commitment released, its fence retired, capacity returned, accounting written |
| `RELEASED` | evidence insufficient | task `VERIFYING` | — | operator queue |
| any non-terminal | cancel request | `ABORTING` | cancel authorised ∧ `purpose ∉ custodial_purposes` | §4.6 |
| any non-terminal | lease expiry | `REASSIGNING`, `STRANDED_SAFE`, or `STRANDED_OBSTRUCTING` | by custody state and obstruction class | §12.2 |
| `STRANDED_SAFE` | obstruction class re-evaluated as `BLOCKING_CRITICAL` (agent moved, or map updated) | `STRANDED_OBSTRUCTING` | — | re-page at the shorter target; external escalation |
| `STRANDED_OBSTRUCTING` | agent cleared to a `CLEAR` location by responders | `STRANDED_SAFE` | corroborated position | de-escalate; recovery continues |
| `STRANDED_SAFE` / `STRANDED_OBSTRUCTING` | goods recovered and agent recovered | `FAILED` or `SETTLED` | custody accounted for (§4.9) | Leg terminates only once custody is discharged (I7, I8) |

### 4.5 Supervision: durable timers

**Every deadline in §4.2 and §4.3 MUST be registered in the durable timer store at the
moment the state is entered, and cancelled atomically with the state exit.**

- **Timers are keyed on the supervised entity's own version, never on the agent's authority
  epoch.** A Leg timer is keyed `(leg, leg_id, state, leg.version)`; a commitment timer is
  keyed `(commitment, commitment_id, state, commitment.fence)`. A timer whose version no
  longer matches its own entity is discarded on fire, which makes late-firing timers harmless
  without requiring reliable cancellation.

  This keying is a correctness requirement, not a convention. Keying timers on the agent's
  epoch would mean that committing or releasing *any unrelated Leg on the same agent*
  invalidates every timer for every other Leg that agent is carrying — silently removing
  supervision from missions that are executing normally, which is exactly the failure class
  durable timers exist to make structurally impossible. Each entity's supervision is
  therefore scoped to that entity's own version, and nothing else's.
- Firing is at-least-once; handlers MUST be idempotent.
- Timer handlers are subject to the same conditional-write discipline as any other
  transition. A timer never forces a state change; it *attempts* one.
- Timer-store lag is a first-class SLI. If the timer store falls behind by more than
  `supervise.max_timer_lag`, the shard enters degraded mode and stops issuing new HARD
  commitments, because it can no longer supervise them. This is a direct application of T3:
  losing supervision reduces what the engine will attempt.

This mechanism replaces, and structurally prevents, the entire family of baseline defects in
which a state persisted forever because no component owned its progression.

### 4.6 Cancellation

Cancellation is a request, not an instruction, and MUST be race-free against an in-flight
round. The baseline's cancellation of a `PENDING` task is silently reverted by the
concurrently-running assignment; that class of bug is prevented as follows.

1. Cancellation writes `cancel_requested_at` and increments the version in a transaction.
   It does **not** attempt to reach a terminal state directly.
2. **The cancellation guard is purpose-conditioned.** Every commitment transition's guard is:

   ```
   cancel_requested_at IS NULL   OR   leg.purpose ∈ custodial_purposes
   ```

   A round that was mid-flight when cancellation landed therefore fails its conditional write
   and abandons its decision — the correct outcome, with no lost update — while the `RECOVERY`
   and `TRANSFER` Legs that cancellation itself creates remain able to progress.

   The unqualified guard `cancel_requested_at IS NULL` would be self-defeating: step 3 below
   *mandates* generating a return-or-transfer Leg on a Task whose cancellation flag is, by
   definition, already set, and the unqualified guard blocks precisely that Leg. The exemption
   is therefore not a loophole in the guard; it is what makes the guard's own mandated recovery
   path executable. Expressing it through the first-class `purpose` attribute (§2.4) rather
   than through an ad-hoc flag is what keeps it consistent across every call site — the
   alternative is each implementer inventing a local exemption, inconsistently, which is how a
   guard of this kind acquires a bypass that later applies to cases nobody intended.

   The exemption is **narrow and closed**: it admits only `RECOVERY` and `TRANSFER`, both of
   which are created solely by the recovery machinery (§4.7), are never created from customer
   input, are themselves not cancellable by a requester, and terminate only when custody is
   discharged. A `PRIMARY` Leg can never acquire a custodial purpose, because `purpose` is set
   at creation and never mutated.
3. Resolution depends on custody:
   - Custody `NONE` and no HARD commitment: `CANCELLED` immediately.
   - HARD commitment, custody `NONE`: `ABORTING`; recall command issued; on ACK,
     `CANCELLED`; the recall is issued at an advanced fence for that commitment and the
     commitment is then released. The agent's other commitments are unaffected (§10.3.1).
   - Custody `HELD`: cancellation **cannot** complete autonomously. The Leg transitions to
     `ABORTING`, and a new Leg with `purpose = RECOVERY` is created to return the goods to
     origin or divert them to a designated recovery point. That Leg is queued, planned,
     committed, and settled through the ordinary pipeline — it is exempt from the cancellation
     guard by step 2, not by a special-case code path. The Task remains non-terminal until
     goods are accounted for. Cancelling a delivery does not make the parcel disappear, and the
     model MUST not pretend otherwise.
4. **A cancelled Task reaches `CANCELLED` only when every custodial Leg it spawned has
   settled.** Until then it is `SUSPENDED` with the outstanding custody obligation named. This
   is what invariant I11 now asserts, and it is a stronger statement than "a cancelled Task
   never transitions into execution": recovery Legs *do* execute, and must, so the invariant
   is stated over `PRIMARY` Legs and over custody discharge rather than over execution as such.
5. Cancellation authority is checked against the requester's scope, is rate-limited, and is
   audited (§23.6). A requester may not cancel a `RECOVERY` or `TRANSFER` Leg at all; only an
   authorised operator may, and only by explicitly reassigning the custody obligation to
   another disposition, which is itself recorded.

### 4.7 Reassignment protocol

Reassignment is the mechanism absent from the baseline entirely, and it MUST be
custody-aware.

**Triggers:** lease expiry, blocking fault, connectivity loss beyond budget, energy
shortfall projection, ETA breach beyond tolerance, agent NACK, operator action, preemption
by a higher-value mission clearing the margin of §4.8 rule 2, or a re-plan round finding a
better allocation while the commitment is still SOFT.

**"Materially better" is not a separate threshold.** It means exactly what the objective
already says it means: the re-planning column's price, *including* `C_churn` evaluated at the
elapsed time and distance already travelled (§8.9), is lower than the incumbent's. The churn
term was introduced precisely to make this comparison rigorous and to prevent oscillation, so
inventing a second prose threshold here would create a quantity that can disagree with the
optimiser — and the two would then have to be kept in agreement by review discipline. There is
one threshold, it is priced in CU, and it lives in the cost function.

**Protocol, custody `NONE`:**
1. Freeze the Leg (`REASSIGNING`); it stops being modifiable by rounds.
2. **In one transaction:** advance the incumbent commitment's fence, mark the commitment
   revoked, and write the recall command to the outbox at the new fence. The ordering is
   mandatory and is a transactional property, not a sequencing convention: the fence advance
   and the command that carries it are written together, so the recall can never be emitted
   before the authority that justifies it has committed, and no in-flight command from the
   superseded commitment can outrank the recall. **The fence advance does not wait for the
   agent to respond** — this is what makes reassignment safe when the incumbent is
   unreachable.
   Only the *reassigned commitment's* fence advances. Every other commitment the incumbent
   holds keeps its own fence and remains fully commandable, which is what permits
   reassignment of one Leg on a `capacity > 1` agent without disabling the rest (§10.3).
   Where the recovery requires the incumbent to abandon **all** work — quarantine, e-stop, or
   an unrecoverable fault — the agent-scope `authority_epoch` is advanced instead, which
   invalidates every commitment-scope authority the agent holds in one action (§10.3).
3. Release the commitment; mark the incumbent ineligible for this Leg for
   `recover.incumbent_cooloff` to prevent ping-pong.
4. Requeue with an aging credit equal to the time already lost, so the Leg is not penalised
   for the incumbent's failure.
5. Record cause, cost, and the reliability signal attributed to the incumbent.

**Protocol, custody `HELD`:** the goods are physically inside the incumbent. There are
exactly three lawful outcomes, and the engine MUST choose explicitly rather than defaulting:

| Outcome | Condition | Mechanism |
|---|---|---|
| **Resume** | Incumbent recovers within `recover.resume_window` and remains feasible | Lease renewed, replan route, continue |
| **Transfer** | Incumbent immobile or infeasible, but reachable and able to release custody, **and** a receiving party exists that can physically take the goods — an agent with `custody_transfer_capable` (§2.3) or a human intermediary | Generate a **transfer mission**: a second agent or a human is assigned to the incumbent's location; custody handoff is an explicit, evidenced Stop. Where no `custody_transfer_capable` agent class is deployed, this outcome is human-mediated by default and the engine MUST NOT select an agent-to-agent transfer |
| **Physical recovery** | Incumbent unreachable, unsafe, or unable to release | `STRANDED_SAFE` or `STRANDED_OBSTRUCTING` by the obstruction class of the stopping location (§4.3); page operations with location, custody manifest, agent condition, and access instructions; external escalation if obstructing (§18.6) |

A transfer mission is an ordinary Leg with `purpose = TRANSFER` (§2.4), a pickup Stop at the
incumbent's position, and a `RequirementSet` derived from the goods already aboard — so it
flows through the same optimiser with no special-case code path. Its priority inherits the
original Task's SLA plus a configured recovery premium, because a stalled parcel is worse than
an unstarted one. Its `TRANSFER` purpose additionally makes it exempt from the cancellation
guard (§4.6), non-preemptible (§4.8), and non-sheddable by admission control (§20.5) — three
properties that would otherwise each need their own ad-hoc test.

**Reassignment is bounded.** `recover.max_reassignments_per_leg` (default 3) caps the chain;
on exhaustion the Leg goes to `SUSPENDED` for operator decision. An unbounded reassignment
loop is a livelock that consumes fleet capacity while completing nothing.

### 4.8 Preemption

Preemption is permitted, narrowly, because forbidding it makes urgent work impossible to
serve in a saturated fleet, and permitting it freely produces thrashing.

Rules, all configurable and all enforced:

1. **Custody bar.** A Leg with custody `HELD` is never preemptible. Non-negotiable. Nor is any
   Leg whose `purpose ∈ custodial_purposes` (§2.4), whether or not it has yet taken custody:
   preempting the recovery of stranded goods to serve a fresh delivery inverts the priority the
   custody model exists to express.
2. **Margin requirement.** The preempting mission's total objective improvement MUST exceed
   `preempt.min_gain` *including* the churn cost, the victim's re-queue cost, the victim's
   accrued aging, and the wasted travel already performed. Preemption must be *provably*
   net-positive under the same objective, not merely locally attractive.
3. **Class ordering.** Only defined SLA-class relations permit preemption
   (`preempt.allowed_class_pairs`), so an operator can guarantee that certain classes are
   never preempted regardless of arithmetic.
4. **Victim protection.** A preempted Leg receives an aging credit and a
   `preempt.victim_immunity_period` during which it cannot be preempted again. This
   guarantees progress and prevents livelock.
5. **Budget.** `preempt.max_per_agent_per_hour` and a shard-level rate cap bound churn.
6. **Audit.** Every preemption records both missions, the computed gain, and the decision
   record ids. A rising preemption rate is a capacity signal, and MUST be alerted on rather
   than absorbed.
7. **The victim's disposition is explicit, and depends on how far it has physically got.**
   Rule 1 bars preemption once custody is `HELD`, but a victim may still be *in transit* to its
   pickup — rule 2 prices "wasted travel already performed," which presumes exactly that. What
   happens to such a victim is stated here rather than left to the implementer:

   | Victim state at preemption | Disposition | Physical action |
   |---|---|---|
   | `PLANNED` (SOFT) | The reservation is discarded in memory; the Leg returns to `QUEUED` | None — no agent was ever told anything (§2.6) |
   | `OFFERED` | The offer is withdrawn at an advanced commitment fence; the Leg returns to `QUEUED` | The agent, if it received the offer, discards it on the withdrawal |
   | `ACCEPTED` or `EN_ROUTE_PICKUP`, custody `NONE` | The commitment is released through the ordinary reassignment protocol (§4.7), **not** by a separate preemption path | A `RECALL` at an advanced commitment fence. The agent completes its current motion to a safe stopping point and becomes available *in place* — it does not return to a depot, because its new position is simply its position and the next round prices it there |
   | Any state with custody `HELD` or `purpose ∈ custodial_purposes` | **Not preemptible** (rule 1) | — |

   The victim retains no commitment of any kind after preemption: it is requeued with its aging
   credit and its immunity period (rule 4) and is re-planned in the next round like any other
   queued Leg. Leaving it holding a weakened form of commitment would create a fourth commitment
   strength alongside SOFT, HARD, and none — which §2.6 exists to prevent.

### 4.9 Settlement

`SETTLED` is separate from "delivered" because several things MUST happen after physical
completion and MUST not be skipped when a later step fails:

1. Verification evidence evaluated and archived (§12.5).
2. Custody closed; payload manifest reconciled to zero.
3. Commitment released; its fence retired; capacity returned to the pool. **The agent's
   `authority_epoch` is not touched** — an ordinary settlement is not an agent-level authority
   change, and advancing it would invalidate the fences of every other commitment the agent is
   concurrently executing (§10.3).
4. Accounting written: distance, energy, cycles, duty-cycle contribution, wear amortisation.
5. Realised-versus-predicted deltas emitted for ETA, energy, and dwell calibration (§21.5).
6. Reliability counters updated with the attributed outcome (§16.3).
7. SLA outcome recorded against the Task's contract.

Settlement is idempotent and retried until complete. An agent MUST NOT be returned to the
available pool before step 3, and step 3 MUST NOT occur before step 2 — releasing an agent
that still holds goods is a correctness violation (§26 invariant I7).

---

## 5. Interfaces

### 5.1 Upstream and downstream contracts

| Peer | Direction | Contract |
|---|---|---|
| OMS / customer API | inbound | Task submission with idempotency key, SLA class, payload spec, requirement set, time windows; returns accepted/rejected with an assignment-window prediction |
| OMS / customer API | outbound | Task lifecycle events, ETA updates, exception notifications, proof-of-delivery reference |
| WMS / site systems | inbound | Readiness signals, dock/door assignment, load confirmation |
| Operator console | bidirectional | Manual actions (§23.6), queue and fleet visibility, explanation queries, quarantine and override controls |
| Agent fleet | outbound | Offers, withdrawals, recalls, reroutes — all fenced and idempotent (§11) |
| Agent fleet | inbound | ACK/NACK, telemetry, progress, evidence, faults, custody events |
| Analytics / BI | outbound | Decision records, realised outcomes, SLI streams |

### 5.2 Dependency contracts and degradation

Every dependency MUST be specified with a latency budget, an availability budget, a
failure-mode behaviour, and — critically — the **envelope reduction** applied when it is
unavailable (T3). Without a pre-declared degradation behaviour, a dependency outage becomes
an improvisation.

| Dependency | Used for | Latency budget (p99) | Timeout | Behaviour on failure | Envelope reduction |
|---|---|---|---|---|---|
| Routing Service — matrix | Approach times for candidate sets | 150 ms | hard, with `AbortController`-equivalent | Fall back to cached matrices; then to geometric bound × detour factor | Max mission radius reduced to `route.degraded_max_radius`; energy reserve multiplied by `route.degraded_reserve_factor` |
| Routing Service — path | Executable geometry for a committed plan | 400 ms | hard | Cached path; then corridor-following fallback | Missions requiring precise geometry are not hardened; only pre-surveyed corridors dispatched |
| Map / graph service | Network topology, restrictions, **obstruction classification** per location (`CLEAR` / `RESTRICTIVE` / `BLOCKING_CRITICAL`, §4.3) | 1 s (cached) | hard | Use last-known snapshot with version pinned; an unavailable or stale obstruction class resolves to `BLOCKING_CRITICAL` | New or recently changed areas excluded from routing; stranding classification fails safe toward the more serious case |
| Forecast Service | Demand forecast for opportunity cost | 200 ms | soft | Use last good forecast; then a seasonal-baseline prior; then flat | Opportunity-cost term shrinks toward its configured prior; recorded as a degradation flag |
| Capacity Pricing | `λ_zone`, and `Ω_terminal` for the pruning bound | 100 ms | soft | Static per-zone `lambda_zone_prior` from config; `Ω_terminal` recomputed from those static prices, so the bound stays admissible under degradation | Opportunity term shrinks toward its prior; recorded as a degradation flag |
| Reliability Service | Failure probability, health tier | 200 ms | soft | Cohort prior for the agent's class | Agents lacking a health tier are barred from `sla_class ≥ critical` work |
| Energy Model Service | Consumption and charge prediction | 100 ms | hard for feasibility | Class-level model without per-agent calibration | Energy reserve multiplied by `energy.uncalibrated_reserve_factor` |
| Agent State Service | Live observations | 50 ms | hard | Rebuild from durable log; agents without fresh state are `INDETERMINATE` (§7.3) | Shard-wide guard if the indeterminate fraction is excessive (§7.4) |
| Config Service | All parameters | 50 ms (cached) | soft | Last known-good version, pinned and reported | Config changes do not take effect; engine continues on the pinned version |
| Commitment Store | Exclusivity, durability, fence allocation | 20 ms | hard | **No degradation. Enter Custodial Operation** (§18.5): stop committing *and* stop commanding | Assignment halts; no commands issued; in-flight missions run autonomously to their agent-side autonomy limit; intake continues queueing; I2 explicitly suspended; §18.4, §18.5 |
| Timer store | Supervision | 50 ms | hard | Enter Unsupervised Commitment (§18.5): stop hardening new commitments (§4.5) | Existing missions supervised by reconciler sweep at reduced frequency; I4 explicitly suspended |
| Charging Scheduler | Charger reservations, target SoC, charger availability projection | 200 ms | soft | Pinned last-published projection; class-default target SoC | Depot-only `E_return` destinations; no charge interruption; target-SoC substitution flagged per decision (§14.5–§14.7) |

Two entries deserve emphasis.

**Routing MUST be self-hosted.** A metered per-request external routing API is
architecturally incompatible with this design: it introduces unbounded latency into a
supervised path, makes matrix queries a cost centre that discourages correct usage, imposes
rate limits that become the fleet's throughput ceiling, and — as the audit documents in the
baseline's partial-batch failure mode — turns a provider hiccup into a systematic scoring
bias. The engine MUST use a routing service it operates, with precomputed contraction
hierarchies or equivalent, colocated with the shard, and MUST treat any external provider as
a map-data source consumed offline rather than as a hot-path dependency.

**The Commitment Store has no degraded mode, by design.** This preserves the baseline's
fail-closed lock policy, which the audit correctly identifies as a considered safety
trade-off. The improvement here is what happens next: rather than marking every task
terminally `FAILED`, work accumulates in the durable queue with honest ETAs and drains when
the store returns (§18.4). Fail-closed on *commitment* need not mean fail-terminal on *work*.

---

## 6. Candidate Generation

### 6.1 The requirement

Candidate generation must satisfy three properties that are normally in tension:

- **Bounded work.** Per-decision cost MUST be a function of local agent density, not global
  fleet size (T9). A fleet of one million agents and a fleet of one thousand agents in the
  same neighbourhood MUST cost the same to serve.
- **Bounded suboptimality.** When the search is truncated, the engine MUST know and report
  *by how much* the answer could be wrong. The baseline's unordered `LIMIT 100` provides no
  such bound: with more than 100 eligible robots the globally best agent may simply never be
  scored, silently, with no signal.
- **Sparse-fleet correctness.** With one agent within 20 km, the search MUST find it rather
  than returning empty because a fixed radius was too small.

### 6.2 Index structure

The **Availability Index** is a live spatial index over assignable agents, maintained by the
Agent State Service and rebuildable from the observation log.

- **Discrete global cells.** Hierarchical geospatial cells (H3 or S2; H3's uniform hexagons
  are preferred because k-ring expansion has uniform metric meaning, which makes distance
  bounds tight). Two resolutions are maintained: a fine cell for neighbourhood lookup and a
  coarse cell for regional sweeps. The generic scales are ~200–500 m edge and ~5–10 km
  respectively; a bounded deployment may maintain a finer fine cell under a **declared
  spatial model** (§3.6), in which case the index is built at that model's resolutions and
  every resolution-dependent quantity — k-ring budgets, pruning bounds, the intra-cell
  offset, cache key spaces — is derived from them rather than from the generic scales.
  *Amended 2026-09-14, `RD-2026-09-14-01` D3.*
- **Index keys** are `(shard, coarse_cell, fine_cell, availability_class)` where
  availability class partitions agents into `IDLE_READY`, `CHARGING_INTERRUPTIBLE`,
  `FINISHING_SOON` (projected free within `candidate.finishing_soon_horizon`), and
  `QUEUE_CAPACITY_AVAILABLE`. Partitioning by class means the common case — find ready
  agents nearby — touches only the smallest partition.
- **Secondary indices** on capability class and container class, so that a mission requiring
  a refrigerated locker never enumerates agents that cannot possibly satisfy it. This is a
  large constant-factor win in heterogeneous fleets and MUST exist before heterogeneity is
  introduced.
- **Indoor and multi-level sites** use site-local graph zones rather than geodesic cells,
  because in a multi-storey building geodesic proximity is a poor proxy for travel time. The
  index abstraction is "proximity partition," and its implementation is per-region
  configuration.

**`FINISHING_SOON` is a significant capability the baseline lacks entirely.** Because an
agent's remaining mission time is projected, an agent that will be free in 90 seconds three
blocks away can beat an idle agent 4 km away. Restricting candidacy to currently-idle agents
discards the fleet's most useful near-term capacity. Admitting such agents requires only that
the cost model include the wait, which it does (§8.2).

### 6.3 Hierarchical expansion

For each pending Leg, candidates are gathered in expanding tiers, cheapest first:

| Tier | Scope | Purpose |
|---|---|---|
| 0 | Agents already committed to a compatible nearby Leg with spare queue capacity | Chaining and consolidation are usually the cheapest option and MUST be considered first (§13.3) |
| 1 | Origin fine cell and its immediate ring | The overwhelmingly common answer |
| 2 | k-ring expansion, k increasing | Density-adaptive local search |
| 3 | Origin zone, then adjacent zones | Respects operational boundaries and permissions |
| 4 | Region-wide coarse-cell sweep | Sparse-fleet fallback |
| 5 | `FINISHING_SOON` and `CHARGING_INTERRUPTIBLE` classes at widened radius | Considered when tiers 0–4 yield no acceptable option |
| 6 | Cross-region (explicitly authorised only) | Rare; requires policy permission and is separately audited |

Expansion is driven by the pruning rule of §6.4, not by a fixed ring count, and is bounded
by `candidate.max_expansion_tiers`, `candidate.max_radius_by_sla_class`, and a wall-clock
budget.

### 6.4 Admissible lower bound and the pruning rule

This is the mechanism that converts radius growth from a heuristic into a guarantee. It is
guaranteed only if the bound is genuinely admissible, and admissibility is a property of the
*whole* cost function, including the terms that can be negative. Those terms are enumerated
and bounded here rather than omitted.

#### The bound

**What the bound bounds.** Candidate generation answers one question — *which agents could
serve this Leg* — so `LB` is a lower bound on the price of a **single-Leg column** pairing agent
`a` with Leg `l`, and `C*` is the best such price found so far for that Leg. Multi-Leg columns
are not pruned against it, and comparing a multi-Leg column's price against a single-Leg `C*`
would be meaningless, since the two cover different amounts of work. Multi-Leg columns are
instead generated from the **union of the per-Leg candidate sets** (§9.3), so every agent they
use has already survived per-Leg pruning, and the residual loss from columns never proposed is
the separately reported column-generation gap. Each gap bounds exactly one approximation, and
neither is asked to bound the other.

Define **`LB(a, l)`** — a lower bound on the price of any single-Leg column pairing agent `a`
with Leg `l`, computable without routing:

```
LB(a, l) =   ( great_circle( position(a), first_stop(l) ) / v_max(class(a)) ) · λ_min
           + wait_until_available(a) · λ_min
           + E_min(a, l) · cu_per_wh
           + C_delay[l]( earliest_possible_completion(a, l) )
           − Ω_terminal(region, decision_time)
           − Ω_policy
```

The first four components are **non-negative provable underestimates**: the great-circle
distance is the shortest possible path on any network, `v_max` is an upper bound on achievable
speed, `λ_min` (`cost.lambda_time_floor`) is the configured floor on the marginal value of
agent time, `E_min` uses the best-case consumption coefficient over the straight-line distance,
and `C_delay` is increasing in completion time evaluated at the earliest physically possible
completion.

The last two components exist because **three cost terms can be negative, and a bound that
omits a negative term is larger than the true cost, not smaller.** Omitting them would make
`LB > γ` exactly in the cases the design most wants to find, and pruning would then silently
discard cells containing the true optimum while the decision record advertised a proven
guarantee. Each negative contribution is bounded by construction:

| Term | Sign | Treatment |
|---|---|---|
| `C_direct`, `C_risk`, `C_lifecycle` | ≥ 0 always | Underestimated as above; safe to bound loosely |
| `C_delay` | ≥ 0 always | Evaluated at earliest possible completion |
| `C_churn` | ≥ 0 always (§8.9) | Safe to omit entirely — omission of a non-negative term preserves admissibility |
| `C_opportunity` | **may be negative** — a repositioning-beneficial mission leaves the agent worth more than it cost to commit (§8.3, §17.3) | Bounded below by `− Ω_terminal` |
| `C_policy` | **may be negative** — the zone-affinity credit, the dedicated-fleet credit, the burn-in credit, the pilot adjustment, and the operator adjustment are all credits by construction (§8.6) | Bounded below by `− Ω_policy` |

**`Ω_terminal(region, t)`** is the maximum achievable terminal-value gain over the search
region: the largest reduction in `C_opportunity` that any relocation within the region could
produce. Because the unavailability component of `C_opportunity` is non-negative by
construction (§8.3), the whole term is bounded below by the negation of the relocation
component alone:

```
Ω_terminal = ( max λ_zone(z,·) − min λ_zone(z,·) ) · H_value
                 z ∈ region        z ∈ region
             + max_charge_access_gain(region)
             + max_soc_deficit_gain(class)
```

with `H_value = cost.opportunity.value_horizon`. All three quantities are computed once per
round from the same price snapshot the cost function uses (§8.3), published by the Capacity
Pricing Service alongside the price surface, and recorded in the decision record.

**`Ω_policy`** is `cost.policy.max_total_credit`, the sum of the configured ceilings of every
negative adjustment in the `C_policy` register. It is **derived at configuration publish time**,
not maintained by hand: the Config Service computes it from the individual credit ceilings and
rejects publication of any `C_policy` adjustment that does not declare a ceiling (§8.6, §22.1).
This is what makes the bound a structural property of the configuration rather than a claim
requiring separate maintenance.

**Cost of the correction.** `Ω_terminal` and `Ω_policy` are constants across all candidates
within a round, so subtracting them shifts the pruning threshold uniformly and **does not
change the order in which cells are visited**. The price of admissibility is therefore a
modestly wider search, never a distorted one. The realised widening — cells visited because of
the Ω correction — is a monitored SLI, because a large value indicates the policy credit
ceilings are set far above their realised use and should be tightened.

#### The pruning rule

Maintain `C*` = the best exact cost found so far. Cells are visited in increasing order of
their minimum possible `LB` (derived from cell-boundary geometry, so a whole cell can be
discarded without touching its members). Expansion terminates when:

```
min LB over all unexplored cells  ≥  C* − Δ_opt
```

**The tolerance is additive and denominated in CU** (`candidate.optimality_tolerance_cu`,
default 25 CU, per SLA class). A multiplicative tolerance is not admissible here: `C*` may be
zero or negative once `C_opportunity` is negative, and `C*/(1+ε)` is then not an upper bound on
anything — for negative `C*` it is larger than `C*`, and the rule would terminate the search
immediately. An additive tolerance in the same absolute unit as every other quantity in the
objective is well defined for every sign of `C*`, and it is what the unit discipline of §1.3
requires in any case: a tolerance is a cost, so it carries the cost unit.

At `Δ_opt = 0` the result is **provably exactly optimal over the whole region for the columns
generated**, while typically examining only a handful of cells. At `Δ_opt > 0` the result is
provably within `Δ_opt` CU of the regional optimum over that column set. The residual gap from
column generation itself is separate, separately bounded, and separately reported (§9.3); the
two are never summed into a single number, because they bound different approximations.

**When a budget truncates the search** — tier cap, candidate cap, or time cap — the engine MUST
record the achieved bound: `C* − min LB over unexplored` is a *proven* bound on the search
gap for that decision, in CU, and is non-negative by construction. That number is written into
the decision record and aggregated into an SLI (§21.4), and is additionally reported as a
fraction of the mission's SLA reference cost for human readability. This is the direct
structural answer to the audit's finding that the baseline's search truncation is both
unbounded and silent: here truncation is permitted, but its cost is always quantified and
reported.

**Admissibility is a build gate, not a sampled property.** `LB ≤ γ` is verified by an exhaustive
build-time check over the configured parameter space — every `C_policy` ceiling, every
`λ_zone` range, every agent class — and the build fails if any combination admits `LB > γ`
(§24.1). Sampling would eventually surface a violation, but only after the false guarantee had
already been written into production decision records and consumed by a first-class SLI, which
is precisely the failure mode that makes an unsound bound worse than no bound.

### 6.5 Candidate set sizing

Two thresholds, both configurable per SLA class:

- `candidate.target_feasible` (default 12) — expansion continues until this many *feasible*
  candidates exist, not this many *rows*. The baseline's `LIMIT 100` on a pre-feasibility
  query can return 100 rows of which zero are eligible, producing a spurious "no robots
  passed eligibility validation" while a suitable agent sat one ring further out.
- `candidate.max_evaluated` (default 200) — hard cap on full cost evaluations per Leg, to
  bound routing cost.

Where a batch contains many Legs in the same neighbourhood, candidate sets are computed once
per **cell cluster** and shared across those Legs, so the routing matrix is built once for
the union. This is the dominant performance optimisation in dense bursts (§20.4).

### 6.6 Determinism of the candidate set

Candidate enumeration MUST be deterministic: cells visited in a canonical order, agents
within a cell ordered by `(agent_id)`, and the resulting list ordered canonically before cost
evaluation. Any set ordering that depends on a query planner, hash iteration order, or
concurrent-response arrival order is prohibited. This is a precondition for T6 (replay), and
it also removes the baseline's arbitrary tie-breaking, in which exact ties resolved to
whichever row an unordered SQL query happened to return first.

---

## 7. Feasibility (Eligibility)

### 7.1 Position in the pipeline and the absolute rule

Feasibility is a **boolean gate evaluated before cost, on the full candidate set, with no
access to cost values** (T1). The cost evaluator MUST be structurally incapable of receiving
an infeasible pairing — enforced by type separation, not by convention, so that a future
change cannot accidentally introduce a path where a high-priority mission "scores around" a
safety rule.

This is the one architectural property of the baseline that is preserved without
modification, because it is correct. Everything else about eligibility changes.

### 7.2 Constraint taxonomy

Constraints are classified by *who may change them and under what authority*. This matters
because a single undifferentiated list of rules inevitably acquires a bypass.

| Class | Definition | Change authority | Override |
|---|---|---|---|
| **Invariant (I)** | Physical or safety impossibility; violating risks injury, damage, or legal breach | Safety engineering, formal review | **Never overridable by anyone, including operators and manual assignment** |
| **Regulatory (R)** | Legally mandated | Compliance | Never overridable operationally |
| **Contractual (C)** | Customer or tenant guarantees | Account management | Documented exception with audit |
| **Policy (P)** | Operational intent | Operations | Operator override with reason and audit |
| **Feasibility (F)** | Computed mission-specific possibility | Derived, not set | Not overridable; may be re-evaluated with different parameters |

**Manual assignment does not bypass constraints.** The audit documents that in the baseline,
supplying a robot id skips validation entirely, permitting assignment to a 6 %-battery or
faulted robot. In this design, manual assignment sets the candidate set to a single agent and
runs the identical feasibility gate. Class I, R, and F constraints are absolute. Class P
constraints may be overridden by an authorised operator, and every override records
identity, reason, and the specific predicate waived (§23.6). The operator's power is to
choose *which* agent, never to make an infeasible agent feasible.

### 7.3 Three-valued evaluation

Each predicate returns **`SATISFIED`**, **`VIOLATED`**, or **`INDETERMINATE`**.
`INDETERMINATE` means the predicate could not be evaluated — data absent, stale beyond its
budget, or from an untrusted source.

Each predicate declares an **indeterminate policy**:

| Policy | Meaning | Permitted for |
|---|---|---|
| `DENY` | Treat as violated | **Mandatory** for all class I and R predicates |
| `DENY_UNLESS_ENVELOPE` | Deny, unless a reduced-envelope variant of the mission is feasible under pessimistic assumptions | Class F where a conservative bound exists |
| `ADMIT_WITH_PENALTY` | Admit, add `cost.uncertainty_penalty[predicate]`, and shrink the mission envelope | Class P and non-safety F only |
| `ADMIT` | Admit unchanged | Only predicates with no safety or contractual consequence |

Every `INDETERMINATE` resolution is recorded per decision with the predicate name and the
reason. This inverts the baseline's defaults, where a null battery reading passed eligibility
*and* scored as 100 %, an absent health record passed the fault check, and an expired live
state yielded the best possible utilisation score. Under T2, unknown is never permission.

### 7.4 The systemic-indeterminacy guard

Strict `DENY` on unknown data has a failure mode of its own: a telemetry or state-service
outage would render the whole fleet infeasible and halt the operation. Fixing the baseline's
fail-open behaviour by naive fail-closed would trade a safety bug for an availability
outage. The guard resolves this:

1. Per round, compute the fraction of candidates rejected solely due to `INDETERMINATE`.
2. If that fraction exceeds `feasibility.systemic_indeterminacy_threshold` (default 0.30),
   the cause is systemic — an infrastructure fault — not a property of the agents.
3. On that determination the shard enters **Restricted Operation** — a named mode in the
   degraded-mode register (§18.5), which suspends no invariant. It does not relax any
   class I or R predicate. Instead it (a) raises a high-severity alert immediately, (b)
   restricts new commitments to missions within `degraded.max_mission_scope`, (c) multiplies
   energy reserves by `degraded.reserve_factor`, (d) permits only agents whose *last known
   good* observation is within `degraded.max_last_known_age` and is corroborated by an
   independent signal such as a network-level session liveness check, and (e) records every
   such commitment as degraded-mode for later review.
4. Restricted Operation is time-boxed by `degraded.max_duration`, after which the shard stops
   issuing new commitments and requires explicit operator acknowledgement to continue.

This is T3 in its purest form: the response to lost information is a smaller operating
envelope with louder alarms, never a lowered safety margin.

### 7.5 The constraint register

Evaluated in the order shown. Ordering is by *evaluation cost*, cheapest first, so that
expensive computed predicates run only on candidates that survive cheap ones. This ordering
is a performance property only; the result is order-independent because every predicate is a
pure function of the snapshot.

#### Group 1 — Identity and lifecycle (local, sub-microsecond)

| # | Predicate | Class | Rationale | Indeterminate |
|---|---|---|---|---|
| F1 | Agent exists and is commissioned | I | An uncommissioned agent has no validated configuration, so no other predicate's inputs are trustworthy | DENY |
| F2 | Lifecycle state is `active` | P | Quarantined, in-maintenance, or decommissioned agents are administratively withdrawn | DENY |
| F3 | Not under operator hold or quarantine | P | Human judgement outranks the optimiser; holds exist precisely to remove an agent the model still likes | DENY |
| F4 | Tenant and fleet scope permit this mission | C | Multi-tenant isolation; a shared-fleet agent must be contractually permitted for this customer | DENY |
| F5 | Software/firmware version is in the supported set for this mission type | I | An agent whose firmware cannot parse or safely execute a mission type must never receive it; version skew is a real and frequent cause of field incidents | DENY |
| F6 | Calibration and certification valid **at projected mission end** | R | Sensor calibration or a handling certificate expiring mid-mission is a compliance and safety breach; checking at decision time is insufficient | DENY |

#### Group 2 — Safety and health (local, cached)

| # | Predicate | Class | Rationale | Indeterminate |
|---|---|---|---|---|
| F7 | Emergency stop not engaged | I | Absolute | DENY |
| F8 | No active fault of severity ≥ `blocking` | I | Graded rather than binary: a `degraded` fault does not bar work but raises risk cost and may bar high-value work (§16.5) | DENY |
| F9 | Health tier ≥ tier required by the mission's SLA class | P | A marginal agent should not carry a critical or high-value mission even when it is nominally functional | DENY |
| F10 | Localisation confidence ≥ threshold for the mission's environment, **corroborated independently of the localisation stack itself** | I | An agent that does not reliably know where it is cannot be safely dispatched into shared space. Self-reported pose covariance alone is insufficient: localisation failures are frequently *confidently wrong*, which is what makes them dangerous rather than merely inconvenient, and gating on the failing subsystem's own opinion of itself contradicts the asymmetric-trust rule of §23.5. The predicate therefore requires the reported covariance **and** at least one corroborating signal — agreement with an independent positioning source where one exists, map-matching residual within bounds, or divergence between odometry and the last accepted fix within `localisation.max_odometry_divergence`. Corroboration unavailable is `INDETERMINATE`, not satisfied | DENY |
| F11 | Reliability estimate within acceptable bound for the mission class | P | Bars an agent whose recent intervention rate has degraded past a threshold, before a human notices (§16.4) | `ADMIT_WITH_PENALTY` using the cohort prior |
| F12 | No safety-relevant recall or advisory outstanding against this agent class | R | Fleet-wide grounding must be enforceable in one action | DENY |

#### Group 3 — Connectivity and commandability (live state)

| # | Predicate | Class | Rationale | Indeterminate |
|---|---|---|---|---|
| F13 | Live session exists and heartbeat is within `connectivity.max_heartbeat_age` | I | Availability MUST mean "commandable now," established from a live session, not from a throttled database column that may lag reality by tens of seconds | DENY |
| F14 | Command path proven: a recent command round-trip or heartbeat ACK succeeded | I | A socket that is open but not carrying traffic is not a proven command path; this is the predicate that prevents dispatching to a silently dead link | DENY |
| F15 | Link quality sufficient for the mission's supervision requirement | P | Missions requiring continuous supervision or teleoperation fallback need a link budget; a mission in a known dead zone requires an agent certified for autonomous operation there | `ADMIT_WITH_PENALTY` |
| F16 | Observation freshness within the budget for every safety-relevant input | I | The general form of the freshness rule (§2.7) | DENY, subject to §7.4 |

#### Group 4 — Commitment and availability

| # | Predicate | Class | Rationale | Indeterminate |
|---|---|---|---|---|
| F17 | The candidate plan holds no more than `capacity[agent_class]` concurrent commitments and extends no further than `plan.commitment_horizon` | I | Generalises one-mission-per-agent; capacity 1 reproduces the strict rule exactly. Evaluated as a property of the **plan** (§13.3), which is what allows queue depth > 1 without introducing a non-separable arc into the solve (§9.3) | DENY |
| F18 | No conflicting reservation held by another subsystem (charging, maintenance, teleop) | I | Prevents the classic bug where two schedulers each believe they own the agent | DENY |
| F19 | Projected availability time ≤ mission's latest feasible start | F | Admits `FINISHING_SOON` agents while ensuring the wait is actually affordable | DENY |
| F20 | Not excluded for this Leg by cooloff, incumbent penalty, or NACK cooloff | P | Prevents reassignment ping-pong and repeated offers to a refusing agent | DENY |

#### Group 5 — Capability and payload

| # | Predicate | Class | Rationale | Indeterminate |
|---|---|---|---|---|
| F21 | `RequirementSet(m) ⊆ CapabilityBundle(a)` under the typed algebra of §2.3 | I | Functional suitability; the baseline treats every robot as interchangeable, which is safe only in a homogeneous fleet and silently wrong in any other | DENY |
| F22 | Total payload mass ≤ rated capacity × `payload.safety_factor` at every point in the plan | I | Overload affects braking, stability, and structural limits; must hold **per stop**, since load changes along a multi-stop plan (§15.4) | DENY |
| F23 | Dimensional and volumetric packing feasible | I | A parcel that does not physically fit cannot be carried; tiered check in §15.3 | DENY |
| F24 | Centre-of-gravity envelope satisfied for every loading state | I | Tipping risk on gradients and in turns | DENY |
| F25 | Thermal class of an assigned compartment covers the payload's required range for the projected duration | C/R | Cold-chain integrity; duration-dependent, so it is a mission-level not agent-level check | DENY |
| F26 | Hazmat, security, and segregation rules satisfied for the combined load | R | Incompatible goods must not share a compartment; a security-classified item requires a lockable compartment | DENY |

#### Group 6 — Spatial, temporal, and regulatory permission

| # | Predicate | Class | Rationale | Indeterminate |
|---|---|---|---|---|
| F27 | Agent authorised in every zone the planned route traverses | R/P | Authorisation is a property of the *whole route*, not of the endpoints; a route crossing an unauthorised zone is illegal even with legal endpoints | DENY |
| F28 | Route uses only road/surface classes the MobilityModel permits | I | A sidewalk robot must not be routed onto a carriageway; enforced by routing with the agent's profile rather than by post-hoc checking | DENY |
| F29 | Dimensional passage feasible along the route (widths, heights, kerbs, gradients, lift capacity) | I | An agent that cannot fit through the route's tightest constriction cannot execute it | DENY |
| F30 | Time-of-day, day-of-week, and event restrictions satisfied for the projected traversal window | R | Curfews and event closures apply at traversal time, not decision time | DENY |
| F31 | Environmental envelope satisfied over the projected mission window using forecast, not current, conditions | I | Dispatching into a forecast storm because it is currently dry is a foreseeable failure | DENY |
| F32 | Site access prerequisites obtainable (gate, dock, lift, door credential) | F | An agent that cannot get in cannot deliver | `DENY_UNLESS_ENVELOPE` |
| F33 | Geofence: origin and destination inside the serviceable region | C | Also a hard input-validation rule at intake; the baseline accepts any latitude/longitude, including out-of-range values | DENY |

#### Group 7 — Computed mission feasibility

| # | Predicate | Class | Rationale | Indeterminate |
|---|---|---|---|---|
| F34 | **Energy feasibility with layered reserves at the configured confidence, evaluated at all three shortfall tiers** (§14.5) | I | The single most important addition relative to the baseline's instantaneous 20 % floor: feasibility is a property of the *mission*, not of the current charge. One predicate, three simultaneous conditions — a divert-to-charge, a physical recovery, and an in-service immobilisation carry consequences orders of magnitude apart and cannot share one probability target. The binding tier is recorded per rejection (§7.7) | DENY |
| F35 | Charger reachable from the projected mission end with reserve intact | I | Prevents the "completed the delivery, stranded afterwards" failure, which a mission-only energy check permits | DENY |
| F36 | Maintenance interval not exceeded before projected mission end | P | Prevents a service interval lapsing mid-mission | DENY |
| F37 | Deadline feasibility: earliest feasible completion ≤ hard deadline | F/C | Hard only where the deadline is contractually hard; otherwise it is priced by `C_delay` rather than gating, because refusing to serve a late task is usually worse than serving it late | DENY when hard |
| F38 | Plan validity: a complete, executable plan exists with all stops sequenced within their time windows | F | The union of all the above; a candidate is feasible only if an actual plan exists | DENY |

**Total: 38 predicates against the baseline's effective 8**, of which two were unreachable or
redundant. The increase is not gratuitous: F5, F6, F14, F22–F26, F27–F31, and F34–F36 each
correspond to a documented class of field incident in mobile-robot fleets, and every one is
unrepresentable in the baseline's domain model.

### 7.6 Feasibility caching and invalidation

Full feasibility evaluation for 200 candidates per Leg across a large batch is expensive.
Three levels of caching, each with an explicit invalidation rule:

1. **Agent-invariant predicates** (F1–F12, F21 partially) depend only on agent state and are
   cached per agent, invalidated by any change to lifecycle, health, capability, firmware, or
   certification. These are the cheapest and most frequently reused.
2. **Agent×MissionClass predicates** (F21, F25, F26, F28, F29 for a route class) are cached
   per `(agent_class, mission_class, zone)`, invalidated by config or map version change.
3. **Mission-specific predicates** (F22–F24, F30–F38) are not cached but are ordered last and
   short-circuit early.

**A negative cache is maintained for infeasible pairings** keyed by the reason, with a TTL
matched to the reason's volatility: a capability mismatch is stable for the agent's
configuration lifetime, while an energy shortfall is valid only until the next state update.
Caching a rejection with the wrong TTL is a correctness hazard, so the TTL MUST be derived
from the reason rather than set globally.

### 7.7 Rejection reporting

Every rejection is *evaluated* as the structured tuple `(agent_id, predicate_id,
observed_value, required_value, input_source, observation_age)`. This is stricter than logging
a message string, and it is what makes "why did the fleet reject this mission" queryable rather
than grep-able.

**Aggregation happens at decision time; only the per-candidate rows are sampled.** The tuples
are folded into the shard's rejection histograms *before* the decision record is written, so
the two derived SLIs below are exact over **100 % of decisions** even though the individual
rows land in the sampled Tier B (§21.2). Aggregating first and sampling second is what allows
full-fidelity capacity diagnostics and bounded write volume to hold simultaneously; sampling
first would degrade the histogram to an estimate and destroy exactly the property that makes it
useful for capacity planning.

Two derived signals are first-class SLIs:

- **Binding-constraint distribution** per zone, mission class, and Leg `purpose`. If 60 % of
  rejections in a zone are F34 (energy), the operational answer is charger placement, not
  scoring changes. This turns the engine into an instrument for capacity planning. For F34 the
  binding **tier** (§14.5) is part of the key, since a fleet blocked on immobilisation risk and
  one blocked on divert-to-charge risk need different interventions.
- **Near-miss margins.** For each rejected predicate, the *distance* from satisfaction, kept as
  a streaming quantile sketch rather than raw rows. A fleet routinely failing F34 by 3 % is one
  configuration change away from working, and that is very different from failing by 60 %.

The Tier A record retains the per-decision rejection **summary** — counts by binding predicate
across the whole candidate set — so "why is this task still waiting" is answerable from Tier A
alone for every decision, without reconstruction (§21.3).

---

## 8. Cost Function

### 8.1 Structure and units

All terms are in CU (§1.3). All are computed in fixed-point integer milli-CU for
determinism (§9.6). Every coefficient below is a configuration parameter with the units
shown; none is a bare number in code.

**The cost function is defined over a plan, not over a pairing.** This is the form the
objective of §1.4 requires, and it is the form that makes chaining priceable:

```
Φ(plan) =  C_direct(plan) + C_opportunity(plan) + C_risk(plan)
         + C_lifecycle(plan) + C_policy(plan)
         + Σ        C_delay[l]( completion_time(l, plan) )
        l ∈ legs(plan)
```

where `legs(plan)` is **every** Leg the plan executes — the Legs being newly inserted *and*
the Legs the agent had already committed. A column's price is the difference of this
functional at two plans, plus churn (§1.4):

```
γ(c) = Φ( plan(c) ) − Φ( plan₀(a(c)) ) + C_churn(c)
```

Two consequences follow immediately, and both are load-bearing.

**The pairing cost is the degenerate case.** For an idle agent `a` and a single Leg `l`,
`plan₀(a)` is empty and `γ = Φ(plan with l) = Cost(a,l)`, which is the form every subsection
below is written in. Nothing about the single-mission case becomes more complicated.

**Insertion is priced correctly and automatically.** For an occupied agent, `Φ(plan(c))`
includes the delay that inserting a new Leg imposes on the agent's existing Legs, the extra
energy, the extra wear, and the altered terminal state. There is no separate "insertion cost
model" that could disagree with the cost model; there is one functional evaluated at two
plans (§13.3).

The reader should note what this does **not** contain: no normalisation, no rescaling, no
relative ranking. Each addend is an estimate of a real quantity of resource consumed or value
destroyed. That property is what makes the sum comparable across candidates, across
missions, across agent classes, and across time — and therefore what makes batch
optimisation, deferral, and heterogeneous fleets possible at all.

**Sign discipline.** `C_direct`, `C_risk`, `C_lifecycle`, `C_delay`, and `C_churn` are
non-negative by construction. `C_opportunity` and `C_policy` may be negative, and both are
bounded below by configured quantities so that the pruning bound of §6.4 remains admissible.
Every term therefore declares its sign and, where it can be negative, its lower bound. A cost
term whose sign is not stated cannot be safely pruned against, and this document uses pruning.

### 8.2 `C_direct` — the physical cost of doing the work

```
C_direct = λ_time(a) · ( t_wait + t_approach + t_service_first
                       + t_linehaul + t_service_last + t_terminal )
         + cu_per_wh · E_mission(a, m)
         + cu_per_metre_wear(a) · d_mission
```

| Component | Definition | Estimation | Hard/soft |
|---|---|---|---|
| `t_wait` | Time until the agent can start: remaining committed work plus any charge top-up needed | Plan projection (§13) | soft; gated by F19 |
| `t_approach` | Travel time from projected release position to the first stop | Routing Service with the agent's MobilityModel, congestion-adjusted for the projected departure window | soft |
| `t_service_first` | Dwell at the first stop: docking, load, door, lift, handover, evidence capture | Learned per `(site, stop_type, mission_class, time_of_day)` with a configured prior; the median service time at a busy lobby differs materially from a kerbside handover | soft |
| `t_linehaul` | Travel time across the remaining stop sequence | Routing Service | soft |
| `t_service_last` | Dwell at the final stop | as above | soft |
| `t_terminal` | Mandatory post-mission activity attributable to this mission — principally a required charging leg when the mission leaves the agent below its charge trigger | §14.6 | soft |
| `E_mission` | Total energy for the plan including approach, linehaul, dwell loads, thermal, and any terminal leg | Energy Model (§14.2) | also gates F34 |
| `d_mission` | Total distance travelled | Routing | soft |
| `λ_time(a)` | Cost of one second of this agent's committed time | Config per agent class, from amortised capital, energy, maintenance, and supervision cost | — |

**Why the linehaul leg belongs here even though it is often robot-independent.** For a
single-stop pickup-to-drop mission the linehaul time is identical for every candidate, so it
contributes an equal constant to every candidate's cost and cannot change the argmin *of this
term*. The audit's framing — that omitting the drop leg is the central scoring defect —
therefore needs refinement. Including the full mission matters for five concrete reasons, all
of which the baseline forfeits:

1. **Energy feasibility.** `E_mission` requires the whole plan. Without it, the engine cannot
   answer "can this agent finish?" — the baseline's most consequential safety gap.
2. **Opportunity cost.** `C_opportunity` scales with total commitment duration, which
   includes linehaul. A 40-minute mission and a 4-minute mission consume very different
   amounts of the resource, and pricing them identically is simply wrong.
3. **Terminal state value.** Where the agent *ends* determines its future usefulness, and the
   end position depends on the linehaul (§8.3).
4. **Chaining and insertion.** For an agent with existing commitments, the marginal cost is
   an insertion cost over the whole sequence, which is robot-dependent throughout (§13.3).
5. **Deadline feasibility and delay cost.** `C_delay` depends on completion time, which
   requires the whole timeline.

So the correct statement is not "the drop leg was missing from the ranking" but **"the
baseline's objective was structurally unable to represent the mission, and therefore unable
to represent energy feasibility, resource consumption, terminal value, chaining, or
deadlines."** The remedy is to model the mission, not merely to add a distance term.

**Distance versus travel time.** `t_approach` is *road-network travel time*, obtained from
the Routing Service, never a great-circle distance. Geometric distance appears in exactly one
place in this design — the admissible lower bound of §6.4 — where its only requirement is
that it underestimate. Using geometry for scoring, as the baseline does at weight 0.50,
makes the engine blind to rivers, walls, one-way systems, level changes, and closures; the
audit's observation that a robot across a river outranks one on the same street is a direct
consequence and is unfixable by reweighting.

### 8.3 `C_opportunity` — the resource-allocation term

This term has no counterpart in the baseline and is the largest single source of expected
quality improvement. It is also the most mathematically delicate term in the model, so it is
derived here rather than asserted, and it is built from **one** calibrated primitive rather
than from several independently-estimated quantities that could double-count each other.

#### 8.3.1 The single primitive: the availability value density

**`λ_zone(z, τ)`** — the marginal reduction in expected future operating cost obtained from
having one additional *available* agent in zone `z` at time `τ`, in CU·s⁻¹, supplied by the
Capacity Pricing Service. This is the only quantity in the opportunity model that is
estimated from data; everything else is derived from it by integration.

Estimation, in order of preference:

1. **Forecast-driven queueing estimate (primary).** From the forecast arrival rate `Λ(z,τ)`,
   projected available supply `S(z,τ)`, and a fitted response-time-versus-supply curve
   `R(z, S)`, take `λ = Λ · ∂(delay cost)/∂S`. Because `R` is convex decreasing in `S`, this
   is large when supply is scarce relative to demand and small when supply is ample —
   exactly the desired behaviour. The fitted curve is empirical, per zone, per time bucket,
   refreshed from realised data.
2. **Solver duals (calibration).** The dual variables of the agent-exclusivity constraints of
   §1.4 are in-round marginal prices, used to *calibrate* estimator 1 rather than to drive the
   current decision. Their status depends on the solve regime and MUST be recorded with them
   (§9.3): in the **singleton-column regime** the relaxation is integral, so the duals are
   exact marginal prices of the integer problem; in the **multi-Leg-column regime** the
   relaxation is generally fractional, so the duals price the relaxation and are an
   approximation to the integer problem's marginal values. Calibration MUST either restrict
   itself to singleton-regime rounds or record the LP–IP gap alongside each dual it consumes.
   Treating relaxation duals as exact prices is an error the design declines to make silently.
3. **Static configured prices (degraded).** Per-zone, per-time-bucket constants from
   `cost.opportunity.lambda_zone_prior` when the forecast is unavailable (§5.2).

#### 8.3.2 The availability value, and the terminal value derived from it

Fix an absolute **valuation horizon** `T_H = decision_time + cost.opportunity.value_horizon`.
For an agent standing *available* at position `p` from time `t`, define its availability value:

```
V_avail(p, t) = ∫[ t → T_H ]  λ_zone( zone(p), τ )  dτ           (CU, ≥ 0; zero for t ≥ T_H)
```

The terminal value of a state is that availability value less the CU-denominated costs the
state imposes before the agent can actually be useful:

```
V_terminal(p, soc, t) =  V_avail(p, t)
                       − expected_charge_access_cost( p, soc, t )
                       − soc_deficit_cost( soc )
```

Every component is already in CU, so **`V_terminal` carries no free weighting coefficients at
all.** This is deliberate. A dimensionless weight multiplying an already-priced quantity is a
second, unexplained exchange rate hidden inside the most complex term in the model, and it
contradicts the unit discipline that §1.3 identifies as the design's central methodological
commitment. The three components mean: ending in a zone with high forecast demand is
*valuable*; ending far from any available charger with a low state of charge is *expensive*;
ending below the operational reserve incurs the cost of the mandatory charge that follows.

#### 8.3.3 The opportunity cost, derived

Committing an agent destroys value in exactly two ways: it makes the agent unavailable for the
duration of the commitment, and it leaves the agent in a different state from the one it
started in. The total value destroyed is the difference between the value of the agent's state
had it not been committed and the value of the state the commitment leaves it in. Decompose
that difference by inserting and cancelling a single intermediate term:

```
C_opportunity =  V_terminal( p_start, soc_start, t_start )
               − V_terminal( p_end,   soc_end,   t_release )

              =  [ V_terminal(p_start, soc_start, t_start)                    ← unavailability
                   − V_terminal(p_start, soc_start, t_release) ]                 component

              +  [ V_terminal(p_start, soc_start, t_release)                  ← relocation
                   − V_terminal(p_end,   soc_end,   t_release) ]                 component
```

The two brackets **telescope exactly**: the intermediate term appears once positive and once
negative and cancels. They are therefore two components of one quantity, not two independent
estimators of the same quantity, and summing them cannot double-count. Evaluating the first
bracket gives the closed form:

```
unavailability = ∫[ t_start → t_release ]  λ_zone( origin_zone(a), τ )  dτ
```

because the charge-access and SoC-deficit terms are evaluated at the *same* state in both
halves of that bracket and cancel with it. So:

```
C_opportunity =  ∫[ t_start → t_release ] λ_zone( origin_zone(a), τ ) dτ
               + [ V_terminal(p_start, soc_start, t_release)
                   − V_terminal(p_end, soc_end, t_release) ]
```

Three properties of this formulation are the substance of the correction, and each replaces a
specific error that a less careful derivation invites.

**(a) No double count.** A shadow-price integral over the commitment and a terminal-value
difference are not two things to be added; they are the time-difference and the state-difference
halves of one telescoping identity. Adding two *independently estimated* quantities — one an
integral of forgone availability, the other a cost-to-go difference whose own coverage component
also measures forgone availability — charges the same resource consumption twice, over-penalises
long missions in proportion to their duration, and makes the model's true sensitivity to zone
prices roughly double what any calibration exercise would infer. Here there is one primitive,
`λ_zone`, and both components are integrals of it over disjoint domains.

**(b) The integral is taken over the origin zone, at a fixed position.** It is emphatically
*not* taken along the route the agent travels. An agent in transit is not available anywhere,
so integrating an *availability* price along its path would penalise a mission for the accident
of passing through an expensive zone — a quantity that measures nothing physical. The value
forgone accrues where the agent *would have been available had it not been committed*, which is
its origin zone. The relocation component, and only the relocation component, accounts for the
fact that it ends up somewhere else.

**(c) Both evaluations in the relocation bracket are at the same time, `t_release`.** Evaluating
the start state at `t_start` and the end state at `t_release` would fold the passage of time
into a term meant to measure displacement, silently re-charging the duration already priced by
the first bracket.

**Horizon discipline.** `V_avail` is zero beyond `T_H`, so a commitment extending past the
horizon is charged the full remaining-horizon integral and the term stops discriminating among
still-longer commitments. The Config Service therefore **rejects at publish time** any
configuration in which `cost.opportunity.value_horizon` is not strictly greater than
`plan.commitment_horizon` plus the region's maximum admissible mission duration (§22.1 rule 5).
A horizon shorter than the commitments being priced is a silent saturation, not a tuning choice.

**Sign and lower bound.** The unavailability component is non-negative, since `λ_zone ≥ 0`. The
relocation component may be **negative** — a mission that ends the agent in a higher-value zone,
or better placed for charging, is worth more than it cost to relocate it, which is exactly the
repositioning-beneficial case §17.3 relies on. `C_opportunity` is therefore bounded below by
`− Ω_terminal`, the maximum achievable relocation gain over the search region, which is computed
once per round from the same price snapshot and published with it (§6.4). That bound is what
keeps the candidate-pruning lower bound admissible, and it is derived from the price surface
rather than assumed.

**Why this term is worth its complexity.** Without it, the engine cannot distinguish
consuming the last agent in a busy district from consuming a surplus agent in a quiet one.
That single distinction is the difference between a dispatcher and a fleet allocator, and it
is measurable: the SLI is zone-level response-time variance, which a proximity-greedy
allocator inflates and this term suppresses. Return-to-base emerges from the relocation
component when it is actually worth it — near end of shift, at low charge, or in a low-demand
period — and does not occur when the agent is better left where it is. The baseline has no
such term, and the audit correctly identifies the consequence: with proximity-to-pickup
dominating and no terminal value, the fleet drifts toward drop clusters and never rebalances.

**Approximation error, stated.** `V_avail` is a finite-horizon, single-agent, myopic
approximation to a cost-to-go: it prices the marginal agent against a *forecast* supply curve
rather than solving the full multi-agent dynamic program. Two error sources follow, and both are
measured rather than assumed away. First, horizon truncation, bounded by
`∫[T_H → ∞] λ_zone dτ` and monitored by re-running the offline evaluator at a longer horizon
(§21.6); a material difference is evidence that `value_horizon` is too short. Second,
supply-response error, since committing this agent itself changes `S(z,τ)` for later rounds —
which is second-order for a single commitment in a shard of thousands, and is exactly what the
dual-variable calibration path of §8.3.1 exists to detect. Both are reported as calibration SLIs
(§21.5), which is the difference between a stated approximation and an unexamined one.

### 8.4 `C_risk` — expected cost of things going wrong

```
C_risk = p_fail(a,m) · C_failure(m)
       + Σ    p_energy[tier](a,m) · C_energy_consequence[tier]
        tier
       + p_late(a,m) · E[ C_delay overrun | late ]
       + staleness_penalty(a)
       + route_hazard_cost(route, conditions)
```

| Component | Estimation | Notes |
|---|---|---|
| `p_fail(a,m)` | Hierarchical Bayesian per-agent estimate, adjusted for mission difficulty (§16.3) | Mission-conditional: an agent with a history of failures on steep gradients is riskier for a hilly route specifically |
| `C_failure(m)` | Configured per mission class: recovery labour, vehicle time, goods value at risk, customer-remediation cost, reputational weight | Substantially higher once custody is `HELD`, which correctly biases the engine toward reliable agents for long-custody missions |
| `p_energy[tier]` | Tail probability of each of the three energy-shortfall tiers, from the energy model's predictive distribution (§14.5) | Non-zero even for feasible pairings — feasibility bounds each tier below its own `α[tier]`, and the residual is priced. Summed **per tier** because the consequences differ by five orders of magnitude in cost: a contingency diversion, a physical recovery mission, and an immobilisation in service are not the same event and must not share one price |
| `p_late` | From the ETA predictive distribution, not the point estimate | An agent with a high-variance ETA is penalised relative to an equally-fast, more-predictable one. Punctuality is a distinct property from speed, and only a distributional model captures it |
| `staleness_penalty` | Increasing in the age of the agent's safety-relevant observations | Prices decision uncertainty, so a well-observed agent is preferred among near-equals. Contrast the baseline, where stale state produced the *best possible* utilisation score |
| `route_hazard_cost` | Known obstacles, historical intervention hotspots per segment, weather exposure, crowd/event density | This is where the obstacle knowledge base becomes a *selection* input rather than a purely post-assignment reroute trigger |

Modelling risk as a priced expectation rather than a threshold means the engine trades risk
against cost coherently, and the trade is auditable because `C_failure` is a stated number
with a derivation.

### 8.5 `C_lifecycle` — amortised physical consumption

```
C_lifecycle = cu_per_metre_wear(class) · d_mission
            + battery_cycle_cost( ΔSoC path, DoD, temperature )        (§14.4)
            + actuator_cycle_cost( lifts, door cycles, latch cycles )
            + tyre_and_brake_cost( braking events, gradient exposure )
            + thermal_stress_cost( ambient, load )
```

This term is the *economically correct* basis for wear levelling, and it is why this design
needs only a small explicit fairness regulariser rather than a large artificial one (§17.1).
Each coefficient derives from a component's replacement cost divided by its rated life, which
is an accounting figure a maintenance engineer can supply and defend — not a tuned weight.

An important second-order effect: because battery cycle cost is depth-of-discharge weighted,
the engine spontaneously avoids deep discharges and prefers to spread shallow cycles across
the fleet, which is the correct Li-ion stewardship policy. No separate rule is required.

### 8.6 `C_policy` — explicit business intent

A named, individually-auditable adjustment for intent that is not derivable from physics.
**Every adjustment MUST declare a credit ceiling** — the largest negative value it may
contribute — because those ceilings are what make the candidate-pruning lower bound admissible
(§6.4). An adjustment without a declared ceiling is rejected at configuration publish time.

| Adjustment | Purpose | Credit ceiling parameter |
|---|---|---|
| Zone-affinity credit | Retains the baseline's zone-locality preference, now priced in CU rather than as a 0.05 additive constant, and applied where the operational reason is real (local knowledge, permit familiarity, supervision coverage) | `policy.max_zone_affinity_credit` |
| Dedicated-fleet credit/penalty | Steers a tenant's contractually dedicated agents to that tenant's work | `policy.max_dedicated_fleet_credit` |
| Training/burn-in policy | Directs new agents or new firmware to low-risk work during a probation window, with a configured decay — a genuine operational need with no other home | `policy.max_burn_in_credit` |
| Pilot/experiment adjustment | Scoped, expiring adjustments for controlled trials; MUST carry an expiry, and the engine MUST refuse an adjustment whose expiry has passed | `policy.max_pilot_adjustment` |
| Manual operator preference | An authorised, reasoned, audited nudge — bounded so that it can influence choice among feasible agents but never dominate the objective | `policy.max_operator_adjustment` |

```
Ω_policy  =  cost.policy.max_total_credit  =  Σ  (credit ceiling of each adjustment above)
```

`Ω_policy` is **computed by the Config Service at publish time**, never hand-maintained, and is
republished automatically whenever any constituent ceiling changes. Introducing a new policy
adjustment therefore updates the pruning bound as a mechanical consequence of registering it,
which is what prevents the bound from silently decaying as the policy register grows — the most
likely way an admissible bound becomes inadmissible over a system's life.

Every entry is individually reported in the decision record. A policy adjustment that cannot
be named and attributed is prohibited; this is where undisciplined systems accumulate their
magic constants, so the register itself is the control.

### 8.7 `C_delay` — SLA, priority, and aging

`C_delay` is indexed by **Leg**, because the Leg is the decision index (§1.4). Its parameters
descend from the parent Task's SLA contract by the attribution rule below.

```
C_delay[l](T_complete) =  w_sla(class, tenant)
                        · aging_multiplier(queue_age)
                        · max(0, T_complete − T_target[l])^p
                        + M_breach · 1[ T_complete > T_deadline[l] ]      ← terminal Leg only
```

#### Attribution of a Mission's delay cost to its Legs

A Mission may comprise several Legs (§2.4), but the customer experiences exactly one instance
of lateness. Charging every Leg the full contract term would penalise a three-Leg Mission three
times for one late delivery, and would inflate every exchange rate in §8.10 by the fleet's
average Leg count. The attribution rule is therefore stated here and is not left to the
implementer:

| Leg role | Term carried | `T_target` | Rationale |
|---|---|---|---|
| **Terminal Leg** — the Leg whose completion determines the Mission's completion | The **full** delay-cost term and the **whole** breach penalty `M_breach` | The Task's contractual target | Exactly one Leg carries the customer-visible consequence, so the Mission is priced once |
| **Upstream Leg** — any Leg feeding a transfer point | A **slack-consumption** term: the same functional form with `w_sla` scaled by `sla.upstream_slack_weight` and `T_target` set to the Leg's *planned* handover time | Planned handover time from the Mission's schedule | An upstream Leg cannot make the Mission late by itself; it can only consume the schedule margin that protects the terminal Leg. Pricing that consumption is what makes an upstream agent prefer to arrive on plan without over-rewarding arriving early |

`M_breach` appears **once per Mission**, on the terminal Leg only. An upstream Leg that
overruns so far that the Mission's deadline becomes unreachable does not itself incur the
breach step; instead the Mission is re-planned and the terminal Leg's projected completion
carries it, which is where the consequence actually lands.

For the common single-Leg Mission — Mission = one Leg = two Stops (§2.4) — that Leg is the
terminal Leg, it carries the full term, and the rule collapses to the simple case with no
overhead. The generality costs nothing until multi-Leg Missions exist.

**Downstream unassigned Legs.** When the terminal Leg has not yet been created or assigned,
its projected completion is taken from the Mission's planned schedule at the current
confidence, and the upstream Leg is priced against its own planned handover time as above.
This is precisely why upstream Legs are priced on slack rather than on the Mission's
completion: the Mission's completion is not yet a decidable quantity at the moment the
upstream Leg is scored, and pricing a Leg against a quantity that does not yet exist is not a
well-posed objective.

- `w_sla` in CU·s⁻¹ is the priced cost of lateness for the class and, where contracted, the
  tenant. This is where "VIP" lives: a premium contract has a higher `w_sla`, which is both
  more honest and more auditable than a priority integer, because it states *how much* the
  premium is worth in the same units as everything else.
- `p ≥ 1` (default 2) makes the penalty convex, so the engine spreads small delays across
  many missions rather than concentrating a large delay on one — usually the right customer
  outcome, and configurable per class where it is not.
- `M_breach` is a large configured step at a hard deadline, making breach avoidance dominate
  ordinary optimisation without being infinite (infinite penalties destroy solvability and
  produce pathological allocations when a breach is already unavoidable).
- `aging_multiplier` is monotonically increasing in queue age and **bounded above** by
  `cost.aging.max_multiplier` (default 8):

  ```
  aging_multiplier(age) = min( cost.aging.max_multiplier,
                               ( 1 + age / cost.aging.reference_period ) ^ cost.aging.growth_exponent )
  ```

  **The cap is a correctness requirement of batch optimisation, not a tuning preference.** An
  unbounded multiplier multiplies an already-convex lateness penalty, so in a batch solve a
  sufficiently aged Leg's cost comes to dominate the entire round's objective. The solver would
  then correctly — by the letter of its own objective — sacrifice arbitrarily large aggregate
  quality across dozens of fresh Legs to improve the aged Leg's completion by seconds, and it
  would do so *even when the achievable improvement is marginal*, because a large enough
  multiplier makes any nonzero improvement outrank any amount of degradation elsewhere. That is
  not anti-starvation; it is a single Leg holding the round's objective hostage, and it grows
  worse the longer the fleet is saturated — precisely when good aggregate allocation matters
  most.

  **Anti-starvation is guaranteed structurally by the escalation ladder (§17.4), not by this
  term.** The ladder terminates in a decision regardless of cost dynamics, which is what makes
  it a guarantee; the aging term is a soft, bounded nudge that improves ordering among
  comparable options before the ladder is needed. The unbounded form was doing work the ladder
  already does, and doing it in a way that could not be bounded.

  The cap does not weaken the guarantee, because the two mechanisms cover different cases: the
  aging term cannot help a Leg that is *infeasible* for every agent no matter how large it
  grows, and the ladder handles both that case and the case of a Leg that is feasible but only
  marginally improvable — which the unbounded term handled destructively and the ladder handles
  by widening the option set instead.

  Admissibility is unaffected: the multiplier is a property of the Leg's queue age, identical
  across all candidates for that Leg, so it scales `C_delay` uniformly and the lower bound of
  §6.4 remains admissible with or without the cap.

Note that `C_delay` is a property of the *Leg*, evaluated at the completion time a given plan
would achieve for that Leg. It is therefore plan-dependent through the timeline — which is why
`Φ` sums it over every Leg in the plan, including Legs the agent had already committed (§8.1),
so that a column inserting new work automatically pays for the delay it imposes on existing
work. It is what makes the optimiser trade "serve the urgent task with a distant agent"
against "serve two ordinary tasks well."

### 8.8 `C_defer` — the price of waiting

Deferral is an arc in the optimisation (§1.4), and its price is the expected cost of waiting
one more round:

```
C_defer[l] = C_delay[l]( T_complete_expected_if_deferred )
           + p_no_better · penalty_for_wasted_round
           + risk_of_deadline_loss · M_breach
```

`T_complete_expected_if_deferred` is estimated from the forecast supply arriving in the next
round window — principally agents projected to finish current work nearby, plus agents
completing charging. Deferral is chosen precisely when the expected improvement in
`C_direct + C_opportunity` from waiting exceeds the delay cost incurred by waiting.

This makes the engine capable of the decision the baseline cannot express at all: *the only
feasible agent is 40 km away with 21 % charge; an agent will free up 600 m away in two
minutes; wait.* Under min-max normalisation the distant agent normalises to a perfect score
of 0 and is assigned immediately.

Deferral is bounded: `assign.max_deferral_time` and `assign.max_consecutive_deferrals` force
escalation, so deferral can never become indefinite silence (§17.4).

**Every deferral MUST emit an operator-facing reason at the moment it is taken.** This is a
requirement of the mechanism, not a presentation concern. Deferral means the engine sometimes
deliberately leaves a customer waiting while a nominally suitable agent sits idle nearby, and
the first time an operator sees that on a live dashboard it will be escalated as a bug —
correctly, by their lights, because nothing on the screen distinguishes a considered decision
from a stuck queue. A feature that cannot explain itself at the moment it surprises someone does
not survive contact with live operations, however sound its arithmetic.

The reason is a structured record, rendered as a single sentence: *"waiting — an agent 600 m
away is projected free in 90 s; assigning the nearest available agent now would cost 3 200 CU
more."* It names the expected improvement in CU, the supply event being waited for, the
projected assignment time, and the deferral deadline at which the ladder takes over. It is
served from Tier A (§21.2, §21.3), because a deferral is exactly the kind of decision that gets
questioned and exactly the kind whose record must therefore never be sampled away.

### 8.9 `C_churn` — hysteresis for the rolling horizon

Re-optimising every round with fresh forecasts will revise SOFT reservations continuously as
estimates jitter, and an agent that is re-planned every 500 ms never departs. The churn term
prevents this without forbidding revision. It is charged **per column**, against whatever the
column displaces:

```
C_churn(c) = 1[ c displaces an existing reservation or commitment ]
           · ( churn.base_cost
             + churn.per_second_elapsed · time_since_reservation
             + churn.wasted_travel_cost · distance_already_travelled
             + churn.notification_cost )
```

The two displacement cases have very different real costs, and the formula prices both
correctly through `time_since_reservation` and `distance_already_travelled`:

- **Revising a SOFT reservation** costs computation and plan instability only. Nothing was
  dispatched, no agent was told anything, nothing durable is rewritten (§2.6), and
  `distance_already_travelled` is zero. Early revisions are consequently cheap, which is what
  makes late binding worth having.
- **Revising a HARD commitment** additionally requires the reassignment protocol (§4.7): a
  fence advance, a recall command, a cooloff, and possibly wasted travel. This is priced by the
  same expression evaluated at a much larger elapsed time and non-zero travel — and it is
  additionally gated by the protocol, which the optimiser cannot bypass by paying the term.

Churn cost grows with elapsed commitment time and with progress made, so early revisions are
cheap and late ones are expensive — which is exactly the desired shape. A revision happens
only when the objective improvement exceeds the churn price, giving stability with no
arbitrary freeze rule. `churn.base_cost` is also the knob that tunes the plan-stability
versus plan-quality trade-off, and it MUST be exposed as such rather than buried.

### 8.10 Parameter register for the cost function

Every parameter, its units, and its authority. Defaults are starting points for calibration,
not recommendations (§22.4).

| Parameter | Unit | Default | Class | Source of truth |
|---|---|---|---|---|
| `cost.cu_per_currency_unit` | CU·currency⁻¹ | 1.0 | Tuning | Finance |
| `cost.lambda_time[agent_class]` | CU·s⁻¹ | 1.0 (reference) | Tuning | Finance + Fleet Ops |
| `cost.lambda_time_floor` | CU·s⁻¹ | 0.2 | Tuning | Required admissible for §6.4 |
| `cost.energy.cu_per_wh` | CU·Wh⁻¹ | derived | Tuning | Energy tariff |
| `cost.wear.cu_per_metre[class]` | CU·m⁻¹ | derived | Tuning | Maintenance accounting |
| `cost.battery.cu_per_equivalent_cycle[class]` | CU | derived | Tuning | Pack cost ÷ rated cycles |
| `cost.failure.cu[mission_class, custody_state]` | CU | — | Policy | Ops + Finance |
| `cost.energy_consequence[tier]` | CU | — | Policy | Ops + Finance (one value per §14.5 tier) |
| `cost.sla.cu_per_second_late[class, tenant]` | CU·s⁻¹ | — | Contractual | Account management |
| `cost.sla.breach_penalty[class]` | CU | — | Contractual | Account management |
| `cost.sla.lateness_exponent[class]` | — | 2 | Policy | Ops |
| `cost.sla.upstream_slack_weight` | — | 0.15 | Policy | Ops (§8.7 attribution) |
| `cost.aging.reference_period` | s | 900 | Policy | Ops |
| `cost.aging.growth_exponent` | — | 1.5 | Policy | Ops |
| `cost.aging.max_multiplier` | — | 8 | Policy | Ops — **bounded by requirement** (§8.7); anti-starvation is guaranteed by the ladder (§17.4), not by this term |
| `cost.opportunity.lambda_zone_prior[zone, bucket]` | CU·s⁻¹ | — | Tuning | Capacity Pricing |
| `cost.opportunity.value_horizon` (`T_H` offset) | s | 1 800 | Tuning | Fleet Ops — **validated** > `plan.commitment_horizon` + max mission duration (§8.3) |
| `cost.opportunity.max_terminal_gain` (`Ω_terminal`) | CU | **derived per round** | Derived | Capacity Pricing — published with the price snapshot (§6.4) |
| `cost.uncertainty_penalty[predicate]` | CU | — | Policy | Safety + Ops |
| `cost.staleness.cu_per_second_age` | CU·s⁻¹ | — | Policy | Safety |
| `churn.base_cost` | CU | — | Tuning | Fleet Ops |
| `churn.per_second_elapsed` | CU·s⁻¹ | — | Tuning | Fleet Ops |
| `policy.max_zone_affinity_credit` | CU | — | Policy | Ops |
| `policy.max_dedicated_fleet_credit` | CU | — | Policy | Ops |
| `policy.max_burn_in_credit` | CU | — | Policy | Ops |
| `policy.max_pilot_adjustment` | CU | — | Policy | Ops |
| `policy.max_operator_adjustment` | CU | — | Policy | Ops leadership |
| `cost.policy.max_total_credit` (`Ω_policy`) | CU | **derived at publish** | Derived | Config Service — sum of the five ceilings above (§6.4, §8.6) |
| `candidate.optimality_tolerance_cu` (`Δ_opt`) | CU | 25 | Tuning | Engineering — **additive**, not a ratio (§6.4) |

**`V_terminal` has no weighting coefficients** and therefore no register entries. Its three
components are each already denominated in CU and are summed directly (§8.3.2). A dimensionless
weight on an already-priced quantity would be an unregistered second exchange rate, which §1.3
prohibits; removing the weights removes three otherwise-uncalibratable parameters from the
model's hardest-to-calibrate term.

---

## 9. Optimisation and Solve

### 9.1 Why batch, and what it buys

The baseline assigns each task independently at arrival. That is a greedy approximation whose
characteristic failure is *cannibalisation*: near-simultaneous tasks in one neighbourhood
compete for the same best agent, the first wins, and later tasks take substantially worse
agents even when a mutually better pairing existed. The loss grows with arrival burstiness
and with the spatial correlation of demand — both of which are high in real delivery
workloads, because demand is driven by meal times, shift patterns, and events.

Batch solving eliminates cannibalisation exactly (within the batch) and additionally yields
the dual prices used to calibrate opportunity cost (§8.3) — exactly in the singleton regime,
and as relaxation prices carrying a recorded LP–IP gap otherwise (§9.3). The cost is latency:
a batch window delays the earliest possible assignment by up to the window length.

**Decision: rolling-horizon batch with an adaptive window and a greedy fast path.** This
takes the quality of batch solving without paying the latency in the cases where latency
matters.

### 9.2 Round cadence

| Regime | Trigger | Window | Rationale |
|---|---|---|---|
| Fast path | Mission with `sla_class ∈ solve.fast_path_classes`, or queue depth 1 with idle supply | Immediate, single-mission greedy | For a genuinely urgent mission, or when there is nothing to trade against, batching buys nothing |
| Nominal | Steady arrivals | `solve.window_min` (default 500 ms) | Latency-favouring; captures near-simultaneous arrivals |
| Loaded | Queue depth > `solve.batch_growth_threshold` | Grows to `solve.window_max` (default 3 s) | Under load, batching quality and per-round amortisation both improve, and queueing delay already dominates the window |
| Saturated | Feasible supply ≈ 0 | `solve.saturated_window` (default 10 s) | Solving repeatedly against no supply is wasted work; back off and let supply accumulate |

The window MUST additionally close early when supply changes materially — an agent becoming
available is new information worth acting on — and MUST be bounded so that the window can
never consume a meaningful fraction of any mission's SLA budget. **The fast path is the batch
path invoked with a batch of one Leg** — not a parallel implementation that shares some code,
but literally the same round executed over `|L| = 1`. In that case the column set is
necessarily singleton, the solve is in the singleton regime (§9.3), and the flow degenerates to
a 1×k assignment. The two paths therefore cannot disagree about feasibility, cost, or
optimality reporting, because there is only one path — which is a stronger property than an
asserted intention to keep two implementations aligned, and it is the property that is
enforceable by a build-time test rather than by review discipline.

### 9.3 Problem formulation

#### Why the round is not a capacity-`k` min-cost flow

A min-cost flow requires **arc costs that are independent of the other flow on the network.**
That requirement fails for an agent holding more than one Leg, for three independent reasons:

- The second Leg's approach begins at the first Leg's drop point, not at the agent's current
  position — so the direct cost of the second Leg is a function of whether the first was also
  assigned to the same agent.
- Both Legs' completion times, and therefore both delay-cost terms, depend on the sequencing
  decision between them.
- The opportunity-cost term integrates over the commitment's total duration (§8.3), which is
  not the sum of two independently computed mission durations.

So `Φ(a, {l₁,l₂}) ≠ Φ(a,l₁) + Φ(a,l₂)`. A flow network with `capacity[a] = k > 1` and one arc
per pairing would therefore compute an objective value that is not the cost of the allocation
it selects, and no amount of solver quality repairs that: the model would be exactly solving
the wrong problem. **Queue capacity greater than one is not natively expressible as arc
capacity in a flow, and this specification does not claim that it is.**

The correct formulation is already implicit in §13.3: the marginal cost of inserting a Leg into
an agent's existing sequence *is* the price of a column in a set-partitioning problem. The
design commits to that formulation explicitly.

#### The formulation

Each round solves the **set-partitioning problem over columns** stated in §1.4:

```
minimise    Σ  γ(c) · z[c]     +     Σ  C_defer[l] · y[l]
            c                       l∈L

subject to        Σ        z[c]  +  y[l]  =  1      (coverage)   for every pending Leg l
              c : l ∈ L(c)

                  Σ        z[c]            ≤  1      (exclusivity) for every agent a
              c : a(c) = a
```

Because an agent accepts **at most one column**, and a column is priced at the marginal cost of
its own complete plan (§8.1), the non-separability above is confined *inside* the column, where
it is evaluated exactly by the Plan Builder rather than approximated by arc arithmetic. The
objective value of any feasible solution is exactly the true cost of the allocation.

Chaining, consolidation, and backhaul are therefore fully available at any
`capacity[agent_class]`, and queue depth stays a freely tunable configuration knob. What
changes is *where* multi-Leg structure is represented: inside a priced column, never as
parallel arcs at one agent node.

#### Two solve regimes, with different guarantees

The regime is a property of the generated column set, is determined per round, and is recorded
in the decision record. The engine never asserts a guarantee it is not in the regime for.

| Regime | Column set | Structure | Solved by | Guarantee | Duals |
|---|---|---|---|---|---|
| **Singleton** | every column covers exactly one Leg | The constraint matrix is the incidence matrix of a bipartite graph, hence **totally unimodular** | **Min-cost flow** on the bipartite-plus-defer-plus-sink network | LP relaxation is integral; the solve is **exact**, with no branching and no integrality gap | Exact marginal prices of the integer problem — valid for §8.3 calibration without qualification |
| **Column** | at least one column covers ≥ 2 Legs | Set partitioning; total unimodularity does **not** hold in general | LP relaxation, then branch-and-bound over fractional columns within `solve.branch_node_budget` | Exact **over the generated column set**, with the residual LP–IP gap reported in CU | Prices of the *relaxation*, not of the integer problem; MUST be recorded as such (§8.3.1) |

The singleton regime is the ordinary case and the one the min-cost-flow machinery exists for:
it is what the round degenerates to when bundling is disabled by kill switch (§22.5) and when
chaining produces no multi-Leg column. Selecting the flow solver in that regime is not a
fallback but a specialisation — the same problem, solved by the algorithm that exploits its
structure.

#### What "exact" does and does not mean

Two distinct approximations exist, and the specification reports them **separately** because
they bound different things and summing them would bound neither:

1. **Candidate-set truncation** (§6.4) — bounded by the admissible lower bound; reported in CU
   as the proven search gap.
2. **Column generation** — the column set is produced by a bounded heuristic (spatial and
   temporal clustering of compatible Legs, `2`–`plan.max_bundle_size` per column, insertion
   enumeration per §13.3, with a feasibility pre-check). Multi-Leg columns are drawn from the
   union of the per-Leg candidate sets, so every agent they use has already survived the
   admissible pruning of §6.4. **No pricing subproblem is solved to
   optimality, so no claim is made that the generated set contains the optimal column.** The
   selection among generated columns is exact; generation is heuristic. The decision record
   reports the number of columns generated, the number pruned, the best pruned column's bound,
   and — in the column regime — the LP–IP gap.

This is column generation with a heuristic, bounded column set: a well-understood engineering
compromise, stated as a compromise. The offline counterfactual evaluator (§21.6) re-solves
recent rounds with enlarged column sets and reports the realised generation gap, which is the
only honest way to know what the heuristic costs.

### 9.4 Solve size control

| Bound | Parameter | Default | Behaviour on exceed |
|---|---|---|---|
| Legs per round | `solve.max_legs_per_round` | 500 | Spatially partition the batch and solve sub-problems independently |
| Candidates per Leg | `candidate.max_evaluated` | 200 | Truncate by lower bound; record the search gap in CU (§6.4) |
| Columns per round | `plan.max_columns_per_round` | 2 000 | Keep the cheapest by bound; record the best pruned column's bound (§9.3) |
| Branch-and-bound nodes | `solve.branch_node_budget` | 5 000 | Return the incumbent with its LP bound; record the residual LP–IP gap in CU |
| Wall-clock budget | `solve.time_budget` | 250 ms | Return the best feasible solution found; record as budget-limited |

The branch-and-bound budget applies only in the column regime; the singleton regime is
integral and never branches (§9.3).

**Spatial partitioning of an oversized batch is near-lossless** for the same reason regional
sharding is (T9): the optimal solution rarely pairs a Leg with an agent from a distant
cluster, and when it does, the lower-bound machinery of §6.4 detects it and the partition
boundary is reported as a possible gap. Partitioning is by connected components of the
Leg–agent feasibility graph where possible, which is *exactly* lossless: two components
sharing no feasible agent **and no common column** cannot influence each other, so solving
them separately is provably optimal. The second condition is required by the column
formulation and is not implied by the first — two Legs may be linked by a multi-Leg column
even when their individual candidate agent sets are disjoint, and splitting such a pair would
discard that column silently. Columns spanning a proposed partition boundary are therefore
either kept whole by merging the components or dropped with their bound recorded, never
severed.

The solver MUST be an **anytime** algorithm: at any point it holds a feasible solution and a
bound. Exceeding the time budget returns the incumbent with its bound, never nothing and
never a hang. This is the general answer to the audit's finding that the baseline has no
timeout anywhere in its assignment path — including no timeout on outbound HTTP calls — so a
single hung connection stalls a task's assignment indefinitely while holding its lock.

### 9.5 Post-solve local improvement

After the solve, a bounded local-search pass attempts 2-exchange swaps between assigned Legs
and re-insertions into other agents' sequences. Its purpose is to recover part of the
**column-generation** gap — the loss from columns the heuristic never proposed — since the
selection among generated columns is already exact and has nothing left to improve. Each
candidate move is evaluated as a new column pair and priced by the same `Φ` (§8.1), so local
search cannot introduce a pairing the cost model did not evaluate. It is bounded by
`solve.improvement_budget`, accepts only strict improvements (so it cannot degrade the
solution), and is deterministic in its exploration order. Any improvement it finds is recorded
as a realised lower bound on the column-generation gap for that round, which makes the
heuristic's cost observable from production traffic rather than only from the offline
evaluator.

### 9.6 Determinism requirements

Mandatory, and individually testable:

1. **Integer arithmetic in the objective.** All costs are int64 milli-CU. Floating-point
   summation over a set is order-dependent at the bit level; integers are not. Conversions
   from float estimates to milli-CU use a single specified rounding mode.
2. **Canonical ordering everywhere.** Candidates, Legs, columns, and solver arcs are
   sorted by explicit total orders ending in a unique id, so no tie is ever resolved by
   iteration order. A column's identity for ordering purposes is
   `(agent_id, sorted leg_id list, insertion position vector)`, which is unique and
   independent of the order in which the Column Builder happened to generate it.
3. **Explicit tie-break policy.** Equal costs resolve by, in order: lower cumulative duty
   cycle (which makes ties do useful fairness work — §17.2), then higher health tier, then
   agent id. Never by arrival order or storage order.
4. **`decision_time` is an input.** No component reads a wall clock during evaluation. All
   time-dependent quantities are computed relative to the round's single timestamp.
5. **Snapshot isolation of inputs.** A round evaluates against an immutable snapshot of agent
   state, config, prices, forecast, model versions, and the **charger availability projection**
   (§14.5), captured at round start and referenced by version in the decision record.
   Late-arriving telemetry affects the next round, not the current one. Without this, replay is
   impossible.

   The charger availability projection is pinned for a second reason beyond replay: it is what
   breaks the `E_return` circularity (§14.5). A constraint evaluated against a *live* view of an
   availability that the current round is itself changing would be neither deterministic nor
   well-defined. Pinning the previous round's projection makes the constraint evaluable, makes
   it replayable, and makes its staleness a measurable quantity rather than a hidden one.
6. **Pinned versions.** Config version, code version, and every model artefact version are
   recorded. A replay MUST load exactly those versions.
7. **No unseeded randomness.** Where a randomised algorithm is genuinely useful (sampling
   which columns to generate), the seed is derived deterministically from the round id and
   recorded.

**Acceptance test:** replaying any stored decision record MUST reproduce the identical
allocation and identical per-candidate costs, byte-for-byte. This is a continuous test over a
sample of production decisions (§24.3), not a one-off.

---

## 10. Commitment

### 10.1 The correctness core

Commitment is the smallest and most safety-critical part of the engine: the moment a decision
becomes a binding claim on a physical machine. Everything before it is retryable and
side-effect-free; everything after it is at-least-once and idempotent. Only this step must be
exactly once.

**Requirement:** for every agent, at every instant, the set of HARD commitments MUST have
cardinality ≤ `capacity[agent]`, under every failure mode including worker crash, network
partition, cache loss, leader change, duplicate request, and clock skew.

### 10.2 Why the cache lock is insufficient alone

The baseline relies on a cache `SET NX EX` as its only real mutual-exclusion mechanism, and
the audit identifies the resulting hazards precisely: the lock TTL can expire during a long
finalisation while the holder continues to act as though it holds the lock; release performs
no ownership check, so a slow holder can delete a *successor's* lock; and the database
transaction, running at READ COMMITTED, does not serialise the conflicting pair.

The general principle is that a lock with a timeout cannot by itself provide mutual exclusion
across a process pause, because a paused holder cannot know it was preempted. The remedy is
not a longer TTL — that trades one failure for another — but a **fencing token**: a
monotonically increasing number that accompanies every side effect, so that a resource
rejects any operation carrying a stale token. The lock then becomes a performance optimisation
and the fence becomes the guarantee.

### 10.3 Lease, fencing, and the conditional commit

#### 10.3.1 Two fencing scopes, because there are two kinds of authority

**Authority in this system is not a single thing.** Some commands assert authority over the
*agent* — stand down entirely, enter quarantine, clear an e-stop, migrate to another shard.
Others assert authority over *one mission* the agent is executing — reroute it, resequence it,
recall it. An agent with `capacity[agent_class] > 1` executes several missions concurrently, so
these two kinds of authority change independently and MUST be fenced independently.

A single per-agent counter used for both is not merely imprecise; it is incorrect, and it fails
in the design's ordinary steady state rather than in a corner case. If commitment C1 is granted
epoch 5 and C2 epoch 6 on the same agent, then a reroute or a cancellation for C1 carries epoch
5, is below the highest the agent has seen, and is rejected — C1 becomes uncommandable for the
rest of its life. When C1 later settles and bumps the counter to 7, every subsequent command for
C2 carries 6 and is likewise rejected. The fleet would seize after the second concurrent
commitment on any agent, which is exactly the configuration that chaining and consolidation
require (§13.3). The specification therefore defines two fences.

| | **Agent-scope: `authority_epoch`** | **Commitment-scope: `fence`** |
|---|---|---|
| Held on | The agent row, durable, monotonic | Each Commitment row, drawn from the agent's monotonic `fence_counter` |
| Compared by the agent against | A single highest-seen value | The highest seen **for that commitment id** — never a maximum across the agent's concurrent commitments |
| Advanced by | Quarantine entry/exit, e-stop clear, operator stand-down-all, shard migration, security re-attestation, reconciler-ordered full stand-down | Commit, re-offer, reroute, recall, withdrawal, lease-expiry recovery, reassignment — **of that commitment only** |
| **Not** advanced by | Ordinary commit, ordinary settlement, anything concerning a single mission | Anything concerning a different commitment on the same agent |
| Guards | Agent-level commands | Mission-level commands |

`fence` values are drawn from one per-agent monotonic `fence_counter`, so they form a total
order over all authority changes on that agent — which preserves the monotonicity audit of
invariant I6 and lets the reconciler decide which of two observations is newer. The correction
is not to the *allocation* of the numbers but to their **comparison**: per commitment id, not
per agent.

**Command-class-to-fence-scope table.** This mapping is normative. Without it, each implementing
team chooses a scope per command and the incompatibility surfaces only in integration testing,
or in production.

| Command class | Commands | Fence scope | Agent's rejection rule |
|---|---|---|---|
| Mission command | `OFFER`, `WITHDRAW`, `REROUTE`, `RESEQUENCE`, `RECALL`, `RESUME`, `TRANSFER_CUSTODY`, `ABORT_MISSION` | **commitment** | Reject if `fence ≤ highest_seen[commitment_id]`, or if `fence ≤ fence_floor` |
| Agent command | `STAND_DOWN_ALL`, `QUARANTINE`, `RELEASE_QUARANTINE`, `ESTOP_CLEAR`, `SHARD_MIGRATE`, `SESSION_REKEY`, `PARAMETER_PUSH` | **agent** | Reject if `authority_epoch < highest_seen_authority` |
| Query | `STATUS_REQUEST`, `PROBE`, `MANIFEST_QUERY` | none — side-effect-free | Always answered; never fenced |

**Interaction rule between the scopes.** Every agent-scope command carries, in addition to
`authority_epoch`, the agent's current `fence_counter` value as `fence_floor`. On accepting an
agent-scope command the agent (a) records the new `authority_epoch`, (b) sets its local
`fence_floor` to the value carried, and (c) discards its per-commitment authority table. Any
subsequent mission command whose `fence ≤ fence_floor` is then rejected. One `STAND_DOWN_ALL`
therefore fences **every** commitment the agent holds, in one action, without needing to
enumerate them — which is the property that made a single global epoch superficially attractive,
now obtained without breaking concurrent commitments.

#### 10.3.2 The commit procedure

Commit applies to **HARD commitments only**. SOFT reservations are round-local coordinator state
and never enter this transaction (§2.6); this is what keeps the serialised section proportional
to the mission rate rather than to the re-planning rate (§3.5).

**Commit procedure** (single transaction in the Commitment Store, per shard):

1. Read the agent row `FOR UPDATE` — an explicit row lock, not an optimistic read. Read the
   Leg row `FOR UPDATE`.
2. Verify the guard set. Every guard aborts the transaction on failure:

   | # | Guard | Protects against |
   |---|---|---|
   | G1 | `shard.leadership_fence` equals the value read at round start | A coordinator whose lease expired mid-round committing on stale leadership (§19.5) |
   | G2 | Agent's active HARD commitment count `< capacity[agent_class]` | Over-commitment |
   | G3 | Agent's `authority_epoch` equals the decision snapshot's value | The agent having been quarantined, e-stopped, migrated, or stood down since the snapshot |
   | G4 | Leg `version` equals the snapshot's | A concurrent modification of the Leg |
   | G5 | `cancel_requested_at IS NULL` **OR** `leg.purpose ∈ custodial_purposes` | Committing cancelled work, while still permitting the recovery Legs that cancellation itself mandates (§4.6) |
   | G6 | Leg state is the expected one | Committing from an unexpected state |

   G1 is what makes leadership a **database-enforced** property rather than a coordinator's
   unverified belief about its own lease. The commit transaction takes row locks that can block
   for an unbounded duration under contention with the reconciliation loop, so a transaction
   that *begins* inside a valid leadership window can *commit* after that window has expired.
   Reading the leadership record inside the same transaction and aborting if the fence has
   advanced closes that window completely, at the cost of one indexed read. Without it, two
   coordinators can run concurrent rounds against disjoint snapshots of the same shard and
   produce commitments whose joint composition no solve ever evaluated — which breaks replay
   determinism (T6) even though the per-agent exclusivity invariant survives.

   G3 uses the **agent-scope** epoch, not a per-commitment value, and this is deliberate: it is
   invariant across ordinary commits, so a coordinator may commit several Legs to one agent
   within one round without each commit invalidating the next one's snapshot. A guard on a
   per-commitment counter here would reproduce, inside the store, the same defect the fencing
   split removes at the agent.

3. Re-verify the **volatile subset** of feasibility. This is essential: the audit documents that
   the baseline validates battery and health *before* the reservation and never re-checks them
   at finalisation, so an agent that drains below threshold or faults during the routing window
   is still bound. The re-check is cheap because it uses cached predicate results whose
   invalidation timestamps are compared against the snapshot. The volatile subset is an
   **enumerated, machine-checkable list**, not a prose description: F7, F8, F10, F13, F14, F16,
   F17, F18, F20, F34, F35. A predicate is either on this list or it is not, and adding a
   predicate to the constraint register requires classifying it.
4. Allocate `fence = agent.fence_counter + 1`; update `agent.fence_counter` to that value;
   insert the Commitment carrying that fence; update the Leg state and version. **The agent's
   `authority_epoch` is not touched.**
5. Insert the outbox row for dispatch **in the same transaction** (§11.1), carrying the fence
   allocated in step 4.
6. Insert the decision-record reference.
7. Commit.

Any guard failure aborts the transaction and returns the pairing to the next round with the
cause recorded. No partial state is possible.

**Isolation level:** the transaction MUST run at `SERIALIZABLE`, or at `REPEATABLE READ` with
explicit `FOR UPDATE` row locks on both the agent and the Leg. Relying on READ COMMITTED with
a plain read-then-write is prohibited — the audit demonstrates the exact interleaving in which
two transactions both observe a free agent and the second silently overwrites the first's
binding, which no uniqueness constraint on the task side prevents.

**Database-enforced invariants:** two schema constraints MUST exist as backstops, so that even a
defective code path cannot violate them silently:

- A partial unique index (or equivalent) enforcing at most `capacity[agent_class]` active
  commitments per agent.
- A constraint admitting only HARD commitments into the table, so that a SOFT reservation
  cannot be persisted by any code path (invariant I18). This is the structural guarantee behind
  the durability rule of §2.6: the rule is not merely a convention that a future call site could
  quietly break, and it is what keeps the shard-sizing derivation of §3.5 valid over time.

Application logic and schema constraints are independent lines of defence, and the schema one is
the one that cannot be bypassed by a new call site.

#### 10.3.3 What the fencing rule buys

- A worker that paused mid-finalisation and resumes cannot affect the agent: its snapshot's
  `authority_epoch` or leadership fence is stale, the commit aborts, and any command it
  nonetheless emits carries a fence at or below one the agent has already seen for that
  commitment.
- A reassignment is safe even when the incumbent is unreachable, because advancing that
  commitment's fence invalidates the incumbent's authority over **that mission** immediately
  rather than after a timeout — while leaving the agent's other missions supervised and
  commandable.
- A quarantine, e-stop, or migration is safe and total, because advancing the agent's
  `authority_epoch` invalidates every mission authority at once.
- Duplicate delivery of the same command is harmless: same fence, same commitment id, same
  sequence, and the agent deduplicates on that triple (§10.5).

This closes, structurally, the baseline's lock-expiry, cross-release, and READ COMMITTED
hazards as a single class rather than as three separate patches — and does so without the
per-agent-epoch formulation's own failure at `capacity > 1`.

### 10.4 The advisory cache lock

A short-lived cache lock per agent is retained, with a changed purpose: it prevents *wasted
work*, not incorrect outcomes. Two coordinators evaluating the same agent will have one back
off early rather than both reach the transaction and have one abort. It is therefore permitted
to be lossy, and its loss degrades throughput only. Because it is advisory, cache
unavailability MUST NOT halt commitment — a significant improvement over the baseline, where
cache unavailability halts all assignment and terminally fails every task created during the
outage.

### 10.5 Idempotency

- Intake requests carry a client idempotency key; replays return the original result rather
  than creating a second Task.
- Commit is idempotent on `commitment_id`, which is derived deterministically from
  `(leg_id, agent_id, decision_round_id)`. A retried commit either observes its own prior
  commitment and succeeds, or fails its guards — never double-commits.
- Every outbound **mission** command is idempotent on `(commitment_id, command_sequence,
  fence)`. Every outbound **agent** command is idempotent on `(agent_id, command_sequence,
  authority_epoch)`. The two namespaces are disjoint, matching the two fence scopes of §10.3.1.

### 10.6 Clock discipline

Leases and offer TTLs depend on time, so clock behaviour is specified rather than assumed:

- All deadlines are stored as absolute timestamps from the Commitment Store's clock, which is
  the single authority for lease validity.
- Comparisons for safety decisions use a monotonic source plus the store's timestamp; wall
  clocks on workers are never trusted for lease validity.
- Maximum tolerated skew is `time.max_clock_skew` (default 500 ms), monitored; leases embed
  that margin. A node exceeding the skew bound removes itself from leadership eligibility.
- Correctness does not depend on synchronised clocks — that is the point of the two fences
  (§10.3.1) and of the transactional leadership guard G1. Clocks affect *liveness* (how quickly
  a lost lease is detected), not *safety*.

---

## 11. Dispatch and Acknowledgement

### 11.1 Transactional outbox

The audit identifies the baseline's most consequential dispatch defect: the task is committed
to the database *before* dispatch is attempted, the dispatch result is discarded, the
exception is swallowed, and there is no acknowledgement — so a correct decision can produce
no physical effect with no signal, recoverable only by a server restart.

The remedy is the transactional outbox:

1. The commit transaction writes the Commitment and an **outbox row** atomically (§10.3
   step 5). Either both exist or neither does. There is no window in which a commitment
   exists without a pending dispatch obligation.
2. Dispatcher workers claim outbox rows, deliver, and mark them delivered. Delivery is
   at-least-once; the agent deduplicates on `(commitment_id, sequence, fence)` for mission
   commands and on `(agent_id, sequence, authority_epoch)` for agent commands (§10.5), against
   the **durable** deduplication state specified in §11.5.
3. An undelivered outbox row past `dispatch.delivery_deadline` escalates (§11.4). Outbox
   depth and oldest-undelivered-age are primary SLIs — a rising value is direct evidence that
   commitments are not reaching agents.

### 11.2 Offer semantics: the agent may refuse

Dispatch is an **offer**, and the agent MUST respond. This is the second structural gap: the
baseline has no `TASK_REJECT` event, so an agent cannot decline, and the one deferral it can
perform — holding an assignment while charging — is invisible to the server, leaving the task
`ASSIGNED` for up to half an hour with no signal, timeout, or alert.

Offer content: commitment id, commitment fence, mission plan, stop sequence with time windows,
route reference, payload manifest, requirement acknowledgements, energy reserve parameters and
target SoC (§14.6), offer expiry, and a signature (§23.3).

| Agent response | Meaning | Engine action |
|---|---|---|
| `ACCEPT` | Plan received, validated locally, and accepted | Commitment becomes HARD; Leg → `ACCEPTED`; lease renewed |
| `REJECT(reason)` | Locally infeasible or refused | Commitment released; Leg → `QUEUED`; agent excluded for `dispatch.nack_cooloff`; reason recorded as a **feasibility observation** and reconciled against the server's view |
| `DEFER(until, reason)` | Cannot start now but can later | The HARD commitment is released and the Leg returns to `PLANNED` as a SOFT reservation carrying a start-not-before constraint, then is re-optimised next round against alternatives — so the deferral becomes a priced trade rather than an invisible wait. Releasing rather than holding is what keeps the agent's capacity accounted correctly while it is not actually working (§2.6) |
| (no response) | Offer TTL expires | Withdraw at an advanced commitment fence, release the commitment, exclude agent, re-plan; reliability signal recorded |

**A `REJECT` is an important safety signal, not merely a scheduling event.** The agent is the
authority on its own physical condition, and it may know something the server does not.
Every rejection is reconciled: if an agent rejects for low energy while the server believed
it feasible, that is a discrepancy between the server's energy model and the agent's — a
calibration defect worth alerting on. Repeated rejections trigger health investigation and
automatic quarantine (§16.4). Refusals MUST be cheap for a healthy agent and consequential in
aggregate.

### 11.3 Delivery mechanism

- **Cluster-safe by construction.** Delivery MUST route by agent identity through a
  session-registry abstraction that works across workers. Any mechanism relying on a
  process-local socket table is prohibited; the audit notes the baseline already learned this
  and moved dispatch to room-based emits, while one eligibility rule still consults a
  process-local map and is consequently skipped whenever the agent is connected to a
  different worker.
- **Ordered per agent.** Commands carry a per-commitment sequence; the agent applies them in
  order and ignores out-of-order duplicates. Reordering a `RECALL` before an `OFFER` would be
  a serious defect, so ordering is a protocol requirement rather than a transport hope.
- **Bounded retry with escalation, not silent retry.** Retries use bounded exponential backoff
  with jitter; exhaustion escalates rather than being discarded.

### 11.4 Escalation ladder for undelivered or unacknowledged offers

| Step | Condition | Action |
|---|---|---|
| 1 | No delivery confirmation within `dispatch.retry_window` | Retry with backoff on an alternate channel where available |
| 2 | No ACK within `dispatch.offer_ttl` | Withdraw offer at an advanced commitment fence, release the commitment, mark agent `dispatch_unresponsive`, re-plan the Leg excluding it |
| 3 | Agent `dispatch_unresponsive` on `health.unresponsive_strikes` consecutive offers | Remove from the availability index; open a health investigation |
| 4 | Fraction of unresponsive agents in the shard exceeds `dispatch.systemic_threshold` | Systemic fault: alert, stop new hardening, enter degraded mode (§18.3) |

Step 4 matters because the difference between one broken agent and a broken message bus is a
count, and a system that only knows how to handle the former will respond to the latter by
quietly grounding the fleet one agent at a time.

### 11.5 Durable agent-side deduplication

At-least-once delivery combined with **non-durable** deduplication state is not exactly-once
in practice, whatever the protocol intends. A robot that power-cycles — which happens
routinely, including as a deliberate fault-recovery action (§18.2 A5) and on every scheduled
firmware update — would lose an in-memory dedup table and then re-execute a redelivered offer
or command it had already processed before the restart. The window is not small: an offer may
be redelivered for up to `dispatch.offer_ttl`, and a queued command for as long as the
transport's maximum delivery delay.

**Requirement: agent-side deduplication state MUST be durable across restart.**

| Element | Requirement |
|---|---|
| Contents | `authority_epoch`; `fence_floor`; per active commitment id, the highest applied `sequence` and highest seen `fence`; the retired-commitment tombstone set |
| Durability | Committed to non-volatile storage **before** the command's effect becomes externally observable — before motion, before a compartment actuates, before an ACK is sent. Acting first and recording after reopens the exact window the state exists to close |
| Retention | `agent.dedup_retention` ≥ `dispatch.offer_ttl` + `dispatch.max_delivery_delay`, default 30 min. Tombstones for settled commitments are retained for this window and then pruned, which bounds the state's size independently of fleet lifetime |
| Generation counter | `dedup_state_generation`, a monotonic counter persisted alongside the state and **incremented whenever the state is created, cleared, or found corrupt**. This is what makes a state loss detectable rather than silent |

**Session-establishment handshake.** On every session establishment (§23.2) the agent reports
its **deduplication high-water mark**: `dedup_state_generation`, `authority_epoch`,
`fence_floor`, and the per-commitment high-water pairs for every commitment it believes it
holds. The server compares this against the Commitment Store and takes one of three paths:

| Server observation | Interpretation | Action |
|---|---|---|
| Generation unchanged, high-water marks consistent with the store | Normal reconnect | Resume; redeliver only commands the agent has not applied |
| Generation unchanged, agent's marks *behind* the store | Commands were lost in flight, not applied | Redeliver from the agent's high-water mark — safe, because the agent's dedup state is intact and will reject anything it has already applied |
| **Generation advanced, or state absent** | **The agent's dedup state was reset.** Its assertion that it has not applied a command can no longer be trusted, in either direction | **Suppress redelivery entirely.** Advance the agent's `authority_epoch`, which invalidates every commitment-scope authority it holds (§10.3.1); reconcile its physical and custody state (§12.4); then re-offer fresh work under new commitment ids and new fences |

The third path is the one that matters, and it reuses machinery that already exists rather
than adding a mechanism. A dedup reset is exactly the condition the agent-scope fence was
designed for: the question "which of my prior authorities does this agent still correctly
honour?" has become unanswerable, and the correct response is to invalidate all of them at once
and start from a known state. Redelivering into an agent whose dedup table is empty is the one
action guaranteed to cause the double execution the protocol forbids.

**Custody is reconciled before any re-offer.** A reset agent may be carrying goods it can no
longer account for against a commitment id the server has retired. The custody audit of §12.4
runs first, and an agent with an unreconciled non-empty manifest is not returned to the
available pool (invariant I7) regardless of how healthy it reports itself to be.

**Monitoring.** `dedup_state_generation` advances are counted per agent and per agent class and
are a first-class SLI. A single advance is an expected consequence of a firmware update; a
rising rate across a class indicates non-volatile storage that is not actually durable — a
defect that is invisible in every other signal, because a fleet with broken dedup persistence
behaves perfectly until the first redelivery.

---

## 12. Supervision and Reconciliation

### 12.1 Why a reconciler is mandatory

The audit's failure summary contains six distinct entries whose outcome is "stuck
`ASSIGNED`", "stuck `PENDING`", or "silent". They have different triggers but one shared root
cause: **no component is responsible for noticing that a state has stopped progressing.**
Patching each trigger individually leaves the seventh undiscovered.

This design instead adopts a control-loop model: a **Reconciler** continuously compares
desired state against observed state and repairs the difference, in the manner of a
Kubernetes controller. It is a convergence mechanism, not an error handler, and it is
correct-by-construction for triggers nobody anticipated.

### 12.2 Lease renewal and expiry

- Each HARD commitment holds a lease with expiry `now + lease.duration` (default 60 s),
  renewed by the Supervisor while progress evidence continues to arrive.
- Renewal requires *positive evidence*: a heartbeat that includes the commitment id and its
  fence. A generic connectivity ping is insufficient — it proves the link, not the mission.
  Leases are **per commitment**, so an agent holding several commitments renews each one on its
  own evidence; a heartbeat naming one mission does not renew the lease of another.
- Lease expiry does not itself abort the mission. It transitions the Leg to a recovery
  assessment whose outcome depends on custody (§4.7): `REASSIGNING` when custody is `NONE`,
  `STRANDED_SAFE` or `STRANDED_OBSTRUCTING` — by obstruction class (§4.3) — when custody is
  `HELD` and the agent is unreachable.
- Expiry always advances **that commitment's** fence, fencing the previous holder of that
  mission immediately, and leaves the agent's other commitments and their leases untouched.
  Only a recovery that requires the agent to abandon all work advances the agent's
  `authority_epoch` (§10.3.1).

**Leases are never renewed against a cached value.** Renewal is a durable write to the
Commitment Store, which is the sole authority for lease validity (§3.3). When that store is
unavailable, renewal does not fall back to a cached lease — it **stops**, the shard enters
Custodial Operation, and invariant I2 is explicitly suspended for the duration (§18.5, §26.2).
Continuing to supervise on a cached lease would mean treating the cache tier as the authority
for a correctness-relevant fact, which the architecture prohibits, and it would provide no real
protection in any case: a cached lease cannot be *revoked*, so it certifies only that the
commitment was valid at some point in the past.

**On-agent self-supervision is what covers that window.** The agent halts at the safest
reachable location once `agent.autonomous_continuation_limit` has elapsed since its last
successful renewal. That bound is enforced on the agent, so it survives every server-side
failure mode, and it is the reason a suspended I2 is safe rather than merely tolerated.

### 12.3 Progress supervision

Lease renewal proves liveness; it does not prove *progress*. An agent can heartbeat happily
while stationary behind an obstacle. Progress supervision compares observed advancement
against the committed plan:

| Signal | Detection | Response |
|---|---|---|
| Position not advancing along the planned route beyond `supervise.stall_time` | Track versus plan | Query the agent, request a status detail, then reroute or escalate |
| Realised ETA drift beyond `execute.eta_tolerance` | Continuous re-projection | Re-project timeline; set Task `AT_RISK`; notify customer; consider reassignment if pre-custody |
| Energy consumption exceeding prediction by more than `energy.deviation_tolerance` | Realised versus predicted Wh | Re-run feasibility with the observed efficiency; divert to charge or abort while it is still possible to reach a charger |
| Repeated local replans or intervention requests | Count per km against baseline | Health signal; may quarantine after this mission |
| Off-route excursion beyond corridor | Geometric | Immediate investigation; possible safety event |

The energy row deserves emphasis: because the check compares *realised* against *predicted*
consumption, an agent whose efficiency has degraded — worn bearings, cold pack, unexpected
gradient — is detected mid-mission while diversion is still possible. The baseline has no
such loop; the audit notes its simulated agent continues driving at the 5 % floor
indefinitely, and no server-side logic consumes the resulting status change at all.

### 12.4 The reconciliation loop

Runs continuously per shard, event-driven with a periodic full sweep, and is idempotent.

| Divergence | Detection | Repair | Escalate when |
|---|---|---|---|
| Commitment exists, agent unaware of it | Agent's reported commitment set versus store | Re-dispatch at an advanced fence for **that commitment only** | Repeated failure |
| Agent reports a commitment the store does not have | Agent report versus store | Issue `ABORT_MISSION` for that commitment id at a fence above any the agent could hold; if the agent's reported set is wholly unrecognisable, escalate to `STAND_DOWN_ALL` at an advanced `authority_epoch` | Custody `HELD` |
| Leg non-terminal with no commitment and no queue entry | Orphan scan | Requeue with aging credit. **This is also the normal path for SOFT reservations lost in a coordinator failover** (§2.6, §19.5), which is why the scan must distinguish the two by Leg state and count them separately — a `PLANNED` orphan after failover is expected; a `QUEUED` or `ACCEPTED` orphan is a defect | Custody `HELD` → operator |
| Agent marked committed but Leg is terminal | Cross-check | Release that commitment, retire its fence, return capacity | — |
| Lease expired, not yet processed | Timer lag scan | Run the §4.7 recovery path | — |
| Custody `HELD` with no active mission | Custody audit | Immediate operator escalation — goods are unaccounted for | Always |
| Task `WAITING` beyond SLA with no queue entry | Queue audit | Requeue; investigate the loss | Always |
| Outbox row undelivered past deadline | Outbox scan | §11.4 ladder | Step 3+ |
| Agent absent from the availability index but healthy and idle | Index audit | Reinsert into index | Repeated |
| Energy accounting inconsistent with telemetry | Accounting audit | Recompute; flag model calibration | Large divergence |

**The reconciler issues no command directly.** Every repair in the table above that commands an
agent does so by writing an outbox row inside the same transaction as the state transition and
fence advance that authorise it (§4.1 rule 5). The reconciler and the timer supervisor can act
on the same entity concurrently, and conditional writes decide which of them wins the
transition; binding the command to that transition is what stops the loser from having already
sent a command. Without this, a real incident reliably produces at least one duplicate
stand-down and one spurious reassignment.

**Every repair is counted and alerted on** (T10). The reconciler's repair rate is a defect
signal: a healthy system's reconciler is nearly idle, so a rising rate means a bug elsewhere,
and burying it in a safety net converts a visible outage into invisible chronic loss. The
release gate MUST include a maximum acceptable repair rate per category.

### 12.5 Completion verification

The audit notes the baseline accepts completion purely on the agent's assertion, with no
geometric or evidentiary check. Trust in a report should be proportional to the consequence of
its being wrong, so verification is graded per mission class.

| Level | Requirements | Applied to |
|---|---|---|
| L0 — asserted | Agent reports completion | Internal, low-value, reposition and maintenance missions |
| L1 — geometric | Position within `verify.arrival_radius` of the stop **and** a plausible telemetry track showing actual travel there, plausibility being the three stated tests below rather than a judgement | Default for all customer work |
| L2 — evidenced | L1 plus a physical event: compartment open/close, mass change, barcode scan, latch state | Goods of material value |
| L3 — attested | L2 plus an external attestation: recipient confirmation, PIN, signature, photograph, or third-party scan | High-value, regulated, contested, or age-restricted |

Insufficient evidence sends the Task to `VERIFYING` with an operator queue — not to
`COMPLETED`, and not to `FAILED`. Both of those are lies about the physical state.

The plausibility check on the track is what defends against a defective or compromised agent
reporting completion it did not perform: a completion claim from a position the agent could
not physically have reached, given its last known position and its kinematic limits, is
rejected and raises a security event (§23.5).

**Track plausibility is three stated tests, with thresholds in the register.** "A plausible
track" without a stated threshold would be tuned reactively by whoever first fields a
false-positive complaint, rather than deliberately and in advance — and a verification threshold
set under complaint pressure only ever moves in one direction. A track is plausible when all
three hold:

1. **Coverage** — the track contains at least `verify.track_min_fix_rate` accepted position
   fixes per minute of the leg's realised duration, so a claim backed by two fixes an hour apart
   is not evidence of travel.
2. **Corridor** — at least `verify.track_min_corridor_fraction` (default 0.85) of accepted fixes
   lie within the planned route corridor, or within a re-planned corridor the agent reported at
   the time. A deviation is not itself a failure; an *unreported* deviation is.
3. **Continuity** — no unexplained gap longer than `verify.track_max_gap`, except where the gap
   is fully covered by a mapped dead zone (§18.2 A3), and every implied inter-fix speed within
   the agent's kinematic limits (§23.5).

Failing any test sends the Task to `VERIFYING` rather than rejecting the completion outright,
because the common cause is a telemetry gap rather than a false claim. Repetition on one agent
is a security signal and is treated as such.

---

## 13. Mission Planning

### 13.1 What the planner produces

For a candidate pairing, the Plan Builder produces a complete, executable, and *evaluated*
plan, and this artefact is the input to both feasibility and cost:

- The ordered stop sequence including any inserted charging or repositioning stops.
- Per-stop projected arrival, service start, service end, and departure times, each with an
  uncertainty band.
- Per-leg route references, distances, and travel-time distributions.
- Per-stop payload state: mass, volume, compartment allocation, centre of gravity, custody.
- Per-stop projected energy state with its uncertainty band.
- The terminal state: position, SoC, time — the input to `V_terminal` (§8.3).
- Feasibility results for every stop, since a plan can be infeasible at stop 3 while being
  fine at stops 1 and 2.

**A candidate is feasible if and only if a valid plan exists.** This makes feasibility and
cost consistent by construction: they are both computed from the same artefact, so the engine
cannot commit a plan that its own cost model never evaluated. The baseline computes total
mission distance only *after* the robot is chosen and bound, which is precisely the
inconsistency this structure forbids.

### 13.2 Time-window and service-time modelling

Every stop has an access window (business hours, dock booking, recipient availability,
curfew) and a service-time distribution. Service time is *learned* per
`(site, stop_type, mission_class, hour_of_week)` with hierarchical shrinkage to broader
cohorts when data is sparse, because a busy office lobby with a lift, a kerbside handover,
and a warehouse dock have service times that differ by an order of magnitude, and a single
global constant guarantees systematic ETA error at every one of them.

Waiting is modelled explicitly: arriving before an access window opens produces wait time,
which is priced at `λ_time` like any other committed time. An agent that would arrive 20
minutes early is therefore correctly penalised rather than rewarded for being fast.

### 13.3 Insertion, chaining, and consolidation

For an agent with existing commitments, the relevant quantity is the **marginal cost of
insertion**, not the standalone mission cost. This is not an auxiliary heuristic bolted onto
the objective — **it is the price of a column** (§1.4, §9.3), and it is computed by evaluating
the one cost functional of §8.1 at two plans:

```
γ(c) = Φ( plan₀(a) ⊕ L(c) ) − Φ( plan₀(a) ) + C_churn(c)
```

where `⊕` denotes the cheapest feasible insertion of the stops of `L(c)` into `a`'s existing
sequence, subject to precedence (pickup before its drop), time windows, payload capacity at
every point, and custody compatibility. Insertion positions are enumerated exhaustively for
short sequences (`plan.max_exhaustive_stops`, default 8) and by bounded heuristic beyond.

Because `Φ` sums `C_delay` over **every** Leg in the plan (§8.1), this difference automatically
charges the column for the delay it imposes on the agent's already-committed Legs, the extra
energy and wear, and the altered terminal state. There is no separate insertion-cost model that
could drift out of agreement with the cost model.

**This is where queue depth is enforced.** A column is admissible only if `plan₀(a) ⊕ L(c)`
holds no more than `capacity[agent_class]` concurrent commitments (F17) and extends no further
than `plan.commitment_horizon` into the future. Queue depth is therefore a **feasibility
property of a plan**, not an arc capacity in the solver — which is precisely what makes
`capacity > 1` expressible without breaking the separability the solve depends on (§9.3).

This yields three capabilities the baseline structurally cannot have, since its model is
strictly one task per robot with no queue:

- **Chaining** — a second mission appended to an agent already en route, eliminating a return
  to idle and the subsequent fresh approach.
- **Consolidation** — several tasks sharing stops or corridors served in one Leg, which is
  the dominant efficiency lever in dense delivery.
- **Opportunistic backhaul** — a pickup near the current drop, which is nearly free and which
  a one-task-at-a-time model can never see.

Queue depth is capped by `capacity[agent_class]` and further limited by a per-agent
**commitment-horizon** cap: committing an agent 40 minutes ahead destroys the engine's future
flexibility and multiplies the cost of any disruption. The horizon cap is the parameter that
trades efficiency against resilience, and it MUST be exposed and tuned explicitly rather than
implied by queue length.

### 13.4 Charging as a planned stop

When a plan's projected energy violates a reserve, the planner attempts to insert a charging
stop rather than declaring infeasibility. The inserted stop carries the charger's reservation
requirement, its projected queue wait taken from the pinned charger availability projection
(§14.5), the **target SoC published by the Charging Scheduler** (§14.6 — the engine does not
choose it), and a charge duration computed from the nonlinear charge curve to reach that target.
The resulting plan is then priced normally, so "this agent can do it but needs a 12-minute
top-up first" competes honestly against "that agent can do it immediately." Only if no charging
insertion produces a feasible plan does F34 reject the pairing.

Inserting a charging stop is a *plan*, not a *booking*: it does not reserve the charger. If the
plan is committed and a reservation is genuinely required, it is requested from the Charging
Scheduler, which may refuse — in which case the Leg is re-planned in the next round. The engine
never creates the reservation itself (§14.7).

### 13.5 Return-to-base

There is no return-to-base *rule*. Return is an emergent outcome of `V_terminal` (§8.3), which
prices the value of the state the agent is left in, plus explicit triggers:

| Trigger | Mechanism |
|---|---|
| Low energy | The mandatory charging leg becomes part of `t_terminal`, and `V_terminal` penalises a low terminal SoC |
| End of shift or duty-cycle limit | A hard constraint on the plan's end time relative to the shift boundary |
| Maintenance due | F36 plus a scheduled maintenance mission |
| Idle in a low-demand zone | `V_avail` is higher in the higher-demand zone, so the relocation component of `C_opportunity` is negative and relocation becomes attractive; realised as a reposition mission (§17.3) |
| Operator recall | Direct command |

This is materially better than a fixed rule, because a blanket return-to-base wastes energy
and time whenever the agent is already well-placed, while never returning — the baseline's
behaviour, where agents go idle at drop coordinates — causes the fleet to drift toward drop
clusters and progressively starve the origin zones. Pricing the terminal state handles both
ends of that trade-off with one mechanism.

---

## 14. Battery and Energy Strategy

### 14.1 Why percentage-based floors are inadequate

The baseline uses an instantaneous percentage floor: 20 % generally, 30 % to interrupt
charging. As the audit states plainly, a robot at 20.1 % is eligible for a mission of
unbounded length. Four independent defects are present, and no choice of threshold fixes them:

1. **A percentage is not an energy budget.** Feasibility depends on the mission's required
   watt-hours versus the pack's *remaining usable* watt-hours. The former is not represented
   at all; the latter is not what a percentage measures.
2. **A percentage of a degraded pack is a smaller quantity.** At 70 % state of health, 30 %
   SoC is 21 % of the nominal energy the threshold was calibrated against. The threshold
   silently tightens — or fails to — as the fleet ages, and does so differently for every
   agent.
3. **Temperature changes both capacity and consumption.** A cold pack delivers less energy
   and the vehicle consumes more; the same percentage means materially less range.
4. **Deterministic margins ignore variance.** Consumption is a distribution. A margin that
   ignores variance is either wasteful most of the time or unsafe in the tail, and cannot be
   both.

**Decision: energy is modelled in watt-hours, feasibility is a probabilistic constraint, and
reserves are layered and explicit.**

### 14.2 Consumption model

Per agent class, with per-agent calibration:

```
E_leg = κ(a) · [ β_dist · d
               + β_mass · m_payload · d
               + β_climb · Σ max(0, Δh)  · (m_vehicle + m_payload)
               − β_regen · Σ max(0, −Δh) · (m_vehicle + m_payload) · η_regen
               + β_move_time · t_moving
               + β_stop_start · n_stop_start_cycles
               + β_dwell · t_dwell
               + β_aux · t_total
               + β_thermal(T_ambient, T_pack) · t_total
               + Σ  β_payload_thermal( thermal_class(k), T_ambient ) · t_occupied(k) ]
                 k ∈ compartments
```

| Coefficient | Meaning | Why it is separate |
|---|---|---|
| `β_dist` | Rolling and drivetrain losses per metre | The dominant term on flat ground |
| `β_mass` | Extra energy per kg per metre | Payload changes range; a capacity gate that ignores this underestimates a fully loaded mission |
| `β_climb`, `β_regen` | Potential-energy gain and partial recovery | On hilly terrain this dominates; a distance-only model can be wrong by a factor of two |
| `β_move_time` | Aerodynamic and speed-dependent losses | Separates fast and slow traversals of the same distance |
| `β_stop_start` | Acceleration cycles | Urban stop-go consumption is not a function of distance |
| `β_dwell`, `β_aux` | Idle draw, computers, sensors, lighting | Long dwells at a lobby are not free |
| `β_thermal` | Vehicle HVAC, pack heating/cooling, cold-weather penalty | Seasonal swings of 20–40 % are typical and must not be absorbed by a fudge factor |
| `β_payload_thermal` | **Active compartment conditioning** for a temperature-controlled payload, per compartment thermal class, as a function of ambient | A distinct, payload-dependent draw that `β_thermal` does not cover: `β_thermal` is a property of the vehicle, this is a property of what it is carrying. It is charged over `t_occupied(k)` — the interval the compartment actually holds conditioned goods — because a cold-chain compartment loaded at stop 1 and emptied at stop 2 draws power over that interval and not over the whole mission |
| `κ(a)` | Per-agent efficiency multiplier | EWMA of realised versus predicted; captures individual wear, tyre pressure, sensor load, and drivetrain condition |

**Why the payload-thermal term is separated rather than folded into `β_thermal`.** Cold-chain
and hot-box missions are disproportionately long-duration, so an omitted conditioning load is
correlated precisely with the missions where energy feasibility binds hardest — the error is
not random, it is concentrated where it does the most damage. Folding it into the vehicle's
thermal coefficient would additionally make the coefficient payload-dependent, which destroys
its calibratability: the same agent would need different `β_thermal` values on consecutive
missions. F25 already gates *whether* a compartment can hold the payload's temperature range
(§7.5); this term prices what doing so *costs*, which is a different question and was
previously unasked.

`κ(a)` is the mechanism that makes the model *self-correcting*: an agent that consistently
consumes 12 % more than predicted has `κ = 1.12` within a few missions and is planned
accordingly. A drifting `κ` is also an early maintenance indicator and is fed to §16.

### 14.3 Usable energy

```
E_usable(a) = C_nominal(class) · SoH(a) · f_temp(T_pack) · SoC(a) · f_derate(class)
```

- `SoH(a)` — state of health, maintained by the Energy Model Service from charge-throughput
  history, capacity tests, and internal-resistance trend. Explicit rather than implicit, so
  an ageing pack tightens the agent's range automatically.
- `f_temp` — capacity derating from a per-chemistry curve.
- `f_derate` — a configured conservatism factor on the vendor curve.

Rising internal resistance is separately tracked: it reduces deliverable power and is a
leading indicator of pack failure, so it feeds both `SoH` and the health tier.

**Layered conservatism MUST be declared, not accumulated.** Several independently-chosen
derating factors sit on top of vendor-supplied physical curves. In the energy domain alone:
`f_derate` here, `energy.charger_availability_margin` on the projection (§14.5),
`energy.uncalibrated_reserve_factor` when per-agent calibration is missing, and
`route.degraded_reserve_factor` under degraded routing. Each is individually defensible, and
their product is nobody's stated intention: layered fudge factors compound invisibly, and a
fleet whose effective energy margin is 1.8× because four people each chose 1.15–1.25 will be
quietly uneconomic without anyone having decided that. Therefore:

- Every conservatism factor declares, in its register entry, **what uncertainty it compensates
  for** — vendor-curve optimism, missing per-agent calibration, projection staleness, degraded
  travel-time estimates. Two factors compensating for the *same* uncertainty is a defect, not
  extra safety, and the declaration is what makes the duplication visible.
- The Config Service computes and publishes the **combined nominal energy conservatism** — the
  product of the energy-domain factors active in nominal operation — and the **combined degraded
  energy conservatism**, which additionally includes the degradation multipliers that a mode can
  activate. Both appear in the resolution-explain query (§22.2). The product is taken over the
  energy domain specifically, because these factors all multiply the same quantity, a reserve in
  Wh; factors acting on other quantities are declared individually but are not multiplied into it.
- A published combination exceeding `energy.max_combined_conservatism` is **rejected at publish
  time** (§22.1 rule 5) and requires an explicit Safety-class decision to raise, which is where a
  deliberate choice to be very conservative belongs — stated once, rather than assembled by
  accident from four reasonable-looking numbers.
- The same declaration discipline applies outside the energy domain — `payload.safety_factor` on
  rated mass (F22), `execute.eta_tolerance` on timelines — each stating its compensated
  uncertainty. They are not combined into one figure, because a product across incommensurable
  quantities is not a meaningful number.

### 14.4 Battery wear cost

Charged into `C_lifecycle` (§8.5) so that the optimiser stewards the packs without a
dedicated rule:

```
C_battery = cu_per_equivalent_cycle · ( ΔSoC_throughput / 2 ) · stress( DoD, SoC_mid, T, C_rate )
```

The stress multiplier comes from the pack's vendor cycle-life-versus-DoD curve, stored as
configuration. Practical consequences, all emergent rather than encoded:

- Deep discharges cost superlinearly more, so the engine prefers many shallow cycles over few
  deep ones — the correct Li-ion policy.
- High-C-rate charging carries a stress premium, so fast charging happens when time is
  genuinely valuable rather than by default.
- A calendar-ageing component mildly penalises resting at very high SoC, so the fleet does
  not sit at 100 % unnecessarily.

### 14.5 The layered reserve model and the feasibility constraint

Four reserves, each with a distinct justification. They are additive, and none may be traded
against another.

| Reserve | Definition | Purpose | Overridable |
|---|---|---|---|
| `E_floor` | Hardware protection floor | Below this the pack risks damage or the agent loses controlled shutdown | **Never** |
| `E_return` | Energy to reach the nearest *available* charger from the mission end, by a pessimistic route | Prevents completing the delivery and stranding afterwards — a failure mode a mission-only check permits | Never |
| `E_contingency` | Quantile allowance for reroutes, congestion, weather, and consumption variance | Absorbs the realistic bad case rather than the average case | Never |
| `E_operational` | Optional buffer to remain useful for a following mission | Efficiency, not safety | Yes, by policy |

#### Shortfall is a tiered event, not one event

A single probability over "energy shortfall" cannot be evaluated for adequacy, because it
conflates outcomes whose consequences differ by orders of magnitude. Consuming the contingency
reserve is a diversion to charge and an operating-cost line. Breaching the return reserve
requires a physical recovery mission. Reaching the hardware floor in active service immobilises
the agent, possibly on a carriageway, a tram line, or a fire exit. These are not the same event
and MUST NOT share one probability target. The reserve model above already states that the
layers "may not be traded against another"; the feasibility constraint is stated with the same
granularity.

| Tier | Event | Consequence | Response (§14.8) | Per-mission target `α[tier]` |
|---|---|---|---|---|
| **T1** | Contingency reserve consumed | Diversion to charge; no incident | Pre-reserve a charger; alert | `≤ 1e-2` |
| **T2** | Return reserve breached | Physical recovery mission required | Abort/divert while still possible; escalate | `≤ 1e-5` |
| **T3** | Hardware floor reached in active service | Immobilisation; possible obstruction of a public right of way | Controlled stop at the safest reachable location; always page | `≤ 1e-7` |

**Feasibility constraint F34** — three simultaneous conditions, all of which MUST hold:

```
T1:  P[ E_usable(a) − E_mission(a,m) <  E_floor + E_return + E_contingency ]  ≤  α_1(class)
T2:  P[ E_usable(a) − E_mission(a,m) <  E_floor + E_return                 ]  ≤  α_2(class)
T3:  P[ E_usable(a) − E_mission(a,m) <  E_floor                            ]  ≤  α_3(class)
```

Each is evaluated on the predictive distribution of `E_mission`, whose variance comes from the
model's residual variance, inflated for route novelty, forecast horizon, and weather
uncertainty. The three conditions are nested — T3's event implies T2's implies T1's — so the
binding one is whichever tier's target is tightest relative to the distribution's shape at that
threshold. Which tier bound, and by what margin, is recorded per rejection (§7.7), because "this
mission failed on immobilisation risk" and "this mission failed on divert-to-charge risk" call
for entirely different operational responses.

#### The targets are governed in fleet-year terms, and derived down to per-mission

A per-mission probability in isolation is not a quantity any operator or safety reviewer can
reason about. Composed across fleet scale it becomes one they can. For a fleet of `N` agents
each completing `r_d` missions per day:

```
expected events per year  =  α · N · r_d · 365
```

At `N = 5 000` and `r_d = 20` — 36.5 million missions per year — the tier targets above compose
to:

| Tier | `α` | Events per fleet per year | Interpretation |
|---|---|---|---|
| T1 | 1e-2 | ~365 000 (≈1 000/day) | An operating-cost line: ~1 % of missions incur an unplanned charge diversion. A service-quality metric, budgeted and monitored, not an incident stream |
| T2 | 1e-5 | ~365 (≈1/day) | Roughly one physical recovery per day fleet-wide, ≈0.07 per agent per year. Absorbable by an existing recovery function |
| T3 | 1e-7 | ~3.7 | A handful of in-service immobilisations per year across a 5 000-agent fleet. This is the number a safety reviewer actually evaluates |

**The composed budget is the governed parameter; `α` is derived from it.** The configuration
register holds `energy.event_budget_per_fleet_year[tier]` (Safety class), and the Config Service
derives

```
α[tier]  =  energy.event_budget_per_fleet_year[tier]  /  ( N_agents · r_missions_per_agent_year )
```

publishing the resulting `α` and exposing both through the resolution-explain query (§22.2).
Deriving in this direction rather than the reverse is what prevents the specific error of
choosing a per-mission number that looks stringent — `1e-3` reads as "wrong less than once in a
thousand" — while authorising roughly a hundred reserve breaches a day once composed over fleet
scale. It also makes the target automatically re-derive when the fleet grows: a number that was
adequate at 500 agents is not adequate at 5 000, and nothing about a hand-set per-mission `α`
would have surfaced that.

The formulation remains deliberately probabilistic. A deterministic margin cannot express a
tail requirement at all, and any deterministic margin chosen to satisfy the tail is wasteful in
the body of the distribution. Tiering makes the safety level a *stated, auditable, tunable,
and composable* set of numbers rather than an emergent property of a threshold nobody can
justify.

**Reserve sizing follows from the tier targets, and is not independently configured.** The
contingency reserve is sized at the quantile that satisfies T1, so
`energy.contingency_quantile = 1 − α_1` is **derived**, not a free parameter. Configuring the
quantile and the tier-1 probability independently would permit them to contradict each other —
a 0.95 quantile cannot deliver a 1e-2 tier-1 target — and the contradiction would be invisible
because each value looks defensible alone.

#### `E_return` and the availability circularity

`E_return` uses the nearest charger that is *available or reservable* at the projected time,
not merely the nearest one geographically. A charger with a 25-minute queue is not a viable
reserve destination, and treating it as one reintroduces the stranding risk the reserve exists
to prevent.

That definition is, taken literally, **circular**: charger availability at a future time
depends on the charging schedule implied by other agents' plans, and those plans depend on the
outcome of the very round now being computed. A constraint defined in terms of its own output
is not evaluable, and a fixed-point iteration over it would be neither bounded in time nor
deterministic — both disqualifying in this engine (§9.6).

**The circularity is broken by construction, not by iteration.** The Charging Scheduler
publishes a **charger availability projection** — an immutable, versioned snapshot giving, per
charger, the intervals in which it is free or reservable over the planning horizon. The
projection published from the **previous completed round** is the input to the current one:

```
E_return( plan )  =  energy to reach the nearest charger that the pinned availability
                     projection shows free or reservable at the projected arrival time,
                     by a pessimistic route,
                     inflated by  energy.charger_availability_margin
```

Four properties follow, and each is required by something stated elsewhere in this document:

- **Determinism and replayability (T6, §9.6).** The projection is pinned by version in the
  round's input snapshot and recorded in the decision record, exactly like prices, forecasts,
  and config. A replay loads the same projection and reaches the same conclusion. A
  self-referential definition could not be replayed at all, because the fixed point reached
  would depend on iteration order.
- **It is an approximation, and is labelled as one.** The projection is stale by up to one
  round plus the Scheduler's publication interval. `energy.charger_availability_margin`
  (default 1.15) is the stated conservatism compensating for that staleness, and it is a
  Safety-class parameter.
- **Staleness is measured, not assumed.** The realised availability of the charger each plan
  selected is compared at settlement against what the projection claimed, and the error
  distribution is a calibration SLI (§21.5). A systematic optimism in the projection shows up
  as a margin that must widen, and is alertable before it shows up as a T2 event.
- **Degradation is defined.** If the projection is unavailable or stale beyond
  `energy.charger_projection_max_age`, the engine falls back to *depot-only* return targets —
  the fixed infrastructure whose availability does not depend on any round's output — and
  applies `energy.uncalibrated_reserve_factor`. This is T3 in its usual form: the envelope
  shrinks to what can still be established, rather than the constraint being relaxed.

The engine does not reserve the charger it plans against. `E_return` is a *feasibility
reserve*, not a booking: it establishes that a viable destination exists, which is a weaker
and much cheaper claim than holding one. Actual reservations remain the Charging Scheduler's
to grant (§14.7), and the engine's projected demand is fed forward so the Scheduler can plan
capacity rather than react to it.

### 14.6 Charging model

**Charge duration is nonlinear.** Li-ion charging is constant-current to roughly 80 % and then
constant-voltage with a decaying current, so the last 20 % can take as long as the first 60 %.
A linear rate — as the baseline's simulation uses — will systematically underestimate time to
full and overestimate fleet availability. The engine MUST integrate a per-model charge-power
curve `P_charge(SoC, T, charger_class)` to compute `t_charge(SoC₀ → SoC₁)`.

Directly consequential: **partial charging is usually optimal.** Charging to 80 % returns the
agent to service far sooner per watt-hour gained, and does less calendar-ageing damage. Target
SoC is therefore an optimisation output chosen against forecast demand, charger contention, and
wear cost — not a fixed "charge to full" rule.

#### Ownership of the target-SoC decision

**Decision: the Charging Scheduler owns and publishes target SoC. The assignment engine treats
the published value as an input constraint. The engine may submit a priced request to change
it; it never computes or asserts a target value unilaterally.**

This is stated because "an optimisation output" does not by itself say *whose* optimisation,
and charge scheduling is explicitly outside this engine's boundary (§1.6). Left unassigned, two
teams each reasonably assume the other owns it, or both implement it and the fleet receives two
different target values for the same agent — the exact two-scheduler conflict that F18 exists
to prevent, reappearing one level down in a field rather than in a reservation.

| Concern | Owner | Mechanism |
|---|---|---|
| Target SoC per agent per charging session | **Charging Scheduler** | Published per agent with each reservation; carried in the availability projection (§14.5); versioned and pinned into the round snapshot |
| Fleet availability curve the target serves | **Charging Scheduler** | Its own objective, against forecast demand |
| Projected energy demand that informs the target | **Assignment engine** | Fed forward continuously (§14.7); the engine's plans are the Scheduler's demand signal |
| Request to raise a target, priced in CU | **Assignment engine** | A priced request the Scheduler may refuse (§14.7); the request and its disposition are recorded |
| Whether a mission may interrupt a charge | **Joint, Scheduler has the veto** | The three conditions below |

The engine consumes `target_soc` exactly as it consumes a charger reservation: as a hard input
it did not choose. When a plan's inserted charging stop (§13.4) would leave the agent below the
published target, the plan is infeasible unless the Scheduler grants a revised target in
response to a priced request. The engine's influence on the value is therefore real but
mediated, priced, refusable, and auditable — rather than asserted.

**Degradation.** If the Scheduler's published target is unavailable or stale beyond
`energy.target_soc_max_age`, the engine uses the class default
`energy.target_soc_fallback[agent_class]` and records the substitution as a degradation flag on
every affected decision. It does **not** compute a substitute target from its own demand
forecast, because doing so would silently transfer ownership of the decision at precisely the
moment the owning service is unable to contest it.

**Charge interruption.** The baseline uses a fixed 30 % threshold. Here, interrupting a charge
is permitted when: (a) the resulting plan satisfies F34–F35 with all reserves intact; (b) the
Charging Scheduler confirms the interruption does not breach the fleet's projected
availability floor; and (c) the value of serving the mission exceeds the wear premium plus the
opportunity cost of the deferred charge. This replaces a magic constant with a stated
condition — and it correctly permits interruption at 25 % for a 400 m mission while forbidding
it at 45 % for a 9 km one, which no single threshold can do.

The threshold sharing that the audit praises in the baseline — one constant used by both the
server gate and the agent's deferral logic, specifically so the two cannot diverge — is
preserved in spirit and strengthened: the *agent* receives the reserve parameters and the
target SoC as part of the offer, so the two sides reason from identical inputs by construction
rather than by a shared constant that a future edit could desynchronise.

### 14.7 Interaction with the Charging Scheduler

Chargers are a finite, contended resource, so charging cannot be a local agent decision. The
contract between the two services is stated explicitly and symmetrically, because the coupling
is deliberately soft (§1.6) and a soft boundary with an unstated contract is just an
unassigned decision.

**The Charging Scheduler owns and publishes:**

- Charger **reservations**, which are **hard constraints** on the assignment engine (F18): an
  agent reserved for charging is not available, which prevents the classic two-scheduler
  conflict.
- **Target SoC** per agent per session (§14.6), which the engine consumes as an input
  constraint and never computes for itself.
- The **charger availability projection** — the versioned, immutable snapshot of per-charger
  free and reservable intervals over the planning horizon, which breaks the `E_return`
  circularity (§14.5) and keys the charger-reachability cache (§20.3).
- The fleet's target availability curve against forecast demand.

**The assignment engine publishes to the Scheduler:**

- Projected energy demand implied by its current plans, so charging is planned ahead of need
  rather than reactively.
- Priced **requests**: to release a reservation, or to revise a target SoC. The Scheduler may
  refuse; both request and disposition are recorded in the decision record.
- Realised consumption and `κ(a)` drift (§14.2), which improve the Scheduler's own forecasts.

**Neither service may assert the other's field.** The engine never writes a reservation or a
target SoC; the Scheduler never assigns work. Every cross-boundary influence is a priced,
refusable, recorded request.

**On Scheduler unavailability:** agents already charging continue to completion; no
interruption is permitted (T3 — without the fleet-level view, interruption cannot be shown
safe); target SoC falls back to the class default with a recorded degradation flag (§14.6); and
`E_return` falls back to depot-only destinations (§14.5). The envelope shrinks in three
specific, pre-declared ways rather than the engine improvising ownership of three decisions
that are not its own.

### 14.8 Mid-mission energy management

Monitored continuously (§12.3). When realised consumption diverges beyond
`energy.deviation_tolerance`, the engine re-evaluates feasibility with the observed
efficiency and acts **while action is still possible**:

The projection tiers here are **the same tiers as the F34 feasibility constraint** (§14.5), so
the realised frequency of each row is directly comparable against that tier's budgeted rate —
which is what makes invariant I17 verifiable from operational data rather than only in
simulation.

| Projection | Tier | Action |
|---|---|---|
| Reserves intact | — | Continue; update `κ(a)` |
| Contingency eroded but return reserve intact | **T1** | Continue; pre-reserve a charger; alert; count against the T1 budget |
| Return reserve threatened, pre-custody | **T2** | Abort and reassign; divert to charger; count against the T2 budget |
| Return reserve threatened, custody `HELD` | **T2** | Attempt a diversion to the nearest safe drop or transfer point; if none, escalate for physical recovery **before** the agent immobilises; count against the T2 budget |
| Below floor projected imminently | **T3** | Controlled stop at the safest reachable location; page operations; count against the T3 budget |

A T3 event that was *reached by controlled stop* is still a T3 event for budget purposes. The
distinction the ordering principle below draws — choosing where to stop — reduces the
consequence of the event, and is priced accordingly in `cost.energy_consequence[T3]`, but it
does not make the event not have happened. Counting it otherwise would let the fleet consume
its immobilisation budget invisibly.

The ordering principle: an agent that stops where it *chose* to stop is a recoverable
inconvenience; an agent that stops where its battery *ran out* may be blocking a road, a fire
exit, or a rail crossing. The engine MUST always prefer the former, and MUST make that
decision early enough to have the choice.

---

## 15. Payload Strategy

### 15.1 Task-side payload specification

The baseline has no payload concept whatsoever — the audit verifies by exhaustive search that
no mass, volume, or capacity field exists in schema or code. The model must therefore be built
from first principles.

| Attribute | Purpose |
|---|---|
| Mass (kg), with tolerance | Capacity, energy, braking, stability |
| Dimensions (L×W×H) and shape class | Packing feasibility, compartment fit |
| Volume | Fast necessary-condition check |
| Orientation constraints | "This way up", fragile stacking limits |
| Stackability and load-bearing limit | Whether other items may rest on it |
| Fragility class | Route smoothness preference, speed limits, acceleration limits |
| Thermal requirement (min/max °C, and max excursion duration) | Cold chain and hot-food integrity |
| Security class | Requires a lockable compartment, tamper evidence, or chain-of-custody |
| Hazard class and segregation rules | Regulatory; incompatible goods must not share a compartment |
| Value | Sets verification level (§12.5) and `C_failure` (§8.4) |
| Regulatory class | Age-restricted, prescription, controlled — sets attestation requirements |
| Item count and divisibility | Whether the consignment may be split across compartments or missions |

Mass is specified with a **tolerance**, because declared masses are frequently wrong.
Feasibility uses the upper bound of the tolerance; energy estimation uses the expectation.
Realised mass, where the agent can measure it, is fed back to correct the declaration source —
a systematically under-declaring merchant is an operational problem worth surfacing.

### 15.2 Agent-side container model

A capacity scalar is insufficient: a 20 kg limit tells you nothing about whether two 40 cm
boxes fit through a 30 cm hatch.

| Element | Content |
|---|---|
| Compartments | Ordered list, each with internal dimensions, aperture dimensions, max mass, thermal class and active/passive control, lock class, tamper sensing, and access side |
| Aggregate limits | Total mass, total volume, per-axle mass distribution |
| CoG envelope | Permitted centre-of-mass region as a function of gradient and speed |
| Access constraints | Which compartments are reachable without disturbing others; whether opening one exposes others |
| Loading interface | Human handover, robotic transfer, conveyor dock, drone winch |
| Cleanliness/contamination class | Food after chemicals requires a cleaning cycle — a genuine constraint in mixed-use fleets |

The **aperture** dimension is modelled separately from the internal dimension because it is a
distinct and frequently binding constraint that a volume-based model misses entirely.

### 15.3 Packing feasibility — tiered evaluation

Exact 3D bin packing with orientation and stacking constraints is NP-hard and cannot run for
200 candidates in a 250 ms budget. Tiered evaluation gives exactness where it matters and
speed everywhere else:

| Tier | Check | Cost | Result |
|---|---|---|---|
| 1 | Necessary conditions: total mass ≤ limit; total volume ≤ capacity × `payload.packing_efficiency`; every item's smallest cross-section fits some compartment's aperture; thermal, hazard, and security classes have a compatible compartment | O(items) | Rejects most infeasible pairings immediately |
| 2 | Greedy constructive packing: first-fit-decreasing by volume with permitted orientations, respecting stacking, access order, and segregation | O(items × compartments) | Accepts with a concrete loading plan |
| 3 | Bounded exact search: branch-and-bound with a node budget, only when tier 2 fails and the pairing is otherwise attractive | bounded | Resolves the marginal cases |
| 4 | Memoised result keyed by `(container_config, item_multiset_signature)` | O(1) | Repeated identical consignments cost nothing |

If tier 3 exhausts its budget without a result, the outcome is `INDETERMINATE` with policy
`DENY` — the engine declines rather than dispatching a load it could not prove fits. Tier 2's
loading plan is transmitted in the offer, so the agent and any human loader know the intended
arrangement, and the plan is verifiable against compartment sensors on load.

### 15.4 Load state along the plan

Payload state is evaluated **per stop**, not once. Along a multi-stop plan, mass and volume
rise and fall, compartments are occupied and freed, and CoG shifts. F22–F24 must therefore
hold at every point in the sequence, and a plan can be feasible at stops 1–3 and infeasible at
stop 4. This is why feasibility is a property of the plan (§13.1) rather than of the pairing.

Access ordering is part of the constraint: if item A must be removed before item B is
reachable, then B's drop cannot precede A's. This is a genuine sequencing constraint that a
capacity-only model cannot express, and it is a common source of real-world failures in
multi-drop delivery.

### 15.5 Payload effects beyond the gate

Payload is not only a constraint; it changes the physics, and a design that treats it purely
as a gate will systematically mis-plan loaded missions:

- **Energy — mass**: `β_mass` term (§14.2).
- **Energy — conditioning**: `β_payload_thermal` (§14.2), charged per compartment over the
  interval it actually holds temperature-controlled goods. This is the effect most often missed,
  and it is missed on exactly the long-duration cold-chain missions where energy feasibility is
  tightest.
- **Speed**: loaded max speed and acceleration limits from the MobilityModel, altering ETA.
- **Braking**: longer stopping distance, which may bar certain routes for a heavy load.
- **Gradient**: mass and CoG limit traversable inclines, which is a *routing* constraint, so
  the routing query for a loaded leg differs from the unloaded one.
- **Fragility**: may impose route-smoothness preferences and acceleration caps, priced as a
  longer duration rather than a hard rejection.

### 15.6 Custody, evidence, and reconciliation

- Custody transitions require evidence proportionate to value (§12.5): compartment sensing,
  mass delta, scan, or attestation.
- The payload manifest is reconciled at every custody event. A mass delta inconsistent with
  the manifest is a discrepancy event, not a rounding error — it may mean a wrong item, a
  missing item, or tampering.
- An agent MUST NOT be returned to the available pool while any compartment is non-empty
  against an open manifest (§26 invariant I7). This single invariant prevents an entire class
  of lost-goods incidents, and it is the reason custody release must precede commitment
  release in settlement (§4.9).

---

## 16. Reliability and Health

### 16.1 What reliability must deliver

Three distinct consumers, and conflating them produces a metric useful to none:

1. **The cost function** needs a calibrated probability `p_fail(a, m)` for `C_risk` (§8.4).
2. **The feasibility gate** needs a graded health tier for F8, F9, and F11.
3. **Maintenance** needs leading indicators to schedule intervention before failure.

The baseline has none of these: the audit confirms no success/failure counters, no MTBF, and
no per-agent historical aggregate exist, and that the `Event` and `Command` rows which are
written are never aggregated or read into any decision.

### 16.2 The metric set

| Metric | Definition | Why it earns its place |
|---|---|---|
| **Interventions per km** | Human interventions (remote or on-site) per distance travelled | The single most predictive operational metric in mobile robotics; it aggregates every cause of non-autonomy into one comparable number |
| Mission success rate | Completed without abort or reassignment, by mission class | The headline outcome, but too coarse alone |
| Stall events per km | Unplanned halts exceeding a duration threshold | Leading indicator of navigation and perception degradation |
| Replans per km | Local route replanning frequency | Distinguishes environmental difficulty from agent difficulty when normalised by segment |
| Localisation health | Pose covariance distribution, relocalisation events per km, sensor dropout rate | Directly gates F10 |
| Comms stability | Disconnect rate, reconnect latency, RTT distribution, packet loss, dead-zone dwell | Gates F13–F15 and predicts dispatch unresponsiveness |
| Command acceptance | ACK latency distribution, NACK rate, fence-rejection count by scope (§10.3.1) | Detects protocol and clock faults early |
| Hardware indicators | Motor current anomalies, temperature trends, wheel slip, vibration signature, pack internal resistance | The physical leading indicators |
| Energy efficiency drift | Trend in `κ(a)` (§14.2) | Rising `κ` precedes mechanical failure |
| Software health | Crash and restart counts, watchdog trips, version | Frequently the real cause of a "hardware" fault |
| Punctuality | Distribution of realised minus predicted arrival | Feeds `p_late`; distinct from speed |
| Handling quality | Damage claims, evidence disputes, acceleration/jerk exceedances | The quality dimension customers actually notice |

Rates are computed with **exponential time decay** (`reliability.halflife_days`, default 30)
so that recent behaviour dominates and a repaired agent recovers its standing at a defined
rate rather than being punished by ancient history.

### 16.3 Estimation: hierarchical Bayesian with attribution

**Estimator.** For a binary outcome, a Beta-Binomial per agent with its prior taken from the
agent's cohort — `(model, hardware revision, firmware version, site)` — nested upward to the
fleet. Rate metrics use a Gamma-Poisson analogue.

Shrinkage is not optional; it is the difference between a usable estimate and noise. A newly
commissioned agent with two successful missions has an empirical success rate of 100 %; a naive
estimator ranks it above a proven agent with 4 000 missions at 99.4 %. With shrinkage, its
estimate sits near its cohort prior and moves as evidence accumulates. This is the correct
handling of the small-sample problem and it MUST be implemented as such rather than with an
arbitrary "minimum missions" rule.

**Mission-conditional difficulty.** Raw rates confound the agent with its assignments. An
agent given the hardest routes will look unreliable. The estimator therefore conditions on
mission difficulty features — gradient profile, crowding, weather exposure, route novelty,
segment intervention history — so that `p_fail(a, m)` is a *pairing* estimate. This also
avoids a pernicious feedback loop: without conditioning, an agent penalised for hard routes
gets easy routes, its measured reliability improves, and the estimator has learned the routing
policy rather than the agent.

**Conditioning narrows that loop; it does not close it, and the residual bias is accepted
explicitly rather than left implicit.** Several difficulty features — route novelty, segment
intervention history, crowding along the chosen path — are partly *derived from routing
decisions the engine itself made*, so the estimator is conditioned on covariates that the policy
influences. Fully breaking the loop would require a randomised assignment component, which T7
and T1 both rule out of the decision path, or a structural identification strategy that cannot
be validated before there is production data to validate it against. The design therefore
accepts the bias, bounds it, and measures it:

- Difficulty features are restricted to those derivable from the **route request** (gradient
  profile, distance, weather exposure, zone) rather than from the engine's *choice among*
  routes, which removes the most direct channel at no cost.
- The bias's magnitude is estimated offline by the counterfactual evaluator (§21.6), which
  re-solves historical rounds under relaxed bounds and compares reliability estimates fitted on
  policy-consistent and policy-divergent subsets. A widening divergence is an alert.
- `p_fail` enters only `C_risk`, a priced term, never a gate — F11's health tier is driven by
  change detection on directly observed rates (§16.4), not by the conditional estimate. A biased
  estimate therefore costs allocation quality and cannot make an unsafe agent eligible.

Revisiting this with an identification strategy is deferred to §28.3 V2-9 rather than guessed at
now.

**Attribution.** Every failure is classified by cause: agent hardware, agent software,
mapping/routing error, environmental obstruction, third-party interference, recipient
unavailability, weather, or infrastructure. **Only agent-attributable causes update the agent's
reliability estimate.** Punishing an agent because a delivery truck blocked an alley is both
unfair and actively harmful — it corrupts the signal the cost function depends on. Attribution
uses automated classification with human review for ambiguous cases and for any event above a
severity threshold; attribution quality is itself audited by sampling.

### 16.4 Health tiers and automatic quarantine

Tiers are derived, ordered, and drive F8/F9/F11:

| Tier | Criteria | Permitted work |
|---|---|---|
| `NOMINAL` | All indicators within control limits | All |
| `WATCH` | One indicator drifting; change detected but within limits | All, with a raised risk cost |
| `DEGRADED` | An indicator out of limits, or a non-blocking fault active | Restricted: no critical SLA class, no high-value goods, reduced mission radius |
| `RESTRICTED` | Multiple indicators out of limits, or a repeated failure pattern | Short local missions only, or reposition and return-to-depot missions |
| `QUARANTINED` | Blocking fault, safety event, failed self-test, or change-detection alarm | None; return to depot only |
| `OUT_OF_SERVICE` | Maintenance, decommissioned, or recalled | None |

The baseline defines a `DEGRADED` health value that is never written and never consulted; here
the graded tiers are load-bearing.

**Automatic quarantine on change detection.** A CUSUM or EWMA change-point detector runs on
each agent's intervention rate, stall rate, and `κ` drift. A statistically significant adverse
change triggers automatic quarantine with operator notification, *without* waiting for the
absolute rate to cross a static threshold. This is the difference between catching a
developing fault in hours and catching it after a field incident. False positives cost one
agent-shift and an inspection; false negatives cost an incident, so the detector is
deliberately tuned toward sensitivity, and its false-positive rate is monitored as an SLI so
the tuning remains a conscious choice.

### 16.5 Use in the decision

- **Hard gate:** `QUARANTINED` and `OUT_OF_SERVICE` are ineligible (F8, F2). Tier below the
  mission's requirement is ineligible (F9).
- **Priced:** `p_fail × C_failure` in `C_risk`; punctuality variance in `p_late`; `κ` in the
  energy model, which affects both feasibility and cost.
- **Never a bonus that can override a constraint.** A perfectly reliable agent cannot become
  eligible for work it is not capable of or does not have the energy for.

### 16.6 Maintenance interaction

The engine does not schedule maintenance, but it MUST make maintenance possible:

- Exposes predicted remaining useful life and interval consumption per agent.
- Honours maintenance reservations as hard constraints (F18) exactly as it honours charging
  reservations.
- Prefers, through `C_lifecycle` and `V_terminal`, to leave an agent nearing service near its
  service bay — so that the maintenance visit is cheap rather than requiring a recovery trip.
- Treats "transit to maintenance" as an ordinary Leg with `purpose = MAINTENANCE_TRANSIT`
  (§2.4), subject to the same feasibility rules — which is important because a degraded agent
  must still be able to *get* there safely, and because a maintenance transit must not be shed
  under load merely for having no customer attached to it.

---

## 17. Fairness, Balancing, and Anti-Starvation

### 17.1 Fairness is mostly an economic outcome, not a separate objective

An explicit fairness weight is the wrong primary mechanism, because unbalanced utilisation is
not intrinsically bad — it is bad *because* it consumes one asset's life faster than another's
and concentrates failure risk. Those are costs, and `C_lifecycle` (§8.5) already prices them.
When wear, energy, and battery cycling are priced per agent, the optimiser spontaneously
spreads load: a heavily used agent has accumulated more wear, and its marginal wear cost is
higher.

This is a better mechanism than a fairness term for three reasons: it is economically correct
rather than arbitrary; it does not sacrifice service quality to equalise a number that does not
matter in itself; and it automatically accounts for agents that *should* be used more (newer,
cheaper to run, better placed).

A **small explicit regulariser** is still required for two effects the economic terms miss.

### 17.2 The duty-cycle regulariser

```
C_fairness(a) = fairness.weight · max( 0, dutycycle_ewma(a) − dutycycle_target(fleet) )^2
```

with `dutycycle_ewma` computed over `fairness.horizon` (default 7 days, contrast the
baseline's ~40-second EMA which the audit shows can only reflect how recently an agent finished
its last task). Two purposes:

1. **Thermal and mechanical recovery.** Continuous duty produces heat soak and accelerated
   wear that per-mission accounting does not capture.
2. **Risk concentration.** Concentrating work on few agents concentrates the fleet's exposure
   to a single failure.

Quadratic and one-sided: it penalises only agents above the fleet target, and its cost grows
with the excess, so it is negligible in normal operation and firm at the extreme. The weight is
deliberately small — if it visibly changes allocations under normal load, the wear coefficients
in `C_lifecycle` are miscalibrated, and that is where the fix belongs.

**Deterministic fair tie-breaking.** Exact cost ties resolve to the agent with the lower
cumulative duty cycle (§9.6). This is free fairness: it costs nothing in objective terms and
makes ties do useful work, replacing the baseline's arbitrary "first row returned by an
unordered query."

### 17.3 Spatial balancing and repositioning

Zone imbalance is a coverage problem, and pricing alone will not fix it, because an agent
sitting in the wrong place costs nothing until work arrives. Two mechanisms:

1. **The relocation component of `C_opportunity`** (§8.3.3) makes missions ending in
   high-demand zones cheaper — negative, where the gain in `V_avail` exceeds the unavailability
   cost — so balancing happens as a by-product of ordinary work at zero extra cost. This is
   always preferred where it suffices. It is also the term whose negativity the pruning bound
   must account for, which is why `Ω_terminal` exists (§6.4): the mechanism that makes
   repositioning-beneficial missions attractive is the same mechanism that would break an
   uncorrected lower bound.
2. **Explicit reposition missions,** generated by the Repositioning Planner when forecast
   demand and projected supply diverge beyond `reposition.trigger_imbalance`. These are
   injected into the engine as ordinary Legs with `purpose = REPOSITION` (§2.4) and a low SLA
   class. Their purpose — not a separate `preemptible` flag — is what makes them freely
   preemptible and first to be shed (§4.8, §20.5), so the three behaviours cannot drift apart.

Injecting reposition moves as ordinary missions rather than handling them in a separate
subsystem is a deliberate architectural choice: it means one optimiser arbitrates between
"serve this delivery now" and "improve coverage for the next ten minutes," using one objective
in one unit. Two separate schedulers competing for the same agents would need a conflict
resolution protocol between them, which is strictly worse than having a single optimiser.

Reposition missions are preemptible without penalty and are the first thing sacrificed under
load, which is correct: speculative positioning should always yield to actual work.

### 17.4 Task anti-starvation: the escalation ladder

**The escalation ladder is the anti-starvation guarantee.** This is stated first because the
division of labour between the two mechanisms is easy to get backwards, and getting it
backwards produces a system that is simultaneously starvation-prone and prone to sacrificing
whole rounds to a single aged Leg.

- **The ladder provides the hard guarantee.** It is finite, it advances on elapsed SLA budget
  regardless of cost dynamics, and it terminates in a decision. No amount of cost arithmetic
  can prevent it from advancing, which is exactly why it — and not a price — is what makes
  starvation impossible.
- **The bounded aging multiplier (§8.7) is a soft, capped nudge.** It improves ordering among
  comparable options before the ladder is needed. It is explicitly *not* relied upon for the
  guarantee, and it is capped at `cost.aging.max_multiplier` so that it cannot dominate a
  batch objective.

An unbounded price cannot in any case rescue a Leg that is infeasible for every agent, which
is the case that actually starves: no multiplier makes an infeasible pairing feasible (T1).
The ladder addresses that case by *widening the option set* — radius, availability classes,
class-P relaxations, preemption, cross-region, manufactured supply — and finally by taking an
explicit decision. Widening what is possible is the only intervention that can help; raising
what it is worth cannot.

Ladder steps are each triggered by an elapsed fraction of the SLA budget, each individually
configurable, each **recorded** with what was relaxed and why:

| Step | Trigger | Action |
|---|---|---|
| 1 | 25 % of budget | Widen the search radius beyond the class default |
| 2 | 40 % | Admit `FINISHING_SOON` and `CHARGING_INTERRUPTIBLE` classes with a longer wait horizon |
| 3 | 55 % | Relax **class P** soft constraints in a defined, ordered, published sequence — zone affinity first, dedicated-fleet preference next, and so on. Class I, R, and F are never relaxed |
| 4 | 70 % | Permit preemption of lower-class missions (§4.8) |
| 5 | 80 % | Request cross-region candidates where policy permits |
| 6 | 85 % | Trigger a targeted reposition or an accelerated charge to manufacture supply |
| 7 | 90 % | Escalate to a human dispatcher with the full rejection analysis (§7.7) and the ranked list of near-miss agents with their binding constraints |
| 8 | 100 % | Fall back to an alternative modality where configured — human courier, third-party carrier, scheduled batch — or decline the task with a stated reason and customer notification |

#### The human steps have a capacity model

Steps 7 and 8 route to people, and people are a finite, contended resource. Without a capacity
model those steps are a guarantee only while the fleet is healthy: under any systemic failure —
a routing outage, a weather regime change, a shard entering Restricted Operation — every
affected Leg advances its ladder on the same clock and arrives at step 7 together. An escalation
path that assumes it will be reached one Leg at a time is not a path; it is a queue nobody sized.

- **Human escalation capacity is modelled explicitly** as `ops.escalation_capacity`, scoped per
  region — the concurrent escalations the on-call dispatch function can actually hold — with the
  current outstanding count as a first-class SLI.
- **Steps 7 and 8 are triaged, not merely queued.** When outstanding escalations exceed capacity,
  Legs are ordered for human attention by custody state first (custody `HELD` always outranks
  custody `NONE`), then obstruction class, then SLA breach proximity, then queue age. A dispatcher
  facing forty escalations needs the order chosen deliberately rather than by arrival.
- **Escalation is rate-limited into the human queue**, and Legs waiting to enter it remain on the
  ladder rather than being deemed to have completed step 7. A Leg that "reached step 7" without a
  human ever seeing it has not been escalated, and recording otherwise would make the ladder's
  guarantee false in exactly the conditions it exists for.
- **Sustained saturation is itself an escalation.** When outstanding escalations exceed capacity
  for `ops.escalation_saturation_period`, the shard raises a distinct high-severity alert and
  admission control begins declining new work of the affected classes at intake (§20.5) — because
  accepting work the operation demonstrably cannot resolve is the failure mode §18.4 exists to
  prevent, one level up.

Two properties make this a genuine guarantee rather than a hopeful sequence. First, the ladder
is **finite and terminates in a decision**: either assignment, an alternative modality, or an
explicit, communicated decline. A task cannot wait forever, which is what the baseline permits
for a task stuck at `PENDING` after a database error. Second, **the relaxation order is
published configuration**, so operations knows in advance exactly what the system will
sacrifice under pressure and in what order. A system that improvises under load is
untrustworthy precisely when trust matters most.

### 17.5 Agent starvation

An unused agent is a wasted asset, and its idleness hides developing faults. Two mechanisms:

- **Detection**: an agent with zero completed missions in `fairness.idle_alert_period` while
  nominally available raises an alert. The usual cause is an unsatisfiable constraint — an
  expired certification, a stale capability record, a geofence misconfiguration — and it is
  diagnosable directly from the rejection histogram (§7.7), which will show one predicate
  rejecting this agent repeatedly.
- **Exercise missions**: periodic self-test and short reposition missions, injected as Legs with
  `purpose = EXERCISE` (§2.4), ensure every agent is regularly proven functional. Discovering
  that an agent has been broken for a fortnight at the moment you finally need it is an
  availability failure, and idle fleets accumulate exactly that. Being a speculative purpose,
  they are shed before any customer work under load.

---

## 18. Failure Handling

### 18.1 Principles

1. **Every failure has a detector with a bounded detection latency.** An undetected failure is
   the worst kind; the audit lists nine baseline failure modes whose detection is "No."
2. **Every failure has a defined automatic response and a defined escalation.** Undefined
   behaviour under failure is a design defect, not an operational surprise.
3. **Responses are custody-aware** (§2.5). Before custody, software recovers. After custody,
   physical logistics recovers, and software's job is to route the physical response quickly
   and accurately.
4. **Degradation reduces the envelope, never the safety margin** (T3).
5. **Every automatic response is counted and alerted** (T10).

### 18.2 Agent-level failure catalogue

| # | Failure | Detection | Latency | Automatic response | Escalation |
|---|---|---|---|---|---|
| A1 | Graceful disconnect | Session close | immediate | Pre-custody: reassign after `connectivity.grace`. Post-custody: monitor for reconnect, then §4.7 | `STRANDED_SAFE` or `STRANDED_OBSTRUCTING` by obstruction class if unreachable past window |
| A2 | Ungraceful disconnect / link loss | Heartbeat miss | ≤ `connectivity.max_heartbeat_age` (default 10 s) | Remove from availability index immediately; lease continues until expiry to allow reconnect; then §4.7 | As A1 |
| A3 | Known dead zone en route | Last accepted position within a mapped dead zone | predictive | Suppress recovery; extend the lease by the **95th percentile of that zone's historical transit time** for the agent's mobility profile, capped at `connectivity.max_deadzone_extension` — never by a mean or a nominal figure. Planned silence must not trigger recovery, but an extension granted on a prediction is immunity from supervision during the window when the agent is *least* observable: an agent that entered the zone and then stopped, turned back, or suffered an unrelated fault looks identical to one transiting normally. **Normal supervision is restored only on corroborated exit** — an accepted position fix outside the zone — not on the extension elapsing | Alert on every extension that reaches its cap; extension frequency per zone and per agent is a monitored signal, since a zone whose extensions routinely run to the cap is mismapped or the agent is failing inside it |
| A4 | Emergency stop engaged | Agent report or state change | immediate | Mission suspended; no reassignment until cleared by a human; area safety check | Always page |
| A5 | Blocking hardware fault | Fault report / self-test | immediate | Pre-custody abort and reassign; post-custody transfer or recovery mission | Maintenance ticket, auto-quarantine |
| A6 | Non-blocking degradation | Health monitor | seconds | Continue; tier drops; excluded from future high-value work | Maintenance ticket |
| A7 | Localisation loss | Covariance breach, relocalisation failure | seconds | Halt in place; attempt recovery; if unresolved, teleop or on-site assistance | Page if in traffic |
| A8 | Navigation stall / blocked | Progress supervision (§12.3) | `supervise.stall_time` | Local replan; then global reroute; then obstacle report to the knowledge base and reroute of other affected missions | Operator after `n` failed replans |
| A9 | Energy divergence | Realised vs predicted Wh | continuous | §14.8 ladder | Page before immobilisation, never after |
| A10 | Battery below floor projected | Energy projection | predictive | Controlled stop at the **lowest obstruction class reachable** — the choice of stopping location is made against the map's obstruction classification, not merely against distance (§4.3, §14.8); counted as a T3 event (§14.5) | Always page; external escalation if the reachable set contains only `BLOCKING_CRITICAL` locations (§18.6) |
| A11 | Offer unacknowledged | ACK timeout | `dispatch.offer_ttl` | §11.4 ladder | Systemic check at threshold |
| A12 | Agent rejects offer | NACK | immediate | Requeue; cooloff; reconcile server-versus-agent feasibility disagreement | Alert on repeated or systemic rejects |
| A13 | Agent reports implausible state | Physical plausibility check | per observation | Reject the observation; mark state indeterminate; quarantine on repetition | Security event (§23.5) |
| A14 | Mission overdue | Timeline supervision | continuous | Re-project; Task `AT_RISK`; customer notification; reassign if pre-custody | Operator at breach |
| A15 | Completion claim unverifiable | Verification (§12.5) | at claim | Task → `VERIFYING`; operator queue | Dispute process |
| A16 | Payload discrepancy | Manifest reconciliation | at custody event | Hold; do not release the agent; investigate | Always, potential theft or mis-ship |
| A17 | Agent immobilised with custody | Progress + custody state | `supervise.stall_time` | `TRANSFER` or `RECOVERY` Leg generated (§2.4, §4.7); Leg moves to the `STRANDED_*` state matching the obstruction class | Always page with manifest and access details; §18.6 chain if obstructing |
| A20 | Agent deduplication state reset | `dedup_state_generation` advanced at session establishment | at reconnect | **Suppress redelivery**; advance `authority_epoch`; reconcile custody and physical state; re-offer fresh (§11.5) | Alert per occurrence; page if the rate across an agent class exceeds threshold, which indicates non-durable storage |
| A18 | Firmware/version mismatch after update | F5 at feasibility | at next decision | Agent excluded from affected mission types | Fleet-wide alert if widespread |
| A19 | Clock skew on agent | Timestamp comparison | per observation | Reject affected observations; require resync; fencing prevents stale-command execution regardless, since both fences are counters rather than timestamps (§10.3.1) | Alert |

### 18.3 Infrastructure failure catalogue and envelope reductions

| # | Failure | Detection | Response | Envelope reduction |
|---|---|---|---|---|
| B1 | Commitment Store unavailable | Health check, write failure | Enter **Custodial Operation** (§18.5): stop committing, stop issuing commands, suspend I2 explicitly; continue intake and queueing; publish honest ETAs; drain on recovery | No new commitments; **no new commands to any agent**; in-flight missions continue under on-agent self-supervision within their autonomy limit; **no task is failed for this reason** |
| B2 | Commitment Store degraded (high latency) | Latency SLI | Reduce round rate; increase batch window; shed low-priority rounds | Fewer, larger, more valuable commitments |
| B3 | Cache tier lost entirely | Connection failure | Enter **Cold Index** (§18.5): continue on the durable path; rebuild the index from the observation log and next heartbeats | Higher latency; candidate search narrower until the index warms; **correctness unaffected** (§3.3, I16) |
| B4 | Timer store unavailable | Health check | Enter **Unsupervised Commitment** (§18.5): stop hardening new commitments; the reconciler's periodic sweep becomes the supervision mechanism at reduced frequency | Supervision latency degrades; commitment rate reduced accordingly; **I4 explicitly suspended**, I2 degraded to sweep granularity |
| B5 | Routing Service unavailable | Timeout | Enter **Degraded Routing** (§18.5): cached matrices; then geometric bound × detour factor | `route.degraded_max_radius`; reserves × `route.degraded_reserve_factor`; only pre-surveyed corridors hardened; reported optimality gaps widen and carry a degradation flag |
| B6 | Routing Service partially failing | Per-request errors | **Uniform treatment**: if any candidate's route is unavailable, *all* candidates in that decision use the degraded estimator | This specifically prevents the baseline's partial-failure bias, where candidates in a failed batch received the best possible travel-time score purely because their data was missing |
| B7 | Map service stale or unavailable | Version check | Pinned last-known-good snapshot | Recently changed areas excluded from routing |
| B8 | Forecast unavailable | Timeout | Last good forecast → seasonal prior → flat | Opportunity term shrinks toward prior; recorded as degraded |
| B9 | Reliability Service unavailable | Timeout | Cohort priors | Agents without a tier barred from critical-class work |
| B10 | Energy Model Service unavailable | Timeout | Class model without per-agent calibration | Reserves × `energy.uncalibrated_reserve_factor` |
| B11 | Agent State Service unavailable | Timeout | Rebuild from the durable log | Indeterminate agents ineligible; §7.4 systemic guard |
| B12 | Config Service unavailable | Timeout | Pinned last-known-good version | No config changes take effect; alert |
| B13 | Coordinator crash | Lease loss | Standby acquires leadership, advances `shard.leadership_fence`, recovers durable commitments and reconstructs SOFT reservations (§19.5) before resuming rounds | Brief pause in round processing; **no HARD commitment loss**; Legs in `PLANNED` are re-planned in the first round |
| B14 | Network partition, coordinator isolated | Lease renewal failure | Isolated coordinator **stops committing immediately**; the majority side elects a new leader and advances the leadership fence; guard G1 (§10.3.2) causes the isolated side's late commits to abort at the store even if it has not yet noticed its own isolation | Availability sacrificed for exclusivity on the commit path only |
| B15 | Message bus / dispatch transport failure | Delivery failure rate | Alternate channel if available; §11.4 step 4 | No new hardening; existing missions continue autonomously |
| B16 | Analytical or Decision Log store unavailable | Write failure | Buffer locally with bounded spill, **prioritising Tier A over Tier B** — Tier B is reconstructible by replay while Tier A is not (§21.2); **never block a decision on logging** | Tier B writes shed first and the shedding is counted; a decision whose Tier A record cannot be written is itself recorded as unlogged; decisions continue |
| B17 | Charging Scheduler unavailable | Timeout | No charge interruptions permitted; in-progress charges complete | Reduced availability; conservative |
| B18 | Clock source failure / excessive skew | Skew monitor | Node removes itself from leadership eligibility | Fewer eligible coordinators; correctness preserved by fencing |
| B19 | Overload (arrival rate > capacity) | Queue depth, round time | Enter **Shed Load** (§18.5): admission control shedding by Leg `purpose` then class (§20.5); publish honest ETAs; alert | Speculative purposes shed first, then low-priority classes, **never `custodial_purposes`**; declines are explicit, never silent |
| B20 | Poison input (a mission that crashes evaluation) | Crash correlation per mission id | Quarantine that mission after `n` failures; continue the round without it | One task blocked, fleet unaffected; always alert |

B16 and B20 deserve note. B16 states an ordering: observability is important but never more
important than the operation, so a logging outage must not stop deliveries — while a
*decision* that cannot be logged is still recorded as unlogged, so the gap is known. B20 is
the poison-pill defence: without it, one malformed mission can crash every round and take down
an entire shard, which is a total-outage failure mode from a single bad input.

### 18.4 Why no failure terminally fails a task

The audit's most operationally severe finding is that assignment failure is terminal: a cache
outage marks every task created during it `FAILED` with no queue and no retry, and a database
error during the detached assignment leaves the task `PENDING` forever with no record and no
event.

In this design, **infrastructure failure never fails customer work.** Work lives in a durable
queue. Infrastructure failure means the queue drains more slowly or not at all, with honest
ETAs and loud alerts. A task reaches `FAILED` only through the §17.4 ladder — that is, only
after the system has exhaustively tried, escalated to a human, attempted alternative
modalities, and produced an explicit, communicated decision. The distinction is between
*"we could not process this right now"* and *"this cannot be done"*, and conflating them
destroys both customer trust and operational visibility.

### 18.5 The degraded-mode register

A degraded mode is a **named, entered, exited, and recorded state of a shard**, not an
emergent condition. Naming them is what makes it possible to state, per invariant, what is
still guaranteed while one is active (§26.2) — and an invariant register that does not say
what it means during a database outage is unenforceable exactly when enforcement matters.

| Mode | Entered when | Envelope | Invariants affected | Exit |
|---|---|---|---|---|
| **Restricted Operation** | Indeterminate-rejection fraction exceeds `feasibility.systemic_indeterminacy_threshold` (§7.4) | Mission scope capped; reserves multiplied; last-known-good state admitted only with independent corroboration | None suspended — all hold | Indeterminate fraction recovers, **or** `degraded.max_duration` elapses and an operator acknowledges |
| **Custodial Operation** | Commitment Store unavailable (B1) | **No commits and no commands.** In-flight missions continue autonomously under on-agent self-supervision; intake continues queueing | **I2 suspended** (§26.2) | Store returns and full reconciliation completes |
| **Unsupervised Commitment** | Timer store unavailable or lagging beyond `supervise.max_timer_lag` (B4, §4.5) | No new hardening; reconciler sweep becomes the supervision mechanism at reduced frequency | **I4 suspended**; I2 degraded to sweep-latency granularity | Timer store recovers and the timer/state cross-audit is clean |
| **Degraded Routing** | Routing Service unavailable or partially failing (B5, B6) | `route.degraded_max_radius`; reserves × `route.degraded_reserve_factor`; only pre-surveyed corridors hardened; **uniform** degraded estimation across all candidates in a decision | None suspended; I20's reported gaps widen and are flagged | Routing recovers |
| **Cold Index** | Cache tier lost entirely (B3) | Candidate search narrower until the index warms | None — **correctness is explicitly unaffected** (§3.3, I16) | Index rebuilt from the observation log |
| **Shed Load** | Overload (B19) | Admission control by class; speculative purposes shed first (§20.5) | None suspended | Queue delay returns within budget |

Four rules govern every mode:

1. **Entry and exit are events**, written to the audit stream with cause, entering component,
   and the set of invariants suspended. Time spent in each mode is an SLI (§21.4).
2. **A suspension is explicit, scoped, and time-boxed.** No invariant is ever suspended
   implicitly by a component finding it inconvenient, and every suspension names the mode that
   authorised it.
3. **No mode may promote the cache tier to an authority** (§3.3). A mode may narrow what the
   engine attempts or suspend a *verification*; it may never redesignate where truth lives.
4. **No mode relaxes a class I or R constraint** (T3). Modes shrink the envelope; they never
   lower a safety threshold.

#### Custodial Operation, in detail

This mode replaces what would otherwise be a direct contradiction of the cache-authority rule.
Supervising in-flight missions on **cached leases** during a Commitment Store outage would mean
acting on an authority value that cannot, for the duration of the outage, be verified against
its source of truth — which is precisely what §3.3 forbids the cache tier from being used for.
Lease validity is a correctness-relevant fact, and the durable store is its only authority.

The resolution is not to find a substitute authority but to **stop needing one**:

- **No new commands are issued to any agent.** Command authority derives from a fence allocated
  in the Commitment Store; with the store unavailable no fence can be allocated, so no command
  can be authorised. The engine does not fall back to a cached fence, because a fence that
  cannot be advanced durably provides none of the protection a fence exists to provide.
- **In-flight missions continue autonomously.** The agent already holds its complete plan,
  stop sequence, reserve parameters, and target SoC from the offer (§11.2), so it does not need
  the server to proceed. It continues under its own safety envelope for at most
  `agent.autonomous_continuation_limit` (default 900 s) past its last successful lease renewal,
  then halts at the safest reachable location (§14.8) and awaits contact. **This bound is the
  safety property that replaces server-side supervision**, it is enforced on the agent rather
  than by the server, and it is therefore unaffected by any server-side outage.
- **Invariant I2 is formally suspended**, the suspension is recorded as an event, and the
  Invariant Checker reports I2 as `SUSPENDED` rather than `VIOLATED` for the duration (§26.2).
  Without this, a routine database outage would page continuously for its entire duration
  against an invariant whose target is exactly zero violations — training operators to ignore
  the one signal the register exists to produce.
- **On recovery**, the shard runs a full reconciliation before resuming rounds: agent-reported
  commitment sets are compared against the store, custody is audited, and any mission that
  exceeded its autonomy limit is routed through the ordinary recovery path (§4.7). Only then
  is I2 restored to `ENFORCED`.

### 18.6 External escalation for obstructing strandings

`STRANDED_OBSTRUCTING` (§4.3) is the one state in this design whose response chain extends
outside the operator. It therefore has its own specified path, because a chain that is
improvised during a live carriageway blockage is not a chain.

| Step | Timing | Action |
|---|---|---|
| 1 | Immediate, automatic | Page the on-call operations responder with position, obstruction class, custody manifest, agent condition, hazard state, and physical access instructions |
| 2 | Immediate, automatic | Notify every other mission routed through the affected segment; the obstacle is written to the knowledge base so the router avoids it and other agents are re-planned (§18.2 A8) |
| 3 | Immediate, automatic | Where the site or jurisdiction is configured with one, emit a machine-readable incident notification to the responsible infrastructure operator — rail, tram, highways, or site security |
| 4 | On operator confirmation | Contact emergency services where the obstruction class and hazard state meet the configured threshold. **This step is deliberately human-gated**: automatic calls to emergency services are not an appropriate output of an allocation engine, and a false positive has real external cost |
| 5 | Continuous until cleared | Re-evaluate obstruction class as position or map data changes; de-escalate to `STRANDED_SAFE` if the agent is moved clear (§4.4) |

The escalation contact set is per-region configuration with a named owner, reviewed on the same
cadence as the safety case (§24.7). An unreviewed contact list is the most common way a
correctly-designed escalation path fails in practice.

---

## 19. Distributed Architecture, Concurrency, and Consistency

### 19.1 Consistency model, stated explicitly

Different parts of the engine require different guarantees, and stating them per-component is
what prevents accidental reliance on a guarantee that does not exist.

| Concern | Model | Justification |
|---|---|---|
| Commitment exclusivity | **Strongly consistent, linearisable per agent** | Double-committing a physical machine has physical consequences. Non-negotiable |
| Task acceptance | Strongly consistent | A customer must not be told "accepted" for work that was lost |
| Custody records | Strongly consistent | Legal and physical accountability |
| Agent live state | Eventually consistent, bounded staleness | Physically impossible to have better; explicitly modelled by freshness budgets (§2.7) |
| Availability index | Eventually consistent | A stale index costs quality, never correctness, because feasibility is re-verified at commit |
| Prices, forecasts | Eventually consistent | Estimates; staleness degrades quality gracefully |
| Reliability estimates | Eventually consistent | Statistical aggregates |
| Decision records | Durable, append-only, at-least-once | Auditability, with dedupe on decision id |
| Config | Eventually consistent with version pinning | A round MUST see one consistent version, never a mixture — a partially-applied config change is a correctness hazard |

The engine is therefore **CP on the commit path and AP everywhere else**, and this asymmetry
is the central architectural choice. It is justified because the costs are asymmetric: a
delayed assignment costs seconds of service quality, while a double-assigned agent can produce
a collision, a lost parcel, or a safety incident.

### 19.2 Sharding and its scaling argument

Region-based shards (§3.5) give a concrete scaling claim:

- Per-decision work is a function of **local agent density** and **local mission rate**, not
  of global fleet size (T9).
- A fleet of 1 000 000 agents partitioned into shards of 5 000 is 200 shards, each running
  independently and in parallel. Adding agents in new regions adds shards; adding agents in an
  existing region adds density, which is bounded by the same candidate caps.
- Cross-shard coordination is required only for the small minority of genuinely inter-region
  missions (§19.6), and never in the hot path.

This is the only architecture in this design that scales to millions of agents, and the reason
is worth stating plainly: **the problem is intrinsically local, so the architecture must be too.**
Any design requiring a global view per decision — a single queue, a global optimiser, a global
lock — has a scaling ceiling set by that global component, regardless of implementation quality.

Shard rebalancing (splitting a hot shard, merging quiet ones) is an explicit, transactional
control-plane operation that migrates agents one at a time, advancing each migrated agent's
**`authority_epoch`** — the agent-scope fence (§10.3.1) — never a bulk reassignment. Migration
is precisely the case the agent-scope fence exists for: it changes who may command the agent at
all, so it must invalidate every mission authority the agent holds, which advancing
`authority_epoch` does in one action. Migration correctness then follows from guard G3
(§10.3.2): an agent migrated mid-round has a changed `authority_epoch`, so the old shard's
pending commitment fails its guard.

Shard size is bounded by the two independent resources derived in §3.5, and rebalancing is
triggered by whichever is the binding one.

### 19.3 Single-writer per shard

Exactly one **active Coordinator** per shard, chosen by leader election with a fenced lease
from a consensus-backed store.

Rationale: batch solving requires a consistent view of the shard's supply and demand.
Permitting multiple concurrent writers would mean either they contend on every agent — most
work wasted — or they partition the agents, which is just finer-grained sharding with extra
steps. A single writer per shard makes each round trivially serialisable, which in turn is
what makes determinism and replay achievable at all.

The single writer is also what makes SOFT reservations safe to hold in memory (§2.6). Exactly
one process holds the shard's plan state, so that state cannot be stale relative to a
competitor, cannot be partially observed, and needs no consistency protocol of its own. Were
there multiple writers, SOFT capacity accounting would have to be durable and shared —
which is the durable-SOFT design the shard-sizing derivation of §3.5 rules out on throughput
grounds. **Single-writer-per-shard and in-memory SOFT reservations are the same decision seen
from two directions**, and neither is separately negotiable.

Leadership itself is not left to the coordinator's own belief: guard G1 of the commit
transaction (§10.3.2) re-reads the shard's leadership fence inside the transaction and aborts if
it has advanced, so exclusivity of the writer is enforced by the database rather than inferred
from a lease the writer thinks it still holds.

The obvious objection is that a single writer is a bottleneck and an availability risk. Both
are addressed by construction:

- **Bottleneck**: shards are sized by measured round time (§3.5). The writer serialises only
  the *commit*, which is milliseconds; feasibility, cost, routing, and solving all fan out to
  stateless workers (§3.1). The serial section is small by design.
- **Availability**: warm standbys per shard; leader lease is short (`shard.lease_duration`,
  default 5 s) so failover is fast; advancing `shard.leadership_fence` on leadership change
  fences the old leader immediately — enforced at the store by guard G1 (§10.3.2) — so a slow
  or partitioned former leader cannot corrupt state even if it believes it is still leading.

### 19.4 Concurrency hazards and their resolutions

| Hazard | Resolution |
|---|---|
| Two coordinators commit the same agent | Single writer per shard; plus `FOR UPDATE` + guards G1–G6 + schema constraint as independent backstops (§10.3.2) |
| Coordinator's lease expires mid-transaction | Guard G1: the leadership fence is re-read inside the commit transaction and the commit aborts if it has advanced (§10.3.2) |
| Stale worker commits after a pause | Guards G1 and G3 fail; commit rejected |
| Stale mission command reaches an agent after that mission was reassigned | Agent rejects a fence at or below the highest seen **for that commitment id** (§10.3.1) |
| Stale command reaches an agent after quarantine, e-stop, or migration | Agent rejects a lower `authority_epoch`, and `fence_floor` invalidates every mission command issued under the superseded authority (§10.3.1) |
| Commanding one mission on a `capacity > 1` agent invalidates its other missions | Structurally impossible: fences are compared per commitment id, and ordinary commit and settlement do not touch `authority_epoch` (§10.3.1) |
| SOFT reservations lost on coordinator failover | Expected and safe: reconstructed by the new leader's reconciliation, never recovered (§2.6, §19.5) |
| Cancellation races an in-flight round | Purpose-conditioned cancellation guard in every transition (§4.6, guard G5) — blocks `PRIMARY` work, admits `custodial_purposes` |
| Duplicate intake | Client idempotency key |
| Duplicate dispatch | Outbox dedupe plus **durable** agent-side dedupe (§11.5) on `(commitment_id, sequence, fence)` |
| Agent loses its dedup state across a restart | Detected by the `dedup_state_generation` handshake at session establishment; redelivery suppressed and `authority_epoch` advanced (§11.5) |
| Lost update on agent state | Observations are append-only and ordered by per-agent sequence; derived state is computed, never blind-written |
| Two subsystems reserve the same agent | Single reservation table, one authority, F18 |
| Read-modify-write on live state | Prohibited; state is a fold over the observation log, not a mutable record — this removes the baseline's last-write-wins registry merge |
| Timer fires after state moved on | Epoch-keyed timers discarded on mismatch (§4.5) |
| Config changes mid-round | Version pinned at round start (§9.6) |
| Clock skew affects lease validity | Store clock is authoritative; skew budget embedded; fencing makes safety clock-independent (§10.6) |

### 19.5 Leadership and split-brain

- Leases come from a consensus-backed store (Raft/Paxos class). No leader election over a
  non-consensus store, which cannot provide the required guarantee under partition.
- Every shard has a monotonic **`shard.leadership_fence`**, advanced on each leadership change.
  Commitments record the fence value that produced them, **and that value is checked as guard
  G1 inside the commit transaction** (§10.3.2). Recording a fence that is never checked
  documents a decision without enforcing it; the guard is what converts leadership from a
  coordinator's belief into a database-enforced property.
- A coordinator MUST stop committing the moment it cannot renew its lease, *before* the lease
  actually expires, leaving a margin of `time.max_clock_skew` plus the store's round-trip
  budget. Stopping early narrows the window; **guard G1 closes it.** A liveness-based rule
  alone cannot establish a safety property — the commit transaction takes row locks that may
  block for an unbounded duration, so a transaction beginning inside a valid leadership window
  can commit outside it. This is the same reasoning by which §10.2 rejects a timeout-based cache
  lock as a mutual-exclusion mechanism, applied consistently to leadership.
- Advancing the shard leadership fence does **not** advance any agent's `authority_epoch`.
  Leadership change concerns which coordinator may write, not which authority the agents are
  operating under, and per-agent bumps on failover would impose an O(agents) write burst on the
  failover path for no correctness gain — guard G1 already fences the outgoing leader's writes
  at the store. The scopes are kept orthogonal on purpose (§10.3.1).

**On leadership acquisition**, the new leader runs a full reconciliation of the shard before
resuming rounds. Resuming first and reconciling later invites acting on state the previous
leader left half-written. Reconciliation has two distinct jobs, matching the two kinds of state
(§2.6):

- **Recover the durable state.** HARD commitments, leases, custody, and outbox rows survived the
  failover and are authoritative. The new leader reads them, resolves any half-written
  transition through the ordinary conditional-write discipline, and re-establishes supervision.
- **Reconstruct the volatile state.** SOFT reservations did not survive and are not expected to.
  Legs found in `PLANNED` with no HARD commitment are returned to `QUEUED` and re-planned in the
  first round. This is a *recomputation*, not a repair: the previous leader's provisional
  choices are neither known nor needed, because no agent was ever told about them and nothing
  physical depends on them. The count of Legs reconstructed this way is emitted as a failover
  metric, distinguishable from the reconciler's genuine orphan repairs (§12.4), so that an
  expected consequence of failover is never mistaken for a defect signal.

### 19.6 Cross-region missions

A mission whose stops span regions is decomposed at intake into per-region Legs joined at
**transfer points**, and orchestrated as a saga:

- Each Leg is assigned independently by its own shard, so no cross-shard distributed
  transaction is ever needed in the assignment path.
- The transfer point is a Stop in both Legs, with an explicit custody handoff and evidence.
- Legs are committed in order, with the downstream Leg pre-planned but not hardened until the
  upstream Leg's ETA is confident enough — late binding again, for the same reason.
- Compensation is explicit per step: if the downstream Leg becomes infeasible, the upstream
  Leg is redirected or held at the transfer point, with the goods in a defined, custodied
  location rather than in transit to nowhere.
- **The failure mode to design against is goods stranded at a transfer point.** A transfer
  point MUST therefore have a defined custodian — a locker, a depot, a staffed counter — and
  the saga MUST NOT release custody to an unattended location unless that location is modelled
  as a custodian with its own capacity and security properties.

---

## 20. Performance and Scalability

### 20.1 Targets

Targets are stated per shard, at the 99th percentile, under nominal (non-degraded) operation.
They are requirements for the release gate, not aspirations.

**Where a tail bounds a safety window, a p99.9 target is stated as well as a p99.** For a
system supervising physical hardware the tail is the operationally interesting part, and two
targets here bound windows rather than merely describing latency: the commit transaction's tail
bounds the leadership-fence vulnerability window (§10.3.2, guard G1), and dispatch's tail bounds
how long a commitment can exist without the agent knowing about it. Both are therefore stated
at p99.9 and both are release-gated at that percentile. Every other target is a p99 and is
labelled as such; a p99 target on a quantity that bounds a safety window would be a category
error, since the transaction that outlives its leadership window is by construction not a
typical one.

| Metric | Target | Rationale |
|---|---|---|
| Intake acknowledgement | < 50 ms | Synchronous customer path |
| Round wall-clock (500 Legs × 200 candidates) | < 250 ms | Keeps the batch window meaningful |
| Candidate generation per Leg | < 5 ms | Index lookup plus ring expansion |
| Feasibility per candidate (cached) | < 50 µs | 100 000 evaluations per round must be affordable |
| Cost per candidate (routing cached) | < 100 µs | |
| **Approach** routing matrix, 200×1, cached | < 20 ms | Origin-anchored; cell-pair cache hit rate > 95 % |
| **Return-leg** charger-reachability lookup, per candidate | < 10 µs cached, < 2 ms on miss | The *second* per-candidate routing population, required by `E_return` (§14.5). Served from the charger-reachability cache (§20.3 item 3); target hit rate > 90 % |
| Return-leg lookups per round | ≤ `m · k` bounded by the same caps as approach queries | Explicitly budgeted rather than assumed free — this is a second set of per-candidate queries, not a rounding error on the first |
| Commit transaction | < 20 ms (p99), **< 100 ms (p99.9)**, < 5 ms (mean) | Serial section. **The mean, not the p99, is what the shard-sizing bound of §3.5 consumes**; the **p99.9** is what bounds the leadership-fence exposure window (§10.3.2), because the vulnerable transaction is by definition an unusually slow one and a p99 says nothing about it |
| Serial-section utilisation `ρ` | < `commit.max_serial_utilisation` (0.25) | Derived, monitored, and the binding shard-size constraint whenever mission rate is high (§3.5) |
| Decision to dispatch | < 100 ms (p99), **< 1 s (p99.9)** | The p99.9 bounds how long a HARD commitment can exist without the agent having been told (§11.1) |
| Time from intake to offer, nominal | < 2 s | Customer-visible responsiveness |
| Detection of agent loss | < 15 s | Heartbeat interval plus margin |
| Lease expiry to recovery start | < 30 s | |
| Reconciler full sweep | < 60 s | Bounds worst-case divergence duration |
| Tier-A decision-record write | < 2 KB per decision, always retained | The compact record; sized in §21.2 |
| Tier-B decision-record write rate | ≤ `observability.tier_b_write_budget` per shard | Full-fidelity detail is sampled and budgeted, never unbounded (§21.2) |

### 20.2 Complexity

Let `n` = agents in shard, `k` = candidates evaluated per Leg, `m` = Legs per round,
`c` = cells examined, `q` = columns generated per round.

| Stage | Complexity | Note |
|---|---|---|
| Index lookup | O(c + k) | Independent of `n` — the key property (T9) |
| Feasibility | O(m · k) with O(1) cached predicates | |
| Plan and column pricing | O(q · s) for `s` stops per plan, with `q ≥ m · k` | `s` bounded by the insertion cap; `q` bounded by `plan.max_columns_per_round` |
| Routing — approach | O(m · k) queries, reduced by cell-pair caching and cluster sharing to roughly O(distinct cell pairs) | The dominant cost; cache hit rate is the critical SLI |
| Routing — return leg | A second O(m · k) population, reduced by the charger-reachability cache to roughly O(distinct destination cells) | Required by `E_return` (§14.5). Counted separately because it does **not** share the approach cache: approach queries are anchored on mission origins, which cluster heavily; return queries are anchored on projected mission-*end* positions, which do not |
| Solve — singleton regime | O(m · k · log) typical for min-cost flow with cost scaling; worst case polynomial | Integral, exact, no branching (§9.3) |
| Solve — column regime | LP relaxation over `q` columns, then branch-and-bound bounded by `solve.branch_node_budget` | Anytime; returns the incumbent with its LP bound and the residual gap in CU |
| Commit | O(m) transactions, serialised | **Bounds shard size, not merely throughput.** SOFT reservations contribute nothing here (§2.6), so this term scales with the mission rate rather than the re-planning rate — the difference between a satisfiable bound and one exceeded by more than an order of magnitude (§3.5) |

**Global fleet size appears nowhere.** That is the design's central scalability claim, and it
is testable: the same benchmark run against a shard within a 10 000-agent fleet and within a
1 000 000-agent fleet MUST produce statistically indistinguishable round times (§24.6).

### 20.3 Routing cost: the dominant term

Routing is the expensive part of any real allocator. **There are two per-candidate routing
populations, not one**, and the second is as large as the first:

- **Approach and linehaul queries**, anchored on mission origins and the stop sequence.
- **Return-leg queries** from each candidate's *projected mission-end position* to a candidate
  charger, required to evaluate `E_return` for F34/F35 (§14.5).

The second population is easy to overlook because it is implied by a feasibility constraint
rather than requested by the cost model, and it does not benefit from the first population's
caching: approach queries are anchored on mission origins, which cluster heavily around
restaurants, depots, and pickup points, whereas projected mission-end positions are
mission-specific and spread across the whole delivery surface. It therefore gets its own
mitigation and its own budget line (§20.1).

Mitigations, ordered by effectiveness:

1. **Lower-bound pruning first** (§6.4). Exact routing is requested only for the shortlist
   that survives geometric pruning. Because the bound is admissible, this preserves the
   optimality guarantee — it is pruning, not sampling. Note that `LB` deliberately requires no
   routing of either population, which is what makes it affordable to evaluate over whole cells.
2. **Cell-pair travel-time cache** for approach and linehaul, keyed `(origin_cell,
   destination_cell, mobility_profile, time_bucket)`. The cache is small relative to a
   point-pair cache because it is quantised to cells at all. **Its hit rate is a property of
   the declared spatial model (§3.6) and the deployment's traffic, and MUST be measured
   against the target stated at the end of this section rather than inferred from the cell
   size.** Within-cell error
   is bounded by the cell diameter and is corrected by an intra-cell offset term.

   *Amended 2026-09-14, `RD-2026-09-14-01` D3.* This item previously read *"Because cells are
   ~200–500 m, the cache is small relative to a point-pair cache and its hit rate is high"* —
   an **argument**, whose premise a declared spatial model may remove. The cell-pair space
   grows as the square of the cell count, so a model four to ten times finer than the generic
   scale multiplies the key space by two orders of magnitude for the same traffic, and the
   hit rate falls accordingly. The conclusion does not survive the premise, so the
   measurement replaces it. **The target is not adjusted to match what a model measures;** a
   model that misses it misses it, and that is a property of the model to be reported with
   the model.

   The **intra-cell offset is a separate quantity from the cell diameter** and is not derived
   from it. The diameter bounds *straight-line* within-cell error; the offset corrects the
   distance actually travelled, which follows the network and is never below the straight
   line. The geometric diameter is therefore a lower bound on the offset required, never the
   offset itself, and a deployment that sets one from the other has under-corrected every
   reserve computed through it.
3. **Charger-reachability cache** for the return leg, keyed
   `(destination_cell, mobility_profile, time_bucket, charger_availability_version)` and
   yielding the nearest `k` chargers with travel time and energy, ordered. The key is the
   *destination cell*, not the exact mission-end point, so it reuses the same
   cell-quantisation trick as item 2 with an intra-cell offset correction — and because there
   are far fewer chargers than delivery points, the reachable set per cell is small and stable.
   Including `charger_availability_version` in the key is what makes the entry safe to reuse:
   an entry computed against one availability projection is never silently applied under
   another, which preserves both the reserve's meaning and replay determinism (§14.5, §9.6).
   Entries are precomputed for every populated cell in the region on projection publication,
   so the steady-state path is a lookup rather than a query.
4. **Batched matrix queries.** One matrix per cell cluster shared across all Legs in that
   cluster (§6.5).
5. **Precomputed hierarchies.** Contraction hierarchies or equivalent, so a query is
   microseconds rather than milliseconds. This is the reason routing must be self-hosted
   (§5.2): the precomputation is the optimisation, and a metered request-per-query API cannot
   provide it.
6. **Congestion as a multiplier layer** on cached free-flow times, updated per time bucket per
   road class, rather than re-routing on every congestion update.
7. **Negative and result caching** for repeated identical queries within a round — common when
   many Legs share an origin such as a restaurant cluster or a depot.

Target cache hit rates in steady state: **> 95 %** for the cell-pair cache and **> 90 %** for
the charger-reachability cache. Both are reported separately and both are alertable, because a
sustained drop in either translates directly into round-time growth, and a drop confined to one
of them has a different cause and a different fix.

*Amended 2026-09-14, `RD-2026-09-14-01` D3.* These targets are **measured, not assumed**.
Where a deployment publishes a declared spatial model (§3.6), its cell-pair hit rate is
measured against a stated workload — origin clustering, destination spread, routing profiles,
time buckets, arrival rate and cache TTL, all declared with the result — and reported with
that workload, because a hit rate quoted without the workload that produced it is not a
measurement. **A model that misses the target misses it.** The target is not adjusted to the
model, and a model whose hit rate cannot be measured is reported as unverified rather than as
compliant.

### 20.4 Batching and amortisation

The engine is designed so that load *improves* efficiency rather than degrading it:
larger batches share candidate sets, share routing matrices, produce better allocations, and
amortise fixed round costs. The batch window grows with load (§9.2), which converts a
throughput problem into a slightly higher latency and a better solution — the correct
trade-off, and the opposite of a per-arrival design where load multiplies redundant work.

### 20.5 Admission control and backpressure

Every queue in the engine is bounded, and every bound has a defined overflow behaviour. An
unbounded queue is a deferred outage.

| Control | Mechanism |
|---|---|
| Per-tenant rate and concurrency quotas | Enforced at intake; a single misbehaving or compromised client cannot consume the fleet |
| Global admission | When projected queue delay exceeds an SLA class's budget, new missions of that class are declined **at intake with an honest reason**, not accepted and silently starved |
| Class-based shedding | Shed in a published order, keyed on Leg `purpose` (§2.4) first and SLA class second: `speculative_purposes` (`REPOSITION`, `EXERCISE`) shed first, then low-priority classes. **`custodial_purposes` (`RECOVERY`, `TRANSFER`) are never shed** — they discharge an obligation that already exists physically, and shedding one leaves goods stranded rather than merely unserved |
| Round-level budgets | Time budgets at every stage, anytime results (§9.4) |
| Downstream protection | Circuit breakers with half-open probing on every dependency; a failing dependency must not be hammered |
| Cost-based limits | Per-tenant routing-query budgets, so one pathological workload cannot exhaust shared routing capacity |

Declining at intake is strongly preferred to accepting and failing later: the customer can act
on an immediate decline, and the operation is not left holding work it cannot perform.

---

## 21. Observability and Explainability

### 21.1 Why this is a functional requirement

An allocation engine makes thousands of consequential, contested decisions per hour. Customers
dispute them, operators override them, safety reviews them, finance audits them, and engineers
tune them. A decision that cannot be explained after the fact cannot be defended, corrected,
or improved. Observability here is not instrumentation added to a finished system; it is part
of the deliverable.

The baseline is comparatively strong here — the audit credits per-allocation logging of
candidates, cost components, rejection reasons, and the winner. This design keeps that
property and makes it durable, structured, queryable, and replayable.

### 21.2 The Decision Record

One immutable record per decision round, per Leg. It MUST be sufficient to reconstruct any
question about the decision, and sufficient to replay it bit-identically (§9.6).

#### Why the record is two tiers

A single full-fidelity record per decision does not fit, and the arithmetic is worth stating
rather than discovering in production. At the stated caps — `candidate.max_evaluated` = 200 and
38 feasibility predicates — a fully itemised feasibility section is

```
200 candidates × 38 predicates  ≈  7 600 predicate sub-records per decision
```

each carrying result, observed value, required value, input source, and observation age. A
region processing 10 000 missions/hour with an average of two decision rounds per mission
produces

```
10 000 × 2 × 7 600  ≈  1.5 × 10⁸  predicate sub-records per hour
```

before re-planning rounds, at perhaps 60–100 bytes each: on the order of 10 TB/day per region.
That is not a storage-tuning problem; it is a design defect, and it lands hardest during
incidents, when both decision volume and the fraction of "interesting" decisions rise together.

**Tier A — the compact record. Always written, always retained in full.**

| Section | Content |
|---|---|
| Identity | Decision id, round id, shard id, `shard.leadership_fence` at round start, coordinator instance, `decision_time` |
| Versions | Code version, config version, **active regime** (§22.2), every model artefact version, map version, routing graph version, charger-availability projection version (§14.5) |
| Trigger | New arrival, re-plan, recovery, preemption, escalation step |
| Input snapshot refs | Immutable references to the agent-state, price, forecast, weather, and projection snapshots — **the inputs replay consumes** |
| Leg | Id, `purpose` (§2.4), class, tenant, SLA parameters, queue age, ladder step reached |
| Outcome | Chosen agent (or deferral), the selected column and its full Leg set, commitment id, commitment fence granted, agent `authority_epoch` observed |
| Runner-up and top-N | The runner-up with its cost delta, and the top `observability.compact_top_n` (default 5) candidates by total cost, each with its cost total and, if rejected, its binding predicate only |
| Cost totals | Every term of §8 itemised **for the chosen candidate and the runner-up**, in milli-CU |
| Rejection summary | Counts by binding predicate across the whole candidate set — the aggregate, not the per-candidate rows |
| Search and solve bounds | Cells explored, smallest unexplored lower bound, `Ω_terminal` and `Ω_policy` applied, proven search gap in CU, regime, columns generated and pruned, LP–IP gap in CU, budget-limited flags |
| Degradation | Every degraded dependency, every envelope reduction, every relaxation applied, every degraded mode active (§18.5), and **the state of every kill switch** (§22.5) — a thrown switch that is not recorded would silently break replay determinism |
| Deferral | Where the outcome was deferral: the supply event awaited, the expected improvement in CU, the projected assignment time, and the deferral deadline (§8.8) — never sampled away |
| Overrides | Any operator action, with identity, reason, and predicate waived |
| Predictions | Predicted timeline, energy, and their uncertainty bands — retained for calibration (§21.5) |

Tier A is bounded by construction — it is `O(1)` in candidate count, not `O(k · predicates)` —
and sizes to roughly 1–2 KB per decision, or ~40 MB/hour for the region above. It is retained
in full for `observability.full_retention` and in summarised form thereafter.

**Tier B — the full-fidelity record. Sampled and budgeted.**

| Section | Content |
|---|---|
| Candidate set | Every agent considered, in canonical order, with the tier at which it was discovered |
| Feasibility | Per candidate, per predicate: result, observed value, required value, input source, observation age, indeterminate policy applied |
| Costs | Per feasible candidate, every term of §8 itemised, in milli-CU, plus the total |
| Column detail | Every generated column with its full price decomposition |

Tier B is written for a decision when **any** of the following holds:

1. The decision falls in the `observability.tier_b_sample_rate` random sample (default 1 %),
   seeded deterministically from the decision id so that sampling is itself replayable.
2. The decision is on the **exemption list**: degraded, relaxed, overridden, preempted, later
   reassigned, later failed, or disputed.

**The exemption list is bounded.** This is the correction that makes the scheme survive an
incident. The exemption list is broad by design, and under a shard-wide degraded mode *every*
decision in the shard is degraded — so an unbounded exemption converts to full retention across
the entire shard at exactly the moment volume spikes hardest, which is the opposite of what a
sampling scheme is for. Therefore:

- A **shard-wide** degraded mode is recorded **once, at the mode level** (§18.5), not as a
  per-decision exemption. Only *decision-specific* degradations — this candidate's stale
  telemetry, this decision's relaxation — exempt an individual record.
- Exempt writes draw on `observability.tier_b_write_budget` per shard per minute. When the
  budget is exhausted, further exempt decisions fall back to Tier A plus a **reservoir sample**
  of Tier B that is uniform over the exempt population, and the shedding is itself recorded as
  a counted event. Retention degrades visibly and uniformly rather than by arrival order.
- Records exempted for a *later* reason — reassigned, failed, disputed — cannot be written
  retroactively if Tier B was not captured. For these the Explanation API reconstructs by
  replay, below, which yields the identical content.

#### Sampling Tier B does not weaken replay or explanation

This is the property that makes the two-tier scheme sound rather than merely cheaper, and it
follows from determinism (T6) rather than from a storage argument.

- **Replay (§9.6, invariant I10) consumes Tier A only.** Replay needs the decision's *inputs* —
  pinned snapshot references, config version, model versions, `decision_time`, seeds — all of
  which are in Tier A. Tier B contains *derived* outputs: what feasibility concluded and what
  each candidate cost. Those are exactly what replay recomputes. A record whose Tier B was
  never written is still bit-for-bit replayable.
- **Explanation (T8) is served from Tier B when present and otherwise reconstructed by replay,
  which is guaranteed to produce identical content.** The Explanation API marks which path it
  used (§21.3). T8's requirement — that the engine can answer why this agent, why not that one,
  and by what margin, from stored data — is met either way; what changes is whether the answer
  is read or deterministically recomputed. The common questions are answered from Tier A with
  no reconstruction at all, because the chosen candidate, the runner-up, the top-N, the margins,
  and the binding-predicate histogram are all retained unconditionally.
- **Aggregate SLIs never sample.** The binding-constraint distribution, near-miss margins, and
  indeterminate rates (§7.7, §21.4) are computed by **streaming aggregation at decision time**,
  before Tier B is discarded. The histograms that make the feasibility gate a capacity-planning
  instrument are therefore exact across 100 % of decisions, while the per-candidate rows behind
  them are sampled. Aggregating first and sampling second is what allows both properties to hold
  at once.

Because replay reproduces Tier B exactly, the pair (Tier A + deterministic replay) is
informationally equivalent to (Tier A + Tier B) for every decision whose inputs are retained.
Tier B is therefore a **cache of a computable function**, and sizing it is a cost-latency
trade-off rather than a fidelity trade-off. Stating it that way is what keeps a future engineer
from "optimising" retention in a way that silently breaks the audit trail.

#### Retention

| | Tier A | Tier B |
|---|---|---|
| Written for | **Every** decision | Sampled decisions plus the bounded exemption list |
| Retained in full for | `observability.full_retention` (default 30 days) | `observability.tier_b_retention` (default 30 days) |
| Thereafter | Summarised form, retained to the audit horizon | Discarded; reconstructible by replay while the input snapshots survive |
| Bounded by | `O(1)` in candidate count | `observability.tier_b_write_budget` per shard |

Input snapshots are retained at least as long as Tier A, since replay — and therefore the
reconstruction path for explanation — depends on them. A retention policy that expires a
snapshot before its Tier A record is a defect, and the Config Service validates the ordering at
publish time (§22.1 rule 5).

### 21.3 The Explanation API

Derived from the decision record, serving both humans and machines. Each answer names its
**source**: `TIER_A` (read directly), `TIER_B` (read directly), or `RECONSTRUCTED` (recomputed
by deterministic replay from the pinned input snapshot, §21.2). A `RECONSTRUCTED` answer is
byte-identical to the Tier B record that would have been written, by T6, and the API states so
alongside the result rather than presenting recomputation as though it were retrieval.

| Query | Answer | Source |
|---|---|---|
| *Why this agent?* | The cost breakdown, the runner-up, the margin, and which terms were decisive | `TIER_A` |
| *Why not agent X?* | Either the predicate that rejected it with observed-versus-required values, or its cost breakdown and the specific terms where it lost | `TIER_A` if X is in the top-N or its binding predicate is recorded; otherwise `TIER_B`/`RECONSTRUCTED` |
| *Why is this task still waiting?* | Rejection histogram across the whole candidate set, the binding constraint distribution, the current ladder step, and the projected assignment time with its basis | `TIER_A` — the histogram is aggregated at decision time and never sampled (§21.2) |
| *Why was this task deferred while a robot sat idle?* | The deferral reason record (§8.8): the supply event being waited for, the expected improvement in CU, the projected assignment time, and the deferral deadline — rendered as one sentence for the operator console | `TIER_A` — never sampled, because this is the decision most often challenged |
| *Why did this task go to a distant agent?* | The near agents' rejection reasons or cost disadvantages, itemised | `TIER_A` for the top-N; otherwise `RECONSTRUCTED` |
| *What would change this decision?* | Sensitivity analysis: the minimum change in each input that flips the outcome — computable exactly because the objective is a transparent sum | `RECONSTRUCTED` — sensitivity is a recomputation over the pinned snapshot by definition, so it is always available and never depends on what was retained |
| *What did this decision cost?* | The CU breakdown and its currency equivalent | `TIER_A` — the chosen candidate's itemised terms are retained unconditionally |
| *What actually happened?* | Realised versus predicted timeline and energy, with the deltas | `TIER_A` for the predictions, joined to settlement outcomes (§4.9, §21.5) |

The sensitivity query is only possible because the objective is an explicit additive function
of named terms. It is a direct, concrete payoff of choosing a transparent optimiser over an
opaque learned policy (T7), and it is the query operators use most.

### 21.4 Metrics

Organised by what question they answer, because a metric that answers no question will not be
looked at.

**Service quality (customer-facing SLIs)**
- Time from intake to offer, and to first movement — distributions per class and zone.
- SLA attainment per class and tenant; lateness distribution.
- Completion rate; reassignment rate; decline rate with reasons.
- ETA accuracy: signed error distribution and calibration curve.

**Allocation quality**
- Cost per mission (CU and currency), decomposed by term.
- Realised versus predicted cost.
- **Proven search gap** distribution in CU (§6.4) and **column-generation gap** distribution in
  CU (§9.3, §21.6), reported separately — they bound different approximations and a single
  combined figure would bound neither.
- Cells visited attributable to the `Ω` admissibility corrections (§6.4) — a large value means
  policy credit ceilings exceed their realised use and should be tightened.
- Fraction of decisions that were budget-limited; fraction of rounds solved in each regime.
- Deferral rate and realised benefit of deferral (did waiting actually help?).
- Preemption rate; churn rate; churn cost as a fraction of total cost.
- Counterfactual regret from the offline evaluator (§21.6).

**Fleet health and utilisation**
- Duty-cycle distribution and Gini coefficient.
- Idle time by cause: no demand, infeasible, unavailable, charging, quarantined — the *cause*
  breakdown is what makes this metric actionable rather than merely interesting.
- Energy per mission; charge-wait time; charger contention.
- Health tier distribution; quarantine rate; intervention rate per km.

**Constraint and capacity diagnostics**
- Rejection histogram by predicate, zone, class, and agent.
- Near-miss margin distributions (§7.7) — the leading indicator of an imminent capacity wall.
- Feasible-candidate count distribution; fraction of missions with zero feasible candidates.
- Indeterminate rate per predicate.

**System health**
- Round time decomposition per stage; queue depths and oldest-item ages.
- Routing cache hit rate; dependency latency and error rates; circuit-breaker states.
- Commit transaction rate, abort rate, and abort reasons.
- Outbox depth and oldest undelivered age; ACK latency; NACK rate.
- Lease expiry rate; **reconciler repair rate by category** (T10); timer-store lag.
- Time spent in each **named** degraded mode (§18.5), with entry cause and the set of
  invariants suspended; count of suspensions exceeding their mode's time box.
- Cell-pair cache hit rate **and** charger-reachability cache hit rate, reported separately
  (§20.3).
- Tier-A write rate; Tier-B write rate against `observability.tier_b_write_budget`; Tier-B
  exempt-shedding count; Explanation API answers served by source (`TIER_A` / `TIER_B` /
  `RECONSTRUCTED`).
- `dedup_state_generation` advance rate per agent class (§11.5) — a rising rate means
  non-volatile storage that is not actually durable, which is invisible in every other signal.
- Kill switches currently thrown, and time spent in any **unrehearsed combination** (§22.5).
- Active regime per region, and time since its parameter set was last calibrated (§22.2, §22.4).

**Human capacity and escalation**
- Outstanding escalations against `ops.escalation_capacity` per region, and time spent
  saturated (§17.4) — the ladder's guarantee is only as good as the capacity behind its last
  two steps.
- Ladder step distribution: how far Legs are getting before resolution, by class and zone.
- Dead-zone lease extensions granted, extensions reaching `connectivity.max_deadzone_extension`,
  and extensions not closed by a corroborated exit (§18.2 A3).
- Parameters by calibration status (`DERIVED` / `PROVISIONAL` / `UNCALIBRATED`), and count of
  Safety-class parameters not `DERIVED` — which MUST be zero in production (§22.4).

**Safety and integrity**
- Fence-rejection count, **reported separately for the two scopes** (§10.3.1): commitment-fence
  rejections and agent-authority-epoch rejections. A non-zero rate is normal during recovery; a
  rising baseline is a defect, and the two scopes fail for entirely different reasons, so a
  combined counter would hide both.
- Energy-shortfall events by tier, composed to a fleet-year rate and compared against each
  tier's budget (§14.5, invariant I17).
- Stranding events split by obstruction class, each against its own response-time target;
  `STRANDED_OBSTRUCTING` response time is a safety SLI, not an operations one (§4.3, §18.6).
- Charger-availability projection error: planned-versus-realised availability of the charger
  each `E_return` was computed against (§14.5) — the measured cost of the fixed-point-free
  approximation.
- Implausible-observation rate; verification failure rate; payload discrepancy rate.
- Invariant-violation count from the continuous checker (§26) — this MUST be zero, and any
  non-zero value is a page.

### 21.5 Prediction calibration as a first-class loop

Every prediction the engine makes — travel time, service time, energy, failure probability,
demand — is compared against its realised outcome at settlement, and the comparison is a
monitored SLI, not an offline curiosity.

This matters more than it initially appears. The cost function is only as good as its inputs,
and a miscalibrated predictor produces confidently wrong allocations that no amount of solver
correctness can fix. Systematic drift is also the earliest available signal of physical change
in the world: a route whose realised travel time has drifted 20 % above prediction indicates
roadworks, a new signal, or seasonal congestion, and detecting that automatically is
operationally valuable in its own right.

Monitored per predictor, sliced by zone, class, agent class, and time bucket:
- Bias (mean signed error) — drives coefficient refitting.
- Dispersion (error spread) — drives uncertainty band width, which drives reserves and
  `p_late`.
- Calibration of probabilistic predictions — each tier's claimed shortfall probability MUST be
  validated against realised frequency, or `α[tier]` in F34 is a fiction. Because the tier
  targets span five orders of magnitude, they are validated at different timescales and by
  different instruments: T1 from direct event counts within days, T2 from event counts over
  quarters, and T3 — whose budget is a handful of events per fleet-year — from the *predictive
  distribution's tail calibration* rather than from event counts, since waiting for T3 events to
  accumulate enough to test a rate is not a monitoring strategy. Validating a 1e-7 target by
  counting its occurrences is a category error, and the design says so rather than implying an
  event count will eventually arrive (§26 invariant I17).
- Drift alarms per slice.

### 21.6 Shadow mode and the offline evaluator

Two permanent capabilities, not temporary tooling:

- **Shadow mode.** A candidate configuration, model, or algorithm runs on live inputs in
  parallel with production, producing decisions that are recorded and never executed.
  Differences are analysed offline. This is the only safe way to change a cost coefficient in
  a system whose decisions have physical consequences, and it MUST exist before the first
  tuning change is contemplated.
- **Offline counterfactual evaluator.** Periodically re-solves recent rounds with relaxed
  bounds — larger candidate sets, wider regions, longer time budgets, perfect hindsight
  forecasts — and reports the realised gap. This is how the engine measures the cost of its own
  approximations: shard boundaries, candidate truncation, batch windows, and — measured by
  re-solving with a deliberately enlarged column set — the **column-generation gap**, which is
  the one approximation the in-round machinery cannot bound for itself (§9.3).
  Because the candidate set and all costs are logged, off-policy evaluation is possible without
  any production experiment, and designing the decision record to make this possible is a
  deliberate present-day choice on behalf of future work.

**The evaluator is a release gate, not only a periodic report, whenever column generation
changes.** The solve makes *selection* among generated columns exact while leaving *generation*
heuristic, so in practice the heuristic determines the answer: an exact solve over a poor column
set produces an exact but poor result, and no in-round signal reveals it, because the in-round
bounds cover only what was generated. The counterfactual evaluator is the sole instrument that
can measure it. Therefore any change to the column-generation heuristic — its clustering rule,
its bundle-size policy, its enumeration order, its pruning, or any learned proposer admitted
under §25.5 — MUST be gated on an evaluator run over a fixed historical corpus showing that the
column-generation gap has not widened beyond `solve.max_generation_gap_regression`. The same
gate applies to changes in `plan.max_columns_per_round` and `plan.max_bundle_size`, since a
budget change is a heuristic change in effect. Running the evaluator only on a schedule would
mean a generation regression ships, degrades allocation quality silently, and is discovered
weeks later mixed in with every other change made since.

### 21.7 Tracing and logging

- **One trace per Task**, spanning intake → queue → round → commit → dispatch → execution →
  settlement, with the agent's execution telemetry correlated by commitment id. A single trace
  answering "where did the last 40 minutes go" is worth more than any number of disconnected
  logs.
- **Structured logs only**, with decision id, commitment id, mission id, agent id, and shard id
  as mandatory fields. Free-text messages are for humans reading a specific incident, never the
  primary carrier of information.
- **Log volume discipline.** Per-candidate detail belongs in the decision record, not in the
  log stream; emitting full candidate sets to logs at fleet scale is a self-inflicted outage.
  Logs carry the round summary and anomalies.
- **Audit stream** — separate, append-only, hash-chained, longer retention: operator actions,
  overrides, config changes, quarantine decisions, constraint relaxations, manual assignments,
  cancellations. Non-repudiation matters when a decision is disputed months later.

---

## 22. Configuration and Governance

### 22.1 Requirements

1. No behavioural constant in code. Every threshold, weight, timeout, exchange rate, policy
   flag, and model reference is configuration.
2. Every parameter has: name, type, **unit**, valid range, default, scope levels, owner,
   description, change class, and blast radius.
3. Configuration is versioned, immutable once published, and referenced by version in every
   decision record.
4. A round observes exactly one config version. Partial application is prohibited.
5. Invalid configuration is rejected at publish time, not discovered at decision time. This
   includes **cross-parameter consistency**, not merely per-parameter range checks. The
   following are validated at publish and are blocking:
   - `cost.opportunity.value_horizon` > `plan.commitment_horizon` + the region's maximum
     admissible mission duration (§8.3), else the opportunity term silently saturates.
   - Every `C_policy` adjustment declares a credit ceiling, and `cost.policy.max_total_credit`
     is recomputed as their sum (§6.4, §8.6), else the candidate-pruning bound stops being
     admissible.
   - `energy.contingency_quantile` is derived as `1 − α_1`, never set independently (§14.5).
   - The shard-sizing inequality of §3.5 holds for the region's measured mission rate.
   - `agent.dedup_retention` ≥ `dispatch.offer_ttl` + `dispatch.max_delivery_delay` (§11.5),
     else a redelivered command can outlive the state that would reject it.
   - Input-snapshot retention ≥ `observability.full_retention` (§21.2), else a retained Tier A
     record becomes unreplayable and its explanation unreconstructable.
   - `cost.aging.max_multiplier` is finite (§8.7); an unbounded value is rejected rather than
     merely discouraged.
   - No zone spans two regions, and every fine cell maps to exactly one zone and at most one
     site (§3.6), else `Ω_terminal` no longer bounds the prices the shard can reach.
   - The combined nominal and degraded conservatism products do not exceed
     `energy.max_combined_conservatism` (§14.3), else independently-chosen derating factors
     compound past anyone's stated intention.
   - Every parameter carries a calibration status, and no Safety-class parameter is
     `PROVISIONAL` or `UNCALIBRATED` (§22.4).
6. **Derived parameters are computed by the Config Service, never hand-entered.** A parameter
   whose value must satisfy an identity with another parameter is a derived parameter, and
   permitting it to be set by hand permits the identity to be violated silently.

### 22.2 Scope hierarchy

Resolution is most-specific-wins, in a fixed order:

```
global → region → zone → site → agent_class → agent
                              → tenant → sla_class → mission_class
                              → time_window (scheduled overrides, including regimes)
```

**Zone is a scope level, not merely an index key.** It sits between region and site because it
is the unit prices, coverage targets, and several policy adjustments are actually keyed by
(§3.6, §8.3, §8.6). Omitting it from the hierarchy — while keying `λ_zone`,
`policy.max_zone_affinity_credit`, and the balancing triggers on it elsewhere — would leave
those values resolvable only by convention, which is how two subsystems end up disagreeing
about which zone's value applies. Site remains more specific than zone: a depot's service-time
model overrides the surrounding zone's.

Every effective value MUST be traceable to the scope level that supplied it — "why is this
threshold 34?" must have a single, immediate answer. The Config Service therefore exposes a
resolution-explain query, and the decision record stores the resolved values it actually used,
not merely the version.

Time-windowed overrides exist because operations genuinely need scheduled policy: tighter
reserves in winter, wider search radius during a known event, a stricter health tier during a
firmware rollout. Encoding these as scheduled config rather than manual intervention is both
safer and auditable.

#### Operating regimes

A **regime** is a named, pre-declared parameter set for a foreseeable operating condition that
invalidates the fleet's ordinary calibration — first snowfall, a sustained heatwave, monsoon,
a major public event. It is a time-windowed override with two additional properties: it is
**named**, so its entry and exit are events like a degraded mode's (§18.5), and it is
**forecast-triggerable**, so it can be entered on a *correct* forecast rather than discovered.

The distinction from a degraded mode matters. §18.3 handles the forecast service being
*unavailable*. Nothing there handles a forecast that is *correct* and predicts conditions under
which the calibrated coefficients are simply wrong: in the first snowfall of the season, energy
consumption, service times, travel times, and intervention rates all move together, and every
one of them moves outside the range the current coefficient set was fitted on. Left unmodelled,
this arrives as a simultaneous drift alarm on every predictor (§21.5) and as an unexplained
spike in T1 energy events — a genuine regime change presenting as a system fault.

- Each regime declares its trigger condition, its parameter deltas, its entry and exit criteria,
  and its owner. Safety-class deltas within a regime remain Safety-class changes and carry the
  same approval (§22.3).
- Entry is proposed automatically from the forecast and **confirmed by an operator**, in both
  directions. An automatic regime change on a forecast is a large, fleet-wide behavioural shift
  and belongs to a person; the automation's job is to propose it early enough to matter.
- The active regime is pinned into the round snapshot and recorded per decision (§9.6, §21.2),
  so a decision taken under a winter regime replays under it.
- Calibration is **per regime** (§22.4). A coefficient set fitted across a mixed year is wrong in
  both regimes, and the calibration status of a regime's parameter set is tracked separately.

### 22.3 Change classes

| Class | Examples | Process |
|---|---|---|
| **Hot** | Log levels, sampling rates, non-safety observability | Immediate |
| **Tuned** | Cost coefficients, batch window, candidate caps, cache TTLs | Shadow-mode evaluation, then staged rollout by shard with automatic rollback on SLI regression |
| **Policy** | SLA weights, relaxation ladder order, preemption rules, zone affinity | Ops approval, staged rollout, audit |
| **Safety** | Energy reserves, `energy.event_budget_per_fleet_year[tier]` (from which every `α[tier]` in F34 derives), payload safety factors, health-tier requirements, **any predicate enable/disable** | Safety review, two-person approval, staged rollout, mandatory post-change monitoring window; **cannot be changed by any automated process** |
| **Structural** | Shard boundaries, capacity limits, agent-class definitions | Change management with a rehearsed rollback plan |

**No automated tuner may modify a Safety-class parameter.** This is an absolute rule. An
optimiser permitted to reduce its own safety margins in pursuit of throughput will do exactly
that, and it will be locally correct every time.

### 22.4 Calibration discipline

Defaults in this document are starting points, and the process for replacing them is part of
the design:

1. **Derive, don't guess.** Exchange rates come from accounting figures: wear from replacement
   cost over rated life, energy from tariff, SLA weights from contract terms and remediation
   cost, failure cost from measured recovery expense.
2. **Validate by replay.** Replay historical demand against a candidate configuration in
   simulation; compare realised cost, SLA attainment, energy, and wear.
3. **Validate in shadow.** Run live, unexecuted, and compare decisions (§21.6).
4. **Stage by shard**, monitored against pre-declared SLI guardrails, with automatic rollback.
5. **Re-derive periodically.** Tariffs, contracts, wages, and component costs change; a
   coefficient set is a perishable artefact with a review cadence, and stale coefficients are a
   silent, gradual drift into wrong decisions.

#### Calibration has a named owner and a launch gate

Calibration is not a task that follows implementation; for a cost-based allocator it *is* a
substantial part of the work. This register holds on the order of eighty values, and a
significant number of them — zone-level price priors, failure costs by mission class and custody
state, per-class wear coefficients, and per-site-per-stop-type service-time models — require data
the fleet does not yet produce and cannot produce before it operates.

Left unowned, the predictable outcome is not a missed deadline but a loss of trust: the engine
ships with placeholder coefficients, its early decisions are indefensible when questioned,
operators begin overriding it within weeks, and the override-rate monitoring of §23.6 faithfully
reports a system nobody is using as designed — without anyone having decided that. This is
stated here because it is the most likely way this design fails in practice, and it fails for
organisational reasons rather than technical ones.

- **Ownership.** A single named **calibration owner** is accountable for the parameter register
  as a whole: for each entry's derivation, its data source, its review cadence, and its current
  status. This is a standing role, not a project task, and it is a launch prerequisite.
- **Every register entry carries a calibration status**: `DERIVED` (from a stated accounting or
  measured source), `PROVISIONAL` (a defensible placeholder, with the data it awaits named), or
  `UNCALIBRATED`. The status is published with the value and is visible in the
  resolution-explain query (§22.2).
- **The launch gate is stated per tier (§1.8).** No Tier 0 parameter — every Safety-class entry
  in Appendix A — may be `PROVISIONAL` or `UNCALIBRATED` at launch. Tier 1 and Tier 2 parameters
  may launch `PROVISIONAL`, but each must name the data it awaits and a date by which it will be
  re-derived. This is what distinguishes "we chose a starting point deliberately" from "nobody
  has looked at this."
- **A bootstrap sequence exists for values that need operating data.** Class-level and cohort
  priors are used until per-agent, per-site, or per-zone data is sufficient, with the shrinkage
  machinery of §16.3 doing the transition automatically rather than by a manual cutover. Where
  no prior can be defended, the affected mechanism starts behind its kill switch (§22.5) rather
  than starting with a guessed coefficient — an absent mechanism is honest, a fabricated
  coefficient is not.
- **A quarterly calibration review** is a standing obligation, reporting per parameter: current
  value, status, realised-versus-assumed evidence, and drift since last review. Its output is an
  input to §21.5's calibration SLIs, and a rising override rate on any predicate is a standing
  agenda item.

### 22.5 Feature flags and kill switches

Every significant capability has an independent kill switch that degrades to a simpler,
well-tested behaviour rather than to nothing:

| Capability | Kill switch degrades to |
|---|---|
| Batch solving | The same round executed with a batch of one Leg (§9.2) |
| Multi-Leg columns (bundling and consolidation) | Singleton columns only — which puts every round in the **singleton regime**, where the solve is a totally unimodular min-cost flow, integral and exact, and solver duals are exact marginal prices (§9.3). This is the most valuable kill switch in the table: it degrades to a *stronger* guarantee, not a weaker one |
| Chaining (queue depth > 1) | `capacity[agent_class] = 1`; strict one-mission-per-agent. Independent of the switch above, because queue depth lives in plan feasibility while multi-Leg structure lives in column generation (§9.3, §13.3) |
| Deferral | Immediate assignment when any feasible candidate exists |
| Preemption | Disabled entirely |
| Opportunity-cost term | `λ_zone` from configured static per-zone, per-bucket priors; the derivation of §8.3 is unchanged, only its input source is (§5.2) |
| Reposition injection | No reposition missions |
| Reliability-based gating | Cohort priors only |
| Cross-region candidacy | Region-local only |

Every kill switch is exercised in staging on a schedule. An untested kill switch is not a
control; it is a second, less well understood code path that will be invoked for the first time
during an incident.

#### Interaction and ordering

The nine independent switches above admit 512 combinations, and leaving all of them implicitly
permitted means an operator under compound-failure pressure may reach a state nobody has ever
tested. Four rules bound this to something exercisable.

1. **Every switch degrades to a Tier 1 behaviour (§1.8), so any combination is *safe*.** This is
   the property that makes the rest of these rules about quality and testing rather than about
   correctness: every switch in this table disables a Tier 2 mechanism, and no Tier 0 or Tier 1
   guarantee depends on a Tier 2 mechanism. There is no combination of these switches that can
   produce an unsafe allocation, and no switch in this table may ever be added that could.
2. **The supported set is the monotone ladder, and it is what is tested.** The switches are
   ordered by how much quality they cost, and the supported combinations are the *prefixes* of
   this order:

   ```
   reposition injection → preemption → deferral → cross-region candidacy
     → chaining (capacity > 1) → multi-Leg columns → reliability-based gating
     → batch solving → opportunity-cost term (to static priors)
   ```

   Throwing a prefix of this ladder is a rehearsed, staged, staging-exercised path. Any other
   combination is *permitted* — an operator must never be blocked from disabling a specific
   misbehaving mechanism — but is recorded as an **unrehearsed combination**, alerts as such,
   and requires an explicit acknowledgement. The distinction is between "we know exactly what
   this does" and "this is safe but untested," and conflating them is what makes an incident
   worse.
3. **Two pairs are order-dependent and are stated.** Disabling multi-Leg columns while leaving
   chaining enabled is valid and useful — queue depth lives in plan feasibility, multi-Leg
   structure in column generation (§9.3, §13.3) — but the reverse leaves column generation
   proposing bundles that plan feasibility will always reject, wasting the round's column budget.
   Chaining is therefore disabled *before* multi-Leg columns, never after. Likewise, disabling
   the opportunity-cost term last is deliberate: it is the term whose loss most changes fleet
   behaviour, and it degrades to static priors rather than to zero (§5.2).
4. **Every switch state is pinned in the decision record** (§21.2, degradation section) and is
   part of the replay input, so a decision made under a thrown switch replays under that switch.
   A switch state that is not recorded would silently break replay determinism (T6).

---

## 23. Security and Trust

### 23.1 Threat model

| Threat | Impact | Primary mitigations |
|---|---|---|
| Spoofed agent identity | Fraudulent commitments, goods theft | mTLS with per-device certificates, hardware-backed keys, short-lived tokens, attested capability (§23.2) |
| Compromised agent | Malicious acceptance, false completion, goods theft | Signed commands, epoch fencing, plausibility checks, graded verification, anomaly detection and quarantine |
| Replayed command | Duplicate or stale execution | Epoch fencing, nonces, sequence numbers, expiry on every offer (§23.3) |
| Malicious or buggy client | Fleet exhaustion, cost attack | Idempotency, per-tenant quotas, geofence validation, payload sanity limits, cost-based rate limiting |
| Insider misuse of override | Unsafe assignment, fraud | Class I/R/F non-overridable, scoped authority, reasons mandatory, two-person rule for high-risk, full audit (§23.6) |
| Tampered configuration | Systemic unsafe behaviour | Signed config versions, change classes, approval workflow, range validation, audit |
| Data exfiltration | Privacy breach | Least privilege, encryption in transit and at rest, PII minimisation and redaction in decision records |
| Denial of service | Operational outage | Admission control, quotas, circuit breakers, shard isolation |
| Poisoned learning inputs | Degraded predictions steering allocation | Outlier rejection, attribution review, bounded model influence, calibration monitoring with automatic fallback to priors |

### 23.2 Agent authentication and capability attestation

- Mutual TLS with per-device certificates, private keys in a secure element where the hardware
  provides one, automated rotation, and revocation checked at session establishment **and**
  periodically during long sessions.
- Session establishment binds `(agent_id, certificate, session_id)`; a session cannot act for
  another agent. It additionally carries the agent's **deduplication high-water mark and
  `dedup_state_generation`** (§11.5), which the server evaluates before delivering any command.
  The handshake is authenticated by the same certificate, so a reported state reset cannot be
  forged by a third party to force an `authority_epoch` advance.
- **Capabilities are never accepted from agent telemetry.** They derive from the commissioning
  record plus a signed firmware/hardware attestation. A compromised agent claiming
  `hazmat_certified` must not thereby become eligible for hazmat work; this is precisely the
  kind of privilege escalation an untyped, self-declared capability field enables.
- Pairing and commissioning are privileged control-plane operations with rate limiting and
  lockout on repeated failure.

### 23.3 Command integrity

Every command carries: its fence scope (§10.3.1), the corresponding fence value — a commitment
`fence` for a mission command, an `authority_epoch` plus `fence_floor` for an agent command —
a sequence number, `not_valid_after`, and a signature over the whole payload including the
agent id.

The agent MUST reject a command that: fails signature verification; is a **mission** command
whose `fence` is at or below the highest seen *for that commitment id*, or at or below the
current `fence_floor`; is an **agent** command whose `authority_epoch` is below the highest
authority epoch seen; duplicates an already-applied `(commitment_id, sequence)` or
`(agent_id, sequence)`; has expired; or is addressed to a different agent id. Every rejection is
reported and counted, by scope.

A mission command for an unknown commitment id is **not** admitted on the grounds that no prior
fence is recorded for it: the `fence_floor` check governs that case, which is what makes a
`STAND_DOWN_ALL` durable against a subsequently redelivered stale offer.

The `not_valid_after` field is the defence against a delayed-delivery attack — and equally
against an innocent delayed queue. A mission offer that surfaces twenty minutes late must not
be executed, because the world has moved on; an expiring offer makes that safe by default
rather than by hoping the delay never happens.

### 23.4 Authorisation

- Operator actions are gated by scoped RBAC/ABAC: region, fleet, tenant, and action class.
- Highest-privilege actions — quarantine override, safety-class config change, bulk
  cancellation, manual assignment against a Policy constraint — require elevated role plus a
  recorded reason, and where configured a second approver.
- Tenant isolation is enforced at every layer: a tenant may not observe or influence another
  tenant's missions, and shared-fleet agents are contractually gated by F4.

### 23.5 Trust boundaries for agent-reported data

Agent reports are **untrusted input** and validated before use:

| Report | Validation |
|---|---|
| Position | Kinematic plausibility against the last accepted fix; map-network consistency; corroboration where an independent signal exists. A jump exceeding achievable speed is rejected, not smoothed |
| Energy | Monotonicity except while charging; rate-of-change bounds; consistency with distance travelled and the energy model |
| Completion | Graded verification (§12.5); track plausibility; evidence corroboration |
| Health / self-report | Accepted for **restricting** the agent (an agent may always declare itself unfit) but never for **expanding** eligibility |
| Capability | Rejected entirely; see §23.2 |
| Custody events | Corroborated with compartment sensing and mass delta where available |

The asymmetry in the health row is deliberate and important: self-reported degradation is
trusted because a false positive costs one agent-shift, while self-reported fitness is not
trusted because a false positive risks an incident. This asymmetric trust rule applies to every
agent-reported field and should be the default reasoning pattern.

Persistent implausibility triggers quarantine and a security event. A compromised agent's most
valuable capability is to appear healthy and well-positioned, so plausibility checking is a
security control, not merely a data-quality one.

### 23.6 Manual override discipline

Manual intervention is necessary — operators routinely know things the engine does not — and
must be bounded. The audit shows the baseline's manual path bypasses every eligibility rule,
permitting assignment to a robot at 6 % battery or with an active fault. Here:

| Rule | Enforcement |
|---|---|
| Class I, R, and F constraints are never waivable | Enforced in the feasibility gate; there is no code path that skips it |
| Class P constraints are waivable by authorised roles | Requires identity, reason, and the specific predicate |
| Manual choice of agent among feasible agents is always permitted | Runs the standard gate with a single-candidate set |
| Every override is audited and counted | Hash-chained audit stream |
| Override rates are monitored per operator and per predicate | A high rate is a signal that a constraint is miscalibrated or that an operator needs support — both actionable, neither punitive by default |
| High-risk overrides require a second approver | Configurable per action class |

Monitoring override rates as a *design signal* is the important part. Operators overriding the
same constraint repeatedly is evidence about the constraint, and a system that treats that as
noise rather than information will keep generating the same friction indefinitely.

### 23.7 Privacy

Decision records contain addresses, recipient details, and payload descriptions. Therefore:
field-level classification, encryption at rest, least-privilege access, PII redaction in
analytical copies, retention limits distinct from (and shorter than) the operational
retention of the decision's *technical* content, and support for erasure requests without
destroying the audit trail's integrity — achieved by separating identifying fields from the
technical record and erasing only the former.

#### Erasure versus exact replay — resolved at the schema, not by assertion

Two requirements in this document are in direct tension, and stating the separation as a
principle is not enough to implement it. Privacy requires erasing personally identifying data on
request. Determinism (T6, invariant I10) requires that a stored decision replay bit-for-bit, and
replay consumes the pinned input snapshot (§21.2) — which contains addresses. Erasing a field a
decision record depends on breaks that decision's replayability, and therefore breaks the
explanation-by-reconstruction path that §21.2 relies on for unsampled decisions.

The resolution is a schema rule, and it is binding on the decision-record and snapshot schemas:

- **No decision record or input snapshot stores an identifying value directly.** Both store a
  **stable surrogate key** into a separate, access-controlled **identity store**, plus the
  *derived, non-identifying* quantities the decision actually consumed: the fine cell, the zone,
  the geofence result, the access-window class, the service-time cohort, the coordinates
  quantised to the routing graph's node. The engine's arithmetic uses only these; a street
  address is never an input to a cost term.
- **Erasure tombstones the identity record and leaves the technical record intact.** The
  surrogate key survives as an opaque token that no longer resolves to a person. Replay
  therefore still reproduces the identical allocation and identical per-candidate costs — because
  the erased fields were never inputs to them — while the erased content is genuinely
  unrecoverable.
- **What is lost after erasure is stated rather than discovered.** A replayed decision on an
  erased Task can no longer render a human-readable destination; the Explanation API returns the
  technical answer with the identifying fields marked `ERASED`. This is the correct trade and it
  is bounded, but it must be visible to whoever later reads such a record in a dispute.
- **The build gate enforces the separation.** The reconstruction-equivalence gate (§24.3) is run
  additionally over a corpus in which erasure has been applied, and MUST still reproduce Tier B
  byte-for-byte. A field whose erasure changes a replayed cost is, by that test, an identifying
  field that was wrongly admitted into the decision path — which is the defect this rule exists
  to catch, and it is caught at build rather than at the first erasure request.

---

## 24. Testing and Verification

A specification that cannot be verified is a wish. The verification strategy is therefore part
of the design.

### 24.1 Unit level

- **Constraint predicates are pure functions** of `(agent snapshot, mission, plan, config)`.
  Each is tested exhaustively at its boundaries, including all three outcomes and every
  indeterminate policy. Purity is a design requirement, not merely a testing convenience — it
  is what makes the gate reviewable by safety engineers who do not read the surrounding code.
- **Cost terms** are tested for unit correctness, monotonicity in the expected direction, and
  scale sanity (a 10 km mission must cost more than a 1 km mission, all else equal — a property
  the baseline's min-max normalisation cannot satisfy).
- **Property-based testing** for: cost monotonicity; feasibility monotonicity (relaxing a
  constraint never reduces the feasible set); packing feasibility soundness; energy-model
  conservation.
- **Lower-bound admissibility is a build gate, not a sampled property.** `LB ≤ γ` (§6.4) is
  checked exhaustively at build time over the configured parameter space — every `C_policy`
  credit ceiling, the published `λ_zone` range per region, every agent class, every SLA class —
  and the build **fails** on any combination admitting `LB > γ`. The check is re-run by the
  Config Service at every configuration publish, because admissibility is a joint property of
  code and configuration and a new policy credit can break it without any code change.

  Sampling is insufficient here for a specific reason. A violation is not merely a missed test:
  it means pruning has silently discarded cells containing the true optimum while the decision
  record advertised a *proven* optimality gap, and that false guarantee has already been written
  into production records and consumed by a first-class SLI (§21.4). A guarantee that is
  discovered to be false after being published is worse than no guarantee, so its verification
  must precede publication rather than sample it.
- **Column pricing consistency.** For every generated column, `γ(c)` recomputed from
  `Φ(plan(c)) − Φ(plan₀)` must equal the value the solver was given, exactly, in integer
  milli-CU. This is what forbids an insertion-cost shortcut from drifting away from the cost
  model (§8.1, §13.3).
- **Regime guarantee test.** A round whose generated columns are all singletons MUST be solved
  in the singleton regime and MUST report zero LP–IP gap; a round containing any multi-Leg
  column MUST NOT report exact-integer duals (§9.3). Asserting the wrong guarantee for the
  regime is a build failure, not a runtime warning.

### 24.2 State machine verification

The lifecycle and the commitment protocol are the parts where subtle concurrency defects hide.
Both are specified formally (TLA+ or an equivalent model checker) and the following properties
are model-checked:

- **Safety:** at most `capacity` HARD commitments per agent, under all interleavings including
  worker pause, leader change, partition, duplicate delivery, and message reordering.
- **Safety:** no state is both terminal and modifiable.
- **Safety:** no command authorised under a superseded authority is ever applied — checked at
  `capacity = 2` and `capacity = 3`, not only at `capacity = 1`. The model MUST include two
  concurrent commitments on one agent and MUST check that commanding, reassigning, or settling
  either one leaves the other fully commandable and fully supervised (§10.3.1, §4.5). A fencing
  model checked only at `capacity = 1` cannot exhibit the defect that fencing at `capacity > 1`
  exists to prevent, so the configuration under check is itself part of the requirement.
- **Safety:** a `STAND_DOWN_ALL` at an advanced `authority_epoch` fences every commitment the
  agent holds, including one whose offer is redelivered afterwards (§23.3).
- **Safety:** no commit succeeds under a superseded shard leadership fence, including when the
  transaction begins before and completes after the leadership change (guard G1, §10.3.2).
- **Safety:** loss of all SOFT reservations at any point leaves no Leg unaccounted for — every
  affected Leg is found by the orphan scan and requeued (§2.6, §19.5).
- **Safety:** custody is never lost — every `HELD` transitions to `RELEASED` or `DISPUTED`.
- **Liveness:** every non-terminal state eventually leaves, given fair timer firing.
- **Liveness:** every queued mission is eventually assigned, escalated, or explicitly declined.

Model checking the exclusivity protocol is proportionate: this is the property whose violation
can put two commitments on one physical machine, and it is exactly the class of property that
testing explores poorly and model checking explores exhaustively.

### 24.3 Determinism and replay

- **Golden replay corpus**: a stored set of production decision records, replayed on every
  build. Any deviation in allocation or in any cost term fails the build.
- **Continuous production replay**: a sampled fraction of live decisions is replayed
  asynchronously and compared. Divergence indicates non-determinism — an unpinned version, a
  clock read, an ordering dependency — and is a release blocker.
- **Reconstruction-equivalence gate.** For every decision in the golden corpus that has a Tier B
  record, reconstruction from Tier A alone MUST reproduce that Tier B content **byte for byte**
  (§21.2). This is the property the two-tier decision record rests on: if reconstruction can
  diverge, then sampling Tier B loses information and the explainability tenet (T8) is no longer
  satisfied for unsampled decisions. It is a build gate rather than a monitored metric, because
  a divergence discovered in production means every unsampled explanation already served was
  potentially wrong.
- **Snapshot-retention check.** A decision whose Tier A record is retained but whose input
  snapshot has expired is unreplayable and unreconstructable. The retention ordering is
  validated at config publish (§22.1) and audited continuously; a non-zero count is a defect,
  not a capacity signal.

### 24.4 Simulation

A fleet simulator is a required deliverable, not optional tooling, because most scenarios in
§18 cannot be produced on demand with physical hardware.

- Replays historical demand, and generates synthetic demand with controllable burstiness and
  spatial correlation.
- Simulates agents with realistic energy, speed, failure, and communication behaviour,
  including the nonlinear charge curve and temperature effects.
- Injects every failure in §18.2 and §18.3, individually and in combination, and drives entry
  into and exit from every named degraded mode in §18.5 — verifying that the invariant statuses
  observed match the matrix of §26.2 exactly, including that no invariant reports `VIOLATED`
  where the matrix says `SUSPENDED` or `D`.
- Runs adversarial scenarios: demand spike with a charging fleet; simultaneous multi-agent
  failure; routing outage during peak; partition during a burst; a slow tail of unresponsive
  agents; a Commitment Store outage spanning the agent autonomy limit, verifying that agents
  halt at safe locations rather than continuing indefinitely; and a stranding on a
  `BLOCKING_CRITICAL` segment, verifying the §18.6 escalation path end to end.
- Exercises the **aging-cap** property directly: a saturated shard with one heavily aged Leg
  MUST NOT sacrifice aggregate quality beyond the bound implied by `cost.aging.max_multiplier`,
  and the ladder MUST still terminate that Leg in a decision (§8.7, §17.4).
- Reports objective cost, SLA attainment, energy, wear, fairness, and invariant violations.

**The simulator itself MUST be validated against physical reality, and the validation is a
release gate on the simulator.** The simulator gates the release of the engine, so an
unvalidated simulator is a release gate that produces confidence rather than evidence — and its
characteristic failure is not randomness but *optimism*: a simulator whose agents traverse
slightly faster, consume slightly less, and fail slightly less often than real ones will
systematically approve an engine that is systematically too aggressive, and every one of its
runs will look clean.

- **Fidelity is measured per model against realised production data**, not asserted: travel
  time, service time, energy consumption, charge duration, intervention rate, disconnect rate,
  and failure rate are each compared as *distributions* — bias and dispersion, per zone, agent
  class, and time bucket — against the same realised outcomes §21.5 already collects. The
  instrument exists; this points it at the simulator.
- **The gate is one-sided, because the risk is.** Simulator bias in the pessimistic direction
  costs approvals; bias in the optimistic direction costs incidents. Bias beyond
  `sim.max_optimistic_bias` on any safety-relevant model — energy, charge, failure — **fails the
  simulator's own release gate**, and until it is fixed the simulator may not be used to
  discharge a Tier 0 verification obligation (§1.8).
- **Fidelity is re-measured on a cadence and after any fleet change** — new agent class, new
  firmware, new site, new regime (§22.2). A simulator validated once is validated against a fleet
  that no longer exists.
- **Scenarios with no real-world counterpart are labelled as such.** Most of §18's failure
  catalogue cannot be observed in production often enough to validate against, which is precisely
  why it is simulated. For those, the simulator's claim is about the *engine's response* to a
  stipulated stimulus, not about the stimulus's realism, and the distinction is recorded with the
  result so that no one later reads an unvalidatable scenario as validated.

### 24.5 Chaos and fault injection

Run continuously in a staging environment carrying production-shaped load:

- Kill coordinators, at random and at the worst moment (mid-commit).
- Partition the network, including asymmetric partitions, which break naive leader election.
- **Flush the entire cache tier under load** — the mandatory test of §3.3. No commitment may be
  lost, duplicated, or double-granted.
- Introduce dependency latency and error injection, per dependency, to the point of timeout.
- Skew clocks beyond the tolerance budget.
- Pause a worker mid-finalisation for longer than the lease duration, then resume it — the
  precise scenario the fencing mechanism exists to defeat, and therefore the test that proves it
  works.
- **Run the whole suite at `capacity[agent_class] = 2` as well as at 1.** Concurrent
  commitments on one agent are the configuration in which a fencing error is expressible, and a
  chaos suite that only ever exercises one commitment per agent cannot detect it.
- Deliver duplicate, reordered, and expired commands to simulated agents, including a command
  for one commitment interleaved with the settlement of a *different* commitment on the same
  agent — the interleaving that a single per-agent epoch handles incorrectly.
- **Kill the coordinator with SOFT reservations outstanding**, and verify that every affected
  Leg is re-planned, that none is lost, and that none is double-committed when the previous
  leader's in-flight commit lands late (guard G1).
- **Power-cycle a simulated agent mid-mission, wiping its deduplication state**, then redeliver
  every command it had already applied. The agent MUST report an advanced
  `dedup_state_generation` at session establishment, the server MUST suppress redelivery and
  advance `authority_epoch` instead of re-offering the old commitments, and no command may be
  applied twice (§11.5, invariant I21). This is the test that distinguishes at-least-once
  delivery with durable dedup from at-least-once delivery that merely claims exactly-once
  semantics.
- **Take the Commitment Store away for longer than `agent.autonomous_continuation_limit`**, and
  verify that the shard enters Custodial Operation, issues no commands, reports I2 as
  `SUSPENDED` rather than `VIOLATED`, that agents halt at safe locations at their autonomy
  limit, and that full reconciliation precedes the resumption of rounds (§18.5).

### 24.6 Scale and performance testing

- Round time versus shard size, candidate count, and batch size, measured against §20.1.
- **The locality test:** identical benchmarks against a shard in a small fleet and a shard in a
  million-agent fleet MUST produce statistically indistinguishable round times. This is the
  direct verification of T9, and its failure invalidates the scaling claim.
- Soak tests over days to expose leaks, unbounded caches, timer accumulation, and queue drift.
- Load tests through overload to verify admission control and graceful shedding rather than
  collapse.

### 24.7 Safety case

For deployments requiring it, the design supports a structured safety argument: an enumerated
hazard list, the constraints mitigating each hazard, the verification evidence for each
constraint, and the invariant monitoring proving continued satisfaction in production (§26).
Because constraints are pure functions with explicit classes, and because every decision
records which predicates were evaluated with what data, the safety evidence is a query rather
than a documentation exercise. Designing for that is much cheaper than retrofitting it.

---

## 25. Extension Points and Future Modalities

### 25.1 What makes extension possible

Three model choices carry all the extensibility, and they are cheap now and expensive later:

1. **`Agent` with a pluggable `MobilityModel`, `EnergyModel`, `ContainerModel`, and
   `CapabilityBundle`** (§2.1–2.3). New modalities supply new parameter sets, not new code
   paths in the allocator.
2. **Absolute cost in a common unit** (§1.3). Comparing a drone-second to a courier-minute is
   only meaningful in absolute units. Relative normalisation makes heterogeneous fleets
   incomparable in principle, not merely in practice.
3. **Leg-based missions with transfer points and custody** (§2.4–2.5). Multi-modal and
   multi-leg operations are already representable.

### 25.2 Per-modality requirements

| Modality | Additions required | Reuses unchanged |
|---|---|---|
| Ground robots (sidewalk, indoor) | Baseline case | Everything |
| Drones / UAS | 3D routing with airspace volumes; airspace authorisation as a hard constraint (class R); wind-dependent energy with hover cost; much tighter energy margins because reserves are safety-critical rather than convenience; weather envelope; noise and overflight restrictions; landing-site availability as a resource | Lifecycle, commitment, dispatch, cost structure, payload, reliability, observability |
| Delivery vehicles / vans | Road routing with vehicle restrictions; driver-hours regulations; multi-drop routing at larger scale; parking availability | Everything structural |
| Human couriers | Shift schedules and labour rules as hard constraints; pay-based cost converted into CU; **acceptance is genuinely voluntary**, so offer semantics need an incentive model and repeated-decline handling; no telemetry-grade observability, so freshness budgets must be far looser | Cost structure, feasibility gate, lifecycle, custody, verification |
| Fixed infrastructure (lockers, conveyors, lifts) | Modelled as **resources with capacity and queues** rather than agents; participate as constraints and as transfer-point custodians | Constraint machinery, reservation model |
| Autonomous vehicles with human fallback | Teleoperator availability as a shared, contended resource and therefore a hard constraint on missions requiring supervision | Everything else |

The human-courier row is the strongest test of the design, because a human is an agent whose
acceptance is voluntary, whose cost is a wage, whose availability follows a roster, and whose
state is poorly observed. That this design accommodates them by supplying different parameters
— rather than by adding a parallel dispatch system — is the practical justification for the
`Agent` abstraction.

### 25.3 Multi-modal and inter-campus missions

Already covered structurally (§2.4, §19.6). The extension work is:

- **Transfer-point modelling** as custodian resources with capacity, security class, dwell
  limits, and opening hours.
- **Timetable constraints** where a leg uses a scheduled service (a shuttle, a scheduled van
  run), which turns the leg's start into a discrete choice over departures rather than a
  continuous variable.
- **Joint leg optimisation**, where committing leg 2 depends on leg 1's arrival distribution.
  The late-binding mechanism of §2.6 handles this: plan both, harden leg 2 only when leg 1's
  ETA is confident.

### 25.4 Heterogeneous fleet operation

Requires nothing structural. What it requires *operationally* is discipline in per-class
parameter sets: every agent class needs its own `λ_time`, energy coefficients, wear
coefficients, reliability priors, and mobility profile. A heterogeneous fleet with copy-pasted
parameters will make confidently wrong cross-class comparisons, which is worse than not
comparing at all — so class parameter completeness MUST be a commissioning gate: an agent class
without a complete, reviewed parameter set cannot be admitted to production allocation.

### 25.5 AI-assisted optimisation — permitted and prohibited roles

Per T7, learning belongs in estimation, and the boundary is stated explicitly because it is
where this kind of system is most likely to be quietly compromised.

**Permitted (and expected):**

| Role | Use | Guardrail |
|---|---|---|
| Travel-time prediction | Replace or correct the router's estimate using historical realisations | Calibration monitored (§21.5); automatic fallback to the router's estimate on drift |
| Service-time prediction | Per site, stop type, and time | Bounded output range; fallback to cohort median |
| Energy prediction | Learned residual on the physical model | The physical model remains the base; learning corrects, never replaces — so a model failure degrades to physics, not to nothing |
| Demand forecasting | Zone-level arrival rates | Fallback to seasonal baseline |
| Failure prediction | `p_fail` and health tiering | Shrinkage priors; attribution-cleaned labels; human review of quarantine decisions above a rate threshold |
| Congestion and dwell nowcasting | Short-horizon adjustments | Bounded multipliers |
| Column generation | Propose promising multi-Leg columns for the solver to price | The Plan Builder still prices every proposal by the same `Φ` and the solver still selects exactly among them; a bad proposal costs compute, never correctness (§9.3) |

**Prohibited:**

- Emitting an assignment directly, bypassing the solver.
- Relaxing, weighting, or overriding any constraint.
- Modifying any Safety-class configuration parameter.
- Any model in the decision path without a versioned artefact, a monitored calibration, and a
  deterministic fallback.
- Unbounded output ranges on any predictor feeding a safety constraint.

**The design decision that keeps this option open:** because the decision record logs the full
candidate set with all costs and the realised outcome, the data required for off-policy
evaluation and offline reinforcement learning accumulates from day one. A future team can
evaluate a learned policy against historical decisions without running an experiment on a live
fleet. That is a deliberate present-day investment, and it costs only storage.

---

## 26. Invariants Register

### 26.1 The register

These MUST hold at all times **in nominal operation**, and their behaviour in every named
degraded mode is stated in §26.2 rather than left to inference. Each is continuously verified by
the Invariant Checker, which runs independently of the code paths that maintain them — a checker
sharing logic with the enforcer verifies nothing.

The Checker reports one of three statuses per invariant, and the third is not a euphemism for
the second:

| Status | Meaning | Response |
|---|---|---|
| `ENFORCED` | The invariant is being verified and holds | — |
| `VIOLATED` | The invariant is being verified and does **not** hold | **Page.** The violation count is an SLI whose target is exactly zero |
| `SUSPENDED` | Verification is not possible, under a named degraded mode that explicitly authorised the suspension (§18.5, §26.2) | Recorded as an event, counted, and time-boxed by the mode. **Not** a page |

Without the third status, a routine Commitment Store outage would report every active
commitment in the shard as violating I2 for the outage's entire duration, against a target of
zero — paging continuously for a condition the design already anticipates and handles. That
trains operators to ignore the register, which costs more than the outage. A suspension is
therefore explicit, authorised by a named mode, scoped to specific invariants, time-boxed, and
itself alertable if it persists beyond the mode's bound.

**Each invariant belongs to exactly one obligation tier (§1.8), and the register partitions
cleanly across them.** Tier 0 — the safety core — carries I1, I2, I4, I5, I7, I8, I9, I12, I16,
I17, I18, I19, I21, I22. Tier 1 — operational integrity — carries I3, I6, I10, I11, I13, I14,
I15. Tier 2 carries I20 alone, which governs the *claims* the quality mechanisms make and holds
whenever any of them is enabled. The partition is exhaustive by construction: an invariant that
belonged to no tier would be an obligation nobody had decided the weight of, and an invariant in
two tiers would make the staging rule ambiguous.

| # | Invariant | Enforced by | Verified by |
|---|---|---|---|
| I1 | Every agent has at most `capacity[class]` active HARD commitments | Serialised commit, `FOR UPDATE`, guards G1–G6, schema constraint (§10.3.2) | Periodic count per agent; model-checked at `capacity` 1, 2 and 3 (§24.2) |
| I2 | Every active commitment has a valid lease or is in a recovery state | Per-commitment lease renewal against the durable store, Supervisor (§12.2) | Lease audit sweep. **Suspended in Custodial Operation** (§18.5, §26.2), where lease validity cannot be verified against its authority and on-agent autonomy limits carry the safety property instead |
| I3 | Every non-terminal Leg has either an active commitment, a SOFT reservation in the leader's plan state, or a queue entry | Reconciler (§12.4); failover reconstruction (§19.5) | Orphan scan, with post-failover `PLANNED` orphans counted separately from defect orphans |
| I4 | Every non-terminal state has a pending timer keyed on **that entity's own version** | Timer registration on entry (§4.5) | Timer/state cross-audit, including a check that no timer is keyed on an agent-level counter |
| I5 | No agent applies a command carrying a superseded fence, in either scope | Two-scope fencing (§10.3.1) | Fence-rejection counters, reported per scope; neither may have a rising baseline |
| I6 | An agent's `fence_counter` and `authority_epoch` are each strictly monotonic | Single writer per shard, transactional increment | Windowed monotonicity audit against a persisted high-water mark per agent |
| I7 | An agent with a non-empty payload manifest is never returned to the available pool | Settlement ordering (§4.9), custody gate | Custody audit; **highest-severity alert on violation** |
| I8 | Custody `HELD` always has exactly one accountable agent or custodian | Custody state machine (§2.5) | Custody reconciliation |
| I9 | No committed plan violates a class I, R, or F constraint at commit time | Feasibility gate plus volatile re-check (§10.3) | Post-hoc audit of committed plans against predicates |
| I10 | Every commitment references a decision record that reproduces it | Commit writes the reference (§10.3) | Continuous replay sampling (§24.3) |
| I11 | No `PRIMARY` Leg of a cancelled Task transitions into execution, **and** a cancelled Task reaches `CANCELLED` only once every custodial Leg it spawned has settled | Purpose-conditioned cancellation guard, G5 (§4.6) | Transition audit over `PRIMARY` Legs; custody-discharge audit over `RECOVERY` and `TRANSFER` Legs. Stating it over execution alone would forbid the recovery the design mandates |
| I21 | No command is applied twice by an agent, across restarts | Durable agent-side deduplication with a generation counter, plus session-establishment handshake (§11.5); two-scope fencing (§10.3.1) | `dedup_state_generation` advance rate per agent class; duplicate-application counter must be exactly zero; chaos delivery of duplicates across a simulated agent power cycle (§24.5) |
| I22 | Every `STRANDED_*` Leg carries an obstruction classification, and no obstructing stranding is held in the ordinary operations queue | Automatic classification from map hazard data with `INDETERMINATE` resolving to `STRANDED_OBSTRUCTING` (§4.3) | Audit that every `STRANDED_*` Leg has a classification and a matching escalation path (§18.6); response-time SLI per class |
| I12 | A terminal state is never modified | Guards on terminal states | Write audit on terminal rows |
| I13 | Every queued mission is progressing through the escalation ladder or has a terminal decision | Ladder supervision (§17.4) | Queue age audit versus ladder step |
| I14 | Cost is computed only for feasible pairings | Type separation (§7.1) | Static analysis plus decision-record audit |
| I15 | Every parameter in use is resolvable to a published config version | Config Service, version pinning (§22) | Decision-record audit |
| I16 | Cache loss cannot cause commitment loss, duplication, or double-granting | Store is authoritative (§3.3) | Chaos test (§24.5) |
| I17 | Every energy-feasible commitment satisfies F34 at **all three tier confidences**, and each tier's realised fleet-year event rate stays within its budget | Feasibility gate (§14.5) | Per tier, at the appropriate timescale and instrument (§21.5): T1 by event count over days, T2 by event count over quarters, T3 by predictive-tail calibration |
| I18 | No SOFT reservation is ever persisted to the Commitment Store | Schema constraint admitting HARD commitments only (§10.3.2) | Continuous schema-constraint enforcement plus a periodic table audit; violation invalidates the shard-sizing derivation of §3.5 and is a page |
| I19 | Commanding, reassigning, or settling one commitment never invalidates another commitment on the same agent | Per-commitment fence comparison; `authority_epoch` untouched by ordinary commit and settlement (§10.3.1, §4.9) | Model-checked at `capacity ≥ 2` (§24.2); chaos suite at `capacity = 2` (§24.5); zero cross-commitment fence rejections in production |
| I20 | Every reported optimality gap is a true bound: `LB ≤ γ` holds for every evaluated pairing, and the search gap and column-generation gap are reported separately | Admissible bound with the `Ω` corrections (§6.4); build gate and publish-time recheck (§24.1) | Build gate; decision-record audit that no decision reports a combined or negative gap |

**I17 deserves note.** It is the only invariant verified *statistically* rather than
structurally, because it is a probabilistic claim — and the tiering makes its verification
tractable in a way a single blended probability never could. If realised T1 or T2 events occur
more often than their budgets predict, either the energy model is miscalibrated or the
constraint is misimplemented; both are serious, and neither is detectable without deliberately
measuring against the stated confidence. T3's budget is a handful of events per fleet-year, so it
is **not** verified by counting occurrences — at that rate an event count carries no statistical
power on any useful timescale — but by validating the predictive distribution's tail, which is
the only instrument that can speak to a rate that low before the events happen.

**I20 deserves note** for the opposite reason: it is the invariant that protects a *claim*
rather than a physical state. A miscomputed bound harms nothing in the world directly; it
corrupts the decision records, the SLIs derived from them, and every downstream argument that
cites them — including the safety case of §24.7. Its verification therefore sits at build and
publish time rather than in production, because by the time a broken bound is observable in
production it has already been asserted.

### 26.2 Invariant behaviour under degraded modes

**Every invariant states its behaviour in every named degraded mode.** An invariant register
that is silent about degraded operation is unenforceable precisely when the system is under
stress, and it forces each on-call engineer to decide in the moment whether a given alert is
real — which is the same thing as having no register.

`E` = enforced and verified normally. `S` = **suspended**, verification not possible, authorised
by that mode. `D` = enforced but verified at degraded latency or granularity, with the
degradation recorded.

| # | Restricted Operation (§7.4) | Custodial Operation (B1) | Unsupervised Commitment (B4) | Degraded Routing (B5/B6) | Cold Index (B3) | Shed Load (B19) |
|---|---|---|---|---|---|---|
| I1 exclusivity | E | E — no commits occur, so the bound holds vacuously | E | E | E | E |
| I2 lease validity | E | **S** — the only suspension in the register; on-agent autonomy limits carry the safety property (§18.5) | **D** — verified by reconciler sweep rather than timer, at sweep granularity | E | E | E |
| I3 Leg accounted for | E | E | E | E | E | E |
| I4 pending timer | E | E — no new states are entered | **S** — the timer store is the thing that failed; the sweep substitutes and its lag is the SLI | E | E | E |
| I5 no superseded fence applied | E | E — no commands are issued | E | E | E | E |
| I6 fence monotonicity | E | E | E | E | E | E |
| I7 custody before pool return | E | E — settlement halts rather than releasing | E | E | E | E |
| I8 custody accountable | E | E | E | E | E | E |
| I9 no infeasible commit | E — envelope narrowed, constraints unchanged | E — vacuous | E | E — degraded estimates are used **uniformly** and reserves widen; the predicates themselves are unchanged | E | E |
| I10 replayable decision | E | E — vacuous | E | E | E | E |
| I11 cancellation | E | **D** — cancellation is accepted and durably recorded, but resolution waits for the store | E | E | E | E |
| I12 terminal immutability | E | E | E | E | E | E |
| I13 ladder progress | E | **D** — the ladder continues to advance on elapsed budget; steps requiring a commitment queue until the store returns | E | E | E | E — shedding is itself a ladder-visible decision |
| I14 cost only for feasible | E | E | E | E | E | E |
| I15 config resolvable | E | E | E | E | E | E |
| I16 cache loss harmless | E | E | E | E | E — this mode **is** the test of I16 | E |
| I17 energy tiers | E — reserves widen | E | E | E — reserves × `route.degraded_reserve_factor` | E | E |
| I18 no durable SOFT | E | E | E | E | E | E |
| I19 no cross-commitment invalidation | E | E | E | E | E | E |
| I20 gaps are true bounds | E | E | E | **D** — bounds remain admissible; the reported gaps widen and carry a degradation flag | E | E |
| I21 no double application | E | E — no commands issued | E | E | E | E |
| I22 stranding classified | **D** — if map hazard data is indeterminate, classification resolves to `STRANDED_OBSTRUCTING` (§4.3) | E | E | **D** — same resolution when map data is stale | E | E |

Three properties of this matrix are load-bearing:

- **Exactly one invariant is ever suspended for a reason other than the failure of its own
  verification mechanism**, and that is I2 in Custodial Operation. Every other `S` is I4 under
  the failure of the timer store itself. A design that needed to suspend several unrelated
  invariants to survive a single dependency outage would be telling us the invariants were
  poorly factored.
- **No mode suspends a safety invariant.** I1, I7, I8, I9, I17, and I19 are `E` in every column.
  Degradation narrows the envelope; it never removes a guarantee about the physical world (T3).
- **Several invariants hold *vacuously* under Custodial Operation**, and the matrix says so
  rather than claiming active enforcement. An invariant that holds because the operation it
  governs is not occurring is genuinely satisfied, but it is satisfied for a reason worth
  recording — it means the guarantee returns automatically on mode exit rather than requiring
  repair.

---

## 27. Open Decisions Requiring Input

Honest specification requires stating what is not settled. Each item below changes
implementation materially and should be resolved before build, with the decision recorded as
an ADR.

| # | Decision | Options | Recommendation | Depends on |
|---|---|---|---|---|
| 1 | Spatial index primitive | H3, S2, or site-local graph zones | H3 outdoors for uniform k-ring metrics; graph zones for indoor and multi-level sites | Site mix |
| 2 | Routing engine | OSRM, Valhalla, GraphHopper, or in-house | Whichever supports per-profile contraction hierarchies and multi-modal networks; self-hosted is non-negotiable (§5.2) | Modality roadmap |
| 3 | Singleton-regime flow solver | Network simplex, cost-scaling push-relabel, or auction | Cost-scaling for its bounded-suboptimality behaviour under a time budget, which suits the anytime requirement | Batch size targets |
| 3b | Column-regime solver | Open-source MIP with a node budget, or a purpose-built branch-and-price | Start with a general MIP under `solve.branch_node_budget`; the column regime is the minority of rounds and a purpose-built solver is unwarranted until measurement says otherwise (§9.3) | Measured share of rounds in the column regime |
| 4 | Consensus store for leases | etcd, Consul, ZooKeeper, or the primary database's own primitives | Reuse an existing operated consensus store rather than adding one; do not build on a non-consensus store | Existing platform |
| 5 | Batch window defaults | 500 ms / 3 s | Requires measurement against real arrival burstiness; the trade-off is quality versus latency and cannot be settled from first principles | Demand data |
| 6 | Deferral aggressiveness | Conservative to aggressive | Start conservative; deferral is the highest-variance new behaviour and its benefit must be demonstrated in shadow mode before it is trusted | Shadow results |
| 7 | Agent queue depth (`capacity`) | 1, 2, or 3+ | Begin at 1 to preserve the baseline's strict invariant, then raise once chaining is measured; queue depth multiplies disruption cost. **This is a rollout choice, not a formulation constraint** — the solve is valid at any queue depth (§9.3) and the fencing model is correct at any queue depth (§10.3.1), so raising it later requires no redesign | Chaining evaluation |
| 8 | `energy.event_budget_per_fleet_year[tier]` (from which each `α[tier]` derives) | Per tier, per class | The tier *structure* and the defaults of §14.5 are settled and not open: T1 ≤ 1e-2, T2 ≤ 1e-5, T3 ≤ 1e-7 per mission. What remains open is each tier's **fleet-year event budget** for this operation, which requires the cost of a recovery mission and of an in-service immobilisation against the throughput cost of the reserve. A business decision, taken in composed fleet-year terms, never as a bare per-mission probability | Ops, finance, and safety |
| 9 | Verification level per mission class | L0–L3 mapping | Requires goods-value distribution and dispute-rate data | Commercial |
| 10 | Preemption enablement | On or off at launch | Off at launch; enable after the churn and fairness metrics are established, since preemption's failure mode is livelock | Post-launch metrics |
| 11 | Shard size | 1 000–20 000 agents | Determined by whichever of the two bounds of §3.5 binds first — measured round time under peak load, or the serial-commit utilisation bound at the region's measured mission rate. The stated range is the arithmetic consequence of the defaults; a high-mission-rate region will size well below it | Load tests; measured `r` per region |
| 12 | Custody evidence hardware | Sensing capability per agent class | Determines achievable verification levels and therefore which mission classes each class may serve | Hardware roadmap |
| 13 | Multi-tenancy model | Shared fleet, dedicated fleet, or hybrid | Drives F4, `C_policy`, and quota design | Commercial model |

---

## 28. Future Improvements (Version 2+)

This section records improvements that were **considered, understood, and deliberately
deferred** — not overlooked. Each is real. Each was declined for this version because it
requires redesigning a major component, introduces significant complexity for an uncertain
practical benefit, or is better decided after implementation and measurement than before.

The architecture is frozen at the end of this revision. Items here are the agreed agenda for
the next one, and each states what evidence should be gathered *during* V1 operation to decide
it well. Deferring an item is not deciding it is unimportant; it is deciding that the
information needed to design it correctly does not exist yet.

**Nothing in this section modifies the V1 architecture.**

### 28.1 Optimisation and pricing

| # | Deferred item | Why deferred | Possible future enhancement | Evidence to gather in V1 |
|---|---|---|---|---|
| V2-1 | **Exact column generation with a solved pricing subproblem** (full branch-and-price) | V1 generates columns by bounded heuristic and is explicit that the generated set is not proven to contain the optimum (§9.3). Making generation exact means a pricing subproblem solved to optimality per round and true branch-and-price — a redesign of the solve, for a gain that is currently unmeasured | Replace heuristic generation with a pricing oracle over the dual prices; keep the current heuristic as the warm start | The column-generation gap distribution from the counterfactual evaluator (§21.6). If it is consistently small, this work is unnecessary; if it is large and structured, it is the highest-value optimisation change available |
| V2-2 | **Multi-agent dynamic-programming terminal value** | `V_avail` is a finite-horizon, single-agent, myopic approximation to a cost-to-go (§8.3.3). A true multi-agent DP or an ADP with a fitted value function is a research programme, and its error is currently *bounded and measured* rather than unknown | Fitted value-function approximation over shard state, trained offline from decision records, with the current form as the fallback | Horizon-truncation and supply-response error from the calibration SLIs (§21.5), plus the dual-variable divergence in §8.3.1 |
| V2-3 | **The engine's own computational cost as a term in its own objective** | Adding a compute-cost term changes the objective and therefore every calibrated exchange rate, for a second-order effect. V1 bounds compute by budget and quota (§9.4, §20.5) rather than pricing it — a cruder instrument, but one that cannot miscalibrate the allocation | Price routing queries, solver time, and record storage in CU and admit them to `Φ`, so the optimiser trades marginal quality against marginal spend | Realised routing-query cost per decision and its dispersion; the share of decisions where extra compute changed the outcome |
| V2-4 | **Time-window and appointment scheduling as a first-class problem** | V1 treats access windows as constraints on an already-created mission (§13.2). *Choosing* a delivery window at order-creation time against projected future capacity is a materially different optimisation, upstream of this engine, and would need a capacity-promise contract between intake and the round loop | A slot-offering service consuming the engine's projected capacity, with slot commitments as a new reservation class | Forecast accuracy at the horizons a slot promise would need; realised capacity variance per zone per bucket |

### 28.2 Resource modelling

| # | Deferred item | Why deferred | Possible future enhancement | Evidence to gather in V1 |
|---|---|---|---|---|
| V2-5 | **Depot, dock, lift, and locker capacity as explicitly contended resources** | Chargers and maintenance bays are modelled as contended and reservable; loading docks, lifts, depot ingress, and lockers are not, despite frequently being the real throughput bottleneck. Modelling them properly means a general reservable-resource abstraction with queueing — a substantial addition touching planning, feasibility, and cost | Generalise the charger reservation model into a resource-reservation service covering docks, lifts, and lockers, with queue projections consumed exactly as the charger availability projection is (§14.5) | Realised dwell at depots and docks versus predicted service time (§21.5); the share of ETA error attributable to congestion at fixed infrastructure. §25.2 already names the extension point |
| V2-6 | **Fleet-level SLO derivation from per-mission targets** | V1 specifies per-mission targets only. Deriving an aggregate availability or throughput commitment — the quantity needed to answer whether a new contract can be accepted — requires a capacity model of the whole operation, which is a fleet-planning artefact rather than an allocation-engine one | A capacity model consuming §21 data, deriving contractable fleet-level SLOs and feeding intake admission thresholds | Realised per-class attainment against per-mission targets across a full seasonal cycle, with the binding-constraint distribution (§7.7) |

### 28.3 Lifecycle and operations

| # | Deferred item | Why deferred | Possible future enhancement | Evidence to gather in V1 |
|---|---|---|---|---|
| V2-7 | **Order modification and partial cancellation after custody is held** | Full cancellation with custody is handled thoroughly (§4.6). Mid-mission address changes, item additions, and recipient rescheduling each need their own re-planning semantics *while goods are aboard*, which is a new family of state transitions on the most safety-sensitive part of the lifecycle. Adding it now would enlarge the custody state machine immediately before implementation | A `MODIFY` request class resolved through the existing re-planning path, with custody-preserving transitions and evidence requirements per modification type | Frequency and type distribution of post-custody change requests reaching operations as manual interventions |
| V2-8 | **Manual and teleoperated missions as a distinct lifecycle** | V1 gates teleoperation as a reservation (F18), so an agent under teleoperation is correctly *unavailable*. What is undefined is the lifecycle, accounting, and settlement of an operator-driven mission — a parallel lifecycle, and a new one is exactly what §1.8 warns against adding late | A `TELEOPERATED` Leg purpose with its own reduced state machine, settling through the ordinary accounting path | How often teleoperated work occurs, and whether it is genuinely mission-shaped or merely recovery |
| V2-9 | **Reliability-estimator identification strategy** | V1 accepts, bounds, and measures the residual policy-feedback bias (§16.3) rather than attempting to eliminate it. A genuine identification strategy needs either randomisation in the decision path — which T1 and T7 forbid — or a natural experiment that does not exist before there is production data | Instrumental-variable or natural-experiment identification using exogenous variation (weather, closures, shard boundary changes) already present in the data | The policy-consistent versus policy-divergent divergence measured by the offline evaluator (§16.3) |

### 28.4 Commercial and pricing fairness

| # | Deferred item | Why deferred | Possible future enhancement | Evidence to gather in V1 |
|---|---|---|---|---|
| V2-10 | **Multi-tenant cost leakage through the shared `λ_zone` surface** | `λ_zone` is estimated from demand aggregated across every tenant sharing a zone (§8.3.1), so one tenant's demand raises the effective opportunity price every other tenant's work pays — a legitimate billing dispute for a tenant on a dedicated-fleet contract, and one the tenant-isolation guarantees do not currently cover. The fix is not local: per-tenant price surfaces fragment the very aggregation that makes the estimate statistically usable, and per-tenant fleets are a commercial decision (§27 item 13) rather than an engineering one | Either a tenant-attributed decomposition of `λ_zone` reported for billing transparency without changing the decision, or genuinely separate price surfaces for dedicated fleets — the choice depends on the multi-tenancy model chosen | Realised `λ_zone` decomposed by contributing tenant; the CU magnitude of the cross-tenant component; whether any dedicated-fleet contract actually shares zones. **Until this is resolved, the shared-surface behaviour MUST be disclosed in dedicated-fleet contracts** rather than left to be discovered in a dispute |

### 28.5 What is explicitly *not* deferred

Recorded to prevent relitigating settled decisions. The following were raised, were found to be
genuine defects, and are **fixed in this version** rather than deferred: the two-scope fencing
model (§10.3.1); the set-partitioning solve formulation replacing capacity-`k` min-cost flow
(§9.3); SOFT reservation durability and the shard-sizing derivation that depends on it (§2.6,
§3.5); the telescoping opportunity-cost derivation (§8.3.3); the admissible lower bound with its
`Ω` corrections (§6.4); tiered energy-shortfall budgets governed in fleet-year terms (§14.5);
the transactional leadership guard G1 (§10.3.2); Custodial Operation and the invariant × mode
matrix (§18.5, §26.2); Leg-indexed delay-cost attribution (§8.7); the capped aging multiplier
(§8.7); durable agent-side deduplication (§11.5); the two-tier decision record (§21.2); split
stranding states (§4.3); target-SoC ownership (§14.6); and the correctness core (§1.8).

---

## Appendix A — Parameter Register

Not exhaustive; it establishes the required form. **Every** behavioural constant in the
implementation MUST appear in a register entry of this shape, and a code review that finds a
behavioural constant absent from the register MUST reject the change.

| Parameter | Unit | Default | Range | Scope | Class | Owner |
|---|---|---|---|---|---|---|
| `solve.window_min` | ms | 500 | 50–5 000 | region | Tuned | Eng |
| `solve.window_max` | ms | 3 000 | 500–30 000 | region | Tuned | Eng |
| `solve.saturated_window` | ms | 10 000 | 1 000–60 000 | region | Tuned | Eng |
| `solve.max_legs_per_round` | count | 500 | 10–5 000 | shard | Tuned | Eng |
| `solve.time_budget` | ms | 250 | 50–2 000 | shard | Tuned | Eng |
| `solve.improvement_budget` | ms | 50 | 0–500 | shard | Tuned | Eng |
| `solve.branch_node_budget` | count | 5 000 | 0–200 000 | shard | Tuned | Eng |
| `solve.fast_path_classes` | set | {critical} | — | region | Policy | Ops |
| `solve.max_generation_gap_regression` | CU | 0 | 0–500 | global | Structural | Eng — release gate on column-generation changes (§21.6) |
| `sim.max_optimistic_bias` | ratio | 0.05 | 0–0.25 | global | **Safety** | Safety — one-sided simulator fidelity gate (§24.4) |
| `commit.max_serial_utilisation` (`ρ_max`) | ratio | 0.25 | 0.05–0.60 | shard | Structural | SRE |
| `candidate.target_feasible` | count | 12 | 3–100 | sla_class | Tuned | Eng |
| `candidate.max_evaluated` | count | 200 | 10–2 000 | sla_class | Tuned | Eng |
| `candidate.max_expansion_tiers` | count | 5 | 1–7 | sla_class | Tuned | Eng |
| `candidate.max_radius_by_sla_class` | m | — | — | sla_class | Policy | Ops |
| `candidate.optimality_tolerance_cu` (`Δ_opt`) | CU | 25 | 0–5 000 | sla_class | Tuned | Eng |
| `candidate.finishing_soon_horizon` | s | 300 | 0–1 800 | region | Tuned | Eng |
| `feasibility.systemic_indeterminacy_threshold` | ratio | 0.30 | 0.05–0.80 | shard | **Safety** | Safety |
| `connectivity.max_heartbeat_age` | s | 10 | 3–60 | agent_class | **Safety** | Safety |
| `connectivity.grace` | s | 20 | 5–120 | agent_class | Policy | Ops |
| `connectivity.max_deadzone_extension` | s | 300 | 30–1 800 | zone | **Safety** | Safety — caps the p95-based lease extension of §18.2 A3 |
| `localisation.max_odometry_divergence` | m | 5 | 0.5–50 | agent_class | **Safety** | Safety — F10 corroboration (§7.5) |
| `energy.event_budget_per_fleet_year[T1]` | events·yr⁻¹ | 365 000 | — | fleet | **Safety** | Safety |
| `energy.event_budget_per_fleet_year[T2]` | events·yr⁻¹ | 365 | — | fleet | **Safety** | Safety |
| `energy.event_budget_per_fleet_year[T3]` | events·yr⁻¹ | 4 | — | fleet | **Safety** | Safety |
| `energy.shortfall_probability[tier]` (`α[tier]`) | prob | **derived** (≈1e-2 / 1e-5 / 1e-7) | — | sla_class | Derived | Config Service (§14.5) |
| `energy.reserve_floor_wh` | Wh | per class | — | agent_class | **Safety** | Safety |
| `energy.contingency_quantile` | quantile | **derived** = `1 − α[T1]` | — | sla_class | Derived | Config Service (§14.5) |
| `energy.charger_availability_margin` | ratio | 1.15 | 1.0–2.0 | region | **Safety** | Safety (§14.5 staleness compensation) |
| `energy.charger_projection_max_age` | s | 120 | 10–900 | region | **Safety** | Safety |
| `energy.target_soc_max_age` | s | 300 | 30–3 600 | region | Policy | Ops (§14.6) |
| `energy.target_soc_fallback[agent_class]` | ratio | 0.80 | 0.5–1.0 | agent_class | Policy | Ops — used only when the Scheduler's published target is unavailable |
| `energy.deviation_tolerance` | ratio | 0.15 | 0.05–0.50 | agent_class | **Safety** | Safety |
| `energy.uncalibrated_reserve_factor` | ratio | 1.25 | 1.0–2.0 | agent_class | **Safety** | Safety |
| `energy.max_combined_conservatism` | ratio | 1.60 | 1.0–3.0 | agent_class | **Safety** | Safety — publish-time cap on the product of all active derating factors (§14.3) |
| `payload.safety_factor` | ratio | 0.90 | 0.5–1.0 | agent_class | **Safety** | Safety |
| `payload.packing_efficiency` | ratio | 0.75 | 0.4–1.0 | agent_class | Tuned | Eng |
| `commit.hardening_deadline` (lead time) | s | 30 | 5–300 | agent_class | Tuned | Eng |
| `dispatch.offer_ttl` | s | 20 | 5–120 | agent_class | Policy | Ops |
| `dispatch.retry_window` | s | 10 | 2–60 | region | Tuned | Eng |
| `dispatch.nack_cooloff` | s | 120 | 10–1 800 | region | Policy | Ops |
| `dispatch.systemic_threshold` | ratio | 0.20 | 0.05–0.60 | shard | Policy | SRE |
| `dispatch.max_delivery_delay` | s | 300 | 30–3 600 | region | Structural | SRE |
| `agent.dedup_retention` | s | 1 800 | ≥ `offer_ttl` + `max_delivery_delay` | agent_class | **Safety** | Safety (§11.5) |
| `agent.autonomous_continuation_limit` | s | 900 | 60–3 600 | agent_class | **Safety** | Safety — the on-agent bound that carries the safety property while I2 is suspended (§18.5) |
| `lease.duration` | s | 60 | 15–300 | agent_class | **Safety** | Safety |
| `shard.lease_duration` | s | 5 | 2–30 | global | Structural | SRE |
| `time.max_clock_skew` | ms | 500 | 50–5 000 | global | Structural | SRE |
| `supervise.stall_time` | s | 90 | 20–600 | mission_class | Policy | Ops |
| `supervise.max_timer_lag` | s | 10 | 2–60 | shard | Structural | SRE |
| `execute.eta_tolerance` | ratio | 1.30 | 1.05–3.0 | sla_class | Policy | Ops |
| `execute.start_grace` | s | 60 | 15–600 | agent_class | Policy | Ops |
| `recover.max_reassignments_per_leg` | count | 3 | 1–10 | mission_class | Policy | Ops |
| `recover.incumbent_cooloff` | s | 300 | 30–3 600 | region | Policy | Ops |
| `recover.resume_window` | s | 180 | 30–1 800 | mission_class | Policy | Ops |
| `preempt.min_gain` | CU | — | — | sla_class | Policy | Ops |
| `preempt.allowed_class_pairs` | set | — | — | region | Policy | Ops |
| `preempt.victim_immunity_period` | s | 600 | 60–3 600 | region | Policy | Ops |
| `preempt.max_per_agent_per_hour` | count | 2 | 0–20 | agent_class | Policy | Ops |
| `fairness.weight` | CU | small | — | region | Tuned | Ops |
| `fairness.horizon` | days | 7 | 1–90 | region | Tuned | Ops |
| `fairness.idle_alert_period` | h | 24 | 1–168 | region | Policy | Ops |
| `reliability.halflife_days` | days | 30 | 7–180 | global | Tuned | Eng |
| `health.unresponsive_strikes` | count | 3 | 1–10 | agent_class | Policy | Ops |
| `verify.arrival_radius` | m | 15 | 3–100 | site | Policy | Ops |
| `verify.evidence_deadline` | s | 300 | 60–3 600 | mission_class | Policy | Ops |
| `verify.track_min_fix_rate` | fixes·min⁻¹ | 2 | 0.2–60 | mission_class | Policy | Ops (§12.5 plausibility test 1) |
| `verify.track_min_corridor_fraction` | ratio | 0.85 | 0.5–1.0 | mission_class | Policy | Ops (§12.5 test 2) |
| `verify.track_max_gap` | s | 120 | 10–1 800 | mission_class | Policy | Ops (§12.5 test 3) |
| `assign.max_deferral_time` | s | — | — | sla_class | Policy | Ops |
| `assign.max_consecutive_deferrals` | count | 5 | 1–50 | sla_class | Policy | Ops |
| `plan.max_bundle_size` (Legs per column) | count | 4 | 1–20 | mission_class | Tuned | Eng |
| `plan.max_columns_per_round` | count | 2 000 | 100–50 000 | shard | Tuned | Eng |
| `plan.max_exhaustive_stops` | count | 8 | 2–15 | agent_class | Tuned | Eng |
| `plan.commitment_horizon` | s | 900 | 60–7 200 | agent_class | Tuned | Ops |
| `capacity[agent_class]` (queue depth) | count | 1 | 1–5 | agent_class | Structural | Eng + Ops |
| `route.degraded_max_radius` | m | — | — | region | **Safety** | Safety |
| `route.degraded_reserve_factor` | ratio | 1.40 | 1.0–3.0 | region | **Safety** | Safety |
| `degraded.max_duration` | s | 900 | 60–7 200 | shard | **Safety** | Safety |
| `degraded.max_last_known_age` | s | 60 | 10–600 | shard | **Safety** | Safety |
| `ops.stranded_safe_response_target` | h | 4 | 0.25–24 | region | Policy | Ops |
| `ops.stranded_restrictive_response_target` | min | 45 | 5–480 | region | Policy | Ops |
| `ops.stranded_obstructing_response_target` | min | 10 | 2–60 | region | **Safety** | Safety (§4.3, §18.6) |
| `ops.suspension_review_period` | s | 3 600 | 300–86 400 | region | Policy | Ops |
| `ops.escalation_capacity` | concurrent | — | — | region | Policy | Ops — ladder steps 7–8 capacity (§17.4) |
| `ops.escalation_saturation_period` | s | 600 | 60–7 200 | region | Policy | Ops (§17.4) |
| `observability.full_retention` | days | 30 | 7–730 | global | Policy | Eng |
| `observability.compact_top_n` | count | 5 | 1–25 | region | Tuned | Eng (§21.2 Tier A) |
| `observability.tier_b_sample_rate` | ratio | 0.01 | 0–1.0 | region | Tuned | Eng |
| `observability.tier_b_retention` | days | 30 | 1–730 | global | Policy | Eng |
| `observability.tier_b_write_budget` | records·min⁻¹ | 5 000 | 100–500 000 | shard | Tuned | SRE — bounds the exemption list so shard-wide degradation cannot force full retention (§21.2) |

*(Cost-function exchange rates are registered separately in §8.10.)*

## Appendix B — Glossary

| Term | Definition |
|---|---|
| **Agent** | Any entity that can be committed to work: ground robot, drone, vehicle, human courier |
| **CU** | Cost unit; one second of committed reference-agent time (§1.3) |
| **Custody** | Physical possession of goods (§2.5) |
| **`authority_epoch`** | Agent-scope fencing token; governs agent-level commands. Compared as a single highest-seen value (§10.3.1) |
| **`fence`** | Commitment-scope fencing token; governs mission-level commands. Compared **per commitment id**, never as a maximum across an agent's concurrent commitments (§10.3.1) |
| **`fence_floor`** | Value carried by an agent-scope command that invalidates every commitment-scope authority the agent holds (§10.3.1) |
| **`shard.leadership_fence`** | Per-shard token advanced on leadership change and checked inside the commit transaction as guard G1 (§10.3.2, §19.5) |
| **Column** | One agent, a set of pending Legs, and a complete plan inserting them into that agent's committed sequence; the unit of proposal in the solve, priced at its marginal cost (§1.4, §9.3) |
| **Singleton / column regime** | Whether a round's columns all cover one Leg (integral, exact, min-cost flow) or some cover several (set partitioning, branch-and-bound) (§9.3) |
| **Leg** | Contiguous stop sequence executed by one agent under one commitment; the unit of assignment **and the decision index of the objective** (§2.4, §1.4) |
| **Mission** | Ordered set of Legs discharging one or more Tasks |
| **Terminal Leg** | The Leg whose completion determines its Mission's completion; carries the Mission's full delay-cost term (§8.7) |
| **Task** | Customer-visible unit of work with an SLA contract |
| **SOFT reservation / HARD commitment** | Round-local, in-memory, never persisted, no physical effect — versus durable, fenced, leased, and dispatched (§2.6) |
| **`Φ`** | The plan-level cost functional; a column's price is its difference at two plans (§8.1) |
| **`LB`** | Admissible lower bound on a column's cost, used for pruning; includes the `Ω` corrections for negative-capable terms (§6.4) |
| **`Ω_terminal`, `Ω_policy`** | Computable upper bounds on the negative contributions of `C_opportunity` and `C_policy`, subtracted to keep `LB` admissible (§6.4) |
| **`λ_zone`** | Availability value density: marginal value of one more available agent in a zone, in CU·s⁻¹ — the single calibrated primitive of the opportunity model (§8.3.1) |
| **`V_avail`, `V_terminal`** | The integral of `λ_zone` from a time to the valuation horizon, and that value less the state's charge-access and SoC-deficit costs. Carries no free weighting coefficients (§8.3.2) |
| **Shortfall tier (T1/T2/T3)** | Contingency consumed, return reserve breached, hardware floor reached in service — three events with separate probability budgets (§14.5) |
| **`κ(a)`** | Per-agent energy efficiency multiplier (§14.2) |
| **SoH** | State of health — usable capacity relative to nominal (§14.3) |
| **Restricted Operation** | Degraded mode entered on systemic indeterminacy (§7.4) |
| **Custodial Operation** | Degraded mode entered on Commitment Store loss: no commits, no commands, in-flight missions autonomous, I2 explicitly suspended (§18.5) |
| **Degraded-mode register** | The named set of degraded modes, each with entry, envelope, suspended invariants, and exit (§18.5) |
| **`SUSPENDED`** | Invariant-checker status meaning verification is impossible under an authorising named mode — distinct from `VIOLATED` (§26.1) |
| **Leg `purpose`** | First-class attribute distinguishing `PRIMARY`, `RECOVERY`, `TRANSFER`, `REPOSITION`, `EXERCISE`, `MAINTENANCE_TRANSIT` (§2.4) |
| **`custodial_purposes`** | `{RECOVERY, TRANSFER}` — exempt from the cancellation guard, never preemptible, never shed (§2.4) |
| **Obstruction class** | Map classification of a location as `CLEAR` / `RESTRICTIVE` / `BLOCKING_CRITICAL`; determines the stranding state (§4.3) |
| **Tier A / Tier B decision record** | The always-retained compact record versus the sampled full-fidelity record; Tier B is reconstructible from Tier A by replay (§21.2) |
| **Charger availability projection** | Versioned snapshot from the Charging Scheduler that breaks the `E_return` circularity (§14.5) |
| **`dedup_state_generation`** | Agent-side counter that makes a deduplication-state reset detectable at session establishment (§11.5) |
| **Envelope reduction** | Narrowing what the engine attempts, in place of relaxing safety (T3) |
| **Reconciler** | Control loop repairing desired-versus-actual divergence (§12.4) |
| **Indeterminate** | A constraint that could not be evaluated (§7.3) |
| **Tier 0 / Tier 1 / Tier 2** | Obligation tiers: safety core, operational integrity, allocation quality. No Tier 0 or Tier 1 guarantee may depend on a Tier 2 mechanism (§1.8) |
| **Region / zone / site / cell** | Shard boundary ⊃ pricing unit ⊃ index cell, with site orthogonal to zone; containment is by published assignment, never query-time geometry (§3.6) |
| **Regime** | A named, forecast-triggerable, operator-confirmed parameter set for a foreseeable condition that invalidates ordinary calibration — snowfall, heatwave, a major event (§22.2) |
| **`custody_transfer_capable`** | Agent capability, **default false**, gating whether agent-to-agent physical custody transfer is possible at all; absent it, transfer is human-mediated (§2.3, §4.7) |
| **Calibration status** | `DERIVED` / `PROVISIONAL` / `UNCALIBRATED`, published with every parameter; no Safety-class parameter may launch other than `DERIVED` (§22.4) |
| **Surrogate key** | The opaque identity-store reference held by decision records and input snapshots in place of identifying values, so that erasure and exact replay can both hold (§23.7) |

## Appendix C — Architecture Decision Summary

| ADR | Decision | Chosen | Rejected | Section |
|---|---|---|---|---|
| 01 | Cost representation | Absolute additive CU with dimensioned exchange rates | Min-max normalised weighted sum | §1.3 |
| 02 | Decision granularity | Rolling-horizon batch, indexed over Legs, with the fast path as a batch of one | Per-arrival greedy; full-horizon global optimisation; indexing the objective over Missions | §9.1, §1.4 |
| 02b | Solve formulation | Set partitioning over marginally-priced columns, one column per agent per round; degenerates to an integral min-cost flow in the singleton regime | Capacity-`k` min-cost flow, whose arc costs are not separable once an agent holds two Legs | §9.3 |
| 02c | Opportunity cost | One primitive (`λ_zone`), integrated over the **origin** zone for unavailability plus a same-time terminal-value difference for relocation — an exact telescoping decomposition | Adding a route-domain shadow-price integral to an independently estimated cost-to-go difference, which double-counts and integrates over a domain with no physical meaning | §8.3 |
| 02d | Optimality tolerance | Additive, in CU, reported as two separate gaps | A multiplicative ratio, undefined once costs can be negative | §6.4, §9.3 |
| 09b | Energy shortfall targets | Three consequence tiers, governed as fleet-year event budgets, with per-mission `α` derived | A single per-mission probability covering outcomes whose consequences differ by orders of magnitude | §14.5 |
| 03 | Deferral | Priced arc in the optimisation | Terminal failure; unbounded retry | §8.8 |
| 04 | Exclusivity | Durable conditional write plus two-scope fencing: agent `authority_epoch` and per-commitment `fence` | Cache lock as the guarantee; a single per-agent epoch for both scopes, which is incorrect at `capacity > 1` | §10.3 |
| 04b | Leadership enforcement | Leadership fence re-read and checked inside the commit transaction (guard G1) | A coordinator's own lease-renewal check as the sole protection | §10.3.2, §19.5 |
| 04c | SOFT reservation durability | Round-local in coordinator memory; reconstructed on failover; schema-forbidden in the store | Durable SOFT commitments, which exceed the shard's serial-commit budget by more than an order of magnitude | §2.6, §3.5 |
| 05 | Dispatch reliability | Transactional outbox with mandatory ACK/NACK | Fire-and-forget emit | §11.1 |
| 06 | Missing-data policy | Three-valued logic with per-predicate policy plus systemic guard | Fail-open; blanket fail-closed | §7.3–7.4 |
| 07 | Lifecycle supervision | Durable timers plus a continuous reconciler | Per-defect patches; in-process timers | §4.5, §12 |
| 08 | Candidate search | Hierarchical with admissible lower-bound pruning | Fixed radius; unordered row limit | §6.4 |
| 09 | Battery feasibility | Probabilistic Wh model with layered reserves | Instantaneous percentage floor | §14.5 |
| 10 | Concurrency control | Single writer per shard, serialisable commit | Multi-writer with optimistic retry | §19.3 |
| 11 | Routing | Self-hosted with precomputed hierarchies | Metered external API in the hot path | §5.2, §20.3 |
| 12 | Scaling strategy | Region sharding exploiting locality | Global queue or global optimiser | §19.2 |
| 13 | Fairness | Priced wear plus a small duty-cycle regulariser | Large explicit fairness weight | §17.1 |
| 14 | Learning boundary | Learning in estimation; classical solver for decisions | Learned end-to-end policy | §25.5 |
| 15 | Payload model | Compartment model with tiered packing feasibility | Scalar capacity | §15.2–15.3 |
| 16 | Recovery semantics | Custody-aware: reassign, transfer, or physical recovery | Uniform requeue | §4.7 |
| 17 | Completion trust | Graded verification with plausibility checking | Trusted agent assertion | §12.5 |
| 18 | Leg purpose | First-class `purpose` attribute driving the cancellation exemption, preemption bar, and shed order | An implicit "is this a recovery?" test reinvented at each call site | §2.4, §4.6 |
| 19 | Anti-starvation | Structural guarantee from the escalation ladder; aging multiplier capped | Unbounded aging multiplier as the primary mechanism, which lets one aged Leg dominate a batch objective | §8.7, §17.4 |
| 20 | Degraded operation | Named degraded-mode register plus a full invariant × mode matrix, with `SUSPENDED` as a first-class checker status | Cached-lease supervision, which would make the cache an authority and page continuously against I2 | §18.5, §26.2 |
| 21 | `E_return` availability | Pinned previous-round charger availability projection with a stated conservatism margin | Live availability, which is circular and non-replayable; or nearest-geographic charger, which reintroduces stranding risk | §14.5 |
| 22 | Target SoC ownership | Charging Scheduler owns and publishes; the engine consumes it and may submit priced requests | Engine-computed target, which duplicates the Scheduler's optimisation and desynchronises from it | §14.6, §14.7 |
| 23 | Agent deduplication | Durable across restart, with a generation counter and a session-establishment handshake | In-memory dedup, which makes at-least-once delivery re-execute after a routine power cycle | §11.5 |
| 24 | Decision-record volume | Two tiers: bounded always-on Tier A, sampled and budgeted Tier B, reconstructible by replay | Full-fidelity per-candidate retention for every decision, ~10 TB/day/region | §21.2 |
| 25 | Stranding severity | `STRANDED_SAFE` / `STRANDED_OBSTRUCTING`, classified automatically from map hazard data | One stranded state and one response target for both a car park and a tram line | §4.3, §18.6 |
| 26 | Obligation tiering | An explicit correctness core: Tier 0 safety, Tier 1 operational integrity, Tier 2 quality, with no Tier 0/1 guarantee depending on a Tier 2 mechanism | Presenting every mechanism at one level of obligation, which guarantees a self-selected partial implementation | §1.8 |
| 27 | Command emission | Every external side effect emitted only via an outbox row written in the same transaction as the guarded write authorising it — for the reconciler and supervisor, not only for dispatch | Bumping a fence and separately issuing the command, which produces duplicate stand-downs and commands carrying authority that does not exist | §4.1 rule 5, §12.4 |
| 28 | Spatial hierarchy | Region ⊃ zone ⊃ cell, with site orthogonal to zone; containment by published assignment, not by query-time geometry; zone admitted to the config scope hierarchy | Four spatial units with unstated containment, and the pricing unit absent from the hierarchy that resolves it | §3.6, §22.2 |
| 29 | Human escalation | Modelled capacity, triage order, and rate limiting on ladder steps 7–8, with saturation as its own escalation | An escalation path assuming it is reached one Leg at a time, which fails exactly under systemic failure | §17.4 |
| 30 | Erasure versus replay | Identifying values held only in a separate identity store behind a stable surrogate key; erasure tombstones the identity and leaves the technical record replayable; enforced by a build gate over an erased corpus | Asserting the separation as a principle and leaving the decision-record schema to interpret it | §23.7, §24.3 |
| 31 | Simulator trust | One-sided fidelity gate on the simulator itself, measured per model against realised production distributions | A release gate that is itself unvalidated, whose characteristic failure is systematic optimism | §24.4 |
| 32 | Conservatism | Every derating factor declares the uncertainty it compensates; the Config Service publishes the combined product and rejects it beyond a stated cap | Independently-chosen margins compounding invisibly to a fleet-wide conservatism nobody chose | §14.3 |

---

## Appendix D — Review Disposition

Every finding of `NEXT_GENERATION_ASSIGNMENT_ENGINE_REVIEW.md`, and what this revision did with
it. `IMPLEMENTED` means the architecture changed and the change is in this document.
`DEFERRED` means the finding is recorded in §28 and the architecture is unchanged. This table is
the audit trail for the final pre-implementation revision; the architecture is frozen after it.

### Critical (P0) — all implemented

| Finding | Decision | Where | Reason |
|---|---|---|---|
| P0-1 Per-agent fencing epoch incompatible with `capacity > 1` | **IMPLEMENTED** | §10.3.1, §4.5, §4.4, §12.2, §19.4, I5/I19 | Correctness. A `capacity > 1` agent became uncommandable after its second commitment — the design's steady state. Split into agent-scope `authority_epoch` and per-commitment `fence`, with a normative command-class-to-scope table; timers rekeyed to each entity's own version |
| P0-2 Min-cost flow invalid for `capacity > 1` | **IMPLEMENTED** | §1.4, §9.3, §13.3 | Correctness. Arc costs are not separable once an agent holds two Legs. Reformulated as set partitioning over marginally-priced columns, one column per agent; min-cost flow retained as the *specialisation* for the singleton regime, where it is integral and exact |
| P0-3 SOFT commitment durability unspecified | **IMPLEMENTED** | §2.6, §3.5, §19.3, I18 | Ambiguity with a 20× throughput consequence. SOFT is round-local coordinator state, never persisted, schema-forbidden; shard sizing re-derived from `k_txn ≈ 2.05` with SOFT contributing zero |
| P0-4 `C_opportunity` double-counts and integrates over the wrong domain | **IMPLEMENTED** | §8.3 | Correctness. Rederived as one telescoping identity from a single primitive `λ_zone`: unavailability integrated over the **origin** zone, plus a same-time terminal-value difference for relocation. Cannot double-count by construction |
| P0-5 Lower bound not admissible | **IMPLEMENTED** | §6.4, §8.6, §24.1, I20 | Correctness. `Ω_terminal` and `Ω_policy` bound the negative-capable terms; `Ω_policy` derived at publish time from declared credit ceilings; admissibility is a build gate, not a sampled property |
| P0-6 `α = 1e-3` wrong by orders of magnitude | **IMPLEMENTED** | §14.5, §8.4, §21.5, §27 item 8, I17 | Safety. Three consequence tiers with separate targets, governed as fleet-year event budgets from which per-mission `α` is derived; contingency quantile derived from `α₁` rather than set independently |

### High priority (P1) — all implemented

| Finding | Decision | Where | Reason |
|---|---|---|---|
| P1-1 Leadership not enforced transactionally | **IMPLEMENTED** | §10.3.2 guard G1, §19.5, §19.4 | Distributed-systems correctness. The leadership fence is re-read inside the commit transaction; a liveness rule cannot establish a safety property |
| P1-2 Cached-lease supervision contradicts the cache-authority rule | **IMPLEMENTED** | §18.5 Custodial Operation, §12.2, §26.2 | Correctness and operability. No commits, no commands, agents autonomous to their own bound; I2 explicitly `SUSPENDED`, not `VIOLATED` |
| P1-3 Objective indexed over Missions, assignment over Legs | **IMPLEMENTED** | §1.4, §8.7, §2.4 | Ambiguity that miscalibrates every exchange rate. Leg is the sole decision index; terminal Leg carries the full delay term, upstream Legs a slack-consumption term |
| P1-4 Cancellation guard blocks its own recovery path | **IMPLEMENTED** | §2.4 `purpose`, §4.6, guard G5 | Correctness. Guard conditioned on `purpose ∈ custodial_purposes`; `purpose` made a first-class immutable Leg attribute rather than an ad-hoc exemption |
| P1-5 Unbounded aging multiplier | **IMPLEMENTED** | §8.7, §17.4, §22.1, §24.4 | Correctness of batch optimisation. Capped; anti-starvation restated as structurally guaranteed by the ladder |
| P1-6 `E_return` circular; return-leg routing unbudgeted | **IMPLEMENTED** | §14.5, §9.6, §20.1, §20.3 | Correctness and performance. Pinned previous-round charger availability projection with a stated margin; return-leg queries given their own budget line and cache |
| P1-7 Agent-side dedup not durable | **IMPLEMENTED** | §11.5, §23.2, §18.2 A20, I21 | Correctness. Durable dedup state, generation counter, session-establishment handshake; on reset, suppress redelivery and advance `authority_epoch` |
| P1-8 Decision-record volume unsized | **IMPLEMENTED** | §21.2, §7.7, §20.1, §18.3 B16 | Feasibility. Two tiers with the arithmetic stated; exemption list bounded; aggregate SLIs computed before sampling so they stay exact |
| P1-9 `STRANDED` conflates hazard with inconvenience | **IMPLEMENTED** | §4.3, §18.6, I22 | Safety. Split by map obstruction class, `INDETERMINATE` resolving to the more serious case; separate response targets and an external escalation chain |
| P1-10 Target-SoC ownership unassigned | **IMPLEMENTED** | §14.6, §14.7, §1.6 | Ambiguity between two teams. Charging Scheduler owns and publishes; the engine consumes it and may submit priced, refusable requests |

### Medium (P2)

| Finding | Decision | Where | Reason |
|---|---|---|---|
| P2-1 Solver duals not valid prices under bundling | **IMPLEMENTED** | §8.3.1, §9.3 | Regime is recorded per round; duals are exact only in the singleton regime, and calibration must restrict itself or record the LP–IP gap |
| P2-2 Agent-to-agent custody transfer assumes absent hardware | **IMPLEMENTED** | §2.3, §4.7 | Correctness of recovery. `custody_transfer_capable`, default false; transfer is human-mediated by default, and F21 rejects the impossible pairing |
| P2-3 Localisation confidence self-reported by the failing subsystem | **IMPLEMENTED** | §7.5 F10 | Safety. F10 now requires independent corroboration; corroboration unavailable is `INDETERMINATE`, not satisfied |
| P2-4 Cold-chain compartment load missing from the energy model | **IMPLEMENTED** | §14.2, §15.5 | Safety. `β_payload_thermal` per compartment over occupied time; the omission was correlated with the longest missions |
| P2-5 Dead-zone lease extension creates a supervision gap | **IMPLEMENTED** | §18.2 A3 | Safety. p95-bounded and capped extension; normal supervision restored only on corroborated exit; extension frequency monitored |
| P2-6 Unbounded monotonicity audit | **IMPLEMENTED** | I6 | Windowed check against a persisted high-water mark |
| P2-7 Region/site/zone/cell containment undefined | **IMPLEMENTED** | §3.6, §22.2, §22.1 | Ambiguity. Containment stated, published as assignment rather than geometry, zone admitted to the config scope hierarchy |
| P2-8 Terminal-value weights undimensioned | **IMPLEMENTED** | §8.3.2, §8.10 | `V_terminal` carries no free coefficients; three uncalibratable parameters removed |
| P2-9 Preemption of an en-route victim unspecified | **IMPLEMENTED** | §4.8 rule 7 | Ambiguity. Disposition stated per victim state; the victim retains no commitment, avoiding a fourth commitment strength |
| P2-10 "Materially better" undefined | **IMPLEMENTED** | §4.7 | Ambiguity. Defined as the churn-inclusive column price; one threshold, priced in CU |

### Low (P3)

| Finding | Decision | Where | Reason |
|---|---|---|---|
| P3-1 Fast path should structurally *be* the batch path | **IMPLEMENTED** | §9.2, §22.5 | Literally the same round at `\|L\| = 1`; enforceable by test rather than by review discipline |
| P3-2 No p99.9 targets | **IMPLEMENTED** | §20.1 | Where a tail bounds a safety window — commit transaction, decision-to-dispatch — a p99.9 is stated and release-gated |
| P3-3 Layered conservatism multipliers compound invisibly | **IMPLEMENTED** | §14.3, §22.1 | Each factor declares what it compensates for; combined product computed and capped at publish time |
| P3-4 Track plausibility threshold unstated | **IMPLEMENTED** | §12.5 | Three stated tests with registered thresholds, decided in advance rather than under complaint pressure |
| P3-5 Reliability estimator feedback loop not closed | **IMPLEMENTED** (as bounded acceptance) | §16.3, §28.3 V2-9 | Bias narrowed, bounded, measured, and confined to a priced term; a genuine identification strategy is deferred, since it needs data that does not yet exist |
| P3-6 Kill switches: no ordering or interaction rules | **IMPLEMENTED** | §22.5 | Every combination is safe by the tiering of §1.8; a monotone supported ladder is what is rehearsed, and unrehearsed combinations alert rather than being blocked |

### Hidden risks

| Risk | Decision | Where | Reason |
|---|---|---|---|
| HR-1 Calibration is the real project and has no owner | **IMPLEMENTED** | §22.4 | Named owner, per-parameter calibration status, tiered launch gate, bootstrap sequence, quarterly review. This was the most likely non-technical failure mode |
| HR-2 Deferral will be disabled within weeks | **IMPLEMENTED** | §8.8, §21.3 | A structured, operator-facing reason is emitted with every deferral and served unsampled from Tier A |
| HR-3 Feasibility-cache invalidation | **IMPLEMENTED** | §10.3.2 step 3 | The volatile re-check subset is an enumerated, machine-checkable list, not prose |
| HR-4 Bundle-generation quality silently dominates | **IMPLEMENTED** | §21.6 | The counterfactual evaluator becomes a release gate for any column-generation change, not only a periodic report |
| HR-5 The feasibility gate will acquire an informal bypass | **IMPLEMENTED** | §7.1, I14 | Type separation enforced by static analysis as a build-time property |
| HR-6 Reconciler/supervisor ordering for external side effects | **IMPLEMENTED** | §4.1 rule 5, §12.4 | Generalised the outbox rule: no command is emitted except from a row written in the authorising transaction |
| HR-7 Multi-tenant cost leakage through `λ_zone` | **DEFERRED** | §28.4 V2-10 | Requires either fragmenting the aggregation that makes the estimate usable, or per-tenant price surfaces — a commercial decision (§27 item 13), not an engineering one. V1 obligation: disclose the shared-surface behaviour in dedicated-fleet contracts |

### Missing topics

| Topic | Decision | Where | Reason |
|---|---|---|---|
| MT-1 A specified correctness core | **IMPLEMENTED** | §1.8 | The review's most important omission. Three obligation tiers, the rule that no Tier 0/1 guarantee may depend on Tier 2, and a staged implementation order that is a consequence of the tiering |
| MT-2 Appointment scheduling as its own problem | **DEFERRED** | §28.1 V2-4 | A materially different optimisation upstream of this engine; needs a capacity-promise contract that does not exist |
| MT-3 Depot, dock, and locker capacity | **DEFERRED** | §28.2 V2-5 | Needs a general reservable-resource abstraction with queueing; extension point already named in §25.2 |
| MT-4 Human operator capacity | **IMPLEMENTED** | §17.4 | Safety-relevant and small: modelled capacity, triage order, rate limiting, and saturation as its own escalation. Without it the ladder's guarantee fails exactly under systemic failure |
| MT-5 The engine's own compute cost in its objective | **DEFERRED** | §28.1 V2-3 | Changes the objective and every calibrated rate for a second-order effect; V1 bounds compute by budget and quota instead |
| MT-6 Weather and seasonal regime change | **IMPLEMENTED** | §22.2 | Named, forecast-triggerable, operator-confirmed regimes with per-regime calibration; the mechanism (time-windowed overrides) already existed |
| MT-7 Order modification after custody | **DEFERRED** | §28.3 V2-7 | A new family of transitions on the most safety-sensitive part of the lifecycle, immediately before implementation |
| MT-8 Teleoperated missions as a lifecycle | **DEFERRED** | §28.3 V2-8 | A parallel lifecycle; F18 already makes the agent correctly unavailable, so nothing is unsafe in the interim |
| MT-9 Fleet-level SLO derivation | **DEFERRED** | §28.2 V2-6 | A fleet-planning artefact requiring a capacity model of the whole operation |
| MT-10 Simulator validation against reality | **IMPLEMENTED** | §24.4 | A release gate that is itself unvalidated provides false confidence, and its characteristic failure is systematic optimism. One-sided fidelity gate, measured per model |
| MT-11 PII erasure versus exact replay | **IMPLEMENTED** | §23.7, §24.3 | A direct contradiction between two stated requirements. Resolved at the schema: surrogate keys, derived non-identifying inputs, erasure tombstones, and a build gate over an erased corpus |

**Summary: 6 of 6 P0, 10 of 10 P1, 10 of 10 P2, 6 of 6 P3, 6 of 7 hidden risks, and 5 of 11
missing topics implemented. Seven findings are deferred whole (HR-7 and missing topics 2, 3, 5,
7, 8, 9).** §28 carries ten entries rather than seven, because three of them record the residual
of a finding that was otherwise fixed: **V2-1** is the exact-pricing option of P0-2, whose
formulation defect is fixed while proven-optimal column *generation* is deferred; **V2-2** is the
approximation error the rewritten P0-4 derivation now states and measures rather than eliminates;
and **V2-9** is the identification strategy behind P3-5, whose bias is meanwhile bounded and
confined to a priced term. Each of the three is a stated, measured limitation of a mechanism that
works, not an outstanding defect.

---

**End of specification.**


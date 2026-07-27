# Architecture Review — NEXT_GENERATION_ASSIGNMENT_ENGINE.md

**Reviewer role:** Principal Robotics Systems Architect / Distributed Systems Reviewer
**Review type:** Adversarial pre-implementation gate — the reviewer's mandate was to attempt
to reject the specification, not to approve it
**Subject:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (clean-sheet design specification for the
next-generation assignment engine)
**Baseline context:** The specification under review is itself a clean-sheet redesign
produced from `ASSIGNMENT_ENGINE_AUDIT.md`, a forensic audit of the current implementation
at `Backend/`, branch `feature/dashboard`, commit `e558243`.
**Disposition:** Attempted rejection — did not succeed outright, but surfaced six defects
serious enough to block implementation as written.

---

## Executive Summary

**Verdict: REQUIRE MAJOR REVISIONS.**

The document is not rejectable outright — the skeleton is sound, and three or four of its
decisions are genuinely correct in ways most dispatch specs get wrong. But it is not
implementable as written, and the reasons are not stylistic. Six defects were found that are
load-bearing:

1. **The fencing epoch is per-agent while authority is per-commitment.** With `capacity > 1`
   — which the entire chaining and consolidation story requires — the stated fencing rule
   makes committed missions uncommandable. This is a hard contradiction between the
   commitment section and the mission-planning/objective sections, not an omission.
2. **The min-cost-flow formulation is invalid for the problem it claims to solve.** The
   solve section asserts the flow formulation "natively expresses agent queue capacity > 1."
   It does not. Arc costs are not separable once an agent holds two missions.
3. **`C_opportunity` double-counts.** The shadow-price integral and the terminal-value
   difference measure the same quantity twice, and the integral is taken over the wrong
   domain.
4. **The admissible lower bound is not admissible.** Several cost terms can be negative and
   are omitted from the bound, which breaks the optimality guarantee that the candidate
   generation section advertises as proven.
5. **`α = 1e-3` in the energy feasibility constraint is wrong by roughly three orders of
   magnitude** once composed over mission count. As specified it authorises roughly 100
   energy-reserve breaches per day on a 5,000-agent fleet.
6. **Whether a SOFT commitment is durable is never stated,** and the answer changes the
   shard throughput budget by roughly 20×, the failover model, and the primary exclusivity
   invariant.

Findings 1, 2, and 6 block implementation outright: two engineers reading the commitment
section and the mission-planning section will build incompatible systems, and the solver
section cannot be implemented as described. Findings 3–5 are quantitative errors in
precisely the sections that claim mathematical rigour, which is worse than being vague,
because they will be implemented faithfully and be wrong.

The document's deeper structural problem is that **it specifies no correctness core.**
Thirty-eight feasibility predicates, bundling, column generation, local search, deferral,
preemption, churn pricing, approximate-dynamic-programming terminal values, three-valued
constraint logic, and hierarchical Bayesian reliability estimation are all presented at the
same level of obligation. Nothing states which subset must be correct for the engine to be
*safe* versus which subset merely improves quality. A specification that cannot be partially
implemented correctly will be implemented incorrectly in full.

---

## Critical Findings (P0)

Design flaws that would prevent correct implementation. These must be fixed before build
begins.

### P0-1 — Per-agent fencing epoch is incompatible with `capacity > 1`

**Sections implicated:** Commitment (fencing/epoch mechanism), the objective function
(capacity constraint), mission planning (insertion/chaining), durable-timer supervision,
invariant register (fencing invariant).

**The specification's stated rule:** epoch is a per-agent monotonic counter; each commit
sets `epoch = commitment_epoch + 1`; the agent "MUST reject any command whose epoch is
lower than the highest it has seen."

**Failure scenario.** Agent A has `capacity = 2`. Commitment C1 is granted epoch 5.
Commitment C2 is granted epoch 6. The agent's highest-seen epoch is now 6.

- A reroute command for C1 carries epoch 5 → **rejected by the agent**, because 5 < 6. C1
  is now uncommandable for the remainder of its lifetime.
- A cancellation of C1 carries epoch 5 → rejected. The cancellation recovery path cannot
  execute.
- C1 settles; settlement bumps the agent epoch to 7. Every subsequent command for C2 now
  carries epoch 6 → **rejected**. C2 is now uncommandable.

With `capacity > 1`, the fencing rule renders the fleet inoperable after the second
concurrent commitment on any agent. This is not a corner case — it is the steady state of
the design's headline efficiency feature (chaining and consolidation), which explicitly
requires `capacity[agent_class] > 1`.

**Compounding defect.** Durable timers are keyed on `(entity, id, state, epoch)` and
discarded on epoch mismatch, specifically so a late-firing timer is harmless. But this means
committing or releasing *any unrelated mission on the same agent* silently invalidates every
timer for every *other* mission on that agent, since the agent's epoch changes. The other
mission's Leg loses supervision entirely — precisely the failure class the durable-timer
mechanism was designed to make structurally impossible.

**Required fix.** Split authority into two independent scopes, both stated explicitly:

- **Agent-scope fence** (`authority_epoch`): governs agent-level commands that must apply to
  the whole agent regardless of which mission is active — stand-down-all, quarantine
  entry/exit, e-stop clear, shard migration. Bumped on leadership change, migration, and
  fleet-wide recovery actions.
- **Commitment-scope fence** (`commitment_fence`): governs mission-specific commands. The
  agent tracks the highest-seen fence *per commitment id*, never a single global maximum
  across all of its concurrent commitments.

Durable timers must key on the Leg's own version, never on the agent's epoch. The
specification must publish a table mapping each command class to the fence scope that
guards it, or implementing engineers will each choose one and rediscover this failure only
in integration testing — or in production.

**Why this is the most serious finding.** The epoch is the single most load-bearing
correctness mechanism in the whole document. Tracing through it: it is the only thing
preventing a safety violation in at least four separate partition-and-pause scenarios across
the concurrency-hazard table, the infrastructure-failure catalogue, the leadership section,
and the reassignment protocol. A mechanism this central being specified incorrectly for the
exact configuration (`capacity > 1`) the rest of the document assumes is the review's single
highest-severity result.

### P0-2 — The min-cost-flow formulation is mathematically invalid as specified

**Sections implicated:** Optimisation and solve (problem formulation), the objective
function, mission planning (insertion cost).

**The specification's claim:** "Min-cost flow rather than plain linear assignment is chosen
because it natively expresses agent queue capacity > 1 (chaining), the deferral option, and
mission multiplicities."

Min-cost flow requires **arc costs independent of other flow on the network.** For an agent
`a` with `capacity = 2` receiving two missions `m₁, m₂` in the same round:

- `m₂`'s approach leg begins at `m₁`'s drop point, not at `a`'s current position. The direct
  cost of `m₂` is therefore a function of whether `m₁` was also assigned to `a` — it is not
  a fixed per-arc cost.
- Both missions' completion times, and therefore both delay-cost terms, depend on the
  sequencing decision between them.
- The opportunity-cost term depends on total commitment duration, which is not the sum of
  two independently-computed mission durations.

So `Cost(a, {m₁,m₂}) ≠ Cost(a,m₁) + Cost(a,m₂)`. The flow solution's objective value is
therefore not the true objective value, and the solve is not exact — while the same section
explicitly claims "the selection among generated bundles is exact."

The specification already contains the correct formulation elsewhere without recognising it:
the mission-planning section's insertion cost, defined as the marginal cost of inserting a
mission into an agent's existing sequence, is precisely a **column** in a set-partitioning
problem. The document is halfway to column generation and describes it as min-cost flow.

**Required fix.** Choose one of the following, and state the consequence of the choice:

| Option | Formulation | Consequence |
|---|---|---|
| A | Strict `capacity = 1` in the flow; **all** chaining and consolidation expressed exclusively as pre-generated multi-task columns priced via the insertion-cost mechanism | Flow stays valid and integral; bundle generation becomes the only route to chaining; capacity ceases to be a freely tunable config knob |
| B | Full set-partitioning with column generation; columns are complete agent sequences | Correct and general; the LP relaxation is no longer guaranteed integral, branch-and-price becomes necessary, and the claim that solver duals are "theoretically correct prices" becomes false |

Option A is the pragmatic choice for a first implementation, and notably the specification's
own rollout recommendation (in its open-decisions section) already proposes starting at
`capacity = 1` — meaning the document's own recommended rollout path is inconsistent with the
formulation it specifies as the target architecture. That inconsistency should be resolved by
making Option A the stated design, not an interim workaround.

### P0-3 — SOFT commitment durability is unspecified and load-bearing

**Sections implicated:** Domain model (commitment/lease/epoch), the objective function,
shard model, performance targets, complexity analysis, invariant register (capacity
invariant), single-writer-per-shard rationale.

The domain model states that a SOFT commitment "reserves capacity in the optimiser's view of
the world," but nothing states whether this reservation is persisted in the durable
Commitment Store or held only in the Assignment Coordinator's in-memory round state. Both
readings are consistent with the text, and they produce materially different systems.

**If SOFT commitments are durable:** the stated commit-transaction latency budget of under
20 milliseconds in a serialised per-shard section implies roughly 50 writes/second/shard at
that budget. A 20,000-agent shard running at 2 rounds/second with 500 missions/round, with
SOFT commitments being revised across rounds under the churn-pricing mechanism, generates
commitment writes on the order of 10³/second. **The stated shard sizing exceeds its own
throughput budget by roughly 20×.** The complexity analysis lists the commit stage as "O(m)
transactions, serialised — small constant"; under this reading it is not small.

**If SOFT commitments are held only in coordinator memory:** they are lost on coordinator
failover. The new leader's reconciliation loop would see "Leg non-terminal, no commitment, no
queue entry" and requeue it — an acceptable, if slightly wasteful, outcome. But the stated
capacity constraint (`Σx[a,m] ≤ capacity[a]`) is then enforced only *within* a single round,
and the invariant register's capacity invariant is scoped only to HARD commitments — so
nothing in the invariant register actually prevents a capacity-1 agent from accumulating
multiple SOFT commitments across successive rounds if any code path happens to persist one
partially.

**Required fix.** State the durability of SOFT commitments explicitly. If in-memory, add an
explicit invariant that SOFT commitments are round-local and are *reconstructed*, not
*recovered*, on failover, and remove them from the durable capacity-constraint semantics. If
durable, re-derive the shard sizing and commit-transaction budget from the actual measured
write rate rather than from HARD-commitment volume alone.

### P0-4 — `C_opportunity` double-counts and integrates over the wrong domain

**Section implicated:** Cost function (opportunity-cost term).

The opportunity-cost term is defined as the integral of a zone-level marginal-value price
over the agent's committed time, minus the difference in terminal-state value between the
agent's end state and its current state. Two independent mathematical errors are present.

**(a) Double counting.** The zone-level marginal-value price is defined as "the marginal
value of one additional available agent in zone `z` at time `τ`" — that is, precisely the
value forgone by the agent's unavailability. The terminal-value function's coverage
component is defined as "expected future response cost" evaluated at the agent's terminal
position — which is the *same* forgone-availability quantity, measured at the end state
instead of integrated over the commitment. In approximate dynamic programming, one uses
*either* a cost-to-go difference *or* a shadow-price integral to capture forgone value — never
both, because they are two estimators of the same quantity. Using both charges the same
resource consumption twice. The practical effect is systematic over-penalisation of long
missions, growing with mission duration, and a cost function whose actual sensitivity to zone
prices is roughly double what any calibration exercise would assume it to be.

**(b) The integral domain is wrong.** The zone-price integral is taken over the agent's
position *while it is travelling* — but a mission-in-transit agent is not available anywhere,
so integrating the availability price along its route means a mission that happens to
transit an expensive zone is penalised for merely passing through it. That is not an
opportunity cost; it measures nothing physically meaningful. The forgone value properly
accrues in the zone where the agent *would have been available* had it not been committed —
its origin zone (or, more simply, a single capacity price for the committing shard) — not
along the route it travels while executing the mission it was assigned.

**Required fix.** Retain one formulation and remove the other:

```
C_opportunity = λ_zone(origin_zone(a), t_start) · T_commit
              − ( V_terminal(end_state) − V_terminal(start_state) )   ← keep only one of
                                                                          these two ideas
```

Recommended resolution: keep the terminal-value difference alone (it is the theoretically
correct approximate-dynamic-programming form) and fold the zone-level marginal price into the
terminal-value function's coverage component only. This eliminates the double count and the
domain error simultaneously, and it also reduces the number of independently-calibrated
quantities in the model, which benefits the configuration-governance goals stated elsewhere
in the document.

### P0-5 — The admissible lower bound is not admissible

**Sections implicated:** Candidate generation (hierarchical expansion, lower-bound pruning
rule), cost function (opportunity cost, policy adjustments, churn), testing and verification
(property-based test of the bound).

The candidate-generation section asserts that every component of the lower bound used for
pruning is "a provable underestimate, so the sum is," and derives from this an exactness
guarantee: at zero optimality tolerance, "the result is provably exactly optimal over the
whole region."

The stated lower bound omits the opportunity-cost term, the policy-adjustment term, and the
churn term entirely. All three can be **negative**:

- The opportunity-cost term is negative whenever the terminal-state improvement from taking
  the mission exceeds its commitment cost — precisely the case for repositioning-beneficial
  missions, which the fairness/balancing section relies on as a real and desirable outcome.
- The policy-adjustment section explicitly defines a zone-affinity "credit" and a
  dedicated-fleet "credit" — both negative by construction.
- The churn term is zero or positive, so it alone is safe to omit; the other two are not.

Omitting a negative term makes the computed lower bound *larger* than the true cost,
violating the required property `LB ≤ Cost`. Pruning then silently discards cells that
contain the true optimum. The "proven optimality gap" that the specification writes into
every decision record, and which feeds a first-class service-level indicator, is therefore
not a bound on anything in these cases.

The testing section proposes catching this via property-based sampling of `LB ≤ Cost` — which
would eventually surface the defect, but only after the false guarantee has already been
advertised in production decision records and consumed by downstream service-level
indicators.

**Required fix.** The lower bound must subtract a computable upper bound on all negative
contributions:

```
LB = (positive admissible components) − max_terminal_value_gain − max_policy_credit
```

`max_policy_credit` is boundable by construction from the configuration register (the
operator-adjustment cap and the individual credit ceilings already exist as configuration
values). `max_terminal_value_gain` must be bounded by the maximum coverage-value differential
achievable across the region. Both bounds must be added to the parameter register, and the
admissibility property must become a build-gate test rather than a sampled property test.

### P0-6 — `α = 1e-3` in the energy feasibility constraint authorises roughly 100 reserve breaches per day

**Sections implicated:** Battery/energy strategy (layered reserve model, feasibility
constraint), open decisions (energy confidence level), invariant register (energy
feasibility invariant).

The energy feasibility constraint requires `P[energy shortfall] ≤ α` per mission, with a
stated default of `α = 1e-3`.

Composing this across fleet scale: 5,000 agents completing 20 missions/day each yields
100,000 missions/day, and at the stated default that implies **roughly 100 expected shortfall
events per day**, or on the order of 36,500 per year. Even the tighter end of the range the
document itself proposes in its open-decisions section (`1e-5`) still yields roughly one
event per day fleet-wide.

A defensible fleet-level target — say, on the order of 10 such events per year across
roughly 36.5 million annual missions at this fleet size — would require `α` on the order of
`2.7e-7`. The stated default is off by roughly three and a half orders of magnitude, and the
document's own stated range for the parameter never reaches a value that would satisfy a
reasonable fleet-level target.

There is a second, more fundamental ambiguity underneath the numerical error: it is not
stated whether "shortfall" means "the contingency reserve layer was consumed" (a
recoverable, non-hazardous diversion) or "the agent stranded" (a hazardous event potentially
requiring physical recovery). If the former, 100 events/day might conceivably be tolerable
as a service-quality metric rather than a safety metric. But the reserve model states that
the contingency, return, and floor reserves "may not be traded against another," and the
mission-feasibility constraint treats reserve integrity as a hard safety property throughout
— so the consequence tiers are conflated, and the single probability number cannot actually
be evaluated for adequacy as written.

**Required fix.** Define energy shortfall as a tiered event with distinct probability targets
per tier:

| Tier | Event | Consequence | Suggested target |
|---|---|---|---|
| 1 | Contingency reserve consumed | Diversion to charge; no incident | `≤ 1e-2` per mission |
| 2 | Return reserve breached | Physical recovery mission required | `≤ 1e-5` per mission |
| 3 | Hardware floor reached in active service | Immobilisation; possible obstruction | `≤ 1e-7` per mission |

The invariant register's energy-feasibility verification should then be restated in composed,
fleet-year terms (expected events per fleet per year), because a per-mission probability in
isolation is not a quantity any operator or safety reviewer can reason about directly.

---

## High Priority Issues (P1)

Important flaws that should be corrected before implementation, though none is individually
fatal to the architecture.

### P1-1 — Leadership is not enforced transactionally

**Sections implicated:** Leadership and split-brain, commitment procedure, concurrency
hazard table.

The stated protection is that "a coordinator MUST stop committing the moment it cannot renew
its lease" — a liveness-based argument being used to support a safety property, which is
structurally the same reasoning the document correctly rejects when discussing why a cache
lock alone cannot provide mutual exclusion. The commit transaction takes row locks that can
block for an unbounded duration under contention with the reconciliation loop; a transaction
that begins inside a coordinator's valid leadership window can therefore commit after that
window has expired.

Tracing this through carefully: the per-agent epoch compare-and-swap does still prevent
double-commitment of any single agent, and the Leg's own version check prevents
double-commitment of any single mission — so the core exclusivity invariant survives. The
residual damage is real but narrower than a safety violation: two coordinators can run
concurrent rounds against disjoint snapshots of the same shard, producing commitments whose
*joint composition* the solver never actually evaluated together, and this breaks the
replay-determinism guarantee, since replaying either round in isolation will not reproduce
the shard's actual resulting state. The leadership section does state that "commitments
record the shard epoch that produced them" but never specifies that this recorded value is
*checked* as a guard anywhere.

**Required fix.** Add the shard leadership fence to the commit transaction's guard set:
read the current leadership record inside the same transaction and abort if the fence value
has advanced since the round began. Leadership then becomes a database-enforced property
rather than a coordinator's unverified belief about its own lease validity. This is a cheap
addition and closes the gap completely.

### P1-2 — The Commitment-Store-unavailable degradation contradicts the cache-authority rule and makes the lease invariant unenforceable

**Sections implicated:** Data-store role assignment (cache-tier authority rule),
infrastructure failure catalogue (Commitment Store unavailable), invariant register (lease
validity invariant).

One section states plainly that "the cache tier MUST NOT hold the only copy of any fact
required for correctness." The infrastructure-failure catalogue's entry for Commitment Store
unavailability states that "existing missions [are] supervised by cached leases."

Lease validity is exactly the kind of correctness-relevant fact the cache-authority rule is
meant to exclude, and the durable store is its own stated authority. Supervising on cached
leases during a store outage means acting on an authority value that cannot, during that
outage, be verified against its source of truth — directly contradicting the document's own
architectural rule.

The consequence compounds: the invariant register's lease-validity invariant ("every active
commitment has a valid lease or is in a recovery state") becomes unenforceable for the
duration of any Commitment Store outage, since leases cannot be renewed against their
authority. Every active commitment in the shard technically violates this invariant for the
outage's duration, and the invariant register states that violations are pages with a target
of exactly zero — meaning a routine database outage would page continuously for its entire
duration under a literal reading of the specification.

**Required fix.** State explicitly that during this failure mode the shard enters a named
degraded state in which: no new commands are issued to agents; existing missions continue to
execute autonomously under on-agent supervision without server-side lease renewal; the
lease-validity invariant is formally and explicitly *suspended* for the duration, with the
suspension itself recorded as an event; and the invariant checker reports a distinct
*suspended* status rather than a *violated* status during this window. Every invariant in the
register needs a stated behaviour under each relevant degraded mode; presently none of them
has one.

### P1-3 — The objective function is indexed over missions while the unit of assignment is legs

**Sections implicated:** Domain model (work hierarchy: task/stop/leg/mission), objective
function, cost function (delay-cost term).

One section is unambiguous that "the unit of assignment is the Leg." The objective function,
however, sums delay cost over "pending mission set `M`." For a multi-Leg Mission, it is never
stated whether each constituent Leg individually contributes a delay-cost term, or whether the
Mission contributes exactly one term attributed to a specific Leg.

If every Leg of a multi-Leg Mission contributes independently, a three-Leg mission is
penalised three times for what is, from the customer's perspective, a single instance of
lateness. If only one Leg carries the term, it is not stated which one, nor how that Leg's
marginal contribution to the Mission's overall completion time is computed when the Mission's
actual completion depends on downstream Legs that have not yet even been assigned at the time
the upstream Leg is scored.

This is the central notation of the entire document, and it is ambiguous at the point where it
matters most. Two engineers will resolve it differently, and the resulting cost scales will
differ by a factor roughly equal to the average Leg count per Mission — silently miscalibrating
every exchange rate registered in the cost-function parameter table, since those rates were
presumably derived assuming a particular attribution convention.

**Required fix.** Rewrite the objective function with the Leg as the sole decision index, and
define the delay-cost term as an explicit Leg-level attribution of the parent Mission's overall
delay cost, with a stated attribution rule — for example: the Leg whose completion determines
the Mission's completion carries the full delay-cost term, while upstream Legs instead carry a
slack-consumption penalty proportional to how much schedule margin they consumed.

### P1-4 — The cancellation guard blocks its own mandated recovery path

**Section implicated:** Assignment lifecycle (cancellation).

The cancellation mechanism states that every commitment transition's guard includes a check
that no cancellation has been requested for the parent Task. But the same section's handling
of cancellation while custody is held *requires* generating a return-or-transfer sub-mission —
which is itself a Leg that needs to progress through ordinary commitment transitions, on a
Task whose cancellation flag is, by definition, already set.

As written, the guard blocks the very recovery mechanism the specification mandates.
Implementers will work around this, most likely by exempting recovery Legs from the guard in
an ad hoc and probably inconsistent way across the codebase.

**Required fix.** State the guard as conditioned on either no cancellation being requested, or
the Leg being explicitly marked as a recovery Leg — making "purpose" (ordinary versus
recovery) an explicit, first-class attribute of every Leg rather than an implicit distinction
left for implementers to invent.

### P1-5 — Unbounded aging interacts pathologically with batch optimisation

**Sections implicated:** Cost function (delay-cost aging multiplier), anti-starvation
escalation ladder, optimisation and solve.

The aging multiplier applied to delay cost is specified as "monotonically increasing in queue
age" with no stated ceiling, and it multiplies an already-convex (quadratic by default)
lateness penalty. The document's anti-starvation argument for this term explicitly depends
on its unboundedness.

In a batch solve, however, a sufficiently aged mission's cost will come to dominate the entire
round's objective. The solver will then correctly — by the letter of its own objective — choose
to sacrifice arbitrarily large amounts of aggregate quality across dozens of otherwise-fresh
missions in order to improve the aged mission's completion time by mere seconds, and it will do
so even when the achievable improvement for the aged mission is marginal, because a
sufficiently large multiplier makes any nonzero improvement dominant over any amount of
degradation elsewhere. The separately-specified escalation ladder correctly handles the case
where the aged mission is outright infeasible; it does not address the case where the mission
is feasible but only marginally improvable.

**Required fix.** Cap the aging multiplier at a stated, configured ceiling, and rely on the
escalation ladder alone to provide the hard anti-starvation guarantee — which is in fact what
actually provides it, since the ladder is specified to terminate in a decision regardless of
cost dynamics. State explicitly that anti-starvation is guaranteed structurally by the ladder,
not by the aging term, and that the aging term's sole purpose is a soft, bounded nudge.

### P1-6 — The return-to-charger energy reserve is circular and its routing cost is unbudgeted

**Sections implicated:** Battery/energy strategy (reserve model), performance targets,
routing cost mitigation.

The return-energy reserve is defined against "the nearest charger that is available or
reservable at the projected time." But charger availability at a future time depends on the
charging schedule implied by *other agents'* plans — plans which themselves depend on the
outcome of the very optimisation round currently being computed. The energy-feasibility
constraint is therefore defined in terms of a quantity that depends circularly on the result
it is meant to help produce.

Separately, computing this reserve for each candidate requires an additional routing query
from that candidate's *projected mission-end position* to a candidate charger — a second full
set of per-candidate routing queries, which is entirely absent from the stated performance
budget and from the routing-cost mitigation analysis elsewhere in the document. The proposed
cell-pair travel-time cache helps with origin-based queries, but projected mission-end
positions are mission-specific and not naturally cell-aligned in the same reusable way that
mission origins tend to be.

**Required fix.** Break the circularity with a fixed-point-free approximation: use charger
availability as projected by the *previous* completed round, explicitly documented as an
approximation with a stated conservatism margin to compensate for its staleness. Add the
return-leg routing query cost explicitly to the performance budget and to the routing
cache-key design.

### P1-7 — Agent-side command deduplication has no stated durability requirement

**Sections implicated:** Commitment idempotency, dispatch and acknowledgement, delivery
mechanism.

The specification states that the agent "deduplicates on `(commitment_id, sequence, epoch)`"
but never requires this deduplication state to be durable across an agent-side restart. A
robot that power-cycles — which will happen routinely, including as a *deliberate*
fault-recovery action elsewhere in the document — loses this table entirely and will then
re-execute a redelivered offer or command that it had, before the restart, already
processed. At-least-once delivery combined with non-durable deduplication state is not
actually exactly-once in practice, regardless of what the protocol intends.

**Required fix.** Require durable deduplication state on the agent, with a stated retention
window at least as long as the offer time-to-live plus the maximum plausible delivery delay.
Additionally require the agent to report its deduplication high-water mark at session
establishment, so the server side can detect a state reset following a restart and suppress
redelivery of commands the agent can no longer be trusted to have deduplicated correctly.

### P1-8 — Decision-record write volume has no sizing analysis

**Sections implicated:** Decision record schema, infrastructure failure catalogue (logging
outage behaviour), performance targets.

The decision record is specified to include, per candidate and per feasibility predicate:
result, observed value, required value, input source, and observation age. At the stated
per-mission candidate cap of 200 and 38 feasibility predicates, this is roughly 7,600
structured sub-records per mission decision, before accounting for re-planning rounds. At a
region processing 10,000 missions/hour with an average of two decision rounds per mission,
this generates on the order of 1.5×10⁸ predicate-result records per hour — with no stated
sizing, sampling rate, or compression scheme anywhere in the document.

The stated exemption list for full-fidelity retention (any decision that was degraded,
relaxed, overridden, preempted, later reassigned, later failed, or disputed) is broad enough
that, under any shard-wide degraded mode, the sampling relief this exemption list is meant to
provide disappears entirely — precisely at the moment volume spikes hardest.

**Required fix.** Specify a two-tier decision record: a compact, always-on record (chosen
agent, runner-up, top-N candidates only, aggregate cost totals, degradation flags) retained
in full, and a full-fidelity record retained only by explicit sampling plus the exemption
list — with the exemption list itself bounded so that a shard-wide degradation event does not
silently force full retention across the entire shard. The sizing calculation above, or an
equivalent one, should appear in the specification itself.

### P1-9 — The `STRANDED` state does not distinguish a public-safety hazard from a mere inconvenience

**Sections implicated:** Leg state machine (`STRANDED` state), mid-mission energy
management, agent-level failure catalogue (immobilisation with custody).

The `STRANDED` state has exactly one exit path and one associated service-level target. A
robot stranded harmlessly in a car park and a robot stranded blocking a tram line, a fire
exit, or a level crossing are treated identically by the state machine. The second case is a
genuine public-safety event requiring a response measured in minutes and involving a
different escalation chain entirely — traffic authorities, emergency services — not an
ordinary operations queue entry. The mid-mission energy management section elsewhere
correctly reasons about actively choosing *where* to stop an agent before it fails, which
makes the absence of this distinction in the state model more conspicuous, not less.

**Required fix.** Split the state into `STRANDED_SAFE` and `STRANDED_OBSTRUCTING`, with the
distinction determined automatically from the map's hazard classification of the stopping
location, each carrying its own response-time target and its own escalation path. This
distinction is a hard requirement for any deployment operating on public rights-of-way.

### P1-10 — Ownership of the target state-of-charge decision is unassigned

**Sections implicated:** Charging model (partial charging as an optimisation output), system
boundaries (charging as a soft boundary), interaction with the Charging Scheduler.

One section states that target state-of-charge "is therefore an optimisation output, chosen
against forecast demand, charger contention, and wear cost — not a fixed rule." The
system-boundaries section places charge scheduling outside the assignment engine entirely, as
a separate service's responsibility. The interaction section states only that the engine
"participates" in charging decisions, without specifying which side actually computes and
owns the target value.

No single component is assigned ownership of this decision as written. Two implementation
teams — one building the assignment engine, one building the Charging Scheduler — will each
reasonably assume the other owns it, or each will implement it independently and
inconsistently.

**Required fix.** Assign ownership explicitly. The recommended resolution: the Charging
Scheduler owns and publishes the target state-of-charge; the assignment engine treats the
published value as an input constraint and may submit a priced request to change it, but
never computes or asserts a target value unilaterally. State this contract explicitly in both
the charging-model section and the interaction section.

---

## Medium Issues (P2)

Improvements that should be made but do not block implementation on their own.

**P2-1 — Solver dual variables are not valid marginal prices in the specified formulation.**
The cost-function section calls the solver's dual variables "the theoretically correct
quantity" for calibrating the opportunity-cost price. This is true only for a pure bipartite
assignment linear program, whose relaxation is integral. Once bundles with mutual-exclusion
constraints are introduced (as the solve section does), the problem becomes set partitioning,
whose relaxation is generally fractional — so the duals are prices for the relaxation, not
for the true integer problem being solved. Either restrict dual-based price calibration to
rounds solved without any bundling, or explicitly state the approximation being made when
bundling is present.

**P2-2 — Agent-to-agent custody transfer assumes hardware most fleets will not have.** The
reassignment protocol offers physical transfer between two agents as one of three lawful
recovery outcomes when custody is held and the incumbent agent has failed. Most sidewalk
delivery robots have no manipulator and no mutually accessible compartment interface, so in
practice this outcome collapses into human-mediated recovery for the large majority of
fleets. There is no capability flag anywhere in the capability model gating whether an agent
class actually supports this. Add an explicit `custody_transfer_capable` capability, default
it to false, and state plainly that transfer defaults to requiring a human intermediary or a
docking-compatible agent pair.

**P2-3 — Localisation confidence is self-reported by the very subsystem that is failing.**
The relevant feasibility predicate gates on the agent's own reported pose covariance.
Localisation failures are frequently *confidently wrong* — that is precisely what makes them
dangerous rather than merely inconvenient. The predicate needs independent corroboration:
cross-checking against an independent positioning signal where available, map-matching
residuals, or divergence between odometry and the last accepted fix. As written, the design
trusts the exact subsystem it is attempting to police, which directly contradicts the
document's own stated principle of asymmetric trust for self-reported agent state.

**P2-4 — Cold-chain compartment cooling load is missing from the energy consumption
model.** The energy model's thermal coefficient covers ambient conditions and general
HVAC-style loads, but active compartment cooling for temperature-controlled payload is a
distinct, payload-dependent energy draw, and the payload-effects section elsewhere omits it
from its list of physical effects beyond simple gating. Cold-chain missions are
disproportionately long-duration, so this omission is correlated precisely with the missions
where energy feasibility matters most. Add a payload-thermal energy term keyed on
compartment thermal class and mission duration.

**P2-5 — Lease extension for agents in known dead zones creates a supervision gap exactly
where observation is worst.** The relevant failure-handling entry extends an agent's lease
based on a *predicted* transit time through a mapped communication dead zone, computed from
its last known position before entry. An agent that entered the zone and then turned around,
stopped, or suffered an unrelated fault receives extended immunity from recovery detection
precisely during the window when it is least observable. Bound the extension to a high
percentile (e.g. 95th) of the zone's historical transit time, require corroboration of actual
zone exit before fully restoring normal supervision, and track extension frequency as a
monitored signal.

**P2-6 — The commitment-epoch monotonicity invariant is checked by an unbounded audit.** The
stated verification method is "a monotonicity audit on the commitment history" with no
window specified, over a history that grows without bound. Specify a windowed check with a
persisted high-water mark instead of an ever-growing full-history scan.

**P2-7 — Four distinct spatial concepts have undefined containment relationships.** Region,
site, zone, and cell all appear as scoping or indexing units across different sections —
region as the sharding key, zone as the pricing unit, site and cell for indexing — and their
containment relationships and relative cardinalities are never stated. The configuration
scope hierarchy resolves from region down to site but never mentions zone, even though zone is
the unit prices are actually keyed by elsewhere in the document. This will produce
inconsistent configuration scoping in practice.

**P2-8 — Terminal-value weighting coefficients have unstated dimensions.** The terminal-value
function combines a coverage weight with an "expected future response cost" quantity. If that
quantity is already expressed in the canonical cost unit, the coverage weight is
dimensionless and functions as an unexplained second weighting on an already-priced quantity.
The parameter register lists the terminal-value weights with unit "—". Given that the
document's central, and correct, methodological claim is dimensioned exchange rates
throughout, an undimensioned weight buried inside the single most complex term in the cost
function is a notable inconsistency with the design's own stated principle.

**P2-9 — Preemption of a victim mission that is already en route is unspecified.** The
preemption rules bar preemption once custody is held, but price "the victim's re-queue cost"
and "wasted travel already performed" — implying the victim can indeed already be in transit
at the moment of preemption. Whether such a victim returns to the queue outright or retains
some form of soft commitment, and what physical action the agent executing it takes
mid-transit, is not specified.

**P2-10 — "Materially better" is left undefined at the reassignment-trigger threshold.** The
reassignment protocol lists a materially-better allocation found by a re-planning round as a
valid reassignment trigger, phrased in prose. The churn-pricing term elsewhere in the cost
function already supplies a rigorous, quantitative threshold for exactly this kind of
decision; the reassignment trigger should reference it directly rather than inviting a second,
independently-invented threshold.

---

## Low Priority Issues (P3)

Nice-to-have suggestions; none affects correctness.

- **P3-1** — The fast-path and batch-path solve routes are asserted to share code "so they
  cannot disagree." This should be enforced structurally — the fast path should literally be
  the batch path invoked with a batch size of one — rather than asserted as an intended
  property of two separately-described code paths.
- **P3-2** — Performance targets are all stated at the 99th percentile with no 99.9th
  percentile target given anywhere. For a system supervising physical hardware, the tail is
  usually the operationally interesting part, particularly for commit-transaction latency,
  since that latency directly bounds the leadership-fence vulnerability window identified in
  P1-1.
- **P3-3** — Two independent, unexplained conservatism multipliers are layered on top of
  vendor-supplied physical curves — one for state-of-health derating, one for payload safety
  margin. Layering independently-chosen fudge factors compounds their effect invisibly;
  document the intended combined conservatism explicitly.
- **P3-4** — The geometric-plausibility check used for baseline completion verification
  requires "a plausible telemetry track" with no stated plausibility threshold. This will be
  tuned reactively by whoever first encounters a false-positive complaint rather than
  deliberately up front.
- **P3-5** — The reliability estimator's mission-difficulty conditioning creates a feedback
  loop that the document itself notes but does not close: difficulty features are partly
  derived from routing decisions the engine itself makes, so the estimator partially learns
  the engine's own policy rather than a property of the agent. This needs either a stated
  identification strategy to break the loop, or an explicit, documented acceptance of the
  resulting bias.
- **P3-6** — The kill-switch table for major capabilities lists roughly nine independent
  switches with no stated ordering or interaction rules. Under a compound failure, which
  switches are thrown first, and are all resulting combinations even valid states for the
  system to be in? Specify the supported subset of combinations rather than leaving all
  512 combinations implicitly permitted.

---

## Strongest Parts

Decisions that were specifically attacked and survived rigorous scrutiny.

**1. Custody as a first-class concept.** This is the single best decision in the document.
The insight that failure *before* custody is a scheduling problem while failure *after*
custody is a physical-logistics problem is correct, genuinely non-obvious, and structurally
consequential — it drives three distinct recovery outcomes, the dedicated stranded state, the
settlement ordering requirement, and the corresponding invariant preventing an agent from
returning to service while still carrying goods. This distinction is the kind of thing
production fleets typically discover only after an incident; having it in the domain model
before implementation begins is worth more than most of the rest of the document combined.

**2. Absolute cost units, and the reasoning given for them.** The argument against
relative (min-max) normalisation is correct and stated in the right terms: it identifies five
specific downstream capabilities that relative normalisation forecloses, rather than
asserting a vague stylistic preference. The observation that a rescaled best candidate always
scores exactly zero regardless of its actual quality, and that this makes the concept of
deferral inexpressible *in principle* rather than merely awkward, is the key insight and it is
correctly identified. The requirement that every weighting coefficient carry an explicit
physical dimension and a stated derivation is the only defence against silent coefficient
drift that has been observed to actually work in comparable production systems.

**3. The systemic-indeterminacy guard.** A naive fail-closed response to missing telemetry
data would turn any routine network blip into a fleet-wide operational outage; the document
correctly recognises this risk and responds with a load-shedding-style guard that shrinks the
operating envelope and raises alarms rather than relaxing any safety margin. The general
principle behind this — that the correct response to lost information is a smaller envelope
with louder alarms, never a lowered safety threshold — is applied consistently throughout the
infrastructure-failure handling.

**4. The custody-return invariant and its associated settlement ordering.** The rule that an
agent carrying a non-empty payload manifest may never be returned to the available pool, with
custody release required to strictly precede commitment release during settlement, is a
single, simple invariant that on its own eliminates an entire class of lost-goods incidents.

**5. The cross-scale locality test.** A genuinely falsifiable test of the design's central
scaling claim — requiring statistically indistinguishable round times for a shard within a
10,000-agent fleet and a shard within a 1,000,000-agent fleet. Most specifications of this
kind merely assert scalability as a property; this one specifies precisely how to disprove the
claim if it is false.

**6. Asymmetric trust in self-reported agent health.** Trusting an agent's self-reported
unfitness while distrusting its self-reported fitness is correct, and the underlying reasoning
— that a false positive in one direction costs an agent-shift while a false positive in the
other risks an incident — generalises properly to every other agent-reported field in the
system.

**7. Rejection-reason telemetry as a capacity-planning instrument.** Recording the
binding-constraint distribution and near-miss margins for every rejected candidate turns the
feasibility gate into an operational diagnostic tool rather than a pure gatekeeping mechanism
— the difference between an operator being told "no robots are available" and being told
precisely that chargers are misplaced in a specific zone.

---

## Weakest Parts

**1. The opportunity-cost and terminal-value section.** This is the most mathematically
complex mechanism in the entire specification, has the least rigorous derivation of any
section, contains two independent mathematical errors (the double-count and the
wrong-domain integration), includes an undimensioned weighting coefficient, offers three
different estimation paths with no stated precedence between them, and will be by far the
hardest term in the model to calibrate against real data. It is also the exact mechanism the
document's central claim — that this is a genuine fleet allocator rather than merely a
proximity dispatcher — rests upon. As written it reads closer to an unfinished research
direction than to a specification ready for implementation. It needs either a properly
derived approximate-dynamic-programming formulation with a stated bound on its approximation
error, or an honest demotion to a simpler heuristic (for example, charger-distance combined
with local demand density) with the more ambitious framing removed.

**2. The solve-formulation section.** Internally inconsistent in a way that is not visible
unless one specifically checks whether the claimed cost terms are separable across an agent's
concurrent commitments — and they are not. The section reads with complete authority while
specifying an approach that cannot actually be built as described.

**3. The commitment and fencing section.** This is the document's single most important
correctness mechanism, and it is specified incorrectly for precisely the configuration
(`capacity > 1`) that the rest of the document assumes throughout.

**4. The energy-confidence parameter within the battery strategy section.** A rigorous-looking
probabilistic feasibility constraint paired with a default numerical value that is wrong by
roughly three orders of magnitude, and a consequence model that fails to distinguish severity
tiers. This is a more dangerous defect than an openly acknowledged gap would be, precisely
because it will be implemented exactly as written, will pass any test written directly against
its own stated specification, and will fail only in aggregate, in production, over time.

**5. The document as a whole lacks any specified correctness core.** Every mechanism, from the
thirty-eight feasibility predicates down to the bundle-generation heuristic, is presented at
the same nominal level of obligation. There is no statement anywhere of the form "the
following subset is required for the system to be safe; the remainder improves quality and
may be staged in later." That absence guarantees that whatever subset ships first will be a
self-selected one, chosen by whichever engineers happen to implement it first, with no
accompanying analysis of whether that particular subset is actually safe on its own.

---

## Hidden Risks

Risks not explicitly discussed in the specification but likely to materialise in production.

**1. Calibration is the real project, and it currently has no owner.** The parameter register
lists on the order of eighty configuration values, a significant number of which — zone-level
marginal-value priors, failure costs broken out by mission class and custody state, per-class
wear coefficients, terminal-value weights, and per-site-per-stop-type-per-hour service-time
models — require data the fleet does not yet produce and cannot produce before initial
deployment. The configuration-governance section describes a calibration *process* but assigns
it no owner and no timeline. The likely real-world outcome is that the engine ships with
placeholder coefficients, its early decisions are consequently indefensible when questioned,
operators lose trust within the first month of operation, and they begin overriding it
constantly — at which point the override-rate monitoring the document specifies will
correctly show a system nobody is actually using as designed, without anyone having decided
that outcome deliberately.

**2. Deferral, as a visible operator-facing behaviour, will likely be disabled within weeks
of launch regardless of its underlying correctness.** Deferral means the engine will
sometimes deliberately choose to leave a customer waiting while a nominally suitable robot
sits idle nearby, because the engine has calculated that a better robot will be available
shortly. The first time an operator observes this on a live dashboard, it will almost
certainly be escalated and treated as a bug, irrespective of whether the underlying decision
was mathematically correct. The specification's own recommendation to start conservative
helps, but the document needs an explicit operator-facing explanation surface built
specifically for deferral decisions — something along the lines of "waiting because a closer
robot will be free in 90 seconds" — or the feature is unlikely to survive sustained contact
with live operations.

**3. Feasibility-cache invalidation is likely to become the single largest source of
production defects.** The three-tier caching scheme for feasibility predicates, with
reason-derived time-to-live values and a separate negative cache, is intricate. A stale
*positive* cached feasibility result commits an unsafe pairing, and the volatile-subset
re-check at commit time is the only defence against this — and that re-check's "volatile
subset" is currently defined only informally, in prose, rather than as an enumerated,
machine-checkable list.

**4. Bundle-generation quality will silently dominate overall solution quality.** The
solve-formulation design makes the *selection* among generated bundles mathematically exact
while leaving bundle *generation* itself a heuristic — meaning in practice the heuristic
determines the actual answer, since an exact solve over a poor set of candidate bundles simply
produces an exact, but poor, result. The offline counterfactual evaluator is the correct
instrument for detecting this, but it is specified as running periodically rather than being
required as a release gate specifically whenever the bundle-generation heuristic itself
changes.

**5. The thirty-eight-predicate feasibility gate will eventually develop an informal bypass.**
Not through any deliberate malice, but through an entirely predictable sequence of events: a
latency incident occurs, someone identifies that a handful of the more expensive predicates
(payload and energy-related checks in particular) dominate per-round evaluation time, and a
"trusted pairing" fast path gets added under time pressure to work around it. The
specification's requirement that cost evaluation be structurally incapable of seeing an
infeasible candidate is the correct defence against exactly this outcome, but it needs to be
enforced as a build-time architectural test, not merely stated as prose obligation that a
future engineer under pressure can route around.

**6. Ordering between the reconciler and the durable-timer supervisor is underspecified for
external side effects.** Both mechanisms can independently act on the same entity at
overlapping times. Conditional writes correctly ensure that only one of them wins the
underlying state transition, but nothing in the specification requires that any *external*
side effect (a command sent to an agent, in particular) occurs only strictly after the
guarded write that authorised it has actually committed. The dispatch mechanism gets this
right by construction, writing its outbox entry inside the same transaction as the commitment
itself — but the reassignment protocol's step of bumping the agent's epoch and separately
issuing a recall command does not clearly state which happens first. Expect at least one
duplicate stand-down command and one spurious reassignment per real incident until this
ordering is pinned down explicitly.

**7. Multi-tenant cost leakage through the shared pricing mechanism.** The zone-level
marginal-value price is derived from aggregate demand summed across all tenants sharing a
zone. One tenant's demand therefore raises the effective price every other tenant pays for the
same shared agent pool. For a tenant on a dedicated-fleet contract, this is a legitimate
billing dispute waiting to happen, and the tenant-isolation guarantees stated elsewhere in the
document do not currently extend to cover this kind of derived-price cross-tenant channel.

---

## Missing Topics

Concepts that should exist in a specification of this scope but currently do not.

| # | Missing topic | Why it matters |
|---|---|---|
| 1 | **A specified correctness core / tiering of obligations** | Without this, any partial implementation of the specification is unsafe by default, and the specification's own enormous scope makes a partial-first implementation all but certain. This is the single most important omission overall. |
| 2 | **Time-window and appointment scheduling as its own first-class problem** | Access windows are modelled as constraints on an already-created mission, but scheduled-delivery products require actively *choosing* a delivery window at order-creation time, weighed against projected future capacity — a materially different optimisation problem that is not addressed anywhere. |
| 3 | **Depot and dock capacity as an explicitly contended resource** | Chargers and maintenance bays are both explicitly modelled as contended, reservable resources; loading docks, lifts, and depot ingress/egress capacity are not, despite frequently being the actual throughput bottleneck at real operational scale. Lockers are mentioned as custodians in the future-modality discussion but never modelled as a capacity-constrained resource in their own right. |
| 4 | **Human operator capacity as an explicit, modelled constraint** | The escalation ladder routes to a human dispatcher at its final step, and teleoperator availability is mentioned as a constraint for autonomous-vehicle fallback — but the escalation path itself has no stated capacity model. Under any systemic failure, every affected mission would escalate to human operators simultaneously, with no throttling or triage mechanism specified. |
| 5 | **The assignment engine's own computational cost, as a term in its own objective** | Routing queries, solver time, and decision-record storage all have a real operational cost. Per-tenant routing-query budgets are mentioned as a resource-protection mechanism, but compute cost never actually enters the cost function itself, so the optimiser as specified is entirely indifferent to spending, say, ten times the routing budget in pursuit of a marginal 0.1% cost improvement. |
| 6 | **Weather and seasonal regime change as a planned, scheduled operating mode** | Forecast-service unavailability is handled as a degraded mode. Nothing handles the case of a *correct* forecast predicting conditions — first snowfall, a heatwave — that invalidate the fleet's currently-calibrated parameter set. This is a predictable, schedulable regime change and should be modelled as an explicit configured regime rather than left to be discovered only as an emergent degradation. |
| 7 | **Order modification and partial cancellation after custody is already held** | Full cancellation is handled thoroughly. Mid-mission address changes, item additions, and recipient rescheduling are common real-world requests and require their own defined re-planning semantics specifically for the case where custody has already been taken. |
| 8 | **Manual and teleoperated missions as a distinct lifecycle** | An agent under active teleoperation is neither genuinely available nor executing a mission the engine itself committed to. This is gated as a reservation against the feasibility model, but the actual lifecycle, accounting, and settlement of an operator-driven mission are left entirely undefined. |
| 9 | **Derivation of fleet-level service-level objectives from per-mission targets** | Only per-mission targets are specified. Nothing in the document derives, or reconciles per-mission targets against, an aggregate fleet-level availability or throughput commitment — so there is no way, using this specification alone, to answer the commercial question of whether a given new contract can actually be accepted. |
| 10 | **Validation of the fleet simulator against physical reality** | The simulator is specified as a release gate for the entire system. Nothing specifies how the simulator itself is validated against real-world outcomes, so a simulator that is systematically optimistic relative to reality would produce a systematically over-approved engine, with the release gate itself providing false confidence. |
| 11 | **A resolution for the conflict between PII erasure and exact decision replay** | Privacy handling requires supporting erasure requests for personally identifiable information. Decision-record replay requires bit-for-bit reproduction of historical decisions. Erasing a field that a stored decision record references would break that decision's replayability. The separation the privacy section proposes between identifying fields and technical record content needs to be specified precisely at the level of the actual decision-record schema, not merely asserted as a general principle. |

---

## Overall Assessment

| Dimension | Score (/10) | Justification |
|---|---|---|
| Engineering maturity | **7** | Strong problem framing; correctly identifies that the baseline's defects are structural rather than incidental; explicit non-goals, explicit invariants, explicit register of open decisions. Loses points for the absence of any obligation tiering and for asserting mathematical proofs it does not actually have. |
| Distributed systems quality | **6** | The chosen primitives — transactional outbox, epoch fencing, durable timers, single-writer-per-shard, and the CP-on-commit/AP-elsewhere split — are the correct primitives, correctly motivated from first principles. But the epoch mechanism is specified incorrectly for the target configuration, shard leadership is not transactionally enforced, at least one degraded mode directly contradicts the invariant register, and agent-side deduplication durability is unaddressed. The ideas are right; several of the load-bearing details are wrong. |
| Robotics realism | **7** | Custody modelling, the distinct stranded state, nonlinear charge curves, state-of-health tracking, thermal derating, per-agent efficiency self-calibration, aperture-versus-volume packing feasibility, and asymmetric trust in self-reported agent state are all clear evidence of genuine fleet-operations experience informing the design. Undercut by assuming inter-agent custody transfer capability that most fleets lack, trusting self-reported localisation confidence from the very subsystem that is failing, omitting cold-chain compartment load from the energy model, and not distinguishing an obstructing stranded robot from a merely inconvenient one. |
| Mathematical rigour | **5** | The lowest score, and the most consequential, because this is the dimension the document explicitly claims as a strength. The unit-discipline argument for absolute cost units is genuinely sound. But the solve formulation is invalid for the stated use case, the opportunity-cost term both double-counts and integrates over the wrong domain, the candidate-pruning lower bound is not actually admissible while an exactness guarantee is claimed from it regardless, the energy confidence level is wrong by roughly three orders of magnitude, and the validity of solver dual prices as calibration inputs is overstated. Five distinct errors, all located precisely in the sections that present themselves as the most rigorous. |
| Scalability | **6** | The locality argument and the region-based sharding decomposition built on it are correct in principle, and the falsifiable locality test is a genuine strength. But the shard sizing may contradict its own stated commit-transaction throughput budget by roughly 20×, depending on an unresolved ambiguity elsewhere in the document; decision-record write volume is entirely unsized; the return-leg routing query cost is unbudgeted; and at least one invariant-verification audit is specified as unbounded. The underlying scaling claim is defensible; the supporting arithmetic is currently incomplete. |
| Implementability | **4** | The weakest dimension overall. An enormous specification surface, no specified correctness core anywhere, at least ten distinct places where two competent engineers would reasonably implement materially different behaviour from the same text, and a substantial calibration burden with no assigned owner or timeline. The document effectively governs a multi-year engineering programme and does not state what must be true first before any of it can be safely built incrementally. |
| Production readiness | **3** | Not intended as a criticism of ambition — the document is explicitly and correctly framed as pre-implementation. But with six critical (P0) findings, an unowned calibration programme, and no defined correctness core, nothing in the current text is ready to be built against without revision first. |

---

## Final Answer

**No — this document, as currently written, would not be approved for implementation on a
real production fleet.**

The underlying design is not wrong in its fundamentals. Its diagnosis of the baseline
implementation it was derived from is accurate and goes deeper than that baseline audit
itself — correctly identifying that the use of absolute cost units, rather than the mere
absence of a delivery-leg distance term, is the actual structural defect being corrected is a
genuinely strong piece of analysis. Custody modelling, envelope-based degradation instead of
margin-based degradation, the transactional outbox, and durable state supervision are all the
right answers to real, well-understood problems in this domain. Attacking the architecture as
a whole did not produce a rejection; attacking the mathematical and concurrency details
underneath it produced six defects serious enough to block a build.

**What must change before implementation can responsibly begin, in strict priority order:**

1. **Fix the fencing model.** Split agent-scope authority from commitment-scope authority,
   key durable timers on each entity's own version rather than on the agent's shared epoch,
   and publish an explicit table mapping every command class to the fence scope that governs
   it. Nothing else in the system can be built correctly on top of a fencing mechanism that is
   broken for its own target configuration.
2. **Replace the solve formulation.** Either commit fully to strict single-capacity agents
   with all chaining expressed exclusively through pre-priced insertion columns, or commit
   fully to proper column generation with its actual consequences stated plainly. Remove the
   current claim that plain min-cost flow natively expresses agent queue capacity greater than
   one — it does not.
3. **Resolve whether SOFT commitments are durable,** and then re-derive shard sizing and the
   commit-transaction throughput budget from whichever answer is chosen.
4. **Rewrite the opportunity-cost and terminal-value section.** Eliminate the double count,
   correct the domain of integration, dimension every weighting coefficient explicitly, and
   either derive the underlying approximate-dynamic-programming formulation properly with a
   stated approximation-error bound, or honestly demote the mechanism to a simpler heuristic
   and drop the more ambitious framing.
5. **Fix the candidate-pruning lower bound** so that it is actually admissible, and make its
   admissibility a build-gate test rather than a sampled property. Until this is fixed, the
   exactness guarantee and the "proven optimality gap" recorded in every decision should be
   removed from the specification, since as currently defined they do not bound anything.
6. **Re-derive the energy-shortfall confidence levels** in composed, fleet-year terms with
   explicit consequence tiers, and restate the corresponding invariant's verification method
   accordingly.
7. **Add the shard leadership fence directly into the commit transaction's guard set,** so
   that leadership becomes a property the database itself enforces rather than something a
   coordinator merely believes about its own lease.
8. **Specify, for every invariant, its exact behaviour under every relevant degraded
   infrastructure mode,** and resolve the direct contradiction between the cached-lease
   supervision behaviour and the cache-authority architectural rule.
9. **Re-index the objective function over Legs rather than Missions,** and state the
   delay-cost attribution rule for multi-Leg missions explicitly.
10. **Add an explicit correctness-core section** stating the minimum subset of constraints,
    states, and mechanisms that must be correct for the engine to be *safe*, clearly
    distinguished from the larger set of mechanisms that merely make it *good*. Without this,
    the specification cannot be implemented incrementally in any principled way — and given
    its scope, it will not be implemented all at once either.

Resolving those ten items would earn approval. Items 1 through 3 and item 10 are the ones I
would not negotiate away under any schedule pressure: the first three because they are
outright errors in mechanisms the rest of the document depends on being correct, and the
tenth because a specification of this scope that does not state what must be true first is a
specification that will inevitably be partially implemented, in an order nobody actually chose
on purpose, with unsafe results.

---

**End of review.**

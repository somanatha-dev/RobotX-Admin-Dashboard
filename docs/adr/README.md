# Architecture Decision Log

**Status of every record in this log: `Accepted — frozen`.**

38 decisions, recorded verbatim from Appendix C of
`NEXT_GENERATION_ASSIGNMENT_ENGINE.md` during **Phase 0** of
`IMPLEMENTATION_EXECUTION_PLAN.md` on 2026-07-28.

---

## What this log is for

The architecture is frozen. Appendix C already records every decision, so this log is
not where the decisions were *made* — it is where each one becomes individually
addressable.

That matters for three things a table inside a 400 KB specification cannot do:

1. **Citation.** A code comment, test name, PR description, or review objection can
   say `ADR-04` and mean exactly one decision, with a stable link, rather than
   paraphrasing "the fencing thing".
2. **Rediscovery of the rejected option.** Every record states what was rejected and
   under which section. When an implementer proposes something during Phase 3 that
   turns out to be "cache lock as the guarantee", the log is what makes that visible
   as a decision already taken, not a fresh idea.
3. **Supersession discipline.** A frozen decision changes only by a new ADR that
   names the one it supersedes. Editing prose in place would erase the record of what
   was once true, which is precisely what a decision log exists to prevent.

## What this log is not

It is **not** a second specification. No record restates the reasoning, adds
qualification, or resolves ambiguity — all three belong to the numbered section each
record cites. Where a record and the specification appear to disagree, the
specification wins and the record is defective.

## Reading a record

| Section | Content |
|---|---|
| **Context** | Pointer to the authoritative specification section. Deliberately thin |
| **Decision** | The chosen option, verbatim from Appendix C |
| **Rejected** | The alternative that was considered and refused, verbatim |
| **Consequences** | The obligation this places on implementing phases |
| **Changing this record** | The supersession rule |

## Adding a record

During Phases 0–16, **you do not**. These 38 records are the complete set,
and the architecture is frozen. A new ADR is warranted only when a decision is taken
that Appendix C does not cover — an *integration* decision such as the ones
`IMPLEMENTATION_EXECUTION_PLAN.md` §6.1 lists as blocking, which choose how to meet
the architecture rather than what the architecture is.

Such a record is numbered from `33` upward, is marked `Accepted` rather than
`Accepted — frozen`, and states plainly that it is an integration decision under a
frozen architecture. It may never contradict a frozen record.

---

## The register

| ADR | Decision | Chosen | Rejected | Spec |
|---|---|---|---|---|
| [01](ADR-01-cost-representation.md) | Cost representation | Absolute additive CU with dimensioned exchange rates | Min-max normalised weighted sum | §1.3 |
| [02](ADR-02-decision-granularity.md) | Decision granularity | Rolling-horizon batch, indexed over Legs, with the fast path as a batch of one | Per-arrival greedy; full-horizon global optimisation; indexing the objective over Missions | §9.1, §1.4 |
| [02b](ADR-02b-solve-formulation.md) | Solve formulation | Set partitioning over marginally-priced columns, one column per agent per round; degenerates to an integral min-cost flow in the singleton regime | Capacity-`k` min-cost flow, whose arc costs are not separable once an agent holds two Legs | §9.3 |
| [02c](ADR-02c-opportunity-cost.md) | Opportunity cost | One primitive (`λ_zone`), integrated over the **origin** zone for unavailability plus a same-time terminal-value difference for relocation — an exact telescoping decomposition | Adding a route-domain shadow-price integral to an independently estimated cost-to-go difference, which double-counts and integrates over a domain with no physical meaning | §8.3 |
| [02d](ADR-02d-optimality-tolerance.md) | Optimality tolerance | Additive, in CU, reported as two separate gaps | A multiplicative ratio, undefined once costs can be negative | §6.4, §9.3 |
| [09b](ADR-09b-energy-shortfall-targets.md) | Energy shortfall targets | Three consequence tiers, governed as fleet-year event budgets, with per-mission `α` derived | A single per-mission probability covering outcomes whose consequences differ by orders of magnitude | §14.5 |
| [03](ADR-03-deferral.md) | Deferral | Priced arc in the optimisation | Terminal failure; unbounded retry | §8.8 |
| [04](ADR-04-exclusivity.md) | Exclusivity | Durable conditional write plus two-scope fencing: agent `authority_epoch` and per-commitment `fence` | Cache lock as the guarantee; a single per-agent epoch for both scopes, which is incorrect at `capacity > 1` | §10.3 |
| [04b](ADR-04b-leadership-enforcement.md) | Leadership enforcement | Leadership fence re-read and checked inside the commit transaction (guard G1) | A coordinator's own lease-renewal check as the sole protection | §10.3.2, §19.5 |
| [04c](ADR-04c-soft-reservation-durability.md) | SOFT reservation durability | Round-local in coordinator memory; reconstructed on failover; schema-forbidden in the store | Durable SOFT commitments, which exceed the shard's serial-commit budget by more than an order of magnitude | §2.6, §3.5 |
| [05](ADR-05-dispatch-reliability.md) | Dispatch reliability | Transactional outbox with mandatory ACK/NACK | Fire-and-forget emit | §11.1 |
| [06](ADR-06-missing-data-policy.md) | Missing-data policy | Three-valued logic with per-predicate policy plus systemic guard | Fail-open; blanket fail-closed | §7.3–7.4 |
| [07](ADR-07-lifecycle-supervision.md) | Lifecycle supervision | Durable timers plus a continuous reconciler | Per-defect patches; in-process timers | §4.5, §12 |
| [08](ADR-08-candidate-search.md) | Candidate search | Hierarchical with admissible lower-bound pruning | Fixed radius; unordered row limit | §6.4 |
| [09](ADR-09-battery-feasibility.md) | Battery feasibility | Probabilistic Wh model with layered reserves | Instantaneous percentage floor | §14.5 |
| [10](ADR-10-concurrency-control.md) | Concurrency control | Single writer per shard, serialisable commit | Multi-writer with optimistic retry | §19.3 |
| [11](ADR-11-routing.md) | Routing | Self-hosted with precomputed hierarchies | Metered external API in the hot path | §5.2, §20.3 |
| [12](ADR-12-scaling-strategy.md) | Scaling strategy | Region sharding exploiting locality | Global queue or global optimiser | §19.2 |
| [13](ADR-13-fairness.md) | Fairness | Priced wear plus a small duty-cycle regulariser | Large explicit fairness weight | §17.1 |
| [14](ADR-14-learning-boundary.md) | Learning boundary | Learning in estimation; classical solver for decisions | Learned end-to-end policy | §25.5 |
| [15](ADR-15-payload-model.md) | Payload model | Compartment model with tiered packing feasibility | Scalar capacity | §15.2–15.3 |
| [16](ADR-16-recovery-semantics.md) | Recovery semantics | Custody-aware: reassign, transfer, or physical recovery | Uniform requeue | §4.7 |
| [17](ADR-17-completion-trust.md) | Completion trust | Graded verification with plausibility checking | Trusted agent assertion | §12.5 |
| [18](ADR-18-leg-purpose.md) | Leg purpose | First-class `purpose` attribute driving the cancellation exemption, preemption bar, and shed order | An implicit "is this a recovery?" test reinvented at each call site | §2.4, §4.6 |
| [19](ADR-19-anti-starvation.md) | Anti-starvation | Structural guarantee from the escalation ladder; aging multiplier capped | Unbounded aging multiplier as the primary mechanism, which lets one aged Leg dominate a batch objective | §8.7, §17.4 |
| [20](ADR-20-degraded-operation.md) | Degraded operation | Named degraded-mode register plus a full invariant × mode matrix, with `SUSPENDED` as a first-class checker status | Cached-lease supervision, which would make the cache an authority and page continuously against I2 | §18.5, §26.2 |
| [21](ADR-21-e-return-availability.md) | `E_return` availability | Pinned previous-round charger availability projection with a stated conservatism margin | Live availability, which is circular and non-replayable; or nearest-geographic charger, which reintroduces stranding risk | §14.5 |
| [22](ADR-22-target-soc-ownership.md) | Target SoC ownership | Charging Scheduler owns and publishes; the engine consumes it and may submit priced requests | Engine-computed target, which duplicates the Scheduler's optimisation and desynchronises from it | §14.6, §14.7 |
| [23](ADR-23-agent-deduplication.md) | Agent deduplication | Durable across restart, with a generation counter and a session-establishment handshake | In-memory dedup, which makes at-least-once delivery re-execute after a routine power cycle | §11.5 |
| [24](ADR-24-decision-record-volume.md) | Decision-record volume | Two tiers: bounded always-on Tier A, sampled and budgeted Tier B, reconstructible by replay | Full-fidelity per-candidate retention for every decision, ~10 TB/day/region | §21.2 |
| [25](ADR-25-stranding-severity.md) | Stranding severity | `STRANDED_SAFE` / `STRANDED_OBSTRUCTING`, classified automatically from map hazard data | One stranded state and one response target for both a car park and a tram line | §4.3, §18.6 |
| [26](ADR-26-obligation-tiering.md) | Obligation tiering | An explicit correctness core: Tier 0 safety, Tier 1 operational integrity, Tier 2 quality, with no Tier 0/1 guarantee depending on a Tier 2 mechanism | Presenting every mechanism at one level of obligation, which guarantees a self-selected partial implementation | §1.8 |
| [27](ADR-27-command-emission.md) | Command emission | Every external side effect emitted only via an outbox row written in the same transaction as the guarded write authorising it — for the reconciler and supervisor, not only for dispatch | Bumping a fence and separately issuing the command, which produces duplicate stand-downs and commands carrying authority that does not exist | §4.1 rule 5, §12.4 |
| [28](ADR-28-spatial-hierarchy.md) | Spatial hierarchy | Region ⊃ zone ⊃ cell, with site orthogonal to zone; containment by published assignment, not by query-time geometry; zone admitted to the config scope hierarchy | Four spatial units with unstated containment, and the pricing unit absent from the hierarchy that resolves it | §3.6, §22.2 |
| [29](ADR-29-human-escalation.md) | Human escalation | Modelled capacity, triage order, and rate limiting on ladder steps 7–8, with saturation as its own escalation | An escalation path assuming it is reached one Leg at a time, which fails exactly under systemic failure | §17.4 |
| [30](ADR-30-erasure-versus-replay.md) | Erasure versus replay | Identifying values held only in a separate identity store behind a stable surrogate key; erasure tombstones the identity and leaves the technical record replayable; enforced by a build gate over an erased corpus | Asserting the separation as a principle and leaving the decision-record schema to interpret it | §23.7, §24.3 |
| [31](ADR-31-simulator-trust.md) | Simulator trust | One-sided fidelity gate on the simulator itself, measured per model against realised production distributions | A release gate that is itself unvalidated, whose characteristic failure is systematic optimism | §24.4 |
| [32](ADR-32-conservatism.md) | Conservatism | Every derating factor declares the uncertainty it compensates; the Config Service publishes the combined product and rejects it beyond a stated cap | Independently-chosen margins compounding invisibly to a fleet-wide conservatism nobody chose | §14.3 |

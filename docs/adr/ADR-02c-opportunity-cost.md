# ADR-02c — Opportunity cost

| Field | Value |
|---|---|
| **Status** | **Accepted — frozen** |
| **Recorded** | 2026-07-28 (Phase 0, from Appendix C) |
| **Specification** | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §8.3 |
| **Decision area** | Opportunity cost |

## Context

The architecture is frozen. This record is the durable, individually-citable form of
the decision Appendix C of the specification records — see
[`docs/adr/README.md`](README.md) for why the log exists and what "frozen" obliges.

The authoritative statement of the decision, its motivation, and its consequences is
§8.3 of the specification. This record does not restate, summarise, or
reinterpret that section; it fixes the decision's identity so that code, tests, and
review comments can cite `ADR-02c` and mean exactly one thing.

## Decision

**One primitive (`λ_zone`), integrated over the **origin** zone for unavailability plus a same-time terminal-value difference for relocation — an exact telescoping decomposition**

## Rejected

**Adding a route-domain shadow-price integral to an independently estimated cost-to-go difference, which double-counts and integrates over a domain with no physical meaning**

## Consequences

Binding on every phase of `IMPLEMENTATION_EXECUTION_PLAN.md`. An implementation that
reintroduces the rejected alternative is a defect against §8.3, not a design
variation, and is reverted rather than debated.

## Changing this record

This ADR is frozen. It is not amended, reworded, or reinterpreted by an implementing
phase. It is superseded only by a new ADR that explicitly states which record it
supersedes, and only after the architecture is deliberately unfrozen — a decision
outside the authority of any implementation phase.

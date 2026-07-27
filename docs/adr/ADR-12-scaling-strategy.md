# ADR-12 — Scaling strategy

| Field | Value |
|---|---|
| **Status** | **Accepted — frozen** |
| **Recorded** | 2026-07-28 (Phase 0, from Appendix C) |
| **Specification** | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §19.2 |
| **Decision area** | Scaling strategy |

## Context

The architecture is frozen. This record is the durable, individually-citable form of
the decision Appendix C of the specification records — see
[`docs/adr/README.md`](README.md) for why the log exists and what "frozen" obliges.

The authoritative statement of the decision, its motivation, and its consequences is
§19.2 of the specification. This record does not restate, summarise, or
reinterpret that section; it fixes the decision's identity so that code, tests, and
review comments can cite `ADR-12` and mean exactly one thing.

## Decision

**Region sharding exploiting locality**

## Rejected

**Global queue or global optimiser**

## Consequences

Binding on every phase of `IMPLEMENTATION_EXECUTION_PLAN.md`. An implementation that
reintroduces the rejected alternative is a defect against §19.2, not a design
variation, and is reverted rather than debated.

## Changing this record

This ADR is frozen. It is not amended, reworded, or reinterpreted by an implementing
phase. It is superseded only by a new ADR that explicitly states which record it
supersedes, and only after the architecture is deliberately unfrozen — a decision
outside the authority of any implementation phase.

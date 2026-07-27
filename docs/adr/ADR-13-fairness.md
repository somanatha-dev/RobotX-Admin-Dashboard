# ADR-13 — Fairness

| Field | Value |
|---|---|
| **Status** | **Accepted — frozen** |
| **Recorded** | 2026-07-28 (Phase 0, from Appendix C) |
| **Specification** | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §17.1 |
| **Decision area** | Fairness |

## Context

The architecture is frozen. This record is the durable, individually-citable form of
the decision Appendix C of the specification records — see
[`docs/adr/README.md`](README.md) for why the log exists and what "frozen" obliges.

The authoritative statement of the decision, its motivation, and its consequences is
§17.1 of the specification. This record does not restate, summarise, or
reinterpret that section; it fixes the decision's identity so that code, tests, and
review comments can cite `ADR-13` and mean exactly one thing.

## Decision

**Priced wear plus a small duty-cycle regulariser**

## Rejected

**Large explicit fairness weight**

## Consequences

Binding on every phase of `IMPLEMENTATION_EXECUTION_PLAN.md`. An implementation that
reintroduces the rejected alternative is a defect against §17.1, not a design
variation, and is reverted rather than debated.

## Changing this record

This ADR is frozen. It is not amended, reworded, or reinterpreted by an implementing
phase. It is superseded only by a new ADR that explicitly states which record it
supersedes, and only after the architecture is deliberately unfrozen — a decision
outside the authority of any implementation phase.

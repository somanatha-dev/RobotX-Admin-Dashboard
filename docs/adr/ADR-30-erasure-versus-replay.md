# ADR-30 — Erasure versus replay

| Field | Value |
|---|---|
| **Status** | **Accepted — frozen** |
| **Recorded** | 2026-07-28 (Phase 0, from Appendix C) |
| **Specification** | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §23.7, §24.3 |
| **Decision area** | Erasure versus replay |

## Context

The architecture is frozen. This record is the durable, individually-citable form of
the decision Appendix C of the specification records — see
[`docs/adr/README.md`](README.md) for why the log exists and what "frozen" obliges.

The authoritative statement of the decision, its motivation, and its consequences is
§23.7, §24.3 of the specification. This record does not restate, summarise, or
reinterpret that section; it fixes the decision's identity so that code, tests, and
review comments can cite `ADR-30` and mean exactly one thing.

## Decision

**Identifying values held only in a separate identity store behind a stable surrogate key; erasure tombstones the identity and leaves the technical record replayable; enforced by a build gate over an erased corpus**

## Rejected

**Asserting the separation as a principle and leaving the decision-record schema to interpret it**

## Consequences

Binding on every phase of `IMPLEMENTATION_EXECUTION_PLAN.md`. An implementation that
reintroduces the rejected alternative is a defect against §23.7, §24.3, not a design
variation, and is reverted rather than debated.

## Changing this record

This ADR is frozen. It is not amended, reworded, or reinterpreted by an implementing
phase. It is superseded only by a new ADR that explicitly states which record it
supersedes, and only after the architecture is deliberately unfrozen — a decision
outside the authority of any implementation phase.

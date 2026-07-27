# ADR-05 — Dispatch reliability

| Field | Value |
|---|---|
| **Status** | **Accepted — frozen** |
| **Recorded** | 2026-07-28 (Phase 0, from Appendix C) |
| **Specification** | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §11.1 |
| **Decision area** | Dispatch reliability |

## Context

The architecture is frozen. This record is the durable, individually-citable form of
the decision Appendix C of the specification records — see
[`docs/adr/README.md`](README.md) for why the log exists and what "frozen" obliges.

The authoritative statement of the decision, its motivation, and its consequences is
§11.1 of the specification. This record does not restate, summarise, or
reinterpret that section; it fixes the decision's identity so that code, tests, and
review comments can cite `ADR-05` and mean exactly one thing.

## Decision

**Transactional outbox with mandatory ACK/NACK**

## Rejected

**Fire-and-forget emit**

## Consequences

Binding on every phase of `IMPLEMENTATION_EXECUTION_PLAN.md`. An implementation that
reintroduces the rejected alternative is a defect against §11.1, not a design
variation, and is reverted rather than debated.

## Changing this record

This ADR is frozen. It is not amended, reworded, or reinterpreted by an implementing
phase. It is superseded only by a new ADR that explicitly states which record it
supersedes, and only after the architecture is deliberately unfrozen — a decision
outside the authority of any implementation phase.

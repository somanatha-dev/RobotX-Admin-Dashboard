# ADR-34 — Cutover rehearsal purpose

| Field | Value |
|---|---|
| **Status** | **Accepted** |
| **Recorded** | 2026-08-22 (Phase 15 remediation, resolving finding **D-7**) |
| **Kind** | **Integration decision under a frozen architecture** |
| **Specification** | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §22.3, §22.4 item 4, §22.5, §24, §1.8 rule 3 |
| **Decision area** | How `rollback_rehearsed` is discharged without weakening the release-gate set |
| **Owner** | Architecture, for the Phase 15 cutover contract |
| **Supersedes** | Nothing. Contradicts no frozen record. |

## Context

The architecture is frozen. This is **not** a record of a frozen Appendix C decision — it is
an *integration* decision of the kind [`docs/adr/README.md`](README.md) admits from number 33
upward: it chooses how to meet the architecture, not what the architecture is.

### The circularity

`rollback_rehearsed` is a **blocking** §24 release gate carrying `ORGANISATIONAL` evidence.
`docs/runbooks/rollback.md` §5 states what a discharging rehearsal must begin with:

> Take a **staging** shard live through the full §3 of `cutover.md`, including the
> pre-declaration.

Taking any shard live goes through `stage.authoriseEnable()`, whose **first** refusal is that
a blocking §24 gate is not `GREEN` — and `rollback_rehearsed` is a blocking gate.

**The rehearsal requires a cutover, and the cutover requires the rehearsal.**

There was no escape in the code, deliberately. `cutover/gates.js` records that there is no
`WAIVED` status because *"a gate that could be waived would be a route around the predicates
those classes protect"*, and `authoriseEnable`'s only override (`overrideOrder`) skips the
staging **order**, never a gate. The gate set was therefore unsatisfiable by any legitimate
sequence — demonstrated mechanically, not argued, in
`Backend/tests/engine/cutoverEvidence.test.js`: with fully admissible evidence for all
twenty-three other gates, the enable is refused by exactly `rollback_rehearsed
(NOT_EVALUATED)`.

### What was rejected, and why

Three obvious resolutions were considered and refused:

1. **Make `rollback_rehearsed` non-blocking.** This ships a cutover whose rollback has never
   been exercised. §22.5's argument applies directly: *"An untested kill switch is not a
   control; it is a second, less well understood code path that will be invoked for the first
   time during an incident."*
2. **Add a `WAIVED` status.** `gates.js` names this as the thing it must not have. A waiver is
   general by construction, and a mechanism that can set aside any gate will eventually be
   used to set aside the one that mattered.
3. **File an attestation for a rehearsal that has not happened.** This is the forgery the
   whole evidence contract exists to prevent, and `rollback.md` §5 already forbids it by name.

## Decision

**An `ENABLE` authorisation names its purpose, and a `REHEARSAL` against a declared
non-production environment excludes exactly the gate it exists to produce.**

The diagnosis is that `authoriseEnable()` was answering one question for two different acts:

- a **production cutover**, which takes a production shard live for real traffic; and
- a **rehearsal**, which takes a *staging* shard live in order to **produce** the evidence
  that `rollback_rehearsed` is about.

*"You may not take a shard live until the rollback has been rehearsed"* is exactly right for
the first and a category error for the second: it demands that the rehearsal be preceded by
its own output. Naming the purpose separates the two acts, and the separation — not a waiver —
is what removes the circularity.

Concretely, in `Backend/src/engine/cutover/stage.js`:

- `PURPOSE.PRODUCTION` is the **default** for a request naming no purpose, and its behaviour
  is unchanged in every respect. An unrecognised purpose is refused (`UNKNOWN_PURPOSE`) rather
  than defaulted, because the only thing a purpose can do is *reduce* the gate set.
- `PURPOSE.REHEARSAL` is refused unless the request declares
  `environment: { id, production: false }` (`REHEARSAL_REQUIRES_NON_PRODUCTION`).
- `REHEARSAL_EXCLUDED_GATES` is a named constant containing **exactly one** id,
  `rollback_rehearsed`. Every other blocking gate, the §1.8 rule 3 ship state, §22.3's
  two-person approval, the §22.4 guardrail pre-declaration and the staging order apply
  unchanged under `REHEARSAL`.
- The exclusion is applied **after** the whole table is evaluated, never by hiding the row
  from evaluation, and the resulting action carries `purpose`, `environment` and
  `gatesSetAside` (each with the status it held). A gate that were removed before evaluation
  would be a gate nobody could see had been set aside.

And in `Backend/src/engine/cutover/evidence.js`, the necessary other half:

- `rollback_rehearsed` is flagged `rehearsal: true` in the gate table, and `admit()` requires
  the record to carry the rehearsal itself — the environment (declared non-production), the
  published configuration version, and each of the six steps of `rollback.md` §5 **named
  individually**, plus `automaticRollbackFired`, because the runbook is explicit that what is
  under test is the guardrail controller and not the rollback API.
- The two signatures §22.3 requires remain necessary. They are no longer sufficient.
- The record ages by the same `maxAgeMs` rule every other record does, so a rehearsal cannot
  be performed once and cited indefinitely.

## Rejected

**A `WAIVED` gate status, a non-blocking `rollback_rehearsed`, or an attestation standing in
for a rehearsal that has not been performed.**

## Consequences

Binding on Phase 15 and Phase 16.

1. **No gate is weakened and no threshold moves.** A production cutover faces exactly the gate
   set it faced before this record. The mechanical demonstration of the circularity is
   retained as a test of `PURPOSE.PRODUCTION`, not deleted.
2. **The exclusion set may not be widened without a new ADR.** The argument above justifies
   excluding the gate a rehearsal *produces*, and generalises to nothing else. A test asserts
   `REHEARSAL_EXCLUDED_GATES` has exactly one entry, so widening it fails the build rather
   than passing review.
3. **A rehearsal authorisation is not a production enable credential.** The action records its
   purpose and its non-production environment, so a caller cannot publish a rehearsal's
   binding as a production one without the audit saying so, and `gatesSetAside` is empty for a
   production cutover *by construction* — a non-empty list is proof of a rehearsal rather than
   a label claiming to be one.
4. **Making the rehearsal performable did not make it forgeable.** The exclusion is only safe
   because the evidence it unblocks became checkable in the same change. Either half without
   the other would have been a defect: the exclusion alone moves the forgery one step along,
   and the record contract alone leaves the gate set unsatisfiable.
5. **`docs/runbooks/rollback.md` §5 is now performable as written.** Its ⚠ OPEN FINDING is
   replaced by the procedure, including the fields a discharging rehearsal record must carry.

## Changing this record

This is an integration record, not a frozen one. It is superseded only by a new ADR that
explicitly states it supersedes `ADR-34`, and only with the two-person approval §22.3 requires
for a change to the cutover contract. Widening `REHEARSAL_EXCLUDED_GATES`, admitting a
rehearsal in a production environment, or removing the rehearsal-record requirement are each
changes to this decision and not implementation details of it.

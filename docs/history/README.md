# HISTORICAL DOCUMENTATION — NOT CURRENT

**Nothing in this directory is current architecture authority.**

Every document here describes a system generation that has been superseded or **deleted outright**.
Several of them cite `file:line` locations for code that no longer exists in the repository. Read
none of them to find out how RobotX works today.

| If you want… | Read |
|---|---|
| **What RobotX is today** | [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) |
| **The architecture** (frozen) | [`../../NEXT_GENERATION_ASSIGNMENT_ENGINE.md`](../../NEXT_GENERATION_ASSIGNMENT_ENGINE.md) |
| **Architectural decisions** | [`../adr/`](../adr/) |
| **The plan of record** | [`../../IMPLEMENTATION_EXECUTION_PLAN.md`](../../IMPLEMENTATION_EXECUTION_PLAN.md) |
| **Current programme status** | [`../phase15/PHASE_15_MASTER.md`](../phase15/PHASE_15_MASTER.md) |

---

## Why these are kept rather than deleted

Three reasons, and none of them is sentiment:

1. **Rationale.** ADRs record *what* was decided and *what was rejected*. They deliberately do not
   restate the argument. For several frozen decisions — most directly **ADR-11** (self-hosted
   routing) and **ADR-12** (region sharding) — the argument survives only here.
2. **Provenance.** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` names
   `ASSIGNMENT_ENGINE_AUDIT.md` as the baseline it was written against. Deleting that audit would
   orphan the frozen specification's own premise.
3. **Auditability.** Some of these documents record findings, corrections, and reversals that are
   evidence about how the programme works, not just about what it built.

## What is NOT here

**`PHASE_*` reports for Phases 0–14 stay at the repository root.** The implementation reports, the
independent verification reports, the remediation-and-closure reports and the Phase 10 cost-scaling
pair are **current historical engineering evidence**, not superseded documentation. They were
deliberately not archived, merged, or renamed.

**Phase 15 is the exception, and it is not archived *here*.** On 2026-08-29 its fifteen reports —
which by then contradicted one another about the current state of the tree — were consolidated into
five canonical documents at [`../phase15/`](../phase15/), with all fifteen originals preserved
byte-for-byte at [`../phase15/archive/`](../phase15/archive/). That archive is separate from this
one on purpose: **this directory holds documentation of *deleted systems*, whereas the Phase 15
archive holds superseded reports about a system that very much still exists.** Start at
[`../phase15/PHASE_15_MASTER.md`](../phase15/PHASE_15_MASTER.md).

---

## ⚠️ A naming collision that was ended here

Two unrelated document families both called themselves "Phase 1":

| Family | Programme | Subject |
|---|---|---|
| `PHASE1_REVIEW.md`, `PHASE1_VERIFICATION.md` (no underscore before the digit) | **Legacy monolith hardening**, July 2026 | Production-readiness findings F1–F50 against the legacy DTARO monolith |
| `PHASE_1_IMPLEMENTATION_REPORT.md`, `PHASE_1_INDEPENDENT_VERIFICATION.md` (underscore) | **Execution plan**, Phase 1 of 16, July 2026 | Configuration service, units, determinism substrate |

They are different programmes, on different subject matter, one character apart. The legacy pair was
**renamed on archive** so the two can never be confused again. The execution-plan pair is untouched
and remains at the repository root.

---

## The archived documents

### `legacy-system-reference.md`
**Originally:** `system.md` · **Date:** 2026-07-28 (baseline commit `e558243`)

**What it described.** The complete file-level reference for the legacy DTARO monolith — the most
thorough document the project has ever had about its own runtime. 27 sections covering the module
catalog, PostgreSQL schema, the full Redis key map with TTLs, the Socket.IO room/event/auth
contract, every HTTP route group, background services, the telemetry pipeline, DTARO assignment,
robot and task lifecycles, recovery, the EKB and rerouting, the simulator, security, observability,
performance, scalability, known defects, configuration, and testing.

**Why it is no longer current.** Its §14 (DTARO assignment) documents
`taskAssignment.service.js`, `costEvaluator.service.js`, `robotValidator.service.js` and
`taskRecovery.service.js` as the live allocation path. **Those four modules were deleted by
Phase 15**, and `tools/gates/checkLegacyRetirement.js` now fails the build if any returns. Its
§1–§8 describe a process shape that has since gained 185 engine modules and 19 workers.

**Where its surviving information now lives.** [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) §3
carries forward the still-accurate host-platform material — the Redis key catalogue (all 21 key
families re-verified against current source), the three TTL philosophies, the `kv.js` facade
contract, the Socket.IO rooms and event vocabulary, the HTTP route groups, authentication and CORS,
the telemetry pipeline, the EKB and rerouting, the simulator, and the environment catalogue —
**with writer/reader attributions naming the four deleted modules dropped rather than carried
forward.**

**Read the original for:** the PostgreSQL schema walkthrough, the per-module catalog, the legacy
task/robot lifecycle state machines, the legacy recovery flow, and the §25 defect register — none
of which was migrated, because all of it describes the retired engine.

---

### `legacy-architecture-summary.md`
**Originally:** `FINAL_ARCHITECTURE_SUMMARY.md` · **Date:** 2026-07-28 (baseline `e558243`)

**What it described.** The short-form executive picture of the legacy monolith: what it was, how it
was built, what it had been measured to do, and where it was going. Diagrams plus a component
table.

**Why it is no longer current.** Its name notwithstanding, it was never architectural authority —
it was a *summary of a system that has since been dismantled*. Its component table lists
"DTARO allocation — `task.service` → `taskAssignment.service` → `robotValidator` + `costEvaluator`"
as a current component; three of those four modules no longer exist. It also presents measured
throughput as current capability, which is the most dangerous claim in the archived set: the system
that produced those numbers is gone, and the system that replaced it **has never executed a single
round.**

**Where its surviving information now lives.** [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) §3.1
carries forward its layered diagram (updated to show the engine as built-but-not-enabled), the
durable/live state-split rationale, the dependency-injection principle, and the
"cluster-capable but not clustered by default" characterisation.

---

### `legacy-assignment-engine-audit.md`
**Originally:** `ASSIGNMENT_ENGINE_AUDIT.md` · **Date:** 2026-07-28 (baseline `e558243`)

**What it described.** A forensic, line-traced specification of the legacy DTARO assignment engine
**as implemented** — explicitly descriptive, proposing no changes. Every statement traced to a
specific file and line, with explicit refusal to infer intent where the repository did not
establish behaviour.

**Why it is no longer current.** The engine it audits has been deleted.

**Why it must not be deleted.**
[`../../NEXT_GENERATION_ASSIGNMENT_ENGINE.md`](../../NEXT_GENERATION_ASSIGNMENT_ENGINE.md) names it
in its header as **the baseline the frozen architecture was written against**, and
`NEXT_GENERATION_ASSIGNMENT_ENGINE_REVIEW.md` does the same. `Backend/src/engine/ARCHITECTURE.md`
§1 opens by characterising it: *"The existing implementation is precisely the baseline the frozen
specification was written against."* This document is the frozen specification's premise. Removing
it would leave the architecture arguing against something no longer on record.

> **Note on the frozen specification's reference.** The spec refers to this document by its
> **original filename**, `ASSIGNMENT_ENGINE_AUDIT.md`. The specification is frozen and was not
> edited to follow the move. This entry is the redirect.

**Where its surviving information now lives.** The DTARO cost function and its weight vector —
`C(r) = w1·D + w2·(1−B/100) + w3·U + w4·T + w5·Z`, with `w1 = 0.50, w2 = 0.30, w3 = 0.15,
w4 = 0.05, w5 = 0.05` — are recorded in
[`legacy-scale-analysis.md`](legacy-scale-analysis.md) §6 as the model **ADR-01** replaced, and the
replacement rationale is in [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) §5. The four
architectural properties it identified in the legacy code (hard constraints separated from soft
preferences; live state overriding durable state; assignment asynchronous to the request;
exclusivity delegated to Redis) are traced to their frozen-architecture successors in
[`legacy-scale-analysis.md`](legacy-scale-analysis.md) §1.1.

---

### `legacy-architecture-proposal.md`
**Originally:** `ARCHITECTURE_PROPOSAL.md` · **Date:** 2026-07-26 (baseline `fa1024f`)

**What it described.** A 33-section target-architecture proposal for the legacy monolith, written
for technical design review. Its central argument inverted the instinctive sequencing: **fix the
data plane inside the current process first, reach horizontal scale as a modular monolith, and only
then extract services** — each extraction justified by a concrete scaling mismatch, not a folder
name. It declared itself as superseding `scale-architecture.md`.

**Why it is no longer current.** Its **diagnosis** was sound and its findings drove real decisions.
Its **plan** was not adopted: it proposed a Kafka-partitioned twelve-service catalogue with staged
extraction, Kubernetes deployment, and multi-region strategy. None of that was built, and the
frozen architecture specifies something different.

**Where its surviving information now lives.**
[`legacy-scale-analysis.md`](legacy-scale-analysis.md) preserves the B1–B4 blocking-property
analysis with its original evidence (§1), the "correct in form, dead in effect" defect pattern and
the four defects that demonstrated it (§2), the routing cost arithmetic behind **ADR-11** (§3), and
an explicit register of what it proposed that was **not** built (§6).

---

### `legacy-scale-architecture.md`
**Originally:** `scale-architecture.md` · **Date:** 2026-07-25

**What it described.** A target architecture for 10 million concurrent robots, with the arithmetic
to justify each decision, a proposed service catalogue, and a phased migration roadmap. Its opening
argument — that geo-sharding, not microservices, is the load-bearing decision — is its lasting
contribution.

**Why it is no longer current.** Explicitly superseded by `ARCHITECTURE_PROPOSAL.md`, which is
itself superseded. **Doubly superseded.** Its Kafka/MQTT/Kubernetes target was not built, and it
argued that the DTARO cost function should carry forward — which **ADR-01 rejected**.

**Where its surviving information now lives.**
[`legacy-scale-analysis.md`](legacy-scale-analysis.md) §4 preserves the 10M-robot arithmetic
**together with its original order-of-magnitude caveat**, and §5 preserves the geo-sharding thesis
behind **ADR-12**.

> **Its numbers are estimates, not measurements**, and the original document said so. They must
> never be quoted as capacity figures or guarantees.

---

### `legacy-phase1-hardening-review.md`
**Originally:** `PHASE1_REVIEW.md` · **Date:** 2026-07-26 (baseline `1d71a7d` + working tree)

**What it described.** A production-readiness review of the legacy monolith — 50 findings (F1–F50)
across 15 review areas, each with severity, location, current implementation, problem, real-world
impact, recommended solution, implementation steps, files affected, breaking changes, effort, and
priority. Its mandate was explicitly to *harden the existing monolith*: no microservices, no
brokers, no Kubernetes, no rewrite.

**Why it is no longer current.** The findings were addressed, and the system they targeted has since
been substantially replaced.

**Why it is still referenced.** Finding **F31** — *"Passkey step-up is not cryptographically
verified by anything"* — documented a WebAuthn ceremony that ran entirely in the browser, discarded
the public key at registration, and treated any truthy assertion as sufficient. It has since been
implemented properly with `@simplewebauthn/server`, and
`Backend/src/routes/auth.routes.js` carries a comment citing F31 as the provenance of that fix.
That comment was updated to point here.

**Where its surviving information now lives.** F1–F50 remain in the archived document; they were
not migrated, because they are findings against retired code. The current state of the control F31
concerned is described in [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) §3.7.

---

### `legacy-phase1-hardening-verification.md`
**Originally:** `PHASE1_VERIFICATION.md` · **Date:** 2026-07-26 (baseline `fa1024f` + working tree)

**What it described.** Verification of every F1–F50 finding above, plus every open item from
`system.md`, against the actual repository state.

**Why it matters more than a routine verification report.** Its **Round 3 changed the method**:
findings moved from being verified *by reading* to being verified *by executable test*, wherever
testable — on the reasoning that a verdict backed by a named test is materially stronger than one
backed by a `file:line` citation, because it re-runs on every commit. In the same round it issued
a **correction notice reversing three of its own earlier verdicts in both directions** — one marked
done that was inert in production, one marked missing that was half-landed, one marked missing that
had already been fixed.

That reversal is the origin of the current programme's insistence on mechanical gates over
inspection.

**Why it is no longer current.** It verifies findings against retired code.

**Where its surviving information now lives.**
[`legacy-scale-analysis.md`](legacy-scale-analysis.md) §2 preserves the "correct in form, dead in
effect" pattern, all four demonstrating defects, and the self-correction — including the document's
correction of its own prior claim.

---

### `legacy-scale-analysis.md`
**Originally:** synthesised during the documentation consolidation from
`ARCHITECTURE_PROPOSAL.md` and `scale-architecture.md`.

Not an archived original — a **new document written to preserve the surviving reasoning** from the
two archived scale documents in one place, so that the rationale behind ADR-11 and ADR-12 does not
require reading 250 KB of superseded proposal. It is marked historical, carries every original
caveat, and explicitly registers what was proposed but never built.

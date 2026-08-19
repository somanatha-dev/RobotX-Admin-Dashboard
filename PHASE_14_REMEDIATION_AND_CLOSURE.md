# Phase 14 — Adversarial Remediation, Re-Verification, and Closure

**Role:** Adversarial remediation and closure engineer. Did not implement Phase 14 and did not
write `PHASE_14_INDEPENDENT_VERIFICATION.md`.
**Date:** 2026-08-19 · **Branch:** `feature/dashboard` · **Baseline commit:** `1f4bfaf`
**Authorities:** `IMPLEMENTATION_EXECUTION_PLAN.md` (Phase 14 row, lines 685-708; checklist,
lines 1914-1931); `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §23.1-§23.7, §22.1 rule 5, §22.3, §22.4,
§21.2, §21.6, §24.3; `PHASE_13_REMEDIATION_AND_CLOSURE.md` for the inbound boundary.
**Evidence, not truth:** `PHASE_14_IMPLEMENTATION_REPORT.md` and
`PHASE_14_INDEPENDENT_VERIFICATION.md` were read in full and **not edited**. Every load-bearing
claim in both was re-executed against the current tree.

---

## 1. Final Status

# PHASE 14 — CLOSED

Closed on the evidence below, not on a green suite. **Fifteen** Phase-14-owned defects were found
and fixed, of which **eleven were not named by either historical report** and **three of the
eleven were live, permissive-direction security defects** — a control that could never fire, an
authorisation check that an ordinary configuration change disabled, and an agent able to expand
its own eligibility from its own telemetry.

The single fact that characterises this phase: **Phase 14 wrote nine guards, tested every one of
them, and called none of them from production.** `assertBound`, `assertNonIdentifying`,
`validateCompletion`, `validateHealth`, `validateCapability`, `validateCustody`,
`trustsSelfReport`, `rates` and `breaches` were all implemented, all unit-tested, all confirmed by
the independent verification as present and correct — and none had a production caller. A guard
that nothing calls is indistinguishable, from the outside, from a guard that works.

The two historical findings that mattered (Finding 2 and Finding 3) are resolved; Finding 1 is
recorded rather than edited, because the documents it names are frozen.

---

## 2. Baseline

Recorded before any change was made.

| Item | Value |
|---|---|
| HEAD | `1f4bfafa787fd0bed8b3c7a81f9eee9357469c24` ("Phase 12 closed") |
| Branch | `feature/dashboard` |
| Working tree at start | 14 modified files + 4 untracked paths, **all Phase 13 remediation work**, uncommitted |
| Migrations | 26 |
| Build gates | 7, all PASS |
| Jest | 150 suites / 6 685 tests / 0 failures |
| `ENGINE_ENABLED` | `false` in `.env`, `.env.benchmark`, `tests/setup/env.js` |
| `AGENT_MTLS_REQUIRED` | `false` in all three |

**A caveat stated rather than buried.** The full suite was first executed *after* the first fix
had landed, so the 6 685 figure includes 7 failures caused by that in-progress change. Every one
had the same stack (`prisma.identityRecord` absent from one test double) and every one was
resolved by extending the double, not by relaxing an assertion. The pre-change baseline is
therefore **150 suites / 6 685 tests / 0 failures** by inference rather than by direct
observation, and the inference is stated here so a reader can discount it.

**Tree context that changes how this phase must be read.** This repository is past Phase 15's
implementation: `git log` shows Phase 15 landed at `cbe540e`, and the phases are being closed
retrospectively. The four legacy services Phase 14's independent verification confirmed as "still
exist unmodified" have since been **retired** by Phase 15, and `gate:legacy` enforces their
absence. Phase-15 code in the tree is therefore expected; what must not have happened is Phase 14
*absorbing* Phase 15 scope, which §21 below verifies separately.

---

## 3. Scope

Phase 14 owns §23 in full plus the remaining §22 governance surface. This remediation treated the
phase as complete only if its **production composition** is complete — for every mechanism:

```
consumer  →  every input it reads  →  production producer  →  actual runtime caller
```

A value supplied by a test and not by production was treated as a defect until proven otherwise.
A module with no production caller was classified explicitly — intentionally deferred, Phase-14
defect, or external dependency — and never left as "harmless".

Out of scope, and left alone: Phases 0–13's frozen files, the specification, the execution plan,
the two historical Phase 14 reports, and every applied migration.

---

## 4. Ownership

| Area | Owner | Disposition |
|---|---|---|
| §23.2 mTLS, sessions, attestation | Phase 14 | Fixed (P14-R1, R8, R9, R11); one part routed (P14-X1) |
| §23.3 command integrity | Phase 14 | Verified unchanged; no defect found |
| §23.4 authorisation | Phase 14 | Fixed (P14-R3, R4) |
| §23.5 trust boundaries | Phase 14 | Fixed (P14-R1, R2, R14, R15) |
| §23.6 override discipline | Phase 14 | Fixed (P14-R5, R6) |
| §23.7 privacy | Phase 14 | Fixed (P14-R7, R10, R12, R13) |
| Two-person approval as a *workflow* | Not specified | OPERATIONAL — see §22 |
| Capability *consumption* path | Phase 15 | EXTERNAL — see §22 |
| `ConfigActiveVersion` schema drift | Phase 1 | EXTERNAL, pre-existing — see §22 |

---

## 5. Historical Findings Re-executed

### Finding 1 (Minor) — "thirteen columns" vs twelve · **CONFIRMED · NOT FIXED, deliberately**

Re-counted from the migration: 12 `ADD COLUMN` statements (`Stop` ×7, `Task` ×2,
`DecisionRecordA`/`DecisionRecordB`/`InputSnapshot` ×1 each). Verified live on PostgreSQL —
harness check **N1** queries `information_schema.columns` and asserts exactly 12, all nullable,
all without a default.

The overcount appears in `PHASE_14_IMPLEMENTATION_REPORT.md` (four places) and at
`migration.sql:3`. **Neither was edited**, for two different reasons that both bind:

- the implementation report is a frozen historical document (remediation rule 11);
- `20260809090000_security_governance_privacy/migration.sql` is an **applied** migration, and
  Prisma checksums applied migrations. Editing a comment inside one makes every existing
  deployment report the migration as modified after application (rule 13).

The correction is recorded here and is authoritative: **twelve**, not thirteen.

### Finding 2 (Moderate) — `surrogateKeys` never populated · **CONFIRMED, MUCH LARGER THAN REPORTED · FIXED**

The verifier's trace was correct and incomplete. Repository-wide search found that the column had
no production writer — and so did **every other part of §23.7's positive half**:

| §23.7 artefact | Production writer before this remediation |
|---|---|
| `IdentityRecord` (any row at all) | **none** — `identityStore.put()` was called only by `tools/migrate/backfillIdentities.js` |
| `Stop.identityKey` | **none** |
| `Stop.fineCell` and the five other derived quantities | **none** |
| `Task.originIdentityKey` / `destinationIdentityKey` | **none** |
| `DecisionRecordA/B.surrogateKeys`, `InputSnapshot.surrogateKeys` | **none** |

And the mechanism was not merely unwired, it was **unrunnable**: `PRIVACY_SURROGATE_SECRET` and
`PRIVACY_IDENTITY_KEY` were set in no environment file — not `.env`, not `.env.benchmark`, not
`tests/setup/env.js` — so the backfill, the only writer, threw on its first line in every
environment.

`backfillIdentities.js`'s own header stated that the five unresolved derived quantities are
"populated by the engine when it next plans against the Stop". No module in `src/` writes any of
them. That sentence was a handoff to a consumer that does not exist — the same defect shape the
Phase 10 and Phase 12 closures each found, and it has been corrected in the tool's header.

The specification decision is set out in full in §6. **Fixed** as P14-R7.

### Finding 3 (Cosmetic) — stale route comment · **CONFIRMED · FIXED**

`privacy.controller.js` documented `GET /api/privacy/erasure/:identityKey`; `privacy.routes.js`
mounts `GET /identity/:identityKey`. Comment corrected, with a note recording what it used to say.

---

## 6. Particular Requirement — Finding 2, the specification decision

**The question.** Does §23.7 require production-generated decision records and input snapshots to
actually contain surrogate keys plus derived non-identifying quantities, or is schema + gate
sufficient at Phase 14?

**The answer: YES for the surrogate keys, conditionally for the derived quantities.** The
implementation was completed rather than the checklist reworded.

### The three sentences the decision rests on

§23.7's schema rule opens with a **positive** statement, not a prohibition:

> **No decision record or input snapshot stores an identifying value directly.** Both store a
> **stable surrogate key** into a separate, access-controlled **identity store**, plus the
> *derived, non-identifying* quantities the decision actually consumed.

"Both store a stable surrogate key" is a requirement about what the record *holds*, and a record
holding `NULL` does not hold a stable surrogate key. Read alone this could be argued as a
substitution rule with nothing to substitute. It cannot be argued that way once the third bullet
is read:

> **What is lost after erasure is stated rather than discovered.** A replayed decision on an
> erased Task can no longer render a human-readable destination; the Explanation API returns the
> technical answer with the identifying fields marked `ERASED`. This is the correct trade and it
> is bounded, but **it must be visible to whoever later reads such a record in a dispute.**

This is unsatisfiable without the key. A decision record with `surrogateKeys = NULL` carries no
link to any subject, so a reader in a dispute sees neither the destination nor `ERASED` — they see
nothing, and cannot distinguish "this decision was about an erased subject" from "this decision
was about nothing". The requirement is not decorative: it is the one §23.7 explicitly says must
remain *visible*.

The implementation's own `schema.prisma` names the same purpose independently:

> The surrogate keys this decision's inputs referenced, so an erasure request can find every
> decision that pointed at a subject **without** reading — or holding — the subject.

Three independent statements of the same requirement, none of which the code satisfied.

### What was implemented

1. **`src/config/privacyKeys.js`** — one boundary where the two §23.7 secrets are read.
   `backfillIdentities.js` now delegates to it, so a Stop backfilled yesterday and a Stop created
   today mint the same key for one address. Both secrets refuse a default: an unkeyed digest over
   an address is reversible by enumeration, and a per-process default would destroy the
   *stability* the whole construction rests on.
2. **`task.service.sealIdentities()`** — the production producer, called from `admitToRound()`.
   Seals every Stop and both Task ends into `IdentityRecord`, writes back `Stop.identityKey`,
   `Task.originIdentityKey`, `Task.destinationIdentityKey`, and the one derived quantity §3.4's
   request path can honestly produce.
3. **`decisionRecord.surrogateKeysFor()`** — the single writer resolves the round's keys once per
   round (`O(1)` in Leg count) and carries them onto all three tables.
4. **The two secrets** added to `.env`, `.env.benchmark` and `tests/setup/env.js`.

### Every property the remediation brief demanded, and where it is proven

| Required property | Evidence |
|---|---|
| Deterministic derivation | Key is a keyed SHA-256 digest of the normalised natural id; live check **P1**, unit test "the same address submitted twice mints one identity record" |
| No identifying value enters the record | Live check **P2** scans all three written rows with `surrogateKeys.scan()` and asserts the raw addresses appear nowhere |
| Replay equivalence | Live check **P3**: Tier B `contentHash` **byte-identical** before and after erasing the subject |
| Erasure does not alter technical replay | Same check; and the column rides in `toRow`, outside `digest()` and outside `contentHash`, asserted by a source test |
| All production writers covered | `admitToRound` is the only path that creates a Stop; `decisionRecord.writeRound` is the only writer of the three record tables (its own header, re-verified) |
| No test-only producer remains | `identityStore.put()` now has a production caller; `privacyKeys` is the single env boundary |
| Reachability after erasure | Live check **P3** queries `DecisionRecordA` by `surrogateKeys array_contains` and finds the record from the *erased* subject's key |
| `ERASED` visible to a later reader | Live check **P4**: `erasure.redact()` returns `identityStatus: "ERASED"` |

### The boundary that is deliberately *not* closed, stated rather than discovered

Five of the six §23.7 derived quantities — the zone, the geofence result, the access-window class,
the service-time cohort, and the routing-graph node — are **not** written at intake, and this is a
decision rather than an omission. Each requires the routing graph, the geofence service, or the
service-time model. §3.4 is explicit that "no routing provider is consulted on the request path",
and each is a product of the round rather than of the submission. A derived quantity invented by
the intake path is a derived quantity nothing derived.

`fineCell` is written because it is a pure function of the coordinate (`spatial/cells.js`),
exactly as the backfill computes it.

**Owner:** Phase 15, at the cutover that first runs a round in production. **Blocks Phase 14: no**
— §23.7's requirement is that the record hold the quantities "the decision actually consumed", and
the decision path consumes none of the five today. **Does it matter: yes** — see §22, entry
P14-X2.

---

## 7. New Adversarial Findings

Eleven defects neither historical report named. Reproduction, root cause and fix for each are in
§9–§11; the ranked table is §8.

**P14-R1 · HIGH · the pinned configuration reached neither agent socket handler.**
`robot.handler.js` resolved it as `io?.engine?.config || socket?.request?.app?.locals?.config` and
`telemetry.handler.js` as `socket?.request?.app?.locals?.config`. Neither expression can ever
resolve: `io.engine` is the Engine.IO server and has no `config`; `socket.request` is the raw HTTP
upgrade request, which never passes through the express app and therefore has no `app` property at
all. Reproduced empirically with a real Socket.IO server and client — all four expressions
`undefined`. **Five registered parameters, three of them Safety-class, had no production
consumer.**

**P14-R2 · HIGH · §23.5's quarantine control could never fire.** Following from P14-R1, the
threshold reaching `trustBoundaries.persistentImplausibility()` was always `undefined`, which the
function defaults to `Infinity` — so `rejections < threshold` is always true and `quarantine` is
always `false`. §23.5's closing sentence, "Persistent implausibility triggers quarantine and a
security event", was unreachable in every deployment. **This path is not `ENGINE_ENABLED`-gated**:
the `SECURITY_EVENT` broadcast sits outside the flag, so it was meant to be live and was not.
Compounding it, the capability-claim branch called `recordImplausibleReport(robotId)` with **no
threshold argument at all**, so an agent could send capability claims without limit.

**P14-R3 · HIGH · an empty elevated-role list admitted everybody.** Both `authoriseWaiver()` and
`authoriseAction()` wrote `elevated.length > 0 && !elevated.includes(role)`, so an empty list
skipped the role check entirely. `security.elevated_roles` is a registered `set` with
`"range": {}` — `[]` is a publishable value, and publishing it reads like the most restrictive
change available. It opened all four of §23.4's highest-privilege action classes to every
authenticated role. The same module's `outOfScope()` had the opposite, correct semantics
documented in its own header ("an empty *array* means the opposite and is honoured as such"), and
`requireElevatedRole()` had them too — the module disagreed with itself in two places out of three.

**P14-R4 · MODERATE · the manual-assignment gate could be walked past.**
`gateManualAssignment` applied the action-class gate only when the body carried a waiver **and**
named an agent. A request carrying `waivePredicate` alone skipped it — no elevated-role check, no
recorded reason, no audit row. Composed with P14-R3 (the controller evaluated the waiver against a
hard-coded `{ elevatedRoles: [] }`), any authenticated caller could obtain a granted class-P or
class-C waiver.

**P14-R5 · MODERATE · waiver decisions were never audited.** `override.js`'s own header states
"Refusals are audited too. A refused class I waiver is exactly the event a later investigation
wants to find". Neither of the two `authoriseWaiver()` call sites wrote an audit row.
`OverrideAudit.predicateId` and `.constraintClass` had **no production writer anywhere**, so
§23.6's per-predicate override rate read an empty column by construction.

**P14-R6 · MODERATE · the override-rate monitor had no caller.** `override.rates()` and
`breaches()` — checklist item 9, and §23.6's fifth row — were called by nothing. Three registered
parameters had no consumer.

**P14-R8 · MODERATE · `session:{agentId}` held two different kinds of thing and compared one as
the other.** §23.2's binding replaced the bearer token *in the same Redis key*, on the stated
argument that reusing the namespace stops both schemes being alive at once. What it produced was a
type confusion: an agent that established an mTLS session wrote a JSON binding to
`session:{agentId}`, and the legacy branch then compared that JSON **as a shared secret** against a
caller-supplied `token`. The binding is not a secret — it names a certificate fingerprint, which
is public. Anyone holding it could authenticate as that agent without a certificate whenever
`AGENT_MTLS_REQUIRED` was false. Exploitation additionally requires the binding's `certificateId`
(a UUID not published in `AUTH_SUCCESS`), which is why this is MODERATE and not HIGH.

**P14-R9 · MODERATE · `sessionBinding.assertBound()` had no production caller.** Its own header
says it is "checked on every command delivery, not only at establishment". It was checked nowhere.
The property it guards holds today for a different reason — every socket handler reads
`socket.data.robotId` and none trusts a payload-supplied agent id, independently verified — so
this was latent rather than exploitable. A guard nothing calls is a guard nobody will notice has
stopped working.

**P14-R12 · HIGH · §23.7's storage rule was enforced by nothing at runtime.**
`surrogateKeys.assertNonIdentifying()`'s own docstring reads: "This is the schema rule of §23.7
expressed as a runtime guard, and **it is applied where the rule is stated to bind: the decision
record and the input snapshot**." It was applied at neither. It was reachable only from
`reference()`, which no production code calls. Neither build gate covers the gap:
`checkIdentityIsolation` is a **static scan of module sources** for identifying field *names*, so
it catches `candidate.stop.address` written literally in one of sixteen modules and nothing that
arrives at runtime; and the erasure gate fails only on a field whose erasure *changes a replayed
cost*. A value reaching a record through the Overrides section, the Predictions section, the
outcome's free-form `detail`, or the snapshot's `pins` was written to the database unchecked by
anything.

**P14-R13 · MODERATE · the erasure gate passed a corpus containing a street address.** Discovered
by planting one. §23.7 states two rules and the gate implemented one: the byte-for-byte rule
catches a field whose erasure *changes a replayed cost*, and says nothing about a field that is
merely **stored**. Planting `12 Acacia Avenue` into a Tier A section no cost reads produced
`erasure removed 1 identifying field(s)` — **and exit code 0**. §23.7's first bullet was enforced
at build by nothing.

**P14-R14 · MODERATE · §23.5 row 3 was decided by Phase 5's rule, not by §23.5's module.** The
plan's Phase 14 testing requirements name the outcome directly: "a completion claim from a
kinematically unreachable position is rejected and **raises a security event**".
`trustBoundaries.validateCompletion()` implements it and had no production caller. Phase 5's
`verification.verify()` did set, log and persist a `securityEvent` flag, so this is less severe
than it first appears — what was missing is the §23.5 decision itself and any *raised* event
comparable to the one persistent implausibility emits.

**P14-R15 · HIGH · an agent could expand its own eligibility from its own telemetry.** §23.5 row
4: "Health / self-report | Accepted for **restricting** the agent … but never for **expanding**
eligibility", followed by "This asymmetric trust rule applies to **every** agent-reported field."
The telemetry status path applies a self-reported status through a symmetric transition table:
`TRANSITIONS.ERROR` admits `IDLE` and `ACTIVE`, so **an agent in a fault state could clear its own
fault by reporting itself healthy**. `Robot.status === "ERROR"` is the field the operator
fault-recovery route reads to decide an agent is withdrawn, and returning to service is supposed
to be a `QUARANTINE_OVERRIDE`-gated operator action. `trustBoundaries.validateHealth()` was
written for exactly this row and had no production caller.

---

## 8. Severity / Owner / Status

| ID | Severity | Category | Owner | Status |
|---|---|---|---|---|
| P14-R1 | **HIGH** | Composition — config unreachable | Phase 14 | **FIXED** |
| P14-R2 | **HIGH** | Security control inert (permissive) | Phase 14 | **FIXED** |
| P14-R3 | **HIGH** | Authorisation bypass by config | Phase 14 | **FIXED** |
| P14-R12 | **HIGH** | Privacy guard uncalled (permissive) | Phase 14 | **FIXED** |
| P14-R15 | **HIGH** | Trust boundary uncalled (permissive) | Phase 14 | **FIXED** |
| P14-R4 | MODERATE | Authorisation gate bypass | Phase 14 | **FIXED** |
| P14-R5 | MODERATE | Audit completeness (§23.6) | Phase 14 | **FIXED** |
| P14-R6 | MODERATE | Monitoring uncomposed (§23.6) | Phase 14 | **FIXED** |
| P14-R7 | MODERATE | §23.7 positive half uncomposed | Phase 14 | **FIXED** |
| P14-R8 | MODERATE | Credential type confusion | Phase 14 | **FIXED** |
| P14-R13 | MODERATE | Build gate under-scoped | Phase 14 | **FIXED** |
| P14-R14 | MODERATE | §23.5 row 3 uncomposed | Phase 14 | **FIXED** |
| P14-R9 | LOW | Guard uncalled (latent) | Phase 14 | **FIXED** |
| P14-R10 | LOW | False handoff claim in a tool header | Phase 14 | **FIXED** |
| P14-R11 | LOW | Worker session provider stubbed | Phase 14 | **FIXED** |
| Finding 1 | COSMETIC | Documentation precision | Phase 14 | **RECORDED** (frozen documents) |
| Finding 3 | COSMETIC | Stale route comment | Phase 14 | **FIXED** |
| P14-X1 | — | Attestation consumption path | **Phase 15** | **EXTERNAL** |
| P14-X2 | — | Five derived quantities | **Phase 15** | **DEFERRED**, owned |
| P14-X3 | — | Second approver not produced | Not specified | **OPERATIONAL** |
| P14-X4 | — | First-fix position INDETERMINATE | Phase 14 | **DEFERRED**, documented |
| P14-X5 | — | `ConfigActiveVersion` schema drift | **Phase 1** | **EXTERNAL**, pre-existing |

---

## 9. Root Cause

Three causes account for all fifteen.

**One: a seam that does not exist reads exactly like one that does.** P14-R1 is the purest case.
`socket?.request?.app?.locals?.config` is syntactically valid, semantically plausible, matches the
express idiom used correctly elsewhere in the same codebase, and evaluates to `undefined` on every
request. Optional chaining converted a structural error into a silent default. No unit test can
observe it, because a unit test supplies the object the production path never receives — which is
precisely the "value supplied by tests but not by production" the brief instructs to treat as
suspicious. P14-R2 is entirely downstream of it.

**Two: a guard is finished when it is written, not when it is called.** Nine guards, nine unit
test suites, zero production callers. Every one was confirmed present and correct by the
independent verification, and being present and correct is what it checked. The phase's
composition was never traced consumer-to-producer, so a module could be complete, tested, verified
and inert simultaneously.

**Three: the permissive default, chosen three times independently.** `elevated.length > 0 &&`
(P14-R3), `threshold ?? Infinity` (P14-R2), and the symmetric transition table (P14-R15) each
resolve a missing or ambiguous input toward *permission*. The codebase has an explicit tenet
against this — "unknown is never permission (T2)" — quoted verbatim in `override.js` and
`attestation.js`, in the same files that then violate it. The tenet was applied to *unknown
enumeration values* and not to *unresolved configuration*, and nothing checked the second case.

---

## 10. Reproduction Evidence

Every defect was reproduced before it was fixed.

**P14-R1** — a runnable script (`scratchpad/repro_socket_config.js`) starting a real express app,
HTTP server, Socket.IO server and client:

```
{ "io.engine.config": "undefined",
  "socket.request.app": "undefined",
  "socket.request.app.locals.config": "undefined",
  "resolved deps.config": "undefined",
  "configNumber(security.session_max_age)": "undefined" }
```

**P14-R2** — `persistentImplausibility({ agentId, rejections: 9999 })` with no threshold returns
`{ quarantine: false }`. Pinned as a regression test.

**P14-R3** — `authoriseWaiver` with `{ elevatedRoles: [] }` granted a class-P waiver to
`SUPER_ADMIN`, `ADMIN`, `VIEWER`, `undefined` and `null` alike. Pinned as a five-role loop.

**P14-R4/R5** — source-level reproduction; both are structural (a missing condition, a missing
call), pinned by source assertions that name the exact prior expression.

**P14-R7** — repository-wide search returned zero production writers for six columns and one
table; `grep -rn "PRIVACY_" ` returned only the backfill tool, proving the mechanism unrunnable.

**P14-R12** — `writeRound()` with an address in the Overrides section wrote the row without
complaint. Pinned by three tests using the three wholesale-passthrough routes (Overrides,
Predictions, snapshot `pins`) and asserting nothing is written.

**P14-R13** — planted `12 Acacia Avenue` into `tests/fixtures/replayCorpus/`:

```
PASS — 3 corpus decision(s) … erasure removed 1 identifying field(s) … and changed no replayed cost
exit=0
```

The corpus was restored immediately; `git status tests/fixtures/` is clean.

**P14-R15** — read directly from the transition table:
`TRANSITIONS.ERROR = new Set(["IDLE","ACTIVE","OFFLINE","ISSUES"])`, applied at
`telemetry.handler.js` with no trust-boundary check between.

---

## 11. Remediation

| ID | Fix | Files |
|---|---|---|
| P14-R1 | `appLocals` threaded from `server.js` → `socket.server.js` → all three agent handlers, read at call time so a republished snapshot is picked up | `server.js`, `socket.server.js`, `robot.handler.js`, `telemetry.handler.js`, `dtaro.handler.js` |
| P14-R2 | `persistentImplausibility()` returns `thresholdConfigured`; one `emitPersistentImplausibility()` serves both refusal paths and logs loudly when the control is off; the capability path now passes the threshold | `trustBoundaries.js`, `telemetry.handler.js` |
| P14-R3 | `roleAdmitted()`: a **present** list is authoritative, empty or not; only an **absent** one is unscoped. Both controllers now pass `policyFor(req)` | `override.js`, `tasks.controller.js`, `robots.controller.js` |
| P14-R4 | The gate fires on `waivePredicate` alone | `tasks.routes.js` |
| P14-R5 | Both waiver call sites call `recordAuthorisation()`, populating `predicateId`/`constraintClass` | `tasks.controller.js`, `robots.controller.js` |
| P14-R6 | Fourth pass on Phase 14's own periodic worker; findings surfaced through `onOverrideRateFinding`, logged, **never acted on** | `certificateRotation.worker.js`, `server.js` |
| P14-R7 | See §6 | `privacyKeys.js` (new), `task.service.js`, `decisionRecord.js`, `tierA.js`, `tierB.js`, `backfillIdentities.js`, 3 env files |
| P14-R8 | `isCertificateBinding()` refuses a stored binding as a bearer token, by name and with a log line | `robot.handler.js` |
| P14-R9 | `assertBound()` called on the heartbeat path, all three components; `now` deliberately omitted so an expired session is *rekeyed* rather than dropped | `robot.handler.js` |
| P14-R10 | The false handoff claim corrected in place | `backfillIdentities.js` |
| P14-R11 | Real session provider enumerating this process's sockets | `server.js` |
| P14-R12 | `assertNonIdentifying()` applied to all three row shapes before each write | `decisionRecord.js` |
| P14-R13 | The erasure gate fails on an identifying value stored in `tierA`, scoped to decision records — `reconstructionInput` is the harness's own bundle and stays reported-only | `replayDecision.js` |
| P14-R14 | `validateCompletion()` composed with a `validatePosition()` of the claimed position; `SECURITY_EVENT` broadcast on the same channel persistent implausibility uses | `dtaro.handler.js` |
| P14-R15 | `validateHealth()` applied to the status transition, staged **exactly as §23.5's position and energy rows already are** — logged now, enforced at cutover | `telemetry.handler.js` |

**Nothing was weakened.** No test deleted, skipped or relaxed; no threshold moved; no gate
loosened. Two gates were made *stricter* (P14-R13, and the runtime guard P14-R12). One test double
was extended — `intakeStranglerSeam.test.js` gained `identityRecord`, `stop.update` and
`task.update` because the production path now uses them — and three assertions were **added** to
that file, none removed.

**On P14-R15's staging, explicitly.** Enforcing immediately would mean a real robot recovering
from a fault could no longer clear its own `ERROR` state, requiring an operator action per
recovery. That is what §23.5 requires and it is a live operational change. Rather than invent a
staging rule, the fix adopts the one Phase 14 already chose and documented for the position and
energy rows of the same table: computed and logged while `ENGINE_ENABLED` is false "so the refusal
rate is observable before it is load-bearing", enforced at the same cutover. This is the phase's
own disposition applied to the row it was not applied to.

---

## 12. Production Composition

Traced consumer → input → producer → runtime caller for every Phase 14 mechanism. **After
remediation:**

| Mechanism | Consumer | Producer | Runtime caller | State |
|---|---|---|---|---|
| Session binding | `sessionBinding.establish` | peer cert (TLS / `x-client-cert` / auth payload) | `robot.handler` AUTH | ✅ |
| Session parameters | `establish`, `recheck`, `rekey` | `app.locals.config` | via `appLocals` (P14-R1) | ✅ |
| Binding assertion | `assertBound` | `socket.data.certificateBinding` | heartbeat (P14-R9) | ✅ |
| Periodic revocation | `recheck` | heartbeat **and** worker sweep | both (P14-R11) | ✅ |
| Capability rejection | `findCapabilityClaims` | AUTH + TELEMETRY payloads | both handlers | ✅ |
| Capability *admission* | `capabilitiesFrom`, `verify` | — | **none** | **P14-X1** |
| Command signing | `sign`/`verify` | `COMMAND_SIGNING_KEY` | `offers.js`, `membership.js`, `VirtualRobot` | ✅ |
| Trust: position, energy | `validatePosition/Energy` | telemetry + config | `telemetry.handler` | ✅ |
| Trust: completion | `validateCompletion` | verification result + claimed position | `dtaro.handler` (P14-R14) | ✅ |
| Trust: health | `validateHealth` | reported status | `telemetry.handler` (P14-R15) | ✅ |
| Trust: capability | `validateCapability` | — | none (enforced equivalently by `findCapabilityClaims`) | ✅ by equivalence |
| Trust: custody | `validateCustody` | — | none — no custody-sensing hardware exists | **P14-X6**, see §22 |
| Persistent implausibility | `persistentImplausibility` | threshold from config | `telemetry.handler` (P14-R1/R2) | ✅ |
| Waiver authorisation | `authoriseWaiver` | `policyFor(req)` | 2 controllers (P14-R3) | ✅ |
| Action authorisation | `authoriseAction` | `policyFor(req)` | 4 gated routes (P14-R4) | ✅ |
| Override audit | `toOverrideAuditRow` | waiver + action decisions | middleware + 2 controllers (P14-R5) | ✅ |
| Override rates | `rates`/`breaches` | `OverrideAudit` rows | worker tick (P14-R6) | ✅ |
| Identity minting | `identityStore.put` | intake, backfill | `admitToRound` (P14-R7) | ✅ |
| Surrogate keys on records | `surrogateKeysFor` | `Stop.identityKey` | `writeRound` (P14-R7) | ✅ |
| Storage rule | `assertNonIdentifying` | assembled rows | `writeRound` ×3 (P14-R12) | ✅ |
| Erasure | `erasure.apply` | REST + retention sweep | controller + worker | ✅ |

**Redis.** `session:*` reused with its contents replaced, and the two contents are now
distinguishable (P14-R8). `pairing:*`, `pairingAttempts:*`, `pairingLocked:*` retained for
commissioning. No new namespace introduced by `security/` or `privacy/` — both are
Postgres-backed. Certificate data remains DB-authoritative; the cache holds session state only.

**Socket.IO.** Every event traced producer → wire → consumer: `AUTH_SUCCESS`/`AUTH_OK` carry the
session descriptor; `SESSION_REKEY` is emitted from the heartbeat and `SESSION_REKEY_ACK` handled;
`SECURITY_EVENT` is broadcast to the dashboard room for `PERSISTENT_IMPLAUSIBILITY` and — new —
`UNREACHABLE_COMPLETION_CLAIM`, both on the same channel so a consumer handling one handles both.
A capability claim in a `TELEMETRY` frame drops the frame with an early `return`, re-confirmed as
not gated behind `ENGINE_ENABLED`.

---

## 13. Database Verification

**Live PostgreSQL 18.3**, disposable cluster on port **55432**, built from installed binaries into
a scratch directory. Never Neon, never `DATABASE_URL`'s production database, never port 5432 — the
harness refuses to start against either. Complete migration chain applied **from empty**: 26
migrations, "All migrations have been successfully applied."

`tools/verify/phase14LiveDatabase.js` — **55 checks, 55 passed, 0 failed.**

| Group | Checks | Covers |
|---|---|---|
| A | 10 | `AgentCertificate`: all 4 CHECKs fired, both unique indexes, the self-referential FK, full lifecycle ACTIVE → SUPERSEDED → REVOKED |
| B | 3 | `CapabilityAttestation`: both CHECKs fired; a rejected attestation persists |
| C | 14 | `OverrideAudit`: **granted class I, R and F each refused by the database**; refusal rows for all three **accepted**; class P grant accepted; the other 5 CHECKs fired |
| D | 7 | `IdentityRecord`: surrogate-key shape, subject type, classification, half-sealed row, **the tombstone rule**, unique key |
| E | 9 | Erasure end to end: seal → audited resolve → unaudited read refused → dry run → tombstone → `ERASED` ≠ `NOT_FOUND` → backfill cannot undo → idempotent → **the put/tombstone race closed by the CHECK** |
| P | 4 | §23.7 production composition: intake seals → writer carries keys to all three tables → erasure leaves `contentHash` byte-identical and the record still reachable → `ERASED` rendered |
| N | 3 | 12 added columns all nullable with no default; an unset column reads `null` not `[]`; all 16 CHECKs present |
| X | 4 | Concurrency (§16) |

Three results deserve to be named individually.

**C1–C3.** The phase's central safety claim, made a fact about the database. A granted override
row against class I, R or F is refused with SQLSTATE 23514 naming
`OverrideAudit_absolute_classes_never_granted` — verified for each class separately, judged on
PostgreSQL's own SQLSTATE and constraint name rather than on a substring of the harness's source.
C4–C6 confirm the complementary property that matters just as much: a **refusal** row against
those classes is accepted, because that is the row an investigation wants.

**E9.** `identityStore.put()` reads the row, finds it unerased, and writes ciphertext — a
read-then-write it cannot close on its own. Issuing exactly that `UPDATE` against a tombstoned row
is refused by `IdentityRecord_erased_has_no_ciphertext`. The race is closed by the store, not by
the code path's discipline.

**P3.** Tier B's `contentHash` is **byte-identical** before and after the subject is erased, and a
query by `surrogateKeys array_contains` still finds the decision record from the erased subject's
key. That is §23.7's central tension — erasure versus exact replay — resolved and measured rather
than asserted.

**Schema drift.** `prisma migrate diff` against the freshly built database reports exactly one
difference: `ConfigActiveVersion_version_fkey`, created by
`20260728093000_config_registry_and_governance` (Phase 1) and not modelled in `schema.prisma`. The
database is *stricter* than the datamodel. Pre-existing since 2026-07-28, unrelated to Phase 14,
recorded as **P14-X5** with Phase 1 as owner.

---

## 14. Security Verification

**Class I/R/F absoluteness, re-derived from scratch at three layers.**

1. `override.js` — the class check returns before `actorId`, `reason` or role is read.
   Independently re-verified **and strengthened**: the new test loops all three absolute classes
   against four different policies (`[]`, populated, `{}`, `null`) and asserts
   `CLASS_NOT_WAIVABLE` every time, so P14-R3's change to the role semantics provably cannot make
   an absolute class negotiable in either direction. `assertAbsolutes()` runs at `require()` time.
2. The database — C1–C3 above, on live PostgreSQL, plus **X3**: four concurrent granted class-I
   inserts, 0 accepted, 0 rows in the table. The CHECK is not racy.
3. `feasibility/evaluate.js` — re-grepped for `skipPredicates`, `waivePredicate`,
   `waivedPredicates`, `manualOverride`, `bypass`. Matches appear only in the header comment
   describing their absence. `src/engine/feasibility/` is untouched by this remediation.

**Bypass paths attempted:** missing actor (refused, `NO_IDENTITY`), fake actor (refused before the
actor is read), elevated actor (refused before the role is read), malformed class (`UNKNOWN_CLASS`),
unknown class (same), direct database insertion (C1–C3), direct service invocation (the class
check is the first statement), direct feasibility invocation (no bypass parameter exists), forged
audit row (`OverrideAudit_refusal_reason_consistent` and `_granted_has_reason` both fired),
concurrent request (X3).

**mTLS / session binding.** Certificate → fingerprint → agent binding → session id → revocation →
periodic re-check → rekey, traced end to end. Wrong certificate: `CERTIFICATE_AGENT_MISMATCH`.
Revoked: `CERTIFICATE_REVOKED`, checked **before** expiry so a withdrawal is never reported as a
routine rotation. Expired / not yet valid: distinct refusals. Wrong agent, wrong session, wrong
fingerprint: all three compared by `assertBound`, now called (P14-R9). Malformed certificate:
`fingerprint()` returns `null` → `NO_CERTIFICATE`. Three transports (TLS `getPeerCertificate`,
`x-client-cert` header, simulator auth payload) all supported. Certificate-less with
`AGENT_MTLS_REQUIRED=true`: refused, and the pairing branch refuses **by name** rather than
falling through. Certificate-present with the flag false: still validated and bound. **Rekey
attempting to change agent identity: structurally impossible** — `rekey()` takes no `agentId` and
inherits it from the prior binding, re-verified by reading the signature.

**Capability attestation.** Telemetry payload: frame **dropped**, not stripped, before any field
is applied, and now counted against the §23.5 threshold (P14-R2). Forged simulator payload, another
agent's attestation, wrong agent id: `AGENT_MISMATCH`, because the agent id is inside the signed
canonical manifest. Expired / stale: two independent bounds (`notAfter`, `attestation_max_age`).
Altered manifest / invalid signature: `SIGNATURE_INVALID`, compared with `timingSafeEqual`.
Unknown origin: refused — "Unknown is never permission (T2)".

**Command signing.** `SIGNED_FIELDS`, `canonicalise()` and `FIELD_SEPARATOR` re-read and confirmed
byte-identical to Phase 4's. The envelope is signed whole, including `agentId`, `fenceScope`,
`sequence` and `notValidAfter`. Wrong algorithm rejected rather than defaulted. **The algorithm is
taken from the verifier's context, never from the envelope**, so an attacker cannot induce
algorithm confusion. Both production signers (`offers.js`, `membership.js`) call `sign(envelope,
key)` with no algorithm argument and therefore still use HMAC: **Phase 14 did not switch production
traffic to Ed25519**, as required.

**Trust boundaries — all six §23.5 rows.** `assertCoverage()` runs at module load and fails the
build if a row is dropped. Self-reported health expanding eligibility: **fixed** (P14-R15).
Implausible position and energy: rejected, not smoothed. Unreachable completion: security event
raised (P14-R14). Missing evidence: `INDETERMINATE`, never converted to permission — verified for
position (no prior fix), energy (no prior SoC) and health (unknown status → `NEUTRAL`, applied but
not treated as an expansion). Unknown state: refused. Persistent implausibility now creates the
correct security event (P14-R2).

---

## 15. Privacy Verification

The full chain was exercised against live PostgreSQL, in both directions.

Identity record → erasure request → dry run → real erasure → tombstone → replay → reconstruction
equivalence, checks **E1–E9** and **P1–P4**:

- an erased identity cannot be resolved as live — `resolve()` returns `ERASED`, and **`ERASED` is
  a different answer from `NOT_FOUND`**, which is what a dispute turns on;
- the ciphertext is genuinely removed — nulled, not marked, and the CHECK enforces it;
- the surrogate key survives as an opaque token;
- the technical record remains replayable — Tier B `contentHash` byte-identical;
- **erasure cannot be reversed by re-running the backfill** — `put()` refuses, and the database
  refuses too if the refusal were bypassed (E9);
- audit evidence survives the erasure, written in the same transaction as the tombstones;
- no identifying value leaks through another record — P2 scans all three written rows;
- strict API validation remains: `.strict()` Zod schema, `dryRun` defaults to true,
  `requestedBy` taken from the session and never from the body.

**Planted defects, and the gates that caught them.** An address in the Overrides section of a
decision record: caught by the new runtime guard, nothing written (P14-R12). An address in the
Predictions section: caught. An address in the snapshot's `pins`: caught **before the snapshot row
reaches the store**, so no partial write survives. An address in a corpus Tier A record: passed the
gate before P14-R13, fails it now with exit code 1.

**Identity-isolation gate, independently re-checked.** Its scope is 16 modules; its method is a
static source scan for identifying field *names*. That narrowness is disclosed in the
implementation report and is confirmed here — and it is precisely why P14-R12 was needed, because a
static name scan cannot see a value that arrives at runtime. The gate's scope was **not** widened
to make anything pass; a runtime guard was added beside it.

**The legacy identifying columns** (`Stop.label`, `Stop.lat/lon`, `Task.pickup/drop`) are still
written by the intake path. This is unchanged and correct: the plan gives Phase 15 the drop, "only
after a full retention window with the new path live", and this remediation is what makes the new
path live. `backfillIdentities.js --redact` remains available and remains not the default.

---

## 16. Governance Verification

Route → authentication → elevated role → action class → scope → override → audit, traced for every
gated surface.

| Surface | Gate | Verified |
|---|---|---|
| `POST /api/config/publish` | `SAFETY_CONFIG_CHANGE` | ✅ elevated + reason + second approver |
| `POST /api/robots/:id/clear-fault` | `QUARANTINE_OVERRIDE` | ✅ + waiver refusal now audited |
| `POST /api/robots/:id/pairing/unlock` | `QUARANTINE_OVERRIDE` | ✅ |
| `POST /api/tasks/assign` (with a waiver) | `MANUAL_ASSIGNMENT_AGAINST_POLICY` | ✅ **gate hole closed** (P14-R4) |
| `BULK_CANCELLATION` | registered, no endpoint | ✅ re-confirmed: no route accepts a list of task ids |

All four action classes are registered. Absolute classes verified at three layers (§14). Second
approver: required by class default, and `security.second_approver_action_classes` may only add
classes, never remove them — re-read and confirmed. Reason: mandatory, from the body or an explicit
header. Scope: `outOfScope()` honours an empty array as "no authority", and now so does the
elevated-role check (P14-R3) — the two agree for the first time. Audit: **both accepted and refused**
decisions written to the hash-chained stream and to the queryable table, joined by
`auditEventHash`, and now including waiver decisions with their predicate and class (P14-R5).

**On `X-Second-Approver` being caller-supplied — the determination the brief asked for.**

§23.4 requires "elevated role plus a recorded reason, and **where configured** a second approver".
The technical requirement is *configurability per action class*, and that is implemented,
registered as a Safety-class parameter, and union-only. §22.3 places "two-person approval" in a
column headed **Process**, alongside "Safety review" and "mandatory post-change monitoring window"
— neither of which is a technical control either, and neither of which anyone has claimed the
system implements. Reading one entry of that column as a technical requirement while its
neighbours are process would be inconsistent, and neither §23.4, §23.6 nor §22.3 specifies an
approval record, a pending-approval state, or a second authentication.

**Determination: permitted by the specification at Phase 14.** No workflow was invented.

It is recorded as **OPERATIONAL**, not as resolved. The system records a *claim* of two-person
approval that nothing verifies, and §22.3 makes two-person approval mandatory for Safety-class
changes — which Phase 15's cutover performs when it moves every Safety-class parameter from
`PROVISIONAL` to `DERIVED`. "Does not block Phase 14" and "does not matter" are different
statements, and this is the first.

---

## 17. Concurrency / Failure Injection

| # | Case | Durable state | Visible result | Audit | Retry safe | Invariant violable |
|---|---|---|---|---|---|---|
| 1 | Concurrent override attempts (X3) | 0 granted class-I rows | all 4 refused | refusal rows accepted | yes | **no** |
| 2 | Concurrent erasure requests (X1) | tombstoned once | ≥1 reports success | 1 event per applied request | yes (idempotent) | **no** |
| 3 | Erasure during record creation (X4) | record written **with** its key; subject tombstoned | both complete | both audited | yes | **no** |
| 4 | Duplicate certificate establishment (X2) | 1 row | exactly 1 of 2 succeeds | — | yes | **no** |
| 5 | Revocation racing session establishment | `establish()` re-reads the store | refused if revoked | — | yes | **no** |
| 6 | Rekey racing revocation | `rekey()` calls `establish()`, which re-assesses | refused | — | yes | **no** |
| 7 | Duplicate attestation | additive rows, `manifestHash` de-duplicates by content | both recorded | both | yes | **no** |
| 8 | Forged capability claim | none — frame dropped | dropped, counted | logged, counted to threshold | n/a | **no** |
| 9 | Concurrent governance requests | independent rows | independent | each audited | yes | **no** |
| 10 | DB failure during a security/audit transaction | erasure + audit in one transaction: both or neither | error | consistent | yes | **no** |
| 11 | Process death during erasure | transactional | — | consistent | yes | **no** |
| 12 | Process death during certificate rotation | worker *reports*, never mints; no partial identity | — | — | yes | **no** |
| 13 | Process death after audit, before response | audit survives; caller retries | possible duplicate attempt, refused or idempotent | audited | yes | **no** |
| 14 | Replay after erasure (P3) | `contentHash` byte-identical | identical | — | yes | **no** |
| 15 | Stale session after revocation | heartbeat re-check terminates; worker sweep also (P14-R11) | disconnected | logged | yes | **no** |

Case 3 deserves a note: the surrogate key survives a concurrent erasure in either interleaving,
because the key is derived from the **Stop**, and erasure never touches the Stop. That is not luck
— it is the property that makes §23.7's separation work, and X4 measures it rather than assuming it.

Case 10's guarantee is structural: `erasure.apply()` writes the tombstones and the audit event
inside one `$transaction`. An erasure whose audit failed is, from the trail's point of view, one
that never happened.

---

## 18. Performance

No measurable regression, and each addition bounded by construction:

- **`surrogateKeysFor()`** — **one** query per round, not per Leg. `O(1)` in Leg count.
- **`assertNonIdentifying()`** — a recursive walk of a 1–2 KB record, once per row. Tier A is
  bounded by construction (§21.2), so the walk is bounded too.
- **`sealIdentities()`** — 4 upserts + 3 updates per submission, on the request path. §3.4 already
  permits durable writes there (`Mission`, `Leg`, 2 `Stop`s, a `WorkQueue` row); this roughly
  doubles a write count that was never the request path's cost driver. No routing provider is
  consulted, which is the constraint §3.4 actually imposes.
- **`sweepOverrideRates()`** — one bounded query per worker tick (60 s), capped at 5 000 rows.
- **`validateHealth()`** — pure, no I/O, on the telemetry path.
- **P14-R1's side effect is a performance *improvement***: with the interval unresolved,
  `dueForRecheck()` returned true on **every heartbeat**, issuing a certificate lookup per
  heartbeat per agent. With `security.certificate_revocation_recheck_interval` now reaching the
  binding, that becomes one lookup per 900 s per agent.

Full suite wall time: 199 s before, 210 s after — inside run-to-run variance for a 6 741-test suite.

---

## 19. Test Results

`npm run verify` — **exit 0.**

| Lane | Suites | Tests | Failures | Skipped |
|---|---|---|---|---|
| legacy | 17 | 126 | 0 | 0 |
| gates | 7 | 135 | 0 | 0 |
| engine | 121 | 6 413 | 0 | 0 |
| chaos | 3 | 44 | 0 | 0 |
| scale | 3 | 23 | 0 | 0 |
| **total** | **151** | **6 741** | **0** | **0** |

Baseline 150 / 6 685 → 151 / 6 741. **+1 suite, +56 tests**, all additions:
`tests/engine/phase14Remediation.test.js` (53) and 3 added to `intakeStranglerSeam.test.js`.
Nothing removed, nothing skipped, no `.skip` or `.only` introduced.

Live PostgreSQL: `tools/verify/phase14LiveDatabase.js` — **55 passed, 0 failed**, exit 0.

---

## 20. Gate Results

| Gate | Result | Figures |
|---|---|---|
| tier-dependencies | PASS | 278 modules, 393 edges, 0 violations |
| parameter-register | PASS | 183 modules, 242 parameters, 0 bare constants |
| tenets | PASS | 275 modules, 0 violations |
| identity-isolation | PASS | 16 modules, 0 violations |
| erasure reconstruction-equivalence | PASS | 3 corpus decisions, 3 Tier B, 0 erased fields |
| legacy-retirement | PASS | 4 retired modules absent, 324 files scanned |
| column-generation | PASS (NOT_REQUIRED) | no column-gen module, neither budget changed |

### Proven able to fail

Each defect was planted, the gate observed to fail, the code restored, and the gate observed to
pass again. **No planted defect remains in the repository** — `git status` and targeted greps
confirm every restore, and the corpus fixture is byte-identical to its committed form.

| Gate / suite | Planted defect | Failed | Restored |
|---|---|---|---|
| `gate:privacy` | an address read in `cost/cDirect.js` | exit **1**, names the file, line and field | exit 0 |
| `gate:erasure` | an address in a corpus Tier A record | exit **1** (`IDENTIFYING_VALUE_STORED_IN_A_DECISION_RECORD`) — **exit 0 before P14-R13** | exit 0 |
| P14-R1 regression | `appLocals` removed from the socket server | 1 test failed | 34/34 |
| P14-R2 regression | `thresholdConfigured` forced true | 1 test failed | 34/34 |
| P14-R3 regression | `roleAdmitted` reverted to `length > 0` | 3 tests failed | 7/7 |
| P14-R7 regression | `tierA.toRow` drops the keys | 1 test failed | 34/34 |
| **Live DB harness** | `surrogateKeysFor` returns empty | **3 checks failed** (P2, P3, X4) | 55/55 |

The last row is the strongest evidence in this document: the live harness detects a broken
production producer through the database, not through a mock.

---

## 21. Phase 0–13 Integrity

| Check | Result |
|---|---|
| `git diff` on `Backend/prisma/migrations/` | **empty** — no migration edited |
| Migration count | 26, unchanged |
| `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` | **untouched** |
| `IMPLEMENTATION_EXECUTION_PLAN.md` | **untouched** |
| `PHASE_14_IMPLEMENTATION_REPORT.md` | **untouched** |
| `PHASE_14_INDEPENDENT_VERIFICATION.md` | **untouched** |
| `src/engine/commitment/` (Phase 3 G1/G2/G3) | **untouched** |
| `src/engine/feasibility/` | **untouched** |
| Phase 13's in-flight files (`shard/*`, `validators.js`, `shards.controller.js`, `schema.prisma`, 6 shard tests) | **untouched** — every diff in them predates this work |
| legacy lane | 126/126, unchanged |
| Thresholds moved | none |
| Tests deleted / skipped / relaxed | none |

`server.js` is the one file carrying both Phase 13's in-flight changes and this remediation's.
The additions are disjoint — Phase 13's touch the shard supervisor, these touch the socket server
and the certificate worker.

**Shared test helper.** `intakeStranglerSeam.test.js`'s `bridgeStore()` gained three model
doubles. The change is strictly additive: `updateIn()` **throws** on an update matching no row,
matching Prisma, so a production path that updated a row it never created fails there rather than
silently succeeding. No existing assertion was altered.

---

## 22. Phase 15 Boundary

**Nothing from Phase 15 leaked backward.**

| Check | Result |
|---|---|
| `ENGINE_ENABLED` | `false` in `.env`, `.env.benchmark`, `tests/setup/env.js` |
| `AGENT_MTLS_REQUIRED` | `false` in all three |
| Legacy service retirement | unchanged — done by Phase 15 before this work; `gate:legacy` PASS |
| Legacy socket events | none removed |
| Redis key retirement | none |
| Legacy identifying columns | **not dropped** — `Stop.label`, `lat`, `lon`, `Task.pickup`, `drop` all retained |
| `src/engine/fairness/` | `.gitkeep` only, 0 `.js` files |
| Phase-15 cutover functionality | none added |
| Phase-15 scale suite | unchanged, 3 suites / 23 tests |
| Specification | unmodified |

The one judgement call: **P14-R15 is staged, not enforced.** Enforcing §23.5's health asymmetry
immediately would change live agent behaviour before the cutover. The fix adopts the identical
staging Phase 14 already chose for the position and energy rows of the same table. It is
composed and observable now; it becomes load-bearing at the same flag flip as its two siblings.

### Routed to Phase 15 — explicitly owned, not hidden

**P14-X1 — the capability *consumption* path (EXTERNAL, Phase 15).** `attestation.verify()`,
`capabilitiesFrom()` and `record()` have no production caller, and `capability.assertAttested()` is
called only from inside `capabilitiesFrom()`. `CapabilityAttestation` is never written by
production. **Not a Phase 14 blocker**: no production code reads a capability bundle at all —
`prisma.capability` and `prisma.capabilityBundle` have zero references in `src/` — so there is no
consumer to wire and inventing one would be Phase 14 adding a capability rather than securing one.
The negative half of §23.2 (capabilities never accepted from telemetry) *is* enforced, in two
handlers, unconditionally. **It does matter**: the first phase that makes capability-based
eligibility live must wire `capabilitiesFrom()` as the only admission path, or `Capability.source`
becomes an unvalidated field on a security-relevant decision.

**P14-X2 — five derived quantities (DEFERRED, Phase 15).** See §6. `Stop.zoneId`,
`geofenceResult`, `accessWindowClass`, `serviceTimeCohort`, `routingNodeId` remain null. **Not a
Phase 14 blocker**: §23.7 requires the quantities "the decision actually consumed", and the
decision path consumes none of the five. **It does matter**: the round is where they become
derivable, and a Phase 15 that treats them as populated will read nulls.

**P14-X3 — second approver (OPERATIONAL).** See §16. Permitted by the specification at Phase 14;
becomes load-bearing at Phase 15's Safety-class launch gate.

**P14-X4 — the first accepted fix (DEFERRED, documented).** `validatePosition()` returns
`INDETERMINATE` with no prior fix, and the telemetry handler treats non-`REJECTED` as acceptable.
An agent quiet longer than the fix-cache window gets one unchecked position on reconnect. §23.5
gives no rule for the first fix, refusing it would make reconnection impossible, and the
plausibility parameters are all `PROVISIONAL` pending calibration. **Not a Phase 14 blocker; it
does matter** — it is the bound on what the kinematic check can promise, and it belongs in the
safety case.

**P14-X5 — `ConfigActiveVersion` schema drift (EXTERNAL, Phase 1, pre-existing).** See §13. The
database is stricter than the datamodel. Not introduced by, and does not affect, Phase 14.

**P14-X6 — `validateCustody()` has no caller (DEFERRED, documented).** §23.5 row 6 says custody
events are "Corroborated with compartment sensing and mass delta **where available**". Neither
signal exists in the schema or the agent protocol, so there is nothing to corroborate against and
no caller was invented. **Not a Phase 14 blocker**; the row's own qualifier permits it. It becomes
real when compartment sensing does.

---

## 23. Remaining Issues

Classified per the reporting principle. **No Phase-14-owned blocker remains.**

| ID | Class | Blocks Phase 14 | Matters | Owner |
|---|---|---|---|---|
| Finding 1 | COSMETIC | no | marginally — the correction is authoritative here | Phase 14 (frozen) |
| P14-X1 | EXTERNAL | no | **yes** — a Phase 15 blocker | Phase 15 |
| P14-X2 | DEFERRED | no | **yes** — a Phase 15 blocker | Phase 15 |
| P14-X3 | OPERATIONAL | no | **yes** — §22.3 mandatory at cutover | Deployment / Security |
| P14-X4 | DEFERRED | no | yes — a bound on the safety case | Phase 14 → safety case |
| P14-X5 | EXTERNAL | no | marginally — DB is stricter | Phase 1 |
| P14-X6 | DEFERRED | no | yes — when the hardware exists | Phase 16+ |
| Identity-isolation gate scope | DEFERRED | no | reduced — P14-R12 now covers the runtime half | Phase 14, mitigated |
| ABAC scope inert (`User` has no region/fleet/tenant) | DEFERRED | no | **yes** — §23.4's tenant isolation is untestable until the columns exist | Phase 15 |

The last row was disclosed by the implementation report and independently confirmed by the
verification. It is repeated here because it is the one remaining §23.4 clause with no technical
enforcement: `policyFor()` reads `req.user?.scope`, which is always `undefined`, so
`outOfScope()` is unscoped for every caller. `override.outOfScope()` is correct and will work the
day the columns land — this is a missing producer, not a broken consumer.

---

## 24. Completion Criteria

| Criterion | Met | Evidence |
|---|---|---|
| Every Phase-14-owned HIGH/CRITICAL defect fixed | ✅ | 5 HIGH, all fixed, all with regression tests proven able to fail |
| Every MODERATE fixed or proven non-blocking | ✅ | 7 MODERATE, all fixed |
| Production composition verified | ✅ | §12 — every mechanism traced consumer → producer → runtime caller |
| Security boundaries verified | ✅ | §14 — absoluteness at 3 layers, every bypass path attempted |
| Privacy guarantees verified | ✅ | §15 — full chain live, planted defects caught |
| Governance/authorisation verified | ✅ | §16 — all 4 action classes, both waiver sites, audit both ways |
| Database constraints verified live | ✅ | §13 — 55/55 on PostgreSQL 18.3, all 16 CHECKs fired |
| New gates proven able to fail | ✅ | §20 — 7 plant/restore cycles, none left planted |
| Failure/concurrency exercised | ✅ | §17 — all 15 cases |
| No earlier phase weakened | ✅ | §21 |
| No Phase-15 functionality leaked backward | ✅ | §22 |
| No migration corruption | ✅ | §21 — zero diff, 26 migrations, chain applies from empty |
| No hidden test-only dependency | ✅ | §12 — this was the phase's defining defect and it is closed |
| All remaining issues classified and owned | ✅ | §23 |
| No Phase-14 blocker remains | ✅ | §23 |

---

## 25. Final Recommendation

# PHASE 14 — CLOSED

Phase 14's specification work was sound. Its modules are well-reasoned, its constraints are correct
at the database, its central safety property — that class I, R and F can never be waived — holds
under every attack this review could construct, at three independent layers, including four
genuinely concurrent transactions against live PostgreSQL.

What it lacked was composition. Nine guards were written, tested, and never called; five registered
parameters reached no consumer because a configuration path that reads correctly cannot resolve;
and the entire positive half of §23.7 existed in schema and in an offline tool that could not run
in any environment because neither of its two required secrets was set anywhere. The independent
verification checked that each module was present and correct, and each module *was* present and
correct. Nobody checked whether anything called them.

That is now closed. Every §23 mechanism has a production producer and a runtime caller; both new
build gates are proven able to fail and one of them is strictly stronger than it was; the runtime
guard §23.7's own docstring promised is applied where the specification says it binds; and the
privacy chain has been driven end to end against a real database, from intake through erasure to a
replay whose Tier B hash is byte-identical to the one taken before the subject was erased.

Three findings would have been live security defects at the Phase 15 cutover and are worth naming
one last time: a quarantine control that could never fire, an authorisation check that an ordinary
Safety-class configuration change would have disabled while appearing to tighten it, and an agent
able to clear its own fault and re-enter service by reporting itself healthy. None was named by
either historical report, and each was found by asking the same question of every mechanism —
*who calls this in production?*

Six issues remain, every one classified, owned, and explicitly distinguished between "does not
block Phase 14" and "does not matter". None is Phase-14-owned and blocking.

**Phase 15 may proceed**, carrying P14-X1 and P14-X2 as named prerequisites of its cutover rather
than as surprises inside it.

---

*End of Phase 14 Remediation and Closure Report.*

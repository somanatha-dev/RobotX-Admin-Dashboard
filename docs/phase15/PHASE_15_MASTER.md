# CURRENT PHASE 15 SOURCE OF TRUTH

> **This document is the canonical navigation and current-state document for Phase 15.**
>
> **Archived Phase 15 reports are historical evidence only.**
> **They MUST NOT be used as current implementation truth.**
>
> Every archived report was written against a tree that no longer exists, and several of them
> were corrected by later passes. Reading them to decide what to implement is the specific
> failure this document exists to prevent.

**Consolidated:** 2026-08-29 · **Last updated:** **2026-08-30** (post-V-10 **current-state audit**;
before it, closure item **V-10**)
**Branch:** `feature/dashboard` · **HEAD:** `67b7c7c` · **working tree NOT clean** — T1-04, the
`Leg.slaDeadline` producer and V-10 are all uncommitted
**Source digest of the current tree:**
`d033038cb261c3de0efe13796af9aa26d190ea113a5a2bfe5971480f72bdca00` (**573 files**)
— computed live via `node -e "require('./tools/release/sourceDigest.js').sourceDigest()"` from `Backend/`.

> **Digest `431010ace1…` (565 files) is the 2026-08-29 consolidation's tree and is superseded.**
> Measurements below still dated 2026-08-29 were taken against it; the ones re-executed on
> 2026-08-30 say so. `PHASE_15_VERIFICATION_STATE.md` carries every current number.

---

## 1. Authority order

When this document and any other source disagree, resolve in this order:

| # | Authority |
|---|---|
| 1 | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` — **FROZEN** architecture/specification |
| 2 | `IMPLEMENTATION_EXECUTION_PLAN.md` — execution plan |
| 3 | **The actual current repository** — source, config, schema, migrations, tests, scripts, tools, generated artefacts, git state |
| 4 | Freshly executed verification against the current repository |
| 5 | These five canonical Phase 15 documents |
| 6 | `archive/` — historical Phase 15 reports |

A historical report is **not** authoritative because it is detailed, recent, or says "FINAL".

---

## 2. What Phase 15 is

`IMPLEMENTATION_EXECUTION_PLAN.md` §3, "PHASE 15 — Verification, release gates, and production
cutover". Its purpose is **not** new capability. It is:

- implement `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §24 in full — the release-gate table;
- implement §22.4's staging discipline — the per-shard cutover authority and its guardrails;
- move every engine worker from shadow to **production scheduling**;
- **remove** the legacy DTARO decision path from the build, not bypass it;
- provide the evidence machinery — source digest, evidence collection, release verdict,
  safety case, simulator-fidelity gate, formal-verification artefacts.

Phase 16 has exactly one prerequisite: Phase 15.

---

## 3. Current status — the verdict

# PHASE 15 IMPLEMENTATION — CLOSED
# PHASE 15 RELEASE — BLOCKED
# PHASE 16 — NOT READY

**Read the distinction carefully; it is the single most important fact in this document.**

- **Implementation CLOSED** means: Phase 15's *code* obligations are discharged. The cutover
  authority, its evidence binding, its observation-window authority, its rollback publisher and
  its configuration propagation are implemented, adversarially attacked, mutation-tested, and
  verified against a live PostgreSQL database. Six adversarial passes have each closed their own
  findings.
- **Release BLOCKED** means: `npm run release:verdict` exits 1. **8 of 24 blocking gates are not
  green for their own reasons** (1 RED — B1; 7 NOT_EVALUATED — B8/B-P/B-O), and nothing in this
  repository can turn any of those 8 green. **As measured on 2026-08-30 the tool reports 0
  green / 17 red / 7 not evaluated**, because the checked-in evidence collection is bound to the
  superseded digest and has aged past every gate's `maxAgeMs` — every extra RED is `[STALE]`, not
  a gate failing, and a fresh `npm run release:gates` at a committed tree restores the 16. See
  `PHASE_15_VERIFICATION_STATE.md` §3.0. **The verdict is BLOCKED either way.**
- **Phase 16 NOT READY** follows from the release verdict. It no longer follows from **REMEDIAL
  PHASE T1-04**: that phase ran on 2026-08-30 and its three fairness modules exist, are composed
  into the production timer and worker paths, and are verified against a live database.

**"In-repository defects: none remaining" is NOT claimed and should not be claimed.** Every pass
that has claimed it has been proven wrong by the next pass, because each pass searches the surface
the previous pass's fix created. See §51 of the archived third-pass report for why this is
structural rather than accidental.

**The 2026-08-30 demonstration of exactly that.** This document told an agent, in §9, that *"there
is no unblocked Phase 15 implementation work identified"*. Closure item **V-10** — *"`rollback.md`
executed against the current API"*, `NOT EVALUATED`, status **UNKNOWN**, never executed by any
pass — was sitting in `PHASE_15_CLOSURE_CHECKLIST.md` §C the whole time. Executing it found
**five defects**, including a manual rollback procedure that would have reverted the fleet's
entire configuration, and a §4 paragraph arguing that Rollback B was safe from a database mirror
that has had no writer since Phase 15 deleted the legacy dispatcher. **None of them was in the
blocker table**, and none would have been found by any test. Three passes running, the next
genuine item has been outside the blocker register — so read §C of the checklist, not only §7 of
this file.

**The 2026-08-30 post-V-10 audit, and why it did not produce a seventh implementation task.**
V-10's changes were re-examined for newly actionable repository-owned work — the worker-count
move, the runbook edits, the new verification harness, and the digest movement. **There is none,
and none was manufactured.** Everything found was **stale documentation**: the canonical set still
carried the pre-T1-04 tree's numbers (18 workers, 11 starting, 340 legacy-corpus files, 242
register entries, `160`/`7 162` tests), recorded **29** migrations where 27 + T1-04's one is
**28**, and — most consequentially — **asserted in two places that the checked-in evidence
collection "matches the current tree"**, contradicting the V-10 finding that it has aged out. All
are corrected in place and marked with what they used to say; the command-by-command record is
`PHASE_15_VERIFICATION_STATE.md` **§7b**. **No code was written, no gate or threshold touched, no
blocker moved, and none of V-10's five findings was altered.** *A pass that finds only stale
numbers should report only stale numbers — inventing a remediation to justify the pass is the
failure mode this file's §10 exists to prevent.*

---

## 4. Current repository identity

| | |
|---|---|
| Branch | `feature/dashboard` |
| HEAD | `67b7c7c` — "documentation of phase 15 resolved" *(re-read 2026-08-30. An earlier revision of this row still named `b68dc5d`, the consolidation's HEAD, and contradicted this file's own header)* |
| Working tree | **Not clean, and deliberately so — but no longer documentation-only.** The 2026-08-29 consolidation's changes were documentation-only; **T1-04, the `Leg.slaDeadline` producer and V-10 have since touched application source, tests, schema, a migration and `package.json`**, all uncommitted. That is precisely **why the digest below moved** from `431010ace1…`/565. *(The "no application source was touched … which is why the digest is unchanged" sentence that stood here described the 2026-08-29 tree and was false on this one.)* |
| Source digest | **`d033038cb261c3de0efe13796af9aa26d190ea113a5a2bfe5971480f72bdca00`** *(2026-08-29's `431010ace1…` is superseded)* — re-verified live 2026-08-30 |
| Files in digest scope | **573** *(was 565)* |
| Digest scope | `Backend/{src,tools,tests}`, `Backend/package.json`, `Backend/jest.config.js` — **`docs/` is deliberately excluded** |
| Registered workers | **19 registered** · **12 actually start** (9 `SCHEDULED` + 3 of 4 `LEADER_ONLY`) · 6 `DEFERRED` · 1 refused (`coordinator`, B1). *Was 18/11 before T1-04 added `fairness.worker.js`; re-measured 2026-08-30 via `registry.report({running:[]})` → total 19, scheduled 9, leaderOnly 4, deferred 6.* `src/workers/` holds **21** `.js` files (19 `*.worker.js` + `registry.js` + `leaderWorkers.js`) |
| Prisma migrations | **28** *(27 before T1-04, which added exactly one — `20260830120000_ladder_escalation_t1_04`)*. **Re-counted directly 2026-08-30: 28 directories, 28 `migration.sql` files.** *An earlier revision said "29 (was 27; T1-04 added one)", which contradicts its own arithmetic; the 29 was wrong wherever it appeared* |
| §24 release gates | 24, all blocking. `gates.blockers({})` returns all **24** |
| Build gates in `npm run gates` | **8** — 7 PASS, 1 FAIL (`gate:composition`) |

**The digest is the binding fact.** Any report — archived or otherwise — that quotes a different
digest was measured against a different tree, and its numbers do not transfer. Digests seen in the
archive that are **NOT** this tree: `22ca9143…`, `134ebc0d…`, `801ed1df…`, `72f943df…`, `d9fdb79a…`.

---

## 5. Current implementation summary

Full detail: **[`PHASE_15_IMPLEMENTATION_STATE.md`](PHASE_15_IMPLEMENTATION_STATE.md)**.

| Subsystem | State |
|---|---|
| Cutover authority | **Implemented** — `src/engine/cutover/` (10 modules). Its **operator procedures** were traced against it for the first time on 2026-08-30 (**V-10**): 5 runbook defects, fixed — see `PHASE_15_BLOCKERS.md` § *V-10* |
| Release gates + evidence | **Implemented** — `tools/release/` (3 tools), 24-gate table in `src/engine/cutover/gates.js` |
| Workers / composition root | **Implemented** — `server.js` is the production composition root. **19 registered; 12 start** (9 `SCHEDULED` + 3 of 4 `LEADER_ONLY`). **1 cannot be composed** (`coordinator`, B1) and **6 are `DEFERRED` with declared blockers**. `gate:composition` prints **"1 violation across 19 registered worker(s)"** and that counts *compliance*, not *starts* — see `PHASE_15_IMPLEMENTATION_STATE.md`. *(Re-measured 2026-08-30; this row said 18/11 and quoted "1 violation of 18", which was the pre-T1-04 tree)* |
| Legacy retirement | **Complete** — 4 modules deleted, build gate enforces absence |
| Routing | **Adapters + readiness tool implemented; NO ENGINE SELECTED** (B1, external) |
| Calibration | Gate implemented; **39 blocking findings** (B8, external) |
| Simulator fidelity | Gate implemented; **no study supplied** — 7 models NOT_MEASURED |
| Safety case | Assembler implemented; assembles cleanly. **The §24.7 gate is not thereby discharged** |
| Formal verification | TLA+ modules + 6 TLC configs present; **`tla2tools.jar` absent, so TLC is not runnable on this tree.** `lifecycle.tla` has **never** been run under TLC at any capacity; `formal/README.md:34-45` records two completed `commitment.tla` runs from **2026-08-15** under TLA+ 1.8.0 (`commitment_c1.cfg` as checked in, plus a reduced capacity-2 form) — neither discharges the gate. **B-M = NOT MEASURED / OPEN** |
| Database | **28 migrations**; **6** live-DB harnesses (the four Phase 15 ones, plus T1-04's and V-10's), **167/167**, all green |
| Runbooks | `docs/runbooks/cutover.md` and `rollback.md`. **Both traced against the current API 2026-08-30 (V-10) — 5 defects fixed**, and `rollback.md` §7 now records when that trace happened. P15-F7a (nothing *binds* a runbook to its API) is unchanged and still open |

---

## 6. Current verification summary

Full detail with commands, exit codes and dates: **[`PHASE_15_VERIFICATION_STATE.md`](PHASE_15_VERIFICATION_STATE.md)**.

**Every row below carries its own date.** The rows marked *re-measured 2026-08-30* were executed
against the **current** digest `d033038c…` (573 files); the rest were executed on 2026-08-29
against the superseded `431010ace1…` and have not been re-run since. None is an inherited number —
but do not read the whole table as one date, which an earlier revision of this sentence invited.

| Command | Exit | Result |
|---|---|---|
| `npm test` | **0** | **162 suites / 7 275 tests / 0 failures / 0 skips** — re-measured 2026-08-30 |
| `npm run gates` | **1** | 7 PASS, 1 FAIL (`gate:composition` — B1, 1 violation of **19** workers) — re-measured 2026-08-30 |
| `npm run release:verdict` | **1** | **2026-08-30: 0 GREEN, 17 RED, 7 NOT_EVALUATED** — every extra RED is `[STALE]`, not a gate failing. *(2026-08-29, when the collection was current: 16 GREEN, 1 RED, 7 NOT_EVALUATED.)* **RELEASE: BLOCKED**, both times |
| `npm run gate:calibration` | **1** | 39 blocking findings; **250** entries (52 DERIVED / **160** PROVISIONAL / 38 UNCALIBRATED), 54 Safety-class — **re-measured 2026-08-30**. *(Was 242 / 152; T1-04 added 8 `PROVISIONAL` ladder-rung fractions, **none Safety-class**, so the 39 and the 54 did not move — see `PHASE_15_BLOCKERS.md` § B8)* |
| `npm run routing:readiness` | **0** *(by design)* | **OVERALL: BLOCKED** — D1, D3, D8 all BLOCKED; Steps 1/3/4/5 BLOCKED, Step 2 PASS — **re-run 2026-08-30, unchanged** |
| `npm run sim:fidelity` | **1** | 7 models NOT_MEASURED, 6 safety-relevant |
| `npm run safety:case` | **0** | 12 hazards assembled, every reference resolves |
| 4 × `tools/verify/phase15*.js` on live PostgreSQL 18.3 | **0** | **80 / 80** checks |
| `npm run verify:t104` (T1-04 + `Leg.slaDeadline`) | **0** | **72 / 72** checks, 2026-08-30 |
| **`npm run verify:v10`** (`rollback.md` §2.1 vs the live API) | **0** | **15 / 15** checks, 2026-08-30 — **167 / 167** in total |

**NOT currently verified** (labelled honestly, not assumed): mutation testing, TLC model checking,
Phase 0–14 cross-phase re-verification, and the soak/shadow/invariant observation windows. See
`PHASE_15_VERIFICATION_STATE.md` §5.

---

## 7. Current blockers

Full register with owners and closure conditions: **[`PHASE_15_BLOCKERS.md`](PHASE_15_BLOCKERS.md)**.

**7 open blockers. 0 are repository-owned *and actionable*** — the one repository-owned entry (A9)
is correctly deferred to Phase 8 and has no action available here. **X1/T1-04 was the eighth and
was closed on 2026-08-30** by REMEDIAL PHASE T1-04 (§17.4's ladder, its human capacity model, and
§17.5's detection — implemented, composed, and verified against live PostgreSQL).

> **Two different quantities in this documentation used to both equal 8. They no longer do, and
> that is itself worth stating.** **7 open blockers** (this table) is a programme count — it
> includes specification and phase-ownership items that are not §24 gates. **8 blocking gates not
> green** (the §24 table: 1 RED + 7 NOT_EVALUATED) is the release-verdict count, and it is
> **unchanged**: closing X1/T1-04 moved the programme count and no gate, because T1-04 was never a
> §24 gate row. B1 appears in both; X3 and A9 appear only in the blocker count; the four individual
> PRODUCTION gates are one blocker (B-P) but four gate rows.

| ID | Summary | Classification | Owner |
|---|---|---|---|
| **B1** | No routing engine selected → `coordinator` uncomposable → `engine_decision_path_wired` RED | **EXTERNAL** | Ops + Commercial (D1), Product + Fleet Eng (D3), Ops (D8) |
| **B8** | 39 Safety-class parameters not `DERIVED` | **EXTERNAL** | §22.4 calibration owner |
| **B-P** | 4 PRODUCTION gates NOT_EVALUATED — needs an operating fleet | **EVIDENCE / OPERATIONS** | Operations |
| **B-O** | 3 ORGANISATIONAL gates NOT_EVALUATED — needs filed attestations | **EVIDENCE / OPERATIONS** | Named humans / release owner |
| **B-M** | `model_check_capacity_1_2_3` is GREEN and **NOT PROVEN** — **NOT MEASURED / OPEN**. An independent release-evidence item, **not a B1 sub-step** | **EVIDENCE / OPERATIONS** (compute) | Release owner (provisioning + **final acceptance**) · Compute/Platform · Safety engineer (property coverage, boundedness) · Engineering (mechanical only) |
| **X3** | No `TASK` timer producer; §4.2 has no transition table | **SPECIFICATION / ADR** | Frozen-spec owner |
| **A9** | `assertVersionInKey` implemented, tested, genuinely uncalled | **REPOSITORY-OWNED, correctly deferred** | Phase 8 |

**Closed since the last revision — X1 / T1-04**, on 2026-08-30. §17.4's escalation ladder, its
human capacity model and §17.5's agent-starvation detection are implemented in
`src/engine/fairness/`, composed into the production timer path (`leaderWorkers.timer` →
`expiryActions` → `ESCALATION_LADDER`) and into `server.js`'s scheduled set, and verified by 72/72
checks against live PostgreSQL. Four parts of §17.4/§17.5 genuinely remain and are recorded with
their reasons in `PHASE_15_BLOCKERS.md`; none of them is a §24 gate. Composing it required arming
the `QUEUED` deadline in `task.service.admitToRound`, which the request path had never done — so
before this phase the ladder would have had no runtime trigger for customer work even had it
existed.

**`Leg.slaDeadline` gained its producer on 2026-08-30**, in the same function and the same
transaction: §17.4's triage comparator sorts escalations by SLA breach proximity, and the column
that proximity is measured from had no writer, so the key was inert and a dispatcher's queue fell
back to arrival order. It is now `storeTime + sla.assignment_deadline` — §4.3's exit deadline for
Leg state `QUEUED`, taken from the same resolved budget and the same clock read as the §4.5 timer
beside it, so the instant §17.4 sorts on cannot drift from the instant §4.5 fires on. Recorded in
full in `PHASE_15_BLOCKERS.md`.

**A9 is the only repository-owned entry, and it is deferred by design** — its discharge point is
`src/engine/routing/client.js`, a Phase 8 module that does not exist and cannot exist before B1.
Do not manufacture a caller for it.

**Closed 2026-08-30 — closure item V-10.** *"`docs/runbooks/rollback.md`'s procedure executed
against the current API"* was never a blocker; it was a `NOT EVALUATED` verification row in
`PHASE_15_CLOSURE_CHECKLIST.md` §C with the note *"No pass has ever done it"* and the status
**UNKNOWN**. Executing it found **five defects** — the worst being that the manual Rollback A, as
written, published one binding into a configuration system whose versions are *complete sets*, and
so reverted every other parameter in the deployment while stopping one shard. All five are fixed,
with 7 tests, 3 mutants killed and **15/15 against live PostgreSQL**. Full record:
`PHASE_15_BLOCKERS.md` § **V-10**.

**B1 gained a fifth item of required engineering work as a result**, and it is *not* implemented:
the coordinator does not read the per-shard cutover switch, so a Rollback A does not stop a
running coordinator. It is invisible today only because no coordinator can be composed. The guard
belongs in the composition root beside the routing client, and writing it now would produce a
guard with no caller. See `PHASE_15_BLOCKERS.md` § **B1**, item 5.

Separately, there are **6 residual in-repository observations that are reported and not fixed**
*(was 7 — observation 2, the unexecuted rollback runbook, was discharged by V-10 on 2026-08-30)*.
None is permissive. They are listed in `PHASE_15_BLOCKERS.md` §"Residual" and are *not* counted as
blockers. **Observation 1 — P15-F7a, that nothing binds a runbook to the API it documents — is
unchanged, and V-10 is the second demonstration of what it costs.**

### 7.1 Known unresolved contradictions

**Yes, there are some. They are named rather than silently corrected.** A fresh agent reading these
five documents *and then* opening `ARCHITECTURE.md` or `ROBOTX_SYSTEM_HANDBOOK.md` will hit
statements that contradict this document. That is expected and is registered, not accidental:

- **Inside the five canonical documents: none known.** §16 of the audit compared every
  status, count and classification across MASTER / IMPLEMENTATION_STATE / VERIFICATION_STATE /
  BLOCKERS / CLOSURE_CHECKLIST against the repository on 2026-08-29 and found no surviving
  contradiction. Where a fact was not established, it is written `UNKNOWN` or `NOT VERIFIED`.
- **Between the canonical documents and the wider documentation: 9 registered discrepancies.**
  The Phase-15-owned falsehoods were corrected on 2026-08-29 (worker scheduling, composition root,
  release-gate count, build-gate count, `gate:legacy`'s quoted output, ADR-34's absence from the
  authority table, CI's third omission). The rest — engine-module counts, suite/test counts, and
  repeated "7 build gates / 23 release gates" phrasing scattered through the handbook — are
  **cross-phase drift that Phase 15 does not own** and were deliberately left in place and
  recorded. **Full register with file and line: [`PHASE_15_BLOCKERS.md`](PHASE_15_BLOCKERS.md)
  § *Cross-phase documentation discrepancies*.**

**When this document and `ARCHITECTURE.md` / `ROBOTX_SYSTEM_HANDBOOK.md` disagree about Phase 15,
this document wins** — §1's authority order, rank 3 (the repository) then rank 5 (these five
documents); `ARCHITECTURE.md` ranks itself below both.

---

## 8. Current closure status

Full checklist: **[`PHASE_15_CLOSURE_CHECKLIST.md`](PHASE_15_CLOSURE_CHECKLIST.md)**.

Phase 15 does not close on test results. It closes on the §24 gate table, and **8 of its 24
blocking gates are not green**. Every one of the 8 requires a decision, a measurement, an
attestation or a compute run that no commit in this repository can supply.

---

## 9. Safe next actions

**For a human / the programme (these unblock Phase 15):**

1. **D1 — partially answered 2026-08-30, still BLOCKED, and no longer waiting on the region
   declaration.** The owner has declared two independent campus regions (`rnsit-bengaluru`,
   `jssate-bengaluru`) with names, `kind`, CRS, versions and an adopted boundary feature each, and
   JSSATE's geometry is pinned as an external snapshot. What is now needed is **an escalation
   authority**: the approved boundaries are smaller than one H3 res-8 cell, standard coverage
   returns zero cells so **V-8** fires, `cardinalityException` cannot rescue it, and the owner has
   **refused** both over-assigning containment modes. **No Architecture, Commercial or approval
   authority exists to resolve it, and none may be invented.** Also still outstanding: the RNSIT
   snapshot artefact and every governance record. See
   [`B1_EXTERNAL_INPUT_HANDOFF.md`](B1_EXTERNAL_INPUT_HANDOFF.md) §1.8.
2. **Product + Fleet Engineering answer D3** — the agent classes operated and, per distinct mobility
   model, §2.2's six elements with a real speed model.
3. **Operations answer D8** — extract identity, source, vintage (ISO), refresh cadence,
   re-contraction downtime budget, plus `extract.bbox` and `extract.marginDegrees`.
4. **§22.4's calibration owner** derives the 39 Safety-class values (B8).
5. **Release owner** provisions `tla2tools.jar` and runs the exhaustive TLC configurations (B-M),
   recording the run's provenance per `B1_EXTERNAL_INPUT_HANDOFF.md` §7.3a and accepting it per
   §7.6. **This is independent of 1–4 above and can start today.**

**For an AI coding agent, right now, in this repository:**

- Read the five canonical documents. Nothing else is required to understand current state.
- Answer questions about current state from `PHASE_15_VERIFICATION_STATE.md`, or re-run the
  command yourself. Do not quote a number from `archive/`.
- If asked to *implement* something in Phase 15: **no unblocked implementation work is identified
  in `PHASE_15_BLOCKERS.md` — and that is not the same as none existing.** Check
  **`PHASE_15_CLOSURE_CHECKLIST.md` §C** as well: it is where V-10 sat, unexecuted, through six
  passes that all read the blocker table. Every §C row that is `NOT EVALUATED` with an owner
  inside this repository is candidate work. Confirm against both before writing code.
- **§C was swept on 2026-08-30 after V-10 closed, and re-swept by the final closure audit later the
  same day. Four of its five open rows are external by construction; the fifth is not.** **V-5** is
  the release owner's evidence re-collection at a committed tree, **V-7** is B-M (needs
  `tla2tools.jar` and compute), **V-8** is B-P (needs an operating fleet), and **V-6** is per-pass
  mutation testing with no pass to attach to. **V-9 — the Phase 0–14 cross-phase re-verification —
  is NOT external and its trigger HAS fired.** *(An earlier revision of this bullet said "V-9 is a
  cross-phase re-verification with no trigger" and concluded "there is presently no §C row this
  repository can close by itself". Both statements were refuted by this tree and are corrected
  here.)* V-9's own stated trigger in `PHASE_15_CLOSURE_CHECKLIST.md` is *"run if the tree changes
  materially"*, and T1-04 and the `Leg.slaDeadline` producer changed it materially and across
  phase boundaries: `src/engine/supervision/expiryActions.js` (**+153 lines** — `attemptTransition`
  gained a `deadlineSecondsOverride` that changes which deadline a target state is armed with, and
  `escalationLadder` gained four verdicts where it previously refused unconditionally),
  `src/workers/leaderWorkers.js` (+68), `src/services/task.service.js` (+187),
  `src/engine/observability/metrics.js` (+123), `prisma/schema.prisma` (+103) and **one new
  migration**. `tools/verify/phase5ExpirySemantics.js` **requires the first two of those modules
  directly** (`:28`, `:31`), and the archived claim this row rested on was *"Phases 0–14, schema and
  migration history untouched"* — which is now false on its own terms. **V-9 is therefore
  repository-owned, actionable, and unrun.** It is **not blocking** (§C records it `Blocking? No`),
  it is **not an implementation defect**, and it moves **no gate, no blocker and not the verdict** —
  it is a verification run whose result is presently **UNKNOWN**, which is the same state V-10 sat
  in through six passes. Scope it to the harnesses whose subjects moved — Phase 5, and the Phase 9
  and Phase 12/13 harnesses covering the intake path and the SLIs — rather than to all of 0–14.
  **Re-derive this; do not inherit it.**
- **Do NOT run `npm run release:gates` to make the tree look green.** The checked-in evidence
  collection is genuinely stale and `release:verdict` genuinely reads 0/17/7; the fix is the
  release owner's re-collection at a **quiescent, committed** tree, and a collection taken against
  this uncommitted tree would be voided by the next source edit. **The verdict is BLOCKED either
  way** — recollecting changes the rendering, not the outcome.
- If the repository has changed since the digest in §4, **re-measure before answering**. The digest
  is how you tell.

---

## 10. Forbidden actions

These are not stylistic preferences. Each corresponds to a defect a previous pass either committed
or came close to committing.

| Do NOT | Why |
|---|---|
| Select, rank, recommend or hint at a routing engine | B1 Step 5 is a decision on recorded evidence, in an ADR. No evidence exists |
| Invent an operating region, boundary, CRS or region kind | D1. `prisma/seed.js`'s `SEED_SPATIAL_MAP` / `RGN-BLR` is a **Phase 2 containment demonstration, not production configuration** |
| Invent a mobility model, speed model or speed data | D3. The only `MobilityModel` in the repository is a seed whose `speedModel` is a note deferring to this decision |
| Invent an extract vintage, cadence or bbox | D8 |
| Derive, edit or reclassify any calibration value | B8. §22.3 forbids automated change of a Safety-class parameter |
| Change any threshold | Every threshold in the §24 table and the register is governed |
| Weaken a gate, or convert `NOT_EVALUATED` → `GREEN` | `NOT_EVALUATED` blocks exactly as `RED` does (§24), and is kept distinct on purpose |
| Use `DEGRADED_ROUTING` as a substitute for a routing service | It is a degradation ladder rung, not an engine |
| Write a stub, fake or in-process router to make `gate:composition` pass | Starting the coordinator on invented travel times assigns real work on invented data |
| Manufacture a caller for `assertVersionInKey` (A9) | Its seam is a Phase 8 module that does not exist |
| Fabricate an observation window, soak record, rehearsal record or attestation | These are the four gates the whole programme has classified as un-closable by commit |
| Put `docs/` into the source digest scope | Every prose edit would void a ~25-minute evidence collection. See B-M/P15-F7a discussion |
| Begin Phase 16 implementation | Phase 16's only prerequisite is Phase 15, which is not closed |
| Re-open a blocker because an archived report gives an older classification | The archive is frozen history. §11 explains |
| Mark a blocker closed because an archived report says "FIXED" | Six passes have proven a historical "FIXED" insufficient |

---

## 11. Documentation map

### Canonical — read these

| File | Answers |
|---|---|
| **`PHASE_15_MASTER.md`** (this file) | Navigation + current truth + what not to do |
| **`PHASE_15_IMPLEMENTATION_STATE.md`** | What actually exists in the repository, by subsystem |
| **`PHASE_15_VERIFICATION_STATE.md`** | What has actually been proven, with command + exit code + date + tree |
| **`PHASE_15_BLOCKERS.md`** | What prevents closure, who owns it, what closes it |
| **`PHASE_15_CLOSURE_CHECKLIST.md`** | The exact exit conditions and the current verdict |

### The B1 / B-M operational handoff — read before doing any B1 or B-M work

| File | Answers |
|---|---|
| **[`B1_EXTERNAL_INPUT_HANDOFF.md`](B1_EXTERNAL_INPUT_HANDOFF.md)** | **The single operational handoff for the external inputs.** What D1, D3 and D8 require field by field, who owns each, what evidence substantiates it, the operator deployment-module contract, B1's execution order and stop conditions — and, in §7, **B-M**: its independence from B1, its `NOT MEASURED / OPEN` state, what must be recorded, and who accepts it. **Do not write a second handoff.** |

### Upstream authorities — unchanged by this consolidation

- `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN)
- `IMPLEMENTATION_EXECUTION_PLAN.md`
- `docs/adr/` — in particular **ADR-11** (routing), **ADR-33** (B1 traversal-domain scope),
  **ADR-34** (cutover rehearsal purpose)

### Historical — `archive/`

15 superseded Phase 15 reports, indexed at **[`archive/README.md`](archive/README.md)**.

---

## 12. Historical archive policy

1. Every archived document is preserved **byte-for-byte**. None was edited, annotated, softened or
   truncated. They are audit records of what was believed at a point in time, and several of them
   contain a later pass's correction *of* an earlier pass — that correction history is itself the
   evidence, and rewriting it would destroy it.
2. Because they are unedited, **no archived file carries a banner saying it is archived.** Their
   status is declared in `archive/README.md`, which names each file, the tree it was measured
   against, and why it is superseded. **Read `archive/README.md` before opening any archived file.**
3. Open an archived report only to answer *"what did we believe on date X and why"*. Never to
   answer *"what is true now"*.
4. Nothing was deleted. No two Phase 15 reports were byte-identical, and every one contains unique
   historical evidence.

---

**TRUTH > GREEN.**

# PHASE 15 IMPLEMENTATION — CLOSED. RELEASE — BLOCKED. PHASE 16 — NOT READY.

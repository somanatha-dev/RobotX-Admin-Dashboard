# V1 — IMPLEMENTATION CONTROL

**Operational control document for the remainder of RobotX V1 implementation and closure.**

| | |
|---|---|
| **Created** | 2026-09-05 |
| **Last updated** | 2026-09-06 — **THE PRESENTATION-PATH PASS — DOCUMENTATION ONLY.** The strongest **honest** demonstration path the tree can execute was identified from the checks that already exist, **executed end to end**, and written down as [`docs/runbooks/demonstration.md`](../runbooks/demonstration.md) — six steps, **no new command, no new fixture, no new npm script, no source or test change**, so the source digest is unmoved by this pass. It is in `docs/runbooks/` and not `docs/v1/` because **§17 rule 13 closes `docs/v1/` to further files**. **It discharges no stop condition and no count, gate, exit code or verdict may cite it.** Two candidate wrappers were **declined** — publishing `cutover.engine_enabled` (§17 rule 3, and it is S-5) and an npm `demo` script chaining the steps behind one exit code (it would hide the per-step exit codes that *are* the evidence). Verified this pass: `npm test` **exit 0 — 167 suites / 7 445 tests / 0 failures**; composition suite **92 passed**; `gate:erasure` **PASS, 3 corpus decisions**; six engine suites **182 tests**; `npm run gates` **exit 1 — 7 PASS / 1 FAIL**, untouched; the live core-path harness on a disposable PG 18.3 cluster **exit 1** at HTTP 503 with **26 of 34 inputs unresolved**; `routing:readiness` **BLOCKED**. **NO STOP CONDITION CHANGED — the score is 3 of 8; S-3 is still 28 and the runtime numerator still 26; `gate:composition` is still RED; nothing was fabricated, published, pinned or seeded outside the disposable cluster.** §13.1 is this pass. *(Previously: execution pass 2 — S5-2, S5-3 and the composition, measured)* |
| *(prior)* | 2026-09-06 — **EXECUTION PASS 2: S5-2, S5-3 AND THE COMPOSITION, MEASURED. NOTHING WAS PUBLISHED, PINNED, SEEDED OR WRITTEN.** **S5-2 is BLOCKED**, and on a prerequisite the plan did not expect: every non-empty fine-cell derivation from the adopted `way/1120154292` boundary is `containmentOverlapping` under another name — 3 cells, 22.8× the campus, **95.6% of the assigned ground outside it** — and that mode is a **standing owner refusal** whose escalation target is **NOT DEFINED**. The standard path returns **0 cells** and there is no V-8 exception. **S5-3 is BLOCKED — classification B (FD-3 = NO)** on V9 *and* S2, re-derived against the **full** S5-2 candidate; V9's arithmetic was checked for a repository defect and is correct. **S5-4 NOT REACHED.** Two further results: the **spatial payload is provably not the publish constraint** (zero additional blocking findings), so S5-2's config half and S5-3 are *one* refusal; and **"the coordinator is blocked on B1" is refuted by measurement — B1 releases 5 of the 26**, with 15 calibration rows and 6 no-producer families remaining. **Three findings recorded and none acted on**: §4.1's step 3 never happened (**D-5 sharpened, status unchanged**), `shardModel.ensureShard` has no caller anywhere (**no W-item, §3.1 does not revert**), and a 116-candidate sweep is reported as **not evidence** rather than as findings. **NO STOP CONDITION WAS MET. The score is unchanged at 3 of 8; S-3 is still 28 and the runtime numerator still 26; `gate:composition` is still RED; no external value was fabricated, no containment mode was chosen, no accommodation was added, no approver was synthesised, and 0 `ConfigVersion` rows were written.** §7.1 is this pass. *(Previously: execution pass 1 — the three decisions, then three measurements)* |
| *(prior)* | 2026-09-06 — **EXECUTION PASS 1: THE THREE DECISIONS RECORDED, THEN THREE MEASUREMENTS.** [`RD-2026-09-05-02`](../release-decisions/RD-2026-09-05-02-v1-agent-boundary-and-simulation-track.md) is drafted for signature: **FD-1 = A** (the V1 contract is unchanged; a real commissioned physical agent is required for S-6), **FD-2 = YES** (an authorisation, **not** a supply), **FD-3 = NO FOR NOW** (no second Safety approver; no self-approval; satisfiable later by one named person). **N-1** and **N-2** each found a core-path defect of the *producer-exists-and-the-composition-root-does-not-use-it* family — **W-A6** and **W-A7**, both fixed, tested and mutation-checked, and §3.1's status reverted and was re-earned. **N-2's nineteen-field §7.5 inventory is §9.2** — (a) 2 · (b) 5 · (c) 11 · 1 fitting none. **S5-1 measured the S-5 publish and it is REFUSED** by V9 *and* S2, so **S-5 is reclassified as blocked by FD-3 = NO** and the one condition FD-1 = A left reachable is not currently reachable. The simulation track is classified **V1-ENG in the new §11.F**, discharging no stop condition. **NO STOP CONDITION WAS MET. The score is unchanged at 3 of 8; S-3 is still 28 and the runtime numerator still 26; `gate:composition` is still RED; no external value was fabricated and no simulation work was started.** *(Previously: the finite repository-only pass)* |
| *(prior)* | 2026-09-05 — **THE FINITE REPOSITORY-ONLY PASS. All four registered repository items (W-A1, W-A2, W-A3, W-A4) are CLOSED; W-B4's repository side is executed (§9.1); and one previously unknown core-path defect, W-A5, was found, fixed and closed** — §14.4's vendor stress curves were declared in a column, loaded onto the agent snapshot, and not read, because the seam that skipped them named the wrong row. **§3.1's status reverted and was re-earned in the same session.** **NO STOP CONDITION CHANGED. The score is unchanged at 3 of 8; S-3 is still 28 and the runtime numerator still 26; `gate:composition` is still RED; no external value was fabricated and no second owner request was issued.** §14.6 now holds zero open repository items. *(Previously: W-D2 executed and closed)* |
| *(prior)* | 2026-09-05 — **W-D2 executed and closed.** The single complete owner request is issued as [`docs/release-decisions/RD-2026-09-05-01-v1-external-input-and-owner-decision-request.md`](../release-decisions/RD-2026-09-05-01-v1-external-input-and-owner-decision-request.md), covering every row of §9 and every decision of §10. **No stop condition changed: S-3 is still NOT MET** — issuing a request is not receiving an answer. Score unchanged at **3 of 8**. *(Previously: W-D1 executed and closed; the S-3 numerator measured for the first time at `26 of 34`, §5.6; the authoritative count unchanged at 28)* |
| **Tree this document was built and verified against** | `4e2155a9a25f7b9d71842ce971a625a1fecaba6e` (HEAD), E-11 implementation at `3ff92ae02b3a406ba77a5a9555a5e8eadfd67013` |
| **Committed source digest** | `023906bef5b23c34f71b64f78419d4d6562813a74f5dd9ca95c48ef719a1017a` / 581 files (measured at `3ff92ae`) |
| **Working tree at creation** | clean |
| **Status** | **REPOSITORY V1 IMPLEMENTATION: complete for E-11's repository-owned corrections. V1 RELEASE / CLOSURE: NOT COMPLETE.** See §3 |
| **This document does NOT replace** | [`V1_CONTRACT_AND_STOP_CONDITION.md`](V1_CONTRACT_AND_STOP_CONDITION.md) — the canonical V1 contract remains authoritative |

> **Source-path convention.** All application source lives under `Backend/`. Paths in this
> document are written from the repository root, e.g. `Backend/src/workers/coordinatorPipeline.js`.
> All commands are run from `Backend/`.

---

## §1 DOCUMENT MAINTENANCE — READ FIRST

**This document MUST be updated in the same implementation session whenever any of the following
occurs:**

- code changes
- configuration changes
- external input changes
- an owner decision occurs
- a defect is discovered or fixed
- a test result changes
- a stop-condition status changes
- an external dependency is supplied
- the V1 critical path changes

**Every update must record, in §16 (Change Log): `date` · `commit/tree` · `change` · `evidence` ·
`affected V1 item`.**

A change that is made and not recorded here is indistinguishable, one session later, from a change
that was never made. Five separate counts in this project's history were each taken at whichever
seam the reader reached (§K, §L.2, §M.6, §N.2 of the contract); the discipline that prevents a
sixth is recording the measurement and the tree it was taken on, together.

---

## §2 DOCUMENT HIERARCHY

This document is **last** in precedence and overrides none of the documents above it. Where this
document and one above it disagree, the one above it governs and the disagreement is a defect in
this document to be corrected here.

| # | Document | Authority | Exists |
|---|---|---|---|
| 1 | [`docs/v1/V1_CONTRACT_AND_STOP_CONDITION.md`](V1_CONTRACT_AND_STOP_CONDITION.md) | **Canonical V1 contract and the finite eight-condition stop condition.** Authoritative | ✔ |
| 2 | [`docs/phase15/PHASE_15_MASTER.md`](../phase15/PHASE_15_MASTER.md) | Phase 15 truth and navigation | ✔ |
| 3 | [`docs/phase15/PHASE_15_IMPLEMENTATION_STATE.md`](../phase15/PHASE_15_IMPLEMENTATION_STATE.md) | Implementation inventory | ✔ |
| 4 | [`docs/phase15/PHASE_15_VERIFICATION_STATE.md`](../phase15/PHASE_15_VERIFICATION_STATE.md) | Proven verification | ✔ |
| 5 | [`docs/phase15/PHASE_15_BLOCKERS.md`](../phase15/PHASE_15_BLOCKERS.md) | Blockers | ✔ |
| 6 | [`docs/phase15/PHASE_15_CLOSURE_CHECKLIST.md`](../phase15/PHASE_15_CLOSURE_CHECKLIST.md) | Phase 15 closure | ✔ |
| 7 | **`docs/v1/V1_IMPLEMENTATION_CONTROL.md`** *(this document)* | **Operational V1 execution and closure control** | ✔ |

Also referenced and present: [`docs/phase15/B1_EXTERNAL_INPUT_HANDOFF.md`](../phase15/B1_EXTERNAL_INPUT_HANDOFF.md),
[`docs/phase15/PHASE_15_BM_TLC_RUN_RECORD.md`](../phase15/PHASE_15_BM_TLC_RUN_RECORD.md),
`NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (the specification), `docs/release-decisions/`.

**This document creates no new V1 status document and no competing V1 report.** ~~`docs/v1/` contains
exactly two files after this one is added: the contract and this control document.~~

> **CORRECTED 2026-09-05. `docs/v1/` holds three files, and the third carries no authority.**
> [`V1_OWNER_ACTION_CHECKLIST.md`](V1_OWNER_ACTION_CHECKLIST.md) was added on 2026-09-05 as an
> **operational collection sheet for the items `RD-2026-09-05-01` already defines** — how to obtain
> and decide them, and nothing else. **It is not a contract, not a status document, not a second
> owner request, and not a source of truth**; it defines no requirement, carries no S-condition
> status of its own, and every row in it traces to a row of that record. Where it and the record
> differ, **the record governs and the checklist is the defect**. §17 rule 13 forbids a *competing
> V1 status document*; that prohibition is unchanged and is not engaged by a file that states no
> status. **The rule's file count is the only thing corrected here — the rule itself is not
> weakened, and `docs/v1/` acquires no fourth file.**

> ### CORRECTED BY MEASUREMENT 2026-09-06 — **`docs/v1/` holds FOUR files, and it already did when the paragraph above was written.**
>
> `ls docs/v1/` returns **four**: the contract, this document, `V1_OWNER_ACTION_CHECKLIST.md`, and
> **`V1_DISCOVERY_AND_OWNER_QUESTIONS.md`**. `git show --name-status 10a527c` shows all three of
> the new ones were **added in the same commit** as the paragraph above — so the count was wrong on
> the tree it was written against, by omitting the discovery document. **This is the fifth instance
> of the class §16 keeps recording**: a published count gone stale against the thing standing beside
> it. *(§N.6 step 5's "all 34"; `registry.js`'s `cadenceParameter`; `UNCOMPOSABLE`'s "four input
> families"; §4.1's step 3; this.)*
>
> **Only the count is corrected here. §17 rule 13's prohibition is NOT weakened, NOT reinterpreted,
> and NOT discharged**, and this pass added no file to `docs/v1/`.
>
> **One thing this session deliberately does not decide, and flags instead.** Rule 13 forbids *a
> competing V1 status document*, and `V1_DISCOVERY_AND_OWNER_QUESTIONS.md` does carry status-shaped
> material — its §1.1 *"the eight stop conditions, as they stand"* and its §12.2 feasibility matrix.
> Whether that engages rule 13's substance, or whether the file is a discovery record the way the
> checklist is a collection sheet, is a **documentation-governance question for the owner**. A
> session that resolved it by declaring the file compliant would be the check answering itself, and
> one that resolved it by deleting or demoting the file would be destroying a record §13 of that
> file is actively cited from. **It is recorded, routed to the owner, and left exactly as it is.**

---

## §3 THE TWO STATUSES — THEY ARE NOT THE SAME CLAIM

§N of the contract ends with the heading *"B. V1 IMPLEMENTATION COMPLETE — EXTERNAL/OWNER INPUTS
REMAIN."* **That sentence must never be read, quoted, or summarised as "V1 is complete."** It is a
statement about one of two statuses, and the other one is not met.

### 3.1 REPOSITORY V1 IMPLEMENTATION — **COMPLETE for E-11's scope, conditionally**

Every item on §M.7's repository-owned work list (R-1 … R-7) is discharged, verified against this
tree in §4. No repository-owned defect is currently known to stand between this tree and V1.

> **It reverted a third time on 2026-09-06 and was re-earned in the same pass.** Tracing the
> coordinator's `OFFER` payload against the agent that executes it found **W-A8** (§11.A): the
> offer's `stopSequence` carries no `path`, the agent read one, and the phase machine treated the
> resulting empty route as an **already-finished** one — accepting the commitment and emitting
> `TASK_COMPLETE` for a delivery during which the robot never moved. It was fixed to fail closed,
> and the BEFORE variant was built and measured rather than argued (7 of 9 new tests fail against
> the unfixed source). **The missing execution-geometry producer it exposes is named in §11.A and
> deliberately given no W-item**, because supplying it is not this repository's to do — and
> because, unlike B1's five, it is not one of the 34.

> **It reverted a second time on 2026-09-05 and was re-earned in the same pass.** The N-1/N-2
> pass found **two** further core-path defects of the same family — `chargingSchedulerClient.resolveTargetSoc()`
> exported, tested and called from nowhere while `planInputFor` read a `targetSoc` no caller set
> (**N-1**), and two declared `AgentClass` columns dropped by the snapshot mapper (**N-2**, §9.2).
> Both were fixed, tested and mutation-checked on this tree (§16). **One repository-owned
> core-path item is now known and deliberately NOT fixed**, and it is recorded rather than
> carried silently: §2.3 requires a certified validity window to be checked against *mission end
> time*, F5 performs no expiry check, and the loader does not know the mission end — so an
> attested-firmware read path would be weaker than the specification on a safety credential
> (§9.2.3). It is bucket **(b)** in any case: nothing writes a `CapabilityAttestation` row.
>
> **This status reverted once, on 2026-09-05, and was re-earned the same session.** The
> repository-only pass of that date found **W-A5** — a core-path defect at the pricing seam:
> §14.4's vendor stress curves were declared in `EnergyModelParams.stressCurves`, loaded onto
> the agent snapshot, and never read, because the code that skipped them named `EnergyModel`,
> a different row (§9.1). The rule in the third bullet below was applied as written rather than
> argued around: it was outstanding repository work, this status was false while it stood, and
> it is true again only because the defect was fixed, tested and mutation-checked on this tree.
> **The four registered non-blocking items (W-A1 … W-A4) are closed in the same pass**, so
> §14.6 is now empty.

**The conditions on that word "complete":**

- it is scoped to **§M.7's list**, not to "the repository is finished";
- it is **subject to any newly identified V1-critical defect**. §I.4 of the contract already
  states the rule: a new defect found on the V1 core path is a V1 bug against a shipped V1, not a
  reopening of the stop condition — but before V1 ships, a new core-path defect is simply
  outstanding repository work and this status reverts;
- three items §M.7 assigned to the repository were **reclassified as not repository-owned** with
  evidence (F20, F22, `plan.route` — §N.3). They are closed as repository work because they were
  never repository work, not because they were done;
- `gate:composition` is **RED**, by design. The repository implementation being complete is
  precisely why the gate now fails for an external reason rather than an internal one.

### 3.2 V1 RELEASE / CLOSURE — **NOT COMPLETE**

**Three of the eight stop conditions hold (S-1, S-2, S-8). Five do not (S-3, S-4, S-5, S-6, S-7).**
See §7 for the individual classification of each. V1 is complete when, and only when, all eight
hold (§I.2).

### 3.3 The distinction, stated once

> **"The repository has done its part" and "V1 exists" are different facts.** The first is about
> commits; the second is about a running system making true decisions for a declared region. This
> repository can close the first by itself and **cannot close the second by itself** — every
> remaining item is a value or a decision that originates outside it. Publishing the first as
> though it were the second is the exact failure mode this project has documented repeatedly: a
> green artefact standing in for an unmeasured one.

---

## §4 E-11 FACTS — VERIFIED AGAINST THIS TREE

Each row below was re-checked against `4e2155a` while writing this document. "Verified how" names
the command or file read; nothing is carried forward on the strength of the E-11 narrative alone.

| # | Claim | Verdict | Verified how |
|---|---|---|---|
| **1** | R-1/R-2/R-3 — three production register-name defects fixed | **CONFIRMED** | `energy.variance_inflation` (2 occurrences), `energy.charger_projection_max_age` (1), `lease.duration` (2) present in `Backend/src/`. All three old names — `energy.uncertainty_inflation`, `energy.projection_max_age`, `commitment.lease_duration` — occur **0** times |
| **2** | R-4 — production register-name invariant added across `src/`, including `src/workers` | **CONFIRMED** | `npm run gates` → `gate:params` **PASS — 193 engine module(s) … 289 runtime module(s) checked for register reads; every name resolved.` Rule 2's scope statement is at `Backend/tools/gates/checkParameterRegister.js:54` and `:307` |
| **3** | R-5 — F33 seam uses spatial hierarchy resolution; does not manufacture `false` for an unassigned cell | **CONFIRMED** | `Backend/src/workers/coordinatorSolvePath.js:850-894`. Three documented answers; only the assigned case sets `serviceable: true` (`:894`); an unmapped cell leaves the field **absent** (`:865-866`) |
| **4** | R-6 — F35 seam uses `Charger` rows, latest availability projection, return leg through the same cell-pair seam | **CONFIRMED** | `Backend/src/workers/coordinatorSolvePath.js:734-781`, `:1029-1040`, `:1130`. `chargerCandidatesFor()` at `:767`; return-leg rate read at `:779-781` |
| **5** | R-7 — mission tenant/RequirementSet/payload, `agent_class` scope, scalar scope resolution, MobilityModel, `Leg.slaDeadline` | **CONFIRMED** | `coordinatorSolvePath.js:415-421` (Task join, §2.8), `:445-449` (`slaDeadline` → `targetMs`/`deadlineMs`), `:359-366` (full MobilityModel incl. `permissionSet`, `envelopeConstraints`, `dimensionalFootprint`, `speedModel`), `:1169` (`agent_class` in gate scope), `:507-510` (Task-carried attributes) |
| **6** | S-6 harness exists: `tools/verify/v1CorePath.js` | **CONFIRMED, with a correction** | File present at `Backend/tools/verify/v1CorePath.js`, 468 lines. **It has no `npm` script.** `package.json` registers `verify:t104` and `verify:v10` but **not** `verify:v1CorePath` — the harness is invoked as `node tools/verify/v1CorePath.js`. Recorded as **W-A1** (§11.A) |
| **7** | `npm test` — 166 suites / 7 411 tests / 0 failures | **CONFIRMED — re-run on this tree.** *(Superseded as a **current** figure on 2026-09-05: the repository-only pass took it to **167 / 7 429**, still exit 0. The row is kept because it is the measurement E-11 is verified against; §7 and §13 carry the live figure.)* | `npm test` from `Backend/` → **exit 0**. `Test Suites: 166 passed, 166 total · Tests: 7411 passed, 7411 total · Snapshots: 0 · Time: 569.666 s · Ran all test suites in 5 projects.` Zero failures, zero skips |
| **8** | `npm run gates` — 7 PASS / 1 FAIL (`gate:composition`), not weakened | **CONFIRMED — re-run on this tree** | `npm run gates` → exit 1. PASS: `gate:tiers` (292 modules / 459 edges), `gate:params`, `gate:tenets` (289), `gate:privacy` (16), `gate:erasure` (3 corpus decisions), `gate:legacy` (350 files), `gate:columngen` (NOT_REQUIRED). FAIL: `gate:composition` — 1 violation across 19 registered workers, `LEADER_ONLY_NOT_COMPOSABLE` for `coordinator` |
| **9** | Real E2E attempted: PG 18.3, **28** migrations *(corrected 2026-09-05 from "29" — the directory holds 28 and `prisma migrate deploy` reports 28)*, seeded region/shard/agent-class/agent/battery/position, `server.js` as a separate process, `ENGINE_ENABLED=true`, real authenticated `POST /api/tasks/assign` | **RECORDED (§N.6). Not re-executed while writing this document** | Harness source at `Backend/tools/verify/v1CorePath.js`; B8 accommodation at `:180-209`; boundary reporting at `:420-462` |
| **10** | The E2E **did not** complete V1 | **CONFIRMED** | The harness exits 1 by construction. §4.1 traces the chain |

### 4.1 The E2E stop chain — exactly as it occurred, and not represented as a success

```
ENGINE_ENABLED=true                                    (deployment fact, set by the harness)
   ↓
no pinned configuration version
   → config/service.bootstrap refuses to boot (§3.3, §22.1 rule 4)
   ↓
the register cannot publish its own defaults
   → V9: combined degraded energy conservatism 2.0125 > energy.max_combined_conservatism 1.6,
        because route.degraded_reserve_factor is Safety-class, PROVISIONAL, awaiting B8
   → S2: §22.3's two-person rule on a first publish
   ↓
no leader could be elected                      ── ✗ SUPERSEDED 2026-09-06, see §4.3
   → §19.5 election.assertConsensusStore refuses a store whose replication posture is UNDECLARED
        (Backend/src/engine/shard/election.js:99, :141, :172-177;
         called from Backend/src/workers/shardSupervisor.worker.js:581)
   ↓
the request was refused — HTTP 503 ENGINE_NOT_LIVE, before anything was written (§12.1)
   → cutover.engine_enabled is not bound true at region scope  ── this is S-5
   ↓
in the same running process, at promotion, the coordinator's composer refused
   → EXTERNAL_DEPENDENCY_UNAVAILABLE                            ── this is S-3
```

**The harness exits 1, and exit 1 is the correct result.** A zero would require inputs nobody has
supplied. **This run is not evidence that the V1 core path works end to end. It is evidence that
the path fails closed at four named boundaries, in the designed order.**

### 4.2 One correction to §N.6, found while verifying it

§N.6 step 2 reads *"The register cannot publish its own defaults"*, and §N.8's closing note
escalates that to *"B8 … stops a deployment publishing its first configuration version **at
all**"*.

**That is true only of an unaccommodated publish.** The harness itself publishes a configuration
version, by taking a **labelled accommodation** already precedented by
`Backend/tools/verify/phase15CurrentTree.js`:

- `Backend/tools/verify/v1CorePath.js:206` binds `route.degraded_reserve_factor = 1.1` at global
  scope, which brings the combined product under the 1.6 cap and clears V9;
- `:191-196` records the same accommodation for S2's two-person rule;
- `:196-210` states the line the harness does **not** cross: `cutover.engine_enabled` stays
  unbound, because binding it would be this file deciding that the engine is live for a region.

**Why the distinction matters operationally.** B8 blocks a *production-intent* first publish. It
does **not** block a *labelled V1 verification environment* from publishing, and the E-11 run
proves that by having done it. Therefore **"resolve B8" is not the technical unblock for S-5 or
S-6** — the harness reached, and deliberately declined, S-5 with a config version already
published. This correction changes the immediate next action; see §15.

**Superseded statement, recorded:** §N.8's *"it stops a deployment publishing its first
configuration version at all"* → **corrected**: *it stops an unaccommodated, production-intent
first publish; a labelled verification publish is precedented and was performed by the E-11 run
itself.* B8's status as an owner decision (§10, D-1) is unchanged.

### 4.3 A second correction to §4.1, found 2026-09-06 while measuring S5-2 — **step 3 never happened**

§4.1's chain is headed *"exactly as it occurred"*, and its third step reads *"no leader could be
elected → §19.5 `election.assertConsensusStore` refuses a store whose replication posture is
UNDECLARED."*

**That step did not occur, in the E-11 run or in any run the harness has ever made.**
`Backend/tools/verify/v1CorePath.js:350` sets `SHARD_CONSENSUS_REPLICATION =
"SINGLE_PRIMARY_NO_AUTOMATIC_FAILOVER"`, `server.js:562` reads exactly that environment variable
into `election.postgresLeadershipStore`, and `assertConsensusStore` therefore **passes**. The line
has been in the harness since its first commit, `3ff92ae` — **so §4.1 was wrong when it was
written**, not made wrong by a later change. §5.6.1 of this same document already records the
contradicting measurement, from an independent re-run: *"**Leadership: Acquired.** The server logged
`Leadership acquired — LEADER_ONLY workers started`, `running: ["outbox","reconciler","timer"]`."*

**Why this is more than a tidy-up.** §12 classifies **D-5** (a declared consensus-store posture) as
**V1 REQUIRED**, with the consequence *"No leader, no round, no coordinator"* — and §4.1 is the
evidence a reader would reach for. Left standing, the two together present D-5 as a live V1 blocker
of the same kind as the routing source and the region. **It is not.** The harness discharges it as
a **statement of fact about the cluster it was pointed at** — one disposable primary, no standby,
therefore no automatic failover — which is what the value names, and the harness says so at
`:343-349`. `ASYNCHRONOUS_FAILOVER` is still refused by name and `UNDECLARED` is still unsafe.

**D-5 is not fabricated by the harness and is not discharged in general.** Any *other* deployment —
including a V1 demo deployment on a cluster this repository has not seen — must declare its own
true posture, and no session may declare one on an operator's behalf. **D-5's status in §12 and in
`RD-2026-09-05-01` is unchanged: it remains an owner declaration.** What changes is only that it is
a one-line declaration of an observable fact about a specific cluster, already demonstrated end to
end, and **not** a boundary the V1 verification path currently stops at. §4.1's step 3 is marked
superseded in place rather than deleted, under this document's own convention.

**This correction was found by measurement, not by reading**, and it is the same defect class §16
has now recorded four times: *a published claim gone stale against a measurement standing beside it
in the same file* (§N.6 step 5's *"all 34"*, `registry.js`'s `cadenceParameter`, `UNCOMPOSABLE`'s
*"four input families"*, and now this).

---

## §5 COUNT RECONCILIATION — 28 vs 34 vs 33/38 *(mandatory)*

**These are three different measurements of three different things. None of them may be collapsed
into another, and 34 is not "28 plus six more inputs."**

### 5.1 What each number is

| Number | What it counts | Where it is produced | Authoritative for |
|---|---|---|---|
| **34** | The **declared size of the coordinator's composition contract** — every row of `coordinatorPipeline.REQUIREMENTS`, satisfied or not, including six process dependencies this repository supplies itself | `Backend/src/workers/coordinatorPipeline.js:287-573`; exposed as `REQUIREMENT_IDS` | The **assembly contract**. It is a *denominator*, not a shortfall |
| **28** | The **S-3 external/owner input list** — §M.6's 27 rows plus the return-leg Wh/metre found at §N.2 | Hand-reconciled in §M.6 / §N.2 of the contract, from the probe **plus** two inputs the probe provably cannot see | **S-3 under the V1 contract.** This is the number the owner is asked for |
| **33/38 → 31/38 → 30/38** | **§7.5 feasibility-gate denials** on one composition fixture — 38 predicates, of which 33 currently deny; 31 with a charger and its return-leg rate; 30 with a region cover added | `Backend/tests/engine/coordinatorSolvePathComposition.test.js` (counterfactual, §N.5) | **Nothing about S-3.** It is a *consequence* measurement — what the gate can decide once inputs arrive — and it counts **predicates**, not inputs |

**Measured on this tree** (`node -e` against `coordinatorPipeline`, read-only):

```
DECLARED TOTAL: 34
  EXTERNAL_ROUTING     5
  REGISTER_UNRESOLVED 16
  NO_PRODUCER          6
  PROCESS_DEPENDENCY   6
  ADMISSIBILITY        1
```

### 5.2 The exact reconciliation

Neither set contains the other. The relationship is:

| | Rows | In the 34? | In the 28? |
|---|---:|---|---|
| **EXTERNAL_ROUTING** — `route`, `travelSdSeconds`, `speedMetresPerSecond`, hop terrain, `timeBucket` | 5 | ✔ | ✔ |
| **REGISTER_UNRESOLVED** — the fifteen `null`-by-declaration rows | 15 | ✔ | ✔ |
| **REGISTER_UNRESOLVED** — `candidate.max_radius_by_sla_class` | 1 | ✔ | ✘ — **satisfied** by §6.3's wall-clock disjunction (E-8's classification, re-measured at §M.6). A containment policy Operations still owes; **not a V1 blocker** |
| **NO_PRODUCER** — environment, vehicle mass, `p_fail`, route hazard cost, battery wear, return-leg Wh/metre | 6 | ✔ | ✔ |
| **PROCESS_DEPENDENCY** — `prisma`, `kv`, `runSerializable`, `selectForUpdate`, `signingKey`, `snapshot` | 6 | ✔ | ✘ — **repository/assembly requirements.** All six are supplied by the composition root: `Backend/server.js:657-722` |
| **ADMISSIBILITY** — Ω correction (`candidates/omega.combinedCorrection`) | 1 | ✔ | ✘ — **a derived precondition, not an input.** It is computed from the snapshot; it resolves when the register rows do |
| **Serviceable-region cell assignments (F33)** | 1 | ✘ — **the probe cannot see it** | ✔ |
| **One depot-class charger (F35)** | 1 | ✘ — **the probe cannot see it** | ✔ |

```
34 = 5 + 15 + 1 + 6 + 6 + 1
28 = 5 + 15 + 6 + 1(region) + 1(charger)
common rows = 26
```

**So the naive subtraction 34 − 28 = 6 is arithmetically true and structurally misleading.** The
six-row net difference is the sum of **+8 and −2**:

- **+6 PROCESS_DEPENDENCY** — repository/assembly requirements, already satisfied by `server.js`;
- **+1 ADMISSIBILITY** — a derived requirement, not an input anyone supplies;
- **+1 REGISTER row** (`candidate.max_radius_by_sla_class`) — declared but satisfied, non-blocking;
- **−2** — the serviceable region and the depot charger, which are **genuine S-3 inputs that are
  absent from the 34 entirely.**

**Why the two are invisible to the probe.** `coordinatorPipeline.REQUIREMENTS` probes the
composition's **constructor** seams. F33's and F35's inputs are read *inside* `planInputFor`, one
seam further in, which the probe does not walk (§M.6). This is a known and recorded limitation of
the instrument, not a disagreement between two audits.

### 5.3 Is any input duplicated under multiple assembly names?

**No row is duplicated. But rows are neither values nor supply acts, and three collapses are
possible if this is read carelessly:**

| Apparent duplication | Verdict | Evidence |
|---|---|---|
| `route` · `travelSdSeconds` · hop terrain · `timeBucket` — four rows for one function | **Not duplicates; four distinct rows, one supply act.** They are separated because availability differs by engine: no shortlisted engine returns `travelSdSeconds` (N29) or `stopStartCycles`; OSRM returns no elevation. **Declaring one traversal source closes rows 1, 2 and 4, and row 5 is a property of the query rather than the answer** | §F.2 (six-field contract), §M.6, §K.1 note at contract line 1036-1039 |
| `speedMetresPerSecond` — looks like routing | **Not routing.** `cellPairCache.applyIntraCellOffset` reads it for §20.3's intra-cell quantisation. It is **fleet/profile configuration (D3)**, supplied alongside the router and never by it | §M.6 |
| `environment.ambientC / packC` — one row | **One row, two values.** Likewise `battery wear inputs (§14.4)` is one row covering several §14.4 quantities | `SOLVE_PATH_REGISTER_INPUTS` / `REQUIREMENTS` why-text |

**Consequence for the owner request: 28 rows ≠ 28 independent suppliers.** The 28 resolve to
roughly **eight supply acts** — one traversal source (4 rows), one fleet speed declaration
(1 row), one calibration publish covering fifteen register rows, five engineering/data-source
programmes (6 NO_PRODUCER rows), one region declaration, one charger declaration. §9 states the
boundary by supply act as well as by row.

### 5.4 Which number is authoritative for S-3

> **28 is the authoritative S-3 count under the V1 contract**, on this tree, as of 2026-09-05.
>
> **34 is the authoritative size of the composition contract** and is what `gate:composition` and
> the running server print. It must never be quoted as an S-3 figure.
>
> **33/38 is a §7.5 predicate-denial count** and has no S-3 interpretation at all.
>
> **And a fourth number now exists, measured 2026-09-05: `26` — the live unresolved count on a
> running deployment** (§5.6). It is neither 28 nor 34: it is 28 minus the two rows the
> instrument structurally cannot see. **28 remains authoritative for S-3** and W-D1 confirmed it
> rather than changing it.

### 5.5 One number in §N.6 was **not** established — and is now MEASURED (W-D1)

> **RESOLVED 2026-09-05 by W-D1. The numerator is 26.** The diagnosis below is kept as written
> because it is the reasoning that produced the measurement; **§5.6 carries the measurement
> itself** and supersedes this subsection's closing sentence *"No number is asserted here."*

§N.6 step 5 reads: *"the coordinator's composer reported `EXTERNAL_DEPENDENCY_UNAVAILABLE` naming
**all 34 declared inputs** it could not resolve."*

**The code that produces that string does not say that.** It prints a fraction:

- `Backend/src/workers/coordinatorSolvePath.js:1541-1543` — `"${contract.missing.length} of ${REQUIREMENT_IDS.length} declared inputs are unresolved"`
- `Backend/src/workers/leaderWorkers.js:389-392` — `"MEASURED against this context — ${assembly.missing.length} of ${REQUIREMENT_IDS.length} inputs unresolved"`

So **34 is the denominator**, and §N.6 records the denominator while appearing to state the
numerator. **The measured numerator for the E-11 run is not recorded anywhere and cannot be
recovered from the document.**

**It was almost certainly not 34.** `Backend/server.js:657-722` supplies all six
`PROCESS_DEPENDENCY` rows to `leaderWorkers.create()` — `prisma` (`:658`), `kv` (`:659`),
`snapshot` as an accessor (`:684`), `runSerializable` (`:701`), `selectForUpdate` (`:702`),
`signingKey` from `COMMAND_SIGNING_KEY` (`:718`). The measured missing count in a real server run
is therefore **bounded above by 28**, and by extension of §M.6's own measurement (25 of 33, plus
the one new `NO_PRODUCER` row) the expected figure is **26**.

~~**No number is asserted here.**~~ The claim was: *the numerator is unrecorded, the denominator
was reported in its place, and one command settles it.* **One command did settle it — §5.6.**

**Superseded statement, recorded:** §N.6 step 5's *"naming all 34 declared inputs it could not
resolve"* → **corrected by measurement**: *the composer named its 34-row declared contract and
reported **26** of them unresolved.* The enumeration §N.6 step 5 gives immediately after that
phrase — *"`route`, `travelSdSeconds`, `speedMetresPerSecond`, hop terrain, `timeBucket`, the
fifteen register rows, the five `NO_PRODUCER` families and the new return-leg rate"* — is
**5 + 15 + 6 = 26 and is exactly right**. Only the phrase *"all 34"* was wrong, and it
contradicted its own list.

### 5.6 W-D1 — THE MEASUREMENT *(2026-09-05)*

**This is the numerator §5.5 said was unrecorded. It was measured, not inferred, not carried
forward from an expectation, and not read off the denominator.**

#### 5.6.1 Provenance

| | |
|---|---|
| **Date** | 2026-09-05 |
| **Tree** | `4e2155a9a25f7b9d71842ce971a625a1fecaba6e` (HEAD). Working tree carried only this document, untracked |
| **Command** | `node tools/verify/v1CorePath.js --database-url postgresql://pgverify@127.0.0.1:55432/robotx`, run from `Backend/` |
| **Database** | A **disposable** PostgreSQL 18.3 cluster, `initdb`-ed for this run on port `55432`, `28` migrations applied by `npx prisma migrate deploy` (exit 0). Neither `DATABASE_URL` nor the local 5432 cluster was used |
| **Harness** | Used **exactly as implemented.** No npm script added, no line changed, no input fabricated, `cutover.engine_enabled` left unbound, B8 unresolved |
| **Harness exit** | **1**, at S-5, with S-3 reported from the same process — the designed result (§4.1), reproduced unchanged |
| **Leadership** | **Acquired.** The server logged `Leadership acquired — LEADER_ONLY workers started`, `running: ["outbox","reconciler","timer"]`. **The coordinator is the one worker absent from that list**, so the refusal below is a promotion-time measurement and not a run that never reached one |

#### 5.6.2 The runtime line, verbatim

> `MEASURED against this context — 26 of 34 inputs unresolved: EXTERNAL_ROUTING: route, travelSdSeconds source (N29), speedMetresPerSecond (per routing profile), hop terrain (climbM / descentM / stopStartCycles), timeBucket (§20.3 congestion bucket) | REGISTER_UNRESOLVED: plan.service_time_prior, energy.model_residual_cv, cost.energy.cu_per_wh, cost.wear.cu_per_metre, cost.failure.cu, cost.staleness.cu_per_second_age, cost.energy_consequence, cost.sla.cu_per_second_late, cost.sla.breach_penalty, lifecycle.cu_per_actuator_cycle, lifecycle.cu_per_braking_event, lifecycle.cu_per_gradient_metre, lifecycle.cu_per_thermal_stress_second, cost.battery.cu_per_equivalent_cycle, energy.reserve_floor_wh | NO_PRODUCER: environment.ambientC / packC, masses.vehicleMassKg, p_fail (per-agent failure probability), route_hazard_cost (Map service), return-leg Wh per metre (per routing profile), battery wear inputs (§14.4).`

**N = 26.** The structured `missingByClass` field on the same log entry reads
`{"EXTERNAL_ROUTING":5,"REGISTER_UNRESOLVED":15,"NO_PRODUCER":6}` — 5 + 15 + 6 = 26.

> **`26` is the measured S-3 shortfall on this deployment. `34` remains the denominator and the
> size of the assembly contract. The two must never again be quoted as one number** (§5.4).

#### 5.6.3 How the line was obtained — and a defect in the instrument that obtained it

**The shipped harness reached the boundary correctly and then could not print the line it exists
to capture.** `Backend/tools/verify/v1CorePath.js:452` writes each refusal through
`line.trim().slice(0, 2400)`. The refusal line the server emits is **16 942 characters**, and the
`MEASURED against this context` clause begins at **index 3 291** — so the harness prints the first
2 400 characters, drops **14 405**, and the clause is cut off every time.

The full line was recovered **without modifying the harness or any application file**: a
scratchpad driver called the harness's **own exported** `seed` and `startServer`
(`v1CorePath.js:468`) with the identical environment, issued the identical `POST
/api/tasks/assign`, waited the identical `PROMOTION_WAIT_MS`, and printed `server.output()`
untruncated. Same code, same database, same 503, same refusal — only the slice removed.

**This is recorded as W-A4 (§11.A). It is a defect in a verification instrument, not on the V1
core path**, so §3.1's repository status does **not** revert. ~~It is not fixed in this session.~~

> **FIXED 2026-09-05, in the next session (W-A4).** Refusal lines are printed whole, and all of
> them. The measurement in §5.6.2 above is **not re-attributed** — it was taken through the
> harness's exported `startServer`, as recorded, and this fix does not retroactively make the
> harness that produced it print the clause. **The next run of the harness will print it
> itself.** A second silent truncation in the same statement was found while fixing this one:
> `refusals.slice(0, 12)` capped the number of lines, so a run whose decisive line was the
> thirteenth reported nothing and said nothing about having stopped. Both are gone.

#### 5.6.4 Row-by-row reconciliation of the measured set against the 28-row S-3 list

**All 26 measured rows.** Classifications are the eight permitted ones; no row is forced into
S-3 that does not belong there.

| # | Runtime requirement (verbatim) | In the 28-row S-3 list? | Classification | Why |
|---:|---|---|---|---|
| 1 | `route` | ✔ §9 row 1 | **1 — V1 external input** | The traversal source itself. `cellPairCache.read` falls through to `deps.route(parts)` on a cache miss |
| 2 | `travelSdSeconds source (N29)` | ✔ §9 row 3 | **1 — V1 external input** | A declared spread model. No shortlisted engine returns one; selecting an engine does not close it |
| 3 | `speedMetresPerSecond (per routing profile)` | ✔ §9 row 4 | **1 — V1 external input** | Fleet/profile configuration (D3), not routing. `applyIntraCellOffset` refuses without it |
| 4 | `hop terrain (climbM / descentM / stopStartCycles)` | ✔ §9 row 2 | **1 — V1 external input** | The terrain half of §F.2's six-field contract; refused by `plan/timeline.project` |
| 5 | `timeBucket (§20.3 congestion bucket)` | ✔ §9 row 5 | **1 — V1 external input** | A property of the query; part of declaring the source |
| 6 | `plan.service_time_prior` | ✔ §9 row 6 | **1 — V1 external input** | Register calibration; `resolveServiceTimes` fails closed |
| 7 | `energy.model_residual_cv` | ✔ §9 row 6 / **6a** | **1 — V1 external input (Safety class)** | §22.3 forbids an automated choice. Still a *value*, not a decision — §10's own exclusion list says so |
| 8 | `cost.energy.cu_per_wh` | ✔ §9 row 6 | **1 — V1 external input** | Register calibration |
| 9 | `cost.wear.cu_per_metre` | ✔ §9 row 6 | **1 — V1 external input** | Register calibration |
| 10 | `cost.failure.cu` | ✔ §9 row 6 | **1 — V1 external input** | Register calibration |
| 11 | `cost.staleness.cu_per_second_age` | ✔ §9 row 6 | **1 — V1 external input** | Register calibration |
| 12 | `cost.energy_consequence` | ✔ §9 row 6 | **1 — V1 external input** | Register calibration |
| 13 | `cost.sla.cu_per_second_late` | ✔ §9 row 6 | **1 — V1 external input** | Register calibration |
| 14 | `cost.sla.breach_penalty` | ✔ §9 row 6 | **1 — V1 external input** | Register calibration |
| 15 | `lifecycle.cu_per_actuator_cycle` | ✔ §9 row 6 | **1 — V1 external input** | Register calibration |
| 16 | `lifecycle.cu_per_braking_event` | ✔ §9 row 6 | **1 — V1 external input** | Register calibration |
| 17 | `lifecycle.cu_per_gradient_metre` | ✔ §9 row 6 | **1 — V1 external input** | Register calibration |
| 18 | `lifecycle.cu_per_thermal_stress_second` | ✔ §9 row 6 | **1 — V1 external input** | Register calibration |
| 19 | `cost.battery.cu_per_equivalent_cycle` | ✔ §9 row 6 | **1 — V1 external input** | Register calibration |
| 20 | `energy.reserve_floor_wh` | ✔ §9 row 6 / **6a** | **1 — V1 external input (Safety class)** | As row 7 |
| 21 | `environment.ambientC / packC` | ✔ §9 row 7 | **1 — V1 external input** | `NO_PRODUCER`: missing code **and** a named source |
| 22 | `masses.vehicleMassKg` | ✔ §9 row 8 | **1 — V1 external input** | `NO_PRODUCER` |
| 23 | `p_fail (per-agent failure probability)` | ✔ §9 row 9 | **1 — V1 external input** | `NO_PRODUCER` |
| 24 | `route_hazard_cost (Map service)` | ✔ §9 row 10 | **1 — V1 external input** | `NO_PRODUCER` |
| 25 | `return-leg Wh per metre (per routing profile)` | ✔ §9 row 14 | **1 — V1 external input** | `NO_PRODUCER`; the §N.2 row. Supplied **with** the charger (D-4) |
| 26 | `battery wear inputs (§14.4)` | ✔ §9 row 11 | **1 — V1 external input** | `NO_PRODUCER` |

**Result: 26 of 26 measured rows are present in the 28-row S-3 list. Zero rows fall into
classifications 6, 7 or 8. No runtime row is missing from S-3; no S-3 row is disproved.**

#### 5.6.5 The eight the runtime reports SATISFIED — and the two S-3 rows it never mentions

The composer's `satisfied` array on the same log entry, verbatim:
`["candidate.max_radius_by_sla_class","prisma","kv","runSerializable","selectForUpdate","signingKey","snapshot","Ω correction (candidates/omega.combinedCorrection)"]`.

| Runtime requirement | In the 28? | Classification | Why |
|---|---|---|---|
| `prisma` · `kv` · `runSerializable` · `selectForUpdate` · `signingKey` · `snapshot` | ✘ correctly | **3 — repository/assembly dependency already supplied by `server.js`**, and **5 — already satisfied** | **Measured, not inferred.** All six appear in `satisfied` and **none** appears in the unresolved set. Supplied at `Backend/server.js:657-722`: `prisma` `:658`, `kv` `:659`, `snapshot` as an accessor `:685`, `runSerializable` `:701`, `selectForUpdate` `:702`, `signingKey` `:718` |
| `Ω correction (candidates/omega.combinedCorrection)` | ✘ correctly | **4 — derived requirement, not an external input**, and **5 — already satisfied** | Computed from the snapshot; it resolved as soon as the snapshot did |
| `candidate.max_radius_by_sla_class` | ✘ correctly | **5 — already satisfied** | §6.3's wall-clock disjunction, exactly as E-8 classified it. Still owed by Operations; **not a V1 blocker** |

**And the two S-3 rows the runtime never mentions at all** — neither as missing nor as satisfied:

| S-3 row | Appears in the runtime measurement? | Classification |
|---|---|---|
| **Serviceable-region cell assignment (F33)** — §9 row 12 | **NO** | **1 — V1 external input**, invisible to this instrument (§5.6.6) |
| **One depot-class `Charger` row (F35)** — §9 row 13 | **NO** | **1 — V1 external input**, invisible to this instrument (§5.6.6) |

```
34 declared  =  26 unresolved  +  8 satisfied            ← measured on a running process
28 S-3       =  26 unresolved  +  1 region  +  1 charger ← the owner request
```

#### 5.6.6 The two blind spots — CHECKED AGAINST CODE, and the documented reason SHARPENED

**§5.2's claim was not accepted because it was written down. It was tested, and it holds — but
its stated mechanism is weaker than the truth.**

**What was checked.** `grep` for `serviceable`, `charger`, `spatial`, `hierarchy` and `indexMap`
across `Backend/src/workers/coordinatorPipeline.js` returns **no requirement row** for either. The
contract's nineteen explicit `id:` rows (`:290`–`:551`) plus the fifteen generated register rows
are the whole 34, and the only charger-adjacent row is `return-leg Wh per metre` (`:440`) — which
is the **rate**, not the estate. Confirmed at runtime: neither string occurs anywhere in the
measured `missing` or `satisfied` arrays.

**§5.2 says** they are read *"inside `planInputFor`, one seam further in, which the probe does not
walk."* **That is true but understates it.** The code shows the real reason:

- **F33** — `serviceabilityFor(snapshot)` (`coordinatorSolvePath.js:874-897`) reads
  `snapshot.spatial`. With no published map it sets `index = null` and returns every stop
  **unchanged**, leaving `serviceable` absent. **It never refuses.** An absent region is not a
  composition failure by construction; it is a per-request indeterminacy that F33 turns into a
  DENY later. There is nothing for a dependency probe to report.
- **F35** — `chargerCandidatesFor` (`:767-843`) is an **async request-time Prisma query**
  (`table.findMany`, `:792`) that returns `problems: ["no Charger rows are declared in this
  deployment"]` (`:794`) rather than a composition refusal.

**The sharper statement, which matters for what to do about it:** the dependencies these two seams
*need* — `snapshot` and `prisma` — are both in the **satisfied** list. What is absent is **data
inside a satisfied dependency**: an unpopulated field of a published snapshot, and an empty table.
**A dependency-resolution probe cannot see an empty table or an absent snapshot field at any depth
of walk.** So F33 and F35 will **never** become visible to `coordinatorPipeline.requirements()` —
this is not a probe that stops one seam short and could be extended, and §11 must not acquire a
work item to extend it.

**One consequence, measured:** the server output for this run contains **no** statement about the
region or the charger at all. Stage 3 refuses first, so `planInputFor` never executes and F33/F35
are never evaluated on a real request. **Their absence is invisible to the running system today**,
which is precisely why they are hand-carried on the 28-row list and must stay there.

#### 5.6.7 Does the measurement change the authoritative S-3 count?

**No. 28 stands, unchanged.**

| | |
|---|---|
| **OLD COUNT** | **28** |
| **NEW COUNT** | **28** — unchanged |
| **ADDED ROWS** | none |
| **REMOVED ROWS** | none |
| **RECLASSIFIED ROWS** | none |
| **WHY** | The runtime measured **26** unresolved, and all 26 are already S-3 rows. The remaining two S-3 rows (region, charger) are structurally invisible to this instrument (§5.6.6), so the measurement can neither confirm nor refute them and does not bear on them. The eight `satisfied` rows are the six process dependencies (class 3), one derived precondition (class 4) and one already-satisfied register row (class 5) — none is an S-3 input. **26 + 2 = 28.** §5.2's predicted decomposition — *"common rows = 26"*, +8, −2 — is reproduced exactly by a running process |

**What the measurement did change** is that §5.2's reconciliation is no longer an argument from
documents. **It is now the observed behaviour of the shipped composer on a live deployment**, and
the fifth widening §14.1 warned about did not occur.

---

## §6 F17 — THE FIRST `VIOLATED`, RESOLVED

**This section discharges the requirement that F17's `VIOLATED` be explicitly resolved before S-7
is called complete. The fixture was not changed, and no `PASS` was manufactured.**

### 6.1 Locations

| | |
|---|---|
| **Predicate source** | `Backend/src/engine/feasibility/predicates/f17.js` — condition 2 at `:103-145`, the `VIOLATED` return at `:133-145` |
| **Register row** | `Backend/src/engine/feasibility/register.js:116` — class `INVARIANT`/`I`, policy `DENY`, cache tier `NONE`, volatile-subset member |
| **Plan-side twin** | `Backend/src/engine/plan/column.js:107-142` — `assertQueueDepthIsPlanFeasibility`, same rule as a plan property |
| **Test / fixture** | `Backend/tests/engine/coordinatorSolvePathComposition.test.js` — plan built at `:1165-1200`, assertion at `:1213-1256` |
| **Parameter** | `plan.commitment_horizon`, `Backend/src/engine/config/register/appendixA.json:1639-1659` |

### 6.2 The predicate

```js
// f17.js:130-133
const horizonMs  = tv.secondsToMs(horizonSeconds);          // plan.commitment_horizon
const extentMs   = extentEndMs - decisionTimeMs;            // plan end − decision time
if (extentMs > horizonMs) → VIOLATED
```

`extentEndMs` is `plan.horizonEndMs ?? plan.projectedEndMs` (`f17.js:121`), and
`Backend/src/engine/plan/planBuilder.js:824-825` sets both to `lastProjected.departureMs` — **the
departure time from the plan's last stop**. So condition 2 compares the plan's **end**, measured
from the round's pinned decision time, against the commitment horizon.

### 6.3 Why 920 > 900

| Quantity | Value | Source |
|---|---:|---|
| Hop 1 travel | 400 s | fixture hop, `coordinatorSolvePathComposition.test.js:1178-1184` (`distanceM: 800, travelSeconds: 400`) |
| Hop 2 travel | 400 s | same, two identical hops |
| Service time × 2 stops | 120 s | fixture register override `"plan.service_time_prior": 60` at `:137` |
| **Plan extent** | **920 s** | 400 + 400 + 60 + 60 |
| `plan.commitment_horizon` | **900 s** | **the published register default** — `appendixA.json:1643`, confirmed live: `service.defaultSnapshot().resolve("plan.commitment_horizon", {})` → `900` |
| Margin | **−20 s** (−2.2 %) | `f17.js:138` reports it as `horizonMs − extentMs` |

**The 900 is not a fixture value.** The fixture overrides `plan.service_time_prior`; it does
**not** override `plan.commitment_horizon`. The rule is read from the shipped register.

### 6.4 Why it appeared only now

F17 evaluates condition 1 (capacity) before condition 2. Until E-11, `readIndexedParameter`
discarded the resolver's scope-resolved **scalar**, so `capacity` returned `undefined`, F17
returned `absent(...)` at `:75-80`, and **condition 2 was never reached**. R-7 made `capacity`
readable (`capacity` resolves to `1` on the published register, confirmed live), and the predicate
ran to completion for the first time.

**This is a fix making an existing rule visible, not a regression introducing one.**

### 6.5 Expected result — is the predicate right?

**Yes, and the specification says so in the same words.**

> `NEXT_GENERATION_ASSIGNMENT_ENGINE.md:3129-3132` — *"A column is admissible only if
> `plan₀(a) ⊕ L(c)` holds no more than `capacity[agent_class]` concurrent commitments (F17) **and
> extends no further than `plan.commitment_horizon` into the future.**"*

The register row (`:1745`) and `f17.js`'s own docstring (`:27-34`) use the same formulation.
`extends no further into the future` is the plan's furthest extent, which is what `f17.js:121`
reads and what `planBuilder.js:825` computes. **The implementation matches the specification
verbatim.**

**One adjacent question, checked and closed.** `plan.max_admissible_mission_duration` (600 s)
exists and might look like the parameter that *should* have bounded a 920 s plan. It does not:
`grep` finds it read **only** by `Backend/src/engine/config/validators.js:216`, in the publish-time
algebra `cost.opportunity.value_horizon > plan.commitment_horizon + plan.max_admissible_mission_duration`
(§8.3 horizon discipline, spec `:2064-2069`). Its own register description settles the intent —
*"a placeholder for a measured figure, **not a service limit**"*
(`Backend/src/engine/config/register/supplementary.json:26`). **It is not a feasibility bound, no
predicate is missing, and there is no permissive gap here.**

### 6.6 Classification

**None of A, B, C or D. The correct classification is E — CORRECT-BY-SPECIFICATION (a true
positive).** Stated against the four offered options so the rejection is explicit:

| | Option | Verdict |
|---|---|---|
| **A** | Intentional negative/counterfactual fixture | **NO.** The fixture was built to exercise the composition, not to fail F17. The test comment records the `VIOLATED` as a discovery, and the assertion was added *after* the behaviour appeared |
| **B** | Fixture/test defect | **NO** for the `VIOLATED` itself — two 800 m hops at 400 s (2 m/s) plus two 60 s service stops is a physically ordinary mission. **See §6.8 for one residual test-durability item, which is not this** |
| **C** | Real V1 correctness defect | **NO.** The predicate implements the specification's sentence exactly, reads a published parameter, and produces the documented `VIOLATED` outcome with a correct margin and reason |
| **D** | Unresolved | **NO.** It is resolved here |
| **E** | **Correct behaviour, newly visible** | **YES.** A real rule, read from the register, broken by a real plan |

### 6.7 Can the violation reach a real V1 decision?

**In principle yes; today no.**

- **In principle:** F17's policy is `DENY` and it sits on the §10.3.2 step-3 volatile subset
  (`Backend/src/engine/feasibility/volatileSubset.js:65`), so it is re-checked inside the commit
  transaction. A real plan whose end exceeds 900 s from the decision time **will** be denied, and
  denied correctly.
- **Today:** no plan is built in production at all. `plan.service_time_prior` resolves to `null`
  on the published register (confirmed live), so `planBuilder.resolveServiceTimes` fails closed and
  `buildVariant` returns before projecting a timeline. **F17 cannot be reached on a real request
  until S-3's register calibration arrives.**

**Present in production composition, or only in a test fixture?** The **rule** is in production
composition — the predicate, the parameter and the plan-side twin all ship. The **920 s plan** is a
test fixture only. No production plan has ever been evaluated by F17.

### 6.8 Required fix, verification, and V1 classification

| | |
|---|---|
| **Required fix to F17, `column.js`, or the fixture** | **NONE.** Nothing is to be changed to remove this `VIOLATED` |
| **V1 blocking classification** | **NOT V1-BLOCKING.** It blocks no stop condition. `npm test` is green *with* the `VIOLATED` asserted; S-7's failing half is `gate:composition`, which is S-4/S-3 |
| **Effect on §7.5's counterfactual** | The 33/38 → 31/38 → 30/38 ladder in §N.5 counts denials. One of those denials is now a `VIOLATED` rather than an `INDETERMINATE`, which is why `deniedForIndeterminacyOnly` correctly reports `false` |
| **One residual, registered not fixed** | The assertion is pinned to an **`UNCALIBRATED`/`PROVISIONAL`** default. `appendixA.json:1653-1654` marks `plan.commitment_horizon` `calibrationStatus: PROVISIONAL`, `awaits: "observed commitment lead times"`. If Ops calibrates it to any value ≥ 920 s, `expect(violated.map(…)).toEqual(["F17"])` fails and the suite goes red for a reason unrelated to any defect. **Recorded as W-A2 (§11.A). It must not be closed by shortening the fixture** — the correct closure is to make the fixture's horizon assumption explicit, and that is repository work to be scheduled, not done reactively |
| **Exact verification that this is resolved** | `npx jest tests/engine/coordinatorSolvePathComposition.test.js` → the suite passes with exactly one `VIOLATED`, `predicateId === "F17"`, `reason` matching `/commitment horizon/`, `observed.extentMs > 900_000`, and `deniedForIndeterminacyOnly === false` |

**F17 is resolved. It does not block S-7.**

---

## §7 V1 STOP CONDITIONS — S-1 … S-8, LIVE

**These are the canonical eight of §I.2. There is no S-9 and none may be added.** Statuses below
were verified against this tree, not copied.

| ID | Requirement | Status | Evidence | Exact blocker | Owner | Next action | Closure proof |
|---|---|---|---|---|---|---|---|
| **S-1** | No reported optimality gap is ever a value the engine did not prove, **and no absent physical input is read as a benign one** | **MET** | E-1 and E-8 regression suites present and passing; `solveRoundSearchGapProvenance.test.js` (14). E-11's R-5 extends the same rule: an unassigned cell stays **absent**, never `false` (`coordinatorSolvePath.js:865-866`) | — | Repository | Hold. Re-verify on every core-path change | `npm test` exit 0 **and** the E-1/E-8 suites present and green |
| **S-2** | `registry.js` names, for every worker, a register parameter that exists or a `@structural` constant with a stated reason | **MET** | Fixed 2026-09-01; `assertRegistry()` assertion green; `workerRegistry.test.js` 15 passed | — | Repository | Hold | `assertRegistry()` green in `npm test` |
| **S-3** | The external values are supplied by the owner, in writing, in a decision record under `docs/release-decisions/` | **NOT MET** | **28 inputs** (§5.4), **confirmed by live measurement 2026-09-05 (§5.6): the running composer reported `26 of 34 inputs unresolved`, all 26 already on the list, plus the 2 rows the instrument cannot see.** **The decision record now exists and is ISSUED, AWAITING RESPONSE** — `docs/release-decisions/RD-2026-09-05-01-v1-external-input-and-owner-decision-request.md`, 2026-09-05, covering §9 rows 1–18 and §10 D-1…D-6. **Not one item in it is answered** *(this cell previously read "No decision record exists")* | **The inputs do not exist.** 5 routing · 15 register calibration (2 Safety-class) · 6 no-producer families · 1 region declaration · 1 charger declaration | **Owner** + §22.4 calibration owner + Engineering (for the `NO_PRODUCER` code and data sources) | **W-D1 and W-D2 are both CLOSED.** The request is issued; **the next act is the owner's**, and no repository action closes S-3 | The **answered** record — values supplied, decisions made, evidence attached — under `docs/release-decisions/`. **Issuing the request does not close S-3; only the response can** |
| **S-4** | The coordinator's solve path is composed at `server.js` and `leaderWorkers.COMPOSERS.coordinator` returns a started handle | **NOT MET — a consequence of S-3, not an independent defect** | `npm run gates` → `gate:composition` **exit 1**, 1 violation, `LEADER_ONLY_NOT_COMPOSABLE` for `coordinator`. **The composition is written and correct**: `coordinatorSolvePath.create()` assembles all three seams and refuses only because `coordinatorPipeline.requirements()` reports unresolved inputs (`coordinatorSolvePath.js:1527-1545`) | S-3 | Owner (via S-3) | None available in this repository. Do **not** weaken the gate | `npm run gates` **exit 0**, `gate:composition` 0 violations |
| **S-5** | A config version binding `cutover.engine_enabled = true` at region scope is published and pinned, and the process runs with `ENGINE_ENABLED=true` | **NOT MET — and RECLASSIFIED 2026-09-06: BLOCKED BY FD-3 = NO.** *(This cell previously read "mechanism exists and is verified; the owner configuration act is absent", which was true and incomplete: it described the act as **available and untaken**. Measured, the act is **refused**.)* | Mechanism verified end to end over HTTP in the E-11 run: real `POST /api/tasks/assign` → **HTTP 503 `ENGINE_NOT_LIVE`** before anything was written (§12.1). `enabled.describe(...)` returns `processEnabled: true, configEnabled: false, live: false, decisionPath: "NONE"`. **No code change is needed** (`Backend/src/engine/cutover/enabled.js`). **S5-1, 2026-09-05, on a disposable PG 18.3 cluster:** a labelled non-production publish binding **only** `cutover.engine_enabled = true` at region scope, with no Safety binding and no accommodation, is **REFUSED** — `ConfigValidationError`, 2 BLOCKING findings, **0 `ConfigVersion` rows written** (§16) | **Two independent refusals, neither of which is "the owner has not got round to it".** **V9** — the register's *own defaults* give a combined degraded conservatism of `2.0125` against a cap of `1.6`; it is in `validateCandidate`'s blocking set for a candidate binding only `cutover.engine_enabled`, so it blocks **every** publish, first or subsequent, until a Safety decision moves `route.degraded_reserve_factor` or `energy.max_combined_conservatism`. **S2** — a first publish has no `previousValues`, so `safetyClassChanges` returns **47** names and §22.3's two-person rule fires **whatever is bound**; measured, a *subsequent* publish changing no Safety value returns **0** and S2 does not fire. `cutover.engine_enabled` is `STRUCTURAL` and is **not** in either set — its own change class was never the constraint | **Safety** (via **D-1**/B8), then **Owner** | **S5-1 — DISCHARGED 2026-09-05, and it is the evidence in the cell to the left.** The approved plan set this row's next action to *"run S5-1"*; S5-1 has been run and its verdict is recorded, so the next action is no longer a measurement. **There is none available in this repository**: both refusals need a Safety authority and a second approver, and **FD-3 = NO** means neither exists. ~~What follows is **§11 step 7 (S5-2 → S5-4)**, behind steps 4, 5 and 6.~~ **MEASURED 2026-09-06 — §7.1: S5-2 is itself BLOCKED, and not only by its position in the order.** Its fine-cell derivation has no answer that is neither empty nor `containmentOverlapping`, which the owner has **refused** as a standing decision, and whose escalation target is **NOT DEFINED** (§7.1.2). **S5-3 = classification B — FD-3 = NO**, on V9 *and* S2, re-derived against the full S5-2 candidate (§7.1.3). Do **not** add an accommodation to obtain a publish, and **do not choose a containment mode to obtain a non-empty cover** | `cutoverEnabled.describe(...)` reports `live: true`, `decisionPath: ENGINE` — reachable only once V9 and S2 are discharged |
| **S-6** | One real request over HTTP against a live PostgreSQL reaches a durable `Commitment` row and an `Outbox` row in the same transaction, with a `Round` row and a per-Leg decision record | **NOT MET — ATTEMPTED for the first time, did not complete** | Harness exists (`Backend/tools/verify/v1CorePath.js`, 468 lines) and was run: PG 18.3, **28** migrations, seeded region/shard/agent-class/agent/battery/position, `server.js` as a separate process, real JWT, real HTTP POST. **Exits 1 at S-5, with S-3 reported from the same process** — **re-run independently 2026-09-05 on a fresh disposable PG 18.3 cluster (§5.6): same exit 1, same two boundaries, same order** | S-5, then S-3 | Owner (via S-5 and S-3) | **W-D1 done** — the numerator is **26 of 34** (§5.6). Full closure needs S-3 + S-5 | `node tools/verify/v1CorePath.js` **exit 0** |
| **S-7** | `npm test` exit 0 **and** `npm run gates` exit 0 | **NOT MET — one half holds** | `npm test` **exit 0** — **167 suites / 7 429 tests / 0 failures**, re-run after the 2026-09-05 repository-only pass *(166 / 7 411 before it; +1 suite and +18 tests, all added by that pass)*. `npm run gates` **exit 1** — 7 PASS, 1 FAIL, **unchanged and not weakened**. **F17's `VIOLATED` does not contribute** (§6.8) | `gate:composition`, i.e. S-4 → S-3 | Owner (via S-3) | Nothing independent. S-4 closes it | Both commands exit 0 |
| **S-8** | The V1 documentation states plainly what V1 does **not** guarantee | **MET** | `V1_CONTRACT_AND_STOP_CONDITION.md` §I.1 and §G; restated and extended by §12 of this document | — | Repository | Keep §12 current as classifications change | This document plus the contract, both current at the released tree |

**Score: 3 of 8 met (S-1, S-2, S-8). 5 not met (S-3, S-4, S-5, S-6, S-7).**

> **V1 is not complete and must not be described as complete while any of the five remains open.**
> Four of the five (S-4, S-6, S-7, and S-5's blocked half) are **mechanical consequences** of S-3
> and S-5. The repository closes none of them.

### 7.1 S5-2 AND S5-3 — MEASURED 2026-09-06. **BOTH BLOCKED, and the blockers are not the same one.**

**Nothing was published, pinned, seeded or written. Every number below is produced by the shipped
modules, read-only, at HEAD `10a527c`.** No region, zone, cell assignment, shard, charger, router
or calibration value was created on any store.

#### 7.1.1 S5-2 — **BLOCKED.** Two independent missing prerequisites, and only one of them was expected.

The six prerequisites, each checked against code rather than against a document:

| # | Prerequisite | Verdict | Measured evidence |
|---|---|---|---|
| 1 | **Authoritative region declaration** | **ABSENT** | `regionBoundary.validateRegionDeclaration({ boundary: <the adopted `way/1120154292` Polygon> })` → `status` not `VALID`, **six named problems**: `regionId`, `name`, `kind`, `crs` (*"required and is never assumed"*, V-6), `version`, `versionDate`. `RD-2026-08-30-01` §7 item 3 said exactly this in prose; this is the same finding produced by the validator |
| 2 | **Authoritative boundary** | **ADOPTED AS INTENT, NOT SUPPLIED** | `RD-2026-08-30-01` §1 adopts the geometry; its own §7 gives four independent reasons D1 is unmoved, including that the file is **this repository's own tracked demo data**, which `B1_EXTERNAL_INPUT_HANDOFF.md` §1.1 forbids as D1 data and whose STOP rule 5 refuses to promote without human approval |
| 3 | **Valid fine-cell derivation** | ★ **REFUSED BY A STANDING OWNER DECISION** | See §7.1.2. This is the prerequisite whose absence is *decisive*, and it is not the one the plan expected |
| 4 | **Region / zone / site relationships** | **UNDECLARED** | `cells.validateAssignment` requires a `zoneId` on every FINE assignment — *"an unassigned fine cell is a hole in the pricing surface"* (§3.6). No zone identity is declared anywhere for either campus, and a zone is where §6.4's `λ_zone` is estimated, so inventing one is a modelling act with pricing consequences, not a label |
| 5 | **Configuration / version records** | **REFUSED** | Identical to S5-3's refusal — see §7.1.3. The spatial payload is provably **not** the constraint |
| 6 | **Shard row semantics** | **MECHANISM EXISTS; NOTHING CALLS IT** | See §7.1.4 |

#### 7.1.2 The decisive finding — **every non-empty fine-cell derivation from the adopted boundary IS `containmentOverlapping`, which the owner has REFUSED**

Measured on this tree with `h3-js@4.5.0` at the unchanged `@structural B5` resolutions. **No
resolution was changed and no cover utility was written.**

| Derivation | Cells | Assigned area | Ratio to the campus |
|---|---:|---:|---:|
| Campus polygon `way/1120154292` | — | **0.0998 km²** | 1× |
| `polygonToCells` (standard / `containmentCenter`), res 8 | **0** | 0 | — |
| `containmentFull`, res 8 | **0** | 0 | — |
| **The ring's 18 unique vertices → `latLngToCell(…, 8)`** | **3** | **2.2759 km²** | **22.8× — 95.6% of the assigned ground lies outside the campus** |
| `containmentOverlapping`, res 8 | **3** | **2.2759 km²** | **22.8×** |
| `containmentOverlappingBbox`, res 8 | 5 | 3.7932 km² | 38.0× |

> **The vertex derivation and `containmentOverlapping` return the same three cells.** So
> *"derive the minimal fine-cell assignments from the adopted boundary"* has, on this geometry, no
> third answer: it is either **empty** — which assigns nothing and is what the standard path
> returns — or it is **`containmentOverlapping` under another name.**
>
> `B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.4 item 2 is a **standing refusal, not an unfilled blank**:
> *"`containmentOverlapping` is REFUSED. `containmentOverlappingBbox` is REFUSED. The owner does
> not authorise geographic over-assignment of non-campus area into a RobotX region … a mode chosen
> for validator success is the check answering itself."* Reaching the same three cells through
> `latLngToCell` on the vertices rather than through `polygonToCells` **is that mode, chosen for a
> different reason**, and §17 rule 3 forbids fabricating a region.

**Classification: OWNER DECISION — and specifically the escalation that `B1_EXTERNAL_INPUT_HANDOFF.md`
§1.8.5 records as `OPEN WITH NO TARGET`.** It is **not** repository-owned; it is not repository-fixable;
and it must not be resolved by this or any future session choosing a containment mode.

*(New measurement: §1.8.3 recorded this for **JSSATE** — 0.1022 km², 1 cell, ≈86% outside. **RNSIT
is worse on the same arithmetic**: 3 cells, 95.6% outside. The two campuses are behind the same
blocker, and RNSIT's exposure is larger, not equal.)*

#### 7.1.3 S5-3 — **BLOCKED. Classification: B — FD-3 = NO / Safety approval policy. Not a repository defect.**

S5-1's refusal was re-derived read-only against the **S5-2 candidate** — the full payload, not
S5-1's bare one: the `cutover.engine_enabled = true` region binding **plus** `regions[]`,
`zones[]`, the three fine-cell assignments and a well-formed `shards[]` definition.

```
validateCandidate(<the full S5-2 candidate>)  →  199 findings, blocking = ["V9"]
safetyClassChanges(entries, values, previousValues = null)  →  47
checkSafetyApproval({ publishedBy: 1 identity }, 47 changes)  →  ["S2"]   (SAFETY_APPROVAL_QUORUM = 2)
```

**Two results, and the second is new:**

1. **The refusal is unchanged and is not repository-owned.**
   - **V9** is arithmetically correct and does not double-count. Measured from the register's own
     defaults: nominal `= 1.15 × 1.25 × 1.0 = 1.4375` (`energy.charger_availability_margin`,
     `energy.uncalibrated_reserve_factor`, `energy.f_derate`); degraded `= 1.4375 × 1.4 = 2.0125`
     (`route.degraded_reserve_factor`); cap `energy.max_combined_conservatism = 1.6`. **Both
     movable parameters are `changeClass: SAFETY`, `PROVISIONAL`** — so discharging V9 is D-1/B8,
     which **FD-3 = NO** blocks.
   - **S2** fires on the *version*, not the parameter: a first publish has `previousValues = null`,
     so 47 Safety-class parameters count as changed **whatever is bound**. One approver identity
     against a quorum of 2. **FD-3 = NO** says there is no second approver and no self-approval.
   - **There is nothing legitimate to fix.** Neither finding is a defect; both are the checks
     working. No accommodation was added, no approver was synthesised, no gate was touched.
2. ★ **The spatial payload is provably not the constraint.** Adding the region, the zone, the three
   fine-cell assignments and the shard definition to the candidate produced **zero additional
   blocking findings** — `hierarchy.validate`, `cells.validateAssignment`, A6, V-4 and V-8 all pass
   on it. **So S5-2's config half and S5-3 are one refusal, not two**, and any future reader must
   not record S5-2 as *"blocked on a spatial problem at publish"*: it is blocked **before** publish,
   at §7.1.2, and blocked **at** publish for S5-3's reasons.

#### 7.1.4 One previously unrecorded fact, on the S5-2 path — **recorded, deliberately NOT changed**

**`shardModel.ensureShard` — the repository's own path for creating a `Shard` row, the one S5-2
would use — is called from nowhere in `src/`, nowhere in `server.js`, and by no harness.**

- It exists, validates its input, creates the `ShardLeadership` row inside the same transaction, is
  idempotent, and is unit-tested (`tests/engine/shardModel.test.js`). Its own docstring states why
  the leadership row must go first: *"a shard that existed without one would be a shard against
  which every commit aborts for a reason that names neither the shard nor the missing row."*
- The control plane has no create path: `src/routes/shards.routes.js` exposes `GET /` and
  `POST /:id/rebalance` only.
- The one place a `Shard` row is created in practice is `tools/verify/v1CorePath.js:124-125`, which
  hand-rolls **both** rows and therefore takes the schema default `leadershipFence = 0`, where
  `leadership.ensureShard` explicitly sets **1** *"so that 'has not moved' is distinguishable from
  'there is no leadership record'"*.

**This is the *producer exists and nothing calls it* family at an eighth place — and, measured, it
has no correctness consequence today.** Every consumer of `leadershipFence` tests it explicitly
against `null`/`undefined` and never for truthiness: `guards.js:103`, `tierA.js:325`,
`membership.js:339`, `app.js:214`. The distinguishability the comment describes is carried by those
null checks, not by the value being non-zero.

**It is therefore NOT given a W-item and NOT fixed, and both halves of that are deliberate.** It is
in `tools/verify/`, which §11.A's W-A4 note already establishes is **not the core path**, so
**§3.1's status does not revert**. Editing the S-6 harness's seed with no measured defect to point
at would be touching the instrument S-6's verdict rests on — the symmetric case of §14.3's rule —
and inventing a work item for it would extend a list §11 declares closed. **The recommendation, for
whoever executes S5-2 when it is unblocked, is that the `Shard` row be created through
`shardModel.ensureShard` rather than hand-rolled.**

#### 7.1.5 The assignment-engine composition, re-measured independently — **it is NOT "released by B1"**

`coordinatorPipeline.requirements()` was run read-only against a context supplying exactly what
`server.js:657-722` supplies — the six `PROCESS_DEPENDENCY` rows and the expansion wall-clock
budget. **It reproduces the live E-11 figure exactly:**

```
26 of 34 inputs unresolved   { EXTERNAL_ROUTING: 5, REGISTER_UNRESOLVED: 15, NO_PRODUCER: 6 }
satisfied (8): prisma, kv, runSerializable, selectForUpdate, signingKey, snapshot,
               Ω correction, candidate.max_radius_by_sla_class
```

*(A first run of the same probe reported `27` — with `candidate.max_radius_by_sla_class` missing —
because that probe honours §6.3's **disjunction** and reads `context.expansionWallClockBudgetMs`,
which the synthetic context had not supplied. Supplying it reproduces `26`. **Recorded because the
difference is the instrument's context, not a disagreement**, and an unexplained 27 would have read
as a seventh widening.)*

> **B1 releases 5 of the 26.** The other 21 are **15** register rows that are `null` by declaration
> and belong to §22.4's calibration owner — §22.3 forbids an automated process from choosing them —
> and **6** input families with no schema column and no data source anyone has named. **A routing
> source arriving tomorrow starts no coordinator.** The shorthand *"the coordinator is blocked on
> B1"* is the sentence §E.1 of the contract already records as having survived six passes
> unexamined, and it must not be restored.

**No new repository-owned defect was found in the composition path by this pass**, and the check
was not a reading exercise:

- The **F33 consumption seam** — the one an executed S5-2 would feed — was exercised against the
  exact spatial payload §7.1.2 derives. Measured: with no map published, every stop keeps
  `serviceable` **absent**; with the map published, a stop at the campus centroid resolves
  `serviceable: true` and a stop outside the map keeps `serviceable` **absent, not `false`**. That
  is §17 rule 4 and §M.2's *"an unassigned cell is not an out-of-area one"*, holding at runtime.
- A **mechanical sweep for the recurring family** — an exported producer with no caller — was run
  over all **81** modules reachable from `coordinatorSolvePath.js`. It returned **116** candidates
  and is **not reported as 116 findings**, because the instrument does not discriminate: it cannot
  see a comparator passed by reference (`sort(compareX)`) or an assertion helper a test calls, and
  substantially all 116 are those. **A detector with that false-positive rate is not evidence, and
  presenting its output as a defect list would be worse than not running it.** The one candidate it
  surfaced that survived reading is §7.1.4's `shardModel.ensureShard`, which is on the S5-2 path
  rather than the solve path and has no measured runtime consequence.

**Verdict: the coordinator's composition failure is B1-blocked *in part* — 5 of 26 — and
owner/calibration-blocked for the remaining 21. `gate:composition` stays RED and was not touched.**

#### 7.1.6 STEP 4 — doable V1 cleanup: **there is none, and that is a measured state, not a shrug**

§11.A holds **zero open repository items**: W-A1…W-A5 closed 2026-09-05, W-A6 and W-A7 closed in the
N-1/N-2 pass, and §11.A's own closing line — *"There is no W-A8"* — stands after this pass. §14
forbids the four ways that state is usually misread, one of which is by name **"do not hunt for new
work."**

Two candidates were considered and **declined, each for a stated reason**:

| Candidate | Declined because |
|---|---|
| Route the S-6 harness's `Shard` seed through `shardModel.ensureShard` | §7.1.4 — no measured defect, `tools/verify/` is not the core path, and editing the instrument S-6's verdict rests on without one is §14.3's rule in mirror image |
| Add a regression test pinning §7.1.2's cell derivation and §7.1.3's `blocking = ["V9"]` | It would commit a **fabricated** `regionId`, zone id and cell-assignment set into the suite, where a later reader could mistake it for a declared region — the exact shape of §17 rule 3. The measurement belongs in this document, where it is labelled as a measurement |

#### 7.1.7 What §7.1 changed, and what it did not

**No stop condition moved. The score is 3 of 8.** S-5 remains NOT MET and remains blocked by
FD-3 = NO; §7's S-5 row is unchanged in verdict and gains §7.1 as further evidence. S5-2 is now
recorded as **BLOCKED on an owner decision with no defined escalation target** — which is a
*harder* boundary than "behind steps 4, 5 and 6", and it is stated rather than softened.

---

## §8 THE V1 CRITICAL PATH — STAGE BY STAGE

`REAL?` answers one question: **does this stage participate in real production composition on this
tree**, or is it constructed only by tests?

| # | Stage | Source | Worker | Input dependencies | Output | Persistence | Safety behaviour | Verification | Current state | REAL? |
|---|---|---|---|---|---|---|---|---|---|---|
| **1** | **Request** | `Backend/src/controllers/tasks.controller.js` → `Backend/src/services/task.service.js` (`assignTask`) | HTTP process | JWT + `User` row; `cutoverEnabled.describe({snapshot: app.locals.config, shard:{regionId}})` (`Backend/src/engine/cutover/enabled.js`) | `Task` row (`PENDING`), or 503 | `prisma.task.create` | **Fail-closed.** `live === false` → **503 `ENGINE_NOT_LIVE`, nothing written** (§12.1). Both `processEnabled` **and** `configEnabled` required; `forShard` ANDs them | E-11 live HTTP POST returned exactly this 503 | **WORKS.** Refuses correctly, because S-5 is unbound | **YES** |
| **2** | **Durable queue** | `task.service.admitToRound` → `Backend/src/engine/intake/intake.js`, `admission.js`; `legacyTask.taskToWork` | HTTP process | `Task` row; deterministic ids ⇒ idempotent | `WorkQueue` row; `Leg` upsert; `slaDeadline` set; `QUEUED` timer registered | One `$transaction`: `leg.upsert` + `superviseQueuedEntry` + `leg.update{slaDeadline}`, then `intake.admit` | Durable and survivable. T1-04 | Covered by the engine suite; exercised live by E-11 up to the 503 | **WORKS** | **YES** |
| **3** | **Coordinator** | `Backend/src/workers/coordinator.worker.js` (`runRound`); composed by `Backend/src/workers/leaderWorkers.js` (`COMPOSERS.coordinator`, `:375-400`) via `Backend/src/workers/coordinatorSolvePath.js` (`create`, `:1521-1545`), contract in `Backend/src/workers/coordinatorPipeline.js` | `shardSupervisor.worker` → `leaderWorkers.apply({mayRunRound})` | **34 declared inputs** (§5.1). Leadership via `election.assertConsensusStore` (`Backend/src/engine/shard/election.js:141`) | A started handle, **or** a named refusal | — | **Fail-closed and total.** Nothing is partially assembled: *"the assembly does not exist unless every declared input does"* (`coordinatorSolvePath.js:1533-1536`) | `gate:composition` reads `UNCOMPOSABLE.coordinator` and stays RED; `coordinatorSolvePathComposition.test.js` 68 passed | ★ **THE STRUCTURAL BREAK.** Refuses with `EXTERNAL_DEPENDENCY_UNAVAILABLE` | **YES — the composition is real; it refuses** |
| **4** | **Candidate generation** | `Backend/src/engine/candidates/expansion.js`, `availabilityIndex`, `lowerBound.js`, `omega.js` | coordinator | `candidate.max_radius_by_sla_class` **or** §6.3's wall-clock bound; fine cell from `cells.cellForPoint` (pure H3, no declaration) | candidate set | — | `unbounded_search_refused` if neither bound resolves (T9, §6.1) | Unit-tested | **Implemented; unreachable in production** — stage 3 refuses first | **NO — reached only by tests** |
| **5** | **Routing** | `Backend/src/engine/routing/cellPairCache.js` (`read`, `hopsFor`, `buildEntry`, `applyIntraCellOffset`) | coordinator | **`deps.route(parts)` — the six-field contract (§F.2). NO SOURCE EXISTS.** Plus `speedMetresPerSecond` per profile | hop distance/time/spread/terrain | cache entry | `buildEntry` **refuses and caches nothing** on a malformed row. *"A declared `0` is accepted in every field. Silence is not"* | `tools/routing/b1Benchmark.js` measures the seam; `npm run routing:readiness` → **BLOCKED** | ★★ **NO SOURCE.** B1, blocked on D1/D3/D8 | **NO** |
| **6** | **Feasibility** | `Backend/src/engine/feasibility/evaluate.js`, `register.js` (38 predicates), `predicates/*.js`, `threeValued.js`, `volatileSubset.js` | coordinator | plan; agent snapshot; config snapshot with `agent_class` scope; `stop.serviceable` (F33); `plan.energy.chargerReachability` (F35) | per-predicate verdict + gate outcome | decision record | **UNKNOWN IS NOT PERMISSION.** Indeterminate → `DENY`, including at `ADMIT_WITH_PENALTY` and `DENY_UNLESS_ENVELOPE` when their admitting inputs are absent | `feasibilityPredicates.test.js`; §7.5 counterfactual **33/38 → 31/38 → 30/38** (§N.5) | **Implemented; can now see.** One `VIOLATED` (F17, §6) | **NO — reached only by tests** |
| **7** | **Pricing** | `Backend/src/engine/cost/phi.js`, `cDirect`, `cRisk`, `cLifecycle`, `cDelay` | coordinator | **15 unresolved register rates** (§5.2); `p_fail`; route hazard cost; battery wear inputs | `Φ` per candidate | decision record | Every rate refuses individually rather than defaulting. `phi.assertWearChargedOnce` keeps wear charged exactly once | Unit-tested | **Implemented; unreachable** | **NO** |
| **8** | **Solve** | `Backend/src/engine/solve/round.js`, `objective.js`, `minCostFlow.js`, `budgets.js`, `cadence.js`, `regime.js` | coordinator | priced columns; `plan/columnBuilder.js` | assignment | `Round` row | Integral/exact in the singleton regime; **no reported gap is a value the engine did not prove** (S-1, C.3 fix) | `solveRoundSearchGapProvenance.test.js` (14) | **Implemented; unreachable** | **NO** |
| **9** | **Commit** | `Backend/src/engine/commitment/commit.js`; `volatileSubset.createVolatileRecheck`; `Backend/src/engine/plan/planState.js` (`reserve`, SOFT §2.6); `leases.grant` (`lease.duration`) | coordinator | transaction seam, row lock, §23.3 signing key — all supplied by `Backend/server.js:701-718` | `Commitment` row | **§10.3.2 step 5: the `Outbox` row is written IN the commit transaction** | Volatile subset (incl. **F17**, F35) re-checked under the row locks | Unit-tested | **Implemented; assembled by `coordinatorSolvePath`; unreachable** | **NO** |
| **10** | **Dispatch** | `Backend/src/workers/outbox.worker.js`; `dispatchOutboxCommand(io, {activeModes})` (`server.js:715-717`) | `outbox.worker` (**composed and started**) | `Outbox` rows | signed command on the §11.3 transport | outbox drain | `modeRegister.commandsSuspended(activeModes)` — §18.5 Custodial Operation enforced per delivery (P15-R3) | Chaos + engine suites | **WORKS** — running, with nothing to drain | **YES** |
| **11** | **Lifecycle supervision** | `Backend/src/workers/timer.worker.js` + `expiryActions.handlers({ladder})` + `ESCALATION_LADDER`/`fairness/ladder`; `Backend/src/workers/reconciler.worker.js`; `Backend/src/engine/lifecycle/*.js` | `timer.worker`, `reconciler.worker` (**composed and started**) | timers registered at stage 2; `Leg`/`Task` state | escalation, reassignment, settlement, cancellation | DB | T1-04 ladder; §4.6 cancellation latch (X7) | Engine + chaos suites; `lifecycle_c1` closes exhaustively in TLC | **WORKS** | **YES** |
| **12** | **Decision recording** | `Backend/src/engine/observability/decisionRecord.js` (`writeRound`) | coordinator | round result | Tier A + sampled Tier B records | DB | `gate:erasure` proves reconstruction from Tier A alone, byte for byte | `gate:erasure` **PASS** — 3 corpus decisions | **Implemented; unreachable** | **NO** |

### 8.1 What the path establishes

| | |
|---|---|
| **Real in production composition today** | Stages **1, 2, 3, 10, 11** — request, durable queue, the coordinator's *refusal*, dispatch, lifecycle supervision |
| **Implemented, tested, and NOT in real composition** | Stages **4, 5, 6, 7, 8, 9, 12** |
| **The single structural break** | Stage 3. Everything downstream is written and tested; the assembly **exists** and refuses because its inputs do not resolve |
| **What changed at E-11** | Stage 3 moved from *"nothing constructs it"* to *"it is constructed and refuses, by name, on measured inputs."* That is progress in truthfulness, and it closes no stop condition |

---

## §9 THE EXTERNAL / OWNER BOUNDARY — CURRENT AT E-11

**No value in this section is invented.** No region, no charger, no routing provider, no
calibration value is proposed, defaulted, or inferred anywhere in this document.

**Rows 1–18 are the boundary. Rows 1–14 are the 28 S-3 inputs (§5.4) grouped by supply act;
rows 15, 16, 17 and 18 are separately classified.**

> **CORRECTED 2026-09-05 by W-D1's reconciliation (§5.6.4).** This sentence read *"Rows 1–17 are
> the boundary. Rows **1–15 and 17** are the 28 S-3 inputs …; rows 16 and **the SHARD row** are
> separately classified."* It was wrong twice: it placed row 17 (`SHARD_CONSENSUS_REPLICATION`)
> both inside and outside the 28 in the same sentence, and rows 1–15 + 17 do not total 28. The
> arithmetic is **rows 1–14 = 5 routing (rows 1–5, row 2 being `route`'s terrain fields) + 15
> register (row 6) + 6 no-producer (rows 7–11, 14) + region (row 12) + charger (row 13) = 28**.
> Row 15 (B8) is **D-1** and row 17 is **D-5** — both owner *decisions* under §10, not inputs, and
> §10's own exclusion list already says so. Counting them would give 30 and contradict §5.4.
> **No row's content changed; only the sentence that indexes them.**

| # | Input | Exact shape required | Class | Owner | Where it enters | When absent (already implemented) |
|---|---|---|---|---|---|---|
| **1** | **`route` traversal source** | `async ({originCell, destCell, profileKey, timeBucket}) => {…}` — one declared, real, self-hosted source, and an explicit statement of the environment it is declared for | EXTERNAL_ROUTING | **Owner (B1)** | `leaderWorkers.create({ route })` → `cellPairCache.read` on a cache miss | *"no router is available and the entry is not cached"* |
| **2** | **`route` fields** | Exactly six, all finite and ≥ 0: `distanceM`, `travelSeconds`, `travelSdSeconds`, `climbM`, `descentM`, `stopStartCycles` (§F.2). **A declared `0` is accepted in every field; silence is not** | EXTERNAL_ROUTING | Owner (B1) | first three refused by `cellPairCache.buildEntry`; terrain three refused by `plan/timeline.project` | entry refused / `MISSING_TERRAIN` |
| **3** | **`travelSdSeconds` source (N29)** | A declared spread model with a named source. **No shortlisted engine returns a spread** — OSRM `table`, Valhalla `sources_to_targets`, GraphHopper `route` are all point estimates. Selecting an engine does **not** close this | EXTERNAL_ROUTING | Owner | `cellPairCache.buildEntry` | entry refused, nothing cached |
| **4** | **`speedMetresPerSecond` per routing profile** | One declared value per profile in use. **Not routing** — §20.3's intra-cell quantisation | EXTERNAL_ROUTING | **Owner (D3 — Product + Fleet Engineering)** | `leaderWorkers.create({ speedMetresPerSecondFor })` → `cellPairCache.applyIntraCellOffset` | correction refused; the cached pair is unusable |
| **5** | **`timeBucket`** (§20.3 congestion bucket) | A property of the query, part of declaring the traversal source | EXTERNAL_ROUTING | Owner | the `route` call | no query can be formed |
| **6** | **Register / calibration values — 15 rows** | `plan.service_time_prior` · `energy.model_residual_cv` · `energy.reserve_floor_wh` · `cost.energy.cu_per_wh` · `cost.wear.cu_per_metre` · `cost.failure.cu` · `cost.staleness.cu_per_second_age` · `cost.energy_consequence` · `cost.sla.cu_per_second_late` · `cost.sla.breach_penalty` · `lifecycle.cu_per_actuator_cycle` · `lifecycle.cu_per_braking_event` · `lifecycle.cu_per_gradient_metre` · `lifecycle.cu_per_thermal_stress_second` · `cost.battery.cu_per_equivalent_cycle`. **All fifteen measured `null` on `service.defaultSnapshot()`** | REGISTER_UNRESOLVED | **§22.4 calibration owner** | published config version → `snapshot.resolve(name, scope)` | `MISSING_SERVICE_TIME`, `MISSING_ENERGY_INPUT`, per-term cost refusals |
| **6a** | ↳ **The two Safety-class rows** | `energy.model_residual_cv` and `energy.reserve_floor_wh`. **§22.3 forbids an automated process from choosing a Safety-class parameter and no provisional route is offered.** No value is proposed here | REGISTER_UNRESOLVED / **SAFETY** | **Safety** | as above | as above |
| **7** | **`environment.ambientC` / `packC`** | °C, two values. **No Prisma column, no producer in `src/`** | NO_PRODUCER | **Engineering + a declared telemetry/forecast source** | `leaderWorkers.create({ environmentFor })` → `legProfiles` | `legEnergyWh` refuses: `profile.ambientC`, `profile.packC` |
| **8** | **`masses.vehicleMassKg`** | kg per agent class. **`AgentClass.totalMassLimitKg` is a *limit*, not a mass**, and reading it as one would overstate consumption on every candidate equally | NO_PRODUCER | **Engineering + fleet specifications** | `leaderWorkers.create({ vehicleMassKgFor })` → `legProfiles` | `legEnergyWh` refuses: `profile.vehicleMassKg` |
| **9** | **`p_fail` per agent** | Per-agent failure probability (§8.3.1) | NO_PRODUCER | **Engineering** | `cost/cRisk.evaluate` | the `p_fail · consequence` term refuses |
| **10** | **`route_hazard_cost`** | Per-route hazard cost | NO_PRODUCER | **Engineering + Map service** | pricing | term refuses |
| **11** | **§14.4 battery wear inputs** — **NARROWED 2026-09-05, see §9.1** | Two halves, with different homes. **The vendor curves have a column**: `EnergyModelParams.stressCurves`, which the repository now reads (W-A5). **The mission quantities have none** — `socThroughput` and `conditions` (`dod`, `socMid`, `tempC`, `cRate`), of which `tempC` is row 7 | NO_PRODUCER | **Engineering + pack characterisation** — the curves as a **column value**, the mission quantities as a producer nobody has written | `energy/wear.batteryWear`, via `coordinatorSolvePath`'s `batteryWearInputFor` | refuses; `cLifecycle` carries it up as `battery.*`. **Unchanged** — an absent column still refuses by name |
| **12** | **Serviceable region** | **The minimum, exactly:** for each fine cell containing the request's origin or any of its stops, one published assignment row `{ cellId, resolution: "FINE", regionId, zoneId?, siteId? }`, plus the `regions[]`/`zones[]`/`sites[]` rows those reference, in a **pinned config version**. **NOT** the D1 signed boundary, CRS, full cover, or governance sign-off | **Owner declaration (D1, minimal form)** | **Owner** | config `spatial` payload → `spatial/hierarchy.indexMap().resolve()` → `stop.serviceable` | F33 `INDETERMINATE` → **DENY for every candidate of every Leg** |
| **13** | **Depot charger** | **The minimum:** one declared depot-class `Charger` row **with a `cellId`**. A charger with no cell is omitted and named, never routed to at a guessed distance | **Owner declaration** | **Owner** | `Charger` rows → `chargerCandidates`; latest `ChargerAvailabilityProjection` → `chargerProjection` | F34/F35 `INDETERMINATE`; `plan.energy` stays `null` |
| **14** | **Return-leg Wh per metre, per routing profile** | The profile's **marginal return-leg Wh per metre**. **`β_dist` is not a substitute** — it is the distance term alone and omits mass, gradient, auxiliary and time, which would understate `E_return` and overstate the surplus, admitting exactly the missions §14.5's reserve exists to refuse. Declared as `returnLegEnergyWhPerMetre` | NO_PRODUCER | **Owner / Engineering, supplied together with row 13** | `chargerReachabilityCache.buildEntry` via `coordinatorSolvePath.js:779-781` | the candidate's `energyWh` is absent; F35 stays `INDETERMINATE` |
| **15** | **B8 Safety-class calibration** | A Safety decision on `route.degraded_reserve_factor` (`default 1.4`, `SAFETY`, `PROVISIONAL`, `awaits: "measured degraded-estimate error distribution"`) **or** on `energy.max_combined_conservatism` (`default 1.6`, `SAFETY`, `PROVISIONAL`), such that validator **V9**'s combined-degraded product `2.0125` falls under the cap. Plus **§22.3's two-person rule (S2)** for a first publish | **OWNER DECISION** (§10, D-1) | **Safety** | publish-time validation | an **unaccommodated** first publish is rejected. **A labelled verification publish is precedented** — §4.2 |
| **16** | **`candidate.max_radius_by_sla_class`** | A containment bound. `required: true`, **no default**, `UNCALIBRATED` | **NOT a V1 blocker** — satisfied by §6.3's wall-clock disjunction | Operations | `snapshot.resolve(name, { sla_class })` | expansion falls back to the wall-clock bound. **Still owed by Operations; does not block V1** |
| **17** | **`SHARD_CONSENSUS_REPLICATION` declared store** | A **declaration of fact about the store this deployment runs on**, from `election.REPLICATION_POSTURE`. Undeclared → `UNDECLARED`, and §19.5's prohibition on electing over a non-consensus store *"cannot be discharged by assumption"* | **Deployment configuration** — see §10 D-5 for why this is a *decision* and not a value | Owner / Operator | `Backend/src/engine/shard/election.js:141,172-177`, called from `shardSupervisor.worker.js:581` | **no leader is elected**, so no round runs and the coordinator's composer never executes |
| **18** | **S-5 engine-enabled region binding** | See §10, **D-2**. Not an input | **OWNER DECISION** | **Owner** | `cutoverEnabled.describe` | **503 `ENGINE_NOT_LIVE`**, nothing written |

**Proven by the current deployment attempt.** Rows **15**, **17** and **18** were not derived from a
document — the E-11 run hit each in order on a live system (§4.1), which is why they appear here at
all. Row **14** was found by *building* the F35 seam, not by auditing it.

**What is NOT on this boundary, and must not be added to it** (§K.3, as corrected):

- a routing-engine **procurement** decision or selection ADR — V1 needs a declared source, not a vendor;
- the D1 signed boundary polygon, CRS attestation, full campus cover, or governance sign-off;
- the 39 Safety-class B8 parameters **in full** — only row 15's single decision is a V1 prerequisite;
- production calibration of `plan.service_time_prior` — a declared provisional value with a named
  author is enough for V1. **`energy.model_residual_cv` is the exception** (row 6a);
- any soak, shadow window, fidelity study, or §7.6 attestation.

### 9.1 W-B4's REPOSITORY SIDE — the six `NO_PRODUCER` families, checked against the schema

**The question asked was narrow and answerable: for each family, is the missing thing a
*value nobody has measured*, or a *read path nobody has written* against something the
repository already holds?** The six were checked against `prisma/schema.prisma` and `src/`
directly, not against the sentences that previously classified them.

**Five are genuinely external. One was not, and it is now fixed (W-A5).**

| Family | Column in `prisma/schema.prisma`? | Producer in `src/`? | Verdict |
|---|---|---|---|
| `environment.ambientC / packC` | **NO.** `grep` for `ambient`/`packC`/`tempC` over the schema returns **only two comment lines** on `EnergyModelParams.betaThermal`, describing the *curves* the temperatures are evaluated at. `ContainerModel.thermalMinC/MaxC` are **payload requirements**, not measurements | NO | **EXTERNAL — unchanged.** A measurement or a forecast. No read path can be written against a column that does not exist |
| `masses.vehicleMassKg` | **NO.** The three mass columns are `ContainerModel.totalMassLimitKg` (a **limit**), `Compartment.maxMassKg`, and `PayloadSpec.massKg` / `Manifest.declaredMassKg`/`observedMassKg` (the **load**). None is the vehicle's own mass, and reading a limit as a mass is the error §9 row 8 already names | NO | **EXTERNAL — unchanged** |
| `p_fail` | **NO.** `grep` for `pfail`/`failureprob`/`reliability` over the schema returns nothing | **NO** — `src/engine/reliability/` holds a single `.gitkeep` and has since 2026-07-28. It is Tier 2, and §1.8 rule 2 forbids a Tier 1 composition root linking it statically | **EXTERNAL — unchanged** |
| `route_hazard_cost` | **NO.** `PayloadSpec.hazardClasses` is a payload property and `hazardState` is a stranding-chain field; neither is a per-route hazard cost | NO — `engine/map/obstructionClass.js` **consumes** `hazardData`; no client fetches any, and writing one means selecting a Map service | **EXTERNAL — unchanged** |
| `return-leg Wh per metre` | **NO.** `grep` for `whPer`/`perMetre`/`returnLeg` over the schema returns nothing | NO | **EXTERNAL — unchanged.** §9 row 14 already records why `β_dist` is not a substitute |
| **`battery wear inputs (§14.4)`** | **PARTLY — YES for the curves.** `EnergyModelParams.stressCurves Json?`, declared *"the vendor cycle-life-versus-DoD curves §14.4 prices wear from"* | **The row was already loaded** — `coordinatorSolvePath.js:308` fetches it, `:373` puts it on the agent snapshot as `energyModelParams` | ★ **A MISSING READ PATH. Implemented — W-A5** |

#### 9.1.1 The one finding, and why it survived

`coordinatorSolvePath.js`'s phi seam and `coordinatorPipeline.js`'s requirement row both
justified the family with the same sentence: *"`EnergyModel` carries `chargePowerCurve` and
`thermalDeratingCurve` and **no wear curve at all**."*

**That sentence is true, and it is about the wrong row.** `EnergyModel` is the declarative
model; `EnergyModelParams` is the fitted one, and the schema puts the vendor stress curves
there — with a comment saying so, in the words §14.4 uses. `energy/wear.js:93` documents its
own `curves` parameter as *"the pack's `stressCurves` from **`EnergyModelParams`**"*. So the
consumer named its source, the schema declared it, the composition root loaded it, and the
one line between them said it did not exist.

**This is the E-8b finding in a new place, for the fourth time in this programme: a producer
exists and the composition root does not use it.** It is also the same shape as `registry.js`'s
false `cadenceParameter` (E-4/S-2) — **source code publishing a false statement about the
schema**, which nothing checked because nothing read it.

#### 9.1.2 What was implemented, and what deliberately was not

| | |
|---|---|
| **Implemented** | `packStressCurvesFrom(agentSnapshot)` and `batteryWearInputFor(...)` in `coordinatorSolvePath.js`. The curves are read from `agentSnapshot.energyModelParams.stressCurves` when nothing else supplies them |
| **Precedence** | **Seam over column.** An injected `curves` still wins; the column fills only the gap. Overriding a caller's explicit value with a row would make every seam-driven test assert against something it never named |
| **Fail-closed, preserved exactly** | A `null`, absent, or non-object column stays **absent**. `wear.batteryWear` then names `stressCurves` and `cLifecycle` carries the refusal up as `battery.*` — bit for bit the behaviour a deployment gets today. **Nothing is defaulted, interpolated, assumed flat, or derived from another column** |
| **NOT implemented, and why** | The **mission half** of §14.4 — `socThroughput` and `conditions` (`dod`, `socMid`, `tempC`, `cRate`). No column carries any of them; `tempC` is the `environment` family above; and deriving DoD, mid-SoC or C-rate here would be **inventing the mission physics §14.4 prices**. `BatteryState.socThroughput` is the pack's *cumulative lifetime* throughput and is **not** `wear.js`'s *"total \|ΔSoC\| over the plan"* — using it would charge one mission for the whole life of the pack |
| **Effect on the requirement** | **NONE. `battery wear inputs (§14.4)` stays declared and unsatisfied**, and a test asserts that it does. `batteryWearInputsFor` is still probed, still required, still missing. **S-3 stays 28, the runtime numerator stays 26, and `gate:composition` stays RED** |
| **Effect on the owner request** | **The ask is narrowed, not changed.** `RD-2026-09-05-01` A11 is answered by populating `EnergyModelParams.stressCurves` for the curves half — a column, not a code change — while the mission quantities still have nowhere to come from. **No second request is issued** (§14): this is a measured amendment to an existing row, and §9 row 11 carries it |

#### 9.1.3 The same false claim, found a third time — in the **gate's own output**

Correcting the two sites above exposed a third, and it is the one an operator actually reads.
`leaderWorkers.UNCOMPOSABLE.coordinator.blockedBy` — the sentence `gate:composition` prints on
every failing run — carried **two** stale claims in one clause:

> *"…**four** input families with **no schema column and no producer anywhere in `src/`**
> (`environment.ambientC/packC`, `masses.vehicleMassKg`, `p_fail`, §14.4's battery wear
> inputs)."*

| Claim | Verdict |
|---|---|
| *"**four** input families"* | **WRONG — there are six.** The contract has carried six since §N.2 added the return-leg Wh/metre; `route_hazard_cost` is the other one the sentence never named. **A published count that had gone stale against the list standing beside it** — §N.6 step 5's *"all 34"* was the same defect, and so was `registry.js`'s `cadenceParameter` |
| *"no schema column"* | **WRONG of one of the six**, for the reason §9.1.1 gives |

**Corrected, and pinned so it cannot drift again.** The sentence now says six, names all six, and
states what the vendor curves' column is and why the row nonetheless stands. Two tests in
`coordinatorPipelineRequirements.test.js` assert the count **against `REQUIREMENTS`** rather than
restating it, so the next divergence fails a test instead of being printed to an operator.

**Nothing about the gate changed.** No algebra, no threshold, no row removed from
`UNCOMPOSABLE`; `gate:composition` is still **RED** with the same single
`LEADER_ONLY_NOT_COMPOSABLE` violation across 19 workers, and the requires-list it prints is
still the same 34 (§17 rule 6 obeyed).

#### 9.1.4 One adjacent divergence — MEASURED, deliberately NOT acted on

`EnergyModelParams.residualCv` exists as a column (*"residual dispersion of this fit … null
until the model has been fitted"*), and two code paths answer the same question differently:

- `diagnostics.controller.js:409` prefers the **column**, falling back to the register:
  `params.residualCv` if finite, else `snapshot.resolve("energy.model_residual_cv")`;
- `coordinatorSolvePath.js:1006` reads **only** the register.

**This is not fixed here, and the restraint is the point.** `energy.model_residual_cv` is
**Safety-class** (§9 row 6a) and §22.3 forbids an automated process choosing it. Deciding
whether a per-class fitted dispersion outranks a Safety-class register binding — in either
direction — is a Safety and §22.4 calibration-owner decision about *which artefact is
authoritative*, not a read path this session may quietly install. Changing it would also move
a Safety input's provenance while B8 is open. **Recorded so it is not re-discovered as new,
routed to the existing D-1/§22.4 boundary, and given no W-item, because it is not repository-owned
to decide.**

---

### 9.2 N-2 — THE §7.5 AGENT-RECORD FIELD INVENTORY *(measured 2026-09-05)*

**All nineteen fields the §7.5 predicates read off the agent snapshot and
`agentSnapshotLoaderFor` does not supply, checked against `prisma/schema.prisma` and `src/`
directly — not against the sentences that previously classified them.** `V1_DISCOVERY_AND_OWNER_QUESTIONS.md`
§12.6 measured nine as absent from the schema; **the other ten had never been checked**, and
two of those ten turned out to be columns on a row this loader already fetches.

> **Tree.** `10a527c85bd8a314be54a5aaa681af3ab1502e89` (HEAD at measurement), working tree
> clean at the start of the pass. Every row below is a `grep`/`node` measurement on that tree.

#### 9.2.1 The premise this inventory corrected

The scoping brief expected `AgentCertificate` and `CapabilityAttestation` to have **live
producers in `src/engine/security/`**. They have producer *functions* and **no callers.**
Measured: `attestation.record()` (`attestation.js:340`, the only writer of a
`CapabilityAttestation` row) and `attestation.verify()` are called from **nowhere in `src/`**;
the two socket handlers that require the module call only `findCapabilityClaims`, and
`trustBoundaries.js:365` calls `admitClaim` — which *rejects* telemetry-origin claims rather
than recording an attestation. `AgentCertificate` likewise has **no `create` in `src/`**;
`certificateRotation.worker.js:110` updates rows and `sessionBinding.js` reads them.

**So the attested-firmware family is bucket (b), not bucket (a)** — a column with no producer —
and had the premise been accepted rather than measured, this pass would have written a read
path against a table nothing fills.

#### 9.2.2 The inventory

Buckets are the three the brief defines: **(a)** column *and* producer exist and the loader
ignores them — a repository-owned V1 core-path defect; **(b)** column exists, no producer — a
data gap; **(c)** no column at all — schema work, BLOCKED-EXTERNAL behind **FD-1 = A**.

| # | Field | Reader | Column | Producer | Bucket |
|---:|---|---|---|---|---|
| 1 | `commissioning` | F1 | **NO.** No model. The word occurs in comments only (`schema.prisma:3774`), and `attestation.js:95-112`'s signed manifest carries `agentId`/`issuedAt`/`notAfter`/`firmwareVersion`/`hardwareRevision`/`secureElement`/`capabilities` — **no commissioning record** | — | **(c)** |
| 2 | `operatorHold` | F3 | **NO.** `grep -i operatorHold` over the schema → **0** | — | **(c)** |
| 3 | `quarantined` | F3 | **NO** as a flag — but the predicate's *first* condition reads `lifecycleState`, which **is** loaded, against `LifecycleState.QUARANTINED` (`schema.prisma:733`, `f03.js:46`). The separate flag is §16.4's race-window supplement | — | **(c)**, and **not** what makes F3 absent — `operatorHold` is |
| 4 | `firmwareVersion` | F5 | **YES.** `CapabilityAttestation.manifest` + `outcome` (`schema.prisma:3781-3812`) | **NO — see §9.2.1** | **(b)** |
| 5 | `firmwareVersionSource` | F5 | **YES**, same row | **NO**, same reason | **(b)** |
| 6 | **`supportedFirmwareByMissionType`** | F5 | **YES.** `AgentClass.firmwareVersionSet Json?` (`schema.prisma:1121`). **F5 names the column in its own refusal** — *"the agent class's firmwareVersionSet"* (`f05.js:73-79`) | The `AgentClass` row **the loader already fetches** | ★ **(a) — FIXED** |
| 7 | `calibrations` | F6 | **NO.** The four `calibration` hits are `CalibrationStatus`/`calibrationStatus` on the **parameter register** (`:574`, `:666`, `:678`, `:695`), not an agent's sensor calibrations | — | **(c)** |
| 8 | `emergencyStop` | F7 | **NO.** `grep -i "emergency"` over the schema → **0**, and over `src/` → nothing outside `fencing.js`'s `ESTOP_CLEAR` label | — | **(c)** |
| 9 | `faults` | F8 | **NO.** All 230 `fault` hits are the string `@default` | — | **(c)** |
| 10 | `healthTier` | F9 | **NO.** `grep -i healthTier` → **0.** `BatteryState.soh` *"feeds the health tier"* (`:2599`) and **is not one** — reading it as one is §9 row 8's limit-is-not-a-mass error | — | **(c)** |
| 11 | `localisation` | F10 | **PARTLY.** `Observation` exists (`:1993`) with `confidence Float?` and a `kind` comment naming `localisation_confidence` (`:1999`) | **NO.** The only `observation.create` in `src/` is `offer.handler.js:218`, a **feasibility-rejection** observation. Even `kind: "position"` has two readers (`dtaro.handler.js:513`, `indexMaintainer.worker.js:90`) and **no writer in `src/`** | **(b)** |
| 12 | `reliability` | F11 | **NO.** `reliability`/`interventionRate` → **0**; `src/engine/reliability/` still holds one `.gitkeep` | — | **(c)** |
| 13 | `advisories` | F12 | **NO.** Both `advisory` hits are about *cache* advisories (§3.3, `:917`, `:2949`) | — | **(c)** |
| 14 | **`hardwareRevision`** | F12 | **YES.** `AgentClass.hardwareRevision String?` (`schema.prisma:1120`) | The `AgentClass` row **the loader already fetches** | ★ **(a) — FIXED** |
| 15 | `session` | F13, F14, F15 | **NO — and by design.** F13 requires liveness *"established from a live session rather than from a database column that may lag reality"* (`f13.js:66-73`). A live producer does exist, in **KV**: `robotRegistry.service.markOnline/markOffline/updateTelemetry` write `{connected, lastHeartbeat}` (`:194-228`) and `robot.handler.js:725` calls it — keyed by **`robotId`**, on the legacy path. `session.linkQuality` (F15) has **no producer anywhere**: `grep linkQuality` over `src/` outside the predicates → **0** | a KV producer for liveness; **none** for link quality | **Neither (a) nor (c) cleanly.** Not schema work; a live-session-registry integration, and BLOCKED-EXTERNAL behind **FD-1 = A** because there is no agent to hold a session |
| 16 | `autonomousDeadZoneCertified` | F15 | **NO.** `deadZone`/`autonomous` → **0** | — | **(c)** |
| 17 | `safetyRelevantObservations` | F16 | **PARTLY** — `Observation`, as row 11 | **NO**, as row 11 | **(b)** |
| 18 | `reservations` | F18 | **YES.** `ChargerReservation` (`:2676`) with `targetSoc Float?`, and the `Agent.chargerReservations` back-relation (`:1212`) | **NO.** No `create`/`upsert` on `chargerReservation` anywhere in `src/`. `diagnostics.controller.js:286` **reads** them (and maps `targetSoc` at `:412`) — a read path exists outside the decision path and not on it | **(b)** |
| 19 | `maintenance` | F36 | **NO.** Both hits are `LifecycleState.MAINTENANCE` / `MAINTENANCE_TRANSIT` (`:734`, `:748`) — **states, not counters** | — | **(c)** |

**Totals: (a) 2 · (b) 5 · (c) 11 · 1 that fits none of the three (row 15).**

#### 9.2.3 What was fixed, and what deliberately was not

**Fixed — rows 6 and 14, and only because they need no new schema, no new data source and no
fabricated value.** `agentSnapshotLoaderFor` already fetches the `AgentClass` row and dropped
two of its declared columns on the way through the mapper. **This is §M.4's `MobilityModel`
finding and W-A5's `EnergyModelParams.stressCurves` finding at a third row** — *a mapper that
narrows a row makes a predicate report an absent record when the record exists.* The columns
are passed through **exactly as declared**: an undeclared column reaches the snapshot as
`undefined`, a declared-null one as `null`, and both are absent to the predicates. **No shape
is asserted by the mapper** — F5 answers `absent` for a non-object, `indeterminate` for a
non-array member and `indeterminate` for an unlisted mission type, three verdicts a
"normalising" mapper would collapse into one.

**Not fixed, and each for a stated reason:**

| | Why not |
|---|---|
| **Rows 4–5** (attested firmware) | Bucket **(b)** — §9.2.1. Nothing writes a `CapabilityAttestation`. And even with rows, §2.3 requires a certified validity window to be *"checked against **mission end time**, not decision time"*; F5 performs no expiry check and the loader does not know the mission end, so a read path here would be **weaker than the specification on a safety credential** |
| **Row 18** (`reservations`) | Bucket **(b)**, and loading it would be **permissive**: an empty table would arrive as `[]`, and F18 states in its own words that this is *"not 'no reservations'. An unconsulted reservation store is precisely how two schedulers collide"* (`f18.js:81-84`). `INDETERMINATE` is the truthful answer while no Scheduler publishes |
| **Rows 11, 17** (observations) | Bucket **(b)**. `Observation.kind` is a free string with **no declared vocabulary** (`domain/observation.js` exports `OBSERVATION_SOURCE` and `FRESHNESS` and no kinds), so there is no mapping from rows to F7/F10/F16's shapes to write |
| **Row 15** (`session`) | The KV producer is keyed by `robotId`, is written by the **legacy** socket path, and carries no link quality. Reading it as *"this agent has a live session"* would admit on evidence §23.5 makes untrusted for expanding eligibility |
| **Rows 1–3, 7–10, 12–13, 16, 19** | Bucket **(c)**. Schema work, **BLOCKED-EXTERNAL behind FD-1 = A** |

**Effect on the counts: none.** No requirement was satisfied, no probe row cleared, no S-3 row
added or removed. **S-3 stays 28, the runtime numerator stays 26, and `gate:composition` stays
RED.** Rows 6 and 14 are not S-3 inputs — they are columns this repository already held.

---

## §10 OWNER DECISIONS — DISTINCT FROM EXTERNAL DATA

**A decision is an act of authority. An input is a value that exists and must be transmitted. They
have different owners, different closure acts, and different evidence — and this document does not
relabel one as the other.** Everything in §9 that is *data* stays in §9.

| ID | Decision | Owner | The exact act | Why V1 needs it | Blocks | Evidence of closure |
|---|---|---|---|---|---|---|
| **D-1** | **B8 Safety-class calibration and two-person approval** | **Safety** | Decide `route.degraded_reserve_factor` **or** `energy.max_combined_conservatism` so validator V9's product clears the cap, **and** discharge §22.3's two-person rule (S2) for the first publish. **No value is proposed here** | An **unaccommodated production-intent** first publish is rejected. A labelled verification publish is precedented (§4.2), so this gates *production* configuration, not the harness. **CORRECTED 2026-09-06 by S5-1: it also gates S-5 itself.** V9 is in the blocking set of a candidate binding *only* `cutover.engine_enabled`, and S2 fires on a first publish whatever is bound — so this decision stands between the deployment and S-5, not only between it and production | ~~Production configuration publication; not, on its own, S-5 or S-6~~ **Production configuration publication, AND S-5, AND S-6 through it** | A Safety decision record with **two named approvers**, under `docs/release-decisions/` |
| | **STATUS 2026-09-06: BLOCKED-EXTERNAL by FD-3 = NO** — `RD-2026-09-05-02` §1. There is no second Safety approver and there is to be no self-approval. **Satisfiable later by one named person**; nothing else about D-1 changes when it is | | | | | | |
| **D-2** | **`cutover.engine_enabled = true` at region scope** | **Owner** | Publish a config version binding it at **`region`** scope, **pin it**, and run the process with `ENGINE_ENABLED=true`. **Both halves are required** — `forShard` ANDs them | Without it `task.service.assignTask` returns **503 `ENGINE_NOT_LIVE`** and nothing is written. That is §22.4's designed fail-closed staging, not a defect. **The mechanism exists and needs no code change** | **S-5** → S-6 | `cutoverEnabled.describe(...)` reports `live: true, decisionPath: ENGINE` |
| | **STATUS 2026-09-06: AUTHORISED AND SEQUENCED — §11 step 7 (S5-2 → S5-4), behind steps 4, 5 and 6.** FD-1 = A makes S-5 the one condition left reachable, so D-2 is the act that would take the score from 3 of 8 to 4 of 8. **It is not currently performable**: S5-1 measured the publish itself as refused by V9 and S2 (§7, §16), both of which need D-1, which FD-3 = NO blocks. **Sequenced is not available** | | | | | | |
| **D-3** | **Serviceable region declaration** | **Owner** | Declare that a named region is the V1 operating region and publish its minimal fine-cell assignment (§9 row 12) | F33 denies every candidate of every Leg without it. §3.6 forbids deriving containment from geometry at query time | S-3 → S-4 → S-6; F33 | A decision record naming the region, plus the pinned config version carrying the assignments |
| **D-4** | **Depot charger declaration** and **the return-leg energy rate** | **Owner** | Declare **one depot-class charger with a `cellId`**, *and* the per-profile return-leg Wh/metre. **§N.2: the estate and the rate are supplied together, or F35 stays `INDETERMINATE`** | F34/F35; `plan.energy` is `null` without it | S-3; F34, F35 | A decision record plus the `Charger` row(s) and the declared rate |
| | **STATUS 2026-09-06: AUTHORISED by FD-2 = YES; CONTENT STILL ABSENT** — `RD-2026-09-05-02` §1. One real plug-in location **will be** provided and **has not been**. **An authorisation to supply a value is not the value**: until the place and the rate are both declared, F34 and F35 deny for every candidate at every state of charge, exactly as they do today. This is §11 step 5, and it is one of only two actions on the whole plan that require the owner | | | | | | |
| **D-5** | **Declared shard/consensus store posture** | **Owner / Operator** | Declare `SHARD_CONSENSUS_REPLICATION` as a **statement of fact about the store this deployment runs on** | **This is a decision, not a value.** §19.5's prohibition *"cannot be discharged by assumption"* — the code refuses `UNDECLARED` precisely so that nobody asserts a posture the deployment does not have. The E-11 harness declares `SINGLE_PRIMARY_NO_AUTOMATIC_FAILOVER` **about its own disposable cluster**, which is **not** a claim about production | Leader election → every round | The declared posture recorded against the named deployment |
| **D-6** | **Boundedness acceptance: `MaxTicks = 3`** | **Release owner (§7.6)** | Sign, or decline, `MaxTicks = 3` as the global tick budget over 2 Legs in `lifecycle_c1` | §7.3a item 8. `commitment_c1` and `lifecycle_c1` both close exhaustively; the budget under which they close is unsigned | **Not a V1 stop condition.** Recorded because it is a genuine outstanding owner decision (§12 classifies it) | A signed or declined acceptance |

**Deliberately NOT called owner decisions** (they are external data or repository work, §9):
the routing source's *values*, the 15 register calibration values, the six `NO_PRODUCER` families,
`candidate.max_radius_by_sla_class`. Calling a missing measurement a "decision" would suggest
someone can close it by choosing, and nobody can.

**Deliberately NOT called external inputs:** D-1 through D-6. Each is an act of authority with a
named accountable party, and none is discharged by transmitting a number.

---

## §11 THE FINITE V1 WORKLIST

**This is the whole remaining list. It is finite, it is closed, and it is not to be extended by
discovery elsewhere.** Items are not speculative; each traces to a measurement in §4–§9. **No
Phase 15 audit is reopened and no Phase 15 release scope is imported.**

### A — REPOSITORY-OWNED WORK

| ID | Action | Why required | Owner | Dependency | Verification | Status | Closure evidence |
|---|---|---|---|---|---|---|---|
| **W-A1** | Register an `npm` script for the S-6 harness (e.g. `verify:v1CorePath`) | S-6's closure command is `node tools/verify/v1CorePath.js`, which is discoverable only by reading §I.2. `verify:t104` and `verify:v10` are registered; this one is not | Repository | none | `npm run verify:v1CorePath` runs the harness | **✅ CLOSED 2026-09-05.** `"verify:v1CorePath": "node tools/verify/v1CorePath.js"` in `Backend/package.json`. **No harness semantics changed**: the script carries no `--database-url`, so `npm run verify:v1CorePath` with no argument still exits **2** with *"no --database-url and no DATABASE_URL. Nothing was run."* — a script that pointed at some local cluster by default would be the fabrication the harness exists to avoid | The script in `package.json`; asserted by `tests/engine/v1CorePathHarnessReporting.test.js` (2 tests) |
| **W-A2** | Make the composition fixture's commitment-horizon assumption explicit | The F17 assertion is pinned to a **`PROVISIONAL`** default (`plan.commitment_horizon = 900`). If Ops calibrates it ≥ 920 s the suite goes red for no defect (§6.8). **MUST NOT be closed by shortening the fixture or removing the `VIOLATED`** | Repository | none | `npx jest tests/engine/coordinatorSolvePathComposition.test.js` still asserts exactly one `VIOLATED` for F17 | **✅ CLOSED 2026-09-05.** The fixture is **unshortened**, `plan.commitment_horizon` is **not** overridden, and the `VIOLATED` is **unchanged**. What was added is the assumption itself, computed from the fixture rather than restated beside it: `commitmentHorizonAssumption()` reads the **published** horizon live and derives the extent as `2 × 400 s + 2 × plan.service_time_prior`. A new test asserts the arithmetic (`= 920`) and that the relation holds, and **fails with a message naming W-A2, saying it is not a defect, and forbidding the three ways it must not be closed**. The existing assertion now compares against `assumption.horizonSeconds × 1000` instead of the literal `900_000` — the relation the predicate actually checks | 69→76 tests in that suite, one `VIOLATED`, `predicateId === "F17"`, `deniedForIndeterminacyOnly === false`, all intact |
| **W-A3** | Correct §N.6 step 5's *"all 34 declared inputs"* and §N.8's *"at all"* in the contract, from the measurement W-D1 produces | Two documentation claims are stronger than the code that produced them (§5.5, §4.2) | Repository | ~~W-D1~~ — **discharged 2026-09-05** | The corrected sentences cite the measured numerator and the accommodation | **✅ CLOSED 2026-09-05.** §N.6 step 5 was corrected earlier to the measured **26 of 34**. **§N.8's *"at all"* is now corrected too**, under the contract's supersession convention with the original struck rather than removed: it stops an **unaccommodated, production-intent** first publish, and the E-11 run is its own counter-example (`v1CorePath.js:206`, `:191-196`, `:196-210`). The correction states the operational consequence — *"resolve B8" is not the technical unblock for S-5 or S-6* — and **changes nothing about B8's status as owner decision D-1** | Both sentences corrected in `V1_CONTRACT_AND_STOP_CONDITION.md`, histories preserved |
| **W-A4** | Remove or widen the 2 400-character output slice in the S-6 harness, `Backend/tools/verify/v1CorePath.js:452` | **The harness cannot print the line it exists to capture.** The refusal line is **16 942** characters and the `MEASURED against this context` clause begins at index **3 291**; `line.trim().slice(0, 2400)` drops 14 405 characters and cuts the clause off every run (§5.6.3). W-D1 had to recover it through the harness's own exported `seed`/`startServer` | Repository | none | `node tools/verify/v1CorePath.js` prints the `MEASURED …` clause in its own output | **✅ CLOSED 2026-09-05.** Both caps removed from the decisive diagnostic: refusal lines are printed **whole**, and **all** of them rather than the first twelve, under a header stating the count. The **twelve-line cap was the second silent truncation in the same statement** and is a defect of the same kind — a run whose decisive line was the thirteenth reported nothing and said nothing about having stopped. The three remaining `.slice(-N)` server-output tails are not on the decisive path and are kept as tails, but now route through `tail()`, which **states how many characters it elided**. Exit semantics untouched; the S-5/S-3 two-boundary distinction untouched | `tests/engine/v1CorePathHarnessReporting.test.js` — 8 tests, incl. a refusal line whose `MEASURED` clause starts past index 2 400 and 20 refusal lines of which the 13th–20th were previously dropped |

> **W-A4 is a defect in a verification instrument, not on the V1 core path.** It reports a
> boundary less completely than it reaches it; the boundary itself was reached correctly, twice.
> **§3.1's repository status does NOT revert** — §3.1's condition is a *core-path* defect, and
> `tools/verify/` is not on the core path. It was found by W-D1 and is now **fixed**.
>
> ### W-A5 — added and closed 2026-09-05. **§3.1's status DID revert, and was re-earned.**
>
> | ID | Action | Why required | Owner | Dependency | Verification | Status | Closure evidence |
> |---|---|---|---|---|---|---|---|
> | **W-A5** | Read §14.4's vendor stress curves from `EnergyModelParams.stressCurves`, the column that declares them, at `coordinatorSolvePath`'s battery-wear seam | **A producer exists and the composition root did not use it** — the E-8b family exactly. `agentSnapshotLoaderFor` loads the whole `EnergyModelParams` row onto the snapshot (`:373`) and the phi seam then asserted *"no schema column carries either"* and did not look. **The claim named the wrong row**: `EnergyModel` indeed has no wear curve; `EnergyModelParams.stressCurves` is declared as *"the vendor cycle-life-versus-DoD curves §14.4 prices wear from"*, and `wear.js:93` names it as its own source. This is a **core-path** defect, on stage 7 | Repository | none | The curves resolve from the column; an absent column still refuses by name; the requirement row stays declared | **✅ CLOSED 2026-09-05** — found by W-B4's repository-side inspection (§9.1). **No value is fabricated**: a null or non-object column stays absent and `batteryWear` names `stressCurves` exactly as before | `coordinatorSolvePath.js` — `packStressCurvesFrom`, `batteryWearInputFor`; 7 tests in `coordinatorSolvePathComposition.test.js`; mutant **M-A** (revert the fallback) killed by 2 |
>
> **W-A5 is why §3.1's *"no repository-owned defect is currently known"* was, for one session,
> false.** §3.1's own rule was applied as written: a new core-path defect is ordinary
> outstanding repository work, not a ninth stop condition and not a reopening. It was found,
> fixed, tested, mutation-checked and closed in the same session, and §3.1's status is re-earned
> on this tree rather than carried forward.
>
> ~~**There is no W-A6.** No further repository-owned V1 **core-path** defect is currently known.
> If one is found, it is added here with its evidence and §3.1's status reverts again.~~
>
> ### **CORRECTED BY MEASUREMENT 2026-09-06. There is a W-A6, and a W-A7.**
>
> **The sentence above was not wrong when it was written and it was not disproved by argument.**
> It was disproved by the two measurements §11 steps 2 and 3 ordered — N-1 and N-2 — each of which
> found a defect of exactly the family this document has now recorded six times: *a producer
> exists, and the composition root does not use it.* §11.A's own rule was applied as written: a new
> core-path defect is added here with its evidence, **§3.1's status reverted**, and it was re-earned
> in the same pass by fixing, testing and mutation-checking both.
>
> | ID | Action | Why required | Owner | Dependency | Verification | Status | Closure evidence |
> |---|---|---|---|---|---|---|---|
> | **W-A6** | **N-1 — resolve `targetSoc` through the Charging Scheduler's own client at the composition root** | `chargingSchedulerClient.resolveTargetSoc()` was exported, unit-tested and **called from nowhere in `src/`**, while `planInputFor` read `input.targetSoc` and `input.targetSocSource` and **no caller set either**. So `plan/planBuilder.insertChargingStop` refused every insertion (`planBuilder.js:619-635`) saying *"with neither a published target nor the class fallback resolved"* — while `energy.target_soc_fallback` resolves to `0.8` and `energy.target_soc_max_age` to `300` on the published register. **The refusal was true about the outcome and false about the attempt.** Stage 7/9 of the critical path, so **core-path** | Repository | none | The resolver is called per candidate with the round's pinned time; a fresh published target is consumed with `SCHEDULER` provenance; **no target SoC is defaulted, derived or invented**; `targetSoc` does **not** become a 35th requirement | **✅ CLOSED 2026-09-05.** §14.7's `TARGET_SOC_CLASS_DEFAULT` substitution is **declined by name**, not taken: §14.6 admits it only where recorded as a degradation flag on every affected decision, and `decisionRecord.writeRound`'s `context.perLeg[legId].degradations` channel (`decisionRecord.js:574`) **has no producer** — both workers that call it forward `input.perLeg` unchanged. Declining preserves today's behaviour exactly and replaces a refusal that misdescribed the register with one that names what is absent | 11 tests in `coordinatorSolvePathComposition.test.js`; mutants **M-N1a** (revert the wiring), **M-N1b** (take the class default unrecorded), **M-N1c** (reconcile disagreeing targets), **M-N1d** (synthesise a publication time) — **4 built, 4 killed**, source restored and byte-verified |
> | **W-A7** | **N-2 — the §7.5 nineteen-field agent-record inventory, and the two `AgentClass` columns the snapshot mapper dropped** | `agentSnapshotLoaderFor` already fetches the `AgentClass` row and dropped **`firmwareVersionSet`** — which F5 names in its own refusal, *"the agent class's firmwareVersionSet"* — and **`hardwareRevision`**, which F12 matches a hardware-scoped advisory against and whose absence makes such an advisory match nothing, **silently**, in the permissive direction. **This is §M.4's `MobilityModel` finding and W-A5's `stressCurves` finding at a third row**: a mapper that narrows a row makes a predicate report an absent record when the record exists | Repository | none | Both columns pass through **exactly as declared**; an undeclared column stays `undefined` and a declared-null one stays `null`; **the mapper asserts no shape**, because F5's three distinct verdicts for three distinct malformations are what a normalising mapper would collapse | **✅ CLOSED 2026-09-05.** The full three-way classification of all nineteen fields is **§9.2** — **(a) 2 · (b) 5 · (c) 11 · 1 fitting none of the three.** Only the two bucket-(a) rows were fixed, and only because they needed no new schema, no new data source and no fabricated value. §9.2.3 states, per row, why nothing else was built | 5 tests incl. the load-bearing negative *"F5 still denies, because the attested firmware version has no read path"*; mutants **M-N2a/b/c** — **3 built, 3 killed**, source restored and byte-verified |
>
> **One repository-owned core-path item is now known and deliberately NOT fixed, and it is named
> rather than left as a silence.** §2.3 requires a certified validity window to be checked against
> **mission end time**; F5 performs no expiry check and `agentSnapshotLoaderFor` does not know the
> mission end, so an attested-firmware read path built today would be **weaker than the
> specification on a safety credential** (§9.2.3). It is bucket **(b)** regardless — nothing in
> `src/` writes a `CapabilityAttestation` row. **It is not given a W-item**, because the work it
> implies is a predicate change plus a data source that does not exist, and inventing a W-item for
> it would extend the V1 worklist §11 declares closed.
>
> ~~**There is no W-A8.** No further repository-owned V1 **core-path** defect is currently known.
> If one is found, it is added here with its evidence and §3.1's status reverts again.~~
>
> ### **CORRECTED BY MEASUREMENT 2026-09-06. There is a W-A8.**
>
> **The sentence above was not wrong when it was written, and it was not disproved by argument.**
> It was disproved by tracing one producer/consumer contract end to end — the coordinator's
> `OFFER` payload against the agent that must execute it — and the defect is the **seventh** of
> the family this document has now recorded by name: *a consumer reads a field the producer
> does not write.* §11.A's own rule was applied as written: the defect is added here with its
> evidence, **§3.1's status reverted**, and it was re-earned in the same pass by fixing and
> testing it.
>
> | ID | Action | Why required | Owner | Dependency | Verification | Status | Closure evidence |
> |---|---|---|---|---|---|---|---|
> | **W-A8** | **Fail closed when an offer carries no executable path, instead of reporting a delivery that never happened** | `coordinatorSolvePath.js:1728-1738` builds each `stopSequence` entry from seven fields — `sequence`, `stopType`, `siteId`, `lat`, `lon`, `projectedArrivalMs`, `departureMs` — and **no `path`**, and sets `routeReference: null` beside it (`:1742`, *"Absent rather than invented"*). `VirtualRobot._respondToOffer` read `plan.stopSequence[0].path` and `[1].path`, got `undefined` from both, and passed `[]` and `[]` into `_onTaskAssign`, which set `status = "ACTIVE"` on an empty `activePath`. `_advanceTask` ends a phase at `pathIndex >= activePath.length - 1`, which an empty path satisfies **on the first tick**, so the machine walked `TO_PICKUP → WAIT_PICKUP → TO_DROP → WAIT_DROP` and **emitted `TASK_COMPLETE`**. The agent accepted a commitment, reported the delivery done, and never moved. Stage 10 → agent, so **core-path** | Repository | none | An offer whose `stopSequence` carries no traversable path is answered **`OFFER_REJECT`**, not `OFFER_ACCEPT`; no `task` is created; no `TASK_COMPLETE` is emitted however long the phase machine runs; and an offer that *does* carry geometry still accepts, moves and completes | **✅ CLOSED 2026-09-06.** The refusal is §11.2's own `REJECT` disposition, **not a new event and not a new wire field**: it releases the commitment, returns the Leg to `QUEUED`, and is recorded as a **feasibility observation** — which is precisely the channel §11.2 defines for *"a discrepancy between the server's model and the agent's ... a calibration defect worth alerting on"*. The energy assessment still runs **first**, so a flat battery is still reported as `BATTERY_CRITICAL` and not masked by the plan's shape. **No route geometry was fabricated, no router was added, no gate weakened, no S5/S2 semantics touched, and `seedTaskKeys` and the retired legacy dispatch path were not resurrected** | **9 tests** in `tests/engine/dispatchAgentProtocol.test.js`; the suite's shared `missionEnvelope` fixture was `{ stopSequence: [] }`, so the `_onTaskAssign` branch **was never once reached** by the suite that certifies this file as *"the reference implementation and the conformance fixture"*. **BEFORE variant built and measured**: against the unfixed source **7 of the 9 fail**, and *"a refused offer never produces TASK_COMPLETE"* fails with `Received array: [{"event": "TASK_COMPLETE", "payload": {"taskId": "LEG-1", …}}]` at `distanceTravelled = 0`. Suite 36 → **45 passed**; engine lane **136 suites / 7 109 tests**, unit+integration+gates **25 suites / 278 tests**, all green |
>
> #### The producer this defect exposes is missing, and it is **not** one of the 34
>
> **Naming it is the whole of the remaining work here; supplying it is not this repository's to
> do, and it was not done.**
>
> There is no route-geometry producer anywhere in the engine. The routing seam's contract is
> **six scalars** — `distanceM`, `travelSeconds`, `travelSdSeconds`, `climbM`, `descentM`,
> `stopStartCycles` (`engine/routing/cellPairCache.js`, and §F.2's *"the `route(parts)` contract
> is **six** fields"*). **None of them is geometry**, and `routeReference` — which §11.2 lists in
> the offer's content and §5.2 assigns to *"the routing engine that produced the traversal"* — has
> exactly **one** write site in `src/`, the hardcoded `null` above.
>
> > **The consequence for planning, stated because it is easy to get backwards: W-B1 landing does
> > not fix this.** A declared traversal source meeting the six-field contract satisfies the
> > *decision* path and still yields **no path for an agent to drive**. The execution-geometry
> > producer is a **distinct** absence from B1's five, and it is invisible to
> > `coordinatorPipeline.requirements()` because the coordinator does not need geometry to
> > *decide* — only the agent needs it to *execute*.
>
> **It is deliberately not given a W-item**, on the same reasoning as the §2.3/F5 mission-end item
> above: the work it implies is a data source that does not exist plus the code to carry it, and
> inventing a W-item for it would extend the V1 worklist §11 declares closed. **It does not become
> a 35th requirement** — the precedent is W-A6's closure, which declined to make `targetSoc` one.
> The measured count is unchanged: **S-3 is still 28, the runtime numerator still 26, and the
> coordinator's requires-list is still 34.**
>
> **There is no W-A9.** No further repository-owned V1 **core-path** defect is currently known.
> If one is found, it is added here with its evidence and §3.1's status reverts again.
>
> ---
>
> ### F — V1-ENG: THE SIMULATION TRACK
>
> **These are engineering work, not V1 worklist items.** They are here, in their own sub-section,
> and **deliberately not in §11.A** — adding them there would extend the V1 worklist, which §11's
> own opening forbids. Their authority is `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` **§24.4** and
> **`ADR-31 — Simulator trust`**, cited and not restated, and their classification is fixed by
> [`RD-2026-09-05-02`](../release-decisions/RD-2026-09-05-02-v1-agent-boundary-and-simulation-track.md) §4.
>
> > **EVERY ROW BELOW DISCHARGES NO STOP CONDITION.** Not S-6, not S-4, not S-7, not any other.
> > Nothing this track produces may be offered as evidence for any of the eight, and no count,
> > gate, harness exit code or verdict in any V1 document may cite it. **A simulated agent is not
> > admitted as V1's agent** (`RD-2026-09-05-02` §2), and FD-1 = A is precisely the decision not to
> > take the option that would have changed that.
>
> | ID | Action | Depends on | Discharges | Note |
> |---|---|---|---|---|
> | **SIM-1** | **Provenance and containment**, including the `tools/verify/v1CorePath.js` refusal | **N-2 (W-A7) — done** | **No stop condition** | **No other simulation work starts before this lands.** Containment first is the whole point: the mechanism that makes simulated facts unable to reach a V1 verdict must exist before anything can produce them |
> | **SIM-2** | The world model, wired through the **existing six accessors** | SIM-1 | **No stop condition** | Through the accessors that exist — **not a second architecture** (`RD-2026-09-05-02` §3) |
> | **SIM-3** | The fleet model, same wiring | SIM-1, SIM-2 | **No stop condition** | As SIM-2 |
> | **SIM-4** | The simulated control plane | SIM-1, SIM-2, SIM-3 | **No stop condition** | **Requires an explicit owner sign-off on the containment design before a line is written.** This row is the one place the track touches the path agent facts travel, and it does not start on a repository judgement |
> | **SIM-5** | Scenario driver, adversarial scenarios, §26.2 matrix checking, reporting | SIM-4 | **No stop condition** | — |

### B — EXTERNAL DATA / INPUT WORK

| ID | Action | Why required | Owner | Dependency | Verification | Status | Closure evidence |
|---|---|---|---|---|---|---|---|
| **W-B1** | Supply a declared **traversal source** meeting §F.2's six-field contract, plus the `timeBucket` convention | Stage 5 has no source; nothing downstream of it runs | **Owner (B1)** | D1/D3/D8 externally | `coordinatorPipeline.requirements()` no longer lists `route`, `travelSdSeconds source (N29)`, `hop terrain`, `timeBucket` | **BLOCKED — external** | Declared source recorded, probe rows cleared |
| **W-B2** | Supply **`speedMetresPerSecond`** per routing profile | §20.3 intra-cell quantisation; `applyIntraCellOffset` refuses without it | **Owner (D3)** | — | probe row cleared | **BLOCKED — external** | Declared per-profile values |
| **W-B3** | Supply the **15 register calibration values** (§9 row 6) | Pricing, plan building and reserves each refuse individually | **§22.4 calibration owner**; **rows 6a to Safety** | **D-1** for a production publish | all 15 resolve non-`null` on the pinned snapshot | **BLOCKED — external** | Pinned config version + decision record |
| **W-B4** | Supply the **six `NO_PRODUCER` families** (§9 rows 7–11, 14) — **and the code to read them** | These are missing **code plus a data source**, not withheld decisions | **Engineering + named data sources** | — | probe rows cleared; `legProfiles` stops refusing | **BLOCKED — external.** *(Was "external + repository".)* **The repository half was executed and closed 2026-09-05 — §9.1.** All six were checked against `prisma/schema.prisma` and `src/` rather than against the sentences that classified them. **Five have no column and no producer** and no read path can be written against them. **One did**: the §14.4 vendor stress curves are declared at `EnergyModelParams.stressCurves`, the row was already loaded onto the agent snapshot, and the seam said the column did not exist — fixed as **W-A5**. **No probe row cleared, no requirement satisfied, no value fabricated** | Producers written and sources declared. **Repository side: §9.1, W-A5** |
| **W-B5** | Declare the **minimal serviceable-region assignment** (§9 row 12) | F33 denies everything without it | **Owner** — see **D-3** | **D-3** | F33 leaves `INDETERMINATE`; §7.5 denials fall to 30/38 | **BLOCKED — external** | Pinned config version carrying the assignments |
| **W-B6** | Declare **one depot charger with a `cellId`** and the **return-leg Wh/metre** (§9 rows 13–14) | F34/F35; `plan.energy` is `null` without both | **Owner** — see **D-4** | **D-4** | F34/F35 leave `INDETERMINATE`; §7.5 denials fall to 31/38 | **BLOCKED — external** | `Charger` row(s) + declared rate |

> **All six B-items were formally REQUESTED on 2026-09-05** by `RD-2026-09-05-01`: W-B1 → A1, A2, A3, A5 · W-B2 → A4 · W-B3 → A6 and A6a · W-B4 → A7…A11 and A14 · W-B5 → A12 · W-B6 → A13 and A14. **Every status above is unchanged.** A request is not a supply, and none of these becomes less blocked by having been asked for.

### C — OWNER DECISIONS

| ID | Action | Why required | Owner | Dependency | Verification | Status | Closure evidence |
|---|---|---|---|---|---|---|---|
| **W-C1** | **D-1** — B8 Safety calibration + two-person approval | Gates a production-intent first publish (§4.2) | Safety | — | An unaccommodated publish succeeds | **OPEN** | Decision record, two named approvers |
| **W-C2** | **D-2** — publish and pin `cutover.engine_enabled = true` at region scope; run with `ENGINE_ENABLED=true` | **S-5** | Owner | D-3 (a region must exist to bind at region scope) | `describe(...)` → `live: true, decisionPath: ENGINE` | **OPEN** | The pinned config version |
| **W-C3** | **D-3** — declare the V1 operating region | S-3, F33 | Owner | — | as W-B5 | **OPEN** | Decision record |
| **W-C4** | **D-4** — declare the depot charger and the return-leg rate | S-3, F34/F35 | Owner | — | as W-B6 | **OPEN** | Decision record |
| **W-C5** | **D-5** — declare `SHARD_CONSENSUS_REPLICATION` for the named deployment | No leader is elected without it, so no round ever runs | Owner / Operator | — | a leader is elected on the target deployment | **OPEN** | The declared posture, recorded against the deployment |

> **All five C-items were formally REQUESTED on 2026-09-05** by `RD-2026-09-05-01` §5, as decisions D-1 … D-5 respectively. **D-6 was requested in the same record and is explicitly marked NON-V1-BLOCKING and outside the eight stop conditions**; it has no W-C item and must not acquire one. **Every status above is unchanged** — a decision that has been asked for is not a decision that has been made.

### D — FINAL VERIFICATION

| ID | Action | Why required | Owner | Dependency | Verification | Status | Closure evidence |
|---|---|---|---|---|---|---|---|
| **W-D1** | **Re-run `node tools/verify/v1CorePath.js` and capture the coordinator's `N of 34 inputs unresolved` line verbatim**, then reconcile the measured set against §9's 28 rows | The S-3 numerator has never been recorded (§5.5). Every prior count was taken at whichever seam the reader reached, five times. An owner request built on an unmeasured list will be issued twice | Repository | none — **this is available now** | The verbatim line, plus a row-by-row reconciliation to §9 | **✅ CLOSED 2026-09-05.** `N = 26 of 34`. 26/26 measured rows already on the 28-row list; **28 unchanged**. Two findings: **W-A4** (§5.6.3) and §9's index sentence (§5.6.4) | **§5.6**, and §16 rows 3–4 |
| **W-D2** | Issue **one** complete owner request covering §9 and §10 | S-3's closure act is a decision record under `docs/release-decisions/` | Repository → Owner | ~~W-D1~~ — **unblocked 2026-09-05** | The record exists and names its author and date | **✅ CLOSED 2026-09-05.** `RD-2026-09-05-01-v1-external-input-and-owner-decision-request.md`. §9 rows 1–14 issued as inputs **A1…A14** (+ **A6a** for the two Safety-class rows); §9 rows 15, 17, 18 routed to decisions **D-1, D-5, D-2**; §9 row 16 recorded as non-blocking and **not requested**; §10 **D-1…D-6** issued as decisions, D-6 explicitly marked **NON-V1-BLOCKING**. **No value proposed, defaulted or illustrated anywhere in it. S-3 unchanged: NOT MET** | **§16 row 10**, and the record itself |
| **W-D3** | `npm run gates` **exit 0** | **S-4**, and S-7's failing half | Repository | W-B1…W-B6 | `gate:composition` 0 violations | **BLOCKED on S-3** | Gate output |
| **W-D4** | `node tools/verify/v1CorePath.js` **exit 0** — a `Commitment` **and** an `Outbox` row in the same transaction, a `Round` row, a per-Leg decision record | **S-6** | Repository | W-C2, W-D3 | Harness exit 0 | **BLOCKED on S-5, S-3** | Harness output |
| **W-D5** | `npm test` exit 0 **and** `npm run gates` exit 0 together | **S-7** | Repository | W-D3 | Both commands | **BLOCKED on W-D3** | Both outputs at one tree |
| **W-D6** | Re-verify **S-1**, **S-2** and **S-8** at the closing tree | A condition met at one tree is not met at another | Repository | all above | the three closure proofs in §7 | **OPEN at closure** | Recorded in §16 |

### E — V2 / PRODUCTION — DEFERRED, NOT V1 WORK

Listed only so that nobody mistakes an item here for a V1 blocker. **Do not start any of these.**
See §12 for the classification and the reason.

`B1` Steps 1/3/4/5 and the selection ADR · `D8` in full · `D1` signed boundary, CRS, full cover,
governance sign-off, containment-semantics escalation · the 39 Safety-class `B8` parameters beyond
D-1 · `B-P` (`invariants_enforced`, `simulator_fidelity`, `soak`, `shadow_agreement`) · `B-O`
(`safety_case_assembled`, `rollback_rehearsed`) · `B-M`/TLC beyond §G.1's V1 subset · Phase 15 §24
release closure and re-collecting `release-evidence.json` · chaining / Tier-2 · Phase 16 ·
`src/engine/stores/roles.js` · `src/engine/deps/registry.js`, `circuitBreaker.js` ·
`src/engine/routing/client.js` · `A9` · `src/engine/lifecycle/preemption.js` ·
`solve/setPartitioning.js`, `branchAndBound.js`, `localSearch.js`.

---

## §12 V1 vs V2 — THE DEFINITIVE CLASSIFICATION

Verified against §I.1, §G and §F.1 of the canonical contract.

| Item | Classification | Reason | Contract authority |
|---|---|---|---|
| A declared **traversal source** meeting §F.2 | **V1 REQUIRED** | Stage 5 has no source; nothing downstream runs | §F-1, §F.1 B |
| **`travelSdSeconds`** source | **V1 REQUIRED** | §8.4 prices `p_late` from the predictive distribution, not the point estimate | §F-2 |
| **`speedMetresPerSecond`** per profile | **V1 REQUIRED** | `applyIntraCellOffset` refuses without it | §F-3 |
| **Per-hop terrain** on the `route` contract | **V1 REQUIRED** | §14.2 states climb, regeneration and stop-start over the traversal | §F-6, §F.2 |
| The **15 register calibration values** | **V1 REQUIRED** | Each refuses individually; no plan is built and no candidate priced | §M.6, §L.2 |
| **Minimal serviceable-region assignment** | **V1 REQUIRED** | F33 denies every candidate of every Leg | §M.2 *(corrects §K.3 bullet 2)* |
| **One depot charger + return-leg Wh/metre** | **V1 REQUIRED** | F34/F35; `plan.energy` is `null` | §M.3, §N.2 |
| The six **`NO_PRODUCER`** families | **V1 REQUIRED** | Missing code **and** missing data sources | §F.0, §M.6 |
| **D-2** cutover binding at region scope | **V1 REQUIRED** | **S-5** | §I.2 S-5, §K.2 |
| **D-1** B8 Safety decision for a production publish | **V1 REQUIRED (narrow)** | Only the single V9/S2 decision. **Not** the 39 parameters | §N.6, §G |
| **D-5** declared consensus-store posture | **V1 REQUIRED — per deployment.** *(Sharpened 2026-09-06, status unchanged.)* | No leader, no round, no coordinator — **but this is not where the V1 verification path currently stops.** The S-6 harness declares the true posture of the disposable cluster it builds (`v1CorePath.js:350`) and **leadership is acquired** (§5.6.1). D-5 is an owner declaration of an observable fact about a *specific* cluster, and no session may make it on an operator's behalf; §4.1's step 3, which presented it as a live stop, is **superseded — see §4.3** | §19.5, ~~§N.6 step 3~~ → **§4.3** |
| **`candidate.max_radius_by_sla_class`** | **V1 NON-BLOCKING** | Satisfied by §6.3's wall-clock disjunction. Still owed by Operations | §M.6, E-8 |
| **F17's `VIOLATED`** | **V1 NON-BLOCKING** | Correct behaviour of a correct predicate (§6) | §N.4, spec `:3129-3132` |
| **`plan.max_admissible_mission_duration`** unread by any predicate | **V1 NON-BLOCKING** | *"not a service limit"* by declaration; publish-time algebra only | `supplementary.json:26` |
| **CI not running `gate:composition`** | **V1 NON-BLOCKING — RESIDUAL** | Recorded fact. CI is green on a tree where a blocking gate is RED | §G |
| **D-6** `MaxTicks = 3` boundedness acceptance | **V1 NON-BLOCKING** | A genuine outstanding owner decision; **not one of the eight** | §K.2, §G.1 |
| **Routing-engine procurement / selection ADR** (B1 Steps 1/3/4/5) | **V2 / PRODUCTION** | A procurement decision on recorded evidence. V1 needs a source, not a vendor | §G, §F.1 A/H |
| **Full D1** — signed boundary, CRS, full cover, charger **estate**, governance sign-off, containment-semantics escalation | **V2 / PRODUCTION** | Blocked on a governance vacuum with no escalation target (§1.8.5). §D.3/§M.2: V1's runtime needs the minimal assignment, not the cover | §G, §M.2 |
| **D8** — extract identity, vintage, refresh cadence, re-contraction budget | **V2 / PRODUCTION** | Governs a production extract. A V1 environment has no refresh cadence to govern | §G |
| **Production calibration beyond V1's required inputs**; the 39 Safety-class B8 parameters | **V2 / PRODUCTION** | §22.3 forbids automated change; a launch prerequisite, not a working-engine prerequisite | §G, §K.3 |
| **Chaining / Tier-2** (incl. F19's `projectedAvailableAtMs` for `CHARGING_INTERRUPTIBLE`/`FINISHING_SOON`) | **V2 / PRODUCTION** | Becomes free at a time only a chaining projection can state | §N.3 |
| **B-P** — `invariants_enforced`, `simulator_fidelity`, `soak`, `shadow_agreement` | **V2 / PRODUCTION** | Each requires an operating fleet and an observation window. **Never simulate** | §G |
| **B-O** — `safety_case_assembled`, `rollback_rehearsed` | **V2 / PRODUCTION** | Filed attestations by named humans | §G |
| **B-M / TLC** beyond §G.1's V1 subset (`commitment_c2/c3`, `lifecycle_c2/c3`, boundedness sign-off, named operator, §7.6 acceptance) | **PHASE 15 RELEASE ONLY** | B-M is a §24 **release** gate. **V1 does not require B-M.** Currently **2 of 6**, OPEN, and blocked on compute rather than defects | §G, §G.1 |
| **Phase 15 §24 release closure**; re-collecting `release-evidence.json` | **PHASE 15 RELEASE ONLY** | The release owner's step at a quiescent tree. **The verdict is BLOCKED either way.** §24 table untouched by E-11 | §G, §N.7 |
| **X3** — no `TASK` timer producer; §4.2 has no transition table | **V1-EXTERNAL-INPUT (specification)** | A specification gap, not an engineering task | §G.2 |
| **Phase 16**; `preemption.js`, `setPartitioning.js`, `branchAndBound.js`, `localSearch.js` | **V2 — FUTURE ARCHITECTURE** | Every §22.5 kill switch is thrown. **Do not start** | §G |
| `stores/roles.js`, `deps/registry.js`, `circuitBreaker.js`, `routing/client.js`, **A9** | **V2 — FUTURE ARCHITECTURE** | **Do not create.** Each protects or documents something V1 has not selected | §G |
| **The high-fidelity multi-robot simulation track** — SIM-1 … SIM-5 (§11.F) | **V1-ENG** | An **intentional engineering track**, classified by `RD-2026-09-05-02` §4. **It discharges no stop condition** — not S-6, not S-4, not S-7, not any other — and nothing it produces may be cited by any count, gate, harness exit code or verdict in these documents. It is tracked in **§11.F** and deliberately not in §11.A, because §11.A is the V1 worklist and §11 declares that list closed | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` **§24.4** · **`ADR-31`** — cited, not restated · `RD-2026-09-05-02` §4 |
| **The §7.5 agent-record programme** — schema, ingestion and a mapper for the fields §9.2 classifies as buckets (b) and (c) | **BLOCKED-EXTERNAL** | **Behind FD-1 = A.** S-6 requires all 38 §7.5 predicates to admit for one agent–Leg pairing, and the fields that stop it are attestations, sensor readings and control-plane facts **about physical hardware that does not exist**. Eleven of the nineteen have no column at all; five have a column and no producer. **No part of it is repository-owned work today**, and seeding any of it would be the specific way a fake green is manufactured here | §9.2 · `V1_DISCOVERY_AND_OWNER_QUESTIONS.md` §12.6 and §13.5 · `RD-2026-09-05-02` §1, §3 |

---

## §13 VERIFICATION MATRIX

> **UNIT TEST PASS ≠ COMPOSITION PROOF.**
> **COMPOSITION PROOF ≠ REAL E2E.**
> **REAL E2E ≠ V1 CLOSURE unless all eight S-conditions are satisfied.**
>
> Each line is a strict widening. A green suite has been shown, repeatedly in this project's
> history, to coexist with a composition that cannot be built and a request path that cannot run.

| Test | Command *(run from `Backend/`)* | Scope | Current result | What it proves | What it does **NOT** prove | Stop condition | Closure evidence |
|---|---|---|---|---|---|---|---|
| **Unit / integration suite** | `npm test` | **167** suites / **7 429** tests, 5 projects | **exit 0 — 167/167 suites, 7 429/7 429 tests, 0 failures, 0 skips** *(166 / 7 411 / 569.7 s before the 2026-09-05 repository-only pass)* | Every module behaves as specified **in isolation and against fixtures** | That any of it is **composed**; that any input resolves; that a request reaches a database | **S-7** (half), **S-1**, **S-2** | exit 0 at the closing tree |
| **Gate suite** | `npm run gates` | 8 gates | **exit 1 — 7 PASS / 1 FAIL** | Tier discipline (292 modules / 459 edges) · every register name resolves (193 engine + **289 runtime**) · tenets (289) · identity isolation (16) · Tier-A erasure reconstruction (3) · legacy retirement (350 files) · column-generation applicability | **Nothing about runtime behaviour.** `gate:composition`'s RED is the honest report that the coordinator cannot be built | **S-7** (half), **S-4** | exit 0, `gate:composition` 0 violations |
| ↳ **`gate:composition`** | `npm run gate:composition` | `UNCOMPOSABLE` + `coordinatorPipeline.REQUIREMENT_IDS` | **FAIL — 1 violation / 19 workers** | That the coordinator's contract is **34 declared inputs** and is unmet | **It prints the static contract, not a measurement.** The measured shortfall comes only from a running process | **S-4** | 0 violations |
| **Mutation testing** | Manual (no npm script): build the mutant, run the affected suite, restore, byte-verify | E-11: 13 mutants over R-1…R-7. **2026-09-05 repository-only pass: 2 more** — **M-A**, revert W-A5's column fallback → **killed by 2 tests**; **M-B**, restore the harness's `.slice(0, 2400)` *and* its 12-line cap → **killed by 2 tests**. Both files restored and **byte-verified by SHA-256 hash**, not by eye | **12 killed; 1 proved equivalent** and replaced by two non-equivalent mutants, both killed. **3 survived the first run** — the M-3 name, the reader's scalar branch, the gate's scan scope — **each recorded as a test gap and closed** | That the tests **discriminate**, not merely execute | That the code is correct — only that a green suite is not vacuous | **S-1** support | Every file restored and byte-verified |
| **Composition tests** | `npx jest tests/engine/coordinatorSolvePathComposition.test.js` | the real assembly against fixture seams | **76 passed** *(was 68, and 42 before that)* — **+1 for W-A2's horizon assumption, +7 for W-A5's stress-curve read path** | The assembly wires the real shipped modules and refuses correctly when an input is absent | **That the inputs exist.** Fixture seams are not a router, a region, or a charger | **S-4** support | 68+ passing with the F17 `VIOLATED` intact |
| **S-6 harness** | `npm run verify:v1CorePath -- --database-url …`, or `node tools/verify/v1CorePath.js` *(the npm script was registered 2026-09-05 — **W-A1**)* | live PG 18.3 · **28** migrations · seeded region/shard/agent-class/agent/battery/position · `server.js` as a separate process · `ENGINE_ENABLED=true` · real JWT · real HTTP POST | **exit 1**, at S-5, with S-3 reported from the same process — **re-run 2026-09-05, unchanged** | That the **whole real path** fails closed at four named boundaries in the designed order (§4.1); that S-5's mechanism works end to end over HTTP; **that the coordinator's live shortfall is `26 of 34`** (§5.6) | **Not an E2E success.** No `Commitment`, no `Outbox` row, no `Round` row, no decision record was written. **And it does not print its own `MEASURED …` clause** — `:452` truncates at 2 400 chars (**W-A4**, §5.6.3) | **S-6** | **exit 0**, with a `Commitment` **and** `Outbox` row in one transaction, a `Round` row, and a per-Leg decision record. *(The "does not print its own `MEASURED …` clause" defect in the cell to the left was **fixed 2026-09-05** — W-A4. It is left stated because it describes the two runs on record, whose outputs are what §5.6 quotes.)* |
| **Real PostgreSQL E2E** | as above | the same | **ATTEMPTED, did not complete** | — | — | **S-6** | as above |
| **§7.5 counterfactual** | within `coordinatorSolvePathComposition.test.js` | 38 predicates on one fixture | **33/38 denials** as built · **31/38** with charger + rate · **30/38** with a region cover · **one `VIOLATED` (F17)** | Exactly which predicates each declared input unblocks | **Nothing about S-3's count** (§5.1). It counts predicates, not inputs, and the remaining 30 are class-A control-plane and telemetry facts with no producer | none directly; informs **S-3** | The ladder re-measured after each input arrives |
| **Routing readiness** | `npm run routing:readiness` | B1 D1/D3/D8 | **OVERALL: BLOCKED**, exit 0 | That no routing source is selected and the tool **refuses to fabricate one** | Nothing about V1's *declared-source* path, which is narrower than B1 | informs **S-3** | Not a V1 closure artefact |
| **Formal (TLC)** | `formal/` configs | `commitment_c1`, `lifecycle_c1` close exhaustively | **2 of 6**; `commitment_c2/c3` UNKNOWN, `lifecycle_c2/c3` need authoritative treatment | The V1 subset §G.1 names | **B-M is a release gate. V1 does not require it** | none | n/a for V1 |

### 13.1 The demonstration runbook — a reading order over this matrix, and NOT a row in it

[`docs/runbooks/demonstration.md`](../runbooks/demonstration.md) *(added 2026-09-06)* sequences
the checks already in the table above into the strongest **honest** presentation path the tree
can execute: `npm test` → the composition suite → the explanation/replay surface → `npm run
gates` → the live core-path harness → `routing:readiness`.

**It is a runbook, not a status document, and it belongs to `docs/runbooks/` beside
[`cutover.md`](../runbooks/cutover.md) and [`rollback.md`](../runbooks/rollback.md) — §17 rule
13 closes `docs/v1/` to further files and that rule was obeyed, not worked around.** It defines
no requirement, carries no S-condition status of its own, and adds **no code, no fixture, no
seed value and no npm script**; every command in it already existed and every expected output in
it was executed on the tree its §7 names. Where it and this document differ, **this document
governs and the runbook is the defect.**

> **It discharges no stop condition.** Not S-3, not S-4, not S-5, not S-6, not S-7, not any
> other, and **no count, gate, harness exit code or verdict in these documents may cite it**.
> Its own banner says so twice, and its §4 — *what the demonstration does NOT prove* — is
> written to be read aloud rather than skipped. **The score is 3 of 8 before it and after it.**

**P15-F7a applies to it exactly as it applies to the other two runbooks**: nothing binds a
runbook to the API it documents, so its expected outputs are pinned to a named tree and digest
(§7 of that file) and must be re-measured rather than quoted against a different one.

---

## §14 THE ONE IMMEDIATE NEXT ACTION

> ### ✅ W-D1 — DONE, 2026-09-05. `26 of 34`. See §5.6.
> ### ✅ W-D2 — DONE, 2026-09-05. The request is issued. See §14.5.
> ### ✅ S5-1 — DONE, 2026-09-05. **The S-5 publish is REFUSED.** See §7's S-5 row and §16.
> **W-D1's and W-D2's own records, and the reasoning that ordered them, are kept in §14.1–§14.4
> unchanged**, because the argument for measuring before asking is the same argument that
> governed the request that has now been issued.

> ## ▶ **THE ONE IMMEDIATE NEXT ACTION WAS S5-1. IT IS DISCHARGED.**
> *(This heading replaced W-D2 as the immediate action per the approved plan §12.3, and S5-1 was
> then executed in the same pass. What follows is recorded here rather than left implicit.)*
>
> **S5-1's result changed the shape of the boundary rather than the score.** Before it, S-5 read as
> *"the mechanism exists and the owner has not performed the act."* Measured, **the act is
> refused** — by V9 and by S2, independently, with zero `ConfigVersion` rows written — and both
> refusals need a Safety authority and a second approver that **FD-3 = NO** says do not exist.
> **The one stop condition FD-1 = A left reachable is not currently reachable.**
>
> **The next actions, in §11's order:**
>
> | | Action | Owner | Available now? |
> |---|---|---|---|
> | §11 step 5 | Name the charger location (campus + lat/lon or a precise description) **and** the per-profile return-leg Wh/metre, in a decision record. **Both or neither** | **Owner** | **Yes** — FD-2 = YES authorises it |
> | §11 step 6 | Write the 13 provisional cost values, sole named author, one config version. §11.7 of the discovery document is the sheet, unchanged | **Owner** | **Yes** — needs no second person, no hardware, no engine, no deployment |
> | §11 step 8 | **SIM-1** — provenance and containment, including the `v1CorePath.js` refusal. **No other simulation work starts before this lands** | Repository | **Yes** — its dependency (N-2) is discharged. **V1-ENG: it discharges no stop condition** (§11.F) |
> | §11 step 7 | S5-2 → S5-4, closing S-5 and taking 3 of 8 → 4 of 8 | Repository + Owner | **No** — ~~behind steps 4, 5 and 6, and behind D-1, which FD-3 = NO blocks~~ · **MEASURED 2026-09-06 (§7.1): also blocked in its own right.** S5-2 needs a containment-semantics decision the owner has **refused** in both available forms, with **no defined escalation target**; S5-3 needs D-1, which FD-3 = NO blocks. **S5-4 is NOT REACHED** |
>
> **Steps 5 and 6 are the only two things that require the owner. Everything else is repository
> work** — and the only repository work available is V1-ENG, which closes nothing.

> ### ✅ S5-2 and S5-3 — MEASURED 2026-09-06. **BOTH BLOCKED. S5-4 NOT REACHED.** See §7.1.
>
> **The boundary moved once more, and again in the unfavourable direction.** Before this pass, S5-2
> read as *repository work waiting its turn behind steps 4, 5 and 6.* Measured, **it is not
> repository work at all**: the one prerequisite that decides it — how a 0.0998 km² campus is
> covered by 0.7373 km² cells — is an owner decision recorded as **refused in both available forms**,
> whose escalation target `B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.5 declares **NOT DEFINED**.
>
> **A third owner-facing item now exists, and it is not a new request** (§14's single-request rule
> is intact — this is an existing §9/§10 row measured to be larger than it read, which §14 says is
> recorded here and amended in place):
>
> | | Action | Owner | Available now? |
> |---|---|---|---|
> | §7.1.2 | **The polygon→H3 containment-semantics decision**, or a decision that removes the need for one. `containmentOverlapping` and `containmentOverlappingBbox` are refused; the standard path returns **0 cells** and fails V-8; there is **no V-8 exception mechanism**. **No session may choose here** | **Owner** — and it is the escalation §1.8.5 records as having no target | **Yes**, in the sense that only the owner can make it. It has been open since 2026-08-30 |
>
> **Nothing in §14's prohibitions was breached by this pass**: no second owner request, no
> fabricated answer, W-D3…W-D6 not started, and no work hunted for — §7.1.6 records the two
> candidates that were considered and declined, with reasons.

> ## ▶ **AND STILL AWAITING THE OWNER'S RESPONSE TO `RD-2026-09-05-01`.**
>
> **There is no repository-owned, V1-blocking action available on this tree.** This is not a
> deferral and not an idle state — it is the honest position of a repository that has completed
> every V1 item it can complete without an external value, and has now asked, once and completely,
> for the ones it cannot.
>
> **What must NOT happen while this state holds:**
>
> - **Do not issue a second owner request.** The whole point of W-D2's single-request rule is that
>   a second one would mean the first was incomplete. If a genuinely new boundary row is
>   *measured* (not reasoned into existence), it is recorded in §9 and §16 and the existing
>   record is amended — it does not become a new request.
> - **Do not fabricate any answer to any row of it**, to reduce a count, to green a gate, or to
>   reach an exit 0. §17 rules 1–3 bind absolutely.
> - **Do not start W-D3, W-D4, W-D5 or W-D6** — each is blocked on S-3 or S-5, and neither is
>   closed by this record's existence.
> - **Do not hunt for new work.** The four open repository items (§14.6) are the whole of what is
>   available, none is V1-blocking, and none is authorised by W-D2.
>
> **The next state change is an owner act, not a repository act.**

### 14.0 What W-D1 settled, and what it did not

| Settled | Not settled |
|---|---|
| The numerator: **26**, measured on a running process, matching §5.2's predicted 26 common rows exactly | **Nothing about whether any input exists.** A measured shortfall is still a shortfall |
| That all six `PROCESS_DEPENDENCY` rows are genuinely supplied — they are in `satisfied`, not in `missing` | **S-3, S-4, S-5, S-6 and S-7 all remain NOT MET.** W-D1 closed no stop condition and was never capable of closing one |
| That **28 is correct** and needed no revision | The **region** and **charger** rows, which this instrument structurally cannot measure (§5.6.6) and which therefore rest on §M.2/§M.3's reading, unchanged |
| That §N.6 step 5's *"all 34"* was wrong and its own enumeration was right | §N.8's *"at all"* — corrected by §4.2 from the accommodation, not by this measurement. **W-A3 stays partly open** |

### 14.1 Why W-D1 came first, and why before the alternatives *(kept as written)*

**The reason is not that it is easy. It is that every other action depends on a number nobody has
measured.**

S-3's closure act is *one* decision record placed in front of the owner (§I.2). That request must
be **complete and correct on the first issue**, because §K, §L.2, §M.6 and §N.2 each widened the
count **after** it had been stated confidently — four times, always in the same direction, always
because *"each count was taken at whichever seam the reader reached."* The instrument built to end
that pattern is `coordinatorPipeline.requirements()`, run against a real process. **It was run
once, at E-11, and its answer was not written down** (§5.5). What was written down was the
denominator.

So the current position is: **the authoritative S-3 list (28) is hand-reconciled from a probe that
provably cannot see two of its rows, and the one code-produced measurement that exists is
unrecorded.** Issuing the owner request from that position is how a fifth widening happens.

> **DISCHARGED 2026-09-05.** The measurement was taken (§5.6) and it **agreed with the
> hand-reconciled list**: 26 measured, 26 already on the 28-row list, nothing added, nothing
> removed. The fifth widening did not happen — which is a result, not a formality, because the
> four preceding counts each widened at exactly this point. The owner request may now be issued
> from a measured position.

### 14.2 Against each alternative, explicitly *(kept as written; alternative 3's remaining half is now done)*

| Alternative | Why it is not first |
|---|---|
| **1. Resolve B8 calibration** | **The E-11 evidence does not support B8 as the gate it appeared to be.** §4.2: the harness publishes a config version by taking a labelled V9/S2 accommodation already precedented by `phase15CurrentTree.js` (`v1CorePath.js:180-209`), and then stops at S-5 **deliberately**, not technically. So B8 gates a *production-intent* publish, not the next verification run. B8 is also **one row of one class** of S-3 (§9 row 15); asking Safety for it alone guarantees a second request later. **It is W-C1, and it belongs in the single owner request W-D2, not ahead of it.** This is precisely the analysis the instruction asked for rather than copying E-11's proposed next action |
| **2. Resolve/document F17 `VIOLATED`** | **Already done — §6.** Classified **E — correct-by-specification**, matching `NEXT_GENERATION_ASSIGNMENT_ENGINE.md:3129-3132` verbatim; not V1-blocking; blocks no stop condition; cannot reach a real decision today because `plan.service_time_prior` is `null` so no plan is built at all. Its one residual (**W-A2**) is a test-durability item that must **not** be closed by shortening the fixture |
| **3. Reconcile 28 vs 34** | **The definitional half is already done — §5**, and it produced a sharper result than expected: the two sets are **not** nested (26 common, +8 in the 34, **−2 in the 28**). What §5 could **not** produce from documents is the live numerator, because §N.6 recorded the denominator in its place. **W-D1 is the remaining half of exactly this item** |
| **4. Wait for owner inputs** | Nothing arrives while the request is incomplete, and this action is what makes it complete |
| **5. Anything in §11.E** | Out of V1 scope. Starting there imports Phase 15 release scope into V1, which §11 forbids |

### 14.3 What this action must **not** turn into

Run the harness, capture the line, reconcile, record. **Do not** change code, tests, gates, formal
models, fixtures, or configuration to make the number nicer. **Do not** publish
`cutover.engine_enabled`. **Do not** invent a router, a region, a charger, or a calibration value to
reduce the count. If the measured set disagrees with §9's 28, **the disagreement is the finding** —
record it here and correct §9, exactly as §5.2 corrected the naive subtraction.

> **Observed 2026-09-05: none of these was needed, and none was done.** No source, test, gate,
> fixture, formal model or configuration file was touched. `cutover.engine_enabled` stayed
> unbound. B8 stayed unresolved. No router, region, charger, terrain, calibration, environment or
> mass value was fabricated. The harness was run exactly as implemented, and where its own output
> slice truncated the line, the fix was to read the same server's untruncated output through the
> harness's **exported** functions — **not** to edit the harness (§5.6.3, **W-A4**).

### 14.4 The same rules, restated for W-D2

**A request is not a value.** W-D2 writes down *what is being asked for and by whom*; it must not
propose, default, illustrate or "suggest a starting point for" any answer — including a
provisional one, including for `plan.service_time_prior`, and most of all for the two Safety-class
rows (§9 row 6a), where §22.3 forbids an automated process choosing at all. **A worked example in
an owner request is a fabricated input with a disclaimer on it.**

> **Observed 2026-09-05, at issue: every rule above was obeyed.** The record proposes, defaults,
> illustrates and suggests nothing — for any row, including `plan.service_time_prior`, and
> including the two Safety-class rows, for which it asks Safety's own decision and value and
> offers none. The B8 register defaults and V9's measured product were **deliberately not quoted
> in it**, so that no number it contains can be read as a target. Verified mechanically: no
> decimal in the record is anything but a section reference, and no integer in it is anything but
> a count, a row index, a line number or an HTTP status.

### 14.5 W-D2 — THE REQUEST, AS ISSUED *(2026-09-05)*

| | |
|---|---|
| **Record** | [`docs/release-decisions/RD-2026-09-05-01-v1-external-input-and-owner-decision-request.md`](../release-decisions/RD-2026-09-05-01-v1-external-input-and-owner-decision-request.md) |
| **Date · requesting party** | 2026-09-05 · the V1 implementation session (repository), under §14/W-D2; recorded by the maintainer of record |
| **Tree context stated in it** | HEAD **`4e2155a`**, E-11 impl `3ff92ae`, digest `023906be…` / 581 files |
| **Status of the record** | **ISSUED — AWAITING RESPONSE.** Not one item is answered |
| **Coverage — inputs** | §9 rows **1–14** as **A1…A14**, one section each, plus **A6a** naming `energy.model_residual_cv` and `energy.reserve_floor_wh` as **Safety-class** |
| **Coverage — the other §9 rows** | Row **15** → decision **D-1** · row **16** recorded as **non-blocking and not requested** (still owed by Operations) · row **17** → **D-5** · row **18** → **D-2** |
| **Coverage — decisions** | §10 **D-1 … D-6**, one section each. **D-6 carries an explicit NON-V1-BLOCKING / outside-the-eight banner** |
| **Categories kept apart** | **A. external inputs / values** (§4) and **B. owner / deployment decisions** (§5) are separate sections with separate response tables and are never collapsed |
| **Per item it states** | what is needed · the exact shape/semantics already specified by §9/§10 · the accountable owner · where it enters the system · what verification proves closure · what happens if it stays absent |
| **The four response categories** | values supplied · decisions made · evidence attached · items intentionally declined — as an **empty** form (§7 of the record) |
| **The four standing statements** | declining an item does **not** make its V1 condition pass · **no absent physical input is benign** · **UNKNOWN remains DENY** · V1 is complete only when **all eight** S-conditions hold |
| **Fabrication check** | **No value is proposed, defaulted, illustrated or suggested anywhere in it** — no router, region, charger, terrain figure, calibration constant, temperature, mass, `p_fail`, hazard cost, battery-wear quantity or energy rate. The B8 register defaults and V9's measured product were **deliberately not quoted**, so that no number in the record can be read as a target |
| **Scope check** | Every V2 / Phase-15-release item is present **only** in the record's §8 "deliberately not asked for" table: procurement/selection ADR, full D1 (signed boundary, CRS, cover, estate, governance sign-off), D8, the 39 B8 parameters, soak, shadow window, simulator fidelity, B-O, B-M beyond §G.1's V1 subset, §24 closure, chaining/Tier-2, Phase 16 |
| **Effect on stop conditions** | **NONE. S-3, S-4, S-5, S-6, S-7 all remain NOT MET; the score is unchanged at 3 of 8.** Issuing a request is not receiving an answer |

### 14.6 ~~The four repository items that remain open~~ — **ALL FOUR CLOSED 2026-09-05, and a fifth found and closed**

**Listed so that "no V1-blocking action is available" is not misread as "nothing exists."** None of
these was authorised by W-D2, and none was started as a substitute for waiting — they were
executed as a finite repository-only pass **after** the request was issued, which is a different
thing from waiting badly.

| ID | Item | Blocking? | Status |
|---|---|---|---|
| **W-A1** | Register an `npm` script for the S-6 harness | **No** — S-6 is blocked on S-5 and S-3 regardless | **✅ CLOSED** |
| **W-A2** | Make the composition fixture's commitment-horizon assumption explicit | **No** — test durability; must **not** be closed by shortening the fixture | **✅ CLOSED — fixture unshortened, `VIOLATED` intact** |
| **W-A3** | §N.8's *"at all"* in the canonical contract *(partially done)* | **No** — documentation | **✅ CLOSED** |
| **W-A4** | The 2 400-character output slice in the S-6 harness | **No** — a defect in a verification instrument, not on the core path | **✅ CLOSED — and a second, silent, twelve-line cap in the same statement with it** |
| **W-A5** | §14.4's vendor stress curves read from the column that declares them | **No** — stage 7 is unreachable in production today, so it changes no current behaviour. **But it is a core-path defect**, and §3.1's status reverted and was re-earned | **✅ CLOSED — found by W-B4's repository-side inspection, §9.1** |

> ### ▶ **The state is unchanged: AWAITING THE OWNER'S RESPONSE TO `RD-2026-09-05-01`.**
>
> **This pass changed no stop condition. The score is 3 of 8, exactly as before.** What it
> changed is that the four registered non-blocking repository items are now zero, and one
> genuine core-path defect that nobody had found is fixed. **None of that assigns a request,
> prices a candidate, or brings V1 one input closer** — every one of the 28 is still absent.
>
> The four prohibitions above still bind, and one is now sharper: **do not hunt for new work.**
> §14.6 is empty. The next state change is an owner act.

### 14.7 The owner action checklist *(2026-09-05, documentation only)*

[`V1_OWNER_ACTION_CHECKLIST.md`](V1_OWNER_ACTION_CHECKLIST.md) was written on 2026-09-05 at the
owner's instruction, to make the collection of the already-defined boundary items as small and
unambiguous as possible. It restates `RD-2026-09-05-01`'s **22 actionable items** — 16 input rows
carrying the 28 S-3 values (A1…A14, with **A6a** as two of A6's fifteen and **A11** in its two
amended halves) and the 6 decisions (D-1…D-6, D-6 non-blocking) — as a per-item collection sheet:
who supplies it, in what form, what validates it, and what it blocks.

**It is not a second owner request** (§14's first prohibition is obeyed: the existing record is
where answers are written, and Amendment 1 remains the only amendment). **It adds no requirement,
proposes no value, and changes no stop condition — the score is 3 of 8, unchanged.** Its precedence
is stated in §2: below this document, and below the record it summarises.


---

## §15 SUPERSEDED STATEMENTS

Recorded here so that a later reader does not restore a claim this document corrected. **Only
documentation was changed; no source, test, gate, formal model, or configuration was touched.**

| # | Superseded statement | Where | Corrected to | Evidence |
|---|---|---|---|---|
| **1** | *"the coordinator's composer reported `EXTERNAL_DEPENDENCY_UNAVAILABLE` naming **all 34 declared inputs** it could not resolve"* | contract §N.6 step 5 | **MEASURED 2026-09-05: `26 of 34`.** 34 is the denominator. §N.6 step 5's own enumeration (5 routing + 15 register + 6 no-producer) already totalled 26 and was right; only the phrase *"all 34"* was wrong. **Corrected in the contract on 2026-09-05 under its supersession convention.** *(This row previously read: "the numerator is unrecorded; it is bounded above by 28 and expected to be 26" — the expectation is now a measurement, and the two agree)* | The verbatim runtime line, **§5.6.2**; `missingByClass` = `{EXTERNAL_ROUTING:5, REGISTER_UNRESOLVED:15, NO_PRODUCER:6}`; `satisfied` = the 6 process dependencies + Ω + `candidate.max_radius_by_sla_class`. **§5.6** |
| **2** | *"B8 … **stops a deployment publishing its first configuration version at all**"* | contract §N.8 closing note | It stops an **unaccommodated, production-intent** first publish. A **labelled verification publish is precedented and was performed by the E-11 run itself** | `v1CorePath.js:180-209`, binding `route.degraded_reserve_factor = 1.1` at `:206`. **§4.2** |
| **3** | The implication that **34 − 28 = 6 "additional inputs"** | the framing of the reconciliation task | The sets are **not nested**: 26 common, **+8** in the 34 (6 process dependencies, 1 derived admissibility precondition, 1 satisfied register row), **−2** in the 28 (region, charger — invisible to the probe) | **§5.2** |
| **4** | *"Not one `VIOLATED`. This is a gate that cannot see, not a fleet that fails."* | contract §M.4 | Already superseded by §N.4. **Now classified: E — correct-by-specification**, matching spec `:3129-3132` verbatim; not V1-blocking | **§6** |
| **5** | §I.3's *"What is true right now"* status block | contract §I.3 | Already marked SUPERSEDED by §N.8 in the contract. **§7 of this document is the live table** | **§7** |
| **6** | §M.7's repository-owned work list (R-1…R-7) as outstanding | contract §M.7 | **Discharged.** R-1…R-6 done; R-7 done except the three rows §N.3 reclassifies as not repository-owned (F20, F22, `plan.route`) | **§4**, verified on this tree |
| **6a** | *"no repository-owned defect stands between this tree and V1 any more"* | contract §N.8, and §3.1 of this document | **It was false when written**, and the honest form is *"none is currently **known**"*. **W-A5** was standing at that tree: the pricing seam refused §14.4's wear inputs for want of vendor curves that `EnergyModelParams.stressCurves` declares and the loader had already loaded. **Three of eight is unaffected** — the defect is on a stage no production request reaches, and fixing it satisfied no requirement and changed no count | **§9.1**, contract §N.8's correction note |
| **7** | §K.3 bullet 2 — *"not the D1 H3 cover, boundary polygon, CRS or charger estate"* | contract §K.3 | Already partially superseded by §M.2/§M.3. **V1 needs a minimal fine-cell assignment and one depot charger** — not the cover, boundary, CRS or governance sign-off | **§9** rows 12–13 |
| **8** | §F.0's `charging.chargerCandidates` = *"RESIDUAL for V1"* | contract §F.0 | **BLOCKING** (§M.3), and §N.2 adds the return-leg rate as a second declaration supplied with it | **§9** rows 13–14 |
| **9** | S-3 = *"four values"* / *"9 inputs"* / *"25 inputs"* / *"27 inputs"* | contract §I.4, §I.3, §L.2, §M.6 | **28**, and §5.4 states which of the three circulating numbers is authoritative for what. **Confirmed 2026-09-05 by live measurement, not re-derived from documents** — the sixth count was taken by the code and did not widen | **§5**, **§5.6.7** |
| **10** | *"Rows 1–15 and 17 are the 28 S-3 inputs … rows 16 and the SHARD row are separately classified"* | **this document, §9** header | **Rows 1–14 are the 28.** The sentence placed row 17 both inside and outside the 28, and rows 1–15 + 17 total 30, contradicting §5.4. Rows 15 (D-1) and 17 (D-5) are owner **decisions** under §10, not inputs | **§5.6.4**; §10's own exclusion list; §5.2's arithmetic |
| **11** | The implication that the S-6 harness's own output reports the measurement it takes | `v1CorePath.js:452`, and §13's harness row | **It did not.** `.slice(0, 2400)` cut the `MEASURED …` clause, which begins at index 3 291 of a 16 942-character line. **FIXED 2026-09-05 (W-A4): it does now**, and a second silent cap — `refusals.slice(0, 12)` — went with it. The clause was, for the two runs on record, reachable only through the harness's exported `startServer` | **§5.6.3**, §11.A |
| **12** | *"`EnergyModel` carries `chargePowerCurve` and `thermalDeratingCurve` and **no wear curve at all**"*, offered as the reason §14.4's wear inputs have no producer — and, more strongly, *"**no schema column carries either**"* | `coordinatorPipeline.js` (the `battery wear inputs (§14.4)` row) and `coordinatorSolvePath.js` (the phi seam) — **source, not prose** | **True of `EnergyModel`, and the wrong row. `EnergyModelParams.stressCurves` is declared as *"the vendor cycle-life-versus-DoD curves §14.4 prices wear from"***, `wear.js:93` names it as its own source, and `agentSnapshotLoaderFor` already loaded it. The curves half had a column all along; **the mission half (`socThroughput`, `dod`, `socMid`, `tempC`, `cRate`) genuinely has none**, so the requirement stands and is narrowed rather than closed | **§9.1**, **W-A5**; `prisma/schema.prisma` `model EnergyModelParams`; `coordinatorSolvePath.js:308`, `:373` |
| **13** | *"B8 … stops a deployment publishing its first configuration version **at all**"* — the sentence **in the canonical contract**, as distinct from row 2 above which recorded the correction here | contract §N.8 closing note | **Corrected in the contract itself, 2026-09-05 (W-A3)**, under its supersession convention with the original struck rather than removed. Row 2 of this table recorded the correction; §N.8 now carries it | contract §N.8; **§4.2** |
| **14** | *"no leader could be elected → §19.5 `assertConsensusStore` refuses a store whose replication posture is UNDECLARED"*, presented as step 3 of a chain headed **"exactly as it occurred"** | **this document, §4.1** | **It never occurred.** `v1CorePath.js:350` declares `SINGLE_PRIMARY_NO_AUTOMATIC_FAILOVER`, `server.js:562` reads it, and the assertion **passes**. The line has been present since the harness's first commit `3ff92ae`, so §4.1 was wrong **when written** — and §5.6.1 of the same document already recorded *"Leadership: **Acquired**"* from an independent re-run. Struck in place, not deleted; **D-5's status as an owner declaration is unchanged** | **§4.3**; `v1CorePath.js:343-350`; `server.js:560-565`; `shardSupervisor.worker.js:581`; §5.6.1 |
| **15** | The reading that S5-2's *"publish the fine-cell assignments"* half might fail on a **spatial** problem at publish time | the S5-2 plan step | **The spatial payload is provably not the constraint.** The full S5-2 candidate — region, zone, three FINE assignments, a well-formed shard definition, and the `cutover.engine_enabled` region binding — adds **zero** blocking findings over the bare S5-1 candidate: `blocking = ["V9"]` either way. S5-2's config half and S5-3 are **one refusal, not two**; S5-2 is blocked **before** publish, at §7.1.2 | **§7.1.3**, measured read-only against the shipped `service.js` |
| **15a** | *"`docs/v1/` holds **three** files"*, and *"no **fourth** file may be added"* | **this document, §2 and §17 rule 13** | **It holds four**, and it did on the tree the sentence was written against: `git show --name-status 10a527c` adds `V1_DISCOVERY_AND_OWNER_QUESTIONS.md`, `V1_IMPLEMENTATION_CONTROL.md` and `V1_OWNER_ACTION_CHECKLIST.md` **in one commit**, and the correction counted only two of the three. **Only the count is corrected; rule 13's prohibition is unchanged, and this pass added no file.** Whether the discovery document engages rule 13's *substance* is flagged to the owner and **deliberately not decided here** | `ls docs/v1/` → 4 · `git log --diff-filter=A -- docs/v1/` → `2b367e4`, `10a527c` · **§2**'s 2026-09-06 correction block |
| **16** | Any future statement that the coordinator's composition failure is *"blocked on B1"* | shorthand in circulation since the E-7 pass | **B1 releases 5 of the 26.** Re-measured 2026-09-06 through `coordinatorPipeline.requirements()`: `EXTERNAL_ROUTING 5` (B1) · `REGISTER_UNRESOLVED 15` (§22.4's calibration owner — §22.3 **forbids** an automated process choosing them) · `NO_PRODUCER 6` (missing code against a data source nobody has named). **21 of the 26 are not B1's**, and B1 arriving alone starts no coordinator | **§7.1.5**; the same `{5, 15, 6}` breakdown the live E-11 run reported (§5.6.2) |

---

## §16 CHANGE LOG

**Every future update to this document appends a row here. No exceptions (§1).**

| Date | Commit / tree | Change | Evidence | Affected V1 item |
|---|---|---|---|---|
| 2026-09-05 | `4e2155a` (E-11 impl `3ff92ae`), digest `023906be…` / 581 files, tree clean | **Document created.** E-11 facts re-verified against the tree; 28/34/33-38 reconciled; F17 classified; S-1…S-8 classified individually; critical path traced with REAL/NOT-REAL per stage; boundary and owner decisions separated; finite worklist opened (W-A1…W-A3, W-B1…W-B6, W-C1…W-C5, W-D1…W-D6) | `npm run gates` **exit 1 — 7 PASS / 1 FAIL (`gate:composition`)**, re-run on this tree · `node -e` measurement of `coordinatorPipeline.REQUIREMENTS` → **34** (5/16/6/6/1) · `service.defaultSnapshot().resolve("plan.commitment_horizon")` → **900**, `capacity` → **1**, `plan.service_time_prior` → **null** · spec `NEXT_GENERATION_ASSIGNMENT_ENGINE.md:3129-3132` · R-1…R-7 greps recorded in §4 | S-1…S-8; S-3 count; F17; §11 worklist |
| 2026-09-05 | `4e2155a` | **`npm test` re-run on this tree** — E-11's figure confirmed independently | **exit 0** — `Test Suites: 166 passed, 166 total · Tests: 7411 passed, 7411 total · Snapshots: 0 total · Time: 569.666 s · Ran all test suites in 5 projects.` Zero failures, zero skips. Confirms §4 row 7 | **S-7** (half), S-1, S-2 |
| 2026-09-05 | `4e2155a`, working tree carrying only this document (untracked) | **W-D1 EXECUTED AND CLOSED. The S-3 numerator is measured for the first time: `26 of 34`.** `node tools/verify/v1CorePath.js --database-url postgresql://pgverify@127.0.0.1:55432/robotx` run from `Backend/` against a disposable PG 18.3 cluster (`initdb` on port 55432, 28 migrations applied, exit 0). Harness used **exactly as implemented** — no npm script, no edit, no fabricated input, `cutover.engine_enabled` left unbound, B8 unresolved. **Harness exit 1** at S-5 with S-3 reported from the same process, reproducing §4.1's chain unchanged. New **§5.6** records provenance, the verbatim line, the 26-row reconciliation, the 8 satisfied rows, the two blind spots and the count decision | Verbatim line in full at **§5.6.2**; in brief: `MEASURED against this context — 26 of 34 inputs unresolved: EXTERNAL_ROUTING: … ⏐ REGISTER_UNRESOLVED: … ⏐ NO_PRODUCER: …` *(the composer's real separator is `\|`; rendered here as `⏐` so this table cell does not split)* · `missingByClass = {EXTERNAL_ROUTING:5, REGISTER_UNRESOLVED:15, NO_PRODUCER:6}` · `satisfied = [candidate.max_radius_by_sla_class, prisma, kv, runSerializable, selectForUpdate, signingKey, snapshot, Ω correction]` · server log `Leadership acquired … running:["outbox","reconciler","timer"]` — the coordinator is the one absent worker | **S-3** count; **S-6** (attempted again, still NOT MET); §5.5, §5.6, §14 |
| 2026-09-05 | `4e2155a` | **The authoritative S-3 count is UNCHANGED at 28.** 26 of 26 measured rows were already on the list; 0 rows added, 0 removed, 0 reclassified. The 8 `satisfied` rows classify as 6 × *repository/assembly dependency supplied by `server.js`*, 1 × *derived requirement*, 1 × *already satisfied* — none is an S-3 input. **26 + region + charger = 28** | **§5.6.4**, **§5.6.5**, **§5.6.7**. Reproduces §5.2's predicted decomposition (26 common, +8, −2) on a running process rather than from documents | **S-3** |
| 2026-09-05 | `4e2155a` | **The two blind spots CHECKED against code, not assumed. §5.2's claim holds; its stated mechanism is sharpened.** Neither F33's serviceable-region assignment nor F35's `Charger` estate appears in the runtime `missing` **or** `satisfied` arrays. The reason is stronger than *"the probe stops one seam short"*: the dependencies those seams need — `snapshot` and `prisma` — are **both satisfied**, and what is absent is *data inside a satisfied dependency* (an unpopulated snapshot field; an empty table). **No dependency probe can ever see either, at any depth of walk** | `grep` for `serviceable`/`charger`/`spatial`/`hierarchy`/`indexMap` in `coordinatorPipeline.js` → **no requirement row**; the only charger-adjacent row is `return-leg Wh per metre` (`:440`), the *rate*, not the estate · `coordinatorSolvePath.js:874-897` — `serviceabilityFor` never refuses, it returns stops unchanged · `:767-843` — `chargerCandidatesFor` is a request-time `findMany` returning `problems`, not a composition refusal · server output for this run contains **no** statement about region or charger, because stage 3 refuses before `planInputFor` runs | **S-3** rows 12–13; §5.6.6 |
| 2026-09-05 | `4e2155a` | **Two corrections, both found by W-D1.** (a) **§9's index sentence was wrong** — it placed row 17 both inside and outside the 28, and rows 1–15 + 17 total 30. Corrected to *"rows 1–14 are the 28"*; **no row's content changed**. (b) **W-A4 opened**: the S-6 harness cannot print the line it exists to capture — `v1CorePath.js:452`'s `.slice(0, 2400)` drops 14 405 of 16 942 characters and the `MEASURED …` clause begins at index 3 291. Recovered without editing the harness, via its own exported `seed`/`startServer`. **Not a core-path defect; §3.1's status does NOT revert** | §5.6.4 · §5.6.3, measured character counts · §11.A, §15 rows 10–11 | §9; **W-A4** |
| 2026-09-05 | `4e2155a` | **Canonical contract corrected — one statement only.** §N.6 step 5's *"naming **all 34 declared inputs** it could not resolve"* → the measured **26 of 34**, under the contract's own supersession convention, history preserved. §N.6 step 5's *enumeration* was already correct (5 + 15 + 6 = 26) and is untouched; the sentence contradicted its own list. **§N.8's *"at all"* deliberately NOT changed** — W-D1 does not bear on it, so **W-A3 remains partly open** | `docs/v1/V1_CONTRACT_AND_STOP_CONDITION.md` §N.6 step 5 | **W-A3** (partial); §5.5 |
| 2026-09-05 | `4e2155a` | **The immediate next action moves: W-D1 → W-D2** (issue one complete owner request covering §9 and §10). W-D1's reasoning kept in §14.1–§14.3 unchanged; §14.0 records what W-D1 settled and what it did not; §14.4 adds the rule that **a worked example in an owner request is a fabricated input with a disclaimer on it**. **No stop condition changed. S-3, S-4, S-5, S-6, S-7 all remain NOT MET; the score is unchanged at 3 of 8** | §7 (unchanged verdicts), §11.D, §14 | §14; **W-D2** |
| 2026-09-05 | `4e2155a` | **Environment figure corrected: 28 migrations, not 29.** `Backend/prisma/migrations` holds **28** directories and `npx prisma migrate deploy` reported *"28 migrations found"* and applied all 28. §4 row 9 and §13's harness row are corrected from *"29 migrations"* | `(Get-ChildItem -Directory).Count` = 28 · `prisma migrate deploy` output, exit 0 | §4 row 9, §13 |
| 2026-09-05 | `4e2155a`, working tree carrying this document and the new record | **W-D2 EXECUTED AND CLOSED. The single complete owner request is issued**, as `docs/release-decisions/RD-2026-09-05-01-v1-external-input-and-owner-decision-request.md`. It covers **§9 rows 1–18** and **§10 D-1…D-6** in one record, and separates **A. external inputs / values** from **B. owner / deployment decisions** without collapsing them: §9 rows 1–14 are issued as inputs **A1…A14** (with **A6a** naming `energy.model_residual_cv` and `energy.reserve_floor_wh` as **Safety-class**, asking Safety's own decision and value and proposing neither); §9 rows 15, 17, 18 are routed to decisions **D-1, D-5, D-2**; §9 row 16 is recorded as **non-blocking and deliberately not requested**; **D-6 is issued with an explicit NON-V1-BLOCKING / outside-the-eight-conditions banner**. For every item the record states what is needed, the exact shape/semantics from §9/§10, the accountable owner, where it enters the system, the verification that proves closure, and what happens if it stays absent. It carries the four required standing statements — declining does not make a condition pass · **no absent physical input is benign** · **UNKNOWN remains DENY** · V1 is complete only when **all eight** S-conditions hold — and states **"V1 is not complete; S-3 is not met."** verbatim, twice. **No stop condition changed. S-3, S-4, S-5, S-6, S-7 all remain NOT MET; the score is unchanged at 3 of 8** — issuing a request is not receiving an answer | The record itself · **§14.5** · §11.B and §11.C request notes · §7's S-3 row *(evidence cell updated from "No decision record exists" to the issued-and-unanswered record; closure evidence sharpened to the **answered** record)* · mechanical verification: A1…A14 + A6a appear once each and map 1:1 to §9 rows 1–14; D-1…D-6 appear once each; every V2/Phase-15-release term inside the request body occurs **only** in an "explicitly NOT asked for" clause; **no decimal in the record is anything but a section reference and no integer is anything but a count, a row index, a line number or an HTTP status** — the B8 defaults and V9's product are deliberately absent | **W-D2**; **S-3** (unchanged, NOT MET); §14 next action |
| 2026-09-05 | `4e2155a`, working tree carrying this document, the RD record, and the source/test changes below | **THE FINITE REPOSITORY-ONLY PASS. W-A1, W-A2, W-A3 and W-A4 all CLOSED; W-B4's repository side executed; W-A5 found, fixed and closed.** **W-A1** — `"verify:v1CorePath": "node tools/verify/v1CorePath.js"` registered in `Backend/package.json`; **no harness semantics changed**, and with no argument it still exits **2** rather than defaulting to a database. **W-A2** — the F17 fixture's commitment-horizon assumption made explicit and *computed*: `commitmentHorizonAssumption()` reads the **published** `plan.commitment_horizon` live and derives the extent as `2 × 400 s + 2 × plan.service_time_prior = 920 s`; a new test pins that arithmetic and, if a future calibration breaks the relation, **fails with a message naming W-A2, stating that it is not a defect, and forbidding the three ways it must not be closed**. **The fixture is not shortened, `plan.commitment_horizon` is not overridden, and the `VIOLATED` is unchanged** (§17 rule 7 obeyed). **W-A3** — §N.8's *"at all"* corrected in the canonical contract under its supersession convention. **W-A4** — the 2 400-character slice removed **and** a second, previously unrecorded, silent twelve-line cap in the same statement; the three remaining server-output tails now route through `tail()`, which states what it elided; exit semantics and the S-5/S-3 distinction untouched | `npx jest tests/engine/coordinatorSolvePathComposition.test.js tests/engine/v1CorePathHarnessReporting.test.js` → **exit 0, 84 passed** *(composition suite 68 → 76; new harness suite 8)*. Mutants: **M-A** (revert the W-A5 column fallback) **killed by 2 tests**; **M-B** (restore `.slice(0, 2400)` and the 12-line cap) **killed by 2 tests**; both files restored and **byte-verified by hash** | **W-A1, W-A2, W-A3, W-A4**; §11.A; §14.6 |
| 2026-09-05 | `4e2155a` | **W-B4's REPOSITORY SIDE EXECUTED — §9.1. Five of the six `NO_PRODUCER` families are genuinely external; the sixth was a missing read path, and it is fixed (W-A5).** Each family was checked against `prisma/schema.prisma` and `src/` directly. **No column exists** for ambient/pack temperature, vehicle mass, `p_fail`, route hazard cost, or the return-leg Wh/metre — the three mass columns are a container *limit*, a compartment limit and the *payload's* mass, and `src/engine/reliability/` still holds only a `.gitkeep`. **`EnergyModelParams.stressCurves` does exist**, declared as *"the vendor cycle-life-versus-DoD curves §14.4 prices wear from"*, `wear.js:93` names it as its own source, and `agentSnapshotLoaderFor` **already loaded the row onto the agent snapshot** — while the phi seam asserted *"no schema column carries either"* and did not look. **The claim named the wrong row** (`EnergyModel` genuinely has no wear curve). Fixed as **W-A5**: `packStressCurvesFrom` / `batteryWearInputFor`, seam-over-column precedence, **fail-closed preserved exactly** — a null or non-object column stays absent and `batteryWear` names `stressCurves` as before. **The mission half is deliberately NOT implemented**: no column carries `socThroughput` or `conditions`, `tempC` is the environment family, and `BatteryState.socThroughput` is *cumulative lifetime* throughput, not §14.4's per-plan \|ΔSoC\| | §9.1's six-row table with the greps behind it · 7 new tests incl. *"an absent column stays absent"*, *"a non-object column is not a curve set"*, *"an injected seam value still wins"*, and the load-bearing negative *"the composition contract still declares `battery wear inputs (§14.4)` as unsatisfied"* · a schema assertion that fails if the column is ever removed · **M-A killed** | **W-B4** (repository half); **W-A5**; §9 row 11; §9.1 |
| 2026-09-05 | `4e2155a` | **THE SAME FALSE CLAIM FOUND A THIRD TIME — in the sentence `gate:composition` prints.** `leaderWorkers.UNCOMPOSABLE.coordinator.blockedBy` said *"**four** input families with **no schema column and no producer anywhere in `src/`**"* and named four. **Both halves were wrong.** There are **six** `NO_PRODUCER` rows — the contract has carried six since §N.2 added the return-leg Wh/metre, and `route_hazard_cost` was the other one never named — so this was **a published count gone stale against the list standing beside it**, the same defect as §N.6 step 5's *"all 34"* and as `registry.js`'s `cadenceParameter`. And *"no schema column"* is false of one of the six (§9.1.1). Corrected to name all six and to state the column; **two tests now assert the count against `REQUIREMENTS` rather than restating it**, so the next divergence fails a test instead of being printed to an operator. **No gate algebra, threshold or `UNCOMPOSABLE` row was touched** (§17 rule 6): `gate:composition` is still RED, still one `LEADER_ONLY_NOT_COMPOSABLE` violation across 19 workers, still the same 34-item requires list | `npm run gates` re-run → **exit 1, 7 PASS / 1 FAIL**, byte-comparable verdict · `coordinatorPipelineRequirements.test.js` 24 → **26 tests** | §9.1.3; **S-2**'s truthfulness principle; `gate:composition` unchanged |
| 2026-09-05 | `4e2155a` | **§3.1's repository status REVERTED and was RE-EARNED in the same session.** W-A5 is a **core-path** defect (stage 7, the pricing seam), so §3.1's own stated condition — *"subject to any newly identified V1-critical defect"* — applied and the status was not simply carried forward. It was found, fixed, tested, mutation-checked and closed in the same pass. **No ninth stop condition was added** (§17 rule 15): a new core-path defect is ordinary outstanding repository work | §11.A's W-A5 row; §3.1 | §3.1; **W-A5** |
| 2026-09-05 | `4e2155a` | **One adjacent divergence MEASURED and deliberately NOT acted on.** `EnergyModelParams.residualCv` exists as a column, and two paths answer the same question differently: `diagnostics.controller.js:409` prefers the column and falls back to the register, while `coordinatorSolvePath.js:1006` reads only the register. **`energy.model_residual_cv` is Safety-class**; deciding which artefact is authoritative is a Safety/§22.4 decision about provenance, not a read path this session may install — and it would move a Safety input's provenance while B8 is open. **Recorded, routed to the existing D-1/§22.4 boundary, given no W-item, and not changed** | §9.1.4; `grep` for `residualCv` across `src/` — 6 hits, 2 of them the divergent reads | §9.1.4; **no new work item** |
| 2026-09-05 | `4e2155a`, working tree not clean (7 modified, 3 untracked — **not committed; no commit was requested**) | **FULL VERIFICATION OF THE PASS, at the closing tree.** `npm test` → **exit 0 — `Test Suites: 167 passed, 167 total · Tests: 7429 passed, 7429 total · Snapshots: 0 total · Ran all test suites in 5 projects`**, zero failures, zero skips *(166 / 7 411 before the pass: **+1 suite, +18 tests**, all added by it)*. `npm run gates` → **exit 1 — 7 PASS / 1 FAIL**, and every PASS line is numerically identical to the pre-pass run: `gate:tiers` 292 modules / 459 edges · `gate:params` 193 engine + 289 runtime · `gate:tenets` 289 · `gate:privacy` 16 · `gate:erasure` 3 · `gate:legacy` 350 files · `gate:columngen` NOT_REQUIRED. `gate:composition` **FAIL — 1 violation across 19 registered workers**, `LEADER_ONLY_NOT_COMPOSABLE` for `coordinator`, requires-list still **34**. The declared contract re-measured read-only: **34 total — 5 EXTERNAL_ROUTING / 16 REGISTER_UNRESOLVED / 6 NO_PRODUCER / 6 PROCESS_DEPENDENCY / 1 ADMISSIBILITY**, identical to §5.1 | Both commands run from `Backend/` at this tree · `node -e` measurement of `coordinatorPipeline.REQUIREMENTS` · `git status --short` | **S-7** (unchanged, one half); **S-4** (unchanged) |
| 2026-09-05 | `4e2155a` | **NO STOP CONDITION CHANGED BY THIS PASS. The score is 3 of 8 — S-1, S-2, S-8 met; S-3, S-4, S-5, S-6, S-7 not met.** S-3 stays at **28** and the runtime numerator stays at **26**: W-A5 satisfied no requirement, cleared no probe row, and reduced no count — it corrected a false statement and read a column that is empty in every deployment this repository can see. `gate:composition` stays **RED**, `LEADER_ONLY_NOT_COMPOSABLE` for `coordinator`. **No external value was fabricated**: no router, region, charger, terrain figure, calibration constant, temperature, mass, `p_fail`, hazard cost, battery-wear quantity or energy rate; `cutover.engine_enabled` remains unbound and B8 unresolved. **No second owner request was issued** — §9 row 11 was amended, which is what §14 prescribes | §7 unchanged · §11.B/§11.C statuses unchanged · the *"still declares `battery wear inputs (§14.4)` as unsatisfied"* test | **S-1…S-8** (all unchanged) |
| 2026-09-05 | `4e2155a`, working tree carrying the repository-only pass (uncommitted) | **OWNER ACTION CHECKLIST ADDED — documentation only, no code, no test, no config, no formal model touched.** `docs/v1/V1_OWNER_ACTION_CHECKLIST.md`, written at the owner's instruction to make collecting the already-defined boundary items as small and unambiguous as possible. It carries **22 actionable rows** — 16 input rows (A1…A14, with **A6a** as two of A6's fifteen and **A11** in Amendment 1's two halves, together the **28** S-3 values) and 6 decisions (**D-1…D-6**, D-6 marked non-blocking) — each with type (A: owner supplies · B: owner decides · C: another party supplies/decides), the exact artefact, source, format, what it blocks, the validation that closes it, and its status. **It is NOT a second owner request, NOT a status document and NOT a source of truth**; every row traces to `RD-2026-09-05-01` and the record governs where they differ. **No value is proposed, defaulted or illustrated in it**, and **no Safety-class number is offered** (A6a, D-1 flagged as requiring an actual authority). §2 and §17 rule 13's file count are corrected from two files to three, with the prohibition on a competing V1 status document **unchanged**. **NO STOP CONDITION CHANGED — S-1, S-2, S-8 met; S-3, S-4, S-5, S-6, S-7 not met; the score is 3 of 8; S-3 is still 28 and the runtime numerator still 26; `gate:composition` is still RED** | The checklist itself · §2, §14.7, §17 rule 13 · mechanical verification: A1…A14 + A6a + D-1…D-6 each appear exactly once and map 1:1 to `RD-2026-09-05-01` §4/§5 and thence to §9 rows 1–18 / §10; every V2 / Phase-15-release term appears **only** in its §3 "explicitly not required" list; no source, test, gate, fixture, formal model or configuration file was modified | §2, §14.7, §17 rule 13; **S-1…S-8 all unchanged** |
| 2026-09-06 | `10a527c85bd8a314be54a5aaa681af3ab1502e89` (HEAD) | **THE THREE DECISIONS RECORDED — §11 step 1.** [`docs/release-decisions/RD-2026-09-05-02-v1-agent-boundary-and-simulation-track.md`](../release-decisions/RD-2026-09-05-02-v1-agent-boundary-and-simulation-track.md) drafted with §12.1's six sections and the owner's name, date and signature **left blank**. **FD-1 = A** — the V1 contract is unchanged, a real commissioned physical agent is required for S-6, RobotX hardware is in active development. **FD-2 = YES** — recorded as an **authorisation, not a supply**; no charger location, region, `isDepot` or return-leg rate is stated anywhere in it. **FD-3 = NO FOR NOW** — no second Safety approver, no self-approval, **satisfiable later by one named person**. §2 of the record states what is **not** decided: the V1 contract, S-1…S-8 and S-6 are unchanged, and **no simulated agent is admitted as V1's agent.** §3 records that physical RobotX is expected to connect through the existing control-plane/commissioning path, **not a second architecture**. §4 classifies the simulation track **V1-ENG** on the authority of `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §24.4 and `ADR-31` — **cited, not restated**, because ADR-31's own text says it does not restate §24.4 and a fourth statement of one rule is how a register rots. **Documentation-only updates made alongside it**: `V1_DISCOVERY_AND_OWNER_QUESTIONS.md` gains **§13** (§12 not edited — a correction sits beside the record), this document's §10 (D-1 BLOCKED-EXTERNAL by FD-3 = NO · D-2 authorised and sequenced to step 7 · D-4 authorised by FD-2 = YES, content still absent), §11.A (**W-A6**, **W-A7**, and the *"There is no W-A6"* sentence corrected **by measurement**), the new **§11.F** for SIM-1…SIM-5, §12 (two new rows), §7's S-5 next action and §14. `V1_OWNER_ACTION_CHECKLIST.md` updated as a collection sheet only | The record itself · §13.1–§13.5 of the discovery document · **the record is DRAFTED AND UNSIGNED and therefore does not satisfy S-3's closure requirement**, which is stated in its own §6 rather than left to a reader | **§11 step 1**; **D-1, D-2, D-4** statuses; **W-A6, W-A7**; §11.F; §12; **no stop condition changed** |
| 2026-09-06 | `10a527c` | **ONE DEVIATION FROM THE APPROVED PLAN, RECORDED RATHER THAN ABSORBED.** §12.1 section 5 and §12.3's §7 row were both written **before** S5-1 ran, and both describe S-5's reachability as *"unmeasured pending S5-1"* / the next action as *"run S5-1"*. **S5-1 ran in this same pass.** Writing either sentence as approved would have published a question that had already been answered, so in both places the pending-measurement clause is **replaced by its result**, with the replacement marked as such. **No section was added, removed or renumbered; §12.1's six sections are exactly the six it names, in order** | `RD-2026-09-05-02` §5 (the addendum is inside section 5, not a seventh section) · §7's S-5 next-action cell · §14's replaced heading | §11 steps 1 and 4 |
| 2026-09-05 measured · 2026-09-06 recorded | `10a527c85bd8a314be54a5aaa681af3ab1502e89` (HEAD), working tree **clean at the start of the pass** | **N-1 — `targetSoc` RESOLVED. Verdict (a): a producer exists and the composition root did not use it — the E-8b family for the fifth time. FIXED.** `coordinatorSolvePath.planInputFor` read `input.targetSoc` and `input.targetSocSource` and **no caller set either**, so `plan/planBuilder.insertChargingStop` refused every insertion (`planBuilder.js:619-635`) with a sentence reading *"with neither a published target nor the class fallback resolved"* — **while `energy.target_soc_fallback` resolves to `0.8` and `energy.target_soc_max_age` to `300` on the published register.** The refusal was true about the outcome and **false about the attempt**, because no attempt was made. `chargingSchedulerClient.resolveTargetSoc()` — the shipped resolver — was exported, unit-tested and **called from nowhere in `src/`**. It is now called, per candidate, from `evaluateExactFor`, with the round's **pinned** decision time and a scope carrying `agent_class` (`energy.target_soc_fallback` is indexed by it — §M.4's `capacity` lesson at a second parameter). **§14.7's `TARGET_SOC_CLASS_DEFAULT` substitution is DECLINED by name, not taken**: §14.6 admits it only where it is *"recorded as a degradation flag on every affected decision"*, and the channel that would carry it — `decisionRecord.writeRound`'s `context.perLeg[legId].degradations` (`decisionRecord.js:574`) — **has no producer**; both workers that call it forward `input.perLeg` unchanged (`coordinator.worker.js:396`, `shadow.worker.js:126`) and Tier A's `degradation` section carries shard modes and relaxations, not a per-decision flag list (`tierA.js:485-495`). Declining keeps today's behaviour exactly and replaces a refusal that misdescribed the register with one that names what is absent; taking it would have been E-1's dropped `achievedGapProven` in a new place. **No target SoC is defaulted, derived or invented.** **`targetSoc` is NOT registered as a 35th requirement** — it is §5.6.6's blind spot again: the dependency it needs (`prisma`) is *satisfied* and what is absent is data inside it, which no dependency probe can see at any depth | BEFORE reproduced against the shipped modules: `planInputFor(…).charging.targetSoc === undefined` with **every** field the composition root actually supplies (`coordinatorSolvePath.js:1209-1222`), and `insertChargingStop` refusing verbatim · `REQUIREMENT_IDS.length` = **34**, rows matching `/soc\|target/i` = **[]** · AFTER matrix: a fresh published target → `0.85`/`SCHEDULER`; a target past `energy.target_soc_max_age` → declined; a target with no publication time → declined; two disagreeing targets → refused by name, neither picked; a `MAINTENANCE` reservation → not a charging target · **10 new tests** in `coordinatorSolvePathComposition.test.js` · **4 mutants built, 4 killed**: **M-N1a** revert the wiring (1 failure), **M-N1b** take the class default unrecorded (4), **M-N1c** reconcile disagreeing targets by taking the first (1), **M-N1d** synthesise a publication time (2). Source restored and **byte-verified** after each | **N-1**; §3.1 (reverted and re-earned); **no stop condition changed** |
| 2026-09-05 measured · 2026-09-06 recorded | `10a527c` | **N-2 — THE §7.5 AGENT-RECORD FIELD INVENTORY. All nineteen fields classified; §9.2 is the table.** **(a) 2 · (b) 5 · (c) 11 · 1 fitting none of the three.** **The scoping premise was wrong and measuring it is the finding**: `AgentCertificate` and `CapabilityAttestation` were expected to have live producers in `src/engine/security/`, and they have producer *functions with no callers* — `attestation.record()` (the only writer of an attestation row) and `attestation.verify()` are called from **nowhere in `src/`**; the two socket handlers call only `findCapabilityClaims`, and `agentCertificate` has no `create` at all. So the attested-firmware family is **(b)**, not (a), and accepting the premise would have produced a read path against a table nothing fills. **Two bucket-(a) defects found and FIXED**, both the same shape as §M.4's `MobilityModel` and W-A5's `stressCurves`: `agentSnapshotLoaderFor` already fetches the `AgentClass` row and dropped **`firmwareVersionSet`** (which F5 names in its own refusal — *"the agent class's firmwareVersionSet"*) and **`hardwareRevision`** (which F12 matches a hardware-scoped advisory against, and whose absence makes such an advisory match nothing, **silently**, in the permissive direction). Both are passed through **exactly as declared** — the mapper asserts no shape, because F5's three distinct verdicts for three distinct malformations are what a normalising mapper would collapse. **Nothing else was built**: rows 4–5 because §2.3 requires the validity window checked against *mission end time* and neither F5 nor the loader can do that; row 18 because an empty `ChargerReservation` table would arrive as `[]` and F18 says in its own words that this is *"not 'no reservations'"*; rows 11/17 because `Observation.kind` is a free string with no declared vocabulary; row 15 because the KV session producer is keyed by `robotId` on the legacy path and carries no link quality | §9.2's nineteen-row table, each row a `grep`/`node` measurement on this tree · **5 new tests** incl. the load-bearing negative *"F5 still denies, because the attested firmware version has no read path"* and *"an undeclared column stays absent — nothing is defaulted or inferred"* · **3 mutants built, 3 killed**: **M-N2a** revert both columns (4 failures), **M-N2b** fabricate `{}` where the class declares no set (1), **M-N2c** normalise the shape in the mapper instead of letting F5 own it (1). Source restored and **byte-verified** | **N-2**; §9.2; §3.1 (reverted and re-earned); **no stop condition changed, no count moved** |
| 2026-09-05 measured · 2026-09-06 recorded | `10a527c`; disposable **PostgreSQL 18.3** cluster, `initdb`-ed for this run on port **55432**, **28** migrations applied by `npx prisma migrate deploy` (*"Database schema is up to date"*). Neither Neon nor the local 5432 was used | **S5-1 — THE S-5 PUBLISH MEASURED UNDER FD-3 = NO. IT REFUSES, on two independent grounds, and §12.2 of the feasibility report is REFUTED.** A **labelled, non-production** config version was attempted binding **exactly one** parameter — `cutover.engine_enabled = true` at **region** scope, for the campus adopted in `RD-2026-08-30-01` — with **no Safety-class binding of any kind, no accommodation, no relabelling and no bypass**, and **no approvals** (FD-3 = NO; no second approver exists and none was self-supplied). **Result: `ConfigValidationError` — "configuration rejected at publish time: 2 blocking finding(s)". 200 findings: 2 BLOCKING, 198 LAUNCH_GATE. `ConfigVersion` rows after the attempt: 0.** **(1) V9** — *"combined degraded energy conservatism 2.0124999999999997 exceeds `energy.max_combined_conservatism` 1.6 (nominal 1.4375 × `route.degraded_reserve_factor`=1.4). Raising the cap is an explicit Safety-class decision"*. **(2) S2** — *"Safety-class change to \[47 parameters] carries 1 distinct approver identities; two-person approval requires 2 (§22.3)"*. **Both documents were partly right and §12.2's conclusion was wrong.** §12.2 is correct that `cutover.engine_enabled` is `STRUCTURAL` (measured: `changeClass = "STRUCTURAL"`, and it is **not** in the Safety change set) — and wrong that this makes S-5 achievable today, because the approver rule is a property of **the version**, not of the parameter: on a first publish `previousValues` is `null`, so `safetyClassChanges` returns **47** names (`service.js:299`) and S2 fires whatever is bound. **§4.2 of this document is confirmed and sharpened**: it attributes the two-approver requirement to the harness's own `route.degraded_reserve_factor` binding — measured, S2 fires with **no Safety binding at all**, and **V9 is not about approvers in any way**: it is computed from the register's own defaults and appears in `validateCandidate`'s blocking set for a candidate that binds only `cutover.engine_enabled`. **S-5 IS RECLASSIFIED AS BLOCKED BY FD-3 = NO.** No accommodation was added to get a green | Verbatim refusal recorded above and in full in the run log · read-only counterfactual against the shipped `service.js` (nothing published, nothing written): first publish → **47** Safety-class changes, S2 fires; subsequent publish changing no Safety value → **0** changes, S2 does **not** fire; `validateCandidate` blocking ids for this candidate → **`["V9"]`**; `SAFETY_APPROVAL_QUORUM` = **2**; `cutover.engine_enabled.changeClass` = **`STRUCTURAL`**, present in the first-publish Safety set = **false** | **S-5** (reclassified: blocked by **FD-3 = NO**, on **V9** *and* **S2**); **S-6** (unchanged, behind S-5); §4.2 sharpened; §12.2 of the feasibility report refuted |
| 2026-09-06 | `10a527c`, working tree **3 modified files** — `Backend/src/workers/coordinatorSolvePath.js`, `Backend/tests/engine/coordinatorSolvePathComposition.test.js`, this document. **Not committed; no commit was requested** | **FULL VERIFICATION OF THE N-1 / N-2 / S5-1 PASS, at the closing tree.** `npm test` → **exit 0 — `Test Suites: 167 passed, 167 total · Tests: 7445 passed, 7445 total · Snapshots: 0 total · Time: 351.022 s · Ran all test suites in 5 projects`**, zero failures, zero skips. **The delta reconciles exactly**: `git show HEAD:…coordinatorSolvePathComposition.test.js` holds **76** tests and the working tree holds **92** — **+16**, and the suite total moved **7 429 → 7 445 = +16**. No other test file was touched. `npm run gates` → **exit 1 — 7 PASS / 1 FAIL**, and **every PASS line is numerically identical to the pre-pass run**: `gate:tiers` 292 modules / 459 edges · `gate:params` 193 engine against 250 registered + 289 runtime · `gate:tenets` 289 · `gate:privacy` 16 · `gate:erasure` 3 · `gate:legacy` 4 retired absent across 350 files · `gate:columngen` NOT_REQUIRED. **`gate:composition` FAIL — 1 violation across 19 registered workers**, `LEADER_ONLY_NOT_COMPOSABLE` for `coordinator`, requires-list still **34**. **It was not weakened and no row was removed from `UNCOMPOSABLE`** (§17 rule 6) | Both commands run from `Backend/` at this tree · `git status --short` → 3 modified, 0 untracked · `git show HEAD:…` test count | **S-7** (unchanged, one half); **S-4** (unchanged) |
| 2026-09-06 | `10a527c` | **NO STOP CONDITION WAS MET BY THIS PASS, AND ONE WAS RECLASSIFIED HARDER. The score is 3 of 8 — S-1, S-2, S-8 met; S-3, S-4, S-5, S-6, S-7 not met.** S-3 stays at **28** and the runtime numerator at **26**: N-1 satisfied no requirement (`targetSoc` is not and must not become a 35th row), and N-2's two columns are not S-3 inputs — they are columns this repository already held. **S-5 moved in the *unfavourable* direction**: from *"the mechanism exists and the owner has not performed the act"* to **"the act is refused, measured, on two independent grounds, and FD-3 = NO means neither can be discharged"**. **No external value was fabricated**: no target SoC, no router, region, charger, terrain figure, calibration constant, temperature, mass, `p_fail`, hazard cost or energy rate; no commissioning record, attestation, e-stop, heartbeat, fault list or health tier was seeded; `cutover.engine_enabled` remains unbound in every environment this repository can see, and the S5-1 attempt wrote **0** `ConfigVersion` rows. **No predicate was weakened, no `skipPredicates` or bypass added, no Safety approval self-supplied, no gate algebra touched, `formal/` untouched, Phase 15 not reopened, no release evidence re-collected, and no SIM item started** | §7 (S-5 row rewritten with its prior text preserved) · §3.1 (reverted twice, re-earned) · §9.2 · the three §16 rows above | **S-1…S-8**; **S-5** reclassified |
| 2026-09-06 | `10a527c85bd8a314be54a5aaa681af3ab1502e89` (HEAD); working tree carrying the prior pass's uncommitted changes | **S5-2 — MEASURED AND BLOCKED, on a prerequisite that is NOT the one the plan expected.** All six prerequisites checked against code, read-only; **nothing published, pinned, seeded or written; zero rows created on any store.** The decisive one is the **fine-cell derivation**: measured with `h3-js@4.5.0` at the unchanged `@structural B5` resolutions, the adopted `way/1120154292` polygon is **0.0998 km²** against a res-8 cell average of **0.7373 km²**, so standard `polygonToCells` and `containmentFull` both return **0 cells**, while **the ring's 18 unique vertices under `latLngToCell` return the same 3 cells — 2.2759 km², 22.8× the campus, 95.6% of the assigned ground outside it — as `containmentOverlapping`**. So *"derive the minimal fine-cell assignments from the adopted boundary"* has **no third answer**: it is empty, or it is `containmentOverlapping` under another name, and `B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.4 item 2 records that mode as a **standing owner refusal** whose escalation target §1.8.5 declares **NOT DEFINED**. **No containment mode was chosen and §17 rule 3 was obeyed.** The other five prerequisites: the **region declaration** is absent — `validateRegionDeclaration` on the adopted Polygon names **six** missing fields (`regionId`, `name`, `kind`, `crs`, `version`, `versionDate`); the **boundary** is adopted as intent and forbidden as D1 data by handoff §1.1/STOP rule 5; **no zone identity** is declared and `cells.validateAssignment` requires one per FINE cell; the **config version** is refused (see the next row); the **Shard row** mechanism exists and nothing calls it (§7.1.4). ***(New measurement: §1.8.3 recorded 1 cell / ≈86% outside for JSSATE. RNSIT is worse on the same arithmetic — 3 cells, 95.6% outside.)*** | **§7.1.1**, **§7.1.2** · `h3.polygonToCells` / `polygonToCellsExperimental` / `latLngToCell` / `cellArea` at res 8, plus a shoelace area on the committed geojson · `regionBoundary.validateRegionDeclaration({boundary: <the adopted Polygon>})` verbatim problem list · `RD-2026-08-30-01` §7, §8.3 · `B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.3–§1.8.5 | **S5-2 BLOCKED** — owner decision, no escalation target; **S-5** unchanged (NOT MET); **no stop condition changed** |
| 2026-09-06 | `10a527c` | **S5-3 — MEASURED. Classification B: FD-3 = NO / Safety approval policy. NOT a repository defect, and there is nothing legitimate to fix.** S5-1's refusal re-derived read-only against the **full S5-2 candidate** — the `cutover.engine_enabled = true` region binding **plus** `regions[]`, `zones[]`, three FINE assignments and a well-formed `shards[]` definition. Result: `blocking = ["V9"]` at `validateCandidate`, and `safetyClassChanges(…, previousValues = null)` → **47**, `checkSafetyApproval` → **`["S2"]`** against `SAFETY_APPROVAL_QUORUM = 2`. **V9's arithmetic was independently checked for a repository defect and is correct with no double-counting**: nominal `1.15 × 1.25 × 1.0 = 1.4375` (`energy.charger_availability_margin`, `energy.uncalibrated_reserve_factor`, `energy.f_derate`), degraded `× route.degraded_reserve_factor 1.4 = 2.0125`, cap `1.6`; **both movable parameters are `changeClass: SAFETY`, `PROVISIONAL`**, so discharging V9 is D-1/B8 and **FD-3 = NO** blocks it. S2 is a property of the *version*, not the parameter. ★ **And a second result: the spatial payload is provably NOT the constraint** — adding region, zone, cells and shard produced **zero** additional blocking findings over S5-1's bare candidate, so **S5-2's config half and S5-3 are one refusal, not two.** No accommodation was added, no approver synthesised, no gate algebra touched, and **0** `ConfigVersion` rows were written | **§7.1.3** · read-only `validateCandidate` / `safetyClassChanges` / `checkSafetyApproval` against the shipped `src/engine/config/service.js` · `buildSnapshot().derivationEvidence.factors` · `entries.get(name).changeClass` for both Safety parameters | **S5-3 BLOCKED (B)**; **S5-4 NOT REACHED**; **S-5** unchanged; **no stop condition changed** |
| 2026-09-06 | `10a527c` | **THE ASSIGNMENT-ENGINE COMPOSITION RE-MEASURED INDEPENDENTLY — and the shorthand "blocked on B1" is refuted by the measurement, not by argument.** `coordinatorPipeline.requirements()` run read-only against a context supplying exactly what `server.js:657-722` supplies reproduces the live E-11 figure **exactly**: **26 of 34 unresolved, `{EXTERNAL_ROUTING: 5, REGISTER_UNRESOLVED: 15, NO_PRODUCER: 6}`**, 8 satisfied. **B1 releases 5 of the 26**; the other **21** belong to §22.4's calibration owner (15 rows §22.3 forbids an automated process from choosing) and to six families with no schema column and no named data source. **A routing source arriving alone starts no coordinator.** *(A first probe run reported `27` because the synthetic context omitted `expansionWallClockBudgetMs`, which §6.3's disjunction reads; supplying it reproduces 26. **Recorded rather than quietly corrected** — an unexplained 27 would have read as a seventh widening.)* **No new repository-owned composition defect was found.** The **F33 consumption seam** was exercised against the exact payload §7.1.2 derives: no map → `serviceable` **absent**; map published → `serviceable: true` inside, and **absent, not `false`**, outside — §17 rule 4 holding at runtime. A mechanical sweep for the *producer-exists-with-no-caller* family over all **81** modules reachable from `coordinatorSolvePath.js` returned **116** candidates and **is not reported as 116 findings**, because the instrument cannot see a comparator passed by reference or a test-only assertion helper and substantially all 116 are those — **a detector with that false-positive rate is not evidence** | **§7.1.5** · `node -e` against `coordinatorPipeline.REQUIREMENTS` / `requirements()` · `coordinatorSolvePath.serviceabilityFor` exercised on the derived map · the sweep script and its output, retained in the session scratchpad and deliberately **not** committed | **S-4** unchanged (`gate:composition` RED, untouched); **S-3** unchanged at 28, numerator 26; **no stop condition changed** |
| 2026-09-06 | `10a527c` | **A DOCUMENTATION DEFECT FOUND BY MEASUREMENT — §4.1's step 3 NEVER HAPPENED.** §4.1's chain is headed *"exactly as it occurred"* and its third step reads *"no leader could be elected → `assertConsensusStore` refuses a store whose replication posture is UNDECLARED."* **`v1CorePath.js:350` sets `SHARD_CONSENSUS_REPLICATION = "SINGLE_PRIMARY_NO_AUTOMATIC_FAILOVER"`, `server.js:562` reads exactly that, and the assertion passes.** The line has been present since the harness's first commit `3ff92ae`, so **§4.1 was wrong when written**, and §5.6.1 of the same document already recorded the contradicting measurement — *"Leadership: **Acquired**"* — from an independent re-run. **This is the fourth instance of the same class**: a published claim gone stale against a measurement standing beside it in the same file (§N.6 step 5's *"all 34"*, `registry.js`'s `cadenceParameter`, `UNCOMPOSABLE`'s *"four input families"*). Struck in place under this document's convention, not deleted. **D-5's status is UNCHANGED and is not discharged in general**: the harness declares a fact about the one disposable cluster it built, `ASYNCHRONOUS_FAILOVER` is still refused by name, `UNDECLARED` is still unsafe, and **no session may declare a posture on an operator's behalf**. What changes is only that D-5 is not where the V1 verification path stops | **§4.3**, **§15** row 14 · `v1CorePath.js:343-350` · `server.js:560-565` · `shardSupervisor.worker.js:581` · `election.js` `REPLICATION_POSTURE` · git: the line is in `3ff92ae`, the harness's first commit | **§4.1** corrected; **D-5** sharpened, status unchanged; **no stop condition changed** |
| 2026-09-06 | `10a527c` | **ONE PREVIOUSLY UNRECORDED FACT ON THE S5-2 PATH — RECORDED, DELIBERATELY NOT CHANGED, AND NOT GIVEN A W-ITEM.** `shardModel.ensureShard` — the repository's own `Shard`-creation path, which validates its input, creates the `ShardLeadership` row in the same transaction, is idempotent and is unit-tested — **is called from nowhere in `src/`, nowhere in `server.js`, and by no harness.** `src/routes/shards.routes.js` exposes `GET /` and `POST /:id/rebalance` only; the one place a `Shard` row is created in practice is `v1CorePath.js:124-125`, which hand-rolls both rows and so takes the schema default `leadershipFence = 0` where `ensureShard` sets **1** for a stated §19.5 reason. **This is the *producer exists and nothing calls it* family at an eighth place — and it has NO measured correctness consequence today**: every consumer of `leadershipFence` tests it explicitly against `null`/`undefined` and never for truthiness (`guards.js:103`, `tierA.js:325`, `membership.js:339`, `app.js:214`). **Not fixed, and both halves deliberate**: `tools/verify/` is not the core path (W-A4's own note), so **§3.1's status does NOT revert**; editing the instrument S-6's verdict rests on with no measured defect to point at is §14.3's rule in mirror image; and inventing a W-item would extend a list §11 declares closed. **Recommendation recorded for whoever executes S5-2 when it is unblocked: create the `Shard` row through `shardModel.ensureShard`** | **§7.1.4** · `grep` for `ensureShard` across `src/`, `server.js`, `tools/` — the only callers are `shardModel.js:442` → `leadership.js:116`, and one test file · `prisma/schema.prisma` `model ShardLeadership` `leadershipFence BigInt @default(0)` · the four consumer call sites | **§7.1.4**; **no W-item**; **§3.1 does not revert**; **no stop condition changed** |
| 2026-09-06 | `10a527c` | **A FIFTH STALE COUNT — §2 and §17 rule 13 say `docs/v1/` holds THREE files; it holds FOUR, and it did when the sentence was written.** `ls docs/v1/` returns the contract, this document, `V1_OWNER_ACTION_CHECKLIST.md` and **`V1_DISCOVERY_AND_OWNER_QUESTIONS.md`**; `git show --name-status 10a527c` adds all three new files **in the same commit** as the "three files" correction, which counted two of them. **Only the count is corrected. §17 rule 13's prohibition on a competing V1 status document is NOT weakened, NOT reinterpreted and NOT discharged, and this pass added no file to `docs/v1/`.** **One question is deliberately NOT decided and is flagged to the owner instead**: the discovery document carries status-shaped material (its §1.1 stop-condition table, its §12.2 feasibility matrix), and whether that engages rule 13's *substance* is a documentation-governance question — a session that declared the file compliant would be the check answering itself, and one that deleted or demoted it would destroy a record this document actively cites (§13) | **§2**'s 2026-09-06 correction block; **§15** row 15a · `ls docs/v1/` · `git log --diff-filter=A -- docs/v1/` | **§2**, **§17 rule 13** (count only); routed to the **owner**; **no stop condition changed** |
| 2026-09-06 | `10a527c` | **STEP 4 — NO DOABLE V1 CLEANUP EXISTS, and two candidates were declined with reasons rather than silently skipped.** §11.A holds **zero** open repository items (W-A1…W-A7 all closed; *"There is no W-A8"* stands after this pass). **Declined: (1)** routing the S-6 harness's `Shard` seed through `shardModel.ensureShard` — §7.1.4's reasons; **(2)** adding a regression test pinning §7.1.2's derivation and §7.1.3's `blocking = ["V9"]` — it would commit a **fabricated** `regionId`, zone id and cell-assignment set into the suite where a later reader could mistake it for a declared region, which is the exact shape of §17 rule 3. **The measurement belongs in this document, labelled as a measurement.** §14's *"do not hunt for new work"* was obeyed | **§7.1.6**; §11.A; §14 | **no repository item opened or closed**; **no stop condition changed** |
| 2026-09-06 | `10a527c`, working tree **3 modified source/test/doc files from the prior pass, plus this document and 1 untracked RD record. This pass modified NO source, NO test, NO gate, NO fixture, NO formal model and NO configuration file — only this document.** Not committed; no commit was requested | **FULL VERIFICATION OF EXECUTION PASS 2, at the closing tree.** `npm test` → **exit 0 — `Test Suites: 167 passed, 167 total · Tests: 7445 passed, 7445 total · Snapshots: 0 total · Time: 598.954 s · Ran all test suites in 5 projects`**, zero failures, zero skips — **numerically identical to the prior pass's closing figure**, which is the expected result of a pass that changed no source or test. `npm run gates` → **exit 1 — 7 PASS / 1 FAIL**, `gate:composition` **FAIL — 1 violation across 19 registered workers**, `LEADER_ONLY_NOT_COMPOSABLE` for `coordinator`, requires-list still **34**. **It was not weakened and no row was removed from `UNCOMPOSABLE`** (§17 rule 6). `npm run routing:readiness` → **OVERALL: BLOCKED**, exit 0 by design — **D1, D3, D8 all BLOCKED**, D1 naming the same five missing declaration fields §7.1.1 measured independently through `validateRegionDeclaration`. **The S-6 harness was deliberately NOT re-run, and the omission is stated rather than left as a silence**: its result is a function of source and external inputs, **neither of which moved this pass**, so a re-run would reproduce §5.6's exit 1 at S-5 and could not change a verdict. Building a disposable cluster to re-decorate a known number is the mirror image of §14.3's rule. **The last recorded run stands and is not restated as new evidence** | Both commands run from `Backend/` at this tree · `git status --short` · `git diff --stat` → **this document only**, 0 source/test files touched by this pass | **S-7** (unchanged, one half); **S-4** (unchanged); **S-6** (unchanged, not re-attempted) |
| 2026-09-06 | `10a527c` | **NO STOP CONDITION WAS MET BY THIS PASS, AND TWO WERE MEASURED HARDER. The score is 3 of 8 — S-1, S-2, S-8 met; S-3, S-4, S-5, S-6, S-7 not met.** S-3 stays at **28** and the runtime numerator at **26**, re-measured independently this pass and reproducing the live E-11 breakdown exactly. **S-5's blockage is now known to be deeper than its position in the order**: S5-2 is refused before publish by a containment-semantics decision the owner has refused in both available forms with **no defined escalation target**, and S5-3 is refused at publish by V9 and S2, both needing D-1, which FD-3 = NO blocks. **S5-4 NOT REACHED.** **Nothing was fabricated**: no containment mode chosen, no region, zone, cell assignment, shard, charger, router, terrain figure, calibration constant, temperature, mass, `p_fail`, hazard cost or energy rate; no accommodation added, no approver synthesised, no self-approval; `cutover.engine_enabled` remains unbound in every environment this repository can see and **0** `ConfigVersion` rows were written. **No predicate weakened, no gate algebra touched, no fail-closed behaviour turned permissive, `formal/` untouched, Phase 15 not reopened, no release evidence re-collected, no SIM item started, no second owner request issued, and no file added to `docs/v1/`** | §7.1 · §7 (S-5 row's next-action cell) · §4.3 · §15 rows 14, 15, 15a, 16 · the six §16 rows above | **S-1…S-8**; **S5-2 BLOCKED**, **S5-3 BLOCKED (B)**, **S5-4 NOT REACHED** |
| 2026-09-06 | `db4b115` (HEAD), working tree **clean at the start and carrying only documentation at the end**. Source digest **`750862692737e568a29ace87acd49fb3d1791c18d8742f41ad9677f12fa8635d` / 582 files**, measured live | **THE PRESENTATION-PATH PASS — documentation only. NO source, test, gate, fixture, formal model, configuration file or `package.json` script was added or modified, so the source digest is unmoved by this pass.** The strongest **honest** demonstration path the tree can execute was identified from the checks that already exist, executed end to end, and written down as [`docs/runbooks/demonstration.md`](../runbooks/demonstration.md) — **six steps, no new command, no new fixture, no new npm script.** It was placed in `docs/runbooks/` beside `cutover.md` and `rollback.md` **because §17 rule 13 closes `docs/v1/` to further files**; it states no status, defines no requirement, and **discharges no stop condition**. **Nothing was redesigned**: every step verifies an existing path rather than replacing it, and the two candidate wrappers that would have made a step exit 0 — publishing `cutover.engine_enabled`, and an npm `demo` script chaining the steps behind one exit code — were **declined**, the first as §17 rule 3 and S-5, the second because chaining would hide the per-step exit codes that are the whole evidential content of steps 4 and 5. **The two refusals are presented as the results they are**: `gate:composition`'s exit 1 and the harness's exit 1 are correct on this tree, and §8 of the runbook forbids presenting either as an outstanding engineering task | **All six steps executed on this tree.** `npm test` → **exit 0, 167 suites / 7 445 tests / 0 failures / 0 skips, 498.268 s** — numerically identical to the prior pass's closing figure, the expected result of a pass that changed no source or test · `npx jest tests/engine/coordinatorSolvePathComposition.test.js` → **exit 0, 92 passed** · `npm run gate:erasure` → **exit 0, PASS, 3 corpus decisions byte-for-byte under erasure** · six engine suites (explanation, decision record, feasibility gate, degraded transitions, search-gap provenance, coordinator round) → **exit 0, 182 tests** · `npm run gates` → **exit 1, 7 PASS / 1 FAIL**, `gate:composition` 1 violation across 19 workers, requires-list still **34**, **not weakened and no row removed from `UNCOMPOSABLE`** (§17 rule 6) · `npm run verify:v1CorePath -- --database-url …` on a **disposable PG 18.3 cluster** (`initdb`, port **55432**, 28 migrations) → **exit 1**, HTTP **503 `ENGINE_NOT_LIVE`** with nothing written, S-5 then S-3 from the same process, **`26 of 34 inputs unresolved` = EXTERNAL_ROUTING 5 / REGISTER_UNRESOLVED 15 / NO_PRODUCER 6, 8 satisfied — reproducing §5.6 and §7.1.5 exactly** · `npm run routing:readiness` → **OVERALL: BLOCKED**, exit 0 by design · `coordinatorPipeline.REQUIREMENTS` re-measured read-only → **34 = 5/16/6/6/1**, identical to §5.1 · `explanation.assertCoverage()` → `{ok: true, queries: 8}` · cluster stopped and its data directory removed | **§13.1** (new); **no stop condition changed** — the score is **3 of 8**, S-3 still **28** and the runtime numerator still **26**, `gate:composition` still **RED**; **nothing fabricated** — no router, region, charger, containment mode, terrain figure, calibration constant, temperature, mass, `p_fail`, hazard cost or energy rate; `cutover.engine_enabled` remains unbound and **0** `ConfigVersion` rows were written outside the disposable cluster; no accommodation added, no approver synthesised, no predicate weakened, no gate algebra touched, `formal/` and `docs/phase15/` untouched (§17 rule 14), Phase 15 not reopened, no release evidence re-collected, no SIM item started, no second owner request issued, and **no file added to `docs/v1/`** |
| 2026-09-05 | `4e2155a` | **The immediate next action moves: W-D2 → AWAITING THE OWNER'S RESPONSE.** §14 now records that **no repository-owned, V1-blocking action is available on this tree**, and forbids the four ways that state is usually misread: a second owner request, a fabricated answer, starting W-D3…W-D6, and hunting for new work. **§14.6** lists the four open repository items (W-A1, W-A2, W-A3 partial, W-A4) precisely so that "none is available" is not misread as "none exists" — **none of the four is V1-blocking and none is authorised by W-D2.** §14.1–§14.4 are kept as written; §14.4 gains a discharge note recording that its rules were obeyed at issue | §14, §14.5, §14.6; §11.A unchanged | §14; **W-A1…W-A4** (statuses unchanged) |

---

## §17 DO-NOT-TOUCH RULES — PERMANENT

**These bind every future V1 implementation session. They are not advisory, and none of them has an
exception for "just to get the build green."**

A future session must **NOT**:

1. **Fabricate external values** — no invented number is ever a substitute for an absent one.
2. **Fabricate physical inputs** — no ambient or pack temperature, no vehicle mass, no `p_fail`,
   no hazard cost, no battery wear figure.
3. **Fabricate a region, a charger, or a routing source** — including a stub, fake, or in-process
   router written to make `gate:composition` pass.
4. **Weaken fail-closed behaviour** — `absent` must never become `false`; an unassigned cell is not
   an out-of-area one; an unread exclusion set is not an empty one; an unpopulated access-rules
   column is *"nobody established what this site requires"*, not *"none required"*.
5. **Weaken formal properties** — no `.cfg` edit, no property redefinition, no `CHECK_DEADLOCK`
   removal.
6. **Modify gate algebra to make a status green** — `gate:composition` stays RED until the
   coordinator actually starts. Removing a row from `UNCOMPOSABLE` is how the gate goes green, and
   a row may be removed **only when the worker actually starts.**
7. **Alter a fixture solely to remove a `VIOLATED`** — specifically, the F17 fixture must not be
   shortened (§6, **W-A2**).
8. **Treat a placeholder as evidence** — a `PROVISIONAL` or `UNCALIBRATED` default is not a
   calibrated value, and a labelled accommodation is not a decision.
9. **Classify `UNKNOWN` as `PASS`** — *"UNKNOWN IS NOT PERMISSION"*, all the way down, including at
   `ADMIT_WITH_PENALTY` and `DENY_UNLESS_ENVELOPE`.
10. **Reclassify a V1 blocker as V2 without contract evidence** — §12 cites its authority per row,
    and a reclassification without one is a scope reduction wearing a taxonomy.
11. **Start Phase 16** — every §22.5 kill switch is thrown.
12. **Perform unrelated refactoring** — including "while I was in there" cleanups on the core path.
13. **Create a competing V1 status document** — update **this** document and the canonical
    contract. ~~`docs/v1/` holds exactly two files.~~ **`docs/v1/` holds three files, and the
    third states no status**: the checklist added 2026-09-05 is an operational collection sheet
    with no authority, subordinate to the record it summarises (§2, §14.7). **The prohibition is
    unchanged — only the file count is corrected — and no fourth file may be added.**
    > **The count is wrong again, corrected 2026-09-06: `docs/v1/` holds FOUR files and already did
    > when the sentence above was written** — `V1_DISCOVERY_AND_OWNER_QUESTIONS.md` landed in the
    > same commit and was not counted. **See §2. The prohibition in this rule stands exactly as
    > written and is not discharged by the correction**; whether the discovery document engages its
    > substance is flagged to the owner there and is not decided by any session.
14. **Reopen a broad Phase 15 audit, or import Phase 15 release scope into V1** — Phase 15 is
    FROZEN; §24, `formal/`, `docs/phase15/` and the release evidence were untouched by E-11 and
    stay untouched by V1 work.
15. **Add a ninth stop condition** — §I.2 admits none, and a newly found core-path defect is
    ordinary outstanding work (§3.1), not a new condition.

---

## §18 FINAL CHECK — PERFORMED AT CREATION

| Check | Result |
|---|---|
| New control document exists | ✔ `docs/v1/V1_IMPLEMENTATION_CONTROL.md` |
| Markdown internally consistent | ✔ every §-reference and table resolves |
| Every referenced canonical document exists | ✔ verified on disk (§2) |
| Current commit / tree recorded | ✔ `4e2155a`, E-11 `3ff92ae`, digest `023906be…` / 581 files |
| No source code changed | ✔ documentation only |
| No test changed | ✔ |
| No gate changed | ✔ `npm run gates` re-run, result **unchanged** at 7 PASS / 1 FAIL |
| No fake external input exists | ✔ no region, charger, router, or calibration value is proposed anywhere |
| S-1 … S-8 individually classified | ✔ §7 |
| 28 vs 34 reconciled | ✔ §5, incl. the unrecorded numerator (§5.5) |
| F17 `VIOLATED` classified | ✔ §6 — **E, correct-by-specification**, not V1-blocking |
| Repository implementation status separated from V1 closure status | ✔ §3 |
| V1 / V2 boundary explicit | ✔ §12 |
| Finite remaining work exists | ✔ §11 — ~~20~~ **21** items, closed list *(W-A4 added 2026-09-05 by W-D1; **W-D1 and W-D2 are both now CLOSED**)* |
| Exactly ONE immediate next action | ✔ §14 — ~~W-D1~~ ~~W-D2~~ **awaiting the owner's response to `RD-2026-09-05-01`** *(W-D1 done 2026-09-05, §5.6; W-D2 done 2026-09-05, §14.5)*. **No repository-owned, V1-blocking action is available on this tree** |

### 18.1 Re-performed at W-D1 — 2026-09-05

| Check | Result |
|---|---|
| Harness run exactly as implemented | ✔ `node tools/verify/v1CorePath.js --database-url …`, no npm script added, not one line of it changed |
| Runtime numerator captured verbatim, not inferred | ✔ **26 of 34** — §5.6.2. Not the expected 26 taken on trust, not the static 28, not the denominator 34 |
| Every measured row classified | ✔ §5.6.4 — 26 of 26, all classification **1**; none fell into 6, 7 or 8 |
| Six process dependencies checked at runtime, not by source inspection | ✔ all six in `satisfied`, none in `missing` — §5.6.5 |
| F33 / F35 blind spots verified against code rather than assumed | ✔ §5.6.6 — claim holds, mechanism sharpened |
| S-3 count changed only on evidence | ✔ **unchanged at 28**, with OLD/NEW/ADDED/REMOVED/RECLASSIFIED stated — §5.6.7 |
| No source, test, gate, fixture, formal model or config touched | ✔ documentation only; `git status` shows only `docs/v1/` |
| No external input fabricated | ✔ no router, region, charger, terrain, calibration, environment, mass, `p_fail` or hazard cost. `cutover.engine_enabled` **unbound**. B8 **unresolved** |
| Phase 15 untouched | ✔ no `formal/`, `docs/phase15/`, `§24` or release-evidence file read for change or written |
| No new report created | ✔ this document and the canonical contract only; `docs/v1/` still holds exactly two files |
| Owner asked for nothing | ✔ no owner request issued, no release-decision record created — that is **W-D2** |

### 18.2 Re-performed at W-D2 — 2026-09-05

| Check | Result |
|---|---|
| The decision record exists, under `docs/release-decisions/` | ✔ `RD-2026-09-05-01-v1-external-input-and-owner-decision-request.md` |
| Date, requesting party, and exact tree context stated in it | ✔ 2026-09-05 · the V1 implementation session, recorded by the maintainer of record · **HEAD `4e2155a`**, E-11 impl `3ff92ae`, digest `023906be…` / 581 files |
| *"V1 is not complete; S-3 is not met."* stated explicitly | ✔ verbatim, twice — §1 and the closing block |
| **Every §9 row represented exactly once** | ✔ rows **1–14** → **A1…A14**, one section each, in order, with **A6a** for the two Safety-class values; rows **15, 17, 18** → decisions **D-1, D-5, D-2**; row **16** recorded as non-blocking and not requested. §4.16 states the disposition of all four |
| **Every §10 decision D-1…D-6 represented exactly once** | ✔ §5.1 … §5.6, one section each |
| The two categories not collapsed | ✔ §4 **A. EXTERNAL INPUTS / VALUES** and §5 **B. OWNER / DEPLOYMENT DECISIONS** are separate sections with separate response tables, and each explicitly refuses the other's classification |
| Per item: what is needed · exact shape/semantics · accountable owner · where it enters · verification proving closure · consequence if absent | ✔ all six fields present for each of the 20 numbered items (**A1…A14**, **D-1…D-6**) and for **A6a**, plus a consolidated closure-evidence table at §6 covering all 21 |
| The four response categories distinguished | ✔ §3 and §7 — values supplied · decisions made · evidence attached · items intentionally declined |
| Declining does not make a condition pass | ✔ §3.1, restated §9 rule 5 |
| No absent physical input may be treated as benign | ✔ §3.2, restated §9 rule 6 |
| UNKNOWN remains DENY / non-permissive | ✔ §3.3, restated §9 rule 7 |
| V1 not complete until all eight S-conditions hold | ✔ §3.4, restated §9 rule 8; §1 carries the live 3-of-8 table |
| **D-6 marked NON-V1-BLOCKING and outside the eight** | ✔ §5.6 carries the banner; §7.2 repeats it; §10's traceability row records the classification |
| **No fabricated or example value anywhere** | ✔ mechanically verified: **every decimal in the record is a section reference**, and every integer is a count, a row index, a line number or an HTTP status. No router, region, charger, terrain figure, calibration constant, temperature, mass, `p_fail`, hazard cost, battery-wear quantity or energy rate. The B8 register defaults and V9's measured product are **deliberately not quoted** |
| **Safety-class values not assigned by the repository** | ✔ §4.6a asks Safety for its own decision and value for `energy.model_residual_cv` and `energy.reserve_floor_wh`, proposes neither, and records that §22.3 forbids an automated choice |
| **No V2 / Phase-15-release item entered the request** | ✔ every such term inside §4 and §5 occurs **only** in an "explicitly NOT asked for" clause; §8 is the full exclusion table, and adds nothing to §12's classification and removes nothing from it |
| No new V1 requirement invented | ✔ §10 of the record traces every row to §9 or §10 of this document, one-to-one in both directions |
| No source, test, gate, fixture, formal model or config touched | ✔ documentation only — `git status` shows only `docs/release-decisions/` and `docs/v1/` |
| No broad Phase 15 audit reopened | ✔ nothing under `docs/phase15/`, `formal/`, `§24` or the release evidence was read for change or written |
| No stop condition changed | ✔ **3 of 8, unchanged.** S-3 remains NOT MET; the request is issued and unanswered |
| Owner asked once, completely, for everything | ✔ one record, not several — §9 and §10 in the same act |

### 18.3 Re-performed at the repository-only pass — 2026-09-05

| Check | Result |
|---|---|
| Every registered repository item attempted | ✔ **W-A1, W-A2, W-A3, W-A4 all closed.** §14.6 is empty |
| W-B4's repository side executed against the schema, not against the sentences | ✔ §9.1 — all six families greped against `prisma/schema.prisma` and `src/`; five confirmed to have **no column and no producer**; one found to have a column that was loaded and not read |
| A found core-path defect handled by §3.1's own rule rather than deferred | ✔ **W-A5** added, fixed, tested, mutation-checked and closed in the same session; §3.1's status reverted and was re-earned. **No ninth stop condition added** |
| Fail-closed behaviour preserved at every change | ✔ a null / absent / non-object `stressCurves` column stays **absent**; `batteryWear` still names `stressCurves`; the harness's exit codes and its S-5/S-3 distinction are untouched |
| The F17 `VIOLATED` preserved | ✔ **not removed, not weakened, and the fixture not shortened.** The suite still asserts exactly one `VIOLATED`, `predicateId === "F17"`, `/commitment horizon/`, `deniedForIndeterminacyOnly === false` |
| No gate weakened, no gate algebra touched | ✔ `gate:composition` still **RED**, still `LEADER_ONLY_NOT_COMPOSABLE` for `coordinator`; no row removed from `UNCOMPOSABLE`; no probe relaxed |
| No requirement row satisfied by this pass | ✔ asserted by a test: `battery wear inputs (§14.4)` is still in `REQUIREMENT_IDS` and still in `requirements().missing` |
| **No external value fabricated** | ✔ **NO.** No router, region, charger, terrain figure, calibration constant, ambient or pack temperature, vehicle mass, `p_fail`, hazard cost, battery-wear quantity or energy rate. `cutover.engine_enabled` **unbound**. B8 **unresolved** |
| No owner decision made or pre-empted | ✔ the `residualCv` precedence divergence was **measured and left alone**, because it is Safety-class provenance (§9.1.4) |
| No second owner request issued | ✔ `RD-2026-09-05-01` stands; §9 row 11 was **amended** in this document, which is what §14 prescribes |
| Formal model untouched | ✔ nothing under `formal/` read for change or written |
| Phase 15 untouched | ✔ nothing under `docs/phase15/`, §24, or the release evidence read for change or written |
| No new status or control document created | ✔ `docs/v1/` still holds exactly two files |
| Stop conditions | ✔ **3 of 8, unchanged.** S-3 still **28**; the runtime numerator still **26** |

---

**TRUTH > GREEN.** V1 is a smaller, honest claim than Phase 15's release — not a weaker one.

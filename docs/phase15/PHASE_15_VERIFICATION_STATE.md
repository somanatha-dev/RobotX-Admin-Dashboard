# Phase 15 — Verification State

**What has actually been proven, and against which tree.**

> Current source of truth for navigation and verdict: **[`PHASE_15_MASTER.md`](PHASE_15_MASTER.md)**.

---

## 0. The tree every result below refers to

> ### ⚠ The tree has moved twice since the 2026-08-29 consolidation
>
> **REMEDIAL PHASE T1-04 + the `Leg.slaDeadline` producer (2026-08-30)** and **closure item
> V-10 (2026-08-30)** both changed files inside the source-digest scope. Digest
> `431010ace1…` (565 files) is **no longer this tree.** Where a row below is still dated
> 2026-08-29 and was not re-executed, it says so.
>
> **The single most consequential consequence, measured and stated up front:**
> `Backend/docs/release-evidence.json` is bound to `431010ace1…` and was produced
> `2026-08-29T06:28:45Z`. On the current tree every one of its records is **STALE** (the
> gates admit 86 400 s; the records are ~126 000 s old), so `npm run release:verdict` now
> reports **0 green, 17 red, 7 not evaluated** rather than 16/1/7. **The verdict is BLOCKED
> either way and no gate was weakened** — but the 16-GREEN figure below is historical, and
> **a fresh `npm run release:gates` collection is required before any closure claim.** See §3.

| | |
|---|---|
| Date of execution | **2026-08-29** (consolidation) · re-executed 2026-08-29 (documentation-integrity audit) · **partially re-executed 2026-08-30** (V-10) · **re-executed 2026-08-30** (post-V-10 current-state audit — see **§7b** for the command-by-command record) |
| Branch | `feature/dashboard` |
| HEAD | `67b7c7c` — with T1-04, the `Leg.slaDeadline` producer and V-10 **uncommitted** |
| Working tree | **Not clean.** Source, test, tool, schema and migration changes from T1-04 and the `Leg.slaDeadline` producer, plus V-10's: two runbooks, one code comment, one new engine test suite, one new live-DB harness, one `package.json` script |
| **Source digest — CURRENT** | **`d033038cb261c3de0efe13796af9aa26d190ea113a5a2bfe5971480f72bdca00`** (**573 files**), measured 2026-08-30 after V-10 |
| Source digest — the T1-04 tree V-10 started from | `f6f69ea1a54ca211939f71c029017de7fe5089ab0484733a98439868adcc2dd4` (571 files) |
| Source digest — the 2026-08-29 consolidation | `431010ace188c4b1b91415821e8cebc7beeb8f3f378a1b39fb77986fb3b22470` (565 files) — **superseded** |
| Node | v22.x · Windows 11 · the build machine — **not representative production hardware** |

**Rule for this document.** No result is recorded here unless it was executed on this tree, by this
consolidation, and its exit code observed. Nothing is inherited from an archived report. Anything
not executed is in §5 under **NOT CURRENTLY VERIFIED** and is labelled as such — never as a pass.

Digest verification command — **output below re-executed 2026-08-30 and is the CURRENT tree**
*(this block previously showed the superseded `431010ace1…`/565 reading with no date on it)*:
```
cd Backend && node -e "console.log(JSON.stringify(require('./tools/release/sourceDigest.js').sourceDigest()))"
→ {"digest":"d033038cb261c3de0efe13796af9aa26d190ea113a5a2bfe5971480f72bdca00","fileCount":573}
```

---

## 1. Test suite

**Command:** `npm test` (from `Backend/`; = `jest --runInBand --forceExit`, all five projects)
**Result:** `Test Suites: 162 passed, 162 total` · `Tests: 7275 passed, 7275 total` · `Snapshots: 0`
**Exit code:** `0`
**Date:** **2026-08-30**, at digest `d033038c…` (573 files)
**Repository state:** HEAD `67b7c7c` **plus T1-04, the `Leg.slaDeadline` producer and V-10, all uncommitted**

| Measured | Suites | Tests | What moved |
|---|---:|---:|---|
| 2026-08-29 consolidation, digest `431010ace1…` | 160 | 7 162 | — |
| T1-04 closure, 2026-08-30 | 161 | 7 261 | `tests/engine/fairnessLadder.test.js` (93) + the ladder contract tests + four flipped module-tree assertions |
| `Leg.slaDeadline` producer, 2026-08-30 | 161 | **7 268** | +7 in `intakeStranglerSeam.test.js`. **Recorded at the time against the engine lane only (130 → 130 suites / 6 920 → 6 927 tests); the full-suite figure was never restated, which is why "161 / 7 261" appeared above** |
| **V-10, 2026-08-30 — current** | **162** | **7 275** | `tests/engine/phase15RollbackRunbook.test.js` (7) |

Engine lane alone, re-measured 2026-08-30 after V-10: **131 suites / 6 934 tests**, exit 0
(`npx jest --selectProjects engine`), from 130 / 6 927.

> **Independently re-executed 2026-08-30 by the post-V-10 current-state audit** — a second, clean
> `npm test` at digest `d033038c…`: `Test Suites: 162 passed, 162 total` · `Tests: 7275 passed,
> 7275 total` · **exit 0**, 633 s, all five projects. **The figure above is confirmed, not
> inherited.** T1-04, the `Leg.slaDeadline` producer and V-10 introduced **no test regression.**
**Meaning:** every test in the repository passes. 0 failures, 0 skips.
**Blocking:** No — but a green suite is **not** a Phase 15 closure condition. Six adversarial passes
each found defects while this suite was green.
**Evidence location:** re-runnable; not archived as a file.

---

## 2. Build gates

**Command:** `npm run gates`
**Exit code:** `1`
**Date:** **2026-08-30** · **Tree:** digest `d033038c…` (573 files). *Every number below was
re-measured; the 2026-08-29 figure follows it in brackets where it moved, and every movement is
T1-04's, not V-10's — V-10 touched one code comment and added no engine module.*

| Gate | Command | Result |
|---|---|---|
| tier-dependencies (§1.8 rule 2) | `gate:tiers` | **PASS** — **289** modules *(285)*, **432** governed import edges *(423)*, no Tier 0/1 → Tier 2 dependency |
| parameter-register (§22, App. A) | `gate:params` | **PASS** — **192** engine modules *(189)* vs **250** registered parameters *(242)*; no bare behavioural constants |
| tenets (T1, T6) | `gate:tenets` | **PASS** — **286** modules *(282)*, no violations |
| identity-isolation (§23.7) | `gate:privacy` | **PASS** — 16 modules; no identifying field, no street address as a cost input |
| erasure reconstruction-equivalence (§23.7, §24.3) | `gate:erasure` | **PASS** — 3 corpus decisions, reconstruction byte-for-byte from Tier A alone |
| legacy-retirement (Phase 15) | `gate:legacy` | **PASS** — 4 retired modules absent and unimported across **346** files *(340)* |
| column-generation (§21.6) | `gate:columngen` | **PASS — NOT_REQUIRED** (0 paths in change set; the gate does not apply) |
| **composition-root (Phase 15)** | `gate:composition` | **FAIL — exit 1.** 1 violation across **19** registered workers *(18)* |

> **19 registered workers, not 18.** T1-04 added `src/workers/fairness.worker.js` for §17.5.
> Re-measured 2026-08-30: `require('./src/workers/registry.js').WORKERS.length` → **19**. The
> violation count is unchanged at 1 (`coordinator`), so **the gate's verdict did not move** —
> but any document still saying "1 of 18" is quoting a superseded tree.

**The one failure, verbatim in substance:** `coordinator` (tier 0) is
`LEADER_ONLY_NOT_COMPOSABLE` — reachable and declared `LEADER_ONLY`, but its round loop needs
`expandCandidates`, `pricedCandidateFor` and `commit`, which bottom out in an injected `route`
function. **No routing engine is selected** — execution-plan item **B1**, Step 5 blocked on D1, D3
and D8. The gate names the owner as **EXTERNAL** and states plainly that no commit in this
repository closes it.

**Blocking:** Yes — this is §24 gate `engine_decision_path_wired`.
**Isolated exit code confirmed:** `npm run gate:composition` → exit `1`.

---

## 3. Release verdict — the §24 gate table

### 3.0 CURRENT — re-executed 2026-08-30 at digest `d033038c…`

**Command:** `npm run release:verdict` · **Exit code:** `1`

```
RELEASE VERDICT — §24 gate table (24 gates, all blocking)
  source digest d033038cb261c3de…   evidence: docs\release-evidence.json   attestations: (none)
  0 green, 17 red, 7 not evaluated
  RELEASE: BLOCKED — 24 blocking gate(s) are not green.
```

*Re-executed 2026-08-30 after the V-10 closure audit: exit 1, same counts, and the tool now prints
the final digest `d033038c…`. (The first capture of this block showed `5e5d2093…`, the tree one
edit before the final one — the `package.json` script line. Nothing about the reading changed, and
this block now shows the settled tree.)* **Note `model_check_capacity_1_2_3` reads RED `[STALE]`
here, not `GREEN [NOT PROVEN]`** — staleness overrides the rendering, and **B-M's evidence state is
`NOT MEASURED / OPEN` either way.**

**Every one of the 17 RED rows carries the same reason, and it is not a gate failing:**

```
[STALE] record is 126012s old; the gate admits 86400s.
        Stale evidence is evidence about a system that has since changed.
```

`Backend/docs/release-evidence.json` was produced `2026-08-29T06:28:45.657Z` against digest
`431010ace1…`. That tree no longer exists and the collection has aged past every gate's
`maxAgeMs`. **This is the machinery working exactly as designed** — it is the same rule that
refuses a year-old rehearsal — and **no gate was weakened, changed or re-classified.** But it
means:

- **The "16 GREEN" figure quoted throughout Phase 15 documentation is historical.** On the
  current tree nothing is green, because nothing has been collected against it.
- **A fresh `npm run release:gates` (`verdict.js --collect`) is required before any Phase 15
  closure claim.** It is a ~25-minute serial collection. It was **not** run by this pass: the
  verdict is `BLOCKED` before and after, the working tree is still uncommitted and would void
  the collection on the next source edit, and re-collecting is the release owner's step at a
  quiescent tree — not a documentation act.
- **It changes no blocker.** B1's `engine_decision_path_wired` was RED for its own reason and
  still is; the 7 `NOT_EVALUATED` rows are untouched by staleness because nothing was ever
  filed for them.

### 3.1 HISTORICAL — 2026-08-29, digest `431010ace1…`

**Everything below this line describes the consolidation's tree and is retained because it is
what the gate table looked like when evidence was current. Do not quote it as current.**

**Command:** `npm run release:verdict`
**Exit code:** `1`
**Date:** 2026-08-29 · **Tree:** digest `431010ace1…`
**Evidence read:** `Backend/docs/release-evidence.json` — producer `tools/release/collectEvidence.js`,
produced `2026-08-29T06:28:45.657Z`, **17 records, 0 VOID, 17/17 bound to `431010ace1…`**, 0
attestations filed.

**`RELEASE VERDICT — §24 gate table (24 gates, all blocking): 16 green, 1 red, 7 not evaluated`**
**`RELEASE: BLOCKED — 8 blocking gate(s) are not green.`**

| Status | Gates |
|---|---|
| **GREEN (16)** | `tier_dependencies`, `parameter_register`, `design_tenets`, `identity_isolation`, `erasure_reconstruction_equivalence`, `legacy_removed_from_build`, `lower_bound_admissibility`, **`model_check_capacity_1_2_3`** ⚠, `determinism_replay`, `snapshot_retention`, `chaos_capacity_1`, `chaos_capacity_2`, `cache_tier_flush`, `scale_targets`, `locality`, `overload_admission_control` |
| **RED (1)** | `engine_decision_path_wired` — exit 1 from `npm run gate:composition` — **B1** |
| **NOT_EVALUATED (7)** | `calibration_safety_derived` (B8) · `invariants_enforced`, `simulator_fidelity`, `soak`, `shadow_agreement` (B-P) · `safety_case_assembled`, `rollback_rehearsed` (B-O) |

⚠ **`model_check_capacity_1_2_3` is GREEN and carries a `[NOT PROVEN]` annotation printed by the
tool itself:** the discharging suite asserts `exhaustive: false` for the lifecycle at capacities 1,
2 and 3, and `lifecycle.tla` has never been run under TLC; the commitment half is exhaustive only
at capacity 1. **A passing exit code from that command does not establish the gate's statement.**
This is blocker **B-M**. Do not read the GREEN as a discharge.

**`NOT_EVALUATED` blocks exactly as `RED` does (§24).** It is kept distinct so an incident review
can tell "we ran it and it failed" from "nobody ran it".

**Meaning:** Phase 15's release cannot proceed. 8 of 24 blocking gates are not green.
**Blocking:** Yes — this *is* the closure condition.
**Evidence location:** `Backend/docs/release-evidence.json`.

---

## 4. Individual Phase 15 verification commands

### 4.1 Calibration

**Command:** `npm run gate:calibration` · **Exit:** `1` · **Date:** **2026-08-30** · **Tree:** `d033038c…` (573 files)
**Result:** `FAIL — 39 blocking finding(s).` `250 entr(ies): 52 DERIVED, 160 PROVISIONAL, 38 UNCALIBRATED. 54 are Safety-class.`

> **Re-measured 2026-08-30; on 2026-08-29 at `431010ace1…` this read `242 entr(ies): 52 DERIVED,
> 152 PROVISIONAL, 38 UNCALIBRATED`.** The delta is exactly T1-04's 8 §17.4 ladder-rung fractions
> (`ladder.step_1_widen_radius_fraction` … `ladder.step_8_alternative_modality_fraction`), every
> one `PROVISIONAL` and **none Safety-class** — so **the blocking-finding count (39) and the
> Safety-class count (54) did not move.** `gate:params` corroborates the register total
> independently: **250** registered parameters, up from 242.
Every finding is `[SAFETY_NOT_DERIVED]` and names what it awaits — a measurement, a certification,
or an operations/safety decision.
**Meaning:** §22.4 forbids any Tier 0 parameter being `PROVISIONAL` or `UNCALIBRATED` at launch.
**Blocking:** Yes — §24 gate `calibration_safety_derived`, blocker **B8**.
**Evidence location:** re-runnable; also present as `corroboration` in `release-evidence.json`.

### 4.2 Routing readiness (B1)

**Command:** `npm run routing:readiness` · **Exit:** `0` · **Date:** 2026-08-29 · **Tree:** `431010ace1…`
**Exit code 0 is by design** (`tools/routing/b1Readiness.js:72–73`): reporting a missing decision is
not a build failure. **Do not read exit 0 as a pass — read the OVERALL line.**
**Result:** `OVERALL: BLOCKED`

| | Owner | State |
|---|---|---|
| **D1** | Operations + Commercial | **BLOCKED** — no authoritative operating region declared |
| **D3** | Product + Fleet Engineering | **BLOCKED** — no fleet speed model exists |
| **D8** | Operations | **BLOCKED** — extract vintage, cadence and re-contraction budget all undecided |
| Step 1 (deploy + contract per candidate) | | BLOCKED by D1, D3 |
| **Step 2 (adapters)** | | **PASS** — 3 implemented (osrm, valhalla, graphhopper); `inhouse` correctly NOT_IMPLEMENTED |
| Step 3 (benchmark) | | BLOCKED via Step 1 |
| Step 4 (build time + refresh cadence) | | BLOCKED by D1, D8 |
| **Step 5 (ENGINE SELECTION + ADR)** | | **BLOCKED** by D1, D3, D8, Steps 1, 3, 4 |

The tool states: *"A benchmark run now would NOT be admissible as B1 Step 3 evidence… NO ENGINE IS
SELECTED, RANKED OR RECOMMENDED BY THIS TOOL."*
**Blocking:** Yes — blocker **B1**, and the cause of the one RED §24 gate.

### 4.3 Simulator fidelity

**Command:** `npm run sim:fidelity` · **Exit:** `1` · **Date:** **2026-08-30** · **Tree:** `d033038c…` — **re-run after V-10; result unchanged**
**Result:** all **7** models `NOT_MEASURED` — `TRAVEL_TIME`(S), `SERVICE_TIME`,
`ENERGY_CONSUMPTION`(S), `CHARGE_DURATION`(S), `FAILURE_RATE`(S), `INTERVENTION_RATE`(S),
`DISCONNECT_RATE`(S). **6 safety-relevant.** No study was supplied (`--input <file.json>`).
**Meaning:** the simulator **may not discharge a Tier 0 verification obligation** (§24.4, §1.8).
An absent study is a standing finding, not a pass.
**Blocking:** Yes — §24 gate `simulator_fidelity`, blocker **B-P**.

### 4.4 Safety case

**Command:** `npm run safety:case` · **Exit:** `0` · **Date:** **2026-08-30** · **Tree:** `d033038c…` — **re-run after V-10; result unchanged**
**Result:** `12 hazard(s) assembled from 38 predicates and 22 invariants` · written to
`docs/safety-case/SAFETY_CASE.md` · `PASS — every reference resolves`.
**Regeneration on the current tree is still byte-identical** — `git status docs/safety-case/` was
empty before the run and empty after it, so the checked-in artefact is current and **T1-04 and
V-10 introduced no drift into it.** *(Checked explicitly on 2026-08-30 rather than assumed: this
assembler writes its output in place, so a silent change here would have been a working-tree
change nobody asked for.)*
**Meaning:** the safety-case *document* assembles and its references resolve.
**It does NOT discharge the §24.7 gate.** The assembler files no evidence and itself reports
"release gates: 0 green, 0 red, 24 not evaluated". `safety_case_assembled` remains `NOT_EVALUATED`.
**Blocking:** Yes — blocker **B-O**.

---

## 5. Live PostgreSQL verification

**Cluster:** disposable **PostgreSQL 18.3**, `initdb` from the installed binaries into the session
scratchpad, port **55432**, destroyed after use. **Never Neon. Never the default 5432 cluster** —
all four harnesses refuse both by name, and this was observed: running them against the ambient
`DATABASE_URL` produced *"refusing to run against … this harness is for a disposable cluster only"*.

**Schema:** `npx prisma migrate deploy` from an empty database → **27/27 migrations applied, 0
failed, 0 rolled back** → 74 domain tables + `_prisma_migrations` (75 base tables total), as of
2026-08-29. **On 2026-08-30 the count is 28**: T1-04 adds exactly one migration,
`20260830120000_ladder_escalation_t1_04` (one new table, `LadderEscalation`), applied by `psql -v
ON_ERROR_STOP=1` in directory order along with every earlier migration. *(Recorded as "29" until
2026-08-30; re-counted directly — 28 directories, 28 `migration.sql` files. 27 + 1 = 28.)*

| Harness | Command | Result | Exit | Date |
|---|---|---|---|---|
| Phase 15 live DB | `node tools/verify/phase15LiveDatabase.js` | **12 / 12 passed** | 0 | 2026-08-29 |
| Phase 15 current tree | `node tools/verify/phase15CurrentTree.js` | **32 / 32 passed** | 0 | 2026-08-29 |
| Phase 15 evidence binding | `node tools/verify/phase15EvidenceBinding.js` | **17 / 17 passed** | 0 | 2026-08-29 |
| Phase 15 version in force | `node tools/verify/phase15VersionInForce.js` | **19 / 19 passed** | 0 | 2026-08-29 |
| **T1-04 §17.4 ladder + `Leg.slaDeadline` producer** | `npm run verify:t104 -- "<url>"` | **72 / 72 passed** | 0 | **2026-08-30** |
| **V-10 — `rollback.md` §2.1 against the live API** | `npm run verify:v10` (`DATABASE_URL=…`) | **15 / 15 passed** | 0 | **2026-08-30** |
| | | **167 / 167** | | |

**The V-10 harness — `tools/verify/v10RollbackRunbook.js`, 15 checks — is the independent
verification of this pass**, and it is independent in the sense that matters: the jest suite
asserts the binding arithmetic through `configService.buildSnapshot`, which is pure and
in-memory, while the runbook's actual promise is about what a *running process* resolves after
a publish and a pin. The harness drives `configService.publish()` → `pinVersion()` →
`loadPinnedSnapshot()` on real PostgreSQL and reads the answer back out of the database.

- **Cluster:** disposable **PostgreSQL 18.3**, `initdb` from the installed binaries into the
  session scratchpad, **port 55436**, all **28** migrations applied by `prisma migrate deploy`
  from empty, destroyed after use. It refuses `neon.tech` and port 5432 by name — **observed**:
  *"refusing to run against a shared or default-port instance; this harness publishes
  configuration versions and moves the active-version pin"*, exit 2.
- **Re-runnable:** run three times in succession against one cluster, 15/15 and exit 0 each
  time. It builds *forward* rather than resetting, because it cannot reset — see Z1.
- **Group B is the BEFORE variant.** It executes the instruction the runbook used to give and
  reproduces the fleet-wide revert. Without it this harness would establish that the correction
  works and nothing about whether what it replaced was wrong (P15-F1's rule).

**Three things the live run established that no in-memory test could, and two of them
corrected this pass's own draft:**

1. **The one-binding publish is *refused* — by the wrong check, naming the wrong thing.** The
   draft finding said it simply succeeded. It does not: **V9** fires, because dropping the
   whole set takes `route.degraded_reserve_factor` back to a register default that puts
   combined degraded energy conservatism at 2.01 against a 1.6 cap. That is a guard by
   coincidence — it exists because of what one default happens to be, it names an energy cap
   rather than the four bindings that vanished, and **B2 shows that resolving it the obvious
   way (bind the one parameter the message names) publishes and pins successfully**, reverting
   everything else. The severity is unchanged and the description is now true.
2. **`ConfigVersion` cannot be deleted.** The draft's cleanup tried and PostgreSQL refused with
   `P0001 — "ConfigVersion is immutable once published (§22.1 rule 3)."` §22.1 rule 3 is
   enforced by a database trigger, not only by convention. Kept as check **Z1** rather than
   worked around; **Z2** clears the active-version pin, which is the one mutable thing here.
3. **The manual recipe and the automatic publisher produce the same set, field for field**
   (**C6**) — the claim §2.1 rests on, driven through the real `versionInForceReader`.

Each of the four Phase 15 harnesses cleans up every row it creates (`Z1 — clean`, observed in all
four). The T1-04 harness instead **clears its own working set at the start of every run**, which is
the same property arrived at from the other end: it was run twice in succession against one cluster
and produced the same result and `exit 0` both times. A verifier that only passes on a virgin
database is a verifier nobody re-runs.

**The T1-04 harness runs on a cluster of its own, port 55434** — the port is checked before use
because a cluster left running by an earlier session answers `pg_isready` while `createdb` then
fails on a missing role. It refuses any URL containing `neon.tech` by name, observed: exit 2 with
*"this tool plants constraint violations and must never run against shared infrastructure"*.

**What the 72 checks establish, and why the JS store model could not:**
- All **28** migrations apply to an empty database in directory order, T1-04's included.
- Each of the migration's **ten CHECK constraints rejects its own planted violation, and is
  asserted to be the constraint that rejected it** — a row refused by the wrong constraint is a row
  the intended one would have admitted.
- The shipped `fairness/ladder.js` is driven end to end through real Prisma transactions: rungs
  recorded, a re-fired timer converging, a human rung admitted, a second one held, a Leg past 100 %
  of budget **not** declared exhausted while no dispatcher had it, and the decline taken only once
  rung 8 carried an `admittedAt`.
- The three §21.4 SLIs derive from the rows the ladder had just written.
- **The `Leg.slaDeadline` producer (7 checks, added 2026-08-30).** The shipped
  `task.service.admitToRound` — the production request path, not a harness — is driven against the
  cluster, and the column it writes is read back out of PostgreSQL. The persisted deadline is
  **exactly** the store instant plus `sla.assignment_deadline` (`900 000 ms`, to the millisecond
  across a `TIMESTAMP(3)` round trip on both the column and the timer), it is the whole budget
  rather than the 225 s rung the timer is armed at, a retried admission moves neither the deadline
  nor the timer, and §17.4's triage comparator orders on the instant this path persisted. The
  in-memory double cannot establish any of this: it stores a JavaScript `Date` verbatim, so a
  truncation that hit the column and not the timer — leaving §17.4 sorting on a different instant
  from the one §4.5 fires on — would still look correct in jest. **The live run earned its keep on
  the first attempt**: it failed with `deadline−store = NaN`, because the verifier read
  `armedSeconds` as a column when `timers.register` writes it on the `payload`. The producer was
  right; the assertion was wrong, and only the real round trip showed it.

Two production defects were found by this work and are fixed. Both are the kind a green suite
against a model hides: `admittedAt` reads back as `undefined` rather than `null` from an
in-transaction Prisma read, and a strict `!== null` read that as *"already admitted"* — returning
`admitted: true` for a Leg no dispatcher had been given. The second was `Number(value || 0)`
collapsing a `NaN` completion count to zero, which would have alerted §17.5 on an agent that had
been working all day.

**Three of `phase15CurrentTree`'s checks are FINDING assertions** — they pass by confirming a
blocker is still present, not by confirming it is gone:
- **G1** — *FINDING X3: no §4.2 Task state is written anywhere, so no TASK timer has a producer.*
- **G2** — *FINDING: the coordinator and shadow workers remain uncomposable (B1).*
- **G3** — *FINDING: `gate:calibration` and the publish validator agree — B8 blocks the cutover.*
  190 launch-gate findings; defaults refused by V9.

**Meaning:** the Phase 15 database contracts, evidence binding, version-in-force semantics and
observation-window authority hold against a real PostgreSQL instance.
**Blocking:** No — these are green.

---

## 6. Repository-state facts verified directly

Confirmed by direct inspection. **Rows marked 2026-08-30 were re-measured against the current
digest `d033038c…` (573 files); the rest were inspected on 2026-08-29 at `431010ace1…` and are
unchanged by T1-04 and V-10.** *(This section's header previously dated every row 2026-08-29 at
`431010ace1…`, which was no longer true of the rows T1-04 moved.)*

| Claim | Method | Result |
|---|---|---|
| Source digest and file count | `sourceDigest()` | **`d033038c…`, 573 files — 2026-08-30.** *(Was `431010ace1…`, 565)* |
| **19** workers registered | `require('./src/workers/registry.js').WORKERS.length` | **19 — 2026-08-30.** *(18 on 2026-08-29; T1-04 added `fairness.worker.js`)* |
| **Worker readiness split** | `registry.report({running:[]})` | **9 `SCHEDULED` · 4 `LEADER_ONLY` · 6 `DEFERRED`** — so **12 workers actually start** (9 + 3, `coordinator` refused). **Re-measured 2026-08-30**; was 8 / 4 / 6 → 11 |
| **`leaderWorkers.UNCOMPOSABLE`** | `Object.keys(...)` | exactly `["coordinator"]`; `COMPOSERS` covers all four `LEADER_ONLY` workers — re-confirmed 2026-08-30 |
| **`src/workers/` file count** | `ls src/workers/*.js` | **21 — 2026-08-30** — 19 `*.worker.js` + `registry.js` + `leaderWorkers.js`. *(Was 20 = 18 + 2)* |
| **§24 gate table size** | `RELEASE_GATES.length`; `blockers({}).length` | **24** and **24**. Every row `blocking: true` — re-confirmed 2026-08-30 |
| **28** Prisma migrations | `ls -d prisma/migrations/*/`; `ls prisma/migrations/*/migration.sql` | 27 on 2026-08-29; **28 on 2026-08-30** — T1-04 adds exactly one, `20260830120000_ladder_escalation_t1_04`. **Both methods return 28.** *(Recorded as "29" until 2026-08-30 — an arithmetic error against its own "27 + one")* |
| Release evidence bound to this tree | JSON inspection | **NO — 2026-08-30.** 17 records, 0 VOID, but all 17 bound to the **superseded** `431010ace1…`; on `d033038c…` every one is `[STALE]`. See §3.0 |
| `tla2tools.jar` absent | repo-wide `find -name "tla2tools*"` | **absent** |
| ~~`src/engine/fairness/` T1-04 modules absent~~ | `ls` | **NO LONGER TRUE (2026-08-30).** `ladder.js`, `operatorCapacity.js`, `agentStarvation.js` all present, composed, and live-verified. The directory holds exactly those three and no Tier 2 fairness module — asserted by four module-tree tests, which were flipped from "empty" rather than deleted |
| `src/engine/lifecycle/preemption.js` absent | `ls` | absent — **and correctly so.** It is §4.8, Tier 2, Phase 16's. §17.4 rung 4 emits a directive and calls nothing, which `gate:tiers` enforces |
| `src/engine/routing/client.js` absent | `ls` | absent |
| **A9** — `assertVersionInKey` uncalled from production | `grep -rn` across `src/`, `tools/`, `tests/` | defined at `chargerReachabilityCache.js:124`, exported at `:375`; **only callers are `tests/engine/energySchema.test.js:268–269`** and one comment in `tools/routing/adapters/contract.js` |
| **P15-E6** — `app.locals.releaseEvidence` has no producer | `grep -rn "locals.releaseEvidence\s*="` | **no assignment anywhere**; read with `\|\| {}` at `health.controller.js:319` |
| `blockers()` ignores `unknownEvidence` | read `src/engine/cutover/gates.js` | `blockers()` filters `results` only; `unknownEvidence` folded into `ok` at `:541` but never into `blockers()` |
| P15-F7 collision fix present in the runbook | `grep -n collision docs/runbooks/cutover.md` | present at lines 220–229, mirroring `verdict.js:103–107` |
| CI omits `gate:composition` | read `.github/workflows/ci.yml` | 7 build gates run; `gate:composition`, `gate:calibration`, `safety:case`, `release:gates`, `routing:readiness`, `sim:fidelity` **not run** |

---

## 7. NOT CURRENTLY VERIFIED

**These have not been executed against the current tree by this consolidation.** They are recorded
as unverified, not as passing, and not as failing. Do not cite an archived number for any of them.

| Item | Why not run | Last archived claim (HISTORICAL — do not cite as current) |
|---|---|---|
| **Mutation testing** | **Partially executed 2026-08-30 by V-10** — see below. Not re-run across the rest of the tree | Archived third-pass report claims 8 distinct mutants across three concurrent sessions, all killed. **UNVERIFIED HERE.** V-10's own three are verified |
| **TLC exhaustive model checking** | `tla2tools.jar` is absent — it is not runnable on this tree at all. **Evidence state: NOT MEASURED / OPEN** | **Not** "never run by any pass" — that phrasing was imprecise and is corrected here. `lifecycle.tla` has never been run under TLC at any capacity; `formal/README.md:34-45` records two completed `commitment.tla` runs on **2026-08-15** under TLA+ 1.8.0 (`commitment_c1.cfg` as checked in, plus a reduced capacity-2 form), and `commitment_c2.cfg` as checked in did not converge. **HISTORICAL — a different tree, no recorded tool checksum, operator or hardware; cited as neither current nor a discharge.** This is blocker **B-M** |
| **Phase 0–14 cross-phase re-verification** | Out of scope for the 2026-08-29 consolidation; `npm test` covers the suites but not the per-phase live-DB harnesses. **The final closure audit of 2026-08-30 re-derived this row and it no longer holds as written: closure-checklist row V-9's trigger — *"run if the tree changes materially"* — is SATISFIED on this tree**, and the row is **repository-owned, actionable and unrun**. See `PHASE_15_CLOSURE_CHECKLIST.md` §C V-9 | Archived report claims Phases 0–14, **schema and migration history untouched** — **that premise is false on this tree**: `prisma/schema.prisma` is +103 lines and migration 28 was added, and T1-04 additionally changed `expiryActions.js` (+153), `leaderWorkers.js` (+68), `task.service.js` (+187) and `metrics.js` (+123). **UNVERIFIED HERE, and now known to need re-running rather than merely being unmeasured** |
| **Phase 5 live harnesses** (`phase5ExpirySemantics.js`, `phase5LiveDatabase.js`) | Out of Phase 15 scope for the consolidation — **but no longer out of scope on the evidence.** `phase5ExpirySemantics.js:28` requires `src/engine/supervision/expiryActions.js` and `:31` requires `src/workers/leaderWorkers.js`, **both of which T1-04 modified** — `attemptTransition` gained a `deadlineSecondsOverride` that changes which deadline a target state is armed with, and `escalationLadder` went from an unconditional refusal to four verdicts. **This is the most directly affected slice of V-9 and it is unrun** | Archived claim: 102/102 and 106/106, total 288/288 with the Phase 15 four. **UNVERIFIED HERE, and the archived numbers were measured against a tree that did not contain T1-04's changes to this harness's own subject — do not cite them as current** |
| **`npm run release:gates`** (`--collect`) | A ~25-minute serial collection that would overwrite `docs/release-evidence.json`. **Not run**, and deliberately so: the working tree is uncommitted, so the next source edit would void the collection, and re-collecting is the **release owner's step at a quiescent, committed tree** — not a documentation act, and never something to run to make the current tree look green | **The checked-in collection is NOT current-tree evidence.** It is bound to the superseded `431010ace1…` and every record is `[STALE]` — see §0 and §3.0. *(This row previously read "the checked-in artefact is already bound to this exact digest … re-collection would add nothing", and "the checked-in collection **is** current-tree evidence". Both were true on 2026-08-29 and false from the moment T1-04 moved the digest; they contradicted §3.0 of this same document. Corrected 2026-08-30.)* |
| **Soak / shadow-agreement / invariant observation windows** | Require an operating fleet. Cannot be run here. **Must not be simulated** | Blocker **B-P** |
| **Rollback rehearsal** | Requires a declared non-production environment and a named operator. **Must not be fabricated** | Blocker **B-O** |
| ~~**`docs/runbooks/rollback.md` procedure vs the current API**~~ | **EXECUTED 2026-08-30 — closure item V-10.** No longer unverified | **Was UNKNOWN; now measured.** Five defects found and fixed, one of them permissive and fleet-wide. See §5's V-10 harness (15/15) and `PHASE_15_BLOCKERS.md` § *V-10* |
| **Soak duration / scale numbers on production hardware** | The build machine is a Windows 11 laptop, explicitly not representative production hardware | Scale suite passes in-lane; that is a lane result, not a production measurement |

---

## 7a. Mutation testing — V-10, 2026-08-30

Three mutants, built against digest `d033038c…`, each run against
`tests/engine/phase15RollbackRunbook.test.js` alone. **All three killed; none survived.**

| # | Mutant | Caught by |
|---|---|---|
| 1 | `bindingsWithRegionDisabled` **appends** instead of replacing — the filter removed entirely | "the region's own binding is replaced, not appended" (1 failed / 6 passed) |
| 2 | The filter drops the `String(binding.key) === key` clause, so **every** region's cutover binding is removed | "disables one region and moves nothing else" (1 failed / 6 passed) |
| 3 | `evidence.REHEARSAL_STEPS` key renamed `artefact_rollback` → `artifact_rollback` | "REHEARSAL_STEPS is exactly the six keys rollback.md §5 lists" (1 failed / 6 passed) |

**The tree was restored and the restoration was verified, not assumed.** `evidence.js` was
compared byte-for-byte against `git show HEAD:…` with LF→CRLF applied — **identical**. Only
`rollbackPublisher.js`'s intended one-comment change remains, confirmed by `git diff --stat`
(3 insertions, 1 deletion).

---

## 7b. Post-V-10 current-state audit — 2026-08-30

**Purpose:** recompute Phase 15's closure state from the repository after V-10 closed, and
determine whether the V-10 changes created or exposed any **newly actionable repository-owned**
work. **They did not.** No code was written, no gate, threshold, test or configuration was
touched, and **no blocker, classification, status or verdict moved.** What the audit found was
**stale documentation** — corrected in place, each marked with what it used to say.

**Focused re-verification executed, with exit codes observed:**

| Command | Exit | Result | Moved? |
|---|---|---|---|
| `sourceDigest()` | — | **`d033038cb261c3de…`, 573 files** | Confirms the header |
| `registry.WORKERS.length` · `report({running:[]})` | — | **19** — 9 `SCHEDULED` / 4 `LEADER_ONLY` / 6 `DEFERRED`; **12 start** | Docs said 18 / 11 |
| `ls -d prisma/migrations/*/` · `ls */migration.sql` | — | **28** and **28** | **Docs said 29** |
| `RELEASE_GATES.length` · `blockers({}).length` | — | **24** and **24** | No |
| `npm test` | **0** | **162 suites / 7 275 tests / 0 failures** | No |
| `npm run gates` | **1** | 7 PASS / 1 FAIL. tiers 289/432 · params 192/250 · tenets 286 · privacy 16 · erasure 3 · legacy **346** · columngen NOT_REQUIRED · **composition FAIL, 1 violation across 19** | legacy 340→346; composition 18→19 |
| `npm run release:verdict` | **1** | **0 green / 17 red / 7 not evaluated**; every RED `[STALE]`; tool prints digest `d033038c…` | No — §3.0 already said so |
| `npm run gate:calibration` | **1** | 39 blocking findings; **250** entries (52 D / **160** P / 38 U), 54 Safety-class | **Docs said 242 / 152** |
| `npm run routing:readiness` | **0** | `OVERALL: BLOCKED`; D1/D3/D8 BLOCKED; Step 2 PASS; Steps 1/3/4/5 BLOCKED | No |
| `npm run sim:fidelity` | **1** | 7 models `NOT_MEASURED`, 6 safety-relevant | No |
| `npm run safety:case` | **0** | 12 hazards / 38 predicates / 22 invariants; **regeneration byte-identical** | No |

**Not re-run, deliberately:** the six live-database harnesses (167/167 — no schema, migration or
harness file changed since they ran), mutation testing beyond V-10's three, TLC (**B-M** —
`tla2tools.jar` still absent), and **`npm run release:gates`**. The last is the one that would
have made the tree "look green"; it is the **release owner's step at a quiescent, committed
tree**, the working tree is uncommitted, and re-collecting to improve a rendering is precisely
the act this programme forbids.

**The one claim the audit re-derived from source rather than trusting:** V-10's finding that
`cutover.engine_enabled` has exactly **four** production consumers — traced on the current tree to
`services/task.service.js` (`forShard`, `describe`), `cutover/agentGate.js` (`configEnabled`),
`controllers/health.controller.js` (`describe`) and `cutover/store.liveShards()` (`forShard`).
`server.js:547` and `sockets/socket.server.js:184` call `processEnabled()` — the **process** half,
not the per-shard binding — and `workers/coordinator.worker.js` reads neither. **V-10's finding
stands exactly as recorded, and B1 item 5 is unchanged.**

---

## 8. Verification integrity notes

1. **The tree did not change during verification** *except by the change under verification*.
   For the 2026-08-29 consolidation `git status --porcelain` was empty before the first command
   and after the last. For V-10, the mutation restoration was byte-verified (§7a).
2. **No test was modified** to obtain any result above.
3. **No threshold, gate or configuration was changed** to obtain any result above.
4. **Exit codes were captured from the command, not from a pipe.** Where output was piped to
   `tail`, `${PIPESTATUS[0]}` was used, and `gate:composition`'s exit was additionally confirmed in
   isolation.
5. **Two exit codes are counter-intuitive and are called out where they appear:**
   `routing:readiness` exits **0** while reporting `BLOCKED` (by design), and
   `model_check_capacity_1_2_3` is **GREEN** while carrying `[NOT PROVEN]` (by design, so the gap
   is visible rather than silent).

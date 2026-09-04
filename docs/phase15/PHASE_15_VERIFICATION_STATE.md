# Phase 15 — Verification State

**What has actually been proven, and against which tree.**

> Current source of truth for navigation and verdict: **[`PHASE_15_MASTER.md`](PHASE_15_MASTER.md)**.

---

## 0. The tree every result below refers to

> ### ⚠ The tree has moved THREE times since the 2026-08-29 consolidation
>
> **REMEDIAL PHASE T1-04 + the `Leg.slaDeadline` producer (2026-08-30)**, **closure item
> V-10 (2026-08-30)**, and now **the V1 audit (2026-09-01)** each changed files inside the
> source-digest scope. Digest `431010ace1…` (565 files) and digest `d033038c…` (573 files)
> are **both no longer this tree.**
>
> **Current: `1b301e285ad7dcd056439c83d24275a9a30a7e2900b1828855ee940250e32ff5` (576 files).**
> The V1 audit changed `solve/round.js`, `observability/metrics.js`,
> `workers/coordinator.worker.js` and `workers/registry.js`, and added one test file — the I20
> search-gap-provenance fix and the N13 registry correction. See
> [`../v1/V1_CONTRACT_AND_STOP_CONDITION.md`](../v1/V1_CONTRACT_AND_STOP_CONDITION.md) §E.
> **Re-measured on the new tree and unchanged:** `npm run gates` 7 PASS / 1 FAIL,
> `gate:params` 192 modules against **250** parameters with no bare behavioural constants,
> `gate:legacy` 346 files, 19 workers, 28 migrations, `routing:readiness` BLOCKED.
>
> Where a row below is still dated 2026-08-29 or 2026-08-30 and was not re-executed, it says so.
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
| Date of execution | **2026-08-29** (consolidation) · re-executed 2026-08-29 (documentation-integrity audit) · **partially re-executed 2026-08-30** (V-10) · **re-executed 2026-08-30** (post-V-10 current-state audit — see **§7b**) · **2026-08-30 — closure item V-9**, the Phase 0–14 cross-phase re-verification (see **§7c**) |
| Branch | `feature/dashboard` |
| HEAD | **`7335260`** — T1-04, the `Leg.slaDeadline` producer and V-10 were **committed as a snapshot** before V-9 ran. *Rows below that say "`67b7c7c` + uncommitted" describe the same content under its previous git identity; **the digest did not move**, which is the fact that matters* |
| Working tree | **No application source modified** — `git status --short` was empty before and after V-9. *(It was "not clean" through V-10; the snapshot commit is what changed, not the content.)* **Since V-9 closed, the five canonical documents in `docs/phase15/` carry their own uncommitted edits; `docs/` is outside the source-digest scope, so the digest is unmoved — re-measured `d033038c…` / 573 on 2026-08-31 by the freeze audit.** |
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
**Result:** `Test Suites: 164 passed, 164 total` · `Tests: 7307 passed, 7307 total` · `Snapshots: 0`
**Exit code:** `0`
**Date:** **2026-09-01**, at digest **`1b301e285ad7dcd0…` (576 files)** — the V1 audit's tree, after E-7
**Repository state:** HEAD `9e1d871` **plus the V1 audit's four source edits and one new test file, uncommitted at the time of the run**

> *(This block read "162 / 7 275, 2026-08-30, at digest `d033038c…`", and that figure is retained in
> the table below as the row it belongs to. It was measured twice, independently, and was correct
> for its tree.)*

| Measured | Suites | Tests | What moved |
|---|---:|---:|---|
| 2026-08-29 consolidation, digest `431010ace1…` | 160 | 7 162 | — |
| T1-04 closure, 2026-08-30 | 161 | 7 261 | `tests/engine/fairnessLadder.test.js` (93) + the ladder contract tests + four flipped module-tree assertions |
| `Leg.slaDeadline` producer, 2026-08-30 | 161 | **7 268** | +7 in `intakeStranglerSeam.test.js`. **Recorded at the time against the engine lane only (130 → 130 suites / 6 920 → 6 927 tests); the full-suite figure was never restated, which is why "161 / 7 261" appeared above** |
| V-10, 2026-08-30, digest `d033038c…` | 162 | 7 275 | `tests/engine/phase15RollbackRunbook.test.js` (7) |
| **V1 audit, 2026-09-01, digest `4d94ef18…` — current** | **163** | **7 291** | `tests/engine/solveRoundSearchGapProvenance.test.js` (**14** — I20 search-gap provenance, end to end from `expansion.js`'s producer contract through `round.finish()` to the §21.4 SLI) **+2 net in `workerRegistry.test.js`**, where the three tests that *pinned* the N13 gap became five that assert it closed |

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
  closure claim.** It is a ~25-minute serial collection. It was **not** run by this pass, nor by
  any pass since: the verdict is `BLOCKED` before and after, and re-collecting is the release
  owner's step at a quiescent, committed tree — not a documentation act. *(This bullet also gave
  "the working tree is still uncommitted and would void the collection on the next source edit".
  **That premise expired** with the snapshot `7335260` — corrected 2026-08-31 by the freeze audit.
  The conclusion is unchanged: **a committed tree is not an instruction to collect.**)*
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
| `tla2tools.jar` absent **from the repository** | repo-wide `find -name "tla2tools*"` | **still absent — 2026-08-31.** The jar used for the §7d runs was provisioned **outside the tree** and deliberately not added to it. **"Absent from the repo" no longer implies "TLC has not been run"** — see §7d |
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
| ~~**TLC exhaustive model checking**~~ | **EXECUTED 2026-08-31 — all six checked-in configurations were run. No longer unverified, and B-M did NOT close.** See **§7d**. **Evidence state remains NOT MEASURED / OPEN**: 1 of 6 closed, 2 UNKNOWN, 3 FAIL, no independent acceptance | **Was UNKNOWN; now measured — and four of the six outcomes are worse than "unmeasured".** The historical 2026-08-15 record is now known to be ambiguous on **two** independent grounds: its constants (already recorded in the handoff §7.1) **and its tool** — the v1.8.0 release was published **2026-08-21**, six days *after* the run is dated, so it cannot have used the released binary. Still cited as neither current nor a discharge. Blocker **B-M**, plus **two new blockers X4 and X5** |
| ~~**Phase 0–14 cross-phase re-verification**~~ | **EXECUTED 2026-08-30 — closure item V-9. No longer unverified.** Scope derived by transitive-closure intersection; **7 harnesses run** on a disposable cluster, **315/317**, **no regression**, no code changed. See **§7c** | **Was UNKNOWN; now measured.** The archived premise — *"Phases 0–14, schema and migration history untouched"* — was indeed false on this tree, which is why the row was run. The schema movement turned out to be **purely additive** (one new table, one back-relation; **no pre-existing column changed**), so no Phase 0–14 subject table moved |
| ~~**Phase 5 live harnesses** (`phase5ExpirySemantics.js`, `phase5LiveDatabase.js`)~~ | **EXECUTED 2026-08-30 under V-9 — the most directly affected slice, and it was run first.** `phase5LiveDatabase.js` **106/106, exit 0**. `phase5ExpirySemantics.js` **100/102, exit 1** — and **both failures are its own FINDING assertions that §17.4's ladder does not exist**, which T1-04 deliberately made false. **Not a regression:** proven by isolating the variable and corroborated by `verify:t104` 72/72. The `LADDER_EXHAUSTED → FAILED` row was **not** taken and the deadline **was** re-armed — the property those checks protect is intact. See **§7c.4** | The archived 102/102 + 106/106 are superseded. **Current: 100/102 and 106/106**, and the 2 are premise-invalidation, not defects. The harness was **deliberately not edited to go green**; what a Phase 5 maintainer would need to change is stated in §7c.4 |
| **`npm run release:gates`** (`--collect`) | A ~25-minute serial collection that would overwrite `docs/release-evidence.json`. **Not run**, and deliberately so: re-collecting is the **release owner's step at a quiescent, committed tree** — not a documentation act, and never something to run to make the current tree look green. *(This cell also gave "the working tree is uncommitted, so the next source edit would void the collection" as a reason. **That premise expired** when the snapshot `7335260` was committed before V-9 — corrected 2026-08-31 by the freeze audit, and the conclusion is unchanged. **A committed tree is not an instruction to collect:** the verdict is BLOCKED either way, so a fresh collection would restore the 16/1/7 rendering and change no gate's standing.)* | **The checked-in collection is NOT current-tree evidence.** It is bound to the superseded `431010ace1…` and every record is `[STALE]` — see §0 and §3.0. *(This row previously read "the checked-in artefact is already bound to this exact digest … re-collection would add nothing", and "the checked-in collection **is** current-tree evidence". Both were true on 2026-08-29 and false from the moment T1-04 moved the digest; they contradicted §3.0 of this same document. Corrected 2026-08-30.)* |
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

## 7c. Closure item V-9 — the Phase 0–14 cross-phase re-verification, 2026-08-30

**Executed for the first time.** V-9's trigger — *"run if the tree changes materially"* — had
fired and the row had never been run. **Result: the scoped Phase 0–14 contracts hold on this
tree. No regression. No code changed.**

### 7c.1 How the scope was derived — not asserted

The instruction V-9 carries is to scope to the surfaces whose subjects moved, **not** to run all
22 historical harnesses. The scope was computed rather than judged:

1. The changed application-source set was taken from `git diff --stat 67b7c7c 7335260` —
   **11 files**: `server.js`, `cutover/rollbackPublisher.js` (comment only), the three new
   `engine/fairness/` modules, `observability/metrics.js`, `supervision/expiryActions.js`,
   `services/task.service.js`, `workers/fairness.worker.js`, `workers/leaderWorkers.js`,
   `workers/registry.js`.
2. For each of the **22** harnesses under `tools/verify/` that is not Phase 15's, the transitive
   `require()` closure restricted to `Backend/{src,server.js}` was computed and intersected with
   that set.
3. **The schema diff was read, not assumed.** It is **purely additive**: one new table
   (`LadderEscalation`) and one back-relation on `Leg`. **No column on any pre-existing table
   changed**, so no Phase 0–14 harness's *subject table* moved. `Leg.slaDeadline` already
   existed; T1-04 added its producer, not the column.

| Harness | closure | changed modules in closure | In V-9 scope? |
|---|---:|---:|---|
| **`phase5ExpirySemantics.js`** | 70 | **5** — `expiryActions` + `leaderWorkers` **direct**, `fairness/ladder`, `fairness/operatorCapacity`, `registry` transitive | **YES — primary** |
| **`phase9ProductionPath.js`** | 131 | **5** — all transitive via `src/app` (the real HTTP intake path): `task.service`, `metrics`, `ladder`, `operatorCapacity`, `registry` | **YES** |
| **`phase14LiveDatabase.js`** | 37 | **3** — `task.service` **direct**, and it *calls* `admitToRound`, the changed function | **YES** |
| **`phase11LiveDatabase.js`** | 10 | **1** — `observability/metrics` **direct** | **YES** |
| `phase5LiveDatabase.js` | 14 | 0 | **YES — data-surface control.** Phase 5's other half; owns the I4 audit and the timer table that intake now populates |
| `phase12LiveDatabase.js` · `phase12Profile.js` | 17 · 17 | 0 · 0 | **YES — data-surface control.** `invariantWorker.checkPass` evaluates **I4**, the invariant whose production population T1-04 changed |
| `phase13LiveDatabase.js` | 38 | 0 | **YES — control.** The audit named "Phase 12–13"; leadership/reconciler over Legs |
| `phase3` · `phase4` · `phase6` ×4 · `phase7` ×3 · `phase8` · `phase9LiveDatabase` · `phase10` ×2 · `phase13Profile` | — | **0 each** | **NO — 14 harnesses skipped.** No changed module anywhere in the closure **and** no changed table in the subject. Their subjects are commitment, dispatch, feasibility, energy, payload, privacy-free solve and the availability index, none of which the tree movement touched |

### 7c.2 Database and environment

**Cluster:** disposable **PostgreSQL 18.3**, `initdb` from the installed binaries into the session
scratchpad, **port 55437**, `max_connections=200`, **destroyed after use** (`pg_ctl -m fast stop`,
data directory removed, 0 listeners on 55437 confirmed). **Never Neon. Never the default 5432
instance** — every harness refuses both by name and `Backend/.env`'s `DATABASE_URL` was overridden
in the environment (`dotenv.config()` carries no `override`, so the ambient value wins).

**Schema:** `npx prisma migrate deploy` from an **empty** database → **28 / 28 migrations applied,
0 failed, 0 rolled back**, **76 base tables**. Each harness then ran against its own database
cloned from that migrated template (`CREATE DATABASE … TEMPLATE`), so no harness inherited another's
rows.

### 7c.3 Harnesses executed — every one, with its exit code

| Harness | Result | Exit |
|---|---|---:|
| `phase5ExpirySemantics.js` | **100 / 102** — 2 invalidated-premise FINDING checks, §7c.4 | 1 |
| `phase5LiveDatabase.js` | **106 / 106** | 0 |
| `phase9ProductionPath.js` | **7 / 7** (real app, real route, real DB) | 0 |
| `phase11LiveDatabase.js` | **31 / 31** | 0 |
| `phase12Profile.js` | **completed, no error** — drove `invariantWorker.checkPass` and `invariantChecker.checkOne` over 500 Legs / 500 agents | 0 |
| `phase12LiveDatabase.js` | **NOT RUNNABLE — UNKNOWN.** Aborted at fixture check **T4** (*"no Mission row; seed the database first"*) before reaching any subject under test. **Blocked by a pre-existing seed defect, not by anything V-9 assesses** — §7c.5 | 1 |
| `phase13LiveDatabase.js` | **73 / 73** | 0 |
| | **315 / 317** across the five that report check counts | |
| *`t104LadderLiveDatabase.js`* | ***72 / 72** — **corroboration, not V-9 scope.** Run only to discriminate §7c.4* | *0* |

**Skipped — 14, each for the same measured reason:** `phase3LiveDatabase`, `phase4LiveDatabase`,
`phase6AlphaProbe`, `phase6LiveDatabase`, `phase6NullTierProbe`, `phase6PlantedViolations`,
`phase7ClosureProbe`, `phase7LiveDatabase`, `phase7SecurityClassProbe`, `phase8LiveDatabase`,
`phase9LiveDatabase`, `phase10Oracle`, `phase10Profile`, `phase13Profile`. **Zero changed modules
in the transitive closure and zero changed tables in the subject.** This is the "scope
intelligently" instruction discharged by measurement; it is **not** a claim that they would fail.

### 7c.4 The two failures — expected semantic change, NOT a regression

Both are in `phase5ExpirySemantics.js`, and **both are FINDING assertions that pass by confirming
a gap is still present** — the same construction as `phase15CurrentTree`'s G1/G2/G3. T1-04 closed
the gap they assert, so they now fail *by design*:

| Check | Asserts | Now |
|---|---|---|
| `:1101` — *"FINDING X1 — §17.4's escalation ladder (T1-04) has no implementation"* | `src/engine/fairness/` holds **0** modules | holds **3**. **X1/T1-04 is CLOSED**; this check asserts the state T1-04 was opened to end |
| `:334` — *"QUEUED · ESCALATION_LADDER refuses by name"* | `lastOutcome === "LADDER_NOT_IMPLEMENTED"` | `LADDER_UNDETERMINED:LADDER_NOT_PUBLISHED` |

**The second needed proof, not assertion, and it got it.** `LADDER_UNDETERMINED` could mean the
shipped ladder is inert — a real regression. It is not. The single variable was isolated against
the shipped `ladder.stepTableFrom`:

```
harness VALUES map: 28 entries · ladder.step_* entries in it: 0
A. harness VALUES as-is             → ok=false
     "ladder.step_1_widen_radius_fraction did not resolve to a finite number,
      so §17.4 rung 1 (WIDEN_SEARCH_RADIUS) has no trigger."
B. harness VALUES + the 8 register-published fractions
                                    → ok=true, 8 rungs, [0.25,0.4,0.55,0.7,0.8,0.85,0.9,1]
```

The harness hand-builds its `VALUES` map and that map **predates T1-04's register entries**; the
register publishes all 8 (`grep` confirms), and every register entry T1-04 added carries
`changeClass: "POLICY"`. **Corroborated end to end:** `t104LadderLiveDatabase.js` drove the
shipped ladder against the same cluster — rungs recorded, the three §21.4 SLIs derived from its
own rows, `Leg.slaDeadline` written by the real `admitToRound`, the timer armed at rung 1's
225 s of a 900 s budget — **72 / 72, exit 0**. **The ladder is not inert; the fixture is stale.**

**The safety-critical half of that check still passed, and that is the load-bearing fact.** The
two checks either side of `:334` — *"it does NOT read a missing ladder as an exhausted one — the
Leg is not FAILED"* (`state=QUEUED`) and *"the deadline is re-armed rather than discharged (I4)"*
(`timerState=PENDING attempts=1`) — **both passed**. The §4.4 `LADDER_EXHAUSTED → FAILED` row was
not taken. The property Phase 5 wrote that check to protect is intact.

**No code was changed, and the harness was deliberately NOT edited to make it green.** Flipping
two FINDING assertions to their inverse would produce a green run and destroy the record of what
they were asserting. V-9's instruction is explicit — *document an intentionally invalidated
premise rather than force a false PASS* — and this section is that documentation. **What a future
Phase 5 maintainer needs** (owned by Phase 5, not by Phase 15, and not done here): add the 8
`ladder.step_*_fraction` entries to the harness's `VALUES` map, and rewrite `:334` and `:1101` to
assert the post-T1-04 truth — that the ladder exists, resolves, and returns `STEP_AVAILABLE`.

### 7c.5 One incidental defect — pre-existing, out of V-9's scope, NOT fixed

`phase12LiveDatabase.js` could not be run, and the reason is a genuine defect that **V-9 did not
cause and does not own**:

> **`node prisma/seed.js` fails silently and exits 0.** It aborts inside `seedRegister`
> (`config/service.js:598`) with `PrismaClientValidationError: Invalid value for argument
> "changeClass". Expected ConfigChangeClass.` — **3 register entries carry
> `changeClass: "OPERATIONAL"`** (`feasibility.negative_cache_ttl`, `link.min_quality`,
> `reliability.max_intervention_rate`) and the `ConfigChangeClass` enum has **7 members, none of
> them `OPERATIONAL`**. `main().catch(console.error)` swallows it, so the process **reports
> success** having written **165 of 250** register entries and **0 Mission / 0 Shard / 0 Region /
> 0 Agent**. A partial seed that exits 0 is worse than one that fails.

**Proven pre-existing by construction, not assumed.** The `ConfigChangeClass` enum, the 3
`OPERATIONAL` entries (8 occurrences) and `prisma/seed.js` are **byte-identical at `67b7c7c`**;
`git diff 67b7c7c 7335260` touches none of them; `git log -S'"OPERATIONAL"'` dates it to
**`cbe540e`, 2026-08-09** — three weeks before the tree movement V-9 exists to assess. Same
inputs, same code, same enum ⇒ the seed failed identically before T1-04.

**Not fixed here**, and deliberately: it is not a Phase 15 item, it moves no §24 gate, choosing
between *"add `OPERATIONAL` to the enum"* and *"reclassify the 3 entries"* is a §22.1 register
governance decision rather than a mechanical one, and **fabricating the missing `Mission` row to
force `phase12LiveDatabase` green would have been manufacturing the fixture** — which V-9's own
instructions forbid. Registered as **residual observation 8** in `PHASE_15_BLOCKERS.md`.
`gate:params` does not catch it because it reads the register JSON, not the database.

**Phase 12's surface is covered regardless:** `phase12Profile.js` exercised the same
`invariantWorker.checkPass` / `invariantChecker.checkOne` path over 500 Legs against the live
cluster and exited 0, and `phase12LiveDatabase`'s closure carries **zero** changed modules — it
was a discretionary control, never a scope-derived requirement, so its `UNKNOWN` does not hold
V-9 open.

### 7c.6 What V-9 changed

**Nothing.** No source, test, tool, threshold, gate, configuration, register entry or harness was
modified. Measured after the run, not asserted:

```
git status --short   → (empty)
sourceDigest()       → {"digest":"d033038cb261c3de0efe13796af9aa26d190ea113a5a2bfe5971480f72bdca00",
                        "fileCount":573}
```

**Identical to the digest in every header of this document set.** **Mutation testing is therefore
not owed** — V-6's requirement is per *implementation* pass, and V-9 wrote no implementation.

**Conclusion: the current Phase 15 tree remains compatible with the affected Phase 0–14
contracts. V-9 — CLOSED / VERIFIED.**

---

## 7d. B-M — TLC executed for the first time, 2026-08-31

**Full §7.3a record with the raw TLC output retained verbatim:
[`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md).** This section is the summary;
that document is the evidence.

> ### B-M REMAINS **OPEN**. Evidence state: **NOT MEASURED / OPEN**.
> **1 of 6 configurations closed. 2 did not converge. 3 failed. No independent acceptance.**
> **Do not report the compute requirement as satisfied because TLC was provisioned.**

**No source file, `.tla`, `.cfg`, schema, migration, test or configuration was changed.** The
Phase 15 implementation freeze at `c27a75c` is intact and its verdict is unchanged. `formal/` and
`docs/` are outside the source-digest scope, so **the digest `d033038cb261c3de…` did not move.**

### 7d.1 The tool artefact — §7.3a items 1–3

| Field | Value |
|---|---|
| **Provenance** | `https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar` — the **v1.8.0 ("The Clarke")** release asset. **Provisioned outside the repository and not added to it** |
| **SHA-256** | `eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a` (4 487 757 bytes) — re-verified 2026-08-31 against the artefact that produced the runs |
| **TLC self-report** | `TLC2 Version 2026.08.21.155922 (rev: 9787e65)` · manifest `Implementation-Version: 2.0 2026-08-21`, `Build-TimeStamp: 2026-08-21T15:59:22.332Z`, `X-Git-Tag:` **empty** |
| **JDK / runtime** | Oracle `20.0.2+9-78`, HotSpot 64-Bit Server VM. Flags `-Xmx6g -XX:+UseParallelGC`; TLC reports `5461MB heap and 64MB offheap`, `12 workers on 12 cores` |
| **Machine** | LENOVO `21DJ` · 12th Gen Intel Core i5-1235U (10 physical / 12 logical) · **15.72 GB RAM** · `C:` 363 GB, **45 GB free**, Micron `MTFDKCD512TFK` NVMe · Windows 11 `10.0.26200` |
| **Contended** | **YES.** A developer workstation, and **it slept mid-run** during `commitment_c2` |
| **Operator (§7.3a item 4)** | **NOT SATISFIED** — an agent session under the owner's direction; **no named human has signed** |

**The artefact never self-reports the string "1.8.0".** Its own version string is a build date and
its manifest tag field is empty. **"TLA+ 1.8.0" identifies where the artefact came from, not
something the tool printed** — which is precisely why §7.3a item 1 also requires the checksum.

### 7d.2 The provenance discrepancy — the historical 2026-08-15 run

| Fact | Source |
|---|---|
| The historical run is dated **2026-08-15** and labelled **TLA+ 1.8.0** | `formal/README.md:28-31` |
| **v1.8.0 was published 2026-08-21T16:05:58Z**; the jar was built `2026-08-21T15:59:22Z` | GitHub release metadata + jar manifest |
| The preceding release, **v1.7.4, was published 2024-08-05** | GitHub release metadata |

**Therefore the released v1.8.0 artefact did not exist on 2026-08-15**, and a run dated then cannot
be proven to have used it merely from its "1.8.0" label. **This does not make the historical run
wrong** — a pre-release build, a nightly or a mislabelled string are all consistent with it. **It
establishes that the historical run's tool is NOT identified**, which is exactly what §7.3a item 1
exists to prevent, and the run recorded no checksum, so it cannot be closed from the record that
exists.

**Separately, the constants ambiguity is now partially resolved.** `commitment_c1.cfg` run **as
checked in (2/2/4)** produced **17 991 520 states / 2 375 660 distinct / diameter 21** — an exact
three-way match to the historical README row that names `commitment_c1.cfg` but annotates it
**3/2/5**. That is strong evidence the file name is right and the annotation is the transcription
error. **It does not resolve the second README row**, whose "reduced capacity-2 at 2/2/4 →
37 633 116 states" cannot be right either, since 2/2/4 measured 17 991 520 here.

> **Both findings are input to the release owner's §7.1 / §7.6 acceptance decision and neither is
> that decision.** **This pass does not count the historical run toward the six**, and the six
> results below stand without it. `formal/README.md` was **not edited** — §7.4 forbids editing
> `.cfg`/`.tla`, and rewriting the README would destroy the historical record rather than correct it.

### 7d.3 The six authoritative results — §7.3a items 5, 6, 9

**Every run executed the configuration exactly as checked in.** Constants quoted verbatim from the
`.cfg` files as §7.3a item 6 requires.

| Configuration | Constants as checked in | Closed? | Generated | Distinct | Depth | Wall | Verdict |
|---|---|---|---|---|---|---|---|
| `commitment_c1.cfg` | `Legs={l1,l2}` `Workers={w1,w2}` `Capacity=1` `MaxFence=4` | **YES**, 0 on queue | 17 991 520 | 2 375 660 | 21 | 25 s | **PROVEN / PASS — exhaustive** |
| `commitment_c2.cfg` | `Legs={l1,l2,l3}` `Workers={w1,w2}` `Capacity=2` `MaxFence=5` | **NO** | 1 650 642 056 | 287 362 834 | 20 | 31 204 s wall / **~6 500 s compute** | **UNKNOWN — did not converge.** 126 025 013 on queue, **23.6 GiB** disk queue still growing |
| `commitment_c3.cfg` | `Legs={l1,l2,l3,l4}` `Workers={w1,w2}` `Capacity=3` `MaxFence=6` | **NO** | 107 713 972 | 32 163 551 | 15 | 247.4 s | **UNKNOWN — did not converge.** Abnormal exit `-1`, 21 066 205 on queue, **no TLC error and no completion line** |
| `lifecycle_c1.cfg` | `Legs={l1,l2}` `Capacity=1` `MaxTicks=3` | **NO** | 220 | 79 | 6 | 2.1 s | **FAIL — `Error: Deadlock reached.`** |
| `lifecycle_c2.cfg` | `Legs={l1,l2,l3}` `Capacity=2` `MaxTicks=3` | **NO** | 1 041 | 277 | 6 | 2.0 s | **FAIL — `Error: Deadlock reached.`** |
| `lifecycle_c3.cfg` | `Legs={l1,l2,l3,l4}` `Capacity=3` `MaxTicks=3` | **NO** | 4 770 | 1 012 | 6 | 2.1 s | **FAIL — `Error: Deadlock reached.`** |

**Capacity scope (§7.3a item 9):** `commitment.tla` **covered at capacity 1 only**;
`lifecycle.tla` **covered at NO capacity**.

**The `commitment_c2` machine-sleep disclosure.** Budget 7 200 s; wall clock **31 204 s**. TLC's own
progress timestamps are continuous `03:35:47 → 05:22:13` local, then stop for ~7 hours, then resume
at `Checkpointing completed at (2026-08-31 12:27:38)`. **The machine slept.** Actual search is
roughly **6 500 s — the run did not consume its own budget**, and the kill was triggered by wall
clock, not compute exhaustion. **This hardens rather than softens the UNKNOWN verdict:** after
~108 minutes the queue was 126 M states and 23.6 GiB and still growing monotonically. A re-run on
dedicated, sleep-inhibited compute would give a cleaner number — Compute/Platform's call (§7.6).

**`commitment_c3` abnormal termination.** Exit `-1` at 247 s of a 7 200 s budget, 2.95 GiB metadir
accumulated in ~4 minutes, **no TLC error line, no completion line, empty stderr, no `hs_err_pid`
crash log**. **The cause is not established and is not guessed at.** It began immediately after
`c2` was killed, while that run's 23.6 GiB metadir was still on disk; disk pressure is *consistent
with* the observation and **not proven** — TLC reports disk exhaustion explicitly and printed
nothing. **Either way the verdict is UNKNOWN.**

### 7d.4 Property coverage — §7.3a item 7

| Configuration | Declares | Reached a verdict? |
|---|---|---|
| `commitment_c{1,2,3}.cfg` | `INVARIANT Safety` only — **no liveness, by design** (`commitment.tla:380-386`) | **c1 yes** (all nine `Safety` conjuncts, exhaustively). **c2/c3 no** — partial search only |
| `lifecycle_c{1,2,3}.cfg` | `INVARIANT Safety` · `PROPERTY TerminalIsFinal, Liveness` | **NONE.** All three abort at depth 6 |

> **No lifecycle liveness property has ever been evaluated by TLC, at any capacity.** TLC printed
> `Implied-temporal checking--satisfiability problem has 6 / 9 / 12 branches` — the tableau was
> *constructed* — and every run then terminated before a liveness result was produced. **The absence
> of a temporal-property error in these logs is the absence of a search, not the absence of a
> counterexample.**

**Guard G5 has no counterpart in either model** — neither `commitment.tla`'s `GuardsPass` nor
`commitmentModel.js` models a cancelled Leg, so G5 is vacuous in both. **The one run that did
complete does not cover it.** Unchanged by this pass; evidence remains `commitmentGuards.test.js`
plus the live-database run (`formal/README.md:130-134`).

**Boundedness (§7.3a item 8) is NOT ACCEPTED.** `MaxTicks = 3` in all three lifecycle
configurations is a **global** timer budget, not per-Leg, and does not scale with `Capacity` while
`Legs` does. Whether a three-tick lifecycle is still the system is a safety judgement and **no
safety engineer has signed for it**.

### 7d.5 Two new blockers — X4 and X5. Neither is B-M and neither is a Phase 15 implementation defect.

> ### ⚠ BOTH WERE DECIDED AND IMPLEMENTED LATER ON 2026-08-31. See **§7e**.
> The two entries below are retained as the record of the findings **as they stood when they were
> opened**, against the previous `formal/lifecycle.tla`. They are not rewritten. **§7e records the
> decisions, the model change, the after-evidence, and the new finding X6 that the fix exposed.**

**X4 — `CustodyMatchesState` is contradicted by `Strand` and `TimerFires`.**
**SPECIFICATION / FORMAL MODEL / SAFETY ENGINEERING.** Under the secondary `-deadlock` diagnostic
runs, all three capacities report `Error: Invariant Safety is violated.` at **depth 9** on this
trace:

```
Plan → Offer → Accept → Depart → ArrivePickup → Load → CancelWithCustody → TimerFires
```

producing `ABORTING → STRANDED_OBSTRUCTING` **while custody remains `HELD`**.
`CustodyMatchesState` (`:392-394`) permits `HELD` only in
`{LOADED, EN_ROUTE_DROP, AT_DROP, ABORTING}`; **`TimerFires` (`:340-342`) and `Strand` (`:291-295`)
are two independent transitions that carry `HELD` into a stranded state**; and `Recovered`
(`:301-306`) is guarded on the Leg being stranded with an `IF custody[l] = "HELD"` branch —
**it is written to resolve exactly the state the invariant forbids.**

**Retaining `HELD` custody while stranded may well be semantically plausible** — a robot broken down
mid-delivery is still holding the parcel. **This document does not decide that**, and it must not be
decided by whichever repair is smaller. **It is safety-engineering and specification work requiring
the safety engineer and the frozen-specification owner. No repository implementation change can
legitimately close it.** `lifecycle.tla` being checked in does not make it Phase 15 implementation —
it is a transcription of the *specification* (`formal/README.md:106-109`). **Whether the shipped
`Backend/src/engine/lifecycle/` shares the disagreement is UNKNOWN and was not investigated.**

**X5 — the lifecycle configurations abort on TLC's default deadlock check before evaluating
anything.** **FORMAL-VERIFICATION CONFIGURATION / DOCUMENTATION GAP.** All Legs `Cancel` to terminal
states, no action remains enabled, and TLC's default check fires at depth 6. No `.cfg` sets
`CHECK_DEADLOCK FALSE`. **`CHECK_DEADLOCK` was not changed and no `.cfg` or README was edited.** The
four available options are not equivalent and at least one is a specification statement — **the
choice is an explicit owner decision** (`PHASE_15_BLOCKERS.md` § X5).

> **The three `-deadlock` runs are SECONDARY DIAGNOSTIC EVIDENCE and are NOT authoritative.** They
> add a flag the checked-in configuration does not specify, and §24.2's own argument is that *"the
> configuration under check is itself part of the requirement"*. They are retained, labelled, at
> `PHASE_15_BM_TLC_RUN_RECORD.md` §12.7–§12.9. **They discharge nothing** and must not be promoted
> into proof.

### 7d.6 Retention — and the convention gap that has to be reported rather than filled

§7.3a requires *"the raw output of every run is kept as release evidence alongside items 1–10"*.
**The repository prescribes NO evidence directory and NO file format for a TLC run**, and §7.5 gap 1
says so by design: *"the six runs' evidence lives in the written record and its retained raw output
— nothing admits, checks or ages it."* `evidence.admit()` refuses any record whose `run.command` is
not `npm run test:engine -- ModelCheck`, and the schema **has no field for any of §7.3a items 1–10**.

**No new retention convention was invented.** No `evidence/` directory, no `formal/runs/`, no JSON
schema, and no change to `evidence.js`, `gates.js` or `sourceDigest.js`. The raw output is retained
**verbatim in the written record** — `PHASE_15_BM_TLC_RUN_RECORD.md` §12, in `docs/phase15/`, the
existing directory and naming convention that the handoff names three times as where B-M's evidence
lives. **That location is PROVISIONAL and is the release owner's to confirm or redirect (§7.6).**

**Four classes of run are kept explicitly apart** and must not be conflated: **authoritative**
(the six checked-in configs), **secondary diagnostic** (the three `-deadlock` runs),
**interrupted / budget-limited** (`commitment_c2` killed at budget after a machine sleep;
`commitment_c3` abnormal exit), and the **historical 2026-08-15 run** whose provenance is ambiguous
and whose raw output this repository never held.

### 7d.7 What did NOT change

| | |
|---|---|
| `establishedByCommand` / `notEstablishedReason` on `model_check_capacity_1_2_3` | **Intact. Not removed.** §7.4 permits removal only after all six complete; one did |
| The gate algebra and the `[NOT PROVEN]` annotation | **Unchanged** |
| `release-evidence.json` | **NOT re-collected.** Still bound to `431010ace1…`, still `[STALE]` |
| The source digest | **`d033038cb261c3de…` — unmoved.** All edits are under `docs/` |
| B1, B8, B-P, B-O, X3, A9 | **Not touched** |

> **One correction owed to `gates.js` and deliberately NOT made.** Its `notEstablishedReason` says
> *"`lifecycle.tla` has never been run under TLC"*. That is now false — it has been run, and it
> failed. Correcting it is a source change inside the digest scope and inside the frozen
> implementation, and the sentence **understates** the gap rather than overstating it, so leaving it
> is conservative. Recorded here and in the blocker register for whoever next has authority.
> *(**Stale in a second way after §7e** — the module has since been changed and `lifecycle_c1` now
> closes. Still not corrected, for the same reason, and it still understates rather than overstates.)*

---

## 7e. The X4 / X5 decision pass — 2026-08-31, second pass

**Trigger:** the sole project owner/reviewer, acting as the project's specification and verification
authority, took the two decisions §7d.5 referred out.
**Scope:** `formal/lifecycle.tla` and the Phase 15 documentation. **Nothing else.**

> ### NO INDEPENDENT SIGN-OFF EXISTS AND NONE IS CLAIMED.
> Solo project — one developer, one tester, one reviewer. The separate **safety engineer**,
> **frozen-specification owner** and **release owner** that §7.6 names **do not exist as distinct
> individuals here.** **No independent safety-engineering or release-owner acceptance was obtained,
> simulated or inferred.** §7.3a items 4, 8 and 10 remain formally unsatisfied.

### 7e.1 The decisions

| | Decision | Basis |
|---|---|---|
| **X4** | `STRANDED_SAFE` and `STRANDED_OBSTRUCTING` **are custody-bearing**; `HELD` is lawful while stranded; recovery accounts for it | **The frozen specification already said so.** §4.4's `EN_ROUTE_DROP` row enters a stranded state under the guard **"custody `HELD`"**; §4.4's recovery row makes custody discharge a precondition of terminating a stranded Leg; §4.3 calls stranding *"an agent with goods aboard"*; §18.6 pages a *"custody manifest"*. **A transcription defect, not an open safety question** |
| **X5** | **Terminal deadlock freedom is a genuine §24.2 obligation**; the model is changed to satisfy the check | A **judgement**, recorded as such: §24.2 does not enumerate deadlock freedom. It rests on §4.1 rule 1 + §24.2's *"every non-terminal state eventually leaves"*. **`CHECK_DEADLOCK FALSE` was REJECTED** |

**The executable checker had already been on the decided side of X4.**
`Backend/tests/engine/helpers/lifecycleModel.js:64-72` has listed both stranded states in
`CUSTODY_BEARING` since Phase 15 and records that it found them **by counterexample**. **The two
§24.2 checkers had contradicted each other since Phase 15**; `lifecycle.tla` was the one not updated.

### 7e.2 The model change

| # | Change |
|---|---|
| 1 | `CustodyBearingStates` — **value unchanged**; comment now states it is a **guard** (used by `Dispute` `:223` and `TimerFires` `:333`), not a classification |
| 2 | **NEW** `StrandedLegStates` |
| 3 | **NEW** `CustodyLawfulStates == CustodyBearingStates \cup { "ABORTING" } \cup StrandedLegStates` |
| 4 | `CustodyMatchesState` → `legState[l] \in CustodyLawfulStates` |
| 5 | **NEW** `AllLegsTerminal`, `TaskQuiescent == AllLegsTerminal /\ UNCHANGED vars` |
| 6 | `TaskQuiescent` added to `Next` |

**`CustodyBearingStates` was deliberately NOT widened**, though it is a guard in two actions:
widening it would have made a stranded Leg disputable and let a timer drag it back to `ABORTING`,
contradicting §4.3 — **changing a shipped transition's meaning to make the model pass.**

**`TaskQuiescent` is a stuttering step on `vars`**, so it is not a `<<Next>>_vars` step:
`WF_vars(Next)` is unaffected and it **cannot discharge a liveness obligation.** §7e.5 is the proof.

**No shipped-implementation change was required.** §10.7 of the run record left open whether
`Backend/src/engine/lifecycle/` shared the disagreement. **It does not** —
`transitions.js:499-506` already routes `STRANDED_*` → terminal under `CUSTODY_ACCOUNTED_FOR`.

### 7e.3 After-evidence — the checked-in configurations, same jar, same machine

| Configuration | BEFORE | AFTER |
|---|---|---|
| `lifecycle_c1.cfg` | `Deadlock reached`, depth 6, 79 distinct, **no property reached a verdict** | **Graph CLOSES:** 8 030 / **1 909** / **depth 27** / **0 on queue**. `Safety` **PASS** · `TerminalIsFinal` **PASS** · **`Liveness` FAIL** |
| `lifecycle_c2.cfg` | `Deadlock reached`, depth 6, 277 distinct | 78 471 / 11 886 / depth 16 / 2 474 on queue. **`Liveness` FAIL**; run ends there |
| `lifecycle_c3.cfg` | `Deadlock reached`, depth 6, 1 012 distinct | 66 908 / 9 934 / depth 11 / 3 722 on queue. **`Liveness` FAIL**; run ends there |

**`c2`/`c3` did not complete.** TLC stops at the first temporal violation, so their `Safety` result
is *"no violation found in a partial search"* — **not exhaustive.** Only `c1` closed.

### 7e.4 Secondary diagnostic — `INVARIANT Safety` only

| Configuration | Result |
|---|---|
| c1 (2/1/3) | **Completed. No error.** 8 030 / 1 909 / depth 27 / 0 on queue |
| c2 (3/2/3) | **Completed. No error.** 419 171 / **60 079** / depth 37 / 0 on queue |
| c3 (4/3/3) | **Completed. No error.** **16 557 136 / 1 680 163** / depth 47 / 0 on queue |

> **NOT AUTHORITATIVE.** These use configurations **that are not checked in**, written to a scratch
> directory outside the repository. They have exactly the standing the `-deadlock` runs have.
> **Do not cite them as a result for `lifecycle_c{1,2,3}.cfg`.** Their value: they establish that
> **X4 is fixed exhaustively at all three capacities**, and that **X6 is the only thing left**
> between the lifecycle half and a pass.

### 7e.5 Mutation testing — **4 built, 4 killed** (V-6, "re-run per implementation pass")

| # | Mutation | Actual | Killed |
|---|---|---|---|
| **M1** | Revert **only** the X4 widening | **`Invariant Safety is violated`** — the **original X4 trace**: depth 9, `l1 :> "STRANDED_OBSTRUCTING"` with `custody = "HELD"`, `l2` untouched in `QUEUED` | ✅ |
| **M2** | Remove **only** `TaskQuiescent` | **`Deadlock reached`** returns | ✅ |
| **M3** | `Recovered` no longer accounts for custody | `Invariant Safety is violated` | ✅ |
| **M4** | `Cancel` may carry custody | `Invariant Safety is violated` | ✅ |

**Tree restored and byte-verified** — scratch copy SHA-256 `BA893389ED40…8B59`, identical to the
repository file. No mutant reached the tree.

**M1 and M2 are the load-bearing ones:** M1 proves the **X4** change is what eliminated the X4
counterexample (not a side effect of X5), and M2 proves the **X5** change is what eliminated the
deadlock (not a side effect of X4). **The §10 counterexample is gone for the intended reason.**

### 7e.6 The new finding — **X6**, and it is not a regression

`Liveness` fails at all three capacities. The `c1` counterexample is a lasso on a **closed** graph:
`QUEUED → Plan → PLANNED → Offer → OFFERED → Reject → QUEUED → …` forever at `ticks = 3 = MaxTicks`,
so `l1` never reaches a terminal or stranded state and **`EveryLegSettles` is violated**.
`QueuedLegsProgress` holds; `CustodyNeverLost` is vacuous on the trace.

> **Pre-existing and previously masked.** §7d.4 recorded that **no lifecycle liveness property had
> ever been evaluated by TLC at any capacity.** Fixing X5 did not create X6 — **it made it
> visible**, which is exactly what distinguishes the fix from a `CHECK_DEADLOCK FALSE` that would
> have hidden this too.

Two candidate causes, **deliberately not decided in the pass that found them**: `WF_vars(Next)` is
weak fairness on the whole disjunction; and the module never transcribed §4.4's `QUEUED` → `FAILED`
*"ladder exhausted"* row — **the §17.4 ladder T1-04 shipped on 2026-08-30 has no counterpart in this
model.** Registered as **X6**.

### 7e.7 What did NOT change

| | |
|---|---|
| **`Backend/` — any file** | **Untouched.** Source digest **`d033038cb261c3de…` / 573 — unmoved**, re-computed after the change |
| Any `.cfg`; `CHECK_DEADLOCK` | **Untouched.** `CHECK_DEADLOCK` is still ON in all three lifecycle configurations |
| `commitment.tla`, `commitment_c{1,2,3}.cfg` | **Untouched and NOT re-run.** Still 1 closed / 2 UNKNOWN |
| `establishedByCommand` / `[NOT PROVEN]` / gate algebra | **Intact** |
| `release-evidence.json` | **NOT re-collected**, by instruction. V-5's RED staleness unchanged |
| B1, B8, B-P, B-O, X3, A9, Phase 16 | **Not touched** |
| Build gates | **Re-run: 7 PASS, `gate:composition` FAIL with 1 violation across 19 workers — identical to V-2's pre-existing record** |
| Jest | `lifecycle` / `ModelCheck` / `phase0Scaffold` — **5 suites, 157 tests, all passing** |

> **Why no broader JS re-run was needed.** No JavaScript reads the *contents* of `lifecycle.tla` —
> the only reference anywhere is `phase0Scaffold.test.js` asserting that `commitment.tla` **exists**.
> The digest is byte-identical to the tree V-1 measured green (162 suites / 7 275 tests) and V-2
> measured gates against, so **those results stand unchanged by construction**; the five suites
> above were run anyway as the topically closest.

---

## 7f. The X6 pass — 2026-08-31, third pass

**X6 was investigated before it was touched, classified as a TRANSCRIPTION defect on both counts it
was suspected of, and fixed in `formal/lifecycle.tla` only. `Liveness` still fails — on a new and
different cause, X7.** Full record: [`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md)
**§16**. Same jar (SHA-256 `eabd140a…533a`, re-verified), same JDK 20.0.2, same workstation.

### 7f.1 The trace that decided the classification

| Layer | The §17.4 ladder-exhaustion path |
|---|---|
| Frozen specification | **PRESENT, verbatim** — §4.4 `:1123` `QUEUED \| ladder exhausted \| FAILED`, with its partner row `:1122`; §4.3 `:1041`; §17.4 "finite and terminates in a decision"; §18.4 "a task reaches `FAILED` **only** through the §17.4 ladder"; I13 |
| Shipped implementation | **PRESENT, wired end to end** — `transitions.js:203-217`, `fairness/ladder.js` (T1-04, eight rungs, four verdicts), `expiryActions.js:373-425`, `leaderWorkers.js:416`. **No `Backend/` change was needed and none was made** |
| Executable checker | **Models the transition, does not verify the property.** `lifecycleModel.js` emits `QUEUED--LADDER_EXHAUSTED-->FAILED` from the initial state; its only liveness check is `checkNoDeadEnds`, with no `EveryLegSettles` and no fairness |
| TLA+ module | **ABSENT — both rows.** `TimerFires` had no `QUEUED` case at all |

**Same correspondence failure as X4, and the same rule applies** (`formal/README.md`): the defect is
in whichever checker was not updated — this module.

### 7f.2 Two corrections to §7e.6, without touching its numbers

1. The `c1` counterexample is the **reassignment** lasso `ACCEPTED → REASSIGNING → QUEUED → PLANNED
   → OFFERED → ACCEPTED`, not the `Reject` cycle. (The `Reject` cycle is real; it is just not what
   TLC emitted.) Every unbounded cycle in the model passes through `QUEUED`, which is why one
   ladder addresses all of them.
2. **All three `Liveness` conjuncts failed independently**, not one. §7e.6 records
   `QueuedLegsProgress` as holding and `CustodyNeverLost` as vacuous; checked one at a time on the
   same closed 8 030 / 1 909 graph, **both are violated**.

### 7f.3 The change, and the one judgement in it

`formal/lifecycle.tla` only: a monotone per-Leg `ladder` variable (`0..LadderSteps`, never reset by
any transition into `QUEUED`, not charged against `MaxTicks`), `LadderSteps == 8` as a **definition**
rather than a CONSTANT so no `.cfg` supplies it, the two §4.4 actions `LadderAdvance` and
`LadderExhausted`, and `Fairness == WF_vars(Next) ∧ ∀l : SF_vars(LadderAdvance(l)) ∧ ∀l :
SF_vars(LadderExhausted(l))` — **`WF_vars(Next)` kept, not replaced.**

> **The judgement, named:** strong rather than weak fairness on the two ladder actions. Adding a
> fairness condition assumes more and makes liveness *easier* to satisfy, so it is stated rather
> than buried. Basis: §17.4's "it advances on elapsed SLA budget **regardless of cost dynamics** …
> **No amount of cost arithmetic can prevent it from advancing**", which for a repeatedly-but-not-
> continuously-enabled action is strong fairness. **Weak fairness was measured and is not
> sufficient** (M6). **No independent safety-engineering or release-owner acceptance exists for
> this, and none is claimed.**

### 7f.4 After-evidence

**As checked in:** `lifecycle_c1` `Liveness` VIOLATED (64 835 / 15 486 / depth 14 / 4 260 queued);
`lifecycle_c2` `Liveness` VIOLATED (2 856 353 / 480 326 / depth 16 / 159 266 queued); **`lifecycle_c3`
reached NO VERDICT — it did not converge and was interrupted at a stated budget** after ≈54 minutes,
last progress 16 247 475 / 2 388 556 / depth 15 / **1 014 936 left on queue**, with no violation
reported (§16.5a). **`c3` is UNKNOWN, not FAIL** — the same category `commitment_c2`/`c3` are in.
**All three are partial searches**: TLC stops at the first temporal violation, and where a failing
run stops varies between runs, so **partial counts are not reproducible while closed-graph counts
are** (§16.5).

> **The `c3` non-convergence is arithmetic, not a surprise.** `ladder` multiplies the state space by
> up to `(LadderSteps + 1)^|Legs|` — 81× / 729× / 6 561× at capacity 1 / 2 / 3 — and capacity 1
> confirms it: 1 909 distinct pre-fix → 156 941 after, a factor of 82.2. One periodic liveness
> check over 1 559 707 states took **21 min 19 s**. **`MaxTicks` was not reduced and `LadderSteps`
> was not reduced to make it converge**; that would have been manufacturing a result. What closes
> it is compute — B-M's existing requirement.

**One conjunct at a time, capacity 1, `INVARIANT Safety` + `TerminalIsFinal` retained:**

| Conjunct | Verdict | States / distinct / depth / queue |
|---|---|---|
| **`QueuedLegsProgress`** | **PASS — complete state graph.** `Safety` PASS, `TerminalIsFinal` PASS | 676 854 / 156 941 / 43 / **0** |
| `EveryLegSettles` | VIOLATED — **X7** | 174 320 / 39 036 / 18 / 7 684 |
| `CustodyNeverLost` | VIOLATED — **X7** | 159 731 / 35 834 / 17 / 7 276 |

**This is the first passing lifecycle liveness verdict this project has ever produced — and it is
a CAPACITY-1 result only.** The identical per-conjunct configuration at capacity 2 was run and
**did not converge** (terminated at a 1 500 s budget; last progress 7 809 667 / 1 238 659 / depth 19
/ 358 738 queued). §24.2 makes the configuration under check part of the requirement, so
**`QueuedLegsProgress` passing at capacity 1 does not discharge §24.2's liveness clause** (§16.6a).

**X7 isolated (diagnostic, not checked in, decides nothing):** with the `STRANDED_* → ABORTING` edge
blocked, **every declared property passes exhaustively** — 662 454 / 156 941 / depth 43 / **0 on
queue**. X7 is therefore the sole remaining cause of the lifecycle `Liveness` failure.

**Question E, measured:** a diagnostic property transcribing §24.2's *literal, weaker* clause
"every non-terminal state eventually leaves" is **also violated** (20 355 / 5 405). So weakening
`EveryLegSettles` to the specification's own wording would not produce a pass. **It was not
weakened.**

### 7f.5 Mutation testing — **7 built, 7 killed** (V-6, "re-run per implementation pass")

M3 (remove `LadderExhausted`) → `QueuedLegsProgress` violated. M4 (drop its `QUEUED` guard) →
`TerminalIsFinal` violated. M5 (target `"QUEUED"` not `"FAILED"`) → `QueuedLegsProgress` violated.
M7 (remove `LadderAdvance`) → `QueuedLegsProgress` violated, **and the graph collapses to exactly
the pre-X6 8 030 / 1 909 / depth 27**. M6 (`SF`→`WF`) → survives the `QueuedLegsProgress` oracle,
**killed** under the X7-isolated `Liveness` oracle — recorded honestly, and it is the measurement
behind §7f.3. **M1 (revert only the X4 widening) → `Invariant Safety is violated`** and **M2 (remove
only `TaskQuiescent`) → `Deadlock reached`**, so both previously decided changes are still
load-bearing.

### 7f.6 The new finding — **X7**, and it is a specification ambiguity, not a defect to fix

`STRANDED_* --CancelWithCustody--> ABORTING --Strand--> STRANDED_*` cycles for ever holding custody
`HELD`. §4.4 `:1145`'s cancel row says "any non-terminal" and `STRANDED_*` is non-terminal; §4.4's
stranded rows `:1147`–`:1149` enumerate exits that do **not** include `ABORTING`; §4.3 gives
`STRANDED_*` an on-expiry action of "page operations", not a transition; and §24.2 `:5216` states
the custody clause **unconditionally**, under *Safety*. **Three defensible readings, each producing
a different model. Reported and left open** — `PHASE_15_BLOCKERS.md` § **X7**.

### 7f.7 What did NOT change

| | |
|---|---|
| **`Backend/` — any file** | **Untouched.** Source digest re-computed after the change |
| Any `.cfg`; `CHECK_DEADLOCK` | **Untouched.** `CHECK_DEADLOCK` still ON in all three lifecycle configurations; X5's `TaskQuiescent` solution still in force |
| `commitment.tla`, `commitment_c{1,2,3}.cfg` | **Untouched and NOT re-run — scope decision stated in §16.9.** `commitment.tla` neither `EXTENDS` nor `INSTANCE`s `lifecycle.tla` and no `.cfg` changed, so no commitment result can be affected. Still 1 closed / 2 UNKNOWN |
| `EveryLegSettles`; fairness on anything but the two ladder actions | **Not weakened, not removed, not broadened** |
| The residual `REASSIGNING` model/checker divergence | **Deliberately preserved.** The specification does not require it as part of X6 |
| `establishedByCommand` / `[NOT PROVEN]` / gate algebra | **Intact** |
| `release-evidence.json` | **NOT re-collected**, by instruction. V-5's RED staleness unchanged |
| B1, B8, B-P, B-O, X3, A9, Phase 16 | **Not touched.** No previous commit amended |
| Source digest | **`d033038cb261c3de…` / 573 — re-computed after the change and UNMOVED**, as expected: `formal/` is outside the digest scope and no `Backend/` file was edited |
| Build gates | **Re-run: 7 PASS, `gate:composition` FAIL with 1 violation across 19 registered workers** (`coordinator`, `LEADER_ONLY_NOT_COMPOSABLE`, blocked on B1) — **identical to the pre-existing V-2 record.** No gate moved |
| Jest | `lifecycle` / `ModelCheck` / `phase0Scaffold` / `fairnessLadder` / `supervisionExpiryActions` — **7 suites, 295 tests, all passing** |
| TLC working-tree artefacts | Running TLC from inside `formal/` writes `*_TTrace_*.tla`/`.bin` and a `states/` directory, and **`.gitignore` covers none of them**. **Deleted before commit; `git status` verified clean of them.** §15's runs did not hit this because they ran from a scratch copy |

> **Why no broader JS re-run was needed, restated for this pass.** No JavaScript reads the
> *contents* of `lifecycle.tla`; the only reference anywhere is `phase0Scaffold.test.js` asserting
> that `commitment.tla` **exists**. The digest is byte-identical to the tree V-1 measured green, so
> those results stand unchanged by construction. The five suites above were run anyway as the
> topically closest — and `fairnessLadder` and `supervisionExpiryActions` were added to that set on
> purpose this time, because they are the shipped modules the X6 investigation asserted were
> already correct.

---

## 7g. The X7 pass — 2026-09-01, fourth pass

**X7 was re-investigated before it was touched, RECLASSIFIED from a specification ambiguity to a
TRANSCRIPTION defect, and fixed in `formal/lifecycle.tla` only. `lifecycle_c1` now passes on a
complete state graph with every declared property, and no new blocker was opened.** Full record:
[`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md) **§17**. Same jar (SHA-256
`eabd140a…533a`, re-verified by `sha256sum` immediately before the run), same JDK 20.0.2, same
workstation, same flags as §12.4's primary run.

### 7g.1 The trace that decided the classification

| Layer | §4.6's `cancel_requested_at` cancellation latch |
|---|---|
| Frozen specification | **PRESENT, verbatim** — §4.6 step 1 `:1185` "writes `cancel_requested_at` and increments the version in a transaction"; step 2 `:1190` guards every subsequent transition on it; **no clearing rule anywhere**; step 5 `:1228` forbids a requester cancelling a `RECOVERY`/`TRANSFER` Leg at all |
| Shipped implementation | **PRESENT, wired end to end** — `lifecycle/cancellation.js:119-130` writes `cancelRequestedAt` in a **version-conditional** `updateMany` (a lost race returns `LOST_RACE`, not a second write); `lifecycle/transitions.js:664-669` `cancellationGuard` reads it; `cancellation.js:101-116` refuses a terminal Leg and a requester-cancelled custodial Leg. **Nothing in `Backend/src/` clears it** — the only `cancelRequestedAt: null` is `domain/mappers/legacyTask.js:139`, constructing a fresh Leg at `version: 0`. **No `Backend/` change was needed and none was made** |
| Executable checker | **PERMISSIVE — records as a separate observation.** `tests/engine/helpers/lifecycleModel.js:347-353` applies `cancellationGuard` to every event **except `CANCEL_REQUEST` itself**, so it still admits a repeated cancellation request the shipped engine refuses. **No test was changed** |
| TLA+ module | **ABSENT.** `cancel_requested_at` was not modelled at all, so `Cancel` and `CancelWithCustody` were indefinitely repeatable |

**Same correspondence failure as X4 and X6, and the same rule applies** (`formal/README.md`): the
defect is in whichever checker was not updated — this module. The shipped system forbids the X7
cycle **through the latch**, not through any `STRANDED_*`-specific rule.

### 7g.2 The correction to §7f.4 / §16.9's framing of X7

§7f and the original X7 entry framed X7 as a genuine ambiguity about whether §4.4's "any
non-terminal" cancel row governs a `STRANDED_*` Leg, with three candidate readings. **The cycle they
describe is real and was reproduced. Their diagnosis of its cause is superseded.** The defect is one
layer earlier — the missing latch — and **none of the three readings had to be chosen** to fix it.
**Their numbers are not touched.**

### 7g.3 The controlled D3 → D6 experiment

D1/D2 reproduced the previous graph exactly, confirming the scratchpad copy faithful.

| | Variant | Result |
|---|---|---|
| **D3** | pristine `Spec`, 1 Leg | `Liveness` **VIOLATED** — `CancelWithCustody ↔ Strand` lasso |
| **D4** | add **only** the §4.6 latch | `Safety` + `TerminalIsFinal` + `Liveness` **PASS** |
| **D5** | D4 at the `c1` shape | **COMPLETE graph, PASS** — 777 942 / 187 289 / depth 43 / **0 on queue** |
| **D6** | remove **only** the latch guard | `Liveness` **VIOLATED** — mutant killed |

**D4 is the load-bearing row:** the latch alone, with no `STRANDED_*` rule, no fairness on
`Recovered` and no weakened property, discharges every declared property.

### 7g.4 After-evidence — `lifecycle_c1.cfg` AS CHECKED IN

`Legs = {l1,l2}` · `Capacity = 1` · `MaxTicks = 3`, from the **unmodified** config
(SHA-256 `ff9d3cda…1cf8`, `IDENTICAL-TO-HEAD`) against the changed module
(SHA-256 `13b8edd8…b8b1`):

| | |
|---|---|
| States generated / distinct | **777 942 / 187 289** |
| Depth / queue / closed? | **43 / 0 / YES — exhaustive** |
| Wall time / exit code | **03 min 47 s (TLC), 229 s (harness) / 0** |
| Terminating line | `Model checking completed. No error has been found.` |
| `INVARIANT Safety` | **PASS** |
| `PROPERTY TerminalIsFinal` | **PASS** |
| `Liveness` → `EveryLegSettles` | **PASS** — *was VIOLATED (X7)* |
| `Liveness` → `CustodyNeverLost` | **PASS** — *was VIOLATED (X7)* |
| `Liveness` → `QueuedLegsProgress` | **PASS** — unchanged from §7f |
| Deadlock (TLC default, ON) | **PASS** — none reported |

**Reproduces D5 exactly. The X7 lasso is gone.**

### 7g.5 Mutation — 1 built, 1 killed; the repository was not modified for it

The minimal X7 mutation — remove **only** the two new latch-**guard** conjuncts
(`/\ ~cancelRequested[l]`), leaving the variable, its `Init`, its writes and all 31 `UNCHANGED`
tuples intact — built in the session scratch location. `diff` against the repository file showed
**exactly two removed lines and nothing else**, and `git status --porcelain` reported
`M formal/lifecycle.tla` and nothing else throughout.

**KILLED.** Exit **13**, `Error: Temporal property Liveness was violated`, 96 961 / 22 606 / depth
16 / 5 720 left on queue (partial, as expected at a violation). The counterexample is the X7 lasso
verbatim: `State 14 <CancelWithCustody(l1)> → State 15 <Strand(l1,"BLOCKING_CRITICAL")> → Back to
state 14`, with `custody = (l1 :> "HELD" @@ l2 :> "NONE")` at every state and
`cancelRequested = (l1 :> TRUE @@ l2 :> FALSE)` — **the latch set and being ignored**, which is
exactly the ability the mutation removes. **Behaved as expected; creates no new repository
blocker.**

### 7g.6 What this pass did NOT touch

| | |
|---|---|
| Any `Backend/` file | **Untouched.** `git diff --name-only -- Backend/` empty |
| Any test, including `lifecycleModel.js` | **Untouched.** Its permissive `CANCEL_REQUEST` exemption is **recorded, not fixed** |
| Any `.cfg`; `CHECK_DEADLOCK` | **Untouched.** All six reported `IDENTICAL-TO-HEAD`; `CHECK_DEADLOCK FALSE` still absent, deadlock checking ran at TLC's default and passed; no `-deadlock` flag was passed |
| The frozen specification; any ADR | **Untouched** |
| `EveryLegSettles`, `CustodyNeverLost`, `QueuedLegsProgress`, `Liveness`, `TerminalIsFinal`, `CustodyMatchesState`, `Next`, `Spec`, `Fairness`, `TaskQuiescent`, `AllLegsTerminal`, `CustodyLawfulStates` | **BYTE-IDENTICAL**, proven by extracting each from `git show HEAD:formal/lifecycle.tla` and from the working tree and comparing. **X4/X5/X6 modelling intact** |
| Fairness on `Recovered`; any `STRANDED_*` special case; any boundedness, timeout or artificial-progress constant | **NOT ADDED** |
| `commitment.tla`, `commitment_c{1,2,3}.cfg` | **Untouched and NOT re-run — deliberately.** `commitment.tla` neither `EXTENDS` nor `INSTANCE`s `lifecycle.tla` and no `.cfg` changed, so no commitment result can be affected. Still 1 PASS / 2 UNKNOWN |
| `lifecycle_c2`, `lifecycle_c3` | **NOT run by this pass.** Still require authoritative treatment |
| Question A (`STRANDED_*` cancellability) | **Open, non-blocking, deliberately NOT resolved** |
| `establishedByCommand` / `[NOT PROVEN]` / gate algebra | **Intact** |
| `release-evidence.json` | **NOT re-collected**, by instruction. V-5's RED staleness unchanged |
| B1, B8, B-P, B-O, X3, A9, Phase 16 | **Not touched.** No previous commit amended |
| TLC working-tree artefacts | **None left.** `-noTE` suppressed the `*_TTrace_*.tla`, and `-metadir` sent `states/` to the scratch location. `git status --porcelain` verified clean of them |

### 7g.7 B-M after this pass — **STILL OPEN**

**`lifecycle_c1` passing is one configuration of six, and X7 closing is not B-M closing.**

| Configuration | State |
|---|---|
| `commitment_c1` | **PASS** — exhaustive, unchanged, not re-run |
| `commitment_c2` | **UNKNOWN** — did not converge; deliberately unaffected |
| `commitment_c3` | **UNKNOWN** — did not converge; deliberately unaffected |
| **`lifecycle_c1`** | **PASS — NEW.** Complete graph, every declared property |
| `lifecycle_c2` | **Still requires authoritative treatment** |
| `lifecycle_c3` | **Still requires authoritative treatment** |

**2 of 6 configurations now close, was 1.** §7.3a items **4** (named operator), **8** (boundedness
acceptance) and **10** (final acceptance) remain **unsatisfied**, and **G5 is still covered by no
TLC run**. **B-M = NOT MEASURED / OPEN.** The §24 gate `model_check_capacity_1_2_3` renders exactly
as before and **did not move**. **No independent safety-engineering or release-owner acceptance
exists for X7, and none is claimed.**

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

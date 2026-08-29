# Phase 15 — Verification State

**What has actually been proven, and against which tree.**

> Current source of truth for navigation and verdict: **[`PHASE_15_MASTER.md`](PHASE_15_MASTER.md)**.

---

## 0. The tree every result below refers to

| | |
|---|---|
| Date of execution | **2026-08-29** (consolidation) · **re-executed 2026-08-29** (documentation-integrity audit) |
| Branch | `feature/dashboard` |
| HEAD | `b68dc5d8653b6b9f435b29b21a70775e1dcd4d45` |
| Working tree | **Documentation-only modifications, uncommitted.** `git status --porcelain` is *not* empty: it shows the five files in `docs/phase15/`, `archive/README.md`, and pointer/fact corrections in `ARCHITECTURE.md`, `README.md`, `ROBOTX_SYSTEM_HANDBOOK.md`, `docs/history/README.md`. **Every one is outside the source-digest scope**, so the digest below is byte-identical before and after. No file under `Backend/{src,tools,tests}`, `prisma/`, `formal/` or `.github/` was modified — re-confirmed by `git diff --name-status` after the audit |
| **Source digest** | **`431010ace188c4b1b91415821e8cebc7beeb8f3f378a1b39fb77986fb3b22470`** (565 files) |
| Node | v22.x · Windows 11 · the build machine — **not representative production hardware** |

**Rule for this document.** No result is recorded here unless it was executed on this tree, by this
consolidation, and its exit code observed. Nothing is inherited from an archived report. Anything
not executed is in §5 under **NOT CURRENTLY VERIFIED** and is labelled as such — never as a pass.

Digest verification command:
```
cd Backend && node -e "console.log(JSON.stringify(require('./tools/release/sourceDigest.js').sourceDigest()))"
→ {"digest":"431010ace188c4b1b91415821e8cebc7beeb8f3f378a1b39fb77986fb3b22470","fileCount":565}
```

---

## 1. Test suite

**Command:** `npm test` (from `Backend/`; = `jest --runInBand --forceExit`, all five projects)
**Result:** `Test Suites: 160 passed, 160 total` · `Tests: 7162 passed, 7162 total` · `Snapshots: 0` · `Time: 501.91 s`
**Exit code:** `0`
**Date:** 2026-08-29
**Repository state:** digest `431010ace1…`, HEAD `b68dc5d`, clean
**Meaning:** every test in the repository passes. 0 failures, 0 skips.
**Blocking:** No — but a green suite is **not** a Phase 15 closure condition. Six adversarial passes
each found defects while this suite was green.
**Evidence location:** re-runnable; not archived as a file.

---

## 2. Build gates

**Command:** `npm run gates`
**Exit code:** `1`
**Date:** 2026-08-29 · **Tree:** digest `431010ace1…`

| Gate | Command | Result |
|---|---|---|
| tier-dependencies (§1.8 rule 2) | `gate:tiers` | **PASS** — 285 modules, 423 governed import edges, no Tier 0/1 → Tier 2 dependency |
| parameter-register (§22, App. A) | `gate:params` | **PASS** — 189 engine modules vs 242 registered parameters; no bare behavioural constants |
| tenets (T1, T6) | `gate:tenets` | **PASS** — 282 modules, no violations |
| identity-isolation (§23.7) | `gate:privacy` | **PASS** — 16 modules; no identifying field, no street address as a cost input |
| erasure reconstruction-equivalence (§23.7, §24.3) | `gate:erasure` | **PASS** — 3 corpus decisions, reconstruction byte-for-byte from Tier A alone |
| legacy-retirement (Phase 15) | `gate:legacy` | **PASS** — 4 retired modules absent and unimported across 340 files |
| column-generation (§21.6) | `gate:columngen` | **PASS — NOT_REQUIRED** (0 paths in change set; the gate does not apply) |
| **composition-root (Phase 15)** | `gate:composition` | **FAIL — exit 1.** 1 violation across 18 registered workers |

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

**Command:** `npm run gate:calibration` · **Exit:** `1` · **Date:** 2026-08-29 · **Tree:** `431010ace1…`
**Result:** `FAIL — 39 blocking finding(s).` `242 entr(ies): 52 DERIVED, 152 PROVISIONAL, 38 UNCALIBRATED. 54 are Safety-class.`
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

**Command:** `npm run sim:fidelity` · **Exit:** `1` · **Date:** 2026-08-29 · **Tree:** `431010ace1…`
**Result:** all **7** models `NOT_MEASURED` — `TRAVEL_TIME`(S), `SERVICE_TIME`,
`ENERGY_CONSUMPTION`(S), `CHARGE_DURATION`(S), `FAILURE_RATE`(S), `INTERVENTION_RATE`(S),
`DISCONNECT_RATE`(S). **6 safety-relevant.** No study was supplied (`--input <file.json>`).
**Meaning:** the simulator **may not discharge a Tier 0 verification obligation** (§24.4, §1.8).
An absent study is a standing finding, not a pass.
**Blocking:** Yes — §24 gate `simulator_fidelity`, blocker **B-P**.

### 4.4 Safety case

**Command:** `npm run safety:case` · **Exit:** `0` · **Date:** 2026-08-29 · **Tree:** `431010ace1…`
**Result:** `12 hazard(s) assembled from 38 predicates and 22 invariants` · written to
`docs/safety-case/SAFETY_CASE.md` · `PASS — every reference resolves`.
Regeneration produced a **byte-identical** file (`git status` clean afterwards) — the checked-in
artefact is current.
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
failed, 0 rolled back** → 74 domain tables + `_prisma_migrations` (75 base tables total).

| Harness | Command | Result | Exit | Date |
|---|---|---|---|---|
| Phase 15 live DB | `node tools/verify/phase15LiveDatabase.js` | **12 / 12 passed** | 0 | 2026-08-29 |
| Phase 15 current tree | `node tools/verify/phase15CurrentTree.js` | **32 / 32 passed** | 0 | 2026-08-29 |
| Phase 15 evidence binding | `node tools/verify/phase15EvidenceBinding.js` | **17 / 17 passed** | 0 | 2026-08-29 |
| Phase 15 version in force | `node tools/verify/phase15VersionInForce.js` | **19 / 19 passed** | 0 | 2026-08-29 |
| | | **80 / 80** | | |

Each harness cleans up every row it creates (`Z1 — clean`, observed in all four).

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

Each confirmed by direct inspection on 2026-08-29 at digest `431010ace1…`:

| Claim | Method | Result |
|---|---|---|
| Source digest and file count | `sourceDigest()` | `431010ace1…`, 565 files |
| 18 workers registered | `require('./src/workers/registry.js').WORKERS.length` | 18 |
| **Worker readiness split** | `registry.report({running:[]})` | **8 `SCHEDULED` · 4 `LEADER_ONLY` · 6 `DEFERRED`** — so **11 workers actually start** (8 + 3, `coordinator` refused). Re-verified by the audit, 2026-08-29 |
| **`leaderWorkers.UNCOMPOSABLE`** | `Object.keys(...)` | exactly `["coordinator"]`; `COMPOSERS` covers all four `LEADER_ONLY` workers |
| **`src/workers/` file count** | `ls src/workers/*.js` | **20** — 18 `*.worker.js` + `registry.js` + `leaderWorkers.js`. **Not 19** |
| **§24 gate table size** | `RELEASE_GATES.length`; `blockers({}).length` | **24** and **24**. Every row `blocking: true` |
| 27 Prisma migrations | `ls prisma/migrations` minus `migration_lock.toml` | 27 |
| Release evidence bound to this tree | JSON inspection | 17 records, 0 unbound, 0 VOID |
| `tla2tools.jar` absent | repo-wide `find -name "tla2tools*"` | **absent** |
| `src/engine/fairness/` T1-04 modules absent | `ls` | directory exists, **empty** |
| `src/engine/lifecycle/preemption.js` absent | `ls` | absent |
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
| **Mutation testing** | Deliberately not re-run. Mutation requires editing source and restoring it; this is a documentation-only operation and Step 15's rules forbid modifying application source | Archived third-pass report claims 8 distinct mutants across three concurrent sessions, all killed, tree restored SHA-256-identical. **UNVERIFIED HERE.** |
| **TLC exhaustive model checking** | `tla2tools.jar` is absent — it is not runnable on this tree at all | Never run by any pass. This is blocker **B-M** |
| **Phase 0–14 cross-phase re-verification** | Out of scope for a Phase 15 consolidation; `npm test` covers the suites but not the per-phase live-DB harnesses | Archived report claims Phases 0–14, schema and migration history untouched. **UNVERIFIED HERE** |
| **Phase 5 live harnesses** (`phase5ExpirySemantics.js`, `phase5LiveDatabase.js`) | Out of Phase 15 scope | Archived claim: 102/102 and 106/106, total 288/288 with the Phase 15 four. **UNVERIFIED HERE** — this consolidation verified only the Phase 15 80/80 |
| **`npm run release:gates`** (`--collect`) | Would re-run and overwrite `docs/release-evidence.json`, a ~25-minute serial collection; the checked-in artefact is already bound to this exact digest and 0 records are VOID, so re-collection would add nothing | The checked-in collection **is** current-tree evidence |
| **Soak / shadow-agreement / invariant observation windows** | Require an operating fleet. Cannot be run here. **Must not be simulated** | Blocker **B-P** |
| **Rollback rehearsal** | Requires a declared non-production environment and a named operator. **Must not be fabricated** | Blocker **B-O** |
| **`docs/runbooks/rollback.md` procedure vs the current API** | No pass has ever executed it. This is the exposure named as **P15-F7a** | **UNKNOWN.** Not a known defect — an unexamined surface |
| **Soak duration / scale numbers on production hardware** | The build machine is a Windows 11 laptop, explicitly not representative production hardware | Scale suite passes in-lane; that is a lane result, not a production measurement |

---

## 8. Verification integrity notes

1. **The tree did not change during verification.** `git status --porcelain` was empty before the
   first command and after the last. `npm run safety:case` regenerates
   `docs/safety-case/SAFETY_CASE.md` in place and produced a byte-identical file.
2. **No test was modified** to obtain any result above.
3. **No threshold, gate or configuration was changed** to obtain any result above.
4. **Exit codes were captured from the command, not from a pipe.** Where output was piped to
   `tail`, `${PIPESTATUS[0]}` was used, and `gate:composition`'s exit was additionally confirmed in
   isolation.
5. **Two exit codes are counter-intuitive and are called out where they appear:**
   `routing:readiness` exits **0** while reporting `BLOCKED` (by design), and
   `model_check_capacity_1_2_3` is **GREEN** while carrying `[NOT PROVEN]` (by design, so the gap
   is visible rather than silent).

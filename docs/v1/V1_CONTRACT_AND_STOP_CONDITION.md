# V1 — CONTRACT, CLASSIFICATION, AND FINITE STOP CONDITION

**Audit date:** 2026-09-01 · **Branch:** `feature/dashboard` · **HEAD at audit start:** `09e91a5`
**Source digest at audit start:** `d033038cb261c3de0efe13796af9aa26d190ea113a5a2bfe5971480f72bdca00`
(**573 files**) — measured live.

> **CURRENT STATE — last execution pass 2026-09-04 (E-9, the composition).**
> **digest `22afc5b1a83634899ad5dce7ccedad6f779afc085ca939f8f9e0c40bc28aead6` / 580 files** ·
> `npm test` **166 suites / 7 379 tests / 0 failures** · `npm run gates` **7 PASS / 1 FAIL**
> (`gate:composition`) · `routing:readiness` **BLOCKED**.
>
> **V1 STATUS: BLOCKED — at an owner/external boundary, not at repository-owned work.**
> Stop conditions **S-1, S-2, S-8 met**; **S-3 open** (§K, and **materially larger than §K
> records — see §L**); S-4, S-6, S-7 are consequences of it; S-5 is an owner configuration act
> whose mechanism is implemented and **verified live**.
>
> **The composition root now exists.** `Backend/src/workers/coordinatorSolvePath.js` assembles
> the coordinator's solve path from the shipped modules; `COMPOSERS.coordinator` calls it and
> starts the worker when every declared input resolves. **§L is this pass**, and it corrects
> §K, §D.3 and §F.0 with measurements the code produces. **Section K remains the shape of the
> owner request; §L.2 is its corrected content.** Sections A–J are the audit as written on
> 2026-09-01, with each later pass's corrections recorded beside the text they correct rather
> than over it.

> **What this document is.** The first V1/V2 boundary this repository has ever had. Before it, no
> V1 stop condition existed anywhere in the tree — a search of every `.md` found none. The
> programme's only exit condition was Phase 15's §24 gate table, which is a **production release**
> condition, and conflating the two is why "what remains" has read as unbounded for six passes.
>
> **What this document is not.** It does not weaken, reclassify, or set aside a single §24 gate.
> Phase 15's verdict is unchanged: **IMPLEMENTATION CLOSED · RELEASE BLOCKED**. V1 is a *smaller*
> milestone that sits below it, not an alternative route through it.

---

## SECTION A — CURRENT REPOSITORY STATE (measured, not inherited)

Every row below was executed against this tree on 2026-09-01. Nothing is quoted from a document.

| Quantity | Measured value | Command |
|---|---|---|
| HEAD | **`09e91a5`** "spec(phase15): close X6 as a TLA+ transcription defect; open X7" | `git log -1` |
| Working tree | **NOT clean.** 6 modified `docs/phase15/*.md`, **`formal/README.md`**, **`formal/lifecycle.tla`**, 1 untracked PDF | `git status --short` |
| Source digest | `d033038cb261c3de…` / **573 files** | `sourceDigest()` |
| `npm test` | **exit 0 — 162 suites / 7 275 tests / 0 failures / 0 skips**, 343.8 s | `npm test` |
| `npm run gates` | **exit 1 — 7 PASS, 1 FAIL** (`gate:composition`) | `npm run gates` |
| `gate:composition` | **1 violation across 19 registered workers** — `coordinator`, `LEADER_ONLY_NOT_COMPOSABLE` | `npm run gates` |
| `gate:legacy` | PASS — 4 retired modules absent across **346** files | `npm run gates` |
| `gate:calibration` | **exit 1 — 39 blocking findings; 250 entries (52 DERIVED / 160 PROVISIONAL / 38 UNCALIBRATED); 54 Safety-class** | `npm run gate:calibration` |
| `routing:readiness` | **OVERALL: BLOCKED** — D1, D3, D8 all BLOCKED; exit 0 by design | `npm run routing:readiness` |
| Workers | **19 registered · 9 `SCHEDULED` · 4 `LEADER_ONLY` · 6 `DEFERRED`** → **12 start** | `registry.report({running:[]})` |
| Prisma migrations | **28** | direct count |
| `cutover.engine_enabled` | default **`false`**, `STRUCTURAL`, `DERIVED`, scopes `global`/`region` | register read |
| Formal tree | `commitment.tla`, `lifecycle.tla`, **6** `.cfg`, `README.md`. No `CHECK_DEADLOCK` in any `.cfg` | direct read |
| `formal/lifecycle.tla` | **modified and uncommitted** — adds the §4.6 `cancelRequested` latch (X7 fix), 96 insertions / 31 deletions | `git diff` |

**Every current-state number in the canonical documents that I re-measured was correct** — digest,
file count, worker counts, migration count, test counts, calibration counts, gate outputs, routing
readiness. The staleness this audit found is confined to **git identity** and to **three X6/X7
status rows**, listed in Section B.

---

## SECTION B — DOCUMENT CURRENCY AUDIT

Classification key: **A** Current · **B** Historical (retain) · **C** Stale/incorrect · **D**
Superseded and correctly labelled · **E** Non-issue (looks old, preserved by the evidence rules).

### B.1 Findings requiring action

| Document | Section / claim | Class | Required action | Why |
|---|---|---|---|---|
| `PHASE_15_MASTER.md` | L135, L259 — **"HEAD: `7335260`"** | **C** | Update to `09e91a5` (and to the X7 commit once made) | Three commits have landed since `7335260`: `ef0d65f`, `22411e8`, `09e91a5`. The row presents an old identity as current |
| `PHASE_15_MASTER.md` | L136, L260 — **"the only modified paths are these five canonical documents"** | **C** | Correct: **six** `docs/phase15/` documents **plus `formal/README.md` and `formal/lifecycle.tla`** | `formal/` is outside the digest scope, so the digest claim stays true — but "no non-`docs/` path is modified" is now false, and `lifecycle.tla` is the X7 fix itself |
| `PHASE_15_MASTER.md` | L369–380 blocker table — **`X6` row still reads "new 2026-08-31 … OPEN … deliberately not decided"** | **C** | Strike through and mark **CLOSED 2026-08-31**, as X4/X5 already are | The same document's §7 arithmetic (L340–344) and its header both say X6 is closed, and the open set it prints (`B1, B8, B-P, B-O, B-M, X3, A9`) excludes it. The table contradicts its own file |
| `PHASE_15_MASTER.md` | L350–359 blockquote — "**X7 is a genuine specification ambiguity** … the reason the lifecycle half of B-M still does not pass" | **C** | Mark superseded by the X7 pass | X7 was reclassified to a transcription defect and closed. This paragraph is the X6 pass's text left unswept |
| `PHASE_15_MASTER.md` | §9 item 5, L492/L496 — "**X6** … must be decided before the lifecycle half can pass" | **C** | Replace with: X4–X7 all closed; **B-M is blocked on compute and acceptance, not on any open model defect** | The CLOSURE_CHECKLIST V-7 row already says exactly this. MASTER §9 does not |
| `PHASE_15_CLOSURE_CHECKLIST.md` | L361 — "X3 and **X6** require specification or formal-verification decisions" | **C** | Replace `X6` with nothing; X3 alone remains | X6 closed 2026-08-31; the same file's V-7 row says so |
| `PHASE_15_IMPLEMENTATION_STATE.md` | L9, L21 — HEAD `7335260`, "no application source modified" | **C** | Same correction as MASTER | Same cause |
| `PHASE_15_BLOCKERS.md` L9 · `PHASE_15_CLOSURE_CHECKLIST.md` L10 · `B1_EXTERNAL_INPUT_HANDOFF.md` L13 | HEAD `7335260` | **C** | Same correction | Same cause |
| `src/workers/registry.js` | `cadenceParameter` on **11 of 19** rows names a register entry **that does not exist** | **C** | Correct each row to the parameter actually read, or mark it `@structural` with the reason | This is **N13**, measured live below. It is a false claim published by code, not by prose |

### B.2 Correct as written — no action

| Document | Basis |
|---|---|
| `PHASE_15_MASTER.md` §4 — digest, file count, worker counts, migrations, gate counts | **All re-measured and correct** |
| `PHASE_15_MASTER.md` §6 — every verification row | `npm test` 162/7 275, gates 7/1, calibration 250/39/54, routing BLOCKED: **all reproduced** |
| `PHASE_15_MASTER.md` §10 — forbidden actions | Every row is a live constraint. **This audit obeys all of them** |
| `PHASE_15_IMPLEMENTATION_STATE.md` — "Explicitly NOT implemented" table | Verified by filesystem: `stores/`, `deps/`, `routing/client.js`, `tla2tools.jar` all absent as stated |
| `PHASE_15_CLOSURE_CHECKLIST.md` §B — the §24 gate table | Unchanged; not re-collected, and correctly labelled as the on-merits reading |
| `B1_EXTERNAL_INPUT_HANDOFF.md` §0.1 — "`routing:readiness` can never print PASS, and always exits 0" | **Reproduced exactly.** Not a defect |
| `B1_EXTERNAL_INPUT_HANDOFF.md` §1.8 — the D1 owner decisions and the V-8 finding | Consistent with `RD-2026-08-30-01`; the governance vacuum is real |
| `PHASE_15_BM_TLC_RUN_RECORD.md` §17 | The `lifecycle.tla` diff in the working tree **is** the described latch; the `.cfg` files are unmodified; `CHECK_DEADLOCK` is absent everywhere |

### B.3 Historical — must NOT be rewritten

| Material | Why it stays |
|---|---|
| `docs/phase15/archive/` — 15 superseded reports | Preserved byte-for-byte by declared policy (`PHASE_15_MASTER.md` §12). Several contain a later pass's correction *of* an earlier pass; that correction history **is** the evidence |
| Root `PHASE_0..14_*.md` (46 files) | Per-phase historical record. Their numbers describe trees that no longer exist and are not current-state claims |
| The "X7 — the original entry, retained verbatim below" block in `PHASE_15_BLOCKERS.md` | Explicitly retained by the register's own convention: *a correction belongs beside the record, not on top of it* |
| Every `*(this row said …)*` parenthetical throughout the canonical set | These are the project's staleness-attribution mechanism. Removing them would make future drift undetectable |
| `docs/history/`, `docs/release-decisions/RD-*` | Signed decision records. Immutable |

### B.4 Known, registered, *not* Phase 15's — leave in place

`ARCHITECTURE.md` and `ROBOTX_SYSTEM_HANDBOOK.md` carry engine-module counts, suite/test counts,
"7 build gates / 23 release gates" phrasing, and the CI omission, all of which disagree with the
current tree. `PHASE_15_MASTER.md` §7.1 already registers these as **cross-phase drift Phase 15
does not own**, with file and line. **Class E — deliberately preserved, not corrected here.**
This audit adds nothing to that register and removes nothing from it.

---

## SECTION C — RECONCILIATION OF THE PREVIOUS AUDIT

Each of the six findings, independently re-derived against this tree.

### C.1 — `leaderWorkers.js:151` / `UNCOMPOSABLE.coordinator` — **CONFIRMED, and understated**

**Reproduced.** `gate:composition` prints the violation verbatim. `COMPOSERS.coordinator()` at
[`leaderWorkers.js:321-323`](../../Backend/src/workers/leaderWorkers.js#L321-L323) returns
`{ ok: false, ...UNCOMPOSABLE.coordinator }` — **unconditionally.** It performs no dependency
check; supplying a `route` function to the composition root today would change nothing.

**But the previous audit's cause is incomplete.** It reported the blocker as "`source.route` does
not exist". The deeper fact, which the repository states in its own words at
[`phase9ProductionPath.js:19-21`](../../Backend/tools/verify/phase9ProductionPath.js#L19-L21):

> *"`workers/coordinator.worker.js` (which would call `candidates/expansion.expandCandidates`) is
> `LEADER_ONLY` … and **nothing in this process constructs its solve path**."*

Verified by search: `evaluateExact`, `expandCandidates` and `pricedCandidateFor` are constructed
**only in tests**. There is no partially-built production factory. So the coordinator is blocked by
**two** independent things, and only one of them is external:

| | Blocker | Owner |
|---|---|---|
| 1 | No `route(parts)` source, no `travelSdSeconds` source, no per-profile `speedMetresPerSecond` | **External** (owner decision) |
| 2 | **The composition-root assembly that would build `expandCandidates` / `pricedCandidateFor` / `expansionInputFor` does not exist as code** | **Repository** |

**Classification: V1 — core path. Blocker 1 is V1-EXTERNAL-INPUT; blocker 2 is V1-MUST-FIX but is
gated on blocker 1**, because writing it now produces an assembly with nothing to inject.

### C.2 — `service.defaultSnapshot()` returning `spatial: null, shards: null, bindings: {}` — **DISPROVED as a defect**

Three independent facts refute it:

1. **`defaultSnapshot()` is a boot fallback, not what a running server serves.**
   [`app.js:25`](../../Backend/src/app.js#L25) assigns it at module load *"with no database and no
   cache"*; [`server.js:421`](../../Backend/server.js#L421) then **replaces** it with
   `configService.bootstrap(...)`, and [`server.js:447`](../../Backend/server.js#L447) keeps it
   current through the configuration pull loop.
2. **`bootstrap()` fails closed, loudly.** With `ENGINE_ENABLED=true` and no pinned version it
   **throws**: *"starting on defaults would be the partial application that rule prohibits"*
   (§22.1 rule 4). The default snapshot is therefore **unreachable** whenever the engine is live.
3. **`spatial` and `shards` are not what the cutover gate reads.** `cutoverEnabled.configEnabled`
   reads exactly one thing: `snapshot.resolve("cutover.engine_enabled", { region })`. Measured:
   the register default is **`false`**. The gate refuses because *the engine has not been staged
   for this region* — §22.4's designed fail-closed staging — not because a snapshot field is null.

**There is no defect here, and "fixing" it would be manufacturing a production configuration.**
The legitimate V1 configuration act is an ordinary, versioned, audited one: publish a config
version binding `cutover.engine_enabled = true` at `region` scope, pin it, and set
`ENGINE_ENABLED=true` on the process. Both halves are required (`forShard` ANDs them).

**Classification: ALREADY-CLOSED / NON-ISSUE.** The V1 requirement it points at is real but is a
*configuration act*, not a code change — recorded in Section F as **X-3**.

### C.3 — `solve/round.js:248`, `expansion.achievedGapMilliCU ?? 0n` — **CONFIRMED. Genuine V1 correctness defect.**

This is the one unambiguous, repository-owned, V1-critical defect the audit found.

**Origin.** [`candidates/expansion.js:678-708`](../../Backend/src/engine/candidates/expansion.js#L678-L708)
computes §6.4's proven search-gap bound and sets `achievedGapMilliCU = null` in **two** cases,
each with a comment saying precisely why zero would be wrong:

- no unexplored floor resolved → *"No floor resolved, so no bound was proven. **Saying 'gap 0'
  here would be the false guarantee §6.4 calls worse than no bound.**"*
- nothing was priced → *"Nothing was priced, so there is no `C*` to bound a gap against.
  **`0n` here would read as 'proven optimal' in the decision record.**"*

It also returns a companion flag, `achievedGapProven`.

**The defect.** [`round.js:248`](../../Backend/src/engine/solve/round.js#L248) coerces that `null`
to `0n`, and **drops `achievedGapProven` entirely**. Reproduced live against the shipped module:

```
searchGapMilliCU = 0n (typeof bigint)
achievedGapProven survived? false
```

An expansion that explicitly reported *"no bound was proven"* becomes a reported search gap of
**zero — the strongest possible optimality claim.**

**Where the false claim lands.** `round.js:308` → `searchGaps[]` → `finish()` `sumMilliCU` →
`round.searchGapMilliCU` → (a) the `Round` row via
[`coordinator.worker.js:353`](../../Backend/src/workers/coordinator.worker.js#L353), and the per-Leg
value → (b) `decisionRecord.searchAndSolveBounds.searchGapMilliCU`, (c) `explanation.js`'s operator
surface, (d) `metrics.js`'s `search_gap` SLI.

**Which invariant it violates.** **I20** — *"Every reported optimality gap is a true bound … and
the search gap and column-generation gap are reported separately"* (§26.1, spec L5492). Zero is not
a true bound when nothing was proven.

**Why no test caught it.** `checkI20` audits only for a **combined** or **negative** gap
([`invariantChecker.js:1210-1221`](../../Backend/src/engine/observability/invariantChecker.js#L1210-L1221)).
A fabricated `0` is neither. The invariant checks the two failure modes that are *visible in the
number* and cannot see the one that is a lie about the number's provenance.

**Is it live today?** Not on a customer request — the coordinator does not run. But it is on the V1
core path by construction, it is equally reachable from `shadow.js` and from replay, and it is
exactly the class of defect this programme exists to prevent: **an engine asserting a guarantee it
did not compute.**

**Classification: V1-MUST-FIX.** Local, architecture-preserving, and fixed in this task.

### C.4 — Empty `src/engine/stores/` and `src/engine/deps/` — **CONFIRMED absent; NOT V1**

Both hold a single `.gitkeep` and have held one since 2026-07-28. Git history shows one touch
(`4244b3d`) and no file ever created.

Their references are **plans, not contracts**:

| Named module | Named by | Owning phase | V1 need |
|---|---|---|---|
| `stores/roles.js` | `IMPLEMENTATION_EXECUTION_PLAN.md:139`, `engine/ARCHITECTURE.md:117` | **Phase 3** | **None.** It is documentation of the §3.3 cache-authority bindings plus a guard. I16 (*the cache never holds the only copy of a correctness-critical fact*) is **enforced today** by the §24.5 cache-flush chaos gate — `chaos_capacity_1/2` and `cache_tier_flush` are all GREEN — and by each module's own advisory-cache discipline (`kv` is "advisory only" at every engine call site I traced). A module that documents a rule already enforced elsewhere adds no runtime behaviour |
| `deps/registry.js`, `deps/circuitBreaker.js` | `IMPLEMENTATION_EXECUTION_PLAN.md:162`, `engine/ARCHITECTURE.md:119` | **Phase 12** | **None for V1.** §5.2's dependency budgets and envelope reductions are a *degraded-operation* mechanism. `src/engine/degraded/` exists and the §18.5 mode machinery is implemented and verified. A circuit breaker protects a live external dependency — and V1's only external dependency, the routing service, is the very thing that is not yet selected |

`ROBOTX_SYSTEM_HANDBOOK.md:108` already states the correct rule: *"The module map names what the
owning phase **must** create — an entry there is not evidence of existence."*

**Classification: V2-FUTURE-ARCHITECTURE.** The user's instruction applies exactly: *do not create
empty architectural abstractions merely because an old plan named them.* **Nothing is created.**

### C.5 — N13 cadence parameters — **CONFIRMED as measured; NOT a V1 correctness defect**

The label is real (`ROBOTX_SYSTEM_HANDBOOK.md:3255`, `ARCHITECTURE.md:714`) and the count is exact.
Measured live against the register:

```
19 worker rows name a cadenceParameter · 11 name one the register does not define
```

| Worker | `cadenceParameter` | In register? | Readiness | What actually sets the interval |
|---|---|---|---|---|
| `reconciler` | `reconciler.sweep_interval` | **NO** | LEADER_ONLY (**starts**) | `MAX_SWEEP_INTERVAL_MS − 1`, clamped in the composer |
| `timer` | `supervision.timer_tick` | **NO** | LEADER_ONLY (**starts**) | `supervise.max_timer_lag` — **registered, `DERIVED`, 10 s.** The row names the wrong parameter |
| `rejection_aggregation` | `feasibility.rejection_flush_interval` | **NO** | SCHEDULED (**starts**) | `FLUSH_INTERVAL_MS = 30_000`, `@structural` |
| `calibration` | `observability.calibration_score_interval` | **NO** | SCHEDULED (**starts**) | `SCORE_INTERVAL_MS = 300_000`, `@structural` |
| `counterfactual` | `observability.counterfactual_interval` | **NO** | SCHEDULED (**starts**) | `RUN_INTERVAL_MS = 86_400_000`, `@structural` |
| `shadow`, `index_maintainer`, `capacity_pricing`, `charger_reachability`, `energy_calibration`, `service_time_model` | 6 further names | **NO** | DEFERRED (do not start) | nothing runs |

**Five belong to workers that actually start** — exactly the handbook's figure.

**Assessed against the user's own rule** (*"If hard-coded timing can violate a V1 correctness
invariant, classify it V1"*):

- `timer` — the one worker where cadence *is* correctness-relevant (§4.5 deadline lag) already
  reads a **registered, `DERIVED`** parameter. Its registry row is simply **wrong metadata**.
- `reconciler` — §12.4 trigger-independence. The composer clamps below the worker's own stated
  ceiling and the worker **refuses** anything slower. Bounded and declared.
- The other three are observability batching, each annotated `@structural` with a written reason —
  §22.1's own admitted category for a value that is not a behavioural threshold.

**No V1 correctness invariant is reachable from any of the eleven.**

**But there is a truthfulness defect, and it is code.** `registry.js` publishes, per worker, the
name of the register parameter its cadence comes from. For 11 of 19 that statement is false, and
nothing reads or checks the field — no gate, no test, no consumer. An unenforced register field
that is wrong more often than right is exactly the rot `registry.js`'s own header warns about
(*"an unexplained exemption is how a register rots"*).

**Classification: DOCUMENTATION-ONLY in effect, but the artefact is source.** Corrected in this
task as part of *the minimum needed to make the V1 state truthful* — with **no parameter
registered, no default invented, and no cadence changed.**

### C.6 — The X7 / `formal/lifecycle.tla` commit-history issue — **CONFIRMED**

The X4/X5 pass committed (`22411e8`). The X6 pass committed (`09e91a5`). **The X7 pass did not.**
`formal/lifecycle.tla` (+96/−31, the §4.6 `cancelRequested` latch), `formal/README.md`, and six
`docs/phase15/*.md` sit uncommitted.

The X7 work itself verifies as described: the diff **is** the latch, it is never cleared, no `.cfg`
changed, `CHECK_DEADLOCK` is absent from all six configs, and no `Backend/` file was touched.
**Nothing was weakened.** The defect is purely that the tree's most recent verification result is
not reproducible from any commit.

**Classification: V1-MUST-FIX (reproducibility).** Committed in this task.

---

## SECTION D — THE ACTUAL V1 RUNTIME PATH

Traced by call graph, not by file existence. `→` is a real call; **bold** marks a break.

```
POST /api/tasks
  → tasks.controller.assignTask                                   [WORKS]
  → task.service.assignTask
      → cutoverEnabled.describe({ snapshot: app.locals.config, shard:{regionId} })
          ├ processEnabled(env.ENGINE_ENABLED)          ── deployment fact
          └ configEnabled(snapshot.resolve("cutover.engine_enabled",{region}))
        live === false  →  503 ENGINE_NOT_LIVE, nothing written   [CORRECT fail-closed]
      → prisma.task.create (PENDING)                              [WORKS]
      → task.service.admitToRound
          → legacyTask.taskToWork  (deterministic ids ⇒ idempotent)
          → $transaction:
              ├ leg.upsert
              ├ superviseQueuedEntry → timers.register(QUEUED, sla.assignment_deadline)
              └ leg.update{ slaDeadline }                          [WORKS — T1-04]
          → intake.admit → WorkQueue row (durable)                 [WORKS]
  ──────────────── request path ends. Durable, survivable, owned. ────────────────

shardSupervisor.worker.runOnce  →  leaderWorkers.apply({mayRunRound})
  ├ COMPOSERS.outbox      → outbox.worker.start                    [WORKS]
  ├ COMPOSERS.reconciler  → reconciler.worker.start                [WORKS]
  ├ COMPOSERS.timer       → expiryActions.handlers({ladder}) → timer.worker.start
  │                          → ESCALATION_LADDER → fairness/ladder [WORKS — T1-04]
  └ COMPOSERS.coordinator → return { ok:false, ...UNCOMPOSABLE }   ★★ BREAK ★★
                             unconditional; no dependency is even attempted

  ── everything below is unreachable in production today ──
  coordinator.worker.runRound
    → leadership.readLeadership / shouldStopCommitting             [implemented]
    → readQueueState (WorkQueue, DB-authoritative)                 [implemented]
    → cadence.windowFor                                            [implemented]
    → claimBatch                                                   [implemented]
    → round.execute(deps, input)
        → deps.expandCandidates            ★ NO PRODUCTION FACTORY
            → expansion.expandCandidates   [implemented, tested]
                → availabilityIndex.candidatesInFineCell(kv, cell)  [implemented]
                → lowerBound.lowerBound + omega.combinedCorrection  [implemented]
                → input.evaluateExact      ★ NO PRODUCTION FACTORY
                    → feasibility/evaluate                          [implemented]
                    → plan/insertion → planBuilder.hopsForSequence
                        → routing/cellPairCache.hopsFor(deps)
                            → deps.route(parts)                     ★★ NO SOURCE ★★
                    → cost/phi                                      [implemented]
        → deps.pricedCandidateFor          ★ NO PRODUCTION FACTORY
            → plan/columnBuilder.build                              [implemented]
        → objective.buildInstance → minCostFlow.solve               [implemented]
        → planState.reserve (SOFT, §2.6)                            [implemented]
        → deps.commit → commitment/commit.js                        [implemented, uninjected]
            └ §10.3.2 step 5: outbox row IN the commit transaction  [implemented]
    → settleBatch → WorkQueue SOLVED                                [implemented]
    → decisionRecord.writeRound (Tier A + sampled Tier B)           [implemented]
```

### D.1 What this establishes

| | |
|---|---|
| **Stages that work end-to-end today** | intake · durable queue · dispatch (outbox) · lifecycle supervision (timer + ladder + reconciler) |
| **Stages that are implemented but unreachable** | candidate generation · feasibility · pricing · solve · commit · decision recording |
| **The single structural break** | The coordinator's dependency assembly. Everything downstream is *written and tested*; nothing *constructs* it |
| **What that assembly needs that this repository cannot supply** | `route(parts)`, a `travelSdSeconds` source (N29 — **no shortlisted engine returns one**), a per-profile `speedMetresPerSecond`, and `candidate.max_radius_by_sla_class` (`required: true`, **no default**, deliberately) |

### D.2 The `route` contract, stated exactly — **SUPERSEDED by §F.2 (E-8, 2026-09-04)**

~~Three fields.~~ **The contract is six.** §14.2 evaluates climb, regeneration and stop-start over
the *traversal*, so terrain is a property of the hop and the router is its producer. The block
below is retained as the state before E-8; **read §F.2 for the current contract**.

```js
async route({ originCell, destCell, profileKey, timeBucket })
  → { distanceM: number ≥ 0,
      travelSeconds: number ≥ 0,
      travelSdSeconds: number ≥ 0 }     // all three REQUIRED by cellPairCache.buildEntry
```

~~Anything missing a field is refused by `buildEntry` and never cached — the seam already fails
closed.~~ **True of these three and still true. It was *not* true of terrain, which had no place in
the contract at all and was silently invented one layer down — see §E.2.**

### D.3 A finding that narrows D1's V1 relevance

**A V1 expansion does not require the D1 H3 cover.** `expandCandidates` guards its cover-consuming
tiers explicitly:

- tier 3 `ZONE` requires `source.zoneCells`
- tier 4 `REGION` requires `source.regionCoarseCellIds`
- tier 6 `CROSS_REGION` requires `source.crossRegionCoarseCellIds`

With `candidate.max_expansion_tiers ≤ 2` (`KRING`) and a radius **or** wall-clock bound supplied,
expansion runs from `cells.cellForPoint(lat, lon, FINE)` — pure H3, no declaration — and
`availabilityIndex.candidatesInFineCell` needs only `kv` and a cell id.

**Consequence:** the polygon→H3 containment question that has D1 deadlocked in a governance vacuum
(`B1_EXTERNAL_INPUT_HANDOFF.md` §1.8.3–§1.8.5) is a **D1 *validator* prerequisite and a
production-coverage question. It is not a V1 *runtime* prerequisite** for a k-ring-bounded
deployment. That is a genuine narrowing, and it is the difference between "V1 is blocked on a
vacuum with no escalation target" and "V1 is blocked on four named values".

---

## SECTION E — V1-MUST-FIX

An item is here only if V1 cannot truthfully be called a working engineering release without it.

| # | Item | Why V1 | Status |
|---|---|---|---|
| **E-1** | `round.js:248` reports an **unproven** search gap as `0n`, and drops `achievedGapProven` | Violates **I20**. The engine would assert a proven optimality bound it did not compute, on the V1 decision path, in the decision record and the operator explanation. Local fix, no architecture change | **FIXED in this task** |
| **E-2** | `coordinator.worker.js:353` writes `String(result.searchGapMilliCU)`, which becomes the literal string `"null"` once E-1 lets a gap be unproven | Same invariant, one layer out. `Round.searchGapMilliCU` is `String?` — nullable by design | **FIXED in this task** |
| **E-3** | `metrics.js:617` folds a missing gap into `"0"` when computing the `search_gap` SLI | Same invariant at the SLI. An unproven round must not be counted as a zero-gap round | **FIXED in this task** |
| **E-4** | `registry.js` publishes a false `cadenceParameter` on 11 of 19 rows (**N13**) | V1 must honestly represent itself. No parameter is registered, no default invented, no cadence changed | **FIXED in this task** |
| **E-5** | The X7 formal-verification result is uncommitted, so the tree's latest verification is not reproducible from any commit | Reproducibility is part of the V1 contract | **FIXED in this task** |
| **E-6** | Canonical documents present a stale HEAD, a stale working-tree claim, and three stale X6/X7 status rows | §15's document-maintenance rule | **FIXED in this task** |
| **E-7** | **The coordinator solve-path composition does not exist** — `expandCandidates`, `pricedCandidateFor`, `expansionInputFor`, and the injection of `route`, `commit`, `planState` and `deferPriceFor` at `server.js` | Without it no request is ever assigned. This is *the* V1 gap | **PARTIALLY CLOSED — the requirements probe is built; the assembly is deliberately not.** See §E.1 |
| **E-8** | Three fail-**open** coercions on the V1 plan path: `legProfiles` turned absent terrain into flat ground, and `timeline.project` turned an absent travel-time and service-time spread into zero | **UNKNOWN IS NOT PERMISSION**, and all three erred permissively. Zeroed climb understates mission energy → overstates the charge F34 holds the §14 reserves against; a zeroed ETA spread makes §8.4's `p_late` price a certain arrival | **FIXED — `e38fe5b`.** See §E.2 |
| **E-8b** | The composition root never handed the coordinator the pinned snapshot it already holds, so `snapshot` **and** the §6.4 Ω admissibility check both measured as unsatisfied at a real promotion | A dependency this repository owns, reported as missing. It also made E-7's own table wrong in two rows | **FIXED — `8910818`.** See §E.3 |
| **E-9** | **The solve-path assembly itself — E-7's remaining half.** `expandCandidates`, `pricedCandidateFor`, `expansionInputFor`, `evaluateExact` and `commit` existed only in test fixtures | *The* V1 gap. Without it no request is ever assigned, and the last obstacle attributable to this repository | **BUILT — this pass.** `src/workers/coordinatorSolvePath.js`. See **§L** |

### E.1 — E-7, as built: the requirements probe

**Owner decision, 2026-09-01:** build the conditional composer first, as a requirements
*reporter* rather than as the full assembly. That decision is what made S-3 measurable instead of
estimable — and §F.0 records that two successive hand-audits of S-3 had already produced two
different, confidently-stated, wrong answers.

**What was wrong with the old composer, and it is not a style point.** `COMPOSERS.coordinator()`
took **no argument** and returned a fixed object. Supplying a routing engine, a region and every
calibrated value would not have changed its answer by one character, because it never looked at the
context it was handed. **A refusal that cannot be satisfied is a constant, not a dependency check**
— and it flattened a distinction that matters: some of what the coordinator lacks is an external
decision, and some of it is code nobody has written.

**What exists now.** `Backend/src/workers/coordinatorPipeline.js` declares the contract as **14
inputs**, each with an id, a class, an owner, the reason it is needed *named at the function that
fails without it*, and a probe. `requirements(context)` runs every probe and returns the missing
set. `COMPOSERS.coordinator(context)` reports that list; `UNCOMPOSABLE.coordinator.requires` is
**derived** from the same list rather than restated, so the declarative table a build gate reads
and the probe a promotion runs cannot drift apart.

**The measured S-3 list** — produced by the code, at digest `4d94ef18…`, against a snapshot-only
context (a real promotion supplies `prisma`, `kv` and `commit`, leaving nine):

| Class | Count | Inputs |
|---|---:|---|
| `EXTERNAL_ROUTING` | **3** | `route`, `travelSdSeconds source (N29)`, `speedMetresPerSecond (per routing profile)` |
| `REGISTER_UNRESOLVED` | **3** | `candidate.max_radius_by_sla_class`, `plan.service_time_prior`, `energy.model_residual_cv` |
| `NO_PRODUCER` | **3** | `terrainByStop`, `environment.ambientC / packC`, `masses.vehicleMassKg` |
| `PROCESS_DEPENDENCY` | **3** | `prisma`, `kv`, `commit` — supplied at promotion |
| `ADMISSIBILITY` | **0 missing** | The Ω correction **resolves** on the current register |

**The classes are the deliverable, not the count.** A `REGISTER_UNRESOLVED` entry is `null` *by
declaration* and §22.3 forbids an automated process from choosing it — §22.4's calibration owner's.
A `NO_PRODUCER` family is **nobody's withheld decision**: it is missing code against a data source
nobody has named. Both used to read as "blocked on B1", and sending the owner to look for a
decision that does not exist is precisely what the flat list caused.

**What was deliberately not built, and why that is not laziness.** No `expandCandidates`, no
`evaluateExact`, no `pricedCandidateFor`. With the real inputs absent, several hundred lines of
assembly would be exercised only by an injected complete context — *written, tested, and never
called*, which `registry.js`'s own header names as the failure mode and which this programme has
hit at least four times. **The composer says so explicitly**: with every input satisfied it still
refuses, with `COLLABORATOR_NOT_IMPLEMENTED`, `external: false`, and a blocker naming the assembly
— so the last obstacle is attributed to this repository rather than left implying it is external.

**`gate:composition` is unchanged and still RED.** The gate reads `UNCOMPOSABLE` declaratively and
that row remains; it is removed when the coordinator actually starts, which is the rule the table
sets for itself. Making the *composer* conditional did not make the *gate* conditional.

**One existing test broke, and it broke for the right reason — recorded because the reason is the
finding.** `tests/engine/leaderWorkerLifecycle.test.js` asserted
`refusal.requires === ["expandCandidates", "pricedCandidateFor", "commit"]`. Those are the three
*collaborators* `round.execute` takes: the assertion pinned the **shape** of the gap and said
nothing about its contents, **which is exactly how "the coordinator is blocked on B1" survived
unexamined across six passes**. Re-pinning a literal list would have recreated the same drift one
layer along, so the assertion now checks the **derivation** (`requires` *is*
`coordinatorPipeline.REQUIREMENT_IDS`) and that the refusal is genuinely measured against the
context it was handed — that fixture supplies `prisma` and `kv`, so those report satisfied while the
routing inputs do not. The contract's *contents* are owned by one suite, not restated in two.

**It was caught by the full suite and not by the targeted one**, which is the standing argument for
running `npm test` rather than the files you think you touched.

**Evidence: 16 tests; 2 mutants built, 1 killed on the first run, 1 survived and is recorded.**
**M4** — revert the composer to unconditional — killed (3 failures). **M5** — make the probe's
outer `catch` fail-*open* — **SURVIVED**, and is recorded as a survival rather than presented as a
kill. The cause was a real gap in the test, not in the code: `resolved()` has its own inner
try/catch, so the register probes returned `false` cleanly and never reached the outer catch. The
test was strengthened with a throwing `Proxy` context that makes every probe raise, **M5 was re-run
against it and killed**, and both files were restored and byte-verified. *(The X6 pass set this
precedent with its own M6, and the reason to follow it is that a mutant reported as killed when it
survived is worse evidence than no mutation testing at all.)*

### E.2 — E-8, as found: three coercions that made a fail-closed guard unreachable

**Found by reading `legProfiles` while verifying §F.0's `terrainByStop` row, not by a new audit.**
The row asserted that `plan/planBuilder.legProfiles` *"requires `{climbM, descentM,
stopStartCycles}` per stop and fails closed without it."* **It did not.** Reproduced live against
the shipped module before any change:

```
legProfiles({ …, terrainByStop: undefined })
  → ok = true
  → profile = { climbM: 0, descentM: 0, stopStartCycles: 1, … }
```

An absent terrain profile became **a complete, plausible, entirely invented physical description of
ground nobody surveyed** — and the same read at `timeline.project` turned an absent
`travelSdSeconds` into `0`, which is §8.4's *"this ETA is certain"* in the optimistic direction and
is N29's own coalesce one layer on from the one `tools/routing/b1Benchmark.js` was already
corrected for.

**Why this is worse than a bad estimate.** `energy/consumption.legEnergyWh` lists `climbM`,
`descentM` and `stopStartCycles` in `REQUIRED_PROFILE_FIELDS` and **refuses** a profile missing any
of them. That refusal was **unreachable**: `legProfiles` always handed it a number. The coercion
did not degrade the estimate, **it defeated the guard one layer down** — and it defeated it
permissively, because the climb term is `β_climb · climbM · grossMassKg` and zeroing it understates
mission energy, which overstates the projected charge F34 holds the §14 reserves against.

**Fixing it exposed a third defect it had been hiding.** Terrain arrived as `terrainByStop`, keyed
by the **sequenced** stop number — and `insertChargingStop` re-sequences every stop when it
evaluates an insertion position. Under §13.4 each stop after an inserted charge therefore read its
**neighbour's** elevation profile, and the missing tail entry coerced to flat so nothing showed.
That was never a refusal; it was a wrong number.

**The contract decision.** §14.2 states `β_climb · Σ max(0, Δh)`, its regeneration counterpart and
`β_stop_start · n_stop_start_cycles` **over the traversal**. Terrain is therefore a property of the
hop, exactly as `distanceM` is — so it moved onto the hop, `hopsForSequence` re-resolves it per
variant, and the misalignment **cannot be expressed**. Charging insertion works again for the right
reason rather than being refused for a keying accident.

**Consequently the `route(parts)` contract is six fields, not three** (§D.2 is superseded by §F.2),
and terrain moves from `NO_PRODUCER` to `EXTERNAL_ROUTING`: it is not a family with no producer, it
is a field the router produces and the seam was not carrying. **The requirement count is unchanged
at 14.**

**Where the requirement is enforced, and why not at the cache.** `cellPairCache.buildEntry`
**carries** terrain and validates it when present, but does not require it; `timeline.project`
refuses without it, before any plan is built or priced. Requiring it at the cache would
additionally refuse every row written by `tools/routing/b1Benchmark.js`, which builds no plan — a
benchmark that cached nothing would report a hit rate of zero and read as an engine result.

**Nothing is fabricated.** Every **declared** zero still passes; what no longer passes is silence.
That is the distinction every test in the suite turns on, and a test that only checked "absent is
refused" would have passed against a change that refused both.

**Evidence: 22 tests; 4 mutants built, 4 killed.** **M6** restores `legProfiles`' coercion → 2
failures. **M7** restores both spread coercions in `timeline.project` → 3. **M8** disables the
timeline terrain guard → 3. **M9** makes `buildEntry` accept a negative climb → 1. All three
modules restored and byte-verified (`diff -q`).

### E.3 — E-8b: the process dependency the composition root already owned

**E-7's table was wrong in two rows, and only measuring the real context showed it.** It recorded
`PROCESS_DEPENDENCY` as *"`prisma`, `kv`, `commit` — supplied at promotion"* and `ADMISSIBILITY` as
*"**0 missing** — the Ω correction **resolves** on the current register"*.

`server.js` hands `leaderWorkers.create()` a `values` accessor — the resolved parameter **map** —
and never the **snapshot**. The map is not a substitute: `resolve(name, { sla_class })` is
scope-aware and a flat map cannot answer a per-SLA-class question, which is exactly what
`candidate.max_radius_by_sla_class` is. Measured against the context `server.js` actually builds:

| | Satisfied | Missing | By class |
|---|---:|---:|---|
| **Before** | 2 — `prisma`, `kv` | **12** | `EXTERNAL_ROUTING` 4 · `REGISTER_UNRESOLVED` 3 · `NO_PRODUCER` 2 · `PROCESS_DEPENDENCY` 2 · `ADMISSIBILITY` 1 |
| **After** | 4 — `+ snapshot`, `+ Ω correction` | **10** | `EXTERNAL_ROUTING` 4 · `REGISTER_UNRESOLVED` 3 · `NO_PRODUCER` 2 · `PROCESS_DEPENDENCY` 1 |

So a real promotion left **twelve** inputs unresolved, not nine — and the §6.4 admissibility check
E-7 recorded as *resolving* was in fact **failing**, because the code that would have resolved it
was never given its input. **This is the Phase 15 finding again in a new place: a producer exists,
and the composition root does not use it.**

Passed as an **accessor**, for P15-R2's reason exactly — `create()` runs once at boot and the
composers run on every promotion, so a captured snapshot would bind the coordinator to the version
the process booted on while the request path moved on. A throwing accessor is **not** satisfied.

**The one remaining `PROCESS_DEPENDENCY` is `commit`, and it is not a wiring omission.**
`commitment/commit.js` refuses without `volatileRecheck`; `feasibility/volatileSubset.js`'s
`createVolatileRecheck` refuses without a `buildContext` adapter, and its own header says why —
*"assembling an agent snapshot from a transaction is the round's work (Phase 9/10) and not this
module's."* That is the same unwritten assembly `evaluateExact` needs. **It is left refused rather
than bound to a stub.**

### E.4 — Why the solve-path assembly is still not written, now measured rather than argued

> **SUPERSEDED by §L (E-9, 2026-09-04, later the same day). The assembly is written.**
> The owner's decision changed: *"the absence of a reference implementation is NOT a reason
> to leave the required V1 composition unwritten."* The four arguments below are retained
> because three of them were **correct and remain true** — 25 of 33 inputs are still
> unresolved, `commit`'s chain did bottom out here, and there is still no reference
> implementation to check an output against. What they did not justify is the conclusion.
>
> Argument 3 is the one the build refuted in practice: with nothing constructing the path,
> the four seams past `planBuilder` had never been executed against a candidate assembled
> from this schema, and **writing the assembly is what found §L.2's twelve further register
> parameters and §L.4's 35 unresolved gate inputs.** An assembly that is written and refuses
> by name turns out to measure more than a probe that stops where the reader stopped.

§E.1 recorded this as an owner decision on 2026-09-01. This pass re-examined it against the tree
and the decision holds, for reasons that are now **facts about the repository** rather than a
judgement about effort:

1. **10 of 14 declared inputs are unresolved at a real promotion**, and 9 of those 10 are external
   or belong to §22.4's calibration owner. The assembly is not one value away from running.
2. **`commit`'s own chain bottoms out in the same unwritten code** (§E.3), so building the assembly
   would not even close the process dependencies.
3. **No reference implementation exists anywhere — including in the tests.** This was checked, not
   assumed: `tests/engine/candidatesExpansion.test.js` injects
   `evaluateExact: async (agentId) => ({ feasible: true, gammaMilliCU: 42_000n })`, and every other
   caller in `tests/` is a stub of the same shape. Nothing in `src/` builds a `planBuilder.build()`
   input; `plan/insertion.js` takes `builderInput` injected. So a new assembly would have **nothing
   to be checked against**.
4. **Its output is a price, not a boolean.** A wiring error in `evaluateExact` produces a *wrong
   assignment* that looks successful, and the only thing that could catch it — §I.2's S-6
   end-to-end demonstration — is itself blocked on S-3.

**This is a stop at an external boundary, not a deferral of repository-owned work.** Everything on
the V1 path that this repository can complete without an external value has been completed.

---

## SECTION F — V1-EXTERNAL-INPUT

Decisions a human must supply. **None may be fabricated, inferred, or defaulted.** Each is stated
as the smallest thing that unblocks V1 — not as its full production form.

| # | Input | V1 needs | V2 / production needs (**not** V1) | Owner |
|---|---|---|---|---|
| **F-1** | **A traversal source for `route(parts)`** | One declared, real, self-hosted source, and an explicit statement of the environment it is declared for | B1 Steps 1/3/4/5: deploy all candidates, benchmark on representative hardware, record hierarchy build times and re-contraction budget, and select in an ADR | Owner |
| **F-2** | **`travelSdSeconds` source (N29)** | A declared spread model with a named source | Calibration against realised production ETAs | Owner |
| **F-3** | **`speedMetresPerSecond` per routing profile** | One declared value per profile in use — required by `applyIntraCellOffset`, which refuses without it | D3's full §2.2 six-element mobility model per class, from a real fleet measurement | Owner (Fleet) |
| **F-4** | **`candidate.max_radius_by_sla_class`** | A bound. `required: true`, **no default**, `UNCALIBRATED` — the register deliberately refuses to invent a containment limit | Derivation from measured SLA attainment | Owner (Ops) |
| **F-5** | **A staged operating region** — publish a config version binding `cutover.engine_enabled = true` at `region` scope, pin it, and set `ENGINE_ENABLED=true` | An ordinary versioned, audited configuration act. **No code change, no fabrication** | The full D1 declaration: signed boundary, CRS, cover, charger estate, governance sign-off | Owner |
| **F-6** | **Per-hop terrain on the `route` contract** — `climbM`, `descentM`, `stopStartCycles` | The same declared traversal source as F-1 returning three more fields. Elevation is available from Valhalla and GraphHopper and not from OSRM; **no shortlisted engine returns stop-start cycles**, so like F-2 this needs a declared source and selecting an engine does not close it | Calibration against realised consumption | Owner |

### F.0 CORRECTION, same day — **S-3 is NOT four values.** The table above is incomplete.

**Found while starting E-7, and stated here rather than absorbed into a widening scope.** §F above
was derived from the `route(parts)` seam and `expandCandidates`'s own input contract, and it is
correct *about those*. It is **incomplete about `evaluateExact`**, which is the other half of what
the coordinator needs and which reaches `plan/planBuilder.build()` and `cost/phi.evaluate()`.

`planBuilder.buildVariant` fails closed on **each** of service times, hops, payload, energy model,
environment, masses and terrain — every one returns `{ ok: false, problems }`. Measured against the
current tree:

| Input | State | Class |
|---|---|---|
| `plan.service_time_prior` | **`null`, `UNCALIBRATED`** — required by `resolveServiceTimes` | **V1-EXTERNAL-INPUT** (calibration owner) |
| `energy.model_residual_cv` | **`null`, `UNCALIBRATED`** — required by `consumption.predictiveDistribution` | **V1-EXTERNAL-INPUT** (calibration owner) |
| `candidate.max_radius_by_sla_class` | **`null`, `UNCALIBRATED`** — already **F-4** | V1-EXTERNAL-INPUT |
| ~~`terrainByStop`~~ **hop terrain** (`climbM`, `descentM`, `stopStartCycles`) | **RECLASSIFIED by E-8, 2026-09-04.** Not a family with no producer: §14.2 states these over the traversal, so **the router is the producer** and the seam simply was not carrying them. The code half is **DONE** (`e38fe5b`); what remains is the declared source | **V1-EXTERNAL-INPUT (routing)** — see **F-6** |
| `environment` (`ambientC`, `packC`) | **No schema column and no producer anywhere in `src/`.** Consumed by `energy/consumption.betaThermal` | **V1-MUST-FIX (code) + a telemetry/forecast source** |
| `masses.vehicleMassKg` | `AgentClass.totalMassLimitKg` is a **limit**, not a mass. No mass column exists | **V1-MUST-FIX (code) + external data** |
| `payload` (container, items per stop) | Schema-backed (`PayloadSpec`, `massKg`, `massToleranceKg`) — **assembly code absent** | V1-MUST-FIX (code) |
| `energy.model`, `energy.kappa`, `usableWh` | Schema-backed (`AgentClass.energyModelParams`, pack state) — **assembly code absent** | V1-MUST-FIX (code) |
| `charging.chargerCandidates` | Empty is survivable — a charging stop is attempted only when reserves fail, and the outcome `NO_FEASIBLE_INSERTION` is a priced result, not a crash. **The owner has declared no production chargers exist at either campus** | RESIDUAL for V1 |

**So the corrected shape of S-3 is: three `UNCALIBRATED` register values (not one), plus the four
routing values, plus three input families that have no producer at all.** The last three are not
external decisions — they are **missing code and missing data sources**, and they were invisible to
§F because §F stopped at the routing seam.

**What this changes, and what it does not.** It does not change the V1 *contract* (§I.1), the eight
stop conditions (§I.2), or anything already fixed. It changes **S-3's content** and it makes the
E-7 estimate materially larger. **It is recorded rather than quietly absorbed**, because a scope
that grows without being announced is how "what remains" became unbounded in the first place.

**How S-3 will be made exact rather than re-estimated by hand.** The owner's decision on 2026-09-01
was to build the conditional assembly first: a composer that *attempts* the real assembly and
**reports, by name, every input it cannot resolve**. That replaces this hand-audit — and the
hand-audit it corrects — with a list the code produces. Until that runs, **treat the table above as
the best current measurement and not as a closed set.**

### F.1 Answers to the routing questions, precisely

| | Question | Answer |
|---|---|---|
| **A** | Does V1 require a production routing engine selection/benchmark? | **No.** B1 Steps 1–5 produce a *procurement decision recorded in an ADR*. That is a release artefact |
| **B** | Does V1 merely require a declared/injected traversal source? | **Yes — plus E-7, the code that injects it.** Both, not either |
| **C** | Can the existing adapter seam satisfy the V1 routing dependency? | **Partly, and not as-is.** `tools/routing/adapters/` are **benchmark** adapters. They live in `tools/`, outside the production require graph; their own header says they are *"not `src/engine/routing/client.js`"*; they answer matrix queries rather than the `route(parts)` cell-pair shape; and **none of them can supply `travelSdSeconds` for any engine (N29)**. An adaptor from that layer to the `route(parts)` seam is small — but it does not exist, and it cannot close F-2 |
| **D** | What must be supplied to `route(parts)`? | ~~`{distanceM, travelSeconds, travelSdSeconds}`~~ — **SUPERSEDED by §F.2 (E-8, 2026-09-04): six fields**, adding `climbM`, `descentM` and `stopStartCycles`, all finite and non-negative |
| **E** | What region/spatial inputs does the V1 runtime genuinely require? | An origin fine cell (**derived**, no declaration), a radius **or** wall-clock bound (**F-4**), and `speedMetresPerSecond` (**F-3**). The **H3 cover is not required** at `max_expansion_tiers ≤ 2` — see §D.3 |
| **F** | Can a V1 engineering environment use a declared bounded traversal source without claiming production readiness? | **This is the owner's decision and nobody else's.** The forbidden-actions table bars *"a stub, fake, or in-process router"* written to make `gate:composition` pass. A **real, declared, owner-supplied** source in a **declared non-production environment** is a different act — ADR-34 already establishes that precedent for cutover rehearsal. It would still have to be recorded as such, and **it would not discharge B1, close `engine_decision_path_wired`, or make any release evidence admissible** |
| **G** | Which B1 decisions are unavoidable for V1? | ~~**F-1, F-2, F-3, F-4.** Four values.~~ **CORRECTED 2026-09-04: F-1, F-2, F-3, F-4 and F-6 — five**, F-6 being the per-hop terrain E-8 moved onto the `route` contract. *(This row has now been wrong twice in the same direction — §F.0 corrected "four" once already, and the reason is the same both times: it was read off one seam.)* |
| **H** | Which B1 requirements are strictly production/release, and therefore V2? | Steps 1/3/4/5 in full; the selection ADR; D8 entirely (extract identity, vintage, refresh cadence, re-contraction budget); the D1 governance sign-off, cover, charger estate and containment-semantics escalation; R1 self-hosting evidence; commercial coverage; every calibration in B8 |

### F.2 The `route` contract, as it stands after E-8 — **six fields**

```js
async route({ originCell, destCell, profileKey, timeBucket })
  → { distanceM:        number ≥ 0,   // REQUIRED by cellPairCache.buildEntry
      travelSeconds:    number ≥ 0,   // REQUIRED by cellPairCache.buildEntry
      travelSdSeconds:  number ≥ 0,   // REQUIRED by cellPairCache.buildEntry  (F-2, N29)
      climbM:           number ≥ 0,   // REQUIRED by plan/timeline.project     (F-6)
      descentM:         number ≥ 0,   // REQUIRED by plan/timeline.project     (F-6)
      stopStartCycles:  number ≥ 0 }  // REQUIRED by plan/timeline.project     (F-6)
```

**Two enforcement points, deliberately.** The first three are what makes a row a usable cache entry
and are refused by `buildEntry`, so a malformed one is never cached. The terrain three are a
*decision-path* requirement and are refused by `timeline.project`, before any plan is built or
priced. The reason the cache does not require them is stated in §E.2: `cellPairCache` is also the
seam `tools/routing/b1Benchmark.js` measures engine latency and hit rate through, and that harness
builds no plan.

**A declared `0` is accepted in every field. Silence is not.** A router that reports a level hop
has measured something; a router that omits the field has not, and the two must not produce the
same plan.


---

## SECTION G — V2 (deliberately deferred, with the reason)

| Item | Bucket | Reason |
|---|---|---|
| B1 Steps 1/3/4/5 and the engine-selection ADR | V2-PRODUCTION | A procurement decision on recorded evidence. V1 needs a traversal source, not a vendor |
| D8 — extract identity, vintage, refresh cadence, re-contraction budget | V2-PRODUCTION | Governs how a production extract is maintained. A V1 environment has no refresh cadence to govern |
| D1 — signed boundary, cover, charger estate, containment-semantics escalation | V2-PRODUCTION | Blocked on a **governance vacuum with no escalation target** (§1.8.5). §D.3 shows V1's runtime does not need the cover |
| B8 — 39 Safety-class parameters not `DERIVED` | V2-PRODUCTION | §22.3 forbids automated change of a Safety-class parameter. Launch prerequisite, not a working-engine prerequisite |
| B-P — `invariants_enforced`, `simulator_fidelity`, `soak`, `shadow_agreement` | V2-PRODUCTION | Each requires an operating fleet and an observation window. **Never simulate** |
| B-O — `safety_case_assembled`, `rollback_rehearsed` | V2-PRODUCTION | Filed attestations by named humans |
| B-M — `commitment_c2/c3` convergence, `lifecycle_c2/c3` authoritative treatment, boundedness sign-off, named operator, §7.6 acceptance | **V1-VERIFICATION (partial) + V2-PRODUCTION** | See §G.1 |
| `src/engine/stores/roles.js` | V2-FUTURE-ARCHITECTURE | Phase 3's. Documents a rule already enforced by the §24.5 chaos gates. **Do not create** |
| `src/engine/deps/registry.js`, `circuitBreaker.js` | V2-FUTURE-ARCHITECTURE | Phase 12's. Protects a live external dependency V1 has not yet selected. **Do not create** |
| `src/engine/routing/client.js` (§5.2 degradation ladder) | V2-FUTURE-ARCHITECTURE | **Phase 8**, blocked by N25/N26 *and* B1. V1's `route` seam is injection, not this client |
| `src/engine/lifecycle/preemption.js`; `solve/setPartitioning.js`, `branchAndBound.js`, `localSearch.js` | V2-FUTURE-ARCHITECTURE | Phase 16. Every §22.5 kill switch is thrown |
| A9 — a caller for `assertVersionInKey` | V2-FUTURE-ARCHITECTURE | Its seam is Phase 8's `routing/client.js`. **Do not manufacture a caller** |
| X3 — no `TASK` timer producer; §4.2 has no transition table | V1-EXTERNAL-INPUT *(specification)* | See §G.2 |
| Re-collecting `release-evidence.json` | V2-PRODUCTION | The release owner's step at a quiescent tree. **The verdict is BLOCKED either way** |
| CI not running `gate:composition` | RESIDUAL | Recorded fact. CI is green on a tree where a blocking gate is RED. No pass has changed CI, and this one does not either |

### G.1 What V1 needs from formal verification

Independently verified: X4, X5, X6 **and** X7 are all closed and implemented; `lifecycle_c1` and
`commitment_c1` close exhaustively; `commitment_c2/c3` are UNKNOWN (non-convergent);
`lifecycle_c2/c3` need authoritative treatment. **2 of 6.** **B-M is OPEN and stays OPEN.**

**V1 does not require B-M.** B-M is `model_check_capacity_1_2_3` — a §24 **release** gate whose
statement is an exhaustive check at three capacities plus a release owner's acceptance. What V1
requires is narrower and **already satisfied**:

> **V1-VERIFICATION (formal): the two capacity-1 configurations close exhaustively with every
> declared property passing, on the configurations as checked in.** `commitment_c1` — 17 991 520
> states / 2 375 660 distinct / diameter 21, no error. `lifecycle_c1` — 777 942 / 187 289 / depth
> 43 / 0 on queue, `Safety` + `TerminalIsFinal` + `Liveness` all PASS.

**Both are met.** Capacities 2 and 3, the boundedness judgement, the named operator and §7.6
acceptance are **V2-PRODUCTION**. Nothing was weakened to reach this: no `.cfg` changed,
`CHECK_DEADLOCK` is absent from all six, and every property definition is byte-identical.

### G.2 X3

§4.2 has no `TASK` transition table, so no `TASK`-entity timer producer exists; `phase15CurrentTree`
G1 reports 0. **Not V1-blocking**: the V1 core path is Leg-scoped, every Leg state has a registered
deadline (I4, discharged by T1-04), and `taskMachine.TASK_DEADLINES` is consulted by
`deadlineSecondsFrom`. A `TASK` deadline would be a *second* supervision layer, not the first.
**V1-EXTERNAL-INPUT (specification), non-blocking for V1.**

---

## SECTION H — RESIDUAL OBSERVATIONS (known; not blocking V1)

1. **P15-F7a** — nothing binds a runbook to the API it documents. Two partial compensating controls
   exist (`rollback.md` §7's trace date; `phase15RollbackRunbook.test.js`'s constant pinning).
   Unchanged.
2. **`app.locals.releaseEvidence` has no producer** — `health.controller.js:319` always evaluates
   an empty evidence set. **Fails closed.** Reported gap, not a permissive defect.
3. **`gates.blockers()` ignores `unknownEvidence`** — evidence filed against an unknown gate id
   never appears as a blocker.
4. **`prisma/seed.js` silently partial-seeds and exits 0** — 3 register entries carry
   `changeClass: "OPERATIONAL"`, which `ConfigChangeClass` does not define. Pre-existing since
   `cbe540e` (2026-08-09). Blocks `phase12LiveDatabase.js` from an empty cluster. **Not Phase 15's,
   not V1's core path**, but it is repository-owned and real.
5. **`round.js` drops `expansion.problems`** — `candidatesFor` collects them and `plan()` never
   reads them, so an expansion's stated problems do not reach the per-Leg record. Adjacent to E-1;
   **not fixed here**, because carrying them changes the decision-record shape and that is a wider
   change than E-1 warrants.
6. **`NO_FEASIBLE_CANDIDATE`'s detail is asserted, not derived** — a refused expansion
   (`ok: false`, `truncatedBy: "unbounded_search_refused"`) produces zero candidates and is
   recorded with the sentence *"the hierarchical expansion found no agent that survived the
   feasibility gate"*, which is not what happened. `truncatedBy` is carried beside it and does
   disambiguate. **Reported, not fixed.**
7. **`evidence.admit()` has no admission path for a TLC run** — the gate is `EVIDENCE.SUITE` and
   admission refuses any run record whose command is not `npm run test:engine -- ModelCheck`.
8. **`formal/` is outside the source-digest scope** — no evidence record binds the state of the
   `.tla` modules or the six `.cfg` files.
9. **CI runs 6 of 8 build gates on a push** (`gate:columngen` is PR-only) and **never runs
   `gate:composition`** — the only one that fails. The workflow gives no reason for that third
   omission.

None of 1–9 prevents a request from traversing the engine, and none makes a false claim about a
decision. **They are reported and left.**

---

## SECTION I — THE FINITE V1 STOP CONDITION

### I.1 The V1 contract

> **V1 is the assignment engine acting as the decision path for one declared operating region, on
> a real database, in which a submitted request traverses intake → durable queue → coordinator →
> candidate generation → routing → feasibility → pricing → solve → commit → dispatch → lifecycle
> supervision, and in which every claim the engine makes about its own decisions is true.**

V1 explicitly does **not** include: production certification, an operating fleet, calibrated
Safety-class parameters, observation windows, filed attestations, a routing-engine procurement
decision, or 24 green §24 gates.

### I.2 The stop condition — eight conditions, all checkable by command

**V1 is complete when, and only when, all eight hold. There is no ninth, and no clause admits one.**

| # | Condition | How it is checked |
|---|---|---|
| **S-1** | No reported optimality gap is ever a value the engine did not prove, **and no absent physical input is read as a benign one** | `npm test` green **and** the E-1 **and E-8** regression suites present and passing. *(E-8 was added to S-1 on 2026-09-04 rather than becoming an S-9: it is the same condition — the engine must not assert what it did not compute — found at a second seam. §I.2 admits no ninth condition and this is not one.)* |
| **S-2** | `registry.js` names, for every worker, either a register parameter that exists or a `@structural` constant with a stated reason | Assertion in `assertRegistry()` / test, green |
| **S-3** | The four external values **F-1…F-4** are supplied by the owner, in writing, in a decision record under `docs/release-decisions/` | The record exists and names its author and date |
| **S-4** | The coordinator's solve path is composed at `server.js` from those values, and `leaderWorkers.COMPOSERS.coordinator` returns a started handle | `gate:composition` **exit 0**, 0 violations |
| **S-5** | A config version binding `cutover.engine_enabled = true` at region scope is published and pinned, and the process runs with `ENGINE_ENABLED=true` | `cutoverEnabled.describe(...)` reports `live: true`, `decisionPath: ENGINE` |
| **S-6** | **One real request, submitted over HTTP against a live PostgreSQL, reaches a durable `Commitment` row and an `Outbox` row in the same transaction, with a `Round` row and a per-Leg decision record written** | A new live-DB harness, `tools/verify/v1CorePath.js`, exits 0 |
| **S-7** | `npm test` exit 0 and `npm run gates` exit 0 | both commands |
| **S-8** | The V1 documentation states plainly what V1 does **not** guarantee: not production-certified, not calibrated, no fidelity study, no soak, no shadow window, no attestations, no routing-engine selection | This document plus a V1 release note |

### I.3 What is true right now

**As of 2026-09-04, after E-8, E-8b and E-9 (the composition — §L):**

```
S-1  ✅ E-1 + E-8, fixed and mutation-tested   S-5  ⬜ owner configuration act (no code; mechanism VERIFIED)
S-2  ✅ fixed 2026-09-01                       S-6  ⬜ blocked by S-3 → S-4. NOT attempted, NOT claimed
S-3  ⬜ OWNER + calibration owner — 25 inputs  S-7  ⚠  npm test 0 ✔ ; npm run gates 1 ✘ (S-4 closes it)
S-4  ⬜ blocked by S-3 — the COMPOSITION now   S-8  ✅ this document
        exists and starts when its inputs
        resolve; they do not resolve here
```

*(S-3 read "9 inputs" before E-9. The composition measured 25 — see §L.2. **The stop
condition did not move**: S-3 has always been "the external values", and only the
measurement of its contents changed.)*

**Three of eight are met. One is an owner/calibration decision (S-3). Two are mechanical
consequences of it (S-4, S-6). One is a configuration act (S-5). One follows (S-7).**

**S-5's mechanism was verified this pass rather than asserted.** Executed live:
`enabled.describe({ snapshot: defaultSnapshot(), shard: { regionId }, env: { ENGINE_ENABLED: "true" } })`
returns `processEnabled: true`, `configEnabled: false`, `live: false`, `decisionPath: "NONE"`.
Both halves are required and `forShard` ANDs them, exactly as §C.2 said. **No code change is
needed for S-5**; what remains is publishing and pinning a config version that binds
`cutover.engine_enabled = true` at `region` scope, which is the owner's act.

### I.4 The single thing standing between this repository and V1

> ~~**S-3 — four values: a `route(parts)` source, a `travelSdSeconds` source, a per-profile
> `speedMetresPerSecond`, and `candidate.max_radius_by_sla_class`.**~~
>
> **CORRECTED the same day — see §F.0. S-3 is larger than four values**, and the correction was
> found on starting E-7 rather than by re-reading §F. It is at least: **three `UNCALIBRATED`
> register values** (`candidate.max_radius_by_sla_class`, `plan.service_time_prior`,
> `energy.model_residual_cv`), **the four routing values**, and **three input families with no
> producer anywhere** (`terrainByStop`, `environment.ambientC`/`packC`, `masses.vehicleMassKg`) —
> the last of which are missing *code and data sources*, not missing decisions.
>
> **S-3 is therefore not yet an exact list, and this document will not pretend it is.** It is being
> made exact by **E-7**, the conditional assembly, which attempts the real composition and reports
> by name every input it cannot resolve — the owner's decision of 2026-09-01. **A list the code
> produces, replacing two successive hand-audits that each stopped at a different seam.**

The routing values cannot be derived, defaulted, or inferred from anything in this repository —
every one is explicitly refused by the code that would otherwise invent it, and that refusal is
correct. **The same is now known to be true of `plan.service_time_prior` and
`energy.model_residual_cv`**, which are `null` by declaration rather than by omission.

**When S-1…S-8 hold, V1 is complete and work stops.** No further item may be added to this list
after the fact. If a new defect is found on the V1 core path, it is a V1 bug against a shipped V1
— it is not a reopening of the stop condition.

---

## SECTION J — FINAL VERIFICATION OF THIS PASS

Executed after the changes, on the tree they produced.

| Check | Result |
|---|---|
| `npm test` | **exit 0 — 164 suites / 7 307 tests / 0 failures / 0 skips**, 643 s *(162 / 7 275 before this pass; 163 / 7 291 after I20+N13; 164 / 7 307 after E-7)* |
| New regression suite | `tests/engine/solveRoundSearchGapProvenance.test.js` — **14 passed** |
| `tests/engine/workerRegistry.test.js` | **15 passed** — the three tests that *pinned* N13 replaced by five that assert it closed |
| Mutation testing | **5 built, 4 killed on first run, 1 survived and was re-killed after the test was strengthened.** I20: M1 reverts only `candidatesFor`'s coercion → 6 failures; M2 makes `finish()` fold unproven Legs into the sum → 1; M3 makes `metrics.js` fold NULL rounds back to `"0"` → 2. E-7: **M4** makes the composer unconditional again → 3 failures; **M5** makes the probe's outer `catch` fail-*open* → **SURVIVED**, because `resolved()`'s inner try/catch meant no register probe ever reached that catch — recorded, test strengthened with a throwing `Proxy` context, **M5 re-run and killed**. **Every file restored and byte-verified** (`diff -q`) |
| `npm run gates` | **exit 1 — 7 PASS, 1 FAIL** (`gate:composition`, `coordinator`). **Unchanged**, and still RED after E-7 by design. `gate:tiers` 290 modules / 434 edges, `gate:tenets` 287, `gate:legacy` 347 files *(was 289 / 432 / 286 / 346 — one new module, one new test file)* |
| `gate:params` | **PASS** — 192 modules against 250 registered parameters, no bare behavioural constants. The N13 correction introduced none |
| `npm run routing:readiness` | **OVERALL: BLOCKED**, D1/D3/D8 all BLOCKED, exit 0. **Unchanged** |
| Registry | 19 workers · **9 named cadence parameters, all of which exist** · **0 fictional** *(was 11)* · 10 with a `cadenceNote`. `src/workers/` now holds **22** `.js` files *(was 21)*; `coordinatorPipeline.js` registers no worker, so the registry count is unmoved |
| Source digest | **`1b301e285ad7dcd056439c83d24275a9a30a7e2900b1828855ee940250e32ff5` / 576 files** *(`d033038cb261c3de…` / 573 → `4d94ef18…` / 574 at commit `2b367e4` → this, after E-7)* |
| Working tree | Commits so far: `9e1d871` (the X7 pass, previously uncommitted), `2b367e4` (I20 + N13 + this document), `cb6517b` (§J), and E-7 pending commit. **Nothing pushed** |
| §24 gate table | **Untouched.** 8 blocking gates still not green; B1, B8, B-P, B-O, B-M, X3, A9 all where they were. **RELEASE: BLOCKED** |

### J.0 THIS PASS — 2026-09-04, E-8 and E-8b

| Check | Result |
|---|---|
| `npm test` | **exit 0 — 165 suites / 7 336 tests / 0 failures / 0 skips** *(164 / 7 307 before this pass; 165 / 7 330 after E-8; 165 / 7 336 after E-8b)* |
| New regression suite | `tests/engine/planTerrainAndSpreadProvenance.test.js` — **22 passed** |
| `tests/engine/coordinatorPipelineRequirements.test.js` | **23 passed** *(was 17)* — six new, pinning E-8b's measured before/after |
| Mutation testing | **4 built, 4 killed on the first run.** M6 restores `legProfiles`' terrain coercion → 2 failures; M7 restores both spread coercions in `timeline.project` → 3; M8 disables the timeline terrain guard → 3; M9 makes `buildEntry` accept a negative climb → 1. **All three modules restored and byte-verified** (`diff -q`) |
| `npm run gates` | **exit 1 — 7 PASS, 1 FAIL** (`gate:composition`, `coordinator`). **Unchanged, and not claimed otherwise.** E-8 and E-8b do not move it |
| `npm run routing:readiness` | **OVERALL: BLOCKED**, D1/D3/D8 all BLOCKED, exit 0. **Unchanged** |
| Coordinator contract | **14 declared inputs, unchanged.** At a real promotion context: **10 missing** *(was 12 before E-8b)* — `EXTERNAL_ROUTING` 4 · `REGISTER_UNRESOLVED` 3 · `NO_PRODUCER` 2 · `PROCESS_DEPENDENCY` 1 |
| Source digest | **`011049f7a504fa70d05bfc2e87a662f897cefdf4fbd5a58b3e861fff5eba3b42` / 577 files** *(`1b301e28…` / 576 at `27d3470` → this)* |
| Commits | `e38fe5b` (E-8), `8910818` (E-8b), and this document. **Nothing pushed** |
| §24 gate table | **Untouched.** B1, B8, B-P, B-O, B-M, X3, A9 all where they were. **RELEASE: BLOCKED** |
| Formal verification | **Nothing re-run and nothing changed.** `commitment_c1` and `lifecycle_c1` still close exhaustively — §G.1's V1-VERIFICATION condition remains met. §7.3a item 8, *boundedness accepted*, is **still unsigned**: see §J.3 |

### J.1 The truthfulness audit — *does the repository now do what we claim V1 does?*

**Not yet, and the claim is not being made.** V1 is defined in §I.1 as a request traversing the
engine end to end, and it cannot: the coordinator's solve path is not composed. **Three of eight
stop conditions are met** (S-1, S-2, S-8). What this pass did was remove every V1 obstacle that was
*this repository's to remove*, and make the rest **measurable instead of estimable**.

**The most useful thing this pass produced is not a fix.** It is that S-3 — the one remaining V1
blocker — went from a hand-audit that said *"four values"*, to a second hand-audit that corrected it
to *"four plus five more"*, to **a list the code computes and a future reader can re-run**. Both
hand-audits were confident and both were wrong, in the same direction, for the same reason: they
stopped at whichever seam they happened to reach. **A programme that has mis-stated its own
remaining work twice in one day should stop asserting it and start measuring it**, and
`coordinatorPipeline.requirements()` is that measurement.

**A correction this pass made to a claim the canonical documents had carried since Phase 15:**
*"the remaining composition-root work is released by B1, not by a commit."* B1 releases **three of
nine**. Three more are `null` register entries belonging to §22.4's calibration owner, and three are
input families with no schema column and no code — **released by no external decision at all**.
Anyone acting on the old sentence would have waited for B1 and then found the gate still red.

**What would have been false to claim, and is not claimed:** that V1 works end to end; that
`gate:composition` can be made to pass from here; that B-M, B1, B8, B-P or B-O moved; that the
release evidence is current; that a routing source exists; or that any independent sign-off was
obtained. **On a solo project the separate safety engineer, frozen-specification owner and release
owner of §7.6 do not exist as distinct individuals, and none was simulated or inferred.**

### J.2 The exact finite remaining V1 blocker

> **S-3 — MEASURED, not estimated.** E-7's probe produces it; §E.1 carries the table. Nine
> inputs, in three classes, and **the class is the actionable part**:
>
> | Class | Who closes it | Inputs |
> |---|---|---|
> | `EXTERNAL_ROUTING` | **the owner** | `route(parts)` · `travelSdSeconds` source (N29) · per-profile `speedMetresPerSecond` |
> | `REGISTER_UNRESOLVED` | **§22.4's calibration owner** | `candidate.max_radius_by_sla_class` · `plan.service_time_prior` · `energy.model_residual_cv` |
> | `NO_PRODUCER` | **Engineering + a named data source** | `terrainByStop` · `environment.ambientC`/`packC` · `masses.vehicleMassKg` |
>
> **UPDATED 2026-09-04.** The `EXTERNAL_ROUTING` row is now **four**, not three: E-8 moved hop
> terrain (`climbM` / `descentM` / `stopStartCycles`) out of `NO_PRODUCER` and onto the `route`
> contract, because §14.2 states those terms over the traversal and the router is their producer.
> `NO_PRODUCER` is correspondingly **two**. The total is unchanged at nine external inputs, and the
> *classes* — the actionable part — are now right where two of them were not.
>
> Plus **E-7's own remaining half**: the assembly bodies, which are repository-owned and
> deliberately unwritten until the inputs exist. **§E.4 re-derives that decision against the tree
> and it holds** — with the added measured fact that `commit`'s own dependency chain bottoms out in
> the same unwritten code, so building the assembly would not even close the process dependencies.

### J.3 The formal-verification acceptance V1 does not grant itself

§G.1's V1-VERIFICATION condition is **met and unchanged**: `commitment_c1` (17 991 520 states /
2 375 660 distinct / diameter 21) and `lifecycle_c1` (777 942 / 187 289 / depth 43 / 0 on queue,
`Safety` + `TerminalIsFinal` + `Liveness` all PASS) both close exhaustively on the configurations as
checked in. **Nothing was re-run this pass and no `.cfg` or property definition was touched.**

**What is not granted, and is not being granted here:** `PHASE_15_BM_TLC_RUN_RECORD.md` §15.10 item
8 — *boundedness accepted* — records `MaxTicks = 3` as **unchanged and still unsigned**. That is an
**owner acceptance** of a global tick budget over 2 Legs, and §22.3's reasoning applies: an
automated process must not sign it. It is recorded in §F as an owner decision and **this document
does not treat it as met**. Capacity 2/3 chaining evidence remains Tier-2 / Phase-16 territory and
the V1 contract does not require it.
>
> *(This row first said "four values", then "at least four plus five more". Both were hand-audits
> and both were wrong. **The list above is the one the code computes**, and re-running
> `coordinatorPipeline.requirements()` is how a future reader checks it rather than trusting it.)*
>
> S-4 and S-6 are mechanical consequences of S-3. S-5 is a configuration act requiring no code.
> S-7 follows from S-4. **There is no V1 work outside S-1…S-8**, and the boundary did not move
> when S-3's contents turned out to be larger than the first measurement of them.

---

## SECTION K — THE OWNER-INPUT REQUEST (2026-09-04)

> **CORRECTED THE SAME DAY BY §L.2 — read both.** This section's *shape* is right and its
> *content* is incomplete. Every row below is still true; the list is not closed. Building
> the assembly (§L) raised the contract from 14 declared inputs to **33**, and the unresolved
> set at a real promotion from 10 to **25**: one further routing input (`timeBucket`), twelve
> further register entries, three further families with no producer — and it removed the one
> `PROCESS_DEPENDENCY` (`commit`), which the composition now builds.
>
> **§L.3 additionally corrects two of §K.3's four "do not ask the owner for" rows**: D1's
> serviceable region and the charger estate are V1 *runtime* prerequisites at the feasibility
> gate, even though §D.3 is right that neither is a *search* prerequisite.
>
> **This row has now been corrected four times, always in the same direction, always for the
> same reason: each count was taken at whichever seam the reader reached.** §L.2's is the
> first taken by code that runs the whole path. It is offered as the current measurement and
> not as a closed set, and `coordinatorPipeline.requirements()` remains the way to check it.

**This is the boundary V1 execution stops at.** Every row is produced by
`coordinatorPipeline.requirements()` run against the context `server.js` builds — not by a
hand-audit. Re-run it to check this table rather than trusting it.

**Nothing here may be defaulted, inferred, or filled in by this repository**, and every row's
"when absent" column is the behaviour that is *already implemented*, not a behaviour to add.

### K.1 The ten unresolved inputs

| # | Field | Type / unit | Why V1 needs it | Source / owner named by the specification | Where it enters the runtime | When absent | Blocks E2E? |
|---|---|---|---|---|---|---|---|
| 1 | `route(parts)` | `async ({originCell, destCell, profileKey, timeBucket}) => {…}` | Every hop of every plan. Without it no candidate can be priced at all | **B1** — the project owner, on D1/D3/D8 | `leaderWorkers.create({ route })` → `cellPairCache.read` on a cache miss | `cellPairCache.read` returns *"no router is available and the entry is not cached"* | **YES** |
| 2 | `distanceM` | `number ≥ 0`, metres | §14.2's `β_dist · d`, the dominant term on flat ground | with (1) | `cellPairCache.buildEntry` | entry **refused**, nothing cached | **YES** |
| 3 | `travelSeconds` | `number ≥ 0`, seconds | The ETA point estimate the timeline projects from | with (1) | `cellPairCache.buildEntry` | entry **refused**, nothing cached | **YES** |
| 4 | `travelSdSeconds` **(N29)** | `number ≥ 0`, seconds | §8.4 prices `p_late` *"from the ETA predictive distribution, not the point estimate"*. **No shortlisted engine returns a spread** — OSRM's `table`, Valhalla's `sources_to_targets` and GraphHopper's `route` are all point estimates — so this needs a **declared** source and selecting an engine does not supply it | the project owner | `cellPairCache.buildEntry` | entry **refused**, nothing cached | **YES** |
| 5 | `climbM`, `descentM` | `number ≥ 0`, metres, per hop | §14.2's `β_climb · Σ max(0,Δh)` and its regeneration counterpart. **New to the contract at E-8** — see §E.2 | the same traversal source as (1). Valhalla and GraphHopper can return elevation; **OSRM cannot** | carried by `cellPairCache.buildEntry`, **required** by `plan/timeline.project` | `timeline.project` refuses: *"the hop's terrain is unresolved"*; `legProfiles` then refuses with `MISSING_TERRAIN` | **YES** |
| 6 | `stopStartCycles` | `number ≥ 0`, count, per hop | §14.2's `β_stop_start · n_stop_start_cycles` — *"urban stop-go consumption is not a function of distance"*. **No shortlisted engine returns it**, so like (4) it needs a declared source | the same traversal source as (1) | as (5) | as (5) | **YES** |
| 7 | `speedMetresPerSecond` per routing profile | `number > 0`, m/s | §20.3's intra-cell quantisation correction is applied *at the profile's own speed*, and `applyIntraCellOffset` refuses without it. The only `MobilityModel` in this repository is a seed whose `speedModel` is a note deferring to **D3** | **D3** — Product + Fleet Engineering | `leaderWorkers.create({ speedMetresPerSecondFor })` → `cellPairCache.applyIntraCellOffset` | correction **refused**; the cached pair is not usable | **YES** |
| 8 | `candidate.max_radius_by_sla_class` | register entry, metres, per SLA class | §6.3 requires the k-ring expansion to be bounded by a radius **or** a wall-clock budget; with neither, `expandCandidates` **refuses outright** (`unbounded_search_refused`) to preserve §6.1's bounded-work property (T9). `required: true` with **no default**, on purpose | **§22.4's calibration owner / Operations** | published config version → `snapshot.resolve(name, { sla_class })` | expansion refuses; zero candidates | **YES** |
| 9 | `plan.service_time_prior` | register entry, seconds | `planBuilder.resolveServiceTimes` fails closed without it and `buildVariant` returns before projecting a timeline | **§22.4's calibration owner** | as (8) | `MISSING_SERVICE_TIME` | **YES** |
| 10 | `energy.model_residual_cv` | register entry, dimensionless CV | `consumption.predictiveDistribution` needs it to turn a mean consumption into the distribution §14's reserves are held against | **§22.4's calibration owner.** **Safety class** — §22.3 forbids an automated process from choosing it, and **no provisional route exists for it** | as (8) | `MISSING_ENERGY_INPUT` | **YES** |
| 11 | `environment.ambientC` / `packC` | `number`, °C | `consumption.betaThermal` evaluates the model's ambient and pack curves at these two temperatures | **Engineering + a declared weather snapshot / agent telemetry source.** No Prisma column, no producer in `src/` | `leaderWorkers.create({ environmentFor })` → `legProfiles` | `legEnergyWh` refuses: `profile.ambientC`, `profile.packC` | **YES** |
| 12 | `masses.vehicleMassKg` | `number > 0`, kg, per agent class | `legProfiles` needs the vehicle's own mass. **`AgentClass.totalMassLimitKg` is a *limit*, not a mass**, and reading a limit as a mass would overstate consumption on every candidate equally — an error that looks conservative and is simply wrong | **Engineering + the fleet's own specifications.** No mass column exists | `leaderWorkers.create({ vehicleMassKgFor })` → `legProfiles` | `legEnergyWh` refuses: `profile.vehicleMassKg` | **YES** |

*(Rows 2–6 are fields of the single `route` contract in §F.2 and are listed separately because they
have different availability across the shortlisted engines. The probe counts them as **four**
requirement rows — `route`, `travelSdSeconds source (N29)`, `speedMetresPerSecond`, `hop terrain` —
which is why `EXTERNAL_ROUTING` reads 4 and not 12.)*

### K.2 The two owner **decisions** — distinct from the inputs above

| Decision | Owner | Exact act | Why V1 needs it | What this repository has already done |
|---|---|---|---|---|
| **A staged V1 operating region** | Owner | Publish a config version binding `cutover.engine_enabled = true` at **`region`** scope, pin it, and run the process with `ENGINE_ENABLED=true`. **Both halves are required** — `forShard` ANDs them | Without it `task.service.assignTask` returns **503 `ENGINE_NOT_LIVE`** and nothing is written. That is §22.4's designed fail-closed staging, not a defect | **The mechanism exists and was verified live this pass** (§I.3). **No code change is needed.** The register default is `false` and this document does not change it |
| **Boundedness acceptance: `MaxTicks = 3`** | Release owner (§7.6) | Sign, or decline, `MaxTicks = 3` as the **global** tick budget over 2 Legs in `lifecycle_c1` | §7.3a item 8. `commitment_c1` and `lifecycle_c1` both close exhaustively with every declared property passing; the budget under which they close is unsigned | **Nothing was re-run and nothing was weakened.** No `.cfg` changed, `CHECK_DEADLOCK` is absent from all six, every property definition is byte-identical. **This document does not treat it as accepted** |

### K.3 What the owner must **not** be asked for

Recorded so that a later reader does not widen this request back out:

- **Not a routing-engine procurement decision.** B1 Steps 1/3/4/5 and the selection ADR are a
  *release* artefact (§F.1 A). V1 needs a **declared traversal source**, not a vendor.
- **Not the D1 H3 cover, boundary polygon, CRS or charger estate.** §D.3 establishes that a
  k-ring-bounded expansion (`candidate.max_expansion_tiers ≤ 2`) runs from
  `cells.cellForPoint(lat, lon, FINE)` with no declaration at all.
- **Not production calibration** of `plan.service_time_prior` or `candidate.max_radius_by_sla_class`
  — a declared provisional value with a named author is enough for V1. **`energy.model_residual_cv`
  is the exception**: it is Safety-class, and **no provisional route is offered for it here**.
- **Not the 39 Safety-class B8 parameters, the soak, the shadow window, the fidelity study or any
  §7.6 attestation.** Those are V2 and §G lists them with the reason.


---

## SECTION L — E-9: THE COMPOSITION, BUILT (2026-09-04)

**Owner decision, this pass:** build the minimum real composition root now — verify each
dependency contract directly, compose the existing implementations, test the wiring, test
that missing external inputs fail closed, and **do not** claim an end-to-end assignment.

That is what was done. **The repository-owned "unwritten composition" boundary is closed.**
What follows is what the assembly measured on its way, and every row of it is produced by
code a reader can re-run rather than by a trace a reader must trust.

### L.1 What was built

| File | What it is |
|---|---|
| **`Backend/src/workers/coordinatorSolvePath.js`** (new, ~840 lines) | **The assembly.** `create(context)` refuses, or returns the exact `deps` object `coordinator.worker.runRound` destructures |
| **`Backend/src/engine/domain/mappers/decisionInputs.js`** (new) | `energyCoefficientsFrom` and `fleetBestCaseFrom`, moved out of `diagnostics.controller.js` because a **second** caller now exists. Two mappings of one schema are free to disagree after a migration |
| `Backend/src/workers/coordinatorPipeline.js` | The contract, extended by what the assembly proved it reads: **14 rows → 33** |
| `Backend/src/workers/leaderWorkers.js` | `COMPOSERS.coordinator` now *attempts the construction* and **starts the worker** when every input resolves |
| `Backend/server.js` | `runSerializable`, `selectForUpdate`, `isSerializationFailure` — the three seams `commit` is built from. The E-8b `snapshot` accessor is **unchanged and pinned by a test** |
| `Backend/src/controllers/diagnostics.controller.js` | Uses the shared mappers instead of its private copies |
| `Backend/tests/engine/coordinatorSolvePathComposition.test.js` (new) | 42 tests, in six groups |

**The exact production dependency graph, as assembled:**

```
coordinator.worker.runRound(deps)
  ├── deps.planState        shard/planState.create({shardId}), wrapped so `beginRound`
  │                         clears the round's pinned plans (§9.6 req. 4–5)
  ├── deps.expansionInputFor(row)          ← the WorkQueue row's own fields, synchronously
  ├── deps.expandCandidates(input)
  │     └── candidates/expansion.expandCandidates
  │           ├── rates            ← cost/exchangeRates.ratesFrom(snapshot)
  │           ├── delayParameters  ← delayParametersFrom(snapshot)   [STRICT: no coalescing]
  │           ├── correction       ← candidates/omega.combinedCorrection
  │           ├── fleetBestCase    ← domain/mappers/decisionInputs.fleetBestCaseFrom(rows)
  │           ├── deadlineMs/elapsedMs ← solve.time_budget  (§6.3's wall-clock half)
  │           ├── loadAgentSnapshot ← prisma.agentCellPosition + agent + class + battery
  │           ├── availabilityIndex.candidatesInFineCell(kv, …)
  │           └── evaluateExact(agentId, leg, agentSnapshot)          ← THE ASSEMBLY
  │                 ├── routing/cellPairCache.hopsFor({kv, route})    ← injected `route`
  │                 │     └── + a per-pairing (from,to) memo → `hopsForSequence` (§13.4)
  │                 ├── plan/planBuilder.build(planInputFor(…))
  │                 │     ├── payload   ← payloadFor(leg.manifests)   [§15, schema-backed]
  │                 │     ├── usableWh  ← energy/usable.fTemp(model, packC) → startingUsableWh
  │                 │     └── energy / masses / environment ← register + injected seams
  │                 ├── feasibility/evaluate.gate(plan, …)            ← the ONLY brander
  │                 └── plan/column.make + column.price(phiInputFor(…))
  │                       └── cost/phi.evaluate → cDirect · cRisk · cLifecycle · cPolicy · cDelay
  ├── deps.pricedCandidateFor(agentId, legId)  ← the memo, keyed `legId|agentId`
  └── deps.commit(assignment, roundResult)
        └── commitment/commit.commit
              ├── runSerializable / selectForUpdate       ← server.js
              ├── volatileRecheck ← volatileSubset.createVolatileRecheck({ buildContext })
              │     └── buildContext: locked rows → evaluation context, on the MEMOISED plan
              └── sideEffects     ← dispatch/offers.enqueueOffer(tx, …)  [§10.3.2 step 5]
```

**Not injected, deliberately:** `deferPriceFor` (`cost/cDefer.js` is Tier 2 behind the
`deferral` kill switch), `tierZeroAgentIds` (chaining, Tier 2), and the tier 3/4/6 cover maps
(§D.3 — an empty array would claim "this zone contains no cells", which is a different and
false statement from "no cover is published"). `gate:tiers` **PASSES**: 292 modules, 456
edges, no Tier 0/1 → Tier 2 dependency.

### L.2 What the assembly measured — S-3 is materially larger than §K records

**This is the finding, and it is the third correction in the same direction for the same
reason.** §F derived S-3 from the routing seam and said four values. §F.0 corrected it to
nine by reading `planBuilder`. E-7 made it a probe. **Writing the assembly walked one seam
further — into `cost/phi.evaluate` — and found the probe itself was short.**

| Class | §K.1 (E-7/E-8b) | **Measured now** | What the assembly walked into |
|---|---:|---:|---|
| `EXTERNAL_ROUTING` | 4 | **5** | `timeBucket` — §20.3 keys a cell-pair entry on the congestion bucket and `cellPairCache.key` refuses without one. **No producer in `src/`** |
| `REGISTER_UNRESOLVED` | 3 | **15** | Every `C_direct`/`C_risk`/`C_lifecycle`/`C_delay` rate is its own refusal. All twelve new ones are `required: true`, `default: null`, `UNCALIBRATED` |
| `NO_PRODUCER` | 2 | **5** | `p_fail` (§8.3.1 — `src/engine/reliability/` holds one `.gitkeep`), `route_hazard_cost` (§5.2's Map service — a consumer exists, no client), §14.4's battery wear inputs (no wear-curve column) |
| `PROCESS_DEPENDENCY` | 1 (`commit`) | **0** | `commit` is now **composed**, not required; the three seams it needs are supplied by `server.js` |
| `ADMISSIBILITY` | 0 | **0** | Unchanged |
| **Total unresolved at a real promotion** | **10** | **25 of 33** | |

**The twelve register parameters E-7's probe did not name**, every one measured `null` on
`service.defaultSnapshot()`: `cost.energy.cu_per_wh` · `cost.wear.cu_per_metre` ·
`cost.failure.cu` · `cost.staleness.cu_per_second_age` · `cost.energy_consequence` ·
`cost.sla.cu_per_second_late` · `cost.sla.breach_penalty` ·
`lifecycle.cu_per_actuator_cycle` · `lifecycle.cu_per_braking_event` ·
`lifecycle.cu_per_gradient_metre` · `lifecycle.cu_per_thermal_stress_second` ·
`cost.battery.cu_per_equivalent_cycle` · `energy.reserve_floor_wh`. Two are **Safety class**
(`energy.reserve_floor_wh`, `energy.model_residual_cv`) and §22.3 offers them no provisional
route. **Nothing here is a proposed value.**

### L.3 Three corrections to this document, each with its evidence

**L.3.1 — `candidate.max_radius_by_sla_class`: E-8's classification is preserved, and the
probe was wrong.** Instruction 10 asked which of two readings was right. Neither document was:
§6.3 states *a radius **or** a wall-clock budget*, `expandCandidates`'s guard is
`!hasRadiusBound && !hasClockBound`, and **the probe asked for the radius alone** — a conjunct
neither the specification nor the code states. The composed path resolves `solve.time_budget`
(registered, `unit: ms`, resolves to 250) and supplies `deadlineMs`/`elapsedMs`, so **the
search terminates without the parameter and E-8's non-blocking classification holds.** The
probe now encodes the disjunction; `contextFor()` resolves the clock half; a test asserts the
row is unsatisfied on a bare snapshot and satisfied on the enriched one. *(What the wall clock
does **not** supply is §6.3's **containment** limit: a clock-bounded search is bounded in work
and unbounded in distance. That remains Operations' policy statement, and it is now stated as
one rather than as a blocker.)*

**L.3.2 — §D.3 and §K.3 stopped one seam short: D1's serviceable region IS a V1 runtime
prerequisite.** §D.3 established that a k-ring-bounded *expansion* needs no published cover,
and that is correct. The conclusion drawn from it — §K.3's *"the owner must not be asked
for the D1 H3 cover, boundary polygon, CRS or charger estate"* — does not follow. **F33
requires every endpoint to be a well-formed coordinate inside the serviceable region** and
**F35 requires a charger reachable with `E_return` intact**; both declare `DENY`. The cover
is not a *search* prerequisite and it is a *gate* prerequisite.

**L.3.3 — the charger estate is not `RESIDUAL`; it is blocking.** §F.0 recorded
`charging.chargerCandidates` as *"empty is survivable — a charging stop is attempted only
when reserves fail, and `NO_FEASIBLE_INSERTION` is a priced result, not a crash"*. Both
sentences are true and the classification does not follow. With no charger estate,
`eReturn.evaluate` resolves no return leg, `reserves.compose` refuses — §14.5 calls a zero
return reserve *"a reachability question nobody answered"* — and therefore **no plan holds
its reserves, for any agent, at any state of charge.** Measured, and pinned by a test.

### L.4 The largest finding — §7.5's gate cannot resolve its own inputs

**Measured by running the shipped gate against a candidate assembled from this repository's
own schema**, with `collectAll` so the answer is the whole set and not whichever predicate
denied first:

> **35 of 38 predicates deny. Every single one is `INDETERMINATE`. Not one is `VIOLATED`.**

Nothing about the agent or the plan breaks a rule — **the gate cannot see the facts it is
required to check.** The denials group by the predicates' own `inputSource`:

| Source | Count | Examples |
|---|---:|---|
| `CONTROL_PLANE` | 16 | commissioning record (**F1**), supported firmware set, certification validity, tenant/fleet scope |
| `SENSOR` | 6 | emergency stop, blocking faults, telemetry freshness |
| `PLAN` | 5 | latest feasible start, cooloff/reassignment budget, §14.5's tier probabilities, charger reachability |
| `ROUTING` | 2 | envelope constrictions, time-of-day restrictions |
| `CONFIG` | 2 | intervention-rate bound, capacity/horizon |
| `OPERATOR` · `INFERRED` · `EXTERNAL_SUBSYSTEM` · `MAP` | 1 each | holds/quarantine · health tier · third-party reservations · serviceable region |

**F1 is first in §7.5's cheapest-first order and it denies**, on `agentSnapshot.commissioning`
— a control-plane fact with **no schema column and no producer anywhere in `src/`**. Its own
text says why that ends the evaluation: *"an uncommissioned agent has no validated
configuration, so no other predicate's inputs are trustworthy."*

**And the two *admitting* policies deny too.** `ADMIT_WITH_PENALTY` and
`DENY_UNLESS_ENVELOPE` are the two seams §7.3 provides for letting an unknown through under
a price, and both refuse here because the inputs *they* need (`cost.uncertainty_penalty`, a
reduced-envelope evaluation) are themselves unresolved. **UNKNOWN IS NOT PERMISSION holds all
the way down**, which is the system behaving exactly as designed and is also why no candidate
can be priced today.

**This was invisible to every prior audit** because every prior audit stopped at
`planBuilder`, and §7.5's gate is one seam further. It is reported, not fixed: supplying any
of these would be fabricating the fleet's own facts.

### L.5 What the tests prove, and what they do not

**42 tests, in six groups.** The file's header states the limit before its first assertion.

| | Proves |
|---|---|
| **A — composition** | The real `expandCandidates` (asserted by the §6.1/§6.4 result shape, incl. `achievedGapProven`), the real `evaluateExact` (the gate, Plan Builder and Φ all reached), the routing dependency **through the seam** (the injected `route` receives §20.3's four key components), `pricedCandidateFor` returning the memo, `commit` opening §10.3.2's serialisable transaction and aborting on step 1, the composer starting the worker, and `server.js` still passing the pinned snapshot (E-8b) |
| **B — missing routing** | With no `route`, `create()` builds **nothing** — `deps` is `undefined`, not a pipeline that declines — the composer starts no worker, no commitment is reachable, and the refusal names `route` as `EXTERNAL_ROUTING` |
| **C — missing energy input** | Through the **real** `planInputFor` + `planBuilder.build`: an omitted `energy.model_residual_cv` → `MISSING_ENERGY_INPUT`; omitted ambient/pack → refused; omitted vehicle mass → refused; omitted hop terrain → refused at `timeline.project` with all three field names; and the composed input carries `null`/`undefined` for every absent seam rather than a value |
| **D — component contracts** | `delayParametersFrom` refuses on the published register and substitutes nothing; `contextFor` resolves §6.3's clock half; the routing seam names *"no router is available"*; `payloadFor`'s observed-over-declared precedence and its refusal to partially sum; the agent snapshot carrying no stand-in for an absent battery row |
| **F — the gate** | §L.4, as a re-runnable measurement |
| **E — no false claim** | On the published register the assembly **refuses**, and `gate:composition`'s declarative row is untouched |

**What they do NOT prove**, stated in the file and here: that a request is assigned, that a
commitment is written, or that any priced number is right. Every green test in groups A, C and
F runs against a snapshot with fifteen register parameters overridden **in one object** and a
labelled router-shaped double. **S-6 is untouched and nothing in that file may be cited
against it.**

**Mutation testing: 5 built, 4 killed on the first run, 1 survived and was re-killed.**

| | Mutant | Result |
|---|---|---|
| **M10** | `create()` builds the assembly even when requirements are unresolved | **KILLED** — 8 failures |
| **M11** | per-Leg state collapsed back to one slot | **KILLED** — 1 failure |
| **M12** | a plausible vehicle mass (50 kg) and ambient/pack temperature (20 °C) substituted | **KILLED** — 3 failures |
| **M13** | absent SLA/aging rates coalesced to zero, as the diagnostics endpoint does | **KILLED** — 2 failures |
| **M14** | an unpriceable candidate admitted at `gammaMilliCU: 0n` | **SURVIVED**, then killed |

**M14's survival is recorded rather than presented as a kill**, following the M5 precedent.
Zero is not a neutral placeholder there: it is the *cheapest possible* price, so an
unpriceable candidate admitted at zero wins every solve it enters. It survived because **the
branch is unreachable through the whole pipeline** — §L.4's gate denies at F1 before pricing
is attempted — so no test had executed it. A unit test of that one branch was added, with
`feasibility.gate` and `column.price` spied and labelled as such in its own body, **M14 was
re-run against it and killed**, and the module was restored and byte-verified (`diff -q`).

### L.6 A defect found in this assembly while writing it, fixed, and pinned

The first draft held the round's per-Leg state — the Leg row, its version, its manifests, its
Ω correction — in **one slot**, overwritten by each `expandCandidates` call. Correct for a
batch of one; silently wrong for a batch of two, because `round.execute` commits **after** the
whole batch is planned, so every commit would have named the last-expanded Leg's row id,
version and expected state. **That is a real commitment written against the wrong Leg,
reporting success.** State is now keyed by Leg, cleared at `planState.beginRound` — the signal
the coordinator already sends — and both properties are pinned by tests. **M11 is the mutant
that reverts it.**

### L.7 Final verification of this pass

| Check | Result |
|---|---|
| `npm test` | **exit 0 — 166 suites / 7 379 tests / 0 failures / 0 skips**, 475 s *(165 / 7 336 before)* |
| New suite | `tests/engine/coordinatorSolvePathComposition.test.js` — **42 passed** |
| `tests/engine/coordinatorPipelineRequirements.test.js` | **24 passed** *(was 23)* |
| Mutation testing | **5 built, 4 killed first run, 1 survived → test strengthened → re-killed.** Module restored and byte-verified |
| `npm run gates` | **exit 1 — 7 PASS, 1 FAIL** (`gate:composition`, `coordinator`). **Unchanged, and not claimed otherwise.** `gate:tiers` 292 modules / 456 edges *(was 290 / 434)*; `gate:params` 193 modules; `gate:legacy` 349 files |
| `npm run routing:readiness` | **OVERALL: BLOCKED**, D1/D3/D8 all BLOCKED, exit 0. **Unchanged** |
| Coordinator contract | **33 declared inputs** *(was 14)*. At a real promotion: **25 missing, 8 satisfied** — `EXTERNAL_ROUTING` 5 · `REGISTER_UNRESOLVED` 15 · `NO_PRODUCER` 5 · `PROCESS_DEPENDENCY` **0** |
| Source digest | **`22afc5b1a83634899ad5dce7ccedad6f779afc085ca939f8f9e0c40bc28aead6` / 580 files** *(`011049f7…` / 577 before)* |
| §24 gate table | **Untouched.** B1, B8, B-P, B-O, B-M, X3, A9 all where they were. **RELEASE: BLOCKED** |
| Formal verification | **Nothing re-run and nothing changed.** No `.tla` or `.cfg` touched |

### L.8 S-4 and S-6, stated exactly

**S-4 — NOT MET, and its content has changed.** S-4 reads: *"the coordinator's solve path is
composed at `server.js` from those values, and `COMPOSERS.coordinator` returns a started
handle; `gate:composition` exit 0."* **The composition now exists and the composer returns a
started handle when its inputs resolve** — proven by test. It does not resolve them on this
register, `gate:composition` is still RED, and **S-4 is not met.** What changed is that S-4 is
no longer waiting on code: it is waiting on S-3, exactly as §I.2 said it would be.

**S-6 — NOT MET, NOT ATTEMPTED, AND NOT CLAIMED.** No request has traversed the engine, no
`Commitment` row has been written, and `tools/verify/v1CorePath.js` has not been built —
building it would produce a harness that can only report the same refusal. **No result in
this pass may be read as end-to-end evidence.**

### L.9 The exact remaining V1 boundary

> **A. Composition implemented and verified; V1 remains blocked only by legitimate
> external/owner inputs.**
>
> **No repository-owned V1 composition defect remains.** Every collaborator
> `coordinator.worker.runRound` takes is constructed by production code, from the shipped
> modules, and starts when its inputs resolve. The one defect this pass found in that code
> (§L.6) was found, fixed, mutation-tested and pinned within it.
>
> What remains is **25 inputs in three classes**, none of which this repository may supply:
> five routing, fifteen register entries belonging to §22.4's calibration owner, and five
> families with no producer — **plus** §L.4's 35 gate inputs and §L.3's two corrections,
> which are new information for the owner and are not additions to the stop condition.
>
> S-1, S-2 and S-8 are met. S-3 is open. S-4, S-6 and S-7 follow from it. S-5 is a
> configuration act needing no code.

---

**TRUTH > GREEN.** V1 is a smaller, honest claim than Phase 15's release — not a weaker one.

# Runbook — V1 engineering demonstration

> ## THIS IS A WORKING ENGINEERING DEMONSTRATION.
> ## IT IS NOT PRODUCTION CERTIFICATION, AND IT IS NOT PROOF OF S-5 PRODUCTION ENABLEMENT.
>
> Nothing in this runbook discharges a V1 stop condition, turns a §24 release gate green, or
> licenses a production cutover. **The V1 score is 3 of 8 before this runbook and 3 of 8 after
> it** (`../v1/V1_IMPLEMENTATION_CONTROL.md` §7), and Phase 15's verdict is unchanged:
> **IMPLEMENTATION CLOSED · RELEASE BLOCKED** (`../phase15/PHASE_15_MASTER.md` §3).
>
> Every command below is one this repository already shipped. **This runbook adds no code, no
> fixture, no seed value and no npm script** — it is a reading order over checks that already
> exist, so that the engine can be shown working without anything being invented to make it
> look better than it is.

**Risk level: NONE to production.** Step 5 builds a *disposable* PostgreSQL cluster on a
non-default port and writes only to it. No step touches Neon, the local 5432 cluster, any
production configuration, or any release evidence.

For the cutover procedure itself see [`cutover.md`](cutover.md); for reversal see
[`rollback.md`](rollback.md). **Neither is part of this demonstration and neither may be run
from it.**

---

## 0. What this runbook is for

The RobotX assignment engine is implemented, tested, and **cannot be started in production**,
because the routing source, fifteen calibration values and six input families that its
decision path requires do not exist and are not this repository's to supply. That is a true
and defensible state, and it is not the same thing as having nothing to show.

This runbook is the strongest **honest** path through the engine that the current tree can
execute end to end. It walks:

```
input  →  assignment / decision logic  →  safety, degradation and cost reasoning  →  output / explanation
```

using **only** existing fixtures, existing controlled test inputs, and the existing
non-production verification harness. **No production input is fabricated at any step**, which
is why two of the six steps end in a deliberate, named refusal rather than a success — and why
those two are the most informative steps in the sequence.

### 0.1 The one rule for presenting this

**A refusal in step 4 or step 5 is the demonstration succeeding, not failing.** `gate:composition`
exits 1 and the core-path harness exits 1, by design, on this tree. Presenting either as a
failure misdescribes it; presenting either as a pass would be the fabrication the whole
programme exists to prevent.

---

## 1. Prerequisites

| # | Prerequisite | How to check | Needed by |
|---|---|---|---|
| 1 | Node.js and npm | `node --version` · `npm --version` — verified on **v22.17.0** / **11.12.1** | all steps |
| 2 | Dependencies installed | `npm ci` from `Backend/` | all steps |
| 3 | Clean working tree | `git status --porcelain` prints nothing | all steps (so the run is attributable to a tree) |
| 4 | PostgreSQL **18.3** binaries | `"C:\Program Files\PostgreSQL\18\bin\postgres.exe" --version` | **step 5 only** |
| 5 | Port **55432** free | `Get-NetTCPConnection -LocalPort 55432` returns nothing | **step 5 only** |

**All commands are run from `Backend/`** unless stated otherwise.

**Steps 1–4 and 6 need no database at all.** If PostgreSQL is unavailable, run those five and
say so — the sequence is still coherent, and step 5 is the only one that observes the running
system rather than the modules.

---

## 2. The demonstration, in order

### Step 1 — the baseline: the whole suite is green

```
npm test
```

**Expected:** exit **0** — `Test Suites: 167 passed, 167 total · Tests: 7445 passed, 7445
total · Snapshots: 0 total · Ran all test suites in 5 projects`. Zero failures, zero skips.
Takes roughly **8–10 minutes**; jest buffers its output, so nothing prints until the end.

**What this establishes:** every module behaves as specified **in isolation and against
fixtures**. It establishes nothing about composition, and this project's own history is the
argument for saying so out loud — a green suite has repeatedly coexisted here with a
composition that could not be built (`../v1/V1_IMPLEMENTATION_CONTROL.md` §13).

*If you are short of time, step 2 is a 7-second subset of this and step 1 can be quoted from
the record below rather than re-run.*

---

### Step 2 — the assignment engine's real decision path, composed and executed

```
npx jest tests/engine/coordinatorSolvePathComposition.test.js --verbose
```

**Expected:** exit **0** — **92 passed**, in about **7 seconds**. With `--verbose` the test
names print, and they are the narrative: read them rather than summarising them.

**This is the centre of the demonstration.** It drives `coordinatorSolvePath.create()` — the
*production* composition root, the same function `leaderWorkers.COMPOSERS.coordinator` calls —
and exercises the shipped modules through it:

| Group | What actually runs |
|---|---|
| **A** | The five collaborators `coordinator.worker.runRound` destructures. The **real** `candidates/expansion`, the **real** `evaluateExact` (gate → Plan Builder → Φ), `pricedCandidateFor`, and `commit` reaching §10.3.2's transaction seam with the `Outbox` row inside it |
| **B** | With no routing source the composition builds **nothing** and the refusal names `route` |
| **C** | The real plan path refuses each absent physical input **by name** — `MISSING_TERRAIN`, `MISSING_ENERGY_INPUT`, no assumed ambient, a limit is not a mass, an absent reserve floor is never a floor of zero |
| **D** | The adapters against the **published** register — `delayParametersFrom` names every absent rate and substitutes none |
| **F** | §7.5's gate over **all 38 predicates**, with `collectAll` so the answer is the whole set and not whichever predicate denied first |
| **G** | F33 containment-by-assignment, F35's charger estate, the §14.4 stress curves, the two `AgentClass` columns, §14.6's target SoC — each with its negative case |
| **E** | *"What this suite does NOT establish"* — asserted, not merely written |

**The safety and cost reasoning is group C and group F, and it is the part worth slowing down
on.** Two results to show directly:

- **Exactly one predicate returns `VIOLATED` — F17** — and it is *correct behaviour of a
  correct predicate*: the fixture's plan extends **920 s** against a published
  `plan.commitment_horizon` of **900 s**. The suite computes that assumption rather than
  restating it, and fails with a message forbidding the three ways it must not be "fixed"
  (`../v1/V1_IMPLEMENTATION_CONTROL.md` §6).
- **Every other denial is `INDETERMINATE` — an absence, not a violation.** That is
  *UNKNOWN IS NOT PERMISSION* holding at runtime: the gate denies because it cannot see, and
  it says which of the two it is.

**The three test doubles are labelled at every use and must be named when presenting.**
`declaredRouter()` answers the six-field `route` contract with fixed numbers so the wiring past
the routing seam can be reached — **its numbers are not travel times**, no assertion depends on
their values, and it is not a traversal source. `snapshotWith()` is the **real**
`service.defaultSnapshot()` with named parameters overridden *in that object alone*; nothing is
written to the register. `storeWith()` is a double for the **store**, never for an engine
module. The rule the file holds them to is the one that makes group C meaningful: *a double may
stand in for a seam, never for a decision.*

---

### Step 3 — the output and explanation surface

```
npm run gate:erasure
npx jest tests/engine/observabilityExplanation.test.js tests/engine/observabilityDecisionRecord.test.js tests/engine/feasibilityGate.test.js tests/engine/degradedTransitions.test.js tests/engine/solveRoundSearchGapProvenance.test.js tests/engine/coordinatorRound.test.js
```

**Expected:** `gate:erasure` exit **0** —

```
gate: reconstruction-equivalence over an ERASED corpus (§23.7, §24.3)
  PASS — 3 corpus decision(s), 3 with a Tier B record; reconstruction from Tier A alone
         reproduces every one byte for byte.
         erasure removed 0 identifying field(s) from the inputs and changed no replayed cost,
         which is the separation §23.7 requires.
```

and the jest command exit **0** — **6 suites, 182 tests**, in about **5 seconds**.

**What this establishes.** The explainability half of the path is executable **today**, on a
golden corpus, with no database and no external input:

- **Replay is a theorem about two pure functions, not a habit.** `round.plan()` is a pure
  function of the pinned Tier A inputs and `tierB.build()` is a pure function of a round
  result, so reconstruction from Tier A alone reproduces Tier B **byte for byte** — and it
  still does after `privacy/erasure.eraseCorpus()` has been applied to the *inputs*. A field
  whose erasure changed a replayed cost would be an identifying field wrongly admitted into
  the decision path, caught at build rather than at the first erasure request.
- **Eight §21.3 queries are implemented, not seven** — `why_this_agent`, `why_not_agent`,
  `why_still_waiting`, `why_deferred`, `why_distant_agent`, `what_would_change_it`,
  `what_did_it_cost`, `what_happened`. `explanation.assertCoverage()` returns
  `{ ok: true, queries: 8 }`.
- **Every answer names its source** — `TIER_A`, `TIER_B` or `RECONSTRUCTED` — because §21.3
  requires the API to say when it is recomputing rather than retrieving. `source` is a field of
  every answer, not a property of the endpoint.
- **Sensitivity is exact, not searched.** Because `Φ` is a transparent additive sum, the
  minimum change that flips a decision is a subtraction: `γ(runner-up) − γ(chosen)`, reported
  per term in integer milli-CU. This is the concrete payoff of a transparent optimiser over an
  opaque learned policy.
- **No reported optimality gap is ever a value the engine did not prove**
  (`solveRoundSearchGapProvenance`, 14 tests) — an unproven search gap stays unproven all the
  way to the `Round` row, the decision record, the operator explanation and the SLI, instead of
  being coerced to a `0` that reads as *proven optimal*.

---

### Step 4 — the structural break, printed by the build gate

```
npm run gates
```

**Expected:** exit **1** — **7 PASS, 1 FAIL**.

```
gate: tier-dependencies      PASS — 292 modules, 459 governed import edges, no Tier 0/1 → Tier 2
gate: parameter-register     PASS — 193 engine modules against 250 registered parameters;
                                    289 runtime modules checked; every name resolved
gate: tenets                 PASS — 289 modules
gate: identity-isolation     PASS — 16 modules; no street address is an input to any cost term
gate: reconstruction-equiv.  PASS — 3 corpus decisions
gate: legacy-retirement      PASS — 4 retired modules absent across 350 files
gate: column-generation      PASS — NOT_REQUIRED
gate: composition-root       FAIL — 1 violation across 19 registered worker(s):
                                    coordinator — LEADER_ONLY_NOT_COMPOSABLE
```

**The FAIL is the exhibit.** `gate:composition` prints the coordinator's whole declared
contract — **34 inputs**, each named, and the owner of each — and states that the blocker is
**external to this repository and no commit here closes it**. Read the printed sentence aloud;
it is the most complete single statement of where the system stands.

**Do not weaken this gate, and do not present its FAIL as an outstanding engineering task.** It
goes green when the coordinator actually starts, and only then
(`../v1/V1_IMPLEMENTATION_CONTROL.md` §17 rule 6).

---

### Step 5 — the real system, over HTTP, against a live PostgreSQL

**This is the only step that observes a running system rather than modules.** It is optional
for a short presentation and is the strongest exhibit for a long one.

#### 5.1 Build a disposable cluster (PowerShell)

```powershell
$bin    = "C:\Program Files\PostgreSQL\18\bin"
$pgdata = "$env:TEMP\robotx-demo-pgdata"

& "$bin\initdb.exe" -D $pgdata -U pgverify -A trust -E UTF8 --locale=C
Start-Process -FilePath "$bin\postgres.exe" `
  -ArgumentList "-D",$pgdata,"-p","55432","-c","listen_addresses=127.0.0.1" -WindowStyle Hidden
Start-Sleep -Seconds 5
& "$bin\pg_isready.exe" -h 127.0.0.1 -p 55432          # → accepting connections
& "$bin\createdb.exe"  -h 127.0.0.1 -p 55432 -U pgverify robotx_demo
```

**Port 55432 is deliberate** — it avoids the operator's own cluster, which stays untouched.
`pg_ctl -w start` hangs in this environment; start the server detached as above. Check the port
is free first: a cluster left running by an earlier session will answer `pg_isready` while
`createdb` then fails with `role "pgverify" does not exist`.

#### 5.2 Apply the schema

```powershell
$env:DATABASE_URL = "postgresql://pgverify@127.0.0.1:55432/robotx_demo"
npx prisma migrate deploy
```

**Expected:** `28 migrations found` → *"All migrations have been successfully applied."*

#### 5.3 Run the core-path harness

```
npm run verify:v1CorePath -- --database-url postgresql://pgverify@127.0.0.1:55432/robotx_demo
```

**Expected: exit 1, and exit 1 is the correct result.**

```
  OK    live PostgreSQL reachable
  OK    fleet and mission rows seeded — region v1-…-region, agent v1-…-agent
  OK    one configuration version published and pinned — version 1; register defaults + the
        V9/B8 accommodation; cutover.engine_enabled deliberately NOT bound (S-5 is the owner's)
  OK    the real server.js process serves HTTP — 127.0.0.1:45789, ENGINE_ENABLED=true
  STOP  POST /api/tasks/assign is admitted — HTTP 503 — the assignment engine is not live for
        this shard: this shard has NO decision path …

--- the boundary this run reached ---
  S-5 — the cutover binding …
  S-3 — the coordinator's own composition, as this running process reported it
        (1 refusal line(s), each printed in full):
    … "refusal":"EXTERNAL_DEPENDENCY_UNAVAILABLE" …
    … MEASURED against this context — 26 of 34 inputs unresolved:
      EXTERNAL_ROUTING: 5 | REGISTER_UNRESOLVED: 15 | NO_PRODUCER: 6
      satisfied (8): candidate.max_radius_by_sla_class, prisma, kv, runSerializable,
                     selectForUpdate, signingKey, snapshot, Ω correction
```

**What this establishes, and it is a great deal.**

- **A real HTTP request, a real JWT for a real `User` row, and the real `server.js` as a
  separate process**, against a real PostgreSQL with all 28 migrations. No jest, no fixture
  prisma, no injected round, no double for any engine module.
- **The request path fails closed and writes nothing.** `cutoverEnabled.describe` reports the
  engine is not live for the shard, admission refuses with **503 `ENGINE_NOT_LIVE`** *before*
  any row is written. A task accepted, durably recorded and never decided is the exact failure
  §12.1 exists to eliminate, and this is that rule holding on a live system.
- **The two boundaries are distinguished rather than merged**, and they have different owners.
  The 503 is **S-5**, the owner's cutover act. The refusal in the server's own log is **S-3**,
  the external inputs.
- **The composition refusal is emitted only at promotion**, so its presence in the log is the
  evidence that the run got that far: leadership was acquired and the `LEADER_ONLY` composers
  ran. *(That the other three — `outbox`, `reconciler`, `timer` — started is recorded from an
  independent run at `../v1/V1_IMPLEMENTATION_CONTROL.md` §5.6.1, which captured
  `running: ["outbox","reconciler","timer"]`. **This run does not print that line**: when
  refusals are found the harness prints those and not the server's whole output. Do not present
  it as observed here.)* The coordinator is the one refusing worker, and it says why in full.
- **`26 of 34` is a measurement, not an estimate** — produced by the running process, matching
  the figure on record exactly.

**The harness fabricates nothing, and that is the point.** It does not publish
`cutover.engine_enabled`; forging that binding would be a verification tool deciding that the
engine is live for a region. It injects no routing source, no calibration value, no
serviceable-region cover, no charger and no commissioning record.

#### 5.4 Tear down

```powershell
& "$bin\pg_ctl.exe" -D $pgdata -m fast stop
Remove-Item -Recurse -Force $pgdata
```

---

### Step 6 — the external boundary, printed by tools that refuse to fabricate

```
npm run routing:readiness
```

**Expected:** exit **0** *(by design — see below)* with **`OVERALL: BLOCKED`**. D1, D3 and D8
are each BLOCKED with the missing fields named; B1 Steps 1, 3, 4 and 5 are BLOCKED and Step 2
PASSes with **3 adapters implemented and 1 candidate correctly `NOT_IMPLEMENTED`** — *no engine
exists to adapt to and none was fabricated*.

The tool closes by stating that a benchmark run now **would not be admissible** as B1 Step 3
evidence, and that **no engine is selected, ranked or recommended by it**.

> **`routing:readiness` can never print PASS and always exits 0. That is by design, not a
> defect** (`../phase15/B1_EXTERNAL_INPUT_HANDOFF.md` §0.1). Do not read its exit code as a
> verdict; read the `OVERALL:` line.

---

## 3. What the demonstration proves

| # | Claim | Proven by |
|---|---|---|
| 1 | Every shipped module behaves as specified in isolation — 167 suites, 7 445 tests, zero failures, zero skips | Step 1 |
| 2 | The coordinator's solve path is **assembled from the real shipped modules by the production composition root**, and the assembly is reached | Step 2, group A |
| 3 | The engine **refuses by name** when a physical input is absent, and never substitutes a plausible value for a missing one | Step 2, group C |
| 4 | §7.5's gate evaluates **all 38 predicates**; exactly one `VIOLATED` (F17, correct by specification) and every other denial `INDETERMINATE` — *UNKNOWN IS NOT PERMISSION* holding at runtime | Step 2, group F |
| 5 | A decision record can be **reconstructed from Tier A alone, byte for byte**, including after erasure | Step 3 |
| 6 | The operator explanation surface answers **all eight** §21.3 queries, each naming its source, with **exact** sensitivity margins | Step 3 |
| 7 | No reported optimality gap is ever a value the engine did not prove | Step 3 |
| 8 | Tier discipline, register discipline, identity isolation and legacy retirement are all enforced at build | Step 4 |
| 9 | The single structural break is **named, enumerated as 34 inputs with owners, and attributed** — 5 routing, 15 calibration, 6 no-producer, at the live measurement | Steps 4 and 5 |
| 10 | On a live system, a real HTTP request **fails closed and writes nothing**, at the designed boundary, in the designed order | Step 5 |
| 11 | Intake, the durable queue, dispatch and lifecycle supervision are **composed and running** in the same process | Step 5 |
| 12 | The repository **refuses to fabricate** a routing engine, a region, a calibration value or a cutover binding, even when doing so would produce a green run | Steps 4, 5 and 6 |

---

## 4. What the demonstration does NOT prove

**Read this section out loud. It is not a disclaimer; it is half the result.**

| It does not prove | Why |
|---|---|
| **That any request is ever assigned** | No `Commitment`, no `Outbox` row, no `Round` row and no decision record is written by any step. Step 5 stops at 503 |
| **That any priced number is right** | The routing source, 15 register rates and 6 input families do not exist. Nothing computes a real cost, and step 2's router double's numbers **are not travel times** |
| **That the composition's inputs exist** | Step 2 proves the wiring is reached and refuses correctly; a fixture seam is not a router, a region or a charger |
| **S-6, or any progress toward it** | S-6 needs one real request reaching a durable `Commitment` **and** `Outbox` row in one transaction, with a `Round` row and a per-Leg decision record. Step 5 is the harness for it and it exits **1** |
| **S-5, or that S-5 is reachable** | S-5 is **blocked by FD-3 = NO**, on two independent grounds (V9 and S2), both needing a Safety authority and a second approver that do not exist today. Step 5 deliberately does not attempt the publish |
| **S-3, S-4 or S-7** | S-4 and S-7's failing half are mechanical consequences of S-3; `gate:composition` stays RED and is not weakened by any step here |
| **Anything about a fleet, a soak, shadow agreement, simulator fidelity or an observation window** | Those are §24 PRODUCTION gates (B-P) and require an operating fleet. **Never simulate them** |
| **Any §24 release gate** | 8 of 24 blocking gates are not green and no step here evaluates or moves one. **RELEASE: BLOCKED** |
| **That the repository is defect-free** | Not claimed, and on the evidence of every prior pass it should not be. Each pass has found defects on the surface the previous pass's fix created |

**And one thing this runbook explicitly is not:** a rehearsal, an attestation, or evidence for
any of the four gates the programme has classified as un-closable by commit.

---

## 5. Which of the architecture is demonstrable now

Stage numbering follows `../v1/V1_IMPLEMENTATION_CONTROL.md` §8.

| # | Stage | Demonstrable now? | How, and where it stops |
|---|---|---|---|
| 1 | **Request** — `tasks.controller` → `task.service.assignTask` | ✅ **Live** | Step 5. Real HTTP POST; fails closed with 503 before writing |
| 2 | **Durable queue** — `intake.admit`, `Leg` upsert, `slaDeadline`, `QUEUED` timer | ✅ **Live** | Step 5, composed and running; reached only once S-5 is bound |
| 3 | **Coordinator composition** | ✅ **Live — as a named refusal** | Steps 2, 4, 5. ★ **THE STRUCTURAL BREAK.** The assembly exists and refuses on measured inputs |
| 4 | **Candidate generation** — `expansion`, `availabilityIndex`, `lowerBound`, `omega` | ⚠️ **Fixture only** | Step 2 group A runs the real module; unreachable in production |
| 5 | **Routing** — `cellPairCache` | ❌ **Blocked — external (B1)** | Step 2 group B refuses by name; step 6 shows why. **No source exists** |
| 6 | **Feasibility** — 38 §7.5 predicates | ⚠️ **Fixture only** | Step 2 group F — the full gate, one `VIOLATED`, the rest `INDETERMINATE` |
| 7 | **Pricing** — `phi`, `cDirect`, `cRisk`, `cLifecycle`, `cDelay` | ⚠️ **Fixture only** | Step 2 groups A and D. **15 rates unresolved**; each refuses individually |
| 8 | **Solve** — `round`, `objective`, `minCostFlow` | ⚠️ **Fixture only** | Steps 2 and 3; gap provenance proven |
| 9 | **Commit** — `commit.js`, `planState`, leases | ⚠️ **Fixture only** | Step 2 group A reaches §10.3.2's seam with the `Outbox` row inside the transaction |
| 10 | **Dispatch** — `outbox.worker` | ✅ **Live** | Step 5 — composed and started, with nothing to drain |
| 11 | **Lifecycle supervision** — timer + ladder, reconciler | ✅ **Live** | Step 5 — composed and started |
| 12 | **Decision recording + explanation** | ⚠️ **Corpus only** | Step 3 — byte-for-byte reconstruction and all eight queries, on the golden corpus |

**Five stages are live in production composition (1, 2, 3, 10, 11). Seven are implemented,
tested and not in real composition (4–9, 12). One stage is the break (3), and it is external.**

---

## 6. Remaining external / owner blockers — none is repository work

Stated so that a viewer leaves knowing what would change the picture. **None of these may be
supplied, defaulted or illustrated by this runbook or by any session.**

| Blocker | What it is | Owner |
|---|---|---|
| **B1 / W-B1, W-B2** | A declared traversal source meeting the six-field `route` contract, plus `travelSdSeconds`, per-hop terrain, `timeBucket`, and `speedMetresPerSecond` per profile. **B1 releases 5 of the 26** — a routing source arriving alone starts no coordinator | Owner (D1/D3/D8) |
| **B8 / W-B3, D-1** | 15 register calibration values, 2 of them Safety-class. §22.3 forbids an automated process from choosing them | §22.4 calibration owner |
| **W-B4** | 6 `NO_PRODUCER` families — missing **code and** a named data source, not a withheld decision | Engineering + named sources |
| **W-B5 / D-3** | The minimal serviceable-region assignment. Additionally blocked: every non-empty fine-cell derivation from the adopted boundary is `containmentOverlapping`, which the owner has **refused**, and the escalation target is **NOT DEFINED** | Owner |
| **W-B6 / D-4** | One depot charger with a `cellId` **and** the return-leg Wh/metre — both or neither | Owner (FD-2 = YES authorises; the values are not supplied) |
| **D-2 / S-5** | Publish and pin `cutover.engine_enabled = true` at region scope. **Measured as refused**, on V9 and S2 | Safety, then Owner |
| **FD-3 = NO** | No second Safety approver exists. `SAFETY_APPROVAL_QUORUM = 2`; **no self-approval** | Owner — satisfiable later by one named person |
| **FD-1 = A** | S-6 requires a **real commissioned physical agent**. Hardware is in active development; **no simulated agent is admitted as V1's agent** | Owner |

The single complete owner request is
[`RD-2026-09-05-01`](../release-decisions/RD-2026-09-05-01-v1-external-input-and-owner-decision-request.md),
**issued and unanswered**.
[`RD-2026-09-05-02`](../release-decisions/RD-2026-09-05-02-v1-agent-boundary-and-simulation-track.md)
is **drafted and unsigned**. **Do not issue a second request.**

---

## 7. Provenance of the expected outputs above

Every figure in this runbook was executed on the tree named here, not carried forward from a
document. **Re-measure before quoting any of them against a different tree; the digest is how
you tell.**

> ### ⚠ THE DIGEST BELOW HAS MOVED. RE-MEASURE BEFORE PRESENTING.
>
> **A later pass changed source and tests** — the W-A8 fail-closed fix
> (`V1_IMPLEMENTATION_CONTROL.md` §11.A): the coordinator's offer carries no route geometry,
> and the agent used to accept it and emit `TASK_COMPLETE` for a mission it never drove.
> Two files changed, `src/simulation/VirtualRobot.js` and
> `tests/engine/dispatchAgentProtocol.test.js`; **no file was added**.
>
> | | Pinned below | Measured after W-A8 |
> |---|---|---|
> | **Source digest** | `750862…8635d` / 582 files | **`df9bf915adcd7e75a86dc8e10b33ba9cb5c9178c28c09617dfdfa405d5be1f91`** / **582** files |
> | **Step 1** — `npm test` | 167 suites / **7 445** tests | 167 suites / **7 454** tests — **+9**, the W-A8 regression tests |
> | **Step 4** — `npm run gates` | exit 1, **7 PASS / 1 FAIL** | **unchanged**, re-run and verified — `legacy-retirement` still PASS, `composition-root` still the only FAIL and not weakened |
>
> **Steps 2, 3, 5 and 6 were not re-run after W-A8 and their figures below are therefore
> unverified on the new tree.** The fix touches only the agent-side offer response, which none
> of those four steps exercises, so they are *expected* to reproduce — but expected is not
> measured, and this runbook's own §7 rule is that a figure is quoted only against the tree it
> was measured on. **Re-run them, or say they were not re-run.**
>
> One further caution for step 1: `tests/scale/round.scale.test.js` asserts a throughput bound
> and **fails on a loaded runner**. It failed in the post-W-A8 full run (which shared the
> machine with `npm run gates`) and passed **9 of 9** when re-run alone. Do not run anything
> else alongside step 1.

| | |
|---|---|
| **Date** | 2026-09-06 |
| **Branch / HEAD** | `feature/dashboard` / **`db4b115`** |
| **Working tree** | **clean** (`git status --porcelain` empty) |
| **Source digest** | **`750862692737e568a29ace87acd49fb3d1791c18d8742f41ad9677f12fa8635d`** / **582** files |
| **Node / npm** | v22.17.0 / 11.12.1 |
| **PostgreSQL** | 18.3, disposable cluster on port 55432, 28 migrations applied |

| Step | Command | Exit | Result |
|---|---|---|---|
| 1 | `npm test` | **0** | 167 suites / 7 445 tests / 0 failures / 0 skips · 498.268 s |
| 2 | `npx jest tests/engine/coordinatorSolvePathComposition.test.js` | **0** | **92 passed** · 6.9 s |
| 3 | `npm run gate:erasure` | **0** | PASS — 3 corpus decisions, byte-for-byte under erasure |
| 3 | `npx jest` — the six engine suites | **0** | 6 suites / **182 tests** · 4.6 s |
| 4 | `npm run gates` | **1** | **7 PASS / 1 FAIL** — `gate:composition`, 1 violation across 19 workers, 34-input contract |
| 5 | `npm run verify:v1CorePath -- --database-url …` | **1** | HTTP **503 `ENGINE_NOT_LIVE`**, nothing written; S-5 then S-3; **26 of 34 unresolved** = 5 / 15 / 6, 8 satisfied |
| 6 | `npm run routing:readiness` | **0** *(by design)* | **OVERALL: BLOCKED** — D1, D3, D8 |

**Nothing was published, pinned, seeded into a production store, or written outside the
disposable cluster. No code, test, gate, fixture, formal model or configuration file was
modified to produce any output above.**

---

## 8. What must not be done with this runbook

| Do NOT | Why |
|---|---|
| Present step 4's or step 5's exit 1 as a defect to be fixed | Both are correct results on this tree. `gate:composition` goes green only when the coordinator actually starts (§17 rule 6) |
| Add a router, region, charger or calibration value to make a step exit 0 | §17 rules 1–3. Starting the coordinator on invented travel times assigns real work on invented data |
| Publish `cutover.engine_enabled` to reach step 5's next stage | That is **S-5**, the owner's act, and it is measured as **refused** |
| Cite any step here as evidence for S-3, S-4, S-5, S-6 or S-7 | None of them bears on any stop condition. The score is **3 of 8** |
| Cite the multi-robot simulation track (SIM-1…SIM-5) here | **V1-ENG.** It discharges no stop condition and no count, gate, exit code or verdict may cite it |
| Run `cutover.md` or `rollback.md` from this runbook | Neither is part of a demonstration |
| Re-collect `release-evidence.json` to make the verdict render better | The verdict is **BLOCKED** either way; re-collection is the release owner's step at a quiescent tree |
| Quote a number from this file against a different tree | §7's digest is the binding fact. Re-measure |

---

**TRUTH > GREEN.**

**This is a working engineering demonstration. It is not production certification, and it is
not proof of S-5 production enablement.**

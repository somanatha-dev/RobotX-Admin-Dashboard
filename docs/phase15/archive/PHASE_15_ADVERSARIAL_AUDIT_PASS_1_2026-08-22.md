# Phase 15 — Current-Tree Adversarial Re-audit, Remediation, Re-verification and Closure

**Date:** 2026-08-22 · **Branch:** `feature/dashboard` · **Baseline commit:** `e5c9655` ("phase 14 closed") + the uncommitted Phase 5 and Phase 15 working tree
**Source digest of the tree everything below was measured against:** `22ca91435d46cf2abf03932637637bcb7986f23c71090211637190305fbb5b00` (560 files)
**Authority order:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN) → `IMPLEMENTATION_EXECUTION_PLAN.md` → the repository → the phase documents.

---

## 0. Status of the earlier Phase 15 reports

`PHASE_15_REMEDIATION_AND_CLOSURE.md` (2026-08-22) and
`PHASE_15_FINAL_IMPLEMENTATION_AND_CLOSURE_REPORT.md` (2026-08-21) are **preserved unedited**.
Nothing in either has been rewritten, softened, or deleted, and no finding of theirs has been
removed. This document sits on top of them.

**They predate the Phase 5 closure and are superseded by this current-tree audit.** The
successor report was written against a tree with 155 suites / 6 850 tests, two
`gate:composition` violations, an unimplemented timer subsystem, and **D-9 / §4.5 timer expiry
semantics as its headline in-repository blocker**. `PHASE_5_ADVERSARIAL_REMEDIATION_AND_CLOSURE.md`
(2026-08-22) then implemented seventeen expiry actions, composed the timer worker, and closed
D-9. Every number in the earlier Phase 15 reports is therefore stale, and this exercise
re-derived all of them from the tree rather than inheriting any.

**The earlier reports did not predict the Phase 5 fixes and are not presented as having done
so.** What they did do is return D-9 to Phase 5 correctly, and Phase 5's closure §2 records
that the deferral which produced it was Phase 5's own. That handoff worked in both directions
and is the reason this audit exists.

---

## 1. Final verdict

# PHASE 15 — BLOCKED. PHASE 16 — NOT READY.

**Six new Phase-15-owned defects were found on the current tree, and all six are fixed**,
each reproduced before the fix, attacked after it, mutation-tested, and verified against a
real PostgreSQL instance driving the shipped composition. **Phase 5's X2a and X2b are also
fixed**, having been routed to this phase by name. **X3 is not fixed and must not be**: it is
a specification blocker, argued in §8.

The verdict is unchanged from the earlier reports, and it is unchanged **for the same
reason**: the decision path terminates in a routing engine that B1 has not selected. Nothing
in this exercise moves that, and nothing here pretends to.

| | Baseline (current tree, before this work) | After |
|---|---|---|
| Test suites / tests | 156 / 6 909 | **157 / 6 960** |
| Build gates | 7 PASS, `gate:composition` FAIL (1) | **7 PASS, `gate:composition` FAIL (1)** — unchanged, still `coordinator`, still external |
| `gate:calibration` | FAIL, 39 findings | FAIL, 39 findings — **unchanged** |
| `sim:fidelity` | exit 1, 7 models `NOT_MEASURED` | exit 1 — **unchanged** |
| Live-PostgreSQL checks | 220 (12 + 102 + 106) | **252** (32 + 12 + 102 + 106) |
| Mutations caught | — | **14 / 14** |
| Release-gate attacks | — | **61 / 61** |
| `src/` modules reachable from `server.js` | 179 / 279 *(earlier report's figure)* | **208 / 285** |
| `npm run release:gates` | — | **16 green, 1 red, 7 not evaluated → BLOCKED** (§19) |

**What the six findings have in common** is the thing this programme has now recorded seven
times, and every one of them was invisible to a green suite for the same reason:

> A real producer, a real consumer, and **nothing joining them** — with a comment at the join
> asserting that the join exists.

Four of the six were accompanied by a source comment stating the correct behaviour as fact.
That is not carelessness; it is what makes this class of defect survive review. A reviewer
reads the sentence, the sentence is what the author intended, and no test can disagree with a
sentence.

---

## 2. Current baseline, measured before anything was changed

```
$ git log --oneline -1
e5c9655 phase 14 closed          (+ 52 uncommitted paths — the Phase 5 and Phase 15 work)

$ npx jest --runInBand --forceExit
Test Suites: 156 passed, 156 total
Tests:       6909 passed, 6909 total

$ npm run gates
gate: tier-dependencies          PASS — 282 modules, 414 governed edges
gate: parameter-register         PASS — 186 modules against 242 registered parameters
gate: tenets                     PASS — 279 modules
gate: identity-isolation         PASS — 16 modules
gate: reconstruction-equivalence PASS — 3 decisions, byte for byte
gate: legacy-retirement          PASS — 4 retired modules absent, 334 files
gate: column-generation          PASS — NOT_REQUIRED
gate: composition-root           FAIL — 1 violation: coordinator [LEADER_ONLY_NOT_COMPOSABLE, EXTERNAL, B1]
exit 1

$ npm run gate:calibration       exit 1 — 39 blocking findings; 242 entries (52 DERIVED, 152 PROVISIONAL, 38 UNCALIBRATED), 54 Safety-class
$ npm run sim:fidelity           exit 1 — 7 models NOT_MEASURED, 6 of them safety-relevant
$ npm run routing:readiness      OVERALL: BLOCKED — D1, D3, D8; no engine selected
$ node tools/release/sourceDigest.js
22ca91435d46cf2a…  (560 files)

# live PostgreSQL 18.3, disposable cluster on 55436, 26 migrations from empty
tools/verify/phase15LiveDatabase.js    12/12
tools/verify/phase5ExpirySemantics.js  102/102
tools/verify/phase5LiveDatabase.js     106/106
```

**Release-gate table: 24 gates** — 17 `BUILD`/`SUITE`, 4 `PRODUCTION`, 3 `ORGANISATIONAL`,
all blocking. (The earlier reports say 23; the table has since gained one row.)

---

## 3. Why the previous Phase 15 baseline is stale, item by item

| Earlier report said | Current tree |
|---|---|
| 155 suites / 6 850 tests | 156 / 6 909 **before this work**; 157 / 6 960 after |
| `gate:composition` — 2 violations (`coordinator`, `timer`) | **1** (`coordinator`). The `timer` row is gone because Phase 5 implemented §4.5's seventeen expiry actions and the worker composes. |
| **D-9** — the timer handler map has no producer; sixteen actions unimplemented | **CLOSED.** `src/engine/supervision/expiryActions.js` implements seventeen; `leaderWorkers.COMPOSERS.timer` starts the worker on leadership and refuses composition if the map is incomplete. |
| 23 release gates | **24** |
| 279 `src/` modules, 100 unreachable | 285 modules, 77 unreachable |
| **X2a / X2b** — recorded by Phase 5 as *new input to Phase 15's cutover scope* | **Fixed here** (§7) |
| **X3** — no TASK timer producer | **Not fixed. Reclassified as a specification blocker** (§8) |

**Nothing in §4–§10 is inherited from either earlier report.** Every finding below was
reproduced against the current tree before it was written down, and the reproduction is
quoted with each one.

---

## 4. Phase 5's closure incorporated as new evidence

Phase 5 handed this phase three named inputs. All three were audited end to end.

### X2a — `offers.applyAccept` → `OFFERED → ACCEPTED`, no `ACCEPTED` deadline

**Traced in full**, as the mandate requires, rather than checked for the existence of timer
registration:

```
producer      OFFER_ACCEPT (socket)  → sockets/handlers/offer.handler.js:144
transition    offers.applyAccept()   → dispatch/offers.js:305  — writeLegState(…, ACCEPTED)
timer         ✗ NONE                 — `grep -n "timers.register" src/engine/dispatch/offers.js` → no hits
persistence   Leg.state=ACCEPTED, Leg.version=1; Timer rows for that Leg: 0
timer worker  never fires — there is nothing to fire
expiry action expiryActions.probeThenReassign  — implemented, unreachable from this path
recovery      ✗ none. `execute.start_grace` never expires.
```

**And it is three paths, not one.** `applyReject` writes `QUEUED` and `applyDefer` writes
`PLANNED`, both with no deadline either. Phase 5 named the accept because that is the one its
live harness planted; the module has four `writeLegState` call sites and none of them
registered a timer.

### X2b — outbox withdrawal → `QUEUED`, no `QUEUED` deadline

```
producer      outbox.worker.drainOnce → performWithdrawal()  (workers/outbox.worker.js:264)
transition    offers.withdrawExpiredOffer()  — advances the fence, signs WITHDRAW, writes Leg=QUEUED
timer         ✗ NONE
```

Compared against Phase 5's own `WITHDRAW_EXCLUDE_REPLAN` path, as instructed:

| | `expiryActions.withdrawExcludeReplan` | `outbox.worker.performWithdrawal` |
|---|---|---|
| calls `offers.withdrawExpiredOffer` | yes | yes |
| cancels the `OFFERED` deadline | **yes** | **no** |
| registers the `QUEUED` deadline | **yes** | **no** |
| refuses if `sla.assignment_deadline` is absent | **yes**, rolls back | n/a |

**Two production paths to one state with different supervision semantics** — precisely what
the mandate says must not exist. And the asymmetry is Phase 15's: this path became live only
when the earlier Phase 15 remediation wired the outbox worker into the composition root (D-5 /
D-8). `phase5ExpirySemantics.js` group F says so in its own words: *"live since Phase 15 wired
the worker."*

### X3 — no `TASK` timer producer

Audited to its root and **deliberately not fixed**. See §8.

---

## 5. The Phase 15 requirement matrix, re-derived

| §24 / plan requirement | Status on the current tree |
|---|---|
| `cutover/enabled.js` — the two-half switch | MET — **and a permissive defect found in it** (P15-R5) |
| `cutover/agentGate.js` — every agent path held to both halves | MET (D-6); re-derived §6.1 |
| `cutover/stage.js` — five refusals, staging order, purposes | MET (D-7 / ADR-34); attacked §11, 9/9 |
| `cutover/gates.js` + `evidence.js` — the §24 table and its admission rules | MET; attacked §11, 61/61 |
| `tools/release/{collectEvidence,verdict,sourceDigest}.js` — a producer for the table | MET; attacked §11 |
| `workers/leaderWorkers.js` — the LEADER_ONLY promotion hook | MET (D-5); **3 composition gaps found** (P15-R2, R3, R6) |
| **A published binding reaching a running process** | **NOT MET** — P15-R2. Now met. |
| **§22.4 item 4 — automatic rollback** | **NOT MET** — P15-R1. Now met. |
| **§18.5 — no commands under Custodial Operation, on the engine's delivery path** | **NOT MET** — P15-R3. Now met. |
| Intake path gated on the per-shard switch | Partly — REST met; **socket path permanently refused** (P15-R4), **REST path fail-open with no region** (P15-R5). Both now met. |
| §4.5 / I4 on the paths the cutover makes live | **NOT MET** — X2a, X2b. Now met. |
| `workers/invariant.worker.js` composed | MET — WIRED, not OBSERVED (§9) |
| `workers/shadow.worker.js` composed | **NOT MET — EXTERNAL (B1)**, unchanged (§10) |
| `workers/coordinator.worker.js` composed | **NOT MET — EXTERNAL (B1)**, unchanged (§10) |
| §4.2's half of §4.5 reachable | **NOT MET — SPECIFICATION** (X3, §8) |
| Every §24 gate green | **NOT MET** — 7 of 24 cannot be closed by a build; `engine_decision_path_wired` red |

---

## 6. Old findings, re-derived rather than carried forward

Each was reproduced against the current tree. None was accepted on the strength of a report.

### 6.1 D-6 — the socket cutover conjunction · **HOLDS, and two new defects found beside it**

```
$ grep -rn "ENGINE_ENABLED" src/ --include=*.js | grep -v "^\S*:[0-9]*: *[*/]"
src/engine/config/service.js:629   (bootstrap's own decision)
src/engine/cutover/enabled.js:92   (processEnabled — the owning module)
→ zero raw reads anywhere else
```

All five agent-facing handlers call `agentGate`. `SHARD_REGION_UNRESOLVED` (the D-13 fix) is
present and fires. **But the same substitution D-13 closed for an agent session was still open
one module along, on the intake path** — see P15-R5. That is not a regression in D-6's fix; it
is the same defect class in a module D-6 never touched, and finding it required constructing
a deployment holding *both* a global and a region binding, which no earlier test did.

### 6.2 D-7 — the rehearsal circularity · **HOLDS**

ADR-34 is registered. `REHEARSAL_EXCLUDED_GATES` holds exactly one id. Attacked with nine
probes (§11 group H) including all six rehearsal steps omitted individually: **9/9 refuse
correctly**, and a complete rehearsal record *is* admitted, so the contract is satisfiable
rather than merely strict.

### 6.3 D-5 / D-4 — the coordinator and the shadow worker · **UNCHANGED, EXTERNAL**

`gate:composition` names one worker and marks it external. `leaderWorkers.UNCOMPOSABLE` holds
exactly one row. `registry.WORKERS`'s `shadow` row still names B1. `npm run routing:readiness`
still reports `BLOCKED` on D1, D3, D8 with no engine selected. Verified live as group G2.

### 6.4 D-8 — `SHARD_MIGRATE` has a deliverer · **HOLDS**

`leaderWorkers.COMPOSERS.outbox` starts the drain worker on leadership with
`commandDispatcher.outboxDeliveryArm(io, …)`. Live check C1 of `phase15LiveDatabase.js`.
**And the arm it was given could not enforce §18.5** — P15-R3, which is a defect *in* this
fix's wiring rather than a doubt about the fix.

### 6.5 D-9 — the timer expiry semantics · **CLOSED by Phase 5**

Re-verified rather than assumed: `phase5ExpirySemantics.js` **102/102** and
`phase5LiveDatabase.js` **106/106** against a fresh database on the post-remediation tree.
The composition-root gate no longer names the timer.

### 6.6 D-10 / D-11 / D-13 · **HOLD**

The composition gate resolves requires to absolute paths and distinguishes
`LEADER_ONLY_UNREACHABLE` from `LEADER_ONLY_NOT_COMPOSABLE`. D-11's call-counting test and
D-13's region check are both present and both mutation-tested here (M1 re-attacks D-13's rule
at its new home).

### 6.7 D-12 — module reachability · **RE-MEASURED**

```
src/ modules total:       285
reachable from server.js: 208
NOT reachable:             77   (was 100 of 279)
  engine/feasibility 41 · engine/payload 5 · commitment 3 · cost 3 · energy 3 · plan 3 ·
  pricing 3 · routing 3 · candidates 2 · … · 6 worker modules
```

**Reachability improved and it means less than it looks.** `solve/` and `lifecycle/transitions`
became reachable because `leaderWorkers` *requires* `coordinator.worker` deliberately, so the
composition gate can see it. Requiring is not starting. The honest statement is the one the
earlier report made and it is unchanged: **the decision path is internally wired and
externally unreached.**

All three modules this exercise added are reachable from `server.js`, which is the same check
applied to its own work.

---

## 7. New findings — all Phase-15-owned, all fixed

### P15-R1 — the automatic rollback published nothing · **BLOCKING** · FIXED

**Root cause.** §22.4 item 4 is *"stage by shard, monitored against pre-declared SLI
guardrails, **with automatic rollback**"*. `cutover.worker` implements the first two clauses
and calls `deps.publish(action)` for the third. `stage.js` says who satisfies that call:

> It writes nothing: it returns an authorisation, and the caller — **the cutover worker** or an
> operator's tooling — **publishes the configuration binding through the Config Service**.

The production composition root supplied a `publish` that wrote a log line and returned.

**Reproduction (before), against the shipped modules with `server.js`'s own dependency object:**

```
before: enabled.forShard = true
pass: {"assessed":1,"rolledBack":1}
publish() received a binding: {"level":"region","key":"region-alpha","name":"cutover.engine_enabled","value":false}
audit event: CUTOVER_SHARD_ROLLED_BACK
after : enabled.forShard = true      <-- the shard the controller just 'rolled back'
next pass verdict: HOLD | rolledBack: false
next pass note   : live with no pre-declared guardrails…
```

Read the last two lines together, because they are the finding. The controller reports a
rollback, writes the audit event — and the shard stays live. Then, because
`cutover/store.declarationFor` returns `null` once the latest cutover event is a rollback, the
**next** pass reports the shard as *live with no pre-declared guardrails* and **never assesses
it against its guardrails again**. A breaching shard is left running and permanently
unguarded, by the control whose entire purpose is to stop it. That is worse than having no
automatic rollback, because the audit stream records one as having happened.

**Why an automated publish is permitted, and how that was established.** The comment
justifying the log line argued that publishing is an approved, versioned operation (§22.1
rule 4). The parameter register answers it directly, in `cutover.engine_enabled`'s own entry:

> **STRUCTURAL rather than SAFETY on purpose**: §22.3 forbids any automated process from
> changing a Safety-class parameter, and **the automatic rollback of §22.4 item 4 must be able
> to set this false**. The asymmetry is enforced in code — `guardrails.assertOneDirectional`
> admits only DISABLE, and `stage.authoriseEnable` refuses an automated request outright — so
> the only automatic transition is the one that lowers risk.

**No ADR was written, deliberately.** The decision this fix rests on was already taken, is
already recorded in the register, and is already enforced in two places. Writing an ADR to
re-decide it would imply the question was open.

**Fix.** `src/engine/cutover/rollbackPublisher.js` (new, Phase 15). It refuses anything that
is not a disable — not a `ROLLBACK`, not `cutover.engine_enabled`, not `region` scope, not
`false`, no region key — carries the version in force forward in full (bindings, kill
switches, regimes, spatial, shards), publishes `automated: true`, and **pins**. Everything is
injected; it requires neither Prisma nor the Config Service.

**Regression.** 8 tests in `phase15CurrentTreeRemediation.test.js`, including the controller
driving it end to end and the converse — a publish that throws must take the audit write with
it. **Live: B1–B6. Mutations M8, M9, M10: caught.**

---

### P15-R2 — no process ever re-read the pinned configuration · **BLOCKING** · FIXED

**Root cause.** §22.1 rule 4 makes configuration propagation *"pull-with-pin, never a push
that could land mid-round"*. `config/service.js` implements both ends: `pinVersion()` writes
the pointer and mirrors it into `config:active`; `loadPinnedSnapshot()` reads it back.

**Nothing pulled.**

```
$ grep -rn "locals.config =" src/ server.js
src/app.js:25       app.locals.config = configService.defaultSnapshot();   (the placeholder)
server.js:303       app.locals.config = await configService.bootstrap(…);  (once, at boot)

$ grep -rn "loadPinnedSnapshot" src/ server.js
src/controllers/config.controller.js:39   (a read endpoint)
src/controllers/config.controller.js:88   (a read endpoint)
```

Two read-only endpoints, and nothing else. `POST /api/config/versions` publishes **and pins**
and does not update its own process's snapshot.

**Why this is Phase 15's deliverable failing rather than a general staleness bug.** The
per-shard cutover switch **is** a published binding, and every consumer of it reads
`app.locals.config`: the five agent handlers through `agentGate`, the intake path through
`task.service`, the staged-rollout controller's own notion of which shards are live through
`store.liveShards`, and `/api/health`'s per-shard posture. So *"staged by shard, with
rollback"* was, on a running deployment, **"staged at boot, permanently"**: a shard could not
be taken live, could not be rolled back, and P15-R1's automatic rollback could not take effect
at all even once it published.

The comment at `server.js:305` stated the opposite as fact:

> `app.locals` by reference, not `app.locals.config` by value: the agent handlers read the
> snapshot at call time, **so a republished configuration reaches an already-connected
> socket** (P14-R1).

The first clause was true. Phase 14 built the plumbing. The second clause described a
republish that never happened.

**Fix.** `src/engine/cutover/configPropagation.js` (new, Phase 15) — a pull on a cadence, with
`load` and `apply` injected. It adopts a new version, ignores an unchanged one (the version is
the unit, not the object), refuses an unversioned snapshot, and on a failed load **keeps the
version in hand** and reports through `onError`. Started in `server.js` immediately after
bootstrap, stopped on shutdown. `startScheduledWorkers` and `leaderWorkers` now read the
snapshot through an accessor so the controller and the LEADER_ONLY composers track it too.

**Deliberately not done:** nothing restarts a worker on a republish. A worker's *cadence* is a
property of the timer its composition created; changing one still needs a promotion or a
restart. That is stated rather than fixed, because it is a different question.

**Regression.** 9 tests. **Live: A1–A5 (a real publish → pin → pull → the same reader changing
its answer). Mutations M6, M7, M14: caught** — M14 only after the test was strengthened, see
§12.

---

### P15-R3 — §18.5's command suspension was unwired · **BLOCKING** · FIXED

**Root cause.** §18.5 Custodial Operation:

> Command authority derives from a fence allocated in the Commitment Store; with the store
> unavailable no fence can be allocated, so **no command can be authorised**.

`commandDispatcher.deliverOutboxCommand` is the single exit every §10.3.1 command passes
through and it checks `modeRegister.commandsSuspended(options.activeModes || [])`. Its own
comment says where the mode set comes from:

> Absent `activeModes`, nothing is suspended. That is the correct default for the legacy path
> … and it is safe for the engine path **because the drain worker always supplies it**.

The drain worker does not supply it. `outbox.worker.js` contains no reference to
`activeModes` at all — `requireDeps` does not ask for it and `drainOnce` does not use it. What
the production composition supplied was, at `server.js`:

```js
deliver: dispatchOutboxCommand(io, { activeModes: () => [] }),
```

A constant empty set. And `leaderWorkers.COMPOSERS.outbox` passed an `activeModes` key into the
worker's deps that the worker never read — a dependency with no consumer, sitting next to the
real gap, which is most of why the gap read as wired.

**Reproduction (before), against the shipped modules:**

```
modes that suspend commands, per modeRegister: [ 'CUSTODIAL_OPERATION' ]
server.js's arm, shard IS in CUSTODIAL_OPERATION: {"delivered":true,"detail":null,"socketId":"sock-1"}
  emits so far: 1
an arm given the real mode set   : {"delivered":false,"detail":"COMMANDS_SUSPENDED:CUSTODIAL_OPERATION",…}
```

A command emitted to an agent under the mode that exists to prevent exactly that. Meanwhile
`GET /api/health` reads the real `DegradedModeEvent` rows and reports
`commandsSuspended: true` — the system's report and the system's behaviour disagreed.

**Why the producer could not be supplied even in principle.** `degraded/transitions.activeModes`
is a **query**. The option was read synchronously, in two places. Supplying the real producer
would have handed `commandsSuspended` a Promise, `Array.isArray(promise)` is false, and the
mode set would have read as empty — a fail-open that looks exactly like a correctly wired
call. So the constant was not laziness; the seam did not admit the producer.

**Fix.** Three changes, all minimal:

1. `deliverOutboxCommand` **awaits** the accessor. `await` on a non-promise is the identity, so
   every existing caller is byte-for-byte unchanged.
2. `outboxDeliveryArm` **forwards** the accessor instead of invoking it at bind time — which is
   what the function's own comment already asked for (*"a value captured at bind time would let
   a command out after Custodial Operation opened"*).
3. An accessor that **throws** refuses the delivery by name (`DEGRADED_MODE_UNREADABLE`) rather
   than escaping. A store blip is the condition §18.5 is about; "we could not find out" must
   never resolve to "they are not suspended", and letting the throw escape would abort the
   whole drain pass rather than one row.

`server.js` then binds `activeModes: () => degradedTransitions.activeModes({ prisma }, shardId)`.
The decision stays at the single exit — *"two determinations of 'may we command' is one too
many"* — and the dead `activeModes` dep was removed from the composer.

**Regression.** 7 tests. **Live: C1–C4, including C3, which plants the old binding beside the
fix and shows the same command going out under the same open mode. Mutations M3, M4, M5:
caught.**

---

### P15-R4 — the socket intake path read a snapshot that does not exist · **High** · FIXED

**Root cause.** `socket.server.js`'s `assign_task` handler:

```js
config: io?.app?.locals?.config || null,
```

**A Socket.IO server has no `app`.** Nothing under `src/` or in `server.js` assigns one:

```
$ grep -rn "io\.app *=" src/ server.js   → no matches
```

So the snapshot was always `null`, `configEnabled` answers `false` for a null snapshot, and
`assignTask` threw `ENGINE_NOT_LIVE` (503) — on **every** shard, including a correctly staged
one, for ever. It failed **closed**, which is why nothing caught it: the path simply never
worked, so no behaviour regressed when it stopped working.

`initSocketServer` receives `appLocals` as a parameter — threaded in by Phase 14's P14-R1 for
exactly this reason, because handlers used to reach for it through the request object and got
it wrong. This call site is the one P14-R1 did not convert.

**Fix.** `config: appLocals?.config ?? null`. **Mutation M2: caught.**

---

### P15-R5 — the intake path inherited the **global** binding when no region was named · **BLOCKING (permissive)** · FIXED

**Root cause.** `enabled.configEnabled` built its resolution context as:

```js
const context = {};
const regionId = shard && (shard.regionId || null);
if (regionId) context.region = regionId;
return snapshot.resolve(PARAMETER, context) === true;
```

An empty context resolves `cutover.engine_enabled` at **global** scope, and the register
declares `scopes: ["global", "region"]`, so a global binding is a legal thing for a deployment
to hold. The per-shard question was therefore answered with the deployment-wide one.

**It was reachable and it was permissive.** `services/task.service.js` takes the region from
the **request body**:

```js
regionId: toStringOrNull(req.body?.regionId) || toStringOrNull(req.query?.regionId),
```

So the way to be admitted onto a shard the staging order had not reached was to **omit
`regionId`**. And `task.service.js`'s own docstring asserted the opposite:

> a caller that passes neither gets `false`, which is the right answer for a caller that cannot
> say which shard it means.

**Reproduction (before):**

```
staged region       : true
unstaged region     : false
NO REGION NAMED     : true   <-- inherits the GLOBAL binding
describe(): {"live":true,"shardId":null,"regionId":null,"decisionPath":"ENGINE"}
```

This is D-13's substitution — *"the answer to 'is the whole deployment cut over' returned in
place of 'is this shard cut over'"* — one module along from where D-13 fixed it. `agentGate`
refuses by `SHARD_REGION_UNRESOLVED` before it consults the snapshot; the intake path had no
such guard.

**Fix at the root, not at the caller.** `configEnabled` now refuses to answer without a region,
for the reason D-13 gives: *a missing region does not make the answer `false`, it makes the
question a different one.* Fixing it in `task.service` would have left the next caller exposed.
`describe()` gains `REGION_UNRESOLVED`, kept distinct from `SHARD_HAS_NO_DECISION_PATH` because
one says *the caller did not say which shard* and the other says *this shard is not staged* —
different incidents, different responses.

**Recorded, and deliberately not changed:** a region with **no binding of its own** still
inherits a global one. That is §22.2's hierarchy doing what it says, it is the operator's own
explicit act, and `stage.authoriseEnable` only ever emits `region`-scope bindings — so the
authorised path cannot produce a global `true`. Live check F5 pins the distinction so a reader
does not take this fix to be broader than it is.

**Regression.** 5 tests, including one asserting the resolution context *always* carries the
region and the null case never reaches the snapshot at all. **Live: F3, F4, F5. Mutation M1:
caught.**

---

### P15-R6 — the timer worker was composed with no operating region · **Medium** · FIXED

**Root cause.** `expiryActions.pageOperations` resolves §18.6's contact set by region:

```js
externalEscalation.resolveContactSet({
  contacts: ctx.config.escalationContacts ?? null,
  regionId: escalationContext.regionId ?? ctx.config.regionId ?? null, …
```

`leaderWorkers.COMPOSERS.timer` passes `regionId: context.regionId`, and `server.js` never
supplied one. So `regionId` was `null` on every fire, `resolveContactSet` returns
`NO_CONTACT_CONFIGURED`, and every obstructing-stranding escalation would record an absent
contact set — silently, and **including after B8 supplies
`ops.external_escalation_contacts`**, which is what makes it worth fixing now rather than
filing behind the calibration blocker.

**And the first fix was wrong, which the live database caught.** `Shard.regionId` is a
**foreign key to `Region.id`** — a uuid — while `Region.regionId` is the identifier an operator
writes. Passing the former would have looked wired and matched nothing:

```
Shard.regionId='p15ct-r-live' (a Region row id) ≠ Region.regionId='p15ct-region-live'
```

This is the same trap the earlier harness's A1 was built for (`Agent.id` vs `Agent.agentId`),
and a fixture using one string for both cannot see it. The composer now reads through the
`Region` relation.

**A distinction worth stating, because it is not a defect and reads like one.** The rest of the
cutover machinery resolves `cutover.engine_enabled` at `Shard.regionId` — the row id — and that
is correct *there*: those bindings are written by `stage.authoriseEnable` from the same column,
so the key is machine-generated at both ends. §18.6's contact set is the opposite case: a map an
operator authors. Two consumers, two right answers.

**Regression.** 2 tests. **Live: E1, E2 — including the converse, that the row id does *not*
match a configured contact set, so the check is not vacuous.**

---

### X2a / X2b — a Leg state entered outside §4.4 was unsupervised (I4) · **BLOCKING** · FIXED

**Reproduced in §4.** Four production paths, all in `dispatch/offers.js`:

| path | writes | timer before |
|---|---|---|
| `applyAccept` ← `OFFER_ACCEPT` | `OFFERED → ACCEPTED` | none — X2a |
| `applyReject` ← `OFFER_REJECT` | `OFFERED → QUEUED` | none |
| `applyDefer` ← `OFFER_DEFER` | `OFFERED → PLANNED` | none |
| `withdrawExpiredOffer` ← outbox §11.4 step 2 | `OFFERED → QUEUED` | none — X2b |

**Why the fix registers a deadline rather than routing the writes through `transitions.apply`.**
This is the load-bearing design decision of this section and it looks like the less principled
option, so it is argued rather than asserted.

§4.4 has a row for two of the four — `OFFERED → ACCEPTED` on `AGENT_ACK`, `OFFERED → QUEUED` on
`AGENT_NACK` — and **no row at all** for `OFFERED → PLANNED`, which is what §11.2's `DEFER`
performs. Verified against the shipped table:

```
OFFERED -> ACCEPTED | AGENT_ACK        | guards: FENCE_MATCHES_OFFER_UNEXPIRED
OFFERED -> QUEUED   | AGENT_NACK       | guards: -
OFFERED -> QUEUED   | OFFER_TTL_EXPIRY | guards: -
(no OFFERED -> PLANNED row)
```

Routing three of four through the table and leaving the fourth out reintroduces the divergence
one layer in. Adding a row for the fourth writes a §4.4 transition the frozen specification does
not contain — the invention Phase 5 refused for §4.2 and this phase refuses here.

The obligation these paths actually breach is **§4.5's**, not §4.4's, and §4.5 is satisfiable
without deciding anything §4.4 leaves open: the state's deadline parameter comes from the
state's own machine, and the timer is written in the transaction that entered the state. That is
exactly what `expiryActions.withdrawExcludeReplan` does for the one path Phase 5 owned.
**Taking ownership of the transitions remains open and remains §4.4's question**; it is recorded
as such rather than settled by a fix aimed at a different invariant.

**Fix.** `src/engine/cutover/legEntryDeadline.js` (new, Phase 15) — one implementation instead
of four. It cancels the exited state's deadline and arms the entered state's, keyed on the
version the conditional write produced, with the parameter read from `legMachine.deadlineFor`.
An unresolvable duration **throws**, rolling the caller's whole write back, on Phase 5's own
precedent: *"committing the withdrawal while failing to arm the requeued Leg's deadline
produces exactly the unsupervised state §4.5 exists to prevent."* Called from
`offer.handler.js` (one call site on the shared applied path, so all three dispositions are
covered) and from `outbox.worker.performWithdrawal`.

**Regression.** 9 tests, plus two in `dispatchEscalation.test.js` (see §13). **Live: D-ACCEPTED,
D-QUEUED, D-PLANNED, D-ROLLBACK, D-PLANTED — the last of which plants the old behaviour, shows
`timers.findUnsupervised` reporting the Leg, and shows the report clearing once the deadline is
armed. Mutations M11, M12, M13: caught.**

---

## 8. X3 — classified, not fixed

The mandate is explicit: *"If Phase 15 owns that production wiring, implement it. If the frozen
specification does not define the missing Task transition semantics, DO NOT invent them."*

**The production composition gap has a single root, and it is not composition.** Nothing anywhere
writes a §4.2 Task state:

```
$ every `timers.register(` call under src/ that names ENTITY_TYPE.TASK  →  none
$ live: TASK-entity timers in the store after a full harness run       →  0
$ services/task.service.js:391  data: { …, status: "PENDING" }
    taskMachine.isLegacyState("PENDING") === true
    taskMachine.isEngineState("PENDING") === false
```

The production intake path — gated on the *live* cutover, so this is what a cut-over shard does
— creates the Task in the **legacy** vocabulary. `taskMachine.js` says whose decision that is:

> `TaskStatus` carries both the §4.2 states and the legacy dispatcher's `PENDING` / `ASSIGNED` /
> `IN_PROGRESS` … **No mapping between the two is offered here** — inventing one would be
> deciding the cutover semantics four phases early, **and Phase 15 owns that**.

So Phase 15 does own the mapping. **And it cannot take it, because §4.2 supplies no transition
table.** Phase 5's closure §17 A3 established this and it re-derives on the current tree:

```
$ transitions.TRANSITIONS rows whose `from` is a §4.2 Task state  →  0
$ taskMachine.deadlineFor("RECEIVED")                             →  { parameter: "intake.validation_budget", … }
```

Writing `RECEIVED` at intake is the one step §4.2 does define. Doing it and nothing else would
arm `intake.validation_budget` on a state with **no defined exit** — a deadline no component can
discharge, which is precisely the `ABORTING` defect Phase 5 fixed as D5-7, reintroduced
deliberately and at the customer-visible layer. It would also break every legacy consumer of
`PENDING` in the same commit.

**Verdict: X3 is a SPECIFICATION blocker, not a composition blocker.** The seven Task expiry
handlers are implemented, unit-tested at the handler boundary, and **unreachable**. Pinned by
live check G1 and by three unit tests, so the classification fails loudly if the specification
or the intake path changes.

**Owner:** whoever owns §4.2's transition semantics — the same open programme decision Phase 5
recorded as ambiguity A3. Not this phase, and not by invention.

---

## 9. Invariants — WIRED, not OBSERVED

22 invariants, all checked by `observability/invariantChecker.CHECKS` (`I1`…`I22`).

**Is `invariantWorker.start()` genuinely composed? — YES.** `server.js`'s
`startScheduledWorkers()` starts it whenever `ENGINE_ENABLED` is true, with `prisma`, `kv`, an
`emit` bound to the dashboard room, and a full check context (`invariant.monotonicity_window`,
`sla.assignment_deadline`, the energy tier budgets, the §18.6 escalation parameters). Recorded
as **WIRED**.

**Does it actually run?** Yes, on `invariant.check_interval`, for any process with the engine
enabled — not only the leader.

**Can violations be measured?** Yes. I4's detector is exercised live in this exercise: check
`D-PLANTED` plants an unsupervised `ACCEPTED` Leg, `timers.findUnsupervised` reports it, and the
report clears when supervision is restored. That is the invariant checker's substrate working
against a real database.

**Can the release gate legitimately evaluate `invariants_enforced`? — NO, and the missing
requirement is production observation, not wiring.** The gate is `PRODUCTION` evidence; §26
requires every invariant `ENFORCED` in *nominal operation*, and there is no fleet. `evidence.js`
refuses a run record filed against it (attack F-`invariants_enforced`), which is correct: a build
must not close it.

**So: not a wiring defect. An observation blocker.** Stated that way because the mandate asks
for the distinction and because the earlier report's *"the invariant worker runs; production
traffic is external"* is exactly right and survives re-derivation.

One consequence worth naming: **the two live paths this exercise fixed were I4 violations.** With
the cutover enabled and X2a unfixed, the invariant checker would have reported I4 `VIOLATED` on
the first accepted offer — so the observation blocker and the composition defects were not
independent. Fixing X2a/X2b is a precondition for the observation window being able to start
clean.

---

## 10. Shadow path and B1

### 10.1 The shadow path, traced

```
production decision  → nothing. `coordinator.worker.runRound` has no production caller.
shadow worker        → registry.WORKERS.shadow is DEFERRED; startScheduledWorkers does not start it
solve path           → observability/shadow.js calls deps.round.plan() with expandCandidates
                        and pricedCandidateFor — the SAME path the coordinator uses
                        → plan/insertion → planBuilder.hopsForSequence → routing/cellPairCache.hopsFor
                        → deps.route     ←── THE ROUTING ENGINE. B1 has selected none.
shadow result        → never produced
persistence          → no ShadowDecision rows are ever written
comparison           → never runs
agreement metric     → never computed
release gate         → shadow_agreement: NOT_EVALUATED
```

**Can the 14-day window begin? — NO.** The system is not short of the window; **it cannot start
the clock.** No shadow evidence was manufactured, and `evidence.js` refuses a four-minute
"fourteen-day" claim by name (attack F5).

### 10.2 What B1 blocks, reconfirmed

`npm run routing:readiness` — unchanged by this work:

```
OVERALL: BLOCKED
  BLOCKED  D1  [Operations + Commercial]      no authoritative operating region declared
  BLOCKED  D3  [Product + Fleet Engineering]  no fleet speed model exists
  BLOCKED  D8  [Operations]                   extract vintage / cadence / budget undecided
  BLOCKED  step 5  ENGINE SELECTION — no recorded evidence exists
```

**No router was invented.** Classified **EXTERNAL**.

**And no unrelated Phase 15 work is hidden behind it.** That was checked rather than assumed:
every one of the six findings in §7 is in a module that has nothing to do with routing, and all
six are fixed. The residue behind B1 is exactly two workers — `coordinator` and `shadow` — and
they are named in `leaderWorkers.UNCOMPOSABLE` and `registry.WORKERS` respectively, with owners.

### 10.3 Blocker taxonomy, as the mandate requires

| | Item | Status |
|---|---|---|
| **In-repository blocker** | *(none remaining)* | all six found in this audit are fixed |
| **External blocker** | B1 routing engine (D1, D3, D8) → `coordinator`, `shadow`, `engine_decision_path_wired` | OPEN |
| **External blocker** | B8 calibration — 39 Safety-class parameters; **and the register's own defaults are not a publishable configuration** (§14) | OPEN |
| **Observation blocker** | `invariants_enforced`, `soak` (72 h), `simulator_fidelity`, `shadow_agreement` (14 d, cannot start) | OPEN |
| **Evidence blocker** | 3 `ORGANISATIONAL` gates need a named human act; 2 also need a clean corroborating run, and `gate:calibration` exits 1 | OPEN |
| **Specification ambiguity** | X3 — §4.2 has no transition table (§8); §4.4 has no `OFFERED → PLANNED` row (§7) | OPEN |
| **Future-phase dependency** | T1-04's §17.4 ladder (Phase 5's X1); Phase 16's Tier 2 mechanisms | OPEN |

---

## 11. Attacking the release gate again

`61/61`, against the current tree, through the shipped modules. The complete path was attacked:
**source → gate → evidence producer → evidence → admission → verdict → cutover.**

| Group | Attacks | Result |
|---|---|---|
| table | every gate blocking; no `WAIVED`, `SKIP` or `EXEMPT` status exists | 2/2 |
| **A — hand-authored booleans** | 24 hand-typed `{pass:true}` records → **0 green, 24 red**; `authoriseEnable` refuses with `RELEASE_GATE_NOT_GREEN` | 2/2 |
| **B — the digest binding** | another tree; no digest on the record; **no digest in the evaluation context** (omission is not a bypass); a `VOID:tree-changed-during-collection` stamp refused against any tree | 6/6 |
| **C — the exit code decides** | `pass:true` over exit 1; missing, non-integer and absent exit codes; wrong command; wrong gate id | 7/7 |
| **D — malformed / anonymous** | `null`, `true`, `"yes"`, `1`; no producer; no instant; from the future; stale | 8/8 |
| **E — `NOT_EVALUATED` is not a pass** | empty set → 24 not evaluated, BLOCKED; **all 17 build/suite gates green still BLOCKED** (7 remain) | 3/3 |
| **F — a build cannot close what it may not** | a run record against each of the 4 `PRODUCTION` gates; unowned; no window; unresolved bound; 1 h vs 72 h soak; 4 min vs 14 d shadow | 9/9 |
| **G — attestations** | no corroborating run; a corroborating run exiting 1; from another tree; self-approved; no approver; **and the satisfiable case is admitted** | 6/6 |
| **H — the rehearsal (ADR-34)** | no rehearsal; in production; `production` undefined; hand-called rollback; **each of the 6 steps omitted individually and refused by name**; exclusion set is exactly one; a production cutover sets aside nothing; an unknown purpose is refused | 9/9 |
| **I — the collector** | all-failing collection reports not-ok and produces 0 green; a killed process is a failure not a zero; no record for `PRODUCTION`/`ORGANISATIONAL`; corroborations discharge nothing | 5/5 |
| **J — the verdict** | no evidence file → BLOCKED; bound to this tree's digest; a build/attestation collision is RED; unknown gate ids surfaced | 4/4 |

**Mutation-tested separately.** The earlier report's M10 (replacing `evidence.admit()` with a stub
that trusts `record.pass`) still fails the suite; this exercise adds 14 mutations of its own
(§12).

**One thing recorded rather than fixed.** A run record carries the digest **twice** — on
`record.build` and on `record.run.build` — and `admit()` reads only the first. The collector
writes both to the same value, so no attack follows from it, but two fields that look
authoritative and are not is the shape of the defects this whole document is about. Attack B6
pins the actual behaviour so a future reader does not audit the wrong one.

---

## 12. Mutation results — 14/14 caught

Each protection was removed from a real source file, the tests that should catch it were run and
required to **fail**, the file was restored byte-for-byte, and they were required to pass again.

| | Protection removed | Verdict |
|---|---|---|
| M1 | `configEnabled` refuses the per-shard question with no region (P15-R5) | **CAUGHT** |
| M2 | the socket intake path reads a snapshot that exists (P15-R4) | **CAUGHT** |
| M3 | the degraded-mode accessor is awaited (P15-R3) | **CAUGHT** |
| M4 | the delivery arm forwards the accessor rather than invoking it at bind time (P15-R3) | **CAUGHT** |
| M5 | an unreadable mode set refuses the delivery (P15-R3) | **CAUGHT** |
| M6 | the propagator does not install an unversioned snapshot (P15-R2) | **CAUGHT** |
| M7 | a failed pull keeps the version in hand (P15-R2) | **CAUGHT** |
| M8 | the rollback publisher refuses anything that is not a disable (P15-R1) | **CAUGHT** |
| M9 | the rollback carries the version in force forward (P15-R1) | **CAUGHT** |
| M10 | the rollback pins the version it published (P15-R1) | **CAUGHT** |
| M11 | an unresolvable deadline refuses rather than committing an unsupervised Leg (X2a/X2b) | **CAUGHT** |
| M12 | the entered state's deadline is keyed on the version the write produced (X2a/X2b) | **CAUGHT** |
| M13 | the outbox worker's §11.4 requeue arms the `QUEUED` deadline (X2b) | **CAUGHT** |
| M14 | the LEADER_ONLY composers resolve configuration through the accessor (P15-R2) | **CAUGHT** |

**Three did not pass on the first attempt, and that is the part worth reading.**

- **M14 SURVIVED.** The test asserted the composer returned `ok: true` after a republish. With
  `valuesOf` stubbed to ignore the accessor, every parameter resolved to `undefined` and the
  composer still returned a handle — so the test passed. *A test that cannot tell a resolved
  configuration from an empty one is not testing the resolution.* Rewritten to spy on
  `outboxWorker.start` and assert the **resolved values** change across a republish.
- **M1 and M13 reported "COULD NOT APPLY".** The tree has mixed line endings — files predating
  this exercise are CRLF, files written whole are LF — and the anchors did not match. That
  status is indistinguishable at a glance from "applied and survived", which is how a mutation
  pass reports a protection it never tested. The harness now matches the file's own endings.

Both are recorded because a mutation pass that passes first time has usually been aimed at what
the tests already check.

---

## 13. Test integrity

**No test was deleted, skipped, weakened, or threshold-relaxed.** One new suite; two existing
tests corrected; one new test added beside them.

### Tests changed rather than added, and why each was wrong

`tests/engine/dispatchEscalation.test.js` — the two §11.4 step 2 tests. Named individually
because "I updated a test" is the sentence this exercise exists to distrust.

1. *"an offer that times out is actually withdrawn: fence advanced, commitment released, Leg
   requeued"* — asserted the fence, the `WITHDRAW`, the release and the Leg state, and **said
   nothing about supervision**. It therefore passed over a requeued Leg that no deadline
   governed, which is invariant **I4**'s violation and Phase 5's finding X2b. §17.4's ladder is
   invoked at `sla.assignment_deadline`; with no timer it was never invoked. **Now** asserts one
   pending `QUEUED` timer, its handler taken from `legMachine`, and its key on the version the
   withdrawal's own write produced.
2. The shared `withdrawalSettings()` helper gained `assignmentDeadlineSeconds`, which is the
   parameter the production composer resolves. Without it the withdrawal now refuses rather than
   committing an unsupervised Leg — which is the fix, and which is why the test had to change.
3. **Added:** *"a withdrawal whose requeue deadline does not resolve ROLLS BACK rather than
   leaving the Leg unsupervised"* — asserting no fence advance, no `WITHDRAW`, no release, no
   state change and no half-written supervision.

Both changed tests are **strictly stronger** afterwards, and both are mutation-tested (M11, M13).

### The new suite

`tests/engine/phase15CurrentTreeRemediation.test.js` — **50 tests**. Its own header states the
rule it works under: where a claim is a fact about `server.js` — which no test may require,
because Phase 0's scaffold guard forbids it — the source assertion is **paired with a
behavioural test of the module that text configures**. A source assertion alone is a proxy; a
behavioural assertion alone cannot see a dependency nobody supplies.

One thing that went wrong and is worth recording: the first version asserted the *absence* of
the old code as raw text, and failed — because the fix's own comment quotes the defect it
replaced. Source assertions now run against comment-stripped code, so they mean "no code does
this any more" rather than "nobody wrote about it".

---

## 14. Live PostgreSQL verification — 252 checks

A disposable **PostgreSQL 18.3** cluster on port **55436**, built from the installed binaries
into the scratchpad. The full migration chain applied **from an empty database**, verified empty
first:

```
tables before: 0
APPLIED 26 migrations
tables after: 74
```

| Harness | Checks | What it establishes |
|---|---|---|
| `tools/verify/phase15CurrentTree.js` | **32 / 32** | **NEW** — the six findings and X2a/X2b, end to end |
| `tools/verify/phase15LiveDatabase.js` | **12 / 12** | D-5 and D-6, unchanged and re-run |
| `tools/verify/phase5ExpirySemantics.js` | **102 / 102** | Phase 5's §4.5 semantics, unchanged and re-run |
| `tools/verify/phase5LiveDatabase.js` | **106 / 106** | Phase 5's schema/keying/lease/reconciler groups |

**Why a second harness rather than more checks in the first:** `phase15LiveDatabase.js` is the
evidence for D-5 and D-6 and is left exactly as it was, so the earlier claim stays reproducible
against the tree that made it.

### What live execution found that the unit suite could not

Three things, and this is the seventh consecutive phase in which that sentence has been true.

1. **`Shard.regionId` is a `Region` **row** id, not the region key.** This exercise's own first
   attempt at P15-R6 passed the wrong one. Failure mode: `NO_CONTACT_CONFIGURED`, silently, for
   ever. No fixture could distinguish the two.
2. **The register's own defaults are not a publishable configuration.** Every publish in the
   harness had to bind one extra parameter:
   ```
   V9: combined degraded energy conservatism 2.0125 exceeds energy.max_combined_conservatism 1.6
       (nominal 1.4375 × route.degraded_reserve_factor = 1.4)
   ```
   `route.degraded_reserve_factor` is Safety-class, PROVISIONAL, and awaiting B8. **So a
   deployment cannot publish its first configuration version from defaults, which means it
   cannot stage any shard.** That is a consequence of B8 considerably sharper than "the
   calibration gate is red", and it is not something this phase may fix — changing the default
   would be inventing a calibration value. Recorded as an external blocker, owner B8, pinned by
   live checks F2 and G3.
3. **`ConfigVersion` is immutable at the database.** The harness's purge could not remove
   versions an earlier run had published: a trigger raises `P0001 — ConfigVersion is immutable
   once published (§22.1 rule 3)`. That is the rule working at the layer that matters, and it is
   now a check of its own (F1b) rather than an inconvenience worked around.

### Adversarial and planted checks in the live harness

| | Planted | Result |
|---|---|---|
| C3 | the composition root's **old** `activeModes: () => []` binding, against a real open `CUSTODIAL_OPERATION` row | the command is delivered — **the finding, reproduced beside its fix** |
| B6 | a "rollback" carrying an ENABLE | refused `BINDING_NOT_A_DISABLE`; `ConfigVersion` count unchanged |
| D-PLANTED | the state written with no deadline registered | `findUnsupervised` reports the Leg (I4), and stops once supervision is restored |
| D-ROLLBACK | an unresolvable deadline mid-transaction | `state=OFFERED version=0`; the `OFFERED` deadline survives; nothing half-applied |
| A5 | the configuration store unreachable mid-pull | the snapshot in hand is kept; one error reported; never a downgrade |
| F1b | `DELETE` on a published `ConfigVersion` | `P0001`, row survives |

Transaction boundaries, concurrency, idempotency, rollback, stale state, restart, demotion and
evidence persistence are covered across the four harnesses; the Phase 5 pair carries the timer
subsystem's own 24-attack matrix unchanged.

---

## 15. Calibration — re-run, nothing manufactured

```
$ npm run gate:calibration    exit 1
  FAIL — 39 blocking finding(s).
  242 entries: 52 DERIVED, 152 PROVISIONAL, 38 UNCALIBRATED. 54 are Safety-class.
```

**Identical to the baseline. No value was promoted, derived, defaulted or attested.**

| | Count | Disposition |
|---|---|---|
| Safety-class total | 54 | — |
| **DERIVED** | 15 | already discharged |
| **Requires measured production or fleet data** | the bulk of the 39 | e.g. `connectivity.max_heartbeat_age` (measured heartbeat inter-arrival per radio class), `security.energy_rate_tolerance` (measured residual of §14.2's model), `shard.store_round_trip_budget` (measured p99 to the operated store) |
| **Requires an external authority decision** | e.g. `ops.emergency_services_hazard_threshold`, `ops.external_escalation_contacts`, `ops.stranded_obstructing_response_target` | a safety decision with local emergency services / the highway or site authority / the infrastructure operator |
| **Requires vendor or certification data** | e.g. `payload.safety_factor` (per-class rated-mass certification), `payload.mass_discrepancy_tolerance_kg` (on-board scale accuracy per container model) | — |
| **Genuinely unavailable before the fleet operates** | e.g. `sim.max_optimistic_bias` (the first one-sided fidelity study against production) | §22.4's own words: values that *"require data the fleet does not yet produce and cannot produce before it operates"* |

**Can any value be incorrectly promoted?** Attacked: no. `calibration_safety_derived` is
`ORGANISATIONAL` **and** `runnable`, so `evidence.admit()` requires two distinct signatures **and**
a corroborating run of `npm run gate:calibration` exiting 0, bound to this tree's digest.
Attack G2 files the attestation while the check exits 1 and it is refused —
*"an attestation cannot outrank the check it is an attestation about."*

**Can the gate be bypassed?** No. It is blocking, there is no `WAIVED` status, `NOT_EVALUATED`
blocks exactly as `RED` does, and the rehearsal purpose sets aside exactly one gate and it is not
this one.

**`NOT_EVALUATED` remains `NOT_EVALUATED` everywhere evidence does not exist.**

---

## 16. Production composition verification

For every dependency each Phase 15 worker reads from context or configuration, the production
tree was searched for its producer; where the only producer was a test fixture, it was
classified a production composition failure. That search is what produced P15-R2, R3 and R6.

### The LEADER_ONLY lifecycle, as `server.js` now composes it

| Dependency | Producer | Before |
|---|---|---|
| `prisma`, `kv`, `io` | process context | ✔ |
| `runInTransaction` | `runSerializable` | ✔ |
| `values` | **`() => app.locals.config.values`** — an accessor | was the boot snapshot's map, frozen for the process's life (**P15-R2**) |
| `shardId` | `process.env.SHARD_ID` | ✔ |
| `regionId` | **`Shard → Region.regionId`** | **absent** (**P15-R6**) |
| `deliver` | **`dispatchOutboxCommand(io, { activeModes: () => degradedTransitions.activeModes(…) })`** | `activeModes: () => []` (**P15-R3**) |
| `signingKey` | `process.env.COMMAND_SIGNING_KEY` | ✔ |
| `record`, `onError`, `logger` | process context | ✔ |
| `assignmentDeadlineSeconds` (outbox) | **`sla.assignment_deadline`** | absent (**X2b**) |

### The scheduled workers

| | Producer for its live inputs |
|---|---|
| `invariant` | composed in full; **WIRED** (§9) |
| `cutover` | `liveShards` now reads the **current** snapshot; `publish` now **publishes and pins** (P15-R1, P15-R2) |
| `tier_b`, `rejection_aggregation`, `calibration`, `counterfactual`, `certificate_rotation` | unchanged |
| `configPropagation` | **new** — `loadPinnedSnapshot` → `app.locals.config` |

### Can the production path reach the new work?

```
src/engine/cutover/configPropagation.js   reachable from server.js: true
src/engine/cutover/rollbackPublisher.js   reachable from server.js: true
src/engine/cutover/legEntryDeadline.js    reachable from server.js: true
```

Reachability is the weak check and it is not the one relied on: each of the three is also
driven end to end against a real database by group A, B and D of the live harness, through the
dependency objects `server.js` builds.

**Missing dependencies that remain, and their owners.** `ladder` → T1-04 (Phase 5's X1).
`probe` → §10.3.1 makes it a transport call; its absence costs a diagnostic. `route` → B1.
**None is stubbed.**

---

## 17. Cross-phase integrity

**Phases 0–4 are unchanged.**

```
$ git status --porcelain | grep -E "prisma/|src/db/|src/engine/(commitment|dispatch|domain|shard)/"
NONE
```

No migration added; the schema is byte-identical. `prisma/migrations/` untouched; 26 migrations
apply cleanly from empty.

**Phase 5 is unchanged and re-verified.** No file under `src/engine/supervision/` or
`src/engine/lifecycle/` was touched by this exercise. Its two harnesses pass at **102/102** and
**106/106** on the post-remediation tree, and Phase 5's six suites are green inside the full run.

### Files modified outside Phase 15's own modules — reported explicitly, as §13 of the mandate requires

| File | Phase | Change | Why it belongs to Phase 15 |
|---|---|---|---|
| `src/services/commandDispatcher.service.js` | 0 / legacy tree | `await` the `activeModes` accessor; forward it from `outboxDeliveryArm`; refuse by name when it throws | **P15-R3.** The module's own comment says the mode set comes from the drain worker; the drain worker is Phase 15's composition. The seam did not admit an asynchronous producer, so the composition root could not supply one. Every existing caller is behaviourally identical: `await` on a non-promise is the identity, and a caller passing no options still sees an empty set. |
| `src/workers/outbox.worker.js` | 4 (§11.4 ladder), Tier 0 | register the requeued Leg's §4.5 deadline in the withdrawal transaction | **X2b.** Phase 5 reproduced it live and routed it here by name. The path became live only when Phase 15 wired this worker into the composition root; the divergence is between this path and Phase 5's own, and Phase 15 created it. |
| `src/sockets/socket.server.js` | 0 / 5 | `appLocals?.config` instead of `io?.app?.locals?.config` | **P15-R4.** The per-shard cutover is the Phase 15 deliverable and this is one of its call sites — the one Phase 14's P14-R1 did not convert. |
| `src/sockets/handlers/offer.handler.js` | 4 | arm the entered state's deadline on the applied path | **X2a**, same argument as X2b. The handler is already a Phase 15-converted call site (D-6). |
| `src/engine/cutover/enabled.js` | 15 | refuse the per-shard question with no region | Phase 15-owned module. |
| `server.js` | 15 | the propagator, the rollback publisher, the mode producer, the region, the values accessor | Phase 15 owns the composition root. |
| `tests/engine/dispatchEscalation.test.js` | 4 tests | two tests strengthened, one added | §13. |
| `tests/engine/phase0Scaffold.test.js` | 0 tests | three new modules registered against Phase 15 | The guard requires it. |

**Does any of this reopen an earlier phase?** No. Full suite green (157 / 6 960); Phase 5's live
harnesses green; the legacy lane green at 126; `gate:legacy` still reports the four retired
modules absent. Phase 0's scaffold guard is intact — `server.js` still names none of the outbox,
timer or reconciler worker modules. **No gate threshold was moved and no assertion was relaxed.**

---

## 18. Exact measured results

### Test suites

```
Test Suites: 157 passed, 157 total
Tests:       6960 passed, 6960 total
Time:        419.084 s
```

| Lane | Tests |
|---|---|
| engine | 6 619 |
| gates | 148 |
| legacy | 126 |
| chaos | 44 |
| scale | 23 |
| **total** | **6 960** |

Baseline was 156 / 6 909. One new suite (50 tests) and one added to `dispatchEscalation`.

**One flake observed and diagnosed, not suppressed.** During an intermediate run with four
background jobs competing for the machine, `tests/scale/round.scale.test.js`'s *"LINEAR in batch
size"* assertion failed at 74.4 s wall-clock. Re-run in isolation it passes in 20.5 s. It is a
wall-clock **measurement**, and the final run above — with nothing else running — is green. It is
recorded rather than ignored, because a load-sensitive assertion in a release-gate lane is worth
somebody's attention.

### Build gates — 7 PASS, 1 FAIL (correctly)

```
gate: tier-dependencies          PASS — 285 modules, 420 governed edges, no Tier 0/1 → Tier 2
gate: parameter-register         PASS — 189 modules against 242 registered parameters
gate: tenets                     PASS — 282 modules, no violations
gate: identity-isolation         PASS — 16 modules
gate: reconstruction-equivalence PASS — 3 decisions, byte for byte
gate: legacy-retirement          PASS — 4 retired modules absent, 338 files
gate: column-generation          PASS — NOT_REQUIRED
gate: composition-root           FAIL — 1 violation across 18 workers:
    coordinator (tier 0) [LEADER_ONLY_NOT_COMPOSABLE] … B1 … EXTERNAL to this repository
npm run gates                    exit 1
```

**Unchanged from the baseline, and that is the correct outcome.** None of the six fixes touches
the composition gate's one remaining violation, and the gate was not modified.

### The other two

```
npm run gate:calibration   exit 1 — 39 findings (unchanged)
npm run sim:fidelity       exit 1 — 7 models NOT_MEASURED, 6 safety-relevant (unchanged)
```

### Live database

```
tools/verify/phase15CurrentTree.js     32/32
tools/verify/phase15LiveDatabase.js    12/12
tools/verify/phase5ExpirySemantics.js  102/102
tools/verify/phase5LiveDatabase.js     106/106
                                       ─────
                                       252
```

### Mutation and attack passes

```
14/14 mutations caught
61/61 release-gate attacks passed
```

### Release verdict

*(§19 — measured, not predicted.)*

---

## 19. `npm run release:gates`, measured

Run to completion on an untouched tree. Nothing below is predicted; it is what the tool printed.

### 19.1 The collection

```
source digest 22ca91435d46cf2abf03932637637bcb7986f23c71090211637190305fbb5b00  (560 files)

  FAIL      935ms  npm run gate:calibration          ← corroborating run, not evidence
  PASS     1442ms  npm run gate:legacy
  FAIL     1715ms  npm run gate:composition
  PASS   180054ms  npm run test:engine -- candidatesLowerBound
  PASS   196722ms  npm run test:engine -- ModelCheck
  PASS   182993ms  npm run test:engine -- determinism
  PASS   184668ms  npm run test:engine -- observabilityDecisionRecord
  PASS     2621ms  npm run test:chaos
  PASS     2572ms  npm run test:chaos -- cacheFlush
  PASS    22980ms  npm run test:scale
  PASS    24879ms  npm run test:scale -- locality
  PASS    21461ms  npm run test:scale -- overload
  PASS      235ms  node tools/safetyCase/assemble.js  ← corroborating run, not evidence
  (plus gate:tiers, gate:params, gate:tenets, gate:privacy, gate:erasure — all PASS)

  17 gate record(s), 2 corroborating run(s).
  PRODUCTION and ORGANISATIONAL gates are not closable here and remain NOT_EVALUATED.
```

The digest taken **before** the first gate and **after** the last agreed, so the collection is
valid: no edit landed during the ~20 minutes it took.

### 19.2 The verdict

```
RELEASE VERDICT — §24 gate table (24 gates, all blocking)
  source digest 22ca91435d46cf2a…   evidence: docs/release-evidence.json   attestations: (none)
  16 green, 1 red, 7 not evaluated

  GREEN         tier_dependencies                    BUILD           §1.8
  GREEN         parameter_register                   BUILD           §22.1
  GREEN         design_tenets                        BUILD           §1.5
  GREEN         identity_isolation                   BUILD           §23.7
  GREEN         erasure_reconstruction_equivalence   BUILD           §23.7, §24.3
  NOT_EVALUATED calibration_safety_derived           ORGANISATIONAL  §22.4
  GREEN         legacy_removed_from_build            BUILD           execution plan, Phase 15
  RED           engine_decision_path_wired           BUILD           execution plan, Phase 15
                    exit 1 from `npm run gate:composition`
  GREEN         lower_bound_admissibility            SUITE           §6.4, §24.1
  GREEN         model_check_capacity_1_2_3           SUITE           §24.2
  GREEN         determinism_replay                   SUITE           §24.3
  GREEN         snapshot_retention                   SUITE           §24.3
  GREEN         chaos_capacity_1                     SUITE           §24.5
  GREEN         chaos_capacity_2                     SUITE           §24.5
  GREEN         cache_tier_flush                     SUITE           §3.3, §24.5, I16
  GREEN         scale_targets                        SUITE           §20.1, §24.6
  GREEN         locality                             SUITE           §24.6, T9
  GREEN         overload_admission_control           SUITE           §20.5, §24.6
  NOT_EVALUATED invariants_enforced                  PRODUCTION      §26
  NOT_EVALUATED simulator_fidelity                   PRODUCTION      §24.4
  NOT_EVALUATED soak                                 PRODUCTION      §24.6
  NOT_EVALUATED shadow_agreement                     PRODUCTION      §21.6
  NOT_EVALUATED safety_case_assembled                ORGANISATIONAL  §24.7
  NOT_EVALUATED rollback_rehearsed                   ORGANISATIONAL  execution plan, Phase 15

  RELEASE: BLOCKED — 8 blocking gate(s) are not green.

exit 1
```

**The one RED is `engine_decision_path_wired`, and it is red for B1.** Every gate a build may
legitimately close is green; the eight that are not are the two external blockers, the four
observation windows and the three human acts, minus overlap.

Two things the table shows that are worth pointing at:

- **`calibration_safety_derived` is `NOT_EVALUATED`, not `RED`, even though its command
  exited 1.** That is correct and it is the taxonomy working: the collector ran
  `gate:calibration` as a **corroboration** and wrote it under a separate key, because an
  `ORGANISATIONAL` gate is not closable by a build. Nobody has filed the attestation, so nobody
  has evaluated the gate. An incident review can tell "we ran it and it failed" from "nobody
  filed it", which is the distinction the two statuses exist for.
- **`safety_case_assembled` is `NOT_EVALUATED` while `node tools/safetyCase/assemble.js` exited
  0.** A clean corroborating run discharges nothing on its own. This is the case the earlier
  remediation built the corroboration mechanism *for*, and it is behaving as designed.

### 19.3 The binding, demonstrated rather than asserted

The mandate asks for proof that stale evidence is rejected and that changed source invalidates
evidence. Both, end to end, against the evidence file the run above produced:

```
1. verdict on the untouched tree
     source digest 22ca91435d46cf2a…
     16 green, 1 red, 7 not evaluated        RELEASE: BLOCKED

2. one comment line appended to one in-scope test file
     20d7315466628d87…  (560 files)
     0 green, 17 red, 7 not evaluated
       [SOURCE_DIGEST_MISMATCH] record ran against source 22ca91435d46 and this tree is
       20d731546662. A gate that passed on a different tree is evidence about a program
       nobody is shipping.        (×17)

3. the file restored byte-for-byte
     identical
     22ca91435d46cf2a…  (560 files)
     16 green, 1 red, 7 not evaluated        RELEASE: BLOCKED
```

**Seventeen green gates become seventeen red ones on a single added comment**, and come back on
an exact restore. The evidence is bound to this tree and to no other.

---

## 20. Remaining limitations

Genuine unresolved items only.

1. **The decision path cannot be composed.** `coordinator` and `shadow` both terminate in a
   routing engine B1 has not selected. **EXTERNAL.**
2. **39 Safety-class parameters are not DERIVED**, and — newly measured here — **the register's
   own defaults are not a publishable configuration** (V9). A deployment cannot publish its
   first version without binding `route.degraded_reserve_factor`, which is itself one of the 39.
   **EXTERNAL, owner B8.**
3. **Four `PRODUCTION` gates need a fleet that has operated.** `shadow_agreement` cannot even
   start its clock.
4. **Three `ORGANISATIONAL` gates need a named human act**, and two of them additionally need
   `gate:calibration` to exit 0.
5. **X3 — §4.2's half of §4.5 is unreachable**, and making it reachable requires transition
   semantics the frozen specification does not contain. **SPECIFICATION.**
6. **§4.4 has no `OFFERED → PLANNED` row** for §11.2's `DEFER`. The deadline is armed; the
   transition is not run through §4.4, and no row was invented.
7. **`transitions.apply` still has no production caller outside supervision.** Phase 5's X2 in
   full remains open; this exercise closed the *supervision* half of it (I4), not the ownership
   transfer.
8. **A republish does not restart a worker.** Cadences and composition-time settings are adopted
   at the next promotion or restart, not at the next pull.
9. **T1-04's §17.4 ladder is unimplemented**, so `ESCALATION_LADDER` refuses and re-arms
   (Phase 5's X1, unchanged).
10. **A global `cutover.engine_enabled = true` binding would stage every region at once.** Not
    reachable through `authoriseEnable`, which only emits region scope; reachable by hand.
    Recorded, not blocked.
11. **`prisma migrate diff` still reports the Phase 1 drift** (`ConfigActiveVersion_version_fkey`).
    Carried forward, not re-investigated.
12. **The `scale` lane holds a load-sensitive wall-clock assertion** (§18).

---

## 21. Exact commands

```bash
cd Backend

# ── baseline, before any change ────────────────────────────────────────────
npx jest --runInBand --forceExit                      # 156 suites / 6909 tests
npm run gates                                         # exit 1 — composition (1)
npm run gate:calibration                              # exit 1 — 39
npm run sim:fidelity                                  # exit 1
npm run routing:readiness                             # BLOCKED — D1, D3, D8
node tools/release/sourceDigest.js

# ── disposable PostgreSQL 18.3, port 55436, migration chain from empty ─────
initdb   -D <scratch>/pg15data -U pgverify --pwfile=<file> -A trust -E UTF8 --locale=C
pg_ctl   -D <scratch>/pg15data -l <scratch>/pg15.log -o "-p 55436 -c listen_addresses=127.0.0.1" start
createdb -h 127.0.0.1 -p 55436 -U pgverify robotx_p15final
for d in prisma/migrations/*/; do
  psql -h 127.0.0.1 -p 55436 -U pgverify -d robotx_p15final -v ON_ERROR_STOP=1 -q -f "${d}migration.sql"
done                                                  # APPLIED 26 migrations, 0 → 74 tables
export DATABASE_URL="postgresql://pgverify:pgverify@127.0.0.1:55436/robotx_p15final"
npx prisma generate

# ── reproductions, before the fixes ────────────────────────────────────────
node <scratch>/repro_n1_n2.js                         # P15-R1, P15-R3
node <scratch>/repro_intake.js                        # P15-R4, P15-R5

# ── verification, after ────────────────────────────────────────────────────
node tools/verify/phase15CurrentTree.js               # 32/32
node tools/verify/phase15LiveDatabase.js              # 12/12
node tools/verify/phase5ExpirySemantics.js            # 102/102
node tools/verify/phase5LiveDatabase.js               # 106/106
node <scratch>/attack_release_gate.js                 # 61/61
node <scratch>/mutate.js                              # 14/14 caught
node <scratch>/reach.js                               # 208/285 reachable

npx jest --runInBand --forceExit                      # 157 suites / 6960 tests
npx jest --runInBand --forceExit --selectProjects engine|gates|legacy|chaos|scale
npm run gates                                         # exit 1 — composition (1)
npm run gate:calibration                              # exit 1 — 39
npm run sim:fidelity                                  # exit 1
npm run release:gates                                 # the whole table, judged  (~25 min)

# ── cross-phase integrity ──────────────────────────────────────────────────
git status --porcelain | grep -E "prisma/|src/db/|src/engine/(commitment|dispatch|domain|shard)/"
grep -rn "MUTATED" Backend/src Backend/server.js

# ── teardown ───────────────────────────────────────────────────────────────
pg_ctl -D <scratch>/pg15data -m fast stop
```

**Do not edit the tree while `release:gates` runs** — the collection is void if the source digest
moves between the first gate and the last, and it says so.

---

## 22. Files changed

**New**

| Path | Purpose |
|---|---|
| `Backend/src/engine/cutover/configPropagation.js` | P15-R2 — the pull half of §22.1 rule 4's pull-with-pin |
| `Backend/src/engine/cutover/rollbackPublisher.js` | P15-R1 — the publish that makes §22.4 item 4's automatic rollback take effect |
| `Backend/src/engine/cutover/legEntryDeadline.js` | X2a / X2b — §4.5's deadline for a Leg state entered outside §4.4 |
| `Backend/tests/engine/phase15CurrentTreeRemediation.test.js` | 50 tests |
| `Backend/tools/verify/phase15CurrentTree.js` | 32 live-PostgreSQL checks |

**Modified**

| Path | Change |
|---|---|
| `Backend/server.js` | the propagator; the rollback publisher; the real `activeModes` producer; the shard's region; `values` as an accessor; `snapshotOf` for the controller; the propagator stopped on shutdown |
| `Backend/src/engine/cutover/enabled.js` | `configEnabled` refuses without a region; `REGION_UNRESOLVED` |
| `Backend/src/services/commandDispatcher.service.js` | the mode accessor is awaited and forwarded; an unreadable mode set refuses by name |
| `Backend/src/sockets/socket.server.js` | `appLocals?.config` for the socket intake path |
| `Backend/src/sockets/handlers/offer.handler.js` | the entered state's §4.5 deadline, on the applied path |
| `Backend/src/workers/outbox.worker.js` | the requeued Leg's §4.5 deadline, in the withdrawal transaction |
| `Backend/src/workers/leaderWorkers.js` | `valuesOf` accessor; `assignmentDeadlineSeconds` and `shardId` for the outbox; the dead `activeModes` dep removed |
| `Backend/tests/engine/dispatchEscalation.test.js` | two tests strengthened, one added |
| `Backend/tests/engine/phase0Scaffold.test.js` | three new modules registered against Phase 15 |
| `docs/runbooks/cutover.md` | prerequisite 3 is also a *deployment* prerequisite (V9); §3.3 gains publish-**and-pin** and the propagation confirmation step |
| `docs/runbooks/rollback.md` | §3 states how the automated publish is permitted, that it pins, and that propagation is not instant |

Both runbook files sit outside the source-digest scope (`src`, `tools`, `tests`,
`package.json`, `jest.config.js`), which was verified after editing them: the digest is
unchanged at `22ca9143…`, so §19's evidence is still bound to the tree it was collected on. A
gate's verdict must not move because a runbook was reworded, and it did not.

**Deleted:** none. **Migrations:** none. **Register changes:** none. **ADRs:** none — see P15-R1.
**Gate thresholds moved:** none.

---

## 23. Phase 16 contamination check

**CLEAN.** `src/engine/fairness/` holds no runtime module. `branchAndBound` absent. Every Tier 2
kill switch thrown by default. `tierTwoAtShipState` refuses a cutover with any Tier 2 mechanism
live, under `PURPOSE.REHEARSAL` too. `gate:tiers` passes over 285 modules and 420 governed edges
with no Tier 0/1 → Tier 2 dependency, including the three modules added here.

---

## 24. Explicitly NOT proven

Stated plainly, because a closure that omits this section is not one.

1. **Nothing here proves the engine assigns work.** `coordinator.worker` remains uncomposable. A
   shard with `ENGINE_ENABLED=true` today would supervise deadlines correctly, deliver commands
   correctly, publish and observe cutover bindings correctly — on Legs that nothing creates.
2. **No production environment was used.** Every measurement is from a disposable local
   PostgreSQL 18.3 instance and a single process. No soak, no multi-shard run, no real fleet.
3. **The automatic rollback has never fired against a real regression.** What is proven is that
   the controller's `publish` writes and pins a version that a real reader then resolves as
   `false`. Whether a real SLI window would breach as intended is a production observation.
4. **The configuration propagator has never adopted a version published by another process.**
   The live checks publish and pull within one process. Cross-process propagation rests on
   `pinVersion`'s database row and its `config:active` mirror, which are exercised, and on no
   process-affinity assumption — but it has not been demonstrated with two processes.
5. **§18.5's suspension has never been exercised against a real store outage**, only against a
   real `DegradedModeEvent` row entered through the shipped module.
6. **The §18.6 chain has still never contacted anyone.** `ops.external_escalation_contacts` is
   UNCALIBRATED, so a real fire would resolve no contact set even now; what P15-R6 fixes is that
   it will resolve one when B8 lands, instead of silently continuing not to.
7. **The seven TASK expiry handlers have never fired and cannot** (X3).
8. **`ESCALATION_LADDER` has never relaxed anything** (Phase 5's X1, T1-04).
9. **The `probe` in "probe, then reassign" has never been sent.**
10. **No shadow comparison has ever been computed**, and the 14-day clock cannot start.
11. **No §26 invariant has been observed in nominal operation.** The worker is WIRED; there is no
    traffic.
12. **The release evidence in §19 is bound to this tree and expires.** It is not a claim about
    any later tree, and `admit()` will refuse it against one.

---

## 25. Phase 0–5 integrity, restated

| | Check | Result |
|---|---|---|
| Phase 0 | scaffold guard: `server.js` names no `LEADER_ONLY` worker module directly | intact |
| Phase 0–4 | `prisma/`, `src/db/`, `src/engine/{commitment,dispatch,domain,shard}/` | **unmodified** |
| Phase 1 | register and validators | **unmodified**; V9's refusal is pre-existing and measured, not introduced |
| Phase 4 | `dispatch/offers.js` | **unmodified**; the deadline is armed by its callers, as Phase 5's own handler does |
| Phase 5 | `supervision/`, `lifecycle/` | **unmodified**; 208/208 live checks re-run green |
| Phases 6–14 | full suite | green — 157 / 6 960 |
| Migrations | 26, applied from empty | 0 failures |

---

## 26. Closure decision

The mandate's standard, item by item:

| Criterion | |
|---|---|
| all Phase-15-owned blockers fixed | **YES** — six found, six fixed |
| all Phase-15 production paths genuinely composed | **NO** — `coordinator` and `shadow` cannot be, and the blocker is external |
| no critical Phase-15 feature test-only | **YES** for everything this phase owns; the seven TASK handlers are Phase 5's and are unreachable for a specification reason (X3) |
| Phase-5 integration correct | **YES** — X2a and X2b closed; Phase 5's harnesses green |
| release evidence bound to the final tree | **YES** — §19 |
| `NOT_EVALUATED` never treated as `PASS` | **YES** — 61/61 attacks |
| no threshold weakened | **YES** |
| no evidence fabricated | **YES** |
| no test deleted, skipped or weakened | **YES** — §13 |
| live critical paths pass | **YES** — 252/252 |
| mutation protections caught | **YES** — 14/14 |
| Phases 0–5 intact | **YES** — §25 |

Every repository-owned item is met. One is not, and it is not a repository-owned item.

# PHASE 15 — BLOCKED

**Not closed**, and deliberately not relabelled. The mandate is explicit that completing all
repository-owned work does not convert a dependency into a closure, and the substantive reason
is unchanged from the two earlier reports:

> The real RobotX engine **cannot be composed**. Its decision path terminates in a routing engine
> that has not been selected, and selecting one is an Operations, Product and Commercial
> decision this phase does not own.

What changed is worth stating precisely, because it is not "nothing":

- **The cutover mechanism now works.** Before this audit a shard could not be taken live, could
  not be rolled back, and the automatic rollback of §22.4 item 4 was a log line. Three of the six
  findings were in that one mechanism, and all three were invisible to 6 909 passing tests.
- **§18.5's command suspension is enforced on the path every command takes.** It was not.
- **A permissive fail-open on the intake path is closed** — the one way past per-shard staging
  that did not require any credential at all.
- **Every Leg state the cutover makes reachable is supervised**, so the invariant window can
  start clean when there is traffic to observe.

### Phase 16 readiness — **NOT READY**

Phase 16 enables Tier 2 mechanisms one at a time on top of a shipped Tier 0 + Tier 1 engine
(§1.8 rule 3). There is no shipped engine to enable them on top of.

### Recommendation

1. **Route B1 and B8.** They are the whole of the remaining blocker set and neither is an
   engineering task. B8 is more urgent than the gate count suggests: the register's own defaults
   are not publishable (§14), so the calibration blocker is currently also a *deployment* blocker.
2. **Then T1-04** — §17.4's ladder is the last in-repository mechanism with no assigned phase, and
   `ESCALATION_LADDER` refuses without it.
3. **Then route X3** to whoever owns §4.2's transition semantics. It is a specification question
   and no amount of engineering closes it.
4. **Do not start Phase 16.**

**TRUTH > GREEN.**

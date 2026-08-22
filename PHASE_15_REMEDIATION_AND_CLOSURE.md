# Phase 15 — Targeted Blocker Remediation, Adversarial Re-verification and Closure

**Date:** 2026-08-22
**Branch:** `feature/dashboard`
**Baseline:** `PHASE_15_FINAL_IMPLEMENTATION_AND_CLOSURE_REPORT.md` (2026-08-21), commit `e5c9655`
**Scope:** D-5, D-4, D-6, D-7 — fix the root cause of each, attack the fixes, re-verify Phase 15
**Verdict:** **PHASE 15 BLOCKED — PHASE 16 NOT READY**

---

## 1. Executive summary

Two of the four targeted blockers are **fixed at the root, attacked, and mutation-tested**.
Two are not, and the reason they are not is the most important finding of this work:

> **D-5 and D-4 were misclassified.** The baseline report lists both under
> "**In-repository** (fixable here, not fixed)". They are not. The Tier 0 decision path
> terminates, at its leaves, in a **routing engine that B1 has not selected** — and B1 is
> blocked on D1, D3 and D8, which are Operations, Product and Commercial decisions. No
> commit in this repository closes them.

That is not a softer conclusion than the baseline's. It is a harder one. "We have not wired
it yet" is a task; "the thing it must be wired to does not exist, and choosing it is not
ours" is a dependency, and the difference decides whether Phase 15 can close on engineering
effort at all. It cannot.

| Blocker | Baseline classification | This work | Status |
|---|---|---|---|
| **D-6** socket shard staging | In-repository | **FIXED** at the root, live-DB verified | ✅ |
| **D-7** rehearsal/cutover circularity | Contract-level (needs ADR) | **FIXED** — ADR-34, no gate weakened | ✅ |
| **D-5** Tier 0 decision path | In-repository | **PARTIALLY FIXED**; the remainder is **EXTERNAL** | ⚠ |
| **D-4** shadow composition | In-repository | **NOT FIXED — EXTERNAL**, same blocker as D-5 | ❌ |

Half of D-5 *was* a wiring gap and is now closed: `workers/leaderWorkers.js` is the shard
supervisor's promotion hook that neither `server.js` nor `shardSupervisor.worker.js` had, and
it starts the `outbox` and `reconciler` workers on leadership acquisition. Wiring the outbox
closed a **live dangling path nobody had reported** (D-8 below): `membership.migrate()` has
been enqueuing `SHARD_MIGRATE` rows inside the handoff transaction that nothing ever
delivered.

Six findings beyond the four assigned are recorded, four of them fixed. **Two are defects in
this work's own remediation**, both found by the §19 hostile pass and both fixed:

- a **fail-open in the D-6 gate itself** — a shard with no region inherited a *global*
  `cutover.engine_enabled` binding, which is the exact substitution per-shard staging exists
  to prevent (D-13);
- a test that was structurally **incapable of failing**, so a planted duplicate-writer defect
  survived it (D-11).

**Measured, not asserted:**

```
npm test        155 suites, 6 850 tests, 0 failures   (baseline: 154 / 6 792)
npm run gates   exit 1 — gate:composition, 2 findings  (baseline: 4 findings)
live PostgreSQL 12/12 checks pass against a disposable PG 18.3, 26 migrations from empty
§19 audit       11 planted defects, 11 caught, 0 survived (2 survived on the first pass)
```

---

## 2. Starting state (measured on an unmodified tree)

| Check | Result at baseline |
|---|---|
| `npm test` | 154 suites, 6 792 tests, 0 failures |
| `npm run gates` | **exit 1** — `gate:composition` fails, 4 × `LEADER_ONLY_UNREACHABLE` |
| `npm run gate:calibration` | exit 1 — 39 Safety-class parameters (B8) |
| `npm run sim:fidelity` | exit 1 — 5 safety-relevant models `NOT_MEASURED` |
| `npm run routing:readiness` | **BLOCKED** — D1, D3, D8; no engine selected |
| `npm run release:gates` | exit 1 — 16 green, 1 red, 7 not evaluated |

All four assigned blockers were reproduced independently before any code was changed; the
reproductions are recorded under each finding.

---

## 3. The structural measurement that reframed D-5 and D-4

Before touching the wiring, the question "what does production actually reach?" was answered
mechanically rather than by reading. A transitive `require` walk from `server.js` over
`Backend/src/`:

```
src/ modules total:       279
reachable from server.js: 179
NOT reachable:            100
```

The 100 are not scattered. They are, almost exactly, **the decision path**:

| Area | Unreachable |
|---|---|
| `feasibility/` (38 predicates + evaluator + cache + volatileSubset + systemicGuard) | 41 |
| `cost/` (8 terms + `phi.js` + `signDiscipline.js`) | 9 |
| `solve/` (`round`, `minCostFlow`, `objective`, `costScaling`, `budgets`, `regime`) | 6 |
| `plan/` (`planBuilder`, `insertion`, `timeline`, `column`, `columnBuilder`) | 5 |
| `commitment/` (`commit`, `guards`, `model`) | 3 |
| `lifecycle/` (`transitions`, `reassignment`, `cancellation`) | 3 |
| `payload/`, `energy/`, `pricing/`, `routing/` caches, `determinism/snapshot`, … | 33 |

Module reachability overstates the case, so it was checked at **function** level too, and the
picture is worse rather than better: `candidates/expansion.js` *is* reachable — but only
because `diagnostics.controller.js` imports `unexploredRingFloorMilliCU`. Its actual entry
point, `expandCandidates()`, has no production caller. `feasibility/evaluate.gate()` has none.
`commitment/commit()` has none. `lifecycle/transitions.apply()` has none.

**The decision path is internally wired and externally unreached.** `round.execute()` is
called by `coordinator.worker.js`, which is called by nothing. The four `LEADER_ONLY` workers
were the visible top of that, which is why the baseline found them; they were not the extent
of it.

Then the chain was followed to its leaves, and this is where D-5 stops being a wiring problem:

```
coordinator.runRound
  → round.execute
    → expandCandidates          (deps.evaluateExact, deps.loadAgentSnapshot, deps.energyFor …)
      → evaluateExact → plan build → planBuilder.hopsForSequence
        → routing/cellPairCache.hopsFor
          → deps.route          ←── THE ROUTING ENGINE
                                     B1 has selected none.
```

`cellPairCache.read()` is explicit: *"if (typeof source.route !== 'function') return { ok:
false, … reason: 'no router is available and the entry is not cached' }"*. And
`npm run routing:readiness` reports, unchanged by this work:

```
OVERALL: BLOCKED
  BLOCKED  D1  [Operations + Commercial]      no authoritative operating region declared
  BLOCKED  D3  [Product + Fleet Engineering]  no fleet speed model exists
  BLOCKED  D8  [Operations]                   extract vintage / cadence / budget undecided
  BLOCKED  step 5  ENGINE SELECTION — no recorded evidence exists
```

`DEGRADED_ROUTING` (§18.5, B5/B6) is **not** an escape: it is the mode entered when "the
Routing Service is unavailable or partially failing" — a mode for an engine that exists and
has failed — and its `uniformDegradedEstimation` still needs D3's speed model, which also
does not exist. Entering it permanently at cutover would be operating the fleet in a degraded
envelope indefinitely, which §18.5 does not sanction.

**Conclusion.** Composing the Tier 0 decision path requires inventing a routing engine, a
fleet speed model, and the calibration values B8 blocks. §23 of the assignment forbids all
three by name. D-5's remainder and D-4 in full are therefore **externally blocked**, and are
reported as such rather than fixed.

---

## 4. D-5 — the Tier 0 decision path

### 4.1 Reproduction

```
$ node tools/gates/checkCompositionRoot.js
  FAIL — 4 violation(s): coordinator, outbox, reconciler, timer
         [LEADER_ONLY_UNREACHABLE] … no module under src/ or server.js requires it

$ grep -rn "coordinator.worker|outbox.worker|reconciler.worker|timer.worker" src/ server.js
  → every hit is a comment. Zero require() statements.
```

Confirmed independently of the baseline report.

### 4.2 Root cause

`registry.js` says `LEADER_ONLY` workers are "started and stopped by the shard supervisor
rather than at boot". `server.js` says they "belong to the shard supervisor's leadership
lifecycle". `shardSupervisor.worker.js` **has no promotion hook**. Each of the three
documents was individually accurate and no one of them owned the wiring, so the wiring did
not exist — the classic three-way deferral.

The supervisor's `runOnce()` already computed the exact signal a promotion hook needs:

```js
// The one question a coordinator asks this worker, answered in one place rather than
// reconstructed from the four passes above.
mayRunRound: recovery.session ? recovery.session.mayCommit === true : false,
```

It was returned on every tick and read by nothing.

### 4.3 Fix

**New — `src/workers/leaderWorkers.js`.** The missing hook, driven from `onTick`:

- `apply(tick)` starts the `LEADER_ONLY` workers when `mayRunRound` becomes true and stops
  them when it becomes false. Idempotent, so the repeated true-ticks of a stable leadership
  start nothing twice.
- Each worker is built by a **composer** that either returns a started handle **or refuses
  with a stated blocker**. There is no third outcome and, deliberately, no "started with what
  we had".
- `server.js` requires only `leaderWorkers` — never the three worker modules Phase 0's
  scaffold guard forbids it from naming. That guard is intact and was re-verified.

**Started (2 of 4):**

| Worker | Collaborators, and their production producers |
|---|---|
| `outbox` | `deliver` = `commandDispatcher.outboxDeliveryArm(io)` (production code, already existed); `readStoreTime` = `clock.readStoreTime`; `runInTransaction` = `runSerializable` |
| `reconciler` | `prisma`, `runInTransaction`, `readStoreTime` — the identical trio `server.js` already builds for the failover path |

**Refused (2 of 4)** — see §3 for why, and §5/§6 for the two findings this exposed.

**Shutdown.** `leaderLifecycle.stop()` runs *before* the leadership release, so the standby
that takes the shard inherits no in-flight writer of ours. Releasing first would advance the
fence while a drain pass was still running here.

### 4.4 Verification

- 16 tests in `tests/engine/leaderWorkerLifecycle.test.js`, driving the lifecycle through
  supervisor ticks exactly as the composition root does.
- Live PostgreSQL: group C of `tools/verify/phase15LiveDatabase.js` (below).
- §19 hostile audit: M1, M2, M3 — all caught (M1 only after the test was repaired; see §8).

### 4.5 What is NOT fixed, and the honest gate

`gate:composition` is **still red**, now with two precise findings instead of four vague ones:

```
FAIL — 2 violation(s) across 18 registered worker(s):
  coordinator (tier 0)  [LEADER_ONLY_NOT_COMPOSABLE]
      … B1 has selected no routing engine (blocked on D1/D3/D8) …
      [owner: B1 — Operations + Commercial (D1), Product + Fleet Eng (D3), Operations (D8)]
      — this blocker is EXTERNAL to this repository and no commit here closes it.
  timer (tier 0)  [LEADER_ONLY_NOT_COMPOSABLE]
      … sixteen §4.3/§4.2 expiry actions declared, none implemented under src/ …
      [owner: Phase 5 (§4.5 timer semantics) — in repository, unimplemented]
      — this blocker is in this repository.
```

**The gate was made stricter, not weaker.** See D-10 (§7).

---

## 5. D-4 — the shadow worker's composition root

### 5.1 Reproduction

`registry.js` marks `shadow` `DEFERRED`; `tests/engine/observabilitySchema.test.js:406`
asserts `server.js` does not include it. Both confirmed.

### 5.2 Root cause — restated, because the recorded one was incomplete

The registry said the blocker was *"the composition root that builds those five
collaborators outside a test fixture"*. That is accurate and it reads as work this repository
can do. It is not: the shadow worker runs **the same solve path the coordinator does**
(`observability/shadow.js` calls `deps.round.plan()` with `expandCandidates` and
`pricedCandidateFor`), and that path bottoms out in the same absent `route` function.

**The blocker is not similar to the coordinator's. It is the same blocker.**

### 5.3 Fix

**None. Not fixable here.** What was done instead:

- `registry.js`'s `blockedBy` for `shadow` now names B1, D1/D3/D8 and the owner explicitly,
  and states the consequence: the `shadow_agreement` gate cannot *begin* accumulating
  evidence — the system is not merely short of the fourteen-day window, it cannot start the
  clock.
- No stub was written. The registry's own rule governs: *"A stub would produce a worker that
  runs, reports success, and compares nothing — the worst of the three possible states."*

### 5.4 Verification

`shadow_agreement` remains `NOT_EVALUATED`. No shadow evidence was manufactured.

---

## 6. D-6 — the cutover switch was a conjunction everywhere except the socket layer

### 6.1 Reproduction

`tests/engine/cutoverSwitchConjunction.test.js` (baseline) pinned it, and it reproduced
exactly: six call sites reading `process.env.ENGINE_ENABLED === "true"` with no shard in the
question, three of them in front of engine **writes**:

| Site | Gates |
|---|---|
| `command.handler.js:82` | settles an outbox row to `ACKED` |
| `offer.handler.js:47` | releases a commitment, moves a Leg, renews a lease |
| `robot.handler.js:271` | suppresses outbox rows, advances an agent's `authority_epoch` |

A staged rollout *requires* a deployment-wide `ENGINE_ENABLED=true`. Those writes were
therefore live for **every** shard, including ones `stage.js` had deliberately not reached.

### 6.2 Root cause

`cutover/enabled.js` was written because the switch has two halves. Phase 15 converted
exactly one call site — `task.service.js`, the intake path — and the agent-facing remainder
still read Phase 0's single master switch. The refusals in `stage.js` govern intake and not
the agent path.

The reason it was left unconverted was a real design question, recorded in the pinning test:
resolving a robot's shard costs a lookup **per event** on the telemetry hot path.

### 6.3 Fix

**New — `src/engine/cutover/agentGate.js`.** One decision, asked once:

```
ENGINE_ENABLED ∧ session authenticated ∧ shard identity known and fresh
               ∧ a configuration is loaded ∧ it enables this shard
```

Every one of those is a **named refusal** when absent (`PROCESS_NOT_ENABLED`,
`SESSION_NOT_AUTHENTICATED`, `SHARD_IDENTITY_UNRESOLVED`, `SHARD_IDENTITY_STALE`,
`CONFIGURATION_UNAVAILABLE`, `SHARD_NOT_ENABLED`). No branch reaches "allowed" through a
missing input.

**The hot-path question, answered without a per-event lookup:**

- **Resolved once at AUTH** from the durable record — `ShardMembership` → `Shard` → region —
  and cached on `socket.data`. §3.5 makes membership explicit, so an agent with no live
  membership row belongs to **no** shard and is refused; it is deliberately *not* defaulted
  to `DEFAULT_SHARD_ID`, which would have placed every unplaced agent in whichever shard the
  staging order reached first.
- **Invalidated by migration, not polled.** `membership.migrate()` advances the agent's
  `authority_epoch`, voiding every mission authority it holds (§19.2), and §11.5's dedup
  handshake rides on `AUTH_SUCCESS` — so the agent must re-AUTH anyway. `server.js`'s
  `onTick` now disconnects a migrated agent's sockets, cross-process via the Socket.IO Redis
  adapter, using the same pattern the §23.2 revocation sweep already uses.
- **A bounded freshness backstop.** An identity older than `DEFAULT_MAX_AGE_MS` (twice the
  heartbeat's existing durable-mirror throttle) is refused as stale. Refreshed on that same
  existing throttle — one extra indexed read per agent per 15 s, and no new cadence.

**All six call sites converted.** `socket.server.js:179` — "which loop owns §12.4 row 9" — is
a genuinely *process*-level question and correctly stays on `processEnabled()` alone; it now
reads it through the owning module rather than as a raw comparison. Zero raw
`process.env.ENGINE_ENABLED` reads remain under `src/` outside `enabled.js` and the Config
Service's own bootstrap decision.

### 6.4 Verification

**Unit / adversarial** — `tests/engine/cutoverSwitchConjunction.test.js` was **replaced, not
edited**, as its own header instructed. 25 tests: the four headline cases §8 names, thirteen
planted refusals covering §9's list (stale session, unknown robot, missing shard, shard with
no region, stale mapping, robot moved between shards, forged identity on an unauthenticated
socket, no configuration, a snapshot whose `resolve()` throws, a truthy-but-not-`true`
binding, direct invocation with no socket, explicit invalidation), and an exhaustiveness
check that a new raw read anywhere is a new finding.

**Live PostgreSQL** — `tools/verify/phase15LiveDatabase.js`, groups A and B, **12/12**:

| | |
|---|---|
| A1 | the shipped resolver returns shard **and** region from the business key |
| A2 | an unknown agent → `null` (fails closed) |
| A3 | a commissioned-but-unplaced agent → `null`, **not** the default shard |
| A4 | staged region → allowed; unstaged region → `SHARD_NOT_ENABLED` |
| B1 | the store refuses a second live membership (SQLSTATE 23505, row absent) |
| B2 | **after a migration the resolver returns the NEW shard and region** |
| B3 | a session holding the pre-migration identity is refused once stale |

A1 is not ceremony: `resolveIdentity()` reads `Agent` by its *business* key and
`ShardMembership` by the agent's *primary* key. A unit fixture using one string for both
cannot tell those apart, and getting it wrong returns `null` — which fails closed, so the
failure mode is a whole fleet silently refused rather than a crash.

**Mutation** — removing the shard half of the conjunction fails 6 tests; removing the
staleness bound fails 3; removing the session check fails 3. Restored and re-verified.

---

## 7. D-7 — the gate set could not be brought to green by any legitimate sequence

### 7.1 Reproduction

Demonstrated mechanically: with fully admissible evidence for all twenty-three other gates,
`stage.authoriseEnable()` refuses by exactly `rollback_rehearsed (NOT_EVALUATED)`.
`rollback.md` §5 step 1 discharges that gate by taking a staging shard live — which calls the
function that just refused.

### 7.2 Architectural decision — **ADR-34**

Three obvious resolutions were considered and **rejected**: make the gate non-blocking (ships
a cutover whose rollback was never exercised — §22.5); add a `WAIVED` status (`gates.js`
names this as the thing it must not have); file an attestation for a rehearsal that did not
happen (the forgery the evidence contract exists to prevent).

The diagnosis: `authoriseEnable()` was answering one question for two different acts — a
**production cutover**, and a **rehearsal** whose whole purpose is to *produce* the evidence
the gate is about. "You may not take a shard live until the rollback has been rehearsed" is
exactly right for the first and a category error for the second.

`docs/adr/ADR-34-cutover-rehearsal-purpose.md`, registered in `docs/adr/README.md`, marked
`Accepted` as an integration decision under a frozen architecture, contradicting no frozen
record.

### 7.3 Implementation

**`stage.js`:**

- `PURPOSE.PRODUCTION` is the **default** and is unchanged in every respect. An unrecognised
  purpose is refused (`UNKNOWN_PURPOSE`), never defaulted — the only thing a purpose can do is
  *reduce* the gate set, so an unnamed one must reduce nothing.
- `PURPOSE.REHEARSAL` is refused unless the request declares
  `environment: { id, production: false }` (`REHEARSAL_REQUIRES_NON_PRODUCTION`).
- `REHEARSAL_EXCLUDED_GATES` is a named constant containing **exactly one** id. Every other
  blocking gate, the §1.8 rule 3 ship state, two-person approval, the guardrail
  pre-declaration and the staging order apply unchanged.
- The exclusion is applied **after** the whole table is evaluated, never by hiding the row.
  The action carries `purpose`, `environment` and `gatesSetAside` (each with the status it
  held), so an audit reads the rehearsal rather than reconstructing it — and `gatesSetAside`
  is empty for a production cutover *by construction*.

**`evidence.js` — the necessary other half.** Making the rehearsal *performable* without
making its evidence *checkable* would have moved the forgery one step along rather than
removing it. `rollback_rehearsed` is flagged `rehearsal: true`, and `admit()` now requires the
record to carry the rehearsal itself: the declared non-production environment, the published
configuration version, `automaticRollbackFired`, and each of the six `rollback.md` §5 steps
**named individually** — because §22.5's argument is about *which* step is skipped ("Step 4 is
the one that will be skipped and it is the one that matters"), and a contract that only
counted them could not tell. It ages by the same `maxAgeMs` rule as every other record, so a
rehearsal cannot be performed once and cited for ever.

### 7.4 Verification

`tests/engine/cutoverEvidence.test.js` grew from 35 to 56 tests. The original circularity pin
is **retained** as a test of `PURPOSE.PRODUCTION` — it still refuses by exactly
`rollback_rehearsed`. Added: the rehearsal is authorised against a declared non-production
environment; the exclusion set is exactly one gate; a production cutover never sets a gate
aside; and §11's attacks — a rehearsal with no environment, in production, with an
`undefined` production flag, an unrecognised purpose, a rehearsal that excuses another gate,
the ship state, the second approver or the guardrails; two signatures and no rehearsal; a
production environment in the record; an unnamed environment; no configuration version; each
of the six steps missing (six cases, each asserting the refusal *names* the step); an omitted
step; a rollback called by hand rather than fired by the controller; a self-approved
rehearsal; a stale rehearsal; a record filed against another gate; a truthy non-record.

`docs/runbooks/rollback.md`'s ⚠ OPEN FINDING is replaced by the resolved procedure and the
rehearsal-record field table.

---

## 8. Findings beyond the four assigned

### D-8 — `SHARD_MIGRATE` had a producer and no consumer (FIXED)

`shard/membership.js:migrate()` runs on the supervisor's **own migration pass**, which
`runOnce()` executes unconditionally every tick. Inside the handoff transaction it advances
the agent's `authority_epoch`, suppresses its outstanding outbox rows, allocates a dispatch
sequence, and enqueues a signed `SHARD_MIGRATE` command telling the agent its authority has
changed.

**Nothing ever delivered it.** The outbox worker had no production caller, so with
`ENGINE_ENABLED=true` an agent would be migrated, have every mission authority it held
voided, and never be told. This was not in the baseline report.

**Fixed** by the D-5 wiring: `leaderWorkers` starts the outbox worker on leadership
acquisition, with the delivery arm that already existed. Regression test:
`leaderWorkerLifecycle.test.js` — "the outbox is started, so `SHARD_MIGRATE` finally has a
deliverer". Live verification: group C, including `Outbox_fence_scope_columns` refusing an
AGENT-scope command that carries a commitment fence (SQLSTATE 23514, row absent).

### D-9 — the timer worker's handler map has no producer at all (REPORTED, in-repository)

`timer.worker.js` requires `deps.handlers`, keyed by the §4.3/§4.2 "on expiry" action.
Sixteen actions are declared across `legMachine.js` and `taskMachine.js` —
`ESCALATION_LADDER`, `FORCE_WIDEN_AND_ESCALATE`, `HARDEN_OR_REPLAN`,
`WITHDRAW_EXCLUDE_REPLAN`, `PROBE_THEN_REASSIGN`, `PROGRESS_PROBE`, `OPERATOR_ALERT`,
`VERIFICATION_ESCALATION`, `FORCE_STRANDED`, `PAGE_OPERATIONS`,
`PAGE_OPERATIONS_AND_EXTERNAL_ESCALATION`, `ESCALATE`, `REJECT_OR_ESCALATE`,
`DECOMPOSITION_STALLED`, `REPROJECT_TIMELINE`, `OPERATOR_REVIEW` — and **none has an
implementation anywhere under `src/`**. `lifecycle/transitions.apply()`, which such a handler
would use, has no production caller either.

This is **not** composition work: the map has no producer because the expiry semantics
themselves are unimplemented. Started with an empty map, `fireOne()` returns
`HANDLER_NOT_REGISTERED` and leaves each due timer `PENDING` for ever — a supervisor that
supervises nothing while reporting a healthy tick.

**Not fixed.** It is in-repository and Phase 5-owned, and implementing sixteen lifecycle
expiry semantics is not remediation of a Phase 15 wiring finding. Recorded in
`leaderWorkers.UNCOMPOSABLE.timer` with `external: false`, and reported by the gate.

### D-10 — the composition gate's own check was a path-string proxy (FIXED)

`checkCompositionRoot.js` matched the registry's module tail as a **substring** of a
`require(...)` literal. That was wrong in both directions:

- A sibling in `src/workers/` writes `require("./coordinator.worker")`, which contains no
  `workers/` segment — so a *real* production reference was invisible to it.
- A comment, or a require with no call, satisfied it — so the gate could be turned green
  without the worker ever running.

Worse, its single `LEADER_ONLY_UNREACHABLE` finding conflated "nobody wired this" with "the
thing it must be wired to does not exist", and invited exactly the wrong repair.

**Fixed and strengthened:** requires are now **resolved** to absolute paths, and `LEADER_ONLY`
is checked three ways — reachable, has a composer, and the composer is not declared unable to
build it. Two new finding kinds, `LEADER_ONLY_NO_COMPOSER` and `LEADER_ONLY_NOT_COMPOSABLE`,
the latter carrying the blocker, what it requires, its owner, and whether it is external.
Mutation M3 confirms the gate goes green if the blocker table is ignored. A regression test
asserts a relative sibling require now resolves.

### D-11 — a test in *this* remediation was incapable of failing (FIXED)

The §19 hostile pass planted "remove the idempotence guard from `startAll()`" and the suite
**passed**. Cause: handles live in a `Map` keyed by worker id, so a second `start()` cannot
add a duplicate *key* — it silently replaces the value, orphaning the first interval, which
then runs for ever and can never be stopped. That is a genuine second writer, and
`lifecycle.running()` looks identical either way.

**Fixed** by counting calls to the worker modules' own `start()`, plus a second test proving
every handle created is later stopped exactly once. Re-attacked: caught.

### D-12 — 100 of 279 `src/` modules are unreachable from the composition root

Recorded in §3. Not a defect with a fix; a measurement that reframes D-5/D-4.

### D-13 — a FAIL-OPEN in the D-6 gate itself (FIXED)

The §19 pass re-audited `agentGate.assess()` without trusting the notes that produced it, and
asked the one question the module's own header claims to answer: *is there any branch that
reaches "allowed" through a missing input?* There was.

`enabled.configEnabled()` builds its resolution context as:

```js
const context = {};
const regionId = shard && (shard.regionId || null);
if (regionId) context.region = regionId;
return snapshot.resolve(PARAMETER, context) === true;
```

A null region yields an **empty context** — and an empty context resolves
`cutover.engine_enabled` at **global** scope. Demonstrated against the shipped module:

```
*** ALLOWED ***  shard with NO region     (global cutover.engine_enabled = true)
refused          shard with an unstaged region   SHARD_NOT_ENABLED
```

So a deployment holding a global `true` binding would have enabled a region-less shard: the
answer to "is the whole deployment cut over" returned in place of "is *this shard* cut over",
which is precisely the substitution the per-shard staging exists to prevent — the D-6 defect
reintroduced one layer in, inside its own fix.

`Shard.regionId` is `NOT NULL`, so the *data* should never produce this. But
`resolveIdentity()` sets `regionId: null` when the `Shard` read **throws**, which made a
transient store blip a fail-open on a Tier 0 path. A `catch` that degrades to a value which
happens to be permissive is the same defect shape as D-3c, one module along.

**Fixed.** `SHARD_REGION_UNRESOLVED` refuses the identity by name, before the snapshot is
consulted — because a missing region does not make the answer `false`, it makes the question a
different one. Regression test asserts `null`, `undefined` and `""`; a dedicated test plants
the global-binding attack. Mutation **M11** confirms removing the check reopens it.

This is the single most valuable finding of the hostile pass, and it argues for the pass
itself: the module was written to fail closed, its header says so, and it did not.

---

## 9. Release-gate integrity (D-3 must not regress)

Re-verified by mutation rather than by reading. **M10:** replacing `evidence.admit()` with a
stub that trusts `record.pass` fails the suite — the D-3 fix is load-bearing and the tests
that pin it are capable of failing.

The full attack set from the baseline is retained and still refuses: the 23 hand-typed
`{pass:true}` records, empty evidence, `pass` over a non-zero exit, wrong command, wrong gate
id, no run record, no exit code, wrong tree digest, absent digest, stale, from-the-future,
anonymous, a BUILD run closing a PRODUCTION gate, a 14-day claim over four minutes, a short
soak, a missing duration bound, an unowned production record, a self-approved attestation, an
attestation while its own check exits 1, a runnable organisational gate with no corroboration,
an unknown gate id, and a void mid-collection tree change.

The new rehearsal contract adds five refusal codes to that set and does not relax any
existing one. `NOT_EVALUATED` is still not a pass. No threshold was moved and no gate was made
non-blocking.

---

## 10. External blockers — not fabricated, and now more precisely owned

| Item | Status | Owner | What is actually required |
|---|---|---|---|
| **B1 routing** | **BLOCKED** | Ops + Commercial (D1), Product + Fleet Eng (D3), Ops (D8) | An authoritative operating region as GeoJSON; a real fleet speed model over roadClass/gradient/surface/payload/congestion/weather; an OSM extract vintage, cadence and re-contraction budget. **Then** B1 steps 1, 3, 4 and the Step 5 ADR. |
| **B8 calibration** | **BLOCKED** | §22.4's calibration owner | 39 Safety-class parameters awaiting measured fleet, vendor and authority data. §22.4 itself: values that "require data the fleet does not yet produce and cannot produce before it operates." |
| **Shadow agreement** | **NOT_EVALUATED — cannot start** | blocked by B1 | 14 days of live traffic. The clock cannot begin: D-4. |
| **Soak** | **NOT_EVALUATED** | — | 72 h wall clock (`release.soak_duration`). |
| **Simulator fidelity** | **RED** | — | A study against realised production distributions. |
| **§26 invariants** | **NOT_OBSERVED** | — | Production traffic with a zero-violation SLI. The worker *is* started; what is missing is traffic. |
| **TLC capacity 3 / checked-in capacity 2** | Partial | — | Compute beyond a workstation session. |

**Nothing here was manufactured.** No region, no speed model, no extract, no calibration
value, no shadow window, no soak duration, no invariant observation. `NOT_EVALUATED` was not
converted to `PASS` anywhere.

The one change is that **D-5 and D-4 now appear in this table's dependency chain**, where the
baseline had them under in-repository work.

---

## 11. Cross-phase regression (Phases 0–14)

**Full suite: 155 suites, 6 850 tests, 0 failures.** Gates: 7 of 8 pass; `gate:composition`
is red for the two documented reasons.

**Earlier-phase source modified, and why each was necessary as a Phase-15 integration seam:**

| File | Phase | Change | Justification |
|---|---|---|---|
| `sockets/handlers/{command,offer,robot,telemetry,dtaro}.handler.js` | 0/4/5/14 | read the cutover switch through `agentGate` | **D-6 itself.** The per-shard cutover is the Phase 15 deliverable; these were the unconverted call sites. Permitted by the existing architecture — `enabled.js` was written for exactly this conjunction. |
| `sockets/socket.server.js` | 0/5 | `processEnabled()` instead of a raw env read; `appLocals` threaded to two handlers | Same seam. The predicate is unchanged. |
| `workers/registry.js` | 15 | `shadow`'s `blockedBy` restated with the real owner | Phase 15 owns this table. |
| `server.js` | 15 | the promotion hook, migration invalidation, lifecycle shutdown | Phase 15 owns the composition root. |

**Earlier-phase tests updated (3), each made strictly stronger:**

| Test | Was | Now |
|---|---|---|
| `supervisionWorkers.test.js` (P5) | matched the raw `ENGINE_ENABLED !== "true"` text | matches `!cutoverEnabled.processEnabled()` **and** asserts the raw read is *absent* |
| `phase14Remediation.test.js` (P14) | matched `!engineEnabled()` | matches `!engineEnabled(socket, configOf())`, asserts `agentGate.mayAct` is used, and asserts no raw read |
| `phase0Scaffold.test.js` (P0) | — | registers `cutover/agentGate.js` against its owning phase |

Each replaced a **source-text proxy** for a behaviour that is preserved and narrowed. No
assertion was relaxed, no tolerance widened, no threshold moved.

**Explicitly verified unchanged:**

- No applied migration edited — `prisma/migrations/` untouched; 26 migrations apply cleanly
  from empty.
- No historical closure, implementation or independent-verification document rewritten.
- No earlier gate weakened; no earlier threshold moved.
- Phase 0's scaffold guard intact: `server.js` still names none of the outbox, timer or
  reconciler worker modules (it names `leaderWorkers`, which names them).
- Phase 10 solver untouched. The new composition does not reach it — the coordinator is not
  started — so no Phase 10 regression is possible or was observed. No parallel solver was
  written.
- Phase 13 leadership not bypassed: the lifecycle reads the supervisor's own `mayRunRound`
  rather than re-deriving leadership.
- Phase 14 security/privacy not bypassed: the D-6 gate **adds** a refusal in front of three
  write paths and removes none.

---

## 12. Live PostgreSQL verification

Disposable **PostgreSQL 18.3** cluster, port **55434**, built from installed binaries into
the scratchpad. Never Neon, never the user's 5432 cluster; the harness refuses both by name.

- **26 migrations applied from an empty database, 0 failures** (verified empty first:
  `count(*) = 0` over `information_schema.tables`).
- 16 Phase-15-relevant tables present.
- **Constraints made to fire, judged on SQLSTATE and on the row being absent afterwards —
  never on message text**, because Prisma embeds the calling file's own source in its errors
  and a text match would report PASS for a probe that never reached the database:

| Constraint | Probe | Result |
|---|---|---|
| `ShardMembership_one_current_per_agent` | a second live membership | refused, 23505 |
| `ShardMembership_migration_advances_epoch` | migration without an epoch advance | refused, 23514 |
| `ShardMembership_move_changes_shard` | migration to the same shard | refused, 23514 |
| `Shard_regionId_key` | two shards in one region | refused, 23505 |
| `Outbox_idempotencyKey_key` | one migration, two commands | refused, 23505 |
| `Outbox_fence_scope_columns` | AGENT command with a COMMITMENT fence | refused, 23514 |

`tools/verify/phase15LiveDatabase.js`: **12/12 passed** (exit 0). Three harness defects were
found and fixed during this run — a missing NOT NULL column set, a text-based refusal judge,
and an incorrect fence-scope fixture. The third became a new positive probe (C3).

---

## 13. Adversarial and mutation testing

**§19 hostile audit: 11 planted defects, 11 caught, 0 survived.** Two survived the first pass
— D-11 (a test that could not fail) and D-13 (a genuine fail-open in the gate) — and in both
cases the *code or the test* was repaired rather than the finding explained away.

| | Defect | Caught by |
|---|---|---|
| M11 | region check removed — a region-less shard inherits the **global** binding | `cutoverSwitchConjunction` (D-13, after the fix) |
| M1 | idempotence removed — duplicate/orphaned writers | `leaderWorkerLifecycle` (after D-11 fix) |
| M2 | demotion no longer stops the workers | `leaderWorkerLifecycle`, 3 tests |
| M3 | the gate stops reporting declared blockers | `checkCompositionRoot`, 2 tests |
| M4 | staleness bound removed | `cutoverSwitchConjunction`, 3 tests |
| M5 | the session check removed | `cutoverSwitchConjunction`, 3 tests |
| M6 | a rehearsal may run in production | `cutoverEvidence`, 2 tests |
| M7 | the exclusion set widened without an ADR | `cutoverEvidence`, 2 tests |
| M8 | a hand-called rollback counts as automatic | `cutoverEvidence`, 1 test |
| M9 | skipped rehearsal steps no longer refuse | `cutoverEvidence`, 2 tests |
| M10 | `evaluate()` trusts `record.pass` again (D-3) | `cutoverEvidence`, suite |

Every mutation was applied to a real file and reverted from an in-memory backup; the tree was
verified clean afterwards (`grep -rn MUTATED` → none) and the full suite re-run green.

Plus the 12 planted refusals in `cutoverSwitchConjunction` and the 20-odd in
`cutoverEvidence`, all automated.

---

## 14. Performance status

Not re-profiled, and no claim is made that it was. The D-6 fix was designed against a
performance constraint rather than measured after it: the shard identity is resolved **once
at AUTH** and refreshed on the heartbeat's **existing** throttle, so the telemetry hot path
gains **zero** database round trips and the socket layer gains no new cadence. The steady-state
cost is one additional indexed read per agent per `legacy.liveness.db_flush_interval_ms`
(15 s), on a pass that already performs a durable write.

`scale_targets`, `locality` and `overload_admission_control` are exercised by the release
collection's own runs; §20.1's whole-round measurement was not re-derived here.

---

## 15. Phase 16 contamination check

**CLEAN.** No Phase 16 functionality implemented. Verified: `src/engine/fairness/` contains
no runtime module; `branchAndBound` absent; every Tier 2 kill switch thrown by default;
`tierTwoAtShipState` refuses a cutover with any Tier 2 mechanism live — and now refuses it
under `PURPOSE.REHEARSAL` too, which is asserted by test rather than assumed.

---

## 16. Files changed

**New**

| Path | Purpose |
|---|---|
| `Backend/src/engine/cutover/agentGate.js` | D-6 — the one place an agent session is held to both halves of the switch |
| `Backend/src/workers/leaderWorkers.js` | D-5 — the shard supervisor's promotion hook, and the declarative blocker table |
| `Backend/tests/engine/leaderWorkerLifecycle.test.js` | 16 tests — promotion, demotion, duplicate writers, refusals |
| `Backend/tools/verify/phase15LiveDatabase.js` | 12 live-PostgreSQL checks for D-5 and D-6 |
| `docs/adr/ADR-34-cutover-rehearsal-purpose.md` | D-7's architectural decision |

**Modified**

| Path | Change |
|---|---|
| `Backend/server.js` | the promotion hook; migration-driven session invalidation; lifecycle shutdown before leadership release |
| `Backend/src/engine/cutover/stage.js` | `PURPOSE`, `REHEARSAL_EXCLUDED_GATES`, two refusals, `purpose`/`environment`/`gatesSetAside` on the action |
| `Backend/src/engine/cutover/evidence.js` | the rehearsal-record contract; `REHEARSAL_STEPS`; five refusal codes |
| `Backend/src/engine/cutover/gates.js` | `rollback_rehearsed` flagged `rehearsal: true` |
| `Backend/src/workers/registry.js` | `shadow`'s `blockedBy` restated with the real, external owner |
| `Backend/src/sockets/handlers/{command,offer,robot,telemetry,dtaro}.handler.js` | all six call sites converted to the conjunction; AUTH binding and heartbeat refresh |
| `Backend/src/sockets/socket.server.js` | `processEnabled()`; `appLocals` threaded to two handlers |
| `Backend/tools/gates/checkCompositionRoot.js` | resolution-based reachability; two new finding kinds; blocker/owner/external reporting |
| `Backend/tests/engine/cutoverSwitchConjunction.test.js` | **replaced** — the pinned defect became the pinned fix |
| `Backend/tests/engine/cutoverEvidence.test.js` | D-7 resolution and its 20 attacks; helper builds admissible rehearsal evidence |
| `Backend/tests/engine/cutoverStaging.test.js` | `allGreen()` builds a rehearsal record — strictly more work |
| `Backend/tests/gates/checkCompositionRoot.test.js` | rewritten for the sharper findings; adds the relative-require regression |
| `Backend/tests/engine/{phase0Scaffold,phase14Remediation}.test.js`, `supervisionWorkers.test.js` | text proxies updated and strengthened |
| `docs/runbooks/rollback.md` | the ⚠ OPEN FINDING replaced by the resolved procedure and the record's field table |
| `docs/adr/README.md` | ADR-34 registered |

**Deleted:** none. **Migrations:** none. **API changes:** none. **Socket contract:** unchanged
— no event added, removed or renamed; three write paths gained a refusal.

---

## 17. Test results

| | Suites | Tests | Failures |
|---|---|---|---|
| Baseline | 154 | 6 792 | 0 |
| After this remediation | **155** | **6 850** | **0** |

One new suite (16 tests) and 42 tests added to existing suites. **No test was deleted,
skipped, weakened or threshold-relaxed.** One test file was *replaced* — the D-6 pinned-defect
suite, which its own header required be deleted rather than edited when the conversion landed.
Three earlier-phase source-text proxies were updated and made strictly stronger (§11).

---

## 18. Every finding

| ID | Severity | Owner | Status |
|---|---|---|---|
| **D-4** shadow composition | Blocking | **B1 — Ops + Commercial, Product + Fleet Eng, Ops** | **EXTERNALLY BLOCKED** — reclassified; not fixable here |
| **D-5** Tier 0 decision path | Blocking | split | **PARTIALLY FIXED** — outbox + reconciler wired; coordinator **external** (B1), timer **in-repo** (D-9) |
| **D-6** socket shard staging | Blocking | Phase 15 | **FIXED** — root cause, adversarial + live-DB verified, mutation-tested |
| **D-7** rehearsal circularity | Blocking | Phase 15 | **FIXED** — ADR-34; no gate weakened |
| **D-8** `SHARD_MIGRATE` undelivered | High | Phase 15 | **FIXED** by the D-5 wiring |
| **D-9** timer handler map absent | Blocking | **Phase 5 (in repository)** | **REPORTED** — 16 expiry semantics unimplemented |
| **D-10** composition gate path proxy | High | Phase 15 | **FIXED** — gate strengthened |
| **D-11** duplicate-writer test could not fail | High | this work | **FIXED** — found by the §19 hostile pass |
| **D-12** 100/279 modules unreachable | Informational | — | **MEASURED** — reframes D-4/D-5 |
| **D-13** fail-open in the D-6 gate | **Blocking (had it shipped)** | this work | **FIXED** — found by the §19 hostile pass |

Each carries its reproduction, root cause, fix, regression test, adversarial test and live
verification in the section above.

---

## 19. Remaining blockers

**In-repository, not fixed:**

1. **D-9** — the timer worker's sixteen §4.3/§4.2 expiry handlers. Phase 5-owned. Blocks
   `engine_decision_path_wired` and, transitively, durable timer supervision.

**Externally blocked — no commit in this repository closes these:**

2. **D-5 (remainder) / D-4** — the Tier 0 decision path and the shadow worker both require a
   routing engine. **B1 has selected none**, blocked on D1, D3 and D8.
3. **B8 calibration** — 39 Safety-class values.
4. **Production observation windows** — shadow agreement (14 days), soak (72 h), simulator
   fidelity, §26 invariants.
5. **TLC at capacity 3** and at checked-in capacity 2.

---

## 20. Final verdict

### PHASE 15 — BLOCKED. PHASE 16 — NOT READY.

**Outcome B.** Not because a test failed, and not because a gate is arithmetically short. The
substantive reason:

> The real RobotX engine **cannot be composed**. Its decision path terminates in a routing
> engine that has not been selected, and selecting one is an Operations, Product and
> Commercial decision that Phase 15 does not own. A worker exists for every stage of that
> path; a producer exists for almost none of the leaves.

Against §24's success criterion, honestly:

| Criterion | Status |
|---|---|
| composed | ❌ — externally blocked (B1/D1/D3/D8), plus D-9 in repository |
| safely enabled | ✅ — every refusal verified by attack; the gate set is now satisfiable in principle (D-7) |
| correctly staged per shard | ✅ — **D-6 fixed**, adversarially and live-DB verified |
| observed | ⚠ — the invariant worker runs; production traffic is external |
| shadowed | ❌ — cannot start the clock (D-4) |
| rolled back | ✅ — the rehearsal is now performable and its evidence checkable (D-7) |
| audited | ✅ — purpose, environment and set-aside gates on every action |

**Does the Phase 15 plan permit closure with these external dependencies?** No. The completion
criteria are "**every** §24 gate green" and "every §26 invariant `ENFORCED` in nominal
operation". `engine_decision_path_wired` is red, four PRODUCTION gates and two ORGANISATIONAL
gates are `NOT_EVALUATED`, and none can be closed by a build. The criteria were not
reinterpreted to reach a different answer.

**What changed that matters.** D-6 and D-7 are genuinely closed at the root. D-8 was a live
defect nobody had found. And the largest remaining blocker moved from a task list to a
dependency register — which is worse news, arrived at honestly, and is the difference between
a phase that is behind and a phase that is waiting on someone else.

**TRUTH > GREEN.**

---

## 21. Reproducing this report

```
cd Backend
npm test                     # 155 suites, 6 850 tests, 0 failures        (~3.5 min)
npm run gates                # exit 1 — gate:composition, 2 named findings
node tools/gates/checkCompositionRoot.js   # the two blockers, with owners
npm run gate:calibration     # exit 1 — 39 Safety-class parameters (B8)
npm run sim:fidelity         # exit 1 — 5 safety-relevant models NOT_MEASURED
npm run routing:readiness    # BLOCKED — D1, D3, D8; no engine selected
npm run release:gates        # the whole table, judged                    (~25 min)

# live PostgreSQL (disposable cluster only — never Neon, never 5432)
DATABASE_URL=postgresql://pgverify@127.0.0.1:55434/robotx_p15 \
  node tools/verify/phase15LiveDatabase.js    # 12/12, exit 0
```

**Do not edit the tree while `release:gates` runs** — the collection is voided if the source
digest moves between the first gate and the last, and it will say so.

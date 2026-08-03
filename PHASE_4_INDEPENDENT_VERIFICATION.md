# Phase 4 — Independent Software Verification Report

**Verifier role:** Independent Software Verification Engineer (did not implement Phase 4; did not
redesign, optimise, simplify, or implement anything during this review)
**Date:** 2026-08-03 · **Branch:** `feature/dashboard` · **Working tree at verification:** `4244b3d`
+ uncommitted Phases 1–4 (unchanged from the state the implementation report was written against)
**Method:** Every PASS below is backed by a command this review ran, a diff this review read in
full, a spec quotation checked against the file and line it cites, or a reproduction script this
review wrote and executed against the live, unmodified shipped code. The implementation report
(`PHASE_4_IMPLEMENTATION_REPORT.md`) was read to understand what was claimed and was **not**
trusted for any claim reported here as PASS, PARTIAL, or FAIL.

---

## 0. Scope discipline and a documentation gap disclosed up front

This review covers Phase 4 only: `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §2.5, §2.6, §4.1, §10.3.1,
§10.5, §10.6, §11 (Dispatch and Acknowledgement — transactional outbox, offer semantics, delivery,
escalation, durable dedup), §18.5, §23.3, §24.5, §26 (I5, I16, I19, I21) — against
`IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 4" and its §7 checklist. No Phase 5+ mechanism
(durable timers, reconciler, lease renewal beyond grant, progress supervision, completion
verification, settlement, cancellation, reassignment, preemption, the Leg/Task state machines,
scheduling, routing optimisation, allocation heuristics) was found in the diff — confirmed directly
in Part 2.

**A gap in the review chain, disclosed rather than silently worked around:** the assignment brief
names `PHASE_0_INDEPENDENT_VERIFICATION.md` among the authoritative prior verification reports.
That file does not exist in the repository (`PHASE_1_INDEPENDENT_VERIFICATION.md`,
`PHASE_2_INDEPENDENT_VERIFICATION.md`, and `PHASE_3_INDEPENDENT_VERIFICATION.md` all exist; Phase 0's
does not). This review proceeded using Phase 0's *implementation* report and the Phase 0 scaffold
tests (still exercised by every later phase's suite) as the available evidence of Phase 0's state,
and flags the missing artefact here rather than fabricating its contents or silently treating Phase 0
as unverified. This is a process/documentation gap, not a Phase 4 defect, and does not block this
review's conclusions about Phase 4 itself.

---

## PART 1 — Phase 4 checklist (`IMPLEMENTATION_EXECUTION_PLAN.md` §7)

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Migration: `Outbox` with `(state, notValidAfter)` index; `AgentDedupState` | **PASS** | Independently regenerated via `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`; both `CREATE TABLE` blocks are **byte-for-byte identical** to the hand-written migration (Part 6) |
| 2 | `dispatch/outbox.js` — row written **inside** the commit transaction | **PASS** | `enqueue`/`suppressOutstandingForAgent` both call `isTransactionClient(tx)` and throw `TypeError` otherwise; read in full, confirmed the check is structural (`typeof tx.$transaction !== "function"`), not a comment |
| 3 | `workers/outbox.worker.js` — claim, deliver, bounded retry, escalate | **PARTIAL** | Claim/deliver/record is real and tested (Part 7). "Escalate" is **assessed and logged but the substantive action of its own step 2 is never executed by any shipped caller** — see Part 3, the review's principal finding |
| 4 | Route **every** server→agent message through the outbox | **PASS** | `commandDispatcher.service.js`'s `deliverOutboxCommand` is the only function that emits a §10.3.1 command name; confirmed by reading the full diff — the legacy `dispatch*` helpers are untouched and carry none of the 18 command names |
| 5 | `offers.js` — OFFER content per §11.2 incl. reserve params and target SoC | **PASS** | `buildOfferPayload` carries all eleven fields; `energyReserveParams`/`targetSoc` present and `null`, declared for Phase 7 |
| 6 | `sockets/handlers/offer.handler.js` | **PASS** | Three events, gated on `ENGINE_ENABLED` and `socket.data.isAuthed`, each its own `prisma.$transaction` |
| 7 | DEFER: release the HARD commitment, Leg → `PLANNED` with start-not-before | **PASS** | `applyDefer` rejects a past `until` as `DEFER_UNTIL_IS_NOT_IN_THE_FUTURE`; releases the commitment; conditional Leg write on `version` |
| 8 | `escalation.js` — steps 1–4 incl. systemic threshold | **PASS on the assessment functions themselves; see item 3 and Part 3 for what is missing above them** | `assessRow`, `assessAgent`, `assessShard` independently re-derived by hand against §11.4's table and found correct at the boundary (`fraction > threshold`, not `≥`; "consecutive" broken by a single ACK; empty shard is `EMPTY_SHARD`, not systemic) |
| 9 | `sequence.js` — per-commitment ordering; `RECALL` never before its `OFFER` | **PASS** | `disposition()` re-derived by hand for all three outcomes; `checkApplicationOrder` reproduced correctly flagging a synthetic `RECALL`-before-`OFFER` stream |
| 10 | `security/commandSigning.js` — fence scope, fence value, sequence, `not_valid_after`, signature | **PASS** | All eleven `SIGNED_FIELDS`; `timingSafeEqual` used (not `===`); a 31-byte key independently confirmed refused, a 32-byte key accepted |
| 11 | `dedupHandshake.js` — three server paths | **PASS** | `classify()` re-derived by hand for all three named rows plus the unnamed "no stored generation" case; the generation-went-backwards case independently confirmed treated as a reset |
| 12 | Extend AUTH to carry `dedup_state_generation`, `authority_epoch`, `fence_floor`, per-commitment high-water marks | **PASS** | Read `robot.handler.js`'s full diff; the four elements are present and the field is optional (legacy AUTH unaffected) |
| 13 | **VirtualRobot:** durable dedup persisted before any observable effect | **PASS for the single-command case; FAILS under concurrent/overlapping command delivery — see Part 3, finding 1 (reproduced independently)** | |
| 14 | **VirtualRobot:** reject mission command at `≤ highest_seen[commitment_id]` or `≤ fence_floor` | **PASS in isolation; the state the comparison reads from can be corrupted by finding 1** | `fencing.acceptsMissionCommand` delegated to, not restated — confirmed by import |
| 15 | **VirtualRobot:** reject agent command at `authority_epoch < highest_seen` | **PASS in isolation, same caveat** | |
| 16 | **VirtualRobot:** answer queries unfenced; enforce `agent.autonomous_continuation_limit` | **PASS** | `_onQuery` performs no fence/sequence/dedup write; `_enforceAutonomousContinuationLimit` independently traced to halt at, not before, the bound |
| 17 | Tests: fence compared **per commitment id**, never as a per-agent maximum | **PASS** | Re-ran `dispatchAgentProtocol.test.js`'s "§10.3.1's worked example" — two concurrent commitments stayed independently commandable |
| 18 | Chaos: power-cycle; redeliver; suppression + epoch advance + zero double-application (I21) | **PASS for the specific sequential scenario the shipped suite exercises; FAILS in general — see Part 3, finding 1** | The shipped chaos test never issues two mission commands for the same commitment while either is still in flight; every command in it is `await`ed before the next begins |
| — | **Gate:** no command reaches an agent except from an outbox row written in its authorising transaction | **PASS** | Confirmed structurally: `enqueue` and `suppressOutstandingForAgent` both refuse a non-transaction client; `commit.js`'s `sideEffects` seam is now required (Part 8) |

**Checklist result: 13/18 substantively PASS as claimed. 1 item (3) is PARTIAL — the worker's
"escalate" is materially incomplete, not merely deferred. 4 items (13, 14, 15, 18) PASS for the
scenario the shipped suite tests but do not hold in general, because of one confirmed, reproduced
defect (Part 3, finding 1) in the shared code path all four exercise.**

---

## PART 2 — Execution plan compliance: everything required, nothing omitted, nothing from later phases

| Check | Verdict | Evidence |
|---|---|---|
| Every Phase 4 scope item present | **PASS, modulo Part 1 item 3/Part 3** | Transactional outbox, sequence, offers, escalation *assessment*, dedup handshake, command signing, the migration, and the VirtualRobot contract are all present |
| No Phase 5+ mechanism present | **PASS** | `find src/engine -iname "*timer*" -o -iname "*reconcil*" -o -iname "*verification*" -o -iname "*settlement*"` returns nothing; `src/engine/lifecycle/` and `src/engine/supervision/` do not exist; `git diff --stat -- src/engine/candidates/ src/engine/solve/ src/engine/plan/ src/engine/cost/ src/engine/energy/ src/routes/` is empty |
| `ENGINE_ENABLED` remains the master switch and is off | **PASS** | `offer.handler.js` and `command.handler.js`'s engine branch both check `process.env.ENGINE_ENABLED === "true"` before doing anything; `server.js` does not import or start `outbox.worker.js` (`grep` for it in `server.js` returns nothing) |
| Tier gate: no Tier 0/1 → Tier 2 import | **PASS** | Fresh `gate:tiers` run: 105 modules, 64 governed edges, 0 violations |
| TIERS.md completeness for Phase 4's own modules | **PASS, and Phase 3's finding #5 is now corrected** | `T0-05` now lists `commitment/leases.js` (missing at Phase 3, carried forward and fixed here); `T0-06` lists `dedupHandshake.js`; `T0-09` lists `outbox.js`, `sequence.js`, `offers.js`, `escalation.js`, `outbox.worker.js` — read directly from `TIERS.md` |

**Verdict: PASS.** Phase 4 does not implement Phase 5+ functionality, and the one Phase 3 carry-forward
documentation item this phase owned (TIERS.md's module list) was corrected.

---

## PART 3 — Two findings, independently reproduced, that the implementation report does not disclose

This section is the substance of the review. Both findings were reproduced directly against the
live, unmodified shipped code — not inferred from reading alone — and both concern the same theme:
**a code path exists and is individually well-tested, but the property the phase is graded on
("I21 verifiable", "escalation ladder … operational") does not hold once the path is exercised
outside the exact scenario the shipped suite constructs.**

### 3.1 Finding 1 (HIGH, reproduced): a persist-failure revert in `VirtualRobot.js` can erase a
### later, already-applied, already-durably-persisted command — reintroducing double-application (I21)

**What the report claims:**

> "The agent has a durable memory, and its loss is detectable… **not one command was applied
> twice** — verified both at the store … and at the agent … Invariant I21."

**What `_onMissionCommand` and `_onAgentCommand` actually do** (`Backend/src/simulation/VirtualRobot.js:554-649`):
each reads the current in-memory mark, mutates `this.dedup` **synchronously**, then `await`s
`persistDedupState()` (a Redis write — a genuine async I/O boundary), and on failure **reverts
`this.dedup` to a snapshot captured at the start of that same call**:

```js
// mission command path, line 584-595
this.dedup.highWaterMarks.set(commitmentId, { fence: BigInt(envelope.fence), sequence: envelope.sequence });
const persisted = await this.persistDedupState();
if (!persisted) {
  if (mark) this.dedup.highWaterMarks.set(commitmentId, mark);
  else this.dedup.highWaterMarks.delete(commitmentId);
  return this._rejectCommand(command, envelope, "DEDUP_STATE_NOT_DURABLE", "commitment");
}
```

Nothing serialises two overlapping invocations of `_onMissionCommand` (or `_onAgentCommand`) for
the same commitment id or agent. If a second command for the same commitment arrives and is fully
processed — including a **successful** persist — while an earlier command's persist is still in
flight, and the earlier command's persist then **fails**, the earlier command's revert restores a
snapshot taken *before either command ran*, silently discarding the later command's already-applied,
already-durably-written state.

**Independently reproduced**, against the real `VirtualRobot` class, with no modification to any
shipped file:

```js
// /tmp/race_repro.js — full script preserved for reproduction; summary below
const vr = new VirtualRobot({ robotId: "r1", ... });
vr.socket = { emit: (...) => {} };
vr.kv = {
  get: async () => null,
  set: async () => {
    callCount += 1;
    if (callCount === 1) { await sleep(30); throw new Error("simulated transient persist failure"); }
    store.set(...); return "OK";               // second call: succeeds
  },
};
vr._dedupLoaded = true;

const pA = vr._onMissionCommand("OFFER", envelope({ command: "OFFER", fence: 5n, sequence: 0 }));
await sleep(5);                                                   // let A reach its await
const resultB = await vr._onMissionCommand(                        // B fully completes while A is in flight
  "REROUTE", envelope({ command: "REROUTE", fence: 7n, sequence: 1 }));
const resultA = await pA;
```

**Output, verbatim:**

```
resultA (OFFER):   { applied: false, reason: 'DEDUP_STATE_NOT_DURABLE' }
resultB (REROUTE): { applied: true, reason: null }
in-memory mark for C1 after both settle: undefined
stale fence-5 redelivery, after the corruption: { applied: true, reason: null }
```

Command A correctly fails (its own persist genuinely failed). Command B correctly succeeds. **But
A's failure handler then deletes commitment C1's high-water mark from the map entirely** — because
`mark` was `undefined` when A started, before B had run — silently erasing B's successful,
already-durably-persisted fence-7 state. The proof this is not merely a bookkeeping curiosity: a
**stale, already-superseded redelivery of the original fence-5 `OFFER`** (a plausible transport
retry — §11.5 states redelivery is expected "for up to `dispatch.offer_ttl`") is then **wrongly
re-admitted** (`applied: true`) and re-executes `_applyMissionEffect`/`_acknowledge` — precisely the
double-application invariant I21 exists to forbid, on the exact class of message (a stale `OFFER`
for a since-rerouted commitment) whose mis-acceptance the specification treats as a serious defect
(§10.3.1's own worked example).

**Why this is not a narrow, dismissible corner case:**
- It requires no adversary — only ordinary overlapping redelivery (explicitly anticipated by
  §11.5) plus a transient persist failure, which the code already anticipates and handles *for a
  single in-flight command* (the whole reason the revert-on-failure branch exists).
- `VirtualRobot.js` is stated by the plan and the report to be **"the reference implementation and
  the conformance fixture" that real firmware must implement the same contract as** — a firmware
  author porting this exact revert pattern inherits the same defect.
- The `_onAgentCommand` path has the identical structural flaw at a wider blast radius: its revert
  (`this.dedup = previous;`) restores the **entire** dedup object on a failed persist, which would
  also erase an interleaved, unrelated **mission**-scope command's successful update to
  `highWaterMarks`, not only another agent-scope command's.
- The shipped chaos test (`dispatchAgentProtocol.test.js`, "chaos (§24.5)") and every other test in
  the suite `await`s each command before issuing the next — none constructs the overlapping-in-flight
  scenario, so this was not caught by 1,067 passing tests.

**Classification: correctness / concurrency, Tier 0, invariant I21. HIGH severity, and blocking** —
this is a demonstrated counterexample to a specific, tested, headline-claimed completion criterion
("I21 verifiable"), not a documentation or characterisation issue.

**Required correction:** serialise `_onMissionCommand`/`_onAgentCommand` per key (per commitment id
for mission commands, per agent for agent commands — e.g. an in-memory mutex/queue keyed the same
way the fence scopes already are), or restructure the revert to re-read current state and apply a
conditional (compare-and-swap) restoration rather than an unconditional snapshot overwrite. Firmware
guidance should be updated in lock-step, since the conformance fixture is what firmware is told to
port.

### 3.2 Finding 2 (HIGH, reproduced): the escalation ladder's step 2 substantive action has zero
### production callers, and the state it produces is excluded from every later query — including
### the outbox SLIs the report claims are "emitted every pass"

**What §11.4 requires for step 2:** *"No ACK within `dispatch.offer_ttl` → Withdraw offer at an
advanced commitment fence, release the commitment, mark agent `dispatch_unresponsive`, re-plan the
Leg excluding it."* **What the report claims:** *"Steps 1 and 2 acted on; steps 3 and 4 assessed and
reported as directives with their owning phase named"* — drawing an explicit distinction between
steps 1–2 (acted on) and 3–4 (merely assessed, with a disclosed owner).

**What is actually wired**, read directly in `src/workers/outbox.worker.js:249-260`
(`escalateOutstanding`): on reaching step 2, the worker calls only

```js
await outbox.settleRow(deps.prisma, { id: row.id, state: outbox.OUTBOX_STATE.UNACKNOWLEDGED, ... });
```

— it does **not** call `offers.withdrawExpiredOffer`, the function that performs the fence advance,
the commitment release, and the `WITHDRAW` command enqueue that §11.4 step 2 and §11.2's fourth row
require. Confirmed by exhaustive search:

```
$ grep -rn "withdrawExpiredOffer" Backend/
Backend\tests\engine\dispatchEscalation.test.js
Backend\tests\engine\dispatchOffers.test.js
Backend\src\engine\dispatch\offers.js        ← its own definition
```

Zero production callers. The shipped test even documents this as deliberate, in its own name:
`dispatchEscalation.test.js`, *"the worker performs no withdrawal itself — the fence advance
belongs to its own transaction."* That disclosure is real and present in the test — but it is
**not** carried into the implementation report's completion-criteria table, which states steps 1–2
are "acted on" without qualifying that step 2's core action is absent, in contrast to how steps 3
and 4 (also not acted on) explicitly name their deferred owner ("Phase 9", "Phase 12"). No owner is
named for wiring step 2's withdrawal, and no later phase's scope table claims it either — §17.1 of
the report lists carry-forward items for Phases 5/7/9/12/14/15, none of which is "call
`withdrawExpiredOffer` from the round or the worker."

**Consequence, independently traced through the state machine, not merely inferred:**

1. An offer that times out is marked `UNACKNOWLEDGED`. `UNACKNOWLEDGED` is in neither
   `TERMINAL_STATES` (`ACKED`, `EXPIRED`, `SUPPRESSED`, `FAILED`) nor `OUTSTANDING_STATES`
   (`PENDING`, `CLAIMED`, `DELIVERED`) — confirmed by reading `outbox.js:80-92`.
2. Because it is excluded from `OUTSTANDING_STATES`, the row is thereafter invisible to:
   - `expirePastValidity` (only queries `state: {in: OUTSTANDING_STATES}`) — it is never expired
     even once its own `notValidAfter` passes.
   - `claim` — correctly, since delivery is moot; not a defect on its own.
   - `readSli`'s **both** numbers — `depth` and `oldestUndeliveredAgeSeconds` are computed only over
     `OUTSTANDING_STATES`/`[PENDING, CLAIMED]`. **A row that has just failed the escalation ladder
     — the exact condition the SLI exists to surface ("a rising value is direct evidence that
     commitments are not reaching agents") — stops being counted by that SLI the instant it reaches
     the state the ladder assigns to that failure.**
   - `dedupHandshake.suppressOutstandingForAgent` — §11.5's reset path, which is supposed to
     "suppress **every outstanding** dispatch obligation" for an agent whose dedup state was reset,
     also filters on `OUTSTANDING_STATES`. An `UNACKNOWLEDGED` row for an agent that then suffers a
     dedup reset is **not suppressed**, contradicting §11.5's "suppress redelivery entirely."
3. Because `withdrawExpiredOffer` is never invoked, the **Commitment** row backing the timed-out
   offer is never released (`releasedAt` stays `null`) and the agent's capacity slot (the partial
   unique index Phase 3 built) remains occupied indefinitely by a commitment nobody is driving. The
   Leg never returns to `QUEUED` for re-planning. Confirmed by grep: `settleRow` (which the worker
   does call) only ever touches the `Outbox` table; nothing in the shipped runtime path touches
   `Commitment`, `Agent.fenceCounter`, or `Leg.state` on the step-2 path.

Every one of these consequences was verified by reading the actual `where` clauses in
`outbox.js`/`escalation.js`/`dedupHandshake.js`, not inferred from the state name alone — confirmed
in Part 12 (grep for every reference to `UNACKNOWLEDGED` in `src/`, four references total, none of
which is a query that includes it).

**Classification: implementation completeness / architecture compliance (§11.1's SLI requirement,
§11.2's fourth row, §11.4 step 2, §11.5's "every outstanding obligation"). HIGH severity.** Not a
safety-invariant violation in the way finding 1 is (nothing is double-executed), but it is a
concrete, undisclosed contradiction of an explicit completion-criteria claim ("escalation ladder
steps 1–4 operational") and it leaves the system unable to recover capacity from an unresponsive
agent by any means Phase 4 shipped — which is the exact scenario the escalation ladder exists to
handle.

**Required correction:** wire a caller — either the worker itself (inside its own
`prisma.$transaction`, locking `Agent`+`Leg` the way `commit.js` and `withdrawExpiredOffer` already
expect) or a documented seam for the not-yet-built round to drive — that actually invokes
`offers.withdrawExpiredOffer` on step 2, and widen `readSli`/`suppressOutstandingForAgent`'s state
filters (or transition `UNACKNOWLEDGED` rows onward) so a row does not become invisible to the SLI
and to reset-suppression at the exact moment it most needs to be visible to both.

---

## PART 4 — Database

### 4.1 Independent regeneration of Prisma's own SQL

```
$ npx prisma validate
The schema at prisma\schema.prisma is valid 🚀

$ npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > gen.sql
$ grep -A26 'CREATE TABLE "Outbox"' gen.sql
$ grep -A12 'CREATE TABLE "AgentDedupState"' gen.sql
```

Both generated blocks (all 24 `Outbox` columns; all 8 `AgentDedupState` columns) are **byte-for-byte
identical** to the hand-written migration file. Separately confirmed all five CHECK constraints
(`Outbox_command_class_known`, `Outbox_fence_scope_columns`, `Outbox_sequence_non_negative`,
`Outbox_state_known`, `AgentDedupState_counters_non_negative`) are **absent** from the fresh Prisma
generation (`grep -n "CHECK" gen.sql` → zero matches) — confirming they are genuine hand-written
additions, exactly as the report claims and exactly the same technique Phase 3's review used.

**Verdict: PASS**, independently reproduced.

### 4.2 Additivity

- `git diff --stat -- Backend/prisma/schema.prisma`: two new models plus back-relations; zero lines
  removed from any pre-existing model (both new tables' only foreign keys point *from* `Outbox`/
  `AgentDedupState` *to* `Agent`/`Commitment`, not the other way).
- The migration's only `ALTER TABLE` statements are the five `ADD CONSTRAINT` CHECKs on the two new
  tables; no pre-existing table is altered.
- `Commitment_kind_hard_only` (Phase 3) is untouched — confirmed not restated.

**Verdict: PASS.**

### 4.3 What remains unverified against a live database (inherited, and now compounded a fourth time)

Every phase to date has disclosed that no migration has been applied to a real PostgreSQL instance.
This review did not have access to one either and did not attempt to obtain or bypass credentials
for the shared instance referenced in `.env`, consistent with the discipline the Phase 1–3 reviews
applied. Phase 4's migration is, in one respect, **lower-risk** than Phase 3's (no partial index, no
`plpgsql` trigger, no data `INSERT`) — it is five `CHECK` constraints and two plain tables — but it
is the first migration with a foreign key to a **non-primary-key unique column**
(`Outbox.commitmentId → Commitment.commitmentId`), which the report itself flags as a risk. Static
cross-checking (4.1) is strong evidence for shape; it is not evidence that this specific FK form, or
that Prisma's `BigInt`/`Date` marshalling through the raw filter subset the `helpers/commitmentStore.js`
test model implements, behaves identically against real PostgreSQL.

**Verdict: PASS on every statically verifiable property; the live-execution gap is inherited,
disclosed by the report, and correctly not treated as a new, undisclosed problem this phase created.**
Given this is the fourth consecutive phase to carry this same recommendation forward unaddressed,
this review repeats Phase 3's verification's recommendation with more force: it should be discharged
before Phase 5 adds a fifth untested migration on top of it.

---

## PART 5 — API review

| Check | Verdict | Evidence |
|---|---|---|
| Request validation | **PASS** | `offer.handler.js`'s `responseSchema` (zod) and `command.handler.js`'s `outboxAckSchema` both reject malformed payloads before any DB access; confirmed by reading both schemas in full |
| Response contracts | **PASS** | `AUTH_SUCCESS`/`AUTH_OK` gain one additive `dedup` field; no existing field removed or retyped |
| Backwards compatibility | **PASS** | `git diff --stat -- Backend/src/routes/` empty; legacy `TASK_ASSIGN`/`COMMAND`/`STOP`/`REROUTE_ALERT` events and the legacy `ackSchema` branch of `COMMAND_ACK` are untouched — read the full diff, confirmed the engine branch is a new `if` block preceding the legacy parse, not a replacement of it |
| Authorisation/authentication | **PASS for what Phase 4 owns** | Every engine-side socket handler checks `socket.data?.isAuthed` and `ENGINE_ENABLED` before any read; no new REST route was added, so no new authorisation surface exists to review |
| Error handling | **PASS** | Both new handlers wrap their bodies in `try/catch` and log rather than throw into the socket layer; `deliverOutboxCommand` never throws, it returns a typed `{ delivered, detail }` |
| Idempotency | **PASS for enqueue/commit; see Part 3.2 for the gap in the *response* path once a row reaches `UNACKNOWLEDGED`** | `Outbox.idempotencyKey` is `@unique`; `enqueue` observes its own prior row on retry |

---

## PART 6 — Runtime behaviour

| Property | Verdict | Evidence |
|---|---|---|
| Execution order (envelope → fence → sequence → persist → effect → ACK) | **PASS in the single-command case** | Traced `_onMissionCommand` line by line; matches §23.3's stated check order exactly |
| State transitions (OFFERED→ACCEPTED/QUEUED/PLANNED) | **PASS** | `applyAccept`/`applyReject`/`applyDefer` each perform exactly one conditional Leg write plus the appropriate commitment update |
| Retry behaviour | **PARTIAL** | `backoffSeconds()` is computed and recorded for telemetry (`dispatch.escalation` event), but **nothing in `drainOnce` consults it to pace redelivery** — `claim()` claims every `PENDING` row every pass regardless of the backoff schedule, so the "bounded exponential backoff with jitter" §11.3 requires is observable in logs but not actually applied to the claim cadence. Lower severity than Part 3's findings (no correctness consequence — at-least-once delivery plus dedup makes an over-eager retry harmless — but it is a real gap between the spec's stated mechanism and what runs) |
| Timeout handling | **PASS for detection, FAIL for the consequent action** | `assessRow` correctly detects both timeout conditions; see Part 3.2 for what happens (or does not) next |
| Failure recovery / consistency under restart | **PASS for claim leases** | `claim`'s conditional `updateMany` on `(id, state, claimedAt)` correctly makes a reclaim of an expired lease exclusive between racing workers — reasoned through against the JS store model (Part 4.3's live-DB caveat applies equally here) |

---

## PART 7 — Concurrency review

| Scenario | Verdict | Evidence |
|---|---|---|
| Two workers racing to claim the same outbox row | **PASS** | `claim`'s conditional write requires `state: candidate.state` (and `claimedAt` for a reclaim) to still match; a losing racer's `updateMany` matches 0 rows and is discarded — traced by hand, consistent with Phase 3's equivalent commit-storm pattern |
| Commit transaction + outbox enqueue atomicity | **PASS** | `enqueue`/`suppressOutstandingForAgent` both refuse a non-transaction client; `commit.js`'s `sideEffects` is now required (not optional as in Phase 3), closing Phase 3 verification finding #2 (the asymmetric seam enforcement) — confirmed by reading `commit.js:250` |
| **Two overlapping in-flight command applications on the same agent/commitment, at the agent** | **FAIL — reproduced. See Part 3.1.** | The review's principal finding |
| Cache loss (I16) | **PASS** | `grep -rn "ioredis\|require(\"../../cache/kv\")\|require(\"../cache/kv\")" src/engine/dispatch/` → zero matches, independently confirming no dispatch module imports the cache; a dedicated worker test (`dispatchEscalation.test.js`, "a cache that throws on every write does not stop a command reaching an agent") re-run and passes |
| Idempotency namespace disjointness | **PASS, inherited from Phase 3 and re-used, not restated** | `buildRow`'s `idempotencyKeyFor` call reuses Phase 3's `idempotency.js` directly |

---

## PART 8 — Architecture compliance

| Check | Verdict | Evidence |
|---|---|---|
| Layering / module placement | **PASS** | Fresh `gate:tiers`: 105 modules, 64 governed edges, 0 violations |
| Gate catches a freshly planted violation in live Phase 4 code | **PASS, independently reproduced** | Planted a bare numeric literal (`47281`) into live `src/engine/dispatch/escalation.js`; `gate:params` caught it with the correct file/line/message (`FAIL — 1 violation(s) … src/engine/dispatch/escalation.js:154 [bare-constant]`); file restored and independently diffed byte-identical to its pre-edit content (`diff` produced no output); `npm run verify` re-run clean afterward |
| Dependency direction | **PASS** | `dispatch/*.js` (Tier 0, T0-09) imports `commitment/fencing.js`, `commitment/leases.js`, `commitment/clock.js` (Tier 0) and `security/commandSigning.js` (Tier 1) — Tier 0 depending on Tier 1 is the permitted direction; no `dispatch/` module imports `cost/`, `solve/`, `plan/`, or the cache |
| TIERS.md completeness | **PASS** | See Part 2 — Phase 3's carried-forward finding (`commitment/leases.js` missing from T0-05) is now corrected |
| No architecture drift | **PASS** | Walked `src/engine/dispatch/`, `src/engine/security/`, `src/workers/outbox.worker.js` by hand; every file matches its declared tier and phase ownership; `sideEffects` becoming required in `commit.js` is a disclosed, deliberate change to a landed phase's contract (assumption 1), not drift |

---

## PART 9 — Implementation quality

Genuine, independently-verified findings only, beyond Part 3's two headline items.

1. **`backoffSeconds()` is computed but not consulted** (Part 6) — dead-in-effect code from the
   claim loop's perspective; it is read only by the `record()` telemetry sink. Low-moderate severity:
   no correctness consequence, but it means the "bounded exponential backoff" §11.3 requires is not
   actually what paces retries.
2. **`OUTBOX_STATE.FAILED` is declared, is part of the CHECK constraint, and is never assigned by
   any code path.** `grep -rn "OUTBOX_STATE.FAILED" src/engine/dispatch/ src/workers/` matches only
   its own definition and its membership in `TERMINAL_STATES`. Combined with Part 3.2, the row
   lifecycle described in `outbox.js`'s own header comment ("Bounded retry exhausted (§11.3).
   Escalated, never discarded") has no code path that reaches it — a row can reach `UNACKNOWLEDGED`
   and then nothing, but never `FAILED`. Severity: moderate on its own; it compounds Part 3.2.
3. **No duplicated logic, no incorrect tier ownership, and consistent naming** were found across
   `dispatch/*.js`, `security/commandSigning.js`, `outbox.worker.js`, and the socket handler diffs —
   the modules are well-factored, and the fence-scope/sequence logic is genuinely written once
   (in `commitment/fencing.js` and `dispatch/sequence.js`) and imported everywhere else, exactly as
   the report describes. This is a real strength, not a finding, and is why Part 3's two findings
   stand out against an otherwise carefully-built surface.
4. **The escalation ladder's own module header is more honest than the implementation report's
   completion-criteria table** about what is deferred ("This module decides; it does not act…
   inventing an index or a mode here would be building two of them") — but that honesty was applied
   only to steps 3–4. Step 2's gap is real and is not flagged with the same care the module's own
   comments apply to steps 3–4. This is a documentation-consistency observation that sits directly
   underneath Part 3.2's functional finding.

---

## PART 10 — Regression review

```
$ git diff --stat -- Backend/src/routes/ Backend/src/app.js Backend/server.js \
    Backend/src/middlewares/ Backend/benchmark/
(empty)

$ grep -n "outbox.worker" Backend/server.js
(no matches — the worker is not started)

$ npx jest --selectProjects legacy --runInBand --forceExit
Test Suites: 22 passed, 22 total
Tests:       169 passed, 169 total
```

Identical to the count every prior phase (0, 1, 2, 3) recorded as its own inherited baseline. The
`robot.handler.js`, `command.handler.js`, and `socket.server.js` diffs were each read in full
(Part-quoted above); every behavioural addition is a new, gated branch preceding or alongside the
pre-existing legacy logic, never a replacement of it.

**Verdict: PASS.** Zero legacy regressions.

---

## PART 11 — Build and test review

```
$ npm run verify
gate: tier-dependencies (§1.8 rule 2)          PASS — 105 module(s), 64 governed edge(s), 0 violations
gate: parameter-register (§22, Appendix A)     PASS — 37 module(s), 148 registered parameter(s), 0 bare constants
gate: tenets (T1, T6)                          PASS — 102 module(s), 0 violations
Test Suites: 53 passed, 53 total
Tests:       1067 passed, 1067 total
```

Fresh run, matches the report's own numbers exactly. Re-ran the legacy lane in isolation (Part 10)
and confirmed the planted-violation gate check (Part 8). **All 1,067 shipped tests pass**, and this
review's two findings are not test failures — they are gaps in what the 1,067 tests exercise (Part
3 explains precisely which scenario each finding's corresponding tests never construct).

**Verdict: PASS on everything the shipped suite checks; the suite itself has two coverage gaps
identified in Part 3, each large enough to hide a real defect.**

---

## PART 12 — Failure analysis

| Scenario | Verdict | Evidence |
|---|---|---|
| Invalid/malformed request | **PASS** | zod schemas reject non-conforming `OFFER_ACCEPT`/`OFFER_REJECT`/`OFFER_DEFER`/outbox-ACK payloads before any store access |
| Duplicate request (retry) | **PASS for enqueue** | `idempotencyKey` unique index; `enqueue` observes prior row |
| **Duplicate/overlapping delivery at the agent** | **FAIL — Part 3.1** | |
| Process crash / restart (worker) | **PASS** | Expired claims are reclaimable by another worker; `drainOnce`'s per-row operations are individually idempotent |
| Database failure | **Not independently verifiable against a live instance (inherited, Part 4.3)** | Reasoned: a thrown Prisma error inside `drainOnce`'s per-row delivery is caught and recorded as an undelivered attempt (`try/catch` around `deps.deliver`); a thrown error from `outbox.claim`/`recordAttempt`/`settleRow` themselves is **not** caught inside `drainOnce` and would propagate to `start()`'s own `catch`, which records `outbox.drain_failed` and lets the next tick retry — reasoned safe, not proven against a live outage |
| Network interruption / undelivered offer | **PARTIAL — detected, not resolved. Part 3.2** | |
| Timeout (offer TTL) | **PARTIAL — detected, not resolved. Part 3.2** | |
| Partial execution (mid-transaction failure) | **PASS** | Every Phase 4 write inside a transaction (`enqueue`, `withdrawExpiredOffer`, `dedupHandshake.apply`, the offer-response handlers) either completes fully or throws, rolling back atomically — traced by hand for each |
| Retry exhaustion | **FAIL — `OUTBOX_STATE.FAILED` is never reached by any code path. Part 9 item 2.** | |

---

## PART 13 — Evidence summary

- **Files inspected in full:** `outbox.js`, `offers.js`, `sequence.js`, `escalation.js`,
  `dedupHandshake.js`, `commandSigning.js`, `outbox.worker.js`, `offer.handler.js`, the full diffs of
  `robot.handler.js`, `command.handler.js`, `socket.server.js`, `commandDispatcher.service.js`, and
  the complete `VirtualRobot.js` (1,425 lines, current state) plus its 727-line diff.
- **Tests executed:** `npm run verify` (fresh, twice — once before and once after the planted-violation
  probe); `npx jest --selectProjects legacy --runInBand --forceExit` (fresh); one standalone
  reproduction script (`/tmp/race_repro.js`) executed directly against the shipped, unmodified
  `VirtualRobot` class.
- **Runtime verification performed:** the concurrency reproduction in Part 3.1 (real execution, not
  reasoning); the planted-violation gate check in Part 8 (real execution); manual trace of every
  `where` clause touching `OUTBOX_STATE.UNACKNOWLEDGED` across the dispatch surface (Part 3.2).
- **Migrations reviewed:** `20260730090000_dispatch_and_agent_protocol/migration.sql`, independently
  regenerated and byte-diffed against a fresh `prisma migrate diff --from-empty`.
- **APIs inspected:** the two new socket-side surfaces (`OFFER_ACCEPT`/`OFFER_REJECT`/`OFFER_DEFER`,
  the extended `COMMAND_ACK`); confirmed zero REST route changes.
- **Architecture sections verified:** §2.6, §4.1 rule 5, §10.3.1, §10.5, §10.6, §11.1–§11.5, §18.5,
  §23.3, §24.5, I5, I16, I19, I21.

---

## PART 14 — FINAL DECISION

# FAIL

Phase 5 must **NOT** begin until the blocking issues below are resolved and independently
re-verified.

This decision is narrower than it may sound: the transactional outbox's core write-path guarantee
(§4.1 rule 5 — no command without its authorising transaction), the command-integrity envelope
(§23.3), the offer response state machine (§11.2's ACCEPT/REJECT/DEFER), the schema and its CHECK
backstops, the tier/parameter/tenet gates, and 1,067 shipped tests all independently check out as
sound and are not in question. The two findings below are specific, reproduced, and scoped — they do
not indicate the phase's design is wrong, only that two of its shipped mechanisms do not yet do what
the phase's own completion criteria and the specification require.

### Blocking issues

| # | Issue | Severity | Affected files | Violated spec section | Violated plan section | Evidence | Required correction |
|---|---|---|---|---|---|---|---|
| 1 | A persist-failure revert in `VirtualRobot.js`'s mission- and agent-command handlers restores a state snapshot captured at the *start* of the failing call, blind to a second, overlapping command that succeeded in between — independently reproduced to cause a stale, already-superseded `OFFER` to be wrongly re-admitted and re-applied after a transient persist failure on an unrelated, interleaved command | **High — blocking** | `Backend/src/simulation/VirtualRobot.js` (`_onMissionCommand`, `_onAgentCommand`, lines 554–649) | §11.5 ("agent-side deduplication state MUST be durable"); §10.3.1 (per-commitment/per-agent fence comparison integrity); invariant I21 ("zero double-application") | Phase 4 checklist item 18 ("Chaos: … zero double-application (I21)"); completion criterion "I21 verifiable" | Part 3.1 — reproduced with a standalone script against the unmodified shipped class; output shows the stale redelivery accepted (`applied: true`) after the corruption | Serialise per-key (commitment id / agent id) access to `this.dedup`, or make the revert a conditional compare-and-restore against current state rather than an unconditional overwrite of a stale snapshot. Extend the chaos test suite to cover overlapping in-flight commands, not only sequential ones, before re-claiming I21 |
| 2 | The escalation ladder's step 2 substantive action (`offers.withdrawExpiredOffer` — fence advance, commitment release, Leg requeue, `WITHDRAW` dispatch) has zero production callers; the `UNACKNOWLEDGED` state it does produce is excluded from `readSli`'s depth/age computation, from `expirePastValidity`, and from `dedupHandshake.suppressOutstandingForAgent`'s reset-path suppression | **High — blocking** | `Backend/src/workers/outbox.worker.js` (`escalateOutstanding`), `Backend/src/engine/dispatch/outbox.js` (`readSli`, `suppressOutstandingForAgent`, `OUTSTANDING_STATES`) | §11.1 ("Outbox depth and oldest-undelivered-age are primary SLIs"); §11.2 row 4 ("withdraw at an advanced commitment fence, release the commitment … re-plan"); §11.4 step 2; §11.5 ("suppress redelivery entirely" for every outstanding obligation) | Phase 4 checklist item 3 ("claim, deliver, bounded retry, escalate") and completion criterion "Escalation ladder steps 1–4 operational" | Part 3.2 — exhaustive grep confirms zero callers of `withdrawExpiredOffer` outside its own definition and its unit tests; traced every `OUTSTANDING_STATES`-filtered query that consequently never sees an `UNACKNOWLEDGED` row | Wire a caller (worker-owned transaction or a documented seam for Phase 10's round) that actually invokes `withdrawExpiredOffer` on step 2; widen or reroute the state filters so an `UNACKNOWLEDGED` row remains visible to the SLI and to dedup-reset suppression until it reaches a true terminal state (`FAILED` or an equivalent) |

### Non-blocking issues (report for the record; do not themselves gate Phase 5)

| # | Issue | Severity | Category | Recommendation |
|---|---|---|---|---|
| 3 | `escalation.backoffSeconds()` is computed and logged but never consulted by `drainOnce`'s claim/retry cadence — the "bounded exponential backoff with jitter" §11.3 requires is not what actually paces redelivery | Low-moderate | Implementation | Consult the computed backoff before re-claiming a `PENDING` row that has already been attempted, or rename the function's role in documentation to "reported schedule" if the at-least-once/dedup safety net is judged sufficient without it |
| 4 | `OUTBOX_STATE.FAILED` is declared, is part of the CHECK constraint, and is never assigned by any shipped code path | Moderate | Implementation completeness | Resolve together with issue 2 — the natural home for `FAILED` is the terminal state a step-2 withdrawal (or its own retry exhaustion) transitions the row to |
| 5 | `PHASE_0_INDEPENDENT_VERIFICATION.md` does not exist, though the verification brief names it among the authoritative prior reports | Low | Documentation / process | Produce it, or record explicitly in the programme's index that Phase 0 was not independently verified, so later readers do not assume it was |
| 6 | No migration in this programme has been applied to a live PostgreSQL instance; this is the fourth consecutive phase to carry the recommendation forward | Elevated (inherited, not new) | Database | Discharge before Phase 5 adds a fifth untested migration; Phase 4's migration is comparatively low-risk (no trigger, no partial index) but introduces the schema's first FK to a non-primary-key unique column |

### What must happen before Phase 5

1. Fix and re-verify issue 1 (the concurrency/revert defect), including a new test that constructs
   genuinely overlapping in-flight command delivery for one commitment id — not merely sequential
   `await`s — and asserts the invariant survives it.
2. Fix and re-verify issue 2 (wire the withdrawal, correct the state-filter blind spot), including a
   test that starts an offer, lets it time out, and asserts the Commitment is actually released and
   the SLI actually reflects it.
3. Re-run `npm run verify` and the legacy lane after both fixes and confirm the counts in Part 11
   still hold.
4. The non-blocking items may be scheduled at the tech lead's discretion and do not themselves
   require re-verification before Phase 5, though item 6 should not be allowed to compound into a
   fifth phase.

**Phase 5 may begin once issues 1 and 2 are corrected and this review's reproduction scripts (Part
3.1's race script; a new equivalent for 3.2) are re-run clean against the corrected code.**

---

## Appendix — Commands and scripts run for this verification (reproducible)

```
npm run verify                                                     # 3 gates PASS, 53/1067, fresh, twice
npx jest --selectProjects legacy --runInBand --forceExit           # 22/169, fresh
npx prisma validate
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > gen.sql
grep -A26 'CREATE TABLE "Outbox"' gen.sql                          # byte-diff against migration.sql
grep -A12 'CREATE TABLE "AgentDedupState"' gen.sql
grep -n "CHECK" gen.sql                                            # zero — confirms hand-written CHECKs
git diff --stat -- Backend/src/routes/ Backend/src/app.js Backend/server.js \
  Backend/src/middlewares/ Backend/benchmark/                      # empty, confirmed
git diff -- Backend/src/sockets/handlers/robot.handler.js          # read in full
git diff -- Backend/src/sockets/handlers/command.handler.js        # read in full
git diff -- Backend/src/sockets/socket.server.js                   # read in full
git diff -- Backend/src/services/commandDispatcher.service.js      # read in full
git diff -- Backend/src/simulation/VirtualRobot.js                 # read in full (727-line diff)
grep -rn "withdrawExpiredOffer" Backend/                            # 3 matches: definition + 2 test files, 0 production callers
grep -rn "OUTBOX_STATE.FAILED" Backend/src/engine/dispatch/ Backend/src/workers/
grep -rn "UNACKNOWLEDGED" Backend/src/                              # 4 matches, none a query that includes it elsewhere
grep -n "outbox.worker" Backend/server.js                          # zero — worker not started
node -e '<planted a bare constant 47281 into live escalation.js, confirmed gate:params catches it, restored, re-diffed clean>'
node /tmp/race_repro.js                                            # Part 3.1's reproduction, full output captured above
```

Working tree left clean; the one planted violation (`escalation.js`) was restored from a backup and
independently re-diffed to confirm byte-identical restoration. No scratch files remain in the
repository (`/tmp/race_repro.js` and `/tmp/gen_full.sql` live outside the repository, in the
session's scratch area, and were not committed).

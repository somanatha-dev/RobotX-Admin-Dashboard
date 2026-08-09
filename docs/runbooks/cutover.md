# Runbook — production cutover

> **Risk level: HIGH — production cutover of the decision path.**
> — `IMPLEMENTATION_EXECUTION_PLAN.md`, Phase 15

This runbook stages `cutover.engine_enabled = true` shard by shard. Read the whole of it
before starting, and read [`rollback.md`](rollback.md) **first** — after this build, rolling
back is not a flag flip, and knowing that beforehand is the difference between a controlled
reversal and an outage.

---

## 0. The one thing that has changed about the shape of this cutover

Every phase from 3 to 14 built the engine beside a working legacy dispatcher. Phase 15
removed that dispatcher **from the build**, not from the code path:

- `taskAssignment.service.js`, `costEvaluator.service.js`, `robotValidator.service.js` and
  `taskRecovery.service.js` are deleted.
- `task.service.js` contains no selection, no finalisation and no detached background
  assignment.
- `tools/gates/checkLegacyRetirement.js` fails the build if any of them returns.

**So `cutover.engine_enabled = false` for a shard no longer means "the old path serves it".
It means that shard has no decision path at all.** Intake refuses new work for it with 503
and a sentence saying so; nothing is silently queued. That is deliberate — a task accepted,
durably recorded and never decided is the exact failure §12.1 exists to eliminate — but it
means a shard you disable is a shard that stops serving until you re-enable it or redeploy.

---

## 1. Prerequisites — none of these is a formality

| # | Prerequisite | How to check | Owner |
|---|---|---|---|
| 1 | Every **build gate** green | `npm run gates` | Eng |
| 2 | Every **§24 release gate** GREEN | `GET /api/health/cutover` → `releaseGates.blocking` is empty | Eng |
| 3 | Every **Safety-class parameter** `DERIVED` | `npm run gate:calibration` | **Calibration owner** (§22.4) |
| 4 | Shadow-mode agreement report over ≥ `cutover.shadow_agreement_window` | published report | Eng |
| 5 | Simulator fidelity study, one-sided, within `sim.max_optimistic_bias` | `npm run sim:fidelity -- --input <study>` | Safety |
| 6 | Safety case assembles with every reference resolving | `npm run safety:case` | Safety |
| 7 | **Rollback rehearsed**, with a date and an operator recorded | rehearsal record | SRE |
| 8 | Every Tier 2 kill switch **thrown** (§1.8 rule 3's ship state) | `GET /api/config/resolve` | Eng |

`cutover/stage.authoriseEnable()` checks 2, 3, 8 and the guardrail declaration
mechanically, and **refuses** rather than warning. It cannot check 4, 5, 6 or 7 — those are
evidence a human files against the gate table — which is precisely why they are listed
here with named owners.

> **Item 3 is the one that is currently red.** 39 Safety-class parameters are `PROVISIONAL`
> or `UNCALIBRATED`. This is execution-plan blocking pre-work item **B8**, not a code
> change: §22.4 says of these values that "a significant number of them … require data the
> fleet does not yet produce and cannot produce before it operates". Run
> `npm run gate:calibration --all` for the list. **The cutover cannot begin until a named
> calibration owner has closed it.**

---

## 2. Publish the staging plan before you start

```
GET /api/health/cutover
```

`stagingPlan.steps` is the order, and it is **not** negotiable at execution time:
ascending `agentCount`, ties broken by `shardId`. Least blast radius first.

Publishing it beforehand is the point. "We started with the biggest region because it was
the one people were watching" is a decision that should be made in a planning meeting, not
discovered in a postmortem. `authoriseEnable` refuses a shard whose eligible predecessors
are not live, and the escape — `options.overrideOrder` — requires a written reason and is
recorded in the audit as a skip rather than as a normal step.

---

## 3. Per shard — the loop

Repeat for each shard in `stagingPlan.steps` order.

### 3.1 Declare the SLI guardrails **before** enabling

§22.4 item 4: "Stage by shard, monitored against **pre-declared** SLI guardrails, with
automatic rollback."

```js
const declaration = guardrails.declare({
  shardId: "shard-eu-west-1",
  declaredBy: "<your identity>",
  declaredAtMs: Date.now(),
  observationWindowSeconds: config.resolve("cutover.observation_window"),
  guardrails: [
    { id: "commit_transaction_p999", direction: "AT_MOST",  threshold: 100, minSamples: 5000, unit: "ms" },
    { id: "decision_to_dispatch_p999", direction: "AT_MOST", threshold: 1000, minSamples: 5000, unit: "ms" },
    { id: "round_wall_clock",         direction: "AT_MOST",  threshold: 250, minSamples: 500,  unit: "ms" },
    { id: "intake_ack",               direction: "AT_MOST",  threshold: 50,  minSamples: 5000, unit: "ms" },
  ],
});
```

Two rules the code enforces and you should understand rather than work around:

- **`minSamples` is mandatory.** A p99.9 concluded from forty observations has not been
  concluded; it has been guessed at, and a rollback triggered by that guess is an outage
  caused by the safety mechanism. A window without enough samples returns `HOLD`, never
  `PROCEED`.
- **A window that opened before its declaration is refused outright.** `assess()` returns
  `HOLD` with a refusal naming the ordering. There is no way to declare guardrails after
  the fact and have them count.

Both p99.9 rows are mandatory. §20.1 states them at p99.9 because each bounds a *safety
window* rather than describing latency — the commit tail bounds the leadership-fence
exposure window, and the dispatch tail bounds how long a commitment can exist without the
agent knowing about it. Declaring either at p99 is a category error, not a relaxation.

### 3.2 Authorise

```js
const authorisation = stage.authoriseEnable({
  shard, allShards, liveShardIds,
  releaseEvidence,          // the §24 gate evidence
  killSwitchState,          // every Tier 2 switch thrown
  declaration,              // from 3.1
  requestedBy: "<you>",
  approvedBy: "<a different person>",
  reason: "<why now>",
  requestedAtMs: Date.now(),
});
```

If it refuses, `refusal.code` says which of the five grounds and `refusal.detail` names the
specifics. Do not route around a refusal; every one of them is a gate somebody put there.

### 3.3 Publish and audit

Publish `authorisation.action.binding` through the Config Service — a normal, versioned,
approved publish. Then append `stage.auditEventFor(authorisation.action)` to the audit
stream. The pre-declaration travels in that event's payload, which is how
`cutover/store.js` reads it back and how anyone can later verify the ordering.

### 3.4 Hold for the observation window

The staged-rollout controller (`workers/cutover.worker.js`) assesses the shard every
`cutover.guardrail_check_interval`. Watch for:

- `PROCEED` — every guardrail held over a sufficient window. Move to the next shard.
- `HOLD` — insufficient samples, or the window has not elapsed. Wait. Do not interpret a
  `HOLD` as a soft pass.
- `ROLL_BACK` — a guardrail regressed. The controller has already reverted the binding and
  written the audit event. Go to [`rollback.md`](rollback.md) §3.

**The controller can only ever disable.** §22.3 forbids an automated process from making
the change that raises risk, so `guardrails.assertOneDirectional()` throws if anything
tries to route an enable through the automatic path. Enabling is always §3.2.

---

## 4. After the last shard

1. **Verify.** `GET /api/health/cutover` — `live` equals `total`, no blocking gate.
2. **Watch the invariants.** `GET /api/health/invariants` — every §26 invariant `ENFORCED`
   with a zero-violation SLI. A `SUSPENDED` is only acceptable where §26.2's matrix
   authorises it and names the mode.
3. **Publish the API version note.** `POST /api/tasks/assign` already carries
   `X-RobotX-API-Version` and the `supersededContract` block; the note goes to consumers
   through whatever channel they subscribe to.

---

## 5. The retention window — what is deliberately **not** done at cutover

The plan conditions four retirements on "after cutover" / "after a full retention window
with the new path live". None of them happens on cutover day. Each has a named trigger:

| Retired | Trigger | Notes |
|---|---|---|
| Legacy socket events `TASK_ASSIGN`, `task_assigned`, `assign_task`, `STOP` | no client has used them for a full retention window | The Frontend already reads `task_accepted` / `OFFER_RESPONSE`; these survive for unmigrated clients and for in-flight missions |
| Redis keys `robotTask:*`, `robotTaskState:*`, `taskPath:*` | every mission that predates the cutover has settled | `rerouteTask` reads them; it is the last legacy surface in `task.service.js` |
| `task.service.rerouteTask` and `straightLineRoute` | the keys above are gone | Rerouting a pre-cutover `Task` is not the assignment path; deleting it at cutover would strand every in-flight mission |
| Legacy columns (`Robot.currentTaskId`, `Stop.label`, `Task.pickup`/`drop`, …) | a full retention window with the new path live | `Robot.currentTaskId` stays as a read-only mirror until then |

`robotReserve:*` is **already** retired for correctness: `kv.reserveRobot` is advisory by
default from this build, and no caller depends on it for exclusivity. The key itself is
harmless and expires on its own.

---

## 6. Abort criteria — stop the cutover, do not push through

Stop and roll back the current shard if any of these is true, without waiting for the
window:

- Any §26 invariant reports `VIOLATED` (not `SUSPENDED`).
- The fence-rejection counters are rising rather than flat.
- The reconciler's repair rate rises in any category.
- Any commitment is observed on an agent that already holds `capacity`.
- Any guardrail breaches, at any point in the window.

The first and the last are the controller's job. The middle three are yours.

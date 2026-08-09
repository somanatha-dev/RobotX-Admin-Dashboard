# Runbook — rollback

> Read this **before** running [`cutover.md`](cutover.md), not after something has gone
> wrong. The single most important fact in it is counter-intuitive and, discovered during
> an incident, expensive.

---

## 0. The fact

**After the Phase 15 build, disabling a shard does not restore the legacy dispatcher. There
is no legacy dispatcher.**

The plan's completion criterion is that the legacy decision path is "removed from the
build, not merely bypassed", and the build carries it out:
`taskAssignment.service.js`, `costEvaluator.service.js`, `robotValidator.service.js` and
`taskRecovery.service.js` are deleted; `task.service.js` has no selection path;
`tools/gates/checkLegacyRetirement.js` fails the build if any of them returns.

So there are **two different rollbacks**, they cost very different amounts, and choosing
the wrong one under pressure is the failure this document exists to prevent:

| | What it does | How long | When to use it |
|---|---|---|---|
| **A — Disable the shard** | The shard stops deciding. Intake refuses new work for it with 503 and a sentence naming the state. Work already committed continues under supervision. | Seconds. A config publish. | The engine is misbehaving on this shard and stopping is better than continuing. |
| **B — Redeploy the previous artefact** | Restores the legacy dispatcher, because that build still contains it. | A deploy. | The engine is misbehaving fleet-wide and the fleet must keep serving. |

**A is not a lesser B.** A stops the shard; it does not hand it to another path. If the
shard must keep serving, you need B.

---

## 1. Decide which one — in under a minute

```
Is any §26 invariant VIOLATED, or is any commitment double-granted?
├── YES → A immediately, for the affected shard. Then investigate. Correctness first.
└── NO
    └── Is the fleet unable to serve without this shard?
        ├── NO  → A. Stopping is cheap and reversible.
        └── YES → B. Start the deploy now; do A on the shard while it runs.
```

Doing A while B deploys is not belt-and-braces, it is correct: A takes seconds and stops
the harm, B takes minutes and restores the service.

---

## 2. Rollback A — disable one shard

```js
const authorisation = stage.authoriseRollback({
  shard,                       // { shardId, regionId }
  reason: "<what you observed>",
  requestedBy: "<you>",
  requestedAtMs: Date.now(),
});
```

`authoriseRollback` **has no gate, no quorum, and no ordering rule.** Every reason to
refuse an enable is a reason to permit a disable, and a control that can be refused is not
a control. It requires only a reason, so the audit records why.

Then:

1. Publish `authorisation.action.binding` (`cutover.engine_enabled = false`, region scope).
2. Append `stage.auditEventFor(authorisation.action)`.
3. Confirm: `GET /api/health/cutover` — the shard's `live` is `false` and its
   `consequence` reads *"this shard has NO decision path"*.

### What is true immediately afterwards

- **New work for this shard is refused**, with 503 and `code: "ENGINE_NOT_LIVE"`. Nothing
  is silently queued: a task accepted, durably recorded and never decided is the exact
  failure §12.1 exists to eliminate.
- **Committed work continues.** Commitments are durable, leases are still renewed, timers
  still fire, and the reconciler still sweeps. Disabling the decision path does not abandon
  missions that are already running — it stops new decisions.
- **The coordinator stands down** for that shard at the next tick.

### What you must do next

Missions already in flight will settle. Missions **queued but not yet decided** will not:
they sit in `WorkQueue` with nothing draining them. Either re-enable the shard once the
cause is understood, or drain the queue deliberately. Leaving it is the one outcome nobody
should choose by default.

---

## 3. Rollback A, automatic

`workers/cutover.worker.js` performs exactly this, on its own, when a pre-declared SLI
guardrail regresses. It:

1. reads the pre-declaration back out of the audit stream (never from memory — a cached
   copy would survive a restart with something nobody can audit);
2. assesses the observation window;
3. on `ROLL_BACK`, calls `stage.authoriseRollback({ automatic: true })`, publishes the
   reverted binding, and appends the audit event;
4. logs at `error` with the shard, the breached guardrails and the observed values.

**It can only ever disable.** `guardrails.assertOneDirectional()` throws on anything else,
because §22.3 forbids an automated process from making the change that raises risk. If you
find yourself wanting to automate the *enable*, that is §22.3 telling you not to.

An automatic rollback is not self-healing. It has stopped the harm and paged; the shard is
now in the state §2 describes and needs a person.

---

## 4. Rollback B — redeploy the previous artefact

Use when the fleet must keep serving and the engine cannot.

1. **Identify the last pre-Phase-15 build.** It is the last artefact whose
   `tools/gates/checkLegacyRetirement.js` **fails** — that gate's failure is precisely the
   marker that the legacy path is present. If the gate passes, the legacy dispatcher is not
   in that artefact and redeploying it will not help.
2. **Set `ENGINE_ENABLED=false`** in that deployment's environment. The pre-Phase-15 build
   reads it as its master switch, and false means the legacy dispatcher serves.
3. **Deploy.**
4. **Verify:** tasks reach `ASSIGNED` with a `robotId`, and `TASK_ASSIGN` reaches agents.

### What the engine leaves behind, and why it is safe

The engine's tables (`Commitment`, `Leg`, `Mission`, `WorkQueue`, `Outbox`, `Timer`, …) are
**additive**. Every Phase 2–14 migration was additive-only and the legacy dispatcher reads
none of them. It reads `Task` and `Robot`, both of which the engine also maintains.

Two consequences, both real:

- **Commitments the engine holds become invisible to the legacy path.** It reads
  `Robot.currentTaskId`, which the engine maintains as a mirror, so an agent executing an
  engine commitment appears busy and is not re-assigned. That is why the column is retained
  as a read-only mirror through the retention window rather than dropped at cutover.
- **Legs queued but not decided are stranded** across the reversal. The legacy path does
  not read `WorkQueue`. Reconcile them by hand, or re-submit them as `Task` rows.

### After B

The engine's durable state is intact and consistent — nothing in the legacy path writes to
it. When the defect is fixed, re-cutover from §2 of [`cutover.md`](cutover.md) with the
same staged discipline. Do not shortcut the staging because "it was live before". It was
live before with a defect in it.

---

## 5. Rehearsal — the gate this document is evidence for

`rollback_rehearsed` is a blocking §24 release gate and it is `ORGANISATIONAL` evidence: no
build can close it. A rehearsal that discharges it must:

1. Take a **staging** shard live through the full §3 of `cutover.md`, including the
   pre-declaration.
2. Trigger an **automatic** rollback by breaching a guardrail deliberately — not by calling
   the rollback function. What is under test is the controller, not the API.
3. Confirm the shard reports no decision path and that new work is refused with a reason.
4. Perform rollback **B** end to end: identify the artefact, deploy it, confirm the legacy
   path serves.
5. Re-cutover.
6. Record the date, the operators, the wall-clock time of each step, and anything that
   surprised you.

Step 4 is the one that will be skipped and it is the one that matters. §22.5's argument
about kill switches applies exactly: *"An untested kill switch is not a control; it is a
second, less well understood code path that will be invoked for the first time during an
incident."*

---

## 6. What is **not** a rollback

- **Setting `ENGINE_ENABLED=false` on the current build.** This process then starts no
  coordinator, drains no outbox and runs no round — for *every* shard, not one. It is a
  fleet-wide stop, not a rollback.
- **Re-adding a legacy service "temporarily".** `checkLegacyRetirement` fails the build,
  deliberately. The greedy per-arrival dispatcher is what the frozen specification was
  written against; reinstating it under incident pressure is how a cutover is quietly
  undone. If the legacy path is genuinely needed, that is rollback B, which is a deploy of
  an artefact that was reviewed — not a hot patch that was not.
- **Throwing kill switches.** Every §22.5 switch disables a **Tier 2** mechanism, and all
  of them are already thrown at launch (§1.8 rule 3). There is nothing to throw, and
  nothing that would help if there were: no Tier 0 or Tier 1 guarantee depends on a Tier 2
  mechanism.

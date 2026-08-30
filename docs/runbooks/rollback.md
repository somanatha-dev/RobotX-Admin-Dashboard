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

1. **Publish the binding — as part of a complete set.** Read step 1 before you type it: the
   obvious form of it is a fleet-wide outage.
2. Append `stage.auditEventFor(authorisation.action)`.
3. Confirm: `GET /api/health/cutover` — the shard's `live` is `false`, its `decisionPath`
   reads `NONE`, and its `consequence` reads *"this shard has NO decision path"*.

### 2.1 Step 1 in full — a version is a complete set

**Do not publish `authorisation.action.binding` on its own.** A configuration version is a
complete set: `config/service.publish()` writes exactly the bindings the request carries and
inherits nothing (`config.controller.publishVersion` defaults `bindings` to `[]`, and
`publishPayload` records `snapshot.declaredBindings`). A publish carrying one binding
therefore reverts **every other parameter in the deployment** to its register default — a
fleet-wide change issued by the one control whose whole justification is that it touches one
shard. `rollbackPublisher.bindingsWithRegionDisabled` exists because the automatic path had
to solve exactly this; the manual path uses the same function.

There is no HTTP surface that returns the in-force binding set — `GET /api/config/versions`
returns version numbers, `publishedBy`, signatures and notes, not payloads, and
`GET /api/config/resolve` explains one parameter at a time. Read it the way the automatic
path does, from a node shell in the deployment (the same shell §3.1 of
[`cutover.md`](cutover.md) puts you in):

```js
const configService     = require("./src/engine/config/service");
const rollbackPublisher = require("./src/engine/cutover/rollbackPublisher");

const inForce = await rollbackPublisher.versionInForceReader({ prisma });
// → { version, latestVersion, payload } — or null if nothing is pinned, in which case
//   no shard is live and a rollback is not the repair for whatever is actually wrong.

const published = await configService.publish(prisma, {
  publishedBy: "<you>",
  approvals: [{ approverId: "<a different person>", approvedAt: new Date().toISOString() }],
  // The in-force set, with this one region's binding replaced — not appended.
  bindings: rollbackPublisher.bindingsWithRegionDisabled(
    inForce.payload.bindings,
    authorisation.action.binding.key,        // the regionId
  ),
  killSwitchState: inForce.payload.killSwitchState,
  regimes:         inForce.payload.regimes,
  spatial:         inForce.payload.spatial,
  shards:          inForce.payload.shards,
  note: `ROLLBACK A — ${authorisation.action.shardId}. ${authorisation.action.reason}`,
});

// Publishing creates a version; pinning is what makes processes observe it.
await configService.pinVersion(prisma, kv, published.version, "<you>");
```

That is the same set §3's automatic path publishes, built by the same exported function, so
the manual and the automatic rollback leave the deployment in the same state rather than in
two states that differ by everything nobody restated.

**Publish *and* pin.** A published version that is not pinned is not the version in force and
no process adopts it — the shard stays live while you believe it has stopped. If you go
through the API instead (`POST /api/config/publish`, elevated role, §23.4 action class
`SAFETY_CONFIG_CHANGE`), it pins by default and `{"pin": false}` turns that off. Do not turn
it off here.

**Yours is an operator publish, not `automated: true`.** §22.3 forbids an automated publish
that changes a Safety-class parameter at all; an operator publish instead needs two distinct
approver identities for any Safety-class parameter whose *effective* value moves — which, if
you restated the set correctly, is none. If `publish()` reports Safety-class changes you did
not intend, that is the check telling you the set is incomplete. Do not add approvers to get
past it.

### What is true immediately afterwards

- **New work for this shard is refused**, with 503 and `code: "ENGINE_NOT_LIVE"`. Nothing
  is silently queued: a task accepted, durably recorded and never decided is the exact
  failure §12.1 exists to eliminate.
- **Committed work continues.** Commitments are durable, leases are still renewed, timers
  still fire, and the reconciler still sweeps. Disabling the decision path does not abandon
  missions that are already running — it stops new decisions.
- **Agent sessions are refused** the same way, by `cutover/agentGate.js`, on all five socket
  handlers.

> **What this does NOT do, and you must know it before you rely on Rollback A: it does not
> stop a running coordinator.** Verified against the current tree on 2026-08-30 — the
> per-shard half of the switch (`cutover.engine_enabled`, via `cutover/enabled.js`) has
> exactly four production consumers: intake (`services/task.service.js`), the agent socket
> gate (`cutover/agentGate.js`), the health surface (`controllers/health.controller.js`) and
> the guardrail controller's own `cutover/store.liveShards()`. **`workers/coordinator.worker.js`
> is not among them**: `runRound()` takes no configuration snapshot and asks no cutover
> question, and `server.js` gates the coordinator lifecycle on `ENGINE_ENABLED` — the
> *process* half — only.
>
> So Rollback A stops **new work entering** the shard. A coordinator already running would go
> on draining the `WorkQueue` it has. Today no coordinator runs at all — `leaderWorkers`
> refuses to compose one because no routing engine is selected (**B1**) — so the two are
> indistinguishable in this deployment, which is exactly why this went unnoticed. **Until B1's
> composition-root work lands, do not read "the shard stops deciding" as enforced by the
> configuration.** If a coordinator is running and must stop now, stop the process that holds
> its leadership lease; that is a fleet-level act on that process, and §6 says what it is not.
>
> The gate belongs in the composition root, alongside the routing client — it is listed with
> B1's remaining engineering work in
> [`../phase15/PHASE_15_BLOCKERS.md`](../phase15/PHASE_15_BLOCKERS.md) § **B1**. It is not
> written here, because a guard injected into a worker that cannot be composed is a guard with
> no caller, and this programme has enough of those.

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
   reverted binding **and pins it**, and appends the audit event;
4. logs at `error` with the shard, the breached guardrails and the observed values.

**How the publish is permitted, and how far it goes.** It runs through
`engine/cutover/rollbackPublisher.js` as an `automated: true` publish. That is legal for
exactly one reason, and it is recorded in the register rather than in this runbook:
`cutover.engine_enabled` is classified **STRUCTURAL rather than SAFETY on purpose**, because
§22.3 forbids an automated process from changing a Safety-class parameter and §22.4 item 4's
automatic rollback must be able to set this one `false`. The publisher refuses anything that is
not a disable of that parameter at region scope, and carries every other binding, kill switch,
regime, spatial declaration and shard definition of the version in force forward unchanged — a
per-shard control must not make a fleet-wide change.

**It refuses while a version is published but not pinned.** *(Phase 15 third-pass
remediation, P15-E2.)* "The version in force" means the **pinned** one. Until this
remediation the composition root handed the publisher the *latest published* version instead,
and those differ exactly when someone has published with `{ "pin": false }` — which is how a
candidate configuration is put up for review. Measured on a real database: with v10 pinned
and v11 published-unpinned, one automatic rollback published v12 **from v11** and pinned it,
putting an unreviewed configuration into force across the fleet as a side effect of disabling
one shard.

The publisher now reads the pin, and in that divergent state it **refuses** with
`SUPERSEDES_AN_UNPINNED_VERSION` rather than choosing for you. Version numbering is linear, so
anything it publishes is `latest + 1` and supersedes the candidate either way: carrying the
in-force set forward reverts the candidate's content, and carrying the candidate's set forward
puts a configuration nobody approved into force — and §22.3 forbids the second absolutely.
Neither is a decision an automatic, one-directional control may take.

> **What to do when you see it.** The refusal names both versions. **The shard stays live
> until you act.** Either resolve the candidate — pin it, or supersede it with a version you
> do want in force — or take **Action A** below by hand. An operator publish is not subject
> to this rule, and it is the faster of the two when a shard is actively breaching.

**Propagation is not instant.** Processes adopt the pinned version on the configuration pull,
at `cutover.guardrail_check_interval`. Confirm with `GET /api/health/cutover` that the shard
reads `NONE` before you treat the harm as stopped. *Before the Phase 15 current-tree
remediation this step published nothing at all: the controller reported a rollback, wrote the
audit event, and left the shard live — and, because a rollback event makes
`store.declarationFor` return null, it was never assessed against its guardrails again.*

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

Three consequences, all real, and the first is the one that will hurt:

- **An agent holding an engine commitment reads as IDLE to the legacy path, and can be
  re-assigned.** *(Corrected 2026-08-30. This section previously said the opposite — that
  `Robot.currentTaskId` is "maintained as a mirror" by the engine, so a committed agent
  "appears busy and is not re-assigned". It is not maintained, and that made this paragraph
  an argument for safety where the hazard is.)* Verified on the current tree: **no code in
  the build assigns `Robot.currentTaskId` a task id.** Its only writers clear it —
  `tasks.controller.js:263` on cancel, `dtaro.handler.js:183` on `TASK_COMPLETE` — and
  `robots.controller.js:483` derives `ACTIVE`/`IDLE` from it. It was the *legacy* path's own
  record (`tools/migrate/backfillDomain.js:32-34`), that path was deleted at Phase 15, and
  nothing replaced the writer. The column is retained through the retention window, and
  `commitmentSchema.test.js` fails if a drop arrives early, but retained is not maintained.

  **So before you deploy B, take the agents holding open commitments out of the legacy
  dispatcher's reach.** `Commitment` is the authoritative list of who holds what; the legacy
  path cannot see it and will not consult it. An agent left visible and idle-looking is a
  double assignment, which is the one outcome §12.1 exists to eliminate — and it would arrive
  during the incident that made you reach for B.
- **Legs queued but not decided are stranded** across the reversal. The legacy path does
  not read `WorkQueue`. Reconcile them by hand, or re-submit them as `Task` rows.
- **Nothing the legacy path does corrupts the engine's state.** It writes `Task` and `Robot`
  and reads none of the engine's tables, so "After B" below holds.

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

> ### ✅ RESOLVED — step 1 is performable (ADR-34)
>
> **This was an open finding until 2026-08-22, and the shape of the problem is worth keeping.**
> Step 1 takes a staging shard live, which goes through `stage.authoriseEnable()`. That
> function refuses while **any** blocking §24 gate is not GREEN, and `rollback_rehearsed` is a
> blocking gate. So the rehearsal required a cutover and the cutover required the rehearsal.
> There was no escape in the code, deliberately: `cutover/gates.js` states there is no
> `WAIVED` status because *"a gate that could be waived would be a route around the predicates
> those classes protect"*, and `authoriseEnable`’s only override skips the **staging order**,
> never a gate.
>
> [`ADR-34`](../adr/ADR-34-cutover-rehearsal-purpose.md) resolves it **without weakening any
> gate**. The diagnosis was that one function was answering one question for two different
> acts: a production cutover, and a rehearsal whose whole purpose is to *produce* the evidence
> the gate is about. An `ENABLE` now names its purpose:
>
> - `PURPOSE.PRODUCTION` — the default, and unchanged in every respect.
> - `PURPOSE.REHEARSAL` — permitted only against a declared non-production environment
>   (`environment: { id, production: false }`), and it excludes **exactly one** gate:
>   `rollback_rehearsed`. Everything else — the other twenty-three gates, the §1.8 rule 3 ship
>   state, two-person approval, the guardrail pre-declaration, the staging order — still
>   applies.
>
> **The forgery this section used to warn about is now refused by the code rather than by this
> paragraph.** Making the rehearsal performable would have been a hole rather than a fix if
> its evidence had stayed uncheckable, so `evidence.admit()` now requires the record to carry
> the rehearsal itself. Two signatures are still necessary and are no longer sufficient.

#### The rehearsal record

A record that discharges `rollback_rehearsed` carries, alongside the two distinct signatures:

| Field | Meaning | Refusal if absent |
|---|---|---|
| `rehearsal.environment` | `{ id, production: false }` — named, and declaring itself non-production | `REHEARSAL_NOT_IN_A_REHEARSAL_ENVIRONMENT` |
| `rehearsal.configVersion` | The published configuration version exercised (§22.1 rule 4) | `REHEARSAL_CONFIGURATION_UNIDENTIFIED` |
| `rehearsal.steps` | Each of the six steps above, **by the key below**, and `true` | `REHEARSAL_INCOMPLETE` (naming the missing steps) |
| `rehearsal.automaticRollbackFired` | The **controller** fired on a real guardrail breach | `REHEARSAL_NOT_AUTOMATIC` |
| `approval.recordedBy` / `approval.approvedBy` | Two **distinct** named humans | `APPROVER_REQUIRED` / `APPROVER_NOT_DISTINCT` |
| `pass` | `true` — the rehearsal succeeded. A completed rehearsal that failed is admissible evidence *of a failure* | (admitted, and the gate is not green) |

**The six step keys, verbatim.** `evidence.admit()` matches
`engine/cutover/evidence.js`'s `REHEARSAL_STEPS` exactly, and a step under any other name is
a step that was not done. *(Added 2026-08-30: this table said "each of the six steps above,
named individually" and never gave the names, so a record filed from this file alone was
refused `REHEARSAL_INCOMPLETE` — on the gate that no build can close.)*

| Key | The step above |
|---|---|
| `cutover` | 1 — staging shard taken live through the full §3 of `cutover.md` |
| `automatic_rollback` | 2 — a guardrail breached deliberately |
| `no_decision_path_confirmed` | 3 — no decision path, and new work refused with a reason |
| `artefact_rollback` | 4 — rollback B end to end |
| `recutover` | 5 — re-cutover |
| `recorded` | 6 — dates, operators, wall-clock times, surprises |

A step that is omitted is treated exactly as a step reported `false`. The record ages like
every other piece of release evidence, so a rehearsal cannot be performed once and cited
indefinitely — it is evidence about the system being shipped, or it is not evidence.

`automaticRollbackFired` is checked separately from its own checkbox for the reason step 2
gives: a rehearsal that called the rollback function directly has exercised the one path that
was never in doubt.

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

---

## 7. When this file was last checked against the code

`docs/` is outside the source-digest scope by design, so **no gate detects this file drifting
from the API it documents** (recorded as **P15-F7a** in
[`../phase15/PHASE_15_BLOCKERS.md`](../phase15/PHASE_15_BLOCKERS.md)). The compensating
control is this section: the procedure is traced by hand and the date recorded, so a reader
can tell how old the last check is instead of assuming there was one.

| Checked | Against | By |
|---|---|---|
| **2026-08-30** | digest `f6f69ea1a54ca211…` (571 files), branch `feature/dashboard` | Phase 15 closure-checklist item **V-10** |

> **The tree is now digest `d033038c…` (573 files), and this trace is still current** — confirmed
> 2026-08-30 by the post-V-10 current-state audit. Every in-scope change between `f6f69ea1…`/571
> and `d033038c…`/573 is **V-10's own artefact**: the two files added are the test suite named
> below and `Backend/tools/verify/v10RollbackRunbook.js`; `package.json` gained the script that
> runs it; and `src/engine/cutover/rollbackPublisher.js` changed by **one comment** (the §4→§3
> citation fix, defect 5 above) with no behavioural edit. **No API this file documents changed**,
> which is why the date above was not re-stamped. Do not read the digest difference as drift — do
> read it as the reason this row records a digest at all.

**V-10 had never been executed by any pass before this one.** Five defects were found and
fixed in this file; each is marked in place with the date and with what it used to say:

1. **§2.1 — step 1 published one binding.** As written it reverted every other parameter in
   the deployment to its register default. The complete-set rule, the carry-forward and the
   pin are now stated. *(Permissive: the wrong version would have been published, and the
   publish would have succeeded.)*
2. **§2 — "the coordinator stands down" is not implemented.** The per-shard switch has four
   production consumers and the coordinator is not one of them. Routed to B1's
   composition-root work; the runbook no longer claims it.
3. **§4 — `Robot.currentTaskId` is not maintained by the engine.** The paragraph argued
   Rollback B was safe from a mirror that has had no writer since Phase 15 deleted the legacy
   path. Corrected, and the double-assignment hazard stated.
4. **§5 — the six rehearsal step keys were never named**, so a record filed from this file
   was refused `REHEARSAL_INCOMPLETE` on a gate no build can close (**B-O**).
5. **§2/§3 pointers** — `engine/cutover/rollbackPublisher.js` cited "§4 says the same" for a
   sentence that is in §3; corrected in that file.

What was traced and found **correct**: `stage.authoriseRollback`'s signature, refusals and
action shape; `stage.auditEventFor`; the `GET /api/health/cutover` fields (`live`,
`decisionPath: "NONE"`, `consequence`); intake's 503 / `ENGINE_NOT_LIVE`; every claim in §3
about `workers/cutover.worker.js` and `rollbackPublisher` including
`SUPERSEDES_AN_UNPINNED_VERSION` and `assertOneDirectional`; §5's four refusal codes; and §6.

`tests/engine/phase15RollbackRunbook.test.js` pins the two facts in this file that a code
change could silently invalidate — the carry-forward set, and the six step keys.

# RobotX Task Assignment Engine — Forensic Implementation Audit

**Status:** Descriptive specification of the system as implemented. No proposed changes.
**Scope:** `Backend/` at branch `feature/dashboard`, commit `e558243`.
**Method:** Every statement below is traced to a specific file and line. Where behavior
cannot be established from the repository, this document says so explicitly rather than
inferring intent.

---

## 1. Assignment Engine Overview

### 1.1 What the engine is

RobotX assigns delivery tasks to robots using a single-shot, greedy, multi-criteria
scoring function branded **DTARO**. There is no queue, no batch optimizer, no bidding
protocol, and no re-planning of already-made assignments. Each task independently
selects one robot at the moment the task is created, and that decision is final unless
the task is cancelled or the server restarts.

The core scoring function is a fixed-weight linear combination of five normalized terms
([costEvaluator.service.js:113-120](Backend/src/services/costEvaluator.service.js#L113-L120)):

```
C(r) = w1·D(r) + w2·(1 − B(r)/100) + w3·U(r) + w4·T(r) + w5·Z(r)

w1 = 0.50   D — min-max normalized haversine distance, robot → pickup
w2 = 0.30   B — battery percentage, inverted
w3 = 0.15   U — utilization ratio from the live registry
w4 = 0.05   T — min-max normalized Mapbox driving duration, robot → pickup
w5 = 0.05   Z — zone-locality penalty (0 same zone, 1 otherwise)
```

The robot with the **minimum** `C(r)` wins
([taskAssignment.service.js:184-186](Backend/src/services/taskAssignment.service.js#L184-L186)).

### 1.2 Architectural philosophy as expressed in code

Four properties are structurally evident in the implementation:

1. **Hard constraints are separated from soft preferences.** Eligibility is a boolean
   gate applied *before* scoring
   ([robotValidator.service.js](Backend/src/services/robotValidator.service.js)); the
   cost function never sees an ineligible robot and can never "score around" a hard rule.

2. **Live state overrides durable state.** Redis is the authority for position, battery,
   status, utilization, zone, and health; PostgreSQL is a durable mirror consulted only
   when the Redis entry is absent or expired
   ([taskAssignment.service.js:126-139](Backend/src/services/taskAssignment.service.js#L126-L139)).

3. **Assignment is asynchronous to the HTTP request.** The API returns a `PENDING` task
   immediately and performs selection, routing, and finalization in a detached
   `setImmediate` callback
   ([task.service.js:364-388](Backend/src/services/task.service.js#L364-L388)).

4. **Mutual exclusion is delegated to Redis, not to the database.** A `SET NX EX`
   reservation is the actual guard against two tasks claiming one robot
   ([kv.js:419-445](Backend/src/cache/kv.js#L419-L445)); the database transaction is a
   secondary consistency check, not a serializable lock (see §7.4).

### 1.3 Component inventory

| Component | File | Role in assignment |
|---|---|---|
| Task API | `controllers/tasks.controller.js` | HTTP entry, no assignment logic |
| Task orchestrator | `services/task.service.js` | Validation, PENDING create, reservation loop, retry, finalization, dispatch |
| Candidate selector | `services/taskAssignment.service.js` | Candidate query, validation fan-out, position overlay, Matrix batching, cost invocation, argmin |
| Eligibility gate | `services/robotValidator.service.js` | All hard constraints |
| Scorer | `services/costEvaluator.service.js` | Normalization + weighted sum |
| Live state facade | `services/robotRegistry.service.js` | `registry:{robotId}`, TTL 30 s |
| KV facade | `cache/kv.js` | Redis wrapper, in-memory fallback, fail-closed lock |
| Zone resolver | `services/zoneManager.service.js` | Bounding-box zone lookup, 3-tier cache |
| Travel time | `services/mapbox.service.js` | Matrix API (selection), Directions API (routing) |
| Geometry | `utils/distance.js` | Haversine, bearing |
| Delivery | `services/commandDispatcher.service.js` | Room-based `TASK_ASSIGN` emit with retry |
| Utilization producer | `sockets/handlers/telemetry.handler.js` | EMA update of `registry.utilization` |
| Recovery | `services/taskRecovery.service.js`, `server.js` | Post-restart re-hydration and re-dispatch |
| Robot simulation | `simulation/VirtualRobot.js` | Executes assignments, drains battery, charges, reports completion |

### 1.4 What the engine explicitly does not do

Established by exhaustive search of `Backend/src`:

- **No payload/capacity model.** No field named `payload`, `capacity`, `weight`, `cargo`,
  or `maxLoad` exists on the `Robot` or `Task` Prisma models
  ([schema.prisma:170-232](Backend/prisma/schema.prisma#L170-L232),
  [schema.prisma:298-342](Backend/prisma/schema.prisma#L298-L342)). **Not implemented.**
- **No capability/skill model.** No robot type, class, or capability attribute exists.
  **Not implemented.**
- **No mission-feasibility check.** Total mission distance is computed *after* the robot
  is already chosen and bound ([task.service.js:246](Backend/src/services/task.service.js#L246)).
  **Not implemented.**
- **No task queue or requeue.** A failed assignment sets the task to `FAILED` terminally
  ([task.service.js:379-385](Backend/src/services/task.service.js#L379-L385)). **Not implemented.**
- **No reassignment of a live task.** Nothing reassigns a task away from a robot that
  disconnects, faults, or drains. **Not implemented.**

---

## 2. Complete Assignment Pipeline

### 2.1 Stage map

```
HTTP POST /api/tasks/assign
  │  authUser JWT middleware              routes/tasks.routes.js:8
  │  rate limit 60/60s                    routes/tasks.routes.js:10,15
  ▼
Stage 1  Input validation                 task.service.js:336-362
  ▼
Stage 2  PENDING task row created         task.service.js:365-368
  ▼
Stage 3  TASK_CREATED → dashboard         task.service.js:371-373
  ▼
──── HTTP RESPONSE RETURNED (200) ────    tasks.controller.js:43
  ▼
Stage 4  setImmediate detach              task.service.js:376
  ▼
Stage 5  Zone resolution for pickup       taskAssignment.service.js:72
  ▼
Stage 6  Candidate discovery (SQL)        taskAssignment.service.js:77-86
  ▼
Stage 7  Batched live-state MGET          taskAssignment.service.js:98
  ▼
Stage 8  Eligibility filtering            taskAssignment.service.js:100-118
  ▼
Stage 9  Position overlay                 taskAssignment.service.js:121-146
  ▼
Stage 10 Travel time (Matrix, batch 24)   taskAssignment.service.js:149-180
  ▼
Stage 11 Cost evaluation + argmin         taskAssignment.service.js:183-186
  ▼
Stage 12 DTARO decision log               taskAssignment.service.js:189-201
  ▼
Stage 13 Reservation (SET NX EX 30s)      task.service.js:189
  │        └─ on failure → Stage 6 with exclusion (max 3 attempts)
  ▼
Stage 14 Finalization pre-checks          task.service.js:229-240
  ▼
Stage 15 Route computation (Directions)   task.service.js:246
  ▼
Stage 16 DB transaction: ASSIGNED + bind  task.service.js:249-272
  ▼
Stage 17 Redis task-state seeding         task.service.js:280-284
  ▼
Stage 18 Dashboard events                 task.service.js:287-308
  ▼
Stage 19 TASK_ASSIGN socket dispatch      task.service.js:317-321
  ▼
Stage 20 Allocation metric record         task.service.js:325
  ▼
Stage 21 Reservation release (finally)    task.service.js:222-224
  ▼
Stage 22 Robot execution (no ACK)         simulation/VirtualRobot.js:316-374
  ▼
Stage 23 TASK_COMPLETE → COMPLETED        sockets/handlers/dtaro.handler.js:82-137
```

### 2.2 Stage 1 — Input validation

Implemented entirely in
[task.service.js:336-362](Backend/src/services/task.service.js#L336-L362).

| Check | Field | Failure |
|---|---|---|
| Non-empty string | `pickup`, `drop` | `400 "pickup and drop are required"` |
| Numeric coercion | `pickupLat`, `pickupLon`, `dropLat`, `dropLon` | `400 "pickupLat/pickupLon/dropLat/dropLon are required"` |

`toNumberOrNull`/`toStringOrNull` ([utils/parse.js](Backend/src/utils/parse.js)) perform
the coercion. **No range validation exists** — latitude outside [-90, 90] or longitude
outside [-180, 180] is accepted. **No check that pickup ≠ drop.** **No check that the
coordinates fall inside any campus, zone, or serviceable region.**

`taskId` is client-supplied or generated as
`` `TSK-${Date.now()}-${crypto.randomInt(100, 1000)}` ``
([task.service.js:348-351](Backend/src/services/task.service.js#L348-L351)).

`robotId` in the request body is read as `robotCodeIn`
([task.service.js:338](Backend/src/services/task.service.js#L338)) and, when present,
switches the engine into **manual assignment mode**, which bypasses candidate discovery,
eligibility filtering, and cost evaluation entirely (§4.9).

### 2.3 Stage 2-3 — PENDING creation and early response

The task row is created with `status: "PENDING"` and no robot binding
([task.service.js:365-368](Backend/src/services/task.service.js#L365-L368)). This row is
what the HTTP caller receives. `TASK_CREATED` is emitted to the `dashboard` room.

Consequence: **the HTTP 200 carries no information about whether a robot was found.**
The caller learns the outcome only via the subsequent `TASK_UPDATED` socket event or by
polling `GET /api/tasks`.

### 2.4 Stage 4 — Detachment

[task.service.js:376-386](Backend/src/services/task.service.js#L376-L386) wraps the
remainder in `setImmediate` with a `try/catch` that, on any throw, sets the task to
`FAILED` and emits `TASK_UPDATED`. There is no supervision, no timeout on the detached
work, and no record of *why* it failed beyond `logger.error`.

### 2.5 Stages 5-12 — Selection

Fully detailed in §3, §4, §5.

### 2.6 Stage 13 — Reservation and retry

[task.service.js:167-210](Backend/src/services/task.service.js#L167-L210):

```js
const excludeRobotIds = [];
for (let attempt = 0; attempt <= MAX_RESERVATION_RETRIES; attempt++) {   // 0,1,2
  const best = await selectNearestRobot({ prisma, kv, pickup, excludeRobotIds });
  if (!kv) { /* accept without reserving */ break; }
  const ok = await kv.reserveRobot(reservationKey(best.robotId), taskId, 30);
  if (ok) { robotCode = best.robotId; ... break; }
  excludeRobotIds.push(best.robotId);
}
if (!robotCode) throw 409;
```

Constants: `RESERVATION_TTL_SEC = 30`, `MAX_RESERVATION_RETRIES = 2`
([task.service.js:134-136](Backend/src/services/task.service.js#L134-L136)). Maximum
three full selection passes. Each retry re-executes the *entire* selection pipeline —
including a fresh zone lookup, a fresh SQL candidate query, a fresh MGET, and fresh
Mapbox Matrix calls.

### 2.7 Stages 14-16 — Finalization

[_finalizeAssignment, task.service.js:228-330](Backend/src/services/task.service.js#L228-L330).

Pre-transaction checks (lines 229-240):
- Robot row exists → else `"Robot not commissioned"`
- `currentTaskId` null → else `"Robot already has an active task"`
- `isOnline` true → else `` `Robot ${robotCode} is offline` ``
- Resolvable start position (Redis `robot:{id}` → selection `start` → DB row) → else
  `"Robot has no known position"`

Route computation (line 246) runs **inside** the reservation window and before the
transaction. `getRoutesWithDistance`
([task.service.js:69-128](Backend/src/services/task.service.js#L69-L128)) attempts
profiles `driving`, then `walking`, then `cycling`; each profile issues **two** parallel
Directions calls (start→pickup, pickup→drop). Worst case: 6 outbound HTTP requests before
falling back to a 100-point straight-line interpolation.

The transaction (lines 249-272) re-reads the robot inside `tx`, re-checks
`currentTaskId == null` and `status ∈ {IDLE, PAUSED}`, then:
- `Task.robotId`, `Task.status = ASSIGNED`, `Task.distanceMeters = total route metres`
- `Robot.currentTaskId`, `Robot.status = ACTIVE`, `Robot.isOnline = true`, `Robot.lastSeenAt = now`

**`Task.startedAt` is never written by any code path** (verified by repository-wide
search: the only writers of task status are `task.service.js`, `tasks.controller.js`, and
`dtaro.handler.js`, none of which set `startedAt`).

**`TaskStatus.IN_PROGRESS` is never written by any code path.** It is read in three
places as a query filter ([dtaro.handler.js:99](Backend/src/sockets/handlers/dtaro.handler.js#L99),
[taskRecovery.service.js:39](Backend/src/services/taskRecovery.service.js#L39),
[socket.server.js:194](Backend/src/sockets/socket.server.js#L194)) but never assigned.
The observable task lifecycle is therefore **PENDING → ASSIGNED → {COMPLETED | CANCELLED}**
or **PENDING → FAILED**.

### 2.8 Stages 17-21 — Side effects

All post-transaction work is wrapped in individually-swallowing `try/catch` blocks
([task.service.js:279-327](Backend/src/services/task.service.js#L279-L327)) and is
skipped in its entirety when `kv` is falsy:

| Effect | Line | Failure handling |
|---|---|---|
| `robotStateCache.set(ACTIVE)` | 276 | unguarded (in-memory, cannot throw) |
| Seed `taskPath:`, `task:`, `robotTask:`, `robotTaskState:` (TTL 86400) | 280-284 | **not guarded** — a throw here escapes to the `setImmediate` catch and marks an already-committed task `FAILED` |
| `TASK_ASSIGNED` → dashboard | 287-297 | swallowed |
| `TASK_UPDATED` → dashboard | 300-308 | swallowed |
| `updatePlannedPath` + `updateAssignedTask` | 310-314 | swallowed |
| `dispatchTaskAssign` | 316-322 | swallowed — **delivery result is discarded** |
| `recordAllocation` | 324-326 | swallowed |

The `finally` block at [task.service.js:218-225](Backend/src/services/task.service.js#L218-L225)
releases the reservation on every path.

### 2.9 Stages 22-23 — Execution and completion

`TASK_ASSIGN` carries `{ taskId, pickup, drop, pathToPickup, pathToDrop, timestamp }`
([commandDispatcher.service.js:122-124](Backend/src/services/commandDispatcher.service.js#L122-L124)).

`VirtualRobot._onTaskAssign` ([VirtualRobot.js:316-374](Backend/src/simulation/VirtualRobot.js#L316-L374))
snaps to the nearest waypoint of `pathToPickup` and sets phase `TO_PICKUP`. The phase
machine is `TO_PICKUP → WAIT_PICKUP (10 s) → TO_DROP → WAIT_DROP (8 s) → emit TASK_COMPLETE`
([VirtualRobot.js:566-629](Backend/src/simulation/VirtualRobot.js#L566-L629)).

`TASK_COMPLETE` ([dtaro.handler.js:82-137](Backend/src/sockets/handlers/dtaro.handler.js#L82-L137))
marks the task `COMPLETED` with `completedAt`, sets the robot to `IDLE` with
`currentTaskId = null`, deletes `robotTaskState:` and `robotTask:`, and clears
`registry.assignedTaskId`.

**There is no server-side verification that the robot reached the drop coordinates.** The
`updateMany` filter checks only that the task belongs to that robot and is in
`{ASSIGNED, IN_PROGRESS}` ([dtaro.handler.js:95-102](Backend/src/sockets/handlers/dtaro.handler.js#L95-L102)).
Completion is a trusted robot assertion.

---

## 3. Candidate Discovery

### 3.1 The candidate query

[taskAssignment.service.js:77-86](Backend/src/services/taskAssignment.service.js#L77-L86):

```js
const dbCandidates = await prisma.robot.findMany({
  where: {
    status: { in: ["IDLE", "PAUSED"] },
    isOnline: true,
    currentTaskId: null,
    ...(exclude.length > 0 ? { robotId: { notIn: exclude } } : {}),
  },
  select: { robotId, lat, lon, battery, currentTaskId, isOnline, status, zoneId },
  take: maxRobots,   // default 100
});
```

Empty result → `409 "No available IDLE robots"`
([taskAssignment.service.js:88-92](Backend/src/services/taskAssignment.service.js#L88-L92)).

### 3.2 Why the candidate pool is PostgreSQL-sourced

The pool comes from the durable database, not from the Redis live index `robots:all`.
This is significant: `Robot.status` and `Robot.isOnline` are written on a **throttled**
schedule — `DB_FLUSH_INTERVAL_MS = 15_000`
([liveness.constants.js:36](Backend/src/config/liveness.constants.js#L36)) — so the
candidate pool can lag live reality by up to 15 seconds, plus the offline-sweep interval.
The telemetry handler deliberately forces an immediate flush on status transitions
precisely because DTARO filters on these columns
([telemetry.handler.js:333-345](Backend/src/sockets/handlers/telemetry.handler.js#L333-L345)).

### 3.3 The `take: 100` bound

`maxRobots` defaults to `100` and is **never overridden** — `selectNearestRobot` is called
from exactly one place ([task.service.js:174-178](Backend/src/services/task.service.js#L174-L178))
and that call site does not pass `maxRobots`.

The query specifies **no `orderBy`**. With more than 100 eligible robots, PostgreSQL
returns an arbitrary (planner-dependent, not stable) 100-row subset, and the globally
best robot may never be scored. This is a hard correctness ceiling on fleet size for
optimality, addressed further in §15.2.

### 3.4 Status semantics of the candidate pool

`RobotStatus` enum values ([schema.prisma:15-22](Backend/prisma/schema.prisma#L15-L22)):
`IDLE`, `ACTIVE`, `PAUSED`, `OFFLINE`, `ERROR`, `ISSUES`.

| Status | In pool? | Reason |
|---|---|---|
| `IDLE` | **Yes** | Explicitly listed |
| `PAUSED` | **Yes** | Explicitly listed — carries CHARGING robots (§3.5) |
| `ACTIVE` | No | Not in the `in` list |
| `OFFLINE` | No | Not in the `in` list; also `isOnline` false |
| `ERROR` | No | Not in the `in` list — this is where `ROBOT_FAULT` puts a robot ([dtaro.handler.js:154-157](Backend/src/sockets/handlers/dtaro.handler.js#L154-L157)) |
| `ISSUES` | No | Not in the `in` list — this is where a VirtualRobot goes below 20 % battery while ACTIVE ([VirtualRobot.js:736-738](Backend/src/simulation/VirtualRobot.js#L736-L738)) |

### 3.5 The CHARGING / PAUSED encoding

`CHARGING` is not a Prisma enum value. The telemetry handler maps incoming `"CHARGING"`
to DB `"PAUSED"` while preserving the literal `"CHARGING"` in Redis and in the dashboard
broadcast ([telemetry.handler.js:42-49](Backend/src/sockets/handlers/telemetry.handler.js#L42-L49),
[telemetry.handler.js:273-278](Backend/src/sockets/handlers/telemetry.handler.js#L273-L278)).
`"RETURNING"` maps to `"ACTIVE"` by the same mechanism.

Therefore `PAUSED` in the candidate pool is ambiguous: it is either a genuinely paused
robot or a charging robot. The validator resolves the ambiguity using the Redis live
status (§4.4).

### 3.6 Virtual vs. physical robots

There is **no distinction anywhere in the assignment path**. `VirtualRobot` connects as
an ordinary Socket.IO client and performs the identical `AUTH` → `TELEMETRY` → `HEARTBEAT`
flow as physical hardware ([VirtualRobot.js:152-212](Backend/src/simulation/VirtualRobot.js#L152-L212)).
No column, registry field, or query filter marks a robot as simulated. Every commissioned
robot gets a `VirtualRobot` instance automatically on commission
([robots.controller.js:84-98](Backend/src/controllers/robots.controller.js#L84-L98)) and
on server restart ([server.js:173-196](Backend/src/server.js#L173-L196)).

### 3.7 Conditions the pool does *not* test

Established by reading the `where` clause and the validator:

- **Socket connectivity.** `isOnline` is a database column, not a live socket check. A
  robot marked online whose socket is gone remains a candidate until the disconnect
  handler or the 30 s offline sweep runs (§9.4).
- **Registry liveness.** A robot whose `registry:{id}` key has expired (TTL 30 s) is still
  a candidate; the validator falls back to DB values (§6.5).
- **Zone membership.** Zone affects the score, never eligibility.
- **Distance to pickup.** There is no maximum-radius filter. A robot 500 km away is a
  valid candidate and will win if it is the only one.
- **Battery sufficiency for the specific mission.** Only an absolute floor (§4.6).
- **Location or campus scoping.** `Robot.locationId` and `Robot.campusId` exist
  ([schema.prisma:179-183](Backend/prisma/schema.prisma#L179-L183)) and are used for
  listing/filtering in `robot.service.listRobots`, but the DTARO candidate query does not
  reference them. A task can be assigned to a robot at a different campus entirely.

---

## 4. Eligibility Rules

All hard rules live in `validateRobot`
([robotValidator.service.js:35-126](Backend/src/services/robotValidator.service.js#L35-L126)),
invoked per candidate with `{ allowCharging: true, liveState }`
([taskAssignment.service.js:100-108](Backend/src/services/taskAssignment.service.js#L100-L108)).

Rules are evaluated in strict source order; the first failure short-circuits and returns a
reason string. All rejections are collected and passed to `logger.dtaro`
([taskAssignment.service.js:195-200](Backend/src/services/taskAssignment.service.js#L195-L200)).

If **no** candidate passes: `409 "No robots passed eligibility validation"`
([taskAssignment.service.js:114-118](Backend/src/services/taskAssignment.service.js#L114-L118)).

### 4.1 Rule table

| # | Rule | Line | Data source | Fail mode | On failure |
|---|---|---|---|---|---|
| R1 | Robot row must exist | 40 | argument | fail-closed | reject |
| R2 | `robotRow.isOnline === true` | 45-47 | PostgreSQL | fail-closed | reject |
| R3 | Charging robots require `allowCharging` | 62-64 | Redis + PG | fail-closed | reject (never fires in DTARO — always `true`) |
| R4 | Charging robots need battery ≥ `max(threshold, 30)` | 71-83 | Redis → PG → null | **fail-open on null** | reject |
| R5 | Charging robots must have `currentTaskId == null` | 85 | PostgreSQL | fail-closed | reject |
| R6 | Non-charging: `dbStatus === "IDLE"` | 90-92 | PostgreSQL | fail-closed | reject |
| R7 | Non-charging: `currentTaskId == null` | 95-97 | PostgreSQL | fail-closed | reject |
| R8 | Non-charging: battery ≥ 20 | 100-112 | Redis → PG → null | **fail-open on null** | reject |
| R9 | `live.healthStatus !== "FAULT"` | 115-117 | Redis | **fail-open on missing registry** | reject |
| R10 | Socket connected ⟹ `live.authenticated !== false` | 120-123 | in-process Map + Redis | **unreachable** (§4.8) | reject |

### 4.2 R1 — Existence

`if (!robotRow) return { valid: false, reason: "Robot not found" }`. Defensive only;
`dbCandidates` entries are always non-null.

### 4.3 R2 — Online

`robotRow.isOnline` is the PostgreSQL column, already filtered to `true` by the candidate
query, so this rule is redundant in the DTARO path. It is not redundant for other callers
of `validateRobot` — though repository search shows the only production caller is
`taskAssignment.service.js`; the remaining callers are in
`tests/unit/dtaro/robotValidator.test.js`.

### 4.4 Charging determination

[robotValidator.service.js:49-60](Backend/src/services/robotValidator.service.js#L49-L60):

```js
const dbStatus        = String(robotRow.status || "");
const live            = liveState !== undefined ? liveState : await getRobotState(kv, robotId);
const liveStatus      = typeof live?.status === "string" ? live.status : null;
const effectiveStatus = liveStatus || dbStatus;
const isCharging = effectiveStatus === "CHARGING"
                || (dbStatus === "PAUSED" && liveStatus === "CHARGING");
```

The second disjunct is subsumed by the first (if `liveStatus === "CHARGING"` then
`effectiveStatus === "CHARGING"`); it is defensive redundancy.

**Critical consequence:** when the registry entry has expired, `liveStatus` is `null` and
`effectiveStatus` falls back to `dbStatus`. A charging robot whose registry key expired
is therefore evaluated as `PAUSED`, not `CHARGING`, and is rejected by R6 with
`"Robot status is PAUSED, expected IDLE"`. Charging robots are eligible **only while
their registry entry is live**.

### 4.5 R4 — Charging battery floor

```js
const chargingMinBattery = Math.max(batteryThreshold, CHARGING_INTERRUPT_BATTERY);
```

With defaults `batteryThreshold = BATTERY_THRESHOLD = 20` and
`CHARGING_INTERRUPT_BATTERY = 30`
([dtaro.constants.js:12-16](Backend/src/config/dtaro.constants.js#L12-L16)), the effective
floor is **30 %**. The `Math.max` exists so a caller passing a lower `batteryThreshold`
cannot accidentally lower the charge-interrupt floor.

Battery resolution order: `live.battery` → `robotRow.battery` → `null`. **If both are
`null` the check is skipped and the robot passes** (`if (battery !== null && ...)`) —
fail-open.

The charging branch **returns early at line 86**, so R9 (fault) and R10 (auth) are never
evaluated for a charging robot. In practice a faulted robot has DB status `ERROR` and is
excluded by the candidate query, so this is not currently exploitable.

The 30 % floor is mirrored on the robot side: `VirtualRobot._onTaskAssign` defers an
assignment it receives below 30 % rather than discarding it
([VirtualRobot.js:320-336](Backend/src/simulation/VirtualRobot.js#L320-L336)), resuming it
when fully charged ([VirtualRobot.js:466-476](Backend/src/simulation/VirtualRobot.js#L466-L476)).

### 4.6 R8 — General battery floor

`BATTERY_THRESHOLD = 20` %. Same fail-open-on-null semantics as R4. The reason string is
`` `Battery ${battery.toFixed(1)}% is below threshold ${batteryThreshold}%` ``.

This is an **absolute instantaneous floor**, not a mission-feasibility check. A robot at
20.1 % is eligible for a 40 km mission. `BATTERY_DRAIN_ACTIVE = 0.0444 %/tick` at a 2 s
tick ([simulation/constants.js:22](Backend/src/simulation/constants.js#L22)) means
20.1 % supports roughly 11 minutes of driving before hitting the `BATTERY_MIN = 5 %` floor.
No code compares this budget against the mission.

### 4.7 R9 — Fault

`live?.healthStatus === "FAULT"`. Written only by `ROBOT_FAULT`
([dtaro.handler.js:161](Backend/src/sockets/handlers/dtaro.handler.js#L161)) and cleared
only by `POST /api/robots/:robotId/clear-fault`
([robots.controller.js:396](Backend/src/controllers/robots.controller.js#L396)).

Because `ROBOT_FAULT` also sets DB `status = ERROR`, a faulted robot is already excluded
by the candidate query. R9 is defense-in-depth against a divergence between the two writes.

**Fail-open:** if the registry entry is absent, `live` is `null`, the expression is
`undefined === "FAULT"` → `false`, and the robot passes.

### 4.8 R10 — Authentication integrity (unreachable)

```js
const socket = getRobotSocket(robotId);
if (socket && live?.authenticated === false) { ...reject... }
```

Repository-wide search for `authenticated` shows exactly one writer:
[robotRegistry.service.js:178](Backend/src/services/robotRegistry.service.js#L178), inside
`markOnline`, which writes the literal `true`. **No code path ever writes
`authenticated: false`.** `markOffline` writes only `{ connected: false, lastHeartbeat }`
([robotRegistry.service.js:189-194](Backend/src/services/robotRegistry.service.js#L189-L194)).

Therefore `live?.authenticated === false` is never satisfiable and **R10 can never
reject a robot**. It is dead code as implemented.

Secondary limitation: `getRobotSocket` reads a process-local `Map`
([robotSockets.js:5-10](Backend/src/sockets/robotSockets.js#L5-L10)). Under the clustered
deployment the codebase is explicitly written for (Redis Socket.IO adapter,
[server.js:45-67](Backend/server.js#L45-L67)), a robot connected to a different worker
yields `socket === null` and the rule is skipped regardless.

### 4.9 The manual-assignment bypass

When `req.body.robotId` is present, the engine takes
[task.service.js:154-166](Backend/src/services/task.service.js#L154-L166):

```js
if (robotCodeIn) {
  if (kv) {
    const ok = await kv.reserveRobot(reservationKey(robotCodeIn), taskId, 30);
    if (!ok) throw 409;
    reservedRobotCode = robotCodeIn;
  }
  robotCode = robotCodeIn;
}
```

`validateRobot` is **never called**. The only checks applied are the finalization
pre-checks and the transaction guard:

| Check | Applied in manual mode? |
|---|---|
| Robot exists | Yes (line 233) |
| `currentTaskId == null` | Yes (lines 234, 251) |
| `isOnline` | Yes (line 235) |
| Known position | Yes (line 240) |
| `status ∈ {IDLE, PAUSED}` | Yes (lines 253-254) |
| **Battery ≥ 20 %** | **No** |
| **Charging battery ≥ 30 %** | **No** |
| **`healthStatus !== FAULT`** | **No** |
| **Any cost consideration** | **No** |

A manual assignment to a robot at 6 % battery, or one whose registry health is `FAULT`
while its DB status remains `IDLE`, is accepted. There is also **no retry** in manual mode
— a lost reservation race throws `409` and the task becomes `FAILED`.

---

## 5. Complete Cost Function Analysis

### 5.1 Entry point and signature

```js
async function computeCosts(kv, candidates, weights = DEFAULT_WEIGHTS, pickupZoneId = null)
```
([costEvaluator.service.js:67](Backend/src/services/costEvaluator.service.js#L67))

Called as `computeCosts(kv, candidates, costWeights, pickupZoneId)`
([taskAssignment.service.js:183](Backend/src/services/taskAssignment.service.js#L183)).
`costWeights` originates from `selectNearestRobot`'s parameter, which the sole production
call site does not supply — so it is `undefined`, the default parameter engages, and
`DEFAULT_WEIGHTS` is used. **The weights are effectively compile-time constants in
production.** No environment variable, database row, or API surface modifies them.

Empty candidate array returns `[]`
([costEvaluator.service.js:68](Backend/src/services/costEvaluator.service.js#L68)), which
propagates to `best === null` and `502 "Cost evaluation returned no result"`
([taskAssignment.service.js:204-208](Backend/src/services/taskAssignment.service.js#L204-L208)).

### 5.2 The redundant second registry read

[costEvaluator.service.js:73](Backend/src/services/costEvaluator.service.js#L73):

```js
const liveStates = await Promise.all(candidates.map((c) => getRobotState(kv, c.robotId)));
```

This re-fetches registry state that `taskAssignment.service.js` already obtained in a
single pipelined `MGET` at line 98 and did not pass down. The result is **one additional
Redis round-trip per candidate** on every assignment, after the batching optimization was
applied one layer up. Functionally harmless; it does mean the battery and utilization used
for *scoring* are read at a marginally later instant than the battery used for
*eligibility*.

### 5.3 The normalization primitive

[costEvaluator.service.js:35-42](Backend/src/services/costEvaluator.service.js#L35-L42):

```js
function normalize(values) {
  if (!values.length) return [];
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min;
  if (!range) return values.map(() => 0.5);
  return values.map((v) => (v - min) / range);
}
```

Properties that materially affect decisions:

- **Relative, not absolute.** The best candidate always scores exactly `0` and the worst
  exactly `1`, regardless of the underlying spread. Two robots 5 m and 10 m from the
  pickup produce the same `D` vector `[0, 1]` as two robots 5 km and 400 km away. **The
  cost function cannot distinguish "both are close" from "both are far".**
- **Single-candidate degeneracy.** With one candidate, `range === 0`, so `D = T = 0.5`.
- **All-equal degeneracy.** Identical distances yield `0.5` for everyone — a constant
  offset that does not affect the argmin.
- **Outlier compression.** One distant robot compresses all remaining robots into a narrow
  band near 0, effectively neutralizing `D` as a discriminator among them and handing the
  decision to `B` (weight 0.30).
- **`Math.min(...values)` spread.** Uses argument spreading; with `take: 100` this is
  bounded and safe.

### 5.4 D — Distance term (w1 = 0.50)

**Purpose:** proximity of the robot to the pickup point.

**Raw value:** great-circle metres from the robot's overlaid live position to the pickup,
computed unconditionally for every candidate
([taskAssignment.service.js:169](Backend/src/services/taskAssignment.service.js#L169)):

```js
batch[i].distanceM = haversineMeters(batch[i].lat, batch[i].lon, pickupLat, pickupLon);
```

`haversineMeters` uses R = 6 371 000 m
([distance.js:5-13](Backend/src/utils/distance.js#L5-L13)).

**Normalization:** min-max across the candidate set
([costEvaluator.service.js:99](Backend/src/services/costEvaluator.service.js#L99)).

**Data source:** Redis registry position (primary) → PostgreSQL `Robot.lat/lon` (fallback)
([taskAssignment.service.js:127-131](Backend/src/services/taskAssignment.service.js#L127-L131)).

**Failure behavior:** none possible — haversine is pure arithmetic over already-validated
numbers. A candidate with no resolvable position is dropped *before* this stage
([taskAssignment.service.js:131](Backend/src/services/taskAssignment.service.js#L131)),
never reaching the cost function.

**Scope limitation — this is the single most consequential property of the entire cost
function:** `D` measures **only the robot→pickup leg**. The pickup→drop leg is not
included. `dropLat`/`dropLon` are in scope at the call site
([task.service.js:174-178](Backend/src/services/task.service.js#L174-L178) passes only
`pickup`) but are **not passed** into `selectNearestRobot`. The signature has no drop
parameter at all
([taskAssignment.service.js:54](Backend/src/services/taskAssignment.service.js#L54)).
Total mission distance is therefore invisible to the decision, and is only computed
afterwards for storage ([task.service.js:246, 261](Backend/src/services/task.service.js#L246)).

**Straight-line vs. road distance.** `D` is always haversine, never the Mapbox road
distance — even when Mapbox succeeds. The Matrix API is requested with
`annotations=duration` only ([mapbox.service.js:135](Backend/src/services/mapbox.service.js#L135)),
so road distance is never retrieved for candidate scoring. A robot separated from the
pickup by a river or a wall scores identically to one on the same street at equal
crow-flies distance.

### 5.5 B — Battery term (w2 = 0.30)

**Purpose:** prefer better-charged robots.

**Raw value** ([costEvaluator.service.js:82-90](Backend/src/services/costEvaluator.service.js#L82-L90)):

```js
const b = typeof s?.battery === "number" ? s.battery
        : typeof candidates[i].battery === "number" ? candidates[i].battery
        : 100;
return Math.max(0, Math.min(100, b));
```

**Normalization:** *not* min-max. Fixed linear inversion
([costEvaluator.service.js:103](Backend/src/services/costEvaluator.service.js#L103)):

```js
const batteryComponents = batteries.map((b) => 1 - b / 100);
```

This makes `B` the **only term on an absolute scale**. A 100 % robot contributes `0.00`;
a 20 % robot contributes `0.24` (0.30 × 0.80). Consequences:

- `B` retains discriminating power when the candidate set is homogeneous in distance,
  where `D` collapses to a constant 0.5.
- Because `D` is relative and `B` is absolute, the trade-off ratio between them is
  **scale-dependent**. Over a candidate spread of 100 m, moving from best to worst
  distance costs 0.50 — outweighing an 80-point battery gap (0.24). Over a spread of
  50 km, the same 0.50 applies. The engine spends the same distance budget regardless of
  whether the distance difference is operationally trivial or enormous.

**Default when unknown: 100.** A robot with no battery reading anywhere receives the
*best possible* battery score. Combined with R8's fail-open on null (§4.6), an unknown
battery is treated as a full battery throughout.

**Data source:** registry `battery` (written every telemetry tick,
[telemetry.handler.js:442](Backend/src/sockets/handlers/telemetry.handler.js#L442)) →
candidate row `battery` from PostgreSQL.

**Failure behavior:** Redis unavailable → `getRobotState` returns `null`
([robotRegistry.service.js:44-46](Backend/src/services/robotRegistry.service.js#L44-L46))
→ falls to the DB value, which is throttle-flushed on ≥ 2 % swings or every 15 s
([telemetry.handler.js:350-357](Backend/src/sockets/handlers/telemetry.handler.js#L350-L357)).

### 5.6 U — Utilization term (w3 = 0.15)

**Purpose:** prefer robots that have been less busy.

**Raw value** ([costEvaluator.service.js:93-96](Backend/src/services/costEvaluator.service.js#L93-L96)):

```js
const u = typeof s?.utilization === "number" ? s.utilization : 0;
return Math.max(0, Math.min(1, u));
```

**Normalization:** none. Used directly as a 0-1 quantity, absolute scale like `B`.

**Producer** — the sole writer is the telemetry hot path
([telemetry.handler.js:427-448](Backend/src/sockets/handlers/telemetry.handler.js#L427-L448)):

```js
const prevUtil = typeof existing.utilization === "number" ? existing.utilization : 0;
const alpha    = 0.05;
const isActive = fullState.status === "ACTIVE" ? 1 : 0;
const nextUtil = Math.max(0, Math.min(1, prevUtil + alpha * (isActive - prevUtil)));
```

An exponential moving average with α = 0.05, updated once per telemetry frame (2 s for a
`VirtualRobot`, [simulation/constants.js:4](Backend/src/simulation/constants.js#L4)).
Time constant ≈ 20 ticks ≈ 40 s to traverse 63 % of a step.

**What U actually measures.** `isActive` is 1 only when the *raw* live status is exactly
`"ACTIVE"`. `ISSUES`, `CHARGING`, `PAUSED`, `RETURNING`→`ACTIVE`(DB-mapped, but the raw
value `"RETURNING"` is what reaches `fullState.status`) all evaluate to 0. Note that
`fullState.status` carries the **raw** incoming label, not the DB-mapped one
([telemetry.handler.js:273-278](Backend/src/sockets/handlers/telemetry.handler.js#L273-L278)),
so a robot reporting `"RETURNING"` accrues **no** utilization despite being in transit.

**What U means for candidates specifically.** Every candidate is, by construction,
`IDLE` or `PAUSED` with no current task — so none of them are accruing utilization at
scoring time; all are decaying toward 0. `U` therefore acts as a **decaying memory of how
recently the robot finished a task**. A robot that completed a mission 30 s ago carries a
meaningfully higher `U` than one idle for 10 minutes. This is the engine's only
load-balancing mechanism, and it is implicit rather than designed as such.

**Upper bound in practice.** Reaching `U = 1` requires sustained `ACTIVE` status for many
multiples of 40 s. A long mission drives `U` toward 1; the decay back toward 0 while idle
takes a comparable time. The realistic operating band for an idle candidate is roughly
0 to 0.5, contributing at most ~0.075 of cost — **half the term's nominal 0.15 weight is
unreachable in the idle state where it is actually evaluated.**

**Dead code adjacent to this term.** `robotRegistry.updateUtilization`
([robotRegistry.service.js:239-242](Backend/src/services/robotRegistry.service.js#L239-L242))
is exported but never called anywhere in `Backend/src`. Likewise
`robotRegistry.updateTelemetry` ([robotRegistry.service.js:202-211](Backend/src/services/robotRegistry.service.js#L202-L211))
is never called — the telemetry handler writes registry state directly via
`buildMergedRegistryState` for pipelining reasons.

**The PostgreSQL `Robot.utilization` column is never read and never written.** It is
declared ([schema.prisma:188](Backend/prisma/schema.prisma#L188)) and migrated
(`migrations/20260518152516_dtaro_zone_obstacle/migration.sql:2`) but repository-wide
search finds no Prisma read or write of it. **There is no durable fallback for `U`:** if
the registry entry has expired, `U` is 0 with no recovery path — unlike `B`, `lat/lon`,
and `zoneId`, which all have DB mirrors.

### 5.7 T — Travel time term (w4 = 0.05)

**Purpose:** road-network-aware ETA to the pickup, as a corrective on the crow-flies `D`.

**Raw value:** Mapbox Directions Matrix duration in seconds, `driving` profile, from each
candidate origin to the single pickup destination
([mapbox.service.js:121-148](Backend/src/services/mapbox.service.js#L121-L148)).

**Batching** ([taskAssignment.service.js:149-171](Backend/src/services/taskAssignment.service.js#L149-L171)):
candidates are chunked into groups of 24. With one destination appended this yields 25
coordinates per request, the Mapbox Matrix maximum. With the `take: 100` cap, at most 5
Matrix requests are issued per selection attempt, and up to 15 across the 3-attempt retry
loop.

**Normalization:** min-max ([costEvaluator.service.js:100](Backend/src/services/costEvaluator.service.js#L100)),
after nulls are coerced to `0`
([costEvaluator.service.js:79](Backend/src/services/costEvaluator.service.js#L79)).

**Failure behavior — three distinct regimes:**

1. **All batches succeed.** `T` is a genuine relative ETA ranking.

2. **All batches fail.** Every `durationSec` is `null` → coerced to `0` → `range === 0` →
   `normalize` returns `0.5` for every candidate. `T` becomes a **constant offset of
   0.025** and has **zero effect on the argmin**. `usedFallback` is set true
   ([taskAssignment.service.js:161-164](Backend/src/services/taskAssignment.service.js#L161-L164))
   and surfaced on the return value, but nothing downstream consumes it for a decision.
   This is the graceful case.

3. **Partial failure (some batches succeed, some fail).** Failed-batch candidates get
   `durationSec = null → 0`, while successful-batch candidates carry real durations
   (typically 60-600 s). The min-max then maps every failed-batch robot to `normT = 0` —
   the **best achievable travel-time score** — purely because their data is missing.
   Robots in a failed batch receive a systematic scoring advantage of up to
   `w4 × 1 = 0.05`. This is bounded and small relative to `w1 = 0.50`, but it is a real
   directional bias introduced by a partial upstream outage. Whether a batch fails is
   independent of robot quality (it depends on which chunk index the robot landed in),
   so the bias is effectively arbitrary.

**Weight rationale as implemented:** at 0.05, `T` is a tiebreaker. Even a maximal
disagreement between `D` and `T` (nearest-by-crow-flies is slowest-by-road) cannot
overturn `D`, since `0.50 × Δ D` dominates `0.05 × Δ T` for any equal normalized delta.
`T` can only decide between candidates already near-tied on `D` and `B`.

**Observability artifact.** `best.durationSec` is echoed from the cost result, where nulls
were already coerced to 0. A total Matrix failure therefore surfaces to the caller as
`durationSec: 0` rather than `null`
([taskAssignment.service.js:214](Backend/src/services/taskAssignment.service.js#L214)).
This is asserted as characterization in
[tests/unit/dtaro/taskAssignment.test.js:83-91](Backend/tests/unit/dtaro/taskAssignment.test.js#L83-L91).
`task.service.js` does not consume the field.

### 5.8 Z — Zone-locality term (w5 = 0.05)

**Purpose:** prefer a robot already operating in the pickup's zone.

**Raw value** ([costEvaluator.service.js:108-111](Backend/src/services/costEvaluator.service.js#L108-L111)):

```js
const zoneComponents = candidates.map((c) => {
  if (!pickupZoneId) return 0;
  return c.zoneId && c.zoneId === pickupZoneId ? 0 : 1;
});
```

Binary, no normalization. Neutral (0 for all) whenever the pickup's zone cannot be
resolved, so a zone-less deployment is unaffected.

**Weight semantics.** `w5` is **additive on top of a w1..w4 budget that already sums to
1.0** — the docstring states this explicitly
([costEvaluator.service.js:15-21](Backend/src/services/costEvaluator.service.js#L15-L21)).
Maximum achievable cost is therefore **1.05**, not 1.0. This is intentional: `Z` nudges
ranking without re-tuning the original four-term formula.

**Candidate zone source** ([taskAssignment.service.js:138](Backend/src/services/taskAssignment.service.js#L138)):

```js
zoneId: typeof live?.zoneId === "string" ? live.zoneId : (r.zoneId || null),
```

Registry (per-tick, [telemetry.handler.js:447](Backend/src/sockets/handlers/telemetry.handler.js#L447))
→ PostgreSQL `Robot.zoneId` (written only on an actual zone crossing,
[zoneManager.service.js:191-194](Backend/src/services/zoneManager.service.js#L191-L194)).

**Pickup zone source** ([taskAssignment.service.js:72-73](Backend/src/services/taskAssignment.service.js#L72-L73)):
`getZoneForCoordinates(prisma, kv, pickupLat, pickupLon)`.

**Zone geometry** ([zoneManager.service.js:93-99](Backend/src/services/zoneManager.service.js#L93-L99)):

```js
zones.find((z) => lat >= z.minLat && lat <= z.maxLat && lon >= z.minLon && lon <= z.maxLon)
```

Axis-aligned lat/lon bounding boxes; **first match wins**, with a comment noting zones
"should not overlap" — but no constraint enforces non-overlap in the schema
([schema.prisma:238-251](Backend/prisma/schema.prisma#L238-L251)). Ordering is
`{ name: "asc" }` ([zoneManager.service.js:55](Backend/src/services/zoneManager.service.js#L55)),
so with overlapping zones the alphabetically-first name wins deterministically.

**Default seeding** ([zoneManager.service.js:223-267](Backend/src/services/zoneManager.service.js#L223-L267)):
4 quadrants around the first campus centre with `delta = 0.005` (~550 m), producing four
~1.1 km × 1.1 km boxes. Idempotent — skipped entirely if any zone already exists. Invoked
once at startup ([socket.server.js:128-135](Backend/src/sockets/socket.server.js#L128-L135)).

**Coverage gap:** the four quadrants cover only ±1.1 km around the campus centre. Any
pickup outside that box resolves to `null`, and `Z` becomes 0 for all candidates —
silently disabling the term.

**Caching** ([zoneManager.service.js:31-65](Backend/src/services/zoneManager.service.js#L31-L65)):
in-process 60 s → Redis `zones:all` 300 s → PostgreSQL. Errors at any tier fall through;
a total failure returns `[]`, which yields `pickupZoneId = null` and a neutral `Z`.

### 5.9 Worked example

Three candidates; pickup zone `Z-NE` resolved.

| Robot | dist (m) | dur (s) | batt (%) | util | zone |
|---|---|---|---|---|---|
| R1 | 200 | 90 | 55 | 0.30 | Z-NE |
| R2 | 800 | 150 | 95 | 0.00 | Z-NW |
| R3 | 1400 | 240 | 88 | 0.05 | Z-NE |

Normalization: `normD = [(200−200)/1200, (800−200)/1200, (1400−200)/1200] = [0, 0.5, 1]`;
`normT = [0, 0.4, 1]`.
`B = [0.45, 0.05, 0.12]`. `U = [0.30, 0, 0.05]`. `Z = [0, 1, 0]`.

```
C(R1) = 0.50(0)   + 0.30(0.45) + 0.15(0.30) + 0.05(0)   + 0.05(0) = 0.1800
C(R2) = 0.50(0.5) + 0.30(0.05) + 0.15(0)    + 0.05(0.4) + 0.05(1) = 0.3350
C(R3) = 0.50(1)   + 0.30(0.12) + 0.15(0.05) + 0.05(1)   + 0.05(0) = 0.5935
```

**R1 wins.** Note that R1 wins despite having the *worst* battery and the *highest*
utilization, because `w1 = 0.50` on a normalized-to-zero distance dominates. This is the
characteristic behavior of the function: **distance is decisive whenever the candidate
set has meaningful distance spread.**

To make R2 win, R1's battery would need to fall to roughly 15 % — below the eligibility
floor. In practice, **within the eligible set, the nearest robot wins the overwhelming
majority of the time**, and `B`/`U`/`T`/`Z` matter only among near-equidistant candidates.

### 5.10 Tie-breaking

[taskAssignment.service.js:185](Backend/src/services/taskAssignment.service.js#L185):

```js
costResults.reduce((a, b) => (a.cost <= b.cost ? a : b))
```

`<=` means the **earlier array element is retained** on an exact tie. Array order is
`candidates` order, which is `eligible` order, which is `dbCandidates` order, which is the
PostgreSQL row order of an **unordered** query. Ties are therefore broken by an arbitrary
but locally-stable database ordering, not by any operational criterion.

Costs are rounded to 6 decimal places before comparison
([costEvaluator.service.js:123](Backend/src/services/costEvaluator.service.js#L123)),
making exact ties reachable in practice — notably in the degenerate cases of §5.3
(single candidate, or all-equal distances with equal battery/utilization/zone).

### 5.11 Term interaction summary

| Term | Scale | Weight | Max contribution | Effective range in practice |
|---|---|---|---|---|
| D | relative (min-max) | 0.50 | 0.500 | full 0-0.50, always spans the set |
| B | absolute (1 − b/100) | 0.30 | 0.300 | 0-0.24 (eligibility floors b at 20) |
| U | absolute (EMA 0-1) | 0.15 | 0.150 | ~0-0.075 (idle candidates decay) |
| T | relative (min-max) | 0.05 | 0.050 | 0-0.05, or constant 0.025 on total Mapbox failure |
| Z | binary | 0.05 | 0.050 | 0 or 0.05, or constant 0 with no zones |

**Dominance ordering: D ≫ B > U > T ≈ Z.** The two relative terms (`D`, `T`) always
consume their full weight range across the candidate set; the three absolute terms
(`B`, `U`, `Z`) contribute only what their actual values dictate.

---

## 6. Live Data Usage

### 6.1 Source-of-truth matrix per decision input

| Input | Primary | Fallback | Final fallback | Read at |
|---|---|---|---|---|
| Candidate pool | PostgreSQL `Robot` | — | — | taskAssignment.service.js:77 |
| Robot position | Redis `registry:{id}.lat/lon` | PG `Robot.lat/lon` | drop candidate | taskAssignment.service.js:127-131 |
| Battery (eligibility) | Redis `registry:{id}.battery` | PG `Robot.battery` | `null` → **pass** | robotValidator.service.js:100-105 |
| Battery (scoring) | Redis `registry:{id}.battery` | candidate row `battery` | `100` | costEvaluator.service.js:82-90 |
| Live status | Redis `registry:{id}.status` | PG `Robot.status` | `""` | robotValidator.service.js:54-57 |
| Health status | Redis `registry:{id}.healthStatus` | — | `undefined` → **pass** | robotValidator.service.js:115 |
| Utilization | Redis `registry:{id}.utilization` | — | `0` | costEvaluator.service.js:93-95 |
| Robot zone | Redis `registry:{id}.zoneId` | PG `Robot.zoneId` | `null` | taskAssignment.service.js:138 |
| Pickup zone | in-process cache | Redis `zones:all` | PG `Zone` | zoneManager.service.js:31-65 |
| Travel duration | Mapbox Matrix | — | `null` → `0` | taskAssignment.service.js:156-160 |
| Distance | computed (haversine) | — | — | taskAssignment.service.js:169 |
| Socket presence | in-process `Map` | — | — | robotSockets.js:7-10 |
| Finalize position | Redis `robot:{id}` | selection `start` | PG `Robot.lat/lon` | task.service.js:237-239 |
| Route geometry | Mapbox Directions ×3 profiles | straight-line 100 pts | throw 502 | task.service.js:79-127 |

### 6.2 Two distinct Redis key namespaces

The codebase maintains **two overlapping live-state keys per robot**, written by the same
telemetry tick but consumed by different subsystems:

| Key | TTL | Fields | Written | Read by |
|---|---|---|---|---|
| `robot:{id}` | 15 s | `lat, lon, battery, status, speed, lastSeenAt, distanceTravelled` | telemetry.handler.js:316-328 | `task.service.readRobotLive` (finalize position), `taskRecovery`, `robots.controller` list overlays |
| `registry:{id}` | 30 s | `lat, lon, battery, status, speed, zoneId, utilization, plannedPath, healthStatus, authenticated, connected, assignedTaskId, lastHeartbeat, socketId, updatedAt` | telemetry.handler.js:450 | **the entire DTARO decision path** |

`REGISTRY_TTL = 30` ([robotRegistry.service.js:19](Backend/src/services/robotRegistry.service.js#L19)).
The `robot:{id}` key uses `{ ex: 15 }` inline.

The **selection path reads `registry:`; the finalization path reads `robot:`**
([task.service.js:13-21](Backend/src/services/task.service.js#L13-L21)). These can
disagree: `robot:` expires at 15 s while `registry:` survives to 30 s, so in the 15-30 s
window after a robot stops reporting, selection still sees a live position while
finalization falls back to `start` (carried from the selection result) and then to the DB.

### 6.3 Registry write path — batched pipeline

The telemetry handler collapses all per-tick Redis I/O into one read pipeline and one
write pipeline ([telemetry.handler.js:230-238](Backend/src/sockets/handlers/telemetry.handler.js#L230-L238),
[telemetry.handler.js:487-489](Backend/src/sockets/handlers/telemetry.handler.js#L487-L489)).
Reads: `robot:{id}`, `snapshotState:{id}`, `registry:{id}`, `vr:batteryPersistAt:{id}`.
Writes: `robot:{id}`, `registry:{id}`, conditionally `snapshotState:{id}`,
`vr:battery:{id}`, `vr:batteryPersistAt:{id}`.

`kv.pipeline()` is explicitly **not** a `MULTI` transaction
([kv.js:325-333](Backend/src/cache/kv.js#L325-L333)) — commands may partially apply on a
connection error. There is no cross-key atomicity for registry state.

### 6.4 PostgreSQL write throttling

`Robot` row writes are gated ([telemetry.handler.js:346-357](Backend/src/sockets/handlers/telemetry.handler.js#L346-L357)).
A flush occurs only when **any** of:

- status transition (`statusChanged`)
- `isOnline` false → true (`reconnected`)
- battery delta ≥ 2 % since last flush (`batteryChanged`)
- 15 s elapsed since last flush (`timeDue`)

**Movement alone never forces a flush** — explicitly documented at
[telemetry.handler.js:341-343](Backend/src/sockets/handlers/telemetry.handler.js#L341-L343).
`Robot.lat/lon` can therefore be up to 15 s stale. At the simulator's ~5.56 m/s cruise
speed ([simulation/constants.js:12](Backend/src/simulation/constants.js#L12)) that is
**~83 m of positional error** in the DB fallback path.

`HEARTBEAT` writes `Robot.lastSeenAt` under the same 15 s gate
([robot.handler.js:273-288](Backend/src/sockets/handlers/robot.handler.js#L273-L288)),
after writing the live signal to Redis on every beat.

### 6.5 The registry-expiry cliff

If a robot emits no telemetry for 30 s, `registry:{id}` expires and every registry-sourced
input degrades simultaneously:

| Input | Behavior after expiry |
|---|---|
| Position | DB `Robot.lat/lon`, up to 15 s + sweep-interval stale |
| Battery (eligibility) | DB `Robot.battery` |
| Battery (scoring) | candidate row `battery` |
| Live status | falls back to `dbStatus` — **a CHARGING robot now reads as PAUSED and is rejected by R6** (§4.4) |
| `healthStatus` | `undefined` → **fault check passes (fail-open)** |
| `utilization` | `0` → **best possible U score, no DB fallback exists** |
| `zoneId` | DB `Robot.zoneId`, written only on zone crossings |
| `authenticated` | `undefined` → R10 passes (already unreachable) |

A robot that has been silent for 30 s but is still `isOnline: true` in the DB (the offline
sweep runs every 10 s with a 30 s cutoff, so this window exists) is therefore evaluated
with **the most favourable utilization score and no fault check**, while its position is
up to ~83 m stale.

### 6.6 In-process caches

| Cache | File | Scope | Invalidation |
|---|---|---|---|
| `robotStateCache` | cache/robotStateCache.js | per-process `Map`, unbounded | seeded at AUTH; updated by every writer of `Robot.status/isOnline/lat/lon/battery`; deleted on decommission and on Prisma `P2025` |
| `localZoneCache` | zoneManager.service.js:22-23 | per-process, 60 s TTL | `invalidateZoneCache` on zone seeding |
| `lastDbFlushAt` | telemetry.handler.js:33 | per-process, unbounded | never pruned |
| `lastTelemetryLogAt` | telemetry.handler.js:40 | per-process, unbounded | never pruned |
| `lastHeartbeatDbFlushAt` | robot.handler.js:26 | per-process | opportunistically pruned above 50 000 entries (robot.handler.js:282-286) |
| `robotSockets` | sockets/robotSockets.js:5 | per-process `Map` | on disconnect |

`robotStateCache` is **not** consulted by the assignment path — DTARO reads PostgreSQL
directly. It exists solely to keep the telemetry hot path off the DB.

### 6.7 Synchronization guarantees

There are **none** in the strict sense. Specifically:

- No distributed transaction spans Redis and PostgreSQL. The assignment transaction
  ([task.service.js:249-272](Backend/src/services/task.service.js#L249-L272)) commits to
  PostgreSQL; the Redis task-state seeding
  ([task.service.js:280-284](Backend/src/services/task.service.js#L280-L284)) happens
  after and can fail independently.
- `kv.pipeline()` provides no atomicity (§6.3).
- `mergeRobotState` / `buildMergedRegistryState` perform a read-modify-write with **no
  optimistic concurrency control** ([robotRegistry.service.js:87-117](Backend/src/services/robotRegistry.service.js#L87-L117)).
  Two concurrent writers to the same `registry:{id}` key last-write-wins. In practice one
  socket owns a given robot so contention is low, but the zone side-effect path and the
  telemetry path can interleave.
- Redis is the *declared* authority for live state, PostgreSQL for durable state, and the
  reconciliation is one-directional and best-effort in both the offline sweep
  ([socket.server.js:102-114](Backend/src/sockets/socket.server.js#L102-L114)) and the
  zone mirror ([zoneManager.service.js:190-197](Backend/src/services/zoneManager.service.js#L190-L197)).

---

## 7. Reservation System

### 7.1 Why it exists

Selection and finalization are separated by an unbounded amount of I/O (up to 6 Mapbox
Directions calls, §2.7). Two tasks created milliseconds apart would both run
`selectNearestRobot`, both observe the same `currentTaskId: null` robot, and both proceed
to bind it. The reservation closes that window.

The rationale is stated in the code
([task.service.js:130-133](Backend/src/services/task.service.js#L130-L133)) as protecting
against both the concurrent-claim race and against a reservation being held forever.

### 7.2 Mechanism

Key: `` `robotReserve:${robotId}` `` ([task.service.js:136](Backend/src/services/task.service.js#L136)).
Value: the `taskId`. TTL: 30 s.

[kv.js:419-445](Backend/src/cache/kv.js#L419-L445):

```js
async reserveRobot(key, value, ttlSec) {
  const ex = /* validated */ 30;
  if (redisAvailable && redis) {
    try {
      const res = await redis.set(key, value, "EX", ex, "NX");
      return res === "OK";
    } catch (e) { disableRedis(e); /* falls through to the guard below */ }
  }
  if (redisConfigured) {
    const err = new Error("Reservation lock unavailable: ...");
    err.status = 503; err.code = "LOCK_UNAVAILABLE";
    throw err;
  }
  if (memoryGet(key) !== null) return false;
  memorySet(key, value, { ex });
  return true;
}
```

### 7.3 Atomicity

`SET key value EX 30 NX` is a single Redis command and therefore atomic across all
clients and all worker processes. This is a genuine distributed mutex for the duration of
the TTL.

### 7.4 What the reservation does *not* guarantee

The database transaction is **not** a substitute for the lock. Inside
[task.service.js:249-272](Backend/src/services/task.service.js#L249-L272):

```js
const cur = await tx.robot.findUnique({ where: { id: robotRow.id }, select: { status, currentTaskId } });
if (cur?.currentTaskId) throw new Error("Robot already has an active task");
if (!assignable.has(String(cur?.status || ""))) throw new Error("Robot is not available for assignment");
await tx.task.update({ ... });
await tx.robot.update({ where: { id: robotRow.id }, data: { currentTaskId: t.id, status: "ACTIVE", ... } });
```

Prisma interactive transactions run at the PostgreSQL default isolation level,
**READ COMMITTED**, unless overridden — and no `isolationLevel` option is passed. Under
READ COMMITTED, two concurrent transactions can both execute the `findUnique` and both
observe `currentTaskId: null`. The subsequent `UPDATE` statements serialize on the row
lock, so the second transaction blocks and then overwrites the first's binding with a
**different** `taskId`.

The `@unique` constraint on `Robot.currentTaskId`
([schema.prisma:207](Backend/prisma/schema.prisma#L207)) does **not** prevent this: it
enforces that a given *task* is the current task of at most one robot, not that a robot
has at most one task. Two different task IDs written to the same robot row sequentially
violate no constraint.

**Conclusion: the Redis reservation is the only real mutual-exclusion mechanism for robot
assignment.** The transaction's checks are a consistency assertion that catches
sequentially-ordered conflicts, not a concurrency guard.

### 7.5 Fail-closed policy

The `redisConfigured` guard ([kv.js:18](Backend/src/cache/kv.js#L18)) distinguishes:

- **Redis never configured** (`REDIS_URL` empty or `REDIS_ENABLED=false`) — deployment is
  explicitly single-process, so the in-memory `Map` lock is correct and is used.
- **Redis configured but unreachable** — throwing `503 LOCK_UNAVAILABLE` rather than
  silently degrading to a process-local lock. The reasoning is documented at
  [kv.js:405-418](Backend/src/cache/kv.js#L405-L418): two degraded replicas would each
  grant the same robot, reintroducing double-assignment precisely in the multi-instance
  deployment where it matters.

Operational consequence: **a Redis outage in a configured deployment halts all automatic
assignment.** Every task created during the outage throws at
[task.service.js:189](Backend/src/services/task.service.js#L189), propagates to the
`setImmediate` catch, and is marked `FAILED` terminally with no requeue
([task.service.js:379-385](Backend/src/services/task.service.js#L379-L385)). Tasks are
**not** queued and retried as the fail-closed comment's premise ("orders queue and are
retried") suggests — no such queue exists in this repository.

This behavior is directly covered by
[tests/unit/redis/lockFailClosed.test.js](Backend/tests/unit/redis/lockFailClosed.test.js).

### 7.6 Release

[task.service.js:218-225](Backend/src/services/task.service.js#L218-L225) — a `finally`
block on `_processAssignment`, so it runs on success, on throw, and on the manual path.

`releaseReservation` is a plain `kv.del` with **no ownership check**
([kv.js:454-456](Backend/src/cache/kv.js#L454-L456)). The justification given is that
callers only release keys they successfully reserved. This holds for the current single
call site. It is deliberately lenient — it does not fail closed — because it executes
inside a `finally` and a throw there would mask the original error.

**Ownership-check gap:** if a reservation's 30 s TTL expires mid-finalization and a
*second* task then reserves the same robot, the first task's `finally` will `DEL` the
second task's reservation. The second task then proceeds with no lock held. This requires
finalization to exceed 30 s — plausible given up to 6 sequential-profile Mapbox Directions
round-trips plus a transaction. **No code detects or prevents this.**

### 7.7 Retry and starvation

The retry loop (§2.6) tries at most 3 candidates. Behavior on exhaustion:
`409 "No robot could be reserved for assignment (all candidates claimed concurrently)"`
→ task `FAILED`.

Anti-starvation properties present:
- Reservations always expire (30 s TTL) — no permanent deadlock.
- Reservations are always released in a `finally` — no orphan on normal error paths.
- Each retry **excludes** the previously-contended robot, so the loop cannot spin on the
  same candidate.

Anti-starvation properties absent:
- No backoff between retries — the three attempts execute back-to-back.
- No fairness or aging: a task that loses three races is failed, not requeued behind the
  winners.
- No priority: an older PENDING task has no precedence over a newer one.

### 7.8 Reservation edge cases

| Case | Behavior | Where |
|---|---|---|
| Process crash between reserve and release | TTL expires after 30 s | kv.js:420 |
| Reservation held while robot goes offline | Not detected; finalization's `isOnline` check rejects at task.service.js:235 | — |
| Reservation held while robot's battery drops below 20 % | **Not re-checked.** Validation ran before reservation; finalization does not re-validate battery | task.service.js:229-240 |
| Manual assignment reservation lost | Immediate `409`, no retry | task.service.js:159-163 |
| `kv` falsy | Reservation entirely skipped, robot accepted unguarded | task.service.js:180-187 |
| Reservation succeeds, finalization throws | `finally` releases; task marked `FAILED` | task.service.js:218-225, 379-385 |
| TTL expires mid-finalization | No detection; possible cross-release (§7.6) | — |

---

## 8. Task Dispatch

### 8.1 Dispatch mechanism

`dispatchTaskAssign(io, robotCode, payload)`
([task.service.js:317-321](Backend/src/services/task.service.js#L317-L321)) →
[commandDispatcher.service.js:122-124](Backend/src/services/commandDispatcher.service.js#L122-L124)
→ generic `dispatch`
([commandDispatcher.service.js:75-113](Backend/src/services/commandDispatcher.service.js#L75-L113)).

Delivery is **room-based**, not socket-map-based. The robot joins `robot:{robotId}` at
AUTH ([robot.handler.js:208](Backend/src/sockets/handlers/robot.handler.js#L208)), and
dispatch uses `io.in(room).fetchSockets()` for presence and `io.to(room).emit()` for
delivery. Both are adapter-aware, so they traverse worker processes via the Redis
Socket.IO adapter ([server.js:56](Backend/server.js#L56)). The rationale — that
`getRobotSocket`'s local `Map` is invisible across workers — is documented at
[commandDispatcher.service.js:5-20](Backend/src/services/commandDispatcher.service.js#L5-L20).

### 8.2 Server-to-robot event catalogue

| Event | Emitter | Retries | ACK expected | Robot handler |
|---|---|---|---|---|
| `TASK_ASSIGN` | task.service.js:317, server.js:221 | 2 (1 s, 2 s) | **No** | VirtualRobot.js:196 |
| `REROUTE_ALERT` | task.service.js:482, alertDissemination.service.js:101 | 1 | No | VirtualRobot.js:197 |
| `COMMAND` | robots.controller.js:570 | 0 | **Yes** (`COMMAND_ACK`) | VirtualRobot.js:204 |
| `STOP` | tasks.controller.js:112 | 0 | No | VirtualRobot.js:208 |
| `RETURN_TO_BASE` | (legacy, no server emitter found) | — | No | VirtualRobot.js:211 |

`MAX_RETRIES = 2`, `RETRY_BASE_MS = 1000`
([commandDispatcher.service.js:36-37](Backend/src/services/commandDispatcher.service.js#L36-L37)).
Backoff is `RETRY_BASE_MS * (attempt + 1)` → 1 s then 2 s. Retries fire **only when the
room is empty**; a successful `emit` returns immediately.

Operator-initiated dispatches pass `retries: 0` deliberately, because they run inside an
HTTP request the caller is blocked on
([commandDispatcher.service.js:26-31](Backend/src/services/commandDispatcher.service.js#L26-L31)).

### 8.3 The absence of a TASK_ASSIGN acknowledgement

This is the most consequential property of the dispatch stage.

`dispatch` returns `{ dispatched, socketId, attempts }`. At the `TASK_ASSIGN` call site:

```js
try {
  await dispatchTaskAssign(io, robotCode, { ... });
} catch { /* non-critical */ }
```
([task.service.js:316-322](Backend/src/services/task.service.js#L316-L322))

**The return value is discarded and the throw is swallowed.** Consequently:

- The task is already `ASSIGNED` and the robot already bound to it in PostgreSQL
  (committed at line 272) **before** dispatch is attempted.
- If the robot is not in the room after 3 attempts (~3 s), `dispatched: false` is returned
  and ignored. The task remains `ASSIGNED` indefinitely.
- There is **no application-level acknowledgement** that the robot received, parsed, or
  accepted the assignment. The Socket.IO transport ACK is not used
  (`emit` is called with no callback).
- **A robot cannot reject a task.** There is no `TASK_REJECT` event in the codebase; the
  only robot-originated task events are `TASK_COMPLETE`, `OBSTACLE_REPORT`, and
  `ROBOT_FAULT` ([dtaro.handler.js](Backend/src/sockets/handlers/dtaro.handler.js)).

The only recovery for a silently-dropped `TASK_ASSIGN` is a **server restart**, which
re-dispatches all `ASSIGNED`/`IN_PROGRESS` tasks 5 s after re-hydration
([server.js:201-250](Backend/server.js#L201-L250)).

### 8.4 The one robot-side deferral mechanism

`VirtualRobot._onTaskAssign` is the sole place where an assignment can be *held* rather
than executed ([VirtualRobot.js:320-336](Backend/src/simulation/VirtualRobot.js#L320-L336)):
a `CHARGING` robot below `CHARGING_INTERRUPT_BATTERY = 30` stores the payload in
`_pendingResume` and replays it once fully charged
([VirtualRobot.js:466-476](Backend/src/simulation/VirtualRobot.js#L466-L476)).

**The server is never informed of this deferral.** The task sits at `ASSIGNED` for the
full charge duration (from 10 % to 100 % at `CHARGING_RATE_PER_TICK = 0.10 %/tick` on a
2 s tick ≈ **30 minutes**), and no timeout, alert, or reassignment fires.

### 8.5 Task cancellation

`POST /api/tasks/:taskId/cancel`
([tasks.controller.js:47-148](Backend/src/controllers/tasks.controller.js#L47-L148)).

Flow:
1. Terminal-state short-circuit for `COMPLETED`/`FAILED`/`CANCELLED` (idempotent, returns
   the existing task).
2. Transaction: task → `CANCELLED`; if `robot.currentTaskId === task.id`, robot →
   `{ currentTaskId: null, status: "IDLE" }` and `releasedRobotCode` is set.
3. Gated on `releasedRobotCode`: `dispatchStop`, deletion of `taskPath:`, `task:`,
   `robotTaskState:`, `robotTask:`, clearing of registry `assignedTaskId` and
   `plannedPath`, and a `TASK_UPDATED` dashboard emit.

The room-based `dispatchStop` is used specifically so cancellation reaches the robot
regardless of which worker owns its connection
([tasks.controller.js:108-110](Backend/src/controllers/tasks.controller.js#L108-L110)).

**Race with in-flight assignment.** If a task is cancelled while it is `PENDING` and
`_processAssignment` is still running in the background:
- `task.robotId` is still `null`, so `releasedRobotCode` stays `null` and **none** of the
  step-3 cleanup runs.
- `_finalizeAssignment` subsequently executes
  `tx.task.update({ where: { taskId }, data: { status: "ASSIGNED", ... } })`
  ([task.service.js:256-264](Backend/src/services/task.service.js#L256-L264)) with **no
  check of the task's current status**, overwriting `CANCELLED` back to `ASSIGNED`.
- The robot is bound, `TASK_ASSIGN` is dispatched, and the robot executes a task the
  operator cancelled.

This race is not guarded anywhere in the repository. `_finalizeAssignment` never re-reads
`Task.status`.

### 8.6 Robot offline and disconnect

`disconnect` handler
([robot.handler.js:298-338](Backend/src/sockets/handlers/robot.handler.js#L298-L338)):
- Verifies this socket is still the current one (DB `socketId` match and local map match)
  to avoid clobbering a newer connection.
- `markRobotOffline`: `Robot.isOnline = false`, `status = "OFFLINE"`, `socketId = null`.
- `markOffline(kv, ...)`: registry `connected: false`.
- `kv.srem("robots:all", robotId)`.
- `robot_offline` → dashboard.

**What it does not do:**
- Does **not** clear `Robot.currentTaskId`.
- Does **not** change the task's status.
- Does **not** trigger reassignment.

A robot that disconnects mid-mission leaves its task at `ASSIGNED` and remains bound to it
permanently. Because `currentTaskId` is non-null, the robot is also excluded from all
future candidate queries even after it reconnects — until a `TASK_COMPLETE` arrives, the
task is cancelled, or an operator intervenes.

### 8.7 Reconnection

`AUTH` accepts either a valid `session:{robotId}` token (reconnect path) or a
`pairing:{robotId}` code ([robot.handler.js:150-177](Backend/src/sockets/handlers/robot.handler.js#L150-L177)).
Brute-force lockout after `PAIRING_LOCKOUT_THRESHOLD = 5` failed pairing attempts, with a
`PAIRING_LOCKOUT_TTL_SEC = 3600` lockout keyed by `robotId` (survives socket churn),
clearable via `POST /api/robots/:robotId/pairing/unlock`.

`markRobotOnline` sets `isOnline: true`, `socketId`, `lastSeenAt` — but **not `status`**
([robot.handler.js:28-39](Backend/src/sockets/handlers/robot.handler.js#L28-L39)). A robot
reconnecting after a disconnect therefore remains `status: "OFFLINE"` in the DB until a
telemetry frame transitions it. `TRANSITIONS.OFFLINE` permits `IDLE`, `ACTIVE`, `ERROR`,
`ISSUES`, `PAUSED`, `CHARGING`
([telemetry.handler.js:22](Backend/src/sockets/handlers/telemetry.handler.js#L22)), so the
first telemetry tick (2 s later for a VirtualRobot) restores it.

**During that window the robot is not a DTARO candidate** (status `OFFLINE` is not in
`{IDLE, PAUSED}`). No task is lost as a result; the robot is simply skipped.

### 8.8 Restart re-dispatch

Two independent mechanisms run at boot:

1. **`recoverActiveTasks`** ([taskRecovery.service.js:34-96](Backend/src/services/taskRecovery.service.js#L34-L96)),
   invoked at [server.js:94](Backend/server.js#L94). For every `ASSIGNED`/`IN_PROGRESS`
   task: reads the robot's last position (Redis `robot:{id}` preferred over DB),
   recomputes both route legs from that position via `getRoutesWithDistance`, re-adds the
   robot to `robots:all`, and re-seeds `taskPath:`, `robotTask:`, `robotTaskState:`.
   Route failure → `continue` (task skipped, remains `ASSIGNED` with no Redis state).

2. **Re-dispatch loop** ([server.js:201-250](Backend/server.js#L201-L250)), on a fixed
   5 s `setTimeout` after re-hydration. Re-emits `TASK_ASSIGN` from the seeded
   `taskPath:{taskId}` and re-emits `TASK_ASSIGNED` to the dashboard.

The 5 s delay is a fixed heuristic for VirtualRobots to connect and authenticate — there
is no readiness check. A robot that takes longer than 5 s to authenticate misses its
re-dispatch, and `dispatch`'s 3-attempt/3-second retry window is the only additional
margin.

**Note:** `recoverActiveTasks` always seeds `robotTaskState` with `phase: "TO_PICKUP"`,
`pathIndex: 0` ([taskRecovery.service.js:18-29](Backend/src/services/taskRecovery.service.js#L18-L29)),
regardless of how far the robot had progressed. A robot that was on the `toDrop` leg is
re-routed back to the pickup. `VirtualRobot._onTaskAssign` snaps to the nearest waypoint
of the *newly computed* `pathToPickup`, which starts at the robot's current position
([VirtualRobot.js:353-369](Backend/src/simulation/VirtualRobot.js#L353-L369)) — so the
robot resumes without backtracking geometrically, but it will drive to the pickup again
and repeat the pickup wait before proceeding to the drop.

---

## 9. Failure Analysis

Each scenario below states the trigger, the code path, the observable outcome, and whether
the behavior is fail-open (assignment proceeds) or fail-closed (assignment halts).

### 9.1 Redis unavailable — configured but unreachable

**Path:** `kv.reserveRobot` → `redisAvailable === false` → `redisConfigured === true` →
throws `503 LOCK_UNAVAILABLE` ([kv.js:432-440](Backend/src/cache/kv.js#L432-L440)).

**Preceding stages still run:** `selectNearestRobot` receives a truthy `kv` (the facade
object always exists), so it proceeds. `getManyRobotStates` catches and returns an empty
`Map` ([robotRegistry.service.js:149-151](Backend/src/services/robotRegistry.service.js#L149-L151));
every candidate is validated and scored purely from PostgreSQL values, with `U = 0` for
all and `healthStatus` fail-open. Zone lookup falls through to PostgreSQL. Mapbox Matrix
still runs. All this work is discarded when the reservation throws.

**Outcome:** every task → `FAILED`. **Fail-closed.** No queue, no retry.

**Recovery:** `kv.js` runs a background reconnect probe with capped exponential backoff
(1 s doubling to a 30 s ceiling, [kv.js:121-140](Backend/src/cache/kv.js#L121-L140)).
Once reconnected, assignment resumes for *new* tasks. Tasks failed during the outage are
**not** retried.

### 9.2 Redis never configured

`redisConfigured === false` → in-memory `Map` lock is used
([kv.js:442-444](Backend/src/cache/kv.js#L442-L444)). Assignment works end-to-end from
PostgreSQL values. `U = 0` uniformly (term inert), `Z` resolved from PostgreSQL zones,
battery and position from the DB row. **Correct for a single-process deployment,
unsafe-by-construction for multiple** — which is exactly why the `redisConfigured` guard
exists.

### 9.3 Mapbox unavailable

Two independent surfaces:

**Selection (Matrix).** `matrixDurationsToDestination` throws → caught per batch
([taskAssignment.service.js:161-164](Backend/src/services/taskAssignment.service.js#L161-L164))
→ `durations = null`, `usedFallback = true`. `D` (haversine) is unaffected. `T` degrades
per §5.7 — inert on total failure, mildly biased on partial failure. **Fail-open;
assignment proceeds.**

**Missing token.** `assertToken` throws `503` before any HTTP call
([mapbox.service.js:21-29](Backend/src/services/mapbox.service.js#L21-L29)). Same catch
applies. Selection succeeds with distance-only scoring.

**Routing (Directions).** `getRoutesWithDistance` tries `driving`, `walking`, `cycling`;
on total failure it emits 100-point straight-line interpolations
([task.service.js:114-127](Backend/src/services/task.service.js#L114-L127)) and sets
`usedFallback: true`. Only if the straight-line generation *also* fails (missing
coordinates) does it throw `502` → task `FAILED`.

**Consequence of the straight-line fallback:** `Task.distanceMeters` becomes the
crow-flies distance, and the robot navigates a path that ignores the road network entirely.
Nothing flags this to the operator beyond `usedFallback` on the `TASK_ASSIGNED` socket
payload ([task.service.js:295](Backend/src/services/task.service.js#L295)).

### 9.4 Robot disconnects

| Timing | Behavior |
|---|---|
| Before candidate query | Excluded — `isOnline: false`, `status: OFFLINE` |
| Between query and reservation | Still a candidate (stale DB row); finalization's `isOnline` check at task.service.js:235 rejects → task `FAILED` |
| Between reservation and transaction | Same — rejected at line 235 |
| After transaction, before dispatch | Task `ASSIGNED`, robot bound; `dispatch` finds an empty room, retries 3×, returns `dispatched: false`, **result discarded** → task stuck at `ASSIGNED` |
| During execution | Task stuck at `ASSIGNED`, robot retains `currentTaskId` permanently (§8.6) |

**Backstop detection.** The offline sweep
([socket.server.js:55-119](Backend/src/sockets/socket.server.js#L55-L119)) runs every
`OFFLINE_SWEEP_INTERVAL_MS = 10_000`, examining up to `OFFLINE_SWEEP_BATCH = 500` robots
whose `lastSeenAt` is older than `OFFLINE_CUTOFF_MS = 30_000`. It cross-checks the
registry's `lastHeartbeat` before marking anything offline, and reconciles the DB mirror
for robots that are live in Redis but stale in PostgreSQL. It **does not touch tasks or
`currentTaskId`.**

The `DB_FLUSH_INTERVAL_MS < OFFLINE_CUTOFF_MS` invariant (15 s vs 30 s) is documented as
load-bearing at [liveness.constants.js:10-32](Backend/src/config/liveness.constants.js#L10-L32).

### 9.5 Battery drops mid-mission

`BATTERY_DRAIN_ACTIVE = 0.0444 %/tick`, `BATTERY_MIN = 5 %`
([simulation/constants.js:22-26](Backend/src/simulation/constants.js#L22-L26)).

At `BATTERY_WARN_THRESHOLD = 20 %` while `ACTIVE`, `VirtualRobot._applyBattery` sets
status to `ISSUES` ([VirtualRobot.js:736-738](Backend/src/simulation/VirtualRobot.js#L736-L738)).

`_updateSpeed` deliberately treats `ISSUES` as a navigating state
([VirtualRobot.js:540-547](Backend/src/simulation/VirtualRobot.js#L540-L547)) — the
comment explains that treating it as halted would strand the robot mid-route while the
task stays `ASSIGNED` forever.

The charging trigger requires `this.phase === null`
([VirtualRobot.js:499-505](Backend/src/simulation/VirtualRobot.js#L499-L505)), so **a
robot with an active task never docks**, regardless of how low the battery falls. It
drives to `BATTERY_MIN = 5 %` and continues indefinitely at that floor.

**Server-side response: none.** No abort, no reassignment, no operator alert. The status
change to `ISSUES` reaches the DB and the dashboard, but no logic consumes it.

### 9.6 Robot faults

`ROBOT_FAULT` ([dtaro.handler.js:140-192](Backend/src/sockets/handlers/dtaro.handler.js#L140-L192))
sets `Robot.status = ERROR`, registry `healthStatus = FAULT`, creates a `CRITICAL` Event
row, and emits `ROBOT_UPDATED`.

**It does not release `currentTaskId` and does not change the task's status.** A robot
that faults mid-mission holds its task forever.

Recovery is operator-driven only: `POST /api/robots/:robotId/clear-fault`
([robots.controller.js:354-418](Backend/src/controllers/robots.controller.js#L354-L418)),
which restores `ACTIVE` if `currentTaskId` is set, else `IDLE`, and clears `healthStatus`.
It rejects with `409` if the robot is not actually in a fault state.

### 9.7 Reservation expires mid-assignment

TTL 30 s. Finalization involves up to 6 Mapbox Directions round-trips plus a transaction.
If exceeded, a concurrent assignment can acquire the same robot. Two overlapping guards
remain — the transaction's `currentTaskId` check, which is not serializable under READ
COMMITTED (§7.4) — plus the cross-release hazard of §7.6. **No detection, no mitigation.**

### 9.8 Task cancelled during assignment

Covered in §8.5. `CANCELLED` is silently overwritten back to `ASSIGNED`.

### 9.9 Assignment timeout

**Not implemented.** There is no timeout on `_processAssignment`, on
`selectNearestRobot`, on Mapbox calls (`fetch` at
[mapbox.service.js:32](Backend/src/services/mapbox.service.js#L32) has no
`AbortController` or `signal`), or on the DB transaction. A hung Mapbox connection stalls
that task's assignment indefinitely while holding its reservation.

### 9.10 Robot rejects task

**Not implemented.** No `TASK_REJECT` event exists in the codebase (§8.3).

### 9.11 Database unavailable

`prisma.robot.findMany` throws → propagates through `selectNearestRobot` →
`_processAssignment` → `setImmediate` catch → attempts `prisma.task.update(FAILED)`, which
also throws → swallowed by the inner `catch`
([task.service.js:381-385](Backend/src/services/task.service.js#L381-L385)).

**The task is left at `PENDING` with no record of the failure and no dashboard event.** It
remains `PENDING` indefinitely.

If the DB fails *during* `prisma.task.create` (Stage 2), the error propagates to
`asyncHandler` and returns a 5xx to the HTTP caller — the only failure mode the caller
observes synchronously.

Boot-time DB connection uses `connectPrismaWithRetry` ([server.js:32](Backend/server.js#L32)).

### 9.12 Duplicate task ID

`Task.taskId` is `@unique` ([schema.prisma:301](Backend/prisma/schema.prisma#L301)). A
client-supplied duplicate causes `prisma.task.create` to throw `P2002`, which is not
specifically handled and surfaces through `asyncHandler` as a generic error response.
Auto-generated IDs use `Date.now()` plus `crypto.randomInt(100, 1000)` — a 900-way
discriminator within the same millisecond, so collisions are possible but improbable.

### 9.13 Duplicate robot ID

`Robot.robotId` is `@unique`. `commissionRobot` explicitly pre-checks and returns
`409` with a human-readable message
([robot.service.js:26-32](Backend/src/services/robot.service.js#L26-L32)).
`commissionRobotWithPairing` instead treats an existing robot as an in-place update
([robots.controller.js:276-302](Backend/src/controllers/robots.controller.js#L276-L302)).

### 9.14 No eligible robot

Three distinct 409s from `selectNearestRobot`, all terminal (task → `FAILED`):

| Condition | Message | Line |
|---|---|---|
| Empty candidate query | `No available IDLE robots` | taskAssignment.service.js:89 |
| All candidates fail validation | `No robots passed eligibility validation` | taskAssignment.service.js:116 |
| No candidate has a resolvable position | `No robots with known positions available` | taskAssignment.service.js:144 |

Plus `502 "Cost evaluation returned no result"` (line 206), reachable only if
`computeCosts` returns `[]` on a non-empty candidate array — not possible given the
current implementation.

### 9.15 Failure summary

| Failure | Detected? | Assignment outcome | Mode |
|---|---|---|---|
| Redis down (configured) | Yes | `FAILED` | fail-closed |
| Redis down (unconfigured) | N/A | Succeeds, process-local lock | fail-open |
| Mapbox Matrix down | Yes | Succeeds, `T` degraded | fail-open |
| Mapbox Directions down | Yes | Succeeds, straight-line path | fail-open |
| Registry entry expired | No | Succeeds, fault check bypassed, `U = 0` | fail-open |
| Battery unknown (null) | No | Succeeds, treated as 100 % | fail-open |
| Robot offline post-select | Yes | `FAILED` | fail-closed |
| Robot offline post-commit | Ignored | Stuck `ASSIGNED` | silent |
| Robot never receives `TASK_ASSIGN` | Ignored | Stuck `ASSIGNED` | silent |
| Robot faults mid-mission | Yes (status only) | Stuck `ASSIGNED` | silent |
| Battery exhausted mid-mission | Status only | Continues at 5 % | silent |
| Task cancelled mid-assignment | No | Cancellation reverted | silent |
| Reservation expires mid-finalize | No | Possible double-assign | silent |
| DB down mid-assignment | No | Stuck `PENDING` | silent |
| Assignment hangs | No | Stuck `PENDING`, lock held | silent |

---

## 10. Robustness Analysis

### 10.1 Duplicate assignment — **Partially protected**

**Protections:** Redis `SET NX EX` reservation (atomic, cross-process, §7.3); pre-transaction
`currentTaskId` check (task.service.js:234); in-transaction re-check (line 251);
candidate query excludes `currentTaskId != null`.

**Gaps:**
- The transaction is READ COMMITTED and is not a serializable guard (§7.4).
- `Robot.currentTaskId @unique` constrains the task side, not the robot side.
- Reservation TTL (30 s) can expire during a long finalization (§7.7, §9.7).
- `releaseReservation` performs no ownership check, permitting cross-release (§7.6).

**Assessment:** correct under normal latency with Redis healthy. The correctness rests
entirely on finalization completing within 30 s, which is not enforced anywhere.

### 10.2 Robot starvation — **Not protected**

No fairness mechanism, aging, round-robin, or assignment-count tracking exists. The
implicit mitigations are:
- `U` penalizes recently-active robots (weight 0.15, effective range ~0-0.075, §5.6).
- `B` penalizes drained robots, which correlates with recent activity (weight 0.30).

**Structural starvation source:** robots do not return to base after completing a task —
`VirtualRobot` goes `IDLE` at the drop coordinates
([VirtualRobot.js:612-624](Backend/src/simulation/VirtualRobot.js#L612-L624)). With
`w1 = 0.50` on distance-to-pickup, the fleet progressively migrates toward drop clusters,
and robots near frequent pickup points win repeatedly while distant robots idle
indefinitely. Nothing counteracts this.

### 10.3 Battery exhaustion — **Partially protected**

**Protections:** 20 % eligibility floor (R8); 30 % charge-interrupt floor (R4); `B` term
at weight 0.30; robot-side auto-dock below `BATTERY_CRITICAL_THRESHOLD = 10 %`; robot-side
deferral of assignments received below 30 % while charging.

**Gaps:**
- No mission-feasibility check — the floor is absolute, not relative to mission energy
  (§4.6, §15.5).
- Auto-dock requires `phase === null`, so it never fires mid-mission (§9.5).
- Null battery is treated as 100 % for scoring and passes eligibility (§5.5, §4.6).
- Battery may be up to 15 s stale in the DB-fallback path (§6.4).

### 10.4 Robot overload — **Protected**

`Robot.currentTaskId` is a strict 1:1 relation
([schema.prisma:206-208](Backend/prisma/schema.prisma#L206-L208)), enforced at the
candidate query, in `validateRobot` (R5, R7), pre-transaction, and in-transaction. **A
robot cannot hold two tasks simultaneously.** There is also no task queue per robot — the
model is strictly one-at-a-time.

### 10.5 Low-battery mission — **Not protected**

Distinct from §10.3: the engine has no concept of the *mission's* energy requirement. The
mission distance is unknown at decision time (§5.4) and is computed only after binding
([task.service.js:246, 261](Backend/src/services/task.service.js#L246)). No comparison
between remaining charge and required energy exists anywhere in the repository.

### 10.6 Charging interruption — **Protected**

Coherently handled on both sides. Server: R4 requires ≥ 30 % before a charging robot is
eligible. Robot: `_onTaskAssign` clears charging state and proceeds if ≥ 30 %, otherwise
defers ([VirtualRobot.js:320-336](Backend/src/simulation/VirtualRobot.js#L320-L336)). The
shared constant is centralized in `dtaro.constants.js` specifically to prevent the two
sides from diverging ([dtaro.constants.js:1-8](Backend/src/config/dtaro.constants.js#L1-L8)).

**Residual gap:** the deferral is invisible to the server (§8.4) — a task can sit
`ASSIGNED` for ~30 minutes with no signal.

### 10.7 Faulty robots — **Partially protected**

`ERROR` status excludes from the candidate pool; `healthStatus === FAULT` is a hard reject
(R9). Recovery requires explicit operator action.

**Gaps:** R9 is fail-open when the registry has expired (§4.7); the charging branch skips
R9 entirely (§4.5); manual assignment skips R9 entirely (§4.9); a fault mid-mission does
not release the task (§9.6).

### 10.8 Network failure — **Partially protected**

Mapbox failures degrade gracefully at both surfaces (§9.3). Redis failure fails closed
with a background reconnect probe (§9.1). Socket.IO reconnection is configured with
`reconnectionAttempts: Infinity` and a 3 s → 10 s delay on the robot side
([VirtualRobot.js:152-159](Backend/src/simulation/VirtualRobot.js#L152-L159)).

**Gaps:** no HTTP timeout on Mapbox calls (§9.9); dispatch delivery failure is discarded
(§8.3).

### 10.9 Redis restart — **Protected for availability, lossy for state**

`kv.js` maintains a reconnect loop with capped backoff and clears the warn latch on
success ([kv.js:121-140](Backend/src/cache/kv.js#L121-L140)). The Socket.IO Redis adapter
is attached separately at boot ([server.js:48-67](Backend/server.js#L48-L67)) and, notably,
**has no equivalent reconnect handling in `server.js`** — it is created once and, if the
initial connect fails, the process falls back to the single-process adapter permanently
with a loud warning. ioredis's own default reconnection applies to an adapter client that
connects successfully and later drops.

**State loss on a Redis flush/restart:** all `registry:{id}` entries vanish. Effects until
the next telemetry tick repopulates them: `U` resets to 0 for every robot (no DB fallback,
§5.6), zone falls back to the DB mirror, charging robots become ineligible (§4.4), and the
fault check is bypassed. Session tokens (`session:{robotId}`, TTL 7 days) and battery
snapshots (`vr:battery:{robotId}`, TTL 48 h) are also lost, forcing re-pairing and
resetting simulated battery to the DB value.

`robots:all` is repopulated by AUTH ([robot.handler.js:221-223](Backend/src/sockets/handlers/robot.handler.js#L221-L223)),
commissioning, and task recovery.

### 10.10 Socket reconnect — **Protected**

Session-token reconnect avoids re-pairing. The previous socket is disconnected only *after*
the DB is updated to the new `socketId`
([robot.handler.js:188-193](Backend/src/sockets/handlers/robot.handler.js#L188-L193)),
preventing the old socket's `disconnect` handler from marking the robot offline. The
`disconnect` handler additionally guards on both the DB `socketId` and the local map
([robot.handler.js:308-316](Backend/src/sockets/handlers/robot.handler.js#L308-L316)).

### 10.11 Mapbox latency — **Not protected**

No timeout, no circuit breaker, no cache of Matrix results. Latency directly extends the
reservation hold window and therefore increases the probability of the §9.7 expiry hazard.
The retry loop can issue up to 15 Matrix requests for a single task.

### 10.12 Task cancellation — **Partially protected**

Correct and thorough for an `ASSIGNED` task (§8.5). Broken for a `PENDING` task with an
in-flight assignment (§8.5 race).

### 10.13 Partial completion — **Not protected**

`TASK_COMPLETE` is accepted on the robot's word with no geometric verification (§2.9).
There is no partial-completion state — a task is either `ASSIGNED` or `COMPLETED`. A robot
that reaches pickup but not drop has no way to express that.

### 10.14 Unexpected disconnect — **Detected, not remediated**

The offline sweep is a genuine backstop for the "disconnect handler never ran" case, and it
is Redis-aware to avoid false positives from the throttled DB writes (§9.4). But it
performs **liveness bookkeeping only** — no task-level remediation.

### 10.15 Robustness scorecard

| Scenario | Status |
|---|---|
| Duplicate assignment | Partially protected |
| Robot overload (2 tasks) | **Protected** |
| Charging interruption | **Protected** |
| Socket reconnect | **Protected** |
| Redis restart (availability) | **Protected** |
| Faulty robot selection | Partially protected |
| Battery exhaustion (selection) | Partially protected |
| Network failure | Partially protected |
| Task cancellation | Partially protected |
| Unexpected disconnect | Detected only |
| Robot starvation | **Not protected** |
| Low-battery mission feasibility | **Not protected** |
| Mapbox latency | **Not protected** |
| Partial completion | **Not protected** |
| Mid-mission task recovery | **Not protected** |

---

## 11. Current Decision Parameters

Every parameter that influences which robot receives a task. "Hard" = binary
eligibility gate; "Soft" = contributes to the cost score; "Structural" = shapes the
candidate set or the pipeline without being either.

### 11.1 Hard constraints

| # | Parameter | Purpose | Source | Mandatory | Location |
|---|---|---|---|---|---|
| H1 | `Robot.status ∈ {IDLE, PAUSED}` | Exclude busy/offline/faulted | PostgreSQL | Yes | taskAssignment.service.js:79 |
| H2 | `Robot.isOnline === true` | Exclude disconnected | PostgreSQL | Yes | taskAssignment.service.js:80 |
| H3 | `Robot.currentTaskId === null` | One task per robot | PostgreSQL | Yes | taskAssignment.service.js:81 |
| H4 | `excludeRobotIds` | Retry exclusion | in-memory (loop) | No | taskAssignment.service.js:82 |
| H5 | `take: 100` | Candidate cap | constant | Yes | taskAssignment.service.js:85 |
| H6 | Effective status is `IDLE` (non-charging) | Reject stale PAUSED | Redis → PG | Yes | robotValidator.service.js:90 |
| H7 | Battery ≥ 20 % | Minimum charge | Redis → PG → null | Yes (fail-open on null) | robotValidator.service.js:107 |
| H8 | Charging battery ≥ 30 % | Charge-interrupt floor | Redis → PG → null | Yes (fail-open on null) | robotValidator.service.js:71-83 |
| H9 | `healthStatus !== FAULT` | Exclude faulted | Redis | Yes (fail-open if absent) | robotValidator.service.js:115 |
| H10 | Socket connected ⟹ authenticated | Auth integrity | local Map + Redis | **Unreachable** | robotValidator.service.js:121 |
| H11 | Resolvable position | Needed for `D` | Redis → PG | Yes | taskAssignment.service.js:131 |
| H12 | Reservation acquired | Mutual exclusion | Redis `SET NX EX` | Yes (fail-closed) | task.service.js:189 |
| H13 | Pre-finalize: robot exists, no task, online, has position | Re-validation | PostgreSQL + Redis | Yes | task.service.js:233-240 |
| H14 | In-transaction: no task, status assignable | Consistency | PostgreSQL | Yes | task.service.js:250-254 |

### 11.2 Soft scoring factors

| # | Parameter | Weight | Normalization | Source | Location |
|---|---|---|---|---|---|
| S1 | Haversine distance robot → pickup | 0.50 | min-max over set | computed | costEvaluator.service.js:99, 115 |
| S2 | Battery % (inverted) | 0.30 | `1 − b/100`, absolute | Redis → candidate row → 100 | costEvaluator.service.js:103, 116 |
| S3 | Utilization EMA | 0.15 | none (already 0-1) | Redis → 0 | costEvaluator.service.js:93-96, 117 |
| S4 | Mapbox driving duration → pickup | 0.05 | min-max over set | Mapbox → null → 0 | costEvaluator.service.js:100, 118 |
| S5 | Zone-locality penalty | 0.05 | binary 0/1 | Redis → PG → null | costEvaluator.service.js:108-111, 119 |

### 11.3 Structural parameters

| # | Parameter | Value | Effect | Location |
|---|---|---|---|---|
| P1 | `RESERVATION_TTL_SEC` | 30 | Lock lifetime; bounds safe finalization duration | task.service.js:134 |
| P2 | `MAX_RESERVATION_RETRIES` | 2 | 3 total selection passes | task.service.js:135 |
| P3 | Matrix batch size | 24 | Origins per request (25-coord Mapbox limit) | taskAssignment.service.js:149 |
| P4 | `BATTERY_THRESHOLD` | 20 | H7 floor | dtaro.constants.js:12 |
| P5 | `CHARGING_INTERRUPT_BATTERY` | 30 | H8 floor and robot-side deferral threshold | dtaro.constants.js:16 |
| P6 | `REGISTRY_TTL` | 30 s | Live-state lifetime; governs the §6.5 cliff | robotRegistry.service.js:19 |
| P7 | `robot:{id}` TTL | 15 s | Finalize-position lifetime | telemetry.handler.js:327 |
| P8 | `DB_FLUSH_INTERVAL_MS` | 15 s | DB staleness bound for candidate query | liveness.constants.js:36 |
| P9 | `OFFLINE_CUTOFF_MS` | 30 s | Offline detection latency | liveness.constants.js:39 |
| P10 | `OFFLINE_SWEEP_INTERVAL_MS` | 10 s | Sweep cadence | liveness.constants.js:42 |
| P11 | `OFFLINE_SWEEP_BATCH` | 500 | Robots per sweep pass | liveness.constants.js:45 |
| P12 | Utilization EMA α | 0.05 | ~40 s time constant on `U` | telemetry.handler.js:429 |
| P13 | `TELEMETRY_INTERVAL_MS` | 2 s | Live-state refresh rate | simulation/constants.js:4 |
| P14 | Zone `delta` | 0.005° (~550 m) | Default quadrant half-width | zoneManager.service.js:230 |
| P15 | Directions profile order | driving, walking, cycling | Route generation fallback chain | task.service.js:79 |
| P16 | Matrix profile | driving | Fixed for `T` | taskAssignment.service.js:159 |
| P17 | Dispatch `MAX_RETRIES` | 2 | `TASK_ASSIGN` retry attempts | commandDispatcher.service.js:36 |
| P18 | Restart re-dispatch delay | 5 s | Fixed wait for robot auth | server.js:250 |
| P19 | Assign rate limit | 60 / 60 s | HTTP throttle | tasks.routes.js:10 |
| P20 | `taskPath:`/`task:`/`robotTask:` TTL | 86 400 s | Task runtime state lifetime | task.service.js:25 |

### 11.4 Declared but unused

| Parameter | Declared | Status |
|---|---|---|
| `Robot.utilization` (PostgreSQL column) | schema.prisma:188 | **Never read, never written** — no durable fallback for `U` |
| `costWeights` parameter | taskAssignment.service.js:54 | Never supplied by the production call site; weights are effectively constants |
| `maxRobots` parameter | taskAssignment.service.js:54 | Never overridden; always 100 |
| `robotRegistry.updateUtilization` | robotRegistry.service.js:239 | Exported, never called |
| `robotRegistry.updateTelemetry` | robotRegistry.service.js:202 | Exported, never called |
| `registry.etaSec` | robotRegistry.service.js:12 (docstring) | Never written or read |
| `TaskStatus.IN_PROGRESS` | schema.prisma:27 | Read as a filter, never assigned |
| `Task.startedAt` | schema.prisma:328 | Never written |
| `H10` auth-integrity rule | robotValidator.service.js:121 | Logically unreachable (§4.8) |
| `usedFallback` return field | taskAssignment.service.js:216 | Returned, never consumed for any decision |
| `RETURN_TO_BASE` robot handler | VirtualRobot.js:211 | No server emitter found |

---

## 12. Desired Decision Parameters

The following is the allocation philosophy specified for comparison. **Nothing in this
section is implemented as a result of this document**; it is the reference model against
which §13 measures the current code.

| # | Desired parameter | Intent |
|---|---|---|
| D1 | Pickup distance | Distance from robot's current position to the pickup point |
| D2 | Delivery distance | Distance from pickup to drop |
| D3 | Total mission distance | D1 + D2 — the full displacement the robot will perform |
| D4 | Estimated mission completion time | End-to-end duration including both legs and dwell times |
| D5 | Estimated payload weight | Mass/volume of the item to be carried |
| D6 | Robot payload capacity | The robot's rated carrying limit |
| D7 | Remaining battery after mission completion | Projected state of charge at drop-off |
| D8 | Battery reserve threshold | Minimum projected post-mission charge to accept the task |
| D9 | Robot health | Diagnostic condition beyond a binary fault flag |
| D10 | Robot availability | Whether the robot is genuinely free to start now |
| D11 | Robot utilization | Longer-horizon duty-cycle measure for load balancing |
| D12 | Current workload | Queued or in-flight work already committed to the robot |
| D13 | Travel time | Road-network ETA |
| D14 | Route complexity | Turns, elevation, road class, difficulty of the path |
| D15 | Zone locality | Preference for robots already operating in the relevant zone |
| D16 | Obstacle information | Known blockages along the candidate route |
| D17 | Robot capability | Whether the robot is functionally suited to this task type |
| D18 | Operational reliability | Historical success rate, failure frequency, MTBF |

---

## 13. Gap Analysis

Status values: **Implemented** — present and load-bearing in the assignment decision.
**Partially Implemented** — present but scoped narrower than the desired parameter, or
present but inert/unreachable. **Not Implemented** — no supporting code exists.
**Cannot Verify** — behavior indeterminate from the repository.

### 13.1 Comparison table

| # | Parameter | Current Implementation | Desired Philosophy | Status |
|---|---|---|---|---|
| D1 | Pickup distance | Haversine robot→pickup, min-max normalized, `w1 = 0.50` — the dominant term (costEvaluator.service.js:99,115) | Straight-line or road distance to pickup | **Implemented** |
| D2 | Delivery distance | Pickup→drop is computed only *after* binding, stored as `Task.distanceMeters` for display (task.service.js:246,261). `selectNearestRobot` has no drop parameter (taskAssignment.service.js:54) | Pickup→drop influences selection | **Not Implemented** |
| D3 | Total mission distance | Same as D2 — computed post-decision, never fed back | Total displacement influences selection | **Not Implemented** |
| D4 | Estimated mission completion time | `T` covers only the robot→pickup leg via Mapbox Matrix, `w4 = 0.05` (taskAssignment.service.js:156-160). No pickup→drop duration, no dwell times, no aggregate ETA | End-to-end mission duration | **Partially Implemented** |
| D5 | Estimated payload weight | No field on `Task`; no `payload`/`weight`/`cargo` identifier anywhere in `Backend/src` or `schema.prisma` | Task carries a payload spec | **Not Implemented** |
| D6 | Robot payload capacity | No field on `Robot`; no capacity concept exists | Robot declares a rated capacity | **Not Implemented** |
| D7 | Remaining battery after mission | No projection exists. Battery is evaluated only as an instantaneous level (robotValidator.service.js:107, costEvaluator.service.js:103) | Project charge at drop-off | **Not Implemented** |
| D8 | Battery reserve threshold | Two absolute floors exist — 20 % general, 30 % charge-interrupt (dtaro.constants.js:12-16) — but they gate *current* charge, not *projected post-mission* charge | Reserve applies to projected end state | **Partially Implemented** |
| D9 | Robot health | Binary `healthStatus ∈ {OK, DEGRADED, FAULT}` (robotRegistry.service.js:261). Only `FAULT` is consulted, as a hard reject (robotValidator.service.js:115). **`DEGRADED` is accepted by the enum but never written by any code and never consulted** | Graded health influences ranking | **Partially Implemented** |
| D10 | Robot availability | Strongly implemented: `status ∈ {IDLE, PAUSED}` + `isOnline` + `currentTaskId == null` + registry live status + reservation lock (§11.1 H1-H3, H6, H12) | Robot is genuinely free | **Implemented** |
| D11 | Robot utilization | `U` term, `w3 = 0.15`, EMA α = 0.05 over `status === "ACTIVE"` (telemetry.handler.js:427-431). Scoped to ~40 s of recent history; no durable store; effective range ~0-0.075 for idle candidates (§5.6) | Longer-horizon duty cycle | **Partially Implemented** |
| D12 | Current workload | Strictly binary — `currentTaskId` is null or not (schema.prisma:207). No queue, no depth, no lookahead. Any non-zero workload makes the robot ineligible rather than lower-ranked | Graded workload influences ranking | **Partially Implemented** |
| D13 | Travel time | Mapbox Matrix `driving` duration, robot→pickup only, `w4 = 0.05` (mapbox.service.js:121-148). Degrades to a constant on total failure, biased on partial failure (§5.7) | Road-network ETA | **Partially Implemented** |
| D14 | Route complexity | Not consulted at selection time. `annotations=duration` only — no distance, congestion, or step data is requested (mapbox.service.js:135). A* replanning exists but runs only during obstacle rerouting, post-assignment (routing.service.js:34-97) | Route difficulty influences selection | **Not Implemented** |
| D15 | Zone locality | `Z` term, `w5 = 0.05`, binary same-zone/other, additive above the w1-w4 budget (costEvaluator.service.js:108-119). Neutral when the pickup's zone is unresolvable | Zone affinity | **Implemented** |
| D16 | Obstacle information | A full EKB exists — obstacle storage with TTL (ekb.service.js), zone tagging, segment-intersection detection (routeIntersection.service.js), REROUTE_ALERT dissemination, A* replanning (routing.service.js). **None of it is consulted by `selectNearestRobot` or `computeCosts`.** It is purely reactive, triggered by `OBSTACLE_REPORT` after assignment (alertDissemination.service.js:35-113) | Known blockages influence selection | **Not Implemented** (as a selection input) |
| D17 | Robot capability | No robot type, class, skill, or capability attribute exists on `Robot` (schema.prisma:170-232). No task type exists on `Task`. Every robot is interchangeable by construction | Capability matching | **Not Implemented** |
| D18 | Operational reliability | No success/failure counters, no MTBF, no per-robot historical aggregate. `Event` and `Command` rows are written (schema.prisma:368-406) but never aggregated or read into any decision | Historical reliability influences ranking | **Not Implemented** |

### 13.2 Roll-up

| Status | Count | Parameters |
|---|---|---|
| **Implemented** | 3 | D1, D10, D15 |
| **Partially Implemented** | 6 | D4, D8, D9, D11, D12, D13 |
| **Not Implemented** | 9 | D2, D3, D5, D6, D7, D14, D16, D17, D18 |
| **Cannot Verify** | 0 | — |

Every desired parameter was resolvable from the repository; none required an
indeterminate verdict.

### 13.3 Structural observation on the gaps

The nine "Not Implemented" parameters are not independent omissions. Seven of them
(D2, D3, D4-partial, D7, D14, D16) share **one** root cause: `selectNearestRobot`'s
signature accepts only `pickup`
([taskAssignment.service.js:54](Backend/src/services/taskAssignment.service.js#L54)). The
drop coordinates, the route geometry, and the obstacle set are all available at the call
site ([task.service.js:143, 174-178](Backend/src/services/task.service.js#L143)) but are
not passed in. The engine is architecturally a **"which robot is nearest to the pickup"**
selector with quality modifiers, not a mission-cost optimizer.

The remaining three (D5, D6, D17) share a different root cause: the **domain model has no
notion of task type or robot type**. `Task` carries only coordinates and text labels;
`Robot` carries only location, status, and telemetry. Adding payload or capability
reasoning would require schema changes, not just scoring changes.

D18 has a third root cause: outcome data (`Event`, `Command`, task completion history) is
persisted but never aggregated.

---

## 14. Decision Quality Analysis

### 14.1 How robust is the decision engine?

**Structurally robust properties:**

1. **Hard/soft separation is clean.** No cost value can override an eligibility rule,
   because filtering completes before `computeCosts` is ever called
   ([taskAssignment.service.js:110-118](Backend/src/services/taskAssignment.service.js#L110-L118)).
2. **The decision is deterministic** given a fixed candidate set and fixed inputs. No
   randomness, no ML, no time-dependent term. The same inputs always produce the same
   winner.
3. **Every external dependency degrades rather than crashes** — except the reservation
   lock, which fails closed by explicit design (§7.5).
4. **The decision is fully auditable.** `logger.dtaro` records candidates, per-candidate
   cost components, rejection reasons, and the winner
   ([taskAssignment.service.js:189-201](Backend/src/services/taskAssignment.service.js#L189-L201));
   `recordAllocation` persists cost, components, and selection latency to Redis
   ([metrics.service.js:17-28](Backend/src/services/metrics.service.js#L17-L28)).

**Structurally fragile properties:**

1. **The decision is never revisited.** No re-evaluation, no preemption, no reassignment
   after any event (§9.4-9.6). A decision made on stale data stays made.
2. **Correctness of mutual exclusion depends on an unenforced timing assumption** —
   finalization completing within 30 s (§7.7).
3. **Several safety rules are fail-open on missing data** (§4.6, §4.7, §6.5), and the data
   most likely to be missing (registry state) is missing precisely when the robot is
   least healthy.
4. **The result of dispatch is discarded** (§8.3), so a correct decision can produce no
   effect with no signal.

### 14.2 Can it produce incorrect robot selections?

Yes. Enumerated, with mechanism:

**(a) Suboptimal beyond the candidate cap.** With more than 100 eligible robots, an
unordered `take: 100` yields an arbitrary subset (§3.3). The globally-best robot may never
be scored. Severity scales with fleet size; below 100 eligible robots this cannot occur.

**(b) Geometrically wrong under stale position.** With an expired registry entry, position
falls back to `Robot.lat/lon`, flushed at most every 15 s (§6.4). At ~5.56 m/s that is
~83 m of error — enough to reorder near-tied candidates.

**(c) Crow-flies vs. road divergence.** `D` (weight 0.50) is haversine; `T` (weight 0.05)
is the only road-aware term and cannot overturn it (§5.4, §5.7). A robot across a river or
a wall from the pickup outranks one on the same street 100 m further away.

**(d) Unknown battery scored as full.** `battery === null` passes eligibility (fail-open)
and scores as 100 % (§5.5). A robot with no battery telemetry outranks a genuinely
well-charged one.

**(e) Partial Mapbox failure biases toward the failed batch.** Failed-batch candidates
receive `normT = 0`, the best possible travel-time score (§5.7). Bounded at 0.05 but
directionally arbitrary.

**(f) Utilization advantage from an expired registry.** `U` defaults to 0 with no DB
fallback (§5.6). A robot whose registry expired scores the best possible utilization —
and expiry correlates with the robot having stopped reporting, which is a *negative*
signal being read as positive.

**(g) Fault bypass on expired registry.** R9 is fail-open (§4.7). A faulted robot whose
`ERROR` status has not yet flushed to PostgreSQL (up to 15 s) and whose registry entry has
expired is both a candidate and unrejected.

**(h) Zone term silently inert outside the seeded quadrants.** The four default zones span
only ~±1.1 km around the campus centre (§5.8). Pickups outside resolve to `null` and `Z`
becomes 0 for everyone.

**(i) Arbitrary tie-breaking.** Exact ties resolve to the first row in an unordered SQL
result (§5.10). Reachable in the single-candidate and all-equal degenerate cases.

**(j) Manual assignment bypasses every soft and most hard checks** (§4.9).

### 14.3 What reduces decision quality?

| Condition | Mechanism | Affected terms |
|---|---|---|
| Fleet > 100 eligible robots | Unordered `take` truncation | all |
| Registry TTL expiry (30 s silence) | Fallback cascade | `B`, `U`, `Z`, position, fault check, charging eligibility |
| Redis outage (configured) | Assignment halts entirely | all |
| Mapbox total outage | `T` becomes a constant | `T` |
| Mapbox partial outage | `normT = 0` for failed batches | `T` |
| No zones seeded / pickup outside zones | `Z` becomes a constant | `Z` |
| Homogeneous candidate distances | `D` collapses to 0.5 for all | `D` |
| One distant outlier candidate | Min-max compresses all others near 0 | `D`, `T` |
| Single candidate | `D = T = 0.5`; only `B`, `U`, `Z` discriminate | `D`, `T` |
| Fleet dispersed to drop points | Structural starvation of distant robots | `D` |
| Battery telemetry absent | Scored as 100 % | `B` |

### 14.4 Assumptions the engine makes

Implicit in the implementation, none validated at runtime:

1. **The candidate set is smaller than 100.** Violated silently.
2. **All robots are functionally interchangeable.** No capability model exists (§13, D17).
3. **All tasks are functionally identical.** No task type or payload exists (D5).
4. **Robot→pickup distance is a sufficient proxy for total mission cost.** Only true when
   pickup→drop distance is roughly uniform across tasks.
5. **Straight-line distance approximates road distance.** Violated by any barrier.
6. **A robot that passes the 20 % floor can complete any mission.** Unbounded mission
   length makes this false in general (§15.5).
7. **Robots report truthfully.** Completion, battery, position, and status are all trusted
   without verification (§2.9, §10.13).
8. **Finalization completes within 30 s.** Unenforced (§7.7).
9. **`TASK_ASSIGN` is delivered.** Result discarded (§8.3).
10. **Redis and PostgreSQL agree closely enough.** Reconciliation is one-directional and
    best-effort (§6.7).

### 14.5 Constraints the engine operates under

- **One task per robot, strictly** (`@unique currentTaskId`).
- **One robot per task, strictly** (single `robotId` FK).
- **Greedy, per-task, no batching.** Tasks created together are assigned independently and
  sequentially; no global optimum across a set of tasks is attempted.
- **No preemption.** An assigned robot cannot be taken for a higher-value task.
- **No queueing.** Failure is terminal.
- **Fixed weights.** No runtime tuning surface (§5.1).
- **Selection cost is O(N) per attempt** in SQL rows, Redis MGET entries, and
  `ceil(N/24)` Mapbox requests, with up to 3 attempts.

---

## 15. Assignment Correctness Analysis

### 15.1 Does it always produce a valid robot?

**Yes, when it produces one at all** — with two qualifications.

Validity is enforced through four sequential layers: the SQL predicate (H1-H3), the
validator (H6-H10), the pre-finalization checks (H13), and the transaction guard (H14).
Any robot reaching `TASK_ASSIGN` has satisfied all four.

**Qualification 1 — the manual path.** `robotCodeIn` bypasses layers 1 and 2 entirely
(§4.9). Layers 3 and 4 still apply, so the robot is guaranteed to exist, be online,
be free, have a position, and be `IDLE`/`PAUSED` — but **not** to have adequate battery or
to be free of a registry-level fault.

**Qualification 2 — time-of-check/time-of-use.** Validation (layer 2) runs before the
reservation; finalization (layers 3-4) runs after route computation. Battery and
`healthStatus` are **not re-checked** at layers 3-4
([task.service.js:229-240](Backend/src/services/task.service.js#L229-L240)). A robot that
drains below 20 % or faults during the Mapbox window is still bound.

**Failure to produce a robot is explicit and terminal:** four distinct error codes (§9.14),
each ending in `Task.status = FAILED`.

### 15.2 Does it always produce the optimal robot?

**No.** Three independent reasons, in decreasing severity:

1. **Optimality is undefined for the stated objective.** The objective the code minimizes
   is `C(r)` over robot→pickup proximity, battery, recent activity, pickup ETA, and zone.
   It is **not** mission cost, mission time, energy, or throughput. Even a perfect argmin
   over `C(r)` is not optimal with respect to the delivery mission, because the mission's
   second leg is not in the objective at all (§13.3).

2. **The search space is truncated.** `take: 100` with no `ORDER BY` (§3.3).

3. **The inputs may be stale or missing**, with fail-open defaults that favour the
   least-observable robot (§14.2 d, f, g).

Within its own definition and below 100 candidates, the argmin is **exact** — `reduce`
over the full scored set with no pruning or heuristic
([taskAssignment.service.js:185](Backend/src/services/taskAssignment.service.js#L185)).

### 15.3 Does it guarantee mission completion?

**No.** No mechanism in the repository guarantees, monitors, or enforces completion.

Evidence:
- No timeout on `ASSIGNED` tasks. Repository-wide search finds no scheduled job examining
  task age. The only periodic timers are the offline sweep
  ([socket.server.js:60](Backend/src/sockets/socket.server.js#L60)) and the EKB sweep
  ([socket.server.js:138](Backend/src/sockets/socket.server.js#L138)) — neither reads
  `Task`.
- No reassignment on disconnect, fault, or battery exhaustion (§9.4-9.6).
- No delivery confirmation for `TASK_ASSIGN` (§8.3).
- `IN_PROGRESS` and `startedAt` are never written, so there is no way to distinguish
  "assigned but never started" from "assigned and under way" (§2.7).
- The robot may defer an assignment for ~30 minutes with no server-side signal (§8.4).

The only completion-adjacent mechanism is **restart recovery** (§8.8), which re-dispatches
`ASSIGNED` tasks — but only on a server restart, and it resets the phase to `TO_PICKUP`
regardless of prior progress.

### 15.4 Is battery validation sufficient?

**No, for the stated philosophy; adequate as a floor.**

What exists:
- 20 % absolute eligibility floor (H7).
- 30 % charge-interrupt floor (H8), mirrored on the robot side.
- `B` term at weight 0.30 — the second-strongest scoring signal.
- Robot-side auto-dock at 10 %, hard floor at 5 %.
- Battery persistence to Redis (`vr:battery:`, 48 h TTL) and periodic DB flush on ≥ 2 %
  swings.

What is missing:
- **No mission energy model.** No consumption-per-metre constant is applied to any
  distance at decision time. `BATTERY_DRAIN_ACTIVE` exists only inside the simulator
  ([simulation/constants.js:22](Backend/src/simulation/constants.js#L22)) and is never
  imported by the assignment path.
- **No projected post-mission charge** (D7).
- **No reserve applied to a projection** (D8).
- **Fail-open on null battery** (§4.6) — the failure mode is toward accepting, not
  rejecting.
- **Mid-mission exhaustion is unhandled** (§9.5) — the robot drives at 5 % indefinitely.

**Concrete insufficiency:** a robot at 20.1 % battery is eligible for a mission of
unbounded length. At the simulator's `0.0444 %/tick` over 2 s ticks, 15.1 % of usable
charge (down to the 5 % floor) supports roughly 11 minutes of driving, or ~3.7 km at
5.56 m/s. Nothing compares that budget to the mission — indeed the mission's length is
not known until after the robot is bound.

### 15.5 Does capability validation exist?

**No.** Exhaustively verified:
- `Robot` has no type, class, model, skill, or capability field
  ([schema.prisma:170-232](Backend/prisma/schema.prisma#L170-L232)).
- `Task` has no type, category, or requirement field
  ([schema.prisma:298-342](Backend/prisma/schema.prisma#L298-L342)).
- No identifier matching `capabilit|skill|robotType|taskType` appears anywhere in
  `Backend/src`.

Every robot is treated as functionally identical to every other.

### 15.6 Does payload validation exist?

**No.** Verified by repository-wide search for `payload|capacity|weight|cargo|maxLoad`:
every match in `Backend/src` refers to a socket message body, an OAuth token payload, or a
cost-function weight. No mass, volume, or capacity concept exists in the schema or the code.

### 15.7 Is distance estimation complete?

**No — it covers one of two legs.**

| Leg | Estimated at selection? | Method | Used in decision? |
|---|---|---|---|
| Robot → pickup | Yes | Haversine (`distanceM`) | **Yes** — `D`, weight 0.50 |
| Pickup → drop | No | — | **No** |
| Total mission | No | — | **No** |

Post-decision, `getRoutesWithDistance` produces a genuine road distance for both legs by
summing Mapbox `route.distance` values, falling back to summed per-segment haversine over
the returned points ([task.service.js:86-89](Backend/src/services/task.service.js#L86-L89)).
That value is written to `Task.distanceMeters` and emitted to the dashboard. **It never
returns to the decision.**

The distance used in the decision is also **never road distance** — even when Mapbox is
fully available, only durations are requested from the Matrix API
([mapbox.service.js:135](Backend/src/services/mapbox.service.js#L135)).

### 15.8 Is route estimation complete?

**Complete for execution; absent for selection.**

For execution, routing is thorough: three-profile Directions fallback, GeoJSON geometry
with `overview=full`, seam-stitching between the two legs
([task.service.js:98-101](Backend/src/services/task.service.js#L98-L101)), a dense
100-point straight-line fallback, A* obstacle replanning over the waypoint graph
([routing.service.js:34-157](Backend/src/services/routing.service.js#L34-L157)), and
segment-intersection detection for obstacle dissemination
([routeIntersection.service.js:50-87](Backend/src/services/routeIntersection.service.js#L50-L87)).

For selection, the only route-derived input is the Matrix duration to the pickup, at weight
0.05. Route geometry, road class, turn count, elevation, and known obstacles are all
computed by the system but none reach `computeCosts`.

### 15.9 Correctness summary

| Question | Answer | Primary evidence |
|---|---|---|
| Always produces a valid robot? | Yes, except the manual path and TOCTOU on battery/fault | §15.1 |
| Always produces the optimal robot? | No — objective excludes the mission; search truncated at 100 | §15.2 |
| Guarantees mission completion? | No — no timeout, no reassignment, no ACK | §15.3 |
| Battery validation sufficient? | No — absolute floor only, no energy model | §15.4 |
| Capability validation exists? | No — no capability concept | §15.5 |
| Payload validation exists? | No — no payload concept | §15.6 |
| Distance estimation complete? | No — pickup leg only, crow-flies only | §15.7 |
| Route estimation complete? | For execution yes; for selection no | §15.8 |

---

## 16. Engineering Conclusion

### 16.1 What the system is

RobotX implements a **greedy, single-shot, fixed-weight, five-criteria nearest-robot
selector with hard eligibility gating and a distributed reservation lock.** It is a
proximity-first dispatcher with quality modifiers — not a mission-cost optimizer, and not
a fleet scheduler.

That characterization is not a criticism; it is the accurate description of the objective
function actually minimized:

```
C(r) = 0.50·D_pickup + 0.30·(1 − battery) + 0.15·U_recent + 0.05·T_pickup + 0.05·Z
```

Every term is scoped to the robot's state and its relationship to the **pickup point**.
No term references the drop point, the mission, the payload, or the robot's history.

### 16.2 Current strengths

1. **Clean constraint/preference separation.** Hard rules gate before scoring; no score can
   override a safety rule. This is the correct architecture for a safety-relevant allocator
   and it is implemented consistently
   ([taskAssignment.service.js:100-118](Backend/src/services/taskAssignment.service.js#L100-L118)).

2. **A genuine distributed mutex with a deliberate fail-closed policy.** `SET NX EX` is
   atomic across workers, and the refusal to degrade to a process-local lock when Redis is
   configured-but-down is a considered safety trade-off, documented in place and covered by
   a dedicated test ([kv.js:405-445](Backend/src/cache/kv.js#L405-L445),
   `tests/unit/redis/lockFailClosed.test.js`).

3. **Layered, coherent live-state architecture.** Redis-primary/PostgreSQL-durable with an
   explicit fallback cascade at every read site, an in-process cache for the telemetry hot
   path, and documented coupling constants for the liveness invariants
   ([liveness.constants.js](Backend/src/config/liveness.constants.js)).

4. **Graceful degradation of every external dependency except the lock.** Mapbox Matrix,
   Mapbox Directions, the zone store, and the registry all have fallback paths that keep
   assignment functioning.

5. **Bounded retry with exclusion.** The reservation-contention loop cannot spin on the
   same candidate and cannot run unbounded
   ([task.service.js:171-210](Backend/src/services/task.service.js#L171-L210)).

6. **Strict one-task-per-robot invariant**, enforced redundantly at four layers and backed
   by a database-level relation (§10.4).

7. **Coherent cross-boundary charging protocol.** The 30 % interrupt threshold is
   centralized in one constants file specifically so the server-side gate and the
   robot-side deferral cannot diverge
   ([dtaro.constants.js:1-8](Backend/src/config/dtaro.constants.js#L1-L8)).

8. **Decision auditability.** Per-allocation logging of candidates, components, rejection
   reasons, and winner, plus a persisted allocation metric with selection latency.

9. **Clustering-correct dispatch.** All server-to-robot delivery goes through
   adapter-aware room emits rather than the process-local socket map, with a loud guard
   against the two-argument call form that previously made re-dispatch a silent no-op
   ([commandDispatcher.service.js:54-62](Backend/src/services/commandDispatcher.service.js#L54-L62)).

10. **Restart resilience.** Active tasks are re-hydrated into Redis and re-dispatched on
    boot, with routes recomputed from the robot's last known position.

### 16.3 Current limitations

**Decision-scope limitations:**

1. The objective function excludes the delivery leg entirely — `selectNearestRobot` never
   receives the drop coordinates (§13.3).
2. Distance is always crow-flies, never road distance, even when Mapbox is fully available
   (§5.4).
3. The candidate search is truncated at 100 rows with no ordering (§3.3).
4. `T` is weighted at 0.05 and cannot correct `D` in any realistic disagreement (§5.7).
5. `U` is bounded to a ~40 s horizon with no durable store, and its effective range for
   idle candidates is roughly half its nominal weight (§5.6).
6. Weights are compile-time constants with no runtime tuning surface (§5.1).

**Lifecycle limitations:**

7. `TASK_ASSIGN` has no acknowledgement, and the dispatch result is discarded (§8.3).
8. No timeout exists on assignment, on Mapbox calls, or on `ASSIGNED` tasks (§9.9, §15.3).
9. Assignment failure is terminal — no queue, no requeue, no retry (§7.5, §9.14).
10. `IN_PROGRESS` and `Task.startedAt` are never written, so "assigned" and "under way" are
    indistinguishable (§2.7).
11. No reassignment on disconnect, fault, or battery exhaustion (§9.4-9.6).

**Safety-margin limitations:**

12. Battery validation is an absolute instantaneous floor with no mission energy model
    (§15.4).
13. Several rules fail open on missing registry data, and the data is most likely missing
    when the robot is least healthy (§6.5, §14.2 f-g).
14. The auth-integrity rule H10 is logically unreachable as written (§4.8).
15. Battery and health are validated before the reservation but not re-checked at
    finalization (§15.1).

**Concurrency limitations:**

16. Mutual-exclusion correctness depends on finalization completing inside the 30 s TTL,
    which is unenforced while up to six sequential Mapbox round-trips occur inside that
    window (§7.7).
17. `releaseReservation` has no ownership check, permitting cross-release after a TTL
    expiry (§7.6).
18. The finalization transaction runs at READ COMMITTED and is not a serializable guard
    (§7.4).
19. Cancelling a `PENDING` task with an in-flight assignment silently reverts the
    cancellation (§8.5).

### 16.4 Implemented capabilities

- Multi-criteria weighted scoring with min-max and absolute normalization.
- Hard eligibility gating on status, connectivity, task-binding, battery, and fault.
- Distinct charging-robot eligibility with a higher battery floor, coordinated across the
  server/robot boundary.
- Live-state overlay with a documented Redis→PostgreSQL fallback cascade.
- Batched registry reads (`MGET`) and batched Mapbox Matrix requests (24 origins/request).
- Distributed reservation locking with a fail-closed policy and TTL backstop.
- Bounded selection retry with candidate exclusion.
- Zone-based locality preference with a three-tier zone cache.
- Multi-profile route generation with a dense straight-line fallback.
- Room-based, cluster-safe task dispatch with retry on an empty room.
- Restart recovery: Redis re-hydration plus timed re-dispatch of active tasks.
- Backstop offline detection reconciled against the live registry.
- Obstacle knowledge base with TTL expiry, route-intersection detection, alert
  dissemination, and A* replanning (post-assignment only).
- Per-allocation decision logging and metric recording.
- Operator controls: cancel, reroute, STOP/PAUSE/RETURN/RESUME commands with ACK tracking
  and a retry-to-FAILED reliability scheduler, and an explicit fault-clear workflow.

### 16.5 Missing capabilities

- Delivery-leg and total-mission distance as decision inputs.
- End-to-end mission time estimation.
- Payload weight/volume modelling (task side) and capacity modelling (robot side).
- Robot capability or type matching.
- Projected post-mission battery and a reserve applied to that projection.
- Route complexity, road class, or congestion as decision inputs.
- Obstacle awareness at selection time.
- Operational reliability history as a decision input.
- Graded health (`DEGRADED` is defined but never written and never consulted).
- Graded workload or per-robot task queueing.
- Task queueing, requeue, or retry after assignment failure.
- Task priority, deadlines, or aging.
- Anti-starvation or fairness guarantees.
- Task acknowledgement, rejection, or delivery confirmation.
- Assignment or mission timeouts.
- Mid-mission reassignment or preemption.
- Batch/global optimization across concurrently created tasks.
- Runtime weight tuning.
- Completion verification against drop coordinates.
- Location- or campus-scoped candidate filtering.

### 16.6 Final assessment

The implementation is **internally consistent and defensible within its own scope**. Where
the code makes a non-obvious trade-off — the fail-closed lock, the throttled DB flush
against the offline cutoff, the additive `w5`, the `ISSUES`-as-navigating treatment — the
reasoning is documented in place and, in several cases, covered by a dedicated test. The
engineering quality of what is built is high.

The gap against the stated allocation philosophy is therefore not a quality gap but a
**scope gap**, and it is concentrated: three of the eighteen desired parameters are fully
implemented, six are partially implemented, and nine are absent. Seven of the nine absences
trace to a single architectural fact — `selectNearestRobot` receives the pickup point and
nothing else about the mission. Three more trace to a domain model that has no concept of
task type or robot type.

The most consequential correctness observations, independent of the desired philosophy,
are: the discarded dispatch result (§8.3), the unenforced 30 s finalization budget on which
mutual exclusion depends (§7.7), the silent reversion of a cancellation racing an in-flight
assignment (§8.5), and the absence of any timeout or reassignment path for a task that
stalls after being assigned (§15.3).

---

## Appendix A — Traceability Index

| Concern | Primary file(s) |
|---|---|
| Cost function | `src/services/costEvaluator.service.js` |
| Candidate pipeline | `src/services/taskAssignment.service.js` |
| Eligibility rules | `src/services/robotValidator.service.js` |
| Orchestration, reservation, retry, finalization | `src/services/task.service.js` |
| Reservation primitive, fail-closed policy | `src/cache/kv.js` |
| Live state | `src/services/robotRegistry.service.js` |
| Utilization production | `src/sockets/handlers/telemetry.handler.js` |
| Zones | `src/services/zoneManager.service.js` |
| Travel time / routing | `src/services/mapbox.service.js`, `src/services/routing.service.js` |
| Dispatch | `src/services/commandDispatcher.service.js` |
| Lifecycle events | `src/sockets/handlers/dtaro.handler.js`, `src/sockets/handlers/robot.handler.js` |
| Cancellation | `src/controllers/tasks.controller.js` |
| Recovery | `src/services/taskRecovery.service.js`, `server.js` |
| Liveness | `src/sockets/socket.server.js`, `src/config/liveness.constants.js` |
| Thresholds | `src/config/dtaro.constants.js`, `src/simulation/constants.js` |
| Robot behaviour model | `src/simulation/VirtualRobot.js` |
| Schema | `prisma/schema.prisma` |

## Appendix B — Behavioural Tests Covering the Assignment Path

| Test | Covers |
|---|---|
| `tests/unit/dtaro/taskAssignment.test.js` | Candidate query shape, 409 paths, min-cost selection, `excludeRobotIds`, Matrix fallback, live-position overlay, input validation |
| `tests/unit/dtaro/costEvaluator.test.js` | Cost computation |
| `tests/unit/dtaro/robotValidator.test.js` | Eligibility rules |
| `tests/unit/dtaro/reservationLocking.test.js` | Reservation semantics |
| `tests/unit/dtaro/zoneLocality.test.js` | `Z` term |
| `tests/unit/redis/lockFailClosed.test.js` | Fail-closed lock policy |
| `tests/unit/redis/liveRobotIndex.test.js` | `robots:all` membership |
| `tests/unit/tasks/taskService.test.js` | Assignment orchestration |
| `tests/unit/tasks/tasksControllerCancel.test.js` | Cancellation |
| `tests/unit/tasks/taskRecovery.test.js` | Restart recovery |
| `tests/unit/tasks/dtaroHandlerTaskComplete.test.js` | Completion handling |
| `tests/unit/sockets/commandDispatch.test.js` | Room-based dispatch |
| `tests/integration/robotCommandRoundTrip.test.js` | End-to-end command path |

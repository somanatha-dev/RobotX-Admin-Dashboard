# RobotX Current Communication Audit

**Audit date** 2026-08-22
**Repository** `c:\Users\soman\OneDrive\Desktop\RobotX`
**Branch** `feature/dashboard`
**Commit** `450d829e8493ff61946bbebd646ac12ff3a07372` — *"phase 15 blocker still exists"*
**Working tree** CLEAN (`git status --porcelain` → empty)
**Runtime switch state** `ENGINE_ENABLED=false`, `AGENT_MTLS_REQUIRED=false` (`Backend/.env`)

### Scope inspected

| Area | Path |
|---|---|
| Socket server + handlers | `Backend/src/sockets/**` |
| Legacy DTARO services | `Backend/src/services/**` |
| Next-generation engine | `Backend/src/engine/**` |
| Workers / composition root | `Backend/src/workers/**`, `Backend/server.js` |
| Agent implementation | `Backend/src/simulation/VirtualRobot.js` |
| Persistence schema | `Backend/prisma/schema.prisma` |
| Dashboard client | `Frontend/src/**` |
| Documentation (as *claims*, not evidence) | `ARCHITECTURE.md` |

### Exact commands and tools used

```
git rev-parse HEAD ; git status --porcelain ; git branch --show-current
git log --oneline e5c9655..HEAD ; git diff --stat e5c9655..HEAD
git log --oneline -S "seedTaskKeys" --all -- Backend/src

# room / emitter sweep (ripgrep via the Grep tool)
socket\.join\(|socket\.leave\(|io\.to\(|io\.in\(|socket\.to\(|\.emit\(   over Backend/src
plannedPath                                                              over Backend/**  (non-node_modules)
setPlannedPath|updatePlannedPath                                         over Backend/src, server.js, tests
\.zoneId                                                                 over Backend/src, server.js
socket\.on\("                                                            over Backend/src/sockets, VirtualRobot.js
adapter|createAdapter|new Server|pubClient|subClient                     over Backend/server.js

# Paper 1 dossier ("audit paper.pdf", 37 pp) — image-only PDF, no text layer.
#   verified: /Subtype /Image only, no font objects, glyphs are vector outlines.
#   rendered to PNG at 110 dpi with pymupdf and read visually.

# EXECUTED verification of the live obstacle path (harness lives OUTSIDE the repo,
# in the session scratchpad; imports production modules unmodified):
node <scratchpad>/verify_dissemination.js
```

> **Read-only.** No source, test, or configuration file in this repository was created,
> modified, or deleted by this audit. The only file added is this document. The
> verification harness referenced above lives in the session scratchpad, imports the
> production modules unchanged, and is not part of the repository.

### A note on the pre-existing "Paper 1 audit"

The brief refers to a prior artefact, *"audit paper(3).pdf"*. The file present on this
machine is `C:\Users\soman\OneDrive\Desktop\audit paper.pdf` (37 pp, 2026-08-22). It is
**not Paper 1** — it is a prior *dossier auditing* Paper 1, taken against baseline
**`e5c9655`**, which is one commit behind this tree. It is used here for two things only:
as a statement of what Paper 1 claims (its §02 decomposes Paper 1's eight mechanisms), and
as a set of prior findings to independently re-test. Its verdicts are **not** treated as
evidence. Every conclusion below was re-derived against `450d829`.

`git diff --stat e5c9655..HEAD` shows the intervening commit touched six socket-layer files
(`socket.server.js`, all four handlers, `commandDispatcher.service.js`) but **no** file in
the zone / EKB / route-intersection / dissemination path. The communication findings are
therefore unchanged by the intervening commit — re-verified below rather than assumed.

---

## 1. Executive Summary

**Transport is healthy. Command authority is strong. Dissemination is dead.**

The current system runs one Socket.IO 4 transport with a Redis adapter, two real rooms
(`dashboard`, `robot:{robotId}`), certificate-capable agent authentication, and a
transactional-outbox command path with two-scope fencing, per-scope sequencing,
deduplication and mandatory ACK. Measured against Paper 1, the *transport* and *command
integrity* layers are far ahead of anything Paper 1 describes.

The *environmental-awareness* half is a different story. Paper 1's headline mechanism —
zone-scoped dissemination of obstacle reports through per-zone Socket.IO rooms — is
**not implemented and never was**. Robots join `zone:{zoneId}` rooms and leave them on
boundary crossings, but **no code path anywhere in the repository emits to a `zone:*`
room**. Zone rooms are a membership structure with zero subscribers' worth of traffic.

What RobotX implements instead is a *different and, in principle, better* algorithm:
server-side route-intersection over the whole live fleet, unicast to `robot:{robotId}`.
That algorithm has no zone false-negatives. **But on the current tree it cannot fire**,
for reasons I confirmed by executing the production path rather than reading it.

### Verified findings — obstacle pipeline

I ran `services/alertDissemination.service.processObstacleReport` — the real function,
imported unmodified — against a registry populated exactly the way the live telemetry
handler populates it, with two robots online and one whose route passes straight through
the obstacle.

| # | Finding | Verified how | Severity |
|---|---|---|---|
| **C-1** | **No emitter to any `zone:*` room exists.** Rooms are joined and left; nothing is ever sent to one. | Repo-wide grep for `io.to(`/`io.in(`/`socket.to(` — every hit is `dashboard` or `robot:{id}`. Executed path: **0** zone emits. | Paper 1's headline mechanism is absent |
| **C-2** | **`plannedPath` is never seeded, so route-intersection always returns `[]`.** The only writer is `routing.service.rerouteRobot` — which runs *only after* a robot has already been selected as affected. The predicate gates its own input. | Executed: real production state → `affectedRobotIds: []`, **zero** `REROUTE_ALERT` emitted. Force-seeding `plannedPath` → `["R-CROSS"]` and the alert fires. | **Fleet-facing obstacle response is inert** |
| **C-3** | **The `REROUTE_ALERT` payload does not satisfy the agent's own handler contract.** Dissemination sends `{obstacleId, lat, lon, zoneId, severity, timestamp}`; `VirtualRobot._onRerouteAlert` acts only on `newPath` or `obstacleLocation` and returns silently otherwise. | Executed: fed the real payload to the real handler — `pathIndex 0 → 0`, `activePath` unchanged. A no-op. | Even if C-2 were fixed, delivery would do nothing |
| **C-4** | **The point-obstacle model is direction-sensitive.** A point obstacle is modelled as one SW→NE diagonal segment (`POINT_OBSTACLE_DELTA`). `segmentsIntersect` treats parallel segments as non-intersecting, so a robot driving *straight down the obstacle's own axis, through the obstacle point*, is classified unaffected. | Executed: `findAffectedRobots` with a parallel path through the obstacle → **not** detected. | New — not in the prior dossier |

C-1 through C-3 corroborate the prior dossier's "3 independent breaks". **C-4 is a fourth,
found by execution, and is not in the prior dossier.**

### Verified findings — documentation vs implementation

| Document | Claim | Reality |
|---|---|---|
| `ARCHITECTURE.md` §3.9 (line 328) | *"The server computes which robots' planned paths **geometrically intersect** the obstacle (`routeIntersection.service`) and reroutes only those, rather than replanning the fleet."* | **False on this tree.** The computation runs, over an input that is always empty, and reroutes nobody. Recording works; the fleet-facing half cannot fire. |
| `ARCHITECTURE.md` line 155 | `rooms: dashboard, robot:{id}` | **Accurate.** It correctly does *not* list zone rooms. |
| `zoneManager.service.js` docstring (lines 127–140) | Justifies the registry write by the DTARO cost function's *Z* term in `costEvaluator.service.js`, and by `taskAssignment.service.js` reading `Robot.zoneId`. | **Both named consumers were deleted at Phase 15.** Neither file exists. The docstring describes a dependency graph that no longer exists. |

### The one-line answer to the brief's §9

Paper 1's communication architecture is **better in exactly one respect** — it has a
trajectory-relevance predicate that is *wired to a real input*, which RobotX's is not — and
**worse or absent in every other respect**: transport reliability, authentication, command
integrity, determinism, and cross-worker correctness. Its central mechanism (zone scoping)
is one RobotX should **not** adopt, because it trades correctness for message count in a
system whose entire design philosophy resolves unknowns in the safe direction.

---

## 2. Current Robot ↔ Backend Communication

### 2.1 Transport and connection establishment

Socket.IO 4 over the same HTTP server as the Express app.

```
Backend/server.js:304-312     http.createServer(app) → new Server(server, { cors: … })
Backend/server.js:363         app.locals.io = io
Backend/src/sockets/socket.server.js:193   io.on("connection", …)
```

There is **one namespace** (the default `/`). `io.of(…)` appears nowhere in `Backend/src`
or `server.js` — namespaces are not used.

On connection, the server splits traffic into two populations by a **heuristic**, before
any authentication:

```js
// socket.server.js:194-196
const origin = socket?.handshake?.headers?.origin;
const ua     = socket?.handshake?.headers?.["user-agent"];
const isDashboard = !!(origin || (typeof ua === "string" && ua.includes("Mozilla")));
```

> **Observation (O-1).** This is a *routing* heuristic, not an authentication decision, and
> it is safe in that direction: a robot misclassified as a dashboard is required to present
> a JWT and is disconnected without one; a browser misclassified as a robot simply never
> joins `dashboard`. It is worth recording only because the two populations' authentication
> schemes are entirely disjoint and the split that selects between them is a `User-Agent`
> substring match.

### 2.2 Dashboard authentication

```
socket.server.js:30-47    getDashboardToken — `token` cookie (the same cookie REST auth
                          uses), falling back to handshake.auth.token
socket.server.js:207-219  verifyUserToken(token) → on failure: emit UNAUTHORIZED, disconnect(true)
socket.server.js:221-222  socket.data.userId = user.id; socket.join("dashboard")
socket.server.js:230-254  re-hydration: replays TASK_ASSIGNED for every ASSIGNED/IN_PROGRESS
                          task with a cached `taskPath:{taskId}`, to this socket only
```

### 2.3 Robot authentication — the `AUTH` event

`Backend/src/sockets/handlers/robot.handler.js:431-700`. The full ordered sequence:

| # | Step | Evidence |
|---|---|---|
| 1 | Rate limit — 5 / 60 s, 100 ms floor | `robot.handler.js:433` |
| 2 | Zod parse (`robotId` required; `token`, `pairingCode`, `dedupState`, `certificate` optional; `.passthrough()`) — failure ⇒ `disconnect(true)` | `:412-436` |
| 3 | `prisma.robot.findUnique` — an uncommissioned `robotId` ⇒ `disconnect(true)` | `:448-452` |
| 4 | Seed `robotStateCache` so the telemetry hot path needs no per-tick DB read | `:453-460` |
| 5 | **Reject capability claims** on the AUTH payload (§23.2/§23.5) and log them as a security event | `:462-464`, `:260-272` |
| 6 | **Certificate session** (§23.2): peer cert from Node TLS, `x-client-cert` proxy header, or the auth payload. Establishes `(agent_id, certificate, session_id)` binding | `:466-494`, `:186-230` |
| 7 | Otherwise: session-token reconnect, or pairing-code bootstrap with brute-force lockout (5 attempts → 1 h) | `:496-572`, `:65-66` |
| 8 | Bind socket ↔ robot; `socket.data.robotId`, `socket.data.isAuthed = true`; disconnect the previous socket for this robot | `:574-613` |
| 9 | **Resolve and cache shard identity once** (`agentGate.resolveIdentity` → `bind`). Failure is non-fatal to the connection but refuses every engine write path for the session | `:595-603` |
| 10 | `kv.set("socket:{socket.id}", robotId, {ex:3600})`; `markRobotOnline` (DB `isOnline`, `socketId`, `lastSeenAt`) | `:606-608` |
| 11 | **Dedup handshake** (§11.5) — gated on `agentGate.assess()`, i.e. both halves of the cutover switch | `:621-634`, `:295-357` |
| 12 | `AUTH_SUCCESS` + `AUTH_OK` (alias), carrying `token`, `dedup`, and a `session` descriptor naming which scheme admitted the agent | `:640-653` |
| 13 | `io.to("dashboard").emit("robot_online")` | `:655` |
| 14 | **`socket.join("robot:{robotId}")`** | `:658` |
| 15 | `markOnline(kv, …)`; `kv.sadd("robots:all", robotId)` | `:661-673` |
| 16 | Zone assignment from last known position, if the registry still holds one | `:675-685` |

> **Observation (O-2) — ordering.** The agent is told `AUTH_SUCCESS` at step 12 but does not
> join its command room until step 14. A command dispatched in that window finds an empty
> room. `commandDispatcher.dispatch` retries with back-off and `deliverOutboxCommand`
> leaves the outbox row `PENDING`, so nothing is lost — but the window is real and is
> avoidable by joining before emitting.

> **Observation (O-3) — zone room at AUTH is conditional.** Step 16 runs only if the
> registry entry still holds `lat`/`lon`. The registry key has a 30 s TTL
> (`robotRegistry.service.js:38`), so an agent reconnecting after a gap joins **no** zone
> room at AUTH. It joins on its first telemetry tick instead (`prevZoneId` is `null`, so the
> change branch fires). Since nothing emits to zone rooms, this is currently inert.

### 2.4 What the robot may send

| Event | Handler | Auth required | Rate limit |
|---|---|---|---|
| `AUTH` | `robot.handler.js:431` | — (establishes it) | 5 / 60 s, 100 ms |
| `HEARTBEAT` / `heartbeat` | `robot.handler.js:771-773` | `socket.data.robotId` | 10 / 5 s, 100 ms |
| `TELEMETRY` / `telemetry` | `telemetry.handler.js` | **yes — F26**, `isAuthed` *and* `robotId`, else `AUTH_REQUIRED` | 50 / 5 s, 100 ms |
| `OBSTACLE_REPORT` | `dtaro.handler.js:65` | yes | 10 / 60 s, 500 ms |
| `TASK_COMPLETE` | `dtaro.handler.js:103` | yes | 5 / 30 s, 1 s |
| `ROBOT_FAULT` | `dtaro.handler.js:215` | yes | 5 / 60 s, 1 s |
| `COMMAND_ACK` | `command.handler.js:82` | yes (for the outbox half, via `agentGate`) | 20 / 60 s, 100 ms |
| `OFFER_ACCEPT` / `OFFER_REJECT` / `OFFER_DEFER` | `offer.handler.js` | yes | — |
| `SESSION_REKEY_ACK` | `robot.handler.js:867` | binding required | 10 / 60 s, 100 ms |
| `assign_task` | `socket.server.js:317` | **none** | **none** |

> **Observation (O-4) — `assign_task`.** This handler is registered on *every* socket,
> including robot sockets, and performs no `isAuthed` check and no rate limiting. It is
> intended as the legacy dashboard path. Its blast radius today is nil — `task.service.assignTask`
> refuses with `ENGINE_NOT_LIVE` while the engine is off, and dashboard sockets are
> authenticated or disconnected — but the handler itself is unauthenticated on the robot
> data plane, and the comment block above it (`socket.server.js:289-316`) describes it as a
> retiring compatibility surface. Recorded, not recommended for change in this audit.

Rate limiting is per-`(socket.id, event)`, in-process, in-memory (`sockets/rateLimit.js`) —
a fixed window plus a hard minimum spacing, with opportunistic map cleanup at 50 000 entries.

### 2.5 What the backend may send

**Legacy / host-platform events** — `TASK_ASSIGN`, `REROUTE_ALERT`, `COMMAND`, `STOP`,
`RETURN_TO_BASE`, `SESSION_REKEY`, `AUTH_SUCCESS`, `AUTH_OK`, `AUTH_REQUIRED`,
`OBSTACLE_REPORT_ACK`, `TASK_COMPLETE_ACK`, `ROBOT_FAULT_ACK`, `ERROR`, `UNAUTHORIZED`.

**§10.3.1 engine commands** — each command name is *its own wire event*, deliberately, so
an agent subscribes per-command rather than switching on a type field inside one opaque
envelope (`commandDispatcher.service.js:304-308`; agent side `VirtualRobot.js:348-356`):

- Mission-scope (fenced by commitment): `OFFER`, `WITHDRAW`, `REROUTE`, `RESEQUENCE`, `RECALL`, `RESUME`, `TRANSFER_CUSTODY`, `ABORT_MISSION`
- Agent-scope (fenced by authority epoch): `STAND_DOWN_ALL`, `QUARANTINE`, `RELEASE_QUARANTINE`, `ESTOP_CLEAR`, `SHARD_MIGRATE`, `SESSION_REKEY`, `PARAMETER_PUSH`
- Queries (never fenced): `STATUS_REQUEST`, `PROBE`, `MANIFEST_QUERY`

(`engine/commitment/fencing.js:59-82`.)

### 2.6 Telemetry handling

`telemetry.handler.js`, ~1 043 lines. Per tick: backpressure drop → rate limit → Zod →
**F26 auth gate** (`:398-404`) → one batched Redis read → validation → a *single* merged
registry read-modify-write covering telemetry fields, a utilisation EMA and zone membership
(`:779-822`) → throttled Postgres mirror → optional `Telemetry` snapshot → one pipelined
Redis write (`:856-858`) → `io.to("dashboard").emit("robot:update", fullState)` (`:882`) →
Phase 5 progress-supervision signals.

The zone lookup is in-process cached and off the Redis path; the zone *change* branch
(`applyZoneChangeSideEffects`) runs only on an actual crossing (`:824-834`).

### 2.7 Heartbeat handling

`robot.handler.js:708-769`. Redis liveness on **every** beat
(`setRobotState({lastHeartbeat, connected})`); the durable `Robot.lastSeenAt` mirror is
throttled to `DB_FLUSH_INTERVAL_MS`. The same throttle carries two riders: the cached shard
identity refresh (`agentGate.resolveIdentity` → `bind`, `:758-765`) and, for certificate
sessions, the §23.2 revocation re-check and rekey (`maybeRekeySession`, `:793-865`).

Offline detection has two owners and exactly one is active at a time
(`socket.server.js:184-188`): the reconciler when the engine is on, the legacy sweep when it
is off. The legacy sweep is Redis-aware — it consults `registry.lastHeartbeat` before
marking a robot offline, because both TELEMETRY and HEARTBEAT throttle their DB writes
(`socket.server.js:80-144`).

### 2.8 Command delivery, sequencing, deduplication, fencing

There are **two** server→agent command paths, and they are not equivalent.

**Path A — legacy typed helpers** (`commandDispatcher.service.js:118-171`).
`dispatchTaskAssign`, `dispatchRerouteAlert`, `dispatchCommand`, `dispatchStop`. Each
resolves the room `robot:{robotId}`, does an adapter-aware presence check via
`io.in(room).fetchSockets()`, emits, and retries with back-off on an empty room. **No fence,
no sequence, no expiry, no signature.** The file says so explicitly (`:183-194`).

**Path B — the outbox delivery arm** (`commandDispatcher.service.js:209-313`), the *only*
route by which a §10.3.1 command reaches an agent (§4.1 rule 5):

- §18.5 degraded-mode gate at the single exit — `activeModes` may be an async accessor and is `await`ed; an accessor that throws **refuses** delivery rather than failing open (`:253-276`)
- presence check → `io.to(room).emit(envelope.command, envelope)`
- **no local retry** — retry is the drain worker's escalation ladder; "no socket connected" leaves the row `PENDING` and is a *state*, not a discard (`:297-302`)

**Sequencing** — `engine/dispatch/sequence.js`. Two disjoint namespaces per §10.5: mission
commands keyed `(commitment_id, command_sequence, fence)`, agent commands keyed
`(agent_id, command_sequence, authority_epoch)`. A gap **holds** rather than skips
(`ORDERING_DISPOSITION.HELD_FOR_ORDER`), bounded by the command's own `not_valid_after`.

**Deduplication** — `engine/dispatch/dedupHandshake.js`, run at AUTH. The agent reports its
`dedup_state_generation`, `authority_epoch`, `fence_floor` and per-commitment high-water
marks; the server classifies and may suppress outbox rows and advance the epoch. Gated on
`agentGate.assess()` — both halves of the cutover switch, not just the process flag.

**Fencing** — `engine/commitment/fencing.js`, two scopes (commitment, agent).

**ACK** — `command.handler.js:82-164`, one event with two readings. `outboxId` ⇒ settle an
outbox row, but only after comparing the agent's echoed `fence` and `authorityEpoch` against
the row's (`:54-66`) — an ACK generated under a superseded authority cannot close a row that
superseded it. `commandId` ⇒ the legacy `Command` row → `ACK`, response time recorded.

### 2.9 Redis, the Socket.IO adapter, and multiple workers

```
Backend/server.js:2-3      require("socket.io"); require("@socket.io/redis-adapter")
Backend/server.js:327-349  attach when REDIS_ENABLED !== "false" AND REDIS_URL is set;
                           awaits both pub and sub "ready"; io.adapter(createAdapter(...))
                           on failure: LOUD warn, fall back to the default in-process adapter
```

**Yes, Redis is involved in Socket.IO transport, and the adapter is active** whenever Redis
is reachable and configured. This matters for correctness, not throughput: `io.to(room)`,
`io.in(room).fetchSockets()` and `io.in(room).disconnectSockets()` all traverse the adapter
and therefore reach sockets owned by *other* worker processes.

The codebase depends on that in three places beyond ordinary broadcast:

- every command dispatch (`commandDispatcher`) — deliberately, so a REST request landing on worker A can command a robot connected to worker B
- shard-migration session invalidation — `io.in("robot:{agentId}").disconnectSockets(true)` (`server.js:793`)
- the §23.2 revocation sweep — which deliberately enumerates **only this process's** sockets (`io.sockets.sockets.values()`, `server.js:845-855`), because a socket owned by another process is one this process cannot close; each worker sweeping its own is what makes coverage complete without a cross-process command

`sockets/robotSockets.js` is a **process-local** `Map`. It is used for presence and identity
checks only. The header of `commandDispatcher.service.js` (`:1-32`) states the rule plainly:
nothing may reach for `getRobotSocket()` to *deliver* a payload.

**If the backend runs multiple workers:** correct, provided Redis is up. If Redis is
unreachable the adapter silently degrades to single-process and cross-worker broadcast stops
working — which is why that fallback is logged as loudly as it is. Multi-worker operation is
exercised by `Backend/benchmark/orchestrator.js` (nginx upstreams, `WORKER_COUNT`).

---

## 3. Current Socket.IO Architecture

```
                    ┌───────────────── one Socket.IO 4 server, default namespace ─────────────────┐
 browser  ──JWT──▶  │  room "dashboard"                                                            │
 (Mozilla/Origin)   │     ← ~20 UI events                                                          │
                    │                                                                              │
 robot    ──AUTH─▶  │  room "robot:{robotId}"                                                      │
 (cert | token |    │     ← TASK_ASSIGN, REROUTE_ALERT, COMMAND, STOP, SESSION_REKEY,              │
 |  pairing code)   │       and every §10.3.1 command as its own event                             │
                    │                                                                              │
 robot (on zone     │  room "zone:{zoneId}"                                                        │
  crossing)         │     ←  ✗  NOTHING. Zero emitters in the entire repository.                   │
                    └──────────────────────────────────────────────────────────────────────────────┘
                                        │
                              @socket.io/redis-adapter
                                        │
                        fan-out across worker processes
```

---

## 4. Current Socket.IO Rooms

Complete enumeration. Every `join`/`leave`/`to`/`in` in `Backend/src` and `server.js` was
inspected; there are no others.

| Room | Who joins | Why it exists | Who receives messages | Current status | Evidence |
|---|---|---|---|---|---|
| `dashboard` | Browser clients, after JWT verification | Scope UI events to browsers instead of `io.emit` to every socket (the old O(N²) fan-out) | `robot_online`, `robot_offline`, `robot:update`, `robot_unregistered`, `ROBOT_UPDATE`, `ROBOT_UPDATED`, `ROBOT_COMMISSIONED`, `TASK_CREATED`, `TASK_UPDATED`, `TASK_ASSIGNED`, `task_accepted`, `task_assigned`, `task_error`, `ALERT_CREATED`, `REROUTE_ALERT`, `ZONE_UPDATED`, `COMMAND_STATUS`, `OFFER_RESPONSE`, `SECURITY_EVENT`, `SUPERVISION_SIGNAL`, shard-supervisor events | **LIVE** | join `socket.server.js:222`; emitters across `socket.server.js`, all 4 handlers, `tasks.controller.js:302`, `robots.controller.js:45,79,512`, `task.service.js:397,526`, `routing.service.js:212`, `zoneManager.service.js:202`, `alertDissemination.service.js:54,103`, `server.js:812` |
| `robot:{robotId}` | The robot itself, at the end of `AUTH` | Adapter-aware, cross-worker addressing of one agent by identity rather than by socket handle | `TASK_ASSIGN`, `REROUTE_ALERT`, `COMMAND`, `STOP`, all 18 §10.3.1 commands; also the target of `disconnectSockets()` | **LIVE** | join `robot.handler.js:658`; emit `commandDispatcher.service.js:105,308`, `alertDissemination.service.js:101`; disconnect `server.js:793,859` |
| `zone:{zoneId}` | The robot, on a zone change (from `AUTH` if a cached position exists, otherwise from the first telemetry tick) | *Intended* as Paper 1's zone-scoped dissemination substrate | **NOBODY — no emitter exists** | **DEAD (membership only)** | join `zoneManager.service.js:115`; leave `:112`; callers `robot.handler.js:681`, `telemetry.handler.js:826`. **No `io.to("zone:…")` anywhere.** Executed path emitted 0 zone messages. |

**Rooms that do NOT exist**, despite appearing in documentation or in Paper 1:

- **campus rooms** — none. `campus.service.js` has no socket surface.
- **location rooms** — none. `location.service.js` has no socket surface.
- **namespaces** — none. `io.of(…)` appears nowhere.
- **shard rooms** — none. Shard events go to `dashboard`; shard-scoped agent actions address `robot:{id}` individually.

Socket.IO's implicit per-socket room (`socket.id`) is used only by direct `socket.emit`.

---

## 5. Current Zone Model

The brief asks four separate questions. They have four different answers, and conflating
them is exactly how the current state became invisible.

### 5.1 Is there a geographic zone model? — **YES, and there are two of them**

**Model A — legacy DTARO zones (live on the host platform).**

```prisma
// Backend/prisma/schema.prisma:263-288
model Zone {
  id     String @id @default(uuid())
  name   String @unique
  minLat Float
  maxLat Float
  minLon Float
  maxLon Float
  robots    Robot[]
  obstacles ObstacleEvent[]
  regionId  String?     // Phase 2 §3.6 — the zone as pricing/coverage unit
}
```

Axis-aligned lat/lon **bounding boxes**. Not polygons, not H3, not S2. Seeded lazily at
startup as four quadrants around the campus centre, `delta = 0.005°` (~550 m half-width),
idempotent — skipped entirely if any zone already exists
(`zoneManager.service.js:223-267`; invoked `socket.server.js:152-160`).

**Model B — engine spatial hierarchy (built, not the live decision path).**

`region ⊃ zone ⊃ cell`, where a cell is an **H3** index (`h3-js ^4.5.0`,
`Backend/package.json:49`; `engine/spatial/cells.js`, `hierarchy.js`,
`regionBoundary.js`). Critically, containment is **by published assignment, not by
geometry** — `cells.js:10-27` states this and explains why: deriving containment from
polygon intersection at query time would make a cell's zone depend on floating-point
geometry evaluated per round, which is slow *and* non-deterministic (T6).

**So the two models are opposites on the one property that matters.** Model A resolves
containment by scanning rectangles at query time; Model B rejects exactly that. They share
the word "zone" and the `Zone` table, and nothing else.

### 5.2 Is there a zone *assignment*? — **YES, dynamic, per telemetry tick**

```js
// zoneManager.service.js:93-99 — linear scan, first match wins
zones.find((z) => lat >= z.minLat && lat <= z.maxLat && lon >= z.minLon && lon <= z.maxLon)
```

O(Z) per lookup. Behind a three-tier cache: in-process 60 s → Redis `zones:all` 300 s →
PostgreSQL (`:31-65`).

- **Cached:** yes, three tiers.
- **Persisted:** twice. `registry:{robotId}.zoneId` in Redis on every tick (30 s TTL); `Robot.zoneId` in Postgres **only on an actual change** (`applyZoneChangeSideEffects:190-197`).
- **Dynamic:** yes — recomputed every telemetry tick (`telemetry.handler.js:786-822`).
- **On a boundary crossing:** the Postgres mirror is updated, `socket.leave(old)` / `socket.join(new)` runs, and `ZONE_UPDATED` goes to `dashboard`.

The `undefined` vs `null` distinction is handled deliberately — `undefined` means "position
unknown this tick, don't touch `zoneId`"; `null` means "known position, outside all zones"
(`telemetry.handler.js:792-794`).

### 5.3 Is there a Socket.IO zone room? — **YES, as membership only**

```js
// zoneManager.service.js:109-117
function updateSocketZoneRoom(socket, oldZoneId, newZoneId) {
  if (!socket) return;
  if (oldZoneId && oldZoneId !== newZoneId) socket.leave(`zone:${oldZoneId}`);
  if (newZoneId) socket.join(`zone:${newZoneId}`);
}
```

Membership is maintained correctly and dynamically. That is the whole of it.

### 5.4 Is there zone-scoped message *delivery*? — **NO**

Zero emitters. Confirmed by repo-wide grep and by executing the dissemination path
(0 zone emits in both scenarios). This is the single most important fact in the audit:
**questions 5.1–5.3 all answer "yes" and question 5.4 answers "no", which is precisely why
a reader of the code, the docs, or Paper 1 would conclude the mechanism works.**

### 5.5 Authoritative, or a communication optimisation? — **Neither; it is currently inert**

Sweep of every read of a robot's zone membership (`grep '\.zoneId'` over `src` + `server.js`,
excluding the engine's own zone concept):

| Reader | What it does |
|---|---|
| `robot.handler.js:681` | passes the previous `zoneId` back into `assignRobotToZone` — a **writer** feeding its own change-detection |
| `telemetry.handler.js:802` | reads `existing.zoneId` for the same change detection — again a **writer** |
| `diagnostics.controller.js:139` | an optional operator query filter |

No consumer. Its two documented consumers — the DTARO cost function's *Z* term in
`costEvaluator.service.js`, and `taskAssignment.service.js`'s durable fallback read of
`Robot.zoneId` — **were both deleted at Phase 15**; neither file exists on this tree. The
`zoneManager.service.js` docstring (lines 127–140) still describes them.

The engine does not use it either: it partitions candidates by
`(shard, cell, availability_class)` through `engine/candidates/availabilityIndex.js`, and
resolves an agent's shard from the durable `ShardMembership` row via
`agentGate.resolveIdentity` (`engine/cutover/agentGate.js:152-186`) — not from `Robot.zoneId`.

**Verdict: zone membership is maintained, cached, persisted, and read by nothing.**

---

## 6. Current Obstacle Communication Path

### 6.1 The path as written

```
VirtualRobot.js:1657          socket.emit("OBSTACLE_REPORT", { lat, lon, severity })
        ↓
dtaro.handler.js:65-100       rate limit 10/60s · auth check · Zod
                              { lat:number, lon:number, severity:enum default "MEDIUM" }
        ↓
alertDissemination.service.js:35   processObstacleReport(prisma, kv, io, report)
        │
        ├─ 1  getZoneForCoordinates(lat, lon)                       → zoneId | null   [:39]
        ├─ 2  ekb.storeObstacle(...)                                → Redis + PG      [:43]
        ├─ 3  io.to("dashboard").emit("ALERT_CREATED", …)                             [:54]
        ├─ 4  getAllRobotIds(kv)  →  SMEMBERS "robots:all"  →  N × getRobotState      [:71-79]
        ├─ 5  model the point as a diagonal segment ±0.0002°                          [:82-83]
        │     findAffectedRobots(robotStates, blockStart, blockEnd)                   [:85]
        └─ 6/7 for each affected robot:
                 io.to(`robot:{id}`).emit("REROUTE_ALERT", payload)                   [:101]
                 io.to("dashboard").emit("REROUTE_ALERT", { robotId, …})              [:103]
                 await rerouteRobot(prisma, kv, io, robotId, { obstacleLocation })     [:108]
        ↓
dtaro.handler.js:92           socket.emit("OBSTACLE_REPORT_ACK", { obstacleId,
                                            affectedRobots, timestamp })
```

### 6.2 What is stored (EKB)

`ekb.service.js:42-87`, `storeObstacle`:

| Field | Stored? | Detail |
|---|---|---|
| `obstacleId` | yes | `OBS-{Date.now()}-{crypto.randomInt(100,999)}` |
| `lat` / `lon` | yes | as reported by the agent — **never validated against the agent's own last accepted fix** |
| **timestamp** | yes | `Date.now()` |
| **reporting robot** | yes | `reportingRobotId` |
| **severity** | yes | agent-supplied, one of `LOW`/`MEDIUM`/`HIGH`/`CRITICAL` |
| **zone** | yes | resolved server-side by bounding-box scan |
| **TTL / staleness** | yes | `expiresAt = now + 300 s` (`DEFAULT_TTL_SEC = 300`) |

Three tiers: Redis `ekb:event:{id}` with a native TTL plus a tracking set `ekb:obstacles`
(primary); an in-memory `Map` fallback when Redis is down; a best-effort `ObstacleEvent`
row in Postgres, wrapped in a `try {} catch {}` that silently swallows failure (`:76-84`).

**Expiry** is wall-clock: the Redis key expires by TTL; `sweepExpired` runs every 60 s
(`socket.server.js:163-170`) and prunes IDs whose key has gone; `getActiveObstacles`
additionally filters on `expiresAt > now` and prunes as it reads.

> **Observation (O-5).** The Postgres `ObstacleEvent` row has no TTL and is never deleted —
> only Redis expires. The two stores therefore diverge permanently after 300 s. Since
> nothing reads the Postgres rows except operator diagnostics, this is a data-hygiene note,
> not a correctness break.

### 6.3 Recipient selection — the four verified breaks

**Is a zone room involved?** No. `zoneId` is *recorded on the obstacle* and *sent in the
payload*, but is never used to address anyone.

**Is fleet-wide broadcast involved?** Not in delivery — but the *scan* is fleet-wide:
`getAllRobotIds` does `SMEMBERS "robots:all"`, one unpartitioned global set, then one
`getRobotState` per member. Cost is O(N) Redis reads per report, in N sequential-ish
`Promise.all` round trips. `robotRegistry.service.js:4-21` carries a standing banner
acknowledging this violates §6.1's bounded-work property T9.

**Is robot-specific addressing involved?** Yes — unicast to `robot:{robotId}`.

**Is route relevance checked, and is it used to choose recipients?** Yes to both, in
intent. `routeIntersection.service.js` implements a standard parametric segment-intersection
test over consecutive waypoint pairs, and `findAffectedRobots` is what selects recipients.

**Does it send to all robots in a zone / only affected / broader-then-filter?** By design:
**only affected**, chosen server-side. No local filtering by the agent, no zone tier.

**And here the design stops matching the code.** Executed results:

```
A) PRODUCTION STATE — registry populated exactly as the live telemetry path populates it
   affectedRobotIds: []
   socket emits    : room=dashboard  event=ALERT_CREATED
   emits to any zone:* room: 0

B) COUNTERFACTUAL — plannedPath force-seeded
   affectedRobotIds: ["R-CROSS"]
   socket emits    : room=dashboard      event=ALERT_CREATED
                     room=robot:R-CROSS  event=REROUTE_ALERT
                     room=dashboard      event=REROUTE_ALERT
   REROUTE_ALERT payload keys: obstacleId, lat, lon, zoneId, severity, timestamp

C) PURE PREDICATE
   findAffectedRobots -> ["R-CROSS"]
   R-PARALLEL (drives down the obstacle's own axis, through the obstacle point)
   Detected as affected? -> false

D) AGENT-SIDE CONTRACT — real payload into real VirtualRobot._onRerouteAlert
   has newPath?           : false
   has obstacleLocation?  : false
   agent pathIndex        : 0 -> 0
   agent activePath changed?: false
```

**C-2 — the predicate gates its own input.** `findAffectedRobots` requires
`plannedPath.length >= 2` (`routeIntersection.service.js:82-84`). A repository-wide sweep
for `plannedPath` (excluding `node_modules` and `coverage`) returns **13 hits in 5 files**,
and there is exactly one writer:

| Site | Direction |
|---|---|
| `robotRegistry.service.js:248-250` `updatePlannedPath` | the setter itself |
| `routing.service.js:207` (inside `rerouteRobot`) | **the only caller that writes a path** |
| `tasks.controller.js:295` | writes `null` on task release |
| `alertDissemination.service.js:76` | the reader |
| `routeIntersection.service.js` | the consumer |

`rerouteRobot` runs only *for robots already selected as affected*. So `plannedPath` is
written only after the predicate has already fired, and the predicate cannot fire until it
is written. The telemetry hot path merges `lat, lon, battery, status, speed, lastHeartbeat,
utilization, zoneId` — and **not** `plannedPath` (`telemetry.handler.js:808-817`).

The seeding used to exist. `git log -S "seedTaskKeys"` shows it in `cbe540e`; the current
`task.service.js:14` lists `seedTaskKeys` among the functions **removed** at Phase 15 —
"the Redis writes that made the cache the source of truth for an assignment". Removing the
legacy assignment path removed the only producer of the dissemination path's only input.

`rerouteRobot` has a second, independent early-return on the same cause: it needs
`robotTaskState:{robotId}` (`routing.service.js:176-177`), which the same deletion stopped
writing. And upstream of everything, `POST /api/tasks` returns `503 ENGINE_NOT_LIVE` while
`ENGINE_ENABLED=false`, so no legacy task is assigned at all.

**C-3 — the payload does not meet the agent's contract.** Dissemination sends
`{obstacleId, lat, lon, zoneId, severity, timestamp}` (`alertDissemination.service.js:90-97`).
`VirtualRobot._onRerouteAlert` (`VirtualRobot.js:1128-1160`) acts on `newPath`, else falls
back to `obstacleLocation`, else returns. Neither key is present. Executed: a complete no-op.

By contrast the *operator-initiated* reroute does satisfy the contract — `task.service.js:537-541`
sends `{taskId, segment, newPath}` through `dispatchRerouteAlert`. So the same event name
carries two incompatible payload shapes from two different producers, and only one of them
works.

**C-4 — the obstacle model is direction-sensitive (new).** A point obstacle is modelled as
a single segment from `(lat−δ, lon−δ)` to `(lat+δ, lon+δ)`, δ = 0.0002° — a ~31 m SW→NE
diagonal (`alertDissemination.service.js:23-24, 82-83`). `segmentsIntersect` returns `false`
for parallel segments by construction (`routeIntersection.service.js:29`). A robot travelling
along that same SW→NE bearing — *directly through the obstacle point* — is therefore
classified unaffected. Verified in isolation (scenario C). A disc or an axis-aligned box
would not have this property; one diagonal segment does.

### 6.4 Missed-recipient handling

**None, in either direction.**

- Delivery: `alertDissemination` calls `io.to(...).emit(...)` **directly**, bypassing `commandDispatcher` entirely — so it gets no presence check, no retry, and no delivery result. Both emits are wrapped in `try {} catch { /* ignore */ }`, and the whole per-robot block is inside `Promise.allSettled` (`:88-110`), so every failure is discarded.
- Relevance: nothing measures or records robots that *should* have been notified and were not. There is no false-negative accounting anywhere in the repository.

---

## 7. Current EKB / Environmental Awareness

The EKB exists and works, on the host platform, at the legacy tier. It is the one Paper 1
mechanism that is genuinely live: `OBSTACLE_REPORT → storeObstacle → ALERT_CREATED` is an
executable path, and the dashboard renders it (`Frontend/src/context/AppProvider.jsx:583`).

What it is **not**:

- It is **not** an engine-tier record. `Backend/src/engine/**` has no obstacle store, no environmental model, and no consumer of `ekb.service`. Nothing in the engine imports it.
- It owns **no authoritative state**. Nothing reads `getActiveObstacles` to make a decision. (`grep getActiveObstacles` → the definition, the export, and tests.)
- Its expiry is **clock-based, not evidence-based**. An obstacle ceases to exist at 300 s whether or not it is still physically there. That resolves an unknown in the *permissive* direction, which is the opposite of how every comparable decision in this architecture resolves (§7.3 DENY, ADR-06, ADR-25).
- Severity is **agent-supplied** and unvalidated. The engine's own hazard notion (`obstructionClass`) is specified as derived automatically and never operator-entered.

There is also a **specified-but-unimplemented** requirement on the engine side:
`engine/failure/externalEscalation.js` declares an `affectedMissionIds` input for §18.2 row
A8 (cooperative obstacle notification). Nothing computes it and nothing calls the module in
production. That is RobotX's *own* unmet requirement, independent of Paper 1.

---

## 8. Current Route-Relevance Path

| Property | Current state |
|---|---|
| Where the predicate lives | `services/routeIntersection.service.js` (legacy tier). Nothing equivalent exists in `engine/**`. |
| Algorithm | Parametric cross-product segment intersection over consecutive waypoint pairs; parallel treated as non-intersecting. |
| Purity | Pure function, no I/O, unit-testable — and unit-tested. |
| Where it runs | **Server-side, over the whole live fleet.** Paper 1 places it receiver-side (§III-D, §IV-E, Alg. 2). |
| Its input | `registry:{robotId}.plannedPath` — **never written outside a reroute**. |
| Effective output in production | Always `[]`. Verified by execution. |
| Its authority | In Paper 1 it is an *optimization input* (an agent decides whether to replan). Here it *decides* who gets a command and whose route the server rewrites — **decision-making authority**. |
| Staleness handling | None. A path is used as-is with no freshness bound, and there is no measurement of what a stale path costs. |
| False-negative accounting | None anywhere in the repository. |

The predicate is sound. Its placement (server-side, whole-fleet) is architecturally
*stronger* than Paper 1's zone-then-route composition, because it has no zone
false-negatives. It is simply not connected to anything that produces its input.

---

## 9. Paper 1 Communication Model

From the Paper 1 decomposition in the prior dossier (§02, §04), Paper 1 describes:

- **System model.** One centralized Node.js coordinator; *n* agents on a discrete 2-D grid partitioned into *Z* equal rectangular zones; Socket.IO/WebSocket transport; five event types. Evaluated at n = 8, 20×20 grid, Z = 16, 200 tasks, five obstacle densities, ten runs.
- **M1 — Zone-scoped dissemination.** Map an obstacle at (x, y) to a zone index; emit `zone_alert` **only to that zone's Socket.IO room**. Purpose: break the O(n) coupling between report count and fleet size. Claims no authority — it is a delivery filter.
- **M2 — Route-intersection relevance predicate.** Test whether an agent's planned polyline crosses the obstacle cell; suppress the replan trigger if not. Placed **receiver-side**. *This is the paper's only novelty claim.*
- **M3 — Environmental Knowledge Base.** TTL-scoped obstacle store (300 s) holding location, timestamp, reporter, zone, severity. Redis primary, in-memory fallback, best-effort PostgreSQL mirror, 60 s sweep.
- **M4 — Readiness gate.** Five boolean admission conditions (token, connection, battery floor, no fault, sensor health), evaluated before scoring. Two-valued.
- **M5 — Cost-ranked allocation.** Min-max normalized weighted sum over distance, battery, utilization, estimated completion time; weights (0.45, 0.25, 0.20, 0.10); arg-min, per-arrival, greedy.
- **M6 — Dynamic rerouting.** Mark the obstacle cell infinite-cost, test intersection, run single-robot A* from current position, resume. No inter-agent conflict resolution, no commitment semantics.
- **M7/M8 — Analytical models.** Per-robot communication model (Eqs. 2–6) and coordinator queueing model (Eqs. 7–8).
- **Events.** `obstacle_report`, `task_new`, `task_complete`, `zone_alert`, plus telemetry.

Paper 1's assumptions include: agents uniformly distributed across zones; obstacles
uniformly placed within a zone; **an agent's relevance is fully determined by its current
zone plus its planned path**; round-trip latency ≤ 50 ms with no loss.

---

## 10. Paper 1 vs Current RobotX Comparison

| | Item | Classification | Architectural reason |
|---|---|---|---|
| **A** | Socket.IO transport | **FUNCTIONALLY EQUIVALENT** (RobotX adds cross-process correctness) | Same library, same version family. RobotX adds `@socket.io/redis-adapter` so room addressing is correct across worker processes; Paper 1 assumes a single coordinator process and needs no such thing. Not a better idea — a different deployment target. |
| **B** | Robot authentication | **DIFFERENT BUT STRONGER** | Paper 1: a token as one of five readiness booleans. RobotX: three-state scheme — mTLS with `(agent_id, certificate, session_id)` binding, revocation re-checked periodically *inside* a live session, automated rekey; session token; pairing code as a commissioning bootstrap with brute-force lockout, refused **by name** under `AGENT_MTLS_REQUIRED`. Capability claims on the agent data plane are rejected as security events. |
| **C** | Robot telemetry / status | **FUNCTIONALLY EQUIVALENT**, engineered further | Same idea. RobotX adds backpressure shedding, one batched Redis read and one pipelined write per tick, a throttled durable mirror with a flush-interval/cutoff invariant, sampled logging, and a hard F26 gate requiring AUTH before any frame is accepted. |
| **D** | Robot → backend obstacle reporting | **EXACTLY EQUIVALENT** | `OBSTACLE_REPORT {lat, lon, severity}` → EKB → `ALERT_CREATED`. Same event, same store, same TTL, same sweep. This is the one place the two systems are the same code shape. |
| **E** | Backend → robot alert communication | **DIFFERENT BUT WEAKER — and currently non-functional** | Design is stronger (server-side relevance, unicast, no zone misses). Implementation is inert: C-2 makes the recipient set always empty; C-3 makes the payload a no-op agent-side; delivery bypasses `commandDispatcher`, so there is no presence check, no retry, and no delivery result. Paper 1's equivalent, as described, at least fires. |
| **F** | Socket.IO rooms | **PARTIALLY IMPLEMENTED** | `dashboard` and `robot:{id}` are live and used correctly. `zone:{id}` is membership-only. Two of three rooms carry traffic. |
| **G** | Zone rooms | **SPECIFIED ONLY** | The rooms exist and membership is maintained dynamically and correctly. **No emitter exists.** Paper 1's central mechanism has no counterpart in behaviour. |
| **H** | Dynamic zone membership | **EXACTLY EQUIVALENT** (mechanically) | Recomputed per telemetry tick, `leave` old / `join` new on crossing, mirrored to Redis and (on change) Postgres, `ZONE_UPDATED` to the dashboard. Mechanically this is exactly what Paper 1 §III-B describes. It simply feeds nothing. |
| **I** | Zone-scoped dissemination | **NOT PRESENT** | Zero emitters. Verified by grep and by execution. |
| **J** | Route-intersection filtering | **PARTIALLY IMPLEMENTED** — stronger in placement, non-functional in fact | The predicate is implemented and correct as a pure function, and placed **server-side over the whole fleet**, which strictly dominates Paper 1's zone-then-route composition on relevance (no zone false-negatives). But its input is never produced, so it returns `[]` always; and it carries a direction-sensitivity defect (C-4). Paper 1's version, receiver-side, has a working input by construction — the agent always knows its own path. |
| **K** | EKB | **EXACTLY EQUIVALENT** | Literally the same design: Redis primary + TTL, in-memory fallback, best-effort PG mirror, 60 s sweep, 300 s default. Live and working. Not present at the engine tier. |
| **L** | Obstacle TTL | **EXACTLY EQUIVALENT** | 300 s wall-clock in both. In RobotX this is an *architectural inconsistency*: it resolves an unknown permissively, where every comparable engine decision resolves it conservatively. |
| **M** | Selective notification | **PARTIALLY IMPLEMENTED** | The selection policy is implemented and is a stronger policy than Paper 1's. The selection always selects nobody. |
| **N** | Communication-cost optimization | **NOT PRESENT** (as a measured property) | Paper 1 has an analytical model (Eqs. 2–8) and reports traffic reduction. RobotX has *no* communication-cost measurement of any kind: no message counting, no byte accounting, no coordinator-cost instrumentation, no false-negative column. The dissemination path's per-report cost is O(N) Redis reads over a global set — measured by nothing. |

**Where the classification depends on a distinction the brief asked for:** items G, I, J and
M all differ *only* in which of §5's four questions is being answered. Zone rooms exist
(question 3) but zone-scoped delivery does not (question 4). Route-relevance logic exists
(policy) but selects nobody (behaviour). Reporting "implemented" for any of these would be
true of the code and false of the system.

---

## 11. Transport vs Dissemination vs Authority

The brief asks for these four layers to be kept apart. They are genuinely separable in this
codebase, and the separation is what makes the safe integration analysis in §12 possible.

### Layer 1 — TRANSPORT · *how bytes reach a socket*

Socket.IO 4, one default namespace, `@socket.io/redis-adapter` for cross-worker fan-out;
per-socket rate limiting; backpressure shedding on telemetry; auth heuristics at connection.

**Status: healthy.** Shared with Paper 1 in kind, extended in cross-process correctness.

### Layer 2 — DISSEMINATION POLICY · *who is a recipient*

Room membership (`dashboard`, `robot:{id}`, `zone:{id}`); `getAllRobotIds` fleet
enumeration; `routeIntersection.findAffectedRobots`; the `POINT_OBSTACLE_DELTA` obstacle
geometry.

**Status: the broken layer.** Rooms are joined but one is never addressed; the relevance
predicate is sound but starved; the geometry is direction-sensitive; there is no
false-negative accounting and no cost measurement. Paper 1's contribution lives entirely
here.

### Layer 3 — DECISION AUTHORITY · *what the system decides to do*

`engine/solve/**` (round loop), `engine/candidates/**` (admissibility, lower bound),
`engine/feasibility/**` (38 three-valued predicates with per-predicate missing-data policy
plus a systemic guard), `engine/cost/**` and `engine/pricing/**` (absolute CU with
dimensioned exchange rates), `engine/intake/**`.

**Status: implemented, not wired, not enabled.** `ENGINE_ENABLED=false`; the legacy decision
path was *deleted from the build* at Phase 15 (`taskAssignment.service.js`,
`costEvaluator.service.js`, `robotValidator.service.js`, `taskRecovery.service.js` are all
absent). Consequently a shard with `cutover.engine_enabled = false` has **no decision path
at all** — this is stated deliberately in `engine/cutover/enabled.js:44-50` and is not an
oversight.

### Layer 4 — PHYSICAL COMMAND AUTHORITY · *what may move a robot*

`engine/commitment/**` (two-scope fencing, leases, guards G1–G6),
`engine/dispatch/outbox.js` (transactional outbox), `dispatch/sequence.js` (per-scope
ordering, gap-holds), `dispatch/dedupHandshake.js`, `dispatch/escalation.js`,
`commandDispatcher.deliverOutboxCommand` (the single exit), `COMMAND_ACK` with fence and
epoch comparison, `engine/degraded/modeRegister` suspension at that single exit.

The governing rule (§4.1 rule 5, quoted at `commandDispatcher.service.js:176-181`):

> Every command to an agent — offer, withdrawal, recall, reroute, stand-down — is emitted
> **only** by draining the outbox, and its outbox row is written in the *same transaction*
> as the state transition and fence advance that authorise it. **No component may send a
> command by any other path.**

### Why this separation is the crux of the audit

`alertDissemination.service.js` is written as a Layer-2 component, but line 108 —
`await rerouteRobot(...)` — reaches into Layer 4. `rerouteRobot` rewrites
`taskPath:{taskId}` and `registry.plannedPath`, i.e. **the executing plan of a mission**,
with no fence, no authority epoch, no outbox row, no sequence, and no ACK, triggered by any
authenticated agent's unvalidated report, with every failure swallowed by
`Promise.allSettled`.

That is a second physical-command authority. It is currently harmless *only* because C-2
makes it unreachable. The moment C-2 is fixed without addressing the layering, a Layer-2
delivery filter acquires Layer-4 power.

**This is the single most important architectural conclusion in this audit, and it governs
every recommendation in §12–§16.**

---

## 12. Safe Integration Analysis

Evaluated per the brief's six questions. Nothing here is a recommendation to implement
Paper 1's allocation half — greedy assignment, readiness gate, normalized weighted cost,
`rerouteRobot` plan mutation, old A* authority, or a second command path. Those are
excluded by the brief and independently rejected by the frozen architecture's own ADRs.

### 12.1 Zone-scoped communication · **DO NOT IMPLEMENT**

1. **Already exists:** the zone model, the assignment, the room membership, the crossing transitions.
2. **Missing:** only the emitter — a genuine one-line change.
3. **Conflicts?** Yes, on correctness rather than on structure. Paper 1's own assumption (iii) is that relevance is determined by *current* zone plus planned path. An agent standing in zone A whose route crosses into zone B is not in B's room and is never told about B's obstacle. It discovers it by driving into it. The miss rate scales with the same path-length/zone-area ratio that makes route filtering worth doing at all: a path long enough to justify the filter is, by construction, long enough to leave its origin zone.
4. **Requires touching assignment/commitment/dispatch?** No.
5. **Second authority path?** No — an emit alone is a delivery filter.
6. **Verdict: DO NOT IMPLEMENT.** It would trade correctness for message count in a system whose stated philosophy resolves unknowns in the safe direction, and the loss would be *silent*: a non-notified agent produces no signal, and the instrument that would detect it does not exist.

### 12.2 Zone rooms (membership) · **KEEP AS-IS**

Already implemented, cheap, correct, and harmless. Their existence is not the problem; a
zone-scoped *emitter* would be. Worth a comment in `zoneManager.service.js` recording that
membership is deliberately maintained without a delivery path — but that is documentation,
and this audit does not change source.

### 12.3 Trajectory relevance · **ADAPT** — highest-value item

1. **Already exists:** the predicate itself, as a tested pure function, plus a *stronger* placement than Paper 1's (server-side, whole-fleet, no zone misses).
2. **Missing:** a real corridor input. The engine has one — a Leg's `Stop` sequence in the round's **pinned snapshot** — which is versioned, replayable, and does not depend on a 30 s Redis cache.
3. **Conflicts?** No, provided it is authored as a **pure, read-only set producer** that returns mission ids and writes nothing.
4. **Requires modifying assignment/commitment/dispatch?** No. It adds a *caller* to `engine/failure/externalEscalation.js`'s existing `affectedMissionIds` input; it changes no row, no contract, no phase.
5. **Second authority path?** No — provided it returns a set and nothing else. The moment it emits a command or writes a route, it becomes one and must be refused.
6. **Verdict: ADAPT.** This is RobotX's *own* unmet requirement (§18.2 A8 has a consumer and no producer), and Paper 1 happens to supply the predicate. Under §7.3's DENY reading, missing corridor data must yield "notify", never "skip".

### 12.4 Affected-robot / Leg selection · **ADAPT** (same item as 12.3)

The engine's natural unit is the **Leg**, not the robot. Selecting Legs whose planned
corridor crosses an obstruction is exactly `affectedMissionIds`. Selecting *robots* and
messaging them directly is what re-creates the legacy shape.

### 12.5 Obstacle dissemination (the delivery half) · **DEFER**

1. **Already exists:** the transport (`robot:{id}` unicast), and the correct delivery machinery (outbox + fence + sequence + ACK).
2. **Missing:** a supervised replan command, and — for the legacy tier — the `plannedPath` seed and a payload contract that matches the agent handler.
3. **Conflicts?** The legacy path conflicts decisively (§11). An engine-tier replan command does not, but it must go through the outbox with fence, sequence and ACK.
4. **Requires modifying dispatch?** Yes — a new §10.3.1 command is an interface extension.
5. **Second authority path?** Only if built the legacy way. Built through the outbox, no.
6. **Verdict: DEFER** until the round loop actually runs. Design it now, build it after. Note that `REROUTE` already exists as a mission-scope command name (`fencing.js:62`) — the envelope shape is already defined; what is missing is a producer.

### 12.6 EKB enhancements · **DEFER** (engine tier) / **KEEP** (legacy tier)

1. **Already exists:** a working TTL store at the legacy tier.
2. **Missing:** any engine-tier environmental record.
3. **Conflicts?** Yes, if imported as-is. A TTL cache cannot be a snapshot-pinned input: §9.6 determinism requires that a round's inputs be versioned and replayable, and a wall-clock TTL is neither. Clock-based expiry also resolves an unknown permissively, against the architecture's grain.
4. **Requires modification?** Yes — it would extend the round snapshot contract (Phase 9 candidates, Phase 7 feasibility), both closed.
5. **Second authority path?** No, but it changes a frozen contract.
6. **Verdict: DEFER.** If ever built, expiry must be evidence-based or explicitly conservative, never clock-based.

### 12.7 Communication measurement · **IMPLEMENT** — safest item in the audit

1. **Already exists:** nothing. No message counting, no byte accounting, no coordinator-cost instrumentation, no false-negative accounting.
2. **Missing:** an offline instrument that replays a fleet trace through candidate dissemination policies — **broadcast · zone-only · zone+route · route-only** — and reports, per policy: agents notified, **agents missed** (ground truth = route actually blocked), coordinator work per report, bytes, end-to-end latency.
3. **Conflicts?** None. It touches no runtime path.
4. **Requires modifying assignment/commitment/dispatch?** No.
5. **Second authority path?** No — it is an offline tool that reads fixtures and writes a report.
6. **Verdict: IMPLEMENT.** It is the only item here with zero architectural risk, and it is the prerequisite for every other decision on this list: without a false-negative column, the choice between zone scoping and route filtering cannot be made on evidence, and the regression risk of 12.1 is undetectable by construction.

---

## 13. KEEP

Exactly as they are:

1. **Socket.IO 4 as the single transport**, one namespace, with the Redis adapter and its loud-warning fallback (`server.js:327-349`).
2. **The two-room model** — `dashboard` and `robot:{robotId}`. Room-based addressing rather than socket handles is what makes multi-worker deployment correct; do not reintroduce `getRobotSocket()` as a delivery mechanism.
3. **The certificate-bound authentication scheme** and its three deployment states, including pairing-refused-by-name under `AGENT_MTLS_REQUIRED`.
4. **The outbox as the single command exit**, with two-scope fencing, per-scope sequencing with gap-holds, the dedup handshake at AUTH, mandatory ACK with fence/epoch comparison, and the §18.5 suspension check at that one exit.
5. **`agentGate` as the single cutover decision** for agent-facing paths — the conjunction of process flag, session, fresh shard identity, region, snapshot, and per-shard binding.
6. **Server-side, whole-fleet route relevance as the *policy*.** The placement is right and is stronger than Paper 1's. Only its input and its geometry need work.
7. **The EKB at the legacy tier** — store, TTL, sweep, dashboard alert. It works.
8. **Zone rooms as membership-only.** Cheap, correct, harmless. Do not add an emitter.
9. **The telemetry hot path's single merged read-modify-write.** Do not add per-tick round trips to it.

## 14. ADD

Ranked by value-to-risk, highest first.

| # | Addition | Layer | Risk | Why |
|---|---|---|---|---|
| **A-1** | **Dissemination-policy measurement instrument** — offline, replays a fleet trace through four policies (broadcast · zone-only · zone+route · **route-only**), reporting notified, **missed**, coordinator work, bytes, latency | Offline tool | **None** — touches no runtime path | The only way to decide 12.1 on evidence rather than assertion. Also produces the missing false-negative column and the missing fourth arm. |
| **A-2** | **Correct `ARCHITECTURE.md` §3.9** | Documentation | None | It asserts a working obstacle→reroute path the code cannot execute. Either restore the seeding or state plainly that the fleet-facing half is inert pending cutover. Leaving a false capability claim in the architecture document is the "correct in form, dead in effect" pattern this programme has recorded repeatedly. |
| **A-3** | **Fix or formally retire the `REROUTE_ALERT` payload contract** (C-3) | Legacy tier | Low | One event name currently carries two incompatible shapes from two producers. Either the dissemination producer sends what the handler reads, or the legacy alert is documented as retired. |
| **A-4** | **False-negative accounting** as a first-class metric | Observability | Low | Nothing anywhere records a robot that should have been notified and was not. Under any dissemination policy this is the metric that matters, and it is absent. |
| **A-5** | **Relevance-set producer** for §18.2 A8 — pure function: (obstruction segment, pinned-snapshot Leg corridors) → `affectedMissionIds` | `engine/` new module | Medium | RobotX's own frozen architecture *requires* this notification and the producer does not exist. Ships tested and uncalled until the round loop runs — a real cost, and the reason it is A-5 rather than A-1. Must return the empty set *and say so* on missing corridor data, with the caller treating unknown as "notify". |

## 15. ADAPT

Paper 1 concepts worth having, expressed in current RobotX primitives:

| Paper 1 concept | Adapted form | Primitive it uses |
|---|---|---|
| Route-intersection relevance predicate (M2), receiver-side | A **pure, read-only set producer** over the round's **pinned snapshot** Leg corridors, returning `affectedMissionIds` | `engine/awareness/*` (new, isolated); consumer `externalEscalation.evaluate()`'s existing `NOTIFY_AFFECTED_MISSIONS` step |
| Selective notification (M1's purpose, without M1's mechanism) | Keep whole-candidate-set relevance; **never** zone pre-filtering. Selection produces *Legs*, not robots | Existing `robot:{id}` unicast, reached via the outbox |
| Dynamic rerouting (M6) | A **supervised** `REROUTE` — the command name already exists in `fencing.MISSION_COMMANDS` — emitted only by draining the outbox, carrying fence, sequence and expiry, requiring ACK | `dispatch/outbox.js`, `dispatch/sequence.js`, `commandDispatcher.deliverOutboxCommand` |
| EKB as a decision input (M3) | *If ever* built at the engine tier: a versioned, snapshot-pinned record with **evidence-based or explicitly conservative** expiry — never a wall-clock TTL cache | round snapshot; `engine/config` versioning discipline |
| Communication cost model (M7/M8) | An offline instrument plus telemetry-derived occupancy-skew measurement | `tools/` |
| Zone partition (part of M1) | **Already superseded** — H3 cells with containment by *published assignment*, validated at publish time | `engine/spatial/cells.js`, `hierarchy.js` |

## 16. DO NOT ADD

| # | Item | Why it would damage the current system |
|---|---|---|
| **1** | **Zone-scoped room delivery** (`io.to("zone:…")`) | Introduces a silent false-negative class — an agent whose route leaves its current zone is never told about the obstacle blocking it. Trades correctness for message count against the architecture's grain, and the loss is undetectable until A-1/A-4 exist. Already handled better by whole-fleet route relevance, which has no misses. |
| **2** | **`rerouteRobot`-style plan mutation, in any engine-facing form** | **The load-bearing entry.** It is a second physical-command authority: it rewrites the executing plan with no fence, no epoch, no outbox row, no sequence, no ACK, no supervision, triggered by any authenticated agent's unvalidated report, with failures swallowed. Bypasses five mechanisms that exist specifically to guarantee the opposite. Concretely reachable failures: stale command racing a fenced dispatch; two sources of truth for the active route; a plan committed that differs from the plan evaluated. |
| **3** | **Readiness gate as an admission mechanism** | Two-valued admission cannot distinguish a *missing* sensor reading from a *failing* one. The engine's 38-predicate three-valued gate with per-predicate missing-data policy exists precisely to preserve that distinction, and the whole degraded-operation register is built on it. |
| **4** | **Cost function C(r) and greedy per-arrival selection** | Explicitly excluded by the brief, and independently the rejected alternatives of record. Min-max normalized weighted sums make a class of defect invisible — every term *looks* present even when one is inert. Re-introducing dimensionless costs would break the dimensioned-CU exchange-rate discipline and the explainability output that depends on it. |
| **5** | **Runtime bounding-box zone lookup as a decision input** | Query-time geometric containment makes a decision depend on floating-point geometry evaluated per round — slow and non-deterministic. The engine resolves containment from a published, versioned, publish-time-validated cell→zone map for exactly this reason. Note the legacy tier *already does* the rejected thing (`getZoneForCoordinates`); the point is not to propagate it inward. |
| **6** | **Agent-supplied obstacle severity as a hazard classification** | Hazard class must be derived automatically, never operator- or agent-entered, because the escalation chain hangs off it. A four-level enum supplied by the reporting agent is an override facility indistinguishable in the data from a correct classification — a faulty or compromised agent could downgrade a hazard that gates emergency escalation. |
| **7** | **Clock-based TTL as an obstacle lifecycle** at the engine tier | An obstacle ceasing to exist at 300 s regardless of physical reality resolves an unknown permissively. Every comparable decision in RobotX resolves the other way. |
| **8** | **A second server→agent delivery path that bypasses `commandDispatcher`** | `alertDissemination` already does this (direct `io.to().emit()`, no presence check, no retry, no result). It should converge on the dispatcher, not be replicated. |

---

## 17. Final Recommendation

### Is Paper 1's communication architecture better than the current RobotX architecture?

Answered per dimension, as the brief requires. No single score.

| | Dimension | Verdict | Reason |
|---|---|---|---|
| **A** | **Transport** | **Equivalent in kind; RobotX stronger in deployment** | Same library. RobotX's Redis adapter makes room addressing correct across worker processes; Paper 1 assumes one coordinator process and does not need it. Different targets, not a better idea. |
| **B** | **Security / authentication** | **RobotX decisively stronger** | Paper 1 has a token as one of five readiness booleans. RobotX has certificate-bound sessions with `(agent_id, certificate, session_id)`, in-session revocation re-checks, automated rekey, brute-force lockout, and data-plane capability-claim rejection. Not comparable. |
| **C** | **Reliability** | **RobotX stronger in machinery; Paper 1 stronger in fact for dissemination** | RobotX has retry with back-off, presence checks, a transactional outbox, an escalation ladder, and degraded-mode suspension — *for commands*. The dissemination path uses none of it: fire-and-forget inside `Promise.allSettled`. Paper 1's is also best-effort, but it fires. RobotX's is best-effort **and** inert. |
| **D** | **Command integrity** | **RobotX overwhelmingly stronger** | Two-scope fencing, per-scope sequencing with gap-holds, dedup handshake, mandatory ACK with fence/epoch comparison, single-exit enforcement. Paper 1 has none of these — its reroute is direct plan mutation with no commitment semantics and no inter-agent conflict resolution, and it says so. |
| **E** | **Scalability** | **Different, and neither is measured** | Paper 1's zone scoping reduces *egress* per report but leaves coordinator ingress unchanged — its own Eqs. 7–8 identify ingress as the binding constraint and decline to claim the scaling result. RobotX's dissemination is O(N) Redis reads over one global unpartitioned set per report, which its own `robotRegistry.service.js:4-21` banner flags as violating the bounded-work property. **Neither system has measured the crossover, and RobotX has no communication measurement at all.** |
| **F** | **Socket.IO room architecture** | **Paper 1 richer as described; RobotX's is real** | Paper 1 uses rooms as the dissemination mechanism. RobotX uses them for identity addressing (`robot:{id}`) and UI scoping (`dashboard`), and both carry real traffic and work across workers. RobotX's zone rooms are the one place Paper 1's design is present in *form* and absent in *behaviour*. |
| **G** | **Geographic dissemination** | **Paper 1 has it; RobotX does not — and RobotX is right not to** | This is a genuine capability gap, and it is deliberate rather than accidental in effect: zone scoping introduces false negatives that Paper 1's own model (Eq. 4) does not account for, conflating "agents that needed the alert" with "agents eligible to receive it". RobotX's whole-fleet route filtering strictly dominates it on relevance and strictly loses on coordinator cost. |
| **H** | **Route-based relevance** | **Paper 1 stronger — the one real gap** | Both have the predicate. Paper 1's has a working input by construction (receiver-side; an agent always knows its own path). RobotX's is starved (C-2), direction-sensitive (C-4), and mis-layered — it holds decision authority where Paper 1 treats it as an optimization input. **This is the one place Paper 1 holds a capability RobotX genuinely lacks, and it is why the paper survives at all.** |
| **I** | **Environmental awareness** | **Equivalent at the legacy tier; RobotX absent at the engine tier** | The EKB is essentially the same code and works in both. RobotX's engine has no environmental model, and its own §18.2 A8 cooperative-obstacle-notification requirement is specified with a consumer and no producer. RobotX is behind *its own specification* here, independent of Paper 1. |

**Summary.** Paper 1 is stronger on exactly one thing: a trajectory-relevance predicate that
is connected to a real input. RobotX is stronger on authentication, command integrity,
determinism, cross-worker correctness, and hazard classification, and is equivalent on
transport and the EKB. On geographic dissemination Paper 1 has a mechanism RobotX lacks, but
adopting it would make RobotX less correct, not more. On measurement, neither system can
support its claims — and RobotX cannot support even the claims in its own architecture
document.

### Next implementation step

> **Build the offline dissemination-policy measurement instrument (A-1).**

It is the single safest communication-related feature available:

- **Zero architectural risk.** A `tools/` harness that reads fixtures and writes a report. It touches no runtime path, no phase, no contract, no invariant, and creates no authority.
- **It is the prerequisite for every other decision on this list.** The choice between zone scoping (§16 item 1) and whole-fleet route filtering cannot be made on evidence until agents-missed is a measured column. Right now that number does not exist for either policy, in either system.
- **It measures the arm nobody has run** — route-only, without zone scoping — which is precisely what RobotX implements and what Paper 1's own model predicts should be strictly better on relevance and strictly worse on coordinator cost. That trade-off, measured, is a real result.
- **It is immediately actionable.** It does not wait on the Phase 15 blocker, on B1 routing-engine selection, or on the round loop running.
- **It makes the four verified breaks visible as numbers rather than as an audit finding** — a regression instrument for C-1 through C-4 that a future change cannot silently undo.

The natural second step, once the instrument exists, is **A-2/A-3**: correct
`ARCHITECTURE.md` §3.9 and resolve the `REROUTE_ALERT` payload contract. Both are low-effort
and both remove a false capability claim. **A-5** (the relevance-set producer) should follow
only when there is an instrument capable of demonstrating that it has no false negatives.

---

## 18. Evidence / File References

### Transport and composition root

| Claim | Location |
|---|---|
| Socket.IO server construction | `Backend/server.js:304-312` |
| Redis adapter attach + fallback policy | `Backend/server.js:327-349` |
| `app.locals.io` | `Backend/server.js:363` |
| Shard-migration session invalidation (cross-process) | `Backend/server.js:790-808` |
| §23.2 revocation sweep — this process's sockets only | `Backend/server.js:845-861` |
| Multi-worker harness (nginx, `WORKER_COUNT`) | `Backend/benchmark/orchestrator.js:181-219` |

### Socket layer

| Claim | Location |
|---|---|
| `io.on("connection")`; dashboard/robot split heuristic | `Backend/src/sockets/socket.server.js:193-196` |
| Dashboard JWT extraction | `Backend/src/sockets/socket.server.js:30-47` |
| Dashboard auth → `join("dashboard")` | `Backend/src/sockets/socket.server.js:204-222` |
| Dashboard task-path re-hydration | `Backend/src/sockets/socket.server.js:230-254` |
| Handler registration (5 handler modules) | `Backend/src/sockets/socket.server.js:266-287` |
| `assign_task` — no auth, no rate limit | `Backend/src/sockets/socket.server.js:317-373` |
| Offline detector, single-owner gate | `Backend/src/sockets/socket.server.js:80-144`, `:184-188` |
| Zone seeding + 60 s EKB sweep | `Backend/src/sockets/socket.server.js:146-171` |
| Rate limiter (fixed window + min spacing) | `Backend/src/sockets/rateLimit.js:1-42` |
| Process-local socket map (presence only) | `Backend/src/sockets/robotSockets.js:1-38` |

### Robot authentication and liveness

| Claim | Location |
|---|---|
| `AUTH` handler | `Backend/src/sockets/handlers/robot.handler.js:431-700` |
| Capability-claim rejection | `:260-272`, `:462-464` |
| Certificate session establishment | `:186-230`, `:466-494` |
| `session:` type-confusion guard (P14-R8) | `:149-162`, `:500-521` |
| Pairing lockout (5 / 1 h) | `:65-66`, `:375-410`, `:551-568` |
| Shard identity resolved once at AUTH | `:595-603` |
| `AUTH_SUCCESS` / `AUTH_OK` | `:640-653` |
| **`socket.join("robot:{id}")`** | `:658` |
| `kv.sadd("robots:all")` | `:671-673` |
| Zone assignment at AUTH (conditional on cached position) | `:675-685` |
| Heartbeat: Redis every beat, DB throttled, gate refresh | `:708-769` |
| Session rekey / revocation re-check | `:793-865` |
| Disconnect: offline, `srem`, `robot_offline` | `:898-938` |

### Telemetry

| Claim | Location |
|---|---|
| F26 auth gate | `Backend/src/sockets/handlers/telemetry.handler.js:398-404` |
| Merged registry RMW incl. zone | `:786-822` |
| Zone-change side effects | `:824-834` |
| Pipelined write | `:856-858` |
| `robot:update` to dashboard | `:882` |

### Commands

| Claim | Location |
|---|---|
| Room-based, adapter-aware dispatch rationale | `Backend/src/services/commandDispatcher.service.js:1-32` |
| `dispatch()` with presence check + retry | `:78-116` |
| Legacy typed helpers (no fence/sequence/expiry) | `:118-171`, `:183-194` |
| §4.1 rule 5 quoted | `:176-181` |
| `deliverOutboxCommand` — single exit | `:209-313` |
| §18.5 suspension, async accessor `await`ed | `:253-276` |
| Command-name-as-event-name | `:304-308` |
| `COMMAND_ACK` dual reading; fence/epoch comparison | `Backend/src/sockets/handlers/command.handler.js:45-71`, `:82-164` |
| Sequencing, two namespaces, gap-holds | `Backend/src/engine/dispatch/sequence.js:1-70` |
| Command taxonomy (8 mission / 7 agent / 3 query) | `Backend/src/engine/commitment/fencing.js:59-82` |
| Agent-side per-command subscription | `Backend/src/simulation/VirtualRobot.js:348-356` |

### Cutover gating

| Claim | Location |
|---|---|
| Two-half switch; "no decision path" consequence | `Backend/src/engine/cutover/enabled.js:44-50`, `:105-169` |
| `agentGate` — six-way conjunction, named refusals | `Backend/src/engine/cutover/agentGate.js:96-127`, `:238-296` |
| Shard identity from `ShardMembership` | `:152-186` |
| `ENGINE_ENABLED=false` | `Backend/.env` |

### Zones

| Claim | Location |
|---|---|
| `Zone` model — lat/lon bounding boxes | `Backend/prisma/schema.prisma:263-288` |
| 3-tier zone cache | `Backend/src/services/zoneManager.service.js:31-65` |
| `getZoneForCoordinates` — linear bbox scan | `:93-99` |
| **`updateSocketZoneRoom` — the only zone room join/leave** | `:109-117` |
| `assignRobotToZone` | `:151-170` |
| `applyZoneChangeSideEffects` | `:189-213` |
| Quadrant seeding, `delta = 0.005°` | `:223-267` |
| Stale docstring naming two deleted consumers | `:127-140` |
| Engine H3 cells; containment by assignment | `Backend/src/engine/spatial/cells.js:1-56` |
| `h3-js ^4.5.0` | `Backend/package.json:49` |

### Obstacle pipeline

| Claim | Location |
|---|---|
| `OBSTACLE_REPORT` handler | `Backend/src/sockets/handlers/dtaro.handler.js:65-100` |
| Payload schema (lat, lon, severity) | `:33-37` |
| `processObstacleReport` — all 7 steps | `Backend/src/services/alertDissemination.service.js:35-113` |
| `POINT_OBSTACLE_DELTA` diagonal model | `:23-24`, `:82-83` |
| Direct `io.to()` emit, bypassing the dispatcher | `:101-104` |
| `Promise.allSettled` swallowing failures | `:88-110` |
| `rerouteRobot` call from a Layer-2 component | `:108` |
| `storeObstacle` — all stored fields, TTL 300 s | `Backend/src/services/ekb.service.js:18`, `:42-87` |
| `sweepExpired` | `:150-168` |
| Segment intersection; parallel → false | `Backend/src/services/routeIntersection.service.js:19-39` |
| `findAffectedRobots` requires `length >= 2` | `:77-87` |
| `rerouteRobot` — the only `plannedPath` writer | `Backend/src/services/routing.service.js:172-224`, esp. `:207` |
| `rerouteRobot` early-return on missing `robotTaskState` | `:176-177` |
| `updatePlannedPath` setter | `Backend/src/services/robotRegistry.service.js:248-250` |
| `getAllRobotIds` — global unpartitioned set | `:178-186` |
| T9 / bounded-work banner | `:4-21` |
| `ObstacleEvent` model | `Backend/prisma/schema.prisma:308-326` |
| `_onRerouteAlert` requires `newPath` \| `obstacleLocation` | `Backend/src/simulation/VirtualRobot.js:1128-1160` |
| Agent emits `OBSTACLE_REPORT` | `:1657` |
| Operator reroute *does* send `newPath` | `Backend/src/services/task.service.js:537-541` |
| `seedTaskKeys` listed as removed at Phase 15 | `Backend/src/services/task.service.js:10-18` |

### Documentation disagreements

| Claim | Location |
|---|---|
| §3.9 asserts a working obstacle→reroute path — **false on this tree** | `ARCHITECTURE.md:328-333` |
| Room list `dashboard, robot:{id}` — **accurate**, correctly omits zone rooms | `ARCHITECTURE.md:155` |
| `zoneManager` docstring cites `costEvaluator.service.js` and `taskAssignment.service.js` — **both deleted** | `Backend/src/services/zoneManager.service.js:127-140` |

### Executed verification

Harness: session scratchpad, outside the repository. Imports
`services/alertDissemination.service`, `services/robotRegistry.service`,
`services/routeIntersection.service` and `simulation/VirtualRobot` **unmodified**, with an
in-memory KV implementing the Redis surface those services use, a stub Prisma returning one
zone, and a recording `io` double.

| Scenario | Result |
|---|---|
| A · registry populated as the live telemetry path populates it | `affectedRobotIds: []`; emits = `dashboard/ALERT_CREATED` only; **0** zone emits |
| B · `plannedPath` force-seeded | `affectedRobotIds: ["R-CROSS"]`; `robot:R-CROSS/REROUTE_ALERT` fires; payload keys = `obstacleId, lat, lon, zoneId, severity, timestamp`; **0** zone emits |
| C · pure predicate, three robots | `["R-CROSS"]`; **`R-PARALLEL` — travelling down the obstacle's own axis through the obstacle point — not detected** |
| D · real payload → real `_onRerouteAlert` | `newPath` absent, `obstacleLocation` absent, `pathIndex 0 → 0`, `activePath` unchanged — **no-op** |

---

*End of audit. No source, test, or configuration file was modified.*

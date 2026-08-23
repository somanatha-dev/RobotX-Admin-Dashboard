# RobotX — Obstacle Alert Dissemination, Clearance Verification and Alert Lifecycle
## Production Implementation Plan

**Status:** PLAN ONLY — no production source, schema, configuration or behaviour was modified in producing this document.
**Branch / tree inspected:** `feature/dashboard` @ `450d829`
**Date:** 2026-08-22
**Authority order used:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN) → `IMPLEMENTATION_EXECUTION_PLAN.md` → `ROBOTX_CURRENT_COMMUNICATION_AUDIT.md` → repository source → `PHASE_15_ADVERSARIAL_REMEDIATION_AND_CLOSURE.md` → *RobotX State Reconciliation* → other phase docs. Root `ARCHITECTURE.md` is treated as **stale** and is never quoted as a fact.

**Scope lock.** This plan covers exactly three capabilities: (1) relevance-based / zone-scoped obstacle awareness, (2) route-aware obstacle relevance and early warning, (3) obstacle state verification, clearance and lifecycle synchronisation. Nothing else from Paper 1 is planned, adapted or revived. Every Paper 1 mechanism named in the exclusion list is explicitly rejected in §16.

---

## 1. Executive summary

### 1.1 What I found

The obstacle pipeline in RobotX is **present in form and inert in effect**. Every structural piece the three features need already exists in the tree — a `Zone` model, per-telemetry-tick zone assignment, `zone:{zoneId}` Socket.IO rooms with join/leave on boundary crossings, an EKB with Redis-primary/Postgres-secondary storage, a tested pure route-intersection predicate, a cross-worker Redis Socket.IO adapter, and a retrying presence-checked command dispatcher. None of it is connected end to end.

Four independent breaks, all confirmed against the source in this session and corroborated by the executed harness in `ROBOTX_CURRENT_COMMUNICATION_AUDIT.md` §6.3:

| # | Break | Evidence in tree |
|---|---|---|
| **B-1** | **No code path anywhere emits to a `zone:*` room.** Rooms are joined (`zoneManager.service.js:115`) and left (`:112`) and never addressed. A repo-wide sweep of `io.to(` / `io.in(` / `socket.to(` returns only `dashboard` and `robot:{id}`. | verified by grep this session |
| **B-2** | **`registry:{robotId}.plannedPath` has exactly one writer, and that writer runs only for robots the predicate has already selected.** `updatePlannedPath` (`robotRegistry.service.js:248-250`) is called only from `routing.service.js:207`, inside `rerouteRobot`, which runs only for a robot already in `affectedRobotIds`. The predicate gates its own input, so `findAffectedRobots` returns `[]` in production, always. | `alertDissemination.service.js:71-85`; `routeIntersection.service.js:82-84` |
| **B-3** | **`REROUTE_ALERT` carries two incompatible payload shapes from two producers.** `alertDissemination.service.js:90-97` sends `{obstacleId, lat, lon, zoneId, severity, timestamp}`; `VirtualRobot._onRerouteAlert` (`VirtualRobot.js:1128-1160`) acts on `newPath`, else on `obstacleLocation`, else returns silently. The dissemination payload has neither key — delivery is a no-op even when it fires. The operator path (`task.service.js:537-541` → `dispatchRerouteAlert`) sends `{taskId, segment, newPath}` and does work. | both producers read this session |
| **B-4** | **The point-obstacle geometry is direction-sensitive.** A point obstacle is modelled as one SW→NE diagonal segment of ±0.0002° (`alertDissemination.service.js:23-24, 82-83`), and `segmentsIntersect` returns `false` for parallel segments by construction (`routeIntersection.service.js:29`). A robot driving along that same bearing *through the obstacle point* is classified unaffected. | `routeIntersection.service.js:19-39` |

Two further facts govern the design:

- **B-5 — the fleet-wide scan.** `processObstacleReport` does `SMEMBERS robots:all` then one `getRobotState` per member (`alertDissemination.service.js:71-79`). That is O(N) Redis round trips per obstacle report over one global unpartitioned set. `robotRegistry.service.js:4-21` carries a standing banner acknowledging this violates the bounded-work property T9. At 5 000 robots this is ~5 001 Redis operations per report.
- **B-6 — the layering violation.** `alertDissemination.service.js:108` calls `rerouteRobot`, which rewrites `taskPath:{taskId}` and `registry.plannedPath` — the executing plan of a mission — with no fence, no authority epoch, no outbox row, no sequence number and no ACK, triggered by any authenticated agent's unvalidated report, with every failure swallowed by `Promise.allSettled`. This is a **second physical-command authority**. It is harmless today *only* because B-2 makes it unreachable. **Fixing B-2 without severing this edge would arm it.** This is the single most important constraint on the whole plan.

A seventh finding, new to this plan and not in the audit:

- **B-7 — zone rooms are not rejoined on reconnect.** `updateSocketZoneRoom` runs only inside the `changed` branch of `assignRobotToZone` (`zoneManager.service.js:165-168`). On AUTH the handler passes `liveState?.zoneId` as `currentZoneId` (`robot.handler.js:674-683`). A robot that reconnects inside the 30 s registry TTL therefore has `newZoneId === currentZoneId`, `changed` is false, and **the new socket never joins `zone:{zoneId}`**. Same on the telemetry path: the merge branch only fires `applyZoneChangeSideEffects` when the zone id actually differs (`telemetry.handler.js:804-806, 824-834`). Socket room membership does not survive a socket. `REQUIRES VERIFICATION` by the test named in §26 (T-EDGE-07) — the code path is unambiguous, but no existing test covers it, so I state it as a derived defect rather than an executed one.

### 1.2 What I propose

**One sentence:** make relevance *additive*, make dissemination *O(1) in fleet size*, make the alert a *fact* rather than a *command*, and make expiry *evidence-based*.

Four decisions carry the design:

**D-1 — Recipients are a union, never a filter.** `recipients = zoneOccupants ∪ routeWatchers ∪ routeIntersecting`. The audit's objection to zone scoping (§12.1, §16 item 1) is that it introduces a silent false-negative class: an agent standing in zone A whose route crosses into zone B is never told about B's obstacle. That objection is decisive **against zone scoping used as a filter**. It does not apply to zone scoping used as an *additional* delivery tier on top of route relevance, because a union cannot have fewer recipients than either input. This is how Feature 1 is delivered without trading correctness for message count, and it is strictly more correct than the status quo, whose recipient set is empty.

**D-2 — Addressing is by room, so coordinator work is O(1) per report.** A robot joins `zone:{zoneId}` for the zone it is in (this already happens) **and** `zonewatch:{zoneId}` for every zone its assigned route passes through (new, joined once at assignment, not per tick). Dissemination becomes a single `io.to("zone:"+z).to("zonewatch:"+z).emit(...)` — one adapter publish, independent of fleet size. The `SMEMBERS robots:all` + N×`GET` scan (B-5) is **deleted**. This is the mechanism that makes Feature 1 cheaper than today rather than more expensive.

**D-3 — Fine relevance is evaluated receiver-side; the server never mutates a plan.** The agent holds its own path and can run the exact intersection test locally at zero coordinator cost. The server ships the obstacle *fact*; the agent decides whether its path is affected. This is Paper 1's own placement (M2, receiver-side) and it is the only placement that does not create a second command authority. The `alertDissemination → rerouteRobot` edge (B-6) is **severed**. Server-side relevance is retained, but only as a *measurement* — a shadow estimate written to metrics for false-negative accounting, with no delivery authority.

**D-4 — Expiry degrades to STALE, never to CLEARED.** The current EKB deletes an obstacle at 300 s of wall clock regardless of physical reality (`ekb.service.js:18, 123-126`), which resolves an unknown in the *permissive* direction — against §7.3's DENY discipline and against ADR-06/ADR-25. The new lifecycle expires an obstacle into `STALE` → `RECHECK_REQUIRED`, and only positive evidence or an operator action reaches `CLEARED`. Feature 3 is where that discipline lives.

### 1.3 Cost of the change

| | Today (per obstacle report) | After |
|---|---|---|
| Redis round trips | 1 + N (N = live fleet) | 4, constant |
| Postgres queries | 1 insert | 1 upsert (best-effort, off the response path) |
| Socket.IO publishes | 1 dashboard + 2 per affected robot | 1 dashboard + 1 zone-scoped |
| Route-intersection checks (server CPU) | N paths × M segments | 0 on the delivery path; bounded shadow sample for measurement |
| Recipients reached in production | **0** | zone occupants ∪ route watchers |
| Added per-telemetry-tick work | — | **0** (hard requirement, §24.2) |

At 5 000 robots and the simulator's obstacle rate this is ~25 000 Redis ops/s today versus ~20 ops/s after — a three-order-of-magnitude reduction — while going from zero recipients to correct ones. Full derivation in §24.

### 1.4 What this plan explicitly does not do

It does not restore the legacy assignment path, does not re-arm `rerouteRobot` in any engine-facing form, does not add an engine-tier obstacle store or touch the round snapshot contract, does not add a kill switch to the Tier 2 ladder, does not create a microservice, does not replace Socket.IO/Redis/Prisma/Postgres, and does not enable the assignment engine. Phases 0–12 here are entirely legacy-tier and host-platform work that is orthogonal to B1/B8/T1-04 and can proceed in parallel with them.

### 1.5 One acknowledged tension, stated plainly

`ROBOTX_CURRENT_COMMUNICATION_AUDIT.md` §12.1 and §16 item 1 rule **DO NOT IMPLEMENT** on zone-scoped room delivery. The locked Feature 1 requires it. I have not overridden the audit; I have satisfied its stated objection. The audit's objection is specifically that zone scoping produces false negatives *relative to whole-fleet route relevance*. Under D-1 the zone tier is a union member, never a filter, so it cannot remove a recipient that route relevance would have selected — the false-negative class the audit names cannot arise. §16 records this reconciliation formally, and §24.7 defines the metric (`obstacle.relevance.missed`) that would detect it if the reasoning were wrong. **If the programme prefers the audit's literal reading over the locked feature, the change to this plan is confined to Phase 4 and is named in §32 as OQ-1.**

---

## 2. Current-system findings

Everything in this section was read in the tree this session. Line numbers are from `450d829`.

### 2.1 Transport and composition root

| Fact | Location |
|---|---|
| One Socket.IO 4 server on the same HTTP server as Express; one default namespace. | `Backend/server.js:304-312` |
| `@socket.io/redis-adapter` attached when `REDIS_URL` set and `REDIS_ENABLED !== "false"`; on failure logs loudly and **falls back to the single-process adapter**, which silently stops cross-worker broadcast. | `Backend/server.js:317-349` |
| No `cluster` fork in the repository. Multi-worker means multiple processes behind a load balancer; the Redis adapter is what makes room addressing correct across them. | grep for `cluster` in `server.js` → adapter comments only |
| Handlers registered per connection: robot, telemetry, command, dtaro, offer. | `Backend/src/sockets/socket.server.js:266-287` |
| `robotSockets` is a **per-process in-memory `Map`**. `getRobotSocket` is a local presence check only and must never be used for delivery. | `Backend/src/sockets/robotSockets.js:5-11` |

### 2.2 Rooms that exist

| Room | Joined where | Left where | Addressed by |
|---|---|---|---|
| `dashboard` | `socket.server.js:222` after JWT verify | on disconnect | ~20 emit sites |
| `robot:{robotId}` | `robot.handler.js:658` on AUTH success | on disconnect | `commandDispatcher.service.js:105,308`; `alertDissemination.service.js:101`; `server.js:793,859` |
| `zone:{zoneId}` | `zoneManager.service.js:115` via `updateSocketZoneRoom` | `:112` | **nothing** (B-1) |

### 2.3 Zone model — two of them, and only one is legacy-relevant

- **Legacy tier (the one these features use).** `model Zone` (`prisma/schema.prisma:263-302`) is an axis-aligned bounding box: `minLat/maxLat/minLon/maxLon`, `name @unique`, back-relations to `Robot[]` and `ObstacleEvent[]`. Containment is query-time geometry: `getZoneForCoordinates` linearly scans the cached zone list and returns the first box containing the point (`zoneManager.service.js:93-99`). Zones are seeded as **4 quadrant boxes** around a campus centre, ±0.005° ≈ 550 m per half-edge (`zoneManager.service.js:223-267`), so a default campus has Z = 4 zones of roughly 1.1 km × 1.1 km.
- **Engine tier (must not be conflated).** `Region` / `Site` / `Zone.cells` / `CellAssignment` with H3, where containment is by *published assignment* validated at publish time, never query-time geometry (`prisma/schema.prisma:807+, 882+`; `engine/spatial/cells.js`). The audit's §16 item 5 forbids propagating the legacy bounding-box lookup inward. **This plan touches only the legacy tier and adds no engine-tier dependency.**

Zone cache is three-tier: in-process 60 s → Redis `zones:all` 300 s → Postgres (`zoneManager.service.js:31-65`). A zone lookup on the telemetry hot path is therefore usually free.

### 2.4 Zone assignment — already live, already on the right hook

The telemetry handler computes the zone on every tick from the in-process cache and folds `zoneId` into the **single merged registry read-modify-write** (`telemetry.handler.js:786-822`). It sets `zoneChangeInfo` only when the resolved zone differs from the stored one, and calls `applyZoneChangeSideEffects` only in that case (`:824-834`). That function does the Postgres mirror write, the socket room move, and the `ZONE_UPDATED` dashboard emit (`zoneManager.service.js:189-213`).

**This is the correct and only hook point for zone-entry state synchronisation.** It already fires exactly once per boundary crossing and never on a steady-state tick. Feature 1's secondary behaviour needs no new detection mechanism at all.

The `undefined` vs `null` distinction at `telemetry.handler.js:794` is load-bearing and must be preserved: `undefined` means "position unknown this tick, do not touch `zoneId`", `null` means "known position, outside all zones".

### 2.5 Obstacle path as written

```
VirtualRobot._maybeReportObstacle        VirtualRobot.js:1648-1664
  → socket.emit("OBSTACLE_REPORT", {lat, lon, severity})
    → dtaro.handler.js:65-100   rate limit 10/60s, min 500ms; zod {lat, lon, severity?}
      → alertDissemination.processObstacleReport   alertDissemination.service.js:35-113
         1. getZoneForCoordinates                   → zoneId (recorded, never used to address)
         2. ekb.storeObstacle                       → Redis SET + SADD + PG create
         3. io.to("dashboard").emit("ALERT_CREATED")
         4. getAllRobotIds  → SMEMBERS robots:all   ← B-5, O(N)
         5. getRobotState per id                    ← B-5, N round trips
         6. findAffectedRobots(diagonal segment)    ← B-4 direction-sensitive; input always [] ← B-2
         7. io.to("robot:{id}").emit("REROUTE_ALERT", ...)  ← B-3 payload mismatch
         8. rerouteRobot(...)                       ← B-6 second command authority
      → socket.emit("OBSTACLE_REPORT_ACK", {obstacleId, affectedRobots, timestamp})
```

Steps 1–3 work and are the only part that reaches a human. Steps 4–8 are the broken half.

### 2.6 EKB storage

`ekb.service.js`. Redis is primary with TTL-based auto-expiry; Postgres `ObstacleEvent` is a best-effort secondary inside a bare `try/catch` that silently swallows *any* failure including a schema mismatch (`:76-84`); an in-memory `Map` is the fallback when Redis is down (`:21, 71-73`).

- Key shapes: `ekb:event:{obstacleId}` (JSON string, `EX = ttlSec`), `ekb:obstacles` (Set of ids).
- `obstacleId` is `OBS-{Date.now()}-{randInt(100,999)}` (`:43`) — **time-random, not spatial**. Two robots reporting the same physical obstacle create two unrelated records. There is no merge, no dedup, no identity.
- Default TTL 300 s (`:18`). Expiry is wall-clock deletion.
- `getActiveObstacles` does `SMEMBERS` then one `GET` per id — O(obstacles), acceptable, but it has **no zone filter**, so it cannot answer "what is active in zone Z" without reading everything.
- `sweepExpired` runs on a 60 s interval started in `socket.server.js:163-170`.
- `getActiveObstacles` has **no production caller**. Grep returns the definition, the export, `metrics.service.js`'s count via `SMEMBERS ekb:obstacles` (`:84`), and tests.

### 2.7 Route representation — and why there are no routes

| Key | Shape | Written by | TTL |
|---|---|---|---|
| `taskPath:{taskId}` | `{pickup, drop, toPickup:[{lat,lon}], toDrop:[...]}` | **only** `task.service.rerouteTask:507-510` (operator action) and formerly `seedTaskKeys` | 86400 |
| `robotTaskState:{robotId}` | `{taskId, pathIndex, segment\|phase}` | **only** `task.service.js:515-519` (mutates an existing row) | 86400 |
| `registry:{robotId}.plannedPath` | `[{lat,lon}]` | **only** `routing.service.js:207` | 30 (registry TTL) |

`task.service.js:14-18` records that `seedTaskKeys` — "the Redis writes that made the cache the source of truth for an assignment" — was **removed from the build at Phase 15**, together with the whole legacy assignment path. `POST /api/tasks/assign` now returns `503 ENGINE_NOT_LIVE` while `ENGINE_ENABLED=false` (`task.service.js:33-41`).

**Consequence, and it is the central constraint on Feature 2:** *there are currently no planned routes in the running system at all.* Not stale ones — none. The producer was deleted, and its replacement (the coordinator round loop) cannot compose because of B1. Any design that requires a route to exist in order to function will ship inert, which is precisely the "correct in form, dead in effect" pattern this programme has recorded seven times. §12 handles this explicitly with a three-stage input ladder.

The 30 s registry TTL is a second, independent reason not to build fine relevance on `plannedPath`: a path that vanishes 30 s after the last telemetry tick is not a corridor, and there is no freshness bound anywhere that would notice.

### 2.8 Redis facade — the exact API available

`Backend/src/cache/kv.js`. Available: `get`, `set(key, val, {ex})`, `del`, `sadd`, `srem`, `smembers`, `mget(keys[])`, `setManyEx(entries[])`, `pipeline()` **supporting only `.get()` and `.set()`**, `incr(key, {ex})` (Redis `INCR` + `EXPIRE`, genuinely atomic when Redis is live), `reserveRobot` (`SET NX EX`, advisory by default since Phase 15), `releaseReservation`, `health()`.

**Not available:** hashes, sorted sets, `EXPIRE` standalone, `SCAN`, Lua `EVAL`, pub/sub, `WATCH`/`MULTI`. The pipeline is explicitly **not** a transaction (`kv.js` comment: "NOT a transaction (no MULTI) — commands can still partially apply").

Every Redis structure in §14 is expressible in `string`, `set` and `incr` alone. **No facade extension is required.** That is a deliberate constraint, not a coincidence — extending `kv.js` would touch a module on the telemetry hot path.

Graceful degradation is uniform: on any Redis error the facade calls `disableRedis()`, switches to the in-memory maps, and schedules capped-exponential reconnect (`kv.js:95-140`). A single-process deployment with no `REDIS_URL` is a supported mode.

### 2.9 Delivery machinery that already exists and should be reused

`commandDispatcher.service.js:78-116` — `dispatch(io, robotId, event, payload, {retries})`:
- addresses by room, never by socket handle, so it is cross-worker correct by construction (`:5-19`);
- presence-checks with `io.in(room).fetchSockets()`, which is adapter-aware;
- retries with back-off (1 s, 2 s) on an empty room;
- **returns a delivery result** `{dispatched, socketId, attempts}` — the thing `alertDissemination` throws away today;
- `assertIoServer` fails loudly on a malformed call rather than degrading to a silent no-op (`:57-65`).

`alertDissemination.service.js:100-105` bypasses all of it with a bare `io.to().emit()` inside `try/catch {}`. Audit §16 item 8 names this. Convergence on the dispatcher is a Phase 4 deliverable.

### 2.10 Simulator capabilities — what the agent can actually do

`VirtualRobot.js`:
- **Can** report an obstacle: `_maybeReportObstacle`, probability 0.002 per 2 s tick while `ACTIVE`, jitters ±0.0001° around its own position, severity `HIGH` at p=0.3 else `MEDIUM` (`:1648-1664`).
- **Can** receive `REROUTE_ALERT` and act on `newPath` (full replace) or `obstacleLocation` (skip-ahead fallback) (`:359, 1128-1160`).
- **Holds its own path**: `this.activePath`, `this.pathIndex`, `this.task.pathToPickup/pathToDrop` (`:151, 1131-1143, 1532-1587`). **This is the input D-3 needs, and it is already on the agent.**
- **Has** a nearest-waypoint-index helper (`:1113-1126`).
- **Cannot** physically re-observe a location on demand. There is no sensor model, no detection range, no "look at point P" primitive. Feature 2's verification is therefore a **simulation-level abstraction** (§13.4) built from what exists: proximity to the obstacle point plus continued forward progress.
- **Has no** local obstacle memory, no zone awareness, and no digest/version handling. All three are Phase 6/Phase 3 additions to the simulator only.

### 2.11 Configuration and flags

Behavioural constants live in the versioned parameter register (`src/engine/config/register/*.json`), resolved through `engine/config/service.js`. Legacy-tier constants use the `legacy.*` namespace with an explicit retirement note (`register/legacy.json`; consumed by `config/dtaro.constants.js` and `config/liveness.constants.js`, both of which **throw** rather than default when a value fails to resolve).

Cross-parameter invariants are enforced at publish time by `engine/config/validators.js` (e.g. A3: `db_flush_interval_ms < offline_cutoff_ms`), not by prose.

The engine kill-switch ladder (`register/killSwitches.json`) is **not** available to this feature: `tierTwoAtShipState` refuses a cutover with any Tier 2 mechanism live, including under rehearsal purpose. §28 uses a plain process flag plus register entries instead.

### 2.12 Observability conventions

`config/logger.js` exposes domain helpers: `logger.socketIn(event, meta)`, `logger.socketOut(event, target, meta)`, `logger.socket(kind, meta)`, and — already present and already the right shape — `logger.obstacle({reportingRobotId, lat, lon, severity, zoneId, affectedRobots})` (`:453`). The `zoneId` and `affectedRobots` parameters exist and are currently passed as defaults.

Metrics: `metrics.service.js` has a legacy Redis-key-per-event writer (`recordAllocation`) that the file's own header (`:94-113`) identifies as the unbounded per-decision write shape §21.2 exists to replace. **Do not extend it.** `engine/observability/sli.js` provides an advisory counter registry (`engine:sli:*`) that is the correct home for the new counters (§25).

---

## 3. Existing capabilities that can be reused

| # | Capability | Where | Reused for |
|---|---|---|---|
| R-1 | Zone bounding-box model + 3-tier cache + `getZoneForCoordinates` | `zoneManager.service.js:31-99`, `schema.prisma:263` | Zone identity, obstacle→zone mapping, no change |
| R-2 | Per-tick zone resolution folded into the merged registry RMW | `telemetry.handler.js:786-822` | Zone membership, **unchanged, zero added cost** |
| R-3 | Zone-crossing detection + side-effect hook | `telemetry.handler.js:824-834` → `zoneManager.js:189-213` | The only hook for zone-entry state sync (Feature 1 secondary) |
| R-4 | `zone:{zoneId}` room join/leave | `zoneManager.js:109-117` | Tier-Z addressing — needs an *emitter*, and a reconnect fix (B-7) |
| R-5 | `robot:{robotId}` room | `robot.handler.js:658` | Unicast state sync, verification requests |
| R-6 | Socket.IO Redis adapter | `server.js:317-349` | Cross-worker fan-out for all of the above, free |
| R-7 | `commandDispatcher.dispatch` with presence check, retry, result | `commandDispatcher.service.js:78-116` | Unicast delivery with a delivery *result* to count |
| R-8 | EKB Redis+PG+memory storage, sweep loop | `ekb.service.js`, started `socket.server.js:163-170` | Extended in place — not replaced |
| R-9 | `ObstacleEvent` Prisma model with `@@index([zoneId])`, `@@index([expiresAt])` | `schema.prisma:308-330` | Durable history; extended additively |
| R-10 | Pure segment-intersection predicate, unit-tested | `routeIntersection.service.js` | Shared by server (shadow metric) and simulator (receiver-side test) — after the B-4 geometry fix |
| R-11 | `OBSTACLE_REPORT` handler with rate limit + zod validation | `dtaro.handler.js:65-100` | Ingress, unchanged shape |
| R-12 | Per-socket rate limiter with min-interval spacing | `sockets/rateLimit.js` | Reused verbatim for the new inbound events |
| R-13 | Atomic `kv.incr(key, {ex})` | `kv.js` | Monotonic obstacle `version` for ordering and idempotency |
| R-14 | `kv.mget` / `kv.pipeline()` batching | `kv.js` | Zone digest reads in one round trip |
| R-15 | Parameter register `legacy.*` namespace + publish-time cross-parameter validators | `register/legacy.json`, `config/validators.js` | Every new numeric constant |
| R-16 | `logger.obstacle` with unused `zoneId` / `affectedRobots` fields | `config/logger.js:453` | Structured obstacle logging, already the right shape |
| R-17 | `engine/observability/sli.js` advisory counters | — | New metrics without the `recordAllocation` anti-pattern |
| R-18 | Jest five-lane config (`legacy`/`gates`/`engine`/`chaos`/`scale`) + `tests/helpers/{testKv,fakeSocket,mockPrisma,waitFor}` | `jest.config.js`, `tests/helpers/` | Every test in §26, in the `legacy` and `scale` lanes |
| R-19 | Benchmark orchestrator + robot workers + system metrics | `Backend/benchmark/` | §27 before/after benchmarking across robot tiers |
| R-20 | `VirtualRobot` path state (`activePath`, `pathIndex`, nearest-index helper) | `VirtualRobot.js:151, 1113-1126` | Receiver-side relevance (D-3) — the input already exists on the agent |

**Twenty reusable capabilities. The three features need four genuinely new modules** (§19), and none of them sits on the telemetry hot path.

---

## 4. Gaps identified

| # | Gap | Class | Feature blocked | Smallest fix |
|---|---|---|---|---|
| G-1 | No emitter to `zone:*` | Missing wiring | F1 | One emit site in a new dissemination module |
| G-2 | No obstacle identity — every report is a new record | Missing mechanism | F3 | Spatial-temporal merge key (§7.2) |
| G-3 | No lifecycle state — obstacles are present-or-deleted | Missing model | F2, F3 | `state` + `version` + evidence counters (§9) |
| G-4 | Expiry is clock-based deletion, permissive direction | Wrong semantics | F3 | TTL → `STALE`, never → `CLEARED` (§9.4) |
| G-5 | No per-zone active-obstacle index | Missing structure | F1 | `obs:zone:{zoneId}` Redis set (§14.2) |
| G-6 | No zone-entry state sync | Missing behaviour | F1 secondary | `ZONE_STATE_SYNC` on the existing crossing hook (§11) |
| G-7 | Zone rooms not rejoined on reconnect (B-7) | Defect | F1 | Unconditional join at AUTH (§11.2) |
| G-8 | `plannedPath` never seeded (B-2) | Dead input | F2 | Do **not** revive the deleted seeder; move relevance receiver-side (§12) |
| G-9 | Direction-sensitive obstacle geometry (B-4) | Defect | F2 | Radius test replaces diagonal segment (§12.3) |
| G-10 | `REROUTE_ALERT` two payload shapes (B-3) | Contract defect | F1, F2 | New event names; retire the dissemination producer (§10.5) |
| G-11 | Dissemination bypasses `commandDispatcher` | Missing reliability | F1 | Route unicast through `dispatch()` (§10.6) |
| G-12 | Dissemination holds Layer-4 authority (B-6) | **Architectural violation** | all | Sever the `rerouteRobot` call (§6.3) |
| G-13 | O(N) fleet scan per report (B-5) | Scalability | F1 | Room addressing (§24.3) |
| G-14 | No verification concept at all | Missing feature | F2 | §13 |
| G-15 | No conflict resolution between disagreeing robots | Missing feature | F3 | Evidence quorum + `DISPUTED` (§9.6) |
| G-16 | No duplicate/out-of-order suppression | Missing feature | F1, F3 | `version` + agent-side digest (§23) |
| G-17 | No false-negative accounting anywhere | Missing observability | all | `obstacle.relevance.missed` (§25) |
| G-18 | Agent has no local obstacle memory | Missing simulator capability | F1, F2 | `VirtualRobot` obstacle map (§11.5) |
| G-19 | `ObstacleEvent` write failures silently swallowed | Masking defect | F3 | Narrow the catch, count the failure (§15.4) |
| G-20 | `getActiveObstacles` has no zone filter and no caller | Dormant API | F1 | Replaced by `activeForZone` (§14.3) |

---

## 5. The three approved features, restated against the tree

### F1 — Relevance-based / zone-scoped obstacle awareness

**Primary.** An obstacle reported at (lat, lon) resolves to a zone and is delivered to robots relevant to that zone, not to the whole fleet. Delivered by D-1/D-2: one emit to `zone:{z}` ∪ `zonewatch:{z}`.

**Secondary (state synchronisation on zone entry).** A robot entering zone Z is brought up to date with Z's currently-active obstacle state. Delivered on the existing crossing hook (R-3), addressed to `robot:{id}`, and suppressed when the robot's held digest already matches (§11.4). This is a *reconciliation*, not a re-notification — the distinction the brief draws is preserved in the event name (`OBSTACLE_ZONE_SYNC` vs `OBSTACLE_ALERT`) and in the metric split.

**Status of prerequisites:** all present. F1 is implementable today with no external dependency.

### F2 — Route-aware obstacle relevance and early warning

A robot whose assigned route passes through zone Z should learn about Z's obstacle *before* entering Z, and a robot whose route passes near the obstacle *point* should be able to distinguish "in my zone" from "on my path".

Split into two independently shippable halves, because their prerequisites differ sharply:

- **F2a — zone-level early warning.** Robot joins `zonewatch:{z}` for every zone on its route. Coarse, cheap, O(1) to address. **Prerequisite: a route exists.** Today it does not (§2.7).
- **F2b — point-level relevance.** The exact intersection test. Run **receiver-side** on the agent's own `activePath` (D-3). **Prerequisite: none on the server** — the agent already holds the input (R-20).

**This ordering matters.** F2b ships first and works today in the simulator; F2a ships behind an input ladder (§12.2) that degrades safely to "no watchers" rather than to "wrong watchers". Neither half is allowed to gate delivery: under D-1 both are additive tiers.

### F3 — Obstacle state verification, clearance and lifecycle synchronisation

Identity, merge, state machine, evidence-based expiry, re-verification, conflict resolution, history retention, and cross-restart consistency. Fully specified in §9, §13, §15, §23. No external dependency.

---

## 6. Final architecture adaptation

### 6.1 Where each feature lives

```
LAYER 1 — TRANSPORT                              unchanged
  socket.io 4 · @socket.io/redis-adapter · rateLimit.js
  server.js:304-349 · sockets/socket.server.js

LAYER 2 — DISSEMINATION POLICY                   ← ALL THREE FEATURES LIVE HERE
  zone rooms (zone:{z})                          zoneManager.service.js      [reuse + B-7 fix]
  route-watch rooms (zonewatch:{z})              obstacleWatch.service.js    [NEW]
  obstacle identity / merge / lifecycle          obstacleStore.service.js    [NEW]
  recipient selection + emit + sync              obstacleDissemination.service.js [NEW, replaces alertDissemination]
  verification protocol                          obstacleVerification.service.js  [NEW]
  relevance predicate (geometry)                 routeIntersection.service.js [reuse + B-4 fix]
  durable history + sweep                        ekb.service.js              [extended in place]

LAYER 3 — DECISION AUTHORITY                     UNTOUCHED
  engine/solve · engine/candidates · engine/feasibility · engine/cost · engine/intake
  ENGINE_ENABLED=false. This plan adds no engine module, no snapshot input,
  no round-loop dependency, and no engine-tier obstacle record.

LAYER 4 — PHYSICAL COMMAND AUTHORITY             UNTOUCHED — AND THE EDGE IS SEVERED
  engine/commitment · engine/dispatch/outbox · dispatch/sequence · dedupHandshake
  commandDispatcher.deliverOutboxCommand · COMMAND_ACK with fence + epoch
  ── alertDissemination → rerouteRobot IS REMOVED ──
```

### 6.2 The three rules that govern every design choice below

**Rule 1 — additive relevance.** No tier may remove a recipient another tier selected. Recipient sets compose by union. A relevance signal that is *unknown* resolves to "notify" (§7.3's DENY reading applied to dissemination: the safe direction for a warning is to send it).

**Rule 2 — no plan mutation.** Nothing in this feature may write `taskPath:*`, `registry.plannedPath`, `Leg`, `Stop`, `Commitment`, or `Outbox`. An obstacle alert is a **fact delivered to an agent**, never a **command that moves it**. Where a plan must change, that is the operator's existing `rerouteTask` path or, after cutover, an outbox-drained `REROUTE` — neither of which this feature calls.

**Rule 3 — zero telemetry-tick cost.** The telemetry handler's batched 4-key read (`telemetry.handler.js:599-605`) and single flushed write pipeline (`:856-858`) must not gain a key, a round trip, or a Postgres query. Every new cost lands on obstacle events (rare) or zone crossings (rare), never on the 0.5 Hz per-robot tick.

### 6.3 The severed edge, stated precisely

`alertDissemination.service.js:108` — `await rerouteRobot(prisma, kv, io, robotId, { obstacleLocation })` — **is deleted, not flag-gated.**

Justification, in the audit's own words (§11): *"a Layer-2 delivery filter acquires Layer-4 power"*. Concretely reachable failures if retained: a stale reroute racing a fenced dispatch; two sources of truth for the active route; a plan committed that differs from the plan evaluated; and an unvalidated agent report rewriting another agent's mission.

`routing.service.js` itself is **kept unmodified** — `replanRoute` and `rerouteRobot` remain exported and remain reachable from `task.service.rerouteTask`, which is an *operator* action on already-committed work and is explicitly retained until after cutover (`task.service.js:19-26`). This plan removes one caller, not the module.

### 6.4 Data-flow summary

```
Robot detects → OBSTACLE_REPORT ──► dtaro.handler (rate limit, zod)
                                      │
                                      ▼
                            obstacleStore.report()
                            ├─ zone lookup (in-process cache, 0 I/O)
                            ├─ merge key → existing obstacle? (1 GET)
                            ├─ INCR version (1 op)
                            ├─ SET obstacle + SADD obs:zone:{z} (1 pipelined)
                            └─ PG upsert ObstacleEvent (best-effort, off path)
                                      │
                                      ▼
                       obstacleDissemination.publish()
                            └─ io.to("zone:"+z).to("zonewatch:"+z)
                                 .emit("OBSTACLE_ALERT", envelope)     ← 1 adapter publish
                            └─ io.to("dashboard").emit("OBSTACLE_ALERT", …)
                                      │
                    ┌─────────────────┴──────────────────┐
                    ▼                                    ▼
        Agent receives envelope                Server records shadow relevance
        ├─ version ≤ held? drop (idempotent)   (bounded sample, metrics only,
        ├─ store in local obstacle map          NO delivery authority)
        ├─ pathIntersectsObstacle(activePath)?  ← receiver-side, D-3
        │    yes → slow / hold / request verify
        │    no  → remember only, keep driving
        └─ (never mutates its plan from the alert alone)
```

---

## 7. Domain model

### 7.1 Entities

| Entity | Nature | Lives in | Authority |
|---|---|---|---|
| **Obstacle** | The operational belief that a location is obstructed. Merged across reports. Has a lifecycle. | Redis (hot) + Postgres (durable) | Redis for delivery; Postgres for history and rebuild |
| **ObstacleReport** | One agent's single observation — present or clear. Immutable. Evidence, never state. | Postgres `ObstacleObservation` (new) | Postgres |
| **Zone** | Existing legacy bounding box. Unchanged. | Postgres `Zone` + caches | Postgres |
| **ZoneObstacleDigest** | Cheap comparable fingerprint of a zone's active obstacle set, for duplicate suppression. | Derived, cached in Redis | Derived |
| **AgentObstacleView** | What one agent currently believes. Held **on the agent**. | Agent memory | Agent |

**The Obstacle / ObstacleReport split is the brief's "active operational state vs historical obstacle event" distinction, made structural.** An Obstacle is mutable, small, hot, and per-zone-indexed. A Report is append-only, cold, and never read on the delivery path. Conflating them is what makes clearance history unrecoverable and analytics impossible.

### 7.2 Obstacle identity — the merge key

Today: `OBS-{Date.now()}-{rand}` (`ekb.service.js:43`). Two robots reporting one physical obstacle produce two records; the same robot reporting twice produces two more.

**Proposed identity:** a spatial-temporal cluster key.

```
obstacleKey = `${zoneId ?? "nozone"}:${snap(lat)}:${snap(lon)}`
snap(x)     = Math.round(x / GRID_DEG) * GRID_DEG
GRID_DEG    = obstacle.merge_grid_degrees   (register; default 0.00018 ≈ 20 m)
obstacleId  = `OBS-${sha1(obstacleKey).slice(0,12)}`
```

- **Deterministic and content-addressed**, so any process on any worker derives the same id from the same coordinates without coordination. No lock, no round trip, no sequence.
- **Grid snapping, not radius clustering.** Radius clustering needs a neighbourhood query (`SCAN`/geo commands the facade does not have) and is order-dependent. Grid snapping is O(1) arithmetic and order-independent — the property that makes it safe under concurrent reports from two workers.
- **Known limitation, stated rather than hidden:** two reports 21 m apart straddling a grid line produce two obstacles. Mitigation is the 3×3 neighbour probe in §14.4 (one `mget` of 9 keys, still one round trip) which merges into an existing adjacent obstacle when one is active. `REQUIRES VERIFICATION`: the right `GRID_DEG` for the real campus is a calibration question, registered UNCALIBRATED and listed in §32 OQ-4.

**Same physical obstacle re-reported ⇒ same id ⇒ merge, version bump, evidence increment.** That is G-2 closed.

### 7.3 The Obstacle record

```jsonc
{
  "obstacleId":   "OBS-a3f8c91b2e40",
  "version":      7,                    // monotonic, kv.incr, sole ordering authority
  "zoneId":       "zone-a" | null,
  "lat": 12.9512, "lon": 77.5541,       // centroid of contributing reports
  "radiusM":      12,                   // derived from report spread, floored at obstacle.min_radius_m
  "state":        "ACTIVE",             // §9
  "severity":     "MEDIUM",             // agent-supplied, RETAINED AS ADVISORY ONLY — see below
  "firstSeenAt":  1755859200000,
  "lastSeenAt":   1755859800000,        // last PRESENT evidence
  "lastCheckedAt":1755859800000,        // last evidence of any kind
  "presentCount": 3,                    // distinct robots reporting PRESENT
  "clearCount":   0,                    // distinct robots reporting CLEAR
  "reporters":    ["R-01","R-04","R-07"],  // capped at obstacle.max_tracked_reporters
  "clearers":     [],
  "expiresAt":    1755860100000,        // when ACTIVE degrades to STALE — NOT when it is deleted
  "verifyRequestedAt": null,
  "verifyAssignedTo":  null
}
```

**On severity.** Audit §16 item 6 forbids agent-supplied severity as a *hazard classification*, because the escalation chain hangs off hazard class and a compromised agent could downgrade a hazard that gates emergency escalation. That prohibition is honoured: `severity` is retained **only** as an advisory display and ordering hint, is explicitly typed as such in the envelope (`severityIsAdvisory: true`), and **nothing in this feature branches on it**. No escalation, no state transition, no delivery decision reads it. The engine's `ObstructionClass` enum (`schema.prisma:794-799`) remains the only hazard classification and this feature does not write it. `REQUIRES VERIFICATION` if a future consumer wants to branch on severity — that would need a derived classifier, not this field.

### 7.4 The ObstacleReport record

```jsonc
{
  "reportId":   "uuid",
  "obstacleId": "OBS-a3f8c91b2e40",
  "robotId":    "R-04",
  "kind":       "PRESENT" | "CLEAR",
  "lat": 12.9513, "lon": 77.5540,
  "reportedSeverity": "MEDIUM",
  "distanceM":  8.2,          // agent's distance from the obstacle centroid when reporting
  "observedAt": 1755859800000,
  "receivedAt": 1755859800120,
  "accepted":   true,
  "rejectReason": null        // "TOO_FAR" | "RATE_LIMITED" | "DUPLICATE_WINDOW" | "UNKNOWN_OBSTACLE"
}
```

`observedAt` vs `receivedAt` mirrors the Observation discipline in §2.7 of the frozen spec (value / observed-at / received-at / source). Rejected reports are **stored with their reason**, not dropped: the rejection rate is the signal that a threshold is wrong, and a dropped rejection is indistinguishable from a healthy fleet.

### 7.5 What is deliberately not modelled

- No engine-tier environmental record, no round-snapshot input, no `CellAssignment` coupling (audit §12.6 — DEFER).
- No obstacle geometry beyond a centroid + radius. Polygons need a spatial index the facade cannot provide.
- No obstacle *type* taxonomy. Nothing would consume it.
- No cross-zone obstacle. An obstacle near a boundary belongs to one zone; the neighbour-zone case is handled by delivery (§10.4), not by the model.

---

## 8. Zone model

### 8.1 Decision: keep the existing bounding-box zones exactly as they are

Options considered: (a) existing `Zone` bounding boxes; (b) H3 cells via `engine/spatial/cells.js`; (c) new polygon geofences; (d) route-graph nodes.

**Chosen: (a).** Reasons, in order:

1. It already exists, is already assigned per tick at zero marginal cost (R-2), already has Socket.IO rooms (R-4), and already has a `zoneId` FK on `ObstacleEvent` (R-9).
2. (b) is forbidden inward-propagation in the wrong direction: the engine tier resolves containment by *published assignment*, and this is a legacy-tier delivery concern. Using H3 here would either duplicate the engine's map or create a legacy→engine dependency that `gate:tiers` would have to govern. Audit §16 item 5 and §15's "already superseded" row both point this way: the legacy zone is a *communication* partition, the H3 cell is a *decision* partition, and they must not be conflated.
3. (c) needs a spatial index and a point-in-polygon evaluation per lookup — cost on the hot path for a precision nobody has asked for.
4. (d) needs a route graph. There is none (§2.7).

**Explicitly:** the legacy zone is used **only** to address a message. It is never a decision input. That is the boundary audit §16 item 5 draws, and this plan stays on the safe side of it.

### 8.2 Zone granularity and its consequences

Default seeding is 4 quadrants of ~1.1 km × 1.1 km (`zoneManager.service.js:229-253`). At delivery-bot speed (5.56–8.33 m/s, `simulation/constants.js`) a robot crosses a zone in roughly 130–200 s.

| Z (zones) | Zone edge | Crossings/robot/hour | Expected occupancy at 1 000 robots |
|---|---|---|---|
| 4 (default) | ~1.1 km | ~20 | 250 |
| 16 | ~550 m | ~40 | 62 |
| 64 | ~275 m | ~80 | 16 |

Higher Z means better targeting and more crossings. Crossing cost is dominated by the Postgres `Robot.zoneId` mirror write (§24.4), which is why §24.4 proposes making that write conditional — its two named consumers (`costEvaluator.service.js`, `taskAssignment.service.js`) were both deleted at Phase 15, a fact the `zoneManager.service.js:127-140` docstring still asserts as live and the audit flags as stale documentation.

**Recommendation: keep Z = 4 for rollout, then tune with the measured crossing rate from Phase 9.** Do not tune Z before the instrument exists — that is the same evidence-free choice the audit refuses in §12.7.

### 8.3 The flow the brief asks to be made explicit

```
Robot telemetry (lat, lon)                telemetry.handler.js:448-449
        ↓
getZoneForCoordinates                     zoneManager.service.js:93-99
  in-process 60s → Redis 300s → Postgres  (usually 0 I/O)
        ↓
zoneId folded into merged registry RMW    telemetry.handler.js:796-819
  (no extra round trip — same SET)
        ↓
changed? ── no ──► nothing happens (steady state, the common case)
        │
        yes
        ↓
applyZoneChangeSideEffects                zoneManager.service.js:189-213
  ├─ Postgres Robot.zoneId mirror         [§24.4: make conditional]
  ├─ socket.leave(zone:old) / join(zone:new)
  ├─ io.to("dashboard").emit(ZONE_UPDATED)
  └─ NEW: obstacleDissemination.syncAgentToZone(...)   ← Feature 1 secondary
        ↓
Agent receives OBSTACLE_ZONE_SYNC (or nothing, if its digest already matches)
        ↓
Agent updates local obstacle map, re-evaluates its own path receiver-side
```

### 8.4 Robots outside all zones

`getZoneForCoordinates` returns `null` for a position in no box (`zoneManager.js:96-98`) — entirely possible, since the seeded quadrants cover only ±1.1 km around the campus centre. Such a robot joins no zone room.

**Under Rule 1 this must not silently mean "receives nothing".** An obstacle with `zoneId = null` is delivered to a dedicated `zone:__unzoned` room, which robots outside all zones join. A robot outside all zones is an unknown, and unknown resolves to notify. This costs one extra room and no extra work, and it removes an otherwise-invisible false-negative class.

---

## 9. Obstacle lifecycle / state machine

### 9.1 States

| State | Meaning | Delivered to agents? | Blocks a route? |
|---|---|---|---|
| `ACTIVE` | Positive evidence within the freshness window. | Yes | Yes (advisory) |
| `STALE` | Freshness window elapsed with no new evidence. Still believed, less confidently. | Yes, flagged `stale: true` | Yes (advisory) |
| `RECHECK_REQUIRED` | A robot needs to traverse it, or staleness crossed the recheck threshold. Verification solicited. | Yes, with `verifyRequested: true` | Yes, but a verifier may approach |
| `VERIFIED_PRESENT` | Re-observed present. Transient — immediately re-enters `ACTIVE` with a fresh window. | Yes | Yes |
| `CLEARED` | Positive evidence of absence, at quorum. Terminal for operations. | Yes, once (the clear notification) | **No** |
| `DISPUTED` | Concurrent contradictory evidence at quorum on both sides. | Yes, flagged | Yes — conservative direction |
| `ARCHIVED` | Retention window elapsed after `CLEARED`. Removed from Redis; row retained in Postgres. | No | No |

### 9.2 The machine

```
                    OBSTACLE_REPORT(PRESENT), no existing id
                                 │
                                 ▼
                          ┌─────────────┐
                          │   ACTIVE    │◄──────────────────────┐
                          └──────┬──────┘                       │
        PRESENT report ──────────┤ (merge: version++,           │
        (same id)                │  presentCount++, window reset)│
                                 │                              │
          expiresAt elapsed      │                              │
                                 ▼                              │
                          ┌─────────────┐                       │
                          │    STALE    │───PRESENT report──────►┤
                          └──────┬──────┘                       │
                                 │                              │
      staleness > recheck_after  │  OR  a robot needs to pass    │
                                 ▼                              │
                    ┌────────────────────────┐                  │
                    │   RECHECK_REQUIRED     │                  │
                    └───────┬────────────┬───┘                  │
                            │            │                      │
        VERIFY(PRESENT)     │            │  VERIFY(CLEAR)       │
        at quorum           │            │  at quorum           │
                            ▼            ▼                      │
                ┌────────────────┐  ┌──────────┐                │
                │VERIFIED_PRESENT│  │ CLEARED  │                │
                └────────┬───────┘  └────┬─────┘                │
                         └───────────────┼──────────────────────┘
                                         │
              PRESENT report after clear │ (reappearance — NEW id, see 9.7)
                                         │
                        retention elapsed│
                                         ▼
                                  ┌──────────┐
                                  │ ARCHIVED │
                                  └──────────┘

        ┌──────────┐
        │ DISPUTED │◄── contradictory evidence at quorum on both sides,
        └────┬─────┘    from ACTIVE / STALE / RECHECK_REQUIRED
             │
             └──► RECHECK_REQUIRED  (operator action, or a tie-breaking third observation)
```

### 9.3 Every transition, and what authorises it

| # | From → To | Trigger | Authority | Guard |
|---|---|---|---|---|
| T1 | ∅ → `ACTIVE` | `OBSTACLE_REPORT(PRESENT)` with no matching id | Any authenticated robot | Rate limit; report position within `max_report_distance_m` of claimed obstacle |
| T2 | `ACTIVE` → `ACTIVE` | `PRESENT` on an existing id | Any authenticated robot | `version++`, `presentCount++` only if `robotId` not already in `reporters`; `expiresAt` reset |
| T3 | `ACTIVE` → `STALE` | `now > expiresAt` | Sweep loop (leader-agnostic; idempotent) | No evidence in the window |
| T4 | `STALE` → `ACTIVE` | `PRESENT` report | Any robot | As T2 |
| T5 | `STALE` → `RECHECK_REQUIRED` | `now > lastCheckedAt + recheck_after_ms` | Sweep loop | — |
| T6 | `ACTIVE`\|`STALE` → `RECHECK_REQUIRED` | Agent requests passage (`OBSTACLE_VERIFY_REQUEST`) | Agent, via §13.2 | Agent is within `verify_solicit_radius_m` and its path crosses |
| T7 | `RECHECK_REQUIRED` → `VERIFIED_PRESENT` → `ACTIVE` | `OBSTACLE_VERIFY_RESULT(PRESENT)` | Verifying agent | Verifier was within `verify_proximity_m`; `presentCount++` |
| T8 | `RECHECK_REQUIRED` → `CLEARED` | `VERIFY_RESULT(CLEAR)` reaching `clear_quorum` distinct robots | Verifying agents | `clearCount ≥ clear_quorum` **and** `presentCount` evidence older than the clear evidence |
| T9 | any → `CLEARED` | Operator action | Authenticated operator, `POST /api/obstacles/:id/clear` | RBAC; audited |
| T10 | `ACTIVE`\|`STALE`\|`RECHECK_REQUIRED` → `DISPUTED` | `presentCount ≥ 1` **and** `clearCount ≥ 1` within `dispute_window_ms`, neither at quorum | Evidence arithmetic | §9.6 |
| T11 | `DISPUTED` → `RECHECK_REQUIRED` | Operator action, or a third observation breaking the tie | Operator / agent | — |
| T12 | `CLEARED` → `ARCHIVED` | `now > clearedAt + archive_after_ms` | Sweep loop | Redis key deleted; Postgres row retained |
| T13 | any → `ARCHIVED` | Zone deleted / campus retired | Operator | Cascade `SetNull` already on `ObstacleEvent.zoneId` |

**Not a transition: `CLEARED` → `ACTIVE`.** A reappearance is a *new* obstacle with a new id (§9.7). Reusing the id would make the history of "cleared then reappeared" indistinguishable from "never cleared", which is exactly the analytics signal Feature 3 exists to produce.

### 9.4 Why expiry degrades rather than deletes — G-4 closed

Today an obstacle stops existing at 300 s of wall clock (`ekb.service.js:18`; Redis TTL does the deleting). Nothing physical happened at 300 s. That resolves an unknown **permissively**: a robot that arrives at t=301 s is told the path is clear when the system has no evidence either way.

Every comparable decision in RobotX resolves the other way — §7.3's three-valued gate DENYs on indeterminate, ADR-06 and ADR-25 both take the conservative branch, and `dtaro.handler.js:245` classifies an unspecified fault as the *blocking* row for exactly this reason ("the cost of treating a degradation as blocking is an unnecessary maintenance ticket, and the cost of the reverse is a mission continued on a robot that cannot finish it").

So: **the TTL becomes a confidence decay, not a delete.** `expiresAt` moves `ACTIVE → STALE`. Only T7/T8/T9 leave the "believed obstructed" region. Redis keys still carry a TTL — but it is `archive_after_ms`-scale, not `300 s`, and the Postgres row is the rebuild source if it expires early (§22.4).

### 9.5 Freshness parameters

All registered under `legacy.obstacle.*`, `UNCALIBRATED`, owner Operations. Defaults chosen to preserve today's observable behaviour where possible.

| Parameter | Default | Rationale |
|---|---|---|
| `legacy.obstacle.active_window_ms` | 300 000 | Exactly today's `DEFAULT_TTL_SEC` — behaviour-preserving |
| `legacy.obstacle.recheck_after_ms` | 900 000 | 3× the active window |
| `legacy.obstacle.archive_after_ms` | 86 400 000 | 24 h; matches the `taskPath` TTL convention |
| `legacy.obstacle.clear_quorum` | 2 | One robot may be wrong; two agreeing is evidence. See §9.6 |
| `legacy.obstacle.present_quorum` | 1 | Asymmetric **on purpose** — one PRESENT is enough to believe, two CLEARs to disbelieve |
| `legacy.obstacle.dispute_window_ms` | 120 000 | Contradiction inside 2 min is a dispute, not a change |
| `legacy.obstacle.merge_grid_degrees` | 0.00018 | ≈ 20 m |
| `legacy.obstacle.min_radius_m` | 10 | Floor for the delivered radius |
| `legacy.obstacle.max_report_distance_m` | 150 | A robot may not report an obstacle far from itself |
| `legacy.obstacle.verify_proximity_m` | 25 | How close a verifier must get for its result to count |
| `legacy.obstacle.verify_solicit_radius_m` | 300 | Range within which an agent may solicit a recheck |
| `legacy.obstacle.max_tracked_reporters` | 8 | Bounds record size |
| `legacy.obstacle.zone_sync_max_obstacles` | 50 | Bounds sync payload size |

**Publish-time cross-parameter validator** (new, in `engine/config/validators.js`, same shape as A3):
`active_window_ms < recheck_after_ms < archive_after_ms` and `present_quorum ≤ clear_quorum` and `verify_proximity_m < max_report_distance_m`. A configuration that inverts the quorum asymmetry — making it easier to clear than to believe — is rejected rather than deployed.

### 9.6 Conflicting robots — G-15 closed

**The asymmetry is the whole answer.** `present_quorum = 1`, `clear_quorum = 2`. Believing an obstacle is cheap and safe; disbelieving one is expensive and dangerous. A single robot can create an obstacle; a single robot cannot destroy one.

Resolution rules, in order:

1. **Distinct-reporter counting.** `presentCount` and `clearCount` count *distinct robotIds* (`reporters` / `clearers` arrays), not report events. One robot spamming CLEAR ten times still counts as one.
2. **Recency ordering by `observedAt`, not arrival.** Evidence is ordered by when the agent measured, not when the packet landed. Out-of-order arrival cannot flip a verdict (§23.3).
3. **Contradiction inside `dispute_window_ms` → `DISPUTED`, and `DISPUTED` is treated as obstructed.** The conservative direction. The obstacle keeps blocking.
4. **Contradiction outside the window is a state change, not a dispute.** A CLEAR 20 minutes after the last PRESENT is plausibly a real change; it starts accumulating toward `clear_quorum` normally.
5. **A verification result outranks a passive report.** A `VERIFY_RESULT` from an agent that was solicited and got within `verify_proximity_m` counts double toward its quorum, because it is a deliberate close-range observation rather than an incidental one. `REQUIRES VERIFICATION` — the weight-2 rule is a judgement call; the alternative is weight 1 with `clear_quorum = 2` requiring two verifications, which is safer but slower. Listed as OQ-5.
6. **Nothing auto-resolves a `DISPUTED` obstacle.** It requires either a third observation or an operator. An automatic tie-break would be inventing evidence.

**Explicitly rejected: last-writer-wins.** Under LWW a faulty sensor on one robot silently clears a real obstacle for the entire fleet — a single-point permissive failure of exactly the class §7.3 exists to prevent.

### 9.7 Reappearance

A `PRESENT` report matching an `obstacleId` in state `CLEARED` or `ARCHIVED` creates a **new obstacle with a new id**, derived by appending an incarnation counter to the merge key: `sha1(obstacleKey + ":" + incarnation)`. The counter lives at `obs:incarnation:{obstacleKey}` (`kv.incr`). The previous incarnation's Postgres rows are untouched.

This makes "obstacle at P reappeared 4 times this week" a directly queryable fact — one of the research metrics in §30.

### 9.8 Who may clear

| Actor | May reach `CLEARED` | How |
|---|---|---|
| A single robot | **No** | `clear_quorum = 2` |
| Two distinct robots | Yes | T8, both within `verify_proximity_m` |
| Operator | Yes | T9, `POST /api/obstacles/:id/clear`, RBAC-gated, audited |
| Time / TTL | **No** | T3 reaches `STALE` only — G-4 |
| The engine | N/A | The engine does not consume obstacles (audit §12.6 DEFER) |

---

## 10. Notification / event model

### 10.1 Naming convention, derived from the tree

Existing robot-facing events are `SCREAMING_SNAKE` (`AUTH`, `TELEMETRY`, `HEARTBEAT`, `OBSTACLE_REPORT`, `TASK_COMPLETE`, `ROBOT_FAULT`, `TASK_ASSIGN`, `REROUTE_ALERT`, `COMMAND_ACK`, `AUTH_SUCCESS`, `OFFER_*`). Dashboard events are mixed (`robot:update`, `ALERT_CREATED`, `TASK_UPDATED`, `SECURITY_EVENT`). ACKs are `{EVENT}_ACK`.

New events follow the robot-facing convention with an `OBSTACLE_` prefix. **`REROUTE_ALERT` is not extended** — it is the event with two incompatible shapes (B-3), and adding a third would compound G-10.

### 10.2 Server → agent

| Event | When | Payload | ACK? | Guaranteed? | Persistent? |
|---|---|---|---|---|---|
| `OBSTACLE_ALERT` | New obstacle, or state change on one, in a zone the agent occupies or watches | Envelope §10.4 | No | No — at-most-once; reconciled by sync | Ephemeral |
| `OBSTACLE_ZONE_SYNC` | Agent enters a zone / AUTHs / reconnects, and its digest differs | `{zoneId, digest, obstacles: [envelope…], truncated: bool}` | **Yes** (`OBSTACLE_ZONE_SYNC_ACK`) | Yes — via `commandDispatcher.dispatch` retry | Ephemeral, but re-derivable |
| `OBSTACLE_CLEARED` | Obstacle reaches `CLEARED` | `{obstacleId, version, zoneId, clearedAt, clearedBy}` | No | No — reconciled by sync | Ephemeral |
| `OBSTACLE_VERIFY_SOLICIT` | Server asks a specific agent to re-verify | `{obstacleId, version, lat, lon, radiusM, deadlineMs}` | **Yes** (`_ACK` accept/decline) | Yes — unicast via dispatcher | Ephemeral |

### 10.3 Agent → server

| Event | When | Payload | Rate limit (reusing `rateLimit.allow`) |
|---|---|---|---|
| `OBSTACLE_REPORT` | Detection. **Unchanged shape**, extended with optional fields | `{lat, lon, severity?, distanceM?, observedAt?}` | Existing: `limit 10 / 60 s, minInterval 500 ms` |
| `OBSTACLE_VERIFY_REQUEST` | Agent needs to pass an obstacle and solicits a recheck | `{obstacleId}` | `limit 5 / 60 s, minInterval 2 000 ms` |
| `OBSTACLE_VERIFY_RESULT` | Agent reports what it observed at close range | `{obstacleId, version, kind: PRESENT\|CLEAR, lat, lon, distanceM, observedAt}` | `limit 10 / 60 s, minInterval 1 000 ms` |
| `OBSTACLE_ZONE_SYNC_ACK` | Confirms sync applied | `{zoneId, digest}` | `limit 20 / 60 s` |

**Backward compatibility.** `OBSTACLE_REPORT`'s existing zod schema (`dtaro.handler.js:33-37`) accepts `{lat, lon, severity?}` and the new fields are `.optional()`. An unmodified `VirtualRobot` or real firmware keeps working unchanged. The three new inbound events are additive; an agent that never sends them is fully functional at Tier Z.

### 10.4 The alert envelope

```jsonc
{
  "obstacleId": "OBS-a3f8c91b2e40",
  "version":    7,
  "zoneId":     "zone-a",
  "lat": 12.9512, "lon": 77.5541, "radiusM": 12,
  "state":      "ACTIVE",
  "stale":      false,
  "severity":   "MEDIUM",
  "severityIsAdvisory": true,
  "reason":     "REPORTED" | "UPDATED" | "STATE_CHANGE" | "ZONE_SYNC" | "CLEARED",
  "tier":       "ZONE" | "WATCH" | "SYNC",
  "firstSeenAt": 1755859200000,
  "lastSeenAt":  1755859800000,
  "verifyRequested": false,
  "emittedAt":  1755859800150
}
```

**`tier` is informational, never authoritative.** It records *why* the agent was addressed. It exists so `obstacle.alert.delivered{tier}` can be split in metrics, and so a receiver can log its own relevance decision against the server's reason. An agent must not branch its safety behaviour on `tier`.

**Boundary obstacles.** An obstacle within `radiusM + boundary_margin_m` of a zone edge is published to the neighbouring zone's rooms as well. Neighbours are precomputed once per zone-cache refresh from the bounding boxes (an O(Z²) pass over ≤ tens of zones, done at cache load, cached alongside `zones:all`). This costs at most one extra room in the emit chain and removes the boundary false-negative class — under Rule 1, a boundary case is an unknown and unknown resolves to notify.

### 10.5 Retiring `REROUTE_ALERT` from the dissemination producer — G-10 closed

- The obstacle-dissemination producer **stops emitting `REROUTE_ALERT` entirely**. Its replacement is `OBSTACLE_ALERT`, whose payload the agent handler is written to consume (§11.5).
- The operator producer (`task.service.js:537-541` → `dispatchRerouteAlert` → `{taskId, segment, newPath}`) is **unchanged**. It is the only shape `VirtualRobot._onRerouteAlert` actually acts on, and it works.
- `VirtualRobot._onRerouteAlert`'s `obstacleLocation` fallback branch (`:1146-1159`) becomes dead. It is **left in place** and marked, not deleted: removing an agent-side branch changes the agent contract, and real firmware may implement it. It is documented as reachable only by the operator path.

Result: one event name, one payload shape, one producer.

### 10.6 Delivery mechanics

| Class | Mechanism | Why |
|---|---|---|
| Zone-scoped alert | `io.to("zone:"+z).to("zonewatch:"+z)[.to(neighbour rooms)].emit(...)` | One adapter publish. Room fan-out is the adapter's job and is O(1) for the coordinator |
| Unicast (sync, solicit) | `commandDispatcher.dispatch(io, robotId, event, payload, {retries})` | Presence check + retry + **delivery result** (R-7). Closes G-11 |
| Dashboard | `io.to("dashboard").emit(...)` | Existing convention |

**A room emit has no delivery result** — that is inherent to broadcast and is why `OBSTACLE_ALERT` is at-most-once. Reliability comes from reconciliation, not retry: any agent that missed an alert is corrected by the next `OBSTACLE_ZONE_SYNC`, which is guaranteed and ACKed. This is the standard "unreliable notify + reliable reconcile" pattern and it is why §11 exists.

### 10.7 Idempotency and versioning

- Every envelope carries `(obstacleId, version)`. `version` is a strictly increasing integer from `kv.incr` — atomic in Redis, single-threaded-safe in the memory fallback.
- **Agent rule:** hold `Map<obstacleId, version>`; drop any envelope whose `version ≤ held`. This makes redelivery, cross-worker duplication, and out-of-order arrival all harmless with one comparison (§23.2).
- **Server rule:** `OBSTACLE_VERIFY_RESULT` carries the `version` the agent was acting on. A result against a superseded version is accepted as *evidence* but never applied as a *state transition* — the same "compare the fence you were given" discipline `COMMAND_ACK` uses (`command.handler.js`). Recorded, counted as `obstacle.verify.stale_version`, not silently dropped.

---

## 11. Robot synchronisation model

This is Feature 1's secondary behaviour, and it is what turns unreliable notification into a convergent system.

### 11.1 The four sync triggers

| # | Trigger | Hook (existing) | Change |
|---|---|---|---|
| S-1 | Robot AUTHs (first connect) | `robot.handler.js:674-683` | Join `zone:{z}` **unconditionally**, then sync |
| S-2 | Robot reconnects | same code path | **Fixes B-7** — see §11.2 |
| S-3 | Robot crosses into a zone | `telemetry.handler.js:824-834` → `zoneManager.js:189-213` | Add a sync call to `applyZoneChangeSideEffects` |
| S-4 | Robot's route changes (new task / reroute) | `task.service.js` assignment + `rerouteTask` | Recompute `zonewatch:*` membership, then sync (§12) |

### 11.2 Fixing B-7 — the reconnect gap

**Current:** `assignRobotToZone` calls `updateSocketZoneRoom` only inside `if (changed)` (`zoneManager.js:165-168`). On reconnect within the 30 s registry TTL, `newZoneId === currentZoneId`, so the *new* socket never joins the room. Socket room membership does not survive a socket.

**Fix, minimal:** split *room membership* from *state change*. Room membership becomes idempotent and unconditional; the Postgres mirror and the `ZONE_UPDATED` broadcast stay in the `changed` branch.

```
assignRobotToZone(...):
    zone      = getZoneForCoordinates(...)
    newZoneId = zone?.id || null
    changed   = newZoneId !== currentZoneId

    updateZone(kv, robotId, newZoneId)            // unchanged

    updateSocketZoneRoom(socket, currentZoneId, newZoneId)   // MOVED OUT of `changed`
                                                             // socket.join is idempotent

    if (changed) applyZoneChangeSideEffects(...)   // PG mirror + dashboard emit, unchanged
```

`socket.join()` on a room already joined is a no-op in Socket.IO, so making it unconditional is free and cannot double-deliver.

**Note the asymmetry with the telemetry path.** `telemetry.handler.js` does not call `assignRobotToZone` — it inlines the zone computation into the merged RMW and calls `applyZoneChangeSideEffects` directly (`:824-834`). That path is *correct as-is* for room membership: the socket that receives telemetry is by definition the live socket, and it joined at AUTH. The fix is needed only on the AUTH path, which is where reconnect lands. **Both paths must be tested (T-EDGE-07, T-EDGE-08).**

### 11.3 The zone digest — duplicate suppression without server-side per-agent state

The brief requires "avoid duplicate/redundant notifications when the robot already knows the current alert state" **without** the server tracking what each of 5 000 agents believes.

```
digest(zoneId) = sha1( sorted( activeIds.map(id => `${id}@${version}`) ).join("|") ).slice(0,16)
```

- Computed from the zone's active set, cached at `obs:zone:digest:{zoneId}` and invalidated on any write to that zone. One `GET` to read.
- The agent stores the digest it last applied per zone.
- **Handshake:** on `AUTH` and on `OBSTACLE_ZONE_SYNC_ACK`, the agent reports its held digest. On a sync trigger the server compares:
  - digests equal → **send nothing**, count `obstacle.sync.suppressed`;
  - differ or agent has none → send the full zone envelope list.

Server-side per-agent state: **zero**. The comparison input travels with the agent. This is the same reasoning `dedupHandshake.js` uses for `dedup_state_generation` at AUTH (`robot.handler.js:620-635`) — the agent carries its own generation and the server compares rather than remembers.

**Cost of a sync:** 1 `GET` (digest) + on mismatch 1 `SMEMBERS` + 1 `mget` = at most 3 round trips, on a per-zone-crossing basis (~25/s at 5 000 robots, §24.4), not per tick.

### 11.4 Payload bounding

`zone_sync_max_obstacles` (default 50) caps the list. On overflow the envelope carries `truncated: true` and the nearest N by distance from the agent's reported position. An agent that needs the rest can pull `GET /api/obstacles?zoneId=…`. A zone with more than 50 active obstacles is itself an alertable condition — counted as `obstacle.zone.saturated`.

### 11.5 Agent-side model (simulator; contract for real firmware)

New `VirtualRobot` state and behaviour — **all of it agent-local, none of it changing the server contract:**

```
this.obstacles     = new Map();   // obstacleId → envelope (G-18)
this.zoneDigests   = new Map();   // zoneId → digest
this.currentZoneId = null;

on OBSTACLE_ALERT (env):
    if (this.obstacles.get(env.obstacleId)?.version >= env.version) return;   // idempotent
    this.obstacles.set(env.obstacleId, env);
    this._evaluateObstacleRelevance(env);                                      // receiver-side, D-3

on OBSTACLE_ZONE_SYNC ({zoneId, digest, obstacles}):
    for (const env of obstacles) apply as above
    prune this.obstacles for zoneId not present in the sync   // convergence
    this.zoneDigests.set(zoneId, digest);
    socket.emit("OBSTACLE_ZONE_SYNC_ACK", { zoneId, digest });

on OBSTACLE_CLEARED ({obstacleId, version}):
    if (held version < version) this.obstacles.delete(obstacleId);

_evaluateObstacleRelevance(env):
    if (!this.activePath) return;                       // nothing to check against
    const remaining = this.activePath.slice(this.pathIndex);
    if (pathApproachesPoint(remaining, env, env.radiusM)) {   // shared pure predicate
        this._obstacleOnPath.add(env.obstacleId);
        // Behaviour: slow / hold at a safe standoff / solicit verification.
        // NEVER mutate activePath from an alert. Rule 2.
    }
```

**`pathApproachesPoint` is the B-4 fix (§12.3) and it is the same module the server uses** — one predicate, two callers, no drift.

**On "do not invent robot capabilities".** Everything above is memory and arithmetic the simulator already has (`activePath`, `pathIndex`, a nearest-index helper, a socket). Nothing here requires a sensor model. The one capability the simulator genuinely lacks — physically re-observing a location on demand — is handled as an explicit simulation-level abstraction in §13.4.

---

## 12. Route-aware early warning design

This is the part of the plan most constrained by what the tree actually contains, and where the brief's instruction to "determine the correct logic based on the actual route representation" produces the most consequential answer.

### 12.1 The investigation the brief asks for, answered

| Question | Answer, from the tree |
|---|---|
| How are routes represented? | Ordered `{lat, lon}` waypoint arrays. `taskPath:{taskId}` = `{pickup, drop, toPickup[], toDrop[]}`; `registry:{robotId}.plannedPath` = the active segment |
| Are waypoints available? | Yes, when a route exists |
| Nodes/edges graph? | **No.** `routing.service.astar` builds a K-nearest graph *on the fly* from a waypoint array (`:34-97`) — there is no persistent graph |
| Geographic coordinates? | Yes, WGS-84 lat/lon throughout |
| Does assignment compute routes? | **Not any more.** `seedTaskKeys` was removed at Phase 15 (`task.service.js:14-18`) |
| Does the backend know a robot's future route? | **No, in production today.** `plannedPath` has one writer, reachable only after a reroute (B-2); `taskPath` has one writer, the operator reroute |
| Can intersection be computed cheaply? | Yes — the predicate is pure, O(segments), no I/O (`routeIntersection.service.js`) |
| Would checking it add unacceptable overhead? | **Server-side per report over the fleet: yes** (B-5, O(N) Redis + O(N·M) CPU). **Receiver-side on the agent: no** — O(M) on one path, on a device that is idle between 2 s ticks |

**Conclusion: the backend does not reliably know future routes, and the cheapest correct place to test a route against an obstacle is the agent that owns the route.** That is D-3, and it is also Paper 1's own placement (M2, receiver-side, §III-D / Alg. 2).

### 12.2 The route-source ladder

`zonewatch:{zoneId}` membership needs a route. Three sources exist or will, and the design consumes whichever is available **without changing shape**:

| Stage | Source | Available | Freshness | Notes |
|---|---|---|---|---|
| **L0 — none** | No route known | **Today** | — | Agent joins **no** `zonewatch` rooms. F2a contributes nothing; Tier Z and receiver-side F2b still work. **Degrades to today's zone-only behaviour, never to a wrong watcher set.** |
| **L1 — operator reroute** | `taskPath:{taskId}` written by `task.service.rerouteTask:507-510` | **Today** | 24 h TTL | Whenever a route *does* materialise, watch rooms are computed from it |
| **L2 — engine Leg corridor** | `Stop` sequence on the committed `Leg` | After B1 + cutover | Versioned, snapshot-pinned | The correct long-term source. Read-only; adds no engine dependency to the legacy tier — a thin adapter reads `Stop` rows |

**The ladder is the mechanism that stops F2a from shipping inert.** At L0 the module is present, tested, and contributes an empty watcher set — which is *correct*, not broken, because Tier Z still delivers. Compare with B-2, where an empty input produced an empty *recipient set overall*. Under Rule 1 an empty tier is absorbed by the union.

**Explicitly rejected: reviving `seedTaskKeys` or any writer of `registry.plannedPath` on the assignment path.** `checkLegacyRetirement.js` fails the build if the deleted functions return, and re-creating the Redis-as-source-of-truth-for-an-assignment shape is what Phase 15 removed on purpose.

### 12.3 The geometry fix — G-9 / B-4 closed

**Current:** point obstacle → one SW→NE diagonal segment ±0.0002° (`alertDissemination.service.js:23-24, 82-83`); `segmentsIntersect` returns `false` for parallel segments (`routeIntersection.service.js:29`). A robot on that bearing through the point is classified unaffected.

**Replacement:** point-to-segment distance against a radius. Direction-invariant by construction, cheaper (no cross-product division, no parametric solve), and it matches the domain — an obstacle is a disc, not a diagonal.

```
function pointSegmentDistanceM(p, a, b):
    // equirectangular projection is exact enough at campus scale and is
    // already the approximation `haversineMeters` callers live with
    scale = cos(toRad(p.lat))
    project (lon, lat) → (x = lon * scale, y = lat), metres via DEG_M = 111320
    t = clamp( ((p-a)·(b-a)) / |b-a|² , 0, 1 )
    return |p - (a + t(b-a))| * DEG_M

function pathApproachesPoint(path, point, radiusM):
    for each consecutive (a, b) in path:
        if pointSegmentDistanceM(point, a, b) <= radiusM: return true
    return false
```

- **Additive, not a replacement of the file's exports.** `segmentsIntersect`, `pathIntersectsSegment` and `findAffectedRobots` stay exported and stay unit-tested — they have existing tests and `task.service`-adjacent history. The new functions are added alongside. This keeps the `legacy` Jest lane green, which is that lane's charter.
- **Degenerate path handled:** a single-waypoint path (`length === 1`) is a point; today `pathIntersectsSegment` returns `false` for `length < 2` (`:51`), silently missing a stationary robot standing on an obstacle. `pathApproachesPoint` handles `length === 1` as a point-to-point distance.
- **Shared by both callers** — server shadow metric and agent receiver-side test — so the two can never disagree.

### 12.4 Where the fine test runs, and where it does not

| Placement | Cost at 5 000 robots | Used for |
|---|---|---|
| **Agent, on its own path** | O(M) on an idle device, per alert received | **The real decision.** Whether to slow, hold, or solicit verification |
| **Server, bounded sample** | ≤ `shadow_sample_size` (default 25) paths per report, only where a path is known | **Measurement only.** `obstacle.relevance.shadow_*` — the false-negative column the audit says must exist before anyone can compare policies |
| Server, whole fleet | O(N) Redis + O(N·M) CPU | **Never.** This is B-5 and it is deleted |

The shadow sample has **no delivery authority** — it cannot add or remove a recipient. That is what keeps the server-side relevance from becoming a second selection mechanism, and it is the compromise that satisfies audit §12.3's requirement (*"a pure, read-only set producer that returns … and writes nothing"*) while keeping the delivery path O(1).

### 12.5 Early-warning semantics — not every route through a zone is an alert

The brief warns explicitly against assuming every route through a zone triggers an alert. Three levels, delivered by two rooms and one receiver-side test:

| Level | Condition | Mechanism | Agent behaviour |
|---|---|---|---|
| **Awareness** | Route passes through zone Z | `zonewatch:{Z}` room | Remember. **No action.** |
| **Proximity** | Robot is in zone Z | `zone:{Z}` room | Remember. **No action.** |
| **Relevance** | Remaining path passes within `radiusM` of the obstacle | Receiver-side `pathApproachesPoint` | Slow / hold / solicit verification |

Only the third level changes agent behaviour, and it is evaluated on the agent, on the *remaining* path (`activePath.slice(pathIndex)`), so an obstacle already passed does not trigger anything. The first two are memory only — which is precisely how the brief describes the desired behaviour, and precisely what makes early warning cheap.

### 12.6 Computing watch rooms

When a route is known (L1/L2), the zones it passes through are computed **once, at route-establishment time**, never per tick:

```
zonesOnRoute(path):
    zones = loadZones()                       // in-process cached, 0 I/O
    hit   = new Set()
    for each consecutive (a, b) in path:
        for each zone z:
            if segmentIntersectsBox(a, b, z) hit.add(z.id)   // cheap slab test
    return hit
```

Cost: O(segments × Z). With Z = 4 and a 100-point path that is 400 slab tests — microseconds, once per assignment. Rooms are joined via `socket.join("zonewatch:"+z)` and cleared on task completion/cancellation. The membership is also mirrored to `obs:watch:{robotId}` (a Redis set) so a reconnecting robot can rejoin without recomputing (§22.3).

**A path segment that crosses a zone the robot never enters is still a watch.** Over-inclusion is the safe direction (Rule 1).

---

## 13. Clearance verification design

### 13.1 The problem, as the brief states it

Robot B must pass through a location marked obstructed, and there is no reasonable alternative. The system must not assume the obstacle is eternal, and must not blindly delete it either.

### 13.2 The protocol

```
 Agent                                Server                              Fleet
   │                                     │                                   │
   │ path blocked by OBS-x, no detour    │                                   │
   │ ── OBSTACLE_VERIFY_REQUEST ───────► │                                   │
   │      {obstacleId}                   │ guard: agent within               │
   │                                     │   verify_solicit_radius_m         │
   │                                     │ guard: agent's zone/watch covers  │
   │                                     │ T6: state → RECHECK_REQUIRED      │
   │                                     │     version++                     │
   │ ◄── OBSTACLE_VERIFY_SOLICIT ─────── │                                   │
   │      {obstacleId, version,          │ ── OBSTACLE_ALERT (STATE_CHANGE) ►│
   │       lat, lon, radiusM,            │    so the fleet sees the recheck  │
   │       deadlineMs}                   │                                   │
   │                                     │                                   │
   │ approach to verify_proximity_m      │                                   │
   │ observe (§13.4)                     │                                   │
   │ ── OBSTACLE_VERIFY_RESULT ────────► │                                   │
   │      {obstacleId, version, kind,    │ guard: distanceM ≤ verify_proximity_m
   │       lat, lon, distanceM,          │ guard: version freshness (§10.7)  │
   │       observedAt}                   │ record ObstacleObservation        │
   │                                     │                                   │
   │                        PRESENT ─────┤ T7: presentCount++, → ACTIVE      │
   │                                     │     window reset                  │
   │                                     │ ── OBSTACLE_ALERT (UPDATED) ─────►│
   │                                     │                                   │
   │                        CLEAR ───────┤ clearCount++                      │
   │                                     │ if clearCount ≥ clear_quorum:     │
   │                                     │    T8 → CLEARED                   │
   │                                     │    ── OBSTACLE_CLEARED ──────────►│
   │                                     │ else: stay RECHECK_REQUIRED,      │
   │                                     │    await a second independent      │
   │                                     │    observation                     │
   │ ◄── OBSTACLE_VERIFY_RESULT_ACK ──── │    {accepted, state, version,      │
   │                                     │     clearCount, quorum}            │
```

### 13.3 Design points

- **The agent decides to solicit; the server decides the state.** An agent cannot set state directly — it submits evidence and the arithmetic in §9.6 decides. This keeps a faulty agent from clearing the fleet's belief.
- **`RECHECK_REQUIRED` does not grant passage.** The obstacle still blocks. It is a *solicitation*, and the agent's approach behaviour is its own — the server issues no movement command (Rule 2).
- **Deadline.** `deadlineMs` bounds the solicitation. On expiry the obstacle falls back to its prior state and the solicitation is counted as `obstacle.verify.expired`. Implemented on the existing `sweepExpired` interval, not a new timer subsystem — this is the legacy tier and must not touch `engine/supervision/timers.js`.
- **One solicitation at a time per obstacle** (`verifyAssignedTo`), so two agents do not both divert. A second requester is told `alreadySolicited` and waits.
- **The first CLEAR does not clear.** With `clear_quorum = 2`, the first agent's CLEAR leaves the obstacle in `RECHECK_REQUIRED` with `clearCount = 1`. The `_ACK` says so explicitly (`{clearCount: 1, quorum: 2}`) so the agent knows its evidence landed and the obstacle is still believed. **This is the asymmetry doing its job**, and it is the behaviour most likely to be mistaken for a bug — §26 pins it (T-FUNC-11).

### 13.4 What "verify" means for the simulator — stated as an abstraction

`VirtualRobot` has **no sensor model** (§2.10). It cannot look at a point.

**Simulation-level abstraction, built only from capabilities that exist:**

> A `VirtualRobot` verifies an obstacle by (a) approaching to within `verify_proximity_m` of the obstacle centroid along its existing path, and (b) drawing the outcome from a configured simulator-only probability `sim.obstacle.persistence_probability` (default 0.7) seeded deterministically from `(obstacleId, robotId, incarnation)`.

- **Deterministic seeding, not `Math.random()`.** A replayed scenario must produce the same verdict, or the concurrency and failure tests in §26 are not reproducible. Note that `_maybeReportObstacle` currently uses bare `Math.random()` (`VirtualRobot.js:1650, 1653-1655`), which already makes obstacle scenarios unreproducible — a pre-existing testability gap this plan does not widen, and flags in §32 OQ-6.
- **`sim.*` namespace, not `legacy.*`.** This is a simulator fiction and must never be resolvable by server code. Register it under a `sim.` prefix with `consumers: ["src/simulation/VirtualRobot.js"]` so `gate:params` records that the server does not read it.
- **Real firmware substitutes a real observation** at the same protocol point. The wire contract (`OBSTACLE_VERIFY_SOLICIT` → `OBSTACLE_VERIFY_RESULT`) is identical; only the evidence source differs. That is the whole reason the protocol is specified in terms of *evidence submitted* rather than *sensor invoked*.

### 13.5 When no alternate route exists — and what the system does not do

The brief's scenario is "Robot B needs to pass and there is no reasonable alternate route." The **route-planning half of that decision is out of scope and stays out**: deciding whether an alternative exists is a planner's job, the planner is the engine, and the engine is off.

What this feature provides is the *verification protocol* the agent uses once it has made that determination locally. The agent's own logic (simulator: "my remaining path crosses OBS-x and I have no other path") triggers `OBSTACLE_VERIFY_REQUEST`. The server never computes an alternative, never rewrites a path, and never commands a movement — Rule 2, and the direct answer to the brief's "do not create a second route-planning engine."

---

## 14. Redis design

### 14.1 Constraints this design respects

`kv.js` offers only `get`, `set{ex}`, `del`, `sadd`, `srem`, `smembers`, `mget`, `setManyEx`, `pipeline()` (get/set only), `incr{ex}`, `reserveRobot` (`SET NX EX`), `releaseReservation`, `health`. No hashes, no sorted sets, no `SCAN`, no Lua, no pub/sub, no `MULTI`. **Every structure below uses only string, set and incr. No facade change is required** — deliberately, because `kv.js` sits under the telemetry hot path and any edit there is a hot-path edit.

### 14.2 Key inventory

| Key | Type | Value | TTL | Written by | Read by |
|---|---|---|---|---|---|
| `obs:o:{obstacleId}` | string | Obstacle JSON (§7.3) | `archive_after_ms` | `obstacleStore.report/verify/sweep` | dissemination, sync, API |
| `obs:zone:{zoneId}` | set | active obstacleIds in that zone | none (members pruned) | `obstacleStore` on state change | sync, digest, sweep |
| `obs:zone:digest:{zoneId}` | string | 16-hex digest | 300 s | `obstacleStore` after any zone write | sync compare (§11.3) |
| `obs:v:{obstacleId}` | string (int) | monotonic version counter | `archive_after_ms` | `kv.incr` | — (value returned by incr) |
| `obs:incarnation:{obstacleKey}` | string (int) | reappearance counter (§9.7) | 30 d | `kv.incr` | id derivation |
| `obs:watch:{robotId}` | set | zoneIds this robot's route crosses | none (cleared on task end) | `obstacleWatch` on route change | reconnect rejoin (§22.3) |
| `obs:sweep:lock` | string | holder id | 90 s | `kv.reserveRobot` (`SET NX EX`) | sweep leader election (§14.6) |
| `obs:rebuild:{zoneId}` | string | `"1"` | 60 s | rebuild path | negative-cache the rebuild (§22.4) |

**Retired:** `ekb:event:{obstacleId}` and `ekb:obstacles` (`ekb.service.js:17, 24`). Migration in §20.5 — the old keys are read once at startup and merged forward, then abandoned to their own TTLs. Nothing deletes them; they expire in ≤ 300 s.

**Naming.** `obs:` prefix, colon-delimited, matching the tree's existing `registry:{id}`, `taskPath:{id}`, `robot:{id}`, `snapshotState:{id}`, `vr:battery:{id}` convention. Short prefix because these keys are read in `mget` batches where key length is on the wire.

### 14.3 Read paths

**Zone sync (the hot one — per zone crossing, ~25/s at 5 000 robots):**
```
1. GET obs:zone:digest:{z}                       ← 1 round trip
2. if digest === agent's held digest: return     ← the common case, done in 1
3. SMEMBERS obs:zone:{z}                         ← 1
4. mget(ids.map(id => `obs:o:${id}`))            ← 1 (pipelined MGET)
```
Worst case 3 round trips; typical case 1. Bounded by **obstacles per zone**, never by fleet size.

**Obstacle report (per report, ~5/s at 5 000 robots):**
```
1. mget(9 neighbour grid keys)                   ← 1 (the 3x3 merge probe, §14.4)
2. incr obs:v:{id}                               ← 1
3. pipeline().set(obs:o:{id}).set(obs:zone:digest:{z}, "")  ← 1
4. sadd obs:zone:{z} {id}                        ← 1  (skipped when merging into an existing member)
```
**4 round trips, constant in N.** Compare with today's `1 + N` (B-5).

`kv.pipeline()` cannot express `SADD`, so step 4 is its own call. Acceptable: it is skipped on the merge path, which is the common case once a zone has settled.

### 14.4 The 3x3 merge probe

§7.2's grid snapping merges reports within one cell but splits two reports straddling a cell boundary. The probe reads the 9 candidate ids around the snapped point in one `mget` and merges into the first **active** neighbour whose centroid is within `merge_grid_degrees` in true distance:

```
candidates = for dLat in [-1,0,1], dLon in [-1,0,1]:
                 idFor(zoneId, snap(lat)+dLat*GRID, snap(lon)+dLon*GRID)
existing   = kv.mget(candidates.map(k => `obs:o:${k}`))     ← 1 round trip
match      = first parsed record with state in {ACTIVE, STALE, RECHECK_REQUIRED, DISPUTED}
             and haversine(record, report) <= merge_radius
```

Nine keys in one `MGET` is one round trip and ~1 KB on the wire. This is the whole of the identity mechanism's I/O cost.

**Order-independence under concurrency:** two workers processing simultaneous reports of the same obstacle derive the same snapped id and the same candidate list. Both may write `obs:o:{id}`; last write wins on the *record*, but `presentCount` is derived from the `reporters` array and `version` comes from atomic `INCR`, so neither count can be lost to a lost update — see §23.5 for the read-modify-write hazard and its bound.

### 14.5 Write concurrency and the lost-update bound

`kv` has no `WATCH`/`MULTI`, so `obs:o:{id}` read-modify-write is not atomic across workers. Two simultaneous reports on one obstacle can lose one `reporters` entry.

**Bound, and why it is acceptable:**
- `version` is `INCR`, so **ordering is never lost** — the agent-side idempotency rule (§10.7) stays sound.
- The lost field is at most one entry in `reporters`/`clearers`, i.e. a count that is *low* by one. Low counts are the **conservative** direction for `presentCount` (fewer reasons to believe → but T1 already created the obstacle) and for `clearCount` (fewer reasons to clear → obstacle stays believed). **A lost update can never clear an obstacle that should not be cleared.**
- Postgres `ObstacleObservation` is the authoritative evidence log and is append-only, so the true counts are always recoverable. §15.5 defines a reconciling recount on the sweep.

This is the same "advisory cache, durable truth" split `kv.reserveRobot`'s Phase 15 demotion documents (`kv.js`, `advisory` default true). Stated as an accepted design bound rather than discovered later.

### 14.6 The sweep, and single-execution across workers

`sweepExpired` is started unconditionally in every process (`socket.server.js:163-170`), which is harmless today because it only prunes a set. The new sweep performs **state transitions** (T3, T5, T12), so N workers running it means N attempts at the same transition.

**Election:** `kv.reserveRobot("obs:sweep:lock", processId, 90, { advisory: true })` — `SET NX EX`, already in the facade, already used for exactly this shape. Advisory is correct here: every transition the sweep performs is **idempotent and monotonic** (`ACTIVE → STALE` twice is `STALE`), so a double-run costs duplicate work and never a wrong state. That is why this needs no consensus store and does not touch B3.

Interval: reuse the existing 60 s `setInterval` in `socket.server.js:163-170`, with the same `.unref()`. **No new timer subsystem, no `engine/supervision/timers.js` dependency.**

### 14.7 Invalidation

- Any write to an obstacle in zone Z sets `obs:zone:digest:{Z}` to `""` (empty sentinel, not `del`, so one pipelined `SET` does it alongside the record write). An empty digest forces recomputation on next read.
- A `CLEARED` obstacle is `srem`'d from `obs:zone:{Z}` at transition time, not at archive time, so the zone's active set is accurate immediately.
- Zone definition changes already call `invalidateZoneCache` (`zoneManager.service.js:71-81`). The neighbour map (§10.4) is cached alongside `zones:all` and is invalidated by the same call — no new invalidation path.

### 14.8 Degradation when Redis is unavailable

The facade degrades to in-memory maps automatically (`kv.js:95-113`) with capped-exponential reconnect. Consequences, stated per structure:

| Structure | Behaviour on Redis loss | Correctness impact |
|---|---|---|
| `obs:o:*`, `obs:zone:*` | Per-process memory | Workers diverge on obstacle state. Postgres is the reconciler (§22.4) |
| `obs:v:*` | Per-process `INCR` | **Versions can collide across workers.** Agents may drop a legitimate update. Mitigated: on Redis recovery the sweep bumps every live obstacle's version once, forcing resync. Counted as `obstacle.version.degraded` |
| Socket.IO adapter | Falls back to single-process (`server.js:341-347`) | **Zone emits reach only the emitting worker's sockets.** This is the dominant multi-worker failure and it is loud in the log by design |
| Digest | Recomputed per process | Extra CPU only |

**A single-process deployment with no `REDIS_URL` is fully correct** — memory maps and the default adapter agree. The degraded case that matters is *multi-worker with Redis down*, and §17.4 states plainly that dissemination is best-effort there and reconciliation is what restores it.

---

## 15. PostgreSQL / Prisma design

### 15.1 Principle

Postgres holds **durable history and the rebuild source**. It is never on the alert delivery path. Two additive changes; no destructive migration; no change to any existing column's type or nullability.

### 15.2 `ObstacleEvent` — extended in place

Current model (`prisma/schema.prisma:308-330`): `id`, `obstacleId @unique`, `lat`, `lon`, `zoneId?` → `Zone` `onDelete: SetNull`, `severity` (String, default "MEDIUM"), `reportingRobotId?`, `expiresAt`, `createdAt`, indexes on `zoneId` and `expiresAt`.

**Added columns — all nullable or defaulted, so the migration is additive and backward compatible:**

| Column | Type | Default | Purpose |
|---|---|---|---|
| `state` | `ObstacleState` (new enum) | `ACTIVE` | §9 lifecycle |
| `version` | `Int` | `1` | Ordering / idempotency |
| `radiusM` | `Float?` | `null` | Delivered radius |
| `firstSeenAt` | `DateTime` | `now()` | Analytics |
| `lastSeenAt` | `DateTime?` | `null` | Last PRESENT evidence |
| `lastCheckedAt` | `DateTime?` | `null` | Last evidence of any kind |
| `presentCount` | `Int` | `1` | Evidence arithmetic |
| `clearCount` | `Int` | `0` | Evidence arithmetic |
| `clearedAt` | `DateTime?` | `null` | Terminal timestamp |
| `clearedBy` | `String?` | `null` | `robotId`, `"OPERATOR:{userId}"`, or `null` |
| `incarnation` | `Int` | `1` | §9.7 reappearance |
| `mergeKey` | `String?` | `null` | `{zoneId}:{snapLat}:{snapLon}` — the identity key |

```prisma
enum ObstacleState {
  ACTIVE
  STALE
  RECHECK_REQUIRED
  VERIFIED_PRESENT
  CLEARED
  DISPUTED
  ARCHIVED
}
```

**Not reusing `ObstructionClass`** (`schema.prisma:794-799`: `CLEAR`/`RESTRICTIVE`/`BLOCKING_CRITICAL`/`INDETERMINATE`). That enum is the engine's *hazard classification* for feasibility predicates; this is a legacy-tier *lifecycle state*. Overloading it would create exactly the legacy→engine semantic coupling audit §16 item 5 warns against, and would put a legacy writer on an engine enum.

**New indexes:**
```
@@index([state])                  // sweep: find expiring ACTIVE rows
@@index([zoneId, state])          // zone rebuild (§22.4) — the important one
@@index([mergeKey, incarnation])  // identity resolution on rebuild
```
`@@index([expiresAt])` already exists and is reused by the sweep.

**Why `obstacleId` stays `@unique` and identity is content-derived:** the id is now `sha1(mergeKey + incarnation)`, so uniqueness is a real constraint that catches an identity-derivation bug at the schema level rather than in application logic — the same "schema backstops that reject violations independently of application logic" discipline `Commitment` uses.

### 15.3 `ObstacleObservation` — NEW MODEL REQUIRED

**Why a new model rather than reusing something.** Candidates considered and rejected:
- `Event` (`schema.prisma:486`) — free-text `message` on a `robotId`; no queryable structure, and it is the fault/audit stream.
- `Observation` (`schema.prisma:1988`) — the **engine's** §2.7 record, keyed on `Agent.id`, consumed by `verification.js` and the reconciler. Writing legacy obstacle reports into it would put unvalidated legacy data into an engine-tier evidence stream that `dtaro.handler.js:512-525` reads for completion verification. **Categorically wrong.**
- `Telemetry` (`schema.prisma:466`) — position history, throttled, wrong cardinality.

```prisma
model ObstacleObservation {
  id         String   @id @default(uuid())
  obstacleId String                        // NOT an FK — see below
  robotId    String?
  kind       ObstacleObservationKind
  lat        Float
  lon        Float
  distanceM  Float?
  reportedSeverity String?
  solicited  Boolean  @default(false)
  accepted   Boolean  @default(true)
  rejectReason String?
  atVersion  Int?
  observedAt DateTime
  receivedAt DateTime @default(now())

  @@index([obstacleId, observedAt])
  @@index([robotId, observedAt])
  @@index([observedAt])
}

enum ObstacleObservationKind { PRESENT  CLEAR }
```

**No foreign key to `ObstacleEvent`, deliberately.** The observation must survive the obstacle's archival and deletion — that is the entire point of separating history from operational state (§7.1). An FK with `onDelete: Cascade` would destroy the analytics corpus; with `Restrict` it would block archival. A soft reference with an index is correct here, and matches how `ObstacleEvent.reportingRobotId` is already a bare `String?` rather than an FK.

**No FK on `robotId`** for the same reason and for consistency with the existing `reportingRobotId` column.

### 15.4 Narrowing the swallowed catch — G-19 closed

`ekb.service.js:76-84` wraps the Postgres write in `try { … } catch { /* Silently skip if model unavailable */ }`. That comment described a real transitional state (the model might not exist yet); it does exist now, and the bare catch currently hides schema drift, constraint violations and pool exhaustion identically.

**Change:** keep the write best-effort — it must never block the alert — but count and log it. `obstacle.store.pg_write_failed{code}` plus a rate-limited `log.error`. A persistent non-zero rate here means the durable half is not durable, which is unrecoverable-by-design today.

### 15.5 The reconciling recount

On each sweep pass, for obstacles whose `lastCheckedAt` is inside the last window, recompute `presentCount`/`clearCount` from `ObstacleObservation` (`groupBy` on `obstacleId, kind` over a bounded id set) and correct the Redis record if it disagrees. This repairs the §14.5 lost-update bound from the authoritative log. Divergences are counted as `obstacle.evidence.recount_corrected` — a non-zero rate is the direct measurement of the concurrency bound, which is better than asserting it is small.

### 15.6 Migration plan

| Order | Migration | Reversible | Notes |
|---|---|---|---|
| M1 | `CREATE TYPE "ObstacleState"`, `CREATE TYPE "ObstacleObservationKind"` | Yes (`DROP TYPE`) | No table touched |
| M2 | `ALTER TABLE "ObstacleEvent" ADD COLUMN …` x12, all `NULL` or `DEFAULT` | Yes | **No table rewrite** — Postgres 11+ adds a defaulted column without rewriting |
| M3 | `CREATE INDEX CONCURRENTLY` x3 on `ObstacleEvent` | Yes | `CONCURRENTLY` so no write lock. Prisma emits plain `CREATE INDEX`; the generated SQL must be hand-edited — **flagged for the implementer**, and it is why M3 is its own migration |
| M4 | `CREATE TABLE "ObstacleObservation"` + 3 indexes | Yes (`DROP TABLE`) | New table, no interaction |
| M5 | Backfill: `UPDATE "ObstacleEvent" SET "mergeKey" = …, "firstSeenAt" = "createdAt" WHERE "mergeKey" IS NULL` | N/A | Rows are ≤ 300 s old by construction; expected count near zero |

**Backward compatibility.** The current `ekb.storeObstacle` `create` call (`ekb.service.js:78-80`) supplies `obstacleId, lat, lon, zoneId, severity, reportingRobotId, expiresAt` — every added column is defaulted, so **the old writer keeps working after M2 and before the code change lands**. That is what makes migrate-then-deploy safe and lets §28 roll the code back without rolling back the schema.

Existing rows are treated as `state = ACTIVE, version = 1, incarnation = 1` and expire naturally.

**No migration is executed by this plan.**

---

## 16. Socket.IO design

### 16.1 Rooms

| Room | Members | Joined | Left | Emitted to |
|---|---|---|---|---|
| `dashboard` | Operator browsers | `socket.server.js:222` | disconnect | existing + `OBSTACLE_*` mirrors |
| `robot:{robotId}` | One agent socket | `robot.handler.js:658` | disconnect | sync, solicit — via `commandDispatcher` |
| `zone:{zoneId}` | Agents currently inside Z | `zoneManager.js:115` (+ B-7 fix, §11.2) | on crossing / disconnect | **`OBSTACLE_ALERT` — NEW, closes G-1** |
| `zone:__unzoned` | Agents outside all zones | same hook, `zoneId === null` | — | `OBSTACLE_ALERT` for `zoneId = null` obstacles (§8.4) |
| `zonewatch:{zoneId}` | Agents whose route crosses Z | **NEW** — on route establishment | task end / disconnect | `OBSTACLE_ALERT` |

Two new room families. Both are `socket.join`/`socket.leave` on an existing socket, both are idempotent, and neither requires an adapter feature beyond what `dashboard` already uses.

### 16.2 The emit

```js
// obstacleDissemination.publish — one adapter publish for the whole fleet
const rooms = [`zone:${z}`, `zonewatch:${z}`, ...neighbourRooms(z)];
io.to(rooms).emit("OBSTACLE_ALERT", envelope);
```

Socket.IO's `io.to(a).to(b)` — or `io.to([a, b])` — computes the **union of room members and delivers once per socket**. A robot both standing in Z and watching Z receives one message, not two. That is a property of the adapter's `BroadcastOperator`, not something this design has to implement. `REQUIRES VERIFICATION` at integration-test level (T-FUNC-04 asserts exactly-once under dual membership) — the semantics are documented for socket.io v4, but the tree pins `^4.8.3` and the union guarantee is worth pinning with a test rather than trusting.

### 16.3 Event flow, end to end

```
OBSTACLE_REPORT (agent → server)
  └─ dtaro.handler: rateLimit.allow → zod parse → authed robotId
     └─ obstacleStore.report()               4 Redis round trips, 1 PG upsert
        └─ obstacleDissemination.publish()   1 adapter publish + 1 dashboard emit
           ├─ zone:{z}         → agents inside Z
           ├─ zonewatch:{z}    → agents routed through Z
           ├─ zone:{neighbour} → boundary case (§10.4)
           └─ dashboard        → operators
     └─ socket.emit("OBSTACLE_REPORT_ACK", {obstacleId, version, state, merged})
```

`OBSTACLE_REPORT_ACK` keeps its existing name and adds fields. Today it returns `{obstacleId, affectedRobots, timestamp}` (`dtaro.handler.js:92-96`). `affectedRobots` is **removed** — it is a fleet-scan artefact that is always `0` (B-2/B-5), and with room addressing the server no longer knows the count. Replaced by `{merged, state, version}`, which is information the reporter can act on. This is a **breaking payload change on an ACK**; `VirtualRobot` does not read it (grep: no handler for `OBSTACLE_REPORT_ACK`), so the blast radius is the dashboard only. Noted in §21.

### 16.4 Duplicate suppression across the three channels

An agent can plausibly receive the same obstacle three ways: the zone alert, a watch alert (dual membership), and a zone sync. All three are collapsed by **one rule on the agent**: `if (held.version >= env.version) drop` (§10.7). No server-side dedup table, no per-agent state, no coordination.

### 16.5 Rate limiting

New inbound events use `rateLimit.allow` verbatim (§10.3 table). The limiter is per-socket, per-event, in-process, bounded by fleet size with opportunistic cleanup (`rateLimit.js:17-22`) — the same pattern this codebase already accepts for `lastDbFlushAt` and `implausibleReportCounts`.

**Outbound rate limiting is not added.** Alert volume is bounded by the inbound limiter times the report rate, and the union-emit means one publish regardless of recipients. A per-zone outbound throttle is listed in §31 as a mitigation to add only if measurement shows a hot zone.

---

## 17. Multi-worker considerations

The brief flags this specifically: *"Do not assume Socket.IO broadcasts behave correctly across workers without verifying the current architecture."* Verified, with the failure modes stated.

### 17.1 What is actually true in this tree

- The Redis adapter is attached **only if** `REDIS_URL` is set and `REDIS_ENABLED !== "false"` (`server.js:328-330`).
- On adapter-attach failure the process logs a warning and **continues with the default single-process adapter** (`server.js:341-347`). The comment there is explicit that this is "the one place where that fallback is a real behavior change … rather than a transparent degrade."
- There is **no `cluster` fork**. Multi-worker means separately started processes behind a load balancer.
- `robotSockets` is a per-process `Map` (`robotSockets.js:5`) and must never be used for delivery. `commandDispatcher.service.js:5-19` documents this at length; `alertDissemination` currently bypasses the dispatcher and emits directly — which happens to be adapter-routed anyway because it uses `io.to()`, but gets no presence check or result.

### 17.2 How each mechanism behaves across workers

| Mechanism | Cross-worker correctness | Why |
|---|---|---|
| `OBSTACLE_ALERT` room emit | **Correct** (adapter attached) | `io.to(room)` publishes through the adapter to all workers |
| Zone room membership | **Correct** | Membership lives with the socket, on its owning worker; the adapter routes to it |
| `zonewatch` membership | **Correct**, same mechanism | Mirrored to `obs:watch:{robotId}` for reconnect only |
| Unicast sync/solicit via `dispatch()` | **Correct** | `io.in(room).fetchSockets()` is adapter-aware (`commandDispatcher.service.js:86-90`) |
| Obstacle state in Redis | **Correct** | Shared store; `INCR` is atomic |
| Obstacle record RMW | **Bounded divergence** | §14.5; repaired by §15.5 recount |
| Digest cache | **Correct** | Shared key; empty sentinel forces recompute |
| Sweep transitions | **Single-executed** | `SET NX EX` lock (§14.6); transitions idempotent anyway |
| In-process zone cache | **Eventually consistent, 60 s** | Pre-existing (`zoneManager.js:20`); a zone *definition* change takes ≤ 60 s to propagate. Unchanged by this plan |

### 17.3 The one genuinely new cross-worker hazard

**Two workers processing simultaneous reports of one physical obstacle.** Both derive the same `obstacleId` (content-addressed, §7.2 — this is exactly why the id is derived rather than generated). Both `INCR` the version, getting distinct values. Both write the record; the later write wins.

Outcome: one `reporters` entry may be lost (§14.5 bound), two `OBSTACLE_ALERT`s are published with versions v and v+1, and agents apply the higher and drop the lower — **correct by the idempotency rule**. Nothing diverges permanently. The lost count is repaired by §15.5.

This is a considered trade rather than an oversight: making it exactly-once would require `WATCH`/`MULTI` or Lua, i.e. a `kv.js` facade extension, i.e. a hot-path module edit, to remove a bounded error that resolves in the safe direction and is repaired within one sweep interval.

### 17.4 When the adapter is absent

If `REDIS_URL` is unset (legitimate single-process mode) everything is correct. If the adapter *fails to attach* in a multi-worker deployment, `OBSTACLE_ALERT` reaches only the emitting worker's sockets. That is the pre-existing failure this codebase already accepts and logs loudly for `dashboard`; this feature inherits it and does not worsen it.

**Mitigation available without new infrastructure:** `OBSTACLE_ZONE_SYNC` is unicast through `commandDispatcher.dispatch`, which presence-checks via `fetchSockets()`. In a broken-adapter deployment `fetchSockets()` also returns only local sockets, so the sync *result* is `dispatched: false` for remote agents — which is **observable**. `obstacle.sync.undelivered` therefore becomes a working detector for a silently-degraded adapter, which the codebase does not currently have. That is a genuine side-benefit and is called out in §25.

### 17.5 Restart behaviour

| Event | Effect | Recovery |
|---|---|---|
| One worker restarts | Its sockets reconnect (possibly to another worker); room membership is rebuilt at AUTH | S-1/S-2 sync (§11.1); `obs:watch:{robotId}` restores watch rooms |
| All workers restart | All rooms empty; Redis obstacle state survives | Agents re-AUTH and sync |
| Redis restarts | Obstacle state lost; adapter reconnects | Rebuild from Postgres per zone, lazily (§22.4) |
| Postgres restarts | Writes fail best-effort, counted (§15.4) | Redis keeps serving; observations for the outage window are lost — **an accepted, counted gap** |

---

## 18. Phase-wise implementation plan

Thirteen phases. Phases 0–4 deliver Feature 1 and are shippable on their own; 5–6 deliver Feature 2; 7–8 deliver Feature 3; 9–12 are the production-safety wrapper the brief requires.

**Ordering principle, taken from this programme's own recorded lesson:** the audit's §12.7 says the measurement instrument is the prerequisite for every other decision, and the reconciliation records seven separate cases of a green suite hiding a composition-join defect. So **Phase 1 is the instrument, and every later phase adds a test that would fail if its join were absent.**

---

### Phase 0 — Reconnaissance confirmation and pinning

**Goal:** turn the seven findings in §1.1 from claims into failing tests before anything is fixed.

| Item | Deliverable |
|---|---|
| 0.1 | Test pinning B-1: assert no production module emits to a `zone:*` room today (a source assertion in the `gates` lane, mirroring `checkLegacyRetirement.js`'s shape) |
| 0.2 | Test pinning B-2: run `processObstacleReport` against a registry populated as `telemetry.handler` populates it; assert `affectedRobotIds === []` |
| 0.3 | Test pinning B-4: `findAffectedRobots` with a path parallel to the SW→NE diagonal, through the point; assert `false` (the defect) |
| 0.4 | Test pinning B-7: AUTH → disconnect → re-AUTH within registry TTL; assert the new socket is **not** in `zone:{z}` |
| 0.5 | Baseline benchmark run (§27) at 100/500 robots on the current tree |

**Files:** `Backend/tests/unit/dtaro/obstaclePipelineBaseline.test.js` **[NEW]**, `Backend/tests/unit/dtaro/zoneRoomRejoin.test.js` **[NEW]**.
**Touches production code:** none.
**Risk:** none. **Rollback:** delete tests.

**Why first.** These tests invert at Phase 3/4/5 into the assertions that the fix landed. A defect pinned before the fix cannot be silently un-fixed later — which is the specific failure mode this programme has recorded most often.

---

### Phase 1 — The dissemination measurement instrument

**Goal:** the audit's A-1, and the false-negative column that makes every later choice evidential rather than asserted.

**NEW MODULE REQUIRED:** `Backend/tools/awareness/disseminationPolicy.js`

Offline harness. Reads a fixture fleet trace (positions, routes, obstacle reports) and replays it through four policies — `broadcast`, `zone-only`, `zone+route`, `route-only` — plus the fifth this plan actually implements, `zone∪watch∪receiver`. Reports per policy: agents notified, **agents missed** (ground truth = remaining path actually passes within radius), coordinator Redis ops, adapter publishes, bytes on the wire, and p50/p99 notify latency.

| Item | Deliverable |
|---|---|
| 1.1 | The harness, reading fixtures, writing a JSON + Markdown report |
| 1.2 | Fixture generator: N robots over the seeded 4-quadrant campus with synthetic routes, at N in {100, 500, 1 000, 2 000, 5 000} |
| 1.3 | `npm run awareness:policy` script in `package.json` |
| 1.4 | Committed baseline report for the current tree |

**Files:** `Backend/tools/awareness/disseminationPolicy.js` **[NEW]**, `Backend/tools/awareness/fixtures.js` **[NEW]**, `Backend/tests/fixtures/awareness/*.json` **[NEW]**, `Backend/package.json` (one script line).
**Touches runtime path:** none — `tools/` only, same class as `tools/routing/b1Benchmark.js`.
**Risk:** none. **Rollback:** delete.

**Why second.** It is the only item with zero architectural risk, it does not wait on B1/B8/T1-04, and it produces the number (`agents missed`) that §1.5's reconciliation of the audit's DO-NOT-IMPLEMENT depends on. If the union design were wrong, this is what would show it — **before** Phase 4 ships it.

---

### Phase 2 — Data model and configuration

**Goal:** the domain model, the register entries, the schema. No behaviour change.

| Item | Deliverable |
|---|---|
| 2.1 | `register/legacy.json`: 13 `legacy.obstacle.*` entries (§9.5), all `UNCALIBRATED`, owner Operations, with `retiresInPhase` notes |
| 2.2 | A `sim.` section: `sim.obstacle.persistence_probability` with `consumers: ["src/simulation/VirtualRobot.js"]` |
| 2.3 | `engine/config/validators.js`: new cross-parameter validator (§9.5) |
| 2.4 | Prisma: `ObstacleState`, `ObstacleObservationKind` enums; 12 columns on `ObstacleEvent`; `ObstacleObservation` model; 3+3 indexes |
| 2.5 | Migrations M1–M5 **authored, not run** (§15.6), with M3's `CONCURRENTLY` hand-edit flagged |
| 2.6 | `Backend/src/config/obstacle.constants.js` **[NEW]** — resolves the register entries and re-exports, exactly mirroring `liveness.constants.js`'s shape including the throwing `required()` |

**Files:** `Backend/prisma/schema.prisma`, `Backend/prisma/migrations/…` **[NEW]**, `Backend/src/engine/config/register/legacy.json`, `Backend/src/engine/config/validators.js`, `Backend/src/config/obstacle.constants.js` **[NEW]**.
**Dependencies:** none. **Risk:** low — additive schema only.
**Rollback:** the code change is revertible independently of the migration (§15.6: old writer works against new schema).
**Gate impact:** `gate:params` must stay PASS — new entries need every required field. `gate:tiers` unaffected (no engine module added).

---

### Phase 3 — Obstacle store: identity, merge, lifecycle

**Goal:** replace the EKB's generate-and-forget with identity, merge and state. Still no dissemination change.

**NEW MODULE REQUIRED:** `Backend/src/services/obstacleStore.service.js`

Why a new module rather than extending `ekb.service.js`: `ekb.service` is imported by `alertDissemination`, `socket.server` (sweep) and tests, and its three functions have fixed signatures. The new store owns identity, versioning, state and the zone index — a different responsibility with a different data shape. `ekb.service.js` is **kept** and reduced to durable-history concerns (the Postgres write and the sweep helper), which is the role its name already describes.

| Item | API |
|---|---|
| 3.1 | `deriveId({zoneId, lat, lon, incarnation})` — pure, exported for test |
| 3.2 | `report(kv, prisma, {lat, lon, zoneId, severity, robotId, observedAt})` → `{obstacle, merged, created}` — the 3x3 probe, `INCR`, record write, zone set, digest invalidation, PG upsert, observation append |
| 3.3 | `activeForZone(kv, zoneId)` → `Obstacle[]` — `SMEMBERS` + `mget`, bounded |
| 3.4 | `digestForZone(kv, zoneId)` → `string` — cached |
| 3.5 | `applyEvidence(kv, prisma, {obstacleId, robotId, kind, distanceM, observedAt, atVersion})` → new state — §9.6 arithmetic |
| 3.6 | `sweep(kv, prisma)` — T3/T5/T12 + §15.5 recount, under the `SET NX EX` lock |
| 3.7 | `rebuildZone(kv, prisma, zoneId)` — §22.4 |

**Files:** `Backend/src/services/obstacleStore.service.js` **[NEW]**, `Backend/src/services/ekb.service.js` (reduced scope + §15.4 catch narrowing), `Backend/src/sockets/socket.server.js:163-170` (sweep now calls `obstacleStore.sweep`).
**Dependencies:** Phase 2.
**Expected change:** ~450 lines new, ~40 changed.
**Risk:** medium — this is where the concurrency bound (§14.5) lives.
**Tests:** T-FUNC-01/02, T-EDGE-01/02/03/08/09, T-CONC-01/02 (§26).
**Rollback:** flag-gated (§28); with the flag off, `dtaro.handler` calls the old `processObstacleReport` unchanged.

---

### Phase 4 — Zone-targeted dissemination + the severed edge

**Goal:** Feature 1 primary. **The highest-risk phase, because it is where B-6 is disarmed.**

**NEW MODULE REQUIRED:** `Backend/src/services/obstacleDissemination.service.js` — replaces `alertDissemination.service.js`.

| Item | Deliverable |
|---|---|
| 4.1 | `publish(io, obstacle, {reason})` — build envelope (§10.4), resolve room list incl. neighbours, **one** `io.to(rooms).emit`, dashboard mirror |
| 4.2 | `neighbourRooms(zoneId)` — precomputed at zone-cache load, cached with `zones:all` |
| 4.3 | **Delete** the `rerouteRobot` call. **Delete** `getAllRobotIds` + per-robot `getRobotState` scan. **Delete** the `REROUTE_ALERT` emit |
| 4.4 | Bounded shadow relevance sample → metrics only, no delivery authority (§12.4) |
| 4.5 | `dtaro.handler.js:85-96` rewired to `obstacleStore.report` → `obstacleDissemination.publish`; ACK payload updated (§16.3) |
| 4.6 | `alertDissemination.service.js` retired: reduced to a re-export shim that logs a deprecation and delegates, so any missed caller is loud rather than broken |

**Files:** `Backend/src/services/obstacleDissemination.service.js` **[NEW]**, `Backend/src/services/alertDissemination.service.js` (retired to shim), `Backend/src/sockets/handlers/dtaro.handler.js` (~15 lines), `Backend/src/services/zoneManager.service.js` (neighbour map).
**Dependencies:** Phases 2, 3.
**Risk:** **high** — this is the load-bearing change. Mitigations: the flag (§28), Phase 0's inverted tests, and an explicit source-level gate test asserting `obstacleDissemination` does not import `routing.service` (the composition-join check this programme's history says is the one that gets missed).
**Rollback:** flag off restores the old path byte-for-byte; the shim guarantees no caller is left dangling.

---

### Phase 5 — Receiver-side relevance and the geometry fix

**Goal:** Feature 2b. Works today, no route infrastructure needed.

| Item | Deliverable |
|---|---|
| 5.1 | `routeIntersection.service.js`: add `pointSegmentDistanceM`, `pathApproachesPoint` (§12.3). **Existing exports untouched** |
| 5.2 | `VirtualRobot`: obstacle map, version idempotency, `OBSTACLE_ALERT` handler, `_evaluateObstacleRelevance` (§11.5) |
| 5.3 | Agent behaviour on relevance: slow to `SPEED_MIN_MS`, hold at standoff, **never mutate `activePath`** (Rule 2) |
| 5.4 | Server-side shadow sample uses the same predicate |
| 5.5 | Invert Phase 0's B-4 test to assert the parallel case is now detected |

**Files:** `Backend/src/services/routeIntersection.service.js` (+~60 lines, additive), `Backend/src/simulation/VirtualRobot.js` (+~90 lines).
**Dependencies:** Phase 4.
**Risk:** low — additive on both sides; the simulator is not production.

---

### Phase 6 — Route-zone watch rooms (early warning)

**Goal:** Feature 2a, behind the §12.2 input ladder.

**NEW MODULE REQUIRED:** `Backend/src/services/obstacleWatch.service.js`

| Item | Deliverable |
|---|---|
| 6.1 | `zonesOnRoute(path)` (§12.6) — pure, `segmentIntersectsBox` slab test |
| 6.2 | `updateWatch(io, kv, robotId, path)` — diff current vs desired, join/leave, mirror to `obs:watch:{robotId}` |
| 6.3 | `clearWatch(io, kv, robotId)` — on task end/cancel |
| 6.4 | Ladder L0: no route → empty set, **explicitly logged once per robot**, not silently |
| 6.5 | Ladder L1 hook: `task.service.rerouteTask` after the `taskPath` write (`:507-510`) |
| 6.6 | Ladder L2 adapter **specified, not built** — reads `Stop` rows; deferred to after cutover, named in §33 |
| 6.7 | Reconnect: rejoin from `obs:watch:{robotId}` at AUTH |

**Files:** `Backend/src/services/obstacleWatch.service.js` **[NEW]**, `Backend/src/services/task.service.js` (~4 lines, in `rerouteTask` only — **`assignTask` is not touched**), `Backend/src/controllers/tasks.controller.js:286-297` (add `clearWatch` next to the existing cleanup), `Backend/src/sockets/handlers/robot.handler.js` (rejoin at AUTH).
**Dependencies:** Phases 3, 4.
**Risk:** low — an empty watcher set is correct, not broken (Rule 1).
**Honest note:** at L0 this phase contributes **nothing observable in production today**. It is built now because it is cheap, because the ladder makes it inert-but-correct rather than inert-and-wrong, and because building it after cutover would put it on the critical path. §33 states the condition under which it becomes live.

---

### Phase 7 — Zone-entry state synchronisation

**Goal:** Feature 1 secondary + the B-7 fix.

| Item | Deliverable |
|---|---|
| 7.1 | `obstacleDissemination.syncAgentToZone(io, kv, robotId, zoneId, heldDigest)` — digest compare, bounded payload, `commandDispatcher.dispatch` with retry |
| 7.2 | Hook S-3: call from `applyZoneChangeSideEffects` (`zoneManager.js:189-213`) |
| 7.3 | Hook S-1/S-2: call from AUTH (`robot.handler.js:674-683`) |
| 7.4 | **B-7 fix:** move `updateSocketZoneRoom` out of the `changed` branch (§11.2) |
| 7.5 | `zone:__unzoned` room for `zoneId === null` (§8.4) |
| 7.6 | `OBSTACLE_ZONE_SYNC_ACK` handler; agent digest carried on AUTH |
| 7.7 | Agent side: apply, prune, ACK (§11.5) |
| 7.8 | Invert Phase 0's B-7 test |

**Files:** `Backend/src/services/obstacleDissemination.service.js`, `Backend/src/services/zoneManager.service.js` (~15 lines), `Backend/src/sockets/handlers/robot.handler.js` (~20 lines), `Backend/src/sockets/handlers/dtaro.handler.js` (ACK handler), `Backend/src/simulation/VirtualRobot.js`.
**Dependencies:** Phases 3, 4.
**Risk:** medium — touches AUTH. Mitigation: every addition is inside its own `try/catch` following the existing "zone assignment is non-critical — never block auth" convention (`robot.handler.js:681-683`).

---

### Phase 8 — Verification and clearance

**Goal:** Feature 2 (clearance) and the evidence half of Feature 3.

**NEW MODULE REQUIRED:** `Backend/src/services/obstacleVerification.service.js`

| Item | Deliverable |
|---|---|
| 8.1 | `requestVerification(...)` — guards, T6, solicit, `verifyAssignedTo` |
| 8.2 | `submitResult(...)` — proximity guard, version freshness, `applyEvidence`, T7/T8 |
| 8.3 | Solicitation deadline expiry on the existing sweep |
| 8.4 | Operator clear: `POST /api/obstacles/:id/clear` (T9), RBAC + audit |
| 8.5 | `GET /api/obstacles` (zone/state filter), `GET /api/obstacles/:id` (with observation history) |
| 8.6 | New router `obstacles.routes.js` mounted in `routes/index.js` |
| 8.7 | Agent side: solicit when blocked with no detour; approach; report (§13.4 abstraction) |

**Files:** `Backend/src/services/obstacleVerification.service.js` **[NEW]**, `Backend/src/controllers/obstacles.controller.js` **[NEW]**, `Backend/src/routes/obstacles.routes.js` **[NEW]**, `Backend/src/routes/index.js` (2 lines), `Backend/src/sockets/handlers/dtaro.handler.js` (2 handlers), `Backend/src/simulation/VirtualRobot.js`.
**Dependencies:** Phases 3, 5, 7.
**Risk:** medium — the quorum arithmetic is where a permissive bug would hide. §26 T-FUNC-11/12/13 and T-CONC-03 target it specifically.

---

### Phase 9 — Observability

**Goal:** §25 in full, including the false-negative column.

| Item | Deliverable |
|---|---|
| 9.1 | Counters via `engine/observability/sli.js` — **not** `metrics.service.recordAllocation` (§2.12) |
| 9.2 | `logger.obstacle` now passed real `zoneId` and recipient-tier counts (the parameters already exist, `logger.js:453`) |
| 9.3 | `obstacle.relevance.missed` from the shadow sample |
| 9.4 | `obstacle.sync.undelivered` as the degraded-adapter detector (§17.4) |
| 9.5 | `GET /api/diagnostics/obstacles` on the existing diagnostics router |
| 9.6 | Dashboard events for the new lifecycle states |

**Files:** `Backend/src/services/metrics.service.js` (read-side only), `Backend/src/routes/diagnostics.routes.js`, `Backend/src/config/logger.js` (call sites only), the four new services.
**Dependencies:** Phases 4–8. **Risk:** low.

---

### Phase 10 — Testing

Full matrix in §26: functional, edge, concurrency at 100/500/1 000/2 000/5 000, failure injection. Lanes: `legacy` for unit/integration, `scale` for the tiers, `gates` for the composition-join source assertions.

**Files:** `Backend/tests/unit/dtaro/obstacle*.test.js` **[NEW]** x6, `Backend/tests/integration/obstacleLifecycle.test.js` **[NEW]**, `Backend/tests/scale/obstacleDissemination.test.js` **[NEW]**, `Backend/tests/gates/obstacleLayering.test.js` **[NEW]**.
**Risk:** none.

---

### Phase 11 — Benchmarking

§27. Before/after across the five tiers using the existing `Backend/benchmark/` orchestrator.

**Files:** `Backend/benchmark/obstacleScenario.js` **[NEW]**, `Backend/benchmark/orchestrator.js` (scenario registration).
**Dependencies:** Phase 0's baseline. **Risk:** none.

---

### Phase 12 — Controlled rollout

§28/§29: flag off → dashboard-only → zone tier → watch tier → verification, with a documented rollback at each step and a runbook.

**Files:** `Backend/.env` (documented default `false`), `Backend/docs/runbooks/obstacleAwareness.md` **[NEW]**.

---

### Phase dependency graph

```
P0 pin ──┬─► P2 model ──► P3 store ──┬─► P4 disseminate ──┬─► P5 receiver-side
         │                            │                    ├─► P6 watch rooms
P1 instrument (independent) ──────────┘                    ├─► P7 zone sync
                                                           └─► P8 verification
                                                                    │
                                              P9 observability ◄────┘
                                                    │
                                        P10 tests ──┴─► P11 benchmark ──► P12 rollout
```

P1 is independent of everything and can start immediately, in parallel with P0/P2.
P5, P6, P7 are mutually independent and can be parallelised after P4.

---

## 19. Actual file / module mapping

Every path below was verified to exist (or is marked **NEW MODULE REQUIRED**) in `450d829`. No filename is invented.

### 19.1 New modules — four services, one tool, one constants shim

| Path | Why it must be new |
|---|---|
| `Backend/src/services/obstacleStore.service.js` | **NEW MODULE REQUIRED.** Identity, merge, versioning, lifecycle state and the per-zone index are a different responsibility and a different data shape from `ekb.service.js`'s three fixed-signature functions. Extending `ekb.service` in place would change the signature of a function three modules and a test suite import. |
| `Backend/src/services/obstacleDissemination.service.js` | **NEW MODULE REQUIRED.** It replaces `alertDissemination.service.js`, whose central act (`:71-85` fleet scan → `:108` `rerouteRobot`) is exactly what §6.3 removes. Editing it in place would leave the file's name, docstring and every comment describing a pipeline that no longer exists — the "stale documentation at the join" pattern this programme has recorded repeatedly. |
| `Backend/src/services/obstacleWatch.service.js` | **NEW MODULE REQUIRED.** `zonewatch:*` room membership is a route→zone mapping. Neither `zoneManager` (position→zone) nor `routing.service` (path planning) owns that question, and putting it in `routing.service` would place a dissemination concern inside a module that mutates plans. |
| `Backend/src/services/obstacleVerification.service.js` | **NEW MODULE REQUIRED.** The solicit/observe/submit protocol with quorum arithmetic. Kept out of `obstacleStore` so the store stays a store; `applyEvidence` is the seam between them. |
| `Backend/src/config/obstacle.constants.js` | **NEW MODULE REQUIRED.** Mirrors `liveness.constants.js` exactly — resolves `legacy.obstacle.*` through the Config Service with a throwing `required()`. New file rather than an addition to `dtaro.constants.js` because that file is a documented Phase-7 retirement shim. |
| `Backend/tools/awareness/disseminationPolicy.js` | **NEW MODULE REQUIRED.** Offline instrument, `tools/` class, same as `tools/routing/b1Benchmark.js`. |
| `Backend/src/controllers/obstacles.controller.js` + `Backend/src/routes/obstacles.routes.js` | **NEW MODULE REQUIRED.** Operator surface. New router rather than a `diagnostics` sub-path because `POST /clear` is a **destructive state action** — the same reasoning `routes/index.js:24-26` gives for `privacy.routes.js` being separate. |

**Four new services. Everything else is an edit to an existing file.**

### 19.2 Existing files, per phase

---
**`Backend/src/services/alertDissemination.service.js`** — 117 lines
- **Existing responsibility:** obstacle report → zone lookup → EKB store → dashboard emit → fleet scan → route filter → per-robot `REROUTE_ALERT` → `rerouteRobot`.
- **Required adaptation:** retired to a deprecation shim delegating to `obstacleDissemination`. The fleet scan (`:71-79`), the diagonal obstacle model (`:23-24, 82-83`), the `REROUTE_ALERT` emit (`:101-104`) and the `rerouteRobot` call (`:108`) are all removed.
- **Why:** it is simultaneously B-5 (O(N) scan), B-4 (bad geometry), B-3 (wrong payload) and B-6 (second command authority). All four live in one 117-line file.
- **Expected change:** ~110 lines deleted, ~15-line shim remains.
- **Dependencies:** Phases 3, 4. **Risk:** high — §28 flag-gated. **Phase:** 4.

---
**`Backend/src/services/ekb.service.js`** — 174 lines
- **Existing responsibility:** Redis-primary obstacle storage with TTL, Postgres secondary, in-memory fallback, expiry sweep.
- **Required adaptation:** scope reduced to durable history — keep and harden the Postgres write (§15.4 catch narrowing), keep `sweepExpired` as a helper called by `obstacleStore.sweep`. `storeObstacle`'s id generation (`:43`) and `getActiveObstacles` (`:95-142`) are superseded by `obstacleStore.deriveId` / `activeForZone`; both are **kept exported** until Phase 12 completes so the flag can fall back to them.
- **Why:** the Redis half is replaced (no identity, no state, no zone index, permissive TTL — G-2/G-3/G-4/G-5/G-20); the Postgres half is exactly right and stays.
- **Expected change:** ~30 changed, ~20 added. **Risk:** low. **Phase:** 3.

---
**`Backend/src/services/routeIntersection.service.js`** — 93 lines
- **Existing responsibility:** pure segment-intersection predicate; `findAffectedRobots` recipient selection.
- **Required adaptation:** **add** `pointSegmentDistanceM` and `pathApproachesPoint` (§12.3). Existing three exports unchanged and still unit-tested.
- **Why:** B-4/G-9 — parallel segments are non-intersecting by construction (`:29`), and a single-waypoint path returns `false` (`:51`), missing a stationary robot on an obstacle.
- **Expected change:** +~60 lines, 0 changed. **Risk:** low (purely additive; keeps the `legacy` lane green, which is that lane's charter). **Phase:** 5.

---
**`Backend/src/services/zoneManager.service.js`** — 275 lines
- **Existing responsibility:** zone load + 3-tier cache, `getZoneForCoordinates`, socket room move, zone-change side effects, default zone seeding.
- **Required adaptation:** three edits. (a) Move `updateSocketZoneRoom` out of the `changed` branch in `assignRobotToZone` (`:165-168`) — the B-7 fix. (b) Add a `syncAgentToZone` call to `applyZoneChangeSideEffects` (`:189-213`). (c) Add `neighbourZones(zoneId)` computed at cache load and invalidated by the existing `invalidateZoneCache` (`:71-81`).
- **Why:** (a) closes G-7; (b) is the only correct hook for Feature 1's secondary behaviour; (c) closes the boundary false-negative.
- **Also worth doing here:** the docstring at `:127-140` justifies the registry write by `costEvaluator.service.js` and `taskAssignment.service.js`, both **deleted at Phase 15**. The audit flags this. Correcting the comment is free and prevents the next reader inheriting a false dependency graph.
- **Expected change:** ~15 changed, ~30 added. **Risk:** medium — touches the zone-crossing path that the telemetry handler calls. Mitigation: T-EDGE-07/08 and the existing `zoneLocality.test.js`, whose three assertions must stay green. **Phase:** 4 (c), 7 (a, b).

---
**`Backend/src/sockets/handlers/dtaro.handler.js`** — 527 lines
- **Existing responsibility:** `OBSTACLE_REPORT`, `TASK_COMPLETE` (with §12.5 graded verification), `ROBOT_FAULT` (with §18.2 classification).
- **Required adaptation:** rewire `OBSTACLE_REPORT`'s body (`:85-96`) to `obstacleStore.report` → `obstacleDissemination.publish`; extend the zod schema with optional `distanceM`/`observedAt` (`:33-37`); update the ACK (§16.3); add `OBSTACLE_VERIFY_REQUEST`, `OBSTACLE_VERIFY_RESULT`, `OBSTACLE_ZONE_SYNC_ACK` handlers with `rateLimit.allow` guards.
- **Why:** this is the single ingress point for agent obstacle traffic.
- **Do not touch:** the `TASK_COMPLETE` and `ROBOT_FAULT` handlers, `verifyCompletionClaim`, `readVerificationThresholds`, `readAcceptedTrack`. They are Phase 5/12/14 engine surfaces.
- **Expected change:** ~15 changed, ~90 added. **Risk:** medium. **Phase:** 4, 7, 8.

---
**`Backend/src/sockets/handlers/robot.handler.js`** — 943 lines
- **Existing responsibility:** AUTH (pairing/session/mTLS), dedup handshake, heartbeat, session rekey, disconnect.
- **Required adaptation:** in the AUTH success path only (`:674-683`): pass the agent's held zone digest, call `syncAgentToZone` after `assignRobotToZone`, and rejoin `zonewatch:*` from `obs:watch:{robotId}`. All inside the existing "zone assignment is non-critical — never block auth" `try/catch`.
- **Why:** AUTH is where reconnect lands (S-1/S-2), and where B-7 manifests.
- **Do not touch:** certificate binding, `runDedupHandshake`, `AUTH_SUCCESS` shape (adding a field is safe; changing one is not), pairing lockout, `markRobotOnline`.
- **Expected change:** ~20 added, 0 changed. **Risk:** medium — AUTH is security-critical. Mitigation: additive only, inside the existing guard; `socketAuthGate.test.js` must stay green. **Phase:** 6, 7.

---
**`Backend/src/sockets/handlers/telemetry.handler.js`** — 1043 lines
- **Existing responsibility:** the hot path — backpressure shed, rate limit, §23.5 trust boundaries, status transitions, batched 4-key Redis read, DB flush gate, snapshot throttle, merged registry RMW with zone resolution, batched write flush, dashboard emit, progress supervision.
- **Required adaptation:** **NONE.** Zero lines changed.
- **Why this matters:** Rule 3. The zone is already resolved here (`:786-794`) and the crossing already detected (`:804-806`), and the side-effect call already exists (`:824-834`). The new sync rides on `applyZoneChangeSideEffects`, which this file already calls. **Not adding a key to the pipelined read at `:599-605` and not adding an await inside the handler is the single most important performance constraint in this plan**, given that a per-tick `prisma.robot.findUnique` here is what caused REST latency to go from 77 ms to 21 s between 100 and 500 robots (`:460-467`).
- **Risk:** none — no change.

---
**`Backend/src/sockets/socket.server.js`** — 376 lines
- **Existing responsibility:** offline detector, DTARO sweep bootstrap, dashboard auth + task rehydration, handler registration, legacy `assign_task`.
- **Required adaptation:** `startDtaroSweep`'s 60 s interval (`:163-170`) calls `obstacleStore.sweep` instead of `ekb.sweepExpired`. Keep `.unref()`. Nothing else.
- **Why:** reuse the existing loop rather than adding a second timer.
- **Expected change:** ~5 lines. **Risk:** low. **Phase:** 3.

---
**`Backend/src/services/task.service.js`** — 548 lines
- **Existing responsibility:** the §3.4 request path (`assignTask` → intake, or 503) and the retained operator `rerouteTask`.
- **Required adaptation:** in `rerouteTask` **only**, after the `taskPath:{taskId}` write (`:507-510`), call `obstacleWatch.updateWatch(io, kv, robotId, newPoints)` — ladder L1.
- **Why:** the one place in production that produces a route today.
- **Do not touch:** `assignTask`, `admitToRound`, `engineEnabled`, the 503 refusal, `straightLineRoute`. Reviving anything named in the `:14-18` removal list would fail `gate:legacy`.
- **Expected change:** ~4 lines. **Risk:** low. **Phase:** 6.

---
**`Backend/src/controllers/tasks.controller.js`**
- **Required adaptation:** add `obstacleWatch.clearWatch(io, kv, releasedRobotCode)` inside the existing Redis cleanup block (`:286-297`), next to `updatePlannedPath(kv, …, null)`.
- **Why:** watch rooms must not outlive the route. This is already the "clear all runtime Redis state tied to this task/robot" block.
- **Expected change:** ~2 lines. **Risk:** low. **Phase:** 6.

---
**`Backend/src/simulation/VirtualRobot.js`** — 1685 lines
- **Existing responsibility:** the reference agent — movement, battery, charging curve, task phases, telemetry, obstacle reporting, reroute handling.
- **Required adaptation:** local obstacle map + zone digests (G-18); `OBSTACLE_ALERT` / `OBSTACLE_ZONE_SYNC` / `OBSTACLE_CLEARED` / `OBSTACLE_VERIFY_SOLICIT` handlers registered next to the existing `REROUTE_ALERT` registration (`:359`); `_evaluateObstacleRelevance` using the shared predicate; slow/hold behaviour; verification solicit + result; deterministic seeding for `_maybeReportObstacle` and the §13.4 persistence draw.
- **Why:** D-3 puts fine relevance on the agent, and this is the reference agent.
- **Do not touch:** the charge-curve integration (`constants.js` `CHARGE_POWER_CURVE` is shared with `engine/energy/chargeCurve.js` and a divergence would corrupt §24.4 fidelity), movement kinematics, telemetry emission shape.
- **Leave in place:** `_onRerouteAlert`'s `obstacleLocation` fallback (`:1146-1159`) — dead after §10.5 but part of the agent contract.
- **Expected change:** ~180 added, ~10 changed. **Risk:** low (not production). **Phase:** 5, 7, 8.

---
**`Backend/src/config/logger.js`** — 511 lines
- **Required adaptation:** none to the logger. `rootLogger.obstacle` (`:453`) already accepts `zoneId` and `affectedRobots`; the **call sites** start passing them.
- **Risk:** none. **Phase:** 9.

---
**`Backend/src/services/metrics.service.js`** — 202 lines
- **Required adaptation:** `getSystemMetrics`'s obstacle count (`:84-85`) reads `SMEMBERS ekb:obstacles`; repoint to a per-state count from the new keys.
- **Do not touch:** `recordAllocation` — its own header (`:94-113`) identifies it as the unbounded per-decision write shape §21.2 replaces. New counters go through `engine/observability/sli.js`.
- **Expected change:** ~10 lines. **Risk:** low. **Phase:** 9.

---
**`Backend/src/routes/index.js`, `diagnostics.routes.js`** — 2 + ~10 lines. **Phase:** 8, 9.
**`Backend/prisma/schema.prisma`** — §15. **Phase:** 2.
**`Backend/src/engine/config/register/legacy.json`, `engine/config/validators.js`** — §9.5. **Phase:** 2.
**`Backend/package.json`** — one `awareness:policy` script. **Phase:** 1.

### 19.3 Explicitly NOT modified

| File | Why |
|---|---|
| `src/services/routing.service.js` | `replanRoute`/`rerouteRobot` stay exported and stay reachable from the operator path. This plan removes one *caller*, not the module (§6.3). |
| `src/cache/kv.js` | Hot-path module. Every structure in §14 fits the existing API (§14.1). |
| `src/cache/robotStateCache.js` | Hot-path cache with a documented writer list. |
| `src/services/robotRegistry.service.js` | `plannedPath` is **not** re-seeded (§12.2). No registry field is added — that would grow the value on every telemetry SET. |
| `src/services/commandDispatcher.service.js` | Used as-is (R-7). |
| `src/engine/**` | No engine module is added, edited or imported by any new legacy-tier module. `gate:tiers` must be unaffected. |
| `src/sockets/handlers/telemetry.handler.js` | Rule 3. |
| `src/sockets/handlers/offer.handler.js`, `command.handler.js` | Layer 4. |
| `server.js` | No composition-root change. The new services are constructed by the handlers that use them, like every other legacy service. |

---

## 20. Database migration plan

### 20.1 Order and reversibility

Migrations M1–M5 as specified in §15.6. Prisma migration directory naming follows the tree's convention (`20260518152516_dtaro_zone_obstacle`), so:

```
20260824090000_obstacle_lifecycle_enums        (M1)
20260824090100_obstacle_event_lifecycle        (M2)
20260824090200_obstacle_event_indexes          (M3 — hand-edit to CONCURRENTLY)
20260824090300_obstacle_observation            (M4)
20260824090400_obstacle_mergekey_backfill      (M5)
```

### 20.2 The `CONCURRENTLY` caveat, flagged

Prisma Migrate emits `CREATE INDEX`, which takes an `ACCESS EXCLUSIVE`-adjacent lock blocking writes for the duration. On an `ObstacleEvent` table that is small by construction (rows expire in 300 s) this is negligible **today**, but after §9.4 rows live for `archive_after_ms` (24 h) and the table grows by roughly the fleet's obstacle rate. M3 is therefore split into its own migration so its SQL can be hand-edited to `CREATE INDEX CONCURRENTLY` — which cannot run inside a transaction, so the migration must also drop Prisma's implicit `BEGIN`/`COMMIT`. **This is the single most error-prone step in the migration plan and is called out for the implementer rather than left to be discovered.**

### 20.3 Deploy ordering

```
1. Apply M1–M5 with the feature flag OFF and the old code running.
   → Old ekb.storeObstacle keeps working (§15.6 backward-compat argument).
2. Deploy the new code with the flag still OFF.
   → New modules loaded, not called.
3. Enable the flag per §28's ladder.
```

Schema-forward, code-second, flag-third. Rollback at step 2 or 3 requires no schema change (§29).

### 20.4 Retention and cleanup

| Data | Retention | Enforced by |
|---|---|---|
| Redis `obs:o:*` | `archive_after_ms` (24 h) | Key TTL |
| Redis `obs:zone:*` members | Until `CLEARED` | `srem` at transition |
| `ObstacleEvent` rows | Indefinite by default | — |
| `ObstacleObservation` rows | Indefinite by default | — |

**Postgres retention is deliberately left unbounded and is an open question (§32 OQ-7).** Both tables grow with the fleet's obstacle rate and are the research corpus (§30) — deleting them destroys exactly the longitudinal data Feature 3 exists to produce. A pruning job is specified but not scheduled: `DELETE FROM "ObstacleObservation" WHERE "observedAt" < now() - interval '<retention>'`, driven by a `legacy.obstacle.observation_retention_days` register entry, left at `null` (no pruning) until Operations names a value. A default that silently deletes research data would be worse than an unbounded table an operator can see growing.

**Note the privacy interaction:** `ObstacleObservation.robotId` is a robot identifier, not a personal one, and `Robot` is not in `engine/privacy/identityStore.js`'s surrogate-key scope. `gate:privacy` should be unaffected — **`REQUIRES VERIFICATION`** by running `npm run gate:privacy` after M4, and it is listed as a Phase 2 exit criterion.

### 20.5 Redis key migration

No migration script. At first `activeForZone(z)` after deploy, if `obs:zone:{z}` is empty and `obs:rebuild:{z}` is not set, the store performs a one-time merge:
1. Read legacy `ekb:obstacles` + `ekb:event:*` (bounded by active obstacle count, ≤ tens).
2. Convert each to a v1 record with `state: ACTIVE`, deriving `mergeKey`/`obstacleId` from its coordinates.
3. Write the new keys; set `obs:rebuild:{z}` for 60 s to negative-cache the attempt.
4. **Do not delete the legacy keys** — they expire on their own 300 s TTL.

Idempotent (content-derived ids), bounded, and it means an obstacle reported 10 s before deploy is not lost.

---

## 21. API / event contract plan

### 21.1 Socket events — full contract

| Event | Dir | Producer | Consumer | Required fields | Optional | ACK | Guaranteed | Persistent | Idempotency |
|---|---|---|---|---|---|---|---|---|---|
| `OBSTACLE_REPORT` | A→S | agent | `dtaro.handler` | `lat`, `lon` | `severity`, `distanceM`, `observedAt` | `OBSTACLE_REPORT_ACK` | No | Yes (PG observation) | Server-side merge by derived id |
| `OBSTACLE_REPORT_ACK` | S→A | `dtaro.handler` | agent | `obstacleId`, `version`, `state`, `merged` | — | — | No | No | — |
| `OBSTACLE_ALERT` | S→A | `obstacleDissemination` | agent | `obstacleId`, `version`, `zoneId`, `lat`, `lon`, `radiusM`, `state`, `reason`, `tier`, `emittedAt` | `stale`, `severity`, `severityIsAdvisory`, `verifyRequested`, `firstSeenAt`, `lastSeenAt` | No | **No** — at-most-once | Ephemeral | `version` ≤ held → drop |
| `OBSTACLE_ZONE_SYNC` | S→A | `obstacleDissemination` | agent | `zoneId`, `digest`, `obstacles[]` | `truncated` | **Yes** | **Yes** — dispatcher retry | Ephemeral, re-derivable | Digest compare; `version` per entry |
| `OBSTACLE_ZONE_SYNC_ACK` | A→S | agent | `dtaro.handler` | `zoneId`, `digest` | — | — | No | No | Idempotent |
| `OBSTACLE_CLEARED` | S→A | `obstacleStore` (T8/T9) | agent | `obstacleId`, `version`, `zoneId`, `clearedAt` | `clearedBy` | No | No — reconciled by sync | Ephemeral | `version` guard |
| `OBSTACLE_VERIFY_REQUEST` | A→S | agent | `dtaro.handler` | `obstacleId` | — | implicit (`SOLICIT` or refusal) | No | Yes (PG) | Server dedups via `verifyAssignedTo` |
| `OBSTACLE_VERIFY_SOLICIT` | S→A | `obstacleVerification` | agent | `obstacleId`, `version`, `lat`, `lon`, `radiusM`, `deadlineMs` | — | **Yes** | **Yes** — dispatcher retry | Ephemeral | `version` guard |
| `OBSTACLE_VERIFY_RESULT` | A→S | agent | `dtaro.handler` | `obstacleId`, `version`, `kind`, `lat`, `lon`, `observedAt` | `distanceM` | `OBSTACLE_VERIFY_RESULT_ACK` | No | Yes (PG) | Stale `version` accepted as evidence, not as a transition |

**Versioning strategy.** No `v1`/`v2` event names. The envelope carries `version` per obstacle, and additive optional fields are the compatibility mechanism — the same approach `AUTH_SUCCESS` took when Phase 14 added `session` (`robot.handler.js:650-652`). A future breaking change would take a new event name, not a version field on the event.

### 21.2 REST — new surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/obstacles` | operator JWT | List, filter by `zoneId`/`state`, paginated |
| `GET` | `/api/obstacles/:obstacleId` | operator JWT | One obstacle + its `ObstacleObservation` history |
| `POST` | `/api/obstacles/:obstacleId/clear` | operator JWT + RBAC | T9 operator clear. Audited |
| `POST` | `/api/obstacles/:obstacleId/recheck` | operator JWT + RBAC | T11, force `RECHECK_REQUIRED` |
| `GET` | `/api/diagnostics/obstacles` | operator JWT | Counters (§25) |

Mounted at `routes/index.js` following the existing pattern. Controllers use `utils/asyncHandler.js` and the existing auth middleware. **No existing endpoint's contract changes.**

### 21.3 Dashboard events

`ALERT_CREATED` (`alertDissemination.service.js:54`) is **retained and still emitted** — the Frontend consumes it (`Frontend/src/context/AppProvider.jsx:583`, per the audit) and breaking the dashboard is out of scope. It is emitted alongside the new `OBSTACLE_ALERT` dashboard mirror, with the same fields it carries today plus the new ones. New dashboard events: `OBSTACLE_UPDATED`, `OBSTACLE_CLEARED`, `OBSTACLE_DISPUTED`.

**`REROUTE_ALERT` to the dashboard** (`:103`) is removed with its producer; the operator reroute path's `TASK_UPDATED` with `action: "REROUTED"` (`task.service.js:527-534`) is untouched and is what the Frontend actually renders reroutes from.

### 21.4 Backward compatibility summary

| Consumer | Impact |
|---|---|
| Unmodified `VirtualRobot` | **None.** New events are ignored; `OBSTACLE_REPORT` shape unchanged; `OBSTACLE_REPORT_ACK` is not read by it |
| Real firmware (none exists) | Contract is additive |
| Frontend dashboard | `ALERT_CREATED` retained. `REROUTE_ALERT`-to-dashboard removed — **requires a Frontend check** before Phase 4. `REQUIRES VERIFICATION` |
| REST clients | Purely additive |
| Existing tests | `zoneLocality.test.js` and the `dtaro` suite must stay green |

---

## 22. Failure handling

### 22.1 Robot disconnect / reconnect

| Event | Behaviour |
|---|---|
| Disconnect | Socket leaves all rooms automatically. `markOffline` + `srem robots:all` (`robot.handler.js:925-930`). `obs:watch:{robotId}` **is retained** — the route did not end, only the connection |
| Reconnect | AUTH rejoins `robot:{id}` (`:658`), `zone:{z}` (B-7 fix), and `zonewatch:*` from `obs:watch:{robotId}`. Then S-2 sync brings the agent's obstacle map current |
| Missed alerts during the gap | **Recovered by the sync, not by replay.** No per-agent outbound queue exists and none is added — a queue would need durable per-agent state and a delivery guarantee this feature does not need, because the zone digest already reconciles the whole zone in one message |

### 22.2 Network delay / out-of-order

Handled entirely by `version` (§23.3). A delayed `OBSTACLE_ALERT` arriving after a newer one is dropped by the agent's `version` guard. A delayed `OBSTACLE_VERIFY_RESULT` is accepted as evidence (its `observedAt` is what orders it) but does not apply a transition against a superseded version.

### 22.3 Redis unavailable

| Path | Degraded behaviour |
|---|---|
| `obstacleStore.report` | In-memory maps; per-worker divergence; PG write still attempted |
| Version | Per-process `INCR` — collisions possible; the recovery sweep bumps versions once (§14.8) |
| Zone digest | Recomputed per process |
| Socket.IO adapter | **Independent connection.** The adapter uses its own `Redis` clients (`server.js:331-332`), so `kv` degradation does not by itself break broadcast, and vice versa. Stated because conflating them is the natural assumption |
| `obs:watch:{robotId}` | Lost; watch rooms rebuilt on next route change |

**No path throws.** Every Redis call is inside the facade's own guard, and every caller treats failure as degraded rather than fatal — the same policy `telemetry.handler.js:856-858` applies to its write flush.

### 22.4 Postgres unavailable

- `ObstacleEvent` upsert and `ObstacleObservation` append fail → counted (§15.4), logged rate-limited, **alert still delivered**. Redis is the delivery source; PG is history.
- The gap is real: observations during the outage are lost and the §15.5 recount cannot repair counts for that window. Accepted and counted, not silently absorbed.
- **Zone rebuild after a Redis loss requires PG.** If both are down, `activeForZone` returns empty and the fleet is told nothing — the honest degradation, and the one the audit's §7 objection ("clock-based expiry resolves permissively") does *not* cover, because an empty answer here is "I have no data", not "the path is clear". `obstacle.zone.rebuild_failed` makes it visible.

**Rebuild:**
```
rebuildZone(kv, prisma, zoneId):
    if GET obs:rebuild:{zoneId} → skip (negative cache, 60 s)
    rows = prisma.obstacleEvent.findMany({
             where: { zoneId, state: { in: [ACTIVE, STALE, RECHECK_REQUIRED, DISPUTED] } } })
           ← uses the new @@index([zoneId, state])
    write obs:o:* + obs:zone:{zoneId}; invalidate digest
    SET obs:rebuild:{zoneId} "1" EX 60
```
One indexed query per zone, lazily, at most once per minute per zone. At Z = 4 that is at most 4 queries/minute in the worst case.

### 22.5 Socket.IO worker unavailable

Load balancer reroutes; agents reconnect; §22.1 applies. Obstacles are in shared state, so nothing is lost. If the **adapter** is down in a multi-worker deployment, §17.4 applies — dissemination becomes per-worker and `obstacle.sync.undelivered` detects it.

### 22.6 Duplicate and delayed telemetry

Telemetry is unchanged by this plan. A duplicate tick recomputes the same zone, `changed` is false, no sync fires. A delayed tick with a stale position could produce a spurious zone change; the existing `undefined`-vs-`null` guard (`telemetry.handler.js:794`) and the §23.5 registry merge already bound this, and a spurious sync costs one message and is idempotent.

### 22.7 Failure matrix

| Failure | Detection | Automatic response | Operator visibility | Data loss |
|---|---|---|---|---|
| Redis down | `kv.health()` | In-memory fallback + reconnect | `/api/health` | Obstacle state on restart (rebuilt from PG) |
| Redis flush | Empty zone set | Lazy rebuild (§22.4) | `obstacle.zone.rebuilt` | None |
| PG down | Write exception | Counted, alert still delivered | `obstacle.store.pg_write_failed` | Observations for the window |
| Adapter down | `dispatched: false` on syncs | None automatic | `obstacle.sync.undelivered` + startup warning | Cross-worker alerts |
| Worker crash | LB health check | Agents reconnect + sync | `robot_offline` | None |
| Agent crash | Socket disconnect | Rooms freed | `robot_offline` | Agent's local map (rebuilt by sync) |
| Sweep lock holder dies | Lock TTL 90 s | Another worker takes it | `obstacle.sweep.skipped` | ≤ 90 s of transition latency |
| Zone deleted | FK `SetNull` (existing) | Obstacles become `zoneId: null` → `zone:__unzoned` | — | None |

---

## 23. Idempotency and consistency

### 23.1 The consistency model, stated

**Obstacle state is eventually consistent across workers and agents, with a monotonic per-obstacle version as the sole ordering authority, and Postgres as the reconciling truth for evidence counts.**

Not linearizable, and it does not need to be: an obstacle alert is advisory, the conservative direction is always "still believed obstructed", and the only irreversible transition (`CLEARED`) is guarded by a quorum that a lost update can only make *harder* to reach (§14.5).

### 23.2 Agent-side idempotency — one rule

```
if (this.obstacles.get(id)?.version >= env.version) return;   // drop
```

This single comparison handles: duplicate delivery from dual room membership, redelivery after reconnect, out-of-order arrival, cross-worker double-publish (§17.3), and sync-versus-alert overlap. **No server-side per-agent state is required for any of them.**

### 23.3 Ordering

| Quantity | Order source | Why |
|---|---|---|
| Obstacle updates | `version` (`kv.incr`) | Atomic and monotonic in Redis; the only total order that exists |
| Evidence | `observedAt` (agent clock) | When the agent *measured*, mirroring §2.7's observed-at/received-at split. Arrival order is not evidence order |
| Zone sync | `digest` | Content-addressed; no ordering needed — it is a snapshot, not a delta |

**Agent clock skew is a known limitation.** `observedAt` is agent-supplied and unvalidated beyond the existing §23.5 trust boundaries, which check *position* plausibility but not *time*. A skewed agent could order its evidence wrongly relative to another agent's. Bound: it can only affect which of two contradictory observations is treated as later, and §9.6 rule 3 sends contradictions inside `dispute_window_ms` to `DISPUTED` regardless of order. Listed in §31 as R-9.

### 23.4 Server-side idempotency

| Operation | Idempotent? | How |
|---|---|---|
| `report` same obstacle twice | Yes | Derived id → merge; `reporters` is a set-like array |
| `report` same robot twice | Yes | `presentCount` counts distinct `robotId` |
| `applyEvidence` replay | Yes | `ObstacleObservation` is append-only; counts recomputed from it (§15.5) |
| Sweep transitions | Yes | Monotonic (`ACTIVE→STALE` twice is `STALE`) |
| `syncAgentToZone` | Yes | Digest compare; a repeat is suppressed |
| Room join/leave | Yes | Socket.IO semantics |
| Operator clear | Yes | Already-`CLEARED` returns the current state, not an error |

### 23.5 The read-modify-write hazard, bounded

Stated fully in §14.5. Summary: `obs:o:{id}` RMW is not atomic; at most one `reporters`/`clearers` entry can be lost per collision; the loss is always in the conservative direction; the durable observation log repairs it on the next sweep; and the divergence rate is *measured* (`obstacle.evidence.recount_corrected`) rather than assumed small.

### 23.6 Consistency between Redis and Postgres

| Divergence | Detection | Repair |
|---|---|---|
| Redis has an obstacle PG does not | PG write failure counter | Next report re-upserts |
| PG has one Redis does not | Empty zone set | Lazy rebuild (§22.4) |
| Counts disagree | Sweep recount | PG wins (§15.5) |
| State disagrees | Sweep | **Redis wins** — it is the operational state; PG mirrors it |

The split is deliberate and directional: **PG is authoritative for evidence, Redis for state.** Evidence is append-only and cannot be wrong; state is derived and can be recomputed.

### 23.7 What is deliberately not guaranteed

- **Not** exactly-once alert delivery. At-most-once + reconciliation.
- **Not** a global order across obstacles. Only per-obstacle.
- **Not** that every agent has an identical view at any instant. Convergence within one sync trigger.
- **Not** that an obstacle cleared on worker A is instantly invisible on worker B. Bounded by the version propagation, which is one adapter publish.

Each of these would require machinery (durable per-agent queues, a total order, consensus) disproportionate to an advisory notification, and each is called out so a later reader does not assume a guarantee that was never made — which is the specific documentation failure the audit found in `ARCHITECTURE.md` §3.9.

---

## 24. Performance and scalability analysis

### 24.1 Method

Per-operation costs derived from the measured constants in the tree: `TELEMETRY_INTERVAL_MS = 2000` (0.5 Hz per robot), `OBSTACLE_PROBABILITY = 0.002` per tick while `ACTIVE` (`simulation/constants.js`), delivery-bot speed 5.56–8.33 m/s, seeded zones ~1.1 km square (`zoneManager.service.js:229-253`), registry TTL 30 s, `DB_FLUSH_INTERVAL_MS = 15 000`.

**Assumption stated:** ~50 % of the fleet `ACTIVE` at a time. Obstacle rate `= N × 0.5 × 0.5 ticks/s × 0.002 = N × 0.0005 /s`.

### 24.2 The hard constraint — telemetry is untouched

| Per-tick cost | Today | After |
|---|---|---|
| Redis reads | 1 pipelined (4 keys) | 1 pipelined (4 keys) |
| Redis writes | 1 pipelined | 1 pipelined |
| PG queries | 0, except the flush gate | unchanged |
| Zone lookup | in-process cached | unchanged |
| New work | — | **none** |

At 5 000 robots that is 2 500 telemetry events/s and **2 500 × 0 = 0** added operations. This is the single most important number in this section, because the tree records that a per-tick `findUnique` here drove REST p99 from 77 ms to 21 s between 100 and 500 robots (`telemetry.handler.js:460-467`).

### 24.3 Obstacle report cost

| | Today | After | Ratio |
|---|---|---|---|
| Redis round trips | `1 + N` | **4** | `(N+1)/4` |
| PG queries | 1 | 1 | — |
| Route-intersection checks | `N × M` | 0 delivery + ≤ 25 shadow | — |
| Adapter publishes | `1 + 2×|affected|` | **2** | — |
| Recipients reached | **0** (B-2) | zone ∪ watch | ∞ |

| Fleet N | Reports/s | Redis ops/s today | Redis ops/s after | Reduction |
|---|---|---|---|---|
| 100 | 0.05 | 5 | 0.2 | 25× |
| 500 | 0.25 | 125 | 1.0 | 125× |
| 1 000 | 0.50 | 501 | 2.0 | 250× |
| 2 000 | 1.00 | 2 002 | 4.0 | 500× |
| 5 000 | 2.50 | 12 503 | 10.0 | **1 250×** |

Shadow relevance CPU is capped at `shadow_sample_size` (25) paths × ~100 segments = 2 500 distance computations per report, ~0.1 ms — and it is skipped entirely when no path is known, which is the current state of the world.

### 24.4 Zone-crossing cost — the new dominant term

Crossing rate ≈ `N / 165 s` (mid-speed across a 1.1 km zone).

| N | Crossings/s | PG writes/s (`Robot.zoneId`) | Dashboard emits/s | Sync Redis ops/s (worst) |
|---|---|---|---|---|
| 100 | 0.6 | 0.6 | 0.6 | 1.8 |
| 500 | 3.0 | 3.0 | 3.0 | 9 |
| 1 000 | 6.1 | 6.1 | 6.1 | 18 |
| 2 000 | 12.1 | 12.1 | 12.1 | 36 |
| 5 000 | 30.3 | 30.3 | 30.3 | 91 |

**All three columns are pre-existing costs except the last** — the PG write (`zoneManager.js:191-194`) and the `ZONE_UPDATED` emit (`:200-212`) already happen on every crossing today. The sync adds ≤ 3 Redis round trips, and only 1 in the common digest-match case.

**Two pre-existing costs worth addressing while here** (both are the brief's "do not destroy existing scalability" concern, and both are made *more* visible by this feature, not created by it):

1. **The `Robot.zoneId` PG write.** 30 writes/s at 5 000 robots against a pool the tree has already had contention problems with. Its two named consumers — `costEvaluator.service.js` and `taskAssignment.service.js` (`zoneManager.js:127-140`) — were **both deleted at Phase 15**. The write's stated justification no longer exists. **Recommendation: gate it behind a `legacy.obstacle.persist_zone_to_db` register entry defaulting to `true`** (behaviour-preserving) so it can be turned off with evidence rather than removed on an argument. Listed as OQ-3.
2. **The `ZONE_UPDATED` dashboard emit.** 30 emits/s to every dashboard client. Already a fan-out concern; not worsened. A coalescing window is listed in §31 as R-6's mitigation, not proposed here.

### 24.5 Memory

| Structure | Per unit | At 5 000 robots |
|---|---|---|
| Redis obstacle records | ~500 B | 100 active → 50 KB |
| `obs:zone:*` sets | ~40 B/member | negligible |
| `obs:watch:{robotId}` | ~100 B | 500 KB |
| Socket.IO room maps (`zone:`+`zonewatch:`) | ~100 B/membership | ~1 MB per worker |
| Agent obstacle map | ~500 B × obstacles in its zones | ~5 KB per agent |

Server-side additions are ~1.5 MB at 5 000 robots. **No new per-robot server-side `Map` is introduced** — deliberately, because the tree already carries five of them (`lastDbFlushAt`, `lastTelemetryLogAt`, `implausibleReportCounts`, `lastAcceptedFixAt`, `lastRouteProgressAt`, `lastKnownPosition`) and each is a bounded leak.

### 24.6 Event loop

The heaviest synchronous block is `zonesOnRoute` (§12.6): `segments × Z`. At 100 segments and Z = 4 that is 400 slab tests, ~50 µs, **once per route change**, not per tick. Everything else on the new paths is I/O-bound and awaited.

The one thing that could block: `activeForZone` parsing 50 obstacle JSONs on a sync. ~50 × `JSON.parse` of 500 B ≈ 0.3 ms. At 30 syncs/s that is 1 % of one core. Bounded by `zone_sync_max_obstacles`.

### 24.7 Connection pool

New PG queries: 1 upsert + 1 insert per obstacle report (2.5/s at 5 000 robots), 1 `groupBy` per sweep (1/min), 1 `findMany` per zone rebuild (rare). **Compare with the existing telemetry flush gate at ~333 writes/s at 5 000 robots** — the new load is under 1 % of it. Pool pressure is not a realistic concern from this feature, and the benchmark in §27 measures it rather than asserting it.

### 24.8 Per-component summary

| Operation | Frequency @5 000 | DB | Redis | CPU | Network | Risk | Mitigation |
|---|---|---|---|---|---|---|---|
| Telemetry tick | 2 500/s | unchanged | unchanged | unchanged | unchanged | **None** | Rule 3, pinned by benchmark |
| Obstacle report | 2.5/s | 2 writes | 4 RT | ~0.2 ms | 1 publish | Low | O(1) in N |
| Zone crossing | 30/s | 1 write* | 1–3 RT | ~0.3 ms | 1–2 msgs | Medium | Digest suppression; *OQ-3 |
| Route change | ~0/s today | 0 | 2 RT | ~50 µs | join/leave | Low | Off the tick path |
| Verification | < 0.1/s | 2 writes | 3 RT | negligible | 2 msgs | Low | Rate limited |
| Sweep | 1/min | 1–2 queries | O(obstacles) | ~5 ms | 0 | Low | Leader-locked, bounded batch |
| Zone rebuild | rare | 1 indexed query | O(obstacles) | ~2 ms | 0 | Low | 60 s negative cache |

### 24.9 The unacceptable pattern, explicitly avoided

The brief names it:

```
1 telemetry event → DB query → query all robots → query all tasks → query all routes → broadcast to everyone
```

- **"1 telemetry event → DB query"** — already avoided by `robotStateCache` (`telemetry.handler.js:468-480`); unchanged.
- **"query all robots"** — this is B-5, `getAllRobotIds` + N × `getRobotState`, and Phase 4 **deletes it**.
- **"query all tasks / all routes"** — never introduced. Route→zone mapping is computed once at route change and cached in room membership.
- **"broadcast to everyone"** — replaced by room addressing.

**The feature removes an instance of the forbidden pattern rather than adding one.**

---

## 25. Observability plan

Counters go through `engine/observability/sli.js`'s advisory registry, **not** `metrics.service.recordAllocation` — whose own header (`:94-113`) identifies the one-Redis-key-per-event shape as the unbounded write volume §21.2 exists to replace.

### 25.1 Metrics — only those that would change a decision

| Metric | Type | Labels | Answers |
|---|---|---|---|
| `obstacle.reported` | counter | `zoneId`, `merged` | Detection rate; merge effectiveness (G-2) |
| `obstacle.active` | gauge | `zoneId`, `state` | Current belief. The number `metrics.service.js:84` gets wrong today |
| `obstacle.transition` | counter | `from`, `to` | Lifecycle health. `ACTIVE→STALE` ≫ `→CLEARED` means verification is not happening |
| `obstacle.alert.published` | counter | `reason` | Dissemination volume |
| `obstacle.alert.rooms` | histogram | — | Rooms per publish — the boundary-case cost |
| **`obstacle.relevance.missed`** | counter | `policy` | **The false-negative column.** Shadow-sampled: a robot whose path crosses the obstacle and which received no alert. Audit A-4. Without this, §1.5's reconciliation is an assertion |
| `obstacle.relevance.shadow_notified` | counter | `policy` | Denominator for the above |
| `obstacle.sync.sent` / `.suppressed` | counter | `trigger` | Digest effectiveness (G-16). A low suppression ratio means the digest is not working |
| `obstacle.sync.undelivered` | counter | — | **Degraded-adapter detector** (§17.4). Non-zero in a multi-worker deployment = adapter broken |
| `obstacle.sync.latency_ms` | histogram | `trigger` | Zone-entry sync latency |
| `obstacle.verify.solicited` / `.completed` / `.expired` | counter | — | Verification loop health |
| `obstacle.verify.result` | counter | `kind` | PRESENT vs CLEAR ratio — the physical-persistence signal |
| `obstacle.verify.stale_version` | counter | — | §10.7 races |
| `obstacle.dispute.opened` / `.resolved` | counter | — | Fleet disagreement rate (G-15) |
| `obstacle.evidence.recount_corrected` | counter | — | **Measures the §14.5 lost-update bound** instead of asserting it is small |
| `obstacle.store.pg_write_failed` | counter | `code` | G-19 — the currently-invisible failure |
| `obstacle.zone.rebuilt` / `.rebuild_failed` | counter | `zoneId` | Redis-loss recovery |
| `obstacle.zone.saturated` | counter | `zoneId` | Sync truncation (§11.4) |
| `obstacle.watch.rooms` | gauge | — | Watch membership; **0 at ladder L0 is expected, not a fault** |
| `obstacle.version.degraded` | counter | — | Redis-down version collisions |

**Deliberately excluded:** "rerouting triggered" and "rerouting failures" from the brief's suggested list. This feature does not trigger rerouting (Rule 2), and a metric for something the system does not do is the "correct in form, dead in effect" pattern in metric form. Route changes remain measured on the operator path where they actually happen.

### 25.2 Logging

Reuse `logger.obstacle` (`logger.js:453`) — its `zoneId` and `affectedRobots` parameters already exist and are currently unused. Call sites start passing real values.

| Level | Event |
|---|---|
| `info` | Obstacle created; state transition; verification solicited/completed |
| `warn` | Dispute opened; sync undelivered; zone saturated; watch computed at L0 (once per robot) |
| `error` | PG write failed (rate-limited per code); zone rebuild failed |
| `debug` | Every alert published (sampled per zone, mirroring `TELEMETRY_LOG_SAMPLE_MS`'s pattern) |

**No per-alert `info` log.** At 2.5 reports/s × N recipients that is the log volume the 2026-07-26 CPU profile already found meaningful (`telemetry.handler.js:860-866`).

### 25.3 Diagnostics endpoint

`GET /api/diagnostics/obstacles` on the existing router: per-zone active counts by state, digest age, watch-room sizes, the last 20 transitions, and the shadow-relevance ratio. One surface an on-call engineer reads during an incident rather than assembling from a metrics pipeline — the argument `routes/index.js:17-19` makes for `health.routes.js`.

### 25.4 Dashboard

New events (§21.3) let the operator UI show obstacle state, age and verification status. Out of scope for this plan beyond emitting them.

---

## 26. Test strategy

Lanes: `legacy` (unit + integration), `scale` (tiers), `gates` (source assertions). `npm run test:legacy` must stay green throughout — that is the lane's charter (`jest.config.js:11-14`).

Helpers already available (R-18): `tests/helpers/testKv.js`, `fakeSocket.js` (`createFakeSocket`, `createFakeIo`), `mockPrisma.js`, `waitFor.js`, `tests/mocks/silentLogger.js`.

### 26.1 Functional

| # | Test | Asserts |
|---|---|---|
| T-FUNC-01 | Report creates an obstacle | Derived id; `state ACTIVE`; `version 1`; zone set contains it |
| T-FUNC-02 | Same location reported twice | **One** obstacle, `version 2`, `presentCount 2` — G-2 |
| T-FUNC-03 | Report emits to `zone:{z}` | **Inverts Phase 0's B-1 test.** A `zone:*` emit exists |
| T-FUNC-04 | Robot in Z **and** watching Z | Receives the alert **exactly once** — §16.2's union guarantee, pinned |
| T-FUNC-05 | Robot in another zone, not watching | Receives nothing |
| T-FUNC-06 | Robot enters Z with an active obstacle | `OBSTACLE_ZONE_SYNC` with that obstacle |
| T-FUNC-07 | Robot re-enters Z, digest unchanged | **Nothing sent**; `sync.suppressed` incremented |
| T-FUNC-08 | Route crosses Z, robot in Y | Joined `zonewatch:{z}`; receives the alert before entering |
| T-FUNC-09 | Agent path within radius | Receiver-side relevance fires |
| T-FUNC-10 | Agent path outside radius | Remembered, no behaviour change — §12.5's three levels |
| T-FUNC-11 | **First CLEAR does not clear** | `state RECHECK_REQUIRED`, `clearCount 1`, ACK says `quorum 2` — the asymmetry (§9.6) |
| T-FUNC-12 | Second distinct CLEAR | `CLEARED`; `OBSTACLE_CLEARED` published |
| T-FUNC-13 | Same robot CLEARs twice | `clearCount` stays 1 — distinct-reporter counting |
| T-FUNC-14 | Verify PRESENT | `ACTIVE`, window reset, `presentCount++` |
| T-FUNC-15 | TTL elapses | `STALE`, **not deleted, not `CLEARED`** — G-4, the permissive-direction guard |
| T-FUNC-16 | Operator clear | `CLEARED`, `clearedBy` set, audited |
| T-FUNC-17 | Duplicate alert, lower version | Agent drops it — §23.2 |

### 26.2 Edge cases

| # | Test | Asserts |
|---|---|---|
| T-EDGE-01 | Two robots, same obstacle, 15 m apart | Merged via the 3×3 probe (§14.4) |
| T-EDGE-02 | Two robots, 60 m apart | **Two** obstacles — merge does not over-merge |
| T-EDGE-03 | Report straddling a grid line | Merged by the neighbour probe |
| T-EDGE-04 | Obstacle 5 m inside a zone boundary | Delivered to the neighbouring zone too (§10.4) |
| T-EDGE-05 | Robot outside all zones | Joins `zone:__unzoned`; receives `zoneId: null` obstacles (§8.4) |
| T-EDGE-06 | Robot crosses 3 zones in 10 s | 3 syncs, no leaked room membership |
| T-EDGE-07 | **Reconnect inside registry TTL** | New socket **is** in `zone:{z}` — **inverts Phase 0's B-7 test** |
| T-EDGE-08 | Reconnect, digest unchanged | Room rejoined, **no** redundant sync |
| T-EDGE-09 | Path parallel to the old diagonal, through the point | **Detected** — inverts Phase 0's B-4 test (G-9) |
| T-EDGE-10 | Single-waypoint path on an obstacle | Detected — the `length < 2` gap |
| T-EDGE-11 | 60 obstacles in one zone | Sync truncated at 50, `truncated: true`, `zone.saturated` counted |
| T-EDGE-12 | Obstacle cleared then re-reported | **New** `obstacleId` with `incarnation 2` (§9.7) |
| T-EDGE-13 | Stale-version verify result | Recorded as evidence, no transition, `verify.stale_version` counted |
| T-EDGE-14 | Contradictory reports inside the window | `DISPUTED`; obstacle still blocks |
| T-EDGE-15 | Contradiction outside the window | Not disputed; normal clear accumulation |
| T-EDGE-16 | Report 300 m from the reporter | Rejected, `rejectReason: TOO_FAR`, **stored** not dropped (§7.4) |

### 26.3 Concurrency and scale (`scale` lane)

| # | Test | Tier | Asserts |
|---|---|---|---|
| T-CONC-01 | Two workers report the same obstacle simultaneously | — | One id; versions distinct; no permanent divergence (§17.3) |
| T-CONC-02 | Lost-update repair | — | `reporters` entry dropped → sweep recount restores from PG (§15.5) |
| T-CONC-03 | Two robots CLEAR simultaneously | — | `CLEARED` once; **one** `OBSTACLE_CLEARED` published |
| T-CONC-04 | Two workers run the sweep | — | Lock held by one; the other skips; state identical either way |
| T-SCALE-01 | 100 robots, 60 s | 100 | Redis ops/report ≤ 5; **0** added telemetry ops |
| T-SCALE-02 | 500 robots | 500 | Same; p99 sync latency < 200 ms |
| T-SCALE-03 | 1 000 robots | 1 000 | Same; PG pool wait unchanged from baseline |
| T-SCALE-04 | 2 000 robots | 2 000 | Same; heap growth < 5 MB over baseline |
| T-SCALE-05 | 5 000 robots | 5 000 | Redis ops/report **constant**; telemetry p99 within 5 % of baseline |
| T-SCALE-06 | Zone-crossing storm (all robots cross at once) | 1 000 | Sync queue drains; no event-loop block > 50 ms |

**T-SCALE-05's constancy assertion is the one that matters** — it is the direct test that B-5's O(N) is gone, and it is the assertion a future regression would break.

### 26.4 Failure injection (`chaos`-style, run in `legacy` lane with fakes)

| # | Test | Asserts |
|---|---|---|
| T-FAIL-01 | Redis unavailable during a report | Falls back to memory; alert still published; no throw |
| T-FAIL-02 | Redis flushed | Zone rebuilt from PG (§22.4); alerts resume |
| T-FAIL-03 | PG unavailable | Alert delivered; `pg_write_failed` counted; no throw |
| T-FAIL-04 | Both unavailable | `activeForZone` returns empty; `rebuild_failed` counted; **no spurious "clear"** |
| T-FAIL-05 | Adapter absent, 2 workers | Cross-worker alert not delivered; `sync.undelivered` non-zero (§17.4) |
| T-FAIL-06 | Agent disconnects mid-sync | No server error; sync retried by the dispatcher |
| T-FAIL-07 | Delayed telemetry with a stale position | No spurious zone change beyond the existing guard |
| T-FAIL-08 | Sweep lock holder dies | Another worker takes it within 90 s |

### 26.5 Layering gates (`gates` lane) — the composition-join guards

This programme's recorded failure mode is a real producer, a real consumer, and nothing joining them, with a comment at the join asserting it exists. These are source-level assertions in the style of `tools/gates/checkLegacyRetirement.js`:

| # | Gate |
|---|---|
| T-GATE-01 | `obstacleDissemination.service.js` **does not import** `routing.service.js` — B-6 stays severed |
| T-GATE-02 | No module under `src/services/obstacle*.js` writes `taskPath:`, `robotTaskState:` or calls `updatePlannedPath` — Rule 2 |
| T-GATE-03 | No new legacy-tier module imports from `src/engine/**` except `engine/config/service` — keeps `gate:tiers` clean |
| T-GATE-04 | At least one production module emits to a `zone:*` room — **G-1 cannot silently regress** |
| T-GATE-05 | `telemetry.handler.js`'s pipelined read at `:599-605` still fetches exactly 4 keys — Rule 3, mechanically enforced |
| T-GATE-06 | Every `legacy.obstacle.*` register entry is read by exactly one production consumer — no dead parameters |

T-GATE-04 and T-GATE-05 are the two that matter most: the first pins the fix, the second pins the constraint.

---

## 27. Benchmark strategy

Uses the existing `Backend/benchmark/` orchestrator (`orchestrator.js`, `robotWorker.js`, `systemMetrics.js`, `poolSweep.js`) and `.env.benchmark`.

### 27.1 Design

**Before:** current tree at `450d829`, flag conceptually off.
**After:** feature branch, flag fully on.
Five tiers: 100, 500, 1 000, 2 000, 5 000. Ten minutes per run, three runs per configuration, median reported with the spread. Obstacle rate forced to a fixed schedule rather than `OBSTACLE_PROBABILITY`'s randomness so the two arms see identical event streams.

### 27.2 Measured

| Metric | Source | Why |
|---|---|---|
| Telemetry ingest p50/p99 | `systemMetrics.js` | **The regression guard.** Must be within 5 % |
| REST p99 | existing harness | The metric that went 77 ms → 21 s historically |
| Redis ops/s total and per report | `kv` instrumentation | Proves the O(1) claim |
| PG queries/s, pool wait | `poolSweep.js` | Pool pressure (§24.7) |
| Socket messages/s out | orchestrator | Dissemination volume |
| Event-loop lag p99 | `systemMetrics.js` | §24.6 |
| RSS | `pidusage` | §24.5 |
| **Recipients per obstacle** | new counter | 0 before, non-zero after — the capability delta |
| **Agents missed** | shadow sample | The correctness delta |

### 27.3 Acceptance

| Criterion | Threshold |
|---|---|
| Telemetry p99 regression | ≤ 5 % at every tier |
| REST p99 regression | ≤ 5 % at every tier |
| Redis ops per obstacle report | **constant across tiers** (≤ 6) |
| PG queries/s increase | ≤ 2 % of baseline |
| Event-loop lag p99 | ≤ baseline + 5 ms |
| RSS increase at 5 000 | ≤ 10 MB |
| Recipients per report | > 0 (before: 0) |
| Agents missed vs route-only ground truth | **0** — the union cannot miss what route-only finds |

**The last row is the one that discharges §1.5.** If it is ever non-zero, the union reasoning is wrong and OQ-1 must be reopened.

### 27.4 The policy comparison

Separately, `npm run awareness:policy` (Phase 1) reports all five policies offline across the tiers. This is the artefact that answers the audit's §12.7 — the arm nobody has run (route-only) measured against the arm this plan ships (zone∪watch∪receiver) with a false-negative column for both.

---

## 28. Rollout strategy

### 28.1 The flag

`OBSTACLE_AWARENESS_MODE` — an ordinal, not a boolean, because the tiers activate in sequence:

```
off      (default)  legacy alertDissemination path, unchanged
shadow               new store writes; NO agent delivery; metrics only
zone                 + zone-room delivery (Feature 1 primary)
sync                 + zone-entry synchronisation (Feature 1 secondary)
watch                + zonewatch rooms (Feature 2a)
full                 + verification and clearance (Features 2b, 3)
```

Read through a small module mirroring `engine/cutover/enabled.js`'s shape — a single owner for the question, never a raw `process.env` comparison at a call site, which is the defect `PHASE_15_REMEDIATION` D-6 records.

**Not on the engine kill-switch ladder.** `tierTwoAtShipState` refuses a cutover with any Tier 2 mechanism live, including under rehearsal purpose. Adding this feature there would block the cutover it is unrelated to. This is a legacy-tier host-platform flag and stays one.

### 28.2 The ladder

| Step | Mode | Duration | Exit criteria | Rollback |
|---|---|---|---|---|
| 1 | `off` + migrations applied | 1 day | Migrations applied; `gate:params`, `gate:tiers`, `gate:privacy` PASS; `test:legacy` green | Revert code; schema stays |
| 2 | `shadow` | 3 days | `obstacle.reported` > 0; merge ratio sane; **0** `pg_write_failed`; telemetry p99 unchanged | → `off` |
| 3 | `zone` | 3 days | Recipients > 0; `relevance.missed` = 0; no agent-side errors | → `shadow` |
| 4 | `sync` | 3 days | `sync.suppressed / sync.sent` > 0.5 (digest working); `sync.undelivered` = 0 | → `zone` |
| 5 | `watch` | 3 days | `watch.rooms` behaves; at L0 it is 0 and that is **expected** | → `sync` |
| 6 | `full` | 7 days | Verification loop closes; `dispute.opened` low; `→CLEARED` transitions occur | → `watch` |

Each step is one env change and a restart. **No schema change, no data migration, no re-deploy between steps.**

### 28.3 Simulator and benchmark compatibility

- The simulator's new handlers are additive; an old `VirtualRobot` against a new server works at every mode.
- A new `VirtualRobot` against an old server receives no `OBSTACLE_*` events and behaves as today.
- The benchmark harness is unaffected at `off`, and §27 runs it at `full`.

### 28.4 What must not happen during rollout

- Do not enable `full` before `zone` has run clean — verification depends on agents having a correct obstacle map.
- Do not tune `merge_grid_degrees` or zone count `Z` before Phase 1's instrument has produced numbers. That is the evidence-free choice the audit refuses.
- Do not enable this on a shard mid-cutover. It is orthogonal to `cutover.engine_enabled`, but changing two things at once makes an incident unattributable.

---

## 29. Rollback strategy

### 29.1 Per-layer

| Layer | Rollback | Time | Data loss |
|---|---|---|---|
| Mode ladder | Decrement `OBSTACLE_AWARENESS_MODE`, restart | seconds | None — state stays in Redis/PG |
| Full feature | `OBSTACLE_AWARENESS_MODE=off` | seconds | None; legacy path resumes |
| Code | Revert the commits; keep the schema | one deploy | None (§15.6: old writer works against new schema) |
| Schema | `DROP TABLE ObstacleObservation`, `ALTER TABLE ObstacleEvent DROP COLUMN` ×12, `DROP TYPE` ×2 | minutes | **The obstacle history corpus.** Only with an explicit decision |

**The schema and code roll back independently.** That is the property M2's all-defaulted columns buy, and it is why §20.3's ordering is schema-first.

### 29.2 What `off` restores

`dtaro.handler`'s `OBSTACLE_REPORT` calls `alertDissemination.processObstacleReport` unchanged — including the fleet scan and the `rerouteRobot` call. **That path is inert (B-2) and returns `affectedRobotIds: []`, so restoring it restores today's behaviour exactly, including its inertness.** The Phase-4 shim (§18 item 4.6) is what makes this true; without it, `off` would restore a broken caller rather than the old behaviour.

**Deliberate consequence:** rolling back re-arms B-6 in principle. It stays harmless for the same reason it is harmless today — the input is empty. Noted so the decision is conscious. Once `zone` mode has run clean for a full ladder cycle, §33's step 12 removes the legacy path and the shim, at which point `off` means "no obstacle dissemination" rather than "the old one".

### 29.3 Partial-failure rollback

| Symptom | Immediate action | Then |
|---|---|---|
| Telemetry p99 regression | → `off` | Compare against §27 baseline; the cause is not on the tick path, so look at zone-crossing volume (§24.4) |
| Redis pressure | → `shadow` | Check `alert.rooms` histogram for a boundary-case explosion |
| Agents behaving oddly | → `shadow` (server keeps recording, stops delivering) | Inspect agent obstacle maps |
| False clears | → `sync` (disables verification) | Inspect `verify.result` and `dispute.opened` |
| PG pool pressure | → `off` | `pg_write_failed` and `poolSweep` |

`shadow` is the important rung: it keeps the durable record and all metrics while stopping every agent-facing effect. Most incidents can be diagnosed there rather than at `off`.

---

## 30. Research-paper evaluation metrics

### 30.1 The governing constraint, restated

RobotX has executed zero assignment rounds, written zero commitments and produced zero decision records from a real decision. **Nothing in this feature may be claimed as an experimentally demonstrated capability of the assignment engine.** What it can support is a claim about *dissemination*, which is a host-platform property and is measurable today with the simulator.

### 30.2 What is genuinely novel

| Claim | Novel? | Honest framing |
|---|---|---|
| Zone-scoped Socket.IO dissemination | **No** | Grid-based interest management, decades old (Liu & Theodoropoulos; spatial publish-subscribe). Paper 1 claims no novelty here either. Engineering adaptation |
| Route-intersection relevance | **No** | Paper 1's own M2; the predicate is textbook |
| **Union-of-tiers relevance with a measured false-negative column** | **Yes, modestly** | Paper 1 composes zone *then* route (an intersection), which introduces false negatives its own Eq. 4 does not model. Composing them as a *union* with occupancy-, trajectory- and receiver-side tiers, and **measuring the miss rate against ground truth**, is a real contribution — because the miss rate is the number neither Paper 1 nor RobotX has ever produced |
| **Evidence-based obstacle lifecycle** | **Yes** | Paper 1 and current RobotX both expire obstacles on a wall clock. Expiring to a *reduced-confidence* state and requiring positive quorum evidence to clear — with an explicit present/clear quorum asymmetry — is a defensible design contribution about resolving unknowns conservatively |
| **Content-addressed obstacle identity with cross-worker merge** | **Yes, modestly** | Neither system has obstacle identity. Deriving the id from snapped coordinates so that N coordinators merge without coordination is a small but real distributed-systems result |
| Receiver-side relevance placement | **No** — but the *reason* is | Paper 1 places it receiver-side. The contribution is the argument for why: it is the only placement that does not create a second physical-command authority. That is an architecture finding, not an algorithm |

### 30.3 Measurable experiments

| # | Experiment | Independent variable | Dependent | Baseline |
|---|---|---|---|---|
| E1 | Dissemination policy comparison | policy ∈ {broadcast, zone-only, zone+route, route-only, union} | notified, **missed**, coordinator ops, bytes, latency | broadcast |
| E2 | Fleet scaling | N ∈ {100, 500, 1 000, 2 000, 5 000} | coordinator ops per report | current tree (O(N)) |
| E3 | Zone granularity | Z ∈ {4, 16, 64} | notified, missed, crossings/s, PG writes/s | Z = 4 |
| E4 | Lifecycle accuracy | expiry policy ∈ {clock-TTL, evidence-based} | false-clear rate, stale-belief duration | clock-TTL (current) |
| E5 | Merge effectiveness | `merge_grid_degrees` | obstacles per physical obstacle | no merge (current: 1 per report) |
| E6 | Verification loop | quorum ∈ {1, 2, 3} | time-to-clear, false-clear rate | no verification (current) |

**E1, E2 and E5 are runnable today** with Phase 1's offline instrument plus the simulator. E4 and E6 need the simulator's persistence model (§13.4) and are therefore *simulation* results and must be labelled as such. E3 needs zone reconfiguration.

### 30.4 What must not be claimed

| Do not claim | Because |
|---|---|
| Any allocation, makespan or utilisation result | Zero rounds executed. This feature does not allocate |
| That zone scoping reduces traffic *in RobotX* relative to a working baseline | The current baseline delivers to **zero** recipients. The honest comparison is against `broadcast`, measured offline, not against the current tree |
| Real-world obstacle persistence rates | `sim.obstacle.persistence_probability` is a configured fiction (§13.4) |
| Any result at a fleet size not actually run | State N explicitly |
| That the union policy has zero false negatives | It has zero *relative to route-only over known routes*. With routes unknown (ladder L0) the ground truth itself is unavailable — and saying so is the result |
| Simulator fidelity for any of it | `sim:fidelity` reports 7 models NOT_MEASURED, 6 safety-relevant |

### 30.5 Suggested framing

> A dissemination-relevance layer for multi-robot obstacle awareness that composes occupancy, trajectory and receiver-side relevance as a **union rather than a cascade**, with a measured false-negative column that the interest-management and cooperative-awareness literature does not report; and an evidence-based obstacle lifecycle in which expiry reduces confidence rather than asserting clearance, with an explicit asymmetry between the evidence needed to believe and to disbelieve.

Two contributions, both measurable, neither requiring the assignment engine to run.

---

## 31. Risks and mitigations

| # | Risk | Likelihood | Impact | Mitigation | Residual |
|---|---|---|---|---|---|
| R-1 | **Fixing B-2 arms B-6** — the second command authority becomes reachable | Low (explicitly designed against) | **Critical** — unsupervised plan mutation | The edge is *deleted*, not gated (§6.3). T-GATE-01/02 assert it at source. Rule 2 stated in three places | Rollback to `off` re-arms it in principle; harmless because the input stays empty (§29.2) |
| R-2 | Zone scoping introduces false negatives the audit predicts | Medium | High | Union not filter (D-1); `relevance.missed` measured (§25.1); §27.3's zero-miss acceptance criterion; OQ-1 names the reversal | If the metric is ever non-zero, reopen OQ-1 |
| R-3 | Zone-crossing volume overwhelms PG at 5 000 robots | Medium | Medium | Pre-existing cost, not created here. OQ-3 proposes gating the mirror write whose consumers were deleted | Measured by T-SCALE-05 |
| R-4 | Merge grid wrong for the real campus | **High** — it is UNCALIBRATED | Medium | 3×3 neighbour probe (§14.4); E5 measures it; register entry is tunable without a deploy | OQ-4 |
| R-5 | Lost update drops evidence | Medium | Low | Conservative direction only (§14.5); PG recount repairs (§15.5); rate measured | Bounded and visible |
| R-6 | Sync storms when many robots cross together | Medium | Medium | Digest suppression (§11.3); payload cap (§11.4); T-SCALE-06 | Coalescing window available if measured |
| R-7 | Adapter silently degrades in multi-worker | Medium | High | `sync.undelivered` is a **new detector the codebase lacks** (§17.4) | Pre-existing risk, now visible |
| R-8 | F2a ships inert at ladder L0 | **Certain today** | Low | Stated openly (§18 Phase 6, §33). Empty watcher set is correct under Rule 1, not broken. `watch.rooms = 0` is documented as expected | Accepted |
| R-9 | Agent clock skew misorders evidence | Low | Low | `DISPUTED` on contradiction regardless of order (§9.6 rule 3) | §23.3 |
| R-10 | Verification abstraction mistaken for a real sensor result | Medium | Medium (research) | `sim.` namespace with declared consumers; §30.4 forbids the claim | Documentation-enforced |
| R-11 | Telemetry regression from an unforeseen path | Low | **Critical** | Rule 3; zero lines changed in `telemetry.handler.js`; T-GATE-05 pins the 4-key read; §27.3's 5 % ceiling | Benchmarked at every tier |
| R-12 | Frontend breaks on the removed `REROUTE_ALERT` dashboard emit | Medium | Low | `ALERT_CREATED` retained; requires a Frontend check before Phase 4 | `REQUIRES VERIFICATION` (§21.4) |
| R-13 | Obstacle tables grow unbounded | Medium | Low | Pruning specified, deliberately not scheduled (§20.4) | OQ-7 |
| R-14 | Scope creep into engine-tier obstacles | Low | High | Audit §12.6 says DEFER; T-GATE-03 asserts no engine import | Governance |

---

## 32. Open questions

| # | Question | Owner | Blocks | Default if unanswered |
|---|---|---|---|---|
| **OQ-1** | The audit rules **DO NOT IMPLEMENT** on zone-scoped delivery; the locked feature requires it. §1.5 reconciles them by making the zone tier additive. **Does the programme accept that reconciliation, or does the audit's literal reading win?** | Architecture owner | Phase 4 | Proceed with the union design; §27.3's zero-miss criterion is the falsifier. If rejected, Phase 4 ships receiver-side relevance only and Feature 1 is not delivered |
| OQ-2 | Should `zonewatch` rooms exist before a route source exists (ladder L0)? | Programme | Phase 6 | Build now, inert-but-correct. Alternative: defer Phase 6 entirely until L2 |
| OQ-3 | The `Robot.zoneId` PG mirror write's two named consumers were deleted at Phase 15. Keep, gate, or remove? | Architecture + Ops | Phase 4 | Gate behind `legacy.obstacle.persist_zone_to_db`, default `true` (behaviour-preserving) |
| OQ-4 | `merge_grid_degrees` — 20 m is a guess | Operations | Calibration only | 0.00018°, UNCALIBRATED, tuned by E5 |
| OQ-5 | Should a solicited verification count double toward quorum (§9.6 rule 5)? | Safety | Phase 8 | Weight 2. Safer alternative: weight 1, requiring two verifications |
| OQ-6 | `_maybeReportObstacle` uses bare `Math.random()` — pre-existing, makes obstacle scenarios unreproducible. Fix as part of this work? | Engineering | Test reproducibility | Fix in Phase 5; it is 3 lines and it makes every scenario test deterministic |
| OQ-7 | `ObstacleObservation` retention | Operations | Nothing | Unbounded (no pruning) until a value is named. Deleting research data by default is worse |
| OQ-8 | Zone count `Z` for the real campus | Operations | Tuning only | Keep the seeded 4; retune with E3 |
| OQ-9 | Does the Frontend read `REROUTE_ALERT` on the dashboard channel? | Frontend | Phase 4 | `REQUIRES VERIFICATION` — check `Frontend/src/` before removing the emit |
| OQ-10 | Should obstacles influence the engine's feasibility gate after cutover? | Architecture | Nothing now | **No.** Audit §12.6 DEFER; expiry must be evidence-based *and* snapshot-pinned before that is even discussable |

---

## 33. Final recommended implementation order

### 33.1 The order

| # | Step | Phase | Depends on | Ships what | Blocked by anything external? |
|---|---|---|---|---|---|
| 1 | Pin the seven findings as failing tests | P0 | — | Regression protection | No |
| 2 | Build the offline dissemination instrument | P1 | — | The false-negative column | No |
| 3 | Answer **OQ-1** and **OQ-9** | — | step 2's numbers | The go/no-go for Feature 1 | Architecture + Frontend |
| 4 | Register entries, enums, schema, migrations (authored) | P2 | — | The model | No |
| 5 | Obstacle store: identity, merge, lifecycle | P3 | 4 | Features 3's spine | No |
| 6 | Dissemination + **sever the `rerouteRobot` edge** | P4 | 5, 3 | **Feature 1 primary** | No |
| 7 | Geometry fix + receiver-side relevance | P5 | 6 | **Feature 2b** | No |
| 8 | Zone-entry sync + the B-7 reconnect fix | P7 | 6 | **Feature 1 secondary** | No |
| 9 | Verification and clearance | P8 | 5, 7, 8 | **Features 2, 3** | No |
| 10 | Watch rooms (ladder L0/L1) | P6 | 6 | **Feature 2a**, inert at L0 | No |
| 11 | Observability | P9 | 6–10 | The metrics | No |
| 12 | Tests, benchmarks, rollout | P10–P12 | all | Production readiness | No |
| 13 | Remove the legacy path and the shim | — | 12 clean for one full ladder cycle | Retirement of `alertDissemination` | No |
| 14 | Ladder L2 — Leg-corridor watch source | — | B1 + cutover | Feature 2a live | **Yes** — B1, then the round loop |

**Steps 1–13 have no external dependency.** They do not wait on B1 (routing engine), B8 (calibration), T1-04 (anti-starvation ladder), B3 (consensus store) or the cutover, and they touch no engine module. Only step 14 does.

### 33.2 Parallelisation

- Steps 1 and 2 in parallel, immediately.
- Step 4 in parallel with 1–2.
- After step 6: steps 7, 8, 10 are mutually independent.
- Step 11 trails whichever of 7–10 land.

### 33.3 If only one thing is done

**Steps 1, 2 and 6.** That is: pin the defects, build the instrument, then deliver zone-targeted dissemination with the command-authority edge severed. It closes G-1, G-12 and G-13, takes the recipient count from zero to correct, reduces per-report Redis cost by three orders of magnitude at 5 000 robots, and removes an instance of the exact pattern the brief forbids — without touching the telemetry hot path, the engine, or the assignment architecture.

### 33.4 What this plan deliberately leaves for later

- Engine-tier obstacle records and any round-snapshot input (audit §12.6 — DEFER).
- Any outbox-drained `REROUTE` command (audit §12.5 — DEFER until the round loop runs).
- A producer for `externalEscalation`'s `affectedMissionIds` (audit A-5) — the pure relevance predicate this plan builds (§12.3) is the input it will need, but wiring it is engine-tier work that waits on the coordinator composing.
- Zone-granularity tuning, merge-grid calibration, and retention policy — all evidence-gated.

### 33.5 Closing statement of scope

This plan adds four legacy-tier services, extends one Prisma model, adds one, introduces two Socket.IO room families and four server→agent events, and changes **zero lines** in the telemetry hot path, the engine tree, the commitment core, the outbox, the dispatch path, or the assignment engine. It removes one O(N) fleet scan, one direction-sensitive geometry, one payload-contract mismatch, one permissive expiry policy, one reconnect defect, and one unsupervised path-mutation authority.

It implements exactly the three approved capabilities and nothing else from Paper 1.

**No production source, configuration, schema or migration was modified in producing this document.**

---

# Appendix A — Sequence diagrams

Conceptual. Participant names are the real modules from §19.

## A.1 — Scenario 1: robot detects an obstacle

```mermaid
sequenceDiagram
    autonumber
    participant RA as Robot A (VirtualRobot)
    participant DH as dtaro.handler
    participant ZM as zoneManager
    participant OS as obstacleStore
    participant KV as Redis (kv)
    participant PG as Postgres
    participant OD as obstacleDissemination
    participant IO as Socket.IO + adapter
    participant FL as zone:Z1 / zonewatch:Z1
    participant DB as dashboard

    RA->>DH: OBSTACLE_REPORT {lat, lon, severity}
    DH->>DH: rateLimit.allow(10/60s, min 500ms)
    DH->>DH: zod parse; socket.data.robotId required
    DH->>ZM: getZoneForCoordinates(lat, lon)
    ZM-->>DH: Zone Z1 (in-process cache, 0 I/O)
    DH->>OS: report({lat, lon, zoneId:Z1, robotId:RA})
    OS->>OS: deriveId = sha1(Z1:snapLat:snapLon)
    OS->>KV: mget(9 neighbour keys)  %% 3x3 merge probe
    KV-->>OS: no active neighbour
    OS->>KV: incr obs:v:{id}
    KV-->>OS: version = 1
    OS->>KV: pipeline: set obs:o:{id}, set digest ""
    OS->>KV: sadd obs:zone:Z1 {id}
    OS-)PG: upsert ObstacleEvent + insert ObstacleObservation
    Note over OS,PG: best-effort, off the response path;<br/>failure counted, never blocks the alert
    OS-->>DH: {obstacle, merged:false, created:true}
    DH->>OD: publish(io, obstacle, {reason:"REPORTED"})
    OD->>ZM: neighbourZones(Z1)
    OD->>IO: io.to(["zone:Z1","zonewatch:Z1", ...neighbours]).emit(OBSTACLE_ALERT)
    IO->>FL: OBSTACLE_ALERT (one adapter publish, union of rooms)
    OD->>DB: ALERT_CREATED + OBSTACLE_ALERT mirror
    DH-->>RA: OBSTACLE_REPORT_ACK {obstacleId, version, state, merged}
```

**Total coordinator cost: 4 Redis round trips, 2 PG writes, 2 adapter publishes — constant in fleet size.** Compare with `1 + N` Redis round trips today (B-5).

## A.2 — Scenario 2: robot enters a zone with an existing active obstacle

```mermaid
sequenceDiagram
    autonumber
    participant RB as Robot B
    participant TH as telemetry.handler
    participant ZM as zoneManager
    participant OD as obstacleDissemination
    participant OS as obstacleStore
    participant KV as Redis (kv)
    participant CD as commandDispatcher

    RB->>TH: TELEMETRY {lat, lon, ...}  %% 0.5 Hz, unchanged
    TH->>ZM: getZoneForCoordinates  %% in-process cache
    ZM-->>TH: Zone Z1
    TH->>TH: merged registry RMW: zoneId Z2 -> Z1
    Note over TH: zoneChangeInfo set ONLY on a real crossing.<br/>No added key, no added round trip (Rule 3).
    TH->>ZM: applyZoneChangeSideEffects(old:Z2, new:Z1)
    ZM->>ZM: socket.leave(zone:Z2); socket.join(zone:Z1)
    ZM-)ZM: Postgres Robot.zoneId mirror (see OQ-3)
    ZM->>OD: syncAgentToZone(robotId:RB, zoneId:Z1, heldDigest)
    OD->>OS: digestForZone(Z1)
    OS->>KV: get obs:zone:digest:Z1
    KV-->>OS: "9f2c...", differs from held
    OD->>OS: activeForZone(Z1)
    OS->>KV: smembers obs:zone:Z1
    OS->>KV: mget(obs:o:*)
    KV-->>OS: [obstacle records]
    OD->>CD: dispatch(io, RB, OBSTACLE_ZONE_SYNC, {zoneId, digest, obstacles})
    CD->>CD: io.in("robot:RB").fetchSockets()  %% adapter-aware presence check
    CD-->>RB: OBSTACLE_ZONE_SYNC
    RB->>RB: apply by version; prune Z1 entries absent from sync
    RB-->>OD: OBSTACLE_ZONE_SYNC_ACK {zoneId, digest}
    RB->>RB: _evaluateObstacleRelevance against activePath (receiver-side)
```

**If the digest matched, the sequence stops at step 8** — nothing is sent, `obstacle.sync.suppressed` is incremented. That is the brief's "avoid duplicate/redundant notifications when the robot already knows the current alert state."

## A.3 — Scenario 3: route intersects an obstacle before the robot enters the zone

```mermaid
sequenceDiagram
    autonumber
    participant OP as Operator
    participant TS as task.service.rerouteTask
    participant OW as obstacleWatch
    participant KV as Redis (kv)
    participant IO as Socket.IO
    participant RB as Robot B (in Z2)
    participant OD as obstacleDissemination

    Note over OP,TS: Ladder L1 — the one route producer that exists today
    OP->>TS: reroute task T-99
    TS->>KV: set taskPath:T-99 {toPickup/toDrop}
    TS->>OW: updateWatch(io, kv, RB, newPoints)
    OW->>OW: zonesOnRoute(path) -> {Z2, Z1}   %% segment x zone slab test, once
    OW->>IO: socket.join("zonewatch:Z1")
    OW->>KV: sadd obs:watch:RB Z1 Z2
    Note over RB: Robot B is physically in Z2, watching Z1

    OD->>IO: OBSTACLE_ALERT for an obstacle in Z1
    IO-->>RB: delivered via zonewatch:Z1  %% EARLY WARNING
    RB->>RB: version guard; store in local obstacle map
    RB->>RB: pathApproachesPoint(activePath.slice(pathIndex), obstacle, radiusM)
    alt remaining path passes within radiusM
        RB->>RB: slow / hold at standoff / solicit verification
        Note over RB: NEVER mutates activePath from an alert (Rule 2)
    else path does not approach
        RB->>RB: remember only — no behaviour change
    end
```

**§12.5's three levels are visible here:** joining `zonewatch:Z1` is *awareness*; being in `zone:Z1` would be *proximity*; only `pathApproachesPoint` returning true is *relevance*, and only relevance changes behaviour.

**At ladder L0 (today) `zonesOnRoute` returns the empty set** and Robot B is reached only when it physically enters Z1 — degraded, but correct, because the union still contains the zone tier.

## A.4 — Scenario 4: robot verifies the obstacle is still present

```mermaid
sequenceDiagram
    autonumber
    participant RB as Robot B
    participant DH as dtaro.handler
    participant OV as obstacleVerification
    participant OS as obstacleStore
    participant KV as Redis
    participant PG as Postgres
    participant OD as obstacleDissemination
    participant FL as zone:Z1 rooms

    RB->>RB: remaining path blocked by OBS-x, no alternative
    RB->>DH: OBSTACLE_VERIFY_REQUEST {obstacleId}
    DH->>OV: requestVerification(RB, OBS-x)
    OV->>OV: guard: RB within verify_solicit_radius_m
    OV->>OS: transition T6 -> RECHECK_REQUIRED, version++
    OS->>KV: set obs:o:OBS-x; invalidate digest
    OV-->>RB: OBSTACLE_VERIFY_SOLICIT {version, lat, lon, radiusM, deadlineMs}
    OV->>OD: publish(STATE_CHANGE)
    OD->>FL: OBSTACLE_ALERT {state: RECHECK_REQUIRED, verifyRequested: true}

    RB->>RB: approach to within verify_proximity_m
    Note over RB: SIMULATION ABSTRACTION (§13.4):<br/>outcome drawn from sim.obstacle.persistence_probability,<br/>seeded from (obstacleId, robotId, incarnation).<br/>Real firmware substitutes a real observation here.
    RB->>DH: OBSTACLE_VERIFY_RESULT {obstacleId, version, kind: PRESENT, distanceM: 18}
    DH->>OV: submitResult(...)
    OV->>OV: guard: distanceM <= verify_proximity_m; version fresh
    OV->>OS: applyEvidence(PRESENT)
    OS->>PG: insert ObstacleObservation {kind: PRESENT, solicited: true}
    OS->>OS: T7: presentCount++, state -> ACTIVE, expiresAt reset, version++
    OS->>KV: set obs:o:OBS-x
    OV-->>RB: OBSTACLE_VERIFY_RESULT_ACK {accepted: true, state: ACTIVE}
    OD->>FL: OBSTACLE_ALERT {reason: UPDATED, state: ACTIVE}
```

## A.5 — Scenario 5: robot verifies the obstacle has cleared

```mermaid
sequenceDiagram
    autonumber
    participant RB as Robot B
    participant RC as Robot C
    participant OV as obstacleVerification
    participant OS as obstacleStore
    participant PG as Postgres
    participant OD as obstacleDissemination
    participant FL as zone:Z1 rooms

    RB->>OV: OBSTACLE_VERIFY_RESULT {kind: CLEAR, distanceM: 12}
    OV->>OS: applyEvidence(CLEAR, robotId: RB)
    OS->>PG: insert ObstacleObservation {kind: CLEAR}
    OS->>OS: clearCount = 1; clear_quorum = 2 -> NOT cleared
    OV-->>RB: ACK {accepted: true, state: RECHECK_REQUIRED, clearCount: 1, quorum: 2}
    Note over RB,OV: THE ASYMMETRY (§9.6): one robot may create<br/>an obstacle; one robot may NOT destroy one.<br/>The obstacle still blocks.

    RC->>OV: OBSTACLE_VERIFY_RESULT {kind: CLEAR, distanceM: 9}
    OV->>OS: applyEvidence(CLEAR, robotId: RC)
    OS->>PG: insert ObstacleObservation
    OS->>OS: clearCount = 2 (distinct robots) -> T8 CLEARED, version++
    OS->>OS: srem obs:zone:Z1 OBS-x; invalidate digest
    OS-)PG: update ObstacleEvent {state: CLEARED, clearedAt, clearedBy: RC}
    OV-->>RC: ACK {accepted: true, state: CLEARED}
    OD->>FL: OBSTACLE_CLEARED {obstacleId, version, clearedAt}
    Note over FL: Agents drop OBS-x from their local maps.<br/>Future robots no longer avoid the location.
    Note over OS: Row retained for retention window,<br/>then T12 -> ARCHIVED (Redis key gone, PG row kept)
```

## A.6 — Scenario 6: two robots report conflicting states

```mermaid
sequenceDiagram
    autonumber
    participant RA as Robot A
    participant RB as Robot B
    participant OS as obstacleStore
    participant PG as Postgres
    participant OD as obstacleDissemination
    participant FL as zone:Z1 rooms

    RA->>OS: PRESENT (observedAt = T)
    OS->>PG: ObstacleObservation {PRESENT}
    OS->>OS: presentCount = 1, state ACTIVE

    RB->>OS: CLEAR (observedAt = T + 30s)
    OS->>PG: ObstacleObservation {CLEAR}
    OS->>OS: clearCount = 1
    OS->>OS: contradiction within dispute_window_ms (120s)?
    alt inside the window
        OS->>OS: T10 -> DISPUTED, version++
        OS->>OD: publish(STATE_CHANGE)
        OD->>FL: OBSTACLE_ALERT {state: DISPUTED}
        Note over FL: DISPUTED is treated as OBSTRUCTED.<br/>Conservative direction. Nothing auto-resolves it.
        Note over OS: Requires a third observation or an operator (T11).<br/>An automatic tie-break would be inventing evidence.
    else outside the window
        OS->>OS: a real state change, not a dispute;<br/>clearCount accumulates toward quorum normally
    end
```

**Ordering is by `observedAt`, not by arrival** (§23.3), so a delayed packet cannot flip the verdict. **Last-writer-wins is explicitly rejected** — under LWW one faulty sensor silently clears a real obstacle for the whole fleet.

## A.7 — Scenario 7: robot disconnects and reconnects

```mermaid
sequenceDiagram
    autonumber
    participant RB as Robot B
    participant RH as robot.handler
    participant KV as Redis
    participant ZM as zoneManager
    participant OW as obstacleWatch
    participant OD as obstacleDissemination

    RB--xRH: socket disconnect
    RH->>RH: markRobotOffline; markOffline(kv); srem robots:all
    Note over RH,KV: Socket leaves ALL rooms automatically.<br/>obs:watch:RB is RETAINED — the route did not end.
    Note over RB: Alerts published during the gap are MISSED.<br/>No outbound queue exists and none is added.

    RB->>RH: reconnect + AUTH {token, zoneDigests}
    RH->>RH: certificate/session checks (unchanged)
    RH->>RH: socket.join("robot:RB")
    RH->>KV: sadd robots:all RB
    RH->>ZM: assignRobotToZone(..., socket, currentZoneId: Z1)
    ZM->>ZM: newZoneId Z1 === currentZoneId -> changed = FALSE
    rect rgb(220, 245, 225)
        ZM->>ZM: socket.join("zone:Z1")
        Note over ZM: THE B-7 FIX — room membership moved OUT of the<br/>`changed` branch. Before this, a reconnect inside the<br/>30s registry TTL left the new socket in NO zone room.
    end
    RH->>OW: rejoin from obs:watch:RB
    OW->>RB: socket.join("zonewatch:Z1"), ("zonewatch:Z2")
    RH->>OD: syncAgentToZone(RB, Z1, heldDigest)
    alt digest differs (obstacles changed during the gap)
        OD-->>RB: OBSTACLE_ZONE_SYNC {full active set}
        Note over RB: Missed alerts recovered by RECONCILIATION,<br/>not by replay. One message restores the whole zone.
    else digest matches
        Note over OD: Nothing sent. obstacle.sync.suppressed++
    end
```

## A.8 — Scenario 8: multi-worker deployment

```mermaid
sequenceDiagram
    autonumber
    participant RA as Robot A (on W1)
    participant W1 as Worker 1
    participant RD as Redis (kv + adapter)
    participant W2 as Worker 2
    participant RB as Robot B (on W2)
    participant DB as Dashboard (on W2)

    RA->>W1: OBSTACLE_REPORT
    W1->>RD: mget probe; incr version; set record; sadd zone set
    Note over W1,RD: Shared state — both workers read the same obstacle
    W1->>RD: io.to(["zone:Z1","zonewatch:Z1"]).emit(OBSTACLE_ALERT)
    Note over RD: @socket.io/redis-adapter publishes to ALL workers
    RD->>W2: adapter delivers the room broadcast
    W2->>RB: OBSTACLE_ALERT  %% B is in zone:Z1 on a different worker
    W2->>DB: dashboard mirror

    Note over W1,W2: CONCURRENT REPORT HAZARD (§17.3)
    par simultaneous reports of ONE physical obstacle
        RA->>W1: OBSTACLE_REPORT at P
    and
        RB->>W2: OBSTACLE_REPORT at P
    end
    W1->>RD: deriveId -> OBS-x (content-addressed)
    W2->>RD: deriveId -> OBS-x (SAME id — no coordination needed)
    W1->>RD: incr -> version 5
    W2->>RD: incr -> version 6
    Note over RD: Both write obs:o:OBS-x; later write wins.<br/>At most one `reporters` entry lost (§14.5) —<br/>always in the CONSERVATIVE direction.
    RD->>RB: OBSTACLE_ALERT v5, then v6
    Note over RB: Agent applies v6, drops v5.<br/>ONE rule handles duplicate, out-of-order and<br/>cross-worker double-publish (§23.2).

    Note over W1,W2: SWEEP — leader-elected, not duplicated
    W1->>RD: reserveRobot("obs:sweep:lock", 90s)  %% SET NX EX
    RD-->>W1: true
    W2->>RD: reserveRobot("obs:sweep:lock", 90s)
    RD-->>W2: false  — skips this pass
    W1->>RD: T3/T5/T12 transitions + evidence recount from PG
    Note over W1: Every transition is idempotent and monotonic,<br/>so even a double-run costs work, never correctness.
```

**If the adapter fails to attach** (`server.js:341-347`), the room broadcast at step 4 never reaches W2, and Robot B is not notified. This is the pre-existing multi-worker failure this codebase already accepts and logs loudly. The new `obstacle.sync.undelivered` counter (§17.4) makes it *detectable at runtime* for the first time, because `OBSTACLE_ZONE_SYNC` goes through `commandDispatcher`, whose `fetchSockets()` presence check returns `dispatched: false` for a robot owned by an unreachable worker.

---

# Appendix B — Traceability

### B.1 Findings → fixes

| Finding | Fixed in | Test |
|---|---|---|
| B-1 no zone emitter | Phase 4 (§16.2) | T-FUNC-03, T-GATE-04 |
| B-2 `plannedPath` never seeded | **Not fixed — designed around** (§12.2 ladder, D-3 receiver-side) | T-FUNC-09, T-FUNC-10 |
| B-3 `REROUTE_ALERT` two shapes | Phase 4 (§10.5) | T-FUNC-03 |
| B-4 direction-sensitive geometry | Phase 5 (§12.3) | T-EDGE-09, T-EDGE-10 |
| B-5 O(N) fleet scan | Phase 4 (§14.3, §24.3) | T-SCALE-05 |
| B-6 second command authority | Phase 4 (§6.3) | T-GATE-01, T-GATE-02 |
| B-7 zone rooms not rejoined | Phase 7 (§11.2) | T-EDGE-07, T-EDGE-08 |

### B.2 Gaps → sections

| Gap | Section | Phase |
|---|---|---|
| G-1 no emitter | §16.2 | 4 |
| G-2 no identity | §7.2, §14.4 | 3 |
| G-3 no lifecycle | §9 | 3 |
| G-4 permissive expiry | §9.4 | 3 |
| G-5 no zone index | §14.2 | 3 |
| G-6 no zone sync | §11 | 7 |
| G-7 reconnect gap | §11.2 | 7 |
| G-8 dead route input | §12.2 | 6 |
| G-9 bad geometry | §12.3 | 5 |
| G-10 payload contract | §10.5 | 4 |
| G-11 bypasses dispatcher | §10.6 | 4, 7 |
| G-12 layering violation | §6.3 | 4 |
| G-13 O(N) scan | §24.3 | 4 |
| G-14 no verification | §13 | 8 |
| G-15 no conflict resolution | §9.6 | 8 |
| G-16 no dedup/ordering | §10.7, §23 | 3, 5 |
| G-17 no false-negative accounting | §25.1 | 9 |
| G-18 no agent obstacle memory | §11.5 | 5 |
| G-19 swallowed PG failures | §15.4 | 3 |
| G-20 dormant `getActiveObstacles` | §14.3 | 3 |

### B.3 Audit recommendations → disposition

| Audit item | Verdict there | Disposition here |
|---|---|---|
| A-1 measurement instrument | IMPLEMENT | **Phase 1**, second step overall |
| A-2 correct `ARCHITECTURE.md` §3.9 | ADD | Out of scope for this plan (documentation), but §1.1 records the false claim; recommended alongside Phase 4 |
| A-3 fix/retire `REROUTE_ALERT` contract | ADD | **Phase 4** (§10.5) |
| A-4 false-negative accounting | ADD | **Phase 9** (`obstacle.relevance.missed`) |
| A-5 relevance-set producer for §18.2 A8 | ADD (engine) | **Deferred** (§33.4) — the pure predicate is built (§12.3); wiring it is engine-tier work behind the coordinator |
| §12.1 zone-scoped communication | **DO NOT IMPLEMENT** | **Reconciled, not overridden** — §1.5, OQ-1. Union not filter; zero-miss is an acceptance criterion |
| §12.2 zone rooms membership | KEEP AS-IS | Kept, plus the B-7 reconnect fix and a corrected docstring |
| §12.3 trajectory relevance | ADAPT | **Phase 5**, receiver-side + bounded server shadow with no delivery authority |
| §12.5 dissemination delivery half | DEFER | Legacy tier delivered; the outbox-drained `REROUTE` command is **not** built (§33.4) |
| §12.6 EKB enhancements | DEFER (engine) / KEEP (legacy) | Exactly that: legacy tier extended, engine tier untouched (T-GATE-03) |
| §16 items 1–8 (DO NOT ADD) | — | 1 reconciled (§1.5); 2, 3, 4, 5, 6, 7 honoured in full; 8 fixed (§10.6) |

### B.4 Brief's decision-making standard, answered per new module

| | `obstacleStore` | `obstacleDissemination` | `obstacleWatch` | `obstacleVerification` |
|---|---|---|---|---|
| 1. Already exists? | Partly — `ekb.service` | Partly — `alertDissemination` | No | No |
| 2. Reusable? | PG half yes, Redis half no | No — its core act is what §6.3 removes | — | — |
| 3. Smallest addition? | Identity + state + zone index | Room addressing + envelope | Route→zone mapping | Solicit/observe/submit |
| 4. Which module owns it? | New service, legacy tier | New service, legacy tier | New service, legacy tier | New service, legacy tier |
| 5. Why there? | Layer 2; no engine dependency | Layer 2 only; the severed edge must be structural | Neither `zoneManager` (position→zone) nor `routing` (planning) owns route→zone | Keeps the store a store |
| 6. Runtime cost? | 4 Redis RT/report | 1 adapter publish | ~50 µs per route change | 3 RT per verification |
| 7. At 5 000 robots? | 10 Redis ops/s | 5 publishes/s | ~0/s today (L0) | < 0.1/s |
| 8. On failure? | Memory fallback; PG rebuild | Best-effort emit; sync reconciles | Rooms rebuilt on reconnect | Deadline expiry |
| 9. Rollback? | Mode ladder → `off` | Mode ladder + shim | Mode ladder | Mode ladder |
| 10. Tested how? | T-FUNC-01/02, T-EDGE-01/02/03, T-CONC-01/02 | T-FUNC-03/04/05, T-GATE-01/04 | T-FUNC-08 | T-FUNC-11/12/13/14, T-CONC-03 |

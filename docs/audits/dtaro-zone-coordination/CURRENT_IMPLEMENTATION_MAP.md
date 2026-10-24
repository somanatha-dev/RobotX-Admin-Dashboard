# Current implementation map: DTARO-relevant architecture and runtime

Audited at `5e94a1a` on `feature/dashboard`, 2026-10-22. All paths are relative to the repository root. Line numbers are from this commit.

**Status vocabulary:** VERIFIED_IMPLEMENTED_AND_COMPOSED · IMPLEMENTED_BUT_NOT_COMPOSED · PARTIALLY_IMPLEMENTED · TEST_ONLY_OR_SIMULATION_ONLY · DOCUMENTED_BUT_NOT_VERIFIED · MISSING · BLOCKED_BY_EXTERNAL_DEPENDENCY · NOT_VERIFIABLE.

**Evidence labels:** **[S]** read in source this session. **[E]** executed this session. **[D]** stated in documentation, not re-proved. **[I]** inference.

---

## 1. Repository and module map

| Area | Entry point / location | Role for DTARO |
|---|---|---|
| Composition root | `Backend/server.js` | Creates `socket.io` `Server` (`:467`), attaches the Redis adapter if configured (`:501-508`), calls `initSocketServer` (`:580`), composes the engine (`:888-983`, gated by `ENGINE_ENABLED`), starts the simulator after `listen` (`:1347-1395`) |
| Socket composition | `Backend/src/sockets/socket.server.js` | Per-connection handler registration (`:341-363`), dashboard auth and rooms (`:234-331`), the legacy DTARO sweep (`startDtaroSweep` `:176-201`) |
| Robot socket handlers | `Backend/src/sockets/handlers/{robot,telemetry,command,dtaro,offer}.handler.js` | AUTH and room join; telemetry and zone membership; command ACK; `OBSTACLE_REPORT`/`TASK_COMPLETE`/`ROBOT_FAULT`; OFFER responses |
| Dashboard broadcast | `Backend/src/sockets/dashboardBroadcast.js` | Only path to dashboard rooms. Campus-scoped relay for an allow-list of events |
| Legacy DTARO services | `Backend/src/services/{zoneManager,ekb,alertDissemination,routeIntersection,routing,robotRegistry}.service.js` | The paper's original zone, EKB, dissemination, intersection and reroute implementation |
| Engine | `Backend/src/engine/**`, `Backend/src/workers/**` | Intake, region→shard, candidate search, 38-predicate gate, solve, commit, dispatch/outbox, supervision, settlement |
| Spatial model | `Backend/src/engine/spatial/{hierarchy,cells,deliveryDomain,regionBoundary}.js` | ADR-28/35/36 region ⊃ zone ⊃ cell, H3 res 11, exact-coordinate delivery domain |
| Simulation | `Backend/src/simulation/**` (`SimulationEngine.js`, `VirtualRobot.js`, `campusTraversalNetwork.js`, `simulationRouter.js`) | Simulated fleet as real socket clients; campus network routing used for pricing **and** execution |
| V1 composition | `Backend/src/services/v1DemonstrationComposition.js`, `v1DemonstrationProfile.js` | Coordinator seams for the simulated fleet (routes, zones traversed, hazard 0) |
| World bootstrap | `Backend/tools/deploy/bootstrapV1Environment.js`, `Backend/tools/demo/seedV1Demonstration.js`, `Backend/prisma/seed.js` | Creates regions, zones, cell assignments, shard, depot |
| Build gates | `Backend/tools/gates/*.js` (`npm run gates`) | `checkLegacyRetirement.js` forbids the paper's allocator |
| Tests | `Backend/tests/{unit,engine,integration,gates,chaos,scale}` (`jest.config.js` lanes) | Isolation via `tests/setup/env.js`: unreachable DB, Redis off, Mapbox off, engine off |
| Frontend | `Frontend/src/context/AppProvider.jsx`, `Frontend/src/lib/obstacleAlert.js`, `Frontend/src/components/modals/DecisionRequiredModal.jsx`, `Frontend/src/features/maps/**` | Obstacle alert handling, map, campus boundary layers |

### Canonical and historical documentation consulted

| Document | Authority |
|---|---|
| `docs/phase15/PHASE_15_MASTER.md` (§2: "**remove** the legacy DTARO decision path from the build, not bypass it") | Canonical |
| `docs/adr/ADR-27-command-emission.md`, `ADR-28-spatial-hierarchy.md` (frozen), `ADR-36-two-layer-spatial-model.md` | Canonical, binding |
| `docs/runbooks/v1-demonstration-assignment.md` | Canonical V1 flow |
| `docs/contracts/PHYSICAL_ROBOTX_BACKEND_CONTRACT.md` (§5.8: `REROUTE`… "have no backend producer today") | Canonical robot-side contract |
| `docs/robotx-system-audit/*` (2026-10-17) | Recent audit; source for Pi/ESP32 facts |
| `ROBOTX_CURRENT_COMMUNICATION_AUDIT.md`, `ROBOTX_OBSTACLE_ALERT_IMPLEMENTATION_PLAN.md` (root, 2026-08-22) | **Historical analysis.** Their break list (B-1…B-7) was re-checked here and still holds at `5e94a1a`. None of the August plan was implemented (no `zonewatch`, `OBSTACLE_ALERT` or `RECHECK_REQUIRED` anywhere in `src`) |
| Root `ARCHITECTURE.md`, `docs/history/**`, `docs/phase15/archive/**` | Historical; not used as fact |

---

## 2. Campus and spatial model

### 2.1 Two zone concepts in one table

`Backend/prisma/schema.prisma` `model Zone` (`:407-446`) carries **both**:

| Semantics | Fields | Containment rule | Producer | Consumer |
|---|---|---|---|---|
| **Legacy DTARO zone**: axis-aligned bounding box | `minLat/maxLat/minLon/maxLon`, `name @unique`, back-relations `robots`, `obstacles` | Query-time geometry: first box containing the point (`zoneManager.service.js:95-101`) | `seedDefaultZones` (`zoneManager.service.js:225-269`); bootstrap gives `rnsit-z1` a real box (`bootstrapV1Environment.js:366-378`) | Telemetry/AUTH membership, `alertDissemination` (zone recorded only) |
| **Engine zone** (§3.6): the pricing and coverage unit | `regionId`, `cells CellAssignment[]`, `priceSnapshots` | **By published assignment, never geometry** (`engine/spatial/hierarchy.js:1-37`; ADR-28 frozen) | Published spatial map in `ConfigVersion` (`snapshot.spatial`), mirrored to `CellAssignment` (`schema.prisma:989-1016`) | `hierarchy.indexMap().resolve()`, F27 zones traversed, capacity pricing, index maintainer region lookup |

`prisma/seed.js:220-237` states the conflict outright: *"Zones already exist as legacy DTARO bounding boxes … the bounding box is legacy state and is not what containment resolves from."* Seeded engine zones get a degenerate `0,0,0,0` box **[S]**.

### 2.2 Campus, region and identifiers

| Entity | Source of truth | Evidence |
|---|---|---|
| Campus | `model Campus` (`schema.prisma:476-495`): `code`, `name`, `centerLat/Lon`, `regionId @unique` → `Region` | Seeded: `RNSIT` (12.9023, 77.5186) and `jssate-bengaluru` (12.9027, 77.5050) (`prisma/seed.js:130-156`) |
| Campus ↔ operating region | `Campus.regionId` (one-to-one) | Only writer: `campus.service.linkCampusRegion` (`campus.service.js:30-72`), SUPER_ADMIN, audited |
| Region | `model Region` (`schema.prisma:911-939`): `regionId` business key; owns zones, cells, agents, missions, chargers, shard | V1 bootstrap creates `rnsit` / `RNSIT` (`bootstrapV1Environment.js:66-67, 364`). `seed.js` creates `RGN-BLR`. Memory of owner decisions names `rnsit-bengaluru` / `jssate-bengaluru` **[D]** |
| JSSATE engine region | **None in any bootstrap or seed tool.** `jssate-bengaluru` appears only as the access-candidate declaration in `tools/campus/generateAccessCandidates.js:53` | **MISSING** in source; live DB **NOT_VERIFIABLE** |
| Robot campus | `Robot.campusId` (`schema.prisma:224-225`), **nullable**. Effective campus via `accessScope.campusIdForRobot` (`accessScope.service.js:166-178`): null if the agent's region disagrees with the campus's region | Writer after commissioning: `PUT /api/robots/:robotId/campus` (`robots.controller.js:1265+`) |
| Agent region / shard | `Agent.regionId` (declared), else region of the observed position via the published map (`indexMaintainer.worker.js:181-191`); shard via `resolveAgentShardId` (`:193-211`), sticky once mirrored in `AgentCellPosition.shardId` | Engine-authoritative |
| Task campus | `Mission.regionId` → `Campus.regionId` (`accessScope.service.js:185-201`); intake maps region → shard and refuses unknown regions (`engine/intake/intake.js:264-354`) | Engine-authoritative |

**Identifier inconsistency [S][D]:** region keys differ by source: `rnsit` (bootstrap), `RGN-BLR` (seed), and `rnsit-bengaluru` (owner decision, 2026-08-30). Any campus-qualified zone identity must be derived from `Region.id`/`Region.regionId` as stored, not from a literal.

### 2.3 Geometry, CRS, indexing

| Topic | Implementation | Status |
|---|---|---|
| Coordinate convention | Code uses `{lat, lon}` objects; GeoJSON inputs are `OGC:CRS84` (lon, lat). A transposed file is not detectable by V-5 [D: spatial memory] | VERIFIED (convention) |
| H3 index | `engine/spatial/cells.js`; FINE = res 11 (ADR-35), COARSE = res 5; `cellForPoint` | VERIFIED_IMPLEMENTED_AND_COMPOSED |
| Delivery domain | `engine/spatial/deliveryDomain.evaluatePoint` (`:266`), point-in-polygon on the exact coordinate, pinned on `Stop.geofenceResult` at intake (`task.service.sealIdentities` `:261`); coordinator runs no geometry (ADR-36) | VERIFIED_IMPLEMENTED_AND_COMPOSED |
| Index cover | D6 boundary-overlap cover of the adopted RNSIT boundary, all `FINE` cells assigned to **one zone `rnsit-z1`** (`bootstrapV1Environment.js:341-344, 381-390`) | VERIFIED in source; live rows NOT_VERIFIABLE |
| Traversal domain | `SIDEWALK_GRAPH` only (owner decision, ROAD_GRAPH excluded) [D]; `campusTraversalNetwork.js` builds the graph from the campus OSM extract's `highway` ways filtered by `MobilityModel.permissionSet.roadClasses` | VERIFIED_IMPLEMENTED_AND_COMPOSED (simulation) |
| Route representation | The OFFER's `stopSequence[].path` (`executionGeometry.attachPricedPaths` `:211-238`, `pathProfile: PRICED_ROUTE`); `taskPath:{taskId}` `{toPickup,toDrop}` KV cache (`assignmentProjection.writeRouteCache` `:351-380`); registry `plannedPath` (no producer, §6) | See §6 |
| Zones traversed by a route | `v1DemonstrationComposition.routeDescriptorFor` (`:363-401`): zones of the **agent's cell and the stop cells only**, not the route's interior cells; consumed by F27 (`engine/feasibility/predicates/f27.js:59`) | PARTIALLY_IMPLEMENTED (endpoint approximation) |

### 2.4 Campus isolation, by layer

| Layer | Mechanism | Status |
|---|---|---|
| Task assignment | Region → shard at intake; one shard per region; candidates only from the shard's availability index (`engine/candidates/availabilityIndex.js` keys `(shard, cell, class)`); 700 m radius | VERIFIED_IMPLEMENTED_AND_COMPOSED [S][D runbook] |
| Dashboard events | `dashboardBroadcast.emit` (`:136-141`): SUPER_ADMIN room gets everything; a campus ADMIN room gets only `ROBOT_EVENTS`/`TASK_EVENTS` for its campus. **`ALERT_CREATED`, `REROUTE_ALERT`, `ZONE_UPDATED` are SUPER_ADMIN-only** (default deny, `:14-17, 33-46`) | VERIFIED_IMPLEMENTED_AND_COMPOSED |
| Obstacle alerts to robots | **None.** `alertDissemination` enumerates the global `robots:all` set (`alertDissemination.service.js:73-81`). The obstacle point is not checked against the reporter's region. Zones are a global list (`zones:all`) | MISSING |
| Zone identity across campuses | Legacy zone ids are UUIDs or explicit ids (`rnsit-z1`), and room names are `zone:{id}` with no campus qualifier. Identical *local* numbers cannot collide only because ids are globally unique strings [I] | PARTIALLY (by accident of id choice, not by design) |

---

## 3. Assignment engine flow (simulated and physical, one path)

Sources: `docs/runbooks/v1-demonstration-assignment.md` §1 **[D]**, with each file confirmed to exist and its entry symbol located **[S]**.

```mermaid
flowchart LR
  A["POST /api/tasks/assign<br/>task.service.assignTask :846"] --> B["sealIdentities :261<br/>deliveryDomain.evaluatePoint → Stop.geofenceResult"]
  B --> C["admitToRound :553 → engine/intake/intake.admit :582<br/>region → shard (intake.js :264-354)"]
  C --> D["WorkQueue row"]
  D --> E["coordinator.worker.runRound :978"]
  E --> F["candidates/expansion over availabilityIndex<br/>(indexMaintainer.worker)"]
  F --> G["feasibility/evaluate.gate :182<br/>38 predicates incl. F27 zones, F34 energy"]
  G --> H["plan/column.price, solve/round.plan :317"]
  H --> I["commitment/commit :241<br/>fenced, capacity 1"]
  I --> J["dispatch/offers.enqueueOffer :189<br/>OFFER + priced path (attachPricedPaths)"]
  J --> K["outbox.worker drainOnce :144<br/>→ room robot:{id}"]
  K --> L["VirtualRobot / Pi<br/>OFFER_ACCEPT"]
  L --> M["offer.handler publishAssignment :261<br/>TASK_ASSIGNED + writeRouteCache :309"]
  L --> N["legProgress.onPositionFix :159<br/>server-detected arrivals"]
  N --> O["TASK_COMPLETE → dtaro.handler verifyCompletionClaim :470<br/>corridor = OFFER path (readCommandedCorridor :790)"]
  O --> P["lifecycle/settlement.settle :164 → taskCompletion"]
```

| Stage | Where | Notes relevant to DTARO |
|---|---|---|
| Readiness and eligibility | 38 §7.5 predicates (`engine/feasibility/**`); e.g. F7 e-stop, F8 faults, F9 health tier, F13 session, F34/F35 energy | Three-valued with a per-predicate missing-data policy. **This is RobotX's readiness gate**; the paper's five-condition gate (`robotValidator`) was retired |
| Cost and ranking | Φ/γ in dimensioned CU (`engine/plan`, `engine/cost`), min-cost-flow solve | The paper's C(r) = 0.45·d + 0.25·(1−b) + 0.20·u + 0.10·τ (`costEvaluator`) was **deleted** at `cbe540e`; `tools/gates/checkLegacyRetirement.js:71-95` fails the build on its return |
| Hazard term | `routeHazardCuFor` seam (`coordinatorSolvePath.js:1411`); the simulator returns 0 (`v1DemonstrationComposition.js:410-411`) | The only existing place an obstacle could ever affect *pricing*; `docs/v1/V1_DISCOVERY_AND_OWNER_QUESTIONS.md` A10 records `ObstacleEvent` as "a different quantity" |
| Commitment | `engine/commitment/commit.js:241`, fenced (`fencing.js`), serialisable | Any replan must not bypass this |
| Command emission | ADR-27: every side effect via an outbox row written in the same transaction as the guarded write | The binding rule for any reroute |
| Rejection, deferral, recovery | OFFER_REJECT/DEFER, NACK cool-off (F20), lease expiry → recovery, B3 orphan claim recovery | Unchanged by DTARO |
| Simulator entry | `SimulationEngine` rehydrates a `VirtualRobot` per `Robot.simulated=true` row; each `connect()`s with `socket.io-client` to `http://127.0.0.1:{port}` (`server.js:1347-1350`, `VirtualRobot.js:996-1002`) | **Same** AUTH, telemetry, OFFER and completion path. Simulation-only *inputs* are injected via `v1DemonstrationComposition` seams, isolated by `isSimulatedSnapshot` (proved by `tests/engine/v1SimulationIsolation.test.js`, run this session) |
| Shortcuts / bypasses found | None that assign. `assign_task` retired; legacy `POST /api/tasks/:id/reroute` refuses engine tasks with `409 ENGINE_REROUTE_UNAVAILABLE` (`tasks.controller.js:483-519`); `TASK_ASSIGN` remains for legacy restart recovery only (contract §5) | VERIFIED |

---

## 4. Simulation architecture (DTARO-relevant parts)

| Capability | Location | Status |
|---|---|---|
| Real socket client, AUTH, rooms | `VirtualRobot.js:996-1010`; server joins `robot:{id}` on AUTH (`robot.handler.js:1075`) and adds it to `robots:all` (`:1089`) | VERIFIED_IMPLEMENTED_AND_COMPOSED |
| Fenced mission command admission | `_registerHandlers` subscribes to every `fencing.MISSION_COMMANDS` event (`VirtualRobot.js:1116`); `_onMissionCommand` (`:1387`) admits by signature/envelope, fence high-water mark, `fenceFloor`, sequence | VERIFIED_IMPLEMENTED_AND_COMPOSED |
| `REROUTE`/`RESEQUENCE` consumer | `VirtualRobot.js:1605-1608`: applies `envelope.payload.newPath` via `_onRerouteAlert` | IMPLEMENTED_BUT_NOT_COMPOSED (no producer) |
| Legacy `REROUTE_ALERT` consumer | `VirtualRobot.js:1127` → `_onRerouteAlert` (`:2347-2387`): acts only on `newPath`, else on `obstacleLocation` (skip ahead), else nothing | Composed; a no-op for the dissemination payload [E: P3] |
| Obstacle generation | `_maybeReportObstacle` (`:3882-3901`), called every tick while `ACTIVE` (`:3230-3231`). With probability `OBSTACLE_PROBABILITY = 0.002` per tick (`constants.js:120`; tick 2 s, `constants.js:4`) it emits `OBSTACLE_REPORT` at the robot's own position ± ~11 m, severity HIGH 30 % / MEDIUM 70 %, from a seeded per-robot stream (`random.js`). The robot **does not stop, slow or react** to its own report | TEST_ONLY_OR_SIMULATION_ONLY: a fabricated event, not a sensed world obstacle |
| Obstacle rate control | `obstacleProbability` is a LIVE simulation parameter (`simulationConfig.js:44, 122`; `SimulationEngine.js:1048-1049`) | VERIFIED |
| World obstacle model | None. No placed or persistent obstacles exist that a robot can encounter or that block network edges | MISSING |
| Route the robot drives | The OFFER's per-stop `path` (priced campus network route) | VERIFIED [D runbook #12][S] |
| Expected ~rate | ≈ 0.06 reports per active robot per minute at defaults [I: 0.002 × 30 ticks/min] | — |

---

## 5. Communication and event architecture

### 5.1 Rooms

| Room | Joined | Left | Emitted to by |
|---|---|---|---|
| `dashboard` | SUPER_ADMIN dashboard socket after JWT (`socket.server.js:267-268`) | disconnect | `dashboardBroadcast.emit` |
| `dashboard:campus:{campusId}` | campus ADMIN socket (`:267`) | disconnect | `dashboardBroadcast.relay` (allow-listed events only) |
| `user:{id}` | every human socket (`:269`) | disconnect | account changes |
| `robot:{robotId}` | robot AUTH success (`robot.handler.js:1075`) | disconnect | outbox worker, `commandDispatcher` (`:43`), `alertDissemination` (`:103`) |
| `zone:{zoneId}` | `zoneManager.updateSocketZoneRoom` (`:111-119`), only on a zone **change** | on change; implicitly on disconnect | **Nothing** [S grep][E: P1b] |

The dashboard/robot split is a heuristic: a socket with an `Origin` header or a `Mozilla` user agent is treated as a dashboard (`socket.server.js:226`; contract §1).

### 5.2 DTARO-relevant events

| Event | Direction | Schema / validation | Server handler | Recipients | Registered consumer | Status |
|---|---|---|---|---|---|---|
| `OBSTACLE_REPORT` | robot → server | zod `{lat:number, lon:number, severity?: LOW\|MEDIUM\|HIGH\|CRITICAL}` (`dtaro.handler.js:86-90`); rate 10/60 s, 500 ms min (`:120`); requires `socket.data.robotId` | `dtaro.handler.js:118-153` → `processObstacleReport` | — | — | VERIFIED_IMPLEMENTED_AND_COMPOSED (sim emits; Pi never emits [D CM-03]) |
| `OBSTACLE_REPORT_ACK` | server → reporter | `{obstacleId, affectedRobots (count), timestamp}` | `:145-149` | reporter socket | No listener in `VirtualRobot` [I: grep found none] | Emitted, unconsumed |
| `ALERT_CREATED` | server → dashboard | `{obstacleId, lat, lon, zoneId, zoneName, severity, reportingRobotId, timestamp, expiresAt}` | `alertDissemination.service.js:54-70` | SUPER_ADMIN only | `AppProvider.jsx:1162-1172` → event log + modal | VERIFIED_IMPLEMENTED_AND_COMPOSED |
| `REROUTE_ALERT` (dissemination) | server → robot | `{obstacleId, lat, lon, zoneId, severity, timestamp}` | `:92-104` | `robot:{id}` for each "affected" robot | `VirtualRobot._onRerouteAlert`: no-op for this shape | IMPLEMENTED_BUT_NOT_COMPOSED (0 recipients) [E: P1, P3] |
| `REROUTE_ALERT` (dashboard copy) | server → dashboard | `{robotId, …}` | `:105` | SUPER_ADMIN | `AppProvider.jsx:1203-1206` log line | Never fires in practice |
| `REROUTE_ALERT` (operator path) | server → robot | `{taskId, segment, newPath}` via `commandDispatcher.dispatchRerouteAlert` (`:130-138`) | `task.service.rerouteTask` (`:1141-1238`) | `robot:{id}` | `_onRerouteAlert` applies `newPath` | Reachable only for **non-engine** tasks (F3 409 for engine tasks) |
| `ZONE_UPDATED` | server → dashboard | `{robotId, oldZoneId, newZoneId, zoneName, timestamp}` | `zoneManager.applyZoneChangeSideEffects` (`:191-215`) | SUPER_ADMIN | **No frontend listener** [S grep] | Emitted, unconsumed |
| `TASK_UPDATED action:REROUTED` | server → dashboard | `{robotId, taskId, action, newPath, segment}` | `routing.rerouteRobot` (`:213-221`) and `task.service.rerouteTask` | dashboard rooms | `useRobotStream.js:961-975` redraws the route | Unreachable from the obstacle path [E: P4] |
| `REROUTE` / `RESEQUENCE` | server → robot (fenced mission command) | Envelope with `commitmentId`, `fence`, `sequence`, signature (`engine/commitment/fencing.js:59-68`, `engine/dispatch/sequence.js:204-212`) | **No producer** in `src` [S grep]; contract §5.8 confirms | — | `VirtualRobot.js:1605-1608` | IMPLEMENTED_BUT_NOT_COMPOSED; protocol tested in `tests/engine/dispatchAgentProtocol.test.js` (run, passed) |
| `SUPERVISION_SIGNAL` | server → dashboard | stall assessment | `telemetry.handler.feedProgressSupervision` (`:1443-1494`), engine-gated, needs `SUPERVISE_STALL_TIME_SECONDS` | dashboard | — | PARTIALLY_IMPLEMENTED: reports, does not act |

### 5.3 Ordering, staleness, replay, delivery guarantees

| Property | Obstacle path today | Engine command path (for comparison) |
|---|---|---|
| Transport | Direct `io.to().emit()` | Outbox row → worker → `robot:{id}` |
| Acknowledgement | `OBSTACLE_REPORT_ACK` to the reporter only; recipients do not ACK | `COMMAND_ACK {outboxId, fence, authorityEpoch}` checked against the row (command ACK fence) |
| Retry | None | Outbox redelivery and escalation |
| Ordering / stale | `timestamp` only; no sequence, no version | Fence + per-commitment sequence; stale or out-of-order refused by the agent |
| Duplicates | Each report gets a fresh `OBS-{ms}-{rand}` id (`ekb.service.js:43`) [E: P6] | Dedup high-water marks, persisted, reported on AUTH |
| Missed while disconnected | Lost. `getActiveObstacles` exists (`ekb.service.js:95-142`) but **has no caller**, so nothing is replayed on reconnect | Outbox state survives; dedup handshake on AUTH |
| Telemetry freshness | Frames carry `timestamp` and `sequence` (`VirtualRobot._emitTelemetry`); older frames are dropped per connection (`aadb2f3`) | — |
| Multi-process | Redis adapter makes room emits cross-process when configured (`server.js:501-508`); Redis is OFF by design locally [D] | Same |

---

## 6. Obstacle and route data flow

### 6.1 As built (verified), with broken edges marked

```mermaid
flowchart TD
  VR["VirtualRobot._maybeReportObstacle<br/>random point ±11 m of itself"] -->|OBSTACLE_REPORT| H["dtaro.handler :118<br/>auth, rate limit, zod lat/lon"]
  H --> P["alertDissemination.processObstacleReport :37"]
  P --> Z["zoneManager.getZoneForCoordinates<br/>bbox lookup → zoneId"]
  P --> K["ekb.storeObstacle :42<br/>KV 300 s TTL + ObstacleEvent (best effort)"]
  P -->|ALERT_CREATED| DB["dashboard (SUPER_ADMIN)<br/>log + modal"]
  P --> S["scan robots:all (fleet-wide)<br/>registry.plannedPath"]
  S --> X["routeIntersection.findAffectedRobots<br/>vs one SW–NE diagonal"]
  X -.->|"always [] — plannedPath has no producer (B-2)"| R["io.to(robot:id) REROUTE_ALERT"]
  R -.->|"payload lacks newPath/obstacleLocation (B-3)"| VRH["VirtualRobot._onRerouteAlert → no-op"]
  X -.-> RR["routing.rerouteRobot :174"]
  RR -.->|"taskPath has no pickup/drop → early return"| NONE["no replan, no event"]
  Z -.->|"zoneId never used to address (B-1)"| ZR["zone:{id} room — no emitter"]
```

Dotted edges are unreachable in the production state. Every dotted edge was confirmed by execution (§11).

### 6.2 Component detail

| Component | Location | What it does | Defects / gaps |
|---|---|---|---|
| Zone lookup | `zoneManager.service.js:33-101` | 3-tier cache (in-process 60 s → KV `zones:all` 300 s → `prisma.zone.findMany`), first bbox match | Global list (no campus filter); engine zones in a seeded DB have `0,0,0,0` boxes and never match; first-match on overlap |
| Default zones | `seedDefaultZones` (`:225-269`) via `startDtaroSweep` (`socket.server.js:182-190`) | 4 quadrants of ±0.01° (~1.1 km × 1.1 km) around `prisma.campus.findFirst()`, **only if zero zones exist** | First campus only (no `orderBy`); skipped whenever any zone exists (always, after bootstrap or seed) |
| Membership (telemetry) | `telemetry.handler.js:1111-1167` | Computes zone each tick and folds it into the merged registry write; side effects only on change. `undefined` (no fix) ≠ `null` (outside all zones) | Correct change detection (tested by `zoneLocality.test.js`) |
| Membership (AUTH) | `robot.handler.js:1092-1102` → `assignRobotToZone` (`zoneManager.service.js:153-172`) | Recomputes from the registry's last position | **Reconnect gap (B-7):** within the 30 s registry TTL the stored `zoneId` equals the new one, so `changed=false` and the new socket never joins `zone:{id}` [E: P5]. `markOffline` keeps `zoneId` (`robotRegistry.service.js:239-251`) |
| Durable mirror | `Robot.zoneId` (`schema.prisma:228-229`), written on change (`zoneManager.service.js:193-196`) | — | No reader (schema forensics) |
| EKB | `ekb.service.js:42-87` | KV `ekb:event:{id}` with TTL + set `ekb:obstacles`; in-memory fallback; `prisma.obstacleEvent.create` with errors swallowed | No dedup/merge key [E: P6]; clock-only expiry 300 s [E: P7]; no clear/confirm; `getActiveObstacles` has no caller; `ObstacleEvent` is write-only; `sweepExpired` every 60 s (`socket.server.js:193-200`) |
| Dissemination | `alertDissemination.service.js:37-115` | See the diagram | Fleet-wide O(N) scan (registry banner `robotRegistry.service.js:4-21` admits it violates T9); no campus scoping; direct emit bypasses `commandDispatcher`; errors swallowed by `allSettled` |
| Intersection | `routeIntersection.service.js:19-87` | Parametric segment test of the route against one diagonal segment ±0.0002° (≈ 44 m × 43 m box, ~62 m diagonal; the comment's "~22 m" is wrong [I]) | Parallel/collinear → false (`:29`) [E: P2b]; a route can cross the box without crossing that diagonal; no buffer/corridor width |
| Replan (legacy) | `routing.service.js:129-226` | "A*" = k-nearest reorder over the existing polyline's waypoints, blocked within 30 m; falls back to Mapbox, then to a **straight line** (`:116`) | Writes `taskPath`/registry with no fence/outbox/ACK (a second command authority); never sends the new path to the robot; incompatible with the engine route cache [E: P4]; straight-line fallback contradicts the "no straight-line" rule of `executionGeometry` |
| Engine replan channel | `REROUTE` mission command | Defined, fenced, sequenced, consumed by the simulator | **No producer** |
| Campus router | `campusTraversalNetwork.js:233-257` (`treeFrom`, memoised Dijkstra), `route()` (`:319+`) | Exact-endpoint routes on the permitted network | **No blocked-edge or vertex input**; the memo is per source vertex and would have to be keyed by any blocked set [I] |
| Commanded corridor | `dtaro.handler.readCommandedCorridor` (`:790-804`): latest OFFER outbox row's `stopSequence[].path` | Used to grade completion | Any route change must update what this reads, or completion goes to `VERIFYING` (F3 precedent) |
| Engine A8 | `engine/failure/agentFailures.js:245-262` ("local replan; then global reroute; then obstacle report to the knowledge base and reroute of other affected missions"); `externalEscalation.js:94-100, 293-302` (`affectedMissionIds`, `writeObstacleToKnowledgeBase: true`) | Specified response rows and payload | `affectedMissionIds` has **no producer** [S grep]; no engine knowledge base exists |

---

## 7. Dashboard observability

| Capability | Status | Evidence |
|---|---|---|
| Campus boundaries and identity | VERIFIED_IMPLEMENTED_AND_COMPOSED | `Frontend/src/features/maps/campus/{campusLayers,campusRegistry,campusSchema}.js` |
| Robot positions, assigned routes | VERIFIED_IMPLEMENTED_AND_COMPOSED | `TASK_ASSIGNED` cache and `useRobotStream`; routes rehydrated on connect (`socket.server.js:306-330`) |
| Task assignment and state | VERIFIED_IMPLEMENTED_AND_COMPOSED | `TASK_UPDATED`/`TASK_ASSIGNED`/`OFFER_RESPONSE` handlers (`AppProvider.jsx:1279-1296`) |
| Obstacles and their lifecycle | PARTIALLY_IMPLEMENTED: event log line + one information modal (`DecisionRequiredModal.jsx`, `OBSTACLE_NO_ACTION_NOTE`); **no map marker, no expiry/clear display** | `obstacleAlert.js`; `AppProvider.jsx:1162-1172` |
| Robot zone membership | MISSING: `ZONE_UPDATED` has no listener; no zone overlay | grep |
| Alert recipients / processing | MISSING beyond the `REROUTE_ALERT` log line, which never fires | `AppProvider.jsx:1203-1206` |
| Route intersections and replanning | Redraw on `TASK_UPDATED REROUTED` exists (`useRobotStream.js:961-975`); never triggered by obstacles | — |
| Connection, stale-state, safety | VERIFIED (connection state, stop latch, readiness, `SUPERVISION_SIGNAL` emitted) | FS-series hardening [D] |
| Campus ADMIN visibility of obstacles | MISSING by design (default deny); an open owner decision [D RBAC memory] | `dashboardBroadcast.js:14-17` |

---

## 8. Safety and authority

| Decision | Authoritative component today | Evidence |
|---|---|---|
| Campus membership (robot) | `Robot.campusId` + agent-region cross-check (`accessScope.campusIdForRobot`); engine uses the agent region/shard | §2.2 |
| Campus membership (task) | Mission region at intake | §2.2 |
| Zone membership | Legacy: KV registry `zoneId` from the bbox (live) mirrored to `Robot.zoneId`. Engine: published cell→zone map. **Two sources; neither is declared authoritative for communication** | §2.1, §6.2 |
| Obstacle validity | None. Any authenticated robot's report is stored as given; severity is agent-supplied | `dtaro.handler.js:118-153` |
| Route validity | The priced route in the signed OFFER; completion graded against it | `executionGeometry`, `readCommandedCorridor` |
| Replanning | None safe. `REROUTE` defined, no producer; legacy reroute refused for engine tasks (F3) | §5.2 |
| Motor command authority | The robot. For physical: the ESP32 gates every wheel command; "Nothing the backend sends is a safety function" (contract ground rule 3). For simulation: `VirtualRobot` admits fenced commands only | contract; `VirtualRobot.js:1387+` |
| Emergency / protective stop | Physical: ESP32 latch (`safety_stop`), operator reset [D system audit]. Backend `STOP` is an operator request | contract §7 |
| Robot readiness | Engine feasibility gate (F7/F8/F9/F13/F34…); agent readiness refusals (`NO_EXECUTABLE_PATH` etc.) | runbook §3 |
| Assignment commitment | `engine/commitment/commit.js` (fenced, serialisable); ADR-27 outbox | §3 |

---

## 9. Pi / ESP32 boundary (as evidenced; repos not inspected)

| Fact | Source |
|---|---|
| The Pi **never emits** `OBSTACLE_REPORT` or `ROBOT_FAULT` (CM-03, RX-21) | `docs/robotx-system-audit/INTERFACE_AND_PROTOCOL_CONTRACTS.md:248`, `CURRENT_BLOCKERS_AND_RISKS.md:28` |
| The physical contract does not list `OBSTACLE_REPORT` as a robot event; it tells the Pi to admit and ACK `REROUTE` but do nothing physical, because it has no backend producer | `docs/contracts/PHYSICAL_ROBOTX_BACKEND_CONTRACT.md:184` |
| A camera obstacle ≥ ~0.3 s puts the Pi leg into a permanent `REROUTE_NEEDED` (RX-08); the Pi engine `REROUTE` is a no-op | `CURRENT_BLOCKERS_AND_RISKS.md:73-79` |
| ESP32 front obstacle → `GATED` → `safety_stop` latch → Pi PAUSED; operator reset needed (RX-03) | system audit; integration-tested on the host-compiled simulator [D] |
| Hardware blockers: faulty front ultrasonic, no independent e-stop | memory `project_robotx_hw_blockers_estop_sensor` [D] |

**Conclusion:** no verified shared obstacle contract exists between the backend and the Pi. DTARO V1 for simulation does not require one. A future physical integration needs its own contract work (deferred).

---

## 10. Prior DTARO implementation history

| Item | Evidence |
|---|---|
| The legacy tier is the paper's implementation (zone rooms, EKB, receiver-side test in the paper vs **server-side** in code, A* reroute, C(r) allocator) | File headers "— DTARO" in every service; `robotRegistry.service.js:1-33` |
| Allocation half retired at Phase 15 | `git log --diff-filter=D`: `cbe540e` deleted `costEvaluator.service.js`, `taskAssignment.service.js`, `tests/unit/dtaro/{costEvaluator,robotValidator,taskAssignment}.test.js` |
| Rule that the legacy decision path stays out | `docs/phase15/PHASE_15_MASTER.md` §2; `tools/gates/checkLegacyRetirement.js` (run: PASS) |
| Earlier analysis that found the same breaks | `ROBOTX_CURRENT_COMMUNICATION_AUDIT.md` §6.3, §12, §16 (rules **DO NOT IMPLEMENT** zone-scoped room delivery and **DO NOT ADD** `rerouteRobot`-style mutation); `ROBOTX_OBSTACLE_ALERT_IMPLEMENTATION_PLAN.md` §1 (B-1…B-7; proposes recipients = zone occupants ∪ route watchers ∪ route-intersecting, receiver-side relevance, severing `alertDissemination → rerouteRobot`, evidence-based expiry). **Neither was implemented** |
| Frontend FS-06 hardening | `obstacleAlert.js` header: the modal's former "auto-rerouting" claim was false and was removed |

---

## 11. Executed probe: reproduction record

**Command (run this session):**
```
node <session-scratchpad>/probe/dtaroProbe.js C:/Users/soman/OneDrive/Desktop/RobotX/Backend
```

**Environment:** `DATABASE_URL` unreachable, `REDIS_ENABLED=false`, no Mapbox token. `prisma = null` is passed to every service, so nothing touches a database. KV is the real `src/cache/kv.js` facade in memory mode. The production modules are imported unmodified. Exit 0. `git status --porcelain` was empty afterwards.

| # | Claim | Observed | Verdict |
|---|---|---|---|
| P1 | With no registry `plannedPath`, no robot is affected | `affectedRobotIds=[]`, `zoneId=rnsit-z1` | CONFIRMED |
| P1b | The zone is resolved but no zone room is addressed | emits = `dashboard:ALERT_CREATED` only | CONFIRMED |
| P2a | A route crossing perpendicular to the model diagonal is detected | `["RBT-A"]` | CONFIRMED |
| P2b | A route passing exactly through the obstacle along SW–NE is missed | `RBT-B` absent | CONFIRMED |
| P2c | A report from a robot whose route is at JSSATE, naming an RNSIT point, is accepted unchecked | obstacle stored | CONFIRMED |
| P3 | The dissemination `REROUTE_ALERT` has neither `newPath` nor `obstacleLocation`; `VirtualRobot._onRerouteAlert` changes nothing | keys `lat,lon,obstacleId,severity,timestamp,zoneId`; state unchanged | CONFIRMED |
| P4 | `writeRouteCache` stores no `pickup`/`drop`; `rerouteRobot` returns early | keys `toPickup,toDrop`; no path change; 0 emits | CONFIRMED |
| P5 | A reconnect within the TTL does not rejoin `zone:{id}` | first socket `[zone:rnsit-z1]`, reconnected `[]` | CONFIRMED |
| P6 | Identical reports create distinct records | two ids, 4 active | CONFIRMED |
| P7 | Expiry is a fixed 300 s wall clock | 300 s | CONFIRMED |

**What it proves:** the module-level behaviour of the composed obstacle path on the current tree.
**What it does not prove:** behaviour through a live `server.js` with real sockets and a database. That still needs a running stack (see the test plan, V-E2E).

<details>
<summary>Probe source (documentation only — not part of the application)</summary>

```js
"use strict";
process.env.DATABASE_URL = "postgresql://probe:probe@127.0.0.1:1/none";
process.env.REDIS_ENABLED = "false";
delete process.env.REDIS_URL; delete process.env.MAPBOX_TOKEN; delete process.env.MAPBOX_ACCESS_TOKEN;
process.env.NODE_ENV = "test";
const path = require("path");
const B = process.argv[2];
const req = (p) => require(path.join(B, p));
const { initKv } = req("src/cache/kv");
const alert = req("src/services/alertDissemination.service");
const registry = req("src/services/robotRegistry.service");
const zoneManager = req("src/services/zoneManager.service");
const routing = req("src/services/routing.service");
const projection = req("src/services/assignmentProjection.service");
const ekb = req("src/services/ekb.service");
const VR = req("src/simulation/VirtualRobot");
const fakeIo = () => { const emitted = []; return { emitted, to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) }; };
const fakeSocket = () => { const rooms = new Set(); return { rooms, join: (r) => rooms.add(r), leave: (r) => rooms.delete(r) }; };
(async () => {
  const { kv } = await initKv({ logger: { info() {}, warn() {}, error() {}, debug() {} } });
  const ZONE = { id: "rnsit-z1", name: "RNSIT Zone 1", minLat: 12.899, maxLat: 12.906, minLon: 77.515, maxLon: 77.522 };
  await kv.set("zones:all", JSON.stringify([ZONE]), { ex: 300 });
  const OBS = { lat: 12.9023, lon: 77.5186 }, d = 0.001;
  for (const id of ["RBT-A", "RBT-B", "RBT-JSS"]) { await kv.sadd("robots:all", id); await registry.setRobotState(kv, id, { robotId: id, ...OBS }); }
  let io = fakeIo(); let r = await alert.processObstacleReport(null, kv, io, { ...OBS, severity: "HIGH", reportingRobotId: "RBT-A" });   // P1, P1b
  await registry.updatePlannedPath(kv, "RBT-A", [{ lat: OBS.lat - d, lon: OBS.lon + d }, { lat: OBS.lat + d, lon: OBS.lon - d }]); // NW–SE
  await registry.updatePlannedPath(kv, "RBT-B", [{ lat: OBS.lat - d, lon: OBS.lon - d }, { lat: OBS.lat + d, lon: OBS.lon + d }]); // SW–NE
  await registry.updatePlannedPath(kv, "RBT-JSS", [{ lat: 12.9027, lon: 77.504 }, { lat: 12.9027, lon: 77.506 }]);
  io = fakeIo(); r = await alert.processObstacleReport(null, kv, io, { ...OBS, severity: "HIGH", reportingRobotId: "RBT-JSS" });     // P2a-c
  const toRobot = io.emitted.find((e) => e.room === "robot:RBT-A" && e.event === "REROUTE_ALERT");
  const self = { activePath: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }], pathIndex: 0, robotId: "RBT-A", log: { info() {} }, task: null };
  VR.prototype._onRerouteAlert.call(self, toRobot.payload);                                                                          // P3
  await projection.writeRouteCache(kv, { taskId: "T-1", robotId: "RBT-A", route: { pathToPickup: [OBS, { lat: OBS.lat + d, lon: OBS.lon }], pathToDrop: [OBS, { lat: OBS.lat + 2 * d, lon: OBS.lon }] } });
  await routing.rerouteRobot(null, kv, fakeIo(), "RBT-A", { obstacleLocation: OBS });                                                 // P4
  const s1 = fakeSocket(), s2 = fakeSocket();
  await zoneManager.assignRobotToZone(null, kv, null, "RBT-Z", OBS.lat, OBS.lon, s1, null);
  await zoneManager.assignRobotToZone(null, kv, null, "RBT-Z", OBS.lat, OBS.lon, s2, (await registry.getRobotState(kv, "RBT-Z")).zoneId); // P5
  const o1 = await ekb.storeObstacle(kv, null, { ...OBS }); const o2 = await ekb.storeObstacle(kv, null, { ...OBS });                 // P6, P7
  /* each claim is then compared and printed as in the table above */
})();
```
</details>

---

## 12. Tests that touch this area

| Test | What it covers | Limitation | Run this session |
|---|---|---|---|
| `tests/unit/dtaro/zoneLocality.test.js` | Telemetry writes `zoneId` to the registry; `ZONE_UPDATED` only on change | Bbox zones only; no reconnect case; no delivery | PASS |
| `tests/unit/tasks/tasksControllerRerouteEngine.test.js` | F3: legacy reroute refused for engine tasks | Controller only | PASS |
| `tests/unit/redis/liveRobotIndex.test.js` | `robots:all` membership | — | PASS |
| `tests/unit/tasks/dtaroHandlerTaskComplete.test.js` | `TASK_COMPLETE` grading/hold in `dtaro.handler` | Not the obstacle handler | PASS |
| `tests/engine/dispatchSchema.test.js` | Legacy events (`REROUTE_ALERT` …) are not engine commands | — | PASS |
| `tests/engine/dispatchAgentProtocol.test.js` | `REROUTE`/`RESEQUENCE` fence, sequence, ordering admission | Protocol only; no producer | PASS |
| `tests/engine/v1SimulationIsolation.test.js`, `routingSimulationProducer.test.js` | Simulation seams answer only for simulated agents; campus routing producer | — | PASS |
| *(none)* | `alertDissemination`, `routeIntersection`, `ekb`, `routing.replanRoute`, `OBSTACLE_REPORT` handler, `_maybeReportObstacle` | **No coverage** | — |

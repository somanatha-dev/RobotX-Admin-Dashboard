# P2A — Physical RobotX: Backend-Side Contract Audit

**Date:** 2026-09-24
**Branch:** `feature/dashboard`, HEAD `f69b3e2` + the uncommitted P1 tree (`fleetProviders/`, `server.js`, `simulationBoundary.test.js`)
**Scope:** Dashboard/Backend only. Read-only. **No file under `Backend/` was changed.** Nothing committed, nothing pushed.
**Companion (for the Rover/Pi Claude):** [`docs/contracts/PHYSICAL_ROBOTX_BACKEND_CONTRACT.md`](docs/contracts/PHYSICAL_ROBOTX_BACKEND_CONTRACT.md)

**Labels used in this document**

| Label | Meaning |
|---|---|
| **EXISTS** | Traced to executing code, cited as `file:line`. |
| **PROPOSED** | A backend change this contract needs. P2B work, not implemented. |
| **NOT CURRENTLY AVAILABLE** | The rover hardware or firmware cannot produce it today. Checked read-only in `OneDrive/Documents/Arduino/robot_controller`. |
| **OWNER** | A value or decision that belongs to the owner. It is not derivable from code. |

---

## 0. Summary

1. **The existing protocol already covers connection, identity, the engine OFFER cycle, custody and completion.** No new event is needed for any of them. The physical robot uses exactly the events `VirtualRobot` uses on the V1 path: `AUTH`, `HEARTBEAT{commitmentId,fence}`, `TELEMETRY`, `OFFER` → `OFFER_ACCEPT/REJECT/DEFER`, `COMMAND_ACK{outboxId}`, `CUSTODY_EVENT`, `TASK_COMPLETE`, and the legacy `COMMAND`/`STOP`.
2. **Three things have no carrier at all today:** safety state, structured faults and localisation quality. The contract adds them as optional blocks inside the existing `TELEMETRY` event, stored as `Observation` rows of new `kind`s. **No migration is needed for them.**
3. **F14 has no producer for any physical agent.** F14 needs a *server-initiated* round trip. Nothing on the server ever initiates one: `HEARTBEAT` is agent-initiated and never acknowledged. Only the simulator states `lastHeartbeatAckAt` (`simulatedAgentState.js:264`). The contract reuses the engine's existing query command `PROBE` and the reference client's existing answer `PROBE_RESULT` (`VirtualRobot.js:1353-1359`). There is no server emitter and no server listener for either. That work is **PROPOSED**.
4. **F7 cannot be satisfied honestly on today's hardware.** The rover has **no confirmed emergency-stop circuit**: `ROVER_HARDWARE_ARCHITECTURE.md` questions 26 and 31 are open. The ESP32's `safety_stop` is a proximity latch. It is *not* an E-stop. Mapping `safety_stop:false` to "E-stop not engaged" would be a fabricated safety fact. F7 stays ABSENT, and the robot stays unassignable.
5. **Four latent defects are permissive in direction and do not fire today.** Each would fire the moment P2B connects real data (§I.2):
   - D-A: `recordReportedSoc` writes any reported `battery` % into engine SoC and ignores how it was obtained.
   - D-B: nothing in the engine checks the age of SoC.
   - D-C: a Pi clock running fast makes stale data look fresh. The agent clock feeds liveness, and agent-timestamp skew is never bounded.
   - D-D: with the engine on, nothing marks a silent robot offline.
6. **Schema:** no change is needed for the telemetry, heartbeat, safety, health or position contract. **One decision is open:** where operator-entered control-plane facts live. These are F1, F3, F5, F6, F11, F12, F27 and F36, none of which the Pi supplies. §M gives the options and the proposed fields. Nothing is migrated.
7. **Physical RobotX stays unassignable after P2A, by design.** The blockers that remain are the missing hardware below, operator-entered facts, charging scope (B2) and the physical router (B1). No Pi implementation can clear them alone.
   - Missing hardware: e-stop, battery sense, GPS path, and localisation corroboration (encoders are wired, but no encoder feature is implemented).

### 0.1 Corrections to the 2026-09-22 audit (`ROBOTX_BACKEND_PI_INTEGRATION_CONTRACT_AUDIT.md`)

That file is untracked and was **left unedited**. The following statements in it are stale:

| 2026-09-22 claim | Current code |
|---|---|
| "HEARTBEAT has no payload; anything sent is discarded" | `{commitmentId, fence}` renews the commitment lease (`robot.handler.js:726-739` → `commitmentLeaseRenewal.service.js:35`). |
| "OFFER_ACCEPT/REJECT/DEFER inert — engine off" | Live on the V1 path (`ENGINE_ENABLED=true` + shard gate), `offer.handler.js:203-398`. |
| (absent) | `CUSTODY_EVENT` exists, `offer.handler.js:324-335` → `legProgress.service.js:234`. |
| "Observation rides the 15 s `shouldSnapshot` throttle" | Written on **every accepted frame** (`telemetry.handler.js:832-840`). |
| (absent) | `battery` → `BatteryState.lastObservedSoc`, update-only, every accepted frame (`telemetry.handler.js:846`, `batteryObservation.service.js:38`). |
| "TASK_COMPLETE only needs `taskId`" | The engine path grades `lat`, `lon` and the position track, and settles the Leg on SUFFICIENT (`dtaro.handler.js:176-265, 431-575`). |
| "Task assignment is unreachable" | Reachable on the V1 composition path (5/5, 10/10 and 20/20 simulated). Physical agents are refused *by data*, not by the absence of a path. |
| "Offline sweep runs every 10 s" | It **stands down** when the engine is enabled (`socket.server.js:184-187`). See D-D. |

---

## A. Existing backend protocol

Transport: Socket.IO v4, default namespace `/`, path `/socket.io/`, one `Server` (`server.js:383`) with the default `pingInterval`/`pingTimeout` (none set). The client is classified by a header heuristic. A handshake that carries an `Origin` header, or a `User-Agent` containing `Mozilla`, is treated as a dashboard (`socket.server.js:194-218`).

### A.1 Robot → server

| Event | Payload (schema) | Auth | State transition | Source | Tests |
|---|---|---|---|---|---|
| `AUTH` | `{robotId:str≥1, pairingCode?|token?, dedupState?, certificate?}` passthrough | none (it *is* auth) | Robot row must exist. Pairing → mints `session:{robotId}` (24 h). Sets `isOnline=true`, `socketId`. Joins `robot:{robotId}`. Joins `robots:all`. Displaces the old socket. Binds shard identity. Replies `AUTH_SUCCESS`+`AUTH_OK`. | `robot.handler.js:413-706` | `integration/robotCommandRoundTrip`, `unit/redis/liveRobotIndex` |
| `HEARTBEAT` / `heartbeat` | optional `{commitmentId, fence}` | authed socket | Redis `lastHeartbeat=serverNow` on every beat. `Robot.lastSeenAt` flushed at most every 15 s. With `commitmentId` and the gate open: lease renewal once the lease is ≥ half consumed. Rate limit 10/5 s. | `robot.handler.js:709-790` | `unit/telemetry/heartbeatDbWrites`, `engine/v1ExecutionProducers` |
| `TELEMETRY` / `telemetry` | `{lat, lon, speed, battery, status, distanceTravelled, timestamp, sequence}` all optional, numeric strings coerced, passthrough | authed, else `AUTH_REQUIRED` | Capability-claim scan (the whole frame is dropped on a hit). §23.5 trust boundary (drops the frame when enforced). Status transition table. Redis live state. `Robot` flush gate. `Telemetry` history. **Position Observation** (needs `timestamp`). **BatteryState SoC** (update-only). Leg departure/arrival (engine). `robot:update` to the dashboard. Rate limit 50/5 s, ≥100 ms apart. | `telemetry.handler.js:384-960` | `unit/telemetry/positionObservation*`, `engine/positionObservationPipeline`, `engine/batteryObservation` |
| `OFFER_ACCEPT` | `{commitmentId, fence, reason?, until?}` | gate (`agentGate.assess`) | `offers.matchResponse` (commitment + fence + agent). `applyAccept` → Leg ACCEPTED, lease granted. `start_grace` armed. Read-model projection, `TASK_ASSIGNED` to the dashboard. | `offer.handler.js:337-349` | `engine/dispatchAgentProtocol`, `unit/sockets/offerAcceptPublishesAssignment` |
| `OFFER_REJECT` | same | gate | Commitment released, Leg re-queued, NACK cooloff 120 s. `Observation{kind: feasibility, source: AGENT_REPORT}`. | `offer.handler.js:351-386` | `engine/dispatchAgentProtocol` |
| `OFFER_DEFER` | same + `until` | gate | `applyDefer` | `offer.handler.js:388-398` | `engine/dispatchAgentProtocol` |
| `COMMAND_ACK` | legacy `{commandId}`, **or** engine `{outboxId, fence?, authorityEpoch?}` | authed (engine half: gate) | Legacy: `Command` SENT→ACK, `executedAt`. Engine: outbox row → ACKED if agent, fence and epoch match. | `command.handler.js:82-164` | `engine/dispatchAgentProtocol`, `integration/robotCommandRoundTrip` |
| `CUSTODY_EVENT` | `{commitmentId, fence, kind: "ACQUIRED"\|"RELEASED"}` | `agentGate.mayAct` | Applied only at a stop the **server** verified: AT_PICKUP→LOADED, AT_DROP→RELEASED. Held in memory if early. RELEASED + prior SUFFICIENT verification → settle. | `offer.handler.js:324-335`, `legProgress.service.js:234-326` | `engine/v1ExecutionProducers` (service level). **No socket-level test.** |
| `TASK_COMPLETE` | `{taskId, lat?, lon?, physicalEvidence?, attestation?, plannedCorridor?, reportedCorridors?, deadZoneWindows?}` | authed | Resolves Task (or Leg → Task). §12.5 verification (engine gate). INSUFFICIENT → `VERIFYING` + ack `{verifying:true}`. Otherwise Task COMPLETED, Leg settled, Robot IDLE. | `dtaro.handler.js:150-311` | `unit/tasks/dtaroHandlerTaskComplete`, `engine/completionIdentityMapping` |
| `ROBOT_FAULT` | `{code?, message?, sensor?, blocking?}` | authed | `Robot.status=ERROR` → F9 QUARANTINED. Registry `FAULT`, CRITICAL Event, A5/A6 classification. **Not mapped to F8 `faults`.** | `dtaro.handler.js:315-409` | **No test found by event name.** |
| `OBSTACLE_REPORT` | `{lat:number, lon:number, severity?}` strict | authed (else `ERROR`) | EKB entry, reroute fan-out | `dtaro.handler.js:112-147` | `unit/dtaro/*` |
| `SESSION_REKEY_ACK` | `{sessionId?}` | mTLS only | binding rotation | `robot.handler.js:884-913` | — |
| `PROBE_RESULT` | reference client sends `{command, robotId, correlationId, status, dedup}` | — | **No server listener exists.** | `VirtualRobot.js:1347-1361` | — |

### A.2 Server → robot

| Event | Payload | Robot ACK | Producer | Notes |
|---|---|---|---|---|
| `AUTH_SUCCESS` + `AUTH_OK` | `{robotId, token, dedup, session}` | — | `robot.handler.js:652,654` | Both fire. Handle one. |
| `AUTH_REQUIRED` | `{robotId}` | re-AUTH | `telemetry.handler.js:421` | |
| `UNAUTHORIZED` | `{message}` | — | `socket.server.js:216` | Means the handshake was misclassified as a dashboard. |
| **`OFFER`** | signed envelope `{outboxId, command:"OFFER", commandClass, fenceScope, agentId:<robotId>, commitmentId, fence:str, authorityEpoch, fenceFloor, sequence, notValidAfter:ISO, signature, payload}` | `COMMAND_ACK{outboxId,fence,authorityEpoch}` **and** one of `OFFER_ACCEPT/REJECT/DEFER` | `offers.enqueueOffer` (`offers.js:189`) → outbox → `leaderWorkers.js:260-280` (rewrites the key and `agentId` to the wire id) → `commandDispatcher.js:308` | The event name is the command. `payload`: `{commitmentId, fence, legId, taskId, missionPlan, stopSequence[], routeReference:null, payloadManifest[], requirementAcknowledgements[], energyReserveParams, targetSoc, offerExpiry}` (`offers.js:105-150`). |
| **OFFER expiry** | — | — | `notValidAfter` = store time + `dispatch.offer_ttl` (20 s). OFFERED deadline armed in the commit tx (`coordinatorSolvePath.js:2171`). On expiry: `withdrawExpiredOffer` → fence advanced, `WITHDRAW` enqueued, Leg → QUEUED (`offers.js:483`). | The agent must refuse any envelope whose `notValidAfter` has passed. |
| `WITHDRAW` | envelope, payload `{commitmentId, supersedesFence, reason}` | `COMMAND_ACK{outboxId}` | `offers.js:483-540` | The robot stops that mission. |
| `RECALL` | envelope | `COMMAND_ACK{outboxId}` | `lifecycle/reassignment.js:218-240` | Reassignment. The robot stops that mission. |
| `ABORT_MISSION`, `REROUTE`, `RESEQUENCE`, `RESUME`, `TRANSFER_CUSTODY`, `STAND_DOWN_ALL`, `QUARANTINE`, `RELEASE_QUARANTINE`, `ESTOP_CLEAR`, `SHARD_MIGRATE`, `PARAMETER_PUSH` | envelope | `COMMAND_ACK{outboxId}` | **No production producer found** (grep of `command: "<NAME>"` in `src/`). The vocabulary is in `fencing.js:59-82`. | Handle defensively. None is emitted today. |
| `PROBE`, `STATUS_REQUEST`, `MANIFEST_QUERY` | query (unfenced, never outboxed) | `<NAME>_RESULT` | **No producer.** `outbox.buildRow` refuses queries (`expiryActions.js:634-640`). | See §D: the contract makes `PROBE` the F14 proof. |
| `COMMAND` | `{commandId, type: STOP\|PAUSE\|RETURN\|RESUME, timestamp}` | `COMMAND_ACK{commandId}` (idempotent) | `robots.controller.js:710-783` → `commandDispatcher.js:154` | Operator motion control. Re-sent at 5 s, 10 s, 15 s, then FAILED. **Not a safety function.** |
| `STOP` | `{taskId?, reason:"TASK_CANCELLED", timestamp}` | none | `tasks.controller.js:278` → `commandDispatcher.js:169` | Distinct from `COMMAND type STOP`. |
| `TASK_ASSIGN` | legacy route payload | none | `server.js` restart recovery only | **Not on the engine path.** The mission arrives inside `OFFER`. |
| `REROUTE_ALERT` | `{obstacleId, lat, lon, zoneId?, severity?, newPath?, timestamp}` | none | `task.service.js` | Legacy DTARO. |
| `TASK_COMPLETE_ACK`, `ROBOT_FAULT_ACK`, `OBSTACLE_REPORT_ACK`, `ERROR` | — | — | `dtaro.handler.js` | |
| `RETURN_TO_BASE` | — | — | **No producer** | Dead listener in `VirtualRobot`. |

### A.3 Disconnect and reconnect

- **Disconnect** (`robot.handler.js:915-955`) marks the robot offline (`isOnline=false`, `status=OFFLINE`, `socketId=null`), `srem robots:all`, and emits `robot_offline`. It is guarded so that a displaced socket never marks the robot offline.
- **Reconnect:** re-`AUTH` with the persisted token. The new socket is registered and the DB updated **before** the old socket is disconnected (`:576-613`). The token TTL is refreshed to 24 h on each success (`:536,572`).
- **Engine on:** the legacy offline sweep stands down (`socket.server.js:184`). Offline detection then relies on the transport disconnect alone: Socket.IO's default ping/pong, roughly 25 s + 20 s. See D-D.

---

## B. Physical robot identity design

**No new model, and no migration.** A physical RobotX is exactly what `POST /api/robots/commission` already creates for a unit with `simulated=false`:

| Identity element | Representation | EXISTS at |
|---|---|---|
| robotId (wire identity) | `Robot.robotId` (unique, operator-chosen). Used by AUTH, the `robot:{robotId}` room, every Redis key and the envelope addressee. | `schema.prisma:203`, `robot.handler.js:432`, `leaderWorkers.js:278` |
| agentId | `Agent.agentId` **= the same string**. `Agent.id` is a deterministic hash of the code (FK only, never on the wire). | `robot.service.js:531-546`, `legacyRobot.robotToAgent` |
| Kind | `Robot.simulated=false` (default) and `simulationOwnerId=null`. Read **only** through `simulationPolicy`. | `schema.prisma:266,308`, Step 1 |
| Class / type | A per-unit `AgentClass` `AC-<code>` with `chassisType=ROVER`, plus `MobilityModel`, `EnergyModel` and `ContainerModel` built from the operator-entered spec | `robotSpecification.js:361-470`, `robot.service.js:339-390` |
| Capability profile | `CapabilityBundle` (incl. the `chassis_type` capability) linked from `AgentClass`. **Never from the robot.** A capability-shaped key in any robot payload is rejected. | `attestation.js:270`, `telemetry.handler.js:450` |
| Tenant | `Agent.tenantId` (column). Null → the provider fills in the deployment tenant (`DEMONSTRATION_TENANT_ID` in V1). | `agentFacts.service.js:176`, `coordinatorSolvePath.js:548` |
| Commissioning state | `Agent.lifecycleState` (`COMMISSIONED\|ACTIVE\|QUARANTINED\|MAINTENANCE\|DECOMMISSIONED`) | `schema.prisma:827,1294` |

What **must not** be identity: `socket.id`. It is used only for the `socket:{id}` reverse binding and the disconnect arbitration. The IP address is not identity either, and it is not read anywhere.

**Identity gaps.** These are data gaps, not schema gaps:

- `AgentClass.hardwareRevision` and `firmwareVersionSet` are null for a physical class. Only `simulatedClassDeclaration` fills them, so F5 is ABSENT. **OWNER** / control plane.
- F1 reads the provider fact `commissioning`, **not** `lifecycleState`. `lifecycleState @default(COMMISSIONED)` is a column default. It is not an attestation, and it must not be promoted into one.
- Commissioning a physical unit writes **no** `BatteryState`, **no** fitted `EnergyModelParams` β and no simulated declarations (`robot.service.js:~280`). That is correct and must stay so until real values exist.

---

## C. Backend telemetry contract

**Design rule: one event, one contract for both kinds.** The contract extends `TELEMETRY` with optional blocks. Today these ride through `passthrough()` and are ignored, so a Pi that sends them early is harmless. It adds no new event.

Tiers are cumulative.

### C.1 Required for connection

| Item | Type | Validation | Updates |
|---|---|---|---|
| Socket.IO v4 client, `/`, no `Origin`, no `Mozilla` UA | — | header heuristic | classification |
| `AUTH.robotId` | string | commissioned row | session binding |
| `AUTH.pairingCode` (first time) **or** `AUTH.token` | string | Redis match, 5 attempts then a 1 h lock | `session:{robotId}` |

### C.2 Required for availability (online, live, indexed)

| Field | Type | Units | Timestamp semantics | Validation | Freshness | Updates |
|---|---|---|---|---|---|---|
| `timestamp` | int | epoch ms, **agent clock**, NTP-disciplined | the instant the frame's measurements were taken | >0. PROPOSED: refuse when `timestamp > receivedAt + time.max_clock_skew` (D-C). | per-frame | `Observation.observedAt` |
| `sequence` | int ≥ 0 | ordinal | strictly increasing per robot and per boot epoch | `advancesSequence` | — | `Observation.sequence` |
| `status` | enum | `IDLE ACTIVE PAUSED ERROR ISSUES RETURNING CHARGING` | — | transition table, asymmetric health rule | — | `Robot.status` → F9 |
| `lat`, `lon` | number | WGS-84 decimal degrees | **only from a real fix** at `timestamp` | numeric, §23.5 kinematics | F16 budget 10 s | `Observation{kind:position}` → `AgentCellPosition` |
| `position.fixType` **PROPOSED** | enum | `NO_FIX\|2D\|3D\|RTK_FLOAT\|RTK_FIXED` | the fix instant | `NO_FIX` ⇒ `lat/lon` must be absent | — | gates the position write |
| `position.hAccM` **PROPOSED** | number | metres (1σ horizontal) | — | >0 | — | `Observation.uncertaintyRadiusM` |

HEARTBEAT and PROBE are covered in §D.

### C.3 Required for assignment

All of the following are PROPOSED blocks. Each is **omitted entirely when the hardware cannot measure it**. Sending `null` inside a block means "measured, value unknown", and the backend treats it as absent.

| Field | Type | Units | Validation | Budget | Updates → consumer |
|---|---|---|---|---|---|
| `safety.observedAtMs` | int | epoch ms, agent clock | ≤ `timestamp` | 10 s | Observation `emergency_stop` / `safety_state` |
| `safety.estop.present` | bool | — | must be `true` for `engaged` to be read | — | if `false`, **no** F7 observation is written |
| `safety.estop.engaged` | bool | — | only an explicit `false` clears (F7 reads "engaged unless `false`") | 10 s | → `emergencyStop{value, observedAt, source:"SENSOR"}` → **F7** |
| `safety.safetyStop` | `{active:bool, latched:bool, reason:str}` | — | from ESP32 `state`/`safety_stop` | 10 s | → `safetyRelevantObservations.safetyStop` (**F16**). `active` ⇒ a DEGRADED fault. |
| `safety.motorDriveAvailable` | bool | — | ESP32 boot/status | 10 s | `false` ⇒ a BLOCKING fault (F8) |
| `safety.commandTimeout` | bool | — | ESP32 `COMMAND_TIMEOUT` | — | diagnostic |
| `faults[]` | `{code:str, severity:"INFO"\|"DEGRADED"\|"BLOCKING"\|"CRITICAL", component:"PI"\|"ESP32"\|"LINK"\|"SENSOR"\|"CAMERA"\|"MOTOR"\|"GNSS"\|"POWER", active:bool, sinceMs:int}` | — | **the complete active set** every frame. `[]` means "no active faults, as measured". | 10 s | Observation `fault_set` → `faults` → **F8** |
| `localisation` | `{confidence:0..1, corroborations:[{kind:"INDEPENDENT_FIX"\|"MAP_MATCH"\|"ODOMETRY", available:bool, divergenceM:number}]}` | ratio, m | kinds exactly as F10's `CORROBORATOR` | 10 s | Observation `localisation` → **F10** |
| `battery` | number | **percent 0–100, a measured SoC only** | omit if not measured | PROPOSED SoC budget (**OWNER** value) | `BatteryState.lastObservedSoc` (existing row only) → §14 energy |
| `energy.socMethod` **PROPOSED** | enum | `BMS\|COULOMB_COUNTING\|VOLTAGE_CURVE_CALIBRATED` | **required** for a physical `battery` to be written (D-A) | — | gates the SoC write |

### C.4 Required for movement (after OFFER)

- Envelope admission: addressee, `notValidAfter`, signature when `COMMAND_SIGNING_KEY` is provisioned, per-commitment fence and floor, and sequence.
- `COMMAND_ACK{outboxId, fence, authorityEpoch}` for every admitted engine command.
- `OFFER_ACCEPT` / `OFFER_REJECT{reason}` / `OFFER_DEFER{until, reason}` before `offerExpiry` (20 s).
- `HEARTBEAT{commitmentId, fence}` while holding a mission. The lease is 60 s and is renewed after half has elapsed.
- `TELEMETRY` with real fixes at ≥ `VERIFY_TRACK_MIN_FIX_RATE` (10/min in V1) and no gap over `VERIFY_TRACK_MAX_GAP_SECONDS` (10 s in V1). Departure and arrival are **server-derived** from these fixes (`legProgress.service.js:174-225`).
- On `WITHDRAW`, `RECALL` or `ABORT_MISSION`: stop that mission and tombstone the commitment. On `COMMAND` or `STOP`: see the companion contract §7.

### C.5 Required for completion

- `CUSTODY_EVENT{commitmentId, fence, kind:"ACQUIRED"}` when the payload is physically loaded at pickup. `kind:"RELEASED"` at the drop. It is admitted only after server-verified arrival within `VERIFY_ARRIVAL_RADIUS_M` (25 m in V1).
- `TASK_COMPLETE{taskId: <OFFER.payload.taskId>, lat, lon, timestamp}` after the last stop. It is graded L1 against the track and the commanded corridor.

### C.6 Optional / future

`heading` (deg, not persisted), `speed` (m/s), `distanceTravelled` (m), `OBSTACLE_REPORT`, `energy.packVoltageV`, `energy.packCurrentA`, `energy.charging` (an agent assertion; see §F), `energy.packC`, `ambientC` (§14.2 thermal), `health.pi{cpuTempC, throttled, uptimeS, diskFreePct}`, `health.controller{linkUp, lastFrameAgeMs, firmware, state}`, `health.sensors{…}`, `health.camera{…}`, `dedupState` in AUTH (§11.5), mTLS `certificate`.

**Forbidden in every robot payload, at any depth:** any key matching `capabilit(y|ies)`, `certification(s)`, `attestedcapabilit(y|ies)`, `hazmatcertified`, `cold_chain`/`coldchain` or `clearance` (`attestation.js:270`). Matching is case- and punctuation-insensitive. A hit drops the **whole** frame and counts toward quarantine. Relevant because the ESP32 emits `front_clear_cm` and `rear_clear_mm`: those names are fine, but a Pi that renames one to `clearance` loses every frame.

---

## D. Heartbeat contract

### D.1 Five states

| State | Backend definition | How it is observed | Engine effect |
|---|---|---|---|
| **CONNECTED_SOCKET** | transport open, `socket.data.isAuthed` false | engine.io connected, no `AUTH` yet | nothing. Not online, not in `robots:all`. |
| **AUTHENTICATED_AGENT** | `AUTH` succeeded | `isOnline=true`, `socketId`, room joined | F13 `session.live=true`, but no heartbeat age yet |
| **LIVE_PROCESS** | app-level `HEARTBEAT` within `connectivity.max_heartbeat_age` (10 s) **and** a `PROBE_RESULT` within the same 10 s | registry `lastHeartbeat` (server clock); PROPOSED registry `lastProbeAckAt` (server clock) | F13 and F14 SATISFIED |
| **STALE** | authenticated, transport still open, no `HEARTBEAT` for >10 s | derived from registry age; no column | F13 VIOLATED, F14 VIOLATED → not a candidate; the dashboard should show STALE (PROPOSED) |
| **DISCONNECTED** | transport closed | `disconnect` handler | `isOnline=false`, `status=OFFLINE`, F13 VIOLATED |

Why the app `HEARTBEAT` is needed on top of the transport: Socket.IO ping/pong is answered by the client *library*. It proves the socket, not the RobotAgent process. The app-level `HEARTBEAT` must be emitted by the RobotAgent main loop, and **only while that loop is healthy**. It must not come from a detached timer thread.

### D.2 Event contract

| | Direction | Payload | Interval | Lease / timeout | Backend transition |
|---|---|---|---|---|---|
| `HEARTBEAT` (**EXISTS**) | robot → server | `{}`, or `{commitmentId, fence}` while holding a mission | **2 s** (rate-limit ceiling 10/5 s) | `connectivity.max_heartbeat_age` = **10 s** (PROVISIONAL, Safety) | `lastHeartbeat=serverNow`. Lease renewal when due. |
| `PROBE` (**PROPOSED emitter**) | server → robot | `{command:"PROBE", correlationId, issuedAtMs}`. Unsigned, unfenced (§10.3.1 row 3). | every **5 s** per LIVE robot (≤ budget/2) | answer expected within **2 s** | — |
| `PROBE_RESULT` (**PROPOSED listener**; reference client already sends it) | robot → server | `{command:"PROBE", correlationId, robotId, status, agentTimestamp}` | on each PROBE | matched by `correlationId` + the **same socket.id** | registry `lastProbeAckAt=serverNow` → F14 `session.lastHeartbeatAckAt` |

Both F14 timestamps are **server clock**. The proof is skew-free by construction.

### D.3 Reconnect behaviour

- On every `connect`, the robot re-emits `AUTH` with the persisted token.
- Listeners are registered **once per socket instance**, never per `connect` (Step 4 finding 1).
- A probe proof is bound to the `socket.id` it was answered on, so a reconnect starts with no F14 proof until the next PROBE. PROPOSED: clear `lastProbeAckAt` on AUTH.
- A mission survives a reconnect only through the lease. The robot resumes `HEARTBEAT{commitmentId, fence}` immediately after `AUTH_SUCCESS`.
- The token expires after 24 h offline. Re-pairing needs an operator-issued code.

---

## E. Normalized physical state

The backend-side record the physical provider reads. Nothing in it is defaulted. `undefined` means "no source", and the consuming predicate denies by name.

```
PhysicalRobotState {
  identity:     { robotId, agentId, agentRowId, agentClassId, chassisType, capabilityBundleId, tenantId, lifecycleState }
  availability: { socket: CONNECTED|AUTHENTICATED|LIVE|STALE|DISCONNECTED,
                  robotStatus,                       // Robot.status (7-value enum) + raw CHARGING/RETURNING in Redis
                  missionState: { commitmentId?, fence?, legState? },   // from Commitment/Leg rows
                  lastHeartbeatAt (server clock), lastProbeAckAt (server clock, PROPOSED) }
  position:     { lat, lon, observedAt (agent clock), receivedAt (server clock), source: AGENT_REPORT,
                  provenance: PHYSICAL, uncertaintyRadiusM?, fixType?, deadReckoned:false } | undefined
  energy:       { socFraction?, socObservedAt?, socMethod?, packVoltageV?, packCurrentA?,
                  charging: UNKNOWN (always, until a physical Charging Scheduler exists — B2) }
  safety:       { estop: { present, engaged, observedAt } | undefined,
                  safetyStop: { active, latched, reason, observedAt } | undefined,
                  motorDriveAvailable?, sensorFault?, motorFault?, controllerFault? }
  health:       { faults: [ { code, severity, component, active, sinceMs } ] | undefined,
                  pi?, esp32?, link?, sensors?, camera? }
  localisation: { confidence, corroborations[] } | undefined
  capabilities: from CapabilityBundle / MobilityModel / ContainerModel rows — never from telemetry
}
```

Storage: `position` **EXISTS**. `emergency_stop`, `safety_state`, `fault_set`, `localisation`, `soc` and `battery_electrical` would be new `Observation.kind` values (PROPOSED, no migration). `Observation.kind` is a free string (`schema.prisma:2113`), and §2.7's own doc lists `soc` and `localisation_confidence` as kinds (`observation.js:62`). All of them use `source: AGENT_REPORT`, except `estop.engaged`, which uses `SENSOR` only when it is read from a hardware circuit. The `provenance` label goes inside `value`, exactly as for position (Step 5).

---

## F. Stale data policy

| Signal | Budget (register) | Stale → backend behaviour | Engine outcome | Status |
|---|---|---|---|---|
| Heartbeat | `connectivity.max_heartbeat_age` 10 s | registry age > 10 s ⇒ STALE. Transport close ⇒ OFFLINE. | F13 VIOLATED | **EXISTS** (engine). Dashboard STALE: PROPOSED. |
| Round-trip proof | same 10 s | no PROBE_RESULT ⇒ no proof | F14 INDETERMINATE → deny | PROPOSED producer |
| Disconnected robot | transport ping ~45 s | `disconnect` ⇒ `isOnline=false` | F13 VIOLATED | EXISTS. **D-D**: with the engine on, no sweep backs this up. |
| Position | F16 uses `connectivity.max_heartbeat_age` | no new fix ⇒ the Observation ages. **Never** re-stamped, never carried forward: `fullState` fallbacks are never written as Observations (`telemetry.handler.js:818-823`). | F16 stale → deny. Index keeps `observedAtMs` (Step 5 fix). | EXISTS |
| Position with future `observedAt` | `time.max_clock_skew` 500 ms | PROPOSED: refuse the frame's Observation (CLOCK_AHEAD) | today: F16/F13 `ageMs<0` ⇒ INDETERMINATE (deny), but a skew below the frame's age passes silently (D-C) | PROPOSED |
| Safety / e-stop | 10 s | an old reading is **never** "not engaged". Absent ⇒ ABSENT. | F7 stale → deny. F16 → deny. | predicate EXISTS; producer PROPOSED |
| Faults | 10 s | a `fault_set` older than budget ⇒ `faults: undefined` (not `[]`) | F8 ABSENT → deny | PROPOSED |
| Localisation | 10 s | older than budget ⇒ `localisation: undefined` | F10 ABSENT → deny | PROPOSED (F10 checks no age itself, so the provider must) |
| Battery / SoC | **none exists** | today: `lastObservedSoc` is read at any age (**D-B**). Missing battery ⇒ nothing written; the old value stays and is read as current. | PROPOSED: add `soc` to `safetyRelevantObservations` with a budget ⇒ F16 denies stale SoC. **OWNER** must set the budget parameter. | gap |
| Health (Pi, ESP32, camera) | 10 s | enters only via `faults` | as faults | PROPOSED |
| Charging | — | always UNKNOWN for a physical agent ⇒ never indexed | index exclusion | EXISTS (`physicalProvider.js:124`, `chargingStatus.service.js:141-156`) |

A robot-reported `charging` flag is an *agent assertion*. It may **narrow** eligibility, never widen it (§23.5). `chargingStatus.service` deliberately ignores the agent's opinion, because the Charging Scheduler owns that fact.

---

## G. Physical provider mapping

`physicalProvider.js` + `agentFacts.service.js`. "Missing" is what happens when the source is absent. No row changes Assignment Engine semantics. Every field name is one the simulator already supplies, and the consumers are unchanged.

| Backend observation | Physical provider field | Assignment Engine consumer | Missing-data behaviour |
|---|---|---|---|
| `Robot.isOnline` | `session.live` | F13 | `false` ⇒ VIOLATED |
| max(registry `lastHeartbeat`, `Robot.lastSeenAt`, position `observedAt`), each ≤ asOf | `session.lastHeartbeatAt` | F13 | ABSENT ⇒ deny. **D-C**: the third term is the agent clock. PROPOSED: drop it for physical agents, or bound its skew. |
| registry `lastProbeAckAt` (PROPOSED) | `session.lastHeartbeatAckAt` | F14 | INDETERMINATE ⇒ deny (today, always) |
| `Command.executedAt` (legacy ACK) | `session.lastCommandRoundTripAt` (PROPOSED, optional) | F14 | — |
| — | `session.linkQuality`, `autonomousDeadZoneCertified` | F15 (class P) | ADMIT_WITH_PENALTY only if `cost.uncertainty_penalty` is resolved. **NOT CURRENTLY AVAILABLE.** |
| `Robot.status` via `HEALTH_TIER_BY_STATUS` | `healthTier` | F9 | null ⇒ ABSENT |
| latest `Observation{position}` | `safetyRelevantObservations.position` | F16, `cRisk` staleness | none ⇒ F16 ABSENT and no index entry |
| `AgentCellPosition` (index maintainer) | `lat/lon/cellId/observedAtMs` (column path, not provider) | candidate discovery, routing origin | not indexed ⇒ never a candidate |
| `Observation{emergency_stop}` (PROPOSED) | `emergencyStop{value, observedAt, source}` | F7 | ABSENT ⇒ deny |
| `Observation{safety_state}` (PROPOSED) | `safetyRelevantObservations.safetyStop` + a DEGRADED/BLOCKING entry in `faults` | F16, F8 | ABSENT ⇒ F16 deny |
| `Observation{fault_set}` (PROPOSED) | `faults[]` | F8 | `undefined` ⇒ ABSENT deny |
| `Observation{localisation}` (PROPOSED) | `localisation` | F10 | ABSENT ⇒ deny |
| `BatteryState.lastObservedSoc` (measured SoC only, D-A) | `soc` (column path) | `energy/usable`, F34, F35, wear | null ⇒ energy refuses |
| `Observation{soc}` (PROPOSED) | `safetyRelevantObservations.soc` | F16 | stale ⇒ deny |
| `ChargerReservation` | `reservations` | F18 | `[]` |
| (none — B2) | `chargingInScope → false` | index maintainer | never indexed |
| `Robot.massKg` | `vehicleMassKg` | §14.2 β_mass | null |
| telemetry `packC`/`ambientC` (future) | `environmentFor` | §14.2 thermal | null |
| operator-entered (see §M) | `commissioning`, `operatorHold`, `firmwareVersion(+Source)`, `calibrations`, `reliability`, `advisories`, `authorisedZoneIds`, `maintenance` | F1, F3, F5, F6, F11, F12, F27, F36 | ABSENT ⇒ deny (F11: penalty) |
| (none — B1) | `route` → `NOT_ROUTABLE`, `profileKeyFor → null` | routing | MISSING_HOP |

**Neutrality constraint on the PROPOSED rows.** Each new field is produced by one reader over `Observation` rows, and the reader ignores `provenance`. Otherwise it would be a second pipeline. The simulated path keeps `simulatedAgentState` until its own robot sends real blocks, so simulated outcomes cannot move.

---

## H. Missing hardware data

Checked read-only in `OneDrive/Documents/Arduino/robot_controller` (ESP32 core `2.0.14`, differential drive). The Pi repository is not on this machine, so Pi-side capability is **unknown** and nothing is assumed about it.

| Needed for | What exists on the rover | Status |
|---|---|---|
| F7 e-stop | No e-stop circuit confirmed (`ROVER_HARDWARE_ARCHITECTURE.md` Q26, Q31 open) | **NOT CURRENTLY AVAILABLE** |
| Safety-stop | ESP32 `state: SAFETY_STOP` + `safety_stop` latch, front HC-SR04 ×2, rear VL53L0X ToF via TCA9548A | available on the UART line (a proximity stop, **not** an e-stop) |
| Sensor / motor / controller fault | `SENSOR_FAULT`, `COMMAND_TIMEOUT`, `motor_drive_available`, `pca_status`, `tca_status`, `rear_health`, `front_*_health` | available on UART; the Pi must forward them |
| Position | NEO-9M GNSS on I2C 0x42, "not driven here" (`config.h:126`); no Pi path known | **NOT CURRENTLY AVAILABLE** |
| Localisation corroboration | 4 encoder inputs wired, "No encoder feature is implemented" (`config.h:100-103`) | **NOT CURRENTLY AVAILABLE** |
| Battery voltage / current / SoC | pack 5.0–7.2 V → XO4016 5 V → Pi; no ADC sense in firmware | **NOT CURRENTLY AVAILABLE** |
| Charging state | none | **NOT CURRENTLY AVAILABLE** (and not robot-authoritative anyway, §F) |
| Pi health, camera health | unknown (Pi repo not present) | UNKNOWN |
| Pack / ambient temperature | none | **NOT CURRENTLY AVAILABLE** |
| Link quality | none | **NOT CURRENTLY AVAILABLE** |

---

## I. Schema gaps and defects found

### I.1 Schema

See §M. Nothing is required for the telemetry-side contract.

### I.2 Defects and gaps found by this audit

None of these is fixed. Each is P2B work.

| ID | Finding | Evidence | Direction | Fires when |
|---|---|---|---|---|
| **D-A** | Any `battery` % becomes engine SoC, regardless of how it was obtained | `batteryObservation.service.js:38-55`, called for every agent at `telemetry.handler.js:846` | permissive | the moment a physical `BatteryState` row exists |
| **D-B** | No consumer checks SoC age. `lastObservedAt` is written and never read. | no reference in `src/engine`, `coordinatorSolvePath.js:623` | permissive | a physical robot reconnects without a fresh SoC |
| **D-C** | Agent-clock skew is unbounded at ingestion, and `observedAt` feeds liveness | `agentFacts.service.js:139-144`, `positionObservation.service.js:381`; `time.max_clock_skew` bounds only server hosts | permissive (a fast Pi clock makes stale look fresh) | invisible in simulation (same clock), live for any physical Pi |
| **D-D** | With the engine enabled, nothing marks a silent robot offline. The sweep stands down, and reconciler row 9 only reinserts into the index. | `socket.server.js:184-187`, `reconciler.js:572-601` | dashboard over-reports online. The engine is protected by F13. | half-open TCP up to the ping timeout |
| **G-1** | F14 has no producer: no server-initiated round trip, no `PROBE_RESULT` listener | §A.2, `agentFacts.service.js:69` | fail-closed | always (physical) |
| **G-2** | `ROBOT_FAULT` sets `ERROR` but never reaches F8 `faults`. There is no fault-clear event. | `dtaro.handler.js:315-409` | fail-closed | always |
| **G-3** | The legacy `COMMAND_ACK` does not check `Command.robotId` against the acknowledging socket, so any authenticated robot can ACK another robot's command | `command.handler.js:114-126` | integrity | a misbehaving client |
| **G-4** | A §23.5-refused TELEMETRY frame is dropped whole when enforced, so safety and fault blocks riding in it would be dropped too | `telemetry.handler.js:540` | fail-closed, but hides an engaged e-stop from the operator | once the blocks exist |
| **G-5** | No socket-level test for `CUSTODY_EVENT` or `ROBOT_FAULT` | test grep | coverage | — |

---

## J. Future Pi implementation contract

See [`docs/contracts/PHYSICAL_ROBOTX_BACKEND_CONTRACT.md`](docs/contracts/PHYSICAL_ROBOTX_BACKEND_CONTRACT.md). It is concise, normative, and written for the Rover/Pi Claude.

---

## K. Test plan (backend)

Every test below runs against the real handlers. Rows marked **live PG** also run on disposable PG 18.3 on port 55432+, because recent passes found join defects that only live execution exposes.

| # | Area | Test | Kind |
|---|---|---|---|
| 1 | Physical identity | Commissioning a `simulated=false` unit creates Robot + Agent (`agentId==robotId`) + `AC-<code>` class. No BatteryState, no EnergyModelParams, no simulated declaration. | live PG |
| 2 | Authentication | Pairing → token → reconnect with token. Wrong code ×5 ⇒ lock. Unknown robotId ⇒ disconnect. `Origin` header ⇒ `UNAUTHORIZED`. A capability key in AUTH is rejected. | socket.io real server |
| 3 | Heartbeat | `HEARTBEAT` sets registry `lastHeartbeat` to **server** time. `{commitmentId, fence}` renews the lease only when due, and only for the agent's own commitment. | unit + live PG |
| 4 | Heartbeat timeout | No HEARTBEAT for 10 s ⇒ F13 VIOLATED at `decisionTime`. PROBE unanswered ⇒ F14 INDETERMINATE. A PROBE_RESULT on a *different* socket.id is not proof. Transport close ⇒ OFFLINE. With the engine on, a half-open socket eventually goes offline (D-D regression). | fake clock + real server |
| 5 | Telemetry validation | No `timestamp` ⇒ no Observation. Future `timestamp` > skew ⇒ refused (D-C). A `clearance` key anywhere ⇒ whole frame dropped. `fixType: NO_FIX` + lat/lon ⇒ no position Observation. Numeric strings coerced. | unit |
| 6 | Stale telemetry | A position older than budget ⇒ F16 stale. The index `observedAtMs` never re-stamped. `fullState` fallback never written as an Observation. | unit + mutant |
| 7 | Safety state | Absent `safety` ⇒ `emergencyStop` undefined ⇒ F7 ABSENT. `estop.present:false` ⇒ no F7 observation. `engaged:"false"` (string) ⇒ engaged. Stale reading ⇒ F7 stale. `safety_stop` is **never** mapped to `emergencyStop` (structural test). | unit + structural |
| 8 | Position state | A physical fix ⇒ `value.provenance=PHYSICAL`, `source AGENT_REPORT`, `uncertaintyRadiusM` from `hAccM`. A §23.5-refused frame writes nothing. | live PG |
| 9 | Battery state | Physical `battery` without `socMethod` ⇒ nothing written (D-A). No physical BatteryState row is ever **created** from telemetry. A stale SoC ⇒ F16 deny once a budget is set (D-B). | unit + live PG |
| 10 | Provider mapping | Every §G row: a physical snapshot built from real Observation rows yields exactly those fields. A missing source yields `undefined`, never a default. | unit |
| 11 | Mixed fleet | Simulated + physical agents in one round. Physical refused by name at its first missing fact. Simulated outcomes unchanged. | `p1FleetProviderScenarios` + live PG |
| 12 | Simulation regression | Full suite (204/8,366 baseline), `runV1Assignment --scenario A\|B\|failures` all PASS, gates 7/1 unchanged | gate |
| 13 | Provenance neutrality | `simulationBoundary.test.js` pinned-read list unchanged. Label-swap twins produce identical verdicts, plan, Φ and γ. Planted provenance preferences in the new readers are killed by mutants. | structural + mutation |

---

## L. Exact files that would need implementation (P2B)

**Backend: modify**

| File | Change |
|---|---|
| `Backend/src/sockets/handlers/telemetry.handler.js` | Declare the `safety`, `faults`, `localisation`, `position`, `energy` blocks in the zod schema. Persist safety/fault blocks independently of the position trust verdict (G-4). Clock-skew refusal (D-C). |
| `Backend/src/services/positionObservation.service.js` | `fixType`/`hAccM` → `uncertaintyRadiusM`. Refuse `NO_FIX`. Skew bound. |
| `Backend/src/services/batteryObservation.service.js` | Require a declared measurement method for a physical agent (D-A). |
| `Backend/src/services/agentFacts.service.js` | Physical branch: read the new Observation kinds → `emergencyStop`, `faults`, `localisation`, `safetyRelevantObservations.{safetyStop,soc}`, `session.lastHeartbeatAckAt`. Drop the agent-clock term from `lastHeartbeatAt` for physical agents (D-C). |
| `Backend/src/sockets/handlers/robot.handler.js` | `PROBE_RESULT` listener (same-socket match). Clear the proof on AUTH. |
| `Backend/src/sockets/handlers/command.handler.js` | Robot ownership check on the legacy ACK (G-3). |
| `Backend/src/sockets/socket.server.js` or the reconciler | Offline detection with the engine on (D-D). |
| `Backend/src/engine/config/register/*.json` | Only if the owner approves: an SoC staleness budget parameter. |

**Backend: new**

| File | Purpose |
|---|---|
| `Backend/src/services/agentObservation.service.js` | One writer for the new Observation kinds (`emergency_stop`, `safety_state`, `fault_set`, `localisation`, `soc`), provenance-blind |
| `Backend/src/services/agentProbe.service.js` | Emits `PROBE` every 5 s to LIVE robots and records `lastProbeAckAt` |
| `Backend/tests/engine/physicalRobotContract.test.js`, `Backend/tools/verify/p2PhysicalContract.js` | §K |

**Not touched:** anything under `src/engine/**` (predicates, solver, ranking, commitment, settlement), `coordinatorSolvePath.js`, `physicalProvider.js`'s refusals of route, energy and charging, the simulator, the ESP32 firmware and the Pi.

---

## M. Is a schema change required?

**For P2A's contract (telemetry, heartbeat, safety, health, position, battery): NO.**

| Need | Existing model / field | New field? | Nullable | Affects V1 feasibility? |
|---|---|---|---|---|
| Identity, class, capability, tenant, lifecycle | `Robot`, `Agent`, `AgentClass`, `CapabilityBundle`, `Agent.tenantId`, `Agent.lifecycleState` | none | — | no |
| E-stop, safety-stop, faults, localisation, SoC freshness, electrical | `Observation(kind, value Json, observedAt, source, confidence, variance, sequence, deadReckoned, uncertaintyRadiusM)` | none; new `kind` values | — | no (simulated agents keep their own path) |
| GNSS accuracy | `Observation.uncertaintyRadiusM` | none | yes (exists) | no |
| Measured SoC | `BatteryState.lastObservedSoc/lastObservedAt` | none | yes (exists) | no |
| F14 proof | Redis registry (like `lastHeartbeat`) | none | — | no |
| Heading persistence | — | optional `Robot.heading Float?` | yes | no (display only; not needed) |

**One open decision (OWNER):** the operator-entered control-plane facts (F1, F3, F5, F6, F11, F12, F27, F36). None of them is telemetry, and the Pi does not supply them. There are two options.

- **Option 1: no migration.** `Observation` rows with `source: OPERATOR_ENTERED` and kinds `commissioning_attestation`, `operator_hold`, `firmware_attestation`, `calibration`, `maintenance`, `zone_authorisation`, `advisory`. This is legal under §2.7's closed source set. Its weakness: these are standing records with lifetimes, not point measurements.
- **Option 2: a dedicated table.** Proposed fields, all nullable except the keys:

  ```
  AgentControlRecord {
    id, agentId (FK Agent.id), kind (COMMISSIONING|HOLD|FIRMWARE|CALIBRATION|MAINTENANCE|ZONE_AUTHORISATION|ADVISORY),
    value Json, validFrom DateTime, validUntil DateTime?, recordedBy String (User.id),
    approvedBy String?, reason String?, supersedesId String?, createdAt
  }
  ```

  It is append-only and needs no change to V1 feasibility: simulated agents keep `simulatedAgentState`.

**Recommendation:** Option 2, because §22.3's two-person rule and the hold/maintenance lifetimes need `validUntil`/`approvedBy`. It is **not migrated**, and it is for separate review.

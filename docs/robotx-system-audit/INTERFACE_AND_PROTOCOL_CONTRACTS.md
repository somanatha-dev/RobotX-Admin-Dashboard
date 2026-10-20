# Interface and Protocol Contracts (as implemented)

Snapshot 2026-10-17. Every field below was read from producer **and** consumer source. "Status" uses the
[audit vocabulary](README.md#status-vocabulary-used-identically-in-every-document). Abbreviations:
**BE** = backend (`RobotX/Backend`), **PI** = Pi agent (`RobotX-Pi`), **FW** = ESP32 firmware
(`robot_controller`). The written specifications are the Pi's `docs/communication/ROBOT_BACKEND_PROTOCOL.md`,
the backend's `docs/contracts/ROBOTX_PI_P2B1_HANDOFF.md` and `PHYSICAL_ROBOTX_BACKEND_CONTRACT.md`, and the
firmware's `PROTOCOL.md`. Where they disagree with code, **code wins** in this document.

## 1. Backend ↔ Pi (Socket.IO)

### 1.1 Transport and connection

| Item | BE | PI | Match | Status |
|---|---|---|---|---|
| Library | socket.io 4.8 server | python-socketio 5.11.4 / python-engineio 4.14.0 (`requirements.txt:121-125`) | compatible (Engine.IO v4) | INTEGRATION-TESTED (Pi loopback against a python-socketio server; README reports Gate 3 against the real BE) |
| Namespace | default `/` | binding `namespace="/"` (`communication/protocol.py:165`); `ROBOTX_SOCKET_NAMESPACE` (default `/robot`) is **ignored** | yes (dead config on Pi) | IMPLEMENTED |
| Client identification | Origin or "Mozilla" UA = dashboard (`socket.server.js:217-247`) | `User-Agent: robotx-pi/2.2`, no Origin (`backend_link.py:382`) | yes | INTEGRATION-TESTED (`test_socketio_transport.py:342-359`) |
| Heartbeat | ping 10 s + timeout 5 s, ≤15 s enforced (`socketTiming.js:20-34`) | detection bound checked at connect, CRITICAL log if > 15 s (`backend_link.py:1959-1981`) | yes | IMPLEMENTED |
| Reconnect | — | own loop, backoff 1→60 s; 60 s after a credential verdict (`backend_link.py:264-270`) | — | UNIT-TESTED |
| TLS | per deployment | `ROBOTX_BACKEND_TLS_VERIFY` default on | — | UNVERIFIED (deployment) |
| mTLS | `AGENT_MTLS_REQUIRED=true` requires a client certificate | **not supported** | **mismatch if enabled** | — |

### 1.2 Authentication

| Field | Type | Req | Producer → consumer | Validation / behaviour | Source |
|---|---|---|---|---|---|
| `AUTH.robotId` | string | yes | PI → BE | must equal the commissioned `Robot.robotId` exactly | PI `protocol.py:713-741`; BE `robot.handler.js:731-760` |
| `AUTH.token` | string | one of | PI → BE | session token from AUTH_SUCCESS, preferred | same |
| `AUTH.pairingCode` | 6-digit string | one of | PI → BE | single use, 300 s TTL, lockout after failures | BE `robots.controller.js:34, 448-449` |
| `AUTH_SUCCESS` / `AUTH_OK` | `{robotId, token, dedup, session}` | — | BE → PI | both emitted; PI acts on the first and reads `token` (also accepts `sessionToken`/`robotToken`/`accessToken`, nested) | BE `robot.handler.js:1066-1068`; PI `protocol.py:756-786`, `backend_link.py:971-1013` |
| `AUTH_FAILED.reason` | `"INVALID_CREDENTIAL"` | — | BE → PI | only this reason discards the stored token | BE `robot.handler.js:680`; PI `backend_link.py:865-876, 1015-1077` |

Status: **INTEGRATION-TESTED** (Pi loopback; BE `pairingEnrollment.test.js`).

### 1.3 Engine envelope (OFFER, WITHDRAW, RECALL, ABORT_MISSION, …)

Event name = the command (`commandDispatcher.service.js:312`). The PI subscribes to all 14 names in
`ENGINE_COMMANDS` (`engine.py:57-64`).

| Field | Type | Req | PI validation | Failure behaviour (PI) |
|---|---|---|---|---|
| `outboxId` | string | yes | non-empty | not admitted (no ACK, no response) |
| `command` | string | yes | ∈ ENGINE_COMMANDS | not admitted |
| `agentId` | string | yes | == `ROBOTX_ROBOT_ID` (checked first) | not admitted |
| `commandClass`, `fenceScope` | any | signed | rendered into the canonical string | — |
| `commitmentId` | string | yes | non-empty | not admitted |
| `fence` | decimal string or non-negative int | yes | > `fenceFloor`, > highest applied | not admitted (STALE_FENCE / FENCE_AT_OR_BELOW_FLOOR) |
| `authorityEpoch` | int | signed | echoed in COMMAND_ACK | — |
| `fenceFloor` | int/string/null | optional | parsed | not admitted if malformed |
| `sequence` | int ≥ 0 | yes | 0 first, then contiguous; duplicate is ignored; a gap is held (≤16 held) | not admitted / held |
| `notValidAfter` | ISO-8601 with zone | yes | must be in the future (Pi wall clock) | not admitted |
| `signature` | lower-case hex HMAC-SHA256 | yes | over the `\u001f`-joined `field=value` of the 11 signed fields, key = UTF-8 bytes of `COMMAND_SIGNING_KEY` (≥32 bytes) | not admitted; **no key means nothing admitted** |
| `payload` | object/null | per command | — | — |

Source: PI `engine.py:66-73, 182-356`, `backend_link.py:1433-1512`. **Cross-repo verification today:** the
PI's `canonical_string` and `sign` reproduced the BE fixture
`docs/contracts/fixtures/offer-signature-test-vector.json` exactly (canonical length 1203, signature equal,
`verify_signature` admits). **INTEGRATION-TESTED (cross-implementation vector).**

### 1.4 OFFER payload

| Field | Type | Req | PI rule | Source |
|---|---|---|---|---|
| `commitmentId` | string | yes | must equal the envelope's | `engine.py:451-452` |
| `fence` | as envelope | yes | must equal the envelope's | `engine.py:453-454` |
| `taskId` | string/null | **required for execution** | null → `UNSUPPORTED_MISSION` | `engine.py:456-458, 506-512` |
| `legId` | any | no | stored only | `engine.py:487` |
| `stopSequence[]` | array | yes | each `{sequence:int, lat:num, lon:num, path?:[{lat,lon}], stopType?}`; sorted by `sequence`; **exactly 2 stops**, both with a path | `engine.py:460-492, 495-521`; `agent.py:506-511` |
| `offerExpiry` | ISO | no | past → no response | `backend_link.py:1568-1571` |

Coordinates are WGS84 degrees (`lat`, `lon` only; `lng` is not accepted). The path for stop 0 leads to the
pickup and the path for stop 1 to the drop. `stopType` is **not interpreted** (`engine.py:500-504`). The
backend's stop-type vocabulary is UNVERIFIED by this audit.

### 1.5 Pi → BE responses

| Event | Payload | When | BE consumer | Status |
|---|---|---|---|---|
| `COMMAND_ACK` (engine) | `{outboxId, fence (as received), authorityEpoch?}` | every admitted envelope, after persisting marks | `command.handler.js:211` | INTEGRATION-TESTED |
| `OFFER_ACCEPT` | `{commitmentId, fence}` | feasible + mission assigned | `offer.handler.js:513` | INTEGRATION-TESTED |
| `OFFER_REJECT` | `{commitmentId, fence, reason}` | reasons: `NO_EXECUTABLE_PATH`, `UNSUPPORTED_MISSION: …`, `ESTOP_LATCHED`, `AGENT_ERROR`, `MISSION_IN_PROGRESS`, `NO_MOTOR_LINK`, `NO_POSITION_FIX`, `NO_CUSTODY_SENSING`, `MISSION_REFUSED: …` | `offer.handler.js:527` | UNIT-TESTED |
| `OFFER_DEFER` | `{commitmentId, fence, until (epoch ms number or ISO), reason}` | **never produced** by `assess_offer` | `offer.handler.js:564` | IMPLEMENTED (encoder only) |
| `CUSTODY_EVENT` | `{commitmentId, fence, kind: ACQUIRED|RELEASED}` | after operator confirmation at a measured arrival | `offer.handler.js:498` → `legProgress.onCustodyReport` | INTEGRATION-TESTED (software) |
| `TASK_COMPLETE` | `{taskId, lat, lon}` (last measured fix sent) | mission COMPLETE, RELEASED reported, both arrivals measured, PI L1 self-check passes | `dtaro.handler.js:153` | INTEGRATION-TESTED (software, per README Gate 3b) |

Responses are persisted before they are emitted and resent once per authenticated session (Y2)
(`backend_link.py:1600-1625, 1848-1945`).

### 1.6 Operator commands

| Event | Payload | PI behaviour | Source |
|---|---|---|---|
| `COMMAND` | `{commandId, type: STOP|PAUSE|RETURN|RESUME, timestamp (epoch ms), commitmentId? (RESUME)}` | applied, then `COMMAND_ACK {commandId}`. A refused or failed command is **not** acked (BE marks it FAILED after redeliveries). Older than 120 s → rejected. RESUME naming a different live commitment → refused | BE `commandDispatcher.service.js:156-160`; PI `backend_link.py:1285-1366`, `commands.py:220-259` |
| `STOP` (bare) | `{taskId?, reason?, timestamp}` | always obeyed (unless it names another robot), never acked | BE `:173-175`; PI `protocol.py:1108-1151` |
| `TASK_ASSIGN` | `{taskId, pickup, drop, pathToPickup, pathToDrop, timestamp}` | parsed and logged; **never starts a mission** | BE `:125-127`; PI `backend_link.py:1398-1429` |
| `PROBE` | `{command, correlationId, issuedAtMs}` | `PROBE_RESULT {command:"PROBE", correlationId, robotId, status}` if authenticated and the agent loop is alive | BE `agentProbe.service.js:201`; PI `backend_link.py:1641-1667` |
| `TASK_COMPLETE_ACK` | `{taskId, verifying?, alreadyCompleted?, reason?, timestamp}` | settles the persisted claim; never retried | PI `backend_link.py:1669-1703` |

### 1.7 HEARTBEAT

`{}` when idle; `{commitmentId, fence}` while a held, non-aborted, custody-required mission matches the held
commitment. Every 2 s (≤2 s enforced), suppressed when the agent loop has stalled for more than 5 s.
BE renews the 60 s lease from the commitment form (`robot.handler.js:1139-1151`). PI
`backend_link.py:1170-1209`, `protocol.py:479-494`. Status: IMPLEMENTED, UNIT-TESTED.

### 1.8 Pi → backend TELEMETRY

Produced by `build_telemetry_payload` (`communication/protocol.py:406-476`), every 1 s.

| Field | Type / unit | Req | When present | BE consumer / rule |
|---|---|---|---|---|
| `sequence` | int, strictly increasing per link | always | — | `telemetry.handler.js:454`, `positionObservation.sequenceFrom` |
| `status` | `IDLE`/`ACTIVE`/`PAUSED`/`ERROR` (STOPPED → `IDLE`) | always | — | allowed set `telemetry.handler.js:305-315` |
| `timestamp` | epoch **ms**, measurement instant (fix time, or now when no fix) | always | — | agent-measured time, never re-stamped |
| `lat`, `lon` | degrees (7 dp) | optional | only a **fresh (≤5 s), measured, not-yet-sent** fix | position Observation |
| `speed` | m/s | optional | with lat/lon if the receiver gave speed | `numOpt` |
| `position.fixType` | `"2D"`/`"3D"` | optional | only if both fixType and hAcc are known (u-blox fixType 4 → omitted) | `FIX_TYPES` (`positionObservation.service.js:180`) |
| `position.hAccM` | metres | optional | same | must be > 0 |
| `safety.stopLatch` | `{engaged, components:{piEmergencyStop, esp32SafetyStop}}` | optional | only while ESP32 TELEMETRY is ≤1 s old | physical F7 input (`stopLatchObservation.service.js`) |
| `battery`, `heading`, `distanceTravelled` | — | **never sent** | no sensor | backend uses the operator SoC declaration |

`position.deadReckoned` is never sent, because dead-reckoned poses never leave the Pi. Status:
UNIT-TESTED (PI and BE), INTEGRATION-TESTED in software.

## 2. Pi ↔ ESP32 UART contract

### 2.1 Physical layer and framing

| Item | FW | PI | Status |
|---|---|---|---|
| Device | UART0 at 115200 8N1 (`config.h:826`) | `/dev/ttyAMA0`, aliases refused, exclusive + `TIOCEXCL` (`transport.py:26-59`) | IMPLEMENTED; wiring per prior reports, UNVERIFIED today |
| Frame | `{json}*XXXX\n`, CRC-16/CCITT-FALSE over the JSON bytes, upper-case hex | same; inbound accepts either case (`protocol.py:109`) | INTEGRATION-TESTED (host simulator) |
| Command line max | 160 bytes (`config.h:832`) | encoder enforces ≤160 (`protocol.py:316-317`) | INTEGRATION-TESTED |
| Inbound line max | TX frame buffer 2560 (`config.h:839`) | 4096 bound (`protocol.py:46`) | — |
| Resync | lone `\n` clears a partial line | PI sends `\n` on every (re)open (`link.py:861-863`) | IMPLEMENTED |
| Boot noise | ROM text before READY | first line after open counted `partial_on_open`, non-frames `NOT_A_FRAME` | INTEGRATION-TESTED |
| Protocol version | `PROTO_VERSION 2` in READY, PING ACK, DIAG SYSTEM | expects 2; mismatch → DEGRADED, no PING proof (`link.py:574-580`) | INTEGRATION-TESTED |

### 2.2 Commands (PI → FW)

Envelope `{"type":"COMMAND","seq":1..65535,"cmd":…}`, built by hand, integers only.

| cmd | Fields | Units | FW effect | PI use |
|---|---|---|---|---|
| `PING` | — | — | ACK `{state, uptime_ms, proto}`; does not refresh the watchdog | once per connection to prove TX/RX; retried every 5 s while unanswered |
| `STOP` | — | — | zero desired, motors stop, refresh watchdog, clear `command_timeout`; does **not** clear `safety_stop` | every tick when the gated intent is a stop/hold, or a DRIVE is not carryable |
| `DRIVE` | `left`, `right` ∈ −255..255 | normalized × 255 (round half away); FW deadband 40 | gate, apply, ACK ACCEPTED or GATED; a clean DRIVE clears `safety_stop` | every tick while AUTO and motion-ready |
| `RESET` | — | — | stop, clear `safety_stop` + `command_timeout`; does not refresh the watchdog | operator only, once |
| `MOVE`, `MOTORTEST`, diagnostics | — | — | supported by FW | **never sent** by PI (not encodable) |

MotionIntent mapping: `left`/`right` = `to_drive_units(intent.left/right)` (`link.py:81-89, 844-848`).
`FORWARD` with steer reduces the inner side; `TURN_LEFT/RIGHT` are pivots (−s, +s). There is no
steering field.

### 2.3 Responses

| Type | Required fields (PI) | FW producer | Notes |
|---|---|---|---|
| `ACK` | `seq:int`, `cmd:str`, `result ∈ {ACCEPTED, GATED, REJECTED, DUPLICATE}`, `reason:str` | `ackBegin`, `ackMotion` (`comm.cpp:298-330, 595-602`) | motion ACKs also carry `req_*`, `gated_*`, `applied_*` (ignored by PI); STALE_SEQ carries `last_seq` (used to resync) |
| `ERROR` | `seq:int|null`, `reason:str` | `emitError` (`comm.cpp:260-296`), rate-limited 10/s | — |
| `EVENT` | `event:str`, `seq:int|null`; `uptime_ms` optional | READY, COMMAND_TIMEOUT, MOTORTEST_DONE, I2CSCAN | `uptime_ms` optional because I2CSCAN omits it (`protocol.py:139-143`) |

Timeouts: ACK expected within 0.5 s. Three consecutive misses → DEGRADED. At most 8 pending. A motion
command is never retried. A command older than 0.3 s when the I/O thread reaches it is dropped (`link.py:93-111`).

### 2.4 TELEMETRY (FW → PI, every 200 ms)

Producer `sendFastTelemetry` (`comm.cpp:1634-1681`); consumer schema `protocol.py:136-174`, model
`state.py:49-109`.

| Field | Type / unit | Req (PI) | FW semantics | PI use |
|---|---|---|---|---|
| `uptime_ms` | int ms | yes | `millis()` | reboot detection (backwards) |
| `state` | string | yes | `MOTOR_TEST`, `DRIVE_UNAVAILABLE`, `COMMAND_TIMEOUT`, `SAFETY_STOP`, `SENSOR_FAULT`, `IDLE`, motion states | display |
| `block_reason` | string | yes | `NONE`, `MOTOR_PWM_UNAVAILABLE`, `FRONT_OBSTACLE`, `FRONT_SENSOR_FAULT`, `REAR_OBSTACLE`, `REAR_SENSOR_FAULT`, `REAR_UNCONFIGURED`, `BLOCKED` | health text |
| `last_seq` | int or null | yes (nullable) | last accepted seq | sequence resync |
| `last_reject` | string | yes | last reject reason | — |
| `left_cmd`, `right_cmd` | int −255..255 | yes | stored desired command | — |
| `left_applied`, `right_applied` | int | yes | after gate, clamp, deadband; 0 without PCA | — |
| `front_left_cm`, `front_right_cm` | float cm (1 dp) or null | yes (nullable) | **filtered median; can be non-null while invalid** (fresh but < 3 good samples); side labels unverified | **not used** for decisions |
| `front_valid` | bool | yes | `!safetySensorFault()` (both sensors valid) | `false` → DRIVE refused, mission paused |
| `front_obstacle` | bool | yes | latched hysteresis (either sensor) | **not used** |
| `front_warning` | bool | optional | ≤ 90 cm | not used |
| `rear_mm` | array of 3 int mm or null | yes | index = TCA channel; filtered, can be non-null while invalid | **not used** |
| `rear_available`, `rear_obstacle`, `rear_sensor_fault` | bool | optional | rear backend up; any rear latch; any sensor invalid | `rear_sensor_fault` in health text only |
| `forward_blocked`, `reverse_blocked` | bool | yes | gate inputs | **not used** |
| `safety_stop` | bool | yes | **latched** | `true` → DRIVE refused, mission paused |
| `command_age_ms` | int ms | yes | since the last movement command | — |
| `command_timeout` | bool | yes | watchdog latched | `true` → DRIVE refused |
| `motor_drive_available` | bool | yes | PCA9685 ready | `false` → DRIVE refused |

Status: field-for-field match **INTEGRATION-TESTED** (simulator link test 6/6 and `test_gate3_contract`).
Real-hardware frames: the PI decoder notes frames captured on the Pi on 2026-09-25 (`protocol.py:140-142`),
**not re-observed today**.

### 2.5 GPS frame (FW → PI, every 1000 ms)

Producer `gpsWriteFrameFields` (`gps.cpp:343-387`) + `uptime_ms` (`comm.cpp:1833-1839`); consumer
`protocol.py:157-174` (schema) and `localization/esp32_gps.py:57-124` (semantics).

| Field | FW type / unit | Null when | PI expects | PI rule | Match |
|---|---|---|---|---|---|
| `gps_status` | `NOT_STARTED`/`BACKOFF`/`NOT_DETECTED`/`STALE`/`NO_FIX`/`OK` | never | required string in that set | ≠ OK → NO_FIX | **yes** |
| `uptime_ms` | int | never | required int | — | yes |
| `fix_type` | u-blox 0–5 | no PVT ever | int or null | ∈ {2,3,4}; 2→"2D", 3→"3D", 4→no fixType | yes |
| `fix_ok` | bool (`gnssFixOK`) | no PVT ever | bool or null | must be `true` | **yes** |
| `siv` | int | no PVT ever | int or null | satellites | yes |
| `lat_e7`, `lon_e7` | int, degrees × 1e7 | status ≠ OK | int or null | range check, not (0,0) | yes |
| `hacc_mm` | int mm | status ≠ OK | int or null | must be > 0; → `h_acc_m` | **yes** |
| `speed_mm_s` | int mm/s | status ≠ OK | int or null | → m/s | yes |
| `head_mot_e5` | int, degrees × 1e5 | status ≠ OK | int or null | → track; used only at ≥ 0.5 m/s | yes |
| `age_ms` | int ms since the ESP32 received the PVT | no PVT ever | int or null | must be ≥ 0; age = Pi monotonic since parse + age_ms; > 5 s → STALE | **yes** (see note) |
| `alt_msl_mm`, `vacc_mm`, `pdop_e2`, `itow_ms` | int | status ≠ OK / no PVT | not declared | ignored | harmless |
| `polls`, `pvt_ok`, `poll_timeouts`, `bus_errors`, `ff_chunks`, `max_service_us`, `latency_ms` | int | never | not declared | ignored (diagnostics) | harmless |

Notes and residual risks:

- `fix_ok`, fix type, coordinates, `age_ms` and horizontal accuracy are **present on both sides with the same names and units**. FW sets `OK` only when `fixOk && 2 ≤ fixType ≤ 4 && fresh(<3 s)` (`gps.cpp:275-294`). The PI re-checks all of them independently.
- `age_ms` counts from the moment the ESP32 *parsed* the PVT, not from the receiver's fix epoch. Poll latency (up to 500 ms, reported as `latency_ms`) is not included, so the PI's fix timestamp can be up to about 0.5 s too recent. Minor.
- Staleness thresholds differ: FW reports STALE at ≥3 s without a new PVT; the PI declares STALE at > 5 s total age. The FW nulls the coordinates at 3 s, so the PI sees NO_FIX first. Consistent.
- The ESP32 does not use GPS for anything (reporting only).
- Status: **UNIT-TESTED** (PI `test_esp32_gps_path.py`, FW `test_gps.cpp`, both passed today). The unit test that would use a **real captured GPS frame skipped**. Hardware behaviour is **UNVERIFIED**.

### 2.6 DIAG and EVENT

DIAG `section ∈ {FRONT, REAR, SYSTEM}` + `uptime_ms` are required; all other keys are stored verbatim
(`link.py:469-474`) and surfaced in `/state` (`controller_diag`). REAR includes `rear_reinit_count[3]`,
`rear_reinit_result[3]`, `rear_bus_err_*[3]` (`comm.cpp:1706-1784`). These are the fields needed to confirm
RX-01.

### 2.7 Link loss and staleness

| Condition | FW | PI |
|---|---|---|
| PI stops sending movement commands | after 2000 ms: motors 0, `command_timeout`, EVENT COMMAND_TIMEOUT | — |
| FW stops sending TELEMETRY | — | after 1.0 s: STALE → no DRIVE (STOP still sent if the link allows it); AUTO paused |
| UART read/write error | — | DISCONNECTED; reopen after 1 s, backoff to 10 s; all pending and motion slots dropped |
| FW reboot | READY, uptime resets | reboot latched → e-stop latch (operator clear + new PING) |
| PI restart | — | seq resynced from TELEMETRY `last_seq`; first line discarded |

## 3. Mismatch register

| ID | Interface | Mismatch | Impact | Status |
|---|---|---|---|---|
| CM-01 | BE→PI | `REROUTE_ALERT` emitted to the robot room (`alertDissemination.service.js:101`); PI has no binding → `backend.unexpected_event` | reroutes never reach the Pi | Confirmed (source) |
| CM-02 | BE→PI | Engine `REROUTE`/`RESEQUENCE`/`RESUME`/… envelopes are ACKed with **no effect** on the PI (`engine.py:59-63`) | engine-level reroute and resume are no-ops | Confirmed (source) |
| CM-03 | PI→BE | BE listens for `OBSTACLE_REPORT` and `ROBOT_FAULT`; PI never emits them | ESP32 obstacles and faults are invisible to the backend except via the stop latch and status | Confirmed (source) |
| CM-04 | BE→PI | `SESSION_REKEY` (and `SESSION_REKEY_ACK`) exist only for mTLS sessions; PI has no handler and no mTLS | latent: enabling `AGENT_MTLS_REQUIRED` locks the Pi out | Confirmed (source) |
| CM-05 | BE→PI | `TASK_ASSIGN` still emitted by the recovery sweep; PI ignores it by design | none if OFFER is the only path | By design |
| CM-06 | PI capability | `agent_capabilities().motion = False` "ESP32 link does not exist" (`protocol.py:689-691`) | stale; sent only on the unbound `register` channel | Inert |
| CM-07 | PI↔FW docs | PI repo `PROTOCOL.md` lacks the GPS section (§11) and newer DIAG REAR fields that the FW repo copy has; PI `protocol.py` cites "PROTOCOL.md section 11" | contributors read an out-of-date spec | Confirmed (diff) |
| CM-08 | PI↔FW tests | PI root `test_link.py` (810 lines) predates `SAFETY_CLEAR_COMMAND_ON_BLOCK`; FW `tests/test_link.py` (1000 lines) is current; `rover_link.py` identical | the PI copy would fail against current FW | Confirmed (diff) |
| CM-09 | PI↔FW semantics | FW `safety_stop` is cleared only by RESET or a clean DRIVE; PI never sends DRIVE while it is set | no autonomous recovery from any ESP32 gate event | Confirmed + INTEGRATION-TESTED |
| CM-10 | FW→PI | FW range and obstacle fields are transmitted but unused by PI navigation and safety | no sensor-informed planning | Confirmed (grep) |
| CM-11 | PI↔BE thresholds | PI `evidence.py:24-29` hard-codes the completion thresholds; BE reads them from env with no default | silent drift if the deployment changes the env | Risk |
| CM-12 | PI config | `ROBOTX_SOCKET_NAMESPACE` default `/robot` is ignored (binding uses `/`) | confusing config | Dead config |

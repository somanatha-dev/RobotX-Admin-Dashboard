# Raspberry Pi Agent — Deep Dive

Repository A: `C:\Users\soman\OneDrive\Desktop\RobotX-Pi` · branch `integration/robotx-pi-autonomy` ·
commit `c58f124` · Python (3.11/3.13 per `requirements.txt` comments). All paths are relative to the
repository root. Status vocabulary: [README](README.md#status-vocabulary-used-identically-in-every-document).

## 1. Module map

| Package | Files | Role | Runtime use |
|---|---|---|---|
| `robotx/application` | `main.py`, `agent.py`, `__main__.py` | FastAPI local API; `RobotAgent` lifecycle and 10 Hz loop | Entry point |
| `robotx/config` | `settings.py`, `logging_setup.py` | All `ROBOTX_*` env parsing (`Settings.from_env`), structured logging | Yes |
| `robotx/esp32` | `link.py`, `protocol.py`, `state.py`, `transport.py`, `sim_transport.py` | UART protocol v2 codec, sole UART owner, host-simulator transport | Yes when `ROBOTX_ESP32_ENABLED=1` |
| `robotx/localization` | `esp32_gps.py`, `position.py`, `local_frame.py` | ESP32 GPS adapter, position + heading estimate, optional dead reckoning | Yes |
| `robotx/hardware` | `gps.py` (NMEA), `camera.py`, `battery.py`, plus `motors.py`, `ultrasonic.py`, `encoders.py`, `ir.py` | Pi-attached hardware | `gps.py` (pi_serial only), `camera.py`, `battery.py` (stub). The motor/ultrasonic/encoder/IR drivers are **bench only**, not imported by the agent |
| `robotx/perception` | `pipeline.py`, `object_detector.py`, `types.py`; `object_tracker.py`, `temporal_filter.py`, `experimental/*` | Detector thread and result types | Tracker, temporal filter and `experimental/` are **not used by the agent** (imported only by `experimental/vision_controller.py`) |
| `robotx/navigation` | `navigator.py`, `route_planner.py`, `directions_client.py` | Waypoint progress, heading error, reroute counters | `directions_client.py` (Google Directions) is **never instantiated** |
| `robotx/control` | `decision.py`, `motion.py`, `safety.py` | Decision policy, `MotionIntent`, Pi safety gate | Yes |
| `robotx/mission` | `mission.py`, `manager.py`, `evidence.py` | Mission model/validation, leg progression, completion evidence self-check | Yes |
| `robotx/communication` | `backend_link.py`, `protocol.py`, `engine.py`, `commands.py`, `commitment_store.py`, `token_store.py`, `commissioning.py` | Socket.IO client, wire payloads, signed engine envelopes, operator commands, persistence | Yes when `ROBOTX_SOCKET_ENABLED=1` |
| `robotx/state` | `robot_state.py`, `telemetry.py` | Single authoritative snapshot, local telemetry | Yes |
| `robotx/diagnostics` | `health.py` | Host metrics and component health | Yes |
| root | `rover_link.py`, `test_link.py` | Reference ESP32 protocol implementation and link test (open a real UART when given `--port`) | Bench only |

## 2. Startup sequence and entry points

- **Only supported launch:** `venv/bin/python -m robotx.application` → `main.run()` → `uvicorn.run(app, host=ROBOTX_API_HOST, port=ROBOTX_API_PORT)` (`application/main.py:378-400`). A non-loopback host logs `api.network_exposed`.
- FastAPI lifespan builds `RobotAgent(SETTINGS)` and `await agent.start()`; a start failure stops whatever started and re-raises (`main.py:62-86`).
- `RobotAgent.start()` (`agent.py:189-231`): logging → camera → perception → **ESP32 link before GPS** (so GPS cannot claim the ESP32 UART) → GPS → state DISABLED placeholders → mode IDLE → create loop task → backend link last and non-blocking.
- systemd template `deployment/robotx-agent.service`: user `robotx`, groups `dialout video`, `WorkingDirectory=/opt/robotx/RobotX-Pi`, `EnvironmentFile=/etc/robotx/robotx-agent.env` plus optional `/etc/robotx/pairing.env`, `Restart=on-failure` with 5 s → 300 s backoff, `TimeoutStopSec=15`, `StateDirectory=robotx` (`/var/lib/robotx`). Whether it is installed on the Pi is **UNVERIFIED** (no SSH).
- Shutdown (`agent.py:268-309`): backend link closed first → loop cancelled → ESP32 link stopped (final `STOP` if motion was sent on a bidirectional, non-rebooted link, `link.py:305-330`) → perception, GPS, camera.

## 3. Configuration

All variables are parsed in `robotx/config/settings.py:395-545`. Secrets are reported only as SET/UNSET by
`public_summary()` (`settings.py:547-560`, secret set = `robot_token`, `pairing_code`,
`google_maps_api_key`, `command_signing_key`). `.env.example` (384 lines) exists as a safe template.

Safety-relevant defaults:

| Variable | Default | Meaning / finding |
|---|---|---|
| `ROBOTX_ESP32_ENABLED` | `0` | No UART link |
| `ROBOTX_ESP32_MOTION_ENABLED` | `0` | No `STOP`/`DRIVE` ever written; the V1 deployment template also sets `0` |
| `ROBOTX_ESP32_PORT` | `/dev/ttyAMA0` | `/dev/serial0` and `/dev/serial1` refused (`link.py:70, 114-118`) |
| `ROBOTX_GPS_SOURCE` | `pi_serial` | Must be `esp32` on the V1 rover. With `pi_serial` and the same port as the ESP32, GPS refuses to start (`agent.py:354-369`) |
| `ROBOTX_NAV_MAX_H_ACC_M` | `5.0` | Fix accuracy gate, must be finite > 0 (`settings.py:93-99`) |
| `ROBOTX_NAV_WAYPOINT_ARRIVAL_M` | `8.0` | Waypoint and destination arrival radius |
| `ROBOTX_SAFETY_REQUIRE_RANGE_SENSOR` | `0` | Pi gate never requires a range sensor (and none is ever passed) |
| `ROBOTX_CUSTODY_CONFIRMATION` | `none` | With `none` every OFFER is rejected `NO_CUSTODY_SENSING` |
| `ROBOTX_SOCKET_ENABLED` | `0` | Backend link off |
| `ROBOTX_BACKEND_LOSS_POLICY` / `_GRACE_S` | `pause` / `10` | `continue` or grace > 10 s refused when the link is enabled (`backend_link.py:180-197`) |
| `ROBOTX_DEADRECKON_ENABLED` | `0` | Open-loop dead reckoning; placeholders "CALIBRATE THESE" (`settings.py:260-264`) |

**Dead configuration** (parsed but never read by runtime code): `ROBOTX_SOCKET_NAMESPACE` (default
`/robot`; the binding namespace is `/`, `communication/protocol.py:165`), `ROBOTX_SOCKET_RECONNECT`,
`ROBOTX_NAV_TARGET_SPEED_MPS`, `ROBOTX_GOOGLE_MAPS_API_KEY` / `ROBOTX_DIRECTIONS_*` (the client is never
built), and the motor, encoder, ultrasonic and IR pin settings (bench scripts only). Found by grep over
`robotx/`.

## 4. The agent loop (`agent.py:809-948`)

Period `1/agent_hz` = 100 ms. Each tick:

1. **GPS → position.** `gps.get_reading()` → `PositionEstimator.update()` → dead-reckoned pose only if GPS gave nothing and DR is enabled (`agent.py:815-830`).
2. **Power.** `battery_status()` always returns nulls (`hardware/battery.py:27-33`).
3. **ESP32 status.** `_update_esp32()` copies link status, controller telemetry and DIAG into state. A newly detected reboot engages the e-stop latch (`agent.py:398-419`). If motion is enabled and the mission is AUTO but the link is not `motion_ready`, the mission is **paused** (`agent.py:843-856`).
4. **Backend loss policy** (`agent.py:862-863`).
5. **Navigation** → `MissionManager.update` (`agent.py:866-875, 950-969`).
6. **Perception** latest result (computed on its own thread at `detection_hz` = 2 Hz).
7. **Decision** → proposed `MotionIntent` (`agent.py:886-891`).
8. **Safety gate** → gated intent, called **without** an `obstacle` range reading (`agent.py:901-905`).
9. **ESP32 submit** of the `SafetyDecision` (`agent.py:912-913`).
10. Dead-reckoner integration with the gated intent; **heading invalidated** when `left*right < 0` (pivot) (`agent.py:921-928`).
11. **Blocked feedback:** if AUTO and the gated intent is a stop whose reason contains `"obstacle"`, `navigator.report_blocked()` (`agent.py:933-934`).
12. Health every 2 s, local telemetry every 1.5 s.

An exception in a tick sets mode ERROR and a stop intent; the loop continues (`agent.py:794-804`).
`is_alive()` (tick within 5 s, `agent.py:768-780`) gates the backend heartbeat and PROBE answers.

## 5. ESP32 link (`robotx/esp32/`)

- **Ownership.** One I/O thread opens, reads, writes and closes the port (`link.py:1-30`). `open_serial` uses `exclusive=True` plus `TIOCEXCL`, so a second opener is refused by the kernel (root excepted) (`transport.py:26-59`). **IMPLEMENTED, UNIT-TESTED.**
- **Framing / decode.** CRC-16/CCITT-FALSE, `{json}*XXXX\n`, printable ASCII, duplicate keys/NaN refused, 4096-byte inbound bound, per-type required/optional schema (`protocol.py:63-263`). Inbound types: ACK, ERROR, EVENT, TELEMETRY, DIAG, GPS.
- **Encode.** Only `PING`, `STOP`, `DRIVE{left,right ∈ −255..255}`, `RESET` are encodable. Payloads are hand-built, ≤160 bytes (`protocol.py:281-318`). `MOVE`, `MOTORTEST` and diagnostics are deliberately not encodable.
- **Sequence.** 1..65535 wrapping, resynced from TELEMETRY `last_seq` and from `STALE_SEQ` ACKs (`protocol.py:321-352`, `link.py:497-500, 540-541`).
- **Link state machine** (`link.py:618-653`): DISCONNECTED → CONNECTING (port open) → TELEMETRY fresh → PING sent → ACK ACCEPTED with proto 2 → **UP**. STALE when TELEMETRY is older than 1.0 s. DEGRADED on a latched reboot, a protocol mismatch or 3 consecutive ACK timeouts.
- **Motion gate** `_motion_ready` (`link.py:670-692`): transmit and motion enabled, port open, UP, bidirectional, no reboot latch, fresh TELEMETRY. For DRIVE it also requires `motor_drive_available` and **no** `safety_stop`, `front_valid=false` or `command_timeout`. `STOP` skips the fault checks.
- **Submission** (`link.py:827-852`): blocked, stopping or over-age (>0.3 s) decisions become `STOP`; a DRIVE the link cannot carry becomes `STOP`. One slot, newest wins, never queued or retried, dropped on reconnect (`link.py:419-437`).
- **Units.** Normalized intent `[-1,1]` → `round_half_away(v*255)` (`link.py:81-89`). The ESP32 then clamps, applies a deadband below 40 and scales to 12-bit PWM.
- **Reboot detection.** Uptime going backwards, or `READY` from a running ESP32, latches a reboot. The agent turns that into an e-stop; clearing the e-stop acknowledges it (`link.py:582-596`, `agent.py:691-707`).
- **Operator RESET** (`link.py:772-825`, API `/controller/reset`): only while PAUSED/IDLE/STOPPED, link UP and fresh, no reboot latch. Sent once, never retried.

## 6. GPS and localisation

**Source selection** (`agent.py:335-371`): `esp32` → `Esp32GpsReader(link)`; `pi_serial` → NMEA `GPSReader`
on `ROBOTX_GPS_PORT` (refused if it is the ESP32 UART).

**ESP32 GPS adapter** (`localization/esp32_gps.py:57-124`), data flow:

```
GPS frame (ESP32) -> gps_status == "OK"?           else NO_FIX(reason)
  -> fix_ok is True, fix_type in {2,3,4}, lat_e7/lon_e7 ints within range, not (0,0),
     age_ms int >= 0, hacc_mm int > 0               else NO_FIX(reason)
  -> age = monotonic seconds since the Pi parsed the frame + age_ms/1000; > 5 s -> STALE
  -> GpsFix(lat=lat_e7/1e7, lon=lon_e7/1e7, timestamp = wall_at_parse - age_ms/1000,
            satellites=siv, speed=speed_mm_s/1000, track=head_mot_e5/1e5,
            fix_type = {2:"2D",3:"3D"} (4 -> None), h_acc_m = hacc_mm/1000)
```

**IMPLEMENTED, UNIT-TESTED** (`tests/unit/test_esp32_gps_path.py`). The one test that would use a *real*
captured ESP32 GPS frame **skipped**: "no real GPS frame has been captured yet"
(`test_esp32_gps_path.py:74`). Hardware behaviour is **UNVERIFIED**.

**Position and heading** (`localization/position.py:191-245`). There is no compass, IMU or
magnetometer (`position.py:9-27`).

- `NMEA_TRACK`: the receiver's course, used only when `speed >= 0.5 m/s` (`settings.py:215`). For the ESP32 source this is u-blox `headMot`.
- `GPS_TRACK`: the bearing between fixes at least 1.5 m apart.
- Otherwise the **last heading is held** (stale, still labelled with its source), or `None` after `reset()` / `invalidate_heading()`.
- Observations: the decision layer's speeds are normalized, and `nav_target_speed_mps` (0.25) is not used anywhere. Whether the rover ever reaches 0.5 m/s, so that `NMEA_TRACK` is used, is **UNVERIFIED**. With the accuracy gate at 5 m and the move threshold at 1.5 m, a `GPS_TRACK` heading can be derived from position noise while creeping. That is a risk, not a measured fault.

**Dead reckoning** (`localization/local_frame.py:171-277`) is off by default, integrates the *gated* intent,
is labelled `DEAD_RECKONING`, is never sent to the backend, and its arrivals are marked unmeasured, which
blocks completion claims (`mission/mission.py:379-387`).

## 7. Camera and perception

- Camera: Picamera2, 640×480 at 20 fps, stale after 2 s (`settings.py:133-138`; `hardware/camera.py`). A prior report (`ROBOTX_PI_CURRENT_STATE.md`, 2026-09-22 snapshot per Pi `README.md`) records 18.69 fps over 60 s with 0 stalls — **HARDWARE-VERIFIED in that report, not re-observed**.
- Pipeline (`perception/pipeline.py:95-320`): a detector thread at 2 Hz on a 320×240 downscale, bboxes rescaled to full resolution. Results older than 3 s become `STALE`. A frame older than 2 s gives `NO_FRAME`. A detector exception gives `DETECTOR_ERROR`. Detector construction failure **disables perception** (`pipeline.py:106-116`).
- Detector (`perception/object_detector.py`): `opencv` default. MOG2 motion foreground (≥4000 px²) plus static Canny contours (≥2000 px²). Every detection is labelled `"obstacle"`. `person` only comes from the YOLO backend, and `ultralytics` is not installed per `requirements.txt:127-130`.
- `PerceptionResult.is_usable` requires status OK **and** frame metadata (`perception/types.py:141-151`).
- Risks (source-based, **UNVERIFIED** on the moving rover): MOG2 background subtraction assumes a mostly static camera, so ego-motion can generate large foreground blobs. Thresholds are uncalibrated (acknowledged in `ROBOTX_PI_CURRENT_STATE.md`).

## 8. Navigation (`navigation/navigator.py`, `route_planner.py`)

- **Route representation:** an ordered list of `(lat, lon)`, exactly the backend path for the current leg (`mission/manager.py:157-168, 266-274`). At least 2 and at most 2000 points per leg (`mission/mission.py:44-49`).
- **Accuracy gate:** a position with `h_acc_m > 5` is treated as no position (`NO_POSITION` with `position_issue`) (`navigator.py:154-202`). A fix without accuracy (NMEA, DR) is not judged.
- **Waypoint progression:** advance when within 8 m of the current waypoint; arrival when the last waypoint is reached and within 8 m (`route_planner.py:380-410`).
- **Off-route:** cross-track distance to the active segment > 25 m increments a counter, otherwise it decays. `REROUTE_NEEDED` at ≥8 (`route_planner.py:390-415`).
- **Blocked:** `report_blocked()` increments a counter that **never decays** and is cleared only by `set_route()` (`route_planner.py:325-330, 364-365`). `REROUTE_NEEDED` at ≥3. The agent calls it every 100 ms tick while an "obstacle" stop is in force, so about 0.3 s of obstacle stop is enough. **Confirmed source behaviour; covered by `tests/unit/test_navigation.py:75-81, 96-102`.**
- **Rerouting:** **NOT IMPLEMENTED.** `REROUTE_NEEDED` → decision `STOP "off route: reroute needed"` (`decision.py:141-142`). Nothing re-plans: `directions_client.py` is unused, the backend refuses reroute for engine tasks (409), and the engine `REROUTE` envelope is "admitted and ACKed with no effect" (`communication/engine.py:59-63`). The leg stays stuck until an operator STOP (mission aborted) or a leg change.

## 9. Decision and motion intent (`control/decision.py`, `control/motion.py`)

`MotionIntent{command, left, right ∈ [-1,1], reason, timestamp}` (`motion.py:268-298`). Priority order in
`_decide` (`decision.py:106-148`):

1. not AUTO → HOLD
2. perception not usable → STOP
3. any `person` → STOP
4. IDLE route → HOLD; NO_POSITION → STOP; ARRIVED → HOLD; REROUTE_NEEDED → STOP
5. largest detection in the centre third with ≥1500 px²: ≥30000 px² → STOP; growth ≥10000 px² → STOP; otherwise **pivot** away at 0.35 (`turn_left` = (−s, +s)) (`decision.py:168-187`)
6. no heading → forward 0.25 "creeping to establish GPS track"
7. |error| ≤5° → forward 0.45 (0.25 if a ≥10000 px² object is anywhere)
8. otherwise forward with proportional steer, saturating at 45° (never pivots for route following)

Interactions, all source-derived:

- Obstacle pivots produce a negative wheel command, so the ESP32 rear gate applies (see [ESP32 §6](ESP32_FIRMWARE_DEEP_DIVE.md#6-safety-gate-and-motor-authority)). With any rear sensor invalid (`REAR_REQUIRE_ALL_SENSORS 1`) the pivot is gated, the command is cleared and the ESP32 latches `safety_stop`. The Pi then pauses the mission.
- Pivots also invalidate the GPS heading (`agent.py:927-928`).

## 10. Pi safety gate (`control/safety.py:286-343`)

Order: e-stop latch → stop requests pass → no mission → intent older than 1.0 s → range veto (only if a
reading is passed or one is required) → perception unusable → speed clamp 0.75 (proportional scaling).
**The agent passes no `obstacle` reading.** The class docstring still says "the ESP32 link does not exist"
(`safety.py:164-171`), which is out of date.

## 11. Mission model and lifecycle

- Validation (`mission/mission.py:134-288`): finite in-range coordinates, 2..2000 points, plausible timestamp, non-empty task id.
- OFFER → mission (`communication/engine.py:495-521`): exactly **two stops**, ordered by `sequence`. The first is the pickup and the second the drop, each with its own path. Anything else is `UNSUPPORTED_MISSION`.
- States: `TO_PICKUP → AT_PICKUP → (hold for ACQUIRED) → TO_DROP → AT_DROP → (hold for RELEASED) → COMPLETE`, or `ABORTED` (`mission/manager.py:210-335`). Custody is accepted only at a **measured** arrival (`manager.py:339-377`).
- Custody source: only `POST /mission/custody` on the local API with `ROBOTX_CUSTODY_CONFIRMATION=operator`, recorded as `OPERATOR_CONFIRMED` (`main.py:283-302`). The API binds 127.0.0.1 by default.
- Completion: `_finish_mission` sets IDLE and keeps the mission in state for reporting (`agent.py:971-988`).
- **Persistence:** the mission, the position track used for completion evidence and the grant time are **in memory only** (`backend_link.py` `_tracks`, `_granted_at_ms`). Commitment high-water marks and responses persist (`commitment_store.py`, atomic write, 0600). After a Pi restart mid-mission the commitment survives but the mission does not, so no lease renewal or report is sent for it (`backend_link.py:1707-1723`).

## 12. Backend link (`communication/backend_link.py`, `protocol.py`, `engine.py`, `commands.py`)

Contract details are in [INTERFACE_AND_PROTOCOL_CONTRACTS.md](INTERFACE_AND_PROTOCOL_CONTRACTS.md). Summary:

- **Lifecycle:** its own reconnect loop (`reconnection=False`); anonymous connect → `AUTH {robotId, token|pairingCode}` → `AUTH_SUCCESS`/`AUTH_OK` (token persisted) → STREAMING. Handlers registered once per client (`backend_link.py:801-921`).
- **Credential handling (R1):** a stored token is discarded only on `AUTH_FAILED {reason: INVALID_CREDENTIAL}`. The pairing code is single-use (`backend_link.py:971-1077`).
- **Inbound:** `COMMAND` (STOP/PAUSE/RESUME/RETURN, ACK only when applied), bare `STOP`, engine envelopes under their own event names (`OFFER`, `WITHDRAW`, `RECALL`, `ABORT_MISSION`, and ten "no-effect" commands), `PROBE`, `TASK_COMPLETE_ACK`, `TASK_ASSIGN` (logged only, never starts a mission, `backend_link.py:1398-1429`). Anything else goes to the `*` catch-all, counted and logged (`backend_link.py:909-921`).
- **Engine admission:** addressee → `notValidAfter` → HMAC-SHA256 (no key means not admitted) → tombstone → fence > floor and > highest → sequence contiguous (gaps held, at most 16) → persist → act (`backend_link.py:1433-1512`).
- **Offer decision** (`agent.py:493-537`): reject `NO_EXECUTABLE_PATH`, `UNSUPPORTED_MISSION`, `ESTOP_LATCHED`, `AGENT_ERROR`, `MISSION_IN_PROGRESS`, `NO_MOTOR_LINK` (no UP link, or not `motion_ready`), `NO_POSITION_FIX` (no measured fix, or fails the hAcc gate), `NO_CUSTODY_SENSING`. DEFER is never produced by `assess_offer`.
- **Outbound loop** (`backend_link.py:1123-1168`): HEARTBEAT 2 s (commitment form while a held mission matches), TELEMETRY 1 s, custody events and task completion checked every 0.25 s. Lost reports are resent once per authenticated session (Y2).
- **Loss policy (Y4):** pause AUTO after `loss_grace_s` from the end of an authenticated session (`backend_link.py:1983-2011`).
- **`agent_capabilities()`** still declares `"motion": False` with the comment "that link does not exist yet" (`communication/protocol.py:674-692`). It is only sent on the optional `register` channel, which is unbound by default, so it is stale but inert.

## 13. Health and telemetry

- `HealthMonitor` combines host metrics (CPU, memory, temperature) and per-component status for camera, perception, GPS (degraded when the accuracy gate fails), navigation, ESP32 (degraded with the controller's own fault list) and backend (`agent.py:999-1189`, `diagnostics/health.py`).
- Local API: `/health`, `/state`, `/telemetry`, `/config`, `/backend`, `/camera` (MJPEG).

## 14. Explicit capability questions

| Question | Answer | Evidence | Status |
|---|---|---|---|
| Computes or merely follows a route? | **Follows** backend-supplied paths only | `mission/manager.py:23-29`; `directions_client` unused | IMPLEMENTED (follow); planning NOT IMPLEMENTED |
| Actual rerouting? | **No.** It stops at `REROUTE_NEEDED` and stays stopped | `decision.py:141-142`; `route_planner.py:325-330` | NOT IMPLEMENTED |
| Uses heading while stationary? | Holds the last GPS-derived heading (stale) until a pivot invalidates it or a run resets it | `position.py:243-245`; `agent.py:582, 927-928` | IMPLEMENTED; accuracy UNVERIFIED |
| Uses ESP32 sensor ranges in navigation? | **No.** Only `front_valid` blocks DRIVE and pauses; ranges are not used | grep: no use outside `robotx/esp32/` | NOT IMPLEMENTED |
| Obstacle detection: camera, distance or both? | Camera on the Pi (heuristic). Ultrasonic and ToF on the ESP32, independently. **Not fused** | `decision.py:152-187`; `safety.cpp:934-958` | PARTIALLY IMPLEMENTED |
| Recovers from GPS loss? | Stops and auto-continues when a usable fix returns | `decision.py:133-138` | IMPLEMENTED, UNIT-TESTED |
| Recovers from comms loss? | Backend: pause, needs RESUME. ESP32: pause, needs RESUME (plus RESET if latched) | `backend_link.py:1983-2011`; `agent.py:843-856` | IMPLEMENTED; recovery is manual |
| Recovers from perception loss? | Stops; auto-continues when usable | `decision.py:117-125` | IMPLEMENTED |
| Mission acceptance/progress/completion? | Yes, with operator custody at both stops and an L1 evidence self-check | §11, §12 | INTEGRATION-TESTED (software) |
| End-to-end mission without operator intervention? | **No.** Custody needs a person at both stops by design; any ESP32 safety stop needs RESET + RESUME | `agent.py:539-549`; `tests/integration/test_esp32_sim_link.py` | BLOCKED by design and by RX-03 |

## 15. Tests

See [TESTING_AND_VERIFICATION.md](TESTING_AND_VERIFICATION.md). Run today on Windows: unit 1000 (4 failed,
all POSIX-specific; 1 skipped), loopback integration 61 (2 failed, timing on Windows; 6 skipped). The
simulator-link integration passed 6/6 against firmware compiled from repository B.

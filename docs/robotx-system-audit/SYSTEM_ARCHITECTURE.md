# RobotX System Architecture

Snapshot 2026-10-17 · Pi `c58f124` · ESP32 `8de2162` · Backend `de03788`. Status words follow the
vocabulary in [README.md](README.md#status-vocabulary-used-identically-in-every-document).
Relationships drawn with solid lines are established by source code. Dashed lines are
**proposed, configuration-dependent or unverified**, and are labelled.

## 1. Components

| Layer | Component | Where | Notes |
|---|---|---|---|
| Fleet | Backend API + Socket.IO server | `RobotX/Backend/server.js`, `src/app.js`, `src/sockets/socket.server.js` | Express 5, Socket.IO 4.8, Prisma 5 (PostgreSQL), optional Redis adapter |
| Fleet | Assignment engine | `RobotX/Backend/src/engine/**`, workers in `src/workers/` | Active only when `ENGINE_ENABLED=true` **and** the shard's cutover binding is on (`src/engine/cutover/enabled.js`, referenced from `task.service.js:42-44`) |
| Fleet | Physical fleet provider | `src/services/fleetProviders/physical*.js` | Off unless `PHYSICAL_FLEET_ENABLED=true` and a declaration file is configured (`physicalPolicy.js:30-32`) |
| Fleet | Dashboard | `RobotX/Frontend` (React 19, Vite 8, Mapbox GL, socket.io-client) | Operator UI. No SoC-declaration, clear-fault or custody UI found |
| Robot | Pi agent | `RobotX-Pi/robotx/**`, entry `python -m robotx.application` | FastAPI loopback API + 10 Hz agent loop + backend link + ESP32 link |
| Robot | ESP32 firmware | `robot_controller/*.ino, *.cpp, *.h` | ESP32 Dev Module, Arduino core 2.0.14 (`robot_controller.ino:5-6`) |
| Hardware | Camera | Raspberry Pi Camera Module 3 via Picamera2 | Pi-side only |
| Hardware | GPS | u-blox (named NEO-9M in `config.h:224`) on ESP32 I2C 0x42 | Polled NAV-PVT, forwarded to Pi |
| Hardware | Front range | 2 × HC-SR04 (GPIO13/14, GPIO18/19) | ESP32 only (`config.h:65-68`) |
| Hardware | Rear range | 3 × VL53L0X @0x29 behind TCA9548A @0x71, ch 0/1/2 | ESP32 only (`config.h:159-168, 491-511`) |
| Hardware | Motors | 4 motors, 2 × L298N; direction GPIO, speed via PCA9685 @0x40 CH0–3 | Differential drive, no steering (`config.h:47-55, 190-212`) |
| Hardware | Encoders | GPIO34/35/36/39 | **Reserved, not read** by firmware (`config.h:100-109`) |
| Hardware | Battery sensing | — | **None** (`robotx/hardware/battery.py:27-33` returns nulls; backend relies on operator-declared SoC) |
| Hardware | Hardware e-stop | — | **None**; backend accepts the Pi-reported *software* stop latch (`physicalPolicy.js:9-14`) |

## 2. Overall component architecture

```mermaid
flowchart LR
  subgraph Fleet["Backend host (laptop or server)"]
    DASH["Dashboard (React/Vite)"]
    API["REST API /api/*"]
    SIO["Socket.IO server"]
    ENG["Assignment engine + outbox worker"]
    DB[("PostgreSQL via Prisma")]
    KV[("Redis or in-memory KV")]
    DASH -- "HTTPS (cookie JWT)" --> API
    DASH -- "Socket.IO room 'dashboard'" --> SIO
    API --> DB
    ENG --> DB
    ENG -- "signed envelopes via outbox" --> SIO
    SIO --> KV
  end

  subgraph Pi["Raspberry Pi 5 - robotx agent"]
    LAPI["Local API 127.0.0.1:8000 (unauthenticated)"]
    AG["RobotAgent 10 Hz loop"]
    BL["BackendLink (python-socketio)"]
    EL["Esp32Link (sole UART owner)"]
    CAM["CameraStream + PerceptionPipeline"]
    AG --- CAM
    AG --- BL
    AG --- EL
    LAPI --> AG
  end

  subgraph ESP["ESP32 firmware"]
    COMM["comm.cpp protocol v2"]
    SAF["safety.cpp gate"]
    MOT["motor.cpp"]
    TOF["rear_tof.cpp"]
    GPSM["gps.cpp"]
  end

  SIO <-->|"Socket.IO, namespace '/'"| BL
  EL <-->|"UART /dev/ttyAMA0 115200 8N1, CRC-16 framed lines"| COMM
  COMM --> SAF --> MOT
  TOF --> SAF
  GPSM --> COMM
  MOT -- "GPIO direction + PCA9685 PWM over I2C" --> MOTORS["4 motors / 2 x L298N"]
  US["2 x HC-SR04 front"] --> SAF
  TOFHW["3 x VL53L0X via TCA9548A"] --> TOF
  GNSS["u-blox GNSS I2C 0x42"] --> GPSM
  PICAM["Pi Camera Module 3"] --> CAM
  OP(["Operator at the stop"]) -.->|"SSH + curl to local API (custody, reset, e-stop) - unverified operational path"| LAPI
```

## 3. Authority boundary: who decides what

**Design intent (verified in source):** the Pi proposes motion; the ESP32 is the final authority
over every wheel.

| Decision | Owner | Evidence |
|---|---|---|
| Which mission to accept | Backend offers; Pi decides feasibility only | `agent.py:493-537` (`assess_offer`) |
| The route | **Backend** (paths in the OFFER). The Pi never plans or edits routes | `mission/manager.py:23-29`, `mission/mission.py:1-8` |
| Desired heading, speed, steer | Pi decision layer | `control/decision.py:106-225` |
| Whether an intent may leave the Pi | Pi safety gate (e-stop latch, staleness, perception, speed ceiling) | `control/safety.py:286-343` |
| Whether a `DRIVE` is transmitted | Pi `Esp32Link` (motion enabled, link UP, PING proven, fresh TELEMETRY, no ESP32 fault) | `esp32/link.py:670-692, 827-852` |
| Whether each wheel turns | **ESP32**, every `loop()` pass: front sensors gate positive wheels, rear sensors gate negative wheels | `safety.cpp:934-958`, `robot_controller.ino:266-300` |
| Stop when the Pi goes silent | **ESP32** watchdog, 2000 ms | `robot_controller.ino:242-248`, `config.h:824` |
| Motor PWM / direction | ESP32 only; the Pi imports no motor driver in the agent path | `agent.py:14-17`; regression test `tests/unit/test_commands.py:279` |

**Deviations and caveats found:**

1. The ESP32 is not *always* in control. While `rearTofUpdate()` re-initialises a failed sensor, `loop()`
   does not run at all (see [ESP32 deep dive §8](ESP32_FIRMWARE_DEEP_DIVE.md#8-the-rear-tof-freeze-analysis)).
   Re-init is allowed only when both applied wheel outputs are zero, so motors are already stopped.
   But for the duration no command, failsafe or sensor update is processed.
2. If the TCA9548A is absent at boot, the rear gate falls back to
   `SAFETY_BLOCK_REVERSE_WHEN_REAR_UNCONFIGURED 0`. **Reverse is then ungated** (`config.h:691`,
   `safety.cpp:888-900`).
3. The Pi's gate never receives a range measurement (`agent.py:898-905`, `require_range_sensor=False`
   at `settings.py:278`). The only range-based protection is the ESP32's.
4. Stop ordering in `stopMotors()` puts an I2C write before the GPIO cutoff (`motor.cpp:243-257`).

## 4. Mission lifecycle (engine path)

```mermaid
sequenceDiagram
  autonumber
  participant Op as Operator / Dashboard
  participant BE as Backend (engine, sockets)
  participant Pi as Pi agent
  participant E as ESP32
  Op->>BE: POST /api/tasks/assign (intake, engine live required)
  Note over BE: Engine round -> Leg QUEUED -> commitment -> outbox OFFER (signed HMAC, fence, sequence, notValidAfter)
  BE->>Pi: OFFER {agentId, commitmentId, fence, sequence, payload.stopSequence[path]}
  Pi->>Pi: admit: addressee, expiry, HMAC, fence, sequence, persist marks
  Pi->>BE: COMMAND_ACK {outboxId, fence, authorityEpoch}
  Pi->>Pi: assess_offer: e-stop, mode, ESP32 motion_ready, measured fix within hAcc gate, custody=operator
  alt feasible
    Pi->>BE: OFFER_ACCEPT {commitmentId, fence}
    Pi->>Pi: assign_mission: route = path to pickup, mode AUTO
  else not feasible
    Pi->>BE: OFFER_REJECT {commitmentId, fence, reason}
  end
  loop every 100 ms
    Pi->>E: DRIVE {left,right} or STOP (seq, CRC)
    E-->>Pi: ACK ACCEPTED or GATED, TELEMETRY every 200 ms, GPS every 1 s
  end
  loop every 1 s / 2 s
    Pi->>BE: TELEMETRY {sequence,status,timestamp,lat,lon,position{fixType,hAccM},safety.stopLatch}
    Pi->>BE: HEARTBEAT {commitmentId, fence} (renews lease)
  end
  Note over BE: legProgress: >=5 m departure, arrival within VERIFY_ARRIVAL_RADIUS_M (server's own evidence)
  Pi->>Pi: ARRIVED at pickup (8 m) -> AT_PICKUP, hold
  Op->>Pi: POST /mission/custody {"kind":"ACQUIRED"} (local API)
  Pi->>BE: CUSTODY_EVENT ACQUIRED
  Pi->>Pi: TO_DROP leg ... ARRIVED -> AT_DROP, hold
  Op->>Pi: POST /mission/custody {"kind":"RELEASED"}
  Pi->>BE: CUSTODY_EVENT RELEASED
  Pi->>Pi: L1 evidence self-check on the fixes it sent
  Pi->>BE: TASK_COMPLETE {taskId, lat, lon}
  BE->>BE: verify track (rate, gaps, corridor, speed, arrival), settle Leg, complete Task
  BE->>Pi: TASK_COMPLETE_ACK {taskId} or {verifying:true}
```

Status of this path: **INTEGRATION-TESTED in software only.** Pi unit and loopback tests and the
backend's targeted tests pass, and the cross-repo signature vector reproduces. The Pi README reports a
Gate 3/3b run against the real backend with the ESP32 host simulator, which was not re-run here. No
physical end-to-end mission is evidenced.

## 5. Runtime data and control flow (one Pi tick)

```mermaid
flowchart TD
  G["ESP32 GPS frame (latest)"] --> R["Esp32GpsReader.get_reading: status OK, fix_ok, fix_type in 2,3,4, age_ms, hacc_mm>0, stale > 5 s"]
  R --> P["PositionEstimator: position + heading (NMEA_TRACK if speed>=0.5 m/s, else GPS_TRACK after 1.5 m)"]
  P --> ST1["state.update_gps"]
  EL["Esp32Link.status (TELEMETRY, DIAG, reboot latch)"] --> X{"mission AUTO and not motion_ready?"}
  X -- yes --> PAUSE["pause_mission"]
  BL["BackendLink.apply_loss_policy"] --> PAUSE2["pause after 10 s link loss"]
  P --> N["Navigator.update: hAcc gate 5 m, waypoint 8 m, off-route 25 m, reroute counters"]
  N --> M["MissionManager.update: AT_PICKUP / TO_DROP / AT_DROP / COMPLETE"]
  C["PerceptionPipeline.latest (2 Hz detector thread)"] --> D["DecisionMaker.decide"]
  N --> D
  D --> S["SafetyGate.evaluate (no range input)"]
  S --> I["gated MotionIntent -> state"]
  I --> E["Esp32Link.submit -> STOP or DRIVE slot (<=0.3 s old)"]
  I --> H["heading invalidated on pivot, report_blocked if 'obstacle' stop"]
  E --> U["UART write by I/O thread"]
```

ESP32 per-`loop()` order (`robot_controller.ino:185-331`): `commPoll` → set re-init permission →
`safetyUpdate` (rear ToF service, rear latch, at most one front ping per 30 ms) → `commPoll` →
MOTORTEST branch → command watchdog → `safetyGateMotion` → `driveDifferential` → `commUpdateRuntime`
→ `commServiceTelemetry` (TELEMETRY 200 ms, DIAG rotating, GPS frame 1 s) → `gpsUpdate` → `delay(1)`.

## 6. Feedback path (sensor to report)

| Step | Front ultrasonic | Rear ToF | GPS |
|---|---|---|---|
| Acquisition | `pingRaw()` `pulseIn` ≤20 ms (`safety.cpp:155-183`) | continuous mode, one sensor per 20 ms (`rear_tof.cpp:460-553`) | NAV-PVT poll 1 Hz over I2C (`gps.cpp:181-231`) |
| Filtering | 5-sample median, ≥3 good, 1 s stale, hysteresis 40/65 cm | 5-sample median, ≥3 good, 600 ms stale, hysteresis 250/400 mm | status machine, 3 s stale on ESP32 |
| ESP32 use | gates forward wheels | gates reverse wheels | **none** (reporting only, `robot_controller.ino:313-320`) |
| Serialised | TELEMETRY `front_*`, `forward_blocked` | TELEMETRY `rear_mm[]`, `rear_*`, DIAG REAR | `GPS` frame |
| Pi parser | `ControllerTelemetry.from_frame` | same | `reading_from_frame` |
| Pi use | only `front_valid` (via `safety_faults`) to refuse DRIVE / pause; health text | `rear_sensor_fault` in health text only | position, heading, navigation, offer feasibility |
| Backend | not sent (no field) | not sent | TELEMETRY `lat/lon/position`, completion evidence |

## 7. Failure handling and safety boundaries

```mermaid
flowchart TB
  subgraph Backend
    B1["Lease 60 s, renewed by HEARTBEAT {commitmentId,fence}"]
    B2["Offer TTL 20 s, start grace 60 s (register defaults)"]
    B3["TASK_COMPLETE graded on measured track, insufficient -> VERIFYING (operator)"]
  end
  subgraph Pi
    P1["Backend loss -> PAUSE after grace <=10 s (Y4)"]
    P2["ESP32 not motion_ready -> PAUSE (resume needs explicit RESUME)"]
    P3["ESP32 reboot detected -> e-stop latch (operator clear)"]
    P4["Perception unusable / no fix / hAcc>5 m -> STOP intent (auto-continues when fixed)"]
    P5["REROUTE_NEEDED -> STOP (no recovery path)"]
    P6["Agent tick stall >5 s -> heartbeat suppressed"]
    P7["Local e-stop latch (API /safety/estop)"]
  end
  subgraph ESP32
    E1["Per-wheel gate: front obstacle/fault blocks forward, rear obstacle/fault blocks reverse"]
    E2["Blocked command cleared + safety_stop latched (RESET or clean DRIVE clears)"]
    E3["Watchdog 2 s without DRIVE/MOVE/STOP -> motors zero, command_timeout"]
    E4["No PCA9685 -> no motion at all"]
  end
  E5["Loop blocked by rear ToF re-init (seconds): E1-E3 not evaluated"]:::risk
  E6["Rear backend absent at boot -> reverse UNGATED"]:::risk
  E5 -.-> E1
  E6 -.-> E1
  P2 --> E2
  classDef risk fill:#fdd,stroke:#c00
```

Hard boundaries that exist in code:

- Nothing the backend does can *start* motion except an admitted OFFER or an explicit `RESUME`
  of a paused mission. Loss of the backend only reduces motion (`backend_link.py:1983-2011`).
- The Pi local API refuses `/mission/start` and `/mission/resume` whenever the backend link is enabled
  (`application/main.py:171-188`).
- `ROBOTX_ESP32_MOTION_ENABLED=0` (the default and the documented V1 value) means no `STOP` or `DRIVE`
  is ever written (`link.py:839-840`).

## 8. Telemetry, diagnostics, health

| Producer | Channel | Rate | Content |
|---|---|---|---|
| ESP32 | `TELEMETRY` | 200 ms | state, commands vs applied, front/rear ranges and gates, latches, watchdog age (`comm.cpp:1634-1681`) |
| ESP32 | `DIAG` FRONT/REAR/SYSTEM | one section every 2nd fast frame, offset 100 ms | sensor health, rear bus-error and re-init counters, link stats, proto (`comm.cpp:1683-1831`) |
| ESP32 | `GPS` | 1 s | status, fix, position, accuracy, poll counters (`gps.cpp:343-387`) |
| ESP32 | `EVENT` | on transition | READY, COMMAND_TIMEOUT, MOTORTEST_DONE, I2CSCAN |
| Pi | `/health`, `/state`, `/telemetry`, `/backend` | on request | full robot snapshot incl. controller telemetry and DIAG (`application/main.py:95-151`) |
| Pi → backend | `TELEMETRY` 1 s, `HEARTBEAT` 2 s | as listed | see [contracts](INTERFACE_AND_PROTOCOL_CONTRACTS.md#18-pi--backend-telemetry) |
| Pi → backend | `status`, `event`, `register` | **never** by default | bindings are empty strings (`communication/protocol.py:185-189`) |

## 9. Recovery and termination summary

| Situation | What happens | Who recovers |
|---|---|---|
| Backend link lost >10 s during AUTO | Pi pauses | Backend `RESUME` after reconnect (operator) |
| ESP32 telemetry stale >1 s during AUTO | Pi pauses | Explicit `RESUME` once the link is UP |
| ESP32 obstacle/fault gate | ESP32 latches; Pi pauses | Operator `/controller/reset` on Pi, then backend `RESUME` |
| ESP32 reboot | Pi e-stop latch | Operator `/safety/clear`, then `RESUME` |
| Camera obstacle ≥3 ticks | Leg stuck in `REROUTE_NEEDED` | Operator STOP (mission aborted) — no resume path |
| GPS loss / poor accuracy | Pi holds (STOP intent), mode stays AUTO | Automatic when fix returns |
| Engine WITHDRAW / RECALL / ABORT_MISSION | Pi stops that mission, tombstones commitment | n/a |
| Pi restart mid-mission | Mission state is in memory only; commitment marks persist | Leg stalls; backend timers / operator |

# Current Blockers and Risks

Snapshot 2026-10-17. Ranked by **safety impact first, then dependency order** (an item that other items
depend on ranks higher), not by ease of fixing. "SW" = verifiable in software only; "HW" = needs the rover.

## Ranked summary

| Rank | ID | Title | Severity | Class | Repo |
|---|---|---|---|---|---|
| 1 | RX-01 | ESP32 `loop()` blocks for seconds during rear ToF re-init | Critical | Confirmed code path / suspected cause of the freeze | B |
| 2 | RX-02 | Motor stop issues I2C before GPIO cutoff | High | Suspected safety risk | B |
| 3 | RX-05 | Reverse is ungated if the rear sensors are absent at boot | High | Safety risk (configuration) | B |
| 4 | RX-06 | A failing initialised rear sensor slows the loop while driving | High | Suspected | B |
| 5 | RX-17 | Deployed Pi code and flashed firmware are unknown | High | Unknown / verification blocker | A, B |
| 6 | RX-04 | Front sensing may be invalid (right ultrasonic) → no forward motion | High | Unknown (HW) | B |
| 7 | RX-03 | Every ESP32 safety stop needs an operator RESET + RESUME | High | Design / autonomy blocker | A, B |
| 8 | RX-09 | Camera pivots plus rear-sensor fault → latch → pause | High | Confirmed interaction | A, B |
| 9 | RX-08 | ~0.3 s obstacle stop → permanent `REROUTE_NEEDED`; no rerouting anywhere | High | Confirmed defect + missing feature | A, C |
| 10 | RX-07 | No range-sensor input to Pi decisions; camera-only heuristic avoidance | High | Missing feature | A |
| 11 | RX-11 | Default and documented configuration rejects every offer; heavy manual provisioning | High (operational) | Blocked | A, C |
| 12 | RX-14 | ESP32 GPS path not verified on hardware | Medium | Unknown (HW) | A, B |
| 13 | RX-10 | GPS-only heading; thresholds and noise | Medium | Unknown (HW) | A |
| 14 | RX-23 | MOG2/Canny detector on a moving camera | Medium | Unknown (HW) | A |
| 15 | RX-20 | Backend 60 s start grace vs creeping start | Medium | Unknown (HW) | A, C |
| 16 | RX-13 | Pi restart mid-mission strands the leg; completion evidence lost | Medium | Confirmed limitation | A |
| 17 | RX-12 | Custody only via the Pi loopback API; no dashboard path | Medium | Missing feature (operational) | A, C |
| 18 | RX-15 | No firmware build identity; patched library outside the repo | Medium | Environmental | B |
| 19 | RX-21 | Unhandled or unemitted events (REROUTE_ALERT, OBSTACLE_REPORT, ROBOT_FAULT) | Low–Med | Integration mismatch | A, C |
| 20 | RX-22 | `AGENT_MTLS_REQUIRED=true` would lock the Pi out | Low | Latent mismatch | A, C |
| 21 | RX-16 | Stale comments, docs and dead configuration | Low | Technical debt | A, B |
| 22 | RX-19 | Pi tests fail on Windows and write to `C:\proc` | Low | Environmental | A |
| 23 | RX-18 | Backend branch 5 commits ahead of remote; several worktrees | Low | Process | C |

---

## A. Safety risks and confirmed defects

### RX-01 — ESP32 control loop blocks during rear ToF re-initialisation
- **Severity: Critical.** While blocked, the ESP32 processes no commands, sends no telemetry, runs no watchdog and pings no front sensor. It is also the most plausible explanation for the reported freeze, and it destabilises every downstream layer (the Pi link goes STALE, missions pause, offers are rejected).
- **Subsystem:** `rear_tof.cpp` runtime re-init; `robot_controller.ino` loop.
- **Evidence:** `rear_tof.cpp:508-527` calls `initOneSelected()` synchronously; `rear_tof.cpp:203-251` (up to 3 `init()` attempts; the 500 ms slow check runs only after the call returns); `robot_controller.ino:210-212` (permitted whenever the applied outputs are 0); `config.h:596-607, 948-962` (a hung transaction lasts ≥1 s; re-init every 5 s); comments at `rear_tof.cpp:515-517` and `robot_controller.ino:206-208` ("can block for seconds"). `config.h:510`: channel 1 = `"LEFT"`.
- **Reproduction evidence:** none in this audit. Host tests use fakes that return immediately.
- **Impact:** periodic loss of TELEMETRY (Pi STALE after 1 s), AUTO missions paused, OFFERs rejected `NO_MOTOR_LINK`, RX ring overflow after ~2 s of Pi traffic, GPS frames stop. Motors are already at zero when it starts, so it does not create motion. It removes the controller's responsiveness.
- **Dependencies:** none. Root of RX-03 and RX-09 symptoms in practice.
- **Recommended action:** (1) Confirm read-only from the Pi `/state` (procedure in [ESP32 §8](ESP32_FIRMWARE_DEEP_DIVE.md#8-the-rear-tof-freeze-analysis)). (2) Remove the synchronous re-init from `loop()`. Options: disable runtime re-init (`REAR_TOF_REINIT_AFTER_MS 0`; the sensor stays failed, so reverse stays blocked, which is the safe direction), or move it behind a strict time budget the library cannot exceed. (3) Add loop-time instrumentation (max loop ms, last stall source) to DIAG SYSTEM.
- **Acceptance criteria:** with one rear sensor faulty or disconnected, for 10 minutes stationary and 10 minutes on blocks while driving: TELEMETRY interval p100 < 400 ms; Pi `communication.esp32` never leaves `UP`; DIAG max loop time < 50 ms; reverse remains blocked (`REAR_SENSOR_FAULT`).
- **Verify:** SW first (a host test with a VL53L0X fake whose `init()` blocks 5 s), then HW on blocks.

### RX-02 — Stop path depends on I2C before GPIO
- **Severity: High** (stop latency on a degraded bus).
- **Evidence:** `motor.cpp:243-257` `stopMotors()`: `pca9685AllOff()` (I2C) runs before the IN1/IN2 GPIO writes, and a per-channel I2C duty write sits between each motor's GPIO writes. `writeChannel` (`motor.cpp:122-143`) also writes the enable over I2C first. Per `config.h:955-962`, a hung transaction can take about 1 s.
- **Impact (suspected):** on a stuck bus, the direction pins of the last motor could drop several seconds late. A coasting L298N with EN still high and direction set would keep driving.
- **Action:** drive all direction pins LOW first (GPIO, immediate), then attempt the PCA writes. Keep the ordering rule for *starting* motion only.
- **Acceptance:** with SDA held low on the bench, every IN pin goes LOW within 2 ms of the stop decision (logic analyser).
- **Verify:** HW (bench, wheels off the ground). The ordering can be unit-checked in the host simulator.

### RX-05 — Reverse ungated when the rear backend never came up
- **Severity: High.** Silent loss of a safety function.
- **Evidence:** `config.h:691` `SAFETY_BLOCK_REVERSE_WHEN_REAR_UNCONFIGURED 0`; `safety.cpp:888-900`; "backend up" requires a sensor initialised at least once since boot (`rear_tof.cpp:302-333, 537-552`).
- **Impact:** if the TCA9548A is not found or no rear sensor initialises at boot, negative wheel commands (Pi obstacle pivots) are not rear-gated.
- **Action:** set the policy to 1 (block) now that the rear hardware is commissioned, or report the unconfigured state to the Pi as a safety fault.
- **Acceptance:** a boot with the TCA disconnected → TELEMETRY `reverse_blocked:true`, `block_reason REAR_UNCONFIGURED` for any reverse request.
- **Verify:** SW (host simulator with the TCA absent) + HW.

### RX-06 — Failing initialised rear sensor stalls the loop per visit, including while driving
- **Severity: High (suspected).**
- **Evidence:** `rear_tof.cpp:344-355, 488-507`. Each visit to an initialised sensor attempts a register read; on a BUS_ERROR the cost is the transaction timeout. Demotion needs 50 consecutive errors. TCA-select failures are recorded every visit (`rear_tof.cpp:476-486`). Not gated by motion.
- **Impact:** with a hung bus, every third 20 ms rear tick costs ≥1 s, stretching the front-sensor cadence and the safety gate while the rover moves.
- **Action:** after N consecutive errors, back off from visiting that sensor (time-based), in addition to demotion.
- **Acceptance:** with a faulty rear sensor and wheels driving (on blocks), DIAG max loop time < 50 ms.
- **Verify:** SW (fake with a slow failure) + HW.

### RX-08 — Permanent `REROUTE_NEEDED` after a brief obstacle stop; no rerouting
- **Severity: High.** A confirmed defect that strands every mission encountering any camera obstacle.
- **Evidence:** `robotx/application/agent.py:933-934` (`report_blocked()` every tick while an "obstacle" stop is in force); `navigation/route_planner.py:364-365, 412-415` (counter never decays; ≥3 → reroute); cleared only by `set_route()` (`route_planner.py:325-330`); `control/decision.py:141-142` (STOP); `resume_mission` does not reset it when a route is loaded (`agent.py:626-627`). No reroute provider: `directions_client.py` is unused; backend returns 409 for engine tasks (`tasks.controller.js:440-456`); engine `REROUTE` is a no-op (`engine.py:59-63`).
- **Reproduction evidence:** unit tests confirm the counter semantics (`tests/unit/test_navigation.py:75-81, 96-102`).
- **Impact:** after about 0.3 s of obstacle stop, the leg stops for good. Recovery is operator STOP (aborts) or WITHDRAW/RECALL.
- **Action:** count *distinct* blocking episodes with time-based decay, or reset on a sustained clear path. Define the behaviour at `REROUTE_NEEDED` (report to the backend; wait for a new path; or stop and escalate).
- **Acceptance:** an obstacle present for 5 s and then removed → navigation resumes `NAVIGATING` without operator action; a persistent obstacle for more than T → explicit escalation event.
- **Verify:** SW (unit + simulated agent ticks), then HW.

### RX-09 — Camera obstacle pivots interact with rear-sensor faults
- **Severity: High.**
- **Evidence:** `decision.py:168-187` (pivot = one wheel negative); ESP32 `REAR_REQUIRE_ALL_SENSORS 1` (`config.h:675`); `SAFETY_CLEAR_COMMAND_ON_BLOCK 1` clears the whole command and latches (`config.h:811`, `comm.cpp:640-657`); Pi refuses DRIVE on `safety_stop` and pauses (`link.py:684-691`, `agent.py:843-856`).
- **Impact:** with one rear ToF failing (the reported ch1), the first camera avoidance manoeuvre pauses the mission and requires RESET + RESUME.
- **Action:** decide policy: forward-only arcs for avoidance, or stop-and-wait, instead of pivots. Make the Pi aware of `reverse_blocked` before commanding negative wheels.
- **Acceptance:** with `reverse_blocked:true`, the Pi never emits a negative wheel command; avoidance never latches `safety_stop`.
- **Verify:** SW (simulator with the rear fault) + HW.

## B. Missing features and design blockers

### RX-03 — ESP32 safety stops require a human
- **Severity: High** for autonomy (safe by design, but no autonomous recovery).
- **Evidence:** latch semantics `comm.cpp:654, 662-677, 684-697, 879-898`; Pi `link.py:684-691`, `agent.py:843-856`; reset only via operator API `main.py:260-280`. **INTEGRATION-TESTED** today: `test_esp32_sim_link` (obstacle → GATED → safety_stop → PAUSED → RESET → still PAUSED → RESUME).
- **Impact:** any front obstacle detection, front sensor flicker or rear gate event ends autonomy until an operator acts.
- **Action:** an explicit design decision. For example, allow the Pi to clear a front-obstacle latch automatically after the ESP32 reports a sustained clear (`front_obstacle:false`, `front_valid:true` for X s) while stationary. Keep faults and reboots manual.
- **Acceptance:** documented policy, plus a simulator test of the automated path with a dwell, plus a negative test that sensor faults still require an operator.
- **Verify:** SW + HW.

### RX-07 — No sensor-informed obstacle handling in the Pi
- **Severity: High.**
- **Evidence:** `agent.py:898-905` (no `obstacle` argument); `settings.py:278`; grep shows no Pi use of `front_*`, `rear_*`, `forward_blocked`. Camera detector heuristic (`perception/object_detector.py`); `person` only via YOLO (not installed).
- **Impact:** the Pi drives toward obstacles until the ESP32 latches (RX-03), then the mission pauses. There is no slow-down using the ultrasonic warning band.
- **Action:** feed fresh ESP32 front ranges into `SafetyGate.evaluate(obstacle=RangeReading(...))` and set `require_range_sensor` on the rover; use `front_warning` for speed limiting.
- **Acceptance:** unit tests for gate behaviour with ranges; on blocks, an object at 60 cm reduces speed and at 35 cm the Pi itself stops before the ESP32 gate engages.
- **Verify:** SW + HW.

### RX-11 — Configuration and provisioning block any physical offer
- **Severity: High (operational).**
- **Evidence:** Pi V1 env template `ROBOTX_ESP32_MOTION_ENABLED=0` (`docs/operations/V1_PI_DEPLOYMENT.md` §12) → `assess_offer` rejects `NO_MOTOR_LINK` (`agent.py:528-529`); `ROBOTX_CUSTODY_CONFIRMATION` must be `operator`; signing key must match the backend's (manual). Backend example `PHYSICAL_FLEET_ENABLED=false`; declaration file required; SoC declaration only by API (`robots.routes.js:57`, no UI); clocks within 500 ms (`docs/runbooks/physical-fleet.md`).
- **Impact:** no physical robot receives or accepts work until all of these are deliberately configured.
- **Action:** a single commissioning checklist that ties the Pi env, backend env, declaration and SoC (see the runbook) and records who enabled motion and when.
- **Acceptance:** Pi `/backend` shows `command_signing_key: SET`; backend boot log `[physical] declaration applied`; an OFFER arrives and the Pi rejects with a reason other than configuration (or accepts) during a supervised test.
- **Verify:** SW (backend + Pi on the LAN) then HW.

### RX-12 — Custody confirmation only through the Pi loopback API
- **Severity: Medium.**
- **Evidence:** `main.py:283-302`; API bound to 127.0.0.1 by default (`settings.py:124`, `main.py:378-400`); no dashboard UI (grep).
- **Impact:** a person must be logged into the Pi at each stop; otherwise the mission holds at AT_PICKUP/AT_DROP forever (by design).
- **Action:** a product decision: an authenticated dashboard → backend → robot custody confirmation, or a physical button on the rover.
- **Verify:** SW + HW.

### RX-13 — Pi restart mid-mission
- **Severity: Medium.**
- **Evidence:** mission and track in memory (`mission/manager.py`, `backend_link.py` `_tracks`, `_granted_at_ms`); `_held_mission` requires both (`backend_link.py:1707-1723`).
- **Impact:** after a restart there is no heartbeat lease renewal for the commitment (the backend lease expires), no custody or completion reports, and completion is withheld for lack of a track.
- **Action:** persist the active mission and the sent-fix track with the commitment record, or explicitly report abandonment on boot.
- **Verify:** SW.

## C. Integration mismatches

### RX-21 — Unhandled or unemitted events
- `REROUTE_ALERT` emitted to the robot room is unbound on the Pi (`alertDissemination.service.js:101`; Pi catch-all `backend_link.py:909-921`). `OBSTACLE_REPORT` and `ROBOT_FAULT` are handled by the backend (`dtaro.handler.js:115, 329`) but never emitted by the Pi. **Impact:** ESP32 obstacle and fault states are invisible to operators except via status and the stop latch. **Verify:** SW.

### RX-22 — mTLS
- `AGENT_MTLS_REQUIRED=true` refuses pairing and requires client certificates (`robot.handler.js:294-346, 905-915`); the Pi has none. `SESSION_REKEY` is likewise unhandled. **Impact:** latent lockout. **Verify:** SW.

Further contract-level mismatches (documentation copies, the stale capability flag, dead config): see the
[mismatch register](INTERFACE_AND_PROTOCOL_CONTRACTS.md#3-mismatch-register).

## D. Unknowns requiring hardware evidence

| ID | Unknown | Evidence to collect (safely) | HW |
|---|---|---|---|
| RX-04 | Is front sensing valid now? (`8de2162` message: right front ultrasonic "not proper"; `SAFETY_REQUIRE_BOTH_SENSORS 1` → `forward_blocked`) | Pi `/state` → `controller.telemetry.front.valid`, DIAG FRONT `front_right_health`, `front_right_timeout_streak` | yes |
| RX-14 | Do real ESP32 GPS frames pass the Pi validator outdoors; typical `hacc_mm`; `age_ms` | `/state` `.gps`, `.position.h_acc_m`; capture a frame as a fixture (with approval) | yes |
| RX-10 | Is GPS-track heading usable at the rover's real speed; does `NMEA_TRACK` ever engage | `/state` `.position.heading_source` while driving a straight line on a test field | yes |
| RX-23 | Detector false-positive rate while moving | logged `decision.changed` reasons over a supervised drive | yes |
| RX-20 | Physical speed at 0.25/0.45 normalised; ≥5 m within 60 s of acceptance | odometry by GPS track on a test field | yes |
| RX-17 | Deployed Pi commit and service state; flashed firmware revision | read-only SSH: `git -C /opt/robotx/RobotX-Pi rev-parse HEAD`, `systemctl status robotx-agent`; flashed firmware unknowable without a build ID (RX-15) | yes |

### RX-17 — Deployed code unknown
- **Severity: High** (every hardware statement depends on it).
- **Evidence:** SSH refused or required a password today. The deployment guide clones `gate3-pi-proposal` (`docs/operations/V1_PI_DEPLOYMENT.md` §9). That branch does **not** contain `288d26b` (ESP32 GPS validation + accuracy gate), `54b0b12` (RESUME binding) or `98a1220` (verified with `git merge-base --is-ancestor`). The local `gate3-pi-proposal` (`2678b69`) is also behind `origin/gate3-pi-proposal` (`fcd42af`).
- **Action:** read-only inventory of the Pi (runbook §5); update the deployment guide to name the release commit on the integration branch.
- **Acceptance:** a recorded `rev-parse HEAD` of `/opt/robotx/RobotX-Pi` equal to a reviewed commit containing `288d26b`.

## E. Environmental limitations and process

- **RX-15 Firmware identity:** constant `fw:"rover-esp32"` (`comm.cpp:1586`); a required library patch lives outside version control (`rear_tof.cpp:5-13`). Add a build ID (git describe injected at build time) to READY and DIAG SYSTEM; vendor or document the patched library with a checksum.
- **RX-16 Stale material:** `.ino` header limitations, `config.h` "PLACEHOLDER" comments on confirmed addresses, `safety.py:164-171`, `communication/protocol.py:425-428, 689-691`, `ROVER_HARDWARE_ARCHITECTURE.md` orientation table, the Pi `PROTOCOL.md` copy; dead settings `ROBOTX_SOCKET_NAMESPACE`, `ROBOTX_SOCKET_RECONNECT`, `ROBOTX_NAV_TARGET_SPEED_MPS`, Directions settings.
- **RX-19 Windows test portability:** 4 unit + 2 integration failures on Windows (see ledger); tests write under `C:\proc`.
- **RX-18 Repository process:** backend `feature/dashboard` is 5 commits ahead of its remote; linked worktrees exist; the Pi integration branch is not merged to `master` (`master` at `184c42b`).

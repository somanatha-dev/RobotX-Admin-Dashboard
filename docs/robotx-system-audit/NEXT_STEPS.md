# Next Steps — Dependency-Ordered Plan

Snapshot 2026-10-17. No dates are assigned; order follows safety and dependency. Each stage cites the
findings it closes ([blockers](CURRENT_BLOCKERS_AND_RISKS.md)).

## The single immediate next task

**Remove the blocking rear-ToF re-initialisation from the ESP32 control loop, and prove that TELEMETRY
cadence holds while a rear sensor is failing (RX-01).**

- **Why this first:** it is the only finding that stops the safety controller itself from running. The code
  path is confirmed (`rear_tof.cpp:508-527`, `robot_controller.ino:210-212`), and it matches the reported
  freeze tied to channel 1 (`config.h:510` = LEFT). Every later stage needs a controller whose telemetry does
  not stall: link UP, offers accepted, missions not paused.
- **Repository:** ESP32 firmware only.
- **Precondition (read-only, needs Pi access):** with the agent running and the rover stationary, poll the
  Pi `GET /state` at 2–5 Hz for 10 minutes. Confirm that `controller.telemetry_age_s > 1` coincides with
  increments of `controller_diag.REAR.rear_reinit_count[1]` (about every 5 s). If it does not, record what
  does correlate and revisit before changing code.
- **Scope:** stop calling `initOneSelected()` synchronously from `loop()` at runtime. The simplest safe
  option is `REAR_TOF_REINIT_AFTER_MS 0`: a failed sensor stays failed and reverse stays blocked, and recovery
  is a reboot. A bounded alternative is acceptable only if no single call can exceed a fixed budget. Add
  `loop_max_ms` and `last_stall_source` to DIAG SYSTEM. Update `PROTOCOL.md` in both repositories if DIAG
  changes.
- **Tests:** a new host test in `tests/host/test_rear_tof.cpp` (or the simulator) with a VL53L0X fake whose
  `init()` blocks 5 s. Assert no `loop()` pass exceeds 50 ms and TELEMETRY intervals stay ≤ 400 ms over
  30 s stationary. The existing host suite and the Pi `test_esp32_sim_link` must still pass.
- **Hardware verification (on blocks, after approval to flash):** with the channel-1 sensor faulty as today,
  10 min stationary and 10 min driving at low speed. Pi `/state` `communication.esp32` stays `UP`;
  `telemetry_age_s` < 0.4 s throughout; `reverse_blocked:true`; DIAG `loop_max_ms` < 50.
- **Acceptance:** all of the above recorded with the firmware commit hash and the Pi commit hash.
- **Non-goals:** no Pi changes, no threshold tuning, no front-sensor work, no stop-ordering change (that is
  the next task, RX-02).

---

## Stage 0 — Audit and establish a baseline

| Item | Detail |
|---|---|
| Objective | Know exactly what runs on the rover, and be able to observe it without touching the UART |
| Why now | Every hardware statement depends on it (RX-17, RX-15) |
| Repos | A, B (process) |
| Current blocker | SSH refused or password-only; no firmware build identity |
| Prerequisites | Owner restores read-only SSH |
| Scope | Record `/opt/robotx/RobotX-Pi` HEAD and status, the service state, and a 10-min `/state` capture. Update the deployment guide to name the release commit on `integration/robotx-pi-autonomy`. Push or review the backend's 5 unpushed commits. Sync the Pi copies of `PROTOCOL.md` and `test_link.py` (CM-07/08) |
| Tests | none new |
| HW verification | read-only only |
| Acceptance | A baseline record: Pi commit, firmware READY/DIAG SYSTEM, `/state` capture, link status, GPS status |
| Non-goals | No restarts, no flashing, no motion |

## Stage 1 — ESP32 controller-loop reliability and safety

| Item | Detail |
|---|---|
| Objective | The ESP32 loop never blocks; stops never depend on I2C; reverse is never silently ungated |
| Why now | The safety authority must be dependable before anything is layered on it |
| Repos | B (+ Pi doc copies) |
| Findings | RX-01 (immediate task), RX-02, RX-05, RX-06, RX-15 |
| Prerequisites | Stage 0 baseline; host toolchain |
| Scope | (1) RX-01 as above. (2) `stopMotors()`: all direction GPIO low first, then the PCA writes. (3) `SAFETY_BLOCK_REVERSE_WHEN_REAR_UNCONFIGURED 1`. (4) Time-based backoff for repeatedly failing rear-sensor visits. (5) Build ID in READY/DIAG. (6) Decide on a loop watchdog (`enableLoopWDT`) |
| Tests | Host tests for each; simulator link suite; Pi sim-link integration |
| HW verification | On blocks: stop latency with SDA held low (logic analyser); TCA-absent boot blocks reverse; 20-min telemetry cadence |
| Acceptance | Per RX-01/02/05/06 criteria |
| Non-goals | Changing thresholds; Pi behaviour |

## Stage 2 — Verify the UART and GPS contracts on hardware

| Item | Detail |
|---|---|
| Objective | Real frames match the documented contract; GPS fixes pass the Pi validator outdoors |
| Why now | Navigation readiness (Stage 3) assumes a working fix and link |
| Repos | A, B |
| Findings | RX-14, RX-04 (front sensing state) |
| Prerequisites | Stage 1 firmware flashed with a build ID |
| Scope | Capture real TELEMETRY, GPS and DIAG frames (with approval, agent stopped, or via `/state`) into Pi test fixtures, which enables the currently skipped test. Measure `hacc_mm` and `age_ms` distributions. Resolve the right front ultrasonic (repair or replace) and set `SENSOR_MAP_VERIFIED` after the hand test |
| Tests | Fixture-based Pi unit tests; `test_gate3_contract` with the real fields |
| HW verification | Outdoors: 10 min of 1 Hz fixes, more than 95 % valid with `h_acc_m ≤ 5`; both front sensors `valid` for 10 min with obstacle detection at 30–40 cm |
| Acceptance | Fixtures committed; measurements recorded |
| Non-goals | Navigation tuning |

## Stage 3 — Pi localisation and navigation readiness

| Item | Detail |
|---|---|
| Objective | The Pi can follow a short route reliably on a test field |
| Why now | Depends on Stage 2 GPS evidence |
| Repos | A |
| Findings | RX-10, RX-20, RX-08 (counter semantics) |
| Scope | Calibrate normalised speed to m/s; decide `heading_min_speed_mps` relative to the real speed; add heading-readiness to offer feasibility or a pre-departure manoeuvre; fix the blocked-counter decay (RX-08); remove dead config |
| Tests | Unit tests for heading thresholds and the counter; synthetic navigation tests |
| HW verification | 3-waypoint, 50 m route, cross-track p95 ≤ 3 m, 5 repetitions, local `/mission/start` in bench mode (backend link off) |
| Acceptance | As stated, logged with commits |
| Non-goals | Backend integration; obstacle handling beyond the current behaviour |

## Stage 4 — Sensor-informed obstacle handling and safe motion

| Item | Detail |
|---|---|
| Objective | The Pi reacts to measured ranges before the ESP32 gate trips; avoidance never latches the ESP32 |
| Why now | Requires valid front sensing (Stage 2) and stable navigation (Stage 3) |
| Repos | A (+ B if fields change) |
| Findings | RX-07, RX-09, RX-03 (policy), RX-23 |
| Scope | Pass ESP32 front ranges into `SafetyGate.evaluate(obstacle=…)`; set `require_range_sensor` on the rover; speed limit in the warning band; forbid negative wheel commands when `reverse_blocked`; decide an automatic latch-recovery policy for front obstacles (dwell + clear), keeping faults manual; evaluate the detector's false-positive rate while moving |
| Tests | Unit (gate with ranges), simulator (front obstacle appears and clears → automatic recovery as per policy) |
| HW verification | On blocks, then at walking pace: a box at 60 cm → slow; at 35 cm → Pi STOP before the ESP32 latch; removal → resume as per policy |
| Acceptance | No `safety_stop` latch in 10 approach trials; mission continues after the obstacle is removed |
| Non-goals | Rerouting |

## Stage 5 — Mission assignment and lifecycle integration

| Item | Detail |
|---|---|
| Objective | A live backend offers a mission to the real rover and the rover answers correctly |
| Why now | Needs a motion-capable rover (Stages 1–4) |
| Repos | A, C |
| Findings | RX-11, RX-12, RX-13, RX-21 |
| Scope | Commissioning checklist (Pi env incl. motion enable, backend `PHYSICAL_FLEET_*`, declaration, SoC, signing key, clock sync); a dashboard SoC declaration UI; a custody confirmation path not requiring a Pi shell; emit `ROBOT_FAULT`/`OBSTACLE_REPORT` or document their absence; persist the active mission and evidence track |
| Tests | `gate1PhysicalOffer.js` (disposable DB); Pi `gate3_harness.py` against the real backend with the simulator |
| HW verification | Rover stationary, motion enabled on blocks: OFFER → ACCEPT → wheels respond → STOP command → paused/stopped correctly |
| Acceptance | Backend Leg reaches ACCEPTED, then EN_ROUTE on movement; COMMAND round trip ACKed |
| Non-goals | Driving a full delivery |

## Stage 6 — Route planning, rerouting and recovery

| Item | Detail |
|---|---|
| Objective | A blocked or off-route leg is resolved without a silent stall |
| Why now | Only meaningful once Stage 4 avoidance and Stage 5 integration work |
| Repos | A, C |
| Findings | RX-08 (behaviour), CM-01, CM-02 |
| Scope | Decide who replans (backend engine `REROUTE` with a signed new path is the consistent choice); implement the Pi handling of `REROUTE` envelopes (currently a no-op); report `REROUTE_NEEDED` to the backend; time-bounded escalation |
| Tests | Engine and Pi unit tests; simulator scenario with a blocked segment |
| HW verification | A test field with a placed obstacle on the route |
| Acceptance | The leg completes via the new path, or escalates within T s with an operator-visible event |
| Non-goals | Full SLAM or local planning |

## Stage 7 — Controlled physical autonomy tests

| Item | Detail |
|---|---|
| Objective | Supervised autonomous legs on a closed test area |
| Prerequisites | Stages 1–6 |
| Scope | Test protocol: safety observer with a kill switch, geofenced area, speed cap, logging of `/state` and backend observations |
| HW verification | 10 legs of ≥100 m with obstacles; zero ESP32 latch events not caused by real obstacles; zero telemetry gaps > 0.4 s |
| Acceptance | Logged results reviewed and signed off |
| Non-goals | Public spaces |

## Stage 8 — End-to-end mission verification

| Item | Detail |
|---|---|
| Objective | Dashboard task → OFFER → drive → custody (operator) → drive → custody → TASK_COMPLETE → backend COMPLETED |
| Prerequisites | Stage 7 sign-off |
| Tests | Backend verification thresholds set; Pi evidence self-check passes |
| HW verification | 5 complete deliveries; backend Task COMPLETED with SUFFICIENT verification; no operator intervention other than the two custody confirmations |
| Acceptance | Records for each run: commits, configs (names only), logs, backend decision records |
| Non-goals | Unattended operation |

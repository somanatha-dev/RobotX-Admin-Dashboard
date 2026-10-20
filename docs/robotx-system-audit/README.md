# RobotX System Audit — Documentation Index

> **Snapshot warning.** This audit describes three local checkouts as they stood on
> **2026-10-17 (IST, UTC+05:30)**. Every line number and behaviour statement is tied to the
> revisions listed below. Re-verify anything you rely on after any of these repositories
> changes. Nothing here describes the firmware that is flashed on the ESP32 or the code
> deployed on the Raspberry Pi; neither could be inspected (see [Runtime visibility](#runtime-visibility)).

## Purpose and scope

A read-only, evidence-based audit of the three RobotX repositories:

| | Repository | Local path | Role |
|---|---|---|---|
| A | Raspberry Pi agent | `C:\Users\soman\OneDrive\Desktop\RobotX-Pi` | High-level autonomy: localisation, perception, navigation, mission execution, backend link, ESP32 link |
| B | ESP32 firmware | `C:\Users\soman\OneDrive\Documents\Arduino\robot_controller` | Low-level controller: motors, front ultrasonic and rear ToF safety gate, command watchdog, GPS polling, UART protocol v2 |
| C | Backend + dashboard | `C:\Users\soman\OneDrive\Desktop\RobotX` | Express/Socket.IO/Prisma backend with the assignment engine, and a React/Vite dashboard |

No application code, firmware, configuration, test, Git history, service or hardware was changed.
The only files created are the eleven documents in this directory (see [Final validation](#final-validation)).

## Revisions inspected

| Repo | Branch | Commit | Working tree | Remote (credentials none in URL) |
|---|---|---|---|---|
| A | `integration/robotx-pi-autonomy` | `c58f124414e8af9043dfcf2d48f9406b9315e539` | clean; in sync with `origin/integration/robotx-pi-autonomy` | `https://github.com/somanathaB/RobotX.git` |
| B | `main` | `8de21622ca7bfad1aca186987aa24c247ab08cef` | clean; in sync with `origin/main` | `https://github.com/somanatha-dev/ROBOTX---ESP32.git` |
| C | `feature/dashboard` | `de03788cd3e1857aa53fb32de1b902e8e85d9eb5` | clean; **5 commits ahead** of `origin/feature/dashboard` (unpushed) | `https://github.com/somanatha-dev/RobotX-Admin-Dashboard.git` |

The expected Pi branch and commit given in the task brief matched exactly.

## Documents

| # | Document | What it answers |
|---|---|---|
| A | [README.md](README.md) | This index |
| B | [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) | End-to-end architecture, authority boundary, four Mermaid diagrams |
| C | [PI_AGENT_DEEP_DIVE.md](PI_AGENT_DEEP_DIVE.md) | Every Pi subsystem, its data flow, and the explicit capability questions |
| D | [ESP32_FIRMWARE_DEEP_DIVE.md](ESP32_FIRMWARE_DEEP_DIVE.md) | Firmware lifecycle, pins, safety gates, UART, and the rear-ToF freeze analysis |
| E | [BACKEND_DASHBOARD_DEEP_DIVE.md](BACKEND_DASHBOARD_DEEP_DIVE.md) | Robot-facing backend paths, mission lifecycle, dashboard coverage |
| F | [INTERFACE_AND_PROTOCOL_CONTRACTS.md](INTERFACE_AND_PROTOCOL_CONTRACTS.md) | Field-level Backend↔Pi and Pi↔ESP32 contracts and mismatches |
| G | [TESTING_AND_VERIFICATION.md](TESTING_AND_VERIFICATION.md) | Evidence ledger: what was run today, what was not, what each proves |
| H | [CURRENT_BLOCKERS_AND_RISKS.md](CURRENT_BLOCKERS_AND_RISKS.md) | Ranked findings with acceptance criteria |
| I | [AUTONOMY_GAP_ANALYSIS.md](AUTONOMY_GAP_ANALYSIS.md) | The 13-stage autonomy lifecycle, required versus actual |
| J | [DEVELOPMENT_AND_HARDWARE_RUNBOOK.md](DEVELOPMENT_AND_HARDWARE_RUNBOOK.md) | Safe developer workflow, what needs approval, deploy/flash hygiene |
| K | [NEXT_STEPS.md](NEXT_STEPS.md) | Dependency-ordered plan (Stages 0–8) and the single next task |

**Recommended reading order for a new developer:** this README → SYSTEM_ARCHITECTURE →
CURRENT_BLOCKERS_AND_RISKS → INTERFACE_AND_PROTOCOL_CONTRACTS → the deep dive for the repository
you will touch → TESTING_AND_VERIFICATION → DEVELOPMENT_AND_HARDWARE_RUNBOOK → NEXT_STEPS.
AUTONOMY_GAP_ANALYSIS is the best single summary of "how far from autonomous are we".

## Status vocabulary (used identically in every document)

| Status | Meaning |
|---|---|
| **IMPLEMENTED** | Source code provides the behaviour. Says nothing about whether it works. |
| **UNIT-TESTED** | A relevant automated unit test passed (in this audit, or in a cited existing report — the ledger says which). |
| **INTEGRATION-TESTED** | Components were exercised together in software (loopback Socket.IO, host-compiled firmware simulator, cross-repo test vector). |
| **HARDWARE-VERIFIED** | Directly observed on the real rover. In this audit, only claims recorded in source comments or prior reports — none were observed today. |
| **PARTIALLY IMPLEMENTED** | Some of the required behaviour exists; named gaps remain. |
| **BLOCKED** | A named dependency, defect or missing capability prevents progress. |
| **NOT IMPLEMENTED** | Inspection confirms the behaviour is absent. |
| **UNVERIFIED** | Evidence is insufficient either way. |
| **FAILED** | A specific test or check failed. |

## High-level architecture in one paragraph

The backend's assignment engine turns a task into a Leg, commits it to a robot, and emits a
**signed, fenced `OFFER`** over Socket.IO to the robot's room. The Pi agent verifies the HMAC,
fence and sequence, checks its own readiness (ESP32 motion-ready, measured GPS fix within the
accuracy gate, operator custody confirmation enabled) and answers `OFFER_ACCEPT/REJECT`. On
accept it follows the **backend-supplied waypoint paths** (it never plans a route) using a
10 Hz loop: GPS (polled by the ESP32 over I2C, forwarded in `GPS` frames) → position and a
GPS-track heading → waypoint navigation → camera-based decision → Pi safety gate →
`DRIVE`/`STOP` over a CRC-framed UART. The ESP32 independently re-gates every wheel command
against its front ultrasonic and rear ToF sensors and a 2 s command watchdog. Custody at pickup
and drop is confirmed by a human through the Pi's local API; the Pi then reports
`CUSTODY_EVENT`s and a `TASK_COMPLETE` that the backend grades against the measured position track.
See [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md).

## Most important current blockers

Ranked by safety impact and dependency order (full detail, evidence and acceptance criteria in
[CURRENT_BLOCKERS_AND_RISKS.md](CURRENT_BLOCKERS_AND_RISKS.md)):

1. **RX-01 — ESP32 control loop can block for seconds while a rear ToF sensor is re-initialised.**
   `rearTofUpdate()` calls the Pololu `init()` synchronously from `loop()` whenever the wheels are
   stopped (`rear_tof.cpp:518-526`, `robot_controller.ino:210-213`). The source states this can
   last "many seconds". During it, no UART command is read, no telemetry is sent, no front sensor
   is pinged and the watchdog is not evaluated. It is the most likely source-level explanation of the
   reported periodic freeze tied to the rear-left ToF on TCA channel 1 (`config.h:510` maps channel 1
   to `"LEFT"`). The source path is confirmed; that it is the cause on the rover is **UNVERIFIED**.
2. **RX-02 — Stop path depends on I2C before GPIO.** `stopMotors()` writes the PCA9685 before driving
   the L298N direction pins low (`motor.cpp:243-257`); on a hung bus that can delay the cutoff.
   Suspected; needs a bench fault-injection test.
3. **RX-03 — Every ESP32 safety stop needs a human.** The ESP32 latches `safety_stop`; the Pi refuses to
   send `DRIVE` while it is set and pauses the mission (`link.py:684-691`, `agent.py:845-856`). Recovery is
   operator `RESET` + `RESUME`. **INTEGRATION-TESTED** against the host-compiled firmware today.
4. **RX-04 — Front sensing may be unusable.** The last firmware commit message reports the right front
   ultrasonic "was not proper"; with `SAFETY_REQUIRE_BOTH_SENSORS 1` that blocks all forward motion.
   Current hardware state **UNVERIFIED**.
5. **RX-07/RX-08 — No sensor-informed navigation and no rerouting.** The Pi's safety gate is never given a
   range reading (`agent.py:901-905`). A camera "obstacle" stop for about 0.3 s puts the leg into
   `REROUTE_NEEDED` permanently (`route_planner.py:364-365`, `agent.py:933-934`), and nothing anywhere
   re-plans an engine-managed route.
6. **RX-11 — Deployment configuration rejects every offer.** The documented V1 Pi environment sets
   `ROBOTX_ESP32_MOTION_ENABLED=0`, so `assess_offer` answers `NO_MOTOR_LINK`. The backend example ships
   with `PHYSICAL_FLEET_ENABLED=false` and needs an owner declaration file, an API-only SoC declaration and
   a manually shared `COMMAND_SIGNING_KEY`.
7. **RX-17 — Deployed code is unknown.** The deployment guide clones `gate3-pi-proposal`, which lacks
   today's GPS-validation and RESUME-binding fixes (`288d26b`, `54b0b12`). SSH was unavailable, so what
   actually runs is unknown. There is no firmware build identifier.

**The rover is not autonomous today.** The software path from offer to completion exists and is
covered in simulation, but on the physical rover no autonomous mission has been evidenced, and two
operator interventions per delivery (custody at each stop) are required by design.

## Which conclusions rest on what

| Evidence class | Examples in this audit |
|---|---|
| Source inspection (most findings) | All behaviour statements with `file:line` references |
| Tests run today (2026-10-17, Windows 11, Python 3.13.5, MinGW g++, Node) | Pi unit 1000 tests (4 failed, 1 skipped); Pi integration 61 (2 failed, 6 skipped) plus simulator link 6/6 passed; ESP32 host suite all passed; backend targeted 40 suites / 791 tests passed; cross-repo OFFER signature vector reproduced |
| Prior reports and source comments (not re-observed) | Motor map verified on blocks 2026-10-02 (`config.h:261-300`); VL53L0X divide-by-zero crash captured on the rover 2026-10-02 (`rear_tof.cpp:5-10`); Gate 3/3b against the real backend with the ESP32 simulator (Pi `README.md`) |
| Hardware observed today | **None.** No serial port, motor, sensor or service was touched. |

## Runtime visibility

- SSH alias `robotx-pi` (LAN host from `~/.ssh/config`, user `pi`) refused the connection; `raspberrypi.local` required a
  password (non-interactive mode). No troubleshooting was attempted. **Deployed commit, service state,
  UART ownership and live telemetry are therefore UNVERIFIED.**
- The development path `/home/pi/Desktop/RobotX-Pi` and the deployed path `/opt/robotx/RobotX-Pi` are
  **previously reported, not verified** (the latter is what `deployment/robotx-agent.service` and
  `docs/operations/V1_PI_DEPLOYMENT.md` assume).

## Final validation

Recorded at the end of the audit (see the closing message of the session for the exact commands):

- Git state of all three repositories before and after was identical. The only new files are this
  directory's eleven `.md` files, which are untracked in repository C.
- Test runs wrote only to temporary or scratch locations, with one exception. The Pi unit suite on Windows
  rewrote `C:\proc\definitely\not\writable\session.json`, a dummy test token. That directory already
  existed from an earlier run on 2026-10-03, and the test assumes `/proc` is unwritable, which is only
  true on Linux. See [TESTING_AND_VERIFICATION.md](TESTING_AND_VERIFICATION.md).
- No secrets are reproduced. Environment variables are named, never valued, except non-secret thresholds
  copied from `Backend/.env.example`.

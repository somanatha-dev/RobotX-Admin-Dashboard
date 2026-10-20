# ESP32 Firmware — Deep Dive

Repository B: `C:\Users\soman\OneDrive\Documents\Arduino\robot_controller` · branch `main` · commit
`8de2162` (2026-10-03). Arduino sketch, C++ (gnu++11 in host tests). Paths are relative to the
repository root. **This describes the source checkout, not the firmware flashed on the rover.**
Nothing links the two (see [§12](#12-build-flash-and-firmware-identity)).

## 1. Files

| File | Lines | Role |
|---|---|---|
| `robot_controller.ino` | 331 | `setup()` / `loop()` orchestration |
| `config.h` | 1067 | Every pin, address, threshold and policy switch, with commissioning notes |
| `comm.cpp/.h` | 1936 / 151 | Line reader, command dispatch and validation, motion application, TELEMETRY/DIAG/GPS/EVENT emission, diagnostics commands |
| `protocol.cpp/.h` | 400 / 133 | Frame parser (strict flat JSON), CRC-16, sequence distance, frame writer. `PROTO_VERSION 2` (`protocol.h:29`) |
| `safety.cpp/.h` | 1009 / 189 | Front HC-SR04 sampling and hysteresis, rear latch, direction-aware gate |
| `rear_tof.cpp/.h` | 867 / 203 | Three VL53L0X behind the TCA9548A: init, continuous-mode service, BUS_ERROR demotion, runtime re-init |
| `motor.cpp/.h` | 360 / 132 | L298N direction GPIO + PCA9685 enable PWM, differential drive, MOTORTEST |
| `pca9685.cpp`, `tca9548a.cpp`, `rover_i2c.cpp` | 295 / 208 / 341 | I2C device drivers and the single `Wire` owner |
| `gps.cpp/.h` | 387 / 103 | Bounded UBX-NAV-PVT polling of the u-blox receiver at 0x42 (reporting only) |
| `PROTOCOL.md` | 410 | Pi⇄ESP32 protocol v2 specification (this copy is newer than the Pi repo's copy) |
| `ROVER_HARDWARE_ARCHITECTURE.md`, `HARDWARE_REAR_IR_IDENTIFICATION.md`, `REAR_IR_HARDWARE_INSPECTION_CHECKLIST.md` | — | Hardware notes dated 2026-09-24. Some statements are now out of date versus `config.h` (e.g. rear orientation "NOT CONFIRMED" vs `REAR_TOF_ORIENTATION_VERIFIED 1`) |
| `tests/` | — | Host build of the real sketch (`tests/host/*`), Python link tests (`tests/test_link.py`, `tests/rover_link.py`), runner `tests/run_host_tests.py` |

## 2. Target and build environment

- Board: "ESP32 Dev Module (ESP32-WROOM-32 class)", core **esp32 by Espressif 2.0.14**, upload 921600 (`robot_controller.ino:5-11`).
- Libraries: **Pololu VL53L0X**, with a required local one-line patch (`VL53L0X_ROVER_VCSEL_ZERO_GUARD`, enforced by `#error` at `rear_tof.cpp:11-13`), and **SparkFun u-blox GNSS v2.x** (tested 2.2.29) (`robot_controller.ino:13-19`). The patched library lives outside this repository (the sketchbook's `libraries/VL53L0X`). The host test `test_vl53_guard` compiled against the installed copy and passed today, so the *locally installed* copy carries the guard. That it is the copy used for the flashed build is **UNVERIFIED**.
- `.gitignore` covers only Python bytecode. There is no build configuration file (Arduino IDE settings are not in the repository).

## 3. Lifecycle

`setup()` (`robot_controller.ino:98-182`):

1. `roverI2cInit()`: `Wire.begin(21, 22, 100 kHz)`, `Wire.setTimeOut(50 ms)` (`rover_i2c.cpp:22-36`).
2. `tcaInit()`: all mux channels deselected.
3. `motorInit()` + `stopMotors()`: direction pins LOW, PCA9685 all-off, then frequency.
4. UART: TX buffer 3072, RX buffer 1024, `Serial.begin(115200)` (`config.h:826, 854, 870`).
5. `safetyInit()`: front pins, then **`rearTofInit()`**, which initialises each VL53L0X in turn behind its channel with up to 3 attempts (`rear_tof.cpp:258-333`).
6. `gpsInit()`: `begin(maxWait 0)`, no waiting.
7. `commInit()`, `commEmitReady()` (`EVENT READY`).
8. One-shot boot I2C scan if `I2C_BOOT_SCAN 1` (`config.h:967`). Per `config.h:948-962`, a stuck bus makes the scan take ~1 s per address (~2 minutes). The Pi link's CONNECTING text mentions this (`link.py:646`).

`loop()` (`robot_controller.ino:185-331`), in order: `commPoll` → `rearTofSetReinitPermitted(applied L==0 && applied R==0 && !MOTORTEST)` → `safetyUpdate` → `commPoll` → MOTORTEST branch → watchdog → gate → `driveDifferential` → `commUpdateRuntime` → `commServiceTelemetry` → `gpsUpdate` → `delay(1)`.

## 4. Pins, buses and devices

| Function | Pins / address | Confirmation (per `config.h`) |
|---|---|---|
| L298N "FRONT" board IN1–IN4 | GPIO23, 25, 26, 27 | wiring |
| L298N "REAR" board IN1–IN4 | GPIO32, 33, 16, 17 | wiring |
| HC-SR04 A (labelled FRONT_LEFT) | TRIG 13 / ECHO 14 | side map **unverified** (`SENSOR_MAP_VERIFIED 0`, `config.h:356`) |
| HC-SR04 B (labelled FRONT_RIGHT) | TRIG 18 / ECHO 19 | same |
| I2C | SDA 21 / SCL 22, 100 kHz, 50 ms timeout | — |
| TCA9548A | 0x71, `TCA9548A_ADDRESS_CONFIRMED 1` | The comment block above still calls it a "PLACEHOLDER" (`config.h:142-160`); the flag says confirmed |
| VL53L0X × 3 | 0x29 on TCA ch 0/1/2 | orientation verified: ch0 CENTRE, **ch1 LEFT**, ch2 RIGHT (`config.h:504-511`) |
| PCA9685 | 0x40, `PCA9685_ADDRESS_CONFIRMED 1`, 1000 Hz, CH0–CH3 → ENA/ENB | same stale "PLACEHOLDER" comment (`config.h:180-191`) |
| u-blox GNSS | 0x42 | — |
| Encoders | GPIO34, 35, 36, 39 | reserved; **never configured or read** (`config.h:98-109`) |

The `.ino` header "KNOWN LIMITATIONS" (`robot_controller.ino:51-82`) still describes the TCA and PCA as
unconfirmed and the motor map as unverified. `config.h` now says otherwise. Treat the header as stale.

## 5. Motor mapping and drive

- Mapping **VERIFIED 2026-10-02 with MOTORTEST on blocks** per `config.h:261-300`: channel 0 rear-left, 1 rear-right, 2 front-right, 3 front-left, all `INVERT 1`. Recorded as HARDWARE-VERIFIED **in the source comment**, not re-observed.
- `driveDifferential(l, r)` (`motor.cpp:218-241`): refuses without PCA9685, clamps to ±255, deadband |v| < 40 → 0 (`config.h:395`), drives both motors of a side identically.
- `writeChannel` (`motor.cpp:122-143`): enable 0 via I2C → direction GPIO → enable duty via I2C.
- `stopMotors()` (`motor.cpp:243-257`): `pca9685AllOff()` (I2C) **first**, then for each motor IN1=IN2=LOW (GPIO) followed by a per-channel duty-0 write (I2C). See RX-02 in [blockers](CURRENT_BLOCKERS_AND_RISKS.md).

## 6. Safety gate and motor authority

**Front (forward) gate** (`safety.cpp:690-740, 848-886`):

- One HC-SR04 is pinged every 30 ms, alternating, so each sensor every ~60 ms. `pulseIn` timeout is 20 ms (`config.h:418, 433`).
- 5-sample window, median of ≥3 good samples, stale after 1 s, spike filter (60 cm jump, confirm 2).
- Hysteresis: stop ≤ 40 cm (2 confirmations), clear ≥ 65 cm (4), warn ≤ 90 cm (`config.h:738-749`). Distances use a fixed 343 m/s and are **uncalibrated** (`robot_controller.ino:78-82`).
- `safetySensorFault()` = **not both valid**, because `SAFETY_REQUIRE_BOTH_SENSORS 1` (`config.h:775`, `safety.cpp:858-870`). `forward_blocked = obstacle || sensorFault`.

**Rear (reverse) gate** (`safety.cpp:418-578, 888-900`):

- Rear latch per sensor: stop ≤ 250 mm (2), clear ≥ 400 mm (4), warn ≤ 600 mm, labelled "COMMISSIONING VALUES" (`config.h:640-655`). An invalid sensor leaves its latch untouched.
- `REAR_REQUIRE_ALL_SENSORS 1`: any one invalid rear sensor means `rear_sensor_fault`, so reverse is blocked (`config.h:675`, `safety.cpp:552-578`).
- **If the rear backend never came up** (TCA absent or no sensor initialised at boot): `SAFETY_BLOCK_REVERSE_WHEN_REAR_UNCONFIGURED 0` → **reverse is permitted unguarded** (`config.h:691`, `safety.cpp:888-900`). "Backend up" is sticky for the boot once any sensor initialised (`rear_tof.cpp:537-552`), so a runtime loss reads as a fault (blocked), not as unconfigured.

**Direction-aware gate** `safetyGateMotion` (`safety.cpp:934-958`): per wheel, positive is front-gated and
negative is rear-gated. `SAFETY_GATE_MODE_COMPONENT` (`config.h:799`) clamps only the offending wheel.

**On a block** (`robot_controller.ino:283-298`, `comm.cpp:640-660`): with `SAFETY_CLEAR_COMMAND_ON_BLOCK 1`
(`config.h:811`) the *whole* stored command is cleared (both wheels to 0) and `safety_stop` is latched. The
latch clears only on `RESET` or on a new movement command that passes the gate cleanly (`comm.cpp:662-677,
879-898`). `STOP` does not clear it (`comm.cpp:684-697`).

**Interaction with the Pi (confirmed by integration test today):** the Pi refuses to send `DRIVE` while
`safety_stop` is true (`robotx/esp32/link.py:684-691`), so the latch can only be cleared by an operator
`RESET`. The simulator-link test passed:
"Obstacle -> GATED -> safety_stop -> PAUSED -> RESET -> clear, still PAUSED -> RESUME -> gated again".

## 7. Watchdog, UART and command handling

- **Watchdog:** after any valid movement command has ever been received, more than 2000 ms without `DRIVE`/`MOVE`/`STOP` zeroes the command, stops the motors and sets `command_timeout` (`robot_controller.ino:242-248`, `config.h:824`). `PING`, `RESET`, garbage and unknown commands do not refresh it. Cleared by the next movement command (`comm.cpp:604-611, 684-693`). RESET clears it but does not refresh the timer (`comm.cpp:879-898`). Host tests measured `watchdog_fired_after_s ≈ 2.003–2.005` today.
- **Line reader** `commPoll` (`comm.cpp:1538-1573`): bytes accumulate to `\n`. A line over 160 bytes is discarded whole and answered `FRAME_TOO_LONG`.
- **Validation order** `handleCommand` (`comm.cpp:1390-1531`): frame/CRC → syntax → envelope (`seq` 1..65535, `type == "COMMAND"`, `cmd` string) → sequence (same seq = `DUPLICATE`; more than 32767 behind = `REJECTED STALE_SEQ` with `last_seq`) → per-command fields.
- **Commands:** `STOP`, `DRIVE{left,right}`, `MOVE{dir,speed}` (legacy), `MOTORTEST{motor,power,ms,onblocks:true}` (bypasses the safety gate, ≤3000 ms), `RESET`, `PING`, and with `DIAGNOSTICS_ENABLED 1` also `I2CSCAN`, `I2CSTATUS`, `TCATEST`, `PCATEST`, `TOFTEST`, `HWREPORT`. `I2CSCAN` is refused while the motors are driven (`I2C_SCAN_REQUIRE_STOPPED 1`). The Pi can encode only `PING`/`STOP`/`DRIVE`/`RESET`.
- **ACK** for motion carries `req_*`, `gated_*`, `applied_*` (`comm.cpp:595-602`). `PING` ACK carries `state`, `uptime_ms`, `proto` (`comm.cpp:901-908`).

## 8. The rear ToF freeze analysis

**Reported symptom (from the task brief):** a periodic controller freeze associated with a repeatedly failing
rear-left ToF on TCA channel 1. `config.h:510` maps channel 1 to `"LEFT"`, which is consistent.

**Source path that can block the whole loop** (all confirmed by reading):

1. A sensor that failed boot init stays `initialised=false`. A sensor that initialised but then hits 50 consecutive VL53L0X-transaction BUS_ERRORs is demoted to `initialised=false` (`rear_tof.cpp:488-507`, `config.h:623`).
2. On each visit to a non-initialised sensor, if `gReinitPermitted` and at least 5000 ms since the last attempt (`config.h:607`), `rearTofUpdate()` calls **`initOneSelected(s)` synchronously** (`rear_tof.cpp:508-527`).
3. `initOneSelected` runs up to 3 attempts of the Pololu `dev.init()` plus `setMeasurementTimingBudget()` (`rear_tof.cpp:203-251`). `REAR_TOF_INIT_SLOW_MS` (500 ms) is checked only **after** `init()` returns. It stops further attempts but cannot shorten the one that is running.
4. `config.h:596-600` and `:948-962` state that a hung ESP-IDF I2C transaction waits about 1 s or more each, and that `Wire.setTimeOut(50)` does not shorten it. The library's `init()` performs hundreds of register transactions (`rear_tof.cpp:24-29`), and its own polling loops use a 100 ms I/O timeout (`config.h:538`). The firmware's own comments say a faulty sensor "can hold one library init() on the bus for many seconds, and nothing can cut it short" (`rear_tof.cpp:515-517`; also `robot_controller.ino:206-208`).
5. `gReinitPermitted` is true whenever both *applied* outputs are zero (`robot_controller.ino:210-212`). That is always the case when the rover is idle, paused, gated or stopping.

**What is blocked while `initOneSelected` runs** (single-threaded `loop()`):

| Function | Blocked? | Why |
|---|---|---|
| UART command reception | **Yes** (bytes buffer in the 1024-byte RX ring; ~89 ms of full-rate traffic per `robot_controller.ino:133-136`; the Pi's 10 Hz STOP/DRIVE stream is ~0.5 KB/s, so roughly 2 s before overflow) | `commPoll` not called |
| Telemetry transmission | **Yes** — no TELEMETRY, DIAG or GPS frames | `commServiceTelemetry` not called |
| Front sensor updates | **Yes** | `safetyUpdate` is the caller |
| Command-timeout enforcement | **Yes** (not evaluated) | watchdog code is later in `loop()` |
| Motor safety processing | Not evaluated, **but** re-init only starts with applied outputs at zero, so the motors are already stopped and nothing changes them until `loop()` resumes | `robot_controller.ino:210-212` |
| GPS polling | **Yes** | `gpsUpdate` not called |

**Effect seen by the Pi** (source-derived): TELEMETRY older than 1.0 s → link `STALE` (`link.py:618-635`).
An AUTO mission is paused (`agent.py:843-856`). An OFFER arriving in the window is rejected `NO_MOTOR_LINK`.
Missed PING ACKs can push the link to `DEGRADED`. After the block, queued commands are processed and stale
STOPs are harmless. Because re-init is attempted at most every 5 s from the *start* of the previous attempt,
an init that takes ≥ 5 s makes the loop blocked almost continuously while stationary.

**A second, smaller stall path:** an *initialised* sensor that fails each visit with a BUS_ERROR costs one
failing transaction per visit (`rear_tof.cpp:350-355`). That is about 50 ms with a normal NACK timeout, or
≥1 s on a hung bus, and it runs **while driving too** (the demotion and service path is not gated by
`gReinitPermitted`). Combined with BUS_ERROR on `tcaSelectChannel`, which is also recorded per visit, a hung
bus would also slow the front sensor cadence and the safety gate.

**History:** the "only while no wheel is driven" gate and `REAR_TOF_INIT_SLOW_MS` were added in `8de2162`
(2026-10-03). That commit moved the blocking to stationary periods; it did not remove it. The same commit
records a divide-by-zero crash and reboot captured on the rover on 2026-10-02, caused by a failed read inside
the library (`rear_tof.cpp:5-10`).

**Conclusion:** source code proves a path that blocks every function of `loop()` for an unbounded multi-second
time while a rear sensor is failing and the rover is stationary. That it is *the* cause of the observed
freeze is **UNVERIFIED**. The source does not prove the failure mode of the physical channel-1 sensor (NACK
versus stuck bus versus brown-out).

**Safest way to confirm later (no flashing, no second serial opener):**

1. On the Pi, with the agent running, read `GET /state` on the loopback API repeatedly (read-only HTTP to the
   agent, which already owns the UART). Record `controller.telemetry_age_s`, `communication.esp32`, and the
   DIAG REAR fields `rear_reinit_count`, `rear_reinit_result`, `rear_bus_err_total`, `rear_bus_err_site`,
   `rear_sensor_status` for index 1.
2. Confirm cause: telemetry gaps of more than 1 s should line up with increments of `rear_reinit_count[1]`
   about every 5 s while stationary, and should be absent while driving.
3. If confirmed, a firmware change (see [NEXT_STEPS](NEXT_STEPS.md)) can be validated first in the host
   simulator with a scripted slow VL53L0X (`tests/host/test_rear_tof.cpp` already scripts sensors), then
   on blocks.

## 9. Telemetry, diagnostics and faults

- TELEMETRY every 200 ms (`comm.cpp:1634-1681`), about 530–560 bytes (host test). The full field list is in [contracts §2](INTERFACE_AND_PROTOCOL_CONTRACTS.md#2-pi--esp32-uart-contract).
- DIAG rotates FRONT, REAR and SYSTEM, one section every second fast frame, 100 ms after it (`comm.cpp:1843-1876`). REAR carries the BUS_ERROR evidence and the re-init counters (`comm.cpp:1706-1784`). SYSTEM carries `proto`, device status and link counters (`comm.cpp:1786-1811`).
- GPS frame every 1000 ms, never in the same pass as TELEMETRY/DIAG (`comm.cpp:1866-1873`).
- ERROR frames are rate-limited to 10/s (`config.h:845`).
- EVENTs: `READY` (fw `"rover-esp32"`, core, proto, device status), `COMMAND_TIMEOUT`, `MOTORTEST_DONE`, `I2CSCAN`.
- Measured in host simulation today: fast frame wire time ≈ 47–49 ms per 200 ms; link utilisation ≈ 40–42 % (test traffic included).

## 10. Blocking operations inventory

| Operation | Bound | Where |
|---|---|---|
| `pulseIn` per front ping | ≤ 20 ms | `safety.cpp:168` |
| Rear sensor service, healthy | short register reads | `rear_tof.cpp:344-428` |
| Rear sensor service, failing transaction | `I2C_TIMEOUT_MS` 50 ms, or ≥1 s on a hung bus per `config.h` | same |
| **Rear sensor runtime re-init** | **unbounded, multi-second** | `rear_tof.cpp:518-526` |
| Boot rear init | 3 sensors × up to 3 attempts, unbounded per attempt | `rear_tof.cpp:308-325` |
| Boot I2C scan | < 100 ms healthy; ~2 min stuck | `config.h:948-967` |
| GPS service | capped at 128 bytes per pass; a call over 100 ms triggers backoff (5 s → 300 s) | `gps.cpp:76-133, 250-273` |
| PCA9685 writes in `stopMotors`/`writeChannel` | 50 ms, or ≥1 s hung | `motor.cpp:122-143, 243-257` |
| `TOFTEST` (diagnostic) | synchronous single-shot range read | `rear_tof.cpp:817-867` |
| TX of a frame | non-blocking while the 3072-byte TX buffer has space | `config.h:854` |

## 11. Fault recovery behaviour

- Reboot: motors are held off from `setup()` onward; the Pi detects the reboot and latches its e-stop.
- `safety_stop` latch: `RESET` or a clean DRIVE.
- `command_timeout`: the next movement command, or RESET (which re-asserts unless a movement command follows).
- Rear sensor: demotion, then 5 s-throttled re-init (blocking; see §8).
- GPS: exponential backoff on bus error or slow call.
- No hardware or ESP-IDF task watchdog configuration was found in the sketch (no `enableLoopWDT` or `esp_task_wdt_*`; grep). Whether a multi-second block trips a watchdog reset on the real core is **UNVERIFIED**.

## 12. Build, flash and firmware identity

- Host tests: `python tests/run_host_tests.py [--cxx g++] [--build-dir DIR]` builds the protocol unit tests, a host simulator of the real sketch, the rear ToF, GPS and VL53L0X guard tests into a temp directory and runs them (`tests/run_host_tests.py:1-29`). **Run today: all passed** (see [ledger](TESTING_AND_VERIFICATION.md)).
- Device build and flash: Arduino IDE / arduino-cli with the board and libraries above. **Not performed in this audit.**
- **Identity:** `READY` reports a constant `fw: "rover-esp32"` and `core: "2.0.14"` (`comm.cpp:1580-1602`). There is no git hash, build time or version number in any frame (grep for `__DATE__`, `GIT_`, `BUILD` found nothing). **No evidence links the flashed binary to `8de2162` or to any commit.** See the runbook for a proposed pre-flash identity procedure.

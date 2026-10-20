# Testing and Verification — Evidence Ledger

Everything marked **RUN 2026-10-17** was executed during this audit on the developer laptop:
Windows 11 Home 10.0.26300, Python 3.13.5 (the Pi repo's existing `venv/`: python-socketio 5.11.4,
python-engineio 4.14.0, **aiohttp 3.14.3** against the pinned 3.14.4, **no OpenCV**), MinGW g++ 6.3.0,
Node 22.17.0, Jest 30.4.1. No serial port, motor, sensor, Pi, ESP32, database or remote service was
involved. Anything not marked RUN is **NOT RUN**; its result is not inferred.

> **A connection is not a mission.** A passing Socket.IO handshake, a GPS frame decoded, or an ESP32
> ACK proves only that layer. No row in this ledger shows a physical rover completing an autonomous
> mission. The highest level reached anywhere is software integration with a host-compiled ESP32
> simulator.

## 1. Static inspection (this audit)

| Check | What it establishes | What it does not | Result |
|---|---|---|---|
| Full read of Pi agent runtime modules (`application`, `esp32`, `localization`, `navigation`, `control`, `mission`, `communication`, key `perception`) | Behaviour as coded, file:line evidence for every deep-dive claim | Runtime behaviour, hardware behaviour | Done |
| Full read of firmware `*.ino`, `rear_tof.cpp`, `safety.cpp` (gate, init, update), `comm.cpp` (dispatch, motion, telemetry), `gps.cpp`, `motor.cpp`, `config.h` constants | Same, for the checkout at `8de2162` | That the flashed binary matches | Done |
| Backend robot-facing handlers and services (sockets, dispatcher, physical policy, leg progress, completion, routes) | Contract and lifecycle as coded | Engine economics, the deployed configuration | Done (targeted) |
| Grep: Pi use of ESP32 range fields outside `robotx/esp32/` | No navigation or safety use | — | none found |
| Grep: firmware build identity (`__DATE__`, `GIT_`, `BUILD`) | No build identity emitted | — | none found |
| Grep: firmware task watchdog (`enableLoopWDT`, `esp_task_wdt`, `WDT`) | No explicit watchdog configuration | Core defaults on hardware | none found |
| Diff of shared files across repos A and B | `rover_link.py` identical; `PROTOCOL.md` and `test_link.py` differ (A is older) | — | see CM-07/08 |
| Branch ancestry (repo A): `288d26b`, `54b0b12`, `98a1220` in `origin/gate3-pi-proposal`? | The documented deploy branch lacks those fixes | What is actually deployed | **no** for all three |

## 2. Unit tests

| Repo | Command | Proves | Does not prove | Result | Notes |
|---|---|---|---|---|---|
| A | `venv\Scripts\python.exe -m unittest discover -s tests/unit -t .` (with `PYTHONDONTWRITEBYTECODE=1`) | Pure logic: protocol codecs, ESP32 link state machine with fake ports, GPS adapter, navigation, decision, safety gate, mission manager, engine admission and signing, backend link with a fake client, local API admission | Real serial timing, real GPS, the camera, the backend | **RUN 2026-10-17: 1000 tests, 4 FAILED, 1 skipped (35.3 s)** | Failures, all Windows-specific: (1) `test_auth_and_commissioning.TestTokenStore.test_an_unwritable_location_is_reported_not_raised` — `/proc/...` is writable on Windows; (2) `…test_file_is_not_readable_by_other_accounts` — expects mode 0600 (got 0666); (3) `test_engine_offer.T15DuplicateOffer.test_a_restart_does_not_answer_twice` — same 0600 check; (4) `test_engine_offer.TestAdmission.test_marks_that_cannot_be_persisted_mean_no_action` — `/proc/robotx-test/...` is writable on Windows, so persistence succeeded. Skip: `test_esp32_gps_path.py:74` "no real GPS frame has been captured yet". **Linux result not established today.** |
| B | `python tests/run_host_tests.py --build-dir <scratch>` (protocol unit part) | CRC, flat-JSON parser, sequence distance | — | **RUN: 92 passed, 0 failed** | — |
| B | same runner: `test_rear_tof` | Rear ToF recovery logic against a fake TCA and scripted VL53L0X: demotion, re-init throttle, validity, latches | **That a real init() returns quickly** (fakes return immediately) | **RUN: 17 tests, 285 checks, 0 failed** | Does not exercise a multi-second init |
| B | same runner: `test_gps` | Bounded polling, backoff, frame fields, stale/NO_FIX rules, 0xFF filler | Real u-blox behaviour | **RUN: 390 checks, 0 failed** | Example frame printed matches the PI parser's expectations |
| B | same runner: `test_vl53_guard` (compiled against the *installed* Pololu library) | The local library has the VCSEL divide-by-zero guard | That the flashed build used this copy | **RUN: 5 tests, 13 checks, 0 failed** | — |
| C | `npx jest --runInBand --forceExit tests/engine/physical tests/engine/offerSignatureCanonical tests/engine/dispatchOffers tests/engine/completionIdentityMapping tests/integration/robotCommandRoundTrip tests/unit/sockets tests/unit/tasks/dtaroHandlerTaskComplete tests/unit/tasks/robotsControllerCommand tests/unit/telemetry tests/unit/robots` | Robot-facing handlers with mocked Prisma and an in-memory KV: AUTH and pairing, telemetry and stop-latch ingestion, offer responses, command round trip, completion handling, physical candidate rules | Real database transactions, a real Pi | **RUN: 40 suites, 791 tests, all passed (83 s)** | Tests force an unreachable DB URL and `ENGINE_ENABLED=false` by default (`tests/setup/env.js`) |
| C | full `npm test` (5 lanes incl. chaos, scale), `npm run gates` | — | — | **NOT RUN** | Slow lanes; not required for the robot contract |

## 3. Integration tests (software)

| Repo | Command | Proves | Does not prove | Result |
|---|---|---|---|---|
| A | `python -m unittest tests.integration.test_socketio_transport tests.integration.test_local_api_bind` | The real python-socketio client against a loopback python-socketio server: AUTH flow, client headers, reconnect, durability of reports, local API bind | The Node backend's behaviour; real network | **RUN 2026-10-17: 55 run, 2 FAILED** — `TestBackendUnavailable.test_agent_survives_a_backend_that_is_down_at_startup` (`connect_failures` 0) and `…test_link_connects_once_the_backend_appears` (status CONNECTING, expected DISCONNECTED). Both concern connection-refused timing; a Windows platform effect is suspected, not proven |
| A + B | `ROBOTX_ESP32_SIMULATOR_EXE=<scratch>\rover_sim.exe python -m unittest tests.integration.test_esp32_sim_link -v` (simulator built from repo B today) | The PI `Esp32Link` against the **real firmware sources compiled for the host**: bring-up to UP and motion-ready, DRIVE accepted with applied output in telemetry, watchdog stops output when the Pi goes silent, STALE detection, ESP32-loss detection, and the obstacle → GATED → safety_stop → PAUSED → RESET → still PAUSED → RESUME path | Real UART electrical behaviour, real sensors, real I2C timing | **RUN: 6/6 passed (17 s)** |
| B | `run_host_tests.py` link runs: `tests/test_link.py --sim rover_sim.exe` × 3 configurations | Protocol v2 conformance of the compiled sketch: framing, CRC, validation order, sequence, PING, RESET, watchdog (fired at 2.003–2.005 s), telemetry size (fast frame 528–562 bytes, about 47–49 ms wire time), obstacle no-auto-resume, gated mixed command produces no output | Hardware | **RUN: 24+26+24 passed; 2 skips in two configurations by design** (they need the front-distance file) |
| A + C | Cross-repo signature vector (scratch script reading `RobotX/docs/contracts/fixtures/offer-signature-test-vector.json` and calling the Pi's `robotx.communication.engine`) | The Pi's canonical string and HMAC equal the backend fixture byte for byte | That the deployed keys match | **RUN: canonical identical (1203 chars), signature identical, `verify_signature` admits** |
| A | `tests/integration/gate3_harness.py` (Pi agent ↔ real backend ↔ ESP32 simulator) | End-to-end offer → accept → drive (simulated) → custody → completion | Hardware | **NOT RUN** (needs a running backend and database). Pi `README.md` reports it passed (Gate 3/3b) — previously reported |
| A | `tests/integration/soak_backend_link.py` | Long-running link stability | — | **NOT RUN** |
| C | `node tools/verify/gate1PhysicalOffer.js --database-url <disposable>` | A declared physical robot receives a verifiable OFFER | Hardware | **NOT RUN** (needs a disposable database) |

## 4. Protocol tests

Covered above. Pi-side `tests/unit/test_esp32_protocol.py` cross-checks `robotx/esp32/protocol.py` against
the reference `rover_link.py` (in the unit run). The FW `tests/test_link.py` is the conformance suite. Note
CM-08: the **Pi repo's** root `test_link.py` is an older copy and was not run (it opens a real UART when given
`--port`).

## 5. Simulation

| Asset | Status |
|---|---|
| ESP32 host simulator (`tests/host/sim_main.cpp`, `sim_hw.cpp` + real sketch sources) | Built and exercised today (above) |
| Backend virtual fleet (`src/simulation/*`, `ENABLE_VIRTUAL_SIMULATOR`) | Exists; **NOT RUN** |
| Navigation synthetic tests (`tests/unit/test_navigation_synthetic.py`) | In the unit run (passed) |

## 6. Hardware evidence (none observed today)

| Claim | Source | Date | Classification |
|---|---|---|---|
| Motor map and polarity verified with MOTORTEST on blocks | `config.h:261-300` | 2026-10-02 | HARDWARE-VERIFIED **per source comment** |
| VL53L0X divide-by-zero crash and reboot captured on the rover | `rear_tof.cpp:5-10` | 2026-10-02 | HARDWARE observation per comment |
| "motor wheels were rotating but the ultrasonic sensor on right of front side was not proper" | FW commit `8de2162` message | 2026-10-03 | Anecdotal; current state UNVERIFIED |
| EVENT I2CSCAN without `uptime_ms` captured on the Pi | PI `esp32/protocol.py:139-142` | 2026-09-25 | Prior capture |
| Physical PING RTT ~17–19 ms | PI `esp32/link.py:102` comment | — | Prior measurement, not re-observed |
| Camera 18.69 fps / 60 s, 0 stalls; GPS serial port opened | PI `ROBOTX_PI_CURRENT_STATE.md` | 2026-09-22 snapshot | Prior report |
| "gps validated state" | FW commit `4633656` message | 2026-09-26 | Anecdotal |
| ESP32 GPS frames validated by the Pi on hardware | — | — | **None.** PI `README.md` says no real frame has been checked |

## 7. End-to-end mission tests

| Level | Evidence | Status |
|---|---|---|
| Backend ↔ simulated robots (engine) | Backend reports (`PHASE_*`, `docs/runbooks/demonstration.md`) | Previously reported; NOT RUN |
| Backend ↔ real Pi agent ↔ ESP32 host simulator | Pi README "Gate 3 / Gate 3b" | Previously reported; NOT RUN |
| Backend ↔ Pi ↔ real ESP32 on blocks | — | **No evidence found** |
| Physical autonomous delivery | — | **No evidence found** |

## 8. Side effects of today's runs

- All build output went to the session scratchpad (`…\scratchpad\esp32_host_build\`).
- **Pi unit suite on Windows rewrote `C:\proc\definitely\not\writable\session.json`** (a dummy token `"tok"`). The `C:\proc\` tree (also `robotx-test\commitments.json`, last modified 2026-10-03) already existed from an earlier run. It was left in place. It lies outside all repositories and holds no real credential.
- All three `git status --porcelain` outputs were empty after every test run.

## 9. Tests that should exist but do not

1. A host test with a VL53L0X fake whose `init()` blocks for N seconds, asserting TELEMETRY cadence and watchdog behaviour (RX-01).
2. A bench fault-injection test for stop latency with SDA held low (RX-02).
3. A Pi unit test asserting the blocked counter decays or resets on a resumed clear path (RX-08).
4. A captured real ESP32 `GPS` frame fixture (the skipped test above).
5. Any hardware-in-the-loop test of Pi + real ESP32 on blocks with the agent's motion enabled.

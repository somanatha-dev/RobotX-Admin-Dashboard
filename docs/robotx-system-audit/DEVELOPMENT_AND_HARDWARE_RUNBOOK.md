# Development and Hardware Runbook (safe workflow)

Snapshot 2026-10-17. Commands marked **verified today** were run during this audit on Windows (Git Bash).
Everything about the Pi itself is **previously reported** in the Pi repo's
`docs/operations/V1_PI_DEPLOYMENT.md` and `V1_PI_OPERATOR_RUNBOOK.md`; it was **not verified** today
because SSH was unavailable.

## 1. The three repositories

| Repo | Path (Windows) | Remote | Working branch |
|---|---|---|---|
| Pi agent | `C:\Users\soman\OneDrive\Desktop\RobotX-Pi` | `github.com/somanathaB/RobotX` | `integration/robotx-pi-autonomy` |
| ESP32 firmware | `C:\Users\soman\OneDrive\Documents\Arduino\robot_controller` | `github.com/somanatha-dev/ROBOTX---ESP32` | `main` |
| Backend + dashboard | `C:\Users\soman\OneDrive\Desktop\RobotX` | `github.com/somanatha-dev/RobotX-Admin-Dashboard` | `feature/dashboard` |

All three sit inside OneDrive-synced folders. Avoid running builds that write into the trees while OneDrive
is syncing. The ESP32 host build defaults to `%TEMP%\rover_host_build`.

## 2. Inspecting state (safe, read-only; verified today)

```bash
git -C <repo> rev-parse --show-toplevel
git -C <repo> branch --show-current && git -C <repo> rev-parse HEAD
git -C <repo> status --porcelain=v1 -b      # -b shows ahead/behind
git -C <repo> stash list
git -C <repo> log --oneline -15
git -C <repo> branch -a -vv
git -C <repo> remote -v                     # check no credentials appear in URLs
git -C <repo> merge-base --is-ancestor <commit> <branch> && echo yes
```

## 3. Building and testing

| Component | Command | Notes |
|---|---|---|
| Pi unit | `venv\Scripts\python.exe -m unittest discover -s tests/unit -t .` (set `PYTHONDONTWRITEBYTECODE=1`) | Verified today. 4 failures are Windows-specific (POSIX file modes, `/proc` assumptions) and write to `C:\proc\...` — prefer Linux or WSL for authoritative results |
| Pi integration (loopback) | `python -m unittest tests.integration.test_socketio_transport tests.integration.test_local_api_bind` | Verified today; 2 timing failures on Windows |
| Pi ↔ firmware simulator | Build the firmware host simulator (next row), then `set ROBOTX_ESP32_SIMULATOR_EXE=<path>\rover_sim.exe` and `python -m unittest tests.integration.test_esp32_sim_link` | Verified today, 6/6 |
| ESP32 host suite | `python tests/run_host_tests.py --build-dir <dir outside the repo>` (needs g++; MinGW 6.3 works) | Verified today, all passed. Needs the patched Pololu VL53L0X library in `..\libraries\VL53L0X` (or pass `--vl53-lib`) |
| ESP32 device build | Arduino IDE / arduino-cli, board "ESP32 Dev Module", core 2.0.14, Pololu VL53L0X (patched), SparkFun u-blox GNSS 2.x | Not run. Compiling proves nothing about the flashed unit |
| Backend targeted tests | `cd Backend && npx jest --runInBand --forceExit <paths>` | Verified today. `tests/setup/env.js` isolates from real databases |
| Backend full | `npm test`, `npm run gates` | Not run (slow lanes) |
| Backend physical-offer proof | `node tools/verify/gate1PhysicalOffer.js --database-url <disposable db>` | **Disposable databases only.** Not run |
| Dashboard | `cd Frontend && npm run dev` | Not run |

**Python environment caveat:** the Pi repo `venv/` has aiohttp 3.14.3 (pinned 3.14.4) and no OpenCV, so
perception code paths that import `cv2` cannot run there. Install pinned requirements in a fresh venv for
authoritative results. **Do not install or upgrade packages in a shared venv without agreement.**

## 4. Configuration and examples

| Repo | Safe example | Secret-bearing variables (never commit values) |
|---|---|---|
| Pi | `.env.example`; V1 template in `docs/operations/V1_PI_DEPLOYMENT.md` §12 | `ROBOTX_COMMAND_SIGNING_KEY`, `ROBOTX_PAIRING_CODE`, `ROBOTX_ROBOT_TOKEN`, `ROBOTX_GOOGLE_MAPS_API_KEY` |
| Backend | `Backend/.env.example`; declaration example `docs/runbooks/physical-fleet.declaration.example.json` | `COMMAND_SIGNING_KEY`, `JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`, `MAPBOX_TOKEN`, `GOOGLE_CLIENT_ID`, `PRIVACY_*`, `SEED_ADMIN_*`, `DEFAULT_ADMIN_PIN` |
| ESP32 | `config.h` (no secrets) | — |

Cross-repo invariants to keep in sync:
- `ROBOTX_COMMAND_SIGNING_KEY` (Pi) == `COMMAND_SIGNING_KEY` (backend), at least 32 bytes, UTF-8, exactly as written.
- `ROBOTX_ROBOT_ID` == the commissioned `Robot.robotId` == `robots[].robotId` in the physical declaration.
- Pi `ROBOTX_GPS_SOURCE=esp32` on the V1 rover; `ROBOTX_ESP32_PORT=/dev/ttyAMA0` (never `/dev/serial0`).
- Pi `evidence.py` thresholds == backend `VERIFY_*` env values.

## 5. The Raspberry Pi: development versus deployed checkout

| Path | Purpose | Verification |
|---|---|---|
| `/home/pi/Desktop/RobotX-Pi` | Development checkout (reported). `TEST_README.md:20` uses `/home/pi/Desktop/RobotX`, a different spelling | **previously reported, not verified** |
| `/opt/robotx/RobotX-Pi` | Deployed checkout used by `robotx-agent.service` (root-owned, detached at a release commit, venv inside) | **previously reported, not verified** |
| `/etc/robotx/robotx-agent.env` (0600), `/etc/robotx/pairing.env` (first pairing only) | Configuration and secrets | not verified |
| `/var/lib/robotx` | Session token and commitment marks (systemd `StateDirectory`) | not verified |

**Warning (RX-17):** the deployment guide clones branch `gate3-pi-proposal`, which lacks the 2026-10-17 GPS
validation (`288d26b`) and RESUME binding (`54b0b12`) fixes. Decide the release commit explicitly before
deploying.

### Read-only inspection of the Pi (when SSH works)

Today: `ssh robotx-pi` (LAN address from `~/.ssh/config`) → connection refused; `ssh raspberrypi.local` → password required.
Once access is restored, these are read-only and do not touch the UART:

```bash
hostnamectl; uname -a; uptime
git -C /opt/robotx/RobotX-Pi rev-parse HEAD; git -C /opt/robotx/RobotX-Pi status --porcelain
git -C /home/pi/Desktop/RobotX-Pi rev-parse HEAD 2>/dev/null
systemctl status robotx-agent --no-pager; systemctl show -p MainPID,ActiveState,NRestarts robotx-agent
journalctl -u robotx-agent -n 200 --no-pager
ls -l /dev/ttyAMA0 /dev/serial0
curl -s http://127.0.0.1:8000/health
curl -s http://127.0.0.1:8000/state     # includes ESP32 TELEMETRY and DIAG as the agent last saw them
curl -s http://127.0.0.1:8000/backend   # secrets reported as SET/UNSET
```

Never print `/etc/robotx/*.env`; list variable **names** only if needed (`sudo` required — ask first).

## 6. What needs explicit approval

| Operation | Why |
|---|---|
| Any `POST` to the Pi local API (`/mission/*`, `/safety/*`, `/controller/reset`) | Changes robot state; `/controller/reset` writes RESET to the ESP32 |
| `systemctl stop/restart robotx-agent`, editing `/etc/robotx/*`, `/etc/systemd/system/*` | Disturbs the running agent |
| Opening `/dev/ttyAMA0` (e.g. `test_link.py --port`, `rover_link.py`, `capture_esp32_rx.py --device`) | The agent owns it exclusively; a second opener steals frames or is refused |
| `strace -p <agent pid>` (suggested in `tests/hardware/capture_esp32_rx.py:6-19`) | Attaching to the running agent |
| Setting `ROBOTX_ESP32_MOTION_ENABLED=1` | Enables wheel commands |
| `MOTORTEST`, `tests/hardware/test_motors.py` | Drives motors; rover must be on blocks |
| Flashing the ESP32 | Changes the safety controller |
| Backend: `POST /api/tasks/assign`, `/robots/*/command`, `/soc-declaration`, `/commission`, Prisma migrate/seed | Mutates persistent state or the fleet |
| `pip install`, `npm install` in shared environments | Changes environments |

## 7. Coordinating cross-repo changes

1. **Protocol changes (Pi ↔ ESP32):** update in one change set: firmware (`comm.cpp`, `protocol.h`), firmware `PROTOCOL.md` and `tests/test_link.py`, the Pi `robotx/esp32/protocol.py` schema and `state.py`, the Pi copies of `PROTOCOL.md` / `test_link.py` / `rover_link.py` (currently out of date, CM-07/08), and `tests/unit/test_gate3_contract.py`. Bump `PROTO_VERSION` for breaking changes; the Pi refuses a mismatched version.
2. **Backend ↔ Pi:** keep `docs/contracts/fixtures/offer-signature-test-vector.json` authoritative. After any envelope change, re-run the cross-check (load the vector, call `robotx.communication.engine.canonical_string`/`sign`).
3. Reference the counterpart commit hash in each commit message, and record the pair in a release note.
4. Run all three suites (unit + simulator link) before merging.

## 8. Deploying a reviewed Pi change without disturbing the running agent

Following the upgrade procedure in `V1_PI_DEPLOYMENT.md` (§ upgrade, lines ~810-830), with additions:

1. With the rover **stationary, no mission held** (`/state` `.mission` null or terminal), and motion disabled in config unless the change is a motion test.
2. `sudo git -C /opt/robotx/RobotX-Pi fetch origin && sudo git -C /opt/robotx/RobotX-Pi checkout --detach <reviewed-commit>`; verify `rev-parse HEAD` and an empty `status --porcelain`.
3. If `requirements.txt` changed, install into the deployed venv per the guide.
4. Close any `/camera` viewers (an open stream holds shutdown; `TimeoutStopSec=15`).
5. Restart in an agreed window; watch `journalctl` for `agent.started`, `esp32.connected`, `esp32.link status=UP`.
6. Record the deployed commit in the release log.

## 9. Firmware identity before any future flash (proposed; nothing in the firmware supports it today)

1. Clean tree: `git status --porcelain` empty; record `git rev-parse HEAD`.
2. Record library versions, and a SHA-256 of the installed `libraries/VL53L0X/VL53L0X.cpp` (the patched copy).
3. Build with arduino-cli and export the binary; record its SHA-256.
4. **Add a build identifier** (e.g. a `-DFW_GIT=<describe>` define emitted in READY and DIAG SYSTEM) so the Pi `/state` `controller.firmware` proves which build runs. Until then, the flashed revision **cannot be verified**.
5. Before flashing: capture `/state` (READY fields, DIAG SYSTEM) as the "before" record.

## 10. Running hardware checks safely

- Rover **on blocks** for any drive test; wheels free; a person at the power switch.
- Prefer observing through the agent's own `/state` over opening the UART.
- Change one thing at a time; record commit hashes for the Pi and firmware for every session.
- Keep `ROBOTX_ESP32_MOTION_ENABLED=0` except during the specific motion test, and revert afterwards.
- For freeze investigation (RX-01): poll `/state` at 2–5 Hz into a log and look for `controller.telemetry_age_s > 1` against DIAG REAR `rear_reinit_count`.

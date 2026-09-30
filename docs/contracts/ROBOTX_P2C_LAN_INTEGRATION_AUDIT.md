# RobotX P2C: LAN integration audit (Dashboard/backend side)

**Date:** 2026-09-24
**Type:** read-only audit. No source file was changed.
**Tree:** `feature/dashboard`, HEAD `f69b3e2`, plus the uncommitted P1/P2A/P2B work (35 working-tree entries).
**Scope:** the milestone below, on the **backend side only**. The Pi and ESP32 repositories were not read or touched.
**Companion documents:**
- `docs/contracts/ROBOTX_PI_P2B1_HANDOFF.md`: the robot-facing protocol contract, which this audit re-verified against source.
- `docs/contracts/PHYSICAL_ROBOTX_BACKEND_CONTRACT.md`
- `ROBOTX_P2A_PHYSICAL_BACKEND_CONTRACT_AUDIT.md`

Citations are `file:line` under `Backend/` unless stated otherwise.

> **Milestone.** A physical Raspberry Pi on the same LAN reaches the backend, authenticates as its commissioned identity, holds a Socket.IO session, sends heartbeat and (where real data exists) telemetry, receives backend commands, would receive a real signed OFFER when one is produced, and the Dashboard observes the protocol events. Assignment-engine semantics are preserved. **Making the robot assignable is not part of this milestone.**

---

## 1. Executive verdict

**The backend is ready for a deterministic LAN smoke test with zero code changes.** Four operator prerequisites must be done first (§14 steps 1–4), and one procedural rule must be kept: **do not restart the backend during the test** (finding LAN-3).

| Milestone item | Status | Evidence |
|---|---|---|
| 1. Reach the backend | **Ready** | Binds `0.0.0.0:3000` by default (`server.js:532-533`). Booted on loopback in the prior pass: `/health` returned 200 and the Socket.IO handshake returned a `sid` with **no Origin header**. |
| 2. Authenticate | **Ready** | Pairing code → `AUTH_SUCCESS` with a token; later connections use the token (`robot.handler.js:433-715`). The code must be minted by an API call, because the UI cannot mint one (LAN-6). |
| 3. Socket.IO session | **Ready** | One HTTP server carries both REST and Socket.IO (`server.js:383-391`). A robot client that sends no Origin and no `Mozilla` User-Agent is not treated as a dashboard (`socket.server.js:194-196`). |
| 4. Heartbeat | **Ready** | `HEARTBEAT {}` updates liveness with no acknowledgement (`robot.handler.js:723-800`). |
| 5. Telemetry with real data | **Ready**, but **position fixes are blocked by the laptop clock** (LAN-1) until it is synced | No GPS, battery or e-stop exists yet, so today the telemetry carries status, safety and faults only. |
| 6. Receive backend commands | **Ready** | Operator `COMMAND` (STOP/PAUSE/RETURN/RESUME) → `COMMAND_ACK {commandId}` → `Command.status = ACK`. Works with the engine off. |
| 7. Receive a real signed OFFER | **Not producible at this milestone. This is correct, not a defect.** | OFFERs exist only when the engine commits an assignment. The engine is off here, and a physical agent is unassignable by design (§12). The signature path was proven **offline** instead: 3 independent implementations reproduce the backend test vector, and 4 command shapes round-trip through their wire form (§7). |
| 8. Dashboard observes ACK/REJECT | **Partly** | `COMMAND_ACK` is durable (`Command`, `Event`), but the UI does not show it. OFFER responses reach `OFFER_RESPONSE`, and the UI shows only REJECT and DEFER. Heartbeat freshness is visible nowhere (LAN-7). The mechanisms that do work are in §10. |
| 9. Engine semantics preserved | **Yes** | No change was made. The P2B-2 edits under `src/engine/**` are 2 wire-identity lines, already approved by the owner. |

**Findings.** 11 LAN findings (LAN-1 … LAN-11), plus 1 latent engine-on finding (LF-1) and 3 hygiene notes. **None needs a code change for the smoke test.**
- LAN-1 and LAN-2 are operator actions.
- LAN-3 and LAN-6 are handled by the procedure.
- **LAN-4 (unauthenticated `assign_task`) must be fixed before `ENGINE_ENABLED=true` on any shared network.**
- **LF-1 must be fixed before the first physical assignment.**

**Test baseline on this tree:**
- 19 focused boundary suites / 236 tests passed: socket auth, command round trip, telemetry, position observation, physical contract, signing, offer guard, task-complete, commissioning, storable precision, fleet-provider boundary, battery observation, KV.
- Full suite: **209 of 210 suites and 8,475 of 8,476 tests passed** (1,192 s). The one failure was the wall-clock scaling assertion in `tests/scale/round.scale.test.js:380` (`buildInstance` exponent measured **1.4016** against `< 1.4`), which ran while other measurement commands were running on the machine. **Re-run alone, it passed** (scale project: 3 suites / 23 tests). Neither that test nor `src/engine/solve` differs in the working tree. This is a load-sensitive timing threshold, not a regression.

---

## 2. Current architecture (as it applies to this milestone)

```
┌─────────────── Laptop 192.168.1.7 ───────────────┐          ┌──── Rover ────┐
│ Browser (localhost:5173) ──cookie JWT──► Backend  │  LAN     │ Pi 5          │
│                                        node       │◄────────►│ RobotAgent    │
│ Disposable PostgreSQL 127.0.0.1:55440 ◄─ server.js│ TCP 3000 │   │ (UART)    │
│ KV: in-process memory (REDIS_ENABLED=false)       │ HTTP+WS  │ ESP32 (no link│
└───────────────────────────────────────────────────┘          │  yet)         │
                                                               └───────────────┘
```

- **One process, one port.** Express and Socket.IO share `http.createServer(app)` (`server.js:382-391`). Nothing else needs to be reachable from the Pi.
- **Engine off** (`ENGINE_ENABLED=false`). The legacy offline sweep owns liveness (`socket.server.js:184-188`).
  - Offer responses, custody events and engine `COMMAND_ACK` are refused by `agentGate` (silently).
  - Task intake returns `503 ENGINE_NOT_LIVE` before writing anything (`task.service.js:892-903`, first write at `:912`).
- **Provider boundary unchanged.** The physical provider supplies only real derived facts. It refuses a route by name (`fleetProviders/physicalProvider.js:94-101`) and never falls through to the simulation router. The engine contains no provenance branch; `simulationBoundary.test.js` pins that.
- **Identity:**
  - `Robot.robotId` (operator-chosen string) = `Agent.agentId` (`robot.service.js:546`).
  - `Agent.id` is a different deterministic row key, used for foreign keys only.
  - The wire identity everywhere is `Robot.robotId`: AUTH, the socket room `robot:<robotId>`, the OFFER/WITHDRAW/RECALL/SHARD_MIGRATE `agentId`.

## 3. LAN topology

| Host | Address | Listens on | Must be reachable from |
|---|---|---|---|
| Laptop backend | `192.168.1.7:3000` (bound `0.0.0.0`) | TCP 3000 | **the Pi only** |
| Laptop disposable PostgreSQL | `127.0.0.1:55440` | loopback only | nobody (the backend is local) |
| Laptop user PostgreSQL service | `0.0.0.0:5432` / `[::]:5432` | all interfaces | nobody. **Measured:** no inbound firewall rule admits 5432 or `postgres.exe`, so it is not LAN-reachable today. Do not add one. |
| Laptop Vite dev server | `localhost:5173` | loopback | nobody (the browser is on the laptop) |
| Pi | `192.168.1.3` | nothing inbound needed | — |

- The Pi initiates every connection. The backend never connects to the Pi.
- Socket.IO starts with HTTP long-polling and then upgrades to WebSocket on the same port.

## 4. Exact server configuration

**Start command:** `node server.js` from `Backend/`. `npm start` and `npm run dev` are the same command.

| Variable | LAN value | Why |
|---|---|---|
| `HOST` | `0.0.0.0` | This is already the default (`server.js:533`). Set it explicitly so the intent is visible. |
| `PORT` | `3000` | Default (`server.js:532`). |
| `DATABASE_URL` | `postgresql://robotx@127.0.0.1:55440/robotx_lan` | Disposable PostgreSQL. **Never the `.env` Neon URL:** it is 11 of 32 migrations behind, so `Robot.simulated` does not exist there. |
| `REDIS_ENABLED` | `false` | In-memory KV. **Do not use `$env:REDIS_URL=""`:** in PowerShell that deletes the variable, and dotenv then loads the hosted Redis URL from `.env`. |
| `ENGINE_ENABLED` | `false` | The milestone needs no engine. With `true`, `SHARD_CONSENSUS_REPLICATION` becomes mandatory; boot throws without it (`server.js:1063-1067`). |
| `ENABLE_VIRTUAL_SIMULATOR` | `false` | No simulated robots on the LAN test. |
| `FLEET_PROVIDER_DISPATCH` | `false` | Irrelevant with the engine off. It stays at its default. |
| `AGENT_MTLS_REQUIRED` | `false` | No TLS terminator exists. With `true`, pairing is refused (`robot.handler.js:558-564`). |
| `NODE_ENV` | `development` | Keeps the localhost CORS allowance for the local dashboard and non-`Secure` cookies over plain HTTP. |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | the owner's choice | A fresh database has no user. Without these, no operator can log in. |
| `AGENT_PROBE_INTERVAL_MS` | **unset** | The Pi does not implement `PROBE`. Leave it off. |
| `COMMAND_SIGNING_KEY` | **unset for this milestone** | Read only by the engine path (`server.js:803,917`). No command is signed while the engine is off. |

`JWT_SECRET`, `PRIVACY_SURROGATE_SECRET`, `PRIVACY_IDENTITY_KEY`, `DEFAULT_ADMIN_PIN` and `FRONTEND_URL` are loaded from `Backend/.env` by dotenv. dotenv does not override variables already set.

- **CORS.** A robot client sends no `Origin`. The `cors` middleware then adds no headers and the request proceeds. Socket.IO behaves the same way, as measured in the prior pass. The dashboard's origin `http://localhost:5173` is allowed only because `NODE_ENV` is not `production` (`config/cors.js`).
- **Localhost assumptions in the backend:**
  - The simulator's `serverUrl` is `http://127.0.0.1:<port>` (`server.js:1175`). This is correct: in-process simulated robots connect locally.
  - The frontend defaults to `http://localhost:3000` (`Frontend/src/lib/api/httpClient.js:8`, `lib/socket.js:3`). This is correct while the browser runs on the laptop.
  - No backend code binds or filters by loopback.

## 5. Commissioning procedure (the exact, current process)

Operator authentication is required for every `/api/robots/*` route (`robots.routes.js:10`). The accepted credentials are the `token` cookie from `POST /api/auth/login {email,password}` or `Authorization: Bearer <jwt>`.

1. **Create the unit.** Use the UI **Commission Unit** page (`/commission`, `Frontend/src/pages/CommissionPage.jsx`).
   - The UI asks for the step-up PIN or passkey. This is a client-side prompt: the server does not bind it (known, recorded in memory).
   - It creates a `Location` (`POST /api/locations`) and then calls `POST /api/robots` (`AppProvider.jsx:268-306`).
   - **Unit ID must be exactly `robotx-pi`.** It is case-sensitive and must be a JSON string.
   - Required: `chassisType` (`ROVER` or `DRONE`) and **all seven** specification values: `massKg, maxSpeedMps, normalSpeedMps, batteryCapacityWh, batteryReservePct, payloadCapacityKg, initialBatteryPct` (`robotSpecification.js:239`). See LAN-9.
   - What gets written:
     - `Robot{simulated:false, status:"IDLE", isOnline:false, battery:null}`. A physical unit's `initialBatteryPct` is validated but **not** written (`robot.service.js:211`).
     - `Robot.lat/lon` are copied from the Location.
     - `Agent{agentId:"robotx-pi"}` and its `AgentClass`/model rows are written in the same transaction.
2. **Mint the pairing code.** No UI mints one (LAN-6). Call the API:
   - `POST /api/robots/commission {"robotId":"robotx-pi"}`. On an existing robot this only issues a new code (`robots.controller.js:381-454`).
   - Response: `{pairingCode:"NNNNNN", expiresIn:300}`.
   - The code is stored at KV `pairing:robotx-pi` with a TTL of 300 s. It is single-use: deleted on a successful AUTH (`robot.handler.js:631-633`).
3. **Pi pairs.** The Pi sends `AUTH {robotId:"robotx-pi", pairingCode:"NNNNNN"}` within 300 s.
   - The server replies `AUTH_SUCCESS {robotId, token, dedup, session:{mode:"LEGACY",…}}` **and** `AUTH_OK` (same body).
   - The token is a UUID stored at `session:robotx-pi` with a 24 h TTL (`:584-586`).
4. **Pi reconnects.** The Pi sends `AUTH {robotId, token}`.
   - A matching token is accepted and the TTL refreshed to 24 h (`:546-550`). The same token is returned.
   - **The TTL is not refreshed while the socket stays connected.**

**Session lifecycle and restart behaviour:**

| Event | Effect |
|---|---|
| Pi drops and reconnects, backend still running | token AUTH succeeds; the session is restored |
| **Backend restarts (in-memory KV)** | `session:*`, `pairing:*` and lockout keys are all lost. The Pi's token no longer matches. **See LAN-3.** |
| Token older than 24 h since the last token AUTH | same as a restart for this robot |
| 5 failed AUTHs within 300 s | `pairingLocked:robotx-pi` for 1 h (`:67-68, :566-583`). Early unlock is `POST /api/robots/robotx-pi/pairing/unlock`, a `QUARANTINE_OVERRIDE` needing a reason and a **second approver** (`robots.routes.js:28-45`). |
| Socket disconnects | `Robot.isOnline=false`, `status="OFFLINE"`, `socketId=null`; `robot_offline` is emitted to the dashboard (`robot.handler.js:943-983`) |
| Reconnect AUTH | `isOnline=true` and `socketId` set. **`status` stays `OFFLINE`** until a TELEMETRY frame reports one (see LF-1). |

## 6. Socket protocol table (re-verified against source)

⚠ **There is no event named `command`.**
- Engine commands are emitted under **the value of `envelope.command`** (`commandDispatcher.service.js:308`: `io.to(room).emit(envelope.command, envelope)`).
- The legacy operator command is emitted under the event name `COMMAND`, capital letters (`commandDispatcher.service.js:155`).

**Pi → backend:**

| Event | Required payload | Auth | Signature / fence | Malformed / stale / duplicate | Source |
|---|---|---|---|---|---|
| `AUTH` | `robotId` (string ≥1), plus `pairingCode` (first time) **or** `token` | — | no | Schema failure, unknown robot, bad code or token, lockout, or exception → **silent disconnect**. A **failed token falls through to the pairing check and counts as a pairing failure** (LAN-3). Rate limit 5/60 s per socket. Re-AUTH as another robot → disconnect. | `robot.handler.js:414-715` |
| `HEARTBEAT` (alias `heartbeat`) | `{}`; while holding a mission `{commitmentId, fence}` | yes (silently ignored otherwise) | Commitment and fence must match to renew the lease (engine only) | Rate limit 10/5 s, ≥100 ms apart. A mismatch renews nothing. No ACK. | `:723-818` |
| `TELEMETRY` (alias `telemetry`) | Nothing required. Declared fields: `timestamp` (agent epoch ms), `sequence`, `status`, `lat`, `lon`, `speed`, `battery`, `distanceTravelled`; also `position{fixType,hAccM}`, `energy.socMethod`; passthrough | yes → `AUTH_REQUIRED` | no | Schema failure, backpressure, rate limit (50/5 s) or a capability-named key → **frame dropped silently**. Unknown `status` or forbidden transition → that field ignored. | `telemetry.handler.js:384-1006` |
| `COMMAND_ACK` | operator: `{commandId}`. Engine: `{outboxId, fence?, authorityEpoch?}` | yes | engine: the fence/epoch, when present, must match the row | Unknown id → ignored. An ACK from a robot the command was not issued to → ignored (`command.handler.js:118-131`). Rate limit 20/60 s. | `command.handler.js:23-178` |
| `OFFER_ACCEPT` / `OFFER_REJECT` / `OFFER_DEFER` | `{commitmentId, fence, reason?, until?}` (`until` is required for DEFER) | yes + `agentGate` | fence must equal the current commitment fence | **Engine off → silently ignored.** Malformed → logged. Leg not `OFFERED`, or offer expired → `IGNORED` (P2B-2). No reply to the robot. | `offer.handler.js:37-44, 256-462` |
| `CUSTODY_EVENT` | `{commitmentId, fence, kind:"ACQUIRED"\|"RELEASED"}` | yes + `agentGate` | fence | Applied only at a server-verified stop; a repeat is harmless | `offer.handler.js:388-399` |
| `TASK_COMPLETE` | `{taskId, lat?, lon?}` | yes | — | Rate limit 5/30 s. An ungradable claim → `TASK_COMPLETE_ACK {verifying:true, reason}`, and nothing is completed. **Engine off → `reason: ENGINE_GATE_CLOSED`.** | `dtaro.handler.js:151-330, 664, 697` |
| `PROBE_RESULT` | `{correlationId, robotId?}` | yes | — | Recorded only for an outstanding probe on this socket | `robot.handler.js:804-814` |
| `OBSTACLE_REPORT`, `ROBOT_FAULT` | see handoff | yes | — | acknowledged with `OBSTACLE_REPORT_ACK` / `ROBOT_FAULT_ACK` | `dtaro.handler.js:113-420` |

**Backend → Pi:**

| Event | Payload | When | Pi reply |
|---|---|---|---|
| `AUTH_SUCCESS`, `AUTH_OK` | `{robotId, token, dedup, session}` (identical) | AUTH success | handle one of the two |
| `AUTH_REQUIRED` | `{robotId}` | TELEMETRY before AUTH | re-AUTH |
| `UNAUTHORIZED` | `{message}` then disconnect | handshake carried an `Origin` or a `Mozilla` User-Agent (LAN-11) | fix the client headers |
| `COMMAND` | `{commandId, type:"STOP"\|"PAUSE"\|"RETURN"\|"RESUME", timestamp}` | operator `POST /api/robots/:id/command` | `COMMAND_ACK {commandId}` (retried at 5 s and 10 s, FAILED at about 15 s) |
| `STOP` | `{taskId?, reason:"TASK_CANCELLED", timestamp}` | task cancel | none |
| `TASK_ASSIGN` | `{taskId, pickup, drop, pathToPickup, pathToDrop, timestamp}` | **only** the restart-recovery sweep (`server.js:1278-1327`) | **none.** Not a mission authority. |
| `REROUTE_ALERT` | alert payload | obstacle dissemination | none |
| `OFFER` | signed envelope (§7) | engine commit + outbox drain | `COMMAND_ACK {outboxId,fence,authorityEpoch}` then exactly one of ACCEPT / REJECT / DEFER |
| `WITHDRAW`, `RECALL`, `ABORT_MISSION` | signed envelope | engine | `COMMAND_ACK`, then stop the mission |
| `SHARD_MIGRATE` | signed, agent scope | engine | `COMMAND_ACK`, then adopt the epoch and floor |
| `PROBE` | `{command:"PROBE", correlationId, issuedAtMs}` | only if `AGENT_PROBE_INTERVAL_MS` is set | `PROBE_RESULT` within 2 s |
| `TASK_COMPLETE_ACK`, `OBSTACLE_REPORT_ACK`, `ROBOT_FAULT_ACK`, `ERROR` | see the handoff | replies | none |
| `SESSION_REKEY` | mTLS sessions only | never on the LAN test | — |

**Engine-off consequences at this milestone.** OFFER, WITHDRAW, RECALL, SHARD_MIGRATE and PROBE are never sent. The robot-originated engine events are accepted by the socket and dropped by `agentGate`.

## 7. Signature compatibility

**Verified in this pass (no code changed):**

| Check | Result |
|---|---|
| Backend signer (`engine/security/commandSigning.js`) over the fixture's content in server form (BigInt fences, Date `notValidAfter`) | canonical **equal**, signature **equal** |
| Independent JS wire implementation (`tools/verify/wireCanonical.js`), from the wire JSON only | canonical equal, `verifyFromWire.ok = true` |
| Python reference (`tools/verify/pi_canonical_reference.py`, Python 3.13.5) | canonical equal, signature equal. Naive `json.dumps` differs at byte 333 (`5e-07` vs `5e-7`). **PASS** |
| Negative controls | The wire form signed naively (fence quoted) does **not** match. A changed `agentId` does **not** verify. |
| Round trip: server-signed → rendered by the outbox worker (`outbox.worker.js:553-561`) → JSON → verified from the wire alone | **SHARD_MIGRATE** (null commitment/fence, BigInt epoch and 20-digit floor, non-ASCII payload) ✔. **RECALL** ✔. **WITHDRAW** ✔. **ABORT_MISSION** ✔. |

**Confirmed properties:**
- **Envelope order is fixed and not sorted:** `agentId, command, commandClass, fenceScope, commitmentId, fence, authorityEpoch, fenceFloor, sequence, notValidAfter, payload` (`commandSigning.js:104-116`). The separator is `\u001f`.
- **Expiry.** The envelope's `notValidAfter` is **unquoted** ISO-8601 with milliseconds and `Z`. The server holds a `Date` (rendered by `toISOString()`), and the wire carries the same string. `payload.offerExpiry` is a **string** at signing time (`offers.js:144`), so it is **quoted**.
- **Fences.** `fence`, `authorityEpoch` and `fenceFloor` are BigInt on the server and render as unquoted digits. On the wire they are decimal **strings**, or `null`. A Pi verifier must render them unquoted. Inside `payload`, `fence` and `supersedesFence` are strings, so they are quoted.
- **Key order.** Keys are sorted at every depth inside `payload` by `Array.prototype.sort()` (UTF-16 code units). The Python reference sorts by the UTF-16-BE encoding. Arrays keep their order.
- **UTF-8.** Non-ASCII strings and keys are emitted raw (`JSON.stringify`). Python needs `ensure_ascii=False`. The fixture contains 6 non-ASCII characters (Kannada).
- **HMAC key.** The key is the UTF-8 bytes of `COMMAND_SIGNING_KEY`, at least 32 bytes (`commandSigning.js:124-139`). The fixture key is ASCII. **Recommendation:** generate the deployment key as 64 hex characters (ASCII, 64 bytes), so no key-encoding question can arise.
- **Numbers.** OFFER content is quantised to 15 significant digits before signing (`coordinatorSolvePath.js:2152-2160`), so the jsonb store cannot shorten a signed double. Other command payloads carry only strings and integers. Render with ECMAScript Number→String rules, and **never re-round before canonicalising**.
- **Robot identity.**
  - OFFER and WITHDRAW sign `agentId` = `Agent.agentId` = `robotx-pi`.
  - RECALL (`reassignment.js:219-229`) and SHARD_MIGRATE (`membership.js:465`) sign `agent.agentId || agent.id` (the P2B-2 fix is present in the working tree).
  - The delivery arm addresses the same identity.
- **Latent trap, not reachable today.** `canonicalValue` renders a `Date` at **any depth** unquoted (`commandSigning.js:159`). Every current payload converts dates to strings before signing, so wire and signature agree. **Any future payload that embeds a raw `Date` would be unverifiable by the Pi.** Keep payload timestamps as strings or integers.

The fixture covers the OFFER shape only. The SHARD_MIGRATE and RECALL shapes are covered by the round trips above and by `tests/engine/wireIdentitySigning.test.js` (in the passing set).

## 8. Telemetry / observation audit

| Topic | Backend behaviour | Source |
|---|---|---|
| Position freshness | The engine judges age at **its** decision time against the agent's `timestamp`. The budget is `connectivity.max_heartbeat_age` = **10 s**. Stale data is never re-stamped. | handoff §16, `agentFacts.service.js` |
| Timestamp validation | No `timestamp` → `NO_AGENT_TIMESTAMP`. `timestamp` > server clock + `time.max_clock_skew` (**500 ms**) → `CLOCK_AHEAD`. **The server clock is the laptop's clock** (LAN-1). | `positionObservation.service.js:382-401` |
| Ordering | `sequence` must advance on the **persisted** high-water mark, which is seeded from the latest `Observation` row in the database. `observedAt` must advance too. A Pi whose `sequence` restarts at 0 gets `STALE_SEQUENCE` until it passes the old maximum (LAN-10). | `:417-435` |
| Fix quality | `position.fixType:"NO_FIX"` → no Observation. `hAccM` > 0 → `uncertaintyRadiusM`. | `:404-409` |
| No lat/lon (the Pi today) | Outcome `NO_REPORTED_POSITION`, logged once at `warn` when the outcome changes. No Observation is written. | `:360-381`, `telemetry.handler.js:1053-1065` |
| Battery | Written to `Robot.battery` (display). It reaches the engine SoC (`BatteryState.lastObservedSoc`) **only** with `energy.socMethod` ∈ {`BMS`, `COULOMB_COUNTING`, `VOLTAGE_CURVE_CALIBRATED`} **and** an existing `BatteryState` row. A physical unit has none. | `batteryObservation.service.js`, `telemetry.handler.js:847-856` |
| Safety, faults, localisation | **Accepted, ignored.** No backend reader yet. Safe to send. | handoff §5, §16 |
| Capability keys | Any key named like `capability`, `clearance`, `cold_chain` and so on, at any depth, **drops the whole frame** and counts toward quarantine. | `telemetry.handler.js:450-463` |
| Absent values | Omitted, `null`, `""` and non-numeric strings are all treated as absent (`numOpt`). **Any number is a measurement.** | `:372-382` |
| Status | Transition table at `:253-261`. The health asymmetry means a self-report may never *raise* the tier (`:574-597`). With the engine off it is applied with a warning; when enforced it is refused (LF-1). | |
| Physical-provider consumption | Positions become `Observation{provenance:"PHYSICAL"}`, which then feed the index maintainer. **With the engine off, nothing consumes them for decisions.** The physical provider supplies derived facts only (§12). | `fleetProviders/physicalProvider.js` |
| Dashboard misrepresentation | **Battery:** fixed in P2B-2 (a physical unit starts at `null`). **Position: not fixed.** `Robot.lat/lon` are seeded from the commissioning Location, and every `robot:update` carries lat/lon forward from the previous state or that row when the frame has none (`telemetry.handler.js:635-652`). **The map therefore shows the Pi at its commissioning location, as though it were a live fix** (LAN-8). This is display only; the engine reads Observations, never these columns. | |

## 9. LAN security (minimum safe configuration)

| Control | Minimum for the LAN test |
|---|---|
| Bind | `0.0.0.0:3000`. The disposable PostgreSQL stays on `127.0.0.1`. |
| Network profile | Set the Wi-Fi to **Private**. It is currently `Public`, measured. |
| Firewall | One inbound rule: TCP 3000, Private profile only, remote address `192.168.1.3`, program `node.exe`. **Disable the two existing "Node.js JavaScript Runtime" rules** that allow node.exe on *all* TCP and UDP ports on **Public** networks. Today they expose any node server this laptop runs on any public Wi-Fi, a college network included (LAN-2). |
| PostgreSQL | Disposable cluster on loopback only. The existing 5432 service is bound to all interfaces but has no inbound allow rule; keep it that way. |
| Redis | Not used. In-memory KV. Nothing to expose. |
| CORS | Unchanged. It is not an authentication control for robots, which send no Origin. |
| Operator auth | JWT cookie. Choose a strong `SEED_ADMIN_PASSWORD`. Note that the login rate limit can be bypassed with a forged `X-Forwarded-For` (LAN-5). |
| Robot auth | Pairing code (300 s, single use) → bearer token (24 h). **Over plain HTTP, both travel in cleartext on the LAN.** Acceptable on a home network or a hotspot you control. **Not acceptable on shared or college Wi-Fi.** |
| Signing key | **Not needed for this milestone.** When the engine phase needs it: generate it on the laptop, store it in an environment variable (never in `.env` committed to git, never in chat or logs), and copy it to the Pi by `scp` over SSH into a mode-`0600` file. It is never sent over the Socket.IO channel. |
| Unauthenticated surface | `GET /health` (read-only metrics) and the Socket.IO handshake. **Also `assign_task`, which should not be there (LAN-4).** It is inert while the engine is off. |

## 10. Dashboard observability

| What | UI today | Backend mechanism that works now |
|---|---|---|
| Pi connected / authenticated | **Not live.** The UI does not subscribe to `robot_online` or `robot_offline` (`Frontend/src/lib/socket.js:55-80`). The Robots page shows `isOnline` from `GET /api/robots/state` on load or refresh. | Backend console: `Robot AUTH success {robotId, socketId, mode:"pairing"\|"session"}`. SQL: `Robot.isOnline`, `socketId`. |
| Authenticated identity | Robots list / detail | `mode` in the AUTH log line; `Robot.socketId`. |
| Heartbeat freshness | **Nowhere.** `registry:<id>.lastHeartbeat` is in-process KV and no endpoint exposes it. | `Robot.lastSeenAt` advances at most every **15 s** (DB flush interval). The robot is marked offline after 30 s of silence (sweep every 10 s). |
| Telemetry | Map and robot state via `robot:update` (live) | SQL: `Telemetry`, `Observation`. Console: `position Observation` outcome lines. |
| OFFER sent | — | Console `COMMAND_ACK (outbox)`; `Outbox` rows. Not reachable at this milestone. |
| ACK received (operator command) | **Not shown.** `COMMAND_STATUS` is emitted, but the UI does not subscribe to it. | SQL: `Command.status = 'ACK'` and `executedAt`; `Event.message = 'COMMAND_ACK <id> responseTimeMs=<n>'`. |
| ACCEPT / REJECT / DEFER | Event log for REJECT and DEFER only; ACCEPT is not logged (`AppProvider.jsx:714-723`) | Console `OFFER_ACCEPT handled {outcome, reason}`; `OFFER_RESPONSE` socket event. |
| Command state | Robot detail buttons STOP / RETURN / RESUME (`RobotDetailPage.jsx:130-142`) | SQL `Command`. |
| Robot / agent state | Robots page | `GET /api/robots/state`; SQL `Robot`, `Agent`. |

SQL against the disposable database:
```powershell
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
$db   = @("-h","127.0.0.1","-p","55440","-U","robotx","-d","robotx_lan","-c")
& $psql @db 'SELECT "robotId", status, "isOnline", "socketId", "lastSeenAt", battery, lat, lon FROM "Robot" WHERE "robotId"=''robotx-pi'';'
& $psql @db 'SELECT c.id, c.type, c.status, c."issuedAt", c."executedAt" FROM "Command" c JOIN "Robot" r ON r.id=c."robotId" WHERE r."robotId"=''robotx-pi'' ORDER BY c."issuedAt" DESC LIMIT 5;'
& $psql @db 'SELECT e.type, e.message, e."createdAt" FROM "Event" e JOIN "Robot" r ON r.id=e."robotId" WHERE r."robotId"=''robotx-pi'' ORDER BY e."createdAt" DESC LIMIT 10;'
& $psql @db 'SELECT o.kind, o."observedAt", o.sequence, o.value FROM "Observation" o JOIN "Agent" a ON a.id=o."agentId" WHERE a."agentId"=''robotx-pi'' ORDER BY o."observedAt" DESC LIMIT 5;'
```

## 11. Deterministic LAN smoke test (no assignment, no fabricated data)

**Prerequisites (P):**
- **P1.** The laptop clock is NTP-synced: `w32tm /stripchart … /samples:3` shows every offset within ±0.1 s.
- **P2.** The Pi's `chronyc tracking` shows a system time offset under 50 ms.
- **P3.** The firewall is configured as in §9.
- **P4.** The disposable PostgreSQL is up and migrated.
- **P5.** The backend is started per §4.
- **P6.** The operator is logged in to the UI.

| # | Actor | Action | Expected, observable | Pass rule |
|---|---|---|---|---|
| S0 | Pi (offline) | Run the Pi's own verifier over `offer-signature-test-vector.json`, copied to the Pi | verifies. A copy with `agentId` changed does **not** verify. | both |
| S1 | Pi | `curl -sS -m 5 -o /dev/null -w "%{http_code}\n" http://192.168.1.7:3000/health` | `200` | exact |
| S2 | Pi | `curl -sS -m 5 "http://192.168.1.7:3000/socket.io/?EIO=4&transport=polling"` | body starts `0{"sid":` | prefix |
| S3 | Operator | Commission `robotx-pi` in the UI, then mint a code via the API (§14 step 6) | `pairingCode` (6 digits), `expiresIn: 300` | — |
| S4 | Pi | connect, then `AUTH {robotId, pairingCode}` | Pi receives `AUTH_SUCCESS` with a `token`; **no `UNAUTHORIZED`**. Backend console: `Robot AUTH success … mode: "pairing"`. SQL: `isOnline = t`, `socketId` not null. | all three |
| S5 | Pi | `HEARTBEAT {}` every 2 s for 40 s | no disconnect. `lastSeenAt` advances at least twice (15 s flush). | — |
| S6 | Pi | `TELEMETRY {timestamp, sequence, status:"IDLE", safety:{…}, faults:[]}` every 2 s. **No lat/lon/battery**, because none are measured. | no `AUTH_REQUIRED`. Console: one warn line, outcome `NO_REPORTED_POSITION`. No `Observation` row. | Observation count is **0**. That is the honest result. |
| S7 | Operator | `POST /api/robots/robotx-pi/command {"type":"STOP"}` | Pi receives `COMMAND {commandId, type:"STOP", timestamp}` and replies `COMMAND_ACK {commandId}`. The API returned `delivered:true`. SQL: `Command.status = ACK`; `Event` `COMMAND_ACK <id> responseTimeMs=<n>`. | ACK within 5 s. STOP is the safe direction, and the Pi has no motor link anyway. |
| S8 | Operator | Repeat S7 once | a new `commandId`, and ACK again | — |
| S9 | Pi | Drop the connection **on the Pi side** (restart the RobotAgent process, or toggle the Pi's Wi-Fi). **Do not restart the backend.** | SQL: `isOnline = f`, `status = OFFLINE`. On reconnect, `AUTH {robotId, token}` → `AUTH_SUCCESS` with the **same token**; console `mode: "session"`. | same token, `mode: session` |
| S10 | Pi | The first TELEMETRY after reconnect carries `status:"IDLE"` | SQL: `status = IDLE`. Console warning `Self-reported health would expand eligibility — recorded, not applied when enforced` (expected with the engine off; see LF-1). | status restored |
| S11 | Pi | Heartbeat and telemetry resume; repeat S7 | ACK | — |

**Deliberately excluded:**
- An OFFER: none can be produced (§1 item 7).
- A backend restart: LAN-3.
- A wrong pairing code: each failure counts toward the 1 h lockout.
- Any GPS, battery or motor state.

**Result recording:** save the Pi log, the backend console, and the §10 SQL output after S11.

## 12. Remaining physical assignability blockers

The engine is unchanged by every item below. Each is a **missing physical fact or capability**, supplied later by a provider, the operator or the hardware. **None is a reason for `if physical` in the engine.**

**A. Pi-side (hardware and agent):**
- **A1.** No Pi↔ESP32 link. The Pi rejects every OFFER with `NO_MOTOR_LINK`, which is correct.
- **A2.** No `PROBE` handler, so F14 (proven command path) stays unsatisfied.
- **A3.** No GNSS feed, so there is no position Observation. The robot is never indexed and never a candidate.
- **A4.** No battery measurement or `energy.socMethod`, so there is no engine SoC. F34/F35 cannot pass.
- **A5.** The `sequence` must persist across Pi restarts (LAN-10).
- **A6.** The Pi must not keep presenting a token the server has rejected (LAN-3).

**B. ESP32-side:**
- **B1.** The NEO-9M GPS on I2C 0x42 is not driven.
- **B2.** No battery voltage, current or SoC sensing.
- **B3.** No encoder odometry feature (the inputs are wired).
- **B4.** No e-stop circuit. `safety_stop` is a proximity latch and is **never** an e-stop.
- **B5.** No pack or ambient temperature.
- **B6.** The UART motor protocol exists (DRIVE/STOP/RESET/PING) but the Pi does not use it yet.

**C. Backend physical-provider:**
- **C1.** The 13 control-plane facts have no physical source (`agentFacts.service.js:59-73`): commissioning F1, hold F3, attested firmware F5, calibrations F6, e-stop F7, faults F8, localisation F10, reliability F11, advisories F12, the `lastHeartbeatAckAt` round trip F14, zones F27, maintenance F36, and ambient/pack temperature.
- **C2.** `agentEnergyDeclarationsFor`, `environmentFor` and `failureProbabilityFor` return `null` (`physicalProvider.js`).
- **C3.** Charging: `chargingInScope: false`. A physical agent is never indexed until a Charging Scheduler covers it (B2 production).
- **C4.** Readers for the `safety`, `faults` and `localisation` telemetry blocks.
- **C5.** No `BatteryState` / `EnergyModelParams` rows are provisioned for a physical unit.

**D. Operator-entered facts:**
- **D1.** Seven commissioning values are required, and some have no honest source yet (LAN-9). The pack Wh needs a declared nominal voltage (the pack is 6000 mAh, not Wh). The reserve and max speed are undeclared.
- **D2.** Where operator control-plane facts live (`AgentControlRecord`, not migrated) is an **owner decision**.
- **D3.** Capability and container envelope: `AgentClass` / `Compartment` for the real box.

**E. Physical routing:**
- **E1.** No physical route producer. `route()` throws `NOT_ROUTABLE`, and `profileKeyFor` returns null.
- **E2.** The `PHYSICAL:` profile namespace is reserved but not issued.
- **E3.** B1 (production router) is still externally blocked.
- **E4.** Three RNSIT points are unroutable boundary cells (an owner-level spatial fact).

**F. Charging and energy:**
- **F1.** No physical charger estate or scheduler (B2).
- **F2.** No fitted β. The two Safety rows (`energy.model_residual_cv`, `energy.reserve_floor_wh`) are null for non-simulated agents.
- **F3.** No measured SoC (A4/B2).

**G. Safety:**
- **G1.** F7 is unsatisfiable honestly without an e-stop circuit (B4).
- **G2.** **LF-1:** once the engine enforces, a physical robot that disconnects once stays `OFFLINE` and F9 denies it.
- **G3.** The telemetry trust boundaries enforce only when the engine is on. They have not been exercised against real GNSS jitter.
- **G4.** LAN-4 must be closed before the engine runs on any shared network.

## 13. Cloud / Render readiness (Option A vs Option B)

**Recommendation: Option A for the college demonstration**, using a phone hotspot or travel router **you control**, not the college Wi-Fi.
- Campus Wi-Fi commonly isolates clients, so the Pi could not reach the laptop.
- On shared Wi-Fi, the robot's credentials and the dashboard cookie would cross the air in cleartext.
- Option A moves nothing to the internet and needs only three operator changes: the new IP in `ROBOTX_SOCKET_SERVER_URL`, the firewall rule's remote address, and the network set to Private.

**Option B (cloud backend, with the Pi on Airtel mobile data)** is architecturally possible. The Pi only makes outbound connections, so carrier-grade NAT is fine, and the heartbeat and OFFER budgets tolerate mobile latency. It is **not safe until every item below is done:**

| Area | Required change before Option B |
|---|---|
| PostgreSQL | A **dedicated** demo database, not the shared Neon instance. All 32 migrations applied (`prisma migrate deploy`); Neon is 11 behind today. Verify Prisma's pooler settings for serializable transactions and `SELECT … FOR UPDATE` (the engine uses both). |
| Redis / session storage | **Required.** Pairing codes, robot tokens, lockout state and the live registry must survive restarts and redeploys. Otherwise every deploy triggers LAN-3 for the Pi. With more than one instance, the Socket.IO Redis adapter plus sticky sessions (for the polling transport) are also required. |
| Secrets | Fresh values for `JWT_SECRET`, `PRIVACY_SURROGATE_SECRET`, `PRIVACY_IDENTITY_KEY`, `COMMAND_SIGNING_KEY` (≥32 bytes), `SEED_ADMIN_*` and `DEFAULT_ADMIN_PIN`, held in the platform's secret store. `Backend/.env` is gitignored. `Backend/.env.benchmark` **is tracked** (commit `89a53b8`); its values are local-benchmark only and differ from `.env` (checked by equality, not printed). Never reuse either. |
| Socket.IO | Render supports WebSockets. One instance, or the Redis adapter. Free instances spin down and drop every socket. |
| CORS | `FRONTEND_URL` = the exact deployed frontend origin. `NODE_ENV=production` removes the localhost allowance. Robots are unaffected. |
| Frontend API URL | `VITE_API_URL` and `VITE_SOCKET_URL` set at **build** time (defaults: `http://localhost:3000`). |
| Cookies | Frontend and API on different `*.onrender.com` subdomains are **cross-site** (`onrender.com` is on the Public Suffix List). That needs `COOKIE_SAMESITE=none` and `COOKIE_SECURE=true`, and browsers increasingly block such cookies. Prefer one custom domain (for example `app.` and `api.` under it), or serve the built frontend from the backend. |
| HTTPS | TLS terminates at the platform, so the Pi uses `https://` and `wss://`. Set `app.set("trust proxy", 1)` and fix LAN-5, because behind a proxy every client would otherwise share the proxy's rate-limit bucket or could forge its own. |
| Signing key | Provisioned to the Pi out of band (§9). A rotation plan is needed; there is no provisioning mechanism. |
| Persistent data | The platform disk is ephemeral. All state lives in PostgreSQL and Redis. |
| Engine configuration | For any real OFFER: `ENGINE_ENABLED=true`, `SHARD_CONSENSUS_REPLICATION`, a published and pinned configuration with region/shard/index/delivery-domain seeds, `cutover.engine_enabled` for the region, and `VERIFY_*`. The physical robot is **still** unassignable (§12). |
| Exposure | **LAN-4 must be fixed first.** On the public internet, unauthenticated task injection over `assign_task` becomes reachable by anyone once the engine is on. Also consider operator MFA; the step-up prompt is client-side only. |

## 14. Exact next actions, ordered by dependency

**Laptop (owner). Steps 1–2 need an elevated PowerShell; the rest a normal one.**

1. **Clock** (LAN-1; measured offset about 4.4 s, and the Windows Time service is stopped):
   ```powershell
   Start-Service w32time
   w32tm /resync /force
   w32tm /stripchart /computer:time.windows.com /dataonly /samples:3   # every offset should be within ±0.1 s
   ```
2. **Network and firewall** (LAN-2):
   ```powershell
   Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private
   New-NetFirewallRule -DisplayName "RobotX backend LAN (TCP 3000)" -Direction Inbound -Action Allow `
     -Protocol TCP -LocalPort 3000 -Profile Private -RemoteAddress 192.168.1.3 `
     -Program "C:\Program Files\nodejs\node.exe"
   Get-NetFirewallRule -DisplayName "Node.js JavaScript Runtime" | Where-Object { $_.Profile -eq 'Public' } | Disable-NetFirewallRule
   ```
3. **Disposable PostgreSQL.** The one-time setup:
   ```powershell
   $bin  = "C:\Program Files\PostgreSQL\18\bin"
   $data = "$env:LOCALAPPDATA\RobotX\pg-lan"
   & "$bin\initdb.exe" -D $data -U robotx -A trust -E UTF8 --locale=C
   Start-Process "$bin\postgres.exe" -ArgumentList "-D",$data,"-p","55440","-c","listen_addresses=127.0.0.1" -WindowStyle Hidden
   & "$bin\createdb.exe" -h 127.0.0.1 -p 55440 -U robotx robotx_lan
   Get-ChildItem "C:\Users\soman\OneDrive\Desktop\RobotX\Backend\prisma\migrations" -Directory | Sort-Object Name | ForEach-Object {
     & "$bin\psql.exe" -h 127.0.0.1 -p 55440 -U robotx -d robotx_lan -q -v ON_ERROR_STOP=1 -f (Join-Path $_.FullName "migration.sql") }
   ```
   In later sessions, run only the `Start-Process` line.
4. **Backend** (leave this window open):
   ```powershell
   cd C:\Users\soman\OneDrive\Desktop\RobotX\Backend
   $env:DATABASE_URL="postgresql://robotx@127.0.0.1:55440/robotx_lan"; $env:REDIS_ENABLED="false"
   $env:ENGINE_ENABLED="false"; $env:ENABLE_VIRTUAL_SIMULATOR="false"; $env:FLEET_PROVIDER_DISPATCH="false"
   $env:AGENT_MTLS_REQUIRED="false"; $env:NODE_ENV="development"; $env:HOST="0.0.0.0"; $env:PORT="3000"
   $env:SEED_ADMIN_EMAIL="<your email>"; $env:SEED_ADMIN_PASSWORD=Read-Host "Admin password"
   node server.js
   ```
   Check the listener: `Get-NetTCPConnection -LocalPort 3000 -State Listen | Select LocalAddress,LocalPort` must show `0.0.0.0`.
   Then start the frontend: `cd Frontend; npm run dev`.
5. **Pi Claude:** run smoke steps S0–S2.
6. **Owner:** commission `robotx-pi` in the UI (`/commission`), then mint the pairing code:
   ```powershell
   $api = "http://localhost:3000"
   $body = @{ email = "<your email>"; password = (Read-Host "Admin password") } | ConvertTo-Json
   Invoke-RestMethod -Method Post -Uri "$api/api/auth/login" -Body $body -ContentType "application/json" -SessionVariable s | Out-Null
   $r = Invoke-RestMethod -Method Post -Uri "$api/api/robots/commission" -ContentType "application/json" `
        -Body (@{ robotId = "robotx-pi" } | ConvertTo-Json) -WebSession $s
   "code $($r.pairingCode) expires in $($r.expiresIn) s"
   ```
   Give the code to the Pi directly (SSH session or the Pi's own prompt), **not through a chat transcript**.
7. **Pi Claude:** run S3–S6 and S9–S11. **Owner:** run S7–S8 with
   `Invoke-RestMethod -Method Post -Uri "$api/api/robots/robotx-pi/command" -ContentType "application/json" -Body '{"type":"STOP"}' -WebSession $s`
8. **Dashboard Claude, P2C implementation** (owner approval required per item; §15): LAN-4, LAN-3, LAN-6, LAN-7, LAN-5, LAN-8, then LF-1 (design first).
9. **Rover/Pi Claude:** A2, A5 and A6, then the ESP32 link (A1) with the ESP32 Claude (B1–B6).
10. **Owner decisions:** D1 (declared values, nominal pack voltage), D2 (where control facts live), and the Option A/B choice.

**Pi environment:**
- `ROBOTX_SOCKET_SERVER_URL=http://192.168.1.7:3000`
- `ROBOTX_ROBOT_ID=robotx-pi`
- the pairing code through the Pi's existing pairing input
- the token persisted after `AUTH_SUCCESS`
- **no** signing key needed for this milestone

The Pi client must:
- send **no** `Origin` header and no `Mozilla` User-Agent;
- use polling-then-upgrade, or a WebSocket client that suppresses Origin (LAN-11);
- keep `chrony` synced.

## 15. Files that would need modification in the next implementation phase

All of these are outside `src/engine/**`, and none changes a decision.

| Finding | File(s) | Change |
|---|---|---|
| LAN-4 | `Backend/src/sockets/socket.server.js:317-373` | Admit `assign_task` only from an authenticated **dashboard** socket (`socket.data.userId`), and rate-limit it. Test: an unauthenticated socket gets no `task_error` and no intake call. |
| LAN-3 | `Backend/src/sockets/handlers/robot.handler.js:538-583` | A presented-but-unknown **token** must not count as a pairing-code failure, or must count separately. Consider refreshing the session TTL on heartbeat. Pi-side mitigation: stop re-presenting a rejected token. |
| LAN-6 | `Frontend/src/pages/RobotDetailPage.jsx` (or `CommissionPage.jsx`), `Frontend/src/lib/api/robots.js` | A "Generate pairing code" action calling `POST /api/robots/commission`. Show the code once with its countdown; never log it. Fix the copy in `SimulatedRobotPage.jsx:585`. |
| LAN-7 | `Frontend/src/lib/socket.js`, `Frontend/src/context/AppProvider.jsx`; `Backend/src/controllers/robots.controller.js` (`getRobotsState`) | Subscribe to `robot_online`, `robot_offline` and `COMMAND_STATUS`; log OFFER ACCEPT. Expose `registry.lastHeartbeat` (age) in `/api/robots/state`. |
| LAN-5 | `Backend/src/middlewares/rateLimitHttp.js:1-5`, `Backend/src/app.js` | Use `req.ip` with an explicit `trust proxy` setting; never read raw `X-Forwarded-For`. |
| LAN-8 | `Backend/src/sockets/handlers/telemetry.handler.js:635-660`, map consumer `Frontend/src/features/maps/mapControl/hooks/useRobotStream.js` | Mark carried-forward lat/lon (for example `positionSource: "COMMISSIONED" \| "REPORTED"` plus the age), and render an unmeasured position differently. |
| LF-1 | `Backend/src/sockets/handlers/robot.handler.js` (AUTH), `telemetry.handler.js` (status) | Design required, owner decision. A server-observed reconnect restores the liveness status the server itself set on disconnect, without letting a self-report raise the health tier. **No `src/engine` change.** |
| LAN-9 / D1 | `Backend/src/services/robotSpecification.js`, `robot.service.js`, `CommissionPage.jsx` | Owner decision: allow "undeclared" for physical units, or require the declared value. `initialBatteryPct` should not be required for a physical unit, since it is never written. |

## 16. What must NOT be changed

- `Backend/src/engine/**`: the solver, feasibility (F1–F38), ranking, commitment, fencing, dispatch, supervision, and `commandSigning`'s canonical form. **No `if physical`, `if simulated` or `if robotx` anywhere in assignment logic.**
- The provider boundary's semantics: a physical fact stays **absent** until a real source exists. Never substitute a simulated or placeholder value.
- `docs/contracts/fixtures/offer-signature-test-vector.json`, and the `SIGNED_FIELDS` order.
- The V1 regression runner, scenarios A/B/failures, invariants I1–I8, and any gate (`npm run gates`, `gate:composition` stays RED by design).
- The shared Neon database, and the database schema (unless the owner approves D2).
- Render or any deployment configuration; the Pi, ESP32, motor and sensor code.
- Telemetry must not be fabricated: no GPS, battery, motor state, completion or e-stop value that was not measured.

---

## Appendix A: findings register

| ID | Severity | Needed for smoke test? | Finding | Evidence |
|---|---|---|---|---|
| **LAN-1** | **High for position fixes** | Prerequisite (operator) | The Windows Time service is **stopped**. The laptop clock is **~4.4 s** off NTP (`w32tm /stripchart`: +4.42 s ×3; by that sign convention the laptop is behind). A correctly synced Pi would stamp frames about 4.4 s "in the future", so every position fix is refused `CLOCK_AHEAD` (bound 500 ms). | `positionObservation.service.js:392-401`; measured |
| **LAN-2** | High on a public network | Prerequisite (operator) | The Wi-Fi is `Public`. Two enabled "Node.js JavaScript Runtime" rules allow node.exe on all TCP/UDP ports, Public profile. | measured |
| **LAN-3** | High (demo availability) | Avoided by procedure | A token rejected after a backend restart (in-memory KV) or after 24 h falls through to pairing and counts toward the 5-failure / 1 h lockout. Clearing it early needs a second approver. | `robot.handler.js:546-583, 67-68` |
| **LAN-4** | High once the engine is on; low now | No | The `assign_task` socket event runs `taskService.assignTask` for **any** socket, unauthenticated and without a rate limit. Engine off → 503 before any write, but it emits `task_error` to every dashboard. | `socket.server.js:317-373`, `task.service.js:892-903`, first write at `:912` |
| LAN-5 | Medium | No | The HTTP rate limiter keys on a client-supplied `X-Forwarded-For`, so the login limit can be bypassed. | `rateLimitHttp.js:1-5` |
| LAN-6 | Medium (operability) | Worked around (API) | The UI commissioning path mints no pairing code, and UI copy claims it does. | `AppProvider.jsx:287`, `robots.controller.js:431`, `SimulatedRobotPage.jsx:585` |
| LAN-7 | Medium (observability) | Worked around (SQL / logs) | The UI ignores `robot_online`, `robot_offline`, `COMMAND_STATUS` and OFFER ACCEPT. Heartbeat age is not exposed anywhere. | `Frontend/src/lib/socket.js:55-80` |
| LAN-8 | Low (display) | No | Commissioning coordinates are shown as a live position. | `robot.service.js:175-176`, `telemetry.handler.js:635-652` |
| LAN-9 | Medium (honesty of facts) | Owner decision at S3 | Physical commissioning demands 7 values, some with no honest source; `initialBatteryPct` is required but never written. | `robotSpecification.js:239`, `robot.service.js:211` |
| LAN-10 | Medium, once GPS exists | No | The position `sequence` high-water mark persists in the database, so a Pi restarting its counter is refused `STALE_SEQUENCE`. | `positionObservation.service.js:417-427` |
| LAN-11 | Unverified risk | Checked in S4 | Robot/dashboard classification is by `Origin` or `Mozilla` UA. Some WebSocket client libraries add `Origin` by default when a client connects WebSocket-only. **Not verified against the Pi's library.** | `socket.server.js:194-218` |
| **LF-1** | **High for engine-on** | No | After any disconnect, `status=OFFLINE`. Under enforcement, a telemetry `IDLE` is refused as a self-report raising the health tier, and AUTH does not restore status, so F9 denies the robot permanently. | `robot.handler.js:47-60, 34-45`; `telemetry.handler.js:574-597` |
| H-1 | Hygiene | No | `reassignment.js` and `offerAcceptPublishesAssignment.test.js` have CRLF line endings in the working tree (the index is LF). `core.autocrlf=input` normalises them on commit. | `git ls-files --eol` |
| H-2 | Hygiene | No | `Backend/.env.benchmark` is tracked. Its values are local-only and not reused. | `git ls-files` |
| H-3 | Latent | No | `canonicalValue` renders a nested `Date` unquoted. Safe today because every payload stringifies its dates. | `commandSigning.js:159` |

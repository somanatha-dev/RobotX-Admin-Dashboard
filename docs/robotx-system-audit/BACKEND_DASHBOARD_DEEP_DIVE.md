# Backend and Dashboard — Deep Dive (robot-facing scope)

Repository C: `C:\Users\soman\OneDrive\Desktop\RobotX` · branch `feature/dashboard` · commit `de03788`
(5 commits ahead of its remote). Paths are relative to `RobotX/`. The backend is very large: about 393
source files, 346 test files and a 4000-line Prisma schema. This document covers **the paths that touch
a physical robot**. It does not re-audit the assignment engine's internal economics, which are documented
by the repository's own `ARCHITECTURE.md`, `docs/adr/*` and the `PHASE_*` reports. Those were not
re-verified here.

## 1. Stack and entry points

| Part | Technology | Entry |
|---|---|---|
| Backend | Node.js, Express 5, Socket.IO 4.8 (+ optional `@socket.io/redis-adapter`), Prisma 5 / PostgreSQL, ioredis (or in-memory KV), zod, pino, jsonwebtoken, @simplewebauthn | `Backend/server.js` (1503 lines) → `src/app.js`, `src/sockets/socket.server.js`, `src/workers/*` |
| Dashboard | React 19, Vite 8, react-router 6, Tailwind 4, Mapbox GL 3, socket.io-client 4.8 | `Frontend/src/main.jsx`, `router/AppRouter.jsx` |
| Formal models | TLA+ (`formal/lifecycle.tla`, `formal/commitment.tla`) | not run in this audit |

Environment variable **names** from `Backend/.env.example`: `AGENT_MTLS_REQUIRED`, `AGENT_PROBE_INTERVAL_MS`,
`COMMAND_SIGNING_KEY`, `DATABASE_URL`, `DEFAULT_ADMIN_PIN`, `ENABLE_VIRTUAL_SIMULATOR`, `ENGINE_ENABLED`,
`FRONTEND_URL`, `GOOGLE_CLIENT_ID`, `HOST`, `JWT_SECRET`, `MAPBOX_TOKEN`, `NODE_ENV`, `PHYSICAL_FLEET_ENABLED`,
`PORT`, `PRIVACY_IDENTITY_KEY`, `PRIVACY_SURROGATE_SECRET`, `REDIS_ENABLED`, `REDIS_URL`, `ROBOTX_ENV`,
`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SHARD_CONSENSUS_REPLICATION`, `SHARD_ID`,
`V1_DEMONSTRATION_COMPOSITION`, `VERIFY_*` (six thresholds). A commented `PHYSICAL_FLEET_DECLARATION_FILE`
is also present. Also read by code: `SOCKET_PING_INTERVAL_MS`, `SOCKET_PING_TIMEOUT_MS`
(`src/config/socketTiming.js:34`), `FLEET_PROVIDER_DISPATCH` (`fleetProviders/index.js:50`). Secret values
were not read. The configured values on any real deployment are **UNKNOWN**.

Non-secret example defaults relevant to robots: `ENGINE_ENABLED=true`, `PHYSICAL_FLEET_ENABLED=false`,
`AGENT_MTLS_REQUIRED=false`, `AGENT_PROBE_INTERVAL_MS=2000`, `ENABLE_VIRTUAL_SIMULATOR=true`,
`REDIS_ENABLED=false`, and verification thresholds 25 m / 10 fixes per min / 0.8 corridor fraction /
10 s gap / 30 m half-width / 8.33 m/s.

## 2. Authentication and authorisation

- **Operators:** JWT from a `token` cookie or `Authorization: Bearer` (`src/middlewares/auth_middleware.js:27-50`). Google login, PIN, WebAuthn and password routes are in `src/routes/auth.routes.js:13-30`. All `/api/robots/*` routes require `authUser` (`robots.routes.js:13`), with action-class guards, rate limiters and retirement guards per route.
- **Dashboard sockets:** classified by a heuristic — an `Origin` header or a `Mozilla` User-Agent means a dashboard — and required to present the REST JWT before joining room `dashboard` (`socket.server.js:217-247`). The Pi deliberately sends `User-Agent: robotx-pi/2.2` and no Origin (`backend_link.py:382`).
- **Robots:** anonymous connect, then `AUTH {robotId, token | pairingCode}` (`robot.handler.js:731`). Unknown and retired robots get the same `AUTH_FAILED {reason: INVALID_CREDENTIAL}`. With `AGENT_MTLS_REQUIRED=true`, a certificate is required and pairing is refused (`robot.handler.js:294-346, 905-915`). **The Pi has no client-certificate support**, so that setting would lock it out. On success the backend emits **both** `AUTH_SUCCESS` and `AUTH_OK` with `{robotId, token, dedup, session}` (`robot.handler.js:1066-1068`), and the socket joins room `robot:{robotId}`.

## 3. Robot registration and pairing

| Step | Route / event | Evidence |
|---|---|---|
| Commission (create the robot, or re-mint a code) | `POST /api/robots/commission` | `robots.routes.js:47`, `robots.controller.js:349` |
| Pairing code | 6-digit `crypto.randomInt`, KV `pairing:{robotId}`, TTL 300 s | `robots.controller.js:34, 448-449` |
| Pairing status / unlock after lockout | `GET /:robotId/pairing`, `POST /:robotId/pairing/unlock` | `robots.routes.js:51-53` |
| Session token | issued on AUTH success; durable `RobotSession` model (commit `47a6da3`) | `prisma/schema.prisma` (`model RobotSession`) |
| Legacy commission | `POST /api/robots` | `robots.routes.js:72` |
| Dashboard pages | `CommissionPage.jsx`, `ConnectRobotPage.jsx`, `lib/robotEnrollment.js` | Frontend |

The Pi side of pairing is **INTEGRATION-TESTED** (Pi loopback tests and backend `tests/unit/sockets/pairingEnrollment.test.js`, passed today).

## 4. Key entities (Prisma)

Legacy/operational: `User`, `Robot`, `RobotSession`, `Location`, `Zone`, `ObstacleEvent`, `Campus`, `Task`,
`Telemetry`, `Event`, `Command`. Engine: `Region`, `Site`, `Agent`, `AgentClass`, `Mission`, `Leg`
(enum `LegState`), `Stop`, `Commitment` (enum `CustodyState`), `Outbox`, `Timer`, `Observation`,
`VerificationEvidence`, `BatteryState`, `Charger`, `Round`, `WorkQueue`, `Shard*`, `AgentCertificate`,
`AuditEvent`, and others (`prisma/schema.prisma`; models listed by grep). 35 migrations, the latest
`20261005180000_schema_cleanup_stage1`.

## 5. Mission and task lifecycle (engine path)

**Is the engine the only path?** Task intake goes through `engine/intake/intake.js`. When the engine is not
live for the resolved shard (process `ENGINE_ENABLED` **and** the shard's `cutover.engine_enabled`), intake
is **refused** (`src/services/task.service.js:30-60` header comments). The repository states the legacy
dispatcher was removed at the Phase 15 cutover (`src/engine/config/register/supplementary.json:2396`).
`dispatchTaskAssign` (event `TASK_ASSIGN`) still exists in `commandDispatcher.service.js:125-127`; its
remaining producer is the post-restart recovery sweep per the Pi's handoff notes. The Pi ignores
`TASK_ASSIGN` by design.

**Leg state chain** (`src/services/legProgress.service.js:7-35`):

```
QUEUED → OFFERED → ACCEPTED —DEPARTURE_DETECTED(≥5 m since grant)→ EN_ROUTE_PICKUP
  —ARRIVAL_VERIFIED(fix within VERIFY_ARRIVAL_RADIUS_M)→ AT_PICKUP —CUSTODY_ACQUIRED(agent report)→ LOADED
  —DEPARTURE→ EN_ROUTE_DROP —ARRIVAL_VERIFIED→ AT_DROP —CUSTODY_RELEASED→ RELEASED → settled on verified TASK_COMPLETE
```

Motion and arrival come from the **server's own** accepted position Observations, never the agent's claim.
Custody comes only from the agent's commitment-scoped `CUSTODY_EVENT`, and is held until the server has
verified arrival (`legProgress.service.js:23-30, 59-80`).

**Offer dispatch:** the outbox worker calls `deliverOutboxCommand`, which emits `io.to('robot:'+id).emit(envelope.command, envelope)`, so the event name *is* the command (`commandDispatcher.service.js:213-317`). It is suspended under the degraded "custodial" mode. It does not retry locally; the outbox worker retries with an escalation ladder.

**Responses:** `OFFER_ACCEPT/REJECT/DEFER` and `CUSTODY_EVENT` are handled in `src/sockets/handlers/offer.handler.js:498-582`. They are transactional, version-conditioned and gated by `agentGate.mayAct`. The accept path re-checks the robot's persisted state and its software stop latch.

**Timing defaults** (parameter register `src/engine/config/register/appendixA.json`, effective values depend
on the published config version — runtime values UNVERIFIED): `dispatch.offer_ttl` 20 s (`:852`),
`lease.duration` 60 s (`:1005`), `execute.start_grace` 60 s (`:1139`).

**Lease:** `HEARTBEAT {commitmentId, fence}` renews the lease (`robot.handler.js:1139-1151`;
`commitmentLeaseRenewal.service.js`).

**Completion:** `TASK_COMPLETE {taskId, lat, lon}` → `verifyCompletionClaim` grades the measured track. The
outcome is one of: unavailable → held and `TASK_COMPLETE_ACK {verifying:true}`; insufficient →
`VERIFYING` (operator); sufficient → settle the Leg and complete the Task → `TASK_COMPLETE_ACK {taskId}`;
repeat → `{alreadyCompleted:true}` (`src/sockets/handlers/dtaro.handler.js:153-326, 679`). The six
thresholds must be set; there is no default (`src/config/verificationThresholds.js:36-60`).

**Cancellation and reroute:** `POST /api/tasks/:taskId/cancel` (`taskCancellation.service.js`).
`POST /api/tasks/:taskId/reroute` returns **409 `ENGINE_REROUTE_UNAVAILABLE`** for engine-managed tasks
(`tasks.controller.js:440-456`).

## 6. Physical robots specifically

A physical robot is an assignment candidate only when (`docs/runbooks/physical-fleet.md`,
`src/services/fleetProviders/physicalPolicy.js`):

1. `PHYSICAL_FLEET_ENABLED=true` and `PHYSICAL_FLEET_DECLARATION_FILE` names a complete owner declaration (charging `MANUAL_OUT_OF_SERVICE`, SoC `OPERATOR_DECLARED` with `maxAgeSeconds`, e-stop `SOFTWARE_STOP_LATCH`, site ambient/terrain/dead-zones/constrictions/`snapRadiusM`, localisation `referenceRadiusM` and accepted fix types, risk prior, and per-robot control and energy blocks). A missing section turns its policy off and the engine "keeps denying by name" (`physicalPolicy.js:1-25, 133-207`). Example: `docs/runbooks/physical-fleet.declaration.example.json`.
2. A **fresh operator SoC declaration**: `POST /api/robots/:robotId/soc-declaration {socPct}` (`robots.routes.js:57`). **No dashboard UI calls it** (grep of `Frontend/src`).
3. Live Pi reports: HEARTBEAT, TELEMETRY with `position.fixType` in the accepted set and the robot within 5 m of a permitted campus way, `safety.stopLatch.engaged=false`, and a recent `PROBE_RESULT` on the current socket.
4. `COMMAND_SIGNING_KEY` set, and the same string configured on the Pi (manual provisioning; no mechanism exists).
5. Clocks within 500 ms (runbook "Known limits").
6. Mixed fleet recommended: a physical-only process has no charger availability projection (runbook B2).

Proof tool: `node tools/verify/gate1PhysicalOffer.js --database-url <disposable db>` — **NOT RUN** (needs a
disposable database).

## 7. Socket.IO events (robot-facing)

Listeners (backend ← robot): `AUTH` (`robot.handler.js:731`), `HEARTBEAT`/`heartbeat` (`:1228-1230`),
`PROBE_RESULT` (`:1216`), `SESSION_REKEY_ACK` (`:1324`), `TELEMETRY`/`telemetry`
(`telemetry.handler.js:1134-1136`), `COMMAND_ACK` (`command.handler.js:211`), `OFFER_ACCEPT/REJECT/DEFER`,
`CUSTODY_EVENT` (`offer.handler.js:498-564`), `TASK_COMPLETE`, `OBSTACLE_REPORT`, `ROBOT_FAULT`
(`dtaro.handler.js:115-329`).

Emitters (backend → robot room): `AUTH_SUCCESS`, `AUTH_OK`, `AUTH_FAILED`, `PROBE`
(`agentProbe.service.js:201`), `COMMAND` (`commandDispatcher.service.js:156-160`), `STOP` (`:173-175`),
`TASK_ASSIGN` (`:125-127`), `REROUTE_ALERT` (`:136-139`; `alertDissemination.service.js:101`), engine
envelopes by command name (`:312`), `SESSION_REKEY` (mTLS sessions only, `robot.handler.js:1317`),
`TASK_COMPLETE_ACK`, `OBSTACLE_REPORT_ACK`, `ROBOT_FAULT_ACK`, `AUTH_REQUIRED`, `ERROR`.

Dashboard room events: `robot_online/offline/unregistered/retired`, `robot:update`, `ROBOT_UPDATE(D)`,
`ROBOT_COMMISSIONED`, `TASK_CREATED/ASSIGNED/UPDATED`, `COMMAND_STATUS`, `OFFER_RESPONSE`,
`SECURITY_EVENT`, `SUPERVISION_SIGNAL`, `ALERT_CREATED`, `REROUTE_ALERT`, `ZONE_UPDATED`.

Robot-side coverage is compared field by field in [INTERFACE_AND_PROTOCOL_CONTRACTS.md](INTERFACE_AND_PROTOCOL_CONTRACTS.md).

## 8. Telemetry ingestion and presence

- Schema: optional `robotId`, `lat`, `lon`, `speed`, `battery`, `status`, `distanceTravelled`, `timestamp`, `sequence`; passthrough for other keys (`telemetry.handler.js:436-456`). It requires a prior AUTH on the socket.
- Status vocabulary accepted: `IDLE, ACTIVE, PAUSED, OFFLINE, ERROR, ISSUES, RETURNING, CHARGING`, with an allowed-transition table (`telemetry.handler.js:305-315`).
- Position Observations: `position.fixType ∈ {NO_FIX, 2D, 3D, RTK_FLOAT, RTK_FIXED}`, `hAccM > 0`, optional `deadReckoned` (`positionObservation.service.js:180-200, 435-482`).
- Stop latch: recorded per socket from `safety.stopLatch` (`telemetry.handler.js:1068-1073`; `stopLatchObservation.service.js`).
- Presence: `markRobotOnline/Offline`, socket-id-conditioned writes on disconnect (`robot.handler.js:1355-1400`).
- Socket heartbeat: `pingInterval` 10 s / `pingTimeout` 5 s by default, refused at boot above a 15 s sum (`src/config/socketTiming.js:20-34`).

## 9. Operator command pathways

`POST /api/robots/:robotId/command {type: STOP|PAUSE|RETURN|RESUME}` → `Command` row (SENT) →
`dispatchCommand` emits `COMMAND {commandId, type, timestamp[, commitmentId on RESUME]}` with no
immediate retry. Redelivery happens on a 5 s reliability scheduler (per the dispatcher comments). The robot
replies `COMMAND_ACK {commandId}`, which sets the row to ACK and emits `COMMAND_STATUS` to the dashboard
(`command.handler.js:211-321`). Dashboard: `Frontend/src/lib/api/robots.js:70-76` (`sendCommand`).
`POST /:robotId/clear-fault` exists (`robots.routes.js:59`) with no dashboard caller found.

## 10. Dashboard coverage gaps (robot operations)

| Operation | Backend | Dashboard | Pi |
|---|---|---|---|
| Commission / pairing code | yes | yes | consumes the code |
| STOP/PAUSE/RESUME/RETURN | yes | yes | applies |
| SoC declaration | yes | **no UI found** | — |
| Clear fault | yes | **no UI found** | — |
| Custody ACQUIRED/RELEASED | via robot `CUSTODY_EVENT` only | **none** | local API only (loopback by default) |
| ESP32 controller RESET | — | **none** | local API `/controller/reset` |
| Pi e-stop / clear | — | **none** | local API `/safety/estop`, `/safety/clear` |

## 11. Tests

Targeted robot-contract run today: 40 suites / 791 tests passed (see the [ledger](TESTING_AND_VERIFICATION.md)).
The full suite (5 jest lanes including chaos and scale), `npm run gates`, the TLA+ models and
`tools/verify/*` were **NOT RUN**.

## 12. Repository hygiene observations

- Branch `feature/dashboard` is 5 commits ahead of its remote (`de03788`, `906bcb2`, `c4de8d2`, `8315836`, `921df39`). They are unpushed and unreviewed remotely.
- Several linked worktrees exist under `C:/Users/soman/robotx-*` (for example `robotx-routing-batch-1`, `robotx-sim-batch-2`, `robotx-v1-spatial`). Not inspected.
- The repository root carries many large historical reports (`PHASE_*`, `ARCHITECTURE.md` ~208 KB, PDFs). Treat them as history, not current truth.

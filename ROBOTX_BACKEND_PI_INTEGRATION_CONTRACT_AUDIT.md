# RobotX / FalconAut Backend — Raspberry Pi Integration Contract Audit

**Audit date:** 2026-09-22
**Branch:** `feature/dashboard` @ `1eff8e2`
**Scope:** read-only trace of the existing robot ↔ backend ↔ dashboard contract.
**Method:** source code is the sole authority. Documentation was consulted only where code was silent, and is labelled as such.

**Evidence labels used throughout**

| Label | Meaning |
|---|---|
| `FOUND IN CODE` | traced to an executing statement in `Backend/src/**` or `Backend/server.js` |
| `FOUND IN SCHEMA` | `Backend/prisma/schema.prisma` |
| `FOUND IN DOCUMENTATION` | a `.md`/comment claim, **not** verified in code |
| `MEASURED` | verified by executing a probe against the installed libraries during this audit |
| `NOT FOUND IN REPOSITORY` | exhaustive grep returned nothing |
| `INFERRED` | a conclusion drawn from code, marked because it is not stated anywhere |

---

## 1. Executive summary

The backend **already has a complete, working, single-namespace Socket.IO robot protocol**. It is not a design that needs to be invented — it is a shipped contract with a reference client (`VirtualRobot.js`) that exercises every event.

The five findings that matter most for the Pi:

1. **Robot authentication is in-band, not in the handshake.** The Pi connects anonymously, then emits an `AUTH` event. There is no `handshake.auth` requirement for robots. `FOUND IN CODE` — `robot.handler.js:431`.

2. **The only usable credential path for physical hardware is the pairing-code flow.** `POST /api/robots/commission` mints a 6-digit code with a 300-second TTL; the Pi presents it once in `AUTH`, receives a session token in `AUTH_SUCCESS`, and must **persist that token to disk** for all later reconnects. The simulator bypasses this entirely by writing `session:{robotId}` straight into Redis — a path the Pi cannot and must not use. `FOUND IN CODE` — `robots.controller.js:431`, `robot.handler.js:566`, `VirtualRobot.js:743`.

3. **Every authentication failure is a silent `socket.disconnect(true)`.** No error event, no reason code, no message to the client. There are **eight distinct** disconnect-without-explanation branches in the AUTH handler. This is the single largest cost to Pi bring-up and is listed as a blocker. `FOUND IN CODE` — `robot.handler.js:436,443,452,478,539,551,560` and the `catch` at `:694`.

4. **A robot that sends an `Origin` header, or a `User-Agent` containing `Mozilla`, is classified as a dashboard**, fails the JWT check, and is disconnected after receiving `UNAUTHORIZED`. The client-type discriminator is a header heuristic, not a declared role. `FOUND IN CODE` — `socket.server.js:194-218`. `MEASURED`: the Node `socket.io-client` sends neither header on either transport, so the default configuration is safe; a hand-rolled or browser-derived client is not.

5. **Task assignment is currently unreachable.** `ENGINE_ENABLED=false` in `Backend/.env`, and Phase 15 removed the legacy decision path from the build. `assignTask` therefore throws `ENGINE_NOT_LIVE` (HTTP 503) before writing anything. The Pi can connect, authenticate, stream telemetry, appear online, and receive operator commands — but **nothing in the system can currently assign it a task**. `FOUND IN CODE` — `task.service.js:872-885`, `Backend/.env:ENGINE_ENABLED=false`.

**Bottom line:** telemetry and operator-command round-trip for one physical robot is achievable with **no backend changes**. Task/mission delivery is not, and is gated on a cutover decision that is out of scope for this integration.

---

## 2. Backend architecture

```
Backend/
├── server.js                         composition root: HTTP + Socket.IO + Redis adapter
├── src/
│   ├── app.js                        express app (REST)
│   ├── sockets/
│   │   ├── socket.server.js          io.on("connection") — client classification
│   │   ├── robotSockets.js           process-local Map<robotId, Socket> (presence only)
│   │   ├── rateLimit.js              per-socket per-event throttle
│   │   └── handlers/
│   │       ├── robot.handler.js      AUTH, HEARTBEAT, SESSION_REKEY_ACK, disconnect
│   │       ├── telemetry.handler.js  TELEMETRY
│   │       ├── command.handler.js    COMMAND_ACK
│   │       ├── dtaro.handler.js      OBSTACLE_REPORT, TASK_COMPLETE, ROBOT_FAULT
│   │       └── offer.handler.js      OFFER_ACCEPT/REJECT/DEFER  (inert — engine off)
│   ├── services/
│   │   ├── commandDispatcher.service.js   the ONLY server→robot emit path
│   │   ├── robotRegistry.service.js       Redis live-state registry
│   │   ├── positionObservation.service.js telemetry → Observation (engine evidence)
│   │   └── telemetry.service.js           Telemetry history rows
│   ├── controllers/robots.controller.js   commissioning, pairing, operator commands
│   └── simulation/VirtualRobot.js         reference robot client (2998 lines)
└── prisma/schema.prisma
```

**Process topology** — `FOUND IN CODE`, `server.js:378-398,518-519,1137`:
- HTTP server binds `HOST` (default `0.0.0.0`) port `PORT` (default `3000`).
- One `socket.io` `Server` attached to it, with a Redis adapter (`@socket.io/redis-adapter`) so `io.to(room)` fans out across worker processes.
- The in-process simulator is **opt-in** via `ENABLE_VIRTUAL_SIMULATOR=true`; it connects back to `http://127.0.0.1:${port}` as an ordinary Socket.IO client.

**Two independent authentication domains:**
- REST (`/api/**`) → `authUser` middleware → JWT in an HttpOnly `token` cookie.
- Socket robots → the in-band `AUTH` event → Redis-held pairing code or session token.

---

## 3. Socket.IO architecture

| Property | Value | Evidence |
|---|---|---|
| Library (server) | `socket.io` 4.8.3, `engine.io` 6.6.6 | `MEASURED` |
| Library (reference client) | `socket.io-client` 4.8.3 | `MEASURED` |
| **Namespace** | `/` (default). `io.of(...)` appears **nowhere** in the repository. | `FOUND IN CODE` — grep for `io.of(` returns zero hits |
| **Path** | `/socket.io/` (default). No `path:` option is passed to `new Server()`. | `FOUND IN CODE` — `server.js:379` |
| **Transports** | Both `polling` and `websocket`. The server sets no `transports` restriction. `VirtualRobot` chooses `["websocket"]`. | `FOUND IN CODE` — `server.js:379`, `VirtualRobot.js:810` |
| **CORS** | `origin` delegate → `isOriginAllowed()`, `credentials: true` | `FOUND IN CODE` — `server.js:380-386`, `config/cors.js:26-53` |
| **CORS effect on robots** | `isOriginAllowed(undefined)` returns `false`, but the `cors` package merely **omits** the header and calls `next()` — it does **not** reject. A no-Origin robot connects normally. | `FOUND IN CODE` + `MEASURED` (`cors/lib/index.js`, engine.io `_applyMiddlewares`) |
| **Connection URL** | `http://<host>:3000` — no namespace suffix, no custom path | `INFERRED` from the two rows above |
| **Required headers** | **None** for a robot. | `FOUND IN CODE` |
| **Forbidden headers** | `Origin` (any value), and any `User-Agent` containing the substring `Mozilla` | `FOUND IN CODE` — `socket.server.js:194-196` |

### 3.1 Client classification — the trap

`socket.server.js:193-218`:

```js
const origin = socket?.handshake?.headers?.origin;
const ua     = socket?.handshake?.headers?.["user-agent"];
const isDashboard = !!(origin || (typeof ua === "string" && ua.includes("Mozilla")));

if (isDashboard) {
    const token = getDashboardToken(socket);          // cookie `token`, else handshake.auth.token
    const user  = token ? await verifyUserToken(token).catch(() => null) : null;
    if (!user) {
        socket.emit("UNAUTHORIZED", { message: "Authentication required" });
        socket.disconnect(true);
        return;                                        // ← robot handlers NEVER registered
    }
    ...
}
```

There is no explicit "I am a robot" declaration. Classification is purely the header heuristic above. A client misclassified as a dashboard never reaches `registerRobotHandlers`, so its `AUTH` event has no listener at all.

**`MEASURED` during this audit** — a Node `socket.io-client` handshake, both transports:

| Transport | `origin` | `user-agent` | `isDashboard` |
|---|---|---|---|
| `["websocket"]` | *(absent)* | *(absent)* | `false` ✅ |
| default (polling→ws) | *(absent)* | `node-XMLHttpRequest` | `false` ✅ |

### 3.2 Rooms

| Room | Joined by | When | Evidence |
|---|---|---|---|
| `dashboard` | browser clients with a valid admin JWT | at connection | `socket.server.js:222` |
| `robot:{robotId}` | the robot socket itself | **after** successful AUTH | `robot.handler.js:657` |

Every server→robot message is emitted to `robot:{robotId}` via the Socket.IO adapter, never through the process-local `robotSockets` Map. That Map is used for presence/identity checks only. `FOUND IN CODE` — `commandDispatcher.service.js:5-19,83-116`.

### 3.3 Redis keys touched by a robot session

`FOUND IN CODE` — across `robot.handler.js`, `telemetry.handler.js`, `robots.controller.js`:

| Key | Written by | TTL | Meaning |
|---|---|---|---|
| `pairing:{robotId}` | `POST /api/robots/commission` | 300 s | the 6-digit pairing code |
| `session:{robotId}` | AUTH success | 86 400 s | the bearer session token |
| `pairingAttempts:{robotId}` | failed AUTH | 300 s | brute-force counter |
| `pairingLocked:{robotId}` | 5 failures | 3 600 s | lockout flag |
| `socket:{socket.id}` | AUTH success | 3 600 s | reverse socket→robot binding |
| `robot:{robotId}` | TELEMETRY | 15 s | live state read by dashboard + REST |
| `registry:{robotId}` | TELEMETRY | see `REGISTRY_TTL` | DTARO registry (utilization, zone, heartbeat) |
| `robots:all` (set) | AUTH success | — | live-robot index |
| `snapshotState:{robotId}` | TELEMETRY | 86 400 s | history-write throttle |
| `vr:battery:{robotId}` | TELEMETRY | 48 h | battery persistence |

---

## 4. Exact event contract

### 4.1 Robot → Server

---

**Event:** `AUTH`
**Direction:** Robot → Server
**Producer:** the robot, on every `connect`
**Consumer:** `robot.handler.js:431`
**Payload (zod, `.passthrough()`, `robot.handler.js:411-429`):**
```
robotId      string, min length 1        REQUIRED
token        string | number             optional, nullable  — session token
pairingCode  string | number             optional, nullable  — 6-digit commissioning code
dedupState   unknown                     optional            — §11.5, engine-only, inert
certificate  unknown                     optional            — §23.2 mTLS, off by default
```
**Required fields:** `robotId`, plus **exactly one of** `token` (reconnect) or `pairingCode` (first pair).
**Optional fields:** `dedupState`, `certificate`. Any extra key is admitted by `passthrough()` **except** a capability claim — see below.
**ACK:** `AUTH_SUCCESS` **and** `AUTH_OK` (both emitted, same payload).
**Error behavior:** `socket.disconnect(true)` with **no message**, on any of:

| Line | Condition |
|---|---|
| `:436` | rate limit exceeded (5 per 60 s, min 100 ms spacing) — *returns silently, no disconnect* |
| `:439` | zod parse failure |
| `:443` | `robotId` missing/empty |
| `:452` | robot not found in Postgres |
| `:478` | certificate session refused (mTLS only) |
| `:539` | `AGENT_MTLS_REQUIRED=true` and the client fell to the pairing branch |
| `:551` | robot is pairing-locked |
| `:560` | pairing code absent, or does not match the stored code |
| `:694` | any thrown exception in the handler |

**Capability-claim rejection** — `robot.handler.js:462`, `security/attestation.findCapabilityClaims`: any key named like a capability claim anywhere in the AUTH payload is logged and rejected. The Pi must **not** put a `capabilities` field in `AUTH` or `TELEMETRY`.

---

**Event:** `TELEMETRY` (alias: `telemetry`)
**Direction:** Robot → Server
**Producer:** the robot, per tick
**Consumer:** `telemetry.handler.js:958,960` → `handleTelemetry` at `:402`
**Payload (zod, `.passthrough()`, `telemetry.handler.js:380-400`):**
```
robotId            string | number   optional  — IGNORED; identity comes from socket.data.robotId
lat                number | null     optional  — string-coerced by `numOpt`
lon                number | null     optional
speed              number | null     optional  — m/s (INFERRED; no unit is asserted in code)
battery            number | null     optional  — PERCENT 0..100 (see §6)
status             string | number   optional, nullable
distanceTravelled  number | null     optional  — metres, cumulative
timestamp          number | null     optional  — epoch ms, MEASURED BY THE AGENT
sequence           number | null     optional  — per-robot monotonic ordinal
heading            (undeclared)      optional  — admitted by passthrough(), read at :477
```
**Required fields:** none are schema-required. **But** see the hard behavioural requirements in §7.
**ACK:** none. Telemetry is never acknowledged.
**Error behavior:**
- Not authenticated → `AUTH_REQUIRED` emitted, frame dropped (`:417`).
- Robot row deleted mid-session → `robot_unregistered` to dashboard, frame dropped (`:490`, `:769`).
- Capability claim present → **whole frame dropped**, counts toward quarantine threshold (`:449-460`).
- Rate limit / backpressure → **silent drop**, no signal (`:406,408`).
- §23.5 trust-boundary refusal → logged; frame dropped **only if** `enforced` (engine on). With the engine off it is logged and processed. (`:526-541`)

**Rate limit:** 50 events per 5 000 ms, minimum 100 ms spacing → **hard ceiling 10 Hz**. `FOUND IN CODE` — `:408`.
**Backpressure:** frames dropped when the websocket `bufferedAmount` exceeds `SOCKET_BUFFER_LIMIT_BYTES` (default 1 000 000). `:353-366`.

---

**Event:** `HEARTBEAT` (alias: `heartbeat`)
**Direction:** Robot → Server
**Producer:** the robot, per tick
**Consumer:** `robot.handler.js:771,773` → `handleHeartbeat` at `:708`
**Payload:** **none — the handler takes no argument.** `FOUND IN CODE` — `socket.on("HEARTBEAT", () => handleHeartbeat("HEARTBEAT"))`. Any payload sent is discarded.
**ACK:** none.
**Error behavior:** silently ignored if unauthenticated or rate-limited.
**Rate limit:** 10 per 5 000 ms, min 100 ms spacing.
**Effect:** writes `lastHeartbeat` to Redis on **every** beat; writes `Robot.lastSeenAt` to Postgres at most once per `DB_FLUSH_INTERVAL_MS` (15 s).

---

**Event:** `COMMAND_ACK`
**Direction:** Robot → Server
**Producer:** the robot, in answer to `COMMAND`
**Consumer:** `command.handler.js:82`
**Payload (zod, `.passthrough()`, `:80`):**
```
commandId  string, min length 1   REQUIRED (legacy operator command)
```
Engine variant, same event (`:23-31`, only read when the cutover gate allows — currently never):
```
outboxId       string           REQUIRED
fence          string | number  optional
authorityEpoch string | number  optional
```
**Optional fields:** the reference client also sends `robotId` and `timestamp`; both are admitted by `passthrough()` and **not read**. `VirtualRobot.js:1651`.
**ACK:** none to the robot. `COMMAND_STATUS` is emitted to the `dashboard` room.
**Error behavior:** unknown `commandId` → silently ignored (`:118`). Parse failure → silently ignored (`:108`).
**Effect:** `Command.status` `SENT` → `ACK`, `executedAt` set, response time recorded, retry key cleared.
**Rate limit:** 20 per 60 000 ms.

---

**Event:** `TASK_COMPLETE`
**Direction:** Robot → Server
**Producer:** the robot, on finishing a task
**Consumer:** `dtaro.handler.js:147`
**Payload:** no zod schema is applied to the envelope. Fields read:
```
taskId   string   optional — may name a Task OR a Leg; resolved by resolveCompletedTaskId
```
The whole payload is additionally passed to `verifyCompletionClaim` (engine, inert while `ENGINE_ENABLED=false`).
**ACK:** `TASK_COMPLETE_ACK` `{ taskId, timestamp }`, or `{ taskId, verifying: true, timestamp }` when verification is insufficient.
**Error behavior:** unauthenticated → silent return (`:152`). Unresolvable `taskId` → logged at error, **and the robot is still released to IDLE**.
**Effect:** Task → `COMPLETED`; `Robot.currentTaskId = null`, `status = IDLE`, `speed = 0`; `TASK_UPDATED` to dashboard.
**Rate limit:** 5 per 30 000 ms, min 1 000 ms spacing.

---

**Event:** `OBSTACLE_REPORT`
**Direction:** Robot → Server
**Producer:** the robot's perception stack
**Consumer:** `dtaro.handler.js:109`
**Payload (zod, `dtaro.handler.js:77-81`):**
```
lat       number    REQUIRED  (strict number — a numeric STRING is rejected)
lon       number    REQUIRED
severity  (see schema line 80)
```
**ACK:** `OBSTACLE_REPORT_ACK` `{ obstacleId, affectedRobots, timestamp }`.
**Error behavior:** emits `ERROR` `{ event, reason, details }` — this is the **only** robot-facing event that reports a validation failure explicitly.
**Rate limit:** 10 per 60 000 ms, min 500 ms spacing.

---

**Event:** `ROBOT_FAULT`
**Direction:** Robot → Server
**Producer:** the robot's health monitor
**Consumer:** `dtaro.handler.js:276`
**Payload (zod, `dtaro.handler.js:83-87`):**
```
code      string   optional  → defaults to "UNKNOWN"
message   string   optional  → defaults to "Unspecified fault"
sensor    string   optional  → defaults to null
blocking  boolean  optional  → read at :313; `false` ⇒ catalogue row A6, anything else ⇒ A5
```
**ACK:** `ROBOT_FAULT_ACK` `{ timestamp }`.
**Error behavior:** a parse failure falls back to `{}` and the defaults — the fault is still recorded.
**Effect:** `Robot.status = ERROR` (**irreversible from the robot side** — see §9), registry `healthStatus = FAULT`, a `CRITICAL` Event row, `ROBOT_UPDATED` to dashboard.
**Rate limit:** 5 per 60 000 ms, min 1 000 ms spacing.

---

**Event:** `SESSION_REKEY_ACK`
**Direction:** Robot → Server
**Consumer:** `robot.handler.js:867`
**Payload:** `{ sessionId?: string }`. The agent id is deliberately **not** a parameter.
**Relevance to the Pi:** **none while `AGENT_MTLS_REQUIRED=false`** — `maybeRekeySession` returns immediately when the socket holds no certificate binding (`:793`).

---

**Events:** `OFFER_ACCEPT`, `OFFER_REJECT`, `OFFER_DEFER`
**Consumer:** `offer.handler.js:297,311,348`
**Payload (zod, `:37-44`):** `{ commitmentId: string, fence: string|number, reason?, until? }`
**Status:** **inert.** These only ever answer an `OFFER`, an `OFFER` only exists as an outbox row written by an engine commit, and no commit runs with `ENGINE_ENABLED=false`. The handler additionally re-checks the gate. `FOUND IN CODE` — `offer.handler.js:12-19`.

---

### 4.2 Server → Robot

---

**Event:** `AUTH_SUCCESS` (and identical alias `AUTH_OK`)
**Producer:** `robot.handler.js:651,653`
**Payload:**
```
robotId  string
token    string | null   — the session token to PERSIST. null in MTLS mode.
dedup    object | null   — §11.5 handshake outcome; null when the engine gate refuses
session  { mode: "LEGACY"|"MTLS", sessionId, fingerprint, keyStorage, expiresAt }
```
For a legacy (pairing/token) session: `mode: "LEGACY"`, `sessionId: socket.id`, the other three `null`.
**Consumer (reference):** `VirtualRobot.js:831` / `:847`.
**Note:** both events fire for one handshake. The reference client guards with `this._handlerSocket !== this.socket` so it does not process the handshake twice (`:849`). **The Pi must do the same, or listen to only one of the two.**

---

**Event:** `AUTH_REQUIRED`
**Producer:** `telemetry.handler.js:417` — emitted when TELEMETRY arrives on an unauthenticated socket
**Payload:** `{ robotId }` — echoed from the frame, may be `null`
**Expected robot behavior:** re-send `AUTH`. `VirtualRobot.js:856`.

---

**Event:** `COMMAND`
**Producer:** `commandDispatcher.dispatchCommand()` at `commandDispatcher.service.js:155`, called from `robots.controller.js:779` (`POST /api/robots/:robotId/command`) and its retry scheduler at `:762`
**Payload:**
```
commandId  string    the Command row id (uuid)
type       "STOP" | "PAUSE" | "RETURN" | "RESUME"
timestamp  number    epoch ms, server clock
```
**ACK:** **REQUIRED** — `COMMAND_ACK { commandId }`. Without it the reliability scheduler re-dispatches at 5 s, 10 s, 15 s, then sets `Command.status = FAILED`.
**Retries on dispatch:** `retries: 0` — one attempt only; durability comes from the 5 s scheduler.

---

**Event:** `STOP`
**Producer:** `commandDispatcher.dispatchStop()` at `:170`, called from `tasks.controller.js:278` on task cancellation
**Payload:** `{ taskId?, reason?, timestamp }` — `reason` is `"TASK_CANCELLED"` at the only call site
**ACK:** **none expected.** Explicitly documented as fire-and-forget (`:158-168`).
**Note:** this is a *different event* from `COMMAND` with `type: "STOP"`. The Pi must handle both.

---

**Event:** `TASK_ASSIGN`
**Producer:** `commandDispatcher.dispatchTaskAssign()` at `:126`
**Call sites:** **exactly one** — `server.js:1261`, the post-restart task-recovery sweep. `FOUND IN CODE`; exhaustive grep confirms no other producer.
**Payload:**
```
taskId        string
pickup        { lat, lon }
drop          { lat, lon }
pathToPickup  array of route points
pathToDrop    array of route points
timestamp     number
```
**ACK:** none. Completion is reported later via `TASK_COMPLETE`.
**Status:** reachable **only** for a task already `ASSIGNED`/`IN_PROGRESS` in the database with a cached `taskPath:{taskId}` — i.e. a restart recovery. There is no live assignment producer while the engine is off.

---

**Event:** `REROUTE_ALERT`
**Producer:** `commandDispatcher.dispatchRerouteAlert()` at `:138`, called from `task.service.js:1078`
**Payload:** `{ obstacleId, lat, lon, zoneId?, severity?, newPath?, timestamp }`
**ACK:** none. `retries: 1`.

---

**Event:** `SESSION_REKEY`
**Producer:** `robot.handler.js:860` — mTLS sessions only
**Payload:** `sessionBinding.rekeyCommandPayload({ sessionId, reason: "SESSION_MAX_AGE", notValidAfter })`
**Relevance to the Pi:** none while `AGENT_MTLS_REQUIRED=false`.

---

**Event:** `ERROR`
**Producer:** `dtaro.handler.js:115,121` — **`OBSTACLE_REPORT` only**
**Payload:** `{ event, reason, details? }`

---

**Event:** `UNAUTHORIZED`
**Producer:** `socket.server.js:216`
**Payload:** `{ message: "Authentication required" }`
**Meaning for the Pi:** *you were classified as a dashboard client.* Receiving this means the handshake carried an `Origin` or a `Mozilla` user-agent. See §3.1.

---

**Event:** `RETURN_TO_BASE`
**Consumer:** `VirtualRobot.js:950`
**Producer:** **NOT FOUND IN REPOSITORY.** Exhaustive grep across `src/` and `server.js` finds no emitter. The reference client listens for a dead event. The live equivalent is `COMMAND` with `type: "RETURN"`.

---

**Engine command events** — `OFFER`, `WITHDRAW`, `REROUTE`, `RESEQUENCE`, `RECALL`, `RESUME`, `TRANSFER_CUSTODY`, `ABORT_MISSION`, `STAND_DOWN_ALL`, `QUARANTINE`, `RELEASE_QUARANTINE`, `ESTOP_CLEAR`, `SHARD_MIGRATE`, `PARAMETER_PUSH`, `STATUS_REQUEST`, `PROBE`, `MANIFEST_QUERY`.
`FOUND IN CODE` — `engine/commitment/fencing.js:59-82`. Emitted by `deliverOutboxCommand` (`commandDispatcher.service.js:308`), where **the event name is the command name**. All unreachable while `ENGINE_ENABLED=false`. **The Pi should not implement these for the immediate target.**

---

### 4.3 Server → Dashboard (robot-originated)

| Event | Emitted at | Payload | Dashboard subscribes? |
|---|---|---|---|
| `robot:update` | `telemetry.handler.js:936` | the full merged live state | **YES** — `AppProvider.jsx:728` |
| `robot_online` | `robot.handler.js:655` | `{ robotId }` | **NO** — absent from `DASHBOARD_EVENTS` |
| `robot_offline` | `robot.handler.js:931` | `{ robotId }` | **NO** |
| `robot_unregistered` | `telemetry.handler.js:490,769` | `{ robotId }` | **NO** |
| `ROBOT_UPDATED` | `dtaro.handler.js:352` | `{ robotId, status, healthStatus, fault, classification, timestamp }` | **YES** |
| `TASK_UPDATED` | `dtaro.handler.js:217,262` | `{ robotId, taskId, status, timestamp }` | **YES** |
| `COMMAND_STATUS` | `command.handler.js:159` | `{ commandId, status: "ACK", responseTimeMs }` | **NO** |
| `SECURITY_EVENT` | `telemetry.handler.js:102`, `dtaro.handler.js:204` | `{ kind, robotId, ... }` | **NO** |
| `SUPERVISION_SIGNAL` | `telemetry.handler.js:1127` | §12.3 progress signals | **NO** |
| `TASK_ASSIGNED` | `offer.handler.js:158`, `socket.server.js:244` | route overlay | **YES** |

The exact `robot:update` payload (`telemetry.handler.js` `fullState`, built at `:640-679`):
```js
{ robotId, lat, lon, battery, status, speed, isOnline: true,
  lastSeenAt: <epoch ms>, heading, distanceTravelled }
```
`status` here is the **raw** incoming status (so `CHARGING` and `RETURNING` survive to the UI), not the DB-mapped one.

---

## 5. Authentication contract

### 5.1 The direct answer

> **"What exactly must the Raspberry Pi send during Socket.IO connection for the backend to accept it as robot X?"**

**During the handshake: nothing.** No auth object, no query parameter, no header. The Pi must merely *avoid* sending `Origin` or a `Mozilla` user-agent.

**Immediately after `connect`, it must emit:**

First ever connection (commissioning):
```json
["AUTH", { "robotId": "ROBOT-X", "pairingCode": "418203" }]
```
Every subsequent connection:
```json
["AUTH", { "robotId": "ROBOT-X", "token": "<uuid from AUTH_SUCCESS>" }]
```

**AUTHENTICATION IS IMPLEMENTED.** It is a Redis-backed shared-secret scheme with an optional mTLS upgrade.

### 5.2 Preconditions the backend enforces

1. **A `Robot` row must exist** with `robotId = "ROBOT-X"`. `robot.handler.js:448-452` does `prisma.robot.findUnique` and disconnects if absent.
2. **Either** `pairing:{robotId}` **or** `session:{robotId}` must exist in Redis.
3. Pairing must not be locked (`pairingLocked:{robotId}`).

### 5.3 The two credential paths

**A. Pairing (bootstrap)** — `robot.handler.js:530-568`
- Operator calls `POST /api/robots/commission` with an admin JWT cookie.
- The controller writes `pairing:{robotId} = <6 digits>` with `ex: 300` (`robots.controller.js:431`) and returns `{ ok, robot, pairingCode, expiresIn: 300 }`.
- The Pi presents it in `AUTH.pairingCode`.
- On match: `pairing:{robotId}` is **deleted**, the attempt counter cleared, and `nextToken = crypto.randomUUID()` is stored as `session:{robotId}` with `ex: 86400` and returned in `AUTH_SUCCESS.token`. (`:565-567`)
- On mismatch: `recordPairingAttempt` increments `pairingAttempts:{robotId}` (`ex: 300`); at **5** attempts `pairingLocked:{robotId}` is set for **3 600 s**. Then `socket.disconnect(true)`. (`:553-561`)
- Lockout is keyed by **robotId, not socket** — reconnecting does not reset it. Operator recovery is `POST /api/robots/:robotId/pairing/unlock`, which requires `QUARANTINE_OVERRIDE` (elevated role + recorded reason + second approver).

**B. Session token (steady state)** — `robot.handler.js:528-532`
```js
} else if (sessionToken && token && token === sessionToken) {
    nextToken = sessionToken;
    await kv.set(`session:${robotId}`, nextToken, { ex: 86400 });
}
```
A plain string equality against the Redis value, with the TTL refreshed to 24 h on each success.

> **Operational consequence, `INFERRED` from the TTL:** a Pi that stays offline for more than **24 hours** loses its session key to Redis expiry and must be re-paired by an operator. There is no automatic re-pairing path.

### 5.4 mTLS (present, off)

`AGENT_MTLS_REQUIRED=false` in `Backend/.env`. When a certificate *is* presented it is validated and bound even with the flag off (`robot.handler.js:466-493`). Three sources are accepted (`peerCertificateOf`, `:186-200`): `socket.request.socket.getPeerCertificate()`, the `x-client-cert` header from a trusted proxy, or `handshake.auth.certificate` / `AUTH.certificate`.

**The Pi should send no certificate.** Doing so switches it into the MTLS branch, where `AUTH_SUCCESS.token` is `null` and the session becomes certificate-bound.

### 5.5 Type-confusion guard worth knowing about

`robot.handler.js:507-522`: if `session:{robotId}` holds a JSON *certificate binding* rather than an opaque token, it is refused as a bearer credential and the robot falls through to pairing. A Pi that once connected with a certificate and later connects without one will therefore need a pairing code.

---

## 6. Robot data model

### 6.1 `model Robot` — `FOUND IN SCHEMA`, `prisma/schema.prisma:201-359`

| Backend field | Type | Nullable | Required | Default | Used by | Meaning based on code |
|---|---|---|---|---|---|---|
| `id` | `String` | no | yes | `uuid()` | all FKs | internal surrogate key — **not** the wire id |
| `robotId` | `String @unique` | no | **yes** | — | AUTH, all Redis keys, rooms | **the wire identity the Pi sends** |
| `name` | `String?` | **yes** | no | — | dashboard | display label |
| `locationId` | `String` | **no** | **yes** | — | commissioning | FK → `Location`; blocks commissioning if invalid |
| `campusId` | `String?` | yes | no | — | spatial | FK → `Campus` |
| `zoneId` | `String?` | yes | no | — | DTARO | set by telemetry zone resolution |
| `utilization` | `Float?` | yes | no | `0` | registry | EMA, α=0.05, updated per telemetry frame |
| `status` | `RobotStatus` | **no** | yes | `IDLE` | everything | enum, see 6.2 |
| `battery` | `Float?` | **YES** | no | — | telemetry, dashboard | **percent 0–100** (`telemetry.handler.js:228` divides by 100 to get SoC) |
| `massKg` | `Float?` | yes | no | — | §14.2 energy | commissioning-entered |
| `batteryReservePct` | `Float?` | yes | no | — | hardware floor | commissioning-entered |
| `simulated` | `Boolean` | no | yes | `false` | `simulationPolicy` | **must stay `false` for the Pi** |
| `simulationOwnerId` | `String?` | yes | no | — | simulator auth | `null` for physical units |
| `isOnline` | `Boolean` | no | yes | `false` | dashboard, sweep | set `true` at AUTH and per telemetry flush |
| `socketId` | `String?` | **yes** | no | — | disconnect arbitration | current socket id; nulled on offline |
| `lastSeenAt` | `DateTime?` | **yes** | no | — | offline sweep | throttled to ≥15 s writes |
| `lat` | `Float?` | **YES** | no | — | map, engine | last known latitude |
| `lon` | `Float?` | **YES** | no | — | map, engine | last known longitude |
| `speed` | `Float?` | **YES** | no | — | dashboard | last reported speed |
| `currentTaskId` | `String? @unique` | yes | no | — | assignment | 1:1 with `Task` |
| `createdAt` | `DateTime` | no | yes | `now()` | — | — |

**Direct answer to the nullability question:** `battery`, `lat`, `lon`, `speed`, `heading` (absent entirely), `lastSeenAt` and `socketId` are **all nullable**. The Pi may omit any of them from telemetry and the backend will carry the previous value forward (`telemetry.handler.js:640-679` falls back Redis → DB → `null`). **`robotId` and `locationId` are the only non-nullable operational requirements.**

### 6.2 Status vocabulary — `FOUND IN CODE`, `telemetry.handler.js:241-243`

```js
ROBOT_STATUS    = { IDLE, ACTIVE, PAUSED, OFFLINE, ERROR, ISSUES }          // Prisma enum
INCOMING_STATUS = { ...ROBOT_STATUS, RETURNING, CHARGING }                  // accepted from robots
```
Mapping applied before the DB write (`mapIncomingStatusToDb`, `:283-290`):
- `RETURNING` → stored as `ACTIVE`
- `CHARGING` → stored as `PAUSED`
- The **raw** value is preserved in Redis and broadcast to the dashboard.

A status outside `INCOMING_STATUS` is **dropped silently** (`statusRaw` becomes `null`, `:250`).

**Transition table** (`:245-253`) — a transition not in the source status's set is logged and ignored:

| From | Permitted to |
|---|---|
| `IDLE` | ACTIVE, PAUSED, ERROR, ISSUES, OFFLINE, CHARGING |
| `ACTIVE` | PAUSED, IDLE, ERROR, ISSUES, OFFLINE |
| `PAUSED` | ACTIVE, IDLE, ERROR, ISSUES, OFFLINE, CHARGING |
| `CHARGING` | IDLE, ACTIVE, PAUSED, ERROR, OFFLINE |
| `ISSUES` | ACTIVE, PAUSED, IDLE, ERROR, OFFLINE |
| `ERROR` | IDLE, ACTIVE, OFFLINE, ISSUES |
| `OFFLINE` | IDLE, ACTIVE, ERROR, ISSUES, PAUSED, CHARGING |

> Note `ACTIVE` cannot go directly to `CHARGING`. A Pi reporting `ACTIVE → CHARGING` has that transition **silently rejected**; it must pass through `IDLE` or `PAUSED`.

### 6.3 `model Telemetry` — `FOUND IN SCHEMA:563-578`
```
id, robotId (FK→Robot.id, Cascade), lat Float?, lon Float?, speed Float?, battery Float?, createdAt
```
`heading`, `timestamp`, `sequence` and `distanceTravelled` are **not persisted here**. `FOUND IN SCHEMA`.

### 6.4 `model Command` — `FOUND IN SCHEMA:606-624`
```
id uuid, robotId (FK→Robot.id), type CommandType, status CommandStatus @default(SENT), issuedAt, executedAt DateTime?
enum CommandType   { STOP, PAUSE, RETURN, RESUME }
enum CommandStatus { SENT, ACK, FAILED }
```

### 6.5 Fields the backend does **not** model

| Concept | Status |
|---|---|
| `heading` | Accepted on the wire, held in Redis live state, broadcast to the dashboard. **No column anywhere.** `FOUND IN CODE` `:678`; `NOT FOUND IN SCHEMA` |
| Connection status | `Robot.isOnline` + `socketId` (DB) and `connected`/`lastHeartbeat` (Redis registry) |
| Health | `Robot.status = ERROR` (DB) + `healthStatus` in the Redis registry only. **No `healthStatus` column.** |
| Warnings | `NOT FOUND IN REPOSITORY` as a robot-reportable concept. The `Event` table has `EventType { INFO, WARNING, CRITICAL }` but only the server writes it. |
| Safety state / E-stop | `ESTOP_CLEAR` exists as an engine command name (`fencing.js:75`) with no handler and no column. **No safety-state field the Pi can report.** |
| **MotionIntent** | **NOT FOUND IN REPOSITORY.** Exhaustive grep over `src/`, `prisma/`, `docs/` returns zero hits for `MotionIntent`, `motionIntent`, `motion_intent`. The backend has no concept of it. |

---

## 7. Telemetry contract

### 7.1 Flow, traced end to end

```
Pi emits "TELEMETRY"
  → telemetry.handler.js:958 → handleTelemetry (:402)
  → :404  backpressure drop            (bufferedAmount > SOCKET_BUFFER_LIMIT_BYTES)
  → :406  rate limit                   (50/5s, ≥100ms apart)
  → :409  zod safeParse                (failure ⇒ SILENT DROP)
  → :416  auth gate                    (⇒ emit AUTH_REQUIRED, drop)
  → :449  capability-claim scan        (⇒ drop whole frame, count toward quarantine)
  → :481  robotStateCache lookup       (miss ⇒ one DB read; row gone ⇒ robot_unregistered)
  → :516  §23.5 trust boundaries       (position kinematics, energy monotonicity)
  → :543  status transition validation + §23.5 asymmetric health rule
  → :612  Redis pipelined READ  (robot:*, snapshotState:*, registry:*, vr:batteryPersistAt:*)
  → :640  fullState assembly with 3-level fallback (frame → Redis → DB → null)
  → :698  Redis SET robot:{id}        ex 15s          [queued]
  → :742  Postgres Robot UPDATE        [gated — see 7.4]
  → :761  Telemetry history row        [gated — see 7.5]
  → :820  Observation (position)       [gated — see 7.6]
  → :832  zone resolution + registry merge            [queued]
  → :910  Redis pipeline EXEC
  → :936  io.to("dashboard").emit("robot:update", fullState)
  → :951  progress supervision feed (inert, engine off)
```

### 7.2 Required frequency

**No minimum is enforced by the telemetry handler itself.** The constraint comes from liveness:

| Parameter | Value | Source |
|---|---|---|
| `legacy.liveness.db_flush_interval_ms` | **15 000 ms** | `config/register/legacy.json:73` |
| `legacy.liveness.offline_cutoff_ms` | **30 000 ms** | `:104` |
| `legacy.liveness.offline_sweep_interval_ms` | **10 000 ms** | `:134` |
| `legacy.liveness.offline_sweep_batch` | **500** | `:164` |

A robot whose `lastSeenAt` is older than **30 s** *and* whose Redis `lastHeartbeat` is older than 30 s is marked `OFFLINE` by the sweep (`socket.server.js:85-143`).

**Reference cadence:** `VirtualRobot` ticks every **2 000 ms**, emitting `HEARTBEAT` then `TELEMETRY` on the same tick. `FOUND IN CODE` — `simulation/constants.js:4`, `VirtualRobot.js:2503,2506`.
**Upper bound:** 10 Hz (rate limiter).
**Recommended for the Pi:** 1 Hz–0.5 Hz, matching the simulator. `INFERRED`.

### 7.3 Timestamp format — load-bearing

`timestamp` is **epoch milliseconds measured by the agent**, extracted by `agentTimestampFrom` (`positionObservation.service.js:172-180`): a `number` or a numeric `string`, and it must be `> 0`.

**The server never substitutes its own receipt time.** `positionObservation.service.js:26-35` states the rule and the code enforces it: a frame with no `timestamp` produces **no `Observation` at all**, and therefore:
- no `AgentCellPosition` row,
- no presence in the availability index,
- **the robot is never a candidate for assignment.**

`sequence` is an optional per-robot monotonic integer used for replay detection and ordering within a millisecond.

> **This is the single most consequential optional field.** Omitting `timestamp` degrades the Pi from "a fleet participant" to "a dot on a map", silently. The only signal is a per-robot log line reading `NO_AGENT_TIMESTAMP` (`telemetry.handler.js` `lastPositionOutcome`, logged on change, not per frame).

### 7.4 Postgres write gate — `telemetry.handler.js:727-740`

`Robot` is updated only when **any** of:
- `status` actually transitions, **or**
- `isOnline` was `false` (reconnect), **or**
- `|battery - existing.battery| >= 2` percentage points, **or**
- 15 s elapsed since the last flush for this robot.

Movement alone does **not** force a flush — position liveness rides on Redis every tick.

### 7.5 History write gate — `computeSnapshotDecision`, `:307-347`

A `Telemetry` row is written when: no previous snapshot, **or** ≥ 15 s elapsed, **or** moved > `10/111320` degrees (≈10 m), **or** battery changed ≥ 2 points.

### 7.6 Observation write gate — `:820-830`

Rides the **same** `shouldSnapshot` throttle, and additionally requires `!trustVerdict.refused` and a present `timestamp`. Uses the **reported** `lat`/`lon`, never the `fullState` fallbacks — pairing a carried-forward position with this frame's timestamp would manufacture a measurement that was never taken. `provenance` is `"PHYSICAL"` for a Pi (derived from `Robot.simulated = false`).

### 7.7 Handling of missing fields

`fullState` (`:640-679`) resolves each field: **frame value → previous Redis value → DB row value → `null`** (`speed` falls back to `0`, `status` to `"IDLE"`). So a partial frame is merged, not rejected.

`distanceTravelled` (`:686-703`) has two modes:
- If the robot **sends** `distanceTravelled`, it is trusted verbatim.
- If not, the server accumulates haversine distance from the previous position, **ignoring any single delta ≥ 500 m** as a GPS jump.

### 7.8 Handling of stale telemetry

There is **no staleness rejection on ingestion.** An old frame is processed normally. Staleness is handled downstream: `Observation.observedAt` carries the agent's own time, and the §23.5 kinematic check (`assessAgentReport`, `:162-240`) compares the reported position against the last **accepted** fix using the agent's `maxSpeedMps` ceiling. Where the projected `Agent` has no `MobilityModel`, the verdict is `INDETERMINATE` and the frame is **not** refused.

Critically: **the trust boundary is not enforced while the engine is off.** `enforced: engineEnabled(socket, config)` (`:229`) — with `ENGINE_ENABLED=false` every verdict is computed and logged only.

---

## 8. Command contract

### 8.1 Full trace: operator STOP → Pi → dashboard

```
Dashboard action        operator clicks STOP on a robot card
  ↓ frontend request    POST /api/robots/{robotId}/command   body { type: "STOP" }
                        (credentials: include — HttpOnly `token` cookie)
  ↓ middleware          routes/robots.routes.js:10  authUser
                        routes/robots.routes.js:47  commandLimiter (60/60s)
  ↓ backend handler     robots.controller.js  sendRobotCommand
                        :710  validate type ∈ {STOP,PAUSE,RETURN,RESUME}  → 400
                        :717  prisma.robot.findUnique                     → 404
                        :725  prisma.command.create { robotId, type }      status=SENT
  ↓ dispatch            commandDispatcher.dispatchCommand(io, robotCode, {commandId, type})
                        :90   io.in("robot:{id}").fetchSockets()   (adapter-aware)
                        :105  io.to("robot:{id}").emit("COMMAND", {...})
                              retries: 0
  ↓ Socket.IO event     "COMMAND"
  ↓ robot payload       { commandId, type: "STOP", timestamp }
  ↓ HTTP response       { ok: true, command, delivered: <bool> }   ← returns immediately
  ↓ reliability         :752 scheduleReliabilityCheck — every 5 s, up to 2 re-dispatches,
                              then Command.status = FAILED
  ↓ ACK                 robot emits "COMMAND_ACK" { commandId }
  ↓ backend handler     command.handler.js:82
                        :114  find Command row (unknown id ⇒ silent ignore)
                        :120  UPDATE status="ACK", executedAt=now
                        :128  responseTimeMs = now - issuedAt
                        :132  Redis SET cmd:rt:{commandId} ex 86400
                        :139  Event row: type INFO, "COMMAND_ACK {id} responseTimeMs=..."
                        :151  Redis DEL cmdretry:{commandId}
  ↓ database update     Command.status SENT → ACK
  ↓ dashboard update    io.to("dashboard").emit("COMMAND_STATUS", {commandId,"ACK",responseTimeMs})
                        ⚠ the dashboard does NOT subscribe to COMMAND_STATUS
```

### 8.2 Commands that actually exist

| Command | Wire event | Payload | ACK required | Producer | Status |
|---|---|---|---|---|---|
| **STOP** | `COMMAND` | `{commandId, type:"STOP", timestamp}` | **yes** | `robots.controller.js:779` | **LIVE** |
| **PAUSE** | `COMMAND` | `{commandId, type:"PAUSE", timestamp}` | **yes** | same | **LIVE** |
| **RETURN** | `COMMAND` | `{commandId, type:"RETURN", timestamp}` | **yes** | same | **LIVE** |
| **RESUME** | `COMMAND` | `{commandId, type:"RESUME", timestamp}` | **yes** | same | **LIVE** |
| Task-cancel stop | `STOP` | `{taskId, reason:"TASK_CANCELLED", timestamp}` | **no** | `tasks.controller.js:278` | **LIVE** |
| Task assignment | `TASK_ASSIGN` | `{taskId, pickup, drop, pathToPickup, pathToDrop, timestamp}` | no | `server.js:1261` only | **restart recovery only** |
| Reroute | `REROUTE_ALERT` | `{obstacleId, lat, lon, zoneId?, severity?, newPath?, timestamp}` | no | `task.service.js:1078` | **LIVE** |
| Session rekey | `SESSION_REKEY` | binding payload | `SESSION_REKEY_ACK` | `robot.handler.js:860` | mTLS only — **off** |
| **MOVE** | — | — | — | — | **NOT FOUND IN REPOSITORY** |
| **MISSION** | — | — | — | — | **NOT FOUND IN REPOSITORY** |
| `RETURN_TO_BASE` | listened for by `VirtualRobot.js:950` | — | — | **NO PRODUCER** | dead event |
| 18 engine commands | event name == command name | signed envelope | `COMMAND_ACK {outboxId, fence, authorityEpoch}` | `deliverOutboxCommand` | **unreachable — engine off** |

> `MOVE` and `MISSION` do **not** exist. They are not in the code, the schema, or the dispatcher. Do not implement them.

### 8.3 Idempotency requirement on the robot

The reference client keeps an applied-command table keyed by `commandId` and, on redelivery, **re-acknowledges without re-applying** (`VirtualRobot.js:1599-1613`). Because the server re-dispatches at 5 s intervals, **the Pi must be idempotent on `commandId` or a delayed ACK will cause the same STOP to be applied up to three times.**

An unknown `type` is deliberately **not** acknowledged and **not** recorded as applied (`:1627-1632`).

---

## 9. ACK / error contract

### 9.1 Acknowledgement matrix

| Robot event | Server ACK event | ACK payload |
|---|---|---|
| `AUTH` | `AUTH_SUCCESS` + `AUTH_OK` | `{robotId, token, dedup, session}` |
| `TELEMETRY` | *(none)* | — |
| `HEARTBEAT` | *(none)* | — |
| `COMMAND_ACK` | *(none to robot)* | — |
| `TASK_COMPLETE` | `TASK_COMPLETE_ACK` | `{taskId, timestamp}` or `{taskId, verifying:true, timestamp}` |
| `OBSTACLE_REPORT` | `OBSTACLE_REPORT_ACK` | `{obstacleId, affectedRobots, timestamp}` |
| `ROBOT_FAULT` | `ROBOT_FAULT_ACK` | `{timestamp}` |
| `SESSION_REKEY_ACK` | *(none)* | — |

| Server event | Robot ACK required | ACK payload |
|---|---|---|
| `COMMAND` | **YES** | `COMMAND_ACK { commandId }` |
| `STOP` | no | — |
| `TASK_ASSIGN` | no | — |
| `REROUTE_ALERT` | no | — |
| `SESSION_REKEY` | yes (mTLS only) | `SESSION_REKEY_ACK { sessionId? }` |

### 9.2 Error surface — the honest picture

| Failure | What the robot observes |
|---|---|
| Bad/missing `robotId` | **silent disconnect** |
| Robot not in DB | **silent disconnect** |
| Wrong pairing code | **silent disconnect** |
| Pairing locked out | **silent disconnect** |
| Exception in AUTH | **silent disconnect** |
| Misclassified as dashboard | `UNAUTHORIZED` then disconnect |
| Telemetry before AUTH | `AUTH_REQUIRED` |
| Telemetry schema failure | **silent drop** |
| Telemetry rate-limited | **silent drop** |
| Telemetry backpressure | **silent drop** |
| Invalid status value | **silent drop of the status field only** |
| Disallowed status transition | server-side log only |
| Capability claim present | **silent whole-frame drop** + `SECURITY_EVENT` to dashboard |
| Invalid `OBSTACLE_REPORT` | `ERROR { event, reason, details }` ← the only structured error |
| Unknown `commandId` in ACK | **silent ignore** |

**There is exactly one structured robot-facing error event (`ERROR`), and it serves exactly one handler.**

### 9.3 Disconnect and reconnect

**Server-side disconnect handling** — `robot.handler.js:898-940`:
1. Resolve `robotId` from `socket.data` or `socket:{socket.id}`.
2. `DEL socket:{socket.id}`.
3. **If `Robot.socketId` in the DB names a different socket, return** — a newer connection already replaced this one.
4. If `robotSockets.get(robotId)` is a different socket, return.
5. `markRobotOffline` → `isOnline=false, status="OFFLINE", socketId=null`.
6. `markOffline(kv, robotId)`, `SREM robots:all`.
7. `io.to("dashboard").emit("robot_offline", { robotId })`.

**Reconnection semantics** — `robot.handler.js:525-529`:
- On re-`AUTH`, the previous socket for the same `robotId` is fetched, the new one registered, the DB updated, and **only then** is the previous socket disconnected (`:571-574`). The ordering is deliberate so the old socket's disconnect handler hits the step-3 guard and does not mark the robot offline.
- Reconnect is therefore **safe and expected**. The Pi does not need to coordinate.

**Backstop offline sweep** — `socket.server.js:80-144`: runs every 10 s, finds `isOnline=true AND lastSeenAt < now-30s`, batch 500. Before marking offline it consults the Redis registry's `lastHeartbeat`; a robot alive in Redis but stale in Postgres has its `lastSeenAt` repaired instead. This sweep **stands down** when `cutoverEnabled.processEnabled()` is true (the reconciler owns it then).

**`ERROR` status is a one-way door from the robot's side.** Once `ROBOT_FAULT` sets `status = ERROR`, §23.5's asymmetric health rule (`telemetry.handler.js:571-596`) means an agent may declare itself *unfit* but never *fit*. Recovery is the operator action `POST /api/robots/:robotId/clear-fault`, gated as `QUARANTINE_OVERRIDE`. (Currently the rule is computed-and-logged only, because `engineEnabled()` is false — so today a self-reported recovery **does** apply. That will change at cutover.)

---

## 10. Simulator analysis

`Backend/src/simulation/VirtualRobot.js` — 2 998 lines, the de-facto reference implementation.

### 10.1 Its connection

`VirtualRobot.connect()`, `:797-812`:
```js
this.socket = ioClient(serverUrl, {
  reconnection:         true,
  reconnectionDelay:    RECONNECT_DELAY_MS,
  reconnectionDelayMax: 10_000,
  reconnectionAttempts: Infinity,
  transports:           ["websocket"],
});
```
`serverUrl` is `http://127.0.0.1:${port}` — the simulator runs **in-process** with the server (`server.js:1138`).

### 10.2 Its handshake

`_authWithDedupReport()`, `:884-890`:
```js
this.socket.emit("AUTH", {
  robotId: this.robotId,
  token:   this.sessionToken,
  dedupState: this.dedupReport(),
});
```

**It never sends `pairingCode`.** It does not need one, because `commission(kv)` (`:728-745`) writes the credential directly:
```js
this.sessionToken = crypto.randomUUID();
await kv.set(`session:${this.robotId}`, this.sessionToken, { ex: SESSION_TTL_SEC });
```
This path is guarded by `simulationPolicy.isSimulatedRobot(this)` and **throws `ROBOT_NOT_SIMULATED`** for a physical robot — precisely so the simulator cannot overwrite a real unit's credentials.

### 10.3 Its timing and state

| Behaviour | Value | Source |
|---|---|---|
| Tick | 2 000 ms | `constants.js:4` |
| Per tick | `HEARTBEAT` then `TELEMETRY` | `:2503,2506` |
| Reconnect | infinite attempts, delay → 10 s max | `:806-809` |
| Battery drain | 0.0444 %/tick ACTIVE, 0.0089 %/tick IDLE | `constants.js:21-22` |
| Obstacle report | probability 0.002 per ACTIVE tick | `constants.js:120` |
| Statuses used | IDLE, ACTIVE, PAUSED, CHARGING, RETURNING, ERROR | `FOUND IN CODE` |

### 10.4 Its telemetry frame — the canonical shape

`_emitTelemetry(nowMs)`, `:2982-2993`:
```js
{
  robotId:           this.robotId,
  lat:               this.lat,
  lon:               this.lon,
  battery:           Math.round(this.battery * 10) / 10,   // 1 decimal, percent
  speed:             Math.round(this.speed * 100) / 100,   // 2 decimals
  status:            this.status,
  distanceTravelled: Math.round(this.distanceTravelled),   // integer metres
  heading:           this._heading !== null ? Math.round(this._heading) : null,
  timestamp:         at,                                   // epoch ms, the tick instant
  sequence:          this._telemetrySequence,              // monotonic, per robot
}
```

### 10.5 SIMULATOR CONTRACT vs BACKEND CONTRACT — inconsistencies found

| # | Inconsistency | Detail | Severity for the Pi |
|---|---|---|---|
| 1 | **Credential acquisition** | Simulator writes `session:{robotId}` into Redis directly; the backend's only *client-facing* path is the pairing code. The simulator therefore never exercises the pairing branch. | **HIGH** — the Pi's bootstrap path has no reference implementation and no simulator coverage. |
| 2 | `RETURN_TO_BASE` | The simulator listens (`:950`); no server code emits it. | LOW — dead listener. Do not implement. |
| 3 | `AUTH_OK` double-processing | The server emits `AUTH_SUCCESS` **and** `AUTH_OK` for one handshake. The simulator needs an explicit `_handlerSocket !== this.socket` guard (`:849`) to avoid processing twice. | **MEDIUM** — the Pi must handle one, not both. |
| 4 | `robotId` in TELEMETRY | The simulator sends it; the server **ignores** it (`telemetry.handler.js:414` takes identity from `socket.data.robotId`). | LOW — harmless, but not a routing mechanism. |
| 5 | `distanceTravelled` | Simulator sends it and is trusted verbatim; omitting it makes the server accumulate haversine instead. Two different provenances for one field. | LOW |
| 6 | Reconnect handler duplication | `socket.io-client` reuses one `Socket` across reconnects, so `connect` fires again on the same emitter. The simulator's listener registration is keyed to the socket instance (`:918-920`) after a real shipped bug that double-applied every command. | **HIGH** — the Pi will hit this identically if it registers handlers inside `connect`. |
| 7 | Transport | Simulator pins `["websocket"]`; the server accepts both. | NONE |
| 8 | Loopback only | The simulator connects to `127.0.0.1`, so nothing in the repository exercises a **remote** robot connection, CORS behaviour from another host, or a network partition. | **MEDIUM** — the Pi is the first such client. |

---

## 11. Dashboard live-update flow

### 11.1 Initial load

`GET /api/robots/state` → `robots.controller.js:242-299`:
1. `prisma.robot.findMany` with `campus`, `location`, `currentTask`, and the specification include, ordered `isOnline desc, lastSeenAt desc`.
2. `kv.mget` over `robot:{robotId}` for every row.
3. Overlays `lat`, `lon`, `speed`, `battery`, `status` from Redis where present; keeps the DB `lastSeenAt`.
4. Returns `{ ok: true, robots: [...] }`, passed through `robotProjection` so internal fields (notably `simulationOwnerId` and the owner's `User.id`) never reach the wire.

### 11.2 Live path

```
Pi TELEMETRY → telemetry.handler.js:936 → io.to("dashboard").emit("robot:update", fullState)
             → Frontend/src/lib/socket.js DASHBOARD_EVENTS.ROBOT_UPDATE
             → AppProvider.jsx:728 onRobotUpdate (:490)
```
`onRobotUpdate` (`AppProvider.jsx:490-509`) merges `lat, lon, battery, speed, status, isOnline, distanceTravelled, heading` into the existing robot entry — **each guarded by a `typeof` check, so `null` values are ignored, not applied.**

### 11.3 A consequence worth stating

`onRobotUpdate` uses `prev.map(...)` and matches on `robotId`. **A robot not already in the list is not added.** A newly commissioned Pi therefore does not appear until the dashboard re-fetches `GET /api/robots/state`. `FOUND IN CODE` — `AppProvider.jsx:493-508`.

Related: the dashboard does **not** subscribe to `robot_online`, `robot_offline`, `robot_unregistered`, or `COMMAND_STATUS` — none appear in `DASHBOARD_EVENTS` (`Frontend/src/lib/socket.js:55-81`). Online/offline is conveyed solely through the `isOnline` field inside `robot:update`, which is always hard-coded `true` (`telemetry.handler.js:676`). **So the dashboard learns a robot went offline only on a page refresh or another read of `/api/robots/state`.**

---

## 12. Pi compatibility matrix

The Pi's stated architecture is: RobotAgent, perception, GPS/localization, navigation, MotionIntent, telemetry, Socket.IO integration, protocol abstraction. Per instruction, the Pi implementation is **not** assumed correct; where its behaviour is not visible in this repository the cell says so.

| Capability | Backend expects | Pi currently sends/receives | Compatible? | Required change |
|---|---|---|---|---|
| **Connection** | Socket.IO 4.x, namespace `/`, path `/socket.io/`, polling or websocket, no auth in handshake | Socket.IO client present; version/namespace/path NOT VISIBLE IN THIS REPOSITORY | **UNKNOWN** | Pin Socket.IO protocol v4 client. Connect to `http://<host>:3000` with **no** namespace and **no** custom path. |
| **Connection headers** | **No** `Origin`; **no** `User-Agent` containing `Mozilla` | NOT VISIBLE | **RISK** | Ensure the client library sends neither. Node `socket.io-client` and `python-socketio` are safe by default (`MEASURED` for Node). |
| **Authentication** | `AUTH` event after `connect`: `{robotId, pairingCode}` first time, `{robotId, token}` thereafter | NOT VISIBLE | **UNKNOWN** | Implement the AUTH event. **Persist `AUTH_SUCCESS.token` to non-volatile storage.** |
| **Robot identity** | `Robot.robotId` (string, unique); must pre-exist in Postgres | Pi presumably has a configured id | **PARTIAL** | Commission the Pi's id via `POST /api/robots/commission` before first connect. |
| **Registration** | No separate registration event. AUTH *is* registration: it joins `robot:{robotId}`, sets `isOnline`, adds to `robots:all`. | NOT VISIBLE | **N/A** | Do not implement a separate register event; none exists. |
| **Telemetry** | `TELEMETRY` with `lat, lon, speed, battery, status, timestamp, sequence` (+ optional `heading`, `distanceTravelled`) at ≤10 Hz | Pi generates telemetry; field names/units NOT VISIBLE | **LIKELY MISMATCH** | Match field names exactly. `battery` **percent 0–100**, not 0–1. `timestamp` **epoch ms, agent-measured** — omitting it removes the robot from the assignment index. |
| **Commands** | `COMMAND {commandId, type}` with `type ∈ {STOP,PAUSE,RETURN,RESUME}`; separate `STOP` event; `TASK_ASSIGN`; `REROUTE_ALERT` | Pi has protocol abstraction; event names NOT VISIBLE | **UNKNOWN** | Subscribe to all four. Handle `COMMAND type:"STOP"` and the bare `STOP` event as **two different things**. |
| **ACK** | `COMMAND_ACK {commandId}` within ~5 s, **idempotent on `commandId`** | NOT VISIBLE | **UNKNOWN** | Implement + keep an applied-command table. Without it, every operator command is re-sent 3× then marked FAILED. |
| **Heartbeat** | `HEARTBEAT` with **no payload**, ≤10 per 5 s | NOT VISIBLE | **UNKNOWN** | Emit every ~2 s alongside telemetry. Any payload is discarded. |
| **Disconnect** | Server marks OFFLINE within ~30 s worst case; immediate on clean close | N/A | **COMPATIBLE** | None. |
| **Reconnect** | Re-emit `AUTH` on every `connect`; old socket is displaced safely | NOT VISIBLE | **RISK** | Register event handlers **once per socket instance**, not per `connect` — see simulator inconsistency #6. |
| **Status** | `IDLE, ACTIVE, PAUSED, OFFLINE, ERROR, ISSUES, RETURNING, CHARGING`; transition table enforced | NOT VISIBLE | **LIKELY MISMATCH** | Map the Pi's internal state machine onto exactly these eight strings. `ACTIVE → CHARGING` is rejected; route via `IDLE`/`PAUSED`. |
| **Battery** | `Float?` **percent 0–100** | NOT VISIBLE | **RISK** | Send percent. A 0–1 SoC will read as "1 %" and trip energy checks. |
| **GPS** | `lat`/`lon` as decimal degrees, `Float?`, nullable | Pi has GPS/localization | **LIKELY COMPATIBLE** | Send WGS-84 decimal degrees. Deltas ≥ 500 m are discarded from `distanceTravelled`. |
| **Heading** | Accepted, cached in Redis, broadcast to the dashboard, **persisted nowhere** | Pi has localization | **COMPATIBLE** | Send degrees (simulator rounds to integer). Accept that it is not stored. |
| **Speed** | `Float?`, no unit asserted in code; simulator treats it as m/s | NOT VISIBLE | **RISK** | Use **m/s** to match `MobilityModel.maxSpeedMps`, which is the ceiling the kinematic check reads. |
| **Mission/Task** | `TASK_ASSIGN` in; `TASK_COMPLETE` out. **No live assignment producer exists.** | Pi has navigation | **BLOCKED** | None possible from the Pi side. Gated on the engine cutover. |
| **Safety state** | **No field, no event, no column.** `ESTOP_CLEAR` is an engine command name with no handler. | Pi/ESP32 will own safety | **NOT SUPPORTED** | Nearest available surface is `ROBOT_FAULT {code, message, sensor, blocking}`, which forces `status = ERROR`. |
| **MotionIntent** | **NOT FOUND IN REPOSITORY** | Pi generates MotionIntent | **NO BACKEND COUNTERPART** | Do not send it. The telemetry schema is `passthrough()`, so an extra field is silently accepted and silently discarded. |

---

## 13. Missing / inconsistent pieces

| # | Finding | Evidence | Impact |
|---|---|---|---|
| M1 | **Silent authentication failure.** Eight branches call `socket.disconnect(true)` with no event, code, or message. | `robot.handler.js:436-694` | Bring-up is trial and error. Highest practical cost to the integration. |
| M2 | **Client type is a header heuristic.** `Origin` present **or** UA contains `Mozilla` ⇒ dashboard ⇒ robot handlers never registered. | `socket.server.js:194-196` | A conforming Socket.IO client can be silently locked out of the robot path. |
| M3 | **No live task-assignment producer.** `dispatchTaskAssign` has exactly one caller: the restart-recovery sweep. Normal assignment is the engine, which is off. | `server.js:1261`; `task.service.js:877-885` | The Pi cannot be assigned work. |
| M4 | **`RETURN_TO_BASE` has no producer.** | grep across `src/`, `server.js` | Dead listener in the reference client. |
| M5 | **`AUTH_SUCCESS` and `AUTH_OK` both fire.** | `robot.handler.js:651,653` | Naive clients process the handshake twice. |
| M6 | **`heading` is accepted but never persisted.** | `telemetry.handler.js:678`; no schema column | Heading is lost on restart. |
| M7 | **No safety-state surface.** No E-stop field, event, or column reachable from a robot. | `NOT FOUND IN SCHEMA`/`IN CODE` | The ESP32 safety layer has nowhere to report to. |
| M8 | **Dashboard ignores `robot_online`/`robot_offline`.** | `Frontend/src/lib/socket.js:55-81` vs `robot.handler.js:655,931` | Offline transitions are invisible until a page refresh. |
| M9 | **Dashboard ignores `COMMAND_STATUS`.** | same | Operators get no ACK feedback in the UI. |
| M10 | **New robots don't appear live.** `onRobotUpdate` only patches existing list entries. | `AppProvider.jsx:493` | A freshly paired Pi needs a dashboard refresh to appear. |
| M11 | **Session tokens expire after 24 h of downtime.** `session:{robotId}` TTL 86 400 s, refreshed only on successful AUTH. | `robot.handler.js:531,567` | A Pi off for a weekend requires operator re-pairing. |
| M12 | **Pairing lockout needs a second approver to clear.** 5 failures ⇒ 1 h lock; `POST /:robotId/pairing/unlock` is a `QUARANTINE_OVERRIDE`. | `robot.handler.js:64-65`; `robots.routes.js:28,45` | A typo-prone bring-up can hard-block the unit for an hour. |
| M13 | **Telemetry `robotId` is decorative.** Sent by the simulator, ignored by the server. | `telemetry.handler.js:414` | Misleading; one socket can only ever be one robot. |
| M14 | **`speed` has no declared unit anywhere in code or schema.** | `INFERRED` from `MobilityModel.maxSpeedMps` | Silent unit mismatch risk. |
| M15 | **The pairing path has no simulator coverage.** The simulator writes Redis directly; nothing exercises the client-facing bootstrap. | `VirtualRobot.js:740-743` | The Pi's first-connect path is the least-tested path in the system. |
| M16 | **No robot-protocol document exists.** No file under `docs/` specifies the wire contract. | `NOT FOUND IN REPOSITORY` | This audit is the first such document. |

---

## 14. Minimum viable integration

Target: **one physical Pi, online on the dashboard, exchanging real-time data.**

### MUST HAVE NOW

| # | Item | Why | Where |
|---|---|---|---|
| 1 | A `Robot` row for the Pi | AUTH disconnects on `findUnique` miss | `POST /api/robots/commission` (admin JWT). Needs `robotId`, `locationId`, and for a *new* row the 7 spec fields (`massKg`, `maxSpeedMps`, `normalSpeedMps`, `batteryCapacityWh`, `batteryReservePct`, `payloadCapacityKg`, `initialBatteryPct`) + `chassisType`. |
| 2 | `simulated = false` | Default. Keeps the simulator from ever minting credentials over the Pi's | `schema.prisma:265` |
| 3 | Socket.IO v4 client, default namespace and path | Anything else 404s or never connects | — |
| 4 | **No `Origin` header, no `Mozilla` UA** | Otherwise `UNAUTHORIZED` + disconnect | `socket.server.js:196` |
| 5 | `AUTH` on every `connect` | The only way to become a robot | `robot.handler.js:431` |
| 6 | **Persist `AUTH_SUCCESS.token`** | Pairing codes are single-use with a 300 s TTL | `robot.handler.js:566` |
| 7 | `HEARTBEAT` every ~2 s | Prevents the 30 s offline sweep | `robot.handler.js:771` |
| 8 | `TELEMETRY` at 0.5–1 Hz with `lat, lon, battery, speed, status` | This is what makes the robot visible | `telemetry.handler.js:958` |
| 9 | `status` from the eight-value vocabulary | Anything else is silently dropped | `telemetry.handler.js:242` |
| 10 | `battery` as **percent 0–100** | Unit mismatch trips energy checks | `telemetry.handler.js:228` |
| 11 | Listen for `COMMAND`, reply `COMMAND_ACK {commandId}` | Otherwise every operator command is retried 3× then FAILED | `command.handler.js:82` |
| 12 | **Idempotency on `commandId`** | The server re-dispatches at 5 s | `VirtualRobot.js:1605` |
| 13 | **Register listeners once per socket instance** | `socket.io-client` reuses the emitter across reconnects | `VirtualRobot.js:918` |
| 14 | Handle bare `STOP` separately from `COMMAND type:"STOP"` | Two distinct events | `commandDispatcher.service.js:155,170` |
| 15 | `timestamp` (epoch ms, agent-measured) in every frame | Without it: no Observation, no index entry, never a candidate | `positionObservation.service.js:26-35` |

### SHOULD HAVE LATER

| Item | Why deferred |
|---|---|
| `sequence` (monotonic per frame) | Improves replay detection/ordering; absence only weakens tie-breaking |
| `heading` | Accepted and shown, but persisted nowhere |
| `distanceTravelled` | Server accumulates haversine if omitted |
| `TASK_ASSIGN` handling + `TASK_COMPLETE` | No live producer exists today |
| `OBSTACLE_REPORT` | DTARO rerouting is not on the critical path |
| `ROBOT_FAULT` | Note it forces `status = ERROR` needing an operator override to clear |
| `AUTH_REQUIRED` → re-AUTH | Defensive; correct AUTH-on-connect makes it rare |
| Token rotation / re-pairing UX | Matters at the 24 h TTL boundary |

### CAN IGNORE FOR NOW

| Item | Why |
|---|---|
| mTLS / certificates / `SESSION_REKEY` | `AGENT_MTLS_REQUIRED=false`; presenting a certificate actively complicates AUTH |
| `dedupState` in AUTH | §11.5; gated on the engine, currently a no-op |
| `OFFER_ACCEPT` / `OFFER_REJECT` / `OFFER_DEFER` | Inert — no producer with the engine off |
| All 18 §10.3.1 engine commands | Unreachable |
| `RETURN_TO_BASE` | No producer anywhere |
| `MotionIntent` | No backend counterpart |
| `MOVE`, `MISSION` commands | Do not exist |
| Shard identity / `agentGate` | Resolves to "refused" and is harmless |

---

## 15. PI INTEGRATION CONTRACT

> Every value below is traced to source. Nothing is guessed. `NOT FOUND IN REPOSITORY` means exactly that.

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  BACKEND URL                                                                 ║
╚══════════════════════════════════════════════════════════════════════════════╝
  http://<backend-host>:3000
    port      process.env.PORT, default 3000        server.js:518
    bind      process.env.HOST, default 0.0.0.0     server.js:519
    scheme    http (TLS is terminated upstream if at all)

╔══════════════════════════════════════════════════════════════════════════════╗
║  NAMESPACE / PATH / TRANSPORT                                                ║
╚══════════════════════════════════════════════════════════════════════════════╝
  Namespace   "/"            (default — io.of() appears nowhere in the repo)
  Path        "/socket.io/"  (default — no `path` option is passed)
  Transports  ["websocket"] recommended (what the reference client uses);
              polling also accepted
  Protocol    Socket.IO v4 / Engine.IO v4   (socket.io 4.8.3, engine.io 6.6.6)

  HEADERS — MUST NOT SEND:
    Origin        : any value  ⇒ classified as dashboard ⇒ UNAUTHORIZED + disconnect
    User-Agent    : any value containing "Mozilla"  ⇒ same
  HEADERS — REQUIRED: none.

╔══════════════════════════════════════════════════════════════════════════════╗
║  CONNECTION AUTHENTICATION                                                   ║
╚══════════════════════════════════════════════════════════════════════════════╝
  handshake.auth    : {}   — nothing required for a robot
  handshake.query   : none required
  cookies           : none required

  Authentication is IN-BAND: emit "AUTH" immediately after "connect".

╔══════════════════════════════════════════════════════════════════════════════╗
║  REGISTRATION                                                                ║
╚══════════════════════════════════════════════════════════════════════════════╝
  There is NO separate registration event. AUTH is registration.
  On success the server:
    • joins the socket to room  robot:{robotId}
    • sets Robot.isOnline = true, Robot.socketId = <socket.id>
    • adds robotId to the Redis set  robots:all
    • emits robot_online to the dashboard room

  PRECONDITION — a Robot row must already exist:
    POST /api/robots/commission          (requires admin JWT cookie `token`)
    body: { robotId, locationId, campusId?, lat?, lon?,
            massKg, maxSpeedMps, normalSpeedMps, batteryCapacityWh,
            batteryReservePct, payloadCapacityKg, initialBatteryPct, chassisType }
       (the seven specification values + chassisType are required only when the
        robotId does not already exist)
    response: { ok: true, robot: {...}, pairingCode: "418203", expiresIn: 300 }

╔══════════════════════════════════════════════════════════════════════════════╗
║  AUTH EVENT                                                                  ║
╚══════════════════════════════════════════════════════════════════════════════╝
  emit("AUTH", payload)                                    robot.handler.js:431

  FIRST CONNECTION (pairing bootstrap):
    { "robotId": "<string>", "pairingCode": "<6 digits>" }

  ALL SUBSEQUENT CONNECTIONS:
    { "robotId": "<string>", "token": "<uuid from AUTH_SUCCESS>" }

  REQUIRED : robotId  +  exactly one of { pairingCode | token }
  OPTIONAL : dedupState (engine, inert), certificate (mTLS, off)
  FORBIDDEN: any capability claim — the payload is scanned and the claim rejected

  RATE LIMIT: 5 per 60 000 ms, minimum 100 ms apart

  SUCCESS  → "AUTH_SUCCESS"  AND  "AUTH_OK"   (identical payload, BOTH fire)
    { robotId, token, dedup, session:{ mode:"LEGACY", sessionId, fingerprint:null,
                                       keyStorage:null, expiresAt:null } }
    ⇒ PERSIST `token` TO DISK. It is the credential for every later connection.
    ⇒ Handle ONE of the two events, or guard against double-processing.

  FAILURE  → socket.disconnect(true) with NO message, NO reason, NO event.
    Causes: unknown robotId · bad/absent pairing code · pairing locked out ·
            schema failure · internal exception
    After 5 failed pairing attempts the robotId is locked for 3600 s and only
    POST /api/robots/{robotId}/pairing/unlock (elevated role + reason +
    second approver) clears it.

  TOKEN TTL: 86 400 s, refreshed on each successful AUTH.
             Offline > 24 h ⇒ the token is gone; re-pairing is required.

╔══════════════════════════════════════════════════════════════════════════════╗
║  TELEMETRY EVENT                                                             ║
╚══════════════════════════════════════════════════════════════════════════════╝
  emit("TELEMETRY", payload)        alias "telemetry"    telemetry.handler.js:958

  PAYLOAD (all fields schema-optional; see REQUIRED IN PRACTICE below):
    {
      "lat":               12.9716,      // decimal degrees WGS-84   Float|null
      "lon":               77.5946,      // decimal degrees          Float|null
      "speed":             1.25,         // m/s  (INFERRED — no unit asserted in code)
      "battery":           87.4,         // PERCENT 0..100  (NOT 0..1)
      "status":            "ACTIVE",     // one of the 8 values below
      "heading":           270,          // degrees; accepted, NOT persisted
      "distanceTravelled": 1423,         // cumulative metres; omit ⇒ server accumulates
      "timestamp":         1758531234567,// epoch ms, MEASURED BY THE AGENT
      "sequence":          1042          // monotonic per robot, integer ≥ 0
    }
    `robotId` may be sent but is IGNORED — identity comes from the socket.

  REQUIRED IN PRACTICE:
    lat, lon      — or the robot has no position
    battery       — or energy feasibility has no input
    status        — or the robot never leaves its previous state
    timestamp     — WITHOUT IT NO Observation IS WRITTEN, so the robot never
                    enters AgentCellPosition and is never an assignment candidate

  OPTIONAL: speed, heading, distanceTravelled, sequence

  STATUS VOCABULARY (anything else is silently discarded):
    IDLE  ACTIVE  PAUSED  OFFLINE  ERROR  ISSUES  RETURNING  CHARGING
    RETURNING is stored as ACTIVE; CHARGING is stored as PAUSED;
    both keep their raw value in Redis and on the dashboard.
    ACTIVE → CHARGING is NOT a permitted transition; go via IDLE or PAUSED.

  RATE LIMIT : 50 per 5 000 ms, minimum 100 ms apart  ⇒ hard ceiling 10 Hz
  RECOMMENDED: every 2 000 ms (the reference client's cadence)
  ACK        : NONE
  ERRORS     : silent drop (schema, rate limit, backpressure)
               "AUTH_REQUIRED" if the socket is not authenticated

╔══════════════════════════════════════════════════════════════════════════════╗
║  HEARTBEAT                                                                   ║
╚══════════════════════════════════════════════════════════════════════════════╝
  emit("HEARTBEAT")                 alias "heartbeat"      robot.handler.js:771

  PAYLOAD    : NONE — the handler takes no argument; anything sent is discarded
  CADENCE    : every 2 000 ms (reference client)
  RATE LIMIT : 10 per 5 000 ms, minimum 100 ms apart
  ACK        : none
  DEADLINE   : a robot with no heartbeat AND no lastSeenAt write for 30 000 ms
               is marked OFFLINE by the sweep (checked every 10 000 ms)

╔══════════════════════════════════════════════════════════════════════════════╗
║  COMMAND EVENT  (server → Pi)                                                ║
╚══════════════════════════════════════════════════════════════════════════════╝
  on("COMMAND", payload)                              commandDispatcher.js:155

  PAYLOAD:
    { "commandId": "<uuid>",
      "type":      "STOP" | "PAUSE" | "RETURN" | "RESUME",
      "timestamp": 1758531234567 }

  ACK REQUIRED — emit("COMMAND_ACK", { "commandId": "<same uuid>" })
    optional extra keys (sent by the reference client, not read): robotId, timestamp

  RETRY BEHAVIOUR: if no ACK arrives the server re-dispatches at 5 s, 10 s, 15 s,
                   then sets Command.status = FAILED.
  ⇒ THE HANDLER MUST BE IDEMPOTENT ON commandId: on redelivery of an already-applied
    command, RE-ACKNOWLEDGE WITHOUT RE-APPLYING.
  ⇒ An unknown `type` must NOT be acknowledged and must NOT be recorded as applied.

╔══════════════════════════════════════════════════════════════════════════════╗
║  OTHER SERVER → PI EVENTS                                                    ║
╚══════════════════════════════════════════════════════════════════════════════╝
  on("STOP", { taskId?, reason?, timestamp })
      Task cancellation. NO ACK expected. DISTINCT from COMMAND type:"STOP".

  on("TASK_ASSIGN", { taskId, pickup:{lat,lon}, drop:{lat,lon},
                      pathToPickup:[...], pathToDrop:[...], timestamp })
      NO ACK. Report completion later with TASK_COMPLETE.
      Currently only emitted by the post-restart recovery sweep.

  on("REROUTE_ALERT", { obstacleId, lat, lon, zoneId?, severity?, newPath?, timestamp })
      NO ACK.

  on("AUTH_REQUIRED", { robotId })     ⇒ re-send AUTH
  on("UNAUTHORIZED",  { message })     ⇒ you were misclassified as a dashboard client
  on("ERROR", { event, reason, details? })  ⇒ OBSTACLE_REPORT validation only

  NOT IMPLEMENTED BY THE SERVER — do not wait for these:
    RETURN_TO_BASE   (no producer anywhere in the repository)
    MOVE, MISSION    (do not exist)

╔══════════════════════════════════════════════════════════════════════════════╗
║  OPTIONAL PI → SERVER EVENTS                                                 ║
╚══════════════════════════════════════════════════════════════════════════════╝
  emit("TASK_COMPLETE",   { taskId })
      → ACK "TASK_COMPLETE_ACK" { taskId, timestamp }
        or { taskId, verifying:true, timestamp }
      Rate limit 5 per 30 000 ms, ≥1 000 ms apart

  emit("OBSTACLE_REPORT", { lat, lon, severity })
      lat/lon must be JSON NUMBERS — numeric strings are rejected here
      → ACK "OBSTACLE_REPORT_ACK" { obstacleId, affectedRobots, timestamp }
      → or  "ERROR" { event, reason, details }
      Rate limit 10 per 60 000 ms, ≥500 ms apart

  emit("ROBOT_FAULT",     { code?, message?, sensor?, blocking? })
      → ACK "ROBOT_FAULT_ACK" { timestamp }
      ⚠ FORCES Robot.status = ERROR. Clearing it requires the operator endpoint
        POST /api/robots/{robotId}/clear-fault (elevated role + recorded reason).
      blocking:false ⇒ catalogue row A6; anything else ⇒ A5 (blocking)
      Rate limit 5 per 60 000 ms, ≥1 000 ms apart

╔══════════════════════════════════════════════════════════════════════════════╗
║  DISCONNECT / RECONNECT                                                      ║
╚══════════════════════════════════════════════════════════════════════════════╝
  RECONNECT   : enable it. Reference settings —
                  reconnection: true, reconnectionDelay: <base>,
                  reconnectionDelayMax: 10 000, reconnectionAttempts: Infinity
  ON CONNECT  : ALWAYS re-emit AUTH (with the persisted token).
  HANDLERS    : register event listeners ONCE PER SOCKET INSTANCE, not on every
                `connect`. socket.io-client reuses one emitter across reconnects;
                re-registering leaves N copies and applies each command N times.
                (This was a real shipped defect — VirtualRobot.js:897-920.)
  SERVER SIDE : a new AUTH for the same robotId displaces the old socket safely —
                the DB is updated before the old socket is disconnected, so the
                stale disconnect handler does not mark the robot offline.
  OFFLINE     : immediate on clean disconnect; otherwise within ~30 s via the sweep.

╔══════════════════════════════════════════════════════════════════════════════╗
║  ROBOT IDENTITY                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
  Wire identity     : Robot.robotId — a unique string, operator-chosen at commissioning
  Internal id       : Robot.id (uuid) — never on the wire
  Socket binding    : socket.data.robotId, set ONLY by a successful AUTH
  Room              : robot:{robotId}
  Redis namespaces  : session:{robotId}, pairing:{robotId}, robot:{robotId},
                      registry:{robotId}, socket:{socket.id}, robots:all
  NOTE              : telemetry `robotId` is ignored; the socket binding is authoritative.

╔══════════════════════════════════════════════════════════════════════════════╗
║  NOT FOUND IN REPOSITORY                                                     ║
╚══════════════════════════════════════════════════════════════════════════════╝
  MotionIntent (any spelling)      · MOVE command      · MISSION command
  Safety-state field or event      · E-stop reachable from a robot
  heading persistence              · warning-report event
  RETURN_TO_BASE producer          · robot-protocol specification document
```

---

## 16. Recommended next implementation steps

**Phase A — prove the pipe (no backend changes)**

1. Commission a `Robot` row for the Pi via `POST /api/robots/commission`; record the `pairingCode` and its 300 s expiry.
2. On the Pi, connect with `transports: ["websocket"]` and confirm no `Origin`/`Mozilla` UA reaches the server. If `UNAUTHORIZED` arrives, that is finding M2 — fix the client headers, not the backend.
3. Emit `AUTH` with `pairingCode`, capture `AUTH_SUCCESS.token`, write it to non-volatile storage, and verify a restart authenticates with `token` alone.
4. Start a 2 s loop emitting `HEARTBEAT` then `TELEMETRY`. Confirm on the dashboard after one `GET /api/robots/state` refresh (finding M10).
5. Issue `POST /api/robots/{robotId}/command {"type":"PAUSE"}` and confirm the `Command` row reaches `ACK` — this proves the full duplex path.

**Phase B — harden the client**

6. Make the `COMMAND` handler idempotent on `commandId` with a bounded applied-command table.
7. Move listener registration to once-per-socket-instance.
8. Add `timestamp` and `sequence` to every telemetry frame; verify `Observation` rows with `kind = "position"` and `value->>'provenance' = 'PHYSICAL'` appear, and that `AgentCellPosition` populates.
9. Map the Pi's state machine onto the eight-value status vocabulary and honour the transition table.

**Phase C — decisions for the backend owner (not Pi work)**

10. **M1** — add an explicit robot-facing `AUTH_FAILED { reason }` before each disconnect. This is the highest-value change for bring-up and for every future unit.
11. **M2** — replace the header heuristic with an explicit client-role declaration (e.g. `handshake.auth.role`), keeping the heuristic as a fallback.
12. **M3** — decide whether the engine is staged for this deployment, or whether a minimal assignment path is restored. Until then the Pi cannot be given work.
13. **M8/M9/M10** — subscribe the dashboard to `robot_online`, `robot_offline` and `COMMAND_STATUS`, and make `onRobotUpdate` append unknown robots.
14. **M11/M12** — reconsider the 24 h session TTL and the second-approver requirement on pairing unlock for a bring-up/lab deployment.

---

## INTEGRATION BLOCKERS

Only items that genuinely prevent the Pi from connecting and exchanging real-time data. Optional production improvements are excluded.

**B1 — A `Robot` row must exist before the Pi can authenticate at all.**
`robot.handler.js:448-452` disconnects on a `findUnique` miss. Commissioning a **new** `robotId` additionally requires a valid `locationId` **and** all seven specification values (`massKg`, `maxSpeedMps`, `normalSpeedMps`, `batteryCapacityWh`, `batteryReservePct`, `payloadCapacityKg`, `initialBatteryPct`) plus `chassisType` (`robot.service.js:144-152`, `robotSpecification.js:239`). Without a pre-existing row, **no AUTH can ever succeed**.
*Resolution:* run the commissioning call before first connect. No backend change needed.

**B2 — The Pi must obtain a pairing code within a 300-second window, and the simulator provides no reference for this path.**
`pairing:{robotId}` has `ex: 300` (`robots.controller.js:431`). The only reference client bypasses pairing entirely by writing `session:{robotId}` directly to Redis, a path guarded against physical robots (`VirtualRobot.js:728-743`). The Pi's bootstrap is therefore the least-exercised path in the system, and every failure in it is a silent disconnect.
*Resolution:* coordinate commissioning and first connect; retry with a fresh code on failure. **Do not exceed 5 attempts** — that triggers a 1-hour lockout requiring a second-approver override to clear (`robot.handler.js:64-65`, `robots.routes.js:28,45`).

**B3 — Any `Origin` header or `Mozilla` user-agent silently routes the Pi into the dashboard path, where its `AUTH` event has no listener.**
`socket.server.js:194-218`. The robot receives `UNAUTHORIZED` and is disconnected; `registerRobotHandlers` is never called. `MEASURED`: the Node `socket.io-client` is safe on both transports, but any client that sets these headers — including browser-derived or hand-rolled WebSocket clients — cannot connect as a robot.
*Resolution:* verify the Pi's client library sends neither header. This is a client-side constraint, not a backend change.

**B4 — All authentication failures are silent.**
Eight branches in the AUTH handler call `socket.disconnect(true)` with no event and no reason (`robot.handler.js:436,443,452,478,539,551,560,694`). A failing Pi is indistinguishable from a network fault, a wrong id, an expired code, and a lockout.
*Resolution for the Pi team:* instrument against the **server** logs during bring-up (`Robot AUTH success` at `:689`, and the `log.warn` lines at `:473,514,540,552`). This is a diagnostic blocker rather than a functional one — but it will dominate bring-up time if not planned for.

**B5 — No live task-assignment path exists; the Pi cannot be given work.**
`ENGINE_ENABLED=false` (`Backend/.env`) and Phase 15 removed the legacy decision path from the build, so `assignTask` throws `ENGINE_NOT_LIVE` (HTTP 503) before writing anything (`task.service.js:872-885`). `dispatchTaskAssign` has exactly one caller — the post-restart recovery sweep at `server.js:1261` — which only re-sends tasks that are *already* `ASSIGNED`/`IN_PROGRESS` with a cached path.
*Scope note:* this blocks **mission/task delivery only**. Connection, authentication, telemetry, dashboard visibility, and the STOP/PAUSE/RETURN/RESUME command round-trip are all fully functional without it. It is an owner decision (engine cutover), not something the Pi integration can resolve.

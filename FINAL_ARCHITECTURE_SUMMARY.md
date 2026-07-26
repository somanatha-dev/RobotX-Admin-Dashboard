# RobotX — Final Architecture Summary

> Companion to `system.md` (full reference) and `PHASE1_VERIFICATION.md` (finding-by-finding audit). This document is the short-form architectural picture: module relationships, request/data flows, and operational lifecycle, as the repository actually exists today (branch `feature/dashboard`, commit `e020db8` + uncommitted working tree).

---

## 1. Current Architecture Overview

RobotX is a **single-process Node.js monolith**. One `server.js` process hosts an Express REST API, a Socket.IO server, a Prisma/PostgreSQL client, a Redis client (with in-memory fallback), and the entire simulated robot fleet (`VirtualRobot` instances connecting back into the same process as `socket.io-client` peers). There is no worker queue, no message broker, no second service of any kind.

```mermaid
flowchart TB
    subgraph Browser["Browser (React SPA)"]
        Pages[Dashboard / Map / Robots / Tasks / Profile]
        SocketClient[socket.io-client singleton\nwithCredentials: true]
    end

    subgraph Process["Single Node.js Process"]
        direction TB
        Express[Express REST API\nauthUser-gated on every operational route]
        SocketServer[Socket.IO server\ndashboard room JWT-gated]
        Services[Service Layer]
        VRSim[VirtualRobot Simulator\nsocket.io-client peers, in-process]
    end

    Postgres[(PostgreSQL\nsystem of record)]
    Redis[(Redis\nephemeral live-state cache\nin-memory fallback if down)]
    Mapbox[[Mapbox Directions + Matrix + Search Box]]

    Pages -- HTTP/JWT cookie --> Express
    SocketClient -- WebSocket/JWT cookie --> SocketServer
    Express --> Services
    SocketServer --> Services
    Services <--> Postgres
    Services <--> Redis
    Services --> Mapbox
    VRSim <--> SocketServer
```

**Services layer** (`Backend/src/services/`): `taskAssignment`, `costEvaluator`, `robotRegistry`, `robotValidator`, `zoneManager`, `ekb`, `alertDissemination`, `routing`, `commandDispatcher`, `task`, `taskRecovery`, `metrics`, `mapbox`. Both HTTP controllers and Socket.IO handlers call into this same layer — there is one source of truth for business logic regardless of transport.

---

## 2. Module Relationships

```mermaid
flowchart LR
    subgraph Entry
        server[server.js]
    end
    subgraph HTTP
        routes[routes/*.js] --> controllers[controllers/*.js]
    end
    subgraph RT["Real-time"]
        socketserver[sockets/socket.server.js] --> handlers[sockets/handlers/*.js]
    end
    subgraph Core["Service Layer"]
        taskAssignment
        costEvaluator
        robotRegistry
        robotValidator
        commandDispatcher
        taskService[task.service.js]
        taskRecovery
        ekb
        alertDissemination
        routing
    end
    subgraph Shared
        kv[cache/kv.js]
        prismaClient[db/prisma.js]
        dtaroConstants[config/dtaro.constants.js]
        authMiddleware[middlewares/auth_middleware.js]
    end

    server --> HTTP
    server --> RT
    server --> VRSim2[simulation/SimulationEngine.js]
    controllers --> Core
    handlers --> Core
    taskAssignment --> costEvaluator
    taskAssignment --> robotValidator
    taskAssignment --> robotRegistry
    taskService --> taskAssignment
    taskService --> commandDispatcher
    taskRecovery --> taskService
    robotValidator --> dtaroConstants
    VRSim2 --> dtaroConstants
    Core --> kv
    Core --> prismaClient
    controllers --> authMiddleware
    socketserver --> authMiddleware
```

The one new cross-cutting dependency introduced by the latest round of work is `config/dtaro.constants.js` — the first shared-constants module in the codebase, imported by both `robotValidator.service.js` (server-side eligibility) and `simulation/constants.js` (VirtualRobot's own charge-interrupt logic). This is a pattern worth repeating for the codebase's other still-duplicated constants (rate-limit thresholds, TTLs).

---

## 3. Request Flow (REST)

```mermaid
sequenceDiagram
    participant Browser
    participant CORS as cors.js
    participant Auth as authUser middleware
    participant Controller
    participant Service as Service layer
    participant DB as Postgres
    participant Redis

    Browser->>CORS: HTTP request (JWT cookie)
    CORS->>CORS: isOriginAllowed()\n(no-Origin still bypasses — see limitations)
    CORS->>Auth: verifyUserToken(cookie or Bearer)
    Auth->>DB: fetch user by decoded id (UUID-validated)
    Auth-->>Controller: req.user attached, or 401
    Controller->>Service: business logic call
    Service->>DB: read/write (system of record)
    Service->>Redis: read/write (best-effort, ephemeral cache)
    Service-->>Controller: result
    Controller-->>Browser: JSON response
```

Every operational route file (`robots.routes.js`, `tasks.routes.js`, `locations.routes.js`, `campuses.routes.js`, `simulator.routes.js`) applies `authUser` router-wide. `auth.routes.js` gates individual routes so `/login`/`/google`/`/logout` stay public.

---

## 4. Robot Flow (commission → auth → live)

```mermaid
stateDiagram-v2
    [*] --> Commissioned: POST /api/robots/commission\n(creates DB row, seeds pairing code)
    Commissioned --> Pairing: VirtualRobot connects,\nsends AUTH with pairing code
    Pairing --> PairingLocked: 5 failed attempts\n(pairingLocked:{robotId}, 1h)
    PairingLocked --> Pairing: admin unlock endpoint,\nor 1h TTL expiry
    Pairing --> Authenticated: correct code,\nsession token issued (7d)
    Authenticated --> Idle: registry marks online,\nDTARO-eligible
    Idle --> Active: TASK_ASSIGN received
    Active --> Idle: TASK_COMPLETE
    Idle --> Charging: battery low, docks\n(stored as PAUSED in Postgres)
    Charging --> Idle: charge complete
    Authenticated --> Fault: ROBOT_FAULT reported\n(healthStatus=FAULT, DTARO-ineligible)
    Fault --> Idle: POST /api/robots/:id/clear-fault\n(explicit admin action)
    Authenticated --> Offline: disconnect / 10s no-heartbeat sweep
    Offline --> Authenticated: reconnect with session token
```

Every robot — real or `VirtualRobot` — connects over the same Socket.IO protocol. The simulator exercises the identical auth/rate-limit/validation path a physical robot would.

---

## 5. Task Flow (DTARO allocation)

```mermaid
sequenceDiagram
    participant Operator
    participant API as tasks.controller.js
    participant TaskSvc as task.service.js
    participant Alloc as taskAssignment.service.js
    participant Cost as costEvaluator.service.js
    participant KV as Redis (kv.js)
    participant Mapbox
    participant DB as Postgres
    participant Robot as Robot socket

    Operator->>API: POST /api/tasks/assign
    API->>TaskSvc: assignTask()
    TaskSvc->>DB: create Task (PENDING)
    TaskSvc-->>Operator: 200 OK (PENDING) — returns immediately
    Note over TaskSvc: setImmediate() — background phase begins
    loop up to 3 attempts
        TaskSvc->>Alloc: selectNearestRobot(excludeIds)
        Alloc->>DB: query eligible candidates
        Alloc->>KV: getManyRobotStates() — one pipelined MGET
        Alloc->>Mapbox: Matrix API (batched)
        Alloc->>Cost: computeCosts() — D, B, U, T, Z weighted sum
        Cost-->>Alloc: winning robot
        TaskSvc->>KV: reserveRobot(robotId, taskId, 30s) — atomic SET NX
        alt reservation wins
            TaskSvc->>Mapbox: Directions API x2 legs
            TaskSvc->>DB: transaction: assign task, update robot
            TaskSvc->>KV: seed taskPath, robotTaskState; release reservation
            TaskSvc->>Robot: TASK_ASSIGN (2 retries, best-effort)
            TaskSvc->>KV: recordAllocation(real cost/latency)
            TaskSvc->>Operator: emit TASK_ASSIGNED / TASK_UPDATED (dashboard room)
        else reservation lost
            TaskSvc->>TaskSvc: exclude robot, retry
        end
    end
    Note over TaskSvc: task FAILED only after all 3 attempts exhausted
```

**What changed structurally in this pipeline versus a naive greedy allocator**: the reservation-and-retry loop means a task no longer fails outright the instant two requests race for the same robot — it falls through to the next-best eligible candidate first. This closes what was previously the single most consequential correctness gap in the allocation system.

**Task cancellation is the one lifecycle edge that remains a straight Postgres update with no downstream effect** — cancelling a task does not stop the robot or clean up its Redis routing state (see `PHASE1_VERIFICATION.md` §1, Tier 2).

---

## 6. Telemetry Flow

```mermaid
flowchart TD
    Robot[Robot / VirtualRobot] -->|TELEMETRY every 2s| Handler[telemetry.handler.js]
    Handler --> AuthCheck{socket.data.isAuthed?}
    AuthCheck -- no --> Reject[AUTH_REQUIRED, frame dropped]
    AuthCheck -- yes --> Validate[zod parse + status-transition check]
    Validate --> PGRead[Postgres read: current row]
    PGRead --> RedisRead["Redis read: robot:{id}"]
    RedisRead --> Merge[Merge incoming + previous state]
    Merge --> RedisWrite1["Redis write: robot:{id} (15s TTL)"]
    Merge --> PGWrite["Postgres write: EVERY tick, unconditional\n(largest scale risk, unaddressed)"]
    Merge --> Snapshot{Smart snapshot throttle:\n>=15s or >=11m moved or >=2% battery delta?}
    Snapshot -- yes --> TelemetryRow[Insert Telemetry history row]
    Merge --> RegistryWrite["registry:{id} write (30s TTL, merge semantics)\nomits healthStatus — FAULT now survives ticks"]
    Merge --> UtilEMA[updateUtilization EMA, alpha=0.05\nfeeds DTARO cost function live]
    Merge --> ZoneCheck[Zone membership check,\nroom join/leave, ZONE_UPDATED broadcast]
    Merge --> Broadcast["io.emit robot:update\n(all sockets, not just dashboard room)"]
```

Two independent Redis documents (`robot:{robotId}` and `registry:{robotId}`) are still written per tick for overlapping data — this duplication was not resolved in the latest round of changes (see `system.md` §7 and §16).

---

## 7. Authentication Flow

```mermaid
flowchart TD
    subgraph HumanAuth["Human (Operator) Auth"]
        Login[POST /api/auth/login or /google] --> JWT["HttpOnly JWT cookie (7d)"]
        JWT --> REST["authUser gates all operational REST routes"]
        JWT --> SocketGate["verifyUserToken gates Socket.IO dashboard room"]
    end
    subgraph StepUp["Step-Up Authorization (destructive actions)"]
        Action[requestAuth wraps action] --> Modal[AuthChallengeModal]
        Modal --> PIN["PIN path: POST /api/auth/pin-auth\nbcrypt compare, server-verified"]
        Modal --> Passkey["Passkey path: POST /api/auth/webauthn/auth-options\nthen /verify — real @simplewebauthn/server ceremony"]
        Passkey --> Challenge["Server-issued Redis challenge (300s TTL)"]
        Challenge --> Counter["Signature counter must strictly advance\n(replay/clone detection)"]
        Counter --> Authorized[action proceeds only if verified:true]
    end
    subgraph RobotAuth["Robot Auth"]
        Pairing["6-digit pairing code (300s TTL)\nor session token (7d)"] --> AuthEvent["Socket.IO AUTH event"]
        AuthEvent --> Lockout["5 failed attempts -> pairingLocked (1h)\nkeyed by robotId, survives reconnect"]
        AuthEvent --> RobotSession["socket.data.isAuthed = true\nrequired before ANY telemetry is accepted"]
    end
```

Both step-up paths (PIN and Passkey) are now genuinely server-verified — this is the most significant authentication change since the prior review: WebAuthn went from a client-side-only illusion of security to a real, cryptographically-verified ceremony with replay protection.

---

## 8. Deployment Architecture

```mermaid
flowchart LR
    subgraph "What exists today"
        NodeProcess["node server.js\n(single process, manually started)"]
        ViteBuild["Vite build\n(Frontend static assets)"]
    end
    subgraph "External dependencies"
        NeonPG[(PostgreSQL — Neon,\nbased on connect-timeout tuning)]
        RedisInstance[(Redis — optional,\nsystem degrades gracefully without it)]
        MapboxAPI[[Mapbox APIs]]
    end
    subgraph "What does NOT exist"
        Docker[No Dockerfile]
        Compose[No docker-compose.yml]
        CI[No CI/CD config]
        EnvExample[No .env.example]
        Tests[No automated tests]
    end

    NodeProcess --> NeonPG
    NodeProcess -.optional.-> RedisInstance
    NodeProcess --> MapboxAPI
    ViteBuild -.served separately, not by NodeProcess.-> Browser2[Browser]
```

There is currently no reproducible build artifact and no documented deployment procedure. Every environment variable required to run the system (`system.md` §15) must be supplied by hand — there is no `.env.example` to reference, and no containerized environment to codify the dependency versions/config implicitly.

---

## 9. Operational Lifecycle

```mermaid
sequenceDiagram
    participant Ops as Operator/Deploy
    participant Server as server.js
    participant Prisma
    participant Redis
    participant Sim as VirtualRobotSimulator
    participant Recovery as taskRecovery.service.js

    Ops->>Server: node server.js
    Server->>Server: load env, create HTTP+Socket.IO server
    Server->>Prisma: connectPrismaWithRetry (4 attempts, 3s apart)
    Server->>Redis: initRedis + health probe (SET/GET/DEL)
    Server->>Server: wire socket handlers (dashboard JWT gate active)
    Server->>Prisma: ensureAdminUser (idempotent upsert)
    Server->>Recovery: recoverActiveTasks (rebuild Redis state for ASSIGNED/IN_PROGRESS)
    Server->>Sim: start simulator, re-hydrate VirtualRobot per DB row
    Sim->>Server: all robots marked online immediately
    Note over Server: 5s grace window
    Server->>Recovery: re-dispatch TASK_ASSIGN for tasks still active
    Note over Server: steady state — REST + Socket.IO serving traffic
    Ops->>Server: SIGINT/SIGTERM
    Server->>Sim: stop simulator
    Server->>Server: drain HTTP server
    Server->>Server: close Socket.IO
    Server->>Redis: close kv client
    Server->>Prisma: disconnect
    Server->>Ops: exit (non-zero on failure at any step)
```

Restart-recovery (no in-flight task or robot state is lost across a restart) and graceful shutdown (ordered drain of every subsystem) remain the two most robust pieces of operational engineering in the system, unchanged by the latest round of work and worth explicitly protecting in any future refactor.

---

## 10. What Changed Architecturally in the Latest Round

No new architectural pattern was introduced — every change fits inside the existing single-process, service-layer shape:

- **New cross-cutting module**: `config/dtaro.constants.js` — first shared-constants file in the codebase.
- **New data-plane primitive**: Redis atomic reservations (`kv.reserveRobot`/`releaseReservation`, `SET NX EX`) — used to make the allocation pipeline race-safe without introducing a lock service or queue.
- **New data-plane primitive**: Redis pipelined batch reads (`kv.mget`, `robotRegistry.getManyRobotStates`) — used to cut Redis round-trips in both the DTARO candidate loop and the REST robot-list endpoints.
- **New security surface**: `webauthn_controller.js` + `WebAuthnCredential` table — a real WebAuthn relying-party implementation, isolated to its own controller/route file, following the existing controller/route/service layering rather than introducing a new pattern.
- **New DTARO input**: zone-locality now genuinely participates in the cost function (`Z` term), and utilization is genuinely live (EMA from telemetry) — both were previously either absent or dead code.

What did **not** change: process topology (still one process), data-store topology (still Postgres + Redis, same roles), transport (still REST + Socket.IO on one shared `io` instance), and the two duplicate-state patterns (`registry:`/`robot:` Redis keys, and the two command-retry mechanisms) that were already flagged as technical debt — both remain exactly as they were.

---

*See `system.md` for full subsystem detail and `PHASE1_VERIFICATION.md` for the complete finding-by-finding audit trail with evidence and prioritized recommendations.*

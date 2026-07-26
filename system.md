# RobotX — System Documentation

> Technical record of the RobotX fleet-management platform as it actually exists in the repository today: architecture, data model, the DTARO robot-allocation system, Redis/Socket.IO usage, authentication (including WebAuthn), and known limitations.
>
> **Scope of this document**: everything under `Backend/` and `Frontend/`, branch `feature/dashboard`, reflecting the working tree exactly as it stands — including uncommitted changes on top of commit `fa1024f`. This document describes ONLY what is currently implemented. For the audit trail of what changed, what was verified, and what remains open, see `PHASE1_VERIFICATION.md`. For the proposed target architecture and migration plan, see `ARCHITECTURE_PROPOSAL.md`. This file intentionally does not carry a flaw-by-flaw roadmap — see §16 for a concise current-limitations summary.
>
> **Confidence note**: sections describing *behavior* (§6 allocation, §7 Redis, §9 telemetry) now have executable backing — `Backend/tests/` pins the claims that matter, and those tests re-run on every commit. Sections describing *structure* (§3 folder layout, §13 frontend) are still prose-only and drift silently. This repository has twice produced documentation that was confidently wrong within a day of being written; treat any behavioral claim here without a corresponding test as unverified.

---

## Table of Contents

1. [What RobotX Is](#1-what-robotx-is)
2. [Tech Stack](#2-tech-stack)
3. [Folder Structure](#3-folder-structure)
4. [High-Level Architecture](#4-high-level-architecture)
5. [Data Model (PostgreSQL / Prisma)](#5-data-model-postgresql--prisma)
6. [The DTARO Task Allocation Pipeline](#6-the-dtaro-task-allocation-pipeline)
7. [Redis Usage — Complete Key Map](#7-redis-usage--complete-key-map)
8. [Socket.IO Usage — Complete Event Map](#8-socketio-usage--complete-event-map)
9. [Real-Time Telemetry Pipeline](#9-real-time-telemetry-pipeline)
10. [Virtual Robot Simulation Engine](#10-virtual-robot-simulation-engine)
11. [Obstacle Detection & Rerouting (EKB)](#11-obstacle-detection--rerouting-ekb)
12. [Authentication & Authorization](#12-authentication--authorization)
13. [Frontend Architecture](#13-frontend-architecture)
14. [Current Admin Dashboard](#14-current-admin-dashboard)
15. [Configuration & Environment Variables](#15-configuration--environment-variables)
16. [Known Limitations](#16-known-limitations)
17. [Testing & Deployment](#17-testing--deployment)

---

## 1. What RobotX Is

RobotX is a fleet-management platform for autonomous delivery robots (ground rovers, modeled as delivery bots at 20–30 km/h). An operator (single `SUPER_ADMIN` role) commissions robots, creates delivery tasks (pickup → drop, geocoded via Mapbox), and the backend automatically:

- Selects the best available robot for a task using a multi-criteria cost function ("DTARO") that weighs distance, battery, utilization, travel time, and zone locality.
- Computes a real road route via Mapbox Directions.
- Dispatches the task to the robot over a persistent Socket.IO connection, with a reservation-based retry mechanism that prevents two concurrent assignments from starving the same task.
- Tracks the robot's live position/battery/status and streams it to connected dashboards.
- Detects obstacles reported by robots, determines which other robots are affected, and re-routes them automatically.
- Since no physical robot hardware exists yet, every commissioned robot is backed by a **VirtualRobot** — a fully simulated robot connecting over the same Socket.IO protocol a real robot would use, so the entire pipeline (auth, telemetry, task execution, battery drain, charging, obstacle reporting) is exercised end-to-end without hardware.

This is fundamentally a **real-time systems problem** wrapped in a CRUD dashboard: the hard parts are allocation correctness, race-condition safety under concurrency, Redis/Postgres consistency, and Socket.IO reliability — not the UI.

---

## 2. Tech Stack

### Backend (`Backend/`)
| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js (CommonJS, no TypeScript) | `server.js` is the entry point; `package.json`'s `main` correctly points to it |
| Web framework | Express 5 | `src/app.js` |
| Realtime | `socket.io` v4 (server) | one shared `io` instance stored on `app.locals.io` |
| ORM | Prisma 5 → PostgreSQL | `Backend/prisma/schema.prisma` |
| Cache / live-state store | `ioredis` v5, wrapped in a custom `kv` facade with an **in-memory fallback** | `src/cache/kv.js` |
| Auth | `jsonwebtoken` (HttpOnly cookie), `bcrypt` (password/PIN hashing), `google-auth-library` (Google OAuth), `@simplewebauthn/server` (Passkey/WebAuthn step-up) | |
| Routing/geocoding | Mapbox Directions API + Mapbox Matrix API (HTTP, via native `fetch`) | `src/services/mapbox.service.js` |
| Validation | `zod` schemas on socket payloads and some HTTP bodies | |
| Logging | Custom logger (`src/config/logger.js`) — colorized dev console, `pino` JSON in production, domain-specific formatters (`logger.dtaro`, `logger.simulation`, `logger.obstacle`) | |
| Security headers | `helmet` | |
| Rate limiting | Custom in-memory limiters — one for HTTP (`middlewares/rateLimitHttp.js`), one for Socket.IO (`sockets/rateLimit.js`) | Both are per-process, in-memory only (no Redis backing) — see §16 |
| Testing | `jest` 30 + `supertest`, `Backend/tests/` | 17 suites / 137 tests. `tests/helpers/testKv.js` drives the **real** `kv` facade in fallback mode rather than a stand-in, so TTL/reservation/`mget` semantics are genuinely exercised (§17) |

### Frontend (`Frontend/`)
| Layer | Choice | Notes |
|---|---|---|
| Framework | React 19 + Vite 8 | `src/main.jsx` → `RobotXApp.jsx` |
| Routing | `react-router-dom` v6 | `src/router/AppRouter.jsx` |
| State | Custom Context (no Redux/Zustand) | `src/context/AppProvider.jsx` + `appContext.js`, split into `AppStateContext`/`AppActionsContext` |
| Realtime client | `socket.io-client`, module-level singleton, `withCredentials: true` | `src/lib/socket.js` |
| Maps | `mapbox-gl` v3 | `src/features/maps/MapControl.jsx` + helpers |
| UI kit | Radix UI primitives + Tailwind CSS v4 + `class-variance-authority` (shadcn-style) | `src/components/ui/*` |
| Animation | `framer-motion`, `gsap` | marker movement, map style transitions |
| Charts | `recharts` (`BatteryPieChart`) | |
| Forms | `react-hook-form` + `@hookform/resolvers` + `zod` (dependency present; most forms hand-rolled) | |
| Auth widget | `@react-oauth/google`, `@simplewebauthn/browser` (Passkey step-up) | |

### Infra / operational notes (current state)
- **Automated tests exist** — `jest` 30, configured in `Backend/jest.config.js`, run via `npm test` (`jest --runInBand --forceExit`). **17 suites, 137 tests, all passing**; ~43% line coverage overall, concentrated on the allocation/auth/telemetry paths (§17).
- **No Docker/Compose files** anywhere in the repo.
- **No CI configuration** anywhere in the repo — the suite exists but nothing runs it automatically.
- **No `.env.example`** in either `Backend/` or `Frontend/` — environment variables are inferred entirely from code (§15 is the only place they're documented together).
- **No load test, and therefore no measured capacity ceiling.** Every performance statement about this system is currently an estimate.
- Prisma migrations are checked in (`Backend/prisma/migrations/*`), including a Postgres-only recursive CTE (`$queryRaw` in `location.service.js`) — ties the project to PostgreSQL.
- The working tree currently carries substantial **uncommitted** changes (three consecutive rounds — see `PHASE1_VERIFICATION.md` §0). Nothing in this document depends on that being committed; it describes the tree as it stands.

---

## 3. Folder Structure

```
RobotX/
├── Backend/
│   ├── server.js                     # entry point: boots Express + Socket.IO + Prisma + Redis + VirtualRobot simulator
│   ├── jest.config.js                # test runner config (node env, silent-logger mapper, coverage)
│   ├── tests/
│   │   ├── helpers/                  # mockPrisma, fakeSocket/fakeIo, testKv (real kv facade), waitFor
│   │   ├── mocks/silentLogger.js     # mapped over config/logger in every test
│   │   ├── setup/env.js              # deterministic env: Redis/Mapbox unset, fixed JWT secret
│   │   ├── unit/                     # auth/ dtaro/ redis/ tasks/ telemetry/
│   │   └── integration/              # socketAuthGate.test.js
│   ├── prisma/
│   │   ├── schema.prisma             # data model (see §5)
│   │   ├── migrations/               # checked-in, applied forward only
│   │   ├── seed.js                   # idempotent Location/Campus seed (Prisma `seed` hook)
│   │   └── seed-pin.js               # one-time admin PIN seed, requires SEED_ADMIN_PIN env var
│   ├── scripts/
│   │   ├── check_password.js         # debug CLI, no production guard
│   │   ├── check_users.js            # debug CLI, no production guard, prints hash prefixes
│   │   └── manual_telemetry_test.js  # manual unauthenticated-telemetry test client (expected to fail AUTH_REQUIRED by design)
│   └── src/
│       ├── app.js                    # Express app, /health endpoint
│       ├── cache/kv.js               # Redis facade + in-memory fallback (§7)
│       ├── config/                   # env.js, cors.js, logger.js, dtaro.constants.js (shared battery thresholds),
│       │                             #   liveness.constants.js (flush/offline-sweep timings + their invariant)
│       ├── controllers/              # auth_controller.js, webauthn_controller.js, robots.controller.js, tasks.controller.js, ...
│       ├── db/prisma.js              # Prisma client + connect-with-retry
│       ├── middlewares/              # auth_middleware.js (authUser, verifyUserToken), rateLimitHttp.js
│       ├── routes/                   # one file per resource, mounted in routes/index.js
│       ├── services/                 # taskAssignment, costEvaluator, robotRegistry, robotValidator, zoneManager, ekb, alertDissemination, routing, commandDispatcher, task, taskRecovery, metrics, mapbox
│       ├── simulation/               # SimulationEngine.js, VirtualRobot.js, constants.js — the only live simulator
│       └── sockets/                  # socket.server.js, rateLimit.js, handlers/ (robot, telemetry, dtaro, command)
├── Frontend/
│   └── src/
│       ├── router/                   # AppRouter.jsx, layout.jsx (global modals wired here), routeTitles.js
│       ├── context/                  # AppProvider.jsx (global state), appContext.js
│       ├── pages/                    # Dashboard, Map, Robots, RobotDetail, Commission, Tasks, Profile
│       ├── features/maps/            # MapControl.jsx + mapControl/hooks/ (useRobotStream, useMapController, useLocationFilters)
│       ├── components/               # modals/ (AuthChallengeModal, CreateTaskModal, DecisionRequiredModal), ui/ (Radix/shadcn primitives)
│       ├── lib/                      # api/*.js (REST clients), socket.js (singleton), storage/userPreferencesStorage.js
│       └── config/mapConfig.js       # MAP_STYLE only (dead demo config removed)
├── system.md                         # this file — current-state reference
├── ARCHITECTURE_PROPOSAL.md          # target architecture + migration plan (forward-looking)
├── FINAL_ARCHITECTURE_SUMMARY.md     # short-form current-state diagrams
├── scale-architecture.md             # earlier scale exploration (superseded by ARCHITECTURE_PROPOSAL.md)
├── PHASE1_REVIEW.md                  # prior production-readiness review (historical)
└── PHASE1_VERIFICATION.md            # finding-by-finding audit trail, incl. corrections to its own earlier verdicts
```

---

## 4. High-Level Architecture

```mermaid
flowchart LR
    subgraph Client["Browser (React SPA)"]
        UI[Dashboard / Map / Tasks / Robots pages]
        SIO_C[socket.io-client singleton, withCredentials]
    end

    subgraph Server["Node.js Backend (single process)"]
        EXPRESS[Express REST API — authUser-gated]
        IO[Socket.IO server — dashboard room JWT-gated]
        SVC[Service layer: taskAssignment, costEvaluator,\nrobotRegistry, robotValidator, zoneManager,\nekb, alertDissemination, routing, commandDispatcher]
        VR[VirtualRobot simulator\n(in-process socket.io-client instances)]
    end

    PG[(PostgreSQL via Prisma)]
    REDIS[(Redis via ioredis,\nin-memory fallback if down)]
    MAPBOX[[Mapbox Directions + Matrix API]]

    UI <--HTTP fetch (JWT cookie)--> EXPRESS
    SIO_C <--WebSocket (JWT cookie)--> IO
    EXPRESS --> SVC
    IO --> SVC
    SVC <--> PG
    SVC <--> REDIS
    SVC --> MAPBOX
    VR <--AUTH/TELEMETRY/TASK_ASSIGN socket events--> IO
    VR -.->|"real robot would connect here instead"| IO
```

**Everything runs in one Node.js process.** There is no worker queue, no separate microservice, no message broker beyond Redis-as-cache. `server.js` boots Express + Socket.IO + Prisma + Redis + the VirtualRobot simulator together, and on shutdown drains all of them in sequence (`SIGINT`/`SIGTERM` handlers, confirmed unchanged and correctly ordered).

### Startup sequence (`Backend/server.js`)
1. Load env (`src/config/env.js` — `dotenv` from `Backend/.env`).
2. Create HTTP server + attach Socket.IO with CORS origin-check callback.
3. Connect Prisma with retry (`connectPrismaWithRetry` — up to 4 attempts, 3s apart, each with a 30s connect timeout patched onto `DATABASE_URL`).
4. Initialize the `kv` (Redis) facade; probe it with a throwaway `SET/GET/DEL` to report Redis health in the startup banner.
5. Register `kv`, `prisma`, `io` on `app.locals` so controllers can reach them via `req.app.locals`.
6. Wire socket handlers (`initSocketServer`) — dashboard sockets now require a valid admin JWT to join the `dashboard` room (§8, §12).
7. `ensureAdminUser` — idempotent upsert of a single `SUPER_ADMIN` from `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`.
8. `recoverActiveTasks` — rebuilds Redis task-path/state keys for any `ASSIGNED`/`IN_PROGRESS` task left over from a previous run.
9. `server.listen()` → create the `VirtualRobotSimulator`, start it, re-hydrate a `VirtualRobot` for every robot row in Postgres, mark them online, and after a 5s grace window re-dispatch `TASK_ASSIGN` for tasks still active.

---

## 5. Data Model (PostgreSQL / Prisma)

Full schema: `Backend/prisma/schema.prisma`. Current models:

- **User** — single-role (`SUPER_ADMIN` only) admin account. Password login and Google OAuth (`googleId`), merged by verified email.
- **AdminPinAuth** — one-to-one with `User`, bcrypt-hashed PIN, with a legacy-plaintext auto-migration path (`crypto.timingSafeEqual`, re-hash on success).
- **WebAuthnCredential** — one-to-many with `User` (cascade delete). Fields: `credentialId` (unique), `publicKey`, `counter` (`BigInt`, replay/clone protection), `transports`, `deviceType`, `backedUp`, `createdAt`, `lastUsedAt`. Indexed on `userId`. This is a **new model** backing real server-verified Passkey step-up (§12).
- **Location** — self-referential hierarchy (`COUNTRY → STATE → CITY → AREA`), a cascading filter for the map UI, not a real geofencing/dispatch boundary. Unique on `(name, parentId)`.
- **Robot** — the central live-state row: `status` (`IDLE/ACTIVE/PAUSED/OFFLINE/ERROR/ISSUES`), `battery`, `lat/lon/speed`, `isOnline`, `socketId`, `lastSeenAt`, strict 1:1 `currentTaskId`. Also `zoneId` + `utilization` for DTARO. No `type`/`chassis` column exists — the Commission form's chassis-type field is collected in the UI but not persisted anywhere (known limitation, §16). Indexed on `status`, `isOnline`, `lastSeenAt`, `[locationId, isOnline]`, `campusId`, `zoneId`, `[lat, lon]`.
- **Zone** — rectangular bounding boxes used for obstacle geofencing, Socket.IO room targeting, **and now DTARO cost-function zone-locality scoring** (§6). Seeded automatically as 4 quadrants around a Campus center the first time any campus exists and no zones do.
- **ObstacleEvent** — persisted mirror of the Redis-primary EKB obstacle store; `expiresAt` column exists but nothing currently sweeps rows past expiry (Postgres copy is a permanent audit log today).
- **Campus** — optional grouping of robots/tasks around a center point; seed anchor for default Zones.
- **Task** — `pickup/pickupLat/pickupLon`, `drop/dropLat/dropLon`, `distanceMeters`, `status` (`PENDING → ASSIGNED → IN_PROGRESS → COMPLETED | FAILED | CANCELLED`), `startedAt/completedAt`.
- **Telemetry** — historical position/speed/battery snapshots, throttled (§9).
- **Event** — generic audit/notification log (`INFO/WARNING/CRITICAL`).
- **Command** — `STOP/PAUSE/RETURN/RESUME` with `status` (`SENT/ACK/FAILED`), `issuedAt/executedAt`.
- **Decision** — modeled (`reason`, `imageUrl`, `action: WAIT/REROUTE/CANCEL`, `resolvedAt`) but **no code path writes to it** — the frontend's obstacle-decision UI (`DecisionRequiredModal`) is entirely client-side state; the table exists in the schema with zero writers anywhere in the service layer (§16).

---

## 6. The DTARO Task Allocation Pipeline

### 6.1 What "DTARO" means in this codebase

The project's internal name for its rule-based multi-criteria allocation system. It is a deterministic weighted-sum cost function evaluated fresh for every task:

```
C(r) = w1·D(r) + w2·(1−B(r)) + w3·U(r) + w4·T(r) + w5·Z(r)

D(r) = normalized haversine distance from robot r to the pickup point (0–1, min-max across current candidates)
B(r) = battery level 0–100, used as (1 − B/100)
U(r) = utilization ratio 0–1, EMA-smoothed (α=0.05) from live telemetry — genuinely live, updated every tick
T(r) = normalized Mapbox-Matrix travel duration to pickup (0–1, min-max across current candidates)
Z(r) = 0 if robot r is in the same Zone as the pickup point, else 1 (neutral 0 for all candidates if pickup zone unknown)

Default weights: w1=0.50 (distance), w2=0.30 (battery), w3=0.15 (utilization), w4=0.05 (travel time), w5=0.05 (zone locality)
```

Note: `w1..w4` sum to 1.00 on their own; `w5` is additive on top, so the effective weight budget is 1.05, not renormalized. This is a deliberate implementation choice (`costEvaluator.service.js`), not a bug — worth knowing precisely when tuning weights.

Source: `Backend/src/services/costEvaluator.service.js`. Weights are overridable per-call via `costWeights`, but there is no persistence or admin UI for changing them — they live only as a function parameter.

### 6.2 End-to-end flow for `POST /api/tasks/assign`

```mermaid
sequenceDiagram
    participant UI as Dashboard
    participant API as tasks.controller.js
    participant TS as task.service.js
    participant TA as taskAssignment.service.js
    participant CE as costEvaluator.service.js
    participant KV as Redis (kv.js)
    participant MB as Mapbox
    participant DB as Postgres
    participant SOCK as Robot socket

    UI->>API: POST /api/tasks/assign {pickup, drop, ...}
    API->>TS: assignTask(prisma, body, {kv, io})
    TS->>DB: task.create(status=PENDING)  [fast path]
    TS-->>UI: 200 OK, task=PENDING
    TS->>UI: emit TASK_CREATED (dashboard room)
    Note over TS: setImmediate() — heavy work runs AFTER the response
    loop up to 3 attempts (F4 fix)
        TS->>TA: selectNearestRobot({prisma, kv, pickup, excludeRobotIds})
        TA->>DB: find IDLE/PAUSED, isOnline, currentTaskId=null, not in excludeRobotIds
        TA->>KV: getManyRobotStates() — one pipelined MGET for the whole candidate pool
        TA->>MB: Matrix API (batches of 24) — travel duration to pickup
        TA->>CE: computeCosts(candidates, weights, pickupZoneId) → min-cost robot
        TA-->>TS: {robotId, start, cost, components}
        TS->>KV: reserveRobot(robotId, taskId, ttl=30s)  — atomic SET NX EX
        alt reservation succeeds
            TS->>MB: Directions API (driving→walking→cycling fallback) x2 legs
            TS->>DB: transaction: task.update(ASSIGNED), robot.update(currentTaskId, ACTIVE)
            TS->>KV: seed taskPath, robotTaskState; releaseReservation
            TS->>UI: emit TASK_ASSIGNED (route geometry) + TASK_UPDATED
            TS->>SOCK: dispatchTaskAssign (TASK_ASSIGN event, retried up to 2x)
            TS->>KV: recordAllocation(cost, components, latencyMs) — real values, not null
        else reservation lost to a concurrent request
            TS->>TS: exclude that robot, retry selectNearestRobot (up to 2 more times)
        end
    end
    Note over TS: task fails only after 3 total attempts are all lost/ineligible
```

**Key design decisions, both still true today**:
1. The HTTP response returns immediately after creating a `PENDING` task row; all expensive work (robot selection, Mapbox calls, DB transaction, Redis writes, socket dispatch) happens in a background `setImmediate()` phase. Assignment failures are only visible via the socket `TASK_UPDATED{status:"FAILED"}` event, not the original HTTP response — the frontend correctly listens for this.
2. **Allocation now has a reservation-and-retry safety net.** `Backend/src/cache/kv.js` exposes `reserveRobot(key, value, ttlSec)` (atomic `SET key value EX ttl NX`) and `releaseReservation(key)`. When two concurrent assignment requests select the same robot, the losing request's reservation attempt fails, and — unlike the pre-fix behavior — it retries `selectNearestRobot` excluding the already-claimed robot, up to 2 additional times (`MAX_RESERVATION_RETRIES=2`, 3 attempts total) before the task is allowed to fail. The reservation is released in a `finally` block on every code path (success, failure, thrown error).

### 6.3 Candidate selection & validation

1. Postgres query: `status IN (IDLE, PAUSED)`, `isOnline: true`, `currentTaskId: null`, excluding any robot already excluded by a prior retry attempt this call, capped at `maxRobots` (default 100).
   - `PAUSED` is included because virtual robots that are `CHARGING` are stored in Postgres as `PAUSED` (the Prisma `RobotStatus` enum has no `CHARGING` value) — Redis is the only place the real `"CHARGING"` string survives.
2. Live state for the entire candidate pool is fetched in **one pipelined Redis `MGET`** (`robotRegistry.service.js:getManyRobotStates`, built on `kv.mget()`), not a per-candidate round-trip.
3. Each candidate is validated (`robotValidator.service.js:validateRobot`, accepting the pre-fetched live state instead of re-fetching):
   - Must be online.
   - Effective status is Redis-first, DB-second.
   - If effectively `CHARGING`, battery must be ≥ `CHARGING_INTERRUPT_BATTERY` semantics via the shared `BATTERY_THRESHOLD`/`CHARGING_INTERRUPT_BATTERY` constants (`Backend/src/config/dtaro.constants.js` — the single source of truth both the validator and the simulator import from, `20`% and `30`% respectively, deliberately distinct values, not accidentally-diverged ones).
   - If not charging: must be DB-`IDLE`, no `currentTaskId`, battery ≥ `BATTERY_THRESHOLD` (20%), `healthStatus !== "FAULT"`.
   - Auth/registry-desync guard (connected socket but registry says unauthenticated → reject).
4. Surviving candidates get live position overlaid from the same batched fetch, falling back to the DB row if Redis has nothing.
5. Mapbox Matrix API called in batches of 24 origins → 1 destination; on failure the whole batch falls back to `durationSec: null` (travel-time term stops discriminating for that call).
6. `computeCosts()` runs the 5-term weighted-sum formula (§6.1); minimum-cost robot wins.
7. A full structured decision log is written via `logger.dtaro()` (now including the `Z` zone-locality component in its dev-console breakdown) — candidates, per-candidate cost breakdown, rejection reasons, winner.

### 6.4 Finalization

`_processAssignment()` re-fetches the chosen robot, re-validates it, takes a Redis reservation on it, computes the two-leg road route, commits inside a Prisma transaction that re-checks `currentTaskId` is still null, seeds Redis task-state keys, emits `TASK_ASSIGNED`/`TASK_UPDATED`, dispatches `TASK_ASSIGN` (2 retries, 1s/2s backoff, silently dropped after that — restart-recovery is the real delivery guarantee), and calls `recordAllocation()` with the **real** computed `cost`, `costComponents`, and measured `latencyMs` (previously always `null` for auto-assigned tasks; manually-assigned tasks — where an operator picks a specific `robotCode` — still record `cost: null` since no cost is computed for a manual pick, which is expected, not a bug).

### 6.5 Rerouting an in-progress task

Unchanged from prior behavior: automatic (`alertDissemination.service.js` → `routing.service.js:rerouteRobot()` for every robot whose path intersects a new obstacle) and manual (`POST /api/tasks/:taskId/reroute`, wired to `DecisionRequiredModal`'s REROUTE button — redundant with the automatic reroute that already ran by the time an operator sees the modal). Both converge on the same `taskPath:{taskId}` Redis structure and `REROUTE_ALERT` event.

### 6.6 Restart recovery

Unchanged: on boot, every `ASSIGNED`/`IN_PROGRESS` task gets its Redis path/state rebuilt from the DB plus a fresh Mapbox route from the robot's last-known position, and `server.js`'s startup re-hydration re-dispatches `TASK_ASSIGN` after a 5s grace window. No bounded-concurrency limit exists on this recovery loop (a restart with many active tasks issues many sequential Mapbox calls).

### 6.7 Utilization is live

`robotRegistry.service.js:updateUtilization()` is called every telemetry tick (`telemetry.handler.js`, EMA α=0.05, `1` while `ACTIVE`/`0` otherwise) — previously dead code, now a genuinely functioning input to the cost function.

### 6.8 Zone locality is live — and was not, until recently

The `Z` term has been present in `costEvaluator.service.js` since the round that introduced it, but it was **inert in production** until the zone write path was added: `robotRegistry.updateZone()` was exported with **zero callers**, so neither `registry:{robotId}.zoneId` nor the `Robot.zoneId` column was ever written. `costEvaluator` therefore evaluated `c.zoneId && c.zoneId === pickupZoneId` against a permanently-`null` value, scoring `Z = 1` for every candidate — a constant offset with **no effect on ranking**.

`zoneManager.assignRobotToZone()` now persists the resolved zone:
- **Registry (Redis) — on every call.** Cheap, merge-semantics, and it refreshes the 30s registry TTL.
- **Postgres `Robot.zoneId` — only on an actual change.** Zone crossings are rare by construction; the column exists solely as the durable fallback `taskAssignment.service.js:138` reads when the registry entry has expired.

The registry write happens *before* the socket-room update and the `ZONE_UPDATED` emit, so a failure in either of those cannot leave the zone unrecorded and re-trigger the "changed" branch on the next tick.

Pinned by `tests/unit/dtaro/zoneLocality.test.js`, which asserts a same-zone candidate scores strictly lower than an otherwise-identical out-of-zone one.

> **Why this is called out at length**: the formula was correct, the plumbing was correct, `pickupZoneId` was resolved and threaded through correctly — and the feature still did nothing, because one write was missing. Reading the cost function verified everything except the thing that was broken. See `PHASE1_VERIFICATION.md` §7.

### 6.9 What the cost function still does not account for

- **No caching/circuit-breaking around Mapbox** — every assignment still makes 1 Matrix call and up to 2 Directions calls synchronously in the hot path, with no cross-request failure-rate tracking. A degraded (not fully down) Mapbox endpoint silently slows every assignment.
- **No batch/global optimization across simultaneously-arriving tasks** — the reservation-and-retry mechanism (§6.2) fixes the specific "two tasks pick the same robot" race, but tasks are still assigned one at a time, independently; there is no joint optimization across a batch of pending tasks.

---

## 7. Redis Usage — Complete Key Map

Redis is a fast, ephemeral, TTL-based live-state cache layered in front of PostgreSQL, plus the sole store for sessions, pairing codes/locks, WebAuthn challenges, and the EKB obstacle primary copy. `Backend/src/cache/kv.js` is a hand-written facade (`get/set/del/sadd/srem/smembers/setManyEx/mget/reserveRobot/releaseReservation/incr/health`).

### Fallback policy — per-capability, not uniform

The facade falls back to an in-process `Map` when Redis is unavailable, **with one deliberate exception**. The policy turns on operator intent:

| Redis state | Cache reads/writes, counters, sets | `reserveRobot` (the allocation lock) |
|---|---|---|
| Available | Redis | Redis (`SET key val EX ttl NX`) |
| **Not configured** (`REDIS_ENABLED=false`, or no `REDIS_URL`) | In-memory fallback | **In-memory fallback** — single-process operation is the operator's explicit intent, so a process-local lock is genuinely correct |
| **Configured but unreachable** | In-memory fallback (degrade) | **Fails closed** — throws `503` with `code: "LOCK_UNAVAILABLE"` |

The exception exists because an in-memory lock is only a lock *relative to its own process*. Two replicas that had both degraded to memory would each be granted the same robot, silently, reintroducing the exact double-assignment race the F4 reservation mechanism exists to prevent — and doing so precisely in the multi-instance deployment where it matters. Halting allocation is a recoverable business problem (the task is marked `FAILED` and can be retried); double-assigning a physical vehicle is not.

`releaseReservation` is deliberately **lenient** — it runs inside a `finally` block, so throwing there would mask whatever error was already unwinding. A release that doesn't land is covered by the reservation's 30s TTL.

Caches, counters, and rate limiters deliberately **fail open**: failing those closed would turn a brief Redis blip into a full outage.

### Reconnect and health

`disableRedis()` schedules a **background reconnect probe** with capped exponential backoff (1s → 30s), `unref()`d so it never holds the process open and cleared on `close()`. A transient outage no longer downgrades a process to in-memory mode for the remainder of its life.

`kv.health()` returns `{ redis, configured, reconnecting }` — surfaced by `/health`. `reconnecting: true` means "configured, currently down, actively retrying", which is the state an operator needs to see and which was previously indistinguishable from normal operation.

### Key catalog

| Key pattern | TTL | Written by | Read by | Purpose |
|---|---|---|---|---|
| `registry:{robotId}` | 30s | `robotRegistry.service.js` (`setRobotState`, called by `markOnline/markOffline/updateTelemetry/updateZone/updatePlannedPath/updateUtilization/updateAssignedTask/updateHealthStatus`); `updateZone` is called from `zoneManager.assignRobotToZone`, `lastHeartbeat` also written by the `HEARTBEAT` handler | `costEvaluator`, `robotValidator`, `taskAssignment` (via batched `getManyRobotStates`), `alertDissemination`, **the offline sweep** (`socket.server.js`) | The DTARO live-state document — lat/lon/battery/status/speed/zoneId/utilization/plannedPath/healthStatus/authenticated/connected/assignedTaskId/lastHeartbeat. Writes merge (`{...existing, ...update}`) rather than replace, so a field omitted from one tick's payload (e.g. `healthStatus` during routine telemetry) survives. **`zoneId` is genuinely written now** — it previously never was, which silently disabled the DTARO `Z` term (§6.8). **`lastHeartbeat` is now load-bearing**: it is the live liveness signal the offline sweep reads before marking a robot offline (§9). |
| `robot:{robotId}` | 15s | `telemetry.handler.js` (every tick), `robots.controller.js` (on commission) | `task.service.js`, `taskRecovery.service.js`, `robots.controller.js` (now via `kv.mget()`, one pipelined call for `GET /api/robots*` instead of per-row `GET`s) | A second, differently-shaped live-state document for the same robot — still a distinct key from `registry:{robotId}`, still not consolidated (see §16). |
| `robots:all` (Set) | none | commission paths, task recovery | `getAllRobotIds`, `metrics.service.js` | Index of every robot ID ever seen live. |
| `session:{robotId}` | 7 days | `robot.handler.js` AUTH success, `VirtualRobot.commission()` | `robot.handler.js` AUTH (reconnect) | Bearer session token for robot reconnects. |
| `pairing:{robotId}` | 300s | `robots.controller.js` (`commissionRobotWithPairing`) | `robot.handler.js` AUTH (first-time pairing) | One-time 6-digit pairing code. |
| `pairingAttempts:{robotId}` | 300s | `robot.handler.js` (`kv.incr`, atomic) | same | Brute-force counter. |
| `pairingLocked:{robotId}` | 1 hour | `robot.handler.js` (`lockPairing()`, at ≥5 attempts) | `robot.handler.js` AUTH (checked before code comparison), `robots.controller.js` unlock endpoint | **New key.** Actually blocks further pairing attempts for that robot ID (keyed by robot, not socket, so reconnecting doesn't reset the counter) — previously this was log-only. Cleared early via `POST /api/robots/:robotId/pairing/unlock`. |
| `socket:{socket.id}` | 3600s | `robot.handler.js` AUTH | disconnect handler | Reverse lookup socket→robotId. Only written on successful AUTH. |
| `taskPath:{taskId}` | 86400s | `task.service.js` (assign + reroute), `taskRecovery.service.js` | `task.service.js` (reroute), `routing.service.js`, `socket.server.js` (dashboard re-hydration) | `{ toPickup, toDrop, pickup, drop }` route geometry. Not cleared on cancel. |
| `task:{taskId}` | 86400s | `task.service.js` seed | *(no reader anywhere in the codebase)* | `{ phase, idx, waitUntil }` — confirmed dead: written on every assignment/recovery, never read. |
| `robotTask:{robotId}` | 86400s | `task.service.js`, `taskRecovery.service.js` | *(no reader for its value — only deleted, never read)* | Maps a robot to its current task ID. Now cleaned up on `TASK_COMPLETE` (`dtaro.handler.js`), but still never consulted for a decision anywhere. |
| `robotTaskState:{robotId}` | 86400s | `task.service.js`, `taskRecovery.service.js` | `task.service.js` (reroute), `routing.service.js` | `{ taskId, phase, pathIndex, waitUntil, segment, startedAt, parking }` — the actual state machine reroute logic reads. Cleared on `TASK_COMPLETE`, **not** cleared on cancel. |
| `snapshotState:{robotId}` | 86400s | `telemetry.handler.js` | same | Tracks last-persisted telemetry snapshot for the smart-snapshot throttle. |
| `vr:battery:{robotId}` | 48h | `VirtualRobot._maybePersistBattery()` (~every 2 min), `telemetry.handler.js` (real-robot mirror, every ~120s) | `VirtualRobot.commission()` on restart | Survives a restart with the robot's actual battery level. |
| `vr:batteryPersistAt:{robotId}` | 48h | `telemetry.handler.js` | same | Debounce timestamp. |
| `zones:all` | 300s | `zoneManager.service.js` | same | Redis-tier cache of Zone rows (also a 60s in-process tier, Postgres as tier 3). |
| `ekb:event:{obstacleId}` | `ttlSec` (default 300s) | `ekb.service.js` (`storeObstacle`) | `ekb.service.js` (`getActiveObstacles`) | Obstacle payload; Redis TTL is the primary expiry mechanism — the Postgres `ObstacleEvent` copy is never itself swept. |
| `ekb:obstacles` (Set) | none | `ekb.service.js` | same, `metrics.service.js` | Index of active obstacle IDs, periodically swept every 60s. |
| `metrics:allocation:{timestamp}` | 3600s | `metrics.service.js` (`recordAllocation`) | *(no reader back yet)* | Write-only allocation telemetry — **now carries real `cost`/`components`/`latencyMs`** for auto-assigned tasks (previously always `null`); still `null` for manually-assigned tasks by design. No dashboard/endpoint reads this back yet. |
| `cmd:rt:{commandId}` | 86400s | `command.handler.js` (`COMMAND_ACK`) | *(no reader)* | Command round-trip time. |
| `cmdretry:{commandId}` | 3600s | `robots.controller.js` (`sendRobotCommand` retry loop) | same | Retry counter for STOP/PAUSE/RETURN/RESUME command reliability. |
| `webauthn:{purpose}Challenge:{userId}` | 300s | `webauthn_controller.js` (`registerOptions`/`authOptions`) | `webauthn_controller.js` (`register`/`verify`) | **New key.** Server-generated WebAuthn challenge (`purpose` is `reg` or `auth`), deleted immediately after use (success or failure) — prevents challenge replay. |
| `health:{timestamp}`, `hb:{timestamp}` | 2s | `app.js` `/health`, `server.js` startup probe | same | Throwaway Redis-alive probes, self-delete. |

### Batched reads

Two dedicated batching helpers now exist on top of `kv.mget()` (pipelined native `MGET`, sequential fallback in-memory): `robotRegistry.service.js:getManyRobotStates()` (used by the DTARO candidate loop) and direct `kv.mget()` calls in `robots.controller.js`'s `listRobots`/`getRobotsState` (used by `GET /api/robots*`). Both replaced what were previously `Promise.all` loops of individual `GET`s.

### Design pattern: multi-tier fallback

Every Redis read follows: **Redis (fast, ephemeral) → Postgres (source of truth) → sane default**, and every Redis *cache* write is best-effort (try/catch, failure silently swallowed). A process that loses Redis now retries in the background rather than latching into memory mode for its lifetime.

Two qualifications to the old "the system runs correctly with zero Redis" claim, both important:
- It holds when Redis is **deliberately** disabled — single-process operation is then the operator's stated intent.
- It does **not** hold when Redis is configured but unreachable: allocation deliberately fails closed (see the fallback-policy table above), because a process-local allocation lock is not a lock at all across replicas.

No dashboard indicator surfaces degraded state to an operator — `/health` exposes `{ redis, configured, reconnecting }` but nothing in the frontend polls it (§16).

---

## 8. Socket.IO Usage — Complete Event Map

One shared `io` instance (`Backend/src/sockets/socket.server.js`). Dashboards (browsers) and robots (real or `VirtualRobot`) connect to the same endpoint, told apart heuristically (`isDashboard = !!(origin || userAgent.includes("Mozilla"))`).

**A dashboard-candidate socket must now also present a valid admin-session JWT** (the same `token` HttpOnly cookie `authUser` verifies for REST, checked via the shared `verifyUserToken()` helper in `middlewares/auth_middleware.js`) before it is joined to the `dashboard` room. An invalid/missing token gets `socket.emit("UNAUTHORIZED", ...)` followed by `socket.disconnect(true)` — the socket never joins `dashboard`. Robot sockets are unaffected — they authenticate solely via their own `AUTH` event. `Frontend/src/lib/socket.js` sends `withCredentials: true` so the cookie reaches the handshake.

The Socket.IO-level CORS no-Origin bypass is closed: `cors.js:isOriginAllowed` now returns `false` when no `Origin` header is present (F29/F2, see §16).

### Rooms
| Room | Who joins | Purpose |
|---|---|---|
| `dashboard` | A browser-like socket **with a valid admin JWT** | Fleet-wide broadcasts (`TASK_*`, `ROBOT_*`, `ALERT_CREATED`, `ZONE_UPDATED`, `REROUTE_ALERT` dashboard copies) |
| `robot:{robotId}` | A robot socket, after successful `AUTH` | Targeted delivery (obstacle alerts, task assignment, reroutes) |
| `zone:{zoneId}` | A robot socket, updated on zone change | Infrastructure exists; not currently used to emit anything |

### Events — robot → server

| Event | Handler | Rate limit | Notes |
|---|---|---|---|
| `AUTH` | `robot.handler.js` | 5/60s, min 100ms | Session-token reconnect or pairing-code first-time path. Pairing brute-force is now actually blocked after 5 failed attempts (`pairingLocked:{robotId}`, 1h), keyed by robot ID so reconnecting with a new socket does not reset the counter. Admin override: `POST /api/robots/:robotId/pairing/unlock`. |
| `TELEMETRY` (+ legacy alias `telemetry`) | `telemetry.handler.js` | 50/5s, min 100ms | Requires `socket.data.isAuthed` unconditionally — no first-telemetry bind path exists. Unauthenticated frames get `AUTH_REQUIRED` and are dropped. |
| `HEARTBEAT` (+ legacy `heartbeat`) | `robot.handler.js` | 10/5s, min 100ms | Writes `lastHeartbeat` to the Redis registry on **every** beat (the live liveness signal), and bumps the durable `Robot.lastSeenAt` mirror **at most once per `DB_FLUSH_INTERVAL_MS`**. Previously this issued an unconditional `prisma.robot.update` per beat — 30 full-row writes/robot/minute at the simulator's 2s tick, which completely defeated the telemetry handler's own flush gate (§9). |
| `OBSTACLE_REPORT` | `dtaro.handler.js` | 10/60s, min 500ms | Requires prior AUTH. Triggers the obstacle-dissemination pipeline (§11). |
| `TASK_COMPLETE` | `dtaro.handler.js` | 5/30s, min 1000ms | Marks task `COMPLETED`, frees robot to `IDLE`, clears `robotTaskState`/`robotTask` Redis keys. |
| `ROBOT_FAULT` | `dtaro.handler.js` | 5/60s, min 1000ms | Sets `status=ERROR` (DB), `healthStatus=FAULT` (registry), logs an `Event`, broadcasts `ROBOT_UPDATED`. **Now clearable**: `POST /api/robots/:robotId/clear-fault` transitions the robot back to `ACTIVE`/`IDLE` and resets `healthStatus` to `OK`, logging a corresponding `Event`. Telemetry writes no longer clobber `healthStatus` on ordinary ticks (merge semantics, not replace). |
| `COMMAND_ACK` | `command.handler.js` | 20/60s, min 100ms | Marks a `Command` row `ACK`, computes response time, logs an `Event`, broadcasts `COMMAND_STATUS`. |

### Events — server → robot

| Event | Sent by | Delivery guarantee |
|---|---|---|
| `TASK_ASSIGN` | `commandDispatcher.service.js` | Best-effort, 2 retries (1s, 2s), silently dropped after that — restart-recovery is the real delivery guarantee, not this dispatch call. |
| `REROUTE_ALERT` | `commandDispatcher.service.js` | 1 retry only (time-sensitive). |
| `STOP` / `PAUSE` / `RETURN` / `RESUME` | `robots.controller.js:sendRobotCommand` → `scheduleReliabilityCheck` | A **separate, independent** retry mechanism from `TASK_ASSIGN`/`REROUTE_ALERT`: checks Postgres `Command.status` every 5s via a Redis-backed `cmdretry:{commandId}` counter, up to 2 retries, marks `FAILED` after exhausting them. Deliberately kept separate from `commandDispatcher.service.js` (documented in a code comment), but this means two different retry policies exist for "reliably deliver a command," and neither survives a server restart mid-retry. |
| `AUTH_SUCCESS` / `AUTH_OK` (alias) / `AUTH_REQUIRED` | `robot.handler.js` | — |

### Events — server → dashboard

`robot:update` (canonical telemetry broadcast — sent to **every** connected socket, not scoped to the `dashboard` room), `ROBOT_UPDATED`, `ROBOT_COMMISSIONED`, `robot_online`/`robot_offline`/`robot_unregistered` (also broadcast to all sockets, not just `dashboard`), `TASK_CREATED`, `TASK_UPDATED` (status changes and reroute notifications multiplexed via an `action` field), `TASK_ASSIGNED` (route geometry), `ALERT_CREATED`, `REROUTE_ALERT` (dashboard copy), `ZONE_UPDATED`, `COMMAND_STATUS`, and the legacy `assign_task` → `task_assigned`/`task_error` Socket.IO task-creation path, which remains registered in `socket.server.js` alongside the REST `POST /api/tasks/assign` path that the current frontend actually uses.

### Rate limiting mechanism

`sockets/rateLimit.js` — a single in-memory `Map` keyed by `socket.id + event name`, combining a hard minimum-interval gate and a sliding-window counter. Per-process, per-socket state; resets on reconnect; does not scale across multiple server instances. Opportunistic cleanup (evicts entries idle >60s once the map exceeds 50,000 entries).

---

## 9. Real-Time Telemetry Pipeline

Every 2 seconds, each connected robot emits `TELEMETRY`. `telemetry.handler.js` remains the single busiest code path, running **sequentially** per tick:

1. Backpressure check — drop the frame if `bufferedAmount` exceeds `SOCKET_BUFFER_LIMIT_BYTES` (default 1MB).
2. Rate-limit check (50/5s, 100ms min interval).
3. Zod-validate/parse the payload.
4. **Auth check** — `socket.data.isAuthed`/`socket.data.robotId` must already be set from a successful `AUTH`; otherwise `AUTH_REQUIRED` and drop. Unconditional for every robot, including never-before-paired ones.
5. One Postgres read (`prisma.robot.findUnique`) for status-transition validation and payload gap-filling.
6. Status-transition validation against a hardcoded state machine (`TRANSITIONS` map).
7. One Redis read (`robot:{robotId}`) to merge with previous state.
8. Distance-travelled accounting (VirtualRobots send it directly; real robots would accumulate from haversine deltas, 500m sanity cap).
9. One Redis write (`robot:{robotId}`, 15s TTL) with merged state.
10. **One Postgres write** (`prisma.robot.update`) — lat/lon/battery/lastSeenAt/isOnline/status, **throttled by a dirty-state flush gate** (`DB_FLUSH_INTERVAL_MS`, shared from `config/liveness.constants.js`). It fires only when: status actually transitions (a field the DTARO candidate query filters on), the robot just came back online, battery moved ≥2% since the last flush, or the interval elapsed. **Movement deliberately does not force a flush** — Redis carries live position every tick regardless, so gating on distance would defeat the purpose (a moving robot covers >10m almost every tick).
11. Smart-snapshot decision (`shouldStoreSnapshotSmart`) — a new `Telemetry` history row is only inserted if ≥15s elapsed, or the robot moved ≥~11m, or battery changed ≥2% since the last stored snapshot.
12. Registry update (`updateTelemetry` → `registry:{robotId}` write, a second, differently-shaped Redis write from step 9's `robot:{robotId}` — both keys still exist independently, see §16). This write **omits `healthStatus`** from its payload; combined with `setRobotState`'s merge (not replace) semantics, a `FAULT` status set by `ROBOT_FAULT` now survives ordinary telemetry ticks instead of being silently reset.
13. **Utilization EMA update** — `updateUtilization()` is called every tick (`α=0.05`, `1` if `status==="ACTIVE"` else `0`), feeding directly into the DTARO cost function's `U(r)` term (§6.1). This is new: previously dead code, now live.
14. Zone-membership resolution → **persisted to the registry every tick** (§6.8), with Socket.IO room join/leave and a `ZONE_UPDATED` broadcast **only on an actual zone change**. Previously, because `zoneId` was never persisted, the change-check compared against a permanently-`null` previous value and fired on *every* tick — a `socket.join()` plus a `dashboard` broadcast twice a second per robot, indefinitely.
15. Every ~120s: persist battery to `vr:battery:{robotId}`.
16. `io.emit("robot:update", fullState)` — broadcast to **every connected socket, robots included**, not just `dashboard`. See §16.

### Per-tick cost, per active robot

| | Postgres reads | Postgres writes | Redis round-trips | Dashboard broadcasts |
|---|---|---|---|---|
| **Telemetry tick** | 1 (unconditional) | ~0.07 avg (1 per 15s flush interval) | ~8–10 | 0 (steady state) |
| **Heartbeat, same 2s tick** | 0 | ~0.07 avg (same shared interval) | 1 | 0 |

Still **fully sequential** — no pipelining or parallelization of the independent reads/writes has been introduced (§16, F12).

**What changed and what didn't.** Postgres *write* volume dropped from ~30 full-row updates per robot per minute to ≤4: the flush gate above throttles the telemetry path, and `robot.handler.js`'s `HEARTBEAT` path — which previously issued an **unconditional** `prisma.robot.update` on every beat, and is emitted on the *same* 2-second tick by `VirtualRobot._tick()` — is now throttled by the same shared interval. Until that second path was fixed, the telemetry gate reduced nothing in aggregate; it only moved the writes to a different handler.

The Postgres *read* (step 5) is still unconditional, once per robot per tick, and is now the dominant per-tick database cost.

### Offline detection

Two independent mechanisms, with clearly different roles:

1. **Primary — the socket `disconnect` handler** (`robot.handler.js`). A robot that disconnects normally is marked offline *immediately*: the handler verifies this socket is still the robot's current one (guarding against a newer reconnect having replaced it), then sets `isOnline: false, status: OFFLINE`, clears the registry, and broadcasts `robot_offline`.

2. **Backstop — the periodic sweep** (`socket.server.js:startOfflineDetector`). Catches only the cases where (1) never ran: a process kill, a half-open TCP connection, a lost network. Runs every `OFFLINE_SWEEP_INTERVAL_MS` (10s):
   - Selects robots that are `isOnline` with `lastSeenAt` older than `OFFLINE_CUTOFF_MS` (30s), capped at `OFFLINE_SWEEP_BATCH` (500) per pass — so its cost scales with the number of *suspect* robots, not fleet size.
   - Batch-reads their registry entries and consults `lastHeartbeat`. Only robots that Redis *also* considers stale are marked offline.
   - Robots that are alive per Redis but stale in Postgres get their `lastSeenAt` reconciled instead of being downed, with a warning log. A sustained non-zero count here means the flush gate is not keeping up and is worth alerting on.
   - With Redis unavailable this degrades to the DB-only behavior, which is safe: the flush interval is half the cutoff, so a live robot's row never ages past it.

**The two timings are coupled and must stay that way.** `config/liveness.constants.js` holds both, and documents the invariant:

```
DB_FLUSH_INTERVAL_MS (15s)  <  OFFLINE_CUTOFF_MS (30s)
```

If the cutoff were ever ≤ the flush interval, a perfectly healthy robot would be marked `OFFLINE` in the gap between two throttled writes and would flap indefinitely. This is exactly why the pre-throttle heartbeat path had to write on *every* beat, and it is the reason throttling those writes required changing the sweep in the same change.

The trade accepted here: backstop detection latency widened from ~10s to ~30s. That is acceptable precisely because the sweep is *not* the primary signal — normal disconnects are still detected instantly.

---

## 10. Virtual Robot Simulation Engine

`Backend/src/simulation/{SimulationEngine,VirtualRobot,constants}.js` — the only "robot" that exists, and the only simulator wired into `server.js` (confirmed: `server.js` imports `createVirtualRobotSimulator` from `SimulationEngine.js`; no other simulation engine exists in the codebase — the previously-dead second engine, `simulation.service.js`, has been deleted entirely, not just left unwired).

- Never auto-spawned — created on commission (`SimulationEngine.addRobot`), re-created per DB row on server restart.
- Connects exactly like a real robot would — a real `socket.io-client` instance hitting `AUTH`/`TELEMETRY`/`TASK_ASSIGN`, genuinely exercising auth, rate limits, zod validation, and registry updates.
- **Battery model** — real-time rates: `100%→20%` in 1 hour while `ACTIVE`, `100%→20%` in 5 hours while idle/paused, `10%→100%` in 30 minutes while charging, 30s docking delay. Persisted to Redis every ~2 minutes.
- **Speed model** — EMA-smoothed (`α=0.20`) around 20–30 km/h.
- **Task execution state machine**: `TO_PICKUP → WAIT_PICKUP (10s) → TO_DROP → WAIT_DROP (8s) → complete`. Movement capped at `MOVE_STEP_METERS=40m`/tick.
- **Charging state machine** is separate from and higher-priority than task navigation. A `TASK_ASSIGN` arriving while charging is accepted immediately if battery ≥ `CHARGING_INTERRUPT_BATTERY` (now imported from the shared `Backend/src/config/dtaro.constants.js`, `30`%), otherwise deferred and auto-resumed once charging completes.
- **Obstacle simulation** — small per-tick probability (`OBSTACLE_PROBABILITY=0.002`, ≈once per ~15 min of continuous driving) emits a synthetic `OBSTACLE_REPORT`.
- **Reroute handling** — full replacement path (preferred) or a local skip-ahead heuristic for the older obstacle-location-only payload shape.

**The battery-threshold split is now a documented, centralized design choice, not an accidental inconsistency**: `robotValidator.service.js` (server-side eligibility, `BATTERY_THRESHOLD=20`) and `simulation/constants.js` (client-side charge-interrupt refusal, `CHARGING_INTERRUPT_BATTERY=30`) both import from the same `Backend/src/config/dtaro.constants.js` module. The two values remain deliberately distinct (20% floor for general eligibility, 30% floor for interrupting an in-progress charge cycle) rather than being collapsed to one number — but they can no longer silently drift independently, since both are sourced from one file.

---

## 11. Obstacle Detection & Rerouting (EKB)

"EKB" = Environmental Knowledge Base — the obstacle-tracking layer (`ekb.service.js`, Redis-primary with TTL auto-expiry, Postgres `ObstacleEvent` secondary). Unchanged from prior behavior:

1. Determine which `Zone` (if any) contains the obstacle (3-tier cached bounding-box lookup).
2. Store the obstacle (Redis primary, Postgres secondary, in-memory fallback if Redis is down).
3. Broadcast `ALERT_CREATED` to `dashboard` — pops `DecisionRequiredModal` with a 60s countdown.
4. Load every tracked robot's live state + `plannedPath`.
5. Model the obstacle as a ~22m line segment; run a parametric line-segment intersection test against every robot's planned path.
6. For every affected robot: emit `REROUTE_ALERT` to `robot:{robotId}` and a dashboard copy, then run automatic server-side path replanning (`routing.service.js:rerouteRobot`) — fully automatic, independent of operator action.
7. Replanning tries a custom A* search over the existing route's waypoints first (K=6 nearest-neighbor graph, waypoints within 30m of the obstacle marked blocked); falls back to a fresh Mapbox Directions call if A* can't find a path.

**By the time an operator sees `DecisionRequiredModal`, the backend has already rerouted every affected robot.** The modal's choices remain cosmetic on the server side: WAIT re-shows the same popup via a client `setTimeout` (no server interaction); REROUTE calls the real reroute endpoint a second time (redundant with the automatic reroute that already ran); CANCEL only clears local modal state — the code contains an explicit comment stating the robot continues on its current route unchanged. No `Decision` row is ever written (§16).

---

## 12. Authentication & Authorization

### Human (operator) auth

- **Login**: email+password (`bcrypt.compare`) or Google OAuth (verifies ID token audience against `GOOGLE_CLIENT_ID`, requires `email_verified`). Both issue the same JWT (`{id, role}`, 7-day expiry) in an HttpOnly cookie.
- **Google merge**: a Google sign-in never creates a new account — it only succeeds if a `User` row with that verified email already exists, linking `googleId` to it.
- **`authUser` middleware** (`middlewares/auth_middleware.js`): reads the JWT from cookie or `Authorization: Bearer` header, verifies it, validates the `id` claim looks like a UUID, fetches the user from Postgres, attaches `req.user`. **Applied via `router.use(authUser)` to every operational route file**: `robots.routes.js`, `tasks.routes.js`, `locations.routes.js`, `campuses.routes.js`, `simulator.routes.js`. `auth.routes.js` gates individual routes (`/me`, `/change-password`, `/pin-auth`, all `/webauthn/*`), leaving `/login`/`/google`/`/logout` public as required.
- **`verifyUserToken(token)`** — a new shared verification function extracted into `auth_middleware.js`, reused by both `authUser` (HTTP) and `socket.server.js`'s dashboard-room gate (Socket.IO) — the same JWT check now protects both transports.

### Step-up authorization (PIN and Passkey/WebAuthn)

Both step-up mechanisms are now **real, server-verified controls**:

- **PIN**: `AdminPinAuth`, bcrypt-hashed, legacy-plaintext auto-migration via `crypto.timingSafeEqual`. `POST /api/auth/pin-auth` requires the JWT middleware first (a step-up check on an authenticated session). The verification logic is now factored into an exported `verifyUserPin(prisma, userId, pin)` in `auth_controller.js`, reused by both the PIN route and WebAuthn registration's defense-in-depth re-check (below).
- **Passkey/WebAuthn**: real, end-to-end, server-verified — this is a change from the prior implementation, which was entirely client-side.
  - Registration (`ProfilePage.jsx` → `POST /api/auth/webauthn/register-options` → `POST /api/auth/webauthn/register`): the backend (`webauthn_controller.js`, using `@simplewebauthn/server`) issues a real challenge, stores it in Redis (`webauthn:regChallenge:{userId}`, 300s TTL), and requires the operator's PIN to be re-verified server-side before persisting a new credential (defense-in-depth — a stolen session cookie alone cannot mint a new authenticator). On a valid `verifyRegistrationResponse()`, the public key, credential ID, and initial counter are persisted to the new `WebAuthnCredential` table.
  - Authentication/step-up (`AuthChallengeModal.jsx` → `POST /api/auth/webauthn/auth-options` → `POST /api/auth/webauthn/verify`): the backend issues a fresh server-generated challenge, the frontend calls `@simplewebauthn/browser`'s `startAuthentication()`, and the backend calls `verifyAuthenticationResponse()` against the stored public key — a destructive action only proceeds if this call reports `verified: true`.
  - **Replay/clone protection**: the stored signature counter must strictly advance on each successful authentication (`newCounter > previousCounter`, with a documented exception only when both are exactly `0`, since some authenticators never implement a counter, which is spec-legal) — a non-advancing counter is rejected outright as a possible cloned authenticator.
  - The RP ID / expected origin are derived from the request's `Origin` header, checked against the same CORS allowlist `authUser` trusts. A **missing** Origin header is rejected outright for WebAuthn endpoints — the same behavior `isOriginAllowed` itself now enforces generally (§16).

### Robot auth

Unchanged: session-token (post-pairing) or one-time 6-digit pairing code, both over Socket.IO `AUTH`. Pairing brute-force is now actually enforced — see §8's `AUTH` row and §7's `pairingLocked:{robotId}` key.

### Current REST authentication coverage

Every operational REST route file (`robots.routes.js`, `tasks.routes.js`, `locations.routes.js`, `campuses.routes.js`, `simulator.routes.js`) is confirmed to apply `authUser` router-wide. Combined with the Socket.IO dashboard-room JWT gate (§8), there is no longer a REST or Socket.IO surface reachable without a valid admin session — the "anyone who can reach the port can commission/delete robots, assign/cancel tasks, and send fleet-wide STOP" gap described in earlier reviews of this system is closed.

`Backend/src/config/cors.js:isOriginAllowed()` now denies requests carrying no `Origin` header at all (F29/F2, closed) — non-browser callers (robot Socket.IO connections, curl/server-to-server) never depended on the CORS response headers this function drives, so closing the bypass has no effect on their admission, which is independently gated by JWT/`authUser`/robot `AUTH` regardless. See §16.

---

## 13. Frontend Architecture

### State management

`Frontend/src/context/AppProvider.jsx` is the single source of truth for session, robots list, tasks list, events/audit log (in-memory, 6-entry cap), user preferences (`localStorage`, keyed by user ID), the "decision required" modal state, the "auth challenge" step-up modal state, and a `taskPathCacheRef`. Split into `AppStateContext`/`AppActionsContext` so action-only consumers don't re-render on every state change.

### The `requestAuth` step-up confirmation pattern

Every destructive/consequential action (`stopAll`, `commission`, `retire`, `createTask`, `cancelTask`, robot commands) is wrapped in `requestAuth(intent, action, isDestructive)`, surfacing `AuthChallengeModal`. The modal itself now performs real server verification for both PIN and Passkey paths (§12) — this is a meaningful change from the prior state, where only PIN was server-verified and Passkey was a client-side illusion of security. The wrapping pattern itself (whether the *frontend* calls the confirmation modal at all) remains a client-side UX convention, not a backend-enforced requirement — a direct API call to the same endpoint still doesn't require step-up token proof at the HTTP layer, only the underlying `authUser` session.

### Real-time sync

`AppProvider`'s socket `useEffect` subscribes to `robot:update`, `ROBOT_UPDATED`, `TASK_CREATED`, `TASK_UPDATED`, `TASK_ASSIGNED`, `ALERT_CREATED`, `REROUTE_ALERT`, folding every event into the global `robots`/`tasks` arrays. `socket.js` is a module-level singleton (reused across Vite HMR via a `globalThis` key) that now connects with `withCredentials: true` so the HttpOnly session cookie reaches the Socket.IO handshake — required for the dashboard-room JWT gate (§8) to succeed.

### Map (`features/maps/MapControl.jsx` + `mapControl/hooks/useRobotStream.js`)

Unchanged from prior behavior: custom DOM marker elements with a separate scale-wrapper child (to avoid fighting Mapbox's own per-frame `transform`), 4-layer route rendering per robot per leg (done/todo × pickup/drop, glow+casing+main), camera persistence via a module-level variable, zoom-proportional sizing with a `TRACKING_MIN_ZOOM=11` clamp, and non-geo-filtered robot display (filters only drive camera position, documented inline as deliberate).

Supporting collaborators, all unchanged: `MapProvider.jsx`/`mapContext.js` (ref-sharing only), `useMapController.js` (load-state + `flyTo` with a GSAP pulse), `useLocationFilters.js` (cascading dropdown state, `localStorage`-persisted valid-prefix filter chain).

### `LocationCombobox.tsx`

Unchanged: Mapbox Search Box API (`suggest`/`retrieve`), correct session-token billing model (one UUID per search interaction, rotated after selection), 350ms debounce with `AbortController` cancellation, proximity bias toward the seeded campus location.

### Layout shell & notifications

Unchanged: `AppSidebar.jsx`, `AppTopBar.jsx` (route titles via a separate lookup table from the router config — can drift if one is edited without the other), `NotificationsMenu.jsx` (same capped in-memory `events` array), `userPreferencesStorage.js` (user-ID-keyed `localStorage`, with a migration path from an older email-keyed scheme).

### Routing (`AppRouter.jsx`)

`/login` public, everything else behind `RequireAuth`. Route inventory confirmed unchanged: `/` (Dashboard), `/robots`, `/robots/:id`, `/commission`, `/map`, `/tasks`, `/profile`, plus a `/dashboard → /` back-compat redirect and a catch-all → `/`. Single `Layout` shell with sidebar/topbar/outlet and the three global modals (auth-challenge, create-task, decision-required), wired in `router/layout.jsx`.

### Dead frontend config — resolved

`Frontend/src/config/mapConfig.js` previously carried unused demo exports (`LOCATION_TREE`, `MAP_FLEET_ROBOTS`); these have been **deleted outright** — the file now exports only `MAP_STYLE`, which is genuinely used by `MapControl.jsx`.

---

## 14. Current Admin Dashboard

| Page | Route | What it shows/does |
|---|---|---|
| Dashboard | `/` | 4 metric cards (online/active robots, active/failed tasks), a battery-health pie chart + breakdown, a lowest-battery-first list, a live speed list. All client-computed from global `robots`/`tasks` arrays — no server-side aggregation endpoint. |
| Map | `/map` | Full-fleet live map with cascading Country→State→City→Area→Campus filters, animated markers with heading rotation, live route overlays with progress shading, obstacle-triggered reroute visualization, recenter control. |
| Robots | `/robots` | Card grid with search + status/battery filter chips, slide-in detail panel (STOP/PAUSE/RETURN, Retire), no bulk actions. |
| Robot Detail | `/robots/:id` | Single-robot deep view: battery/speed live state, unit info, command buttons. "Primary Vision" camera panel is a static placeholder — no camera stream integration exists. |
| Commission | `/commission` | Form to register a unit (ID, name, chassis type — collected but not persisted anywhere in the schema, Mapbox-searched initial zone). |
| Tasks | `/tasks` | Metric cards + task card grid with live ETA/remaining-distance, Create Task modal (Mapbox place search), Cancel action per task — marks the task `CANCELLED`, emits `STOP` to the robot's socket, and clears its Redis routing state (`taskPath`, `robotTaskState`, `robotTask`, registry assigned-task and planned-path), all gated on the robot's `currentTaskId` still pointing at that task. |
| Profile | `/profile` | Account settings, password/PIN change, and Passkey registration (now real server-verified WebAuthn, §12). |

**Still absent** relative to a "complete" admin dashboard: no audit-log page (the `Event` table accumulates real server-side data that nothing in the UI reads back), no user/role management (single hardcoded `SUPER_ADMIN`), no zone/campus management UI (zones only auto-seed, never editable), no DTARO cost-weight configuration UI, no historical analytics (Telemetry/Command/Event/allocation-metrics data accumulates with no chart/report reading it back), no obstacle history view, no fleet-degraded-state indicator (Redis/Mapbox health is exposed at `/health` but nothing in the frontend polls it), no bulk robot operations beyond the global "Emergency Stop."

---

## 15. Configuration & Environment Variables

No `.env.example` exists in either app — this table remains the only place every variable is documented together.

**Backend (`Backend/.env`, loaded by `src/config/env.js`):**

| Variable | Read in | Required? | Purpose |
|---|---|---|---|
| `DATABASE_URL` | `src/db/prisma.js` | Yes | Postgres connection string; `connect_timeout=30` patched on automatically if not already present. |
| `REDIS_URL` | `src/cache/kv.js` | No | Unset/empty → Redis disabled, in-memory fallback used from boot. |
| `REDIS_ENABLED` | `src/cache/kv.js` | No | `"false"` force-disables Redis even if `REDIS_URL` is set. |
| `REDIS_CONNECT_TIMEOUT_MS` | `src/cache/kv.js` | No | Default `5000`. |
| `PORT` | `server.js` | No | Default `3000`. |
| `HOST` | `server.js` | No | Default `0.0.0.0`. |
| `NODE_ENV` | `server.js`, `config/cors.js`, `config/logger.js`, `auth_controller.js` | No | Drives logger format, CORS localhost allowance, cookie `secure`/`sameSite` defaults. |
| `LOG_LEVEL` | `config/logger.js` | No | Default `info` in prod, `debug` otherwise. |
| `FRONTEND_URL` | `config/cors.js` | Yes in production | Only non-localhost CORS allowlist entry; also the basis for WebAuthn's RP ID/origin resolution. |
| `JWT_SECRET` | `auth_controller.js`, `auth_middleware.js` | Yes | Signs/verifies the 7-day admin session JWT. Unset → login/`me`/`change-password`/WebAuthn all fail closed with `500`. |
| `GOOGLE_CLIENT_ID` | `auth_controller.js` | Only if Google login used | Verifies Google ID token audience. |
| `COOKIE_SECURE` | `auth_controller.js` | No | Overrides `secure` cookie flag; defaults to `NODE_ENV==="production"`. |
| `COOKIE_SAMESITE` | `auth_controller.js` | No | Defaults `"lax"`. |
| `SEED_ADMIN_EMAIL` / `ADMIN_EMAIL` | `adminBootstrap.service.js` | No | Idempotent bootstrap `SUPER_ADMIN` upsert target. |
| `SEED_ADMIN_PASSWORD` / `ADMIN_PASSWORD` | `adminBootstrap.service.js` | No | Paired with the email var above. |
| `SEED_ADMIN_PIN` | `prisma/seed-pin.js` | Yes, to run that script | 4-10 digit PIN. Script exits non-zero if unset, empty, or malformed — no hardcoded fallback exists. |
| `LOG_PII` | `adminBootstrap.service.js` | No | `"true"` logs the bootstrap admin's email; otherwise redacted. |
| `MAPBOX_TOKEN` / `MAPBOX_ACCESS_TOKEN` | `mapbox.service.js` | Yes | Routing/allocation breaks without it; every Directions/Matrix call throws `503` if neither is set. |
| `SOCKET_BUFFER_LIMIT_BYTES` | `telemetry.handler.js` | No | Default `1_000_000` — backpressure threshold. |

**Frontend (`Frontend/.env`, `VITE_`-prefixed, baked in at build time):**

| Variable | Read in | Required? | Purpose |
|---|---|---|---|
| `VITE_API_URL` | every `lib/api/*.js` | No | Default `http://localhost:3000`. |
| `VITE_SOCKET_URL` | `lib/socket.js` | No | Default `http://localhost:3000`. |
| `VITE_SOCKET_GLOBAL_KEY` | `lib/socket.js` | No | Default `__robotx_socket__`. |
| `VITE_MAPBOX_TOKEN` | `MapControl.jsx`, `LocationCombobox.tsx` | Yes | Map tiles + Search Box API, called directly from the browser. |
| `VITE_GOOGLE_CLIENT_ID` | `RobotXApp.jsx` | Only if Google login used | Passed to `GoogleOAuthProvider`. |

---

## 16. Known Limitations

Current, factual state — not a roadmap. See `PHASE1_VERIFICATION.md` for the full prioritized punch list with severities and recommendations.

**Scale — the binding constraints, in order**
- **Socket.IO state is process-local.** No `@socket.io/redis-adapter`, and `sockets/robotSockets.js` is an in-memory `Map` of `robotId → socket` consulted by `commandDispatcher`, `robots.controller`, `tasks.controller`, and `robotValidator`. A second process cannot dispatch a command to a robot connected to the first. This is a **topology** limit, not a throughput one: the system runs on exactly one process regardless of headroom.
- **`io.emit("robot:update", …)`** (`telemetry.handler.js`) broadcasts every telemetry frame to **every connected socket, robots included** — O(N²) message amplification. The lowest-effort/highest-return fix available in the system: scope it to the `dashboard` room.
- **Obstacle dissemination is O(fleet) per obstacle.** `alertDissemination.processObstacleReport` reads *every* robot ID from `robots:all` (a Set that is never pruned) and fetches each one's registry document — which contains the full planned-path geometry — then runs a linear segment-intersection test against each.
- One unconditional Postgres **read** per robot per telemetry tick (`prisma.robot.findUnique`) remains; it is now the dominant per-tick DB cost, the write side having been throttled.
- The telemetry handler remains fully sequential (no `Promise.all` pipelining of the independent reads/writes).
- Socket.IO rate limiting is a per-process in-memory `Map`, not Redis-backed.
- No circuit breaker or result cache around Mapbox in the allocation hot path — a degraded (not down) endpoint silently slows every assignment, and `getRoutesWithDistance` can issue up to 6 Directions calls per assignment across its profile fallbacks.
- `taskRecovery.recoverActiveTasks` has no bounded concurrency and runs *before* `server.listen()` — a restart with many active tasks issues that many sequential Mapbox calls before the process becomes healthy.

**Task lifecycle**
- The `Decision` table has full schema support (`reason`, `imageUrl`, `action`, `resolvedAt`) but zero writers anywhere in the service layer — the obstacle-decision UI is entirely client-side ephemeral state; WAIT and CANCEL have no server-side effect.
- Two independent command-retry mechanisms exist for "reliably deliver a command to a robot" — `commandDispatcher.service.js` (TASK_ASSIGN/REROUTE_ALERT) and `robots.controller.js:scheduleReliabilityCheck` (STOP/PAUSE/RETURN/RESUME) — documented as an intentional split via a code comment, but neither survives a process restart, and neither has restart-recovery parity with `taskRecovery.service.js`.
- **`PENDING` tasks are unrecoverable.** `assignTask` creates the row then does the real work in `setImmediate()`; a crash in that window strands the task permanently, because `taskRecovery` only queries `ASSIGNED`/`IN_PROGRESS`.
- No idempotency keys anywhere — a client retry of `POST /api/tasks/assign` creates a duplicate task.
- A legacy Socket.IO `assign_task` task-creation path remains registered in `socket.server.js:228`, parallel to and unused by the REST path the current frontend calls.

**Data model**
- `registry:{robotId}` and `robot:{robotId}` remain two independently-written Redis documents for the same robot's live state, with different TTLs (30s / 15s), different shapes, and different write semantics (merge / replace).
- `task:{taskId}` Redis key is written on every assignment/recovery and **read nowhere** (it is deleted on cancel, but never consulted). `robotTask:{robotId}` is written and cleaned up, but likewise never read for its value.
- Robot status is modeled in two incompatible vocabularies: the `RobotStatus` Prisma enum (6 values) and the wider set accepted from robots (8, including `RETURNING` and `CHARGING`), with a lossy mapping (`CHARGING → PAUSED`, `RETURNING → ACTIVE`). A genuinely paused robot and a charging robot are therefore **indistinguishable at the database layer**; every consumer must re-derive intent from Redis.
- `Robot.type`/chassis is collected on the Commission form and silently dropped — no corresponding schema column exists.
- `ObstacleEvent.expiresAt` is indexed but nothing sweeps expired rows; the Postgres table grows unbounded.
- No tenancy: the authorization model is `enum Role { SUPER_ADMIN }`. There is no organization, customer, or scoped-permission concept.

**Security**
- Debug scripts `check_password.js`/`check_users.js` have no `NODE_ENV` production guard and the latter still prints a 4-character password-hash prefix to stdout.
- Step-up authorization (PIN/Passkey) is enforced **client-side only** — `requestAuth` wraps destructive actions in the SPA, but a direct API call to the same endpoint requires only the session cookie. Both ceremonies are genuinely server-verified (§12); what is not enforced server-side is the *requirement* to have performed one.
- Dashboard-vs-robot socket classification is heuristic (`!!(origin || userAgent.includes("Mozilla"))`). A connection presenting neither is treated as a robot and skips the JWT gate — defensible today, since the robot `AUTH` event independently gates everything, but a fragile default.

**Testing**
- Coverage is ~43% overall and unevenly distributed. The **obstacle/reroute pipeline is effectively untested**: `routeIntersection` 4%, `routing.service` 8%, `ekb.service` 10%, `alertDissemination` 24%. That code is safety-adjacent and algorithmically the least trivial in the repository.
- `robots.controller.js` (0%) and all route files (0%) are untested.

**Operational**
- No Dockerfile/Compose anywhere in the repo.
- No CI — the test suite exists but nothing runs it automatically on push or PR.
- No `.env.example` in either app.
- **No load test, so the system's actual capacity ceiling has never been measured.** Every performance claim in this document is an estimate.
- The working tree carries three consecutive uncommitted change rounds.

---

## 17. Testing & Deployment

**Testing**: `jest` 30 + `supertest`, configured in `Backend/jest.config.js`. Run with `npm test` (`jest --runInBand --forceExit`) or `npm run test:coverage`. **17 suites, 137 tests, all passing.**

| Area | Suites | What is covered |
|---|---|---|
| `tests/unit/dtaro/` | costEvaluator, robotValidator, taskAssignment, reservationLocking, zoneLocality | The full allocation decision path: 5-term cost function, eligibility rules, candidate selection, reservation semantics, zone locality |
| `tests/unit/tasks/` | taskService, taskRecovery, tasksControllerCancel, dtaroHandlerTaskComplete | Assignment finalization, restart recovery, cancel-and-stop, completion |
| `tests/unit/telemetry/` | telemetryHandler, heartbeatDbWrites | Auth gating, status transitions, utilization EMA, both Postgres flush gates |
| `tests/unit/redis/` | kv, lockFailClosed | TTL semantics, `mget`, `incr`, reservation locking, fail-closed policy, reconnect signalling |
| `tests/unit/auth/` | authMiddleware, cors, webauthnController | JWT verification, origin policy, the WebAuthn ceremony incl. counter replay detection |
| `tests/integration/` | socketAuthGate | Dashboard socket JWT gate end-to-end |

**Coverage: ~42.9% lines overall**, deliberately concentrated rather than uniform. High where correctness is subtle and failure is expensive — `costEvaluator` 100%, `robotValidator` 100%, `telemetry.service` 100%, `auth_middleware` 100%, `taskRecovery` 97%, `taskAssignment` 92%, `webauthn_controller` 79%, `robotRegistry` 78%, `zoneManager` 70%. Near-zero on thin transport layers (all route files 0%, `robots.controller.js` 0%) — **and, less defensibly, on the obstacle/reroute pipeline** (`routeIntersection` 4%, `routing` 8%, `ekb` 10%), which is the most significant remaining gap (§16).

Two conventions worth preserving: `tests/helpers/testKv.js` drives the **real** `kv` facade in fallback mode rather than a hand-rolled double, so the tests exercise actual TTL/reservation/`mget` logic; and suites that touch module-level state (the flush gates, the zone cache) call `jest.resetModules()` in `beforeEach` so timing state cannot leak between cases.

**What the suite is for.** It is not a coverage target — it is a defect-detection tool, and it has already earned its place: on its first run against the existing codebase it surfaced three defects that two rounds of careful manual review had missed, one of which (the inert zone-locality term) manual review had affirmatively marked as *fixed*. See `PHASE1_VERIFICATION.md` §7.

**Deployment**: No containerization, no CI/CD configuration, and no documented deployment procedure exist in the repository. Running the system today means starting `Backend/server.js` (Node) and a Vite build (`Frontend/`) directly against a Postgres instance (Neon, based on the connect-timeout tuning in `db/prisma.js`) and a Redis instance, with every required environment variable (§15) supplied by hand since no `.env.example` exists to reference.

Note one deployment-relevant change: Redis is **optional only when it is explicitly disabled**. If `REDIS_URL` is set but the instance is unreachable, task allocation now fails closed rather than silently proceeding with a process-local lock (§7). A deployment that intends to run without Redis must say so explicitly (`REDIS_ENABLED=false` or no `REDIS_URL`) rather than relying on a failed connection to degrade gracefully.

**Graceful shutdown**: `server.js`'s `SIGINT`/`SIGTERM` handlers stop the simulator, drain the HTTP server, close Socket.IO, close the `kv` client, and disconnect Prisma, in sequence, with a catch-all that exits non-zero on failure — this remains correctly implemented and unchanged.

---

*This document reflects the working tree exactly as read during this audit. It carries no future roadmap and no historical implementation narrative by design — for prioritized next steps see `PHASE1_VERIFICATION.md` §6, and for the target architecture see `ARCHITECTURE_PROPOSAL.md`.*

*Re-verify before trusting this document if significant time has passed. The codebase has twice drifted materially within a single day of active development, and on both occasions the drift was invisible to careful reading — the behavioral sections here are now pinned by tests precisely because prose alone has repeatedly failed to stay true (`PHASE1_VERIFICATION.md` §7).*

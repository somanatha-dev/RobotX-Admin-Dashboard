# RobotX — Phase 1 Production-Readiness Review

> Companion to `system.md`. Scope: the same Node.js/Express/Prisma/PostgreSQL/Redis/Socket.IO monolith, reviewed against the **working tree** on `feature/dashboard` (commit `1d71a7d` + uncommitted changes), 2026-07-26.
>
> **Mandate**: harden the existing monolith. No microservices, no message brokers, no Kubernetes, no rewrite. Every recommendation below stays inside Node/Express/Prisma/Postgres/Redis/Socket.IO.
>
> **Method**: every finding below was checked against the actual current code (not just `system.md`'s narrative, which was written against an earlier commit and is now stale in places) — file contents, `git diff` against the last commit, and `schema.prisma` were all read directly. Findings are grouped under the 15 review areas requested, each in the format: Title / Severity / Location / Current implementation / Problem / Real-world impact / Recommended solution / Implementation steps / Files affected / Breaking changes / Estimated effort / Priority.

---

## 0. What changed since `system.md` was written (read this first)

The working tree already contains an **uncommitted cleanup pass** (30 files, +60/‑1080 lines) that resolves several items `system.md` flagged. Confirmed by diffing against `HEAD`:

**Already fixed / in progress — do not re-fix these:**
- ✅ `authUser` middleware now applied via `router.use(authUser)` on `campuses.routes.js`, `locations.routes.js`, `robots.routes.js`, `simulator.routes.js`, `tasks.routes.js` (system.md flaw #1, Tier 0 #1). `/api/auth/login` and `/api/auth/google` gained a 10/min rate limiter.
- ✅ `Backend/src/services/simulation.service.js` (the dead, never-started second simulation engine, system.md §9.1 / flaw #29) has been **deleted**.
- ✅ `Backend/src/utils/polylineDecode.js` (dead code, flaw #28) **deleted**.
- ✅ `Backend/robot.js` (the unauthenticated manual telemetry-spam script, flaw #26's live demonstration) **moved** to `Backend/scripts/manual_telemetry_test.js` — reduces accidental discoverability at the repo root, but **does not fix the underlying unauthenticated-telemetry-bind vulnerability it demonstrates** (see F26).
- ✅ `taskRecovery.service.js` no longer carries its own parallel `straightLineRoute`/`getRoutesWithFallback` implementation — it now imports and reuses `task.service.js:getRoutesWithDistance`, removing one of the two duplicate route-generation implementations `system.md` warned about.
- ✅ `robots.controller.js:deleteRobot` now also calls `virtualSimulator.removeRobot()`, so decommissioning a robot stops its `VirtualRobot` instance instead of leaving it running against a deleted DB row.
- ✅ `telemetry.handler.js`'s smart-snapshot call was fixed from `{ moveMeters: 10 }` to `{ moveDegreesThreshold: 10 / 111320 }` — the old key name didn't match `shouldStoreSnapshotSmart`'s actual parameter, so the move-distance throttle condition was silently a no-op before this fix (confirmed by reading `telemetry.service.js`'s signature).
- ✅ `Backend/package.json`'s `main` field fixed from a nonexistent `index.js` to `server.js`.
- ✅ ~10 files had genuinely dead exports removed (`selectMinCostRobot`, `filterEligibleRobots`, `getObstaclesByZone`, `removeObstacle`, `getAllRobotStates`, `updateETA`, `disconnectExisting`, `dispatchStop`/`dispatchReturnToBase`/`broadcastToRoom`, `astar`/`planRoute` exports, `loadZones`/`updateSocketZoneRoom` exports, `kv.exists`, `lerp`). **Verified**: a repo-wide grep confirms no remaining caller references any of them — this cleanup did not break anything discoverable.

**Confirmed still open (do not assume fixed):**
- ❌ `cors.js:isOriginAllowed()` still returns `true` unconditionally when no `Origin` header is present (flaw #2) — only the unused `getAllowedOrigins` export was trimmed, the bypass logic itself is untouched.
- ❌ Pairing brute-force (`robot.handler.js`) still only `log.warn`s at ≥5 attempts and never blocks (flaw #3).
- ❌ `ROBOT_FAULT` still has no code path that clears `healthStatus` back to `OK` (flaw #4) — still relies on the 30s registry TTL as an accidental reset.
- ❌ No Passkey/WebAuthn server-side verification exists anywhere in `Backend/` (flaw #25).
- ❌ `cancelTask` (`tasks.controller.js`) still only updates Postgres — confirmed by reading the current function body: no socket emit, no Redis key cleanup (flaw #13).
- ❌ No Docker/Compose files exist anywhere in the repo (checked).

This matters for prioritization: **Tier 0 item #1 (auth gating) is now ~90% done** — the remaining Tier 0 gap is narrower than `system.md` implies (see §9, F21).

---

## 1. Architecture Review

Current shape: a single Express + Socket.IO process; a service layer (`taskAssignment`, `costEvaluator`, `robotRegistry`, `robotValidator`, `zoneManager`, `ekb`, `alertDissemination`, `routing`, `commandDispatcher`) called from both HTTP controllers and socket handlers; `VirtualRobot` instances connect back into the same process as socket.io-client peers. This is the *correct* shape for the stated goal (robust monolith, not a rewrite) — the review below is about internal boundaries, not about breaking the process apart.

#### F1. Two independent, overlapping live-state stores for the same robot
- **Severity:** High
- **Location:** `Backend/src/services/robotRegistry.service.js` (`registry:{robotId}`) vs `Backend/src/sockets/handlers/telemetry.handler.js` + `Backend/src/controllers/robots.controller.js` (`robot:{robotId}`)
- **Current implementation:** Two Redis keys carry overlapping subsets of the same robot's live state (lat/lon/battery/status/speed), written by two independent code paths, with different TTLs (30s vs 15s) and non-overlapping extra fields (`distanceTravelled` only on one, `zoneId`/`plannedPath`/`utilization`/`healthStatus` only on the other).
- **Problem explanation:** There is no single function a new feature can call to get "the live state of a robot" — every consumer must know which key has which field, and the two can drift during partial write failures (one write succeeds, the sibling fails).
- **Real-world impact:** A robot can appear online with fresh position in one endpoint and stale/absent in another; a future engineer adding a field has a 50/50 chance of picking the "wrong" key and silently duplicating state again.
- **Recommended solution:** Collapse into one canonical `robot:{robotId}` document with every field DTARO, REST, and recovery code need; update `registry.service.js` to become the only writer/reader, with `telemetry.handler.js` and `robots.controller.js` calling through it instead of writing Redis directly.
- **Implementation steps:** 1) Union the field lists from both keys into one schema. 2) Point `telemetry.handler.js`'s per-tick Redis write at `robotRegistry.service.js:setRobotState`. 3) Update every reader (`taskAssignment`, `robots.controller.js` REST merge, `taskRecovery.service.js`) to read the one key. 4) Pick the shorter TTL (15s) since it's the safer staleness bound. 5) Delete the now-redundant key.
- **Files affected:** `robotRegistry.service.js`, `telemetry.handler.js`, `robots.controller.js`, `taskRecovery.service.js`, `taskAssignment.service.js`.
- **Breaking changes:** No (internal data shape only; no external API contract changes if field names are preserved in the merged document).
- **Estimated effort:** M (1–2 days, mostly careful field auditing + regression-testing every consumer by hand since there's no test suite yet — see §13).
- **Priority:** Tier 1

#### F2. Two independent command-retry mechanisms for the same concept
- **Severity:** Medium
- **Location:** `Backend/src/services/commandDispatcher.service.js:dispatch()` vs `Backend/src/controllers/robots.controller.js:sendRobotCommand` → `scheduleReliabilityCheck`
- **Current implementation:** `commandDispatcher.dispatch()` retries 2x with 1–2s in-memory backoff for `TASK_ASSIGN`/`REROUTE_ALERT`; `robots.controller.js` has its own, separate retry loop (`scheduleReliabilityCheck`, checks Postgres `Command.status` every 5s) for `STOP`/`PAUSE`/`RETURN`/`RESUME`. Both are pure `setTimeout` chains with no persistence.
- **Problem explanation:** Two policies (different intervals, different completion checks, different failure semantics) exist for "reliably deliver a command to a robot" — a future engineer fixing a bug in one won't know to check the other.
- **Real-world impact:** A restart mid-retry silently abandons either loop with no recovery (unlike task assignment, which does have restart-recovery via `taskRecovery.service.js`) — a `STOP` command issued right before a deploy can simply vanish.
- **Recommended solution:** Merge into one retry primitive inside `commandDispatcher.service.js` parameterized by (event name, ack source: Postgres `Command.status` vs none), used by both call sites.
- **Implementation steps:** 1) Extend `dispatch()` to accept an optional `ackCheck` callback + interval. 2) Migrate `sendRobotCommand`'s STOP/PAUSE/RETURN/RESUME calls onto it. 3) Delete `scheduleReliabilityCheck`.
- **Files affected:** `commandDispatcher.service.js`, `robots.controller.js`.
- **Breaking changes:** No.
- **Estimated effort:** S (0.5–1 day).
- **Priority:** Tier 2

#### F3. Two task-creation code paths (REST + legacy Socket.IO) still both live
- **Severity:** Low
- **Location:** `Backend/src/routes/tasks.routes.js` (`POST /api/tasks/assign`, used by the frontend) vs `Backend/src/sockets/socket.server.js` (`assign_task` → `task_assigned`/`task_error`, still registered)
- **Current implementation:** Both paths ultimately call `task.service.js:assignTask`, so they're not divergent in *logic*, but two event/route vocabularies exist for the same operation, and the legacy one is unused by any current client.
- **Problem explanation:** Dead surface area a security review or a future refactor has to reason about twice; the legacy path was not brought under the new `router.use(authUser)` gating pattern used for REST (Socket.IO auth is a separate concern — see §6 — but the *existence* of a second unauthenticated task-creation trigger widens the attack surface unnecessarily).
- **Real-world impact:** Low today (nothing calls it), but it's a live, reachable code path that bypasses the REST rate limiters (`task_assign` limiter in `tasks.routes.js`) entirely.
- **Recommended solution:** Remove the `assign_task`/`task_assigned`/`task_error` socket handlers once confirmed unused by any client build.
- **Implementation steps:** 1) Grep frontend bundle history for `assign_task` usage (already confirmed none in current `Frontend/`). 2) Delete the handler in `socket.server.js`. 3) Document the removal in `system.md`.
- **Files affected:** `socket.server.js`.
- **Breaking changes:** Potentially yes for any out-of-repo client still using the legacy event — confirm before deleting.
- **Estimated effort:** S (<1 hour).
- **Priority:** Tier 3.5

---

## 2. DTARO Review

`costEvaluator.service.js` computes `C(r) = 0.50·D + 0.30·(1−B) + 0.15·U + 0.05·T`. This is a clean, debuggable, deterministic design — the review below is about closing correctness gaps, not replacing the model.

#### F4. No allocation reservation — concurrent task assignment can starve a task instead of retrying
- **Severity:** Critical
- **Location:** `Backend/src/services/taskAssignment.service.js:selectNearestRobot`, `Backend/src/services/task.service.js:_processAssignment`
- **Current implementation:** Candidate selection reads a Postgres snapshot (`status IN (IDLE,PAUSED), isOnline, currentTaskId: null`), does 1–2 Mapbox HTTP round-trips, then commits inside a transaction that re-checks `currentTaskId IS NULL` at commit time.
- **Problem explanation:** Between snapshot and commit there is no claim/lock, so two tasks arriving close together can select the *same* robot. The transaction re-check prevents a double-assignment, but the losing request just throws — `_processAssignment` has no fallback to the second-best candidate.
- **Real-world impact:** Under any realistic multi-task-arrival load (which is the entire point of scaling to "hundreds or thousands of robots"), this directly costs completed deliveries — a task fails outright instead of falling through to the next-best idle robot, even when one exists.
- **Recommended solution:** Take a short-lived Redis reservation immediately after selection: `SET robotReserve:{robotId} {taskId} NX EX 30`. If the `SET NX` fails, the robot was just claimed by a concurrent request — retry `selectNearestRobot` excluding that robot against the remaining candidate pool (bounded to e.g. 2 retries) before failing the task. Release the reservation on commit success or transaction failure.
- **Implementation steps:** 1) Add `reserveRobot`/`releaseReservation` helpers to `kv.js` (atomic `SET NX EX`, plain `DEL`). 2) Wrap the `selectNearestRobot` → `_processAssignment` sequence in a retry loop that excludes already-tried/reserved robot IDs. 3) Release the reservation in both the transaction-commit success path and the catch block. 4) Add a metric for "assignment succeeded on retry N" to make the fix's effect measurable (ties into §14).
- **Files affected:** `kv.js`, `taskAssignment.service.js`, `task.service.js`.
- **Breaking changes:** No (internal allocation flow only; API contract unchanged).
- **Estimated effort:** M (1–2 days incl. manual concurrency testing — spin up N `VirtualRobot`s and fire concurrent `assignTask` calls).
- **Priority:** Tier 1 — highest-impact single fix in the whole allocation pipeline.

#### F5. Utilization term is dead weight (always 0) in the system that actually runs
- **Severity:** Medium
- **Location:** `Backend/src/services/robotRegistry.service.js:updateUtilization` (correctly implemented, never called from any live path); the one caller (`simulation.service.js`) was **deleted** in the uncommitted cleanup (see §0).
- **Current implementation:** `w3=0.15` of the cost function multiplies a value that is never written by anything the running system executes — `VirtualRobot`/`telemetry.handler.js` never call `updateUtilization`.
- **Problem explanation:** 15% of the intended allocation model is silently inert; the real formula in production is `≈0.50·D + 0.30·(1−B) + 0.05·T` renormalized. This was previously masked by `simulation.service.js` existing (even though unstarted) as a reference implementation to port from — that reference has now been deleted, so the EMA-based utilization logic (`α=0.05`, active=1/idle=0) needs to be re-derived or recovered from git history (`git show 3cc8e8b:Backend/src/services/simulation.service.js`) rather than copy-pasted from a live file.
- **Real-world impact:** Cost-function tuning today is effectively tuning a 3-term, not 4-term, weighted sum — anyone adjusting `w3` expecting an effect will observe none.
- **Recommended solution:** Call `updateUtilization(kv, robotId, isActive ? 1 : 0)` (EMA-smoothed, same `α=0.05` as the deleted reference) from `telemetry.handler.js`'s per-tick path, since that's the one place both real and virtual robots' status is already known every 2s.
- **Implementation steps:** 1) Recover the EMA formula from git history (`git show 3cc8e8b -- Backend/src/services/simulation.service.js`). 2) Add a one-line call in `telemetry.handler.js` after the status-transition step. 3) Verify `costEvaluator.service.js` picks it up (it already reads `U` from the registry document — no change needed there).
- **Files affected:** `telemetry.handler.js`.
- **Breaking changes:** No.
- **Estimated effort:** S (2–4 hours).
- **Priority:** Tier 1

#### F6. Zone locality has zero weight in allocation despite existing infrastructure
- **Severity:** Medium
- **Location:** `Backend/src/services/costEvaluator.service.js`
- **Current implementation:** `Zone`/`zoneId` is tracked per robot and per obstacle but never enters `C(r)`.
- **Problem explanation:** A robot on the far side of the service area can outrank a same-zone robot purely on haversine distance if Mapbox Matrix happens to be unavailable for that call (at which point `T` collapses to 0 for everyone and stops discriminating — see F7).
- **Real-world impact:** At fleet scale, cross-zone dispatch means longer real travel times than the model believes, and defeats the purpose of having zones at all beyond obstacle geofencing.
- **Recommended solution:** Add a same-zone bonus/penalty term, or a hard same-zone-first filter that only falls through to cross-zone candidates if none exist in-zone.
- **Implementation steps:** 1) Pass the pickup point's zone into `computeCosts`. 2) Add `Z(r) = 0` if same zone else `1`, weight `w5` (rebalance existing weights so they still sum to 1, or treat it as a tiebreaker rather than a 5th additive term to avoid re-tuning `w1..w4`). 3) Log the new term in `logger.dtaro()`'s existing breakdown output.
- **Files affected:** `costEvaluator.service.js`, `taskAssignment.service.js`.
- **Breaking changes:** No.
- **Estimated effort:** S–M (0.5–1 day).
- **Priority:** Tier 1

#### F7. Mapbox is a synchronous hard dependency in the allocation hot path with no circuit breaker
- **Severity:** Medium
- **Location:** `Backend/src/services/taskAssignment.service.js` (Matrix API), `Backend/src/services/task.service.js:_processAssignment` (Directions API ×2)
- **Current implementation:** Every task assignment makes 1 Matrix call (batched ≤24 origins) and up to 2 Directions calls (with driving→walking→cycling→straight-line fallback for routing itself). There is no cache, no circuit breaker, and no visibility into Mapbox latency/error rate in the metrics layer.
- **Problem explanation:** A slow (not fully down) Mapbox endpoint adds its full latency to every single task assignment serially, with no fast-fail; at fleet scale this multiplies directly into allocation latency.
- **Real-world impact:** A degraded (not down) Mapbox account/region can silently make every assignment slow without ever showing up as an "outage" in current logging.
- **Recommended solution:** Add a lightweight circuit breaker (e.g. a rolling error-rate counter in `kv.js`) around the Mapbox client that trips to "skip Matrix, use haversine-only ranking" after N consecutive failures/timeouts within a window, with a cooldown before re-probing — this is a single-process pattern, no external dependency needed.
- **Implementation steps:** 1) Add `mapboxCircuit:{status}` tracking to `kv.js` or a small in-process counter (single-process monolith, so in-memory is acceptable here unlike rate limiting which must scale). 2) Wrap `mapbox.service.js` calls with a fail-fast check. 3) Emit a `mapbox_degraded` flag into `getSystemMetrics()` (already surfaced at `/health`) for dashboard visibility (ties to §14/F44).
- **Files affected:** `mapbox.service.js`, `taskAssignment.service.js`, `task.service.js`, `metrics.service.js`.
- **Breaking changes:** No.
- **Estimated effort:** M (1 day).
- **Priority:** Tier 2

#### F8. Allocation metrics are written with `cost: null, latencyMs: null` — the store is inert
- **Severity:** Low
- **Location:** `Backend/src/services/task.service.js` (call site of `recordAllocation`), `Backend/src/services/metrics.service.js:recordAllocation`
- **Current implementation:** Confirmed still present — `recordAllocation` is called after every successful assignment but the actual computed `cost`/`components` from `selectNearestRobot()` are discarded before reaching the call.
- **Problem explanation:** The entire `metrics:allocation:*` Redis key space accumulates timestamped entries with no usable payload; nothing can be read back from it despite the plumbing existing end-to-end.
- **Real-world impact:** No historical visibility into allocation quality/latency trends without this fix — directly blocks the analytics view called for in §14 and `system.md` §16 item 6.
- **Recommended solution:** Thread `cost`, `components`, and measured `latencyMs` (wrap the `selectNearestRobot` call in a `Date.now()` delta) through to the `recordAllocation` call.
- **Implementation steps:** 1) Capture `t0 = Date.now()` before `selectNearestRobot`, compute `latencyMs = Date.now() - t0`. 2) Pass `{cost: result.cost, components: result.components, latencyMs}` into `recordAllocation`. 3) No schema change needed — the Redis value shape already supports these fields.
- **Files affected:** `task.service.js`.
- **Breaking changes:** No.
- **Estimated effort:** S (<2 hours).
- **Priority:** Tier 1 (cheap, unblocks observability work)

#### F9. Redundant per-candidate Redis reads in the allocation loop
- **Severity:** Low
- **Location:** `Backend/src/services/robotValidator.service.js:validateRobot` (calls `getRobotState` internally) + `Backend/src/services/taskAssignment.service.js` (calls `getRobotState` again for the same robot right after)
- **Current implementation:** Each candidate does ≥2 Redis round-trips where 1 would do; `kv.js` has a batched write helper (`setManyEx`) but no batched read.
- **Problem explanation:** At 100 candidates (the `maxRobots` cap), that's up to 200 sequential Redis round-trips per assignment call.
- **Real-world impact:** Adds tail latency to every assignment proportional to candidate pool size — compounds with F4's retry loop once that's added.
- **Recommended solution:** Add a `kv.mget(keys[])` helper (pipelined `MGET` via ioredis, sequential fallback for the in-memory mode) and fetch all candidate registry states in one call before validation.
- **Implementation steps:** 1) Extend `kv.js` with `mget`. 2) Refactor `taskAssignment.service.js`'s candidate loop to fetch once, pass the resolved state into `validateRobot` instead of having it re-fetch.
- **Files affected:** `kv.js`, `taskAssignment.service.js`, `robotValidator.service.js`.
- **Breaking changes:** No.
- **Estimated effort:** S (half a day).
- **Priority:** Tier 3

---

## 3. Telemetry Review

`telemetry.handler.js` runs on every 2s tick per connected robot and is the single busiest path in the backend (confirmed: 1 Postgres read, 1 Postgres write, 2 Redis writes, all `await`ed sequentially, per tick, per robot).

#### F10. Every telemetry tick writes to Postgres, not just Redis
- **Severity:** High (for the stated goal of "hundreds or thousands of robots")
- **Location:** `Backend/src/sockets/handlers/telemetry.handler.js`, step ~10 (`prisma.robot.update`)
- **Current implementation:** `lat/lon/battery/lastSeenAt/isOnline/status` are written to Postgres on **every** telemetry frame (every 2s per robot), independent of the "smart snapshot" throttle that already exists for the `Telemetry` history table.
- **Problem explanation:** The smart-snapshot throttle (§3, step 11) correctly limits *history* writes, but the *live* `Robot` row update has no equivalent throttle — it fires unconditionally every tick even though the same data is already fresher in Redis (`robot:{robotId}`/`registry:{robotId}`).
- **Real-world impact:** At N robots, this is `N/2` `UPDATE robot` statements per second purely to keep already-cached fields fresh. At a "hundreds of robots" fleet (say 500 active robots), that's 250 UPDATEs/sec sustained just from telemetry — before counting any other DB load. This is the single largest scalability risk identified in this entire review, because it's baked into the hottest path in the system.
- **Recommended solution:** Move `lat/lon/speed` off the per-tick Postgres write path entirely; keep `lastSeenAt`/`isOnline`/`status` writes (cheap, low-cardinality, needed for the offline-sweep and status-transition validation) but batch-flush position from Redis into Postgres on a periodic interval (e.g. every 10–15s via a single `updateMany`-style bulk statement, or per-robot but rate-limited to 1 write per N seconds regardless of tick frequency).
- **Implementation steps:** 1) Add a per-robot "last DB position flush" timestamp (reuse the existing `snapshotState:{robotId}` pattern or a new `dbFlushAt:{robotId}` key). 2) In the telemetry handler, only include `lat/lon/speed` in the `prisma.robot.update` call if the flush interval has elapsed; otherwise update only `lastSeenAt`. 3) Add a background interval (or extend the existing snapshot logic) that periodically bulk-syncs any position not yet flushed, so a robot that goes offline between flushes still has a reasonably fresh DB row. 4) Validate the offline-sweep (which reads `lastSeenAt`) still works correctly since that field is unaffected by this change.
- **Files affected:** `telemetry.handler.js`, possibly a new small `positionFlush.service.js`.
- **Breaking changes:** No (external API responses unaffected — `GET /api/robots` already merges Redis over the DB row per `system.md` §6, so callers keep seeing fresh data).
- **Estimated effort:** M (1–2 days incl. testing the offline-sweep interaction).
- **Priority:** Tier 3 (scale-readiness) — but move to Tier 1 if real robot counts are expected to exceed ~100 concurrent soon.

#### F11. Two separate Redis writes per tick for largely the same data
- **Severity:** Medium
- **Location:** `telemetry.handler.js` steps 9 and 12 (`robot:{robotId}` write, then `updateTelemetry` → `registry:{robotId}` write)
- **Current implementation:** Confirmed still present — this is the write-side manifestation of F1.
- **Problem explanation / impact:** Doubles Redis round-trips on the hottest path in the system for no functional benefit once F1 is resolved.
- **Recommended solution:** Resolved as a side effect of F1 — once there's one canonical live-state document, this becomes one write.
- **Implementation steps:** Covered by F1.
- **Files affected:** `telemetry.handler.js`.
- **Breaking changes:** No.
- **Estimated effort:** Included in F1's estimate.
- **Priority:** Tier 1 (bundle with F1)

#### F12. Telemetry pipeline is fully sequential per tick — no pipelining
- **Severity:** Low
- **Location:** `telemetry.handler.js`
- **Current implementation:** Every step (`await`) runs one after another: rate-limit check → zod parse → Postgres read → Redis read → Postgres write → Redis write → registry write → zone check.
- **Problem explanation:** Several of these are independent reads/writes that don't need to serialize (e.g., the Postgres read for status-transition validation doesn't block on the Redis merge read finishing first).
- **Real-world impact:** Adds avoidable per-tick latency; not currently a correctness bug, purely a throughput ceiling as fleet size grows.
- **Recommended solution:** Parallelize the independent reads with `Promise.all` (Postgres row fetch + Redis state fetch can run concurrently since neither depends on the other's result before the merge step).
- **Implementation steps:** 1) Identify the true dependency chain (parse → [DB read ‖ Redis read] → merge → validate → [DB write ‖ Redis write ‖ registry write] → zone check → emit). 2) Replace sequential `await`s with `Promise.all` where steps are independent.
- **Files affected:** `telemetry.handler.js`.
- **Breaking changes:** No.
- **Estimated effort:** S (half a day, careful review of ordering assumptions).
- **Priority:** Tier 3

---

## 4. Redis Review

`kv.js`'s multi-tier (Redis → in-memory fallback) design is a genuine strength (see §15 of `system.md`) — the findings below are about key hygiene and consistency, not the fallback architecture itself.

#### F13. Dead/write-only keys still seeded on every assignment
- **Severity:** Low
- **Location:** `task:{taskId}`, `robotTask:{robotId}` in `task.service.js` and `taskRecovery.service.js`
- **Current implementation:** Confirmed still written on every assign/recovery; no reader found anywhere in the current codebase (grepped — only `robotTaskState:{robotId}` is actually consulted for reroute/segment logic).
- **Problem explanation:** Every task assignment and every restart-recovery pass writes two Redis keys that nothing reads — pure overhead and a discoverability trap for future engineers who'll assume they matter.
- **Real-world impact:** Minor Redis memory/write overhead; larger risk is a future engineer building new logic against one of these dead keys and being confused when it "doesn't do anything."
- **Recommended solution:** Delete both write sites; if a future need for a robot→task index arises, expose it via the already-canonical `registry:{robotId}.assignedTaskId` field instead of a new key.
- **Implementation steps:** 1) Remove the `kv.set` calls for both keys in `task.service.js` and `taskRecovery.service.js`. 2) Grep once more immediately before merging to be certain no reader was missed.
- **Files affected:** `task.service.js`, `taskRecovery.service.js`.
- **Breaking changes:** No.
- **Estimated effort:** S (<1 hour).
- **Priority:** Tier 3.5

#### F14. No batched read primitive despite a batched write primitive existing
- **Severity:** Low
- **Location:** `Backend/src/cache/kv.js`
- **Current implementation:** `setManyEx` exists for pipelined writes; there's no `mget`/pipelined-read equivalent, so every place that needs N keys (candidate overlay in DTARO, `GET /api/robots*`) does `Promise.all` of individual `GET`s.
- **Problem explanation:** `Promise.all` of individual round-trips is not the same as a single pipelined command — each still pays full round-trip latency, just concurrently rather than serially; at high robot counts this is meaningfully worse than a true `MGET`.
- **Real-world impact:** Directly causes F9 and F17 (see below) — this is the root cause both findings point back to.
- **Recommended solution:** Add `kv.mget(keys)` backed by ioredis's native `mget`/pipeline, with a sequential fallback in the in-memory mode.
- **Implementation steps:** 1) Implement in `kv.js` alongside `setManyEx`. 2) Migrate the two known call sites (F9, F17).
- **Files affected:** `kv.js`.
- **Breaking changes:** No.
- **Estimated effort:** S (half a day, this one helper unblocks two other findings).
- **Priority:** Tier 1 (do this first — F9 and F17 both depend on it)

#### F15. Redis fallback never retries reconnecting to Redis once disabled
- **Severity:** Medium
- **Location:** `Backend/src/cache/kv.js:disableRedis()`
- **Current implementation:** `initRedis()` runs once at boot; if Redis becomes unreachable later, `disableRedis()` trips a flag and every subsequent call uses the in-memory `Map` fallback for the rest of the process's life — there is no background reconnect probe.
- **Problem explanation:** A transient Redis blip (restart, network hiccup, brief failover) permanently downgrades the process instead of recovering when Redis comes back — the only fix today is restarting the Node process.
- **Real-world impact:** Silent, indefinite degraded mode after any Redis hiccup, invisible except via `/health`'s `redis: "fail"` (nothing polls that automatically to alert an operator, and there's no dashboard indicator per `system.md` §16 item 8).
- **Recommended solution:** Add a background interval (e.g. every 30s while disabled) that attempts a lightweight `PING`/`SET+GET+DEL` against Redis, and flips `redisAvailable` back to `true` on success.
- **Implementation steps:** 1) Add a `setInterval` in `kv.js`, started only when `disableRedis()` fires. 2) On successful reconnect probe, clear the interval and log a recovery event. 3) Decide what happens to state written to the in-memory fallback during the outage window (acceptable to let it lapse — Redis is documented as an ephemeral cache, not source of truth — but document this explicitly).
- **Files affected:** `kv.js`.
- **Breaking changes:** No.
- **Estimated effort:** S–M (0.5–1 day).
- **Priority:** Tier 3

#### F16. Redis outage is invisible to the operator
- **Severity:** Medium
- **Location:** `kv.js`, frontend (no consumer)
- **Current implementation:** `/health` already reports `redis: "ok"|"fail"` (confirmed by reading `app.js`) and `getSystemMetrics()` is folded in — but nothing in the frontend polls or surfaces this.
- **Problem explanation:** The backend already exposes the signal; the gap is purely that no UI surfaces it, so an operator has no way to know DTARO is running with reduced precision (F1/F11's degraded-fidelity live-state) without reading server logs.
- **Real-world impact:** Operators can't distinguish "the fleet looks fine" from "the fleet looks fine because we're flying blind on live state."
- **Recommended solution:** Add a small polling call (`GET /health` every 30–60s) in the frontend's `AppProvider`, surfaced as a persistent banner/indicator when `redis !== "ok"` or `db !== "ok"`.
- **Implementation steps:** 1) Frontend: add a `useHealthPoll` hook. 2) Render a dismissible-but-recurring banner component when degraded. 3) No backend changes needed — the endpoint already exists.
- **Files affected:** `Frontend/src/context/AppProvider.jsx`, a new small component.
- **Breaking changes:** No.
- **Estimated effort:** S (half a day).
- **Priority:** Tier 4 (ties to `system.md` §16 item 8; low engineering cost, do opportunistically)

---

## 5. Database Review

Schema (`Backend/prisma/schema.prisma`) was read directly for this pass — indexing is already reasonably thorough (`Robot` has 7 indexes covering the hot query patterns; `Task`, `Event`, `Command`, `Telemetry`, `ObstacleEvent` all have sensible single/composite indexes for their known access patterns).

#### F17. `GET /api/robots`/`/api/robots/state` do per-row Redis `GET`s instead of one pipelined fetch
- **Severity:** Medium
- **Location:** `Backend/src/controllers/robots.controller.js`
- **Current implementation:** A `Promise.all` of individual `kv.get()` calls, one per robot row returned from Postgres, to overlay live state.
- **Problem explanation:** Same root cause as F9/F14 — N individual round-trips instead of 1 pipelined `MGET`.
- **Real-world impact:** Fine at current scale; becomes a visible endpoint-latency bottleneck once robot counts grow past a few hundred with a dashboard that refreshes/polls this endpoint.
- **Recommended solution:** Use the `kv.mget()` helper from F14 once implemented.
- **Implementation steps:** 1) Depend on F14 landing first. 2) Replace the `Promise.all` overlay loop with one `mget` call keyed by all robot IDs in the page.
- **Files affected:** `robots.controller.js`.
- **Breaking changes:** No.
- **Estimated effort:** S (a few hours, after F14).
- **Priority:** Tier 3

#### F18. `ObstacleEvent.expiresAt` is indexed but never swept
- **Severity:** Low
- **Location:** `schema.prisma` (`ObstacleEvent`), `ekb.service.js`
- **Current implementation:** The Postgres table has `@@index([expiresAt])` and an `expiresAt` column, but nothing in the reviewed service layer ever queries/deletes rows where `expiresAt < now()` — only the Redis TTL actually expires an obstacle from DTARO's perspective. The Postgres copy is a permanent, ever-growing audit log.
- **Problem explanation:** The index exists for a query pattern (sweep-by-expiry) that no code executes — it's dead indexing overhead, and separately, the table has no retention/archival policy at all.
- **Real-world impact:** Unbounded table growth over the life of a deployment; not urgent at current volumes, but worth deciding deliberately (keep forever for audit purposes vs. archive/prune) rather than by accident.
- **Recommended solution:** Either (a) add a periodic cleanup job that deletes/archives `ObstacleEvent` rows older than a retention window (e.g. 90 days) using the existing index, if audit retention isn't required indefinitely, or (b) explicitly document that this table is an intentional permanent audit log and the index is for a future "obstacle history" query (`system.md` §16 item 7), not a sweep.
- **Implementation steps:** If pruning: 1) Add a `setInterval` (daily) or a manual admin endpoint that runs `DELETE FROM "ObstacleEvent" WHERE "expiresAt" < now() - interval '90 days'`. 2) Document retention policy in `system.md`.
- **Files affected:** New small scheduled task, or `ekb.service.js`.
- **Breaking changes:** No.
- **Estimated effort:** S (a few hours either way).
- **Priority:** Tier 4

#### F19. `Decision` table has full schema support but zero writers
- **Severity:** Low (data-model), but blocks a real feature (§8/§16 item 9's "why did this fail" workflow depends on it existing)
- **Location:** `schema.prisma:Decision`, `Frontend/src/.../DecisionRequiredModal`
- **Current implementation:** Confirmed — no `prisma.decision.create` call exists anywhere in the current service layer. The whole "operator obstacle decision" concept described by the schema (`reason`, `imageUrl`, `action`, `resolvedAt`) is 100% client-side ephemeral state.
- **Problem explanation:** A real table, with real indexes, sits unused while the feature it models runs entirely as untracked React state — this is scoped fully in §8 (Task Lifecycle, F27) since fixing it requires backend + frontend coordination, not just a schema change.
- **Recommended solution / steps:** See F27.
- **Files affected:** See F27.
- **Breaking changes:** No.
- **Estimated effort:** See F27.
- **Priority:** Tier 2

#### F20. Cosmetic commission-time fields are collected but never persisted
- **Severity:** Low
- **Location:** `Frontend/src/pages/CommissionPage.jsx` (chassis "type" field), `Backend/src/services/robot.service.js:commissionRobot`
- **Current implementation:** The Commission form collects a chassis type (`Rover (Ground)` / `Drone (Aerial)`); the Prisma `Robot` model has no corresponding column, and the backend commission function never reads it.
- **Problem explanation:** Operators fill in a field that silently does nothing — a confusing but low-severity UX/data-integrity gap.
- **Real-world impact:** No functional break today (nothing reads `type` anywhere for filtering/display), but it's a trust issue: what else on that form doesn't actually save?
- **Recommended solution:** Either add a `type` column to `Robot` and thread it through `commissionRobot`, or remove the field from the form until it's meant to do something.
- **Implementation steps (if persisting):** 1) `prisma migrate dev` to add `type String?` to `Robot`. 2) Thread through `robot.service.js:commissionRobot` and `robots.controller.js`. 3) Surface it in the Robot Detail page.
- **Files affected:** `schema.prisma`, `robot.service.js`, `robots.controller.js`, `CommissionPage.jsx`.
- **Breaking changes:** No (additive column).
- **Estimated effort:** S (half a day).
- **Priority:** Tier 4

---

## 6. Socket.IO Review

#### F21. Most robot-facing security gaps are now narrower than `system.md` states, but two remain
- **Severity:** Critical (residual)
- **Location:** `Backend/src/config/cors.js:isOriginAllowed`
- **Current implementation:** Confirmed unchanged — `if (!origin) return true;` still executes before any allowlist check, meaning any non-browser HTTP/WebSocket client (curl, a script, a modified frontend build) bypasses the origin check entirely, for both the REST API *and* the Socket.IO handshake (`server.js` wires the same `isOriginAllowed` into `Server({cors: {origin: ...}})`).
- **Problem explanation:** Now that `authUser` gates most REST routes (§0), this specific gap matters most for Socket.IO, where there is no equivalent JWT-based gate for *dashboard* sockets (robot sockets have their own `AUTH` event, which is a separate and adequate mechanism) — a dashboard-room subscriber can connect from anywhere with no Origin header and receive every fleet-wide broadcast (`TASK_*`, `ROBOT_*`, `ALERT_CREATED`) with zero authentication.
- **Real-world impact:** Read-side fleet visibility (positions, battery, task assignments, obstacle alerts) is fully exposed to anyone who can reach the Socket.IO endpoint, regardless of the REST auth improvements already landed.
- **Recommended solution:** Require the same JWT (from the HttpOnly cookie, since Socket.IO's handshake carries cookies) to join the `dashboard` room — reject the join (or the whole connection) if the JWT is missing/invalid, mirroring `authUser`'s verification logic.
- **Implementation steps:** 1) Add a `socket.server.js` connection-time check: parse the JWT cookie from `socket.handshake.headers.cookie`, verify it the same way `auth_middleware.js` does, and only auto-join `dashboard` (or allow the connection at all, for browser-origin sockets) if valid. 2) Leave robot `AUTH` untouched — it already has its own equivalent gate. 3) Update the frontend's `socket.js` to confirm cookies are sent with the WebSocket handshake (`withCredentials`/cookie-based transport — verify current config).
- **Files affected:** `socket.server.js`, possibly `lib/socket.js` (frontend).
- **Breaking changes:** No for legitimate clients (browser already sends the cookie); yes for any out-of-repo dashboard client that doesn't authenticate — intended.
- **Estimated effort:** M (1 day incl. testing reconnect behavior).
- **Priority:** Tier 0 (this is now the highest-priority remaining item, given REST auth is largely closed)

#### F22. No `@socket.io/redis-adapter` — Socket.IO state is single-process only
- **Severity:** Medium (blocks horizontal scale-out, not current single-instance operation)
- **Location:** `socket.server.js`, `robotSockets.js` (plain in-process `Map`)
- **Current implementation:** Confirmed unchanged — the robot-socket registry and Socket.IO room state live entirely in one process's memory.
- **Problem explanation:** Running more than one Node instance (even for zero-downtime deploys via a second process) would silently break cross-instance delivery — a robot connected to instance A is invisible to a dashboard connected to instance B.
- **Real-world impact:** None today (single instance), but this is the single structural blocker to *any* future horizontal scaling within the "still a monolith" constraint (e.g. running 2 Node processes behind a load balancer for zero-downtime deploys, still not microservices).
- **Recommended solution:** Add `@socket.io/redis-adapter` (a Socket.IO ecosystem package, not a new architecture — it just uses the Redis you already run as a pub/sub backplane for room broadcast) before ever running more than one instance.
- **Implementation steps:** 1) `npm install @socket.io/redis-adapter`. 2) Wire it in `server.js` using the existing `ioredis` client already created by `kv.js`. 3) Move `robotSockets.js`'s registry to a Redis-backed lookup (robotId → instance ID + local socket, so targeted `robot:{robotId}` emits route through the adapter). 4) Test with 2 local instances behind a sticky/non-sticky reverse proxy.
- **Files affected:** `server.js`, `robotSockets.js`, `package.json`.
- **Breaking changes:** No (transparent to clients).
- **Estimated effort:** M (1–2 days, mostly testing).
- **Priority:** Tier 3 (do before actually running >1 instance; not urgent otherwise)

#### F23. In-memory Socket.IO rate limiter is per-process, same constraint as F22
- **Severity:** Low (today), Medium (once F22 is done)
- **Location:** `Backend/src/sockets/rateLimit.js`
- **Current implementation:** A single in-memory `Map` keyed by `socket.id + event`, with opportunistic eviction at 50,000 entries.
- **Problem explanation:** If F22 is implemented and a second instance is added, this rate limiter would need to move to Redis (`kv.incr` + `EXPIRE`, which `kv.js` already supports) to remain effective across instances — otherwise a client could get 2x its intended rate by load-balancing across instances.
- **Recommended solution:** Defer until F22 is actually acted on; when it is, migrate this alongside it using the existing `kv.incr` helper.
- **Implementation steps:** Tie to F22's rollout.
- **Files affected:** `rateLimit.js`.
- **Breaking changes:** No.
- **Estimated effort:** S (half a day, bundled with F22).
- **Priority:** Tier 3 (bundle with F22)

#### F24. Two naming schemes for "send a command to a robot"
- **Severity:** Low
- **Location:** `commandDispatcher.service.js` (`TASK_ASSIGN`/`REROUTE_ALERT`/`STOP`/`RETURN_TO_BASE`) vs `robots.controller.js` (generic `COMMAND` event, `{commandId, type}`)
- **Current implementation:** Confirmed still present — this is the event-naming half of F2's mechanism duplication.
- **Recommended solution:** Resolved as part of F2 — once retry logic is unified, standardize on one event vocabulary too (recommend keeping the specific event names, since `VirtualRobot` already expects them, and retiring the generic `COMMAND` wrapper).
- **Files affected:** Covered by F2.
- **Breaking changes:** Yes if any client depends on the generic `COMMAND` event shape — verify `VirtualRobot.js` handling before removing.
- **Estimated effort:** Included in F2.
- **Priority:** Tier 2 (bundle with F2)

---

## 7. Simulation Review

`VirtualRobot`/`SimulationEngine.js` remains the only running simulator (confirmed — the dead second engine is now deleted, see §0). This section is now much shorter than it would have been against the pre-cleanup snapshot.

#### F25. Battery-threshold mismatch between server validator and simulator, still unreconciled
- **Severity:** Low (currently masked by working deferred-resume logic)
- **Location:** `robotValidator.service.js` (`BATTERY_THRESHOLD`, allows charging-interrupt at ≥20%) vs `Backend/src/simulation/constants.js` (`CHARGING_INTERRUPT_BATTERY = 30`)
- **Current implementation:** Confirmed unchanged — two independent hardcoded thresholds for the same real-world concept ("how low can battery be before we don't interrupt charging").
- **Problem explanation:** Nothing is broken today because `VirtualRobot`'s deferred-resume mechanism absorbs the mismatch gracefully, but the two numbers disagreeing is a footgun for whoever tunes one without knowing the other exists — and once real robot firmware exists, this constant needs to be a contract, not two independent guesses.
- **Real-world impact:** Low now; becomes a real bug source the day a real robot's firmware hardcodes its own third value for the same concept.
- **Recommended solution:** Source both from one shared constant (e.g. a `config/dtaro.constants.js` module both the validator and simulator import), and document it as the value real robot firmware must also honor.
- **Implementation steps:** 1) Create the shared constant. 2) Import it in both `robotValidator.service.js` and `simulation/constants.js`. 3) Pick one value (recommend 20%, matching the server's — the simulator's 30% was more conservative but arbitrary).
- **Files affected:** `robotValidator.service.js`, `simulation/constants.js`, new shared config file.
- **Breaking changes:** No.
- **Estimated effort:** S (<1 hour).
- **Priority:** Tier 1 (cheap, closes a real inconsistency)

#### F26. Unauthenticated legacy telemetry-bind path still exists (script relocated, vulnerability not fixed)
- **Severity:** Critical
- **Location:** `Backend/src/sockets/handlers/telemetry.handler.js`
- **Current implementation:** A socket binds to whatever `robotId` its first valid `TELEMETRY`/`telemetry` payload names, with no `AUTH` required, as long as `session:{robotId}` doesn't yet exist in Redis (i.e., the robot has never been paired). `Backend/scripts/manual_telemetry_test.js` (renamed from `robot.js`, see §0) still demonstrates this working today, unchanged.
- **Problem explanation:** Any client that knows (or guesses/enumerates) a commissioned-but-unpaired robot ID can inject fabricated position/battery/status data for it, with zero authentication — this directly feeds DTARO's cost function (fake battery/position skews allocation) and the dashboard (fake telemetry shown to operators as real).
- **Real-world impact:** In a fleet of "hundreds or thousands of robots," the window where a robot is commissioned but not yet paired is a normal, frequent operational state (new units being onboarded) — this isn't an edge case, it's a routine state with an open door.
- **Recommended solution:** Require `AUTH` (session or pairing-code) to succeed before *any* `TELEMETRY` frame is accepted for a robot that has never established a session — drop the frame and emit `AUTH_REQUIRED` instead of binding on first-telemetry.
- **Implementation steps:** 1) In `telemetry.handler.js`, check `socket.data.isAuthed` (set by `robot.handler.js`'s `AUTH` success) before processing any `TELEMETRY`/`telemetry` frame — reject and emit `AUTH_REQUIRED` if absent, for *every* robot, not just ones with an existing session. 2) Update `VirtualRobot.js` (already does AUTH first, per `system.md` §9 — no change needed there) and confirm `manual_telemetry_test.js`'s behavior is intentionally left broken (it's a script that demonstrates the fixed vulnerability no longer working, which is correct).
- **Files affected:** `telemetry.handler.js`.
- **Breaking changes:** Yes for any client that currently relies on unauthenticated first-telemetry binding — this is the point.
- **Estimated effort:** S (a few hours; low complexity, high leverage).
- **Priority:** Tier 0 — this is arguably a higher-priority open item than F21 now, since the REST gate is mostly closed but this socket-level gap is completely untouched by the cleanup pass.

---

## 8. Task Lifecycle Review

#### F27. Cancelling a task doesn't stop the robot or clean up Redis state
- **Severity:** High
- **Location:** `Backend/src/controllers/tasks.controller.js:cancelTask`
- **Current implementation:** Confirmed by reading the current function — it only runs a Prisma transaction (`Task.status = CANCELLED`, frees `robot.currentTaskId`); no socket emit to the robot, no `taskPath:{taskId}`/`robotTaskState:{robotId}` Redis cleanup.
- **Problem explanation:** A physical or virtual robot mid-route has no idea its task was cancelled — it keeps driving toward the pickup/drop until it independently emits `TASK_COMPLETE` for a task the server no longer recognizes (undefined behavior downstream) or until an operator manually sends `STOP`.
- **Real-world impact:** Cancel is the one operator action explicitly meant to stop something, and it doesn't — this is a correctness gap an operator will discover the hard way in production (a robot visibly continuing to a cancelled destination).
- **Recommended solution:** On cancel: (1) emit `STOP` (or `RETURN_TO_BASE`, depending on desired behavior — recommend `STOP` since the destination is no longer valid) to the robot's socket via `commandDispatcher.dispatch`, (2) delete `taskPath:{taskId}` and `robotTaskState:{robotId}`.
- **Implementation steps:** 1) After the transaction commits, call `dispatch(robotId, "STOP", {reason: "task_cancelled"})`. 2) `kv.del("taskPath:"+taskId)`, `kv.del("robotTaskState:"+robotId)`. 3) Emit `TASK_UPDATED` (already happens — confirm the cancel path already does this; if not, add it) so the dashboard reflects the stop.
- **Files affected:** `tasks.controller.js`.
- **Breaking changes:** No.
- **Estimated effort:** S (half a day).
- **Priority:** Tier 2

#### F28. The Decision workflow is entirely cosmetic — no server-side effect for WAIT/CANCEL, and the `Decision` table is unused
- **Severity:** Medium
- **Location:** `Frontend/.../DecisionRequiredModal`, `schema.prisma:Decision`
- **Current implementation:** WAIT re-shows the same modal via a client `setTimeout`; CANCEL just dismisses the modal (does not call the real cancel endpoint, does not stop the robot); only REROUTE calls a real endpoint — and by the time the operator sees the modal, the backend has already auto-rerouted every affected robot (`alertDissemination.service.js`), so REROUTE is a redundant second reroute. No `prisma.decision.create` exists anywhere.
- **Problem explanation:** The schema models a real "operator obstacle-response audit trail" concept that is entirely unimplemented at the persistence layer — every obstacle-response decision an operator makes today leaves zero durable record.
- **Real-world impact:** No audit trail for "who decided what when an obstacle was hit" — a real compliance/operations gap for a fleet-management product, and a schema that misleads anyone reading it into thinking this is tracked.
- **Recommended solution:** Decide the intended semantics, then implement for real: WAIT → a server-side snooze marker (not a client timer) so the modal reappears even if the operator refreshes; CANCEL → actually call `POST /api/tasks/:taskId/cancel` (now meaningful once F27 lands); every resolution (WAIT/REROUTE/CANCEL) → `prisma.decision.create({reason, action, robotId, taskId, resolvedAt})`.
- **Implementation steps:** 1) Add `POST /api/obstacles/:obstacleId/decision` (or fold into the existing reroute endpoint) that writes a `Decision` row and performs the corresponding action. 2) Update `DecisionRequiredModal` to call this endpoint for all three actions instead of only REROUTE. 3) For WAIT, store a `snoozeUntil` somewhere server-reachable (Redis key with TTL is sufficient) instead of a pure client timer.
- **Files affected:** New route/controller, `DecisionRequiredModal.jsx`, depends on F27 for CANCEL to be meaningful.
- **Breaking changes:** No (additive).
- **Estimated effort:** M (1–2 days across backend + frontend).
- **Priority:** Tier 2

---

## 9. Security Review

This section supersedes `system.md` §14's security list with current-state verification (§0 already summarized the diff). Full attack-scenario detail below for what's still open.

#### F29. CORS bypass for no-Origin requests — see F21
Cross-referenced above; listed here for completeness of the security section. **Severity: Critical. Priority: Tier 0.**

#### F30. Unauthenticated telemetry injection — see F26
Cross-referenced above. **Severity: Critical. Priority: Tier 0.**

#### F31. Passkey step-up is not cryptographically verified by anything
- **Severity:** High
- **Location:** `Frontend/src/.../ProfilePage.jsx:FingerprintSection` (registration), `AuthChallengeModal.jsx:handlePasskeyAuth` (verification)
- **Attack scenario:** An operator's browser is compromised (XSS, malware, or a modified frontend build served from a MITM'd network). The attacker calls `navigator.credentials.get()` themselves (or simply patches `requestAuth` to always resolve `true`, since the assertion is never checked against anything server-side) and triggers any "Passkey-protected" destructive action — fleet-wide STOP, robot deletion, task cancellation — with no server ever verifying a real biometric ceremony occurred.
- **Current implementation:** Confirmed unchanged — registration discards the WebAuthn public key after generating it (only `cred.rawId` is kept, client-side, in `localStorage`); verification generates its own challenge in the browser and treats any truthy assertion as sufficient. No WebAuthn table/column/route exists in `Backend/`.
- **Impact:** Of the two step-up methods presented as equivalent in the UI, only PIN is real. An operator who believes "Passkey" is a security control is trusting something that provides zero server-verifiable guarantee.
- **Recommended solution:** Implement real server-side WebAuthn via `@simplewebauthn/server` (issue+store a server-generated challenge, persist the public key at registration, verify the signed assertion against it at authentication) — or remove the Passkey option entirely until it can be done properly. Do not ship a control that visually looks equivalent to PIN but isn't.
- **Implementation steps:** 1) Add `WebAuthnCredential` table (`userId`, `credentialId`, `publicKey`, `counter`). 2) Backend: `POST /api/auth/webauthn/register-options` → `POST /api/auth/webauthn/register` (store public key), `POST /api/auth/webauthn/auth-options` (server-issued challenge) → `POST /api/auth/webauthn/verify` (verify signature, check/update counter for replay protection). 3) Frontend: replace the client-only ceremony with calls to the new endpoints.
- **Files affected:** `schema.prisma`, new `webauthn.controller.js`/`webauthn.routes.js`, `ProfilePage.jsx`, `AuthChallengeModal.jsx`.
- **Breaking changes:** Yes — any existing client-only "registered" passkey becomes invalid and must be re-registered.
- **Estimated effort:** L (3–5 days for a correct implementation with a well-tested library) or S (<1 hour) to remove the option instead.
- **Priority:** Tier 0

#### F32. Pairing brute-force protection logs but never blocks
- **Severity:** Medium
- **Location:** `robot.handler.js` — confirmed unchanged, `recordPairingAttempt` still only triggers a `log.warn` at ≥5 attempts.
- **Attack scenario:** An attacker who knows a commissioned robot's ID can brute-force its 6-digit pairing code (1,000,000 combinations) with no rate-limit-driven lockout — only the 5/60s socket-level `AUTH` rate limiter (`allow(socket, "AUTH", {limit:5, windowMs:60_000})`) slows this down, and that resets per-socket, so reconnecting with a new socket resets the counter.
- **Impact:** Given enough reconnects, an attacker can eventually guess a valid pairing code and hijack a robot's identity before its legitimate first-time pairing completes.
- **Recommended solution:** Actually enforce a lockout: once `pairingAttempts:{robotId}` reaches the threshold, reject all further pairing attempts for that `robotId` until an operator manually resets it (or a longer cooldown elapses), independent of which socket is attempting.
- **Implementation steps:** 1) In `recordPairingAttempt`, when the counter hits the threshold, additionally set a `pairingLocked:{robotId}` key with a longer TTL (e.g. 1 hour). 2) Check that key at the top of the pairing-code branch and reject immediately (before even comparing codes) if locked. 3) Add an admin-only endpoint to clear the lock early if needed.
- **Files affected:** `robot.handler.js`.
- **Breaking changes:** No.
- **Estimated effort:** S (a few hours).
- **Priority:** Tier 1

#### F33. `ROBOT_FAULT` has no clear path — permanently (or accidentally-by-TTL) ineligible
- **Severity:** Medium
- **Location:** `dtaro.handler.js` (`ROBOT_FAULT` sets `healthStatus: FAULT`), no path anywhere clears it.
- **Attack/failure scenario:** Not an attack — an operational gap. A robot that reports one transient fault (e.g. a sensor hiccup) becomes permanently DTARO-ineligible until its registry key's 30s TTL happens to expire and repopulate as `OK` from the next telemetry tick — meaning the "reset" is an accidental side effect of TTL expiry, not a deliberate design.
- **Impact:** Depending on timing, a robot can either recover unintentionally within 30s (undermining the fault flag's purpose) or, if telemetry keeps refreshing the registry key before it TTLs with the fault status baked in, stay stuck — the actual behavior depends on write-ordering that isn't obviously intentional either way.
- **Recommended solution:** Make fault-clearing deliberate: add an explicit `POST /api/robots/:robotId/clear-fault` admin endpoint (or fold into the existing RESUME command) that sets `healthStatus: OK` and logs an `Event`, and make the registry write in `telemetry.handler.js` stop clobbering `healthStatus` on every tick (currently it likely gets overwritten by whatever the next `setRobotState` call passes — audit this specifically).
- **Implementation steps:** 1) Audit whether `updateTelemetry`'s `setRobotState` call includes/omits `healthStatus` on each tick (determines current actual behavior). 2) Add the clear-fault endpoint. 3) Ensure telemetry writes never silently reset `healthStatus` unless explicitly clearing it.
- **Files affected:** `robotRegistry.service.js`, `telemetry.handler.js`, new endpoint in `robots.controller.js`/`robots.routes.js`.
- **Breaking changes:** No.
- **Estimated effort:** S–M (half a day incl. the audit step).
- **Priority:** Tier 1

#### F34. Hardcoded default admin PIN committed to the repository
- **Severity:** High
- **Location:** `Backend/prisma/seed-pin.js`
- **Current implementation:** Confirmed unchanged — sets the literal PIN `931100` (bcrypt-hashed) on every `AdminPinAuth` row.
- **Attack scenario:** Anyone with read access to the repository (current or historical, including anyone who ever cloned it before a rotation) knows the PIN gating every `AuthChallengeModal`-protected destructive action, for any deployment where this script was ever run and the PIN never rotated per-account afterward.
- **Impact:** Combined with F31 (Passkey isn't real), the PIN path is the *only* real step-up control — a known default PIN defeats it entirely.
- **Recommended solution:** Remove the hardcoded literal; require a `SEED_ADMIN_PIN` env var with no fallback, or generate a random PIN at seed time and print it once (never store it in a script/file).
- **Implementation steps:** 1) Rewrite `seed-pin.js` to read from `process.env.SEED_ADMIN_PIN` and throw if unset (or `crypto.randomInt` a fresh PIN and log it once, forcing the operator to note and rotate it). 2) Rotate the PIN on any environment where this script has already run with the old literal.
- **Files affected:** `seed-pin.js`.
- **Breaking changes:** No (script behavior change only).
- **Estimated effort:** S (<1 hour).
- **Priority:** Tier 0

#### F35. Debug scripts have no safeguard against running against production `DATABASE_URL`
- **Severity:** Low
- **Location:** `Backend/scripts/check_password.js`, `Backend/scripts/check_users.js`
- **Current implementation:** Both read `.env` directly and operate on whatever `DATABASE_URL` resolves to, with no environment check; `check_users.js` prints the first 4 characters of password hashes to stdout.
- **Impact:** Low likelihood, but a debug script accidentally run with a production `.env` loaded (e.g. via a shared shell profile or CI misconfiguration) could leak information or be misused with no guardrail.
- **Recommended solution:** Add a `NODE_ENV !== 'production'` guard (refuse to run if production) to both scripts; stop printing even a hash prefix in `check_users.js`.
- **Implementation steps:** 1) Add the guard at the top of each script. 2) Remove the hash-prefix print.
- **Files affected:** `check_password.js`, `check_users.js`.
- **Breaking changes:** No.
- **Estimated effort:** S (<1 hour).
- **Priority:** Tier 3.5

---

## 10. Performance Review

Findings F9, F10, F12, F14, F17 (above) are the substantive performance findings for this codebase — cross-referenced here rather than duplicated. Two additional points:

#### F36. No caching of Mapbox Matrix/Directions results for repeated/similar queries
- **Severity:** Low
- **Location:** `mapbox.service.js`
- **Current implementation:** Every assignment recomputes Matrix/Directions from scratch, even if the same pickup point (or a nearby one) was just queried moments ago for a different task.
- **Problem explanation:** No caching layer exists for external API results at all.
- **Real-world impact:** Higher Mapbox API cost and latency than necessary at scale, especially for tasks clustered around common pickup hubs (e.g. a campus dining hall).
- **Recommended solution:** Add a short-TTL (30–60s) Redis cache keyed by rounded origin/destination coordinates for Matrix results specifically (Directions results are more task-specific and less cacheable, so lower priority).
- **Implementation steps:** 1) Round pickup coordinates to ~4 decimal places (≈11m precision) for a cache key. 2) Check `kv` before calling Mapbox Matrix; store result with a short TTL on miss.
- **Files affected:** `taskAssignment.service.js`, `mapbox.service.js`.
- **Breaking changes:** No.
- **Estimated effort:** S (half a day).
- **Priority:** Tier 3

#### F37. `logger.dtaro()`'s dev-mode console output does real formatting work on every allocation
- **Severity:** Low
- **Location:** `Backend/src/config/logger.js:rootLogger.dtaro`
- **Current implementation:** In non-production mode, every allocation call builds a full colorized, bar-chart-style multi-line string, even under heavy allocation load.
- **Problem explanation:** This is intentionally chatty for developer debugging (a genuine strength per `system.md` §15) but has no volume guard — unlike `logger.simulation()`, which already throttles to once per 10s per robot/status/phase.
- **Real-world impact:** Negligible at demo scale; worth a similar throttle if allocation volume ever becomes high even in a dev/staging environment.
- **Recommended solution:** Low priority — only worth doing if dev/staging environments start seeing high allocation throughput. Not a production concern since `isProd` already short-circuits to a single structured `pino` line.
- **Files affected:** `logger.js`.
- **Breaking changes:** No.
- **Estimated effort:** S.
- **Priority:** Tier 4

---

## 11. Reliability Review

#### F38. In-memory command retries don't survive a restart (unlike task assignment)
Cross-referenced from F2 — bundling the two retry mechanisms into one (F2) should also add restart-recovery parity with `taskRecovery.service.js`'s existing pattern (re-check `Command.status === "SENT"` rows on boot and re-dispatch, the same way active tasks are re-dispatched). **Severity: Medium. Priority: Tier 2 (bundle with F2).**

#### F39. No distinction between "Redis truly down" and "one slow request"
Cross-referenced from F15 — the same fix (background reconnect probe) should also add a short grace/retry window before tripping `disableRedis()` on a single slow call, rather than one timeout immediately downgrading the whole process. **Severity: Low. Priority: Tier 3 (bundle with F15).**

#### F40. Startup re-hydration has no upper bound on Mapbox load if many tasks are active at once
- **Severity:** Low
- **Location:** `server.js` startup sequence, `taskRecovery.service.js`
- **Current implementation:** On boot, every `ASSIGNED`/`IN_PROGRESS` task gets a fresh Mapbox route computed sequentially (implied by the current loop structure) — confirmed no explicit batching/concurrency limit in `recoverActiveTasks`.
- **Problem explanation:** At "hundreds or thousands of robots," a restart with hundreds of concurrently active tasks means hundreds of sequential Mapbox Directions calls before recovery completes, directly extending the restart-recovery window.
- **Real-world impact:** Longer time-to-recovery after any restart/deploy as fleet size grows — currently invisible because demo-scale fleets never hit this.
- **Recommended solution:** Batch the recovery loop with bounded concurrency (e.g. `p-limit`-style, 5–10 concurrent Mapbox calls) instead of fully sequential or fully unbounded-parallel.
- **Implementation steps:** 1) Add a small concurrency limiter around the per-task route-generation loop in `taskRecovery.service.js`. 2) Log total recovery time so this becomes measurable.
- **Files affected:** `taskRecovery.service.js`.
- **Breaking changes:** No.
- **Estimated effort:** S (half a day).
- **Priority:** Tier 3

---

## 12. Clean Code Review

#### F41. The uncommitted cleanup pass itself is a process risk worth naming explicitly
- **Severity:** Medium (process, not code)
- **Location:** Current working tree (30 files, +60/‑1080 lines, uncommitted)
- **Current implementation:** A large deletion-heavy refactor is sitting uncommitted with `Backend/package.json`'s `"test"` script still being `"echo ... && exit 1"` — i.e., this cleanup was verified by manual grep (which this review also did, independently, and found clean) but by **zero automated tests**.
- **Problem explanation:** Not a code defect — this specific pass checked out fine — but it demonstrates the actual production risk of continuing to work this way: the next 1000-line deletion pass might not be caught by a manual grep before it ships.
- **Real-world impact:** Directly motivates §13 (Testing Strategy) below — this isn't hypothetical, it's the exact kind of change that just happened in this repo.
- **Recommended solution:** Commit this cleanup (it's good work), then prioritize even a minimal smoke-test suite (§13) before the next large refactor pass.
- **Files affected:** N/A (process recommendation).
- **Breaking changes:** No.
- **Estimated effort:** N/A.
- **Priority:** Tier 1 (as motivation for §13)

#### F42. Remaining dead/confusing code after the cleanup
- **Severity:** Low
- **Location:** `Frontend/src/config/mapConfig.js` (`LOCATION_TREE`, `MAP_FLEET_ROBOTS` — confirmed still unreferenced anywhere per `system.md` §12.4, not touched by the backend-focused cleanup pass)
- **Recommended solution:** Delete both unused exports, keep only `MAP_STYLE` and `MAP_CENTER`/`MAP_ZOOM` if those are still used as defaults.
- **Files affected:** `mapConfig.js`.
- **Breaking changes:** No.
- **Estimated effort:** S (<1 hour).
- **Priority:** Tier 3.5

#### F43. No repo-level `.env.example`
- **Severity:** Low
- **Location:** Repo root / `Backend/`, `Frontend/`
- **Current implementation:** Confirmed absent — every environment variable is inferred from code (system.md §2.1 is currently the only place they're all documented together).
- **Recommended solution:** Add `Backend/.env.example` and `Frontend/.env.example` mirroring `system.md` §2.1's table, so onboarding doesn't require reading the whole system doc to find required variables.
- **Implementation steps:** Generate directly from the existing `system.md` §2.1 table — the research is already done.
- **Files affected:** New `.env.example` files.
- **Breaking changes:** No.
- **Estimated effort:** S (<1 hour).
- **Priority:** Tier 3.5

---

## 13. Testing Strategy (currently: none)

**Current state**: `Backend/package.json`'s `"test"` script is `"echo \"Error: no test specified\" && exit 1"` — confirmed unchanged. Zero automated tests exist anywhere in the repo for either app. Given F41 above, this is no longer a theoretical gap — it's the reason a 1080-line deletion pass had to be manually grep-verified instead of CI-verified.

A monolith this size doesn't need a heavyweight testing pyramid — it needs targeted coverage of the parts that are genuinely hard to get right by inspection: DTARO allocation correctness, concurrency, and restart recovery.

| Layer | What to cover | Why this, specifically | Suggested tools |
|---|---|---|---|
| **Unit** | `costEvaluator.service.js` (weight math, normalization edge cases: single candidate, all-equal candidates, null durations), `routeIntersection.service.js` (segment intersection math), `robotValidator.service.js` (every branch of the eligibility state machine), `distance.js` (haversine/bearing correctness) | Pure functions, no I/O, cheapest tests to write, and exactly the math a future weight-tuning or zone-locality change (F6) needs a safety net for. | `node:test` or `vitest` (no framework currently installed — either is a lightweight addition, not a new architecture) |
| **Integration** | `taskAssignment.service.js` + `task.service.js` against a real (test) Postgres + Redis — verify a full assign→dispatch→complete cycle updates all three stores (DB, `registry:*`, `robot:*`) consistently | This is where F1 (dual live-state stores) and F4 (allocation race) actually manifest — unit tests can't catch cross-store drift. | `node:test` + a disposable test Postgres schema (Prisma supports this well) + `ioredis-mock` or a real local Redis instance |
| **End-to-end** | Boot the real server + one real `VirtualRobot`, drive it through commission → auth → task assign → complete → cancel via HTTP + socket calls, assert on socket events received | Validates the actual wire protocol end-to-end, exactly the thing `system.md` credits `VirtualRobot` for exercising manually today — automate what's currently done by hand. | `socket.io-client` in the test itself, `supertest` for HTTP |
| **Load** | N concurrent `VirtualRobot`s (the existing simulator, just spun up in bulk) + M concurrent task-assign calls, measure allocation latency/success rate as N and M scale | Directly tests F4 (the allocation race) and F10 (telemetry write scaling) under realistic concurrency — the simulator already provides everything needed, no new load-gen tooling required. | A script reusing `SimulationEngine.js`'s existing `addRobot`, plus `autocannon` or a hand-rolled concurrent `fetch` loop against `/api/tasks/assign` |
| **Stress** | Push robot count well past any number tested informally today (e.g. 500–1000 `VirtualRobot`s) until something breaks (DB connection pool exhaustion, Redis memory, event-loop lag) | Establishes the actual current ceiling before "hundreds or thousands of robots" is attempted for real — right now that number is unknown. | Same tooling as Load, run against a staging-sized Postgres/Redis |
| **Chaos** | Kill Redis mid-run and verify `kv.js`'s fallback engages (and, once F15 lands, recovers); kill the Node process mid-task-assignment and verify `taskRecovery.service.js` picks it back up correctly | These are the exact resilience claims `system.md` §15 credits the system for — they should be continuously verified, not just believed. | Manual `docker stop redis` / `kill -9` scripts orchestrated from a test harness |
| **Recovery** | Full restart-recovery scenario: N active tasks, kill the server, restart, assert every task gets re-dispatched within the 5s grace window and no robot is left in a stuck state | This is the single most load-bearing piece of engineering in the whole system per `system.md` §15 — it deserves the most explicit test coverage of anything here. | Same as Chaos |
| **Simulator fidelity** | Assert `VirtualRobot`'s battery/speed/charging state machine matches its documented model (e.g. 100%→20% in exactly ~1 hour while ACTIVE, within tolerance) | The simulator *is* the test environment for everything else — if it silently drifts from its documented model, every other test's assumptions become unreliable. | Unit-level, fast-forwarding the tick loop rather than real-time waiting |
| **Allocation correctness** | Golden-file style tests: given a fixed set of candidate robots (positions/battery/status), assert the exact expected winner and cost breakdown | This is what makes future cost-function tuning (weights, F6's zone term, F5's utilization fix) safe to iterate on without regressing existing behavior. | `node:test`, fixtures checked into the repo |

**Recommended sequencing**: unit tests for `costEvaluator`/`routeIntersection` first (cheapest, unblocks safe iteration on F5/F6/F8 above), then the recovery/chaos tests (protects the system's best-already-built feature), then load/stress (answers the open "how many robots can this actually take" question the whole Phase 1 mandate is implicitly asking).

**Estimated effort for a minimally credible baseline** (unit + integration for DTARO, one E2E happy-path, one recovery test): ~1–2 weeks for one engineer, and it should happen *before* F1/F4/F6 (the DTARO changes) land, so those changes have a regression net from day one.

---

## 14. Observability

**Current state, verified**: `pino`-based structured JSON logging in production (`logger.js`) is already solid — redaction of sensitive fields (`password`/`token`/`secret`/`pin`/etc.) is built in, and domain-specific formatters (`logger.dtaro`, `logger.simulation`, `logger.obstacle`) already produce genuinely useful structured events. `/health` already exists and already folds in `getSystemMetrics()`. This is a better starting point than most projects at this stage — the gap is entirely in *using* what's already logged/exposed.

#### F44. Allocation/telemetry metrics exist in the data model but are inert or unread
Cross-referenced: F8 (allocation metrics written with null cost/latency) and `metrics:allocation:*`/`cmd:rt:*` (write-only Redis keys, confirmed no reader anywhere) are the concrete blockers. Fixing F8 is the prerequisite for anything else in this section.

#### F45. No `/metrics` endpoint in a scrape-friendly format
- **Severity:** Low
- **Location:** `app.js` (only `/health` exists)
- **Recommended solution:** Once F8 is fixed and allocation metrics are real, add a `/metrics` endpoint (plain JSON is fine — this is a monolith, not a Prometheus-instrumented microservice fleet, so a hand-rolled aggregation endpoint reusing `getSystemMetrics()` plus allocation stats is proportionate; a full `prom-client` integration is optional, not required, for this phase).
- **Implementation steps:** 1) Extend `metrics.service.js:getSystemMetrics` to read back the now-populated `metrics:allocation:*` keys (count, p50/p95 latency, cost distribution over the last N minutes). 2) Expose at `/metrics` or fold into `/health`.
- **Files affected:** `metrics.service.js`, `app.js`.
- **Breaking changes:** No.
- **Estimated effort:** S–M (1 day, after F8).
- **Priority:** Tier 4

#### F46. No dashboard-side surfacing of degraded state
Cross-referenced from F16 — same fix, listed here because it's as much an observability gap as a Redis-review one.

---

## 15. Production Readiness

#### F47. No Dockerfile/Compose anywhere in the repo
- **Severity:** Medium
- **Location:** Repo root, `Backend/`, `Frontend/` (checked — none exist; the only `Dockerfile` in the tree is inside `node_modules/bcrypt`, irrelevant)
- **Problem explanation:** Deployment today is implicitly "run `node server.js` somewhere with the right env vars" — there's no reproducible build artifact.
- **Recommended solution:** Add a single-stage `Backend/Dockerfile` (Node base image, `npm ci`, `prisma generate`, `CMD node server.js`) and a `docker-compose.yml` for local dev (Postgres + Redis + backend), matching the existing local-first, single-process philosophy — explicitly not adding orchestration beyond Compose, per the Phase 1 mandate.
- **Implementation steps:** 1) Write `Backend/Dockerfile`. 2) Write root `docker-compose.yml` with `postgres:16`, `redis:7`, and the backend service, wired to `.env`. 3) Document the `prisma migrate deploy` step as part of container startup or a documented pre-deploy step.
- **Files affected:** New `Dockerfile`, `docker-compose.yml`.
- **Breaking changes:** No.
- **Estimated effort:** M (1 day).
- **Priority:** Tier 4

#### F48. Graceful shutdown is already well-implemented — verify it stays that way
- **Severity:** N/A (positive finding, not a flaw)
- **Location:** `server.js:shutdown()`
- **Current implementation:** Confirmed — `SIGINT`/`SIGTERM` handlers stop the simulator, drain the HTTP server, close Socket.IO, close the `kv` client, and disconnect Prisma, in a sensible order, with a catch-all that exits non-zero on failure.
- **Recommendation:** No change needed. Flagging explicitly so future refactors (e.g. F22's redis-adapter work) don't regress this — add the adapter's own cleanup to the same `shutdown()` sequence when it's added.
- **Priority:** N/A (preserve, don't fix)

#### F49. No documented backup/migration-rollback strategy
- **Severity:** Low
- **Location:** N/A (operational gap, not code)
- **Problem explanation:** Prisma migrations are checked in and applied forward, but there's no documented Postgres backup cadence or a tested rollback procedure for a bad migration.
- **Recommended solution:** Document (in `system.md` or a new `RUNBOOK.md`) the backup provider's (e.g. Neon, per `system.md`'s mention of Neon cold-start tuning) point-in-time-restore capability and a manual rollback procedure (`prisma migrate resolve` + restoring the prior schema) — this is documentation, not code, given the current hosting setup.
- **Estimated effort:** S (half a day of writing).
- **Priority:** Tier 4

#### F50. Secrets management is env-var-only, consistent with a single-instance monolith — one gap
- **Severity:** Low
- **Location:** F34 (hardcoded seed PIN) is the one real secret-in-repo issue; otherwise `JWT_SECRET`/`MAPBOX_TOKEN`/`DATABASE_URL`/`GOOGLE_CLIENT_ID` are all correctly sourced from env vars with sensible fail-closed behavior (`JWT_SECRET` unset → 500, not a silent bypass).
- **Recommended solution:** No architectural change needed (a secrets manager/vault would be disproportionate for this phase) — just close F34 and add the `.env.example` from F43 so required secrets are discoverable without reading source.
- **Priority:** Tier 0 (via F34) / Tier 3.5 (via F43)

---

## Consolidated Priority Roadmap

Reconciles this review's findings with `system.md` §17's existing tiers, updated for what's already done (§0).

**Tier 0 — security, before anything else:**
1. F26 — require AUTH before accepting any TELEMETRY frame (closes the still-live unauthenticated-telemetry-injection path).
2. F21 — gate the Socket.IO `dashboard` room behind the same JWT used for REST (the CORS no-Origin bypass, F29/F2 in `system.md` terms, now matters most here since REST is largely gated).
3. F31 — implement real server-side WebAuthn, or remove the Passkey option.
4. F34 — remove the hardcoded seed PIN; rotate it on any environment where it was ever applied.
5. ~~Apply `authUser` to REST routes~~ — **done** (§0).

**Tier 1 — allocation correctness + cheap high-value fixes:**
6. F4 — Redis reservation lock + retry-against-next-candidate (the single highest-impact allocation fix).
7. F14 — add `kv.mget` (unblocks F9/F17).
8. F5 — restore utilization tracking (recover EMA logic from git history before it's forgotten).
9. F6 — zone-locality term in the cost function.
10. F8 — fix `recordAllocation` to carry real cost/latency (cheap, unblocks §14).
11. F25 — reconcile the two battery-interrupt thresholds.
12. F32 — actually lock out pairing brute-force attempts.
13. F33 — add a deliberate fault-clear path.
14. F41 — commit the current cleanup pass; start §13's test baseline before further large refactors.

**Tier 2 — lifecycle correctness:**
15. F27 — cancel actually stops the robot + clears Redis state.
16. F28 — implement the Decision workflow for real (write `Decision` rows).
17. F1 — collapse the two live-state Redis stores into one.
18. F2/F24/F38 — unify the two command-retry/naming mechanisms, add restart-recovery parity.

**Tier 3 — scale-readiness:**
19. F10 — stop writing `lat/lon` to Postgres on every telemetry tick.
20. F22/F23 — `@socket.io/redis-adapter` + move rate-limiting to Redis, before ever running >1 instance.
21. F15/F39 — Redis reconnect-retry loop with proper down-vs-slow distinction.
22. F9/F17 — batch candidate/dashboard Redis reads via F14's `mget`.
23. F7 — Mapbox circuit breaker.
24. F40 — bound concurrency in startup task-recovery.

**Tier 3.5 — housekeeping (cheap, opportunistic):**
25. F13 — delete dead `task:{taskId}`/`robotTask:{robotId}` keys.
26. F3 — remove the legacy `assign_task` socket path once confirmed unused.
27. F42/F43 — delete dead frontend config; add `.env.example`.
28. F35 — guard debug scripts against production `DATABASE_URL`.

**Tier 4 — completeness, once the above are solid:**
29. F16/F46 — surface degraded-mode state in the dashboard.
30. F18 — decide + implement `ObstacleEvent` retention policy.
31. F20 — persist or remove the cosmetic chassis-type field.
32. F45 — a real `/metrics` endpoint once F8 makes the data meaningful.
33. F47 — Dockerfile + Compose for reproducible deploys.
34. F49 — document backup/rollback procedure.

---

*This document reflects the working tree as of 2026-07-26, including uncommitted changes. Re-verify §0's "already fixed" list against `git status`/`git diff` before acting on any Tier 0/1 item, in case the working tree has moved further since this was written. Update `system.md` alongside any of the above once implemented, per its own stated maintenance convention.*

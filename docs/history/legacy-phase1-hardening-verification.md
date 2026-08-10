# RobotX — Phase 1 Verification Report

> Verifies every finding in `PHASE1_REVIEW.md` (F1–F50) and every open item in the prior `system.md` against the **actual current repository state** — branch `feature/dashboard`, last commit `fa1024f`, plus an uncommitted working-tree diff.
>
> **Method**: originally five independent read-only passes over the source tree, reconciled by hand. **Round 3 (below) changed the method**: findings are now verified by **executable tests** rather than by reading, wherever the finding is testable. A verdict backed by a named test is materially stronger than one backed by a `file:line` citation, because it re-runs on every commit. Verdicts still resting on reading alone are marked as such.
>
> **Legend**: ✓ Fully implemented · ⚠ Partially implemented · ✗ Missing / still open · — Not re-verified
>
> ---
>
> **⚠️ Correction notice (Round 3).** Three verdicts in the Round 2 tables below were **wrong**, in both directions, and are corrected inline with strikethrough rather than silently rewritten:
> - **F6 was marked ✓ but was inert in production** — implemented in form, dead in effect.
> - **F10 was marked ✗ but was half-landed** — the telemetry gate existed and worked; a second write path defeated it.
> - **F27 was marked ✗ but had already been fixed** in the working tree.
>
> All three were caught by writing tests, not by re-reading. That is the single most important finding of Round 3 and it is generalized in §7. this pass

---

## 0. What changed since `PHASE1_REVIEW.md` was written

`PHASE1_REVIEW.md`'s own §0 already documented one round of fixes (auth gating, dead-code deletion, seed-pin fix). **A second, larger round of uncommitted work has landed since**, touching 28 files. This round specifically targeted the Tier 0/Tier 1 items `PHASE1_REVIEW.md` called out as highest-priority:

- Real server-side WebAuthn (F31) — new `webauthn_controller.js`, new `WebAuthnCredential` Prisma model + migration, new frontend flows.
- Socket.IO dashboard-room JWT gating (F21) — new shared `verifyUserToken` helper.
- Allocation reservation locking + retry (F4) — new `kv.reserveRobot`/`releaseReservation`.
- Utilization tracking (F5) — `updateUtilization()` now called from the live telemetry path.
- Zone-locality cost term (F6) — `costEvaluator.service.js` cost function now has a 5th term.
- Battery-threshold unification (F25) — new shared `Backend/src/config/dtaro.constants.js`.
- Pairing brute-force lockout (F32) — new `pairingLocked:{robotId}` key + admin unlock endpoint.
- Fault-clear path (F33) — new `POST /api/robots/:robotId/clear-fault` endpoint.
- Batched Redis reads (F9/F14/F17) — new `kv.mget()` and `robotRegistry.service.js:getManyRobotStates()`, consumed by both the DTARO candidate loop and `GET /api/robots*`.

None of this is reflected in either existing document. This is the primary reason `system.md` needed a full rewrite rather than an edit.

### Round 3 — test baseline + four defect fixes (2026-07-26, later)

A third round has landed since the Round 2 audit above. It is qualitatively different from Rounds 1 and 2: those added features, this one **added a test suite and used it to find defects that manual review had missed for two consecutive rounds**.

**Test infrastructure (new):**
- `Backend/jest.config.js`, `Backend/tests/` — **17 suites, 137 tests, all passing**. `package.json`'s `"test"` script is now `jest --runInBand --forceExit` (it was a stub that exited non-zero).
- Helpers: `tests/helpers/{mockPrisma,fakeSocket,testKv,waitFor}.js`. `testKv` runs the **real** `kv` facade in fallback mode rather than a hand-rolled stand-in, so TTL/reservation/mget semantics are genuinely exercised.

**Defects found by the new tests and fixed:**

| ID | Defect | Root cause | Fix |
|---|---|---|---|
| **F51** | DTARO zone-locality (F6) was **inert** — `Z` was a constant across all candidates | `robotRegistry.updateZone()` had **zero callers**; `zoneId` was never persisted to either the registry or `Robot.zoneId` | `zoneManager.assignRobotToZone()` now persists zone on every call (registry) and on change (Postgres) |
| **F52** | `ZONE_UPDATED` broadcast to `dashboard` on **every telemetry tick**, plus a redundant `socket.join()` — 0.5 events/robot/second of pure noise | Same root cause as F51: `currentZoneId` was permanently `null`, so the "did the zone change?" guard was always true | Fixed by F51's persistence; the guard now compares real values |
| **F53** | `HEARTBEAT` issued an **unconditional** `prisma.robot.update` per beat, fully defeating F10's telemetry flush gate | The F10 gate was added to `telemetry.handler.js` only; `VirtualRobot._tick()` emits `HEARTBEAT` on the **same 2s tick** | Heartbeat now writes liveness to Redis every beat, throttles the Postgres mirror to `DB_FLUSH_INTERVAL_MS` |
| **F54** | `kv.reserveRobot()` **silently degraded to a process-local lock** when Redis was configured but unreachable — voiding F4's race fix in exactly the multi-instance deployment it exists to protect | `kv.js` applied one uniform in-memory fallback policy to every capability, including the distributed lock | Lock **fails closed** (503 `LOCK_UNAVAILABLE`) when Redis is configured-but-down; still uses memory when Redis is *deliberately* disabled |

**Supporting changes required by the above:**
- `Backend/src/config/liveness.constants.js` — **new file.** F53's throttle would have made healthy robots flap OFFLINE, because the sweep's 10s `lastSeenAt` cutoff was shorter than the 15s flush interval. The constants and the invariant between them (`DB_FLUSH_INTERVAL_MS < OFFLINE_CUTOFF_MS`) now live in one file, following the `dtaro.constants.js` precedent.
- `socket.server.js:startOfflineDetector` — now **Redis-aware and batched**: reads registry `lastHeartbeat` before marking a robot offline, reconciles rather than downing a live robot, and bounds each pass to `OFFLINE_SWEEP_BATCH`. Cutoff widened 10s → 30s.
- `kv.js` — background **reconnect probe** with capped exponential backoff (closes F15/F39), and `health()` now returns `{ redis, configured, reconnecting }`.

---

## 1. Finding-by-Finding Verification

### Tier 0 — Security (was the highest-priority tier)

| Finding | Verdict | Evidence |
|---|---|---|
| **REST `authUser` gating** (`system.md` #1) | ✓ | `router.use(authUser)` confirmed in `tasks.routes.js:8`, `campuses.routes.js:7`, `locations.routes.js:7`, `simulator.routes.js:7`, `robots.routes.js:8`. All mounted via `routes/index.js:12-17`. |
| **F21 — Socket.IO `dashboard` room requires JWT** | ✓ | `socket.server.js:105-120`: dashboard-candidate sockets resolve a JWT (cookie `token` or `auth.token`) through the new shared `verifyUserToken()` (`auth_middleware.js:17-38`); failure → `UNAUTHORIZED` emit + `socket.disconnect(true)`, no `dashboard` join. `Frontend/src/lib/socket.js:13` sends `withCredentials: true`. Robot sockets unaffected (own `AUTH` event). |
| **F29/F2 — CORS no-Origin bypass** | ✓ **Fixed** | `Backend/src/config/cors.js:36`: `if (!origin) return false;` — missing-Origin requests are now denied by default. Verified safe for every consumer: browsers always attach `Origin` on cross-origin fetch/XHR/WebSocket handshakes (REST + dashboard sockets unaffected); robot Socket.IO connections and non-browser tooling never enforce/depend on reflected CORS headers (confirmed the `cors`/`engine.io` middleware never blocks the underlying request based on this callback's return value — it only toggles response headers), so closing the bypass has no effect on their admission, which is independently gated by JWT/`authUser`/robot `AUTH` regardless; WebAuthn's `resolveRpIdAndOrigin` already short-circuited on missing Origin before ever calling `isOriginAllowed`, so it was and remains unaffected. |
| **F31 — Passkey/WebAuthn not cryptographically verified** | ✓ **Fully implemented, real WebAuthn end-to-end** | Backend: `webauthn_controller.js` uses `@simplewebauthn/server` — server-issued challenge stored in Redis (`webauthn:{purpose}Challenge:{userId}`, 300s TTL), `verifyRegistrationResponse`/`verifyAuthenticationResponse` actually invoked, public key persisted (`register():151-161`), signature-counter replay/clone check (`verify():266-277`, rejects `newCounter <= previousCounter`). Registration additionally re-checks PIN server-side (line 108, via newly-exported `verifyUserPin`). Schema: `WebAuthnCredential` model (`schema.prisma:111-136`, unique `credentialId`, `publicKey`, `counter BigInt`, cascade FK to `User`), migration `20260726075557_add_webauthn_credentials`. Routes: `auth.routes.js:22-26`, all `authUser`-gated + rate-limited. Frontend: `ProfilePage.jsx` (`startRegistration`) and `AuthChallengeModal.jsx` (`startAuthentication` → `webauthnVerify`) both call `@simplewebauthn/browser` against the real endpoints — no more client-only truthy-assertion check. Dependencies confirmed installed both sides (`@simplewebauthn/server ^10.0.1`, `@simplewebauthn/browser ^10.0.0`). |
| **F26 — unauthenticated first-telemetry bind** | ✓ | `telemetry.handler.js:141-144`: unconditional `if (!socket.data.isAuthed \|\| !socket.data.robotId) { emit AUTH_REQUIRED; return; }` — no first-telemetry bind path exists anywhere in the file. |
| **F32 — pairing brute-force logs but never blocks** | ✓ | `robot.handler.js:121-129`: at `PAIRING_LOCKOUT_THRESHOLD=5` attempts, `lockPairing()` sets `pairingLocked:{robotId}` (1h TTL); every AUTH checks the lock *before* comparing codes, keyed by `robotId` (not socket), so reconnecting doesn't reset the counter. Admin override: `POST /api/robots/:robotId/pairing/unlock` (`robots.controller.js:325-345`, wired `robots.routes.js:23`). |
| **F33 — `ROBOT_FAULT` `healthStatus` never cleared** | ✓ | New `POST /api/robots/:robotId/clear-fault` (`robots.controller.js:353-416`, wired `robots.routes.js:27`) — validates the robot is actually faulted, transitions DB status, calls `updateHealthStatus(kv, robotCode, "OK")`, logs an `Event`, emits `ROBOT_UPDATED`. Separately confirmed telemetry no longer clobbers `healthStatus`: `updateTelemetry`'s payload (`telemetry.handler.js:303-309`) omits the field, and `setRobotState` merges (`{...existing, ...update}`, `robotRegistry.service.js:61`) rather than replaces — so a FAULT flag now survives ticks (previously it was TTL-accident-reset; now it's deliberately sticky until cleared). |
| **F34 — hardcoded seed PIN** | ✓ (already fixed, reconfirmed) | `seed-pin.js:21-42`: requires `SEED_ADMIN_PIN`, exits non-zero if unset/malformed. No literal PIN remains. |

**Tier 0 net result: 8 of 8 items closed** (as of the F29/F2 CORS fix in this pass).

### Tier 1 — DTARO allocation correctness + cheap high-value fixes

| Finding | Verdict | Evidence |
|---|---|---|
| **F4 — no allocation reservation/locking (highest-impact allocation fix)** | ✓ | `kv.js:291-313` adds `reserveRobot(key, value, ttlSec)` (`SET key value EX ttl NX`, in-memory-fallback-aware) and `releaseReservation(key)`. `task.service.js`'s `_processAssignment` wraps selection in a bounded retry loop (`MAX_RESERVATION_RETRIES=2`, `RESERVATION_TTL_SEC=30`): a lost reservation triggers a retry against `selectNearestRobot` with the losing robot excluded (`excludeRobotIds`, growing each retry), only failing the task after 3 total attempts. Reservation released in a `finally` block on every exit path. |
| **F14 — `kv.mget` (unblocks F9/F17)** | ✓ | `kv.js:241-256`: `mget(keys)` — pipelined native `redis.mget`, sequential fallback in-memory mode. |
| **F9 — redundant per-candidate Redis reads** | ✓ | `robotRegistry.service.js:77-101` adds `getManyRobotStates()` built on `mget`. `taskAssignment.service.js:98` calls it once for the whole candidate pool; `validateRobot()` (`robotValidator.service.js:38,53`) accepts a pre-fetched `liveState` and skips its own fetch when supplied. Candidate loop is now one `MGET` instead of up to 200 sequential `GET`s. |
| **F5 — utilization always 0** | ✓ | `telemetry.handler.js:314-323`: EMA update (`α=0.05`, `isActive = status==="ACTIVE" ? 1 : 0`) calling `updateUtilization()` every tick — matches the formula recovered from the deleted `simulation.service.js` reference. |
| **F6 — zone locality has zero weight** | ~~✓~~ → **✗ in Round 2, ✓ as of Round 3** | **Round 2's ✓ was wrong.** The formula was correctly extended (`costEvaluator.service.js`: `C(r) = w1·D + w2·(1−B) + w3·U + w4·T + w5·Z`, weights `{0.50, 0.30, 0.15, 0.05, 0.05}`), and `taskAssignment.service.js:70-73` does resolve `pickupZoneId` and thread it through — which is what Round 2 verified. What Round 2 did **not** check is whether anything ever *writes* `zoneId`. Nothing did: `robotRegistry.updateZone()` had zero callers (`grep -rn "updateZone" src/` returned only its definition and its export), and `assignRobotToZone()` updated socket rooms and emitted an event but never persisted. So `c.zoneId` was always `null`, `Z` evaluated to `1` for every candidate, and the term was **a constant offset with zero effect on ranking** — present in the formula, dead in production. Fixed in Round 3 (F51). Now pinned by `tests/unit/dtaro/zoneLocality.test.js`, which asserts a same-zone candidate scores strictly lower than an otherwise-identical out-of-zone one. **Documentation nuance (unchanged and still true)**: w1..w4 alone sum to 1.00; `w5` is additive on top, so the budget is 1.05, not renormalized — a deliberate design choice. |
| **F8 — allocation metrics written with null cost/latency** | ✓ (auto-assign path) | `task.service.js` now captures `cost`, `costComponents`, and `latencyMs` (`Date.now()` delta around `selectNearestRobot`) and threads them through `_finalizeAssignment` into `recordAllocation()`. **Caveat**: manual robot assignment (`robotCodeIn` supplied) still records `cost: null` since no cost is computed for a manual pick — correct behavior, not a bug, but worth noting in the metrics documentation. |
| **F25 — battery-threshold mismatch (server vs. simulator)** | ✓ | New `Backend/src/config/dtaro.constants.js` exports `BATTERY_THRESHOLD=20` and `CHARGING_INTERRUPT_BATTERY=30`, explicitly comment-referencing F25. `robotValidator.service.js:14` and `simulation/constants.js:1` both import from it instead of hardcoding independent literals. The two numbers were deliberately *kept distinct* (20 for general eligibility, 30 for charge-interrupt) rather than collapsed to one value — a documented design choice, and the inconsistency risk (two files silently drifting) is closed either way. |
| **F32 — pairing lockout** | ✓ | See Tier 0 table above. |
| **F33 — fault-clear path** | ✓ | See Tier 0 table above. |
| **F41 — commit the cleanup pass before further large refactors** | ⚠ **Testing half now closed; committing half still open** | **Testing**: a real suite now exists — 17 suites, 137 tests, all passing, run via `npm test` (`jest --runInBand --forceExit`). This directly vindicates the finding: the suite immediately surfaced three defects (F51–F54) that two rounds of careful manual review had missed, including one (F6/F51) that manual review had affirmatively marked as *fixed*. **Committing**: the working tree still carries three uncommitted rounds. Still the correct next action. |

**Tier 1 net result: 9 of 10 items closed, but one closure (F6) was false and is only genuinely closed as of Round 3.** F41's testing half is now closed and immediately proved its worth.

### Tier 2 — Lifecycle correctness

| Finding | Verdict | Evidence |
|---|---|---|
| **F27 — cancelling a task doesn't stop the robot / clean up Redis** | ~~✗~~ → **✓ Closed** | **Round 2's ✗ was wrong** — the fix was already present in the working tree and was missed. `tasks.controller.js:cancelTask` gates all cleanup on `releasedRobotCode` (populated only when the robot's `currentTaskId` still pointed at this task at cancel time, mirroring the DB release condition), then: emits `STOP {taskId, reason:"TASK_CANCELLED"}` to the robot socket (`:110`), deletes `taskPath:{taskId}`, `task:{taskId}`, `robotTaskState:{robot}`, `robotTask:{robot}` (`:121-124`), and clears the registry's assigned task and planned path (`:126-127`). Covered by `tests/unit/tasks/tasksControllerCancel.test.js`. |
| **F28 — Decision workflow is cosmetic, `Decision` table unused** | ✗ **Still open** | Zero `prisma.decision.create`/`.decision.` calls anywhere in `Backend/src`. Real wiring lives in `Frontend/src/router/layout.jsx:34-67`: `handleWait` (34) is a pure client `setTimeout` re-show; `handleReroute` (47) is the only real backend call; `handleCancel` (64) only clears local state — with an inline code comment literally stating *"robot continues on its current route unchanged."* No server-side effect for WAIT or CANCEL, exactly as before. |
| **F1 (system.md) — two duplicate live-state Redis stores** | ✗ **Still open** | `registry:{robotId}` (`robotRegistry.service.js`) and `robot:{robotId}` (`telemetry.handler.js:261-273`) remain two independently-written keys with overlapping fields, different TTLs (30s vs 15s). The new `mget`/`getManyRobotStates` work made *reading* each store cheaper (F9/F17) but did not consolidate them — F1 itself is unaddressed. |
| **F2/F24/F38 — two independent command-retry mechanisms** | ⚠ **Still two — now explicitly documented as an intentional split, not unified** | `commandDispatcher.service.js:8-9` gained a comment stating STOP/PAUSE/RETURN/RESUME are deliberately routed through `robots.controller.js:sendRobotCommand`'s own retry loop (`scheduleReliabilityCheck`, 5s interval, Redis-backed `cmdretry:{commandId}` counter, checks Postgres `Command.status`), while `commandDispatcher.dispatch()` is reserved for `TASK_ASSIGN`/`REROUTE_ALERT`. Functionally this is exactly the duplication F2/F24/F38 described — two separate in-memory retry policies for "reliably deliver a command" — but it is no longer an accidental/undocumented duplication, it's a stated (if not obviously correct) design split. Neither loop survives a restart (F38 remains fully open). |
| **F3 — legacy Socket.IO `assign_task` task-creation path** | ✗ **Still open** | `socket.server.js:179-193` still registers `assign_task` → `task_assigned`/`task_error`, parallel to the REST path, unchanged. |

**Tier 2 net result: 1 of 5 items closed** (F27, which Round 2 had incorrectly marked open). F2/F24/F38 improved only in documentation, not in mechanism. This remains the least-progressed tier.

### Tier 3 — Scale-readiness

| Finding | Verdict | Evidence |
|---|---|---|
| **F10 — every telemetry tick writes to Postgres** | ~~✗~~ → **✓ Closed as of Round 3** (was half-landed at Round 2) | **Round 2's ✗ was wrong in one direction and right in another.** A dirty-state flush gate *did* exist in `telemetry.handler.js` (`DB_FLUSH_INTERVAL_MS`, `lastDbFlushAt`) and worked: it flushes only on status transition, reconnect, ≥2% battery swing, or interval elapse — deliberately *not* on movement, since Redis carries position every tick regardless. But the aggregate write volume to `Robot` was **unchanged**, because `robot.handler.js`'s `HEARTBEAT` path issued an unconditional `prisma.robot.update` and `VirtualRobot._tick()` emits `HEARTBEAT` on the same 2s tick as `TELEMETRY` — **30 full-row writes/robot/minute** straight past the gate (F53). Both paths are now throttled to the shared `DB_FLUSH_INTERVAL_MS`. Pinned by `tests/unit/telemetry/heartbeatDbWrites.test.js` (10 beats ⇒ 1 write) and the existing F10 cases in `telemetryHandler.test.js`. **Lesson**: "is there a throttle in this handler?" was the wrong question; "how many writes does one robot-tick produce, across all paths?" was the right one. |
| **F12 — telemetry pipeline fully sequential** | ✗ **Still open** | Full chain remains `await`-chained top to bottom (Postgres read → Redis read → Postgres write → snapshot → registry write → utilization → second registry read → zone check). Only one unrelated `Promise.all` exists (battery-persist writes). |
| **F17 — `GET /api/robots`/`/state` per-row Redis GET** | ✓ | `robots.controller.js:116,164`: both `listRobots` and `getRobotsState` now call `kv.mget([...])` once instead of `Promise.all` of individual `GET`s. |
| **F22 — no `@socket.io/redis-adapter`** | ✗ **Still open** | `Backend/package.json` has no `@socket.io/redis-adapter` dependency; no `io.adapter(...)` call anywhere in `Backend/src` (grep-confirmed empty). Horizontal scale-out remains structurally blocked. |
| **F23 — in-memory Socket.IO rate limiter, per-process** | ✗ **Still open** | `rateLimit.js:2`: `const lastEvent = new Map()`, still process-local; no `kv.incr` usage. |
| **F15/F39 — Redis fallback never retries reconnecting** | **✓ Closed (Round 3)** | `kv.js` now has `scheduleReconnect()` — capped exponential backoff (1s → 30s), `unref()`d so it never holds the process open, cleared on `close()`. `disableRedis()` schedules it; a successful probe clears the warn-latch and resumes Redis mode. `health()` now reports `{ redis, configured, reconnecting }` so a degraded process is *visible* rather than silently latched. Verified by `tests/unit/redis/lockFailClosed.test.js`. |
| **F54 (new, Round 3) — the allocation lock silently degrades to a process-local lock** | **✓ Closed (Round 3)** | Found while testing F15/F39. `kv.js` applied one uniform in-memory fallback to *every* capability, including `reserveRobot`. A test spinning up two independent `kv` instances against an unreachable Redis had **both** successfully reserve the same robot — voiding F4's race fix precisely in the multi-instance deployment it exists to protect, with no error, no log, and no metric. `reserveRobot` now **fails closed** (`503`, `code: LOCK_UNAVAILABLE`) when Redis is configured-but-unreachable, while still using the memory lock when Redis is *deliberately* disabled (`REDIS_ENABLED=false` / no `REDIS_URL`), where single-process operation is the operator's explicit intent. `releaseReservation` stays lenient by design — it runs in a `finally`, so throwing would mask the original error; the reservation TTL covers a missed release. Caches and rate limiters still fail **open**, since failing those closed would turn a Redis blip into a full outage. |
| **F7 — Mapbox circuit breaker** | ✗ **Still open** | Zero hits for `circuit`/`breaker`/`consecutiveFailures`/`mapboxCircuit` across `Backend/src`. `mapbox.service.js` still has only per-call `try/catch` with no cross-request failure-rate state. |
| **F40 — startup recovery has no bounded concurrency** | — Not re-verified | No file touching `taskRecovery.service.js` appears in the diff; presumed unchanged. |

**Tier 3 net result: 4 of 9 items closed** (F17, F10, F15/F39, F54). F10 — flagged across two rounds as the single largest scale risk — is now genuinely closed on **both** write paths, taking `Robot` writes from ~30/robot/minute to ≤4. F12, F22, F23, F7 and F40 remain open, and F22 (no `@socket.io/redis-adapter`) is now the binding constraint: it is a **topology** blocker, not a throughput one, so it caps the system at exactly one process regardless of how much per-process headroom the other fixes bought.

**A scale risk this tier does not yet name.** `telemetry.handler.js:400` broadcasts `io.emit("robot:update", …)` to **every connected socket**, robots included — O(N²) message amplification, and the lowest-effort/highest-return fix available anywhere in the system (scope it to the `dashboard` room). It is tracked as **B2** in `ARCHITECTURE_PROPOSAL.md` §1.2 and belongs in this tier.

### Tier 3.5 — Housekeeping

| Finding | Verdict | Evidence |
|---|---|---|
| **F13 — dead Redis keys `task:{taskId}` / `robotTask:{robotId}`** | ⚠ **Partially implemented** | `task:{taskId}` (`task.service.js:27`) — still written, still zero readers, fully dead. `robotTask:{robotId}` (`task.service.js:28`, `taskRecovery.service.js:17`) — now also `del`'d on `TASK_COMPLETE` (`dtaro.handler.js:115`), so its lifecycle is hygienic, but it is still never read for its *value* anywhere — the core complaint ("nothing consults this key") is not resolved, only its cleanup improved. |
| **F42 — dead frontend config (`mapConfig.js`)** | ✓ (exceeded the ask) | `Frontend/src/config/mapConfig.js` now contains only `export const MAP_STYLE = ...` — `LOCATION_TREE` and `MAP_FLEET_ROBOTS` were deleted outright (not merely left unused, confirmed zero remaining references anywhere in `Frontend/src`). |
| **F43 — no `.env.example`** | ✗ **Still open** | `Glob **/.env.example` returns nothing anywhere in the repo. |
| **F35 — debug scripts unguarded against production `DATABASE_URL`** | ✗ **Still open** | `check_password.js`/`check_users.js` still have no `NODE_ENV` guard; `check_users.js` still prints a 4-character password-hash prefix to stdout. |

**Tier 3.5 net result: 1 of 4 items closed.**

### Tier 4 — Completeness (not re-verified in depth; spot-checked)

| Finding | Verdict | Evidence |
|---|---|---|
| **F16/F46 — degraded-mode indicator in the dashboard** | — Not re-verified | No frontend health-poll/banner component found in any of the reviewed frontend diffs (`AppProvider.jsx` did not appear in the uncommitted-changes list). Presumed unchanged / still open. |
| **F18 — `ObstacleEvent` retention policy** | — Not re-verified | `ekb.service.js` not in the diff; presumed unchanged. |
| **F20 — cosmetic chassis "type" field not persisted** | ✗ **Still open** | `schema.prisma`'s `Robot` model has no `type`/`chassis` column. `CommissionPage.jsx` still collects and submits `formData.type`; `robot.service.js:commissionRobot` still never reads it — silently dropped before `prisma.robot.create`. |
| **F36 — no Mapbox result caching** | — Not re-verified | `mapbox.service.js` not in the diff; presumed unchanged. |
| **F45 — no `/metrics` endpoint** | — Not re-verified, but a prerequisite (F8) just landed | `metrics.service.js` not in the diff; the endpoint does not exist, but F8's fix means the underlying data is now real, unblocking this if picked up. |
| **F47 — no Dockerfile/Compose** | ✗ **Still open** | `Glob **/Dockerfile` matches only `node_modules/bcrypt/Dockerfile` (irrelevant); no `docker-compose*.yml` anywhere. |
| **F49 — no documented backup/rollback strategy** | — Not re-verified | Documentation-only item; not addressed by this code round. |

---

## 2. Regressions Detected

**Rounds 1–2: none found.** Every change was additive or a narrowly-scoped correction. No previously-working behavior was broken.

**Round 3: none found**, verified by a means the earlier rounds did not have — the full 137-test suite passes after the changes. Two intentional behavior changes are worth calling out explicitly so they are not mistaken for regressions later:

1. **Offline-detection latency widened from ~10s to ~30s** in the backstop sweep. This is a deliberate consequence of throttling heartbeat DB writes (F53): the sweep's cutoff must exceed the flush interval or a healthy robot flaps offline between two throttled writes. It is safe because the sweep is **not** the primary offline signal — the socket `disconnect` handler marks a robot offline immediately, and the sweep only catches cases where that never ran (process kill, half-open connection). The sweep is also now Redis-aware, so it is *more* accurate than before, not less.
2. **`kv.health()` changed shape** from `{ redis }` to `{ redis, configured, reconnecting }`. `tests/unit/redis/kv.test.js` was updated accordingly — as that test's own comment had instructed a future implementer to do.

One **near-miss that remains a documentation-drift risk rather than a regression**: `commandDispatcher.service.js`'s comment describing the STOP/PAUSE/RETURN/RESUME vs. TASK_ASSIGN/REROUTE_ALERT split as intentional could mislead a reader into believing F2/F24/F38 is resolved. It is not — the comment documents the split; it doesn't fix the duplication (no restart-recovery parity, two different retry cadences for conceptually the same problem).

---

## 3. Consistency Check

**Dead documentation**: Both `system.md` and `PHASE1_REVIEW.md`, as they stood before this audit, described a repository state that is now materially stale — neither mentions WebAuthn's real implementation, the DTARO reservation lock, the zone-locality cost term, utilization tracking going live, the pairing lockout, the fault-clear endpoint, or the batched Redis reads. This is the direct justification for the full `system.md` rewrite accompanying this report (see that file).

**Dead code remaining** (re-verified by grep, Round 3):
- `task:{taskId}` Redis key — written in `task.service.js:27`, deleted in `tasks.controller.js:122`, **read nowhere** (F13, still open for this key).
- Legacy Socket.IO `assign_task`/`task_assigned`/`task_error` handlers — `socket.server.js:228`, reachable, unused by the current frontend (F3, still open).
- `robots.controller.js`'s `scheduleReliabilityCheck` vs. `commandDispatcher.service.js`'s `dispatch()` — not dead, but duplicate logic for the same concept (F2/F24/F38).

**Dead code resolved in Round 3**: `robotRegistry.updateZone()` — previously exported with zero callers, which is precisely what made F6 inert. Now called from `zoneManager.assignRobotToZone()`. Worth noting as a pattern: **an exported function with no callers is not merely dead weight; when a downstream consumer reads the field it was supposed to write, it is a silent correctness bug.** A lint rule for unreferenced internal exports would have caught F6 statically.

**Unused configuration**: `Backend/.env`/`Frontend/.env` variable set is unchanged in shape; no new required variables were introduced by this round's features (WebAuthn reuses the existing `FRONTEND_URL`/CORS-derived origin resolution rather than needing a new env var — confirmed via `webauthn_controller.js:resolveRpIdAndOrigin`, which derives RP ID from the request's `Origin` header checked against the existing CORS allowlist).

**Unused APIs**: None newly introduced — every new endpoint added in this round (`/webauthn/*`, `/robots/:id/pairing/unlock`, `/robots/:id/clear-fault`) has a confirmed frontend or operational caller, except the two admin-recovery endpoints (`pairing/unlock`, `clear-fault`), which are reachable but have no frontend UI wired to them yet — they exist as API-only recovery tools today (worth flagging for a future dashboard iteration, not a defect).

**Duplicate logic**: F1 (dual live-state Redis stores) and F2/F24/F38 (dual command-retry mechanisms) are the two remaining duplicate-logic findings; both are explicitly still open per §1 above.

**Duplicate constants**: Resolved for battery thresholds (F25, `dtaro.constants.js`) and, in Round 3, for liveness/flush timings (`liveness.constants.js` — `DB_FLUSH_INTERVAL_MS`, `OFFLINE_CUTOFF_MS`, `OFFLINE_SWEEP_INTERVAL_MS`, `OFFLINE_SWEEP_BATCH`, shared by `telemetry.handler.js`, `robot.handler.js`, and `socket.server.js`). The second file also documents the **invariant** between its values (`DB_FLUSH_INTERVAL_MS < OFFLINE_CUTOFF_MS`), not just the values themselves — which is the part that actually prevents the next F53. Still not extended to rate-limit thresholds or Redis TTLs.

**Outdated comments**: The `commandDispatcher.service.js` comment (noted above) is accurate about *what* the split is but doesn't flag that the split is itself a known finding rather than a resolved design.

**Broken references**: None found — all new imports (`dtaro.constants.js`, `@simplewebauthn/*`, `verifyUserToken`, `verifyUserPin`) resolve correctly and are confirmed to have real callers.

**Architecture drift**: The core architectural shape described in `PHASE1_REVIEW.md` §1 (single Express + Socket.IO process, service layer, `VirtualRobot` as socket.io-client peers) is unchanged and still accurate. The drift is entirely additive: new capabilities (real WebAuthn, allocation reservations, zone-aware cost) were added within the existing architectural boundaries, not by introducing new architectural patterns. No new external dependency changes the deployment shape (no message broker, no second process type added).

---

## 4. Quality Review

Ratings reflect the repository as it stands right now (working tree, not last commit), on a 1–10 scale.

Scores are shown as **Round 2 → Round 3**.

| Area | Score | Justification |
|---|---|---|
| **Security** | 7 → **8**/10 | REST and Socket.IO comprehensively auth-gated; WebAuthn real and cryptographically verified end-to-end; pairing brute-force actually blocked; fault-clear recovery path; CORS no-Origin bypass closed. Round 3 adds a genuine security-adjacent fix: the allocation lock no longer silently degrades (F54) — a failure that could dispatch two tasks to one physical vehicle. `cancelTask` **does** stop the robot (F27 — Round 2's claim otherwise was wrong). Held back from 9 by: unguarded debug scripts that print password-hash prefixes against a live `DATABASE_URL` (F35), and step-up authorization still enforced only client-side. |
| **Reliability** | 7 → **8**/10 | Allocation-reservation retry (F4), restart recovery (`taskRecovery.service.js`), and now a Redis reconnect probe (F15/F39) plus a fail-closed lock (F54) and a Redis-aware offline sweep. Held back by: two command-retry mechanisms with no restart-recovery parity (F2/F24/F38), no recovery path for `PENDING` tasks orphaned by a crash during the `setImmediate` assignment window, and the still-cosmetic Decision workflow (F28). |
| **Performance** | 5 → **7**/10 | F9/F14/F17 cut per-assignment Redis round-trips from ~200 to a handful. Round 3 closes F10 on **both** write paths — `Robot` writes drop from ~30/robot/minute to ≤4, roughly a 7× reduction in the hottest DB path — and removes a per-tick `ZONE_UPDATED` broadcast and redundant `socket.join()` per robot (F52). Held back by: the O(N²) `io.emit` broadcast (B2), the still-sequential telemetry pipeline (F12), and no Mapbox circuit breaker or route cache (F7). |
| **Scalability** | 4 → **5**/10 | Per-process headroom improved materially. **Topology is unchanged**: no `@socket.io/redis-adapter` (F22), in-memory socket rate limiting (F23), and a process-local `robotSockets` Map that means a second instance cannot dispatch to a robot connected to the first. The system still runs on exactly one process. F54 sharpened this: the lock now *correctly refuses* to pretend it works across instances, which converts a silent correctness hazard into a loud one — the right trade, but not the same as being able to scale out. |
| **Maintainability** | 6 → **7**/10 | The shared-constants pattern is now used twice (`dtaro.constants.js`, `liveness.constants.js`), and the second documents the *invariant* between its values rather than just the values. Test suite makes refactoring meaningfully safer. Still working against it: two duplicate live-state Redis stores (F1) and two command-retry mechanisms (F2/F24/F38). |
| **Code organization** | 7 → **7**/10 | Service-layer separation maintained; Round 3's changes follow existing conventions. One new cross-layer dependency (`zoneManager` → `robotRegistry`), verified acyclic. Dead surface area remains (legacy `assign_task` path, `task:{taskId}` key). |
| **Production readiness** | 4 → **5**/10 | Real test suite and a working `npm test` are genuine progress. Still missing: Dockerfile/Compose (F47), `.env.example` (F43), any CI configuration, and any load test — so the system's actual capacity ceiling **remains unmeasured**. Three uncommitted rounds still sit in the working tree. |
| **Documentation quality** | 8 → **7**/10 | Downgraded deliberately, on evidence. Round 3 found that three verdicts in this very document were wrong — including one (F6) that confidently marked an inert feature as fixed. The documents were carefully written and still drifted from reality within a day. This is not a writing-quality problem; it is structural, and the fix is to move load-bearing claims out of prose and into tests (§7). The documents are now accurate *and* have executable backing for the claims that matter. |
| **Testing coverage** | 1 → **6**/10 | 17 suites, **137 tests**, all passing. Overall line coverage **42.9%** — but the distribution matters far more than the number, and it is well-targeted at the risky code: `costEvaluator` 100%, `robotValidator` 100%, `telemetry.service` 100%, `taskRecovery` 97%, `auth_middleware` 100%, `taskAssignment` 92%, `webauthn_controller` 79%, `robotRegistry` 78%, `zoneManager` 70%, `task.service` 66%. Near-zero: controllers other than tasks/webauthn (`robots.controller.js` 0%), all route files (0%), `mapbox.service` 3.6%, `routeIntersection` 4%, `routing.service` 8%, `ekb.service` 10%. **The gap that matters most is the obstacle/reroute pipeline** (`ekb` → `alertDissemination` → `routeIntersection` → `routing`), which is safety-adjacent, algorithmically non-trivial, and effectively untested. |

---

## 5. Production Readiness Assessment

**Verdict: Not production-ready, but materially closer — and, for the first time, the claim is backed by something other than reading.**

What changed the calculus:
- Tier 0 security (REST auth gating, Socket.IO dashboard auth, real WebAuthn) is **fully closed**. No "reachable port = full control" failure mode remains.
- The most-flagged allocation correctness bug (F4) is **closed** — and Round 3 closed the hole *underneath* it (F54), where the lock it depends on silently became a no-op across instances.
- All three cost-function correctness gaps are now **genuinely** closed: F5 utilization, F6 zone-locality (only actually live as of Round 3), F8 real allocation metrics.
- The hottest DB path (F10) is closed on both write paths, and F27 turned out never to have been open.
- **A test suite exists**, and it immediately paid for itself by finding three defects two rounds of manual review had missed.

What still blocks a genuine production deployment, in priority order:

1. **No horizontal-scale path (F22, F23, and the process-local `robotSockets` Map).** This is now the top blocker. It is a *topology* limit, not a throughput one: the system runs on exactly one process, and no amount of per-process optimization changes that. Every other item on this list is a matter of degree; this one is binary.
2. **The capacity ceiling remains unmeasured.** No load test exists. Every capacity claim in this document and in `ARCHITECTURE_PROPOSAL.md` is an estimate. This should be fixed *before* the next round of optimization work, so the work can be prioritized by evidence.
3. **The O(N²) telemetry broadcast (B2).** `io.emit("robot:update", …)` fans out to every connected socket including robots. Roughly a day's work for the single largest headroom gain available.
4. **No reproducible deployment artifact (F47) and no documented environment contract (F43).** Deployment is still "run `node server.js` somewhere with the right env vars," undocumented.
5. **The obstacle/reroute pipeline is effectively untested** (3–10% coverage across `ekb`, `alertDissemination`, `routeIntersection`, `routing`). It is safety-adjacent and algorithmically the least trivial code in the repository — the worst possible combination with near-zero coverage.
6. **Three uncommitted rounds** in the working tree. Needs committing in reviewable, bisectable chunks before further large changes land (F41).

---

## 6. Recommendations (Prioritized)

**Completed since Round 2** (struck through, retained for audit trail):
- ~~Close the CORS no-Origin bypass (F29/F2)~~ — **Done.**
- ~~Fix `cancelTask` (F27)~~ — **Done**; Round 2 had incorrectly reported this as open.
- ~~Stand up a minimal test baseline~~ — **Done.** 17 suites / 137 tests, including `costEvaluator` at 100%.
- ~~Address F10 (per-tick Postgres write)~~ — **Done**, on both write paths.

**Do next, in order:**

1. **Commit the working tree** in reviewable, bisectable chunks (security/auth · DTARO · liveness/test-baseline · docs). Overdue by three rounds. With a passing test suite this is now low-risk, which removes the last excuse.
2. **Establish the capacity ceiling with a load test.** Everything below is currently prioritized by estimate. One afternoon with the `VirtualRobot` simulator driven out-of-process converts every capacity claim in this document from a guess into a number. **Do this before item 3**, so the improvement is measurable rather than asserted.
3. **Fix the O(N²) telemetry broadcast (B2).** Scope `io.emit("robot:update", …)` to the `dashboard` room. Roughly a day; the largest single headroom gain available.
4. **Add `@socket.io/redis-adapter` and move `robotSockets` to a Redis-backed routing table (F22).** This is what unblocks running more than one process, and it is the boundary between "a well-tuned single process" and "a system that can grow."
5. **Cover the obstacle/reroute pipeline with tests** before touching it. `routeIntersection` (pure geometry) and `routing.replanRoute` (pure A*) are both pure functions — trivially testable, currently at 4% and 8%, and safety-adjacent.
6. **Decide the Decision workflow (F28)** — implement it or remove it from the UI. A schema-backed feature that silently does nothing is worse than no feature.
7. **Add a lint rule for unreferenced internal exports.** F6 was an exported function with zero callers, and it silently broke a downstream consumer. This class of bug is statically detectable and would have been caught two rounds earlier.
8. Everything else in Tier 3/3.5/4 as bandwidth allows.

---

## 7. Method Note — Why Round 3 Found What Rounds 1–2 Missed

Worth recording explicitly, because it generalizes beyond these four defects.

Rounds 1 and 2 were careful, multi-pass, `file:line`-cited manual reviews. They still produced three wrong verdicts, and the errors were not careless — they were **structural to the method**:

- **F6** was verified by checking that the cost function reads `zoneId` and that `pickupZoneId` is threaded through. Both were true. Nobody asked *"and what writes this field?"* Reading verifies that code exists; it does not verify that code **runs**, or that data **flows**.
- **F10** was verified by checking `telemetry.handler.js` for a throttle. The question should have been *"how many DB writes does one robot-tick produce, across all handlers?"* Reading is scoped to the file you open; the defect lived in the interaction between two files.
- **F27** was verified against a stale mental model of the file and simply not re-read closely enough. Reading does not re-run.

Each was caught within minutes of writing a test, because a test asks a different question: **not "is the code there?" but "does the observable behavior hold?"**

Two concrete conclusions:

1. **A finding's verdict should cite a test, not a line number**, wherever the finding is testable. This document now does so for every Round 3 verdict.
2. **Prose documentation should carry decisions and rationale, not behavioral claims.** Behavioral claims drift silently; this repository has now demonstrated that twice in two days. `system.md` §9's per-tick cost table and §7's key map are the highest-risk sections in either document for exactly this reason — they describe behavior, and nothing enforces them.

---

*This document reflects the working tree as of 2026-07-26, after Round 3. Round 3's verdicts are backed by 137 passing tests and re-run on every commit; Rounds 1–2 verdicts not re-verified since remain reading-based and should be treated as weaker evidence — that distinction is the point of §7.*

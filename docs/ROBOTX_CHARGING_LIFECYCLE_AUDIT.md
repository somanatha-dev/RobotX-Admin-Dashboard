# RobotX — Charging Lifecycle, Assignment and Dashboard Audit

**Date:** 2026-10-12 · **Branch:** `feature/dashboard` · **HEAD:** `769bba2` (plus the uncommitted working tree, which was preserved)
**Type:** audit only. No production code, test, database row or service was changed. This file is the only file added.

**Concurrent edits.** During the audit another session modified files in the working tree for RESUME commitment binding:
- `VirtualRobot._resumeBindingRefusal`;
- `robots.controller.js`, `commandDispatcher.service.js` and `p7d1HoldAndRestore.test.js`.

None of these touch charging, and all line references below were read from the files after those changes.

## Evidence

**Code.** Every claim below cites a file and line in the current tree.

**Isolated harness.** The scratchpad file `charging.harness.test.js` (16 tests, all passing; not in the repo) runs the real components together:
- simulation: `VirtualRobot`, `SimulationEngine`, `devChargingScheduler`, `chargerRoute` and `campusTraversalNetwork` over the pinned RNSIT declaration (fixture `tests/fixtures/phase7/local-2026-10-09.json`);
- engine: `chargeCurve`, `chargingStatus.service`, `availabilityIndex.classify` and F18;
- server: `telemetry.handler`, with the engine on.

Only three things are mocked: the database (an in-memory store copied from `p7d3RestartRecovery.test.js`), the sockets and KV, and the clock (2 s ticks).

**Existing suites.** Seven charging suites re-run and passing: 161/161 tests. They are `p7d1StopLatch`, `p7d3ChargerApproach`, `p7d3RestartRecovery`, `phase7SimulationIntegrity`, `devChargingScheduler`, `p7d3SharedChargerAgreement` and `energySimulation`. The F34 threshold quoted below comes from the existing `tests/engine/p7c1ReturnEnergyLedger.test.js`.

**LOCAL database, read-only.** Queried inside `BEGIN READ ONLY … ROLLBACK` on the Docker `robotx` database at `:5433`.

**Not done.** Nothing was run against a live backend. Neon/Render were not touched.

---

## 1. Summary

### How charging works today, in plain terms

A simulated robot decides to charge at **≤ 10 % battery**, and only when it holds **no mission**. It then:
1. asks the development Charging Scheduler for one of the **3 plugs** at the single charger, **`V1DEMO-DEPOT-01`** (the RNSIT demonstration depot);
2. drives the campus sidewalk route to the depot (status `RETURNING`);
3. docks within 0.01 m and charges on a CC/CV curve to **80 %** (about **10.5 min** for a 500 Wh pack);
4. releases the plug and goes `IDLE` **at the depot**.

From the moment it holds a reservation it is excluded from assignment twice: by the availability index and by F18. This works end to end in the harness (S1a, S4, S5a).

### Why you see continuous discharge and almost no charging

These are the measured causes, in order of impact:

1. **Dead band.** The engine stops offering work well above 10 %. F34 refused TSK-816 for a 500 Wh robot below **29 %**. The simulator only charges at **10 %**, and an idle robot drains at **16 %/h**. So every robot spends about **70 min idle and visibly discharging** between "no more work" and "go charge" (29 → 10 %). Nothing charges opportunistically.
2. **Real time only.** There is no simulation time scale. An idle robot needs **5.6 h** to fall from 100 % to 10 %, so a demonstration session almost never reaches a charge.
3. **The LOCAL fleet is operator-held.** All 4 LOCAL simulated robots are `OFFLINE` with `statusBeforeOffline = PAUSED`, at 10.4, 17.4, 43.4 and 68.7 %. A held robot drains at the idle rate and gets no work. The robot list styles every `PAUSED` robot as **charging** (a blue card with a battery-charging watermark) while its battery falls (U-1).
4. **ISSUES becomes a permanent hold.** A robot that drops below 20 % during a delivery reports `ISSUES`. With the engine on, the server can never lift that status (D-1). The robot then shows ISSUES even while charging and receives no V1 work afterwards.
5. **The end of every charge is refused.** The robot's final frames (IDLE at about 80 %) are refused by the §23.5 energy check for about 2–7.5 min (D-2). The dashboard therefore keeps showing `CHARGING ~79.9 %`.
6. **The new path has never run live.** The drive-to-depot path from P7-D3 has never executed against LOCAL. The LOCAL projection is still v1 (DEV-SIM). All 7 reservations on LOCAL are pre-P7-D3 charge-in-place sessions at `DEV-SIM-RNSIT-MBA-01`, the last on 2026-10-09.

### Confirmed defects

All of these were reproduced in the harness.

| ID | Severity | Defect |
|---|---|---|
| D-1 | **High** | A low-battery `ISSUES` self-report becomes a permanent MARGINAL hold under the engine. F09 then denies every V1 task, even after charging to 80 %. No server path lifts it. |
| D-2 | **High** | The end-of-charge telemetry is refused by §23.5 for about 2–7.5 min: 73 consecutive frames and 71 `SECURITY_EVENT`s in the reproduction. During that time the dashboard is frozen at CHARGING, F18 keeps denying, and no position Observation is recorded. |
| D-3 | Medium | Same mechanism after a restart. The battery is restored from the older Redis snapshot instead of the newer DB row, so the first frames are refused: 50 frames and 48 `SECURITY_EVENT`s for a 0.5-point gap. |
| D-4 | Medium | An operator-held robot at ≤ 10 % takes a depot plug and holds it, without moving, for the whole 2 h 11 min window. SIM-0A8C on LOCAL is in exactly this state. |
| D-5 | Medium | A robot reporting `ISSUES` drains at the **idle** rate while still driving: 5× below the rate the engine plans with. |
| D-6 | Low/Med | With no usable charger or no route, the robot seeks forever. It reads the scheduler and logs a warning every tick, or creates and releases a reservation row about every 30 s. The dashboard says nothing. |
| D-7 | Low (latent) | The reservation window is computed for a fixed 1000 Wh pack rather than the robot's own. A commissioned pack above about 6.2 kWh would be cut off before reaching 80 %. |
| D-8 | Low | After a release, the robot's cached `_schedulerState` can stay `ACTIVE`, which misreports state in `GET /api/simulator/status`. |

### Decisions you need to make

| # | Decision | Why it is yours |
|---|---|---|
| Q-1 | **Charge-trigger threshold** and whether it is configurable. 10 % is the current value. | This is the dead band in cause 1. |
| Q-2 | How the simulator expresses "low battery" (D-1). | `virtualRobotBehaviour.test.js:599` pins the current ISSUES behaviour as a contract. |
| Q-3 | The §23.5 energy reference (D-2/D-3). | It is a security trust boundary. |
| Q-4 | Whether a held robot may reserve a plug (D-4). | Policy on operator holds. |
| Q-5 | The target state of charge (80 %), the plug count (3), and a JSSATE charger. | Fleet configuration. Production chargers are NONE by your 2026-08-30 decision. |

---

## 2. Part A — the lifecycle as implemented

All paths are under `Backend/src/simulation/` unless stated otherwise. **VR** means `VirtualRobot.js`.

### A1. Battery initialisation

- **Restore order:** Redis `vr:battery:{id}` (if 1–100) → DB `Robot.battery` → the simulator config `initialBattery` → 100 % (VR `commission()` 852–881).
- **Who writes the Redis snapshot:**
  - the VR, every 60 ticks (2 min) — `_maybePersistBattery` 3430;
  - `telemetry.handler`, every 120 s (965–985).
- **Who writes the DB row:** the telemetry flush gate, at least every **15 s** (`legacy.liveness.db_flush_interval_ms`), and also on any ≥ 2-point swing or status change.
  → The Redis snapshot is normally *older* than the DB row, yet it wins at restart. That ordering is D-3.
- **Range:** the battery cannot be null, negative or above 100 at runtime. It is clamped at the floor `BATTERY_MIN = 5 %` (`_applyBattery` 3342), so a simulated robot never strands.
- **Physical robots:** no VR is created for them (`simulationPolicy.maySpawnVirtualRobot`). Their battery is whatever telemetry they send. The Pi has no CHARGING status and no battery ADC.

### A2. Consumption

**Formula** (`_applyBattery` 3307–3348; `constants.js` 21–22):

```
per tick (2 s):  ACTIVE or RETURNING       → 0.0444 %   (79.9 %/h)
                 IDLE, PAUSED or ISSUES    → 0.0089 %   (16.0 %/h)
                 CHARGING (incl. queued)   → 0
scaled by telemetryIntervalMs / 2000; floor 5 %
```

- **Basis.** The rate is a fixed percentage of pack per unit time, independent of distance, speed, payload or pack size. The §14.2 Wh model is wired in (`simulatedEnergy.tickEnergy`) but refuses because the β coefficients and terrain are null. The harness reports `energyBasis = LEGACY_PERCENTAGE`.
- **What that means per metre.** At the commissioned 1.5 m/s, a 500 Wh pack loses about **0.074 Wh/m (≈ 14.8 %/km)**. The engine prices 0.0793 Wh/m at 1.4 m/s, which is consistent.
- **Single loop, deterministic.** The battery changes once per tick in one loop; no second loop touches it. Speed and obstacles use per-robot seeded random streams. Ambient temperature is derived from the clock, and it only affects charging above 35 °C.
- **The ISSUES branch is inconsistent (D-5).** `ISSUES` drains at the idle rate even though the robot keeps driving at full speed (`_updateSpeed` 3027–3029). In S1b, 890 m of delivery used 2.78 points; the engine's rate would be about 13.7 points.

### A3. Thresholds

| Threshold | Value | Source | Effect |
|---|---|---|---|
| Warning | 20 % | `BATTERY_WARN_THRESHOLD` (constants.js 23) | ACTIVE → `ISSUES` (VR 3345–3346). Only while on a mission. |
| Charge trigger | ≤ 10 % | `BATTERY_CRITICAL_THRESHOLD` (constants.js 24) | `_enterCharging`, evaluated **every tick** (VR 2969–2981). Requires no mission phase, no session already in progress, and the 30 s retry interval to have passed. |
| Floor | 5 % | `BATTERY_MIN` | Hard clamp. |
| Charging interrupt | 30 % | register `legacy.dtaro.charging_interrupt_battery_pct` | Only the agent's own response to an offer or TASK_ASSIGN while charging (VR 1602, 2137). |
| Engine energy gate | per mission | F34 (§14.5 layered reserves) | TSK-816 on 500 Wh: admitted at 29 %, VIOLATED at 28 %, DENY at 20 %. |

- All simulator thresholds are hard-coded constants. They are not part of `simulationConfig`'s tunable set.
- **Crossing 10 % mid-delivery:** the robot finishes the whole mission first. There is no divert (S1b).
- **Oscillation:** none. The trigger is ≤ 10 % and the target is 80 %, so there is wide hysteresis. A session cut short (by window expiry or a legacy interrupt) leaves the robot part-charged and IDLE until it next reaches 10 % (S5b).

### A4. Chargers

- **The only charger the simulator uses** is `V1DEMO-DEPOT-01`: the depot row created by `seedV1Demonstration` / `bootstrapV1Environment`, at 12.900729, 77.517603 (RNSIT), STANDARD class, 3 plugs.
  - It is read and never written (`devChargingScheduler.js` 123, `provision` 412).
  - Its capacity comes from the scheduler's own published projection (`publishedCapacity` 565).
- **Superseded charger.** `DEV-SIM-RNSIT-MBA-01` still exists on LOCAL. Its live reservations are released as `CHARGER_SUPERSEDED`.
- **Selection.** There is no selection: one fixed charger.
  - The route is computed over the campus sidewalk network (`chargerRoute.js`), which is the same network the engine prices the return leg on.
  - Capacity is enforced inside a serialisable transaction on the charger row. Requests are queued FIFO by `reservedFrom`.
- **Contention.** Verified in S4a and S4b: the number of ACTIVE plugs never exceeded the published capacity, and the robot that could not get a plug waited docked.
- **JSSATE.** No region, charger or robot exists on LOCAL. A robot off the RNSIT network is still routed to the RNSIT depot, through an uncontained straight-line access connector (S2c: 3,250 m). This is the already-known "simulated routes uncontained" product decision.
- **Production chargers** are NONE, by your 2026-08-30 decision. The dashboard has no charger API and no charger rendering.

### A5. Route to the charger

The robot genuinely moves; it does not charge in place (VR 2336–2500).

| Phase (`_chargingPhase`) | What happens |
|---|---|
| `SEEKING` | Requests a plug. Once the plug is QUEUED or ACTIVE, asks for the campus route. |
| `APPROACHING` | Drives the route with status `RETURNING`, at the active drain rate. |
| `_dockAt` | Must be within `DOCKING_RADIUS_M = 0.01 m` of the depot. |

Failure paths:
- **Route refused** (no declaration, off the network, unusable charger): the robot releases the plug, goes IDLE and retries after 30 s. It never charges in place (D-6).
- **Held robot:** a PAUSED robot stays in APPROACHING without moving (D-4).

Dashboard visibility: the position moves on the map through `robot:update`, but **the charger route is never sent to the dashboard**. The robot stays at the depot after charging.

### A6. Charging progression and duration

- **Start condition.** Docked within the radius and the reservation ACTIVE. QUEUED means docked and waiting at 0 % per tick (VR 2664–2700).
- **Rate.** The CC/CV curve `CHARGE_POWER_CURVE` (constants.js 67–86): 2000 W up to 80 % SoC, then 900 / 400 / 120 W. It is integrated through `engine/energy/chargeCurve`, the same integrator the server plans with. Temperature derating is 1.0 between 15 and 35 °C and 0.7 at 45 °C. Pack temperature in the harness was 30–31.4 °C.
- **Target.** The offer's `targetSoc`, otherwise the fallback **0.8**. Reaching it ends the session (VR 2731–2760). The battery never decreases while charging.

| Pack | Charge | Simulated time |
|---|---|---|
| 500 Wh | 10 → 80 % | **630 s (10.5 min)** at 15–35 °C; 900 s at 45 °C |
| 500 Wh | 10 → 100 % | 1,289 s |
| 465 Wh | 10 → 80 % | 586 s |
| Measured (S1a) | 9.05 → 80 % | 640 s |
| Measured (S1a) | whole cycle, threshold → IDLE | 688 s: drive 62 m (44 s) + dock + charge |

LOCAL history agrees: the old charge-in-place sessions lasted about 10.5 min.

- **Scaling.** The charge step scales with the tick period. There is no time multiplier, so everything runs in real time.
- **No one-tick charge.** Dock → WAITING → CHARGING takes at least two ticks, and each charging step is about 0.22 percentage points.
- **Leaving the dock** abandons the session: no charge rises away from the charger (VR 2667–2672).

### A7. Completion and return to service

At the target, `_clearCharging(TARGET_REACHED)` releases the plug. The release promotes the next queued robot within the same call.

- **Status after charging:** `IDLE`, or `PAUSED` if a STOP was latched during the session.
- **Missions:** any mission deferred by the legacy path is resumed. No engine mission is ever held through a charge, because charging only starts with no mission.
- **Route:** cleared.
- **Position:** the robot **stays at the depot**.

Back in the pool:
- The availability index sees no reservation, so the robot is IDLE_READY.
- F18 is satisfied, but only once a telemetry frame is accepted. D-2 delays this by about 2–7.5 min.
- If the robot ever reported `ISSUES`, it never returns to the pool (D-1).

Other session endings:
- **Reservation window** (`reservedUntil`): 7,868 s (2 h 11 min), computed for 1000 Wh at −10 °C. After it, `reconcile` (every 10 s) expires the reservation and the robot stops part-charged (S5b).
- **Restart:** the surviving reservation is adopted (S5a: `RESUMED_AT_CHARGER`, then charged to 80 %).

**State machine** (scheduled path):

```
IDLE ──(≤10 %, no mission, not CHARGING, retry elapsed)──▶ SEEKING (status unchanged: IDLE or PAUSED)
SEEKING ──plug QUEUED/ACTIVE──▶ route? ──no──▶ release(AGENT_RELEASED) → IDLE, retry in 30 s
                                   └──yes──▶ APPROACHING (RETURNING; PAUSED holds position)
APPROACHING ──arrive ≤0.01 m──▶ CHARGING/WAITING ──plug ACTIVE──▶ CHARGING/CHARGING
CHARGING ──battery ≥ target──▶ release(TARGET_REACHED) → IDLE (or PAUSED if a STOP latched)
CHARGING ──reservation gone (expiry/reconcile)──▶ IDLE part-charged
any approach ──TASK_ASSIGN/OFFER accepted──▶ release(AGENT_RELEASED) → mission
```

---

## 3. Part B — assignment eligibility

**The engine path.** The coordinator round assembles candidates through `indexMaintainer.assembleRecord` and then evaluates the predicates.

**Manual assignment.** `POST /api/tasks/assign` goes through engine intake and ignores a nominated `robotId` (`task.service.js` 1010).

**Legacy TASK_ASSIGN.** The restart sweep runs only when the engine is off (`legacyTaskRedispatch.service.js` 98).

| Robot state | New task via engine? | Existing task | Race with transition | Engine vs dashboard |
|---|---|---|---|---|
| Low (10–29 %), idle | **Mission-dependent.** Index IDLE_READY; F34 denies when the reserves don't fit. | — | — | Dashboard shows IDLE; the engine may refuse every task. **Disagree.** |
| < 20 % on a mission | Continues. Later work is denied by F09 (ISSUES = MARGINAL; V1 requires NOMINAL, `v1DemonstrationProfile.js` 54). | Kept | — | Agree on ISSUES, but it is permanent (D-1). |
| SEEKING, before the plug commits | Index IDLE_READY and F18 satisfied for one DB round trip; F34 denies at ≤ 10 %. | None (only starts with no mission) | Theoretical; covered by F34 | Dashboard IDLE; engine IDLE → excluded within ms. |
| SEEKING / APPROACHING with a plug | **No.** `chargingStatus` gives charging:true → `classify` returns null (`availabilityIndex.js` 160); F18 VIOLATED (S1a probes). | None | No. F18 is in the volatile subset, rechecked at commit. | Dashboard IDLE (SEEKING) or RETURNING; engine unavailable. **Disagree on SEEKING.** |
| Queued at the charger | **No.** waiting:true → not indexed (`indexMaintainer.worker.js` 282); F18 VIOLATED. | — | No | Dashboard CHARGING (no current flows); engine unavailable. |
| Charging | **No.** Not indexed; F18 VIOLATED on the reservation **and** on `SELF_REPORTED_CHARGING` (`agentFacts.service.js` 219) (S3). | — | No | Agree. |
| After charging | Yes once the reservation is released, but F18 (stale self-report) and F16 (stale position) deny until a frame is accepted (D-2). | — | — | Dashboard frozen at CHARGING; engine unavailable for up to ~7.5 min. |

**Can a charging or charger-bound robot be assigned through another path?**
- **Through the engine:** no. `chargingInterruptible` is always `false` (`chargingStatus.service.js`), so the §6.3 tier-5 "charging interruptible" class is never populated.
- **Agent side:** if an OFFER or legacy TASK_ASSIGN did reach a charging robot at ≥ 30 %, the VR would **accept and abandon the charge** (S3: OFFER_ACCEPT at 45 %, reservation `RELEASED:AGENT_RELEASED`). Below 30 % it defers. An approach to the charger is likewise abandoned on any accepted assignment (VR 2155–2159).
  - Through the engine this is unreachable. Through the legacy sweep it is reachable, but only with the engine off.
  - This is a defence-in-depth gap rather than a live defect. I recommend no change unless the legacy path is to be used.
- **Reconnect:** the reservation outlives the socket, and the CHARGING self-report disappears when frames stop. Exclusion therefore rests on the reservation row, which is durable.

---

## 4. Part C — data path and consistency

```
VR._tick → TELEMETRY {battery, status (raw), lat/lon, timestamp, sequence}
  → telemetry.handler: §23.5 position/energy check (refuse ⇒ drop whole frame, 539)
    → KV robot:{id} (15 s TTL) + registry:{id} (raw status, read by agentFacts for F18)
    → DB Robot: status = toPersistedStatus(raw) (RETURNING→ACTIVE, CHARGING→not stored),
                health-tier rises refused when engine on (573–598); flushed ≥2 %/15 s/status change
    → broadcast robot:update {status: displayedStatus(DB, raw)} (1039)
  → Frontend AppProvider.onRobotUpdate (824–841) merges battery/status → RobotsPage card + side panel
REST: GET /api/robots/state = DB row + KV overlay with the same displayedStatus (robots.controller.js 243)
```

- **What the dashboard shows during charging.** CHARGING is broadcast (it ranks NOMINAL) over a DB status of IDLE or ACTIVE (harness C2). It is **never** shown over PAUSED or ISSUES (C1: ISSUES throughout charging).
- **List vs detail.** The list card and the detail panel use the same `robots` state and the same `isCharging()`, so they are consistent with each other. Both mis-style PAUSED as charging (U-1).
- **Polling.** There is none; refreshes are driven by events. The robot-list and detail views cannot overwrite newer socket data with stale polls.
- **Overrides.** One deliberate local override exists: a terminal task event sets the robot `IDLE` (`AppProvider.jsx` 985), which can briefly show IDLE over a backend ISSUES or PAUSED (U-6).
- **Timestamps.** Battery and status come from the same frame. The DB copy lags by up to 2 points or 15 s, and that lag is the root of D-2 and D-3.
- **What is never shown.** Charging phase, reservation state, target, charger and queue position are all exposed by `GET /api/simulator/status` but **never read by the frontend**. SEEKING is invisible (the status stays IDLE).

---

## 5. Part E — scenario traces (harness; simulated time)

### S1a — normal low battery

**Setup:** an idle robot at SIM-0A8C's real LOCAL position, 47 m from the depot; 10.3 %; 500 Wh; 1.5 m/s.

| t (s) | Status / phase | Battery | Distance to depot | Reservation | Index | F18 |
|---|---|---|---|---|---|---|
| 0 | IDLE / — | 10.30 | 47 m | none | IDLE_READY | SATISFIED |
| 70 | IDLE / SEEKING | 9.99 | 47 m | ACTIVE | excluded | VIOLATED |
| 72 | RETURNING / APPROACHING (route 62 m) | 9.98 | 47 m | ACTIVE | excluded | VIOLATED |
| 116 | CHARGING / WAITING (docked) | 9.05 | 0 | ACTIVE | excluded | VIOLATED |
| 118 | CHARGING / CHARGING | 9.05 | 0 | ACTIVE | excluded | VIOLATED |
| 758 | IDLE / — | 80.0 | 0 | RELEASED: TARGET_REACHED | IDLE_READY | SATISFIED |

**Result:** works.

### S1b — delivery crossing the threshold

**Setup:** start at 12 % with a 445 m + 445 m legacy TASK_ASSIGN.

- The robot was `ISSUES` from the first tick.
- It crossed 10 % at t = 442 s, in `TO_DROP`, and did not divert.
- It completed the task at 9.22 % (t = 616 s), sought a plug on the next tick, and charged to 80 % by t = 1310 s.
- It used 2.78 points in total for 890 m (D-5).

### S2 — no usable charger

**S2a — no charger row at all.** Provisioning refused, so no plug can be granted. Over 30 min:
- the robot stayed `IDLE` / SEEKING and drained to the 5 % floor;
- the scheduler's projection was read **900** times and **902** warning lines were logged;
- telemetry said IDLE throughout;
- the index showed IDLE_READY and F18 was SATISFIED (F34 is then the only gate);
- nothing reached the dashboard.

**S2b — depot present, no declaration.** The route was refused with `NO_DELIVERY_DOMAIN`. Over 30 min, **57** reservation rows were created and released (`AGENT_RELEASED`), and the robot ended IDLE at 5 %.

**S2c — robot 3.7 km off campus.** A route *was* produced, including a 3,250 m straight-line access connector. After 10 min the robot was still driving, at the 5 % floor.

### S3 — assignment while charging

**Gates.** Charging status `{known: true, charging: true, interruptible: false}`; index class `null`; F18 VIOLATED on the reservation alone and on the self-report alone.

**Battery** kept rising over the same 30 ticks: 9.98 → 16.65 %.

**Agent side:**
- An OFFER at 25 % was answered with `OFFER_DEFER (CHARGING_BELOW_INTERRUPT_THRESHOLD)`, and the robot kept charging.
- An OFFER at 45 % was answered with `OFFER_ACCEPT`: the charge was abandoned and the plug released.
- A legacy TASK_ASSIGN at 45 % had the same effect.

### S4 — contention

**S4a — 4 robots at once, 3 plugs.**
- Three robots ACTIVE and one QUEUED.
- The fourth drove to the depot and waited **322 ticks (10.7 min)** docked. Its status was `CHARGING` but its battery stayed flat at 9.05 %.
- When the first three released at t = 690 s, the fourth was promoted and finished at t = 1332 s.
- The ACTIVE count never exceeded 3.

**S4b — published capacity set to 1, 2 robots.** At most 1 ACTIVE at any time; strict FIFO.

### S5 — completion and restart

**S5a — restart mid-charge (40.2 %).** The new process adopted the surviving reservation (`RESUMED_AT_CHARGER`), charged to 80 % in 181 ticks, and released it as `TARGET_REACHED`. There was still only one reservation row.

**S5b — paused longer than the window (7,680 s remaining).** `reconcile` expired the reservation, and the robot stopped part-charged at 29.8 %, IDLE. It will not seek again until 10 %.

**S5c — held robot.** SIM-0A8C's LOCAL state: `OFFLINE`, held `PAUSED`, 10.4 %.
- After 92 s it reserved an ACTIVE plug.
- It stayed `PAUSED` / APPROACHING **without moving for 60 min**, draining to 5 %.
- Its plug stayed ACTIVE until the window end, 2 h 11 min later (D-4).

### C — server persistence and broadcast (real `telemetry.handler`, engine on)

**C1 — a robot that reported ISSUES.** Reports sent: ACTIVE → ISSUES → IDLE → RETURNING → CHARGING → CHARGING → IDLE. The DB status was **ISSUES at every step from the second onward**, and so was the broadcast. The handler logged "Self-reported health refused … ISSUES → IDLE".

**C2 — a normal session.** The broadcast went IDLE → RETURNING → CHARGING, while the DB went IDLE → ACTIVE → ACTIVE.

**C3 — the real frames of one charge session.**
- At the target the DB battery stood at 79.3 %, against the robot's reported 80.0 %.
- **73 consecutive frames were refused** ("state of charge rose while not charging"), equal to **146 s** of simulated time.
- **71 `SECURITY_EVENT`s** were emitted at the register default threshold of 3.
- The first frame accepted again was at 79.3 %.

**C4 — restart.** Restored from Redis at 50.5 % with the DB at 50.0 %: **50 frames refused**, 48 `SECURITY_EVENT`s.

---

## 6. Part F — findings

### Confirmed defects

**D-1 — the ISSUES low-battery label becomes a permanent hold. High.**

The chain:
1. The VR reports `ISSUES` when its battery is below 20 % while ACTIVE (`VirtualRobot.js` 3345–3346).
2. That status is persisted as MARGINAL.
3. With the engine on, every later report (IDLE, ACTIVE via RETURNING, or CHARGING) would raise the tier, so P14-R15 refuses it (`telemetry.handler.js` 573–598).
4. Task completion releases only IDLE or ACTIVE (`taskCompletion.service.js` 44).
5. Clear-fault refuses ISSUES with "not in a fault state" (`robots.controller.js` 730–733).
6. F09 requires NOMINAL for V1 (`v1DemonstrationProfile.js` 54).

The result is that the robot is out of service for good, and it displays ISSUES even while charging. The only escape is an API-only sequence: STOP → RESUME → clear-fault, which goes through `placeOperatorHold` and the PAUSED branch.

**How it arises in practice.** F34 admits a mission whose energy ends below 20 % (TSK-816 starting at 29 % ends at about 15 %). **Reproduction:** harness C1 + S1b.

**Expected:** a low-battery warning should not require operator recovery once the robot has recharged. **Fix options (Q-2):**
- (a) **Recommended, smallest.** The VR stops encoding low battery as `ISSUES`. The battery is reported numerically, and F34 is the authoritative energy gate. This changes the contract pinned at `virtualRobotBehaviour.test.js:599`.
- (b) A clear-fault branch for ISSUES, with the same live-evidence checks as the PAUSED branch.

Do not relax §23.5. **Regression test:** an engine-on telemetry sequence where a delivery drops below 20 %, then the robot charges and reports IDLE. The robot must be assignable again, so F09 must pass.

**D-2 — the end of a charge is refused by the §23.5 energy row. High.**

`assessAgentReport` measures the change in SoC against `existing.battery` (`telemetry.handler.js` 213–222). That value is the DB row, flushed only on a ≥ 2-point swing, every 15 s, or on a status change. The VR's final tick reports `IDLE` at a SoC above that stale value: `CHARGING 79.9` → `IDLE 80.0`, against 79.3 in the DB. The rise is judged "while not charging", and the frame is refused.

The refusal continues until idle drain brings the battery below the DB value:
- **73 frames (146 s)** reproduced in C3;
- **about 225 frames (7.5 min)** in the worst case of a 2-point gap.

Refused frames are dropped before anything else happens (539): no `robot:update`, no registry update (so the stale CHARGING self-report keeps F18 denying), no position Observation (so F16 goes stale), and `SECURITY: persistent implausibility` logged at error level on each frame.

**Expected:** compare against the **last accepted report**. That reference is also *stricter*: today a genuine rise below a stale, higher DB value is admitted. **Regression test:** the C3 frame sequence produces zero refusals, while a real rise relative to the previous frame is still refused. Needs your sign-off (Q-3).

**D-3 — restart restores the older battery value. Medium.**

`commission()` prefers Redis (snapshot up to 120 s old) over the DB row (up to 15 s old). The restored, higher SoC is refused exactly as in D-2: C4 lost 50 frames. **Fix:** restore the lower of the two values, or prefer the DB row. That is the conservative choice and never asserts energy a newer record says is gone. **Regression test:** C4.

**D-4 — a held robot reserves and keeps a plug. Medium.**

The tick trigger (VR 2969–2981) does not exclude `PAUSED`. The approach then holds its position while keeping the plug (2409, `_adoptChargerRoute`). In S5c one of three plugs was blocked for 2 h 11 min. In addition, `_schedulerState` is not refreshed during the approach, so a later RESUME can dock and draw one tick of current after the reservation has expired.

**Fix:** do not start a session while PAUSED, and release on a hold (Q-4). **Regression test:** S5c.

**D-5 — ISSUES drains at the idle rate while driving. Medium.**

The rate selection (VR 3311) keys on the status label instead of on movement. `constants.js` 22 documents it, but it contradicts `_updateSpeed` 3027–3029, under which ISSUES is a navigating state. The low-battery tail of each delivery therefore costs about 5× less than the engine predicted (S1b).

**Fix:** use the active rate whenever the robot is navigating. This disappears if D-1 option (a) is taken.

**D-6 — no back-off and no visible reason when charging is impossible. Low/Medium.**

S2a: one projection read and one warning per tick, indefinitely. S2b: about two reservation rows per minute. **Fix:** exponential back-off, plus a reason surfaced in the simulator status and on the dashboard.

**D-7 — the reservation window ignores the robot's pack. Low, latent.**

The scheduler computes the window for a fixed 1000 Wh pack (`devChargingScheduler.js` 420/772/920). Charging 10 → 80 % exceeds the 7,868 s window for any pack above about 6.2 kWh, and commissioning allows packs up to 200 kWh. LOCAL units are 465–500 Wh, so nothing is affected today.

**D-8 — stale scheduler state after release. Low.**

The timelines (S1a, S4) show `_schedulerState = ACTIVE` after the reservation was released. A pending state read resolves after `_clearCharging`. Only `GET /api/simulator/status` is affected.

### Missing implementation (V1-relevant)

| ID | Missing | Minimum to add |
|---|---|---|
| M-1 | Coupling between "no longer dispatchable" and "go charge" (cause 1) | A configurable charge-trigger threshold in `simulationConfig`, with its value chosen by you (Q-1). Keep the 80 % target as hysteresis. |
| M-2 | Dashboard charging visibility | Read `chargingPhase`, `chargingReservationState` and `chargingRecovery` from `GET /api/simulator/status` (already served). Show *Seeking charger / Driving to charger / Queued / Charging → 80 %*. |
| M-3 | A reason for unavailability per robot | Show the dominant denial (F34 energy, F09 health, F18 charging) next to the robot. The P1.1 rejection observability data already exists per task. |
| M-4 | A JSSATE charger | Owner configuration (Q-5). Until then, a JSSATE simulated robot has nowhere valid to charge. |

### Product and design decisions

These are Q-1 to Q-5 in §1. None of the values above was chosen by this audit. 10 %, 20 %, 30 %, 80 % and 3 plugs are all **existing** values, as cited.

### Dashboard and UX defects

| ID | Defect | Location |
|---|---|---|
| U-1 | `isCharging()` returns true for **PAUSED**, so held robots get the charging card tone while discharging. | `Frontend/src/lib/robotStatus.js` 17–19; `RobotsPage.jsx` 138–144, 285–293 |
| U-2 | No "Charging" filter; "Low Battery" means < 25 %, unrelated to the 10 % trigger or the F34 level. | `RobotsPage.jsx` 66, 91 |
| U-3 | SEEKING shows as IDLE. RETURNING to a charger gets the amber idle tone. Queued at the charger shows as CHARGING with no current. No target, ETA, charger or queue position anywhere. | `RobotsPage.jsx` 138–144; `robotVisual.js` 63/66 |
| U-4 | After a charge the card freezes at CHARGING ~79.9 % for minutes (D-2). | — |
| U-5 | A robot holding ISSUES shows ISSUES throughout its charge (D-1). | — |
| U-6 | A terminal task event locally overwrites the status with IDLE, flickering over a backend ISSUES or PAUSED. | `AppProvider.jsx` 985 |
| U-7 | Neither the charger nor the route to it is drawn on the map; there is no charger API. | — |

### Evidence limitations

- **No live run.** LOCAL robots have been offline since 2026-10-10 13:31Z. **Your dashboard observation was not reproduced live**; cause 3 is inferred from the DB state and the code.
- **Neon and Render** were not inspected.
- **The F34 crossover** (29 %) is for TSK-816 on a 500 Wh pack only. It depends on the mission.
- **Concurrency:** the in-memory store does not model PostgreSQL SERIALIZABLE behaviour. Concurrent plug requests are covered by `devChargingScheduler.test.js`.
- **Harness compression:** the harness fed telemetry at about 110 ms intervals and rebased timestamps to real time. The refusal counts depend only on SoC deltas, not on timing.
- **Physical charging** (rate, location, docking tolerance) is unknown. The Pi reports no CHARGING status and has no battery ADC. Every number here is simulation configuration, not a measurement.

---

## 7. Part D — simulation model classification

| # | Capability | Classification |
|---|---|---|
| 1 | Consumption by distance / idle time | **Implemented but defective.** Time-based legacy percentage; the §14.2 model refuses; ISSUES rate wrong (D-5). Optional later: the Wh model once β is declared. |
| 2 | Energy for the trip to the charger | **Implemented and verified.** RETURNING drains at the active rate (S1a: 0.93 points over 62 m). |
| 3 | Charger capacity and occupancy | **Implemented and verified** (S4a, S4b). |
| 4 | Selection by network distance or time | **Optional for later.** One charger; route over the network, verified. |
| 5 | Explicit low / travel / queue / charging / post-charge states | **Implemented but defective.** Present internally (`_chargingPhase`), lost on the wire: SEEKING → IDLE, queued → CHARGING (U-3, M-2). |
| 6 | Configurable target state of charge | **Implemented.** Published `targetSoc`, fallback 0.8. Verified. |
| 7 | Consistent rate and predictable duration | **Implemented and verified.** Shared curve; 630 s for 10 → 80 % at 500 Wh. |
| 8 | Defer or reassign when energy is insufficient | **Implemented** (F34 at the engine). No mid-mission divert; the 5 % floor makes this moot in simulation. |
| 9 | No threshold oscillation | **Implemented and verified** (10 % → 80 % hysteresis). |
| 10 | Clock scaling, pause/resume, reset | Tick-period scaling consistent; **no time multiplier (missing, important for demos)**; restart verified (S5a); a long pause gives a part charge (S5b); D-3. |
| 11 | Fair access, no starvation | **Implemented and verified.** FIFO by `reservedFrom`; promotion on release. |
| 12 | No assignment to charging / charger-bound / queued robots | **Implemented and verified** on the engine path (index + F18). Agent-side gap is legacy-only. |
| 13 | Explanation of unavailability | **Missing; important for V1** (M-3). |
| 14 | ETA, charger, queue, trend on the dashboard | **Missing; important for V1** (M-2). |
| 15 | Throughput and downtime metrics | **Optional for later.** Reservation rows already give per-session wait and duration. |

---

## 8. Part G — direct answers

| # | Question | Answer | Status |
|---|---|---|---|
| 1 | Battery % that triggers charging | **≤ 10 %** (`BATTERY_CRITICAL_THRESHOLD`), only with no mission. The engine itself stops offering work much earlier (F34; ~29 % for TSK-816). | Verified |
| 2 | Finish the task first? | **Yes, always.** No divert. Below 20 % it reports ISSUES and continues; the battery floors at 5 %. | Verified (S1b) |
| 3 | Where does it charge? | `V1DEMO-DEPOT-01`, the RNSIT demonstration depot at 12.900729, 77.517603, within 0.01 m. It stays there afterwards. | Verified |
| 4 | Chargers configured for RNSIT and JSSATE? | RNSIT: the depot only, a development configuration (LOCAL also has the superseded DEV-SIM row). JSSATE: **none**. Production chargers are NONE by owner decision. | Verified (LOCAL read-only); Neon unknown |
| 5 | How is a charger selected? | It is not: one fixed charger. The plug comes from a FIFO queue with 3 plugs; the route is the campus sidewalk network. | Verified |
| 6 | Consumption | 0.0444 %/tick moving (79.9 %/h, ≈ 14.8 %/km at 1.5 m/s on 500 Wh); 0.0089 %/tick idle, paused or ISSUES (16 %/h); 0 while charging. Not distance- or payload-based. | Verified |
| 7 | Charging rate | CC/CV: 2000 W to 80 %, then 900 / 400 / 120 W; derating 1.0 at 15–35 °C. Simulation configuration, not hardware. | Verified |
| 8 | Time from threshold to target | 10 → 80 %: **630 s** (500 Wh), 586 s (465 Wh); whole cycle including a 62 m drive ≈ **11.5 min**; plus queue time if plugs are full (S4a: +10.7 min). | Verified |
| 9 | New delivery while charging | Engine never offers: not indexed; F18 denies on the reservation and the self-report. | Verified (S3) |
| 10 | Alternate API or async path? | Manual assign goes through the engine and ignores the nominated robot. Legacy TASK_ASSIGN (engine off only) or a stray OFFER at ≥ 30 % **would** interrupt the charge agent-side. | Verified (S3); legacy path code-read |
| 11 | Physical movement or in place? | **Moves**, over the campus network, to the depot. Recovers in place only on the legacy unscheduled path (no Agent row). | Verified |
| 12 | Why continuous discharge without visible charging? | Dead band 29 → 10 % (~70 min idle); real time only (5.6 h idle to 10 %); LOCAL robots held PAUSED and styled as charging; ISSUES lock; post-charge freeze. | Verified causes; your specific observation not reproduced |
| 13 | Robot list while charging | `CHARGING` (blue) if the DB status is IDLE or ACTIVE; `ISSUES` if it is ISSUES; `PAUSED` (also blue) if held. Consistent with the backend's displayed status, but SEEKING, queued and ETA are not shown. | Verified (C1/C2, code) |
| 14 | No charger / occupied / unreachable | No charger: seeks forever, IDLE, unexplained. Occupied: queued and docked, FIFO. Unreachable: released, retried every 30 s, unexplained. Off-network: an uncontained straight access line. | Verified (S2a–c, S4) |
| 15 | Return to the pool | At the 80 % target: plug released, IDLE at the depot, indexed IDLE_READY. Effectively assignable only after the post-charge refusal clears (D-2), and never if it ever held ISSUES (D-1). | Verified |
| 16 | Stuck, overlap, or unreleased plug? | **Plugs:** releases verified on every exit; expiry backstop at 2 h 11 min. **Stuck:** a held robot keeps its plug (D-4); ISSUES is permanent (D-1). **Overlap:** a stale `_schedulerState` (D-8). Does not get stuck in CHARGING. | Verified |
| 17 | Fix immediately | D-1, D-2 (+ D-3), D-4, then U-1. | — |
| 18 | Three highest-value V1 improvements | (1) A configurable charge trigger aligned with dispatchability (Q-1). (2) Fix D-1/D-2 so a recharged robot returns to service. (3) Dashboard charging state + reason for unavailability (M-2, M-3, U-1). | — |

---

## 9. Recommended V1 fix plan, smallest first, in priority order

Nothing will be implemented until you authorise it. Each step needs a failing regression test first, built from the harness scenario named.

1. **D-1** — the ISSUES lock. Decide Q-2; recommended: the VR stops emitting ISSUES for low battery, which also removes D-5. Regression: harness C1 / S1b through the engine-on handler.
2. **D-2 + D-3** — the energy-row reference. Measure against the last accepted report, and restore the lower of Redis and DB at commission. Regression: C3 and C4 sequences with zero refusals, plus a real rise still refused. Needs Q-3 sign-off.
3. **Q-1 / M-1** — make the charge trigger a `simulationConfig` parameter. You choose the value; the code default stays 10 % until you do. Regression: an idle robot at the chosen level seeks a plug.
4. **D-4** — no charging session while PAUSED; release the plug on a hold. Regression: S5c.
5. **U-1 + M-2 (+ M-3)** — dashboard:
   - `isCharging` = CHARGING only;
   - a charging-phase badge, target and queue position from `/api/simulator/status`;
   - a "Charging" filter;
   - a short reason when a robot is unavailable.
   Frontend only; the engine and gates are unchanged.
6. **D-6, D-7, D-8** — back-off and a visible reason; a window per commissioned pack; clear `_schedulerState` on a late resolve.

**Explicitly not recommended:**
- weakening F18, F09 or F34, or §23.5's health rule;
- making charging "interruptible" for the engine;
- a multi-charger selection model;
- adding a time multiplier before Q-1 is decided (it would only hide the dead band).

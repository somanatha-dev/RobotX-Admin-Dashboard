# Autonomy Gap Analysis — Required versus Actual

Snapshot 2026-10-17. Being able to connect, receive GPS, or move under a manual command is **not** autonomy.
Each stage below is judged against the behaviour a supervised pilot needs, using the
[audit vocabulary](README.md#status-vocabulary-used-identically-in-every-document). "Level" is the highest
verification reached for that stage.

## Summary

| # | Stage | Actual | Level |
|---|---|---|---|
| 1 | Backend assigns a pickup/drop mission | Engine OFFER over Socket.IO | INTEGRATION-TESTED (software) |
| 2 | Pi receives and validates the offer | HMAC, fence, sequence, expiry, two-stop shape | INTEGRATION-TESTED (cross-repo vector) |
| 3 | Pi confirms localisation readiness | measured fix + hAcc ≤ 5 m required to accept | UNIT-TESTED; HW UNVERIFIED |
| 4 | Pi validates destination and route feasibility | shape and coordinate validity only | PARTIALLY IMPLEMENTED |
| 5 | Pi plans or obtains a route | obtains it from the backend; never plans | IMPLEMENTED (obtain); planning NOT IMPLEMENTED |
| 6 | Pi executes navigation decisions | waypoint following, GPS-track heading, camera avoidance | UNIT-TESTED; HW UNVERIFIED |
| 7 | ESP32 enforces sensor safety and controls motors | per-wheel gate, watchdog, latch | INTEGRATION-TESTED (host sim); motor map HW-verified per comment; **RX-01/02/05** |
| 8 | Pi consumes localisation and perception feedback | GPS yes; camera yes; ESP32 ranges **no** | PARTIALLY IMPLEMENTED |
| 9 | Pi handles obstacles, stale data, GPS loss, comms loss | stops safely; recovery mostly manual | PARTIALLY IMPLEMENTED |
| 10 | Pi replans or safely stops | stops; **never replans**; gets stuck | PARTIALLY IMPLEMENTED (stop only) |
| 11 | Pi detects arrival and manages handover | 8 m arrival; human custody confirmation | IMPLEMENTED; handover needs an operator |
| 12 | Pi reports completion or failure | TASK_COMPLETE with evidence self-check; failures implicit | PARTIALLY IMPLEMENTED |
| 13 | Backend records the final state | graded completion, settlement, Task COMPLETED | UNIT-TESTED (backend) |

**Overall verdict:** a complete *software* path exists and is covered by unit and integration tests, plus a
reported Gate 3/3b run with a simulated ESP32. On the physical rover the path is **UNVERIFIED end to end**.
Several stages either stop permanently (10) or require an operator (7, 9, 11) in ordinary situations.

## Stage detail

### 1. Backend assigns a mission
- **Expected:** a task becomes a commitment for a capable robot, delivered reliably with a deadline.
- **Actual:** intake → engine round → Leg/commitment → outbox → `OFFER` emitted under its own event name to `robot:{id}` (`commandDispatcher.service.js:213-317`). A physical robot is a candidate only with the physical fleet declaration, a fresh SoC, an accepted fix near a campus way, an unengaged stop latch and a recent probe (`docs/runbooks/physical-fleet.md`).
- **Missing:** a backend configured for physical robots (RX-11); a dashboard SoC UI.
- **Failure behaviour:** undeliverable → the outbox row stays PENDING; an expired offer is withdrawn by the TTL timer (20 s default).
- **Acceptance:** a supervised run in which the declared rover receives an OFFER whose signature the Pi admits (`engine_commands_admitted` +1 in `/backend`).

### 2. Pi receives and validates the offer
- **Actual:** `backend_link.py:1433-1512`; `engine.py:278-492`. Answers exactly once; the answer is persisted before it is sent.
- **Level:** cross-implementation signature vector reproduced today; Pi unit tests passed.
- **Missing:** the deployed key must match (manual).
- **Acceptance:** `OFFER_ACCEPT`/`REJECT` observed by the backend for a live offer.

### 3. Localisation readiness
- **Expected:** a fresh, accurate, measured fix and a usable heading before committing.
- **Actual:** `assess_offer` requires a measured fix with `has_fix` and the navigator's hAcc ≤ 5 m (`agent.py:530-534`). **Heading readiness is not checked.** The rover establishes heading by creeping forward after acceptance.
- **Missing:** a hardware-validated ESP32 GPS path (RX-14); a heading source while stationary (no IMU/compass).
- **Failure:** reject `NO_POSITION_FIX`.
- **Acceptance:** outdoors, `/state` shows `gps.status FIX`, `position.h_acc_m ≤ 5` and `fix_type "3D"` for more than 95 % of 1 s samples over 10 min.

### 4. Destination and route feasibility
- **Expected:** reject routes the rover cannot physically drive; check the start is near the path.
- **Actual:** coordinate, shape and length validation only (`mission/mission.py:134-288`). No check that the rover is near the first segment, of geofence, or of terrain. The backend checks campus-way containment and snap radius for physical routes (`physicalPolicy.js`, `routeContainment.js`).
- **Missing:** a Pi-side "distance to path start" check; a corridor check before departure.
- **Acceptance:** an offer whose path starts more than X m from the rover is rejected with a reason.

### 5. Route planning
- **Expected:** a route, ideally with a way to obtain a new one.
- **Actual:** backend-supplied paths only (`mission/manager.py:23-29`). Google Directions client present but unused. Backend reroute refused for engine tasks (409). Engine `REROUTE` envelope is a no-op on the Pi.
- **Status:** obtaining a route is IMPLEMENTED; replanning is NOT IMPLEMENTED anywhere in the robot path.
- **Acceptance (future):** a blocked leg yields a new signed path or an explicit escalation, never a silent stall.

### 6. Navigation execution
- **Actual:** 10 Hz loop; waypoint 8 m arrival; proportional steering on GPS-track heading error; creep at 0.25 when heading is unknown; perception gating (`decision.py:106-225`).
- **Gaps:** heading accuracy (RX-10); MOG2 false positives (RX-23); the speed mapping from normalised units to m/s is uncalibrated; start grace 60 s (RX-20).
- **Acceptance:** on a test field, a 3-waypoint 50 m route completes with cross-track error ≤ 3 m p95 and no operator input.

### 7. ESP32 safety and motor control
- **Actual:** per-wheel gate every loop pass; front stop 40 cm (both sensors required valid); rear stop 250 mm (all three required valid); watchdog 2 s; blocked commands cleared and latched (`safety.cpp:934-958`, `robot_controller.ino:242-300`).
- **Gaps:** loop blocking (RX-01, RX-06); stop ordering (RX-02); ungated reverse when rear is absent (RX-05); uncalibrated ultrasonic distances; front sensor state (RX-04).
- **Acceptance:** on blocks: an obstacle at 35 cm gates forward within 150 ms; Pi silence stops output at 2.0 ± 0.1 s; a faulty rear sensor never makes TELEMETRY gaps exceed 400 ms.

### 8. Feedback consumption
- **Actual:** GPS → navigation; camera → decision; ESP32 `front_valid`, `safety_stop`, `command_timeout` and `motor_drive_available` → refuse DRIVE / pause. Ranges and obstacle flags are **unused** (RX-07).
- **Acceptance:** Pi decisions change (slow/stop) on ESP32 range data before the ESP32 gate engages.

### 9. Handling obstacles, stale data, GPS loss, comms loss

| Condition | Behaviour | Auto-recovers? | Evidence |
|---|---|---|---|
| Camera obstacle (small, off-centre) | slow | yes | `decision.py:194-198` |
| Camera obstacle (centre, large) | STOP → after 3 ticks `REROUTE_NEEDED` | **no** (RX-08) | `agent.py:933-934` |
| ESP32 front obstacle | ESP32 gate + latch → Pi pause | **no** (RX-03) | sim test |
| Perception stale or failed | STOP | yes | `decision.py:117-125` |
| GPS lost / hAcc > 5 m | STOP | yes | `decision.py:133-138` |
| ESP32 telemetry stale | pause | **no** (RESUME) | `agent.py:843-856` |
| Backend lost > 10 s | pause | **no** (backend RESUME) | `backend_link.py:1983-2011` |
| ESP32 reboot | e-stop latch | **no** | `agent.py:416-418` |

### 10. Replan or safely stop
- **Actual:** safe stop is always available (fail-closed decision, gate and ESP32). Replanning does not exist, and the stop can become permanent for the leg (RX-08).
- **Acceptance:** see RX-08.

### 11. Arrival and handover
- **Actual:** arrival at 8 m on a measured position (`route_planner.py:398-410`); the backend independently verifies arrival on its own observations (radius from `VERIFY_ARRIVAL_RADIUS_M`). Handover requires an operator calling `POST /mission/custody` on the Pi (`main.py:283-302`), at a measured arrival only.
- **Gap:** no non-shell custody path (RX-12). The 8 m Pi radius against a 25 m example backend radius is consistent (the Pi is stricter).

### 12. Completion or failure reporting
- **Actual:** `TASK_COMPLETE` only after RELEASED is reported and the Pi's own L1 check passes (`backend_link.py:1768-1834`). Failures are **not reported explicitly**: rejections answer offers; a stuck or paused mission is visible only through telemetry `status` and the absence of progress. `ROBOT_FAULT` and `OBSTACLE_REPORT` are never emitted (RX-21).
- **Gap:** after a Pi restart the completion evidence is lost (RX-13).

### 13. Backend records the final state
- **Actual:** verification → settlement → Task COMPLETE, or VERIFYING for operator review (`dtaro.handler.js:153-326`). Covered by backend unit tests that passed today.
- **Gap:** the physical-robot path has not been exercised end to end in this audit (`gate1PhysicalOffer.js` NOT RUN).

## What "autonomous" would require, minimally

1. RX-01/02/05/06 closed and verified on blocks.
2. Front sensing valid (RX-04) and the Pi using ranges (RX-07).
3. No permanent stall on a transient obstacle (RX-08), and a decided policy for ESP32 latch recovery (RX-03).
4. Measured hardware evidence for GPS accuracy and heading (RX-14, RX-10).
5. Configuration and provisioning completed and recorded (RX-11, RX-17).
6. A supervised field mission with custody confirmed by an operator. Custody remains an operator act by design until a sensor or UI exists (RX-12).

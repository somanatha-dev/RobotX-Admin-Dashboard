# V1 assignment engine — demonstration runbook

**Status (2026-09-23):** the real assignment path assigns, executes, verifies and settles
deliveries for a simulated fleet, and its V1 regression gate passes at 10 robots × 10 and × 20
tasks and on the failure scenario. See §7 for the measured runs.

**This is V1. It is not production.** Every value the path runs on is read from a real row,
derived from the simulator's own constants (`DEVELOPMENT_SIMULATION`), or a declared V1
simplification (`V1_DEMONSTRATION`). Nothing here is a measurement of a physical robot.

---

## 1. What V1 supports

| Capability | Where it happens |
|---|---|
| Task intake + validation (coordinates, payload, chassis class, region) | `services/task.service.assignTask` → `engine/intake/intake.admit` |
| Durable queueing, one shard per region | `WorkQueue` row; `workers/coordinator.worker.runRound` claims it |
| Candidate discovery, bounded by the search radius (700 m) | `engine/candidates/expansion` over the availability index (`workers/indexMaintainer.worker`) |
| Feasibility — all 38 §7.5 predicates, energy (F34/F35) and payload (F22–F24) included | `engine/feasibility/evaluate.gate`, via `workers/coordinatorSolvePath.evaluateExactFor` |
| Ranking (Φ/γ) and solve (min-cost flow) | `engine/plan/column.price`, `engine/solve/round.plan` |
| Commitment (serialised, fenced, capacity 1 per robot) | `engine/commitment/commit` |
| Signed OFFER → ACCEPT / REJECT / DEFER / expiry | `engine/dispatch/offers`, outbox worker, `sockets/handlers/offer.handler` |
| Execution: §4.4 chain from the server's own position evidence + the robot's custody report | `services/legProgress.service` |
| Lease renewal from the robot's commitment-scoped heartbeat | `services/commitmentLeaseRenewal.service` |
| Completion verification against the robot's position track, then settlement | `sockets/handlers/dtaro.handler` `TASK_COMPLETE` → `engine/lifecycle/settlement.settle` |
| Many robots, many simultaneous tasks | measured: 10 robots × 20 tasks (§7) |

Physical RobotX is a separate input source. It is **not** admitted by V1 (see §9).

---

## 2. What is simulated, why that is acceptable, and what stays real

Every simplification is an **input**. No decision is bypassed: each value below is consumed by
the same predicate, planner or ranking term a production value would be.

| # | Input | V1 value (label) | Why acceptable for V1 | What stays real |
|---|---|---|---|---|
| 1 | Route distance / time / spread | Haversine between cell centres at the robot's **commissioned** speed + the declared V1 campus travel model (`DEVELOPMENT_SIMULATION`, `simulation/simulationRouter`) | It is exactly the geometry `VirtualRobot` drives | Boundary refusal: an endpoint off the adopted RNSIT boundary is refused (`OUTSIDE_SERVICEABLE_REGION`) |
| 2 | Terrain | climb 0 m, descent 0 m (`DEVELOPMENT_SIMULATION`) | The simulated world has no elevation axis — a fact of the simulator, not a claim RNSIT is flat | The energy model still consumes both terms |
| 3 | Energy coefficients (β) | Derived from the simulator's drain constants; `fittedAt` null (`DEVELOPMENT_SIMULATION`) | Prediction and simulated consumption are one model (coherence, not validation) | F34 tiers, F35 return-to-charger — both still decide |
| 4 | Energy dispersion / floor | CV 0.10; floor = `BATTERY_MIN` × pack — per simulated agent only | Facts of the simulated pack | The two Safety register rows stay null for every other agent |
| 5 | State of charge | **The robot's own reported battery** (telemetry → `BatteryState.lastObservedSoc`, update-only) | Real for both kinds of agent | Was frozen at commissioning until 2026-09-23 (§5, D21) |
| 6 | Control-plane facts (commissioning, hold, firmware, calibrations, e-stop, faults, localisation, reliability, advisories, zones, maintenance) | `simulation/simulatedAgentState` (`DEVELOPMENT_SIMULATION`) | The simulator has no e-stop, sensors or fault channel beyond its status | PAUSED → held (F3); ERROR/ISSUES → faults (F8); stale telemetry → stale e-stop (F7) |
| 7 | Session, health tier, position freshness, reservations | Real rows, both kinds | — | Real |
| 8 | Mission facts (type, class, supervision, required health tier, localisation threshold, deadline hardness, tenant) | `services/v1DemonstrationProfile` (`V1_DEMONSTRATION`), **only where the task states nothing** | The dashboard does not send them | A value stated on the task always wins |
| 9 | Cargo geometry | One-parcel envelope 400×300×250 mm box; undeclared parcel taken at 2.5 kg (`V1_DEMONSTRATION`) | No dimensions exist anywhere | **Mass is real**: a 10 kg parcel is rejected by F22 |
| 10 | Route facts (surfaces, constrictions, zones, windows, dead zones), forecast | The simulated world: one surface, none, published zones, no restrictions, ambient ≤ `AMBIENT_MAX_C` | Exactly the simulated world | F27–F31 still evaluate them |
| 11 | p_fail, hazard, thermal stress, battery wear (ranking only) | 0 / 0 / 1 / plan-derived | Ranking only, equal across the simulated fleet | — |
| 12 | Execution geometry | The simulator's planar segment | Planning and execution see the same geometry | Completion corridor is graded against it |
| 13 | Search radius, horizons, budgets | 700 m (campus longest chord 624 m); `v1DemonstrationConfig.executionBindings()` | Bounded, deterministic rounds | Not unlimited |
| 14 | Tenant | `robotx-v1-demonstration` where a row states none | Single-tenant deployment | F4 still refuses another tenant |
| 15 | SLA assignment window | `sla.assignment_deadline` 3600 s (`V1_DEMONSTRATION`) | The 900 s default stranded queued work behind a busy fleet (D29) | F19 still gates on it |

**Isolation.** Every simulated seam answers only for an agent whose snapshot is
`DEVELOPMENT_SIMULATION` or whose `Robot.simulated === true`; for a physical agent it answers
nothing and the predicate that needs the real input denies by name. The composition cannot be
built at all in a process that is not running the simulator. Proven in
`tests/engine/v1SimulationIsolation.test.js` and `tests/engine/routingSimulationProducer.test.js`.

---

## 3. Checks that remain real

The engine still says, with the reason, for each of these (live proof in §7, scenario `failures`):

| Situation | Where it is refused | Reason seen |
|---|---|---|
| Battery too low to finish and return | F34 (plan energy) | `E_return: insufficient energy to return to charger … = -x Wh` |
| Parcel heavier than any robot's rating | F22 (+F21) | payload mass > rated × safety factor |
| Wrong vehicle class | F21 | requirement not in the capability bundle |
| Robot outside the search radius | candidate expansion — never loaded | (unit: `v1SimulationIsolation.test.js` case 3) |
| Robot offline | dropped from the availability index, else F9 / F13 (the gate stops at its first denial) | `health tier QUARANTINED` (status OFFLINE) / no live session |
| Robot unroutable (boundary cell) / task to an unroutable point | before the gate: `MISSING_HOP` | router refuses the cell |
| Robot at capacity / two tasks for one robot | G2 at commit; the solver never double-books | capacity 1 |
| Leg already being executed | G6 at commit | `G6_UNEXPECTED_LEG_STATE` |
| OFFER not answered | OFFERED deadline expires → withdrawn, re-queued, re-offered to another robot | `dispatch.offer_ttl` |
| Robot rejects the OFFER | released; NACK cool-off excludes that robot for that Leg (F20) | robot's reason |
| Robot fails mid-mission | lease not renewed → expiry → recovery | `lease.duration` |
| Invalid task (missing coordinates, unknown class, bad payload, pickup = drop) | 400 before anything is written | named field / `PICKUP_EQUALS_DROP` |

---

## 4. How to run the demonstration

A **disposable** local PostgreSQL only (loopback, never port 5432, never Neon), with every
migration applied — see `reference_disposable_postgres_verification` in the team notes: PG 18
binaries, `initdb` to a scratch directory, start on e.g. `55436`, apply
`prisma/migrations/*/migration.sql` in name order. Recreate the database between runs.

```bash
cd Backend
node tools/demo/runV1Assignment.js postgresql://<user>@127.0.0.1:<port>/<db> --scenario A        # 10 robots × 10 tasks
node tools/demo/runV1Assignment.js postgresql://<user>@127.0.0.1:<port>/<db> --scenario B        # 10 robots × 20 tasks
node tools/demo/runV1Assignment.js postgresql://<user>@127.0.0.1:<port>/<db> --scenario failures # §3's cases
node tools/demo/runV1Assignment.js postgresql://<user>@127.0.0.1:<port>/<db>                     # baseline: 6 robots × 5 tasks
# options: --tasks N  --seed N (default 20260923)  --timeout-s S  --json out.json   ·  V1_TRACE=1 for per-candidate traces
```

The runner seeds the RNSIT region, zone, shard, published index cover and depot charger;
commissions every robot through `robot.service.createRobotWithProjection` (`simulated: true`,
fixed codes); starts a real socket.io server with the app's handlers and real `VirtualRobot`s;
publishes and pins the V1 configuration; starts the real `leaderWorkers` lifecycle with the V1
composition; submits tasks through `task.service.assignTask`; and then checks the run.

**No gate bypass, no injected candidate, no direct assignment.** The runner only *observes*
(gate verdicts, per-candidate refusals, outbox deliveries, robot events). The `failures`
scenario additionally changes **robot-side** behaviour (a robot that never answers, one that
always rejects, one that disappears mid-mission, one that goes offline) — no engine code.

**Exit code 0 only if** every invariant holds and the scenario's expectations are met:

| | Invariant (`tools/demo/v1RunReport.js`) |
|---|---|
| I1 / I8 | never two commitments on one Leg — at the end (I1) or at any moment of the run (I8) |
| I2 | never more live commitments on a robot than its capacity |
| I3 | every commitment was preceded by a feasible gate verdict for that robot and Leg |
| I4 | no task disappears: each is COMPLETED, in flight, waiting in the queue, or terminally failed |
| I5 | COMPLETED ⇒ Leg SETTLED **and** a SUFFICIENT verification |
| I6 | no live commitment left on a settled/queued/terminal Leg |
| I7 | the Leg was settled by the robot the Task names |

**The real `server.js` (what the dashboard and robots connect to)** is started in V1 mode
by a launcher, never by editing `Backend/.env` (whose `DATABASE_URL` is the shared Neon
instance and whose `ENGINE_ENABLED` stays `false`):

```bash
cd Backend
node tools/demo/seedV1Demonstration.js --database-url postgresql://<user>@127.0.0.1:<port>/<db> --fleet baseline
node tools/demo/startV1Server.js       --database-url postgresql://<user>@127.0.0.1:<port>/<db> [--port 3000] [--host 127.0.0.1]
```

The seed publishes and pins the configuration: `tools/config/v1DemonstrationConfig.js`'s
bindings **and `executionBindings()`** (700 m search radius, 2000 ms solve budget — without
them every round finds no candidate), `cutover.engine_enabled` for the region, the spatial
index and the delivery domain. `--fleet baseline` commissions the six acceptance units.
`runV1Assignment.js` publishes through the same function.

The launcher refuses any database that is not loopback on a non-default port (it never
falls back to `DATABASE_URL`), then sets `ENGINE_ENABLED=true`,
`ENABLE_VIRTUAL_SIMULATOR=true`, `V1_DEMONSTRATION_COMPOSITION=true`,
`SHARD_CONSENSUS_REPLICATION=SINGLE_PRIMARY_NO_AUTOMATIC_FAILOVER`, `SHARD_ID=v1demo-shard`,
a per-process `COMMAND_SIGNING_KEY` (unless one is set), `REDIS_ENABLED=false`, and the six
`VERIFY_*` thresholds from `v1DemonstrationConfig.VERIFICATION_THRESHOLDS` (without them no
Leg settles). It checks read-only that the database is a seeded V1 world before starting
`server.js`. An engine process with an invalid §23.7 privacy secret refuses to start.

```
VERIFY_ARRIVAL_RADIUS_M=25  VERIFY_TRACK_MIN_FIX_RATE=10  VERIFY_TRACK_MIN_CORRIDOR_FRACTION=0.8
VERIFY_TRACK_MAX_GAP_SECONDS=10  VERIFY_CORRIDOR_HALF_WIDTH_M=30  VERIFY_MAX_SPEED_MS=8.33
```

A dashboard task names its campus; the frontend submits that campus's `regionId` from the
campus registry (`RNSIT` → `rnsit`). The backend never defaults a region.

Every task the dashboard's form creates states a chassis type and a payload mass, which F21
matches against the robot's capability bundle. Until 2026-09-27 the coordinator's agent
snapshot loaded the bundle without its `capabilities` rows, so every such task found no
candidate (F21 INDETERMINATE); it now loads them (`workers/coordinatorSolvePath.js`,
`tests/engine/v1CapabilityBundleSnapshot.test.js`). A DRONE task or a payload above the
fleet's rated 5 kg is refused by F21 as VIOLATED.

The first publish of any configuration trips S2 and V9; the demo uses the labelled
accommodation on a disposable database only. **That is not a Safety approval.**

---

## 5. How to run the tests

```bash
cd Backend
npx jest --coverage=false tests/engine/v1 tests/engine/batteryObservation.test.js \
  tests/engine/routingSimulationProducer.test.js tests/engine/simulationBoundary.test.js   # focused V1
npm test                                                                                   # full suite
```

V1-specific suites: `v1DemonstrationAssignmentPath`, `v1DemonstrationPathBlockers`,
`v1DemonstrationConfig`, `v1SimulationIsolation`, `v1ExecutionProducers`,
`v1CoordinatorConcurrency`, `v1RunReport`, `batteryObservation`, `routingSimulationProducer`.

---

## 6. Expected output

```
[fleet] 10 simulated robots: V1DEMO-01@rnsit-innovation-center(90%) … V1DEMO-09@rnsit-main-gate(85%) V1DEMO-10@…(12%)
[watch] t+…s completed n/N legs {"SETTLED":…} live=… offers=… accepts=… rejects=…
── REJECTION REASONS … REJECTED V1DEMO-10 … F34: … E_return: insufficient energy …
── TASK OUTCOMES … COMPLETED task=COMPLETED leg=SETTLED robot=V1DEMO-0x
── SUMMARY { tasks, completed, candidatePairs, feasiblePairs, rejectedByPredicate, refusedBeforeGate, offersDelivered, accepts, rejects, … }
── INVARIANTS   all hold (I1–I8)
── EXPECTATIONS PASS …
RESULT: PASS — scenario A, 10/10 tasks completed, … s
```

---

## 7. Measured runs

Disposable PG 18.3 (127.0.0.1:55436), seed 20260923, 2026-09-23, all fixes in (final runs).

| | A — 10 robots × 10 | B — 10 robots × 20 | failures — 10 robots × 7 (+4 invalid) |
|---|---|---|---|
| Result | **PASS** | **PASS** | **PASS** |
| Completed & settled | 10 / 10 | 20 / 20 | 4 / 4 servable (3 unservable wait, by name) |
| Wall time | 291 s | 655 s | 456 s |
| Candidate pairs evaluated / feasible | 63 / 53 | 123 / 102 | 41 / 19 |
| Rejections at the gate | F34 × 10 | F34 × 21 | F21 × 10, F3 × 5, F34 × 4, F20 × 2, F9 × 1 |
| Refused before the gate | MISSING_HOP × 10 | MISSING_HOP × 20 | MISSING_HOP × 13 |
| Commitments = OFFERs delivered | 10 | 20 | 7 |
| ACCEPT / REJECT / expired | 10 / 0 / 0 | 20 / 0 / 0 | 5 / 1 / 1 |
| Robots used (max tasks per robot) | 8 (2) | 8 (3) | 6 |
| Custody events / completions reported | 20 / 10 | 40 / 20 | 8 / 4 |
| Invariants I1–I8 | all hold | all hold | all hold |
| Duplicate / orphaned commitments, lost tasks | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Worker failures | 0 | 0 | 0 |

**Repeatability.** Across repeated runs of the same scenario the *outcome* is identical —
completions, rejections by reason, commitments, OFFERs, ACCEPTs, custody events, robots used
(A: three runs; B: two). What varies is timing-dependent: how many candidate pairs a round
happened to evaluate (A: 80 vs 63) and which robot took which task. V1 is repeatable in
outcome, not bit-for-bit deterministic in assignment — the robots, sockets and timers are real.

**Before the fixes** (same harness): A delivered one task twice (D22, caught by I8); B
livelocked at 0 assignments (D27) and then stranded two tasks with seven robots idle (D29);
`failures` lost two tasks (I4, D25), never expired the silent robot's OFFER (D26) and left a
reassigned task uncompleted (D30).

---

## 8. Known limitations (V1)

- **Simulated world only.** Flat, one surface class, straight-line segments. Distances are a
  lower bound on real campus paths.
- **The energy plan is conservative, by ~5–10×.** Measured: the simulator drains 1–4.6 % (10–46 Wh)
  per campus mission in 58–214 s; the engine plans ~175–270 Wh (~15 min). The inputs that make it
  so: `plan.service_time_prior` 60 s per stop (the simulator dwells 8–10 s), 250 m of
  `route.intra_cell_offset_m` per hop, and the uncalibrated-reserve inflation on the return leg.
  Every one errs safe: a robot below roughly 40–45 % is refused a cross-campus task it could
  actually do. Nothing is refused that should have been accepted the other way round.
- **`Leg.slaDeadline` is the assignment deadline, read as a delivery deadline** by F19. V1
  widens the window (D29); separating the two is V2.
- **A robot that dies holding a parcel** (custody HELD) is not reassigned — correct, the goods are
  on it — but its Leg stays in LOADED rather than moving to a STRANDED state with an operator
  alert (the expired-lease scan records the repair; no `recover` action is composed). A robot
  that dies before loading is reassigned (live `failures`, case 9).
- **An offline robot drops out of the availability index** (its charging status is no longer
  known), so it is never even evaluated — stronger than F13, which fires for a robot that is
  indexed but has no live session.
- **Three RNSIT points are unroutable** (main gate, playground-1, parking lot: boundary cells
  whose centres lie outside the adopted boundary, RD-2026-08-30-01). No robot can start or
  deliver there. Owner-level spatial fact; not routed around.
- **A robot that disappears mid-mission** is recovered by lease expiry (60 s) and the §4.3
  timers, not instantly.
- **A custody report held for a later-verified arrival lives in process memory**; a restart
  loses it (the Leg still settles on verified completion).
- **`gate:composition` stays RED.** It asserts the *production* coordinator, which still has no
  production router (B1). It is correct that it is red; V1 does not weaken it.
- The demo harness composes its own socket server. The `server.js` V1 mode (via
  `tools/demo/startV1Server.js`) was run end to end separately on 2026-09-27: 5 tasks
  submitted through the frontend's request code, 5/5 completed, verified SUFFICIENT and
  settled. That run is not part of this harness's regression gate.
- The congestion time bucket is computed once when the composition is built (harmless: the
  simulation router ignores congestion).

---

## 9. Physical RobotX integration boundary

The engine does not change for RobotX. It reads the **same fields** from a different provider.
Today each simulated seam returns nothing for a physical robot, and the predicates deny it by
name — that is deliberate.

| Engine-facing fact | Engine reads it from | Simulated provider (today) | RobotX adapter must supply |
|---|---|---|---|
| robotId / identity | `Robot.robotId` = `Agent.agentId`; socket `AUTH` | `VirtualRobot` | Pairing-code AUTH once, then the persisted session token |
| Online / session | `Robot.isOnline`, live heartbeat store (F13) | real | `HEARTBEAT` every ~2 s |
| Command path proven (F14) | `session.lastHeartbeatAckAt` | `simulatedAgentState` overlay | an acknowledged round trip |
| Location | position `Observation` (per accepted `TELEMETRY` frame with an agent `timestamp`) → `AgentCellPosition` | real telemetry | GPS lat/lon + epoch-ms timestamp |
| Battery / SoC | `BatteryState.lastObservedSoc` (written from telemetry `battery` %) | real telemetry | a real battery measurement (none on the ESP32 today) |
| Health (F9) | `Robot.status` | real | the 8-value status |
| Faults (F8) | `faults[]` | status-derived | ESP32 sensor health / `ROBOT_FAULT` |
| Emergency stop (F7) | `emergencyStop {value, observedAt}` | "not engaged" at last telemetry | the ESP32 safety-stop latch, forwarded by the Pi |
| Localisation (F10) | `localisation {confidence, corroborations}` | confidence 1 | GPS fix quality (+ odometry when encoders exist) |
| Capabilities / payload capacity | `AgentClass` → `CapabilityBundle`, `ContainerModel`, `Compartment` | commissioning + V1 envelope | commissioning with the measured box |
| Physical specification | `Robot.massKg`, `MobilityModel`, `EnergyModel`, `EnergyModelParams` | simulator constants | measured mass, speed, pack Wh, fitted β |
| Firmware / control plane (F1, F3, F5, F6, F12, F27, F36) | `agentFacts` control-plane fields | `simulatedAgentState` | a physical control-plane provider (`agentFacts.PHYSICAL_CONTROL_PLANE_FACTS`) |
| Route + route facts | `route`, `routeDescriptorFor`, `environmentForecastFor` | `simulationRouter`, simulated world | a physical-route provider (not `simulationRouter`) |
| Mission heartbeat | `HEARTBEAT {commitmentId, fence}` | `VirtualRobot` | same payload while holding a mission |
| OFFER acceptance | `OFFER` event (signed; carries the stops) → `OFFER_ACCEPT/REJECT/DEFER {commitmentId, fence}` | `VirtualRobot._respondToOffer` | the Pi executes **from the OFFER**; there is no `TASK_ASSIGN` on this path |
| Custody | `CUSTODY_EVENT {commitmentId, fence, kind: ACQUIRED|RELEASED}` | `VirtualRobot` | at pickup / handover |
| Completion | `TASK_COMPLETE {taskId, lat, lon}` + the position track | `VirtualRobot` | same, with telemetry ≥ every 6 s during the mission |

The adapter is an **input source**, not a second assignment algorithm: it fills these fields in
`services/agentFacts.service` (physical branch) and the composition's per-agent seams.

---

## 10. V2 backlog (deliberately not in V1)

Production router with elevation and stop-start (B1) · terrain/weather/hazard providers ·
calibrated physical energy coefficients and the two Safety rows (`energy.model_residual_cv`,
`energy.reserve_floor_wh`) with a real two-person approval · physical control-plane tables and
firmware attestation · production charger estate / Charging Scheduler (B2) · physical-route
provider · `RETURN_TO_BASE` producer · durable held-custody · scale beyond ~100 robots ·
`server.js` V1-mode end-to-end harness · dashboard live robot/offline events.

---

## Appendix — defects found by running the real path (fixed)

Every one was silent: no throw, no log, just "no candidate" or a wrong lifecycle.

| # | Defect | Fix | Regression test |
|---|---|---|---|
| D1–D2 | Leg business id vs row id in the priced memo and the column | `round.legIdentity` / `canonicalLegId` | `v1DemonstrationAssignmentPath` |
| D3 | `maxSpeedMps` vs `maxSpeedMs` | both readers accept `maxSpeedMps` | `v1DemonstrationAssignmentPath` |
| D4 | Router priced at 5.56 m/s; robots drive at 1.5 m/s | per-agent profile key carries the commissioned speed | `v1DemonstrationAssignmentPath` |
| D5 | Robots without `Agent.regionId` never indexed | region from observed position | `v1DemonstrationPathBlockers` |
| D6 | Round never pinned the leadership fence | worker passes step 1's fence to commit | live run (every commit) |
| D7 | Outbox drained every 300 s; OFFER TTL 20 s | cadence bounded by the offer TTL | live run (every OFFER) |
| D8 | Delivery routed to `Agent.id` | wire identity resolved from the row | live run |
| D9 | OFFER signed for `Agent.id` | signed for `Agent.agentId` | `v1DemonstrationAssignmentPath` |
| D10 | `membership.place` had no caller | index maintainer places on first indexing | live run (agentGate binding) |
| D11 | Offer handler's `lease.duration` injected by nobody | read from the pinned config | live run (every ACCEPT) |
| D12 | Lease renewal had no caller | commitment-scoped heartbeat renews | `v1ExecutionProducers` |
| D13 | No producer for §4.4 execution events | `legProgress.service` | `v1ExecutionProducers` |
| D14 | `settlement.settle` had no caller | settle on SUFFICIENT verification | live run (I5) |
| D15 | Observations on the 15 s history throttle | one Observation per accepted frame | `positionObservationPipeline` |
| D16 | Verification corridor only from the agent's claim | the server's own signed OFFER route | live run (I5) |
| D17 | `VirtualRobot` "arrived" while heading for the last waypoint | arrival means *at* the waypoint | `virtualRobotBehaviour` |
| D18 | Energy failure reasons swallowed | carried to F34 | `v1SimulationIsolation` (case 1) |
| D19 | Custody release vs completion race on `Leg.version` | settlement retried on `LOST_RACE` | live run (I5) |
| D20 | Agent facts newer than the round's decision time | facts read as of the decision time | live run |
| **D21** | `BatteryState.lastObservedSoc` written only at commissioning — the engine planned every mission on the commissioning charge | telemetry writes the reported SoC, update-only | `batteryObservation` |
| **D22** | Coordinator rounds overlapped (`setInterval` + async); a round that threw after committing re-queued the committed Leg; G6 was told to expect the loaded state — **LEG-V1DEMO-TASK-6 was delivered by two robots** | non-reentrant tick; throw path keeps committed Legs out of the queue; G6 expects the assignable states | `v1CoordinatorConcurrency`; live I8 |
| **D23** | A robot starting at its pickup sent custody before the server verified arrival; the report was dropped and the Leg stalled in AT_PICKUP | report held and applied at the verified arrival | `v1ExecutionProducers` |
| **D24** | Low-battery rejection read "energy projection could not be built" | the E_return balance is stated | `v1SimulationIsolation` |
| **D25** | A Leg returned to QUEUED (rejected/expired OFFER, reassignment) kept its WorkQueue row SOLVED — no round ever claimed it again | each round returns such Legs to the queue (`coordinator.worker.requeueReturnedLegs`) | live `failures` (cases 7–9); I4 |
| **D26** | A delivered OFFER that was never answered never expired — the OFFERED deadline was not armed at commit | the commit arms it in the same transaction (`dispatch.offer_ttl` → `WITHDRAW_EXCLUDE_REPLAN`) | live `failures` (case 7) |
| **D27** | A batch larger than one round's wall clock livelocked: every Leg expanded, the solve truncated to nothing, all re-queued (20 Legs, 208 `BUDGET_TRUNCATED`, 0 assignments) | once a Leg is priced and half the budget is spent, the rest wait for the next round | `v1CoordinatorConcurrency` §4; live B |
| **D28** | A task whose pickup is its drop (two RNSIT points share a coordinate) stalled in LOADED, COMPLETED but never SETTLED | refused at intake: pickup and drop within the arrival radius → 400 `PICKUP_EQUALS_DROP` | `v1SimulationIsolation`; live `failures` |
| **D29** | `sla.assignment_deadline` (900 s) is written into `Leg.slaDeadline`, which F19 reads as the *delivery* deadline minus the plan's duration — Legs queued behind a busy fleet became permanently infeasible (2 stranded with 7 robots idle) | V1 input: `sla.assignment_deadline` = 3600 s (`executionBindings`); the conflation itself is V2 | live B |
| **D30** | After a reassignment the Task kept naming the robot that died; the new robot's `TASK_COMPLETE` settled the Leg but could not complete the Task | the accepted-assignment projection follows a reassigned Leg to its new robot | `v1ExecutionProducers`; live `failures` (case 9) |
| **D31** | `TASK_COMPLETE` arrived before the robot's RELEASED custody was admitted; settlement refused while custody was held and was never retried — Task COMPLETED, Leg stuck RELEASED with a live commitment | when custody is released and a SUFFICIENT verification for that commitment exists, settle then | `v1ExecutionProducers`; live A (I5) |

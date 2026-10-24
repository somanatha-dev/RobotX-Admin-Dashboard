# DTARO zone coordination: implementation audit

| | |
|---|---|
| **Audit date** | 2026-10-22 |
| **Branch** | `feature/dashboard` |
| **Commit audited** | `5e94a1ab35b41072bcfa11a77a13bd1b340fd5c9` (`5e94a1a`) |
| **Working tree at start** | Clean. No pre-existing modifications. |
| **Working tree at end** | Only this directory was added. No application source, schema, migration, configuration or test file was changed. |
| **Kind** | Read-only audit. **It does not implement DTARO.** |
| **Reference paper** | *DTARO: Zone-Scoped Cooperative Obstacle Awareness for Communication-Efficient Multi-Robot Coordination* (Basavanuty, Prarthana B, Neha N, Prasanna Kumar M). The version used is the newest local copy, `Desktop/Major-project-backups/final research paper things/DTARO-final.pdf` (2026-09-28). Two older copies under `Downloads/` have the same title. |

## Start here (for a future session)

1. Read this page.
2. Read [`DTARO_GAP_ANALYSIS.md`](DTARO_GAP_ANALYSIS.md) to see where each paper concept stands.
3. Before changing any code, read the owner decisions in [`IMPLEMENTATION_READINESS_AND_TEST_PLAN.md`](IMPLEMENTATION_READINESS_AND_TEST_PLAN.md) §2. Several of them gate whether code may be written at all, because the V1 assignment engine is frozen (`78b4712`).
4. Use [`CURRENT_IMPLEMENTATION_MAP.md`](CURRENT_IMPLEMENTATION_MAP.md) for file, symbol and line references, the traces, and the reproduction probe.

| Document | Contents |
|---|---|
| [`CURRENT_IMPLEMENTATION_MAP.md`](CURRENT_IMPLEMENTATION_MAP.md) | Repository map, campus and spatial model, assignment flow, simulation, sockets, the obstacle and route data flow, dashboard, authority, the Pi boundary, end-to-end traces, the executed probe |
| [`DTARO_GAP_ANALYSIS.md`](DTARO_GAP_ANALYSIS.md) | Concept-by-concept comparison of the paper and RobotX, the paper's results kept separate from RobotX facts, and the failure-case matrix |
| [`IMPLEMENTATION_READINESS_AND_TEST_PLAN.md`](IMPLEMENTATION_READINESS_AND_TEST_PLAN.md) | Owner decisions, the smallest safe simulation-first path, dependencies, acceptance criteria, tests, risks |

## Scope and boundaries inspected

- **Backend** (`Backend/`): `server.js` (the composition root), the socket layer (`src/sockets/**`), the legacy DTARO services (`zoneManager`, `ekb`, `alertDissemination`, `routeIntersection`, `routing`, `robotRegistry`), the engine spatial model (`src/engine/spatial/**`), intake, candidate search, feasibility F27, commit, dispatch and fencing, completion verification, failure catalogue A8, the simulator (`src/simulation/**`), the Prisma schema, seed and bootstrap tools, and the build gates.
- **Frontend** (`Frontend/src`): the obstacle alert handling (`lib/obstacleAlert.js`, `context/AppProvider.jsx`, `DecisionRequiredModal.jsx`) and the reroute redraw in the map stream.
- **Documentation:** the Phase 15 canonical set (`docs/phase15/PHASE_15_MASTER.md` and others), ADR-27, ADR-28 and ADR-36, the V1 runbook, the physical contract, the 2026-10-17 system audit, and two **historical** root-level documents: `ROBOTX_CURRENT_COMMUNICATION_AUDIT.md` and `ROBOTX_OBSTACLE_ALERT_IMPLEMENTATION_PLAN.md`, both from 2026-08-22. I treat these as evidence of earlier analysis. Their claims were re-checked against current source.
- **Not inspected:** the Pi (`RobotX-Pi`) and ESP32 repositories. They are separate repos and out of scope; the 2026-10-17 system audit is cited for them. The live database was also not inspected: Docker was not running, so the actual `Zone`/`Region` rows are **NOT_VERIFIABLE** from this session.

## What exists today

RobotX already contains a substantial **legacy DTARO tier**. It is the paper's original implementation, built before the assignment engine. All of it is still registered in the running server:

| Paper element | RobotX code | Status |
|---|---|---|
| Zones and zone rooms | `zoneManager.service.js`: bounding-box `Zone` rows, membership on every telemetry tick, join/leave of `zone:{id}` | Membership is **VERIFIED_IMPLEMENTED_AND_COMPOSED**. Delivery is **MISSING** (nothing ever emits to a zone room) |
| Obstacle report | `dtaro.handler.js` `OBSTACLE_REPORT`, emitted by `VirtualRobot` | **VERIFIED_IMPLEMENTED_AND_COMPOSED**, but the simulator's reports are random fabrications |
| Environmental knowledge base (EKB) | `ekb.service.js`: Redis/KV with a 300 s TTL plus a best-effort `ObstacleEvent` row | **PARTIALLY_IMPLEMENTED**: writes happen, but there is no dedup and no reader |
| Route-intersection test | `routeIntersection.service.js`, run **server-side** over every robot in the fleet | **IMPLEMENTED_BUT_NOT_COMPOSED**: its input `plannedPath` is never written, so it always returns `[]` |
| Replanning | `routing.service.js` `rerouteRobot` / `replanRoute` | Unreachable, and unsafe if reached (see below) |
| Allocation (readiness gate + cost C(r)) | `robotValidator`, `costEvaluator`, `taskAssignment` | **Deleted** at Phase 15 (`cbe540e`). The `gate:legacy` build gate now fails the build if they are re-added |

RobotX also has a separate, **engine-native** spatial and fleet architecture. This is what actually assigns work today, simulated robots included:

- Region ⊃ zone ⊃ cell, by published assignment ([ADR-28](../../adr/ADR-28-spatial-hierarchy.md), frozen).
- H3 index plus an exact-coordinate delivery domain ([ADR-36](../../adr/ADR-36-two-layer-spatial-model.md)).
- One shard per region.
- 38 feasibility predicates.
- A fenced commitment, and a signed OFFER that carries the **priced route** as execution geometry.
- Completion graded against that commanded corridor.

The engine also defines the mission commands `REROUTE`/`RESEQUENCE` (fenced and sequenced). Its failure catalogue already specifies DTARO-like behaviour as row **A8**: "local replan; then global reroute; then obstacle report to the knowledge base and reroute of other affected missions".

Simulated robots are faithful clients. Each `VirtualRobot` opens a real Socket.IO loopback connection, authenticates, and answers fenced engine commands through the same handlers a physical robot uses.

## Most important gaps

1. **No end-to-end obstacle-sharing path is operational.** An executed probe of unmodified production modules (CURRENT_IMPLEMENTATION_MAP §11) confirmed every break:
   - The obstacle's zone is computed but never used to address anyone.
   - The intersection input (`plannedPath`) has no producer.
   - The alert payload is a no-op for the simulator.
   - The legacy replanner returns early on the engine's route cache.
   - A route running straight through the obstacle along the SW–NE bearing is missed.
   - Identical reports are not deduplicated.
2. **No campus scoping of obstacle alerts.** Recipients are selected from the global `robots:all` set. A report is accepted from any authenticated robot, for any coordinate, with no plausibility or region check.
3. **The legacy zone concept conflicts with the frozen ADR-28.** Bounding-box containment, query-time geometry, and default zones seeded only for the first campus (`findFirst`) all contradict it. The engine's zones are the ADR-compliant concept, but V1 publishes exactly **one** zone per region (`rnsit-z1`). JSSATE has a `Campus` row but no engine region in any bootstrap tool.
4. **No safe replanning authority exists.** The only engine-sanctioned way to change a robot's route is a fenced `REROUTE`, and it has **no producer**. The legacy `rerouteRobot` rewrites route caches with no fence or outbox, and the F3 precedent rules that pattern out: it breaks "priced = driven = drawn" and fails completion corridor grading. The campus router has no blocked-edge input.
5. **There is no communication-efficiency measurement.** The only obstacle metric is an `obstacles.active` gauge. Recipients, relevance, replans, duplicates and expiries are not counted anywhere.
6. **The dashboard shows obstacles only as a log line and a modal.** There is no map marker, zone overlay, membership display or alert-processing view, and obstacle and zone events reach SUPER_ADMIN sockets only.

## End-to-end status

| Stage (prompt §8) | Status |
|---|---|
| 1 Obstacle observed | **TEST_ONLY_OR_SIMULATION_ONLY**: a random draw near the simulated robot's own position. The physical Pi never emits `OBSTACLE_REPORT` |
| 2 Observation validated | **PARTIALLY_IMPLEMENTED**: authentication, rate limit, and a schema with a numeric check on lat/lon only |
| 3 Shared environmental state updated | **PARTIALLY_IMPLEMENTED**: EKB write with TTL. No dedup, no reader, and the `ObstacleEvent` table is write-only |
| 4 Alert routed to relevant recipients | **MISSING** in effect: zero recipients in the production state |
| 5 Alert received and validated | **MISSING**: the simulator handler ignores the payload |
| 6 Planned route checked | **IMPLEMENTED_BUT_NOT_COMPOSED**: server-side and starved of input. No receiver-side check exists |
| 7 Replan decided | **MISSING** as a safe mechanism |
| 8 New route generated and accepted | **MISSING**: `REROUTE` has no producer, and the campus router cannot avoid an obstacle |
| 9 Safe execution resumed or held | **MISSING** for obstacle alerts. Stall detection reports only |
| 10 Reflected in telemetry and dashboard | **PARTIALLY_IMPLEMENTED**: log line and modal only |

**Verdict: the end-to-end obstacle-sharing path is not composed and not operational.** Much of what is needed exists in parts (zone membership, KV, rooms, fenced command protocol, priced execution geometry, simulator command admission, failure row A8). The missing links are mostly links between those parts, but several sit behind owner decisions and the V1 engine freeze.

## Checks run

| Check | Result |
|---|---|
| Focused Jest: `zoneLocality`, `tasksControllerRerouteEngine`, `liveRobotIndex`, `dtaroHandlerTaskComplete`, `dispatchSchema`, `dispatchAgentProtocol`, `v1SimulationIsolation`, `routingSimulationProducer` | **8 suites, 205 tests, all passed** (exit 0, 29 s) |
| `npm run gate:legacy` | **PASS**: 4 retired modules absent, no retired symbol redefined across 482 files |
| Executed probe in the session scratchpad, outside the repo (unmodified production modules, in-memory KV, no DB or network) | **10 of 10 claims CONFIRMED** (details in CURRENT_IMPLEMENTATION_MAP §11) |
| `git status --porcelain` after the probe | Empty: the probe wrote nothing to the repo |

No existing test exercises `alertDissemination`, `routeIntersection`, `ekb`, `replanRoute` or the `OBSTACLE_REPORT` handler.

## What this audit is not

- It does not choose the zone model, the delivery policy, the replanning authority, or the obstacle lifecycle. Those are listed as owner decisions.
- It does not claim any of the paper's reported numbers for RobotX. The paper's experiment was a separate 20×20 grid simulation with 8 agents (see the gap analysis §3).
- It does not create a competing source of truth for the canonical documentation. Phase 15 status, ADRs and the V1 freeze remain authoritative in their own documents.

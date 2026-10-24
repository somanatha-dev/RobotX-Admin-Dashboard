# DTARO obstacle policy: decision record

| | |
|---|---|
| **Status** | **OPEN.** Every decision below is unmade. This record presents evidence and options only |
| **Prepared** | 2026-10-22 |
| **Baseline** | `feature/dashboard` @ `5e94a1ab35b41072bcfa11a77a13bd1b340fd5c9`; tracked tree identical to HEAD. Untracked: this directory and `Backend/tests/unit/dtaro/obstaclePipeline.test.js` |
| **Companion documents** | [README](README.md) · [CURRENT_IMPLEMENTATION_MAP](CURRENT_IMPLEMENTATION_MAP.md) · [DTARO_GAP_ANALYSIS](DTARO_GAP_ANALYSIS.md) · [IMPLEMENTATION_READINESS_AND_TEST_PLAN](IMPLEMENTATION_READINESS_AND_TEST_PLAN.md) |
| **Authority** | This record decides nothing. A recommendation here is the audit's view, not a decision. Every "Owner decision" cell is OPEN until the owner fills it in |

**Evidence labels**

| Label | Meaning |
|---|---|
| **[S]** | Read in the current source this session, with the line confirmed |
| **[T]** | Observed by running a test. The date says when |
| **[A]** | A conclusion of the earlier audit documents, carried forward and not re-proved here |
| **[O]** | An owner instruction: this task's own instructions, or recorded project memory |
| **[U]** | Unverified or assumed |

**No live database was inspected.** Every statement about zones, regions or cells is about source and bootstrap definitions, not about rows in any deployed database.

---

## A. Scope and frozen boundaries

| # | Boundary | Source |
|---|---|---|
| A-1 | DTARO obstacle awareness is **additive**. It must not reintroduce the retired allocator (`taskAssignment`, `costEvaluator`, `robotValidator`, `taskRecovery`). `tools/gates/checkLegacyRetirement.js:71` (`RETIRED_MODULES`) fails the build on their return | [S]; `docs/phase15/PHASE_15_MASTER.md` §2 |
| A-2 | The **V1 assignment engine remains frozen** | [O] this task's instructions; project memory (commit `78b4712`, 2026-10-02). No repository decision record states the V1 freeze itself. The *architecture* freezes are recorded: ADR-11, ADR-27, ADR-28 and Phase 15 |
| A-3 | **No changes are authorised to:** allocation, candidate selection, pricing and cost functions, feasibility and readiness, commitment and fencing, offers, outbox semantics, authoritative commanded routes, or completion verification | [O] |
| A-4 | **Robot-local replanning must not diverge from the signed OFFER corridor.** Completion is graded against the commanded corridor read from the OFFER outbox row (`Backend/src/sockets/handlers/dtaro.handler.js:790` `readCommandedCorridor`). The legacy reroute of an engine task is refused for exactly this reason (`Backend/src/controllers/tasks.controller.js:511`, `ENGINE_REROUTE_UNAVAILABLE`) | [S]; [O] |
| A-5 | **Any future reroute** needs explicit owner authorisation for **two** things: a fenced engine `REROUTE` (a mission command in `Backend/src/engine/commitment/fencing.js:62`, with no producer today), and an authoritative corridor update emitted through the outbox (ADR-27) | [S]; [O] |
| A-6 | Physical Raspberry Pi/ESP32 integration is **out of scope** | [O] |
| A-7 | The paper's reported results (20×20 grid, n = 8) are **not RobotX results**, and no RobotX measurement of them exists ([GAP §3](DTARO_GAP_ANALYSIS.md)) | [A] |

---

## B. Evidence-backed current state

### B-1 Published spatial configuration and zone resolution

| Fact | Evidence | Label |
|---|---|---|
| A point resolves to a zone by looking up its H3 cell in the pinned published map (`hierarchy.indexMap(...).resolve`). There is no query-time geometry | `Backend/src/engine/spatial/hierarchy.js:63, 114`; example caller `Backend/src/workers/indexMaintainer.worker.js:181` | [S] |
| An unassigned cell answers `assigned:false` and fails closed. Task stops are denied by F33 (`serviceabilityFor`); an agent with no declared region is not indexed | `hierarchy.js:173`; `Backend/src/workers/coordinatorSolvePath.js:1893` | [S] |
| Every fine cell must map to exactly one zone. V8 rejects a zone that spans regions | `Backend/src/engine/spatial/cells.js:179`; `Backend/src/engine/config/validators.js:520` | [S] |
| Every spatial-map source defines **one** RNSIT zone, `rnsit-z1`, in region `rnsit` | `Backend/tools/deploy/bootstrapV1Environment.js:66, 68, 342`; `Backend/tools/demo/seedV1Demonstration.js:161` | [S] (definitions, not deployed rows) |
| **No JSSATE engine region** exists in any bootstrap or seed tool. A pinned snapshot carries **one** delivery-domain declaration (`domainId: base.regionId`) | `Backend/src/engine/spatial/deliveryDomain.js:203, 249` | [S] |
| The approved way to publish is `configService.publish` (V8/A6 validation; two distinct approvers for Safety-class changes), then `pinVersion`. Over HTTP it requires the `SAFETY_CONFIG_CHANGE` action class | `Backend/src/engine/config/service.js:358, 523, 605`; `Backend/src/routes/config.routes.js:48` | [S] |
| The legacy obstacle path does **not** use the published map. It uses bounding-box `Zone` rows (`getZoneForCoordinates`); default seeding covers only `prisma.campus.findFirst()` | `Backend/src/services/zoneManager.service.js:95, 225`; `Backend/src/sockets/socket.server.js:185` | [S] |

### B-2 Obstacle intake, authentication, validation, rate limiting

| Fact | Evidence | Label |
|---|---|---|
| Handler `OBSTACLE_REPORT`: rate limit (`limit 10 / 60 s, minIntervalMs 500`), then authentication (`socket.data.robotId`), then zod `{lat:number, lon:number, severity?: LOW\|MEDIUM\|HIGH\|CRITICAL = MEDIUM}` | `dtaro.handler.js:86-90, 118-130`; `Backend/src/sockets/rateLimit.js:4` | [S] |
| Rejections: unauthenticated gets `ERROR "Not authenticated"`; invalid gets `ERROR "Invalid payload"`; a rate-limited report is dropped silently | `dtaro.handler.js:124, 130, 120` | [S]; [T] INV-2/3/4 |
| **No** region, campus, delivery-domain, coordinate-range or plausibility check exists. The robot supplies severity | `dtaro.handler.js:118-153` | [S] |

### B-3 Storage and TTL

| Fact | Evidence | Label |
|---|---|---|
| `storeObstacle` writes KV `ekb:event:{id}` with a 300 s TTL plus set `ekb:obstacles`, falls back to memory, and makes a best-effort `ObstacleEvent` row | `Backend/src/services/ekb.service.js:18, 42-87, 78` | [S] |
| Id `OBS-{ms}-{random}`: **no dedup, no merge key, no version** | `ekb.service.js:43` | [S]; [A] probe P6 |
| Expiry is wall-clock only: active at +299,999 ms, gone at +300,001 ms | `ekb.service.js:18, 95` | [T] CURRENT BEHAVIOUR (OD-4) |
| `getActiveObstacles` has **no caller** (no replay); `sweepExpired` runs every 60 s | `ekb.service.js:95, 150`; `socket.server.js:193-200` | [S] |

### B-4 Recipient discovery and dissemination

| Fact | Evidence | Label |
|---|---|---|
| The zone is resolved (`getZoneForCoordinates`) and stored, but **never used to address** anyone. No code emits to `zone:*` | `Backend/src/services/alertDissemination.service.js:41`; grep finds no `zone:` emitter | [S]; [T] CURRENT BEHAVIOUR (OD-1/OD-2) |
| Recipients come from a **fleet-wide scan** of `robots:all` and a server-side intersection over registry `plannedPath`; there is no region filter | `alertDissemination.service.js:73, 87` | [S] |
| `plannedPath`'s only non-null writer is `rerouteRobot` itself, so the recipient set is empty in practice | `Backend/src/services/robotRegistry.service.js:286`; `Backend/src/services/routing.service.js:174` | [S]; [T] CURRENT BEHAVIOUR (OD-2) |
| An affected robot gets `REROUTE_ALERT` `{obstacleId, lat, lon, zoneId, severity, timestamp}` by direct emit, and `rerouteRobot` is called | `alertDissemination.service.js:103, 110` | [S] |
| `rerouteRobot` returns early on the engine's route cache (no `pickup`/`drop`) and never sends a path to the robot. Its Mapbox fallback is a straight line | `routing.service.js:195, 116`; `Backend/src/services/assignmentProjection.service.js:351, 362` | [S]; [A] probe P4 |

### B-5 Route intersection and receiver-side relevance

| Fact | Evidence | Label |
|---|---|---|
| A point obstacle is modelled as **one** SW→NE segment of ±0.0002°, and parallel segments never intersect | `alertDissemination.service.js:26`; `Backend/src/services/routeIntersection.service.js:29, 77` | [S] |
| A route through the obstacle on the NW→SE bearing is detected; one on the SW→NE bearing is missed | FI-1 setup check passes; FI-1 is `test.failing` | [T] |
| **No receiver-side relevance check exists** in the simulator | `Backend/src/simulation/VirtualRobot.js` (no intersection logic) | [S]; [A] |

### B-6 Reconnect and zone-room membership

| Fact | Evidence | Label |
|---|---|---|
| AUTH joins `robot:{id}` and calls `assignRobotToZone` with the registry's stored zone. The room is joined only when the zone *changed* | `Backend/src/sockets/handlers/robot.handler.js:1075, 1098`; `zoneManager.service.js:153, 167` | [S] |
| The registry TTL is 30 s, and `markOffline` keeps `zoneId`. A reconnect within the TTL is **not** re-joined to `zone:{id}` | `robotRegistry.service.js:38, 239` | [S]; [T] FI-2 (`test.failing`) |

### B-7 Simulator obstacle generation and alert handling

| Fact | Evidence | Label |
|---|---|---|
| While `ACTIVE`, each 2 s tick emits `OBSTACLE_REPORT` with probability 0.002, at a random point within ±0.0001° of the robot itself, from a seeded per-robot stream. The robot does not react | `VirtualRobot.js:3882`; `Backend/src/simulation/constants.js:4, 120`; `simulationConfig.js:122, 126` | [S] |
| `REROUTE_ALERT` acts only on `newPath`, else `obstacleLocation`; the dissemination payload has neither, so it is a no-op. A `newPath` payload does change navigation | `VirtualRobot.js:1127, 2347` | [S]; [T] CURRENT BEHAVIOUR + control |
| Fenced `REROUTE` is consumed (`case "REROUTE"`) but has no producer | `VirtualRobot.js:1605`; `fencing.js:62` | [S] |
| You cannot place an obstacle at chosen coordinates through the simulator; only the rate and seed are configurable | `simulationConfig.js:122, 126` | [S] |

### B-8 Dashboard visibility and campus-admin isolation

| Fact | Evidence | Label |
|---|---|---|
| `ALERT_CREATED` goes through `dashboardBroadcast.emit` to `dashboard` (SUPER_ADMIN). It is **not** on the campus allow-list (`ROBOT_EVENTS`, `TASK_EVENTS`), so campus ADMIN rooms never receive it (default deny) | `alertDissemination.service.js:56`; `Backend/src/sockets/dashboardBroadcast.js:14, 33, 46, 109` | [S]; [T] INV-5 + control |
| The frontend shows obstacles as an event-log line and an information modal only; it has no map marker, zone overlay or `ZONE_UPDATED` listener | [CURRENT_IMPLEMENTATION_MAP §7](CURRENT_IMPLEMENTATION_MAP.md) | [A] |

### B-9 F27's dependency on database `Zone` rows

| Fact | Evidence | Label |
|---|---|---|
| A route's traversed zones come from the **pinned published map** (agent cell plus stop cells only) | `Backend/src/services/v1DemonstrationComposition.js:375` | [S] |
| A simulated agent's **authorised** zones come from **database `Zone` rows** in its region (`prisma.zone.findMany({ where: { regionId } })`). A physical agent uses the same rows when `authorisation === "REGION"` | `Backend/src/services/agentFacts.service.js:130, 236`; `Backend/src/simulation/simulatedAgentState.js:258`; `Backend/src/services/fleetProviders/physicalFacts.js:180` | [S] |
| F27 denies a route that crosses a zone missing from the authorised set | `Backend/src/engine/feasibility/predicates/f27.js:47, 78` | [S] |
| **Consequence:** a zone published in configuration without a matching `Zone` row in the database would deny assignments through it. Adding `Zone` rows also changes the legacy bounding-box lookup, which reads every `Zone` row. Capacity pricing, which is per-zone, is `DEFERRED` | `Backend/src/workers/registry.js:327-330` | [S] (inference from the code paths; not executed) |

### B-10 Regression tests

| Fact | Evidence | Label |
|---|---|---|
| `Backend/tests/unit/dtaro/obstaclePipeline.test.js` (655 lines, 27 tests): INV-1…INV-6 (`:286-485`), CURRENT BEHAVIOUR (`:486-566`), FI-1 (`:599`, `test.failing` `:618`), FI-2 (`:623`, `test.failing` `:651`) | file | [S] |
| Re-run this session: **27/27 passed**; FI-1 and FI-2 pass *as failing tests* | `npx jest … obstaclePipeline.test.js` | [T] 2026-10-22, this step |
| Step 2, same tree (the test file's SHA-256 is unchanged): 12 of 12 negative-control mutants caught; focused set 11 suites / 319 tests; `npm test` exit 0 (335/336 suites, 10,885/10,900 tests, 0 failed, 15 pending) | Step 2 report | [T] 2026-10-22, Step 2 |
| `npm run gates` is **not** all passing: 7 of 8. `gate:composition` fails on the external B1 blocker ("no routing engine is selected"); that gate excludes `tests/` (`Backend/tools/gates/checkCompositionRoot.js:99`) | Step 2 | [T]; [S] |
| `redisKv.integration.test.js` was **skipped** (15 pending): `REDIS_TEST_URL` was absent. The Redis integration tests did **not** run | Step 2 | [T] |

---

## C. Decision register

No decision below has been made. The "Recommendation" column is the audit's view, and it is empty where the evidence does not support one.

| ID | Decision required | Evidence and consequences | Safe options | Recommendation, if supported | Owner decision | Implementation gate |
|---|---|---|---|---|---|---|
| **OD-1** | Which zone model is authoritative for DTARO? | ADR-28 (frozen): region ⊃ zone ⊃ cell, by published assignment (B-1). The legacy bounding-box zones contradict this and are first-campus-only. Only **one** RNSIT zone is defined, and JSSATE has **no** region. B-9: publishing new zones in configuration alone would make F27 deny routes; adding `Zone` rows also changes the legacy lookup | (a) Published engine zones (ADR-28). (b) Keep legacy bounding boxes (contradicts ADR-28). (c) A new derived grid (would have to be published to satisfy ADR-28) | (a) is the only option that adds no spatial architecture. Multi-zone behaviour also needs: a multi-zone RNSIT map publish (V8/A6, two approvers, `pinVersion`); matching `Zone` rows with `regionId` so F27 stays satisfied; and a decision on how those rows interact with the legacy lookup | **OPEN** | Blocks zone membership and zone delivery. Does **not** block test-only work on synthetic maps |
| **OD-2** | Who receives an alert? | Today the zone is computed but unused, and recipients are empty (B-4). The historical communication audit ruled *current-zone-only* **DO NOT IMPLEMENT** (silent false negatives for routes leaving the zone). The August plan proposed *current zone ∪ active-route-zone watchers*: **a proposal, not approved** | (i) Current zone only: fewest messages, misses robots whose route enters the zone later. (ii) Current zone ∪ zones the active route traverses: fewer misses, more unnecessary alerts, needs route-zone subscriptions maintained across OFFER/settle/withdraw. (iii) Route-intersecting robots within the same region: no zone scoping, needs a server-side route source, costs O(robots in region) per report | None until measured. Measure each policy's false negatives (relevant robot not notified) and unnecessary alerts (notified robot not relevant) on a deterministic fixture first (section E) | **OPEN** | Blocks delivery. Measurement does **not** need it |
| **OD-3** | Who may replan, and through what protocol? | Robot-local replanning diverges from the OFFER corridor and fails completion grading (A-4). `REROUTE` exists but has no producer. The campus router has no blocked-edge input [A]. The V1 engine is frozen (A-2) | (A) Robot-local A*: **prohibited** by A-4. (B) Engine-produced fenced `REROUTE` that also updates the commanded corridor (needs the freeze lifted). (C) No autonomous replan in V1: hold and escalate (failure row A8 → operator queue); its effect on the lease and supervision must still be specified | No implementation recommended. (B) is the only protocol-compatible replan, and it requires the owner to lift the freeze **and** specify the fenced protocol | **OPEN** | **Blocks any replan or reroute work.** Out of scope until authorised |
| **OD-4** | Obstacle lifecycle | Today: 300 s wall-clock TTL; silent expiry; no confirm, clear, version or replay (B-3). Clock expiry treats "unknown" as "clear" | (a) Keep the 300 s TTL. (b) An explicit lifecycle, e.g. `ACTIVE → STALE → RECHECK_REQUIRED → CLEARED` (August plan; **not introduced**) | No recommendation on values. Open questions: who may clear (a robot, an operator)? What evidence clears it? Does staleness re-notify? What happens to robots already diverted? Is versioning needed for ordering? | **OPEN** | Blocks lifecycle and replay features. Characterisation test at `obstaclePipeline.test.js:545` |
| **OD-5** | Reporter trust and validation | Existing boundaries: authentication, rate limit, schema (B-2). There is **no** reporter-region binding, coordinate range, plausibility against the reporter's last accepted fix, stale-report rejection, or conflict handling. Severity is robot-supplied. **A robot report does not prove an obstacle exists** | Policies to decide, with no thresholds proposed here: (1) bind the report's point to the reporter's region; (2) a plausibility distance from the reporter's position; (3) severity as advisory vs a hazard class (the historical audit lists agent severity as a hazard class under DO NOT ADD); (4) maximum report age; (5) handling of conflicting or duplicate reports | Severity should remain advisory, never a hazard class (consistent with the recorded DO NOT ADD). No thresholds recommended | **OPEN** | Blocks report hardening. Characterisation tests can proceed |
| **OD-6** | What is a robot's campus authority? | `Robot.campusId` is nullable. `accessScope.campusIdForRobot` returns null when the agent region disagrees (`Backend/src/services/accessScope.service.js:166`). The engine places agents by declared or observed region, and shard membership is sticky | (a) Engine region (declared, else observed via the published map). (b) `Robot.campusId`. (c) Require both to agree | No change recommended now. (a) is always present for an indexed robot, but changing identity resolution touches authorisation and is the owner's call | **OPEN** | Blocks region-qualified rooms and recipients. Authorisation code must not change without it |
| **OD-7** | Simulator obstacle model | Today: random points near the reporter itself, with seeded rate and stream (B-7). This cannot give a ground truth for "should robot X have been told?" | (a) Keep random self-reports (reproducible per seed, not meaningful for relevance). (b) Deterministic placed world obstacles that a robot encounters on its path | (b) for any relevance or measurement work; random reports should be off (`obstacleProbability` 0) in measurement runs. **No simulator change in this step** | **OPEN** | Blocks simulator-side end-to-end measurement. A test-only fixture does not need it |
| **OD-8** | Dashboard visibility | SUPER_ADMIN only, by default deny (B-8). Campus ADMIN visibility of obstacles is an open RBAC question | (a) Keep SUPER_ADMIN only. (b) Relay to a campus ADMIN for their own campus (needs a payload field that resolves a campus, plus allow-list membership) | None. A permission expansion is the owner's call; the default deny stays | **OPEN** | Blocks campus-admin obstacle UI only |
| **OD-9** | Is JSSATE in DTARO scope? | No JSSATE engine region or cover is defined (B-1). A snapshot pins one delivery domain, so two serviceable campuses cannot be pinned together today. D1 coverage governance is unresolved [A] | (a) RNSIT only. (b) RNSIT + JSSATE once the region, cover, declaration and the single-domain limitation are addressed | Use **synthetic two-region fixtures** for isolation tests until configuration and governance exist. Do **not** add JSSATE to production configuration | **OPEN** | Blocks real two-campus demonstration. Synthetic isolation tests do not need it |
| **OD-10** | Where do DTARO metrics live? | `Backend/src/services/metrics.service.js` holds legacy per-event KV writes (`recordAllocation`); its own header says extending that shape is rejected (§21.2). Engine metrics are **derived from the durable record** (`Backend/src/engine/observability/metrics.js`, Tier 1); quantities with no durable row go to an advisory in-process registry published as `engine:sli:{shard}:{instance}` snapshots (`Backend/src/engine/observability/sli.js`). Both live in the engine tree (A-2). Today only an `obstacles.active` gauge exists | Metrics needed: reports accepted/refused by reason; duplicates; recipients selected; deliveries; delivery latency; receiver relevance verdicts; **missed relevant robots** (needs ground truth); **unnecessary alerts**; expiries and clears. Placement options: (a) offline/test computation only; (b) derive from a durable obstacle/alert record (the `ObstacleEvent` table exists but is write-only); (c) the advisory SLI registry (engine tree) | Start with (a): no instrumentation, no per-event KV writes. Choosing (b) or (c) is an architecture decision | **OPEN** | Blocks production instrumentation. Offline measurement does not need it |

---

## D. Owner decisions required before runtime work

### D-1 Blocking safety and architecture decisions

These must be resolved before the **corresponding production feature** is built. They do not block test-only work.

| Decision | Blocks |
|---|---|
| OD-1 | Zone membership and zone-scoped delivery |
| OD-2 | Changing recipient selection or delivery |
| OD-3 plus the V1 freeze | Any reroute or replan, including a `REROUTE` producer |
| OD-5 | Report hardening (region binding, plausibility, conflicts) |
| OD-6 | Region-qualified rooms and recipient scoping |
| OD-4 | Lifecycle states, clearing, replay |
| OD-8 | Any campus-admin obstacle visibility |
| OD-10 (placement) | Any production instrumentation |

### D-2 Measurement decisions

These can be addressed through tests or offline experiments without changing production behaviour.

- **OD-2:** compare policies offline on fixtures, counting false negatives against unnecessary alerts.
- **OD-10 (option a):** metric definitions computed in tests.
- **OD-7:** deterministic synthetic obstacles inside test fixtures, which needs no simulator change.
- **OD-9:** synthetic two-region isolation fixtures.

### D-3 Deferred decisions

These are explicitly out of scope.

- Physical Pi/ESP32 obstacle contract and behaviour (A-6).
- Engine-authorised replanning (OD-3 option B) until the freeze is lifted.
- Obstacle-aware pricing or feasibility for new assignments.
- Adding JSSATE to production configuration.

---

## E. Smallest safe next step

**Proposal: an offline, deterministic recipient-policy measurement fixture.** It would be one new test file, with no production change.

| Item | Content |
|---|---|
| **What** | A new test under `Backend/tests/unit/dtaro/`. It builds a **synthetic published map** through the production `hierarchy.indexMap` (ADR-28 semantics, synthetic H3 res-11 cells from `cells.cellForPoint`) with **two regions**, each with several zones. It places a fixed fleet with fixed straight-line routes and fixed obstacle points. For OD-2's options (i), (ii) and (iii), computed **in the test only**, it reports per obstacle: notified, relevant (ground truth), **missed**, and **unnecessary** |
| **Ground truth** | Defined in the fixture as "the route passes within *r* of the obstacle", evaluated over a declared **sweep** of *r*. The sweep is a measurement parameter, **not** a chosen threshold (OD-5 stays open) |
| **Why it is safe** | Test-only; uses production spatial primitives read-only; touches no handler, service, engine, simulator, configuration or database; makes no recipient decision |
| **Prerequisites** | (1) Owner agrees that a test-local computation of candidate policies is an offline experiment, not a parallel production subsystem. (2) Owner agrees the results are **fixture-specific**: not evidence of production performance, and not comparable to the paper. No other owner decision is needed |
| **Exit criteria** | (a) The only diff is the new test file (protected-path `git diff` empty). (b) Deterministic: two consecutive runs give identical counts. (c) Each policy's counts for the fixture equal hand-derived expected values, written in the test. (d) A cross-region case shows the region-bounded policies notify **0** robots in the other region. (e) It runs offline with no database, network, or new dependency. (f) `obstaclePipeline.test.js` and the focused suites still pass |
| **Not included** | Changing any recipient behaviour, fixing FI-1/FI-2, metrics instrumentation, simulator changes, configuration publishing |

If the owner does not accept prerequisite (1), there is no further safe step without an owner decision, and work should wait for OD-1/OD-2.

---

## Claims not verified in this record

- **Deployed database contents:** live `Zone`, `Region`, `CellAssignment` and `ObstacleEvent` rows were not inspected.
- **The V1 engine freeze:** it rests on an owner instruction and project memory. No repository record states it.
- **The B-9 consequence:** it is inferred from the code paths. No run published a multi-zone map against an F27-evaluated route.
- **Full-suite and gate results:** they come from Step 2, on a tree whose tracked files and test-file hash are unchanged since. They were not re-run for this document.
- **Pi and ESP32 obstacle behaviour:** cited from the earlier audit and the 2026-10-17 system audit. The repositories were not inspected.

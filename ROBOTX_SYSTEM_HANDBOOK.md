# RobotX — System Handbook

**The practical companion to [`ARCHITECTURE.md`](ARCHITECTURE.md).** Where that document says *what the
system is*, this one answers *"if I joined this project today, what do I need to understand?"* — in
plain language first, implementation second.

| | |
|---|---|
| **Reconstructed** | 2026-09-07 |
| **Branch / HEAD** | `feature/dashboard` / `1223574`, **working tree dirty** (the uncommitted P0 presentation pass) |
| **Written by** | reading the repository and **executing** its verification tooling — not from memory, not from prior editions |
| **Previous edition** | 2026-08-11 at HEAD `63f5c58`, preserved byte-for-byte at [`docs/history/handbook-snapshot-2026-08-11.md`](docs/history/handbook-snapshot-2026-08-11.md) |

> ### The one rule for using this handbook
>
> **Every number here was measured on the tree named above.** The tree moves. Before you quote a figure
> in a presentation, an interview, or a report — **re-measure it.** §36 tells you exactly how, and every
> command takes under ten minutes.
>
> An explicitly documented unknown is worth more than a confident wrong answer. Where this document
> says **NOT REPRESENTED**, **UNKNOWN**, or **NOT PROVEN**, that is a finding, not an omission.

---

## Contents

**Part I — Orientation**
1. What RobotX is, in three levels of detail
2. The problem it solves
3. The mental model
4. Core terminology — the words that mean specific things
5. Current status, honestly

**Part II — The system**
6. Repository structure
7. How the backend works
8. How the database works
9. How Redis works
10. How a robot connects
11. How Socket.IO works *in RobotX*
12. How tasks work
13. How assignment works (and why it doesn't run)
14. How telemetry works
15. How the dashboard works
16. How campuses and regions actually work
17. The robot: hardware, firmware, and what this repository knows about it
18. Simulation
19. Authentication and authorization

**Part III — Operating it**
20. Configuration and environment
21. Development workflow
22. Testing — five lanes and eight gates
23. Debugging and troubleshooting
24. Metrics and observability
25. Deployment

**Part IV — The engineering story**
26. Scalability: what was measured, and what it proved
27. Profiling: what was actually found
28. The clustering experiment, and why it failed
29. The negative results worth keeping
30. Safety, release gates, and why nothing is green

**Part V — Reference**
31. Important files
32. Important functions and classes
33. Common workflows, end to end
34. Current limitations
35. Future roadmap — and the AI boundary
36. How to re-verify everything in this document
37. Interview and presentation mental models
38. The one-page summary

---

# PART I — ORIENTATION

## 1. What RobotX is, in three levels of detail

### Level 1 — for anyone

RobotX is the **control tower** for a fleet of delivery robots.

Robots drive around a campus carrying things. RobotX is the software that knows where every robot is,
what its battery is doing, whether it is healthy, what job it has been given, and whether that job is
going well. A human operator watches a live map in a browser and can create delivery jobs, stop a
robot, or reroute one around an obstacle.

The hard part is not the map. The hard part is **deciding which robot should do which job** — and
doing it in a way you can *explain afterwards*, that never double-books a physical machine, and that
never quietly loses a job.

### Level 2 — for an engineer

A Node.js backend holding thousands of long-lived WebSocket connections. Robots connect and stream
telemetry every two seconds; browsers connect and receive a filtered live feed. PostgreSQL holds
durable truth; Redis holds live state and fans broadcasts across processes. On top of that platform
sits an assignment engine that turns "someone wants a delivery" into "this specific robot is
contractually bound to this specific leg of work."

That engine replaced a simpler one. The old one picked the nearest available robot by a weighted score
and dispatched it. The new one runs a **round loop**: it batches queued work, generates candidates,
puts every candidate through a 38-predicate feasibility gate, prices the survivors with a cost
function in absolute units, solves a min-cost flow, and commits the winner inside a `SERIALIZABLE`
transaction with six guards and a fencing token.

**The old engine has been deleted. The new one is built, tested, and refuses to start.**

### Level 3 — for someone who will maintain it

RobotX is two systems sharing a process.

**The host platform** is live, measured, and optimised. It authenticates robots, ingests telemetry at
~1 000 messages/second at the tested plateau, keeps live state in Redis with a throttled Postgres
mirror, handles obstacle reports and rerouting, dispatches operator commands, and streams a
room-scoped feed to the dashboard. Its performance characteristics are known precisely: see Part IV.

**The assignment engine** is 196 modules under `Backend/src/engine/`. Twelve of its nineteen registered
workers run in production. The one that matters — the coordinator's round loop — **refuses to compose**,
because it needs a routing engine that has not been selected, fifteen calibration values that nobody
has derived, and six input families for which there is no code and no named data source.

That refusal is the single most important thing to understand about this codebase, and it is
deliberate. The system would rather do nothing than decide on invented numbers.

---

## 2. The problem it solves

### 2.1 The business problem

A campus has robots and it has delivery requests. Requests arrive continuously and unpredictably.
Robots have finite battery, finite carrying capacity, different capabilities, and they are already
partway through other jobs. Somebody has to decide who goes where, and the decision has to be
defensible when it goes wrong.

### 2.2 The technical problems, in the order they bite

| Problem | Why it is hard | What RobotX does |
|---|---|---|
| **Robots have no inbound address** | NAT, cellular, intermittent connectivity | Persistent Socket.IO connections; the server pushes |
| **Position changes constantly, but history must be durable** | 0.5 Hz × N robots of row writes will kill Postgres | Redis every tick; Postgres on a dirty-state gate (~4/min) |
| **Two things must never both be true** | Two coordinators, one robot, two jobs | A `SERIALIZABLE` commit with row locks, six guards, a per-commitment fencing token, and two schema backstops |
| **Work must never vanish** | A background job with no owner *will* silently drop something | The request path's last act is a durable queue row; the round path's first act is to read it. No closures, no timers, no process-local state between them |
| **A decision must be explainable months later** | "The algorithm chose it" is not an answer | Two tiers of decision record, pinned input snapshots, byte-for-byte replay, eight explanation queries, exact per-term sensitivity margins |
| **Unknown must not mean yes** | A gate that can't see something must not wave it through | Three-valued feasibility: `ADMIT` / `DENY` / `INDETERMINATE`, and indeterminate **denies** for every identity and resource predicate |
| **The system must be honest about what it cannot do** | Every incentive pushes toward a green dashboard | Eight build gates, a 24-row release table, refusals that name their blocker and its owner, and a composition root that will not start a worker it cannot fully wire |

### 2.3 The one-sentence version of the whole architecture

> **Make it impossible to be wrong quietly.**

Every unusual thing in this codebase — the fencing tokens, the three-valued gate, the durable queue,
the composition refusals, the immutable config triggers, the "state the blocker's owner" discipline —
is an instance of that sentence.

---

## 3. The mental model

Hold these five pictures and most of the codebase follows.

### 3.1 Two stores, two jobs

```
   PostgreSQL                          Redis
   ──────────                          ─────
   "What is TRUE"                      "What is HAPPENING"
   Durable, transactional              Ephemeral, fast, lossy
   Written ~4×/min per robot           Written ~30×/min per robot
   ACID, SERIALIZABLE, constraints     No transactions assumed
   Losing it = the system is down      Losing it = the system degrades

   AUTHORITATIVE. Always.              AUTHORITATIVE. Never.
```

Every Redis key in RobotX either mirrors a Postgres row or is genuinely ephemeral. The module that
decides exclusivity — `engine/commitment/commit.js` — takes **no cache dependency at all**.

### 3.2 Four layers, and which store each uses

```
L1  REQUEST     validate, admit, queue          → Postgres (Task, Leg, WorkQueue)
L2  LIVE STATE  where is everyone, right now    → Redis (advisory) + Postgres (mirror)
L3  COMMITMENT  the durable contract            → Postgres, SERIALIZABLE
L4  PLAN STATE  the round's working memory      → RAM. Never persisted.
                                                  Reconstructed on failover.
```

If you remember one thing: **L4 is deliberately volatile.** A soft reservation is coordinator memory
and is *never written anywhere*. A failover does not "recover" plan state — it **reconstructs** it from
L3, which is what makes the reconstruction correct rather than optimistic.

### 3.3 Two vocabularies for the same fleet

The schema carries both generations side by side, on purpose.

```
   LEGACY (what the UI reads)          ENGINE (what decisions read)
   ─────────────────────────           ────────────────────────────
   Robot                        ←1:1→  Agent → AgentClass → {Mobility,
                                                Energy, Container} models
                                                + CapabilityBundle
   Task                         ←m:n→  Mission → Leg (ordered) → Stop (ordered)
   Task.robotId,
   Robot.currentTaskId          ←────  Commitment (fenced, SERIALIZABLE)
   Location / Campus / Zone            Region → Site → CellAssignment (H3)
   (none)                              WorkQueue
```

**Neither is dead.** The bridge is one module, one direction:
`services/assignmentProjection.service.js` copies an accepted commitment into the legacy columns so
the old screens show the new engine's decision. It writes *only* legacy columns, and a test asserts
that no engine module can import it and it can import no engine module.

### 3.4 The request path and the round path never touch

```
   REQUEST PATH                          ROUND PATH
   (synchronous, fast)                   (leader-elected, batched)

   POST /api/tasks/assign
        │
        ├─ validate
        ├─ cutover gate  ──── 503 if not live (nothing written)
        ├─ Task row
        ├─ Mission + Leg + Stops
        ├─ arm the §4.5 deadline
        └─ WorkQueue row  ●─────────────►  ● claim batch
                          │                  │
              THE HANDOFF │                  ├─ candidates
                          │                  ├─ feasibility gate
              Nothing in  │                  ├─ cost Φ
              between.    │                  ├─ solve
              No closure. │                  ├─ commit (+ Outbox, same txn)
              No timer.   │                  └─ settle the queue
              No memory.  │
```

The gap between them is a **durable row**. That is the whole design. The legacy system had a
`setImmediate` there, with no owner, no timeout, no retry and no observability — and it produced tasks
"stuck at PENDING with no record of the failure."

### 3.5 The cutover switch is a conjunction

```
  engine is live  =  process ENGINE_ENABLED === "true"
                     AND
                     this shard's published cutover.engine_enabled binding is true
```

The first half is a **deployment** decision. The second is a **published configuration binding, scoped
per region** — which is what makes "stage it on one region, watch it, roll it back on regression"
expressible. **Neither half is true anywhere today**, which is why every task submission returns 503.

---

## 4. Core terminology

Words that mean something specific here. Using them loosely is how documentation drifts.

| Term | Means |
|---|---|
| **Agent** | The engine's abstraction for a thing that can execute work. §2.1 chose it over "robot" so that ground robots, drones, vehicles and human couriers are representable **without a structural change**. One `Agent` per `Robot`, but an `Agent` may have no `Robot` row |
| **Robot** | The legacy row. A commissioned physical unit, its credentials, its live mirror, its socket binding |
| **Task** | The unit of **customer-visible work**. What somebody asked for. **Not** the unit of assignment |
| **Mission** | The ordered set of Legs that discharges one or more Tasks |
| **Leg** | A contiguous sequence of Stops executed by **one** agent under **one** commitment. **This is the unit of assignment** and the decision index of the objective |
| **Stop** | A located, time-windowed action: PICKUP, DROP, WAIT, CHARGE, INSPECT, TRANSFER, REPOSITION |
| **Commitment** | The **durable contract** binding an Agent to a Leg. Only HARD commitments exist in the store; a CHECK constraint enforces it |
| **SOFT reservation** | Round-local coordinator **memory**. Never written anywhere. There is no third case |
| **Fence / fencing token** | A monotone counter proving a command is not stale. Two scopes: *commitment* (compared per commitment id) and *agent* (`authorityEpoch`) |
| **Round** | One pass of the coordinator loop over a claimed batch |
| **Shard** | The unit of the single-writer guarantee. Exactly one coordinator per shard |
| **Region** | The operating domain. The real isolation boundary |
| **Zone** | A broadcast and pricing sub-area. A zone **may not straddle a region** |
| **Cell** | An H3 hexagon. Containment is by **published assignment**, never query-time geometry |
| **Φ (Phi)** | The cost functional. A functional over **plans**, not a score over pairings |
| **CU / milli-CU** | Cost Units. **Absolute**, never normalised. Integer milli-CU on the wire |
| **γ (gamma)** | The cost of one candidate = `Φ(plan with the new Leg)` |
| **Predicate F1…F38** | The feasibility gate. Class **I**dentity, **R**esource, **P**olicy, **C**apability, **F**orecast |
| **INDETERMINATE** | The gate could not see. **For class I and R this DENIES.** *Unknown is not permission* |
| **Tier 0 / 1 / 2** | What a mechanism's failure costs: physical incident / unsupportable system / worse allocation |
| **Outbox** | The transactional outbox. **Every** command to an agent is emitted by draining it, and its row is written in the *same transaction* as the state change that authorises it |
| **Cutover** | Making the engine the decision path for a shard, by publishing a config binding |
| **B1 / B8** | Execution-plan blocking items. B1 = routing engine selection. B8 = the calibration owner |
| **S-1…S-8** | V1 stop conditions. Score today: **3 of 8** |
| **DTARO** | The **deleted** legacy allocator. Its name survives in a socket handler filename and in Redis key comments. It is not a current component |

---

## 5. Current status, honestly

Measured on 2026-09-07 by running the tooling, not by reading a report.

| | |
|---|---|
| **Test suite** | **175 suites / 7 581 tests / 0 failures / 0 skips**, exit 0, 406 s |
| **Build gates** | **7 PASS, 1 FAIL** (`gate:composition`), `npm run gates` **exits 1** |
| **Calibration gate** | **FAIL at 39** blocking findings. 250 parameters: 52 DERIVED / 160 PROVISIONAL / 38 UNCALIBRATED; 54 Safety-class |
| **Release verdict** | **BLOCKED** — 24 blocking gates, **0 green**, 17 RED (all stale evidence, ~8.5 days), 7 NOT_EVALUATED |
| **Routing readiness** | **OVERALL: BLOCKED** — D1, D3, D8 |
| **V1 stop conditions** | **3 of 8** |
| **Phase 15** | **IMPLEMENTATION CLOSED · RELEASE BLOCKED** |
| **`POST /api/tasks/assign`** | **503 `ENGINE_NOT_LIVE`** on every shard |

**What that adds up to:** a platform that works and an engine that will not lie about being ready.

---

# PART II — THE SYSTEM

## 6. Repository structure

```
RobotX/
├── ARCHITECTURE.md                 ← what the system IS (companion to this file)
├── ROBOTX_SYSTEM_HANDBOOK.md       ← this file
├── NEXT_GENERATION_ASSIGNMENT_ENGINE.md   ← THE FROZEN ARCHITECTURE (authority)
├── IMPLEMENTATION_EXECUTION_PLAN.md       ← 16 phases, blockers, release gates
├── PHASE_*_{IMPLEMENTATION_REPORT,INDEPENDENT_VERIFICATION,REMEDIATION_AND_CLOSURE}.md
│                                   ← 48 files. Dated engineering evidence. DO NOT REWRITE
├── *.geojson                       ← campus map source data
│
├── Backend/
│   ├── server.js                   ← THE COMPOSITION ROOT (1 184 lines, mostly reasoning)
│   ├── src/
│   │   ├── app.js                  ← Express pipeline + unauthenticated GET /health
│   │   ├── routes/          (14)   ← 13 groups; every one does router.use(authUser)
│   │   ├── controllers/     (14)
│   │   ├── services/        (18)   ← transport-agnostic business logic
│   │   ├── sockets/
│   │   │   ├── socket.server.js    ← connection gate, dashboard JWT check
│   │   │   ├── handlers/     (5)   ← robot · telemetry · command · dtaro · offer
│   │   │   ├── robotSockets.js     ← process-local map: PRESENCE ONLY, never delivery
│   │   │   └── rateLimit.js
│   │   ├── engine/         (196)   ← the assignment engine
│   │   ├── workers/         (23)   ← 19 registered
│   │   ├── simulation/       (3)   ← the reference agent implementation
│   │   ├── cache/kv.js             ← THE Redis facade
│   │   ├── db/prisma.js            ← THE Prisma client + runSerializable/selectForUpdate
│   │   ├── middlewares/      (4)
│   │   └── config/           (6)
│   ├── prisma/                     ← schema.prisma (4 065 lines, 74 models), 29 migrations
│   ├── tests/              (175)   ← 5 Jest projects
│   ├── tools/                      ← gates · routing · release · replay · safetyCase · verify
│   └── benchmark/                  ← harness + 18 result directories
│
├── Frontend/                       ← React 19 + Vite, 114 files
├── docs/
│   ├── adr/                (40)    ← frozen decisions, each with its rejected alternative
│   ├── phase15/                    ← current programme status + archive/
│   ├── v1/                         ← V1 stop conditions and control
│   ├── runbooks/                   ← cutover · rollback · demonstration
│   ├── safety-case/                ← generated; DO NOT HAND-EDIT
│   ├── release-decisions/
│   └── history/                    ← superseded docs + the two snapshots this pass archived
└── formal/                         ← TLA+ specifications
```

### 6.1 The engine's own layout

```
Backend/src/engine/
├── config/       the 250-parameter register, resolver, validators, publish/pin
├── domain/       Agent, Work, Capability, Custody, Purpose + legacy mappers
├── spatial/      H3 cells, hierarchy, region boundary
├── intake/       admission + the durable queue write        ← LIVE
├── candidates/   availability index, expansion, admissible lower bound, Ω
├── feasibility/  38 predicates + three-valued logic + the systemic guard
├── energy/       consumption, usable capacity, reserves, charge curve, E_return
├── payload/      spec, container, packing, load state, custody evidence
├── plan/         column builder, insertion, plan builder, timeline
├── cost/         Φ and its six terms, exchange rates, sign discipline, units
├── solve/        round, objective, min-cost flow, budgets, cadence, regime
├── commitment/   THE COMMIT: guards G1–G6, fencing, leases, idempotency, clock
├── dispatch/     outbox, offers, sequence, escalation, dedup handshake  ← LIVE
├── lifecycle/    Leg and Task state machines, cancellation, reassignment, settlement
├── supervision/  timers, reconciler, progress, verification, expiry actions ← LIVE
├── shard/        election, leadership, membership, failover, sizing        ← LIVE
├── observability/ decision records A/B, explanation, SLI, invariants, calibration
├── degraded/     the mode register and its transitions
├── failure/      the §18.2 catalogue, agent/infra failures, external escalation
├── fairness/     the §17.4 ladder, operator capacity, agent starvation
├── security/     session binding, attestation, command signing, override, trust boundaries
├── privacy/      identity store, surrogate keys, erasure
├── cutover/      the switch, agent gate, stage, guardrails, rollback publisher ← LIVE
├── determinism/  fixed point, ordering, snapshot
├── routing/      cell-pair cache, charger reachability   ← needs an INJECTED route fn
├── pricing/      capacity pricing, terminal value          [Tier 2]
├── map/          obstruction classification
└── guards/       tier assertions, tenet scanner, source scan
```

**Reading order for a newcomer:** `TIERS.md` → `domain/` → `feasibility/register.js` → `cost/phi.js`
→ `commitment/commit.js` → `workers/coordinator.worker.js`. That is the spine.

---

## 7. How the backend works

### 7.1 The request pipeline

```
HTTP request
  → helmet()                     security headers
  → cors(corsOriginDelegate)     allow-list from FRONTEND_URL
  → express.json()
  → cookieParser()
  → logger.http / httpEnd        request + response with timing
  → GET /health                  ← UNAUTHENTICATED. Everything else is behind /api
  → /api → routes/index.js       13 groups
      → router.use(authUser)     JWT from cookie or Bearer; re-reads the User row
      → [rate limiter]           per-route token bucket
      → [requireElevatedRole]    where the whole group is privileged
      → [requireActionClass]     §23.4's four high-privilege actions
      → controller               thin, asyncHandler-wrapped
      → service                  transport-agnostic
  → notFound
  → errorHandler
```

### 7.2 The socket pipeline

```
Socket.IO connection
  → is this a dashboard? (origin header or Mozilla UA)
      YES → verify the SAME JWT the REST middleware uses
            fail → emit UNAUTHORIZED, disconnect
            pass → join room "dashboard", re-hydrate active task routes
      NO  → nothing yet; it must emit AUTH
  → register 5 handler modules (all of them, on every socket):
       robot.handler      AUTH, HEARTBEAT, SESSION_REKEY_ACK, disconnect
       telemetry.handler  TELEMETRY
       command.handler    COMMAND_ACK
       dtaro.handler      OBSTACLE_REPORT, TASK_COMPLETE, ROBOT_FAULT
       offer.handler      OFFER_ACCEPT / OFFER_REJECT / OFFER_DEFER
  → also: socket.on("assign_task")  ← the legacy socket task-creation path,
                                       routed through the SAME task.service function
                                       the REST controller uses
```

**Why all five register on every socket:** the handlers are individually inert for a client that never
sends their events, and registering conditionally would mean deciding *what kind of client this is*
twice. The offer handler additionally checks the cutover switch, so its inertness is *enforced* rather
than argued.

### 7.3 Dependency injection everywhere

Nothing reaches for a global. `prisma`, `kv`, `io`, `logger` and the config snapshot are passed in.
This is not style — it is what makes 175 test suites able to drive real modules with real logic and
fake stores.

Two mistakes this codebase has actually made and fixed are worth internalising:

1. **`socket.request.app.locals.config` does not exist.** The Socket.IO upgrade request never passes
   through the Express app. Three handlers read it, got `undefined` in every deployment, and three
   §23.5 security controls were silently off. The fix threads `appLocals` in as a parameter.
2. **`io.app` does not exist either.** The socket `assign_task` path read `io?.app?.locals?.config`,
   got `null`, and therefore refused **every** socket task creation with `ENGINE_NOT_LIVE` on every
   shard, for ever. It failed *closed*, which is why no test and no gate caught it — the path simply
   never worked.

**The lesson: a wiring bug that fails closed is invisible.** Look for paths that have never succeeded.

---

## 8. How the database works

### 8.1 Prisma is the only door

`src/db/prisma.js` owns the single client and exports three things:

| Export | Why |
|---|---|
| `getPrisma()` / `connectPrismaWithRetry()` | The client, with boot retry |
| **`runSerializable(prisma, fn)`** | Prisma cannot express `SERIALIZABLE`. §10.3.2's commit needs it |
| **`selectForUpdate(tx, …)`** | Prisma cannot express `FOR UPDATE`. The commit needs row locks |
| `isSerializationFailure(e)` | So a serialization conflict is retried, not reported as a bug |

`previewFeatures = ["metrics"]` is enabled, and that is not incidental: it is what makes
`prisma_pool_connections_busy` and `prisma_client_queries_wait_histogram_ms` readable from
`GET /health`, and **pool wait is the metric that found the 500-robot bottleneck.**

### 8.2 Three things are enforced by the *database*, not by code

Because application logic can be defective and constraints cannot:

1. **`ConfigVersion` and `ConfigScopeBinding` are immutable** — a trigger rejects UPDATE.
2. **`Commitment.kind = 'HARD'`** — a CHECK constraint. This is the schema backstop for invariant I18
   ("no SOFT reservation is ever written to the Commitment Store").
3. **A partial unique index enforces `≤ capacity[agent_class]` active commitments per agent** —
   invariant I1. Even if every guard were bypassed, the database would refuse the second commitment.

### 8.3 The models you will actually touch

| Model | You will touch it when |
|---|---|
| `Robot` | Anything about a physical unit: commissioning, live state, status, specification |
| `Task` | Anything a customer asked for |
| `Agent` / `AgentClass` | Anything the engine reasons about, including the four model rows a unit's specification lands on |
| `Mission` / `Leg` / `Stop` | Anything about the *structure* of work |
| `Commitment` | Exclusivity. Read carefully before touching |
| `WorkQueue` | The handoff between the request path and the round path |
| `Outbox` | Every command to an agent |
| `Timer` | Every deadline |
| `ConfigVersion` / `ParameterRegisterEntry` | Configuration |
| `DecisionRecordA` / `B` / `InputSnapshot` | Explainability |
| `Zone` / `Region` / `Shard` | Geography and isolation |
| `Telemetry` / `Event` / `Command` / `Decision` | History and the dashboard |

### 8.4 Migrations

29 dated directories, applied in order, each reviewable. The newest —
`20260906120000_robot_specification_and_chassis_class` — is **uncommitted**, and skipping
`npx prisma generate` after applying it produces a `PrismaClientValidationError` on the **first
commission**, surfaced to the browser as a bare `HTTP 500` with nothing in it that names the cause.
That was measured, not anticipated.

```bash
npx prisma migrate deploy   # apply (production-safe)
npx prisma generate         # REGENERATE THE CLIENT. Not optional. Its omission is silent
npx prisma migrate dev      # create + apply (development)
npx prisma migrate reset    # DROPS EVERYTHING, re-applies, re-seeds
npx prisma studio           # browse
node prisma/seed.js         # spatial map + the default agent class
```

---

## 9. How Redis works

### 9.1 One facade, and why

Everything goes through `src/cache/kv.js`. One module means one place where the fallback policy, the
TTL semantics and the pipelining live. The Socket.IO adapter in `server.js` is the single exception,
and it uses its own pub/sub pair because that is what the adapter requires.

### 9.2 The three behaviours that surprise people

**1. It works without Redis.** Every operation degrades to an in-memory `Map` with TTL semantics.
`REDIS_ENABLED=false` is a supported development mode.

**2. It comes back.** A failure schedules a reconnect with capped exponential backoff (1 s → 30 s,
`unref`'d). Before that existed, one transient blip downgraded the process to in-memory mode
**permanently, silently, for the rest of its life.**

**3. The fail-closed rule turns on *why*, not *whether*.**

```
Redis was never configured  → single-process is intentional
                            → the memory lock IS a lock. Use it.

Redis is configured but down → the operator asked for a SHARED lock
                             → advisory caller: granted (§10.4 — "cache
                               unavailability MUST NOT halt commitment")
                             → { advisory: false } caller: 503 LOCK_UNAVAILABLE
```

No caller in this repository passes `advisory: false`. The throw is kept so the capability can be
*expressed*, never as the default — because as the default it made a cache outage able to halt
allocation for a system whose §3.3 rule says the opposite.

### 9.3 The performance primitive you must know

```js
const [a, b, c, d] = await kv.pipeline()
  .get(k1).get(k2).get(k3).get(k4)
  .exec();

const writes = kv.pipeline();
writes.set(k1, v1, { ex: 15 });
writes.set(k2, v2, { ex: 3600 });
await writes.exec();
```

**One round trip instead of N.** The telemetry handler went from ~6 sequential round trips per event to
2. CPU at 500 robots fell from 107 % to 34 %. **This is not a micro-optimisation; it was the second
largest win in the project.**

It is explicitly **not** `MULTI`. It collapses round trips; it does not add cross-key atomicity.
Commands can still partially apply on a connection error — exactly as independent calls could.

### 9.4 Reading the key catalogue

The full table is [`ARCHITECTURE.md` §8.3](ARCHITECTURE.md#83-key-catalogue--every-family-in-the-running-system).
When you add a key, the rule is: **name what is authoritative instead.** Every engine key in that table
does.

---

## 10. How a robot connects

### 10.1 The sequence

```
1. COMMISSION   POST /api/robots/commission
                → Robot row (+ AgentClass, MobilityModel, EnergyModel,
                   ContainerModel, CapabilityBundle for this unit)
                → SET pairing:{robotId} = <one-time code>
                → the simulator attaches a VirtualRobot

2. CONNECT      socket.io-client → ws handshake. No identity yet.

3. AUTH         socket.emit("AUTH", { robotId, pairingCode | token, dedupState?, certificate? })

                server:
                  rate limit 5/60 s
                  Zod parse            → malformed = disconnect
                  robot.findUnique     → unknown robot = disconnect
                                       → SEEDS robotStateCache (this is the one
                                          DB read the telemetry hot path needs)
                  reject capability claims (§23.2)
                  establishCertificateSession  → MTLS or LEGACY
                  legacy path:
                     stored session token matches?  → reconnect
                     else → locked out? → disconnect
                          → pairing code matches? → mint a session UUID
                          → else count the failure (5 → 1 h lockout)
                  bind socket ↔ robot; resolve and CACHE the shard identity
                  SET socket:{socket.id}; mark online in DB + registry
                  disconnect the PREVIOUS socket (after the DB points at the new one)
                  DEL pairing:*; SADD robots:all
                  §11.5 dedup handshake  ← BEFORE AUTH_SUCCESS
                  emit AUTH_SUCCESS { robotId, token, dedup, session }
                  socket.join("robot:{robotId}")
                  assign to a zone → socket.join("zone:{zoneId}")
                  io.to("dashboard").emit("robot_online")

4. STEADY       every 2 s: HEARTBEAT + TELEMETRY
5. WORK         receive OFFER / TASK_ASSIGN / COMMAND / REROUTE_ALERT
6. DISCONNECT   mark offline, SREM robots:all, tell the dashboard
```

### 10.2 The three authentication states

| State | When | What happens |
|---|---|---|
| **Legacy** | No certificate, `AGENT_MTLS_REQUIRED` unset | Pairing code → session UUID → token reconnect. **This is what the simulator uses** |
| **Opportunistic mTLS** | A certificate is presented | Validated and bound `(agent_id, certificate, session_id)` regardless of whether mTLS is required — there is no window in which a real certificate is ignored |
| **Enforced mTLS** | `AGENT_MTLS_REQUIRED=true` | No certificate → refused. **Pairing is refused by name**, not by falling through |

### 10.3 Why the shard identity is cached at AUTH

Every engine-facing decision this session makes asks *"is the engine the decision path for **this
shard**?"*, and the cutover stages that answer per shard.

- Resolving it **per event** → two indexed queries on the telemetry hot path.
- Resolving it **never** (what the code did) → the staged rollout meant nothing on the agent side.
- Resolving it **once at AUTH** → correct for as long as the agent's shard does not change, and a
  migration is the one thing that changes it — at which point the agent is **deliberately
  disconnected**, because a migration already voids its authority epoch and it must re-AUTH anyway.

The heartbeat refreshes the binding on the same throttle as the durable liveness mirror, as a backstop
for a session that outlives its invalidation. `agentGate`'s freshness bound is twice that interval, so
one missed refresh does not sever a healthy session while two do.

---

## 11. How Socket.IO works *in RobotX*

Not generically — specifically.

### 11.1 Three rooms, three jobs

| Room | Who | Why it exists |
|---|---|---|
| `dashboard` | Authenticated browsers only | **The O(N²) fix.** Telemetry used to be `io.emit`, which sent every robot's position to every *other robot* — none of which has any use for it. Dashboard latency at 500 robots: **601 ms → 5 ms** |
| `robot:{robotId}` | Exactly one socket | **All** server→robot delivery. Because it goes through the adapter, a command issued on worker 0 reaches a robot connected to worker 3 |
| `zone:{zoneId}` | Robots inside a zone | Zone-targeted broadcast; membership updated on every position change |

### 11.2 The rule about delivery

**Never deliver through the process-local socket map.** `sockets/robotSockets.js` is for local presence
checks only. Everything that *sends* goes through `commandDispatcher`, which uses `io.to(room)` and
`io.in(room).fetchSockets()`.

A real bug shipped from breaking this rule: calling `dispatchTaskAssign(robotId, payload)` instead of
`dispatchTaskAssign(io, robotId, payload)` bound `robotId` to `io`, and because the presence check
treats any failure as "no socket connected", the mistake **degraded into a silent no-op that still
reported itself as attempted.** `assertIoServer()` now fails loudly.

### 11.3 The two event names that lie

This trips up everyone, so learn it once:

| Event | What it actually means |
|---|---|
| **`task_accepted`** | The task was validated, admitted, deduplicated, routed to a shard and durably queued. **No robot has been chosen.** Carries a queue position and a predicted window |
| `task_assigned` (lowercase) | **A compatibility echo.** Its payload says `status: "PENDING"`, `robotId: null` — because that is the truth. **The dashboard does not subscribe to it** |
| **`TASK_ASSIGNED`** (uppercase) | A real assignment with a drawable route. Emitted after `OFFER_ACCEPT` |

`Frontend/src/lib/socket.js` is the single place this is documented, and it exports
`RETIRED_AFTER_RETENTION_WINDOW` so the eventual removal is one grep away.

### 11.4 Rate limiting

Per socket, per event, in memory (`sockets/rateLimit.js`): a limit, a window, and a minimum interval.
`TELEMETRY` is 50 per 5 s with a ≥100 ms floor, so **10 Hz is the hard server-side ceiling per robot.**
Bounded by fleet size, not by tick rate, and swept opportunistically.

---

## 12. How tasks work

### 12.1 Creating one

```
POST /api/tasks/assign
{
  pickup: "Main Gate", pickupLat: 12.91, pickupLon: 77.51,
  drop:   "Block C",   dropLat:   12.92, dropLon:   77.52,
  payload: { massKg: 7.5, massToleranceKg: 0.5 },   // BOTH or NEITHER
  requestedChassisType: "ROVER"                      // ROVER | DRONE
}
```

Three validation rules that are more interesting than they look:

**1. A mass without a tolerance is refused, not defaulted.** §15.1 uses the *upper bound* of the
tolerance for feasibility and the *expectation* for energy. Defaulting the tolerance to zero would
*"declare perfect precision on behalf of somebody who declared nothing"* — and feasibility would then
admit a plan on a bound nobody stated.

**2. A task with no payload at all is legitimate.** A repositioning or inspection task carries nothing.
What is refused is a *partial* declaration — somebody who meant to state a payload and did not finish.

**3. `requirements` is left NULL when none were stated, not `[]`.** `[]` asserts "this task has no
requirements"; `null` is "nobody stated any". F21 reads them differently and only one of them is true.

### 12.2 The two vocabularies again

`Task.status` carries the six legacy values (`PENDING`, `ASSIGNED`, `IN_PROGRESS`, `COMPLETED`,
`FAILED`, `CANCELLED`) **and** the eight §4.2 states (`RECEIVED`, `REJECTED`, `PLANNABLE`, `WAITING`,
`IN_EXECUTION`, `AT_RISK`, `SUSPENDED`, `VERIFYING`). Legs have their own §4.3 machine.

**`VERIFYING` deserves a sentence.** §12.5: *"Insufficient evidence sends the Task to `VERIFYING` with
an operator queue — not to `COMPLETED`, and not to `FAILED`. **Both of those are lies about the
physical state.**"*

### 12.3 What happens today

**Nothing past step 5.** The cutover gate refuses with `503 ENGINE_NOT_LIVE` before any row is written,
and the dashboard shows *"refused — the assignment engine is not live for this shard. No work is
queued."*

That is the correct behaviour. With the legacy dispatcher out of the build, accepting a task for a
shard whose coordinator is not running would durably record work that no component is responsible for
deciding. **A 503 naming the state is honest; a queue nobody drains is not.**

---

## 13. How assignment works (and why it doesn't run)

### 13.1 The round, in words

The coordinator holds a leadership lease for one shard. Every window it:

1. **Checks it still leads** — and refuses to *plan*, not merely to commit, if it does not. A stale
   leader that planned would spend routing budget and emit decision records for a shard it does not own.
2. **Reads the queue** and computes this round's window and batch cap from the cadence model.
3. **Claims a batch** by conditional write on `(id, state, version)` — so two coordinators racing
   produce one winner and one no-op, without a distributed lock.
4. **Pins its inputs**: the decision time, a seed derived from the round id, the config version.
5. **For each Leg**: expands candidates from the availability index, runs **all 38 predicates**, prices
   the survivors with Φ, prunes with an admissible lower bound.
6. **Solves** a min-cost flow within its budgets, anytime.
7. **Commits** each assignment in a `SERIALIZABLE` transaction with guards G1–G6, writing the `Outbox`
   row **in the same transaction**.
8. **Settles the queue** — and only now, because a row moved to `SOLVED` before its commit landed would
   be a Leg removed from the queue with no commitment to show for it.
9. **Records** a `Round` row, a pinned `InputSnapshot`, and a Tier A decision record per Leg.

### 13.2 Why "Robot A instead of Robot B" has five different answers

This is the interview question. The machinery to answer it exists and is exercised on fixtures:

| Answer | Explanation query |
|---|---|
| B was **never a candidate** — outside the expansion radius for that SLA class, or the evaluation budget ran out first | `why_distant_agent` |
| B was a candidate but the **gate denied it**. The record carries **every** failing predicate, and distinguishes *denied* (a violation) from *indeterminate* (the gate could not see) | `why_not_agent` |
| B was admitted but **cost more**: `Φ(plan_B) > Φ(plan_A)`, with the per-term breakdown in integer milli-CU and the exact margin | `why_this_agent`, `what_did_it_cost` |
| B cost less **but the global assignment is cheaper with B elsewhere**. The solve is a min-cost *flow*, not a greedy per-Leg pick. **This is the single biggest behavioural difference from the deleted allocator** | `what_happened` |
| B won the plan but **lost the commit** — a guard fired, or a volatile predicate flipped between plan and commit. Returned to the next round with the cause recorded | `what_would_change_it` |

### 13.3 Why it doesn't run

`gate:composition` FAILs on one worker. Its printed contract is **34 inputs**; the live measurement is
**26 unresolved**:

| Class | Count | Owner |
|---|---|---|
| `EXTERNAL_ROUTING` | 5 | **B1** — blocked on D1 (operating region), D3 (fleet speed model), D8 (extract vintage) |
| `REGISTER_UNRESOLVED` | 15 | **B8** — the calibration owner. Every `C_direct`/`C_risk`/`C_lifecycle`/`C_delay` rate |
| `NO_PRODUCER` | 6 | Engineering **+ a named data source**. Missing *code*, not a withheld decision |
| *satisfied* | 8 | — |

**B1 releases 5 of the 26.** A routing engine arriving alone starts no coordinator.

### 13.4 Why a stub would be worse than a refusal

The registry states the rule and `leaderWorkers.js` enforces it:

> *A stub would produce a worker that runs, reports success, and computes nothing — the worst of the
> three possible states.*

A coordinator started with a fabricated router would **assign real work on invented travel times.** A
timer worker started with an empty handler map would return `HANDLER_NOT_REGISTERED` for every due
timer and leave each one `PENDING` — *a supervisor that supervises nothing while reporting a healthy
tick.*

So each unstartable worker is **refused by name, with its blocker**, the refusal is returned for a
health endpoint to publish, and `gate:composition` stays red.

---

## 14. How telemetry works

### 14.1 The hot path, annotated

```
TELEMETRY every 2 s per robot
  │
  ├─ backpressure?        ws.bufferedAmount > 1 MB → DROP the frame
  ├─ rate limit           50 / 5 s, ≥100 ms apart
  ├─ Zod parse            coerces numeric strings, admits nulls, passthrough
  ├─ authed?              F26 — no first-telemetry binding, ever
  ├─ capability claim?    → DROP the WHOLE frame + SECURITY_EVENT
  ├─ robotStateCache      ← process memory. WAS a prisma.findUnique PER FRAME
  ├─ §23.5 trust          position kinematics, energy monotonicity
  ├─ status transition    validated + the asymmetric health rule
  │
  ├─ ONE pipelined READ   robot: · snapshotState: · registry: · vr:batteryPersistAt:
  ├─ build fullState      reported ← previous Redis ← cached DB row
  ├─ ONE pipelined WRITE  robot: (always) · registry: (always) · the two conditionals
  │
  ├─ Postgres?            ONLY IF status changed | reconnected | Δbat ≥ 2 % | interval
  ├─ Telemetry row?       ONLY IF >15 s | moved >10 m | Δbat ≥ 2 %
  ├─ zone membership      3-tier cache → room join/leave on change
  ├─ sampled debug log    1 per robot per 10 s; silent at LOG_LEVEL=info
  ├─ io.to("dashboard").emit("robot:update", fullState)
  └─ §12.3 progress feed  measures a stall; NEVER acts on it
```

### 14.2 Why movement does not force a database write

Position liveness is carried by Redis **every tick regardless**. Gating the DB write on
distance-since-last-write would defeat the point entirely — a moving robot covers >10 m on almost every
2 s tick, so "flush when it moves" is "flush every tick" with extra steps.

### 14.3 The heartbeat gate is the one people miss

`VirtualRobot._tick()` emits `HEARTBEAT` **and** `TELEMETRY` on the same tick. Adding the flush gate to
telemetry alone left the heartbeat handler issuing 30 unconditional full-row writes per robot per
minute — so aggregate write volume to `Robot` was **unchanged and had only moved handlers.** Both need
the gate. This is a good example of a fix that measured as no improvement until it was completed.

### 14.4 Why the trust boundary reports INDETERMINATE rather than refusing

The kinematic check needs a ceiling: the agent's `MobilityModel` maximum speed. A legacy `Robot` with
no projected `Agent` carries none. **An absent ceiling is a missing input, not evidence of a spoof** —
so the check reports `INDETERMINATE` and the frame is *not* refused. Refusing on it would take the
whole legacy fleet offline. That is §7.3's three-valued discipline applied one layer out.

---

## 15. How the dashboard works

### 15.1 Seven pages

| Route | What an operator can do |
|---|---|
| `/login` | Email+password or Google Sign-In |
| `/` | Fleet KPIs, battery pie, live event feed, **global Emergency Stop** |
| `/robots` | Unit list with live battery/status/position, model, payload capacity |
| `/robots/:id` | Full configuration; **Edit → Save**; commands; history |
| `/commission` | Identifier, chassis (Rover/Drone), zone via Mapbox search, six specification values, initial battery |
| `/map` | Mapbox campus map: 3D environment, campus layers, robot markers, route overlays, follow camera, theming, legend, search |
| `/tasks` | Task list; Create Task modal; cancel; reroute |
| `/profile` | Password, PIN, passkey, preferences |

### 15.2 State

`AppProvider` holds everything and exposes **two** contexts — `AppStateContext` and
`AppActionsContext` — so a component that only dispatches does not re-render on every telemetry tick.

- **Hydration:** `GET /api/robots/state` + `GET /api/tasks` on mount, guarded by a `refreshingRef` so
  concurrent actions cannot race two `Promise.all` fetches into stale state.
- **Live:** eleven subscribed socket events. **No polling anywhere.**
- **Route overlays:** `taskPathCacheRef`, a `Map` that survives re-render and navigation, populated
  from `TASK_ASSIGNED` and read by the map. This is why opening `/map` *after* an assignment still
  draws the route.

### 15.3 The step-up pattern, and where it deliberately stops

`requestAuth(intent, action, isDestructive)` gates: commissioning, decommissioning, task creation, task
cancellation, the global stop.

**Editing a unit's configuration is deliberately NOT gated**, and the reason is worth quoting:

> *"Correcting a payload capacity is an ordinary administrative edit, and putting a PIN prompt in front
> of every keystroke's worth of it would train operators to type the PIN without reading what it is
> authorising."*

### 15.4 The map's multi-campus pipeline

Two campuses are registered (**RNSIT**, verified; **JSSATE**, `NOT_VERIFIED` on every feature because
nobody has visited it). Adding the second added **an entry and two data files** — no importer, no
classifier, no layer, no camera rule, no branch anywhere downstream. That property is what must stay
true at campus #3 and #100, and **14 `node:test` architecture suites** (`npm run test:arch`) assert it.

**Nothing in the pipeline invents geometry.** Every coordinate was read out of a named file, unchanged,
and every feature carries the dataset and element it came from.

---

## 16. How campuses and regions actually work

> **Read this section carefully. The widely repeated claim that RobotX has "multi-campus isolation" is
> not what the code does.**

### 16.1 `Campus` is a label

Verified by exhaustive grep of `Backend/src`. The `Campus` model does exactly three things:
`GET`/`POST /api/campuses`; an optional `Robot.campusId` FK validated at commission; and
`GET /api/robots?campusId=…` as a filter.

**There is no user↔campus relation, no campus scoping in any middleware, no campus predicate in the
gate, and no campus term in any engine query.** The `Role` enum has one value: `SUPER_ADMIN`.
`policyFor()` reads `req.user.scope`; the `User` table has no scope column; `override.outOfScope()`
therefore treats every operator as unscoped — **and the code says so in a comment rather than leaving
it to be discovered.**

**Consequence:** any authenticated operator can see and act on every robot and every task, regardless
of campus. A "Campus Admin" role does not exist.

### 16.2 The real isolation model is `Region` → `Shard`

| Boundary | Isolates | Enforced by | Status |
|---|---|---|---|
| **Region** | The operating domain (`Agent`, `Mission`, `Zone`, `Shard` all carry it) | Shard resolution + per-region `cutover.engine_enabled` bindings | **IMPLEMENTED** |
| **Shard** | The single-writer domain — exactly one coordinator, fenced lease | Leader election + guard G1 in every commit | **LIVE** |
| **Zone** | Broadcast and pricing scope. **May not straddle a region** (validator V8 at publish) | `zoneManager`, `CellAssignment` | **LIVE** (bounding boxes); H3 cells implemented, not populated |
| **`tenantId`** | Multi-tenancy on `Task` and `Agent`; F4 and F25 read it | The feasibility gate | **IMPLEMENTED, unexercised** |

**Why a zone may not straddle a region:** λ_zone would be estimated from demand served by two
independent shards, and Ω_terminal would no longer bound anything the shard can reach.

### 16.3 If someone asks "how do you isolate campuses?"

The honest answer has three parts:

1. **Today, operators are not isolated at all** — one role, no scope columns, no scoped queries.
2. **The map is multi-campus** as a data pipeline, with per-campus verification status.
3. **The architecture's isolation boundary is `Region`/`Shard`**, it is implemented, and the staged
   cutover is scoped to it — so "run the engine on one region while another stays off" is expressible
   and enforced. What is missing is the *operator-facing* half: scope columns on `User` and a second
   role.

---

## 17. The robot: hardware, firmware, and what this repository knows

> ### ⚠ THE HARDWARE IS NOT IN THIS REPOSITORY.
>
> A repository-wide search for `Raspberry`, `ESP32`, `ultrasonic`, `EC200U`, `L298N` and `NEO-6M`
> returns **zero matches** outside `node_modules`. There is no firmware directory, no bill of
> materials, no wiring diagram, no pin map, no sensor driver, no hardware-in-the-loop harness.
>
> **Any hardware you have discussed elsewhere is, from this repository's point of view, UNKNOWN.**
> Classify every component as *discussed only* until a file here describes it. `docs/runbooks/
> demonstration.md` corroborates: **FD-1 = A** — *"Hardware is in active development; no simulated
> agent is admitted as V1's agent."*

### 17.1 What the repository *does* define: the contract firmware must satisfy

This is the useful, honest answer to "how does hardware integrate", and it is fully derivable from
code. `simulation/VirtualRobot.js` is designated by the execution plan as **"the reference
implementation and the conformance fixture."**

| # | Obligation | Why |
|---|---|---|
| 1 | **Durable dedup state written BEFORE any observable effect** (§11.5) | *"Before motion, before a compartment actuates, before an ACK is sent. Acting first and recording after reopens the exact window the state exists to close."* A rising rate of generation advances across a class indicates non-volatile storage that **is not actually durable** — a defect invisible in every other signal |
| 2 | **Two fence scopes, compared differently** (§10.3.1) | Mission scope: reject at `fence ≤ highest_seen[commitment_id]`, **per commitment id**. Agent scope: reject at `authority_epoch < highest_seen_authority`. Both predicates are imported from `engine/commitment/fencing.js` — **a firmware author ports that module** |
| 3 | **Queries are never fenced** | Always answered |
| 4 | **A bounded autonomous continuation limit** (§18.5) | On losing supervision, continue at most `agent.autonomous_continuation_limit` (default 900 s), then halt **at the safest reachable location** |
| 5 | **Refuse an unexecutable offer by name** | `OFFER_REJECT{NO_EXECUTABLE_PATH}`. A path of fewer than two waypoints describes *no journey at all*, and the phase machine would walk through every phase and emit `TASK_COMPLETE` for a mission during which the robot never moved. **That was a real shipped defect (W-A8)** |
| 6 | **Integrate the same charge curve the server plans with** | `engine/energy/chargeCurve.js`, on the reserve parameters and target SoC **carried in the offer** — so both sides reason from identical inputs by construction rather than by a shared constant an edit could desynchronise |

### 17.2 The wire protocol a robot must speak

**Emit:** `AUTH`, `HEARTBEAT`, `TELEMETRY`, `OBSTACLE_REPORT`, `TASK_COMPLETE`, `ROBOT_FAULT`,
`COMMAND_ACK`, `OFFER_ACCEPT`/`OFFER_REJECT`/`OFFER_DEFER`, `SESSION_REKEY_ACK`, `{COMMAND}_RESULT`.

**Subscribe:** `AUTH_SUCCESS`/`AUTH_OK`, `AUTH_REQUIRED`, `TASK_ASSIGN`, `REROUTE_ALERT`, `COMMAND`,
`STOP`, `RETURN_TO_BASE`, `SESSION_REKEY`, and every §10.3.1 command by name.

### 17.3 GPS — what is and is not defined

**Defined:** the `lat`/`lon` fields on `TELEMETRY`; a server ceiling of 10 Hz per robot; server-side
haversine distance accumulation for robots that don't send `distanceTravelled`, **with jumps over
500 m ignored as artefacts**; bounding-box zone resolution through a 3-tier cache; H3 cell mapping as a
pure function; kinematic plausibility against the `MobilityModel` ceiling.

**Not defined, and must not be invented:** the GPS module or chipset; the serial interface, baud rate,
or NMEA sentences; **any accuracy figure whatsoever** — no CEP, no HDOP handling, no precision claim
appears anywhere in this repository; RTK/differential correction; indoor localisation or SLAM.

The `Observation` model carries a `deadReckoned` flag and §12.5's coverage test **excludes**
dead-reckoned fixes as evidence of travel — but nothing produces them today.

---

## 18. Simulation

### 18.1 What it is

A `VirtualRobot` is a **`socket.io-client` connecting to the same server over the loopback**, speaking
the same protocol as real hardware. It is not a mock and not an in-process shortcut.

**Simulation is opt-in at two independent levels, and physical robots are outside it entirely
(Step 1, 2026-09-07).** The process must set `ENABLE_VIRTUAL_SIMULATOR=true` — unset means off —
*and* the `Robot` row must carry `simulated = true`, a column that defaults to `false`, so every
pre-existing unit is physical. `src/simulation/simulationPolicy.js` is the only module that
evaluates either condition.

At boot, `rehydrateSimulatedRobots()` queries `where: { simulated: true }` and spawns a
`VirtualRobot` for those rows only; `SimulationEngine.addRobot()` re-reads the row and refuses if
the database disagrees with its caller. Commissioning starts a simulator only for a unit
commissioned as `simulated: true`. Active-task re-dispatch after 5 s is fleet-wide and not gated on
the simulator.

Nothing fabricates liveness: boot writes no `isOnline`, and commissioning writes `isOnline: false`.
`Robot.isOnline` is set at AUTH, cleared on disconnect, and swept for staleness — identically for
physical and simulated agents.

`VirtualRobot.commission()` throws `ROBOT_NOT_SIMULATED` before its first write when the target is
not a simulated unit, because what it writes is `session:{robotId}` — the credential a robot
presents at AUTH — and the live-state key. For a physical unit those would replace the hardware's
own credential and fabricate its telemetry.

### 18.2 What it proves, and what it emphatically does not

| Proves | Does **not** prove |
|---|---|
| The Socket.IO contract is implementable end to end | Anything about physical hardware |
| The server handles N concurrent authenticated sockets at a measured rate | GPS accuracy, motor control, sensor fusion, obstacle *detection* |
| Redis/Postgres/event-loop behaviour at fleet-scale message rates | Battery, thermal, or mechanical reality |
| The agent-side obligations are *satisfiable* | That any real firmware satisfies them |
| Reroute, fault, completion and command paths reach their handlers | That a real robot avoids a real obstacle |

**ADR-31 governs this.** §24.4's `simulator_fidelity` gate is `NOT_EVALUATED` with **7 models
NOT_MEASURED**, and `sim.max_optimistic_bias` is Safety-class and PROVISIONAL, awaiting *"the first
one-sided simulator fidelity study against production."*

The multi-robot simulation track (SIM-1…SIM-5) is classified **V1-ENG** and *"discharges no stop
condition and no count, gate, exit code or verdict may cite it."*

### 18.3 The simulated unit's constants — not hardware specifications

2 s tick · EMA speed (α 0.20, base 5.56 m/s ≈ 20 km/h, floor 5.0, ceiling 8.33 m/s ≈ 30 km/h) · 40 m
per-tick movement cap · battery drain 0.0444 %/tick ACTIVE and 0.0089 %/tick IDLE · warn 20 %, critical
10 %, floor 5 % · 1 000 Wh modelled pack with a constant-current-then-taper curve (10→80 % in ≈21 min,
80→100 % in ≈24 min) · obstacle probability 0.002/tick · 10 s pickup wait, 8 s drop wait.

---

## 19. Authentication and authorization

### 19.1 The distinction, with RobotX examples

**Authentication = "who are you."**
Operator: a JWT in an HttpOnly cookie, verified by `verifyUserToken()` — **the same function** for REST
and for the socket handshake, so both surfaces cannot drift. Robot: a pairing code, then a session
token, or a certificate binding `(agent_id, certificate, session_id)`.

**Authorization = "may you do this."**
- `authUser` — are you logged in at all? (every route group)
- `requireElevatedRole()` — a privileged read or a whole privileged group
- `requireActionClass(...)` — §23.4's four high-privilege actions: **quarantine override**,
  **safety-class config change**, **bulk cancellation**, **manual assignment against a Policy
  constraint**. Each needs an elevated role **plus a recorded reason**, and where configured a **second
  approver**.

### 19.2 Three things worth internalising

**1. Every authorisation decision is audited, including refusals.**
> *"A stream holding only successes answers 'nobody tried' to a question whose true answer is 'somebody
> tried eleven times.'"*

The audit write is best-effort and never turns a refusal into a 500 — because a caller that got a 500
would retry, and a retry landing after the audit recovered would look like a first attempt.

**2. Agent self-reports are asymmetric.** An agent may always declare itself **unfit**; it may never
declare itself **fit**. Returning to service is an operator action under an override.
> *"Self-reported degradation is trusted because a false positive costs one agent-shift; self-reported
> fitness is not trusted because a false positive risks an incident."*

**3. A capability claim from an agent is rejected entirely — the whole frame is dropped.** Position can
be sanity-checked against physics; a capability claim has nothing to check it against, because **the
claim is the fact.** Dropping (rather than stripping) makes the attempt cost the attacker their
telemetry.

### 19.3 A type-confusion bug worth remembering

`session:{id}` holds two different kinds of thing: a bearer token (a **secret**) and a certificate
binding (which names a **public** fingerprint). The legacy branch once compared the *binding* as though
it were a shared secret — so anyone who learned it could authenticate as that agent without a
certificate. `isCertificateBinding()` now refuses a binding as a token.

**The general lesson:** reusing one namespace for two kinds of value is a type system you are not
enforcing.

---

# PART III — OPERATING IT

## 20. Configuration and environment

### 20.1 Two different things called "configuration"

| | `.env` | The parameter register |
|---|---|---|
| **Holds** | Deployment facts: connection strings, secrets, ports, the master switch | **Behavioural** constants: thresholds, budgets, deadlines, exchange rates |
| **Count** | ~37 variables | **250 parameters** |
| **Changed by** | Editing a file and restarting | Publishing a version through an approved, validated, audited API |
| **Versioned** | No | Yes, immutably (trigger-enforced) |
| **Enforced by** | Nothing | `gate:params` — a bare numeric literal in a decision path **fails the build** |

### 20.2 Minimum `.env` to run

```env
DATABASE_URL="postgresql://USER:PASS@localhost:5432/robotx?schema=public"
JWT_SECRET="a-long-random-string"
FRONTEND_URL="http://localhost:5173"
MAPBOX_ACCESS_TOKEN="pk...."

REDIS_URL="redis://localhost:6379"     # or REDIS_ENABLED=false to run without it
ENGINE_ENABLED=false                   # leave false — see §5
```

Frontend `.env.local` (Vite reads these **at startup** — restart after changing):

```env
VITE_API_URL=http://localhost:3000
VITE_SOCKET_URL=http://localhost:3000
VITE_SOCKET_GLOBAL_KEY=__robotx_socket__
VITE_MAPBOX_TOKEN=pk....
```

### 20.3 The variables whose *absence* changes behaviour

These are the ones that bite, because nothing crashes:

| Variable | Absent means |
|---|---|
| `JWT_SECRET` | Every authenticated route returns **500** |
| `SHARD_CONSENSUS_REPLICATION` | **The process refuses to start** with `ENGINE_ENABLED=true`. Deliberate: better than electing a leader over a store that cannot fence one |
| `COMMAND_SIGNING_KEY` | Migration and withdrawal paths report `NO_COMMAND_CREDENTIALS` rather than emitting **unsigned** commands |
| `SUPERVISE_STALL_TIME_SECONDS` | §12.3 stall detection **does not run at all** — §22.1 admits no invented threshold |
| The six `VERIFY_*` thresholds | **All-or-nothing.** A partial set means the graded completion check does not run — *"a partially resolved threshold set would grade a claim against some real thresholds and some invented ones, and the resulting verdict would be neither"* |
| `MAPBOX_ACCESS_TOKEN` | Rerouting falls back to a straight line; the map shows `MapUnavailableFallback` |
| `REDIS_URL` | In-memory fallback; **cross-worker broadcast silently stops working** if you are running more than one process |

The full catalogue is in [`ARCHITECTURE.md` §26.3](ARCHITECTURE.md#263-environment-variables--the-complete-catalogue).

---

## 21. Development workflow

```bash
# Backend
cd Backend
npm install
# create .env (§20.2)
npx prisma migrate deploy && npx prisma generate
node prisma/seed.js
npm run dev                       # http://localhost:3000

# Frontend
cd Frontend
npm install
# create .env.local
npm run dev                       # http://localhost:5173
```

An admin account is needed to sign in: set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` before starting
the backend, or create the `User` row directly.

### 21.1 The loop for a change

```
1. Read the relevant §n.n in NEXT_GENERATION_ASSIGNMENT_ENGINE.md.
   It wins over everything, including this handbook.
2. Check docs/adr/ — is there a frozen decision here, and what did it reject?
3. Check TIERS.md — what tier is the module you are touching?
4. Write the change. Explain WHY in a comment, not what.
5. npm run gates      ← FIRST. Structural defects are not made acceptable by passing tests
6. npm test
7. If you added a threshold: register it. gate:params will fail you if you don't
8. If you added a worker: add a registry row with a cadence source, or a
   mandatory cadenceNote. assertRegistry() throws at load otherwise
```

### 21.2 House rules that are actually enforced

| Rule | Enforced by |
|---|---|
| No behavioural constant outside the register | `gate:params` |
| No Tier 0/1 module may import a Tier 2 module | `gate:tiers` |
| No wall-clock read in the decision path (T6) | `gate:tenets` |
| No identifying field in any cost term (§23.7) | `gate:privacy` |
| A decision record must replay byte-for-byte under erasure | `gate:erasure` |
| The four retired modules stay retired | `gate:legacy` |
| Every registered worker reaches production scheduling, or names its blocker | `gate:composition` |
| A `DEFERRED` worker must name `blockedBy` | `assertRegistry()`, at module load |
| `TIERS.md` and `tierAssertions.js` must agree | a test that reads both from disk |

> **Four tests read `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` and `docs/adr/**` from disk; three read
> `TIERS.md`. Moving, renaming or reformatting them breaks the build.** A gate failing after a
> documentation change is not a false positive.

---

## 22. Testing — five lanes and eight gates

### 22.1 The lanes, and why they are separate

```bash
npm test               # all five — 175 suites / 7 581 tests / ~7 min
npm run test:legacy    # unit + integration: auth, CORS, kv, commands, telemetry, simulator
npm run test:gates     # gate self-tests: plant a violation, assert the gate catches it
npm run test:engine    # src/engine/**
npm run test:chaos     # §24.5 fault injection, at capacity 1 AND 2 (timeout 120 s)
npm run test:scale     # §24.6 scale, locality, soak, overload (timeout 300 s)
```

**Why `gates` is its own lane:** *"A gate that cannot fail is not a gate, so these tests are what make
the other two lanes trustworthy."*

**Why `chaos` runs at capacity 1 *and* 2:** §24.5 requires it, because *"a chaos suite that only ever
exercises one commitment per agent cannot detect"* a fencing error.

**Why `scale` is separate:** both slow lanes were split out because *"a slow test inside a fast lane is
a test somebody eventually skips."*

> **`tests/scale/round.scale.test.js` asserts a throughput bound and fails on a loaded machine.** Do
> not run anything else alongside `npm test`.

### 22.2 The gates

```bash
npm run gates          # all eight. EXITS 1 today, and that is correct
```

| Gate | Checks | Today |
|---|---|---|
| `gate:tiers` | §1.8 rule 2, over the static import graph | PASS — 295 modules, 459 edges |
| `gate:params` | §22 — no behavioural constant outside the register | PASS — 193 engine modules / 250 parameters |
| `gate:tenets` | T1 type separation, T6 no clock in the decision path | PASS — 292 modules |
| `gate:privacy` | §23.7 identity isolation | PASS — 16 modules |
| `gate:erasure` | Byte-for-byte replay over an **erased** corpus | PASS — 3 decisions |
| `gate:legacy` | The four deleted modules stay deleted | PASS — absent across 353 files |
| `gate:columngen` | §21.6 — a column-generation change must carry an evaluator run | PASS (NOT_REQUIRED) |
| **`gate:composition`** | Every registered worker reaches production scheduling | **FAIL — coordinator, B1** |

Plus three that are **not** in `npm run gates` because they block the *cutover*, not the *build*:

```bash
npm run gate:calibration    # FAIL at 39 Safety-class findings (B8)
npm run release:verdict     # BLOCKED — 24 gates, 0 green
npm run routing:readiness   # OVERALL: BLOCKED — and it EXITS 0 by design
npm run sim:fidelity        # 7 models NOT_MEASURED, exits 1
```

> **`routing:readiness` can never print PASS and always exits 0.** Read the `OVERALL:` line, not the
> exit code.

### 22.3 Four things that are often confused

| | Answers |
|---|---|
| **Unit test** | Does this module behave as specified, in isolation, against fixtures? |
| **Build gate** | Is this a structural violation no amount of passing tests makes acceptable? |
| **Release gate** | Is there *evidence* that this property holds on a real system? |
| **Formal model** | Is the design itself sound, independently of the code? (`formal/`, TLC) |

**A green suite has repeatedly coexisted in this project with a composition that could not be built.**
That is why the gates run first and independently.

---

## 23. Debugging and troubleshooting

### 23.1 The symptom table

| Symptom | Cause | Fix |
|---|---|---|
| **`POST /api/tasks/assign` → 503 `ENGINE_NOT_LIVE`** | **Expected.** The cutover binding is unpublished | Nothing. Do **not** publish it to get past this — that is S-5, the owner's act, and it would not help because S-3 stops the coordinator one layer further in |
| First commission → bare `HTTP 500` | `npx prisma generate` was not re-run after the newest migration | `npx prisma generate` |
| Telemetry not updating | Backend not on 3000 · `REDIS_URL` unreachable (hosted Redis usually needs `rediss://`) · simulator not started | Check `/health`: `redis`, `db`, `eventLoopDelay`, `prismaPool` |
| Socket connects/disconnects repeatedly in dev | You constructed your own socket instead of importing the global singleton | Import from `Frontend/src/lib/socket.js` |
| No map / Mapbox errors | `VITE_MAPBOX_TOKEN` missing, or Vite not restarted | Set it, restart |
| Prisma errors on start | `DATABASE_URL`, migrations, or `generate` | See §8.4 |
| A gate fails after a doc change | **Not a false positive** — tests read those files from disk | Restore the path/content. Do **not** weaken the test |
| `npm run gates` exits 1 | **Expected.** `gate:composition` FAILs on B1 | Nothing |
| Scale test fails | The machine was loaded | Re-run alone |
| Dashboard socket rejected | No `token` cookie on the handshake | Log in; the socket needs `withCredentials: true` |
| Robot AUTH silently disconnects | Unknown `robotId`, malformed payload, wrong pairing code, or **pairing lockout** (5 failures → 1 h) | `POST /api/robots/:id/pairing/unlock` |
| A worker "runs" but does nothing | Its composer refused. **Look for the `error`-level line at leadership promotion** | Read the refusal; it names its blocker and owner |
| An engine security check never fires | Its threshold did not resolve. **The code logs this at `error` level, once per agent** | Publish the parameter |

### 23.2 Where to look first

```bash
curl localhost:3000/health | jq
```
Returns: `server`, `redis`, `db`, `degraded` (open modes + suspended invariants + invariant counts),
`shard` (led? lease valid? rounds resumable?), `configVersion`, `configRegisterDigest`, `uptime`,
`eventLoopDelay`, `prismaPool` (open/busy/idle/**queriesWaitAvgMs**), `sli`, plus DTARO metrics.

**`prismaPool.queriesWaitAvgMs` is the single most diagnostic number in the system.** If it is above a
millisecond, something is doing per-request database work it should not be.

| Then | Read |
|---|---|
| Engine not deciding | The server log at leadership promotion — the composition refusal, in full |
| Invariant concerns | `GET /api/health/invariants` |
| Degraded shard | `GET /api/health/modes` |
| Why a Leg is stuck | `GET /api/legs/:legId/supervision` — current state, deadline, owning timer |
| Why a decision went that way | `GET /api/explain/:decisionId` |
| Which candidates were considered | `GET /api/diagnostics/candidates/:legId` |
| Why everything is denied | `GET /api/diagnostics/rejections` — the binding-constraint distribution |
| Shard topology | `GET /api/shards` |

### 23.3 The debugging lesson this codebase teaches

**Look for code paths that have never succeeded.** Several of the worst defects in this project's
history were not crashes; they were expressions that were always `undefined`, guards that were never
called, workers that were never started, and a socket path that failed *closed* on every shard for
ever. None of them produced an error. All of them produced a system that looked like it was working.

Practical heuristics:
- A `try { … } catch { /* ignore */ }` around something you have never seen succeed.
- An optional-chain reaching for a property nobody assigns (`io?.app?.locals`).
- A guard function with no production caller — grep for its name.
- A metric that is always zero.
- A worker whose "healthy tick" is indistinguishable from doing nothing.

---

## 24. Metrics and observability

| Surface | What it gives you |
|---|---|
| `GET /health` | The liveness picture. Unauthenticated, polled by infrastructure |
| `GET /api/health/invariants` | §26's register: ENFORCED / VIOLATED / SUSPENDED per invariant |
| `GET /api/health/modes` | §18.5's degraded modes, their suspended invariants and time boxes |
| `GET /api/health/cutover` | Per-shard cutover posture |
| `GET /api/shards` | Topology, memberships, **both** §3.5 sizing bounds with the binding one named |
| `GET /api/legs/:id/supervision` | State, deadline, owning timer |
| `GET /api/explain/:decisionId` | Eight §21.3 queries, each naming its source |
| `GET /api/diagnostics/rejections` | The exact, unsampled binding-constraint distribution |
| `GET /api/diagnostics/energy/:agentId` | Energy feasibility inputs and margins |
| `GET /api/diagnostics/candidates/:legId` | The candidate set and near-miss margins |
| `observability/eventLoopMonitor` | `perf_hooks` histogram, surfaced on `/health` |
| Pino structured logs | `logger.http`, `httpEnd`, `socket`, `socketIn`, `socketOut`, `startup` |

**Two design rules worth copying:**

1. **A check that cannot resolve its inputs reports *unverified*, never *clean*.** *"An omission shows
   up as an incomplete register instead of a false page."*
2. **A health probe reads the durable row, not the cache mirror.** `/health` deliberately queries
   `ShardLeadership` rather than `engine:shard:leader:{shard}`, because a probe answering from a cache
   would report a dead coordinator as leading for the mirror's whole TTL.

---

## 25. Deployment

### 25.1 What the repository actually specifies

| | |
|---|---|
| **Process model** | A single `node server.js`. `PORT` (3000), `HOST` (0.0.0.0) |
| **Clustering** | **EXPERIMENTAL.** The `nginx.conf` files under `benchmark/results/cluster-*/` are experiment artefacts, not deployment configuration |
| **Containers** | **NOT REPRESENTED.** No Dockerfile, no compose file |
| **Kubernetes** | **NOT REPRESENTED, and not planned.** Proposed by a superseded document; not adopted |
| **Reverse proxy** | Benchmark-only. `rateLimitHttp` trusts `X-Forwarded-For` and the robot handler trusts a proxy-forwarded `x-client-cert`, **both on the explicit assumption that the proxy is inside the trust boundary and strips a client-supplied copy** |
| **TLS** | The process does **not** terminate TLS. `tlsPosture()` declares what the deployment believes, at boot |
| **VPN / LAN** | **NOT REPRESENTED** |
| **CI** | `.github/workflows/` exists. **CI does not run `gate:composition`** — so CI is green while that gate is RED |
| **Verification DB** | A **disposable PG 18.3 cluster on port 55432** built from installed binaries. Never 5432, never hosted |

### 25.2 Cutover and rollback

**Read `docs/runbooks/rollback.md` before `cutover.md`.**

After Phase 15 the legacy dispatcher is **not a fallback** — it was removed from the build.
`ENGINE_ENABLED=false` no longer means "the old path serves this fleet"; it means **this process runs
no round, drains no outbox, and starts no supervisor.**

The automatic rollback is real, and it took several attempts to make real. `cutover.worker` assesses
each live shard against its pre-declared SLI guardrails and, on regression, **publishes a reverted
binding**. Before that fix it logged and returned — so a breaching shard stayed live *and*, because
`declarationFor` returns null once the latest cutover event is a rollback, was **never assessed
again.** `guardrails.assertOneDirectional` throws on anything but a disable: the automatic path may
only ever turn the engine **off**.

---

# PART IV — THE ENGINEERING STORY

> Everything in this part was produced by the harness in `Backend/benchmark/`, is stored as JSON in
> `Backend/benchmark/results/`, and was re-read from those files while writing this document.
>
> **Scope note, and it matters.** These runs measure the **host platform**. The assignment path in them
> is the *deleted* legacy DTARO allocator. The telemetry, Redis, Socket.IO, Prisma and event-loop
> findings carry forward unchanged, because those paths were not replaced. **The assignment-latency
> figures describe an engine that no longer exists**, and must be presented that way.

## 26. Scalability: what was measured, and what it proved

### 26.1 The method

```
Benchmark → Profile → Form a hypothesis → Optimise → Re-benchmark → Re-profile → Conclude
```

Not "optimise what looks slow." **Every change was made because a profile identified it, and was kept
because a re-benchmark showed it moved.** Two of the changes below measured as *no improvement* until a
second, related fix landed — which is exactly the information you lose if you optimise by intuition.

The harness ramps a tier of virtual robots, warms up 15 s, measures 75 s, and records: connection
ratio, five latency distributions, CPU/memory, Redis ops/s, Postgres writes/s and transactions/s,
Prisma pool gauges, and event-loop delay. Each robot ticks telemetry + heartbeat every 2 s.
`ENABLE_VIRTUAL_SIMULATOR=false` and `DISABLE_VIRTUAL_SIMULATOR=true` so an **external** load generator is the only source of robot traffic
— otherwise the in-process clients would compete with the server for CPU and invalidate the
measurement.

### 26.2 The headline: 500 robots, three stages

All figures read from `benchmark/results/*/tier-500.json`.

| Metric | baseline | optimized | **optimized-redis-logging** |
|---|---|---|---|
| Authenticated | 500/500 | 500/500 | 500/500 |
| **Assign — REST response** p50 | **18 433 ms** (avg 21 262) | 6 984 ms (avg 5 744) | **19 ms** (avg 21) |
| **Assign — end to end** p50 | *none completed* | **1 241 ms** | **189 ms** |
| **Telemetry → dashboard** p50 | 936 ms (avg 3 523) | **601 ms** | **5 ms** |
| Assignments succeeded | **0 / 24** (19 timed out) | 4 / 24 (14 timed out) | **24 / 24** |
| CPU avg | 106.96 % | 106.97 % | **33.93 %** |
| **Prisma pool wait** avg | *not instrumented* | **158.97 ms** (max 325) | **0.01 ms** (max 0.02) |
| Pool connections busy avg | — | 9.91 / 20 | **0.5 / 20** |
| Event-loop p95 | — | 130 ms | **31.8 ms** |
| Memory avg | 533 MB | 300 MB | 325 MB |

> ### Read this table carefully, because the popular summary of it is imprecise.
>
> **"21 seconds → 1.2 seconds" compares two different metrics.** 21 262 ms is the baseline's *REST
> response average*; 1 241 ms is the optimized stage's *end-to-end p50*. Within one metric:
>
> - **REST response p50: 18 433 ms → 6 984 ms → 19 ms** (≈ **970×**)
> - **End-to-end p50: never completed → 1 241 ms → 189 ms** (≈ **6.6×** across the last two stages)
> - **Dashboard latency p50: 936 ms → 601 ms → 5 ms** (≈ **187×**)
> - **CPU: 107 % → 107 % → 34 %**
> - **Pool wait: 159 ms → 0.01 ms** (≈ **16 000×**)
>
> Quote whichever you like — but say which metric it is. In a technical interview, "REST response p50
> fell from 18.4 s to 19 ms, and end-to-end assignment from never-completing to 189 ms" is both more
> impressive and more defensible than a number that dissolves under one question.

### 26.3 What each stage actually changed

**Stage 1 → 2 — the per-frame database read.**
The profile and the pool gauges agreed: `prisma_client_queries_wait_histogram_ms` averaged **159 ms**
with 9.91 of 20 connections busy. The cause was a `prisma.robot.findUnique` **on every telemetry
frame** — 500 robots × 0.5 Hz = 250 reads/s of a row the process had just written.

Three fixes: `robotStateCache` (seeded at AUTH, invalidated by every writer of `status`/`isOnline`), the
Postgres flush gate on telemetry, and **the same gate on the heartbeat handler** — which had been
issuing 30 unconditional full-row writes per robot per minute of its own, so the aggregate write volume
to `Robot` had been *unchanged and had only moved handlers*.

**Stage 2 → 3 — Redis round trips and logging.**
The V8 profile of stage 2 put `ioredis/utils/Commander.js` at 3.5 % and `ioredis sendCommand` at 2.3 %
of non-library ticks — **the two highest JS entries in the whole profile** — with
`Socket._writeGeneric` at 2.0 %. That is **per-command socket-write cost**, not Redis server slowness.

Two fixes: `kv.pipeline()` collapsing ~6 round trips per telemetry event into 2, and demoting the
unconditional per-frame `INFO` log to a per-robot 10 s `debug` sample.

**The result was not marginal.** CPU 107 % → 34 %, pool wait 159 ms → 0.01 ms, and *every* assignment
completed at this tier for the first time.

### 26.4 Where the plateau is

`benchmark/results/highfleet/` — post-optimisation, single process:

| Tier | Authenticated | Assign e2e p50 | Assignments | Telem→dash p50 | CPU avg | Event loop p95 | Memory |
|---|---|---|---|---|---|---|---|
| **1 000** | **1 000 / 1 000 (100 %)** | **256 ms** | **24 / 24** | 9 ms | 76 % | 31.9 ms | 435 MB |
| **2 000** | 1 928 / 2 000 (96.4 %) | 349 ms | **2 / 24** (19 timed out) | 126 ms | 43 % | **86.8 ms** | 962 MB |
| **5 000** | 2 895 / 5 000 (57.9 %) | *none* | **0 / 24** (21 timed out) | *none recorded* | 50 % | *not sampled* | 2 187 MB |

**The conclusion, stated with its scope:** on this single machine, under this workload, the practical
operating range is **≈1 000 robots comfortably and ≈2 000 at the edge**. At 2 000 authentication still
largely succeeds and telemetry still flows, but **task assignment collapses first** — 2 of 24. At 5 000
the ramp itself fails: only 58 % of robots ever authenticate.

> **This is a plateau of one process on one machine under one workload profile.** It is not a statement
> about the architecture's ceiling and must never be quoted as one.

### 26.5 What was optimised, and what each was worth

| # | Change | Evidence that motivated it | Measured effect |
|---|---|---|---|
| 1 | `robotStateCache` — process-memory `Robot` row cache | Pool wait 159 ms; a `findUnique` per frame | Pool wait → 0.01 ms |
| 2 | Postgres flush gate on telemetry | 30 row writes/robot/min for data Redis already carried | ~4/min |
| 3 | **The same gate on HEARTBEAT** | Both fire on one tick, so #2 had *moved* the writes | Aggregate `Robot` write volume actually fell |
| 4 | `kv.pipeline()` / `kv.mget()` | ioredis command dispatch was the top two JS entries; ~17 % of samples in per-command socket writes | ~6 round trips/event → 2; CPU 107 % → 34 % |
| 5 | Room-scoped dashboard broadcast | `io.emit` sent every robot's position to every other robot — O(N²) | Dashboard p50 601 ms → 5 ms |
| 6 | Removed two duplicate telemetry events | `robot:update` + `ROBOT_UPDATE` + `robot_update` fired the same client handler 3× per tick | 2 fewer emissions + 1 fewer DB query per tick |
| 7 | Sampled telemetry logging | CPU profile attributed measurable cost to unconditional `INFO` | `debug`, 1 per robot per 10 s |
| 8 | Prisma pool → 100 | The pool sweep | Pool wait 14 ms → 0.13 ms |
| 9 | Socket.IO Redis adapter | **Correctness, not performance** — a room emit from worker A must reach a client on worker B | Cross-worker broadcast works |
| 10 | 3-tier zone cache | Zone lookup was per tick | 60 s process → 300 s Redis → Postgres |
| 11 | Backpressure frame dropping | A slow client must not become a server memory leak | Frames dropped over 1 MB buffered |

---

## 27. Profiling: what was actually found

> **Do not say "Redis was slow." That is not what the profile shows, and saying it misstates a
> genuinely interesting result.**

Two V8 statistical profiles at the 500-robot tier, before and after the Redis/logging work:

| | **Before** (8 135 ticks) | **After** (9 618 ticks) |
|---|---|---|
| `ntdll.dll` — OS: sockets, I/O, scheduling | **52.1 %** | **70.2 %** |
| `node.exe` — V8 + libuv internals | 26.6 % | 17.9 % |
| Top JS entry | `ioredis/utils/Commander.js` — **3.5 %** | `LoadIC` (a V8 inline cache) — 9.8 % of non-library |
| `ioredis sendCommand` | 2.3 % | **1.5 %** |
| `Socket._writeGeneric` | 2.0 % | 0.7 % |
| `telemetry.handler.handleTelemetry` | 1.4 % | 0.8 % |

### 27.1 The findings, stated precisely

| Finding | Evidence |
|---|---|
| **Redis *command dispatch and socket write* was the dominant application-level CPU cost** — not Redis server latency, not network wait. ioredis's per-command JS path held the two highest JS entries | `profile-500/profile-summary.txt` |
| **The fix was to issue fewer commands, not to make Redis faster** | ioredis dropped out of the top entries after pipelining |
| **DTARO's cost evaluation was never a dominant bottleneck.** No allocation-path function appears meaningfully in either profile | both |
| **Socket.IO itself was not a bottleneck** — `engine.io`/`socket.io` frames sit at 0.5–0.6 % | both |
| **JSON serialization was not a bottleneck** — it does not appear in the top entries at all | both |
| **GC was not a bottleneck** — memory was stable (300–435 MB at 500–1 000 robots) and GC does not surface | both + `summary.json` |
| **Zod validation is visible but small** — several entries at 0.6–1.0 % each | both |
| **PostgreSQL stopped being the limiting factor after optimisation #1** — 0.01 ms pool wait, 0.5/20 busy at 500 robots | `optimized-redis-logging/tier-500.json` |
| **Application logic became cheap.** In the "after" profile the top JS entries are V8 *inline caches* (`LoadIC`, `KeyedLoadIC_Megamorphic`) — property-access dispatch, which is what you see when **no single function dominates** | `optimized-redis-logging-prof2` |
| **The remaining pressure is OS-level socket I/O and single-process event-loop capacity.** `ntdll.dll` *rose* from 52 % to 70 % — because the application's share shrank while the kernel's socket work did not | both |

### 27.2 The load-bearing conclusion

After the optimisations, the process spends **~70 % of its samples inside the operating system doing
socket work.** You cannot optimise past that in JavaScript. The next real gain is **architectural**:
fewer and larger messages, or more machines.

That sentence is the honest end of the single-machine performance story, and it is a better interview
answer than any number in §26.

---

## 28. The clustering experiment, and why it failed

`benchmark/results/cluster-2w/` and `cluster-4w/` — Node worker processes behind Nginx, **on the same
physical machine**, with the Socket.IO Redis adapter attached.

| Tier | Config | Authenticated | Assign e2e p50 | Assignments | Telem→dash p50 | Pool wait avg |
|---|---|---|---|---|---|---|
| 2 000 | **1 worker** | 96.4 % | 349 ms | **2 / 24** | 126 ms | 2.63 ms |
| 2 000 | **2 workers** | 98.3 % | 975 ms | 1 / 24 | 841 ms | **3 555.67 ms** |
| 2 000 | **4 workers** | 96.0 % | 5 428 ms | 4 / 24 | 1 503 ms | *not sampled* |
| 5 000 | 1 worker | 57.9 % | — | 0 / 24 | — | — |
| 5 000 | 2 workers | 33.4 % | 4 266 ms | 6 / 24 | 643 ms | — |
| 5 000 | 4 workers | **20.5 %** | *none* | **0 / 24** | 5 731 ms | — |

### 28.1 Why it got worse, in order of size

1. **The workers competed for the same CPU.** Four Node processes on one machine do not have four
   machines' worth of cores. They have the same cores, plus context switching, plus four copies of
   every in-process cache.
2. **Postgres connection-pool amplification.** Each worker opens its own Prisma pool. At 2 workers,
   **pool wait went from 2.63 ms to 3 555.67 ms — a 1 350× regression** — with all 20 connections busy
   continuously. **The database became the bottleneck the single-process optimisation had removed.**
3. **Nginx `worker_connections`.** The 5 000-robot 4-worker run authenticated only 20.5 %; the ramp
   itself was the failure.
4. **The in-process caches lost their hit rate.** `robotStateCache`, the zone cache and the flush gate
   are per-process and bounded by fleet size; splitting the fleet across four processes did not shrink
   them proportionally.

### 28.2 What the experiment *did* establish, and it is genuinely valuable

- **The `robot:{id}` room pattern is correct.** Every server→robot delivery already routes through the
  Socket.IO adapter rather than a process-local socket map, so a command issued on worker 0 reaches a
  robot connected to worker 3. The 2- and 4-worker runs *did* deliver across workers.
- **The Redis adapter works** — dashboard broadcast continued across workers (298–308 msg/s at the
  2 000 tier versus 200 on one worker).
- **The blocker to horizontal scale is not the application's message routing.** It is CPU contention
  and connection-pool amplification — **neither of which is present when workers are on separate
  machines.**

### 28.3 The claim you may and may not make

> **✅ MAY say:** "Same-machine clustering did not demonstrate horizontal scalability and regressed
> every comparable tier, because the workers competed for one machine's CPU and each opened its own
> database pool — pool wait went from 2.63 ms to 3 555 ms at two workers. What it did establish is that
> the cross-process message routing is already correct: the Redis adapter and the per-robot room
> pattern delivered across workers throughout."
>
> **❌ MAY NOT say:** "The system scales horizontally." **Multi-machine horizontal scaling has never
> been tested.** Multiple workers on one box is not that test; it is an experiment about CPU
> oversubscription that happens to use the same code path. A genuine test needs independent machines, a
> shared Postgres sized for the aggregate pool, and a load balancer that is not itself the ceiling.
> That test has not been run — the multi-machine phase is recorded as **paused on 2026-07-27**.

---

## 29. The negative results worth keeping

Two experiments were run, failed, and were **kept in the repository rather than deleted.** A negative
result that is recorded is worth more than one that is repeated.

### 29.1 The Prisma pool sweep — a knee, not a slope

500 robots, sweeping `connection_limit`:

| Pool | Assign p50 | Succeeded | CPU | Pool wait avg | Event loop p95 |
|---|---|---|---|---|---|
| 20 | 402 ms | 11 / 24 | 94 % | 14.20 ms | 79.7 ms |
| 40 | 288 ms | 3 / 24 | 77 % | 13.95 ms | 95.0 ms |
| 60 | 4 887 ms | 11 / 24 | 92 % | 17.23 ms | 162.4 ms |
| 80 | 1 269 ms | 8 / 24 | 81 % | 15.84 ms | 97.0 ms |
| **100** | 1 572 ms | **18 / 24** | 93 % | **0.13 ms** | 102.5 ms |

**Finding:** pool wait collapses at 100, but throughput does not improve proportionally, because the
constraint has moved to the event loop. **Enlarging a pool does not create database capacity; it
relocates the queue.**

### 29.2 PgBouncer — a clean negative

| Tier | Stage | Assign p50 | Succeeded | CPU | Pool wait avg | Event loop p95 |
|---|---|---|---|---|---|---|
| 500 | pool-100 (no bouncer) | 1 572 ms | **18 / 24** | 93 % | **0.13 ms** | 103 ms |
| 500 | pgbouncer-100 | 1 109 ms | 4 / 24 | 120 % | 58.73 ms | 122 ms |
| 500 | pgbouncer-200 | 2 296 ms | 4 / 24 | 107 % | 6.19 ms | 177 ms |
| 1 000 | pool-100 | 3 701 ms | 2 / 24 | 97 % | 39.05 ms | 236 ms |
| 1 000 | pgbouncer-100 | *none* | **0 / 24** | 90 % | **582.34 ms** | 630 ms |
| 1 000 | pgbouncer-200 | *none* | **0 / 24** | 102 % | 481.25 ms | 848 ms |

**PgBouncer made every measured dimension worse.** The reading: after the per-frame read was removed,
this workload was **not connection-bound** — it was **event-loop-bound** — and inserting a
transaction-pooling proxy added a hop and a second queue in front of a queue that was already empty.

**PgBouncer is not in the running system.** `benchmark/pgbouncer/up.sh` is an experiment harness.

### 29.3 Why these belong in a presentation

They demonstrate the discipline the whole project runs on: **a hypothesis, an experiment, a
measurement, and a conclusion that was allowed to be "no."** Two of the most common scaling reflexes —
*add workers* and *add a connection pooler* — were tried here and both made things worse, for reasons
the data explains.

---

## 30. Safety, release gates, and why nothing is green

### 30.1 The layered safety argument

| Layer | Mechanism |
|---|---|
| **Design** | Obligation tiers (§1.8). Tier 0 = "if this is wrong, a physical incident." A release may not ship on an incomplete Tier 0 |
| **Structural** | `gate:tiers` over the static import graph. A Tier 2 mechanism statically linked into a Tier 1 path is a kill switch that **cannot actually be thrown** |
| **Logical** | The 38-predicate gate, evaluated **before** cost and **never traded against it**. Three-valued, with DENY on indeterminate for class I and R |
| **Transactional** | `SERIALIZABLE` + `FOR UPDATE` + guards G1–G6 + a per-commitment fence + an outbox row in the same transaction |
| **Schema** | A `kind='HARD'` CHECK and a partial unique index — invariants I18 and I1 hold **even when application logic is defective** |
| **Supervisory** | Every non-terminal state has a deadline registered in the transaction that enters it (I4); durable timers keyed on the entity's own version; a trigger-independent reconciler |
| **Degraded** | A named, time-boxed mode register with **explicitly enumerated** suspended invariants. Custodial Operation suspends **all** commands |
| **Observational** | An invariant worker running every §26.1 check **independently of the code paths that maintain them** |
| **Organisational** | 24 release gates, `SAFETY_APPROVAL_QUORUM = 2`, **no self-approval**, and a calibration gate that blocks launch on 39 Safety-class parameters |
| **Formal** | TLA+ models under `formal/`, checked with TLC |

### 30.2 Why the release verdict is BLOCKED

`npm run release:verdict` → **0 green, 17 red, 7 not evaluated.**

All 17 RED rows are red for **one** reason today: `[STALE]` — the recorded evidence is ~8.5 days old
against an 86 400 s admittance window. *"Stale evidence is evidence about a system that has since
changed."*

Seven are `NOT_EVALUATED`, which blocks exactly as RED does but is kept distinct **so an incident
review can tell "we ran it and it failed" from "nobody ran it."**

> **Do not re-collect release evidence to make the verdict render better.** The verdict is BLOCKED
> either way; re-collection is the release owner's step at a quiescent tree. The Phase 15 freeze
> (2026-08-31) bars manufactured work of exactly this kind.

### 30.3 The four gate classes

| Class | Example | Closable by a commit here? |
|---|---|---|
| **BUILD** | tier dependencies, parameter register, tenets, identity isolation, legacy removal | **Yes** — and 7 of 8 are passing |
| **SUITE** | lower-bound admissibility, model checking at capacity 1/2/3, determinism replay, chaos, scale, locality, overload | **Yes**, but the evidence ages out |
| **PRODUCTION** | invariants enforced in production, simulator fidelity, soak, shadow agreement | **No.** These need an operating fleet. **Never simulate them** |
| **ORGANISATIONAL** | calibration derived, safety case assembled, rollback rehearsed | **No.** These need named humans with authority |

### 30.4 The rules the project holds itself to

> **TRUTH > GREEN.**

- A status of `NOT_EVALUATED`, `NOT_PROVEN`, `PROVISIONAL`, `UNCALIBRATED` or `BLOCKED` **stays that
  way** until real evidence changes it.
- A refusal names its **blocker and its owner**. `assertRegistry()` throws on a `DEFERRED` worker with
  no `blockedBy`, because *"an unexplained exemption is how a register rots."*
- `gate:composition` goes green **when the coordinator actually starts, and only then.** It is not
  weakened to get past it.
- A gate that fails on this tree is **the correct result**, not an outstanding engineering task.

---

# PART V — REFERENCE

## 31. Important files

### 31.1 If you read ten files, read these

| # | File | Why |
|---|---|---|
| 1 | `Backend/server.js` | The composition root. 1 184 lines, most of it *why* rather than *what*. Reading it top to bottom teaches the system's shape |
| 2 | `Backend/src/engine/TIERS.md` | The obligation tiers. Checked against `tierAssertions.js` by a test |
| 3 | `Backend/src/workers/registry.js` | The declarative answer to "what runs?", including what does **not** and why |
| 4 | `Backend/src/workers/leaderWorkers.js` | The composition refusals. **The most instructive file in the repository** |
| 5 | `Backend/src/services/task.service.js` | The §3.4 request path, and a header that records exactly what Phase 15 deleted and what it kept |
| 6 | `Backend/src/sockets/handlers/telemetry.handler.js` | The hot path, with every optimisation annotated with the measurement that motivated it |
| 7 | `Backend/src/cache/kv.js` | The Redis facade and the fail-closed argument |
| 8 | `Backend/src/engine/commitment/commit.js` | Where exclusivity is decided |
| 9 | `Backend/src/engine/cost/phi.js` | The cost functional, and why there is no `normalize()` |
| 10 | `docs/runbooks/demonstration.md` | The honest end-to-end walkthrough, including the two steps that correctly fail |

### 31.2 By subsystem

| Concern | Files |
|---|---|
| **Boot / wiring** | `server.js`, `src/app.js`, `src/routes/index.js` |
| **Auth** | `middlewares/auth_middleware.js`, `controllers/auth_controller.js`, `controllers/webauthn_controller.js`, `engine/security/{sessionBinding,attestation,override}.js` |
| **Robots** | `controllers/robots.controller.js`, `services/robot.service.js`, `services/robotSpecification.js`, `sockets/handlers/robot.handler.js` |
| **Telemetry** | `sockets/handlers/telemetry.handler.js`, `services/telemetry.service.js`, `services/robotRegistry.service.js`, `cache/robotStateCache.js` |
| **Tasks** | `controllers/tasks.controller.js`, `services/task.service.js`, `engine/intake/intake.js`, `engine/domain/mappers/legacyTask.js` |
| **Assignment** | `workers/coordinator.worker.js`, `workers/coordinatorSolvePath.js`, `workers/coordinatorPipeline.js`, `engine/{candidates,feasibility,cost,plan,solve,commitment}/` |
| **Dispatch** | `engine/dispatch/{outbox,offers,sequence,escalation}.js`, `workers/outbox.worker.js`, `services/commandDispatcher.service.js`, `sockets/handlers/offer.handler.js` |
| **Supervision** | `engine/supervision/*`, `workers/{timer,reconciler}.worker.js`, `engine/fairness/ladder.js` |
| **Obstacles** | `sockets/handlers/dtaro.handler.js`, `services/{alertDissemination,ekb,routeIntersection,routing}.service.js` |
| **Zones / space** | `services/zoneManager.service.js`, `engine/spatial/{cells,hierarchy,regionBoundary}.js` |
| **Config** | `engine/config/*`, `controllers/config.controller.js` |
| **Sharding** | `engine/shard/*`, `workers/shardSupervisor.worker.js`, `controllers/shards.controller.js` |
| **Observability** | `engine/observability/*`, `controllers/{health,explain,diagnostics}.controller.js`, `observability/eventLoopMonitor.js` |
| **Cutover** | `engine/cutover/*`, `workers/cutover.worker.js` |
| **Simulation** | `simulation/{SimulationEngine,VirtualRobot,constants}.js` |
| **Frontend core** | `context/AppProvider.jsx`, `lib/socket.js`, `router/AppRouter.jsx`, `lib/api/*` |
| **Frontend map** | `features/maps/campus/campusRegistry.js`, `features/maps/mapControl/*`, `features/maps/__architecture__/*` |
| **Gates** | `tools/gates/*`, `src/engine/guards/tenets.js`, `tools/replay/replayDecision.js` |

---

## 32. Important functions and classes

```
TASK CREATION
├── controllers/tasks.controller.js
│   └── assignTask(req,res)                     ← REST entry
├── services/task.service.js
│   ├── assignTask(prisma, task, {kv,io,...})   ← THE §3.4 REQUEST PATH
│   ├── parsePayloadDeclaration(input)          ← mass AND tolerance, or neither
│   ├── admitToRound(prisma, pending, options)  ← Task → Mission/Leg/Stops → queue
│   ├── superviseQueuedEntry(tx, input)         ← the §4.5 deadline, SAME transaction
│   ├── sealIdentities(prisma, input)           ← §23.7 surrogate keys
│   └── rerouteTask(prisma, taskId, {kv,io})    ← the ONE retained legacy surface
└── engine/intake/intake.js
    └── admit(deps, input)                      ← idempotency, shard, WorkQueue row

ASSIGNMENT  (composed; refuses)
├── workers/coordinator.worker.js
│   ├── runRound(deps, input)                   ← THE ROUND
│   ├── claimBatch(deps, input)                 ← conditional write on (id,state,version)
│   ├── settleBatch(deps, input)                ← AFTER the commit, never before
│   ├── recordRound(deps, input)                ← Round + snapshot + Tier A/B
│   └── resumeAfterFailover(deps, shardId)      ← §19.5 reconstruction
├── workers/coordinatorSolvePath.js
│   ├── create(context)                         ← BUILDS the five collaborators
│   ├── commitFor(context, round)               ← geometry resolved OUTSIDE the txn
│   └── taskAttributesFor(mission)              ← requirements/payload/SLA/tenant
├── workers/coordinatorPipeline.js
│   ├── REQUIREMENT_IDS                         ← the 34-input contract
│   └── requirements(context)                   ← what THIS deployment is missing
├── engine/candidates/expansion.js  · lowerBound.js · omega.js
├── engine/feasibility/
│   ├── register.js  PREDICATES[38]             ← id, class, cacheTier, volatile, group
│   ├── evaluate.js  evaluate(...)              ← collectAll — the WHOLE denial set
│   └── threeValued.js                          ← UNKNOWN IS NOT PERMISSION
├── engine/cost/phi.js
│   ├── evaluate(plan, context)                 ← Φ over EVERY Leg in the plan
│   ├── registerTerm(...)                       ← the Tier 2 inversion seam
│   └── assertWearChargedOnce(...)              ← §8.2/§8.5 ambiguity, resolved
├── engine/solve/round.js  execute(...)         ← plan → commit → decisions
└── engine/commitment/commit.js  commit(...)    ← SERIALIZABLE, G1–G6, outbox inside

DISPATCH
├── services/commandDispatcher.service.js
│   ├── dispatch(io, robotId, event, payload)   ← room-routed, adapter-aware
│   ├── deliverOutboxCommand(io, id, envelope)  ← THE SINGLE EXIT for §10.3.1
│   └── outboxDeliveryArm(io, options)          ← forwards the accessor, never invokes it
├── workers/outbox.worker.js  drainOnce/start
└── sockets/handlers/offer.handler.js
    └── publishAssignment(input)                ← the legacy projection, AFTER the txn

TELEMETRY
├── sockets/handlers/telemetry.handler.js
│   ├── handleTelemetry(data)                   ← THE HOT PATH
│   ├── assessAgentReport(input)                ← §23.5 position + energy
│   ├── computeSnapshotDecision(...)            ← pure; the history throttle
│   └── feedProgressSupervision(...)            ← §12.3; MEASURES, never acts
└── services/robotRegistry.service.js
    └── buildMergedRegistryState(...)           ← pure; EMA utilisation + zone

ROBOT SESSION
└── sockets/handlers/robot.handler.js
    ├── AUTH handler                            ← the whole admission sequence
    ├── establishCertificateSession(...)        ← §23.2, before the weaker branches
    ├── isCertificateBinding(stored)            ← the P14-R8 type-confusion fix
    ├── runDedupHandshake(...)                  ← §11.5, BEFORE AUTH_SUCCESS
    └── maybeRekeySession()                     ← rides the heartbeat

OBSTACLES
└── services/alertDissemination.service.js
    └── processObstacleReport(prisma,kv,io,rpt) ← zone → EKB → affected → reroute

CACHE
└── cache/kv.js
    ├── pipeline().get().set().exec()           ← THE performance primitive
    ├── mget(keys)
    └── reserveRobot(k,v,ttl,{advisory})        ← advisory by DEFAULT since Phase 15

COMPOSITION
└── workers/leaderWorkers.js
    ├── COMPOSERS.{outbox,reconciler,timer,coordinator}
    ├── UNCOMPOSABLE.coordinator                ← the declarative blocker a gate reads
    └── create(context).apply(tick)             ← idempotent; stops on demotion
```

---

## 33. Common workflows, end to end

### 33.1 Commission a robot and watch it move

```
1. /commission  → identifier RBT-1000, chassis Rover (Ground),
                  zone via Mapbox search, six specification values, initial battery
2. Backend      → Robot row; AgentClass AC-RBT-1000; MobilityModel, EnergyModel,
                  ContainerModel, CapabilityBundle for THIS unit; pairing code in Redis
3. Simulator    → VirtualRobot attaches, connects, AUTHs with the pairing code
4. /robots      → the unit appears, live battery and position updating every 2 s
5. /map         → its marker moves
6. /robots/RBT-1000 → Edit → change a value → Save
                  (battery, position and the current assignment are NOT editable
                   and are refused BY NAME, not silently ignored)
```

### 33.2 Create a task (and see the refusal)

```
1. /tasks → Create Task → pickup and drop via Mapbox search,
            payload mass AND tolerance, required model
2. Submit → PIN/passkey step-up
3. POST /api/tasks/assign
4. → 503 ENGINE_NOT_LIVE. Nothing is written.
5. The card says: "refused — the assignment engine is not live for this shard.
                   No work is queued."
```

**That is the correct end state on this tree.** Publishing `cutover.engine_enabled` to get past it
would not help — S-3 stops the coordinator one layer further in — and it is the owner's decision,
already measured as refused.

### 33.3 Run the honest demonstration

`docs/runbooks/demonstration.md` — seven steps, of which **two end in a deliberate refusal, and those
two are the most informative.**

```
Step 1  npm test                                       → 175 suites / 7 581 tests, exit 0
Step 2  npx jest tests/engine/coordinatorSolvePathComposition.test.js --verbose
                                                       → 92 passed, ~7 s. THE CENTRE
Step 3  npm run gate:erasure  + six engine suites      → byte-for-byte replay, 8 queries
Step 4  npm run gates                                  → exit 1. THE STRUCTURAL BREAK
Step 5  disposable PG on 55432 + npm run verify:v1CorePath
                                                       → exit 1. 503, then 26 of 34
Step 6  npm run routing:readiness                      → OVERALL: BLOCKED
Step 7  the browser workflow                           → stops at the refusal
```

**The one rule for presenting it:** *a refusal in step 4 or step 5 is the demonstration succeeding, not
failing.* Presenting either as a failure misdescribes it; presenting either as a pass would be the
fabrication the whole programme exists to prevent.

### 33.4 Add a new configuration parameter

```
1. Add the entry to the right register file under engine/config/register/
   — name, changeClass, calibrationStatus, default, scope, and what it AWAITS
2. Read it through the resolver, never as a literal
3. npm run gate:params   ← fails if a literal remains
4. If it is Safety-class and not DERIVED, gate:calibration will now count it.
   THAT IS CORRECT. Do not mark it DERIVED to make the gate quieter
```

### 33.5 Add a worker

```
1. Write src/workers/x.worker.js with runOnce()/drainOnce() and start()
2. Add a registry row: id, module, section, tier, readiness,
   AND (cadenceParameter that actually exists) OR (cadenceNote saying what governs it)
3. If DEFERRED, blockedBy is MANDATORY — assertRegistry() throws otherwise
4. If SCHEDULED, wire it in server.js startScheduledWorkers()
5. If LEADER_ONLY, add a composer in leaderWorkers.js that either starts it
   or REFUSES BY NAME. Never a stub
6. npm run gate:composition
```

---

## 34. Current limitations

1. **The engine does not assign anything.** 26 of 34 coordinator inputs unresolved.
2. **`POST /api/tasks/assign` returns 503 on every shard.**
3. **39 Safety-class parameters are not DERIVED.** §22.4 forbids launching on any of them.
4. **All release evidence has aged out.** 17 of 24 gates RED for staleness alone.
5. **Operators are unscoped.** Any authenticated operator sees and acts on the whole fleet.
6. **There is exactly one role.**
7. **Campus is a label, not a boundary.**
8. **No physical robot has ever connected.** Every measurement is of simulated agents.
9. **Multi-machine horizontal scaling is unproven**; the one clustering experiment regressed every tier.
10. **`CellAssignment` is unpopulated** — the H3 containment model is implemented and unused.
11. **Three legacy Redis key families remain in the correctness path for in-flight work**
    (`taskPath:*`, `robotTaskState:*`, `robotTask:*`), retired *after* the retention window rather than
    at cutover, because deleting them would strand every mission in flight.
12. **The P0 presentation work is uncommitted** — a `git stash` changes what the system does.
13. **Four P0 seams have never been observed on a running system** — the route handoff, the legacy read
    model, the completion mapping, the Mapbox execution geometry. Tests only, because nothing on this
    tree can produce a commitment for them to act on.
14. **CI does not run `gate:composition`** — a green CI is not a green build-gate set.
15. **Simulator fidelity is NOT_MEASURED** across 7 models.

---

## 35. Future roadmap — and the AI boundary

### 35.1 The critical path to a working assignment

```
D1  authoritative operating region      ← Operations + Commercial   ]
D3  fleet speed model                   ← Product + Fleet Eng       ]→ B1
D8  extract vintage                     ← Operations                ]
                                                                     ↓
B1  select and deploy a routing engine  ── releases 5 of 26 inputs
B8  derive 15 calibration values        ← the §22.4 calibration owner
W-B4 build 6 NO_PRODUCER input families ← Engineering + named sources
                                                                     ↓
                    the coordinator composes → gate:composition GREEN
                                                                     ↓
FD-3 a second Safety approver           ← currently NO
S-5  publish + pin cutover.engine_enabled at region scope
                                                                     ↓
                          one shard staged, watched, rollback-armed
```

**None of the first six is an engineering task inside this repository**, and no commit here closes any
of them. That is why the gate is red rather than the work being scheduled.

### 35.2 The AI roadmap — every item PLANNED or PROPOSED

> **RobotX contains no machine learning, no AI model, and no learned policy.** A search for
> `tensorflow`, `onnx`, `pytorch`, `neural`, `SLAM`, `computer vision` and `machine learning` across
> `Backend/src` and `Frontend/src` returns **zero matches**. Nothing below may be described as a
> capability.

| Area | Status | Where it would attach |
|---|---|---|
| Computer vision (obstacle classification) | **PROPOSED** | On-agent, enriching `OBSTACLE_REPORT` |
| Sensor fusion (GPS + IMU + ultrasonic) | **PROPOSED** | On-agent, before `TELEMETRY` |
| Local obstacle avoidance | **PROPOSED** | On-agent, entirely below the wire contract |
| ML ETA prediction | **PLANNED — the seam exists** | `serviceTimeModel.worker` is the shrinkage-based version already |
| Hybrid ML + engine | **PROPOSED** | Only ever as an *estimator* feeding Φ's inputs. **Never as the chooser** |
| Failure / anomaly prediction | **PROPOSED** | `p_fail` is already a **declared engine input with no producer** — a named seam awaiting a source |
| Predictive charging | **PROPOSED** | `energy/chargingSchedulerClient.js` is an interface with no implementation |
| Congestion prediction | **PROPOSED** | `timeBucket` is a declared routing input with no producer |
| Route risk prediction | **PROPOSED** | `route_hazard_cost` is a declared input from a Map service that does not exist |
| AI diagnostic / root-cause | **PROPOSED** | Would read the decision records; §21.3 already answers eight queries deterministically |
| AI fleet assistant | **PROPOSED** | Read-only over the explanation API |
| SLAM | **PROPOSED** | On-agent |

### 35.3 The boundary, and why it is structural rather than aspirational

**ADR-14, frozen:**
> **Decision: Learning in estimation; classical solver for decisions.**
> **Rejected: Learned end-to-end policy.**
> *"An implementation that reintroduces the rejected alternative is a defect against §25.5, not a
> design variation, and is reverted rather than debated."*

Even the three statistical fitters sit on the **estimation** side, and the architecture enforces the
separation mechanically: a fitted cohort is an **input the round pins by version.** *"A model that
moved while a round was running would make two candidates for the same Leg evaluate against different
dwell distributions, which is a determinism failure rather than a freshness improvement."*

**AI-assisted, not AI-dependent.** An LLM or a learned model **must not directly control
safety-critical motor actuation**, and nothing here gives one that ability — structurally:

```
motion  ⟸ only a §10.3.1 command
        ⟸ only by draining the outbox
        ⟸ only from a row written INSIDE the commit transaction that authorises it
        ⟸ only behind a 38-predicate boolean gate that is NEVER traded against cost

A learned component that wanted to move a robot would have to satisfy that gate,
and the gate does not accept confidence scores.
```

**Where ML would genuinely help, and why it is the right shape:** the engine already declares
`p_fail`, `timeBucket`, `route_hazard_cost` and the service-time cohorts as *inputs with no producer*.
An ML model that produced any of them would slot in as an **estimator behind a versioned, pinned
interface** — improving the numbers Φ prices with, while leaving the choosing to a solver whose
decisions replay byte-for-byte and whose sensitivity margin is an exact subtraction. **That is a
better place for a model than the decision itself**, and it is the reason the boundary was drawn
there.

---

## 36. How to re-verify everything in this document

**Nothing here should be trusted after the tree moves.** Every figure in this handbook is reproducible
in under ten minutes.

```bash
cd Backend

# ── The three verdicts ───────────────────────────────────────────────────────
npm run gates              # 8 build gates. Expect exit 1, gate:composition FAIL
npm test                   # 5 projects.   Expect 175 suites / 7 581 tests / exit 0
npm run gate:calibration   # Expect FAIL at 39. Prints the 250 / 52 / 160 / 38 split
npm run release:verdict    # Expect RELEASE: BLOCKED
npm run routing:readiness  # Expect OVERALL: BLOCKED (exit 0 — by design)

# ── The counts ───────────────────────────────────────────────────────────────
node -e "console.log(require('./src/engine/feasibility/register').PREDICATES.length)"   # 38
node -e "const r=require('./src/workers/registry');console.log(r.WORKERS.length)"       # 19
ls prisma/migrations | wc -l                                                            # 30 (incl. lock)
find src -name '*.js' | wc -l                                                           # 295
find src/engine -name '*.js' | wc -l                                                    # 196
grep -cE '^model ' prisma/schema.prisma                                                 # 70

# ── The benchmark figures — read the JSON, do not quote this document ────────
node -e "
const fs=require('fs');
for (const d of ['baseline','optimized','optimized-redis-logging','highfleet']) {
  for (const f of fs.readdirSync('benchmark/results/'+d).filter(x=>x.startsWith('tier-')&&x.endsWith('.json'))) {
    const r=JSON.parse(fs.readFileSync('benchmark/results/'+d+'/'+f));
    const a=Array.isArray(r)?r:[r];
    for (const x of a) console.log(d, x.tier,
      'auth', x.connection?.authRatio,
      'restP50', x.latency?.assignRestResponseMs?.p50,
      'e2eP50', x.latency?.assignmentEndToEndMs?.p50,
      'dashP50', x.latency?.telemetryToDashboardMs?.p50,
      'cpu', x.resources?.serverProcess?.cpuPercentAvg,
      'poolWait', x.resources?.prismaPool?.queriesWaitAvgMs,
      'ok', x.counts?.taskAssignSucceeded+'/'+x.counts?.taskAssignAttempts);
  }
}"

# ── The live system ──────────────────────────────────────────────────────────
curl -s localhost:3000/health | jq '{redis,db,degraded,shard,configVersion,prismaPool,eventLoopDelay}'
```

### 36.1 The rule for quoting a number

**Say which tree it was measured on.** `docs/runbooks/demonstration.md` §7 makes this a formal rule and
pins a source digest for exactly that reason. A number quoted against a different tree is not a
measurement; it is a memory.

---

## 37. Interview and presentation mental models

This section exists because the honest description of RobotX is *more* impressive than the marketing
one, and because a claim that dissolves under one follow-up question costs more than it earned.

### 37.1 The three sentences to open with

> **"RobotX is a fleet command-and-control platform for delivery robots. The host platform — telemetry,
> authentication, live dashboard, obstacle handling, commanding — is live and benchmarked to about a
> thousand robots on one process. The assignment engine that replaced the original allocator is built,
> tested at 7 581 tests, and deliberately refuses to start, because it needs a routing engine and
> fifteen calibration values that nobody has supplied yet."**

That framing does three things at once: it states real capability, it states real limitation, and it
signals that the limitation is *understood and named* rather than discovered.

### 37.2 Architecture questions

**Why Node.js?**
The workload is I/O-bound fan-out — thousands of long-lived WebSockets carrying small frequent
messages — not computation. A single event loop with non-blocking I/O suits that, and one language
across backend, simulator and dashboard removes a class of contract drift. **The cost is measured, not
assumed:** at 500 robots the profile shows 70 % of samples in OS socket work on one core, which is why
the solve is budgeted and anytime, and why CPU-bound work must never go on that thread.

**Why Socket.IO rather than raw WebSocket?**
Robots have **no inbound address** — NAT, cellular, intermittent. The server must push. Socket.IO gives
four things I would otherwise have to build: automatic reconnection, transport fallback, **rooms**, and
a **pluggable adapter**. Rooms are what made the O(N²) fix a one-line change — telemetry was `io.emit`,
sending every robot's position to every *other* robot; scoping it to a `dashboard` room took dashboard
latency at 500 robots from 601 ms to 5 ms. The adapter is what makes multi-process delivery correct.

**Why Redis *and* PostgreSQL? Why not one?**
Two different jobs. Postgres is durable truth and needs transactions — the commit is `SERIALIZABLE`
with `FOR UPDATE` row locks, and three invariants are enforced by database constraints and triggers so
they hold even when application code is defective. Redis is live state that changes 0.5 Hz per robot,
plus cross-process pub/sub for the socket adapter.
**The measured reason:** the telemetry path once did a Postgres read per frame. At 500 robots that
alone put pool wait at 159 ms and REST latency at 21 s. Moving live state to Redis took the same tier
to 0.01 ms pool wait.
**And the rule that keeps it safe:** the cache is *never* authoritative. Every Redis key mirrors a
Postgres row or is genuinely ephemeral, and the module that decides exclusivity takes no cache
dependency at all — because a lock with a timeout cannot provide mutual exclusion across a process
pause, since a paused holder cannot know it was preempted.

**Why Prisma?**
Typed queries, migrations as reviewable ordered artefacts, and — the part that earned its keep —
`previewFeatures: ["metrics"]`, which surfaced `prisma_client_queries_wait_histogram_ms` on `/health`.
**That metric is what found the bottleneck.** Where Prisma cannot express what is needed
(`SERIALIZABLE`, `FOR UPDATE`, triggers) the code drops to raw SQL and says so.

**Why replace the original assignment engine?**
Four structural problems, not a preference. It was **greedy per-arrival**, so it could not express "B
is better for this Leg but the global assignment is cheaper with B elsewhere." It scored candidates on
a **normalised weighted sum**, which cannot answer "how much did this cost?" in a unit anyone can
audit. It detached the assignment into a **`setImmediate` with no owner, timeout, retry or
observability**, which produced tasks stuck at PENDING with no record of the failure. And its only
exclusivity mechanism was a **Redis lock with a TTL.**

**Why is it not running, then?**
Because it needs inputs that do not exist, and it refuses to invent them. A build gate prints the whole
contract: 34 declared inputs, 26 unresolved — 5 routing, 15 calibration, 6 with no producer. A stub
would produce *"a worker that runs, reports success, and computes nothing — the worst of the three
possible states."* A coordinator started with a fabricated router would assign real work on invented
travel times.

**What is the bottleneck?**
It moved three times, and each move is documented. First a per-frame database read (pool wait 159 ms).
Then Redis *command dispatch* — not Redis itself; ioredis's per-command JS socket write was the top two
JS entries in the profile, so the fix was **fewer commands**, not a faster Redis. After both, the
process spends ~70 % of its samples in the OS doing socket work. **That is where JavaScript
optimisation ends**; the next gain is architectural — fewer, larger messages, or more machines.

### 37.3 Workflow questions

**What happens when a user creates a task?**
Validate → parse the payload (mass *and* tolerance, or neither) → normalise the requested chassis →
**check the cutover gate before writing anything** → `Task` row → map to one Mission, one PRIMARY Leg,
two Stops with ids that are a pure function of the task id → arm the §4.5 deadline **in the same
transaction as the Leg** → seal identifying values into a separate store → write a durable `WorkQueue`
row. **That queue row is the handoff.** Between the request path and the round path there is no
closure, no timer and no process-local state — which is what makes the work survive a restart.
**Today it stops at the gate with a 503, and that is deliberate.**

**How is a robot selected?**
Candidates from a cell-partitioned availability index, ring-expanded within the SLA class's radius →
**all 38 feasibility predicates**, three-valued, with indeterminate *denying* for identity and resource
classes → survivors priced with Φ, a functional over the agent's **whole plan** rather than a score for
the pairing → an admissible lower bound prunes anything already worse than the incumbent → min-cost
flow → commit inside a `SERIALIZABLE` transaction with six guards.

**Why Robot A and not Robot B?**
Five genuinely different answers, and the system distinguishes them: B was never a candidate; B was
denied by the gate (and the record carries **every** failing predicate, distinguishing *denied* from
*indeterminate*); B cost more (with the per-term breakdown in integer milli-CU and the exact margin);
B cost less but the global assignment is cheaper with B elsewhere; or B won the plan and lost the
commit. There are eight explanation queries, each naming whether it retrieved or recomputed.

**What happens when a robot disconnects?**
Two mechanisms, and exactly one is active at a time. The primary is the socket handler, which marks it
offline immediately. The backstop is a sweep for handlers that never ran — a process kill, a half-open
TCP connection. The backstop consults Redis's per-beat heartbeat **before** the throttled Postgres
column, because both telemetry and heartbeat throttle their writes and a stale column is no longer
evidence. With the engine on, the sweep stands down and the reconciler owns it — *"a divergence
repaired twice, by two loops with different notions of stale, is the disagreement the control-loop
model exists to remove."*

**What happens when an obstacle appears?**
The robot reports it → the zone is resolved through a 3-tier cache → the obstacle is stored in the
Environmental Knowledge Base (Redis with a TTL, plus a durable row) → the dashboard is told → every
live robot's planned path is tested against the obstacle modelled as a small segment → affected robots
get `REROUTE_ALERT` in their own rooms and are replanned server-side through Mapbox. Everything after
EKB storage is best-effort: a rerouting failure must not stop the obstacle being recorded.

### 37.4 Database questions

**What is in PostgreSQL, and what is in Redis?**
Postgres: identity, commissioning, commitments, work structure, decision records, configuration
versions, audit — **persistent truth and history**. Redis: current position, current battery, last
heartbeat, session tokens, pairing codes, cached zones, route polylines for in-flight work, and every
engine advisory mirror — **what is happening right now**.
**The rule:** every Redis key either mirrors a Postgres row or is ephemeral, and the key catalogue
names what is authoritative for each.

**How do you prevent double-assignment?**
Four independent mechanisms, deliberately not one. (1) Leader election gives one writer per shard.
(2) The commit is `SERIALIZABLE` with `FOR UPDATE` row locks. (3) Six guards check leadership fence,
authority epoch, entity version, capacity, cancellation and idempotency. (4) Two **database**
backstops — a `kind='HARD'` CHECK and a partial unique index enforcing capacity — that hold even if
every guard were bypassed. **The Redis lock is advisory and no caller depends on it for correctness.**

### 37.5 Robotics questions

**What hardware does it run on?**
**Honest answer:** the hardware is not in this repository. What *is* defined — and this is the part
worth talking about — is the **contract firmware must satisfy**, with `VirtualRobot` as the designated
reference implementation and conformance fixture. Six obligations: durable deduplication state written
**before any observable effect** (before motion, before actuation, before an ACK); two fence scopes
compared differently, imported from **one shared module** so server and agent cannot drift; queries
never fenced; a bounded autonomous continuation limit with a halt at the safest reachable location;
refusal of an unexecutable offer **by name**; and integration of the **same charge curve** the server
plans with, on parameters carried in the offer.

**How does GPS enter the system?**
As `lat`/`lon` on a `TELEMETRY` frame. Below that is firmware and is not in this repository — there is
no NMEA parsing, no serial handling, **and no accuracy figure anywhere**, so I will not quote one.
Above it: kinematic plausibility against the agent's `MobilityModel` ceiling (a jump exceeding
achievable speed is **rejected, not smoothed** — a smoothed jump is a position that is plausible and
wrong, and every consumer downstream would treat it as measured); merge into live state; Redis every
tick; Postgres on a dirty-state gate; bounding-box zone resolution; H3 cell mapping as a pure function.
**And where the ceiling is unknown, the check reports INDETERMINATE rather than refusing** — an absent
input is not evidence of a spoof.

**Why a simulator, and what does it actually prove?**
It is a `socket.io-client` speaking the same protocol over loopback — not a mock. It proves the wire
contract is implementable end to end, that the server handles N concurrent authenticated sockets at a
measured rate, and how Redis/Postgres/the event loop behave at fleet-scale message rates. **It proves
nothing about hardware** — not GPS accuracy, not motor control, not obstacle *detection*, not battery
or thermal reality. The project enforces that: the simulator-fidelity gate is `NOT_EVALUATED` with
seven models unmeasured, and an owner decision on record states that **no simulated agent is admitted
as V1's agent**.

### 37.6 Scalability questions

**How does it scale?**
Measured, on one machine: **1 000 robots comfortably** — 100 % authentication, 24 of 24 assignments,
256 ms end-to-end, 76 % CPU — and **≈2 000 at the edge**, where authentication still largely succeeds
and telemetry still flows but assignment collapses to 2 of 24. At 5 000 the ramp itself fails at 58 %
authentication. **That is a single-process, single-machine plateau under one workload profile, not an
architectural ceiling.**

**Why didn't clustering help?**
Because I ran four processes on **one** machine. They competed for the same cores, and — the bigger
effect — each opened its own Prisma pool, so pool wait went from **2.63 ms to 3 555 ms at two
workers**, a 1 350× regression. The database became the bottleneck the single-process optimisation had
removed. Nginx's `worker_connections` capped the 5 000-robot ramp at 20 % authentication, and the
in-process caches lost their hit rate.
**What it did prove is worth keeping:** the cross-process routing is already correct — the Redis
adapter and the per-robot room pattern delivered across workers throughout.

**Is it horizontally scalable?**
**Not proven, and I won't claim it.** Multiple workers on one box is not that test. A genuine test
needs independent machines, a shared Postgres sized for the aggregate pool, and a load balancer that
is not itself the ceiling. **The architecture is *shaped* for it** — region sharding with one leader
per shard, adapter-routed delivery, a durable outbox rather than in-memory queues — and the shard
model with leader election, fenced leases and failover reconciliation is implemented and running.
**Shaped for it is not the same as demonstrated, and I keep those separate.**

**Would Kubernetes / Kafka / microservices help?**
All three were proposed in a superseded design document and **none was adopted.** ADR-12 chose
**region sharding** over service extraction, because the work partitions geographically and splitting
one transaction across services would break the exclusivity argument. ADR-05 chose a **transactional
outbox** over a broker, because the command and the state change that authorises it must commit
*together* — a broker puts the write and the publish in different systems and reintroduces the exact
failure. None of the three has been benchmarked here, so I cannot claim they would or would not help;
what I can say is why they were rejected for this design.

### 37.7 AI questions

**Does RobotX use AI?**
**No, and I would rather say so than stretch the word.** There is no model, no inference, no training
pipeline, no LLM anywhere in the runtime. What people sometimes mistake for it: a 38-predicate boolean
gate, an additive cost function in absolute units, a min-cost-flow solve, EMA smoothing, and three
statistical fitters that are implemented and **have never run**.

**What is planned, and where would it go?**
The architecture has already reserved the seams. `p_fail`, `timeBucket`, `route_hazard_cost` and the
per-site service-time cohorts are **declared engine inputs with no producer** — named gaps awaiting a
data source. An ML model that produced any of them would slot in as an **estimator behind a versioned,
pinned interface**, improving the numbers the cost function prices with while leaving the choosing to
a solver whose decisions replay byte for byte.

**Why not let a model make the assignment?**
ADR-14 is frozen: *learning in estimation, classical solver for decisions*, with *learned end-to-end
policy* recorded as the **rejected** alternative. The practical reason is explainability. Because Φ is
a transparent additive sum, the minimum change that flips a decision is a **subtraction** —
`γ(runner-up) − γ(chosen)`, reported per term in integer milli-CU. **That exact sensitivity margin is
the concrete payoff of a transparent optimiser over an opaque policy**, and it is what lets an operator
be told not just *what* was decided but *what would have changed it.*

**Why must AI not control motors?**
It is structural here, not a policy statement. Motion comes only from a §10.3.1 command; a command is
emitted only by draining the outbox; an outbox row is written only inside the commit transaction that
authorises it; and that commit runs only behind a boolean gate that is never traded against cost.
**A learned component that wanted to move a robot would have to satisfy that gate — and the gate does
not accept confidence scores.**

### 37.8 The five things to say about engineering process

These are the answers that distinguish a project from a demo.

1. **"Every optimisation was made because a profile identified it, and kept because a re-benchmark
   showed it moved."** Two changes measured as *no improvement* until a second related fix landed —
   the heartbeat gate is the example, and it is exactly the information intuition-driven optimisation
   loses.
2. **"Two experiments failed and I kept them."** Same-machine clustering and PgBouncer both made things
   measurably worse, and both are still in the repository with their data, because a negative result
   that is recorded is worth more than one that is repeated.
3. **"The build gates run first and independently of the tests."** A tier-dependency violation or an
   unregistered behavioural constant is a structural defect that no amount of passing tests makes
   acceptable. And a green suite has repeatedly coexisted in this project with a composition that could
   not be built.
4. **"A refusal names its blocker and its owner."** A worker that cannot be composed is refused by
   name, the refusal is published, and the gate stays red. A deferred worker with no stated blocker
   throws at module load, because *"an unexplained exemption is how a register rots."*
5. **"TRUTH > GREEN."** A status of `NOT_EVALUATED`, `PROVISIONAL`, `UNCALIBRATED` or `BLOCKED` stays
   that way until real evidence changes it. The release verdict is BLOCKED and I did not re-collect
   evidence to make it render better.

### 37.9 Questions you should expect, and honest answers

| Question | Answer |
|---|---|
| *"So it doesn't work?"* | The platform works and is benchmarked. The **assignment decision** doesn't run, and that is a named, external blocker — not an unfinished feature. I can demonstrate the whole path end to end, including the two steps that correctly refuse |
| *"Why not just hard-code a router to demo it?"* | Because then it would assign real work on invented travel times. The gate exists to stop exactly that, and weakening it to make a demo greener is the failure mode the whole programme is built against |
| *"Isn't 2 000 robots low?"* | For one Node process on one laptop-class machine with every robot on a 2 s tick, it is the measured plateau, and I know precisely why: ~70 % of CPU samples are OS socket work. The architecture is sharded for multi-machine scale; I have not **proved** multi-machine scale, so I don't claim it |
| *"Have you tested with real robots?"* | No. Every measurement is of simulated agents, and the project refuses to count simulation as physical validation — there is an owner decision on record saying so |
| *"What's the biggest thing you'd change?"* | The blockers are external, so the honest answer is not a code change: it is that the six `NO_PRODUCER` input families need **code and a named data source**, and nobody has named the source. Inside the code, I'd close the operator-scoping gap — one role and no scope columns is the largest genuine gap that is mine to fix |
| *"What broke that you didn't expect?"* | Several defects that produced no error at all: expressions that were always `undefined`, guards written and tested but never called, and a socket path that failed *closed* on every shard for ever. **A wiring bug that fails closed is invisible.** It changed how I look for defects |

---

## 38. The one-page summary

```
WHAT IT IS       A fleet command-and-control platform for delivery robots
                 Node.js · Express · Socket.IO · PostgreSQL/Prisma · Redis · React 19

WHAT RUNS        Robot auth · telemetry ingestion · live dashboard · obstacle handling
                 and rerouting · operator commands · commissioning · simulation
                 Task intake → durable queue · outbox dispatch · timers · reconciler
                 shard leadership · config service · invariant register  (12 of 19 workers)

WHAT DOESN'T     The assignment round loop. 26 of 34 declared inputs unresolved
                 POST /api/tasks/assign → 503 ENGINE_NOT_LIVE

WHY              5 routing inputs  → B1, blocked on D1/D3/D8 (not engineering tasks)
                 15 calibration    → B8, the §22.4 calibration owner
                 6 no producer     → missing code AND a named data source
                 + S-5, the per-region cutover binding, an owner act, measured as refused

MEASURED         175 suites / 7 581 tests / 0 failures        (2026-09-07)
                 7 of 8 build gates PASS; gate:composition FAIL (correctly)
                 gate:calibration FAIL at 39 · release verdict BLOCKED
                 500 robots: REST p50 18 433 ms → 19 ms; dashboard 601 ms → 5 ms;
                             CPU 107 % → 34 %; pool wait 159 ms → 0.01 ms
                 1 000 robots: 100 % auth, 24/24 assignments, 256 ms e2e
                 2 000 robots: the edge — assignment collapses first
                 Same-machine clustering and PgBouncer both made it WORSE

NOT PROVEN       Multi-machine horizontal scale · any priced number · simulator fidelity
NOT PRESENT      Machine learning of any kind (ADR-14 forbids a learned policy)
NOT REPRESENTED  Physical hardware · firmware · GPS driver · containers · Kubernetes

THE PRINCIPLE    Make it impossible to be wrong quietly.
                 TRUTH > COMPLETENESS > PRESENTATION.
```

---

**Companion document: [`ARCHITECTURE.md`](ARCHITECTURE.md).**
**Architectural authority: `NEXT_GENERATION_ASSIGNMENT_ENGINE.md`.**
**Programme status: [`docs/phase15/PHASE_15_MASTER.md`](docs/phase15/PHASE_15_MASTER.md).**
**This edition's predecessor: [`docs/history/handbook-snapshot-2026-08-11.md`](docs/history/handbook-snapshot-2026-08-11.md).**

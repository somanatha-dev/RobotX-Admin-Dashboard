# RobotX at Scale — Target Architecture for 10 Million Concurrent Robots

> Companion document to [`system.md`](./system.md). That document describes what RobotX **is today** (a single-process Node.js app, one Postgres instance, one Redis instance, Socket.IO for everything). This document describes what it **must become** to run 1 crore (10,000,000) robots simultaneously delivering, plus a continuously-queued backlog of customer orders, 24/7, in production, at industry standard. It is a target-state design + a phased path to get there — not a rewrite mandate.
>
> Every number in this document is a back-of-envelope estimate derived from the current codebase's own constants (e.g. the 2-second telemetry tick in `Backend/src/simulation/constants.js`), used to make the scale visceral and to justify each design decision. Treat the arithmetic as "this is the right order of magnitude," not as a precise capacity plan — do real load testing before trusting any number here for a purchase order.

---

## Table of Contents

1. [Direct Answer: Microservices Is Necessary, Not Sufficient](#1-direct-answer-microservices-is-necessary-not-sufficient)
2. [Scale Math: What "1 Crore Robots, All Busy" Actually Means](#2-scale-math-what-1-crore-robots-all-busy-actually-means)
3. [Target Reference Architecture](#3-target-reference-architecture)
4. [Component-by-Component Deep Dive](#4-component-by-component-deep-dive)
5. [Proposed Service Catalog](#5-proposed-service-catalog)
6. [Consistency, Concurrency & Correctness at Scale](#6-consistency-concurrency--correctness-at-scale)
7. [Reliability Engineering](#7-reliability-engineering)
8. [Security for Production / Industry Level](#8-security-for-production--industry-level)
9. [Observability Stack](#9-observability-stack)
10. [DevOps, CI/CD & Deployment Strategy](#10-devops-cicd--deployment-strategy)
11. [Capacity Planning & Cost-Estimation Method](#11-capacity-planning--cost-estimation-method)
12. [Production-Readiness / Go-Live Checklist](#12-production-readiness--go-live-checklist)
13. [Phased Migration Roadmap](#13-phased-migration-roadmap)
14. [Summary Decision Table](#14-summary-decision-table)

---

## 1. Direct Answer: Microservices Is Necessary, Not Sufficient

Yes — but "microservices" by itself is the wrong unit of analysis. Splitting the current monolith into 12 services that all still talk to one Postgres instance and one Redis instance synchronously would fall over at 10M robots just as fast as the monolith does, only with more network hops in between. The three things that actually make 10M robots survivable are:

1. **Geo-sharding** — no service should ever hold or reason about "all 10M robots" at once. Every hot-path operation (telemetry write, allocation, obstacle check, dashboard query) must be scoped to a geographic cell from the start. This is the single most important architectural decision in this document — get this wrong and nothing else matters.
2. **A streaming backbone (Kafka-class), not synchronous request/response, for anything device-originated.** Telemetry, obstacle reports, and task completions arrive as an unbounded, bursty, multi-million-events/second stream — that's an ingestion problem, not an API-call problem.
3. **Decoupling "hold the connection" from "process the data."** A device gateway's only job is terminating 10M persistent connections and relaying bytes to/from the stream. It must never touch a database, call Mapbox, or run allocation logic — if it does, one slow downstream call stalls a gateway node holding tens of thousands of unrelated devices.

Microservices is the *packaging* that lets you scale, deploy, and own these three things independently. It is the right call — but only once it's built around geo-sharding and streaming, not as a goal in itself.

---

## 2. Scale Math: What "1 Crore Robots, All Busy" Actually Means

Grounding every recommendation below in real numbers, using the current system's own constants as the baseline (`system.md` §8–9):

| Metric | Current design (1 process) | At 10,000,000 robots, all `ACTIVE` |
|---|---|---|
| Telemetry interval | 2s per robot (`TELEMETRY_INTERVAL_MS`) | unchanged — it's a property of the robot, not the backend |
| **Telemetry ingestion rate** | trivial at demo scale | **10,000,000 ÷ 2 = 5,000,000 events/sec, sustained, 24/7** |
| Payload size (JSON: robotId, lat, lon, battery, speed, status, heading, distanceTravelled) | ~150–250 bytes | ~200 bytes average |
| **Raw ingress throughput** | negligible | **5,000,000 × 200B ≈ 1 GB/s ≈ 8 Gbps**, before WebSocket/TLS framing overhead |
| Postgres writes per telemetry tick (current: 1 read + 1 write, `system.md` §8 step 5 & 10) | fine for a handful of robots | **10,000,000 queries/sec** *just for reads*, another 10M/sec for writes — a well-tuned single Postgres instance tops out somewhere around 10,000–50,000 simple queries/sec. **The current per-tick DB write pattern is 200–1000× over capacity.** This isn't an optimization nice-to-have at this scale — it is a hard architectural blocker. |
| Redis ops per telemetry tick (current: 1 registry write + 1 live-state write, `system.md` §8 step 9 & 12) | fine | **10–15 million ops/sec** — a single Redis node tops out somewhere around 100,000–200,000 ops/sec even pipelined. Needs sharding across many dozens of shards *at minimum*, and the current "2 keys written per tick for the same data" duplication (`system.md` §14 #15) doubles this for no benefit. |
| Concurrent persistent connections | a few dozen in dev | **10,000,000** — a single Node.js process realistically holds ~50,000–100,000 WebSocket connections before event-loop and memory pressure degrade it. That's **100–200 separate gateway processes** just to hold the connections, before any processing happens. |
| Task/order throughput (assume ~20 min average delivery cycle → ~3 completions/robot/hour) | a handful/hour in dev | **10,000,000 × 3 ÷ 3600 ≈ 8,300 task completions/sec sustained**, *before* counting the backlog of queued-but-unassigned customer orders on top of that — realistically the allocation service needs sustained five-figures-per-second decision throughput with burst headroom well above that. |
| Third-party routing API calls (current: 2 Mapbox Directions calls per assignment + Matrix batches for candidate scoring) | fine at demo volume | At ~8,300+ assignments/sec × 2+ calls each, this is **tens of thousands of external HTTP calls/sec** to Mapbox — infeasible on both rate-limit and cost grounds. A hosted third-party routing API cannot be the routing engine at this scale; it must be self-hosted (§4.6). |

**The conclusion these numbers force**: nothing about the current single-process, single-Postgres-instance, per-tick-synchronous-write design (documented in full in `system.md` §3, §8) can be *tuned* into surviving this scale. It has to be *replaced* at the architecture level for the hot path, while the parts that were already well-designed (DTARO's cost-function *shape*, the restart-recovery philosophy, the multi-tier Redis-fallback instinct) carry forward conceptually into the new design.

---

## 3. Target Reference Architecture

```mermaid
flowchart TB
    subgraph Devices["10,000,000 Robots (edge)"]
        R[Robot MQTT/gRPC client]
    end

    subgraph EdgeLayer["Edge / Gateway Tier — stateless, horizontally scaled"]
        GW[Device Gateway Nodes\nMQTT broker cluster / gRPC stream terminators]
        DGW[Dashboard Gateway\nWebSocket fan-out, viewport-scoped]
    end

    subgraph Bus["Streaming Backbone"]
        KAFKA[(Kafka / Pulsar\npartitioned by geo-cell)]
    end

    subgraph Core["Core Services — geo-sharded, independently scaled"]
        ING[Telemetry Ingestion Service]
        REG[Robot Registry Service\n(sharded hot-state cache)]
        INTAKE[Order Intake Service]
        ALLOC[Allocation / Dispatch Service\n(DTARO, per-geo-cell workers)]
        ROUTE[Routing Service\n(self-hosted OSRM/Valhalla cluster)]
        EKB[Obstacle/EKB Service\n(spatial index)]
        CMD[Command Dispatch Service]
        IDENT[Device Identity Service]
    end

    subgraph Data["Data Tier"]
        HOT[(Hot: Redis Cluster / in-memory grid\nsharded by geo-cell)]
        WARM[(Warm: Distributed SQL\nCockroachDB/YugabyteDB or sharded Postgres)]
        COLD[(Cold: Columnar warehouse\nClickHouse/BigQuery, fed by stream)]
        GEO[(Geo index: PostGIS / H3-backed store)]
    end

    R <--MQTT/gRPC--> GW
    GW --> KAFKA
    KAFKA --> ING --> HOT
    ING --> COLD
    ING --> REG
    INTAKE --> KAFKA
    KAFKA --> ALLOC
    ALLOC <--> REG
    ALLOC --> ROUTE
    ALLOC --> WARM
    ALLOC --> CMD --> GW --> R
    KAFKA --> EKB --> GEO
    EKB --> CMD
    DGW <--viewport-scoped subscribe--> KAFKA
    IDENT --> GW
```

**Reading this diagram**: the device gateway and dashboard gateway are deliberately separate services with completely different scaling profiles (10M low-value, high-frequency connections vs. a few thousand high-value, moderate-frequency connections) — conflating them, as the current single Socket.IO server does (`system.md` §7), is itself a scaling mistake independent of raw volume.

---

## 4. Component-by-Component Deep Dive

### 4.1 Device Connectivity Layer

**Recommendation: MQTT for robot-to-cloud, not Socket.IO.** Socket.IO/WebSocket is a fine choice for a few thousand browser dashboards; it is not the tool the industry uses for millions of constrained IoT-style devices. MQTT brokers (EMQX, VerneMQ, HiveMQ) and managed equivalents (AWS IoT Core, Azure IoT Hub, Google Cloud IoT) are purpose-built and benchmarked for tens to hundreds of millions of concurrent device connections, with:
- QoS levels (at-most-once for high-frequency telemetry where an occasional dropped frame is fine; at-least-once for obstacle reports/task completion where it isn't).
- Built-in last-will-and-testament (automatic "robot went offline ungracefully" signaling — replaces the current 10-second polling offline-detector, `system.md` §7).
- Topic-based pub/sub with wildcard subscriptions, natural fit for per-robot command topics (`robot/{id}/command`) and per-cell telemetry topics (`telemetry/{geoCell}/{id}`).
- Persistent sessions so a robot that reconnects after a network blip resumes exactly where message delivery left off, without a bespoke session-token/pairing scheme reinvented per project (replaces `system.md` §6's `session:{robotId}`/`pairing:{robotId}` Redis keys).

Keep a WebSocket (or Socket.IO) layer, but scope it *only* to the dashboard/operator side, where connection counts are small and the existing real-time UX patterns (`system.md` §12) are worth preserving.

**Gateway sizing**: with ~50–100k connections per gateway node as a realistic ceiling, 10M devices need on the order of 100–200 gateway nodes, run as a stateless, horizontally-autoscaled fleet behind a Layer-4 load balancer with connection-aware (not simple round-robin) distribution. Gateways hold no business state — a gateway process dying should only cost the reconnect time of the devices attached to it, not any data.

### 4.2 Telemetry Ingestion & Streaming Backbone

Every telemetry frame lands on a Kafka (or Apache Pulsar) topic **partitioned by geo-cell** (H3 or S2 cell ID derived from lat/lon, or a geohash prefix), not by robot ID hash — this is what lets the allocation and obstacle services downstream consume only the slice of the world they're responsible for, instead of filtering a global stream.

Consumers of this stream, each independently scaled:
- **Telemetry Ingestion Service** — validates, enriches (zone lookup, status-transition check — logic that already exists and is *correct* in `telemetry.handler.js`, it just needs to move from "runs inline per HTTP-adjacent socket handler" to "runs as a stream consumer"), writes to the hot store.
- **Cold-path consumer** — batches and lands raw telemetry into the columnar warehouse for historical analytics/compliance, completely decoupled from the hot path so analytics load can never back-pressure live operations.
- **Sampling, not universal persistence** — the current "smart snapshot" throttle (`system.md` §8 step 11 — only store a `Telemetry` row on ≥15s elapsed / meaningful movement / battery delta) is exactly the right *idea*; at this scale, push it further: most ticks for a "cruising normally" robot never need to leave the hot cache at all. Persist to warm/cold storage only on state transitions, anomalies, or a coarse heartbeat (e.g. once every 30–60s per robot even if unchanged, for liveness auditing).

### 4.3 Hot State Store (Robot Registry)

Replace the current dual `registry:{robotId}` / `robot:{robotId}` Redis-key duplication (`system.md` §14 #15) with **one canonical hot-state document per robot**, in a **Redis Cluster (or a purpose-built in-memory grid like Aerospike/ScyllaDB-in-memory-mode) sharded by geo-cell**, so:
- A query for "candidates near this pickup point" is a query against one shard (or a small, known set of neighboring shards), not a scatter-gather across the entire fleet.
- Write load is naturally distributed — a hot delivery corridor's shard sees more traffic than a quiet suburb's shard, which is fine, because shards are independently scalable.
- Memory footprint is manageable: 10M robots × ~500 bytes of hot state ≈ 5GB, comfortably held across a modest cluster — the constraint here is *write throughput*, not storage size, which is exactly why sharding (spreading writes across nodes) matters more than compression.

### 4.4 Order/Task Intake & Queueing

Customer orders land on an **Order Intake Service** that does the minimum possible synchronously (validate, assign an idempotency key, persist `PENDING`, ack the customer) and publishes an event to a **priority-aware queue** (Kafka topic per priority tier, or a broker with native priority support like RabbitMQ/SQS FIFO+priority patterns) for the allocation service to consume. This mirrors the current system's already-correct instinct (`system.md` §5.2 — return the HTTP response fast, do the heavy DTARO work in the background) but replaces `setImmediate()` (in-process, lost on crash) with a durable, replayable queue (survives process death, can be replayed, can be monitored for depth/backlog).

**Idempotency is not optional at this volume** — any client-side retry (mobile app flaky network, etc.) must not create a duplicate order. Every intake request carries a client-generated idempotency key; the intake service deduplicates against it before publishing.

**Backpressure and backlog**: "much more customers who have queued their orders" than can be instantly served is the expected steady state, not a failure mode — the queue depth *is* the backlog, and the system must expose it (§9) and handle it gracefully: a customer-facing "your order is queued, estimated wait: N minutes" experience, not silent request timeouts.

### 4.5 Geo-Sharded Allocation (DTARO at Scale)

This is the most important rework, because it's where the current design's known race condition (`system.md` §14 #5) stops being a rare edge case and becomes a near-certainty under load. The fix is architectural, not a bigger lock:

- **Partition the operating area into cells** (H3 hexagons are the industry-standard choice here — used by Uber, who open-sourced H3 for exactly this purpose). Each cell has a bounded number of robots and a bounded task arrival rate.
- **One allocation worker owns each cell (or a small group of cells) at a time** — a single-writer-per-partition model (an "actor" per cell), so within a cell, task-to-robot matching decisions are naturally serialized and the current "two tasks pick the same robot" race (`system.md` §14 #5) cannot happen *within* a cell by construction, with zero extra locking overhead. Ownership is assigned/rebalanced via a partition-assignment mechanism (Kafka consumer groups naturally provide this if the topic is partitioned by cell).
- **Batch, don't stream, the matching decision itself**: instead of assigning one task the instant it arrives (current design), collect orders arriving in a short window (e.g. 500ms–2s) per cell and solve a local matching problem across all pending orders and available robots in that window (a greedy nearest-cost match is fine at small batch sizes; a proper bipartite assignment/Hungarian-style solver improves global cost if batch sizes grow). This is exactly how large-scale ride-hailing dispatch systems avoid both races and myopic single-task greediness.
- **Cross-cell overflow**: if a cell has no eligible robots (all busy/low battery), the batch matcher escalates the search radius to neighboring cells before failing — this also finally gives the system an answer to the current "no retry against the next-best candidate" gap (`system.md` §14 #5) at any scale, not just within one cell.
- **The cost function itself carries forward** — `C(r) = w1·D + w2·(1−B) + w3·U + w4·T` (`system.md` §5.1) is a sound multi-criteria model; it just needs U (utilization) actually wired up (`system.md` §14 #6, the dead `simulation.service.js` code already has a working implementation to port) and a genuine zone/cell-locality term (§14 #7) — which, at this scale, is now *structurally* enforced anyway, since the candidate pool is already cell-scoped before the cost function ever runs.

### 4.6 Routing Engine — Self-Hosted, Not a Third-Party API

At 8,000+ assignments/sec each needing 1–2+ routing calls, a metered third-party API (Mapbox) is not viable on cost or rate-limit grounds. Run a **self-hosted routing cluster** (OSRM, Valhalla, or GraphHopper — all open-source, all designed for exactly this: high-QPS road-network routing against a pre-processed regional road graph) fed by an offline OpenStreetMap (or licensed map data) build, horizontally scaled behind the Routing Service, with regional graph partitions matching your geo-cell/region boundaries. Keep a hosted API as a *fallback* for regions not yet covered by self-hosted data, not as the primary path — inverting the current system's arrangement (`system.md` §5.4, §10).

### 4.7 Obstacle/EKB at Scale

The current "test every robot's path against every new obstacle" approach (`system.md` §10, `routeIntersection.service.js`) is O(robots) per obstacle — fine for hundreds of robots, not for millions. Replace the full linear scan with a **spatial index** (PostGIS geometry index, or an H3-cell-keyed lookup: "which robots have a planned-path segment passing through cell X" maintained incrementally as paths are assigned) so an obstacle report only needs to check robots whose paths intersect the *same or neighboring cells* as the obstacle — turning an O(n) scan into an O(cell-local) lookup, the same geo-sharding principle applied consistently.

### 4.8 Command Dispatch & Reliability

Replace both of the current system's competing in-memory retry mechanisms (`system.md` §14 #16) with **one durable, queue-backed command-delivery service**: a command is a persisted, at-least-once-delivered message (via the MQTT broker's own QoS1/2 guarantees, or an explicit outbox pattern against the warm store) with a single source of truth for ACK state — not two independent `setTimeout` chains that both silently die on process restart.

### 4.9 Dashboard/Operator Realtime Layer

An operator dashboard **cannot** and **should not** try to display 10,000,000 live markers — no human can parse that, no browser can render it, and no reasonable network budget supports pushing that much live data to a browser tab. The dashboard's data-access pattern must fundamentally change from "give me all robots" (`system.md` §13, current `GET /api/robots/state`) to:
- **Viewport-scoped subscriptions** — the client tells the server "I'm looking at this bounding box at this zoom level," and the server streams only robots within it (mirroring exactly how Google Maps/Uber's own ops dashboards work), backed by the same geo-cell index as everything else.
- **Server-side clustering at low zoom** — at city/country zoom, show aggregated counts/heatmaps per cell, not individual markers, only "unclustering" to individual robots once the viewport is tight enough that the count is human-scale (tens to low hundreds).
- **Fleet-wide KPIs (online count, active count, low-battery count — `system.md` §13's Dashboard page) computed as continuously-maintained aggregates** (streamed rollups from the ingestion pipeline), never as a client-side `.filter()` over a full fleet array like the current `DashboardPage.jsx` does.

### 4.10 Data Tiering Strategy

| Tier | Technology | What lives here | Consistency needs |
|---|---|---|---|
| **Hot** | Redis Cluster / in-memory grid, geo-sharded | Live robot position/battery/status/plannedPath — anything read on every allocation decision or dashboard tick | Eventual consistency acceptable (this is exactly the current system's already-correct instinct, `system.md` §6, just made to scale) |
| **Warm** | Distributed SQL (CockroachDB, YugabyteDB, or Postgres + Citus sharding) | Robot/Task/Command canonical records, anything needing transactions (task assignment, currentTaskId uniqueness) | **Strong consistency required** — this is where the allocation race (§4.5, §6) must never be allowed to produce a double-assignment |
| **Cold** | Columnar warehouse (ClickHouse, BigQuery, Snowflake) | Full telemetry history, completed task archive, obstacle history, audit events | Append-only, eventually consistent, optimized for analytical queries over billions of rows — never queried on the hot path |
| **Geo index** | PostGIS or H3-keyed store | Zone boundaries, cell→robot membership, cell→obstacle membership | Needs to be fast and roughly current, not perfectly real-time |

---

## 5. Proposed Service Catalog

| Service | Responsibility | Scaling unit | Data owned |
|---|---|---|---|
| Device Gateway | Terminate MQTT/gRPC device connections, relay to/from stream | Per connection count | None (stateless) |
| Dashboard Gateway | Viewport-scoped WebSocket fan-out to operators | Per viewer count (small) | None (stateless) |
| Device Identity Service | Certificate/token issuance, device provisioning, pairing | Per provisioning request rate | Device credentials (warm store) |
| Telemetry Ingestion Service | Consume telemetry stream, validate, enrich, write hot+cold | Per geo-cell partition | None (writes to hot/cold stores) |
| Robot Registry Service | Query API over hot state; the *only* place that reads/writes robot live state | Per geo-cell shard | Hot store |
| Order Intake Service | Accept customer orders, idempotency, publish to queue | Per request rate | Order records (warm store) |
| Allocation/Dispatch Service (DTARO) | Geo-cell-scoped batched matching | Per geo-cell partition (one owner per cell) | Reads registry + warm store, writes task assignment |
| Routing Service | Self-hosted road-network routing + travel-time estimation | Per region (matches routing graph partitions) | Routing graph data |
| Obstacle/EKB Service | Spatially-indexed obstacle store + affected-robot lookup | Per geo-cell | Geo index + obstacle records |
| Command Dispatch Service | Durable, ACKed command delivery to devices | Per command volume | Command/outbox records (warm store) |
| Admin/Auth Service | Operator auth, RBAC, PIN/passkey (done properly — see `system.md` §11's Passkey findings), audit | Per operator count (small) | User/session records |
| Analytics/Reporting Service | Stream consumer into the warehouse, scheduled aggregates | Per stream volume | Cold store |

Each of these is independently deployable, independently scaled, and — critically — **owns its own data**; no service reaches into another service's database directly (a discipline the current monolith doesn't need yet but a microservice split absolutely must enforce from day one, or it degrades into a "distributed monolith" that's harder to operate than the monolith it replaced).

---

## 6. Consistency, Concurrency & Correctness at Scale

- **Task assignment is the one place strong consistency is non-negotiable.** A robot must never be double-assigned. The geo-cell single-writer pattern (§4.5) removes the race *within* a cell structurally; the warm store's transaction (the existing `currentTaskId` uniqueness check, `system.md` §5.4, is the right mechanism) is the last-line defense across cell boundaries or during rebalancing.
- **Everything else can be eventually consistent.** Telemetry position being a few hundred milliseconds stale on a dashboard, or a battery reading lagging by a couple of seconds, has no correctness impact — treating these with the same rigor as task assignment is exactly the kind of unnecessary synchronous coupling that makes the *current* per-tick design so expensive (`system.md` §8, §14 #18).
- **Idempotency keys everywhere a client can retry**: order creation, command issuance, telemetry frames (a device reconnecting after a network blip must not double-count `distanceTravelled` or replay a stale position as current).
- **Exactly-once is a myth at this scale; design for at-least-once + idempotent consumers instead** — this is standard streaming-systems practice (Kafka itself only guarantees at-least-once/at-most-once depending on configuration) and is the correct target, not a compromise.
- **Explicit CAP choice per subsystem**, stated up front rather than discovered under incident pressure: hot state = AP (availability over strict consistency), task assignment = CP (consistency over availability — briefly refusing a new assignment during a partition is safer than double-assigning a robot).

---

## 7. Reliability Engineering

- **Circuit breakers** around every external dependency (routing engine, payment/billing if applicable, any third-party API) — fail fast and degrade (e.g. fall back to haversine-only cost scoring, exactly as the current system already does for Mapbox, `system.md` §5.3) rather than letting a slow dependency exhaust connection pools upstream.
- **Bulkheads** — the device gateway tier must be resource-isolated from the allocation tier from the dashboard tier; a burst on one must not starve another (this is a direct consequence of splitting into services with owned resources, §5).
- **Retries with exponential backoff + jitter** on all inter-service calls, bounded (never infinite), with a dead-letter topic/queue for messages that exhaust retries — visible and alertable, not silently dropped (a direct fix for the current system's fire-and-forget command retries, `system.md` §14 #16).
- **Backpressure is a first-class signal**, not an afterthought: queue depth, consumer lag, and gateway connection saturation all feed autoscaling (§10) and alerting (§9) directly.
- **Graceful degradation modes, planned in advance**: Redis cluster partially down → hot-state reads fall back to warm store with higher latency (extending the current system's already-good multi-tier-fallback instinct, `system.md` §6, §15); routing engine down → haversine-only scoring; allocation service backlogged → customers see an honest queued-ETA instead of a silent failure.
- **Chaos engineering before go-live and continuously after** — fault injection (Chaos Mesh, Gremlin, or cloud-native equivalents: kill a gateway node, partition a Redis shard, inject routing-service latency) run as scheduled "game days," not just theoretical readiness.
- **Explicit SLOs/SLIs and error budgets** — e.g. "telemetry ingestion p99 latency < 2s," "allocation decision p95 < 3s," "assignment success rate > 99.5%" — with alerting on error-budget burn rate, not just raw thresholds.
- **Multi-AZ minimum, multi-region for anything serving a national/global fleet** — define RPO/RTO targets explicitly and test failover, don't assume it works because it's configured.

---

## 8. Security for Production / Industry Level

- **Device identity via certificates, not pairing codes.** The current 6-digit pairing-code + session-token scheme (`system.md` §6, §11) is fine for a handful of demo robots; at 10M devices it needs a real **Device Provisioning Service** issuing per-device X.509 certificates (or hardware-backed keys where the robot's compute module supports a TPM/secure element), with mutual TLS to the gateway tier — the same model AWS IoT Core / Azure IoT Hub use, for the same reason.
- **Close the REST-auth gap identified in `system.md` §11/§14 #1 before any of this matters** — it's just as critical at 10 robots as at 10M; scale doesn't change that priority, it just makes the blast radius of leaving it open catastrophically larger.
- **Fix or remove the client-side-only Passkey flow** (`system.md` §11, §14 #25) — a fake step-up control is a liability at any scale, and industry-level deployments will be audited against exactly this kind of gap.
- **mTLS between all internal services**, ideally via a service mesh (Istio, Linkerd) that also gives you retries/circuit-breaking/observability "for free" at the infrastructure layer rather than reimplementing them per-service.
- **Secrets management via Vault or a cloud KMS** — no hardcoded credentials in the repository (directly closes `system.md` §14 #27, the committed default PIN).
- **API gateway with WAF and DDoS protection at the edge** — 10M internet-facing device connections is a very large attack surface; rate limiting, request validation, and DDoS mitigation (Cloudflare, AWS Shield, or equivalent) belong at the edge, not hoped for from application-level rate limiters alone (the current in-memory rate limiters, `system.md` §7/§14 #19, don't survive horizontal scaling anyway).
- **Least-privilege network policies** between services (Kubernetes NetworkPolicies or the mesh's equivalent) — a compromised dashboard-gateway pod should not be able to reach the warm database directly.
- **Audit logging that's actually queryable** — extend the existing `Event` table concept (`system.md` §4, §13) into the cold-tier warehouse so security/compliance queries don't compete with operational load.

---

## 9. Observability Stack

- **Metrics**: Prometheus (or a managed equivalent) scraping every service; Grafana dashboards built around the **four golden signals** per service (latency, traffic, errors, saturation) plus domain-specific ones (telemetry ingestion lag, allocation queue depth, assignment success rate, DTARO cost distribution — finally making real use of the currently-inert `metrics:allocation:*` concept from `system.md` §14 #11).
- **Distributed tracing**: OpenTelemetry instrumentation across every service, exported to Jaeger/Tempo/equivalent — essential once a single task-assignment flow spans 5+ services (intake → queue → allocation → routing → command dispatch); without tracing, debugging a slow assignment becomes archaeology.
- **Centralized logging**: structured JSON logs (the current logger, `system.md` §2, already produces this in production mode — good foundation) shipped to a central store (Loki, ELK) with correlation IDs threading a single order/task through every service's logs.
- **Alerting**: burn-rate alerts on SLO error budgets (§7), queue-depth alerts, gateway-connection-saturation alerts, and a documented on-call rotation with runbooks per alert — an alert with no runbook is just anxiety.
- **A genuine "fleet health" status surface** — extending the already-identified gap in `system.md` §16 #8 (no degraded-mode indicator in the UI) into a proper internal status page showing per-region/per-cell health, not just a binary up/down.

---

## 10. DevOps, CI/CD & Deployment Strategy

- **Infrastructure as Code**: Terraform (or Pulumi) for all cloud infrastructure — no manually-clicked resources, ever, at this scale.
- **Container orchestration**: Kubernetes, with each service in §5 as its own Deployment, resource requests/limits set from actual load-test data (not guessed), and Pod Disruption Budgets so rolling deploys never drop below safe capacity for the device gateway tier especially.
- **Autoscaling on the right signal** — CPU-based HPA is the wrong metric for a queue-consumer service; use KEDA (or custom-metrics HPA) scaling the allocation service on **queue depth/consumer lag**, and the gateway tier on **connection count**, not CPU.
- **GitOps**: ArgoCD or Flux reconciling cluster state from a Git repository — deployments are a `git merge`, not a manual `kubectl apply`, giving you an audit trail and trivial rollback.
- **CI pipeline**: lint → unit tests → integration tests → container build → image vulnerability scan (Trivy/Grype) → SAST/dependency scan — on every PR, blocking merge on failure.
- **CD pipeline**: canary or blue-green deployment with automated rollback tied to the SLOs in §7 (e.g. auto-rollback if error rate or p99 latency regresses past a threshold during the canary window) — never a big-bang deploy to 100% of the allocation service, given how sensitive that logic is to subtle bugs.
- **Feature flags** (LaunchDarkly, Unleash, or OpenFeature) for anything touching the allocation cost function or matching batch window — the ability to instantly revert a bad weight change without a redeploy is worth building in from day one, given `system.md` §16 #5 already flags cost-weight tuning as something operators will want to do live.
- **Zero-downtime schema migrations** on the warm store — expand/contract pattern (add nullable column → backfill → make required → drop old column, each as a separate deploy), never a blocking `ALTER TABLE` on a table with 10M+ rows; use online-schema-change tooling appropriate to whichever distributed SQL engine is chosen.
- **Environment strategy**: dev → staging (production-like, ideally seeded with production-scale synthetic load, not just a handful of demo robots) → production, with the staging environment specifically used to validate load behavior *before* it's discovered in production.
- **Load testing as a release gate**, not a one-time exercise: k6, Locust, or Gatling scripts simulating realistic telemetry/order arrival patterns at target scale, run against every release candidate before it reaches production.

---

## 11. Capacity Planning & Cost-Estimation Method

A lightweight framework for sizing any component, illustrated with telemetry ingestion:

1. **Peak event rate** = robot count ÷ telemetry interval (§2: 5M/sec at 10M robots).
2. **Per-partition throughput ceiling** for the chosen technology (e.g. a Kafka partition realistically sustains low-tens-of-MB/sec) → **partition count** = total throughput ÷ per-partition ceiling.
3. **Broker count** = partition count × replication factor ÷ partitions-per-broker comfortably handled (consult the chosen technology's own benchmarks — don't extrapolate from a laptop test).
4. **Consumer count** = event rate ÷ (per-consumer processing rate, measured from an actual load test of the ingestion service's real per-event work, not assumed).
5. **Repeat the same four steps for every hot-path component** (gateway connections, allocation decisions/sec, routing calls/sec, hot-store ops/sec) — the number that matters is always *this event/request rate ÷ this technology's measured per-unit ceiling*, never a guess.
6. **Cost** falls out of the resulting node/instance counts × the cloud provider's pricing for that instance class — do this exercise **before** committing to a cloud provider or instance family, since the gap between "cheap but low per-node ceiling" and "expensive but high per-node ceiling" compounds enormously at 10M-robot scale.

Build this into a living spreadsheet/model tied to real load-test results, updated every time a load test is re-run — capacity planning done once at design time and never revisited is capacity planning done wrong.

---

## 12. Production-Readiness / Go-Live Checklist

**Security**
- [ ] Every state-changing REST/gRPC endpoint requires authentication (closes `system.md` §14 #1)
- [ ] Device identity uses certificates/hardware-backed keys, not shared pairing codes, at fleet scale
- [ ] Passkey/step-up auth is either real (server-verified) or removed (`system.md` §14 #25)
- [ ] No hardcoded credentials anywhere in source control (`system.md` §14 #27)
- [ ] Secrets in Vault/KMS, rotated on a schedule
- [ ] mTLS between all internal services
- [ ] WAF + DDoS protection at the edge
- [ ] Dependency and container image scanning in CI, with a policy for acting on findings

**Reliability**
- [ ] SLOs defined and instrumented for every hot-path flow (ingestion, allocation, command delivery)
- [ ] Circuit breakers on every external/inter-service call
- [ ] Dead-letter queues on every consumer, with alerting on DLQ depth
- [ ] Chaos/game-day exercises run against a staging environment at realistic scale
- [ ] Documented, tested failover procedure with measured RTO/RPO
- [ ] Load testing at target scale is a release gate, not a one-time exercise

**Data**
- [ ] Geo-sharding strategy chosen and applied consistently across every service (§4)
- [ ] Backup and point-in-time-recovery tested (not just configured) for the warm store
- [ ] Data retention/archival policy defined for cold-tier telemetry history
- [ ] Zero-downtime migration tooling in place for the warm store's schema evolution

**Operations**
- [ ] Centralized metrics, tracing, and logging wired for every service before go-live, not added reactively after the first incident
- [ ] On-call rotation staffed with runbooks for every defined alert
- [ ] Autoscaling validated against real queue-depth/connection-count signals, not just CPU
- [ ] Canary/blue-green deployment pipeline proven on a non-critical service first

**Product/Business**
- [ ] Customer-facing behavior for "your order is queued" defined and tested — the backlog is a normal operating state at this scale, not an error (§4.4)
- [ ] Dashboard redesigned around viewport-scoped queries and clustering — "list all 10M robots" is not a feature that can exist at this scale (§4.9)
- [ ] Cost model validated against real load-test-derived capacity numbers (§11) before committing to a cloud spend

---

## 13. Phased Migration Roadmap

This is not a rewrite. The current system's core ideas (the DTARO cost function's shape, the restart-recovery philosophy, the multi-tier Redis fallback instinct — all praised in `system.md` §15) carry forward; what changes is how they're scaled and packaged. Suggested phased order, each phase independently shippable and each building directly on the fixes already prioritized in `system.md` §17:

1. **Phase 0 (prerequisite, do regardless of scale target)**: close the security gaps that are severe at *any* scale — REST auth (`system.md` §14 #1), the fake Passkey flow (#25), the hardcoded PIN (#27), the unauthenticated telemetry-bind path (#26). None of the scale work below is worth doing on top of an insecure foundation.
2. **Phase 1 — introduce geo-sharding conceptually, still on current infra**: add an H3/geohash cell ID to every robot and obstacle, scope the existing allocation query and obstacle-intersection check to same/neighboring cells instead of the full fleet, even before moving to a distributed architecture — this alone fixes the O(n) obstacle scan (`system.md` §14, obstacle section) and shrinks the allocation candidate pool, buying real headroom on the current single-Postgres-instance setup.
3. **Phase 2 — decouple telemetry ingestion from synchronous per-tick DB writes**: introduce a stream (Kafka, or Redis Streams as a smaller first step) between the device gateway and the database write path, batch-flushing to Postgres instead of writing per-tick (`system.md` §14 #18) — this is the highest-leverage single change for surviving fleet growth before any other re-architecture.
4. **Phase 3 — split the device gateway out as its own horizontally-scaled service**, evaluate MQTT migration for the device side specifically, keep Socket.IO for the dashboard side.
5. **Phase 4 — introduce the geo-cell single-writer allocation pattern** (§4.5, §6) properly, replacing the current best-effort transaction-recheck approach with structural race-freedom — this is also where the dead `simulation.service.js` utilization-tracking logic (`system.md` §9.1, §14 #6) should finally be ported into the live path.
6. **Phase 5 — move the warm store to a distributed SQL engine** (Citus-sharded Postgres is the least disruptive first step, since it keeps the Postgres/Prisma tooling; CockroachDB/YugabyteDB if a full re-platform is acceptable), and stand up the cold-tier warehouse for analytics, taking that load off the operational database entirely.
7. **Phase 6 — self-host the routing engine**, moving Mapbox from primary to fallback.
8. **Phase 7 — full observability, chaos-testing, and DevOps maturity** (§7–§10) as a continuous practice, not a one-time milestone — this should actually start much earlier and run in parallel with every phase above, not wait until the end.

---

## 14. Summary Decision Table

| Concern | Current (`system.md`) | Target at 10M-robot scale |
|---|---|---|
| Device protocol | Socket.IO for both robots and dashboards | MQTT (device) + Socket.IO/WebSocket (dashboard), separate gateways |
| Telemetry write path | Synchronous per-tick Postgres + Redis writes | Streamed via Kafka, batched/sampled writes, hot store is authoritative for live reads |
| Robot live state | Two duplicate Redis keys per robot | One canonical hot-state document, geo-sharded |
| Allocation scope | All eligible robots fleet-wide, one task at a time | Geo-cell-scoped candidate pool, batched matching, single-writer-per-cell |
| Allocation race safety | Transaction re-check only, losing task fails outright | Structurally race-free within a cell + cross-cell overflow retry |
| Routing | Third-party Mapbox API, synchronous, in the hot path | Self-hosted routing cluster, Mapbox as fallback only |
| Obstacle check | O(n) scan of every robot's path | Spatially-indexed, cell-scoped lookup |
| Command delivery | Two competing in-memory retry loops | One durable, queue/broker-backed delivery mechanism |
| Dashboard data access | Fetch entire fleet, filter client-side | Viewport-scoped subscriptions + server-side clustering |
| Warm data store | Single Postgres instance | Distributed SQL, geo/shard-aware |
| Analytics | None (data accumulates, unread) | Dedicated cold-tier warehouse, streamed continuously |
| Device identity | Pairing code + session token | Certificate-based device identity, hardware-backed where possible |
| Deployment | Manual `node server.js` | Kubernetes + GitOps + canary deploys + autoscaling on real signals |
| Observability | Console/pino logs only | Metrics + tracing + centralized logs + SLO-based alerting |

---

*This document should be read alongside `system.md`, which remains the accurate description of the system as it exists today and the source of every specific flaw/finding referenced above. Update both documents together as the system evolves toward this target.*

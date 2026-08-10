# HISTORICAL — NOT CURRENT ARCHITECTURE

> **This document describes a system that no longer exists, and a plan that was not adopted.**
>
> It is a synthesis of the surviving engineering reasoning from two archived documents:
>
> | Original | Date | Archived as |
> |---|---|---|
> | `scale-architecture.md` | 2026-07-25 | [`legacy-scale-architecture.md`](legacy-scale-architecture.md) |
> | `ARCHITECTURE_PROPOSAL.md` | 2026-07-26 | [`legacy-architecture-proposal.md`](legacy-architecture-proposal.md) |
>
> Both analysed the **legacy DTARO monolith**, whose assignment modules —
> `taskAssignment.service.js`, `costEvaluator.service.js`, `robotValidator.service.js`,
> `taskRecovery.service.js` — have since been **deleted from the repository**. Every file:line
> citation below points at code that is gone.
>
> **Neither document's target architecture was built.** Both proposed a Kafka-partitioned
> multi-service platform. The architecture actually frozen and implemented is different: see
> [`../../NEXT_GENERATION_ASSIGNMENT_ENGINE.md`](../../NEXT_GENERATION_ASSIGNMENT_ENGINE.md) and
> [`../adr/`](../adr/).
>
> **Nothing here is a current guarantee, a current measurement, or a current commitment.**
> For what RobotX is today, read [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md).

**Why this document exists.** These two archived documents contain reasoning that shaped decisions
still binding today — most directly **ADR-11** (self-hosted routing) and **ADR-12** (region
sharding). An ADR records *what* was decided and *what was rejected*; it deliberately does not
restate the argument. This is where the argument survives.

---

## 1. The four blocking properties of the legacy data plane

**Source:** `ARCHITECTURE_PROPOSAL.md` §1.2. Verified against the code at the time, not inferred
from documentation.

The proposal's central claim was that the legacy system's problem was **not insufficient
decomposition**. It was four specific structural properties of the data plane that would make
*any* topology — monolith or microservice — fail at scale. Decomposing before fixing them would
produce a distributed monolith strictly harder to operate than what existed.

| # | Property | Evidence (in code now deleted) | Consequence |
|---|---|---|---|
| **B1** | **Connection-state affinity** — the robot→socket routing table was a process-local `Map` | `sockets/robotSockets.js:5`; consumed by `commandDispatcher.service.js:17`, `robots.controller.js:565`, `tasks.controller.js:109`, `robotValidator.service.js:120` | A second process could not dispatch a command to a robot connected to the first. **Hard blocker on running two instances**, independent of load |
| **B2** | **Global fan-out on the hot path** — every telemetry frame broadcast to *every* connected socket | `telemetry.handler.js:400` — `io.emit("robot:update", …)` | O(N²) amplification. At 10 000 robots: 10 000 robots × 5 000 frames/s ≈ **50 M socket writes/sec** for a workload whose useful payload is 5 000 frames/s |
| **B3** | **Per-robot synchronous datastore round-trips inside the 2-second loop** | `telemetry.handler.js:170` (unconditional `findUnique` per tick); `robot.handler.js:210` (unconditional `robot.update` per HEARTBEAT, emitted every tick by `VirtualRobot.js:457`) | Postgres query rate scaled linearly with fleet size at 1 Hz per robot. Ceiling ≈ 10k–25k robots against a well-tuned single instance, with **zero headroom** |
| **B4** | **No durable work queue** — the allocation pipeline was `setImmediate()` | `task.service.js:371` | A process death between `task.create(PENDING)` and assignment orphaned the order permanently. `taskRecovery.service.js:39` recovered only `ASSIGNED`/`IN_PROGRESS`; **`PENDING` was never recovered by anything** |

B1 and B2 were correctness/architecture blockers. B3 was a capacity blocker. B4 was a durability
blocker. **None of the four is fixed by drawing service boundaries around it.**

### 1.1 How these were actually resolved

Not by the proposal's plan. The frozen architecture addresses each structurally:

| Legacy blocker | Frozen architecture's answer |
|---|---|
| B1 — connection affinity | Region sharding with single-writer-per-shard (**ADR-12**, **ADR-10**) |
| B2 — global fan-out | Room-scoped broadcast (already live in the host platform) |
| B3 — per-tick DB round-trips | Gated Postgres flush on the telemetry path (already live) |
| B4 — no durable queue | Durable per-shard `WorkQueue` + transactional outbox (**ADR-05**, **ADR-27**) |

---

## 2. "Correct in form, dead in effect"

**Source:** `ARCHITECTURE_PROPOSAL.md` §1.3 and `PHASE1_VERIFICATION.md` §0 Round 3 (archived as
[`legacy-phase1-hardening-verification.md`](legacy-phase1-hardening-verification.md)).

This is the most transferable lesson in the archived material, and the reason the current programme
gates on **executable checks rather than careful reading**.

A review pass found three defects that had passed prior inspection — each a feature that was
**correct in form and dead in effect**, invisible to reading:

1. **The DTARO zone-locality term was functionally inert.** `robotRegistry.updateZone()` was
   exported but **called by nothing**. `assignRobotToZone()` updated socket rooms and emitted
   events but never persisted `zoneId` to the Redis registry or the `Robot.zoneId` column. So
   `costEvaluator.service.js:110` evaluated `c.zoneId && c.zoneId === pickupZoneId` against a value
   that was always `null` → `Z = 1` for every candidate → **a constant offset with zero ranking
   effect.** A prior verification had marked this finding *closed*.

2. **A per-tick dashboard broadcast storm, caused by the same defect.** Because `currentZoneId` was
   always `null` while `newZoneId` resolved to a real zone, the guard
   `newZoneId !== currentZoneId` was **true on every telemetry tick**, firing a `socket.join()`
   plus a `ZONE_UPDATED` emit to the dashboard room 0.5×/robot/second, forever.

3. **The telemetry DB-write throttle was defeated by the heartbeat path.** The
   `DB_FLUSH_INTERVAL_MS` gate correctly throttled `robot.update` in the telemetry handler — but
   `VirtualRobot._tick()` emitted `HEARTBEAT` in the *same* 2-second tick, and
   `robot.handler.js:210` issued an **unconditional, ungated `prisma.robot.update`** for every
   heartbeat. Aggregate write volume was unchanged; it had merely moved handlers.

A fourth, noted separately: `kv.reserveRobot()` fell back to a process-local `Map` when Redis was
unavailable, so the allocation lock **silently degraded to a no-op across processes** — voiding the
race fix in exactly the multi-instance deployment it was first needed in.

**All four were subsequently confirmed by executable tests and fixed.** They are retained here
because the *pattern* is the evidence: a specification or review that rests on reading will
certify things that do not work.

> **A correction the original document recorded about itself**, preserved because self-correction
> is part of the evidence: it had also listed `cancelTask` not stopping the robot as an open defect.
> **That was wrong** — the fix was already present. A prior verification had it marked open and the
> claim was carried forward without re-reading the file.

**This lesson is now structural.** The current programme runs six build gates independently of and
*before* its test suites, and four of its tests read the frozen specification from disk and assert
against it, precisely so that a documented guarantee cannot drift from an enforced one.

---

## 3. Routing economics — the argument behind ADR-11

**Source:** `ARCHITECTURE_PROPOSAL.md` §29–§30, `scale-architecture.md` §4.6.

The legacy allocation path called Mapbox synchronously inside assignment:
`getRoutesWithDistance` tried three profiles × two legs, plus a Matrix call — **up to 7 external
HTTP calls per assignment.**

| Fleet | Assignments/sec | External calls/sec |
|---|---|---|
| 100 000 robots @ 3 tasks/hour | ≈ 83 | **≈ 580 sustained** |
| 10 000 000 robots | ≈ 8 300 | **tens of thousands** |

At commercial per-1000-request pricing, the 100k case alone was a **mid-six-figure monthly line
item** — before rate limits made it impossible anyway. Both documents concluded independently that
a metered third-party API **cannot be the routing engine**, and that the open-source candidates
(OSRM, Valhalla, GraphHopper) fed by an offline OpenStreetMap build, with regional graph partitions
matching cell boundaries, were the viable path — with a hosted API demoted to a fallback for
uncovered regions, **inverting** the legacy arrangement where Mapbox was primary and straight-line
interpolation was the fallback.

**This is the reasoning behind ADR-11** — *"Self-hosted with precomputed hierarchies"*, rejecting
*"metered external API in the hot path"*.

**One observation worth carrying:** the anticorruption layer was already most of the way there.
`mapbox.service.js` exposed `directionsWithDistance` / `matrixDurationsToDestination` — consumers
depended on `{points, distanceMeters, durationSec}`, not on Mapbox response shapes. The swap was
genuinely a swap.

> **Current status:** ADR-11 is frozen, but **no routing engine has been selected**, and selection
> is blocked one step earlier — on the region definition (D1). See
> [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) §6.

---

## 4. The 10-million-robot arithmetic

**Source:** `scale-architecture.md` §2.

> ### ⚠️ Read the original caveat first — it is part of the evidence
>
> *"Every number in this document is a back-of-envelope estimate derived from the current
> codebase's own constants (e.g. the 2-second telemetry tick in
> `Backend/src/simulation/constants.js`), used to make the scale visceral and to justify each
> design decision. Treat the arithmetic as 'this is the right order of magnitude,' not as a
> precise capacity plan — do real load testing before trusting any number here for a purchase
> order."*
>
> **These are not measurements. They were never measurements.** They are order-of-magnitude
> reasoning from constants, and they must never be quoted as capacity figures, benchmarks, or
> guarantees.

At 10 000 000 robots, all `ACTIVE`, on the legacy design:

| Metric | Legacy design (1 process) | At 10M robots |
|---|---|---|
| Telemetry interval | 2 s per robot | Unchanged — a property of the robot, not the backend |
| **Telemetry ingestion** | Trivial at demo scale | **5 000 000 events/sec, sustained, 24/7** |
| Payload size | ~150–250 B | ~200 B average |
| **Raw ingress** | Negligible | **≈ 1 GB/s ≈ 8 Gbps**, before WebSocket/TLS framing |
| Postgres writes per tick | Fine for a handful | **10 M queries/sec reads + 10 M/sec writes.** A well-tuned single instance tops out ≈ 10 000–50 000 simple queries/sec — **200–1000× over capacity** |
| Redis ops per tick | Fine | **10–15 M ops/sec.** A single node tops out ≈ 100 000–200 000 ops/sec even pipelined — needs dozens of shards minimum, and the duplicate-key write doubled it for no benefit |
| Concurrent connections | A few dozen in dev | **10 000 000.** A single Node process realistically holds ~50 000–100 000 WebSockets → **100–200 gateway processes** just to hold connections |
| Task throughput | A handful/hour in dev | **≈ 8 300 completions/sec sustained**, before any queued backlog |
| Third-party routing calls | Fine at demo volume | **Tens of thousands of external HTTP calls/sec** — infeasible on rate-limit and cost grounds |

**The conclusion these numbers forced:** nothing about the legacy single-process,
single-Postgres, per-tick-synchronous-write design could be *tuned* into surviving that scale. The
hot path had to be replaced at the architecture level, while the parts that were already
well-designed carried forward conceptually.

---

## 5. The geo-sharding thesis — the argument behind ADR-12

**Source:** `scale-architecture.md` §1.

Asked whether microservices were the answer, the document's reply was *"necessary, but the wrong
unit of analysis"* — splitting a monolith into twelve services that all still talk to one Postgres
and one Redis synchronously falls over just as fast, with more network hops. Three things actually
mattered:

1. **Geo-sharding — no service should ever hold or reason about "all robots" at once.** Every
   hot-path operation — telemetry write, allocation, obstacle check, dashboard query — must be
   scoped to a geographic cell *from the start*. Called out as **"the single most important
   architectural decision in this document — get this wrong and nothing else matters."**
2. **A streaming backbone for anything device-originated**, rather than synchronous
   request/response — telemetry is an ingestion problem, not an API-call problem.
3. **Decoupling "hold the connection" from "process the data"** — a device gateway's only job is
   terminating connections and relaying bytes. It must never touch a database, call a routing API,
   or run allocation logic; if it does, one slow downstream call stalls a node holding tens of
   thousands of unrelated devices.

**Point 1 survived and is now ADR-12** — *"Region sharding exploiting locality"*, rejecting
*"global queue or global optimiser"*. The same principle recurs in **ADR-28** (Region ⊃ zone ⊃
cell) and in the spatial index, where an obstacle report checks only robots whose paths touch the
same or neighbouring cells rather than scanning every robot's path — the legacy `O(robots)`
approach in `routeIntersection.service.js`.

**Points 2 and 3 were not adopted in the proposed form.** No Kafka, MQTT, or device-gateway tier
exists in the repository, and the frozen architecture does not specify one.

---

## 6. What both documents proposed that was NOT built

Recorded so nobody mistakes these for plans in progress:

| Proposed | Status |
|---|---|
| Kafka / Redpanda / Pulsar streaming backbone, partitioned by geo-cell | **Not built.** No broker in the repository |
| MQTT device gateway tier separate from dashboard WebSockets | **Not built** |
| A 12-service catalogue (Device Identity, Live State, Territory, Allocation, Navigation, Read Model, …) with staged extraction | **Not built.** The system remains a single process |
| Kubernetes + GitOps + canary deploys + autoscaling | **Not built** |
| Distributed SQL replacing the single Postgres instance | **Not built** |
| Certificate-based device identity replacing pairing code + session token | **Partially** — `AGENT_MTLS_REQUIRED` exists; the legacy pairing flow is still live |
| Viewport-scoped dashboard subscriptions | **Not built** |
| Cold-tier analytics warehouse | **Not built** |
| Carrying the DTARO cost function `C(r)` forward | **Rejected.** ADR-01 replaced normalised weighted sums with absolute additive cost units and dimensioned exchange rates |

The last row matters most: `scale-architecture.md` explicitly argued that *"the cost function
itself carries forward — it just needs U wired up and a genuine locality term."* **The frozen
architecture rejected that**, on the grounds that a dimensionless min-max normalised score cannot
express opportunity cost, deferral pricing, or an admissible lower bound. See **ADR-01** and
**ADR-02c**.

---

## 7. Where the surviving conclusions live now

| Legacy reasoning | Current home |
|---|---|
| Self-hosted routing is mandatory | **ADR-11** · [`ARCHITECTURE.md`](../../ARCHITECTURE.md) §6 |
| Locality-exploiting sharding is mandatory | **ADR-12**, **ADR-28** · §6.1 |
| A durable work queue is mandatory (B4) | **ADR-05**, **ADR-27** · §5 |
| Exclusivity cannot rest on a cache lock | **ADR-04**, **ADR-10** · §4.1 |
| Verification must be executable, not read | Six build gates + 144 test suites · §2 |
| Legacy DTARO cost model and weights | [`legacy-assignment-engine-audit.md`](legacy-assignment-engine-audit.md) |
| Legacy host-platform detail | [`legacy-system-reference.md`](legacy-system-reference.md) |
| Raw benchmark artefacts | `Backend/benchmark/results/` — **legacy monolith measurements** |

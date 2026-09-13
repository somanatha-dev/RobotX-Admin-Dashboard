# RobotX Routing, Distance, Mapbox & Assignment — Interview Guide

> **How this document was produced.** Every claim below was read out of the repository at
> commit `1223574` (branch `feature/dashboard`, working tree as of 2026-09-07). Where I say
> "not implemented", it means I searched for it and found nothing — the searches are named so
> you can re-run them yourself.
>
> **Status labels used throughout:**
>
> | Label | Meaning |
> |---|---|
> | **CURRENT** | Real code, on a path that runs in production today |
> | **SIMULATION-ONLY** | Real code, but only exercised by `VirtualRobot` / the simulator |
> | **PLANNED** | Written down as a decision or contract, but no working code |
> | **NOT IMPLEMENTED** | Searched for, not found anywhere in the repo |
> | **DEAD CODE** | Code exists, compiles, but nothing calls it |

---

## 1. Big Picture

RobotX has **two separate worlds** that people constantly confuse. Getting this distinction
right is the single most valuable thing in this document.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  WORLD A — THE DECISION PATH  ("who should do this job?")                 │
│                                                                            │
│   Task → Mission → Leg → candidate robots → feasibility → cost γ           │
│                                → min-cost flow → commit → OFFER            │
│                                                                            │
│   Lives in:  Backend/src/engine/**  +  Backend/src/workers/**              │
│   Uses Mapbox?  NO. Never. Not once.                                       │
│   Status: FULLY BUILT but CANNOT RUN — 34 required inputs are unresolved.  │
└───────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────────┐
│  WORLD B — THE EXECUTION PATH  ("now drive there and show me the line")   │
│                                                                            │
│   chosen robot + chosen stops → Mapbox Directions → polyline               │
│                                → attached to the OFFER → drawn on the map  │
│                                → VirtualRobot walks the polyline           │
│                                                                            │
│   Lives in:  Backend/src/services/**  +  Frontend/src/features/maps/**     │
│   Uses Mapbox?  YES — for the drawn line only.                            │
│   Status: WORKING.                                                         │
└───────────────────────────────────────────────────────────────────────────┘
```

**The one-sentence version:** Mapbox draws the line *after* the robot has been chosen. It
plays no part in *choosing* the robot, and the chooser cannot currently run at all.

The codebase says this about itself, in
[executionGeometry.service.js:9-19](Backend/src/services/executionGeometry.service.js#L9-L19):

> It is **not** a routing source for the decision path. […] Nothing here is read by candidate
> generation, by the feasibility gate, by any cost term, or by the solve. […] Presenting a
> Mapbox polyline as the missing traversal source would be exactly the fabrication the
> programme's standing rule forbids; drawing the line an already-chosen agent drives is not.

---

## 2. What Mapbox Actually Does

### 2.1 Where Mapbox is configured

| Where | File | What it configures | Status |
|---|---|---|---|
| Frontend map | [MapControl.jsx:103-121](Frontend/src/features/maps/MapControl.jsx#L103-L121) | `mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN`, then `new mapboxgl.Map({ style: MAP_STYLE })` | **CURRENT** |
| Basemap style | [environmentConfig.js:26,34](Frontend/src/features/maps/environment/environmentConfig.js#L26) | `ENVIRONMENT_STYLE = 'mapbox://styles/mapbox/standard'`, fallback `dark-v11` | **CURRENT** |
| Backend token | [mapbox.service.js:15-29](Backend/src/services/mapbox.service.js#L15-L29) | `getMapboxToken()` reads `MAPBOX_TOKEN` or `MAPBOX_ACCESS_TOKEN`; throws HTTP 503 if absent | **CURRENT** |
| Env file | `Backend/.env` | `MAPBOX_TOKEN` is set | **CURRENT** |

### 2.2 Which Mapbox SDKs/APIs are actually present

**Frontend** — [Frontend/package.json](Frontend/package.json) lists exactly one Mapbox package:

```
"mapbox-gl": "^3.12.0"
```

That is the **map rendering SDK only**. There is **no** `@mapbox/mapbox-sdk`, **no**
`@mapbox/mapbox-gl-directions`, **no** `@mapbox/polyline`. Verified by
`grep -rn "@mapbox" Frontend/src Frontend/package.json` → the only hits are inside
`package-lock.json` transitive deps of `mapbox-gl` itself.

**Backend** — no Mapbox npm package at all. It calls the REST API with plain `fetch()`:

| API | Endpoint | Function | Status |
|---|---|---|---|
| Directions v5 | `api.mapbox.com/directions/v5/mapbox/{profile}` | [`directionsWithDistance`](Backend/src/services/mapbox.service.js#L55) | **CURRENT** (execution path only) |
| Directions v5 (wrapper) | same | [`directionsPolyline`](Backend/src/services/mapbox.service.js#L112) | **CURRENT** |
| Directions **Matrix** v1 | `api.mapbox.com/directions-matrix/v1/mapbox/{profile}` | [`matrixDurationsToDestination`](Backend/src/services/mapbox.service.js#L121) | **⚠ DEAD CODE** |
| Search Box v1 | `api.mapbox.com/search/searchbox/v1/suggest` and `/retrieve` | [LocationCombobox.jsx:23,48](Frontend/src/components/system/LocationCombobox.jsx#L23) | **CURRENT** (typing a place name in a form) |

**⚠ The Matrix API is a trap in an interview.** Its docstring
([mapbox.service.js:118-120](Backend/src/services/mapbox.service.js#L118-L120)) says
*"Used by DTARO for nearest-robot selection"* — **this is stale and untrue.**

```bash
$ grep -rn "matrixDurations" Backend/src Backend/tests Backend/tools
Backend/src/services/mapbox.service.js:121:  async function matrixDurationsToDestination(...)
Backend/src/services/mapbox.service.js:151:    matrixDurationsToDestination,
```

Only its own definition and its own export. **Zero callers.** The "nearest-robot selection"
it refers to was the legacy DTARO dispatcher, which was deleted — see
[task.service.js:4-19](Backend/src/services/task.service.js#L4-L19).

### 2.3 What Mapbox does and does not provide, exactly

Read the request URL that RobotX actually builds
([mapbox.service.js:64-70](Backend/src/services/mapbox.service.js#L64-L70)):

```js
`https://api.mapbox.com/directions/v5/mapbox/${profile}/${coords}`
  + `?geometries=geojson`   // give me GeoJSON coordinates
  + `&overview=full`        // full detail, not simplified
  + `&steps=false`          // ← NO turn-by-turn
  + `&access_token=…`
```

and how the response is consumed ([line 73](Backend/src/services/mapbox.service.js#L73)):

```js
const route = json?.routes?.[0];   // ← always the FIRST route only
```

| Capability | Provided by Mapbox to RobotX? | Evidence |
|---|---|---|
| **Route geometry** (the drawn line) | ✅ **YES** — this is the whole point | `geometries=geojson`, mapped to `{lat,lon}` at [line 92](Backend/src/services/mapbox.service.js#L92) |
| **Road distance** (metres) | ✅ **YES** — `route.distance` is captured | [line 97](Backend/src/services/mapbox.service.js#L97) → `distanceMeters` |
| **ETA / travel time** (seconds) | ⚠️ **RETURNED but essentially UNUSED** — `route.duration` is captured into `durationSec`, logged, and then **dropped by every caller** | [line 100](Backend/src/services/mapbox.service.js#L100); `executionGeometry` keeps only `points` + `distanceMeters` ([lines 99-103](Backend/src/services/executionGeometry.service.js#L99-L103)) |
| **Turn-by-turn instructions** | ❌ **NO** — explicitly disabled | `steps=false`, with the comment *"we only need the shape, not turn-by-turn"* |
| **Alternative routes** | ❌ **NO** — `alternatives=true` is never sent | `grep -rn "alternatives" Backend/src` → no hits |
| **Fastest-route selection among options** | ❌ **NO** — there is nothing to select from | Only `routes[0]` is read |
| **Any input to the assignment decision** | ❌ **NO** | See §2.4 |

### 2.4 Does Mapbox perform routing for RobotX? — the precise answer

**Yes, in one narrow sense; no, in the sense an interviewer means.**

- ✅ Mapbox *does* compute a real road route between two points, and RobotX *does* use that
  route's shape and length. That is genuine road routing, done by Mapbox's engine.
- ❌ Mapbox does **not** decide *which* robot goes, does **not** compare candidate robots,
  does **not** feed any cost term, and is **not** consulted before the assignment is made.
  It is called *after* the choice, with the already-chosen robot and the already-chosen stops.

The three profiles are tried in order until one answers
([executionGeometry.service.js:52](Backend/src/services/executionGeometry.service.js#L52)):

```js
const PROFILES = Object.freeze(["driving", "walking", "cycling"]);
```

This is a **fallback chain**, not a comparison. The first profile that returns *any* route
wins. It never asks "which of these three is fastest?"

### 2.5 The three places Mapbox Directions is called (all CURRENT)

| # | Caller | When it fires | Purpose |
|---|---|---|---|
| 1 | [`executionGeometry.attachStopPaths`](Backend/src/services/executionGeometry.service.js#L134) ← called from [coordinatorSolvePath.js:1757](Backend/src/workers/coordinatorSolvePath.js#L1757) | After the solver picks a robot, **before** the commit transaction | Attach a drivable polyline to each stop in the OFFER |
| 2 | [`routing.service.planRoute` / `replanRoute`](Backend/src/services/routing.service.js#L107) ← called from [alertDissemination.service.js:108](Backend/src/services/alertDissemination.service.js#L108) | An obstacle is reported near an in-flight robot | Re-plan around the obstacle |
| 3 | [`task.service.rerouteTask`](Backend/src/services/task.service.js#L843) | An operator clicks REROUTE in the UI | Fresh route from the robot's current position |

Note the deliberate design in #1: the Mapbox HTTP call happens **outside** the `SERIALIZABLE`
database transaction, because *"a slow or hanging provider would become a store-wide stall"*
([executionGeometry.service.js:21-27](Backend/src/services/executionGeometry.service.js#L21-L27)).
That is a good thing to be able to explain.

---

## 3. Robot Location Data Flow

### 3.1 The complete pipeline

```
   ┌──────────────────────────────────────────────────────────────────┐
   │ 1. SIMULATOR — VirtualRobot                    SIMULATION-ONLY   │
   │    Backend/src/simulation/VirtualRobot.js                        │
   │                                                                   │
   │    this.lat / this.lon are plain instance fields.                │
   │    Every 2 s (_tick), _stepAlongPath() advances them              │
   │    along this.activePath — the Mapbox polyline.                  │
   └────────────────────────────┬─────────────────────────────────────┘
                                │  Socket.IO "TELEMETRY" event
                                ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 2. BACKEND INGEST                                     CURRENT    │
   │    Backend/src/sockets/handlers/telemetry.handler.js             │
   │                                                                   │
   │    Builds `fullState` = {lat, lon, battery, status, speed,       │
   │                          heading, isOnline, lastSeenAt,          │
   │                          distanceTravelled}                       │
   └────────────┬──────────────────────────────────┬──────────────────┘
                │                                  │
                ▼                                  ▼
   ┌────────────────────────────┐   ┌──────────────────────────────────┐
   │ 3a. REDIS (live truth)     │   │ 3b. POSTGRES (occasional)        │
   │  key `robot:<id>`, TTL 15s │   │  prisma.robot.update — NOT every │
   │  telemetry.handler.js      │   │  tick (F10; see the comment at   │
   │  :594 (key), :683-696 (set)│   │  telemetry.handler.js:~700)      │
   └────────────────────────────┘   └──────────────────────────────────┘
                │
                ▼  io.to("dashboard").emit("robot:update", fullState)
                │  telemetry.handler.js:882
   ┌──────────────────────────────────────────────────────────────────┐
   │ 4. DASHBOARD                                          CURRENT    │
   │    Frontend/src/features/maps/mapControl/hooks/useRobotStream.js │
   │    Subscribes to the single canonical event "robot:update".      │
   └────────────────────────────┬─────────────────────────────────────┘
                                ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ 5. MAPBOX GL RENDER                                   CURRENT    │
   │    robotMarker2dRenderer.js → new mapboxgl.Marker(...)           │
   │    .setLngLat([lon, lat])                                        │
   └──────────────────────────────────────────────────────────────────┘
```

### 3.2 Where the latitude/longitude actually originates

**There is no GPS hardware in this repository.** Robot position originates in one of two
places:

1. **SIMULATION-ONLY** — `VirtualRobot` is constructed with a starting `lat`/`lon`
   ([VirtualRobot.js:163-177](Backend/src/simulation/VirtualRobot.js#L163-L177)) and then
   moves itself mathematically.
2. **CURRENT (for real hardware)** — the telemetry handler accepts `lat`/`lon` from whatever
   client sends a `TELEMETRY` event. A real robot would just send them. The backend does not
   care whether the sender is simulated or physical — same socket contract
   ([VirtualRobot.js:5](Backend/src/simulation/VirtualRobot.js#L5): *"Connects as a Socket.IO
   client (same AUTH / TELEMETRY flow as real hardware)"*).

### 3.3 One detail worth knowing: `distanceTravelled`

[telemetry.handler.js:662-681](Backend/src/sockets/handlers/telemetry.handler.js#L662-L681)
handles the two sender types differently:

```js
if (typeof distanceTravelledIn === "number") {
  distanceTravelled = distanceTravelledIn;          // VirtualRobot — trust its own number
} else if (prevState has lat/lon) {
  const moved = haversineMeters(prev.lat, prev.lon, fullState.lat, fullState.lon);
  if (Number.isFinite(moved) && moved < 500) {      // sanity: ignore GPS jumps > 500 m
    distanceTravelled += moved;
  }
}
```

So for a **real** robot, odometry is accumulated **haversine straight-line hops** between
consecutive telemetry samples. At a 2-second sampling rate over a smooth road that is a
decent approximation of road distance, but it is *not* road-network distance — it is a
polyline-of-samples length. **Status: CURRENT.**

---

## 4. How Routing Actually Works

### 4.1 What I searched for, and what I found

| Algorithm | Found? | Where |
|---|---|---|
| **A\*** | ✅ **YES** | [routing.service.js:34-97](Backend/src/services/routing.service.js#L34-L97) — but only for obstacle re-planning over an *existing* waypoint list |
| **Dijkstra** | ✅ **YES** | [minCostFlow.js:793-817](Backend/src/engine/solve/minCostFlow.js#L793-L817) — but on the **assignment** graph, not a road graph |
| **Haversine** | ✅ **YES** | [utils/distance.js:5-13](Backend/src/utils/distance.js#L5-L13) |
| **Great-circle (H3)** | ✅ **YES** | [spatial/cells.js:375-380](Backend/src/engine/spatial/cells.js#L375-L380) |
| **Straight-line fallback** | ✅ **YES** | [task.service.js:514](Backend/src/services/task.service.js#L514) `straightLineRoute` |
| **Mapbox Directions** | ✅ **YES** | [mapbox.service.js:55](Backend/src/services/mapbox.service.js#L55) |
| **D\* Lite** | ❌ **NOT IMPLEMENTED** | `grep -rin "d\* lite\|dstar\|d_star" Backend/src` → no hits |
| **BFS for routing** | ❌ **NOT IMPLEMENTED** | no breadth-first search over any map structure |
| **OSRM / Valhalla / GraphHopper** | ⚠️ **BENCHMARK ADAPTERS ONLY** | `Backend/tools/routing/adapters/{osrm,valhalla,graphhopper,inhouse}.js` — see §4.5 |
| **Google Maps / OpenRouteService** | ❌ **NOT IMPLEMENTED** | no hits anywhere |

### 4.2 Is there a road graph inside RobotX?

**No. NOT IMPLEMENTED.** There is no node/edge road network, no OSM graph loaded into memory,
no adjacency structure over roads. The repo contains GeoJSON campus files
(`rnsit-campus-osm.geojson`, `jssate-bengaluru-campus-osm.geojson`) but these are consumed by
the **frontend map layers** for drawing buildings and labels
([Frontend/src/features/maps/campus/osm/osmCampusImport.js](Frontend/src/features/maps/campus/osm/osmCampusImport.js)),
**not** by any pathfinder.

The road graph is Mapbox's, hosted on Mapbox's servers, reached over HTTP.

### 4.3 Is there a routing engine?

Two different answers for the two worlds:

**World B (execution) — YES, it's Mapbox.** `robot → pickup` and `pickup → drop` polylines
come from Mapbox Directions.
[executionGeometry.attachStopPaths](Backend/src/services/executionGeometry.service.js#L134)
walks the stop sequence and routes each hop:

```
 leg 1: agent's current position  →  stop[0]  (pickup)
 leg 2: stop[0]                   →  stop[1]  (drop)
 leg n: stop[n-1]                 →  stop[n]
```

Note the comment at [line 116-119](Backend/src/services/executionGeometry.service.js#L116-L119):
*"the agent's position is a required input rather than an optimisation: a stop sequence alone
describes where to be, not how to get to the first of them."*

**World A (decision) — NO. There is a hole where the routing engine should be.**

The engine's routing seam is [`routing/cellPairCache.js`](Backend/src/engine/routing/cellPairCache.js).
On a cache miss it calls an **injected** `deps.route(...)` function. When no router has been
injected, [line 242](Backend/src/engine/routing/cellPairCache.js#L242) returns:

```js
return { ok: false, entry: null, hit: false,
         reason: "no router is available and the entry is not cached" };
```

And the composition root deliberately supplies nothing
([coordinatorSolvePath.js:266-270](Backend/src/workers/coordinatorSolvePath.js#L266-L270)):

> The composition root never calls a routing engine; it hands `cellPairCache` the `route`
> function it was given and lets the cache decide when to fall through.

### 4.4 The `route` contract the decision path demands (PLANNED, unfilled)

[coordinatorPipeline.js:296-299](Backend/src/workers/coordinatorPipeline.js#L296-L299) states
exactly what a routing engine would have to return — **six fields**, not one:

```js
async ({ originCell, destCell, profileKey, timeBucket }) => ({
  distanceM,          // road distance, metres
  travelSeconds,      // road travel time
  travelSdSeconds,    // ← standard deviation of travel time
  climbM,             // ← total ascent along the hop
  descentM,           // ← total descent along the hop
  stopStartCycles,    // ← number of stop-start events
})
```

**Mapbox Directions supplies two of these six** (`distanceM`, `travelSeconds`). That is
precisely why a Mapbox polyline cannot be quietly promoted into the decision path — and the
code says so in a comment at
[coordinatorSolvePath.js:1735-1739](Backend/src/workers/coordinatorSolvePath.js#L1735-L1739):

> the §5 `route` contract the composition declares is six fields and remains unresolved, so a
> polyline here is not, and must never be presented as, the missing traversal source.

The docs are equally explicit that even *choosing* an engine wouldn't finish the job
([docs/phase15/B1_EXTERNAL_INPUT_HANDOFF.md:19](docs/phase15/B1_EXTERNAL_INPUT_HANDOFF.md)):

> **Availability differs across the shortlist**: Valhalla and GraphHopper can return elevation,
> **OSRM cannot**, and **no shortlisted engine returns stop-start cycles**.

### 4.5 The routing-engine shortlist (PLANNED)

`Backend/tools/routing/adapters/` holds four adapters — `osrm.js`, `valhalla.js`,
`graphhopper.js`, `inhouse.js`. **These are benchmark harnesses, not production wiring.**
Verified: `grep -rn "tools/routing" Backend/src` returns only three *comment* mentions, zero
imports.

[adapters/index.js:11-12](Backend/tools/routing/adapters/index.js#L11-L12):

> It selects nothing. Ranking, ordering and choosing are **B1 Step 5**, on recorded evidence,
> and the order below is §27 item 2's own — not a preference.

And the handoff doc's status line: **"Engine selected: NONE."**

### 4.6 The A\* that *does* exist — and its real scope

[routing.service.js:34-97](Backend/src/services/routing.service.js#L34-L97). Read the
docstring carefully — it is narrower than it first sounds:

> A\* operates on the **existing route waypoints as a graph**, marking obstacle-proximate
> waypoints as blocked and finding an alternate index sequence.

So:
- **Nodes** = indices into an array of `{lat,lon}` points *that Mapbox already returned*.
- **Edges** = each node to its `K_NEAREST = 6` geographically nearest other points
  ([line 21](Backend/src/services/routing.service.js#L21)).
- **Edge weight** = `haversineMeters` between the two points ([line 50](Backend/src/services/routing.service.js#L50)).
- **Heuristic** = `haversineMeters` to the goal ([line 40](Backend/src/services/routing.service.js#L40)).
- **Blocked set** = waypoints within `OBSTACLE_RADIUS_M = 30` m of the reported obstacle
  ([lines 20, 133-138](Backend/src/services/routing.service.js#L133-L138)).

This A\* **cannot discover a road that Mapbox didn't already give it.** It reshuffles and
skips points on a known polyline. If it fails, the code falls back to asking Mapbox for a
fresh route ([lines 154-156](Backend/src/services/routing.service.js#L154-L156)).

**Status: CURRENT**, but only reachable via the obstacle-alert path
(`alertDissemination.service.js`).

### 4.7 Summary answer

> **"How does RobotX route from robot → pickup → drop?"**
>
> It asks the Mapbox Directions API for each hop, taking the first route returned, trying
> `driving` then `walking` then `cycling` until one answers. That happens **after** the robot
> has been chosen. It does not compare routes, and the assignment engine never sees a route
> at all — its routing seam is unimplemented.

---

## 5. How Distance Is Actually Calculated

There are **four** distinct distance mechanisms. Naming which one you mean is a strong
interview signal.

### 5.1 Haversine (great-circle) — `Backend/src/utils/distance.js`

**Status: CURRENT.** The actual code
([utils/distance.js:5-13](Backend/src/utils/distance.js#L5-L13)):

```js
function haversineMeters(aLat, aLon, bLat, bLon) {
  const R = 6371000;                            // Earth radius, METRES
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const aa = s1*s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2*s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(aa)));
}
```

- **Type:** straight-line / geographical (as-the-crow-flies over a sphere).
- **Units:** metres. Earth radius hard-coded as `6371000`.
- **Consumers:**
  - `routing.service.js` — A\* edge weights and heuristic (**CURRENT**)
  - `telemetry.handler.js:675` — real-robot odometry accumulation (**CURRENT**)
  - `telemetry.handler.js:976` — movement detection for progress supervision (**CURRENT**)
  - `VirtualRobot.js:1652` — how far to the next waypoint this tick (**SIMULATION-ONLY**)

### 5.2 H3 great-circle — `Backend/src/engine/spatial/cells.js`

**Status: CURRENT (inside the engine), but the engine cannot run.**

```js
function greatCircleMetres(lat1, lon1, lat2, lon2) {
  if (!isFiniteCoordinate(lat1, lon1) || !isFiniteCoordinate(lat2, lon2)) {
    throw new Error("greatCircleMetres: both points must be finite, in-range lat/lon pairs");
  }
  return h3.greatCircleDistance([lat1, lon1], [lat2, lon2], h3.UNITS.m);
}
```

This delegates to Uber's **H3** library rather than hand-rolling the formula.

- **Type:** straight-line / geographical.
- **Units:** metres (`h3.UNITS.m`).
- **Where it goes next:** into the **admissible lower bound** for candidate pruning —
  [candidates/lowerBound.js:144](Backend/src/engine/candidates/lowerBound.js#L144).

The design rule is stated in [cDirect.js:30-37](Backend/src/engine/cost/cDirect.js#L30-L37):

> `t_approach` is *road-network travel time*, obtained from the Routing Service, never a
> great-circle distance. **Geometric distance appears in exactly one place in this design —
> the admissible lower bound of §6.4.**

That is a deliberate architectural boundary: great-circle distance is allowed to say *"this
robot cannot possibly be cheaper than X"* (safe, because straight-line ≤ road distance), but
is never allowed to *price* a candidate.

### 5.3 Mapbox road distance — `route.distance`

**Status: CURRENT, execution path only.**
[mapbox.service.js:97-99](Backend/src/services/mapbox.service.js#L97-L99):

```js
const distanceMeters = typeof route.distance === "number" && Number.isFinite(route.distance)
  ? route.distance : null;
```

- **Type:** true **road-network route distance**, computed by Mapbox.
- **Units:** metres (Mapbox's native unit for `route.distance`).
- **Where it goes next:** attached to each offered stop as `pathDistanceMeters`
  ([executionGeometry.service.js:170](Backend/src/services/executionGeometry.service.js#L170)),
  stored in the `Outbox` OFFER payload, then read back for the dashboard by
  [`offeredRouteFor`](Backend/src/services/assignmentProjection.service.js#L185).
  **It is a display/record value. No cost term consumes it.**

### 5.4 Simulated odometry — `VirtualRobot.distanceTravelled`

**Status: SIMULATION-ONLY.**
[VirtualRobot.js:1652-1674](Backend/src/simulation/VirtualRobot.js#L1652-L1674) accumulates
haversine hops between consecutive polyline waypoints as the robot walks them. Because it
walks Mapbox's polyline, the total closely tracks road distance — but the arithmetic itself is
straight-line segment summation.

### 5.5 Distance mechanisms at a glance

| # | Mechanism | Type | Units | Consumer | Status |
|---|---|---|---|---|---|
| 1 | `haversineMeters` | Straight-line | metres | A\* replan, real-robot odometry, movement checks | **CURRENT** |
| 2 | `greatCircleMetres` (H3) | Straight-line | metres | §6.4 pruning lower bound **only** | **CURRENT** (engine inert) |
| 3 | Mapbox `route.distance` | **Road-network** | metres | Display + OFFER record | **CURRENT** |
| 4 | `distanceTravelled` | Sum of straight-line hops | metres | Dashboard odometer | **SIMULATION-ONLY** |
| 5 | `plan.distanceM` (the cost model's `d_mission`) | Would be road distance from the `route` seam | metres | `C_direct` / `C_lifecycle` | **NOT AVAILABLE — see §10** |

---

## 6. Multiple Routes and Best Route Selection

This section answers your question #6 directly and bluntly.

### 6.1 Does RobotX calculate multiple routes?

**No.** For any given pair of points, exactly **one** Directions request is issued, and
exactly **one** route is read from it (`json?.routes?.[0]`). The `alternatives` query parameter
that would make Mapbox return several is never sent — `grep -rn "alternatives" Backend/src`
finds nothing.

### 6.2 Does it compare routes?

**No.** There is no comparison code. The three-profile loop looks superficially like a
comparison but is not — look at
[executionGeometry.service.js:94-104](Backend/src/services/executionGeometry.service.js#L94-L104):

```js
for (const profile of PROFILES) {              // ["driving","walking","cycling"]
  const result = await provider({ from, to, profile });
  if (isTraversable(result && result.points)) {
    return { points: result.points, ... };     // ← RETURNS ON FIRST SUCCESS
  }
}
return null;
```

The loop **returns immediately** on the first profile that produces a usable path. `walking`
and `cycling` are never even requested if `driving` succeeds. It is a fallback chain, not a
tournament.

### 6.3 Does it choose the shortest route?

**No** — no route is compared against another by length.

### 6.4 Does it choose the fastest route?

**No** — no route is compared against another by duration. `durationSec` is captured from
Mapbox and then discarded by every caller.

**Important nuance to state honestly in an interview:** Mapbox's `driving` profile internally
optimises for a fast route on its own road graph. So the line drawn is a sensible road route.
But **RobotX** performs no selection of its own — it accepts whatever Mapbox hands back first.

### 6.5 So what does it actually do?

```
        RobotX's actual "best route" logic, in full:
        ─────────────────────────────────────────────
        try driving  →  got a path with ≥ 2 points?  →  USE IT. STOP.
        else try walking →  got one?                 →  USE IT. STOP.
        else try cycling →  got one?                 →  USE IT. STOP.
        else                                          →  attach NO path at all
```

That last branch matters. When no route is obtainable, the code does **not** substitute a
straight line — see [executionGeometry.service.js:29-35](Backend/src/services/executionGeometry.service.js#L29-L35):

> **Absence is absence.** When no route can be obtained the stop carries **no** `path` […]
> There is deliberately no straight-line substitute.

The robot then refuses the offer with `NO_EXECUTABLE_PATH`
([VirtualRobot.js `assessExecutability`](Backend/src/simulation/VirtualRobot.js#L119)) and the
Leg returns to `QUEUED`.

*(The one straight-line fallback that survives is `straightLineRoute` in
[task.service.js:514](Backend/src/services/task.service.js#L514), used only by the operator-triggered
`rerouteTask` path — and the header at [task.service.js:20-26](Backend/src/services/task.service.js#L20-L26)
explains it is kept only until the cutover retention window closes.)*

**Status of §6 as a whole: multiple-route generation, comparison, shortest-route selection and
fastest-route selection are all NOT IMPLEMENTED.**

---

## 7. Task → Mission → Leg

Before we can talk about assignment, we need the vocabulary the engine uses. It does **not**
assign "tasks to robots" — it assigns **Legs** to **agents**.

```
   TASK  (what the customer asked for)
     │   Backend/prisma/schema.prisma — the `Task` model
     │   { taskId, pickup, pickupLat, pickupLon, drop, dropLat, dropLon,
     │     status, requirements[], payloadSpecId }
     │
     ▼   engine/domain/mappers/legacyTask.js — `taskToWork()`
   MISSION  (the unit of work in the domain model)
     │
     ▼
   LEG  (one indivisible chunk of driving+service assigned to ONE agent)
     │
     ▼
   STOPS  (ordered points the agent visits: pickup at sequence 0, drop at sequence 1, …)
```

### 7.1 What happens when a task is submitted (CURRENT)

[`task.service.assignTask`](Backend/src/services/task.service.js#L640) — despite the name, it
**does not assign anything**. Its steps:

1. Validate `pickupLat/pickupLon/dropLat/dropLon` — 400 if any is missing.
2. Parse the payload declaration and the `requestedChassisType`.
3. **Check the cutover gate** — this is the `ENGINE_NOT_LIVE` refusal (§10.6).
4. Create the `Task` row with `status: "PENDING"`.
5. Emit `TASK_CREATED` to the dashboard.
6. `admitToRound(...)` — write a durable `WorkQueue` row.

The comment at [line 730-733](Backend/src/services/task.service.js#L730) is worth quoting:

> Fast and synchronous: **no routing provider is consulted on the request path**, because the
> plan that will be routed is built inside the round, before the choice, from the same
> artefact the cost model scores.

**The legacy greedy dispatcher is gone from the build.** Header at
[task.service.js:11-19](Backend/src/services/task.service.js#L11-L19) lists what was deleted:
`_processAssignment`, `_finalizeAssignment`, `legacyDetachedAssignment`, `seedTaskKeys`,
`getRoutesWithDistance`, `pathDistanceMeters`, and the `robotReserve:*` retry loop. A build
gate (`tools/gates/checkLegacyRetirement.js`) fails if any returns.

---

## 8. Candidate Generation

**Status: CODE COMPLETE, cannot run (see §10.6).**
Files: [`engine/candidates/`](Backend/src/engine/candidates/) — `expansion.js`,
`availabilityIndex.js`, `lowerBound.js`, `admissibilityGate.js`, `ordering.js`, `omega.js`,
`clusterShare.js`.

### 8.1 The idea: H3 hexagons and rings

RobotX divides the world into **H3 hexagonal cells** (Uber's open-source geospatial index) —
[`engine/spatial/cells.js`](Backend/src/engine/spatial/cells.js). Robots are indexed by which
cell they're in (`availabilityIndex.js`).

To find candidates for a Leg, the engine starts at the Leg's first stop's cell and expands
outward ring by ring:

```
                       ring 2
                  ┌───┐   ┌───┐   ┌───┐
              ┌───┤   ├───┤   ├───┤   ├───┐
              │   │   │ ┌─┴─┐ │   │   │   │      ring 1 = 6 neighbours
              └───┤   ├─┤ ▓ ├─┤   ├───┘          ring 0 = the pickup's own cell (▓)
                  │   │ └─┬─┘ │   │              ring 2 = 12 cells further out
                  └───┘   └───┘   └───┘
```

### 8.2 Expansion stops early — that's the clever part

Expansion is **not** "grab the nearest N robots". From
[expansion.js:7-10](Backend/src/engine/candidates/expansion.js#L7-L10):

> Expansion is driven by the pruning rule of §6.4, not by a fixed ring count.

For a ring that has **not yet been queried**, the engine computes a **geometric floor** — the
cheapest any robot in that ring could *possibly* be — using the minimum great-circle distance
to that ring ([`minimumPossibleDistanceForRingMetres`](Backend/src/engine/candidates/expansion.js#L105),
[`unexploredRingFloorMilliCU`](Backend/src/engine/candidates/expansion.js#L133)).

If that floor is already worse than the best real candidate found so far, **the ring is never
queried at all** — and neither is any ring beyond it.

### 8.3 The lower bound formula (the one place geometry is allowed)

[lowerBound.js:31, 144-150](Backend/src/engine/candidates/lowerBound.js#L144):

```js
const distanceM    = greatCircleMetres(agent.lat, agent.lon,
                                       leg.firstStopLat, leg.firstStopLon);
const travelSeconds = distanceM / maxSpeedMs;         // fastest physically possible
const eMinWh        = Math.max(0, kappa * betaDist * distanceM);
```

**Why this is safe:** great-circle distance is the *shortest possible* path between two points
on Earth. A real road can only be longer. Dividing by the agent's *maximum* speed gives the
*shortest possible* travel time. So this genuinely under-estimates — which is exactly what an
**admissible** bound must do. If you pruned with an over-estimate, you could throw away the
true optimum.

### 8.4 Containment: how far will it look?

Governed by `candidate.max_radius_by_sla_class` **or** a wall-clock budget
([coordinatorPipeline.js:363-386](Backend/src/workers/coordinatorPipeline.js#L363-L386)). If it
has **neither**, `expandCandidates` refuses outright with `unbounded_search_refused`. The
wall-clock budget resolves (from `solve.time_budget`), so the search terminates — but the
*distance* radius is unresolved, meaning the deployment has not stated how far it will send a
robot.

---

## 9. Feasibility Checks

**Status: CODE COMPLETE, cannot run.**
Files: [`engine/feasibility/`](Backend/src/engine/feasibility/) — with **38 numbered
predicates** in `predicates/f01.js` … `f38.js`.

### 9.1 The structure

```
   candidate (agent a + Leg l)
        │
        ▼
   evaluate.js  ──runs──►  register.js  ──►  f01 … f38
        │
        ▼
   THREE-VALUED result  (threeValued.js)
        │
   ┌────┴────┬─────────────┐
   ▼         ▼             ▼
 FEASIBLE  INFEASIBLE   INDETERMINATE
   │         │             │
   │         └─ dropped ───┴─ NOT priced, NOT offered
   ▼
 gets a "feasibility brand" — a cryptographic-style marker
        │
        ▼
 cost/phi.js REFUSES to price anything without the brand
```

### 9.2 Three-valued logic is the important idea

Most systems answer feasibility yes/no. RobotX has a third answer: **INDETERMINATE** — "I
could not establish this either way." An `INDETERMINATE` candidate is **not** treated as
feasible. This is *failing closed*: unknown is treated as unusable.

This is why the whole engine is currently stuck rather than producing bad answers — the
missing inputs make predicates indeterminate, and indeterminate candidates get no offer.

### 9.3 The brand — a structural guarantee

[phi.js:327](Backend/src/engine/cost/phi.js#L327) and
[cDirect.js:108](Backend/src/engine/cost/cDirect.js#L108) both start with:

```js
assertFeasible(plan, "cost/phi.evaluate");
```

From [phi.js:86-87](Backend/src/engine/cost/phi.js#L86): *"`evaluate()` asserts the feasibility
brand, so `Φ` is structurally incapable of pricing a candidate the gate did not admit."*

You cannot *accidentally* price an infeasible candidate — the code throws.

### 9.4 Examples of what the 38 predicates check

Chassis/requirement matching (F21, referenced from
[task.service.js:673-679](Backend/src/services/task.service.js#L673)), energy reserve
feasibility (§14.5, F35 — needs charger estate + return-leg Wh/metre), payload mass limits.
`f33.js` and `f35.js` are named in the memory notes as runtime prerequisites.

---

## 10. Cost Calculation

**Status: CODE COMPLETE, cannot run — this is the heart of the blockage.**

### 10.1 The two-level structure

```
   Φ (phi)    =  the cost of a whole PLAN     — "what will this agent's day cost?"
   γ (gamma)  =  the price of one COLUMN      — "what does adding this Leg cost?"
```

### 10.2 Φ — the cost functional

[cost/phi.js:6-11](Backend/src/engine/cost/phi.js#L6-L11) — the formula as written in the code:

```
Φ(plan) =  C_direct(plan) + C_opportunity(plan) + C_risk(plan)
         + C_lifecycle(plan) + C_policy(plan)
         + Σ        C_delay[l]( completion_time(l, plan) )
        l ∈ legs(plan)
```

| Term | Module | What it prices | Sign |
|---|---|---|---|
| `C_direct` | [cDirect.js](Backend/src/engine/cost/cDirect.js) | Time + energy + distance wear of doing the work | ≥ 0 |
| `C_opportunity` | [cOpportunity.js](Backend/src/engine/cost/cOpportunity.js) | Value destroyed by tying this robot up | may be **negative** |
| `C_risk` | [cRisk.js](Backend/src/engine/cost/cRisk.js) | Expected cost of failure + route hazard | ≥ 0 |
| `C_lifecycle` | [cLifecycle.js](Backend/src/engine/cost/cLifecycle.js) | Wear: actuators, braking, gradient, thermal, **battery** | ≥ 0 |
| `C_policy` | [cPolicy.js](Backend/src/engine/cost/cPolicy.js) | Policy penalties/credits | bounded below |
| `C_delay` | [cDelay.js](Backend/src/engine/cost/cDelay.js) | Lateness against the SLA, per Leg | ≥ 0 |

Crucially — `legs(plan)` is **every** Leg the plan executes, including ones the agent already
committed to. That's what makes Φ a *plan* functional rather than a *pair* score, and it means
insertion cost is priced automatically
([phi.js:22-27](Backend/src/engine/cost/phi.js#L22-L27)).

### 10.3 Inside `C_direct` — the six time components

[cDirect.js:6-11, 67-86](Backend/src/engine/cost/cDirect.js#L67-L86):

```
C_direct = λ_time(a) · ( t_wait + t_approach + t_service_first
                       + t_linehaul + t_service_last + t_terminal )
         + cu_per_wh       · E_mission(a, m)
         + cu_per_metre_wear(a) · d_mission
```

| Component | Meaning (from `COMPONENT_MEANING`) |
|---|---|
| `waitSeconds` | time until the agent can start: remaining committed work plus charge top-up |
| `approachSeconds` | travel from projected release position to the first stop, congestion-adjusted |
| `serviceFirstSeconds` | dwell at the first stop: docking, load, door, lift, handover, evidence capture |
| `linehaulSeconds` | travel across the remaining stop sequence |
| `serviceLastSeconds` | dwell at the final stop |
| `terminalSeconds` | mandatory post-mission activity — principally a required charging leg |

**Note the fail-closed rule** at [cDirect.js:114-118](Backend/src/engine/cost/cDirect.js#L114-L118):

```js
for (const name of TIME_COMPONENTS) {
  if (!isNumber(components[name]) || components[name] < 0) missing.push(`plan.components.${name}`);
}
if (!isNumber(plan.energyWh)  || plan.energyWh  < 0) missing.push("plan.energyWh");
if (!isNumber(plan.distanceM) || plan.distanceM < 0) missing.push("plan.distanceM");
```

A missing component is **not** treated as zero. *"An omitted component is not a cheap mission,
it is an unpriced one, and the baseline's central defect was exactly that shape."*

### 10.4 The wear double-charge rule (a nice detail to mention)

`cost.wear.cu_per_metre · d_mission` appears in **both** §8.2 (`C_direct`) and §8.5
(`C_lifecycle`). Summing both would double-charge. `phi.js` charges it **once, in
`C_lifecycle`**, and *proves* it with
[`assertWearChargedOnce`](Backend/src/engine/cost/phi.js#L263) rather than trusting the call
site.

### 10.5 γ — the column price

[plan/column.js:7](Backend/src/engine/plan/column.js#L7):

```
γ(c) = Φ( plan₀(a) ⊕ L(c) ) − Φ( plan₀(a) ) + C_churn(c)
```

Read it in plain English:

> **γ = (cost of the agent's plan WITH the new Leg) − (cost of its plan WITHOUT it) + churn**

For an **idle** robot, `plan₀(a)` is empty and `Φ(∅) = 0` exactly
([phi.empty()](Backend/src/engine/cost/phi.js#L475)), so `γ` simply equals the mission's whole
cost. For a **busy** robot, γ automatically includes the delay imposed on its existing work.

**γ is the number that becomes an arc cost in the min-cost flow.** It is stored as an integer
in **milli-CU** (thousandths of a Cost Unit) as a `BigInt` — no floating point anywhere in the
solve, so results are exactly reproducible.

### 10.6 ⚠ Is distance actually available to the assignment engine? — **NO**

This is the crux, and you must be able to state it clearly.

`C_direct` needs `plan.distanceM` and the six time components. Those come from
[`plan/timeline.project`](Backend/src/engine/plan/timeline.js), which reads hops from
[`routing/cellPairCache`](Backend/src/engine/routing/cellPairCache.js), which calls the
injected `deps.route(...)`. **Nothing injects one.**

Run the probe yourself:

```bash
$ cd Backend
$ node -e "const p=require('./src/workers/coordinatorPipeline'); \
           const r=p.requirements({}); \
           console.log('total', p.REQUIREMENT_IDS.length, 'missing', r.missing.length); \
           console.log(r.byClass);"

total 34 missing 34
{
  EXTERNAL_ROUTING:    5,
  REGISTER_UNRESOLVED: 16,
  NO_PRODUCER:         6,
  PROCESS_DEPENDENCY:  6,
  ADMISSIBILITY:       1
}
```

**All 34 of the coordinator's solve-path inputs are unresolved.** The five routing ones:

| # | Input | Why it blocks |
|---|---|---|
| 1 | `route` | The traversal source itself. Without it `cellPairCache.read` answers *"no router is available and the entry is not cached"* |
| 2 | `travelSdSeconds source (N29)` | §8.4 prices lateness "from the ETA predictive distribution, not the point estimate". No shortlisted engine returns a spread |
| 3 | `speedMetresPerSecond` (per profile) | `cellPairCache.applyIntraCellOffset` needs it; it is a real fleet measurement, not a guessable number |
| 4 | `hop terrain (climbM / descentM / stopStartCycles)` | §14.2's energy model evaluates these *over the traversal* |
| 5 | `timeBucket` (§20.3 congestion bucket) | Cache keys include it so an entry computed under one congestion bucket is never applied under another |

Six more have **no producer anywhere in `src/`** — `environment.ambientC/packC`,
`masses.vehicleMassKg`, `p_fail`, `route_hazard_cost`, return-leg Wh/metre, battery-wear
mission inputs. Note `p_fail`: *"`cost/cRisk.evaluate` refuses without `failure.probability`,
so **no candidate can be priced at all** without it"*
([coordinatorPipeline.js:420](Backend/src/workers/coordinatorPipeline.js#L420)).

### 10.7 What `ENGINE_NOT_LIVE` actually is — get this right

**A common mistake would be to say "ENGINE_NOT_LIVE is thrown because routing is missing."
That is not what the code does.** The two are separate:

**`ENGINE_NOT_LIVE`** is thrown at [task.service.js:695-706](Backend/src/services/task.service.js#L695-L706):

```js
const posture = cutoverEnabled.describe({ snapshot: options.config, shard: {...} });
if (!posture.live) {
  const err = new Error(`the assignment engine is not live for this shard: ${posture.consequence}`);
  err.status = 503;
  err.code = "ENGINE_NOT_LIVE";
  throw err;
}
```

It is a **cutover feature-flag gate** — a conjunction of the process-level `ENGINE_ENABLED`
env var AND the shard's `cutover.engine_enabled` binding
([engine/cutover/enabled.js](Backend/src/engine/cutover/enabled.js)). It is a *deployment
posture* check, not a *missing-input* check.

The **missing-input** refusal is separate and lives in the composition root:
`leaderWorkers.COMPOSERS.coordinator()` calls `coordinatorSolvePath.create(context)`; if the
requirements probe reports anything missing, it returns `UNCOMPOSABLE` with a message naming
*"34 inputs unresolved: …"*
([leaderWorkers.js:389-399](Backend/src/workers/leaderWorkers.js#L389)) and **the coordinator
worker never starts.**

So the honest causal chain is:

```
34 unresolved inputs  →  coordinator refuses to compose  →  no worker running
                                                                    │
ENGINE_ENABLED / shard binding not turned on  ────────────────►  ENGINE_NOT_LIVE (503)
                                                        at task submission time
```

Both close the door. They are two different doors. And the design reason the flag stays off is
stated in [task.service.js:37-43](Backend/src/services/task.service.js#L37-L43): admitting work
to a shard whose coordinator is not running *"would recreate exactly the defect the
architecture exists to eliminate — a task accepted, durably recorded, and never decided. A 503
naming the state is honest; a queue nobody drains is not."*

---

## 11. What Φ and γ Mean

### 11.1 Φ (Greek capital "phi")

**Φ is the price tag on a robot's whole plan.**

Think of a delivery driver's shift. Φ answers: *"If this driver's schedule looks like THIS,
what does it cost the business — in time, electricity, wear on the vehicle, risk of failure,
lateness penalties, and lost opportunity?"*

- It is a **functional over plans**, not a score over pairs. Input: a whole plan. Output: one
  integer in milli-CU.
- It is **not normalised**. [phi.js:29-33](Backend/src/engine/cost/phi.js#L29-L33): *"no
  normalisation, no rescaling, no relative ranking. Each addend is an estimate of a real
  quantity of resource consumed or value destroyed."* There is a
  `units.refuseNormalisation()` function that exists purely to make reintroducing min-max
  scaling fail loudly.
- **Φ(empty plan) = 0**, exactly, in integers.

### 11.2 γ (Greek lowercase "gamma")

**γ is the *extra* cost of giving one more Leg to one particular robot.**

```
        Robot R2's plan today          Robot R2's plan if we add T2
        ────────────────────           ────────────────────────────
        Φ(plan₀)  =  4 200             Φ(plan₀ ⊕ T2)  =  9 100
                                                          
        γ(R2, T2) = 9 100 − 4 200 + C_churn = 4 900 + churn
```

It is a **marginal cost**, not a total. That is why it correctly prices insertion: if adding
T2 makes R2's existing delivery 10 minutes late, that lateness shows up inside
`Φ(plan₀ ⊕ T2)` via `C_delay` and therefore inside γ automatically. There is no separate
"insertion penalty" that could disagree with the cost model
([phi.js:23-27](Backend/src/engine/cost/phi.js#L23-L27)).

`C_churn` is the extra term: the cost of *changing your mind* about work already promised
([REGISTRABLE_TERMS.C_churn](Backend/src/engine/cost/phi.js#L120), kill switch `churn_pricing`).

### 11.3 Why the distinction matters

| | Φ | γ |
|---|---|---|
| Scope | A whole plan | One (agent, Leg) pairing |
| Sign | Whole-plan cost | Difference of two Φ values (+ churn) |
| Where it lives | `cost/phi.js` | `plan/column.js` |
| Who consumes it | `column.price()` | The **min-cost flow arc cost** |

**One line for an interview:** *"Φ prices a plan; γ is the difference between two Φ values, and
γ is what the optimiser actually sees."*

---

## 12. Cost Table Example

> ⚠️ **The numbers in this section are invented for teaching.** RobotX cannot produce real
> ones — every rate (`cost.lambda_time`, `cost.energy.cu_per_wh`, `cost.wear.cu_per_metre`, …)
> resolves to `null` today. **Never present numbers like these as measured output.** What is
> real is the *arithmetic shape*.

Suppose we could resolve the rates. For candidate (R2, T2):

| Component | Value | Rate | milli-CU |
|---|---|---|---|
| `waitSeconds` | 120 s | λ_time = 2 mCU/s | 240 |
| `approachSeconds` | 300 s | 2 | 600 |
| `serviceFirstSeconds` | 60 s | 2 | 120 |
| `linehaulSeconds` | 480 s | 2 | 960 |
| `serviceLastSeconds` | 45 s | 2 | 90 |
| `terminalSeconds` | 0 s | 2 | 0 |
| **time subtotal** | | | **2 010** |
| `E_mission` | 180 Wh | cu_per_wh = 3 | 540 |
| **`C_direct`** (time + energy; wear excluded here by the §10.4 rule) | | | **2 550** |
| `C_risk` | | | 300 |
| `C_lifecycle` (incl. `d_mission` = 2 400 m × 0.1) | | | 480 |
| `C_policy` | | | 0 |
| `C_delay` | | | 150 |
| **Φ(plan₀ ⊕ T2)** | | | **3 480** |
| **Φ(plan₀)** (R2 was idle) | | | **0** |
| `C_churn` | | | 0 |
| **γ(R2, T2)** | | | **3 480** |

Do that for every surviving (robot, Leg) pair and you get a cost table:

```
              T1 (Library→MBA)   T2 (CSE→Electronics)
   R1              4 100                6 900
   R2              3 900                3 480
   R3              7 400                2 100
   defer           9 000                9 000        ← C_defer, the "do it next round" price
```

That table **is** the optimisation problem.

---

## 13. Min-Cost Flow

### 13.1 Is a library used?

**No. It is implemented by hand, twice.** Files:

| File | What it is |
|---|---|
| [`engine/solve/minCostFlow.js`](Backend/src/engine/solve/minCostFlow.js) | Builds the network; contains the **successive-shortest-path** solver |
| [`engine/solve/costScaling.js`](Backend/src/engine/solve/costScaling.js) | The **cost-scaling** solver — the actual decision path |
| [`engine/solve/objective.js`](Backend/src/engine/solve/objective.js) | Builds the set-partitioning *instance* the network is derived from |
| [`engine/solve/regime.js`](Backend/src/engine/solve/regime.js) | Decides which regime/solver applies; labels the duals |
| [`engine/solve/budgets.js`](Backend/src/engine/solve/budgets.js) | The anytime time-budget tracker |
| [`engine/solve/round.js`](Backend/src/engine/solve/round.js) | Orchestrates one decision round |

Everything is `BigInt` integer arithmetic. `grep` for graph/LP libraries (`lemon`, `glpk`,
`ngraph`, `graphlib`, `javascript-lp-solver`) in `Backend/package.json` → **no hits**.

### 13.2 Why two solvers?

[minCostFlow.js:52-71](Backend/src/engine/solve/minCostFlow.js#L52-L71):

1. **Cost scaling** is the decision path — it's fast.
2. **Successive shortest paths** is kept for two jobs:
   - **Test oracle** — a *different* algorithm reaching the same optimum, so tests compare two
     independent implementations rather than one against its own opinion.
   - **Exactness fallback** — cost scaling collapses the cost into a scaled integer that is
     exact only inside float64's exact-integer range. `prepare()` checks up front, `certify()`
     proves the answer afterwards; if either declines, the round is re-solved by SSP. *"Exact
     and slow rather than fast and uncertified."*

The SSP solver was measured at **≈ 23.5 s** on a 500 Legs × 200 agents shape — which is
literally why cost scaling was written ([line 79-80](Backend/src/engine/solve/minCostFlow.js#L79)).

### 13.3 The network, drawn

[minCostFlow.js:17-21](Backend/src/engine/solve/minCostFlow.js#L17-L21):

```
                    ┌── cost γ(c) ──► agent a ──┐
          S ──► Leg l                           ├──► T
                    └── cost C_defer[l] ────────┘
```

| Arc | Capacity | Cost | Meaning | Code |
|---|---|---|---|---|
| `S → l` | **1** | 0 | *Coverage row*: exactly one unit leaves the source per Leg | [line 229](Backend/src/engine/solve/minCostFlow.js#L229) |
| `l → a` | **1** | `γ(c)` | The pairing "agent a does Leg l" | [line 246](Backend/src/engine/solve/minCostFlow.js#L246) |
| `l → T` | **1** | `C_defer[l]` | *Deferral*: leave this Leg for the next round | [line 261](Backend/src/engine/solve/minCostFlow.js#L261) |
| `a → T` | **1** | 0 | **Exclusivity row: ≤ 1 per agent** | [line 269](Backend/src/engine/solve/minCostFlow.js#L269) |

### 13.4 The data structures

**Forward-star adjacency with paired forward/reverse arcs**
([lines 207-225](Backend/src/engine/solve/minCostFlow.js#L207-L225)) — parallel typed arrays
rather than objects:

```js
const arcTo       = [];   // arcTo[i]       = head node of arc i
const arcCapacity = [];   // arcCapacity[i] = remaining capacity
const arcCost     = [];   // arcCost[i]     = [bigint, bigint]  (lexicographic pair)
const arcRole     = [];   // SUPPLY | PAIRING | DEFER | REMAIN_QUEUED | EXCLUSIVITY
const arcMeta     = [];   // { legId, agentId, identity, columnIndex }
const adjacency   = [];   // adjacency[node] = [arc indices]
```

Every arc is stored with its reverse immediately after it, so **the reverse of arc `i` is at
`i ^ 1`** (XOR with 1) — a classic residual-network trick
([`ARC_PAIR_STRIDE = 2`](Backend/src/engine/solve/minCostFlow.js#L134)).

Node indexing is canonical: `0` = source, `1 … |L|` = Legs (sorted by id), then agents (sorted
by id), then the sink last. This ordering is **also a topological order** of the initial DAG,
which is what lets `initialPotentials()` compute exact Johnson potentials in one pass
([lines 305-329](Backend/src/engine/solve/minCostFlow.js#L305-L329)).

### 13.5 The lexicographic cost — a genuinely elegant bit

When deferral is switched off, a Leg with no feasible agent still needs a way to reach the
sink. The obvious hack is a huge constant ("big-M"). The code refuses that
([lines 33-47](Backend/src/engine/solve/minCostFlow.js#L33-L47)) because a big-M is an
unregistered magic number that the optimiser may eventually decide is worth paying.

Instead, **every cost is a pair `(unassigned, milliCU)`**:

- remain-queued arc costs `(1, 0)`
- every other arc costs `(0, something)`

Comparison is lexicographic — the first component dominates absolutely, and money only breaks
ties. So "assign whenever any feasible candidate exists" becomes a **priority**, not a price,
and no configuration of real costs can ever outbid it.

### 13.6 How conflicts are prevented — the exclusivity arc

**This is the whole answer to "what if two tasks want the same robot?"**

Each agent has **exactly one** arc `a → T` with **capacity 1**. Flow is conserved: whatever
enters agent node `a` must leave it, and only one unit can leave. Therefore **at most one Leg
can route through any agent**. It is a structural impossibility, not a check.

[minCostFlow.js:28-31](Backend/src/engine/solve/minCostFlow.js#L28-L31) is emphatic that this
is per-*agent*, never per-capacity-slot:

> §9.3 rejects `capacity[a] = k > 1` on one arc outright: it "would compute an objective value
> that is not the cost of the allocation it selects".

### 13.7 Tiny numerical example — worked by hand

Two Legs, two agents. Costs:

```
          A1     A2      defer
   L1     5      9        20
   L2     8      6        20
```

Network (capacities all 1):

```
                    5
          ┌────────────────► A1 ──┐
          │                       │ 0
    ┌──► L1 ──────8──────────┐    ▼
    │     │                  │   ┌───┐
 S ─┤     └──20──────────┐   └──►│ T │
    │                    │       └───┘
    │     ┌──6───────────┼──► A2 ──┘
    └──► L2                       0
          └──20──────────────► T
```

Enumerate the sensible flows (integer, capacity 1 everywhere):

| Assignment | Cost | Valid? |
|---|---|---|
| L1→A1, L2→A2 | 5 + 6 = **11** | ✅ |
| L1→A2, L2→A1 | 9 + 8 = 17 | ✅ |
| L1→A1, L2→A1 | — | ❌ **A1's arc has capacity 1** |
| L1→A1, L2 defer | 5 + 20 = 25 | ✅ |
| both defer | 40 | ✅ |

Minimum = **11**. The solver finds it without enumerating, by pushing one unit of flow at a
time along the cheapest augmenting path (Dijkstra on *reduced* costs).

**Note the greedy trap this avoids.** A greedy "cheapest first" would pick L1→A1 (cost 5),
then be forced into L2→A2 (cost 6) — total 11. Lucky here. But flip the table:

```
          A1     A2
   L1     5      6
   L2     5      20
```

Greedy takes L1→A1 (5, the global cheapest), leaving L2→A2 = 20. **Total 25.** Min-cost flow
takes L1→A2 (6) and L2→A1 (5). **Total 11.** *That* is why a flow solver is worth the code.

### 13.8 The duals (bonus credibility)

The final Johnson potentials **are** the LP duals: `π[l]` prices the coverage row, `π[a]` the
exclusivity row ([lines 82-88](Backend/src/engine/solve/minCostFlow.js#L82-L88)). Because the
constraint matrix is the incidence matrix of a bipartite graph, it is **totally unimodular**,
so the LP relaxation is integral and the solve is exact with **zero integrality gap**
([line 571-578](Backend/src/engine/solve/minCostFlow.js#L571)).

There's a nice honesty detail: a **budget-limited** solve publishes ε-optimal prices and
labels them `optimalityCertified: false`, because §8.3.1's λ_zone calibration reads that field
and *"cannot tell an ε-optimal price from a marginal one by inspection."*

---

## 14. What Happens When Robots Conflict

### 14.1 Inside one round — structurally impossible

Covered in §13.6: capacity-1 exclusivity arc. Two Legs cannot both route through one agent.
The optimiser doesn't "resolve" the conflict — it cannot represent it.

Concretely: if R2 is best for both T1 and T2, the solver compares the two *global* allocations
and picks the cheaper total. It might give R2 to T2 and send T1 to R1 even though R1 is worse
for T1 individually — because `(R1,T1) + (R2,T2)` beats `(R2,T1) + (R3,T2)` overall.

### 14.2 Across rounds — database-level exclusivity

The commit is one `SERIALIZABLE` transaction (§10.3.2) with explicit row locks on the agent
and the Leg, via `runSerializable` + `selectForUpdate`
([coordinatorSolvePath.js:1780-1786](Backend/src/workers/coordinatorSolvePath.js#L1780)).

And in the projection layer,
[assignmentProjection.service.js:160-172](Backend/src/services/assignmentProjection.service.js#L160-L172):

```js
const robotUpdate = await tx.robot.updateMany({
  where: { id: robot.id, OR: [{ currentTaskId: null }, { currentTaskId: task.id }] },
  data:  { currentTaskId: task.id, status: "ACTIVE" },
});
if (robotUpdate.count !== 1) {
  throw Object.assign(new Error("ROBOT_ALREADY_BOUND"), { projectionReason: "ROBOT_ALREADY_BOUND" });
}
```

`currentTaskId` is `@unique` in the Prisma schema, so double-binding raises a constraint
violation rather than silently overwriting.

### 14.3 The robot can still say no

An OFFER is an *offer*. [`offer.handler.js`](Backend/src/sockets/handlers/offer.handler.js)
accepts `OFFER_ACCEPT`, `OFFER_REJECT`, `OFFER_DEFER` (§11.2). A rejected offer returns the
Leg to `QUEUED` and records a feasibility observation. `NO_EXECUTABLE_PATH` (no Mapbox
geometry) is one such rejection reason.

---

## 15. Complete Assignment Flow

```
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ STEP 0 — SUBMISSION                              task.service.assignTask     │
 │   validate coords → parse payload → CUTOVER GATE (ENGINE_NOT_LIVE?)         │
 │   → create Task(PENDING) → emit TASK_CREATED → admitToRound → WorkQueue row │
 │   ✅ CURRENT (but gate refuses 503 while the flag is off)                    │
 └────────────────────────────────┬────────────────────────────────────────────┘
                                  ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ STEP 1 — ROUND STARTS            coordinator.worker + solve/cadence.js       │
 │   claim a batch of Legs from WorkQueue; pin a config snapshot version        │
 │   ⛔ NEVER REACHED — coordinator refuses to compose (34 unresolved inputs)    │
 └────────────────────────────────┬────────────────────────────────────────────┘
                                  ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ STEP 2 — CANDIDATE GENERATION            candidates/expansion.js             │
 │   H3 cell of first stop → ring 0, 1, 2 … via availabilityIndex               │
 │   compute unexploredRingFloorMilliCU per ring (great-circle based)           │
 │   STOP expanding once the ring's floor ≥ best-known cost   (§6.4 pruning)    │
 └────────────────────────────────┬────────────────────────────────────────────┘
                                  ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ STEP 3 — FEASIBILITY               feasibility/evaluate.js → f01…f38         │
 │   FEASIBLE → branded and passed on                                           │
 │   INFEASIBLE / INDETERMINATE → dropped (fail closed)                         │
 └────────────────────────────────┬────────────────────────────────────────────┘
                                  ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ STEP 4 — PLAN BUILD                plan/planBuilder.js + plan/timeline.js     │
 │   build plan₀(a) ⊕ Leg; insertion via plan/insertion.js                      │
 │   timeline.project() reads hops ◄── routing/cellPairCache ◄── deps.route()   │
 │   ⛔ THIS IS WHERE IT DIES: no router injected                                │
 └────────────────────────────────┬────────────────────────────────────────────┘
                                  ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ STEP 5 — PRICE                  cost/phi.js → cDirect/cRisk/cLifecycle/…     │
 │   Φ(plan₀ ⊕ l) and Φ(plan₀)                                                  │
 │   plan/column.js: γ = Φ(with) − Φ(without) + C_churn      → BigInt milli-CU  │
 │   an unpriceable column is PRUNED with its reason in the decision record     │
 └────────────────────────────────┬────────────────────────────────────────────┘
                                  ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ STEP 6 — BUILD INSTANCE                    solve/objective.buildInstance()   │
 │   columns (identity, agentId, legIds[], costMilliCU) + deferVariables        │
 │   canonically sorted: price, then agent, then identity                       │
 └────────────────────────────────┬────────────────────────────────────────────┘
                                  ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ STEP 7 — SOLVE                  solve/minCostFlow.buildNetwork() + solve()   │
 │   cost scaling (decision path) → certify() → duals                           │
 │   declined/uncertified → successive shortest paths fallback                  │
 │   out of time budget → trivial feasible incumbent, budgetLimited: true       │
 └────────────────────────────────┬────────────────────────────────────────────┘
                                  ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ STEP 8 — EXECUTION GEOMETRY (Mapbox!)   executionGeometry.attachStopPaths    │
 │   OUTSIDE the transaction. agent pos → stop[0] → stop[1] …                   │
 │   driving → walking → cycling, first success wins                            │
 │   no route ⇒ NO path attached (no straight-line substitute)                  │
 └────────────────────────────────┬────────────────────────────────────────────┘
                                  ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ STEP 9 — COMMIT                        commitment/commit.js  (SERIALIZABLE)  │
 │   lock agent row + Leg row → volatileRecheck → write Leg state               │
 │   → sideEffects: dispatch/offers.enqueueOffer writes the signed Outbox OFFER │
 └────────────────────────────────┬────────────────────────────────────────────┘
                                  ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ STEP 10 — OFFER → AGENT                 sockets/handlers/offer.handler.js    │
 │   robot answers OFFER_ACCEPT / OFFER_REJECT / OFFER_DEFER                    │
 │   on ACCEPT: projectAcceptedAssignment → offeredRouteFor(Outbox)             │
 │              → emit TASK_ASSIGNED{pathToPickup, pathToDrop}                  │
 │              → writeRouteCache(taskPath:*, robotTaskState:*)                 │
 └────────────────────────────────┬────────────────────────────────────────────┘
                                  ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ STEP 11 — EXECUTION + RENDER                                                 │
 │   VirtualRobot walks the polyline; telemetry → Redis → robot:update          │
 │   Dashboard draws robot marker + route line in Mapbox GL                     │
 └─────────────────────────────────────────────────────────────────────────────┘
```

---

## 16. VirtualRobot Simulation

**File:** [`Backend/src/simulation/VirtualRobot.js`](Backend/src/simulation/VirtualRobot.js)
(1 791 lines) — **SIMULATION-ONLY** throughout.
**Constants:** [`Backend/src/simulation/constants.js`](Backend/src/simulation/constants.js)

### 16.1 What it does simulate

| Behaviour | How | Where |
|---|---|---|
| **Socket protocol** | Real Socket.IO client, same AUTH/TELEMETRY flow as hardware | [line 5](Backend/src/simulation/VirtualRobot.js#L5) |
| **GPS position** | `this.lat`/`this.lon` updated every 2 s tick | `_stepAlongPath` [line 1626](Backend/src/simulation/VirtualRobot.js#L1626) |
| **Route following** | ✅ Walks the Mapbox polyline waypoint by waypoint | [lines 1648-1676](Backend/src/simulation/VirtualRobot.js#L1648) |
| **Speed (EMA-smoothed)** | Target ± jitter, exponential moving average, clamped | `_updateSpeed` [line 1535](Backend/src/simulation/VirtualRobot.js#L1535) |
| **Heading** | From actual movement vector, wrap-aware EMA to avoid 359°→1° flip | [lines 1684-1713](Backend/src/simulation/VirtualRobot.js#L1684) |
| **Battery drain** | Different rates for ACTIVE vs IDLE | `_applyBattery` [line 1721](Backend/src/simulation/VirtualRobot.js#L1721) |
| **Nonlinear charging** | Integrates a real power curve through the **same** `engine/energy/chargeCurve.js` the server plans with | [constants.js:67-86](Backend/src/simulation/constants.js#L67) |
| **Battery persistence** | Survives server restart via Redis `vr:battery:<id>`, DB fallback | [line 89](Backend/src/simulation/VirtualRobot.js#L89) |
| **Mission phases** | `TO_PICKUP → WAIT_PICKUP → TO_DROP → WAIT_DROP` → `TASK_COMPLETE` | [line 118](Backend/src/simulation/VirtualRobot.js#L118) |
| **Command dedup (§11.5)** | Non-volatile dedup store, authority epochs, fence floors | [lines 92, 489-575](Backend/src/simulation/VirtualRobot.js#L489) |
| **Offer protocol (§11.2)** | Answers ACCEPT / REJECT / DEFER | [line 847](Backend/src/simulation/VirtualRobot.js#L847) |
| **Refusing unroutable work** | `assessExecutability` → refuses if a path has < 2 points | [lines 114-142](Backend/src/simulation/VirtualRobot.js#L114) |
| **Random obstacle reports** | `OBSTACLE_PROBABILITY = 0.002` per ACTIVE tick | [constants.js:120](Backend/src/simulation/constants.js#L120) |

### 16.2 Does it call Mapbox? — **No, never.**

`grep -n "mapbox" Backend/src/simulation/VirtualRobot.js` finds only **comments** referring to
Mapbox-shaped data. The simulator **receives** `pathToPickup` / `pathToDrop` inside the
`TASK_ASSIGN` payload ([`_onTaskAssign`](Backend/src/simulation/VirtualRobot.js#L1141)). The
server did the Mapbox call; the robot just walks the result — exactly as real hardware would.

### 16.3 Straight-line or path-following?

**Path-following, with straight-line interpolation *between* consecutive waypoints.**

```js
const dist = haversineMeters(curLat, curLon, target.lat, target.lon);
if (dist <= budgetM) {                       // can reach this waypoint this tick
  curLat = target.lat; curLon = target.lon;  // snap to it
  idx++;
} else {                                     // partial move toward it
  const t = budgetM / dist;
  curLat = curLat + (target.lat - curLat) * t;   // linear interpolation
  curLon = curLon + (target.lon - curLon) * t;
}
```

Because Mapbox's `overview=full` polylines are densely sampled, linear interpolation between
adjacent points is visually indistinguishable from following the road. The `while` loop lets
it cross **multiple** waypoints in one tick *"so the robot moves at the correct speed
regardless of how densely the path is sampled"* ([line 1646](Backend/src/simulation/VirtualRobot.js#L1646)).

### 16.4 ⚠️ Which values are simulation constants, NOT hardware specs

**Be very careful here in an interview — do not present any of these as robot specifications.**

| Constant | Value | What it really is |
|---|---|---|
| `TELEMETRY_INTERVAL_MS` | 2000 | Simulator tick rate |
| `SPEED_BASE_MS` | 5.56 m/s (≈20 km/h) | **Invented** "delivery-bot speed" |
| `SPEED_JITTER` | 1.5 | Cosmetic randomness so the marker doesn't look robotic |
| `SPEED_MIN_MS` / `SPEED_MAX_MS` | 5.0 / 8.33 m/s | Invented clamp |
| `SPEED_EMA_ALPHA` | 0.20 | Animation smoothing coefficient |
| `MOVE_STEP_METERS` | 40 | Anti-teleport guard, not a physical limit |
| `BATTERY_DRAIN_ACTIVE` | 0.0444 %/tick | Chosen to give "100→20 % in 1 hour" |
| `BATTERY_DRAIN_IDLE` | 0.0089 %/tick | Chosen to give "100→20 % in 5 hours" |
| `PACK_NOMINAL_WH` | 1000 Wh | Nominal pack of a **simulated** class |
| `CHARGE_POWER_CURVE` | 2000 W → 120 W taper | Shaped to demonstrate §14.6's nonlinearity |
| `PICKUP_WAIT_MS` / `DROP_WAIT_MS` | 10 000 / 8 000 | Invented dwell times |
| `OBSTACLE_PROBABILITY` | 0.002/tick | Invented event rate |

The code itself is honest about this — the pipeline requirement for `speedMetresPerSecond`
says *"It is a real fleet measurement, not a plausible number: the only `MobilityModel` in this
repository is a seed whose `speedModel` is a note deferring to D3."*
([coordinatorPipeline.js:320-321](Backend/src/workers/coordinatorPipeline.js#L320))

### 16.5 What VirtualRobot does NOT simulate

- ❌ GPS noise, drift, or multipath error — position is exact
- ❌ Sensors (LiDAR, cameras, IMU, ultrasonic)
- ❌ Real physics — no acceleration limits, no turning radius, no mass, no inertia
- ❌ Traffic, pedestrians, or real obstacles (only a random probability)
- ❌ Localisation, SLAM, or on-board perception
- ❌ Any routing of its own — it never chooses where to go

---

## 17. Current vs Planned vs Unknown

### 17.1 CURRENT (working today)

| Capability | Location |
|---|---|
| Mapbox GL basemap + campus layers + 3D terrain | `Frontend/src/features/maps/**` |
| Mapbox Search Box place lookup | `Frontend/src/components/system/LocationCombobox.jsx` |
| Mapbox Directions for execution polylines | `Backend/src/services/mapbox.service.js`, `executionGeometry.service.js` |
| Live robot telemetry → Redis → dashboard | `telemetry.handler.js`, `useRobotStream.js` |
| Haversine distance utilities | `Backend/src/utils/distance.js` |
| A\* obstacle re-planning over an existing polyline | `Backend/src/services/routing.service.js` |
| Operator-triggered reroute | `task.service.rerouteTask` |
| Task submission → validation → PENDING → WorkQueue | `task.service.assignTask` |
| Assignment projection + `TASK_ASSIGNED` emission | `assignmentProjection.service.js`, `offer.handler.js` |
| Min-cost flow (both solvers) — **as code** | `engine/solve/**` |
| 38 feasibility predicates — **as code** | `engine/feasibility/predicates/**` |
| Φ / γ cost model — **as code** | `engine/cost/**`, `engine/plan/column.js` |
| VirtualRobot simulator | `Backend/src/simulation/**` |

### 17.2 SIMULATION-ONLY

- All robot movement, speed, heading, battery, charging, dwell, obstacle generation
- `distanceTravelled` as reported by simulated robots
- The entire fleet, in fact — there is no hardware integration in this repo

### 17.3 PLANNED (decided/specified, no working code)

| Item | Where it's specified |
|---|---|
| Selecting a routing engine (B1) | `docs/phase15/B1_EXTERNAL_INPUT_HANDOFF.md` — *"Engine selected: NONE"* |
| The six-field `route` contract | `coordinatorPipeline.js:296-299` |
| `travelSdSeconds` source (N29) | `coordinatorPipeline.js:303-313` — no engine supplies it |
| Hop terrain (climb/descent/stop-start) | `coordinatorPipeline.js:325-343` |
| Congestion `timeBucket` | `coordinatorPipeline.js:346-359` |
| 16 unresolved register rates | `coordinatorPipeline.SOLVE_PATH_REGISTER_INPUTS` |
| `p_fail` reliability model | `src/engine/reliability/` — contains **only** a `.gitkeep` |
| Map service route-hazard data | `coordinatorPipeline.js:430-437` |
| OSRM / Valhalla / GraphHopper adapters | `Backend/tools/routing/adapters/**` (benchmark harnesses) |

### 17.4 NOT IMPLEMENTED / UNKNOWN

- ❌ Multiple-route generation, route comparison, shortest/fastest selection
- ❌ Turn-by-turn navigation
- ❌ Any internal road graph
- ❌ D\* Lite, RRT, or any continuous-space planner
- ❌ Google Maps / OSRM / any non-Mapbox provider *in production code*
- ❌ Real GPS hardware
- ❌ Mapbox Matrix API usage (defined, zero callers)
- ❌ Live use of Mapbox `durationSec` (captured, then dropped)
- ❓ **Unknown:** which routing engine will be chosen — that is an explicitly withheld owner
  decision, and the docs forbid even hinting at a preference before the evidence steps complete

---

## 18. Current Limitations

Stated plainly. Being able to say these calmly is a *strength* in an interview.

1. **The assignment engine cannot run.** 34/34 solve-path inputs unresolved. Verifiable in one
   command (§10.6).
2. **No road distance reaches the cost model.** `plan.distanceM` and the six time components
   have no producer, because the `route` seam is unimplemented.
3. **Mapbox is not a routing brain for RobotX.** One route, no alternatives, no comparison,
   `steps=false`.
4. **`durationSec` is fetched and thrown away.** A real ETA is sitting right there in the
   response and nothing consumes it.
5. **The Matrix API function is dead code with a misleading docstring** claiming DTARO uses it
   for nearest-robot selection. DTARO's selection path was deleted.
6. **The A\* is not a road planner.** It reorders points on a polyline Mapbox already produced.
7. **Everything moving is simulated.** Speeds, battery curves and dwell times are invented
   constants.
8. **Real-robot odometry is a sum of straight-line hops**, not road distance.
9. **No containment radius is configured**, so the search is bounded in *work* (wall clock) but
   not in *distance*.
10. **`p_fail` blocks pricing entirely** — `cRisk` refuses without it, and
    `src/engine/reliability/` holds a single `.gitkeep`.

---

## 19. Interview Answers

### 19.1 The 2-minute explanation

> RobotX separates *deciding* from *driving*, and that separation is the core design idea.
>
> **Deciding.** A task comes in with pickup and drop coordinates. It becomes a Mission and
> then Legs — a Leg is one indivisible chunk of work for one robot. For each Leg, the engine
> finds candidate robots by expanding outward through H3 hexagonal cells around the pickup
> point. It doesn't expand blindly: before querying a ring, it computes a geometric lower
> bound on what any robot in that ring could possibly cost, using great-circle distance. If
> that floor is already worse than the best candidate found so far, the ring is never queried.
>
> Surviving candidates go through 38 feasibility predicates with three-valued logic — feasible,
> infeasible, or *indeterminate*, and indeterminate fails closed. Feasible candidates get a
> "brand" and only branded candidates can be priced; the cost model literally throws otherwise.
>
> Pricing is a functional called Φ over a robot's whole plan — direct cost, opportunity, risk,
> lifecycle wear, policy, and delay. The number the optimiser actually sees is γ, the
> *difference* between Φ with the new Leg and Φ without it, plus a churn term. Because it's a
> difference over whole plans, insertion cost is priced automatically — if adding a job makes
> an existing delivery late, that lateness is already inside γ.
>
> Those γ values become arc costs in a min-cost flow: source → Leg → agent → sink, every arc
> capacity 1. The capacity-1 arc from each agent to the sink is what makes double-booking
> structurally impossible. It's solved by a hand-written cost-scaling algorithm, with a
> successive-shortest-path solver behind it as both a test oracle and an exactness fallback.
> All BigInt integer arithmetic, so it's exactly reproducible.
>
> **Driving.** Only *after* a robot is chosen does Mapbox get involved. The Directions API
> returns a polyline for each hop; that polyline is attached to the offer, stored in the outbox
> record, drawn on the dashboard, and walked by the robot.
>
> **The honest status:** the decision path is fully written but cannot execute. Its requirements
> probe reports 34 unresolved inputs — most importantly the routing seam itself, which needs
> six fields per hop, and Mapbox only supplies two of them.

### 19.2 "How is the best robot selected?" (30 s)

> Not greedily. Every feasible robot–Leg pair gets a marginal cost γ — the difference between
> the robot's plan cost with the job and without it. Those become arc costs in a min-cost flow
> network, and the solver picks the cheapest *global* allocation across all Legs at once, not
> the cheapest robot per Leg. So it can deliberately give a Leg to a worse-for-that-Leg robot
> if it makes the overall assignment cheaper. The code is complete; it can't run yet because
> the routing and calibration inputs the cost model needs are unresolved.

### 19.3 "Does Mapbox calculate the route?" (30 s)

> Yes for the drawn line, no for the decision. We call Mapbox Directions v5 with
> `geometries=geojson`, `steps=false`, no `alternatives` — so we get one route's shape and its
> distance, no turn-by-turn and no alternatives. That happens *after* a robot has been chosen,
> purely to give the robot and the dashboard a line to follow. The assignment engine never
> calls Mapbox. Its routing seam expects six fields per hop — distance, travel time, travel-time
> standard deviation, climb, descent, and stop-start cycles — and Mapbox supplies two.

### 19.4 "How is distance calculated?" (30 s)

> Depends which distance. Straight-line uses haversine in `utils/distance.js`, Earth radius
> 6 371 000 m, output in metres — that's used for the A\* replan and real-robot odometry. The
> engine's pruning bound uses H3's `greatCircleDistance`, also metres, and that's deliberately
> the *only* place geometry is allowed to touch a cost, because it's an admissible
> under-estimate. True road distance comes from Mapbox's `route.distance`, in metres, but it's
> only recorded and displayed — no cost term consumes it.

### 19.5 "How does min-cost flow work?" (30 s)

> Build a graph: source → each Leg → each feasible agent → sink. Every arc has capacity 1. The
> Leg→agent arc costs γ, the pairing's price. Each Leg also gets a direct arc to the sink — the
> deferral option. Push one unit of flow per Leg and find the cheapest total routing. Capacity
> 1 on each agent's arc to the sink means at most one Leg can pass through any agent, so
> conflicts are structurally impossible. We implemented it ourselves — cost scaling on the
> decision path, successive shortest paths as an oracle and fallback — in BigInt integers, no
> library.

### 19.6 "What happens if two tasks want the same robot?" (30 s)

> Nothing special happens, because it can't happen. Each agent has exactly one arc to the sink
> with capacity 1, so flow conservation makes a second Leg through that agent infeasible. The
> solver then finds the best allocation given that constraint — it might give the robot to the
> task that needs it more and route the other task to a slightly worse robot, if that's cheaper
> overall. Across rounds it's enforced again in the database: a SERIALIZABLE transaction with
> row locks, plus a unique `currentTaskId` on the robot that raises `ROBOT_ALREADY_BOUND`.

### 19.7 "Can your current system actually perform assignment?" (30 s)

> No, and I can show you why in one command. `coordinatorPipeline.requirements()` probes every
> input the solve path needs and reports 34 of 34 unresolved — five routing, sixteen
> uncalibrated register rates, six with no producer at all, six process dependencies, one
> admissibility precondition. The coordinator worker refuses to start rather than assign real
> work on invented travel times. Separately, task submission returns 503 `ENGINE_NOT_LIVE`
> because the cutover flag is off — deliberately, so we don't accept work into a queue nobody
> drains. Every algorithm is written and tested; what's missing is external inputs, not code.

---

## 20. Cross-Questions

**1. Q: Does Mapbox pick the fastest route?**
A: Mapbox's own `driving` profile optimises internally, but RobotX does nothing with that — we
request one route, read `routes[0]`, and never send `alternatives=true`. We perform no
selection of our own.

**2. Q: Why not just use Mapbox for assignment too?**
A: The decision path's `route` contract needs six fields per hop; Mapbox gives two. Missing are
travel-time standard deviation (§8.4 prices lateness from a distribution, not a point
estimate), climb, descent, and stop-start cycles (§14.2's energy model evaluates those over the
traversal). The code explicitly forbids substituting a polyline —
`coordinatorSolvePath.js:1737`.

**3. Q: Why does travel-time *variance* matter?**
A: `C_delay` prices `p_late`, the probability of missing the SLA. With only a mean you'd have to
assert the ETA is certain, which is optimistic in exactly the direction that causes SLA
breaches. The pipeline calls turning that silence into `0` an unacceptable assumption.

**4. Q: Where is haversine used, exactly?**
A: `routing.service.js` (A\* weights and heuristic), `telemetry.handler.js:675` (real-robot
odometry) and `:976` (movement detection for progress supervision), and `VirtualRobot.js:1652`
(distance to next waypoint). It is **not** used by the cost model.

**5. Q: Why is great-circle distance allowed in the lower bound but banned in the cost?**
A: Because the bound must *under*-estimate to be admissible — straight-line ≤ road distance, so
pruning with it can never discard the true optimum. A cost, by contrast, must be accurate;
`cDirect.js:30-37` states the rule explicitly.

**6. Q: What is an "admissible" lower bound?**
A: One that never over-estimates the true cost. Same idea as an A\* heuristic. If it
over-estimated, you could prune away the region containing the optimum while claiming a proven
guarantee.

**7. Q: What is H3?**
A: Uber's open-source hexagonal geospatial index. It tiles Earth into hexagons at multiple
resolutions and gives you cell IDs, k-rings, and grid distance. RobotX uses it to index robot
availability by cell and to expand candidate search ring by ring.

**8. Q: Why hexagons rather than a square grid?**
A: Every hexagon has six neighbours all at the same centre-to-centre distance. A square grid has
four edge neighbours and four diagonal ones at different distances, which makes ring-based
distance bounds messier.

**9. Q: What does the "feasibility brand" actually do?**
A: `assertFeasible(plan, …)` at the top of `phi.evaluate` and `cDirect.evaluate`. It makes it
structurally impossible to price a candidate the gate didn't admit — a bug that would otherwise
be silent becomes a thrown error.

**10. Q: What is three-valued feasibility and why not just true/false?**
A: FEASIBLE / INFEASIBLE / INDETERMINATE. "I couldn't establish this" is genuinely different
from "this is fine". Collapsing indeterminate into feasible would be the permissive direction —
assigning work you couldn't prove was safe.

**11. Q: Φ versus γ, in one line each?**
A: Φ is the cost of a whole plan. γ is the difference between two Φ values plus churn — the
marginal cost of adding one Leg. Only γ reaches the solver.

**12. Q: Why is Φ a plan functional and not a pair score?**
A: So insertion is priced by the same model as everything else. `phi.js:23-27`: *"There is no
separate insertion cost model that could disagree with the cost model."*

**13. Q: Why milli-CU BigInt instead of floats?**
A: Determinism. Floating-point addition isn't associative, so summing costs in a different order
gives different answers, and two nodes could disagree about the optimum. Integers make the sum
exact and order-independent.

**14. Q: What is a "CU"?**
A: A Cost Unit — the common currency all terms convert into via registered exchange rates
(`cost.lambda_time` CU/second, `cost.energy.cu_per_wh` CU/Wh, `cost.wear.cu_per_metre` CU/metre).
Milli-CU is a thousandth of one.

**15. Q: Why does the code refuse to normalise costs to [0,1]?**
A: `phi.js:29-37` — normalisation destroys the meaning of the units and makes the score depend
on which other candidates happen to be in the set. `units.refuseNormalisation()` exists solely
to make reintroducing it fail loudly.

**16. Q: What's the difference between cost scaling and successive shortest paths?**
A: Same optimum, different algorithms. SSP runs |L| Dijkstras — measured at ≈23.5 s on a
500×200 shape. Cost scaling is the fast decision path. SSP is retained as a differential test
oracle and as the exact fallback when cost scaling declines or can't certify.

**17. Q: Why do you need two solvers at all?**
A: Cost scaling collapses the lexicographic cost into one scaled integer, exact only while
costs fit in float64's exact-integer range. `prepare()` checks that up front and `certify()`
proves the answer afterwards. If either declines, we re-solve exactly rather than return an
unproven answer.

**18. Q: Why lexicographic costs instead of a big-M constant?**
A: A big-M is an unregistered magic number that decides behaviour silently, and as real costs
grow the optimiser may eventually decide it's worth paying. The pair `(unassigned, milliCU)`
makes "assign whenever feasible" a *priority* that no price can outbid.

**19. Q: Why is the exclusivity capacity 1 per agent, not k for queue depth?**
A: `minCostFlow.js:28-31` — a capacity-k arc *"would compute an objective value that is not the
cost of the allocation it selects"*. In the singleton regime an agent takes at most one column
regardless of queue depth.

**20. Q: What are the duals and why publish them?**
A: The final Johnson potentials. `π[l]` prices the coverage row, `π[a]` the exclusivity row.
Because the constraint matrix is totally unimodular they're exact marginal prices of the
*integer* problem — useful for λ_zone calibration. A budget-limited solve publishes ε-optimal
prices labelled `optimalityCertified: false`, because the calibration consumer can't tell them
apart by inspection.

**21. Q: What is "totally unimodular" and why does it matter?**
A: A property of the constraint matrix meaning every square submatrix has determinant 0, +1 or
−1. Consequence: the LP relaxation has an integral optimum, so you get exact integer answers
with no branch-and-bound and no integrality gap.

**22. Q: What happens if the solver runs out of time?**
A: It returns the incumbent with a *bound*, and marks `budgetLimited: true`. Crucially it
returns the **trivial feasible flow** (every Leg to the sink) rather than the zero flow — a
zero flow would report `ok: true` while naming no Leg at all, which was an actual defect that
got fixed.

**23. Q: What is `C_defer`?**
A: The price of leaving a Leg queued for the next round. It's the cost of the `Leg → sink` arc,
so deferral competes with assignment on price rather than being a special case.

**24. Q: Does the A\* find roads?**
A: No. Its nodes are indices into a polyline Mapbox already returned, its edges connect each
point to its 6 nearest neighbours, and its weights are haversine. It reroutes *around blocked
waypoints on a known line*. If it fails it asks Mapbox for a fresh route.

**25. Q: What triggers the A\*?**
A: An obstacle report. `alertDissemination.service.js:108` calls
`routing.service.rerouteRobot`, which marks waypoints within 30 m of the obstacle as blocked
and runs A\* over the rest.

**26. Q: Why is Mapbox called outside the commit transaction?**
A: The commit is SERIALIZABLE over locked rows. An HTTP call inside it would hold those locks
across an external round trip, so a slow provider becomes a store-wide stall. The geometry is
resolved first and the transaction closes over already-resolved data.

**27. Q: What happens if Mapbox returns no route?**
A: The stop carries no `path` key at all. There is deliberately no straight-line substitute.
The robot's `assessExecutability` then refuses with `NO_EXECUTABLE_PATH`, the Leg returns to
QUEUED, and a feasibility observation is recorded.

**28. Q: Why refuse rather than draw a straight line?**
A: A straight line goes through buildings. Executing it would report a completed mission the
robot never actually performed. `executionGeometry.js:29-35` calls the refusal correct and says
this module must not defeat it.

**29. Q: Does `ENGINE_NOT_LIVE` mean routing is missing?**
A: No — that's a common misreading. `ENGINE_NOT_LIVE` is a **cutover feature-flag** refusal:
process `ENGINE_ENABLED` AND the shard's `cutover.engine_enabled`. The missing-inputs refusal
is separate — the composition root returns `UNCOMPOSABLE` naming 34 unresolved inputs and the
coordinator worker never starts.

**30. Q: Why refuse submissions with 503 instead of queueing them?**
A: `task.service.js:37-43` — admitting work to a shard whose coordinator isn't running recreates
the exact defect the architecture exists to eliminate: a task accepted, durably recorded, and
never decided. *"A 503 naming the state is honest; a queue nobody drains is not."*

**31. Q: How many inputs are missing, and how do you know?**
A: 34, measured not estimated:
`node -e "const p=require('./src/workers/coordinatorPipeline');console.log(p.requirements({}).missing.length)"`
→ `34`. Grouped: 5 EXTERNAL_ROUTING, 16 REGISTER_UNRESOLVED, 6 NO_PRODUCER, 6
PROCESS_DEPENDENCY, 1 ADMISSIBILITY.

**32. Q: Why is the requirement list computed rather than written down?**
A: Because hand-audits kept getting it wrong. `coordinatorPipeline.js:14-27` records that two
successive hand-audits produced two different confident answers — one said four values, the
next found three more. So the list became a table a build can walk.

**33. Q: Which routing engine will you use?**
A: Undecided, deliberately. Four candidates are benchmarked in `tools/routing/adapters/` —
OSRM, Valhalla, GraphHopper, in-house. The handoff doc's status line says *"Engine selected:
NONE"* and forbids ranking before the evidence steps are complete. Notably, none of the four
returns stop-start cycles and OSRM can't return elevation, so choosing an engine still doesn't
close the contract.

**34. Q: Would picking OSRM unblock the coordinator?**
A: No. Measured: B1 closes 3 of the routing requirements; 31 others remain. The handoff says
*"'B1 unblocks the coordinator' was never true and is now measured rather than assumed."*

**35. Q: What is `p_fail` and why does it block everything?**
A: A per-agent failure probability. `cRisk.evaluate` refuses without it, so **no candidate can
be priced at all**. The Tier 2 module that would produce it lives at `src/engine/reliability/`,
which has contained a single `.gitkeep` since 2026-07-28.

**36. Q: What is the Tier 1 / Tier 2 distinction?**
A: Tier 1 is the always-on decision path; Tier 2 is optional mechanisms behind kill switches.
§1.8 rule 2 forbids a Tier 1 module from statically importing a Tier 2 one — otherwise the kill
switch couldn't actually be thrown. `phi.registerTerm()` is the dependency-inversion seam that
lets `C_opportunity` arrive by registration.

**37. Q: If `C_opportunity` isn't registered, is it zero?**
A: No — it's *omitted* and the omission is reported. `phi.js:408-416`: a zero would be
indistinguishable from an opportunity cost that happened to be nil, and *"the two mean opposite
things when reading a decision record."*

**38. Q: What's the wear double-charge issue?**
A: `cost.wear.cu_per_metre · d_mission` appears in both §8.2 and §8.5. Summing both would double
a registered exchange rate. Φ charges it once, in `C_lifecycle`, and `assertWearChargedOnce()`
*proves* the attribution from the two breakdowns rather than trusting the call site.

**39. Q: Is the VirtualRobot's 20 km/h a real spec?**
A: No — `SPEED_BASE_MS = 5.56` is a simulation constant, as are the jitter, the EMA coefficient,
the min/max clamp, both battery drain rates, the 1000 Wh pack, and the dwell times. The pipeline
requirement for a real per-profile speed says the only `MobilityModel` in the repo is a seed
deferring to decision D3.

**40. Q: Does VirtualRobot call Mapbox?**
A: No. It receives `pathToPickup` / `pathToDrop` in the `TASK_ASSIGN` payload and walks them.
The server made the Mapbox call.

**41. Q: How does the robot move between waypoints?**
A: Budget = speed × tick, capped at 40 m. It consumes that budget walking waypoints, snapping to
each one it can reach and linearly interpolating toward the one it can't. The loop crosses
multiple waypoints per tick so speed is correct regardless of polyline density.

**42. Q: Why does the simulator share the charge curve with the server?**
A: §14.6 requires both sides to reason from identical inputs. If the simulator modelled the
taper differently, the fidelity gate would be measuring the gap between two models rather than
between a model and reality.

**43. Q: How does the dashboard get the route line?**
A: Not by recomputing it. `offeredRouteFor` reads the polyline back out of the `Outbox` OFFER
row — the durable record of what the agent was actually offered — so the dashboard draws the
same line the robot is driving, not a second route computed later that could differ.

**44. Q: What if the offer carried no geometry?**
A: `offeredRouteFor` returns null, no `TASK_ASSIGNED` is emitted, and the map draws nothing —
*"the honest rendering of an offer the agent will refuse."*

**45. Q: Is Postgres written on every telemetry tick?**
A: No — that was removed (F10). Redis is the live source for the dashboard and REST reads;
the `robot:<id>` key has a 15-second TTL. Postgres is written far less often.

**46. Q: Why is the telemetry broadcast scoped to a room?**
A: It used to be a global `io.emit`, which sent every robot's telemetry to every connected
socket including all the *other* robots — an O(N²) fan-out. Now it's `io.to("dashboard")`.

**47. Q: Could you make the system assign today by hard-coding a speed and using Mapbox
distance?**
A: Technically yes, and the codebase forbids it on purpose. `leaderWorkers.js:67`: *"A
coordinator started with a fabricated router would assign real work on invented travel times."*
It would produce confident, unfalsifiable, wrong answers — worse than refusing.

**48. Q: What would you do next?**
A: Close the routing seam first, because it's the widest. That means an engine decision plus
two things no engine supplies: a declared travel-time-spread source and a terrain source for
climb/descent/stop-start. In parallel, `p_fail` — because without it nothing can be priced at
all, and it's a code-plus-data gap rather than a withheld decision.

---

## 21. Things I Must NOT Claim in an Interview

❌ **"Mapbox calculates our routes."** → Say: *"Mapbox draws the execution polyline after the
robot is chosen; the assignment engine never calls it."*

❌ **"We use Mapbox Directions to find the best robot."** → We don't. Nothing in
`Backend/src/engine/**` imports anything Mapbox.

❌ **"We use the Mapbox Matrix API for nearest-robot selection."** → That docstring is stale.
Zero callers. Don't repeat it just because it's written in the file.

❌ **"We compare routes and pick the fastest."** → We request one route, read `routes[0]`, and
never send `alternatives=true`.

❌ **"The three profiles are compared."** → They're a fallback chain; the loop returns on the
first success.

❌ **"We do turn-by-turn navigation."** → `steps=false`, explicitly.

❌ **"We have a road graph / we implemented Dijkstra over roads."** → The Dijkstra is inside the
min-cost flow, over the *assignment* network. There is no road graph in this repo.

❌ **"We use D\* Lite."** → Not present anywhere.

❌ **"Our robots travel at 20 km/h."** → That's `SPEED_BASE_MS`, a simulation constant. Say
*"the simulator runs at ~20 km/h; real fleet speed is an unresolved input (D3)."*

❌ **"The system assigns tasks."** → It cannot. 34/34 inputs unresolved, coordinator refuses to
compose, submissions return 503.

❌ **"ENGINE_NOT_LIVE is because routing is missing."** → It's a cutover feature-flag gate. The
missing-inputs refusal is a separate mechanism in the composition root.

❌ **"Distance feeds the cost function."** → `plan.distanceM` has no producer. `cDirect` refuses
without it rather than treating it as zero.

❌ **"We've benchmarked the engine end to end."** → The measured numbers that exist are for the
*solver* on synthetic instances (≈23.5 s for SSP on 500×200) and for routing adapters in
`tools/routing/b1Benchmark.js`. There is no end-to-end assignment benchmark, because there is
no end-to-end assignment.

❌ **"We chose OSRM/Valhalla/GraphHopper."** → *"Engine selected: NONE."* Ranking before the
evidence steps is explicitly prohibited.

❌ Quoting any number from §12. Those are invented for teaching. Every real rate resolves to
`null`.

---

### What to lead with

If you only get one sentence, make it this:

> **RobotX separates the decision from the drive: a min-cost flow over marginal plan costs
> chooses the robot, and only then does Mapbox draw the line it follows. The decision path is
> fully implemented and deliberately refuses to run, because 34 of its inputs — starting with a
> six-field routing contract Mapbox only half-satisfies — are unresolved, and assigning real
> work on invented travel times is the one failure mode the architecture exists to prevent.**

That sentence is accurate, it's verifiable in one command, and it demonstrates you understand
your own system's boundaries — which is worth considerably more than claiming it works.

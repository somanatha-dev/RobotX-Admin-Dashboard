# RobotX Map — 3D environment, 2D robots

**Current milestone state**

| | |
|---|---|
| 3D map | **yes** |
| 3D environment (terrain / buildings / sky / lighting) | **yes** |
| 2D robots | **yes** |
| 2D pointers | **yes** |
| Future 3D seam | **yes** |
| 3D robot model | **no — and nothing here is a placeholder for one** |

The robots are 2D **on purpose**. Not as an interim step, not as a stand-in
awaiting a mesh. A flat, screen-legible marker is the correct visualization for
fleet operations, and this milestone commits to it while making a later 3D
robot a *renderer addition* rather than another architectural migration.

---

## Layers

```
Mapbox GL scene
│
├── ENVIRONMENT LAYER          environment/useEnvironmentLayer.js
│   ├── terrain (DEM)              environment/environmentConfig.js
│   ├── 3D buildings / landmarks   ← VENDOR geometry: city context (§6)
│   ├── sky + atmosphere
│   └── lighting preset
│        installed once per style load — never touched by telemetry
│
├── CAMPUS LAYER               campus/useCampusLayer.js
│   ├── vendor clip                ← campus precedence over the basemap (§6)
│   ├── boundary                   campus/campusSchema.js   (the contract)
│   ├── grounds / sports areas     campus/campusRegistry.js (the geometry)
│   ├── building extrusions        campus/osm/osmCampusImport.js (the classifier)
│   ├── roads / paths / steps      campus/campusLayers.js   (sources + specs)
│   ├── point locations + gate     campus/supplemental/…    (user-supplied)
│   └── labels (3 zoom bands)      campus/campusSearch.js   (the index)
│        5 GeoJSON sources, 17 layers, installed once, fed with setData
│
├── OPERATIONAL LAYER          mapControl/hooks/useRobotStream.js
│   ├── robot visuals ─────────► the renderer seam (below)
│   ├── route lines (ahead / travelled + directional flow)
│   │     progress from position   operational/routeGeometry.js
│   │     findings, reported       operational/routeValidation.js
│   ├── mission pins (pickup / drop)
│   └── follow camera             camera/followCamera.js
│
├── THEME LAYER                theme/useMapTheme.js
│   └── Day / Evening / Night      theme/mapThemes.js
│        interpolated in place — never `setStyle`
│
└── UI LAYER                   MapControl.jsx + mapControl/ui/*
    ├── location filter bar
    ├── theme + camera-mode controls
    ├── campus search
    ├── feature details card (with provenance)
    ├── campus data-coverage notice
    ├── selected-robot panel
    ├── legend
    └── WebGL-unavailable fallback
```

Environment geometry, campus geometry and operational overlays are separate
modules with separate lifecycles. No robot geometry is baked into the
environment, and the environment has no dependency on robots existing at all.
The campus and theme layers have no telemetry dependency either — asserted in
`__architecture__/robotLayerUnchanged.test.mjs` against the source, so a robot
moving cannot rebuild a campus layer or restart a theme transition.

---

## Multi-campus: one engine, N datasets

A campus is **data**. There is one importer, one classifier, one registry, one
set of Mapbox sources and layers, one camera, one theme system and one search
index, and every campus goes through all of them:

```
REGISTERED_CAMPUSES              campusRegistry.js — metadata + which files
        │
        ▼
buildCampus(entry)               the pipeline, written once, run per campus
        │
CAMPUS_GEOMETRY[Campus.code]     features · dataset · verification · notes
        │
resolveCampusDefinition(record)  + the DB centre → the renderable definition
        │
campusLayers · useCampusLayer · campusSearch · cameraModes · mapThemes
                                 none of which knows a campus code exists
```

Adding campus #3 is:

1. a `Campus` row (`code`, `name`, `centerLat`, `centerLon`) in the database;
2. a dataset under `campus/data/<campus>/`;
3. an entry in `REGISTERED_CAMPUSES` naming both.

There is no step 4. No renderer, no layer, no camera rule, no theme, no search
implementation and no `MapControl` logic changes, and
`__architecture__/campusMultiCampus.test.mjs` scans every source file under
`features/maps` to assert that no code branches on a campus id.

### Registered today

| code | name | datasets | verification |
|---|---|---|---|
| `RNSIT` | RNS Institute of Technology | OSM extract + user-supplied points | `VERIFIED_BY_USER` (project owner, 2026-08-23) |
| `jssate-bengaluru` | JSS Academy of Technical Education | OSM extract | `NOT_VERIFIED` — nobody has been |

The two are in deliberately different states, and the map says so per campus
rather than averaging them into one badge. Everything a campus reports — its
coverage notes, its outstanding-data request, its trust line — is **derived
from that campus's own import**, so a hand-written paragraph cannot go stale
against the data it describes.

### Selecting a campus loads it, and only it

`CAMPUS_REGISTRY` carries metadata only — name, aliases, city — so listing or
searching campuses touches no geometry. A campus's features reach the GPU when
`resolveCampusDefinition` is called for its record, which happens when it is
selected. World, country, state and city zoom push nothing, whether the build
holds two campuses or a hundred.

### Switching campus is a `setData`

Sources and layers are installed once per style load and are never rebuilt for
a campus change:

```
useCampusLayer install effect   deps: [map, isMapLoaded, environmentReady, …]
useCampusLayer data effect      deps: [definition] → pushCampusData()
```

So RNSIT → JSSATE → RNSIT adds no source, adds no layer, removes nothing, and
cannot recreate the Mapbox instance. Stale geometry, stale labels and duplicate
layers are structurally unavailable rather than cleaned up afterwards — asserted
against a fake style that **throws on a duplicate id**, exactly as Mapbox does.

---

## Campus geography: the contract, and what RNSIT actually has

RNSIT's campus geography comes from **two sources**, which meet only at the
semantic model in `campusRegistry.js`:

```
rnsit/rnsit-campus-osm.geojson          ──►  osmCampusImport          ──┐
  57 features → 54                                                      ├──► 65 features
rnsit/rnsit-campus-supplemental.geojson ──►  supplementalCampusImport ──┘   (+1 DB centre)
  11 locations → 10
```

**1. An OpenStreetMap extract** — `campus/data/rnsit/rnsit-campus-osm.geojson`,
classified by `campus/osm/osmCampusImport.js`. 57 source features become 54:
the boundary, 19 buildings, 16 roads, 8 paths, 2 landmarks, 8 facilities.

**2. User-supplied point locations** — `campus/data/rnsit/rnsit-campus-supplemental.geojson`,
classified by `campus/supplemental/supplementalCampusImport.js`. 11 supplied
locations become 10 features (one merged into OSM): the main gate, two
playgrounds, parking, a food court, three colleges, an innovation centre and a
department OSM does not carry. These are the **weakest** provenance the system
holds — someone who knows the campus pointing at where a thing is — and they are
`POINT_LOCATION` only. Neither source file can edit the other; a disagreement
between them is reported, never resolved by overwriting.

**It is real geometry, it has been checked by the project owner, and it is
still not a survey.** Those are three different claims and the system keeps all
three apart:

```
geometry       real, community-mapped, ODbL, held and rendered by us
provenance     OPEN_DATA_IMPORT / USER_SUPPLIED — where the coordinates came from
verification   VERIFIED_BY_USER — the owner checked them against the site
               (NOT `VERIFIED`, which is reserved for a survey; nothing here has one)
```

Every imported feature carries its `provenance`, its OSM element id, its
complete original tag set in `sourceTags`, and a `source` string naming the
dataset, the element and the licence — **and**, separately, `verification`,
`verifiedBy` and `verifiedOn`. Origin and confirmation are independent fields
and neither overwrites the other, which is the whole point: a feature that came
from OpenStreetMap still says OpenStreetMap after the owner confirms it, so it
can be re-derived, re-licensed and re-checked against its source forever.

The details card shows them as two rows — *Source: OpenStreetMap* /
*Campus verification: Verified by project owner* — for exactly this reason.
Collapsing them into one badge is how a confirmed feature ends up displaying
"NOT VERIFIED".

**The verification is one dated, attributed record**, in
`campus/verification/campusVerification.js`, applied at the registry merge point
by a pure array→array transform that passes geometry through by reference.
Importers still emit `NOT_VERIFIED` and always will: an importer classifies a
file, and no file has ever been to Bengaluru. Revoking the check is deleting one
object; widening it is editing one field.

The record also states what it does **not** cover, and that list is displayed:
the seeded DB centre (a repository row, not a place anyone walked to — it stays
`NOT_VERIFIED` and is the only unverified feature on the map), metre-level
positional accuracy of the imported vertices, drawn building heights, and every
gate access rule.

What makes it hold under pressure is the contract, not discipline:

- every feature must declare `provenance`, `source` and `verification`, or
  `validateCampusFeature` rejects it;
- `VERIFIED` without a `verifiedOn` date is rejected, and `VERIFIED_BY_USER`
  without both a `verifiedOn` and a `verifiedBy` is rejected — an unattributed,
  undated check is not a check;
- geometry is validated numerically and against the kind (a building must be a
  polygon), and an invalid feature is **excluded**, never best-efforted;
- absent capabilities are enumerated by name in `coverage.missing` — for RNSIT
  that is still **gates**, which OSM does not map here;
- the seeded `Campus.centerLat/centerLon` is cross-checked against the imported
  boundary (`centreWithinBoundary`), because two independent sources disagreeing
  about where the campus is would otherwise be invisible.

### What the importer will not do

It creates no geometry. Emitted `geometry` is the **same object** as the source
geometry — no reprojection, rounding, simplification or repair — asserted
position-by-position in `__architecture__/campusOsmImport.test.mjs`. It invents
no identity: an unnamed building stays "Unnamed building", is flagged
`nameIsDescriptive` and is never labelled.

Three source features are deliberately not rendered, each with a stated reason:
the campus node OSM duplicates inside its own boundary way, and two unnamed
part-footprints tracing the outline of RNS International School (extruding all
three produced coplanar faces fighting for the same pixels).

One tag conflict is reported rather than silently resolved: `way/151617521` is
`building=commercial` **and** `sport=cricket;football` + `surface=grass` over
13 338 m². It is drawn as ground, not as a seven-metre box over the playing
field, and the contradiction appears in its details card.

### Two heights, on purpose

The extract contains **no `height` tag on any feature**. So:

| field | meaning | RNSIT |
|---|---|---|
| `height` | measured, from the source | **absent everywhere** |
| `renderHeight` | how tall to draw the box | derived, always captioned |

`renderHeight` comes from `building:levels × 3.5 m` for the seven buildings that
have a level count, and a 7 m default otherwise, clamped for footprints small
enough that the default would render a pillar (the 26 m² Canara Bank cabin draws
at 4.6 m). The card shows *"Measured height: Not in source data"* beside
*"Drawn height: 10.5 m — estimated for rendering from building:levels × 3.5 m —
not a measured height"*. The schema enforces the pairing: a `renderHeight` with
no `heightBasis` is rejected.

### Campus precedence over the basemap

`CAMPUS_LAYER.VENDOR_CLIP` is a Mapbox `clip` layer fed the boundary polygon and
scoped to the `basemap` import, removing the vendor's 3D models and labels
**inside the campus and nowhere else**. Outside the perimeter Bengaluru keeps
its full skyline. Verified on the live map: `clip-layer-types: ['model','symbol']`,
`clip-layer-scope: ['basemap']`. Installation retries without the scope and then
degrades, reporting `vendorClipActive` — losing the clip costs de-duplication,
never the campus.

Because the campus now supplies its own names, `showPointOfInterestLabels` is
switched **off** at campus focus where geometry exists (it used to be switched
on, when vendor labels were the only identification available). A campus without
geometry keeps the old behaviour.

### A point is a location, not a building

Every supplemental feature is `geometryRole: POINT_LOCATION`. Nothing fabricates
a footprint, extent, height or floor count from a coordinate — and the schema
now **refuses** a `POINT_LOCATION` carrying a `renderHeight`, so it cannot
happen by accident later either. A role that disagrees with its geometry is
rejected in both directions.

That field is also the upgrade path (§23). A feature's identity is its `id`;
geometry is a separate, replaceable fact about it. When a real footprint arrives,
the feature keeps its id and swaps its geometry and role — label, search entry,
selection state and any operational reference all survive.

### Reconciling two sources

| Verdict | Rule | Fires on |
|---|---|---|
| `MERGED_WITH_OSM` | identical normalised name **and** ≤ 60 m | CANARA BANK ↔ `node/2146315474` (10 m) |
| `POSSIBLE_DUPLICATE` | ≤ 60 m, both **named**, and either a shared significant word or the same non-`UNCLASSIFIED` category | Food Court ↔ Canteen (41 m); Cyber Security Dept ↔ Civil & AIML Block (47 m) |
| distinct | everything else | the rest |

Proximity alone is never evidence: on a 24-acre site with 54 features almost
everything is within 60 m of something. Requiring a name match to merge is what
stops the map asserting that a food court *is* the canteen 41 m away — which
would delete a real location from an operations map. Two further guards removed
5 of 7 spurious flags in the first version of the rule: an **unnamed** footprint
has no identity to be a duplicate of, and `UNCLASSIFIED` matching `UNCLASSIFIED`
is an absence of information, not a similarity.

A merge does **not** rewrite the OSM record. `applyMergesToOsmFeatures` returns
a new array; the OSM feature keeps its geometry, provenance and verification and
gains a `corroboratedBy` record. Re-importing the extract from scratch produces
exactly what it produced before the second dataset existed — asserted by test.

### Co-location

RNS FIRST GRADE COLLEGE and RNS Evening College are supplied at the *same*
coordinate and the dataset declares it via `coLocatedWith`. Two markers stacked
pixel-for-pixel are a rendering artefact, not information — so the dependent
record surrenders its marker and its label, and keeps everything else: it is
still a campus feature, still searchable (subtitled *"shares a location"*), still
openable, and its coordinate is untouched. The host card lists it under
**Also at this location**.

### Campus boundary containment

Every supplied point is classified `INSIDE` / `OUTSIDE` / `UNCERTAIN` by
point-to-**edge** distance (not to vertices — a vertex-only measure would call a
point 2 m from the middle of a long segment "100 m from the boundary").

`UNCERTAIN` is anything within 25 m of the perimeter, because the boundary is
itself unverified OSM geometry: a point 1 m outside an unverified line is not
evidence the thing is off campus, it is evidence that we do not know. An
`OUTSIDE` point is never discarded — a main gate is outside the perimeter almost
by definition — it is classified, drawn, and reported on its card.

For RNSIT: 7 inside, 2 outside (Main Gate +33 m, Playground 1 +58 m), 2
uncertain (Parking Lot +1 m, CANARA BANK −22 m).

### Replacing OSM with a survey

Swap the importer for one emitting the same feature shape with
`provenance: SURVEYED` and a `verifiedOn` date. Layers, labels, search,
click-to-inspect, themes and camera do not change — none of them knows where
geometry came from.

---

## Themes

`Day / Evening / Night` are **configurations** (`theme/mapThemes.js`), not
conditionals. A theme change is never a style reload:

```
capture the CURRENTLY DISPLAYED values (mid-transition included)
    ↓  hand the vendor its light preset (Mapbox animates its own lighting)
    ↓  interpolate everything we own, frame by frame, in place
    ↓  notify consumers (campus layers, route layers) each frame
```

Nothing is added, removed or re-created, so a theme change **cannot** reset a
robot marker, a route, the selected robot, the camera or the terrain. That is a
property of not reloading, not something anyone has to remember.

**Evening uses the vendor's `dawn` preset, not `dusk`** — deliberately, and the
reason is in `mapThemes.js`. On the live map `dusk` reproduced the documented
low-contrast brown-mauve failure *and* dimmed the vendor's own place labels,
which at RNSIT are the operator's only building identification. `dawn` renders
the same golden low-sun quality at full label contrast. A theme is a viewing
mode, not a claim about the time of day.

Because Mapbox Standard seals its layers inside an import, `setPaintProperty`
cannot reach the buildings and roads actually rendering at RNSIT. Standard does
expose colour config knobs (`colorRoads`, `colorMotorways`, `colorGreenspace`,
`colorBuildingHighlight`, `colorPlaceLabelHighlight`) — confirmed present on the
live style — and each theme sets them. That is the only lever giving the road
hierarchy and building mass contrast at campus zoom.

---

## The seam

```
                    Robot state  (REST row / robot:update / merged live)
                              │
                              ▼
              world/robotWorldAnchor.js          ← ONE transform, no other
                  toRobotWorldAnchor()
                              │
                    RobotWorldAnchor
                    { position { lng, lat, altitude }
                      rotation { yaw, pitch, roll }
                      scale }
                              │
                              ▼
              operational/robotVisual.js
                    toRobotVisual()
                              │
                       RobotVisual
                              │
              operational/robotRendererRegistry.js
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
        renderers/robotMarker2d…   '3d' renderer
              CURRENT                 FUTURE — not registered
```

### What a future 3D robot milestone costs

1. Write one module implementing the renderer contract.
2. `registerRobotRenderer('3d', factory)`.
3. Change the `representation` prop passed to `useRobotStream`.

### What it does **not** touch

telemetry · socket contract · robot state · task state · assignment engine ·
selection state · the coordinate model · the world transform · the camera ·
route rendering · mission pins · the location filter hierarchy · the
environment layer.

That claim is executable, not aspirational — `__architecture__/` registers a
recording double under `'3d'` and asserts it receives byte-identical world
state to the 2D renderer. Run it with `npm run test:arch`. The double is a
call recorder with no geometry of any kind; it is not a placeholder mesh.

### Rules the seam depends on

- **One position formula.** Nothing outside `robotWorldAnchor.js` converts
  robot state to a world position. Renderers never report position back —
  `recenter` and the follow-camera read the last `RobotVisual` the hook sent,
  not a marker's coordinate.
- **Selection is application state.** `selectedRobotId` lives in `MapProvider`.
  Markers raise an id; they never own selection. A 3D robot raising the same id
  inherits every downstream behaviour unchanged.
- **Labels are an overlay, not part of the robot.** Identity chip, battery bar
  and status glyph belong to the operational layer, so they survive a
  representation change untouched.
- **The camera follows a world transform**, never a particular kind of visual
  object.
- **No speculative 3D properties.** `RobotVisual` carries the semantic state
  both representations need and nothing else. A test asserts `wheelRotation`,
  `bodyMesh`, `lidarMesh` and friends are absent.
- **The map is a consumer.** It visualizes state and is never a source of it.
  The assignment engine — candidate generation, feasibility, cost, solver,
  commitment, fencing, outbox, supervision, reconciliation, settlement — was
  not touched by this milestone and must not be, for visual reasons.

---

## The depth decision (2D marker in a 3D scene)

The marker is **one element anchored at the robot's exact coordinate**, split
into two halves that answer the depth question differently:

| half | behaviour | why |
|---|---|---|
| **ground plane** — contact shadow, selection ring, vehicle icon | compressed by `cos(pitch)`, rotated by `heading − camera bearing` | reads as painted on the ground; direction shown is the direction actually travelled, at any camera angle |
| **screen-facing** — id chip, battery, status, leader line | always upright | stays legible at any tilt, where a ground decal would not |

Consequences worth knowing:

- Mapbox projects the anchor element every frame, **including onto terrain**, so
  the marker stays synchronised with the robot's real world position.
- DOM markers draw above the WebGL canvas, so 3D buildings never hide a robot.
- Ground compression is floored at `0.42` — below roughly a third the vehicle
  becomes an unreadable sliver, and legibility beats the last few degrees of
  geometric purity. The contact shadow and chip carry position and identity at
  extreme tilt regardless.
- **Heading is a world fact** (degrees clockwise from true north).
  `worldYawToScreenYaw` exists because once the camera can rotate, north is no
  longer screen-up. A future 3D renderer must **not** call it — a mesh uses the
  world yaw directly and the 3D camera applies bearing itself.

---

## Route progress: derived here, because nothing sends it

The map drew *travelled* and *ahead* as two differently-styled lines, split at
`task.pathIndex`. That index is real — the simulation holds one, the routing
service holds one — and **nothing sends it to the browser**. `robot:update`
carries `robotId, lat, lon, battery, status, speed, isOnline, lastSeenAt,
heading`; `TASK_ASSIGNED` carries both paths and no progress. So the split index
was `0` for the entire life of every task: *travelled* was a zero-length stub
and *ahead* was the whole route, from assignment to completion. Two colours,
one meaning.

Progress now comes from the robot's own streamed position, projected onto its
route by `operational/routeGeometry.js`. Nothing was asked of the backend and no
navigation semantic changed: the position is already streamed, the route is
already held, and where a point falls on a polyline is arithmetic.

Three properties make it safe to draw:

| | |
|---|---|
| **aligned** | every emitted coordinate is a source vertex or a point *on* the source line — nothing is smoothed, snapped or nudged |
| **continuous** | the projected point is the last vertex of *travelled* and the first of *ahead*, so the halves meet exactly. A vertex-index split leaves a gap that reads on a pitched map as the route breaking |
| **monotonic** | the state machine carries a floor index, so a route that retraces itself (a drop leg back along the pickup's service road) cannot drag the travelled line backwards while the unit moves forwards |

The pickup→drop transition is **observed**, because nothing announces it: the
unit reaching the end of the pickup leg latches it onto the drop leg, and a
session that never saw the transition (a reload mid-task) recognises a unit
sitting on the drop path. A segment the backend *states* — `TASK_ASSIGNED`'s
phase, a `REROUTED` message — always wins, once, and then observation resumes.

**Off its own route, nothing is invented.** Beyond `MAX_ROUTE_OFFSET_M` (40 m,
chosen against this campus: its service roads run 15–25 m apart) the nearest
point of a route says where the *route* is, not where the unit has got to. The
leg is drawn whole, progress reports `null`, and the operator is told.

### A route that contradicts the campus is reported, never rendered away

`operational/routeValidation.js` checks each drawn route against the campus
geometry — footprints crossed, steps crossed, boundary left, unit off route —
and returns *findings*. It has no map, no source and no setter; a test asserts
it cannot reference one. The line is drawn exactly where the route data puts it
and `RouteIssuesNotice` says what is wrong with it, because nudging it off the
footprint would be falsifying the route and drawing it underneath would be
falsifying it more quietly.

Validation runs when the **route** changes, never when progress does — the
polyline is what is being checked and it does not move as the unit travels.

---

## Camera: fly flat, then tilt

The focus camera moves in **two stages**, and this is a correctness
requirement, not styling:

1. **Travel flat** to the target (`pitch: 0`), with an explicit duration from
   `flightDurationForZoomDelta`.
2. **Tilt on arrival** — `easeTo({ pitch })` over ~900 ms, once stationary.

A single *pitched* `flyTo` across ~15 zoom levels (world → campus) with terrain
enabled resolves ground elevation continuously along a long arc, and reliably
ended with the camera pointing at atmosphere: a uniform sky-coloured viewport,
no tiles, no robots, until some later camera command recomputed it. Travelling
flat removes the elevation/pitch interaction from the long move; the short tilt
afterwards happens over a stationary point where it cannot go wrong.

Two supporting rules:

- **Terrain is installed before the first flight.** The focus effect waits on
  `environmentReady`. A flight started while `setTerrain` is still pending
  computes its path against a flat world and then has the ground moved under it.
- **Flights are duration-bounded.** Left to Mapbox's `speed`/`curve` model a
  world→campus move ran for many seconds, fetching and discarding a batch of
  tiles at every intermediate zoom — which is what a user reads as the map
  glitching on load.

Pending tilts carry a token so switching filters mid-flight cannot tilt toward
an abandoned target.

> Historical note: before this milestone the world→campus flight never actually
> ran. `isStyleAboutToSwitch` was permanently true whenever a campus was
> selected, because the style-switch effect that owned `styleModeRef` was dead
> code (`wantMode` was the literal `'default'`). Removing that dead effect
> activated a camera path that had never executed, which is how these
> constraints were discovered.

---

## Follow: two clocks, deliberately

```
telemetry  ──►  followTarget (a value)          ~ every 2 000 ms
                      │
                      ▼
frame      ──►  stepFollowCamera()  ──► camera  ~ 60 times a second
```

Every `robot:update` used to call `map.easeTo({ center, duration: 1200 })`.
Telemetry arrives about every 2 000 ms, so each ease was still running when the
next replaced it — and an interrupted `easeTo` does not blend, it restarts from
wherever the camera reached with a fresh ease-in. The camera accelerated, was
cut off, and accelerated again, forever. Turning Follow on fired a second,
competing 900 ms ease at the same target.

Separating the clocks is the whole fix: telemetry writes a **value**, so it
cannot interrupt anything, and a frame loop closes the gap. The smoothing is
exponential rather than a tween because a tween needs an endpoint and a moving
target invalidates one every tick; each frame closes `1 - e^(-λ·dt)` of the
remaining gap, which is frame-rate independent, converges on a stationary unit
and trails a moving one by a constant distance.

- **Entering** is one deliberate `easeTo` — travel to the unit, settle at a
  bounded-comfortable pitch — and the loop takes over on `moveend`. That order
  matters: `jumpTo` cancels an in-flight `easeTo`, so starting the loop first
  would cut to the robot instead of travelling to it.
- **Leaving** is instant, in one statement.
- **A dead band** (0.5 m) stops a parked unit's GPS jitter from shivering the
  camera, and lets the loop stop itself so an idle follow costs no frames.
- **`maxDtMs`** clamps the delta a backgrounded tab resumes with, so it flies
  rather than teleports.
- **North stays screen-up.** Bearing smoothing exists and is tested — through
  the short arc, so 350° → 10° is 20° — and is off by default, preserving the
  decision in `cameraModes.js`.

---

## Operational semantics: what the fleet has business with

`campus/semantics/campusOperational.js` derives, for every campus feature, an
`operationalRole` and a priority — from fields the feature **already declares**
(its kind, its category, the `kind` word the supplemental dataset supplied, an
OSM tag, and as a last stage the name the source itself asserts). Never from
position, never from size, never from a hard-coded id, and every profile records
`operationalBasis` so the derivation shows on the card rather than passing as
source data. Delete every rule and the map is still geographically correct —
every feature simply becomes `NONE`.

It drives three things and nothing else: marker size (`poiScale`, capped at
1.45× so no POI outgrows the robot beside it), label collision rank
(`labelRank` — the old `symbol-sort-key` was `labelPriority` *inside a layer
already filtered to one priority*, i.e. a constant, so collisions were resolved
by array order), and what recedes in Operations mode.

**`CHARGING_POINT` and `DOCKING_STATION` have rules and zero features**, because
no dataset says where a charger or a dock is. A test asserts the count is zero.
That is what keeps "prepared for" from drifting into "pretended".

Gates are first-class: `GATE_ACCESS_CHANNELS` (vehicle / pedestrian / service /
emergency) plus a status, every one of them explicitly `UNKNOWN` on this campus,
carried rather than omitted — an absent field reads as "nobody thought about
it", an `UNKNOWN` reads as "this is a known gap", and only the second gets
filled in. The schema refuses access rules on anything that is not a gate.

---

## Operations mode is a number, not a branch

`campusStyleForTheme(theme, reveal, emphasis)`. Operations is a *way of looking
at* the campus, so it lives where every other viewing decision lives: a value
interpolated in place, on layers that already exist. No layer is added, removed,
hidden or re-filtered, so entering Operations cannot disturb geometry, a robot,
a route or the selection — the same property a theme change has, for the same
structural reason.

It steps the building mass and the ground back one notch, recedes the POIs the
fleet has no business with (floor 0.45 — still clearly a marker), and quiets the
detail label band. **The roads are untouched**, because they are how an operator
reads where a unit can go. Nothing is hidden; a test asserts no layer gains a
`visibility` switch.

---

## Performance contract

- The environment effect depends on the map instance and the style epoch only.
  It has no robot, telemetry or selection dependency, so a `robot:update`
  **cannot** re-run it. Terrain, buildings and sky are never rebuilt by a robot
  moving.
- Telemetry updates are incremental and imperative: build a `RobotVisual`, call
  `renderer.update`. No marker is recreated, no source is re-added, no layer is
  re-added.
- Camera events (`zoom`, `pitch`, `rotate`) only write CSS transforms onto
  already-mounted elements. Reprojection, not reconstruction.
- Selection touches only the two robots whose selected-ness changed.
- Position tweens are cancelled on `destroy`, and the renderer's `dispose`
  tears down every element and DOM listener it created.
- **Routes are redrawn only when what is drawn changes.** `upsertRoutes` carries
  a signature over task, path revision, segment, on-route state and progress; an
  identical signature returns before touching a source. A stationary unit used
  to push identical GeoJSON into four sources twenty times a minute.
- **Route validation runs on a path revision, not on a tick.** ~19 000 segment
  tests per leg, run on assignment and on replan.
- **The search index is two memos**, not one. The campus half depends on the
  campus and the fleet half on the fleet; a telemetry tick no longer re-derives
  65 label anchors to change one robot's status string.
- **Only the selected unit's route progress reaches React state.** Every other
  unit's progress lives beside its route entry.

---

## Rendering stack

Mapbox GL JS v3 only. `three` is listed in `package.json` but is **imported
nowhere** and was never wired into anything; this milestone did not start using
it. No second rendering framework was introduced — Mapbox Standard supplies the
3D environment from the same renderer, tiles and vendor already in the app.

If a future 3D robot renderer needs a different stack, that is a decision for
that milestone. The seam is deliberately agnostic: `world/` and `operational/`
are pure modules with no rendering dependency, so they can be consumed by
whatever draws.

---

## Known gaps (data, not code)

Most of the list below is written from RNSIT, the campus with the most data.
Each gap is reported **per campus** from that campus's own import
(`missingGeometryRequestFor(code)`), so the sentences differ where the campuses
do. JSSATE's differences are called out first.

### JSSATE specifically

- **Nobody has checked JSSATE against the physical site.** Every one of its
  features is `NOT_VERIFIED`. Its geometry is real, community-mapped ODbL data,
  and being present in OpenStreetMap is not a verification — the map does not
  upgrade one into the other. The project owner's RNSIT confirmation is a dated,
  attributed record scoped to RNSIT and does not reach it.
- **No gate, entrance or barrier is mapped anywhere on the JSSATE site.** The
  `gates` capability is reported MISSING rather than filled by promoting a road
  end or a parking entrance into an entrance. How a fleet gets on and off the
  site is unknown.
- **No supplemental dataset exists for JSSATE.** That is fine and nothing was
  fabricated to stand in for one. The OSM/user-supplied separation is the reason
  there are two importers; a campus with nothing in the second category reports
  nothing there.
- **One imported feature lies outside the JSSATE boundary** — Omkar Ashram
  (`way/1120154290`), a temple compound that shares a border with the campus. An
  Overpass query is a bounding box, not a campus. It is drawn, because it is
  real correctly-attributed geometry, and it is reported as outside on its
  details card and in the coverage notice rather than deleted. Three further
  features the extract swept in (two city postal-code relations and the
  neighbouring Turahalli reserve forest) carry no tag this map understands and
  are excluded with a stated reason.
- **Only one JSSATE building records `building:levels`.** The other ten draw at
  the conservative rendering default. See "Two heights, on purpose".

### Both campuses

- **No campus geometry here is *surveyed*.** The owner's confirmation is a
  first-hand check by the person who runs the site, and it is not a
  georeferenced survey: it settles *what* each feature is and *where* it is on
  the campus, and puts no tolerance on the imported vertices. `VERIFIED` is
  reserved for a source that does; nothing holds one.
  `missingGeometryRequestFor(code)` states what would be needed, per campus.
- **The seeded campus centre is the one unverified feature on the map.** It is a
  row in this repository's database, not a place anyone walked to. It stays
  `SEED_RECORD` / `NOT_VERIFIED` and is cross-checked against the imported
  boundary (`centreWithinBoundary`) rather than asserted.
- **Gate access rules are entirely unknown**, and this is now the highest-value
  outstanding record on the list. The gate's *location* is supplied and
  confirmed; whether it admits a vehicle, a pedestrian, a service vehicle or an
  emergency vehicle, and whether it is open, are four explicit `UNKNOWN`s. A
  route planned through a gate closed to vehicles is a route that does not
  exist. The gate is available to future routing as a semantic feature; no route
  uses it and the solver is untouched.
- **The supplied locations are still point locations.** Ten of them. Their
  positions are confirmed; their shape, extent and height are unknown, and
  nothing derives a footprint or a volume from a coordinate.
- **No charging point and no docking station exists in any dataset.** Both roles
  are declared in the operational vocabulary and both carry zero features; no
  parking apron has been quietly reinterpreted as a dock.
- **No measured building heights.** See "Two heights, on purpose" above. Drawn
  heights are drawn heights.
- **Buildings the extract does not contain are absent inside the campus.**
  The vendor clip removes the basemap's own models inside the boundary, so any
  structure OSM has not mapped in this file is simply not drawn there. That is
  the intended trade (§6: no duplicate footprints) and the honest one, but it
  means campus completeness is now bounded by the extract rather than by the
  basemap.
- **The basemap carries no building identity.** Measured on the live map: a
  clicked Mapbox Standard building returns `height`, `min_height` and `group`
  and no name, class or id. Outside the campus, clicking a building still cannot
  say which building it is, and the details card says exactly that.
- **No obstacle overlay.** Obstacles are not currently rendered on the map and
  were not added here; `ROBOTX_OBSTACLE_ALERT_IMPLEMENTATION_PLAN.md` is an
  unimplemented plan, not a contract this milestone consumes.
- **No altitude channel.** `telemetry.handler.js` persists lat/lon/heading and
  no elevation. The anchor carries `altitude` and an explicit
  `altitudeSource: 'ground-assumed'` rather than hard-coding `z = 0`, so a 3D
  renderer gets real elevation the day telemetry sends it.
- **`VITE_MAPBOX_STYLE_3D`** exists in `.env` set to `dark-v11`, is read by no
  code, and predates this milestone. It is left unwired deliberately: honouring
  it at its current value would silently downgrade the map to the flat fallback
  style.

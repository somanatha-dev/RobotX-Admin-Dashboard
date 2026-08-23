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
│   ├── route lines (todo / travelled + directional flow)
│   └── mission pins (pickup / drop)
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

## Campus geography: the contract, and what RNSIT actually has

RNSIT's campus geography comes from **two sources**, which meet only at the
semantic model in `campusRegistry.js`:

```
rnsit-campus-osm.geojson          ──►  osmCampusImport          ──┐
  57 features → 54                                                ├──► 65 features
rnsit-campus-supplemental.geojson ──►  supplementalCampusImport ──┘     (+1 DB centre)
  11 locations → 10
```

**1. An OpenStreetMap extract** — `campus/data/rnsit-campus-osm.geojson`,
classified by `campus/osm/osmCampusImport.js`. 57 source features become 54:
the boundary, 19 buildings, 16 roads, 8 paths, 2 landmarks, 8 facilities.

**2. User-supplied point locations** — `campus/data/rnsit-campus-supplemental.geojson`,
classified by `campus/supplemental/supplementalCampusImport.js`. 11 supplied
locations become 10 features (one merged into OSM): the main gate, two
playgrounds, parking, a food court, three colleges, an innovation centre and a
department OSM does not carry. These are the **weakest** provenance the system
holds — someone who knows the campus pointing at where a thing is — and they are
`POINT_LOCATION` only. Neither source file can edit the other; a disagreement
between them is reported, never resolved by overwriting.

**It is real geometry and it is not a survey.** Those are different claims and
the system keeps them apart:

```
geometry       real, community-mapped, ODbL, held and rendered by us
verification   NOT_VERIFIED — no survey, no ground truth, no site plan
```

Every imported feature carries `provenance: OPEN_DATA_IMPORT`, its OSM element
id, its complete original tag set in `sourceTags`, and a `source` string naming
the dataset, the element and the licence. The `CampusDataNotice` leads with
*"Campus geometry: OpenStreetMap · Unverified"*, and every details card repeats
it. That is deliberate: generic vendor blocks at least *looked* generic —
correctly-shaped, correctly-named OSM footprints look exactly like a survey.

What makes it hold under pressure is the contract, not discipline:

- every feature must declare `provenance`, `source` and `verification`, or
  `validateCampusFeature` rejects it;
- `VERIFIED` without a `verifiedOn` date is rejected;
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

- **No campus geometry here is verified.** The OSM extract is real and it is
  unchecked against the physical site. Every feature is `NOT_VERIFIED`, the map
  says so on screen, and `MISSING_GEOMETRY_REQUEST` states what a verification
  pass would need.
- **The gate is user-supplied, not surveyed.** The OSM extract contains no
  `barrier=gate`, `entrance=*` or access-control node anywhere on the site; the
  supplemental dataset supplies one. Campus geometry coverage is therefore
  complete — but it is complete because a person said where the gate is, and its
  access properties (vehicle / pedestrian / service / emergency, opening status)
  are all explicitly `UNKNOWN`. It is available to future routing as a semantic
  feature; no route uses it and the solver is untouched.
- **User-supplied locations are the least verified thing on the map.** Ten point
  locations with no external record behind them. They are labelled as such in
  the details card, in the on-map notice and in the legend ("Campus location
  (point only)").
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

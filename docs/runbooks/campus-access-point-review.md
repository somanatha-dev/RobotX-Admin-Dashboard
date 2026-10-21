# Campus access points: reviewing a candidate into a task location

The Create Task form offers declared **points** only. Campus destinations that exist in the
data only as a building **footprint** (on RNSIT: ECE Department, Main Building, the two
canteens, …) cannot be chosen until someone confirms where a robot can actually hand over
there. This runbook is that confirmation.

## What a candidate is

`Backend/tools/campus/generateAccessCandidates.js` proposes up to three points per footprint.
Each one is a point **on the permitted sidewalk graph** (`footway`, `path`, `service`) facing
the building. It is the projection of a vertex or edge midpoint of the outline onto the
boundary-contained network. It has been checked with the engine's own instruments: delivery
domain, both router gates, and routes to every declared campus location.

What a candidate is **not**: an entrance. The façade it faces may be a blank wall, a locked
door, a fence or a flight of steps. Nothing in the data can tell, so every candidate needs a
person on site.

| Status | Set by | Offered as a task location? |
|---|---|---|
| `candidate` | generator: all automated checks passed | no |
| `needs_review` | generator: checks passed, but see `flags` | no |
| `rejected` | generator (`rejections`) or a reviewer | no |
| `verified` | **a person**, with a `review` | **yes** |

Flags a reviewer should read first:

- `LONG_FRONTAGE_GAP`: the façade is more than 15 m from the sidewalk.
- `NEAR_DECLARED_POINT`: within 15 m of an existing location. It may be the same place. On
  RNSIT, a Canteen candidate is 3.5 m from "Innovation Center", and an auditorium candidate
  is 4.1 m from "RNSIT Food Court".
- `SHARED_FRONTAGE`: another building's candidate is within 5 m.
- `PARTIAL_CONNECTIVITY`: some endpoints are on another part of the network.

## Review one on site

1. Find the candidate in `<campus>-campus-access-candidates.geojson` at the repository root.
   Its coordinate is `[lon, lat]`, and `derivation.facade` is the wall point it faces. Note
   which way it lies on (`service` ways carry vehicles; `footway` and `path` do not).
2. Stand at the coordinate and answer each question **from what you see**, not from the map:

   | # | Check | Answer |
   |---|---|---|
   | C1 | A ground robot can **stop here safely** without blocking the path or a vehicle lane | yes / no |
   | C2 | The building's usable entrance or handover spot is reachable from here **without steps, a kerb, a gate or a locked door** | yes / no |
   | C3 | This point **serves the building the entry names**, not a neighbour | yes / no |
   | C4 | Anything else a reviewer should know: a ramp, opening hours, a security desk, a second entrance | note |

3. Decide:
   - **C1, C2 and C3 all "yes"** → `verified`.
   - **Any "no"** → `rejected`, saying which one in `note`.
   - **Unsure** (closed building, no access today) → leave the status as it is, or set
     `needs_review`, and record why in a `review` block. Nothing is offered until it is
     `verified`.
4. Record it in the **repository-root** file. Never edit the Frontend copies. Write the
   answers into `note` in the order C1–C4:

   ```json
   "status": "verified",
   "review": {
     "by": "<your name>",
     "on": "<YYYY-MM-DD, the day you were on site>",
     "method": "OWNER_SITE_CHECK",
     "label": "<only when required — see Names below>",
     "note": "C1 yes: stops on the footway clear of the door. C2 yes: level entrance 4 m away. C3 yes. C4: none."
   }
   ```

   - `method` is `OWNER_SITE_CHECK`, or `SURVEY` for a georeferenced survey. Anything else is
     refused.
   - `by` and `on` are required; `on` must be a real `YYYY-MM-DD` date. Never fill them for
     a review that did not happen.
   - If the real entrance is not among the candidates, add your own Feature with the same
     properties, `derivation: { "method": "REVIEWER_SUPPLIED" }` and a `review`.
5. Regenerate the three copies of the register, then check (from the repository root):

   ```
   cd Backend  && node tools/campus/generateAccessCandidates.js --write --campus RNSIT
   cd ../Frontend && npm run audit:locations && npm run test:arch
   cd ../Backend  && npx jest tests/engine/campusAccessCandidates.test.js
   ```

   - **Regeneration** keeps every entry that has a `review`, and refuses to run if an entry
     says `verified` without a valid one. It marks a reviewed entry `stale` if the campus
     data no longer produces it.
   - **`audit:locations`**: the pickup and drop counts rise by one per admitted point, and the
     building moves from `NO_DECLARED_POINT` to `SERVED_BY_ACCESS_POINT`. A `verified` entry
     that was **not** admitted is listed as `INVALID_ACCESS_RECORD` with the reason.
   - **`test:arch`** fails while any `verified` entry is refused, so a recording mistake cannot
     be committed unnoticed. Fix the entry (usually a missing `label`) and regenerate.
   - **The backend test** re-checks every entry, verified ones included, against the
     current campus data and network.

   The point is selectable in the deployed dashboard only after the change is committed and
   the frontend is rebuilt.

## Development mode: unverified candidates in the form

To build and test the software before any site review, set
`VITE_UNVERIFIED_CAMPUS_LOCATIONS=true`, for example in the gitignored
`Frontend/.env.development.local`, and run `npm run dev`. Create Task then also offers the
`candidate` entries of the buildings in `access/developmentCandidates.js` (the six RNSIT
departments):

- They appear as `"<building> — point <n> (unverified)"`, recorded `NOT_VERIFIED`, and the
  form shows a development-mode notice.
- `needs_review`, `rejected` and unconfigured buildings stay out, and the name rule below
  still applies.
- A production build (`vite build`, `NODE_ENV=production`) ignores the flag.
- These are **not** certified delivery points. Only a `verified` entry with a review is one.

To see the counts with the flag on, run
`VITE_UNVERIFIED_CAMPUS_LOCATIONS=true npm run audit:locations`.

## Names in the pickup and drop lists

Pickup and drop are chosen by name, so the importer refuses any name an operator could
confuse:

- A verified point is offered as the building's name, or as `"<building> — <label>"` when
  `review.label` is set.
- **`label` is required** when the building's name is shared by another footprint on the
  campus. RNSIT maps **two different buildings as "Canteen"**.
- **`label` is required** for a second verified point on the same building.
- A name may not repeat a **declared location**. The Canara Bank footprint would clash with
  the declared "Canara Bank".
- A name may not repeat **another building's** access point. Names are compared ignoring
  case and spacing. Every entry in a clash is refused, not just the second one.

**Proposed canteen labels.** These come from map evidence only. Confirm them on site, and
use what people on campus actually call the place if that differs:

| Footprint | OSM tags | Map evidence | Proposed name |
|---|---|---|---|
| `osm-way-204638928` | `amenity=food_court`, `opening_hours=Mo-Sat 08:00 to 16:00` | 8 m from the Basketball Court; 23 m from the Canara Bank building | **Canteen — near Basketball Court** |
| `osm-way-1486312655` | `amenity=fast_food` (cafeteria), **`level=-1`** | shares a wall with the RNSIT auditorium; "Innovation Center" lies 0.9 m from its outline | **Canteen — beside Auditorium** |

If neither description holds on site, use neutral names instead: **Canteen — Building A**
(`204638928`) and **Canteen — Building B** (`1486312655`). `level=-1` means OpenStreetMap
places the second canteen **below ground level**, so check C2 (step-free access) with
particular care there. Its two flagged candidates may also be the "Innovation Center"
location; if so, reject them rather than create a second name for one place.

## Still owner decisions (not settled by this tool)

- **R13 `site.snapRadiusM`** has no value anywhere. Until the physical fleet declaration
  sets it, the physical router refuses **every** route (`NO_SNAP_RADIUS`). Candidates are on
  the graph (0 m connector), so any positive value admits them. Playground 2, an existing
  location, needs about 60 m on the physical network.
- **JSSATE** has no operating region, so its candidates can be reviewed but offer nothing.
- **Hostels** are not destinations: the operational model gives `RESIDENTIAL` no role. The
  three RNSIT hostels are also all named just "Hostel" in OSM.

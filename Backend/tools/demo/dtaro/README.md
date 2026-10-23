# DTARO obstacle-awareness demonstration

Zone-scoped obstacle alerts for the **simulated** fleet. The flow is: a robot reports an obstacle, the server resolves its zone, the alert goes to that zone's room, and each receiver checks it against its commanded route. Background is in `docs/audits/dtaro-zone-coordination/`.

## Run it (offline, about 45 s)

```
cd Backend
node tools/demo/dtaro/runDtaroDemo.js            # full run: the crossing robot drives to the obstacle
node tools/demo/dtaro/runDtaroDemo.js --quick    # stops after the relevance verdicts (about 3 s)
node tools/demo/dtaro/runDtaroDemo.js --json out.json   # also writes the timeline and checks
```

The script exits `0` only if every check passes.

**What it prints:**
- the spatial authority;
- the obstacle, with its cell and zone;
- each robot's zone room;
- each commanded route;
- `ALERT_CREATED`, with its recipients, as the dashboard socket receives it;
- each robot's `OBSTACLE_RELEVANCE` verdict;
- a summary and a list of PASS/FAIL checks.

**Real in this run:**
- The shipped `initSocketServer`, with robot AUTH, TELEMETRY and the DTARO handlers.
- `VirtualRobot` clients that connect over websockets on 127.0.0.1.
- A SUPER_ADMIN dashboard socket.
- The RNSIT map from the V1 bootstrap (`intendedWorld()`: 64 res-11 cells, **one** zone `rnsit-z1`).
- Routes on the RNSIT campus walkway network.

**This is not `server.js` and not a full-stack test.**

**Not real in this run:**
- There is no express app or REST.
- There is no `configService` bootstrap. The "pinned snapshot" is a hand-built object holding only `spatial`.
- There is no `SimulationEngine` or `commission()`; the robots are constructed directly.
- Pairing is skipped: session tokens are pre-seeded.
- There is no database. Prisma is replaced by an in-memory stand-in, and the process is pinned to an unreachable `DATABASE_URL`.
- There is no engine. Routes arrive through the legacy `TASK_ASSIGN` dispatch, which builds the same `task.stops` that an engine OFFER builds.
- The second region, `SYNTHETIC-R2`, is labelled as synthetic. Its zone deliberately reuses the label `rnsit-z1` to show isolation between regions. JSSATE has no engine region.

## Use it in the running server

Two environment variables turn it on. Both are off by default.

| Variable | Effect |
|---|---|
| `DTARO_ZONE_ALERTS_ENABLED=true` | Turns on the zone-room path. `OBSTACLE_REPORT` is resolved against the pinned published map (`app.locals.config.spatial`). If no map is pinned, the report fails closed. Simulated robots join `dtaro:region:<regionId>:zone:<zoneId>` at AUTH and on every telemetry frame. When the variable is unset, the legacy path runs unchanged. |
| `SIM_DTARO_SCENARIO=tools/demo/dtaro/rnsit-dtaro-scenario.json` | Simulated robots sense the scenario's fixed obstacles within `senseRadiusM` and stop sending random self-reports. Physical robots never load it. |

**What you see in the dashboard event log (SUPER_ADMIN):**
- "Obstacle reported by … — alerted A, B in zone …"
- one line per recipient: either "on its commanded route — flagged, no reroute (V1)" or "not on its commanded route — no change"
- refused reports, with the reason

**Limitation of the RNSIT map:** with the current RNSIT map (one zone), every simulated robot on campus is in the same room. The relevance check is what separates affected robots from unaffected ones. The four-zone RNSIT proposal (`RNSIT_ZONE_MAPPING_PROPOSAL.md`) is **not** published and is not used.

## Full-stack run (real `server.js`, real engine, disposable PostgreSQL)

This section has **not been executed yet.** It is the procedure for running the full stack. Every step touches only a new cluster under `%TEMP%`, on port 55470:
- never 5432 (your Windows cluster);
- never 5433 (Docker LOCAL `robotx`);
- never Neon.

Configuration comes from a disposable env file named by `ROBOTX_ENV_FILE`. The LOCAL file (`~/robotx-secrets/robotx-local.env`) is therefore never loaded, so no Mapbox token, Google client, LOCAL secrets or LOCAL admin reach this run.

Run in PowerShell, from `Backend`.

```powershell
# 0. Paths (outside the repository and OneDrive)
$SP   = "$env:TEMP\robotx-dtaro-fullstack"; $PG = "C:\Program Files\PostgreSQL\18\bin"
$URL  = "postgresql://dtaro@127.0.0.1:55470/robotx_dtaro_demo"
if (Get-NetTCPConnection -LocalPort 55470 -State Listen -ErrorAction SilentlyContinue) { throw "55470 in use" }
New-Item -ItemType Directory -Force $SP | Out-Null

# 1. Disposable cluster + schema
& "$PG\initdb.exe" -D "$SP\pgdata" -U dtaro -A trust -E UTF8 --locale=C
Start-Process "$PG\postgres.exe" -ArgumentList "-D","$SP\pgdata","-p","55470","-c","listen_addresses=127.0.0.1" -WindowStyle Hidden
& "$PG\pg_isready.exe" -h 127.0.0.1 -p 55470
& "$PG\createdb.exe" -h 127.0.0.1 -p 55470 -U dtaro robotx_dtaro_demo
Get-ChildItem prisma\migrations -Directory | Sort-Object Name | ForEach-Object {
  & "$PG\psql.exe" -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55470 -U dtaro -d robotx_dtaro_demo -f "$($_.FullName)\migration.sql"
  if ($LASTEXITCODE -ne 0) { throw "migration $($_.Name) failed" } }

# 2. Disposable configuration (fresh secrets; nothing from the LOCAL file)
$hex = { -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) }) }
@"
NODE_ENV=development
HOST=127.0.0.1
PORT=3100
FRONTEND_URL=http://localhost:5174
JWT_SECRET=$(& $hex)
PRIVACY_IDENTITY_KEY=$(& $hex)
PRIVACY_SURROGATE_SECRET=$(& $hex)
SEED_ADMIN_EMAIL=dtaro-demo@local.test
SEED_ADMIN_PASSWORD=$(& $hex)
PHYSICAL_FLEET_ENABLED=false
AGENT_MTLS_REQUIRED=false
DTARO_ZONE_ALERTS_ENABLED=true
SIM_DTARO_SCENARIO=$((Resolve-Path tools\demo\dtaro\rnsit-dtaro-scenario.json).Path)
"@ | Set-Content -Encoding ascii "$SP\dtaro.env"
$env:ROBOTX_ENV_FILE = "$SP\dtaro.env"; Remove-Item Env:ROBOTX_ENV -ErrorAction SilentlyContinue

# 3. Guard: refuses non-loopback AND the canonical LOCAL database (the V1 launcher's own
#    check refuses only port 5432, so it would accept 127.0.0.1:5433/robotx).
$env:DATABASE_URL = $URL
node -e "process.exit(require('./src/config/environmentGuard').requireDisposableTarget() ? 0 : 78)"
if ($LASTEXITCODE -ne 0) { throw "not a disposable target" }

# 4. Seed the V1 world (region, zone rnsit-z1, 64-cell cover, shard, depot, six sims; publishes + pins)
node tools/demo/seedV1Demonstration.js --database-url $URL --fleet baseline

# 5. Start the real server.js in V1 mode (engine, simulator, in-memory KV, Redis off)
node tools/demo/startV1Server.js --database-url $URL --port 3100 --host 127.0.0.1
```

**Dashboard.** Start it in a second shell from `Frontend`:

```powershell
$env:VITE_API_URL = "http://127.0.0.1:3100"
$env:VITE_SOCKET_URL = "http://127.0.0.1:3100"
npm run dev -- --port 5174
```

Process variables override Vite's `.env` files. Sign in as `dtaro-demo@local.test` with the generated password, which is in `$SP\dtaro.env`.

**Campus row.** The seed creates the region but no `Campus` row. Create RNSIT once as SUPER_ADMIN (`POST /api/campuses` with `{ code: "RNSIT", name, centerLat, centerLon }`) and link it with `PUT /api/campuses/:id/region` `{ regionId: "rnsit" }`. Without it the map has no RNSIT campus to select.

**Staging the demo.** The engine assigns the robots, so this is the order:
1. Create two tasks whose routes pass the obstacle: Pre-University College → Playground 2 and Playground 2 → Pre-University College. These are the serviceable stops on that walkway. Main Gate, Playground 1 and the Parking Lot are refused with `MISSING_HOP`, which is engine behaviour by design.
2. Create a third task elsewhere, for example Canara Bank → Cyber Security.
3. Wait until all three are assigned and the robots are moving.
4. Commission a simulated robot at the obstacle (`POST /api/simulator/robot` with `lat: 12.89989, lon: 77.518413` and a seeded `locationId`). It senses the obstacle on its first tick.
5. Optionally, commission a second one a few metres south (`lat: 12.899763`). It senses the same obstacle in the same published cell, and the server merges its report (below).

The event log then shows:
- the report, with its recipients;
- one verdict per recipient.

Whichever robot first comes within 15 m of the obstacle reports it, and each later one records `ALREADY_ALERTED`.

**Duplicate reports.** While an obstacle is active (the 300 s EKB TTL), it is the only one for its region and published cell. A further report from that cell is not stored and not broadcast again:
- A different robot is recorded as a corroboration.
- The same robot again is a repeat.

The reporter gets `OBSTACLE_REPORT_ACK` with `delivery: "MERGED"` and `duplicateOf`. The dashboard gets `OBSTACLE_REPORT_MERGED`, and the panel shows "+1 report" and "Also reported by". The same cell in another region is a separate obstacle. When the TTL ends, the panel says "expired — not confirmed clear": nothing confirms that the obstacle is gone (OD-4).

**What this run writes, all inside the disposable database or the process:**
- shard lease and fence rows;
- WorkQueue, Outbox and Timer rows from the engine;
- position Observation rows on every telemetry frame;
- `ObstacleEvent` rows from the existing EKB, plus KV keys with a 300 s TTL;
- AuditEvent rows;
- the admin user;
- Robot and Agent rows.

The KV store is in memory and Redis is off. There is no external network use: there is no Mapbox token, and the Google client is unset.

**Cleanup:**

```powershell
# Ctrl+C the server and Vite, then:
& "$PG\pg_ctl.exe" -D "$SP\pgdata" -m fast stop
Remove-Item -Recurse -Force $SP
Remove-Item Env:ROBOTX_ENV_FILE, Env:DATABASE_URL -ErrorAction SilentlyContinue
```

## Dashboard: zones and obstacle awareness

This appears on `/map`, for SUPER_ADMIN only.
- **The zone map is shown whatever the alert switch says.** It is the published map, not part of the alert feature. Until 2026-10-22 it was gated on `DTARO_ZONE_ALERTS_ENABLED`. A server without that switch, such as the LOCAL environment file, then showed no zone and gave no reason.
- **`alertsEnabled` reports the switch.** The legend says "Obstacle alerts: on" or "off on this server — the zone is shown for reference only".
- **The obstacle panel appears only when alerts are on.** Alert delivery is unchanged either way.
- **A failed load is stated** in the legend, with its reason, for example "(HTTP 403)".

**Zones.** These come from `GET /api/dtaro/zones`, the pinned published map. Each zone is the union of the cells assigned to it.
- Only the selected campus's region is drawn, keyed by region and zone.
- The fill is a pastel tint beneath the campus roads. The boundary is a solid line with a white casing, drawn above the roads and beneath the buildings, so it no longer reads as one more road.
- The first zone colour is the Okabe–Ito reddish purple, not blue, which is the colour of the roads and routes. The proposal preview starts one colour later.
- The name is repeated along the boundary as "<zone> · alert zone". The label follows a simplified copy of the ring, because Mapbox sets no text along the raw H3 outline, which turns 60° at every cell. The drawn boundary is the exact cell outline.
- The legend header names the published zone at the map centre ("Alert zone: RNSIT Zone 1", or "Outside the alert zones"). It stays readable when the legend is collapsed and when no boundary is on screen.
- The legend has a "Zones" section: one row and swatch per zone with a show/hide toggle, plus "Show all".
- With today's map, RNSIT shows **one** zone (`rnsit-z1`) and JSSATE shows none, because it has no region.

**Alert zone versus campus areas.** The map shows two kinds of area, and the legend keeps them apart.
- **Alert zone (authoritative).** This is the published zone, `rnsit-z1`: 64 cells covering the whole campus.
  - It is drawn as a purple outline with a white casing, over a pastel purple tint.
  - It is labelled "Alert zone · RNSIT Zone 1" on its northern edge, and "RNSIT Zone 1 · alert zone" along the boundary.
  - The legend states that one operational zone covers all 64 assigned cells, and that the 4-zone layout is a proposal that is not in use.
  - It is the only area that alert delivery uses.
- **Campus areas (visual only, not alert zones).** These are pastel tints of outlines from the owner-checked OpenStreetMap extract:
  - Sports ground and Basketball Court;
  - Canteen ×2 (two separate OSM buildings);
  - Main Building;
  - Auditorium and Theatre;
  - Hostels ×3;
  - Parking ×3;
  - academic blocks, tinted but not relabelled.

  Their labels show at overview zooms (15–17.4). Beyond that the campus layer names the buildings itself. The legend has a "Show" switch for them. It is **off by default**: tinted buildings inside a campus-wide zone read as zone divisions they are not. They are also hidden during the proposal preview.
- **Not drawn, because the data has no outline for them:**
  - **Library:** absent from all data.
  - **Playgrounds 1 and 2:** owner-verified points only.
  - The legend's "Not in the data" note lists both.

**Proposal preview.** This is off by default. Turn it on with "Proposal preview (not approved)" in the legend.
- It draws the four-zone proposal as dashed outlines labelled `PROPOSAL · …`.
- The 14 tied cells are drawn grey as "Unresolved (no zone)".
- A banner reads "not published, not used for alerts".
- The data is the static snapshot `Frontend/src/features/maps/dtaro/rnsitZoneProposalPreview.js`, written by `node tools/demo/dtaro/exportZoneProposalPreview.js`. Run `--check` to see whether the snapshot is stale.
- Alert routing never reads this snapshot.

**Obstacle awareness.** This is a collapsible panel in the right rail.
- It lists each accepted report with:
  - the reporter, marked SIM;
  - the zone;
  - the time;
  - every recipient with its own verdict (on its commanded route, not on it, no planned route, or awaiting its answer).
- Refused reports appear with their reason.
- There is a filter for All, Relevant and Refused.
- It shows reconnecting and disconnected states.
- Entries from other regions are counted but not shown.

On the map:
- An obstacle is one neutral marker; severity is advisory and is not drawn.
- Selecting an obstacle outlines its published cell.
- Selecting an obstacle rings the reporter in white and each recipient by its verdict: amber for relevant, grey for not relevant, blue for awaiting.

**Demonstrating it.** These are the full-stack steps above. When step 7 is reached:
1. Open `/map` and pick RNSIT. The legend header reads "Alert zone: RNSIT Zone 1", and the purple tint and boundary cover the campus.
2. Start or create the tasks. Once the reporter is commissioned at the obstacle, the panel count goes to 1.
3. Open the panel and select the report.
   - The crossing robot reads **On its commanded route**.
   - The other robot reads **Not on its commanded route**.
   - "Show on map" flies to the obstacle.
4. Optionally, toggle the proposal preview to show the four-zone proposal, which is clearly labelled as a proposal. Toggle it off again afterwards.

## Protocol (additive; existing payloads unchanged)

| Event | Direction | Payload |
|---|---|---|
| `OBSTACLE_ALERT` | server → zone room (the reporter is excluded) | `{ obstacleId, lat, lon, severity, regionId, zoneId, cellId, footprint: { kind: "H3_CELL", cellId, polygon }, reportingRobotId, timestamp, expiresAt }` |
| `OBSTACLE_RELEVANCE` | robot → server | `{ obstacleId, relevant, routeSource: COMMANDED_ROUTE \| CHARGER_APPROACH \| NONE, taskId?, routePoints?, decision }`. Accepted once per recipient, and only from a recipient. Relayed to the dashboard with `robotId`, `regionId` and `zoneId` filled in by the server |
| `OBSTACLE_REPORT_REJECTED` | server → reporter and dashboard | `{ reportingRobotId, lat, lon, reason, … }`. `reason` is one of `INVALID_COORDINATES`, `SPATIAL_AUTHORITY_UNAVAILABLE`, `UNASSIGNED_CELL`, `CELL_HAS_NO_ZONE`, `REPORTER_NOT_SIMULATED`, `REPORTER_REGION_UNKNOWN`, `WRONG_REGION` |
| `ALERT_CREATED` (existing) | server → dashboard | Unchanged fields, plus `regionId`, `cellId`, `room`, `recipients`, `delivery: "ZONE_ROOM"` and `footprint` (the published cell outline). Since 2026-10-23 also `recipientPolicy: "ZONE_PLUS_REMAINING_ROUTE"`, `sameZoneRecipients`, `crossZoneRecipients`, and `recipientDecisions` — one entry per robot considered: `{ robotId, zoneId, relation, routeIntersects, selected, alerted, reason, route: { source: "OFFER", status, commitmentId, cut, corridorPoints, remainingPoints, offRouteM, leaseExpired, … } }`. `recipients` is every robot alerted (zone room ∪ cross-zone). `crossZoneError` appears only if the cross-zone step failed (the zone room was still delivered) |
| `OBSTACLE_ALERT` (cross-zone copy) | server → `robot:<id>` | The same payload plus `via: "REMAINING_ROUTE"`, sent to a same-region robot in ANOTHER zone whose remaining commanded route meets the footprint |
| `GET /api/dtaro/zones` | dashboard → server (SUPER_ADMIN) | `{ available, alertsEnabled, source: "PUBLISHED_MAP", configVersion, spatialVersion, cellsWithoutZone, regions: [{ id, regionKey, name }], zones: [{ key, regionId, regionKey, zoneId, name, cellCount, geometry }] }`, served whether or not alerts are on (`alertsEnabled` reports `DTARO_ZONE_ALERTS_ENABLED`). With no pinned map: `{ available: false, alertsEnabled, reason: "SPATIAL_AUTHORITY_UNAVAILABLE", regions: [], zones: [] }`. Read-only |
| `OBSTACLE_REPORT_ACK` (existing) | server → reporter | Unchanged fields (`affectedRobots` is now the recipient count), plus `regionId`, `zoneId`, `cellId`, `recipients` and `delivery`. A merged report has `delivery: "MERGED"`, `affectedRobots: 0`, `recipients: []` and `duplicateOf` |
| `OBSTACLE_REPORT_MERGED` | server → dashboard | `{ obstacleId, reportingRobotId, originalReporterId, corroborations, repeat, regionId, zoneId, cellId, lat, lon, timestamp }`. A further report of an obstacle already active in that region and cell. Nothing is re-broadcast to robots |

## Cross-zone recipients (2026-10-23)

With the switch on, an alert reaches the obstacle's zone room **and** every simulated robot in the same region whose **remaining commanded route** meets the obstacle's published cell, wherever it is now (`src/services/dtaroRecipientPolicy.js`).

- **Route source (trusted):** the robot's live commitment and the latest `OFFER` in the Outbox, `stopSequence[].path` — the corridor completion grading reads. A robot never supplies its route.
- **Cut:** at the robot's latest server-held position (registry, then cache), on the earliest corridor segment within `VERIFY_CORRIDOR_HALF_WIDTH_M` of the nearest one, so a route that doubles back is never cut short. Position unknown, or the tolerance unset → the whole corridor (conservative).
- **Not selected by route:** no live commitment (idle), no route geometry, a failed read (`LOOKUP_FAILED`). Each is recorded in `recipientDecisions`.
- **Order:** the zone room is emitted first and waits on nothing; the database reads and the cross-zone emits follow.
- **Never:** another region; the reporter; a duplicate (a merged report delivers nothing).
- **With today's map** (one zone, `rnsit-z1`) every robot on campus is in the zone room, so `crossZoneRecipients` is empty; `recipientDecisions` still records each robot's server-side route verdict. Cross-zone delivery takes effect only with a multi-zone published map, which is not published (G4 is a proposal).
- **Physical robots** are still not recipients (A-6).

## Not done, on purpose

- **No reroute, replan or path mutation (OD-3).** A relevant robot records the obstacle and reports `RELEVANT_NO_REPLAN`.
- **No change to the V1 engine.** No engine module was touched.
- **Dedup is per published cell only.** There is no plausibility distance and no confirmed clearance. The lifecycle is the existing 300 s EKB TTL, and expiry is not shown as clear (OD-4, OD-5). The dedup index is per process, like the delivery ledger.
- **Reroute is blocked, not just deferred.** The `REROUTE` mission command has no producer. Completion is graded against the OFFER corridor only. The campus router takes no blocked-edge input. Any of these would need a frozen-engine change and owner decision OD-3.
- **No replay to a robot that reconnects after the alert.**
- **The delivery ledger is per process.** With a cross-process adapter, a relevance answer that reaches another process is refused (fails closed).
- **Physical robots are neither zone members nor accepted reporters.**

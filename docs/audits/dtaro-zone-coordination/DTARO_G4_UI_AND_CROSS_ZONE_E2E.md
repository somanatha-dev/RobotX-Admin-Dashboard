# DTARO — G4 four-zone preview in the app, and the cross-zone recipient policy end to end

**Date:** 2026-10-23
**Branch:** `feature/dashboard` @ `5e94a1a`, uncommitted.
**Read with:** [RNSIT_ZONE_LAYOUT_G4_PROPOSAL.md](RNSIT_ZONE_LAYOUT_G4_PROPOSAL.md).

| | What is true |
|---|---|
| **Published map (real databases)** | Unchanged. RNSIT has one zone, `rnsit-z1`. Nothing was published, pinned or written anywhere but the disposable cluster below |
| **G4** | A **validated offline proposal**, shown in the dashboard as a read-only preview behind an off-by-default toggle. It is never published, never pinned and never read by alert routing |
| **Disposable demo cluster** (`127.0.0.1:55472`, `%TEMP%\robotx-dtaro-g4ui`) | The V1 seed, then a **synthetic test map** published there only: the RNSIT cover split into two TEST zones at cell-centre longitude 77.518, plus a synthetic second region. It is **not G4** |

## 1. Why the UI showed no four zones (audit)

1. **The wrong proposal.** The dashboard's preview data (`Frontend/src/features/maps/dtaro/rnsitZoneProposalPreview.js`) was generated from the earlier **L4** candidate: zones `rnsit-z2…z5` plus 14 grey, unresolved cells. `exportZoneProposalPreview.js` had never been switched to G4.
2. **Off by default.** The preview sits behind an off-by-default toggle, shown only to SUPER_ADMIN and only once a campus coded `RNSIT` is selected. The V1 seed creates no `Campus` row, so on a seeded database there was nothing to select.
3. **Too faint.** The proposal outline was a 1–1.75 px dashed line with no casing, so it hardly read on the basemap.
4. **Cross-zone was invisible.** It was integrated server-side (`dtaroZoneAlert.processReport`), but the real stack published one zone. With every robot in the same zone room, the cross-zone step could never select anyone. The panel also dropped the server's per-robot decision record.

## 2. What changed

**Frontend:**
- **G4 data.** The preview is now G4, validated: four zones and 0 open cells. Each zone is listed with its name, cell count and contents.
- **Drawing.** A thicker dashed outline over a white casing, plus a thin per-zone grid of the assigned cells.
- **Campus boundary.** It stays drawn, and keeps its legend row during the preview.
- **Banner and legend** say "G4 … validated offline — NOT approved, NOT published, not used for alerts. Alerts use the published map (N zones)".
- **Obstacle panel.** Each recipient carries the server's reason, as one of:
  - "same zone";
  - "other zone — its remaining route crosses the obstacle", tagged **cross-zone**.

  A "Considered, not alerted" list gives each remaining robot's reason: route clear, idle, another region.
- **Replay.** A dashboard that opens or reconnects after a report replays the server's own events (`GET /api/dtaro/activity`).

**Backend:**
- `dtaroZoneAlert.service` keeps a bounded in-process log of the exact dashboard payloads it emits.
- `GET /api/dtaro/activity` (SUPER_ADMIN, read-only) serves that log.
- `exportZoneProposalPreview.js` now exports G4, and refuses a proposal that is approved, published or failing validation.
- New disposable-only demo tooling:
  - `tools/demo/dtaro/stageCrossZoneDemo.js`, which refuses any non-loopback target or the canonical LOCAL database;
  - `tools/demo/dtaro/rnsit-dtaro-crosszone-scenario.json`, three obstacles each about 10 m off the walkway with a 4 m sense radius, so that only a reporter placed on the point reports it.

## 3. End-to-end evidence (real `server.js` + engine + simulator + dashboard, disposable PostgreSQL)

**How each report is judged.**
- Every obstacle was reported by a real simulated robot, commissioned at a scenario point through `POST /api/simulator/robot`.
- Recipients and reasons are the server's own `ALERT_CREATED`. Verdicts are the robots' own `OBSTACLE_RELEVANCE`, relayed to a real dashboard socket.
- An **independent oracle** in the driver decides what *should* have happened. It uses each robot's last DB-recorded position, its live OFFER corridor from the Outbox, its own nearest-vertex cut, and 1 m sampling against the obstacle cell. That is a different method from the server's.

**Assignments made by the engine:**

| Task | Robot |
|---|---|
| T1 PU College → Playground 2 | V1DEMO-02 |
| T2 Playground 2 → PU College | V1DEMO-01 |
| T3 Canara Bank → Cyber Security | V1DEMO-03 |
| T4 Evening College → CSE access point | V1DEMO-04 |

### Report 1 — OB-A, synthetic EAST zone

| Robot | Zone | Expected (oracle) | Server | Reason | Robot's own verdict |
|---|---|---|---|---|---|
| V1DEMO-02 (T1) | east | alert | **alerted** | SAME_ZONE (route OK, 19/20 remaining) | RELEVANT |
| V1DEMO-01 (T2) | **west** | alert | **alerted, cross-zone** | ROUTE_CROSSES_OBSTACLE (26/27) | RELEVANT |
| V1DEMO-04 (T4) | west | no | not alerted | ROUTE_CLEAR (11/12) | — |
| V1DEMO-06 | west | no | not alerted | NO_REMAINING_ROUTE (idle, NO_LIVE_COMMITMENT) | — |
| SIM-AE31BAC31BE9 | **region 2** | no | not alerted | OTHER_REGION (route never read) | — |
| V1DEMO-03 (T3), V1DEMO-05, SIM-228FE9B1C922 | east | alert | alerted | SAME_ZONE | NOT_RELEVANT ×1, NO_PLANNED_ROUTE ×2 |
| SIM-12A971668EDF | east | — | reporter | REPORTER | — |

Oracle agreed on 9/9. The robots that sent verdicts were exactly the alerted robots.

### Duplicate

A second reporter, 2 m from OB-A, produced `OBSTACLE_REPORT_MERGED` into the same obstacle. It created 0 new `ALERT_CREATED` and drew 0 new verdicts. The panel shows "+1 report".

### Report 2 — OB-B, synthetic EAST zone, after T1 had passed it

| Robot | Zone | Server | Notes |
|---|---|---|---|
| V1DEMO-01 (T2, still heading to PU) | west | **alerted, cross-zone**, RELEVANT | 21/27 remaining |
| **V1DEMO-02 (T1, past OB-B)** | west | **not alerted**, ROUTE_CLEAR | Its **whole** OFFER corridor *does* enter OB-B's cell (`8b6014510495fff`); the 9 remaining of 20 points do not. Completed segments do not count |
| V1DEMO-03 (T3) | west | not alerted, ROUTE_CLEAR | — |
| V1DEMO-04 | west | not alerted | Its task had finished: NO_LIVE_COMMITMENT |

Oracle agreed on 11/11.

### Reconnect

1. The simulator was stopped and restarted through `POST /api/simulator/stop` and `POST /api/simulator/start`. Every robot re-sent AUTH and resumed telemetry (server log at 12:20:41 local).
2. The dashboard page was reloaded. It showed both earlier obstacles, replayed from `/api/dtaro/activity`.
3. **Report 3 (OB-C, WEST)** followed, after the engine had given two new crossing tasks to two east-zone robots:
   - SIM-228FE9B1C922 and SIM-334C082C5ABF (east): **alerted cross-zone**, RELEVANT.
   - West robots: alerted by the zone room.
   - The idle east robots and the region-2 robot: not alerted.

   Oracle agreed on 12/12, and the verdict senders equalled the recipients.

### Flag off (separate server start, same database)

- `ALERT_CREATED` came in the legacy shape: no `delivery`, `recipientPolicy` or decision fields.
- 0 zone-room deliveries, and 0 `OBSTACLE_ALERT` received by robots.
- `/api/dtaro/activity` was empty, and `alertsEnabled` was false.

### Engine

| Check | Result |
|---|---|
| Outbox commands | `OFFER=6` and nothing else |
| `REROUTE` / `RESEQUENCE` rows | **0** |
| OFFER rows rewritten for any commitment | 0 |
| Config versions | v1 is the seed; v2 is the synthetic stage, **in the disposable cluster only** |

### Not exercised on the real stack

A **failed route read** (`LOOKUP_FAILED`), and a robot with **no known position** (whole corridor used). Both need a fault the live stack cannot produce safely. They are covered at integration level, over real sockets (`tests/integration/dtaroCrossZoneRecipients.test.js`), and by unit tests (`tests/unit/dtaro/dtaroCommandedRoute.test.js`).

## 4. Artifacts

Screenshots from the real dashboard in headless Chrome, plus raw evidence, are in this session's scratchpad `e2e2/`:

| File | Content |
|---|---|
| `01-published-synthetic-zones.png` | The two synthetic published zones |
| `02-g4-preview.png` | The G4 preview, with legend and banner |
| `03-report-OB-A.png` | Report 1, with the cross-zone recipient tagged |
| `04-duplicate-merged.png` | The merged duplicate |
| `05-report-OB-B-completed-segment.png` | Report 2 |
| `06-after-reload-hydrated.png` | The panel after a page reload, replayed from the server |
| `07-report-OB-C-after-reconnect.png` | Report 3, after the simulator restart |
| `08-g4-preview-legend-collapsed.png` | The G4 preview with its cell grid |
| `phaseOff.json` | The flag-off check |
| `activity-after-reports-1-2.json` | The server's own log for reports 1 and 2 |
| `evidence-phase2.json` | Report 3, the scenario 6 proof, and the engine checks |
| `demo-output.txt`, `phase2-output.txt` | Driver output |

## 5. Follow-up 2026-10-23: "the map still shows only two zones"

Reported: `/map` showed two zones (blue and pink) labelled "RNSIT west half (not G4)", and the four G4 zones could not be verified from the UI.

**What the page was actually doing (diagnosed in the browser, not assumed):**

- **Published-map default.** The page opens on the published map, and on the disposable stack that map is the synthetic two-zone split. The only way into the preview was a small checkbox at the bottom of the legend, below the fold.
- **Colours.** The preview zones reused the published palette, so the blues looked alike.
- **Labels.** Proposal labels were anchored on each zone's northern vertex, and two of them collided.
- **Misleading text.** The warning listed the synthetic zone names ("…west half (not G4)") while the preview was on.
- **Framing.** The pitched default camera hid the south-west lobe under the legend.

The first browser re-check after those fixes surfaced three rendering defects that a DOM-only check would have missed:

1. **The preview framing was terrain-dependent.** `map.fitBounds` on the globe + terrain style framed the same bounds at z16.36 before the elevation tiles arrived and at z15.2–15.4 after them (measured with `cameraForBounds` on an unchanged camera). The zones became a thumbnail and the labels piled up. A `padding` passed to a camera call also stays on the map as its standing padding, which would offset every later Overview, Follow or Recenter. Fixed with `topDownCameraForBounds` (`camera/cameraModes.js`): plain Web Mercator, which equals Mapbox's flat result to 1e-9. The preview eases to that camera with no `padding`, and it claims the camera sequencer, so a pending arrival tilt cannot run afterwards.
2. **Robot markers covered the labels.** Robot markers are HTML above every map layer, and the demo robots park at the zone medoids. Three of the four medoid labels were under a marker. Two fixes:
   - Labels are now two short lines, "G4 PROPOSAL" over the zone name in capitals.
   - `previewLabelsClearOf` (`dtaro/zoneModel.js`) keeps each label at its medoid cell unless a marker covers it there; otherwise it uses the nearest own-zone cell that no marker or other label covers. Robot positions are sampled once, when the preview is switched on.
3. **A harness bug, not an app bug.** An early verification run screenshotted before Mapbox's `load` event: DTARO layers install only after `load`, which can take more than 10 s in headless SwiftShader. Verification now waits on map conditions (layers installed, camera idle), not on sleeps.

**Verified in a real browser** (headless Chrome 1440×900 against Vite :5199 + `server.js` :3120 + disposable PG :55472; the switch was clicked 29.5 s after load, with terrain loaded):

| | Published (as opened) | G4 preview (on-map switch) | Published again |
|---|---|---|---|
| Switch state | `[x] Published (2)` | `[x] G4 proposal (4) · preview` | `[x] Published (2)` |
| Zone fills Mapbox drew | LIVE `rnsit-syn-east`, `rnsit-syn-west` | PREVIEW `rnsit-z-west`, `-east`, `-south`, `-southwest` | LIVE `rnsit-syn-east`, `rnsit-syn-west` |
| Label source | 2 synthetic labels | 4 labels, `PROPOSAL · <name> · <id>` | 2 synthetic labels |
| Preview cell outlines drawn | 0 | 70 | 0 |
| Legend | 2 synthetic rows (28 / 36 cells) | West 15 · East 17 · South 14 · South-west 18 cells | 2 synthetic rows |
| "west half (not G4)" text | yes | **no** | yes |
| Camera | z16.6, pitch 48 | z16.36, pitch 0, padding 0 | z16.36, pitch 0, padding 0 |

Writes while toggling, any non-GET to :3120 or :5199 except socket.io transport: **none**. `ConfigActiveVersion` is `2`, pinned at `2026-10-23 06:39:35.755`, both before and after. `ConfigVersion` is `1,2` before and after. Console errors: 0. The preview is client-side only (`rnsitZoneProposalPreview.js`, `approved: false`, `published: false`), and `previewZonesForCampus` refuses a snapshot that claims either.

Screenshots and run data are in the session scratchpad, `e2e2/`:

- `FINAL-1-published-synthetic-2-zones.png`
- `FINAL-2-g4-preview-4-zones-4-labels.png`
- `FINAL-3-preview-off-synthetic-restored.png`
- `FINAL-verify-preview.json`

Tests: frontend `test:arch` 715/715 pass. New coverage:

- the camera equals the measured Mapbox flat fit;
- every proposal cell falls inside the padded view;
- no `fitBounds` call and no standing padding;
- labels sit clear of the 2026-10-23 robot positions, each in its own zone, with none overlapping;
- the two-line label format.

ESLint is clean and the build is ok. Nothing was committed.

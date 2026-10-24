# G4 RNSIT zones + DTARO zone alerts: release record, 2026-10-23

**Authority.** The owner authorised publishing and pinning the validated G4 layout and enabling `DTARO_ZONE_ALERTS_ENABLED` on the operational environment (2026-10-23). The owner accepted these risks for this release:

- the three LOW-confidence G4 cell decisions;
- the outstanding T03 site survey.

**Not approved:**

- the Playground 2 route-containment change;
- any frozen V1 engine change;
- automatic rerouting;
- physical robots as reporters;
- unrelated map or campus changes;
- direct-service publication.

## Operational environment (verified, no secrets)

| Item | Value |
|---|---|
| Backend | Render service `srv-davphsu0tbcc73esoaig`, `https://robotx-admin-dashboard.onrender.com` (auto-deploys `origin/feature/dashboard`) |
| Database | Original Neon, host `ep-broad-lab-a1shw6nm.ap-southeast-1.aws.neon.tech`, db `neondb`, PostgreSQL 17.11, 37 migrations |
| Frontend | Vercel, `https://robot-x-admin-dashboard.vercel.app` |
| Region | `rnsit` (`Region.id d7534ec6-0840-4a36-b691-42584daed00f`); shard `rnsit-shard` ACTIVE |
| Map before | ConfigVersion **1** (bootstrapV1Environment, 2026-10-02), the only version, pinned. One zone, `rnsit-z1`, holds all 64 cells. Signature `9114c0cd…`. |

## Done today

1. **Deploy** (fast-forward pushes, owner-authorised workflow). The working tree held the guard and DTARO code uncommitted, so the operational server lacked both.
   - `5e94a1a..075473e` at 11:39:50Z;
   - `075473e..8bc3155` at about 11:44Z;
   - Render was serving the new code by 11:40:49Z (`GET /api/dtaro/zones` 401, new route); Vercel's bundle carries the new dashboard;
   - config is still v1 and the engine is led.
2. **Pre-change backup** of `neondb`: `C:\Users\soman\robotx-backups\neondb-pre-g4-20261023T110252Z\neondb.sql`.
   - 260 MB, sha256 `4d5cf2c6…65da3`;
   - restore-tested into a disposable cluster: v1 pinned, 5 Zone rows, 12 robots, 296,899 observations, 37 migrations. The only errors were for the Neon-managed `pg_session_jwt` extension.
3. **Zone rows** (`tools/deploy/createG4ZoneRows.js --apply`, after a dry run) at 11:41Z.
   - `rnsit-z-west`, `rnsit-z-east`, `rnsit-z-south` and `rnsit-z-southwest`, in Region `rnsit`, with degenerate boxes (Q10). No conflicts.
   - Inert until a published map names them.
4. **Production preflight** (READ ONLY):
   - 0 engine-validator findings;
   - 0 Zone-reference findings;
   - only the 64 RNSIT cells change (regions, sites, 21 bindings, kill switches and the delivery domain are restated);
   - the candidate resolves to West 15, East 17, South 14, South-west 18.

## Not done: the remaining steps need the owner

- **Publish and pin (Phase 3).** `POST /api/config/publish` requires an authenticated SUPER_ADMIN and a genuine second approver. The route verifies that the approver exists and is elevated, but does not authenticate them, so naming one is an attestation. Neither can be supplied by the assistant. Run `%USERPROFILE%\robotx-secrets\publish-g4.ps1`:
  1. a dry run;
  2. then with `-Apply`.

  It publishes only through the guarded route and verifies through the API pin, the database pin, the 64 cells and `/api/dtaro/zones`.
- **Alert activation (Phase 4).** No Render API access exists here, so this is done in the Render dashboard **after** G4 is verified:
  1. set `DTARO_ZONE_ALERTS_ENABLED=true`;
  2. for the simulated-reporter verification only, set `SIM_DTARO_SCENARIO=tools/demo/dtaro/rnsit-dtaro-g4-scenario.json`;
  3. redeploy or restart.

  Then run the scenario checks.

## Rollback and recovery

- **Rollback target:** version 1 (one zone). Recovery uses the same guarded route: `publish-g4.ps1 … -RestoreVersion 1 -Apply` republishes v1 exactly and pins it. This was rehearsed on a disposable database: G4 → v1 map → G4, with the live server following each pin.
- **Alerts:** unset `DTARO_ZONE_ALERTS_ENABLED` (or set it to `false`) and restart. The legacy dissemination then runs.
- **Zone rows, before publication only:** delete the four `rnsit-z-*` ids. After publication, keep them; they are referenced.

## Tests (release tree)

| Suite | Result |
|---|---|
| Backend full suite (correctly rooted, `075473e`) | 354 passed, 1 skipped; 11,193 tests passed, 15 skipped, 0 failed |
| New or changed backend tests | 10 / 10 |
| Frontend `test:arch` | 728 / 728; lint clean; build ok |
| Gates | 7 / 8 (`composition`: pre-existing B1) |

## Accepted risks / open items

- LOW-confidence cells `…049a` and `…049b`, plus `…286a` (owner accepted). T03 site survey outstanding (owner accepted).
- Simulated routes to or from Playground 2 leave the boundary by up to 8.1 m. The fix was not approved.
- Code that calls `configService.publish` directly bypasses the guard; closing that needs a V1-freeze exception.
- Legacy mirrors (`Robot.zoneId`, `CellAssignment`) keep the legacy zones. Production also has 4 region-less legacy default Zone rows ("RNS Institute of Technology Zone-NE/NW/SE/SW") that the legacy box lookup uses; they have no reader.
- `/health` reports `redis: "fail"` on Render. This was not caused by this release; it needs a separate check.

## Owner-only publication release (2026-10-23 afternoon)

Owner decision: a configuration publish needs no second approver. The publisher must still be an authenticated `SUPER_ADMIN`, give a reason, and leave an `OverrideAudit` row.

**Committed and pushed:** `023435c` "feat(config): owner-only G4 publication and spatial-containment validation", 14 files, on `feature/dashboard` (`8bc3155..023435c`, pushed 13:25:39Z, no force).
- Owner-only gate: `SAFETY_CONFIG_CHANGE` no longer requires a second approver by default. The Safety-class approval quorum is 1. S5 was removed.
- `secondApproverVerified` marker: set only when the gate actually checked an approver.
- Containment guard: `POST /api/config/publish` runs `hierarchy.validateForPublish` and refuses a failing map with 422 `SPATIAL_CONTAINMENT` before anything is written.
- `publishG4.js`: works without a second approver, and checks parameter values and the served approval policy.
- `docs/security/rbac.md` updated.

**Rehearsal (before the commit):** a throwaway restore of `neondb-pre-g4-publish-20261023T123641Z` on PG 55490, with the new backend on :3130.
- Access: unauthenticated 401, campus `ADMIN` 403, no reason 400 `NO_REASON` (audited).
- Dry run: wrote nothing (DB fingerprint unchanged).
- `--apply`: v2 = 4 zones (15/17/14/18); the audit row was granted with approver null.
- Rollback with `--restore-version 1`: v3 = `rnsit-z1(64)` in 12 s.
- Four invalid maps (missing Zone row, cross-region Zone row, cell zone not in map, cell with an unknown region): all 422, nothing written.
  - The fourth was accepted (200) before the containment guard existed. That is the defect `023435c` fixes.

**Tests at `023435c`:**
- Full backend suite: 354 suites passed (1 skipped), 11,213 tests passed (15 skipped), 0 failed.
- Targeted config, spatial, auth and DTARO suites: 23 suites, 528 tests.
- Frontend: unchanged, not re-run.

**Deploy:**
- Render `/health` came up with uptime 16 s at 13:26:49Z, about 50 s after the push, and stayed stable (73 s, 94 s, 115 s), `db: ok`, `configVersion: 1`.
- Render logs and deploy status were not readable from here (no Render API access).
- The register digest (`6b4d7d46…`) is the same for `8bc3155` and `023435c`, so it does not identify the commit. The proof that the new code is live is the dry run's served approval policy (step 2d, `secondApproverRequired: false`).

**Production preflight (read only):**
- Neon pin is v1, and only version 1 exists. v1 has `rnsit-z1:64`. The G4 Zone rows (`rnsit-z-east/south/southwest/west`) are all in RNSIT region `d7534ec6…`. 0 active tasks.
- Backup `robotx-backups\neondb-pre-g4-publish-20261023T123641Z`:
  - sha256 `79a13faf…` matches `SHA256SUMS.txt`; `pg_dump.stderr` is empty.
  - The restore test reads back pin 1, 9 zones, 12 robots, 6 users, 32 tasks, 37 migrations and 64 v1 cells, all identical to live production.
- The exact G4 candidate, built from the production v1 payload:
  - containment ok; 0 engine findings; 0 Zone-reference findings;
  - 64 distinct RNSIT cells, all reassigned to G4 zones (west 15, east 17, south 14, southwest 18), nothing else changed;
  - map zones are exactly the four G4 zones, all in RNSIT; one region in the map; 0 cells outside RNSIT before and after.
- Operator wrapper `publish-g4.ps1`: `-SecondApproverId` removed (local file, not in git).

## Production after the owner's publish (verified 2026-10-23, read only)

- Neon pin is **v2**, published 13:34:27Z by the owner account `b3624ba3`. v2 cells: east 17, south 14, southwest 18, west 15.
- `OverrideAudit` 13:34:27Z: `SAFETY_CONFIG_CHANGE` granted, second approver null, audit hash present. The 12:02:57Z refused attempt (`SECOND_APPROVER_UNKNOWN`) is still on record.
- Render `/health`: `configVersion: 2`, db ok. 4 robots online, 0 active tasks, 0 active obstacles.
- `DTARO_ZONE_ALERTS_ENABLED`: set by the owner, but **not independently verified**. Only `GET /api/dtaro/zones` reports it, and that route needs a SUPER_ADMIN session, which this audit did not use. No production environment variable, configuration, task or robot was changed.

## DTARO obstacle-alert audit and hardening (2026-10-23 evening)

### Call chain (traced in code)

1. Simulated robot (`VirtualRobot._senseWorldObstacles`) → `OBSTACLE_REPORT` over its own Socket.IO connection.
2. `dtaro.handler`: rate limit; authenticated `socket.data.robotId`; zod schema (finite lat/lon, severity; every other field stripped).
3. `DTARO_ZONE_ALERTS_ENABLED` decides the path. Off: the legacy `alertDissemination` path. On: `dtaroZoneAlert.processReport`:
   - The reporter must be simulated, which is read from the server's own row (A-6).
   - `resolvePoint`: point → H3 res-11 cell → pinned published map → zone and region. Fails closed with `INVALID_COORDINATES`, `UNASSIGNED_CELL`, `CELL_HAS_NO_ZONE` or `SPATIAL_AUTHORITY_UNAVAILABLE`.
   - The reporter's region is taken from its server-side zone membership, never from the report (`WRONG_REGION` / `REPORTER_REGION_UNKNOWN`).
4. Per-(region, cell) lock, then dedup.
   - If the cell already holds an active obstacle: `OBSTACLE_REPORT_MERGED` (a corroboration or a repeat), with no store and no broadcast.
   - Otherwise: `ekb.storeObstacle` (TTL 300 s), then a ledger entry.
5. `OBSTACLE_ALERT` goes to the region-qualified zone room `dtaro:region:<r>:zone:<z>`, excluding the reporter's robot room.
6. Cross-zone step:
   - `eligibleRobots` collects the authenticated, simulated robot sockets that hold a zone membership.
   - `dtaroCommandedRoute.readCommandedRoutes` reads, server-side only, the Agent, then the live Commitment, then the latest OFFER `stopSequence[].path`.
   - `remainingRoute` cuts that path at the server-held position (registry, then cache).
   - `dtaroRecipientPolicy.selectRecipients` decides, and each selected robot gets `robot:<id>` with `via: REMAINING_ROUTE`.
7. `ALERT_CREATED` goes to SUPER_ADMIN dashboards (`dashboardBroadcast`).
   - It carries the recipients, the same-zone and cross-zone lists, and one `recipientDecisions` entry per robot considered.
   - It is also kept in the bounded `activityLog` (`GET /api/dtaro/activity`).
8. Each recipient sends `OBSTACLE_RELEVANCE`. The server accepts it only from a recipient, once, while the obstacle is active, and relays it to the dashboard.
9. Frontend:
   - `AppProvider` socket listeners (registered once, removed on cleanup) feed `obstacleActivityStore`.
   - `refreshDbState` hydrates from `/api/dtaro/activity` through the same idempotent reducer.
   - `MapControl` shows the `ObstacleActivityPanel`; `useDtaroLayer` draws the markers, footprint and zones.
10. Expiry is the server-stated `expiresAt`. A page clock ticks every 15 s, plus exactly at the next expiry.
11. Membership is joined at AUTH and moved on each telemetry frame (`syncMembership`). A reconnect is a new socket, which is re-joined at AUTH. A disconnect leaves all rooms.
12. No reroute, no engine write, no change to commanded routes, and no assignment-engine file is touched.

### Defects found and fixed

**B1. Duplicate-report race (backend).**
- Defect: the duplicate check and the ledger write were separated by `await ekb.storeObstacle`. Two near-simultaneous reports of one cell could both create and broadcast an obstacle.
- Fix: reports are serialized per (region, cell) by `withCellLock`.
- Test: 3 concurrent reports give 1 store, 1 alert and 2 merges. The mutant without the wait fails it.

**B2. Missing route data was treated as "unaffected" (backend policy).**
- Defect: a same-region robot in another zone whose route read failed (`LOOKUP_FAILED`), or whose live commitment had no usable geometry, got `NO_REMAINING_ROUTE` (as if idle) and was not alerted.
- Fix: such a robot is now alerted conservatively, with `ROUTE_UNKNOWN`. Alerts are advisory, and the robot judges relevance itself.
- Unchanged: idle robots (no live commitment) are still not alerted by route, and other regions are never alerted.

**B3. Malformed route points (backend).**
- Defect: a `NaN` passed `corridorOf`'s `typeof` check. Filtering bad points later joined their neighbours into a segment that was never commanded.
- Fix: any non-finite or out-of-range point makes the route `MALFORMED_ROUTE`, which is treated as an unknown route. The mutant fails the test.

**B4. Expired obstacles stayed active on the map (frontend).**
- Defect: the marker's `expired` flag was computed only when the obstacle list changed, and the panel re-checked only every 15 s.
- Fix: the layer now takes the page clock and is rebuilt only when an obstacle crosses its expiry. A timer fires at the next exact expiry.
- Verified in Chrome: entries and markers flipped to expired at the server time, with no reload and no new event.

**B5. A late verdict resurrected an expired obstacle (frontend + backend).**
- Defect: a relayed verdict for an obstacle the page never saw created a "partial" entry with no expiry.
- Fix: verdicts now carry the obstacle's `expiresAt`. A partial entry expires with it, and a verdict that arrives after expiry is dropped. The mutant fails the test.

**B6. The panel and zones vanished during a connection drop (frontend).**
- Defect: the zone fetch re-runs when the connection drops. Offline it failed with `NETWORK`, which set `alertsEnabled` false and unmounted the obstacle panel. "Reconnecting" was never shown, and the panel came back collapsed.
- Fix: a network-failed refetch keeps the last good view.
- Verified in Chrome: "Live updates paused — reconnecting" appeared while offline and cleared about 5 s after coming back, with no duplicate entries.

**Hardening:**
- The report schema requires finite numbers.
- A merged report states the original expiry, so merging never extends an obstacle's lifetime.
- The panel labels every entry SIMULATED, "active · until HH:MM:SS" and its severity, and states that no entry is a physical sensor detection.

### Contract notes (documented, not changed)

- Reports carry no client timestamp, id or type. The server stamps the receipt time and the 5-minute lifetime, and ignores any client-supplied time, id, expiry, region or zone (tested over real sockets). A "stale" or "out-of-order" report therefore cannot set an obstacle's time.
- There is no obstacle type: the protocol carries severity only.
- Dedup is one active obstacle per (region, published res-11 cell). Obstacles in adjacent cells are separate (tested).
- The ledger, activity log and dedup index are per process, in memory. Render runs one instance, and Redis is off for this path.
- Physical robots neither report nor join zone rooms (A-6).

### Tests

- Backend, focused DTARO set (20 suites): 357 passed, 0 failed. Full backend suite: 354 suites passed (1 skipped), 11,222 tests passed (15 skipped), 0 failed.
  - New tests: the concurrent race; adjacent cells; verdict expiry; a merge keeps the expiry; `ROUTE_UNKNOWN`; a reused zone id in another region; route endpoints and vertices; a malformed route; swapped lat/lon over real sockets; forged time, id and expiry over real sockets.
  - Updated: two cross-zone integration expectations, to the conservative policy.
- Frontend: `test:arch` 734/734 (6 new). Lint on the changed files is clean; the whole project still has the same 3 pre-existing findings in untouched files. The build succeeds.
- Mutation checks: 4 of 4 killed (the cell-lock wait, malformed detection, the late-verdict guard, the conservative policy).
- Test-harness note: running one integration file alone leaves open handles, and jest does not exit. Use `--forceExit`. This predates the work and is also true of the untouched sibling suite.

### End to end on a throwaway stack

Setup: the new presentation kit `tools/demo/dtaro/presentation/` (PG 55480, server :3140, Vite :5190), with G4 pinned, the real engine and simulator, and only simulated robots.

**`runDemo.js`: 13/13 checks in each of four runs**, including one after a full teardown and rebuild.
- Every recipient decision matched the independent oracle (G4 cell lookup plus 1 m corridor sampling).
- Each report had a cross-zone recipient.
- The duplicate merged, with no new alert or verdict.
- Unrelated and idle robots were not alerted.
- OFFER rows were byte-identical, and there were 0 REROUTE/RESEQUENCE rows.
- Socket.IO receipt was observed by a real dashboard socket, and by each robot's own socket (its verdict).

**Headless-Chrome `uiCheck`: 16/16.**
- The normal map, then the Zones view with the four G4 zones.
- Markers sourced from the server.
- Panel entries marked SIMULATED and active, and "+1 report" on the duplicate.
- The detail view, with recipients, the cross-zone tag, the reasons and the no-reroute note.
- The offline and reconnect note, with no duplicates after reconnecting.
- The 390 px phone layout, with no horizontal scroll.
- Entries and markers expired at the server time.
- 0 console errors.

Evidence is in the session scratchpad `evidence-dtaro/`: the demo runs, `demo-evidence.json`, `ui-check.json` and 6 screenshots. The stack was torn down afterwards.

### Simulated vs physical

- **Simulated:** every obstacle report, every robot in the demo, and the demo database and server.
- **Real code paths:** the socket server, the handler, spatial resolution, route reads, the recipient policy, Socket.IO rooms, dashboard events, the frontend store, the panel and map layer, and the live engine (OFFERs).
- **Not exercised:** physical robot obstacle detection. The Pi emits no `OBSTACLE_REPORT`, and physical robots are refused (A-6).
- **Not verified on production:** obstacle delivery. By instruction, no production report was made.

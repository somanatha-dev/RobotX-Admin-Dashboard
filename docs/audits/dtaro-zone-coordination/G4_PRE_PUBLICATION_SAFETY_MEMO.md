# G4 final pre-publication safety audit: owner decision memo

> **Owner decisions, 2026-10-23 (later the same day).**
>
> - **Q10:** empty bounding boxes accepted; no code change.
> - **Publication guard:** approved for implementation and regression verification. It is implemented, re-verified and still **uncommitted**:
>   - focused tests 7 / 7;
>   - G4 consumer and DTARO suites 238 / 238;
>   - the full backend suite;
>   - full backend 11,190 passed / 15 skipped / 0 failed (a run that overlapped the live demo had 3 timing failures, including `b1CommitAuthority`, which passed 21/21 alone; the quiet re-run was clean); real HTTP on the fresh disposable `robotx_guard_verify`: missing rows → 422, with pin, versions, bindings and Zone rows byte-identical; rows created → 200, v2 pinned.
> - **Route-containment fix:** NOT approved; not applied.
> - **Real G4 publication:** NOT authorised; nothing was published to any real database.
> - **Frozen V1 engine:** unchanged.
>
> **Known gap, by decision:** code that calls `configService.publish` / `pinVersion` directly (scripts, tools) bypasses the guard. Closing it requires the engine-level patch described in §2 under a V1-freeze exception. Until then, the rule is that zone maps are published only through `POST /api/config/publish`, or through `rehearseG4Publication.js` on a disposable cluster.

**Date:** 2026-10-23.
**Branch:** feature/dashboard @ 5e94a1a, with uncommitted changes.
**Scope:** G4 was not published or pinned in any real database, and no real database was opened. Integration evidence comes from a throwaway cluster:

- port 55474;
- data directory `%TEMP%\robotx-g4-pubrehearsal\pgdata`;
- system identifier `7699791088827621048`;
- databases `robotx_g4_rehearsal` and `robotx_g4_norows`.

## Verdict

| Issue | Status | One line |
|---|---|---|
| 1. Legacy zone identity / lookup (Q10) | **PASS** | No live assignment, routing, authorisation or dashboard decision reads `rnsit-z1` once G4 is pinned. The legacy box chain keeps *writing* `rnsit-z1` to a mirror that nothing reads. |
| 2. Publication prerequisite enforcement | **REQUIRES APPROVAL** (to ship) | The hazard is proven live. A non-engine guard on the production publish route is implemented and proven live, but is uncommitted. No engine change was needed. |
| 3. Campus route containment | **REQUIRES APPROVAL** (G4-5, V1-freeze exception) | One private service road (`way/788480062`) causes all 50 out-of-boundary routes. The fix is fully quantified but changes commanded routes, so it was **not applied**. |

---

## 1. Legacy zone identity (Q10): PASS

`rnsit-z1` is not hard-coded anywhere in `src/` or `Frontend/src`. It appears only in tools (seed, bootstrap, verifiers) and as data: the `Zone` row, `CellAssignment` and the published map.

| # | Consumer (source) | Zone source | In the production path? | After G4 is pinned | Proof |
|---|---|---|---|---|---|
| 1 | F27 authorised set (`services/agentFacts.service.js:130`, `fleetProviders/physicalFacts.js:136`) | `Zone` rows `where: { regionId }` | **Yes**: every assignment round | Includes the 4 G4 rows once they exist; missing rows break assignment (issue 2) | Unit: `g4ZoneConsumers` (F27 VIOLATED → SATISFIED). Live: `norowsProof` (280 F27 rejections → OFFER) |
| 2 | Route traversed zones for F27/F30 (`services/v1DemonstrationComposition.js:372–396`, `fleetProviders/physicalProvider.js:189–204`) | **Published map** (`hierarchy.indexMap(pinned.spatial)`), agent cell and stop cells | **Yes** | G4 zone ids | Unit: every cover cell resolves to G4. Live: 4 OFFERs under G4 (rehearsal) |
| 3 | F30 zone restrictions (`services/v1DemonstrationProfile.js:163`) | None: `[]` for any zone id | Yes | No change | Unit |
| 4 | DTARO zone rooms, recipient policy, alerts (`services/dtaroZoneAlert.service.js`, `dtaroRecipientPolicy.js`) | **Published map** | Yes, with `DTARO_ZONE_ALERTS_ENABLED=true` | G4 | DTARO suites; live rehearsal (oracle agreed on 3 reports) |
| 5 | `/api/dtaro/zones` (dashboard zone layer) (`services/dtaroZoneView.service.js`) | Published map; `Zone.name` for display only | Yes | G4 geometry and names | Live: preview vs served map 64/64 |
| 6 | `ObstacleEvent.zoneId` FK (`services/ekb.service.js:79`, called from `dtaroZoneAlert.service.js:378`) | Published-map zone id → `Zone` FK | Yes | G4 ids. A missing row makes the insert fail **silently** (swallowed), so the obstacle is delivered but not persisted. | Live: rows stored `rnsit-z-east/west` under G4 |
| 7 | **Legacy box lookup** `zoneManager.getZoneForCoordinates` (telemetry `telemetry.handler.js:1123`, AUTH `robot.handler.js:1102`) | `Zone` boxes, first by name | **Runs** on every telemetry tick | Keeps answering **`rnsit-z1`** (G4 rows have degenerate boxes) | Unit (plus a counterexample: real G4 boxes would change it). Live DB: `Robot.zoneId = rnsit-z1` under G4 |
| 7a | …which writes the registry `zoneId`, `Robot.zoneId`, the legacy `zone:<id>` room and the `ZONE_UPDATED` event | (writes only) | Runs | **Nothing reads them.** The readers named in `zoneManager`'s docstring (`costEvaluator`, `taskAssignment`) are retired (`gate:legacy` PASS). Nothing emits to `zone:<id>`. The dashboard has no `ZONE_UPDATED` handler. | Code search; `gate:legacy` |
| 8 | Legacy obstacle dissemination `alertDissemination.processObstacleReport` (`dtaro.handler.js:215`) | Box lookup → `rnsit-z1` | **Only when `DTARO_ZONE_ALERTS_ENABLED` is off** | Unchanged (`rnsit-z1`). **G4 has no effect unless the flag is on.** | Code: `dtaro.handler.js:140` branch |
| 9 | `seedDefaultZones` (`sockets/socket.server.js:186`) | Creates boxes only if the `Zone` table is empty | Boot | No-op (rows exist) | Code |
| 10 | Zone-priced cost: `cOpportunity` / `vTerminal` / λ-zone (`capacityPricing.worker`) | Agent origin zone, price surface | **No**: `killswitch.opportunity_cost_term` is thrown in every version (`TIER_ONE_BASELINE`); the worker is DEFERRED | None. Before Phase 16a enables it, the surface must cover the G4 ids. | Unit (default thrown); DB: all versions `true` |
| 11 | Zone-scoped config bindings (`engine/config/resolver.js` supports a `zone` level) | Bindings keyed by zone id | None are published (only `global` ×21 and `region` ×1) | None. A future zone binding must use G4 ids. | DB query |
| 12 | Rejection telemetry and metrics zone dimension (`coordinatorSolvePath.js:2038` → `RejectionAggregate.zoneId`; diagnostics `?zone=`) | `agentSnapshot.zoneId`, which no snapshot builder sets | Yes (telemetry) | `NULL`, as today | Live: 492 F27 rows, `zoneId NULL` |
| 13 | Feasibility cache class key with a zone (`engine/feasibility/cache.js:101`) | n/a | **No caller** | None | Code search |
| 14 | `CellAssignment` table | Seed / `bootstrapV1Environment` | No runtime reader | Stays `rnsit-z1` ×64 (stale). The bootstrap's *verify* would fail, and it **refuses** to replace a pin it did not publish, so it cannot revert G4. | Code: `bootstrapV1Environment.js:289` |
| 15 | Authorisation / RBAC | Campus / region, no zones | Yes | None | Code search |

**Smallest safe resolution:**

- Choose **Q10 = degenerate boxes for the G4 rows**. This needs no code change and introduces no second ownership source: the published map remains the only zone owner for every live decision.
- **Treat `Robot.zoneId`, the registry `zoneId`, the legacy `zone:<id>` rooms and `CellAssignment` as legacy mirrors.** They say `rnsit-z1` (or `NULL` outside the boundary box) after G4. Do not use them for diagnosis.

Retiring the legacy box chain, or fixing its stale docstring, is a separate cleanup and is not needed for G4.

## 2. Publication prerequisite enforcement: REQUIRES APPROVAL

**Production paths that can pin:**

1. **`POST /api/config/publish`**, through `config.controller.publishVersion`. It requires auth, SUPER_ADMIN, an elevated role, and `SAFETY_CONFIG_CHANGE` with a verified second approver. It **publishes and then pins at once**. This is the operator path.
2. The cutover `rollbackPublisher` (automatic). It re-publishes the version in force, carrying its spatial map forward, so it cannot introduce a missing reference.
3. `tools/deploy/bootstrapV1Environment.js`. It creates `rnsit-z1` itself and refuses foreign pins.

`configService.publish` (frozen engine) validates structure only.

**Hazard, proven live** on `robotx_g4_norows`, with G4 pinned straight through `configService` and no G4 rows: the engine accepted the version. A West→East task then stayed **PENDING, 0 OFFERs, 280 F27 rejections in 60 s**, and **no line in the server log** said why.

**Guard (non-engine, implemented, uncommitted):**

- `src/services/spatialZoneReferences.js` holds one implementation of the invariant: every zone the map names is a `Zone` row in the map's region, and every cell's zone is listed.
- `config.controller.publishVersion` runs it **before** `configService.publish`, and therefore before the pin, returning **422** with `ZONE_REFERENCE/F27` findings.
- The rehearsal tool delegates to the same function.

**Proof** on the real server and route, with all middleware:

- missing rows → **422**, 4 findings, versions `1,2` unchanged, pin unchanged;
- rows created → the same task assigned (OFFER to V1DEMO-04);
- the same publish → **200**, v3 published and pinned.

**Approval required:**

- Owner approval to commit and deploy the guard: a behaviour change on the safety-configuration route (a new refusal for invalid maps only; valid maps are unaffected).
- Operational rule: ad-hoc scripts that call `configService.publish` directly bypass it; only `rehearseG4Publication.js` (disposable) and the HTTP route are sanctioned.

**Optional defence in depth (NOT applied; frozen engine, needs a V1-freeze exception):** call the same check inside `configService.publish` (before `prisma.$transaction`) and inside `pinVersion` (re-checking the target version's map). That is roughly 8 lines, plus `prisma.zone.findMany` in the service.

Residual exposure without it:

- **Out-of-band scripts.** A script that calls `configService.publish` directly is not covered.
- **Zone deletion.** A `Zone` row deleted by SQL after pinning is not covered; no API deletes zones, and the FKs are `SetNull`, so the database would not stop it.

## 3. Campus route containment: REQUIRES APPROVAL (G4-5)

**Audit** (read-only; the simulator's own network builders over 26 endpoints and 650 ordered pairs):

| Finding | Value |
|---|---|
| Pairs leaving the boundary | **50 / 650**: every pair to or from **Playground 2**, which sits at 12.899483, 77.516086, 41.7 m *inside* the boundary |
| Cause | The live, uncontained network snaps Playground 2 to **`way/788480062`** (`highway=service`, `access=private`) at 12.899437, 77.516544, which is outside the boundary |
| Exact out-of-boundary geometry | **68.2 m along `way/788480062`**, from 12.900051, 77.516608 to 12.899437, 77.516544 (segment 12.900150, 77.516618 → 12.899437, 77.516544), plus **8.0 m of the access connector**; max **8.1 m** outside |
| Zone effect under G4 | All 2,964 outside samples fall in two South-west cover cells, so no robot is left without a zone |

**Proposed fix (NOT applied).** In `src/services/v1DemonstrationComposition.js`, pass `containment: routeContainment.createRouteContainment(declaration)` from `networksFrom(extract)` into `createCampusTraversalNetwork`. That is about 4 lines, and the same pattern `fleetProviders/physicalRouter.js:107` and `simulation/chargerRoute.js:101` already use. The network then *drops* the 19 segments outside or touching the boundary (93 → 74 vertices, 98 → 79 segments). It clips nothing.

| Verification of the fix | Result |
|---|---|
| The 50 pairs routed / refused | 50 / **0** |
| Metres outside the boundary | **0** on every pair |
| Invented geometry | **0**: every interior step is an existing OSM way segment; only the two endpoint access connectors are straight lines, as today |
| Crossings of excluded road classes (`residential`, `steps`) | **0** (the live routes: 0) |
| Length change | **−22 m** on each of the 50 (e.g. PU College ⇄ Playground 2: 410 → 388 m) |
| Other 600 pairs | Identical |
| Access connector at Playground 2 | 49.9 m → **59.7 m** (straight, inside the boundary). Neither network has a walkway into the playground, and R13's `maxAccessM` is not declared. |

**Approval required:** G4-5 plus a V1-freeze exception. The change alters commanded OFFER paths, their priced length and the corridor completion is graded against, for tasks to or from Playground 2 only. A follow-up worth deciding with it is declaring R13 `maxAccessM`; today a connector of about 60 m is accepted.

## Tests (actual results)

- **New:** `tests/unit/dtaro/g4ZoneConsumers.test.js`, 12 tests. Together with `rehearseG4Publication.test.js` (14): **26 / 26** pass.
- **Full backend suite (after the guard):** 352 of 353 suites passed and 1 was skipped (`redisKv`, by design); 11,183 tests passed, 15 were skipped, and **0 failed**.
- **Gates:** 7 / 8. `composition` fails with `LEADER_ONLY_NOT_COMPOSABLE` (pre-existing B1); `tiers`, `params` and `tenets` pass with the new module.

## Remaining risks

1. G4 only changes alert delivery when `DTARO_ZONE_ALERTS_ENABLED=true`. With it off, the legacy box path (`rnsit-z1`) runs regardless.
2. The legacy mirrors (`Robot.zoneId`, `CellAssignment`) will disagree with G4; anyone reading them will see `rnsit-z1`.
3. HTTP publish does not carry `shards`. Today every version has `shards: null`. If shards are ever published, the HTTP route would drop them.
4. Phase 16a (live λ-zone) must price the G4 zone ids before it releases the kill switch.
5. Three LOW-confidence tie decisions and the T03 site survey remain open (G4-2, G4-3).

## Changed files (uncommitted; this task)

- New: `Backend/src/services/spatialZoneReferences.js`
- Changed: `Backend/src/controllers/config.controller.js` (guard before publish)
- Changed: `Backend/tools/demo/dtaro/rehearseG4Publication.js` (delegates to the shared check)
- New: `Backend/tests/unit/dtaro/g4ZoneConsumers.test.js`
- New: this memo

No engine module, migration, frontend file, commanded route or live map was changed.

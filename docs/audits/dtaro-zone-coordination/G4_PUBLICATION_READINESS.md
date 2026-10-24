# G4 publication readiness and disposable-database rehearsal

**Date:** 2026-10-23.
**Branch:** feature/dashboard @ 5e94a1a, with uncommitted changes.
**Verdict:** G4 is **technically ready to publish**. Publication is **BLOCKED on owner authorisation** and on the open owner decisions listed below. Nothing was published or pinned in any real database.

The rehearsal ran end to end on a newly initialised throwaway PostgreSQL cluster:

- port 55474;
- data directory `%TEMP%\robotx-g4-pubrehearsal\pgdata`;
- system identifier `7699791088827621048`.

It ran against the real `server.js`, the assignment engine, the simulator and the dashboard. No other database was opened.

## 1. Prerequisites

| # | Prerequisite | Status | Evidence |
|---|---|---|---|
| 1 | All 64 cells in exactly one of `rnsit-z-west` / `-east` / `-south` / `-southwest` | **PASS** | 15 / 17 / 14 / 18 cells; digest `13be3a93…`; stage DECIDED, 0 unresolved |
| 2a | Zone connectivity | **PASS** | Each zone is one H3-connected piece, and each zone's walk network is one connected part |
| 2b | Campus containment | **PASS (cells)** with a **LIMITATION (routes)** | Every cell touches the campus. All 1,260 walk-network pieces lie strictly inside the boundary. Simulator routes are a separate matter (see §4). |
| 2c | Region isolation | **PASS** | JSSATE cover (69 cells) shares 0 cells. Live: the region-2 robot got `OTHER_REGION` in all 3 reports. |
| 2d | Site access points | **PASS** | All 18 verified access points join their own zone's walk network |
| 2e | Publication validators | **PASS** | `hierarchy.validateForPublish` ok, V8 0 findings, on the real version derived from the pinned one |
| 2f | Zone-row references | **PASS, but only via the new preflight** | `configService.publish` does not check that map zones exist as `Zone` rows. F27 needs them. See §3. |
| 3 | Disposable rehearsal: rows → validate → publish → pin → rollback → recover | **PASS** | Steps R0–R9 all PASS (§2) |
| 4a | Same-zone alert | **PASS** | Live |
| 4b | Cross-zone alert on the remaining authoritative route | **PASS** | Live: 3 robots in 3 reports |
| 4c | No alert on an unrelated route | **PASS** | Live: `ROUTE_CLEAR` |
| 4d | No delivery across regions | **PASS** | Live: `OTHER_REGION` |
| 4e | Duplicate merging | **PASS** | Live: merged, 0 new alerts, 0 new verdicts |
| 4f | No OFFER mutation, no REROUTE | **PASS** | 4 OFFER rows with identical digests throughout, including the live rollback; 0 REROUTE/RESEQUENCE |
| 5 | Preview and recipient policy agree; preview read-only | **PASS** | Preview vs served map 64/64. Every server zone verdict equals the G4 oracle. Toggling makes no writes; `approved: false`, `published: false`. |
| 6 | Regression | **PASS** | See §5. Gate `composition` fails as before (pre-existing B1). |
| 7 | Owner authorisation and decisions G4-1 … G4-6 | **BLOCKED** | Not given. The actual publication stays pending. |

## 2. Rehearsal (disposable cluster, executed)

Tool: `Backend/tools/demo/dtaro/rehearseG4Publication.js --rehearse`.

| Step | Result |
|---|---|
| R0 | Guard. The server's own `data_directory` equals the throwaway cluster's, and that directory is under `%TEMP%`. The tool refuses anything else before any query. |
| R1 | Before: v1 pinned (the seed), cover resolves to `rnsit-z1` ×64, one Zone row. |
| R2 | Candidate = pinned v1 restated exactly. 64 cells changed zone; regions and sites identical; engine findings 0. |
| R3 | The preflight **refused** while the four Zone rows were missing ("F27 would refuse every route through it"). `publish` would have accepted the map. |
| R4 | Four Zone rows created with degenerate boxes. F27's authorised set in `rnsit` is now `rnsit-z1` plus the 4 G4 zones. |
| R5 | Published **v2**, not pinned (the pin stayed at v1). Parameter values identical; bindings, kill switches, regimes, delivery domain and shards identical; safety-class changes `[]`. |
| R6 | Pinned v2 (23 ms). The alert path resolves 64/64 cells to G4. |
| R7 | **Rollback:** re-pinned v1 (20 ms), giving `rnsit-z1` ×64. v2 is kept and immutable (signature unchanged). |
| R8 | **Recovery:** re-pinned v2 (16 ms), 64/64 G4, same signature. |
| R9 | A map naming a zone that has no Zone row passes the engine validators; only the preflight catches it. |

**Live rollback with the server running.** Re-pinning v1 took 30 ms, and `server.js` served `rnsit-z1 (64)` within 30 s (its propagation tick). Re-pinning v3 restored the four zones within 30 s. OFFER rows were unchanged throughout. A report after recovery delivered under the four zones.

v3 is **demonstration only**: the G4 version plus a synthetic second region, used to show region isolation. Its RNSIT part is byte-identical to v2.

## 3. Findings to act on before a real publication

1. **The publish path has no Zone-row reference check.** Pinning G4 before its four Zone rows exist would make F27 reject every RNSIT route. The rehearsal tool's preflight (`zoneRowFindings`) closes this, but a production publication path (HTTP `POST /api/config/versions`, or a reviewed script) must run the same check. Consider adding it to `configService.publish`; that is an engine change and needs owner approval.
2. **Zone rows use degenerate boxes**, so the legacy bounding-box zone (`Robot.zoneId`, `alertDissemination`, legacy zone rooms) stays `rnsit-z1`. DTARO alerting reads the published map and is unaffected. This is open owner decision Q10 (Zone row bounding-box policy).
3. **Rollback leaves the four G4 Zone rows in place.** They are inert under v1: no cell names them, and their boxes never match. Deleting them is optional and was not rehearsed.
4. The published-view labels use the long Zone names and crowd each other when all four are on screen. This is a cosmetic issue in the diagnostic view only; the Normal map, the default, shows no zones. No UI change was made.

## 4. Known limitations (stated, not hidden)

- **Simulator routes leave the authoritative boundary.** 50 of 650 route pairs, all to or from Playground 2, go up to **8.1 m** outside. Every sampled out-of-boundary point (2,964 samples on 38 routes) lies in two **South-west** cover cells (`…048b`, `…0489`). So a robot there still resolves to a zone; there is no zone-less gap. The live dashboard flagged "1 route issue against the campus geometry". The fix (contain `networksFrom`) changes commanded routes, is NOT applied, and needs owner approval (G4-5).
- **Low-confidence decisions.** 15 ties were decided (9 HIGH, 3 MEDIUM, 3 LOW). The LOW ones need owner review:
  - `…049a` → West (R4; T03 needs a site survey);
  - `…049b` → West (R3);
  - `…286a` → West (R3).
- **Cross-zone coverage depends on the server-side remaining route.** Offline: zone-only delivery misses 8,396 of 21,788 relevant robot moments; zone plus route misses **0**. The charger approach is not a server-side route, and physical robots are excluded (A-6).
- No automatic reroute exists. The decision is advisory only (OD-3).

## 5. Tests (actual output)

- **Targeted backend suites:** 25 suites, **762 / 762** pass. They cover publication/config, DTARO unit/integration/socket, G4, zone map, ties, boundary regression, containment, F27/feasibility, the V1 launcher and config, and the Phase 15 remediation.
- **Full backend suite:** 351 of 352 suites passed and 1 was skipped; 11,171 tests passed, 15 were skipped, and **0 failed** (691 s). The skipped suite is `redisKv`, skipped by design.
- **New tests:** `tests/unit/dtaro/rehearseG4Publication.test.js`, 14 / 14 pass.
- **Frontend:** `test:arch` **726 / 726**; lint clean on map, DTARO and lib; build ok.
- **Gates:** 7 / 8. `composition` fails with `LEADER_ONLY_NOT_COMPOSABLE`; this is pre-existing (B1).

## 6. Changed files (this task; uncommitted)

- New: `Backend/tools/demo/dtaro/rehearseG4Publication.js` (audit, rehearsal, demo region, `--pin`; disposable-only).
- New: `Backend/tools/demo/dtaro/rnsit-dtaro-g4-scenario.json` (12 rehearsal obstacles, 3 per zone).
- New: `Backend/tests/unit/dtaro/rehearseG4Publication.test.js`.
- New: this report.

No `src/` file, engine module, frontend file, migration or live map was changed.

## 7. To publish for real (pending authorisation, not done)

1. Owner approves G4-1 (layout), G4-2 (decisions; 3 LOW), G4-3 (T03 survey), Q10 (box policy); decides on G4-5 (route containment).
2. Choose the production publication path and have it run the Zone-row preflight (finding 1).
3. Back up the production database. Record the currently pinned version, which is the rollback target.
4. Create the four Zone rows. Verify that F27's authorised set includes them.
5. Publish a version that restates the pinned one with only the RNSIT cells reassigned, plus approvals as the path requires. Verify publish is unpinned and parameters are identical.
6. Pin it. Verify 64/64 through the alert path and through `/api/dtaro/zones` after the propagation tick.
7. If anything is wrong, re-pin the recorded version; the rehearsal measured about 30 s for the server to switch.

Evidence (session scratchpad, `g4pub/FINAL/`): `audit.json`, `cluster-verification.txt`, `rehearsal-output.txt`, `g4demo-output.txt`, `g4demo-evidence.json`, `agreement.json`, `g4ui.json`, `jest-targeted.txt`, and the screenshots `g4-1-normal-map.png`, `g4-2-zones-preview.png`, `g4-3-published-g4.png`, `g4-4-obstacle-panel.png`, `g4-preview-vs-published.png`.

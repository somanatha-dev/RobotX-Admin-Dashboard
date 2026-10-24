# RNSIT four-zone layout G4 — validated zoning proposal

| | |
|---|---|
| **Status** | **VALIDATED PROPOSAL.** Every offline check passes. **Not approved by the owner, not published, not pinned.** The published map is unchanged: one zone, `rnsit-z1`, all 64 cells |
| **Updated** | 2026-10-23, applying the owner's design directive of the same day. The earlier version of this file (2026-10-22) described the *generated* stage only |
| **Baseline** | `feature/dashboard` @ `5e94a1a`. The tracked working tree is unchanged by this work; other sessions' uncommitted files are untouched |
| **Generator** | `Backend/tools/campus/rnsitZoneLayoutG4.js` (offline; no database, no network, no runtime importer) |
| **Generated evidence** | [RNSIT_ZONE_LAYOUT_G4_EVIDENCE.md](RNSIT_ZONE_LAYOUT_G4_EVIDENCE.md): every number below, the decision table, the validation checks, and all 64 cells |
| **Preview** | [rnsit-zone-proposal-g4-preview.html](rnsit-zone-proposal-g4-preview.html) (offline) · [rnsit-zone-proposal-g4.geojson](rnsit-zone-proposal-g4.geojson) |

## 0. Three states — keep them apart

| State | What it is | Digest | Cells without a zone | May robots or alerts use it? |
|---|---|---|---|---|
| **Generated proposal** | Instruments only: member footprint, then walk distance. L4's 14 ties are left open | `52bb2005…76f51cb` | 14 | No |
| **Validated proposal** | Generated, plus decision rules R1–R4 (§3). All 13 offline checks pass (§5) | `13be3a93…9145d39` | 0 | **No.** It still needs owner approval, the publication prerequisites (§9) and the cross-zone wiring (§6) |
| **Published map** | The pinned configuration: `rnsit-z1`, one zone, 64 cells | — | 0 | Yes, as today. **Unchanged** |

---

## 1. Result

- **Exactly four zones, every cell with exactly one owner, and no open cells.**

  | Zone | Cells | Boundary cells | Polsby–Popper | Extent |
  |---|---|---|---|---|
  | `rnsit-z-west` | 15 | 4 | 0.622 | 187 m |
  | `rnsit-z-east` | 17 | 5 | 0.426 | 267 m |
  | `rnsit-z-south` | 14 | 4 | 0.507 | 200 m |
  | `rnsit-z-southwest` | 18 | 6 | 0.507 | 268 m |

- **Every zone is walkable inside itself.** Each zone's share of the boundary-contained footway, path and service network is **one connected part**:

  | Zone | Network length | Ways |
  |---|---|---|
  | West | 837 m | 11 |
  | East | 754 m | 7 |
  | South | 535 m | 5 |
  | South-west | 312 m | 2 |

  All 18 site-verified access points join their own building's zone's network. In the generated stage, West's network was in 4 parts and East's in 5.
- **Zone changes along walkways fall to 10.** In total across the 21 permitted ways they drop from 27 (generated) and 26 (L4) to **10**, with at most 3 on any one way.
- **The engine's own publish validators accept the candidate map**, offline, with a stand-in region id (`hierarchy.validateForPublish` ok; V8 has 0 findings). This is a check, not a publication.
- **15 decisions were made by rule** (§3): **8 HIGH, 4 MEDIUM, 3 LOW** confidence. The three LOW ones (T03, T04, C1) are where an instrument disagrees, and they need owner review. T03 also needs a site survey.

---

## 2. What was inspected

| Item | Finding |
|---|---|
| G4 files from 2026-10-22 | Present and reproducible (`--check` passed before any change) |
| Tie evidence (`RNSIT_ZONE_TIE_EVIDENCE.md`) | Unchanged; regenerates identically. Reused for what is in each tied cell |
| Working tree | 14 tracked files modified and many untracked DTARO files, all from earlier sessions; none edited here. New since 2026-10-22: `Backend/tests/engine/dtaroCampusBoundaryRegression.test.js` (another session, 22:49). It records the route-containment gap as a `test.failing` (§7). Left untouched |
| Walk graph | Junction-by-junction (evidence §2 and §5). Two facts decided the layout: |

The two graph facts:

- **West's north footway `1510483622` reaches the rest of West only through cell `…286a`.** The junction of `1510483621` and `1539965405` lies in it.
- **The hostel lane `788480057`, with footways `788480058`/`059`, meets the rest of the network only in T04 (`…049b`).** That is its junction with `1539965404`.

---

## 3. Decision rules and the decision for every cell

The rules are applied in order and deterministically. Each decision records its rule, its evidence, a confidence, and the authority *"Owner design directive 2026-10-23 … not owner-approved per cell"*.

| Rule | Condition |
|---|---|
| **R1** | The tie borders exactly one proposed zone, and no other zone's member footprint touches it |
| **R2** | Both instruments (member-footprint area and walk distance) name the same competing zone |
| **R3** | **Connectivity repair.** While a zone's walk network is split, a cell on its border moves in if that joins the parts, and the donor zone stays contiguous and no more split. An owner override is never moved |
| **R4** | The only competing zone that keeps every zone's walk network unsplit and every zone contiguous |

Anything left after R4 stays open; nothing did.

**Confidence** is:
- **HIGH** when all the evidence agrees and is strong;
- **MEDIUM** when it agrees but is weak, or the decision came from connectivity;
- **LOW** when an instrument points elsewhere.

A HIGH decision that does not survive every seed variant (§5) is shown as MEDIUM.

| Cell | | Decision | Rule | Confidence | Evidence in one line |
|---|---|---|---|---|---|
| T01 | `…0490fff` | East | R2 | MEDIUM | MBA corner (11 % of the cell); walk East by 11.6 m |
| T02 | `…0493fff` | South | R2 | HIGH | RN Shetty Statue (12 %); walk South by 92 m |
| **T03** | `…049afff` | **West** | **R4** | **LOW** | Hostel and hostel-cluster buildings (22 %, West); walk South by only 14.6 m. **South would strand a 12 m piece of hostel footway `788480059` in South; West is the only owner that keeps every network whole.** Three *unverified* institution points sit in this cell: **site survey recommended** |
| **T04** | `…049bfff` | **West** | **R3** | **LOW** | International School sliver (1 %, South-west); walk West by 18 m. **Holds the only junction joining the hostel lane to West** |
| T05 | `…04b1fff` | South | R1 | HIGH | Only neighbour |
| T06 | `…04b3fff` | South | R2 | MEDIUM | Motorcycle parking (14 %); walk South by 13 m. Seed-sensitive: open under `NAMED_MEMBERS_ONLY` |
| T07 | `…2841fff` | East | R2 | MEDIUM | Toilets (7 %); walk East by 51 m. Seed-sensitive: open under `ACCESS_POINTS_FIRST` |
| T08 | `…2861fff` | East | R1 | HIGH | Only neighbour (Mec & EEE corner) |
| T09 | `…2866fff` | East | R1 | HIGH | Only neighbour; enclosed by East |
| T10 | `…2868fff` | West | R2 | MEDIUM | Dormitory hostel sliver (0.3 %); walk West by 85 m; holds the junction of 204638946, 204638947, 768598925 and 1539965405 |
| T11 | `…286cfff` | East | R1 | HIGH | Only neighbour (sports ground) |
| T12 | `…286dfff` | West | R2 | HIGH | Dormitory hostel (8 %); walk West by 146 m |
| T13 | `…2b20fff` | South-west | R1 | HIGH | Only neighbour; nothing mapped |
| T14 | `…2b26fff` | South-west | R2 | HIGH | International School (48 %); walk South-west by 83 m |
| **C1** | `…286afff` | **West** (was East) | **R3** | **LOW** | Main Building 22 % against ECE 2 %, and the walk favours East by 7.5 m. **Left East, West's walk network is split, because its north footway is cut off. Moved West, every network is whole and East stays one part** (owner directive item 2) |

**Note on C1.** The Main Building's west end, and one unverified Main Building access *candidate*, now lie in West. The single-owner model is kept, because buildings already span several cells. Connectivity was chosen over footprint, as the directive asked.

---

## 4. The zones

| Proposed ID | Name | Landmarks (member footprints) | Walkways (main) |
|---|---|---|---|
| `rnsit-z-west` | RNSIT West — CSE/ISE/CSDS, ECE, Civil & AIML, hostels | CSE/ISE/CSDS, ECE, Civil & AIML (9 site-verified access points); three hostels; Fountain (landmark only) | `1183883496`, `1510483622`, `204638946`, `788480057`, `768598925` (north part), `1539965405`/`1510483621` |
| `rnsit-z-east` | RNSIT East — Main Building, Canara Bank, Canteen (north), Basketball Court, Mec & EEE, MBA | Mec & EEE and MBA (6 verified points); Main Building (most of it), Canara Bank, north Canteen, Basketball Court, parking, toilets, theatre | `204638948` (perimeter road), `204638949` (spine, north part), `204638950`, `655840340` |
| `rnsit-z-south` | RNSIT South — Auditorium, Canteen (south), Shiva Temple | Auditorium, south Canteen, Shiva Temple, RN Shetty Statue, motorcycle parking. Innovation Center (the V1 depot), PU College and Food Court are unverified points | `204638949` (south road), `1539965404`, `1112008837` |
| `rnsit-z-southwest` | RNSIT South-west — RNS International School and the south-west lobe | International School (3 verified points); Playground 2 (unverified point; no outline exists) | `204638949` (west end), `1539965404` (south part) |

**Why the lines are where they are:**

- **East is one zone** because its buildings share cells in a chain, across `…2865`, `…2860` and `…2863`.
- **The south-west lobe** sits behind a 31 m boundary neck.
- **West** now owns the corridor west of the sports ground (`…286a`, T10), which its own walkways need.

---

## 5. Validation (offline)

All 13 checks pass on the validated stage. Generated directly from `validateLayout`:

| Check | Result |
|---|---|
| `PERIMETER_UNCHANGED`: file digest, and identical to the published delivery-domain declaration | PASS |
| `COVER_EXACT`: the adopted 64 cells | PASS |
| `SINGLE_OWNER`: each cell once, at most one zone | PASS |
| `ALL_ASSIGNED` | PASS (0 open) |
| `EXACTLY_FOUR_ZONES` | PASS |
| `ZONES_CONTIGUOUS`: H3 adjacency | PASS |
| `CELLS_TOUCH_CAMPUS`: every cell has in-boundary area | PASS |
| `SEEDS_INSIDE` | PASS |
| `WALK_NETWORK_CONNECTED`: each zone one part | PASS |
| `WALK_NETWORK_CONTAINED`: 1,260 pieces, all strictly inside | PASS |
| `ACCESS_POINTS_JOIN_OWN_ZONE`: 18 of 18 | PASS |
| `ENGINE_VALIDATORS`: `validateForPublish` + V8 | PASS |
| `REGION_ISOLATION`: JSSATE shares 0 of its 69 cells | PASS |

The generated stage fails exactly `ALL_ASSIGNED`, `WALK_NETWORK_CONNECTED` and `ENGINE_VALIDATORS`, as it should.

**Seed sensitivity.** The validated proposal was rebuilt under three other seed policies. Only T06 and T07 change, and in each case they stay *open*; they never move to another zone. No other decision, and no footprint- or walk-decided cell, moves.

---

## 6. Cross-zone obstacle awareness: the adopted policy

**Policy (owner directive item 5).** Warn every robot in the obstacle's zone, as today's zone room does. **Also** warn every robot in the *same region* whose **remaining commanded route** meets the obstacle's footprint. Never warn another region.

**Implemented as** `Backend/src/services/dtaroRecipientPolicy.js` → `selectRecipients()`. It is a pure function with 7 unit tests:
- same zone;
- cross-zone hit;
- clear route, and an obstacle already behind the robot;
- another region, even with a route through the obstacle;
- the reporter excluded;
- deterministic order;
- refusal on bad input.

**Wired on 2026-10-23** into `dtaroZoneAlert.processReport`, with the server-side route source of §8.1 (`src/services/dtaroCommandedRoute.service.js`). With today's single published zone it selects no cross-zone robot; it takes effect only when a multi-zone map is published.

**Quantified** on the simulator's own network:
- 342 routes between the 18 verified access points and the depot;
- each robot observed at every vertex of its route: **3,888 robot moments**;
- × 64 obstacle cells.

A moment is relevant when its *remaining* route meets the obstacle. The bulk computation is checked against `selectRecipients` itself on 8 obstacles and must match exactly.

| Map · recipients | Relevant | Warned, same zone | Warned, cross-zone | **Missed** | Warned, not relevant | Messages |
|---|---|---|---|---|---|---|
| Published single zone · zone room (today) | 21,788 | 21,788 | 0 | **0** | 227,044 | 248,832 |
| G4 · zone room only | 21,788 | 13,392 | 0 | **8,396 (38.5 %)** | 46,836 | 60,228 |
| G4 · **adopted policy** | 21,788 | 13,392 | 8,396 | **0** | 46,836 | 68,624 |

**What this shows:**

- **Cross-zone notification is required for 8,396 relevant robot moments.** That is 38.5 % of all relevant ones, spread across every ordered zone pair (evidence §7). The largest flows are East robots meeting West obstacles (1,298), West robots meeting East obstacles (1,222), and South robots meeting East obstacles (1,159).
- **The adopted policy misses none**, and adds only relevant robots. Its unnecessary warnings are the zone room's alone, and its total message count is 72 % lower than today's campus-wide broadcast.
- **Region isolation holds** in the unit tests and in the two-region map tests.

---

## 7. Separate issue: simulated routes leave the campus boundary

**Measured** with `Backend/tools/campus/simRouteContainmentProbe.js` (read-only):
- 650 ordered pairs of in-campus task endpoints: the 18 verified access points and the 8 user-supplied points that lie inside the boundary;
- routed on the **live simulator network**, which `v1DemonstrationComposition.networksFrom` builds **without containment**.

| | Live (uncontained) | Contained (candidate) |
|---|---|---|
| Pairs leaving the boundary | **50** (every pair to or from Playground 2, and only those) | **0** |
| Furthest outside | **8.1 m** (International School → Playground 2) | 0 m |
| Pairs refused | 0 | **0** |
| Other 600 pairs | — | **identical** (same length, same path) |
| Changed pairs | — | 50, each **22 m shorter** (PU College ⇄ Playground 2: 410 m → 388 m) |

**Cause.** Playground 2's access connector snaps to a way segment outside the boundary.

**Smallest safe correction (NOT applied).** In `v1DemonstrationComposition.networksFrom`, pass `containment: routeContainment.createRouteContainment(<pinned delivery-domain declaration>)` to `createCampusTraversalNetwork`.

- This is one argument. The physical router and the charger router already build the network this way.
- **It changes commanded OFFER paths, priced lengths and the corridor completion is graded against.** That falls under the V1 freeze, so it needs owner approval.
- It was tested in isolation (`tests/engine/simRouteContainmentCorrection.test.js`, 6 tests). The test also confirms the composition is unchanged.
- The DTARO demo route PU → Playground 2 still crosses the demo obstacle's cell after the correction, so the demo's RELEVANT outcome is preserved.
- After approval, the other session's `test.failing` in `dtaroCampusBoundaryRegression.test.js` should flip to a passing test.

---

## 8. What is still needed before any multi-zone publication

### 8.1 Wiring the cross-zone policy — DONE 2026-10-23 (implementation; no engine change)

`dtaroZoneAlert.processReport` must call `selectRecipients` with each same-region robot's **remaining commanded route**.

**Recommended source:** the commanded corridor the server already reads, which is the latest OFFER outbox payload's `stopSequence[].path` (as `dtaro.handler.readCommandedCorridor` does). Cut it at the robot's last accepted position.

- This is a read of existing engine data. It changes no engine semantics.
- Cross-zone recipients are then emitted to `robot:<id>` rooms, alongside the zone room.
- **This must ship and pass its tests before G4 is published.** Otherwise 38.5 % of relevant warnings are lost.

### 8.2 Authoritative fenced reroutes (architecture; needs OD-3 and lifting the V1 freeze)

**Verified today:**
- `REROUTE` is a mission command fenced at commitment scope (`engine/commitment/fencing.js`). It may only follow an OFFER (`engine/dispatch/sequence.js`).
- `VirtualRobot` consumes it (`newPath`).
- **Nothing produces it.**
- The task controller refuses engine reroutes with `409 ENGINE_REROUTE_UNAVAILABLE`.
- Completion is graded against the **latest OFFER only**.
- The campus router has no blocked-edge input.

**Required:**

| # | Piece | Change |
|---|---|---|
| 1 | Obstacle fact | A validated, region-scoped obstacle (with TTL and clearance rules: OD-4/OD-5) becomes an engine input |
| 2 | Router | `campusTraversalNetwork` accepts blocked segments (those meeting an active obstacle footprint) and stays deterministic |
| 3 | Producer | An engine round (coordinator or supervisor; supervision already names `QUERY_THEN_REROUTE_OR_ESCALATE`) computes a new path for each affected commitment. It emits `REROUTE` through the **outbox**, fenced with the commitment's current fence token |
| 4 | Corridor versioning | Settlement and `readCommandedCorridor` grade each fix against the corridor version **in force when it was taken**, not only the OFFER. **This is a settlement-semantics change** |
| 5 | Acknowledgement | The robot ACKs through the existing command ACK fence. No ACK leads to escalation |
| 6 | Replay | The reroute decision is recorded (decisionRef) so replay reproduces it |

**Decision needed:** the owner authorises OD-3 and the specific V1-freeze exceptions for items 3 and 4 (outbox producer, settlement corridor versioning). **Not done here.**

### 8.3 Publication prerequisites (unchanged from L4 §6)

1. Owner approval of G4 and of the 15 decisions, LOW ones first.
2. A site survey for T03.
3. `Zone` rows for the four IDs **before** pinning (F27).
4. A complete restated configuration version, keeping `deliveryDomain`.
5. `validateForPublish` + V8.
6. Two named approvers.
7. Rehearsal on disposable PostgreSQL.
8. Publish with `pin: false`, verify, then pin.

`rnsit-z1` stays published until all of this is done.

---

## 9. Tests (2026-10-23)

| Suite | Result |
|---|---|
| `tests/engine/rnsitZoneLayoutG4.test.js` | **40/40.** Groups: containment (5), determinism (3), generated stage (3), decisions R1–R4 (9), validated stage (6), published map untouched (2), region isolation (3), cross-zone (4), design claims (5) |
| `tests/unit/dtaro/dtaroRecipientPolicy.test.js` (new) | **7/7** |
| `tests/engine/simRouteContainmentCorrection.test.js` (new) | **6/6** |
| Targeted mutants, 9: rules R1, R2, R3; confidence; the policy's cross-zone step; the policy's region isolation; remaining vs whole route; walk-network containment; the probe's containment | **9/9 killed by their own targeted test.** M5 and M7 stop the G4 suite at load, because the model's built-in `selectRecipients` cross-check throws, as designed. All three files were restored byte-identical (md5 checked) |
| Neighbouring suites (L4 map, tie evidence, obstacle zone resolution, simulation boundary, `tests/unit/dtaro`, DTARO socket integration, the other session's boundary regression) | **16 suites, 290/290 pass** (including the three above). The other session's `test.failing` still "fails as expected": the correction is not applied |
| Gates | `npm run gates` chain: 7/8. `gate:composition` fails on the **pre-existing** B1 blocker, unchanged. The L4 in-app preview `--check` is up to date; the tie evidence regenerates identically |

```bash
cd Backend
npx jest --runInBand tests/engine/rnsitZoneLayoutG4.test.js tests/unit/dtaro/dtaroRecipientPolicy.test.js tests/engine/simRouteContainmentCorrection.test.js
node tools/campus/rnsitZoneLayoutG4.js --check     # the three review files are current
node tools/campus/rnsitZoneLayoutG4.js             # summary: stage, validation, decisions, cross-zone
node tools/campus/simRouteContainmentProbe.js      # the 8.1 m measurement
```

---

## 10. Reviewing the preview

1. **Open the page.** Open `docs/audits/dtaro-zone-coordination/rnsit-zone-proposal-g4-preview.html` in any browser. It works offline: no scripts or tiles are fetched. From PowerShell:

   `Start-Process "C:\Users\soman\OneDrive\Desktop\RobotX\docs\audits\dtaro-zone-coordination\rnsit-zone-proposal-g4-preview.html"`
2. **Read the map.**
   - The banner reads **VALIDATED PROPOSAL (offline checks pass) — NOT PUBLISHED, NOT PINNED, NOT APPROVED**.
   - The black outline is the authoritative perimeter.
   - Coloured hexagons are the four zones.
   - Labels **T01–T14** mark the former ties and **C1** the repaired Main Building cell.
   - Their inset dashed outline gives the decision's confidence: dark is HIGH, brown is MEDIUM, red is LOW.
3. **Inspect cells.** Hover any cell to see its rule, its confidence (including seed sensitivity), its footprint shares and walking distances, and what L4 did with it. The right-hand table lists every decision.
4. **GIS.** In QGIS, open `rnsit-zone-proposal-g4.geojson` and filter on `properties.role`: `PROPOSED_CELL`, `DECIDED_CELL`, `PROPOSED_ZONE`, `CAMPUS_PERIMETER`, `LANDMARK` or `VERIFIED_ACCESS_POINT`.
5. **Dashboard.** The in-app "proposal preview" still shows L4. The live zone layer shows the published `rnsit-z1`.

---

## 11. Files

**New (this pass):**
- `Backend/src/services/dtaroRecipientPolicy.js`
- `Backend/tools/campus/simRouteContainmentProbe.js`
- `Backend/tests/unit/dtaro/dtaroRecipientPolicy.test.js`
- `Backend/tests/engine/simRouteContainmentCorrection.test.js`

**Changed (untracked files from the 2026-10-22 pass):**
- `Backend/tools/campus/rnsitZoneLayoutG4.js`
- `Backend/tests/engine/rnsitZoneLayoutG4.test.js`
- this report

**Regenerated:**
- `RNSIT_ZONE_LAYOUT_G4_EVIDENCE.md`
- `rnsit-zone-proposal-g4.geojson`
- `rnsit-zone-proposal-g4-preview.html`

**Not touched:**
- every tracked file;
- the frozen engine (`src/engine/**`, outbox, fencing, settlement);
- `dtaroZoneAlert.service.js`;
- `v1DemonstrationComposition.js`;
- every database;
- other sessions' files, including `dtaroCampusBoundaryRegression.test.js`.

Nothing was committed.

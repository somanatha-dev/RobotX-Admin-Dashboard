# RD-2026-10-12-02 — Containment of simulated charger routes

| | |
|---|---|
| **Recorded** | 2026-10-12 |
| **Owner** | Project owner |
| **Status** | **APPROVED IN PRINCIPLE** by the owner on 2026-10-12 ("simulated charger routes must be contained within the correct campus traversal network … a narrow, explicit exception only for simulated charger-route calculations"). Recorded here, not as an ADR amendment: see §3 |
| **Subject** | The route a SIMULATED robot drives to its charging station (`Backend/src/simulation/chargerRoute.js`) and the reachability check of a declared station (`Backend/src/simulation/chargingStations.js`) |
| **Scope** | Development simulation only. No physical route, no task route, no assignment-engine route, no intake geofence |
| **Supersedes** | Nothing |
| **Contradicts a frozen record?** | **No** — see §3 |
| **Gates and verdicts** | **Unchanged** |

## 1. The decision

A simulated robot's route to a charger must stay strictly inside the pinned operating boundary: both
endpoints, both access connectors and every segment of the path. A robot that is not on the campus of
the pinned declaration (another campus such as JSSATE, or a bad position fix) is **refused by name**
(`OUTSIDE_OPERATING_BOUNDARY`) and is never joined to the network by a straight line. Before this
record, such a robot was routed to the RNSIT depot through an uncontained access connector
(3,250 m measured in the charging lifecycle audit, scenario S2c).

## 2. What it permits — exactly one new use

`Backend/src/simulation/chargerRoute.js` may `require` `Backend/src/services/fleetProviders/routeContainment.js`
and pass `createRouteContainment(declaration)` as the `containment` of the campus traversal network it
builds (`containedNetworkFor`). `chargingStations.js` obtains that same contained network from
`chargerRoute.containedNetworkFor`; it does not build a guard of its own.

Nothing else changes:

- no module under `Backend/src/` other than `routeContainment.js` constructs a serviceability oracle;
- the simulator never reads or writes `Stop.geofenceResult`, never calls `evaluatePoint`, `verdictFor`
  or `pinnedMembership`, and produces no geofence verdict;
- intake (`task.service.js`) remains the only producer of a pinned delivery-domain verdict;
- no buffer, tolerance or snap is applied (`RD-2026-08-30-01` §1), and no access-distance bound is
  invented (`RD-2026-10-12-01` AC2 stays pending).

## 3. Why this is a release decision and not an ADR change

`ADR-28` is frozen: it "is not amended, reworded, or reinterpreted by an implementing phase". It decides
that the containment of spatial **units** (region ⊃ zone ⊃ cell) is by published assignment, not by
query-time geometry. A charger route's geometry is not a spatial unit's containment: it is derived
route geometry checked by a routing-local guard that returns booleans. That is the same reading under
which `RD-2026-10-12-01` AC1 placed physical route containment in `routeContainment.js`, and this record
extends that guard's use by one simulator file, under the owner's approval in principle.

If the owner requires this to be recorded as an ADR instead, that requires deliberately unfreezing the
architecture and superseding `ADR-28` with a new record — a decision outside any implementing phase.

## 4. Evidence

- `Backend/tests/engine/routingSpatialAuthorityBoundary.test.js` — the exemption is named for
  `simulation/chargerRoute.js` alone, and the file is held to the routing-local side of the line.
- `Backend/tests/unit/simulation/chargingStations.test.js` — on the real RNSIT network: in-campus robots
  route exactly as before (62 m, 385 m, 66 m); an off-campus robot and a robot at JSSATE (Academic
  Block A, from the repository's OSM data) are refused; a station outside the boundary is never in the
  estate; no straight-line route is produced.

## 5. Rollback

Remove the `routeContainment` require and the `containment` argument from `chargerRoute.js`, and the
exemption from the boundary test. Charger routes then behave as before this record (uncontained).

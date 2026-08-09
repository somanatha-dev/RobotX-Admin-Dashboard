# ADR-33 — B1 Traversal-Domain Scope

| Field | Value |
|---|---|
| **Status** | **Accepted** |
| **Recorded** | 2026-08-09 (Phase 15, ratifying decision **D4**) |
| **Kind** | **Integration decision under a frozen architecture** |
| **Specification** | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §5.2, §6.2, §20.3, §25.2, §27 item 2 |
| **Decision area** | B1's traversal-domain scope — which members of `TRAVERSAL_DOMAIN` the procured engine must serve |
| **Owner** | Architecture, ratified against the Product modality roadmap |
| **Source of this text** | `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md` §32.10 (recommendation §32.1–§32.2; riders §22.8) |

## Context

The architecture is frozen. This is **not** a record of a frozen Appendix C decision — it is an
*integration* decision of the kind [`docs/adr/README.md`](README.md) admits from number 33 upward:
it chooses how to meet the architecture, not what the architecture is. It may not contradict a
frozen record, and it does not: [`ADR-11`](ADR-11-routing.md) fixes the routing **mode**
(self-hosted with precomputed hierarchies), and this record fixes the **domain scope** the
self-hosted engine must serve.

The authoritative statement of the recommendation, the evidence behind it and its consequences is
`PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md` §32 (recommendation §32.2, evidence §32.3,
independence from **D1** §32.6, riders §22.8), which restates
`PHASE_15_ROUTING_CONFIGURATION_DECISION.md` §5.1 and §8 item **D4**. This record does not restate,
summarise or reinterpret those sections; it fixes the decision's identity so that code, tests and
review comments can cite `ADR-33` and mean exactly one thing.

**What this record does not decide.** It selects no routing engine — that is **B1** itself, at its
Step 5, on recorded evidence. It does not define the adapter interface or the production routing
client — those are **Phase 8**. It does not decide the route-attribution contract the Tier 0
feasibility gate reads — that is **Phase 8 + B6**.

## Decision

**B1 procures a self-hosted outdoor geodesic routing engine that serves `SIDEWALK_GRAPH` and
`ROAD_GRAPH` from one OSM extract per region; `INDOOR_GRAPH` and `AIRSPACE_VOLUME` are excluded
from B1's scope.**

## Rejected

**Procuring a multi-modal routing platform.** `INDOOR_GRAPH` is a per-region *proximity
partition* implemented as site-local graph zones (§6.2) and is not something an OSM engine
provides; `AIRSPACE_VOLUME` is a §25.2 future modality requiring 3D routing with airspace
volumes. Scoping either into B1 would mis-specify the procurement.

## Riders — decided in this record, per §22.8

1. **D7 is deferred, not decided.** `MobilityModel.traversalDomain` remains a scalar column while
   B1's scope is single-domain-plus-`ROAD_GRAPH`-on-one-extract. `mobilityModel.traversalDomains()`
   already supports a composition; the schema change is deferred until a modality outside this
   scope is admitted.
2. **Validate before you key.** `routingProfileKey()` is total and yields `unknown:unknown:*` for
   a model with an absent `modelId` or an unrecognised domain, so two differently-broken models
   would **share cache entries**. The Phase 8 routing client MUST call `validateModel()` before it
   keys.
3. **Scope is conditional on outdoor operation.** If D1 returns a purely indoor footprint, B1 does
   not apply rather than this record being wrong.

## Consequences

The §27 item 2 shortlist — OSRM, Valhalla, GraphHopper, in-house — stands, and the *"multi-modal
networks"* clause of its filter is **not** applied. **B1 Step 2 is released**
(`b1Benchmark.js:588`): one executable benchmark adapter per candidate to the contract at
`b1Benchmark.js:84–98`, hardened per §32.5 of the Phase 15 consolidated report. Steps 1, 3, 4 and
5 remain blocked by D1, D3 and D8. This record selects no engine; B1 does that at Step 5 on
recorded evidence.

## Changing this record

This record is an integration decision under a frozen architecture. It does not amend, reword or
reinterpret [`ADR-11`](ADR-11-routing.md) or any other frozen record; where it and the
specification appear to disagree, the specification wins and this record is defective. It is
changed only by a new ADR that explicitly states that it supersedes `ADR-33` — for example, when a
modality outside this scope is admitted and rider 1's deferral of **D7** is taken up.

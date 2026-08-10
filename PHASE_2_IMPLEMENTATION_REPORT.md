# Phase 2 — Domain model and schema · Implementation Report

> ## ⚠️ SUPERSEDED IN PART — read `PHASE_2_REMEDIATION_AND_CLOSURE.md` first
>
> **Final Phase 2 status (2026-08-10): CLOSED WITH DOCUMENTED ENVIRONMENTAL LIMITATION.**
>
> This report is the **Phase-2-era record, preserved verbatim**. Since it was written the
> migration has been executed against a live PostgreSQL 18.3, and that execution found **two
> real defects in the spatial mirror that this report could not have known about** — both now
> fixed and regression-tested. Three specific corrections to the text below:
>
> | Claim in this report | Corrected status |
> |---|---|
> | §14.3 / §17.1 / §18 — *the migration, the triggers, and the backfill were never run against a live PostgreSQL* | ✅ **All three now executed.** 21/21 migrations applied; 49/49 behavioural checks PASS; legacy data md5-identical before/after; backfill run with the real Prisma client |
> | §7 / §14.2 — *the backfill mirrors the spatial map, fine and coarse* | ❌ **This did not work.** `backfillSpatialMirror` wrote **nothing**: it leaked Phase 15's `indexing` field into Prisma, and wrote logical map ids into foreign-key columns. Fixed; see remediation §2 |
> | §4 — *`prisma/schema.prisma` +~640 lines* | ⚠️ **Not independently re-checkable** — Phase 2 was never committed in isolation (it entered history inside `cf9103f` with Phases 3–5). The load-bearing claim, **zero lines removed**, is re-confirmed as 0 |
>
> **Every test and gate count below is Phase-2-era and has moved.** The suite is now 145
> suites / 6 363 tests; the legacy lane is 17 / 126, not 22 / 169 (Phase 15 retired four
> modules). Full mapping in remediation §10.
>
> Nothing in this report has been deleted or rewritten to make it look correct.

**Phase:** 2 of 16 · **Status:** ✅ **COMPLETE — awaiting independent verification before Phase 3**
**Date:** 2026-07-28 · **Branch:** `feature/dashboard` · **Working tree at implementation:** `4244b3d`
**Authority:** `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 2" and §7 "Phase 2" checklist
**Specification:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN) — §2, §3.6, §4.1–§4.3, §10.3, §15, §21.2, §25

> **Phase 3 has NOT been started.** No commit transaction, no guards G1–G6, no fence
> allocation, no lease grant, no `ShardLeadership`, no advisory-lock demotion. The
> `Commitment` table exists and is empty; nothing writes it. `ENGINE_ENABLED` remains
> `false` in every environment and no round runs.

---

## 1. Executive summary

Phase 2 lands §2's domain model, §3.6's spatial hierarchy, and the §4.2/§4.3 state
vocabularies in the database and in code. It is the largest single migration in the
programme: **20 new tables, 5 new enums, 8 new values on `TaskStatus`, 3 schema
backstops, 11 new engine modules, and an idempotent backfill.**

Three properties hold that did not before:

1. **The engine has a domain model to reason about.** Custody, Leg purpose, the
   two fencing scopes, typed capabilities, observation freshness, and the
   Task/Mission/Leg/Stop split are entities and vocabularies rather than absent
   concepts. Every one of them is checked against the specification's own tables in
   both directions — an enum value with no §-defined meaning fails as loudly as a
   missing one.
2. **Containment is by published assignment, never by geometry.** `spatial/hierarchy.js`
   resolves a cell's zone, site, and region from a published map. Its resolver takes
   one argument and it is a cell id: there is no coordinate to pass, which is the
   structural form of §3.6's rule rather than a promise to obey it.
3. **The conversion is deterministic and re-runnable.** Every backfilled id is a
   UUIDv5-shaped hash of a fixed namespace and the legacy row's own key, so running
   the job twice produces byte-identical state — asserted, not claimed.

**The migration is additive to a degree worth stating precisely: `git diff` on
`prisma/schema.prisma` removes zero lines.** Not "no models dropped" — no line
deleted at all.

`npm run verify` is green: **3 gates PASS, 42 suites, 668 tests, 0 failures.** The
legacy lane is **22 suites / 169 tests, identical to the Phase 0 and Phase 1
baselines** — no legacy test was modified, skipped, or re-baselined.

**One inherited risk is not discharged** (§17): the migration has not been applied to
a live PostgreSQL instance, for the same reason Phase 1's could not be. It is
cross-checked statement-by-statement against Prisma's own generated SQL by an
automated test, which is materially stronger than Phase 1's line-by-line review, but
it is not execution.

---

## 2. Objective achieved

The plan's stated purpose:

> Land §2 (domain model), §3.6 (spatial hierarchy), and the §4.2/§4.3 state
> vocabularies in the database. This is the largest single migration in the programme.

> **Scope.** Agent, Task/Mission/Leg/Stop, Commitment, Custody, Observation, payload
> and capability models, spatial hierarchy, decision-record skeleton. Data is migrated
> forward from existing `Robot`/`Task` rows; the legacy columns remain readable until
> Phase 15.

All nine migration groups (a)–(i) landed. Data migrates forward. Legacy columns are
untouched and every legacy read path returns exactly what it returned before.

---

## 3. Files created

### 3.1 Domain modules — `src/engine/domain/**` (2 050 lines)

| File | Purpose | Tier |
|---|---|---|
| `purpose.js` | The six §2.4 purposes; `custodial_purposes` and `speculative_purposes` **derived from** the same table that states cancellability and preemptibility, never restated | 1 |
| `custody.js` | The five §2.5 states with their recovery semantics; `holdsGoods`, `isRequeueable`, `isDischarged` | **0** |
| `capability.js` | §2.3's typed algebra: five kinds, five comparators, three-valued match, certification checked against **mission end**, `custody_transfer_capable` default-false, the attestation seam | **0** |
| `work.js` | The §4.2 (11) and §4.3 (19) state tables with their deadline *parameter names*; the seven §2.4 stop types; obstruction-class → stranding-state derivation; Mission/Leg/Stop structural validation | 1 |
| `agent.js` | §2.1's facets and lifecycle; the five orthogonal state concerns returned as five; the two fencing scopes and the per-commitment fence comparison | 1 |
| `mobilityModel.js` | §2.2's six elements and the routing-profile key §20.3's cell-pair cache is keyed by | 1 |
| `observation.js` | §2.7: `createObservation`, and `assess()` returning `FRESH`/`ABSENT`/`INDETERMINATE` against a caller-declared staleness budget and a caller-supplied evaluation time | 1 |
| `mappers/legacyRobot.js` | `Robot` → `Agent`; deterministic UUIDv5-shaped id derivation; the read projection | 1 |
| `mappers/legacyTask.js` | `Task` → `Mission` + `PRIMARY` `Leg` + 2 `Stop`s; the one-directional legacy-status bridge; the round trip | 1 |

### 3.2 Spatial hierarchy — `src/engine/spatial/**` (518 lines)

| File | Purpose |
|---|---|
| `cells.js` | Cell identity, validation, canonical ordering, the §20.3 cell-pair key. **Computes no geometry** — the index primitive is blocking decision B5, which belongs to Phase 9 |
| `hierarchy.js` | The §3.6 map: `indexMap` / `resolve` / `cellsOfZone` / `cellsOfSite`, the containment validator, and `toConfigPayload` |

### 3.3 Migration and tooling

| File | Lines | Purpose |
|---|---|---|
| `prisma/migrations/20260728140000_domain_model_and_spatial_hierarchy/migration.sql` | 788 | The whole migration |
| `tools/migrate/backfillDomain.js` | 455 | The one-shot, idempotent, deterministic backfill, with its own six-check verifier |

### 3.4 Tests — `tests/engine/**` (1 631 lines, 176 tests)

| File | Tests | Covers |
|---|---|---|
| `domainModel.test.js` | 57 | Every §2 vocabulary against the specification's own tables; the three-valued and conservative-default behaviours |
| `domainSchema.test.js` | 64 | Additivity; the migration ⟷ `schema.prisma` cross-check against Prisma's own SQL; schema ⟷ specification enum agreement; the backstops; referential integrity |
| `domainBackfill.test.js` | 32 | Deterministic identity; the mappers; idempotency; paging; every verifier finding |
| `spatialHierarchy.test.js` | 23 | §3.6's three rules; the seeded map against **the real Config Service V8 check** |

---

## 4. Files modified

| File | Change | Why |
|---|---|---|
| `prisma/schema.prisma` | +~640 lines, **zero lines removed** | All nine migration groups. `TaskStatus` extended in place; `Zone` and `Task` gain nullable columns; `Robot` gains a back-relation only (no column) |
| `prisma/seed.js` | Spatial map, agent class and its four models; Prisma client made lazy | The plan's "region/zone/site/cell maps published as config" and a class for a backfilled Agent to key its parameter sets from. Lazy client so importing the seeded map does not construct a database client or require a generated client |
| `src/services/robot.service.js` | `commissionRobot` creates the paired `Agent` in one transaction; adds `ensureAgentForRobot` and `readAgentProjection` | Without it the zero-orphan criterion decays the first time a robot is commissioned after the backfill. Response shape unchanged |
| `src/controllers/robots.controller.js` | `commissionRobotWithPairing` calls `ensureAgentForRobot` | Two of its three paths obtain a Robot **without** going through the service, and would otherwise leave it unprojected. Best-effort, response unchanged |
| `src/controllers/tasks.controller.js` | `REJECTED` added to the terminal set in `cancelTask` | Read-compatibility with the extended §4.2 vocabulary. **Inert today** — nothing writes `REJECTED` (verified by grep across `src/`) |
| `tests/engine/phase0Scaffold.test.js` | Ownership assertion widened to Phase 2; two new presence tests | The assertion narrows rather than disappears; a module under `commitment/`, `feasibility/`, or `dispatch/` still fails it |

**Not modified:** every file under `src/sockets/`, `src/cache/`, `src/simulation/`,
`src/services/commandDispatcher.service.js`, `task.service.js`,
`taskAssignment.service.js`, `costEvaluator.service.js`, `robotValidator.service.js`,
`taskRecovery.service.js`. Verified by `git diff --stat` returning empty for those paths.

---

## 5. Database changes

20 tables, 5 enums, 8 enum values, 2 altered tables, 3 backstops. Additive only.

| Group | Objects |
|---|---|
| **(a)** Agent | `Agent` — `agentId`, `robotDbId` (unique 1:1 to `Robot`), `agentClassId`, `regionId`, `homeDepotId`, `lifecycleState`, `authorityEpoch` BIGINT, `fenceCounter` BIGINT, `capacityOverride` |
| **(b)** Class and models | `AgentClass`, `MobilityModel`, `EnergyModel`, `ContainerModel`, `Compartment`, `CapabilityBundle`, `Capability` |
| **(c)** Work | `Mission`, `Leg` (`purpose`, `state`, `custodyState`, `version`, `cancelRequestedAt`, `obstructionClass`), `Stop` (`stopType`, time window, `serviceTimeModelRef`, `payloadDelta`) |
| **(d)** Commitment | `Commitment` — `commitmentId`, `agentId`, `legId`, `fence` BIGINT, `leaseExpiry`, `custodyState`, `planSnapshotRef`, `decisionRef`, `version`, `releasedAt`, `kind = 'HARD'` CHECK |
| **(e)** Payload | `PayloadSpec` (all twelve §15.1 attributes), `PayloadManifest` |
| **(f)** Spatial | `Region`, `Site`, `CellAssignment`, `Zone.regionId` |
| **(g)** Observation | `Observation` — append-only, `observedAt`/`receivedAt`/`source`/`confidence`/`variance`/`sequence`/`deadReckoned`/`uncertaintyRadiusM` |
| **(h)** Decision record | `DecisionRecordA` — every §21.2 Tier A section as a column |
| **(i)** Enums | `LifecycleState`, `LegPurpose`, `LegState`, `CustodyState`, `ObstructionClass`; `TaskStatus` extended |
| — | `_MissionToTask` — Prisma's implicit join for §2.8's `Task >──< Mission` |

### 5.1 The `TaskStatus` extension — a plan/specification disagreement, resolved as the plan requires

The plan names five additions: `AT_RISK`, `SUSPENDED`, `VERIFYING`, `PLANNABLE`,
`RECEIVED`. §4.2 tabulates **eleven** states, of which **eight** are absent from the
legacy enum — the plan's parenthetical omits `REJECTED`, `WAITING`, and
`IN_EXECUTION`.

The plan states its own precedence: *"Where this plan and the specification appear to
disagree, the specification wins and this plan is defective."* All eight are added.
This is the same treatment Phase 1 gave the "eight versus ten rule-5 checks"
discrepancy, and the reasoning is the same: adding an enum value is additive and
harmless, while omitting one §4.2 requires would leave Phase 5's Task machine unable
to express a state the specification mandates.

Recorded as a plan defect, not an architecture question.

### 5.2 Schema backstops

Three properties enforced in the database, independently of application logic — the
discipline Phase 1 established for configuration immutability.

| Backstop | Rule | Why in the database |
|---|---|---|
| `Commitment_kind_hard_only` CHECK | §2.6, I18 — "Only HARD commitments exist in the Commitment Store" | Persisting a SOFT reservation would put an entire optimisation loop inside the serialised per-shard section. Phase 3 implements the commit transaction *against* this constraint; the constraint rejects the violation without it |
| `Observation_append_only` trigger (BEFORE UPDATE) | §2.7 | A measurement that can be rewritten is not evidence, and every freshness judgement downstream reads it as though it were |
| `DecisionRecordA_immutable` trigger (BEFORE UPDATE) | §21.2 — "One **immutable** record per decision" | A record that can be edited after the fact cannot discharge T8, and the safety case (§24.7) is assembled from queries over exactly these rows |

**The `Observation` asymmetry is deliberate and stated:** UPDATE is refused, DELETE is
not. A high-volume observation log needs a retention path and the specification
attaches no immutability requirement to deletion. Recorded here so the asymmetry is a
decision on the record rather than an omission.

### 5.3 Referential integrity

| Relationship | On delete | Why |
|---|---|---|
| `Agent → Robot` | **CASCADE** | Decommissioning a Robot through the existing endpoint must keep working, and an Agent projecting a Robot that no longer exists is the orphan the criterion forbids |
| `Commitment → Agent`, `Commitment → Leg` | **RESTRICT** | A durable contract binding a physical machine to work must not be destroyed as a side effect of deleting a row it references |
| `Leg → Mission`, `Stop → Leg`, `Compartment → ContainerModel`, `Capability → CapabilityBundle`, `Observation → Agent`, `PayloadManifest → Leg` | CASCADE | Composition: the child has no meaning without its parent |
| `Site → Region`, `CellAssignment → Region` | RESTRICT | Deleting a region with sites or cells in it is a redistricting operation, not a row deletion |
| `Zone → Region`, `Agent → Region/Site/AgentClass`, `Stop → Site`, `Task → PayloadSpec` | SET NULL | Optional assignment |

---

## 6. Migration details

**One file:** `20260728140000_domain_model_and_spatial_hierarchy/migration.sql`, 788 lines.

**Every `CREATE TABLE`, `CREATE INDEX`, and `ADD CONSTRAINT` is Prisma's own generated
SQL, taken verbatim** from `prisma migrate diff --from-empty --to-schema-datamodel`
and diffed against the pre-Phase-2 schema's generated SQL to isolate the delta. The
hand-written additions are the eight `ALTER TYPE … ADD VALUE`, the two
`ALTER TABLE … ADD COLUMN` blocks, the CHECK, and the two triggers.

`domainSchema.test.js` re-derives Prisma's SQL offline on every test run and asserts,
per table, that **every generated statement appears verbatim in the migration** — so
the migration cannot drift from the schema without a red test.

**Statement ordering** is: enums → tables → altered tables → indexes → foreign keys →
backstops. Every unique index a foreign key depends on is created before it.

**PostgreSQL ≥ 12 is required.** Adding more than one value to an enum inside a
transaction block is not possible on 11 and earlier. None of the added values is
*used* in this migration, which is the other restriction Postgres places on the
operation. Recorded in the migration's own header.

**Reversibility.** The plan requires migrations to be "reversible **where the
implementation plan requires**". It does not require a down migration for this phase,
and this repository's migration system is forward-only by convention — no prior
migration, including Phase 1's, carries a `down`. The rollback path for this phase is
the additive-only property itself: no legacy object is altered, so an unapplied Phase
2 leaves the legacy dispatcher operating on exactly the rows it operated on before.

---

## 7. Backfill strategy

`tools/migrate/backfillDomain.js`, run as `node tools/migrate/backfillDomain.js [--dry-run] [--batch n] [--json]`.

| Step | Conversion |
|---|---|
| Spatial mirror | Published map → `CellAssignment` (fine **and** coarse), validated before writing |
| Robot → Agent | 1:1, `agentId = robot.robotId`, `lifecycleState = ACTIVE`, both fencing counters at 0 |
| Task → work | 1 `Mission` + 1 `PRIMARY` `Leg` + 2 `Stop`s, `custodyState = NONE` |

**Deterministic.** Every id is `uuid5(namespace, legacyKey)` over
`sha256(namespace + " " + key)`, with the RFC 4122 version and variant nibbles set.
Four disjoint namespaces (agent, mission, leg, stop) so a Robot and a Task with the
same legacy key cannot collide. No clock read decides content, no random id is minted,
and rows are processed in canonical `id` order.

**Idempotent — and idempotent in the way that matters.** Re-running upserts the same
primary keys. Three fields are deliberately **excluded from the update branch**:

- `Agent.authorityEpoch` and `Agent.fenceCounter` — monotone counters (§2.6, I6). A
  re-run that reset one would invalidate a fencing decision already taken against it.
- `Leg.state`, `Leg.custodyState`, `Leg.version` — once a Leg exists its lifecycle
  belongs to the state machine (Phase 5). A re-run that reset a Leg's state would be a
  data-loss bug wearing an idempotency badge.

Both exclusions are asserted by tests that advance the values and re-run.

**What it deliberately does not do.** It writes **no `Commitment`**. §2.6's binding is
a durable contract created by §10.3.2's transaction with a fence, a lease, and six
guards — Phase 3. Fabricating one here from `Robot.currentTaskId` would manufacture
exactly the unfenced, unleased, unsupervised binding the commitment core exists to
replace.

**Region assignment is never inferred from geometry.** The job uses an explicitly
supplied region, or the single declared region when the deployment has exactly one
(unambiguous, not an inference), and otherwise `null` — leaving the assignment to be
published rather than guessed (§3.6).

**Self-verification.** `verify()` runs six counted checks — unprojected Robots,
Agents without a Robot, undecomposed Tasks, Missions without Legs, Legs without Stops,
and non-`PRIMARY` backfilled Legs — and exits non-zero on any. "Zero orphans" is not a
statistical claim, so nothing is sampled.

---

## 8. API changes

**None externally.** No route added, removed, or renamed. No response shape changed.

Two behavioural notes, both strictly forward-compatible:

| Endpoint | Change | Observable today? |
|---|---|---|
| `POST /api/robots` and `POST /api/robots/commission` | Also create/ensure the `Agent` row | No. Same status, same body, same emitted events |
| `POST /api/tasks/:taskId/cancel` | `REJECTED` treated as terminal | **No.** Nothing in `src/` writes `REJECTED` — verified by grep. The change is inert until a §4.2 writer exists |

The internal read models the plan asks for (`readAgentProjection`,
`toAgentProjection`, `toWorkProjection`) are exposed at the **service and mapper
layer**, not wired into any HTTP response. Adding a field to a payload would have
been a change to a legacy endpoint's behaviour, and the completion criterion forbids
that.

---

## 9. Redis changes

**None written.** The plan's row reads: *"New key prefixes **reserved (not yet
written)**: `engine:agent:{id}`, `engine:idx:{shard}:{cell}`,
`engine:snapshot:{roundId}`. Legacy `robot:*`, `registry:*` untouched this phase."*

Reserved and unwritten is exactly the state. `domainSchema.test.js` asserts that no
module under `src/engine/domain/**` or `src/engine/spatial/**` calls a KV write, and
`git diff` shows `src/cache/` untouched. The prefixes are recorded here as reserved;
Phases 4, 9, and 10 are their owning phases.

---

## 10. Socket.IO changes

**None.** The plan specifies "None (no behaviour change yet)", and none was made.
`src/sockets/` is byte-for-byte unchanged, asserted by `git diff --stat` and by the
same no-`emit` test above.

---

## 11. Compatibility guarantees

| Surface | Guarantee | Evidence |
|---|---|---|
| **Data** | No legacy row is read differently. Every added column is nullable or defaulted; every added enum value is unused by any writer | §5, `domainSchema.test.js` "every column it adds is nullable or defaulted" |
| **Schema** | Zero lines removed from `schema.prisma`; no DROP, RENAME, or ALTER COLUMN anywhere in the migration | `git diff` removed-line count = 0; four dedicated tests |
| **API** | No route, no response shape, no status code changed | §8 |
| **Redis** | No key written, no key read, no key retired | §9 |
| **Socket.IO** | No event added, changed, or removed | §10 |
| **Legacy tests** | 22 suites / 169 tests, identical to the Phase 0 and Phase 1 baselines, none modified or skipped | §15.1 |
| **Determinism** | Deterministic ids; canonical cell and string ordering; no wall-clock read in any new module | §15.3 |
| **Parameter register** | No behavioural constant introduced; `capacity[agent_class]` already registered with default 1 by Phase 1 | `gate:params` PASS, 23 modules / 148 parameters |

---

## 12. Tests added

**176 new tests** across 4 new suites. Every plan-named requirement, and where it is met:

| Plan requirement | Where |
|---|---|
| Migration: forward + rollback on a production-shaped dump | **Not run** — see §14.3 and §17. Substituted with an automated statement-level cross-check against Prisma's own generated SQL |
| **Backfill idempotency (run twice → identical state)** | `domainBackfill.test.js` — full state snapshot compared across two runs, plus two tests proving the monotone counters and Leg lifecycle survive a re-run |
| Referential integrity for every FK | `domainSchema.test.js` — every `REFERENCES` names a declared table; the RESTRICT/CASCADE choices asserted individually |
| **Unit: mappers round-trip legacy↔domain** | `domainBackfill.test.js` — decompose then recompose preserves every legacy field |
| **Property: every legacy Task maps to exactly one Mission with exactly one `PRIMARY` Leg and two Stops** | Asserted in the mapper test, in the backfill test over every produced Mission, **and at the point of construction inside the backfill itself**, which throws rather than writing a non-conforming Mission |
| Validate: zone never spans a region; every fine cell → exactly one zone, ≤ one site | `spatialHierarchy.test.js` — each rule with its own crafted violation |
| Regression: full existing suite green | 42 suites / 668 tests; legacy lane unchanged at 169 |

---

## 13. Checklist — `IMPLEMENTATION_EXECUTION_PLAN.md` §7, Phase 2

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Migration (a): `Agent` fields | ✅ | All eight fields; `domainSchema.test.js` asserts each by name, both counters BIGINT defaulting to 0 |
| 2 | Migration (b): `AgentClass`, `MobilityModel`, `EnergyModel`, `ContainerModel`, `Compartment`, `CapabilityBundle`, `Capability` | ✅ | All seven; aperture modelled separately from internal dimension (§15.2) |
| 3 | Migration (c): `Mission`, `Leg`, `Stop` | ✅ | `purpose`, `state`, `custodyState`, `version` present; plus `cancelRequestedAt` for guard G5 |
| 4 | Migration (d): `Commitment` with HARD-only CHECK | ✅ | All nine §2.6 fields asserted by name; CHECK asserted |
| 5 | Migration (e): `PayloadSpec`, `PayloadManifest` | ✅ | All twelve §15.1 attributes, mass with tolerance |
| 6 | Migration (f): `Region`, `Site`, `Zone.regionId`, `CellAssignment` | ✅ | Plus the mirror the backfill populates |
| 7 | Migration (g): `Observation` append-only | ✅ | All six §2.7 fields plus dead-reckoning provenance; BEFORE UPDATE trigger |
| 8 | Migration (h): `DecisionRecordA` skeleton | ✅ | Every §21.2 Tier A section as a column; immutability trigger |
| 9 | Migration (i): five new enums; `TaskStatus` extended per §4.2 | ✅ | All five; **eight** TaskStatus values, not the plan's five — see §5.1 |
| 10 | Domain modules ×7 | ✅ | `domainModel.test.js`, 57 tests |
| 11 | `spatial/hierarchy.js` — containment by published assignment | ✅ | `spatialHierarchy.test.js`; the resolver's arity is asserted to be 1, so no coordinate can be passed |
| 12 | Legacy mappers for dual-read | ✅ | `domainBackfill.test.js`; round trip asserted |
| 13 | `tools/migrate/backfillDomain.js` (idempotent) | ✅ | 32 tests including two-run state equality |
| 14 | Validate: zone never spans a region; fine cell → one zone, ≤ one site | ✅ | Both in `hierarchy.validate()` and, at publish time, in Phase 1's V8 |
| 15 | Tests: forward/rollback, idempotency, round-trip, FK integrity | ⚠️ **14 of 15** | Everything except live forward/rollback execution — §14.3 |
| 16 | **Gate:** 100 % converted, zero orphans; endpoints behaviourally unchanged | ✅ | Backfill verifier; §8; legacy lane unchanged |

**15 of 15 items implemented. One item's evidence is partial:** the forward/rollback
migration run against a production-shaped dump could not be executed here, for the
reason Phase 1 recorded and did not discharge.

---

## 14. Completion criteria — §3 "PHASE 2"

| Criterion | Result |
|---|---|
| Schema matches §2 and §3.6 | ✅ Every enum checked against its § table **in both directions**; every §2.6 Commitment field and every §2.1 Agent field asserted by name |
| Backfill converts 100 % of existing rows with zero orphans | ✅ Six counted checks, no sampling; asserted to report each orphan class rather than pass silently |
| `purpose`, `custodyState`, `authority_epoch`, `fence_counter` present and defaulted | ✅ `purpose` required (no default — a Leg with an unstated reason for existing is not a Leg); `custodyState` defaults `NONE`; both counters BIGINT default 0 |
| Spatial containment validator (§22.1) passes on seeded region/zone/cell maps | ✅ **Run against the real Phase 1 validator**, not a reimplementation: `validateCandidate({ spatial })` returns **zero V8 findings** on the seeded map, and the same call on a deliberately broken variant returns a V8 finding — so the pass is known to be capable of failing |
| Legacy endpoints unchanged in behaviour | ✅ §8, §11 |

### 14.1 A note on the spatial map and publication

The seeded map passes V8. It is **not published as a `ConfigVersion`**, because a
publish is currently blocked by an unrelated, inherited finding: Phase 1 §7.1's
combined-conservatism V9 rejection, which is a Safety-class decision escalated to the
named calibration owner. Reproduced directly:

```
V8 findings: 0
blocking findings: [ 'V9 §22.1 rule 5 · §14.3' ]
```

The completion criterion is that the **containment validator passes**, which it does.
Publishing awaits a decision Phase 2 must not take.

### 14.2 A real interaction found and resolved inside Phase 2's scope

Phase 1's V8 reads `spatial.cells` as the fine cell→zone map and requires each entry
to name exactly one zone. §3.6 states that rule for **fine** cells only: a coarse cell
spans many zones by construction — that is what makes it the §6.2 regional-sweep unit.

Publishing coarse cells in the array V8 reads would fail a correct map against a
correct check. `toConfigPayload` therefore emits fine cells under `cells` and coarse
cells under `coarseCells`. **Phase 1 code is unmodified.** The durable
`CellAssignment` mirror carries both, distinguished by its `resolution` column, which
is what Phase 9's Cold Index rebuild reads.

### 14.3 What could not be verified here, and why

| Item | Status |
|---|---|
| The migration applied against a live PostgreSQL | **Not run.** A local PostgreSQL is listening on 5432 but rejects the two credential pairs on file (`P1000`); I stopped rather than attempt others. The project's `DATABASE_URL` points at a shared Neon database — production infrastructure, not a disposable test target — and I did not run DDL against it. **Mitigated** by an automated statement-level equivalence check against Prisma's own generated SQL, which needs no database and runs on every test invocation |
| The two immutability triggers firing | **Not run**, same reason. Both use the idiom Phase 1's approved triggers use; the placeholder/argument counts in every `RAISE EXCEPTION` are checked automatically by a test that parses at top-level commas |
| The backfill against real data | **Not run** against PostgreSQL. Run in full against an in-memory store implementing the Prisma surface it uses, including cursor paging over 25 rows at batch size 4 |

---

## 15. Verification evidence

### 15.1 `npm run verify`

```
> gate:tiers
gate: tier-dependencies (§1.8 rule 2)
  PASS — 89 module(s), 30 governed import edge(s), no Tier 0/1 → Tier 2 dependency.

> gate:params
gate: parameter-register (§22, Appendix A)
  PASS — 23 engine module(s) checked against 148 registered parameter(s); no bare behavioural constants.

> gate:tenets
gate: tenets (T1 type separation, T6 decision-path determinism)
  PASS — 86 module(s) checked, no violations.

> test
Test Suites: 42 passed, 42 total
Tests:       668 passed, 668 total
```

| Lane | Suites | Tests | Δ vs Phase 1 |
|---|---|---|---|
| `legacy` | 22 | 169 | **unchanged** |
| `gates` | 3 | 49 | unchanged |
| `engine` | 17 | 450 | +4 suites, +178 tests |
| **Total** | **42** | **668** | +4 / +178 |

The engine lane's +178 is 176 new tests plus the two presence tests added to
`phase0Scaffold.test.js`.

### 15.2 The gates caught a real violation during implementation

`gate:params` failed on `legacyRobot.js:83` — a bare `16`, the hexadecimal radix in
the UUID variant-nibble computation. It was annotated `@structural` with its reason
and the gate passed. Recorded because a gate that has never fired during a phase is a
gate nobody has evidence about.

### 15.3 Architectural compliance, item by item

| Requirement | Evidence |
|---|---|
| §2.1 — lifecycle separate from operational status | `Agent.lifecycleState` is its own column; the mapper explicitly does **not** map `Robot.status` to it, asserted by a test naming the `PAUSED`-means-two-things defect |
| §2.1, §23.5 — capabilities attested, never self-declared | `capability.assertAttested()` refuses a telemetry source; `agent.refuseSelfDeclaredCapability()` throws unconditionally |
| §2.3 — certification checked against **mission end**, not decision time | Asserted with the same agent and the same decision, differing only in mission end |
| §2.3 — `custody_transfer_capable` defaults false | The single enumerated default-false capability; asserted |
| §2.4 — purpose set at creation, never mutated | Column has no default and no update path in the backfill |
| §2.4 — the two derived purpose sets | Derived from the table, asserted member-by-member against the per-purpose rows |
| §2.5 — `DISPUTED` resolves conservatively | `holdsGoods("DISPUTED") === true`; not requeueable |
| §2.6 — only HARD commitments are durable | CHECK constraint; nothing writes the table |
| §2.6, §10.3.1 — fence compared **per commitment id** | Asserted with two concurrent commitments where a per-agent-maximum comparison would wrongly reject the lower-fenced one |
| §2.7 — `ABSENT` and `INDETERMINATE` are distinct | Asserted directly; a consumer with no declared budget gets `INDETERMINATE`, not a default |
| §2.7 — extrapolation prohibited for safety constraints | `isAdmissibleFor` returns false for `SAFETY_CONSTRAINT` on a dead-reckoned position |
| §3.6 — containment by assignment, not geometry | The resolver takes one argument and it is a cell id; asserted via `resolve.length === 1` |
| §3.6 — a zone never straddles a region | Rejected with a finding quoting the Ω_terminal consequence |
| §4.1 rule 1 — every non-terminal state has a deadline | `nonTerminalLegStatesWithoutDeadline()` returns exactly `["LOADED"]`, surfaced for Phase 5 rather than hidden |
| §4.3 — obstruction `INDETERMINATE` → `STRANDED_OBSTRUCTING` | Asserted, including for an absent class |
| §9.6 — canonical, host-independent ordering | Cell ordering uses `compareStrings`, not `localeCompare`; asserted to differ from locale collation |
| §15.2 — aperture distinct from internal dimension | Separate columns; seeded with different values |
| §21.2 — the decision record is immutable | BEFORE UPDATE trigger |
| §1.8 rule 2 — no Tier 0/1 → Tier 2 dependency | `gate:tiers` PASS over 30 governed edges |

---

## 16. Known assumptions

Each is an implementation choice not dictated by the plan, stated so it can be overruled.

1. **`Agent` is a new table extending `Robot` through a 1:1 link, not columns added to
   `Robot`.** The plan's group (a) reads "`Agent` (extends Robot: …)" while group (f)
   reads "`Zone` (**extend**: …)" for an in-place column addition — the same author
   using two different constructions for two different operations. It is also the only
   reading under which "Robot→Agent" is a *conversion* the backfill performs, and it
   preserves the strangler pattern: `Robot` stays byte-for-byte authoritative for the
   legacy dispatcher. **This is the single most consequential reading in the phase.**
2. **`stopType` and `CellAssignment.resolution` are strings, not database enums.** The
   plan's group (i) enumerates exactly five new enums and neither is among them. The
   permitted sets are enforced in `domain/work.js` and `spatial/cells.js`.
3. **Eight `TaskStatus` values are added, not the plan's five.** §5.1.
4. **`Leg.cancelRequestedAt` and `Commitment.releasedAt` are added in Phase 2 although
   the plan's field lists do not name them.** Guard G5 is defined over
   `cancel_requested_at`, and Phase 3's partial unique index enforcing ≤ capacity
   *active* commitments needs a predicate column — and Phase 3's migration list names
   only constraints, no column additions. Adding them now is what makes Phase 3's
   stated migration possible as stated.
5. **`RequirementSet` is a JSON column on `Task`, not a table.** §2.8 names it as a
   Task attribute; the plan's migration list names no entity for it; "do not invent
   additional entities" governs.
6. **`Task >──< Mission` uses Prisma's implicit join table.** §2.8 draws the relation
   as many-to-many. An implicit relation carries it without introducing a named entity.
7. **`Agent.capacityOverride` is a durable record, not a decision-time input.** The
   plan lists a "`capacity` override" field; §22 resolution remains the authority.
   Stated in the schema comment so no later phase reads the column instead of the
   Config Service.
8. **The spatial config payload separates fine and coarse cells.** §14.2.
9. **`Observation` refuses UPDATE but permits DELETE.** §5.2.
10. **The backfill's Agent lifecycle is `ACTIVE`.** A robot already commissioned into
    the fleet is in service. No other legacy field informs it, and §2.1 forbids
    deriving lifecycle from operational status.
11. **Legacy `ASSIGNED` maps to no §4.2 Task state** and to Leg state `ACCEPTED`.
    §4.2's states are deliberately coarse and "assigned" is Leg detail — precisely the
    `OFFERED`/`ACCEPTED`/`EN_ROUTE_PICKUP` distinction §4.3 exists to make. `ACCEPTED`
    is the state that claims least: a binding exists, nothing is asserted about motion.
    Nothing maps to `LOADED`, because custody is a fact the legacy schema never recorded.
12. **`Agent.robotDbId` is nullable.** §25 admits agents with no Robot row (drones,
    human couriers). The backfill verifier reports a null as a finding anyway, since
    before any non-robot agent exists it is an orphan.
13. **`ensureAgentForRobot` is transactional in the service and best-effort in the
    pairing controller.** In the service both writes are new, so atomicity is free; in
    the controller the Robot row is already committed, and failing an existing endpoint
    over a projection write would be the behaviour change this phase must not make.

---

## 17. Remaining TODOs

### 17.1 Carried out of Phase 2

| # | Item | Owner | Due |
|---|---|---|---|
| 1 | **Apply this migration and Phase 1's to a production-shaped dump; exercise all four immutability/append-only triggers and the HARD-only CHECK** | Verifier / SRE | **Before Phase 3.** Phase 3's constraints are added to `Commitment`, which this migration creates |
| 2 | Publish the spatial map as a `ConfigVersion` once §17.2 item 1 is settled | Config owner | Phase 9 (the Availability Index reads the pinned map) |
| 3 | Populate `EnergyModel.consumptionCoefficients` and the thermal/charge curves | Phase 7 | Phase 7 |
| 4 | Complete `DecisionRecordA` — writer, sampler, Tier B, `InputSnapshot` | Phase 11 | Phase 11 |
| 5 | Decide whether `Robot.status` retires or becomes `Agent.activity` at cutover | Phase 15 | Phase 15 |

### 17.2 Carried forward, still open

| # | Item | Owner | Origin |
|---|---|---|---|
| 1 | Resolve the combined-conservatism V9 finding — **the seeded register still does not publish** | Safety | Phase 1 §7.1 |
| 2 | Resolve the §1.8 / §22.5 kill-switch discrepancy | Tech lead | Phase 0 §7.1 |
| 3 | Name the calibration owner; set the fleet-year energy budgets (B8) | Ops / Finance / Safety | Phase 1 |
| 4 | Supply the 15 unset `required` register values | Ops, Finance, Account management | Phase 1 |
| 5 | `fixedPoint.toMilliCU()` half-boundary rounding | Implementation | Phase 1 verification, issue 1 |
| 6 | `POST /api/config/publish` 500 on malformed input | Implementation | Phase 1 verification, issue 2 |
| 7 | `settlement.js` tier (Phase 5); call-site T1 (Phase 8); layer-direction gate (Phase 10); erasure-corpus gate (Phase 14) | owning phases | Phase 0 §9.1 |

**Items 5 and 6 were deliberately not fixed**, per the instruction to carry forward
only non-blocking items that belong to Phase 2. Neither is called by any Phase 2 code
path: `toMilliCU` has no consumer until Phase 8, and the publish endpoint is not
invoked by this phase.

### 17.3 Explicitly out of scope for Phase 2

Redis writes · Socket.IO changes · REST API changes · background workers other than
the one-shot backfill — **the plan specifies "None" for each, and none was made.** No
commit transaction, no guards, no fencing logic, no leases, no outbox: Phase 3 onward.

---

## 18. Risks

| Risk | Assessment |
|---|---|
| **The migration has not been applied to a real database** | The largest residual risk, inherited undischarged from Phase 1 and now compounded — this migration is roughly four times the size of Phase 1's. Mitigated by `prisma validate`, by Prisma-generated SQL used verbatim, and by an **automated** per-table statement-equivalence test, but not by execution. §17.1 item 1 should be discharged before Phase 3 |
| **The `Agent`-as-a-table reading (assumption 1)** | If the intended reading was "columns on `Robot`", the correction is mechanical — the fields, defaults, and backfill are the same — but it touches every FK that names `Agent.id`. Flagged first among the assumptions for exactly this reason |
| **`ALTER TYPE … ADD VALUE` on PostgreSQL 11** | Would fail. Neon runs 15+. Recorded in the migration header rather than left to fail at deploy |
| **`domainSchema.test.js` shells out to Prisma** | The test needs `node_modules/prisma` and its downloaded engines. Present after `npm ci`, which CI runs, and it needs no database — but it is a heavier dependency than a pure-JS test and would fail loudly rather than skip if the binary were absent |
| **The in-memory Prisma stand-in in `domainBackfill.test.js`** | It implements the subset of Prisma the job uses. A behaviour it models wrongly — relation-filter `count` semantics, most plausibly — would let a real bug pass. This is why §17.1 item 1 matters: the idempotency property is proven against a model, not against PostgreSQL |
| **`REJECTED` in the cancel guard is currently unreachable** | Inert today, correct tomorrow. It becomes live when Phase 10's intake writes §4.2 states, and it is asserted only by inspection until then |
| **148 register parameters, 96 `PROVISIONAL`** | Unchanged by this phase; §22.4's predicted failure mode, gated at launch |

---

## 19. Readiness for Phase 3

| Prerequisite | State |
|---|---|
| Phase 2 complete | ✅ 15/15 checklist implemented; 5/5 completion criteria, one with partial evidence (§14.3) |
| Phase 3's dependency | Phase 2 only — satisfied |
| Blocking decisions for Phase 3 | **None in Phase 2's output.** B9 (PostgreSQL isolation strategy — Prisma does not expose SERIALIZABLE per-transaction ergonomically) is Phase 3's own blocking decision and is unaffected by this phase |
| What Phase 3 gets | `Commitment` with `fence` BIGINT, `leaseExpiry`, `custodyState`, `planSnapshotRef`, `decisionRef`, `version`, `releasedAt`, and the HARD-only CHECK already in place; `Agent.authorityEpoch` and `Agent.fenceCounter` defaulted and monotone; `Leg.version` for guard G4; `Leg.cancelRequestedAt` and `Leg.purpose` for guard G5; `Leg.state` for guard G6; `domain/purpose.isCustodial()` as G5's single definition of `custodial_purposes` |
| What Phase 3 must add | `ShardLeadership` (static row + fence), `AgentFenceAudit`, the partial unique index enforcing ≤ `capacity[agent_class]` active commitments (I1) — predicated on `releasedAt` |
| Guardrails Phase 3 will meet | Tier gate (`commitment/**` is Tier 0), parameter gate (23 modules / 148 parameters, load-bearing), tenet gate, and the Phase-2-ownership assertion in `phase0Scaffold.test.js`, which will fail on any `commitment/` module until this report's successor widens it |
| **Strongly recommended first** | §17.1 item 1 — apply Phases 1 and 2 to a production-shaped dump. Phase 3 adds constraints to a table this migration creates, and adding a constraint to a table that has never been created is not a test |

---

## 20. Stop

**Phase 2 is complete. Phase 3 has not been started and will not be started without
independent verification and explicit approval.**

No commitment logic, no scheduling, no optimisation, and no Phase 3+ work of any kind
was implemented. The `Commitment` table is empty and no code path writes it.

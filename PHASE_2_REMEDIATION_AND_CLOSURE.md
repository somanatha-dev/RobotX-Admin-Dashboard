# Phase 2 — Remediation and Closure

**Scope:** the three issues of `PHASE_2_INDEPENDENT_VERIFICATION.md` Part 13, the migration
and backfill execution gaps both Phase 2 reports disclosed but could not discharge, and
whatever independent re-verification of Phase 2 found in the repository as it stands today.
**Date:** 2026-08-10 · **Branch:** `feature/dashboard` · **HEAD at remediation:** `62d8141`
**Authority order applied:** `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN) →
`IMPLEMENTATION_EXECUTION_PLAN.md` → repository/code/schema/migrations →
`PHASE_2_INDEPENDENT_VERIFICATION.md` → `PHASE_2_IMPLEMENTATION_REPORT.md`.

> **This document does not replace either Phase 2 report.** Their original claims and
> findings are preserved verbatim; this is the remediation record laid alongside them. Where
> re-verification found a report claim to be stale or no longer checkable, the original text
> is left standing and corrected here, with evidence.

> **No Phase 3 functionality was introduced.** No commit transaction, no `commitment/fencing.js`,
> no guards G1–G6, no fence allocation, no lease grant, no `ShardLeadership`, no advisory-lock
> demotion, no commitment lifecycle. The `Commitment` table is still written by nothing in
> `tools/` — verified in §9. The frozen specification was not modified. No gate was weakened.
> No test was deleted, skipped, or re-baselined.

> **Read this alongside the repository's actual age.** Phase 2 was implemented at working tree
> `4244b3d` and verified the next day. The repository is now at Phase 15. Phase 2's artefacts
> have since been modified by later phases, and two of this remediation's findings exist only
> because of that. Where a Phase 2 report states a number that later phases have moved, the
> number is corrected here as *Phase-2-era* rather than silently updated.

---

## 0. Status summary

| # | Finding | Origin | Classification | Status |
|---|---|---|---|---|
| 1 | Migration never executed against a live PostgreSQL | Verification Part 13 #1 | Environmental | ✅ **EXECUTED** — 21/21 migrations applied; 49/49 behavioural checks; legacy data md5-identical |
| 2 | Backfill never executed against a live PostgreSQL | Report §14.3 item 3 | Environmental | ✅ **EXECUTED** — 6 Robots + 7 Tasks converted; 0 orphans; deterministic and idempotent against real DDL |
| 3 | Immutability/append-only triggers and the HARD-only CHECK never fired | Report §14.3 item 2, §17.1 item 1 | Environmental | ✅ **EXECUTED** — all three fire; DELETE asymmetry confirmed deliberate |
| 4 | Spatial mirror passes a non-column field to Prisma (`indexing`) | **New — found by live execution** | Implementation defect (Phase 15 regression into a Phase 2 path) | ✅ **FIXED** + 6 regression tests |
| 5 | Spatial mirror writes logical map ids into foreign-key columns | **New — found by live execution** | Implementation defect (latent since Phase 2) | ✅ **FIXED** + regression tests (same suite) |
| 6 | `schema.prisma` line-delta understated (~640 claimed vs 879 measured) | Verification Part 13 #2 | Documentation | ⚠️ **NO LONGER INDEPENDENTLY CHECKABLE** — Phase 2 was never committed in isolation; the load-bearing claim (zero deletions) is re-confirmed as 0 |
| 7 | `Agent`-as-a-table vs columns-on-`Robot` | Verification Part 13 #3 | Architecture ambiguity | ⚠️ **VERIFIED / NO DEFECT — reading now supported by live evidence, but still a reading** |
| 8 | `ConfigActiveVersion_version_fkey` exists in the migration but not in `schema.prisma` | **New — found by live drift check** | Schema drift, **Phase 1 scope** | ⚠️ **DOCUMENTED, NOT FIXED — out of Phase 2 scope** |
| 9 | The seeded spatial map now fails Phase 15's A6 (H3 cell identity) | **New — found by re-verification** | Cross-phase interaction | ⚠️ **DEFERRED — Phase 15 / config owner; Phase 2's own criterion (V8) passes** |
| 10 | Both Phase 2 reports' test and lane counts are stale | **New** | Documentation | ✅ **DOCUMENTATION CORRECTED** — §10 |

**Findings 1–3 are the ones that mattered.** Every Phase 2 document said, honestly, that the
largest migration in the programme had never been run. It has now been run, and it exposed two
real defects (4 and 5) that every static check and the entire green test suite had missed.

**Findings 6–9 remain open by design.** 6 is unrecoverable history. 7 is an ambiguity in the
plan that no implementation phase may resolve. 8 belongs to Phase 1. 9 belongs to Phase 15.

---

## 1. Findings 1–3 — live PostgreSQL execution

### Original finding

> `PHASE_2_IMPLEMENTATION_REPORT.md` §14.3: *"The migration applied against a live PostgreSQL —
> **Not run.** A local PostgreSQL is listening on 5432 but rejects the two credential pairs on
> file (`P1000`). The project's `DATABASE_URL` points at a shared Neon database — production
> infrastructure, not a disposable test target."*
>
> `PHASE_2_INDEPENDENT_VERIFICATION.md` Part 13 #1: *"Neither the implementer nor this reviewer
> could reach a usable local Postgres … materially stronger mitigation than a documentation
> claim, but not equivalent to execution."*

**Confirmed as stated.** The local cluster on 5432 still rejects the on-file credentials
(`FATAL: password authentication failed for user "postgres"`), and `DATABASE_URL` still points
at the shared Neon instance. Neither was used.

### What was done instead

A **disposable cluster was created from the installed PostgreSQL 18.3 binaries**, in the
session scratchpad, on port 55432, bound to `127.0.0.1`, with its own superuser. It touches
neither the user's `robot_system` database nor Neon. This is the safe target both earlier
attempts lacked.

```
initdb -D <scratch>/pgdata -U pgverify -A trust
postgres -D <scratch>/pgdata -p 55432 -c listen_addresses=127.0.0.1
psql -h 127.0.0.1 -p 55432 -U pgverify -tAc "select version();"
  PostgreSQL 18.3 on x86_64-windows, compiled by msvc-19.44.35223, 64-bit
```

### 1.1 Phase 2 applied onto a production-shaped legacy database

The plan's testing requirement is *"Migration: forward + rollback on a production-shaped
dump."* The forward half was run as follows.

A database was built to the **pre-Phase-2** state by applying the first eight migrations
(`init` … Phase 1's `config_registry_and_governance`), then seeded with a legacy fixture
shaped like production: 6 `Robot` rows spanning all six `RobotStatus` values, 7 `Task` rows
spanning all six legacy `TaskStatus` values, 2 `Zone` rows, and two strict 1:1
`Robot.currentTaskId` links. Only then was Phase 2's migration applied.

```
=== PRE-PHASE-2 CHAIN (init .. Phase 1) ===
OK    20260402190740_init            OK    20260725142730_add_google_auth
OK    20260420171310_add_pin_auth    OK    20260726075557_add_webauthn_credentials
OK    20260518152516_dtaro_zone_obstacle
OK    20260519052912_add_robot_name  OK    20260728093000_config_registry_and_governance
OK    20260519084941_add_task_distance_meters

=== APPLY PHASE 2 MIGRATION (live DDL execution) ===
exit code: 0        (… ALTER TABLE ×21, CREATE FUNCTION ×2, CREATE TRIGGER ×2)

=== LEGACY PRESERVATION ===
  BEFORE robots=6   task_md5=829e2bff452f3595d4085f2fdb50a6bc   robot_md5=f618bb7d1ad9fa22147858e36275a947
  AFTER  robots=6   task_md5=829e2bff452f3595d4085f2fdb50a6bc   robot_md5=f618bb7d1ad9fa22147858e36275a947
RESULT: LEGACY DATA IDENTICAL BEFORE AND AFTER PHASE 2 MIGRATION
```

The md5 covers each row's id, business key, status, and the nullable columns the migration
touches. **Not "no rows lost" — no byte changed.**

The **full 21-migration chain** (through Phase 15's `security_governance_privacy`) was then
applied to a second disposable database from empty, all 21 `OK`, which additionally confirms
Phase 2's migration is ordering-compatible with everything built on top of it.

### 1.2 Objects actually created

Read back from the live catalogue, not from the migration text:

| Object | Live count | Report claim | Verdict |
|---|---|---|---|
| Phase 2 tables (incl. `_MissionToTask`) | **20** | 20 | ✅ |
| New enums | **5** (`LifecycleState`, `LegPurpose`, `LegState`, `CustodyState`, `ObstructionClass`) | 5 | ✅ |
| `TaskStatus` values after migration | **14** (6 legacy + 8 added) | 8 added | ✅ |
| Indexes on Phase 2 tables | **73** | not stated | ✅ recorded |
| Foreign keys touching Phase 2 tables | **27** | 20 tabulated | ✅ superset, all checked |
| CHECK constraints | **1** (`Commitment_kind_hard_only`) | 1 | ✅ |
| Phase 2 triggers | **2** (`Observation_append_only`, `DecisionRecordA_immutable`) | 2 | ✅ |

`Agent` carries all 11 substantive columns including `fleetId` and `tenantId`; both fencing
counters are `bigint NOT NULL DEFAULT 0`; `lifecycleState` defaults `COMMISSIONED`.
`Leg.purpose` is `NOT NULL` **with no default**, exactly as the completion criterion requires.

### 1.3 The 49 behavioural checks

Static analysis can prove a constraint is *written*. Only execution proves it *fires*. Every
check below ran against the live database inside one transaction that was then rolled back.

```
================== SUMMARY ==================
 verdict | count
---------+-------
 PASS    |    49
```

The ones that carry the most weight:

| Property | Result |
|---|---|
| `Commitment` with `kind='HARD'` accepted | PASS |
| `kind='SOFT'` **rejected** — `23514 violates check constraint "Commitment_kind_hard_only"` | PASS |
| `kind='hard'` (lowercase) rejected — the CHECK is case-exact | PASS |
| `UPDATE` moving `kind` away from `HARD` rejected — the CHECK holds on update, not only insert | PASS |
| `Observation` UPDATE rejected — `P0001 Observation is append-only (§2.7); UPDATE is refused` | PASS |
| `Observation` **no-op** UPDATE also rejected — the trigger is unconditional | PASS |
| `Observation` DELETE **permitted** — the documented retention asymmetry, confirmed deliberate | PASS |
| `DecisionRecordA` UPDATE rejected — `P0001 DecisionRecordA is immutable (§21.2)` | PASS |
| `Leg` without `purpose` rejected — `23502 null value in column "purpose"` | PASS |
| `Agent`→`Robot` **CASCADE**: deleting the Robot removes its Agent, and its Observations with it | PASS |
| `Commitment`→`Agent` / `Commitment`→`Leg` **RESTRICT**: `23001 violates RESTRICT setting` | PASS |
| `Site`→`Region`, `CellAssignment`→`Region` **RESTRICT** — redistricting is not a row delete | PASS |
| `Zone`→`Region` **SET NULL** — the Zone survives, `regionId` nulled | PASS |
| `Task`→`PayloadSpec` **SET NULL** — the Task row is preserved | PASS |
| `Leg`→`Mission`, `Stop`→`Leg`, `PayloadManifest`→`Leg`, `Compartment`→`ContainerModel`, `Capability`→`CapabilityBundle` **CASCADE** | PASS |
| A second `Agent` on the same `Robot` rejected — `Agent_robotDbId_key`, so the 1:1 is enforced by the database | PASS |
| Duplicate `(missionId,sequence)`, `(legId,sequence)`, `(cellId,mapVersion)` all rejected | PASS |
| Legacy `Task.status` write (`IN_PROGRESS`) still works after the migration | PASS |
| New §4.2 write (`AT_RISK`) works | PASS |
| Legacy `Robot` insert still works — the migration added no required column | PASS |

**Every `ON DELETE` clause in the implementation report's §5.3 table was confirmed by causing
the deletion and observing the result**, not by reading the clause.

### 1.4 `prisma validate` and schema drift

```
$ npx prisma validate
The schema at prisma\schema.prisma is valid 🚀

$ npx prisma migrate diff --from-url <disposable> --to-schema-datamodel prisma/schema.prisma --script
-- DropForeignKey
ALTER TABLE "ConfigActiveVersion" DROP CONSTRAINT "ConfigActiveVersion_version_fkey";
```

**No Phase 2 object drifts.** The migration chain and `schema.prisma` agree exactly on every
one of Phase 2's 20 tables, 73 indexes, 27 foreign keys, its CHECK, and its triggers — which
is a materially stronger result than the original static statement-equivalence test, because
it compares against a database that actually ran the DDL. The single drifting object belongs
to Phase 1; see Finding 8.

### Status

✅ **Findings 1–3 discharged.** The recommendation both reports made — *"apply Phases 1 and 2
to a production-shaped dump before Phase 3"* — is satisfied.

---

## 2. Findings 4 and 5 — two real defects in the spatial mirror

Both were found by doing the thing neither earlier pass could do: running the backfill against
a real Prisma client and a real PostgreSQL. Both made `backfillSpatialMirror` write **nothing
at all**, and both passed a green test suite for weeks.

### 2.1 Finding 4 — a non-column field reached Prisma

`toConfigPayload` is a *configuration* projection. Phase 15 added an `indexing` field to it so
the publish-time A6 check could read the map's own declaration. `backfillSpatialMirror` built
its row with `create: { ...assignment, mapVersion }`, so `indexing` went straight to Prisma:

```
PrismaClientValidationError
    create: { cellId: "cell-rrnagar-fine-01", …, indexing: null,
                                                  ~~~~~~~~
Unknown argument `indexing`. Available options are marked with ?.
```

This is a **Phase 15 regression into a Phase 2 code path**, not an original Phase 2 defect.
Phase 2 shipped when `toConfigPayload` emitted exactly the mirror's columns.

### 2.2 Finding 5 — logical map ids written into foreign-key columns

Underneath Finding 4 sat an older defect. §3.6's containment is *published* against logical
identifiers (`RGN-BLR`, `ZN-RRNAGAR`, `STE-RNSIT`), and that is the vocabulary the payload and
the resolver speak. But `CellAssignment.regionId` / `zoneId` / `siteId` are foreign keys to
`Region.id` / `Zone.id` / `Site.id` — surrogate row ids. The mirror wrote the logical ids
directly:

```
PrismaClientKnownRequestError P2003
Foreign key constraint violated: `CellAssignment_regionId_fkey (index)`
```

`prisma/seed.js` performs the resolution correctly when it publishes the map. The mirror never
did. This defect has been latent since Phase 2 shipped and would have failed on the first
real run.

### 2.3 Why every existing check missed both

`domainBackfill.test.js` drives the backfill through an in-memory store. That store's `upsert`
was `{ ...create }` — it validated no field name and enforced no foreign key, and it had **no
`site` or `zone` table at all**. This is precisely the risk the implementation report named in
its own §18:

> *"The in-memory Prisma stand-in … A behaviour it models wrongly … would let a real bug pass.
> This is why §17.1 item 1 matters: the idempotency property is proven against a model, not
> against PostgreSQL."*

That warning was correct, and this is the bug it predicted.

### 2.4 The fix

`tools/migrate/backfillDomain.js`:

1. **A column whitelist.** `CELL_ASSIGNMENT_COLUMNS` names the five columns the mirror writes,
   and each row is built from it explicitly. A future addition to the config payload can no
   longer leak into a database call.
2. **`resolveSpatialUnitRows()`** joins each logical unit to its row — `Region` by `regionId`,
   `Site` by `siteId`, `Zone` by `name` (it carries no logical-id column) — which is exactly
   the resolution `prisma/seed.js` performs.
3. **Refuse rather than half-mirror.** A map whose units are not yet published, or a cell whose
   unit cannot be resolved, returns `skipped: true` with a problem naming the unit, and writes
   nothing. This follows the module's existing treatment of an invalid map, for the same
   reason: a mirror missing some cells is a map that means something different from the one
   that was published.

No schema, no migration, and no specification was changed. `CellAssignment.regionId` is
`NOT NULL`, so an unresolvable region is reported rather than written as `null`.

### 2.5 Regression tests

Six tests added to `domainBackfill.test.js` (32 → **38**), and the in-memory store made
faithful enough to fail on both defects:

- the store now rejects any payload key that is not a `CellAssignment` column, mirroring
  `PrismaClientValidationError`;
- it now carries `site` and `zone` tables with `findUnique`, and its fixture gives the spatial
  units **row ids that differ from their logical ids** — a fixture that reused the logical id
  as the primary key would hide the very defect it exists to catch.

| Test | Proves |
|---|---|
| the mirror passes only real `CellAssignment` columns to the client | Finding 4 cannot return |
| the mirror stores database row ids, not the map's logical ids | Finding 5 cannot return |
| a map whose units are not yet published is refused, not written with dangling ids | the refusal path |
| an unresolvable zone refuses the whole mirror rather than half of it | all-or-nothing |
| `resolveSpatialUnitRows` joins each unit on the key the seed publishes it under | the join keys |
| the mirror stays idempotent after resolution | the fix did not cost idempotency |

### 2.6 Fresh evidence — the fix against live PostgreSQL

```
STEP A  mirror BEFORE publication      → cells=0, skipped=true, 4 problems naming each unit
STEP B  publish the units              → Region RGN-BLR → ec5c436f-…, Zone ZN-RRNAGAR → 21ba0e5d-…
STEP C  mirror AFTER publication       → {"cells":5,"skipped":false,"problems":[]}
STEP D  every FK joins to a real row   → 5 of 5 CellAssignment rows join to Region/Zone/Site
STEP E  fine/coarse split              → FINE n=4 with_zone=4 · COARSE n=1 with_zone=0
STEP F  re-run                         → rows still 5, MIRROR STATE IDENTICAL ACROSS RUNS: YES
STEP G  full run() end to end          → 5 cells, 6 Agents, 7 Missions, 7 Legs, 14 Stops,
                                         VERIFIED — 100% of legacy rows converted, zero orphans
STEP H  deliberately invalid map       → skipped=true, rows unchanged at 5 (validator still fails)
```

### Status

✅ **Findings 4 and 5 FIXED**, regression-tested, and verified against live PostgreSQL.

---

## 3. Backfill — independently re-verified against a real database

The real `tools/migrate/backfillDomain.js` was run against the real `@prisma/client` and the
disposable database, at batch size 4 to force cursor paging.

### Completeness — counted, not sampled

| | Source | Converted |
|---|---|---|
| `Robot` → `Agent` | 6 | **6** |
| `Task` → `Mission` | 7 | **7** |
| `Task` → `PRIMARY` `Leg` | 7 | **7** |
| `Task` → `Stop` | 7 | **14** (two per Leg) |
| `Mission`↔`Task` links | 7 | **7** |
| `Commitment` | — | **0** |

A dry run first reported the same counts and wrote nothing (`counts after dry run: agents=0`).

### Zero orphans — an independent sweep, not just the job's own verifier

`verify()` returned `ok: true` with `findings: []`. Re-counted independently:

```json
{ "robotsWithoutAgent": 0, "agentsWithoutRobot": 0, "tasksWithoutMission": 0,
  "missionsWithoutLeg": 0, "legsWithoutStops": 0, "nonPrimaryLegs": 0,
  "legsWithWrongStopCount": 0, "commitmentsWritten": 0, "observations": 0 }
```

`legsWithWrongStopCount` is this remediation's own addition: it walks every Leg and asserts
exactly two Stops, which is the plan's stated property (*"exactly one Mission with exactly one
`PRIMARY` Leg and two Stops"*) checked over real rows rather than at construction time.

### Determinism

Every id is a UUIDv5-shaped digest of a fixed namespace and the legacy key. Observed:

```
Agent   RBT-001     -> 12f1bccd-72ac-5516-93b5-2b36d7312e41
Mission MSN-TSK-001 -> 89b36575-583e-5ac8-b852-10e80e893397
Leg     LEG-TSK-001 -> a2fe990e-42df-5c35-988e-80dd380620e0
```

All version nibbles `5`, all variant nibbles in `[89ab]`, and the four namespaces produce four
distinct ids for the same key — so a Robot and a Task sharing a legacy key cannot collide.

### Idempotency — and the part that actually matters

Counts identical across runs, and a full row-level snapshot of `Agent`/`Mission`/`Leg`/`Stop`/
`CellAssignment` **identical before and after a re-run**.

The stronger test: state the re-run must *not* reset was advanced first.

| Advanced before re-run | After re-run | Verdict |
|---|---|---|
| `Agent.authorityEpoch = 7`, `fenceCounter = 42` | **7 / 42** | PASS — monotone counters survive (§2.6, I6) |
| `Leg.state = LOADED`, `custodyState = HELD`, `version = 5` | **LOADED / HELD / 5** | PASS — the state machine owns the Leg (Phase 5) |

A re-run that reset either would be, in the implementation report's own words, *"a data-loss
bug wearing an idempotency badge."* It does not.

### Legacy status mapping, over all six values

| Legacy `TaskStatus` | Leg state | |
|---|---|---|
| `PENDING` | `QUEUED` | |
| `ASSIGNED` | `ACCEPTED` | claims a binding, asserts nothing about motion |
| `IN_PROGRESS` | `EN_ROUTE_PICKUP` | |
| `COMPLETED` | `SETTLED` | |
| `FAILED` | `FAILED` | |
| `CANCELLED` | `CANCELLED` | |
| unrecognised | `QUEUED` | never a terminal state (T2 — unknown is not permission) |

Nothing maps to `LOADED`: custody is a fact the legacy schema never recorded.

---

## 4. Schema and enums against the frozen specification

Checked in **both directions** against the live `pg_enum` catalogue — a value in the database
with no §-defined meaning fails as loudly as a §-defined value that is missing.

| Enum | § | Spec values | DB values | spec→DB | DB→spec | Verdict |
|---|---|---|---|---|---|---|
| `TaskStatus` | §4.2 | 11 | 14 | all present | no unauthorised value | ✅ (3 legacy retained: `PENDING`, `ASSIGNED`, `IN_PROGRESS`) |
| `LegState` | §4.3 | 19 | 19 | all present | none extra | ✅ |
| `LegPurpose` | §2.4 | 6 | 6 | all present | none extra | ✅ |
| `CustodyState` | §2.5 | 5 | 5 | all present | none extra | ✅ |
| `LifecycleState` | §2.1 | 5 | 5 | all present | none extra | ✅ |
| `ObstructionClass` | §4.3 | 4 | 4 | all present | none extra | ✅ |

`ENUM CHECK: PASS — all 6 enums agree in both directions.`

The eight added `TaskStatus` values are the correct resolution of the plan/specification
disagreement the implementation report documented in its §5.1: §4.2 tabulates eleven states,
the plan names five additions, and the plan states its own precedence. Re-confirmed
independently; not a scope overrun.

---

## 5. Migration safety

Scanned the Phase 2 migration for every destructive operation class:

| Pattern | Occurrences |
|---|---|
| `DROP` | **0** |
| `RENAME` | **0** |
| `ALTER COLUMN` | **0** |
| `TRUNCATE` | **0** |
| `DELETE FROM` | **0** |
| `UPDATE` | **0** |
| `SET NOT NULL` | **0** |
| `SET DEFAULT` | **0** |

Statement census: 20 `CREATE TABLE`, 5 `CREATE TYPE`, 8 `ALTER TYPE … ADD VALUE`, 35
`CREATE INDEX`, 22 `CREATE UNIQUE INDEX`, 30 `ALTER TABLE`, 2 `CREATE OR REPLACE FUNCTION`,
2 `CREATE TRIGGER`. **The migration is additive, and now demonstrably so rather than
assertedly so** — the md5 evidence of §1.1 is the same claim measured on data.

Ordering, verified by line number:

```
last CREATE TYPE at line 61; first CREATE TABLE at line 68   -> PASS (enums precede tables)
last unique index at line 642; first foreign key at line 652 -> PASS (indexes precede FKs)
new TaskStatus values used by DML in this migration: 0        -> PASS (PG ≥12 in-transaction rule)
```

Every added column on `Zone` and `Task` is nullable: `Zone.regionId`, and `Task`'s
`tenantId`, `slaClass`, `businessPriority`, `requirements`, `windowStart`, `windowEnd`,
`payloadSpecId` — seven, as the migration header states.

**Rollback was not executed**, and remains the one part of the plan's testing requirement not
discharged. This repository's migrations are forward-only by convention and Phase 2 carries no
`down`, so there is nothing to execute; the rollback path is the additive-only property itself,
now evidenced. Recorded as a residual limitation in §11 rather than claimed.

---

## 6. Spatial hierarchy — 41 checks including seven deliberately broken maps

### Containment is by published assignment, not geometry (§3.6)

- `resolve()` arity is **1**, and it is a cell id — there is no coordinate to pass.
- None of eight geometry tokens (`pointInPolygon`, `haversine`, `minLat`/`maxLat`, …) appears
  in `hierarchy.js` outside comments.
- An unpublished cell resolves to `assigned: false` — not to a guess.

### The validator can fail

A validator that has never rejected anything is not verified. Seven crafted violations, each
rejected with a finding quoting the rule and its §3.6 consequence:

| Broken map | Rejected |
|---|---|
| a zone assigned to two regions | ✅ *"…Ω_terminal no longer bounds the prices the shard can reach"* |
| a fine cell mapped to two zones | ✅ *"maps to 2 zones; every fine cell maps to exactly one"* |
| a fine cell mapped to no zone | ✅ *"an unassigned fine cell is a hole in the pricing surface"* |
| a fine cell mapped to two sites | ✅ *"maps to 2 sites; every fine cell maps to at most one"* |
| a zone naming an undeclared region | ✅ |
| a cell whose region disagrees with its zone's region | ✅ *"Containment must agree at every level"* |
| a zone with no region at all | ✅ |

### Fine vs coarse, and the real Phase 1 V8 check

Run against `validators.v8SpatialContainment` — the actual Phase 1 export, not a
reimplementation:

| | Result |
|---|---|
| fine cells published under `cells` | 4, all `FINE` |
| coarse cells published under `coarseCells` | 1, naming no zone (it spans zones by construction, §6.2) |
| **V8 on the seeded payload** | **0 findings** |
| V8 on a payload with a fine cell in two zones | **1 finding** — so the pass is known to be capable of failing |
| V8 if the coarse cell were published inside `cells` | **1 finding** — *"cell-blr-coarse-01 maps to 0 zones"* |

That last line is the load-bearing one: it demonstrates *why* `toConfigPayload` separates the
two resolutions. Publishing coarse cells in the array V8 reads would fail a correct map against
a correct check. **Phase 1 remains unmodified**, and the completion criterion — the containment
validator passes on the seeded map — holds.

---

## 7. Findings 6 and 7 — the two carried-forward documentation/architecture items

### Finding 6 — the schema line count

The verification report measured **879 insertions** against the report's stated **~640**. That
figure is **no longer independently checkable**: Phase 2 was never committed on its own.

```
$ git log --oneline --diff-filter=A -- .../20260728140000_domain_model_and_spatial_hierarchy/migration.sql
cf9103f 3rd aug 2026 phase 5 implemented and verified
```

Phase 2's schema additions entered the history inside `cf9103f`, together with Phases 3–5
(1328 insertions for the four phases combined). I did not reconstruct a Phase-2-only delta and
do not restate 879 as though I had verified it.

The **substantive** claim is verifiable and verified: that commit removes **0** lines from
`schema.prisma`. Nothing was dropped, renamed, or re-typed — which §5's destructive scan and
§1.1's md5 evidence both independently confirm.

⚠️ **Classification: documentation, no longer independently checkable.** The lesson is a
process one: a phase whose central compatibility claim is "zero lines removed" should be
committed on its own.

### Finding 7 — `Agent` as a table

Still a reading of an ambiguous plan (group (a) *"`Agent` (extends Robot: …)"* against group
(f) *"`Zone` (**extend**: …)"*), and still not a specification-stated fact. Live execution now
adds evidence that the reading is at least *implemented coherently*:

- `Agent_robotDbId_key` makes the 1:1 a database guarantee — a second Agent on one Robot is
  rejected, not merely discouraged;
- `Agent`→`Robot` `ON DELETE CASCADE` fires, so the existing decommission endpoint cannot
  leave the orphan the criterion forbids;
- `Robot` acquired **no column** — a legacy `Robot` insert with only its required fields still
  succeeds after the migration, so the strangler pattern holds and `Robot` stays authoritative
  for the legacy dispatcher.

⚠️ **Classification: verified / no defect; architecture ambiguity preserved, not resolved.**
If the intended reading was columns-on-`Robot`, the correction remains mechanical but touches
every FK naming `Agent.id` — now measured at **27** foreign keys.

---

## 8. Finding 8 — `ConfigActiveVersion` schema drift (Phase 1 scope)

The drift check of §1.4 found exactly one disagreement between the migration chain and
`schema.prisma`, and it is not Phase 2's:

```
$ npx prisma migrate diff --from-url <disposable> --to-schema-datamodel prisma/schema.prisma --script
-- DropForeignKey
ALTER TABLE "ConfigActiveVersion" DROP CONSTRAINT "ConfigActiveVersion_version_fkey";
```

Phase 1's migration adds the constraint:

```sql
-- 20260728093000_config_registry_and_governance/migration.sql:173
ALTER TABLE "ConfigActiveVersion"
    ADD CONSTRAINT "ConfigActiveVersion_version_fkey"
    FOREIGN KEY ("version") REFERENCES "ConfigVersion"("version") ON DELETE RESTRICT ON UPDATE CASCADE;
```

…while `schema.prisma`'s `ConfigActiveVersion` model (line 642) declares `version Int` with no
relation. The database is therefore *stricter* than the datamodel, which is the safe direction,
but the divergence is real: a future `prisma migrate dev` or `db push` would propose dropping a
constraint that Phase 1 added deliberately (*"the active-version pointer is a single row"*).

Grepped: this is recorded in none of `PHASE_1_IMPLEMENTATION_REPORT.md`,
`PHASE_1_INDEPENDENT_VERIFICATION.md`, or `PHASE_1_REMEDIATION_AND_CLOSURE.md`.

⚠️ **Classification: schema drift, Phase 1 scope — DOCUMENTED, NOT FIXED.** Fixing it means
either declaring the relation in `schema.prisma` or removing the constraint, both of which are
decisions about Phase 1's configuration registry. Phase 2 has no authority over it, and this
remediation deliberately did not touch it. **Owner: Phase 1 / config owner.**

---

## 9. Finding 9 — the seeded map and Phase 15's A6

Phase 2's completion criterion is that *"the spatial containment validator (§22.1) passes on
seeded region/zone/cell maps."* That is **V8, and it passes with zero findings** (§6).

Phase 15 added **A6** (`a6SpatialCellIdentity`), which enforces §6.2's now-settled B5 decision
that cell ids are H3 indexes. The Phase 2 seed map uses placeholders:

```
A6 findings on the seeded payload: 5
  cells: V-10 cell "cell-rrnagar-fine-01" is not a valid H3 index. B5 is settled (§6.2, spatial/cells…)
```

Phase 2 shipped when B5 was explicitly *unsettled* — its own report records the cell primitive
as *"blocking decision B5, which belongs to Phase 9."* So this is not a Phase 2 defect; it is
the cost of a fixture outliving the decision it was waiting on.

Consequence for the record: the implementation report's TODO §17.1 item 2 (*"publish the
spatial map as a `ConfigVersion`"*) is now blocked by **two** findings, not one — Phase 1's V9
combined-conservatism finding (confirmed still open: `PHASE_1_REMEDIATION_AND_CLOSURE.md`
classifies it *"VERIFIED / NO DEFECT — EXTERNAL SAFETY DECISION REQUIRED"*) and now A6.

⚠️ **Classification: cross-phase interaction — DEFERRED.** **Owner: Phase 15 / config owner.**
Rewriting the seed map's cell ids to real H3 indexes would change a published-map fixture that
Phase 2, 9 and 15 tests all read, and is not Phase 2's call.

---

## 10. Finding 10 — stale counts in both Phase 2 reports

Both reports state Phase-2-era numbers as though current. They were accurate on 2026-07-28/29;
the repository has since absorbed thirteen more phases, and Phase 15 retired legacy modules.

| Claim in the Phase 2 reports | Phase-2-era | Measured today |
|---|---|---|
| Full suite | 42 suites / 668 tests | **145 suites / 6 363 tests** |
| Legacy lane *"22 suites / 169 tests, identical to Phase 0/1 baselines"* | 22 / 169 | **17 / 126** (Phase 15 retired 4 modules; `gate:legacy` PASS) |
| Gates lane | 3 suites / 49 tests | **7 suites / 100 tests** |
| Engine lane | 17 / 450 | **115 / 6 070** |
| `gate:tiers` | 89 modules / 30 edges | **277 modules / 386 edges** |
| `gate:params` | 23 modules / 148 parameters | **183 modules / 242 parameters** |
| `gate:tenets` | 86 modules | **274 modules** |
| `domainBackfill.test.js` | 32 tests | **38 tests** (this remediation added 6) |
| `domainSchema.test.js` | 64 tests | **65 tests** |

✅ **DOCUMENTATION CORRECTED.** The originals are left standing as the Phase-2-era record;
both reports now carry a banner pointing here.

---

## 11. Tests and gates — exact commands, exact results

```
$ npm run gates
gate: tier-dependencies (§1.8 rule 2)          PASS — 277 module(s), 386 governed import edge(s)
gate: parameter-register (§22, Appendix A)     PASS — 183 module(s), 242 registered parameter(s)
gate: tenets (T1, T6)                          PASS — 274 module(s), no violations
gate: identity-isolation (§23.7)               PASS — 16 module(s) in cost/decision-record scopes
gate: reconstruction-equivalence (ERASED)      PASS — 3 corpus decision(s), byte-for-byte
gate: legacy-retirement (Phase 15)             PASS — 4 retired module(s) absent, 302 file(s)
gate: column-generation (§21.6)                PASS — NOT_REQUIRED

$ npx jest --runInBand --forceExit
Test Suites: 145 passed, 145 total
Tests:       6363 passed, 6363 total

$ npx jest --selectProjects legacy   → 17 suites / 126 tests passed
$ npx jest --selectProjects gates    → 7 suites / 100 tests passed
$ npx jest --selectProjects engine   → 115 suites / 6070 tests passed

Phase 2 suites individually:
  domainModel.test.js       57 passed
  domainSchema.test.js      65 passed
  domainBackfill.test.js    38 passed   (32 before; +6 regression)
  spatialHierarchy.test.js  23 passed
                           ─── 183 tests

$ npx prisma validate                → valid
$ 21/21 migrations applied to a disposable PostgreSQL 18.3
$ 49/49 behavioural constraint checks PASS
$ 41/41 spatial + mapper checks PASS
$ 6/6 enums agree with the frozen specification in both directions
```

**Zero failures, zero skips, zero re-baselined expectations.** No test was weakened; the one
test *double* that changed became stricter (§2.5).

---

## 12. Phase 3 boundary

Explicitly checked. `git diff` for this remediation touches exactly two files:

```
 Backend/tests/engine/domainBackfill.test.js | 173 +++++++++++++++-
 Backend/tools/migrate/backfillDomain.js     | 131 ++++++++++--
 2 files changed, 289 insertions(+), 15 deletions(-)
```

- Scanned every added line for `commit(`, `fencing`, `G1`–`G6`, `lease`, `ShardLeadership`,
  `advisory`, `leadership` — **zero matches**.
- `prisma/schema.prisma` and every file under `prisma/migrations/` — **untouched**.
- The backfill still writes **no `Commitment`**: grep for `commitment.create` / `.upsert` across
  `tools/` returns nothing, and the live run ended with `commitmentsWritten: 0`.
- `Commitment`'s schema, its HARD-only CHECK, and its RESTRICT foreign keys were *verified*,
  which is Phase 2's scope. None of its behaviour was implemented.

> **No Phase 3 functionality was implemented.**

The one place where a Phase 2 issue could have pulled Phase 3 forward — Findings 4 and 5 sit in
the backfill, which also touches `Agent.authorityEpoch` and `Agent.fenceCounter` — was handled
by leaving both counters exactly as Phase 2 left them: excluded from the upsert's update branch,
and now *proven* to survive a re-run (§3) rather than merely asserted to.

---

## 13. Files changed

| File | Change | Phase 2 scope? | Which finding | Which test |
|---|---|---|---|---|
| `Backend/tools/migrate/backfillDomain.js` | `CELL_ASSIGNMENT_COLUMNS` whitelist; `resolveSpatialUnitRows()`; mirror refuses rather than half-writes | Yes — the plan names this file as Phase 2's background worker | 4, 5 | 6 new tests in `domainBackfill.test.js`, plus live verification §2.6 |
| `Backend/tests/engine/domainBackfill.test.js` | store rejects non-columns and carries `site`/`zone`; 6 regression tests | Yes — Phase 2's own suite | 4, 5 | is the test |
| `PHASE_2_REMEDIATION_AND_CLOSURE.md` | **New** — this record | Documentation | all | — |
| `PHASE_2_IMPLEMENTATION_REPORT.md` | Status banner + corrections; original text preserved | Documentation | 1–3, 6, 10 | — |
| `PHASE_2_INDEPENDENT_VERIFICATION.md` | Status banner + corrections; original findings preserved | Documentation | 1–3, 6, 10 | — |

No unrelated file was modified. The pre-existing uncommitted work in the tree (Phase 15
routing, region boundary, config) was neither touched nor reset.

---

## 14. Remaining limitations

Genuine, unresolved, and not converted into a PASS:

1. **Rollback was not executed** (§5). Phase 2 carries no `down` migration and this repository
   is forward-only by convention, so there is nothing to run. The plan's *"forward + rollback"*
   requirement is therefore **half discharged by execution and half by design**.
2. **Finding 8 — `ConfigActiveVersion` FK drift.** Phase 1 scope. Open.
3. **Finding 9 — the seeded map fails Phase 15's A6.** Phase 15 / config owner. Open.
4. **Phase 1's V9 combined-conservatism finding remains open**, so the spatial map still does
   not publish as a `ConfigVersion`. Safety-class decision with a named owner.
5. **Finding 6 is unrecoverable.** Phase 2's isolated schema delta cannot be re-measured.
6. **The live verification used PostgreSQL 18.3; production is Neon (15+).** The DDL is
   version-portable and the migration's own PG ≥ 12 requirement is satisfied by both, but the
   executed evidence is from 18.3, not from the production engine.
7. **The disposable database was seeded with a 6-Robot / 7-Task fixture**, not a production
   dump. It covers every legacy status value and both `currentTaskId` link shapes, but it is
   representative rather than real, and it is small: paging was forced with `--batch 4` rather
   than exercised at fleet scale.
8. **Finding 7 remains an interpretive reading**, preserved rather than resolved.

---

## 15. Final status

# PHASE 2 CLOSED WITH DOCUMENTED ENVIRONMENTAL LIMITATION

Every Phase 2 execution-plan item and completion criterion is independently checked, and the
three verification issues plus the two execution gaps are discharged or explicitly classified.
The migration has been executed against a live PostgreSQL and is demonstrably additive; the
backfill converts every legacy row with zero orphans, deterministically and idempotently; the
spatial hierarchy resolves containment from published assignment and its validator is proven
capable of failing; the legacy surface is behaviourally unchanged.

**Two real defects were found — by execution, not by inspection — and both are fixed and
regression-tested.** Neither would have been caught by any static check, and both had been
green in CI since Phase 2 shipped. That is the argument for the environmental work this
remediation did.

The limitation in the title is item 1 of §14: rollback was not executed, because there is
nothing to execute. Items 2–4 are open findings owned by Phase 1, Phase 15, and Safety
respectively — none of them Phase 2's to close.

### Is Phase 2 genuinely ready for Phase 3?

**Yes**, and more so than the original documentation could claim. Phase 3's prerequisite is
that it adds constraints to a `Commitment` table this migration creates — and that table has
now been created by executed DDL, its HARD-only CHECK has been shown to reject a `SOFT` row on
both insert and update, and its RESTRICT foreign keys have been shown to fire. Both
`Agent.authorityEpoch` and `Agent.fenceCounter` exist as `bigint NOT NULL DEFAULT 0` and are
proven to survive a backfill re-run, which is what Phase 3's fence allocation will build on.
`Leg.version`, `Leg.cancelRequestedAt`, `Leg.purpose` and `Leg.state` — guards G4, G5, G6 —
are present with the semantics Phase 3 needs.

The one recommendation both earlier documents made as a precondition for Phase 3 has been
satisfied. No blocking Phase 2 requirement remains unresolved.

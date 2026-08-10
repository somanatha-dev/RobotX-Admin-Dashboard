# Phase 2 — Independent Architecture Verification Report

> ## ⚠️ SUPERSEDED IN PART — read `PHASE_2_REMEDIATION_AND_CLOSURE.md` first
>
> **Final Phase 2 status (2026-08-10): CLOSED WITH DOCUMENTED ENVIRONMENTAL LIMITATION.**
>
> This report is preserved verbatim. Its verdict — **PASS WITH MINOR ISSUES** — was correct on
> the evidence available, and its Part 13 issue #1 named exactly the right condition for Phase 3.
> That condition has now been met, and meeting it proved the report's own caution justified.
>
> | Part 13 issue | Final status |
> |---|---|
> | #1 Migration never executed against a live PostgreSQL | ✅ **DISCHARGED.** Disposable PostgreSQL 18.3; 21/21 migrations; 49/49 behavioural checks; legacy data md5-identical; `prisma migrate diff` shows **no Phase 2 object drifts** |
> | #2 Schema line-count understated (~640 vs 879) | ⚠️ **NO LONGER INDEPENDENTLY CHECKABLE** — Phase 2 entered git history inside `cf9103f` together with Phases 3–5, so no Phase-2-only delta exists to measure. The substantive claim (zero deletions) re-confirmed as 0 |
> | #3 `Agent`-as-a-table remains an interpretive reading | ⚠️ **VERIFIED / NO DEFECT** — live evidence now supports the reading (`Agent_robotDbId_key` enforces the 1:1; CASCADE fires; `Robot` gained no column), but it is still a reading, not a spec-stated fact |
>
> **Two defects this review could not have found were found by execution.** Part 6 credited the
> backfill's spatial mirror as PASS on a structural reading. Against a real database it wrote
> **nothing at all** — an unknown-argument failure from Phase 15's `indexing` field, and a
> foreign-key violation from writing logical map ids into surrogate-key columns. Both are fixed
> and regression-tested. The review's Part 6 reasoning was sound; the in-memory test double it
> reasoned about was not faithful, exactly as the implementation report's §18 warned.
>
> **One new finding is out of Phase 2's scope:** `ConfigActiveVersion_version_fkey` exists in
> Phase 1's migration but not in `schema.prisma` — the only schema drift in the repository.
> Documented, not fixed; Phase 1 owns it. See remediation §8.
>
> Every test, suite, and gate count below is Phase-2-era; see remediation §10 for current figures.

**Verifier role:** Independent Architecture Verification Engineer (did not implement Phase 2)
**Date:** 2026-07-29 · **Branch:** `feature/dashboard` · **Working tree at verification:** `4244b3d` + uncommitted Phase 2 changes
**Method:** Evidence re-derived from spec text, code execution, and byte-level diffs. The
implementation report was not trusted for any claim reported here as PASS. Every claim below is
backed by a command, a diff, or a spec quotation reproduced during this review. Where a report
claim could not be independently reproduced (live-database execution), it is reported as such and
not credited as verified.

---

## 0. Scope discipline

This review covers Phase 2 only: `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §2, §3.6, §4.1–§4.3,
§10.3 (Commitment schema only, not the commit transaction), §15 (payload schema only), §21.2
(skeleton only), §25 (Agent extensibility), against `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE
2" and its §7 Phase 2 checklist. No Phase 3+ mechanism (commit transaction, guards, fencing logic,
leases, outbox) is in scope, and none was found in the diff — confirmed in Part 9.

---

## PART 1 — Phase 2 checklist (`IMPLEMENTATION_EXECUTION_PLAN.md` §7)

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | Migration (a): `Agent` — 8 fields | **PASS** | `agentId`, `robotDbId`, `fleetId`, `tenantId`, `agentClassId`, `regionId`, `homeDepotId`, `lifecycleState`, `authorityEpoch` BIGINT, `fenceCounter` BIGINT, `capacityOverride` all present in `schema.prisma` and `migration.sql`; both counters `BIGINT NOT NULL DEFAULT 0`, confirmed by direct read of the migration SQL |
| 2 | Migration (b): `AgentClass`, `MobilityModel`, `EnergyModel`, `ContainerModel`, `Compartment`, `CapabilityBundle`, `Capability` | **PASS** | All seven tables present; `Compartment` carries `apertureWidthMm`/`apertureHeightMm` as columns distinct from `internalLengthMm`/`internalWidthMm`/`internalHeightMm` — aperture modelled separately from internal dimension per §15.2, confirmed by direct column read |
| 3 | Migration (c): `Mission`, `Leg`, `Stop` | **PASS** | `Leg.purpose` (`LegPurpose` enum, `NOT NULL`, no default), `state` (`LegState`, default `QUEUED`), `custodyState` (`CustodyState`, default `NONE`), `version` (`INTEGER`, default 0) all present; `cancelRequestedAt` present for guard G5 |
| 4 | Migration (d): `Commitment` with HARD-only CHECK | **PASS** | All nine §2.6 fields present by name (`commitmentId`, `agentId`, `legId`, `fence`, `leaseExpiry`, `custodyState`, `planSnapshotRef`, `decisionRef`, `version`); `CHECK ("kind" = 'HARD')` present verbatim in migration.sql line 752–753 |
| 5 | Migration (e): `PayloadSpec`, `PayloadManifest` | **PASS** | Counted the columns against §15.1's own attribute list by hand: mass (with `massToleranceKg`), dimensions, `shapeClass`, `volumeLitres`, `orientationConstraints`, `stackable`, `loadBearingLimitKg`, `fragilityClass`, thermal (min/max/max-excursion), `securityClass`, `hazardClasses`, `segregationRules`, `declaredValue`, `regulatoryClass`, `itemCount`, `divisible` — twelve substantive attributes plus mass tolerance, matches |
| 6 | Migration (f): `Region`, `Site`, `Zone.regionId`, `CellAssignment` | **PASS** | All four present; `Zone.regionId` is nullable with no default (confirmed in schema diff), consistent with "existing zones carry no region until a region map is published" |
| 7 | Migration (g): `Observation` append-only | **PASS** | All six §2.7 fields present (`value`, `observedAt`, `receivedAt`, `source`, `confidence`/`variance`, `sequence`) plus `deadReckoned`/`uncertaintyRadiusM`; `BEFORE UPDATE` trigger `Observation_append_only` present and independently confirmed to `RAISE EXCEPTION` unconditionally in its function body (migration.sql lines 763–773) |
| 8 | Migration (h): `DecisionRecordA` skeleton | **PASS** | 19 columns spanning identity, versions, trigger, snapshot refs, outcome, cost, rejection, search bounds, degradation, deferral, overrides, predictions — a reasonable reading of "every §21.2 Tier A section as a column"; `BEFORE UPDATE` immutability trigger present and unconditional |
| 9 | Migration (i): five new enums; `TaskStatus` extended per §4.2 | **PASS, plan defect correctly resolved per the plan's own precedence rule** | `LifecycleState`, `LegPurpose`, `LegState`, `CustodyState`, `ObstructionClass` all present and each enum's value set matches its §-table exactly, checked value-by-value against the spec text read in Part 0 of this review (§2.1, §2.4, §4.3, §2.5). `TaskStatus`: independently re-read §4.2's table (11 states) against the legacy enum (6 states: `PENDING, ASSIGNED, IN_PROGRESS, COMPLETED, FAILED, CANCELLED`) — three of the eleven (`COMPLETED`, `FAILED`, `CANCELLED`) already existed, eight did not (`RECEIVED, REJECTED, PLANNABLE, WAITING, IN_EXECUTION, AT_RISK, SUSPENDED, VERIFYING`), and all eight are the values actually added by `ALTER TYPE … ADD VALUE` in the migration (verified by direct read, migration.sql lines 39–46). The plan's own §0.1 precedence rule ("where this plan and the specification appear to disagree, the specification wins") makes this the correct resolution, not a scope overrun |
| 10 | Domain modules ×7 | **PASS** | `agent.js`, `custody.js`, `capability.js`, `work.js`, `purpose.js`, `mobilityModel.js`, `observation.js` all present, all read in full during this review, each checked clause-by-clause against its cited §. No invented vocabulary found in any of the seven; every enum/table matches its §-source in both directions (spec→code and code→spec) |
| 11 | `spatial/hierarchy.js` — containment by published assignment | **PASS** | `resolve(cellId)` takes exactly one argument (confirmed by direct read of the function signature, `spatial/hierarchy.js:110`); no coordinate parameter exists anywhere in the module. `validate()` independently re-read and confirmed to enforce both §3.6 rules (a zone never spans a region; a fine cell maps to exactly one zone and at most one site) |
| 12 | Legacy mappers for dual-read | **PASS** | `mappers/legacyRobot.js` and `mappers/legacyTask.js` read in full. `robotToAgent`/`taskToWork` produce deterministic UUID-shaped ids via SHA-256 + RFC 4122 version/variant nibble fix-up (independently traced through the byte manipulation, lines 67–90 of `legacyRobot.js` — correct); `Robot.status` is never referenced by `robotToAgent` (grepped: not present), confirming the lifecycle/status separation claim |
| 13 | `tools/migrate/backfillDomain.js` (idempotent) | **PASS** | Read in full. Idempotency mechanism confirmed structurally: `Agent` upsert's `update` branch excludes `authorityEpoch`/`fenceCounter`; `Leg` upsert's `update` branch excludes `state`/`custodyState`/`version` (lines 110–116, 200–208) — exactly the fields the report claims are protected, confirmed by direct code read, not by trusting the report's prose |
| 14 | Validate: zone never spans a region; fine cell → one zone, ≤ one site | **PASS** | Both rules present in `spatial/hierarchy.js` `validate()`, independently re-read; separately, `spatial/cells.js` `validateAssignment()` enforces the fine-cell-must-name-a-zone rule per-row |
| 15 | Tests: forward/rollback, idempotency, round-trip, FK integrity | **PARTIAL — matches the report's own disclosure** | Idempotency, round-trip, and FK-integrity tests exist and pass (independently re-run, see Part 1 test evidence below). Forward/rollback against a live PostgreSQL was **not** independently executable in this review either — same environment constraint the implementation report records (local Postgres on 5432 rejects on-file credentials; `DATABASE_URL` points at a shared Neon instance not appropriate for DDL testing). This is an honestly disclosed gap, not a concealed one |
| 16 | **Gate:** 100% converted, zero orphans; endpoints behaviourally unchanged | **PASS** | Backfill's `verify()` performs six counted (not sampled) checks, confirmed by direct read; endpoint behavioural-equivalence confirmed independently in Part 8 |

**Checklist result: 16/16 substantively PASS.** Item 15 carries the same disclosed, unresolved
residual-risk gap (no live-database execution) the report itself states in its §14.3 and §17.1 —
this review did not discharge it either, and says so rather than crediting it.

### Test suite — independently re-run, not trusted from the report

```
$ npm run verify
gate: tier-dependencies (§1.8 rule 2)   PASS — 89 module(s), 30 governed import edge(s), no Tier 0/1 → Tier 2 dependency.
gate: parameter-register (§22, Appendix A)  PASS — 23 engine module(s) checked against 148 registered parameter(s); no bare behavioural constants.
gate: tenets (T1 type separation, T6 decision-path determinism)  PASS — 86 module(s) checked, no violations.
Test Suites: 42 passed, 42 total
Tests:       668 passed, 668 total
```

Every number here (89 modules/30 edges, 23 modules/148 parameters, 86 modules, 42/668) matches
the implementation report exactly and was reproduced by this reviewer's own `npm run verify`
invocation, not copied from the report.

```
$ npx jest --selectProjects legacy --runInBand --forceExit
Test Suites: 22 passed, 22 total
Tests:       169 passed, 169 total
```

Legacy lane isolated and re-run: 22/169, matching the report's claimed "unchanged from Phase 0/1
baseline." `git diff --stat -- tests/unit tests/integration` returns empty — **no legacy test
file was touched**, which is the stronger claim underneath "unchanged": not merely the same
counts, but the identical files.

Per-file test counts spot-checked against the report's table: `domainModel.test.js` 57 (report:
57, match), `domainBackfill.test.js` 32 (match), `spatialHierarchy.test.js` 23 (match).
`domainSchema.test.js` shows 27 static `test(`/`it(` call sites but **64 when actually run**
(`test.each` over a table-name array) — re-run in isolation and confirmed 64/64 passed, matching
the report. This is noted because a static grep alone would have under-counted and produced a
false PARTIAL; running the file is what resolves it.

---

## PART 2 — Completion criteria (`IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 2")

| Criterion | Verdict | Evidence |
|---|---|---|
| Schema matches §2 and §3.6 | **PASS** | Every enum's value set independently re-checked against its §-table (Part 1 item 9, Part 3). No enum value exists in code with no §-defined meaning, and no §-defined value is missing from any enum |
| Backfill converts 100% of existing rows with zero orphans | **PASS (mechanism verified; not executed against live data)** | `verify()`'s six checks are structurally sound and each traces to a specific orphan class the plan/spec name. Not run against a real database in this review, same constraint as Part 1 item 15 |
| `purpose`, `custodyState`, `authority_epoch`, `fence_counter` present and defaulted | **PASS** | `purpose LegPurpose NOT NULL` with **no default** (confirmed — a Leg with no stated purpose cannot be created, matching "set at creation, never mutated" and never silently defaulted); `custodyState` defaults `NONE`; both fencing counters `BIGINT NOT NULL DEFAULT 0` |
| Spatial containment validator (§22.1) passes on seeded region/zone/cell maps | **PASS** | `SEED_SPATIAL_MAP` in `prisma/seed.js` read directly: two zones, one site, five cell assignments (4 fine + 1 coarse), all correctly attributed to one region. `spatialHierarchy.test.js` independently re-run and confirmed to call the actual `validateCandidate` from Phase 1's `config/validators.js` (not a reimplementation) — grepped the import path to confirm it is the real module, not a stub |
| Legacy endpoints unchanged in behaviour | **PASS** | See Part 8 |

**Result: 5/5 substantively PASS**, one (backfill orphan-freedom) verified at the mechanism level
only, matching the report's own disclosed limitation.

---

## PART 3 — Domain model

Every entity independently checked against §2's own tables, in both directions (an entity in code
with no spec source, and a spec entity missing from code, would both be findings; neither was
found).

| Entity | Ownership | Fields/relationships | Identifiers | Lifecycle | Invariants | Verdict |
|---|---|---|---|---|---|---|
| `Agent` (§2.1) | New table, 1:1 to `Robot` via `robotDbId` | 8 facets present as columns/relations; `Agent.robot` back-relation nullable | `agentId` unique, seeded from `Robot.robotId` | `lifecycleState` enum, separate from `Robot.status` — confirmed by grep that no mapper reads `Robot.status` into `Agent.lifecycleState` | Two fencing counters, both `BIGINT DEFAULT 0`, monotone by convention (enforced structurally in Phase 3, not yet writable in Phase 2 since nothing writes `Commitment`) | **PASS** |
| `AgentClass`/`MobilityModel`/`EnergyModel`/`ContainerModel`/`Compartment`/`CapabilityBundle`/`Capability` (§2.1–§2.3, §15.2) | New tables | All present; `Capability.kind` restricted to the five §2.3 kinds by `domain/capability.js`, not by a DB enum (a disclosed, reasoned choice — Part 1 item 9's five-enum ceiling is honoured) | Unique `classId`/`modelId`/`bundleId` per table | N/A | `custody_transfer_capable` default-false path confirmed live: `DEFAULT_FALSE_CAPABILITIES` in `capability.js` names exactly this one capability | **PASS** |
| `Mission`/`Leg`/`Stop` (§2.4) | New tables | `Leg.purpose` required, `state`/`custodyState` defaulted, `version` for optimistic concurrency | `missionId`/`legId`/`stopId` unique | §4.2/§4.3 vocabularies present as enums (Task) and enum+string (Leg/Stop) | `Leg` unique on `(missionId, sequence)`; `Stop` unique on `(legId, sequence)` — both confirmed present, enforcing "no two Legs/Stops at the same position" at the DB level, not only in application code | **PASS** |
| `Commitment` (§2.6) | New table | All 9 fields | `commitmentId` unique | N/A (Phase 3) | `CHECK (kind = 'HARD')` confirmed present and correctly worded; **nothing writes this table** — confirmed by grepping `prisma.commitment.(create\|upsert\|update)` across `src/` and `tools/`: zero matches outside the table definition itself | **PASS** |
| `Observation` (§2.7) | New table | All 6 core fields + dead-reckoning provenance | none (append-only log) | Append-only enforced by trigger | Trigger unconditionally raises on `UPDATE`; `DELETE` deliberately unguarded — a real asymmetry, correctly stated as deliberate in both the schema comment and the migration comment, not silently inconsistent | **PASS** |
| `Region`/`Site`/`CellAssignment` (§3.6) | New tables | Full containment chain | `regionId`/`siteId` unique; `CellAssignment` unique on `(cellId, mapVersion)` | N/A | Containment-by-assignment enforced in `spatial/hierarchy.js`, not by geometry — confirmed no lat/lon field is read by `resolve()` | **PASS** |

**No invented entities, no missing entities, no architectural drift found.** The one interpretive
choice worth flagging on its own (Part 6) is Agent-as-a-table versus Agent-as-columns-on-Robot,
which the report itself surfaces as its "single most consequential reading" and defends with a
textual argument from the plan's own inconsistent phrasing between groups (a) and (f). This
reviewer finds that argument sound: it is the only reading under which the backfill is a genuine
*conversion* rather than a no-op, and it is what keeps `Robot` byte-for-byte authoritative for the
legacy dispatcher, which is the phase's own compatibility requirement.

---

## PART 4 — Database

### Independent regeneration of Prisma's own SQL (the report's central technical claim)

The report claims: *"Every `CREATE TABLE`, `CREATE INDEX`, and `ADD CONSTRAINT` below is Prisma's
own generated SQL … taken verbatim."* This was re-derived from scratch rather than trusted:

```
$ npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
```

This regenerates the full current-schema SQL independently of any file the implementation wrote.
Extracting the `CREATE TABLE` block for each of the 19 Phase 2 tables (`Region`, `Site`,
`CellAssignment`, `MobilityModel`, `EnergyModel`, `ContainerModel`, `Compartment`,
`CapabilityBundle`, `Capability`, `AgentClass`, `Agent`, `PayloadSpec`, `PayloadManifest`,
`Mission`, `Leg`, `Stop`, `Commitment`, `Observation`, `DecisionRecordA`, `_MissionToTask`) from
this fresh generation and comparing column-for-column against `migration.sql` found **byte-for-
byte identity on every table**. A second pass comparing every `CREATE INDEX` and
`AddForeignKey` statement (sorted, diffed) found the migration's set is a strict match against
the freshly generated set, with the only "extra" lines in the migration being the hand-written
`CHECK` constraint and the two triggers — exactly the four hand-written additions the migration's
own header comment discloses (§4.2's 8 `ALTER TYPE` statements, 2 `ALTER TABLE` blocks, 1 `CHECK`,
2 triggers). `prisma validate` also passes clean.

**This independently confirms the report's strongest and most checkable claim.** It is not a
weaker corroboration of the report's own `domainSchema.test.js` — it is a second, differently-
sourced computation (this reviewer's own terminal invocation, not the shipped test file) that
lands on the same answer.

### Additivity

```
$ git diff --stat prisma/schema.prisma
 Backend/prisma/schema.prisma | 879 +++++++++++++++++++++++++++++++++++++++++++
 1 file changed, 879 insertions(+)
$ git diff prisma/schema.prisma | grep -c '^-[^-]'
0
```

Zero lines removed, confirmed directly — not by re-running the report's test, by running `git
diff` myself. **One discrepancy found**: the report's §4 states "+~640 lines"; the actual diff is
**879 insertions**, a ~37% understatement. This is a **documentation-accuracy defect**, not a
functional one — the substantive claim ("zero lines removed") is exactly correct, and every
change in the extra ~239 lines is accounted for elsewhere in this review (comments, the additional
models). Recorded as a minor finding in Part 13, not as grounds for FAIL.

### Constraints, indexes, foreign keys

Referential integrity table (report §5.3) independently re-verified line-by-line against
`migration.sql`'s `AddForeignKey` section:

- `Agent → Robot`: **CASCADE** ✓ (line 691)
- `Commitment → Agent`, `Commitment → Leg`: **RESTRICT** ✓ (lines 724, 727)
- `Leg → Mission`, `Stop → Leg`, `Compartment → ContainerModel`, `Capability → CapabilityBundle`, `Observation → Agent`, `PayloadManifest → Leg`: **CASCADE** ✓ (all confirmed)
- `Site → Region`, `CellAssignment → Region`: **RESTRICT** ✓ (lines 658, 661)
- `Zone → Region`, `Agent → Region/Site/AgentClass`, `Stop → Site`, `Task → PayloadSpec`: **SET NULL** ✓ (all confirmed)

Every relationship in the report's table matches the actual `ON DELETE` clause in the migration,
with no exceptions found.

**Verdict: PASS.**

---

## PART 5 — Migration safety

- **Additive changes:** all `CREATE TABLE`/`CREATE INDEX`/`ADD CONSTRAINT`/`ALTER TYPE … ADD
  VALUE` — confirmed exhaustively; no other statement kind appears in the file (grepped for
  `DROP|RENAME|ALTER COLUMN` — zero matches).
- **Destructive changes:** none found.
- **Rollback safety:** the migration carries no `down` migration, consistent with this repo's
  forward-only convention (confirmed: no other migration directory in `prisma/migrations/`
  carries one either). The stated rollback path — "an unapplied Phase 2 leaves the legacy
  dispatcher operating on exactly the rows it operated on before" — is consistent with the
  additive-only property and with the confirmed-empty diff on every legacy-path file (Part 9).
- **Preservation of existing production data:** every added column on `Zone` and `Task` is
  nullable with no default requiring backfill; the eight new `TaskStatus` enum values are added
  but never written by any code path in this diff (confirmed by grep — see Part 1 item 16 and
  Part 8).
- **Migration ordering:** enums → tables → altered tables → indexes → foreign keys → backstops,
  confirmed by reading the file top to bottom; every unique index a foreign key depends on
  (`CellAssignment_cellId_mapVersion_key`, etc.) precedes its dependent FK in the file.
- **PostgreSQL version constraint:** the header correctly notes multi-value `ALTER TYPE … ADD
  VALUE` requires PG ≥ 12 and that none of the new values is used within the same migration
  (both true — confirmed no `INSERT`/`UPDATE` statement in the file references any of the eight
  new `TaskStatus` values).
- **Idempotency:** N/A at the DDL level (a Prisma migration is not designed to be re-run); the
  relevant idempotency claim is the backfill's, covered in Part 6.

**Where data loss is possible:** none identified in this migration. The only residual risk is the
disclosed one — this migration has not been executed against a live PostgreSQL instance by
anyone, implementer or verifier, so the automated statement-equivalence check (Part 4) is strong
static evidence but is not proof the DDL runs clean end-to-end (e.g., trigger function syntax,
enum-in-transaction behavior on the actual target PG version). This is the same gap the report
discloses in its own §17.1 item 1 and does not attempt to hide.

**Verdict: PASS**, with the live-execution gap carried forward as an open item (see Part 13).

---

## PART 6 — Backfill

`tools/migrate/backfillDomain.js` read in full; every claim checked against the actual code, not
the report's prose.

- **Deterministic behaviour:** `deterministicId()` in `legacyRobot.js` derives every id from
  `SHA-256(namespace + " " + key)`, truncated and RFC-4122-shaped — no `Date.now()`, no
  `Math.random()`, no `crypto.randomUUID()` anywhere in the backfill's write path (grepped: zero
  matches in `tools/migrate/` and the two mapper files). Four distinct namespaces
  (`ID_NAMESPACE.AGENT/MISSION/LEG/STOP`) rule out cross-entity collision by construction.
- **Completeness:** `verify()` performs six counted checks covering every orphan class the plan
  and spec name (unprojected Robot, Agent without Robot, undecomposed Task, Mission without Leg,
  Leg without Stop, non-`PRIMARY` backfilled Leg). All six use `prisma.count()`, not sampling.
- **Idempotency — verified structurally, not just asserted:** `backfillAgents`'s `upsert.update`
  branch (lines 110–116) sends only `agentId, robotDbId, agentClassId, regionId, homeDepotId` —
  `authorityEpoch`/`fenceCounter` are absent from the object literal, so a re-run cannot touch
  them regardless of what a test does or doesn't check. Same pattern independently confirmed for
  `backfillWork`'s `Leg` upsert (lines 200–208): `state`, `custodyState`, `version` absent from
  `update`. This is a stronger form of verification than re-running the shipped test, because it
  rules out the failure mode where a passing test coincidentally doesn't exercise the excluded-
  field path.
- **Handling of missing data:** `resolveRegionId()` never infers a region from geometry; it uses
  an explicit region, the sole declared region, or `null` — confirmed to match §3.6's rule against
  inferring containment.
- **Handling of legacy rows:** `legacyStatusToLegState()` maps every one of the six legacy
  `TaskStatus` values to a specific §4.3 Leg state, with an explicit fallback to `QUEUED` (not a
  terminal state) for any unrecognised value — checked against T2 ("unknown is never permission")
  and found consistent: an unrecognized status does not silently close out work.
- **Replay compatibility:** the job processes rows in `orderBy: { id: "asc" }` cursor order on
  both entity types, confirmed identical between the two backfill functions, which is what makes
  two runs process rows in the same sequence.
- **Structural property enforced at write time, not only in a test:** `backfillWork` calls
  `isPointToPointMission()` on every constructed Mission and **throws** if it does not hold
  (lines 174–179) — this is a stronger guarantee than a passing test, because it means a
  non-conforming Mission cannot be silently written in production even if a future code change
  broke the invariant and no test caught it.

**Verdict: PASS.** No commitment row is written (grep-confirmed, Part 3), consistent with the
report's and this review's understanding that fabricating one from `Robot.currentTaskId` would be
exactly the unfenced binding Phase 3 exists to replace.

---

## PART 7 — Architecture compliance

| Check | Verdict | Evidence |
|---|---|---|
| Layering / module placement | **PASS** | `domain/` and `spatial/` are the only two new runtime directories; `gate:tiers` re-run independently, PASS, 89 modules / 30 edges, matching report |
| Ownership | **PASS** | Every new module traces to exactly one §; no module claims ownership of a mechanism outside Phase 2's stated scope (checked each module's header comment against its own code — no module implements commit logic, dispatch, or feasibility evaluation, all of which correctly `throw`/defer to later phases where touched at all) |
| Dependency direction | **PASS** | `domain/work.js` depends on `domain/custody.js` and `domain/purpose.js` (both Tier 0/1 peers); no Phase 2 module imports anything from a not-yet-built `commitment/`, `feasibility/`, or `dispatch/` directory (those directories do not exist yet, confirmed by `ls src/engine/`) |
| Tier compliance | **PASS** | `gate:tiers` re-run clean; `custody.js` self-declares "Tier 0, mechanism T0-07" in its header, consistent with the invariants it exists to serve (I7, I8) |
| Invariant compliance | **PASS, appropriately partial** | Invariants I7/I8 (custody) and I18 (HARD-only) have their **vocabulary and schema backstop** landed; the invariants themselves are not yet *enforced end-to-end* because nothing writes `Commitment` or transitions custody yet — this is correct for Phase 2's scope, not a gap in it |
| ADR compliance | N/A this phase | No ADR is specifically implicated by a pure schema/vocabulary phase; none checked as violated |
| No architecture drift | **PASS** | `phase0Scaffold.test.js`'s widened assertion (`LANDED_PHASE_OWNED` = Phase 1 ∪ Phase 2 owned paths) re-run and passed; independently walked `src/engine/` by hand and found no runtime file outside `config/`, `cost/units.js`, `cost/exchangeRates.js`, `determinism/`, `domain/`, `spatial/`, `guards/` |

**Verdict: PASS.**

---

## PART 8 — API review

- **Routes:** `git diff --stat -- src/routes` — no route file touched (confirmed empty diff on
  the routes directory as part of the broader untouched-paths check in Part 9).
- **Validation:** no new validation surface added; the two controller diffs (below) add no new
  input-validated field.
- **Compatibility:** `robots.controller.js`'s `commissionRobotWithPairing` now also calls
  `ensureAgentForRobot` in a `try/catch` that only logs on failure — the HTTP response path is
  untouched by this addition (confirmed: the added block sits between two pre-existing statements
  and does not touch `res`). `tasks.controller.js`'s `cancelTask` widens its terminal-status guard
  from `{COMPLETED, FAILED, CANCELLED}` to `{COMPLETED, FAILED, CANCELLED, REJECTED}` — confirmed
  by direct diff read, and confirmed **inert**: `grep -rn "REJECTED" src/` shows `REJECTED` is
  referenced only in this guard and in `domain/work.js`'s vocabulary table — no writer of
  `Task.status = REJECTED` exists anywhere in `src/`.
- **Request/response models:** unchanged. `readAgentProjection`/`toAgentProjection`/
  `toWorkProjection` are defined and exported but **not called by any controller** — confirmed by
  grepping their usage sites across `src/`: the only call sites are within `robot.service.js`
  itself (self-referential export) and the test suite. No HTTP handler reads them.
- **Authorization:** unchanged; no new route means no new authorization surface.
- **Error handling:** the new `ensureAgentForRobot` call in the pairing controller is
  intentionally best-effort (caught and logged, not re-thrown) — confirmed this cannot turn a
  previously-200 response into a non-200 response, which is the compatibility property claimed.

**Verdict: PASS.** No externally observable API change found.

---

## PART 9 — Regression review

Independently re-ran, rather than trusted, the report's "not modified" claim:

```
$ git diff --stat -- src/sockets/ src/cache/ src/simulation/ \
    src/services/commandDispatcher.service.js src/services/task.service.js \
    src/services/taskAssignment.service.js src/services/costEvaluator.service.js \
    src/services/robotValidator.service.js src/services/taskRecovery.service.js \
    tests/unit tests/integration
(empty)
```

Every one of these paths — legacy assignment (`taskAssignment.service.js`, `task.service.js`),
cost evaluation, feasibility (`robotValidator.service.js`), task recovery, Redis (`src/cache/`),
Socket.IO (`src/sockets/`), the simulator (`src/simulation/`), and every legacy test file — is
byte-for-byte untouched. This is a stronger and more directly falsifiable check than counting
test totals, and it independently corroborates the report's §4 "Not modified" list and §9/§10's
"None written"/"None" claims for Redis and Socket.IO.

Additionally grepped the two genuinely new modules (`src/engine/domain/**`,
`src/engine/spatial/**`) and the backfill tool for any KV-cache or socket import — zero matches,
confirming no Redis key is written and no socket event is touched by the new code, not only that
the old files are unchanged.

Authentication, benchmarks, and existing APIs: no file under `src/middlewares/`, `benchmark/`, or
`src/routes/` appears in `git diff --stat` for the full repo (confirmed by the broader `git
status` at the top of this session — only the files listed in Part 1/9 above are touched).

**Verdict: PASS. No regression surface found.**

---

## PART 10 — Build gates

| Gate | Verdict | Evidence |
|---|---|---|
| Tier gate | **PASS** | Re-run independently: 89 modules, 30 governed edges, 0 forbidden Tier 0/1→Tier 2 dependencies |
| Parameter gate | **PASS** | Re-run independently: 23 modules / 148 parameters, no bare behavioural constants. The report's own §15.2 records that this gate **caught a real violation during implementation** (a bare `16` hex radix in `legacyRobot.js`, subsequently annotated `@structural`) — this reviewer independently confirms the `@structural` annotation is present and its stated reason (hex encoding, not a threshold) is accurate on inspection of the actual code (`legacyRobot.js` line 84) |
| Tenet gate | **PASS** | Re-run independently: 86 modules, 0 violations (T1 type separation, T6 decision-path determinism) |
| Intentional violations still fail | **Not independently re-tested this session** | This reviewer did not plant a fresh violation to re-confirm gate sensitivity (Phase 1's verification report already did this for the same gate machinery and found it functioning; Phase 2 changes no gate logic itself — `git diff --stat -- tools/gates src/engine/guards` is empty, confirming the gates themselves are unmodified this phase). Carried forward as adequately covered rather than re-verified from scratch |

**Verdict: PASS.**

---

## PART 11 — Phase 1 follow-up

The report's §17.2 carries forward five items explicitly scoped to Safety/Tech-lead/Ops/other
phases (combined-conservatism V9 finding, kill-switch discrepancy, calibration-owner naming,
unset register values, two Phase 1 implementation bugs). None of these blocks Phase 2 and Phase 2
does not attempt to fix them — confirmed correct: none is a Phase 2 completion criterion, and
fixing any of them would be scope creep this review does not require. `git diff --stat` confirms
no file under `src/engine/config/` (Phase 1's territory) is touched by this diff, so Phase 2
could not have silently "fixed" or altered them either way.

**Verdict: PASS — correctly deferred, nothing improperly required of Phase 2.**

---

## PART 12 — Code quality

- **Duplicated logic:** none found. `custodial_purposes`/`speculative_purposes` are derived once
  from `purpose.js`'s own table (confirmed: `CUSTODIAL_PURPOSES` is a `.filter()` over
  `PURPOSE_NAMES`, not a second hand-maintained list) — this is a genuine anti-duplication pattern
  applied consistently across the module (same technique in `work.js` for
  `nonTerminalLegStatesWithoutDeadline()`).
- **Dead code:** `toWorkProjection` and `readAgentProjection` are unused outside tests today
  (Part 8) — this is disclosed by the report itself as intentional (read models for Phase 3+
  consumers), not concealed dead code, so this reviewer does not flag it as a defect, only notes
  it for the record.
- **Incorrect ownership:** none found; every module's stated tier/owner in its header comment
  matches its actual dependency graph (Part 7).
- **Inconsistent naming:** the specification's snake_case (`authority_epoch`, `fence_counter`) is
  consistently rendered as camelCase (`authorityEpoch`, `fenceCounter`) throughout schema and
  code, and this mapping is explicitly documented in the schema's own header comment rather than
  left for a reader to infer — correct practice, not a defect.
- **Incomplete migration:** none found within Phase 2's own scope; what Phase 2 does not do
  (write `Commitment`, enforce custody transitions, run the commit transaction) is explicitly
  Phase 3+'s work and is documented as such in the code's own comments, not silently absent.
- **Unnecessary complexity:** the `Agent`-as-a-table decision (assumption 1) is the one place this
  reviewer would flag as adding structural weight (a 1:1 join rather than columns) — but per Part
  3, the alternative reading is textually weaker and operationally worse for the strangler
  pattern, so this is a justified complexity, not an unnecessary one.

**One documentation-accuracy defect found** (Part 4): the report's stated schema line-delta
(~640) undercounts the actual diff (879) by roughly 37%. Immaterial to correctness — the
substantive claim (zero deletions) is exact — but the report should not present an approximate
count with unwarranted precision in the same paragraph where it makes a "removes zero lines"
claim that is exact.

---

## PART 13 — Final decision

# PASS WITH MINOR ISSUES

| # | Issue | Classification | Detail |
|---|---|---|---|
| 1 | Migration not executed against a live PostgreSQL instance | **Migration** (carried forward, not new) | Neither the implementer nor this reviewer could reach a usable local Postgres or was willing to run DDL against the shared Neon instance. Mitigated to the extent statically possible: `prisma validate` clean, and this reviewer independently regenerated Prisma's own SQL and confirmed byte-for-byte agreement with the migration for every table, index, and foreign key (Part 4) — materially stronger mitigation than a documentation claim, but not equivalent to execution. **Recommendation unchanged from the report: apply Phases 1 and 2 to a production-shaped dump before Phase 3**, since Phase 3 adds constraints to a table (`Commitment`) this migration creates |
| 2 | Schema line-count in the report (§4) is understated by ~37% (~640 claimed vs. 879 actual) | **Documentation** | No functional impact — verified independently that zero lines are removed either way. Correct the figure or remove the approximation in the next report |
| 3 | `Agent`-as-a-table vs. columns-on-`Robot` remains an interpretive reading of an ambiguous plan phrasing | **Architecture ambiguity** (carried forward from the report's own disclosure, not newly found) | This reviewer's independent reading agrees with the report's reading and finds it the more defensible one (Part 3), but it is still a reading, not a spec-stated fact, and the report is correct to flag it as the single most consequential assumption in the phase |

None of the three issues blocks correctness of what shipped, and none represents an undisclosed
risk — all three are either already stated in the implementation report or are refinements of
claims the report already qualified. This review found **no case** where the implementation
report's PASS claim could not be independently reproduced, and **no case** of a claim that
overstated what the code actually does.

**Phase 3 may begin**, subject to the same condition the implementation report itself states as
"strongly recommended first": discharge issue #1 (apply Phases 1–2 to a production-shaped
database dump) before Phase 3 adds constraints to the `Commitment` table this migration creates.
That condition is a recommendation carried forward from the report, not a new blocking finding
from this review — this review did not find a reason to make it stronger than the report already
does.

---

## Appendix — Commands run for this verification (reproducible)

```
git diff --stat prisma/schema.prisma
git diff prisma/schema.prisma | grep -c '^-[^-]'
npx prisma validate
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
npm run verify
npx jest --selectProjects legacy --runInBand --forceExit
npx jest tests/engine/domainSchema.test.js --selectProjects engine --verbose
git diff --stat -- src/sockets/ src/cache/ src/simulation/ \
  src/services/commandDispatcher.service.js src/services/task.service.js \
  src/services/taskAssignment.service.js src/services/costEvaluator.service.js \
  src/services/robotValidator.service.js src/services/taskRecovery.service.js \
  tests/unit tests/integration
git diff --stat src/controllers/tasks.controller.js src/controllers/robots.controller.js
git diff --stat src/services/robot.service.js
grep -rn "toWorkProjection|readAgentProjection|toAgentProjection" src/ --include="*.js"
grep -rn "\"REJECTED\"|'REJECTED'" src/ --include="*.js"
grep -rniE "require\(.*(cache/kv|ioredis|socket)" src/engine/domain src/engine/spatial tools/migrate
```

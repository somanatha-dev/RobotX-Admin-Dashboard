# Phase 15 — B1 prerequisite adversarial pass

**Date:** 2026-08-28 · **Branch:** `feature/dashboard` · **Baseline commit:** `3f0e522`
**Digest before:** `72f943df83416c7317b107a903efedee1863459ea3839ccd2b016a69e43e8c81` (565 files)
**Digest after:** `d9fdb79a164a1664ce5b80b7f6aed6f2cc70647f054844fa43edb1a3d6f6ff80` (565 files)

**Mandate:** find repository-owned defects that would still be waiting underneath B1 when its
external decisions arrive. Not to make Phase 15 green.

---

## 0. Verdict

# B1 — STILL EXTERNAL / BLOCKED.

No engine was selected, ranked, recommended or hinted at. No D1 region, D3 speed model or D8
vintage was invented. No threshold moved, no `NOT_EVALUATED` became `PASS`, no gate was
weakened, no fake router was written, `DEGRADED_ROUTING` was not used as a substitute for a
routing service, and `UNCOMPOSABLE.coordinator` stands — `gate:composition` still exits 1 on
the same one violation, with the same EXTERNAL owner.

What changed is underneath B1, not B1: **nine repository-owned defects were reproduced
mechanically and eight were fixed.** Every fix moves a verdict in the strict direction only —
`PASS` → `FAIL`/`BLOCKED`, `ACCEPTED` → `refused`, `admissible` → `inadmissible`. On this tree,
with nothing supplied, the readiness gate prints **byte-identically what it printed before**:
the fixes are all on branches that only external answers reach.

The most serious was not F1. It was **R1** — the one requirement §32.4 marks *non-negotiable*
— which all six public hosted routing services could walk past by adding a single character to
their hostname.

---

## 1. Baseline, measured on this tree before any change

| Command | Exit | Result |
|---|---:|---|
| `node tools/release/sourceDigest.js` | 0 | `72f943df83416c73…` (565 files) |
| `npm test` | 0 | **160 suites / 7 112 tests / 0 failures** |
| `npx jest --selectProjects engine --testPathPatterns routingB1` | 0 | 3 suites / **95 tests** / 0 failures |
| `node tools/routing/b1Readiness.js` | 0 | `OVERALL: BLOCKED` — D1, D3, D8; steps 1, 3, 4, 5 |
| `node tools/gates/checkCompositionRoot.js` | **1** | FAIL — 1 violation / 18 workers: `coordinator` `[LEADER_ONLY_NOT_COMPOSABLE]`, EXTERNAL, B1 |
| `npm run gates` | — | 7 PASS / 1 FAIL (composition) |
| `node tools/routing/b1Benchmark.js` | 0 | `NOT_MEASURED` on every row |
| `node tools/release/verdict.js --collect` | 1 | RELEASE: BLOCKED (see §5 for the caveat on this row) |

The digest matched `B1_ROUTING_ENGINE_DECISION_PREPARATION.md` §1 exactly, so every claim in
that document was re-derivable and every claim below is against the same starting tree.

---

## 2. Findings

Nine — A1 through A9, of which A1–A8 were fixed and A9 was deferred.

> **Count correction (final verification, 2026-08-28).** The first draft of §0 and of this
> line read *"eight … seven were fixed"*. That was an arithmetic miscount, caught by the
> post-remediation verification and corrected here. It is contradicted by this section's own
> nine `A`-headings, by §3's mutation table (M1–M8 protect eight distinct fixes), and by the
> independent re-verification in §5.3, which reproduced and re-refuted all eight. No finding
> was added, removed or re-rated to make this correction; only the total was wrong.

Each was reproduced by a probe that builds its own inputs and does not reuse the
implementation's helpers. Severity is the direction of the failure, not the difficulty of
reaching it: every one of these is *permissive* — it turns an absent or wrong answer into an
accepted one.

### A1 — `assertSelfHosted` accepts all six public hosted services written as an FQDN · **High** · FIXED

**Claim.** R1 — *"B1 procures a SELF-HOSTED engine"*, §5.2, ADR-11, §32.4's one requirement
marked **non-negotiable** — is enforced by name against six hosts, and the enforcement can be
bypassed by one character.

**Location.** `Backend/tools/routing/adapters/contract.js:204` (before the fix):

```js
const host = parsed.hostname.toLowerCase();
if (HOSTED_HOSTS.some((hosted) => host === hosted || host.endsWith(`.${hosted}`))) { … }
```

**Root cause.** A fully-qualified domain name may be written with a trailing root dot —
`router.project-osrm.org.` — and every DNS resolver, and Node's own HTTP client, treats it as
the same host. `new URL()` preserves the dot in `hostname`, so neither the equality nor the
suffix comparison matched.

**Mechanical reproduction** (before the fix):

```
http://router.project-osrm.org/     refused (MALFORMED_REQUEST)
http://router.project-osrm.org./    ACCEPTED          ← the same server
https://graphhopper.com./api        ACCEPTED
https://api.mapbox.com./            ACCEPTED
https://valhalla1.openstreetmap.de./ ACCEPTED
https://routing.openstreetmap.de./  ACCEPTED
https://valhalla.mapzen.com./       ACCEPTED
```

All six. A benchmark configured against one of them would have produced ENGINE-attributed
latency rows measuring somebody else's cluster — the exact outcome the check exists to make
impossible, and the outcome §7.5's provenance line cannot catch, because the numbers are real.

**Why the existing tests missed it.** `routingB1Adapters.test.js:167` asserted three hosts, in
one spelling each, from a hand-written list rather than from the shipped `HOSTED_HOSTS`. It
tested that the check works, never that it cannot be walked around.

**Repository-owned.** Yes, entirely. Fixed.

---

### A2 — V-11 drops the region under assessment the moment neighbours are supplied · **High** · FIXED

**Claim.** `assessD1` calls `validateRegionsDisjoint`, and in the configuration V-11 exists for,
the call is a no-op.

**Location.** `Backend/tools/routing/b1Readiness.js:176` (before the fix):

```js
const disjoint = regionBoundary.validateRegionsDisjoint(
  Array.isArray(source.regions) ? source.regions.map(regionBoundary.validateRegionDeclaration) : [declaration]);
```

**Root cause.** `regions` is documented — in `b1Readiness.js`'s own seam and in
`B1_ROUTING_ENGINE_DECISION_PREPARATION.md` §5.3 — as *"the **other** region declarations, for
V-11 disjointness"*. The ternary substitutes them **for** the declaration instead of adding
them **to** it. With one neighbour supplied, `validateRegionsDisjoint` receives a single
region, and its own guard (`usable.length < 2` → `VALID`) returns clean: a single region cannot
overlap.

**Mechanical reproduction.** Two 1°-squares sharing a quarter of their area, one declared and
one in `regions`:

```
direct validateRegionsDisjoint([primary, neighbour])  →  INVALID   (V-11 fires)
assessD1({ region: primary, regions: [neighbour], … }) →  PASS     with zero problems
```

The consequence is §3.5's: region → shard is a function (`Shard.regionId @unique`), and an
overlap makes "every Agent and every Leg belongs to exactly one region" undefined for
everything inside it — an Agent routed to two shards.

**Why the existing tests missed it.** `spatialRegionBoundary.test.js:309–317` tests
`validateRegionsDisjoint` thoroughly, by calling it directly with both regions. No test ever
supplied `regions` to `assessD1`, which is the only path that constructs the argument.

**Repository-owned.** Yes. Fixed.

---

### A3 — V-12 is skipped in silence when the charger catalogue is absent or mistyped · **Medium** · FIXED

**Location.** `Backend/tools/routing/b1Readiness.js:179` (before the fix):

```js
if (Array.isArray(source.chargers) && source.cover) {
  problems.push(...regionBoundary.validateChargerContainment({ … }).problems);
}
```

**Root cause.** A guard whose false branch produces nothing. `chargers` carries no `?` in the
seam `deployment.js` and §36.3.1 document (`regions?` and `cardinalityException?` do), and §14.5
makes it `E_return`'s population — so its absence is a missing D1 answer, not an opt-out. The
validator already returns `NOT_CONFIGURED` with a reason for exactly this case; the guard threw
that reason away.

**Mechanical reproduction.** D1 reports `PASS` for a region with a valid boundary, a valid
cover, and **no charger catalogue at all** — and equally for `chargers: { "CHG-1": "cell" }`,
`chargers: "CHG-1"`, `chargers: 7`.

**Why the existing tests missed it.** The suite's own `FIXTURE` had no `chargers` key and was
asserted to produce `D1: PASS`. The fixture *was* the reproduction, and it was read as a pass.

**Repository-owned.** Yes. Fixed.

---

### A4 — F1: V-13 is implemented, tested, and called by nothing · **Medium** · FIXED

**Claim.** `B1_ROUTING_ENGINE_DECISION_PREPARATION.md` §11 F1, re-derived rather than trusted,
and **it remains true on this tree.**

**Location.** `Backend/src/engine/spatial/regionBoundary.js:760` (definition), `:816` (export),
`Backend/tests/engine/spatialRegionBoundary.test.js:334,343,346` (three tests). Grep over the
whole tree excluding `node_modules` and `coverage` returns exactly those five lines and no
other caller. `assessD1` did not call it; `assessD8` did not call it, and never read
`extract.bbox` or `extract.marginDegrees`.

**Mechanical reproduction.** F1 records the consequence as latent — *"not permissive today,
because D8 is BLOCKED for want of every other field"*. It is permissive the moment the other
fields arrive, and this pass supplied them:

```
extract = { identity, source, vintage, refreshCadenceDays,
            recontractionDowntimeBudgetSeconds,        ← all five present
            bbox: { 0.4, 0.4 → 0.6, 0.6 }, marginDegrees: 0.1 }
region  = the unit square [0,0]–[1,1]

direct validateExtractMargin({ region, extract })  →  INVALID  (4 edges uncovered)
assessD8 via readiness                              →  PASS     with zero problems
```

The extract covers 4 % of the region and D8 passes. §5.2 colocates the routing service with the
shard and routes within the region; a route leaving the cut graph is `EXTRACT_MISS`, so this is
a deployment where a documented fraction of every round's routing fails and no gate said so.

**Why F1 was reported and not fixed at the time.** The stated reason was *"doing so while every
input is absent would be verified by nothing"*. That reason is dischargeable — by supplying the
inputs in a fixture and asserting both directions, which is what §3's tests do.

**Repository-owned.** Yes. Fixed, by the discharge F1 itself prescribes.

---

### A5 — a vintage dated in the future clears every refresh cadence, permanently · **Medium** · FIXED

**Location.** `Backend/tools/routing/b1Readiness.js:380` (before the fix): `if (ageDays > extract.refreshCadenceDays)`.

**Root cause.** The staleness comparison is one-sided. A vintage after the evaluation date
gives a negative age, which is not greater than any positive cadence.

**Mechanical reproduction.** `vintage: "2062-01-01"`, `refreshCadenceDays: 1`, evaluated at
`2026-08-28` → **`PASS`**, summary *"at vintage 2062-01-01, −12910 day(s) old against a 1-day
cadence"*. One mistyped year pins the extract permanently fresh and the check that exists
because *"a stale extract routes over a map the region no longer has, and it does so silently —
every query still answers"* never fires again.

**Why the existing tests missed it.** The stale test walks forward from a fixed vintage; no test
walked backward past zero.

**Repository-owned.** Yes. Fixed — `FAIL`, with the vintage left for Operations to correct.

---

### A6 — two authorities disagree about what a date is · **Medium** · FIXED

**Location.** `Backend/tools/routing/b1Readiness.js:346` (before the fix) tested
`/^\d{4}-\d{2}-\d{2}$/`. `Backend/src/engine/spatial/regionBoundary.js:119` `isIsoDate()` — the
authority `region.versionDate` is judged by — additionally requires the string to round-trip
through `Date`, precisely because *"`2026-02-30` matches the pattern and is not a date"*.

**Mechanical reproduction.** `vintage: "2026-02-31"` → D8 **`PASS`**, with an age computed
against a rolled-over March date; the identical string as `region.versionDate` is refused two
functions away. `"2026-13-01"` likewise.

**Repository-owned.** Yes. Fixed — `isIsoDate` is now exported and D8 uses it, so there is one
rule rather than two.

---

### A7 — `stepEvidenceAdmissible` is true while Step 1 is `NOT_CONFIGURED` · **Medium** · FIXED

**Claim.** The one field whose whole job is to stop a harness number being quoted later as B1
Step 3 evidence reports `true` when no candidate is deployed and no hierarchy is built.

**Location.** `Backend/tools/routing/b1Readiness.js:556` (before the fix):

```js
stepEvidenceAdmissible: steps[0].status !== READINESS.BLOCKED && steps[2].status !== READINESS.BLOCKED,
```

**Root cause.** Step 1 has five states, and the test covers one. With D1 and D3 answered but no
candidate configured, Step 1 is `NOT_CONFIGURED` — *"D1 and D3 are supplied; no candidate
deployment is configured yet"* — which is not `BLOCKED`, so the flag flipped true. §12.2 of the
preparation document states the intended release condition as *"step 1 → NOT_MEASURED once D1
and D3 both PASS"*; `NOT_CONFIGURED` was never it.

**Mechanical reproduction, and why it is reachable rather than theoretical.**
`adapters/index.js:57–58` classifies **any** module passed to `--engine ./x.js` as `AVAILABLE`
on the strength of it exporting a `matrix()` function. So:

```
registry roster:              osrm/valhalla/graphhopper NOT_DEPLOYED, inhouse NOT_IMPLEMENTED
availabilityOf(hand-written): AVAILABLE  ("adapter supplied by module path")   → it gets measured
readiness:                    step1 NOT_CONFIGURED, step3 NOT_MEASURED
stepEvidenceAdmissible:       true                                            → the numbers are "admissible"
```

A hand-written adapter answering from a `Map`, timed on a laptop, over no extract, against no
built hierarchy — and the gate says the result may be quoted as Step 3 evidence.

**Why the existing tests missed it.** The suite asserts `stepEvidenceAdmissible === false` for
the empty tree and after a D3 failure. The one test that reaches the `NOT_CONFIGURED` branch
(*"D1 + D3 alone release Step 1 and Step 3"*) asserts the two step statuses and does not assert
the flag.

**Repository-owned.** Yes. Fixed — admissibility now requires Step 1 to have actually reached
`NOT_MEASURED` or better. This narrows the flag and cannot widen it.

---

### A8 — whitespace satisfies every "this must be a named answer" check in the adapter layer · **Medium** · FIXED

**Location.** `Backend/tools/routing/adapters/contract.js:179` (before the fix):
`typeof value === "string" && value.length > 0` — no trim, while
`normaliseDeployment`'s placeholder comparison one screen below **does** trim
(`.trim().toLowerCase()`), and `b1Readiness.js` and `regionBoundary.js` both trim.

**Root cause.** Two guards on the same field with different notions of empty; `"   "` fell
between them.

**Mechanical reproduction.**

```
travelTimeSpread: { source: "   ", … }                    ACCEPTED   ← N29's NAMED source
deployment:       { extract: "  ", … }                    ACCEPTED   ← Step 4's operational record
engineProfile:    "  "                                    ACCEPTED   ← D3's profile name
```

`travelTimeSpread.source` is the N29 evidence item the engine choice does not close — its whole
requirement is that *somebody must state where the spread comes from*. `deployment.extract` is
carried verbatim into `description` and into Step 4's record, guarded by a check whose stated
purpose is that *"a placeholder there is indistinguishable from an answer"*. A string of spaces
is a placeholder that renders as nothing at all.

**Repository-owned.** Yes. Fixed — the acceptance test trims; the value is never rewritten,
because an operator's string is carried verbatim.

---

### A9 — `assertVersionInKey` is implemented, tested, and called by nothing · **Medium** · REPORTED, NOT FIXED

**Location.** `Backend/src/engine/routing/chargerReachabilityCache.js:124` (definition), `:375`
(export), `tests/engine/energySchema.test.js:268–269` (two assertions, both directions). No
caller anywhere.

> **Citation correction (final verification, 2026-08-28).** This line first cited
> `tests/engine/routingInProcessCache.test.js`. That file exists but contains no reference to
> `assertVersionInKey`; a grep over `tests/` returns only `energySchema.test.js:268–269`. The
> finding itself is unchanged and was re-verified in §8 — only the file name was wrong.

**Root cause and why this one is NOT fixed here.** This is the same *shape* as F1 and a
different *case*, and the difference is the whole point:

- **V-13's** caller existed. `assessD8` ran, on every invocation, and omitted the check. Wiring
  it in changes what a shipped gate reports about inputs somebody supplied — reproducible, and
  now reproduced in both directions.
- **`assertVersionInKey`'s** caller does not exist. `key()` already refuses a missing
  `projectionVersion` and builds the version into the key by construction, so calling the
  assertion from inside `read()`/`write()` would verify a key the same function built from the
  same inputs one line earlier. That is a discharge that proves nothing — the fake-green move
  this programme has documented five times.

Its real caller is the one that receives a key **from elsewhere**: the production Routing
Service client (`src/engine/routing/client.js`, Phase 8, blocked by N25/N26 *and* B1) and the
`charger_reachability` worker's composition root, `DEFERRED` for *"a routing client this
process does not construct"*.

**Discharge:** call `assertVersionInKey(cacheKey, projectionVersion)` from the Phase 8 client at
the point it hands a cache key across a module boundary. **Owner: Phase 8.** Recorded here so
that it is a named handoff rather than a rediscovery.

---

## 3. Fixes

Five files. No new file, no deleted file — the digest still covers 565 files.

| File | Change | Direction |
|---|---|---|
| `tools/routing/adapters/contract.js:192` | `isNonEmptyString` trims before measuring | `ACCEPTED` → `refused` |
| `tools/routing/adapters/contract.js:208,233` | new `canonicalHost()`; R1 compares the canonical hostname | `ACCEPTED` → `refused` |
| `src/engine/spatial/regionBoundary.js:813` | export `isIsoDate` — one date authority, not two | — |
| `tools/routing/b1Readiness.js:195–205` | V-11 always includes the region under assessment; a re-declared id is reported | `PASS` → `FAIL` |
| `tools/routing/b1Readiness.js:217` | V-12 runs unconditionally; its `NOT_CONFIGURED` reason is folded in | `PASS` → `FAIL` |
| `tools/routing/b1Readiness.js:353,445,455` | `extract.bbox` + `extract.marginDegrees` required, shape-checked | `PASS` → `BLOCKED` |
| `tools/routing/b1Readiness.js:470` | **V-13 is called** — F1's discharge | `PASS` → `FAIL` / `BLOCKED` |
| `tools/routing/b1Readiness.js:419` | vintage judged by `regionBoundary.isIsoDate` | `PASS` → `BLOCKED` |
| `tools/routing/b1Readiness.js:499` | a vintage after the evaluation date is a `FAIL` | `PASS` → `FAIL` |
| `tools/routing/b1Readiness.js:664` | D1's validated declaration is passed to D8, never re-derived | — |
| `tools/routing/b1Readiness.js:701` | admissibility requires Step 1 `NOT_MEASURED` or better | `true` → `false` |

### Why each change is safe

1. **Every one is monotone in the strict direction.** No verdict moves toward `PASS`; no
   threshold, tolerance or target is touched; `READINESS`'s five states are unchanged and no
   `BLOCKED` collapses into anything.
2. **Nothing is supplied, defaulted or inferred.** No region, boundary, bounding box, margin,
   speed model, vintage, cadence, downtime budget, spread, threshold or engine. The two new
   required fields are *refused when absent*, which is what the other five already did.
3. **The reported state of this tree does not change.** With nothing supplied, every new branch
   is unreachable — `b1Readiness.js` prints the same three `BLOCKED` decisions and the same
   five step lines it printed at digest `72f943df…`, and `gate:composition` fails on the same
   single violation with the same EXTERNAL owner. The digest moved; the verdict did not.
4. **V-13 cannot pass by default.** Its `NOT_CONFIGURED` answer — which is the only answer
   possible once the extract's own fields are present — is now `BLOCKED` on D1, never `PASS`.
   That is asserted directly.
5. **The self-hosting fix refuses hosted services, not trailing dots.** An internal deployment
   written as an FQDN (`https://valhalla.svc.cluster.local./`) is still accepted; all four
   self-hosted forms probed are unaffected.

### Tests added — 14, all in the two existing suites

`tests/engine/routingB1Readiness.test.js`:
absent inputs · valid inputs · the exact failure direction, edge by edge · V-13 proven to be
*called* by spying on the module `b1Readiness` requires, not by reading the source · V-13
refusing to pass by default with a complete extract and no region · malformed and inside-out
bounding boxes · `marginDegrees: 0` accepted as the real answer it is · the future-vintage
boundary at ±1 day · leap-day and non-leap-day `2029-02-29` · V-11 overlapping, disjoint and
re-declared · V-12 across five wrong types · the admissibility narrowing.

`tests/engine/routingB1Adapters.test.js`:
every host in `HOSTED_HOSTS` × seven spellings, asserted against the **shipped** list rather
than a copy · self-hosted deployments still accepted · whitespace refused on four fields with
the un-trimmed value still carried verbatim into `description`.

### Mutation attack — 10 mutants, 10 killed

Each fix was reverted in place and `routingB1` re-run. A protection no test can distinguish
from its absence is not a protection.

| Mutant | Result |
|---|---|
| M1 `canonicalHost` stops stripping the trailing dot | **KILLED** (1) |
| M2 `isNonEmptyString` stops trimming | **KILLED** (1) |
| M3 V-11 excludes the assessed region again | **KILLED** (1) |
| M4 V-12 re-guarded behind `Array.isArray(chargers) && cover` | **KILLED** (1) |
| M5a `validateExtractMargin` replaced by a constant `VALID` | **KILLED** (4) |
| M5b `extract.bbox` no longer required | **KILLED** (2) |
| M5c `extract.marginDegrees` no longer required | **KILLED** (2) |
| M6 future vintage allowed again | **KILLED** (1) |
| M7 vintage judged by shape, not by calendar | **KILLED** (1) |
| M8 admissible while Step 1 `NOT_CONFIGURED` | **KILLED** (1) |

The tree was restored byte-for-byte after each; the post-mutation digest is the one reported.

---

## 4. What was audited and found sound

These were attacked and did not yield. They are recorded because "we looked" is evidence too.

**The benchmark evidence boundary (scope D).** `verdicts()` was driven with measurements it did
not produce:

- A `HARNESS_ARTIFACT` row fed a perfect 1.00 hit rate stays `NOT_MEASURED`, carries `observed:
  null`, and puts the figure under `harnessObserved`. Neither hit-rate row can become `PASS` or
  `EXCEEDED` under any input.
- A `CACHE_PATH` row driven a billion-fold over budget exceeds **alone**: zero `ENGINE` rows
  exceed. The attribution split is in code.
- `cost_per_candidate` is `NOT_MEASURED` even when both engine rows have samples — it is never
  synthesised from them.
- With no measurement, every row is `NOT_MEASURED` and the exit code is 0 *because no claim was
  made*.
- `DEFAULT_WORKLOAD` is §20.1's own shape (500 × 200 × 25), not a stand-in.
- `travelSdSeconds` is computed only from the configured named spread; `okAnswer` refuses a
  non-finite or negative distance or duration, and `failedAnswer` returns `null` physics rather
  than a straight-line estimate.

**The production seam (scope E).** Nothing under `src/` or `server.js` requires anything from
`tools/routing/adapters/`. The only mention is a comment in `leaderWorkers.js`.
`src/engine/routing/client.js` does not exist. The two seams are not conflated anywhere.

**The composition root (scope B).** The `coordinator` refusal is `EXTERNAL_DEPENDENCY_UNAVAILABLE`
and names D1/D3/D8 and their owners. `evaluateExact`, `pricedCandidateFor` and `hopsForSequence`
have consumers and no producers under `src/` — re-verified by grep — and `cellPairCache.hopsFor`
has one test caller and no production caller. This is F4 and it is correctly **not** a defect:
it is composition-root construction that cannot begin until the engine exists. Nothing was
removed from `UNCOMPOSABLE`.

**Numeric and type boundaries (scope F).** `refreshCadenceDays` and
`recontractionDowntimeBudgetSeconds` were probed with `0`, `-1`, `NaN`, `±Infinity`, `1.5`,
`"30"` and `true` — all `BLOCKED`. `assess({config})` was probed with `""`, `0`, `null`, `[]`,
a string and a number — all `BLOCKED`, all inadmissible. `matrixTimeoutMs`,
`travelTimeSpread.value` and `k` reject every non-finite and negative form. `chargerCatalogue`
must return an array of complete entries. `normaliseMatrixRequest` refuses an absent
`timeBucket` outright, so no adapter can read a clock.

**Evidence binding.** The release verdict refused every stored gate record with
`SOURCE_DIGEST_MISMATCH` the moment the tree moved, and voided the records of a collection that
was running while files changed underneath it
(`VOID:tree-changed-during-collection:72f943df8341->d9fdb79a164a`). Evidence is bound to the
tree that produced it, and the binding is enforced rather than described.

---

## 5. Final measured state

| Command | Exit | Before | After |
|---|---:|---|---|
| `node tools/release/sourceDigest.js` | 0 | `72f943df8341…` (565) | **`d9fdb79a164a…` (565)** |
| `npm test` | 0 | 160 suites / 7 112 tests / 0 fail | **160 suites / 7 126 tests / 0 fail** |
| `jest … routingB1` | 0 | 3 suites / 95 tests | **3 suites / 109 tests** |
| `node tools/routing/b1Readiness.js` | 0 | `OVERALL: BLOCKED` | **`OVERALL: BLOCKED`** (identical output) |
| `node tools/gates/checkCompositionRoot.js` | **1** | 1 violation / 18 workers | **1 violation / 18 workers** (identical) |
| `npm run gates` | — | 7 PASS / 1 FAIL | **7 PASS / 1 FAIL** |
| Mutation | — | — | **10 mutants, 10 killed** |

`release:gates` — see §5.1.

### 5.1 A caveat this report must carry rather than hide

The baseline `release:gates --collect` run was started **before** the source edits and was
still running **while** they landed. The collector detected it and stamped every affected
record `VOID:tree-changed-during-collection:72f943df8341->d9fdb79a164a` rather than
attributing a result to a tree that had moved. That is the correct behaviour and it is why
**no clean measured `release:gates` baseline exists in this pass** — the committed
`docs/release-evidence.json` at `HEAD` is bound to `72f943df…` and is the recorded prior state.

Evidence was re-collected against `d9fdb79a164a…` after the fixes; the result is reported in
§5.2. `docs/release-evidence.json` is **not** part of the 565-file source digest (which covers
`Backend/{src,tools,tests}`, `package.json` and `jest.config.js`), which is why the digest is
stable across the re-collection.

### 5.2 `release:gates` — the clean final collection (E)

A completely fresh `npm run release:gates` was run against the current tree. It is the **only
authoritative collection in this pass**; the earlier one is VOID and none of its records is
used for anything.

**Tree stability, established before the collection was trusted rather than after:**

| Fact | Value |
|---|---|
| Last write to any in-scope source file | `tools/routing/b1Readiness.js`, **22:26:41** |
| VOID collection wrote its output | 22:37:41 |
| Clean collection started | **22:39:50** — after the last source edit |
| Clean collection finished | **23:04:50** (~25 min, 18 distinct gate commands) |
| Digest at start / at end | `d9fdb79a164a…` / `d9fdb79a164a…` (565 files) |

The collector takes the digest at both endpoints and voids the collection unless they agree
(`collectEvidence.js:121,145`). They agreed, so **no record carries a `VOID:` stamp** — which
is itself the proof the tree did not move under the run. Every probe in this verification was
written to a scratchpad outside `Backend/{src,tools,tests}` for exactly this reason, and the
disposable PostgreSQL cluster (§5.4) lives outside the digest scope too.

```
evidence records : 17        VOID records : 0
records bound to d9fdb79a164a1664ce5b80b7f6aed6f2cc70647f054844fa43edb1a3d6f6ff80 : 17/17
fileCount on every record : 565
```

**Collected run records — 16 PASS, 1 FAIL:**

| | Gate | Command |
|---|---|---|
| PASS | `tier_dependencies` | `npm run gate:tiers` |
| PASS | `parameter_register` | `npm run gate:params` |
| PASS | `design_tenets` | `npm run gate:tenets` |
| PASS | `identity_isolation` | `npm run gate:privacy` |
| PASS | `erasure_reconstruction_equivalence` | `npm run gate:erasure` |
| PASS | `legacy_removed_from_build` | `npm run gate:legacy` |
| **FAIL** | `engine_decision_path_wired` | `npm run gate:composition` — exit 1, the one EXTERNAL B1 violation |
| PASS | `lower_bound_admissibility` | `npm run test:engine -- candidatesLowerBound` |
| PASS | `model_check_capacity_1_2_3` | `npm run test:engine -- ModelCheck` |
| PASS | `determinism_replay` | `npm run test:engine -- determinism` |
| PASS | `snapshot_retention` | `npm run test:engine -- observabilityDecisionRecord` |
| PASS | `chaos_capacity_1` / `chaos_capacity_2` | `npm run test:chaos` |
| PASS | `cache_tier_flush` | `npm run test:chaos -- cacheFlush` |
| PASS | `scale_targets` | `npm run test:scale` |
| PASS | `locality` | `npm run test:scale -- locality` |
| PASS | `overload_admission_control` | `npm run test:scale -- overload` |

Corroborating runs (not evidence, and they discharge nothing on their own):
`calibration_safety_derived` **FAIL** — B8, unchanged; `safety_case_assembled` PASS.

**The verdict over that evidence — `npm run release:verdict`, exit 1:**

```
RELEASE VERDICT — §24 gate table (24 gates, all blocking)
  source digest d9fdb79a164a1664…   evidence: docs\release-evidence.json   attestations: (none)
  16 green, 1 red, 7 not evaluated
  RELEASE: BLOCKED — 8 blocking gate(s) are not green.
```

The one **RED** is `engine_decision_path_wired` — the same `UNCOMPOSABLE.coordinator`
violation, same EXTERNAL owner, B1. The seven **NOT_EVALUATED** are the four `PRODUCTION` and
three `ORGANISATIONAL` gates a build may not close; **not one was converted to `PASS`**, no
threshold was touched, and `model_check_capacity_1_2_3` still prints its `[NOT PROVEN]` line.

### 5.3 The eight fixes, re-verified independently (D)

Not trusted from the 7 126 passing tests. Each was re-attacked by a probe that builds its own
inputs, imports the **shipped** modules, and reuses none of the suite's fixtures.

| | Defect re-reproduced pre-fix | Current behaviour | Production caller proven | Mutant |
|---|---|---|---|---|
| **A1** | all 6 hosted hosts ACCEPTED under the old `parsed.hostname.toLowerCase()` | **60/60** hosted spellings refused | `assertSelfHosted` | M1 KILLED |
| **A2** | pre-fix ternary → `validateRegionsDisjoint` returns `VALID` on one neighbour | overlap/clone/re-declaration all `FAIL` | `assessD1` | M3 KILLED |
| **A3** | absent/mistyped catalogue skipped V-12 | 6 wrong types all `FAIL` | `assessD1` | M4 KILLED |
| **A4** | `assessD8` never read `bbox`/`marginDegrees`; 4 % box → `PASS` | 4 % box `FAIL`; 14 malformed forms `BLOCKED` | **spy: `validateExtractMargin` called once per `assess()`** | M5a/b/c KILLED |
| **A5** | `ageDays > cadence` only | future vintage `FAIL` at +1 day and at +12 910 | `assessD8` | M6 KILLED |
| **A6** | local `/^\d{4}-\d{2}-\d{2}$/` | `2026-02-31`, `2026-13-01`, `2029-02-29` all `BLOCKED`; real leap day passes | `assessD8` | M7 KILLED |
| **A7** | `step1 !== BLOCKED` → **`true`** on the current tree | `false` | `assess()` | M8 KILLED |
| **A8** | `"   ".length > 0` | whitespace refused on 6 fields × 5 forms | `normaliseConfig` | M2 KILLED |

Three points the table cannot carry:

1. **A1 did not broaden acceptance.** All seven legitimate self-hosted forms probed are still
   accepted — including `https://valhalla.svc.cluster.local./`, an internal FQDN written with
   the very root dot the fix strips. The fix refuses hosted services, not trailing dots.
   Uppercase, explicit ports, credentials, surrounding whitespace, percent-encoded dots,
   subdomains and `HTTPS://` were each attacked across all six hosts; 14 malformed and
   wrong-scheme forms (including `//router.project-osrm.org./` and an IPv4/IPv6 pair) behave
   correctly.
2. **A4's caller is real, and was proven by observation rather than by reading.** The probe
   replaced `validateExtractMargin` on the module object `b1Readiness` actually requires and
   counted invocations across one `assess()`: **1**. With a complete extract and no region,
   D8 is `BLOCKED` on D1 — never `PASS`. The trace is
   `main()` → `assess()` → `assessD8(config, { region: d1.region })` → `validateExtractMargin`
   → the D8 verdict.
3. **A7 did not disable adapters and does not require an unselected engine.** Step 2 is still
   `PASS`; an arbitrary `--engine ./x.js` exporting `matrix()` is still classified `AVAILABLE`
   and still measurable. What changed is only that its numbers can no longer be called
   admissible Step 3 evidence while Step 1 is `NOT_CONFIGURED`.

**Mutation, re-run rather than quoted.** All ten mutants were re-applied to the working tree,
the `routingB1` suites re-run against each, and each file restored from an in-memory backup:
**10/10 KILLED**, with the same per-mutant failure counts recorded in §3 (M5a 4, M5b 2, M5c 2,
the rest 1). The digest was `d9fdb79a164a…` before the attack and `d9fdb79a164a…` after the
restore — byte-for-byte, so the release evidence collected in §5.2 remains bound to this tree.

### 5.4 Live PostgreSQL (H)

A disposable PostgreSQL **18.3** cluster was built from the installed binaries on port
**55432** — never Neon and never the default 5432 cluster, both of which these harnesses
refuse by name. The schema was applied with `prisma migrate deploy`.

| Harness | Result |
|---|---|
| `tools/verify/phase15LiveDatabase.js` | **12/12** |
| `tools/verify/phase15CurrentTree.js` | **32/32** |
| `tools/verify/phase15EvidenceBinding.js` | **17/17** |
| `tools/verify/phase15VersionInForce.js` | **19/19** |
| | **80/80, all exit 0** |

Two notes, both worth carrying:

- A first attempt used `prisma db push` and produced two failures — a missing partial unique
  index and a missing `CHECK` constraint. Both were an **artefact of the setup, not defects**:
  `db push` syncs `schema.prisma` and silently drops the raw-SQL constraints the real
  migrations create. Re-running under `migrate deploy` gave 12/12. Recorded because a green
  suite over a wrongly-built database is exactly the failure this programme keeps finding.
- None of the four harnesses references `regionBoundary`, `b1Readiness` or the adapter
  contract. They verify **earlier** Phase-15 remediations, so they are a regression guard here
  rather than evidence about these eight fixes. `phase15CurrentTree` G2 independently
  re-confirms the coordinator is uncomposable on B1, EXTERNAL.

### 5.5 Residual observations from this verification — none fixed, none in the eight

Found while re-attacking A2 and A8, recorded because they were seen. **No remediation pass was
started for them**; they are named so they are a handoff rather than a rediscovery.

> **Status, 2026-08-28 (residual remediation pass).** All three have since been remediated in a
> separate pass under a separate mandate. **They remain outside the A1–A9 count** — that count
> is nine findings, eight fixed, A9 deferred, and nothing below is added to it or renumbered
> into it. The paragraphs that follow are left exactly as they were written, as the record of
> what was seen and deliberately not fixed under a verification mandate; the remediation,
> including a correction to what R-2 was originally observed to affect, is **§10**.

- **R-1 · a malformed entry in `regions[]` is dropped from V-11's set rather than reported.**
  `validateRegionsDisjoint` filters to `status === VALID`, and `assessD1` folds in the
  *disjointness* problems but not the neighbours' own declaration problems. So
  `regions: [<malformed>]` yields D1 `PASS` with zero problems. Permissive in direction. A
  real overlap supplied alongside it **is** still caught (`FAIL`), so this narrows to "an
  unusable neighbour is silently not compared", not "V-11 is off". Same shape as A2, one layer
  out; deliberately left for whoever owns the next pass rather than fixed under a verification
  mandate.
- **R-2 · edge-adjacent regions are reported as overlapping.** Two unit squares sharing only
  the line `x = 1` are `INVALID`. This is pre-existing in `validateRegionsDisjoint`, unchanged
  by this pass, and in the **strict** direction — it refuses more than it must, never fewer.
  A2's fix made it reachable from `assessD1`, so it will be seen the first time an operator
  supplies genuinely adjacent regions.
- **R-3 · `PLACEHOLDER_TOKENS` is scoped to the four `deployment` fields only.** So
  `travelTimeSpread.source: "tbd"` is accepted while `"   "` is refused. That scope is
  deliberate and documented in `normaliseDeployment`; A8's fix was about whitespace and did
  not narrow or widen it. Noted because N29's requirement is that somebody *name* the source.

---

## 6. Unfixed — and which kind of unfixed each one is

### External B1 decisions — no commit here closes them

| | Owner | What is missing |
|---|---|---|
| **D1** | Operations + Commercial | the authoritative operating region: `regionId` + `name`, `kind`, the serviceable boundary as GeoJSON Polygon/MultiPolygon in WGS-84 `[lon, lat]`, the CRS, and a version label with a date |
| **D3** | Product + Fleet Engineering | the agent classes this deployment operates and, per **distinct mobility model**, §2.2's six elements with a real speed model over `roadClass`, `gradient`, `surface`, `payloadMass`, `congestion`, `weather` |
| **D8** | Operations | extract identity, source, vintage (ISO, never a file timestamp), refresh cadence, re-contraction downtime budget — **and now also `extract.bbox` and `extract.marginDegrees`, which V-13 reads** |

D1 additionally releases: the cell cover (Engineering), the charger catalogue (Ops / Charging —
now required rather than optional), V-11 disjointness, V-12 containment, V-13 margin, D2's
residual (N23), and `projectCell()` (N27).

### Phase 8 dependencies

- `src/engine/routing/client.js` — the production Routing Service client, §5.2's degradation
  ladder, §18.3 B6's uniform-treatment rule, the `route(parts)` seam `cellPairCache` calls.
  Blocked by N25/N26 **and** B1.
- **A9** — `assertVersionInKey`'s caller. Named above with its discharge point.

### Composition-root construction — released by B1, not by a commit

`evaluateExact`, `pricedCandidateFor`, `hopsForSequence`, and the injection of all of them plus
the routing client and the charger precompute trigger at `server.js`. Estimate it as
composition-root work, not as adapter wiring.

### Specification / governance blockers, carried unchanged

- **F2** — `route.matrix_timeout` and `route.path_timeout` unregistered (§32.5). §22.1
  governance work, not B1 Step 2's.
- **F3** — the GraphHopper snap-radius asymmetry. A real difference between candidates that
  must appear in the ADR as one.
- **N29** — `travelTimeSpread`'s source. Open for every candidate; the engine choice does not
  close it.
- **B8** — 39 Safety-class parameters not `DERIVED`, including `route.degraded_max_radius`
  (UNCALIBRATED, no default). Untouched.
- **B-P / B-O / B-M / X3** — production, organisational, model-checking and TASK-timer
  blockers, all unchanged.

### Repository-owned and deliberately deferred

- **An empty `chargers: []` still passes V-12.** After A3's fix, omitting the catalogue is a
  `FAIL` and declaring it empty is an explicit operator statement — which is the property that
  matters, because the two are now distinguishable. Whether a region may operate with zero
  chargers at all is an Operations/Architecture question about `E_return`'s population, not a
  validator's to decide, so no rule was invented for it.
- **Neither `b1Readiness --json` nor `b1Benchmark --json` embeds the source digest.** Binding a
  number to its tree is manual (`§12.1`'s own instruction). Adding it would make a pure function
  read the filesystem; it is recorded as a known manual step rather than changed unilaterally.
- **`b1Benchmark` reports `stepEvidenceAdmissible` and does not gate on it.** That is by design
  — a run while blocked is legitimate and reports `NOT_MEASURED` — but the per-row records carry
  no admissibility marker of their own. Changing the row schema is a Phase 8 contract change
  (§32.11), not this pass's.

---

## 7. Next action

Unchanged, and still not an engineering task.

1. **Operations + Commercial** answer **D1** — the five region fields.
2. **Product + Fleet Engineering** answer **D3** — the agent classes and, per distinct model, a
   real speed model over the six §2.2 factors.
3. **Operations** answer **D8** — extract identity, source, vintage, refresh cadence,
   re-contraction budget, **and the extract's bounding box and margin**.
4. **Engineering (on D1)** derive the cell cover and supply the charger catalogue; implement
   `projectCell()` once.
5. **Architecture** resolve D2's residual (N23) if the supplied cover falls outside §3.6's band.
6. **Phase 8** write the production routing client, and call `assertVersionInKey` from it (A9).
7. **Whoever owns N29** name the source of the travel-time spread.

Only then do Steps 1, 3 and 4 become runnable, and only then is Step 5 a decision made on
evidence rather than on preference.

**What this pass bought:** when those answers arrive, eight fewer things are waiting underneath
them — including a self-hosting requirement that could be walked past with one character, a
disjointness check that switched itself off when it was given work to do, and a coverage check
that had been written, tested, and never once run.

---

## 8. A9 is correctly deferred (F) — verified, not assumed

A9 was **not** implemented, and no caller was manufactured to make the finding go away. What
was verified instead:

| Claim | Evidence |
|---|---|
| implemented | `chargerReachabilityCache.js:124` |
| exported | `:375` |
| tested | `tests/engine/energySchema.test.js:268–269` — both directions (`ok` true *and* false) |
| genuinely not called | grep over the tree excluding `node_modules`/`coverage` returns the definition, the export, the two assertions, and two prose comments. **No caller.** |
| not required for this closure | it guards a Phase 8 seam that does not exist; `src/engine/routing/client.js` is absent |

**The deferral reasoning holds, and is stronger than first recorded.** `read()` builds its own
key — `const built = key(parts)` — from `parts.projectionVersion`. Calling
`assertVersionInKey(built.key, parts.projectionVersion)` there would check a string that same
function assembled from that same value one line earlier: it can only fail if `key()` is
broken, which is a different test. That is the tautological discharge this programme has
documented repeatedly, and it was correctly refused.

Further, `read()` is **not** unprotected in the meantime. It already carries a genuine
independent cross-check that `assertVersionInKey` on a self-built key could not provide:

```js
// Belt and braces against a key built elsewhere: the entry states the version it was
// computed under, and a mismatch is a miss rather than a plausible wrong answer.
if (String(parsed.projectionVersion) !== String(parts.projectionVersion)) { … miss … }
```

That compares the **stored entry's** version against the requested one — data from outside the
process — which is the real protection. `assertVersionInKey`'s caller is the one that receives
a key *from elsewhere*: the Phase 8 routing client, at the point it hands a cache key across a
module boundary. **Owner: Phase 8.** Unchanged.

---

## 9. FINAL MEASURED STATE

All figures below were measured on the final stable tree at digest `d9fdb79a164a…`. No result
from `72f943df8341…` is presented as evidence for this tree.

> **Superseded for the current tree, not withdrawn.** Everything in this section was true at
> `d9fdb79a164a…` and remains the record of that tree. The residual remediation pass (§10) moved
> the tree, so the figures binding the **current** tree are in **§11**, measured at digest
> `21d9ad95b964…`. Nothing below was re-run and re-labelled; the two are kept apart on purpose,
> because a number bound to one tree is not evidence about another.

**Source digest:** BEFORE `72f943df83416c73…` (565 files) → **CURRENT
`d9fdb79a164a1664ce5b80b7f6aed6f2cc70647f054844fa43edb1a3d6f6ff80` (565 files)**. Unchanged
across the clean collection, across the mutation attack, and at final check.

**Tests:** `npm test` — **160 suites / 7 126 tests / 0 failures**, exit 0 (333 s).

**Routing tests:** `npx jest --selectProjects engine --testPathPatterns routingB1` —
**3 suites / 109 tests / 0 failures**, exit 0.

**Mutation:** **10 mutants, 10 KILLED**, re-run independently; tree restored byte-for-byte
(digest identical before and after).

**Build gates:** `npm run gates` — **7 PASS / 1 FAIL**, exit 1. The one failure is
`gate:composition`: **1 violation across 18 registered workers**, `coordinator`
`[LEADER_ONLY_NOT_COMPOSABLE]`, owner **EXTERNAL — B1**.

**Release gates:** `npm run release:gates` — clean collection, **17 records, 0 VOID, 17/17
bound to the current digest**. Verdict over 24 blocking gates: **16 GREEN / 1 RED / 7
NOT_EVALUATED**, `RELEASE: BLOCKED`, exit 1.

**B1 readiness:** `node tools/routing/b1Readiness.js` — exit 0, **`OVERALL: BLOCKED`**;
D1 BLOCKED (Operations + Commercial), D3 BLOCKED (Product + Fleet Engineering), D8 BLOCKED
(Operations); Steps **1, 3, 4, 5 BLOCKED**, Step 2 PASS; a benchmark run now is **not**
admissible as Step 3 evidence; no engine selected, ranked or recommended.

**Live PostgreSQL:** 4 harnesses, **80/80**, all exit 0, on a disposable PG 18.3 cluster at
port 55432.

**A9:** implemented, exported, tested both directions, **genuinely uncalled**, correctly
deferred to **Phase 8**. Untouched by this pass.

**External blockers:** D1, D3, D8 (the B1 decisions) · `UNCOMPOSABLE.coordinator` · B8's 39
Safety-class parameters · F2, F3, N29 · B-P / B-O / B-M / X3. All unchanged.

**Phase 15 status:** **BLOCKED** on B1, unchanged by this pass.

**Phase 16 status:** **NOT STARTED.** Not begun, not planned, not prepared here.

### What this verification explicitly did and did not do

- **Nine** repository-owned defects were reproduced; **eight were fixed** (A1–A8). The
  previously reported "seven" was an arithmetic miscount, corrected in §2 and contradicted by
  the mutation table and by the independent re-verification in §5.3.
- **A9 remains intentionally deferred to Phase 8** — no caller was manufactured.
- **B1 remains external / blocked.**
- **No engine was selected**, ranked, recommended or hinted at.
- **No D1 / D3 / D8 values were invented**, supplied, defaulted or inferred.
- **No release threshold was changed** and no release-gate semantics were modified.
- **No `NOT_EVALUATED` gate was converted to `PASS`.** All seven remain NOT_EVALUATED.
- **No fake production evidence was created.** Every probe ran in a scratchpad outside the
  digest scope; nothing was written into `Backend/{src,tools,tests}` except the mutation
  attack, which restored byte-for-byte.
- **The old release-gate collection was VOID** because the tree changed during it
  (`VOID:tree-changed-during-collection:72f943df8341->d9fdb79a164a`); none of its records was
  used.
- **The new collection is the only authoritative final collection**, and its tree stability is
  established by the collector's own matching endpoint digests, not by assertion.

**TRUTH > GREEN.**

# B1 — STILL EXTERNAL / BLOCKED.

---
---

# Residual defects discovered during final verification

**Date:** 2026-08-28 · **Branch:** `feature/dashboard` · **Mandate:** remediate the three
repository-owned residuals recorded in §5.5 — and nothing else. No engine selected, B1 untouched,
A9 untouched, no threshold moved, no gate semantics changed, Phase 16 not started.

**Digest before this pass:** `d9fdb79a164a1664ce5b80b7f6aed6f2cc70647f054844fa43edb1a3d6f6ff80` (565 files)
**Digest after:** `21d9ad95b964f64a5fc2d535d93b2a665b6b381aa681775904d981b7c089c052` (565 files)

## 10.0 The historical count is unchanged

| | |
|---|---|
| Findings in the adversarial pass | **A1 – A9 = nine** |
| Fixed before this residual pass | **eight** (A1 – A8) |
| Intentionally deferred | **A9 — to Phase 8**, still untouched, no caller manufactured |
| Residuals remediated here | **R-1, R-2, R-3** — recorded in §5.5, **not** part of the nine |

R-1/R-2/R-3 were *observations* made during verification and were deliberately left unfixed
under that mandate. They are remediated here under a separate one, and they are numbered
separately so that no reader can arrive at "twelve findings" or at "eleven fixed". Three files
changed; no file added, none deleted — the digest still covers 565 files.

## 10.1 Reproduction, before anything was changed

Every residual was re-reproduced by a probe that builds its own inputs, imports the shipped
modules, and reuses no fixture from either test suite. It ran from a scratchpad outside
`Backend/{src,tools,tests}`, so it is outside the source digest.

```
R-1   D1: PASS with ZERO problems for every one of: a three-position ring · a missing regionId ·
      a [lat, lon] swap · a null entry · a bare string · one valid + one malformed · all three
      invalid · regions supplied as a number instead of an array
      (control: a real overlap supplied alongside them was still FAIL)

R-2   INVALID   edge-only contact   [0,1]² vs [1,2]×[0,1]
      INVALID   corner-only contact [0,1]² vs [1,2]²          ← not named in §5.5; found here

R-3   ACCEPTED  travelTimeSpread.source = tbd / TBD / "  tbd  " / TBD. / todo / unknown /
                placeholder / n/a / ? / - / fixme
      PASS      extract.source = tbd, extract.identity = tbd  ← not named in §5.5; found here
      (control: deployment.extract = "tbd" was already refused)
```

Two of the three were **wider than §5.5 recorded**, and the widening is stated rather than
folded in silently: R-2 also refused corner contact, and R-3's bypass was not confined to the
adapter layer — D8's own two named-source fields had the same hole, one directory away.

---

## R-1 · a malformed entry in `regions[]` was dropped before V-11 saw the set

**Original behaviour.** `assessD1` reported D1 **`PASS`, with zero problems**, for a deployment
whose `regions[]` contained an entry that does not validate — any of the eight forms above.

**Root cause.** `validateRegionsDisjoint` filters its argument to entries whose status is
`VALID`, because it can only compare geometry it has; `assessD1` folded in the **disjointness**
problems and never the neighbours' **own declaration** problems. The unusable entry therefore
left the set before the check ran, and nothing anywhere reported that it had. A `regions` key
holding a non-array had the same fate one level up: it was read as "no neighbours", which
switches V-11 off for exactly the configuration it exists for. This is A2's shape one layer
out — the check was called, over a set the bad input had already left.

**Fix** — `tools/routing/b1Readiness.js`, in `assessD1`, ~15 lines:

- every `regions[]` entry is validated by the same authority the primary is
  (`validateRegionDeclaration`) and **its problems are attributed to its own slot index**;
- an entry that is `null`/`undefined` gets its own message — an empty slot is not a declaration,
  and it is reported rather than skipped;
- a `regions` key that is present and is not an array is a wrong-typed answer rather than an
  absence (§4.1 rule 3), and is refused. **An omitted `regions` key is still an absence** — the
  seam writes it `regions?` — and `regions: []` is still an empty comparison set.

Direction: `PASS` → `FAIL`. Nothing is repaired, defaulted or dropped; V-11 is not weakened, and
the disjointness comparison still runs over the entries that are usable.

**Regression tests** (`tests/engine/routingB1Readiness.test.js`): the controls first — absent,
empty, one well-formed neighbour and two well-formed neighbours all still `PASS` with zero
problems, which is the property that keeps this from being a widening.

**Adversarial tests**: the seven attacks the mandate names, each built by the test rather than
perturbed from `FIXTURE` — malformed geometry (a three-position ring), missing region
identifier, malformed coordinates (`[lat, lon]` and a non-numeric position), a `null` entry, an
`undefined` entry, non-object entries (a string and a number), a mixed collection asserted entry
by entry (and asserted **not** to blame the well-formed entry at `[0]`), and an all-invalid
collection. Plus: a malformed entry **does not suppress V-11** — a real overlap supplied beside
it is still reported, so this is "the unusable entry is now named" and not "V-11 got louder";
`regions` as `null`, `7`, a string, an object and `true`; and the consequence assertion — D1
`FAIL` re-blocks Step 1 and `stepEvidenceAdmissible` is `false`.

**Mutation.** M-R1a — `assessD1` stops reporting the entry, so malformed regions are silently
filtered again: **KILLED (12 failing)**. M-R1b — a non-array `regions` is read as "no
neighbours" again: **KILLED (1 failing)**.

---

## R-2 · regions that touch were reported as overlapping

**Original behaviour.** Two unit squares sharing only the line `x = 1` were `INVALID`, and so
were two meeting at a single corner. §5.5 recorded the edge case; the corner case was found
here and is recorded above.

**Root cause.** `polygonsOverlap` asked whether **any pair of edges met at all**, via
`segmentsCross` — which reports a collinear overlap as a crossing because V-3, hunting a ring
that doubles back on itself, needs it to. Sharing a boundary is not sharing area, and V-11 is
about area.

**The contract was established from the shipped modules, not chosen.** Three statements already
in the tree settle it: `polygonsOverlap`'s own line asks whether two polygons *"share any
**area**"*; `boxesOverlap` is documented as a filter and not an answer; and V-11's stated reason
— §3.5's *"every Agent and every Leg belongs to exactly one region at a time"*, with §3.6
assigning membership by **published cell**, not by geometry — is a statement about interiors. A
zero-area boundary contains no cell, so no Agent and no Leg is ever in two regions because of
one. **Positive-area intersection is an overlap; boundary-only contact is not.** A depot
catchment abutting the metro area beside it is the ordinary case; A2's fix had just made V-11
reachable from `assessD1`, so that operator would have met a `FAIL` on a correct boundary.

**Fix** — `src/engine/spatial/regionBoundary.js`, `polygonsOverlap` rewritten over two new
private helpers. Each edge of one ring is cut at every parameter where it meets the other ring,
which makes every resulting stretch homogeneous — wholly inside the other, wholly outside it, or
wholly along it — so one sample decides each stretch exactly:

- any stretch **inside** the other ring → overlap (this covers a proper crossing, a partial
  overlap, containment, and containment flush against shared edges);
- otherwise, one boundary running **wholly along** the other → identical regions → overlap.
  V-2/V-3 have already established both rings are closed and simple, and a simple closed curve
  cannot be a proper subset of another, so this is the only remaining way two interiors coincide.
  It is the one case boundary sampling alone cannot see, and it is caught by the property that
  makes the regions identical rather than by a special case for equality;
- otherwise the interiors are disjoint.

**No bounding-box shortcut.** `boxesOverlap` remains a pre-filter that only skips work for boxes
that are *strictly* separated; every touching or overlapping pair goes to the geometry. Asserted
directly by two triangles with **identical** bounding boxes that share only a diagonal.

**No tolerance, and the reason is recorded in the module.** Every comparison is exact — the same
`=== 0` orientation test `segmentsCross` and `checkRing` already make. A collinear stretch is
recognised from the **parameter range** that produced it, never by re-deriving a midpoint and
testing it back against the other line, which is what would have needed an epsilon to absorb its
own rounding. An "almost touching" rule would be this module deciding how close two boundaries
may be drawn before they are the same place — a geographic decision it holds no authority to
make, for the same reason `checkPosition` refuses to re-order a `[lat, lon]` file rather than
correcting it.

**Regression tests** (`tests/engine/spatialRegionBoundary.test.js`): the pre-existing V-11 tests
are unchanged and still pass — disjoint `VALID`, crossing `INVALID`, contained `INVALID`, and
the §9.6 ordering test. **V-3 is asserted unchanged**: a bow-tie and a ring that doubles back
along itself are both still `INVALID`, so the fix is proven not to have reached the function
V-11 and V-3 share.

**Adversarial tests**: the mandate's six, each asserted in **both supply orders** —
A positive-area overlap `INVALID` · B edge-only contact `VALID` · C corner-only contact `VALID` ·
D disjoint `VALID` · E identical `INVALID` · F tiny positive-area overlap `INVALID`. Plus:
containment with and without a shared edge (a region flush inside another on three of four
edges — every vertex on the larger's boundary, which a vertex-only test would call disjoint);
a **slanted** shared edge with identical bounding boxes, and a slanted pair that genuinely
shares area; a row of three adjacent regions passing as a set, with a fourth genuinely
overlapping one of them still caught and **naming only that pair**; and the no-tolerance
boundary probed at `1 ± Number.EPSILON` in both directions.

At the production authority path (`tests/engine/routingB1Readiness.test.js`): an edge-adjacent
neighbour supplied through `regions[]` gives D1 `PASS` with zero problems, and the same pair
moved one tenth of a degree into genuine shared interior still `FAIL`s and still re-blocks Step 1.

**Mutation.** M-R2 — `polygonsOverlap` reverted to "any edge contact is an overlap":
**KILLED (6 failing)**, across both suites.

---

## R-3 · a placeholder satisfied every "name the source" check outside `deployment`

**Original behaviour.** `travelTimeSpread.source: "tbd"` was accepted, and D8 reported `PASS`
for `extract.source: "tbd"` and `extract.identity: "tbd"` — while `deployment.extract: "tbd"`
was refused.

**Root cause.** `PLACEHOLDER_TOKENS` existed, but the comparison against it was written **inline
inside `normaliseDeployment`**, applied to that function's own four fields. It was never a
predicate, so no other field could be judged by it. One question, two rules — the shape A6 found
for dates and A8 found for emptiness, a third time.

**Tracing the contract — which fields are a named evidence source.** The rule is applied where a
name is the whole of the requirement, i.e. where the field exists so somebody can later ask
*"where did this come from?"* and get an answer:

| Field | Why it qualifies |
|---|---|
| `travelTimeSpread.source` | N29 / §32.4 R7. No shortlisted engine returns a spread, so **every** `travelSdSeconds` is computed from this configuration; the name is the only record of whose number it is, and it is carried verbatim into `description` |
| `deployment.{shape, extract, profilesBuilt, hierarchyBuildTime}` | already covered — `b1Benchmark.js:89–90`, `:590–591`, Step 4's operational record |
| `extract.identity` | D8. *"a stable name for the extract every measurement will be attributed to"* |
| `extract.source` | D8. *"where the snapshot came from, so a re-cut can be reproduced"* |

And, explicitly, which do **not**, because the mandate is not to reject these strings globally:

- `engineProfile` — an engine-side costing name matched against a deployed profile, not evidence
  about where a number came from; the token list holds strings (`-`, `?`) a profile could
  legitimately be called.
- `regionId`, `name`, `version` in `regionBoundary.js` — D1's identifier, commercial label and
  version tag, judged by V-7's own rule, which is about *stability* rather than provenance.
  Widening the rule to them would be a change to a different authority's contract and is not
  made here.
- D8's other five fields — `vintage` is already an ISO calendar date and the three numbers are
  already numbers, so the rule would add nothing.

**Fix.** `tools/routing/adapters/contract.js` — the inline comparison becomes an exported
predicate `isPlaceholder(value)`; `normaliseDeployment` now calls it (identical behaviour, one
line), and `normaliseSpread` calls it for `travelTimeSpread.source`.
`tools/routing/b1Readiness.js` — `assessD8` requires `contract` directly (not `./adapters`,
whose index materialises every candidate) and applies the same predicate to `extract.identity`
and `extract.source`. **The token list itself is unchanged**, including its deliberate narrowness:
`"none"` and `"not built"` are honest answers for a candidate Step 1 has not deployed, and are
still accepted. Direction: `ACCEPTED` → `refused`, `PASS` → `BLOCKED`.

**Regression tests**: an empty or whitespace-only source still gets **A8's** message, not the new
one — nothing supplied and a non-answer supplied are two defects with two remedies, and this must
not swallow the first. `deployment`'s four fields keep their own message unchanged, and
`"none"` / `"not built"` still build an adapter.

**Adversarial tests**: every token in the **shipped** `PLACEHOLDER_TOKENS` set × five spellings
(bare, upper-cased, space-padded, trailing dot, space-then-dot) against
`travelTimeSpread.source` — asserted against the shipped list rather than a copy of part of it,
the discipline A1 established — and all nineteen tokens in case and spacing variants against
both `extract.identity` and `extract.source`. Empty string, `"   "`, `"\t\n"` on each.
Legitimate sources asserted **accepted**: a URL, a Geofabrik file name, an internal mirror path,
a vendor SLA reference, a ticket reference, and — the two that matter —
`"unknown-roads-survey-2026"` and `"N/A-WEST depot survey"`, because the comparison is against
the whole trimmed field and never a substring of it. Scope asserted directly:
`engineProfile: "tbd"` is still accepted, and `extract.vintage: "tbd"` still gets the ISO-date
message. And the single-authority property is asserted by **observation**: a spy on the module
`b1Readiness` actually requires records `isPlaceholder("tbd")` being called from `assessD8`, so
the gate is using the adapter layer's predicate rather than a second copy of the list.

**Mutation.** M-R3a — `travelTimeSpread.source` accepts placeholders again: **KILLED (1
failing)**. M-R3b — D8's two fields accept placeholders again: **KILLED (3 failing)**.

---

## 10.2 Mutation attack — 5 mutants, 5 killed

Each protection was reverted in place and the suites that are supposed to notice were re-run.
A protection no test can distinguish from its absence is not a protection.

| Mutant | Reverts | Result |
|---|---|---|
| M-R1a | `assessD1` stops reporting a malformed `regions[]` entry | **KILLED** (12) |
| M-R1b | a non-array `regions` is read as "no neighbours" again | **KILLED** (1) |
| M-R2 | `polygonsOverlap` back to "any edge contact is an overlap" | **KILLED** (6) |
| M-R3a | placeholder check removed from `travelTimeSpread.source` | **KILLED** (1) |
| M-R3b | placeholder check removed from `extract.identity` / `extract.source` | **KILLED** (3) |

Every file was restored from an in-memory backup and the digest was `21d9ad95b964…` before the
attack and `21d9ad95b964…` after it — byte-for-byte, which is why the release evidence collected
in §11 is bound to this tree.

> One honesty note on the harness. The first automated run reported M-R2 as killed with "0
> failing", because the runner passed `spatialRegionBoundary|routingB1Readiness` through a shell
> that read the `|` as a pipe: the command failed for the wrong reason, and a non-zero exit was
> being read as a kill. M-R2 was therefore re-applied and re-run by hand, and it is killed by
> **six real assertion failures**, listed above. The other four mutants used single-token
> patterns and were unaffected. Recorded because "the mutant died" on a broken command is
> exactly the fake-green move this programme keeps finding.

## 10.3 The reported state of this tree is unchanged

The strongest claim available about a fix made while every input is absent: with nothing
supplied, every new branch is unreachable, so the gate must print exactly what it printed before.
That was verified mechanically rather than asserted — all five mutants were applied at once
(reverting the tree to its pre-residual behaviour), `b1Readiness.js` was run against both, and
the two outputs compared:

```
all five fixes reverted, b1Readiness output compared:
  BYTE-IDENTICAL — every new branch is unreachable on this tree
```

`OVERALL: BLOCKED`; D1, D3, D8 each `BLOCKED` naming their owners; Steps 1, 3, 4, 5 `BLOCKED`,
Step 2 `PASS`; a benchmark run now is **not** admissible as Step 3 evidence. The digest moved;
the verdict did not.

## 10.4 One thing this pass changed that it was not asked to

`npm test` failed once during verification, on `gate:parameter_register`: the midpoint divisor
`/ 2` introduced by R-2's geometry was a bare behavioural constant. It was annotated
`@structural` — *"the arithmetic mean of two parameters — a midpoint's own divisor"* — which is
what the register requires and what `signedRingArea`'s own `/ 2` already carried three hundred
lines above. **No parameter was registered, no threshold moved, and the gate was not relaxed.**
It is recorded because the failure was real, was caught by a shipped gate rather than by review,
and the full suite was then re-run from a clean tree rather than the single file being re-checked.



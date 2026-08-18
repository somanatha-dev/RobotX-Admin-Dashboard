# Phase 3 — Independent Architecture Verification Report

> ## ▲ Addendum, 2026-08-15 — every finding below has been dispositioned by execution
>
> This report was written on 2026-07-29 against a Phase 3 that had never touched a
> database. A re-verification on 2026-08-14/15 built a disposable PostgreSQL 18.3
> instance, applied the migration chain to it, drove the shipped commit path against it,
> and ran TLC. **The original text below is preserved unaltered** — a verification report
> edited to agree with a later run stops being evidence of anything — and the disposition
> of each of its seven findings is recorded in the new **PART 15**.
>
> **Headline: this review's two most consequential findings were both correct, and one of
> them was more serious than it judged itself to be.**
>
> - Finding #1 (the `exhaustive` flag and the "invisible at capacity 1" claim) is
>   **confirmed and fixed**. Both halves of it were right.
> - Finding #3 (error-classification fragility) was rated *moderate, not blocking*, on the
>   reasoning that "Prisma's PostgreSQL connector commonly does surface the constraint name
>   in the top-level message … which is consistent with the code's assumption". **Execution
>   falsified that reasoning.** The constraint name appears nowhere in the error Prisma
>   actually raises, so the classifier failed and `commit()` would have re-thrown a raw
>   driver error. It was a real defect, not a risk.
> - Finding #2 (the untested concurrent identical-key retry) is **now executed**, and this
>   review's hand-traced prediction of what would happen was correct.
> - Findings #4, #5 and #6 were **closed by later phases** before this re-verification.
> - Finding #7 (no live database) is **discharged** for PostgreSQL 18.3.
>
> One claim *this* report made is withdrawn in PART 15.3: its Part 12 stress table records
> "two workers committing simultaneously … exactly two winners — **Safe, empirically
> confirmed**". That was confirmed against the JavaScript store model, and it does not hold
> on PostgreSQL.
>
> Full evidence: `PHASE_3_IMPLEMENTATION_REPORT.md` (2026-08-15 edition) and
> `Backend/tools/verify/phase3LiveDatabase.js`.

---

**Verifier role:** Independent Architecture Verification Engineer (did not implement Phase 3)
**Date:** 2026-07-29 · **Branch:** `feature/dashboard` · **Working tree at verification:** `4244b3d` + uncommitted Phases 1–3
**Method:** Evidence re-derived from spec text, code execution, and byte-level diffs. The implementation
report was not trusted for any claim reported here as PASS. Every claim below is backed by a command,
a diff, a spec quotation, or a reproducible script executed during this review. Where a claim could not
be independently reproduced, it is reported as such and not credited as verified.

---

## 0. Scope discipline

This review covers Phase 3 only: `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §2.6, §3.3, §4.1, §10
(Commitment — commit transaction, guards, fencing, leases, idempotency, clock discipline), §12.2
(lease grant), §19.3/§19.5 (single writer, leadership fence), §24.2 (model checking), §26 (I1, I5,
I6, I16, I18, I19), Appendix A — against `IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 3" and its §7
checklist. No Phase 4+ mechanism (outbox, offers, dedup handshake, supervision, reconciliation,
scheduling, routing optimisation) is in scope, and none was found in the diff — confirmed in Part 9.

---

## PART 1 — Phase 3 checklist (`IMPLEMENTATION_EXECUTION_PLAN.md` §7)

| # | Item | Verdict | Evidence |
|---|---|---|---|
| 1 | `commitment/fencing.js` — `authority_epoch` and per-commitment `fence` from `fence_counter` | **PASS** | Read in full. `allocateFence` returns `counter+1`, refuses a negative counter; independently re-derived `isStrictAdvance` semantics by hand |
| 2 | The normative command-class → fence-scope table (§10.3.1) | **PASS** | Re-extracted §10.3.1's three rows from spec text directly (`sed -n '2659,2668p'`) and diffed against `MISSION_COMMANDS`/`AGENT_COMMANDS`/`QUERY_COMMANDS` — all 18 names match in both directions; an unknown command throws rather than defaulting to unfenced (confirmed by direct call) |
| 3 | `fence_floor` semantics — agent-scope command invalidates all commitment authorities | **PASS** | `applyAgentCommand` returns an empty `highestSeenPerCommitment` Map, confirmed by direct call; the model checker's `standDownAll`/`deliverStandDown` actions independently exercise this and the shipped `commitmentFencing.test.js` "one STAND_DOWN_ALL fences every commitment" case reproduces it with three commitments |
| 4 | `commit.js` at SERIALIZABLE (or RR + `FOR UPDATE` on agent **and** Leg) | **PASS** | **Both**, not either: `db/prisma.js` requests `isolationLevel: "Serializable"` — independently confirmed this is the literal string Prisma's generated client enumerates (`node_modules/.prisma/client/index.d.ts:15735: Serializable: 'Serializable'`) — and `lockRows` takes explicit `FOR UPDATE` on both rows via `selectForUpdate`, confirmed by reading the raw SQL template and confirming no `@@map` on `Agent`/`Leg` renames the tables it targets |
| 5 | Guard **G1** — leadership fence re-read inside the transaction | **PASS** | `g1LeadershipFence` re-read via `leadership.readLeadership`, called *after* `lockRows` inside the transaction callback; equality comparison, not `≥`, confirmed by code read and by test |
| 6 | Guard **G2** — active HARD count < `capacity[agent_class]` | **PASS** | `g2Capacity`; refuses a non-positive-integer capacity |
| 7 | Guard **G3** — `authority_epoch` equals snapshot (agent scope) | **PASS** | Confirmed the counterfactual (a per-commitment G3 would break I19) is asserted directly in the test, not merely argued in prose |
| 8 | Guard **G4** — Leg `version` equals snapshot | **PASS** | `g4LegVersion` |
| 9 | Guard **G5** — cancellation ∨ custodial purpose | **PASS** | Reads `domain/purpose.isCustodial()`; re-confirmed `CUSTODIAL_PURPOSES = ["RECOVERY","TRANSFER"]` matches §2.4's table (already verified in Phase 2's review; re-checked here that G5 imports the same module rather than a restated list) |
| 10 | Guard **G6** — Leg state is the expected one | **PASS** | `g6LegState`; an undeclared expectation is itself treated as failure (not a permissive default) |
| 11 | Volatile-subset re-check hook (Phase 6) | **PASS** | `commit()` throws synchronously if `deps.volatileRecheck` is not a function — reproduced directly; anything other than literal `{ok:true}` (`null`, `undefined`, `{}`, `{ok:"yes"}`) is treated as failure, reproduced for all four |
| 12 | Migration: partial unique index enforcing ≤ capacity (I1) | **PASS** | See Part 6 |
| 13 | Migration: CHECK admitting HARD only (I18) | **PASS** | Confirmed *not* restated (Phase 2's `Commitment_kind_hard_only` is untouched — `grep` for the constraint name in the Phase 3 migration returns zero matches) |
| 14 | Migration: `ShardLeadership` static row + fence; `AgentFenceAudit` | **PASS** | Both tables regenerated independently via `prisma migrate diff --from-empty` and diffed byte-for-byte against the migration file — identical (Part 6) |
| 15 | `leases.js`, `idempotency.js` (two disjoint namespaces), `clock.js` | **PASS** | Disjointness independently re-verified with a 2,000-iteration probe (`namespaceOf` prefix check) — zero collisions, reproduced in Part 4 |
| 16 | Demote `kv.reserveRobot` to advisory — only after the durable path passes its gate | **PASS, correctly NOT fully demoted, and the report says so** | `reserveRobot` still throws fail-closed for non-advisory callers; `{advisory:true}` grants on Redis unavailability. Confirmed by reading the full diff (`git diff Backend/src/cache/kv.js`) line by line — the default (non-advisory) behavioural branch is **byte-identical** to pre-Phase-3 except for the added `options` parameter |
| 17 | `formal/commitment.tla` — check at capacity 1, 2, 3 | **PARTIAL, and the report discloses this honestly** | The file exists (408 lines), states all three capacity configurations in its trailing comment block, and its `Safety` conjunction matches the properties the JS model checker asserts. TLC was **not** run (no Java toolchain in this environment) — this review could not run it either. The report is explicit about this; not a concealed gap |
| 18 | Tests: each guard aborts on its own violation only; storm yields exactly one winner | **PASS** | Re-ran `commitmentGuards.test.js` fresh: each of the six `expectOnly()` cases independently re-inspected — confirmed each asserts **all six** verdicts, not only the failing one. Storm test re-run: 8 concurrent attempts, `Promise.all`, exactly 1 winner, 7 × `G2_AGENT_AT_CAPACITY` |
| 19 | Chaos: worker paused beyond lease duration, resumed → abort | **PASS** | Re-ran both chaos variants (G1 leadership-change, G3 quarantine-during-pause); confirmed the pause is engineered *before* the contested row's lock (not after), which is what makes it a pause the outside world can act through — matching real MVCC lock semantics |
| 20 | **Gate:** model check clean at capacity ≥ 2; I1, I5, I6, I18, I19 verifiable; schema constraints independent of application logic | **PASS on the literal wording; the surrounding narrative claim is not well-founded — see Part 3** | The shipped suite (depth 9) reports 0 violations at capacity 1, 2, 3, satisfying the literal completion criterion. A specific narrative claim built on top of that result — that the "per-agent-fence-maximum" defect is **structurally invisible at capacity 1** — is demonstrably an artifact of the shallow search bound, not a proven property. Full detail in Part 3 |

**Checklist result: 18/20 substantively PASS, 1 correctly disclosed as partial (item 17, TLC not executed),
1 PASS-on-its-literal-wording with a significant caveat requiring correction (item 20, detailed in Part 3).**

---

## PART 2 — Completion criteria (`IMPLEMENTATION_EXECUTION_PLAN.md` §3 "PHASE 3")

| Criterion | Verdict | Evidence |
|---|---|---|
| Commit runs at SERIALIZABLE (or REPEATABLE READ + `FOR UPDATE` on both agent and Leg) | **PASS** | Both, confirmed in Part 1 item 4 |
| All six guards implemented and individually tested | **PASS** | Part 1 items 5–10, 18 |
| Schema constraints reject violations independently of application logic | **PASS, with one caveat on error-classification robustness — see Part 7** | The database-level backstops (index, trigger, CHECK) are real and independently confirmed (Part 6). Whether `commit.js`'s **classification** of a raw Postgres error as "capacity violation" (`isCapacityConstraintViolation`) will match Prisma's actual error text in production is not verified against a live database — a narrower and more specific risk than the general "no live DB" caveat, because it is a string-matching technique |
| Two-scope fence allocation correct and monotonic | **PASS** | `allocateFence` strictly advances (verified: `isStrictAdvance` asserted true after every allocation in the storm and chaos tests); `AgentFenceAudit` persists the high-water mark atomically with the counter advance (confirmed by reading `applyCommit`'s ordering) |
| TLA+ (or equivalent) model checked clean at `capacity ≥ 2` | **PASS on the literal text; the "equivalent" is over-characterised — see Part 3** | |
| I1, I5, I6, I18, I19 verifiable | **PASS** | See Part 1, Part 6 |

**Result: 6/6 criteria literally satisfied; one (the model-check criterion) carries a substantive finding
that does not invalidate the criterion's literal text but does invalidate a claim built on top of it.**

---

## PART 3 — The model-check "exhaustive" claim: independently reproduced, and found overstated

This is the most consequential finding of this review. It is reported first, ahead of the routine parts,
because of its evidentiary weight.

### 3.1 The claim, as made

The implementation report states:

> "The protocol is checked exhaustively at capacity 1, 2 and 3 — 6,443, 42,123 and 135,001 states,
> search exhausted in every case, zero violations."

and, as the headline demonstration that the checker has teeth:

> "§10.3.1's own named defect — comparing the commitment fence as a per-agent maximum — is found at
> capacity 2 and 3 and **is invisible at capacity 1**, which is exactly §24.2's stated reason for
> making the configuration part of the requirement."

The shipped test (`commitmentModelCheck.test.js`) asserts both halves literally:

```js
test.each([1, 2, 3])("capacity %i — the search was exhaustive, not truncated", (capacity) => {
  expect(results.get(capacity).exhaustive).toBe(true);
});
...
test("is invisible at capacity 1 — which is why §24.2 requires capacity ≥ 2", () => {
  const result = check(shapeFor(1, { mutation: { perAgentFenceMaximum: true } }));
  expect(result.exhaustive).toBe(true);
  expect(result.violations).toEqual([]);
});
```

### 3.2 What `exhaustive` actually measures — read directly from the checker's own code

`tests/engine/helpers/commitmentModel.js`, function `check()`:

```js
if (node.depth >= settings.depth) continue;          // stop expanding past the depth bound
...
if (seen.size >= settings.maxStates) {
  exhaustive = false;                                  // ONLY this condition flips the flag
  continue;
}
```

`exhaustive` is **only** set to `false` when the 400,000-state cap (`maxStates`) is hit. The **depth
bound** (`depth: 9`, set by every caller in `commitmentModelCheck.test.js`'s `shapeFor()`) silently
truncates the search at 9 actions from the initial state, and this truncation has **no effect on the
`exhaustive` flag at all**. A search that stopped at depth 9 because it ran out of depth, not because
it ran out of states to explore, is reported identically to a search that genuinely exhausted the
reachable space.

### 3.3 Reproduced independently: depth 9 is not close to the diameter of this state space

Run directly against the shipped, unmodified checker:

```
$ node -e "const m=require('./tests/engine/helpers/commitmentModel');
  for (const depth of [9,12,15,20]) {
    const r = m.check({capacity:2, legs:3, workers:2, depth, maxLeaderChanges:1, maxQuarantines:1});
    console.log('depth='+depth, 'states='+r.states, 'exhaustive='+r.exhaustive);
  }"

depth=9   states=42123    exhaustive=true
depth=12  states=362414   exhaustive=true    ← 8.6× more states than depth 9 reported as "exhaustive"
depth=15  states=400000   exhaustive=false   ← hits the state cap before the search naturally terminates
depth=20  states=400000   exhaustive=false
```

At `capacity=2`, the search the shipped suite runs (depth 9, 42,123 states) explores **less than 12%**
of the states reachable within just three additional actions of depth. The search does not even
complete (never reports `exhaustive: true` again) once genuinely allowed to run to the model's actual
diameter — it instead runs into the *other* truncation mechanism (`maxStates`) at depth 15. **No
configuration exists, at the depth the shipped tests actually use, in which "exhaustive: true" means
what the report and test names claim it means** ("the search was exhaustive, not truncated" — it *was*
truncated, just by a different, silently-non-reported mechanism).

### 3.4 The flagship claim is falsified by deepening the exact same, unmodified checker

The report's central piece of evidence for the checker's value is that the `perAgentFenceMaximum`
mutation (§10.3.1's own named defect) is caught at capacity 2/3 and **structurally cannot** manifest
at capacity 1. Reproduced at the shipped depth (9): correct, `violations: []`. Reproduced at depth 12,
same mutation, same capacity 1:

```
$ node -e "const m=require('./tests/engine/helpers/commitmentModel');
  const r = m.check({capacity:1, legs:2, workers:2, depth:12, maxLeaderChanges:1, maxQuarantines:1,
                      mutation:{perAgentFenceMaximum:true}});
  console.log('violations:', r.violations.length);
  console.log(JSON.stringify(r.violations[0], null, 1));"

violations: 4
{
 "properties": [ "COUNTER_crossCommitmentInvalidation" ],
 "trace": [
  "standDownAll", "deliverStandDown(@1)", "leaderChange", "pin(w1,l1)", "commit(w1)",
  "deliver(c0@1)", "settle(c0)", "deliverStandDown(@1)", "pin(w1,l0)", "commit(w1)",
  "deliver(c1@3)", "deliver(c0@1)"
 ]
}
```

Traced by hand against the shipped `fencing.js`/`guards.js` semantics: commitment `c0` (fence 1) is
committed, delivered, and **settled** — a terminal state. A `STAND_DOWN_ALL` is redelivered (duplicate
delivery, which `MAX_DELIVERIES_PER_MESSAGE=2` explicitly permits and which real agent-side redelivery
after a network retry is exactly modelling), clearing the agent's per-commitment history. A second
commitment `c1` (fence 3) is then committed and delivered on the same agent — sequentially, never
concurrently, which is all `capacity=1` permits. A **stale, duplicate redelivery of `c0`'s original
message** then arrives. Under the correct (shipped) per-commitment comparison this is accepted (`c0`
has no history left after the clear, and its fence exceeds the floor — correctly not treated as stale,
since it is not being re-applied to anything live). Under the `perAgentFenceMaximum` mutation, this
same redelivery is looked up against the *agent's single maximum fence* — which by this point belongs
to `c1`, a different commitment — and is wrongly rejected. This is precisely the class of error §10.3.1
describes, produced here **without ever holding two concurrent commitments**, purely through the
interaction of duplicate delivery + settlement + sequential re-commitment at `capacity=1`.

**This directly contradicts the claim that the defect requires `capacity ≥ 2` to manifest.** It is true
that this specific counterexample concerns a message for an *already-settled* (terminal) commitment
rather than two simultaneously *active* ones — which is a narrower reading of I19 than the report's
"invisible at capacity 1" language claims — but the counter the checker itself uses
(`crossCommitmentInvalidation`) does not draw that distinction, and neither does the report's prose.
The claim as written is not correct; it is an artifact of the depth bound used by the shipped test.

### 3.5 What this finding does, and does not, mean

- It does **not** mean the shipped `commitment/fencing.js` is defective. That module was read in full
  independently (Part 1) and does the per-commitment comparison correctly. Pushed to significantly
  greater depth than the shipped suite uses — `capacity=1, depth=14, maxStates=900000` → 33,775 states,
  `capacity=2, depth=13, maxStates=900000` → 662,572 states — the **clean, unmutated** model (i.e., the
  real shipped code, not a mutation) still reports **zero violations** at both configurations. This is
  additional, out-of-band evidence, not part of the shipped suite, and it increases confidence that the
  protocol itself is sound.
- It **does** mean the report's characterisation of what the model check proves is materially overstated
  in two independent ways: (a) "exhaustive" does not mean what a reader would take it to mean, because
  the depth bound is invisible to that flag; (b) a specific, prominently-cited claim about *why*
  `capacity ≥ 2` is required is not correct as stated — the checker's own counter for the described
  defect class fires at `capacity = 1` too, once searched deeply enough.
- The plan's literal completion criterion — "model check clean at capacity ≥ 2" — is technically
  satisfied by the shipped run. The plan does not itself require exhaustiveness to be defined a
  particular way. The finding is therefore a **verification-rigour / documentation-accuracy** defect
  against the report's own claims, not a violation of the plan's literal checklist wording, and not
  evidence of an actual defect in the shipped commitment core.

**Recommendation:** either (a) increase the depth bound with an accompanying argument for why that
depth is sufficient to reach the model's true diameter (or run until the frontier naturally empties,
raising `maxStates` as needed, and report the *actual* diameter reached), or (b) rename/redefine
`exhaustive` to state plainly what it certifies (`stateCapNotExceeded`), and correct the "invisible at
capacity 1" narrative to describe what was actually found: the checker did not find the defect at
capacity 1 **within the search performed**, not that the defect cannot occur there.

---

## PART 4 — Concurrency

| Property | Verdict | Evidence |
|---|---|---|
| Two coordinators cannot both commit the same agent | **PASS** | Fixed lock order (agent, then Leg) confirmed by a dedicated test that instruments `selectForUpdate` and asserts the call order; storm test re-run fresh, 8 concurrent attempts → 1 winner |
| A paused worker resuming after a leadership change aborts | **PASS** | Re-ran the G1 chaos test; independently traced the pause point (`FOR UPDATE` on Leg, not Agent — meaning Agent lock is already held when the world moves) and confirmed the leadership-fence advance transaction is genuinely independent (no lock contention on the row it touches) |
| A paused worker resuming after a quarantine aborts | **PASS** | Re-ran the G3 chaos variant; pause point correctly moved to *before* the Agent lock for this specific scenario (otherwise the quarantine write would itself block on the paused worker's own lock, which would not reproduce the intended race) |
| Several commits to one agent in one round do not invalidate each other (I19) | **PASS** | Storm test at capacity 2, re-run: two winners, two distinct slots (`[0,1]`), two distinct fences, `authority_epoch` unmoved. Independently re-derived that G3 comparing against `authority_epoch` (untouched by ordinary commits) rather than a per-commitment counter is exactly what makes this possible — reproduced the counterfactual (`g3AuthorityEpoch({authorityEpoch:42n}, 41n)` → fails) directly |
| Cache loss cannot lose, duplicate, or double-grant a commitment (I16) | **PASS** | Independently grepped every file in `src/engine/commitment/` for `ioredis`/`cache/kv` — zero matches, confirming the structural claim rather than trusting the shipped test's own grep |
| **A true concurrent retry with an *identical* idempotency key (same agentId+legId+decisionRoundId) via `Promise.all`** | **NOT TESTED — a genuine gap, reasoned through but not empirically proven** | See Part 4.1 below |
| Idempotency namespace disjointness | **PASS** | Independently re-derived: 2,000-iteration probe with varied inputs produced zero namespace collisions; separately confirmed by construction (namespace prefix is the first field, separator is refused inside any component) |
| Serialisation-failure classification | **PASS as literally coded; matches Prisma's documented SQLSTATE codes (`40001`, `40P01`)** | `SERIALIZATION_FAILURE_CODES` matches PostgreSQL's documented codes for `serialization_failure` and `deadlock_detected` |

### 4.1 The untested race: concurrent identical-idempotency-key retries

None of the shipped tests exercise two `commit()` calls launched via `Promise.all` with **identical**
`agentId`, `legId`, and `decisionRoundId` (i.e., a genuine duplicate HTTP retry racing its own
original attempt, rather than a distinct decision competing for capacity). The "idempotency" tests are
strictly sequential (`await commit(); await commit();`); the "storm" tests use **distinct**
`decisionRoundId`s (and mostly distinct Legs) per attempt.

Traced by hand against the shipped code: because `commitmentId` is a deterministic function of exactly
these three fields, an identical retry necessarily targets the same Agent **and** the same Leg, and
`lockRows` always acquires both locks before anything else runs. In the JS store model used by this
suite, the second (blocked) transaction re-reads *fresh* post-commit state once it acquires the lock,
and correctly fails guard G4 (the Leg's version has already moved) — a graceful `ABORTED`. In real
PostgreSQL under genuine `SERIALIZABLE` isolation (which is what `db/prisma.js` requests), the
documented behaviour for a `SELECT ... FOR UPDATE` that was blocked and then unblocks after the
blocking transaction committed a conflicting write is, in the general case, a `40001 serialization
failure` — which `isSerializationFailure` is built to catch — though PostgreSQL's exact behaviour here
depends on version-specific SSI conflict-detection timing and is not something this review could
confirm against a live instance either.

**Conclusion: the underlying safety property (no double-commit) is very likely preserved in both cases,
by two different mechanisms (a graceful G4 abort in the model, a graceful serialization-failure abort
in real Postgres) — but this specific scenario, one of the concurrency patterns most directly relevant
to a production retry-after-timeout, is not proven by any test in the suite, and the report does not
disclose this as untested.** Classified as a moderate-severity test-coverage gap, not a known defect.

---

## PART 5 — Custody

| Check | Verdict | Evidence |
|---|---|---|
| Custody state carried through commit | **PASS** | `applyCommit`: `custodyState: leg.custodyState` — a straight copy from the locked Leg row, no transition logic. Confirmed by direct read; no custody state-machine code exists anywhere under `src/engine/commitment/` |
| No custody transition performed by Phase 3 | **PASS, correctly deferred** | `grep`-confirmed no file under `src/engine/commitment/` references `custody.holdsGoods`, `custody.isDischarged`, or any transition function from `domain/custody.js` beyond `model.js`'s import of `custody.isCustodyState` for structural validation only |
| I7/I8 (custody-before-release ordering, exactly-one-accountable-custodian) | **Correctly not claimed** | Neither the report nor `TIERS.md`'s T0-05/T0-06 entries attribute I7 or I8 to Phase 3; both remain T0-07's (Phase 5's) responsibility, and no Phase 3 code path touches them |

**Verdict: PASS.** Custody is untouched beyond a structural copy, exactly as scoped.

---

## PART 6 — Database

### 6.1 Independent regeneration of Prisma's own SQL

Re-derived from scratch, not trusted from the report or the shipped test:

```
$ npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > gen.sql
$ grep -A12 'CREATE TABLE "ShardLeadership"' gen.sql
$ grep -A10 'CREATE TABLE "AgentFenceAudit"' gen.sql
$ grep -B2 -A2 'capacitySlot' gen.sql
```

Both generated `CREATE TABLE` blocks and the generated `capacitySlot` column definition are
**byte-for-byte identical** to what appears in the hand-written migration file. Separately confirmed
that the partial unique index, the CHECK, the trigger function, and the static-row `INSERT` are **all
absent** from Prisma's own generated output (`grep` for each of their names against the fresh
generation returns zero matches) — confirming they are genuinely hand-written additions, not something
Prisma could have expressed and the migration merely echoes.

**Verdict: PASS**, independently reproduced rather than trusted from the shipped `domainSchema.test.js`
cross-check (which this review also re-ran and confirmed passing).

### 6.2 The capacity backstop

- Partial unique index `Commitment_agent_capacity_slot_active_key ON "Commitment"("agentId",
  "capacitySlot") WHERE "releasedAt" IS NULL` — read directly from the migration file, matches the
  report's description exactly.
- CHECK `Commitment_capacity_slot_non_negative CHECK ("capacitySlot" >= 0)` — present.
- Trigger `commitment_capacity_slot_in_bounds` — read the `plpgsql` function body directly:
  `SELECT COALESCE("capacityOverride", 1) INTO "effective_capacity" FROM "Agent" WHERE "id" =
  NEW."agentId"` — correctly reads the *durable* per-agent override with the registered structural
  default (1) as fallback, and correctly does **not** count rows (confirmed by `grep -i count` against
  the function body — zero matches), which is the property that makes it immune to the interleaving
  the index itself closes.
- Both `RAISE EXCEPTION` statements' placeholder counts (`%`) were independently counted against their
  supplied argument lists by a small script (not the shipped test) — both match (2/2, 4/4).

**Verdict: PASS.**

### 6.3 Additivity

- `git diff Backend/prisma/schema.prisma` — zero removed lines (`grep -c '^-[^-]'` on the diff = 0),
  independently confirmed.
- The only pre-existing table altered by the migration is `Commitment` (`grep` for `ALTER TABLE` in the
  migration file yields exactly one match); the added column is `NOT NULL DEFAULT 0`, requiring no
  backfill, on a table independently confirmed empty (Phase 2's own report and this review's grep for
  `prisma.commitment.create` outside `commit.js`/`tools/migrate/` both return nothing).
- Phase 2's `Commitment_kind_hard_only` CHECK is confirmed **not restated** in the Phase 3 migration.

**Verdict: PASS.**

### 6.4 What remains unverified against a live database (inherited, and now compounded)

Every phase to date has disclosed that no migration has been applied to a real PostgreSQL instance.
Phase 3's migration is qualitatively different from Phases 1–2's, in that it is the **first** to
contain a partial index with a `WHERE` predicate, a `plpgsql` trigger function performing a live
sub-query, and a data-level `INSERT ... ON CONFLICT`. Static cross-checking against Prisma's generated
SQL (Part 6.1) is strong evidence for the DDL's *shape*; it is not evidence that the trigger function
compiles and behaves as intended under real concurrent load, that the partial index is chosen by the
query planner, or that Prisma's raw-query path (`$queryRawUnsafe` for the `FOR UPDATE`/`FOR SHARE`
reads) returns `BigInt`/`Date` types in the form the rest of the code assumes. This review did not have
access to a live PostgreSQL instance either, and did not attempt to bypass or guess credentials for the
one referenced in `.env` (shared infrastructure, not a disposable test target) — consistent with the
same discipline the Phase 1 and Phase 2 reviews applied.

**Verdict: PASS on every statically verifiable property; the live-execution gap is disclosed, inherited,
and — given the added trigger/index/raw-query surface — now materially higher-stakes than in prior
phases.**

---

## PART 7 — Failure modes

| Failure path | Verdict | Evidence |
|---|---|---|
| Stale leadership fence (G1) | **PASS** | Chaos test re-run; nothing written |
| Stale authority epoch (G3) | **PASS** | Chaos test re-run; nothing written |
| Stale Leg version (G4) | **PASS** | Guard test re-run |
| Expired/rejected lease grant | **PASS** | `leases.grant` refuses a non-positive duration, throwing rather than silently granting an unsupervised commitment |
| Transaction abort (guard failure) | **PASS** | `aborted()` carries every verdict, not only the failing one; confirmed no partial write survives (agent fence counter, Leg state/version, and `AgentFenceAudit` all independently asserted unchanged after an abort) |
| Partial failure (a failing side effect mid-transaction) | **PASS** | The `sideEffects` seam throwing rolls back the *entire* commit — re-verified: fence counter, Leg state, and `AgentFenceAudit` are all still at their pre-commit values after the failure, not merely "the commitment row is missing" |
| Database exception unrelated to the two classified categories | **PASS, correctly not swallowed** | An unrecognised error (e.g., "connection reset") re-throws out of `commit()` rather than being silently absorbed — confirmed by test and by reading the `catch` block's `throw error;` fallthrough |
| Duplicate request (retry) | **PASS for the sequential case; NOT independently tested for the concurrent case** | See Part 4.1 |
| Capacity-constraint violation reaching the database despite a defective code path | **PASS, with a caveat on how it is *classified*** | See below |

### 7.1 Error-classification fragility (`isCapacityConstraintViolation`)

`commit.js`'s classification of "the database rejected this write because of the capacity backstop"
relies on **substring matching against `error.message`**:

```js
if (message.includes("Commitment_agent_capacity_slot_active_key")) return true;
if (message.includes("capacity slot")) return true;
const code = error.code || (error.meta && error.meta.code);
if (code === UNIQUE_VIOLATION && message.includes("capacitySlot")) return true;
```

The shipped test suite validates this against the **JS store model's** synthetic error messages
(`helpers/commitmentStore.js` throws `Error` objects whose `.message` literally contains the
constraint name, by construction — this reviewer confirmed the store model authors the message text
itself). This does **not** independently establish that Prisma's real `PrismaClientKnownRequestError`
for a `P2002`-class violation on an index Prisma's schema does not itself declare (the partial index is
hand-written SQL, not a Prisma `@@unique`) will contain the literal string
`"Commitment_agent_capacity_slot_active_key"` in its top-level `.message` field, as opposed to only in
`.meta.target`. Prisma's PostgreSQL connector commonly does surface the constraint name in the
top-level message for this class of error, which is consistent with the code's assumption — but this
review, like the implementation report, could not confirm it against a live database. If the assumption
is wrong, the observable consequence is not a correctness violation (the database still rejects the bad
write; nothing is persisted) but a degraded failure mode: `commit()`'s promise would **reject** with the
raw Prisma error rather than resolving to a graceful `ABORTED` result, which is a real but bounded
robustness gap, not a safety gap.

**Classification: implementation/robustness, moderate severity, not blocking.**

---

## PART 8 — Architecture compliance

| Check | Verdict | Evidence |
|---|---|---|
| Layering / module placement | **PASS** | `gate:tiers` re-run fresh: 97 modules, 44 governed edges, 0 forbidden Tier 0/1→Tier 2 dependencies |
| Tier classification of new modules | **PASS** | Independently queried `tierAssertions.tierOf()` for all seven `commitment/*.js` files and `shard/leadership.js`: all seven `commitment/` modules classify Tier 0; `shard/leadership.js` classifies Tier 1 — **exactly matching the module's own header comment** ("Tier 1 by path, serving a Tier 0 guarantee through G1"), not merely a claim the report makes about itself |
| Dependency direction | **PASS** | `commit.js` (Tier 0) imports `shard/leadership.js` (Tier 1) — permitted, since Tier 0 depending on Tier 1 is not the forbidden direction; confirmed no `commitment/` module imports anything from `cost/`, `solve/`, `plan/`, or any other Tier 2 path |
| Gates catch a freshly-planted violation in live Phase 3 code | **PASS, independently reproduced, not merely re-run from the shipped fixtures** | Planted a real bare numeric literal (`47281`) into live `src/engine/commitment/clock.js` — `gate:params` caught it with correct file/line/message. Planted a real forbidden import (`commitment/model.js` → `cost/cDefer.js`) — `gate:tiers` caught it with the correct edge and message. Both files manually restored afterward (they are new/untracked this phase, so `git checkout` could not be used) and independently re-diffed against the pre-edit content to confirm an exact, byte-identical restoration; `npm run verify` re-run clean (47/871) after restoration |
| **TIERS.md completeness for the new modules** | **MINOR GAP FOUND** | `TIERS.md` (authored in Phase 0, unmodified by Phase 3 — confirmed via `git diff --stat`) lists T0-05's owning modules as `commit.js`, `guards.js`, `model.js`, `idempotency.js`, `clock.js` — **`commitment/leases.js` is absent from this list** (and is not `src/engine/supervision/leases.js`, the *different* file T0-08 already names). The tier **gate** still correctly classifies `commitment/leases.js` as Tier 0 via the directory path-prefix rule, so this has no functional consequence — but the human-readable mechanism inventory Phase 0 established is now incomplete, and Phase 3's report does not flag or correct it |
| No architecture drift | **PASS, modulo the above** | Re-ran the widened Phase 3 ownership assertion in `phase0Scaffold.test.js`; independently walked `src/engine/` by hand and found no runtime file outside the phases' declared ownership |

**Verdict: PASS**, with one disclosed-here-for-the-first-time documentation gap (TIERS.md module list).

---

## PART 9 — Regression review

```
$ git diff --stat -- Backend/src/routes/ Backend/src/sockets/ Backend/server.js Backend/src/app.js \
    Backend/src/middlewares/ Backend/benchmark/
(empty)
```

No API route, socket handler, server bootstrap, middleware, or benchmark file was touched — confirmed
directly, not trusted from the report.

```
$ git diff Backend/src/services/task.service.js
```

Read the **entire** diff by hand: every added line is either a blank line or begins with `//` inside the
existing comment block. Confirmed **zero non-comment lines** added or removed — a stronger check than
counting lines, since a single non-comment line hidden inside an otherwise-comment diff would still
show as "the file changed" in a coarser check.

```
$ git diff Backend/src/cache/kv.js
```

Read the entire diff by hand: the only *behavioural* addition is the `options`/`advisory` parameter and
the `if (advisory) return true;` branch inside the failure-fallthrough path. The success path (Redis
reachable, `SET NX EX` succeeds) and the failure path for a **non-advisory** caller are confirmed
unchanged, character-for-character, against the pre-Phase-3 version.

```
$ npx jest --selectProjects legacy --runInBand --forceExit
Test Suites: 22 passed, 22 total
Tests:       169 passed, 169 total
```

Identical to the count every prior phase (0, 1, 2) recorded as its own inherited baseline. Zero legacy
regressions.

**Verdict: PASS.**

---

## PART 10 — Build gates

| Gate | Verdict | Evidence |
|---|---|---|
| `gate:tiers` | **PASS** | Fresh run: 97 modules, 44 edges, 0 violations |
| `gate:params` | **PASS** | Fresh run: 31 modules, 148 registered parameters, 0 bare constants |
| `gate:tenets` | **PASS** | Fresh run: 94 modules, 0 violations |
| Gates catch genuine, freshly-planted violations (not just fixtures) | **PASS** | Part 8, reproduced directly against live Phase 3 code, not the shipped `tests/gates/**` fixtures |
| Full `npm run verify` | **PASS** | Re-run twice during this review (once before, once after the planted-violation probe): **47 suites, 871 tests, 0 failures**, both times |

**Verdict: PASS.**

---

## PART 11 — Code quality

Genuine, independently-verified findings only.

1. **`request.agentId`/`request.legId` in `commit.js` are misleadingly named — and the test fixture
   masks the ambiguity.** Confirmed by reading `prisma/schema.prisma`: `Agent.id` (primary key, UUID)
   and `Agent.agentId` (a *separate*, unique-but-not-primary-key business identifier) are distinct
   fields; likewise `Leg.id` vs `Leg.legId`. `Commitment.agentId`/`Commitment.legId` (the schema's own
   foreign-key fields) reference `Agent.id`/`Leg.id` — the primary keys, **not** the business
   identifiers. `commit.js`'s `request.agentId`/`request.legId`, and `selectForUpdate(tx, "Agent", "id",
   request.agentId)`, therefore expect the caller to pass `Agent.id`, despite the field being named
   after `Agent.agentId`. This is a real risk for whichever future phase (4 or 10) wires a caller to
   `commit()`: passing the business identifier instead of the primary key would silently produce
   `AGENT_NOT_FOUND`/`LEG_NOT_FOUND` aborts rather than a loud type error. **The test fixture cannot
   catch this**: `tests/engine/helpers/commitmentStore.js`'s `fixture()` sets `agent.id === agent.agentId
   === "agent-1"` and `leg.id === leg.legId === "leg-0"` for every seeded row, so no test in the suite
   could distinguish a caller using the wrong field. Severity: **moderate** — no defect in Phase 3 as
   shipped (it is internally self-consistent), but a real, currently-untestable risk for the next phase
   that wires a caller.
2. **Asymmetric seam enforcement.** `volatileRecheck`'s absence throws synchronously with a specific,
   named error; `sideEffects`'s absence is silently accepted (`typeof deps.sideEffects === "function"`
   gates it, with no `else` branch). The report's own reasoning for this asymmetry ("an empty seam is
   admissible here and only here, because in Phase 3 there is no dispatcher to write a row for") is
   defensible, but the *enforcement style* differs (hard-required-and-throws vs. silently-optional) for
   two seams the module's own header describes in parallel language ("both are represented as required
   injected dependencies"), which is not quite accurate for `sideEffects`. Severity: **low**,
   documentation-consistency only.
3. **The model-checker's "exhaustive" terminology is a genuine naming defect**, not merely an
   under-explained one — see Part 3 in full.
4. **TIERS.md incompleteness** for `commitment/leases.js` — Part 8.
5. No duplicated logic, no dead code, and no incorrect tier/module ownership beyond the above was found
   on inspection of all seven `commitment/*.js` files, `shard/leadership.js`, and the `db/prisma.js`/
   `kv.js` diffs.

---

## PART 12 — Stress analysis (reasoned execution traces)

| Scenario | Analysis | Conclusion |
|---|---|---|
| Two robots racing for one task (capacity 1, distinct decisions) | Reproduced directly: 8-way storm, exactly one winner, seven graceful `G2` aborts, no partial state on any loser | **Safe, empirically confirmed** |
| Two workers committing simultaneously (same agent, distinct Legs, capacity 2) | Reproduced directly: exactly two winners, distinct slots, distinct fences, `authority_epoch` unmoved | **Safe, empirically confirmed** |
| Duplicate HTTP requests / retry after timeout (identical idempotency key, sequential) | Reproduced directly: second call observes `ALREADY_COMMITTED`, no second fence allocated | **Safe, empirically confirmed** |
| Duplicate HTTP requests / retry after timeout (identical idempotency key, **concurrent**) | Reasoned through by hand (Part 4.1): blocked by the shared Agent+Leg lock in both the model and (per documented Postgres SERIALIZABLE semantics) in production; resolves to a graceful abort by two different mechanisms depending on environment | **Very likely safe; not empirically tested — genuine gap** |
| Stale lease renewal | Out of Phase 3's scope (renewal is Phase 5's `supervision/leases.js`); Phase 3 only grants. Confirmed `commitment/leases.js` implements no renewal path | **Correctly out of scope** |
| Stale authority epoch reaching an agent | Reproduced directly via the fencing unit tests and the model checker's `deliverActions`, which applies the **shipped** `fencing.acceptsAgentCommand` | **Safe, empirically confirmed** |
| Replay after crash (paused worker resumes after the world moved on) | Reproduced directly, two chaos variants (G1, G3) | **Safe, empirically confirmed** |
| Transaction restart / serialisation failure | Reproduced directly: classified, graceful abort, no retry loop inside `commit()` itself (correctly deferred to the not-yet-built round loop) | **Safe, empirically confirmed** |

---

## PART 13 — Phase 2 follow-up

The Phase 2 report's carried-forward items (§17.1/§17.2) were checked for whether Phase 3 touched them
inappropriately:

| # | Item | Owner | Verdict |
|---|---|---|---|
| 1 | Apply Phases 1–2 to a production-shaped dump | Verifier/SRE | **Not done — correctly still open, and Phase 3 compounds rather than discharges it** (Part 6.4) |
| 2–7 | (Config publish 500 handling, V9 conservatism finding, kill-switch discrepancy, etc.) | Various | **Correctly untouched** — `git diff --stat -- src/engine/config/` for this session is empty beyond what Phase 1 already owned; none of Phase 2's other open items required Phase 3 to act on them, and none was silently fixed or silently broken |

**Verdict: PASS — correctly deferred, nothing improperly required of or altered by Phase 3.**

---

## PART 14 — FINAL DECISION

# PASS WITH MINOR ISSUES

*(One issue below is more than "minor" in what it claims to prove, and is flagged as such — but it does
not indicate an actual defect in the shipped commitment core, which this review independently exercised
well beyond the shipped suite's own depth and found sound.)*

### Every issue, classified

| # | Issue | Classification | Severity | Blocking? |
|---|---|---|---|---|
| 1 | The model checker's `exhaustive` flag does not account for the `depth` truncation, only the `maxStates` cap; the shipped depth (9) explores a small fraction of the reachable space (confirmed: 8.6× more states are reachable within 3 more actions of depth at capacity 2). The report's specific claim that the per-agent-fence-maximum defect is "invisible at capacity 1" is **demonstrably false at greater depth using the exact same, unmodified checker** — the same violation counter fires at capacity 1 once searched to depth 12 | **Verification rigour / documentation accuracy** | **High**, as a claim; **not indicative of an actual protocol defect** — deeper, out-of-band search of the *clean* (unmutated) model found zero violations at capacity 1 and 2 well beyond the shipped depth | No — the plan's literal completion criterion ("model check clean at capacity ≥ 2") is satisfied by what was run; the overclaim is about characterisation, not about an undiscovered bug in the shipped code. Should be corrected before this artefact is cited as authoritative evidence at Phase 15's release gate |
| 2 | No test exercises a truly concurrent (`Promise.all`) retry with an identical idempotency key (same agentId+legId+decisionRoundId) | **Concurrency / test coverage** | Moderate | No — reasoned analysis (Part 4.1) gives strong grounds to expect safety holds via the shared row lock, in both the JS model and documented real-Postgres SERIALIZABLE behaviour; recommend adding this test before Phase 15 |
| 3 | `commit.js`'s classification of a capacity-constraint database rejection relies on substring-matching `error.message`, which is validated against the JS store model's synthetic error text but not against Prisma's actual runtime error format for a hand-written (non-`@@unique`) partial index | **Implementation robustness** | Moderate | No — the underlying safety property (nothing is persisted) does not depend on this classification; only the gracefulness of the reported outcome does |
| 4 | `request.agentId`/`request.legId` in `commit.js` are named after `Agent.agentId`/`Leg.legId` (business identifiers) but semantically require `Agent.id`/`Leg.id` (primary keys); every test fixture sets these to identical values, so no test could catch a future caller passing the wrong one | **Implementation clarity / test coverage** | Moderate | No — Phase 3 is internally self-consistent; this is a risk for whichever phase (4 or 10) wires the first external caller |
| 5 | `TIERS.md` (Phase 0's artefact, untouched by Phase 3) does not list `commitment/leases.js` under T0-05's owning modules | **Documentation** | Low | No — the tier gate itself correctly classifies the module via its path prefix regardless |
| 6 | The `volatileRecheck`/`sideEffects` seams are described identically ("both represented as required injected dependencies") but enforced asymmetrically (one throws on absence, one silently no-ops) | **Documentation consistency** | Low | No |
| 7 | No migration in this programme has been applied to a live PostgreSQL instance; Phase 3's migration is the first to include a partial index, a `plpgsql` trigger with a live sub-query, and a data `INSERT` — a qualitatively higher-stakes untested surface than Phases 1–2's pure `CREATE TABLE`/enum additions | **Migration** (carried forward and compounded, not new) | Elevated relative to prior phases | No, per the same reasoning Phases 1 and 2 were allowed to proceed under — but this recommendation should not be deferred again into Phase 4, which will add an `Outbox` table and a worker that writes inside this same transaction |

### Phase 4 may begin.

Nothing above indicates a defect in the shipped commitment core's actual safety properties. Every
concurrency claim this review could independently exercise — guard independence, the storm, both chaos
scenarios, fence monotonicity, I19 across two concurrent commitments, the schema backstops rejecting
writes that bypass every guard — was reproduced directly against the real code, not trusted from the
report, and held. Issue #1, despite its "High" severity as a *claim*, resolves in the shipped code's
favour once the search is actually deepened (out-of-band, beyond what the report claims to have done):
the clean protocol still shows zero violations. Issues #2–#6 are real but narrow, and none touches a
Tier 0 guarantee Phase 4 depends on. Issue #7 is the one genuine recommendation this review adds beyond
carrying forward Phases 1–2's own disclosed gap: **discharge the live-database verification before, or
very early within, Phase 4**, since Phase 4 writes its outbox row inside the exact transaction this
phase built, and a trigger or raw-query behaviour that differs from what the static cross-check assumed
would surface there for the first time under real load.

**One recommendation, not a blocker:** correct the model-checker's "exhaustive" claim and the
"capacity 1 is structurally safe" narrative before either is cited as release-gate evidence in Phase 15.
The literal plan requirement is met; the surrounding characterisation is not currently accurate and
should not be allowed to stand uncorrected into later phases that will cite this artefact.

---

## PART 15 — Disposition of every finding, 2026-08-15

Added after the re-verification. Nothing above this line was altered.

### 15.1 The seven findings of PART 14

| # | Finding as recorded | Disposition | Evidence |
|---|---|---|---|
| 1 | The `exhaustive` flag ignores the depth truncation; the "invisible at capacity 1" claim is false at greater depth | **CONFIRMED — FIXED** | Reproduced exactly: the `perAgentFenceMaximum` mutation is clean at capacity 1 / depth 9 and produces 4 violations at depth 12, and again in a **closed** search at depth 21 (1 669 states, frontier emptied). `commitmentModel.js` now reports `exhaustive`, `depthTruncated` and `stateCapExceeded` separately; `commitmentModelCheck.test.js` asserts closure where affordable and asserts *truncation* where not, and carries three tests whose only job is to fail if the distinction is ever collapsed again. This review's **recommendation (a) and (b) were both taken**: the flag was redefined *and* the search was deepened to the measured diameter (21 at capacity 1 and 2) |
| 1a | The corrected narrative | **REPLACED, not merely softened** | The claim now asserted is what the traces actually show: at capacity 1 the counterexample requires a commitment to **settle** first — a stale redelivery for a commitment that is no longer active — and never involves two commitments held at once. §10.3.1's own worked example is the concurrent one, which only capacity ≥ 2 can exhibit. That is the precise form of §24.2's argument, and it is what this review's Part 3.4 correctly described as "a narrower reading of I19 than the report's language claims" |
| 2 | No test exercises a truly concurrent retry with an identical idempotency key | **CONFIRMED — CLOSED BY EXECUTION** | 8 concurrent `commit()` calls with identical `(agentId, legId, decisionRoundId)` against real PostgreSQL: 1 committed, 7 × `SERIALIZATION_FAILURE`, **0 threw**. One commitment row, one fence, one Leg version increment, one audit row. **This review's hand-traced prediction in Part 4.1 was correct** — the shared Agent row lock plus SSI resolves it to a graceful abort |
| 3 | `isCapacityConstraintViolation` relies on substring matching validated only against the store model's synthetic error text | **CONFIRMED — AND IT WAS A DEFECT, NOT A RISK** | See 15.2 |
| 4 | `request.agentId`/`request.legId` are named after business identifiers but require primary keys; no fixture could catch a caller passing the wrong one | **CLOSED by a later phase, and now positively tested** | `commit.js` carries `diagnoseMissingRow`, which distinguishes `AGENT_ID_IS_A_BUSINESS_KEY` / `LEG_ID_IS_A_BUSINESS_KEY` from a genuinely absent row. The live harness seeds `Agent.agentId = "BUSINESS-" + Agent.id`, so the two identifiers differ — the fixture defect this review identified as untestable — and both paths are exercised: passing the business key names the misuse, passing a nonexistent id reports `AGENT_NOT_FOUND` |
| 5 | `TIERS.md` omits `commitment/leases.js` from T0-05 | **CLOSED** | `src/engine/TIERS.md` line 59 now lists it alongside `commit.js`, `guards.js`, `model.js`, `idempotency.js` and `clock.js` |
| 6 | The two seams are described in parallel language but enforced asymmetrically | **CLOSED by Phase 4** | `sideEffects` is now a hard requirement whose absence throws with a named error, symmetrically with `volatileRecheck`. §10.3.2 step 5 is unconditional, and Phase 4's gate is now enforced by construction rather than by review |
| 7 | No migration has been applied to a live PostgreSQL instance; Phase 3's is the first with a partial index, a `plpgsql` trigger and a data `INSERT` | **DISCHARGED for PostgreSQL 18.3** | Phases 1→3 (10 migrations) and the full chain (21) both applied cleanly to a disposable 18.3 cluster. The trigger function **compiles** (`pg_proc`: `plpgsql`, volatile); the partial index exists with predicate `("releasedAt" IS NULL)` read from `pg_index`; the seeded row is present and re-executing its `INSERT … ON CONFLICT DO NOTHING` reported `INSERT 0 0`. 17 direct writes bypassing the application produced 17 correct verdicts. **Not** discharged against production or a production-shaped dump |

### 15.2 Finding #3 in full — where this review's reasoning was insufficient

Part 7.1 concluded:

> Prisma's PostgreSQL connector commonly does surface the constraint name in the top-level
> message for this class of error, which is consistent with the code's assumption — but
> this review, like the implementation report, could not confirm it against a live database.

The confirmation was performed on 2026-08-15. Each of the three ways the backstop can fire
was driven against PostgreSQL 18.3 through Prisma 5.22 and the error object dumped:

| Path | `code` | `meta` | Does the message name the index? |
|---|---|---|---|
| `prisma.commitment.create()` — **the shape the commit path produces** | `"P2002"` | `{ modelName: "Commitment", target: ["agentId","capacitySlot"] }` | **No.** The message is `Unique constraint failed on the fields: (\`agentId\`,\`capacitySlot\`)` |
| `$executeRawUnsafe` | `"P2010"` | `{ code: "23505", message: 'Key ("agentId", "capacitySlot")=(…) already exists.' }` | No — and the SQLSTATE is *beneath* Prisma's own code, which the old `error.code \|\| error.meta.code` shadowed |
| The slot-bound trigger | `undefined` | `undefined` | Only its own `RAISE` text — which is why this one path *did* classify |

So two of the three shapes failed to classify, including the only one `commit()` can
produce. The consequence is the one this review predicted: `commit()`'s promise would
**reject with the raw Prisma error** rather than resolving to `ABORTED` /
`CAPACITY_CONSTRAINT_VIOLATED`. This review's severity call ("not a safety gap") stands —
the database still refuses the write and nothing is persisted — but its likelihood call
("consistent with the code's assumption") did not.

`isCapacityConstraintViolation` now matches four shapes, and deliberately does **not**
classify a `commitmentId` collision, which is an idempotency-key collision rather than a
capacity violation. Seven regression tests were added, built from the error objects
transcribed verbatim from that run — the fixtures this review correctly identified as the
thing that could not be written from documentation.

### 15.3 One claim from this report is withdrawn

Part 12's stress table records:

> Two workers committing simultaneously (same agent, distinct Legs, capacity 2) →
> Reproduced directly: exactly two winners, distinct slots, distinct fences,
> `authority_epoch` unmoved — **Safe, empirically confirmed**

That was reproduced against `helpers/commitmentStore.js`, and it does not hold on
PostgreSQL. Eight concurrent commits against a capacity-2 agent produce **one** winner and
seven `SERIALIZATION_FAILURE`s: every attempt takes `FOR UPDATE` on the same Agent row, and
under SERIALIZABLE a blocked reader whose row was updated by a committed concurrent
transaction is aborted with `40001` rather than permitted to re-read. Two winners require
two rounds — which is §10.3.2's own disposition for a failed commit ("returns the pairing to
the next round with the cause recorded"), so the design is unaffected.

The safety half of the claim is intact and was re-confirmed on the live database: capacity
was never exceeded in any run, and after the next round the agent holds exactly two active
commitments in slots `[0,1]` with distinct fences and an unmoved `authority_epoch`.

Two further claims in the implementation report fell to the same cause and are withdrawn in
`PHASE_3_IMPLEMENTATION_REPORT.md` §22.3. The general lesson this review had already
recorded in its own risk framing — that the store model is not PostgreSQL — is now
demonstrated rather than warned about, and the model's *storm* results should no longer be
cited as statements about production. Its guard and fencing results are pure functions and
remain sound.

### 15.4 What the re-verification adds that this report could not

| Question this report left open | Answer |
|---|---|
| Does Prisma's `isolationLevel: "Serializable"` reach the connection? | **Yes.** `SHOW transaction_isolation` inside `runSerializable` returns `serializable`; a bare `$transaction` returns `read committed`, confirming B9's premise |
| Does `SELECT … FOR UPDATE` block? | **Yes.** The second acquirer obtained the row 3–4 ms *after* the first transaction released it |
| Does the planner choose the partial index? | **Yes.** Over 16 000 rows after `ANALYZE`, both the point lookup and the commit path's active-set read use `Commitment_agent_capacity_slot_active_key` |
| Does the `plpgsql` trigger compile and behave? | **Yes**, including the branch this report could only read: an insert naming a non-existent agent raises the trigger's `P0001` *before* the foreign key fires |
| Is G1 load-bearing, or is it redundant with the isolation level? | **Both, depending on the race.** When the world moves *before* the transaction begins, G1 aborts. When it moves *during*, SERIALIZABLE aborts first with `40001` — so G1 was additionally driven at READ COMMITTED, where the store declines to intervene and the guard is demonstrably what fences the write |
| Was TLC ever run? | **Now yes.** `commitment_c1.cfg` as checked in: complete state graph, 2 375 660 distinct states, diameter 21, no error. A reduced capacity-2 model: complete, 4 769 532 distinct states, no error. Capacity 3 did not complete and is reported as not completed |

### 15.5 What remains open after this disposition

1. TLC at capacity 3, and at capacity 2 with the checked-in configuration — resource-bound.
2. No migration has touched production or a production-shaped dump; interactive-transaction
   semantics on the pooled Neon endpoint are unconfirmed.
3. `tests/engine/helpers/lifecycleModel.js` carries the **identical** `exhaustive` defect as
   finding #1. It is Phase 15's artefact and was deliberately not changed here.
4. Guard **G5** has no counterpart in either formal model — neither models a cancelled Leg,
   so it is vacuous in both. Its evidence is the unit suite and the live run.

---

## Appendix — Commands and scripts run for this verification (reproducible)

```
npm run verify                                          # 47/871, fresh, twice
npx jest --selectProjects legacy --runInBand --forceExit # 22/169, fresh
npx prisma validate
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
grep -A12 'CREATE TABLE "ShardLeadership"' <generated>   # byte-diff against migration.sql
grep -A10 'CREATE TABLE "AgentFenceAudit"' <generated>
grep -B2 -A2 'capacitySlot' <generated>
grep -n "Commitment_agent_capacity_slot_active_key|Commitment_capacity_slot_non_negative|
         commitment_capacity_slot_in_bounds|INSERT INTO \"ShardLeadership\"" <generated>  # confirms hand-written
grep -rn "Serializable" node_modules/.prisma/client/index.d.ts   # confirms Prisma's own enum value
grep -n "@@map" prisma/schema.prisma                             # confirms no table renames
git diff Backend/src/services/task.service.js                    # read in full, comment-only confirmed
git diff Backend/src/cache/kv.js                                  # read in full
git diff --stat -- Backend/src/routes/ Backend/src/sockets/ Backend/server.js Backend/src/app.js \
  Backend/src/middlewares/ Backend/benchmark/                     # empty, confirmed
git diff --stat -- Backend/src/engine/TIERS.md Backend/src/engine/ARCHITECTURE.md  # empty
node -e '<planted a bare constant 47281 into live clock.js, confirmed gate:params catches it>'
node -e '<planted commitment/model.js -> cost/cDefer.js import, confirmed gate:tiers catches it>'
node -e '<manually reverted both plants, confirmed byte-identical restoration, re-ran verify clean>'
node -e '<tierAssertions.tierOf() queried directly for all 8 Phase 3 modules>'
node -e '<commitmentModel.js check() re-run at depth 9/12/15/20 at capacity 2 — states grow 8.6x>'
node -e '<perAgentFenceMaximum mutation re-run at capacity 1, depth 9 vs 12 — violations appear at 12>'
node -e '<clean, unmutated model re-run at capacity 1/2 well beyond shipped depth — zero violations>'
node -e '<idempotency namespace-disjointness probe, 2000 iterations, zero collisions>'
node -e '<RAISE EXCEPTION placeholder/argument count re-derived independently — both match>'
git diff --stat Backend/src/controllers/robots.controller.js Backend/src/controllers/tasks.controller.js \
  Backend/src/services/robot.service.js Backend/prisma/seed.js    # confirmed these are Phase 2 carryovers,
                                                                    # not claimed by and not touched by Phase 3
```

Working tree left clean; every planted violation was manually reverted and independently re-diffed to
confirm exact restoration. No scratch files remain in the repository (`tmp_verify/` was created and
removed during this session).

### Appendix B — commands run for the 2026-08-15 disposition (PART 15)

```
initdb -D <scratch>/pgdata3 -U pgverify -A trust -E UTF8 --locale=C
postgres -D <scratch>/pgdata3 -p 55432 -c listen_addresses=127.0.0.1   # disposable; 5432 untouched
psql -v ON_ERROR_STOP=1 -f <each migration.sql>      # 10 migrations, then all 21
psql -f schema-verify.sql       # pg_index / pg_constraint / pg_trigger / pg_proc read back
psql -f backstop.sql            # 17 writes bypassing the application → 17/17 correct verdicts
psql -f planner.sql             # EXPLAIN ANALYZE over 16 000 rows; partial index chosen
DATABASE_URL=…/robotx_full   node tools/verify/phase3LiveDatabase.js   # 82/82
DATABASE_URL=…/robotx_phase3 node tools/verify/phase3LiveDatabase.js   # 82/82 on Phases 1-3 alone
java -cp tla2tools.jar tlc2.TLC -config commitment_c1.cfg -workers auto commitment.tla   # complete, 0 errors
java -cp tla2tools.jar tlc2.TLC -config <capacity-2 reduced> -workers auto commitment.tla # complete, 0 errors
npx jest tests/engine/commitmentModelCheck.test.js                     # 31/31
npm run verify                                                          # 7 gates PASS; 145 suites / 6 378 tests
pg_ctl -D <scratch>/pgdata3 -m fast stop && rm -rf <scratch>/pgdata3
```

The cluster, its two databases, and TLC's 11 GB state queue were all created outside the
repository and removed afterwards. The shared Neon instance named by `DATABASE_URL` and the
developer's own cluster on port 5432 were never contacted.

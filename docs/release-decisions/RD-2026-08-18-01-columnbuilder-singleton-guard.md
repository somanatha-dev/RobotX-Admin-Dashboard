# RD-2026-08-18-01 — `columnBuilder.js` singleton-regime guard wiring

| | |
|---|---|
| **Recorded** | 2026-08-18 |
| **Owner** | Release owner |
| **Specification section** | §21.6 — the counterfactual evaluator's column-generation release gate |
| **Discharges** | `PHASE_11_REMEDIATION_AND_CLOSURE.md` **BLOCKER-1**, by the report's own path (b) |
| **Machine-readable record** | [`RD-2026-08-18-01-columnbuilder-singleton-guard.json`](RD-2026-08-18-01-columnbuilder-singleton-guard.json) |
| **Consumed by** | `Backend/tools/gates/checkColumnGeneration.js` |

---

## 1. The decision

> **Release-owner decision:** the current `columnBuilder.js` modification only wires the existing
> `assertSingletonRegime()` invariant guard into the column-builder execution path. It does not
> alter clustering rules, bundle-size policy, enumeration order, pruning rules, or kept-column
> selection. Therefore this change is outside the §21.6 counterfactual surfaces enumerated by the
> specification and does not require a counterfactual corpus/report for release gating. The §21.6
> gate remains fully enabled for changes that do affect those surfaces.

**This is not a general exemption.** It is not an exemption for `columnBuilder.js`, and it is not
an exemption for future changes to it. It applies to exactly one pair of file contents, named
below by their git object names, and to nothing else.

---

## 2. The exact change

**File:** `Backend/src/engine/plan/columnBuilder.js`

| | git object name |
|---|---|
| Content **before** the change (`HEAD`) | `748372cb054fbeda3e22d7c4813ad763ef76a199` |
| Content **classified** by this decision | `78fa8756381cd013d5cebf2e58895c84e4963fd6` |

```diff
@@ -149,10 +149,18 @@ function build(input) {
     }
   }

+  // The guard this module's own docstring claims — "`assertSingletonRegime()` refuses a set
+  // containing a multi-Leg column" — run over the set actually emitted. It shipped correct
+  // and unit-tested but uncalled, so the restriction rested on `build()` happening to take
+  // one `legId` per candidate rather than on the named check. Unreachable while that holds,
+  // which is the point: a guard proven live before it is relied on.
+  const regimeCheck = assertSingletonRegime(kept);
+  if (!regimeCheck.ok) problems.push(...regimeCheck.problems);
+
   const singletonRegime = kept.every((entry) => entry.singleton);

   return {
-    ok: true,
+    ok: regimeCheck.ok,
     columns: kept,
     pruned,
     generation: Object.freeze({
```

## 3. What the change actually does

Three effects, and no fourth:

1. It calls `assertSingletonRegime(kept)` — a function that already existed in this module,
   already exported, already unit-tested, and never called.
2. It appends that function's `problems` to the builder's `problems` array.
3. It makes the builder's `ok` field the guard's verdict rather than the constant `true`.

Effects 2 and 3 are **unreachable for any input `build()` accepts.** `build()` constructs every
column through `column.make({ agentId, legIds: [candidate.legId], … })` — one `legId` per
candidate, wrapped in a one-element array. `Backend/src/engine/plan/column.js:92` normalises that
array with `[...(source.legIds || [])].map(String).sort(compareStrings)`, which neither
de-duplicates nor expands, so `legIds.length === 1` for every entry `build()` can produce.
`assertSingletonRegime()` raises a problem only when `legIds.length !== 1`. It therefore returns
`{ ok: true, problems: [] }` for every column set this builder can emit, `ok` remains `true`, and
`problems` gains nothing.

The change's value is precisely that: the module's documented restriction — "`build()` emits one
column per (agent, Leg) pair and `assertSingletonRegime()` refuses a set containing a multi-Leg
column" — becomes enforced by the named check rather than resting on the incidental shape of the
loop that builds the input. The guard is proven live *before* Tier 2's multi-Leg work (T2-02) can
rely on it.

## 4. The §21.6 surfaces this change does NOT modify

§21.6 enumerates the gated surfaces; `tools/evaluator/counterfactual.js`'s `GATED_CHANGES`
encodes them. Each is examined against the diff above:

| §21.6 surface | Verdict | Evidence |
|---|---|---|
| **The column-generation clustering rule** | **Not modified** | No clustering step is touched. `build()` still emits exactly one column per surviving candidate; the loop at lines 89–128 is byte-identical. |
| **The bundle-size policy** | **Not modified** | This module sets and reads no bundle size. `plan.max_bundle_size` is not referenced before or after. |
| **The enumeration order** | **Not modified** | `comparePriced` and the `canonicalSort(priced, comparePriced)` call are byte-identical. The inserted code runs *after* ordering and after truncation, reads `kept`, and reorders nothing. |
| **The pruning rule** | **Not modified** | Every `pruned.push(...)` site — the unpriceable/inadmissible path at line 106 and the budget path at line 138 — is byte-identical. The inserted guard pushes to `problems`, never to `pruned`, and does not touch `bestPrunedGammaMilliCU`. |
| **Kept-column selection** | **Not modified** | `kept` is fully determined at line 150 by the pre-existing budget-truncation block and is never reassigned. The guard reads it and does not write it. |
| **A learned column proposer (§25.5)** | **Not present** | No proposer exists in this module or this repository. |
| **`plan.max_columns_per_round`** | **Unchanged** | `Backend/src/engine/config/register/appendixA.json` is not part of this change. |
| **`plan.max_bundle_size`** | **Unchanged** | As above. |

Because the change modifies none of the enumerated surfaces, the quantity §21.6 exists to protect
— the column-generation gap — cannot move. The generated set is the same set, in the same order,
with the same truncation and the same prunings.

## 5. Why the gate fired anyway, and why that is correct

`tools/gates/checkColumnGeneration.js` triggers on the **path** `Backend/src/engine/plan/columnBuilder.js`,
because §21.6's four surfaces are properties of the Column Builder and a path is the only proxy a
pre-execution gate can compute. A proxy is deliberately coarser than what it stands for. This
change is a case where the proxy fires and the surfaces are untouched — which is the case
`PHASE_11_REMEDIATION_AND_CLOSURE.md` BLOCKER-1 anticipated and assigned to a human.

The gate was **not narrowed** to resolve this. Its path list, its verdict logic, its delegation to
`counterfactual.gate()`, and `solve.max_generation_gap_regression` are all unchanged.

## 6. No corpus was manufactured

**No counterfactual corpus was created, and no counterfactual report was produced, for this
decision.**

`counterfactual.run()` requires a `resolve` bound to `solve/round.js` over a corpus of **stored
rounds**. No round has ever executed: `ENGINE_ENABLED` is `false` and no composition root is
started. Any corpus assembled to satisfy the gate would be fiction — a fabricated measurement of
exactly the quantity §21.6 exists to require an honest measurement of. The gate's own docstring
states this ("any corpus this gate manufactured would be fiction"), and it is why an
unaccompanied gated change fails here rather than passing on an empty measurement.

This decision does not assert that the column-generation gap was measured. It asserts that the
change cannot move it, on the structural grounds set out in §4 — a different claim, resting on
the diff rather than on data, and recorded as such.

## 7. The §21.6 gate remains enforced

Unchanged and still in force:

- `gate:columngen` remains in `npm run gates`, and `npm run verify` still reaches it.
- CI still runs it on every pull request with `--base "${{ github.event.pull_request.base.sha }}"`.
- All four gated source paths, both gated parameters, the register value comparison, the
  fail-closed indeterminate branch, and the `NO_MEASUREMENT` verdict are untouched.
- `tools/evaluator/counterfactual.js` was **not modified**. No threshold moved.

What the gate gained is the ability to *read* a decision like this one, under these constraints:

- A record is **pinned to two git blob names**, both resolved from git (`rev-parse <base>:<path>`
  and `hash-object`), never from the record itself. One byte of drift on either side and it stops
  applying.
- A record whose `surfacesAffected` is non-empty is **invalid**. A record that concedes a §21.6
  surface is affected is a waiver, and this gate implements no waivers.
- A record can suppress only a **source-path** trigger. It can never suppress a budget move,
  because a budget value changing *is* the heuristic change, with no proxy in between.
- A malformed, unreadable, or non-matching record suppresses nothing and is named in the gate's
  output.
- Every applied classification is printed on every run, passing or failing.

`Backend/tests/gates/checkColumnGeneration.test.js` holds these properties, including a mutation
test asserting that a one-byte edit to the classified file re-raises `REPORT_REQUIRED`.

## 8. Nature of this decision

**This is an explicit release-owner classification, not an engineering bypass.**

- The gate was not weakened, narrowed, disabled, or moved out of `npm run gates`.
- The counterfactual evaluator was not altered.
- No measurement was fabricated and no corpus was manufactured.
- The change was not reverted to obtain a green gate.
- The decision is recorded permanently, in version control, pinned to the content it classifies,
  and surfaced in the gate's own output on every run.

If `Backend/src/engine/plan/columnBuilder.js` changes again by so much as one byte, this record
ceases to apply, `gate:columngen` returns to `REPORT_REQUIRED`, and §21.6 must be discharged by a
new decision or — preferably, once rounds have executed — by a real evaluator run over a real
corpus.

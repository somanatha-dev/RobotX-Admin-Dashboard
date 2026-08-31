# Phase 15 — B-M: TLC run record (§7.3a)

> ## B-M REMAINS **OPEN**. EVIDENCE STATE: **NOT MEASURED / OPEN**.
>
> Six checked-in configurations were executed. **One closed. Two did not converge. Three failed.**
> Independent acceptance has not been given. **Nothing in this document discharges B-M**, and the
> `model_check_capacity_1_2_3` gate row is unchanged — it is GREEN and `[NOT PROVEN]` before this
> run record and after it.
>
> **This run record also reports two findings that did not exist before TLC was executed** —
> **X4**, a safety violation in `lifecycle.tla`'s own invariant set, and **X5**, a
> formal-verification configuration gap. Both are registered in
> [`PHASE_15_BLOCKERS.md`](PHASE_15_BLOCKERS.md). **Neither is folded into B-M** and neither is a
> Phase 15 implementation defect.

**Created:** 2026-08-31 · **Run date:** 2026-08-30 → 2026-08-31
**Tree:** digest `d033038cb261c3de…` (573 files), HEAD **`c27a75c`** — the Phase 15 freeze commit.
**Source tree state during every run: FROZEN and unmodified.** No `.tla`, no `.cfg`, no application
source, no schema, no test and no configuration was changed by this pass. See §11.

---

## 0. What this document is, and what it is not

| It is | It is not |
|---|---|
| The §7.3a written record for the six checked-in configurations, with the **raw TLC output retained verbatim** (§12) | A discharge of B-M. §7.3a item 10 — release-owner acceptance — has **not** been given |
| Evidence **input** to the release owner's §7.6 decision | The decision itself. Engineering does not accept this evidence and does not decide the gate is discharged |
| A factual report of what six commands printed | An interpretation of what the results *ought* to mean for the specification. §9 and §10 are referred out, not resolved here |

**Read `B1_EXTERNAL_INPUT_HANDOFF.md` §7 before using this document.** It defines §7.3a's ten
items, §7.4's list of what does not discharge the gate, §7.5's two structural gaps and §7.6's
ownership. Nothing here supersedes it.

---

## 1. The tool artefact — §7.3a item 1

| Field | Value |
|---|---|
| **Provenance / source** | `https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar` — the **v1.8.0 ("The Clarke") release** asset |
| **SHA-256** | `eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a` |
| **Size** | 4 487 757 bytes |
| **Release published** | **2026-08-21T16:05:58Z** (GitHub release metadata for `v1.8.0`) |
| **TLC self-report (every run)** | `TLC2 Version 2026.08.21.155922 (rev: 9787e65)` |
| **Manifest `Implementation-Version`** | `2.0 2026-08-21` |
| **Manifest `Build-TimeStamp`** | `2026-08-21T15:59:22.332Z` |
| **Manifest `X-Git-Revision`** | `9787e65714c37d94eebab40774bff401bd9f616d` |
| **Manifest `X-Git-Tag`** | **empty** — the jar is a master-branch CI build (`X-Git-BuildNumber: master__9787e65`, `X-Git-Commits-Count: 8901`), published *as* the v1.8.0 release asset |
| **Manifest `Built-By` / `Created-By`** | `runner` / `17.0.20+8 (Eclipse Adoptium)`, Apache Ant 1.10.12 |
| **Manifest `Implementation-Vendor`** | `Microsoft Corp.` |

**The SHA-256 was re-verified on 2026-08-31 against the artefact that produced every run below** —
it is the value the capture wrapper stamped into each log's `TLC_JAR_SHA256:` header, and it
matches a fresh `sha256sum` of the jar on disk.

> **Recorded precisely because §7.3a item 1 exists:** the artefact **does not self-report the
> string "1.8.0" anywhere.** Its own version string is a build date, and its manifest tag field is
> empty. "TLA+ 1.8.0" is a statement about *where the artefact came from* (the v1.8.0 release
> asset), corroborated by the SHA-256 — **not** a string the tool prints. Any future record that
> cites only "1.8.0" without the checksum is citing something the tool never said.

**The jar was NOT added to the repository.** It remains outside the tree, consistent with the
existing repository-state fact that `tla2tools.jar` is absent.

---

## 2. Runtime and machine — §7.3a items 2 and 3

| Field | Value |
|---|---|
| **JDK** | `java version "20.0.2" 2023-07-18`; Java(TM) SE Runtime Environment build `20.0.2+9-78`; Java HotSpot(TM) 64-Bit Server VM build `20.0.2+9-78`, mixed mode, sharing |
| **JVM vendor, as TLC reports it** | `Oracle Corporation 20.0.2 64bit` |
| **JVM flags used** | `-Xmx6g -XX:+UseParallelGC` |
| **TLC heap, as TLC reports it** | `5461MB heap and 64MB offheap memory` |
| **Workers** | `-workers auto` → **12 workers on 12 cores** in every run |
| **Machine** | LENOVO `21DJ` |
| **CPU** | 12th Gen Intel(R) Core(TM) i5-1235U — **10 physical / 12 logical cores**, base 1300 MHz. A hybrid P/E-core mobile part |
| **RAM** | **15.72 GB** total |
| **OS** | Microsoft Windows 11 Home Single Language, `10.0.26200` build 26200 (TLC reports `Windows 11 10.0 amd64`) |
| **Disk** | `C:` — 363 GB volume, **45 GB free** as measured 2026-08-31 after the runs. Physical device: Micron `MTFDKCD512TFK` (NVMe SSD) |
| **Contended?** | **YES — and materially.** This is a developer workstation, not dedicated compute. The machine **entered sleep during the `commitment_c2.cfg` run**; see §5.2. Other interactive work ran on the machine across the window |

> **§7.3a item 3 exists because "did not converge" is a statement about a machine as much as a
> model.** This machine is a 16 GB mobile laptop with a 363 GB volume of which 45 GB is free. The
> `commitment_c2.cfg` search had **23.6 GiB of on-disk state queue and was still growing** when it
> was stopped. **It is not established that these two configurations are infeasible; it is
> established that they are infeasible here.** Compute/Platform owns that judgement (§7.6), not
> Engineering.

**A measurement in the logs that must not be believed.** Every log carries a
`PEAK_JVM_WORKING_SET_MB:` line reading `0` or `11`. That is the capture wrapper's
`Process.PeakWorkingSet64` reading of the `java.exe` launcher shim at
`C:\Program Files\Common Files\Oracle\Java\javapath\java.exe`, **not** the JVM's working set — a
run that generated 1.6 billion states did not use 11 MB. **The value is retained verbatim in §12
because it is what the wrapper printed, and it is flagged here as an artefact.** The reliable
memory statement is TLC's own `5461MB heap and 64MB offheap memory`, and the reliable disk
statement is `PEAK_METADIR_MB`, which was measured by directory walk and is sound.

---

## 3. Operator and date — §7.3a item 4

| Field | Value |
|---|---|
| **Run dates** | 2026-08-30 (22:03 UTC) → 2026-08-31 (12:34 local, UTC+05:30) |
| **Executed by** | An automated agent session (Claude Code), acting **under the direction of the repository owner**, on the owner's workstation |
| **Named human** | **NOT SATISFIED.** §7.3a item 4 requires *"the operator (a named human)"*. This run has a directing owner but no signed operator attestation |

> **This is a recorded gap, not a discharged item.** §24.7 asks the safety evidence to be
> reproducible and attributable. The runs are reproducible — every command, the tool checksum, the
> machine and the constants are recorded here. **They are not yet attributed to a named human who
> has signed for them.** That signature is part of §7.6 acceptance and is the release owner's, not
> Engineering's, and not this document's to supply.

---

## 4. The provenance discrepancy in the historical 2026-08-15 record — §7.3a items 1 and 6

`formal/README.md:28-45` records two completed `commitment.tla` runs dated **2026-08-15** under
**"TLA+ 1.8.0"**. `B1_EXTERNAL_INPUT_HANDOFF.md` §7.1 already recorded that the constants in that
table do not match the files it names. **This pass adds a second, independent discrepancy and
partially resolves the first. Neither is decided here.**

### 4.1 The tool-provenance discrepancy — NEW, and it is arithmetic

| Fact | Source |
|---|---|
| The historical run is dated **2026-08-15** | `formal/README.md:28` |
| It is labelled **TLA+ 1.8.0** | `formal/README.md:31` |
| The **v1.8.0 release was published 2026-08-21T16:05:58Z** | GitHub release metadata, read 2026-08-30 |
| The v1.8.0 `tla2tools.jar`'s own **build timestamp is 2026-08-21T15:59:22.332Z** | Jar manifest, read 2026-08-31 (§1) |
| The **immediately preceding** TLA+ release, v1.7.4, was published **2024-08-05T20:16:41Z** | GitHub release metadata, read 2026-08-30 |

**Therefore: on 2026-08-15 the released v1.8.0 artefact did not exist.** It was built six days
later and published six days and some hours later. A run dated 2026-08-15 **cannot** have used the
released v1.8.0 binary, and the newest published release available to it was **v1.7.4, from
2024-08-05**.

**What this does and does not establish.** It does **not** establish that the historical run is
wrong, or that its numbers are wrong. A pre-release build, a nightly, a locally built jar or a
mislabelled version string are all consistent with the record. **What it establishes is that the
"1.8.0" label cannot be taken at face value**, and therefore that **the historical run's tool is
NOT identified** — which is exactly what §7.3a item 1 exists to prevent. The run has no recorded
checksum, so there is no way to close this from the record that exists.

> **The current runs are not affected by this.** Their tool is identified by SHA-256, and that
> checksum was verified against the artefact that produced them.

### 4.2 The constants discrepancy — PARTIALLY RESOLVED by an exact numeric match, and still the owner's call

`formal/README.md:36-41` records the closed 48-second run as **`commitment_c1.cfg` — as checked
in — with `Legs`/`Workers`/`MaxFence` = 3 / 2 / 5**. The checked-in `commitment_c1.cfg` on this
tree is **2 / 2 / 4**. The 3 / 2 / 5 triple belongs to `commitment_c2.cfg`, whose README row
carries the **opposite** outcome. That is §7.1's recorded ambiguity.

**This pass ran `commitment_c1.cfg` exactly as checked in (2 / 2 / 4) and obtained:**

| Quantity | Historical README row for `commitment_c1.cfg` | **This run, `commitment_c1.cfg` as checked in** |
|---|---|---|
| States generated | 17 991 520 | **17 991 520** |
| Distinct states | 2 375 660 | **2 375 660** |
| Graph diameter | 21 | **21** |
| Result | no error found | **no error found** |
| Wall clock | 48 s | 25 s (TLC) / 26.7 s (wrapper) |
| Constants **recorded** | 3 / 2 / 5 | — |
| Constants **actually used** | — | **`Legs = {l1,l2}`, `Workers = {w1,w2}`, `Capacity = 1`, `MaxFence = 4`** |

**All three state-graph quantities match exactly.** A state count, a distinct-state count and a
diameter agreeing to the digit across two independent executions is strong evidence that the
historical closed run used **the checked-in `commitment_c1.cfg` (2 / 2 / 4)**, and that the
README's "3 / 2 / 5" annotation beside it is the transcription error — not the file name.

**It does not resolve the second README row.** That row records a *"reduced capacity-2"* run at
**2 / 2 / 4** producing 37 633 116 states. **2 / 2 / 4 is the checked-in `c1` triple**, and this
pass measured 2 / 2 / 4 as producing 17 991 520 states. **So that row's constants cannot be right
either**, and what configuration produced 37 633 116 states is **not established**.

> **This is evidence for the release owner's §7.1 / §7.6 decision, and it is not that decision.**
> §7.3a item 6 requires the constants actually used, quoted verbatim; for the historical run they
> still cannot be established from the retained record, and §7.1's rule is explicit that where they
> cannot, **the run cannot be counted toward the six — a `NOT MEASURED` answer, not a smaller
> number of runs remaining.** Whether the numeric match above is sufficient to overturn that is the
> release owner's call. **This pass does not count the historical run toward the six**, and the
> six results in §5 stand on their own without it.

**`formal/README.md` was NOT edited.** §7.4 forbids editing `.cfg` and `.tla`; the README is the
historical record of a run this repository did not observe, and rewriting it would destroy the
evidence rather than correct it. The correction lives here.

---

## 5. Results — the six checked-in configurations — §7.3a items 5, 6 and 9

**Every run below executed the configuration EXACTLY AS CHECKED IN.** No `.cfg` and no `.tla` was
modified, before, during or after. `formal/` is outside the source-digest scope (§7.5 gap 2), so
that statement is not machine-enforced — it is asserted here, and the tree was frozen at `c27a75c`
throughout.

**Command form, run from `formal/`** — the `formal/README.md:21-24` command plus capture flags:

```
java -Xmx6g -XX:+UseParallelGC -jar <tla2tools.jar> -config <CFG> -workers auto \
     -metadir <scratch>/meta_<name> -noTE <MODULE>.tla
```

`-metadir` redirects TLC's state files out of the source tree. `-noTE` suppresses generation of a
trace-exploration spec, **which is what keeps a failing run from writing a `.tla` file into
`formal/`**. Neither flag changes the model, the configuration or the checked properties.

### 5.1 The six authoritative results

| # | Configuration | Constants **as checked in**, verbatim | Graph **closed**? | States generated | Distinct | Depth | Wall | Verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | `commitment_c1.cfg` | `Legs = {l1,l2}` · `Workers = {w1,w2}` · `Capacity = 1` · `MaxFence = 4` | **YES — complete state graph, 0 left on queue** | 17 991 520 | 2 375 660 | 21 | 25 s | **PROVEN / PASS — exhaustive.** `Model checking completed. No error has been found.` |
| 2 | `commitment_c2.cfg` | `Legs = {l1,l2,l3}` · `Workers = {w1,w2}` · `Capacity = 2` · `MaxFence = 5` | **NO** | 1 650 642 056 | 287 362 834 | ≥ 20, still at 20 | 31 204 s wall / **~6 500 s compute** | **UNKNOWN — did not converge.** Killed at budget with **126 025 013 states still on queue** and a **23.6 GiB** disk queue still growing |
| 3 | `commitment_c3.cfg` | `Legs = {l1,l2,l3,l4}` · `Workers = {w1,w2}` · `Capacity = 3` · `MaxFence = 6` | **NO** | 107 713 972 | 32 163 551 | ≥ 15, still at 15 | 247.4 s | **UNKNOWN — did not converge.** Process terminated abnormally (exit `-1`) with **21 066 205 states on queue**; **no TLC error and no completion line was printed** |
| 4 | `lifecycle_c1.cfg` | `Legs = {l1,l2}` · `Capacity = 1` · `MaxTicks = 3` | **NO** | 220 | 79 | 6 | 2.1 s | **FAIL — `Error: Deadlock reached.`** Aborted at depth 6 with 38 states on queue. **See §9** |
| 5 | `lifecycle_c2.cfg` | `Legs = {l1,l2,l3}` · `Capacity = 2` · `MaxTicks = 3` | **NO** | 1 041 | 277 | 6 | 2.0 s | **FAIL — `Error: Deadlock reached.`** Aborted at depth 6 with 140 states on queue. **See §9** |
| 6 | `lifecycle_c3.cfg` | `Legs = {l1,l2,l3,l4}` · `Capacity = 3` · `MaxTicks = 3` | **NO** | 4 770 | 1 012 | 6 | 2.1 s | **FAIL — `Error: Deadlock reached.`** Aborted at depth 6 with 536 states on queue. **See §9** |

**Capacity scope, stated plainly as §7.3a item 9 requires:**

| Capacity | `commitment.tla` | `lifecycle.tla` |
|---|---|---|
| **1** | **COVERED — exhaustive, no violation** | **NOT COVERED** — run aborts on deadlock at depth 6 |
| **2** | **NOT COVERED** — search did not converge | **NOT COVERED** — run aborts on deadlock at depth 6 |
| **3** | **NOT COVERED** — search did not converge | **NOT COVERED** — run aborts on deadlock at depth 6 |

**One of six configurations closed.** The gate's statement is an exhaustive model check of both
modules at capacities 1, 2 and 3. **Five sixths of that statement has no evidence, and the
lifecycle half has none at any capacity.**

### 5.2 `commitment_c2.cfg` — the machine-sleep disclosure

**This must be read before the 31 204-second wall clock is quoted anywhere.**

| Field | Value |
|---|---|
| Budget | 7 200 s (2 h) |
| `START_UTC` | `2026-08-30T22:05:46.5284889Z` |
| `END_UTC` | `2026-08-31T07:00:22.3376099Z` |
| `WALL_CLOCK_SEC` | **31 204.2** (8 h 40 m) |
| `OUTCOME` | `TIMEOUT_KILLED_AT_BUDGET` |

**The machine slept mid-run.** TLC's own progress lines are emitted at 60-second intervals and are
continuous from `03:35:47` to `05:22:13` local (UTC+05:30), then **stop for approximately seven
hours**, then resume with `Checkpointing completed at (2026-08-31 12:27:38)` followed by three
further progress lines at `12:27:38`, `12:28:38` and `12:29:38`. The gap is visible in the raw
output at §12.2 and was not edited out.

**Consequences, all of which cut in the same direction:**

- **The 31 204 s wall clock is not compute.** Actual TLC progress spans roughly **6 386 s before
  the gap plus ~120 s after it — about 6 500 s**, against a nominal 7 200 s budget. **The run did
  not consume its own budget.**
- **The kill was triggered by wall clock, not by compute exhaustion.** The wrapper's deadline
  elapsed while the machine was asleep; the process was killed on wake.
- **This does not soften the UNKNOWN verdict — it hardens the resource observation.** After
  ~108 minutes of actual search the run had **287 million distinct states found, 126 million still
  on the queue, and 23.6 GiB of disk queue still growing.** The queue was growing monotonically
  across the entire window. There is no indication of approaching convergence.
- **It does mean the run is not a clean measurement of the 2-hour budget**, and a re-run on
  dedicated, sleep-inhibited compute would produce a cleaner number. That is Compute/Platform's
  call (§7.6).

### 5.3 `commitment_c3.cfg` — abnormal termination, cause NOT determined

| Field | Value |
|---|---|
| Budget | 7 200 s |
| `WALL_CLOCK_SEC` | **247.4** |
| `OUTCOME` | `PROCESS_EXITED` |
| `EXIT_CODE` | **`-1`** |
| `PEAK_METADIR_MB` | **3 018.1** (2.95 GiB accumulated in ~4 minutes) |
| Last progress line | `Progress(15) … 107,713,972 states generated … 21,066,205 states left on queue` |
| TLC error line | **none** |
| TLC completion line | **none** |
| stderr | **empty** |
| JVM crash log (`hs_err_pid*`) | **none found** |

**The process died 247 seconds into a 7 200-second budget, without TLC printing either an error or
a completion.** No `OutOfMemoryError`, no `Deadlock`, no invariant violation, no `Finished in`.

**The cause is not established and is not guessed at here.** What is recorded is the surrounding
state: the run began **immediately after `commitment_c2.cfg` was killed**, at which point that
run's **23.6 GiB metadir was still on disk**; `c3` then accumulated a further 2.95 GiB in four
minutes on a volume with 45 GB free as measured after the fact. Disk pressure is *consistent with*
what was observed and is **not proven** — TLC reports disk exhaustion explicitly when it detects
it, and it printed nothing.

**Either way the verdict is the same: UNKNOWN — did not converge.** An abnormally terminated
search is not a failure of the model and is not a pass. It is an unfinished search, reported as
one. **`commitment_c3.cfg` should be re-run on provisioned compute with a clean volume before any
conclusion about capacity 3 is drawn.**

---

## 6. Property coverage — §7.3a item 7

**The gate's statement is "every §24.2 safety and liveness property".** This is what each run
actually covered, property by property.

### 6.1 What the checked-in configurations declare

| Configuration | `INVARIANT` | `PROPERTY` |
|---|---|---|
| `commitment_c{1,2,3}.cfg` | `Safety` | **none declared** |
| `lifecycle_c{1,2,3}.cfg` | `Safety` | `TerminalIsFinal`, `Liveness` |

The commitment configurations assert no liveness **by design**, and each `.cfg` says why in its own
header: §24.2's two liveness properties are properties of the lifecycle machine and its durable
timers, and *"a liveness property asserted over a model with no timers would be checking the model
rather than the design"* (`commitment.tla:380-386`). They are asserted in the lifecycle
configurations, where the timers exist.

### 6.2 `commitment.tla` — `Safety` conjuncts (`commitment.tla:366-375`)

`TypeOK` · `AtMostCapacity` · `DistinctSlots` · `DistinctFences` · `TerminalIsFinal` ·
`CustodyNeverLost` · `OnlyHardCommitments` · `NoIllegalCommits` · `AllActiveCommandable`

| Capacity | Coverage |
|---|---|
| **1** | **All nine, exhaustively, over the complete state graph** (17 991 520 states, diameter 21, 0 on queue). No violation |
| **2** | **Covered only over the 287 362 834 distinct states reached before the run stopped.** 126 025 013 states were never expanded. **This is not coverage** |
| **3** | **Covered only over the 32 163 551 distinct states reached before termination.** 21 066 205 never expanded. **This is not coverage** |

### 6.3 `lifecycle.tla` — declared properties (`lifecycle.tla:410-449`)

`Safety` = `TypeOK` · `CapacityRespected` · `CustodyNeverCancelled` · `NoCommitmentOnTerminal` ·
**`CustodyMatchesState`** · `IndeterminateEscalates` · `TaskCompletionIsHonest`
`Liveness` = `EveryLegSettles` · `CustodyNeverLost` · `QueuedLegsProgress`
plus the step property `TerminalIsFinal`.

| Property | Capacity 1 | Capacity 2 | Capacity 3 |
|---|---|---|---|
| **`Safety` (all seven conjuncts)** | **NOT ESTABLISHED** — the authoritative run aborts on deadlock at depth 6 having explored 79 distinct states. Under the §12.7 secondary diagnostic, **`Safety` is VIOLATED at depth 9** | **NOT ESTABLISHED** — aborts at depth 6, 277 states. Secondary: **VIOLATED at depth 9** | **NOT ESTABLISHED** — aborts at depth 6, 1 012 states. Secondary: **VIOLATED at depth 9** |
| **`TerminalIsFinal`** | **NO VERDICT REACHED** | **NO VERDICT REACHED** | **NO VERDICT REACHED** |
| **`Liveness` (all three conjuncts)** | **NO VERDICT REACHED** | **NO VERDICT REACHED** | **NO VERDICT REACHED** |

> **"No verdict reached" is not "passed".** TLC printed
> `Implied-temporal checking--satisfiability problem has 6 / 9 / 12 branches` in each run, which
> records that the temporal tableau was **constructed**. Every run then terminated — on the
> deadlock abort in the authoritative runs, on the invariant violation in the secondary ones —
> **before any liveness result was produced.** The absence of a temporal-property error in these
> logs is the absence of a search, not the absence of a counterexample. **No lifecycle liveness
> property has been evaluated by TLC at any capacity.**

### 6.4 The known correspondence gap — **G5**

**Guard G5 (cancellation, purpose-conditioned) has NO COUNTERPART IN EITHER MODEL.** Neither
`commitment.tla`'s `GuardsPass` nor `Backend/tests/engine/helpers/commitmentModel.js` models a
cancelled Leg, so **G5 is vacuous in both**.

**A completed TLC run does not cover G5 — including the one run in this record that did complete.**
`commitment_c1.cfg`'s exhaustive pass at capacity 1 says nothing whatever about G5. Its evidence is
`commitmentGuards.test.js` (including the counterfactual that an unqualified guard would block its
own mandated recovery path) plus the live-database run — `formal/README.md:130-134`.

**This gap is restated here rather than left to be rediscovered, exactly as §7.3a item 7 and §7.4
require. It is unchanged by this pass and is not a new finding.**

---

## 7. Boundedness — §7.3a item 8 — **NOT ACCEPTED**

Both models are bounded, and the bounds are visible in the constants:

| Module | Bound | Effect |
|---|---|---|
| `commitment.tla` | `MaxFence` = 4 / 5 / 6 | Bounds the fence counter, which would otherwise advance without limit |
| `lifecycle.tla` | `MaxTicks` = **3 in all three configurations** | Bounds timer firings. `TimerFires(l)` requires `ticks < MaxTicks`, so **at most three timer events occur in any behaviour, across all Legs combined** |

**Two observations recorded for the safety engineer, neither of them a decision:**

1. **`MaxTicks = 3` is a global budget, not a per-Leg one.** `ticks` is a single scalar incremented
   by every `TimerFires`. At `Capacity = 3` with four Legs, three timer firings cannot exercise a
   timeout on each Leg. **Whether a three-tick lifecycle is still the system is a safety
   judgement.**
2. **`MaxTicks` does not scale with `Capacity`, while `Legs` does.** `Legs` is `Capacity + 1` in
   every configuration, so the ratio of Legs to available timer events worsens as capacity rises.

> **§7.3a item 8 requires boundedness to be "explicitly accepted", signed rather than assumed, and
> it is a safety question and not an engineering convenience.** **It has not been accepted.** No
> safety engineer has signed for either bound. **This item is OPEN**, and it is open independently
> of whether the searches ever close — a completed exhaustive run of a bounded model is a
> completed run *of that bound*.

---

## 8. Release-owner acceptance — §7.3a item 10 — **NOT GIVEN**

**No acceptance decision exists.** Specifically, all of the following remain open and are the
release owner's (§7.6):

| Open decision | Why it is not Engineering's |
|---|---|
| Whether the one closed run (`commitment_c1.cfg`) is accepted | The runs are input to a decision; they are not the decision |
| Whether the historical 2026-08-15 run may be counted toward the six, given §4.1 and §4.2 | §7.1 reserves this explicitly to the release owner |
| Whether a named human signs as operator for these runs (§3) | §24.7 attributability |
| Whether the bounds are accepted (§7) | Safety engineer's judgement per §7.6 |
| Whether `commitment_c2/c3` are re-run on provisioned compute | Compute/Platform per §7.6 |
| What is done about **X4** and **X5** | Safety / specification authority — see §9, §10 |

**`establishedByCommand` has NOT been removed and must not be.** §7.4 is explicit: *"Only after all
six exhaustive runs actually complete may `establishedByCommand` be removed from the gate."* One
completed. **Five have not.**

**The status machinery is intact and was not touched by this pass.** `gates.js`'s
`model_check_capacity_1_2_3` row still carries `establishedByCommand: false` and its
`notEstablishedReason`, and `verdict.js` still prints the `[NOT PROVEN]` annotation. No source file
was modified.

> **One sentence in that `notEstablishedReason` is now factually out of date and is deliberately
> left alone:** it says *"`lifecycle.tla` has never been run under TLC"*. As of this record,
> `lifecycle.tla` **has** been run under TLC — and it **failed**. Correcting the string is a source
> change to `Backend/src/engine/cutover/gates.js`, which is inside the source-digest scope and
> inside the frozen implementation. **The annotation understates the gap rather than overstating
> it, so leaving it is conservative**, and the correction is recorded here and in
> `PHASE_15_BLOCKERS.md` for whoever next has authority to touch that file. **Do not edit it to
> "tidy" this record.**

---

## 9. The lifecycle deadlock abort — finding **X5**

**Classification: FORMAL-VERIFICATION CONFIGURATION / DOCUMENTATION GAP. Requires an explicit
owner decision. It is NOT the safety finding in §10 and must not be merged with it.**

### 9.1 What happens

All three checked-in lifecycle configurations abort on **TLC's default deadlock check** at depth 6,
long before the declared properties can be evaluated. The counterexample is the same shape in each:
every Leg is `Cancel`led in turn until all are `CANCELLED`, at which point no action is enabled.

```
Error: Deadlock reached.
State 1: <Initial predicate>          legState = (l1 :> "QUEUED"    @@ l2 :> "QUEUED")
State 2: <Cancel(l1) …>               legState = (l1 :> "CANCELLED" @@ l2 :> "QUEUED")
State 3: <Cancel(l2) …>               legState = (l1 :> "CANCELLED" @@ l2 :> "CANCELLED")
```

Every action in `Next` requires `legState[l] \notin TerminalLegStates` for some `l`, and
`"CANCELLED" \in TerminalLegStates`. Once every Leg is terminal, no successor state exists.

### 9.2 Why this is a configuration/documentation gap and not obviously a model defect

**The model's terminal states are absorbing by design, and the specification says so.** `Safety`'s
own `TerminalIsFinal` conjunct asserts exactly that a terminal Leg never changes state
(`lifecycle.tla:377-379`). A behaviour in which every Leg has reached a terminal state is the
**intended end of a behaviour**, not a stuck system.

**TLC's default deadlock check cannot tell those apart.** It reports any state with no successor.
Neither `CHECK_DEADLOCK FALSE` nor a stuttering self-loop is present in any of the three `.cfg`
files, so the check is on.

### 9.3 The consequence, which is the part that matters

**The authoritative lifecycle runs never evaluate the properties they declare.** Each aborts at
depth 6 having explored 79 / 277 / 1 012 distinct states. `INVARIANT Safety`, `PROPERTY
TerminalIsFinal` and `PROPERTY Liveness` are all declared and **none of them reaches a verdict**.

**So the checked-in lifecycle configurations, run exactly as `formal/README.md` instructs, cannot
produce evidence for the gate they exist to serve.** That is the gap.

### 9.4 What was NOT done

- **`CHECK_DEADLOCK` was not changed.** No `.cfg` was edited. §7.4 forbids it and the tree is frozen.
- **`formal/README.md` was not edited.**
- **No stuttering action was added to `lifecycle.tla`.**
- **The secondary `-deadlock` runs are NOT treated as authoritative.** See §9.5.

### 9.5 The secondary diagnostic runs, and their exact standing

To determine whether the deadlock abort was masking anything, each lifecycle configuration was
re-run **once** with TLC's `-deadlock` flag, which disables the deadlock check **on the command
line only**. **No file was modified.** These runs are recorded verbatim at §12.7–§12.9.

> ### The `-deadlock` runs are SECONDARY DIAGNOSTIC EVIDENCE. They are NOT authoritative and do NOT discharge anything.
>
> They were run under a flag the checked-in configuration does not specify, so **they check a
> different thing than the configuration under check.** §24.2's own argument — quoted in all six
> `.cfg` headers — is that *"the configuration under check is itself part of the requirement"*.
> **A run that alters the configuration is evidence about a different run.**
>
> Their value is diagnostic and it is real: they establish that the deadlock abort **was** masking
> something, and what it was masking is §10. **That is why they were run and why they are
> retained.** It is not a licence to quote them as a result for `lifecycle_c{1,2,3}.cfg`.

### 9.6 The decision required, and who owns it

**An explicit owner decision is required. Engineering must not choose on its own.** The options are
not equivalent and at least one of them is a specification statement:

| Option | What it asserts | Who may decide |
|---|---|---|
| Add `CHECK_DEADLOCK FALSE` to the three `.cfg` files | That "all Legs terminal" is an accepted end-state and deadlock freedom is not a §24.2 property of this model | Safety engineer + release owner |
| Add an explicit stuttering/termination action to `lifecycle.tla` | A change to the specification's transition relation | Frozen-specification owner |
| Treat deadlock freedom as a genuine §24.2 obligation and change the model to satisfy it | That the current model is defective | Frozen-specification owner + safety engineer |
| Accept that the lifecycle configurations produce no evidence | That the gate's lifecycle half stays permanently unevidenced | Release owner |

**Registered as X5 in [`PHASE_15_BLOCKERS.md`](PHASE_15_BLOCKERS.md).**

---

## 10. The `CustodyMatchesState` safety violation — finding **X4**

**Classification: SPECIFICATION / FORMAL MODEL / SAFETY ENGINEERING.**
**This is a specification-level finding requiring safety-engineering and spec-owner judgement. It
is NOT an implementation convenience, NOT a Phase 15 implementation defect, and NOT part of B-M.**

### 10.1 How it was found

The deadlock abort (§9) hides it. Under the secondary `-deadlock` diagnostic runs, **all three
capacities produce `Error: Invariant Safety is violated.` at depth 9** — the identical trace at each
capacity, on Leg `l1`, with the other Legs untouched in `QUEUED`.

| Configuration | Secondary run result | States generated | Distinct | Depth |
|---|---|---|---|---|
| `lifecycle_c1.cfg` `-deadlock` | `Invariant Safety is violated` | 1 108 | 296 | 9 |
| `lifecycle_c2.cfg` `-deadlock` | `Invariant Safety is violated` | 4 853 | 1 051 | 9 |
| `lifecycle_c3.cfg` `-deadlock` | `Invariant Safety is violated` | 21 078 | 3 812 | 9 |

**This is an independent finding.** It is not the deadlock, it is not caused by the deadlock, and
removing the deadlock check did not create it — the violating state is reachable in the model as
checked in, at depth 9, and the checked-in configuration simply stops at depth 6 before reaching it.

### 10.2 The exact trace

```
Plan → Offer → Accept → Depart → ArrivePickup → Load → CancelWithCustody → TimerFires
```

Reproduced verbatim from §12.7, with the violating state in full:

| State | Action | `legState[l1]` | `custody[l1]` | `hardCommitted[l1]` | `ticks` |
|---|---|---|---|---|---|
| 1 | `<Initial predicate>` | `QUEUED` | `NONE` | `FALSE` | 0 |
| 2 | `Plan(l1)` — `lifecycle.tla:148` | `PLANNED` | `NONE` | `FALSE` | 0 |
| 3 | `Offer(l1)` — `:158` | `OFFERED` | `NONE` | `FALSE` | 0 |
| 4 | `Accept(l1)` — `:166` | `ACCEPTED` | `NONE` | **`TRUE`** | 0 |
| 5 | `Depart(l1)` — `:184` | `EN_ROUTE_PICKUP` | `NONE` | `TRUE` | 0 |
| 6 | `ArrivePickup(l1)` — `:189` | `AT_PICKUP` | `NONE` | `TRUE` | 0 |
| 7 | `Load(l1)` — `:194` | `LOADED` | **`HELD`** | `TRUE` | 0 |
| 8 | `CancelWithCustody(l1)` — `:275` | **`ABORTING`** | `HELD` | `TRUE` | 0 |
| 9 | `TimerFires(l1)` — `:316` | **`STRANDED_OBSTRUCTING`** | **`HELD`** | `TRUE` | 1 |

**State 9 violates `CustodyMatchesState`.**

### 10.3 The contradiction, stated exactly

Four definitions in `lifecycle.tla` cannot all be right.

**1. `CustodyMatchesState` — `lifecycle.tla:392-394`, a conjunct of `Safety`:**

```tla
CustodyMatchesState ==
    \A l \in Legs :
        custody[l] = "HELD" => legState[l] \in (CustodyBearingStates \cup { "ABORTING" })
```

with `CustodyBearingStates == { "LOADED", "EN_ROUTE_DROP", "AT_DROP" }` (`:80`). **The permitted
set while custody is `HELD` is exactly `{LOADED, EN_ROUTE_DROP, AT_DROP, ABORTING}`. Neither
`STRANDED_OBSTRUCTING` nor `STRANDED_SAFE` is in it.** Its comment cites §2.5: *"custody is HELD
only while the Leg is in a state that bears it."*

**2. `TimerFires` — `lifecycle.tla:340-342`, the `recover.abort_budget` disjunct:**

```tla
\/ /\ legState[l] = "ABORTING"         \* recover.abort_budget -> force STRANDED
   /\ legState' = [ legState EXCEPT ![l] = "STRANDED_OBSTRUCTING" ]
   /\ UNCHANGED << custody, hardCommitted, taskState, everHeld >>
```

**It moves `ABORTING → STRANDED_OBSTRUCTING` and leaves `custody` UNCHANGED.** From a state where
custody is `HELD` — which `CustodyMatchesState` permits for `ABORTING` — it lands in a state where
`HELD` is forbidden. **This is the transition the trace takes.**

**3. `Strand(l, class)` — `lifecycle.tla:291-295`, a SECOND route to the same violation:**

```tla
Strand(l, class) ==
    /\ legState[l] = "ABORTING"
    /\ class \in ObstructionClasses
    /\ legState' = [ legState EXCEPT ![l] = StrandingStateFor(class) ]
    /\ UNCHANGED << custody, hardCommitted, taskState, everHeld >>
```

`StrandingStateFor` maps to `STRANDED_SAFE` or `STRANDED_OBSTRUCTING` (`:123`). **`Strand` also
carries `HELD` custody into a stranded state.** So the violation is not a single stray disjunct —
**there are two independent transitions into stranding, and both preserve `HELD`.**

**4. `Recovered(l)` — `lifecycle.tla:301-306`, which ASSUMES the state the invariant forbids:**

```tla
Recovered(l) ==
    /\ legState[l] \in { "STRANDED_SAFE", "STRANDED_OBSTRUCTING" }
    /\ custody' = [ custody EXCEPT ![l] = IF custody[l] = "HELD" THEN "RELEASED" ELSE custody[l] ]
    …
```

**`Recovered` is guarded on the Leg being stranded, and its custody update exists specifically to
handle the case where that stranded Leg holds custody.** Its comment (`:298-300`) says so: *"a
stranding is resolved by physical intervention. The Leg leaves the stranded state; custody, if
held, is accounted for."*

**Under `CustodyMatchesState`, `Recovered`'s `IF custody[l] = "HELD"` branch is unreachable — dead
code.** Under `Strand` and `TimerFires`, it is not only reachable, it is the whole point of the
action.

### 10.4 The contradiction in one sentence

**`Strand` and `TimerFires` construct stranded-with-custody states; `Recovered` is written to
resolve them; and `CustodyMatchesState` declares they cannot exist.** Two of the model's actions
and one of its invariants disagree about whether a stranded Leg may still be holding the goods.

For contrast, `AbortResolved` (`:284-289`) has the identical `IF custody[l] = "HELD"` shape but
fires **from `ABORTING`**, which `CustodyMatchesState` explicitly permits. **That one is
consistent.** The inconsistency is specifically about the stranded states.

### 10.5 What must NOT be concluded from this — recorded deliberately

> **Physically retaining custody while stranded may well be the semantically correct behaviour.**
> A robot that has broken down mid-delivery **is still holding the parcel.** Releasing custody in
> the model because an invariant says so would assert that the goods stop being the system's
> responsibility at the moment it becomes least able to discharge it — and §18.6's own comment
> that recovery *"is impossible without physical intervention"* points the same way, as does
> `Recovered` existing at all.
>
> **This document does not decide that question, and no one may decide it by reference to whichever
> repair is smaller.** The plausible readings are not equivalent:
>
> | Reading | Change implied | Consequence |
> |---|---|---|
> | The **invariant** is too narrow | `CustodyMatchesState` should admit the stranded states | Makes `Recovered`'s HELD branch live and correct. **Weakens a safety invariant** — must be justified against §2.5, not adopted for convenience |
> | The **transitions** are wrong | `Strand` and `TimerFires` must release or dispute custody on entry to stranding | Makes `Recovered`'s HELD branch dead code. **Asserts custody ends without physical handover** |
> | The **state set** is wrong | Stranded states should be modelled as custody-bearing | A change to §4.3's state classification |
> | Something else | — | — |
>
> **Each is a different safety claim about what the system owes for goods it is physically holding.
> This is safety-engineering and specification work. It is not a model-checking fix, not an
> implementation convenience, and not a Phase 15 defect.**

### 10.6 Why this is NOT a Phase 15 implementation defect

**`lifecycle.tla` being checked into this repository does not make its contents Phase 15
implementation.** The module is a **transcription of the specification into a modelling language** —
`formal/README.md:106-109` says exactly that: its value is that *"a safety engineer who has read
§4.4 can confirm that the transition relation is the one §4.4 describes, without reading any
JavaScript."*

**So a contradiction inside it is one of two things, and both are specification-level:**

1. The transcription faithfully reflects §2.5 / §4.3 / §18.6, and **the specification itself is
   internally inconsistent** about custody during stranding; or
2. The transcription is unfaithful, and **the specification must be consulted to say which of the
   four definitions is the wrong one.**

**Determining which requires reading the frozen specification, which Engineering may not amend.**
`NEXT_GENERATION_ASSIGNMENT_ENGINE.md` is FROZEN — the same constraint that keeps **X3** open.

**No repository implementation change can legitimately close X4.** Editing `lifecycle.tla` to make
TLC go green would be writing specification under the guise of fixing a model, and it would destroy
the evidence that the disagreement exists. **Registered as X4 in
[`PHASE_15_BLOCKERS.md`](PHASE_15_BLOCKERS.md).**

### 10.7 What this does NOT say about the shipped implementation

**No claim is made here about `Backend/src/engine/lifecycle/`.** This pass ran a model checker
against a TLA+ module. It did not run the executable checkers, did not run a live database, and did
not inspect the shipped transition tables.

**Whether the shipped implementation exhibits the same disagreement is UNKNOWN and was not
investigated** — investigating it would mean reading and possibly changing frozen implementation,
which this pass is not permitted to do. **It is a question X4's owner should ask**, and it is
recorded here so that it is asked rather than assumed either way.

---

## 11. Retention — §7.3a "the run is not the evidence until it is written down"

### 11.1 The exact requirement

`B1_EXTERNAL_INPUT_HANDOFF.md` §7.3a, verbatim:

> **Retention:** the raw output of every run is kept as release evidence alongside items 1–10.
> A summary written from memory after the fact is not the raw evidence and does not replace it.

and, from the same section's preamble:

> All of it is retained — the **raw TLC output** included, not a summary of it.

and §7.5 gap 1, verbatim:

> **Consequence:** the six runs' evidence lives in the written record and its retained raw output —
> nothing admits, checks or ages it.

### 11.2 The repository prescribes NO evidence directory and NO file format for this

**This was checked, and the finding is that there is nothing to conform to:**

| Checked | Result |
|---|---|
| A directory named for evidence, runs or run-records | **None exists.** `find` for `*evidence*`, `*run-record*`, `*runs*`, `*artifact*` directories returns nothing |
| A schema that could carry a TLC run | **None.** `evidence.admit()` refuses any record whose `run.command` is not `npm run test:engine -- ModelCheck` (`COMMAND_MISMATCH`), and the schema **has no field for any of §7.3a items 1–10** — §7.5 gap 1 |
| A prescribed location in §7.3a, §7.5, §7.6 or `formal/README.md` | **None.** They state the obligation and name no path |
| An existing precedent for retained raw command output | The **written record** — the canonical `docs/phase15/` documents — is the only mechanism named, and it is named three times: §7.5 gap 1, the **B-M** register entry (*"The run evidence therefore lives only in the written record"*) and §7.0 (*"this document and the blocker register are where its state lives"*) |

> ### The gap is reported, not filled by invention.
>
> **A completed TLC run has no evidence-admission path in this repository, by design.** That is
> §7.5 gap 1 and it is explicitly marked *"recorded, NOT to be fixed"*. **No new retention
> convention was invented by this pass** — no `evidence/` directory, no `formal/runs/`, no JSON
> schema, no change to `evidence.js`, `gates.js` or `sourceDigest.js`.
>
> **What was done instead is the one thing the handoff actually names:** the raw output is retained
> **verbatim, in the written record**, in §12 of this document, in `docs/phase15/` — the existing
> directory, under the existing `PHASE_15_*.md` naming convention, where the handoff says B-M's
> evidence lives.
>
> **This location is PROVISIONAL and is the release owner's to confirm or redirect (§7.6).** If the
> owner wants the raw logs as separate files under a prescribed path, that is a retention-convention
> decision, and **it is theirs to make, not Engineering's to assume.**

### 11.3 Source-digest scope — deliberately not moved

| Constraint | Status |
|---|---|
| `formal/` is outside the source digest (§7.5 gap 2) | **Unchanged.** No file in `formal/` was created, edited or deleted |
| `docs/` is outside the source digest | **Unchanged.** This document and every edit this pass made are under `docs/phase15/` |
| Digest covers `Backend/{src,tools,tests}` + `package.json` + `jest.config.js` (`sourceDigest.js:33-36`) | **Untouched.** The digest `d033038cb261c3de…` does not move |

**Putting `formal/` into the digest scope was NOT proposed and must not be** — §7.5 gap 2 and
`PHASE_15_MASTER.md` §10 are explicit that the exclusion is deliberate. **The same applies to
`docs/`:** `PHASE_15_MASTER.md` §10 records that digest-scoping `docs/` would make every prose edit
void a ~25-minute evidence collection.

**`release-evidence.json` was NOT re-collected.** It remains bound to the superseded
`431010ace1…` and every record remains `[STALE]`. Re-collection is the release owner's step at a
quiescent tree and is not a documentation act.

### 11.4 What is retained, and the four classes kept apart

**§12 retains ten run logs in four explicitly separated classes. They must not be conflated.**

| Class | Runs | Standing |
|---|---|---|
| **AUTHORITATIVE** — the checked-in configuration, unmodified | §12.1 `commitment_c1` · §12.2 `commitment_c2` · §12.3 `commitment_c3` · §12.4 `lifecycle_c1` · §12.5 `lifecycle_c2` · §12.6 `lifecycle_c3` | **These six are the result.** One PASS, two UNKNOWN, three FAIL |
| **SECONDARY DIAGNOSTIC** — `-deadlock` on the command line; **no file modified** | §12.7 `lifecycle_c1` · §12.8 `lifecycle_c2` · §12.9 `lifecycle_c3` | **NOT authoritative. Discharges nothing.** Diagnostic only — this is how X4 was found. §9.5 |
| **INTERRUPTED / BUDGET-LIMITED** | `commitment_c2` (killed at wall-clock budget, machine slept — §5.2) · `commitment_c3` (abnormal exit `-1` at 247 s — §5.3) | Unfinished searches. **Not a failure and not a pass.** Retained inside §12.2 / §12.3 with their termination metadata intact |
| **SUPERSEDED EXPLORATORY** | §12.10 — an earlier `lifecycle_c1` run, 03:29 local, **different flags** (no `-noTE`, no `-XX:+UseParallelGC`, 6144 MB heap) | **Retained but NOT a result.** Superseded by §12.4. It is the run that emitted `lifecycle_TTrace_1788127170.tla`, which landed in the scratch output directory and **NOT in `formal/`** |
| **HISTORICAL — 2026-08-15, provenance ambiguous** | **NOT retained here — this repository never held its raw output.** Its only record is `formal/README.md:34-45` | **Ambiguous provenance on two independent grounds — §4.1 (tool) and §4.2 (constants).** Not counted toward the six by this pass |

**No TLC output below was invented, summarised, reordered or rewritten.** Each block is the capture
file's bytes. The only alteration is removal of the leading UTF-8 byte-order mark that PowerShell's
`Out-File -Encoding utf8` prepended to each capture file; **no byte of TLC's own output was
changed.** The `COMMAND`, `TLC_JAR_SHA256`, `START_UTC`, `END_UTC`, `WALL_CLOCK_SEC`, `OUTCOME`,
`EXIT_CODE`, `PEAK_JVM_WORKING_SET_MB` and `PEAK_METADIR_MB` header lines were written by the
capture wrapper, not by TLC, and are retained as-is — including the implausible
`PEAK_JVM_WORKING_SET_MB` values flagged in §2.

---

## 12. RAW TLC OUTPUT — retained verbatim

### 12.1 `commitment_c1.cfg` — AUTHORITATIVE — **complete state graph, no error**

**Class: AUTHORITATIVE.** Configuration as checked in. Constants `Legs = {l1,l2}`, `Workers = {w1,w2}`, `Capacity = 1`, `MaxFence = 4`.
**This is the only one of the six that closed.**

```text
COMMAND (run from c:\Users\soman\OneDrive\Desktop\RobotX\formal):
  java -Xmx6g -XX:+UseParallelGC -jar "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\tla2tools.jar" -config commitment_c1.cfg -workers auto -metadir "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\out\meta_commitment_c1__primary" -noTE commitment.tla
TLC_JAR_SHA256: eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a
BUDGET_SEC: 1800
START_UTC: 2026-08-30T22:03:17.4760316Z
END_UTC: 2026-08-30T22:03:45.0189269Z
WALL_CLOCK_SEC: 26.7
OUTCOME: PROCESS_EXITED
EXIT_CODE: 0
PEAK_JVM_WORKING_SET_MB: 11
PEAK_METADIR_MB: 164.2
----- TLC STDOUT -----
TLC2 Version 2026.08.21.155922 (rev: 9787e65)
Running breadth-first search Model-Checking with fp 93 and seed 2905768861659091343 with 12 workers on 12 cores with 5461MB heap and 64MB offheap memory [pid: 2100] (Windows 11 10.0 amd64, Oracle Corporation 20.0.2 64bit, MSBDiskFPSet, DiskStateQueue).
Parsing file C:\Users\soman\OneDrive\Desktop\RobotX\formal\commitment.tla (file:/c:/Users/soman/OneDrive/Desktop/RobotX/formal/commitment.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15478554086401238677\Integers.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Integers.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15478554086401238677\FiniteSets.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/FiniteSets.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15478554086401238677\Sequences.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Sequences.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15478554086401238677\TLC.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/TLC.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15478554086401238677\Naturals.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Naturals.tla)
Semantic processing of module Naturals
Semantic processing of module Integers
Semantic processing of module Sequences
Semantic processing of module FiniteSets
Semantic processing of module TLC
Semantic processing of module commitment
Linting of module commitment
Starting... (2026-08-31 03:33:18)
Computing initial states...
Finished computing initial states: 1 distinct state generated at 2026-08-31 03:33:18.
Progress(15) at 2026-08-31 03:33:21: 1,990,435 states generated (1,990,435 s/min), 443,602 distinct states found (443,602 ds/min), 189,098 states left on queue.
Model checking completed. No error has been found.
  Estimates of the probability that TLC did not check all reachable states
  because two distinct states had the same fingerprint:
  based on the actual fingerprints:  val = 5.7E-8
  calculated (optimistic):  val = 2.0E-6
The depth of the complete state graph search is 21.
17991520 states generated, 2375660 distinct states found, 0 states left on queue.
The average outdegree of the complete state graph is 1 (minimum is 0, the maximum 8 and the 95th percentile is 3).
Finished in 25s at (2026-08-31 03:33:43)

----- TLC STDERR -----

```

### 12.2 `commitment_c2.cfg` — AUTHORITATIVE — **did not converge / INTERRUPTED at budget**

**Class: AUTHORITATIVE, and INTERRUPTED / BUDGET-LIMITED.** Configuration as checked in. Constants `Legs = {l1,l2,l3}`, `Workers = {w1,w2}`, `Capacity = 2`, `MaxFence = 5`.
**Read §5.2 before quoting the 31 204 s wall clock — the machine slept mid-run.** The ~7-hour gap in TLC's own progress timestamps, between `05:22:13` and the `Checkpointing completed at (2026-08-31 12:27:38)` line, is that sleep. **It is retained, not edited out.**

```text
COMMAND (run from c:\Users\soman\OneDrive\Desktop\RobotX\formal):
  java -Xmx6g -XX:+UseParallelGC -jar "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\tla2tools.jar" -config commitment_c2.cfg -workers auto -metadir "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\out\meta_commitment_c2__primary" -noTE commitment.tla
TLC_JAR_SHA256: eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a
BUDGET_SEC: 7200
START_UTC: 2026-08-30T22:05:46.5284889Z
END_UTC: 2026-08-31T07:00:22.3376099Z
WALL_CLOCK_SEC: 31204.2
OUTCOME: TIMEOUT_KILLED_AT_BUDGET
EXIT_CODE: n/a (killed at budget)
PEAK_JVM_WORKING_SET_MB: 11
PEAK_METADIR_MB: 24118.1
----- TLC STDOUT -----
TLC2 Version 2026.08.21.155922 (rev: 9787e65)
Running breadth-first search Model-Checking with fp 53 and seed -2097048831605945487 with 12 workers on 12 cores with 5461MB heap and 64MB offheap memory [pid: 23192] (Windows 11 10.0 amd64, Oracle Corporation 20.0.2 64bit, MSBDiskFPSet, DiskStateQueue).
Parsing file C:\Users\soman\OneDrive\Desktop\RobotX\formal\commitment.tla (file:/c:/Users/soman/OneDrive/Desktop/RobotX/formal/commitment.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-14456453163835637790\Integers.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Integers.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-14456453163835637790\FiniteSets.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/FiniteSets.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-14456453163835637790\Sequences.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Sequences.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-14456453163835637790\TLC.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/TLC.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-14456453163835637790\Naturals.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Naturals.tla)
Semantic processing of module Naturals
Semantic processing of module Integers
Semantic processing of module Sequences
Semantic processing of module FiniteSets
Semantic processing of module TLC
Semantic processing of module commitment
Linting of module commitment
Starting... (2026-08-31 03:35:47)
Computing initial states...
Finished computing initial states: 1 distinct state generated at 2026-08-31 03:35:47.
Progress(12) at 2026-08-31 03:35:50: 1,838,633 states generated (1,838,633 s/min), 616,406 distinct states found (616,406 ds/min), 388,198 states left on queue.
Progress(15) at 2026-08-31 03:36:50: 37,122,857 states generated (35,284,224 s/min), 9,531,373 distinct states found (8,914,967 ds/min), 5,506,957 states left on queue.
Progress(16) at 2026-08-31 03:37:50: 73,812,494 states generated (36,689,637 s/min), 17,794,486 distinct states found (8,263,113 ds/min), 9,995,490 states left on queue.
Progress(17) at 2026-08-31 03:38:50: 110,265,249 states generated (36,452,755 s/min), 25,673,315 distinct states found (7,878,829 ds/min), 14,176,000 states left on queue.
Progress(17) at 2026-08-31 03:39:50: 147,396,574 states generated (37,131,325 s/min), 33,411,744 distinct states found (7,738,429 ds/min), 18,216,311 states left on queue.
Progress(17) at 2026-08-31 03:40:50: 184,403,547 states generated (37,006,973 s/min), 40,677,433 distinct states found (7,265,689 ds/min), 21,771,870 states left on queue.
Progress(17) at 2026-08-31 03:41:50: 221,002,424 states generated (36,598,877 s/min), 47,919,800 distinct states found (7,242,367 ds/min), 25,374,825 states left on queue.
Progress(18) at 2026-08-31 03:42:50: 257,113,142 states generated (36,110,718 s/min), 55,157,778 distinct states found (7,237,978 ds/min), 29,053,645 states left on queue.
Progress(18) at 2026-08-31 03:43:50: 293,304,651 states generated (36,191,509 s/min), 62,370,536 distinct states found (7,212,758 ds/min), 32,737,014 states left on queue.
Progress(18) at 2026-08-31 03:44:50: 323,779,001 states generated (30,474,350 s/min), 68,022,481 distinct states found (5,651,945 ds/min), 35,405,748 states left on queue.
Progress(18) at 2026-08-31 03:45:50: 342,052,016 states generated (18,273,015 s/min), 71,202,180 distinct states found (3,179,699 ds/min), 36,797,824 states left on queue.
Progress(18) at 2026-08-31 03:46:50: 359,622,733 states generated (17,570,717 s/min), 74,297,317 distinct states found (3,095,137 ds/min), 38,155,094 states left on queue.
Progress(18) at 2026-08-31 03:47:50: 376,175,160 states generated (16,552,427 s/min), 77,509,557 distinct states found (3,212,240 ds/min), 39,703,757 states left on queue.
Progress(18) at 2026-08-31 03:48:50: 393,600,217 states generated (17,425,057 s/min), 80,543,657 distinct states found (3,034,100 ds/min), 41,040,370 states left on queue.
Progress(18) at 2026-08-31 03:49:50: 410,309,301 states generated (16,709,084 s/min), 83,503,958 distinct states found (2,960,301 ds/min), 42,364,987 states left on queue.
Progress(18) at 2026-08-31 03:50:50: 425,895,061 states generated (15,585,760 s/min), 86,483,339 distinct states found (2,979,381 ds/min), 43,793,090 states left on queue.
Progress(18) at 2026-08-31 03:51:50: 441,669,500 states generated (15,774,439 s/min), 89,392,933 distinct states found (2,909,594 ds/min), 45,158,075 states left on queue.
Progress(18) at 2026-08-31 03:52:50: 457,175,670 states generated (15,506,170 s/min), 92,176,010 distinct states found (2,783,077 ds/min), 46,438,823 states left on queue.
Progress(18) at 2026-08-31 03:53:50: 472,538,295 states generated (15,362,625 s/min), 94,944,469 distinct states found (2,768,459 ds/min), 47,696,078 states left on queue.
Progress(18) at 2026-08-31 03:54:50: 487,421,112 states generated (14,882,817 s/min), 97,625,571 distinct states found (2,681,102 ds/min), 48,922,977 states left on queue.
Progress(18) at 2026-08-31 03:55:50: 501,863,323 states generated (14,442,211 s/min), 100,228,063 distinct states found (2,602,492 ds/min), 50,137,357 states left on queue.
Progress(19) at 2026-08-31 03:56:50: 515,846,464 states generated (13,983,141 s/min), 102,829,429 distinct states found (2,601,366 ds/min), 51,371,914 states left on queue.
Progress(19) at 2026-08-31 03:57:50: 529,584,899 states generated (13,738,435 s/min), 105,417,884 distinct states found (2,588,455 ds/min), 52,622,326 states left on queue.
Progress(19) at 2026-08-31 03:58:50: 543,145,866 states generated (13,560,967 s/min), 107,934,582 distinct states found (2,516,698 ds/min), 53,835,323 states left on queue.
Progress(19) at 2026-08-31 03:59:50: 556,464,652 states generated (13,318,786 s/min), 110,364,728 distinct states found (2,430,146 ds/min), 54,984,676 states left on queue.
Progress(19) at 2026-08-31 04:00:50: 569,707,236 states generated (13,242,584 s/min), 112,737,660 distinct states found (2,372,932 ds/min), 56,087,585 states left on queue.
Progress(19) at 2026-08-31 04:01:50: 582,562,420 states generated (12,855,184 s/min), 115,174,972 distinct states found (2,437,312 ds/min), 57,272,139 states left on queue.
Progress(19) at 2026-08-31 04:02:50: 594,842,131 states generated (12,279,711 s/min), 117,561,591 distinct states found (2,386,619 ds/min), 58,451,494 states left on queue.
Progress(19) at 2026-08-31 04:03:50: 607,301,719 states generated (12,459,588 s/min), 119,887,622 distinct states found (2,326,031 ds/min), 59,582,019 states left on queue.
Progress(19) at 2026-08-31 04:04:50: 619,710,442 states generated (12,408,723 s/min), 122,144,147 distinct states found (2,256,525 ds/min), 60,665,364 states left on queue.
Checkpointing of run C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\out\meta_commitment_c2__primary\26-08-31-03-35-46.773
Checkpointing completed at (2026-08-31 04:05:50)
Progress(19) at 2026-08-31 04:05:50: 632,595,215 states generated (12,884,773 s/min), 124,303,576 distinct states found (2,159,429 ds/min), 61,627,298 states left on queue.
Progress(19) at 2026-08-31 04:06:50: 646,090,718 states generated (13,495,503 s/min), 126,532,330 distinct states found (2,228,754 ds/min), 62,572,309 states left on queue.
Progress(19) at 2026-08-31 04:07:50: 659,089,351 states generated (12,998,633 s/min), 128,867,303 distinct states found (2,334,973 ds/min), 63,616,265 states left on queue.
Progress(19) at 2026-08-31 04:08:50: 672,163,726 states generated (13,074,375 s/min), 131,145,176 distinct states found (2,277,873 ds/min), 64,630,508 states left on queue.
Progress(19) at 2026-08-31 04:09:50: 687,482,169 states generated (15,318,443 s/min), 133,637,182 distinct states found (2,492,006 ds/min), 65,639,475 states left on queue.
Progress(19) at 2026-08-31 04:10:50: 702,290,134 states generated (14,807,965 s/min), 135,991,077 distinct states found (2,353,895 ds/min), 66,553,548 states left on queue.
Progress(19) at 2026-08-31 04:11:50: 719,022,431 states generated (16,732,297 s/min), 138,605,065 distinct states found (2,613,988 ds/min), 67,539,076 states left on queue.
Progress(19) at 2026-08-31 04:12:50: 735,260,632 states generated (16,238,201 s/min), 141,173,352 distinct states found (2,568,287 ds/min), 68,526,440 states left on queue.
Progress(19) at 2026-08-31 04:13:50: 751,515,840 states generated (16,255,208 s/min), 143,788,003 distinct states found (2,614,651 ds/min), 69,529,456 states left on queue.
Progress(19) at 2026-08-31 04:14:50: 766,951,448 states generated (15,435,608 s/min), 146,487,447 distinct states found (2,699,444 ds/min), 70,677,409 states left on queue.
Progress(19) at 2026-08-31 04:15:50: 781,952,967 states generated (15,001,519 s/min), 149,201,959 distinct states found (2,714,512 ds/min), 71,917,273 states left on queue.
Progress(19) at 2026-08-31 04:16:50: 797,856,206 states generated (15,903,239 s/min), 151,697,809 distinct states found (2,495,850 ds/min), 72,874,349 states left on queue.
Progress(19) at 2026-08-31 04:17:51: 813,377,571 states generated (15,521,365 s/min), 154,145,651 distinct states found (2,447,842 ds/min), 73,822,174 states left on queue.
Progress(19) at 2026-08-31 04:18:51: 828,618,199 states generated (15,240,628 s/min), 156,630,052 distinct states found (2,484,401 ds/min), 74,800,680 states left on queue.
Progress(19) at 2026-08-31 04:19:51: 843,583,332 states generated (14,965,133 s/min), 159,007,516 distinct states found (2,377,464 ds/min), 75,742,298 states left on queue.
Progress(19) at 2026-08-31 04:20:51: 858,179,285 states generated (14,595,953 s/min), 161,411,564 distinct states found (2,404,048 ds/min), 76,718,033 states left on queue.
Progress(19) at 2026-08-31 04:21:51: 871,752,177 states generated (13,572,892 s/min), 163,935,322 distinct states found (2,523,758 ds/min), 77,896,437 states left on queue.
Progress(19) at 2026-08-31 04:22:51: 885,719,711 states generated (13,967,534 s/min), 166,345,079 distinct states found (2,409,757 ds/min), 78,955,925 states left on queue.
Progress(19) at 2026-08-31 04:23:51: 899,823,095 states generated (14,103,384 s/min), 168,667,777 distinct states found (2,322,698 ds/min), 79,904,355 states left on queue.
Progress(19) at 2026-08-31 04:24:51: 913,524,579 states generated (13,701,484 s/min), 170,920,034 distinct states found (2,252,257 ds/min), 80,832,901 states left on queue.
Progress(19) at 2026-08-31 04:25:51: 927,044,111 states generated (13,519,532 s/min), 173,176,173 distinct states found (2,256,139 ds/min), 81,785,347 states left on queue.
Progress(19) at 2026-08-31 04:26:51: 940,474,308 states generated (13,430,197 s/min), 175,369,279 distinct states found (2,193,106 ds/min), 82,675,531 states left on queue.
Progress(19) at 2026-08-31 04:27:51: 953,973,851 states generated (13,499,543 s/min), 177,559,500 distinct states found (2,190,221 ds/min), 83,548,101 states left on queue.
Progress(19) at 2026-08-31 04:28:51: 967,606,351 states generated (13,632,500 s/min), 179,742,454 distinct states found (2,182,954 ds/min), 84,397,637 states left on queue.
Progress(19) at 2026-08-31 04:29:51: 981,025,318 states generated (13,418,967 s/min), 181,871,290 distinct states found (2,128,836 ds/min), 85,229,061 states left on queue.
Progress(19) at 2026-08-31 04:30:51: 993,731,290 states generated (12,705,972 s/min), 184,122,068 distinct states found (2,250,778 ds/min), 86,247,427 states left on queue.
Progress(19) at 2026-08-31 04:31:51: 1,006,503,948 states generated (12,772,658 s/min), 186,227,089 distinct states found (2,105,021 ds/min), 87,143,548 states left on queue.
Progress(19) at 2026-08-31 04:32:51: 1,019,245,651 states generated (12,741,703 s/min), 188,299,540 distinct states found (2,072,451 ds/min), 87,995,308 states left on queue.
Progress(19) at 2026-08-31 04:33:51: 1,031,578,150 states generated (12,332,499 s/min), 190,435,740 distinct states found (2,136,200 ds/min), 88,931,339 states left on queue.
Progress(20) at 2026-08-31 04:34:51: 1,043,953,432 states generated (12,375,282 s/min), 192,544,335 distinct states found (2,108,595 ds/min), 89,841,865 states left on queue.
Checkpointing of run C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\out\meta_commitment_c2__primary\26-08-31-03-35-46.773
Checkpointing completed at (2026-08-31 04:36:02)
Progress(20) at 2026-08-31 04:36:02: 1,058,118,831 states generated (14,165,399 s/min), 195,032,373 distinct states found (2,488,038 ds/min), 90,957,205 states left on queue.
Progress(20) at 2026-08-31 04:37:02: 1,070,414,791 states generated (12,295,960 s/min), 197,123,312 distinct states found (2,090,939 ds/min), 91,865,019 states left on queue.
Progress(20) at 2026-08-31 04:38:02: 1,082,577,243 states generated (12,162,452 s/min), 199,128,793 distinct states found (2,005,481 ds/min), 92,718,299 states left on queue.
Progress(20) at 2026-08-31 04:39:02: 1,094,539,913 states generated (11,962,670 s/min), 201,198,103 distinct states found (2,069,310 ds/min), 93,638,518 states left on queue.
Progress(20) at 2026-08-31 04:40:02: 1,104,382,639 states generated (9,842,726 s/min), 202,885,824 distinct states found (1,687,721 ds/min), 94,379,340 states left on queue.
Progress(20) at 2026-08-31 04:41:02: 1,116,156,775 states generated (11,774,136 s/min), 204,816,660 distinct states found (1,930,836 ds/min), 95,194,706 states left on queue.
Progress(20) at 2026-08-31 04:42:02: 1,128,137,971 states generated (11,981,196 s/min), 206,848,597 distinct states found (2,031,937 ds/min), 96,091,631 states left on queue.
Progress(20) at 2026-08-31 04:43:02: 1,140,095,450 states generated (11,957,479 s/min), 208,784,196 distinct states found (1,935,599 ds/min), 96,891,679 states left on queue.
Progress(20) at 2026-08-31 04:44:02: 1,151,879,747 states generated (11,784,297 s/min), 210,800,727 distinct states found (2,016,531 ds/min), 97,780,125 states left on queue.
Progress(20) at 2026-08-31 04:45:02: 1,163,735,106 states generated (11,855,359 s/min), 212,914,158 distinct states found (2,113,431 ds/min), 98,747,305 states left on queue.
Progress(20) at 2026-08-31 04:46:02: 1,175,640,449 states generated (11,905,343 s/min), 214,990,611 distinct states found (2,076,453 ds/min), 99,675,748 states left on queue.
Progress(20) at 2026-08-31 04:47:02: 1,187,138,393 states generated (11,497,944 s/min), 217,052,943 distinct states found (2,062,332 ds/min), 100,611,545 states left on queue.
Progress(20) at 2026-08-31 04:48:02: 1,198,603,027 states generated (11,464,634 s/min), 219,090,784 distinct states found (2,037,841 ds/min), 101,541,215 states left on queue.
Progress(20) at 2026-08-31 04:49:02: 1,210,485,930 states generated (11,882,903 s/min), 221,106,610 distinct states found (2,015,826 ds/min), 102,437,382 states left on queue.
Progress(20) at 2026-08-31 04:50:02: 1,222,242,728 states generated (11,756,798 s/min), 223,149,411 distinct states found (2,042,801 ds/min), 103,356,292 states left on queue.
Progress(20) at 2026-08-31 04:51:02: 1,233,984,161 states generated (11,741,433 s/min), 225,126,781 distinct states found (1,977,370 ds/min), 104,232,549 states left on queue.
Progress(20) at 2026-08-31 04:52:02: 1,246,055,095 states generated (12,070,934 s/min), 227,129,855 distinct states found (2,003,074 ds/min), 105,110,176 states left on queue.
Progress(20) at 2026-08-31 04:53:02: 1,258,109,758 states generated (12,054,663 s/min), 229,030,009 distinct states found (1,900,154 ds/min), 105,896,673 states left on queue.
Progress(20) at 2026-08-31 04:54:02: 1,270,369,394 states generated (12,259,636 s/min), 230,911,785 distinct states found (1,881,776 ds/min), 106,642,909 states left on queue.
Progress(20) at 2026-08-31 04:55:02: 1,282,799,888 states generated (12,430,494 s/min), 232,793,208 distinct states found (1,881,423 ds/min), 107,389,606 states left on queue.
Progress(20) at 2026-08-31 04:56:02: 1,295,571,555 states generated (12,771,667 s/min), 234,728,317 distinct states found (1,935,109 ds/min), 108,073,975 states left on queue.
Progress(20) at 2026-08-31 04:57:02: 1,307,916,351 states generated (12,344,796 s/min), 236,711,682 distinct states found (1,983,365 ds/min), 108,845,326 states left on queue.
Progress(20) at 2026-08-31 04:58:02: 1,320,240,407 states generated (12,324,056 s/min), 238,846,937 distinct states found (2,135,255 ds/min), 109,758,233 states left on queue.
Progress(20) at 2026-08-31 04:59:02: 1,332,665,488 states generated (12,425,081 s/min), 240,848,265 distinct states found (2,001,328 ds/min), 110,565,911 states left on queue.
Progress(20) at 2026-08-31 05:00:02: 1,345,505,957 states generated (12,840,469 s/min), 242,807,026 distinct states found (1,958,761 ds/min), 111,288,429 states left on queue.
Progress(20) at 2026-08-31 05:01:02: 1,358,714,871 states generated (13,208,914 s/min), 244,662,241 distinct states found (1,855,215 ds/min), 111,868,111 states left on queue.
Progress(20) at 2026-08-31 05:02:02: 1,371,861,860 states generated (13,146,989 s/min), 246,624,443 distinct states found (1,962,202 ds/min), 112,545,784 states left on queue.
Progress(20) at 2026-08-31 05:03:02: 1,385,478,721 states generated (13,616,861 s/min), 248,570,774 distinct states found (1,946,331 ds/min), 113,173,853 states left on queue.
Progress(20) at 2026-08-31 05:04:02: 1,399,248,867 states generated (13,770,146 s/min), 250,486,467 distinct states found (1,915,693 ds/min), 113,744,208 states left on queue.
Progress(20) at 2026-08-31 05:05:02: 1,412,750,617 states generated (13,501,750 s/min), 252,361,471 distinct states found (1,875,004 ds/min), 114,298,472 states left on queue.
Checkpointing of run C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\out\meta_commitment_c2__primary\26-08-31-03-35-46.773
Checkpointing completed at (2026-08-31 05:06:13)
Progress(20) at 2026-08-31 05:06:13: 1,427,865,724 states generated (15,115,107 s/min), 254,485,813 distinct states found (2,124,342 ds/min), 114,965,971 states left on queue.
Progress(20) at 2026-08-31 05:07:13: 1,441,573,307 states generated (13,707,583 s/min), 256,346,662 distinct states found (1,860,849 ds/min), 115,488,241 states left on queue.
Progress(20) at 2026-08-31 05:08:13: 1,455,620,884 states generated (14,047,577 s/min), 258,470,922 distinct states found (2,124,260 ds/min), 116,212,291 states left on queue.
Progress(20) at 2026-08-31 05:09:13: 1,469,724,582 states generated (14,103,698 s/min), 260,389,914 distinct states found (1,918,992 ds/min), 116,736,864 states left on queue.
Progress(20) at 2026-08-31 05:10:13: 1,483,110,064 states generated (13,385,482 s/min), 262,439,782 distinct states found (2,049,868 ds/min), 117,447,062 states left on queue.
Progress(20) at 2026-08-31 05:11:13: 1,496,177,705 states generated (13,067,641 s/min), 264,528,464 distinct states found (2,088,682 ds/min), 118,235,810 states left on queue.
Progress(20) at 2026-08-31 05:12:13: 1,508,075,140 states generated (11,897,435 s/min), 266,648,319 distinct states found (2,119,855 ds/min), 119,177,336 states left on queue.
Progress(20) at 2026-08-31 05:13:13: 1,519,058,407 states generated (10,983,267 s/min), 268,434,107 distinct states found (1,785,788 ds/min), 119,901,100 states left on queue.
Progress(20) at 2026-08-31 05:14:13: 1,528,404,644 states generated (9,346,237 s/min), 269,866,085 distinct states found (1,431,978 ds/min), 120,427,286 states left on queue.
Progress(20) at 2026-08-31 05:15:13: 1,540,734,413 states generated (12,329,769 s/min), 271,565,447 distinct states found (1,699,362 ds/min), 120,925,242 states left on queue.
Progress(20) at 2026-08-31 05:16:13: 1,553,110,409 states generated (12,375,996 s/min), 273,292,227 distinct states found (1,726,780 ds/min), 121,451,613 states left on queue.
Progress(20) at 2026-08-31 05:17:13: 1,565,361,585 states generated (12,251,176 s/min), 274,973,465 distinct states found (1,681,238 ds/min), 121,958,534 states left on queue.
Progress(20) at 2026-08-31 05:18:13: 1,577,768,117 states generated (12,406,532 s/min), 276,741,570 distinct states found (1,768,105 ds/min), 122,507,669 states left on queue.
Progress(20) at 2026-08-31 05:19:13: 1,590,522,521 states generated (12,754,404 s/min), 278,517,798 distinct states found (1,776,228 ds/min), 123,019,653 states left on queue.
Progress(20) at 2026-08-31 05:20:13: 1,602,643,757 states generated (12,121,236 s/min), 280,347,499 distinct states found (1,829,701 ds/min), 123,659,474 states left on queue.
Progress(20) at 2026-08-31 05:21:13: 1,614,391,814 states generated (11,748,057 s/min), 282,121,619 distinct states found (1,774,120 ds/min), 124,304,547 states left on queue.
Progress(20) at 2026-08-31 05:22:13: 1,626,827,167 states generated (12,435,353 s/min), 283,811,027 distinct states found (1,689,408 ds/min), 124,795,883 states left on queue.
Checkpointing of run C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\out\meta_commitment_c2__primary\26-08-31-03-35-46.773
Checkpointing completed at (2026-08-31 12:27:38)
Progress(20) at 2026-08-31 12:27:38: 1,638,294,779 states generated (11,467,612 s/min), 285,567,999 distinct states found (1,756,972 ds/min), 125,438,080 states left on queue.
Progress(20) at 2026-08-31 12:28:38: 1,644,104,307 states generated (5,809,528 s/min), 286,417,359 distinct states found (849,360 ds/min), 125,715,759 states left on queue.
Progress(20) at 2026-08-31 12:29:38: 1,650,642,056 states generated (6,537,749 s/min), 287,362,834 distinct states found (945,475 ds/min), 126,025,013 states left on queue.

----- TLC STDERR -----

```

### 12.3 `commitment_c3.cfg` — AUTHORITATIVE — **did not converge / abnormal termination**

**Class: AUTHORITATIVE, and INTERRUPTED.** Configuration as checked in. Constants `Legs = {l1,l2,l3,l4}`, `Workers = {w1,w2}`, `Capacity = 3`, `MaxFence = 6`.
**Exit code `-1` at 247.4 s of a 7 200 s budget. TLC printed no error line and no completion line.** Cause not determined — §5.3.

```text
COMMAND (run from c:\Users\soman\OneDrive\Desktop\RobotX\formal):
  java -Xmx6g -XX:+UseParallelGC -jar "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\tla2tools.jar" -config commitment_c3.cfg -workers auto -metadir "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\out\meta_commitment_c3__primary" -noTE commitment.tla
TLC_JAR_SHA256: eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a
BUDGET_SEC: 7200
START_UTC: 2026-08-31T07:00:22.4143862Z
END_UTC: 2026-08-31T07:04:30.7958000Z
WALL_CLOCK_SEC: 247.4
OUTCOME: PROCESS_EXITED
EXIT_CODE: -1
PEAK_JVM_WORKING_SET_MB: 11
PEAK_METADIR_MB: 3018.1
----- TLC STDOUT -----
TLC2 Version 2026.08.21.155922 (rev: 9787e65)
Running breadth-first search Model-Checking with fp 11 and seed -6425496614292652574 with 12 workers on 12 cores with 5461MB heap and 64MB offheap memory [pid: 15876] (Windows 11 10.0 amd64, Oracle Corporation 20.0.2 64bit, MSBDiskFPSet, DiskStateQueue).
Parsing file C:\Users\soman\OneDrive\Desktop\RobotX\formal\commitment.tla (file:/c:/Users/soman/OneDrive/Desktop/RobotX/formal/commitment.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15139109335912238109\Integers.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Integers.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15139109335912238109\FiniteSets.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/FiniteSets.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15139109335912238109\Sequences.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Sequences.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15139109335912238109\TLC.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/TLC.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15139109335912238109\Naturals.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Naturals.tla)
Semantic processing of module Naturals
Semantic processing of module Integers
Semantic processing of module Sequences
Semantic processing of module FiniteSets
Semantic processing of module TLC
Semantic processing of module commitment
Linting of module commitment
Starting... (2026-08-31 12:30:23)
Computing initial states...
Finished computing initial states: 1 distinct state generated at 2026-08-31 12:30:23.
Progress(11) at 2026-08-31 12:30:26: 1,130,354 states generated (1,130,354 s/min), 458,218 distinct states found (458,218 ds/min), 316,000 states left on queue.
Progress(13) at 2026-08-31 12:31:26: 25,971,196 states generated (24,840,842 s/min), 8,561,776 distinct states found (8,103,558 ds/min), 5,716,655 states left on queue.
Progress(14) at 2026-08-31 12:32:26: 49,529,671 states generated (23,558,475 s/min), 15,479,858 distinct states found (6,918,082 ds/min), 10,216,832 states left on queue.
Progress(14) at 2026-08-31 12:33:26: 79,276,913 states generated (29,747,242 s/min), 24,249,309 distinct states found (8,769,451 ds/min), 15,980,833 states left on queue.
Progress(15) at 2026-08-31 12:34:26: 107,713,972 states generated (28,437,059 s/min), 32,163,551 distinct states found (7,914,242 ds/min), 21,066,205 states left on queue.

----- TLC STDERR -----

```

### 12.4 `lifecycle_c1.cfg` — AUTHORITATIVE — **FAIL: deadlock abort**

**Class: AUTHORITATIVE.** Configuration as checked in. Constants `Legs = {l1,l2}`, `Capacity = 1`, `MaxTicks = 3`.
**Aborted on TLC's default deadlock check at depth 6 — finding X5 (§9). `Safety`, `TerminalIsFinal` and `Liveness` all reached NO VERDICT.**

```text
COMMAND (run from c:\Users\soman\OneDrive\Desktop\RobotX\formal):
  java -Xmx6g -XX:+UseParallelGC -jar "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\tla2tools.jar" -config lifecycle_c1.cfg -workers auto -metadir "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\out\meta_lifecycle_c1__primary" -noTE lifecycle.tla
TLC_JAR_SHA256: eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a
BUDGET_SEC: 900
START_UTC: 2026-08-30T22:03:08.6405313Z
END_UTC: 2026-08-30T22:03:11.5965654Z
WALL_CLOCK_SEC: 2.1
OUTCOME: PROCESS_EXITED
EXIT_CODE: 11
PEAK_JVM_WORKING_SET_MB: 0
PEAK_METADIR_MB: 0
----- TLC STDOUT -----
TLC2 Version 2026.08.21.155922 (rev: 9787e65)
Running breadth-first search Model-Checking with fp 104 and seed 2502187404395443233 with 12 workers on 12 cores with 5461MB heap and 64MB offheap memory [pid: 21236] (Windows 11 10.0 amd64, Oracle Corporation 20.0.2 64bit, MSBDiskFPSet, DiskStateQueue).
Parsing file C:\Users\soman\OneDrive\Desktop\RobotX\formal\lifecycle.tla (file:/c:/Users/soman/OneDrive/Desktop/RobotX/formal/lifecycle.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-5022144860335723802\Integers.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Integers.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-5022144860335723802\FiniteSets.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/FiniteSets.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-5022144860335723802\Sequences.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Sequences.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-5022144860335723802\TLC.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/TLC.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-5022144860335723802\Naturals.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Naturals.tla)
Semantic processing of module Naturals
Semantic processing of module Integers
Semantic processing of module Sequences
Semantic processing of module FiniteSets
Semantic processing of module TLC
Semantic processing of module lifecycle
Linting of module lifecycle
Starting... (2026-08-31 03:33:09)
Implied-temporal checking--satisfiability problem has 6 branches.
Computing initial states...
Finished computing initial states: 1 distinct state generated at 2026-08-31 03:33:09.
Error: Deadlock reached.
Error: The behavior up to this point is:
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE")
/\ ticks = 0
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE)
/\ taskState = "WAITING"

/\ legState = (l1 :> "QUEUED" @@ l2 :> "QUEUED")
State 1: <Initial predicate>
State 2: <Cancel(l1) line 268, col 5 to line 272, col 58 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "CANCELLED" @@ l2 :> "QUEUED")

State 3: <Cancel(l2) line 268, col 5 to line 272, col 58 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "CANCELLED" @@ l2 :> "CANCELLED")

220 states generated, 79 distinct states found, 38 states left on queue.
The depth of the complete state graph search is 6.
Finished in 00s at (2026-08-31 03:33:09)

----- TLC STDERR -----

```

### 12.5 `lifecycle_c2.cfg` — AUTHORITATIVE — **FAIL: deadlock abort**

**Class: AUTHORITATIVE.** Configuration as checked in. Constants `Legs = {l1,l2,l3}`, `Capacity = 2`, `MaxTicks = 3`.
**Aborted on the deadlock check at depth 6 — finding X5 (§9). No declared property reached a verdict.**

```text
COMMAND (run from c:\Users\soman\OneDrive\Desktop\RobotX\formal):
  java -Xmx6g -XX:+UseParallelGC -jar "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\tla2tools.jar" -config lifecycle_c2.cfg -workers auto -metadir "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\out\meta_lifecycle_c2__primary" -noTE lifecycle.tla
TLC_JAR_SHA256: eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a
BUDGET_SEC: 900
START_UTC: 2026-08-30T22:03:11.6638183Z
END_UTC: 2026-08-30T22:03:14.5261967Z
WALL_CLOCK_SEC: 2
OUTCOME: PROCESS_EXITED
EXIT_CODE: 11
PEAK_JVM_WORKING_SET_MB: 0
PEAK_METADIR_MB: 0.2
----- TLC STDOUT -----
TLC2 Version 2026.08.21.155922 (rev: 9787e65)
Running breadth-first search Model-Checking with fp 74 and seed 9127312237397852736 with 12 workers on 12 cores with 5461MB heap and 64MB offheap memory [pid: 19332] (Windows 11 10.0 amd64, Oracle Corporation 20.0.2 64bit, MSBDiskFPSet, DiskStateQueue).
Parsing file C:\Users\soman\OneDrive\Desktop\RobotX\formal\lifecycle.tla (file:/c:/Users/soman/OneDrive/Desktop/RobotX/formal/lifecycle.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-442308113194043500\Integers.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Integers.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-442308113194043500\FiniteSets.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/FiniteSets.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-442308113194043500\Sequences.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Sequences.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-442308113194043500\TLC.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/TLC.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-442308113194043500\Naturals.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Naturals.tla)
Semantic processing of module Naturals
Semantic processing of module Integers
Semantic processing of module Sequences
Semantic processing of module FiniteSets
Semantic processing of module TLC
Semantic processing of module lifecycle
Linting of module lifecycle
Starting... (2026-08-31 03:33:12)
Implied-temporal checking--satisfiability problem has 9 branches.
Computing initial states...
Finished computing initial states: 1 distinct state generated at 2026-08-31 03:33:12.
Error: Deadlock reached.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "QUEUED" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED")

State 2: <Cancel(l1) line 268, col 5 to line 272, col 58 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "CANCELLED" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED")

State 3: <Cancel(l2) line 268, col 5 to line 272, col 58 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "CANCELLED" @@ l2 :> "CANCELLED" @@ l3 :> "QUEUED")

State 4: <Cancel(l3) line 268, col 5 to line 272, col 58 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "CANCELLED" @@ l2 :> "CANCELLED" @@ l3 :> "CANCELLED")

1041 states generated, 277 distinct states found, 140 states left on queue.
The depth of the complete state graph search is 6.
Finished in 01s at (2026-08-31 03:33:13)

----- TLC STDERR -----

```

### 12.6 `lifecycle_c3.cfg` — AUTHORITATIVE — **FAIL: deadlock abort**

**Class: AUTHORITATIVE.** Configuration as checked in. Constants `Legs = {l1,l2,l3,l4}`, `Capacity = 3`, `MaxTicks = 3`.
**Aborted on the deadlock check at depth 6 — finding X5 (§9). No declared property reached a verdict.**

```text
COMMAND (run from c:\Users\soman\OneDrive\Desktop\RobotX\formal):
  java -Xmx6g -XX:+UseParallelGC -jar "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\tla2tools.jar" -config lifecycle_c3.cfg -workers auto -metadir "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\out\meta_lifecycle_c3__primary" -noTE lifecycle.tla
TLC_JAR_SHA256: eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a
BUDGET_SEC: 900
START_UTC: 2026-08-30T22:03:14.5632052Z
END_UTC: 2026-08-30T22:03:17.4401329Z
WALL_CLOCK_SEC: 2.1
OUTCOME: PROCESS_EXITED
EXIT_CODE: 11
PEAK_JVM_WORKING_SET_MB: 0
PEAK_METADIR_MB: 1.1
----- TLC STDOUT -----
TLC2 Version 2026.08.21.155922 (rev: 9787e65)
Running breadth-first search Model-Checking with fp 32 and seed 6803714917876676751 with 12 workers on 12 cores with 5461MB heap and 64MB offheap memory [pid: 22416] (Windows 11 10.0 amd64, Oracle Corporation 20.0.2 64bit, MSBDiskFPSet, DiskStateQueue).
Parsing file C:\Users\soman\OneDrive\Desktop\RobotX\formal\lifecycle.tla (file:/c:/Users/soman/OneDrive/Desktop/RobotX/formal/lifecycle.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-12779514453664616311\Integers.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Integers.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-12779514453664616311\FiniteSets.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/FiniteSets.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-12779514453664616311\Sequences.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Sequences.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-12779514453664616311\TLC.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/TLC.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-12779514453664616311\Naturals.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Naturals.tla)
Semantic processing of module Naturals
Semantic processing of module Integers
Semantic processing of module Sequences
Semantic processing of module FiniteSets
Semantic processing of module TLC
Semantic processing of module lifecycle
Linting of module lifecycle
Starting... (2026-08-31 03:33:15)
Implied-temporal checking--satisfiability problem has 12 branches.
Computing initial states...
Finished computing initial states: 1 distinct state generated at 2026-08-31 03:33:15.
Error: Deadlock reached.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE" @@ l4 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "QUEUED" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED" @@ l4 :> "QUEUED")

State 2: <Cancel(l1) line 268, col 5 to line 272, col 58 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE" @@ l4 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "CANCELLED" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED" @@ l4 :> "QUEUED")

State 3: <Cancel(l2) line 268, col 5 to line 272, col 58 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE" @@ l4 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "CANCELLED" @@ l2 :> "CANCELLED" @@ l3 :> "QUEUED" @@ l4 :> "QUEUED")

State 4: <Cancel(l3) line 268, col 5 to line 272, col 58 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE" @@ l4 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "CANCELLED" @@ l2 :> "CANCELLED" @@ l3 :> "CANCELLED" @@ l4 :> "QUEUED")

State 5: <Cancel(l4) line 268, col 5 to line 272, col 58 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE" @@ l4 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = ( l1 :> "CANCELLED" @@
  l2 :> "CANCELLED" @@
  l3 :> "CANCELLED" @@
  l4 :> "CANCELLED" )

4770 states generated, 1012 distinct states found, 536 states left on queue.
The depth of the complete state graph search is 6.
Finished in 01s at (2026-08-31 03:33:16)

----- TLC STDERR -----

```

---

### The three runs below are SECONDARY DIAGNOSTIC ONLY

> They add `-deadlock` **on the command line**. No `.cfg` and no `.tla` was modified.
> **They are NOT authoritative and discharge NOTHING** — §9.5. They are retained because they
> are how finding **X4** (§10) was discovered: the authoritative deadlock abort at depth 6 was
> masking a `Safety` violation at depth 9.

### 12.7 `lifecycle_c1.cfg` `-deadlock` — SECONDARY DIAGNOSTIC — **`Invariant Safety is violated`**

**Class: SECONDARY DIAGNOSTIC. NOT AUTHORITATIVE.**
**This log carries the full nine-state counterexample for finding X4 (§10), with every variable printed at each step.**

```text
COMMAND (run from c:\Users\soman\OneDrive\Desktop\RobotX\formal):
  java -Xmx6g -XX:+UseParallelGC -jar "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\tla2tools.jar" -config lifecycle_c1.cfg -workers auto -metadir "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\out\meta_lifecycle_c1__secondary_nodeadlock" -noTE -deadlock lifecycle.tla
TLC_JAR_SHA256: eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a
BUDGET_SEC: 1800
START_UTC: 2026-08-30T22:04:07.6906875Z
END_UTC: 2026-08-30T22:04:10.6231626Z
WALL_CLOCK_SEC: 2.1
OUTCOME: PROCESS_EXITED
EXIT_CODE: 12
PEAK_JVM_WORKING_SET_MB: 0
PEAK_METADIR_MB: 0.1
----- TLC STDOUT -----
TLC2 Version 2026.08.21.155922 (rev: 9787e65)
Running breadth-first search Model-Checking with fp 53 and seed 7863375294384678292 with 12 workers on 12 cores with 5461MB heap and 64MB offheap memory [pid: 20400] (Windows 11 10.0 amd64, Oracle Corporation 20.0.2 64bit, MSBDiskFPSet, DiskStateQueue).
Parsing file C:\Users\soman\OneDrive\Desktop\RobotX\formal\lifecycle.tla (file:/c:/Users/soman/OneDrive/Desktop/RobotX/formal/lifecycle.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-11302719119123742352\Integers.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Integers.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-11302719119123742352\FiniteSets.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/FiniteSets.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-11302719119123742352\Sequences.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Sequences.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-11302719119123742352\TLC.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/TLC.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-11302719119123742352\Naturals.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Naturals.tla)
Semantic processing of module Naturals
Semantic processing of module Integers
Semantic processing of module Sequences
Semantic processing of module FiniteSets
Semantic processing of module TLC
Semantic processing of module lifecycle
Linting of module lifecycle
Starting... (2026-08-31 03:34:08)
Implied-temporal checking--satisfiability problem has 6 branches.
Computing initial states...
Finished computing initial states: 1 distinct state generated at 2026-08-31 03:34:08.
Error: Invariant Safety is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "QUEUED" @@ l2 :> "QUEUED")
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE)

State 2: <Plan(l1) line 148, col 5 to line 150, col 73 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE")
/\ ticks = 0
/\ legState = (l1 :> "PLANNED" @@ l2 :> "QUEUED")

State 3: <Offer(l1) line 158, col 5 to line 163, col 73 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "OFFERED" @@ l2 :> "QUEUED")

/\ taskState = "WAITING"
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE)
State 4: <Accept(l1) line 166, col 5 to line 171, col 47 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE")
/\ ticks = 0
/\ taskState = "IN_EXECUTION"
/\ legState = (l1 :> "ACCEPTED" @@ l2 :> "QUEUED")

State 5: <Depart(l1) line 184, col 5 to line 186, col 73 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE")
/\ ticks = 0
/\ taskState = "IN_EXECUTION"
/\ legState = (l1 :> "EN_ROUTE_PICKUP" @@ l2 :> "QUEUED")

State 6: <ArrivePickup(l1) line 189, col 5 to line 191, col 73 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE")
/\ ticks = 0
/\ taskState = "IN_EXECUTION"
/\ legState = (l1 :> "AT_PICKUP" @@ l2 :> "QUEUED")

State 7: <Load(l1) line 194, col 5 to line 198, col 54 of module lifecycle>
/\ everHeld = (l1 :> TRUE @@ l2 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE)
/\ custody = (l1 :> "HELD" @@ l2 :> "NONE")
/\ ticks = 0
/\ taskState = "IN_EXECUTION"
/\ legState = (l1 :> "LOADED" @@ l2 :> "QUEUED")

State 8: <CancelWithCustody(l1) line 275, col 5 to line 278, col 73 of module lifecycle>
/\ everHeld = (l1 :> TRUE @@ l2 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE)
/\ custody = (l1 :> "HELD" @@ l2 :> "NONE")
/\ ticks = 0
/\ taskState = "IN_EXECUTION"
/\ legState = (l1 :> "ABORTING" @@ l2 :> "QUEUED")

State 9: <TimerFires(l1) line 316, col 5 to line 347, col 82 of module lifecycle>
/\ everHeld = (l1 :> TRUE @@ l2 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE)
/\ custody = (l1 :> "HELD" @@ l2 :> "NONE")
/\ ticks = 1
/\ taskState = "IN_EXECUTION"
/\ legState = (l1 :> "STRANDED_OBSTRUCTING" @@ l2 :> "QUEUED")

1108 states generated, 296 distinct states found, 87 states left on queue.
The depth of the complete state graph search is 9.
Finished in 00s at (2026-08-31 03:34:08)

----- TLC STDERR -----

```

### 12.8 `lifecycle_c2.cfg` `-deadlock` — SECONDARY DIAGNOSTIC — **`Invariant Safety is violated`**

**Class: SECONDARY DIAGNOSTIC. NOT AUTHORITATIVE.** Same trace shape as §12.7, at capacity 2.

```text
COMMAND (run from c:\Users\soman\OneDrive\Desktop\RobotX\formal):
  java -Xmx6g -XX:+UseParallelGC -jar "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\tla2tools.jar" -config lifecycle_c2.cfg -workers auto -metadir "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\out\meta_lifecycle_c2__secondary_nodeadlock" -noTE -deadlock lifecycle.tla
TLC_JAR_SHA256: eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a
BUDGET_SEC: 1800
START_UTC: 2026-08-30T22:04:10.6600347Z
END_UTC: 2026-08-30T22:04:13.5113298Z
WALL_CLOCK_SEC: 2
OUTCOME: PROCESS_EXITED
EXIT_CODE: 12
PEAK_JVM_WORKING_SET_MB: 0
PEAK_METADIR_MB: 0.8
----- TLC STDOUT -----
TLC2 Version 2026.08.21.155922 (rev: 9787e65)
Running breadth-first search Model-Checking with fp 8 and seed -1257197656242210578 with 12 workers on 12 cores with 5461MB heap and 64MB offheap memory [pid: 15484] (Windows 11 10.0 amd64, Oracle Corporation 20.0.2 64bit, MSBDiskFPSet, DiskStateQueue).
Parsing file C:\Users\soman\OneDrive\Desktop\RobotX\formal\lifecycle.tla (file:/c:/Users/soman/OneDrive/Desktop/RobotX/formal/lifecycle.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15531364152832675786\Integers.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Integers.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15531364152832675786\FiniteSets.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/FiniteSets.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15531364152832675786\Sequences.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Sequences.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15531364152832675786\TLC.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/TLC.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15531364152832675786\Naturals.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Naturals.tla)
Semantic processing of module Naturals
Semantic processing of module Integers
Semantic processing of module Sequences
Semantic processing of module FiniteSets
Semantic processing of module TLC
Semantic processing of module lifecycle
Linting of module lifecycle
Starting... (2026-08-31 03:34:11)
Implied-temporal checking--satisfiability problem has 9 branches.
Computing initial states...
Finished computing initial states: 1 distinct state generated at 2026-08-31 03:34:11.
Error: Invariant Safety is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "QUEUED" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED")

State 2: <Plan(l1) line 148, col 5 to line 150, col 73 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "PLANNED" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED")

State 3: <Offer(l1) line 158, col 5 to line 163, col 73 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "OFFERED" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED")

State 4: <Accept(l1) line 166, col 5 to line 171, col 47 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE")
/\ ticks = 0
/\ taskState = "IN_EXECUTION"
/\ legState = (l1 :> "ACCEPTED" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED")

State 5: <Depart(l1) line 184, col 5 to line 186, col 73 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE")
/\ ticks = 0
/\ taskState = "IN_EXECUTION"
/\ legState = (l1 :> "EN_ROUTE_PICKUP" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED")

State 6: <ArrivePickup(l1) line 189, col 5 to line 191, col 73 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE")
/\ ticks = 0
/\ taskState = "IN_EXECUTION"
/\ legState = (l1 :> "AT_PICKUP" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED")

State 7: <Load(l1) line 194, col 5 to line 198, col 54 of module lifecycle>
/\ everHeld = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ custody = (l1 :> "HELD" @@ l2 :> "NONE" @@ l3 :> "NONE")
/\ ticks = 0
/\ taskState = "IN_EXECUTION"
/\ legState = (l1 :> "LOADED" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED")

State 8: <CancelWithCustody(l1) line 275, col 5 to line 278, col 73 of module lifecycle>
/\ everHeld = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ custody = (l1 :> "HELD" @@ l2 :> "NONE" @@ l3 :> "NONE")
/\ ticks = 0
/\ taskState = "IN_EXECUTION"
/\ legState = (l1 :> "ABORTING" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED")

State 9: <TimerFires(l1) line 316, col 5 to line 347, col 82 of module lifecycle>
/\ everHeld = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE)
/\ custody = (l1 :> "HELD" @@ l2 :> "NONE" @@ l3 :> "NONE")
/\ ticks = 1
/\ taskState = "IN_EXECUTION"
/\ legState = (l1 :> "STRANDED_OBSTRUCTING" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED")

4853 states generated, 1051 distinct states found, 441 states left on queue.
The depth of the complete state graph search is 9.
Finished in 01s at (2026-08-31 03:34:12)

----- TLC STDERR -----

```

### 12.9 `lifecycle_c3.cfg` `-deadlock` — SECONDARY DIAGNOSTIC — **`Invariant Safety is violated`**

**Class: SECONDARY DIAGNOSTIC. NOT AUTHORITATIVE.** Same trace shape as §12.7, at capacity 3.

```text
COMMAND (run from c:\Users\soman\OneDrive\Desktop\RobotX\formal):
  java -Xmx6g -XX:+UseParallelGC -jar "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\tla2tools.jar" -config lifecycle_c3.cfg -workers auto -metadir "C:\Users\soman\AppData\Local\Temp\claude\c--Users-soman-OneDrive-Desktop-RobotX\da2fc863-978c-492c-ad69-269e923821e7\scratchpad\bm-tlc\out\meta_lifecycle_c3__secondary_nodeadlock" -noTE -deadlock lifecycle.tla
TLC_JAR_SHA256: eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a
BUDGET_SEC: 1800
START_UTC: 2026-08-30T22:05:27.1147106Z
END_UTC: 2026-08-30T22:05:32.1466111Z
WALL_CLOCK_SEC: 4.2
OUTCOME: PROCESS_EXITED
EXIT_CODE: 12
PEAK_JVM_WORKING_SET_MB: 11
PEAK_METADIR_MB: 4.5
----- TLC STDOUT -----
TLC2 Version 2026.08.21.155922 (rev: 9787e65)
Running breadth-first search Model-Checking with fp 71 and seed -9222444302098371765 with 12 workers on 12 cores with 5461MB heap and 64MB offheap memory [pid: 16120] (Windows 11 10.0 amd64, Oracle Corporation 20.0.2 64bit, MSBDiskFPSet, DiskStateQueue).
Parsing file C:\Users\soman\OneDrive\Desktop\RobotX\formal\lifecycle.tla (file:/c:/Users/soman/OneDrive/Desktop/RobotX/formal/lifecycle.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15522453656735787431\Integers.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Integers.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15522453656735787431\FiniteSets.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/FiniteSets.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15522453656735787431\Sequences.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Sequences.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15522453656735787431\TLC.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/TLC.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-15522453656735787431\Naturals.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Naturals.tla)
Semantic processing of module Naturals
Semantic processing of module Integers
Semantic processing of module Sequences
Semantic processing of module FiniteSets
Semantic processing of module TLC
Semantic processing of module lifecycle
Linting of module lifecycle
Starting... (2026-08-31 03:35:27)
Implied-temporal checking--satisfiability problem has 12 branches.
Computing initial states...
Finished computing initial states: 1 distinct state generated at 2026-08-31 03:35:28.
Error: Invariant Safety is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE" @@ l4 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "QUEUED" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED" @@ l4 :> "QUEUED")

State 2: <Plan(l1) line 148, col 5 to line 150, col 73 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE" @@ l4 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "PLANNED" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED" @@ l4 :> "QUEUED")

State 3: <Offer(l1) line 158, col 5 to line 163, col 73 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE" @@ l4 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "OFFERED" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED" @@ l4 :> "QUEUED")

State 4: <Accept(l1) line 166, col 5 to line 171, col 47 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE" @@ l4 :> "NONE")
/\ ticks = 0
/\ taskState = "IN_EXECUTION"
/\ legState = (l1 :> "ACCEPTED" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED" @@ l4 :> "QUEUED")

State 5: <Depart(l1) line 184, col 5 to line 186, col 73 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE" @@ l4 :> "NONE")
/\ ticks = 0
/\ taskState = "IN_EXECUTION"
/\ legState = (l1 :> "EN_ROUTE_PICKUP" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED" @@ l4 :> "QUEUED")

State 6: <ArrivePickup(l1) line 189, col 5 to line 191, col 73 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE" @@ l3 :> "NONE" @@ l4 :> "NONE")
/\ ticks = 0
/\ taskState = "IN_EXECUTION"
/\ legState = (l1 :> "AT_PICKUP" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED" @@ l4 :> "QUEUED")

State 7: <Load(l1) line 194, col 5 to line 198, col 54 of module lifecycle>
/\ everHeld = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ custody = (l1 :> "HELD" @@ l2 :> "NONE" @@ l3 :> "NONE" @@ l4 :> "NONE")
/\ ticks = 0
/\ taskState = "IN_EXECUTION"
/\ legState = (l1 :> "LOADED" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED" @@ l4 :> "QUEUED")

State 8: <CancelWithCustody(l1) line 275, col 5 to line 278, col 73 of module lifecycle>
/\ everHeld = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ custody = (l1 :> "HELD" @@ l2 :> "NONE" @@ l3 :> "NONE" @@ l4 :> "NONE")
/\ ticks = 0
/\ taskState = "IN_EXECUTION"
/\ legState = (l1 :> "ABORTING" @@ l2 :> "QUEUED" @@ l3 :> "QUEUED" @@ l4 :> "QUEUED")

State 9: <TimerFires(l1) line 316, col 5 to line 347, col 82 of module lifecycle>
/\ everHeld = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ hardCommitted = (l1 :> TRUE @@ l2 :> FALSE @@ l3 :> FALSE @@ l4 :> FALSE)
/\ custody = (l1 :> "HELD" @@ l2 :> "NONE" @@ l3 :> "NONE" @@ l4 :> "NONE")
/\ ticks = 1
/\ taskState = "IN_EXECUTION"
/\ legState = ( l1 :> "STRANDED_OBSTRUCTING" @@
  l2 :> "QUEUED" @@
  l3 :> "QUEUED" @@
  l4 :> "QUEUED" )

The depth of the complete state graph search is 9.
21078 states generated, 3812 distinct states found, 1794 states left on queue.
Finished in 02s at (2026-08-31 03:35:29)

----- TLC STDERR -----

```

---

### 12.10 `lifecycle_c1.cfg` — SUPERSEDED EXPLORATORY RUN — **NOT a result**

**Class: SUPERSEDED EXPLORATORY. NOT AUTHORITATIVE AND NOT A RESULT.**
An earlier run at `03:29` local, under **different flags** — no `-noTE`, no `-XX:+UseParallelGC`, 6144 MB heap
(TLC emits its own `Warning: Please run the Java VM … -XX:+UseParallelGC` in consequence), and with the
trace-exploration spec enabled. **Superseded by §12.4**, which is the authoritative capacity-1 lifecycle run.

Retained for two reasons. First, it independently reproduces the same deadlock abort at depth 6 under a
different JVM configuration. Second, it is the run whose final line reads
`Trace exploration spec path: .\lifecycle_TTrace_1788127170.tla` — **that generated file landed in the
scratch output directory and NOT in `formal/`**, which is why `-noTE` was used for every run thereafter.
`formal/` contains exactly the two `.tla` modules, six `.cfg` files and `README.md` it contained before
this pass.

```text
TLC2 Version 2026.08.21.155922 (rev: 9787e65)
Warning: Please run the Java VM, which executes TLC with a throughput optimized garbage collector, by passing the "-XX:+UseParallelGC" property.
(Use the -nowarning option to disable this warning.)
Running breadth-first search Model-Checking with fp 16 and seed 2976016224110861876 with 12 workers on 12 cores with 6144MB heap and 64MB offheap memory [pid: 18092] (Windows 11 10.0 amd64, Oracle Corporation 20.0.2 64bit, MSBDiskFPSet, DiskStateQueue).
Parsing file C:\Users\soman\OneDrive\Desktop\RobotX\formal\lifecycle.tla
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-16112591104552431030\Integers.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Integers.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-16112591104552431030\FiniteSets.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/FiniteSets.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-16112591104552431030\Sequences.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Sequences.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-16112591104552431030\TLC.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/TLC.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-16112591104552431030\_TLCTrace.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/_TLCTrace.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-16112591104552431030\Naturals.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/Naturals.tla)
Parsing file C:\Users\soman\AppData\Local\Temp\tlc-16112591104552431030\TLCExt.tla (jar:file:/C:/Users/soman/AppData/Local/Temp/claude/c--Users-soman-OneDrive-Desktop-RobotX/da2fc863-978c-492c-ad69-269e923821e7/scratchpad/bm-tlc/tla2tools.jar!/tla2sany/StandardModules/TLCExt.tla)
Semantic processing of module Naturals
Semantic processing of module Integers
Semantic processing of module Sequences
Semantic processing of module FiniteSets
Semantic processing of module TLC
Semantic processing of module TLCExt
Semantic processing of module _TLCTrace
Semantic processing of module lifecycle
Linting of module TLCExt
Linting of module _TLCTrace
Linting of module lifecycle
Starting... (2026-08-31 03:29:30)
Implied-temporal checking--satisfiability problem has 6 branches.
Computing initial states...
Finished computing initial states: 1 distinct state generated at 2026-08-31 03:29:31.
Error: Deadlock reached.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "QUEUED" @@ l2 :> "QUEUED")

State 2: <Cancel(l1) line 268, col 5 to line 272, col 58 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "CANCELLED" @@ l2 :> "QUEUED")

State 3: <Cancel(l2) line 268, col 5 to line 272, col 58 of module lifecycle>
/\ everHeld = (l1 :> FALSE @@ l2 :> FALSE)
/\ hardCommitted = (l1 :> FALSE @@ l2 :> FALSE)
/\ custody = (l1 :> "NONE" @@ l2 :> "NONE")
/\ ticks = 0
/\ taskState = "WAITING"
/\ legState = (l1 :> "CANCELLED" @@ l2 :> "CANCELLED")

269 states generated, 92 distinct states found, 41 states left on queue.
The depth of the complete state graph search is 6.
Finished in 01s at (2026-08-31 03:29:31)
Trace exploration spec path: .\lifecycle_TTrace_1788127170.tla
```

---

## 13. B-M status after this run record

# B-M REMAINS **OPEN**. EVIDENCE STATE: **NOT MEASURED / OPEN**.

**What the evidence establishes:**

| Item | State |
|---|---|
| `commitment_c1.cfg` | **PROVEN / PASS — exhaustive**, complete state graph, no error |
| `commitment_c2.cfg` | **UNKNOWN** — did not converge |
| `commitment_c3.cfg` | **UNKNOWN** — did not converge |
| `lifecycle_c1.cfg` | **FAIL** — deadlock abort; no declared property reached a verdict |
| `lifecycle_c2.cfg` | **FAIL** — deadlock abort; no declared property reached a verdict |
| `lifecycle_c3.cfg` | **FAIL** — deadlock abort; no declared property reached a verdict |
| **Independent acceptance (§7.3a item 10, §7.6)** | **NOT COMPLETE** |
| **Named operator (§7.3a item 4)** | **NOT SATISFIED** |
| **Boundedness accepted (§7.3a item 8)** | **NOT ACCEPTED** |
| **G5 coverage (§7.3a item 7)** | **NOT COVERED by any TLC run, by construction** |

### The compute requirement is NOT satisfied

**TLC was provisioned. That is not the same thing.** §7.3 requires *"all six configurations
completing"*, and one did. The two commitment configurations that did not converge are the same two
that had never completed on any machine tried before this one, and this machine — a 16 GB laptop
with 45 GB of free disk — is not the compute §7.6 assigns to Compute/Platform.

**Do not report B-M as advanced because a jar was downloaded.** What changed is that the six
configurations now have measured outcomes instead of no outcomes. **Four of the six outcomes are
worse than "unmeasured": two are unfinished searches and three are failures.**

### The closure condition is unchanged

From `PHASE_15_BLOCKERS.md` § **B-M**, unaltered by this pass:

> **Closure condition:** the checked-in configurations completed exhaustively, recorded with the
> provenance above, and accepted by the release owner; then the flag removed.

**One of six completed. No acceptance exists. `establishedByCommand` stays.**

### And the gate row still cannot be used to track this

`model_check_capacity_1_2_3` was GREEN with a `[NOT PROVEN]` annotation before these runs and is
GREEN with a `[NOT PROVEN]` annotation after them. **On the current tree it renders RED `[STALE]`,
for staleness and not for a gate failing.** None of those renderings is affected by anything in
this document. **This register and `B1_EXTERNAL_INPUT_HANDOFF.md` §7 are where B-M's state lives.**

---

## 14. Two things this record separates, and they must stay separate

| | |
|---|---|
| **Phase 15 implementation remains FROZEN** | The freeze at `c27a75c` is intact. No application source, schema, migration, test or configuration was changed. The implementation verdict is unchanged. **Nothing found by this pass is a Phase 15 implementation defect** |
| **Formal verification has uncovered a specification-level blocker** | **X4** — `lifecycle.tla`'s `CustodyMatchesState` is contradicted by `Strand` and `TimerFires`, while `Recovered` is written to resolve the very state the invariant forbids. This is a **specification / formal-model / safety-engineering** finding. **It is new, it is real, and it is not B-M** |

**These are not the same statement and neither implies the other.** A frozen, unmodified
implementation is entirely consistent with a formal model that contradicts itself — the model is a
transcription of the *specification*, not of the code (§10.6). **The freeze is not evidence that X4
is benign, and X4 is not evidence that the freeze was wrong.**

**B-M, X4 and X5 are three separate items with three different owners.** Do not merge them, and do
not close any of them on the strength of another.

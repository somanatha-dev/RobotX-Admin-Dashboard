# Phase 15 — Blocker Register

**The canonical list of what prevents Phase 15 from closing.**

> Current source of truth for navigation and verdict: **[`PHASE_15_MASTER.md`](PHASE_15_MASTER.md)**.
> Evidence for every "last verified" line below: [`PHASE_15_VERIFICATION_STATE.md`](PHASE_15_VERIFICATION_STATE.md).

**Last verified:** **2026-08-30** · **Tree:** digest `d033038cb261c3de…` (**573 files**), HEAD
**`7335260`** — the T1-04 / `Leg.slaDeadline` / V-10 work was **committed as a snapshot** before V-9
ran, and **the digest did not move**. *(This line read "HEAD `67b7c7c` + uncommitted …", which
describes the same content under its previous git identity; corrected 2026-08-31 by the freeze
audit. Previously 2026-08-29 at `431010ace188c4b1…` / 565 files / HEAD `b68dc5d` — superseded.)*
**Re-verified 2026-08-29** by the documentation-integrity audit: every blocker below re-derived from
the current repository; blocker count and classifications unchanged. The audit added the
§ *Cross-phase documentation discrepancies* register at the end and found **no new blocker**.

> **Updated 2026-08-30 by closure item V-10** (tree now digest `d033038c…`, 573 files). **The
> blocker count and every classification are unchanged.** What moved:
> - **B1 gained a fifth item of required engineering work** — the coordinator does not read the
>   per-shard cutover switch, so a Rollback A does not stop a running coordinator. Filed, not
>   implemented; see B1 item 5.
> - **Residual observation 2 is discharged** — the rollback runbook has now been executed
>   against the current API. Observation 1 (**P15-F7a**) is unchanged and still open.
> - **A new closed section, § *V-10*,** records the five defects it found.
> - **`release-evidence.json` has aged out.** `release:verdict` now reports 0 green / 17 red /
>   7 not evaluated — every RED for `[STALE]`, not for a gate failing. No blocker moves; the
>   verdict was and is BLOCKED. See `PHASE_15_VERIFICATION_STATE.md` §3.0.
>
> **Re-audited 2026-08-30, after V-10 closed** — every blocker below re-derived from the current
> tree (digest `d033038c…`, 573 files; `gate:composition` exit 1 at **19** registered workers;
> `release:verdict` exit 1 at 0/17/7). **The blocker count is still 7, every classification is
> unchanged, 0 are repository-owned and actionable, and no new blocker was found.** The audit
> corrected stale *numbers* in this register — the worker count in B1's evidence, and rows C1, C3
> and C7 of the cross-phase table — and **changed no finding, no severity and no owner.** In
> particular **nothing in § *V-10* was altered**: its five findings stand exactly as recorded.

## Summary

| Count | |
|---:|---|
| **9** | Open blockers — **was 7; X4 and X5 added 2026-08-31 by the B-M TLC execution** |
| **0** | REPOSITORY-OWNED and actionable |
| **2** | EXTERNAL (B1, B8) |
| **2** | SPECIFICATION / ADR / SAFETY (X3, **X4**) — X1/T1-04 was a third and is now closed |
| **1** | FORMAL-VERIFICATION CONFIGURATION (**X5**) |
| **3** | EVIDENCE / OPERATIONS (B-P, B-O, B-M) |
| **1** | REPOSITORY-OWNED but correctly deferred to another phase (A9) |
| **0** | NOT EVALUATED |

> ### ⚠ Updated 2026-08-31 — TLC was executed for the first time. **B-M did not close. Two new blockers opened.**
>
> `tla2tools.jar` was provisioned (v1.8.0 release asset, SHA-256
> `eabd140a…533a`) and **all six checked-in configurations were run on the frozen tree**. Full
> §7.3a record with the **raw TLC output retained verbatim**:
> **[`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md)**.
>
> | | |
> |---|---|
> | **B-M** | **STILL OPEN — evidence state NOT MEASURED / OPEN.** 1 of 6 configurations closed. `commitment_c1` exhaustive PASS; `commitment_c2`/`c3` **UNKNOWN**, did not converge; `lifecycle_c1`/`c2`/`c3` **FAIL**. No independent acceptance. **The compute requirement is NOT satisfied merely because TLC was provisioned** |
> | **X4 — NEW** | `lifecycle.tla`'s `CustodyMatchesState` is contradicted by `Strand` and `TimerFires`, while `Recovered` is written to resolve the very state it forbids. **SPECIFICATION / FORMAL MODEL / SAFETY.** Explicitly **separate from B-M** |
> | **X5 — NEW** | The three checked-in `lifecycle_c*.cfg` abort on TLC's default deadlock check before any declared property is evaluated. **FORMAL-VERIFICATION CONFIGURATION.** Explicitly **separate from X4 and from B-M** |
>
> **No source file, `.tla`, `.cfg`, schema, test or configuration was changed.** The Phase 15
> implementation freeze at `c27a75c` is intact and its verdict is unchanged. `formal/` and `docs/`
> are outside the source-digest scope, so **the digest `d033038c…` did not move.**
> **B1, B8, B-P, B-O, X3 and A9 were not touched** — only the counts above changed, arithmetically.

Plus **7 residual in-repository observations** — reported, not fixed, none permissive
*(was 6; observation 2 was discharged by **V-10** and **observation 8 was added by V-9** on
2026-08-30 — a pre-existing silent-partial-seed defect that is not Phase 15's)*. They are listed
at the end and are **not** counted as blockers.

> **Updated 2026-08-30 by closure item V-9** — the Phase 0–14 cross-phase re-verification,
> executed for the first time. **No blocker moved, no classification changed, and no new blocker
> was found.** 7 Phase 0–14 harnesses on a disposable cluster, **315/317**, both failures being
> `phase5ExpirySemantics` FINDING assertions whose premise T1-04 deliberately invalidated. **No
> code was changed and the digest is unmoved.** What moved: a new closed section, § *V-9*, and
> **residual observation 8**. Full record: `PHASE_15_VERIFICATION_STATE.md` §7c.

**Standing rule for this register.** A blocker is not re-opened because an archived report carries
an older classification, and not closed because an archived report says "FIXED". Each entry below
was re-derived from the current repository on 2026-08-29.

> **Scope of the 2026-08-31 update, stated so it is not overread.** That pass executed TLC and
> nothing else. It **re-derived only B-M**, and it **added X4 and X5**. It did **not** re-derive
> **B1, B8, B-P, B-O, X3 or A9** — those entries are unchanged and still carry their own
> "Last verified" dates. The header's tree line is unchanged for the same reason: the pass changed
> no source, so the digest did not move. HEAD is now **`c27a75c`**, the Phase 15 freeze commit.

---

## B1 — No routing engine is selected

**Status:** OPEN
**Classification:** **EXTERNAL**
**Owner:** Operations + Commercial (D1) · Product + Fleet Engineering (D3) · Operations (D8)
**First discovered:** 2026-08-08 (`PHASE_15_B1_ROUTING_DECISION_REPORT.md`). Originally recorded as
in-repository composition work (D-4 / D-5); **reclassified to EXTERNAL on 2026-08-22** and
re-confirmed EXTERNAL by every pass since.
**Last verified:** 2026-08-29

**Current evidence:**
- `npm run gate:composition` → exit **1**, **1 violation across 19 registered workers**:
  `coordinator` `[LEADER_ONLY_NOT_COMPOSABLE]`, owner declared **EXTERNAL** by the gate itself.
  *(Re-run 2026-08-30. Was "1 violation of 18"; T1-04 added a 19th worker and **the violation
  count did not move**.)*
- `npm run release:verdict` → §24 gate `engine_decision_path_wired` **RED**.
- `npm run routing:readiness` → `OVERALL: BLOCKED`; D1, D3, D8 each BLOCKED; Steps 1, 3, 4, 5
  BLOCKED; Step 2 PASS.
- `tools/verify/phase15CurrentTree.js` check **G2** confirms coordinator and shadow remain
  uncomposable.

**Why it blocks:** `coordinator`'s round loop needs `expandCandidates`, `pricedCandidateFor` and
`commit`. The first two resolve through `plan/insertion.js → planBuilder.hopsForSequence →
routing/cellPairCache.hopsFor` to an injected `route` function — the routing engine. With no engine
selected, the Tier 0 decision path has no leaf. `engine_decision_path_wired` is one of 24 blocking
§24 gates.

**Three workers, not one, are held by B1.** `gate:composition` fails on `coordinator` alone,
because it is the only one *declared* `LEADER_ONLY` and therefore expected to start. Two more are
`DEFERRED` on the same dependency and so pass the gate by declaration:

| Worker | Readiness | Consequence of B1 |
|---|---|---|
| `coordinator` | `LEADER_ONLY` | Gate violation. No round can execute |
| `shadow` | `DEFERRED` | **`shadow_agreement` cannot begin accumulating evidence at all.** The system is not merely short of the 14-day window — it cannot start the clock. This is why **B-P** is gated by B1 |
| `charger_reachability` | `DEFERRED` | Scheduling it needs the routing client this process does not construct (Phase 8's `routing/client.js`) |

Full readiness breakdown: [`PHASE_15_IMPLEMENTATION_STATE.md`](PHASE_15_IMPLEMENTATION_STATE.md)
§ *Workers and the composition root*.

**Can repository code solve it?** **No.** Selection is B1 Step 5: a choice made on recorded
benchmark evidence and written into an ADR. Step 3 evidence cannot be produced because Step 1
(deploy each candidate against the target region extract, build per-profile contraction hierarchies)
requires a region that does not exist.

**Required external input.** The field-by-field requirements, per-field ownership and evidence, the
operator deployment-module contract and B1's execution order are in
**[`B1_EXTERNAL_INPUT_HANDOFF.md`](B1_EXTERNAL_INPUT_HANDOFF.md)** — the single operational handoff
for this blocker. Summary only below.

| | Owner | What is missing |
|---|---|---|
| **D1** | Operations + Commercial | **Partially answered 2026-08-30 — still BLOCKED.** The owner has declared two independent campus regions with `regionId`, `name`, `kind: CAMPUS`, `crs: OGC:CRS84`, version + date, and an adopted boundary feature each; JSSATE's geometry is pinned as an external snapshot. **Still missing:** the RNSIT snapshot artefact, the cell cover (see below), and every governance record — no approval, no Commercial confirmation, no Architecture approval exists. Full record: [`B1_EXTERNAL_INPUT_HANDOFF.md`](B1_EXTERNAL_INPUT_HANDOFF.md) §1.8 |
| **D3** | Product + Fleet Engineering | The agent classes this deployment operates and, per distinct mobility model, §2.2's six elements with a real speed model over `roadClass`, `gradient`, `surface`, `payloadMass`, `congestion`, `weather` |
| **D8** | Operations | Extract identity, source, vintage (ISO date, never a file timestamp), refresh cadence, re-contraction downtime budget, **plus `extract.bbox` and `extract.marginDegrees`** (read by validator V-13) |

D1 additionally releases: the cell cover (Engineering), the charger catalogue (Ops / Charging — now
required, not optional), V-11 disjointness, V-12 containment, V-13 margin, D2's residual (N23), and
`projectCell()` (N27).

**D1's live sub-blocker since 2026-08-30 is architectural, not a missing input.** The approved
JSSATE boundary is ≈0.1022 km² against a ≈0.7373 km² H3 res-8 cell, so standard `polygonToCells`
returns **zero** fine cells and **V-8 fires** — and `cover.cardinalityException` cannot rescue it,
because that exception is read only inside the V-9 branch. The owner has **refused** both
over-assigning containment modes (`containmentOverlapping`, `containmentOverlappingBbox`) and has
escalated the coverage-semantics question, but **the escalation target is NOT DEFINED**: RobotX has
no separate Architecture, Commercial or approval authority, and none may be invented or inferred.
So D1 is currently blocked on a **governance vacuum**. Measurements, refusals and consequences:
[`B1_EXTERNAL_INPUT_HANDOFF.md`](B1_EXTERNAL_INPUT_HANDOFF.md) §1.8.3–§1.8.5. **D3 and B-M are not
behind this escalation.**

**Required engineering work after the dependency arrives:**
1. B1 Steps 1, 3, 4 — deploy, benchmark, record.
2. B1 Step 5 — write the ADR selecting the engine.
3. `src/engine/routing/client.js` — the production Routing Service client (§5.2's degradation ladder,
   §18.3 B6's uniform-treatment rule, the `route(parts)` seam). **Phase 8**, also blocked by N25/N26.
4. Composition-root construction at `server.js`: `evaluateExact`, `pricedCandidateFor`,
   `hopsForSequence`, plus the routing client and charger precompute trigger. **Estimate as
   composition-root work, not adapter wiring.**
5. **NEW, added by V-10 on 2026-08-30 — the coordinator does not read the per-shard cutover
   switch, so a Rollback A does not stop a running coordinator.** Measured on the current tree:
   `cutover.engine_enabled` (via `cutover/enabled.js`) has exactly **four** production consumers
   — `services/task.service.js` (intake, 503 `ENGINE_NOT_LIVE`), `cutover/agentGate.js` (all five
   socket handlers), `controllers/health.controller.js` (reporting) and `cutover/store.liveShards()`
   (the guardrail controller's own enumeration). **`workers/coordinator.worker.js` is not among
   them**: `runRound()` takes no configuration snapshot and asks no cutover question, and
   `server.js` gates the coordinator lifecycle on `ENGINE_ENABLED` — the *process* half — only.
   So Rollback A stops new work **entering** a shard and does not stop a coordinator already
   draining that shard's `WorkQueue`.

   **It is filed here, under B1, and deliberately not implemented.** The gate needs a
   configuration snapshot injected into a worker that **cannot be composed at all** until B1
   selects an engine. Writing it now would produce a guard whose only caller does not exist —
   the defect class this register was created to stop (Phase 14 wrote nine such guards, tested
   all, called none), and the same reasoning that keeps **A9** deferred. `docs/runbooks/rollback.md`
   §2 now states plainly that the stand-down is not enforced by configuration, instead of
   promising it.

   *It is invisible today rather than harmless: no coordinator runs, because `leaderWorkers`
   refuses to compose one. The two states are indistinguishable in this deployment, which is
   exactly why five passes did not notice.*

**Do not:**
- Select, rank, recommend or hint at an engine. `b1Readiness.js` explicitly refuses to, and so must you.
- Invent a region, boundary, CRS, speed model, extract vintage or bbox.
- Treat `prisma/seed.js`'s `SEED_SPATIAL_MAP` / `RGN-BLR` as production configuration. It is a Phase 2
  containment demonstration: four fine cells, placeholder cell ids, never published as a config version.
- Write a stub, fake or in-process router to make `gate:composition` pass. Starting the coordinator
  against an invented router assigns real work on invented travel times.
- Use `DEGRADED_ROUTING` as a substitute for a routing service.

**Closure condition:** D1, D3 and D8 answered; Steps 1/3/4 executed and recorded; Step 5 ADR
written; the routing client and composition root built; `gate:composition` exits 0;
`engine_decision_path_wired` GREEN.

---

## B8 — Safety-class parameters are not DERIVED

**Status:** OPEN
**Classification:** **EXTERNAL**
**Owner:** §22.4's named calibration owner
**First discovered:** 2026-08-08 · **Last verified:** 2026-08-29

**Current evidence:** `npm run gate:calibration` → exit **1**, `FAIL — 39 blocking finding(s)`.
**250 registered entries: 52 DERIVED, 160 PROVISIONAL, 38 UNCALIBRATED; 54 Safety-class**
— **re-run 2026-08-30 at digest `d033038c…`.**
`phase15CurrentTree.js` check **G3** confirms the gate and the publish validator agree that B8
blocks the cutover (190 launch-gate findings; defaults refused by V9).

> **The register grew and B8 did not — measured, not assumed.** It held **242** entries
> (152 `PROVISIONAL`) on 2026-08-29. **REMEDIAL PHASE T1-04 added exactly 8**, all
> `PROVISIONAL`, all §17.4 ladder-rung fractions:
> `ladder.step_1_widen_radius_fraction` … `ladder.step_8_alternative_modality_fraction`.
> **None of the 8 is Safety-class**, which is why the two numbers that matter here —
> **39 blocking findings and 54 Safety-class entries — are unchanged.** T1-04 added no
> Safety-class calibration debt, and this row's totals had simply never been re-measured
> after it. Nothing about B8's ownership, closure condition or classification moves.

**Why it blocks:** §22.4 — no Tier 0 parameter may be `PROVISIONAL` or `UNCALIBRATED` at launch.
§24 gate `calibration_safety_derived` is `NOT_EVALUATED`, which blocks exactly as RED.

**Can repository code solve it?** **No.** Every one of the 39 findings names what it awaits, and
none of them is a code change — e.g. *"per-class rated-mass certification"*, *"the operated CA's
revocation-publication latency"*, *"a safety decision with the local highway or site authority"*,
*"measured on-board scale accuracy per container model"*.

**Required external input:** a named calibration owner, and per-parameter derivation from a stated
accounting or measured basis (§22.4's `DERIVED` definition).

**One worker is held by B8.** `energy_calibration` is `DEFERRED` — it exposes a pass function
rather than a scheduler, and its inputs are realised-outcome rows the fleet has not produced. The
registry records it as one of the loops B8's calibration owner governs. It does not fail
`gate:composition`, because the deferral is declared.

**Required engineering work after the dependency arrives:** record the derived values and their
bases in the register; `gate:calibration` then passes without any code change.

**Do not:** derive, invent, edit, promote or reclassify any calibration value. **§22.3 forbids any
automated process from changing a Safety-class parameter.** Note in particular that
`release.soak_duration` is still `PROVISIONAL` and was deliberately **not** promoted — an earlier
pass made the system *use* it, which is a different act from calibrating it.

**Closure condition:** 39 findings → 0; `gate:calibration` exit 0; `calibration_safety_derived` GREEN.

---

## B-P — Four PRODUCTION gates are NOT_EVALUATED

**Status:** OPEN
**Classification:** **EVIDENCE / OPERATIONS**
**Owner:** Operations — requires an operating fleet
**First discovered:** 2026-08-08 · **Last verified:** 2026-08-29

**Current evidence:** `release:verdict` shows `invariants_enforced`, `simulator_fidelity`, `soak`
and `shadow_agreement` all `NOT_EVALUATED`. `npm run sim:fidelity` → exit **1**, all 7 models
`NOT_MEASURED`, 6 safety-relevant, no study supplied.

**Why it blocks:** these four gates are discharged by *observed production behaviour over a
declared window*. There is no collector for them; an operator files them by hand. `NOT_EVALUATED`
blocks exactly as RED.

**Can repository code solve it?** **No.** Worse — **the observation cannot even begin**: the shadow
worker cannot compose, for the same reason `coordinator` cannot (B1). The 14-day shadow-agreement
window has no start.

**Required external input:** an operating fleet; a simulator-fidelity study against realised
production data (`sim:fidelity --input <file.json>`); a completed soak; a completed shadow window;
an invariant-observation window (execution-plan **OP-8**, a pre-existing gap — I13 consumes the
window, no phase creates it).

**Do not:** fabricate an observation window, a soak record, a fidelity study or a shadow-agreement
result. This is the exact attack surface finding **P15-E1** closed — malformed windows
(`NaN`, `±Infinity`, entirely-in-the-future) were being ADMITTED and PASSED on precisely these four
gates, and would have taken a shard live. The authority now refuses them by name. **Do not weaken
that, and do not route around it.**

**Closure condition:** each of the four filed with a valid, finite, past, sufficiently long
observation window and a genuine result.

---

## B-O — Three ORGANISATIONAL gates are NOT_EVALUATED

**Status:** OPEN
**Classification:** **EVIDENCE / OPERATIONS**
**Owner:** Named humans — the release owner, the calibration owner, the rehearsal operator
**First discovered:** 2026-08-08 · **Last verified:** 2026-08-29

**Current evidence:** `calibration_safety_derived`, `safety_case_assembled` and `rollback_rehearsed`
are all `NOT_EVALUATED`. **0 attestations are filed** — `release-evidence.json` carries 17 build
records and no attestation block.

**Why it blocks:** these are human sign-offs. `npm run safety:case` exits 0 and every reference
resolves, but **the assembler files no evidence** — it reports "0 green, 0 red, 24 not evaluated"
itself. An assembling safety case is not a discharged §24.7 gate.

**Can repository code solve it?** **No.**

**Required external input:** a filed safety-case attestation; a recorded rollback rehearsal per
`docs/runbooks/rollback.md` §5, in a declared non-production environment (ADR-34's `REHEARSAL`
purpose exists for exactly this and sets aside exactly one gate); the B8 calibration attestation.

**Do not:** file an attestation on anyone's behalf. Note that `verdict.js` (and now
`cutover.md` §3.2) forces a gate **RED** when a build record and an attestation collide for the
same gate id — do not attempt to override a build record with an attestation.

**Closure condition:** three attestations filed by named humans and admitted by `evidence.admit()`.

---

## B-M — `model_check_capacity_1_2_3` is GREEN and NOT PROVEN

**Status:** OPEN · **Evidence state: NOT MEASURED / OPEN.** Not `PASS`, and the gate rendering
GREEN is not evidence that it is.
**Classification:** **EVIDENCE / OPERATIONS** (compute provisioning) — an **independent
release-evidence item, NOT a B1 sub-step.** It is independent of D1, D3, D8, routing-engine
selection and B1 Steps 1/3/4/5, in both directions: B-M progress is not B1 progress and B1 progress
is not B-M progress.
**Owner:** **Release owner** (provisions `tla2tools.jar`, executes or coordinates the runs, and
gives **final acceptance**) · **Compute/Platform** (suitable compute and the machine statement) ·
**Safety engineer** (property-coverage and boundedness judgement) · **Engineering** (repository
implementation and mechanical support only — **release authority does not transfer to Engineering**).
Full ownership and the run-record requirements:
[`B1_EXTERNAL_INPUT_HANDOFF.md`](B1_EXTERNAL_INPUT_HANDOFF.md) §7.3a and §7.6.
**First discovered:** pass 3 (as **P15-E5**) · **Last verified:** **2026-08-31 — TLC executed**

### ⚠ 2026-08-31 — the six configurations were RUN. B-M did NOT close.

**`tla2tools.jar` was provisioned and all six checked-in configurations were executed on the frozen
tree.** Full §7.3a record, with the **raw TLC output retained verbatim** and the tool/JDK/machine
provenance: **[`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md)**.

| Configuration | Constants as checked in | Closed? | Result |
|---|---|---|---|
| `commitment_c1.cfg` | 2 Legs / 2 Workers / Cap 1 / MaxFence 4 | **YES** | **PROVEN / PASS — exhaustive.** 17 991 520 states, 2 375 660 distinct, diameter 21, no error, 25 s |
| `commitment_c2.cfg` | 3 / 2 / Cap 2 / MaxFence 5 | **NO** | **UNKNOWN — did not converge.** 287 M distinct found, **126 M still on queue**, **23.6 GiB** disk queue still growing |
| `commitment_c3.cfg` | 4 / 2 / Cap 3 / MaxFence 6 | **NO** | **UNKNOWN — did not converge.** Abnormal exit `-1` at 247 s, 21 M on queue, no TLC error or completion line |
| `lifecycle_c1.cfg` | 2 Legs / Cap 1 / MaxTicks 3 | **NO** | **FAIL — deadlock abort at depth 6** |
| `lifecycle_c2.cfg` | 3 Legs / Cap 2 / MaxTicks 3 | **NO** | **FAIL — deadlock abort at depth 6** |
| `lifecycle_c3.cfg` | 4 Legs / Cap 3 / MaxTicks 3 | **NO** | **FAIL — deadlock abort at depth 6** |

**Tool:** v1.8.0 release asset, SHA-256 `eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a`,
self-reporting `TLC2 Version 2026.08.21.155922 (rev: 9787e65)`. **JDK** Oracle 20.0.2+9-78.
**Machine** LENOVO 21DJ, i5-1235U (12 logical cores), 15.72 GB RAM, 363 GB volume / 45 GB free —
**a contended developer workstation, and the machine slept during the `c2` run** (run record §5.2).

**What this changes about B-M: the outcomes are measured instead of absent. Nothing else.**

- **1 of 6 closed.** §7.3 requires all six. **The lifecycle half has no evidence at any capacity.**
- **§7.3a item 4 (named human operator) NOT satisfied**; **item 8 (boundedness accepted) NOT
  accepted**; **item 10 (release-owner acceptance) NOT given**; **item 7's G5 gap unchanged and
  still uncovered by any TLC run.**
- **The compute requirement is NOT satisfied because TLC was provisioned.** The two commitment
  configurations that did not converge are the same two that had never completed on any machine
  tried before, and this machine is not the compute §7.6 assigns to Compute/Platform.
- **`establishedByCommand` was NOT removed and must not be.**

> **Two NEW blockers came out of these runs and are NOT part of B-M** — see **X4** and **X5**
> below. **Do not fold either into B-M and do not close B-M by resolving either.**

> **One correction owed to `gates.js`, deliberately NOT made.** Its `notEstablishedReason` string
> says *"`lifecycle.tla` has never been run under TLC"*. That is now false — it has been run, and
> it failed. Correcting the string is a source change inside the digest scope and inside the frozen
> implementation, and the sentence **understates** the gap rather than overstating it, so leaving it
> is the conservative choice. Recorded for whoever next has authority over that file.

**Current evidence:** `release:verdict` prints the gate as GREEN with an inline `[NOT PROVEN]`
annotation generated by the tool: *"the discharging suite asserts `exhaustive: false` for the
lifecycle at capacities 1, 2 and 3, and `lifecycle.tla` has never been run under TLC; the commitment
half is exhaustive only at capacity 1."* **That quoted string is the tool's, and its middle clause
is now out of date** — see the correction note above. A repository-wide search still confirms
**`tla2tools.jar` is absent from the repository**; the jar used on 2026-08-31 was provisioned
**outside the tree** and deliberately not added to it, so **"absent from the repo" no longer implies
"TLC has not been run here".**

**Why it blocks:** the gate's *statement* is an exhaustive model check. A passing exit code from the
discharging command does not establish it. The `[NOT PROVEN]` annotation is the honest record of
that gap, deliberately made visible rather than silent.

**Can repository code solve it?** **No** — it needs `tla2tools.jar` and a compute run. The artefacts
it would check (`formal/commitment.tla`, `formal/lifecycle.tla`, six `.cfg` configurations) all
exist.

**Required external input:** `tla2tools.jar` and machine time.

**Required engineering work after the dependency arrives:** run the six configurations per
`formal/README.md`; record the run per the handoff's §7.3a (tool version **and SHA-256**, JDK
version, machine/compute characteristics, named operator and run date, whether each state graph
actually **closed**, state counts/diameter/runtime, the §24.2 properties each run covered,
boundedness explicitly accepted, capacity scope explicitly addressed, and the retained raw output);
then, **on the release owner's recorded acceptance and not before**, remove `establishedByCommand`
from the gate.

**Two structural gaps in the machinery itself — recorded here, NOT to be fixed.** Both verified
against the current tree on 2026-08-29. Do **not** modify `gates.js`, `evidence.js`,
`sourceDigest.js` or any test to accommodate a TLC run:

1. **A completed TLC run has no normal evidence-admission path.** The gate is `EVIDENCE.SUITE` with
   `command: "npm run test:engine -- ModelCheck"` (`gates.js:186-190`), and `evidence.admit()`
   refuses any BUILD/SUITE record whose `run.command` is not that exact command
   (`COMMAND_MISMATCH`, `evidence.js:342-405`). A `java -jar tla2tools.jar …` run cannot be filed
   against this gate, and the schema has no field for any of the provenance items above. **The run
   evidence therefore lives only in the written record — nothing admits, checks or ages it**, and
   the only mechanical act reflecting a discharge is the flag removal above.
2. **`formal/` is outside the source-digest scope.** The digest covers `Backend/{src,tools,tests}`
   plus `package.json` and `jest.config.js` (`sourceDigest.js:33-36`); `formal/` is at the
   repository root. **No evidence record is bound to the state of the two `.tla` modules or the six
   `.cfg` files** — one could be altered between a run and its citation with no digest movement and
   no gate reaction. This is why the runs must be recorded as executed *as checked in*. **Do not
   propose digest-scoping `formal/` as a fix** — see `PHASE_15_MASTER.md` §10.

**Do not:** remove the `[NOT PROVEN]` annotation, change the gate algebra, or mark the gate proven.
The GREEN status is *not* a discharge and must not be read as one; **the `[NOT PROVEN]` annotation
is the authoritative statement of this row's truth and outranks the GREEN.**

**Closure condition:** the checked-in configurations completed exhaustively, recorded with the
provenance above, and accepted by the release owner; then the flag removed. **Note the gate's
status does not move on closure** — it is GREEN before and after — so the gate table cannot be used
to track B-M. This register and the handoff §7 are where its state lives.

---

## X3 — No `TASK` timer producer; §4.2 has no transition table

**Status:** OPEN
**Classification:** **SPECIFICATION / ADR**
**Owner:** The frozen-specification owner
**First discovered:** adversarial pass 1, 2026-08-22 · **Last verified:** 2026-08-29

**Current evidence:** `tools/verify/phase15CurrentTree.js` check **G1** — *"FINDING X3 — no §4.2 Task
state is written anywhere, so no TASK timer has a producer."* Passes as a finding assertion, i.e. it
confirms the gap is still present.

**Why it blocks:** the timer subsystem implements expiry for entities whose §4.x transition tables
exist. §4.2 (`TASK`) has none, so there is nothing to produce a `TASK` timer *from*.

**Can repository code solve it?** **No — and it must not.** Pass 2 recorded this explicitly as
*"NOT FIXED, and must not be"*: inventing a TASK transition table would be writing specification,
and `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` is **FROZEN**.

**Required external input:** a §4.2 transition table from the specification owner, or an ADR
declaring that `TASK` has no timed transitions.

**Do not:** invent a TASK state machine, a TASK timer producer, or a §4.2 transition table.

**Closure condition:** the specification decision is recorded, and the repository implements it.

---

## X4 — `lifecycle.tla`'s `CustodyMatchesState` is contradicted by `Strand` and `TimerFires`

**Status:** OPEN
**Classification:** **SPECIFICATION / FORMAL MODEL / SAFETY ENGINEERING**
**Owner:** **Safety engineer** (the custody-during-stranding safety judgement — §7.6 assigns
property-coverage and model-semantics judgement here) · **Frozen-specification owner** (any change
to §2.5 / §4.3 / §18.6 or to the model's transition relation, as for **X3**) · **Release owner**
(final acceptance, §7.6). **Engineering: mechanical support only — it may not decide this.**
**First discovered:** **2026-08-31**, by the first-ever TLC execution of `lifecycle.tla`
**Last verified:** 2026-08-31

> ### This is SEPARATE from B-M and must not be folded into it.
> B-M is an **evidence/compute** item: whether the six configurations were run and recorded. X4 is
> a **specification-level safety finding** about what the model says. **Resolving X4 does not close
> B-M, and closing B-M would not resolve X4.** They have different owners and different closure
> conditions.

**Current evidence:** all three lifecycle configurations report
`Error: Invariant Safety is violated.` at **depth 9**, with an identical trace on Leg `l1`
(296 / 1 051 / 3 812 distinct states at capacity 1 / 2 / 3). Raw output and the full nine-state
counterexample: [`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md) §10 and §12.7–§12.9.

**The trace:**

```
Plan → Offer → Accept → Depart → ArrivePickup → Load → CancelWithCustody → TimerFires
```

producing `ABORTING → STRANDED_OBSTRUCTING` **while `custody[l1]` remains `"HELD"`**.

**Affected invariant** — `CustodyMatchesState` (`lifecycle.tla:392-394`), a conjunct of `Safety`:

```tla
custody[l] = "HELD" => legState[l] \in (CustodyBearingStates \cup { "ABORTING" })
```

`CustodyBearingStates == { "LOADED", "EN_ROUTE_DROP", "AT_DROP" }` — **neither stranded state is in
the permitted set.**

**Affected transitions — there are TWO independent routes into the violation, not one:**

| Definition | Lines | What it does |
|---|---|---|
| **`TimerFires`** (`recover.abort_budget` disjunct) | `:340-342` | `ABORTING → STRANDED_OBSTRUCTING` with `UNCHANGED custody`. **The route the trace takes** |
| **`Strand(l, class)`** | `:291-295` | `ABORTING → STRANDED_SAFE`/`STRANDED_OBSTRUCTING` with `UNCHANGED custody`. **A second, independent route** |
| **`Recovered(l)`** | `:301-306` | Guarded on the Leg being **stranded**, and its custody update is `IF custody[l] = "HELD" THEN "RELEASED"` — **it is written to resolve exactly the state the invariant forbids.** Under `CustodyMatchesState` that branch is dead code |

**The contradiction in one sentence:** `Strand` and `TimerFires` construct stranded-with-custody
states, `Recovered` exists to resolve them, and `CustodyMatchesState` declares they cannot exist.
*(By contrast `AbortResolved` (`:284-289`) has the same shape but fires from `ABORTING`, which the
invariant permits — that one is consistent. The disagreement is specifically about the stranded
states.)*

**Why it blocks:** `model_check_capacity_1_2_3`'s statement is that **every §24.2 safety property**
is model-checked. A model whose own safety invariant is violated by its own transitions cannot
produce that evidence at any capacity, on any compute. **The lifecycle half of the gate cannot pass
while X4 stands**, independently of B-M's compute problem.

**Can repository code solve it?** **No — and it must not.** **No repository implementation change
can legitimately close X4 without the required safety/specification decision.** Editing
`lifecycle.tla` to make TLC go green would be writing specification under the guise of fixing a
model, and would destroy the evidence that the disagreement exists — the same reasoning that keeps
**X3** open.

> **Recorded and deliberately NOT decided: physically retaining `HELD` custody while stranded may be
> semantically plausible.** A robot broken down mid-delivery is still holding the parcel, and
> §18.6's own comment that recovery *"is impossible without physical intervention"* points that way,
> as does `Recovered` existing at all. **This register does not decide it.** The candidate readings
> — the invariant is too narrow; the two transitions are wrong; the state classification is wrong —
> are **different safety claims about what the system owes for goods it is physically holding**, and
> **none may be chosen because its repair is smaller.**

**`lifecycle.tla` being checked in does NOT make this a Phase 15 implementation defect.** The module
is a transcription of the *specification* into a modelling language (`formal/README.md:106-109`), so
the contradiction is either (a) faithful, and the specification is internally inconsistent, or
(b) unfaithful, and the specification must say which of the four definitions is wrong. **Both are
specification-level.** No claim is made here about `Backend/src/engine/lifecycle/` — whether the
shipped implementation shares the disagreement is **UNKNOWN and was not investigated**, because
doing so would mean touching frozen implementation. **X4's owner should ask that question.**

**Do not:** edit `lifecycle.tla` or any `.cfg` to make the violation disappear; treat X4 as an
implementation bug; merge X4 into B-M or into X5; or close it on Engineering's judgement.

**Closure condition:** the safety/specification authority records which of the four definitions is
wrong and why, **and** the release owner accepts it (§7.6); only then may the model be changed to
match.

---

## X5 — the checked-in `lifecycle_c*.cfg` abort on the deadlock check before any property is evaluated

**Status:** OPEN
**Classification:** **FORMAL-VERIFICATION CONFIGURATION / DOCUMENTATION GAP**
**Owner:** **Release owner** (which option is taken, §7.6) with the **safety engineer** (whether
deadlock freedom is a §24.2 obligation of this model) and, for one of the four options, the
**frozen-specification owner**. **Engineering: mechanical support only.**
**First discovered:** **2026-08-31**, by the first-ever TLC execution of `lifecycle.tla`
**Last verified:** 2026-08-31

> ### This is SEPARATE from X4 and from B-M.
> **X5 is a configuration/documentation gap; X4 is a safety finding about the model's content.**
> They were found in the same session and are otherwise unrelated: fixing X5 does not fix X4 —
> it **reveals** it — and fixing X4 does not fix X5.

**Current evidence:** `lifecycle_c1/c2/c3.cfg`, run exactly as `formal/README.md:21-24` instructs,
each abort with `Error: Deadlock reached.` at **depth 6**, having explored **79 / 277 / 1 012**
distinct states. Raw output: [`PHASE_15_BM_TLC_RUN_RECORD.md`](PHASE_15_BM_TLC_RUN_RECORD.md) §9
and §12.4–§12.6.

**What happens:** every Leg is `Cancel`led in turn until all are `CANCELLED`; every action in `Next`
requires some `legState[l] \notin TerminalLegStates`, so no successor exists. **TLC's default
deadlock check fires.** No `.cfg` sets `CHECK_DEADLOCK FALSE` and the model has no stuttering action.

**Why it blocks:** the three configurations **declare** `INVARIANT Safety` and
`PROPERTY TerminalIsFinal, Liveness` and **none of them reaches a verdict on any of those** — the
run is over at depth 6. **The checked-in lifecycle configurations, run as documented, cannot produce
evidence for the gate they exist to serve.** In particular **no lifecycle liveness property has ever
been evaluated by TLC at any capacity**, and the absence of a temporal-property error in the logs is
the absence of a search, not the absence of a counterexample.

**This is not obviously a model defect.** `Safety`'s own `TerminalIsFinal` conjunct asserts that
terminal Legs never change state (`:377-379`), so "every Leg terminal" is an **intended end of a
behaviour**. TLC's default check cannot distinguish that from a stuck system. **Which it is, is the
owner's call.**

**Required decision — four options, not equivalent, and at least one is a specification statement:**

| Option | What it asserts | Who may decide |
|---|---|---|
| `CHECK_DEADLOCK FALSE` in the three `.cfg` | Deadlock freedom is not a §24.2 property of this model | Safety engineer + release owner |
| An explicit stuttering/termination action in `lifecycle.tla` | A change to the transition relation | Frozen-specification owner |
| Treat deadlock freedom as a genuine §24.2 obligation | The current model is defective | Frozen-specification owner + safety engineer |
| Accept that the lifecycle configurations produce no evidence | The gate's lifecycle half stays permanently unevidenced | Release owner |

**Can repository code solve it?** **Not unilaterally.** Every option is a statement about what
§24.2 requires of this model. **Engineering must not pick one**, and picking the first because it is
the smallest edit is exactly the failure this register exists to prevent.

> ### The secondary `-deadlock` diagnostic runs are NOT a discharge and must not be promoted to one.
> Each lifecycle configuration was re-run once with TLC's `-deadlock` flag **on the command line;
> no file was modified**. Those runs are **diagnostic evidence only** — they are how **X4** was
> found. §24.2's own argument, quoted in all six `.cfg` headers, is that *"the configuration under
> check is itself part of the requirement"*, so **a run under a flag the configuration does not
> specify is evidence about a different run.** They are retained, clearly labelled, at
> `PHASE_15_BM_TLC_RUN_RECORD.md` §12.7–§12.9. **Do not cite them as a result for
> `lifecycle_c{1,2,3}.cfg`.**

**Do not:** edit any `.cfg`; edit `formal/README.md`; change `CHECK_DEADLOCK`; add a stuttering
action; or silently convert the `-deadlock` diagnostic into authoritative proof.

**Closure condition:** the owner records which of the four options is taken and why; only then is
the corresponding change made.

---

## X1 / T1-04 — The §17.4 escalation ladder and the three fairness modules

**Status:** **CLOSED — implemented, composed, and verified against a live database** (2026-08-30)
**Classification:** was SPECIFICATION / ADR · **now discharged by REPOSITORY work**
**Owner:** **REMEDIAL PHASE T1-04** (`IMPLEMENTATION_EXECUTION_PLAN.md` §3, §6.3)
**First discovered:** recorded as ARCHITECTURE.md gap 16 / OAD-7 · **Closed:** 2026-08-30

**What it was:** `src/engine/fairness/` existed and was empty. §1.8 places the anti-starvation
*guarantee* in this ladder, and Phase 8's aging-multiplier cap was justified *because* the
guarantee lives here — so the engine had neither the unbounded price it had deliberately given up
nor the ladder it gave it up for.

**What now exists (all three, Tier 1, invariant I13):**

| Module | What it implements |
|---|---|
| `src/engine/fairness/ladder.js` | §17.4's eight rungs, triggered on elapsed queue age over `sla.assignment_deadline`; four named verdicts; every crossed rung recorded with what was relaxed and why |
| `src/engine/fairness/operatorCapacity.js` | §17.4's human capacity model — `ops.escalation_capacity`, the triage order, holding, and sustained-saturation alerting |
| `src/engine/fairness/agentStarvation.js` | §17.5's detection: zero completed missions in `fairness.idle_alert_period` while nominally available |

**Where it runs — the composition, which is the part that makes it more than a module:**

- `workers/leaderWorkers.js:timer()` builds the ladder and passes it to
  `expiryActions.handlers({ ladder })`. The timer worker fires `ESCALATION_LADDER`, which §4.3
  declares as the expiry action of `QUEUED`. That is the runtime caller, and there is no other.
- `services/task.service.js:admitToRound()` now arms the `QUEUED` deadline in the transaction that
  creates the Leg. **This was the load-bearing find of the session:** the production request path
  armed *no* `QUEUED` timer at all, so `checkI4` reported every admitted Leg as `NO_PENDING_TIMER`
  and the ladder had no trigger for customer work. Composing the ladder without this would have
  produced a mechanism that was present, tested, and unreachable.
- `server.js` starts `workers/fairness.worker.js` for §17.5, whose signal is an *absence* over a
  window and therefore has no deadline behind it.
- `observability/metrics.js` derives `outstanding_escalations`, `escalation_saturation_time` and
  `ladder_step_distribution` from `LadderEscalation` — the three §21.4 SLIs whose producer note
  used to read "`src/engine/fairness/` still holds no ladder".

**Verification:** 93 tests in `tests/engine/fairnessLadder.test.js`; the full five-lane suite green
at **161 suites / 7 261 tests**; and **72/72 checks against live PostgreSQL 18.3** via
`npm run verify:t104` — every one of the migration's ten CHECK constraints rejecting its own
planted violation, and the shipped module driven end to end through real Prisma transactions.
(65/65 at T1-04's own closure; the seven added on 2026-08-30 are the `Leg.slaDeadline` producer
below, driven through the real `admitToRound` path.)

**Not everything §17.4 and §17.5 name is implemented.** Four genuinely remain, each with a stated
reason rather than an omission:

| Remaining | Why |
|---|---|
| §17.5 **exercise missions** | A short reposition mission needs §17.3's repositioning — **Tier 2**, which §1.8 rule 2 forbids this Tier 1 mechanism from depending on — and no EXERCISE Leg producer exists. `agentStarvation.exerciseCandidates` produces the list; every entry carries the blocker |
| §17.4 **rate limiting** into the human queue | No register entry parameterises a rate. Admission is gated on concurrent capacity, which §17.4 *does* parameterise. A gap in smoothing, not in the guarantee |
| §17.4 **saturation → §20.5 admission control** | The directive is emitted; nothing consumes it. Owned by §20.5, not by T1-04. **Re-derived 2026-08-30 — this is not one missing producer but four distinct undecided questions; see below** |
| §17.4 rung 8 **alternative modality** | No register entry names a modality set, so "where configured" reads as not configured and the decline branch runs. The collaborator seam exists and is unused |

#### `Leg.slaDeadline` — **CLOSED 2026-08-30**

T1-04 left §17.4's triage comparator with a third key it could not use. `compareForTriage` orders
escalations by "custody state first, then obstruction class, **then SLA breach proximity**, then
queue age", and breach proximity is read from `Leg.slaDeadline` — a nullable column whose only
writer on the tree was `domain/mappers/legacyTask.taskToWork()`, which sets it to `null`. Every Leg
therefore reached a dispatcher as "proximity unknown", and the key collapsed to arrival order.

**The producer.** `task.service.superviseQueuedEntry` now writes the column in the transaction that
creates the Leg, as `storeTime + sla.assignment_deadline`. Nothing was invented: §4.3 gives Leg
state `QUEUED` the exit deadline `sla.assignment_deadline` (registered, default 900 s), §4.5
requires that deadline to be registered in the transaction entering the state, and the column holds
that deadline's absolute instant. The producer sits beside the §4.5 timer and takes the **same**
resolved budget and the **same** store-clock read, so the instant §17.4 sorts on and the instant
§4.5 fires on are one number rather than two that can drift.

Three properties are load-bearing and each is tested:
- **The whole budget, not the rung.** The timer is armed at rung 1's boundary (225 s of 900 s)
  because the ladder re-arms at each rung. A deadline derived from that would declare every Leg in
  breach 675 s early — urgent-looking and wrong.
- **Written once, never moved.** It sits below the "already supervised" guard, so a retried
  submission converging on the same Leg does not recompute it against a later clock. Requeue paths
  (§11.2, `cutover/legEntryDeadline.superviseEntry`) are deliberately untouched: restarting the
  assignment budget on every offer rejection would reset the anti-starvation clock a Leg could then
  cycle indefinitely against.
- **Null over a guess.** An unresolvable `sla.assignment_deadline` leaves the column `null` (§22.1),
  which the comparator already reads as "proximity unknown, sort last".

**Verification:** 7 focused tests in `tests/engine/intakeStranglerSeam.test.js`; the engine lane
green at **130 suites / 6 927 tests**; and **7 live-PostgreSQL checks** in `npm run verify:t104`
driving the real `admitToRound` (72/72 overall). Both mutants were built and both were caught —
`budgetSeconds → armedSeconds` fails 3 tests, removing the write fails 5.

**This closes the column's gap and nothing wider.** `Leg.slaDeadline` is populated by the legacy
`Task` → Leg admission path, which is the only Leg-creation path in production. Legs created by any
future non-legacy intake would need the same producer, and Legs admitted *before* this change keep
`null` — no backfill was run, because rewriting the deadline of an in-flight Leg would change the
supervision it is already under.

#### §20.5 admission control — why the seam cannot be closed by writing a producer (2026-08-30)

A pass scoped to §20.5 traced the seam and found the earlier "no production producer" framing
**understated the blocker**. `intake/admission.js` is complete and correct; `intake.admit()` already
calls `admission.assess()`. What is absent is not wiring but **decided semantics for the inputs**.
Measured on the production input shape — `admissionInputs` is `{}` because neither
`tasks.controller.js` nor `socket.server.js` ever sets it — `assess()` returns **ADMIT for all 30
purpose × SLA-class combinations**, with every observed control value `null` except `shedLevel`,
pinned at `0` (`NOMINAL`). §20.5 is presently incapable of declining anything in production.

Each of the four controls is blocked on a **different** missing decision:

| Control | Missing decision |
|---|---|
| Per-tenant rate / concurrency quotas | **§27 open decision #13** — "Multi-tenancy model … drives F4, `C_policy`, and **quota design**", *Depends on: Commercial model*. No quota parameter is registered, and `tenantId` has no production source (null on every request). **External/commercial, not repository-owned** |
| Global admission (projected queue delay > class budget) | The rule and the budget are settled — `sla.assignment_deadline` (default 900 s, scoped `sla_class`/`tenant`) is resolvable via `snapshot.resolve()`, and `predictAssignmentWindow`'s `atRisk` field is already arithmetically the §20.5 test. The **input** is not producible: §3.4 defines the projection as "derived from current queue depth **and supply**", `solve/cadence.js` keys its regime on feasible supply, and the specification never defines what quantity *intake* measures as supply — while §3.4 forbids consulting the routing provider on the request path and §7 makes feasibility a round-path evaluation. `feasibleSupply` has **no producer anywhere on the tree**, including in `coordinator.worker.js`, which takes it as an input defaulting to `0`. The Availability Index cannot supply it: it is cache-tier and advisory, and §3.3 / §18.5 rule 3 forbid promoting it to an authority for a customer-visible decline. `cadence.windowFor`'s config shape has no register→config producer either |
| Class-based shedding (`shedLevel`) | The published **order** is implemented (`SHED_LADDER`). The **level** is not derivable: §18.5 makes Shed Load a *binary* named mode, B19's entry condition ("arrival rate > capacity") has **no registered threshold parameter**, and no published mapping exists from overload severity to rungs 1/2/3. Nothing under `src/` ever calls `transitions.enter()` for `SHED_LOAD` |
| §17.4 saturation → admission | The **trigger** is fully specified and already computed deterministically by T1-04 (`ops.escalation_capacity`, `ops.escalation_saturation_period`). The **consequence** is not: "declining new work of *the affected classes*" — the phrase occurs **exactly once in the 5 941-line specification and is never defined**. Closing it requires choosing (a) which classes are "affected", and (b) whether the consequence is a §20.5 *shed* verdict (purpose-then-class, custodial-exempt) or a *global-admission decline* (queue-delay-keyed) — different verdicts, different operator meanings, different custodial paths |

**No code was written for §20.5.** Each producer would have required inventing a threshold, a
supply definition, or a class set that the frozen specification does not publish — and a producer
that manufactures its own input is the failure mode this blocker register exists to record, not a
closure of it. The two decisions that would unblock the repository-owned half are: **what quantity
intake measures as "supply"**, and **what "the affected classes" denotes in §17.4**.

**`src/engine/lifecycle/preemption.js` is still absent, and that is correct** — §4.8 preemption is
**Tier 2 / Phase 16**. It was listed as evidence under this blocker; it is not T1-04's. Rung 4
emits a `PERMIT_PREEMPTION_OF_LOWER_CLASS` directive and calls nothing, which is what §1.8 rule 2
requires and what `gate:tiers` enforces.

**Closure condition (met):** the three modules exist, are reachable from the production path, and
are verified against a live database. **E1/E2 are now dischargeable as far as T1-04 is concerned**
— they remain blocked by B1, which is external.

---

## A9 — `assertVersionInKey` is implemented, tested, and called by nothing

**Status:** OPEN — **correctly deferred**
**Classification:** **REPOSITORY-OWNED**, deferred to **Phase 8**
**Owner:** Phase 8
**First discovered:** B1 prerequisite pass, 2026-08-28 · **Last verified:** 2026-08-29

**Current evidence:** defined at `src/engine/routing/chargerReachabilityCache.js:124`, exported at
`:375`. The only callers on the whole tree are `tests/engine/energySchema.test.js:268–269` (both
directions asserted) and one explanatory comment in `tools/routing/adapters/contract.js:340`. No
production caller exists.

**Why it does not block now:** its discharge point is `src/engine/routing/client.js` — a Phase 8
module that **does not exist** and cannot exist before B1. Meanwhile `read()` already carries a
genuine independent cross-check that a self-built key could not provide, so nothing is currently
unguarded.

**Can repository code solve it?** Only by manufacturing a caller, which would be a fake seam.

**Do not:** manufacture a caller. A guard called from a synthetic site is not a guard.

**Closure condition:** `src/engine/routing/client.js` is built (post-B1, Phase 8) and calls it.

---

## V-10 — the rollback runbook traced against the current API (CLOSED 2026-08-30)

**Status:** **CLOSED** — executed, five defects fixed, verified against a live database
**Classification:** REPOSITORY-OWNED · **was the only Phase-15-owned closure-checklist row that
was actionable in this repository and had never been executed**
**Owner:** Phase 15 · **Executed:** 2026-08-30 at digest `d033038c…` (573 files)

**What V-10 was.** `PHASE_15_CLOSURE_CHECKLIST.md` §C row **V-10** —
*"`docs/runbooks/rollback.md` procedure executed against the current API"* — stood at
`NOT EVALUATED`, blocking **No**, with the note *"No pass has ever done it"* and the status
**UNKNOWN, not clean**. It was the next genuine item: `rollback.md` §5 is the procedure the
`rollback_rehearsed` gate (**B-O**) is evidence for, and `rollbackPublisher`'s
`SUPERSEDES_AN_UNPINNED_VERSION` refusal routes an operator into §2 by name. A runbook that has
drifted is discovered during the incident it exists for.

**Five defects. The first is permissive and fleet-wide.**

| # | Defect | Severity |
|---|---|---|
| **V10-1** | **§2 step 1 published a single binding.** It read, in full: *"Publish `authorisation.action.binding` (`cutover.engine_enabled = false`, region scope)."* A configuration version is a **complete set** — `config/service.publish()` writes exactly `snapshot.declaredBindings` and inherits nothing, and `config.controller.publishVersion` defaults `bindings` to `[]`. The manual Rollback A therefore reverted **every other parameter in the deployment** to its register default, as a side effect of disabling one shard. `rollbackPublisher.bindingsWithRegionDisabled` exists precisely to prevent this on the automatic path; the runbook never carried it across. Fixed by new **§2.1**, which gives the recipe, names `POST /api/config/publish`, and states the pin | **Permissive, fleet-wide** |
| **V10-2** | **§2 promised a coordinator stand-down that no code performs.** *"The coordinator stands down for that shard at the next tick."* The per-shard switch has four production consumers and `coordinator.worker.js` is not one of them. Corrected in the runbook; **the missing gate is routed to B1's composition-root work** (item 5 above) and deliberately not written, because the worker it belongs in cannot be composed | **Permissive claim; latent behaviour** |
| **V10-3** | **§4 argued Rollback B was safe from a mirror that has no writer.** *"It reads `Robot.currentTaskId`, which the engine maintains as a mirror, so an agent executing an engine commitment appears busy and is not re-assigned."* **No code in the build assigns `Robot.currentTaskId` a task id.** Its only writers clear it (`tasks.controller.js:263`, `dtaro.handler.js:183`); it was the *legacy* path's own record (`tools/migrate/backfillDomain.js:32-34`) and that path was deleted at Phase 15. So after Rollback B every agent holding an engine commitment reads IDLE to the legacy dispatcher and can be re-assigned — **a double assignment, arriving during the incident that prompted the rollback**. Corrected, and the hazard and the `Commitment`-table remedy stated. **The column is retained by design** and `commitmentSchema.test.js` still fails if a drop arrives early — *retained is not maintained* | **Permissive claim; real hazard** |
| **V10-4** | **§5 never named the six rehearsal step keys.** The record table said *"each of the six steps above, named individually"*. `evidence.REHEARSAL_STEPS` requires `cutover`, `automatic_rollback`, `no_decision_path_confirmed`, `artefact_rollback`, `recutover`, `recorded`. A record filed from the runbook alone is refused `REHEARSAL_INCOMPLETE` — **on a gate no build can close**. The keys, and the `approval.recordedBy`/`approvedBy` and `pass` fields, are now named | **Obstructive — blocks B-O** |
| **V10-5** | **`rollbackPublisher.js` cited `rollback.md` §4** for the carry-forward sentence, which is in **§3**; §4 is Rollback B and says nothing of the kind. Corrected in the code comment | Low |

**Also corrected in `cutover.md`, because it is the same sentence:** §3.3's *"Publish
`authorisation.action.binding` through the Config Service"* carries V10-1 in the enable
direction, and it named **`POST /api/config/versions`** as the publish endpoint. That endpoint
does not exist — `/versions` is `GET`, the read-only version list, and it returns no payloads.
The publish route is **`POST /api/config/publish`**.

**One claim in this register's own draft was corrected by the live run.** The one-binding
publish does **not** simply succeed: **V9** refuses it, because dropping the set takes
`route.degraded_reserve_factor` to a default over the combined-conservatism cap. That is a
guard by coincidence, not by design — it names an energy cap rather than the four vanished
bindings, and check **B2** of the harness shows that resolving it the obvious way (bind the one
parameter the message names) publishes and pins successfully, reverting everything else. The
severity is unchanged; the description is now true. This is recorded because a register that
edits its own drafts silently is a register nobody can audit.

**Verification:** 7 tests in `tests/engine/phase15RollbackRunbook.test.js`; **3 mutants built,
3 killed**; the engine lane green at 131 suites / 6 934 tests and the full suite at 162 / 7 275;
and **15/15 against live PostgreSQL 18.3** via `npm run verify:v10`, including a BEFORE variant
that reproduces the fleet-wide revert and a `C6` check that the manual recipe and the automatic
publisher produce the same binding set field for field.

**What V-10 did NOT do:** it did not add a prose-parsing gate, digest-scope `docs/`, weaken any
gate, or write the coordinator's cutover check. **P15-F7a — the structural gap that nothing
binds a runbook to its API — is still open**, and is residual observation 1.

**Closure condition (met):** the procedure traced end to end against the current API, the drifts
corrected, and the corrected procedure executed against a real database.

---

## V-9 — the Phase 0–14 cross-phase re-verification (CLOSED 2026-08-30)

**Status:** **CLOSED — executed, no regression found, no code changed**
**Classification:** REPOSITORY-OWNED · **was the last Phase-15-owned closure-checklist row that
was actionable in this repository and had never been executed** — the successor to V-10, and the
fourth pass running in which the next genuine item was **not in this blocker table**
**Owner:** Phase 15 · **Executed:** 2026-08-30 at digest `d033038c…` (573 files)

**What V-9 was.** `PHASE_15_CLOSURE_CHECKLIST.md` §C row **V-9** — *"Phase 0–14 cross-phase
re-verification"* — stood at `NOT EVALUATED`, blocking **No**, result **UNKNOWN**, with its
trigger (*"run if the tree changes materially"*) **already fired**: T1-04 and the `Leg.slaDeadline`
producer changed `expiryActions.js` (+153), `leaderWorkers.js` (+68), `task.service.js` (+187),
`metrics.js` (+123), `schema.prisma` (+103) and added migration 28 — and
`tools/verify/phase5ExpirySemantics.js` requires the first two directly.

**Scope was derived, not judged.** The transitive `require()` closure of all **22** Phase 0–14
harnesses was intersected with the **11** changed application-source files. **4 carry a changed
module** (`phase5ExpirySemantics` 5, `phase9ProductionPath` 5, `phase14LiveDatabase` 3,
`phase11LiveDatabase` 1); **18 carry none**. The schema diff was read and is **purely additive** —
one new table, one back-relation, **no pre-existing column altered** — so no Phase 0–14 subject
table moved. **7 harnesses were run; 14 were skipped with that measurement as the reason.**

**Result: 315 / 317 checks on disposable PostgreSQL 18.3.** `phase5LiveDatabase` 106/106 ·
`phase13LiveDatabase` 73/73 · `phase11LiveDatabase` 31/31 · `phase9ProductionPath` 7/7 ·
`phase12Profile` completed clean · `phase5ExpirySemantics` **100/102**.

**The 2 failures are not defects, and this was proven rather than argued.** Both are
`phase5ExpirySemantics` **FINDING assertions** — checks that pass by confirming a gap is still
open — and the gap they assert is *"§17.4's escalation ladder has no implementation"*, which
**X1/T1-04 closed on this same tree**. The subtler of the two returned
`LADDER_UNDETERMINED:LADDER_NOT_PUBLISHED`, which could have meant the shipped ladder was inert.
It does not: the harness's hand-built `VALUES` map carries **0** of the 8 `ladder.step_*_fraction`
entries T1-04 registered, and feeding the shipped `stepTableFrom` that same map **plus the
register's own fractions** flips it from `ok=false` to `ok=true` with 8 strictly increasing
rungs. `verify:t104` corroborated end to end at **72/72** on the same cluster. **The
`LADDER_EXHAUSTED → FAILED` row was not taken and the deadline was re-armed** — the property those
checks exist to protect held.

**What V-9 did NOT do:** it did not edit the two stale assertions to make the run green (that
would have destroyed the record of what they asserted), did not fabricate the `Mission` row that
would have let `phase12LiveDatabase` run, did not touch a gate, threshold, test or configuration,
and did not re-collect release evidence. **`git status` is empty and the digest is unmoved at
`d033038c…` / 573** — so **no mutation testing was owed**, V-6 being a per-*implementation*-pass
requirement.

**Two items are handed on, neither of them Phase 15's:**
1. **Phase 5 owns its own harness's staleness** — `phase5ExpirySemantics.js:334` and `:1101`
   assert a pre-T1-04 world. What to change is written out in
   `PHASE_15_VERIFICATION_STATE.md` §7c.4. Not done here.
2. **A pre-existing seed defect**, found incidentally and registered as **residual observation 8**
   below. It is repository-owned and actionable and it is **not a Phase 15 item**.

**Closure condition (met):** the harnesses whose subjects moved were identified by measurement,
executed against a disposable live database, and every failure classified as regression or
expected semantic change on evidence. **V-9 — CLOSED / VERIFIED.**

---

## Residual in-repository observations — reported, not fixed, none permissive

These are **not blockers**. They are carried forward so a future pass inherits named gaps instead of
rediscovering them. Each was re-confirmed present on 2026-08-29.

| # | Observation | Evidence | Why it is not a blocker |
|---|---|---|---|
| 1 | **P15-F7a — nothing binds a runbook to the API it documents.** `docs/` is outside the source-digest scope by design, so no gate detects a runbook drifting from a signature it calls. `docs/runbooks/cutover.md` §3.2 drifted through two contract changes with every build gate green — and **on 2026-08-30 V-10 found five more drifts, in the other runbook** | `tools/release/sourceDigest.js` scope; the P15-F7 defect; the V-10 findings below | Structural gap. Still **not** fixed by digest-scoping `docs/` (which would void a ~25-min evidence collection on every prose edit) or by a prose-parsing gate (an unmaintained future false green). **Two partial compensating controls now exist and are the most that should be built:** `rollback.md` §7 records the date of the last hand-trace, and `tests/engine/phase15RollbackRunbook.test.js` pins the two *constants* the runbook enumerates — not its prose |
| 2 | ~~**`docs/runbooks/rollback.md` has never had its procedure executed against the current API.**~~ **EXECUTED 2026-08-30 — closure item V-10.** Five defects found and fixed; see § *V-10* below | `npm run verify:v10` — 15/15 on live PostgreSQL 18.3; 7 tests in `tests/engine/phase15RollbackRunbook.test.js`; 3 mutants, 3 killed | **No longer UNKNOWN.** The surface is examined and the defects are closed. The *structural* exposure is observation 1 and remains open |
| 3 | **`app.locals.releaseEvidence` has no producer** (P15-E6). The cutover health endpoint always evaluates against `{}` | `grep`: no assignment; read with `\|\| {}` at `health.controller.js:319` | **Fails closed** — every gate reads as not-green |
| 4 | **`gates.blockers()` ignores `unknownEvidence`.** Evidence filed against an unknown gate id never appears as a blocker | `src/engine/cutover/gates.js` — `blockers()` filters `results` only | `evaluate()` does fold it into `ok`, and `verdict.js` prints it |
| 5 | **The evidence schema cannot distinguish a gate that failed from a gate that never ran** | Discovered when a gate process failed to start (`0xC0000142 STATUS_DLL_INIT_FAILED`) and the collection was discarded rather than reported | Detected in practice; the affected collection was voided, not published |
| 6 | **The register accessor is injected**, and pass 2's **X-C1** / **X-C2** | Archived third-pass report §33.3, probe 12d | Carried forward, none permissive |
| 8 | **`prisma/seed.js` fails silently and exits 0 — a partial seed reported as success.** It aborts inside `seedRegister` with `Invalid value for argument "changeClass". Expected ConfigChangeClass`: **3 register entries carry `changeClass: "OPERATIONAL"`** (`feasibility.negative_cache_ttl`, `link.min_quality`, `reliability.max_intervention_rate`) and the enum has **7 members, none of them `OPERATIONAL`**. `main().catch(console.error)` swallows it, so the process **exits 0** having written **165 of 250** register entries and **0 Mission / 0 Shard / 0 Region / 0 Agent**. **Found by V-9 on 2026-08-30**, as the reason `phase12LiveDatabase.js` could not run from an empty cluster | Measured on the disposable cluster: `SELECT count(*)` → `ParameterRegisterEntry` 165, `Mission` 0, `Shard` 0, `Region` 0. **Proven pre-existing by construction:** the enum, the 3 entries and `seed.js` are **byte-identical at `67b7c7c`**, the T1-04 diff touches none of them, and `git log -S'"OPERATIONAL"'` dates it to **`cbe540e`, 2026-08-09** | **Not permissive, and NOT Phase 15's** — it predates the tree movement V-9 assesses by three weeks, moves **no §24 gate**, and affects only a development/verification fixture path. It **is** repository-owned and actionable, and is recorded here rather than fixed because the choice between *"add `OPERATIONAL` to `ConfigChangeClass`"* and *"reclassify the 3 entries"* is a **§22.1 register governance decision**, not a mechanical one. `gate:params` does not catch it because it reads the register JSON, never the database. **Do not fabricate the missing `Mission` row to make `phase12LiveDatabase` green** |
| 7 | **CI does not run `gate:composition`** — CI is green on a tree where a blocking §24 gate is RED | `.github/workflows/ci.yml` — 7 gate steps, no `gate:composition`; the workflow header enumerates exactly **two** deliberate absences (`gate:calibration`, `safety:case`) and this is not one of them, so **no reason is recorded**. `npm run gates` runs 8 and exits 1; CI runs 7 of those 8 and exits 0, and the omitted one is the only one that fails | The gate is authoritative via `npm run gates` and `release:verdict`; CI is not the §24 authority. **Recorded by the consolidation; extended by the 2026-08-29 audit**, which additionally found that `gate:columngen` is pull-request-only (a push runs 6 gate steps) and that `ARCHITECTURE.md` §9.1 and `ROBOTX_SYSTEM_HANDBOOK.md` §42 both described CI as running the complete gate set. Those two prose statements were corrected; **CI itself was not changed** — that is a code change and is out of scope for a documentation pass |

---

## Cross-phase documentation discrepancies — recorded, not owned by Phase 15

**These are not blockers and not Phase 15 findings.** They are places where documentation outside
`docs/phase15/` disagrees with the current repository. The audit of 2026-08-29 classified each by
**who owns the correction**, corrected only the Phase-15-owned ones, and left the rest in place
with the reasoning below. Nothing here was silently discarded.

**Standing rule.** Where any of these documents and the five canonical Phase 15 documents disagree
about Phase 15, the canonical documents win — `PHASE_15_MASTER.md` §1's authority order, rank 3
(the repository) then rank 5. `ARCHITECTURE.md` ranks itself below both, in its own words.

### Corrected on 2026-08-29 — Phase-15-owned and provably false

| # | Statement | Where | Truth | Why Phase 15 owned it |
|---|---|---|---|---|
| **C1** | "None of the 19 workers is on production scheduling" | `ARCHITECTURE.md` §4.2 · `ROBOTX_SYSTEM_HANDBOOK.md` §3.3 | **12 of 19 start** (re-measured 2026-08-30): 9 `SCHEDULED` at boot + 3 of 4 `LEADER_ONLY` on promotion. *(Read "11 of 18 · 8 SCHEDULED" when written on 2026-08-29; T1-04's `fairness.worker.js` is the 19th and it is `SCHEDULED`. **The falsehood being corrected is unchanged — "none" is still wrong.**)* | "All engine workers move to production scheduling" **is** Phase 15's execution-plan row |
| **C2** | "No production composition root exists" (archived finding **N12**) | `ROBOTX_SYSTEM_HANDBOOK.md` §3.3 · §51.2 · §2 summary | **`Backend/server.js` is the composition root.** What is absent is a constructible *solve path* — a different claim, and the one that is still true | Phase 15 built the composition root |
| **C3** | "19 workers" | `ARCHITECTURE.md` §1.4, §4.2 · `ROBOTX_SYSTEM_HANDBOOK.md` §0.1, §3.3, §51.2 | **⚠ THIS ROW HAS INVERTED — DO NOT ACT ON ITS ORIGINAL TEXT.** On 2026-08-29 the registry held **18** and this row read *"18 registered … `src/workers/` holds 20 `.js` files … '19' is wrong under every reading"*. **Since T1-04 the registry registers exactly 19** (re-measured 2026-08-30), so the figure this register was created to correct is now the *correct* registry count, reached by coincidence rather than by anyone updating it. The file count did **not** converge: `src/workers/` now holds **21** `.js` files (19 `*.worker.js` + `registry.js` + `leaderWorkers.js`), so "19" is still wrong **as a file count** and right **as a registry count**. **A future pass must not "correct" 19 → 18.** The genuine remaining defect in those documents is that they say *none* of the workers is scheduled (row C1), not the number | Phase 15 wrote the registry and `leaderWorkers.js` |
| **C4** | "`gates.blockers({})` returns all **23** rows" / "23 release gates" | `ARCHITECTURE.md` §1.5 · `ROBOTX_SYSTEM_HANDBOOK.md` §60.4, §87 | **24 rows**, all blocking; `blockers({})` returns 24 | The §24 gate table is Phase 15's deliverable |
| **C5** | "16 GREEN, 2 RED, 1 **PARTIAL**, 4 NOT_EVALUATED" | `ROBOTX_SYSTEM_HANDBOOK.md` §60.4 | **16 GREEN, 1 RED, 7 NOT_EVALUATED.** Doubly wrong: the counts moved, **and there is no `PARTIAL` status in the gate algebra** — `gates.js` defines GREEN, RED and NOT_EVALUATED only | It misstates the release verdict, which is the closure surface |
| **C6** | "the seven build gates" | `ARCHITECTURE.md` §2 rank 6 · `ROBOTX_SYSTEM_HANDBOOK.md` §0.2 item 6 · `README.md` verification block | **`npm run gates` runs 8** and **exits 1**. Phase 15 added the eighth, `gate:composition`, and it is the one that fails | Phase 15 added the gate; a "seven gates, all passing" reading hides the RED one |
| **C7** | `gate:legacy` quoted as *"…across 301 file(s)"* | `ARCHITECTURE.md` §1.3 | **346 files**, re-measured 2026-08-30 *(340 on 2026-08-29; the corpus grew with T1-04's and V-10's files)*. **The load-bearing number is *4 absent*, not the corpus size** — which is exactly why this row moves every time the tree does, and why quoting the corpus size at all is the weaker practice | `gate:legacy` is Phase 15's gate |
| **C8** | Authority table lists ADR-33 but **not ADR-34** | `ARCHITECTURE.md` §2 rank 2 · `README.md` doc table (said "38 records") | **40 ADR files** = 38 frozen Appendix C records + ADR-33 + **ADR-34**. `docs/adr/README.md`'s "38 records are the complete set" is correct *for the frozen set* and is not a defect | **ADR-34 is Phase 15's own ADR** (cutover rehearsal purpose, resolving D-7) |
| **C9** | CI described as running the complete build-gate set | `ARCHITECTURE.md` §9.1 · `ROBOTX_SYSTEM_HANDBOOK.md` §42 | CI runs **7 of 8** gate steps (6 on a push — `gate:columngen` is pull-request-only) and omits `gate:composition` **without stating a reason** | See residual observation 7 |

### Recorded and deliberately NOT corrected — cross-phase drift

**Reason, stated once and applying to every row below: these are general project counts, not Phase
15 facts, and re-counting the whole handbook is a handbook re-audit rather than a Phase 15
documentation audit.** Correcting them here would also mean Phase 15 silently asserting numbers for
phases it did not measure. A **currency banner** was added at the head of
`ROBOTX_SYSTEM_HANDBOOK.md` instead, and `ARCHITECTURE.md`'s baseline header was relabelled
**historical**, so every figure below is now reachable as dated rather than current.

| # | Drift | Where | Current, measured 2026-08-29 | Owner |
|---|---|---|---|---|
| **D1** | "145 suites · 6 363 tests" (and "6 287", "6 357") | `ROBOTX_SYSTEM_HANDBOOK.md` lines 53, 55, 1136, 1895, 2915, 3858, 3860, 4081, 4083, 4120, 4132, 4350, 4525, 4553 · `ARCHITECTURE.md` header | **162 suites / 7 275 tests / 0 failures**, exit 0 — re-measured 2026-08-30 *(was 160 / 7 162 on 2026-08-29; T1-04 and V-10 added two suites)*. **This row is itself the argument for the rule below: a suite count is stale the moment anyone adds a test, which is why these are recorded rather than chased** | Whoever next re-compiles the handbook |
| **D2** | "185 engine modules" / "186 `.js` files" | `ROBOTX_SYSTEM_HANDBOOK.md` lines 64, 146, 247, 299, 2911, 3243, 3247, 4110, 4553 · `ARCHITECTURE.md` §1.4 | **Approximate, and each gate scopes its own:** `gate:tiers` governs **285**, `gate:params` scans **189**, `find src/engine -name '*.js'` gives **192**. The handbook's own advice — quote a gate's number with the gate's name attached — is the right rule | Programme-wide |
| **D3** | `gate:tiers` quoted as "277 modules / 386 edges" and `gate:params` as "183 modules" | `ROBOTX_SYSTEM_HANDBOOK.md` §0.1 | **285 / 423** and **189 / 242** | Phase 0's gates |
| **D4** | "39 ADR files … ADR-01 through ADR-33 plus six lettered sub-records" — presented as a *corrected* count | `ROBOTX_SYSTEM_HANDBOOK.md` §0.1 | **40 files**, ADR-01…**34** plus six lettered. The handbook corrected 38→39 and was then overtaken by ADR-34 | Whoever next re-compiles the handbook |
| **D5** | Phase 15 row: "16 GREEN · 2 RED · 1 PARTIAL · 4 NOT_EVALUATED … **BLOCKED**", entry conditions, findings N11–N20 | `ROBOTX_SYSTEM_HANDBOOK.md` §29 phase table, line 1694 | Superseded by this register and by `PHASE_15_CLOSURE_CHECKLIST.md`. Left intact because it is one row of a 16-row cross-phase table whose other rows this audit did not verify | Whoever next re-compiles the handbook |
| **D6** | The label "**Ph15 F1**" applied to the `tla2tools.jar` gap | `ROBOTX_SYSTEM_HANDBOOK.md` §41 | **Naming collision.** In the current ledger **P15-F1** is the observation-bound weakening finding (fixed); the `tla2tools.jar` gap is **B-M**. The handbook's label predates both IDs | Whoever next re-compiles the handbook |

**None of the above blocks anything.** They are registered so the next pass inherits them by name
rather than rediscovering them, and so no one mistakes a dated figure for a current one.

---

## Findings that are CLOSED — do not re-open

Every entry below was raised by an earlier pass and is closed. **Do not re-open one because an
archived report shows it OPEN** — archived reports were frozen at the moment they were written.
Where "verified 2026-08-29" appears, this consolidation re-confirmed it directly; the rest are
closed on the archived pass's own evidence and were not re-attacked here.

| ID | Finding | Resolution |
|---|---|---|
| **D-4 / D-5** | Shadow + Tier 0 decision-path composition, filed as in-repository | **RECLASSIFIED, not fixed.** `outbox` and `reconciler` are wired via `workers/leaderWorkers.js`; `coordinator` and `shadow` are **EXTERNAL — B1**. This reclassification is the correct one and is confirmed by `gate:composition`'s own owner field (verified 2026-08-29) |
| **D-6** | Socket handlers read half the staging switch | **FIXED** — `cutover/agentGate.js` evaluates the full conjunction; all five handlers call it; identity bound at AUTH and refreshed. Live-DB verified, mutation-tested |
| **D-7** | Rehearsal/cutover circularity — the gate set was unsatisfiable | **FIXED under ADR-34** — a `REHEARSAL` purpose requiring a declared non-production environment, setting aside exactly one gate. No gate weakened |
| **D-8** | `SHARD_MIGRATE` undelivered | **FIXED** by the D-5 wiring |
| **D-9** | §4.5 timer expiry semantics — 16 declared `on expiry` actions with no implementation | **RETURNED TO PHASE 5 and closed there** (`PHASE_5_ADVERSARIAL_REMEDIATION_AND_CLOSURE.md`, 2026-08-22): 17 expiry actions implemented, timer worker composed. **Not a Phase 15 blocker** |
| **D-10** | Composition gate used a path proxy | **FIXED** — gate strengthened |
| **D-11** | Duplicate-writer test could not fail | **FIXED** |
| **D-12** | 100/279 modules unreachable | **MEASURED**, informational — reframes D-4/D-5 |
| **D-13** | Fail-open in the D-6 gate | **FIXED** (would have been blocking had it shipped) |
| **P15-R1** | The automatic rollback published nothing | **FIXED** — `cutover/rollbackPublisher.js`, wired at `server.js:207` |
| **P15-R2** | No process ever re-read the pinned configuration | **FIXED** — `cutover/configPropagation.js`; the pull loop runs and is stopped on shutdown |
| **P15-R3** | §18.5's command suspension was unwired | **FIXED** — the shard's open degraded modes are an accessor, not a constant `[]` |
| **P15-R4** | Socket intake read a snapshot that does not exist | **FIXED** |
| **P15-R5** | Intake inherited the global binding when no region was named | **FIXED** (permissive) |
| **P15-R6** | Timer worker composed with no operating region | **FIXED** |
| **X2a / X2b** | `OFFERED → ACCEPTED` and outbox-withdrawal `→ QUEUED` had no deadline | **FIXED** in pass 1, verified in pass 2 |
| **P15-C1** | Evidence-binding context was half-mandatory | **FIXED** (permissive) — with an age bound |
| **P15-C2** | The authority accepted a guardrail declaration its own reader refuses | **FIXED** (permissive) |
| **P15-C3** | A gate flag its adjudicator would silently ignore | **FIXED** (latent) |
| **P15-C4** | No cutover audit event could ever be written | **FIXED** — verified 2026-08-29 by `phase15EvidenceBinding.js` D2/D3 (17/17) |
| **P15-E1** | PRODUCTION observation window that is not a window — `NaN`/`±Infinity`/future windows ADMITTED+PASS on all four B-P gates | **FIXED** (permissive, blocking) — `Number.isFinite` on both endpoints, refusal by name, and a window may not close in the future. Verified 2026-08-29 by `phase15VersionInForce.js` C1–C3 (19/19) |
| **P15-E2** | The automatic rollback's base configuration was the wrong version | **FIXED** — the version **in force**, not the latest published |
| **P15-E3** | The same `NaN` shape in `guardrails.assess()` | **FIXED** (latent, permissive) — verified 2026-08-29 (C1) |
| **P15-E4** | A caller-supplied minimum-observation bound of zero | **FIXED** (permissive) |
| **P15-E5** | The lifecycle model check claimed an exhaustion that was impossible | **FIXED** — the claim was corrected. The underlying gap is now tracked as **B-M** |
| **P15-E6** | Cutover runbook prerequisite 2 could not be discharged by the check it names | **FIXED (documentation).** The producer gap remains — residual observation 3 |
| **P15-F1** | A caller could weaken a release requirement by stating a smaller number (a 72-hour soak discharged by a 1-second window) | **FIXED** — the authority resolves the bound from the register and refuses a caller who states one, in both directions. Reproduced BEFORE the fix, re-attacked with 12 mandated attack cases and 8 distinct mutants across three concurrent sessions |
| **P15-F3** | Every malformed `--max-age-hours` refused except the one a shell produces | **FIXED** (low) |
| **P15-F7** | The only documented invocation of `authoriseEnable()` could not authorise anything | **FIXED (documentation)**, and the fix itself was then corrected for a gate-id collision divergence. Verified present 2026-08-29 at `docs/runbooks/cutover.md:220–229` |
| **A1** | `assertSelfHosted` accepted all six public hosted routing services written as a trailing-dot FQDN | **FIXED** — the most serious finding of the B1 prerequisite pass; §32.4 marks this requirement non-negotiable |
| **A2–A8** | Seven further B1-prerequisite validator defects (V-11 dropping the region under assessment; V-12 skipped silently; V-13 uncalled; a future vintage clearing every cadence; two authorities disagreeing about dates; `stepEvidenceAdmissible` true while Step 1 `NOT_CONFIGURED`; whitespace satisfying every "name the source" check) | **FIXED** — every fix moves a verdict in the strict direction only (`PASS`→`FAIL`, `ACCEPTED`→`refused`, `admissible`→`inadmissible`) |
| **R-1 / R-2 / R-3** | Residual validator defects found during the B1 pass's own final verification | **FIXED** — 5 mutants, 5 killed |

**Carried forward, unchanged, from the B1 prerequisite pass** (specification/governance, not
Phase-15-owned): **F2** (`route.matrix_timeout` / `route.path_timeout` unregistered — §22.1
governance), **F3** (the GraphHopper snap-radius asymmetry — must appear in the B1 ADR as a real
difference between candidates), **N29** (`travelTimeSpread`'s source — open for every candidate; the
engine choice does not close it).

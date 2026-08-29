# CURRENT PHASE 15 SOURCE OF TRUTH

> **This document is the canonical navigation and current-state document for Phase 15.**
>
> **Archived Phase 15 reports are historical evidence only.**
> **They MUST NOT be used as current implementation truth.**
>
> Every archived report was written against a tree that no longer exists, and several of them
> were corrected by later passes. Reading them to decide what to implement is the specific
> failure this document exists to prevent.

**Consolidated:** 2026-08-29
**Branch:** `feature/dashboard` · **HEAD:** `b68dc5d` ("before phase 15 docs structuring") · working tree clean
**Source digest of the tree every measurement below was taken against:**
`431010ace188c4b1b91415821e8cebc7beeb8f3f378a1b39fb77986fb3b22470` (565 files)
— computed live via `node -e "require('./tools/release/sourceDigest.js').sourceDigest()"` from `Backend/`.

---

## 1. Authority order

When this document and any other source disagree, resolve in this order:

| # | Authority |
|---|---|
| 1 | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` — **FROZEN** architecture/specification |
| 2 | `IMPLEMENTATION_EXECUTION_PLAN.md` — execution plan |
| 3 | **The actual current repository** — source, config, schema, migrations, tests, scripts, tools, generated artefacts, git state |
| 4 | Freshly executed verification against the current repository |
| 5 | These five canonical Phase 15 documents |
| 6 | `archive/` — historical Phase 15 reports |

A historical report is **not** authoritative because it is detailed, recent, or says "FINAL".

---

## 2. What Phase 15 is

`IMPLEMENTATION_EXECUTION_PLAN.md` §3, "PHASE 15 — Verification, release gates, and production
cutover". Its purpose is **not** new capability. It is:

- implement `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §24 in full — the release-gate table;
- implement §22.4's staging discipline — the per-shard cutover authority and its guardrails;
- move every engine worker from shadow to **production scheduling**;
- **remove** the legacy DTARO decision path from the build, not bypass it;
- provide the evidence machinery — source digest, evidence collection, release verdict,
  safety case, simulator-fidelity gate, formal-verification artefacts.

Phase 16 has exactly one prerequisite: Phase 15.

---

## 3. Current status — the verdict

# PHASE 15 IMPLEMENTATION — CLOSED
# PHASE 15 RELEASE — BLOCKED
# PHASE 16 — NOT READY

**Read the distinction carefully; it is the single most important fact in this document.**

- **Implementation CLOSED** means: Phase 15's *code* obligations are discharged. The cutover
  authority, its evidence binding, its observation-window authority, its rollback publisher and
  its configuration propagation are implemented, adversarially attacked, mutation-tested, and
  verified against a live PostgreSQL database. Six adversarial passes have each closed their own
  findings.
- **Release BLOCKED** means: `npm run release:verdict` exits 1 — **8 of 24 blocking gates are not
  green** (1 RED, 7 NOT_EVALUATED). Nothing in this repository can turn any of those 8 green.
- **Phase 16 NOT READY** follows from the release verdict, and additionally from **REMEDIAL PHASE
  T1-04**, whose three fairness modules do not exist.

**"In-repository defects: none remaining" is NOT claimed and should not be claimed.** Every pass
that has claimed it has been proven wrong by the next pass, because each pass searches the surface
the previous pass's fix created. See §51 of the archived third-pass report for why this is
structural rather than accidental.

---

## 4. Current repository identity

| | |
|---|---|
| Branch | `feature/dashboard` |
| HEAD | `b68dc5d8653b6b9f435b29b21a70775e1dcd4d45` — "before phase 15 docs structuring" |
| Working tree | **Not clean, and deliberately so.** The consolidation (2026-08-29) and the documentation-integrity audit that followed it are **uncommitted, documentation-only** changes: the five files in `docs/phase15/`, `archive/` and its README, and pointer/fact corrections in `ARCHITECTURE.md`, `README.md`, `ROBOTX_SYSTEM_HANDBOOK.md` and `docs/history/README.md`. **No application source, test, schema, migration, gate, threshold or CI file was touched** — which is why the digest below is unchanged |
| Source digest | `431010ace188c4b1b91415821e8cebc7beeb8f3f378a1b39fb77986fb3b22470` |
| Files in digest scope | 565 |
| Digest scope | `Backend/{src,tools,tests}`, `Backend/package.json`, `Backend/jest.config.js` — **`docs/` is deliberately excluded** |
| Registered workers | 18 registered · **11 actually start** (8 `SCHEDULED` + 3 of 4 `LEADER_ONLY`) · 6 `DEFERRED` · 1 refused (`coordinator`, B1) |
| Prisma migrations | 27 |
| §24 release gates | 24, all blocking. `gates.blockers({})` returns all **24** |
| Build gates in `npm run gates` | **8** — 7 PASS, 1 FAIL (`gate:composition`) |

**The digest is the binding fact.** Any report — archived or otherwise — that quotes a different
digest was measured against a different tree, and its numbers do not transfer. Digests seen in the
archive that are **NOT** this tree: `22ca9143…`, `134ebc0d…`, `801ed1df…`, `72f943df…`, `d9fdb79a…`.

---

## 5. Current implementation summary

Full detail: **[`PHASE_15_IMPLEMENTATION_STATE.md`](PHASE_15_IMPLEMENTATION_STATE.md)**.

| Subsystem | State |
|---|---|
| Cutover authority | **Implemented** — `src/engine/cutover/` (10 modules) |
| Release gates + evidence | **Implemented** — `tools/release/` (3 tools), 24-gate table in `src/engine/cutover/gates.js` |
| Workers / composition root | **Implemented** — `server.js` is the production composition root. 18 registered; **11 start** (8 `SCHEDULED` + 3 of 4 `LEADER_ONLY`). **1 cannot be composed** (`coordinator`, B1) and **6 are `DEFERRED` with declared blockers**. `gate:composition`'s "1 violation of 18" counts *compliance*, not *starts* — see `PHASE_15_IMPLEMENTATION_STATE.md` |
| Legacy retirement | **Complete** — 4 modules deleted, build gate enforces absence |
| Routing | **Adapters + readiness tool implemented; NO ENGINE SELECTED** (B1, external) |
| Calibration | Gate implemented; **39 blocking findings** (B8, external) |
| Simulator fidelity | Gate implemented; **no study supplied** — 7 models NOT_MEASURED |
| Safety case | Assembler implemented; assembles cleanly. **The §24.7 gate is not thereby discharged** |
| Formal verification | TLA+ modules + 6 TLC configs present; **`tla2tools.jar` absent — TLC has never been run** |
| Database | 27 migrations; 4 Phase 15 live-DB harnesses, all green |
| Runbooks | `docs/runbooks/cutover.md` (391 lines) and `rollback.md` (269 lines) |

---

## 6. Current verification summary

Full detail with commands, exit codes and dates: **[`PHASE_15_VERIFICATION_STATE.md`](PHASE_15_VERIFICATION_STATE.md)**.

Everything below was **executed on 2026-08-29 against digest `431010ace1…`** as part of this
consolidation. These are not inherited numbers.

| Command | Exit | Result |
|---|---|---|
| `npm test` | **0** | 160 suites / 7 162 tests / 0 failures / 0 skips |
| `npm run gates` | **1** | 7 PASS, 1 FAIL (`gate:composition` — B1) |
| `npm run release:verdict` | **1** | 16 GREEN, 1 RED, 7 NOT_EVALUATED — **RELEASE: BLOCKED** |
| `npm run gate:calibration` | **1** | 39 blocking findings; 242 entries (52 DERIVED / 152 PROVISIONAL / 38 UNCALIBRATED), 54 Safety-class |
| `npm run routing:readiness` | **0** *(by design)* | **OVERALL: BLOCKED** — D1, D3, D8 all BLOCKED; Steps 1/3/4/5 BLOCKED, Step 2 PASS |
| `npm run sim:fidelity` | **1** | 7 models NOT_MEASURED, 6 safety-relevant |
| `npm run safety:case` | **0** | 12 hazards assembled, every reference resolves |
| 4 × `tools/verify/phase15*.js` on live PostgreSQL 18.3 | **0** | **80 / 80** checks |

**NOT currently verified** (labelled honestly, not assumed): mutation testing, TLC model checking,
Phase 0–14 cross-phase re-verification, and the soak/shadow/invariant observation windows. See
`PHASE_15_VERIFICATION_STATE.md` §5.

---

## 7. Current blockers

Full register with owners and closure conditions: **[`PHASE_15_BLOCKERS.md`](PHASE_15_BLOCKERS.md)**.

**8 open blockers. 0 are repository-owned *and actionable*** — the one repository-owned entry (A9)
is correctly deferred to Phase 8 and has no action available here.

> **Two different quantities in this documentation both happen to equal 8. Do not conflate them.**
> **8 open blockers** (this table) is a programme count — it includes specification and
> phase-ownership items that are not §24 gates. **8 blocking gates not green** (the §24 table: 1 RED
> + 7 NOT_EVALUATED) is the release-verdict count. B1 appears in both; X3, X1/T1-04 and A9 appear
> only in the blocker count; the four individual PRODUCTION gates are one blocker (B-P) but four
> gate rows. The coincidence is arithmetic, not a correspondence.

| ID | Summary | Classification | Owner |
|---|---|---|---|
| **B1** | No routing engine selected → `coordinator` uncomposable → `engine_decision_path_wired` RED | **EXTERNAL** | Ops + Commercial (D1), Product + Fleet Eng (D3), Ops (D8) |
| **B8** | 39 Safety-class parameters not `DERIVED` | **EXTERNAL** | §22.4 calibration owner |
| **B-P** | 4 PRODUCTION gates NOT_EVALUATED — needs an operating fleet | **EVIDENCE / OPERATIONS** | Operations |
| **B-O** | 3 ORGANISATIONAL gates NOT_EVALUATED — needs filed attestations | **EVIDENCE / OPERATIONS** | Named humans / release owner |
| **B-M** | `model_check_capacity_1_2_3` is GREEN and **NOT PROVEN** — TLC never run | **EVIDENCE / OPERATIONS** (compute) | Release owner + compute |
| **X3** | No `TASK` timer producer; §4.2 has no transition table | **SPECIFICATION / ADR** | Frozen-spec owner |
| **X1 / T1-04** | §17.4 escalation ladder + 3 fairness modules unimplemented | **SPECIFICATION / ADR** (phase ownership resolved; work not done) | REMEDIAL PHASE T1-04 |
| **A9** | `assertVersionInKey` implemented, tested, genuinely uncalled | **REPOSITORY-OWNED, correctly deferred** | Phase 8 |

**A9 is the only repository-owned entry, and it is deferred by design** — its discharge point is
`src/engine/routing/client.js`, a Phase 8 module that does not exist and cannot exist before B1.
Do not manufacture a caller for it.

Separately, there are **7 residual in-repository observations that are reported and not fixed**.
None is permissive. They are listed in `PHASE_15_BLOCKERS.md` §"Residual" and are *not* counted as
blockers.

### 7.1 Known unresolved contradictions

**Yes, there are some. They are named rather than silently corrected.** A fresh agent reading these
five documents *and then* opening `ARCHITECTURE.md` or `ROBOTX_SYSTEM_HANDBOOK.md` will hit
statements that contradict this document. That is expected and is registered, not accidental:

- **Inside the five canonical documents: none known.** §16 of the audit compared every
  status, count and classification across MASTER / IMPLEMENTATION_STATE / VERIFICATION_STATE /
  BLOCKERS / CLOSURE_CHECKLIST against the repository on 2026-08-29 and found no surviving
  contradiction. Where a fact was not established, it is written `UNKNOWN` or `NOT VERIFIED`.
- **Between the canonical documents and the wider documentation: 9 registered discrepancies.**
  The Phase-15-owned falsehoods were corrected on 2026-08-29 (worker scheduling, composition root,
  release-gate count, build-gate count, `gate:legacy`'s quoted output, ADR-34's absence from the
  authority table, CI's third omission). The rest — engine-module counts, suite/test counts, and
  repeated "7 build gates / 23 release gates" phrasing scattered through the handbook — are
  **cross-phase drift that Phase 15 does not own** and were deliberately left in place and
  recorded. **Full register with file and line: [`PHASE_15_BLOCKERS.md`](PHASE_15_BLOCKERS.md)
  § *Cross-phase documentation discrepancies*.**

**When this document and `ARCHITECTURE.md` / `ROBOTX_SYSTEM_HANDBOOK.md` disagree about Phase 15,
this document wins** — §1's authority order, rank 3 (the repository) then rank 5 (these five
documents); `ARCHITECTURE.md` ranks itself below both.

---

## 8. Current closure status

Full checklist: **[`PHASE_15_CLOSURE_CHECKLIST.md`](PHASE_15_CLOSURE_CHECKLIST.md)**.

Phase 15 does not close on test results. It closes on the §24 gate table, and **8 of its 24
blocking gates are not green**. Every one of the 8 requires a decision, a measurement, an
attestation or a compute run that no commit in this repository can supply.

---

## 9. Safe next actions

**For a human / the programme (these unblock Phase 15):**

1. **Operations + Commercial answer D1** — the authoritative operating region: `regionId` + `name`,
   `kind`, the serviceable boundary as GeoJSON Polygon/MultiPolygon in WGS-84 `[lon, lat]`, the CRS,
   and a version label with a date.
2. **Product + Fleet Engineering answer D3** — the agent classes operated and, per distinct mobility
   model, §2.2's six elements with a real speed model.
3. **Operations answer D8** — extract identity, source, vintage (ISO), refresh cadence,
   re-contraction downtime budget, plus `extract.bbox` and `extract.marginDegrees`.
4. **§22.4's calibration owner** derives the 39 Safety-class values (B8).
5. **Release owner** provisions `tla2tools.jar` and runs the exhaustive TLC configurations (B-M).

**For an AI coding agent, right now, in this repository:**

- Read the five canonical documents. Nothing else is required to understand current state.
- Answer questions about current state from `PHASE_15_VERIFICATION_STATE.md`, or re-run the
  command yourself. Do not quote a number from `archive/`.
- If asked to *implement* something in Phase 15: there is **no unblocked Phase 15 implementation
  work identified**. Confirm the request against `PHASE_15_BLOCKERS.md` before writing code.
- If the repository has changed since the digest in §4, **re-measure before answering**. The digest
  is how you tell.

---

## 10. Forbidden actions

These are not stylistic preferences. Each corresponds to a defect a previous pass either committed
or came close to committing.

| Do NOT | Why |
|---|---|
| Select, rank, recommend or hint at a routing engine | B1 Step 5 is a decision on recorded evidence, in an ADR. No evidence exists |
| Invent an operating region, boundary, CRS or region kind | D1. `prisma/seed.js`'s `SEED_SPATIAL_MAP` / `RGN-BLR` is a **Phase 2 containment demonstration, not production configuration** |
| Invent a mobility model, speed model or speed data | D3. The only `MobilityModel` in the repository is a seed whose `speedModel` is a note deferring to this decision |
| Invent an extract vintage, cadence or bbox | D8 |
| Derive, edit or reclassify any calibration value | B8. §22.3 forbids automated change of a Safety-class parameter |
| Change any threshold | Every threshold in the §24 table and the register is governed |
| Weaken a gate, or convert `NOT_EVALUATED` → `GREEN` | `NOT_EVALUATED` blocks exactly as `RED` does (§24), and is kept distinct on purpose |
| Use `DEGRADED_ROUTING` as a substitute for a routing service | It is a degradation ladder rung, not an engine |
| Write a stub, fake or in-process router to make `gate:composition` pass | Starting the coordinator on invented travel times assigns real work on invented data |
| Manufacture a caller for `assertVersionInKey` (A9) | Its seam is a Phase 8 module that does not exist |
| Fabricate an observation window, soak record, rehearsal record or attestation | These are the four gates the whole programme has classified as un-closable by commit |
| Put `docs/` into the source digest scope | Every prose edit would void a ~25-minute evidence collection. See B-M/P15-F7a discussion |
| Begin Phase 16 implementation | Phase 16's only prerequisite is Phase 15, which is not closed |
| Re-open a blocker because an archived report gives an older classification | The archive is frozen history. §11 explains |
| Mark a blocker closed because an archived report says "FIXED" | Six passes have proven a historical "FIXED" insufficient |

---

## 11. Documentation map

### Canonical — read these

| File | Answers |
|---|---|
| **`PHASE_15_MASTER.md`** (this file) | Navigation + current truth + what not to do |
| **`PHASE_15_IMPLEMENTATION_STATE.md`** | What actually exists in the repository, by subsystem |
| **`PHASE_15_VERIFICATION_STATE.md`** | What has actually been proven, with command + exit code + date + tree |
| **`PHASE_15_BLOCKERS.md`** | What prevents closure, who owns it, what closes it |
| **`PHASE_15_CLOSURE_CHECKLIST.md`** | The exact exit conditions and the current verdict |

### Upstream authorities — unchanged by this consolidation

- `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` (FROZEN)
- `IMPLEMENTATION_EXECUTION_PLAN.md`
- `docs/adr/` — in particular **ADR-11** (routing), **ADR-33** (B1 traversal-domain scope),
  **ADR-34** (cutover rehearsal purpose)

### Historical — `archive/`

15 superseded Phase 15 reports, indexed at **[`archive/README.md`](archive/README.md)**.

---

## 12. Historical archive policy

1. Every archived document is preserved **byte-for-byte**. None was edited, annotated, softened or
   truncated. They are audit records of what was believed at a point in time, and several of them
   contain a later pass's correction *of* an earlier pass — that correction history is itself the
   evidence, and rewriting it would destroy it.
2. Because they are unedited, **no archived file carries a banner saying it is archived.** Their
   status is declared in `archive/README.md`, which names each file, the tree it was measured
   against, and why it is superseded. **Read `archive/README.md` before opening any archived file.**
3. Open an archived report only to answer *"what did we believe on date X and why"*. Never to
   answer *"what is true now"*.
4. Nothing was deleted. No two Phase 15 reports were byte-identical, and every one contains unique
   historical evidence.

---

**TRUTH > GREEN.**

# PHASE 15 IMPLEMENTATION — CLOSED. RELEASE — BLOCKED. PHASE 16 — NOT READY.

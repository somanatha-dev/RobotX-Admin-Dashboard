# RD-2026-09-05-02 — V1 agent boundary and simulation track

| Field | Value |
|---|---|
| **Record** | `RD-2026-09-05-02-v1-agent-boundary-and-simulation-track` |
| **Date** | 2026-09-05 |
| **Status** | **DRAFTED FOR SIGNATURE — unsigned** |
| **Subject** | The three decisions FD-1, FD-2 and FD-3 of [`V1_DISCOVERY_AND_OWNER_QUESTIONS.md`](../v1/V1_DISCOVERY_AND_OWNER_QUESTIONS.md) §12.8, and the classification of the multi-robot simulation track |
| **Scope** | These three decisions and that classification. **Nothing else.** §2 states what this record does not decide |
| **Supersedes** | Nothing. `RD-2026-09-05-01` is unaffected and remains issued and unanswered |
| **Authority for the simulation classification** | `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` §24.4 and [`ADR-31 — Simulator trust`](../adr/ADR-31-simulator-trust.md) — **cited, not restated** (§4) |

---

## 1. Decisions

Three decisions, recorded as taken. Each is stated in the form the question was asked in
`V1_DISCOVERY_AND_OWNER_QUESTIONS.md` §12.8, so that the answer and the question cannot drift
apart.

### FD-1 = **A**

> **A — Accept that V1 stops at S-5 until hardware exists.** S-1, S-2, S-5 and S-8 close; S-3
> closes as far as one person can take it; S-4, S-6 and S-7 are recorded as *awaiting hardware*,
> which is a true and defensible state to be in.

**The V1 contract is unchanged. A real commissioned physical agent is required for S-6.** RobotX
hardware is in active development (§3).

> **One clause of option A's own text is corrected by §13.2 of `V1_DISCOVERY_AND_OWNER_QUESTIONS.md`,
> and the correction is not a change to this decision.** Option A says *"S-3 closes as far as one
> person can take it"*. **S-3 does not close at all.** It is a single, indivisible stop condition
> over 28 inputs; supplying 13 of them leaves S-3 **NOT MET**. Choosing A does not partially close
> S-3, and this record must not be read as though it did.

### FD-2 = **YES**

One real plug-in location will be provided.

**This is an authorisation, not a supply.** No charger location, region, `isDepot` value or
per-profile return-leg Wh/metre is stated in this record, and none has been supplied. Until the
location **and** the rate are both declared — §11 step 5, *both or neither* — F34 and F35 continue
to deny for every candidate at every state of charge, exactly as they do today. **An authorisation
to supply a value is not the value.**

### FD-3 = **NO FOR NOW**

There is no second Safety approver. **Do not self-approve.**

**Satisfiable later by one named person.** This is not a permanent state and not a judgement about
the project; it is a fact about who exists today, and it is discharged the moment one further named
individual can review and co-sign. Until then, `SAFETY_APPROVAL_QUORUM = 2` stands and no
automated, harness-supplied or self-supplied second identity may be offered against it.

---

## 2. What is explicitly NOT decided

This record decides three things. It decides none of the following, and no reader may treat it as
having done so.

| Not decided | Statement |
|---|---|
| **The V1 contract** | **Unchanged.** `V1_CONTRACT_AND_STOP_CONDITION.md` §I.1 and §I.2 are untouched by this record |
| **S-1 … S-8** | **Unchanged**, individually and as a set. No condition is added, removed, reworded, split, merged or reinterpreted. There is no S-9 |
| **S-6** | **Unchanged.** S-6 still requires one real request over HTTP against a live PostgreSQL reaching a durable `Commitment` row and an `Outbox` row in the same transaction, with a `Round` row and a per-Leg decision record |
| **A simulated agent as V1's agent** | **NOT admitted.** No declared, labelled or otherwise simulated agent stands as V1's agent for any purpose. FD-1 = A is precisely the decision *not* to take option B, and option B — changing what S-6 means — remains untaken and available to the owner as a separate, future record |
| **Any external value** | No routing source, region, charger, terrain figure, calibration constant, temperature, mass, `p_fail`, hazard cost, energy rate or target state of charge is stated, defaulted or illustrated anywhere in this record |
| **B8 / D-1** | The Safety-class calibration decision is not taken here. FD-3 = NO records that it *cannot* be taken today |
| **`RD-2026-09-05-01`** | Unaffected. It remains issued and unanswered, and only a response supersedes it |

---

## 3. Physical RobotX

**Physical RobotX is in active development.**

When it exists it is expected to connect through the **existing control-plane and commissioning
path** — the same path `AgentCertificate`, `CapabilityAttestation`, the session registry and the
§7.5 agent record already describe — and **not through a second architecture** built alongside it.

The practical consequence, and the reason this is written down rather than assumed: **no work
undertaken while hardware is absent may introduce a parallel route into the decision path for
agent facts.** The hardware handover is populating the control-plane tables and swapping the
existing accessors (§11 step 12). It is not a migration, and it must not become one.

---

## 4. The multi-robot simulation track

The high-fidelity multi-robot simulation is an **intentional engineering track**.

Its authority is `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` **§24.4** and **`ADR-31 — Simulator
trust`**. Both are **cited here and deliberately not restated**: §24.4 is the authoritative
statement, ADR-31 is its durable citable identity and says of itself that it *"does not restate,
summarise, or reinterpret that section"*, and a third paraphrase in this record would be a fourth
statement of one rule — which is how a register rots.

**Classification: V1-ENG.**

> **It discharges no stop condition.** Not S-6, not S-4, not S-7, not any other. Nothing produced
> by this track may be offered as evidence for any of the eight, and no count, gate, harness exit
> code or verdict anywhere in the V1 documents may cite it.

It is tracked in `V1_IMPLEMENTATION_CONTROL.md` **§11.F**, which is a new sub-section created for
exactly this purpose — **not** in §11.A, because §11.A is the V1 worklist and adding engineering
work to it would extend a list §11 declares closed.

---

## 5. The consequence, stated once

**With FD-1 = A, the reachable ceiling for V1 is 4 of 8 — S-1, S-2, S-8 and S-5.**

S-3 does not close (§1, FD-1). S-4, S-6 and S-7 are consequences of S-3 and are recorded as
awaiting hardware and awaiting the external inputs. **The single condition that FD-1 = A leaves
reachable is S-5**, and reaching it would take the score from 3 of 8 to 4 of 8.

> **This section was drafted stating that S-5's reachability was unmeasured pending S5-1. S5-1 has
> since been run, in the same pass, and the sentence is replaced by its result rather than left
> standing as a question that has been answered.**
>
> **S-5 is not reachable under FD-3 = NO. Measured 2026-09-05.** On a disposable PostgreSQL 18.3
> cluster built for the run, a labelled non-production configuration version binding **only**
> `cutover.engine_enabled = true` at region scope — with no Safety-class binding, no
> accommodation, no relabelling and no bypass — was **refused**, writing **zero** `ConfigVersion`
> rows, on **two independent** blocking findings:
>
> - **V9** — the register's own defaults give a combined degraded energy conservatism of `2.0125`
>   against `energy.max_combined_conservatism` of `1.6`. It is in the candidate's blocking set
>   whatever is bound, so it blocks **every** publish, first or subsequent, until a Safety-class
>   decision moves `route.degraded_reserve_factor` or `energy.max_combined_conservatism`.
> - **S2** — a first publish has no previous version, so **47** Safety-class parameters count as
>   changed at once and §22.3's two-person rule fires **whatever is bound**. A subsequent publish
>   changing no Safety value produces **0** such changes and does not trigger it.
>
> `cutover.engine_enabled` is `STRUCTURAL` and appears in neither set; its own change class was
> never the constraint. **Both refusals require a Safety authority and a second approver, and
> FD-3 = NO means neither exists today.**
>
> **The ceiling of 4 of 8 therefore depends on FD-3, not only on FD-1.** With FD-3 = NO the score
> stands at **3 of 8**. The evidence is recorded in `V1_IMPLEMENTATION_CONTROL.md` §16 and §7.

---

## 6. Author and date

**S-3's closure requirement is that external values and owner decisions are supplied by the owner,
in writing, in a decision record under `docs/release-decisions/`. An unsigned record does not
satisfy it.** This record is drafted by the repository and is not in force until the owner
completes the two fields below.

| Field | Value |
|---|---|
| **Decision author (owner)** | ☐ *to be completed by the owner* |
| **Date signed** | ☐ *to be completed by the owner* |
| **Signature** | ☐ *to be completed by the owner* |

| | |
|---|---|
| **Drafted by** | Repository, 2026-09-05, against tree `10a527c85bd8a314be54a5aaa681af3ab1502e89` |
| **Drafted at the owner's instruction** | The three decisions in §1 were stated by the owner and are recorded here verbatim in the form §12.8 asked them. **No decision in this record was chosen by the repository** |
| **Status until signed** | **Not in force.** The decisions are recorded; the record is not yet the written owner decision S-3 requires |

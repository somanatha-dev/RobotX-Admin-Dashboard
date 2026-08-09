# RobotX — Safety Case

> **This file is generated. Do not edit it.**
>
> Run `npm run safety:case` to regenerate. The only hand-written input is
> `docs/safety-case/hazards.json`, which contains the enumerated hazard list and *no evidence*.
> Every class, policy, tier and gate status below is read from the shipped code at assembly time,
> which is what §24.7 means by "the safety evidence is a query rather than a documentation exercise".

## Provenance

- `hazards` — docs/safety-case/hazards.json
- `constraintRegister` — Backend/src/engine/feasibility/register.js
- `invariantChecker` — Backend/src/engine/observability/invariantChecker.js
- `tierRegistry` — Backend/src/engine/guards/tierAssertions.js
- `releaseGates` — Backend/src/engine/cutover/gates.js
- `predicateCount` — 38
- `invariantCount` — 22

## Hazards, their mitigations, and their monitoring

### H1 — Two commitments are granted on one physical agent

The hazard the whole commitment core exists to prevent: two decisions, taken concurrently or across a leadership change, each believing they hold the same agent. The physical consequence is two missions dispatched to one machine, which no downstream component can undo — §10.2 is explicit that a cache lock with a TTL cannot prevent it, because a paused holder cannot know it was preempted.

**Specification:** §10.1, §24.2
**Severity:** CATASTROPHIC

**Mitigating constraints** (class and policy read from the §7.5 register):

| Predicate | Name | Class | Policy | Waivable (§23.6) |
|---|---|---|---|---|
| F17 | The candidate plan holds no more than capacity[agent_class] concurrent commitments and extends no further than plan.commitment_horizon | I | DENY | **never** |
| F18 | No conflicting reservation held by another subsystem | I | DENY | **never** |

**Monitoring invariants** (§26, checked independently of the code that maintains them):

- I1 — checked; Tier 0 — Safety core
- I5 — checked; Tier 0 — Safety core
- I19 — checked; Tier 0 — Safety core

### H2 — An agent is dispatched on a mission it cannot energetically complete, and strands

A percentage battery floor cannot express a tail requirement, and the same percentage means a different number of watt-hours on every pack and at every state of health. An agent that departs on a plan whose energy it does not have strands mid-mission — with goods aboard, possibly obstructing — and the recovery is physical, not algorithmic.

**Specification:** §14.1, §14.5
**Severity:** SEVERE

**Mitigating constraints** (class and policy read from the §7.5 register):

| Predicate | Name | Class | Policy | Waivable (§23.6) |
|---|---|---|---|---|
| F34 | Energy feasibility with layered reserves at the configured confidence, evaluated at all three shortfall tiers | I | DENY | **never** |
| F35 | Charger reachable from the projected mission end with reserve intact | I | DENY | **never** |

**Monitoring invariants** (§26, checked independently of the code that maintains them):

- I9 — checked; Tier 0 — Safety core
- I13 — checked; Tier 1 — Operational integrity

### H3 — An agent strands in a position that obstructs a right of way or an emergency route

A robot stopped harmlessly in a car park and a robot stopped across a tram line are the same event only to a database. The second is a public-safety event whose response time is measured in minutes and whose escalation chain includes traffic authorities. The classification is derived from the stopping location's obstruction class and is never operator-entered; an unavailable or stale class resolves to the more serious case under §7.3's DENY semantics.

**Specification:** §4.3, §18.6
**Severity:** CATASTROPHIC

**Mitigating constraints** (class and policy read from the §7.5 register):

| Predicate | Name | Class | Policy | Waivable (§23.6) |
|---|---|---|---|---|
| F27 | Agent authorised in every zone the planned route traverses | R | DENY | **never** |
| F28 | Route uses only road/surface classes the MobilityModel permits | I | DENY | **never** |
| F29 | Dimensional passage feasible along the route | I | DENY | **never** |
| F31 | Environmental envelope satisfied over the projected mission window using forecast conditions | I | DENY | **never** |

**Monitoring invariants** (§26, checked independently of the code that maintains them):

- I8 — checked; Tier 0 — Safety core
- I17 — checked; Tier 0 — Safety core

### H4 — A command authorised under a superseded authority is applied by an agent

A command issued by a coordinator that has since lost the shard, or for a commitment that has since been withdrawn, reaching an agent that applies it. The two fencing scopes exist for this: a mission command is compared per commitment id, an agent command against the authority epoch, and a stand-down raises a floor above every fence the agent has seen. Comparing a mission command against a per-agent maximum is the specific error that strands a second commitment.

**Specification:** §10.3.1, §11.5, §23.3
**Severity:** CATASTROPHIC

**Mitigating constraints** (class and policy read from the §7.5 register):

| Predicate | Name | Class | Policy | Waivable (§23.6) |
|---|---|---|---|---|
| F13 | Live session exists and heartbeat is within connectivity.max_heartbeat_age | I | DENY | **never** |
| F14 | Command path proven: a recent command round-trip or heartbeat ACK succeeded | I | DENY | **never** |

**Monitoring invariants** (§26, checked independently of the code that maintains them):

- I6 — checked; Tier 1 — Operational integrity
- I12 — checked; Tier 0 — Safety core
- I21 — checked; Tier 0 — Safety core

### H5 — Custody of goods is lost — held by nobody, recorded against no one

Goods aboard an agent whose mission was cancelled, reassigned or failed without the custody being discharged. §4.6 rule 2 routes a custodial cancellation through ABORTING rather than to CANCELLED for exactly this reason, and §24.2 requires every HELD to reach RELEASED or DISPUTED — a dispute being an outcome, not a loss.

**Specification:** §2.5, §15.6, §24.2
**Severity:** SEVERE

**Mitigating constraints** (class and policy read from the §7.5 register):

| Predicate | Name | Class | Policy | Waivable (§23.6) |
|---|---|---|---|---|
| F26 | Hazmat, security, and segregation rules satisfied for the combined load | R | DENY | **never** |
| F38 | Plan validity: a complete, executable plan exists with all stops sequenced within their time windows | F | DENY | **never** |

**Monitoring invariants** (§26, checked independently of the code that maintains them):

- I3 — checked; Tier 1 — Operational integrity
- I7 — checked; Tier 0 — Safety core

### H6 — A payload is carried by an agent that cannot safely carry it

Mass beyond the rated capacity after the safety factor, a packing that does not fit, a centre of gravity outside the envelope, or a thermal or hazmat class the compartment does not cover. Each is checked at every point in the plan rather than at the start, because a plan that is feasible when empty and infeasible when loaded is infeasible.

**Specification:** §2.3, §15.3
**Severity:** SEVERE

**Mitigating constraints** (class and policy read from the §7.5 register):

| Predicate | Name | Class | Policy | Waivable (§23.6) |
|---|---|---|---|---|
| F21 | RequirementSet(m) subset of CapabilityBundle(a) under the typed algebra of §2.3 | I | DENY | **never** |
| F22 | Total payload mass <= rated capacity x payload.safety_factor at every point in the plan | I | DENY | **never** |
| F23 | Dimensional and volumetric packing feasible | I | DENY | **never** |
| F24 | Centre-of-gravity envelope satisfied for every loading state | I | DENY | **never** |
| F25 | Thermal class of an assigned compartment covers the payload's required range for the projected duration | R | DENY | **never** |
| F26 | Hazmat, security, and segregation rules satisfied for the combined load | R | DENY | **never** |

**Monitoring invariants** (§26, checked independently of the code that maintains them):

- I11 — checked; Tier 1 — Operational integrity
- I15 — checked; Tier 1 — Operational integrity

### H7 — A mission is assigned to an agent that is not commandable, or whose state is stale

An agent whose session has lapsed, whose command path has not been proven by a recent round trip, or whose safety-relevant observations are older than their freshness budget. §4.1 rule 3 forbids inferring state from the absence of data: an agent that has not been heard from is not an agent that is fine.

**Specification:** §7.5, §2.7
**Severity:** SEVERE

**Mitigating constraints** (class and policy read from the §7.5 register):

| Predicate | Name | Class | Policy | Waivable (§23.6) |
|---|---|---|---|---|
| F13 | Live session exists and heartbeat is within connectivity.max_heartbeat_age | I | DENY | **never** |
| F14 | Command path proven: a recent command round-trip or heartbeat ACK succeeded | I | DENY | **never** |
| F15 | Link quality sufficient for the mission's supervision requirement | P | ADMIT_WITH_PENALTY | yes |
| F16 | Observation freshness within the budget for every safety-relevant input | I | DENY | **never** |

**Monitoring invariants** (§26, checked independently of the code that maintains them):

- I2 — checked; Tier 0 — Safety core
- I22 — checked; Tier 0 — Safety core

### H8 — A blocking fault, e-stop or failed calibration is overridden and the agent is dispatched anyway

The hazard that override discipline exists to prevent. Class I, R and F constraints are never waivable by anyone under any role, the refusal is issued before the requester's identity is consulted, and a CHECK at the database refuses a granted waiver for those classes even if the application logic were bypassed entirely.

**Specification:** §7.2, §23.6
**Severity:** CATASTROPHIC

**Mitigating constraints** (class and policy read from the §7.5 register):

| Predicate | Name | Class | Policy | Waivable (§23.6) |
|---|---|---|---|---|
| F7 | Emergency stop not engaged | I | DENY | **never** |
| F8 | No active fault of severity >= blocking | I | DENY | **never** |
| F6 | Calibration and certification valid at projected mission end | R | DENY | **never** |
| F12 | No safety-relevant recall or advisory outstanding against this agent class | R | DENY | **never** |
| F5 | Software/firmware version is in the supported set for this mission type | I | DENY | **never** |

**Monitoring invariants** (§26, checked independently of the code that maintains them):

- I4 — checked; Tier 0 — Safety core
- I14 — checked; Tier 1 — Operational integrity

### H9 — An agent acts on a position it cannot corroborate

Localisation confidence is checked against a threshold and corroborated independently of the localisation stack, because a stack that is confidently wrong reports high confidence. §23.5's asymmetry applies: self-reported health may restrict eligibility and may never expand it.

**Specification:** §7.5, §23.5
**Severity:** SEVERE

**Mitigating constraints** (class and policy read from the §7.5 register):

| Predicate | Name | Class | Policy | Waivable (§23.6) |
|---|---|---|---|---|
| F10 | Localisation confidence >= threshold, corroborated independently of the localisation stack | I | DENY | **never** |

**Monitoring invariants** (§26, checked independently of the code that maintains them):

- I17 — checked; Tier 0 — Safety core

### H10 — A Leg stops progressing and no component notices

The baseline's characteristic failure, and the one §12 is written against: 'no component is responsible for noticing that a state has stopped progressing. Patching each trigger individually leaves the seventh undiscovered.' The reconciler is the trigger-independent answer; every non-terminal state carries a durable timer, and every repair is rate-counted so a rising repair rate is visible as a defect rather than absorbed as normal.

**Specification:** §12.1, §12.4
**Severity:** SEVERE

**Mitigating constraints** (class and policy read from the §7.5 register):

| Predicate | Name | Class | Policy | Waivable (§23.6) |
|---|---|---|---|---|
| F19 | Projected availability time <= mission's latest feasible start | F | DENY | **never** |
| F37 | Deadline feasibility: earliest feasible completion <= hard deadline | C | DENY | yes |

**Monitoring invariants** (§26, checked independently of the code that maintains them):

- I10 — checked; Tier 1 — Operational integrity
- I20 — checked; Tier 2 — Allocation quality

### H11 — A commitment is lost, duplicated or double-granted when the cache tier fails

The mandatory test of §3.3, and the hazard behind the cache-authority rule: no decision may depend on a cache read that cannot be re-derived from the store, and cache unavailability must not halt commitment. The commit path holds no cache client at all, which is the strongest available form of the mitigation — not 'the cache was not consulted' but 'there is nothing to consult'.

**Specification:** §3.3, §24.5
**Severity:** CATASTROPHIC

**Mitigating constraints** (class and policy read from the §7.5 register):

| Predicate | Name | Class | Policy | Waivable (§23.6) |
|---|---|---|---|---|
| F17 | The candidate plan holds no more than capacity[agent_class] concurrent commitments and extends no further than plan.commitment_horizon | I | DENY | **never** |
| F18 | No conflicting reservation held by another subsystem | I | DENY | **never** |

**Monitoring invariants** (§26, checked independently of the code that maintains them):

- I16 — checked; Tier 0 — Safety core
- I18 — checked; Tier 0 — Safety core

### H12 — The engine is taken live on a shard before its verification evidence exists

The hazard this phase itself creates. Tier 0 is indivisible, so the cutover switches the whole decision path at once per shard; a shard taken live while a §24 gate is red, or while a Safety-class parameter is still PROVISIONAL, is a fleet running on evidence nobody produced. The mitigation is mechanical rather than procedural: `cutover/stage.authoriseEnable` refuses while any blocking gate is not GREEN, refuses without a second approver, refuses an automated request outright, and refuses a shard whose SLI guardrails were not declared beforehand.

**Specification:** execution plan Phase 15, §1.8, §22.4
**Severity:** CATASTROPHIC

**Mitigating constraints** (class and policy read from the §7.5 register):

| Predicate | Name | Class | Policy | Waivable (§23.6) |
|---|---|---|---|---|
| F1 | Agent exists and is commissioned | I | DENY | **never** |
| F2 | Lifecycle state is active | P | DENY | yes |
| F3 | Not under operator hold or quarantine | P | DENY | yes |

**Monitoring invariants** (§26, checked independently of the code that maintains them):

- I1 — checked; Tier 0 — Safety core
- I2 — checked; Tier 0 — Safety core
- I5 — checked; Tier 0 — Safety core

## Verification evidence — the §24 release gates

| Status | Gate | Evidence kind | Section |
|---|---|---|---|
| NOT_EVALUATED | tier_dependencies | BUILD | §1.8 |
| NOT_EVALUATED | parameter_register | BUILD | §22.1 |
| NOT_EVALUATED | design_tenets | BUILD | §1.5 |
| NOT_EVALUATED | identity_isolation | BUILD | §23.7 |
| NOT_EVALUATED | erasure_reconstruction_equivalence | BUILD | §23.7, §24.3 |
| NOT_EVALUATED | calibration_safety_derived | ORGANISATIONAL | §22.4 |
| NOT_EVALUATED | legacy_removed_from_build | BUILD | execution plan, Phase 15 |
| NOT_EVALUATED | lower_bound_admissibility | SUITE | §6.4, §24.1 |
| NOT_EVALUATED | model_check_capacity_1_2_3 | SUITE | §24.2 |
| NOT_EVALUATED | determinism_replay | SUITE | §24.3 |
| NOT_EVALUATED | snapshot_retention | SUITE | §24.3 |
| NOT_EVALUATED | chaos_capacity_1 | SUITE | §24.5 |
| NOT_EVALUATED | chaos_capacity_2 | SUITE | §24.5 |
| NOT_EVALUATED | cache_tier_flush | SUITE | §3.3, §24.5, I16 |
| NOT_EVALUATED | scale_targets | SUITE | §20.1, §24.6 |
| NOT_EVALUATED | locality | SUITE | §24.6, T9 |
| NOT_EVALUATED | overload_admission_control | SUITE | §20.5, §24.6 |
| NOT_EVALUATED | invariants_enforced | PRODUCTION | §26 |
| NOT_EVALUATED | simulator_fidelity | PRODUCTION | §24.4 |
| NOT_EVALUATED | soak | PRODUCTION | §24.6 |
| NOT_EVALUATED | shadow_agreement | PRODUCTION | §21.6 |
| NOT_EVALUATED | safety_case_assembled | ORGANISATIONAL | §24.7 |
| NOT_EVALUATED | rollback_rehearsed | ORGANISATIONAL | execution plan, Phase 15 |

**0 green, 0 red, 23 not evaluated.** `NOT_EVALUATED` blocks the cutover exactly as `RED` does; the two are distinct so that "we ran it and it failed" and "nobody ran it" cannot be confused during an incident review.


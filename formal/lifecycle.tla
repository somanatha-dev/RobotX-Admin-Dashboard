-------------------------------- MODULE lifecycle --------------------------------
(***************************************************************************)
(* The RobotX Task and Leg lifecycle.                                       *)
(*                                                                          *)
(* Normative source: NEXT_GENERATION_ASSIGNMENT_ENGINE.md (FROZEN)          *)
(*   Sec 4.2   Task state machine                                           *)
(*   Sec 4.3   Leg state machine, including the two STRANDED states         *)
(*   Sec 4.4   the complete transition table and its guards                 *)
(*   Sec 4.5   supervision: durable timers                                  *)
(*   Sec 2.5   custody                                                      *)
(*   Sec 12.4  the reconciliation loop                                      *)
(*   Sec 24.2  the properties model-checked here                            *)
(*   Sec 26    invariants I3, I4, I7, I8, I9, I13, I17                      *)
(*                                                                          *)
(* Delivered by:  IMPLEMENTATION_EXECUTION_PLAN.md, Phase 15 checklist item *)
(*   "Complete formal/commitment.tla and formal/lifecycle.tla; all Sec 24.2 *)
(*    safety and liveness properties checked"                               *)
(*                                                                          *)
(* ------------------------------------------------------------------------ *)
(* WHAT THIS MODULE IS, AND WHAT ELSE DISCHARGES THE SAME GATE              *)
(*                                                                          *)
(* Sec 24.2 requires the lifecycle to be checked with "TLA+ or an equivalent *)
(* model checker". This module is the TLA+ form. As with commitment.tla, it  *)
(* has NOT been executed under TLC in the implementation environment, which  *)
(* has no Java toolchain; that is recorded in                                *)
(* PHASE_15_IMPLEMENTATION_REPORT.md rather than claimed as verified.        *)
(*                                                                          *)
(* The equivalent checker that HAS been executed is                          *)
(* Backend/tests/engine/helpers/lifecycleModel.js, driven by                 *)
(* Backend/tests/engine/lifecycleModelCheck.test.js. It explores the same     *)
(* actions and checks the same properties exhaustively, and it has one        *)
(* property this module cannot have: its transitions call the shipped        *)
(* implementation modules -- lifecycle/transitions.js, legMachine.js,        *)
(* taskMachine.js -- rather than a transcription of them.                    *)
(*                                                                          *)
(* The two are intended to stay in step. An action added here without a       *)
(* matching action there, or vice versa, is a defect in whichever was not     *)
(* updated.                                                                  *)
(*                                                                          *)
(* ------------------------------------------------------------------------ *)
(* WHY THE LIFECYCLE IS MODEL-CHECKED AT ALL                                *)
(*                                                                          *)
(* Sec 24.2 justifies model-checking exclusivity because "this is the        *)
(* property whose violation can put two commitments on one physical machine".*)
(* The lifecycle earns its own check for a different reason: Sec 4.1 rule 1  *)
(* states that "no state is both terminal and modifiable", and Sec 12.1      *)
(* states that the baseline's characteristic failure is a state that stops   *)
(* progressing with nobody responsible for noticing. Both are properties of  *)
(* the transition relation as a whole, not of any single transition, and a   *)
(* transition table is exactly the artefact where an exhaustive search finds *)
(* what review does not: the one event that is enabled in the one state      *)
(* where nobody expected it.                                                 *)
(***************************************************************************)

EXTENDS Integers, FiniteSets, Sequences, TLC

CONSTANTS
    Legs,          \* the set of Leg identifiers belonging to the Task under check
    Capacity,      \* capacity[agent_class]; checked at 1, 2 and 3
    MaxTicks       \* bound on timer firings, to keep the space finite

ASSUME Capacity \in 1..3
ASSUME MaxTicks \in Nat

(***************************************************************************)
(* Sec 4.3 -- the Leg states, complete.                                     *)
(***************************************************************************)
LegStates ==
    { "QUEUED", "DEFERRED", "PLANNED", "OFFERED", "ACCEPTED",
      "EN_ROUTE_PICKUP", "AT_PICKUP", "LOADED", "EN_ROUTE_DROP", "AT_DROP",
      "RELEASED", "SETTLED", "ABORTING", "STRANDED_SAFE", "STRANDED_OBSTRUCTING",
      "REASSIGNING", "WITHDRAWN", "CANCELLED", "FAILED" }

TerminalLegStates == { "SETTLED", "WITHDRAWN", "CANCELLED", "FAILED" }

(***************************************************************************)
(* Sec 4.3 -- the states in which the agent is physically TRANSPORTING the  *)
(* goods along the nominal path. Custody is HELD from LOADED until          *)
(* RELEASED (Sec 2.5).                                                      *)
(*                                                                          *)
(* This set is a GUARD, not a classification: `Dispute` and `TimerFires`    *)
(* use it to decide which Legs may be disputed and which a timer may drive  *)
(* into ABORTING. It is deliberately NOT the set of states in which custody *)
(* may lawfully be HELD -- see CustodyLawfulStates below.                   *)
(***************************************************************************)
CustodyBearingStates == { "LOADED", "EN_ROUTE_DROP", "AT_DROP" }

(***************************************************************************)
(* Sec 4.3 -- the two stranding states.                                     *)
(***************************************************************************)
StrandedLegStates == { "STRANDED_SAFE", "STRANDED_OBSTRUCTING" }

(***************************************************************************)
(* Sec 2.5 / Sec 4.4 -- the states in which custody = HELD is LAWFUL.       *)
(*                                                                          *)
(* Decision X4, recorded 2026-08-31 by the sole project owner/reviewer      *)
(* acting as the project's specification and verification authority:        *)
(* STRANDED_SAFE and STRANDED_OBSTRUCTING are custody-bearing, so a         *)
(* stranded Leg may lawfully still be holding the goods. See                *)
(* docs/phase15/PHASE_15_BLOCKERS.md (X4) for the decision and its basis.   *)
(*                                                                          *)
(* This is what the FROZEN specification already says, and the invariant    *)
(* below was an unfaithful transcription of it:                             *)
(*                                                                          *)
(*   - Sec 4.4 gives EN_ROUTE_DROP -> STRANDED_SAFE / STRANDED_OBSTRUCTING  *)
(*     under the explicit guard "custody HELD", so the specification's own  *)
(*     transition table enters a stranded state CARRYING the goods.         *)
(*   - Sec 4.4's lease-expiry row selects between REASSIGNING and the two   *)
(*     STRANDED_* states "by custody state".                                *)
(*   - Sec 4.4's recovery row terminates a stranded Leg only once "custody  *)
(*     accounted for (Sec 4.9)", noting "Leg terminates only once custody   *)
(*     is discharged (I7, I8)" -- an obligation that is vacuous unless a    *)
(*     stranded Leg can hold custody in the first place.                    *)
(*   - Sec 4.3 describes stranding as "an agent with goods aboard,          *)
(*     immobilised, out of communication".                                  *)
(*   - Sec 18.6 step 1 pages the responder with a "custody manifest".       *)
(*                                                                          *)
(* ABORTING was already permitted, and remains so for the same reason:      *)
(* Sec 4.6 routes a custodial cancellation through it precisely SO THAT the *)
(* goods stay accounted for.                                                *)
(*                                                                          *)
(* The executable equivalent, Backend/tests/engine/helpers/lifecycleModel.js *)
(* CUSTODY_BEARING, has listed both STRANDED_* states since Phase 15 and    *)
(* found them by counterexample. Until this change the two checkers         *)
(* contradicted each other, and per formal/README.md the defect was in      *)
(* whichever was not updated -- this module.                                *)
(*                                                                          *)
(* KNOWN REMAINING DIVERGENCE, recorded rather than closed: lifecycleModel  *)
(* also lists REASSIGNING, for Sec 12.2's lease-expiry route that keeps a   *)
(* LOADED Leg reassignable. This module does not model that route at all    *)
(* -- `Reassign` requires custody = "NONE" -- so REASSIGNING is deliberately *)
(* NOT included here: widening the invariant to admit a state the           *)
(* transition relation cannot reach would weaken it for no coverage. The    *)
(* missing route is a COVERAGE gap in this module, separate from X4.        *)
(***************************************************************************)
CustodyLawfulStates ==
    CustodyBearingStates \cup { "ABORTING" } \cup StrandedLegStates

(***************************************************************************)
(* Sec 4.2 -- the Task states.                                             *)
(***************************************************************************)
TaskStates ==
    { "RECEIVED", "REJECTED", "PLANNABLE", "WAITING", "IN_EXECUTION",
      "AT_RISK", "SUSPENDED", "VERIFYING", "COMPLETED", "CANCELLED", "FAILED" }

TerminalTaskStates == { "REJECTED", "COMPLETED", "CANCELLED", "FAILED" }

(***************************************************************************)
(* Sec 2.5 -- custody states. DISPUTED is reachable and is NOT terminal for *)
(* the custody chain: Sec 24.2 requires every HELD to reach RELEASED or     *)
(* DISPUTED, which is a weaker obligation than reaching RELEASED, and the   *)
(* difference is deliberate -- a dispute is an outcome, not a loss.         *)
(***************************************************************************)
CustodyStates == { "NONE", "HELD", "RELEASED", "DISPUTED" }

(***************************************************************************)
(* Sec 4.3 -- the obstruction class of a stopping location (Sec 4.3 table). *)
(* INDETERMINATE is included because Sec 7.3's DENY semantics make its      *)
(* resolution a checkable property rather than a documented intention.      *)
(***************************************************************************)
ObstructionClasses == { "CLEAR", "RESTRICTIVE", "BLOCKING_CRITICAL", "INDETERMINATE" }

(***************************************************************************)
(* Sec 17.4 -- the escalation ladder has exactly eight rungs.               *)
(*                                                                          *)
(* This is a DEFINITION rather than a CONSTANT because Sec 17.4 fixes the   *)
(* number: its table enumerates rungs 1 to 8, and the shipped               *)
(* Backend/src/engine/fairness/ladder.js `STEPS` carries the same eight     *)
(* rows verbatim. It is not a tunable bound, no .cfg supplies it, and that  *)
(* also keeps the three checked-in configurations byte-identical to the     *)
(* ones the X4 and X5 runs used.                                            *)
(*                                                                          *)
(* It is NOT a "boundedness constant" in the sense MaxTicks is. MaxTicks    *)
(* exists to make an otherwise unbounded action finite. The ladder is       *)
(* finite in the SPECIFICATION -- "It is finite, it advances on elapsed SLA *)
(* budget regardless of cost dynamics, and it terminates in a decision" --  *)
(* so this transcribes a stated property rather than imposing an artificial *)
(* one. That is also why the ladder rungs do NOT consume `ticks`: `ticks`   *)
(* bounds timer firings that have no intrinsic bound, and Sec 17.4's own    *)
(* rung count already bounds these.                                         *)
(***************************************************************************)
LadderSteps == 8

VARIABLES
    legState,        \* [Legs -> LegStates]
    custody,         \* [Legs -> CustodyStates]
    hardCommitted,   \* [Legs -> BOOLEAN]  TRUE once the agent has ACKed
    taskState,       \* the Task's state (Sec 4.2)
    ticks,           \* how many timer firings have occurred; bounds the search
    everHeld,        \* [Legs -> BOOLEAN]  custody was HELD at some point
    ladder           \* [Legs -> 0..LadderSteps]  the Sec 17.4 rung this Leg has reached

vars == << legState, custody, hardCommitted, taskState, ticks, everHeld, ladder >>

(***************************************************************************)
(* Sec 4.3 -- the obstruction class resolves to a stranding state.          *)
(* Sec 7.3 policy DENY: INDETERMINATE resolves to the MORE serious case,    *)
(* "because the cost of over-escalating a safe stranding is an unnecessary  *)
(* callout and the cost of under-escalating an obstructing one is an        *)
(* incident."                                                               *)
(***************************************************************************)
StrandingStateFor(class) ==
    IF class \in { "BLOCKING_CRITICAL", "INDETERMINATE" }
    THEN "STRANDED_OBSTRUCTING"
    ELSE "STRANDED_SAFE"

Init ==
    /\ legState = [ l \in Legs |-> "QUEUED" ]
    /\ custody = [ l \in Legs |-> "NONE" ]
    /\ hardCommitted = [ l \in Legs |-> FALSE ]
    /\ everHeld = [ l \in Legs |-> FALSE ]
    /\ ladder = [ l \in Legs |-> 0 ]
    /\ taskState = "WAITING"
    /\ ticks = 0

(***************************************************************************)
(* How many Legs currently hold a HARD commitment. Sec 10.1: at most        *)
(* `capacity` per agent. The model places all Legs on one agent, which is   *)
(* the configuration in which the bound is expressible.                     *)
(***************************************************************************)
HardCount == Cardinality({ l \in Legs : hardCommitted[l] })

(***************************************************************************)
(* ACTIONS -- the Sec 4.4 transition table.                                *)
(***************************************************************************)

Plan(l) ==
    /\ legState[l] \in { "QUEUED", "DEFERRED" }
    /\ legState' = [ legState EXCEPT ![l] = "PLANNED" ]
    /\ UNCHANGED << custody, hardCommitted, taskState, ticks, everHeld, ladder >>

Defer(l) ==
    /\ legState[l] = "QUEUED"
    /\ legState' = [ legState EXCEPT ![l] = "DEFERRED" ]
    /\ UNCHANGED << custody, hardCommitted, taskState, ticks, everHeld, ladder >>

Offer(l) ==
    /\ legState[l] = "PLANNED"
    \* Sec 10.1's bound is enforced at the point the offer is made, because an
    \* offer that cannot lawfully be accepted is an offer that should not be sent.
    /\ HardCount < Capacity
    /\ legState' = [ legState EXCEPT ![l] = "OFFERED" ]
    /\ UNCHANGED << custody, hardCommitted, taskState, ticks, everHeld, ladder >>

Accept(l) ==
    /\ legState[l] = "OFFERED"
    /\ HardCount < Capacity
    /\ legState' = [ legState EXCEPT ![l] = "ACCEPTED" ]
    /\ hardCommitted' = [ hardCommitted EXCEPT ![l] = TRUE ]
    /\ taskState' = "IN_EXECUTION"
    /\ UNCHANGED << custody, ticks, everHeld, ladder >>

(***************************************************************************)
(* Sec 11.2 -- the agent may refuse. The offer is withdrawn, the agent is   *)
(* excluded, and the Leg is re-planned. WITHDRAWN is terminal "for that      *)
(* pairing", not for the Leg, which is why this returns to QUEUED.          *)
(***************************************************************************)
Reject(l) ==
    /\ legState[l] = "OFFERED"
    /\ legState' = [ legState EXCEPT ![l] = "QUEUED" ]
    /\ UNCHANGED << custody, hardCommitted, taskState, ticks, everHeld, ladder >>

(***************************************************************************)
(* Sec 4.4 -- the two `QUEUED` assignment-deadline rows, and Sec 4.3's      *)
(* `QUEUED` row whose on-expiry action is "escalation ladder (Sec 17.4)".   *)
(*                                                                          *)
(* Blocker X6. Until this change the module transcribed NEITHER row, and    *)
(* `TimerFires` had no `QUEUED` case at all -- so the one state whose exit  *)
(* IS the anti-starvation guarantee was the one state with no supervised    *)
(* exit. Verbatim from Sec 4.4:                                             *)
(*                                                                          *)
(*   | `QUEUED` | assignment deadline | `QUEUED` | ladder step available |  *)
(*   |          |                     |          | relaxation applied and  *)
(*   |          |                     |          | recorded (Sec 17.4)     *)
(*   | `QUEUED` | ladder exhausted    | `FAILED` | -- | task `FAILED`,      *)
(*   |          |                     |          | operator notification   *)
(*                                                                          *)
(* The guard "ladder step available" is `ladder[l] < LadderSteps`, and the  *)
(* event "ladder exhausted" is `ladder[l] = LadderSteps`. In the shipped    *)
(* system those are the two verdicts of fairness/ladder.js -- STEP_AVAILABLE *)
(* and EXHAUSTED -- read by supervision/expiryActions.js escalationLadder,  *)
(* and applied through lifecycle/transitions.js's ASSIGNMENT_DEADLINE and   *)
(* LADDER_EXHAUSTED rows.                                                   *)
(*                                                                          *)
(* WHY THE RUNG NEVER RESETS -- this is the whole guarantee. Sec 17.4 makes *)
(* the rung a function of elapsed SLA budget, and the shipped ladder reads  *)
(* that budget from the queue row's `enqueuedAt`, which in ladder.js's own  *)
(* words "survives a Leg leaving and re-entering `QUEUED` (a NACK, a failed *)
(* hardening) ... a queue age that resets on every requeue is a starvation  *)
(* clock that starvation resets". So `ladder` is monotone for the lifetime  *)
(* of the Leg and NO transition into `QUEUED` clears it. That monotonicity  *)
(* is what makes the re-plan cycle finite.                                  *)
(*                                                                          *)
(* WHAT IS DELIBERATELY NOT MODELLED HERE. Sec 4.4's side-effect column for *)
(* the second row reads "task `FAILED`, operator notification", and this    *)
(* action leaves `taskState` UNCHANGED. Resolving the Task's own state when *)
(* its Legs end other than by settlement is Sec 4.2 territory, Sec 4.2 has  *)
(* no transition table, and that is blocker X3 -- untouched here for the    *)
(* same reason `TaskQuiescent` (X5) does not touch `taskState` either.      *)
(* Modelling it would need a rule for the case where one Leg fails the      *)
(* ladder and a sibling later settles, and no such rule is specified.       *)
(***************************************************************************)
LadderAdvance(l) ==
    /\ legState[l] = "QUEUED"
    /\ ladder[l] < LadderSteps
    /\ ladder' = [ ladder EXCEPT ![l] = ladder[l] + 1 ]
    /\ UNCHANGED << legState, custody, hardCommitted, taskState, ticks, everHeld >>

LadderExhausted(l) ==
    /\ legState[l] = "QUEUED"
    /\ ladder[l] = LadderSteps
    /\ legState' = [ legState EXCEPT ![l] = "FAILED" ]
    /\ UNCHANGED << custody, hardCommitted, taskState, ticks, everHeld, ladder >>

Depart(l) ==
    /\ legState[l] = "ACCEPTED"
    /\ legState' = [ legState EXCEPT ![l] = "EN_ROUTE_PICKUP" ]
    /\ UNCHANGED << custody, hardCommitted, taskState, ticks, everHeld, ladder >>

ArrivePickup(l) ==
    /\ legState[l] = "EN_ROUTE_PICKUP"
    /\ legState' = [ legState EXCEPT ![l] = "AT_PICKUP" ]
    /\ UNCHANGED << custody, hardCommitted, taskState, ticks, everHeld, ladder >>

Load(l) ==
    /\ legState[l] = "AT_PICKUP"
    /\ legState' = [ legState EXCEPT ![l] = "LOADED" ]
    /\ custody' = [ custody EXCEPT ![l] = "HELD" ]
    /\ everHeld' = [ everHeld EXCEPT ![l] = TRUE ]
    /\ UNCHANGED << hardCommitted, taskState, ticks, ladder >>

DepartDrop(l) ==
    /\ legState[l] = "LOADED"
    /\ legState' = [ legState EXCEPT ![l] = "EN_ROUTE_DROP" ]
    /\ UNCHANGED << custody, hardCommitted, taskState, ticks, everHeld, ladder >>

ArriveDrop(l) ==
    /\ legState[l] = "EN_ROUTE_DROP"
    /\ legState' = [ legState EXCEPT ![l] = "AT_DROP" ]
    /\ UNCHANGED << custody, hardCommitted, taskState, ticks, everHeld, ladder >>

Release(l) ==
    /\ legState[l] = "AT_DROP"
    /\ legState' = [ legState EXCEPT ![l] = "RELEASED" ]
    /\ custody' = [ custody EXCEPT ![l] = "RELEASED" ]
    /\ taskState' = "VERIFYING"
    /\ UNCHANGED << hardCommitted, ticks, everHeld, ladder >>

(***************************************************************************)
(* Sec 15.6 -- custody may end in dispute rather than in release. Sec 24.2  *)
(* asks only that every HELD reaches RELEASED or DISPUTED.                  *)
(***************************************************************************)
Dispute(l) ==
    /\ custody[l] = "HELD"
    /\ legState[l] \in CustodyBearingStates
    /\ custody' = [ custody EXCEPT ![l] = "DISPUTED" ]
    /\ legState' = [ legState EXCEPT ![l] = "ABORTING" ]
    /\ UNCHANGED << hardCommitted, taskState, ticks, everHeld, ladder >>

(***************************************************************************)
(* Sec 12.5 -- settlement releases the commitment. This is the ONLY action  *)
(* that clears hardCommitted along the nominal path, which is what makes    *)
(* Sec 10.1's bound a statement about concurrent commitments rather than    *)
(* about lifetime totals.                                                   *)
(***************************************************************************)
Settle(l) ==
    /\ legState[l] = "RELEASED"
    /\ custody[l] \in { "RELEASED", "DISPUTED" }
    /\ legState' = [ legState EXCEPT ![l] = "SETTLED" ]
    /\ hardCommitted' = [ hardCommitted EXCEPT ![l] = FALSE ]
    /\ taskState' = IF \A m \in Legs : (m = l \/ legState[m] \in TerminalLegStates)
                    THEN "COMPLETED"
                    ELSE taskState
    /\ UNCHANGED << custody, ticks, everHeld, ladder >>

(***************************************************************************)
(* Sec 4.7 -- reassignment. The commitment is released BEFORE the Leg       *)
(* returns to QUEUED, which is the ordering that stops a reassigned Leg     *)
(* consuming a capacity slot on an agent that is no longer executing it.    *)
(***************************************************************************)
Reassign(l) ==
    /\ legState[l] \in { "ACCEPTED", "EN_ROUTE_PICKUP", "AT_PICKUP" }
    /\ custody[l] = "NONE"
    /\ legState' = [ legState EXCEPT ![l] = "REASSIGNING" ]
    /\ hardCommitted' = [ hardCommitted EXCEPT ![l] = FALSE ]
    /\ UNCHANGED << custody, taskState, ticks, everHeld, ladder >>

ReassignComplete(l) ==
    /\ legState[l] = "REASSIGNING"
    /\ legState' = [ legState EXCEPT ![l] = "QUEUED" ]
    /\ UNCHANGED << custody, hardCommitted, taskState, ticks, everHeld, ladder >>

(***************************************************************************)
(* Sec 4.6 -- cancellation. Sec 4.1 rule 4: a Leg carrying custody may NOT  *)
(* be cancelled outright; it goes through ABORTING so that the goods are     *)
(* accounted for. This guard is the whole reason cancellation is two        *)
(* actions rather than one.                                                 *)
(***************************************************************************)
Cancel(l) ==
    /\ legState[l] \notin TerminalLegStates
    /\ custody[l] # "HELD"
    /\ legState' = [ legState EXCEPT ![l] = "CANCELLED" ]
    /\ hardCommitted' = [ hardCommitted EXCEPT ![l] = FALSE ]
    /\ UNCHANGED << custody, taskState, ticks, everHeld, ladder >>

CancelWithCustody(l) ==
    /\ legState[l] \notin TerminalLegStates
    /\ custody[l] = "HELD"
    /\ legState' = [ legState EXCEPT ![l] = "ABORTING" ]
    /\ UNCHANGED << custody, hardCommitted, taskState, ticks, everHeld, ladder >>

(***************************************************************************)
(* Sec 18 -- recovery. ABORTING either resolves the custody and fails the   *)
(* Leg, or exhausts its budget and forces the applicable STRANDED state.    *)
(***************************************************************************)
AbortResolved(l) ==
    /\ legState[l] = "ABORTING"
    /\ custody' = [ custody EXCEPT ![l] = IF custody[l] = "HELD" THEN "RELEASED" ELSE custody[l] ]
    /\ legState' = [ legState EXCEPT ![l] = "FAILED" ]
    /\ hardCommitted' = [ hardCommitted EXCEPT ![l] = FALSE ]
    /\ UNCHANGED << taskState, ticks, everHeld, ladder >>

Strand(l, class) ==
    /\ legState[l] = "ABORTING"
    /\ class \in ObstructionClasses
    /\ legState' = [ legState EXCEPT ![l] = StrandingStateFor(class) ]
    /\ UNCHANGED << custody, hardCommitted, taskState, ticks, everHeld, ladder >>

(***************************************************************************)
(* Sec 18.6 -- a stranding is resolved by physical intervention. The Leg     *)
(* leaves the stranded state; custody, if held, is accounted for.           *)
(***************************************************************************)
Recovered(l) ==
    /\ legState[l] \in { "STRANDED_SAFE", "STRANDED_OBSTRUCTING" }
    /\ custody' = [ custody EXCEPT ![l] = IF custody[l] = "HELD" THEN "RELEASED" ELSE custody[l] ]
    /\ legState' = [ legState EXCEPT ![l] = "FAILED" ]
    /\ hardCommitted' = [ hardCommitted EXCEPT ![l] = FALSE ]
    /\ UNCHANGED << taskState, ticks, everHeld, ladder >>

(***************************************************************************)
(* Sec 4.5 -- a durable timer fires. Sec 12.1: something must be            *)
(* responsible for noticing that a state has stopped progressing, and this  *)
(* is that something. Every non-terminal state with a deadline has an       *)
(* on-expiry transition in the Sec 4.3 table; the model fires the ones that *)
(* change the state.                                                        *)
(***************************************************************************)
TimerFires(l) ==
    /\ ticks < MaxTicks
    /\ legState[l] \notin TerminalLegStates
    /\ ticks' = ticks + 1
    /\ \/ /\ legState[l] = "OFFERED"          \* dispatch.offer_ttl -> withdraw, exclude, re-plan
          /\ legState' = [ legState EXCEPT ![l] = "QUEUED" ]
          /\ UNCHANGED << custody, hardCommitted, taskState, everHeld, ladder >>
       \/ /\ legState[l] = "PLANNED"          \* commit.hardening_deadline -> re-plan
          /\ legState' = [ legState EXCEPT ![l] = "QUEUED" ]
          /\ UNCHANGED << custody, hardCommitted, taskState, everHeld, ladder >>
       \/ /\ legState[l] = "DEFERRED"         \* assign.max_deferral_time -> force widen
          /\ legState' = [ legState EXCEPT ![l] = "QUEUED" ]
          /\ UNCHANGED << custody, hardCommitted, taskState, everHeld, ladder >>
       \/ /\ legState[l] \in { "ACCEPTED", "EN_ROUTE_PICKUP", "AT_PICKUP" }
          /\ custody[l] = "NONE"              \* execute.start_grace -> probe, then reassign
          /\ legState' = [ legState EXCEPT ![l] = "REASSIGNING" ]
          /\ hardCommitted' = [ hardCommitted EXCEPT ![l] = FALSE ]
          /\ UNCHANGED << custody, taskState, everHeld, ladder >>
       \/ /\ legState[l] \in CustodyBearingStates
          /\ legState' = [ legState EXCEPT ![l] = "ABORTING" ]
          /\ UNCHANGED << custody, hardCommitted, taskState, everHeld, ladder >>
       \/ /\ legState[l] = "RELEASED"         \* verify.evidence_deadline -> escalate
          /\ legState' = [ legState EXCEPT ![l] = "SETTLED" ]
          /\ hardCommitted' = [ hardCommitted EXCEPT ![l] = FALSE ]
          /\ UNCHANGED << custody, taskState, everHeld, ladder >>
       \/ /\ legState[l] = "ABORTING"         \* recover.abort_budget -> force STRANDED
          /\ legState' = [ legState EXCEPT ![l] = "STRANDED_OBSTRUCTING" ]
          /\ UNCHANGED << custody, hardCommitted, taskState, everHeld, ladder >>
       \/ /\ legState[l] = "REASSIGNING"      \* recover.reassign_budget -> escalate
          /\ legState' = [ legState EXCEPT ![l] = "QUEUED" ]
          /\ UNCHANGED << custody, hardCommitted, taskState, everHeld, ladder >>
       \/ /\ legState[l] \in { "STRANDED_SAFE", "STRANDED_OBSTRUCTING" }
          /\ UNCHANGED << legState, custody, hardCommitted, taskState, everHeld, ladder >>

(***************************************************************************)
(* TERMINAL QUIESCENCE -- the end of a behaviour, stated explicitly.        *)
(*                                                                          *)
(* Decision X5, recorded 2026-08-31 by the sole project owner/reviewer      *)
(* acting as the project's specification and verification authority:        *)
(* terminal deadlock freedom is treated as a genuine Sec 24.2 obligation of *)
(* this model. The model is therefore changed to SATISFY TLC's deadlock     *)
(* check, NOT to switch the check off. No .cfg sets CHECK_DEADLOCK FALSE    *)
(* and none may: see docs/phase15/PHASE_15_BLOCKERS.md (X5).                *)
(*                                                                          *)
(* WHAT WENT WRONG WITHOUT IT. Every action in `Next` requires some Leg to  *)
(* be non-terminal. Once every Leg is terminal -- reachable in as few as    *)
(* two steps by cancelling each Leg in turn -- no successor state existed,  *)
(* and TLC reported "Deadlock reached" at depth 6. All three lifecycle      *)
(* configurations aborted there, so INVARIANT Safety and PROPERTY           *)
(* TerminalIsFinal, Liveness never reached a verdict at any capacity.       *)
(*                                                                          *)
(* WHY THIS IS THE SPECIFICATION-CONSISTENT REPAIR. Sec 4.1 rule 1 says "no *)
(* state is both terminal and modifiable" and Sec 24.2's liveness clause is *)
(* that "every NON-terminal state eventually leaves". Together they say a   *)
(* state in which every Leg is terminal has ENDED rather than stalled --    *)
(* TLC's default check cannot tell those two apart, and this action is what *)
(* tells it. Sec 24.2 does not enumerate deadlock freedom itself; treating  *)
(* it as an obligation of this model is the recorded X5 decision.           *)
(*                                                                          *)
(* WHY IT CANNOT HIDE A LIVENESS DEFECT. This is a stuttering step on       *)
(* `vars`, so it is NOT a <<Next>>_vars step. WF_vars(Next) is therefore    *)
(* unaffected by it: it cannot starve any enabled action, and it cannot     *)
(* discharge any liveness obligation. It is enabled ONLY when every Leg is  *)
(* already terminal, which is exactly the state Sec 4.1 rule 1 declares     *)
(* unmodifiable.                                                            *)
(*                                                                          *)
(* Note it does NOT touch taskState. Resolving the Task's own state when    *)
(* its Legs end other than by settlement is Sec 4.2 territory, and Sec 4.2  *)
(* has no transition table -- that is blocker X3, which is untouched here.  *)
(***************************************************************************)
AllLegsTerminal == \A l \in Legs : legState[l] \in TerminalLegStates

TaskQuiescent ==
    /\ AllLegsTerminal
    /\ UNCHANGED vars

Next ==
    \/ \E l \in Legs :
         \/ Plan(l) \/ Defer(l) \/ Offer(l) \/ Accept(l) \/ Reject(l)
         \/ LadderAdvance(l) \/ LadderExhausted(l)
         \/ Depart(l) \/ ArrivePickup(l) \/ Load(l) \/ DepartDrop(l) \/ ArriveDrop(l)
         \/ Release(l) \/ Dispute(l) \/ Settle(l)
         \/ Reassign(l) \/ ReassignComplete(l)
         \/ Cancel(l) \/ CancelWithCustody(l)
         \/ AbortResolved(l) \/ Recovered(l)
         \/ TimerFires(l)
    \/ \E l \in Legs, c \in ObstructionClasses : Strand(l, c)
    \/ TaskQuiescent

(***************************************************************************)
(* FAIRNESS -- Sec 24.2's own hypothesis, "given fair timer firing".        *)
(*                                                                          *)
(* Blocker X6, second half. `WF_vars(Next)` ALONE does not transcribe that  *)
(* hypothesis, and it is very nearly vacuous for liveness: weak fairness on *)
(* the whole disjunction only forbids the system stuttering while some step *)
(* is enabled. It places no obligation on any particular Leg or any         *)
(* particular timer, so one Leg may sit in `QUEUED` for ever while another  *)
(* Leg cycles -- which is exactly the counterexample TLC produced for       *)
(* `QueuedLegsProgress`, with no ladder involved in it at all.              *)
(*                                                                          *)
(* It is KEPT, because it is what stops the whole system freezing while an  *)
(* action is enabled. What is ADDED is fairness on the two ladder actions,  *)
(* per Leg. Nothing is removed and nothing is weakened.                     *)
(*                                                                          *)
(* WHY STRONG FAIRNESS AND NOT WEAK. A Leg in the re-plan cycle             *)
(* `QUEUED -> PLANNED -> OFFERED -> QUEUED` leaves `QUEUED` between rungs,  *)
(* so `LadderAdvance` is enabled infinitely often but never CONTINUOUSLY,   *)
(* and weak fairness would impose nothing on it at all. Sec 17.4 says what  *)
(* the ladder does in exactly that situation, in these words:               *)
(*                                                                          *)
(*   "It is finite, it advances on elapsed SLA budget regardless of cost    *)
(*    dynamics, and it terminates in a decision. No amount of cost          *)
(*    arithmetic can prevent it from advancing."                            *)
(*                                                                          *)
(* "Advances regardless", for an action that is repeatedly but not          *)
(* continuously enabled, is strong fairness. The shipped ladder has that    *)
(* property mechanically, because the rung is a monotone function of a      *)
(* queue age that no requeue resets.                                        *)
(*                                                                          *)
(* THIS IS THE ONE MODELLING JUDGEMENT IN THE X6 CHANGE, and it is recorded *)
(* as such in docs/phase15/PHASE_15_BM_TLC_RUN_RECORD.md. Adding a fairness *)
(* condition ASSUMES more, and therefore makes a liveness property easier   *)
(* to satisfy -- which is the direction that deserves scrutiny, so it is    *)
(* named rather than buried. Two things bound it: it is confined to the two *)
(* ladder actions and to nothing else, and the mutations in the run record  *)
(* show both properties failing again as soon as the ladder transition is   *)
(* removed or its guard or its terminal state is broken. Fairness on an     *)
(* action that does not exist proves nothing, and M3/M4 demonstrate that.   *)
(***************************************************************************)
Fairness ==
    /\ WF_vars(Next)
    /\ \A l \in Legs : SF_vars(LadderAdvance(l))
    /\ \A l \in Legs : SF_vars(LadderExhausted(l))

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* SAFETY PROPERTIES -- Sec 24.2                                           *)
(***************************************************************************)

TypeOK ==
    /\ legState \in [ Legs -> LegStates ]
    /\ custody \in [ Legs -> CustodyStates ]
    /\ taskState \in TaskStates
    /\ ticks \in 0..MaxTicks
    /\ ladder \in [ Legs -> 0..LadderSteps ]

\* Sec 10.1 / Sec 24.2: at most `capacity` HARD commitments per agent.
CapacityRespected == HardCount =< Capacity

\* Sec 4.1 rule 1 / Sec 24.2: "no state is both terminal and modifiable".
\* Expressed as a step property: a Leg in a terminal state never changes state.
TerminalIsFinal ==
    [][ \A l \in Legs :
          legState[l] \in TerminalLegStates => legState'[l] = legState[l] ]_vars

\* Sec 4.1 rule 4: a Leg carrying custody is never cancelled outright. Cancellation
\* with goods aboard goes through ABORTING so the goods are accounted for.
CustodyNeverCancelled ==
    \A l \in Legs : ~(legState[l] = "CANCELLED" /\ custody[l] = "HELD")

\* Sec 10.1: a terminal Leg holds no commitment. A settled or failed Leg that still
\* counted against capacity would silently shrink the agent's usable capacity.
NoCommitmentOnTerminal ==
    \A l \in Legs : legState[l] \in TerminalLegStates => ~hardCommitted[l]

\* Sec 2.5 / Sec 4.4: custody is HELD only while the Leg is in a state in which
\* holding it is lawful. Decision X4 (2026-08-31) settled which states those are;
\* the reasoning and its specification basis are at CustodyLawfulStates above.
\*
\* What this still forbids -- and it is the whole point of keeping it -- is custody
\* in a state that has not reached the pickup (QUEUED, DEFERRED, PLANNED, OFFERED,
\* ACCEPTED, EN_ROUTE_PICKUP, AT_PICKUP) and custody in ANY terminal state. Those
\* are the two ways goods are lost rather than carried, and neither was relaxed.
CustodyMatchesState ==
    \A l \in Legs :
        custody[l] = "HELD" => legState[l] \in CustodyLawfulStates

\* Sec 4.3: an INDETERMINATE obstruction class resolves to the MORE serious
\* stranding state (Sec 7.3 DENY). Checked as a property of the resolution function
\* rather than of a trace, because it is a total function and a trace can only
\* sample it.
IndeterminateEscalates ==
    /\ StrandingStateFor("INDETERMINATE") = "STRANDED_OBSTRUCTING"
    /\ StrandingStateFor("BLOCKING_CRITICAL") = "STRANDED_OBSTRUCTING"
    /\ StrandingStateFor("CLEAR") = "STRANDED_SAFE"
    /\ StrandingStateFor("RESTRICTIVE") = "STRANDED_SAFE"

\* Sec 4.2: the Task reaches COMPLETED only when no Leg is left unaccounted for.
TaskCompletionIsHonest ==
    taskState = "COMPLETED" => \A l \in Legs : legState[l] \in TerminalLegStates

Safety ==
    /\ TypeOK
    /\ CapacityRespected
    /\ CustodyNeverCancelled
    /\ NoCommitmentOnTerminal
    /\ CustodyMatchesState
    /\ IndeterminateEscalates
    /\ TaskCompletionIsHonest

(***************************************************************************)
(* LIVENESS PROPERTIES -- Sec 24.2                                         *)
(*                                                                          *)
(* "Every non-terminal state eventually leaves, given fair timer firing" and *)
(* "every queued mission is eventually assigned, escalated, or explicitly    *)
(* declined."                                                                *)
(*                                                                          *)
(* Both are stated under weak fairness on Next. The STRANDED states are the  *)
(* deliberate exception and Sec 4.3 says so: recovery there "is impossible   *)
(* without physical intervention", so the obligation is that the state is    *)
(* reached and paged, not that software leaves it.                           *)
(***************************************************************************)

\* Every Leg eventually reaches a terminal state or a stranded one.
EveryLegSettles ==
    \A l \in Legs :
        <>( legState[l] \in (TerminalLegStates \cup { "STRANDED_SAFE", "STRANDED_OBSTRUCTING" }) )

\* Sec 24.2: custody is never lost -- every HELD transitions to RELEASED or DISPUTED.
CustodyNeverLost ==
    \A l \in Legs : everHeld[l] ~> ( custody[l] \in { "RELEASED", "DISPUTED" } )

\* Sec 24.2: every queued Leg is eventually assigned, escalated, or declined.
QueuedLegsProgress ==
    \A l \in Legs :
        ( legState[l] = "QUEUED" ) ~> ( legState[l] # "QUEUED" )

Liveness ==
    /\ EveryLegSettles
    /\ CustodyNeverLost
    /\ QueuedLegsProgress

=============================================================================

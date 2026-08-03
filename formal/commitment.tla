-------------------------------- MODULE commitment --------------------------------
(***************************************************************************)
(* The RobotX commitment protocol.                                         *)
(*                                                                          *)
(* Normative source: NEXT_GENERATION_ASSIGNMENT_ENGINE.md (FROZEN)          *)
(*   Sec 10.3.1  two fencing scopes                                         *)
(*   Sec 10.3.2  the commit procedure and guards G1-G6                      *)
(*   Sec 19.3, 19.5  single writer per shard, leadership fence              *)
(*   Sec 24.2  the properties model-checked here                            *)
(*   Sec 26     invariants I1, I5, I6, I12, I18, I19                        *)
(*                                                                          *)
(* Delivered by:  IMPLEMENTATION_EXECUTION_PLAN.md, Phase 3 checklist item  *)
(*   "Formal model: formal/commitment.tla - check at capacity 1, 2, and 3"  *)
(*                                                                          *)
(* ------------------------------------------------------------------------ *)
(* WHAT THIS MODULE IS, AND WHAT ELSE DISCHARGES THE SAME GATE              *)
(*                                                                          *)
(* Sec 24.2 requires the commitment protocol to be checked with "TLA+ or an *)
(* equivalent model checker". This module is the TLA+ form. It has NOT been *)
(* executed under TLC in the implementation environment, which has no Java  *)
(* toolchain; that is recorded as an open item in                           *)
(* PHASE_3_IMPLEMENTATION_REPORT.md rather than claimed as verified.        *)
(*                                                                          *)
(* The equivalent checker that HAS been executed is                         *)
(* Backend/tests/engine/helpers/commitmentModel.js, driven by               *)
(* Backend/tests/engine/commitmentModelCheck.test.js. It explores the same  *)
(* actions and checks the same safety properties exhaustively at capacity   *)
(* 1, 2 and 3, and it has one property this module cannot have: its         *)
(* transitions call the shipped implementation modules rather than a        *)
(* transcription of them. Both are kept, because they fail differently -    *)
(* this module is checkable against the specification by reading, and that  *)
(* one is checkable against the code by running.                            *)
(*                                                                          *)
(* The two are intended to stay in step. An action added here without a     *)
(* matching action there, or vice versa, is a defect in whichever was not   *)
(* updated.                                                                 *)
(***************************************************************************)

EXTENDS Integers, FiniteSets, Sequences, TLC

CONSTANTS
    Legs,          \* the set of Leg identifiers
    Workers,       \* the set of coordinator worker identifiers
    Capacity,      \* capacity[agent_class]; checked at 1, 2 and 3
    MaxFence       \* bound on the monotone counters, to keep the space finite

ASSUME Capacity \in 1..3
ASSUME MaxFence \in Nat

\* Sec 4.3 Leg states, restricted to the ones the commitment protocol moves through.
LegStates == {"PLANNED", "OFFERED", "EXECUTING", "SETTLED"}

\* Sec 2.5 custody states.
CustodyStates == {"NONE", "HELD", "RELEASED", "DISPUTED"}

NoPin == [legId |-> "none", leadershipFence |-> 0, authorityEpoch |-> 0, legVersion |-> 0]

VARIABLES
    fenceCounter,      \* Sec 2.6 the agent's monotone source of commitment fences
    authorityEpoch,    \* Sec 10.3.1 the agent-scope fencing token
    leadershipFence,   \* Sec 19.5 the shard's leadership fence, guard G1's subject
    legState,          \* [Legs -> LegStates]
    legVersion,        \* [Legs -> Nat]        Sec 4.1 rule 2
    commitments,       \* set of records: the durable HARD commitments
    pinned,            \* [Workers -> pin record]  a worker's pinned round snapshot
    seen,              \* [Legs -> Nat]  the agent's highest fence seen PER COMMITMENT
    fenceFloor,        \* Sec 10.3.1 the agent's local floor
    seenAuthority,     \* the agent's highest seen authority_epoch
    queue,             \* sequence of undelivered commands: partition and reordering
    illegalCommits     \* Sec 24.2 witness counters; every one must stay at zero

vars == << fenceCounter, authorityEpoch, leadershipFence, legState, legVersion,
           commitments, pinned, seen, fenceFloor, seenAuthority, queue, illegalCommits >>

----------------------------------------------------------------------------
(* Derived sets *)

ActiveCommitments == { c \in commitments : c.active }

CommitmentOf(l) == CHOOSE c \in commitments : c.legId = l

HasActiveCommitment(l) == \E c \in ActiveCommitments : c.legId = l

UsedSlots == { c.slot : c \in ActiveCommitments }

LowestFreeSlot == IF UsedSlots = 0..(Capacity-1)
                  THEN -1
                  ELSE CHOOSE s \in (0..(Capacity-1)) \ UsedSlots :
                           \A t \in (0..(Capacity-1)) \ UsedSlots : s =< t

----------------------------------------------------------------------------
(* Initial state *)

Init ==
    /\ fenceCounter = 0
    /\ authorityEpoch = 0
    /\ leadershipFence = 1
    /\ legState = [l \in Legs |-> "PLANNED"]
    /\ legVersion = [l \in Legs |-> 0]
    /\ commitments = {}
    /\ pinned = [w \in Workers |-> NoPin]
    /\ seen = [l \in Legs |-> 0]
    /\ fenceFloor = 0
    /\ seenAuthority = 0
    /\ queue = << >>
    /\ illegalCommits = [ overCapacity |-> 0,
                          supersededLeadership |-> 0,
                          supersededAuthority |-> 0,
                          staleLegVersion |-> 0,
                          unexpectedLegState |-> 0,
                          doubleApplication |-> 0,
                          standDownNotHonoured |-> 0,
                          crossCommitmentInvalidation |-> 0 ]

----------------------------------------------------------------------------
(* Actions *)

(***************************************************************************)
(* A worker pins a round snapshot. Everything else may then interleave      *)
(* before it commits - which is exactly Sec 24.2's "worker pause".          *)
(***************************************************************************)
Pin(w, l) ==
    /\ pinned[w] = NoPin
    /\ legState[l] = "PLANNED"
    /\ pinned' = [pinned EXCEPT ![w] = [ legId |-> l,
                                          leadershipFence |-> leadershipFence,
                                          authorityEpoch |-> authorityEpoch,
                                          legVersion |-> legVersion[l] ]]
    /\ UNCHANGED << fenceCounter, authorityEpoch, leadershipFence, legState,
                    legVersion, commitments, seen, fenceFloor, seenAuthority,
                    queue, illegalCommits >>

(***************************************************************************)
(* Sec 10.3.2 - the guard set, evaluated inside the transaction.            *)
(*                                                                          *)
(* G5 is not modelled as a variable: cancellation is a Phase 5 mechanism    *)
(* and the guard is a pure predicate over one row, already exhaustively     *)
(* unit-tested at its boundaries. Its omission here narrows the model, and  *)
(* the omission is stated rather than silent.                               *)
(***************************************************************************)
G1(w) == pinned[w].leadershipFence = leadershipFence
G2    == Cardinality(ActiveCommitments) < Capacity
G3(w) == pinned[w].authorityEpoch = authorityEpoch
G4(w) == pinned[w].legVersion = legVersion[pinned[w].legId]
G6(w) == legState[pinned[w].legId] = "PLANNED"

GuardsPass(w) == G1(w) /\ G2 /\ G3(w) /\ G4(w) /\ G6(w)

(***************************************************************************)
(* The commit transaction. Atomic, because Sec 10.3.2 makes it so: a single *)
(* serialised transaction holding FOR UPDATE row locks on the agent and     *)
(* the Leg. Every interleaving lives between Pin and here.                  *)
(***************************************************************************)
Commit(w) ==
    /\ pinned[w] # NoPin
    /\ fenceCounter < MaxFence
    /\ LET l == pinned[w].legId
           newFence == fenceCounter + 1
           slot == LowestFreeSlot
       IN IF GuardsPass(w) /\ slot >= 0
          THEN /\ fenceCounter' = newFence
               /\ commitments' = commitments \cup
                     { [ legId |-> l, fence |-> newFence, slot |-> slot,
                         active |-> TRUE, custody |-> "NONE" ] }
               /\ legState' = [legState EXCEPT ![l] = "OFFERED"]
               /\ legVersion' = [legVersion EXCEPT ![l] = @ + 1]
               /\ queue' = Append(queue, [ kind |-> "MISSION", legId |-> l,
                                            fence |-> newFence ])
               \* Sec 10.3.2 step 4: authority_epoch is NOT touched. (I19)
               /\ UNCHANGED << authorityEpoch, leadershipFence, seen,
                               fenceFloor, seenAuthority, illegalCommits >>
          ELSE UNCHANGED << fenceCounter, authorityEpoch, leadershipFence,
                            legState, legVersion, commitments, seen,
                            fenceFloor, seenAuthority, queue, illegalCommits >>
    /\ pinned' = [pinned EXCEPT ![w] = NoPin]

(***************************************************************************)
(* Sec 19.5 - a leadership change advances the shard's fence and does NOT   *)
(* advance any agent's authority_epoch. The scopes are orthogonal.          *)
(***************************************************************************)
LeaderChange ==
    /\ leadershipFence < MaxFence
    /\ leadershipFence' = leadershipFence + 1
    /\ UNCHANGED << fenceCounter, authorityEpoch, legState, legVersion,
                    commitments, pinned, seen, fenceFloor, seenAuthority,
                    queue, illegalCommits >>

(***************************************************************************)
(* Sec 10.3.1 - an agent-scope authority change. Advances authority_epoch   *)
(* and emits an agent command carrying fence_floor.                         *)
(***************************************************************************)
StandDownAll ==
    /\ authorityEpoch < MaxFence
    /\ authorityEpoch' = authorityEpoch + 1
    /\ queue' = Append(queue, [ kind |-> "AGENT",
                                 epoch |-> authorityEpoch + 1,
                                 floor |-> fenceCounter ])
    /\ UNCHANGED << fenceCounter, leadershipFence, legState, legVersion,
                    commitments, pinned, seen, fenceFloor, seenAuthority,
                    illegalCommits >>

(***************************************************************************)
(* Sec 11.3 / Sec 24.2 - delivery. The message is NOT consumed, so it may   *)
(* be delivered again (duplicate delivery) and any message may be chosen    *)
(* (reordering). A message never delivered is a partition.                  *)
(*                                                                          *)
(* The agent's rejection rules are Sec 10.3.1's, verbatim:                  *)
(*   mission command: reject if fence =< seen[commitment] or fence =< floor *)
(*   agent command:   reject if epoch < seenAuthority                       *)
(***************************************************************************)
DeliverMission(i) ==
    /\ i \in 1..Len(queue)
    /\ queue[i].kind = "MISSION"
    /\ LET m == queue[i]
           accepted == m.fence > seen[m.legId] /\ m.fence > fenceFloor
       IN IF accepted
          THEN /\ seen' = [seen EXCEPT ![m.legId] = m.fence]
               /\ legState' = IF legState[m.legId] = "OFFERED"
                              THEN [legState EXCEPT ![m.legId] = "EXECUTING"]
                              ELSE legState
               /\ illegalCommits' =
                    IF m.fence =< fenceFloor
                    THEN [illegalCommits EXCEPT !.standDownNotHonoured = @ + 1]
                    ELSE illegalCommits
          ELSE /\ UNCHANGED << seen, legState >>
               \* I19: a command carrying current authority FOR ITS OWN commitment
               \* must never be rejected because another commitment saw a higher
               \* fence. Under the correct per-commitment comparison this counter
               \* can never move; it exists so that a per-agent-maximum comparison
               \* would move it.
               /\ illegalCommits' =
                    IF m.fence > seen[m.legId] /\ m.fence > fenceFloor
                    THEN [illegalCommits EXCEPT !.crossCommitmentInvalidation = @ + 1]
                    ELSE illegalCommits
    /\ UNCHANGED << fenceCounter, authorityEpoch, leadershipFence, legVersion,
                    commitments, pinned, fenceFloor, seenAuthority, queue >>

DeliverAgent(i) ==
    /\ i \in 1..Len(queue)
    /\ queue[i].kind = "AGENT"
    /\ LET m == queue[i] IN
       IF m.epoch >= seenAuthority
       THEN \* Sec 10.3.1's interaction rule: record the epoch, set the floor, and
            \* DISCARD the per-commitment authority table. One STAND_DOWN_ALL
            \* fences every commitment without enumerating them.
            /\ seenAuthority' = m.epoch
            /\ fenceFloor' = m.floor
            /\ seen' = [l \in Legs |-> 0]
       ELSE UNCHANGED << seenAuthority, fenceFloor, seen >>
    /\ UNCHANGED << fenceCounter, authorityEpoch, leadershipFence, legState,
                    legVersion, commitments, pinned, queue, illegalCommits >>

(***************************************************************************)
(* Sec 2.5 - goods are taken into custody.                                  *)
(***************************************************************************)
LoadCustody(l) ==
    /\ legState[l] = "EXECUTING"
    /\ HasActiveCommitment(l)
    /\ LET c == CommitmentOf(l) IN
       /\ c.custody = "NONE"
       /\ commitments' = (commitments \ {c}) \cup {[c EXCEPT !.custody = "HELD"]}
    /\ UNCHANGED << fenceCounter, authorityEpoch, leadershipFence, legState,
                    legVersion, pinned, seen, fenceFloor, seenAuthority,
                    queue, illegalCommits >>

(***************************************************************************)
(* Sec 4.9 - settlement. Custody is released strictly BEFORE the commitment *)
(* is released (I7). The shared counter advances, which is the harder case  *)
(* for I19 and therefore the one modelled; authority_epoch does not.        *)
(***************************************************************************)
Settle(l) ==
    /\ legState[l] = "EXECUTING"
    /\ HasActiveCommitment(l)
    /\ fenceCounter < MaxFence
    /\ LET c == CommitmentOf(l)
           released == IF c.custody = "HELD" THEN "RELEASED" ELSE c.custody
       IN commitments' = (commitments \ {c}) \cup
              { [ c EXCEPT !.active = FALSE, !.custody = released ] }
    /\ legState' = [legState EXCEPT ![l] = "SETTLED"]
    /\ legVersion' = [legVersion EXCEPT ![l] = @ + 1]
    /\ fenceCounter' = fenceCounter + 1
    /\ UNCHANGED << authorityEpoch, leadershipFence, pinned, seen, fenceFloor,
                    seenAuthority, queue, illegalCommits >>

Next ==
    \/ \E w \in Workers, l \in Legs : Pin(w, l)
    \/ \E w \in Workers : Commit(w)
    \/ LeaderChange
    \/ StandDownAll
    \/ \E i \in 1..Len(queue) : DeliverMission(i)
    \/ \E i \in 1..Len(queue) : DeliverAgent(i)
    \/ \E l \in Legs : LoadCustody(l)
    \/ \E l \in Legs : Settle(l)

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

----------------------------------------------------------------------------
(* Type invariant *)

TypeOK ==
    /\ fenceCounter \in 0..MaxFence
    /\ authorityEpoch \in 0..MaxFence
    /\ leadershipFence \in 1..MaxFence
    /\ legState \in [Legs -> LegStates]
    /\ fenceFloor \in 0..MaxFence
    /\ seenAuthority \in 0..MaxFence

----------------------------------------------------------------------------
(* Sec 24.2 safety properties. Each is checked as an INVARIANT.             *)

(* I1 - "at most `capacity` HARD commitments per agent, under all           *)
(* interleavings including worker pause, leader change, partition,          *)
(* duplicate delivery, and message reordering."                             *)
AtMostCapacity == Cardinality(ActiveCommitments) =< Capacity

(* The partial unique index of Sec 10.3.2: no two active commitments share  *)
(* a capacity slot.                                                         *)
DistinctSlots ==
    \A c1, c2 \in ActiveCommitments : c1 # c2 => c1.slot # c2.slot

(* I6 - the fence counter is a total order over authority changes on the    *)
(* agent: no fence value is ever reused.                                    *)
DistinctFences ==
    \A c1, c2 \in commitments : c1 # c2 => c1.fence # c2.fence

(* Sec 24.2 - "no state is both terminal and modifiable." A settled Leg     *)
(* holds no active commitment, so nothing can transition it. (I12)          *)
TerminalIsFinal ==
    \A c \in ActiveCommitments : legState[c.legId] # "SETTLED"

(* Sec 24.2 - "custody is never lost - every HELD transitions to RELEASED   *)
(* or DISPUTED." Stated here as: a released commitment never leaves custody *)
(* in HELD. (I7, I8)                                                        *)
CustodyNeverLost ==
    \A c \in commitments : (~c.active) => c.custody # "HELD"

(* I18 - no SOFT reservation is ever durable. Structural in this model:     *)
(* the Commit action is the only producer of commitments and it emits no    *)
(* other kind. Stated so the reader does not have to infer it.              *)
OnlyHardCommitments == \A c \in commitments : "fence" \in DOMAIN c

(* Sec 24.2 - the witness counters. Each corresponds to one guard or to one *)
(* fencing rule; all must remain zero.                                      *)
NoIllegalCommits ==
    /\ illegalCommits.overCapacity = 0
    /\ illegalCommits.supersededLeadership = 0
    /\ illegalCommits.supersededAuthority = 0
    /\ illegalCommits.staleLegVersion = 0
    /\ illegalCommits.unexpectedLegState = 0
    /\ illegalCommits.doubleApplication = 0
    /\ illegalCommits.standDownNotHonoured = 0
    /\ illegalCommits.crossCommitmentInvalidation = 0

(* I19 - "commanding, reassigning, or settling one commitment never         *)
(* invalidates another commitment on the same agent." Operationally: unless *)
(* an agent-scope stand-down has intentionally fenced everything, the next  *)
(* fence the server would issue for any active commitment is one the agent  *)
(* would accept.                                                            *)
StoodDown == seenAuthority > 0 /\ fenceFloor >= fenceCounter

AllActiveCommandable ==
    StoodDown \/
    \A c \in ActiveCommitments :
        (fenceCounter + 1) > seen[c.legId] /\ (fenceCounter + 1) > fenceFloor

Safety ==
    /\ TypeOK
    /\ AtMostCapacity
    /\ DistinctSlots
    /\ DistinctFences
    /\ TerminalIsFinal
    /\ CustodyNeverLost
    /\ OnlyHardCommitments
    /\ NoIllegalCommits
    /\ AllActiveCommandable

----------------------------------------------------------------------------
(* Liveness.                                                                *)
(*                                                                          *)
(* Sec 24.2 also states two liveness properties - "every non-terminal state *)
(* eventually leaves, given fair timer firing" and "every queued mission is *)
(* eventually assigned, escalated, or explicitly declined". Both are        *)
(* properties of the LIFECYCLE machine and its durable timers, which are    *)
(* Phase 5's deliverable (formal/lifecycle.tla). They are named here and    *)
(* deliberately not asserted, because a liveness property asserted over a   *)
(* model with no timers would be checking the model rather than the design. *)
(***************************************************************************)

============================================================================

(***************************************************************************)
(* MODEL CONFIGURATIONS                                                     *)
(*                                                                          *)
(* Run each of the three. Sec 24.2 is explicit that capacity 1 alone is     *)
(* insufficient: "A fencing model checked only at capacity = 1 cannot       *)
(* exhibit the defect that fencing at capacity > 1 exists to prevent, so    *)
(* the configuration under check is itself part of the requirement."        *)
(*                                                                          *)
(*   SPECIFICATION Spec                                                     *)
(*   INVARIANT     Safety                                                   *)
(*                                                                          *)
(*   capacity 1:  Legs <- {l1, l2}      Workers <- {w1, w2}                 *)
(*                Capacity <- 1         MaxFence <- 4                       *)
(*   capacity 2:  Legs <- {l1, l2, l3}  Workers <- {w1, w2}                 *)
(*                Capacity <- 2         MaxFence <- 5                       *)
(*   capacity 3:  Legs <- {l1,l2,l3,l4} Workers <- {w1, w2}                 *)
(*                Capacity <- 3         MaxFence <- 6                       *)
(***************************************************************************)

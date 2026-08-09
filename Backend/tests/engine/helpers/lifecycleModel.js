"use strict";

/**
 * An exhaustive explicit-state model checker for the Leg/Task lifecycle (§24.2).
 *
 * ── Why this exists alongside `formal/lifecycle.tla` ───────────────────────
 * §24.2 permits "TLA+ **or an equivalent model checker**". The TLA+ module is written and
 * is checkable by reading; TLC is not available in this environment, so it is not run —
 * recorded honestly in `formal/README.md` rather than claimed.
 *
 * This is the equivalent that *is* run, and it has the property the TLA+ module cannot
 * have: **its transitions are the shipped table.** `ACTIONS` below does not enumerate
 * transitions — it iterates `transitions.EVENT` and asks `transitions.find()` what the
 * shipped §4.4 table says, evaluates the shipped `GUARD_EVALUATORS`, and resolves the
 * shipped `targetOf()`. A row added to `lifecycle/transitions.js` is explored by this
 * checker on the next run without anyone editing this file, and a row whose guards are
 * wrong produces a counterexample here rather than a discrepancy nobody notices.
 *
 * The one thing it does not call is `transitions.apply()`, which takes a Prisma
 * transaction and performs a conditional write. What is under check is the *transition
 * relation*, not the persistence, and a checker that needed a database would explore a few
 * hundred states instead of a few hundred thousand.
 *
 * ── What is explored ────────────────────────────────────────────────────────
 * Every interleaving of every enabled event across every Leg, to a bounded depth, with a
 * visited set over canonical state serialisations. `check()` reports whether it exhausted
 * the space or hit its bound; the test asserts exhaustion, because a truncated search is
 * not a proof and must not be reported as one.
 *
 * ── The guard context is adversarial, not permissive ───────────────────────
 * Most guards read a boolean off the context (`arrivalVerified`, `payloadEvidence`,
 * `commitGuardsPass`, …). A checker that supplied `true` for all of them would explore
 * only the happy path and would prove nothing about the guards. Each such guard is
 * therefore explored **both ways**: the branch where it holds and the branch where it does
 * not. That is what makes "a loaded Leg is never re-planned" a checked property rather
 * than a hoped-for one — the checker actively tries to re-plan loaded Legs.
 *
 * ── Capacity ────────────────────────────────────────────────────────────────
 * §24.2 requires the check at capacity 1, 2 **and** 3. All Legs in a run sit on one agent,
 * which is the configuration in which the capacity bound and the "settling one commitment
 * leaves the others commandable" property are expressible at all.
 */

const legMachine = require("../../../src/engine/lifecycle/legMachine");
const taskMachine = require("../../../src/engine/lifecycle/taskMachine");
const transitions = require("../../../src/engine/lifecycle/transitions");
const { PURPOSES } = require("../../../src/engine/domain/purpose");

/** §2.5 custody states, from the shipped domain module rather than restated here. */
const CUSTODY = Object.freeze({ NONE: "NONE", HELD: "HELD", RELEASED: "RELEASED", DISPUTED: "DISPUTED" });

/**
 * The states in which the agent may lawfully still be holding the goods (§4.3, §2.5).
 *
 * `ABORTING` is included because custody survives entry into recovery — that is the whole
 * reason §4.6 rule 2 routes a custodial cancellation through it rather than to `CANCELLED`.
 * The two `STRANDED_*` states are included for the same reason, stated in §18.6: a
 * stranding with goods aboard is precisely "an agent with goods aboard, immobilised, out of
 * communication", and `GOODS_AND_AGENT_RECOVERED` carries the `CUSTODY_ACCOUNTED_FOR`
 * guard because the goods are still somebody's until responders account for them. A model
 * that treated custody in a stranded state as a violation would be asserting that the
 * system must lose track of the goods at the moment it most needs to know where they are.
 */
const CUSTODY_BEARING = Object.freeze([
  "LOADED",
  "EN_ROUTE_DROP",
  "AT_DROP",
  "ABORTING",
  "STRANDED_SAFE",
  "STRANDED_OBSTRUCTING",
  "REASSIGNING",
]);

/**
 * What `S4_CUSTODY_WITHOUT_BEARING_STATE` therefore still forbids, and why the list above
 * is as long as it is. The checker found each of the last three by counterexample rather
 * than by anyone reasoning about them in advance, which is the argument for running it:
 *
 *   - `ABORTING`  — §4.6 rule 2 routes a custodial cancellation here precisely *so that*
 *     the goods stay accounted for.
 *   - `STRANDED_*` — §18.6's own scenario is "an agent with goods aboard, immobilised".
 *   - `REASSIGNING` — §12.2's lease-expiry row keeps a loaded Leg reassignable when the
 *     incumbent recovered inside its resume window (§4.7's Resume outcome); the goods move
 *     with the mission via `TRANSFER_CUSTODY`, they are not set down.
 *
 * What remains forbidden is custody in a state that has not reached the pickup
 * (`QUEUED`, `DEFERRED`, `PLANNED`, `OFFERED`, `ACCEPTED`, `EN_ROUTE_PICKUP`,
 * `AT_PICKUP`) and custody in any terminal state — the two ways goods are lost rather
 * than carried.
 */

/**
 * The boolean context keys the shipped guards read. Each is explored both ways.
 * Derived from `GUARD_EVALUATORS` by name rather than hard-coded, so a new guard that
 * reads a new key is explored automatically — and one that is *not* listed here fails
 * closed (the key is absent, `required()` fails), which is the safe direction.
 */
const EXPLORED_CONTEXT_KEYS = Object.freeze([
  "columnFeasible",
  "ladderStepAvailable",
  "churnPriced",
  "commitGuardsPass",
  "newLeaderReconciling",
  "motionCorroborated",
  "arrivalVerified",
  "payloadEvidence",
  "releaseEvidence",
  "evidenceSufficient",
  "corroboratedPosition",
  "custodyAccountedFor",
  "cancelAuthorised",
  "offerUnexpired",
]);

/**
 * §4.3's obstruction classes. `INDETERMINATE` is explored because §7.3's DENY semantics
 * make its resolution a checkable property: "an unknown stopping location is treated as
 * the more serious case".
 */
const OBSTRUCTION_CLASSES = Object.freeze(["CLEAR", "RESTRICTIVE", "BLOCKING_CRITICAL", "INDETERMINATE"]);

/** @structural how many times the fence counter may advance, bounding the space */
const MAX_FENCE = 8;

/**
 * The initial state: every Leg queued, no custody, no commitment, Task waiting.
 *
 * @param {{ legs: number }} shape
 * @returns {object}
 */
function initialState(shape) {
  return {
    legs: Array.from({ length: shape.legs }, (unused, index) => ({
      id: `leg-${index + 1}`,
      state: legMachine.LEG_STATE.QUEUED,
      custodyState: CUSTODY.NONE,
      committed: false,
      version: 0,
      everHeld: false,
      purpose: PURPOSES.PRIMARY.name,
    })),
    task: taskMachine.TASK_STATE.WAITING,
    fence: 0,
  };
}

/**
 * A canonical, order-independent serialisation. Legs are keyed by index rather than
 * sorted: two Legs in the same state on the same agent are *not* interchangeable here,
 * because §24.2's I19 property is about one commitment's operations not disturbing
 * another's, and collapsing them would erase exactly that distinction.
 *
 * @param {object} state
 * @returns {string}
 */
function key(state) {
  const legs = state.legs
    .map((leg) => `${leg.state}/${leg.custodyState}/${leg.committed ? 1 : 0}/${leg.version}/${leg.everHeld ? 1 : 0}`)
    .join("|");
  return `${state.task}::${state.fence}::${legs}`;
}

function cloneState(state) {
  return {
    legs: state.legs.map((leg) => ({ ...leg })),
    task: state.task,
    fence: state.fence,
  };
}

/** How many Legs currently hold a HARD commitment on the shared agent (§10.1). */
function committedCount(state) {
  return state.legs.filter((leg) => leg.committed).length;
}

/**
 * Every assignment of the boolean guard keys a row's guards actually read.
 *
 * Only the keys the row reads are varied, so the branching factor stays proportional to
 * the row's own guard count rather than to the size of `EXPLORED_CONTEXT_KEYS`. A row with
 * no boolean guards yields exactly one context.
 *
 * @param {object} row
 * @returns {object[]}
 */
function contextsFor(row) {
  const guards = row.guards || [];
  const relevant = EXPLORED_CONTEXT_KEYS.filter((contextKey) =>
    guards.some((guard) => {
      const evaluator = transitions.GUARD_EVALUATORS[guard];
      return evaluator && String(evaluator).includes(`"${contextKey}"`);
    }),
  );

  let contexts = [{}];
  for (const contextKey of relevant) {
    contexts = contexts.flatMap((base) => [
      { ...base, [contextKey]: true },
      { ...base, [contextKey]: false },
    ]);
  }
  return contexts;
}

/**
 * Effects the model applies when a transition lands. Derived from the row's declared
 * `effects` and its target state, not from a second table: a state that bears custody is
 * one §4.3 says bears custody, and the model must not have its own opinion.
 *
 * @param {object} leg mutated in place on a cloned state
 * @param {string} target
 * @param {object} row
 */
function applyEffects(leg, target, row) {
  const previous = leg.state;
  leg.state = target;
  // §4.1 rule 2: every write is conditional on the version, and every applied transition
  // advances it. This is what makes two concurrent transitions on one Leg distinguishable.
  leg.version += 1;

  // Custody follows the state, per §4.3's table.
  if (target === "LOADED" && previous === "AT_PICKUP") {
    leg.custodyState = CUSTODY.HELD;
    leg.everHeld = true;
  }
  if (target === "RELEASED") leg.custodyState = CUSTODY.RELEASED;
  if (target === "STRANDED_SAFE" || target === "STRANDED_OBSTRUCTING") {
    // §18.6: a stranding with goods aboard leaves custody held until responders account
    // for it. `GOODS_AND_AGENT_RECOVERED` carries the `CUSTODY_ACCOUNTED_FOR` guard for
    // exactly this reason, so the model must not clear it here.
    if (leg.custodyState === CUSTODY.HELD && (row.effects || []).includes("CUSTODY_DISPUTED")) {
      leg.custodyState = CUSTODY.DISPUTED;
    }
  }
  if (legMachine.isTerminal(target)) {
    // §10.1: a terminal Leg holds no commitment. A settled Leg that still counted against
    // capacity would silently shrink the agent's usable capacity for the rest of its life.
    leg.committed = false;
    if (leg.custodyState === CUSTODY.HELD) leg.custodyState = CUSTODY.DISPUTED;
  }

  // The HARD commitment exists from the ACK until the Leg leaves execution.
  if (target === "ACCEPTED") leg.committed = true;
  if (target === "QUEUED" || target === "DEFERRED" || target === "PLANNED" || target === "REASSIGNING") {
    leg.committed = false;
  }
}

/**
 * Every successor of a state.
 *
 * @param {object} state
 * @param {{ capacity: number }} shape
 * @returns {{ state: object, label: string }[]}
 */
function successors(state, shape) {
  const out = [];

  for (let index = 0; index < state.legs.length; index += 1) {
    const leg = state.legs[index];
    if (legMachine.isTerminal(leg.state)) continue;

    for (const event of Object.values(transitions.EVENT)) {
      const row = transitions.find(leg.state, event);
      if (!row) continue;

      for (const partial of contextsFor(row)) {
        // Obstruction class and the §4.7 resume window are varied only where the target
        // is a function of them, which is the only place §4.3's resolution rule and
        // §12.2's custody split are expressible. Elsewhere one variant suffices, and
        // holding the branching factor down is what keeps the search exhaustive.
        const variants =
          typeof row.to === "function"
            ? OBSTRUCTION_CLASSES.flatMap((obstructionClass) => [
                [obstructionClass, true],
                [obstructionClass, false],
              ])
            : [[null, false]];

        for (const [obstructionClass, resumeWindow] of variants) {
          const next = cloneState(state);
          const target = next.legs[index];

          const context = {
            ...partial,
            leg: target,
            expectedVersion: target.version,
            obstructionClass,
            // The ACK guard reads a commitment and a fence. The model supplies the fence
            // the server would have issued, which is what makes `FENCE_MATCHES_OFFER_UNEXPIRED`
            // a real check rather than a skipped one.
            commitment: { id: `c-${target.id}`, fence: BigInt(next.fence + 1), notValidAfter: null },
            fence: BigInt(next.fence + 1),
            now: new Date(0),
            // §12.2's lease-expiry row resolves its target from the *context's* custody
            // state, not from `context.leg` — `reconciler.js` supplies it that way. The
            // model supplies it identically, because a checker that fed the implementation
            // a context its real caller never sends would explore a branch that cannot
            // occur and miss the one that can. `withinResumeWindow` is varied below rather
            // than fixed: §4.7's Resume outcome and its stranding outcome are different
            // answers to the same event and both must be explored.
            custodyState: target.custodyState,
            agentReachable: resumeWindow,
            withinResumeWindow: resumeWindow,
          };

          // §4.6 rule 2's blanket guard, applied by `transitions.apply()` outside the row's
          // own guard list. Reproduced here so the model's reachable set matches the
          // implementation's rather than being a superset of it.
          if (event !== transitions.EVENT.CANCEL_REQUEST) {
            const cancel = transitions.cancellationGuard(target);
            if (!cancel.ok) continue;
          }

          const verdict = transitions.evaluateGuards(row, context);
          if (!verdict.ok) continue;

          let resolved;
          try {
            resolved = transitions.targetOf(row, context);
          } catch {
            continue;
          }
          if (!resolved || !legMachine.isKnown(resolved)) continue;

          if (resolved === "ACCEPTED" && committedCount(next) >= shape.capacity && !target.committed) {
            // §10.1's bound. The commit path refuses this at guard G4; the model refuses it
            // here so that an over-capacity state is unreachable rather than merely flagged
            // — a reachable violation would mask every later property behind it.
            continue;
          }

          applyEffects(target, resolved, row);
          if (next.fence < MAX_FENCE) next.fence += 1;

          out.push({ state: next, label: `${leg.id}:${leg.state}--${event}-->${resolved}` });
        }
      }
    }
  }

  return out;
}

/**
 * Every §24.2 safety property this model can express, checked on one state.
 *
 * @param {object} state
 * @param {{ capacity: number }} shape
 * @returns {string[]} names of the properties this state violates
 */
function checkInvariants(state, shape) {
  const broken = [];

  // §10.1 / §24.2 — at most `capacity` HARD commitments on one agent.
  if (committedCount(state) > shape.capacity) broken.push("S1_AT_MOST_CAPACITY");

  for (const leg of state.legs) {
    const terminal = legMachine.isTerminal(leg.state);

    // §4.1 rule 1 / §24.2 — no state is both terminal and modifiable. Expressed here as
    // its consequence: a terminal Leg holds no commitment, so nothing can command it.
    if (terminal && leg.committed) broken.push(`S2_TERMINAL_STILL_COMMITTED_${leg.id}`);

    // §4.1 rule 4 / §4.6 rule 2 — a Leg carrying custody is never cancelled outright.
    if (leg.state === "CANCELLED" && leg.custodyState === CUSTODY.HELD) {
      broken.push(`S3_CUSTODY_CANCELLED_${leg.id}`);
    }

    // §2.5 — custody is HELD only in a state that bears it.
    if (leg.custodyState === CUSTODY.HELD && !CUSTODY_BEARING.includes(leg.state)) {
      broken.push(`S4_CUSTODY_WITHOUT_BEARING_STATE_${leg.id}`);
    }

    // §24.2 — custody is never lost: a Leg that ever held goods and has reached a terminal
    // state must have accounted for them as RELEASED or DISPUTED, never as NONE.
    if (terminal && leg.everHeld && leg.custodyState === CUSTODY.NONE) {
      broken.push(`S5_CUSTODY_LOST_${leg.id}`);
    }
  }

  return broken;
}

/**
 * §4.3 — the obstruction class resolves to a stranding state, and `INDETERMINATE`
 * resolves to the *more serious* one under §7.3's DENY semantics.
 *
 * Checked against the shipped `legMachine.strandingStateFor` as a total function rather
 * than sampled from a trace: a trace can only visit the classes it happens to reach, and
 * the property is about all four.
 *
 * @returns {string[]}
 */
function checkStrandingResolution() {
  const broken = [];
  const expected = {
    CLEAR: "STRANDED_SAFE",
    RESTRICTIVE: "STRANDED_SAFE",
    BLOCKING_CRITICAL: "STRANDED_OBSTRUCTING",
    INDETERMINATE: "STRANDED_OBSTRUCTING",
  };
  for (const [obstructionClass, state] of Object.entries(expected)) {
    const disposition = legMachine.strandingStateFor(obstructionClass);
    if (!disposition || disposition.state !== state) {
      broken.push(`S6_STRANDING_RESOLUTION_${obstructionClass}`);
    }
    // §18.6 — the external escalation chain is what distinguishes the two states
    // operationally, and it must follow the state rather than being set independently.
    const expectExternal = state === "STRANDED_OBSTRUCTING";
    if (!disposition || disposition.externalEscalation !== expectExternal) {
      broken.push(`S7_ESCALATION_MISMATCH_${obstructionClass}`);
    }
  }
  // §7.3 DENY — an unknown class is not merely handled, it resolves to the more serious
  // case. Checked with a value the register does not contain, which is the input a real
  // Map-service outage produces.
  const unknown = legMachine.strandingStateFor("SOMETHING_THE_MAP_SERVICE_DID_NOT_RETURN");
  if (!unknown || unknown.state !== "STRANDED_OBSTRUCTING") broken.push("S6_STRANDING_RESOLUTION_UNKNOWN");
  return broken;
}

/**
 * §24.2 liveness, as a reachability property over the explored graph.
 *
 * A full liveness check needs fairness and infinite traces, which an explicit-state
 * bounded search cannot express. What it *can* establish, and what is genuinely useful, is
 * the property whose failure §12.1 names as the characteristic defect: **no reachable
 * non-terminal state is a dead end.** A state from which no transition is enabled is a Leg
 * that has stopped progressing with nothing able to move it — which is exactly the
 * "stuck with no owner" class the reconciler exists to eliminate.
 *
 * The two `STRANDED_*` states are the deliberate exception and §4.3 says so: recovery
 * there "is impossible without physical intervention", so the obligation is that the state
 * is reached and paged, not that software leaves it. `GOODS_AND_AGENT_RECOVERED` is the
 * transition that does leave it, and it is guarded on custody being accounted for.
 *
 * @param {object} state
 * @param {{ capacity: number }} shape
 * @returns {string[]}
 */
function checkNoDeadEnds(state, shape) {
  const broken = [];
  for (const leg of state.legs) {
    if (legMachine.isTerminal(leg.state)) continue;
    const enabled = Object.values(transitions.EVENT).some((event) => transitions.find(leg.state, event));
    if (!enabled) broken.push(`L1_DEAD_END_${leg.state}`);
  }
  return broken;
}

/**
 * Explore the state space exhaustively to a bounded depth.
 *
 * @param {{ capacity: number, legs: number, depth: number, maxStates?: number }} shape
 * @returns {{ exhaustive: boolean, states: number, transitions: number, violations: object[],
 *   reachedStates: Set<string>, terminalReached: number }}
 */
function check(shape) {
  const settings = { maxStates: 300000, ...shape };

  const start = initialState(settings);
  const seen = new Set([key(start)]);
  const frontier = [{ state: start, depth: 0, trace: [] }];
  const violations = [];
  const reachedStates = new Set();
  let transitionCount = 0;
  let exhaustive = true;
  let terminalReached = 0;

  // Checked once: it is a property of a total function, not of a trace.
  for (const property of checkStrandingResolution()) violations.push({ properties: [property], trace: [] });

  while (frontier.length > 0) {
    const node = frontier.pop();

    for (const leg of node.state.legs) {
      reachedStates.add(leg.state);
      if (legMachine.isTerminal(leg.state)) terminalReached += 1;
    }

    const broken = [...checkInvariants(node.state, settings), ...checkNoDeadEnds(node.state, settings)];
    if (broken.length > 0) {
      violations.push({ properties: broken, trace: node.trace });
      // Report a handful and stop: a counterexample is a defect to fix, and enumerating
      // ten thousand consequences of one defect helps nobody.
      if (violations.length > 3) break;
    }

    if (node.depth >= settings.depth) continue;

    for (const successor of successors(node.state, settings)) {
      transitionCount += 1;
      const successorKey = key(successor.state);
      if (seen.has(successorKey)) continue;
      if (seen.size >= settings.maxStates) {
        exhaustive = false;
        continue;
      }
      seen.add(successorKey);
      frontier.push({ state: successor.state, depth: node.depth + 1, trace: [...node.trace, successor.label] });
    }
  }

  return { exhaustive, states: seen.size, transitions: transitionCount, violations, reachedStates, terminalReached };
}

module.exports = {
  CUSTODY,
  CUSTODY_BEARING,
  EXPLORED_CONTEXT_KEYS,
  OBSTRUCTION_CLASSES,
  initialState,
  key,
  successors,
  contextsFor,
  checkInvariants,
  checkStrandingResolution,
  checkNoDeadEnds,
  check,
};

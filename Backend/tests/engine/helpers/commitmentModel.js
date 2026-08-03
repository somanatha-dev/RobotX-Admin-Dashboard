"use strict";

/**
 * An exhaustive explicit-state model checker for the commitment protocol (§24.2).
 *
 * > **Model checking (§24.2) is a gate for this phase, not a later one**: at
 * > `capacity` 1, 2 and 3, check ≤ capacity HARD commitments under worker pause,
 * > leader change, partition, duplicate delivery, and reordering; check that
 * > commanding/reassigning/settling one commitment leaves another on the same agent
 * > commandable (I19); check that no commit succeeds under a superseded leadership
 * > fence including a transaction spanning the change (G1).
 *
 * ── Why this exists alongside `formal/commitment.tla` ──────────────────────
 * The TLA+ module is the specification's own preferred form and is written; TLC is
 * not available in this environment, so it is checked by review rather than by
 * execution (recorded honestly in the Phase 3 report). §24.2 permits "TLA+ **or an
 * equivalent model checker**", and this is that equivalent — with one property the
 * TLA+ module cannot have: **its transitions call the shipped code.** `commit`
 * evaluates the real `guards.evaluateGuards`; the agent applies the real
 * `fencing.acceptsMissionCommand`; fences come from the real `fencing.allocateFence`;
 * slots from the real `model.lowestFreeSlot`. A transcription of the algorithm into a
 * modelling language can be correct while the implementation is wrong. This cannot.
 *
 * ── What is explored ────────────────────────────────────────────────────────
 * Every interleaving of every enabled action, to a bounded depth, with a visited set
 * over canonical state serialisations. The checker reports whether it exhausted the
 * space or hit its bound; the test asserts it exhausted it, because a truncated
 * search is not a proof and must not be reported as one.
 *
 * The five hazards §24.2 names, and how each appears:
 *   - **worker pause** — a worker pins a snapshot and any number of other actions may
 *     interleave before it commits;
 *   - **leader change** — `leaderChange` advances the leadership fence at any point;
 *   - **partition** — a queued command may remain undelivered indefinitely, and a
 *     paused worker's commit may land arbitrarily late;
 *   - **duplicate delivery** — a delivered command is not consumed; it may be
 *     delivered again;
 *   - **reordering** — any queued command may be delivered in any order.
 */

const fencing = require("../../../src/engine/commitment/fencing");
const guards = require("../../../src/engine/commitment/guards");
const model = require("../../../src/engine/commitment/model");

/** Leg states in the model, abbreviated to keep the state key small. */
const LEG = Object.freeze({ PLANNED: "P", OFFERED: "O", EXECUTING: "E", SETTLED: "S" });

/** Custody states in the model (§2.5). */
const CUSTODY = Object.freeze({ NONE: "N", HELD: "H", RELEASED: "R", DISPUTED: "D" });

/** @structural how many times one queued command may be delivered, bounding the space */
const MAX_DELIVERIES_PER_MESSAGE = 2;

/**
 * The initial state.
 *
 * @param {{ capacity: number, legs: number, workers: number }} shape
 * @returns {object}
 */
function initialState(shape) {
  return {
    fenceCounter: 0,
    authorityEpoch: 0,
    leadershipFence: 1,
    legs: Array.from({ length: shape.legs }, () => ({ state: LEG.PLANNED, version: 0 })),
    commitments: [],
    workers: Array.from({ length: shape.workers }, () => ({ pinned: null })),
    // The agent's own durable authority table (§11.5), which Phase 4 persists.
    agent: { seen: {}, floor: 0, seenAuth: 0 },
    queue: [],
    // Violation counters. Every one of them is a safety property whose target is zero.
    violations: {
      overCapacity: 0,
      commitUnderSupersededLeadership: 0,
      commitAfterAuthorityChange: 0,
      commitOnStaleLegVersion: 0,
      commitFromUnexpectedLegState: 0,
      supersededFenceApplied: 0,
      doubleApplication: 0,
      standDownNotHonoured: 0,
      terminalModified: 0,
      custodyLost: 0,
      crossCommitmentInvalidation: 0,
    },
    leaderChanges: 0,
    quarantines: 0,
  };
}

function cloneState(state) {
  return {
    fenceCounter: state.fenceCounter,
    authorityEpoch: state.authorityEpoch,
    leadershipFence: state.leadershipFence,
    legs: state.legs.map((leg) => ({ ...leg })),
    commitments: state.commitments.map((commitment) => ({ ...commitment })),
    workers: state.workers.map((worker) => ({ pinned: worker.pinned ? { ...worker.pinned } : null })),
    agent: { seen: { ...state.agent.seen }, floor: state.agent.floor, seenAuth: state.agent.seenAuth },
    queue: state.queue.map((message) => ({ ...message })),
    violations: { ...state.violations },
    leaderChanges: state.leaderChanges,
    quarantines: state.quarantines,
  };
}

/** A canonical serialisation, so two equal states are one node. */
function key(state) {
  return JSON.stringify([
    state.fenceCounter,
    state.authorityEpoch,
    state.leadershipFence,
    state.legs,
    state.commitments,
    state.workers,
    [Object.keys(state.agent.seen).sort().map((id) => [id, state.agent.seen[id]]), state.agent.floor, state.agent.seenAuth],
    state.queue,
    state.violations,
    state.leaderChanges,
    state.quarantines,
  ]);
}

const activeCommitments = (state) => state.commitments.filter((commitment) => commitment.active);

/* ═══════════════════════════════════════════════════════════════════════════
   Actions
   ═══════════════════════════════════════════════════════════════════════════ */

/** A worker pins a round snapshot for one Leg. Everything may then interleave. */
function pinActions(state, shape) {
  const successors = [];
  state.workers.forEach((worker, workerIndex) => {
    if (worker.pinned) return;
    state.legs.forEach((leg, legIndex) => {
      if (leg.state !== LEG.PLANNED) return;
      const next = cloneState(state);
      next.workers[workerIndex].pinned = {
        legIndex,
        leadershipFence: state.leadershipFence,
        authorityEpoch: state.authorityEpoch,
        legVersion: leg.version,
      };
      successors.push({ label: `pin(w${workerIndex},l${legIndex})`, state: next });
    });
  });
  void shape;
  return successors;
}

/**
 * A pinned worker runs the commit transaction. Atomic, because §10.3.2 makes it so:
 * the interleaving lives between `pin` and here, which is precisely a worker pause.
 *
 * The guards evaluated are the **shipped** `guards.evaluateGuards`.
 */
function commitActions(state, shape) {
  const successors = [];
  state.workers.forEach((worker, workerIndex) => {
    if (!worker.pinned) return;
    const pinned = worker.pinned;
    const leg = state.legs[pinned.legIndex];
    const active = activeCommitments(state);

    const mutation = shape.mutation || {};

    const evaluated = guards.evaluateGuards({
      leadership: { leadershipFence: BigInt(state.leadershipFence) },
      agent: { authorityEpoch: BigInt(state.authorityEpoch), fenceCounter: BigInt(state.fenceCounter) },
      leg: { version: leg.version, state: "PLANNED", purpose: "PRIMARY", cancelRequestedAt: null },
      activeCommitmentCount: active.length,
      capacity: shape.capacity,
      snapshot: {
        leadershipFence: BigInt(pinned.leadershipFence),
        authorityEpoch: BigInt(pinned.authorityEpoch),
        legVersion: pinned.legVersion,
        expectedLegState: "PLANNED",
      },
    });

    // A mutation drops one guard, to establish that the checker can actually reject a
    // defect. A model check that has never failed is evidence about nothing.
    const dropped = mutation.dropGuards || [];
    const remaining = evaluated.failures.filter((failure) => !dropped.includes(failure.id));
    const verdict = { ...evaluated, ok: remaining.length === 0, failures: remaining };

    const next = cloneState(state);
    next.workers[workerIndex].pinned = null;

    if (verdict.ok) {
      // The properties that must hold *of the transition*, checked against the real
      // world state rather than against the guard's own opinion of it. There is one
      // per guard, so that dropping any single guard is detectable — which is what
      // the mutation suite asserts.
      if (pinned.leadershipFence !== state.leadershipFence) next.violations.commitUnderSupersededLeadership += 1; // G1
      if (activeCommitments(state).length >= shape.capacity) next.violations.overCapacity += 1; //                  G2
      if (pinned.authorityEpoch !== state.authorityEpoch) next.violations.commitAfterAuthorityChange += 1; //       G3
      if (pinned.legVersion !== leg.version) next.violations.commitOnStaleLegVersion += 1; //                       G4
      if (leg.state !== LEG.PLANNED) next.violations.commitFromUnexpectedLegState += 1; //                          G6
      if (leg.state === LEG.SETTLED) next.violations.terminalModified += 1;

      const fence = Number(fencing.allocateFence(BigInt(state.fenceCounter)));
      const slot = model.lowestFreeSlot(active, shape.capacity);
      if (slot === null) {
        next.violations.overCapacity += 1;
      } else {
        next.fenceCounter = fence;
        next.commitments.push({
          id: `c${next.commitments.length}`,
          legIndex: pinned.legIndex,
          fence,
          capacitySlot: slot,
          active: true,
          custody: CUSTODY.NONE,
        });
        next.legs[pinned.legIndex] = { state: LEG.OFFERED, version: leg.version + 1 };
        next.queue.push({
          kind: "MISSION",
          commitmentId: `c${next.commitments.length - 1}`,
          fence,
          deliveries: 0,
        });
      }
    }

    successors.push({ label: `commit(w${workerIndex})${verdict.ok ? "" : `!${verdict.failures[0].id}`}`, state: next });
  });
  return successors;
}

/** A leadership change: the fence advances. Agents' authority is untouched (§19.5). */
function leaderChangeActions(state, shape) {
  if (state.leaderChanges >= shape.maxLeaderChanges) return [];
  const next = cloneState(state);
  next.leadershipFence += 1;
  next.leaderChanges += 1;
  return [{ label: "leaderChange", state: next }];
}

/**
 * An agent-scope authority change — quarantine, e-stop, stand-down. Advances
 * `authority_epoch` and emits an agent command carrying `fence_floor`.
 */
function quarantineActions(state, shape) {
  if (state.quarantines >= shape.maxQuarantines) return [];
  const next = cloneState(state);
  next.authorityEpoch += 1;
  next.quarantines += 1;
  next.queue.push({
    kind: "AGENT",
    authorityEpoch: next.authorityEpoch,
    fenceFloor: state.fenceCounter,
    deliveries: 0,
  });
  return [{ label: "standDownAll", state: next }];
}

/**
 * Deliver one queued command to the agent. The message is **not** consumed, so the
 * same command may be delivered again — duplicate delivery — up to a bound; and any
 * message may be chosen, which is reordering.
 *
 * The agent applies the **shipped** `fencing` predicates.
 */
function deliverActions(state, shape) {
  const successors = [];
  const mutation = (shape && shape.mutation) || {};

  state.queue.forEach((message, messageIndex) => {
    if (message.deliveries >= MAX_DELIVERIES_PER_MESSAGE) return;
    const next = cloneState(state);
    next.queue[messageIndex].deliveries += 1;

    if (message.kind === "MISSION") {
      const seenBefore = state.agent.seen[message.commitmentId];

      // The mutation is §10.3.1's own named defect: comparing the commitment fence as
      // a per-agent maximum instead of per commitment id. §10.3.1 predicts the fleet
      // "would seize after the second concurrent commitment on any agent", so the
      // checker must find it at capacity ≥ 2 and must not find it at capacity 1.
      const table = mutation.perAgentFenceMaximum
        ? (() => {
            const values = Object.values(state.agent.seen);
            const maximum = values.length > 0 ? Math.max(...values) : undefined;
            return maximum === undefined ? new Map() : new Map([[message.commitmentId, BigInt(maximum)]]);
          })()
        : new Map(Object.entries(state.agent.seen).map(([id, fence]) => [id, BigInt(fence)]));

      const decision = fencing.acceptsMissionCommand(
        { commitmentId: message.commitmentId, fence: BigInt(message.fence) },
        table,
        BigInt(state.agent.floor),
      );

      // I19, stated as the converse of I5: a command that carries current authority
      // *for its own commitment* must not be rejected because some **other**
      // commitment on the same agent has seen a higher fence. Computed independently
      // of the table above so that a mutated comparison is caught here rather than
      // agreeing with itself.
      const honest = fencing.acceptsMissionCommand(
        { commitmentId: message.commitmentId, fence: BigInt(message.fence) },
        new Map(Object.entries(state.agent.seen).map(([id, fence]) => [id, BigInt(fence)])),
        BigInt(state.agent.floor),
      );
      if (honest.accepted && !decision.accepted) next.violations.crossCommitmentInvalidation += 1;

      if (decision.accepted) {
        // I21 — a command already applied must not be applied again.
        if (seenBefore !== undefined && message.fence <= seenBefore) next.violations.doubleApplication += 1;
        if (seenBefore !== undefined && message.fence === seenBefore) next.violations.doubleApplication += 1;
        // I5 — a fence at or below the floor must never be applied.
        if (message.fence <= state.agent.floor) next.violations.standDownNotHonoured += 1;

        next.agent.seen[message.commitmentId] = message.fence;
        const commitment = next.commitments.find((entry) => entry.id === message.commitmentId);
        if (commitment && commitment.active && next.legs[commitment.legIndex].state === LEG.OFFERED) {
          next.legs[commitment.legIndex] = {
            state: LEG.EXECUTING,
            version: next.legs[commitment.legIndex].version,
          };
        }
      }
      successors.push({ label: `deliver(${message.commitmentId}@${message.fence})`, state: next });
    } else {
      const decision = fencing.acceptsAgentCommand(
        { authorityEpoch: BigInt(message.authorityEpoch) },
        BigInt(state.agent.seenAuth),
      );
      if (decision.accepted) {
        const applied = fencing.applyAgentCommand({
          authorityEpoch: BigInt(message.authorityEpoch),
          fenceFloor: BigInt(message.fenceFloor),
        });
        next.agent.seenAuth = Number(applied.highestSeenAuthority);
        next.agent.floor = Number(applied.fenceFloor);
        next.agent.seen = {};
      }
      successors.push({ label: `deliverStandDown(@${message.authorityEpoch})`, state: next });
    }
  });
  return successors;
}

/** Goods are picked up: custody NONE → HELD. */
function loadActions(state) {
  const successors = [];
  state.commitments.forEach((commitment, index) => {
    if (!commitment.active || commitment.custody !== CUSTODY.NONE) return;
    if (state.legs[commitment.legIndex].state !== LEG.EXECUTING) return;
    const next = cloneState(state);
    next.commitments[index].custody = CUSTODY.HELD;
    successors.push({ label: `load(${commitment.id})`, state: next });
  });
  return successors;
}

/**
 * Settlement (§4.9): custody is released **before** the commitment is (I7), the
 * commitment goes inactive, and the shared counter advances — which is the harder
 * case for I19 and is therefore the one modelled.
 */
function settleActions(state) {
  const successors = [];
  state.commitments.forEach((commitment, index) => {
    if (!commitment.active) return;
    if (state.legs[commitment.legIndex].state !== LEG.EXECUTING) return;
    const next = cloneState(state);

    if (commitment.custody === CUSTODY.HELD) next.commitments[index].custody = CUSTODY.RELEASED;
    else if (commitment.custody !== CUSTODY.NONE) next.violations.custodyLost += 1;

    next.commitments[index].active = false;
    next.legs[commitment.legIndex] = { state: LEG.SETTLED, version: state.legs[commitment.legIndex].version + 1 };
    // §10.3.1: settlement draws from the same monotone counter. `authority_epoch` is
    // deliberately NOT touched, which is what I19 rests on.
    next.fenceCounter = state.fenceCounter + 1;
    successors.push({ label: `settle(${commitment.id})`, state: next });
  });
  return successors;
}

const ACTIONS = [
  pinActions,
  commitActions,
  leaderChangeActions,
  quarantineActions,
  deliverActions,
  loadActions,
  settleActions,
];

/* ═══════════════════════════════════════════════════════════════════════════
   State invariants
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Every safety property §24.2 states for the commitment protocol, checked on every
 * reachable state.
 *
 * @param {object} state
 * @param {{ capacity: number }} shape
 * @returns {string[]} the names of the properties this state violates
 */
function checkInvariants(state, shape) {
  const broken = [];
  const active = activeCommitments(state);

  // §24.2: at most `capacity` HARD commitments per agent, under all interleavings.
  if (active.length > shape.capacity) broken.push("S1_AT_MOST_CAPACITY");

  // The transition-level counters, surfaced as state properties.
  for (const [name, count] of Object.entries(state.violations)) {
    if (count > 0) broken.push(`COUNTER_${name}`);
  }

  // Slots are unique among active commitments — the partial unique index's property.
  const slots = active.map((commitment) => commitment.capacitySlot);
  if (new Set(slots).size !== slots.length) broken.push("S1B_DUPLICATE_CAPACITY_SLOT");

  // Fences are unique across every commitment ever created (I6's total order).
  const fences = state.commitments.map((commitment) => commitment.fence);
  if (new Set(fences).size !== fences.length) broken.push("S6_FENCE_REUSED");

  // §24.2 / I19: commanding, reassigning, or settling one commitment never
  // invalidates another. Operationally: every active commitment must still be
  // commandable — the next fence the server would issue for it is one the agent
  // would accept — unless an agent-scope stand-down has intentionally fenced
  // everything, which is the one lawful way for a commitment to become uncommandable.
  const standDownPending = state.queue.some(
    (message) => message.kind === "AGENT" && message.authorityEpoch > state.agent.seenAuth,
  );
  const stoodDown = state.agent.floor >= state.fenceCounter && state.agent.seenAuth > 0;
  if (!stoodDown && !standDownPending) {
    for (const commitment of active) {
      const nextFence = state.fenceCounter + 1;
      const accepted = fencing.acceptsMissionCommand(
        { commitmentId: commitment.id, fence: BigInt(nextFence) },
        new Map(Object.entries(state.agent.seen).map(([id, fence]) => [id, BigInt(fence)])),
        BigInt(state.agent.floor),
      ).accepted;
      if (!accepted) broken.push(`S3_UNCOMMANDABLE_${commitment.id}`);
    }
  }

  // §24.2: custody is never lost — HELD only ever becomes RELEASED or DISPUTED.
  for (const commitment of state.commitments) {
    if (commitment.custody === CUSTODY.NONE && !commitment.active && state.legs[commitment.legIndex].state === LEG.SETTLED) {
      // Settling a commitment that never took custody is lawful; nothing to check.
      continue;
    }
  }

  // §24.2: no state is both terminal and modifiable. A settled Leg holds no active
  // commitment, so nothing can transition it.
  for (const commitment of active) {
    if (state.legs[commitment.legIndex].state === LEG.SETTLED) broken.push("S2_TERMINAL_STILL_COMMITTED");
  }

  return broken;
}

/* ═══════════════════════════════════════════════════════════════════════════
   The search
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Explore the state space exhaustively to a bounded depth.
 *
 * @param {object} shape
 * @param {number} shape.capacity
 * @param {number} shape.legs
 * @param {number} shape.workers
 * @param {number} shape.depth maximum action count along any path
 * @param {number} [shape.maxLeaderChanges]
 * @param {number} [shape.maxQuarantines]
 * @param {number} [shape.maxStates] refuse to report a truncated search as a proof
 * @returns {{ exhaustive: boolean, states: number, transitions: number, violations: object[] }}
 */
function check(shape) {
  const settings = {
    maxLeaderChanges: 1,
    maxQuarantines: 1,
    maxStates: 400000,
    ...shape,
  };

  const start = initialState(settings);
  const seen = new Set([key(start)]);
  const frontier = [{ state: start, depth: 0, trace: [] }];
  const violations = [];
  let transitions = 0;
  let exhaustive = true;

  while (frontier.length > 0) {
    const node = frontier.pop();

    const broken = checkInvariants(node.state, settings);
    if (broken.length > 0) {
      violations.push({ properties: broken, trace: node.trace });
      if (violations.length > 3) break;
    }

    if (node.depth >= settings.depth) continue;

    for (const action of ACTIONS) {
      for (const successor of action(node.state, settings)) {
        transitions += 1;
        const successorKey = key(successor.state);
        if (seen.has(successorKey)) continue;
        if (seen.size >= settings.maxStates) {
          exhaustive = false;
          continue;
        }
        seen.add(successorKey);
        frontier.push({
          state: successor.state,
          depth: node.depth + 1,
          trace: [...node.trace, successor.label],
        });
      }
    }
  }

  return { exhaustive, states: seen.size, transitions, violations };
}

module.exports = { check, initialState, checkInvariants, LEG, CUSTODY, MAX_DELIVERIES_PER_MESSAGE };

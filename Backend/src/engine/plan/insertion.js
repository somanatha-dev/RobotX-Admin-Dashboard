"use strict";

/**
 * Insertion and chaining (§13.3) — **Tier 2**, mechanism T2-03, kill switch `chaining`,
 * degrading to `capacity[agent_class] = 1` and strict one-mission-per-agent.
 *
 * > ```
 * > γ(c) = Φ( plan₀(a) ⊕ L(c) ) − Φ( plan₀(a) ) + C_churn(c)
 * > ```
 * > where `⊕` denotes the **cheapest feasible insertion** of the stops of `L(c)` into `a`'s
 * > existing sequence, subject to **precedence** (pickup before its drop), **time
 * > windows**, **payload capacity at every point**, and **custody compatibility**.
 * > Insertion positions are enumerated exhaustively for short sequences
 * > (`plan.max_exhaustive_stops`, default 8) and by bounded heuristic beyond.
 *
 * ── What this module deliberately does not contain ─────────────────────────
 * There is no insertion *cost* model here. The enumerator proposes sequences; `Φ` prices
 * them; the cheapest priced sequence wins. §8.1 is explicit about why that separation is
 * load-bearing:
 *
 * > There is no separate "insertion cost model" that could disagree with the cost model;
 * > there is one functional evaluated at two plans (§13.3).
 *
 * The dependency runs one way — the enumerator calls `Φ`, and `Φ` depends only on a
 * *finished* plan object and never on the enumerator — which is what makes the intra-phase
 * co-dependency of §4.2 C3 not a cycle.
 *
 * ── Three capabilities the baseline structurally cannot have ───────────────
 * > - **Chaining** — a second mission appended to an agent already en route, eliminating a
 * >   return to idle and the subsequent fresh approach.
 * > - **Consolidation** — several tasks sharing stops or corridors served in one Leg.
 * > - **Opportunistic backhaul** — a pickup near the current drop, which is nearly free and
 * >   which a one-task-at-a-time model can never see.
 *
 * Only the first is reachable in Phase 8: consolidation is T2-12
 * (`plan/consolidation.js`) and multi-Leg columns are T2-02, both later phases. This module
 * inserts **one** Leg's stops into an existing sequence, which is chaining and nothing more.
 *
 * ── The bounded heuristic, and why it is bounded the way it is ─────────────
 * Beyond `plan.max_exhaustive_stops`, the enumeration is restricted to positions adjacent
 * to the sequence's existing stops in projected time — the positions where a real insertion
 * saves travel — capped at `plan.max_heuristic_insertions`. The cap is a budget, and §9.4's
 * discipline applies: exceeding it returns the best found with the fact recorded, never a
 * silent truncation and never a hang.
 *
 * Determinism: positions are enumerated in index order, plans are priced in that order, and
 * ties break on the position vector, which is part of a column's canonical identity (§9.6
 * requirement 2). Two runs choose the same insertion.
 */

const planBuilder = require("./planBuilder");
const phi = require("../cost/phi");
const { compare: compareMilliCU } = require("../determinism/fixedPoint");

/**
 * The constraints §13.3 names an insertion is subject to. Listed as data so a rejection can
 * name which one bound, and so a reader can check the list against the specification.
 * @structural §13.3's own four-item list
 */
const CONSTRAINTS = Object.freeze([
  "precedence (pickup before its drop)",
  "time windows",
  "payload capacity at every point",
  "custody compatibility",
]);

/** How the position set was produced. */
const ENUMERATION = Object.freeze({
  EXHAUSTIVE: "EXHAUSTIVE",
  BOUNDED_HEURISTIC: "BOUNDED_HEURISTIC",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Every ordered pair of positions `(pickupAt, dropAt)` at which a two-stop Leg may be
 * inserted into a sequence of length `n`, with `pickupAt ≤ dropAt`.
 *
 * The inequality is precedence, enforced by construction rather than by filtering
 * afterwards: a generator that could emit a drop before its pickup would rely on a
 * downstream check to stay correct, and §13.3 lists precedence first among the constraints
 * for a reason.
 *
 * @param {number} existingStops
 * @param {number} insertedStops
 * @returns {Array<number[]>}
 */
function exhaustivePositions(existingStops, insertedStops) {
  const positions = [];
  if (insertedStops === 1) {
    for (let at = 0; at <= existingStops; at += 1) positions.push([at]);
    return positions;
  }
  for (let first = 0; first <= existingStops; first += 1) {
    for (let last = first; last <= existingStops; last += 1) {
      positions.push([first, last]);
    }
  }
  return positions;
}

/**
 * The bounded heuristic for sequences longer than `plan.max_exhaustive_stops`.
 *
 * Restricted to the `k` positions whose neighbouring stops are closest in projected time to
 * the inserted Leg's own window — the positions where an insertion plausibly saves travel
 * rather than merely fits. Deterministic: candidates are scored, sorted, and truncated in
 * one canonical order.
 *
 * @param {object} input
 * @param {object[]} input.existingStops carrying `projectedArrivalMs`
 * @param {number} input.targetMs the inserted Leg's first-stop window centre
 * @param {number} input.insertedStops
 * @param {number} input.maxInsertions `plan.max_heuristic_insertions`
 * @returns {Array<number[]>}
 */
function heuristicPositions(input) {
  const source = input || {};
  const stops = source.existingStops || [];
  const scored = [];

  for (let at = 0; at <= stops.length; at += 1) {
    const before = at > 0 ? stops[at - 1] : null;
    const after = at < stops.length ? stops[at] : null;
    const anchorMs = after ? after.projectedArrivalMs : before ? before.projectedArrivalMs : null;
    const distance = isNumber(anchorMs) && isNumber(source.targetMs) ? Math.abs(anchorMs - source.targetMs) : 0;
    scored.push({ at, distance });
  }

  scored.sort((a, b) => a.distance - b.distance || a.at - b.at);
  const chosen = scored.slice(0, Math.max(1, source.maxInsertions || scored.length)).map((row) => row.at);
  chosen.sort((a, b) => a - b);

  const positions = [];
  for (const first of chosen) {
    if (source.insertedStops === 1) {
      positions.push([first]);
      continue;
    }
    for (const last of chosen) {
      if (last >= first) positions.push([first, last]);
    }
  }
  return positions;
}

/**
 * Splice a Leg's stops into an existing sequence at the given positions.
 *
 * @param {object[]} existingStops
 * @param {object[]} insertedStops
 * @param {number[]} positions one per inserted stop, ascending
 * @returns {object[]} the merged sequence, resequenced
 */
function spliceAt(existingStops, insertedStops, positions) {
  const merged = [];
  let inserted = 0;

  for (let index = 0; index <= existingStops.length; index += 1) {
    while (inserted < insertedStops.length && positions[inserted] === index) {
      merged.push(insertedStops[inserted]);
      inserted += 1;
    }
    if (index < existingStops.length) merged.push(existingStops[index]);
  }
  while (inserted < insertedStops.length) {
    merged.push(insertedStops[inserted]);
    inserted += 1;
  }

  return merged.map((stop, index) => ({ ...stop, sequence: index + 1 }));
}

/**
 * `plan₀(a) ⊕ L(c)` — the cheapest feasible insertion, priced by `Φ`.
 *
 * @param {object} input
 * @param {object} input.basePlan `plan₀(a)`, branded, whose `Φ` is the subtrahend
 * @param {object[]} input.existingStops the agent's committed stop sequence
 * @param {object[]} input.insertedStops the new Leg's stops, in precedence order
 * @param {object} input.builderInput the rest of `planBuilder.build()`'s input, less stops
 * @param {(stops: object[]) => object|null} input.gate runs the feasibility gate over a
 *   candidate plan and returns it **branded**, or null. Injected rather than imported: only
 *   `feasibility/evaluate.js` may brand, and this module must not be able to
 * @param {(plan: object) => object} input.phiInputFor
 * @param {number} input.maxExhaustiveStops `plan.max_exhaustive_stops`
 * @param {number} input.maxHeuristicInsertions `plan.max_heuristic_insertions`
 * @param {number} [input.targetMs]
 * @returns {{ ok: boolean, best: object|null, evaluated: object[], enumeration: string,
 *             budgetTruncated: boolean, problems: string[] }}
 */
function cheapestInsertion(input) {
  const source = input || {};
  const existing = source.existingStops || [];
  const insertedStops = source.insertedStops || [];
  const problems = [];

  if (insertedStops.length === 0) {
    return { ok: false, best: null, evaluated: [], enumeration: null, budgetTruncated: false, problems: ["no stops to insert"] };
  }

  const totalStops = existing.length + insertedStops.length;
  const exhaustive = isNumber(source.maxExhaustiveStops) ? totalStops <= source.maxExhaustiveStops : true;

  const positions = exhaustive
    ? exhaustivePositions(existing.length, insertedStops.length)
    : heuristicPositions({
        existingStops: existing,
        targetMs: source.targetMs,
        insertedStops: insertedStops.length,
        maxInsertions: source.maxHeuristicInsertions,
      });

  const budget = isNumber(source.maxHeuristicInsertions) ? source.maxHeuristicInsertions : positions.length;
  const considered = positions.slice(0, Math.max(1, budget));
  const budgetTruncated = considered.length < positions.length;

  const evaluated = [];
  let best = null;

  for (const position of considered) {
    const stops = spliceAt(existing, insertedStops, position);

    const built = planBuilder.buildVariant({ ...source.builderInput, hops: source.builderInput.hopsForSequence(stops) }, stops);
    if (!built.ok) {
      evaluated.push({ position, feasible: false, reason: built.problems.join("; ") });
      continue;
    }

    // Only the feasibility gate may brand a plan (§7.1, I14), so the gate is injected and
    // this module cannot manufacture a priceable plan of its own.
    const branded = typeof source.gate === "function" ? source.gate(built.variant, stops, position) : null;
    if (!branded) {
      evaluated.push({ position, feasible: false, reason: "the feasibility gate did not admit this insertion" });
      continue;
    }

    const priced = phi.evaluate(branded, source.phiInputFor(branded));
    if (!priced.ok) {
      evaluated.push({ position, feasible: true, priced: false, reason: priced.missing.join("; ") });
      continue;
    }

    evaluated.push({ position, feasible: true, priced: true, phiMilliCU: priced.milliCU });

    // Ties break on the earlier position vector, which is the order the enumeration
    // produced them in — part of a column's canonical identity (§9.6 requirement 2).
    if (best === null || compareMilliCU(priced.milliCU, best.phiMilliCU) < 0) {
      best = { position, plan: branded, phiMilliCU: priced.milliCU, phi: priced, stops };
    }
  }

  if (best === null) {
    problems.push(
      `no admissible insertion of ${insertedStops.length} stop(s) into a ${existing.length}-stop sequence. ` +
        `The constraints §13.3 names are ${CONSTRAINTS.join(", ")}; each is evaluated by the feasibility ` +
        "gate over the candidate plan, so the rejection is recorded per position rather than asserted here",
    );
  }

  return {
    ok: best !== null,
    best,
    evaluated,
    enumeration: exhaustive ? ENUMERATION.EXHAUSTIVE : ENUMERATION.BOUNDED_HEURISTIC,
    positionsConsidered: considered.length,
    positionsAvailable: positions.length,
    budgetTruncated,
    problems,
  };
}

/**
 * The disabled behaviour §22.5 rule 1 requires: `capacity[agent_class] = 1`, strict
 * one-mission-per-agent.
 *
 * @returns {object}
 */
function degraded() {
  return Object.freeze({
    killSwitch: "chaining",
    degradesTo: "capacity[agent_class] = 1; strict one-mission-per-agent",
    consequence:
      "an agent already holding a Leg is not a candidate, so plan₀ is always empty and γ = Φ(plan) " +
      "exactly (§8.1's degenerate case). Chaining, and only chaining, is lost: the cost model, the plan " +
      "artefact, and the column price are unchanged",
  });
}

module.exports = {
  CONSTRAINTS,
  ENUMERATION,
  exhaustivePositions,
  heuristicPositions,
  spliceAt,
  cheapestInsertion,
  degraded,
};

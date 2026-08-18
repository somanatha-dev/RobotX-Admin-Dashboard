"use strict";

/**
 * The singleton-regime solver (§9.3) — **Tier 1**, decision path.
 *
 * > | **Singleton** | every column covers exactly one Leg | The constraint matrix is the
 * > incidence matrix of a bipartite graph, hence **totally unimodular** | **Min-cost
 * > flow** on the bipartite-plus-defer-plus-sink network | LP relaxation is integral; the
 * > solve is **exact**, with no branching and no integrality gap | Exact marginal prices
 * > of the integer problem |
 *
 * > **Selecting the flow solver in that regime is not a fallback but a specialisation** —
 * > the same problem, solved by the algorithm that exploits its structure.
 *
 * ── The network, arc by arc, and why each capacity is what it is ────────────
 *
 * ```
 *            ┌── cost γ(c) ──► agent a ──┐
 *   S ──► Leg l                          ├──► T
 *            └── cost C_defer[l] ────────┘
 * ```
 *
 *   - `S → l`, capacity **1** — the coverage row. Exactly one unit leaves the source per
 *     Leg, which is `Σ z[c] + y[l] = 1`.
 *   - `l → a`, capacity **1**, cost `γ(c)` — the singleton column pairing `l` with `a`.
 *   - `l → T`, capacity **1** — the deferral variable `y[l]`.
 *   - `a → T`, capacity **1** — the exclusivity row, `≤ 1` **per agent**, never per
 *     capacity slot. §9.3 rejects `capacity[a] = k > 1` on one arc outright: it "would
 *     compute an objective value that is not the cost of the allocation it selects". In
 *     the singleton regime `k` does not appear here at all, because an agent accepts at
 *     most one column whatever its queue depth.
 *
 * ── "Assign when any feasible candidate exists", without a big-M ────────────
 * With the `deferral` kill switch thrown there is no `y[l]` variable, yet the flow still
 * needs a way for a Leg with no feasible agent to reach the sink or no feasible flow
 * exists at all. The obvious device — a very large constant on that arc — is exactly what
 * §1.3's unit discipline prohibits: an unregistered number that silently decides
 * behaviour, and one whose magnitude the optimiser is entitled to pay once real costs
 * grow.
 *
 * So costs here are **lexicographic pairs** `(unassigned, milliCU)`, and the
 * remain-queued arc costs `(1, 0)` while every other arc costs `(0, …)`. Addition is
 * componentwise and comparison is lexicographic, which is an ordered abelian group — all
 * the flow algorithm requires. The result is §22.5 rule 1's degraded behaviour *exactly*
 * as written — "immediate assignment when any feasible candidate exists" — expressed as a
 * priority rather than as a price, so no configuration of real costs can outbid it, and
 * no constant needed inventing.
 *
 * With deferral enabled the arc is `(0, C_defer[l])` and the lexicographic first
 * component vanishes from the whole network, leaving precisely §1.4's objective.
 *
 * ── Which algorithm solves it, and why there are two ────────────────────────
 * §20.2 names the algorithm: *"min-cost flow **with cost scaling**"*. `solve/costScaling.js`
 * is that algorithm and is the decision path; this module owns the network it runs on.
 *
 * The **successive-shortest-path** solver this module used to be is retained below as
 * `solveSuccessiveShortestPath()`, for two jobs and no others:
 *
 *   1. **The test oracle.** It is a different algorithm reaching the same optimum, so
 *      `tests/engine/solveCostScaling.test.js` can compare the two on generated instances
 *      rather than compare the new solver against its own opinion. It is a *differential*
 *      oracle and not a complete one: both solvers read the network this module builds, so a
 *      misunderstanding of the formulation itself would be invisible to the comparison.
 *      `tests/engine/solveCostScalingOracle.test.js` closes that by enumerating §1.4's
 *      objective directly from the instance, sharing no code with either solver.
 *   2. **The exactness fallback.** Cost scaling collapses the lexicographic cost into a
 *      single scaled integer, which is exact only while the instance's costs fit inside
 *      float64's exact-integer range. `costScaling.prepare()` establishes that up front and
 *      `costScaling.certify()` proves the answer afterwards; if either declines, the round is
 *      solved here instead. That path is exact and slow rather than fast and uncertified,
 *      which is the correct direction for a Tier 1 module to fail in.
 *
 * Successive shortest paths with Johnson potentials. The initial network is a DAG in the
 * order `S < Legs < Agents < T`, so the initial potentials are obtained by one relaxation
 * pass in topological order — exact even though `γ` may be negative once `C_opportunity`
 * is active — and every subsequent shortest-path search runs on non-negative reduced
 * costs. Each augmentation pushes exactly one unit, so the algorithm terminates in `|L|`
 * searches and the final flow is integral by construction, not by rounding. That is also its
 * limitation: `|L|` Dijkstras over the whole network is `O(m² · k · log)`, measured at ≈ 23.5 s
 * on §20.1's own 500 × 200 shape, which is what re-opened Phase 10.
 *
 * The final potentials **are** the duals: `π[l]` prices the coverage row and `π[a]` the
 * exclusivity row. In this regime §9.3 permits them to be published as exact marginal
 * prices of the integer problem, and `solve/regime.js` is what enforces that permission —
 * this module returns them labelled through `regime.dualsFor()` rather than bare. Cost
 * scaling publishes the potentials its optimality certificate proves dual-feasible, so the
 * label means the same thing on either path — and on the cost-scaling path it is *checked*
 * on every solve rather than inherited from the algorithm's construction.
 *
 * ── Determinism (§9.6 requirement 2) ────────────────────────────────────────
 * Nodes are indexed in canonical order (Legs then agents, each sorted by id) and arcs are
 * appended in the canonical column order the objective builder produced. Every priority
 * comparison ends in the node index, so no tie is ever resolved by heap-insertion order.
 * All arithmetic here is `BigInt`; no float enters the network. `costScaling.js` states its
 * own ordering discipline and its own exactness argument.
 *
 * T6: no clock, no randomness.
 */

const regime = require("./regime");
const costScaling = require("./costScaling");
const { compareStrings, thenBy, canonicalSort } = require("../determinism/ordering");
const { compare: compareMilliCU, add: addMilliCU, subtract: subtractMilliCU, sum: sumMilliCU } = require("../determinism/fixedPoint");

/** Node roles, for readable diagnostics. @structural the network's own node kinds */
const NODE = Object.freeze({
  SOURCE: "SOURCE",
  LEG: "LEG",
  AGENT: "AGENT",
  SINK: "SINK",
});

/** Arc roles, for the decision record. @structural the network's own arc kinds */
const ARC = Object.freeze({
  SUPPLY: "SUPPLY",
  PAIRING: "PAIRING",
  DEFER: "DEFER",
  REMAIN_QUEUED: "REMAIN_QUEUED",
  EXCLUSIVITY: "EXCLUSIVITY",
});

/**
 * The lexicographic cost `(unassigned, milliCU)`. Zero, addition, and comparison over
 * the ordered abelian group the flow algorithm needs.
 * @structural the arity of the lexicographic cost pair
 */
const COST_ARITY = 2;

/**
 * Arcs are stored in forward/reverse pairs, so an arc's reverse sits at `index ^ 1` and
 * the forward arcs are the even indices.
 * @structural the forward/reverse arc pairing of a residual network
 */
const ARC_PAIR_STRIDE = 2;

/** The additive identity of that group. */
const ZERO_COST = Object.freeze([0n, 0n]);

/**
 * @param {readonly bigint[]} a
 * @param {readonly bigint[]} b
 * @returns {bigint[]}
 */
function addCost(a, b) {
  return [addMilliCU(a[0], b[0]), addMilliCU(a[1], b[1])];
}

/**
 * @param {readonly bigint[]} a
 * @param {readonly bigint[]} b
 * @returns {bigint[]}
 */
function subtractCost(a, b) {
  return [subtractMilliCU(a[0], b[0]), subtractMilliCU(a[1], b[1])];
}

/**
 * Lexicographic: the unassigned count dominates, and money breaks its ties.
 *
 * @param {readonly bigint[]} a
 * @param {readonly bigint[]} b
 * @returns {number} -1, 0, or 1
 */
function compareCost(a, b) {
  const first = compareMilliCU(a[0], b[0]);
  if (first !== 0) return first;
  return compareMilliCU(a[1], b[1]);
}

/**
 * @param {readonly bigint[]} a
 * @returns {boolean}
 */
function isNegativeCost(a) {
  return compareCost(a, ZERO_COST) < 0;
}

/**
 * Canonical order for the reported allocation: by Leg id, which is unique within a round.
 * @structural §9.6 requirement 2's order, specialised to the reported allocation
 */
const compareByLegId = thenBy((a, b) => compareStrings(a.legId, b.legId));

/**
 * Build the flow network from a set-partitioning instance.
 *
 * @param {object} instance from `solve/objective.buildInstance()`
 * @returns {{ ok: boolean, network: object|null, problems: string[] }}
 */
function buildNetwork(instance) {
  const problems = [];

  const legIds = instance.legIds;
  const agentIds = instance.agentIds;

  const legNodeOf = new Map(legIds.map((legId, index) => [legId, 1 + index]));
  const agentNodeOf = new Map(agentIds.map((agentId, index) => [agentId, 1 + legIds.length + index]));
  const sourceNode = 0;
  const sinkNode = 1 + legIds.length + agentIds.length;
  const nodeCount = sinkNode + 1;

  const nodeKind = new Array(nodeCount).fill(NODE.LEG);
  nodeKind[sourceNode] = NODE.SOURCE;
  nodeKind[sinkNode] = NODE.SINK;
  for (const node of agentNodeOf.values()) nodeKind[node] = NODE.AGENT;

  /** Forward-star adjacency; each arc's reverse sits at `index ^ 1`. */
  const arcTo = [];
  const arcCapacity = [];
  const arcCost = [];
  const arcRole = [];
  const arcMeta = [];
  const adjacency = Array.from({ length: nodeCount }, () => []);

  const addArc = (from, to, capacity, cost, role, meta) => {
    const index = arcTo.length;
    arcTo.push(to, from);
    arcCapacity.push(capacity, 0);
    arcCost.push(cost, [-cost[0], -cost[1]]);
    arcRole.push(role, role);
    arcMeta.push(meta, meta);
    adjacency[from].push(index);
    adjacency[to].push(index + 1);
    return index;
  };

  // §1.4's coverage row: exactly one unit per Leg.
  for (const legId of legIds) {
    addArc(sourceNode, legNodeOf.get(legId), 1, ZERO_COST, ARC.SUPPLY, { legId });
  }

  // The pairing arcs, one per singleton column, appended in the canonical column order
  // the objective builder produced (§9.6 requirement 2).
  for (const variable of instance.columns) {
    if (variable.legIds.length !== 1) {
      problems.push(
        `column ${variable.identity} covers ${variable.legIds.length} Legs. The min-cost flow is the ` +
          "specialisation for the singleton regime only; a multi-Leg column has no arc representation, which " +
          "is precisely why §9.3 formulates the round as set partitioning rather than as a flow.",
      );
      continue;
    }
    const legNode = legNodeOf.get(variable.legIds[0]);
    const agentNode = agentNodeOf.get(variable.agentId);
    if (legNode === undefined || agentNode === undefined) continue;
    addArc(legNode, agentNode, 1, [0n, variable.costMilliCU], ARC.PAIRING, {
      identity: variable.identity,
      agentId: variable.agentId,
      legId: variable.legIds[0],
      columnIndex: variable.index,
    });
  }

  // The deferral variable, or the remain-queued arc that replaces it when the switch is
  // thrown. Exactly one of the two exists per Leg; see the module header for why the
  // second costs `(1, 0)` rather than a large number.
  const deferByLeg = new Map(instance.deferVariables.map((entry) => [entry.legId, entry]));
  for (const legId of legIds) {
    const defer = deferByLeg.get(legId);
    if (defer) {
      addArc(legNodeOf.get(legId), sinkNode, 1, [0n, defer.costMilliCU], ARC.DEFER, { legId });
    } else {
      addArc(legNodeOf.get(legId), sinkNode, 1, [1n, 0n], ARC.REMAIN_QUEUED, { legId });
    }
  }

  // §9.3's exclusivity row: `≤ 1` per agent.
  for (const agentId of agentIds) {
    addArc(agentNodeOf.get(agentId), sinkNode, 1, ZERO_COST, ARC.EXCLUSIVITY, { agentId });
  }

  return {
    ok: problems.length === 0,
    network: {
      nodeCount,
      sourceNode,
      sinkNode,
      nodeKind,
      legNodeOf,
      agentNodeOf,
      arcTo,
      arcCapacity,
      arcCost,
      arcRole,
      arcMeta,
      adjacency,
      requiredFlow: legIds.length,
    },
    problems,
  };
}

/**
 * Initial Johnson potentials by one relaxation pass in topological order.
 *
 * The initial network is a DAG — every arc runs `S → Leg → Agent → T` or `Leg → T` — so
 * one pass in node-index order is exact, including for negative `γ`. This is what makes
 * every subsequent search a Dijkstra on non-negative reduced costs rather than a
 * Bellman-Ford, and it is exact rather than heuristic because the node indexing *is* a
 * topological order by construction.
 *
 * @param {object} network
 * @returns {bigint[][]} potential per node
 */
function initialPotentials(network) {
  const INFINITE = null;
  const potential = new Array(network.nodeCount).fill(INFINITE);
  potential[network.sourceNode] = [0n, 0n];

  for (let node = 0; node < network.nodeCount; node += 1) {
    if (potential[node] === INFINITE) continue;
    for (const arc of network.adjacency[node]) {
      if (network.arcCapacity[arc] <= 0) continue;
      const target = network.arcTo[arc];
      const relaxed = addCost(potential[node], network.arcCost[arc]);
      if (potential[target] === INFINITE || compareCost(relaxed, potential[target]) < 0) {
        potential[target] = relaxed;
      }
    }
  }

  for (let node = 0; node < network.nodeCount; node += 1) {
    // A node the source cannot reach gets a zero potential: it contributes no reduced
    // cost because no residual arc into it carries flow either.
    if (potential[node] === INFINITE) potential[node] = [0n, 0n];
  }

  return potential;
}

/**
 * A binary heap keyed on `(cost, node)`. The node index is part of the key, so equal
 * distances resolve by a total order rather than by insertion order (§9.6 requirement 2).
 *
 * @returns {object}
 */
function createHeap() {
  const items = [];

  const less = (a, b) => {
    const byCost = compareCost(a.cost, b.cost);
    if (byCost !== 0) return byCost < 0;
    return a.node < b.node;
  };

  return {
    get size() {
      return items.length;
    },
    push(entry) {
      items.push(entry);
      let index = items.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (!less(items[index], items[parent])) break;
        [items[index], items[parent]] = [items[parent], items[index]];
        index = parent;
      }
    },
    pop() {
      const top = items[0];
      const last = items.pop();
      if (items.length > 0) {
        items[0] = last;
        let index = 0;
        for (;;) {
          const left = 2 * index + 1; // @structural binary-heap child index arithmetic
          const right = left + 1;
          let smallest = index;
          if (left < items.length && less(items[left], items[smallest])) smallest = left;
          if (right < items.length && less(items[right], items[smallest])) smallest = right;
          if (smallest === index) break;
          [items[index], items[smallest]] = [items[smallest], items[index]];
          index = smallest;
        }
      }
      return top;
    },
  };
}

/** Which algorithm solved the round. @structural the two solvers this module dispatches to */
const SOLVER = Object.freeze({
  /** §20.2's algorithm, and the decision path. */
  COST_SCALING: "COST_SCALING",
  /** The reference implementation: the test oracle, and the exactness fallback. */
  SUCCESSIVE_SHORTEST_PATH: "SUCCESSIVE_SHORTEST_PATH",
});

/**
 * The refusal a caller reads when `solve()` could not build the network at all.
 *
 * @param {string[]} problems
 * @returns {object}
 */
function refusal(problems) {
  return Object.freeze({
    ok: false,
    regime: regime.REGIME.COLUMN,
    problems: Object.freeze([...problems]),
    assignments: Object.freeze([]),
    deferred: Object.freeze([]),
    unassigned: Object.freeze([]),
    objectiveMilliCU: null,
    duals: null,
    augmentations: 0,
    budgetLimited: false,
  });
}

/**
 * The trivial feasible flow, and the completion of a partial one.
 *
 * Every Leg carries an arc straight to the sink — its deferral variable `y[l]`, or the
 * remain-queued arc that replaces it when the switch is thrown — so the flow that sends one
 * unit `S → l → T` for **every** Leg is feasible on any network this module builds: it meets
 * every coverage row with equality and consumes no agent's exclusivity row at all. It is the
 * allocation `budgets.emptyIncumbent()` already describes in words —
 *
 * > no Leg assigned. Feasible by construction: every Leg remains queued and is solved by the
 * > next round. §9.4 requires the solver to hold a feasible solution at every instant, and
 * > this is the one it holds before it has found a better one.
 *
 * — computed rather than described, which is what §9.4's *"at any point it holds a feasible
 * solution"* requires of a result and not merely of a tracker. Producing it is one pass over
 * the arcs and no arithmetic: it is affordable on exactly the path that cannot afford
 * `prepare()`.
 *
 * Given a partial flow it **completes** rather than replaces: a Leg whose supply arc already
 * carries a unit is left exactly as the solver routed it, and only the Legs the solver never
 * reached are sent to the sink. A Leg that carries no supply also carries no flow on any arc
 * out of its node, so both arcs the completion needs are free and the result is a flow.
 *
 * @param {object} network
 * @param {(arc: number) => number} flowOn forward-arc flow of the partial solution
 * @returns {{ flow: Int32Array, completed: string[] }} the completed flow and the Legs it decided
 */
function completeToFeasibleFlow(network, flowOn) {
  const arcCount = network.arcTo.length;
  const flow = new Int32Array(arcCount);

  const supplyArcOf = new Map();
  const sinkArcOf = new Map();

  for (let arc = 0; arc < arcCount; arc += ARC_PAIR_STRIDE) {
    flow[arc] = flowOn(arc);
    const role = network.arcRole[arc];
    if (role === ARC.SUPPLY) supplyArcOf.set(network.arcMeta[arc].legId, arc);
    else if (role === ARC.DEFER || role === ARC.REMAIN_QUEUED) sinkArcOf.set(network.arcMeta[arc].legId, arc);
  }

  const completed = [];
  for (const [legId, supplyArc] of supplyArcOf) {
    if (flow[supplyArc] > 0) continue;
    const sinkArc = sinkArcOf.get(legId);
    // Every Leg has one by construction — see the module header's network diagram. A Leg
    // without one would be a network-construction defect, and silently skipping it would
    // return an infeasible flow, which is the very thing this function exists to prevent.
    if (sinkArc === undefined) continue;
    flow[supplyArc] = 1;
    flow[sinkArc] = 1;
    completed.push(legId);
  }

  return { flow, completed };
}

/**
 * A valid lower bound on the money objective of **any** feasible flow on this network.
 *
 * Drop the exclusivity rows and every Leg chooses its cheapest arc independently; the
 * relaxation's optimum is therefore no greater than the true optimum, and it is the sum over
 * Legs of the cheapest arc leaving that Leg's node. Every feasible flow routes exactly one
 * unit out of each Leg node, so its money cost is a sum of one arc price per Leg, each at
 * least that Leg's minimum — which is the bound, arc for arc.
 *
 * Money only, deliberately: the lexicographic first component is an assignment *priority* and
 * not a price (§1.3), and `objectiveMilliCU` is the money the bound has to bound.
 *
 * @param {object} network
 * @returns {bigint}
 */
function relaxedMoneyLowerBound(network) {
  const cheapestByLegNode = new Map();

  for (let arc = 0; arc < network.arcTo.length; arc += ARC_PAIR_STRIDE) {
    const tail = network.arcTo[arc + 1];
    if (network.nodeKind[tail] !== NODE.LEG) continue;
    if (network.arcCapacity[arc] <= 0) continue;
    const money = network.arcCost[arc][1];
    const held = cheapestByLegNode.get(tail);
    if (held === undefined || compareMilliCU(money, held) < 0) cheapestByLegNode.set(tail, money);
  }

  // Summed in node order rather than in Map order — the two coincide here, and depending on
  // that coincidence is how an order-dependent total gets written by accident (§9.6).
  const perLeg = [];
  for (let node = 0; node < network.nodeCount; node += 1) {
    const cheapest = cheapestByLegNode.get(node);
    if (cheapest !== undefined) perLeg.push(cheapest);
  }
  return sumMilliCU(perLeg);
}

/**
 * Read the allocation off a solved network, in the canonical order §9.6 requirement 2 asks
 * for. Shared by both solvers, so the two cannot report the same flow differently.
 *
 * @param {object} network
 * @param {(arc: number) => number} flowOn forward-arc flow
 * @param {(node: number) => bigint} priceOf the node's milli-CU potential
 * @param {object} meta `{ solver, budgetLimited, optimalityCertified, diagnostics }`
 * @returns {object}
 */
function assemble(network, flowOn, priceOf, meta) {
  const assignments = [];
  const deferred = [];
  const unassigned = [];
  const costs = [];
  let routed = 0;

  for (let arc = 0; arc < network.arcTo.length; arc += ARC_PAIR_STRIDE) {
    const flow = flowOn(arc);
    if (flow <= 0) continue;
    const role = network.arcRole[arc];
    const detail = network.arcMeta[arc];
    if (role === ARC.SUPPLY) {
      routed += flow;
    } else if (role === ARC.PAIRING) {
      assignments.push({ legId: detail.legId, agentId: detail.agentId, identity: detail.identity, columnIndex: detail.columnIndex });
      costs.push(network.arcCost[arc][1]);
    } else if (role === ARC.DEFER) {
      deferred.push({ legId: detail.legId });
      costs.push(network.arcCost[arc][1]);
    } else if (role === ARC.REMAIN_QUEUED) {
      unassigned.push({ legId: detail.legId });
    }
  }

  // The duals. `π[l]` prices the coverage row, `π[a]` the exclusivity row. Only the
  // milli-CU component is a price: the lexicographic first component is the
  // assignment-priority ordering, not money, and publishing it as a price would be a
  // dimensioned quantity fabricated from an ordering (§1.3).
  const legPrices = Object.create(null);
  for (const [legId, node] of network.legNodeOf) legPrices[legId] = priceOf(node);
  const agentPrices = Object.create(null);
  for (const [agentId, node] of network.agentNodeOf) agentPrices[agentId] = priceOf(node);

  const objectiveMilliCU = sumMilliCU(costs);

  // §9.4 asks a budget-limited stop to return "the incumbent **with its bound**", and the two
  // are not the same number once the solve was cut short. On a completed solve they are: §9.3
  // makes the singleton regime's LP relaxation integral, so the optimum this solver reached
  // *is* the bound, computed as an equality rather than asserted as one. On a budget-limited
  // stop the incumbent is ε-optimal — measured at +36.5 % on the 500 × 200 shape at a 250 ms
  // budget — and publishing `bound = objective` there would report a proven optimum the run
  // explicitly did not prove, alongside the `optimalityCertified: false` that says it did not.
  // So the bound becomes a real one: the exclusivity-relaxed lower bound, which is valid for
  // every feasible flow on this network and is therefore valid for the optimum.
  const boundMilliCU = meta.budgetLimited === true ? relaxedMoneyLowerBound(network) : objectiveMilliCU;

  return Object.freeze({
    ok: true,
    regime: regime.REGIME.SINGLETON,
    problems: Object.freeze([]),
    assignments: Object.freeze(canonicalSort(assignments, compareByLegId)),
    deferred: Object.freeze(canonicalSort(deferred, compareByLegId)),
    unassigned: Object.freeze(canonicalSort(unassigned, compareByLegId)),
    objectiveMilliCU,
    boundMilliCU,
    // The **integrality** gap, which §9.3 puts at exactly zero in this regime whatever the
    // budget did: the constraint matrix is totally unimodular, so the LP relaxation has an
    // integral optimum and there is no LP–IP gap to report. The distance between a
    // budget-limited incumbent and `boundMilliCU` is a *truncation* gap and a different
    // quantity; it is `objectiveMilliCU − boundMilliCU`, available to any caller that wants
    // it, and it is deliberately not folded in here — §9.3 reports distinct approximations
    // separately "because they bound different things and summing them would bound neither".
    lpIpGapMilliCU: subtractMilliCU(objectiveMilliCU, objectiveMilliCU),
    // Labelled with what they are on *this* solve, not with what the regime entitles a solve
    // to. §9.3 permits the singleton regime to publish exact marginal prices of the integer
    // problem, and a solve that stopped on §9.4's budget did not produce any: cost scaling
    // publishes the ε-optimal prices there and the reference solver's potentials price a
    // partially routed network. Both used to be labelled `EXACT_INTEGER_MARGINAL_PRICE` with
    // `validForCalibrationWithoutQualification: true`, which is the one thing `solve/regime.js`
    // exists to prevent — §8.3.1's λ_zone calibration reads that field and cannot tell an
    // ε-optimal price from a marginal one by inspection.
    duals: regime.dualsFor(regime.REGIME.SINGLETON, legPrices, { proven: meta.budgetLimited !== true }),
    agentDuals: regime.dualsFor(regime.REGIME.SINGLETON, agentPrices, { proven: meta.budgetLimited !== true }),
    augmentations: routed,
    budgetLimited: meta.budgetLimited === true,
    branched: false,
    solver: meta.solver,
    // Whether *this* solve carries a proof, not whether the algorithm is believed to be
    // exact. Successive shortest paths is exact by construction and computes no certificate,
    // so it reports `null` rather than `true` — an unchecked claim and a checked one are not
    // the same fact and this field does not let them be read as one.
    optimalityCertified: meta.optimalityCertified === undefined ? null : meta.optimalityCertified,
    solverDiagnostics: Object.freeze(meta.diagnostics || {}),
    network: Object.freeze({
      nodeCount: network.nodeCount,
      arcCount: network.arcTo.length / ARC_PAIR_STRIDE,
      requiredFlow: network.requiredFlow,
    }),
  });
}

/**
 * §20.2's solver, on a built network. Returns `null` when it declines the instance or cannot
 * certify its answer, which is the caller's signal to fall back rather than to fail.
 *
 * @param {object} network
 * @param {object} settings
 * @returns {{ result: object|null, reason: string|null }}
 */
function solveByCostScaling(network, settings) {
  // Before `prepare()`, not after. Collapsing and flattening a 100 000-column network is tens
  // of milliseconds of work, and a round that has already spent its budget should not spend
  // that too. The check is here rather than inside `run()` so it happens exactly once — a
  // second call would record a second §9.4 wall-clock verdict for one exceedance.
  //
  // What it returns is the **trivial feasible flow**, not the zero flow. Returning the zero
  // flow was a defect: `assemble()` reads the allocation off the arcs carrying flow, so a
  // round that stopped here named no Leg at all — not assigned, not deferred, not queued —
  // while reporting `ok: true`, and with the `deferral` switch thrown `objective.validate()`
  // called that **feasible**, because a coverage row reading `≤ 1` is satisfied by zero. §9.4
  // requires the incumbent to be "a feasible solution and a bound"; an allocation accounting
  // for none of the round's Legs is not one, and a caller cannot tell it apart from a round
  // that genuinely decided nothing was worth doing. The trivial flow is a real feasible
  // solution of this instance, it accounts for every Leg, it costs one pass over the arcs
  // rather than a `prepare()`, and it is exactly the incumbent §9.4 says the solver holds
  // before it has found a better one.
  if (settings.budgets) {
    const permitted = settings.budgets.continueSolving();
    if (!permitted.ok) {
      const trivial = completeToFeasibleFlow(network, () => 0);
      return {
        result: assemble(network, (arc) => trivial.flow[arc], () => 0n, {
          solver: SOLVER.COST_SCALING,
          budgetLimited: true,
          optimalityCertified: false,
          diagnostics: {
            scalingPhases: 0,
            relabels: 0,
            pushes: 0,
            finalEpsilon: null,
            dualsTight: false,
            // Named, so a reader of the decision record can tell "every Leg was deferred
            // because the round ran out of time before it looked at any of them" apart from
            // "every Leg was deferred because deferral was cheaper", which price the same.
            trivialIncumbent: true,
            legsDecidedByTrivialCompletion: trivial.completed.length,
          },
        }),
        reason: null,
      };
    }
  }

  const prepared = costScaling.prepare(network);
  if (!prepared.ok) return { result: null, reason: `${prepared.refusal}: ${prepared.detail}` };

  const state = costScaling.run(prepared.prepared, { budgets: settings.budgets });
  if (state.outcome !== costScaling.OUTCOME.OK) {
    return { result: null, reason: `run ended ${state.outcome}` };
  }

  const residual = prepared.prepared.arcResidual;
  const capacity = network.arcCapacity;

  // A budget-limited stop leaves a feasible, whole allocation that is ε-optimal rather than
  // optimal. No exact marginal price exists for it, so the certificate cannot succeed — and
  // attempting it would spend |V| relaxation passes establishing that at exactly the moment
  // §9.4 says to return the incumbent. The incumbent is returned with the ε-optimal prices and
  // `optimalityCertified: false`, which is the honest pair; claiming the proof would be worse
  // than not having it, and paying for a proof that cannot exist would be worse than either.
  let potentialMoney;
  let certified;
  let dualsTight;

  if (state.budgetLimited) {
    potentialMoney = costScaling.approximatePrices(prepared.prepared, state).potentialMoney;
    certified = false;
    dualsTight = false;
  } else {
    // Which arcs the published prices must price *exactly*: the priced arcs that carry flow.
    // §9.3 calls the singleton-regime duals "exact marginal prices of the integer problem", and
    // a marginal price is one at which the chosen column is indifferent — reduced cost zero. The
    // structural arcs (`S → Leg`, `agent → T`) are excluded deliberately: forcing them tight as
    // well over-constrains the dual and admits no solution, which is why the successive-
    // shortest-path solver's own potentials do not make them tight either.
    const tighten = new Uint8Array(network.arcTo.length);
    for (let arc = 0; arc < network.arcTo.length; arc += ARC_PAIR_STRIDE) {
      const role = network.arcRole[arc];
      if (role !== ARC.PAIRING && role !== ARC.DEFER) continue;
      if (capacity[arc] - residual[arc] > 0) tighten[arc] = 1;
    }

    const proof = costScaling.certify(prepared.prepared, state, { tighten });
    if (!proof.ok) return { result: null, reason: `certificate failed: ${proof.problems.join("; ")}` };

    potentialMoney = proof.potentialMoney;
    certified = true;
    dualsTight = proof.dualsTight;
  }

  return {
    result: assemble(
      network,
      (arc) => capacity[arc] - residual[arc],
      (node) => BigInt(potentialMoney[node]),
      {
        solver: SOLVER.COST_SCALING,
        budgetLimited: state.budgetLimited,
        optimalityCertified: certified,
        diagnostics: {
          scalingPhases: state.phasesCompleted,
          relabels: state.relabels,
          pushes: state.pushes,
          finalEpsilon: state.epsilon,
          dualsTight,
        },
      },
    ),
    reason: null,
  };
}

/**
 * The reference solver: successive shortest paths with Johnson potentials.
 *
 * **Not the decision path.** §20.2 specifies cost scaling and `solve()` runs it; this exists
 * as the oracle equivalence tests compare against, and as the exact fallback for an instance
 * cost scaling declines. Exported so a test can name it explicitly — a test that reached it
 * through `solve()` would be testing the dispatch rather than the algorithm.
 *
 * @param {object} instance from `solve/objective.buildInstance()`
 * @param {object} [options]
 * @param {object} [options.budgets] a `solve/budgets.js` tracker; consulted between
 *   augmentations so an oversized instance still returns its incumbent (§9.4)
 * @param {string} [options.fallbackFrom] why the decision path handed this instance over
 * @returns {object} the allocation, the objective, the duals, and the bound
 */
function solveSuccessiveShortestPath(instance, options) {
  const settings = options || {};

  const built = buildNetwork(instance);
  if (!built.ok) return refusal(built.problems);

  return solveNetworkBySuccessiveShortestPath(built.network, settings);
}

/**
 * @param {object} network
 * @param {object} settings
 * @returns {object}
 */
function solveNetworkBySuccessiveShortestPath(network, settings) {
  const potential = initialPotentials(network);
  const arcFlowed = new Array(network.arcTo.length).fill(0);

  let augmentations = 0;
  let budgetLimited = false;

  while (augmentations < network.requiredFlow) {
    if (settings.budgets) {
      const permitted = settings.budgets.continueSolving();
      if (!permitted.ok) {
        // §9.4's anytime requirement, at the only point where stopping is safe: between
        // augmentations, where the flow is integral and every unit already pushed is a
        // valid partial allocation. Stopping mid-augmentation would leave a fractional
        // flow, which is not a solution at all.
        //
        // Integral is not the same as *complete*, and this used to stop at merely integral:
        // the Legs the loop had not yet reached carried no flow on any arc, so `assemble()`
        // reported them in none of its three lists and the round lost them silently — 3 of 20
        // Legs named, `ok: true`, and with deferral thrown `objective.validate()` called it
        // feasible. The remaining Legs are therefore routed to the sink before the result is
        // read, which is the same trivial completion the cost-scaling path takes and leaves
        // every unit the search *did* place exactly where it placed it.
        budgetLimited = true;
        break;
      }
    }

    const distance = new Array(network.nodeCount).fill(null);
    const viaArc = new Array(network.nodeCount).fill(-1);
    const settled = new Array(network.nodeCount).fill(false);

    distance[network.sourceNode] = [0n, 0n];
    const heap = createHeap();
    heap.push({ node: network.sourceNode, cost: [0n, 0n] });

    while (heap.size > 0) {
      const { node } = heap.pop();
      if (settled[node]) continue;
      settled[node] = true;

      for (const arc of network.adjacency[node]) {
        const residual = network.arcCapacity[arc] - arcFlowed[arc];
        if (residual <= 0) continue;
        const target = network.arcTo[arc];
        if (settled[target]) continue;

        // The reduced cost. Non-negative for every residual arc, because the potentials
        // are exact shortest distances in the previous residual network — which is what
        // Johnson's transformation buys and what makes Dijkstra applicable despite the
        // negative γ values `C_opportunity` can produce.
        const reduced = addCost(subtractCost(network.arcCost[arc], potential[target]), potential[node]);
        const candidateDistance = addCost(distance[node], reduced);

        if (distance[target] === null || compareCost(candidateDistance, distance[target]) < 0) {
          distance[target] = candidateDistance;
          viaArc[target] = arc;
          heap.push({ node: target, cost: candidateDistance });
        }
      }
    }

    if (distance[network.sinkNode] === null) {
      // Unreachable sink. Every Leg has a path to the sink by construction (a defer arc
      // or a remain-queued arc), so this is a defect in network construction rather than
      // an infeasible instance — reported as such instead of silently returning a
      // partial flow.
      return Object.freeze({
        ok: false,
        regime: regime.REGIME.SINGLETON,
        problems: [
          "the sink became unreachable before every Leg was routed. Each Leg carries either a deferral arc or a " +
            "remain-queued arc, so a feasible flow of value |L| exists by construction; unreachability is a " +
            "network-construction defect, not an infeasible round.",
        ],
        assignments: Object.freeze([]),
        deferred: Object.freeze([]),
        unassigned: Object.freeze([]),
        objectiveMilliCU: null,
        duals: null,
        augmentations,
        budgetLimited: false,
      });
    }

    // Nodes the search did not reach are advanced by the sink's distance rather than
    // left behind: they are reachable, if at all, only at a cost at least that high, and
    // an un-advanced potential would admit a negative reduced cost into the next search
    // — the one thing Dijkstra may not see.
    const sinkDistance = distance[network.sinkNode];
    for (let node = 0; node < network.nodeCount; node += 1) {
      potential[node] = addCost(potential[node], distance[node] === null ? sinkDistance : distance[node]);
    }

    // Every capacity on this network is 1, so an augmenting path carries exactly one
    // unit. Stated rather than computed, because a bottleneck search would imply
    // capacities this network deliberately does not have (§9.3).
    let node = network.sinkNode;
    while (node !== network.sourceNode) {
      const arc = viaArc[node];
      arcFlowed[arc] += 1;
      arcFlowed[arc ^ 1] -= 1;
      node = network.arcTo[arc ^ 1];
    }

    augmentations += 1;
  }

  const completion = budgetLimited ? completeToFeasibleFlow(network, (arc) => arcFlowed[arc]) : null;

  return assemble(network, (arc) => (completion ? completion.flow[arc] : arcFlowed[arc]), (node) => potential[node][1], {
    solver: SOLVER.SUCCESSIVE_SHORTEST_PATH,
    budgetLimited,
    // Exact by construction and computing no proof of it — see `assemble`.
    optimalityCertified: undefined,
    diagnostics: {
      augmentations,
      fallbackFrom: settings.fallbackFrom || null,
      trivialIncumbent: completion !== null && augmentations === 0,
      legsDecidedByTrivialCompletion: completion ? completion.completed.length : 0,
    },
  });
}

/**
 * Solve the round in the singleton regime.
 *
 * §20.2's cost-scaling min-cost flow, with the reference solver behind it for the instances
 * cost scaling declines and for the answers it cannot prove. Both are exact; the fallback is
 * a correctness guarantee, not a degraded mode, and `solver` on the result says which ran.
 *
 * @param {object} instance from `solve/objective.buildInstance()`
 * @param {object} [options]
 * @param {object} [options.budgets] a `solve/budgets.js` tracker; consulted between scaling
 *   phases so an oversized instance still returns its incumbent (§9.4)
 * @param {string} [options.solver] force one solver, for tests. Absent in the decision path.
 * @returns {object} the allocation, the objective, the duals, and the bound
 */
function solve(instance, options) {
  const settings = options || {};

  const built = buildNetwork(instance);
  if (!built.ok) return refusal(built.problems);

  if (settings.solver === SOLVER.SUCCESSIVE_SHORTEST_PATH) {
    return solveNetworkBySuccessiveShortestPath(built.network, settings);
  }

  const scaled = solveByCostScaling(built.network, settings);
  if (scaled.result !== null) return scaled.result;

  return solveNetworkBySuccessiveShortestPath(built.network, { ...settings, fallbackFrom: scaled.reason });
}

module.exports = {
  NODE,
  ARC,
  SOLVER,
  ARC_PAIR_STRIDE,
  ZERO_COST,
  addCost,
  subtractCost,
  compareCost,
  isNegativeCost,
  buildNetwork,
  initialPotentials,
  createHeap,
  solve,
  solveSuccessiveShortestPath,
};

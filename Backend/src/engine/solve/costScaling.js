"use strict";

/**
 * §20.2's solver: **min-cost flow with cost scaling** — **Tier 1**, decision path.
 *
 * > | Solve — singleton regime | O(m · k · log) typical for min-cost flow **with cost
 * > scaling**; worst case polynomial | Integral, exact, no branching (§9.3) |
 *
 * This module owns the algorithm. `solve/minCostFlow.js` owns the network — which arc means
 * what, which capacity is `1` and why (§9.3) — and hands it here to be solved. The split is
 * deliberate: the network is the *model* and is frozen by the specification, while the
 * algorithm is an implementation choice §20.2 names, and the two were previously entangled
 * in one file where changing the second looked like changing the first.
 *
 * ── Why the algorithm had to change ─────────────────────────────────────────
 * The shipped solver was successive shortest paths: one Dijkstra per Leg, so `O(m² · k · log)`
 * on a batch of `m` Legs with `k` candidates each. Measured at §20.1's own shape — 500 Legs ×
 * 200 candidates — that is ≈ 23.5 s against a 250 ms round target, and the exponent in Legs
 * measured ≈ 2, exactly as the analysis predicts. Cost scaling does not augment once per unit
 * of flow at all; it moves *all* the flow at once under a tolerance `ε` and then tightens `ε`,
 * so the Leg count enters through the node count of a single sweep rather than as a multiplier
 * on the number of sweeps.
 *
 * ── The algorithm (Goldberg–Tarjan push-relabel with ε-scaling) ─────────────
 * Prices `p(v)` per node; the reduced cost of a residual arc `(v,w)` is
 * `c_p(v,w) = c(v,w) + p(v) − p(w)`. A pseudoflow is **ε-optimal** when every residual arc
 * has `c_p ≥ −ε`. The invariant is maintained, never merely hoped for:
 *
 *   - **`refine(ε)`** first saturates every residual arc with `c_p < 0`, which makes the
 *     pseudoflow 0-optimal and therefore ε-optimal for the new, smaller ε.
 *   - **push** moves flow along an *admissible* arc — one with `c_p < 0` — which cannot
 *     violate ε-optimality, because the arc it creates in the reverse direction has
 *     `c_p > 0`.
 *   - **relabel** sets `p(v) = max{ p(w) − c(v,w) − ε : (v,w) residual }`. The maximising arc
 *     becomes admissible at exactly `−ε`, and every other residual arc out of `v` keeps
 *     `c_p ≥ −ε` because `p(v)` is their maximum. It is a strict *decrease* of at least `ε`
 *     whenever no admissible arc existed, which is what bounds the number of relabels.
 *   - **`refine` returns** when no node holds excess. The pseudoflow is then a genuine flow
 *     and it is ε-optimal.
 *
 * Costs are pre-multiplied by `n + 1` (`scale` below), so that `ε < 1` on the scaled costs is
 * `ε < 1/(n+1)` on the originals — and a flow that is `1/(n+1)`-optimal on integer costs is
 * **optimal**, because any improving cycle would have to improve by at least 1 and can contain
 * at most `n` arcs. The scaling loop therefore ends at `ε = 1` and the answer is exact rather
 * than near-optimal. There is no tolerance anywhere in the result.
 *
 * ── The lexicographic cost, collapsed exactly ───────────────────────────────
 * `minCostFlow.js` prices arcs as lexicographic pairs `(unassigned, milliCU)` so that
 * §22.5 rule 1 — "immediate assignment when any feasible candidate exists" — is a priority
 * rather than a big-M price. ε-scaling needs a single scalar magnitude to halve, so the pair
 * is collapsed to `w = unassigned · K + milliCU` with
 *
 * ```
 *   K = 1 + 2 · n · max|milliCU|
 * ```
 *
 * `K` is **derived from the instance**, not configured: any simple path or cycle in this
 * network has at most `n` arcs, so the money component of any cost the algorithm ever compares
 * is bounded by `n · max|milliCU| < K/2`. The collapsed comparison is therefore *identical* to
 * the lexicographic one, arc for arc — not an approximation of it, and not the unregistered
 * constant §1.3 prohibits, because no configuration of real costs can reach `K` by
 * construction rather than by assumption.
 *
 * ── The result carries its own proof ────────────────────────────────────────
 * The collapse and the floating-point-free integer arithmetic are both *devices for finding a
 * candidate flow*. Nothing downstream trusts them. `certify()` recomputes exact lexicographic
 * node potentials on the final residual network and checks the two conditions of LP duality
 * directly:
 *
 *   1. the flow is feasible — every node's excess is zero and every arc is within capacity;
 *   2. every residual arc has a lexicographically non-negative reduced cost.
 *
 * Together those *prove* the flow is a minimum-cost flow, for this instance, on this run. A
 * solver that returns an optimality certificate cannot silently return a near-optimum, which
 * is the property §9.3's "the solve is **exact**" needs and the property a numerical shortcut
 * would otherwise put at risk. When the certificate does not hold — an instance whose costs are
 * too wide for exact integer arithmetic, or any defect in this module — the caller falls back
 * to the reference successive-shortest-path solver rather than returning an uncertified answer.
 *
 * The same potentials are the published duals. §9.3 permits them to be exact marginal prices
 * of the integer problem in this regime, and dual feasibility is precisely what condition 2
 * checks, so the label is earned on every solve rather than asserted once in a comment.
 *
 * ── Determinism (§9.6 requirement 2) ────────────────────────────────────────
 * Every loop here is over an index range, never over a Map, a Set, or an object's keys. Active
 * nodes are held in a FIFO seeded in ascending node order; each node's arcs are scanned in the
 * canonical order `minCostFlow.js` appended them, which is the canonical column order
 * `objective.buildInstance()` produced. Relabelling takes the maximum over that same order and
 * the first maximum wins. No tie is resolved by insertion order, by hashing, or by iteration
 * order of anything.
 *
 * T6: no clock, no randomness.
 */

/**
 * Arcs are stored in forward/reverse pairs, so an arc's reverse sits at `index ^ 1`.
 * @structural the forward/reverse arc pairing of a residual network, shared with minCostFlow.js
 */
const ARC_PAIR_STRIDE = 2;

/**
 * The factor `ε` shrinks by per scaling phase. Two is the textbook choice and the one the
 * `O(log(n·C))` phase count is stated for.
 * @structural the ε-scaling schedule
 */
const SCALING_ALPHA = 2;

/**
 * The largest integer JavaScript numbers represent exactly. Every intermediate the scaling
 * arithmetic can produce is checked against this rather than assumed to fit.
 * @structural the float64 exact-integer width
 */
const EXACT_INTEGER_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * Headroom the arithmetic needs above the largest scaled arc cost before the fast path is
 * worth attempting at all: prices move, and a run with no room to move in is a run that will
 * abort on its first relabel.
 * @structural the minimum price headroom, as a multiple of the largest scaled arc cost
 */
const MINIMUM_HEADROOM = 8;

/**
 * The denominator that turns the remaining exact-integer range into a price bound. A reduced
 * cost is `cost + p(tail) − p(head)`, so two prices and one cost must fit; four leaves the
 * relabel candidate `p(head) − cost − ε` room as well.
 * @structural the reduced-cost expression's price arity, with margin
 */
const PRICE_LIMIT_DIVISOR = 4;

/**
 * A relabel budget per scaling phase, as a multiple of `n²`. Goldberg–Tarjan bound the
 * relabels of one phase at `O(n²)`; this is that bound with margin, and exceeding it means a
 * defect in this module rather than a hard instance. It is a guard against a non-terminating
 * loop, not a quality knob: tripping it aborts to the reference solver, which is exact.
 * @structural the O(n²) relabel bound of one scaling phase, with margin
 */
const RELABEL_LIMIT_FACTOR = 8;

/** How a run ended. @structural the algorithm's own outcomes */
const OUTCOME = Object.freeze({
  OK: "OK",
  /** A node held excess with no residual arc to move it along — a network-construction defect. */
  STUCK: "STUCK",
  /** A price left the exactly-representable range. The fallback is exact; this is not. */
  OVERFLOW: "OVERFLOW",
  /** The relabel guard tripped. */
  RELABEL_LIMIT: "RELABEL_LIMIT",
});

/**
 * Why an instance was refused the cost-scaling path. Each names the exact quantity that did
 * not fit, so a refusal in production is diagnosable rather than merely observed.
 * @structural the preconditions of exact integer scaling
 */
const REFUSAL = Object.freeze({
  MONEY_TOO_WIDE: "MONEY_TOO_WIDE",
  COLLAPSE_TOO_WIDE: "COLLAPSE_TOO_WIDE",
  SCALED_COST_TOO_WIDE: "SCALED_COST_TOO_WIDE",
});

/**
 * @param {bigint} value
 * @returns {bigint}
 */
function absBig(value) {
  return value < 0n ? -value : value;
}

/**
 * Collapse the lexicographic network into exact scaled integers, and establish that every
 * intermediate the algorithm can produce is exactly representable.
 *
 * Called once per solve: `run()` consumes the residual capacities it returns, so a prepared
 * network is single-use rather than a cached description of the instance.
 *
 * @param {object} network from `minCostFlow.buildNetwork()`
 * @returns {{ ok: boolean, refusal: string|null, detail: string|null, prepared: object|null }}
 */
function prepare(network) {
  const nodeCount = network.nodeCount;
  const arcCount = network.arcTo.length;
  const span = BigInt(nodeCount);

  let maxAbsMoney = 0n;
  for (let arc = 0; arc < arcCount; arc += ARC_PAIR_STRIDE) {
    const money = absBig(network.arcCost[arc][1]);
    if (money > maxAbsMoney) maxAbsMoney = money;
  }

  // The exact potentials `certify()` computes are sums of at most `n` arc costs, so this is
  // the widest money quantity the certificate's arithmetic ever holds.
  const moneyCeiling = span * maxAbsMoney;
  if (moneyCeiling > BigInt(EXACT_INTEGER_LIMIT)) {
    return {
      ok: false,
      refusal: REFUSAL.MONEY_TOO_WIDE,
      detail: `a path's money component may reach ${moneyCeiling} milli-CU, beyond exact integer arithmetic`,
      prepared: null,
    };
  }

  // @structural the lexicographic collapse constant. The factor two is the collapse's own
  // arithmetic, not a tuning choice: it puts every money sum the algorithm can compare
  // strictly inside ±K/2, which is what makes `unassigned · K + milliCU` order-identical to
  // the pair rather than an approximation of it.
  const collapseK = 1n + 2n * moneyCeiling;
  if (collapseK > BigInt(EXACT_INTEGER_LIMIT)) {
    return {
      ok: false,
      refusal: REFUSAL.COLLAPSE_TOO_WIDE,
      detail: `the lexicographic collapse constant is ${collapseK}, beyond exact integer arithmetic`,
      prepared: null,
    };
  }

  // `ε < 1` on costs scaled by `n + 1` is `ε < 1/(n + 1)` on the originals, which on integer
  // costs is optimality rather than near-optimality — see the module header.
  const scale = span + 1n;

  let maxAbsScaled = 0n;
  const collapsed = new Array(arcCount);
  for (let arc = 0; arc < arcCount; arc += ARC_PAIR_STRIDE) {
    const cost = network.arcCost[arc];
    const value = cost[0] * collapseK + cost[1];
    collapsed[arc] = value * scale;
    collapsed[arc + 1] = -collapsed[arc];
    const magnitude = absBig(collapsed[arc]);
    if (magnitude > maxAbsScaled) maxAbsScaled = magnitude;
  }

  if (maxAbsScaled * BigInt(MINIMUM_HEADROOM) > BigInt(EXACT_INTEGER_LIMIT)) {
    return {
      ok: false,
      refusal: REFUSAL.SCALED_COST_TOO_WIDE,
      detail: `the largest scaled arc cost is ${maxAbsScaled}, which leaves no room for prices to move`,
      prepared: null,
    };
  }

  const maxAbsScaledNumber = Number(maxAbsScaled);
  // Whatever range is left after the widest arc cost, shared between the two prices a reduced
  // cost holds. Derived from what is representable rather than from the worst-case price bound,
  // because the runtime guard is what makes exactness unconditional and a static bound would
  // only refuse instances the run would have handled.
  const priceLimit = Math.floor((EXACT_INTEGER_LIMIT - maxAbsScaledNumber) / PRICE_LIMIT_DIVISOR);

  const arcHead = new Int32Array(arcCount);
  const arcResidual = new Int32Array(arcCount);
  // The capacities as built, kept alongside the residuals the run consumes. `certify()`'s
  // first condition is feasibility, and feasibility is conservation *and* capacity; without
  // the original capacities the second half cannot be checked at all, only argued.
  const arcCapacity = new Int32Array(arcCount);
  const arcCostScaled = new Float64Array(arcCount);
  const arcCostUnassigned = new Float64Array(arcCount);
  const arcCostMoney = new Float64Array(arcCount);

  for (let arc = 0; arc < arcCount; arc += 1) {
    arcHead[arc] = network.arcTo[arc];
    arcResidual[arc] = network.arcCapacity[arc];
    arcCapacity[arc] = network.arcCapacity[arc];
    arcCostScaled[arc] = Number(collapsed[arc]);
    arcCostUnassigned[arc] = Number(network.arcCost[arc][0]);
    arcCostMoney[arc] = Number(network.arcCost[arc][1]);
  }

  // Forward-star as a flat CSR pair, in exactly the adjacency order `buildNetwork` produced.
  // The flattening is what makes the inner loop an index range rather than an array of arrays,
  // and it preserves the canonical order rather than re-deriving it.
  const adjacencyOffset = new Int32Array(nodeCount + 1);
  for (let node = 0; node < nodeCount; node += 1) {
    adjacencyOffset[node + 1] = adjacencyOffset[node] + network.adjacency[node].length;
  }
  const adjacencyArc = new Int32Array(adjacencyOffset[nodeCount]);
  for (let node = 0; node < nodeCount; node += 1) {
    const arcs = network.adjacency[node];
    const base = adjacencyOffset[node];
    for (let index = 0; index < arcs.length; index += 1) adjacencyArc[base + index] = arcs[index];
  }

  return {
    ok: true,
    refusal: null,
    detail: null,
    prepared: {
      nodeCount,
      arcCount,
      sourceNode: network.sourceNode,
      sinkNode: network.sinkNode,
      requiredFlow: network.requiredFlow,
      arcHead,
      arcResidual,
      arcCapacity,
      arcCostScaled,
      arcCostUnassigned,
      arcCostMoney,
      adjacencyOffset,
      adjacencyArc,
      collapseK: Number(collapseK),
      scale: Number(scale),
      epsilonStart: Math.max(1, maxAbsScaledNumber),
      priceLimit,
    },
  };
}

/**
 * Run the ε-scaling loop to optimality.
 *
 * @param {object} prepared from `prepare()`
 * @param {object} [options]
 * @param {object} [options.budgets] a `solve/budgets.js` tracker, consulted **between scaling
 *   phases** — the only point at which the pseudoflow is a genuine, feasible, integral flow
 *   (§9.4). Stopping mid-phase would return a pseudoflow, which is not an allocation at all.
 * @returns {{ outcome: string, price: Float64Array, phases: number, relabels: number,
 *   pushes: number, budgetLimited: boolean, phasesCompleted: number }}
 */
function run(prepared, options) {
  const settings = options || {};
  const {
    nodeCount,
    arcCount,
    sourceNode,
    sinkNode,
    requiredFlow,
    arcHead,
    arcResidual,
    arcCostScaled,
    adjacencyOffset,
    adjacencyArc,
    priceLimit,
  } = prepared;

  const price = new Float64Array(nodeCount);
  const excess = new Int32Array(nodeCount);
  const current = new Int32Array(nodeCount);
  excess[sourceNode] = requiredFlow;
  excess[sinkNode] = -requiredFlow;

  // A FIFO of active nodes. `inQueue` bounds it at one entry per node, so the ring never
  // wraps onto a live entry.
  const queue = new Int32Array(nodeCount + 1);
  const inQueue = new Uint8Array(nodeCount);
  let queueHead = 0;
  let queueTail = 0;
  let queueSize = 0;

  const relabelLimit = RELABEL_LIMIT_FACTOR * nodeCount * nodeCount;

  let relabels = 0;
  let pushes = 0;
  let phasesCompleted = 0;
  let budgetLimited = false;

  const enqueue = (node) => {
    if (inQueue[node] === 1) return;
    inQueue[node] = 1;
    queue[queueTail] = node;
    queueTail = queueTail + 1 === queue.length ? 0 : queueTail + 1;
    queueSize += 1;
  };

  const dequeue = () => {
    const node = queue[queueHead];
    queueHead = queueHead + 1 === queue.length ? 0 : queueHead + 1;
    queueSize -= 1;
    inQueue[node] = 0;
    return node;
  };

  /**
   * Move `node`'s excess along admissible arcs, relabelling when none remain, until it holds
   * none. The current-arc pointer is what makes the repeated scans amortise: an arc rejected
   * before a relabel is not re-examined until the next relabel resets the pointer.
   *
   * @param {number} node
   * @param {number} epsilon
   * @returns {string} an `OUTCOME`
   */
  const discharge = (node, epsilon) => {
    const end = adjacencyOffset[node + 1];

    while (excess[node] > 0) {
      let index = current[node];

      while (index < end) {
        const arc = adjacencyArc[index];
        if (arcResidual[arc] > 0) {
          const head = arcHead[arc];
          if (arcCostScaled[arc] + price[node] - price[head] < 0) {
            const capacity = arcResidual[arc];
            const delta = excess[node] < capacity ? excess[node] : capacity;
            arcResidual[arc] = capacity - delta;
            arcResidual[arc ^ 1] += delta;
            excess[node] -= delta;
            excess[head] += delta;
            pushes += 1;
            if (excess[head] > 0) enqueue(head);
            if (excess[node] === 0) {
              current[node] = index;
              return OUTCOME.OK;
            }
          }
        }
        index += 1;
      }

      let best = null;
      for (let scan = adjacencyOffset[node]; scan < end; scan += 1) {
        const arc = adjacencyArc[scan];
        if (arcResidual[arc] <= 0) continue;
        const candidate = price[arcHead[arc]] - arcCostScaled[arc] - epsilon;
        if (best === null || candidate > best) best = candidate;
      }

      // Every Leg reaches the sink by construction and every arc has a residual reverse once
      // it carries flow, so a node holding excess always has somewhere to send it. Reaching
      // here is a network-construction defect, reported as one rather than looped on.
      if (best === null) return OUTCOME.STUCK;
      if (best < -priceLimit) return OUTCOME.OVERFLOW;

      price[node] = best;
      relabels += 1;
      if (relabels > relabelLimit) return OUTCOME.RELABEL_LIMIT;
      current[node] = adjacencyOffset[node];
    }

    return OUTCOME.OK;
  };

  /**
   * One scaling phase: re-establish 0-optimality by saturating what the smaller ε made
   * admissible, then discharge until no excess remains.
   *
   * @param {number} epsilon
   * @returns {string} an `OUTCOME`
   */
  const refine = (epsilon) => {
    for (let arc = 0; arc < arcCount; arc += 1) {
      if (arcResidual[arc] <= 0) continue;
      const tail = arcHead[arc ^ 1];
      const head = arcHead[arc];
      if (arcCostScaled[arc] + price[tail] - price[head] < 0) {
        const delta = arcResidual[arc];
        arcResidual[arc] = 0;
        arcResidual[arc ^ 1] += delta;
        excess[tail] -= delta;
        excess[head] += delta;
      }
    }

    queueHead = 0;
    queueTail = 0;
    queueSize = 0;
    inQueue.fill(0);
    for (let node = 0; node < nodeCount; node += 1) {
      current[node] = adjacencyOffset[node];
      if (excess[node] > 0) enqueue(node);
    }

    while (queueSize > 0) {
      const node = dequeue();
      if (excess[node] <= 0) continue;
      const outcome = discharge(node, epsilon);
      if (outcome !== OUTCOME.OK) return outcome;
    }

    return OUTCOME.OK;
  };

  let epsilon = prepared.epsilonStart;
  let outcome = OUTCOME.OK;

  for (;;) {
    // §9.4's anytime requirement, at the only points where stopping is safe: **between**
    // phases. `refine` returns when no node holds excess, so after one completed phase the
    // flow is whole and feasible — every Leg is routed, to an agent or to the sink — and
    // merely ε-optimal rather than optimal. That is a strictly better incumbent than a
    // partially routed batch.
    //
    // `phasesCompleted > 0` is what makes "between phases" true rather than nearly true. The
    // loop's first iteration is not between phases: it is *before* the first one, where the
    // pseudoflow is the empty one and every unit of supply is still sitting on the source.
    // Stopping there returned a result that `assemble()` read as an allocation naming no Leg
    // at all — not a partial allocation but an absent one, reported as feasible. §9.4 asks the
    // incumbent to be "a feasible solution and a bound", and before the first phase there is
    // no such thing to return, so the budget cannot be honoured by returning early here. It is
    // honoured by the phase after this one, and the overshoot that costs is one phase at the
    // coarsest ε — measured at 3.5 ms (median of 5) against a ~400 ms whole solve at §20.1's
    // own 500 × 200 shape, which is the price of the contract holding unconditionally rather
    // than usually.
    if (settings.budgets && phasesCompleted > 0) {
      const permitted = settings.budgets.continueSolving();
      if (!permitted.ok) {
        budgetLimited = true;
        break;
      }
    }

    outcome = refine(epsilon);
    if (outcome !== OUTCOME.OK) break;
    phasesCompleted += 1;

    if (epsilon === 1) break;
    epsilon = Math.max(1, Math.ceil(epsilon / SCALING_ALPHA));
  }

  return {
    outcome,
    price,
    excess,
    epsilon,
    phasesCompleted,
    relabels,
    pushes,
    budgetLimited,
  };
}

/**
 * The ε-optimal prices, decomposed back into the lexicographic pair they collapse.
 *
 * For a **budget-limited** stop only. The flow is then feasible but ε-optimal rather than
 * optimal, so no exact marginal price exists to publish and `certify()` cannot succeed by
 * construction — running it anyway would spend `|V|` relaxation passes proving a negative at
 * exactly the moment the round has run out of time, which is the opposite of what §9.4's
 * anytime requirement asks for. These prices are `O(n)` to produce and are reported alongside
 * `optimalityCertified: false`, so nothing downstream can read them as exact.
 *
 * @param {object} prepared from `prepare()`
 * @param {object} state from `run()`
 * @returns {{ potentialMoney: Float64Array, potentialUnassigned: Float64Array }}
 */
function approximatePrices(prepared, state) {
  const { nodeCount, sourceNode, collapseK, scale } = prepared;
  const potentialUnassigned = new Float64Array(nodeCount);
  const potentialMoney = new Float64Array(nodeCount);

  for (let node = 0; node < nodeCount; node += 1) {
    const collapsedPrice = Math.round(state.price[node] / scale);
    const unassigned = Math.round(collapsedPrice / collapseK);
    potentialUnassigned[node] = unassigned;
    potentialMoney[node] = collapsedPrice - unassigned * collapseK;
  }

  const anchorUnassigned = potentialUnassigned[sourceNode];
  const anchorMoney = potentialMoney[sourceNode];
  for (let node = 0; node < nodeCount; node += 1) {
    potentialUnassigned[node] -= anchorUnassigned;
    potentialMoney[node] -= anchorMoney;
  }

  return { potentialMoney, potentialUnassigned };
}

/**
 * Prove the flow. Recomputes exact lexicographic potentials on the final residual network and
 * checks LP duality's two conditions directly — see the module header for why the proof is
 * computed rather than argued.
 *
 * The potentials are also the answer to §9.3's dual question, so they are returned whether or
 * not the certificate holds and the caller decides what a failed certificate means.
 *
 * @param {object} prepared from `prepare()`
 * @param {object} state from `run()`
 * @param {object} [options]
 * @param {Uint8Array} [options.tighten] arcs whose reduced cost must come out *exactly* zero —
 *   the priced arcs carrying flow. Relaxing a saturated arc in its forward direction as well as
 *   its residual reverse turns the pair of inequalities into an equality, which is what makes
 *   the published prices marginal prices rather than merely feasible ones. See below.
 * @returns {{ ok: boolean, problems: string[], potentialMoney: Float64Array,
 *   potentialUnassigned: Float64Array, converged: boolean, dualsTight: boolean }}
 */
function certify(prepared, state, options) {
  const { nodeCount, arcCount, sourceNode, arcHead, arcResidual, arcCapacity, arcCostUnassigned, arcCostMoney } = prepared;
  const settings = options || {};

  const problems = [];
  const potentialUnassigned = new Float64Array(nodeCount);
  const potentialMoney = new Float64Array(nodeCount);
  let overflowed = false;

  /**
   * Bellman–Ford in the exact lexicographic pair, from a zero seed.
   *
   * Zero-seeded rather than seeded from the scaling prices, and that is not merely
   * convenient. Relaxing from zero converges to the **pointwise maximal** potential
   * satisfying the system, and the system is shift-invariant, so a solution exists under the
   * zero ceiling exactly when one exists at all — the seed costs nothing in generality. A
   * seed taken from the scaling prices lands instead on whichever vertex of the dual polytope
   * it happens to be nearest, which is dual-*feasible* but is not a marginal price.
   *
   * @param {Uint8Array|null} tighten
   * @returns {boolean} whether it converged
   */
  const relax = (tighten) => {
    potentialUnassigned.fill(0);
    potentialMoney.fill(0);

    for (let pass = 0; pass <= nodeCount; pass += 1) {
      let changed = false;
      for (let arc = 0; arc < arcCount; arc += 1) {
        if (arcResidual[arc] <= 0 && (tighten === null || tighten[arc] !== 1)) continue;
        const tail = arcHead[arc ^ 1];
        const head = arcHead[arc];
        const reachedUnassigned = arcCostUnassigned[arc] + potentialUnassigned[tail];
        const reachedMoney = arcCostMoney[arc] + potentialMoney[tail];
        if (
          reachedUnassigned < potentialUnassigned[head] ||
          (reachedUnassigned === potentialUnassigned[head] && reachedMoney < potentialMoney[head])
        ) {
          if (!Number.isSafeInteger(reachedMoney) || !Number.isSafeInteger(reachedUnassigned)) {
            overflowed = true;
            return false;
          }
          potentialUnassigned[head] = reachedUnassigned;
          potentialMoney[head] = reachedMoney;
          changed = true;
        }
      }
      if (!changed) return true;
    }
    return false;
  };

  // First with complementary slackness forced on the priced arcs carrying flow. That system is
  // strictly tighter than the certificate needs, and where it is feasible its solution is the
  // marginal price §9.3 asks for. Where it is not — a degenerate instance whose optimal flow
  // admits no such potential — the residual system alone still proves the flow optimal, and the
  // result says which of the two was used rather than publishing the weaker one as the stronger.
  let dualsTight = settings.tighten ? relax(settings.tighten) : false;
  let converged = dualsTight;
  if (!converged && !overflowed) converged = relax(null);

  if (overflowed) {
    problems.push(
      "an exact potential left the exactly-representable integer range while proving the flow. " +
        "The certificate is the reason the scaled arithmetic can be trusted, so it is never taken on trust itself.",
    );
    return { ok: false, problems, potentialMoney, potentialUnassigned, converged: false, dualsTight: false };
  }

  if (!converged) {
    problems.push(
      "the residual network of the returned flow still admits an improving cycle after |V| relaxation passes, so " +
        "the flow is not a minimum-cost flow. §9.3 requires the singleton-regime solve to be exact.",
    );
    return { ok: false, problems, potentialMoney, potentialUnassigned, converged, dualsTight: false };
  }

  // Condition 1 — feasibility, which is conservation **and** capacity. Excess is the
  // flow-conservation residue, so all-zero is exactly "every Leg routed, nothing left in
  // transit"; the capacity half is the arc-pair identity below.
  for (let node = 0; node < nodeCount; node += 1) {
    if (state.excess[node] !== 0) {
      problems.push(
        `node ${node} holds ${state.excess[node]} units of excess, so the returned pseudoflow is not a flow. ` +
          "Flow conservation is the first half of the optimality certificate.",
      );
      break;
    }
  }

  // The capacity half, computed rather than argued. `residual + residual(reverse)` is
  // invariant under push and relabel, so a pair whose residuals no longer sum to the pair's
  // total capacity has had flow created or destroyed, and a negative residual is flow beyond
  // capacity in one direction or below zero in the other. Both are cheap to check and neither
  // was checked before: this condition was stated in the module header and argued from the
  // push/relabel invariants, which is precisely the kind of claim the certificate exists to
  // stop taking on trust.
  if (arcCapacity) {
    for (let arc = 0; arc < arcCount; arc += ARC_PAIR_STRIDE) {
      const reverse = arc ^ 1;
      if (arcResidual[arc] < 0 || arcResidual[reverse] < 0) {
        problems.push(
          `arc ${arc} has residual capacities (${arcResidual[arc]}, ${arcResidual[reverse]}), one of which is ` +
            "negative, so the returned flow exceeds a capacity. Capacity is the second half of feasibility.",
        );
        break;
      }
      if (arcResidual[arc] + arcResidual[reverse] !== arcCapacity[arc] + arcCapacity[reverse]) {
        problems.push(
          `arc ${arc}'s residuals sum to ${arcResidual[arc] + arcResidual[reverse]} against a pair capacity of ` +
            `${arcCapacity[arc] + arcCapacity[reverse]}, so flow was created or destroyed on it rather than moved.`,
        );
        break;
      }
    }
  }

  // Condition 2 — dual feasibility, which for these potentials is also complementary
  // slackness: an arc carrying flow has a residual reverse, and both directions being
  // non-negative forces the arc's own reduced cost to zero.
  for (let arc = 0; arc < arcCount; arc += 1) {
    if (arcResidual[arc] <= 0) continue;
    const tail = arcHead[arc ^ 1];
    const head = arcHead[arc];
    const reducedUnassigned = arcCostUnassigned[arc] + potentialUnassigned[tail] - potentialUnassigned[head];
    const reducedMoney = arcCostMoney[arc] + potentialMoney[tail] - potentialMoney[head];
    if (reducedUnassigned < 0 || (reducedUnassigned === 0 && reducedMoney < 0)) {
      problems.push(
        `residual arc ${arc} has reduced cost (${reducedUnassigned}, ${reducedMoney}), which is negative. ` +
          "A negative reduced cost on a residual arc is an unexploited improvement, so the flow is not optimal.",
      );
      break;
    }
  }

  // Anchored at the source, which is the convention the successive-shortest-path solver's
  // potentials already carry, so the two solvers' published prices differ by no constant.
  const anchorUnassigned = potentialUnassigned[sourceNode];
  const anchorMoney = potentialMoney[sourceNode];
  for (let node = 0; node < nodeCount; node += 1) {
    potentialUnassigned[node] -= anchorUnassigned;
    potentialMoney[node] -= anchorMoney;
  }

  return { ok: problems.length === 0, problems, potentialMoney, potentialUnassigned, converged, dualsTight };
}

module.exports = {
  ARC_PAIR_STRIDE,
  SCALING_ALPHA,
  EXACT_INTEGER_LIMIT,
  OUTCOME,
  REFUSAL,
  prepare,
  run,
  certify,
  approximatePrices,
};

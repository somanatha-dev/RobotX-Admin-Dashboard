"use strict";

/**
 * Tiered packing feasibility (§15.3) — **Tier 0**.
 *
 * > Exact 3D bin packing with orientation and stacking constraints is NP-hard and
 * > cannot run for 200 candidates in a 250 ms budget. Tiered evaluation gives exactness
 * > where it matters and speed everywhere else.
 *
 * | Tier | Check | Cost | Result |
 * |---|---|---|---|
 * | 1 | Necessary conditions: total mass ≤ limit; total volume ≤ capacity × `payload.packing_efficiency`; every item's smallest cross-section fits some compartment's aperture; thermal, hazard, and security classes have a compatible compartment | O(items) | Rejects most infeasible pairings immediately |
 * | 2 | Greedy constructive packing: first-fit-decreasing by volume with permitted orientations, respecting stacking, access order, and segregation | O(items × compartments) | Accepts with a concrete loading plan |
 * | 3 | Bounded exact search: branch-and-bound with a node budget, only when tier 2 fails and the pairing is otherwise attractive | bounded | Resolves the marginal cases |
 * | 4 | Memoised result keyed by `(container_config, item_multiset_signature)` | O(1) | Repeated identical consignments cost nothing |
 *
 * ── The three verdicts, and why the third is not a failure ─────────────────
 * > If tier 3 exhausts its budget without a result, the outcome is `INDETERMINATE` with
 * > policy `DENY` — the engine declines rather than dispatching a load it could not
 * > prove fits.
 *
 * `BUDGET_EXHAUSTED` is reported as its own verdict rather than folded into
 * `INFEASIBLE`, because they are different facts and call for different responses: an
 * infeasible consignment needs a bigger vehicle, an exhausted budget needs a bigger
 * budget. F23 maps `BUDGET_EXHAUSTED` to `INDETERMINATE`, and its class I policy turns
 * that into a denial — which is the `DENY` half, applied at the gate rather than
 * written into the search.
 *
 * ── Tier 2's output is not merely a yes ────────────────────────────────────
 * > Tier 2's loading plan is transmitted in the offer, so the agent and any human loader
 * > know the intended arrangement, and the plan is verifiable against compartment
 * > sensors on load.
 *
 * So the result carries `compartmentLoads` — which is also exactly what F26 reads to
 * check segregation and lock classes, and what `custodyEvidence.js` reconciles the
 * manifest against.
 *
 * ── Determinism ────────────────────────────────────────────────────────────
 * Both search tiers walk items in a canonical order (volume descending, then item id)
 * and compartments in the container's declared ordinal order. A packing verdict that
 * depended on input order would make the same pairing feasible in one round and
 * infeasible in the next (§9.6).
 *
 * Tier 0 (T0-04). Decision path (T6): no clock, no randomness, no store — the tier-4
 * cache client is injected, exactly as `feasibility/cache.js`'s is.
 */

const crypto = require("crypto");

const { canonicalJson } = require("../determinism/ordering");
const container = require("./container");
const spec = require("./spec");

/**
 * §15.3's verdicts, identical to `feasibility/predicates/f23.js`'s `PACKING_VERDICT`.
 * A drift between the two would make every packing result unreadable at the gate.
 * @structural the specification's own packing outcomes
 */
const VERDICT = Object.freeze({
  FEASIBLE: "FEASIBLE",
  INFEASIBLE: "INFEASIBLE",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
});

/**
 * The tier that produced a verdict, so the diagnostic surface can distinguish "rejected
 * by a necessary condition" from "no placement found by an exact search".
 * @structural the specification's own tier numbering
 */
const TIER = Object.freeze({ NECESSARY: 1, GREEDY: 2, EXACT: 3, MEMOISED: 4 });

/** Redis key prefix for the tier-4 memo. @structural the plan's own key prefix */
const CACHE_KEY_PREFIX = "engine:pack";

const DIGEST_ALGORITHM = "sha256";

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The canonical item order both search tiers walk: largest volume first, ties broken by
 * item id. First-fit-**decreasing** is §15.3's own tier-2 algorithm, and the tie-break
 * is what makes it deterministic when two items are the same size.
 *
 * @param {object[]} items
 * @returns {object[]}
 */
function canonicalItemOrder(items) {
  return [...items].sort((a, b) => {
    const volumeA = isNumber(a.volumeLitres) ? a.volumeLitres : 0;
    const volumeB = isNumber(b.volumeLitres) ? b.volumeLitres : 0;
    if (volumeB !== volumeA) return volumeB - volumeA;
    return String(a.itemId).localeCompare(String(b.itemId));
  });
}

/**
 * The tier-4 key: `(container_config, item_multiset_signature)`.
 *
 * A **multiset** signature, not a list: two consignments of the same items in a
 * different order are the same packing problem, and keying on the order would miss the
 * repeat that §15.3 says should cost nothing. The item's identity for this purpose is
 * its geometry and its classes — not its id, which differs on every order.
 *
 * @param {object} normalisedContainer
 * @param {object[]} items
 * @returns {{ containerConfig: string, itemSignature: string, key: string }}
 */
function signature(normalisedContainer, items) {
  const containerShape = {
    modelId: normalisedContainer.modelId,
    aggregateLimits: normalisedContainer.aggregateLimits,
    compartments: (normalisedContainer.compartments || []).map((compartment) => ({
      ordinal: compartment.ordinal,
      internalLengthMm: compartment.internalLengthMm,
      internalWidthMm: compartment.internalWidthMm,
      internalHeightMm: compartment.internalHeightMm,
      apertureWidthMm: compartment.apertureWidthMm,
      apertureHeightMm: compartment.apertureHeightMm,
      maxMassKg: compartment.maxMassKg,
      thermalClass: compartment.thermalClass,
      thermalMinC: compartment.thermalMinC,
      thermalMaxC: compartment.thermalMaxC,
      lockClass: compartment.lockClass,
      cleanlinessClass: compartment.cleanlinessClass,
      blockedBy: compartment.blockedBy,
    })),
  };

  const itemShapes = items
    .map((item) => ({
      lengthMm: item.lengthMm,
      widthMm: item.widthMm,
      heightMm: item.heightMm,
      volumeLitres: item.volumeLitres,
      massKg: item.massKg,
      massToleranceKg: item.massToleranceKg,
      stackable: item.stackable,
      loadBearingLimitKg: item.loadBearingLimitKg,
      thermalMinC: item.thermalMinC,
      thermalMaxC: item.thermalMaxC,
      securityClass: item.securityClass,
      hazardClasses: [...(item.hazardClasses || [])].sort(),
      incompatibleHazardClasses: [...((item.segregation && item.segregation.incompatibleHazardClasses) || [])].sort(),
      orientationConstraints: item.orientationConstraints,
    }))
    .map((shape) => canonicalJson(shape))
    .sort();

  const containerConfig = crypto.createHash(DIGEST_ALGORITHM).update(canonicalJson(containerShape)).digest("hex");
  const itemSignature = crypto.createHash(DIGEST_ALGORITHM).update(itemShapes.join("\n")).digest("hex");

  return { containerConfig, itemSignature, key: `${CACHE_KEY_PREFIX}:${containerConfig}:${itemSignature}` };
}

/**
 * Build the result shape F23, F25, and F26 read.
 *
 * @param {object} input
 * @returns {object}
 */
function result(input) {
  const source = input || {};
  return Object.freeze({
    verdict: source.verdict,
    tier: source.tier ?? null,
    bindingConstraint: source.bindingConstraint ?? null,
    // F25's input. Null when the consignment declares no thermal requirement, which is
    // exactly the case F25 treats as "does not bind".
    thermalAssignment: source.thermalAssignment ?? null,
    // F26's input, and the offer's loading plan.
    compartmentLoads: Object.freeze(source.compartmentLoads || []),
    loadingPlan: source.loadingPlan ?? null,
    nodesExplored: isNumber(source.nodesExplored) ? source.nodesExplored : null,
    diagnostics: Object.freeze(source.diagnostics || []),
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Tier 1 — necessary conditions, O(items)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * §15.3 tier 1, exactly the four conditions the table names.
 *
 * Every one is *necessary*: failing one proves infeasibility, and passing all four
 * proves nothing. That asymmetry is why a tier-1 pass falls through to tier 2 rather
 * than accepting.
 *
 * @param {object} normalisedContainer
 * @param {object[]} items
 * @param {number} packingEfficiency `payload.packing_efficiency`
 * @returns {{ ok: boolean, verdict: string|null, bindingConstraint: string|null,
 *             reason: string|null, indeterminate: boolean }}
 */
function tierOne(normalisedContainer, items, packingEfficiency) {
  const limits = normalisedContainer.aggregateLimits || {};

  // (i) total mass ≤ limit, at the **upper bound** of every tolerance (§15.1).
  const mass = spec.totalMassKg({ items }, spec.MASS_READING.FEASIBILITY);
  if (!mass.ok) {
    return {
      ok: false,
      verdict: null,
      bindingConstraint: "TOTAL_MASS",
      reason: `a declared mass or tolerance is missing (${mass.missing.join(", ")}); feasibility uses the upper bound of the tolerance (§15.1)`,
      indeterminate: true,
    };
  }
  if (!isNumber(limits.totalMassLimitKg)) {
    return { ok: false, verdict: null, bindingConstraint: "TOTAL_MASS", reason: "the container states no total mass limit", indeterminate: true };
  }
  if (mass.massKg > limits.totalMassLimitKg) {
    return {
      ok: false,
      verdict: VERDICT.INFEASIBLE,
      bindingConstraint: "TOTAL_MASS",
      reason: `${mass.massKg} kg at the tolerance upper bound exceeds the ${limits.totalMassLimitKg} kg container limit`,
      indeterminate: false,
    };
  }

  // (ii) total volume ≤ capacity × payload.packing_efficiency.
  if (!isNumber(packingEfficiency) || packingEfficiency <= 0 || packingEfficiency > 1) {
    return { ok: false, verdict: null, bindingConstraint: "TOTAL_VOLUME", reason: "payload.packing_efficiency is unresolved", indeterminate: true };
  }
  if (!isNumber(limits.totalVolumeLitres)) {
    return { ok: false, verdict: null, bindingConstraint: "TOTAL_VOLUME", reason: "the container states no total volume", indeterminate: true };
  }
  let totalVolume = 0;
  for (const item of items) {
    if (!isNumber(item.volumeLitres)) {
      return { ok: false, verdict: null, bindingConstraint: "TOTAL_VOLUME", reason: `item "${String(item.itemId)}" states no volume`, indeterminate: true };
    }
    totalVolume += item.volumeLitres;
  }
  const usableVolume = limits.totalVolumeLitres * packingEfficiency;
  if (totalVolume > usableVolume) {
    return {
      ok: false,
      verdict: VERDICT.INFEASIBLE,
      bindingConstraint: "TOTAL_VOLUME",
      reason: `${totalVolume} L exceeds the ${usableVolume} L usable volume (${limits.totalVolumeLitres} L × packing efficiency ${packingEfficiency})`,
      indeterminate: false,
    };
  }

  // (iii) and (iv): every item has at least one compartment whose aperture it passes
  // and whose thermal, hazard, and security classes it is compatible with.
  for (const item of items) {
    const admissible = container.admissibleCompartments(item, normalisedContainer);
    if (admissible.compartments.length > 0) continue;

    const indeterminate = admissible.rejections.some((rejection) => rejection.outcome === "INDETERMINATE");
    const first = admissible.rejections[0];
    return {
      ok: false,
      verdict: indeterminate ? null : VERDICT.INFEASIBLE,
      bindingConstraint: first ? first.check.toUpperCase() : "NO_ADMISSIBLE_COMPARTMENT",
      reason: `item "${String(item.itemId)}" has no admissible compartment: ${admissible.rejections.map((r) => r.reason).join("; ")}`,
      indeterminate,
    };
  }

  return { ok: true, verdict: null, bindingConstraint: null, reason: null, indeterminate: false };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Placement bookkeeping shared by tiers 2 and 3
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * May this item be added to this compartment's current contents?
 *
 * Four checks, all of them from §15.2 and §15.3: remaining internal volume, the
 * compartment's own mass limit, pairwise segregation against everything already there,
 * and the stacking rule — an item may only rest on something declared stackable and
 * within that item's load-bearing limit.
 *
 * @param {object} compartment
 * @param {object[]} contents
 * @param {object} item
 * @returns {{ ok: boolean, reason: string|null }}
 */
function canPlace(compartment, contents, item) {
  const fit = container.fitsInternal(item, compartment);
  if (fit.fits !== true) return { ok: false, reason: fit.reason || "the item does not fit the compartment" };

  if (isNumber(compartment.maxMassKg)) {
    const used = contents.reduce((sum, placed) => sum + (spec.itemMassForFeasibilityKg(placed) ?? 0), 0);
    const adding = spec.itemMassForFeasibilityKg(item);
    if (adding === null) return { ok: false, reason: `item "${String(item.itemId)}" states no mass tolerance` };
    if (used + adding > compartment.maxMassKg) {
      return { ok: false, reason: `compartment ${String(compartment.compartmentId)} mass limit ${compartment.maxMassKg} kg exceeded` };
    }
  }

  const capacityLitres =
    isNumber(compartment.internalLengthMm) && isNumber(compartment.internalWidthMm) && isNumber(compartment.internalHeightMm)
      ? (compartment.internalLengthMm * compartment.internalWidthMm * compartment.internalHeightMm) / 1_000_000 // @structural cubic millimetres per litre
      : null;
  if (capacityLitres !== null && isNumber(item.volumeLitres)) {
    const used = contents.reduce((sum, placed) => sum + (isNumber(placed.volumeLitres) ? placed.volumeLitres : 0), 0);
    if (used + item.volumeLitres > capacityLitres) {
      return { ok: false, reason: `compartment ${String(compartment.compartmentId)} has no remaining volume` };
    }
  }

  for (const placed of contents) {
    const segregation = container.segregationCompatible(placed, item);
    if (!segregation.ok) return { ok: false, reason: segregation.reason };
  }

  // Stacking: anything already in the compartment may end up underneath. An item that
  // is not stackable may not have another placed with it, and an item whose
  // load-bearing limit the newcomer exceeds may not either.
  for (const placed of contents) {
    if (!placed.stackable) {
      return { ok: false, reason: `item "${String(placed.itemId)}" is not stackable and cannot share compartment ${String(compartment.compartmentId)}` };
    }
    const adding = spec.itemMassForFeasibilityKg(item);
    if (isNumber(placed.loadBearingLimitKg) && adding !== null && adding > placed.loadBearingLimitKg) {
      return {
        ok: false,
        reason: `item "${String(item.itemId)}" at ${adding} kg exceeds the ${placed.loadBearingLimitKg} kg load-bearing limit of "${String(placed.itemId)}"`,
      };
    }
  }

  return { ok: true, reason: null };
}

/**
 * Turn a placement map into the `compartmentLoads` shape F26 reads.
 *
 * @param {object} normalisedContainer
 * @param {Map<string, object[]>} placement
 * @returns {object[]}
 */
function compartmentLoadsFrom(normalisedContainer, placement) {
  return (normalisedContainer.compartments || [])
    .filter((compartment) => (placement.get(compartment.compartmentId) || []).length > 0)
    .map((compartment) =>
      Object.freeze({
        compartmentId: compartment.compartmentId,
        lockClass: compartment.lockClass,
        ordinal: compartment.ordinal,
        items: Object.freeze(
          (placement.get(compartment.compartmentId) || []).map((item) =>
            Object.freeze({
              itemId: item.itemId,
              hazardClasses: item.hazardClasses,
              securityClass: item.securityClass,
              segregation: item.segregation,
              massKg: item.massKg,
              massToleranceKg: item.massToleranceKg,
              volumeLitres: item.volumeLitres,
              thermalMinC: item.thermalMinC,
              thermalMaxC: item.thermalMaxC,
            }),
          ),
        ),
      }),
    );
}

/**
 * The single thermal assignment F25 reads.
 *
 * F25 asks one question — can the compartment holding the temperature-controlled goods
 * hold their range for long enough — so the assignment reports the compartment those
 * goods went to. A consignment with no thermal requirement yields `null`, which is F25's
 * "does not bind" case.
 *
 * @param {object} normalisedContainer
 * @param {Map<string, object[]>} placement
 * @returns {object|null}
 */
function thermalAssignmentFrom(normalisedContainer, placement) {
  for (const compartment of normalisedContainer.compartments || []) {
    const contents = placement.get(compartment.compartmentId) || [];
    const thermal = contents.find((item) => isNumber(item.thermalMinC) || isNumber(item.thermalMaxC));
    if (!thermal) continue;
    return Object.freeze({
      compartmentId: compartment.compartmentId,
      thermalClass: compartment.thermalClass,
      thermalMinC: compartment.thermalMinC,
      thermalMaxC: compartment.thermalMaxC,
      activeThermal: compartment.activeThermal,
      thermalHoldSeconds: compartment.thermalHoldSeconds,
      itemIds: Object.freeze(contents.filter((item) => isNumber(item.thermalMinC) || isNumber(item.thermalMaxC)).map((item) => item.itemId)),
    });
  }
  return null;
}

/**
 * The per-compartment occupancy intervals `consumption.js` charges
 * `β_payload_thermal` over.
 *
 * > It is charged over `t_occupied(k)` — the interval the compartment actually holds
 * > conditioned goods.
 *
 * Produced here because this module is what decides *which* compartment holds what;
 * `loadState.js` turns the placement into per-stop intervals.
 *
 * @param {object} normalisedContainer
 * @param {Map<string, object[]>} placement
 * @returns {object[]}
 */
function conditionedCompartments(normalisedContainer, placement) {
  return (normalisedContainer.compartments || [])
    .map((compartment) => ({
      compartmentId: compartment.compartmentId,
      thermalClass: compartment.thermalClass,
      itemIds: (placement.get(compartment.compartmentId) || [])
        .filter((item) => isNumber(item.thermalMinC) || isNumber(item.thermalMaxC))
        .map((item) => item.itemId),
    }))
    .filter((row) => row.itemIds.length > 0);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Tier 2 — greedy first-fit-decreasing
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * §15.3 tier 2. Accepts with a concrete loading plan, or falls through to tier 3.
 *
 * @param {object} normalisedContainer
 * @param {object[]} items canonical order
 * @returns {{ ok: boolean, placement: Map<string, object[]>|null, reason: string|null }}
 */
function tierTwo(normalisedContainer, items) {
  const placement = new Map();
  for (const compartment of normalisedContainer.compartments || []) placement.set(compartment.compartmentId, []);

  for (const item of items) {
    const admissible = container.admissibleCompartments(item, normalisedContainer).compartments;
    const chosen = admissible.find((compartment) => canPlace(compartment, placement.get(compartment.compartmentId) || [], item).ok);
    if (!chosen) {
      return { ok: false, placement: null, reason: `first-fit-decreasing found no compartment for item "${String(item.itemId)}"` };
    }
    placement.get(chosen.compartmentId).push(item);
  }

  return { ok: true, placement, reason: null };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Tier 3 — bounded branch and bound
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * §15.3 tier 3. Depth-first over item→compartment assignments with a node budget.
 *
 * The search is exhaustive within its budget, so exhausting the item list is a *proof*
 * of feasibility and exhausting the search space without exhausting the budget is a
 * proof of infeasibility. Running out of budget is neither, and is reported as
 * `BUDGET_EXHAUSTED` rather than as either — which is the distinction §15.3 rests the
 * `INDETERMINATE` outcome on.
 *
 * @param {object} normalisedContainer
 * @param {object[]} items canonical order
 * @param {number} nodeBudget `payload.packing_node_budget`
 * @returns {{ verdict: string, placement: Map<string, object[]>|null, nodes: number }}
 */
function tierThree(normalisedContainer, items, nodeBudget) {
  const placement = new Map();
  for (const compartment of normalisedContainer.compartments || []) placement.set(compartment.compartmentId, []);

  const admissibleByItem = items.map((item) => container.admissibleCompartments(item, normalisedContainer).compartments);
  let nodes = 0;
  let exhausted = false;

  const search = (index) => {
    if (index >= items.length) return true;
    for (const compartment of admissibleByItem[index]) {
      if (nodes >= nodeBudget) {
        exhausted = true;
        return false;
      }
      nodes += 1;
      const contents = placement.get(compartment.compartmentId);
      if (!canPlace(compartment, contents, items[index]).ok) continue;
      contents.push(items[index]);
      if (search(index + 1)) return true;
      contents.pop();
      if (exhausted) return false;
    }
    return false;
  };

  const found = search(0);
  if (found) return { verdict: VERDICT.FEASIBLE, placement, nodes };
  if (exhausted) return { verdict: VERDICT.BUDGET_EXHAUSTED, placement: null, nodes };
  return { verdict: VERDICT.INFEASIBLE, placement: null, nodes };
}

/* ═══════════════════════════════════════════════════════════════════════════
   The tiered evaluation
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Evaluate packing feasibility across the four tiers.
 *
 * @param {object} input
 * @param {object} input.container a raw `ContainerModel` or an already-normalised one
 * @param {object} input.consignment a `spec.normalise()` consignment
 * @param {number} input.packingEfficiency `payload.packing_efficiency`
 * @param {number} input.nodeBudget `payload.packing_node_budget`
 * @param {boolean} [input.exactSearchPermitted] §15.3 runs tier 3 "only when tier 2
 *   fails **and the pairing is otherwise attractive**". The attractiveness judgement is
 *   the candidate pipeline's, not this module's, so it arrives as a decision rather
 *   than being made here. Defaults to true so a direct caller gets the strongest
 *   available answer.
 * @returns {object} a `result()`
 */
function evaluate(input) {
  const source = input || {};

  const normalised = source.container && Array.isArray(source.container.compartments) && source.container.aggregateLimits
    ? { ok: true, container: source.container, problems: [] }
    : container.normalise(source.container);

  if (!normalised.ok) {
    return result({
      verdict: VERDICT.BUDGET_EXHAUSTED,
      tier: TIER.NECESSARY,
      bindingConstraint: "CONTAINER_MODEL",
      diagnostics: normalised.problems,
    });
  }

  const items = Array.isArray(source.consignment && source.consignment.items) ? source.consignment.items : null;
  if (!items || items.length === 0) {
    return result({
      verdict: VERDICT.BUDGET_EXHAUSTED,
      tier: TIER.NECESSARY,
      bindingConstraint: "CONSIGNMENT",
      diagnostics: ["the consignment states no items, so no placement can be proved (§15.3)"],
    });
  }

  const ordered = canonicalItemOrder(items);

  const necessary = tierOne(normalised.container, ordered, source.packingEfficiency);
  if (!necessary.ok) {
    return result({
      // A tier-1 condition that could not be *evaluated* is not a proof of
      // infeasibility. It resolves to BUDGET_EXHAUSTED, which F23 reads as
      // INDETERMINATE and class I denies — the engine declines rather than dispatching
      // a load it could not prove fits.
      verdict: necessary.indeterminate ? VERDICT.BUDGET_EXHAUSTED : VERDICT.INFEASIBLE,
      tier: TIER.NECESSARY,
      bindingConstraint: necessary.bindingConstraint,
      diagnostics: [necessary.reason],
    });
  }

  const greedy = tierTwo(normalised.container, ordered);
  if (greedy.ok) {
    return result({
      verdict: VERDICT.FEASIBLE,
      tier: TIER.GREEDY,
      compartmentLoads: compartmentLoadsFrom(normalised.container, greedy.placement),
      thermalAssignment: thermalAssignmentFrom(normalised.container, greedy.placement),
      loadingPlan: Object.freeze({
        method: "FIRST_FIT_DECREASING",
        conditionedCompartments: Object.freeze(conditionedCompartments(normalised.container, greedy.placement)),
      }),
    });
  }

  if (source.exactSearchPermitted === false) {
    return result({
      verdict: VERDICT.BUDGET_EXHAUSTED,
      tier: TIER.GREEDY,
      bindingConstraint: "GREEDY_PLACEMENT",
      diagnostics: [greedy.reason, "the exact search was not run; §15.3 admits tier 3 only when the pairing is otherwise attractive"],
    });
  }

  if (!Number.isInteger(source.nodeBudget) || source.nodeBudget < 1) {
    return result({
      verdict: VERDICT.BUDGET_EXHAUSTED,
      tier: TIER.EXACT,
      bindingConstraint: "NODE_BUDGET",
      diagnostics: ["payload.packing_node_budget is unresolved"],
    });
  }

  const exact = tierThree(normalised.container, ordered, source.nodeBudget);
  if (exact.verdict === VERDICT.FEASIBLE) {
    return result({
      verdict: VERDICT.FEASIBLE,
      tier: TIER.EXACT,
      nodesExplored: exact.nodes,
      compartmentLoads: compartmentLoadsFrom(normalised.container, exact.placement),
      thermalAssignment: thermalAssignmentFrom(normalised.container, exact.placement),
      loadingPlan: Object.freeze({
        method: "BOUNDED_BRANCH_AND_BOUND",
        conditionedCompartments: Object.freeze(conditionedCompartments(normalised.container, exact.placement)),
      }),
    });
  }

  return result({
    verdict: exact.verdict,
    tier: TIER.EXACT,
    nodesExplored: exact.nodes,
    bindingConstraint: exact.verdict === VERDICT.BUDGET_EXHAUSTED ? "NODE_BUDGET" : "NO_PLACEMENT_EXISTS",
    diagnostics: [
      greedy.reason,
      exact.verdict === VERDICT.BUDGET_EXHAUSTED
        ? `the bounded exact search explored ${exact.nodes} nodes without a result; this is not evidence that no placement exists, and is not evidence that one does (§15.3)`
        : `the exact search proved no placement exists within ${exact.nodes} nodes`,
    ],
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Tier 4 — memoisation
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * §15.3 tier 4: evaluate through the memo.
 *
 * The cache is non-authoritative (§3.3, invariant I16): a read failure is a miss and a
 * write failure is silent, because the only cost of either is a recomputation. A
 * `BUDGET_EXHAUSTED` verdict is deliberately **not** cached — the budget may be larger
 * next time, and memoising "I could not decide" would make an indecision permanent for
 * the TTL.
 *
 * @param {object} deps `{ kv }`
 * @param {object} input the same input `evaluate()` takes, plus `ttlSeconds`
 * @returns {Promise<{ result: object, cached: boolean, key: string|null }>}
 */
async function evaluateMemoised(deps, input) {
  const source = input || {};
  const normalised = container.normalise(source.container);
  const items = Array.isArray(source.consignment && source.consignment.items) ? source.consignment.items : [];

  if (!normalised.ok || items.length === 0) {
    return { result: evaluate(source), cached: false, key: null };
  }

  const keys = signature(normalised.container, items);

  if (deps && deps.kv && typeof deps.kv.get === "function") {
    try {
      const raw = await deps.kv.get(keys.key);
      if (raw !== null && raw !== undefined) {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (parsed && parsed.verdict) {
          return { result: result({ ...parsed, tier: TIER.MEMOISED }), cached: true, key: keys.key };
        }
      }
    } catch {
      // A cache failure is never a packing verdict.
    }
  }

  const computed = evaluate({ ...source, container: normalised.container });

  if (computed.verdict !== VERDICT.BUDGET_EXHAUSTED && deps && deps.kv && typeof deps.kv.set === "function") {
    try {
      await deps.kv.set(keys.key, JSON.stringify(computed), source.ttlSeconds ? { ex: source.ttlSeconds } : undefined);
    } catch {
      // Silent: a memo that failed to write costs a recomputation and nothing else.
    }
  }

  return { result: computed, cached: false, key: keys.key };
}

module.exports = {
  VERDICT,
  TIER,
  CACHE_KEY_PREFIX,
  canonicalItemOrder,
  signature,
  result,
  tierOne,
  tierTwo,
  tierThree,
  canPlace,
  compartmentLoadsFrom,
  thermalAssignmentFrom,
  conditionedCompartments,
  evaluate,
  evaluateMemoised,
};

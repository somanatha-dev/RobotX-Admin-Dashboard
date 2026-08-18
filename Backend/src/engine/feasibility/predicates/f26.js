"use strict";

/**
 * **F26 — Hazmat, security, and segregation rules satisfied for the combined load.**
 * Class R. Indeterminate: `DENY`.
 *
 * > Incompatible goods must not share a compartment; a security-classified item
 * > requires a lockable compartment.
 *
 * ── "For the combined load" is the whole difficulty ─────────────────────────
 * Every other payload predicate can be answered item by item. This one cannot: two
 * items each perfectly legal alone become illegal when placed together, so the
 * predicate is a property of the *set* in each compartment. That is why it is
 * evaluated after the packing assignment rather than against the payload spec — before
 * assignment there is no "combined load" to reason about, only a bag of items.
 *
 * ── Two independent rules ───────────────────────────────────────────────────
 *   1. **Segregation.** For every ordered pair sharing a compartment, neither item's
 *      declared incompatibility list may name any hazard class the other carries. The
 *      check is run in both directions rather than once per unordered pair, because
 *      incompatibility declarations are not symmetric in practice — an oxidiser's
 *      manifest lists flammables far more reliably than the reverse.
 *   2. **Security.** A security-classified item requires a compartment with a lock
 *      class, and the lock class must be *compatible* with the item's security class —
 *      §15.3 tier 1 requires "thermal, hazard, and security classes have a compatible
 *      compartment", and §15.1/§15.2 give the item a **security class** and the
 *      compartment a **lock class** as the two sides of that relation. Naming a class
 *      and then accepting any would make the declaration decorative.
 *
 *      The relation is transcribed here **independently** of
 *      `payload/container.satisfiesSecurityClass()`, which enforces the same rule at
 *      placement time. A predicate must not take its rule from the module whose output
 *      it checks (the reason F35 re-transcribes `BASIS` rather than importing it), so
 *      the two are kept as two transcriptions and a test asserts they agree. What makes
 *      that safe is the direction: the set of loads F26 admits is a **subset** of the
 *      set the container model admits, so "F26 admits ⟹ the container model agrees"
 *      holds structurally rather than by coincidence.
 *
 * ── Undeclared is not "none" ────────────────────────────────────────────────
 * An item whose hazard classes are absent is `INDETERMINATE`, not hazard-free. Class R
 * is never overridable operationally, and a manifest that failed to load is the case
 * where treating absence as safety is most expensive.
 *
 * Tier 0 (T0-01, T0-04).
 */

const tv = require("../threeValued");

const REQUIRED = "segregation and security rules satisfied for every compartment's combined load";

/**
 * Does `item` declare an incompatibility with any hazard class `other` carries?
 *
 * @param {object} item
 * @param {object} other
 * @returns {string|null} the offending hazard class, or null
 */
function conflictingHazard(item, other) {
  const forbidden = (item.segregation && item.segregation.incompatibleHazardClasses) || [];
  const carried = other.hazardClasses || [];
  return forbidden.find((hazard) => carried.includes(hazard)) || null;
}

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const plan = (context && context.plan) || null;
  if (!plan) return tv.absent("the candidate plan", { required: REQUIRED });

  const loads = plan.packing && plan.packing.compartmentLoads;
  if (loads === undefined) {
    return tv.absent("the plan's per-compartment load assignment (§15.3)", {
      required: REQUIRED,
      inputSource: "PLAN",
      reason:
        "no compartment assignment is attached to this plan. Before assignment there is no combined " +
        "load to reason about, only a bag of items; the assignment is engine/payload/packing.js (Phase 7)",
    });
  }
  if (loads === null || !Array.isArray(loads)) {
    return tv.indeterminate({
      required: REQUIRED,
      inputSource: "PLAN",
      reason: "the per-compartment load assignment is unreadable",
    });
  }

  for (const compartment of loads) {
    if (!compartment || !Array.isArray(compartment.items)) {
      return tv.indeterminate({
        observed: { compartmentId: compartment ? compartment.compartmentId : null },
        required: REQUIRED,
        inputSource: "PLAN",
        reason: "a compartment's item list is unreadable; its combined load cannot be evaluated",
      });
    }

    const compartmentId = compartment.compartmentId === undefined ? null : compartment.compartmentId;

    // Every item must declare what it is before any pair can be judged.
    for (const item of compartment.items) {
      if (!item || !Array.isArray(item.hazardClasses)) {
        return tv.indeterminate({
          observed: { compartmentId, itemId: item ? item.itemId : null },
          required: REQUIRED,
          inputSource: "CONTROL_PLANE",
          reason:
            "an item declares no hazard-class list. Undeclared is not hazard-free, and class R is " +
            "never overridable operationally (§7.2, §7.5 F26)",
        });
      }
    }

    // ── 1. Segregation, both directions ─────────────────────────────────────
    for (const item of compartment.items) {
      for (const other of compartment.items) {
        if (item === other) continue;
        const hazard = conflictingHazard(item, other);
        if (hazard !== null) {
          return tv.violated({
            observed: {
              compartmentId,
              itemId: item.itemId === undefined ? null : item.itemId,
              conflictsWith: other.itemId === undefined ? null : other.itemId,
              hazardClass: hazard,
            },
            required: REQUIRED,
            inputSource: "CONTROL_PLANE",
            reason:
              `item "${String(item.itemId)}" declares hazard class "${hazard}" incompatible, and ` +
              `item "${String(other.itemId)}" in the same compartment carries it. Incompatible goods ` +
              "must not share a compartment (§7.5 F26)",
          });
        }
      }
    }

    // ── 2. Security ─────────────────────────────────────────────────────────
    for (const item of compartment.items) {
      const securityClass = item.securityClass === undefined ? null : item.securityClass;
      if (securityClass === null) continue;

      const lockClass = compartment.lockClass === undefined ? null : compartment.lockClass;

      if (lockClass === null) {
        return tv.violated({
          observed: { compartmentId, itemId: item.itemId === undefined ? null : item.itemId, lockClass: null },
          required: { securityClass, lockClass: "any" },
          inputSource: "CONTROL_PLANE",
          reason:
            `item "${String(item.itemId)}" is security-classified "${securityClass}" and its ` +
            "compartment has no lock class. A security-classified item requires a lockable " +
            "compartment (§7.5 F26)",
        });
      }

      if (lockClass !== securityClass) {
        return tv.violated({
          observed: { compartmentId, itemId: item.itemId === undefined ? null : item.itemId, lockClass },
          required: { securityClass, lockClass: securityClass },
          inputSource: "CONTROL_PLANE",
          reason:
            `item "${String(item.itemId)}" is security-classified "${securityClass}" and its ` +
            `compartment carries lock class "${lockClass}". A security class requires a *compatible* ` +
            "compartment (§15.3 tier 1), not merely a locked one; naming a class and accepting any " +
            "would make the declaration decorative (§7.5 F26)",
        });
      }
    }
  }

  return tv.satisfied({
    observed: {
      compartmentsChecked: loads.length,
      itemsChecked: loads.reduce((total, compartment) => total + compartment.items.length, 0),
    },
    required: REQUIRED,
    inputSource: "PLAN",
  });
}

module.exports = { evaluate, conflictingHazard };

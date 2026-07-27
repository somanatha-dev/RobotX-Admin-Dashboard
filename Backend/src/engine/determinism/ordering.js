"use strict";

/**
 * Canonical ordering (§9.6 requirements 2 and 3).
 *
 * > **Canonical ordering everywhere.** Candidates, Legs, columns, and solver arcs are
 * > sorted by explicit total orders ending in a unique id, so no tie is ever resolved
 * > by iteration order. A column's identity for ordering purposes is
 * > `(agent_id, sorted leg_id list, insertion position vector)`, which is unique and
 * > independent of the order in which the Column Builder happened to generate it.
 *
 * > **Explicit tie-break policy.** Equal costs resolve by, in order: lower cumulative
 * > duty cycle (which makes ties do useful fairness work — §17.2), then higher health
 * > tier, then agent id. Never by arrival order or storage order.
 *
 * The baseline resolved ties by taking the first row the database returned
 * (`taskAssignment.service.js`), which is not a tie-break policy — it is the absence
 * of one, and it makes two identical rounds produce different allocations.
 *
 * ── Why string comparison is by code unit ───────────────────────────────────
 * `String.prototype.localeCompare` depends on the host's ICU data and collation
 * locale, so the same two agent ids can order differently on two hosts. A total order
 * whose result depends on where it ran is not a total order for replay purposes. Every
 * comparison here uses `<` / `>`, which compare UTF-16 code units and are identical
 * on every host.
 */

const { compare: compareMilliCU } = require("./fixedPoint");

const BEFORE = -1;
const AFTER = 1;
const EQUAL = 0;

/**
 * Code-unit string order. Host-independent by construction.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareStrings(a, b) {
  const left = String(a);
  const right = String(b);
  if (left < right) return BEFORE;
  if (left > right) return AFTER;
  return EQUAL;
}

/**
 * Ascending numeric order, with a stated position for absent values: an absent value
 * sorts after every present one, so a missing field never silently wins a comparison.
 *
 * @param {number|null|undefined} a
 * @param {number|null|undefined} b
 * @returns {number}
 */
function compareNumbers(a, b) {
  const aMissing = typeof a !== "number" || !Number.isFinite(a);
  const bMissing = typeof b !== "number" || !Number.isFinite(b);
  if (aMissing && bMissing) return EQUAL;
  if (aMissing) return AFTER;
  if (bMissing) return BEFORE;
  if (a < b) return BEFORE;
  if (a > b) return AFTER;
  return EQUAL;
}

/**
 * Compose comparators: the first to express a preference wins.
 *
 * @param {...(a: *, b: *) => number} comparators
 * @returns {(a: *, b: *) => number}
 */
function thenBy(...comparators) {
  return (a, b) => {
    for (const comparator of comparators) {
      const verdict = comparator(a, b);
      if (verdict !== EQUAL) return verdict;
    }
    return EQUAL;
  };
}

/**
 * Reverse a comparator — used for "higher health tier first".
 *
 * @param {(a: *, b: *) => number} comparator
 * @returns {(a: *, b: *) => number}
 */
function descending(comparator) {
  return (a, b) => -comparator(a, b);
}

/**
 * The §9.6 requirement-3 tie-break, as a comparator over agent-shaped records.
 *
 * Order: lower cumulative duty cycle, then higher health tier, then agent id.
 * The first term is deliberate — it makes ties do useful fairness work rather than
 * being decided arbitrarily (§17.2).
 *
 * @param {{ dutyCycle?: number, healthTier?: number, agentId: string }} a
 * @param {{ dutyCycle?: number, healthTier?: number, agentId: string }} b
 * @returns {number}
 */
const compareTieBreak = thenBy(
  (a, b) => compareNumbers(a.dutyCycle, b.dutyCycle),
  descending((a, b) => compareNumbers(a.healthTier, b.healthTier)),
  (a, b) => compareStrings(a.agentId, b.agentId),
);

/**
 * The canonical total order over scored candidates: cost first, then the §9.6
 * tie-break, ending in the unique agent id.
 *
 * Costs are compared as int64 milli-CU, never as floats.
 *
 * @param {{ costMilliCU: bigint, dutyCycle?: number, healthTier?: number, agentId: string }} a
 * @param {{ costMilliCU: bigint, dutyCycle?: number, healthTier?: number, agentId: string }} b
 * @returns {number}
 */
const compareScored = thenBy((a, b) => compareMilliCU(a.costMilliCU, b.costMilliCU), compareTieBreak);

/**
 * The canonical identity of a column: `(agent_id, sorted leg_id list, insertion
 * position vector)`.
 *
 * Unique, and independent of the order in which the Column Builder happened to
 * generate it — which is what lets two runs that generate the same columns in
 * different orders produce the same solve input.
 *
 * @param {{ agentId: string, legIds: string[], insertionPositions?: number[] }} column
 * @returns {string}
 */
function columnIdentity(column) {
  const legIds = [...(column.legIds || [])].sort(compareStrings);
  const positions = [...(column.insertionPositions || [])];
  return JSON.stringify([String(column.agentId), legIds, positions]);
}

/**
 * Total order over columns, by their canonical identity.
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function compareColumns(a, b) {
  return compareStrings(columnIdentity(a), columnIdentity(b));
}

/**
 * Sort a collection under a canonical comparator, without mutating the input.
 *
 * The comparator is required to be a genuine total order — one ending in a unique id
 * — so the result never depends on the sort's stability or on the input order.
 *
 * @param {Iterable<*>} values
 * @param {(a: *, b: *) => number} comparator
 * @returns {*[]}
 */
function canonicalSort(values, comparator) {
  return [...values].sort(comparator);
}

/**
 * Assert that a comparator is a total order over the given set: no two distinct
 * members compare equal.
 *
 * A comparator that ties two distinct members leaves their relative order to the
 * sort implementation, which is exactly the defect §9.6 requirement 2 prohibits.
 * This is cheap enough to run on every round's candidate set in tests and in the
 * invariant checker.
 *
 * @param {*[]} values
 * @param {(a: *, b: *) => number} comparator
 * @param {(value: *) => string} [identify]
 * @returns {{ ok: boolean, collisions: string[] }}
 */
function assertTotalOrder(values, comparator, identify) {
  const sorted = canonicalSort(values, comparator);
  const collisions = [];
  const label = identify || ((value) => JSON.stringify(value));
  for (let index = 1; index < sorted.length; index += 1) {
    if (comparator(sorted[index - 1], sorted[index]) === EQUAL) {
      collisions.push(`${label(sorted[index - 1])} ties with ${label(sorted[index])}`);
    }
  }
  return { ok: collisions.length === 0, collisions };
}

/**
 * Canonical JSON: object keys in code-unit order, at every depth.
 *
 * Two uses, both load-bearing. It is what a content hash is taken over — a config
 * version's signature, a pinned snapshot's hash — so that the same content always
 * produces the same digest regardless of the order in which the object was built.
 * And it is what a decision record serialises to, so that a replay's record is
 * byte-comparable with the original's.
 *
 * @param {*} value
 * @returns {string}
 */
function canonicalJson(value) {
  const encode = (node) => {
    if (node === null || node === undefined) return "null";
    if (typeof node === "bigint") return JSON.stringify(node.toString());
    if (typeof node === "number") {
      if (!Number.isFinite(node)) {
        throw new TypeError(`canonicalJson cannot encode the non-finite number ${node}`);
      }
      return JSON.stringify(node);
    }
    if (typeof node === "boolean" || typeof node === "string") return JSON.stringify(node);
    if (Array.isArray(node)) return `[${node.map(encode).join(",")}]`;
    if (node instanceof Map) {
      return encode(Object.fromEntries(node.entries()));
    }
    if (typeof node === "object") {
      const keys = Object.keys(node).sort(compareStrings);
      const parts = keys
        .filter((key) => node[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${encode(node[key])}`);
      return `{${parts.join(",")}}`;
    }
    throw new TypeError(`canonicalJson cannot encode a ${typeof node}`);
  };
  return encode(value);
}

module.exports = {
  BEFORE,
  AFTER,
  EQUAL,
  compareStrings,
  compareNumbers,
  thenBy,
  descending,
  compareTieBreak,
  compareScored,
  columnIdentity,
  compareColumns,
  canonicalSort,
  assertTotalOrder,
  canonicalJson,
};

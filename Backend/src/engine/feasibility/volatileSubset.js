"use strict";

/**
 * The volatile subset, and the commit-time re-check it feeds (§10.3.2 step 3) —
 * **Tier 0**.
 *
 * > 3. Re-verify the **volatile subset** of feasibility. This is essential: the audit
 * > documents that the baseline **validates battery and health *before* the reservation
 * > and never re-checks them at finalisation**, so an agent that drains below threshold
 * > or faults during the routing window is still bound. The re-check is cheap because
 * > it uses cached predicate results whose invalidation timestamps are compared against
 * > the snapshot. The volatile subset is an **enumerated, machine-checkable list**, not
 * > a prose description: F7, F8, F10, F13, F14, F16, F17, F18, F20, F34, F35. A
 * > predicate is either on this list or it is not, and **adding a predicate to the
 * > constraint register requires classifying it**.
 *
 * ── Two representations, deliberately, and a check that they agree ──────────
 * The subset appears twice in this module: once as `SPECIFIED_SUBSET`, transcribed
 * literally from §10.3.2, and once as a derived query over `register.js`'s `volatile`
 * flag. `assertSubset()` proves they are the same set.
 *
 * That redundancy is the point. The register's flag is what the code uses; the
 * transcription is what a reviewer checks against the specification. Deriving the list
 * from the register alone would make the register self-certifying — any flag someone
 * changed would silently become "the specification" — and hard-coding only the literal
 * list would leave the register's flag decorative. Neither alone is a
 * *machine-checkable* list in the sense §10.3.2 means.
 *
 * ── The seam this fills ─────────────────────────────────────────────────────
 * Phase 3's `commitment/commit.js` declares `volatileRecheck` as a **required**
 * injected dependency and names Phase 6 as its supplier:
 *
 * > `volatileRecheck` — Phase 6 supplies the enumerated volatile subset … Its
 * > **absence is refused**, because a re-check that silently passes when nobody
 * > registered it is exactly the "informal bypass under latency pressure" §7.1 names
 * > as a predicted failure mode.
 *
 * `createVolatileRecheck()` below is that supplier. It returns the exact contract
 * `commit.js` expects — `(context) => Promise<{ ok, reason?, detail? }>` — and it
 * evaluates the eleven predicates against the state read **under the row locks**,
 * which is the only place the routing-window race can actually be closed.
 *
 * ── A stale positive cannot survive this step ───────────────────────────────
 * The re-check never consults the feasibility cache. §10.4 and invariant I16 make the
 * cache non-authoritative, and the whole purpose of this step is to catch a verdict
 * that has since become wrong; consulting the cache that produced it would defeat it.
 * The cheapness §10.3.2 refers to comes from the subset being eleven predicates rather
 * than thirty-eight, not from re-reading a cache.
 */

const { PREDICATES, predicate } = require("./register");
const { OUTCOME, applyPolicy } = require("./threeValued");

/**
 * §10.3.2 step 3's enumerated list, transcribed verbatim from the specification.
 * @structural the specification's own enumeration of the volatile subset
 */
const SPECIFIED_SUBSET = Object.freeze([
  "F7",
  "F8",
  "F10",
  "F13",
  "F14",
  "F16",
  "F17",
  "F18",
  "F20",
  "F34",
  "F35",
]);

/**
 * The subset as the register declares it. This is what the code evaluates.
 *
 * @returns {string[]} predicate ids, in register (evaluation) order
 */
function subset() {
  return PREDICATES.filter((entry) => entry.volatile).map((entry) => entry.id);
}

/**
 * @param {string} predicateId
 * @returns {boolean}
 */
function isVolatile(predicateId) {
  const entry = predicate(predicateId);
  return Boolean(entry && entry.volatile);
}

/**
 * Prove the register's `volatile` flags are exactly §10.3.2's enumerated list.
 *
 * Run by the engine test lane. A failure here means either the register acquired a
 * volatile predicate the specification does not list, or lost one it does — and both
 * are silent correctness defects: the first over-constrains the commit path, the
 * second reopens the routing-window race for whichever predicate fell off.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertSubset() {
  const problems = [];
  const derived = subset();

  const missing = SPECIFIED_SUBSET.filter((id) => !derived.includes(id));
  const extra = derived.filter((id) => !SPECIFIED_SUBSET.includes(id));

  if (missing.length > 0) {
    problems.push(
      `the register does not mark [${missing.join(", ")}] volatile, but §10.3.2 step 3 enumerates ` +
        "them. The routing-window race is reopened for each",
    );
  }
  if (extra.length > 0) {
    problems.push(
      `the register marks [${extra.join(", ")}] volatile, but §10.3.2 step 3 does not enumerate ` +
        "them. Adding a predicate to the constraint register requires classifying it against this list",
    );
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Re-evaluate the volatile subset against commit-time state.
 *
 * @param {object} context the evaluation context, assembled from state read under the
 *   row locks: `{ agentSnapshot, mission, plan, config, decisionTimeMs }`
 * @returns {{ ok: boolean, failures: object[], evaluated: string[] }}
 */
function recheck(context) {
  const failures = [];
  const evaluated = [];

  for (const entry of PREDICATES) {
    if (!entry.volatile) continue;
    evaluated.push(entry.id);

    const outcome = entry.evaluate(context);
    if (outcome.outcome === OUTCOME.SATISFIED) continue;

    const resolution = applyPolicy(outcome, entry, {
      // The commit path never admits on an envelope reduction or an uncertainty
      // penalty: re-planning is not available inside the serialised section, and a
      // penalty is a cost, which this path may not see (T1, §7.1). Every volatile
      // predicate declares DENY in any case — `assertSubset` and the register's own
      // policy check together guarantee it — so this is a belt on a brace.
      envelopeFeasible: false,
    });

    if (!resolution.admitted) {
      failures.push({
        predicateId: entry.id,
        outcome: outcome.outcome,
        observed: outcome.observed,
        required: outcome.required,
        reason: outcome.reason || resolution.reason,
      });
    }
  }

  return { ok: failures.length === 0, failures, evaluated };
}

/**
 * Build the `volatileRecheck` dependency `commitment/commit.js` requires.
 *
 * `commit.js` calls it with `{ tx, agent, leg, storeTime, snapshot, commitmentId }` —
 * database rows read `FOR UPDATE`, not an evaluation context. `buildContext` is the
 * caller-supplied adapter from one to the other, because assembling an agent snapshot
 * from a transaction is the round's work (Phase 9/10) and not this module's.
 *
 * **Its absence is refused**, symmetrically with `commit.js`'s own refusal: a re-check
 * that cannot build its inputs must not report success.
 *
 * @param {{ buildContext: (commitContext: object) => object }} deps
 * @returns {(commitContext: object) => Promise<{ ok: boolean, reason?: string, detail?: string }>}
 */
function createVolatileRecheck(deps) {
  if (!deps || typeof deps.buildContext !== "function") {
    throw new Error(
      "createVolatileRecheck requires a buildContext adapter. §10.3.2 step 3's re-check runs against " +
        "state read under the row locks, and a re-check that cannot build its inputs must not report " +
        "success — that is the informal bypass under latency pressure §7.1 predicts.",
    );
  }

  return async function volatileRecheck(commitContext) {
    const context = await deps.buildContext(commitContext);
    const outcome = recheck(context);

    if (outcome.ok) return { ok: true };

    const first = outcome.failures[0];
    return {
      ok: false,
      reason: "VOLATILE_FEASIBILITY_LOST",
      detail:
        `${first.predicateId} is ${first.outcome} at commit time (§10.3.2 step 3): ${first.reason}. ` +
        `${outcome.failures.length} of ${outcome.evaluated.length} volatile predicates failed`,
    };
  };
}

module.exports = {
  SPECIFIED_SUBSET,
  subset,
  isVolatile,
  assertSubset,
  recheck,
  createVolatileRecheck,
};

"use strict";

/**
 * The staged, per-shard production cutover (execution plan Phase 15) — **Tier 0 by
 * consequence**.
 *
 * > **No partial cutover.** Because Tier 0 is indivisible (§1.8), the cutover switches
 * > the whole decision path at once, **per shard**, with rollback. There is no state in
 * > which half the commitment core is live.
 *
 * > **Configuration updates** — `ENGINE_ENABLED=true` per shard, staged; every
 * > Safety-class parameter must be `DERIVED` (not `PROVISIONAL`) — this is a hard launch
 * > gate (§22.4).
 *
 * This module decides **whether** a shard may be enabled and **in what order** shards are
 * taken. It writes nothing: it returns an authorisation, and the caller — the cutover
 * worker or an operator's tooling — publishes the configuration binding through the
 * Config Service, so that the change is versioned, approved, audited and explainable by
 * the same machinery every other parameter change uses. A cutover that wrote its own
 * flag somewhere else would be the one change in the system with no publish record.
 *
 * ── Five refusals, and the reason each exists ───────────────────────────────
 * `authoriseEnable()` refuses on any of five grounds. None is a warning; all five return
 * a refusal, because a cutover that proceeds past a warning is a cutover with no gate.
 *
 *   1. **A blocking §24 release gate is not GREEN.** `cutover/gates.js` holds the table.
 *      This is the gate the whole phase exists to install, and it is checked first so
 *      that the answer to "why was the cutover refused" names the missing evidence
 *      rather than a procedural detail.
 *   2. **The Tier 2 ship state does not hold.** §1.8 rule 3: "Tier 0 plus Tier 1 … is a
 *      complete, safe, shippable engine. **Tier 2 mechanisms are then enabled one at a
 *      time**". Phase 16 is what enables them. A cutover that took a shard live with a
 *      Tier 2 mechanism already on would be cutting over to a configuration no shadow
 *      run covered, and would make Phase 16's per-mechanism gates retrospective.
 *   3. **No second approver.** §22.3 requires two-person approval for the Safety class
 *      and change management for the Structural class; the cutover is the largest change
 *      either class admits. The requester may not be the approver.
 *   4. **Guardrails were not pre-declared for this shard.** §22.4 item 4. Enforced here
 *      as well as in `guardrails.js` so that a shard cannot be enabled and *then*
 *      monitored — which is the ordering that makes a rollout unreviewable.
 *   5. **The staging order was skipped.** See below.
 *
 * ── Why the order is smallest-blast-radius-first, and why it is enforced ────
 * §22.3's Structural row requires "change management with a rehearsed rollback plan",
 * and §3.5 makes a shard's `agentCount` the measure of what one shard's failure costs.
 * `stagingOrder()` therefore takes shards in ascending `agentCount`, breaking ties by
 * `shardId` so the order is deterministic and can be published in the runbook before the
 * cutover begins rather than discovered during it. `authoriseEnable()` refuses a shard
 * whose predecessors are not yet live, so "we started with the biggest region because it
 * was the one people were watching" cannot happen by drift.
 *
 * The rule has one deliberate escape: `overrideOrder` with a reason. Skipping is
 * sometimes correct — a small shard may be mid-incident — and an operator who must never
 * be blocked is §22.5 rule 2's own principle. The escape is recorded as an override, is
 * refused without a reason, and appears in the audit as a skip rather than as a normal
 * step.
 *
 * ── Rollback is never refused ───────────────────────────────────────────────
 * `authoriseRollback()` has no gate, no quorum and no ordering rule. A control that can
 * be refused is not a control, and every reason to refuse an enable is a reason to permit
 * a disable. It requires only a reason, so that the audit records why.
 *
 * ── No clock ────────────────────────────────────────────────────────────────
 * Every instant is supplied.
 */

const { compareStrings } = require("../determinism/ordering");
const enabled = require("./enabled");
const gates = require("./gates");
const guardrails = require("./guardrails");
const killSwitches = require("../config/killSwitches");

/** @structural the two authorised transitions; there is no third */
const ACTION = Object.freeze({
  ENABLE: "ENABLE",
  ROLLBACK: "ROLLBACK",
});

/**
 * What an `ENABLE` is *for* — **ADR-34**, the resolution of the D-7 bootstrap circularity.
 *
 * ── The circularity ────────────────────────────────────────────────────────
 * `rollback_rehearsed` is a blocking §24 gate. `docs/runbooks/rollback.md` §5 step 1
 * discharges it by taking a **staging** shard live through the full §3 of `cutover.md` —
 * which calls `authoriseEnable()`, which refuses while any blocking gate is not GREEN. The
 * rehearsal requires a cutover and the cutover requires the rehearsal. `gates.js` has no
 * `WAIVED` status, deliberately, and `overrideOrder` skips the staging *order*, never a
 * gate. The gate set was therefore unsatisfiable by any legitimate sequence.
 *
 * ── Why the answer is a purpose and not a waiver ───────────────────────────
 * The temptation is to make `rollback_rehearsed` non-blocking, or to add a waiver. Both are
 * wrong for the reason `gates.js` already states: "a gate that could be waived would be a
 * route around the predicates those classes protect." The gate is not the problem. The
 * problem is that `authoriseEnable()` was answering one question for two different acts:
 *
 *   - a **production cutover**, which takes a production shard live for real traffic, and
 *   - a **rehearsal**, which takes a *staging* shard live in order to *produce* the evidence
 *     that `rollback_rehearsed` is about.
 *
 * "You may not take a shard live until the rollback has been rehearsed" is exactly right for
 * the first and a category error for the second: it demands that the rehearsal be preceded
 * by its own output. Naming the purpose separates them, and the separation is what removes
 * the circularity — no gate is weakened, no threshold moves, and `PRODUCTION` behaviour is
 * bit-for-bit what it was.
 *
 * ── What a REHEARSAL may and may not do ────────────────────────────────────
 * It excludes **exactly one** gate — the one it exists to produce — and nothing else. Every
 * other blocking gate, the §1.8 rule 3 ship state, two-person approval, the guardrail
 * pre-declaration and the staging order all apply unchanged. It is refused unless the
 * request declares a **non-production environment**, so the exclusion can never be granted
 * to the real thing. The action it produces is stamped with its purpose and its environment,
 * so an audit reads "rehearsal" rather than inferring it, and `authoriseEnable`'s caller
 * cannot publish a rehearsal's binding as a production one without the record saying so.
 *
 * @structural the two purposes an ENABLE can serve; ADR-34
 */
const PURPOSE = Object.freeze({
  /** The real thing. Every gate applies. This is the default for a request that names none. */
  PRODUCTION: "PRODUCTION",
  /** A rollback rehearsal against a declared non-production environment (ADR-34). */
  REHEARSAL: "REHEARSAL",
});

/**
 * The gates a `REHEARSAL` excludes — **and it is one**.
 *
 * Written as a list so the exclusion is enumerable and testable rather than a condition
 * buried in a branch, and so that widening it is a visible diff against a named constant
 * rather than an extra clause nobody reviews. A second entry here would need its own ADR:
 * the argument above justifies excluding the gate a rehearsal *produces*, and generalises
 * to nothing else.
 *
 * @structural the rehearsal exclusion set; ADR-34
 */
const REHEARSAL_EXCLUDED_GATES = Object.freeze(["rollback_rehearsed"]);

/** @structural refusal codes, so a caller can branch without parsing prose */
const REFUSAL = Object.freeze({
  RELEASE_GATE_NOT_GREEN: "RELEASE_GATE_NOT_GREEN",
  TIER_TWO_NOT_AT_SHIP_STATE: "TIER_TWO_NOT_AT_SHIP_STATE",
  NO_SECOND_APPROVER: "NO_SECOND_APPROVER",
  GUARDRAILS_NOT_DECLARED: "GUARDRAILS_NOT_DECLARED",
  STAGING_ORDER_SKIPPED: "STAGING_ORDER_SKIPPED",
  SHARD_NOT_ELIGIBLE: "SHARD_NOT_ELIGIBLE",
  NO_REASON_GIVEN: "NO_REASON_GIVEN",
  /** ADR-34 — a REHEARSAL that does not declare a non-production environment. */
  REHEARSAL_REQUIRES_NON_PRODUCTION: "REHEARSAL_REQUIRES_NON_PRODUCTION",
  /** ADR-34 — a purpose this module does not recognise. Fail closed rather than default. */
  UNKNOWN_PURPOSE: "UNKNOWN_PURPOSE",
});

/** Shard states that may be taken live. A draining or retired shard may not (§3.5). */
const ELIGIBLE_SHARD_STATES = Object.freeze(["ACTIVE"]);

/**
 * The deterministic staging order: least blast radius first.
 *
 * @param {object[]} shards `{ shardId, regionId, agentCount, state }`
 * @returns {object[]} a new array, ordered
 */
function stagingOrder(shards) {
  const list = Array.isArray(shards) ? shards.slice() : [];
  list.sort((a, b) => {
    const left = typeof a.agentCount === "number" ? a.agentCount : 0;
    const right = typeof b.agentCount === "number" ? b.agentCount : 0;
    if (left !== right) return left - right;
    return compareStrings(String(a.shardId || ""), String(b.shardId || ""));
  });
  return list;
}

/**
 * Build the staging plan a runbook publishes before the cutover begins.
 *
 * @param {object[]} shards
 * @returns {{ steps: object[], totalAgents: number }}
 */
function plan(shards) {
  const ordered = stagingOrder(shards);
  const steps = ordered.map((shard, index) => ({
    position: index + 1,
    shardId: shard.shardId,
    regionId: shard.regionId,
    agentCount: typeof shard.agentCount === "number" ? shard.agentCount : 0,
    state: shard.state || null,
    eligible: ELIGIBLE_SHARD_STATES.includes(String(shard.state || "")),
    predecessors: ordered.slice(0, index).map((earlier) => earlier.shardId),
  }));
  return {
    steps,
    totalAgents: steps.reduce((sum, step) => sum + step.agentCount, 0),
  };
}

/**
 * Is every Tier 2 mechanism still behind its switch — §1.8 rule 3's ship state?
 *
 * @param {object} [switchState] as `killSwitches.normaliseState` produces
 * @returns {{ ok: boolean, enabled: string[] }}
 */
function tierTwoAtShipState(switchState) {
  const state = killSwitches.normaliseState(switchState);
  const live = Object.entries(state)
    .filter(([, thrown]) => thrown !== true)
    .map(([name]) => name)
    .sort(compareStrings);
  return { ok: live.length === 0, enabled: live };
}

function refuse(code, message, detail) {
  return { authorised: false, action: null, refusal: { code, message, detail: detail || null } };
}

/**
 * Authorise taking one shard live.
 *
 * @param {object} request
 * @param {object} request.shard `{ shardId, regionId, state }`
 * @param {object[]} request.allShards every shard in the fleet, for the ordering check
 * @param {object} request.liveShardIds ids already live
 * @param {object} request.releaseEvidence evidence for `gates.evaluate`
 * @param {object} request.killSwitchState the state that will be published
 * @param {object} request.declaration the pre-declared guardrails (`guardrails.declare`)
 * @param {string} request.requestedBy
 * @param {string} request.approvedBy the second approver; must differ from the requester
 * @param {string} request.reason
 * @param {number} request.requestedAtMs
 * @param {{ overrideOrder?: string|null }} [request.options]
 * @returns {{ authorised: boolean, action: object|null, refusal: object|null }}
 */
function authoriseEnable(request) {
  const source = request || {};
  const shard = source.shard || {};
  const shardId = shard.shardId ? String(shard.shardId) : "";
  const regionId = shard.regionId ? String(shard.regionId) : "";

  if (!shardId || !regionId) {
    return refuse(
      REFUSAL.SHARD_NOT_ELIGIBLE,
      "a cutover names the shard and its operating region. Resolution is by region (§22.2), so a shard " +
        "with no region has no scope at which the binding could be published.",
    );
  }
  if (!ELIGIBLE_SHARD_STATES.includes(String(shard.state || ""))) {
    return refuse(
      REFUSAL.SHARD_NOT_ELIGIBLE,
      `shard ${shardId} is ${shard.state || "in an unknown state"}; only ${ELIGIBLE_SHARD_STATES.join("/")} may be ` +
        "taken live. A draining shard is giving its agents away (§3.5) and a retired one owns nothing.",
    );
  }
  if (!source.reason) {
    return refuse(REFUSAL.NO_REASON_GIVEN, "a cutover step carries a reason; §22.3 makes it an audited change");
  }

  // 0. What this enable is *for* — ADR-34. A request that names no purpose is a production
  //    cutover, which is the safe default: the only thing a purpose can do is *reduce* the
  //    gate set, so an unnamed one must reduce nothing.
  const purpose = source.purpose ? String(source.purpose) : PURPOSE.PRODUCTION;
  if (!Object.values(PURPOSE).includes(purpose)) {
    return refuse(
      REFUSAL.UNKNOWN_PURPOSE,
      `unknown cutover purpose \`${purpose}\`. A purpose decides which gates apply, so an unrecognised one is ` +
        "refused rather than treated as production — a typo must not silently become an authorisation.",
    );
  }

  // A rehearsal is only a rehearsal if it is happening somewhere that is not production.
  // This is the whole safety of ADR-34's exclusion: the gate that is set aside is set aside
  // for an environment that cannot serve real traffic, and the declaration is the operator's
  // to make and the audit's to hold them to.
  const environment = source.environment || null;
  if (purpose === PURPOSE.REHEARSAL) {
    if (!environment || !environment.id || environment.production !== false) {
      return refuse(
        REFUSAL.REHEARSAL_REQUIRES_NON_PRODUCTION,
        "a rehearsal must declare its environment as non-production (`environment: { id, production: false }`). " +
          `Without that declaration the ${REHEARSAL_EXCLUDED_GATES.join(", ")} exclusion would be granted to a ` +
          "production cutover, which is the circularity's escape hatch rather than its resolution.",
      );
    }
  }

  // 1. The release gates. Checked first so the refusal names the missing evidence.
  //
  // The context travels with the evidence: without it a run record from a different tree,
  // or one produced a month ago, is admitted. `requestedAtMs` is the instant the operator
  // asked, which is the right clock to age evidence against — a record is stale relative to
  // the decision it is being used to justify, not relative to when it was written.
  const blocking = gates.blockers(source.releaseEvidence, {
    nowMs: typeof source.requestedAtMs === "number" ? source.requestedAtMs : undefined,
    maxAgeMs: typeof source.evidenceMaxAgeMs === "number" ? source.evidenceMaxAgeMs : undefined,
    sourceDigest: source.sourceDigest,
    // Resolved by the caller from the register (`evidence.resolveMinObservationMs`). Absent
    // here, the two windowed gates are refused rather than unbounded — which is the correct
    // direction, and the reason this is passed through rather than defaulted.
    minObservationMs: source.minObservationMs,
  });
  // ADR-34 — a rehearsal excludes exactly the gate it exists to produce, and nothing else.
  //
  // The exclusion is applied *after* `blockers()` has evaluated the whole table rather than
  // by hiding the row from it, so the gate is still judged, still reported, and still
  // appears in the action's audit as excluded-by-purpose. A gate that were removed before
  // evaluation would be a gate nobody could see had been set aside.
  const excluded = purpose === PURPOSE.REHEARSAL ? new Set(REHEARSAL_EXCLUDED_GATES) : new Set();
  const setAside = blocking.filter((gate) => excluded.has(gate.id));
  const stillBlocking = blocking.filter((gate) => !excluded.has(gate.id));

  if (stillBlocking.length > 0) {
    return refuse(
      REFUSAL.RELEASE_GATE_NOT_GREEN,
      `${stillBlocking.length} blocking §24 release gate(s) are not green, so no shard may be taken live: ` +
        stillBlocking.map((gate) => `${gate.id} (${gate.status})`).join(", ") +
        (setAside.length > 0
          ? `. (${setAside.length} gate(s) set aside for this rehearsal: ${setAside.map((gate) => gate.id).join(", ")})`
          : ""),
      stillBlocking,
    );
  }

  // 2. §1.8 rule 3's ship state.
  const shipState = tierTwoAtShipState(source.killSwitchState);
  if (!shipState.ok) {
    return refuse(
      REFUSAL.TIER_TWO_NOT_AT_SHIP_STATE,
      "the cutover ships Tier 0 plus Tier 1 only. §1.8 rule 3 enables Tier 2 mechanisms one at a time, " +
        `after the cutover, each behind its own gate (Phase 16). Enabled here: ${shipState.enabled.join(", ")}.`,
      shipState.enabled,
    );
  }

  // 3. Two-person approval.
  const requestedBy = source.requestedBy ? String(source.requestedBy) : "";
  const approvedBy = source.approvedBy ? String(source.approvedBy) : "";
  if (!requestedBy || !approvedBy || requestedBy === approvedBy) {
    return refuse(
      REFUSAL.NO_SECOND_APPROVER,
      "taking a shard live requires two distinct people (§22.3). The requester may not approve their own " +
        "cutover, and an automated process may not perform this transition at all.",
    );
  }
  if (source.automated === true) {
    return refuse(
      REFUSAL.NO_SECOND_APPROVER,
      "this request is marked automated. §22.3: no automated process makes the change that raises risk. " +
        "The automatic controller may only roll a shard back.",
    );
  }

  // 4. Pre-declared guardrails, for this shard, declared before now.
  const declaration = source.declaration || null;
  if (!declaration || declaration.shardId !== shardId) {
    return refuse(
      REFUSAL.GUARDRAILS_NOT_DECLARED,
      `no pre-declared SLI guardrails for shard ${shardId}. §22.4 item 4 stages by shard "monitored against ` +
        'pre-declared SLI guardrails, with automatic rollback"; declaring them afterwards is not that.',
    );
  }
  if (typeof source.requestedAtMs === "number" && declaration.declaredAtMs > source.requestedAtMs) {
    return refuse(
      REFUSAL.GUARDRAILS_NOT_DECLARED,
      `the guardrails for shard ${shardId} are stamped after this request. "Pre-declared" is an ordering, ` +
        "and this ordering is the wrong way round.",
    );
  }

  // 5. The staging order.
  const ordered = stagingOrder(source.allShards || []);
  const position = ordered.findIndex((entry) => String(entry.shardId) === shardId);
  const liveIds = new Set((source.liveShardIds || []).map(String));
  const skipped =
    position === -1
      ? []
      : ordered
          .slice(0, position)
          .filter((earlier) => ELIGIBLE_SHARD_STATES.includes(String(earlier.state || "")))
          .filter((earlier) => !liveIds.has(String(earlier.shardId)))
          .map((earlier) => String(earlier.shardId));

  const override = source.options && source.options.overrideOrder ? String(source.options.overrideOrder) : null;
  if (skipped.length > 0 && !override) {
    return refuse(
      REFUSAL.STAGING_ORDER_SKIPPED,
      `shard ${shardId} sits at position ${position + 1} of the staging order and ${skipped.length} eligible ` +
        `shard(s) before it are not live: ${skipped.join(", ")}. The order is ascending agent count — least ` +
        "blast radius first — and skipping it requires an explicit, reasoned override.",
      skipped,
    );
  }

  return {
    authorised: true,
    refusal: null,
    action: {
      type: ACTION.ENABLE,
      shardId,
      regionId,
      /**
       * ADR-34 — what this enable is for, carried on the action rather than left to be
       * inferred from the shard's name. Two things read it: the audit, where "rehearsal"
       * must be a recorded fact rather than a reconstruction, and any caller deciding
       * whether it is holding a production authorisation.
       */
      purpose,
      /** The declared environment. `null` for a production cutover, which declares none. */
      environment: purpose === PURPOSE.REHEARSAL ? { id: String(environment.id), production: false } : null,
      /**
       * The gates this purpose set aside, and their status when it did. Empty for a
       * production cutover — always, because `excluded` is empty for it — so an audit that
       * finds a non-empty list here is looking at a rehearsal by construction and not by
       * label.
       */
      gatesSetAside: setAside.map((gate) => ({ id: gate.id, status: gate.status })),
      /**
       * The binding the caller publishes. Scope is `region`, which is §22.2's own alias
       * for a shard (`config/resolver.js`, convention 2); no new scope level is added.
       */
      binding: { level: "region", key: regionId, name: enabled.PARAMETER, value: true },
      requestedBy,
      approvedBy,
      reason: String(source.reason),
      orderPosition: position === -1 ? null : position + 1,
      orderOverride: skipped.length > 0 ? { skipped, reason: override } : null,
      guardrailDeclaration: declaration,
      requestedAtMs: typeof source.requestedAtMs === "number" ? source.requestedAtMs : null,
    },
  };
}

/**
 * Authorise rolling one shard back. Never refused except for a missing reason.
 *
 * @param {{ shard: object, reason: string, requestedBy?: string, automatic?: boolean,
 *   assessment?: object, requestedAtMs?: number }} request
 * @returns {{ authorised: boolean, action: object|null, refusal: object|null }}
 */
function authoriseRollback(request) {
  const source = request || {};
  const shard = source.shard || {};
  const shardId = shard.shardId ? String(shard.shardId) : "";
  const regionId = shard.regionId ? String(shard.regionId) : "";

  if (!shardId || !regionId) {
    return refuse(REFUSAL.SHARD_NOT_ELIGIBLE, "a rollback names the shard and its operating region");
  }
  if (!source.reason) {
    return refuse(
      REFUSAL.NO_REASON_GIVEN,
      "a rollback carries a reason. Nothing else about a rollback is refusable — a control that can be " +
        "refused is not a control — but an unexplained one leaves the next operator guessing.",
    );
  }

  // An automatic rollback is the one automatic action permitted; assert it by name so a
  // future caller cannot widen the automatic path by passing a different action.
  if (source.automatic === true) guardrails.assertOneDirectional("DISABLE");

  return {
    authorised: true,
    refusal: null,
    action: {
      type: ACTION.ROLLBACK,
      shardId,
      regionId,
      binding: { level: "region", key: regionId, name: enabled.PARAMETER, value: false },
      requestedBy: source.requestedBy ? String(source.requestedBy) : null,
      automatic: source.automatic === true,
      reason: String(source.reason),
      assessment: source.assessment || null,
      requestedAtMs: typeof source.requestedAtMs === "number" ? source.requestedAtMs : null,
      /**
       * Stated on every rollback, because it is the fact an operator most needs and is
       * least likely to have in mind: after Phase 15 the legacy dispatcher is not in the
       * build, so this disables the shard's decision path rather than restoring another.
       *
       * The constant, not `describe()`. A rollback is issued from wherever the operator
       * is, and that machine's own `ENGINE_ENABLED` says nothing about the shard being
       * rolled back — deriving the sentence from it produced the process-level consequence
       * for a shard-level action.
       */
      consequence: enabled.SHARD_HAS_NO_DECISION_PATH,
    },
  };
}

/**
 * The audit event body for an authorised action (§21.7's audit stream).
 *
 * @param {object} action
 * @returns {object}
 */
function auditEventFor(action) {
  return {
    eventType: action.type === ACTION.ENABLE ? "CUTOVER_SHARD_ENABLED" : "CUTOVER_SHARD_ROLLED_BACK",
    subjectType: "SHARD",
    subjectId: action.shardId,
    actorId: action.type === ACTION.ENABLE ? action.requestedBy : action.requestedBy || "AUTOMATIC",
    actorRole: action.automatic ? "AUTOMATIC_CONTROLLER" : "OPERATOR",
    reason: action.reason,
    payload: {
      regionId: action.regionId,
      binding: action.binding,
      approvedBy: action.approvedBy || null,
      orderPosition: action.orderPosition || null,
      orderOverride: action.orderOverride || null,
      assessment: action.assessment || null,
      /**
       * The pre-declaration itself, carried into the append-only hash-chained stream
       * rather than into a table of its own. It is the evidence that the guardrails
       * existed **before** the shard went live, and §21.7's stream is the one place in
       * the system where that ordering cannot be edited afterwards. `cutover/store.js`
       * reads it back; nothing else writes it.
       */
      guardrails: action.guardrailDeclaration || null,
    },
  };
}

module.exports = {
  ACTION,
  PURPOSE,
  REHEARSAL_EXCLUDED_GATES,
  REFUSAL,
  ELIGIBLE_SHARD_STATES,
  stagingOrder,
  plan,
  tierTwoAtShipState,
  authoriseEnable,
  authoriseRollback,
  auditEventFor,
};

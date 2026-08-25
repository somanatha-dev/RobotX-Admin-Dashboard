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
const auditStream = require("../observability/auditStream");
const enabled = require("./enabled");
const evidence = require("./evidence");
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
  /**
   * P15-C1 — the request did not supply what the release evidence must be judged against.
   *
   * Kept apart from `RELEASE_GATE_NOT_GREEN` because they are different incidents. That one
   * says *the evidence was judged and it does not discharge the table*; this one says *the
   * request did not say what to judge the evidence against*, which is the caller's defect
   * and not the release's. Reporting the second as the first is how the previous behaviour
   * — silently judging against nothing — would have read if it had failed closed.
   */
  EVIDENCE_CONTEXT_INCOMPLETE: "EVIDENCE_CONTEXT_INCOMPLETE",
  /**
   * P15-F1 — the request stated a minimum observation window.
   *
   * Kept apart from `EVIDENCE_CONTEXT_INCOMPLETE` for the same reason that one is kept apart
   * from `RELEASE_GATE_NOT_GREEN`: they are different incidents. That one says *the request
   * did not supply a dependency*; this one says *the request supplied a value it does not own*.
   * A caller who states `{ soak: 1000 }` has not made a mistake of omission — they have
   * asserted an authority the register holds, and being told so by name is the difference
   * between a fixed request and a repeated attempt.
   */
  OBSERVATION_BOUND_NOT_THE_CALLERS: "OBSERVATION_BOUND_NOT_THE_CALLERS",
  /**
   * P15-F1 — the authoritative parameter source was supplied and could not be read.
   *
   * Distinct from a parameter that is *absent* or *invalid*: those two resolve to no bound,
   * which refuses the gate they bound (`evidence.admit`'s `OBSERVATION_WINDOW_REQUIRED`) and
   * leaves the rest of the table judged. A register accessor that throws has told us nothing
   * about any parameter, so nothing about this request can be judged and the whole of it is
   * refused rather than the two rows that happen to depend on it.
   */
  PARAMETER_REGISTER_UNREADABLE: "PARAMETER_REGISTER_UNREADABLE",
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
 * @param {{ get: (name: string) => any }} request.parameterValues the authoritative parameter
 *   source. The minimum observation windows are resolved from it **here** (P15-F1); a request
 *   that states `minObservationMs` is refused, because a caller who can state the bound can
 *   state a smaller one.
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
  //
  // ── P15-C1 — the context is checked here, not passed through as `undefined` ──
  //
  // These three fields used to be forwarded with `typeof … === "number" ? … : undefined`,
  // and `evidence.admit()` read `nowMs` and `maxAgeMs` through `typeof` guards of its own.
  // The two omissions composed into a fail-open at the exact point this module exists to be
  // the authority: a request that named no `requestedAtMs` and no `evidenceMaxAgeMs`
  // authorised a production cutover against evidence whose age nothing had looked at —
  // including `rollback_rehearsed`, which carries no source digest and for which the age
  // bound is therefore the only binding to the system being shipped.
  //
  // `admit()` now refuses a missing bound by name, so this would already fail closed. It is
  // still checked *here*, first, because a caller who forgot a field must be told that
  // rather than handed "24 blocking gates are not green" — a refusal that names the wrong
  // thing sends the next operator to look at the release instead of at their request.
  //
  // `requestedAtMs` earns its own mention: it is read again below to decide whether the
  // guardrails were declared *before* this request, so omitting it silently disabled the
  // "pre-declared" ordering check as well. One missing field, three protections off.
  //
  // ── P15-F1 — the observation bound is the register's, and a request may not state it ──
  //
  // P15-E4 closed the degenerate values of this field and left the class open. It refuses a
  // bound of `0`, `NaN`, `±Infinity`, a string or `null`; it admits **any positive finite
  // number, however small**, because nothing anywhere compared the caller's bound against the
  // register's. Measured against the shipped module before this fix, with
  // `release.soak_duration = 72` hours and `cutover.shadow_agreement_window = 14` days in the
  // register:
  //
  //     *** ADMITTED + PASS ***  soak: window 2 000 ms, caller bound 1 000 ms
  //     *** ADMITTED + PASS ***  soak: window 1 ms,     caller bound 0.5 ms
  //     *** ADMITTED + PASS ***  shadow_agreement: window 1 000 ms, caller bound 1 000 ms
  //
  // A gate whose entire content is *"72 hours of production soak"* was discharged by a
  // one-second window, by adding one field to the request object. And it was not hypothetical:
  // `tools/verify/phase15EvidenceBinding.js` supplied `soak: DAY` — 24 hours against a
  // register value of 72 — and its 17/17 green included a soak gate judged against a third of
  // the required duration, because nothing compared it to anything.
  //
  // The previous comment here read *"Resolved by the caller from the register"*. That was the
  // whole defect: a contract stated in a comment and enforced nowhere is not a contract, and
  // the field it describes is an override with the register's name on it. The same argument
  // this module makes for the second approver applies — the party the rule constrains may not
  // supply the rule — so the number is removed from the request and resolved **here**, by the
  // authority, from the authoritative parameter source.
  //
  // Both directions are refused, not only the weakening one. A caller-supplied *larger* bound
  // would be extra caution, and refusing it costs nothing this system needs: the requirement
  // is §21.6's and §24.6's, it is registered, and an operator who believes 72 hours is too
  // short changes `release.soak_duration` through the Config Service — a versioned, approved,
  // audited change — rather than by typing a bigger number into one cutover request. An
  // authority that accepts a stricter bound from a caller has conceded that the bound is the
  // caller's, and the next caller states a smaller one.
  if (Object.hasOwn(source, "minObservationMs")) {
    return refuse(
      REFUSAL.OBSERVATION_BOUND_NOT_THE_CALLERS,
      "this request states `minObservationMs`. The minimum observation window for " +
        `${Object.keys(evidence.MIN_OBSERVATION_PARAMETER).join(" and ")} is the register's — ` +
        `${Object.values(evidence.MIN_OBSERVATION_PARAMETER).join(", ")} — and is resolved here rather than ` +
        "supplied. A caller who can state the bound can state a smaller one, and a gate whose whole content " +
        "is a duration would then be discharged by whatever duration the caller was willing to wait. Supply " +
        "`parameterValues` instead: the authority reads the requirement, the request does not declare it.",
      { field: "minObservationMs", supplied: source.minObservationMs },
    );
  }

  const missingContext = [];
  if (typeof source.requestedAtMs !== "number" || !Number.isFinite(source.requestedAtMs)) {
    missingContext.push("`requestedAtMs` — the instant to age the evidence against, and the instant the " +
      "guardrail pre-declaration is ordered against");
  }
  if (typeof source.evidenceMaxAgeMs !== "number" || !Number.isFinite(source.evidenceMaxAgeMs) || source.evidenceMaxAgeMs < 0) {
    missingContext.push("`evidenceMaxAgeMs` — how stale a record may be and still describe this system");
  }
  if (typeof source.sourceDigest !== "string" || source.sourceDigest.trim() === "") {
    missingContext.push("`sourceDigest` — the tree the build gates' run records must have run against");
  }
  // P15-F1 — the authoritative parameter source, made an explicit dependency of the authority.
  //
  // Absent, it is refused here rather than defaulted to an empty accessor. An empty accessor
  // would also fail closed — `resolveMinObservationMs({})` yields no bound and `admit()`
  // refuses both windowed gates — but it would fail closed while *reporting the wrong thing*:
  // "soak and shadow_agreement are not green", sending the next operator to look at the
  // release when the defect is that this process cannot read the register. That is the exact
  // argument P15-C1 gives one screen up for checking the other three fields here rather than
  // relying on `admit()` alone, and it applies unchanged.
  if (!source.parameterValues || typeof source.parameterValues.get !== "function") {
    missingContext.push(
      "`parameterValues` — the authoritative parameter source (`{ get(name) }`, as the Config Service " +
        "resolves it) from which the minimum observation windows for " +
        `${Object.keys(evidence.MIN_OBSERVATION_PARAMETER).join(" and ")} are read`,
    );
  }
  if (missingContext.length > 0) {
    return refuse(
      REFUSAL.EVIDENCE_CONTEXT_INCOMPLETE,
      "the release evidence cannot be judged: this request supplies no " +
        missingContext.join("; and no ") +
        ". Evidence judged against nothing is not weaker evidence; it is no evidence, and this is the one " +
        "call in the system whose answer takes a shard live.",
      missingContext,
    );
  }

  /**
   * P15-F1 — the authority resolves the requirement, from the register, itself.
   *
   * `resolveMinObservationMs` **omits** any parameter that is absent or that resolves to
   * something other than a finite positive number, and `evidence.admit()` refuses a gate the
   * register bounds whose bound did not resolve. So the four states the mandate distinguishes
   * stay distinguished, and three of the four are refusals:
   *
   *   - the parameter source is **absent**            → `EVIDENCE_CONTEXT_INCOMPLETE`, above
   *   - a **parameter** is absent from the register   → omitted → that gate is refused
   *     (`OBSERVATION_WINDOW_REQUIRED`), the rest of the table still judged
   *   - a parameter is **invalid** (0, `NaN`, `-1`,
   *     `Infinity`, a string, `null`)                 → omitted → the same refusal
   *   - a parameter is **valid**                      → it, and only it, is the requirement
   *
   * Nothing here invents a default, reads a missing value as zero, or reads one as unlimited.
   * A register that lost `release.soak_duration` reddens the soak gate; it does not unbound it.
   */
  let minObservationMs;
  try {
    minObservationMs = evidence.resolveMinObservationMs(source.parameterValues);
  } catch (error) {
    return refuse(
      REFUSAL.PARAMETER_REGISTER_UNREADABLE,
      "the authoritative parameter source threw while resolving the minimum observation windows: " +
        `${error && error.message}. A register that cannot be read has said nothing about any parameter, ` +
        "so this request is refused rather than judged against the bounds that happen to have resolved.",
      { message: error && error.message },
    );
  }

  const blocking = gates.blockers(source.releaseEvidence, {
    nowMs: source.requestedAtMs,
    maxAgeMs: source.evidenceMaxAgeMs,
    sourceDigest: source.sourceDigest,
    minObservationMs,
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
  //
  // ── P15-C2 — the declaration is validated, not merely present ──────────────
  //
  // This step used to check two things about `source.declaration`: that it existed, and that
  // its `shardId` matched. Nothing else. It was then copied verbatim into the action as
  // `guardrailDeclaration`, and `auditEventFor` wrote it into §21.7's stream.
  //
  // The read side does not accept what the write side was accepting. `cutover/store.js`
  // states its own rule — *"`declarationFor` returns exactly what was written at enable
  // time, **re-validated through `guardrails.declare()`** so that a corrupted or truncated
  // payload is refused rather than partially honoured"* — and returns `null` when the
  // re-validation throws.
  //
  // So a hand-built `{ shardId, declaredAtMs }`, or any declaration with an empty guardrail
  // set, was authorised here, written to the audit, and then **refused by the controller on
  // its very first pass**. `cutover.worker.assessShard` reports that shard as *"live with no
  // pre-declared guardrails"* and returns HOLD without assessing it — on that pass and on
  // every pass afterwards. The shard is live, unguarded, and the automatic rollback of §22.4
  // item 4 can never fire for it.
  //
  // That is the same end state P15-R1 found and fixed from the rollback side, reached from
  // the enable side, and it is worse here: there the shard had at least breached something,
  // and here nothing was ever watching. `guardrails.declare()` refuses an empty set in as
  // many words — *"a guardrail declaration with no guardrails is a stage with no
  // guardrails"* — and this call site simply never asked it.
  //
  // Validated through the **same function** the reader uses, deliberately. A second
  // implementation of "is this declaration well formed" is how the two sides came to
  // disagree in the first place, and the normalised result is what goes into the action, so
  // what the audit records is exactly what the controller will later accept.
  if (!source.declaration) {
    return refuse(
      REFUSAL.GUARDRAILS_NOT_DECLARED,
      `no pre-declared SLI guardrails for shard ${shardId}. §22.4 item 4 stages by shard "monitored against ` +
        'pre-declared SLI guardrails, with automatic rollback"; declaring them afterwards is not that.',
    );
  }

  let declaration;
  try {
    declaration = guardrails.declare(source.declaration);
  } catch (error) {
    return refuse(
      REFUSAL.GUARDRAILS_NOT_DECLARED,
      `the guardrail declaration for shard ${shardId} does not validate: ${error && error.message} — so ` +
        "`cutover/store.declarationFor` would refuse it on the controller's first pass and report this shard " +
        "as live with no pre-declared guardrails, for ever. A declaration the reader will not accept must not " +
        "authorise a cutover.",
      { message: error && error.message },
    );
  }

  if (declaration.shardId !== shardId) {
    return refuse(
      REFUSAL.GUARDRAILS_NOT_DECLARED,
      `the guardrail declaration names shard ${declaration.shardId} and this request is for ${shardId}`,
    );
  }
  if (declaration.declaredAtMs > source.requestedAtMs) {
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
 * ── PHASE 15 remediation (P15-C4) — this event was never writable ───────────
 * Two independent reasons, both found by writing one to a real database for the first time:
 * its `eventType` was outside the enforced vocabulary (see below), and it carried **no
 * instant**. `auditStream.link()` builds the row's `recordedAt` as
 * `new Date(source.recordedAtMs)`, so an absent one produced `new Date(undefined)` — an
 * Invalid Date, which PostgreSQL then refused.
 *
 * The instant was never missing from the *action*: both `authoriseEnable` and
 * `authoriseRollback` carry `requestedAtMs`, which is the right clock — a cutover is
 * recorded as of the moment it was authorised, not the moment the row happened to be
 * written, and the two differ by however long the publish took.
 *
 * Refused rather than defaulted to `Date.now()`. An audit event is a non-repudiation record
 * (§21.7); stamping one with the writer's clock because the authorisation's was missing
 * would put a plausible number where a fact belongs, and the caller that lost the instant
 * is the thing to fix.
 *
 * @param {object} action
 * @returns {object}
 */
function auditEventFor(action) {
  if (typeof action.requestedAtMs !== "number" || !Number.isFinite(action.requestedAtMs)) {
    throw new TypeError(
      "a cutover audit event carries the instant its action was authorised (`requestedAtMs`). Without one " +
        "`auditStream.link()` stamps the row `new Date(undefined)` and the append is refused — which is how " +
        "this event came to be unwritable. Substituting the writer's clock would put a plausible number where " +
        "§21.7 requires a fact.",
    );
  }
  return {
    recordedAtMs: action.requestedAtMs,
    // PHASE 15 remediation (P15-C4) — from the vocabulary the stream and the database
    // actually enforce, not from a literal here. As literals these two names were refused
    // by `auditStream.append()` and by the `AuditEvent_event_type_known` CHECK constraint,
    // so no cutover event could be written and `store.declarationFor()` found none.
    eventType:
      action.type === ACTION.ENABLE
        ? auditStream.EVENT_TYPE.CUTOVER_SHARD_ENABLED
        : auditStream.EVENT_TYPE.CUTOVER_SHARD_ROLLED_BACK,
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

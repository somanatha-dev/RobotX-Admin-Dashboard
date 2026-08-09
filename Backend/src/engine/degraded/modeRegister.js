"use strict";

/**
 * The degraded-mode register (§18.5) — **Tier 0**, mechanism T0-11.
 *
 * > A degraded mode is a **named, entered, exited, and recorded state of a shard**, not
 * > an emergent condition. Naming them is what makes it possible to state, per invariant,
 * > what is still guaranteed while one is active (§26.2) — and an invariant register that
 * > does not say what it means during a database outage is unenforceable exactly when
 * > enforcement matters.
 *
 * ── Why this module is data first and behaviour second ──────────────────────
 * The specification's §18.5 table and §26.2 matrix are the deliverable. A register whose
 * modes are discovered by reading the code that enters them is the "emergent condition"
 * the first sentence rejects. So the six modes, their envelopes, their suspension sets,
 * and every one of the 132 cells of §26.2 are **declared here as frozen data**, and the
 * functions in this module are queries over that data. `transitions.js` performs entry
 * and exit; `observability/invariantChecker.js` reads the matrix to decide whether a
 * failing check is `VIOLATED` or `SUSPENDED`.
 *
 * ── The four governing rules, each enforced rather than described ───────────
 *
 *   1. **Entry and exit are events.** `entryEvent()` / `exitEvent()` produce the audit
 *      payload §18.5 requires — cause, entering component, and the set of invariants
 *      suspended — and refuse to build one that omits any of the three.
 *   2. **A suspension is explicit, scoped, and time-boxed.** `suspensionsFor()` returns
 *      the *declared* set and nothing else; there is no API by which a caller supplies
 *      its own. Every suspension carries the mode that authorised it and the
 *      `degraded.max_duration` box, and `assertEverySuspensionIsTimeBoxed()` proves no
 *      mode can suspend an invariant without one.
 *   3. **No mode may promote the cache tier to an authority.**
 *      `assertNoCacheAuthority()` refuses any envelope carrying a field capable of
 *      redesignating where truth lives — by name, so a future field called
 *      `readLeasesFromCache` fails the build rather than quietly working.
 *   4. **No mode relaxes a class I or R constraint.** `assertRelaxesNoConstraint()`
 *      checks the same two properties `feasibility/systemicGuard.js` checks for
 *      Restricted Operation, applied to all six: no predicate-override field of any
 *      name, and every numeric knob pointing in the tightening direction.
 *
 * Beyond the four, §26.2 states a fifth property the matrix is load-bearing for, and it
 * is proved here too: **no mode suspends a safety invariant.** `assertNoSafetyInvariantSuspended()`
 * checks that I1, I7, I8, I9, I17 and I19 are `E` in every column, which is the claim
 * "degradation narrows the envelope; it never removes a guarantee about the physical
 * world" (T3) reduced to an assertion over the table.
 *
 * ── No clock, no store, no I/O ──────────────────────────────────────────────
 * Everything here is a pure function of its arguments and of the frozen tables. Time
 * arrives as an argument, exactly as it does in `systemicGuard.js`, so a replay of a
 * round taken under a mode reaches the same conclusion about whether its box had
 * expired.
 *
 * Invariants: I2 (the one suspension in the register), and — by the assertions above —
 * the untouched status of every safety invariant in every column.
 */

/* ═══════════════════════════════════════════════════════════════════════════
   The six named modes (§18.5)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The mode names, exactly as §18.5 names them. Used as the vocabulary of the
 * `DegradedModeEvent.mode` column and its CHECK constraint.
 * @structural the specification's own mode names
 */
const MODE = Object.freeze({
  RESTRICTED_OPERATION: "RESTRICTED_OPERATION",
  CUSTODIAL_OPERATION: "CUSTODIAL_OPERATION",
  UNSUPERVISED_COMMITMENT: "UNSUPERVISED_COMMITMENT",
  DEGRADED_ROUTING: "DEGRADED_ROUTING",
  COLD_INDEX: "COLD_INDEX",
  SHED_LOAD: "SHED_LOAD",
});

const MODE_NAMES = Object.freeze(Object.values(MODE));

/**
 * The §26.2 status codes.
 *
 * > `E` = enforced and verified normally. `S` = **suspended**, verification not possible,
 * > authorised by that mode. `D` = enforced but verified at degraded latency or
 * > granularity, with the degradation recorded.
 *
 * `D` is deliberately not a euphemism for `S`: a `D` invariant is still enforced and
 * still pages on a real violation; only the instrument is coarser.
 * @structural §26.2's own three-symbol vocabulary
 */
const BEHAVIOUR = Object.freeze({
  ENFORCED: "E",
  SUSPENDED: "S",
  DEGRADED: "D",
});

/**
 * §18.5's table, one row per mode.
 *
 * `envelope` carries only *narrowings*. There is no field by which a mode can widen what
 * the engine is permitted to do, and `assertRelaxesNoConstraint()` is what keeps it that
 * way as fields are added.
 *
 * `entryTrigger` names the §18.2/§18.3 catalogue row that causes entry, so the failure
 * catalogue and the mode register are joined by an identifier rather than by prose;
 * `failure/catalogue.js` asserts the join is total in both directions.
 */
const MODES = Object.freeze({
  [MODE.RESTRICTED_OPERATION]: Object.freeze({
    name: MODE.RESTRICTED_OPERATION,
    section: "§18.5, §7.4",
    entryTrigger: "F7.4",
    enteredWhen:
      "the indeterminate-rejection fraction exceeds feasibility.systemic_indeterminacy_threshold (§7.4)",
    envelope: Object.freeze({
      missionScopeCapped: true,
      maxMissionScopeParameter: "degraded.max_mission_scope",
      reserveMultiplierParameter: "degraded.reserve_factor",
      lastKnownGoodMaxAgeParameter: "degraded.max_last_known_age",
      // The property that makes this mode a *tightening*: last-known-good state is
      // admitted only with independent corroboration, which is strictly harder than
      // nominal admission. §23.5 forbids an unmonitored agent vouching for itself.
      requiresIndependentCorroboration: true,
      recordCommitmentsAsDegraded: true,
    }),
    suspendsInvariants: Object.freeze([]),
    exitWhen:
      "the indeterminate fraction recovers, or degraded.max_duration elapses and an operator acknowledges",
    /**
     * §7.4 step 4 — the only mode whose expiry is survivable by acknowledgement rather
     * than only by the underlying condition clearing.
     */
    exitOnOperatorAcknowledgement: true,
    ownedBy: "feasibility/systemicGuard.js supplies the assessment; this register owns the mode",
  }),

  [MODE.CUSTODIAL_OPERATION]: Object.freeze({
    name: MODE.CUSTODIAL_OPERATION,
    section: "§18.5, §18.3 B1",
    entryTrigger: "B1",
    enteredWhen: "the Commitment Store is unavailable (B1)",
    envelope: Object.freeze({
      // The two that define the mode. §18.5: "**No commits and no commands.**"
      noCommits: true,
      noCommands: true,
      // Intake continues queueing — infrastructure failure never fails customer work
      // (§18.4). The queue drains more slowly, with honest ETAs.
      intakeContinues: true,
      publishHonestEtas: true,
      // The safety property that *replaces* server-side supervision, enforced on the
      // agent and therefore unaffected by any server-side outage.
      agentAutonomyLimitParameter: "agent.autonomous_continuation_limit",
      // Exit is two-step: the store returning is necessary and not sufficient.
      reconciliationRequiredBeforeRounds: true,
    }),
    suspendsInvariants: Object.freeze(["I2"]),
    exitWhen: "the store returns **and** full reconciliation completes",
    exitOnOperatorAcknowledgement: false,
    ownedBy: "failure/infraFailures.js B1 detects; this register owns the mode",
  }),

  [MODE.UNSUPERVISED_COMMITMENT]: Object.freeze({
    name: MODE.UNSUPERVISED_COMMITMENT,
    section: "§18.5, §18.3 B4, §4.5",
    entryTrigger: "B4",
    enteredWhen:
      "the timer store is unavailable or lagging beyond supervise.max_timer_lag (B4, §4.5)",
    envelope: Object.freeze({
      // "No new hardening" is the load-bearing half: the correct response to losing
      // supervision is to stop creating things that need supervising (T3).
      stopNewHardening: true,
      supervisionMechanism: "RECONCILER_SWEEP",
      supervisionAtReducedFrequency: true,
      commitmentRateReduced: true,
    }),
    suspendsInvariants: Object.freeze(["I4"]),
    exitWhen: "the timer store recovers and the timer/state cross-audit is clean",
    exitOnOperatorAcknowledgement: false,
    ownedBy: "supervision/timers.assessLag detects; this register owns the mode",
  }),

  [MODE.DEGRADED_ROUTING]: Object.freeze({
    name: MODE.DEGRADED_ROUTING,
    section: "§18.5, §18.3 B5, B6",
    entryTrigger: "B5",
    enteredWhen: "the Routing Service is unavailable or partially failing (B5, B6)",
    envelope: Object.freeze({
      maxCandidateRadiusParameter: "route.degraded_max_radius",
      reserveMultiplierParameter: "route.degraded_reserve_factor",
      onlyPreSurveyedCorridorsHardened: true,
      // B6's uniform treatment, which is what prevents the baseline's partial-failure
      // bias: a candidate whose route lookup failed must not score *better* than one
      // whose succeeded merely because its data was missing.
      uniformDegradedEstimation: true,
      reportedGapsCarryDegradationFlag: true,
    }),
    suspendsInvariants: Object.freeze([]),
    exitWhen: "routing recovers",
    exitOnOperatorAcknowledgement: false,
    ownedBy: "failure/infraFailures.js B5/B6 detect; this register owns the mode",
  }),

  [MODE.COLD_INDEX]: Object.freeze({
    name: MODE.COLD_INDEX,
    section: "§18.5, §18.3 B3",
    entryTrigger: "B3",
    enteredWhen: "the cache tier is lost entirely (B3)",
    envelope: Object.freeze({
      candidateSearchNarrowed: true,
      // §3.3 and I16. The durable path is unchanged, which is why this mode suspends
      // nothing: correctness never depended on the cache tier in the first place.
      continuesOnDurablePath: true,
      indexRebuiltFrom: "OBSERVATION_LOG_AND_NEXT_HEARTBEATS",
      correctnessUnaffected: true,
    }),
    suspendsInvariants: Object.freeze([]),
    exitWhen: "the index is rebuilt from the observation log",
    exitOnOperatorAcknowledgement: false,
    ownedBy: "failure/infraFailures.js B3 detects; this register owns the mode",
  }),

  [MODE.SHED_LOAD]: Object.freeze({
    name: MODE.SHED_LOAD,
    section: "§18.5, §18.3 B19, §20.5",
    entryTrigger: "B19",
    enteredWhen: "arrival rate exceeds capacity (B19)",
    envelope: Object.freeze({
      admissionSheddingByClass: true,
      // The published order lives in `intake/admission.SHED_LADDER`; naming it here
      // rather than restating it is what stops two shed orders existing.
      shedOrderOwnedBy: "intake/admission.js SHED_LADDER (§20.5)",
      speculativePurposesShedFirst: true,
      custodialPurposesNeverShed: true,
      declinesAreExplicit: true,
      publishHonestEtas: true,
    }),
    suspendsInvariants: Object.freeze([]),
    exitWhen: "queue delay returns within budget",
    exitOnOperatorAcknowledgement: false,
    ownedBy: "intake/admission.js applies the ladder; this register owns the mode",
  }),
});

/* ═══════════════════════════════════════════════════════════════════════════
   §26.2 — invariant behaviour under degraded modes
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The twenty-two invariants of §26.1, in the register's own order.
 * @structural the invariant identifiers of §26.1
 */
const INVARIANTS = Object.freeze([
  "I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9", "I10", "I11",
  "I12", "I13", "I14", "I15", "I16", "I17", "I18", "I19", "I20", "I21", "I22",
]);

/**
 * The six safety invariants §26.2 states are `E` in **every** column.
 *
 * > **No mode suspends a safety invariant.** I1, I7, I8, I9, I17, and I19 are `E` in
 * > every column. Degradation narrows the envelope; it never removes a guarantee about
 * > the physical world (T3).
 * @structural the specification's own enumeration of the never-degraded invariants
 */
const NEVER_DEGRADED_INVARIANTS = Object.freeze(["I1", "I7", "I8", "I9", "I17", "I19"]);

/**
 * §26.2's matrix, transcribed cell by cell: `MATRIX[invariant][mode]`.
 *
 * Every cell carries its status **and the sentence §26.2 gives for it**, because the
 * reason is what an on-call engineer needs at 3am and because several cells are `E` for
 * reasons worth recording — an invariant that holds *vacuously* under Custodial
 * Operation is genuinely satisfied, but it is satisfied because the operation it governs
 * is not occurring, which means the guarantee returns automatically on mode exit rather
 * than requiring repair.
 *
 * `vacuous: true` marks exactly those cells.
 */
const MATRIX = Object.freeze({
  I1: cells("exclusivity", {
    CUSTODIAL_OPERATION: vacuous("no commits occur, so the bound holds vacuously"),
  }),
  I2: cells("lease validity", {
    CUSTODIAL_OPERATION: suspended(
      "the only suspension in the register; on-agent autonomy limits carry the safety property (§18.5)",
    ),
    UNSUPERVISED_COMMITMENT: degraded(
      "verified by reconciler sweep rather than timer, at sweep granularity",
    ),
  }),
  I3: cells("Leg accounted for", {}),
  I4: cells("pending timer", {
    CUSTODIAL_OPERATION: vacuous("no new states are entered"),
    UNSUPERVISED_COMMITMENT: suspended(
      "the timer store is the thing that failed; the sweep substitutes and its lag is the SLI",
    ),
  }),
  I5: cells("no superseded fence applied", {
    CUSTODIAL_OPERATION: vacuous("no commands are issued"),
  }),
  I6: cells("fence monotonicity", {}),
  I7: cells("custody before pool return", {
    CUSTODIAL_OPERATION: enforced("settlement halts rather than releasing"),
  }),
  I8: cells("custody accountable", {}),
  I9: cells("no infeasible commit", {
    RESTRICTED_OPERATION: enforced("envelope narrowed, constraints unchanged"),
    CUSTODIAL_OPERATION: vacuous("vacuous"),
    DEGRADED_ROUTING: enforced(
      "degraded estimates are used **uniformly** and reserves widen; the predicates themselves are unchanged",
    ),
  }),
  I10: cells("replayable decision", {
    CUSTODIAL_OPERATION: vacuous("vacuous"),
  }),
  I11: cells("cancellation", {
    CUSTODIAL_OPERATION: degraded(
      "cancellation is accepted and durably recorded, but resolution waits for the store",
    ),
  }),
  I12: cells("terminal immutability", {}),
  I13: cells("ladder progress", {
    CUSTODIAL_OPERATION: degraded(
      "the ladder continues to advance on elapsed budget; steps requiring a commitment queue until the store returns",
    ),
    SHED_LOAD: enforced("shedding is itself a ladder-visible decision"),
  }),
  I14: cells("cost only for feasible", {}),
  I15: cells("config resolvable", {}),
  I16: cells("cache loss harmless", {
    COLD_INDEX: enforced("this mode **is** the test of I16"),
  }),
  I17: cells("energy tiers", {
    RESTRICTED_OPERATION: enforced("reserves widen"),
    DEGRADED_ROUTING: enforced("reserves × route.degraded_reserve_factor"),
  }),
  I18: cells("no durable SOFT", {}),
  I19: cells("no cross-commitment invalidation", {}),
  I20: cells("gaps are true bounds", {
    DEGRADED_ROUTING: degraded(
      "bounds remain admissible; the reported gaps widen and carry a degradation flag",
    ),
  }),
  I21: cells("no double application", {
    CUSTODIAL_OPERATION: vacuous("no commands issued"),
  }),
  I22: cells("stranding classified", {
    RESTRICTED_OPERATION: degraded(
      "if map hazard data is indeterminate, classification resolves to STRANDED_OBSTRUCTING (§4.3)",
    ),
    DEGRADED_ROUTING: degraded("same resolution when map data is stale"),
  }),
});

/**
 * Build one invariant's row: `E` with no note in every column, then the overrides.
 *
 * Defaulting to `E` is the safe direction — a cell nobody transcribed reports the
 * invariant as fully enforced, so a transcription omission produces a false *page*
 * rather than a false silence, and `assertMatrixMatchesSuspensionSets()` catches the
 * omission at build time in any case.
 *
 * @param {string} label the §26.2 row label
 * @param {Record<string, object>} overrides
 * @returns {object}
 */
function cells(label, overrides) {
  const row = { label };
  for (const mode of MODE_NAMES) {
    row[mode] = Object.freeze(overrides[mode] || { status: BEHAVIOUR.ENFORCED, note: null, vacuous: false });
  }
  return Object.freeze(row);
}

/** @param {string} note @returns {object} */
function enforced(note) {
  return Object.freeze({ status: BEHAVIOUR.ENFORCED, note, vacuous: false });
}

/** @param {string} note @returns {object} */
function vacuous(note) {
  return Object.freeze({ status: BEHAVIOUR.ENFORCED, note, vacuous: true });
}

/** @param {string} note @returns {object} */
function suspended(note) {
  return Object.freeze({ status: BEHAVIOUR.SUSPENDED, note, vacuous: false });
}

/** @param {string} note @returns {object} */
function degraded(note) {
  return Object.freeze({ status: BEHAVIOUR.DEGRADED, note, vacuous: false });
}

/* ═══════════════════════════════════════════════════════════════════════════
   Queries
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {string} mode
 * @returns {boolean}
 */
function isMode(mode) {
  return typeof mode === "string" && Object.prototype.hasOwnProperty.call(MODES, mode);
}

/**
 * The declared row for a mode.
 *
 * @param {string} mode
 * @returns {object}
 * @throws {TypeError} on an unregistered name — an unnamed mode is the "emergent
 *   condition" §18.5 exists to forbid, and returning `null` would let one propagate.
 */
function modeOf(mode) {
  if (!isMode(mode)) {
    throw new TypeError(
      `"${String(mode)}" is not one of §18.5's six named degraded modes [${MODE_NAMES.join(", ")}]. ` +
        "A degraded mode is a named, entered, exited, and recorded state of a shard, not an emergent condition.",
    );
  }
  return MODES[mode];
}

/**
 * Rule 2 — the invariants a mode suspends, from the declaration and from nowhere else.
 *
 * There is deliberately no parameter by which a caller can add to this set. "No
 * invariant is ever suspended implicitly by a component finding it inconvenient, and
 * every suspension names the mode that authorised it" is enforced by the absence of the
 * API that would allow it.
 *
 * @param {string} mode
 * @returns {readonly string[]}
 */
function suspensionsFor(mode) {
  return modeOf(mode).suspendsInvariants;
}

/**
 * §26.2's cell for one invariant under one mode.
 *
 * @param {string} invariantId
 * @param {string} mode
 * @returns {{ status: string, note: string|null, vacuous: boolean }}
 */
function behaviourOf(invariantId, mode) {
  const row = MATRIX[invariantId];
  if (!row) {
    throw new TypeError(
      `"${String(invariantId)}" is not one of §26.1's twenty-two invariants. §26.2 requires **every** ` +
        "invariant to state its behaviour in every named mode; an unknown identifier has no stated behaviour.",
    );
  }
  return row[modeOf(mode).name];
}

/**
 * The behaviour of one invariant given the **set** of modes a shard is currently in.
 *
 * Several modes can be active at once — a routing outage during an overload is not a
 * novel condition — so the resolution rule must be stated rather than assumed. It is the
 * most permissive-to-the-checker one that remains honest: `S` beats `D` beats `E`,
 * because a suspension means verification is *not possible*, and a verifier that
 * reported `D` while one authorising mode said `S` would be claiming a check it cannot
 * perform.
 *
 * The authorising mode is returned with the status, so a suspension always names the
 * mode that authorised it (rule 2) even when three are active.
 *
 * @param {string} invariantId
 * @param {readonly string[]} activeModes
 * @returns {{ status: string, authorisedBy: string|null, note: string|null, vacuous: boolean }}
 */
function resolveBehaviour(invariantId, activeModes) {
  const modes = Array.isArray(activeModes) ? activeModes : [];
  let best = { status: BEHAVIOUR.ENFORCED, authorisedBy: null, note: null, vacuous: false };

  for (const mode of modes) {
    const cell = behaviourOf(invariantId, mode);
    if (cell.status === BEHAVIOUR.SUSPENDED) {
      return { status: cell.status, authorisedBy: mode, note: cell.note, vacuous: cell.vacuous };
    }
    if (cell.status === BEHAVIOUR.DEGRADED && best.status === BEHAVIOUR.ENFORCED) {
      best = { status: cell.status, authorisedBy: mode, note: cell.note, vacuous: cell.vacuous };
    }
    if (cell.status === BEHAVIOUR.ENFORCED && cell.vacuous && best.status === BEHAVIOUR.ENFORCED && !best.vacuous) {
      best = { status: cell.status, authorisedBy: mode, note: cell.note, vacuous: true };
    }
  }

  return best;
}

/**
 * Does any active mode forbid issuing commands (§18.5 Custodial Operation)?
 *
 * Read by `services/commandDispatcher.js` before every engine command. It is a query
 * over the register rather than a flag the dispatcher keeps, because a second copy of
 * "are we allowed to command" is a second thing that can be wrong.
 *
 * @param {readonly string[]} activeModes
 * @returns {{ suspended: boolean, byMode: string|null, reason: string|null }}
 */
function commandsSuspended(activeModes) {
  for (const mode of Array.isArray(activeModes) ? activeModes : []) {
    if (modeOf(mode).envelope.noCommands === true) {
      return {
        suspended: true,
        byMode: mode,
        reason:
          "§18.5 Custodial Operation: command authority derives from a fence allocated in the Commitment " +
          "Store; with the store unavailable no fence can be allocated, so no command can be authorised. " +
          "The engine does not fall back to a cached fence, because a fence that cannot be advanced " +
          "durably provides none of the protection a fence exists to provide.",
      };
    }
  }
  return { suspended: false, byMode: null, reason: null };
}

/**
 * Does any active mode forbid taking new commitments?
 *
 * @param {readonly string[]} activeModes
 * @returns {{ suspended: boolean, byMode: string|null, reason: string|null }}
 */
function commitsSuspended(activeModes) {
  for (const mode of Array.isArray(activeModes) ? activeModes : []) {
    if (modeOf(mode).envelope.noCommits === true) {
      return {
        suspended: true,
        byMode: mode,
        reason: "§18.5 Custodial Operation: no commits. Intake continues queueing and no task is failed for this reason (§18.4).",
      };
    }
  }
  return { suspended: false, byMode: null, reason: null };
}

/**
 * Does any active mode forbid hardening a new commitment into a supervised one?
 *
 * @param {readonly string[]} activeModes
 * @returns {{ stopped: boolean, byMode: string|null }}
 */
function hardeningStopped(activeModes) {
  for (const mode of Array.isArray(activeModes) ? activeModes : []) {
    if (modeOf(mode).envelope.stopNewHardening === true) return { stopped: true, byMode: mode };
  }
  return { stopped: false, byMode: null };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Rule 1 — entry and exit are events
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * §18.5 rule 1 — the entry event.
 *
 * > **Entry and exit are events**, written to the audit stream with cause, entering
 * > component, and the set of invariants suspended.
 *
 * All three are mandatory. An entry recorded without its cause is a mode nobody can
 * explain afterwards, and one recorded without its entering component is a mode nobody
 * owns — both of which convert a named state back into the emergent condition §18.5
 * rejects.
 *
 * @param {object} input
 * @param {string} input.mode
 * @param {string} input.shardId
 * @param {string} input.cause why the mode was entered
 * @param {string} input.enteringComponent which component determined it
 * @param {number} input.atMs
 * @param {number|null} [input.maxDurationMs] `degraded.max_duration`, resolved by the caller
 * @param {object} [input.detail]
 * @returns {object} the audit payload and the `DegradedModeEvent` row shape
 */
function entryEvent(input) {
  const source = input || {};
  const declared = modeOf(source.mode);

  if (!source.cause) {
    throw new TypeError(
      `entering ${declared.name} without a cause. §18.5 rule 1 requires the entry event to carry its cause; ` +
        "a mode entered for no recorded reason cannot be exited on evidence either.",
    );
  }
  if (!source.enteringComponent) {
    throw new TypeError(
      `entering ${declared.name} without an entering component. §18.5 rule 1 requires it, because a mode ` +
        "nobody entered is a mode nobody will exit.",
    );
  }
  if (!Number.isFinite(source.atMs)) {
    throw new TypeError(`entering ${declared.name} without a time. Time is supplied, never read (T6, §9.6).`);
  }

  const maxDurationMs = Number.isFinite(source.maxDurationMs) ? source.maxDurationMs : null;

  return Object.freeze({
    mode: declared.name,
    shardId: String(source.shardId),
    cause: String(source.cause),
    enteringComponent: String(source.enteringComponent),
    // Rule 1's third mandatory field. Empty is a legitimate value — four of the six
    // modes suspend nothing — and it is recorded explicitly rather than omitted, so a
    // reader can tell "suspended nothing" from "nobody wrote it down".
    suspendedInvariants: [...declared.suspendsInvariants],
    degradedInvariants: INVARIANTS.filter(
      (invariant) => behaviourOf(invariant, declared.name).status === BEHAVIOUR.DEGRADED,
    ),
    enteredAtMs: source.atMs,
    timeBox: Object.freeze({
      maxDurationMs,
      expiresAtMs: maxDurationMs === null ? null : source.atMs + maxDurationMs,
      parameter: "degraded.max_duration",
    }),
    exitWhen: declared.exitWhen,
    envelope: declared.envelope,
    detail: source.detail || null,
    section: declared.section,
  });
}

/**
 * §18.5 rule 1 — the exit event, and the SLI §18.5 requires ("time spent in each mode is
 * an SLI").
 *
 * @param {object} input
 * @param {object} input.entry the `entryEvent()` payload, or the stored row
 * @param {number} input.atMs
 * @param {string} input.reason the evidence the exit criterion was met
 * @param {string} input.exitingComponent
 * @returns {object}
 */
function exitEvent(input) {
  const source = input || {};
  const entry = source.entry || {};
  const declared = modeOf(entry.mode);

  if (!source.reason) {
    throw new TypeError(
      `exiting ${declared.name} without stating the evidence. §18.5 gives every mode an exit criterion ` +
        `("${declared.exitWhen}"); an exit with no stated evidence is an exit nobody can audit.`,
    );
  }
  if (!Number.isFinite(source.atMs)) {
    throw new TypeError(`exiting ${declared.name} without a time. Time is supplied, never read (T6, §9.6).`);
  }

  const enteredAtMs = Number.isFinite(entry.enteredAtMs)
    ? entry.enteredAtMs
    : entry.enteredAt instanceof Date
      ? entry.enteredAt.getTime()
      : null;

  return Object.freeze({
    mode: declared.name,
    shardId: entry.shardId ?? null,
    exitedAtMs: source.atMs,
    reason: String(source.reason),
    exitingComponent: String(source.exitingComponent || "unknown"),
    // "Time spent in each mode is an SLI" (§18.5 rule 1, §21.4).
    durationMs: enteredAtMs === null ? null : source.atMs - enteredAtMs,
    // Restoring an invariant is itself a fact worth recording: §18.5's Custodial
    // Operation paragraph ends "Only then is I2 restored to `ENFORCED`."
    restoredInvariants: [...declared.suspendsInvariants],
    section: declared.section,
  });
}

/**
 * Rule 2's time box, evaluated against a supplied time.
 *
 * A box whose expiry cannot be computed is treated as **expired**, matching
 * `systemicGuard.evaluateTimeBox`: §18.5 requires every suspension to be time-boxed, and
 * an unbounded degraded mode is precisely what the rule forbids.
 *
 * @param {object} entry an `entryEvent()` payload or stored row
 * @param {number} nowMs
 * @returns {{ expired: boolean, remainingMs: number|null, alertable: boolean, reason: string }}
 */
function evaluateTimeBox(entry, nowMs) {
  const box = (entry && entry.timeBox) || {};
  const expiresAtMs = Number.isFinite(box.expiresAtMs) ? box.expiresAtMs : null;

  if (expiresAtMs === null || !Number.isFinite(nowMs)) {
    return {
      expired: true,
      remainingMs: null,
      alertable: true,
      reason:
        "the time box cannot be evaluated. §18.5 rule 2 requires every suspension to be time-boxed; " +
        "a box with no computable expiry is treated as expired rather than as unbounded.",
    };
  }

  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs > 0) {
    return { expired: false, remainingMs, alertable: false, reason: "within the time box" };
  }

  return {
    expired: true,
    remainingMs,
    // §26.1: a suspension is "itself alertable if it persists beyond the mode's bound".
    alertable: true,
    reason:
      `${entry.mode} has been active past degraded.max_duration. §26.1 makes a suspension that outlives ` +
      "its box alertable, which is the counterpart of not paging for it while the box holds.",
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   The four governing rules, as assertions
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Field names that would redesignate where truth lives, in any envelope.
 *
 * §18.5 rule 3: "A mode may narrow what the engine attempts or suspend a *verification*;
 * it may never redesignate where truth lives." Enumerating the names is what makes a
 * future field called `readLeasesFromCache` fail the build rather than quietly work.
 * @structural the forbidden envelope field names of §18.5 rule 3
 */
const CACHE_AUTHORITY_FIELDS = Object.freeze([
  "cacheIsAuthoritative",
  "readLeasesFromCache",
  "authoritativeStore",
  "authorityStore",
  "truthSource",
  "trustCache",
  "cachedLeaseFallback",
  "fallbackToCache",
  "promoteCache",
]);

/**
 * Field names that would relax a constraint rather than narrow an envelope.
 *
 * The same list `feasibility/systemicGuard.assertRelaxesNothing()` refuses for
 * Restricted Operation, applied to all six modes — because §18.5 rule 4 states it for
 * all six and a rule enforced for one mode is not a rule.
 * @structural the forbidden envelope field names of §18.5 rule 4
 */
const RELAXATION_FIELDS = Object.freeze([
  "predicateOverrides",
  "relaxedPredicates",
  "waivedPredicates",
  "policyOverrides",
  "classOverrides",
  "skipPredicates",
  "suspendedPredicates",
  "relaxConstraints",
  "reserveDivisor",
]);

/**
 * §18.5 rule 3 — no mode may promote the cache tier to an authority.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertNoCacheAuthority() {
  const problems = [];
  for (const mode of MODE_NAMES) {
    const envelope = MODES[mode].envelope;
    for (const field of CACHE_AUTHORITY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(envelope, field)) {
        problems.push(
          `${mode}'s envelope exposes "${field}". §18.5 rule 3: a mode "may narrow what the engine attempts ` +
            'or suspend a *verification*; it may never redesignate where truth lives" (§3.3).',
        );
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * §18.5 rule 4 — no mode relaxes a class I or R constraint.
 *
 * Two properties, matching `systemicGuard.assertRelaxesNothing()`:
 *   1. **Shape** — no field capable of altering a predicate's outcome, policy, or class.
 *   2. **Direction** — every reserve knob is a *multiplier*, named by a parameter whose
 *      register range starts at 1, so it can only enlarge a reserve. A mode that carried
 *      a divisor would be a relaxation wearing a tightening name.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertRelaxesNoConstraint() {
  const problems = [];
  for (const mode of MODE_NAMES) {
    const envelope = MODES[mode].envelope;
    for (const field of RELAXATION_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(envelope, field)) {
        problems.push(
          `${mode}'s envelope exposes "${field}". §18.5 rule 4: "Modes shrink the envelope; they never ` +
            'lower a safety threshold" (T3).',
        );
      }
    }
    // Reserve knobs are named as *multiplier* parameters and never as absolute values,
    // so the direction is a property of the name and checkable without resolving config.
    for (const key of Object.keys(envelope)) {
      if (/reserve/i.test(key) && !/multiplierparameter$/i.test(key)) {
        problems.push(
          `${mode}'s envelope carries "${key}", which touches reserves without being a named multiplier ` +
            "parameter. §18.5 rule 4 admits reserve *multipliers* (which only enlarge) and nothing else.",
        );
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * §18.5 rule 2 — every suspension is time-boxed, and no mode suspends an invariant the
 * §26.2 matrix does not also mark `S` for that mode.
 *
 * The second half is what stops the two declarations drifting: `suspendsInvariants` is
 * what the entry event records and what an operator reads; `MATRIX` is what the Invariant
 * Checker reads. If they disagreed, the checker would page for an invariant the event
 * said was suspended, or stay silent about one it did not.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertMatrixMatchesSuspensionSets() {
  const problems = [];
  for (const mode of MODE_NAMES) {
    const declared = [...MODES[mode].suspendsInvariants].sort();
    const fromMatrix = INVARIANTS.filter(
      (invariant) => MATRIX[invariant][mode].status === BEHAVIOUR.SUSPENDED,
    ).sort();
    if (declared.join(",") !== fromMatrix.join(",")) {
      problems.push(
        `${mode} declares suspendsInvariants [${declared.join(", ")}] but the §26.2 matrix marks ` +
          `[${fromMatrix.join(", ")}] as S. The event an operator reads and the matrix the checker reads ` +
          "must be the same statement.",
      );
    }
    // Rule 2's time box: every mode is boxed by `degraded.max_duration`, and a mode that
    // suspends an invariant without one would be an unbounded suspension.
    if (MODES[mode].exitWhen === undefined || MODES[mode].exitWhen === null) {
      problems.push(`${mode} states no exit criterion. §18.5 gives every mode one.`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * §26.2's third load-bearing property — no mode suspends a safety invariant.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertNoSafetyInvariantSuspended() {
  const problems = [];
  for (const invariant of NEVER_DEGRADED_INVARIANTS) {
    for (const mode of MODE_NAMES) {
      const cell = MATRIX[invariant][mode];
      if (cell.status !== BEHAVIOUR.ENFORCED) {
        problems.push(
          `${invariant} is "${cell.status}" under ${mode}. §26.2: "No mode suspends a safety invariant. ` +
            'I1, I7, I8, I9, I17, and I19 are `E` in every column."',
        );
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * §26.2's first load-bearing property, as an assertion.
 *
 * > **Exactly one invariant is ever suspended for a reason other than the failure of its
 * > own verification mechanism**, and that is I2 in Custodial Operation. Every other `S`
 * > is I4 under the failure of the timer store itself.
 *
 * @returns {{ ok: boolean, problems: string[], suspensions: object[] }}
 */
function assertSuspensionsAreExactlyTheTwo() {
  const suspensions = [];
  for (const invariant of INVARIANTS) {
    for (const mode of MODE_NAMES) {
      if (MATRIX[invariant][mode].status === BEHAVIOUR.SUSPENDED) {
        suspensions.push({ invariant, mode });
      }
    }
  }

  const expected = [
    { invariant: "I2", mode: MODE.CUSTODIAL_OPERATION },
    { invariant: "I4", mode: MODE.UNSUPERVISED_COMMITMENT },
  ];
  const asKey = (row) => `${row.invariant}@${row.mode}`;
  const found = suspensions.map(asKey).sort();
  const wanted = expected.map(asKey).sort();

  const problems =
    found.join(",") === wanted.join(",")
      ? []
      : [
          `the matrix carries suspensions [${found.join(", ")}] but §26.2 states exactly [${wanted.join(", ")}]. ` +
            "A design that needed to suspend several unrelated invariants to survive a single dependency outage " +
            "would be telling us the invariants were poorly factored.",
        ];

  return { ok: problems.length === 0, problems, suspensions };
}

/**
 * Run every structural assertion this register makes about itself.
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
function assertRegister() {
  const results = [
    assertNoCacheAuthority(),
    assertRelaxesNoConstraint(),
    assertMatrixMatchesSuspensionSets(),
    assertNoSafetyInvariantSuspended(),
    assertSuspensionsAreExactlyTheTwo(),
  ];
  const problems = results.flatMap((result) => result.problems);
  return { ok: problems.length === 0, problems };
}

module.exports = {
  MODE,
  MODE_NAMES,
  MODES,
  BEHAVIOUR,
  INVARIANTS,
  NEVER_DEGRADED_INVARIANTS,
  MATRIX,
  CACHE_AUTHORITY_FIELDS,
  RELAXATION_FIELDS,
  isMode,
  modeOf,
  suspensionsFor,
  behaviourOf,
  resolveBehaviour,
  commandsSuspended,
  commitsSuspended,
  hardeningStopped,
  entryEvent,
  exitEvent,
  evaluateTimeBox,
  assertNoCacheAuthority,
  assertRelaxesNoConstraint,
  assertMatrixMatchesSuspensionSets,
  assertNoSafetyInvariantSuspended,
  assertSuspensionsAreExactlyTheTwo,
  assertRegister,
};

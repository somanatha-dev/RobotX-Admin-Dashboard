"use strict";

/**
 * The Charging Scheduler contract (§14.7) — the engine's side of it.
 *
 * The Scheduler is **outside this engine's boundary** (§1.6). It does not exist yet;
 * blocking decision B2 records that "a conformant publisher must be built or stubbed,
 * and the engine must never compute a target SoC". This module is the engine's half of
 * the contract, written so that the missing half is a *deployment* gap rather than a
 * design one: everything it consumes is validated at the boundary, and everything it
 * sends is a priced, refusable, recorded request.
 *
 * ── The one rule that governs every function here ──────────────────────────
 * > **Neither service may assert the other's field.** The engine never writes a
 * > reservation or a target SoC; the Scheduler never assigns work. Every cross-boundary
 * > influence is a priced, refusable, recorded request.
 *
 * There is no code path in this module that produces a target SoC from the engine's own
 * reasoning. `resolveTargetSoc()` returns either the Scheduler's published value or the
 * **configured class default** — and the class default is a published parameter, not a
 * computation. §14.6 is explicit about why:
 *
 * > It does **not** compute a substitute target from its own demand forecast, because
 * > doing so would silently transfer ownership of the decision at precisely the moment
 * > the owning service is unable to contest it.
 *
 * `assertNotEngineComputed()` makes that structural rather than conventional: a value
 * arriving with a source this module does not recognise is refused outright.
 *
 * ── What the Scheduler owns, and what arrives here ─────────────────────────
 * | Owned and published by the Scheduler | Consumed here as |
 * |---|---|
 * | Charger **reservations** | a hard constraint (F18) — a reserved agent is not available |
 * | **Target SoC** per agent per session | an input constraint, never computed |
 * | The **charger availability projection** | the pinned input that breaks the `E_return` circularity (§14.5) and keys the reachability cache (§20.3) |
 * | The fleet's target availability curve | not read by the engine at all |
 *
 * ── On Scheduler unavailability, three pre-declared degradations ───────────
 * > agents already charging continue to completion; no interruption is permitted (T3 —
 * > without the fleet-level view, interruption cannot be shown safe); target SoC falls
 * > back to the class default with a recorded degradation flag (§14.6); and `E_return`
 * > falls back to depot-only destinations (§14.5).
 *
 * `unavailabilityEnvelope()` returns exactly those three and nothing else — "the
 * envelope shrinks in three specific, pre-declared ways rather than the engine
 * improvising ownership of three decisions that are not its own".
 *
 * This module is an **L1 dependency client**, not part of the decision path: it is
 * listed in `guards/tenets.js`'s `DECISION_PATH_EXCLUSIONS` because it talks to an
 * external service, and nothing it does runs inside a round. What runs inside a round
 * is the *pinned* projection it produced earlier.
 */

/**
 * Where a target SoC came from. The engine is not on this list, and that is the point.
 * @structural the two lawful provenances of a target SoC (§14.6)
 */
const TARGET_SOC_SOURCE = Object.freeze({
  SCHEDULER: "SCHEDULER",
  CLASS_DEFAULT: "CLASS_DEFAULT",
});

/**
 * The requests the engine may make of the Scheduler. Both are refusable.
 * @structural the specification's own request kinds (§14.7)
 */
const REQUEST_KIND = Object.freeze({
  RELEASE_RESERVATION: "RELEASE_RESERVATION",
  REVISE_TARGET_SOC: "REVISE_TARGET_SOC",
});

/**
 * A request's disposition. Both outcomes are recorded in the decision record (§14.7).
 * @structural the specification's own dispositions
 */
const DISPOSITION = Object.freeze({
  GRANTED: "GRANTED",
  REFUSED: "REFUSED",
  UNANSWERED: "UNANSWERED",
});

/**
 * The three degradations §14.7 pre-declares for Scheduler unavailability.
 * @structural the specification's own unavailability envelope
 */
const UNAVAILABILITY_ENVELOPE = Object.freeze([
  Object.freeze({
    id: "CHARGE_COMPLETION_ONLY",
    rule: "Agents already charging continue to completion; no interruption is permitted",
    reason: "T3 — without the fleet-level view, interruption cannot be shown safe",
    section: "§14.7",
  }),
  Object.freeze({
    id: "TARGET_SOC_CLASS_DEFAULT",
    rule: "Target SoC falls back to energy.target_soc_fallback[agent_class], with a recorded degradation flag",
    reason: "computing a substitute target would silently transfer ownership of the decision",
    section: "§14.6",
  }),
  Object.freeze({
    id: "DEPOT_ONLY_RETURN",
    rule: "E_return falls back to depot-only destinations",
    reason: "the fixed infrastructure whose availability does not depend on any round's output",
    section: "§14.5",
  }),
]);

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate and freeze a charger availability projection at the boundary.
 *
 * > the versioned, immutable snapshot of per-charger free and reservable intervals over
 * > the planning horizon
 *
 * A projection without a version is refused rather than assigned one: the version is
 * what keys the reachability cache (§20.3 item 3) and what makes a decision replayable,
 * and a locally-minted version would collide across processes.
 *
 * @param {object} raw
 * @returns {{ ok: boolean, projection: object|null, problems: string[] }}
 */
function consumeProjection(raw) {
  const problems = [];
  if (!raw || typeof raw !== "object") {
    return { ok: false, projection: null, problems: ["no projection supplied"] };
  }
  if (raw.version === undefined || raw.version === null || raw.version === "") {
    problems.push(
      "the projection states no version. §20.3 item 3 keys the charger-reachability cache on " +
        "charger_availability_version so an entry computed under one projection is never applied under " +
        "another, and §14.5 pins the version into the round snapshot for replay",
    );
  }
  const publishedAtMs = raw.publishedAt instanceof Date ? raw.publishedAt.getTime() : raw.publishedAtMs;
  if (!isNumber(publishedAtMs)) {
    problems.push("the projection states no publication time, so its staleness cannot be measured (§14.5)");
  }
  if (!Array.isArray(raw.chargers)) {
    problems.push("the projection lists no chargers");
  }

  if (problems.length > 0) return { ok: false, projection: null, problems };

  const chargers = raw.chargers.map((charger) =>
    Object.freeze({
      chargerId: charger.chargerId,
      chargerClass: charger.chargerClass ?? null,
      cellId: charger.cellId ?? null,
      isDepot: charger.isDepot === true,
      intervals: Object.freeze(
        (Array.isArray(charger.intervals) ? charger.intervals : []).map((interval) =>
          Object.freeze({
            fromMs: interval.from instanceof Date ? interval.from.getTime() : interval.fromMs,
            untilMs: interval.until instanceof Date ? interval.until.getTime() : interval.untilMs,
            state: interval.state,
          }),
        ),
      ),
    }),
  );

  return {
    ok: true,
    // Frozen because §14.7 calls the projection immutable: a round that could mutate its
    // own pinned input could not be replayed from the version it recorded.
    projection: Object.freeze({
      version: raw.version,
      publishedAtMs,
      horizonEndMs: raw.horizonEnd instanceof Date ? raw.horizonEnd.getTime() : raw.horizonEndMs ?? null,
      chargers: Object.freeze(chargers),
    }),
    problems: [],
  };
}

/**
 * Reservations are **hard constraints** on the engine (F18), not preferences.
 *
 * > an agent reserved for charging is not available, which prevents the classic
 * > two-scheduler conflict.
 *
 * Returned in the shape F18 reads off the agent snapshot, so the predicate consumes the
 * Scheduler's field without this module reinterpreting it.
 *
 * @param {Array<object>} raw
 * @returns {{ ok: boolean, reservations: object[], problems: string[] }}
 */
function consumeReservations(raw) {
  if (!Array.isArray(raw)) return { ok: false, reservations: [], problems: ["no reservations supplied"] };

  const problems = [];
  const reservations = [];

  for (const entry of raw) {
    if (!entry || typeof entry.agentId !== "string") {
      problems.push("a reservation names no agent");
      continue;
    }
    const from = entry.from instanceof Date ? entry.from : new Date(entry.fromMs);
    const until = entry.until instanceof Date ? entry.until : new Date(entry.untilMs);
    if (Number.isNaN(from.getTime()) || Number.isNaN(until.getTime())) {
      problems.push(`the reservation for agent ${entry.agentId} states no readable window`);
      continue;
    }
    reservations.push(
      Object.freeze({
        subsystem: "CHARGING",
        agentId: entry.agentId,
        chargerId: entry.chargerId ?? null,
        from,
        until,
        // Carried through untouched. The engine consumes it (§14.6) and never sets it.
        targetSoc: isNumber(entry.targetSoc) ? entry.targetSoc : null,
        externalId: entry.externalId ?? null,
      }),
    );
  }

  return { ok: problems.length === 0, reservations, problems };
}

/**
 * Refuse a target SoC the engine produced.
 *
 * The check is on **provenance**, not on the number: any value is plausible, and a
 * plausible value from the wrong owner is exactly the failure §14.6 describes — "two
 * teams each reasonably assume the other owns it, or both implement it and the fleet
 * receives two different target values for the same agent".
 *
 * @param {string} source
 * @returns {{ ok: boolean, reason: string|null }}
 */
function assertNotEngineComputed(source) {
  if (source === TARGET_SOC_SOURCE.SCHEDULER || source === TARGET_SOC_SOURCE.CLASS_DEFAULT) {
    return { ok: true, reason: null };
  }
  return {
    ok: false,
    reason:
      `target SoC provenance "${String(source)}" is not one of ${Object.keys(TARGET_SOC_SOURCE).join(", ")}. ` +
      "The Charging Scheduler owns and publishes target SoC; the engine consumes it as an input constraint " +
      "and never computes or asserts one unilaterally (§14.6, §14.7)",
  };
}

/**
 * Resolve the target SoC in force for an agent.
 *
 * Two lawful outcomes and no third. The class default is a *published parameter*, so
 * using it is consuming configuration rather than computing a target — which is the
 * distinction §14.6 draws and the reason the fallback is lawful at all.
 *
 * @param {object} input
 * @param {number|null} input.publishedTargetSoc
 * @param {number|null} input.publishedAtMs
 * @param {number} input.decisionTimeMs the round's pinned time
 * @param {number} input.maxAgeSeconds `energy.target_soc_max_age`
 * @param {number|null} input.classFallback `energy.target_soc_fallback[agent_class]`
 * @returns {{ ok: boolean, targetSoc: number|null, source: string|null,
 *             degradationFlag: object|null, reason: string|null }}
 */
function resolveTargetSoc(input) {
  const source = input || {};

  const fresh =
    isNumber(source.publishedTargetSoc) &&
    isNumber(source.publishedAtMs) &&
    isNumber(source.decisionTimeMs) &&
    isNumber(source.maxAgeSeconds) &&
    // @structural milliseconds per second
    (source.decisionTimeMs - source.publishedAtMs) / 1000 <= source.maxAgeSeconds &&
    source.decisionTimeMs >= source.publishedAtMs;

  if (fresh) {
    return {
      ok: true,
      targetSoc: source.publishedTargetSoc,
      source: TARGET_SOC_SOURCE.SCHEDULER,
      degradationFlag: null,
      reason: null,
    };
  }

  if (!isNumber(source.classFallback)) {
    return {
      ok: false,
      targetSoc: null,
      source: null,
      degradationFlag: null,
      reason:
        "no published target SoC is fresh and energy.target_soc_fallback is unresolved for this agent class. " +
        "The engine does not compute a substitute (§14.6)",
    };
  }

  return {
    ok: true,
    targetSoc: source.classFallback,
    source: TARGET_SOC_SOURCE.CLASS_DEFAULT,
    // §14.6 — "records the substitution as a degradation flag on **every affected
    // decision**". Returned so the caller attaches it, rather than logged here where a
    // decision record would never see it.
    degradationFlag: Object.freeze({
      flag: "TARGET_SOC_CLASS_DEFAULT",
      section: "§14.6",
      publishedTargetSoc: isNumber(source.publishedTargetSoc) ? source.publishedTargetSoc : null,
      substituted: source.classFallback,
    }),
    reason: null,
  };
}

/**
 * Build a priced request. The Scheduler may refuse; both the request and its
 * disposition are recorded (§14.7).
 *
 * The price is in CU and is supplied by the caller, because pricing is `Φ`'s job and a
 * dependency client that computed its own price would be a second cost model.
 *
 * @param {object} input
 * @returns {{ ok: boolean, request: object|null, problems: string[] }}
 */
function buildRequest(input) {
  const source = input || {};
  const problems = [];

  if (!Object.values(REQUEST_KIND).includes(source.kind)) {
    problems.push(`request kind "${String(source.kind)}" is not one of ${Object.keys(REQUEST_KIND).join(", ")}`);
  }
  if (typeof source.requestId !== "string" || source.requestId === "") {
    problems.push("a request carries an id so its disposition can be correlated and recorded (§14.7)");
  }
  if (typeof source.agentId !== "string" || source.agentId === "") problems.push("a request names its agent");
  if (!isNumber(source.priceCu)) {
    problems.push("a request to the Scheduler is priced in CU; an unpriced request is not refusable on its merits (§14.7)");
  }
  if (source.kind === REQUEST_KIND.REVISE_TARGET_SOC && !isNumber(source.requestedTargetSoc)) {
    problems.push("a target-SoC revision states the target it requests");
  }

  if (problems.length > 0) return { ok: false, request: null, problems };

  return {
    ok: true,
    request: Object.freeze({
      requestId: source.requestId,
      kind: source.kind,
      agentId: source.agentId,
      chargerId: source.chargerId ?? null,
      requestedTargetSoc: isNumber(source.requestedTargetSoc) ? source.requestedTargetSoc : null,
      priceCu: source.priceCu,
      decisionRef: source.decisionRef ?? null,
      rationale: source.rationale ?? null,
    }),
    problems: [],
  };
}

/**
 * Pair a request with what the Scheduler did about it, for the decision record.
 *
 * An unanswered request is `UNANSWERED`, not `REFUSED`: they call for different
 * operational responses, and recording silence as a refusal would hide a broken
 * integration behind a plausible business outcome.
 *
 * @param {object} request
 * @param {object|null} response
 * @returns {object}
 */
function recordDisposition(request, response) {
  const disposition = response && Object.values(DISPOSITION).includes(response.disposition)
    ? response.disposition
    : DISPOSITION.UNANSWERED;

  return Object.freeze({
    requestId: request ? request.requestId : null,
    kind: request ? request.kind : null,
    agentId: request ? request.agentId : null,
    priceCu: request ? request.priceCu : null,
    disposition,
    grantedValue: response && response.grantedValue !== undefined ? response.grantedValue : null,
    reason: response && response.reason ? response.reason : null,
  });
}

/**
 * The engine → Scheduler demand feed (§14.7).
 *
 * > Projected energy demand implied by its current plans, so charging is planned ahead
 * > of need rather than reactively.
 *
 * Also carries realised consumption and κ drift, which "improve the Scheduler's own
 * forecasts" — the same numbers `consumption.updateKappa()` produces at settlement.
 *
 * @param {object} input
 * @returns {object}
 */
function projectedDemand(input) {
  const source = input || {};
  return Object.freeze({
    shardId: source.shardId ?? null,
    horizonEndMs: isNumber(source.horizonEndMs) ? source.horizonEndMs : null,
    agents: Object.freeze(
      (Array.isArray(source.agents) ? source.agents : []).map((agent) =>
        Object.freeze({
          agentId: agent.agentId,
          projectedEnergyWh: isNumber(agent.projectedEnergyWh) ? agent.projectedEnergyWh : null,
          projectedEndSoc: isNumber(agent.projectedEndSoc) ? agent.projectedEndSoc : null,
          projectedEndCellId: agent.projectedEndCellId ?? null,
          realisedEnergyWh: isNumber(agent.realisedEnergyWh) ? agent.realisedEnergyWh : null,
          kappa: isNumber(agent.kappa) ? agent.kappa : null,
        }),
      ),
    ),
  });
}

/**
 * The three pre-declared degradations, as an envelope a degraded-mode record can carry.
 *
 * @param {string} reason
 * @returns {object}
 */
function unavailabilityEnvelope(reason) {
  return Object.freeze({
    dependency: "CHARGING_SCHEDULER",
    reason: reason || "the Charging Scheduler is unavailable",
    // Additive-only, exactly as §7.4's Restricted Operation envelope is: every entry
    // narrows what the engine may do. None of them relaxes a constraint.
    reductions: UNAVAILABILITY_ENVELOPE,
    interruptionPermitted: false,
  });
}

module.exports = {
  TARGET_SOC_SOURCE,
  REQUEST_KIND,
  DISPOSITION,
  UNAVAILABILITY_ENVELOPE,
  consumeProjection,
  consumeReservations,
  assertNotEngineComputed,
  resolveTargetSoc,
  buildRequest,
  recordDisposition,
  projectedDemand,
  unavailabilityEnvelope,
};

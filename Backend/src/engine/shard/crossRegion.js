"use strict";

/**
 * Cross-region missions — decomposition at intake and the saga (§19.6) — **Tier 2**,
 * mechanism T2-13, kill switch `cross_region_candidacy`, degrading to **region-local
 * only**.
 *
 * > A mission whose stops span regions is decomposed at intake into per-region Legs
 * > joined at **transfer points**, and orchestrated as a saga:
 * >
 * > - Each Leg is assigned independently by its own shard, so no cross-shard distributed
 * >   transaction is ever needed in the assignment path.
 * > - The transfer point is a Stop in both Legs, with an explicit custody handoff and
 * >   evidence.
 * > - Legs are committed in order, with the downstream Leg pre-planned but not hardened
 * >   until the upstream Leg's ETA is confident enough — late binding again, for the same
 * >   reason.
 * > - Compensation is explicit per step: if the downstream Leg becomes infeasible, the
 * >   upstream Leg is redirected or held at the transfer point, with the goods in a
 * >   defined, custodied location rather than in transit to nowhere.
 * > - **The failure mode to design against is goods stranded at a transfer point.** A
 * >   transfer point MUST therefore have a defined custodian — a locker, a depot, a
 * >   staffed counter — and the saga MUST NOT release custody to an unattended location
 * >   unless that location is modelled as a custodian with its own capacity and security
 * >   properties.
 *
 * ── Why this module is Tier 2, and what that costs it ───────────────────────
 * §1.8 puts cross-region candidacy in Tier 2 and `guards/tierAssertions.js` has named
 * this exact file since Phase 0. Tier rule 2 — "No Tier 0 or Tier 1 guarantee may depend
 * on a Tier 2 mechanism" — therefore means **nothing may import this module**:
 * `intake/intake.js` is Tier 1 and must be able to run with this file deleted.
 *
 * So the direction of the dependency is inverted. This module imports intake and calls
 * it; intake knows nothing about cross-region work. A single-region submission never
 * touches this file at all, and throwing the `cross_region_candidacy` switch is a real
 * control rather than a flag on a code path that is linked in either way — which is
 * §22.5 rule 1's requirement and the reason the tier gate exists.
 *
 * `decompose()` is pure and does no I/O; `admit()` is the composition that writes. The
 * split is what lets the decomposition be model-checked and replayed without a store.
 *
 * ── Late binding is a *refusal*, not a preference ───────────────────────────
 * `mayHarden()` returns false without an ETA-confidence measurement rather than
 * defaulting to true. Hardening the downstream Leg early is exactly the commitment §19.6
 * defers: it binds an agent in the downstream region to an arrival time the upstream Leg
 * has not earned, and when the upstream Leg slips, the downstream agent has been held out
 * of its own region's rounds for nothing.
 *
 * ── No clock ────────────────────────────────────────────────────────────────
 * Every instant is supplied. A saga step is an event with a recorded time.
 */

const intake = require("../intake/intake");
const killSwitches = require("../config/killSwitches");

/** §22.5's switch for this mechanism. @structural the kill-switch name */
const KILL_SWITCH = "cross_region_candidacy";

/** §19.6's saga states. CHECK-constrained in the migration. @structural the saga vocabulary */
const SAGA_STATE = Object.freeze({
  PLANNED: "PLANNED",
  IN_PROGRESS: "IN_PROGRESS",
  COMPENSATING: "COMPENSATING",
  COMPLETED: "COMPLETED",
  COMPENSATED: "COMPENSATED",
  FAILED: "FAILED",
});

/**
 * §19.6's custodian kinds. CHECK-constrained in the migration.
 *
 * The first three are the ones the specification names outright. `MODELLED_UNATTENDED` is
 * the fourth it *conditionally* admits, and `requireCustodian()` is that condition
 * expressed as code: choosing it obliges the definition to carry a capacity and security
 * properties, so it is a modelling act rather than a way to turn the prohibition off.
 * @structural the custodian vocabulary
 */
const CUSTODIAN_TYPE = Object.freeze({
  LOCKER: "LOCKER",
  DEPOT: "DEPOT",
  STAFFED_COUNTER: "STAFFED_COUNTER",
  MODELLED_UNATTENDED: "MODELLED_UNATTENDED",
});

/**
 * §19.6's compensating actions. Two, because the section names two: "the upstream Leg is
 * redirected **or** held at the transfer point".
 * @structural the compensation vocabulary
 */
const COMPENSATION = Object.freeze({
  /** Re-route the upstream Leg to a different downstream path or destination. */
  REDIRECT_UPSTREAM: "REDIRECT_UPSTREAM",
  /** Leave the goods custodied at the transfer point until the downstream Leg is feasible. */
  HOLD_AT_TRANSFER_POINT: "HOLD_AT_TRANSFER_POINT",
});

/** The `Stop.stopType` a transfer point contributes to both Legs. @structural the stop type */
const TRANSFER_STOP_TYPE = "TRANSFER";

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Is the mechanism enabled?
 *
 * @param {object} killSwitchState the resolved switch set
 * @returns {boolean}
 */
function isEnabled(killSwitchState) {
  return killSwitches.isEnabled(killSwitchState, KILL_SWITCH);
}

/**
 * §19.6's custodian requirement, as a refusal.
 *
 * Refuses a transfer point that names no custodian at all, and refuses an unattended one
 * that has not been modelled. The migration's two CHECK constraints are the schema half
 * of the same rule; this is the half that produces a sentence naming which property is
 * missing, at the moment a saga would otherwise have been planned around it.
 *
 * @param {object} transferPoint
 * @returns {{ ok: boolean, problems: string[] }}
 */
function requireCustodian(transferPoint) {
  const point = transferPoint || {};
  const problems = [];
  const label = isNonEmptyString(point.transferPointId) ? point.transferPointId : "(unnamed)";

  if (!isNonEmptyString(point.custodianType) || !Object.values(CUSTODIAN_TYPE).includes(point.custodianType)) {
    problems.push(
      `transfer point "${label}" names custodian type "${String(point.custodianType)}", which is not one of ` +
        `${Object.values(CUSTODIAN_TYPE).join(", ")}. §19.6: "A transfer point MUST therefore have a defined ` +
        'custodian — a locker, a depot, a staffed counter".',
    );
  }
  if (!isNonEmptyString(point.custodianId)) {
    problems.push(
      `transfer point "${label}" names no custodian identity. §2.5 makes custody an accountable party, and "a ` +
        'locker" is not one — the record has to say which locker, or the handoff has no owner.',
    );
  }
  if (!Number.isFinite(point.capacity) || point.capacity <= 0) {
    problems.push(
      `transfer point "${label}" declares capacity ${String(point.capacity)}. A custodian that can hold nothing is ` +
        "a handoff that cannot happen, discovered at the kerb rather than at publish.",
    );
  }
  if (point.custodianType === CUSTODIAN_TYPE.MODELLED_UNATTENDED) {
    const modelled = point.securityProperties !== null && point.securityProperties !== undefined;
    if (!modelled) {
      problems.push(
        `transfer point "${label}" is unattended and carries no security properties. §19.6: the saga "MUST NOT ` +
          'release custody to an unattended location **unless that location is modelled as a custodian with its ' +
          'own capacity and security properties**." Without them the label is not a model, and choosing it would ' +
          "turn the prohibition off rather than satisfy it.",
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * §19.6 — decompose a mission whose stops span regions into per-region Legs joined at
 * transfer points.
 *
 * Pure. Takes the ordered stops with their regions and the available transfer points, and
 * produces the ordered Leg descriptors, the joins, and the saga's step list. Writes
 * nothing and reads no store, so the decomposition of a given mission is a function of its
 * inputs and replays identically (T6).
 *
 * ── The decomposition rule ──────────────────────────────────────────────────
 * Stops are grouped into **maximal runs of consecutive stops in one region**. Each run is
 * a Leg. Between consecutive runs a transfer point joining the two regions is required,
 * and it becomes a `TRANSFER` Stop appended to the upstream Leg and prepended to the
 * downstream one — §19.6's "a Stop in both Legs".
 *
 * A run that returns to an earlier region produces a *new* Leg rather than rejoining the
 * earlier one. Merging them would produce a Leg whose stops are not contiguous in time,
 * which §2.4 forbids outright ("a contiguous sequence of Stops executed by one agent under
 * one commitment").
 *
 * @param {object} input
 * @param {string} input.missionId
 * @param {Array<{ stopId: string, regionId: string }>} input.stops in mission order
 * @param {object[]} input.transferPoints available points, each with its two regions
 * @param {string} [input.purpose] the purpose every produced Leg carries
 * @returns {object} the decomposition, always carrying its own `ok`
 */
function decompose(input) {
  const source = input || {};
  const stops = Array.isArray(source.stops) ? source.stops : [];
  const points = Array.isArray(source.transferPoints) ? source.transferPoints : [];
  const problems = [];

  if (stops.length === 0) {
    return Object.freeze({
      ok: false,
      crossRegion: false,
      legs: [],
      joins: [],
      problems: ["a mission with no stops cannot be decomposed"],
    });
  }

  const unregioned = stops.filter((stop) => !isNonEmptyString(stop && stop.regionId));
  if (unregioned.length > 0) {
    return Object.freeze({
      ok: false,
      crossRegion: false,
      legs: [],
      joins: [],
      problems: [
        `${unregioned.length} stop(s) name no OperatingRegion, so the mission cannot be partitioned. §3.5 routes ` +
          "every Leg by its first Stop's region; a stop with none belongs to no shard.",
      ],
    });
  }

  // Maximal runs of consecutive same-region stops.
  const runs = [];
  for (const stop of stops) {
    const last = runs[runs.length - 1];
    if (last && last.regionId === stop.regionId) last.stops.push(stop);
    else runs.push({ regionId: stop.regionId, stops: [stop] });
  }

  if (runs.length === 1) {
    return Object.freeze({
      ok: true,
      crossRegion: false,
      regionId: runs[0].regionId,
      legs: [Object.freeze({ sequence: 0, regionId: runs[0].regionId, stops: runs[0].stops, transferIn: null, transferOut: null })],
      joins: [],
      problems: [],
      note:
        "the mission lies in one region; no decomposition, no saga, and no transfer point. This is also the " +
        "behaviour the `cross_region_candidacy` kill switch degrades every mission to (§22.5, T2-13).",
    });
  }

  // A transfer point joining each consecutive pair.
  const joins = [];
  for (let index = 0; index < runs.length - 1; index += 1) {
    const upstream = runs[index];
    const downstream = runs[index + 1];

    const candidates = points.filter(
      (point) =>
        point &&
        point.upstreamRegionId === upstream.regionId &&
        point.downstreamRegionId === downstream.regionId,
    );

    if (candidates.length === 0) {
      problems.push(
        `no transfer point joins region "${upstream.regionId}" to "${downstream.regionId}". §19.6 requires the two ` +
          "Legs to meet at a point with a defined custodian; without one the goods would be handed over nowhere, " +
          "which is the failure mode the section is written against.",
      );
      continue;
    }

    // Deterministic choice: the first candidate by identity. Capacity-aware or
    // cost-aware selection is a quality decision, and §19.6 states none — inventing one
    // here would put an unspecified optimisation inside a custody path.
    const chosen = [...candidates].sort((a, b) => String(a.transferPointId).localeCompare(String(b.transferPointId)))[0];

    const custodian = requireCustodian(chosen);
    if (!custodian.ok) {
      problems.push(...custodian.problems);
      continue;
    }

    joins.push(
      Object.freeze({
        afterLegSequence: index,
        transferPointId: chosen.transferPointId,
        upstreamRegionId: upstream.regionId,
        downstreamRegionId: downstream.regionId,
        custodian: Object.freeze({
          type: chosen.custodianType,
          id: chosen.custodianId,
          capacity: chosen.capacity,
          securityProperties: chosen.securityProperties ?? null,
        }),
      }),
    );
  }

  if (problems.length > 0) {
    return Object.freeze({ ok: false, crossRegion: true, legs: [], joins: [], problems });
  }

  const legs = runs.map((run, index) => {
    const transferIn = joins.find((join) => join.afterLegSequence === index - 1) || null;
    const transferOut = joins.find((join) => join.afterLegSequence === index) || null;
    return Object.freeze({
      sequence: index,
      regionId: run.regionId,
      purpose: source.purpose || "PRIMARY",
      // §19.6 — "The transfer point is a Stop in both Legs". Prepended to the downstream
      // Leg and appended to the upstream one, so the handoff appears on both sides of the
      // custody chain rather than only on the side that happens to be executing.
      stops: Object.freeze([
        ...(transferIn ? [{ stopId: `${transferIn.transferPointId}:in`, stopType: TRANSFER_STOP_TYPE, regionId: run.regionId, transferPointId: transferIn.transferPointId }] : []),
        ...run.stops,
        ...(transferOut ? [{ stopId: `${transferOut.transferPointId}:out`, stopType: TRANSFER_STOP_TYPE, regionId: run.regionId, transferPointId: transferOut.transferPointId }] : []),
      ]),
      transferIn,
      transferOut,
    });
  });

  return Object.freeze({
    ok: true,
    crossRegion: true,
    missionId: source.missionId ?? null,
    legs: Object.freeze(legs),
    joins: Object.freeze(joins),
    problems: [],
    note:
      "each Leg is assigned independently by its own shard, so no cross-shard distributed transaction is ever " +
      "needed in the assignment path (§19.6).",
  });
}

/**
 * The saga's step list, derived from a decomposition.
 *
 * Each step carries **its own compensating action, decided in advance**. §19.6 —
 * "Compensation is explicit per step" — and the reason to decide it here rather than at
 * failure time is that a compensation improvised during an incident is the improvisation
 * the whole section exists to prevent.
 *
 * The rule: a step that ends at a transfer point compensates by **holding there**, because
 * the goods are then in a defined, custodied location. A step with no downstream transfer
 * point — the last Leg — compensates by **redirecting**, because there is nowhere on its
 * own path to hold.
 *
 * @param {object} decomposition a `decompose()` result
 * @returns {object[]}
 */
function stepsFor(decomposition) {
  const source = decomposition || {};
  return (source.legs || []).map((leg) => ({
    sequence: leg.sequence,
    regionId: leg.regionId,
    transferInId: leg.transferIn ? leg.transferIn.transferPointId : null,
    transferOutId: leg.transferOut ? leg.transferOut.transferPointId : null,
    compensation: leg.transferOut ? COMPENSATION.HOLD_AT_TRANSFER_POINT : COMPENSATION.REDIRECT_UPSTREAM,
    compensationDetail: leg.transferOut
      ? `hold at ${leg.transferOut.transferPointId} under custodian ${leg.transferOut.custodian.type}:${leg.transferOut.custodian.id}`
      : "redirect: this step ends at a delivery rather than a transfer point, so there is no custodied location on its own path to hold at",
    disposition: "PENDING",
  }));
}

/**
 * §19.6's late binding: may the downstream Leg be hardened yet?
 *
 * > Legs are committed in order, with the downstream Leg pre-planned but **not hardened
 * > until the upstream Leg's ETA is confident enough** — late binding again, for the same
 * > reason.
 *
 * Returns false in the absence of a measurement rather than defaulting to true. An
 * unmeasured confidence is not a high one, and hardening on the strength of a missing
 * number would bind a downstream agent to an arrival the upstream Leg has not earned.
 *
 * @param {object} input
 * @param {number} [input.upstreamEtaConfidence] 0–1, from the upstream Leg's prediction
 * @param {number} input.threshold `crossregion.downstream_binding_eta_confidence`
 * @param {boolean} [input.upstreamSettled] true once the upstream Leg has reached the point
 * @returns {{ mayHarden: boolean, reason: string, confidence: number|null }}
 */
function mayHarden(input) {
  const source = input || {};

  // An upstream Leg that has already delivered to the transfer point needs no prediction:
  // the goods are there, custodied, and the arrival is a fact rather than an estimate.
  if (source.upstreamSettled === true) {
    return { mayHarden: true, reason: "UPSTREAM_SETTLED_AT_TRANSFER_POINT", confidence: null };
  }
  if (!Number.isFinite(source.threshold)) {
    return { mayHarden: false, reason: "NO_BINDING_THRESHOLD_CONFIGURED", confidence: null };
  }
  if (!Number.isFinite(source.upstreamEtaConfidence)) {
    return { mayHarden: false, reason: "NO_UPSTREAM_ETA_CONFIDENCE", confidence: null };
  }
  if (source.upstreamEtaConfidence < source.threshold) {
    return { mayHarden: false, reason: "UPSTREAM_ETA_NOT_CONFIDENT_ENOUGH", confidence: source.upstreamEtaConfidence };
  }
  return { mayHarden: true, reason: "UPSTREAM_ETA_CONFIDENT", confidence: source.upstreamEtaConfidence };
}

/**
 * Open the saga durably.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ sagaId, missionId, decomposition, at }`
 * @returns {Promise<object>} the saga row
 */
async function openSaga(deps, input) {
  const settings = input || {};
  const decomposition = settings.decomposition || {};

  if (decomposition.ok !== true || decomposition.crossRegion !== true) {
    throw new Error(
      "refusing to open a saga for a mission that is not a valid cross-region decomposition. A single-region " +
        "mission needs no orchestration, and an invalid decomposition would produce a saga whose steps nobody " +
        "checked the transfer points of (§19.6).",
    );
  }

  return deps.prisma.crossRegionSaga.create({
    data: {
      sagaId: String(settings.sagaId),
      missionId: String(settings.missionId),
      state: SAGA_STATE.PLANNED,
      steps: { legs: decomposition.legs, joins: decomposition.joins, steps: stepsFor(decomposition) },
      currentStepIndex: 0,
      compensation: null,
      heldAtTransferPointId: null,
      heldSince: null,
      openedAt: settings.at,
      detail: { note: decomposition.note },
    },
  });
}

/**
 * Admit a cross-region mission: decompose it, open the saga, and submit each per-region
 * Leg to intake so its own shard queues it.
 *
 * This is the composition §19.6's "decomposed at intake" names, and it lives here rather
 * than in `intake.js` for the tier reason in the module header: intake is Tier 1 and must
 * run with this file absent. The direction of the call is the whole point — this module
 * imports intake; intake does not import this module.
 *
 * With the switch thrown, or on a single-region mission, the work is submitted exactly as
 * an ordinary submission would be. That is T2-13's "degrades to: region-local only",
 * discharged rather than described.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ missionId, sagaId, stops, transferPoints, purpose, receivedAtMs,
 *                          killSwitchState, submissionTemplate, shardResolution }`
 * @returns {Promise<object>}
 */
async function admit(deps, input) {
  const settings = input || {};
  const enabled = isEnabled(settings.killSwitchState);

  const decomposition = decompose({
    missionId: settings.missionId,
    stops: settings.stops,
    transferPoints: settings.transferPoints,
    purpose: settings.purpose,
  });

  if (!decomposition.ok) {
    return Object.freeze({
      ok: false,
      crossRegion: decomposition.crossRegion,
      problems: decomposition.problems,
      saga: null,
      admissions: [],
      sentence: decomposition.problems.join("; "),
    });
  }

  if (!decomposition.crossRegion || !enabled) {
    // Region-local. One submission, through the ordinary path, with no saga.
    const first = decomposition.legs[0];
    const admission = await intake.admit(deps, {
      ...(settings.submissionTemplate || {}),
      legId: settings.legIdFor ? settings.legIdFor(first) : `${settings.missionId}:0`,
      purpose: settings.purpose || "PRIMARY",
      receivedAtMs: settings.receivedAtMs,
      shardResolution: { ...(settings.shardResolution || {}), regionId: first.regionId },
    });

    return Object.freeze({
      ok: admission.accepted === true,
      crossRegion: false,
      degradedBy: decomposition.crossRegion && !enabled ? KILL_SWITCH : null,
      problems: decomposition.crossRegion && !enabled
        ? [
            "the mission spans regions but `cross_region_candidacy` is thrown, so it was admitted as a single " +
              "region-local Leg (§22.5, T2-13). The work is not lost; the decomposition is.",
          ]
        : [],
      saga: null,
      admissions: [admission],
      sentence: admission.sentence,
    });
  }

  const saga = await openSaga(deps, {
    sagaId: settings.sagaId,
    missionId: settings.missionId,
    decomposition,
    at: new Date(settings.receivedAtMs),
  });

  const admissions = [];
  for (const leg of decomposition.legs) {
    // eslint-disable-next-line no-await-in-loop
    const admission = await intake.admit(deps, {
      ...(settings.submissionTemplate || {}),
      legId: settings.legIdFor ? settings.legIdFor(leg) : `${settings.missionId}:${leg.sequence}`,
      purpose: settings.purpose || "PRIMARY",
      receivedAtMs: settings.receivedAtMs,
      // Each Leg routes by **its own** region, which is what makes each shard's
      // assignment independent and removes the cross-shard transaction (§19.6).
      shardResolution: { ...(settings.shardResolution || {}), regionId: leg.regionId },
    });
    admissions.push(admission);
  }

  return Object.freeze({
    ok: admissions.every((admission) => admission.accepted === true),
    crossRegion: true,
    degradedBy: null,
    problems: [],
    saga,
    admissions,
    sentence:
      `mission ${settings.missionId} decomposed into ${decomposition.legs.length} per-region Leg(s) joined at ` +
      `${decomposition.joins.length} transfer point(s); each is queued to its own shard and assigned independently.`,
  });
}

/**
 * Advance the saga one step.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ sagaId, at, atTransferPointId? }`
 * @returns {Promise<object>} the updated saga
 */
async function advance(deps, input) {
  const settings = input || {};
  const saga = await deps.prisma.crossRegionSaga.findUnique({ where: { sagaId: String(settings.sagaId) } });
  if (!saga) throw new Error(`no saga "${String(settings.sagaId)}"`);

  const steps = (saga.steps && saga.steps.steps) || [];
  const next = saga.currentStepIndex + 1;
  const done = next >= steps.length;

  return deps.prisma.crossRegionSaga.update({
    where: { sagaId: saga.sagaId },
    data: {
      state: done ? SAGA_STATE.COMPLETED : SAGA_STATE.IN_PROGRESS,
      currentStepIndex: done ? saga.currentStepIndex : next,
      // Custody is at the transfer point between two Legs, and nowhere while a Leg
      // carries it. The schema's `CrossRegionSaga_hold_is_timed` CHECK keeps the two
      // columns moving together.
      heldAtTransferPointId: settings.atTransferPointId ? String(settings.atTransferPointId) : null,
      heldSince: settings.atTransferPointId ? settings.at : null,
      closedAt: done ? settings.at : null,
    },
  });
}

/**
 * Compensate the saga: the downstream Leg has become infeasible.
 *
 * > if the downstream Leg becomes infeasible, the upstream Leg is redirected or held at
 * > the transfer point, **with the goods in a defined, custodied location rather than in
 * > transit to nowhere**.
 *
 * `HOLD_AT_TRANSFER_POINT` is refused when the point does not satisfy `requireCustodian()`.
 * That is the sentence above enforced rather than restated: holding goods at a place with
 * no custodian is precisely "in transit to nowhere" with a location attached.
 *
 * @param {object} deps `{ prisma }`
 * @param {object} input `{ sagaId, at, reason, transferPoint? }`
 * @returns {Promise<object>}
 */
async function compensate(deps, input) {
  const settings = input || {};
  const saga = await deps.prisma.crossRegionSaga.findUnique({ where: { sagaId: String(settings.sagaId) } });
  if (!saga) throw new Error(`no saga "${String(settings.sagaId)}"`);

  const steps = (saga.steps && saga.steps.steps) || [];
  const step = steps[saga.currentStepIndex] || null;
  const action = step ? step.compensation : COMPENSATION.REDIRECT_UPSTREAM;

  if (action === COMPENSATION.HOLD_AT_TRANSFER_POINT) {
    const custodian = requireCustodian(settings.transferPoint);
    if (!custodian.ok) {
      throw new Error(
        `refusing to compensate by holding at a transfer point with no defined custodian: ${custodian.problems.join("; ")}. ` +
          '§19.6: the goods must end "in a defined, custodied location rather than in transit to nowhere", and a ' +
          "location with no custodian is the second of those with an address attached.",
      );
    }
  }

  const held = action === COMPENSATION.HOLD_AT_TRANSFER_POINT && settings.transferPoint;

  return deps.prisma.crossRegionSaga.update({
    where: { sagaId: saga.sagaId },
    data: {
      state: SAGA_STATE.COMPENSATING,
      // NOT NULL for a compensating saga, by CHECK. The plan was decided at decomposition
      // (`stepsFor`), so this records what was already agreed rather than what was
      // invented during the incident.
      compensation: {
        action,
        decidedAt: "DECOMPOSITION",
        appliedAt: settings.at,
        reason: settings.reason || "DOWNSTREAM_LEG_INFEASIBLE",
        stepIndex: saga.currentStepIndex,
        detail: step ? step.compensationDetail : null,
        custodian: held
          ? {
              transferPointId: settings.transferPoint.transferPointId,
              type: settings.transferPoint.custodianType,
              id: settings.transferPoint.custodianId,
            }
          : null,
      },
      heldAtTransferPointId: held ? String(settings.transferPoint.id || settings.transferPoint.transferPointId) : saga.heldAtTransferPointId,
      heldSince: held ? settings.at : saga.heldSince,
    },
  });
}

module.exports = {
  KILL_SWITCH,
  SAGA_STATE,
  CUSTODIAN_TYPE,
  COMPENSATION,
  TRANSFER_STOP_TYPE,
  isEnabled,
  requireCustodian,
  decompose,
  stepsFor,
  mayHarden,
  openSaga,
  admit,
  advance,
  compensate,
};

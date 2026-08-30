"use strict";

/**
 * §17.4's human capacity model — the thing that makes ladder rungs 7 and 8 a path rather
 * than a queue nobody sized. Mechanism T1-04, Tier 1 (§1.8), invariant I13.
 *
 * REMEDIAL PHASE T1-04, with `fairness/ladder.js` and `fairness/agentStarvation.js`.
 *
 * ── The failure this exists to prevent ──────────────────────────────────────
 * > Steps 7 and 8 route to people, and people are a finite, contended resource. Without a
 * > capacity model those steps are a guarantee only while the fleet is healthy: under any
 * > systemic failure — a routing outage, a weather regime change, a shard entering
 * > Restricted Operation — every affected Leg advances its ladder on the same clock and
 * > arrives at step 7 together. An escalation path that assumes it will be reached one Leg
 * > at a time is not a path; it is a queue nobody sized.
 *
 * The specification's own review register calls this out as omission MT-4 and marks it
 * "safety-relevant and small: modelled capacity, triage order, rate limiting, and
 * saturation as its own escalation. **Without it the ladder's guarantee fails exactly
 * under systemic failure.**" The correlation is the whole point: escalations do not
 * arrive independently, they arrive all at once, because they are all triggered by the
 * same clock reading the same outage.
 *
 * ── Four obligations, and where each one lives ──────────────────────────────
 *   1. **Capacity is modelled explicitly**, as `ops.escalation_capacity`, scoped per
 *      region, "with the current outstanding count as a first-class SLI" — `outstanding`.
 *   2. **Steps 7 and 8 are triaged, not merely queued** — `compareForTriage` / `triage`,
 *      in §17.4's stated key order.
 *   3. **A held Leg remains on the ladder** — `admit` returns `admitted: false` with a
 *      stated reason, and `LadderEscalation.admittedAt` stays null. The schema's
 *      `LadderEscalation_admitted_xor_held` CHECK is the backstop.
 *   4. **Sustained saturation is itself an escalation** — `assessSaturation`.
 *
 * ── Why outstanding is counted from intervals, not from a counter ───────────
 * A counter is a number somebody has to remember to decrement. §17.4 asks two different
 * questions of the same fact — "how many right now" (a point reading) and "how long have
 * we been over capacity" (a question about an interval) — and only one of them is
 * answerable from a counter. So `LadderEscalation` stores `admittedAt`/`resolvedAt` and
 * both readings are derived from the same rows. `escalation_saturation_time` cannot
 * disagree with `outstanding_escalations`, because there is nothing for them to disagree
 * about.
 *
 * `reconcile` is what closes a row: an escalation stops being outstanding when the Leg
 * stops waiting — it was assigned, or it reached a terminal state. That is derived from
 * the Leg rather than reported by an operator, because §17.4 defines no operator-facing
 * resolution API and inventing one would be an operations contract this module has no
 * standing to write. The consequence is stated in the closure notes: an escalation a
 * dispatcher has *seen and answered* stays outstanding until the Leg actually moves,
 * which over-counts rather than under-counts. Over-counting is the safe direction — it
 * saturates earlier, and saturation sheds load.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 * §17.4 also says escalation is **rate-limited** into the human queue. Appendix A and the
 * specification's text register no rate parameter, and this module does not invent one:
 * admission is gated on concurrent capacity alone, which is the control §17.4 does
 * parameterise. That is a genuine gap, recorded rather than papered over — and it is a
 * gap in smoothing, not in the guarantee: the property rungs 7–8 must have is that a Leg
 * is never *deemed* escalated without a human, and capacity gating delivers that on its
 * own.
 */

const custody = require("../domain/custody");
const legMachine = require("../lifecycle/legMachine");

/** @structural milliseconds per second — a unit conversion, not a threshold */
const MS_PER_SECOND = 1000;

/** Why a human rung is being held rather than escalated. Mirrors `heldReason`. */
const HELD_REASON = Object.freeze({
  /** Written when the rung is first recorded, before capacity has been consulted. */
  NOT_YET_ASSESSED: "NOT_YET_ASSESSED",
  /** Outstanding escalations are at or over `ops.escalation_capacity`. */
  CAPACITY_SATURATED: "CAPACITY_SATURATED",
  /**
   * `ops.escalation_capacity` did not resolve. It is a **required** register entry with
   * no default ("Without it the ladder's human steps are an unbounded promise"), so its
   * absence holds the Leg rather than admitting an unbounded number of escalations to a
   * dispatch function whose size nobody has stated.
   */
  CAPACITY_UNCONFIGURED: "CAPACITY_UNCONFIGURED",
  /**
   * The escalation has no region. `ops.escalation_capacity` is region-scoped, so an
   * escalation with no region cannot be counted against any capacity, and admitting it
   * would put it outside the only bound §17.4 gives it.
   */
  REGION_UNRESOLVED: "REGION_UNRESOLVED",
  /**
   * There is a free slot and this Leg is not the one §17.4 says should have it. A Leg
   * already waiting outranks it on custody, obstruction, breach proximity or queue age,
   * so that Leg was admitted instead. This is the reason that makes the difference between
   * a triaged queue and a first-come one visible in the row.
   */
  OUTRANKED: "OUTRANKED",
});

/** How an outstanding escalation stopped being outstanding. Mirrors the `outcome` CHECK. */
const RESOLUTION = Object.freeze({
  ASSIGNED: "ASSIGNED",
  TERMINAL: "TERMINAL",
  DECLINED: "DECLINED",
});

/**
 * The four positions §17.4's second triage key can take, in the order a dispatcher should
 * meet them. Ordinals, not weights: nothing multiplies them and nothing tunes them — they
 * exist so that `compareForTriage` sorts on a total order rather than on a chain of
 * booleans, and their only meaning is "before" and "after".
 * @structural §4.3's own obstruction severity ordering, as triage positions
 */
const RANK = Object.freeze({ OBSTRUCTING: 0, RESTRICTIVE: 1, CLEAR: 2, NO_STOPPING_LOCATION: 3 });

/**
 * §17.4's obstruction ordering for triage, **derived from `legMachine`** rather than
 * re-listed.
 *
 * §17.4 says "then obstruction class" without ranking the four, and §4.3 already ranks
 * them for the only purpose that matters: the state they derive and the response target
 * they carry. So the rank is read off `OBSTRUCTION_DISPOSITION` — a class that opens an
 * external escalation outranks one that does not, and among those that do not, a
 * shortened response target outranks the ordinary one. That is §4.3's own severity
 * ordering, not a second one invented here, which is what keeps this from drifting the
 * day §4.3 gains a class.
 *
 * `INDETERMINATE` therefore ranks with `BLOCKING_CRITICAL`, which is §7.3's DENY
 * semantics applied consistently: an unknown obstruction is treated as the worse case,
 * not the better one.
 *
 * @param {string|null|undefined} obstructionClass
 * @returns {number} lower sorts first — that is, gets a dispatcher's attention sooner
 */
function obstructionRank(obstructionClass) {
  if (obstructionClass === null || obstructionClass === undefined) {
    // No class has been derived. §4.3 makes the class Map-service-derived and never
    // operator-entered, so its absence means "not stranded", not "unknown severity" —
    // a queued Leg has no stopping location to classify. It sorts after every class.
    return RANK.NO_STOPPING_LOCATION;
  }
  const disposition = legMachine.OBSTRUCTION_DISPOSITION[obstructionClass];
  if (!disposition) {
    // A class §4.3 does not define. Ranked most urgent, for the same reason §7.3 denies
    // on indeterminate: an unrecognised severity is not evidence of a low one.
    return RANK.OBSTRUCTING;
  }
  if (disposition.externalEscalation === true) return RANK.OBSTRUCTING;
  return disposition.responseTargetParameter === "ops.stranded_restrictive_response_target"
    ? RANK.RESTRICTIVE
    : RANK.CLEAR;
}

/**
 * Does this Leg's custody state mean an agent may be holding goods?
 *
 * `custody.holdsGoods` throws on an unrecognised state by design. Here that throw is
 * caught and read as **held**, which is the conservative direction for a triage order:
 * §17.4 makes custody the first key precisely because goods in a machine's hold are the
 * thing an unattended escalation puts at risk, and a state nobody recognises is not a
 * reason to move a Leg down the dispatcher's list.
 *
 * @param {string|null|undefined} custodyState
 * @returns {boolean}
 */
function holdsGoods(custodyState) {
  try {
    return custody.holdsGoods(custodyState) === true;
  } catch {
    return true;
  }
}

/**
 * §17.4's triage comparator, in its stated key order:
 *
 * > Legs are ordered for human attention by custody state first (custody `HELD` always
 * > outranks custody `NONE`), then obstruction class, then SLA breach proximity, then
 * > queue age. A dispatcher facing forty escalations needs the order chosen deliberately
 * > rather than by arrival.
 *
 * Total and deterministic. The final key is the Leg id, which is not one of §17.4's four
 * — it is there so that two Legs equal on all four produce the same order on every call
 * and in every process. §9.6 requires decisions to be replayable, and an order that
 * depends on the store's row order is not.
 *
 * **`slaDeadline` now has a producer.** `task.service.superviseQueuedEntry` writes it in
 * the transaction that creates the Leg, as `storeTime + sla.assignment_deadline` — the
 * same two values the Leg's §4.5 `QUEUED` timer is armed from, so the instant this key
 * sorts on and the instant the ladder advances on are one number. The third key is
 * therefore live on the present tree.
 *
 * It remains nullable and the null handling stays, because two cases still produce one
 * honestly: a Leg admitted before that producer existed, and a deployment whose
 * `sla.assignment_deadline` does not resolve (§22.1 refuses a guessed instant). A null
 * deadline sorts after every known one: unknown proximity is not evidence of urgency, and
 * claiming otherwise would let an unpopulated column outrank a Leg whose breach is
 * measured.
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function compareForTriage(a, b) {
  const aHolds = holdsGoods(a.custodyState);
  const bHolds = holdsGoods(b.custodyState);
  if (aHolds !== bHolds) return aHolds ? -1 : 1;

  const aObstruction = obstructionRank(a.obstructionClass);
  const bObstruction = obstructionRank(b.obstructionClass);
  if (aObstruction !== bObstruction) return aObstruction - bObstruction;

  const aDeadline = a.slaDeadline instanceof Date && !Number.isNaN(a.slaDeadline.getTime())
    ? a.slaDeadline.getTime()
    : null;
  const bDeadline = b.slaDeadline instanceof Date && !Number.isNaN(b.slaDeadline.getTime())
    ? b.slaDeadline.getTime()
    : null;
  if (aDeadline !== bDeadline) {
    if (aDeadline === null) return 1;
    if (bDeadline === null) return -1;
    return aDeadline - bDeadline;
  }

  // Queue age: older first. Read from the queue row's own instant so it is the same
  // number the ladder advanced on, rather than a second measurement of the same fact.
  const aAge = Number.isFinite(a.queueAgeSeconds) ? a.queueAgeSeconds : -1;
  const bAge = Number.isFinite(b.queueAgeSeconds) ? b.queueAgeSeconds : -1;
  if (aAge !== bAge) return bAge - aAge;

  return String(a.legId ?? "").localeCompare(String(b.legId ?? ""));
}

/**
 * The order a dispatcher should work the queue in.
 *
 * @param {Array<object>} candidates
 * @returns {Array<object>} a new array; the input is not mutated
 */
function triage(candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates.slice().sort(compareForTriage);
}

/**
 * Has the region been continuously over capacity for the whole saturation window?
 *
 * > When outstanding escalations exceed capacity for `ops.escalation_saturation_period`,
 * > the shard raises a distinct high-severity alert and admission control begins
 * > declining new work of the affected classes at intake (§20.5).
 *
 * "For the period" is a statement about an interval, and it is answered by reconstructing
 * the outstanding count as a step function over the window from the escalation intervals
 * themselves. An escalation contributes to the count on `[admittedAt, resolvedAt)`, with
 * an unresolved one running to `now`.
 *
 * **Continuously**, not "on average" and not "at the end": a window that dipped below
 * capacity for one second is a window in which the operation caught up, and §17.4's
 * response — shedding customer work at intake — is too expensive to trigger on a
 * transient. So the test is whether the count was strictly over capacity at *every*
 * instant of the window, which is decided by checking each interval between consecutive
 * change points. Change points are the only instants at which the step function moves,
 * so checking them is exact rather than a sample.
 *
 * Pure: no store, no clock. The caller supplies both.
 *
 * @param {object} input
 * @param {Array<{admittedAt: Date, resolvedAt: Date|null}>} input.intervals
 * @param {number} input.capacity `ops.escalation_capacity`
 * @param {number} input.saturationPeriodSeconds `ops.escalation_saturation_period`
 * @param {Date} input.now the store clock
 * @returns {{ saturated: boolean, reason: string|null, windowStart: Date|null,
 *   minimumOutstanding: number|null, capacity: number|null }}
 */
function assessSaturation(input) {
  const source = input || {};
  const capacity = source.capacity;
  const period = source.saturationPeriodSeconds;
  const now = source.now;

  if (!Number.isFinite(capacity) || capacity < 0) {
    return { saturated: false, reason: "CAPACITY_UNCONFIGURED", windowStart: null, minimumOutstanding: null, capacity: null };
  }
  if (!Number.isFinite(period) || period <= 0) {
    return { saturated: false, reason: "SATURATION_PERIOD_UNCONFIGURED", windowStart: null, minimumOutstanding: null, capacity };
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return { saturated: false, reason: "NO_STORE_TIME", windowStart: null, minimumOutstanding: null, capacity };
  }

  const nowMs = now.getTime();
  const windowStartMs = nowMs - period * MS_PER_SECOND;
  const intervals = Array.isArray(source.intervals) ? source.intervals : [];

  // Clip every interval to the window; anything that does not overlap it cannot affect
  // whether the window was continuously saturated.
  const clipped = [];
  for (const row of intervals) {
    const from = row && row.admittedAt instanceof Date ? row.admittedAt.getTime() : NaN;
    if (!Number.isFinite(from)) continue;
    const to = row.resolvedAt instanceof Date && !Number.isNaN(row.resolvedAt.getTime())
      ? row.resolvedAt.getTime()
      : nowMs;
    if (!(to > from)) {
      // A zero-length or inverted interval. The schema's
      // `LadderEscalation_resolution_follows_admission` CHECK makes the inverted case
      // unwritable; this is the application-side half of the same refusal, and it drops
      // the row rather than letting it subtract from a count.
      continue;
    }
    const start = Math.max(from, windowStartMs);
    const end = Math.min(to, nowMs);
    if (end > start) clipped.push([start, end]);
  }

  // The change points, plus the window's own two ends. Between consecutive change points
  // the count is constant, so evaluating just after each one evaluates every distinct
  // value the step function takes.
  const points = new Set([windowStartMs, nowMs]);
  for (const [start, end] of clipped) {
    if (start > windowStartMs && start < nowMs) points.add(start);
    if (end > windowStartMs && end < nowMs) points.add(end);
  }
  const ordered = [...points].sort((left, right) => left - right);

  let minimum = Infinity;
  for (let index = 0; index < ordered.length - 1; index += 1) {
    // A point strictly inside the sub-interval, so a half-open [start, end) is counted
    // the way it is defined rather than at a boundary shared with its neighbour.
    // @structural the midpoint of two adjacent change points — a bisection, not a threshold
    const probe = (ordered[index] + ordered[index + 1]) / 2;
    let outstanding = 0;
    for (const [start, end] of clipped) {
      if (probe >= start && probe < end) outstanding += 1;
    }
    if (outstanding < minimum) minimum = outstanding;
  }
  if (!Number.isFinite(minimum)) minimum = 0;

  return {
    saturated: minimum > capacity,
    reason: minimum > capacity ? "SUSTAINED_SATURATION" : null,
    windowStart: new Date(windowStartMs),
    minimumOutstanding: minimum,
    capacity,
  };
}

/**
 * Build the capacity model the ladder consults at rungs 7 and 8.
 *
 * @param {object} deps
 * @param {string} [deps.regionId] `ops.escalation_capacity` is region-scoped
 * @param {number} [deps.capacity] `ops.escalation_capacity`
 * @param {number} [deps.saturationPeriodSeconds] `ops.escalation_saturation_period`
 * @param {(event: string, detail: object) => void} [deps.record]
 * @returns {object}
 */
function create(deps) {
  const settings = deps || {};
  const record = typeof settings.record === "function" ? settings.record : () => {};
  const regionId = typeof settings.regionId === "string" && settings.regionId !== "" ? settings.regionId : null;
  const capacityValue = Number.isFinite(settings.capacity) && settings.capacity >= 0 ? settings.capacity : null;
  const saturationPeriodSeconds =
    Number.isFinite(settings.saturationPeriodSeconds) && settings.saturationPeriodSeconds > 0
      ? settings.saturationPeriodSeconds
      : null;

  /**
   * Close every outstanding escalation in this region whose Leg has stopped waiting.
   *
   * Derived from the Leg's own state rather than reported: see the header. Bounded by the
   * number of *open* escalations in the region, which is bounded by capacity plus the
   * held backlog, so this is a small query even under saturation.
   *
   * @param {object} tx
   * @param {Date} storeTime
   * @returns {Promise<{ closed: number }>}
   */
  async function reconcile(tx, storeTime) {
    const open = await tx.ladderEscalation.findMany({
      where: { regionId, humanStep: true, admittedAt: { not: null }, resolvedAt: null },
      select: { id: true, legId: true },
    });
    if (open.length === 0) return { closed: 0 };

    const legs = await tx.leg.findMany({
      where: { id: { in: open.map((row) => row.legId) } },
      select: { id: true, state: true },
    });
    const stateById = new Map(legs.map((row) => [row.id, row.state]));

    let closed = 0;
    for (const row of open) {
      const state = stateById.get(row.legId);
      // A Leg that has vanished is not a Leg that is still waiting; the FK is
      // `ON DELETE CASCADE`, so this is only reachable inside a transaction that has not
      // yet seen the delete. Treated as terminal rather than left outstanding for ever.
      const stillWaiting = state !== undefined && [legMachine.LEG_STATE.QUEUED, legMachine.LEG_STATE.DEFERRED].includes(state);
      if (stillWaiting) continue;

      const outcome = state === undefined || legMachine.isTerminal(state) ? RESOLUTION.TERMINAL : RESOLUTION.ASSIGNED;
      await tx.ladderEscalation.update({
        where: { id: row.id },
        data: { resolvedAt: storeTime, outcome },
      });
      closed += 1;
    }

    if (closed > 0) record("ladder.escalations_resolved", { regionId, closed });
    return { closed };
  }

  /**
   * The current outstanding count — §17.4's "first-class SLI".
   *
   * @param {object} client a transaction client or the base client
   * @returns {Promise<number>}
   */
  async function outstanding(client) {
    return client.ladderEscalation.count({
      where: { regionId, humanStep: true, admittedAt: { not: null }, resolvedAt: null },
    });
  }

  /**
   * The escalation intervals the saturation window is reconstructed from.
   *
   * @param {object} client
   * @param {Date} storeTime
   * @returns {Promise<Array<object>>}
   */
  async function intervalsSince(client, storeTime) {
    if (saturationPeriodSeconds === null) return [];
    const from = new Date(storeTime.getTime() - saturationPeriodSeconds * MS_PER_SECOND);
    return client.ladderEscalation.findMany({
      where: {
        regionId,
        humanStep: true,
        admittedAt: { not: null },
        OR: [{ resolvedAt: null }, { resolvedAt: { gte: from } }],
      },
      select: { admittedAt: true, resolvedAt: true },
    });
  }

  /**
   * Assess this region against `ops.escalation_capacity` and, if it has been over for
   * the whole window, raise §17.4's distinct high-severity alert.
   *
   * @param {object} client
   * @param {Date} storeTime
   * @returns {Promise<object>}
   */
  async function saturation(client, storeTime) {
    const assessment = assessSaturation({
      intervals: await intervalsSince(client, storeTime),
      capacity: capacityValue,
      saturationPeriodSeconds,
      now: storeTime,
    });

    if (assessment.saturated) {
      record("ladder.escalation_saturation", {
        // §17.4 calls for "a distinct high-severity alert". Distinct, because the
        // operation being out of human capacity is not the same incident as any one Leg
        // being late, and an operator who is paged for the second will not act on the
        // first.
        severity: "HIGH",
        regionId,
        capacity: assessment.capacity,
        minimumOutstanding: assessment.minimumOutstanding,
        saturationPeriodSeconds,
        windowStart: assessment.windowStart,
        // §17.4's second consequence — "admission control begins declining new work of
        // the affected classes at intake (§20.5)". Emitted as a directive, not applied:
        // §20.5's controls read an `admissionInputs` object that this process's request
        // path does not currently populate for *any* control (quota, shed level and
        // queue delay are all in the same position). Wiring one control through a
        // producer that does not exist would be a seam this module manufactured for
        // itself. The gap is recorded in the T1-04 closure notes against §20.5, whose
        // producer it is.
        admissionDirective: "DECLINE_AFFECTED_CLASSES_AT_INTAKE",
      });
    }

    return assessment;
  }

  /**
   * Admit this Leg's human rung into the dispatcher queue, or hold it on the ladder.
   *
   * The order matters and is §17.4's: reconcile first (so the count is the count now,
   * not the count at the last fire), then read the count, then decide. Deciding against a
   * stale count is how a queue nobody sized gets sized wrong a second time.
   *
   * @param {object} tx the fire transaction — admission is durable and must commit with
   *   the transition it justifies (§4.1 rule 5)
   * @param {object} input
   * @param {string} input.legId
   * @param {object} input.leg
   * @param {number} input.step 7 or 8
   * @param {Date} input.storeTime
   * @param {string} [input.custodyState]
   * @returns {Promise<object>}
   */
  async function admit(tx, input) {
    const source = input || {};
    const storeTime = source.storeTime;

    // `findFirst` over the two columns of the `(legId, step)` unique index rather than
    // `findUnique` on the compound key: the same index answers it, and the row is written
    // by the ladder inside this same transaction, where a compound-key read of an
    // uncommitted row is the one shape Prisma's own client will not serve.
    const row = await tx.ladderEscalation.findFirst({ where: { legId: source.legId, step: source.step } });
    if (!row) {
      // The rung was not recorded, so there is nothing to admit. The ladder records
      // before it admits, so this is unreachable through it; a caller that reaches it
      // gets a hold rather than an admission.
      return Object.freeze({
        admitted: false,
        heldReason: HELD_REASON.NOT_YET_ASSESSED,
        outstanding: null,
        capacity: capacityValue,
        saturated: false,
      });
    }
    // Already admitted on an earlier fire. §4.5 fires at least once by design, so this is
    // the ordinary path for a Leg a dispatcher is still working, and re-admitting it
    // would move `admittedAt` forward — shortening every saturation window that row is
    // part of, which is the one direction the reading must not move by itself.
    //
    // `!= null`, not `!== null`. A row the ladder created in *this* transaction carries no
    // `admittedAt` key at all, and a strict comparison read that `undefined` as "already
    // admitted" — which returned `admitted: true` for a Leg no dispatcher had been given,
    // without ever writing the instant that says so. That is precisely the claim §17.4
    // forbids ("a Leg that reached step 7 without a human ever seeing it has not been
    // escalated"), arrived at through a nullish check rather than through a decision.
    if (row.admittedAt != null) {
      return Object.freeze({
        admitted: true,
        heldReason: null,
        alreadyAdmitted: true,
        outstanding: await outstanding(tx),
        capacity: capacityValue,
        saturated: false,
        row,
      });
    }

    if (regionId === null) {
      return Object.freeze({
        admitted: false,
        heldReason: HELD_REASON.REGION_UNRESOLVED,
        outstanding: null,
        capacity: capacityValue,
        saturated: false,
      });
    }
    if (capacityValue === null) {
      await hold(tx, row, HELD_REASON.CAPACITY_UNCONFIGURED);
      return Object.freeze({
        admitted: false,
        heldReason: HELD_REASON.CAPACITY_UNCONFIGURED,
        outstanding: null,
        capacity: null,
        saturated: false,
      });
    }

    await reconcile(tx, storeTime);
    const count = await outstanding(tx);

    if (count >= capacityValue) {
      await hold(tx, row, HELD_REASON.CAPACITY_SATURATED);
      const assessment = await saturation(tx, storeTime);
      record("ladder.escalation_held", {
        legId: source.legId,
        step: source.step,
        regionId,
        outstanding: count,
        capacity: capacityValue,
        // §17.4: a held Leg "remains on the ladder rather than being deemed to have
        // completed step 7". Said in the record too, because this line is what an
        // operator reads when they ask why a Leg is still queued past its budget.
        note: "held on the ladder; not escalated, and not recorded as escalated",
      });
      return Object.freeze({
        admitted: false,
        heldReason: HELD_REASON.CAPACITY_SATURATED,
        outstanding: count,
        capacity: capacityValue,
        saturated: assessment.saturated,
        saturation: assessment,
      });
    }

    // ── There is a slot. §17.4 decides *whose* it is, and it is not this Leg's by
    //    virtue of having fired first ────────────────────────────────────────────
    //
    // > **Steps 7 and 8 are triaged, not merely queued.** When outstanding escalations
    // > exceed capacity, Legs are ordered for human attention by custody state first
    // > (custody `HELD` always outranks custody `NONE`), then obstruction class, then SLA
    // > breach proximity, then queue age. **A dispatcher facing forty escalations needs
    // > the order chosen deliberately rather than by arrival.**
    //
    // Admitting this Leg here because its timer happened to fire is precisely arrival
    // order — and it is arrival order at the worst moment, because the Legs it would jump
    // are the ones that have already been waiting. So every unadmitted human rung in the
    // region is ranked together and the free slots go to the top of that order. A Leg
    // carrying goods, or blocking a road, is not made to wait behind one that is not.
    //
    // The other Legs' rows are updated in this transaction, which is correct rather than a
    // liberty: they are `LadderEscalation` rows only — no Leg is written, so §4.1 rule 2's
    // conditional-write discipline is not in play — and they have been waiting for exactly
    // the slot that just opened. Leaving them for their own timers would reintroduce
    // arrival order one tick later.
    const waiting = await queueOrder(tx, storeTime);
    const unadmitted = waiting.filter((entry) => entry.admitted === false);
    const slots = capacityValue - count;
    const chosen = unadmitted.slice(0, slots).map((entry) => entry.legRowId);

    // The slots are filled **first**, and only then is this Leg's own answer decided.
    //
    // The order matters, and getting it backwards is a defect that hides behind a correct
    // verdict: an implementation that returned "outranked" without admitting the Legs that
    // outrank leaves the slot empty and every one of them still waiting — the dispatcher
    // idle, the queue full, and this Leg's refusal pointing at a Leg nobody handed over.
    // Naming who should have the slot is not the same act as giving it to them.
    let admitted = null;
    for (const legRowId of chosen) {
      const target = legRowId === source.legId
        ? row
        : await tx.ladderEscalation.findFirst({
            where: { legId: legRowId, humanStep: true, admittedAt: null, resolvedAt: null },
            orderBy: { step: "desc" },
          });
      if (!target) continue;
      const updated = await tx.ladderEscalation.update({
        where: { id: target.id },
        data: { admittedAt: storeTime, heldReason: null },
      });
      if (legRowId === source.legId) admitted = updated;
    }

    if (admitted === null) {
      await hold(tx, row, HELD_REASON.OUTRANKED);
      record("ladder.escalation_held", {
        legId: source.legId,
        step: source.step,
        regionId,
        outstanding: count + chosen.length,
        capacity: capacityValue,
        note:
          "a slot was free and this Leg is not the one §17.4's triage order gives it to. It remains on the " +
          "ladder, unescalated, and the Legs that outrank it have been admitted.",
        admittedInstead: chosen,
      });
      return Object.freeze({
        admitted: false,
        heldReason: HELD_REASON.OUTRANKED,
        outstanding: count + chosen.length,
        capacity: capacityValue,
        saturated: false,
        admittedInstead: chosen,
      });
    }

    record("ladder.escalation_admitted", {
      legId: source.legId,
      step: source.step,
      regionId,
      outstanding: count + chosen.length,
      capacity: capacityValue,
      // Named so the log answers "why this one" rather than only "this one".
      triagedAheadOf: unadmitted.slice(slots).map((entry) => entry.legRowId),
    });

    return Object.freeze({
      admitted: true,
      heldReason: null,
      outstanding: count + chosen.length,
      capacity: capacityValue,
      saturated: false,
      row: admitted,
    });
  }

  /**
   * Restate why a rung is being held. Idempotent, and never clears `admittedAt`: a row
   * that has been admitted is not held, and the schema CHECK makes that unwritable.
   *
   * @param {object} tx
   * @param {object} row
   * @param {string} reason
   */
  async function hold(tx, row, reason) {
    if (row.heldReason === reason) return;
    await tx.ladderEscalation.update({ where: { id: row.id }, data: { heldReason: reason, admittedAt: null } });
  }

  /**
   * The dispatcher's working order for this region — §17.4's triage, over the rows that
   * are actually outstanding.
   *
   * Called by `admit` above, which is defined earlier in the file: both are function
   * declarations in the same closure, so the reference resolves by hoisting. It is also
   * the answer to "what should I work on next", which is what an operator surface would
   * read — but `admit` is what makes it load-bearing rather than advisory, and a triage
   * order that only an absent dashboard consumed would be an order nothing obeyed.
   *
   * @param {object} client
   * @param {Date} storeTime
   * @returns {Promise<Array<object>>}
   */
  async function queueOrder(client, storeTime) {
    const rows = await client.ladderEscalation.findMany({
      where: { regionId, humanStep: true, resolvedAt: null },
      select: { legId: true, step: true, admittedAt: true, heldReason: true, reachedAt: true, queueAgeSeconds: true },
    });
    if (rows.length === 0) return [];

    const legs = await client.leg.findMany({
      where: { id: { in: rows.map((row) => row.legId) } },
      select: { id: true, legId: true, custodyState: true, obstructionClass: true, slaDeadline: true },
    });
    const legById = new Map(legs.map((row) => [row.id, row]));

    const now = storeTime instanceof Date ? storeTime.getTime() : null;
    return triage(
      rows.map((row) => {
        const leg = legById.get(row.legId) || {};
        return {
          legId: leg.legId ?? row.legId,
          legRowId: row.legId,
          step: row.step,
          admitted: row.admittedAt !== null,
          heldReason: row.heldReason,
          custodyState: leg.custodyState,
          obstructionClass: leg.obstructionClass ?? null,
          slaDeadline: leg.slaDeadline ?? null,
          // Recomputed to now rather than reused from the row: the row's value is the age
          // at the moment the rung was reached, and a triage order taken an hour later
          // must rank on the age now.
          queueAgeSeconds:
            now !== null && row.reachedAt instanceof Date
              ? row.queueAgeSeconds + (now - row.reachedAt.getTime()) / MS_PER_SECOND
              : row.queueAgeSeconds,
        };
      }),
    );
  }

  return Object.freeze({
    regionId,
    capacity: capacityValue,
    saturationPeriodSeconds,
    admit,
    outstanding,
    reconcile,
    saturation,
    queueOrder,
  });
}

module.exports = {
  HELD_REASON,
  RESOLUTION,
  obstructionRank,
  holdsGoods,
  compareForTriage,
  triage,
  assessSaturation,
  create,
};

"use strict";

/**
 * §17.5's agent starvation — detection. Mechanism T1-04, Tier 1 (§1.8).
 *
 * REMEDIAL PHASE T1-04, with `fairness/ladder.js` and `fairness/operatorCapacity.js`.
 *
 * §17.4 is about work that no agent takes. This is its mirror: an agent that no work
 * reaches.
 *
 * > An unused agent is a wasted asset, and its idleness hides developing faults.
 *
 * > **Detection**: an agent with zero completed missions in `fairness.idle_alert_period`
 * > while nominally available raises an alert. The usual cause is an unsatisfiable
 * > constraint — an expired certification, a stale capability record, a geofence
 * > misconfiguration — and it is diagnosable directly from the rejection histogram
 * > (§7.7), which will show one predicate rejecting this agent repeatedly.
 *
 * ── Why "while nominally available" is the load-bearing clause ──────────────
 * Without it this is a report of the fleet's idle agents, which on a quiet night is the
 * whole fleet, and an alert that fires on every quiet night is an alert nobody reads. The
 * signal §17.5 wants is the *contradiction*: an agent the system believes it could use
 * and has not used. So the population is agents in `LifecycleState.ACTIVE` — F2's own
 * predicate, "Lifecycle state is active" — and nothing else. A `QUARANTINED` agent that
 * completed nothing is not starving; it is quarantined, and saying so twice would bury
 * the case that matters under the case that does not.
 *
 * ── Why "zero completed missions" is counted from commitments ───────────────
 * A completed mission is a Leg that reached a terminal state with an agent that was
 * committed to it. `Commitment` is the only row that joins the two, and `releasedAt` is
 * when that commitment ended — which is the instant the window has to be measured
 * against, because an agent that finished work yesterday and has been idle since is
 * exactly the case, and one whose commitment is still open is working right now.
 *
 * ── What this module does not do, and why ───────────────────────────────────
 * §17.5's second mechanism is **exercise missions** — "periodic self-test and short
 * reposition missions, injected as Legs with `purpose = EXERCISE`". This module
 * identifies which agents are due one (`exerciseCandidates`) and does not inject any,
 * for a reason that is structural rather than a matter of effort:
 *
 *   · A reposition mission needs a destination, and choosing one is §17.3's
 *     repositioning — `MODULE_TIERS` places `fairness/repositioning.js` at **Tier 2**.
 *     §1.8 rule 2 forbids this Tier 1 module from depending on it, and
 *     `tools/gates/checkTierDependencies.js` enforces that on every build. The module
 *     does not exist either way.
 *   · A self-test mission still needs a Mission, a Stop and an intake submission. `intake`
 *     admits a Leg it is given; nothing under `src/` creates one except
 *     `lifecycle/cancellation.js`'s recovery Leg. There is no EXERCISE producer to call.
 *
 * So the candidate list is produced and the injection is named as blocked, rather than a
 * plausible-looking Leg being manufactured against a destination nobody chose. §17.5's
 * detection half is complete and is the half that alerts.
 */

const legMachine = require("../lifecycle/legMachine");

/** @structural seconds per hour — a unit conversion, not a threshold */
const SECONDS_PER_HOUR = 3600;
/** @structural milliseconds per second — a unit conversion, not a threshold */
const MS_PER_SECOND = 1000;

/**
 * The lifecycle state §17.5's "nominally available" names. One, deliberately: F2's
 * predicate is "Lifecycle state is active", and widening it here would make this module
 * and the feasibility gate disagree about which agents the engine believes it can use.
 * @structural §17.5's "nominally available", as F2 defines it
 */
const NOMINALLY_AVAILABLE = "ACTIVE";

/** Why an agent is reported. Named so an operator's next action is in the alert. */
const FINDING = Object.freeze({
  /** Zero completed missions in the window, while nominally available. §17.5's alert. */
  IDLE_WHILE_AVAILABLE: "IDLE_WHILE_AVAILABLE",
});

/**
 * §7.7's rejection histogram is where §17.5 sends the diagnosis. It is named in every
 * finding rather than joined into one, because `RejectionAggregate` is keyed on
 * `(shard, zone, mission class, purpose, predicate, tier, bucket)` and carries **no
 * agent column** — so "one predicate rejecting *this agent* repeatedly" is not a query
 * the present schema answers. Naming the route an operator must take is honest; joining
 * on a column that does not exist would not be, and inventing a per-agent aggregate is a
 * §7.7 schema decision rather than a §17.5 one.
 * @structural the diagnostic route §17.5 names for an idle agent
 */
const DIAGNOSTIC_ROUTE = Object.freeze({
  section: "§7.7",
  instrument: "rejection histogram",
  limitation:
    "RejectionAggregate has no agent dimension, so the per-agent binding predicate §17.5 describes is not " +
    "queryable on the present schema. The histogram narrows it to a predicate and a zone; identifying the agent " +
    "within that is currently an operator step.",
});

/**
 * The window, in seconds, from `fairness.idle_alert_period` — which the register carries
 * in **hours**.
 *
 * Registered in hours (default 24, range 1–168) and used in seconds, so the conversion
 * happens once, here, rather than at three call sites that will eventually disagree.
 *
 * @param {number} hours
 * @returns {number|null} null when the parameter did not resolve
 */
function windowSecondsFrom(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return hours * SECONDS_PER_HOUR;
}

/**
 * §17.5's detection, as a pure function over the two facts it needs.
 *
 * Pure because the rule is worth testing without a store: "zero completed in the window
 * while nominally available" has four interesting cases (available and idle, available
 * and busy, unavailable and idle, unavailable and busy) and exactly one of them is an
 * alert. A rule that can only be exercised through Prisma is a rule whose boundary
 * conditions get exercised in production.
 *
 * Deterministic order: agents are returned sorted by id, so two passes over the same
 * fleet produce the same alert list in the same order (§9.6).
 *
 * @param {object} input
 * @param {Array<{id: string, agentId: string, lifecycleState: string, regionId?: string|null,
 *   agentClassId?: string|null}>} input.agents
 * @param {Map<string, number>|object} input.completionsByAgent completed missions in the
 *   window, keyed by the agent's surrogate id. A missing key is zero.
 * @param {number} input.windowSeconds
 * @param {Date} input.storeTime
 * @returns {{ ok: boolean, reason: string|null, findings: Array<object>, considered: number }}
 */
function detect(input) {
  const source = input || {};

  if (!Number.isFinite(source.windowSeconds) || source.windowSeconds <= 0) {
    // §17.5's alert is "zero completed *in fairness.idle_alert_period*". Without the
    // period there is no window, and a window of zero would report every agent in the
    // fleet as starving — a guaranteed page produced by a missing parameter rather than
    // by the fleet, which is the exact failure `checkI13` documents for its own budget.
    return {
      ok: false,
      reason:
        "fairness.idle_alert_period did not resolve, so \"zero completed missions in the period\" has no period. " +
        "Reporting every idle agent against a zero window would page on a healthy fleet.",
      findings: [],
      considered: 0,
    };
  }
  if (!(source.storeTime instanceof Date) || Number.isNaN(source.storeTime.getTime())) {
    return { ok: false, reason: "no store time was supplied (§10.6)", findings: [], considered: 0 };
  }

  const agents = Array.isArray(source.agents) ? source.agents : [];
  const completions = source.completionsByAgent instanceof Map
    ? source.completionsByAgent
    : new Map(Object.entries(source.completionsByAgent || {}));

  const findings = [];
  let considered = 0;
  const seen = new Set();

  for (const agent of agents) {
    if (!agent || typeof agent.id !== "string" || agent.id === "") continue;
    // A duplicated agent row — the same id twice in one page of results — is counted
    // once. Two findings for one agent would double the alert volume for a fleet that
    // has one problem, and the count is what an operator triages by.
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);

    if (agent.lifecycleState !== NOMINALLY_AVAILABLE) continue;
    considered += 1;

    // The raw value, then the default — in that order. `value || 0` collapses `NaN` to
    // zero because `NaN` is falsy, so a corrupt count would have been read as "completed
    // nothing" and alerted on an agent that may have been working all day. A count that is
    // absent is genuinely zero; a count that is present and unreadable is a broken pass.
    const raw = completions.get(agent.id);
    const completed = raw === undefined || raw === null ? 0 : Number(raw);
    if (!Number.isFinite(completed) || completed < 0) {
      // A count that is not a count. Reported as a finding would be an alert about the
      // wrong thing; skipped silently would hide an agent. It is neither: the pass fails
      // loudly rather than reporting a fleet it could not measure.
      return {
        ok: false,
        reason: `the completion count for agent ${agent.agentId ?? agent.id} is ${completed}, which is not a count`,
        findings: [],
        considered: 0,
      };
    }
    if (completed > 0) continue;

    findings.push(
      Object.freeze({
        finding: FINDING.IDLE_WHILE_AVAILABLE,
        agentId: agent.agentId ?? agent.id,
        agentRowId: agent.id,
        regionId: agent.regionId ?? null,
        agentClassId: agent.agentClassId ?? null,
        lifecycleState: agent.lifecycleState,
        windowSeconds: source.windowSeconds,
        windowStart: new Date(source.storeTime.getTime() - source.windowSeconds * MS_PER_SECOND),
        completedMissions: 0,
        diagnose: DIAGNOSTIC_ROUTE,
        sentence:
          `agent ${agent.agentId ?? agent.id} completed no missions in the last ` +
          `${Math.round(source.windowSeconds / SECONDS_PER_HOUR)}h while nominally available (${NOMINALLY_AVAILABLE}). ` +
          "§17.5: the usual cause is an unsatisfiable constraint — an expired certification, a stale capability " +
          "record, a geofence misconfiguration — diagnosable from §7.7's rejection histogram.",
      }),
    );
  }

  findings.sort((left, right) => String(left.agentRowId).localeCompare(String(right.agentRowId)));
  return { ok: true, reason: null, findings, considered };
}

/**
 * The agents §17.5's exercise missions would be for, in the order they are most overdue.
 *
 * Produced, not injected — see the header. The list is the input an EXERCISE producer
 * would consume the day one exists, and it is what makes the absence of that producer a
 * named gap rather than an unexamined one.
 *
 * @param {{findings: Array<object>}} detection the result of `detect`
 * @returns {Array<object>}
 */
function exerciseCandidates(detection) {
  const findings = detection && Array.isArray(detection.findings) ? detection.findings : [];
  return findings.map((finding) =>
    Object.freeze({
      agentId: finding.agentId,
      agentRowId: finding.agentRowId,
      regionId: finding.regionId,
      purpose: "EXERCISE",
      // §2.4's table: EXERCISE is a speculative purpose, "shed before any customer work
      // under load" (§20.5). Carried on the candidate so a producer cannot enqueue one
      // at a priority that competes with a customer.
      speculative: true,
      reason: finding.finding,
      blockedBy:
        "no EXERCISE Leg producer exists. A short reposition mission needs §17.3's repositioning to choose a " +
        "destination, which is Tier 2 and which §1.8 rule 2 forbids this Tier 1 mechanism from depending on; a " +
        "self-test mission still needs a Mission, a Stop and an intake submission that nothing under src/ builds.",
    }),
  );
}

/**
 * Build the detector a scheduled worker calls.
 *
 * @param {object} deps
 * @param {object} deps.prisma
 * @param {string} [deps.regionId] scope the sweep to this shard's region
 * @param {number} [deps.idleAlertPeriodHours] `fairness.idle_alert_period`, in hours
 * @param {(event: string, detail: object) => void} [deps.record]
 * @returns {{ assess: Function }}
 */
function create(deps) {
  const settings = deps || {};
  const record = typeof settings.record === "function" ? settings.record : () => {};
  const windowSeconds = windowSecondsFrom(settings.idleAlertPeriodHours);
  const regionId = typeof settings.regionId === "string" && settings.regionId !== "" ? settings.regionId : null;

  /**
   * One detection pass.
   *
   * @param {object} input
   * @param {Date} input.storeTime
   * @returns {Promise<object>}
   */
  async function assess(input) {
    const source = input || {};
    const storeTime = source.storeTime;
    const prisma = settings.prisma;

    if (!prisma || !prisma.agent || !prisma.commitment) {
      return { ok: false, reason: "no store client was supplied", findings: [], considered: 0 };
    }
    if (windowSeconds === null) {
      return detect({ agents: [], completionsByAgent: new Map(), windowSeconds: null, storeTime });
    }
    if (!(storeTime instanceof Date) || Number.isNaN(storeTime.getTime())) {
      return detect({ agents: [], completionsByAgent: new Map(), windowSeconds, storeTime });
    }

    const agents = await prisma.agent.findMany({
      where: { lifecycleState: NOMINALLY_AVAILABLE, ...(regionId ? { regionId } : {}) },
      select: { id: true, agentId: true, lifecycleState: true, regionId: true, agentClassId: true },
      orderBy: { id: "asc" },
    });
    if (agents.length === 0) {
      return { ok: true, reason: null, findings: [], considered: 0, exercise: [] };
    }

    const from = new Date(storeTime.getTime() - windowSeconds * MS_PER_SECOND);

    // A completed mission, joined the only way the schema joins an agent to a finished
    // Leg. `releasedAt` bounds the window; the Leg's terminal state is what makes it a
    // *completed* mission rather than a withdrawn or failed one.
    const completions = await prisma.commitment.findMany({
      where: {
        agentId: { in: agents.map((agent) => agent.id) },
        releasedAt: { gte: from, lte: storeTime },
        leg: { state: { in: [legMachine.LEG_STATE.SETTLED, legMachine.LEG_STATE.RELEASED] } },
      },
      select: { agentId: true },
    });

    const completionsByAgent = new Map();
    for (const row of completions) {
      completionsByAgent.set(row.agentId, (completionsByAgent.get(row.agentId) || 0) + 1);
    }

    const detection = detect({ agents, completionsByAgent, windowSeconds, storeTime });
    const exercise = detection.ok ? exerciseCandidates(detection) : [];

    if (!detection.ok) {
      record("fairness.agent_starvation_undetermined", { regionId, reason: detection.reason });
    } else if (detection.findings.length > 0) {
      record("fairness.agent_starvation", {
        regionId,
        idle: detection.findings.length,
        considered: detection.considered,
        windowSeconds,
        agents: detection.findings.map((finding) => finding.agentId),
        diagnose: DIAGNOSTIC_ROUTE,
        // Named on every alert so the gap travels with the finding rather than living
        // only in a closure document nobody reads at 3 a.m.
        exerciseMissionsBlockedBy: exercise.length > 0 ? exercise[0].blockedBy : null,
      });
    }

    return { ...detection, exercise };
  }

  return Object.freeze({ assess, windowSeconds, regionId });
}

module.exports = {
  NOMINALLY_AVAILABLE,
  FINDING,
  DIAGNOSTIC_ROUTE,
  windowSecondsFrom,
  detect,
  exerciseCandidates,
  create,
};

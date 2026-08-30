"use strict";

/**
 * The engine's background workers, and which of them this process schedules — **Tier 1**.
 *
 * > **Background workers** — All engine workers move from **shadow to production
 * > scheduling**. (execution plan, Phase 15)
 *
 * Every worker under `src/workers/` shipped with the same disposition from Phase 4
 * onward: complete, tested through its own `runOnce`/`drainOnce`, and started by nothing.
 * Phase 15 is where they are scheduled. This module is the list, so that "which workers
 * run in production" is one table that a test asserts and a health endpoint returns,
 * rather than a shape you infer by reading `server.js` top to bottom.
 *
 * ── Three readiness states, and why the third one is written down ──────────
 *   - `SCHEDULED` — this process starts it. Its dependency contract is satisfiable from
 *     the process context (`prisma`, `kv`, `io`, the published config snapshot).
 *   - `LEADER_ONLY` — scheduled, but only while this process holds the shard's leadership
 *     lease (§19.3's single writer). Started and stopped by the shard supervisor rather
 *     than at boot, because a standby that drained an outbox would be a second writer.
 *   - `DEFERRED` — **not** started, with the reason named and the phase that owns it.
 *
 * The third state is the honest one and it is why this file exists. Two kinds of worker
 * are deferred, and conflating them would hide the difference:
 *
 *   1. **Tier 2 workers**, whose mechanism is behind a §22.5 kill switch that §1.8 rule 3
 *      requires to be thrown at launch. Starting the Capacity Pricing Service at cutover
 *      would populate `λ_zone` from live duals for a term that is configured to read
 *      static priors — work whose output nothing consumes, and which Phase 16a exists to
 *      enable under its own gate.
 *   2. **Workers whose collaborators this process does not construct.** The shadow
 *      runner needs a full solve path (`round`, `expandCandidates`, `pricedCandidateFor`,
 *      `budgetsFor`, `deferPriceFor`); the index maintainer needs the capability and
 *      charging classifiers. Those are composition-root work, and a stub passed in their
 *      place would produce a worker that runs, reports success, and computes nothing —
 *      the worst of the three possible states. Each is recorded with the collaborator it
 *      is missing, so the gap is a line in a table rather than an absence.
 *
 * `blockedBy` is mandatory on a `DEFERRED` row and `assertRegistry()` refuses a row
 * without it, for the same reason `@structural` demands a reason: an unexplained
 * exemption is how a register rots.
 */

/** @structural the three dispositions a worker can have in this process */
const READINESS = Object.freeze({
  SCHEDULED: "SCHEDULED",
  LEADER_ONLY: "LEADER_ONLY",
  DEFERRED: "DEFERRED",
});

/**
 * Every worker under `src/workers/`, in the order a reader should meet them: the ones
 * that keep commitments correct first, then observability, then the deferred.
 */
const WORKERS = Object.freeze([
  {
    id: "shard_supervisor",
    module: "workers/shardSupervisor.worker",
    section: "§19.2, §19.3, §19.5",
    tier: 1,
    readiness: READINESS.SCHEDULED,
    cadenceParameter: "shard.renewal_interval",
    purpose: "Lease renewal, failover reconciliation, sizing, and one membership migration per tick.",
    blockedBy: null,
  },
  {
    id: "coordinator",
    module: "workers/coordinator.worker",
    section: "§9.2, §19.3",
    tier: 0,
    readiness: READINESS.LEADER_ONLY,
    cadenceParameter: "solve.window_min",
    purpose: "The round loop: drain the queue, generate, gate, price, solve, commit.",
    blockedBy: null,
  },
  {
    id: "outbox",
    module: "workers/outbox.worker",
    section: "§11.1, §11.3, §11.4",
    tier: 0,
    readiness: READINESS.LEADER_ONLY,
    cadenceParameter: "dispatch.max_delivery_delay",
    purpose: "Claim outbox rows, deliver, record, escalate, expire.",
    blockedBy: null,
  },
  {
    id: "reconciler",
    module: "workers/reconciler.worker",
    section: "§12.4",
    tier: 0,
    readiness: READINESS.LEADER_ONLY,
    cadenceParameter: "reconciler.sweep_interval",
    purpose: "The full sweep: every divergence category, repaired by conditional write and rate-counted.",
    blockedBy: null,
  },
  {
    id: "timer",
    module: "workers/timer.worker",
    section: "§4.5, §12.2",
    tier: 0,
    readiness: READINESS.LEADER_ONLY,
    cadenceParameter: "supervision.timer_tick",
    purpose: "Fire durable timers: lease expiry, progress deadlines, offer TTLs.",
    blockedBy: null,
  },
  {
    id: "invariant",
    module: "workers/invariant.worker",
    section: "§26, §18.5, §18.6",
    tier: 1,
    readiness: READINESS.SCHEDULED,
    cadenceParameter: "invariant.check_interval",
    purpose: "Run every §26.1 check independently of the code paths that maintain them; sweep mode time boxes and open escalations.",
    blockedBy: null,
  },
  {
    id: "cutover",
    module: "workers/cutover.worker",
    section: "§22.4 item 4",
    tier: 1,
    readiness: READINESS.SCHEDULED,
    cadenceParameter: "cutover.guardrail_check_interval",
    purpose: "Assess each live shard against its pre-declared SLI guardrails and roll it back on regression.",
    blockedBy: null,
  },
  {
    id: "tier_b",
    module: "workers/tierB.worker",
    section: "§21.2",
    tier: 1,
    readiness: READINESS.SCHEDULED,
    cadenceParameter: "observability.tier_b_write_budget",
    purpose: "Drain the Tier B reservoir within its per-shard write budget.",
    blockedBy: null,
  },
  {
    // REMEDIAL PHASE T1-04. §17.4's ladder and its capacity model are driven by a
    // deadline — `ESCALATION_LADDER` is §4.3's expiry action for `QUEUED` — so the timer
    // worker is their runtime caller and they need no row here. §17.5's detector is the
    // exception: "zero completed missions in `fairness.idle_alert_period` while nominally
    // available" is a statement about an *absence* over a window, which no event announces
    // and no deadline expires on. A detector of "nothing happened" that only runs when
    // something happens detects nothing, so it gets a tick of its own.
    //
    // The cadence is the alert period itself. No second parameter was registered for the
    // interval: an alert whose window is a day is not improved by being recomputed every
    // minute, and §22.1 admits no behavioural constant outside the register — so the
    // alternative to reusing this one is inventing a cadence the specification never names.
    id: "fairness",
    module: "workers/fairness.worker",
    section: "§17.5",
    tier: 1,
    readiness: READINESS.SCHEDULED,
    cadenceParameter: "fairness.idle_alert_period",
    purpose: "Detect agents that completed no mission in the idle-alert period while nominally available (§17.5).",
    blockedBy: null,
  },
  {
    id: "rejection_aggregation",
    module: "workers/rejectionAggregation.worker",
    section: "§7.7",
    tier: 1,
    readiness: READINESS.SCHEDULED,
    cadenceParameter: "feasibility.rejection_flush_interval",
    purpose: "Flush the exact, unsampled binding-constraint distribution into RejectionAggregate.",
    blockedBy: null,
  },
  {
    id: "certificate_rotation",
    module: "workers/certificateRotation.worker",
    section: "§23.2, §23.7",
    tier: 1,
    readiness: READINESS.SCHEDULED,
    cadenceParameter: "security.certificate_revocation_recheck_interval",
    purpose: "Periodic revocation recheck on long sessions, rotation lead time, and the identity retention sweep.",
    blockedBy: null,
  },
  {
    id: "calibration",
    module: "workers/calibration.worker",
    section: "§21.5",
    tier: 1,
    readiness: READINESS.SCHEDULED,
    cadenceParameter: "observability.calibration_score_interval",
    purpose: "Score predictions against realised outcomes and publish the calibration SLIs.",
    blockedBy: null,
  },
  {
    id: "counterfactual",
    module: "workers/counterfactual.worker",
    section: "§21.6",
    tier: 1,
    readiness: READINESS.SCHEDULED,
    cadenceParameter: "observability.counterfactual_interval",
    purpose: "Re-solve recent rounds with relaxed bounds and report the realised gap.",
    blockedBy: null,
  },
  {
    id: "shadow",
    module: "workers/shadow.worker",
    section: "§21.6",
    tier: 1,
    readiness: READINESS.DEFERRED,
    cadenceParameter: "observability.shadow_interval",
    purpose: "Run a candidate configuration on live inputs, record the decisions, execute none of them.",
    blockedBy:
      "needs a constructed solve path (round, expandCandidates, pricedCandidateFor, budgetsFor, deferPriceFor). " +
      "The runner and its comparison are complete and tested through runOnce; what is missing is the composition " +
      "root that builds those five collaborators outside a test fixture. A stub would produce a worker that runs, " +
      "reports success, and compares nothing. " +
      // PHASE 15 remediation (D-4) — the blocker restated, because the sentence above was
      // accurate and incomplete, and the difference decides who can clear it. "What is
      // missing is the composition root" reads as work this repository can do. It is not:
      // the shadow worker runs the *same* solve path the coordinator does, and that path
      // bottoms out — through plan/insertion.js → planBuilder.hopsForSequence →
      // routing/cellPairCache.hopsFor — in an injected `route` function. **No routing engine
      // is selected.** That is execution-plan item B1, whose Step 5 is blocked on D1 (no
      // authoritative operating region), D3 (no fleet speed model) and D8 (no extract
      // vintage). `workers/leaderWorkers.js` records the identical blocker against the
      // coordinator, and it is the same blocker rather than a similar one.
      "The blocker is the SAME as the coordinator's and is EXTERNAL: those five collaborators bottom out in an " +
      "injected `route` function, and B1 has selected no routing engine (blocked on D1/D3/D8 — Operations, " +
      "Product and Commercial decisions). `npm run routing:readiness` reports BLOCKED and refuses to fabricate " +
      "one. Consequence: the `shadow_agreement` release gate cannot begin accumulating evidence at all — the " +
      "system is not merely short of the fourteen-day window, it cannot start the clock.",
  },
  {
    id: "index_maintainer",
    module: "workers/indexMaintainer.worker",
    section: "§6.2",
    tier: 1,
    readiness: READINESS.DEFERRED,
    cadenceParameter: "index.sweep_interval",
    purpose: "Keep the cell-partitioned availability index consistent with agent state.",
    blockedBy:
      "needs the capability/container and charging classifiers (capabilityAndContainerClassesFor, " +
      "chargingStatusFor). The index is otherwise maintained on the telemetry path; the sweep is the " +
      "self-healing pass, and running it with a classifier that answers 'unknown' would evict live agents.",
  },
  {
    id: "capacity_pricing",
    module: "workers/capacityPricing.worker",
    section: "§8.3, §5.2",
    tier: 2,
    readiness: READINESS.DEFERRED,
    cadenceParameter: "pricing.refresh_interval",
    purpose: "Publish live λ_zone from the solve's duals.",
    blockedBy:
      "Tier 2. killswitch.opportunity_cost_term is thrown at launch (§1.8 rule 3), so C_opportunity reads static " +
      "priors and nothing consumes a live λ_zone. Phase 16a enables it under its own gate.",
  },
  {
    id: "charger_reachability",
    module: "workers/chargerReachability.worker",
    section: "§14.5, §20.3",
    tier: 1,
    readiness: READINESS.DEFERRED,
    cadenceParameter: "route.charger_cache_refresh",
    purpose: "Warm the charger-reachability cache E_return reads per candidate.",
    blockedBy:
      "exposes a pass function rather than a scheduler; it is driven by the routing layer's cache miss path today. " +
      "Scheduling it needs a routing client this process does not construct.",
  },
  {
    id: "energy_calibration",
    module: "workers/energyCalibration.worker",
    section: "§14.2, §21.5",
    tier: 1,
    readiness: READINESS.DEFERRED,
    cadenceParameter: "energy.calibration_interval",
    purpose: "Re-fit per-class consumption coefficients against realised energy.",
    blockedBy:
      "exposes a pass function rather than a scheduler, and its inputs are the realised-outcome rows the fleet " +
      "has not yet produced. It is one of the loops execution-plan item B8 (the calibration owner) governs.",
  },
  {
    id: "service_time_model",
    module: "workers/serviceTimeModel.worker",
    section: "§13.2",
    tier: 1,
    readiness: READINESS.DEFERRED,
    cadenceParameter: "plan.service_time_refit_interval",
    purpose: "Re-fit per-site, per-stop-type service-time models.",
    blockedBy:
      "exposes a pass function rather than a scheduler, and §22.4 names per-site service-time models among the " +
      "values that 'require data the fleet does not yet produce'.",
  },
]);

const WORKER_BY_ID = Object.freeze(
  WORKERS.reduce((index, worker) => {
    index[worker.id] = worker;
    return index;
  }, Object.create(null)),
);

/**
 * Refuse a malformed registry at load.
 *
 * @returns {true}
 */
function assertRegistry() {
  const seen = new Set();
  for (const worker of WORKERS) {
    if (seen.has(worker.id)) throw new Error(`worker declared twice in the registry: ${worker.id}`);
    seen.add(worker.id);
    if (!Object.values(READINESS).includes(worker.readiness)) {
      throw new Error(`worker ${worker.id} declares an unknown readiness: ${worker.readiness}`);
    }
    if (worker.readiness === READINESS.DEFERRED && !worker.blockedBy) {
      throw new Error(
        `worker ${worker.id} is DEFERRED but names no blocker. An unexplained deferral is indistinguishable ` +
          "from an oversight, which is exactly what this registry exists to prevent.",
      );
    }
    if (worker.readiness !== READINESS.DEFERRED && worker.blockedBy) {
      throw new Error(`worker ${worker.id} is ${worker.readiness} but names a blocker`);
    }
    if (!worker.cadenceParameter || !worker.section || !worker.purpose) {
      throw new Error(`worker ${worker.id} is missing its cadence parameter, section or purpose`);
    }
  }
  return true;
}

assertRegistry();

/** Worker ids this process starts at boot. */
function scheduledAtBoot() {
  return WORKERS.filter((worker) => worker.readiness === READINESS.SCHEDULED).map((worker) => worker.id);
}

/** Worker ids the shard supervisor starts on leadership acquisition. */
function scheduledOnLeadership() {
  return WORKERS.filter((worker) => worker.readiness === READINESS.LEADER_ONLY).map((worker) => worker.id);
}

/**
 * The registry as a health-endpoint payload: what runs, what does not, and why not.
 *
 * @param {{ running?: string[] }} [context]
 * @returns {object}
 */
function report(context) {
  const running = new Set((context && context.running) || []);
  return {
    total: WORKERS.length,
    scheduled: scheduledAtBoot().length,
    leaderOnly: scheduledOnLeadership().length,
    deferred: WORKERS.filter((worker) => worker.readiness === READINESS.DEFERRED).length,
    workers: WORKERS.map((worker) => ({
      id: worker.id,
      section: worker.section,
      tier: worker.tier,
      readiness: worker.readiness,
      running: running.has(worker.id),
      blockedBy: worker.blockedBy,
    })),
  };
}

module.exports = { READINESS, WORKERS, WORKER_BY_ID, assertRegistry, scheduledAtBoot, scheduledOnLeadership, report };

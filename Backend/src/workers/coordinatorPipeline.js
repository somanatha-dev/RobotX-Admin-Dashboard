"use strict";

/**
 * What the Assignment Coordinator's solve path needs, and which of it this deployment has
 * — **the requirements probe**. Composition-root code, beside `leaderWorkers.js`.
 *
 * ── The finding this module exists to close ────────────────────────────────
 * `workers/coordinator.worker.js` is complete. `solve/round.js` is complete. So are
 * `candidates/expansion.js`, `feasibility/evaluate.js`, `plan/planBuilder.js`, `cost/phi.js`
 * and `commitment/commit.js`. What has never existed is the code that **assembles** them:
 * `expandCandidates`, `pricedCandidateFor`, `expansionInputFor` and the `evaluateExact` they
 * bottom out in are constructed **only in tests**. `tools/verify/phase9ProductionPath.js`
 * says so in its own header — *"nothing in this process constructs its solve path"*.
 *
 * Until now `leaderWorkers.COMPOSERS.coordinator()` reported that as a single fixed
 * paragraph: *"no routing engine is selected"*. That is **true and incomplete**, and the
 * incompleteness was doing real damage — two successive hand-audits of "what does V1 need"
 * each stopped at a different seam and each produced a different, confidently-stated answer.
 * The first said four values. The second found three more `UNCALIBRATED` register entries
 * and three input families with no producer at all. Neither was measured; both were read.
 *
 * **So this module measures it.** `requirements(context)` attempts to resolve every input
 * the coordinator's solve path needs and returns, by name, owner and class, the ones it
 * cannot. The composer reports that list instead of a paragraph. The answer to *"what
 * exactly is missing"* becomes something the code computes rather than something a reader
 * infers — which is the same move `registry.js` made for `blockedBy` and
 * `leaderWorkers.js` made for `UNCOMPOSABLE`.
 *
 * ── What this module deliberately does NOT do ──────────────────────────────
 * **It does not assemble anything.** There is no `expandCandidates` body here, no
 * `evaluateExact`, no `pricedCandidateFor`. Writing those now would produce several hundred
 * lines exercised only by an injected complete context, because the real inputs do not
 * exist — *written, tested, and never called*, which is the failure this programme has hit
 * at least four times and which `registry.js`'s own header names.
 *
 * **It fabricates nothing.** No default is invented for an unresolved register entry, no
 * router is stubbed, no terrain or ambient temperature is guessed. Every probe answers
 * *"is this present"* and never *"here is a plausible value"*.
 *
 * **It does not make `gate:composition` pass.** The gate reads `leaderWorkers.UNCOMPOSABLE`
 * declaratively, that row is unchanged, and it is removed — per the rule that table sets
 * for itself — only when the coordinator actually starts.
 *
 * ── Why the classes matter more than the count ─────────────────────────────
 * "Eight things are missing" is not actionable. **Who can supply each, and whether it is a
 * decision or an absence, is.** A `REGISTER_UNRESOLVED` entry is `null` *by declaration* —
 * §22.4's calibration owner's to derive, and §22.3 forbids any automated process from
 * choosing it. A `NO_PRODUCER` family is not waiting on anybody's decision: it is code
 * nobody has written plus a data source nobody has named. Reporting both as "missing" is
 * what let one be mistaken for the other.
 *
 * Tier 1 by path (`src/workers/`). No clock, no randomness, no I/O: every probe is a pure
 * function of the supplied context and the supplied snapshot.
 */

const omega = require("../engine/candidates/omega");

/**
 * Why an input is absent — and therefore who, if anyone, can supply it.
 *
 * @structural the requirement taxonomy; each class has a different owner and a different
 *   closure act
 */
const REQUIREMENT_CLASS = Object.freeze({
  /**
   * An external decision about the traversal source. Not derivable here, and explicitly
   * forbidden to fabricate: *"starting the coordinator against an invented router assigns
   * real work on invented travel times"*.
   */
  EXTERNAL_ROUTING: "EXTERNAL_ROUTING",
  /**
   * A register entry that exists but resolves to nothing. **`null` by declaration, not by
   * omission** — the register carries the entry precisely so that its absence is visible,
   * and §22.3 forbids an automated process from choosing the value.
   */
  REGISTER_UNRESOLVED: "REGISTER_UNRESOLVED",
  /**
   * An input family with **no schema column and no producer anywhere in `src/`**. Nobody is
   * deciding this and no calibration closes it: it is missing code plus a missing data
   * source, and it is the class both prior hand-audits missed entirely.
   */
  NO_PRODUCER: "NO_PRODUCER",
  /** A collaborator the composition root builds, but did not supply to this call. */
  PROCESS_DEPENDENCY: "PROCESS_DEPENDENCY",
  /**
   * A §6.4 admissibility precondition that resolves or does not. An `LB` missing its
   * negative-term correction **is not a lower bound**, so this is checked rather than
   * assumed — `tools/verify/phase9ProductionPath.js` exists because it once silently was
   * not.
   */
  ADMISSIBILITY: "ADMISSIBILITY",
});

/** Read a value from the round's configuration snapshot without throwing. */
function resolved(snapshot, name, context) {
  if (!snapshot || typeof snapshot.resolve !== "function") return undefined;
  try {
    return snapshot.resolve(name, context || {});
  } catch {
    return undefined;
  }
}

const isFunction = (value) => typeof value === "function";
const isPositive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const present = (value) => value !== null && value !== undefined;

/**
 * A register entry that must resolve to something before the solve path can run.
 *
 * @param {string} name
 * @param {string} why what breaks without it, named at the function that breaks
 * @param {string} owner
 * @returns {object}
 */
function registerRequirement(name, why, owner) {
  return {
    id: name,
    class: REQUIREMENT_CLASS.REGISTER_UNRESOLVED,
    owner,
    why,
    probe: (context) => present(resolved(context.snapshot, name, { sla_class: context.slaClass ?? null })),
  };
}

/**
 * Every input the coordinator's solve path needs that this repository cannot supply on its
 * own, in the order a reader should meet them: routing first, then the register, then the
 * families with no producer, then the process context, then admissibility.
 *
 * **This list is the contract.** `leaderWorkers.UNCOMPOSABLE.coordinator.requires` is
 * derived from it rather than restated, so the declarative table a build gate reads and the
 * probe a promotion runs cannot disagree about what the coordinator needs.
 */
const REQUIREMENTS = Object.freeze([
  /* ── Routing: the injected `route` seam and the two values it cannot supply ── */
  {
    id: "route",
    class: REQUIREMENT_CLASS.EXTERNAL_ROUTING,
    owner: "B1 — the project owner, on D1/D3/D8",
    why:
      "`routing/cellPairCache.read` falls through to `deps.route(parts)` on a cache miss and returns " +
      "`no router is available and the entry is not cached` without it. Contract: " +
      "`async ({originCell, destCell, profileKey, timeBucket}) => {distanceM, travelSeconds, travelSdSeconds}`, " +
      "all three finite and non-negative or `buildEntry` refuses the result and nothing is cached.",
    probe: (context) => isFunction(context.route),
  },
  {
    id: "travelSdSeconds source (N29)",
    class: REQUIREMENT_CLASS.EXTERNAL_ROUTING,
    owner: "the project owner",
    why:
      "`cellPairCache.buildEntry` requires a finite non-negative `travelSdSeconds`, and §8.4 prices `p_late` " +
      "\"from the ETA predictive distribution, not the point estimate\". **No shortlisted engine returns a " +
      "spread** — OSRM's `table`, Valhalla's `sources_to_targets` and GraphHopper's `route` are all point " +
      "estimates — so turning that silence into `0` asserts \"this ETA is certain\", in the optimistic " +
      "direction. The spread needs a declared source, and selecting an engine does not close it.",
    probe: (context) => present(context.travelTimeSpread),
  },
  {
    id: "speedMetresPerSecond (per routing profile)",
    class: REQUIREMENT_CLASS.EXTERNAL_ROUTING,
    owner: "D3 — Product + Fleet Engineering",
    why:
      "`cellPairCache.applyIntraCellOffset` inflates a cached pair by §20.3's intra-cell quantisation at the " +
      "profile's own speed, and refuses without it. It is a real fleet measurement, not a plausible number: " +
      "the only `MobilityModel` in this repository is a seed whose `speedModel` is a note deferring to D3.",
    probe: (context) => isFunction(context.speedMetresPerSecondFor) || isPositive(context.speedMetresPerSecond),
  },

  /* ── Register entries that exist and resolve to nothing ────────────────────── */
  registerRequirement(
    "candidate.max_radius_by_sla_class",
    "§6.3 requires the k-ring expansion to be bounded by a radius or a wall-clock budget; `expandCandidates` " +
      "**refuses outright** with `unbounded_search_refused` when it has neither, because a Leg with no feasible " +
      "agent would otherwise expand without limit (§6.1's bounded-work property, T9). `required: true` with no " +
      "default, on purpose: the containment limit is Operations' to set.",
    "§22.4's calibration owner / Operations",
  ),
  registerRequirement(
    "plan.service_time_prior",
    "`plan/planBuilder.resolveServiceTimes` fails closed without it, and `buildVariant` returns before " +
      "projecting a timeline. §22.4 names per-site service-time models among the values that \"require data the " +
      "fleet does not yet produce\" — which is also why `service_time_model` is a DEFERRED worker.",
    "§22.4's calibration owner",
  ),
  registerRequirement(
    "energy.model_residual_cv",
    "`energy/consumption.predictiveDistribution` needs it to turn a mean consumption into the distribution " +
      "§14's reserves are held against; without it `buildVariant` returns `MISSING_ENERGY_INPUT`.",
    "§22.4's calibration owner",
  ),

  /* ── Input families with no schema column and no producer ─────────────────── */
  {
    id: "terrainByStop",
    class: REQUIREMENT_CLASS.NO_PRODUCER,
    owner: "Engineering + a terrain data source",
    why:
      "`plan/planBuilder.legProfiles` requires `{climbM, descentM, stopStartCycles}` per stop and fails closed " +
      "without it. **No Prisma column and no producer anywhere in `src/` supplies it.** This is not a decision " +
      "anyone is withholding — it is code nobody has written against a data source nobody has named.",
    probe: (context) => isFunction(context.terrainForStops),
  },
  {
    id: "environment.ambientC / packC",
    class: REQUIREMENT_CLASS.NO_PRODUCER,
    owner: "Engineering + a telemetry or forecast source",
    why:
      "`energy/consumption.betaThermal` evaluates the model's ambient and pack curves at these two " +
      "temperatures, and `legProfiles` fails closed without them. **No Prisma column and no producer anywhere " +
      "in `src/`.** The thermal coefficient is a real term in §14.2's consumption model, so omitting it is not " +
      "a degradation this path is permitted to take silently.",
    probe: (context) => isFunction(context.environmentFor),
  },
  {
    id: "masses.vehicleMassKg",
    class: REQUIREMENT_CLASS.NO_PRODUCER,
    owner: "Engineering + the fleet's own specifications",
    why:
      "`legProfiles` needs the vehicle's own mass to project consumption. `AgentClass.totalMassLimitKg` is a " +
      "**limit**, not a mass, and reading a limit as a mass would overstate consumption on every candidate " +
      "equally — which is the kind of error that looks conservative and is simply wrong. No mass column exists.",
    probe: (context) => isFunction(context.vehicleMassKgFor) || isPositive(context.vehicleMassKg),
  },

  /* ── Process context the composition root supplies ─────────────────────────── */
  {
    id: "prisma",
    class: REQUIREMENT_CLASS.PROCESS_DEPENDENCY,
    owner: "the composition root",
    why: "agent snapshots, the claimed batch and the durable write all read through it",
    probe: (context) => present(context.prisma),
  },
  {
    id: "kv",
    class: REQUIREMENT_CLASS.PROCESS_DEPENDENCY,
    owner: "the composition root",
    why:
      "`candidates/availabilityIndex` reads the cell-partitioned index through it, and " +
      "`routing/cellPairCache` caches through it. Advisory for correctness (§3.3), required to expand at all",
    probe: (context) => present(context.kv),
  },
  {
    id: "commit",
    class: REQUIREMENT_CLASS.PROCESS_DEPENDENCY,
    owner: "the composition root",
    why:
      "§10.3.2's serialised conditional write, already bound to its own dependencies. `solve/round.execute` " +
      "takes it injected rather than imported, because a Tier 1 decision module that reached into Tier 0's " +
      "durable write would give the decision layer an external effect",
    probe: (context) => isFunction(context.commit),
  },
  {
    id: "snapshot",
    class: REQUIREMENT_CLASS.PROCESS_DEPENDENCY,
    owner: "the composition root",
    why: "§9.6 requirement 5 — the round's pinned configuration version. Every register probe above reads it",
    probe: (context) => present(context.snapshot) && isFunction(context.snapshot.resolve),
  },

  /* ── §6.4 admissibility, checked rather than assumed ───────────────────────── */
  {
    id: "Ω correction (candidates/omega.combinedCorrection)",
    class: REQUIREMENT_CLASS.ADMISSIBILITY,
    owner: "resolves from the pinned snapshot; see `problems` on the failure",
    why:
      "§6.4's bound subtracts `Ω_terminal` and `Ω_policy` because three cost terms can be negative, and **a " +
      "bound that omits a negative term is larger than the true cost, not smaller** — pruning would then " +
      "discard cells containing the true optimum while the decision record advertised a proven guarantee. " +
      "`lowerBound()` refuses a non-bigint correction, so this fails closed; it is probed here so the refusal " +
      "names §6.4 rather than surfacing as an unexplained empty candidate set.",
    probe: (context) => {
      if (!present(context.snapshot)) return false;
      try {
        return omega.combinedCorrection({ snapshot: context.snapshot, omegaTerminalCu: context.omegaTerminalCu }).ok;
      } catch {
        return false;
      }
    },
  },
]);

/** Every requirement id, in declaration order. Used by `leaderWorkers.UNCOMPOSABLE`. */
const REQUIREMENT_IDS = Object.freeze(REQUIREMENTS.map((entry) => entry.id));

/**
 * Which of the coordinator's solve-path inputs this context can supply, and which it cannot.
 *
 * A probe that throws counts as **not satisfied**, never as satisfied: an input whose own
 * resolution raises is exactly the case where assuming presence is worst.
 *
 * @param {object} [context] the composition context; omit it for the standing contract
 * @returns {{ ok: boolean, missing: object[], satisfied: string[], byClass: object }}
 */
function requirements(context) {
  const source = context || {};
  const missing = [];
  const satisfied = [];

  for (const entry of REQUIREMENTS) {
    let ok = false;
    try {
      ok = entry.probe(source) === true;
    } catch {
      ok = false;
    }
    if (ok) satisfied.push(entry.id);
    else missing.push({ input: entry.id, class: entry.class, owner: entry.owner, why: entry.why });
  }

  const byClass = Object.create(null);
  for (const row of missing) byClass[row.class] = (byClass[row.class] || 0) + 1;

  return { ok: missing.length === 0, missing, satisfied, byClass };
}

/**
 * The refusal sentence, built from the measured list rather than restated.
 *
 * Grouped by class, because *who can supply this* is the actionable part and a flat list of
 * eight names hides that three of them are nobody's decision.
 *
 * @param {object[]} missing from `requirements()`
 * @returns {string}
 */
function describeMissing(missing) {
  const grouped = new Map();
  for (const row of missing) {
    if (!grouped.has(row.class)) grouped.set(row.class, []);
    grouped.get(row.class).push(row.input);
  }
  return [...grouped.entries()].map(([className, inputs]) => `${className}: ${inputs.join(", ")}`).join(" | ");
}

module.exports = {
  REQUIREMENT_CLASS,
  REQUIREMENTS,
  REQUIREMENT_IDS,
  requirements,
  describeMissing,
};

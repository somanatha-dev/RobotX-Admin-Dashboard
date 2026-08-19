"use strict";

/**
 * Publish-time validation (§22.1 rule 5).
 *
 * > Invalid configuration is rejected at publish time, not discovered at decision
 * > time. This includes **cross-parameter consistency**, not merely per-parameter
 * > range checks.
 *
 * §22.1 rule 5 enumerates ten blocking cross-parameter checks. They are implemented
 * here as V1–V10, each named after the failure it prevents rather than after the
 * parameter it reads, because the point of every one of them is that the individual
 * values look defensible alone:
 *
 *   V1  opportunity value horizon      — else the opportunity term silently saturates
 *   V2  policy credit ceilings         — else the candidate-pruning bound stops being admissible
 *   V3  contingency quantile derived   — else quantile and tier-1 target contradict each other
 *   V4  shard sizing inequality        — else the serialised commit section is oversubscribed
 *   V5  dedup retention                — else a redelivered command outlives the state that would reject it
 *   V6  snapshot retention             — else a retained Tier A record becomes unreplayable
 *   V7  aging multiplier finite        — rejected rather than merely discouraged
 *   V8  spatial containment            — else Ω_terminal no longer bounds the prices the shard can reach
 *   V9  combined conservatism          — else derating factors compound past anyone's stated intention
 *   V10 calibration status             — no Safety-class parameter PROVISIONAL or UNCALIBRATED
 *
 * ── A note on the count ─────────────────────────────────────────────────────
 * `IMPLEMENTATION_EXECUTION_PLAN.md` §7 Phase 1 says "all eight §22.1 rule-5
 * cross-parameter checks". §22.1 rule 5 lists **ten** bullets. The plan states its
 * own precedence — "Where this plan and the specification appear to disagree, the
 * specification wins and this plan is defective" — so all ten are implemented and
 * the plan's count is recorded as a defect in the Phase 1 report.
 *
 * Three further checks are implemented and clearly labelled as such, because they are
 * cross-parameter identities the specification states elsewhere in normative language
 * and because rule 5's list is introduced with "the following are validated at publish
 * and are blocking", not "only the following":
 *
 *   A1  λ_min is a genuine underestimate of every class's λ_time (§6.4, §8.10)
 *   A2  derived parameters are not hand-entered (§22.1 rule 6)
 *   A3  the migrated legacy liveness coupling `flush interval < offline cutoff`
 *   A4  the leadership renewal margin is satisfiable (§19.5) — Phase 13
 *   A6  every published cell id is an H3 index at its declared resolution, or is a declared
 *       §6.2 site-local graph zone (B5) — Phase 15, closing N21
 *
 * Per-parameter type and range validation runs first (P-series). A cross-parameter
 * check reading an out-of-range value would report a second, derived failure.
 */

const { CALIBRATION_STATUS, checkRegister } = require("./calibrationStatus");
const { rejectHandEnteredDerived, CONTINGENCY_TIER } = require("./derived");
const { normaliseScopeLevel, permitsScope } = require("./resolver");
// PHASE 13 — V4's inequality and §3.5's definition-set rules live where the shard model
// lives, and are read from here rather than restated. A second copy of a sizing bound is a
// second thing to update when k_txn is re-measured.
const sizing = require("../shard/sizing");
const shardModel = require("../shard/shardModel");
const election = require("../shard/election");
// PHASE 15 — A6's rule is the D1 gate's V-10, read from where it is defined rather than
// restated. §6.2's site-local carve-out is the part most likely to be revisited, and it must
// mean the same thing at publish time as it does at region acceptance.
const regionBoundary = require("../spatial/regionBoundary");
const { RESOLUTION } = require("../spatial/cells");

// `SECONDS_PER_HOUR` and `MS_PER_SECOND` were declared here until Phase 13's refactor moved
// the §3.5 arithmetic into `shard/sizing.js`, which owns the only copies now. They were left
// behind unreferenced; `PHASE_13_INDEPENDENT_VERIFICATION.md` Finding 2 records it. Removed
// rather than kept, because a unit conversion sitting beside a validator that no longer does
// the arithmetic is an invitation to do it here a second time — and two copies of a sizing
// bound is two places to update when k_txn is re-measured, the one that is not updated being
// the one that admits the oversubscribed shard.

const SEVERITY = Object.freeze({
  BLOCKING: "BLOCKING",
  LAUNCH_GATE: "LAUNCH_GATE",
  WARNING: "WARNING",
});

/**
 * @param {*} value
 * @returns {boolean}
 */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * @param {Map<string, *>|object} values
 * @param {string} name
 * @returns {*}
 */
function read(values, name) {
  return values instanceof Map ? values.get(name) : values[name];
}

/**
 * Make one finding.
 *
 * @param {string} id
 * @param {string} severity
 * @param {string} rule
 * @param {string} message
 * @returns {object}
 */
function finding(id, severity, rule, message) {
  return { id, severity, rule, message };
}

/* ═══════════════════════════════════════════════════════════════════════════
   P-series — per-parameter form, type and range
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * §22.1 rule 2: every parameter has a name, type, unit, valid range, default, scope
 * levels, owner, description, change class, and blast radius.
 *
 * @param {object} entry
 * @returns {string[]}
 */
function checkEntryForm(entry) {
  const problems = [];
  const required = ["name", "type", "unit", "scopes", "owner", "description", "changeClass", "blastRadius"];
  for (const field of required) {
    const value = entry[field];
    const missing = value === undefined || value === null || (Array.isArray(value) && value.length === 0) || value === "";
    if (missing) problems.push(`${entry.name || "(unnamed)"}: register entry has no ${field} (§22.1 rule 2)`);
  }
  if (!Object.prototype.hasOwnProperty.call(entry, "default")) {
    problems.push(`${entry.name}: register entry declares no default (§22.1 rule 2)`);
  }
  if (!Object.prototype.hasOwnProperty.call(entry, "range")) {
    problems.push(`${entry.name}: register entry declares no valid range (§22.1 rule 2)`);
  }
  return problems;
}

/**
 * Range and type check of one effective value.
 *
 * @param {object} entry
 * @param {*} value
 * @returns {string[]}
 */
function checkValueAgainstEntry(entry, value) {
  const problems = [];
  if (value === null || value === undefined) return problems;

  const check = (scalar) => {
    if (entry.type === "integer" || entry.type === "number") {
      if (!isNumber(scalar)) {
        problems.push(`${entry.name}: value ${JSON.stringify(scalar)} is not a finite ${entry.type}`);
        return;
      }
      if (entry.type === "integer" && !Number.isInteger(scalar)) {
        problems.push(`${entry.name}: value ${scalar} is not an integer (unit ${entry.unit})`);
      }
      const range = entry.range;
      if (range) {
        if (isNumber(range.min) && (range.exclusiveMin ? scalar <= range.min : scalar < range.min)) {
          problems.push(`${entry.name}: value ${scalar} is below its valid range minimum ${range.min} (unit ${entry.unit})`);
        }
        if (isNumber(range.max) && scalar > range.max) {
          problems.push(`${entry.name}: value ${scalar} is above its valid range maximum ${range.max} (unit ${entry.unit})`);
        }
      }
    } else if (entry.type === "boolean" && typeof scalar !== "boolean") {
      problems.push(`${entry.name}: value ${JSON.stringify(scalar)} is not a boolean`);
    } else if (entry.type === "string" && typeof scalar !== "string") {
      problems.push(`${entry.name}: value ${JSON.stringify(scalar)} is not a string`);
    }
  };

  if (entry.type === "map" && value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (Array.isArray(entry.keys) && !entry.keys.includes(key)) {
        problems.push(`${entry.name}: unknown index key "${key}"; expected one of ${entry.keys.join(", ")}`);
      }
      const scalar = value[key];
      if (isNumber(scalar) && entry.range) {
        if (isNumber(entry.range.min) && scalar < entry.range.min) {
          problems.push(`${entry.name}[${key}]: value ${scalar} is below its valid range minimum ${entry.range.min}`);
        }
        if (isNumber(entry.range.max) && scalar > entry.range.max) {
          problems.push(`${entry.name}[${key}]: value ${scalar} is above its valid range maximum ${entry.range.max}`);
        }
      }
    }
    return problems;
  }

  if (entry.type === "set") {
    if (!Array.isArray(value)) problems.push(`${entry.name}: value ${JSON.stringify(value)} is not a set`);
    return problems;
  }

  if (entry.indexedBy && value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value)) check(value[key]);
    return problems;
  }

  check(value);
  return problems;
}

/* ═══════════════════════════════════════════════════════════════════════════
   V-series — the §22.1 rule 5 cross-parameter checks
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * V1 — `cost.opportunity.value_horizon` > `plan.commitment_horizon` + the region's
 * maximum admissible mission duration (§8.3), else the opportunity term silently
 * saturates.
 */
function v1OpportunityValueHorizon(values) {
  const horizon = read(values, "cost.opportunity.value_horizon");
  const commitment = read(values, "plan.commitment_horizon");
  const mission = read(values, "plan.max_admissible_mission_duration");

  if (!isNumber(horizon) || !isNumber(commitment) || !isNumber(mission)) {
    return [
      finding(
        "V1",
        SEVERITY.BLOCKING,
        "§22.1 rule 5 · §8.3",
        "cost.opportunity.value_horizon cannot be validated: one of value_horizon, " +
          "plan.commitment_horizon, plan.max_admissible_mission_duration is unset.",
      ),
    ];
  }
  if (horizon > commitment + mission) return [];
  return [
    finding(
      "V1",
      SEVERITY.BLOCKING,
      "§22.1 rule 5 · §8.3",
      `cost.opportunity.value_horizon (${horizon} s) must exceed plan.commitment_horizon ` +
        `(${commitment} s) + plan.max_admissible_mission_duration (${mission} s) = ` +
        `${commitment + mission} s, else the opportunity term silently saturates.`,
    ),
  ];
}

/**
 * V2 — every `C_policy` adjustment declares a credit ceiling, and
 * `cost.policy.max_total_credit` is recomputed as their sum (§6.4, §8.6), else the
 * candidate-pruning bound stops being admissible.
 */
function v2PolicyCreditCeilings(entries, values, derivedValues) {
  const results = [];
  let declared = 0;

  for (const entry of entries) {
    if (!entry.creditCeiling) continue;
    declared += 1;
    const ceiling = read(values, entry.name);
    if (!isNumber(ceiling) || ceiling < 0) {
      results.push(
        finding(
          "V2",
          SEVERITY.BLOCKING,
          "§22.1 rule 5 · §8.6 · §6.4",
          `C_policy adjustment "${entry.name}" declares no usable credit ceiling. An adjustment ` +
            "without a declared ceiling is rejected at configuration publish time — those ceilings " +
            "are what make the candidate-pruning lower bound admissible.",
        ),
      );
    }
  }

  if (declared === 0) {
    results.push(
      finding(
        "V2",
        SEVERITY.BLOCKING,
        "§22.1 rule 5 · §8.6",
        "no C_policy adjustment declares a credit ceiling, so Ω_policy is undefined and the " +
          "candidate-pruning lower bound has no bound on its negative policy term.",
      ),
    );
    return results;
  }

  const omega = derivedValues.get("cost.policy.max_total_credit");
  const expected = [...entries]
    .filter((entry) => entry.creditCeiling)
    .reduce((total, entry) => total + (isNumber(read(values, entry.name)) ? read(values, entry.name) : Number.NaN), 0);

  if (results.length === 0 && (!isNumber(omega) || omega !== expected)) {
    results.push(
      finding(
        "V2",
        SEVERITY.BLOCKING,
        "§22.1 rule 5 · §8.6",
        `Ω_policy (cost.policy.max_total_credit) is ${String(omega)} but the sum of the declared ` +
          `ceilings is ${expected}. It is computed by the Config Service at publish time, never ` +
          "hand-maintained, and republished automatically whenever any constituent ceiling changes.",
      ),
    );
  }

  return results;
}

/**
 * V3 — `energy.contingency_quantile` is derived as `1 − α_1`, never set independently
 * (§14.5).
 */
function v3ContingencyQuantileDerived(values, derivedValues, bindings) {
  const results = [];

  const handEntered = (bindings || []).filter((binding) => binding.name === "energy.contingency_quantile");
  for (const binding of handEntered) {
    results.push(
      finding(
        "V3",
        SEVERITY.BLOCKING,
        "§22.1 rule 5 · §14.5",
        `energy.contingency_quantile is bound by hand at scope ${binding.level || "global"}. It is ` +
          "derived as 1 − α[T1]: configuring the quantile and the tier-1 probability independently " +
          "permits them to contradict each other — a 0.95 quantile cannot deliver a 1e-2 tier-1 " +
          "target — and the contradiction is invisible because each value looks defensible alone.",
      ),
    );
  }

  const alpha = derivedValues.get("energy.shortfall_probability");
  const quantile = derivedValues.get("energy.contingency_quantile");
  if (!alpha || !isNumber(alpha[CONTINGENCY_TIER]) || !isNumber(quantile)) {
    results.push(
      finding("V3", SEVERITY.BLOCKING, "§22.1 rule 5 · §14.5", "energy.contingency_quantile could not be derived from α[T1]."),
    );
    return results;
  }

  if (quantile !== 1 - alpha[CONTINGENCY_TIER]) {
    results.push(
      finding(
        "V3",
        SEVERITY.BLOCKING,
        "§22.1 rule 5 · §14.5",
        `energy.contingency_quantile (${quantile}) does not equal 1 − α[T1] (${1 - alpha[CONTINGENCY_TIER]}).`,
      ),
    );
  }
  return results;
}

/**
 * V4 — the shard-sizing inequality of §3.5 holds for the region's measured mission
 * rate: `N · r · k_txn · t_txn ≤ ρ_max · 3600`.
 *
 * ── PHASE 13 — the arithmetic moved, and the check gained a second subject ───
 * The inequality itself now lives in `shard/sizing.evaluateSerialCommitBound()`, and this
 * check delegates to it. Two copies of a sizing inequality is two places to update when
 * `k_txn` is re-measured, and the copy that is not updated is the one that admits the
 * oversubscribed shard — the exact failure §3.5 wrote both bounds down to prevent.
 *
 * The check is also now applied **per shard definition** as well as to the resolved global
 * values. §3.5 is explicit that the bound "is inversely proportional to mission rate" and
 * that "shard size is therefore configured per region against that region's measured `r`",
 * so a publish carrying region-scoped overrides has as many instances of this inequality as
 * it has regions, and validating only the global one would pass a publish in which the one
 * dense urban region is oversubscribed by a factor of five.
 *
 * @param {Map<string, *>|object} values the resolved global values
 * @param {object[]} [shards] per-shard definitions `{ shardId, regionId, maxAgents?,
 *   missionRatePerAgentHour?, commitTxnServiceTimeMs? }` — each field falling back to the
 *   global value when the definition does not override it
 * @returns {object[]}
 */
function v4ShardSizing(values, shards) {
  const globalInputs = {
    agents: read(values, "shard.max_agents"),
    missionRatePerAgentHour: read(values, "shard.mission_rate_per_agent_hour"),
    txnPerMissionLifecycle: read(values, "shard.txn_per_mission_lifecycle"),
    commitTxnServiceTimeMs: read(values, "shard.commit_txn_service_time"),
    maxSerialUtilisation: read(values, "commit.max_serial_utilisation"),
  };

  const results = [];

  const evaluateOne = (inputs, label) => {
    const bound = sizing.evaluateSerialCommitBound(inputs);
    if (!bound.evaluated) {
      results.push(
        finding(
          "V4",
          SEVERITY.BLOCKING,
          "§22.1 rule 5 · §3.5",
          `${label}the shard-sizing inequality cannot be evaluated: ${bound.missing.join(", ")} unset. ` +
            "An unevaluated bound is not a satisfied one — a shard sized against a bound nobody computed is " +
            "sized against nothing.",
        ),
      );
      return;
    }
    if (bound.satisfied) return;
    results.push(finding("V4", SEVERITY.BLOCKING, "§22.1 rule 5 · §3.5", `${label}${bound.sentence}`));
  };

  evaluateOne(globalInputs, "");

  for (const definition of Array.isArray(shards) ? shards : []) {
    if (!definition) continue;
    const label = `shard "${String(definition.shardId)}" (region "${String(definition.regionId)}"): `;
    evaluateOne(
      {
        agents: isNumber(definition.maxAgents) ? definition.maxAgents : globalInputs.agents,
        missionRatePerAgentHour: isNumber(definition.missionRatePerAgentHour)
          ? definition.missionRatePerAgentHour
          : globalInputs.missionRatePerAgentHour,
        // `k_txn` is deliberately not overridable per shard: §3.5 derives it from the
        // mission lifecycle, which is a property of the design rather than of a region.
        txnPerMissionLifecycle: globalInputs.txnPerMissionLifecycle,
        commitTxnServiceTimeMs: isNumber(definition.commitTxnServiceTimeMs)
          ? definition.commitTxnServiceTimeMs
          : globalInputs.commitTxnServiceTimeMs,
        maxSerialUtilisation: globalInputs.maxSerialUtilisation,
      },
      label,
    );
  }

  // §3.5 also requires region → shard to be a function and shard ids to be unique. A
  // publish that broke either would produce a map intake cannot route against, discovered
  // at the first Leg rather than here.
  if (Array.isArray(shards) && shards.length > 0) {
    const structural = shardModel.validateDefinitions(shards);
    for (const problem of structural.problems) {
      results.push(finding("V4", SEVERITY.BLOCKING, "§22.1 rule 5 · §3.5", problem));
    }
  }

  return results;
}

/**
 * V5 — `agent.dedup_retention` ≥ `dispatch.offer_ttl` + `dispatch.max_delivery_delay`
 * (§11.5), else a redelivered command can outlive the state that would reject it.
 */
function v5DedupRetention(values) {
  const retention = read(values, "agent.dedup_retention");
  const offerTtl = read(values, "dispatch.offer_ttl");
  const maxDelay = read(values, "dispatch.max_delivery_delay");

  if (![retention, offerTtl, maxDelay].every(isNumber)) {
    return [
      finding("V5", SEVERITY.BLOCKING, "§22.1 rule 5 · §11.5", "agent.dedup_retention cannot be validated: an input is unset."),
    ];
  }
  if (retention >= offerTtl + maxDelay) return [];
  return [
    finding(
      "V5",
      SEVERITY.BLOCKING,
      "§22.1 rule 5 · §11.5",
      `agent.dedup_retention (${retention} s) is below dispatch.offer_ttl (${offerTtl} s) + ` +
        `dispatch.max_delivery_delay (${maxDelay} s) = ${offerTtl + maxDelay} s, so a redelivered ` +
        "command can outlive the state that would reject it.",
    ),
  ];
}

/**
 * V6 — input-snapshot retention ≥ `observability.full_retention` (§21.2), else a
 * retained Tier A record becomes unreplayable and its explanation unreconstructable.
 */
function v6SnapshotRetention(values) {
  const snapshot = read(values, "observability.input_snapshot_retention");
  const full = read(values, "observability.full_retention");

  if (![snapshot, full].every(isNumber)) {
    return [
      finding("V6", SEVERITY.BLOCKING, "§22.1 rule 5 · §21.2", "snapshot retention cannot be validated: an input is unset."),
    ];
  }
  if (snapshot >= full) return [];
  return [
    finding(
      "V6",
      SEVERITY.BLOCKING,
      "§22.1 rule 5 · §21.2",
      `observability.input_snapshot_retention (${snapshot} days) is below ` +
        `observability.full_retention (${full} days), so a retained Tier A record becomes ` +
        "unreplayable and its explanation unreconstructable.",
    ),
  ];
}

/**
 * V7 — `cost.aging.max_multiplier` is finite (§8.7); an unbounded value is rejected
 * rather than merely discouraged.
 */
function v7AgingMultiplierFinite(values) {
  const multiplier = read(values, "cost.aging.max_multiplier");
  if (isNumber(multiplier)) return [];
  return [
    finding(
      "V7",
      SEVERITY.BLOCKING,
      "§22.1 rule 5 · §8.7",
      `cost.aging.max_multiplier is ${String(multiplier)}, which is not finite. An unbounded value ` +
        "is rejected rather than merely discouraged: anti-starvation is guaranteed by the §17.4 " +
        "escalation ladder, not by letting the aging term grow without limit.",
    ),
  ];
}

/**
 * V8 — no zone spans two regions, and every fine cell maps to exactly one zone and at
 * most one site (§3.6), else `Ω_terminal` no longer bounds the prices the shard can
 * reach.
 *
 * The spatial maps are published as configuration in Phase 2. Until they exist, this
 * validates whatever map the payload supplies and passes vacuously on an absent one —
 * an absent map is not an invalid map.
 */
function v8SpatialContainment(spatial) {
  if (!spatial) return [];
  const results = [];

  const zoneRegion = new Map();
  for (const zone of spatial.zones || []) {
    if (!zone || !zone.id) continue;
    if (zoneRegion.has(zone.id) && zoneRegion.get(zone.id) !== zone.regionId) {
      results.push(
        finding(
          "V8",
          SEVERITY.BLOCKING,
          "§22.1 rule 5 · §3.6",
          `zone "${zone.id}" is assigned to more than one region. A zone that spans two regions ` +
            "means Ω_terminal no longer bounds the prices the shard can reach.",
        ),
      );
    }
    zoneRegion.set(zone.id, zone.regionId);
    if (!zone.regionId) {
      results.push(
        finding("V8", SEVERITY.BLOCKING, "§22.1 rule 5 · §3.6", `zone "${zone.id}" names no region.`),
      );
    }
  }

  const cellZones = new Map();
  const cellSites = new Map();
  for (const assignment of spatial.cells || []) {
    if (!assignment || !assignment.cellId) continue;
    const zones = cellZones.get(assignment.cellId) || new Set();
    if (assignment.zoneId) zones.add(assignment.zoneId);
    cellZones.set(assignment.cellId, zones);

    const sites = cellSites.get(assignment.cellId) || new Set();
    if (assignment.siteId) sites.add(assignment.siteId);
    cellSites.set(assignment.cellId, sites);
  }

  for (const [cellId, zones] of cellZones.entries()) {
    if (zones.size !== 1) {
      results.push(
        finding(
          "V8",
          SEVERITY.BLOCKING,
          "§22.1 rule 5 · §3.6",
          `fine cell "${cellId}" maps to ${zones.size} zones; every fine cell maps to exactly one. ` +
            "Containment is by published assignment, not query-time geometry.",
        ),
      );
    }
  }
  for (const [cellId, sites] of cellSites.entries()) {
    if (sites.size > 1) {
      results.push(
        finding(
          "V8",
          SEVERITY.BLOCKING,
          "§22.1 rule 5 · §3.6",
          `fine cell "${cellId}" maps to ${sites.size} sites; every fine cell maps to at most one.`,
        ),
      );
    }
  }

  return results;
}

/**
 * A6 — every published cell id is the thing it claims to be (§6.2, B5), else a fabricated
 * region map is indistinguishable from a derived one at the only point that can refuse it.
 *
 * ── The defect this closes ────────────────────────────────────────────────
 * `PHASE_15_CONSOLIDATED_REMEDIATION_REPORT.md` §30.5.2 records it as **N21**, proven by
 * execution rather than by reading: `hierarchy.validate(SEED_SPATIAL_MAP).ok → true` with zero
 * problems, on a map whose every cell id is a placeholder token and none of which
 * `cells.resolutionOfH3Cell` can resolve. That was **correct for Phase 2**, where a cell id was
 * "an opaque token supplied by the published map" because B5 was open. B5 is now settled
 * (`cells.js:29–39` — H3, resolutions 8 and 5) and this check is the validator catching up to
 * it. §36.2 records the consequence of leaving it open: "the publish path still cannot
 * mechanically reject a fabricated region, and it should be tightened *before* the first
 * spatial map is published, not after."
 *
 * ── Why it is an A-series check ───────────────────────────────────────────
 * §22.1 rule 5's list is introduced with "the following are validated at publish and are
 * blocking", not "only the following" — this file's header states that, and A1–A5 already
 * stand on it. A6 enforces a §6.2 identity, not a §22.1 cross-parameter identity, so it takes
 * the same place A3's migrated legacy coupling does.
 *
 * ── What it does not do ───────────────────────────────────────────────────
 * It passes **vacuously on an absent map**, exactly as V8 does: D1 is undecided, nothing is
 * published, and an absent map is not an invalid one. It validates no geometry, because a
 * published map carries none (§3.6 — containment is by assignment). And it does not reject
 * §6.2's indoor/multi-level site-local graph zones: those are legitimate non-geodesic tokens,
 * and a cell may claim that exemption by declaring it and naming its site. What it refuses is
 * a token that is *neither* — which is precisely what a fabricated map is made of.
 *
 * @param {object|null|undefined} spatial the published spatial payload
 * @returns {object[]} findings
 */
function a6SpatialCellIdentity(spatial) {
  if (!spatial) return [];
  const results = [];

  const check = (list, resolution, field) => {
    for (const assignment of Array.isArray(list) ? list : []) {
      if (!assignment || assignment.cellId === undefined || assignment.cellId === null) continue;
      for (const problem of regionBoundary.validateCellIdentity(assignment, resolution)) {
        results.push(finding("A6", SEVERITY.BLOCKING, "§6.2 · B5 · §22.1 rule 5", `${field}: ${problem}`));
      }
    }
  };

  // `toConfigPayload` splits the map: `cells` carries the fine cells §3.6's containment rule is
  // stated for, `coarseCells` the §6.2 regional-sweep index. Each is checked at its own band,
  // because a fine cell published at the coarse resolution silently changes the §20.3 cache key
  // space and the §6.3 k-ring bounds while looking entirely well-formed.
  check(spatial.cells, RESOLUTION.FINE, "cells");
  check(spatial.coarseCells, RESOLUTION.COARSE, "coarseCells");

  return results;
}

/**
 * V9 — the combined nominal and degraded conservatism products do not exceed
 * `energy.max_combined_conservatism` (§14.3), else independently-chosen derating
 * factors compound past anyone's stated intention.
 */
function v9CombinedConservatism(values, derivedValues, evidence) {
  const cap = read(values, "energy.max_combined_conservatism");
  const nominal = derivedValues.get("energy.combined_nominal_conservatism");
  const degraded = derivedValues.get("energy.combined_degraded_conservatism");
  const results = [];

  if (!isNumber(cap)) {
    return [
      finding("V9", SEVERITY.BLOCKING, "§22.1 rule 5 · §14.3", "energy.max_combined_conservatism is unset."),
    ];
  }

  const factorList = (factors) =>
    Object.entries(factors)
      .map(([name, value]) => `${name}=${value}`)
      .join(" × ");

  if (isNumber(nominal) && nominal > cap) {
    results.push(
      finding(
        "V9",
        SEVERITY.BLOCKING,
        "§22.1 rule 5 · §14.3",
        `combined nominal energy conservatism ${nominal} exceeds energy.max_combined_conservatism ` +
          `${cap} (${factorList(evidence.factors.nominal)}). Layered fudge factors compound ` +
          "invisibly; raising the cap is an explicit Safety-class decision.",
      ),
    );
  }
  if (isNumber(degraded) && degraded > cap) {
    results.push(
      finding(
        "V9",
        SEVERITY.BLOCKING,
        "§22.1 rule 5 · §14.3",
        `combined degraded energy conservatism ${degraded} exceeds energy.max_combined_conservatism ` +
          `${cap} (nominal ${nominal} × ${factorList(evidence.factors.degradedOnly)}). Raising the cap ` +
          "is an explicit Safety-class decision, which is where a deliberate choice to be very " +
          "conservative belongs — stated once, rather than assembled by accident.",
      ),
    );
  }

  for (const duplicate of evidence.duplicateCompensations || []) {
    results.push(finding("V9", SEVERITY.WARNING, "§14.3", duplicate));
  }

  return results;
}

/**
 * V10 — every parameter carries a calibration status, and no Safety-class parameter is
 * `PROVISIONAL` or `UNCALIBRATED` (§22.4).
 *
 * The Safety-class half is the §22.4 **launch** gate, which Phase 15 owns. It is
 * enforced as blocking only when the publish declares itself launch-gated (a
 * production publish); otherwise it is reported at `LAUNCH_GATE` severity so the
 * Phase 15 check is a report rather than a discovery. Everything else in §22.4 — a
 * missing status, a missing owner, an uncalibrated entry that does not name the data
 * it awaits — is blocking always.
 */
function v10CalibrationStatus(entries, options) {
  const result = checkRegister(entries, options);
  return [
    ...result.blocking.map((message) => finding("V10", SEVERITY.BLOCKING, "§22.1 rule 5 · §22.4", message)),
    ...result.launchGate.map((message) => finding("V10", SEVERITY.LAUNCH_GATE, "§22.4 launch gate", message)),
  ];
}

/* ═══════════════════════════════════════════════════════════════════════════
   A-series — cross-parameter identities stated outside §22.1 rule 5's list
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * A1 — `cost.lambda_time_floor` (λ_min) must not exceed any class's `cost.lambda_time`.
 *
 * §6.4 requires the first four components of `LB` to be **non-negative provable
 * underestimates**, and names λ_min as the configured floor on the marginal value of
 * agent time. A floor above some class's actual λ_time makes `LB` an overestimate for
 * that class, and pruning then discards cells containing the true optimum while the
 * decision record advertises a proven guarantee.
 */
function a1LambdaFloorAdmissible(values) {
  const floor = read(values, "cost.lambda_time_floor");
  const lambdaTime = read(values, "cost.lambda_time");
  if (!isNumber(floor)) {
    return [finding("A1", SEVERITY.BLOCKING, "§6.4 · §8.10", "cost.lambda_time_floor is unset; the pruning bound has no λ_min.")];
  }

  const perClass =
    lambdaTime !== null && typeof lambdaTime === "object" && !Array.isArray(lambdaTime)
      ? Object.entries(lambdaTime)
      : [["(default)", lambdaTime]];

  const offending = perClass.filter(([, value]) => isNumber(value) && floor > value);
  if (offending.length === 0) return [];

  return [
    finding(
      "A1",
      SEVERITY.BLOCKING,
      "§6.4 · §8.10",
      `cost.lambda_time_floor (${floor} CU·s⁻¹) exceeds cost.lambda_time for ` +
        `${offending.map(([klass, value]) => `${klass}=${value}`).join(", ")}. λ_min must be a genuine ` +
        "underestimate, or the candidate-pruning lower bound is not admissible.",
    ),
  ];
}

/**
 * A2 — derived parameters are not hand-entered (§22.1 rule 6).
 */
function a2NoHandEnteredDerived(bindings) {
  return rejectHandEnteredDerived(bindings).map((message) =>
    finding("A2", SEVERITY.BLOCKING, "§22.1 rule 6", message),
  );
}

/**
 * A3 — the migrated legacy liveness coupling: the throttled `lastSeenAt` flush
 * interval must stay below the offline cutoff.
 *
 * This is not a §22.1 rule-5 item. It is the coupling `liveness.constants.js`
 * documented in prose, carried into the register by Phase 1's migration: if the
 * cutoff were at or below the flush interval, a perfectly healthy robot would be
 * marked OFFLINE in the gap between two throttled writes and would flap forever. It
 * retires with the legacy path in Phase 5.
 */
function a3LegacyLivenessCoupling(values) {
  const flush = read(values, "legacy.liveness.db_flush_interval_ms");
  const cutoff = read(values, "legacy.liveness.offline_cutoff_ms");
  if (!isNumber(flush) || !isNumber(cutoff)) return [];
  if (flush < cutoff) return [];
  return [
    finding(
      "A3",
      SEVERITY.BLOCKING,
      "migrated legacy coupling (src/config/liveness.constants.js)",
      `legacy.liveness.db_flush_interval_ms (${flush} ms) is not below ` +
        `legacy.liveness.offline_cutoff_ms (${cutoff} ms). A healthy robot would be marked OFFLINE ` +
        "in the gap between two throttled writes and would flap online/offline forever.",
    ),
  ];
}

/**
 * A4 — the leadership renewal margin of §19.5 is satisfiable.
 *
 * > A coordinator MUST stop committing the moment it cannot renew its lease, *before* the
 * > lease actually expires, leaving a margin of `time.max_clock_skew` plus the store's
 * > round-trip budget.
 *
 * That sentence is a coupling between four parameters, and a publish can satisfy every one
 * of their individual ranges while making the coupling impossible: with a 5 s lease, a
 * 500 ms skew allowance, a 500 ms store round trip and a 4 500 ms renewal interval, the
 * leader's *first* renewal already falls after the instant §19.5 requires it to have
 * stopped committing. The shard would then commit in bursts and idle between them, and
 * nothing about any individual value would show why.
 *
 * A-series rather than V-series for the same reason A1–A3 are: §22.1 rule 5's list does not
 * enumerate it, and the list is introduced with "the following are validated at publish and
 * are blocking", not "only the following". §19.5 states the requirement in normative
 * language, which is the standard the other three A-checks were admitted under.
 */
function a4LeadershipRenewalMargin(values) {
  const leaseSeconds = read(values, "shard.lease_duration");
  const renewalMs = read(values, "shard.renewal_interval");
  const skewMs = read(values, "time.max_clock_skew");
  const roundTripMs = read(values, "shard.store_round_trip_budget");

  if (![leaseSeconds, renewalMs, skewMs, roundTripMs].every(isNumber)) {
    return [
      finding(
        "A4",
        SEVERITY.BLOCKING,
        "§19.5",
        "the leadership renewal margin cannot be validated: one of shard.lease_duration, " +
          "shard.renewal_interval, time.max_clock_skew, shard.store_round_trip_budget is unset.",
      ),
    ];
  }

  const budget = election.renewalBudget({
    leaseDurationSeconds: leaseSeconds,
    maxClockSkewMillis: skewMs,
    storeRoundTripMillis: roundTripMs,
  });

  if (renewalMs < budget.latestRenewalMillis) return [];

  return [
    finding(
      "A4",
      SEVERITY.BLOCKING,
      "§19.5",
      `shard.renewal_interval (${renewalMs} ms) is not below the latest lawful renewal instant ` +
        `(${budget.latestRenewalMillis} ms). ${budget.sentence} The shard would stop committing before every ` +
        "renewal and resume after it — committing in bursts, with nothing about any individual parameter's range " +
        "showing why.",
    ),
  ];
}

/**
 * A5 — the identity store's retention is shorter than the technical record's (§23.7).
 *
 * > field-level classification, encryption at rest, least-privilege access, PII
 * > redaction in analytical copies, **retention limits distinct from (and shorter than)
 * > the operational retention of the decision's *technical* content**, and support for
 * > erasure requests without destroying the audit trail's integrity.
 *
 * The parenthesis is the check. A deployment that set `privacy.identity_retention` to or
 * beyond `observability.full_retention` would be keeping personal data exactly as long as
 * the decision record it was deliberately separated from — which is the state the whole
 * §23.7 construction exists to leave behind, arrived at by a config publish rather than
 * by a schema mistake.
 *
 * The mirror image of V6, and deliberately so: V6 refuses a snapshot retention *below*
 * the technical record's, because that breaks replay; A5 refuses an identity retention
 * *at or above* it, because that breaks the privacy separation. The two together are what
 * make the ordering `identity < technical ≤ snapshot` a published property rather than an
 * intention.
 *
 * A-series rather than V-series for the reason A1–A4 are: §22.1 rule 5's list does not
 * enumerate it, and §23.7 states the requirement in normative language.
 */
function a5IdentityRetentionOrdering(values) {
  const identity = read(values, "privacy.identity_retention");
  const full = read(values, "observability.full_retention");

  if (![identity, full].every(isNumber)) {
    return [
      finding(
        "A5",
        SEVERITY.BLOCKING,
        "§23.7",
        "identity retention cannot be validated: privacy.identity_retention or observability.full_retention is unset.",
      ),
    ];
  }
  if (identity < full) return [];

  return [
    finding(
      "A5",
      SEVERITY.BLOCKING,
      "§23.7",
      `privacy.identity_retention (${identity} days) is not shorter than observability.full_retention ` +
        `(${full} days). §23.7 requires the identity store's retention be "distinct from (and shorter than) the ` +
        'operational retention of the decision\'s technical content"; equal retention keeps the personal data for ' +
        "exactly as long as the record it was separated from, which is the state the separation exists to leave behind.",
    ),
  ];
}

/* ═══════════════════════════════════════════════════════════════════════════
   Entry point
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Validate a candidate configuration at publish time.
 *
 * @param {{ entries: Map<string, object>, bindings?: object[],
 *           values: Map<string, *>, derivedValues: Map<string, *>,
 *           derivationEvidence: object, spatial?: object,
 *           enforceLaunchGate?: boolean }} candidate
 * @returns {{ ok: boolean, findings: object[], blocking: object[],
 *             launchGate: object[], warnings: object[] }}
 */
function validatePublish(candidate) {
  const entries = [...candidate.entries.values()];
  const bindings = candidate.bindings || [];
  const values = candidate.values;
  const derivedValues = candidate.derivedValues;
  const findings = [];

  // P-series first: a cross-parameter check reading an out-of-range value would
  // report a second, derived failure and obscure the real one.
  for (const entry of entries) {
    for (const problem of checkEntryForm(entry)) {
      findings.push(finding("P1", SEVERITY.BLOCKING, "§22.1 rule 2", problem));
    }
    for (const problem of checkValueAgainstEntry(entry, read(values, entry.name))) {
      findings.push(finding("P2", SEVERITY.BLOCKING, "§22.1 rule 5 (range)", problem));
    }
  }

  for (const binding of bindings) {
    const entry = candidate.entries.get(binding.name);
    if (!entry) {
      findings.push(
        finding(
          "P3",
          SEVERITY.BLOCKING,
          "§22.1 rule 1",
          `binding for "${binding.name}" has no register entry. No behavioural constant exists ` +
            "outside the register (§22.1 rule 1, Appendix A).",
        ),
      );
      continue;
    }
    if (!permitsScope(entry, binding.level || "global")) {
      findings.push(
        finding(
          "P4",
          SEVERITY.BLOCKING,
          "§22.2",
          `"${binding.name}" is bound at scope level "${normaliseScopeLevel(binding.level || "global")}", ` +
            `which is not among its declared levels (${(entry.scopes || []).join(", ")}).`,
        ),
      );
    }
    for (const problem of checkValueAgainstEntry(entry, binding.value)) {
      findings.push(finding("P2", SEVERITY.BLOCKING, "§22.1 rule 5 (range)", problem));
    }
  }

  findings.push(...v1OpportunityValueHorizon(values));
  findings.push(...v2PolicyCreditCeilings(entries, values, derivedValues));
  findings.push(...v3ContingencyQuantileDerived(values, derivedValues, bindings));
  findings.push(...v4ShardSizing(values, candidate.shards));
  findings.push(...v5DedupRetention(values));
  findings.push(...v6SnapshotRetention(values));
  findings.push(...v7AgingMultiplierFinite(values));
  findings.push(...v8SpatialContainment(candidate.spatial));
  findings.push(...v9CombinedConservatism(values, derivedValues, candidate.derivationEvidence.conservatism));
  findings.push(...v10CalibrationStatus(entries, { enforceLaunchGate: candidate.enforceLaunchGate }));
  findings.push(...a1LambdaFloorAdmissible(values));
  findings.push(...a2NoHandEnteredDerived(bindings));
  findings.push(...a3LegacyLivenessCoupling(values));
  findings.push(...a4LeadershipRenewalMargin(values));
  findings.push(...a5IdentityRetentionOrdering(values));
  findings.push(...a6SpatialCellIdentity(candidate.spatial));

  const blocking = findings.filter((item) => item.severity === SEVERITY.BLOCKING);
  const launchGate = findings.filter((item) => item.severity === SEVERITY.LAUNCH_GATE);
  const warnings = findings.filter((item) => item.severity === SEVERITY.WARNING);

  return { ok: blocking.length === 0, findings, blocking, launchGate, warnings };
}

module.exports = {
  SEVERITY,
  CALIBRATION_STATUS,
  checkEntryForm,
  checkValueAgainstEntry,
  v1OpportunityValueHorizon,
  v2PolicyCreditCeilings,
  v3ContingencyQuantileDerived,
  v4ShardSizing,
  v5DedupRetention,
  v6SnapshotRetention,
  v7AgingMultiplierFinite,
  v8SpatialContainment,
  v9CombinedConservatism,
  v10CalibrationStatus,
  a1LambdaFloorAdmissible,
  a2NoHandEnteredDerived,
  a3LegacyLivenessCoupling,
  a4LeadershipRenewalMargin,
  a5IdentityRetentionOrdering,
  a6SpatialCellIdentity,
  validatePublish,
};

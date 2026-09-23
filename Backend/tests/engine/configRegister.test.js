"use strict";

/**
 * Engine lane — the parameter register (§22.1, §22.4, Appendix A, §8.10).
 *
 * The register is the artefact the rest of the programme leans on: the build gate
 * reads it, every phase resolves through it, and a parameter absent from it is a
 * constant that shipped uncalibrated, unowned, and unscoped. These tests bind it to
 * the frozen specification in both directions — every tabulated parameter is
 * registered, and every registered entry is well-formed.
 */

const fs = require("fs");
const path = require("path");

const service = require("../../src/engine/config/service");
const { checkEntryForm } = require("../../src/engine/config/validators");
const { CALIBRATION_STATUS, ALL_STATUSES } = require("../../src/engine/config/calibrationStatus");
const { SCOPE_ORDER, SPEC_SCOPE_ALIASES, normaliseScopeLevel } = require("../../src/engine/config/resolver");

const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const SPEC = fs.readFileSync(path.join(REPO_ROOT, "NEXT_GENERATION_ASSIGNMENT_ENGINE.md"), "utf8");

const { entries } = service.loadRegister();

/**
 * Pull the parameter names out of a markdown table in the specification.
 * `energy.event_budget_per_fleet_year[T1]` and `capacity[agent_class]` register
 * under their base name with the index recorded as `indexedBy`/`keys`.
 */
function tabulatedNames(sectionHeading, endHeading) {
  const start = SPEC.indexOf(sectionHeading);
  expect(start).toBeGreaterThan(-1);
  const rest = SPEC.slice(start);
  const end = rest.indexOf(endHeading, sectionHeading.length);
  const table = end === -1 ? rest : rest.slice(0, end);

  const names = new Set();
  for (const line of table.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cell = line.split("|")[1] || "";
    const match = cell.match(/`([^`]+)`/);
    if (!match) continue;
    const base = match[1].replace(/\[.*$/, "").trim();
    if (base && base !== "Parameter") names.add(base);
  }
  return [...names];
}

describe("the register is seeded from the frozen specification", () => {
  const appendixA = tabulatedNames("## Appendix A — Parameter Register", "\n## Appendix B");
  const costRegister = tabulatedNames("### 8.10 Parameter register for the cost function", "\n## 9.");

  test("Appendix A tabulates parameters and every one of them is registered", () => {
    expect(appendixA.length).toBeGreaterThan(80);
    const missing = appendixA.filter((name) => !entries.has(name));
    expect(missing).toEqual([]);
  });

  test("§8.10 tabulates the cost parameters and every one of them is registered", () => {
    expect(costRegister.length).toBeGreaterThan(25);
    const missing = costRegister.filter((name) => !entries.has(name));
    expect(missing).toEqual([]);
  });

  test("no parameter is defined twice across the register files", () => {
    expect(service.loadRegister({ reload: true }).duplicates).toEqual([]);
  });

  test("every constant migrated out of dtaro.constants.js and liveness.constants.js is registered", () => {
    const migrated = [
      "legacy.dtaro.battery_threshold_pct",
      "legacy.dtaro.charging_interrupt_battery_pct",
      "legacy.liveness.db_flush_interval_ms",
      "legacy.liveness.offline_cutoff_ms",
      "legacy.liveness.offline_sweep_interval_ms",
      "legacy.liveness.offline_sweep_batch",
    ];
    for (const name of migrated) {
      expect({ name, registered: entries.has(name) }).toEqual({ name, registered: true });
    }
  });

  test("every kill switch is a register entry, so switch states are governed like any other value", () => {
    const { KILL_SWITCH_NAMES } = require("../../src/engine/config/killSwitches");
    for (const name of KILL_SWITCH_NAMES) {
      expect({ name, registered: entries.has(`killswitch.${name}`) }).toEqual({ name, registered: true });
    }
  });
});

describe("every register entry carries the fields §22.1 rule 2 requires", () => {
  const all = [...entries.values()];

  test("name, type, unit, range, default, scope levels, owner, description, change class, blast radius", () => {
    const problems = all.flatMap((entry) => checkEntryForm(entry));
    expect(problems).toEqual([]);
  });

  test("every declared scope is a §22.2 level, or an Appendix A alias that maps onto one", () => {
    const problems = [];
    for (const entry of all) {
      for (const scope of entry.scopes || []) {
        if (!SCOPE_ORDER.includes(normaliseScopeLevel(scope))) {
          problems.push(`${entry.name}: scope "${scope}"`);
        }
      }
      if (entry.specScope && !SCOPE_ORDER.includes(normaliseScopeLevel(entry.specScope))) {
        problems.push(`${entry.name}: specScope "${entry.specScope}"`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("the two Appendix A scope values §22.2 does not name are mapped, not invented as new levels", () => {
    expect(SPEC_SCOPE_ALIASES).toEqual({ fleet: "global", shard: "region" });
    for (const alias of Object.keys(SPEC_SCOPE_ALIASES)) {
      expect(SCOPE_ORDER).not.toContain(alias);
    }
  });

  test("every calibration status is one of the three §22.4 statuses", () => {
    for (const entry of all) {
      expect({ name: entry.name, status: entry.calibrationStatus }).toEqual({
        name: entry.name,
        status: expect.stringMatching(new RegExp(`^(${ALL_STATUSES.join("|")})$`)),
      });
    }
  });

  test("every PROVISIONAL or UNCALIBRATED entry names the data it awaits (§22.4)", () => {
    const silent = all
      .filter(
        (entry) =>
          entry.calibrationStatus !== CALIBRATION_STATUS.DERIVED &&
          (!entry.awaits || String(entry.awaits).trim() === ""),
      )
      .map((entry) => entry.name);
    expect(silent).toEqual([]);
  });

  test("every derived entry states its formula and its inputs, and every input is registered", () => {
    const derived = all.filter((entry) => entry.changeClass === "DERIVED");
    expect(derived.length).toBeGreaterThan(0);
    for (const entry of derived) {
      expect({ name: entry.name, hasDerivation: Boolean(entry.derivation && entry.derivation.formula) }).toEqual({
        name: entry.name,
        hasDerivation: true,
      });
      for (const input of entry.derivation.inputs || []) {
        expect({ derived: entry.name, input, registered: entries.has(input) }).toEqual({
          derived: entry.name,
          input,
          registered: true,
        });
      }
    }
  });

  test("every conservatism factor declares the uncertainty it compensates for (§14.3)", () => {
    const factors = all.filter((entry) => entry.conservatism);
    expect(factors.length).toBeGreaterThan(0);
    for (const entry of factors) {
      expect({ name: entry.name, compensates: Boolean(entry.conservatism.compensates) }).toEqual({
        name: entry.name,
        compensates: true,
      });
    }
  });

  test("every C_policy credit ceiling is declared, so Ω_policy is a sum of stated numbers (§8.6)", () => {
    const ceilings = all.filter((entry) => entry.creditCeiling).map((entry) => entry.name);
    expect(ceilings.sort()).toEqual(
      [
        "policy.max_burn_in_credit",
        "policy.max_dedicated_fleet_credit",
        "policy.max_operator_adjustment",
        "policy.max_pilot_adjustment",
        "policy.max_zone_affinity_credit",
      ].sort(),
    );
  });

  // ── The defect: three entries carried a change class that does not exist ─────
  //
  // `feasibility.negative_cache_ttl`, `link.min_quality` and `reliability.max_intervention_rate`
  // declared `changeClass: "OPERATIONAL"`. `ConfigChangeClass` has seven values and that is
  // not one of them, and §22.3's own table names five (Hot, Tuned, Policy, Safety,
  // Structural) of which it is also not one.
  //
  // Nothing caught it, because nothing compared the two vocabularies: `checkEntryForm`
  // requires a change class to be *present*, not to be *valid*, so publish-time validation
  // passed and `prisma/seed.js` failed instead — `seedRegister()` writes the value into an
  // enum column, so `node prisma/seed.js` aborted before the spatial hierarchy was seeded
  // and a demo database could not be built at all.
  //
  // The valid set is read out of `schema.prisma` rather than written down here, so the
  // register and the column cannot drift apart again in either direction.
  describe("every change class is one the ConfigChangeClass column can store", () => {
    const schema = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");
    const block = /enum\s+ConfigChangeClass\s*\{([^}]*)\}/.exec(schema);
    const CHANGE_CLASSES = block[1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("/"));

    test("the enum is readable and carries the seven governed classes", () => {
      expect(CHANGE_CLASSES).toEqual(["HOT", "TUNED", "POLICY", "SAFETY", "STRUCTURAL", "DERIVED", "CONTRACTUAL"]);
    });

    test("no register entry declares a class outside it", () => {
      const invalid = all
        .filter((entry) => !CHANGE_CLASSES.includes(entry.changeClass))
        .map((entry) => `${entry.name} = ${String(entry.changeClass)} (${entry.registerFile})`);
      expect(invalid).toEqual([]);
    });

    test("OPERATIONAL in particular cannot return", () => {
      // Named, because it is the one that shipped and the one whose spelling reads
      // plausibly enough to be re-introduced by hand.
      expect(all.filter((entry) => entry.changeClass === "OPERATIONAL").map((entry) => entry.name)).toEqual([]);
    });

    test("the three corrected entries are classified as §22.3 classifies their kind", () => {
      // A cache TTL: §22.3's Tuned row names "cache TTLs" verbatim, and the register's
      // three other cache TTLs — config.cache_ttl, payload.packing_cache_ttl,
      // route.cell_pair_cache_ttl — are all TUNED.
      expect(entries.get("feasibility.negative_cache_ttl").changeClass).toBe("TUNED");
      // Two Ops-owned feasibility thresholds: operational policy, which is what §22.3's
      // Policy row is ("Ops approval, staged rollout, audit"). Neither declares a Safety
      // owner, and on this register every SAFETY entry's owner is Safety, SRE or Security.
      expect(entries.get("link.min_quality").changeClass).toBe("POLICY");
      expect(entries.get("reliability.max_intervention_rate").changeClass).toBe("POLICY");
    });

    test("the correction did not move any entry into or out of the Safety class", () => {
      // The Safety class is the one with a process attached (§22.3: two-person approval,
      // no automated tuner) and a launch gate that blocks on it (§22.4). Fixing a spelling
      // must not have changed who has to approve a publish.
      for (const name of ["feasibility.negative_cache_ttl", "link.min_quality", "reliability.max_intervention_rate"]) {
        expect({ name, safety: entries.get(name).changeClass === "SAFETY" }).toEqual({ name, safety: false });
      }
    });
  });

  test("the Safety-class entries are the ones the specification marks Safety", () => {
    const safety = all.filter((entry) => entry.changeClass === "SAFETY").map((entry) => entry.name);
    for (const expected of [
      "sim.max_optimistic_bias",
      "feasibility.systemic_indeterminacy_threshold",
      "connectivity.max_heartbeat_age",
      "energy.event_budget_per_fleet_year",
      "energy.max_combined_conservatism",
      "payload.safety_factor",
      "agent.dedup_retention",
      "lease.duration",
      "route.degraded_reserve_factor",
      "ops.stranded_obstructing_response_target",
    ]) {
      expect({ expected, isSafety: safety.includes(expected) }).toEqual({ expected, isSafety: true });
    }
  });
});

describe("the register's digest", () => {
  test("is stable across loads and changes when an entry changes", () => {
    const first = service.registerDigest(entries);
    expect(service.registerDigest(service.loadRegister().entries)).toBe(first);

    const mutated = new Map(entries);
    mutated.set("solve.window_min", { ...entries.get("solve.window_min"), default: 501 });
    expect(service.registerDigest(mutated)).not.toBe(first);
  });
});

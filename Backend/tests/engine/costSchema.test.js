"use strict";

/**
 * Phase 8 — schema, register, Redis keys, tier discipline, workers, and the phase boundary.
 *
 * The migration assertions follow Phase 7's discipline exactly: every CREATE TABLE, index,
 * and foreign key is asserted **byte-equal** (whitespace-normalised) to Prisma's own
 * generated output, and every hand-written CHECK constraint is asserted present in the
 * migration *and* absent from the generated output — so a reviewer can tell an addition
 * from an echo.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const SCHEMA_PATH = path.join(BACKEND_ROOT, "prisma", "schema.prisma");
const MIGRATION_PATH = path.join(
  BACKEND_ROOT,
  "prisma",
  "migrations",
  "20260804220000_cost_function_and_plan_builder",
  "migration.sql",
);

const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
const migration = fs.readFileSync(MIGRATION_PATH, "utf8");

const PHASE_8_TABLES = ["ServiceTimeModel", "ZonePriceSnapshot"];

/** Whitespace-normalised, so formatting differences are not mistaken for content ones. */
const normalise = (sql) => sql.replace(/\s+/g, " ").trim();

let generated = null;
const generatedSql = () => {
  if (generated === null) {
    // Prisma's own entry point, invoked through this Node, exactly as Phase 7's
    // `energySchema.test.js` does: a `.cmd` shim is not spawnable with `execFileSync` on
    // Windows, and the point of this test is the SQL rather than the launcher.
    generated = execFileSync(
      process.execPath,
      [
        path.join(BACKEND_ROOT, "node_modules", "prisma", "build", "index.js"),
        "migrate",
        "diff",
        "--from-empty",
        "--to-schema-datamodel",
        path.join(BACKEND_ROOT, "prisma", "schema.prisma"),
        "--script",
      ],
      { cwd: BACKEND_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
  }
  return generated;
};

/** The migration with its commentary stripped, so a `--` line cannot satisfy a match. */
const migrationStatements = migration.replace(/^--.*$/gm, "");

describe("the migration is Prisma's own output plus annotated CHECK constraints", () => {
  test.each(PHASE_8_TABLES)("%s's CREATE TABLE is byte-equal to Prisma's", (table) => {
    const pattern = new RegExp(`CREATE TABLE "${table}" \\([\\s\\S]*?\\n\\);`);
    const fromMigration = pattern.exec(migration);
    const fromPrisma = pattern.exec(generatedSql());
    expect(fromMigration).not.toBeNull();
    expect(fromPrisma).not.toBeNull();
    expect(normalise(fromMigration[0])).toBe(normalise(fromPrisma[0]));
  });

  // The Phase 8 migration created eight indexes on the two tables. Schema cleanup stage 1
  // (forensic re-proof 2026-10-05) dropped the two single-column `version` indexes: each is
  // the leading column of the table's `(version, …)` unique key, which the planner uses for
  // every `WHERE version = ?`. Six remain declared; the historical eight remain in the file.
  const RETIRED_BY_STAGE_1 = ["ServiceTimeModel_version_idx", "ZonePriceSnapshot_version_idx"];

  test("every index Prisma generates for the two tables is in the migration", () => {
    const indexes = generatedSql()
      .split("\n")
      .filter((line) => /^CREATE (UNIQUE )?INDEX/.test(line))
      .filter((line) => PHASE_8_TABLES.some((table) => line.includes(`ON "${table}"`)));
    expect(indexes.length).toBe(6);
    for (const statement of indexes) {
      expect(normalise(migration)).toContain(normalise(statement));
    }
  });

  test("the migration created eight indexes, and stage 1 retired exactly the two left-prefix ones", () => {
    const created = migration
      .split("\n")
      .filter((line) => /^CREATE (UNIQUE )?INDEX/.test(line))
      .filter((line) => PHASE_8_TABLES.some((table) => line.includes(`ON "${table}"`)));
    expect(created.length).toBe(8);
    const generated = generatedSql();
    const cleanup = fs
      .readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20261005180000_schema_cleanup_stage1", "migration.sql"), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    for (const name of RETIRED_BY_STAGE_1) {
      expect(created.some((line) => line.includes(`"${name}"`))).toBe(true);
      expect(generated).not.toContain(`"${name}"`);
      expect(cleanup).toContain(`DROP INDEX "${name}";`);
    }
  });

  test("every foreign key Prisma generates for the two tables is in the migration", () => {
    const keys = generatedSql()
      .split("\n")
      .filter((line) => PHASE_8_TABLES.some((table) => line.startsWith(`ALTER TABLE "${table}" ADD CONSTRAINT`)));
    expect(keys).toHaveLength(2);
    for (const statement of keys) {
      expect(normalise(migration)).toContain(normalise(statement));
    }
  });

  test("the migration is additive: it drops, renames, and re-types nothing", () => {
    expect(migrationStatements).not.toMatch(/DROP TABLE|DROP COLUMN|RENAME|ALTER COLUMN|DROP CONSTRAINT/);
  });

  test("no existing table acquires a column or a constraint", () => {
    const altered = [...migrationStatements.matchAll(/ALTER TABLE "(\w+)"/g)].map((match) => match[1]);
    expect([...new Set(altered)].sort()).toEqual([...PHASE_8_TABLES].sort());
  });

  describe("the four CHECK constraints are hand-written, not echoes", () => {
    const checks = [
      ["ZonePriceSnapshot_lambda_non_negative", /lambdaCuPerSecond" >= 0/],
      ["ZonePriceSnapshot_omega_terminal_non_negative", /omegaTerminalCu" >= 0/],
      ["ZonePriceSnapshot_estimator_known", /FORECAST_QUEUEING/],
      ["ServiceTimeModel_distribution_well_formed", /meanSeconds" >= 0/],
    ];

    test.each(checks)("%s is present in the migration", (name, body) => {
      expect(migration).toContain(name);
      expect(migration).toMatch(body);
    });

    test.each(checks)("%s is absent from Prisma's generated output", (name) => {
      expect(generatedSql()).not.toContain(name);
    });
  });
});

describe("the schema carries what Phase 8 needs and nothing more", () => {
  test.each(PHASE_8_TABLES)("%s is declared", (table) => {
    expect(schema).toMatch(new RegExp(`model ${table} \\{`));
  });

  test("ZonePriceSnapshot is insert-only — no updatedAt, as with the charger projection", () => {
    const model = /model ZonePriceSnapshot \{[\s\S]*?\n\}/.exec(schema)[0];
    expect(model).not.toMatch(/updatedAt/);
    expect(model).toMatch(/version\s+Int/);
    expect(model).toMatch(/omegaTerminalCu\s+Float/);
  });

  test("ServiceTimeModel's four discriminators are nullable — that is the hierarchy", () => {
    const model = /model ServiceTimeModel \{[\s\S]*?\n\}/.exec(schema)[0];
    for (const field of ["siteId", "stopType", "missionClass", "hourOfWeek"]) {
      expect(model).toMatch(new RegExp(`${field}\\s+\\w+\\?`));
    }
    expect(model).toMatch(/sampleCount\s+Int\b/);
  });

  // Phase 9 lands `AgentCellPosition` and Phase 10 lands `WorkQueue` and `Round` — see
  // `commitmentSchema.test.js` for their own presence assertions. The boundary here
  // narrows to what Phase 10 does not yet land, the same discipline every earlier
  // phase's version of this test applied.
  // Phase 11 lands the four §21 tables — see `observabilitySchema.test.js` for their
  // own presence assertions. The boundary narrows again to what Phase 11 does not land.
  // Phase 12 lands §18's and §26's three tables — see `degradedSchema.test.js` for their
  // own presence assertions. Phase 13 lands §3.5's and §19's four — see
  // `shardSchema.test.js`. The boundary narrows again to what Phase 13 does not land.
  // Phase 14 lands §23's four — see `securitySchema.test.js` for their own presence
  // assertions. The boundary narrows again to what Phase 14 does not land. Phase 15's
  // migration row adds no table; it *drops* legacy columns, so what this file now guards
  // is that the cost path's own inputs have not acquired an identifying field — the §23.7
  // rule the identity-isolation gate enforces statically, asserted here against the schema
  // so that a column added to `DecisionRecordA` is caught as well as a read added to a
  // cost module.
  test("no decision-record table has acquired an identifying column (§23.7)", () => {
    const surrogateKeys = require("../../src/engine/privacy/surrogateKeys");
    for (const table of ["DecisionRecordA", "DecisionRecordB", "InputSnapshot"]) {
      const model = new RegExp(`model ${table} \\{[\\s\\S]*?\\n\\}`).exec(schema)[0];
      const columns = [...model.matchAll(/^\s{2}(\w+)\s+\S/gm)].map((match) => match[1]);
      const identifying = columns.filter((column) => surrogateKeys.isIdentifyingField(column));
      expect({ table, identifying }).toEqual({ table, identifying: [] });
    }
  });
});

describe("§8.10 — the cost function's parameter register", () => {
  const registerDir = path.join(BACKEND_ROOT, "src", "engine", "config", "register");
  const names = new Set();
  for (const file of fs.readdirSync(registerDir)) {
    if (!file.endsWith(".json")) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(registerDir, file), "utf8"));
    for (const entry of Array.isArray(parsed) ? parsed : parsed.parameters || []) names.add(entry.name);
  }

  test("every parameter §8.10 tabulates is registered", () => {
    for (const name of [
      "cost.cu_per_currency_unit",
      "cost.lambda_time",
      "cost.lambda_time_floor",
      "cost.energy.cu_per_wh",
      "cost.wear.cu_per_metre",
      "cost.battery.cu_per_equivalent_cycle",
      "cost.failure.cu",
      "cost.energy_consequence",
      "cost.sla.cu_per_second_late",
      "cost.sla.breach_penalty",
      "cost.sla.lateness_exponent",
      "cost.sla.upstream_slack_weight",
      "cost.aging.reference_period",
      "cost.aging.growth_exponent",
      "cost.aging.max_multiplier",
      "cost.opportunity.lambda_zone_prior",
      "cost.opportunity.value_horizon",
      "cost.opportunity.max_terminal_gain",
      "cost.uncertainty_penalty",
      "cost.staleness.cu_per_second_age",
      "churn.base_cost",
      "churn.per_second_elapsed",
      "policy.max_zone_affinity_credit",
      "policy.max_dedicated_fleet_credit",
      "policy.max_burn_in_credit",
      "policy.max_pilot_adjustment",
      "policy.max_operator_adjustment",
      "cost.policy.max_total_credit",
      "candidate.optimality_tolerance_cu",
    ]) {
      expect({ name, registered: names.has(name) }).toEqual({ name, registered: true });
    }
  });

  test("the quantities §8 names but §8.10 does not tabulate are registered too", () => {
    for (const name of [
      "churn.wasted_travel_cost",
      "churn.notification_cost",
      "defer.wasted_round_penalty",
      "lifecycle.cu_per_actuator_cycle",
      "lifecycle.cu_per_braking_event",
      "lifecycle.cu_per_gradient_metre",
      "lifecycle.cu_per_thermal_stress_second",
      "plan.service_time_prior",
      "plan.service_time_prior_cv",
      "plan.service_time_shrinkage_strength",
      "plan.max_heuristic_insertions",
      "route.cell_pair_cache_ttl",
      "route.cell_pair_min_hit_rate",
    ]) {
      expect({ name, registered: names.has(name) }).toEqual({ name, registered: true });
    }
  });

  test("every supplementary Phase 8 entry states the section that requires it", () => {
    const supplementary = JSON.parse(
      fs.readFileSync(path.join(registerDir, "supplementary.json"), "utf8"),
    ).parameters;
    for (const name of [
      "churn.wasted_travel_cost",
      "churn.notification_cost",
      "defer.wasted_round_penalty",
      "lifecycle.cu_per_actuator_cycle",
      "plan.service_time_prior",
    ]) {
      const entry = supplementary.find((row) => row.name === name);
      expect({ name, section: Boolean(entry.section), owner: Boolean(entry.owner) }).toEqual({
        name,
        section: true,
        owner: true,
      });
    }
  });

  test("V1 validates value_horizon > commitment_horizon + max mission duration (§8.3)", () => {
    const validators = require("../../src/engine/config/validators");
    const failing = validators.v1OpportunityValueHorizon(
      new Map([
        ["cost.opportunity.value_horizon", 60],
        ["plan.commitment_horizon", 7200],
        ["plan.max_admissible_mission_duration", 3600],
      ]),
    );
    expect(failing.length).toBeGreaterThan(0);
  });

  test("V7 keeps the aging multiplier finite (§8.7)", () => {
    const validators = require("../../src/engine/config/validators");
    expect(validators.v7AgingMultiplierFinite(new Map([["cost.aging.max_multiplier", Infinity]])).length).toBeGreaterThan(0);
    expect(validators.v7AgingMultiplierFinite(new Map([["cost.aging.max_multiplier", 8]]))).toEqual([]);
  });

  test("the new dimensioned rates are declared in the exchange-rate table", () => {
    const { RATE_DIMENSIONS, ABSOLUTE_CU_PARAMETERS } = require("../../src/engine/cost/exchangeRates");
    expect(RATE_DIMENSIONS["churn.wasted_travel_cost"]).toBe("CU·m⁻¹");
    expect(RATE_DIMENSIONS["lifecycle.cu_per_gradient_metre"]).toBe("CU·m⁻¹");
    expect(RATE_DIMENSIONS["lifecycle.cu_per_thermal_stress_second"]).toBe("CU·s⁻¹");
    expect(ABSOLUTE_CU_PARAMETERS).toEqual(expect.arrayContaining(["defer.wasted_round_penalty"]));
  });
});

describe("Redis — the two new key families", () => {
  test("the pinned λ_zone surface is engine:price:{version}", () => {
    const capacityPricing = require("../../src/engine/pricing/capacityPricingClient");
    expect(capacityPricing.KEY_PREFIX).toBe("engine:price");
    expect(capacityPricing.key(12)).toBe("engine:price:12");
  });

  test("the cell-pair cache is engine:route:cell:{origin}:{dest}:{profile}:{bucket}", () => {
    const cellPairCache = require("../../src/engine/routing/cellPairCache");
    expect(cellPairCache.KEY_PREFIX).toBe("engine:route:cell");
    expect(cellPairCache.KEY_FIELDS).toEqual(["originCell", "destCell", "profileKey", "timeBucket"]);
  });

  test("neither cache is an authority: a read error is a miss and a write failure is silent", async () => {
    const capacityPricing = require("../../src/engine/pricing/capacityPricingClient");
    const failing = { get: async () => { throw new Error("down"); }, set: async () => { throw new Error("down"); } };
    const loaded = await capacityPricing.read({ kv: failing, load: async () => ({ version: 3 }) }, 3);
    expect(loaded).toEqual({ ok: true, snapshot: { version: 3 }, hit: false });
    expect(await capacityPricing.write({ kv: failing }, { version: 3 }, 60)).toBe(false);
  });
});

describe("§1.8 — tier discipline across the Phase 8 tree", () => {
  const { tierOf, TIER, MECHANISMS } = require("../../src/engine/guards/tierAssertions");

  test("the Tier 2 modules §1.8 names are the ones Phase 8 placed there", () => {
    for (const modulePath of [
      "src/engine/cost/cOpportunity.js",
      "src/engine/cost/cDefer.js",
      "src/engine/cost/cChurn.js",
      "src/engine/pricing/vTerminal.js",
      "src/engine/pricing/capacityPricingClient.js",
      "src/engine/pricing/forecastClient.js",
      "src/engine/plan/insertion.js",
    ]) {
      expect({ modulePath, tier: tierOf(modulePath) }).toEqual({ modulePath, tier: TIER.ALLOCATION_QUALITY });
    }
  });

  test("Φ and the plan builder are Tier 1", () => {
    for (const modulePath of [
      "src/engine/cost/phi.js",
      "src/engine/cost/cDirect.js",
      "src/engine/cost/cRisk.js",
      "src/engine/cost/cLifecycle.js",
      "src/engine/cost/cPolicy.js",
      "src/engine/cost/cDelay.js",
      "src/engine/cost/signDiscipline.js",
      "src/engine/plan/planBuilder.js",
      "src/engine/plan/timeline.js",
      "src/engine/plan/column.js",
      "src/engine/plan/columnBuilder.js",
      "src/engine/routing/cellPairCache.js",
    ]) {
      expect({ modulePath, tier: tierOf(modulePath) }).toEqual({ modulePath, tier: TIER.OPERATIONAL_INTEGRITY });
    }
  });

  test("no Tier 1 Phase 8 module statically imports a Tier 2 one", () => {
    const offenders = [];
    const tier1 = [
      "cost/phi.js",
      "cost/cDirect.js",
      "cost/cRisk.js",
      "cost/cLifecycle.js",
      "cost/cPolicy.js",
      "cost/cDelay.js",
      "cost/signDiscipline.js",
      "plan/planBuilder.js",
      "plan/timeline.js",
      "plan/column.js",
      "plan/columnBuilder.js",
    ];
    const tier2 = ["cOpportunity", "cDefer", "cChurn", "vTerminal", "capacityPricingClient", "forecastClient", "insertion"];

    for (const relative of tier1) {
      const source = fs.readFileSync(path.join(BACKEND_ROOT, "src", "engine", relative), "utf8");
      for (const match of source.matchAll(/require\("([^"]+)"\)/g)) {
        if (tier2.some((name) => match[1].endsWith(`/${name}`))) {
          offenders.push(`${relative} requires ${match[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("Φ obtains its Tier 2 terms by registration, which is the compliant pattern", () => {
    const phi = require("../../src/engine/cost/phi");
    expect(typeof phi.registerTerm).toBe("function");
    expect(Object.keys(phi.REGISTRABLE_TERMS).sort()).toEqual(["C_churn", "C_opportunity"]);
    for (const term of Object.keys(phi.REGISTRABLE_TERMS)) {
      expect(typeof phi.REGISTRABLE_TERMS[term].killSwitch).toBe("string");
      expect(typeof phi.REGISTRABLE_TERMS[term].degradesTo).toBe("string");
    }
  });

  test("every Phase 8 Tier 2 module names the kill switch §1.8 gives its mechanism", () => {
    const byModule = new Map();
    for (const mechanism of MECHANISMS) {
      for (const modulePath of mechanism.modules) byModule.set(modulePath, mechanism.killSwitch);
    }
    expect(byModule.get("src/engine/cost/cOpportunity.js")).toBe("opportunity_cost_term");
    expect(byModule.get("src/engine/cost/cDefer.js")).toBe("deferral");
    expect(byModule.get("src/engine/cost/cChurn.js")).toBe("churn_pricing");
    expect(byModule.get("src/engine/plan/insertion.js")).toBe("chaining");
  });
});

describe("T6 — the Phase 8 decision path reads no clock and no random source", () => {
  const modules = [
    ...fs.readdirSync(path.join(BACKEND_ROOT, "src", "engine", "cost")).map((name) => `cost/${name}`),
    ...fs.readdirSync(path.join(BACKEND_ROOT, "src", "engine", "plan")).map((name) => `plan/${name}`),
    ...fs.readdirSync(path.join(BACKEND_ROOT, "src", "engine", "pricing")).map((name) => `pricing/${name}`),
    "routing/cellPairCache.js",
  ].filter((name) => name.endsWith(".js"));

  // `src/engine/pricing/` is outside the T6 build scope Phase 0 declared, so this suite
  // checks it directly rather than relying on the gate. The property is asserted either
  // way; only the enforcement point differs, and Phase 0's scope list is not Phase 8's to
  // edit.
  test.each(modules)("%s reads no wall clock and no unseeded randomness", (relative) => {
    const source = fs.readFileSync(path.join(BACKEND_ROOT, "src", "engine", relative), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/Date\s*\.\s*now\s*\(/);
    expect(code).not.toMatch(/new\s+Date\s*\(/);
    expect(code).not.toMatch(/Math\s*\.\s*random\s*\(/);
  });
});

describe("the two background workers", () => {
  const serviceTimeWorker = require("../../src/workers/serviceTimeModel.worker");
  const capacityPricingWorker = require("../../src/workers/capacityPricing.worker");

  test("the fitter accumulates every cohort level in one pass", () => {
    const accumulated = serviceTimeWorker.accumulate([
      { siteId: "s1", stopType: "DROP", missionClass: "PARCEL", hourOfWeek: 60, durationSeconds: 100 },
      { siteId: "s1", stopType: "DROP", missionClass: "PARCEL", hourOfWeek: 60, durationSeconds: 200 },
    ]);
    expect(accumulated.used).toBe(2);
    expect(accumulated.cohorts.get("stopType=DROP").mean).toBe(150);
    expect(accumulated.cohorts.get("siteId=s1|stopType=DROP|missionClass=PARCEL|hourOfWeek=60").n).toBe(2);
  });

  test("a non-attributable observation is dropped and counted, never coerced", () => {
    const accumulated = serviceTimeWorker.accumulate([
      { stopType: "DROP", durationSeconds: 100, attributable: false },
      { stopType: "DROP", durationSeconds: -5 },
      { stopType: "DROP" },
      { durationSeconds: 100 },
    ]);
    expect(accumulated.used).toBe(0);
    expect(accumulated.dropped).toEqual({
      NOT_ATTRIBUTABLE: 1,
      NEGATIVE_DURATION: 1,
      NO_REALISED_DURATION: 1,
      NO_STOP_TYPE: 1,
    });
  });

  test("the fitter and the reader apply the same shrinkage", async () => {
    const timeline = require("../../src/engine/plan/timeline");
    const observations = Array.from({ length: 10 }, () => ({ stopType: "DROP", durationSeconds: 200 }));
    const fitted = await serviceTimeWorker.fit(
      {},
      {
        observations,
        version: 1,
        parameters: { priorSeconds: { DROP: 100 }, priorCv: 0.5, shrinkageStrength: 10 },
      },
    );
    const row = fitted.rows.find((entry) => entry.level === "stopType");
    // 10 observations against strength 10 → weight 0.5 → (200 + 100) / 2.
    expect(row.shrinkageWeight).toBe(0.5);
    expect(row.meanSeconds).toBe(150);
    expect(timeline.shrink({ n: 10, meanSeconds: 200, sdSeconds: 50 }, { meanSeconds: 100, sdSeconds: 50 }, 10).meanSeconds).toBe(150);
  });

  test("a cohort with one observation inherits its parent's dispersion, not a fabricated zero", async () => {
    const fitted = await serviceTimeWorker.fit(
      {},
      {
        observations: [{ stopType: "DROP", durationSeconds: 200 }],
        version: 1,
        parameters: { priorSeconds: { DROP: 100 }, priorCv: 0.5, shrinkageStrength: 10 },
      },
    );
    expect(fitted.rows[0].sdSeconds).toBeGreaterThan(0);
  });

  test("a stop type with no prior is refused rather than defaulted", async () => {
    const fitted = await serviceTimeWorker.fit(
      {},
      {
        observations: [{ stopType: "INSPECT", durationSeconds: 60 }],
        version: 1,
        parameters: { priorSeconds: { DROP: 100 }, priorCv: 0.5, shrinkageStrength: 10 },
      },
    );
    expect(fitted.ok).toBe(false);
    expect(fitted.problems[0]).toMatch(/no value for stop type "INSPECT"/);
  });

  test("the pricing worker refuses to run while its kill switch is thrown", async () => {
    const result = await capacityPricingWorker.refresh(
      { pricing: require("../../src/engine/pricing/capacityPricingClient") },
      { opportunityCostTermEnabled: false },
    );
    expect(result.skipped).toBe(capacityPricingWorker.SKIPPED.KILL_SWITCH);
    expect(result.snapshot).toBeNull();
  });

  test("the pricing worker takes its Tier 2 client by injection, not by import", () => {
    const source = fs.readFileSync(path.join(BACKEND_ROOT, "src", "workers", "capacityPricing.worker.js"), "utf8");
    expect(source).not.toMatch(/require\("\.\.\/engine\/pricing\//);
    expect(source).toMatch(/deps && deps\.pricing/);
  });

  test("the pricing worker publishes a surface with Ω_terminal derived from it", async () => {
    const pricing = require("../../src/engine/pricing/capacityPricingClient");
    const forecast = require("../../src/engine/pricing/forecastClient");
    const decisionTimeMs = Date.UTC(2026, 7, 4, 12, 0, 0);

    const result = await capacityPricingWorker.refresh(
      { pricing, forecast },
      {
        opportunityCostTermEnabled: true,
        version: 5,
        zoneIds: ["zone-a"],
        fromMs: decisionTimeMs,
        horizonEndMs: decisionTimeMs + 1_800_000,
        valueHorizonSeconds: 1800,
        decisionTimeMs,
        maxChargeAccessGainCu: 0,
        maxSocDeficitGainCu: 0,
        config: { "cost.opportunity.lambda_zone_prior": 0.01 },
        forecastSources: {
          live: {
            version: 9,
            publishedAtMs: decisionTimeMs - 1000,
            zones: {
              "zone-a": {
                arrivalRate: 2,
                projectedSupply: 4,
                responseCurve: [
                  { supply: 0, delayCostCu: 100 },
                  { supply: 10, delayCostCu: 0 },
                ],
              },
            },
          },
          maxAgeSeconds: 300,
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.snapshot.source).toBe(pricing.ESTIMATOR.FORECAST_QUEUEING);
    expect(result.omegaTerminalCu).toBe(0);
    expect(result.snapshot.zones["zone-a"][0].lambdaCuPerSecond).toBe(20);
    expect(forecast.LADDER[0]).toBe("LIVE_FORECAST");
  });

  test("a worker with no client injected refuses rather than improvising", async () => {
    const result = await capacityPricingWorker.refresh({}, { opportunityCostTermEnabled: true });
    expect(result.skipped).toBe(capacityPricingWorker.SKIPPED.NO_CLIENT);
    expect(result.problems[0]).toMatch(/§1.8 rule 2/);
  });
});

describe("the phase boundary", () => {
  const engineRoot = path.join(BACKEND_ROOT, "src", "engine");

  // `candidates/` is Phase 9's own directory and `solve/`/`intake/` are Phase 10's —
  // see `candidatesSchema.test.js` and `roundSchema.test.js` for their presence
  // assertions, and `phase0Scaffold.test.js`'s engine-tree ownership walk for the
  // boundary this test used to state narrowly here.

  // Phase 0 scaffolded every future phase's directory, so their *existence* proves
  // nothing; what the boundary asserts is that none of them holds runtime code yet.
  // Phase 11 has now filled `observability/` — see `observabilitySchema.test.js` for its
  // module-presence assertions. Phase 12 fills `degraded/`, `failure/`, and `map/`;
  // §17.4's ladder fills `fairness/`.
  // Phase 12 has now filled `degraded/`, `failure/`, and `map/` — see
  // `degradedSchema.test.js` for its module-presence assertions. §17.4's ladder fills
  // `fairness/`, which is still the boundary this test states.
  // REMEDIAL PHASE T1-04. This asserted `fairness/` was **empty**, which was the boundary
  // while §17.4's ladder had no owning phase. The remedial phase has run and the three
  // modules `guards/tierAssertions.js` names for T1-04 are on disk, so the boundary moves
  // rather than disappearing: `fairness/` now holds **exactly** those three and nothing
  // else. `dutyCycle.js` (§17.2, T2-10) and `repositioning.js` (§17.3) are Tier 2 and
  // Phase 16's — an assertion that only checked the three were *present* would let either
  // arrive here unnoticed, which is the drift the empty-directory assertion prevented.
  test("fairness/ holds exactly T1-04's three §17.4 modules — no Tier 2 fairness module yet", () => {
    expect(
      fs.readdirSync(path.join(engineRoot, "fairness")).filter((name) => name.endsWith(".js")).sort(),
    ).toEqual(["agentStarvation.js", "ladder.js", "operatorCapacity.js"]);
  });

  test("no Phase 16 multi-Leg column or consolidation module exists", () => {
    const planFiles = fs.readdirSync(path.join(engineRoot, "plan")).filter((name) => name.endsWith(".js"));
    expect(planFiles.sort()).toEqual(
      ["column.js", "columnBuilder.js", "insertion.js", "planBuilder.js", "timeline.js"].sort(),
    );
  });

  // PHASE 15 — this test asserted the opposite until the cutover. §1.3 prohibits min-max
  // normalisation outright, and `costEvaluator.service.js` was the module that did it;
  // Phase 8 replaced it and Phase 15 removes it from the build. The assertion flips from
  // "annotated, not deleted" to "deleted", which is the completion criterion's own wording
  // ("removed from the build, not merely bypassed").
  test("the superseded legacy cost evaluator is deleted, not merely bypassed", () => {
    expect(fs.existsSync(path.join(BACKEND_ROOT, "src", "services", "costEvaluator.service.js"))).toBe(false);
    expect(() => require("../../src/services/costEvaluator.service")).toThrow(/Cannot find module/);

    // And the route helpers that measured a mission's distance *after* the robot was
    // chosen went with it (§13.1: the plan is built before the choice, from the same
    // artefact the cost model scores).
    const taskService = fs.readFileSync(path.join(BACKEND_ROOT, "src", "services", "task.service.js"), "utf8");
    const code = taskService.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/function getRoutesWithDistance\(/);
    expect(code).not.toMatch(/function pathDistanceMeters\(/);
  });

  test("no engine module imports the superseded legacy cost evaluator", () => {
    const offenders = [];
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js") && /require\([^)]*costEvaluator\.service/.test(fs.readFileSync(full, "utf8"))) {
          offenders.push(path.relative(BACKEND_ROOT, full));
        }
      }
    };
    walk(engineRoot);
    expect(offenders).toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * Phase 8 remediation — §13.2's NULL-bearing cohort key.
 *
 * Found by `tools/verify/phase8LiveDatabase.js` against PostgreSQL 18.3: the
 * five-part unique key was NULLS DISTINCT, so the *broad* cohorts §13.2's ladder
 * falls back to were unconstrained and a duplicate was accepted. `loadVersion()`
 * then returned whichever row the database listed last, making a pinned model
 * version yield different dwell times on two loads — a §9.6 replay defect.
 *
 * The same class of defect, and the same repair, that Phase 6 applied to
 * `RejectionAggregate`. Closed at the storage layer by migration
 * 20260818090000 and, independently, in the reader below.
 * ══════════════════════════════════════════════════════════════════════════ */

describe("Phase 8 remediation — the cohort key binds its NULL-bearing rows", () => {
  const NULLS_MIGRATION_PATH = path.join(
    BACKEND_ROOT,
    "prisma",
    "migrations",
    "20260818090000_service_time_model_nulls_not_distinct",
    "migration.sql",
  );
  const nullsMigration = fs.readFileSync(NULLS_MIGRATION_PATH, "utf8");

  test("the remediation migration redeclares the key NULLS NOT DISTINCT over the identical columns", () => {
    expect(normalise(nullsMigration)).toContain(
      normalise(`CREATE UNIQUE INDEX "ServiceTimeModel_version_siteId_stopType_missionClass_hourO_key"
        ON "ServiceTimeModel" ("version", "siteId", "stopType", "missionClass", "hourOfWeek")
        NULLS NOT DISTINCT`),
    );
  });

  test("it drops no column and rewrites no table — the index is replaced in place", () => {
    const statements = nullsMigration.replace(/^--.*$/gm, "");
    expect(statements).not.toMatch(/DROP TABLE|DROP COLUMN|RENAME|ALTER COLUMN|TRUNCATE/);
    // The only DELETE is the duplicate reduction a tightened unique key requires, and it
    // touches nothing outside a group of size > 1.
    expect(statements).toMatch(/ROW_NUMBER\(\) OVER \(\s*PARTITION BY/);
    expect(statements).toMatch(/ranked\."ordinal" > 1|ranked\.ordinal > 1/);
  });

  test("the duplicate reduction is deterministic, and keeps the best-supported fit (§13.2)", () => {
    // sampleCount is §13.2's shrinkage weight, so the largest is the least-shrunk
    // estimate; `id` ends the order so the outcome cannot depend on physical row order.
    expect(nullsMigration).toMatch(/ORDER BY "sampleCount" DESC, "fittedAt" DESC, "id" ASC/);
  });

  test("the schema records that the clause lives only in the migration, and why", () => {
    expect(schema).toMatch(/This index is `NULLS NOT DISTINCT` in the database, which Prisma cannot express/);
    expect(schema).toContain("20260818090000_service_time_model_nulls_not_distinct");
  });

  test("loadVersion refuses a version whose cohort key is claimed twice, rather than picking one", async () => {
    const worker = require("../../src/workers/serviceTimeModel.worker");
    const broad = (id, sampleCount) => ({
      id,
      version: 3,
      siteId: null,
      stopType: "DROP",
      missionClass: null,
      hourOfWeek: null,
      meanSeconds: sampleCount === 40 ? 120 : 600,
      sdSeconds: 10,
      sampleCount,
    });
    // Two rows for one broad cohort — the pair NULLS DISTINCT used to permit.
    const prisma = {
      serviceTimeModel: { findMany: async () => [broad("row-a", 40), broad("row-b", 39)] },
    };
    await expect(worker.loadVersion({ prisma }, 3)).rejects.toThrow(/two rows for cohort/);
    await expect(worker.loadVersion({ prisma }, 3)).rejects.toThrow(/§9.6 requirement 6/);
  });

  test("loadVersion reads in a total, deterministic order so the map cannot depend on row order", async () => {
    const worker = require("../../src/workers/serviceTimeModel.worker");
    let observedArgs = null;
    const prisma = {
      serviceTimeModel: {
        findMany: async (args) => {
          observedArgs = args;
          return [
            { id: "r1", version: 3, siteId: null, stopType: "DROP", missionClass: null, hourOfWeek: null, meanSeconds: 120, sdSeconds: 10, sampleCount: 40 },
          ];
        },
      },
    };
    const models = await worker.loadVersion({ prisma }, 3);
    expect(observedArgs.orderBy).toEqual([{ sampleCount: "desc" }, { fittedAt: "desc" }, { id: "asc" }]);
    expect(models["stopType=DROP"]).toEqual({ n: 40, meanSeconds: 120, sdSeconds: 10 });
  });
});

"use strict";

/**
 * Engine lane — Phase 7: the migration, the register additions, the cache keys, and the
 * tier mapping.
 *
 * The migration is cross-checked against Prisma's own generated SQL, so the hand-written
 * file and `schema.prisma` cannot silently disagree. What Prisma cannot express — the
 * five CHECK constraints — is asserted as written, and its *absence* from the generated
 * output is asserted too, so a reviewer can tell a hand-written addition from an echo.
 * The same discipline Phases 2, 4, 5, and 6 applied to theirs.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const service = require("../../src/engine/config/service");
const derived = require("../../src/engine/config/derived");
const { tierOf, TIER, MECHANISMS } = require("../../src/engine/guards/tierAssertions");
const cache = require("../../src/engine/routing/chargerReachabilityCache");
const packing = require("../../src/engine/payload/packing");

const BACKEND_ROOT = path.join(__dirname, "..", "..");
const MIGRATION_DIRECTORY = "20260804180000_energy_and_payload_models";
const MIGRATION = fs.readFileSync(
  path.join(BACKEND_ROOT, "prisma", "migrations", MIGRATION_DIRECTORY, "migration.sql"),
  "utf8",
);
const SCHEMA = fs.readFileSync(path.join(BACKEND_ROOT, "prisma", "schema.prisma"), "utf8");

const TABLES = [
  "EnergyModelParams",
  "BatteryState",
  "Charger",
  "ChargerReservation",
  "ChargerAvailabilityProjection",
  "PackingResultCache",
];

let generated = null;
function generatedSql() {
  if (generated === null) {
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
}

function block(sql, header) {
  const start = sql.indexOf(header);
  if (start === -1) return null;
  const end = sql.indexOf("\n);", start);
  return sql.slice(start, end + 3);
}

/** Collapse whitespace so formatting differences do not read as drift. */
function normalise(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

/* ═══════════════════════════════════════════════════════════════════════════
   The six tables
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the Phase 7 migration", () => {
  test.each(TABLES.map((table) => [table]))("%s matches Prisma's own generated SQL for the model", (table) => {
    const header = `CREATE TABLE "${table}" (`;
    const fromMigration = block(MIGRATION, header);
    const fromPrisma = block(generatedSql(), header);

    expect(fromMigration).not.toBeNull();
    expect(fromPrisma).not.toBeNull();
    expect(normalise(fromMigration)).toBe(normalise(fromPrisma));
  });

  test.each(TABLES.map((table) => [table]))("%s is declared in schema.prisma", (table) => {
    expect(SCHEMA).toMatch(new RegExp(`model ${table} \\{`));
  });

  test("every index and foreign key Prisma generates for these tables is in the migration", () => {
    const wanted = generatedSql()
      .split("\n")
      .filter((line) => /^(CREATE (UNIQUE )?INDEX|ALTER TABLE)/.test(line))
      .filter((line) => TABLES.some((table) => line.includes(`"${table}"`)));

    expect(wanted.length).toBeGreaterThan(0);
    for (const line of wanted) expect(normalise(MIGRATION)).toContain(normalise(line));
  });

  test("it is additive only — nothing is dropped, renamed, or re-typed", () => {
    // Statements only. The header comment names `DROP TABLE` as the rollback, and a
    // scan that could not tell prose from SQL would either fail on that or force the
    // rollback to go undocumented.
    const statements = MIGRATION.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");

    expect(statements).not.toMatch(/DROP TABLE/i);
    expect(statements).not.toMatch(/DROP COLUMN/i);
    expect(statements).not.toMatch(/RENAME/i);
    expect(statements).not.toMatch(/ALTER COLUMN/i);
    // Every ALTER TABLE is an ADD, and every one names a Phase 7 table. Split on the
    // statement terminator rather than on newlines: the hand-written CHECK constraints
    // are multi-line, and a line-wise scan would read their first line as a bare ALTER.
    const alters = statements
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.startsWith("ALTER TABLE"));

    expect(alters.length).toBeGreaterThan(0);
    for (const statement of alters) {
      expect(statement).toMatch(/ADD CONSTRAINT/);
      expect(TABLES.some((table) => statement.includes(`"${table}"`))).toBe(true);
    }
  });

  test("the projection table carries no updatedAt — it is insert-only and immutable", () => {
    const model = /model ChargerAvailabilityProjection \{[\s\S]*?\n\}/.exec(SCHEMA)[0];
    expect(model).not.toMatch(/updatedAt/);
    expect(model).toMatch(/version\s+Int\s+@unique/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The hand-written CHECK constraints
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the five CHECK constraints Prisma cannot express", () => {
  const CONSTRAINTS = [
    ["BatteryState_soh_fraction", /"soh" IS NULL OR \("soh" > 0 AND "soh" <= 1\)/],
    ["BatteryState_kappa_positive", /"kappa" > 0/],
    ["ChargerReservation_target_soc_fraction", /"targetSoc" IS NULL OR \("targetSoc" >= 0 AND "targetSoc" <= 1\)/],
    ["ChargerReservation_window_ordered", /"reservedUntil" > "reservedFrom"/],
    ["PackingResultCache_verdict_decided", /"verdict" IN \('FEASIBLE', 'INFEASIBLE'\)/],
  ];

  test.each(CONSTRAINTS)("%s is present in the migration", (name, pattern) => {
    expect(MIGRATION).toContain(name);
    expect(MIGRATION).toMatch(pattern);
  });

  test.each(CONSTRAINTS.map(([name]) => [name]))("%s is absent from Prisma's generated output", (name) => {
    // Asserted so a reviewer can tell a hand-written addition from an echo of the
    // schema. Prisma has no CHECK-constraint syntax; if one of these ever appears in the
    // generated SQL, it came from somewhere this test does not know about.
    expect(generatedSql()).not.toContain(name);
  });

  test("the packing memo may hold only a decided verdict", () => {
    // §15.3's third outcome is deliberately not storable: "the budget may be larger next
    // time", and memoising an indecision would make it permanent for the entry's life.
    expect(MIGRATION).toMatch(/PackingResultCache_verdict_decided[\s\S]*?FEASIBLE', 'INFEASIBLE'/);
    expect(MIGRATION).not.toMatch(/verdict" IN \([^)]*BUDGET_EXHAUSTED/);
    expect(Object.values(packing.VERDICT)).toContain("BUDGET_EXHAUSTED");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   The register additions
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the Phase 7 parameter register additions", () => {
  const { entries } = service.loadRegister({ reload: true });

  const ADDED = [
    "energy.kappa_ewma_alpha",
    "energy.kappa_bounds",
    "energy.model_residual_cv",
    "energy.variance_inflation",
    "energy.charge_curve_integration_steps",
    "energy.operational_reserve_wh",
    "payload.packing_node_budget",
    "payload.packing_cache_ttl",
    "payload.mass_discrepancy_tolerance_kg",
    "route.charger_reachability_k",
    "route.charger_reachability_min_hit_rate",
    "route.intra_cell_offset_m",
  ];

  test.each(ADDED.map((name) => [name]))("%s is registered", (name) => {
    expect(entries.has(name)).toBe(true);
  });

  test("every parameter §14 and §15 name is registered, not only the ones added here", () => {
    for (const name of [
      "energy.event_budget_per_fleet_year",
      "energy.shortfall_probability",
      "energy.contingency_quantile",
      "energy.reserve_floor_wh",
      "energy.charger_availability_margin",
      "energy.charger_projection_max_age",
      "energy.target_soc_max_age",
      "energy.target_soc_fallback",
      "energy.deviation_tolerance",
      "energy.uncalibrated_reserve_factor",
      "energy.max_combined_conservatism",
      "payload.safety_factor",
      "payload.packing_efficiency",
    ]) {
      expect({ name, registered: entries.has(name) }).toEqual({ name, registered: true });
    }
  });

  test("the Safety-class additions name Safety as their owner", () => {
    for (const name of ["energy.kappa_bounds", "energy.model_residual_cv", "payload.mass_discrepancy_tolerance_kg"]) {
      expect(entries.get(name).changeClass).toBe("SAFETY");
      expect(entries.get(name).owner).toBe("Safety");
    }
  });

  test("energy.model_residual_cv ships null rather than with a plausible number", () => {
    // A fabricated dispersion would produce three fabricated tier probabilities and F34
    // would admit or reject on them. Null denies loudly instead.
    const entry = entries.get("energy.model_residual_cv");
    expect(entry.default).toBeNull();
    expect(entry.calibrationStatus).toBe("UNCALIBRATED");
    expect(entry.awaits).toMatch(/residual variance/);
  });

  describe("the variance inflations are not conservatism factors", () => {
    test("they declare no conservatism block, so they stay out of §14.3's product", () => {
      // "a product across incommensurable quantities is not a meaningful number": these
      // multiply a variance in Wh², not a reserve in Wh.
      expect(entries.get("energy.variance_inflation").conservatism).toBeUndefined();
    });

    test("adding them changed neither published conservatism product", () => {
      const snapshot = service.defaultSnapshot();
      const evidence = derived.deriveCombinedConservatism([...entries.values()], {
        get: (name) => snapshot.resolve(name),
      });
      expect(Object.keys(evidence.factors.nominal)).not.toContain("energy.variance_inflation");
      expect(Object.keys(evidence.factors.degradedOnly)).not.toContain("energy.variance_inflation");
    });
  });

  test("α[tier] and the contingency quantile remain derived, and cannot be hand-set", () => {
    expect(derived.DERIVED_PARAMETERS).toEqual(
      expect.arrayContaining(["energy.shortfall_probability", "energy.contingency_quantile"]),
    );
    expect(
      derived.rejectHandEnteredDerived([{ name: "energy.shortfall_probability", level: "region", key: "r1" }]),
    ).toHaveLength(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   Redis keys and the tier mapping
   ═══════════════════════════════════════════════════════════════════════════ */

describe("the Redis key families the plan names", () => {
  test("the charger-reachability key carries the projection version last", () => {
    const built = cache.key({ cellId: "cell-a", profileKey: "p", timeBucket: 7, projectionVersion: 41 });
    expect(built.ok).toBe(true);
    expect(built.key).toBe("engine:charger:reach:cell-a:p:7:41");
    expect(cache.assertVersionInKey(built.key, 41).ok).toBe(true);
    expect(cache.assertVersionInKey(built.key, 42).ok).toBe(false);
  });

  test("a key cannot be built without the projection version", () => {
    const built = cache.key({ cellId: "cell-a", profileKey: "p", timeBucket: 7 });
    expect(built.ok).toBe(false);
    expect(built.reason).toMatch(/charger_availability_version/);
  });

  test("the projection mirror key is the one the plan names", () => {
    expect(cache.projectionKey(41)).toBe("engine:charger:proj:41");
  });

  test("the packing memo key is the one the plan names", () => {
    expect(packing.CACHE_KEY_PREFIX).toBe("engine:pack");
  });
});

describe("the tier mapping", () => {
  test("every energy and payload module is Tier 0", () => {
    for (const module of [
      "src/engine/energy/consumption.js",
      "src/engine/energy/usable.js",
      "src/engine/energy/reserves.js",
      "src/engine/energy/tiers.js",
      "src/engine/energy/eReturn.js",
      "src/engine/energy/wear.js",
      "src/engine/energy/chargeCurve.js",
      "src/engine/energy/midMission.js",
      "src/engine/energy/chargingSchedulerClient.js",
      "src/engine/payload/spec.js",
      "src/engine/payload/container.js",
      "src/engine/payload/packing.js",
      "src/engine/payload/loadState.js",
      "src/engine/payload/custodyEvidence.js",
      "src/engine/routing/chargerReachabilityCache.js",
    ]) {
      expect({ module, tier: tierOf(module) }).toEqual({ module, tier: TIER.SAFETY_CORE });
    }
  });

  test("the rest of src/engine/routing/ is not Tier 0 — only the cache §20.3 item 3 names is", () => {
    expect(tierOf("src/engine/routing/client.js")).toBe(TIER.OPERATIONAL_INTEGRITY);
  });

  test("T0-03's inventory now names every module of the §14.5 mechanism", () => {
    const mechanism = MECHANISMS.find((row) => row.id === "T0-03");
    for (const module of [
      "src/engine/energy/chargeCurve.js",
      "src/engine/energy/midMission.js",
      "src/engine/energy/chargingSchedulerClient.js",
    ]) {
      expect(mechanism.modules).toContain(module);
    }
  });

  test("T0-04's inventory names every payload module", () => {
    const mechanism = MECHANISMS.find((row) => row.id === "T0-04");
    for (const module of [
      "src/engine/payload/spec.js",
      "src/engine/payload/container.js",
      "src/engine/payload/packing.js",
      "src/engine/payload/loadState.js",
    ]) {
      expect(mechanism.modules).toContain(module);
    }
  });
});

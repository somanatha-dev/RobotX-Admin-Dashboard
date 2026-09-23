"use strict";

/**
 * Engine lane — the **V1 DEMONSTRATION** configuration (§22.4).
 *
 * These tests exist to prove seven things about the demonstration configuration, and to
 * fail on the day any of them stops being true:
 *
 *   1. all thirteen entries are present in it;
 *   2. each is `PROVISIONAL` — not `UNCALIBRATED`, and not, on any account, `DERIVED`;
 *   3. each retains the `awaits` text it had before the demonstration bound it;
 *   4. each carries `awaitsBy = 2026-09-26`;
 *   5. none is `DERIVED` — the status that would claim a measured source that does not exist;
 *   6. **neither Safety-class parameter was silently bound**;
 *   7. the published version loads through the ordinary pinned-snapshot path.
 *
 * ── Why (3) is asserted against a literal and not against the register ──────
 * The obvious way to test "the awaits text is unchanged" is to compare the entry's `awaits`
 * against the register's `awaits`, which is a tautology: it passes whatever the register
 * says, including after somebody rewrites the text to describe the placeholder instead of
 * the measurement. So the expected sentences are written out here, once. If a future edit
 * changes one, this file fails and the change has to be deliberate — which is the whole
 * point of the `awaits` field: it is the record of what is still owed.
 */

const service = require("../../src/engine/config/service");
const calibration = require("../../src/engine/config/calibrationStatus");
const demonstration = require("../../../Backend/tools/config/v1DemonstrationConfig");
const publisher = require("../../../Backend/tools/config/publishV1Demonstration");
const pipeline = require("../../src/workers/coordinatorPipeline");

const AWAITS_BY = "2026-09-26";

/** The two Safety-class (Tier 0) values the demonstration may never bind (§22.4, A6a). */
const SAFETY_PARAMETERS = Object.freeze(["energy.model_residual_cv", "energy.reserve_floor_wh"]);

/**
 * The `awaits` sentence each of the thirteen carried *before* the demonstration, written out
 * so that rewriting one in the register fails here rather than passing silently.
 */
const AWAITS_TEXT = Object.freeze({
  "plan.service_time_prior":
    "the first fitted ServiceTimeModel cohorts; until then every stop prices against this prior and reports that it did",
  "cost.energy.cu_per_wh": "the energy tariff; derived, not chosen",
  "cost.wear.cu_per_metre": "maintenance cost over rated distance per class",
  "cost.failure.cu": "measured recovery expense by mission class and custody state",
  "cost.staleness.cu_per_second_age": "measured relationship between observation age and realised error",
  "cost.energy_consequence":
    "measured cost of a charge diversion, a recovery mission, and an in-service immobilisation",
  "cost.sla.cu_per_second_late": "contract terms and remediation cost per tenant",
  "cost.sla.breach_penalty": "contractual breach penalties",
  "lifecycle.cu_per_actuator_cycle": "component replacement cost divided by rated cycle count, per actuator, per class",
  "lifecycle.cu_per_braking_event": "pad and tyre replacement cost divided by rated braking events, per class",
  "lifecycle.cu_per_gradient_metre":
    "tyre and transmission replacement cost over rated distance under gradient, per class",
  "lifecycle.cu_per_thermal_stress_second":
    "measured life reduction per second of thermal stress at reference conditions, per class",
  "cost.battery.cu_per_equivalent_cycle": "pack replacement cost and rated cycle count per class",
});

const registerEntry = (name) => service.loadRegister().entries.get(name);

/**
 * An in-memory stand-in for the config tables, shaped like the one `configService.test.js`
 * uses. Deliberately not the shared `mockPrisma` helper — that belongs to the legacy lane.
 */
function createConfigStore() {
  const versions = [];
  const bindings = [];
  let pin = null;
  let identity = 0;

  const client = {
    configVersion: {
      create: jest.fn(async ({ data }) => {
        identity += 1;
        const row = { id: `cv-${identity}`, publishedAt: new Date("2026-09-19T09:00:00Z"), ...data };
        versions.push(row);
        return row;
      }),
      findFirst: jest.fn(async () => (versions.length === 0 ? null : [...versions].sort((a, b) => b.version - a.version)[0])),
      findUnique: jest.fn(async ({ where }) => versions.find((row) => row.version === where.version) || null),
      findMany: jest.fn(async () => [...versions].sort((a, b) => b.version - a.version)),
    },
    configScopeBinding: {
      createMany: jest.fn(async ({ data }) => {
        bindings.push(...data);
        return { count: data.length };
      }),
    },
    configActiveVersion: {
      upsert: jest.fn(async ({ create, update }) => {
        pin = pin ? { ...pin, ...update } : { ...create };
        return pin;
      }),
      findUnique: jest.fn(async () => pin),
    },
    $transaction: jest.fn(async (callback) => callback(client)),
  };

  return { client, versions, bindings };
}

describe("the demonstration binds exactly thirteen ranking-only parameters", () => {
  test("thirteen, and they are the fifteen REGISTER_UNRESOLVED inputs less the two Safety ones", () => {
    const declared = pipeline.SOLVE_PATH_REGISTER_INPUTS.map((row) => row.name);
    const expected = declared
      .filter((name) => registerEntry(name).changeClass !== calibration.TIER_ZERO_CHANGE_CLASS)
      .sort();

    expect(demonstration.PARAMETER_NAMES).toHaveLength(13);
    expect(demonstration.PARAMETER_NAMES).toEqual(expected);
    // The derivation, not just the list: fifteen declared, two Safety-class, thirteen left.
    expect(declared).toHaveLength(15);
    expect(declared.filter((name) => registerEntry(name).changeClass === "SAFETY").sort()).toEqual(
      [...SAFETY_PARAMETERS].sort(),
    );
  });

  test("every one of the thirteen is a real register entry, bound at a scope it declares", () => {
    for (const binding of demonstration.bindings()) {
      const entry = registerEntry(binding.name);
      expect(entry).toBeTruthy();
      expect(entry.scopes).toContain(binding.level);
      expect(binding.value === null || binding.value === undefined).toBe(false);
    }
    expect(demonstration.bindings()).toHaveLength(13);
  });

  test("every bound value passes the register's own type and range check", () => {
    const { result } = service.validateCandidate({ bindings: demonstration.bindings() });
    const perParameter = result.findings.filter(
      (item) => item.severity === "BLOCKING" && demonstration.PARAMETER_NAMES.some((name) => item.message.includes(name)),
    );
    expect(perParameter).toEqual([]);
  });

  test("each carries a stated basis — a demonstration value nobody can trace is not defensible", () => {
    for (const row of demonstration.PARAMETERS) {
      expect(typeof row.basis).toBe("string");
      expect(row.basis.length).toBeGreaterThan(40);
    }
  });
});

describe("calibration discipline — PROVISIONAL, with the awaits text and a date (§22.4)", () => {
  test.each(Object.keys(AWAITS_TEXT))("%s is PROVISIONAL", (name) => {
    expect(registerEntry(name).calibrationStatus).toBe(calibration.CALIBRATION_STATUS.PROVISIONAL);
  });

  test.each(Object.keys(AWAITS_TEXT))("%s keeps the awaits text it had before", (name) => {
    expect(registerEntry(name).awaits).toBe(AWAITS_TEXT[name]);
  });

  test.each(Object.keys(AWAITS_TEXT))("%s names 2026-09-26 as the date it is re-derived by", (name) => {
    expect(registerEntry(name).awaitsBy).toBe(AWAITS_BY);
  });

  test("not one of the thirteen is DERIVED", () => {
    // DERIVED is a *claim* — "from a stated accounting or measured source" — where
    // PROVISIONAL is an admission. Nothing here was measured, so the claim would be false.
    for (const name of demonstration.PARAMETER_NAMES) {
      expect(registerEntry(name).calibrationStatus).not.toBe(calibration.CALIBRATION_STATUS.DERIVED);
    }
  });

  test("§22.4's per-entry check is satisfied by all thirteen, with no launch-gate finding", () => {
    for (const name of demonstration.PARAMETER_NAMES) {
      const result = calibration.checkEntry(registerEntry(name));
      expect({ name, blocking: result.blocking, launchGate: result.launchGate }).toEqual({
        name,
        blocking: [],
        launchGate: [],
      });
    }
  });

  test("none of the thirteen is Tier 0 — a Safety-class entry may not be PROVISIONAL at all", () => {
    for (const name of demonstration.PARAMETER_NAMES) {
      expect(calibration.isTierZeroParameter(registerEntry(name))).toBe(false);
    }
  });
});

describe("neither Safety parameter was silently bound", () => {
  test.each(SAFETY_PARAMETERS)("%s is absent from the demonstration binding set", (name) => {
    expect(demonstration.PARAMETER_NAMES).not.toContain(name);
    expect(demonstration.bindings().map((row) => row.name)).not.toContain(name);
    expect(publisher.publishRequest({ accommodate: true }).bindings.map((row) => row.name)).not.toContain(name);
  });

  test.each(SAFETY_PARAMETERS)("%s is still Safety-class and still unresolved", (name) => {
    const entry = registerEntry(name);
    expect(entry.changeClass).toBe(calibration.TIER_ZERO_CHANGE_CLASS);
    expect(entry.calibrationStatus).not.toBe(calibration.CALIBRATION_STATUS.DERIVED);
    expect(entry.default === null || entry.default === undefined).toBe(true);
  });

  test("cutover.engine_enabled is not bound either — that is the owner's act (S-5)", () => {
    const names = publisher.publishRequest({ accommodate: true }).bindings.map((row) => row.name);
    expect(names).not.toContain("cutover.engine_enabled");
  });

  test("adding a refused parameter to the binding set throws rather than publishing", () => {
    for (const name of Object.keys(demonstration.REFUSED)) {
      expect(() =>
        demonstration.assertNoSafetyParameter([...demonstration.bindings(), { level: "global", key: "", name, value: 1 }]),
      ).toThrow(new RegExp(name.replace(/\./g, "\\.")));
    }
  });
});

describe("the published version loads through the ordinary pinned-snapshot path", () => {
  /**
   * Published with the same labelled V9/S2 accommodation the disposable-cluster run takes.
   * Without it a *first* publish is refused outright — which the next describe block asserts
   * on its own, so it is not being quietly assumed away here.
   */
  async function publishAndPin() {
    const store = createConfigStore();
    const published = await publisher.publishDemonstration(store.client, { accommodate: true });
    return { store, published };
  }

  test("all thirteen resolve from the pinned snapshot, at the published values", async () => {
    const { store, published } = await publishAndPin();
    expect(published.version).toBe(1);

    const snapshot = await service.loadPinnedSnapshot({ prisma: store.client, kv: null });
    expect(snapshot.version).toBe(1);
    expect(snapshot.signature).toMatch(/^[0-9a-f]{64}$/);

    for (const row of demonstration.PARAMETERS) {
      expect({ name: row.name, value: snapshot.resolve(row.name, {}) }).toEqual({ name: row.name, value: row.value });
    }
  });

  test("the version is marked a demonstration and disclaims production calibration", async () => {
    const { store } = await publishAndPin();
    const versions = await service.listVersions(store.client, {});
    const published = versions[0];
    expect(published.note).toMatch(/V1 DEMONSTRATION CONFIGURATION/);
    expect(published.note).toMatch(/NOT PRODUCTION CALIBRATION/);
    // The two exclusions are stated on the row itself, not only in a runbook.
    expect(published.note).toMatch(/energy\.model_residual_cv/);
    expect(published.note).toMatch(/cutover\.engine_enabled is NOT bound/);
  });

  test("the two Safety parameters still resolve to nothing on the pinned snapshot", async () => {
    const { store } = await publishAndPin();
    const snapshot = await service.loadPinnedSnapshot({ prisma: store.client, kv: null });
    for (const name of SAFETY_PARAMETERS) {
      const value = snapshot.resolve(name, {});
      expect({ name, resolved: value === null || value === undefined }).toEqual({ name, resolved: true });
    }
  });

  test("the probe falls from 15 REGISTER_UNRESOLVED to exactly the two Safety ones", async () => {
    const { store } = await publishAndPin();
    const snapshot = await service.loadPinnedSnapshot({ prisma: store.client, kv: null });
    const context = (pinned) => ({
      snapshot: pinned,
      prisma: {},
      kv: {},
      runSerializable: async () => {},
      selectForUpdate: async () => {},
      signingKey: "test-key",
      expansionWallClockBudgetMs: 250,
      omegaTerminalCu: 0,
      slaClass: null,
    });

    const before = pipeline.requirements(context(service.defaultSnapshot()));
    const after = pipeline.requirements(context(snapshot));

    expect(before.byClass.REGISTER_UNRESOLVED).toBe(15);
    expect(after.byClass.REGISTER_UNRESOLVED).toBe(2);
    expect(after.missing.filter((row) => row.class === "REGISTER_UNRESOLVED").map((row) => row.input).sort()).toEqual(
      [...SAFETY_PARAMETERS].sort(),
    );
    expect(before.missing.length).toBe(26);
    expect(after.missing.length).toBe(13);
  });

  test("publishing these thirteen does NOT make the engine executable", async () => {
    // The claim this test exists to refuse. Routing and the no-producer families are
    // untouched by any of it, and the coordinator still cannot compose.
    const { store } = await publishAndPin();
    const snapshot = await service.loadPinnedSnapshot({ prisma: store.client, kv: null });
    const result = pipeline.requirements({
      snapshot,
      prisma: {},
      kv: {},
      runSerializable: async () => {},
      selectForUpdate: async () => {},
      signingKey: "test-key",
      expansionWallClockBudgetMs: 250,
      omegaTerminalCu: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.byClass.EXTERNAL_ROUTING).toBe(5);
    expect(result.byClass.NO_PRODUCER).toBe(6);
  });
});

describe("no gate was weakened to obtain the publish", () => {
  test("without the labelled accommodation a first publish is still refused, by V9 and S2", async () => {
    const store = createConfigStore();
    await expect(publisher.publishDemonstration(store.client, { accommodate: false })).rejects.toThrow(
      /rejected at publish time/,
    );
    expect(store.versions).toHaveLength(0);
  });

  test("the refusal is V9 and S2 — the two §22.3/§14.3 gates, unmodified", async () => {
    const store = createConfigStore();
    let error = null;
    try {
      await publisher.publishDemonstration(store.client, { accommodate: false });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeTruthy();
    const blocking = error.findings.filter((item) => item.severity === "BLOCKING").map((item) => item.id).sort();
    expect(blocking).toEqual(["S2", "V9"]);
  });

  test("the accommodation is labelled in the version's own note, not hidden", () => {
    const request = publisher.publishRequest({ accommodate: true });
    expect(request.note).toMatch(/LABELLED NON-PRODUCTION ACCOMMODATION/);
    expect(request.note).toMatch(/NEITHER IS A SAFETY DECISION OR A CALIBRATION VALUE/);
    expect(request.bindings.map((row) => row.name)).toContain("route.degraded_reserve_factor");
    // …and it is not one of the thirteen.
    expect(demonstration.PARAMETER_NAMES).not.toContain("route.degraded_reserve_factor");
    expect(request.bindings).toHaveLength(14);
  });

  test("the unaccommodated request carries no approvals and no extra binding", () => {
    const request = publisher.publishRequest({ accommodate: false });
    expect(request.bindings).toHaveLength(13);
    expect(request.approvals).toBeUndefined();
  });

  test("a non-local database URL is refused before any connection is made", () => {
    for (const url of [
      "postgresql://user:pw@ep-cool-name-123456.ap-southeast-1.aws.neon.tech/robotx",
      "postgresql://user@db.internal.example.com:5432/robotx",
    ]) {
      expect(() => publisher.assertLocalDatabase(url)).toThrow(/refusing to publish/);
    }
    expect(publisher.assertLocalDatabase("postgresql://pgverify@127.0.0.1:55433/robotx_demo_cfg")).toBeTruthy();
  });

  test("the Safety-class launch gate still blocks — 13 PROVISIONAL rows did not close it", () => {
    const register = [...service.loadRegister().entries.values()];
    const safetyNotDerived = register.filter(
      (entry) => entry.changeClass === "SAFETY" && entry.calibrationStatus !== "DERIVED",
    );
    // A floor, never an equality: this file must not be the reason a reduction looks approved.
    expect(safetyNotDerived.length).toBeGreaterThan(0);
  });
});

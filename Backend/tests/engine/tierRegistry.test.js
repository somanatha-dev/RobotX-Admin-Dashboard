"use strict";

/**
 * Engine lane — the tier registry and the documents generated from it.
 *
 * `TIERS.md` is prose; `tierAssertions.js` is what the build gate actually reads. If
 * they drift, the document that reviewers trust stops describing the rule that is
 * enforced, which is worse than having no document. These tests bind them together.
 */

const fs = require("fs");
const path = require("path");

const {
  TIER,
  MECHANISMS,
  MODULE_TIERS,
  INVARIANT_TIERS,
  KILL_SWITCH_LADDER,
  KILL_SWITCHES,
  KILL_SWITCHES_OFF_LADDER,
  isOnSupportedLadder,
  mechanismsAtTier,
  tierOf,
} = require("../../src/engine/guards/tierAssertions");

const ENGINE_ROOT = path.join(__dirname, "..", "..", "src", "engine");
const TIERS_DOC = fs.readFileSync(path.join(ENGINE_ROOT, "TIERS.md"), "utf8");

describe("TIERS.md agrees with the registry the gate reads", () => {
  test("every mechanism appears with its id, name and owning modules", () => {
    for (const mechanism of MECHANISMS) {
      expect(TIERS_DOC).toContain(mechanism.id);
      expect(TIERS_DOC).toContain(mechanism.name);
      for (const modulePath of mechanism.modules) {
        expect(TIERS_DOC).toContain(modulePath);
      }
    }
  });

  test("TIERS.md names no mechanism the registry does not define", () => {
    const documented = new Set(TIERS_DOC.match(/\bT[012]-\d{2}\b/g) || []);
    const defined = new Set(MECHANISMS.map((m) => m.id));
    for (const id of documented) {
      expect(defined.has(id)).toBe(true);
    }
    expect(documented.size).toBe(defined.size);
  });

  test("every module tier assignment is documented", () => {
    for (const [prefix] of MODULE_TIERS) {
      expect(TIERS_DOC).toContain(prefix);
    }
  });

  test("every kill switch and every invariant is documented", () => {
    for (const switchName of KILL_SWITCHES) expect(TIERS_DOC).toContain(switchName);
    for (const invariant of Object.keys(INVARIANT_TIERS)) expect(TIERS_DOC).toContain(invariant);
  });

  test("the recorded §22.5 discrepancy is stated, not silently absorbed", () => {
    expect(TIERS_DOC).toMatch(/[Dd]iscrepancy/);
    expect(TIERS_DOC).toContain("off ladder");
    for (const switchName of KILL_SWITCHES_OFF_LADDER) {
      expect(TIERS_DOC).toContain(switchName);
    }
  });
});

describe("the §1.8 tier partition", () => {
  test("carries the mechanism counts §1.8 states", () => {
    // §1.8 lists eleven Tier 0 bullets, seven Tier 1 bullets, and twelve Tier 2
    // mechanisms. Cross-region candidacy is carried as a thirteenth Tier 2 entry
    // because §22.5 gives it a switch of its own.
    expect(mechanismsAtTier(TIER.SAFETY_CORE)).toHaveLength(11);
    expect(mechanismsAtTier(TIER.OPERATIONAL_INTEGRITY)).toHaveLength(7);
    expect(mechanismsAtTier(TIER.ALLOCATION_QUALITY).length).toBeGreaterThanOrEqual(12);
  });

  test("mechanism ids are unique", () => {
    const ids = MECHANISMS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("only Tier 2 mechanisms declare a kill switch", () => {
    for (const mechanism of MECHANISMS) {
      if (mechanism.tier === TIER.ALLOCATION_QUALITY) {
        expect(typeof mechanism.killSwitch).toBe("string");
      } else {
        expect(mechanism.killSwitch).toBeUndefined();
      }
    }
  });

  test("the §22.5 supported ladder is exactly nine switches in the stated order", () => {
    expect(KILL_SWITCH_LADDER).toEqual([
      "reposition_injection",
      "preemption",
      "deferral",
      "cross_region_candidacy",
      "chaining",
      "multi_leg_columns",
      "reliability_based_gating",
      "batch_solving",
      "opportunity_cost_term",
    ]);
    for (const switchName of KILL_SWITCH_LADDER) {
      expect(isOnSupportedLadder(switchName)).toBe(true);
    }
    for (const switchName of KILL_SWITCHES_OFF_LADDER) {
      expect(isOnSupportedLadder(switchName)).toBe(false);
    }
  });
});

describe("mechanism module paths are real locations", () => {
  test("every owning module lies inside a directory the module tree created", () => {
    for (const mechanism of MECHANISMS) {
      for (const modulePath of mechanism.modules) {
        const directory = modulePath.endsWith("/")
          ? modulePath
          : path.posix.dirname(modulePath);
        const absolute = path.join(__dirname, "..", "..", directory);
        expect({ mechanism: mechanism.id, directory, exists: fs.existsSync(absolute) }).toEqual({
          mechanism: mechanism.id,
          directory,
          exists: true,
        });
      }
    }
  });

  test("every engine-owned module resolves to the tier its mechanism declares", () => {
    for (const mechanism of MECHANISMS) {
      for (const modulePath of mechanism.modules) {
        const resolved = tierOf(modulePath);
        if (resolved === null) continue; // e.g. controllers and routes, outside the tree
        // settlement.js is deliberately assigned the stricter of its two tiers.
        if (modulePath === "src/engine/lifecycle/settlement.js") {
          expect(resolved).toBe(TIER.SAFETY_CORE);
          continue;
        }
        expect({ modulePath, resolved }).toEqual({ modulePath, resolved: mechanism.tier });
      }
    }
  });
});

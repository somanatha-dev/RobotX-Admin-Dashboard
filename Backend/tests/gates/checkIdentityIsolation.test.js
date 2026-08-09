"use strict";

/**
 * Self-test for the identity-isolation build gate (§23.7).
 *
 * Phase 14's completion gate: *"no identifying value is an input to any cost term."*
 *
 * A gate that has never failed is not known to work, so this plants an identifying field
 * in each of the gate's two scopes and asserts it is caught, then plants the same field
 * *outside* both scopes and asserts it is not — because a gate that fires everywhere is
 * one somebody turns off.
 */

const { checkIdentityIsolation, checkModule, formatReport, COST_SCOPE, RECORD_SCOPE } = require("../../tools/gates/checkIdentityIsolation");
const surrogateKeys = require("../../src/engine/privacy/surrogateKeys");

const { createTree, removeTree, removeAllTrees } = require("./fixtureTree");

afterAll(() => removeAllTrees());

const COMPLIANT_COST_TERM = `"use strict";
function cDirect(candidate) {
  // The derived, non-identifying quantities §23.7 admits into the decision path.
  return candidate.fineCell === candidate.routingNodeId ? 0n : candidate.travelMilliCU;
}
module.exports = { cDirect };
`;

const OFFENDING_COST_TERM = `"use strict";
function cDirect(candidate) {
  // A street address, read inside a cost term. This is the defect the gate exists for.
  return candidate.stop.address === "depot" ? 0n : candidate.travelMilliCU;
}
module.exports = { cDirect };
`;

const OFFENDING_RECORD_BUILDER = `"use strict";
function build(round) {
  return { legId: round.legId, label: round.stop.label };
}
module.exports = { build };
`;

describe("the gate catches an identifying value inside a cost term", () => {
  test("a planted address read fails, naming the file, the line and the field", () => {
    const root = createTree("identity-cost-violation", {
      "src/engine/cost/cDirect.js": OFFENDING_COST_TERM,
    });

    const result = checkIdentityIsolation({ root });
    removeTree(root);

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      file: "src/engine/cost/cDirect.js",
      field: "address",
      kind: "identifying-input-to-cost",
    });
    expect(formatReport(result)).toMatch(/a street address is never an input to a cost term/);
  });

  test("the compliant version of the same module passes", () => {
    const root = createTree("identity-cost-clean", {
      "src/engine/cost/cDirect.js": COMPLIANT_COST_TERM,
    });

    const result = checkIdentityIsolation({ root });
    removeTree(root);

    expect(result).toMatchObject({ ok: true, violations: [] });
    expect(result.filesChecked).toBe(1);
  });
});

describe("the gate catches an identifying value written into a decision record", () => {
  test("a planted `label` in the Tier B builder fails", () => {
    const root = createTree("identity-record-violation", {
      "src/engine/observability/tierB.js": OFFENDING_RECORD_BUILDER,
    });

    const result = checkIdentityIsolation({ root });
    removeTree(root);

    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({ field: "label", kind: "identifying-value-in-record" });
  });

  test("a module outside both scopes is not checked", () => {
    // The gate is deliberately narrow. Candidate generation computes a great-circle lower
    // bound and F33 evaluates a geofence; both consume a coordinate in order to *produce*
    // one of §23.7's admissible derived quantities, which is the construction the section
    // describes rather than a violation of it. A gate that fired on them would fail on
    // correct code, and a gate that fails on correct code gets weakened within a week.
    const root = createTree("identity-out-of-scope", {
      "src/engine/candidates/lowerBound.js": OFFENDING_COST_TERM,
      "src/engine/feasibility/predicates/f33.js": OFFENDING_COST_TERM,
    });

    const result = checkIdentityIsolation({ root });
    removeTree(root);

    expect(result).toMatchObject({ ok: true, filesChecked: 0 });
  });
});

describe("the exemption pragma", () => {
  test("`@identifying-input` with a stated reason is honoured", () => {
    const root = createTree("identity-exempt", {
      "src/engine/cost/cDirect.js": `"use strict";
function cDirect(candidate) {
  /** @identifying-input quantised to the routing node before it reaches any arithmetic */
  return candidate.stop.address;
}
module.exports = { cDirect };
`,
    });

    const result = checkIdentityIsolation({ root });
    removeTree(root);
    expect(result.ok).toBe(true);
  });

  test("an unexplained exemption fails, exactly as `@structural` does in the register gate", () => {
    const root = createTree("identity-exempt-bare", {
      "src/engine/cost/cDirect.js": `"use strict";
function cDirect(candidate) {
  /** @identifying-input */
  return candidate.stop.address;
}
module.exports = { cDirect };
`,
    });

    const result = checkIdentityIsolation({ root });
    removeTree(root);

    expect(result.ok).toBe(false);
    expect(result.violations[0].kind).toBe("unexplained-exemption");
  });
});

describe("the gate's scope and register are the ones the phase declares", () => {
  test("the cost scope is every term of Φ, and the record scope names its four modules", () => {
    expect([...COST_SCOPE]).toEqual(["src/engine/cost/"]);
    expect([...RECORD_SCOPE]).toEqual([
      "src/engine/observability/tierA.js",
      "src/engine/observability/tierB.js",
      "src/engine/observability/decisionRecord.js",
      "src/engine/determinism/snapshot.js",
    ]);
  });

  test("it reads the same register `privacy/surrogateKeys.js` publishes, not a copy", () => {
    // A second list would drift, and the drift would be silent in exactly the direction
    // that matters: a field the register calls identifying and the gate does not.
    const findings = checkModule("src/engine/cost/x.js", `const v = candidate.${surrogateKeys.IDENTIFYING_FIELDS[0]};`);
    expect(findings).toHaveLength(1);
    expect(findings[0].field).toBe(surrogateKeys.IDENTIFYING_FIELDS[0]);
  });

  test("the real tree passes", () => {
    const result = checkIdentityIsolation();
    expect(result.violations).toEqual([]);
    // If this ever drops to zero the scope has stopped matching and the assertion above
    // proves nothing.
    expect(result.filesChecked).toBeGreaterThan(10);
  });
});

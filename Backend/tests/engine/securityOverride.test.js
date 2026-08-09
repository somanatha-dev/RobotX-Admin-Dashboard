"use strict";

/**
 * Engine lane — Phase 14: manual override discipline (§23.6) and authorisation scoping
 * (§23.4).
 *
 * The property this file exists to defend is the first row of §23.6's table:
 *
 * > | Class I, R, and F constraints are never waivable | Enforced in the feasibility gate;
 * > | there is no code path that skips it |
 *
 * Both halves are asserted: the module refuses, and the gate it is supposed to be enforced
 * in still has no bypass — because a module that refuses and a gate that could be told to
 * skip would together be worth nothing.
 */

const fs = require("fs");
const path = require("path");

const override = require("../../src/engine/security/override");
const { CONSTRAINT_CLASS } = require("../../src/engine/feasibility/threeValued");
const register = require("../../src/engine/feasibility/register");

const OPERATOR = { actorId: "ops-1", actorRole: "SUPER_ADMIN", reason: "the customer is on site and has confirmed" };

describe("§23.6 / §7.2 — class I, R and F are never waivable", () => {
  test("the three are refused, and the refusal names the rule", () => {
    for (const constraintClass of override.NEVER_WAIVABLE) {
      const decision = override.authoriseWaiver({ ...OPERATOR, predicateId: "F8", constraintClass }, { elevatedRoles: ["SUPER_ADMIN"] });
      expect({ constraintClass, granted: decision.granted, refusal: decision.refusal }).toEqual({
        constraintClass,
        granted: false,
        refusal: override.REFUSAL.CLASS_NOT_WAIVABLE,
      });
    }
  });

  test("the refusal is issued WITHOUT consulting the requester's role", () => {
    // "Never overridable by **anyone**" is implemented by not looking at who. If the role
    // were checked first, the absoluteness of class I would be one privilege escalation
    // away from being negotiable, and the audit would record a denied authorisation rather
    // than an impossible request.
    const decision = override.authoriseWaiver(
      { predicateId: "F8", constraintClass: "I", actorId: null, actorRole: null, reason: null },
      { elevatedRoles: ["SUPER_ADMIN"] },
    );
    expect(decision.refusal).toBe(override.REFUSAL.CLASS_NOT_WAIVABLE);
    expect(decision.detail).toMatch(/without consulting the requester's role/);
  });

  test("every class I, R and F predicate in the register is unwaivable — all thirty-odd of them", () => {
    const absolute = register.PREDICATES.filter((entry) => override.NEVER_WAIVABLE.includes(entry.constraintClass));
    expect(absolute.length).toBeGreaterThan(20);
    for (const entry of absolute) {
      const decision = override.authoriseWaiver({ ...OPERATOR, predicateId: entry.id, constraintClass: entry.constraintClass }, {});
      expect({ id: entry.id, granted: decision.granted }).toEqual({ id: entry.id, granted: false });
    }
  });

  test("the module refuses to load if WAIVABILITY is ever edited to permit one", () => {
    expect(() => override.assertAbsolutes()).not.toThrow();
  });

  test("the feasibility gate still has no bypass", () => {
    // §23.6's enforcement clause is about the gate, not about this module. Phase 6 shipped
    // `evaluate.js` with "deliberately no skipPredicates, no manual flag, and no privileged
    // path", and Phase 14 does not add one.
    //
    // Scanned over the **code**, not the file: `evaluate.js`'s own header says "There is
    // deliberately no `skipPredicates`, no `manual` flag, and no privileged path", and a
    // naive `includes()` would fail on the sentence that promises the property it is
    // checking.
    const { codeOnly } = require("../../src/engine/guards/sourceScan");
    const source = codeOnly(fs.readFileSync(path.join(__dirname, "..", "..", "src", "engine", "feasibility", "evaluate.js"), "utf8"));
    for (const bypass of ["skipPredicates", "waivePredicate", "waivedPredicates", "manualOverride", "bypass"]) {
      expect({ bypass, present: source.includes(bypass) }).toEqual({ bypass, present: false });
    }
  });
});

describe("§7.2 — class P and C are waivable, under conditions", () => {
  test("a class P waiver by an authorised role, with a reason, naming the predicate, is granted", () => {
    const decision = override.authoriseWaiver({ ...OPERATOR, predicateId: "F9", constraintClass: CONSTRAINT_CLASS.POLICY }, { elevatedRoles: ["SUPER_ADMIN"] });
    expect(decision).toMatchObject({ granted: true, waivedPredicate: "F9" });
  });

  test("it is refused without a predicate, without an identity, or without a reason", () => {
    const base = { ...OPERATOR, constraintClass: CONSTRAINT_CLASS.POLICY, predicateId: "F9" };
    expect(override.authoriseWaiver({ ...base, predicateId: null }, {}).refusal).toBe(override.REFUSAL.NO_PREDICATE);
    expect(override.authoriseWaiver({ ...base, actorId: null }, {}).refusal).toBe(override.REFUSAL.NO_IDENTITY);
    expect(override.authoriseWaiver({ ...base, reason: null }, {}).refusal).toBe(override.REFUSAL.NO_REASON);
  });

  test("an unelevated role is refused", () => {
    const decision = override.authoriseWaiver(
      { ...OPERATOR, actorRole: "VIEWER", predicateId: "F9", constraintClass: CONSTRAINT_CLASS.POLICY },
      { elevatedRoles: ["SUPER_ADMIN"] },
    );
    expect(decision.refusal).toBe(override.REFUSAL.ROLE_NOT_ELEVATED);
  });

  test("a class C waiver is a documented exception and needs a second, distinct approver", () => {
    const base = { ...OPERATOR, predicateId: "F4", constraintClass: CONSTRAINT_CLASS.CONTRACTUAL };
    expect(override.authoriseWaiver(base, {}).refusal).toBe(override.REFUSAL.SECOND_APPROVER_REQUIRED);
    expect(override.authoriseWaiver({ ...base, secondApproverId: "ops-1" }, {}).refusal).toBe(override.REFUSAL.SECOND_APPROVER_NOT_DISTINCT);
    expect(override.authoriseWaiver({ ...base, secondApproverId: "ops-2" }, {}).granted).toBe(true);
  });

  test("an unknown constraint class is refused — unknown is never permission", () => {
    expect(override.authoriseWaiver({ ...OPERATOR, predicateId: "F9", constraintClass: "X" }, {}).refusal).toBe(override.REFUSAL.UNKNOWN_CLASS);
  });
});

describe("§23.4 — scoped RBAC/ABAC over the four high-privilege action classes", () => {
  test("all four §23.4 actions are registered", () => {
    expect(Object.keys(override.ACTION_CLASS).sort()).toEqual([
      "BULK_CANCELLATION",
      "MANUAL_ASSIGNMENT_AGAINST_POLICY",
      "QUARANTINE_OVERRIDE",
      "SAFETY_CONFIG_CHANGE",
    ]);
  });

  test("each requires an elevated role and a recorded reason", () => {
    for (const definition of override.ACTION_CLASSES) {
      expect({ id: definition.id, elevated: definition.elevated, reason: definition.reason }).toEqual({
        id: definition.id,
        elevated: true,
        reason: true,
      });
    }
  });

  test("a quarantine override without a reason is refused", () => {
    const decision = override.authoriseAction(
      { actionClass: "QUARANTINE_OVERRIDE", actorId: "ops-1", actorRole: "SUPER_ADMIN", secondApproverId: "ops-2" },
      { elevatedRoles: ["SUPER_ADMIN"] },
    );
    expect(decision.refusal).toBe(override.REFUSAL.NO_REASON);
  });

  test("configuration may ADD a second-approver requirement but never remove one", () => {
    // Allowing a configuration to remove it would put the strongest control in §23 behind
    // an ordinary config change.
    const request = { actionClass: "QUARANTINE_OVERRIDE", actorId: "ops-1", actorRole: "SUPER_ADMIN", reason: "r" };
    expect(override.authoriseAction(request, { elevatedRoles: ["SUPER_ADMIN"], requireSecondApproverFor: [] }).refusal).toBe(
      override.REFUSAL.SECOND_APPROVER_REQUIRED,
    );

    const bulk = { actionClass: "BULK_CANCELLATION", actorId: "ops-1", actorRole: "SUPER_ADMIN", reason: "r" };
    expect(override.authoriseAction(bulk, { elevatedRoles: ["SUPER_ADMIN"] }).granted).toBe(true);
    expect(override.authoriseAction(bulk, { elevatedRoles: ["SUPER_ADMIN"], requireSecondApproverFor: ["BULK_CANCELLATION"] }).refusal).toBe(
      override.REFUSAL.SECOND_APPROVER_REQUIRED,
    );
  });

  test("region, tenant and fleet scoping refuses an action outside the actor's authority", () => {
    const request = { actionClass: "BULK_CANCELLATION", actorId: "ops-1", actorRole: "SUPER_ADMIN", reason: "r" };
    const policy = { elevatedRoles: ["SUPER_ADMIN"], scope: { regionIds: ["region-a"] } };

    expect(override.authoriseAction(request, policy, { regionId: "region-a" }).granted).toBe(true);
    expect(override.authoriseAction(request, policy, { regionId: "region-b" }).refusal).toBe(override.REFUSAL.OUT_OF_SCOPE);
    // An action naming no region is refused when the authority is region-scoped: an
    // unscoped action under a scoped authority is an action outside it.
    expect(override.authoriseAction(request, policy, {}).refusal).toBe(override.REFUSAL.OUT_OF_SCOPE);
  });

  test("tenant isolation is enforced", () => {
    const problem = override.outOfScope({ tenantId: "tenant-a" }, { tenantId: "tenant-b" });
    expect(problem).toMatch(/tenant isolation/);
  });

  test("an absent scope list means unscoped; an empty one means no authority", () => {
    expect(override.outOfScope({}, { regionId: "r" })).toBeNull();
    expect(override.outOfScope({ regionIds: [] }, { regionId: "r" })).toMatch(/does not extend to regionId/);
  });

  test("an unknown action class is refused", () => {
    expect(override.authoriseAction({ actionClass: "DELETE_EVERYTHING", actorId: "ops-1" }, {}).refusal).toBe(
      override.REFUSAL.UNKNOWN_ACTION_CLASS,
    );
  });
});

describe("§7.2 — manual assignment does not bypass constraints", () => {
  test("a manual selection is a candidate set of one, run through the standard gate", () => {
    const selection = override.manualSelection({ agentId: "AGT-7", actorId: "ops-1", reason: "operator knows the site" });
    expect(selection).toEqual({ candidateAgentIds: ["AGT-7"], manual: true, actorId: "ops-1", reason: "operator knows the site" });
  });

  test("it refuses to construct a selection that names no agent", () => {
    expect(() => override.manualSelection({})).toThrow(/names the agent it selects/);
  });
});

describe("§23.6 — every override is audited, granted or refused", () => {
  test("a refused class I waiver still produces an audit event and a queryable row", () => {
    const request = { predicateId: "F8", constraintClass: "I", actorId: "ops-1", actorRole: "SUPER_ADMIN", reason: "customer pressure" };
    const decision = override.authoriseWaiver(request, {});

    const event = override.toAuditEvent(decision, request, { subjectType: "AGENT", subjectId: "AGT-1", recordedAtMs: 1000 });
    expect(event).toMatchObject({ eventType: "OVERRIDE", actorId: "ops-1", reason: "customer pressure" });
    expect(event.payload).toMatchObject({ granted: false, refusal: "CLASS_NOT_WAIVABLE", predicateId: "F8", constraintClass: "I" });

    const row = override.toOverrideAuditRow(decision, request, { subjectType: "AGENT", subjectId: "AGT-1", auditEventHash: "abc" });
    // A table recording only successes would answer "nobody tried" to a question whose
    // true answer was "somebody tried eleven times".
    expect(row).toMatchObject({ granted: false, refusalReason: "CLASS_NOT_WAIVABLE", auditEventHash: "abc" });
  });

  test("an action-class decision is audited under that class's own event type", () => {
    const request = { actionClass: "QUARANTINE_OVERRIDE", actorId: "ops-1", actorRole: "SUPER_ADMIN", reason: "r", secondApproverId: "ops-2" };
    const decision = override.authoriseAction(request, { elevatedRoles: ["SUPER_ADMIN"] });
    expect(override.toAuditEvent(decision, request, { recordedAtMs: 1 }).eventType).toBe("QUARANTINE");
  });
});

describe("§23.6 — override rates are a design signal", () => {
  const events = [
    { granted: true, actorId: "ops-1", predicateId: "F9" },
    { granted: true, actorId: "ops-2", predicateId: "F9" },
    { granted: true, actorId: "ops-1", predicateId: "F11" },
    // A refusal is counted in `total` but is not a waiver, so it does not raise a rate.
    { granted: false, actorId: "ops-1", predicateId: "F8" },
  ];

  test("rates are reported per predicate and per operator, in a stable order", () => {
    const measured = override.rates(events);
    expect(measured).toMatchObject({ total: 4, granted: 3 });
    expect(measured.perPredicate).toEqual([
      { predicateId: "F9", count: 2 },
      { predicateId: "F11", count: 1 },
    ]);
    expect(measured.perOperator[0]).toEqual({ actorId: "ops-1", count: 2 });
  });

  test("a breach names the actionable interpretation, not only the count", () => {
    const findings = override.breaches(override.rates(events), { perPredicate: 2, perOperator: 2 });
    expect(findings.ok).toBe(false);

    const predicate = findings.findings.find((row) => row.kind === "PREDICATE");
    expect(predicate.interpretation).toMatch(/evidence about the constraint: it is likely miscalibrated/);

    const operator = findings.findings.find((row) => row.kind === "OPERATOR");
    expect(operator.interpretation).toMatch(/neither punitive by default/);
  });

  test("no thresholds means no findings, never a division by zero", () => {
    expect(override.breaches(override.rates(events), {}).ok).toBe(true);
  });
});

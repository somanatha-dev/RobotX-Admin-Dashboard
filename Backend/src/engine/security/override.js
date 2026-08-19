"use strict";

/**
 * Manual override discipline (§23.6) and authorisation scoping (§23.4) — **Tier 1**.
 *
 * > Manual intervention is necessary — operators routinely know things the engine does
 * > not — and must be bounded. The audit shows the baseline's manual path bypasses every
 * > eligibility rule, permitting assignment to a robot at 6 % battery or with an active
 * > fault.
 *
 * §23.6's six rules are implemented as six checkable things rather than six sentences:
 *
 * | Rule | Where it is enforced here |
 * |---|---|
 * | Class I, R and F are never waivable | `WAIVABILITY`, and `authoriseWaiver()` refuses before it looks at the actor |
 * | Class P is waivable by authorised roles | `authoriseWaiver()` requires identity, reason, and the specific predicate |
 * | Manual choice among feasible agents is always permitted | `manualSelection()` — a single-candidate set through the standard gate |
 * | Every override is audited and counted | `toAuditEvent()` / `toOverrideAuditRow()`; the chain is `observability/auditStream.js` |
 * | Override rates are monitored per operator and per predicate | `rates()`, `breaches()` |
 * | High-risk overrides require a second approver | `ACTION_CLASS[…].secondApprover`, checked in `authoriseAction()` |
 *
 * ── Why the refusal comes before the actor check ────────────────────────────
 * A class I waiver request is refused **without consulting the requester's role**, and
 * the ordering is the point. If the code asked "is this operator senior enough?" first,
 * then the absoluteness of class I would be one privilege escalation away from being
 * negotiable, and the audit trail would record a *denied authorisation* rather than an
 * *impossible request* — which is a materially weaker record when the incident is
 * reviewed. §7.2 says "Never overridable by anyone, including operators and manual
 * assignment", and "by anyone" is implemented by not looking at who.
 *
 * ── Where the gate is, and where it is not ──────────────────────────────────
 * This module does not evaluate feasibility and holds no bypass. `feasibility/gate.js`
 * has "deliberately no `skipPredicates`, no `manual` flag, and no privileged path", and
 * Phase 14 does not add one. A granted class P waiver is expressed as a **waived
 * predicate id** that the caller applies to the gate's *result*, never as an argument
 * that changes how the gate ran. The distinction survives a refactor: a gate that never
 * takes a waiver cannot be made to honour one by accident.
 *
 * ── Rates are a design signal, not a disciplinary one ───────────────────────
 * > A high rate is a signal that a constraint is miscalibrated or that an operator needs
 * > support — both actionable, neither punitive by default.
 *
 * `breaches()` therefore returns a *finding* with the constraint named, and the
 * per-predicate view is first in the returned object, because the predicate is the thing
 * that is usually wrong.
 */

const { CONSTRAINT_CLASS } = require("../feasibility/threeValued");
const { EVENT_TYPE } = require("../observability/auditStream");

/**
 * §7.2's Override column, as data.
 *
 * `F` is "Not overridable; may be re-evaluated with different parameters" — which is a
 * different sentence from class I's and reaches the same place, so it carries its own
 * text rather than being folded into one bucket.
 * @structural §7.2's own Override column
 */
const WAIVABILITY = Object.freeze({
  [CONSTRAINT_CLASS.INVARIANT]: Object.freeze({
    waivable: false,
    rule: "Never overridable by anyone, including operators and manual assignment (§7.2)",
  }),
  [CONSTRAINT_CLASS.REGULATORY]: Object.freeze({
    waivable: false,
    rule: "Never overridable operationally (§7.2)",
  }),
  [CONSTRAINT_CLASS.FEASIBILITY]: Object.freeze({
    waivable: false,
    rule: "Not overridable; may be re-evaluated with different parameters (§7.2)",
  }),
  [CONSTRAINT_CLASS.CONTRACTUAL]: Object.freeze({
    waivable: true,
    requiresSecondApprover: true,
    rule: "Documented exception with audit (§7.2)",
  }),
  [CONSTRAINT_CLASS.POLICY]: Object.freeze({
    waivable: true,
    requiresSecondApprover: false,
    rule: "Operator override with reason and audit (§7.2)",
  }),
});

/** The three classes §23.6 names as never waivable, kept as a set for the assertions. */
const NEVER_WAIVABLE = Object.freeze([CONSTRAINT_CLASS.INVARIANT, CONSTRAINT_CLASS.REGULATORY, CONSTRAINT_CLASS.FEASIBILITY]);

/**
 * §23.4's high-privilege action classes.
 *
 * > Highest-privilege actions — quarantine override, safety-class config change, bulk
 * > cancellation, manual assignment against a Policy constraint — require elevated role
 * > plus a recorded reason, and where configured a second approver.
 *
 * The four are enumerated here so that the REST layer gates them from one register
 * rather than from four independently-remembered decisions, and so that a test can
 * assert all four are gated.
 * @structural §23.4's own enumeration
 */
const ACTION_CLASS = Object.freeze({
  QUARANTINE_OVERRIDE: Object.freeze({
    id: "QUARANTINE_OVERRIDE",
    elevated: true,
    reason: true,
    secondApprover: true,
    auditEventType: EVENT_TYPE.QUARANTINE,
    description: "releasing an agent from quarantine, or clearing a fault that put it there",
  }),
  SAFETY_CONFIG_CHANGE: Object.freeze({
    id: "SAFETY_CONFIG_CHANGE",
    elevated: true,
    reason: true,
    secondApprover: true,
    auditEventType: EVENT_TYPE.CONFIG_CHANGE,
    description: "publishing a configuration version that changes a Safety-class parameter (§22.3)",
  }),
  BULK_CANCELLATION: Object.freeze({
    id: "BULK_CANCELLATION",
    elevated: true,
    reason: true,
    secondApprover: false,
    auditEventType: EVENT_TYPE.CANCELLATION,
    description: "cancelling more than one Task or Leg in a single operator action",
  }),
  MANUAL_ASSIGNMENT_AGAINST_POLICY: Object.freeze({
    id: "MANUAL_ASSIGNMENT_AGAINST_POLICY",
    elevated: true,
    reason: true,
    secondApprover: false,
    auditEventType: EVENT_TYPE.MANUAL_ASSIGNMENT,
    description: "assigning an agent while waiving a class P predicate it fails",
  }),
});

const ACTION_CLASSES = Object.freeze(Object.values(ACTION_CLASS));

/** Why an authorisation was refused. Enumerated so refusals are countable by cause. */
const REFUSAL = Object.freeze({
  CLASS_NOT_WAIVABLE: "CLASS_NOT_WAIVABLE",
  UNKNOWN_CLASS: "UNKNOWN_CLASS",
  NO_PREDICATE: "NO_PREDICATE",
  NO_REASON: "NO_REASON",
  NO_IDENTITY: "NO_IDENTITY",
  ROLE_NOT_ELEVATED: "ROLE_NOT_ELEVATED",
  SECOND_APPROVER_REQUIRED: "SECOND_APPROVER_REQUIRED",
  SECOND_APPROVER_NOT_DISTINCT: "SECOND_APPROVER_NOT_DISTINCT",
  UNKNOWN_ACTION_CLASS: "UNKNOWN_ACTION_CLASS",
  OUT_OF_SCOPE: "OUT_OF_SCOPE",
});

/**
 * Is this actor's role among the elevated roles the policy admits? — PHASE 14
 * remediation (P14-R3).
 *
 * ── The bug this replaces, stated plainly ───────────────────────────────────
 * Both authorisation functions previously wrote `elevated.length > 0 &&
 * !elevated.includes(role)`, so an **empty** list skipped the role check entirely and
 * every authenticated caller passed it. `security.elevated_roles` is a registered `set`
 * with an open range, so `[]` is a publishable value — and publishing it, which reads
 * like the most restrictive possible change and is the obvious thing an offboarding
 * process would do, silently opened all four of §23.4's highest-privilege action classes
 * to every role.
 *
 * The semantics now match the two places in this codebase that already had them right:
 * `outOfScope()` below, whose own header says "an empty *array* means the opposite and is
 * honoured as such, because 'this operator may act in no region' is a state an
 * offboarding process should be able to express", and `auth_middleware.requireElevatedRole()`,
 * whose `roles.includes(...)` has always refused everyone on an empty list. A **present**
 * list is authoritative, empty or not; only an **absent** one means unscoped.
 *
 * @param {unknown} elevatedRoles the policy's list, or absent
 * @param {unknown} actorRole
 * @returns {boolean}
 */
function roleAdmitted(elevatedRoles, actorRole) {
  if (!Array.isArray(elevatedRoles)) return true;
  return elevatedRoles.includes(actorRole);
}

/**
 * May a predicate of this class be waived at all?
 *
 * @param {string} constraintClass one of `CONSTRAINT_CLASS`
 * @returns {{ waivable: boolean, rule: string|null }}
 */
function mayWaive(constraintClass) {
  const row = WAIVABILITY[constraintClass];
  if (!row) return { waivable: false, rule: null };
  return { waivable: row.waivable, rule: row.rule };
}

/**
 * Authorise (or refuse) the waiver of one feasibility predicate.
 *
 * The class check is first, deliberately — see the header.
 *
 * @param {object} request
 * @param {string} request.predicateId e.g. `F9`
 * @param {string} request.constraintClass the predicate's §7.2 class
 * @param {string} request.actorId
 * @param {string} request.actorRole
 * @param {string} request.reason
 * @param {string} [request.secondApproverId]
 * @param {object} [policy] `{ elevatedRoles: string[], scope: { regionIds?, tenantIds?, fleetIds? } }`
 * @param {object} [subject] `{ regionId, tenantId, fleetId }` — what is being overridden
 * @returns {{ granted: boolean, refusal: string|null, detail: string|null, waivedPredicate: string|null }}
 */
function authoriseWaiver(request, policy, subject) {
  const source = request || {};
  const rules = policy || {};

  const waivability = WAIVABILITY[source.constraintClass];
  if (!waivability) {
    return {
      granted: false,
      refusal: REFUSAL.UNKNOWN_CLASS,
      detail: `"${String(source.constraintClass)}" is not a §7.2 constraint class. Unknown is never permission (T2).`,
      waivedPredicate: null,
    };
  }
  if (!waivability.waivable) {
    return {
      granted: false,
      refusal: REFUSAL.CLASS_NOT_WAIVABLE,
      detail:
        `${String(source.predicateId)} is class ${source.constraintClass}: ${waivability.rule}. This refusal is ` +
        "issued without consulting the requester's role — 'by anyone' is implemented by not looking at who, so that " +
        "the absoluteness of the class is not one privilege escalation away from being negotiable (§7.2, §23.6).",
      waivedPredicate: null,
    };
  }

  if (!source.predicateId) {
    return { granted: false, refusal: REFUSAL.NO_PREDICATE, detail: "a waiver names the specific predicate it waives (§23.6)", waivedPredicate: null };
  }
  if (!source.actorId) {
    return { granted: false, refusal: REFUSAL.NO_IDENTITY, detail: "every override records identity (§23.6)", waivedPredicate: null };
  }
  if (!source.reason) {
    return { granted: false, refusal: REFUSAL.NO_REASON, detail: "every override records a reason (§23.6)", waivedPredicate: null };
  }

  if (!roleAdmitted(rules.elevatedRoles, source.actorRole)) {
    return {
      granted: false,
      refusal: REFUSAL.ROLE_NOT_ELEVATED,
      detail: `role "${String(source.actorRole)}" is not among the roles authorised to waive a class ${source.constraintClass} predicate (§23.4)`,
      waivedPredicate: null,
    };
  }

  const scopeProblem = outOfScope(rules.scope, subject);
  if (scopeProblem) {
    return { granted: false, refusal: REFUSAL.OUT_OF_SCOPE, detail: scopeProblem, waivedPredicate: null };
  }

  if (waivability.requiresSecondApprover) {
    if (!source.secondApproverId) {
      return {
        granted: false,
        refusal: REFUSAL.SECOND_APPROVER_REQUIRED,
        detail: `a class ${source.constraintClass} waiver is a documented exception and requires a second approver (§7.2, §23.6)`,
        waivedPredicate: null,
      };
    }
    if (String(source.secondApproverId) === String(source.actorId)) {
      return {
        granted: false,
        refusal: REFUSAL.SECOND_APPROVER_NOT_DISTINCT,
        detail: "the second approver must be a distinct identity; one person approving themselves is not two-person approval",
        waivedPredicate: null,
      };
    }
  }

  return { granted: true, refusal: null, detail: null, waivedPredicate: String(source.predicateId) };
}

/**
 * §23.4's scoped RBAC/ABAC: "region, fleet, tenant, and action class".
 *
 * Absent scope lists mean "unscoped", not "empty": a policy that names no regions grants
 * across regions. An empty *array* means the opposite and is honoured as such, because
 * "this operator may act in no region" is a state an offboarding process should be able
 * to express.
 *
 * @param {object|null|undefined} scope
 * @param {object|null|undefined} subject
 * @returns {string|null} a refusal detail, or null when in scope
 */
function outOfScope(scope, subject) {
  if (!scope) return null;
  const target = subject || {};

  for (const [field, list] of [
    ["regionId", scope.regionIds],
    ["tenantId", scope.tenantIds],
    ["fleetId", scope.fleetIds],
  ]) {
    if (!Array.isArray(list)) continue;
    const value = target[field];
    if (value === undefined || value === null) {
      return `the action names no ${field}, and the actor's authority is scoped by ${field} (§23.4)`;
    }
    if (!list.includes(value)) {
      return `the actor's authority does not extend to ${field} "${String(value)}" (§23.4)`;
    }
  }

  // §23.4 — "Tenant isolation is enforced at every layer: a tenant may not observe or
  // influence another tenant's missions."
  if (scope.tenantId !== undefined && target.tenantId !== undefined && scope.tenantId !== target.tenantId) {
    return `tenant isolation: an actor bound to tenant "${String(scope.tenantId)}" may not act on tenant "${String(target.tenantId)}" (§23.4)`;
  }

  return null;
}

/**
 * Authorise one of §23.4's high-privilege action classes.
 *
 * @param {object} request `{ actionClass, actorId, actorRole, reason, secondApproverId }`
 * @param {object} [policy] `{ elevatedRoles, scope, requireSecondApproverFor }`
 * @param {object} [subject]
 * @returns {{ granted: boolean, refusal: string|null, detail: string|null, actionClass: object|null }}
 */
function authoriseAction(request, policy, subject) {
  const source = request || {};
  const rules = policy || {};
  const definition = ACTION_CLASS[source.actionClass];

  if (!definition) {
    return {
      granted: false,
      refusal: REFUSAL.UNKNOWN_ACTION_CLASS,
      detail: `"${String(source.actionClass)}" is not one of ${Object.keys(ACTION_CLASS).join(", ")} (§23.4)`,
      actionClass: null,
    };
  }
  if (!source.actorId) {
    return { granted: false, refusal: REFUSAL.NO_IDENTITY, detail: "a high-privilege action records who took it (§23.4)", actionClass: definition };
  }
  if (definition.reason && !source.reason) {
    return { granted: false, refusal: REFUSAL.NO_REASON, detail: `${definition.id} requires a recorded reason (§23.4)`, actionClass: definition };
  }

  if (definition.elevated && !roleAdmitted(rules.elevatedRoles, source.actorRole)) {
    const elevated = Array.isArray(rules.elevatedRoles) ? rules.elevatedRoles : [];
    return {
      granted: false,
      refusal: REFUSAL.ROLE_NOT_ELEVATED,
      detail:
        `${definition.id} requires an elevated role; "${String(source.actorRole)}" is not one of ` +
        `${elevated.length > 0 ? elevated.join(", ") : "(the elevated-role list is empty: no role is authorised)"} (§23.4)`,
      actionClass: definition,
    };
  }

  const scopeProblem = outOfScope(rules.scope, subject);
  if (scopeProblem) {
    return { granted: false, refusal: REFUSAL.OUT_OF_SCOPE, detail: scopeProblem, actionClass: definition };
  }

  // "and where configured a second approver" — the default is the action class's own,
  // and a deployment may require it for more classes but never for fewer. Allowing a
  // configuration to *remove* a second-approver requirement would put the strongest
  // control in this section behind an ordinary config change.
  const configured = Array.isArray(rules.requireSecondApproverFor) ? rules.requireSecondApproverFor : [];
  const needsSecond = definition.secondApprover || configured.includes(definition.id);

  if (needsSecond) {
    if (!source.secondApproverId) {
      return { granted: false, refusal: REFUSAL.SECOND_APPROVER_REQUIRED, detail: `${definition.id} requires a second approver (§23.4, §23.6)`, actionClass: definition };
    }
    if (String(source.secondApproverId) === String(source.actorId)) {
      return { granted: false, refusal: REFUSAL.SECOND_APPROVER_NOT_DISTINCT, detail: "the second approver must be a distinct identity", actionClass: definition };
    }
  }

  return { granted: true, refusal: null, detail: null, actionClass: definition };
}

/**
 * §7.2 / §23.6 — manual choice of agent among feasible agents.
 *
 * > Manual choice of agent among feasible agents is always permitted | Runs the standard
 * > gate with a single-candidate set
 *
 * This function does not run the gate; it constructs the *input* the gate is run with,
 * which is the whole content of the rule. Returning a candidate set of one is what makes
 * "manual assignment does not bypass constraints" true by construction rather than by a
 * flag somebody has to remember not to set.
 *
 * @param {object} input `{ agentId, legId, actorId, reason }`
 * @returns {{ candidateAgentIds: string[], manual: true, actorId: string, reason: string|null }}
 */
function manualSelection(input) {
  const source = input || {};
  if (!source.agentId) throw new TypeError("a manual selection names the agent it selects (§7.2)");
  return {
    candidateAgentIds: [String(source.agentId)],
    manual: true,
    actorId: source.actorId ?? null,
    reason: source.reason ?? null,
  };
}

/**
 * The audit-stream event for an override decision — granted **or refused**.
 *
 * Refusals are audited too. A refused class I waiver is exactly the event a later
 * investigation wants to find, and a stream that recorded only successes would answer
 * "nobody tried" to a question whose true answer was "somebody tried eleven times".
 *
 * @param {object} decision the result of `authoriseWaiver` or `authoriseAction`
 * @param {object} request the request it decided
 * @param {object} context `{ subjectType, subjectId, recordedAtMs, streamId }`
 * @returns {object} the `auditStream.append` input
 */
function toAuditEvent(decision, request, context) {
  const settings = context || {};
  const source = request || {};
  const eventType = decision && decision.actionClass ? decision.actionClass.auditEventType : EVENT_TYPE.OVERRIDE;

  return {
    streamId: settings.streamId,
    eventType,
    actorId: source.actorId ?? null,
    actorRole: source.actorRole ?? null,
    subjectType: settings.subjectType ?? null,
    subjectId: settings.subjectId ?? null,
    reason: source.reason ?? null,
    payload: {
      granted: Boolean(decision && decision.granted),
      refusal: (decision && decision.refusal) ?? null,
      detail: (decision && decision.detail) ?? null,
      predicateId: source.predicateId ?? null,
      constraintClass: source.constraintClass ?? null,
      actionClass: source.actionClass ?? null,
      secondApproverId: source.secondApproverId ?? null,
    },
    recordedAtMs: settings.recordedAtMs,
  };
}

/**
 * The `OverrideAudit` row for the same decision.
 *
 * Two records, deliberately. The hash-chained stream is the tamper-evident one and is
 * append-only with a global order; this table is the *queryable* one, because "how often
 * has F9 been waived in region R this quarter" is a `GROUP BY` and a hash chain is not a
 * thing one groups by. `auditEventHash` joins them, so a queried row can always be
 * checked against the chain that cannot be edited.
 *
 * @param {object} decision
 * @param {object} request
 * @param {object} context `{ subjectType, subjectId, decisionId, auditEventHash, at }`
 * @returns {object}
 */
function toOverrideAuditRow(decision, request, context) {
  const settings = context || {};
  const source = request || {};
  return {
    actorId: String(source.actorId ?? ""),
    actorRole: source.actorRole ?? null,
    actionClass: source.actionClass ?? null,
    predicateId: source.predicateId ?? null,
    constraintClass: source.constraintClass ?? null,
    subjectType: settings.subjectType ?? null,
    subjectId: settings.subjectId ?? null,
    decisionId: settings.decisionId ?? null,
    reason: source.reason ?? null,
    secondApproverId: source.secondApproverId ?? null,
    granted: Boolean(decision && decision.granted),
    refusalReason: (decision && decision.refusal) ?? null,
    auditEventHash: settings.auditEventHash ?? null,
    recordedAt: settings.at ?? new Date(),
  };
}

/**
 * §23.6 — override rates per operator and per predicate.
 *
 * Per predicate first in the returned object, because the predicate is usually the thing
 * that is wrong: "operators overriding the same constraint repeatedly is evidence about
 * the constraint".
 *
 * @param {object[]} events `OverrideAudit` rows
 * @returns {{ perPredicate: object[], perOperator: object[], total: number, granted: number }}
 */
function rates(events) {
  const rows = (events || []).filter((row) => row && row.granted);
  const byPredicate = new Map();
  const byOperator = new Map();

  for (const row of rows) {
    const predicate = row.predicateId ?? row.actionClass ?? "UNSPECIFIED";
    const operator = row.actorId ?? "UNKNOWN";
    byPredicate.set(predicate, (byPredicate.get(predicate) || 0) + 1);
    byOperator.set(operator, (byOperator.get(operator) || 0) + 1);
  }

  const sorted = (map, key) =>
    [...map.entries()]
      .map(([name, count]) => ({ [key]: name, count }))
      // Descending by count, then by name — a total order, so the report is stable
      // between two runs over the same data.
      .sort((a, b) => b.count - a.count || String(a[key]).localeCompare(String(b[key])));

  return {
    perPredicate: sorted(byPredicate, "predicateId"),
    perOperator: sorted(byOperator, "actorId"),
    total: (events || []).length,
    granted: rows.length,
  };
}

/**
 * Which rates have crossed their threshold.
 *
 * The finding names the *actionable* interpretation rather than the count alone, because
 * §23.6 is explicit that this monitoring is a design signal and "neither punitive by
 * default".
 *
 * @param {ReturnType<typeof rates>} measured
 * @param {object} thresholds `{ perOperator, perPredicate }`
 * @returns {{ ok: boolean, findings: object[] }}
 */
function breaches(measured, thresholds) {
  const limits = thresholds || {};
  const findings = [];

  const predicateLimit = Number.isFinite(limits.perPredicate) ? Number(limits.perPredicate) : Infinity;
  const operatorLimit = Number.isFinite(limits.perOperator) ? Number(limits.perOperator) : Infinity;

  for (const row of measured.perPredicate || []) {
    if (row.count >= predicateLimit) {
      findings.push({
        kind: "PREDICATE",
        predicateId: row.predicateId,
        count: row.count,
        threshold: predicateLimit,
        interpretation:
          `${row.predicateId} has been waived ${row.count} time(s) in the window. Operators overriding the same ` +
          "constraint repeatedly is evidence about the constraint: it is likely miscalibrated (§23.6).",
      });
    }
  }
  for (const row of measured.perOperator || []) {
    if (row.count >= operatorLimit) {
      findings.push({
        kind: "OPERATOR",
        actorId: row.actorId,
        count: row.count,
        threshold: operatorLimit,
        interpretation:
          `${row.actorId} has taken ${row.count} override(s) in the window. This is a signal that this operator ` +
          "needs support, or that their work is routinely hitting a constraint that does not fit it — both " +
          "actionable, neither punitive by default (§23.6).",
      });
    }
  }

  return { ok: findings.length === 0, findings };
}

/**
 * The three never-waivable classes are never waivable. Asserted at load, so a future
 * edit to `WAIVABILITY` that made one of them permissive fails at require time rather
 * than in the first review that happens not to notice.
 */
function assertAbsolutes() {
  for (const constraintClass of NEVER_WAIVABLE) {
    const row = WAIVABILITY[constraintClass];
    if (!row || row.waivable !== false) {
      throw new Error(
        `constraint class ${constraintClass} is marked waivable. §23.6: "Class I, R, and F constraints are never ` +
          'waivable | Enforced in the feasibility gate; there is no code path that skips it".',
      );
    }
  }
}

assertAbsolutes();

module.exports = {
  WAIVABILITY,
  NEVER_WAIVABLE,
  ACTION_CLASS,
  ACTION_CLASSES,
  REFUSAL,
  mayWaive,
  roleAdmitted,
  authoriseWaiver,
  authoriseAction,
  outOfScope,
  manualSelection,
  toAuditEvent,
  toOverrideAuditRow,
  rates,
  breaches,
  assertAbsolutes,
};

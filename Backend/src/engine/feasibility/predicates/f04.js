"use strict";

/**
 * **F4 — Tenant and fleet scope permit this mission.** Class C. Indeterminate: `DENY`.
 *
 * > Multi-tenant isolation; a shared-fleet agent must be contractually permitted for
 * > this customer.
 *
 * Two independent scopes, both of which must permit:
 *
 *   - **Tenant.** The agent either belongs to the mission's tenant, or appears in a
 *     shared pool the mission's tenant is contractually entitled to draw from.
 *   - **Fleet.** A mission may be restricted to a named fleet — a dedicated
 *     sub-fleet under a customer contract (§8.6's dedicated-fleet policy credit
 *     prices *preferring* such a fleet; this predicate is what makes a *restriction*
 *     to one binding rather than merely priced).
 *
 * Pricing a tenant breach instead of gating it is the specific error T1 forbids: a
 * high-value mission must not be able to score its way onto another customer's agent.
 *
 * Tier 0 (T0-01).
 */

const tv = require("../threeValued");

const REQUIRED = "the mission's tenant and fleet scope";

/**
 * Does `permitted` — a list of ids, or `null`/`undefined` for "unrestricted" — admit
 * `value`?
 *
 * @param {unknown} permitted
 * @param {string} value
 * @returns {boolean|null} null when the list is absent, so the caller can distinguish
 *   "unrestricted" from "not established"
 */
function admits(permitted, value) {
  if (permitted === undefined) return null;
  if (permitted === null) return true;
  if (!Array.isArray(permitted)) return null;
  return permitted.includes(value);
}

/**
 * @param {object} context `{ agentSnapshot, mission, plan, config }`
 * @returns {object} a `threeValued` predicate result
 */
function evaluate(context) {
  const agent = (context && context.agentSnapshot) || null;
  const mission = (context && context.mission) || null;

  if (!agent) return tv.absent("the agent snapshot", { required: REQUIRED });
  if (!mission) return tv.absent("the mission", { required: REQUIRED });

  const missionTenant = mission.tenantId;
  if (missionTenant === undefined || missionTenant === null) {
    return tv.absent("the mission's tenantId", {
      required: REQUIRED,
      inputSource: "CONTROL_PLANE",
      observed: { agentTenantId: agent.tenantId === undefined ? null : agent.tenantId },
    });
  }

  // Tenant scope.
  if (agent.tenantId !== missionTenant) {
    const shared = admits(agent.permittedTenants, missionTenant);
    if (shared === null) {
      return tv.indeterminate({
        observed: { agentTenantId: agent.tenantId === undefined ? null : agent.tenantId },
        required: { tenantId: missionTenant },
        inputSource: "CONTROL_PLANE",
        reason:
          "the agent's tenant differs from the mission's and no shared-pool entitlement list was " +
          "supplied; multi-tenant isolation cannot be established (§7.5 F4)",
      });
    }
    if (shared === false) {
      return tv.violated({
        observed: { agentTenantId: agent.tenantId === undefined ? null : agent.tenantId },
        required: { tenantId: missionTenant },
        inputSource: "CONTROL_PLANE",
        reason: "the agent is not contractually permitted for this customer (§7.5 F4)",
      });
    }
  }

  // Fleet scope.
  const requiredFleet = mission.requiredFleetId;
  if (requiredFleet !== undefined && requiredFleet !== null) {
    if (agent.fleetId === undefined || agent.fleetId === null) {
      return tv.absent("the agent's fleetId", {
        required: { fleetId: requiredFleet },
        inputSource: "CONTROL_PLANE",
      });
    }
    if (agent.fleetId !== requiredFleet) {
      return tv.violated({
        observed: { fleetId: agent.fleetId },
        required: { fleetId: requiredFleet },
        inputSource: "CONTROL_PLANE",
        reason: "the mission is restricted to a fleet this agent does not belong to (§7.5 F4)",
      });
    }
  }

  return tv.satisfied({
    observed: {
      agentTenantId: agent.tenantId === undefined ? null : agent.tenantId,
      fleetId: agent.fleetId === undefined ? null : agent.fleetId,
    },
    required: { tenantId: missionTenant, fleetId: requiredFleet === undefined ? null : requiredFleet },
    inputSource: "CONTROL_PLANE",
  });
}

module.exports = { evaluate };

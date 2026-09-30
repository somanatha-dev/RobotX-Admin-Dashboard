"use strict";

/**
 * The **physical provider** — the inputs the assignment engine reads for a physical agent,
 * from real sources only. P1: the boundary, and only what is already legitimately real.
 *
 * ── What a physical agent is given today ───────────────────────────────────
 *   agentFactsFor            the half of `agentFacts.service` that is derived from real rows —
 *                            session, health tier, position freshness, charger reservations,
 *                            the deployment's tenant — labelled `PHYSICAL_DERIVED_ONLY` by that
 *                            module. The control-plane half (commissioning, hold, firmware,
 *                            calibrations, e-stop, faults, localisation, reliability,
 *                            advisories, zones, maintenance, link) has no physical source and
 *                            stays ABSENT, so §7.5 denies by name.
 *   vehicleMassKgFor         `Robot.massKg`, the commissioning column, off the snapshot.
 *   batteryWearInputsFor     the V1 wear model (`v1DemonstrationComposition.batteryWearInputsFor`,
 *                            labelled V1_DEMONSTRATION, never DEVELOPMENT_SIMULATION) over the
 *                            agent's OWN pack, SoH and SoC. With no measured SoC it returns
 *                            null. It is handed to both kinds of agent today; kept so.
 *
 * ── What a physical agent is NOT given — each is absent, never substituted ─
 *   position / GPS, battery / SoC, e-stop, faults, health beyond `Robot.status`, charging
 *   state, route, route descriptor, speed, return-leg energy, energy declarations,
 *   environment, forecast, thermal multiplier, failure probability, route hazard, execution
 *   geometry. No simulation declaration is copied here, and this module imports nothing
 *   from `src/simulation/` directly. The two shared functions it calls — the derived half of
 *   `agentFacts.service` and the V1 wear model — read only the agent's own rows, and a facts
 *   object labelled as simulator-stated is refused below rather than passed on.
 *
 * So a physical agent stays unassignable for the same missing-data reasons as before this
 * boundary existed. Each later phase fills one of the absences above from a real source,
 * here, without touching the engine.
 *
 * ── Routing ────────────────────────────────────────────────────────────────
 * `profileKeyFor` answers `null` — the coordinator then keys the traversal by the agent's
 * traversal domain, exactly as before. The `PHYSICAL:` namespace is reserved for the
 * physical routing producer when it exists. A route asked of this provider is refused by
 * name: it never falls through to the simulation router.
 */

const { createAgentFactsProvider } = require("../agentFacts.service");
const { RouteRefusedError, ROUTE_REFUSAL } = require("../../engine/routing/productionRouter");
const v1DemonstrationComposition = require("../v1DemonstrationComposition");

/** @structural the provider's name, for logs and diagnostics only */
const ID = "PHYSICAL";

/**
 * The routing-profile namespace reserved for a physical agent's key once a physical routing
 * producer exists (`PHYSICAL:<classId>`). Not issued in P1.
 * @structural
 */
const PHYSICAL_PROFILE_NAMESPACE = "PHYSICAL:";

/**
 * The provenance label `agentFacts.service` gives a facts object it built from the
 * simulator. The physical provider refuses to pass one on — a guard for a misrouted call,
 * which the dispatcher should never make.
 * @structural a label, not a value
 */
const SIMULATED_FACTS_PROVENANCE = "DEVELOPMENT_SIMULATION";

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * @param {object} settings
 * @param {object} settings.prisma
 * @param {object} [settings.kv]
 * @param {string} [settings.tenantId] the deployment's single tenant, when it has one
 * @returns {object} the provider
 */
function createPhysicalProvider(settings) {
  const { prisma, kv, tenantId } = settings || {};
  if (!prisma) throw new TypeError("createPhysicalProvider requires prisma");

  const derivedFacts = createAgentFactsProvider({ prisma, kv, tenantId });

  const seams = Object.freeze({
    /* ── agent facts (§7.5): the real, derived half only ─────────────────── */
    async agentFactsFor(input) {
      const facts = await derivedFacts(input);
      // Never pass on simulator-stated facts, whatever the caller routed here.
      if (facts && facts.provenance === SIMULATED_FACTS_PROVENANCE) return null;
      return facts;
    },

    /* ── commissioning columns, read off the agent's own snapshot ────────── */
    vehicleMassKgFor: (agentClassId, agentSnapshot) =>
      agentSnapshot && isNumber(agentSnapshot.vehicleMassKg) ? agentSnapshot.vehicleMassKg : null,
    batteryWearInputsFor: (agentSnapshot, plan) => v1DemonstrationComposition.batteryWearInputsFor(agentSnapshot, plan),

    /* ── routing (§5): no physical producer yet ──────────────────────────── */
    profileKeyFor: () => null,
    speedMetresPerSecondFor: () => undefined,
    returnLegEnergyWhPerMetreFor: () => undefined,
    async route(parts) {
      const profileKey = parts && parts.profileKey;
      throw new RouteRefusedError(
        ROUTE_REFUSAL.NOT_ROUTABLE,
        `no physical routing producer is composed, so profile "${profileKey}" has no route. A physical agent is ` +
          "never routed on the simulation router; it is refused until its own routing producer exists",
        { provider: ID, profileKey: profileKey === undefined ? null : profileKey },
      );
    },
    routeDescriptorFor: () => undefined,
    directionsFor: () => undefined,

    /* ── energy, environment and Φ inputs: no physical source ────────────── */
    agentEnergyDeclarationsFor: () => null,
    environmentFor: () => null,
    environmentForecastFor: () => undefined,
    thermalStressMultiplierFor: () => undefined,
    failureProbabilityFor: () => null,
    routeHazardCuFor: () => null,
  });

  return Object.freeze({
    id: ID,
    seams,
    /**
     * No Charging Scheduler covers a physical agent (B2), so whether it is charging is
     * unestablished and the index maintainer leaves it out — never a fabricated answer.
     */
    chargingInScope: async () => false,
  });
}

module.exports = {
  ID,
  PHYSICAL_PROFILE_NAMESPACE,
  createPhysicalProvider,
};

"use strict";

/**
 * P1 — the frozen V1 regression gate, run THROUGH the fleet provider boundary.
 *
 * `tools/demo/runV1Assignment.js` is the V1 regression gate and is not edited. This wrapper
 * runs it unchanged, with the two compositions it builds routed through
 * `src/services/fleetProviders`:
 *
 *   · `v1DemonstrationComposition.createV1DemonstrationComposition` → the composition the
 *     runner builds is wrapped in the simulation provider, paired with a physical provider,
 *     and dispatched by `createFleetComposition` — exactly what `server.js` spreads when
 *     `FLEET_PROVIDER_DISPATCH=true`;
 *   · `chargingStatus.createChargingStatusReader` → its scope predicate is answered through
 *     `createChargingScope`, with the runner's own roster as the simulation provider's.
 *
 * Both are replaced on the module export objects **before** the runner is loaded, and the
 * runner reads both through those objects at call time. Nothing else changes: same
 * database, same seed, same scenarios, same invariants I1–I8, same exit code.
 *
 * Usage (loopback PostgreSQL only, exactly as the runner):
 *   node tools/verify/p1FleetProviderScenarios.js <postgres-url> --scenario A|B|failures [--json <path>]
 */

const v1Composition = require("../../src/services/v1DemonstrationComposition");
const chargingStatus = require("../../src/services/chargingStatus.service");
const profile = require("../../src/services/v1DemonstrationProfile");
const fleetProviders = require("../../src/services/fleetProviders");

const originalCompose = v1Composition.createV1DemonstrationComposition;
const originalReader = chargingStatus.createChargingStatusReader;

const counts = { compositions: 0, chargingReaders: 0 };

v1Composition.createV1DemonstrationComposition = function composeThroughTheBoundary(settings) {
  const simulation = fleetProviders.simulationProvider.createSimulationProvider({ composition: originalCompose(settings) });
  const physical = fleetProviders.physicalProvider.createPhysicalProvider({
    prisma: settings.prisma,
    kv: settings.kv,
    tenantId: profile.DEMONSTRATION_TENANT_ID,
  });
  const composed = fleetProviders.createFleetComposition({ simulation, physical });
  if (!fleetProviders.isFleetComposition(composed)) throw new Error("the fleet provider boundary did not compose");
  counts.compositions += 1;
  return composed;
};

chargingStatus.createChargingStatusReader = function readerThroughTheBoundary(deps) {
  const physical = fleetProviders.physicalProvider.createPhysicalProvider({ prisma: deps.prisma });
  counts.chargingReaders += 1;
  return originalReader({
    ...deps,
    inScope: fleetProviders.createChargingScope({ simulation: { chargingInScope: deps.inScope }, physical }),
  });
};

process.on("exit", (code) => {
  process.stderr.write(
    `[p1] fleet provider boundary: ${counts.compositions} coordinator composition(s) and ` +
      `${counts.chargingReaders} charging reader(s) built through it; runner exit ${code}\n`,
  );
  if (counts.compositions === 0) process.stderr.write("[p1] WARNING: the runner never built a composition through the boundary\n");
});

require("../demo/runV1Assignment");

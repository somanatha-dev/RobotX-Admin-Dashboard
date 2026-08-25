const configService = require("../src/engine/config/service");
const spatialHierarchy = require("../src/engine/spatial/hierarchy");

// Required and constructed lazily rather than at module load. Phase 2's engine
// tests read `SEED_SPATIAL_MAP` from this file to prove the seeded map satisfies
// §3.6 containment, and importing a module should neither bring a database client
// into existence nor require the Prisma client to have been generated.
let prismaClient = null;
function getPrisma() {
  if (!prismaClient) {
    const { PrismaClient } = require("@prisma/client");
    prismaClient = new PrismaClient();
  }
  return prismaClient;
}

/**
 * The seeded spatial map (§3.6) — Phase 2.
 *
 * Containment is by **published assignment**, not by geometry: a zone is a set of
 * fine cells and a site is a set of fine cells plus its indoor graph zones. This
 * object is the published map in the shape the Config Service validates (V8) and
 * `spatial/hierarchy.js` indexes, so the same declaration serves the configuration
 * payload, the `CellAssignment` durable mirror, and the containment resolver.
 *
 * Cell ids are opaque tokens. Choosing the index primitive — H3 versus S2 — is
 * blocking decision B5, which belongs to Phase 9; §3.6 needs only that a fine cell
 * maps to exactly one zone and at most one site, which is a property of the map and
 * not of the primitive.
 */
const SEED_SPATIAL_MAP = {
  regions: [{ id: "RGN-BLR", name: "Bengaluru operating region" }],
  zones: [
    { id: "ZN-RRNAGAR", regionId: "RGN-BLR", name: "Rajarajeshwari Nagar" },
    { id: "ZN-RNSIT", regionId: "RGN-BLR", name: "RNSIT campus and approaches" },
  ],
  sites: [{ id: "STE-RNSIT", regionId: "RGN-BLR", name: "RNS Institute of Technology" }],
  cells: [
    { cellId: "cell-rrnagar-fine-01", resolution: "FINE", regionId: "RGN-BLR", zoneId: "ZN-RRNAGAR", siteId: null },
    { cellId: "cell-rrnagar-fine-02", resolution: "FINE", regionId: "RGN-BLR", zoneId: "ZN-RRNAGAR", siteId: null },
    { cellId: "cell-rnsit-fine-01", resolution: "FINE", regionId: "RGN-BLR", zoneId: "ZN-RNSIT", siteId: "STE-RNSIT" },
    { cellId: "cell-rnsit-fine-02", resolution: "FINE", regionId: "RGN-BLR", zoneId: "ZN-RNSIT", siteId: "STE-RNSIT" },
    { cellId: "cell-blr-coarse-01", resolution: "COARSE", regionId: "RGN-BLR", zoneId: null, siteId: null },
  ],
};

async function main() {
  const prisma = getPrisma();
  console.log("🌱 Minimal seeding started...");

  //////////////////////////////////////////////////
  // 1. LOCATION TREE (ONLY REQUIRED)
  //////////////////////////////////////////////////

  const india = await prisma.location.upsert({
    where: { slug: "india" },
    update: {},
    create: {
      name: "India",
      slug: "india",
      type: "COUNTRY",
      lat: 20.5937,
      lon: 78.9629
    }
  });

  const karnataka = await prisma.location.upsert({
    where: { slug: "karnataka" },
    update: {},
    create: {
      name: "Karnataka",
      slug: "karnataka",
      type: "STATE",
      parentId: india.id,
      lat: 15.3173,
      lon: 75.7139
    }
  });

  const bengaluru = await prisma.location.upsert({
    where: { slug: "bengaluru" },
    update: {},
    create: {
      name: "Bengaluru",
      slug: "bengaluru",
      type: "CITY",
      parentId: karnataka.id,
      lat: 12.9716,
      lon: 77.5946
    }
  });

  const rrNagar = await prisma.location.upsert({
    where: { slug: "rr-nagar" },
    update: {},
    create: {
      name: "Rajarajeshwari Nagar",
      slug: "rr-nagar",
      type: "AREA",
      parentId: bengaluru.id,
      lat: 12.9279,
      lon: 77.5150
    }
  });

  //////////////////////////////////////////////////
  // 2. CAMPUS
  //////////////////////////////////////////////////

  //
  // A Campus row is the JOIN between the database and the frontend campus
  // registry: `Campus.code` is the key `Frontend/src/features/maps/campus/
  // campusRegistry.js` looks its geometry up by, and `centerLat/centerLon` is
  // the only campus-scale coordinate this system OWNS — the map reads the centre
  // from here rather than hard-coding it, so the two cannot drift apart.
  //
  // Adding a campus to the map is therefore two things and no more: a row here,
  // and a dataset + entry in the registry. There is no third step, and nothing
  // in the renderer, the camera, the themes or the search changes.
  //
  // Both centres are cross-checked against their campus's imported boundary at
  // render time (`centreWithinBoundary`), which is what catches a row wired to
  // the wrong campus's dataset — geometry from the wrong site would otherwise
  // load, validate and draw perfectly, kilometres from where the record says.
  const CAMPUSES = [
    {
      code: "RNSIT",
      name: "RNS Institute of Technology",
      centerLat: 12.9023,
      centerLon: 77.5186
    },
    {
      // JSS Academy of Technical Education, Bengaluru — India / Karnataka /
      // Bengaluru, on Dr. Vishnuvardhan Road, Kengeri.
      //
      // The centre is the vertex centroid of the campus site polygon in the
      // OpenStreetMap extract (way/106873634, `amenity=college`) — derived from
      // the imported boundary rather than estimated off a satellite image, and
      // it falls inside that boundary. It is a SEED_RECORD like RNSIT's and is
      // rendered NOT_VERIFIED: nobody has stood on it.
      code: "jssate-bengaluru",
      name: "JSS Academy of Technical Education",
      centerLat: 12.9027,
      centerLon: 77.5050
    }
  ];

  for (const campus of CAMPUSES) {
    await prisma.campus.upsert({
      where: { code: campus.code },
      update: {},
      create: campus
    });
  }

  //////////////////////////////////////////////////
  // 3. PARAMETER REGISTER (§22, Appendix A + §8.10) — Phase 1
  //
  // Mirrors src/engine/config/register/*.json into ParameterRegisterEntry rows so
  // the register is queryable and the resolution-explain endpoint can report an
  // entry's unit, owner, range, and calibration status. The JSON files remain the
  // source of truth — the build gate reads them — and this upsert is idempotent, so
  // re-seeding is safe.
  //
  // Seeding the register is NOT publishing a configuration version. A version is an
  // explicit, approved, validated act (§22.1 rule 5, §22.3).
  //////////////////////////////////////////////////

  const { seeded } = await configService.seedRegister(prisma);
  console.log(`🔧 Parameter register mirrored: ${seeded} entries`);

  //////////////////////////////////////////////////
  // 4. SPATIAL HIERARCHY (§3.6) — Phase 2
  //
  // Region → Site / Zone → Cell, published as an assignment map and mirrored into
  // Region, Site, Zone.regionId, and CellAssignment.
  //
  // Validated before it is written. §3.6's containment rules are what make
  // `Ω_terminal` bound anything the shard can reach (§6.4); seeding a map that
  // breaks them would put the defect in the database rather than in a rejection.
  // The same rules are enforced at publish time by the Config Service's V8 check.
  //////////////////////////////////////////////////

  const verdict = spatialHierarchy.validate(SEED_SPATIAL_MAP);
  if (!verdict.ok) {
    throw new Error(
      `seeded spatial map violates §3.6 containment: ${verdict.problems.join("; ")}`,
    );
  }

  const regionRows = new Map();
  for (const region of SEED_SPATIAL_MAP.regions) {
    const row = await prisma.region.upsert({
      where: { regionId: region.id },
      update: { name: region.name },
      create: { regionId: region.id, name: region.name },
    });
    regionRows.set(region.id, row);
  }

  const siteRows = new Map();
  for (const site of SEED_SPATIAL_MAP.sites) {
    const row = await prisma.site.upsert({
      where: { siteId: site.id },
      update: { name: site.name, regionId: regionRows.get(site.regionId).id },
      create: { siteId: site.id, name: site.name, regionId: regionRows.get(site.regionId).id },
    });
    siteRows.set(site.id, row);
  }

  // Zones already exist as legacy DTARO bounding boxes. The seed attaches the
  // region to the zone of that name where one exists and creates it otherwise; the
  // bounding box is legacy state and is not what containment resolves from.
  const zoneRows = new Map();
  for (const zone of SEED_SPATIAL_MAP.zones) {
    const existing = await prisma.zone.findUnique({ where: { name: zone.name } });
    const row = existing
      ? await prisma.zone.update({ where: { id: existing.id }, data: { regionId: regionRows.get(zone.regionId).id } })
      : await prisma.zone.create({
          data: {
            name: zone.name,
            regionId: regionRows.get(zone.regionId).id,
            // Degenerate box: containment is by assignment (§3.6), so these bounds
            // are never read by the engine. They exist because the legacy column is
            // NOT NULL and Phase 2 does not alter it.
            minLat: 0,
            maxLat: 0,
            minLon: 0,
            maxLon: 0,
          },
        });
    zoneRows.set(zone.id, row);
  }

  let cellCount = 0;
  for (const cell of SEED_SPATIAL_MAP.cells) {
    const data = {
      cellId: cell.cellId,
      resolution: cell.resolution,
      regionId: regionRows.get(cell.regionId).id,
      zoneId: cell.zoneId ? zoneRows.get(cell.zoneId).id : null,
      siteId: cell.siteId ? siteRows.get(cell.siteId).id : null,
    };
    await prisma.cellAssignment.upsert({
      where: { cellId_mapVersion: { cellId: cell.cellId, mapVersion: 0 } },
      update: data,
      create: { ...data, mapVersion: 0 },
    });
    cellCount += 1;
  }

  console.log(
    `🗺️  Spatial hierarchy seeded: ${regionRows.size} region(s), ${siteRows.size} site(s), ` +
      `${zoneRows.size} zone(s), ${cellCount} cell assignment(s)`,
  );

  //////////////////////////////////////////////////
  // 5. AGENT CLASS AND ITS MODELS (§2.1–§2.3, §15.2) — Phase 2
  //
  // One default class, so that a backfilled Agent has a class to key its
  // model-specific parameter sets from. The numbers are declarative placeholders,
  // not calibrated values — Phase 7 owns the energy model's β coefficients and
  // Phase 6 owns the predicates that read the container model.
  //////////////////////////////////////////////////

  const mobility = await prisma.mobilityModel.upsert({
    where: { modelId: "MOB-SIDEWALK-DEFAULT" },
    update: {},
    create: {
      modelId: "MOB-SIDEWALK-DEFAULT",
      name: "Default sidewalk courier",
      traversalDomain: "SIDEWALK_GRAPH",
      permissionSet: { roadClasses: ["footway", "path", "service"], stairCapable: false },
      speedModel: { note: "Populated by the routing integration in Phases 7–9 (blocking decision B1)" },
      kinematicLimits: { maxSpeedMps: 1.5, maxGradient: 0.08 },
      envelopeConstraints: { maxWindMps: null, minVisibilityM: null },
      dimensionalFootprint: { widthMm: 600, heightMm: 900, lengthMm: 800 },
    },
  });

  const energy = await prisma.energyModel.upsert({
    where: { modelId: "ENG-SIDEWALK-DEFAULT" },
    update: {},
    create: {
      modelId: "ENG-SIDEWALK-DEFAULT",
      name: "Default sidewalk courier pack",
      packNominalWh: 500,
      chemistry: "LFP",
      consumptionCoefficients: { note: "β coefficients are fitted in Phase 7 (§14.2); none is asserted here" },
      thermalDeratingCurve: null,
      chargePowerCurve: null,
    },
  });

  const container = await prisma.containerModel.upsert({
    where: { modelId: "CTR-SIDEWALK-DEFAULT" },
    update: {},
    create: {
      modelId: "CTR-SIDEWALK-DEFAULT",
      name: "Default single-compartment locker",
      totalMassLimitKg: 20,
      totalVolumeLitres: 60,
      loadingInterface: "HUMAN_HANDOVER",
      cleanlinessClass: "GENERAL",
      compartments: {
        create: [
          {
            ordinal: 0,
            internalLengthMm: 500,
            internalWidthMm: 400,
            internalHeightMm: 350,
            // §15.2: the aperture is modelled separately because it is a distinct
            // and frequently binding constraint a volume-based model misses.
            apertureWidthMm: 380,
            apertureHeightMm: 300,
            maxMassKg: 20,
            thermalClass: "AMBIENT",
            activeThermal: false,
            lockClass: "ELECTRONIC",
            tamperSensing: false,
            accessSide: "REAR",
          },
        ],
      },
    },
  });

  const bundle = await prisma.capabilityBundle.upsert({
    where: { bundleId: "CAP-SIDEWALK-DEFAULT" },
    update: {},
    create: {
      bundleId: "CAP-SIDEWALK-DEFAULT",
      name: "Default sidewalk courier capabilities",
      capabilities: {
        create: [
          {
            // §2.3: defaults to false, and the default is the realistic case —
            // most sidewalk delivery robots have no manipulator, no mutually
            // accessible compartment interface, and no docking-compatible pair.
            name: "custody_transfer_capable",
            kind: "BOOLEAN",
            value: false,
            source: "COMMISSIONING_RECORD",
          },
          {
            name: "secure_locker",
            kind: "BOOLEAN",
            value: true,
            source: "COMMISSIONING_RECORD",
          },
          {
            name: "max_payload_mass",
            kind: "QUANTITATIVE",
            value: 20,
            unit: "kg",
            source: "HARDWARE_MANIFEST",
          },
        ],
      },
    },
  });

  const agentClass = await prisma.agentClass.upsert({
    where: { classId: "AC-SIDEWALK-DEFAULT" },
    update: {
      mobilityModelId: mobility.id,
      energyModelId: energy.id,
      containerModelId: container.id,
      capabilityBundleId: bundle.id,
    },
    create: {
      classId: "AC-SIDEWALK-DEFAULT",
      name: "Default sidewalk courier",
      mobilityModelId: mobility.id,
      energyModelId: energy.id,
      containerModelId: container.id,
      capabilityBundleId: bundle.id,
    },
  });

  console.log(`🤖 Agent class seeded: ${agentClass.classId}`);
  console.log(
    "   capacity[agent_class] is a register parameter with default 1 (§27 item 7); it is not a column.",
  );

  console.log("✅ Minimal seeding completed");
}

module.exports = { SEED_SPATIAL_MAP, main };

if (require.main === module) {
  main()
    .catch(console.error)
    .finally(() => getPrisma().$disconnect());
}
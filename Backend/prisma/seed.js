const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
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

  await prisma.campus.upsert({
    where: { code: "RNSIT" },
    update: {},
    create: {
      code: "RNSIT",
      name: "RNS Institute of Technology",
      centerLat: 12.9023,
      centerLon: 77.5186
    }
  });

  console.log("✅ Minimal seeding completed");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
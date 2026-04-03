const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcrypt");
const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding started...");

  //////////////////////////////////////////////////
  // 0. OPTIONAL: SUPER ADMIN USER
  //////////////////////////////////////////////////

  const adminEmail = String(process.env.SEED_ADMIN_EMAIL || process.env.ADMIN_EMAIL || "").trim();
  const adminPassword = String(process.env.SEED_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "");

  if (adminEmail && adminPassword) {
    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    await prisma.user.upsert({
      where: { email: adminEmail },
      update: {
        password: hashedPassword,
        role: "SUPER_ADMIN",
      },
      create: {
        email: adminEmail,
        password: hashedPassword,
        role: "SUPER_ADMIN",
      },
    });

    console.log(`✅ Admin user seeded: ${adminEmail}`);
  } else {
    console.log("ℹ️ Admin user not seeded (set SEED_ADMIN_EMAIL + SEED_ADMIN_PASSWORD)");
  }

  //////////////////////////////////////////////////
  // 1. LOCATION TREE
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

  const areas = [
    { name: "Rajarajeshwari Nagar", slug: "rr-nagar", lat: 12.9279, lon: 77.5150 },
    { name: "Jayanagar", slug: "jayanagar", lat: 12.9250, lon: 77.5938 },
    { name: "JP Nagar", slug: "jp-nagar", lat: 12.9063, lon: 77.5857 },
    { name: "MG Road", slug: "mg-road", lat: 12.9758, lon: 77.6065 }
  ];

  const areaRecords = [];

  for (const area of areas) {
    const record = await prisma.location.upsert({
      where: { slug: area.slug },
      update: {},
      create: {
        name: area.name,
        slug: area.slug,
        type: "AREA",
        parentId: bengaluru.id,
        lat: area.lat,
        lon: area.lon
      }
    });

    areaRecords.push(record);
  }

  //////////////////////////////////////////////////
  // 2. OPTIONAL: CAMPUS
  //////////////////////////////////////////////////

  const campus = await prisma.campus.upsert({
    where: { code: "RNSIT" },
    update: {},
    create: {
      code: "RNSIT",
      name: "RNS Institute of Technology",
      centerLat: 12.9023,
      centerLon: 77.5186
    }
  });

  //////////////////////////////////////////////////
  // 3. OPTIONAL: SAMPLE ROBOTS
  //////////////////////////////////////////////////

  const robots = [
    {
      robotId: "RBT-001",
      locationId: areaRecords[0].id,
      campusId: campus.id,
      lat: 12.928,
      lon: 77.515
    },
    {
      robotId: "RBT-002",
      locationId: areaRecords[1].id,
      lat: 12.925,
      lon: 77.594
    }
  ];

  for (const robot of robots) {
    await prisma.robot.upsert({
      where: { robotId: robot.robotId },
      update: {},
      create: {
        ...robot,
        status: "IDLE",
        isOnline: false
      }
    });
  }

  console.log("✅ Seeding completed");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
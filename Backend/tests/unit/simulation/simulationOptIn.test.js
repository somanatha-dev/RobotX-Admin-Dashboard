/**
 * STEP 1 — simulation is explicitly opt-in, and isolated at the robot lifecycle boundary.
 *
 * The truth statement these tests exist to hold:
 *
 *   > Physical robots are explicitly `simulated = false` by default and cannot be
 *   > replaced, spawned, or marked online by the simulator. Simulation is opt-in and
 *   > isolated at the robot lifecycle boundary.
 *
 * Tests A–F below each take one clause of that sentence. They drive the **production**
 * modules — `rehydrate.js` is the function `server.js` calls at boot, `SimulationEngine`
 * is the object it calls it with, and the KV is the real `kv` facade in its in-memory
 * mode — rather than re-implementing the decision in the test, because the defect class
 * this whole step addresses is precisely a decision that lived in three places.
 */

const path = require("path");
const fs = require("fs");

const simulationPolicy = require("../../../src/simulation/simulationPolicy");
const { createVirtualRobotSimulator } = require("../../../src/simulation/SimulationEngine");
const { rehydrateSimulatedRobots } = require("../../../src/simulation/rehydrate");
const VirtualRobot = require("../../../src/simulation/VirtualRobot");
const robotService = require("../../../src/services/robot.service");
const { createMockPrisma } = require("../../helpers/mockPrisma");
const { createTestKv } = require("../../helpers/testKv");

const silentLogger = { info() {}, warn() {}, error() {} };

/** A Prisma stand-in whose `Robot` table is the given rows. */
function prismaWithRobots(rows) {
  const prisma = createMockPrisma();
  prisma.robot.findMany.mockImplementation(async ({ where } = {}) => {
    if (where && where.simulated === true) return rows.filter((r) => r.simulated === true);
    return rows;
  });
  prisma.robot.findUnique.mockImplementation(async ({ where } = {}) =>
    rows.find((r) => r.robotId === where?.robotId) || null,
  );
  return prisma;
}

/**
 * A simulator double that records what it was asked to spawn.
 *
 * Used only where the assertion is about the *caller* (the boot path). Where the assertion
 * is about the engine's own refusal, the real engine is used.
 */
function recordingSimulator() {
  const asked = [];
  return {
    asked,
    async addRobot(config) {
      asked.push(config);
      return { started: true, reason: null };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST A — a physical robot never gets a VirtualRobot
// ═══════════════════════════════════════════════════════════════════════════

describe("Test A — a physical Robot never receives a VirtualRobot", () => {
  test("boot re-hydration does not even ask the simulator about a physical row", async () => {
    const prisma = prismaWithRobots([
      { robotId: "PHYS-1", lat: 12.9, lon: 77.5, simulated: false },
      { robotId: "PHYS-2", lat: 12.9, lon: 77.5, simulated: false },
    ]);
    const simulator = recordingSimulator();

    const outcome = await rehydrateSimulatedRobots({
      prisma,
      simulator,
      logger: silentLogger,
      enabled: true, // simulator explicitly ON — the row is what refuses, not the switch
    });

    expect(simulator.asked).toEqual([]);
    expect(outcome.considered).toBe(0);
    expect(outcome.spawned).toBe(0);

    // The query itself is filtered, so a physical row is never even a candidate.
    expect(prisma.robot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { simulated: true } }),
    );
  });

  test("the engine refuses a physical row even when a caller asserts it is simulated", async () => {
    // The case that matters: a caller that is wrong, or a future feature that copies the
    // old call site. The database row is the authority, and it says physical.
    const prisma = prismaWithRobots([
      { robotId: "PHYS-1", lat: 12.9, lon: 77.5, simulated: false, battery: 90 },
    ]);
    const engine = createVirtualRobotSimulator({
      prisma,
      kv: null,
      serverUrl: "http://127.0.0.1:0",
      logger: silentLogger,
      enabled: true,
    });
    engine.start();

    const result = await engine.addRobot({
      robotId: "PHYS-1",
      lat: 12.9,
      lon: 77.5,
      simulated: true, // a lie
    });

    expect(result).toEqual({ started: false, reason: "ROBOT_NOT_SIMULATED" });
    expect(engine.getStatus().robotCount).toBe(0);
  });

  test("a row whose simulated flag could not be read is refused, not assumed", async () => {
    const prisma = createMockPrisma();
    prisma.robot.findUnique.mockRejectedValue(new Error("connection reset"));

    const engine = createVirtualRobotSimulator({
      prisma,
      kv: null,
      serverUrl: "http://127.0.0.1:0",
      logger: silentLogger,
      enabled: true,
    });
    engine.start();

    const result = await engine.addRobot({ robotId: "PHYS-1", simulated: true });
    expect(result.started).toBe(false);
    expect(result.reason).toBe("ROBOT_ROW_UNREADABLE");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST B — a simulated robot can be re-hydrated
// ═══════════════════════════════════════════════════════════════════════════

describe("Test B — a simulated Robot is re-hydrated when the simulator is enabled", () => {
  test("boot passes the simulated row, and only the simulated row, to the simulator", async () => {
    const prisma = prismaWithRobots([
      { robotId: "PHYS-1", lat: 12.9, lon: 77.5, simulated: false },
      { robotId: "SIM-1", lat: 12.91, lon: 77.51, simulated: true },
      { robotId: "SIM-2", lat: 12.92, lon: 77.52, simulated: true },
    ]);
    const simulator = recordingSimulator();

    const outcome = await rehydrateSimulatedRobots({
      prisma,
      simulator,
      logger: silentLogger,
      enabled: true,
    });

    expect(simulator.asked.map((c) => c.robotId)).toEqual(["SIM-1", "SIM-2"]);
    expect(outcome).toMatchObject({ enabled: true, considered: 2, spawned: 2, refused: [] });
  });

  test("the real engine constructs and registers a VirtualRobot for a simulated row", async () => {
    const { kv, close } = await createTestKv();
    try {
      const prisma = prismaWithRobots([
        { robotId: "SIM-1", lat: 12.91, lon: 77.51, simulated: true, battery: 77 },
      ]);
      const engine = createVirtualRobotSimulator({
        prisma,
        kv,
        serverUrl: "http://127.0.0.1:0",
        logger: silentLogger,
        enabled: true,
      });
      // Deliberately not `start()`ed: the robot is constructed, credentialed and
      // registered, but no socket is opened, so the test needs no listening server.
      const result = await engine.addRobot({ robotId: "SIM-1", simulated: true });

      expect(result).toEqual({ started: false, reason: "ENGINE_NOT_STARTED" });
      const status = engine.getStatus();
      expect(status.robotCount).toBe(1);
      expect(status.robots[0].robotId).toBe("SIM-1");
      // Its pack was restored from the DB row rather than invented.
      expect(status.robots[0].battery).toBe(77);
      // And its simulator session key exists, because for a simulated unit that key IS
      // the robot's credential.
      expect(await kv.get("session:SIM-1")).toBeTruthy();
    } finally {
      await close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST C — a physical robot's session/credential state is never touched
// ═══════════════════════════════════════════════════════════════════════════

describe("Test C — physical credentials survive repeated simulator lifecycles", () => {
  test("session and live-state keys are byte-identical after many sim start/stop cycles", async () => {
    const { kv, close } = await createTestKv();
    try {
      // ── The physical robot, as it exists after commissioning and pairing ──
      const PHYSICAL_SESSION = "physical-session-token-issued-by-pairing";
      const PHYSICAL_LIVE = JSON.stringify({
        lat: 12.8, lon: 77.4, battery: 63, status: "IDLE", speed: 0, lastSeenAt: 1_700_000_000_000,
      });
      await kv.set("session:PHYS-1", PHYSICAL_SESSION, { ex: 3600 });
      await kv.set("robot:PHYS-1", PHYSICAL_LIVE, { ex: 3600 });

      const prisma = prismaWithRobots([
        { robotId: "PHYS-1", lat: 12.8, lon: 77.4, simulated: false, battery: 63 },
        { robotId: "SIM-1", lat: 12.9, lon: 77.5, simulated: true, battery: 100 },
      ]);

      // ── Five simulator lifecycles, each a fresh engine, as a restart is ──
      for (let cycle = 0; cycle < 5; cycle += 1) {
        const engine = createVirtualRobotSimulator({
          prisma,
          kv,
          serverUrl: "http://127.0.0.1:0",
          logger: silentLogger,
          enabled: true,
        });

        // The legitimate path: re-hydrate whatever the DB says is simulated.
        await rehydrateSimulatedRobots({
          prisma,
          simulator: engine,
          logger: silentLogger,
          enabled: true,
        });

        // And the hostile paths, on every cycle: a caller naming the physical robot, and
        // a VirtualRobot constructed directly against it.
        await engine.addRobot({ robotId: "PHYS-1", simulated: true });

        const rogue = new VirtualRobot({ robotId: "PHYS-1", lat: 12.8, lon: 77.4, logger: silentLogger });
        await expect(rogue.commission(kv)).rejects.toThrow(/not marked simulated/i);

        engine.stop();
      }

      // ── The physical robot's credential and live state are exactly as left ──
      expect(await kv.get("session:PHYS-1")).toBe(PHYSICAL_SESSION);
      expect(await kv.get("robot:PHYS-1")).toBe(PHYSICAL_LIVE);

      // The simulated robot, by contrast, does hold a simulator-minted session — which is
      // correct: for a simulated unit the simulator *is* the robot.
      expect(await kv.get("session:SIM-1")).toBeTruthy();
      expect(await kv.get("session:SIM-1")).not.toBe(PHYSICAL_SESSION);
    } finally {
      await close();
    }
  });

  test("VirtualRobot.commission refuses before writing anything at all", async () => {
    const { kv, close } = await createTestKv();
    try {
      const writes = [];
      const spy = {
        async set(key, value, opts) { writes.push(key); return kv.set(key, value, opts); },
        async get(key) { return kv.get(key); },
        async sadd(key, member) { writes.push(key); return kv.sadd(key, member); },
      };

      const rogue = new VirtualRobot({ robotId: "PHYS-1", logger: silentLogger });
      await expect(rogue.commission(spy)).rejects.toMatchObject({ code: "ROBOT_NOT_SIMULATED" });

      // Not "wrote and rolled back" — never wrote.
      expect(writes).toEqual([]);
    } finally {
      await close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST D — no fabricated online state
// ═══════════════════════════════════════════════════════════════════════════

describe("Test D — a commissioned physical Robot with no connection stays offline", () => {
  const SPEC = Object.freeze({
    massKg: 45,
    maxSpeedMps: 2.5,
    normalSpeedMps: 1.4,
    batteryCapacityWh: 500,
    batteryReservePct: 15,
    payloadCapacityKg: 20,
    initialBatteryPct: 82,
  });

  function commissioningPrisma() {
    const prisma = createMockPrisma();
    prisma.robot.findUnique.mockResolvedValue(null);
    prisma.location.findUnique.mockResolvedValue({ id: "loc-1", lat: 12.9, lon: 77.5 });
    prisma.robot.create = jest.fn(async ({ data }) => ({ id: "robot-row-1", ...data }));
    prisma.mobilityModel.upsert.mockImplementation(async ({ create }) => ({ id: "mob-1", ...create }));
    prisma.energyModel.upsert.mockImplementation(async ({ create }) => ({ id: "eng-1", ...create }));
    prisma.containerModel.upsert.mockImplementation(async ({ create }) => ({ id: "ctr-1", ...create }));
    prisma.capabilityBundle.upsert.mockImplementation(async ({ create }) => ({ id: "cap-1", ...create }));
    prisma.capability.deleteMany.mockResolvedValue({ count: 0 });
    prisma.capability.create.mockImplementation(async ({ data }) => data);
    prisma.agentClass.upsert.mockImplementation(async ({ create }) => ({ id: "class-1", ...create }));
    prisma.agent.upsert.mockImplementation(async ({ create }) => ({ id: "agent-1", ...create }));
    return prisma;
  }

  const BODY = Object.freeze({
    robotId: "PHYS-1",
    name: "Physical Rover",
    locationId: "loc-1",
    chassisType: "Rover (Ground)",
    specification: SPEC,
  });

  test("commissioning writes isOnline: false — a record is not a session", async () => {
    const prisma = commissioningPrisma();
    await robotService.commissionRobot(prisma, BODY);

    expect(prisma.robot.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isOnline: false }) }),
    );
  });

  test("boot re-hydration writes no liveness for anybody", async () => {
    const prisma = prismaWithRobots([
      { robotId: "PHYS-1", lat: 12.9, lon: 77.5, simulated: false },
      { robotId: "SIM-1", lat: 12.9, lon: 77.5, simulated: true },
    ]);

    await rehydrateSimulatedRobots({
      prisma,
      simulator: recordingSimulator(),
      logger: silentLogger,
      enabled: true,
    });

    // The blanket `updateMany({ data: { isOnline: true } })` this step removed.
    expect(prisma.robot.updateMany).not.toHaveBeenCalled();
    expect(prisma.robot.update).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST E — the simulator is disabled by default
// ═══════════════════════════════════════════════════════════════════════════

describe("Test E — simulation is off unless explicitly enabled", () => {
  test.each([
    ["unset", {}],
    ["empty", { ENABLE_VIRTUAL_SIMULATOR: "" }],
    ["false", { ENABLE_VIRTUAL_SIMULATOR: "false" }],
    ["1", { ENABLE_VIRTUAL_SIMULATOR: "1" }],
    ["yes", { ENABLE_VIRTUAL_SIMULATOR: "yes" }],
    ["truthy typo", { ENABLE_VIRTUAL_SIMULATOR: "ture" }],
  ])("%s → disabled", (_label, env) => {
    expect(simulationPolicy.isSimulatorEnabled(env)).toBe(false);
  });

  test.each([
    ["true", { ENABLE_VIRTUAL_SIMULATOR: "true" }],
    ["TRUE", { ENABLE_VIRTUAL_SIMULATOR: "TRUE" }],
    ["padded", { ENABLE_VIRTUAL_SIMULATOR: " true " }],
  ])("%s → enabled", (_label, env) => {
    expect(simulationPolicy.isSimulatorEnabled(env)).toBe(true);
  });

  test("the legacy benchmark kill switch still wins over an enable", () => {
    expect(
      simulationPolicy.isSimulatorEnabled({
        ENABLE_VIRTUAL_SIMULATOR: "true",
        DISABLE_VIRTUAL_SIMULATOR: "true",
      }),
    ).toBe(false);
  });

  test("with the simulator disabled, a simulated row is not started", async () => {
    const prisma = prismaWithRobots([
      { robotId: "SIM-1", lat: 12.9, lon: 77.5, simulated: true, battery: 50 },
    ]);
    const simulator = recordingSimulator();

    const outcome = await rehydrateSimulatedRobots({
      prisma,
      simulator,
      logger: silentLogger,
      enabled: false,
    });

    expect(outcome).toMatchObject({ enabled: false, considered: 0, spawned: 0 });
    expect(simulator.asked).toEqual([]);
    // Not even queried: a disabled simulator reads nothing.
    expect(prisma.robot.findMany).not.toHaveBeenCalled();
  });

  test("a disabled engine refuses addRobot for an explicitly simulated row", async () => {
    const prisma = prismaWithRobots([
      { robotId: "SIM-1", lat: 12.9, lon: 77.5, simulated: true, battery: 50 },
    ]);
    const engine = createVirtualRobotSimulator({
      prisma,
      kv: null,
      serverUrl: "http://127.0.0.1:0",
      logger: silentLogger,
      enabled: false,
    });
    engine.start();

    const result = await engine.addRobot({ robotId: "SIM-1", simulated: true });
    expect(result).toEqual({ started: false, reason: "SIMULATOR_DISABLED" });
    expect(engine.getStatus()).toMatchObject({ enabled: false, started: false, robotCount: 0 });
  });

  test("the test environment itself does not enable the simulator", () => {
    // If a future edit turned it on globally, every other assertion here would still pass
    // while production behaviour had changed. This is the one that would not.
    expect(simulationPolicy.isSimulatorEnabled(process.env)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST F — the decision is the explicit Robot.simulated flag
// ═══════════════════════════════════════════════════════════════════════════

describe("Test F — simulation identity is explicit", () => {
  test.each([
    ["explicit true", { simulated: true }, true],
    ["explicit false", { simulated: false }, false],
    ["absent", {}, false],
    ["undefined", { simulated: undefined }, false],
    ["null", { simulated: null }, false],
    ['the string "true"', { simulated: "true" }, false],
    ['the string "false"', { simulated: "false" }, false],
    ["1", { simulated: 1 }, false],
  ])("%s → %s", (_label, row, expected) => {
    expect(simulationPolicy.isSimulatedRobot(row)).toBe(expected);
  });

  test("maySpawnVirtualRobot names which of the two conditions failed", () => {
    expect(simulationPolicy.maySpawnVirtualRobot({ simulated: true }, { enabled: false })).toEqual({
      allowed: false,
      reason: "SIMULATOR_DISABLED",
    });
    expect(simulationPolicy.maySpawnVirtualRobot({ simulated: false }, { enabled: true })).toEqual({
      allowed: false,
      reason: "ROBOT_NOT_SIMULATED",
    });
    expect(simulationPolicy.maySpawnVirtualRobot({ simulated: true }, { enabled: true })).toEqual({
      allowed: true,
      reason: null,
    });
  });

  test("every module that can instantiate a VirtualRobot consults the policy", () => {
    // The structural half of "the decision is explicit": a spawn site that does not import
    // `simulationPolicy` is a spawn site that decided for itself, which is the shape of the
    // defect this step removes.
    const srcRoot = path.join(__dirname, "..", "..", "..", "src");

    const spawnSites = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) {
          const source = fs.readFileSync(full, "utf8");
          if (/new\s+VirtualRobot\s*\(/.test(source)) spawnSites.push({ full, source });
        }
      }
    };
    walk(srcRoot);

    expect(spawnSites.length).toBeGreaterThan(0);
    for (const site of spawnSites) {
      expect({
        file: path.relative(srcRoot, site.full),
        consultsPolicy: /simulationPolicy/.test(site.source),
      }).toEqual({ file: path.relative(srcRoot, site.full), consultsPolicy: true });
    }
  });

  test("the policy normalises a creation-boundary `simulated` without coercion", () => {
    expect(simulationPolicy.normaliseSimulatedInput(undefined)).toEqual({ ok: true, simulated: false });
    expect(simulationPolicy.normaliseSimulatedInput(null)).toEqual({ ok: true, simulated: false });
    expect(simulationPolicy.normaliseSimulatedInput(false)).toEqual({ ok: true, simulated: false });
    expect(simulationPolicy.normaliseSimulatedInput(true)).toEqual({ ok: true, simulated: true });
    expect(simulationPolicy.normaliseSimulatedInput("true").ok).toBe(false);
    expect(simulationPolicy.normaliseSimulatedInput(1).ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The service layer persists `simulated`, safely defaulted (requirement 7)
// ═══════════════════════════════════════════════════════════════════════════

describe("commissionRobot — physical only, `simulated` defaulted false and create-only", () => {
  const SPEC = Object.freeze({
    massKg: 45,
    maxSpeedMps: 2.5,
    normalSpeedMps: 1.4,
    batteryCapacityWh: 500,
    batteryReservePct: 15,
    payloadCapacityKg: 20,
    initialBatteryPct: 82,
  });

  function commissioningPrisma() {
    const prisma = createMockPrisma();
    prisma.robot.findUnique.mockResolvedValue(null);
    prisma.location.findUnique.mockResolvedValue({ id: "loc-1", lat: 12.9, lon: 77.5 });
    prisma.robot.create = jest.fn(async ({ data }) => ({ id: "robot-row-1", ...data }));
    prisma.mobilityModel.upsert.mockImplementation(async ({ create }) => ({ id: "mob-1", ...create }));
    prisma.energyModel.upsert.mockImplementation(async ({ create }) => ({ id: "eng-1", ...create }));
    prisma.containerModel.upsert.mockImplementation(async ({ create }) => ({ id: "ctr-1", ...create }));
    prisma.capabilityBundle.upsert.mockImplementation(async ({ create }) => ({ id: "cap-1", ...create }));
    prisma.capability.deleteMany.mockResolvedValue({ count: 0 });
    prisma.capability.create.mockImplementation(async ({ data }) => data);
    prisma.agentClass.upsert.mockImplementation(async ({ create }) => ({ id: "class-1", ...create }));
    prisma.agent.upsert.mockImplementation(async ({ create }) => ({ id: "agent-1", ...create }));
    return prisma;
  }

  const BODY = Object.freeze({
    robotId: "RBT-2000",
    locationId: "loc-1",
    chassisType: "Rover (Ground)",
    specification: SPEC,
  });

  test("omitted → physical", async () => {
    const prisma = commissioningPrisma();
    await robotService.commissionRobot(prisma, BODY);
    expect(prisma.robot.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ simulated: false }) }),
    );
  });

  // ── CHANGED BY STEP 2, deliberately ──────────────────────────────────────
  //
  // This test previously asserted that `commissionRobot(…, { simulated: true })` created a
  // simulated unit. Step 1 was right to make that explicit; Step 2 closes it, because a
  // simulated robot created here would have no owner and would bypass the
  // one-per-operator rule entirely. The physical commissioning endpoint is now physical-only.
  //
  // The property Step 1 was protecting — that `simulated` is never *coerced* — is
  // unchanged and still asserted by the two tests either side of this one. What moved is
  // where a simulated unit may be created, not how the flag is read. `simulated: true` is
  // now created by `POST /api/simulator/robot`, and
  // `tests/unit/simulation/simulatedRobotOwnership.test.js` asserts that it persists.
  test("explicit true → refused, with the simulator endpoint named", async () => {
    const prisma = commissioningPrisma();
    await expect(
      robotService.commissionRobot(prisma, { ...BODY, simulated: true }),
    ).rejects.toMatchObject({ status: 400, code: "SIMULATED_NOT_ALLOWED_HERE" });

    // Refused before anything is written — not created and then rolled back.
    expect(prisma.robot.create).not.toHaveBeenCalled();
  });

  test('a non-boolean is a 400, not a coercion — no Robot row is written', async () => {
    const prisma = commissioningPrisma();
    await expect(robotService.commissionRobot(prisma, { ...BODY, simulated: "true" })).rejects.toMatchObject({
      status: 400,
    });
    expect(prisma.robot.create).not.toHaveBeenCalled();
  });

  test("there is no update path that turns a physical robot simulated", () => {
    // `updateRobot` enumerates its editable fields and rejects everything else. The
    // guarantee is that `simulated` is not in that set, so no API caller can flip a
    // commissioned physical unit into one the simulator will adopt.
    const controllerSource = fs.readFileSync(
      path.join(__dirname, "..", "..", "..", "src", "controllers", "robots.controller.js"),
      "utf8",
    );
    const editable = controllerSource.match(/const EDITABLE = new Set\(\[([\s\S]*?)\]\)/);
    expect(editable).not.toBeNull();
    expect(editable[1]).not.toMatch(/simulated/);
  });
});

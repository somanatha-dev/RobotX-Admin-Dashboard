/**
 * T2 — the commissioned specification is what the simulator actually runs on.
 *
 * ── The claim, and the weaker claim this deliberately does not make ─────────
 * It would be easy, and worthless, to assert that three presets hold three different
 * numbers. That tests a frozen object literal. The claim that matters is a chain:
 *
 *     preset → parseSpecification → model rows → persisted row → Prisma read →
 *     VirtualRobot → the speed the agent actually moves at
 *
 * so every test below either walks a link of that chain or measures the far end of it.
 * The decisive ones are the last two describes: the agent is built from a **database
 * row**, and its resolved speed envelope and its observed movement both come from that
 * row rather than from `SPEED_BASE_MS`.
 */

const VirtualRobot = require("../../../src/simulation/VirtualRobot");
const { createVirtualRobotSimulator } = require("../../../src/simulation/SimulationEngine");
const robotSpecification = require("../../../src/services/robotSpecification");
const constants = require("../../../src/simulation/constants");

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** The owner's declared figures, restated here so a drift in the table is a failure. */
const DECLARED = {
  LIGHT: { massKg: 1, normalSpeedMps: 1.2, payloadCapacityKg: 3 },
  STANDARD: { massKg: 2, normalSpeedMps: 1.5, payloadCapacityKg: 5 },
  HEAVY: { massKg: 3, normalSpeedMps: 1.0, payloadCapacityKg: 8 },
};

describe("T2 — the presets carry the owner's declared values", () => {
  test.each(Object.entries(DECLARED))("%s matches the declaration", (name, expected) => {
    expect(robotSpecification.simulationPresetValues(name)).toEqual(expected);
  });

  test("a preset declares three fields and deliberately not the other four", () => {
    for (const name of robotSpecification.SIMULATION_PRESET_NAMES) {
      expect(Object.keys(robotSpecification.simulationPresetValues(name)).sort())
        .toEqual(["massKg", "normalSpeedMps", "payloadCapacityKg"]);
    }

    // The four a preset must never supply, because nobody declared them. If a future
    // edit adds one of these to the table, this fails — which is the point.
    for (const field of ["maxSpeedMps", "batteryCapacityWh", "batteryReservePct", "initialBatteryPct"]) {
      expect(robotSpecification.PRESET_UNDECLARED_FIELDS[field]).toEqual(expect.any(String));
      for (const name of robotSpecification.SIMULATION_PRESET_NAMES) {
        expect(robotSpecification.simulationPresetValues(name)[field]).toBeUndefined();
      }
    }
  });

  test("an unrecognised preset fills nothing rather than falling back to one of the three", () => {
    expect(robotSpecification.simulationPresetValues("MEDIUM")).toBeNull();
    expect(robotSpecification.simulationPresetValues("")).toBeNull();
    expect(robotSpecification.simulationPresetValues(undefined)).toBeNull();
  });

  test("preset values survive the real validator and land on the model rows that mean them", () => {
    const preset = robotSpecification.simulationPresetValues("LIGHT");
    // The operator supplies the four the preset does not.
    const parsed = robotSpecification.parseSpecification(
      { ...preset, maxSpeedMps: 2, batteryCapacityWh: 300, batteryReservePct: 10, initialBatteryPct: 65 },
      { require: robotSpecification.COMMISSIONING_REQUIRED },
    );
    expect(parsed.ok).toBe(true);

    const rows = robotSpecification.modelRowsFor({
      robotCode: "SIM-LIGHT",
      chassisType: "ROVER",
      spec: parsed.spec,
    });

    expect(rows.robot.massKg).toBe(1);
    expect(rows.mobility.speedModel.nominalSpeedMps).toBe(1.2);
    expect(rows.container.totalMassLimitKg).toBe(3);
  });

  test("a preset alone does not satisfy commissioning — the four undeclared fields are still required", () => {
    const parsed = robotSpecification.parseSpecification(
      robotSpecification.simulationPresetValues("STANDARD"),
      { require: robotSpecification.COMMISSIONING_REQUIRED },
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.problems.join(" ")).toMatch(/Max speed is required/);
    expect(parsed.problems.join(" ")).toMatch(/Battery capacity is required/);
    expect(parsed.problems.join(" ")).toMatch(/Battery reserve is required/);
    expect(parsed.problems.join(" ")).toMatch(/Initial battery is required/);
  });
});

describe("T2 — the agent reads its persisted specification, not a fleet constant", () => {
  /** A `Robot` row exactly as `SimulationEngine.addRobot`'s select returns it. */
  function persistedRowFor(preset, { maxSpeedMps = 2.5, packNominalWh = 300 } = {}) {
    const declared = DECLARED[preset];
    return {
      battery: 80,
      simulated: true,
      massKg: declared.massKg,
      agent: {
        batteryState: { kappa: 1, kappaSampleCount: 0, soh: null, lastObservedSoc: 0.8 },
        agentClass: {
          mobilityModel: {
            kinematicLimits: { maxSpeedMps },
            speedModel: { nominalSpeedMps: declared.normalSpeedMps },
          },
          energyModel: { packNominalWh },
          containerModel: { totalMassLimitKg: declared.payloadCapacityKg },
          energyModelParams: [],
        },
      },
    };
  }

  /** Build an agent the way the engine does — through Prisma, not by hand. */
  async function agentFromDatabase(preset, options) {
    const row = persistedRowFor(preset, options);
    const built = [];

    const prisma = {
      robot: { findUnique: jest.fn(async () => row) },
    };
    const kv = {
      async get() { return null; },
      async set() { return "OK"; },
      async sadd() { return 1; },
    };

    const engine = createVirtualRobotSimulator({
      prisma, kv, serverUrl: "http://localhost:0", logger: silentLogger, enabled: true,
    });

    // Capture the constructed agent without connecting a socket.
    const original = VirtualRobot.prototype.connect;
    VirtualRobot.prototype.connect = function connect() { built.push(this); };
    try {
      engine.start();
      await engine.addRobot({ robotId: `SIM-${preset}`, lat: 12.9, lon: 77.5, simulated: true });
    } finally {
      VirtualRobot.prototype.connect = original;
    }

    expect(built).toHaveLength(1);
    return built[0];
  }

  test.each(["LIGHT", "STANDARD", "HEAVY"])(
    "%s: the agent's speed envelope comes from the persisted row",
    async (preset) => {
      const agent = await agentFromDatabase(preset);
      const status = agent.getStatus();

      expect(status.specification.normalSpeedMps).toBe(DECLARED[preset].normalSpeedMps);
      expect(status.specification.massKg).toBe(DECLARED[preset].massKg);
      expect(status.specification.payloadCapacityKg).toBe(DECLARED[preset].payloadCapacityKg);
      expect(status.specification.packNominalWh).toBe(300);

      // The fix itself: the base speed is the commissioned nominal, not 5.56 m/s.
      expect(status.speedEnvelope.baseMs).toBe(DECLARED[preset].normalSpeedMps);
      expect(status.speedEnvelope.baseMs).not.toBe(constants.SPEED_BASE_MS);

      // And the clamps moved with it. Leaving `SPEED_MIN_MS` (5.0) in place would drag a
      // 1.2 m/s robot back up to 5.0 on every tick, so the base would read correct while
      // the robot moved at four times its declared speed.
      expect(status.speedEnvelope.minMs).toBeLessThan(DECLARED[preset].normalSpeedMps);
      expect(status.speedEnvelope.minMs).toBeLessThan(constants.SPEED_MIN_MS);
      expect(status.speedEnvelope.maxMs).toBe(2.5);
    },
  );

  test("the three presets produce three genuinely different speed envelopes", async () => {
    // Sequential, not `Promise.all`: `agentFromDatabase` swaps `VirtualRobot.prototype
    // .connect` to capture the instance, and three overlapping swaps restore each other's
    // patch. Concurrency here would be testing the harness, not the agents.
    const bases = [];
    for (const preset of ["LIGHT", "STANDARD", "HEAVY"]) {
      // eslint-disable-next-line no-await-in-loop
      const agent = await agentFromDatabase(preset);
      bases.push(agent.getStatus().speedEnvelope.baseMs);
    }
    expect(bases).toEqual([1.2, 1.5, 1.0]);
    expect(new Set(bases).size).toBe(3);
  });

  test("the agent actually MOVES at its commissioned speed, not merely reports it", async () => {
    // The far end of the chain. A robot commissioned at 1.2 m/s must cover roughly
    // 1.2 m each simulated second — this is what a constant-speed regression breaks.
    const agent = await agentFromDatabase("LIGHT");

    // Drive the EMA to steady state, then measure.
    agent.status = "ACTIVE";
    agent.task = { taskId: "T", stops: [] };
    agent.phase = "TO_PICKUP";
    for (let i = 0; i < 200; i += 1) agent._updateSpeed();

    // Within the declared envelope, and nowhere near the 5.0–8.33 m/s fleet band.
    expect(agent.speed).toBeGreaterThan(1.0);
    expect(agent.speed).toBeLessThan(1.4);
    expect(agent.speed).toBeLessThan(constants.SPEED_MIN_MS);
  });

  test("an uncommissioned unit still gets the fleet constants — a fallback fills a gap", async () => {
    const row = {
      battery: 50,
      simulated: true,
      massKg: null,
      agent: null,
    };
    const built = [];
    const prisma = { robot: { findUnique: jest.fn(async () => row) } };
    const kv = { async get() { return null; }, async set() { return "OK"; }, async sadd() { return 1; } };
    const engine = createVirtualRobotSimulator({
      prisma, kv, serverUrl: "http://localhost:0", logger: silentLogger, enabled: true,
    });

    const original = VirtualRobot.prototype.connect;
    VirtualRobot.prototype.connect = function connect() { built.push(this); };
    try {
      engine.start();
      await engine.addRobot({ robotId: "SIM-OLD", lat: 12.9, lon: 77.5, simulated: true });
    } finally {
      VirtualRobot.prototype.connect = original;
    }

    const status = built[0].getStatus();
    expect(status.specification.normalSpeedMps).toBeNull();
    expect(status.speedEnvelope.baseMs).toBe(constants.SPEED_BASE_MS);
    expect(status.speedEnvelope.minMs).toBe(constants.SPEED_MIN_MS);
    expect(status.speedEnvelope.maxMs).toBe(constants.SPEED_MAX_MS);
  });

  test("a present commissioned value is never replaced by a constant", () => {
    // Stated directly, because it is the precedence rule the whole step rests on.
    const agent = new VirtualRobot({
      robotId: "SIM-P", lat: 0, lon: 0, logger: silentLogger, simulated: true,
      specification: { massKg: 3, normalSpeedMps: 1.0, maxSpeedMps: 1.8, packNominalWh: 250, payloadCapacityKg: 8 },
    });

    const status = agent.getStatus();
    expect(status.speedEnvelope.baseMs).toBe(1.0);
    expect(status.specification.packNominalWh).toBe(250);
    expect(status.specification.packNominalWh).not.toBe(constants.PACK_NOMINAL_WH);
  });
});

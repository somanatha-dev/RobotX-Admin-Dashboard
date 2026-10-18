"use strict";

/**
 * Fleet-wide physical commissioning: declaration → lifecycle → candidate index, for ANY number of
 * physical units, with no unit named in code.
 *
 *   A  the declaration file: many units, each validated on its own; a bad or duplicated entry is
 *      refused by name and never partly applied
 *   B  `applyRobotDeclaration` / `applyDeclaration` (the boot path): COMMISSIONED → ACTIVE bound
 *      to the declared region; held, retired and simulated units are reported, never activated
 *   C  `activateDeclaredRobot` (one unit, no restart): elevated + reason + typed confirmation,
 *      only from the loaded declaration, refusals by name, audit Event in the same transaction
 *   D  lifecycle ↔ index consistency across activation, restart (rebuild), retirement and
 *      recommissioning, with each unit indexed in ITS declared region's shard, and the physical
 *      evidence (trusted SoC, a position) still required for discovery
 *   E  the readiness diagnostic names the declaration standing of a physical unit
 *
 * The §7.5 gates (stale/missing fix, stop latch, readiness, energy, campus isolation, route
 * containment) are exercised through the real coordinator path in `physicalCandidate.test.js` and
 * `physicalRouteContainment.test.js`; this file is the commissioning half in front of them.
 */

jest.mock("../../src/db/prisma");

const physicalPolicy = require("../../src/services/fleetProviders/physicalPolicy");
const physicalProvider = require("../../src/services/fleetProviders/physicalProvider");
const physicalDeclaration = require("../../src/services/physicalDeclaration.service");
const positionObservation = require("../../src/services/positionObservation.service");
const robotDispatchReadiness = require("../../src/services/robotDispatchReadiness.service");
const indexMaintainer = require("../../src/workers/indexMaintainer.worker");

const NOW = Date.now();
const RNSIT_POINT = { lat: 12.90217, lon: 77.51829 };
const JSSATE_POINT = { lat: 12.9016, lon: 77.5005 };

/* ── the declaration ──────────────────────────────────────────────────────── */

function unitEntry(robotId, overrides) {
  const { control, energy } = overrides || {};
  return {
    robotId,
    control: {
      firmwareVersion: "2.2",
      hardwareRevision: "rover-rev-a",
      missionTypes: ["DELIVERY"],
      calibrations: [],
      serviceDueAt: "2027-06-01T00:00:00Z",
      regionId: "rnsit",
      authorisation: "REGION",
      advisories: [],
      operatingAmbientC: { min: 0, max: 45 },
      ...(control || {}),
    },
    energy: { idlePowerW: 5, movingPowerW: 20, soh: 0.9, residualCv: 0.2, reserveFloorWh: 8.6, ...(energy || {}) },
  };
}

function declarationWith(robots, extra) {
  return {
    declaredBy: "test owner",
    declaredAt: "2026-10-18",
    charging: { policy: "MANUAL_OUT_OF_SERVICE" },
    stateOfCharge: { policy: "OPERATOR_DECLARED", maxAgeSeconds: 7200 },
    emergencyStop: { mechanism: "SOFTWARE_STOP_LATCH" },
    site: {
      ambientC: { min: 18, max: 38 },
      terrain: "FLAT_DECLARED",
      connectivityDeadZones: "NONE_DECLARED",
      constrictions: "NONE_DECLARED",
      stopStartCyclesPerHop: 1,
      snapRadiusM: 25,
    },
    localisation: { referenceRadiusM: 25, acceptedFixTypes: ["3D"] },
    risk: { failureProbabilityPrior: 0.05, routeHazardCu: 0 },
    robots,
    ...(extra || {}),
  };
}

/* ── an in-memory store with the slice of Prisma these paths read and write ── */

function commissioningStore(units) {
  const regions = [
    { id: "region-row-rnsit", regionId: "rnsit" },
    { id: "region-row-jssate", regionId: "jssate" },
  ];
  const shards = [
    { shardId: "rnsit-shard", regionId: "region-row-rnsit", state: "ACTIVE" },
    { shardId: "jssate-shard", regionId: "region-row-jssate", state: "ACTIVE" },
  ];
  const robots = new Map();
  const agents = new Map();
  for (const unit of units) {
    const agentRowId = `agent-${unit.robotId}`;
    robots.set(unit.robotId, {
      id: `robot-${unit.robotId}`,
      robotId: unit.robotId,
      simulated: unit.simulated === true,
      massKg: 12,
      status: "IDLE",
      isOnline: false,
      socketId: null,
      agentRowId,
    });
    agents.set(agentRowId, {
      id: agentRowId,
      agentId: unit.robotId,
      lifecycleState: unit.lifecycleState || "COMMISSIONED",
      regionId: unit.regionId === undefined ? null : unit.regionId,
      agentClassId: `class-${unit.robotId}`,
      capacityOverride: null,
      robotId: unit.robotId,
    });
  }
  const batteryStates = new Map();
  const observations = [];
  const mirror = new Map();
  const memberships = [];
  const events = [];
  const writes = [];
  const hooks = {};

  const robotView = (robot) => {
    if (!robot) return null;
    const agent = agents.get(robot.agentRowId);
    return {
      ...robot,
      agent: agent
        ? {
            ...agent,
            agentClass: {
              id: agent.agentClassId,
              mobilityModelId: `mob-${robot.robotId}`,
              energyModelId: `en-${robot.robotId}`,
              containerModelId: `con-${robot.robotId}`,
              mobilityModel: { permissionSet: { roadClasses: ["footway", "path", "service"] } },
              containerModel: { totalMassLimitKg: 5 },
            },
          }
        : null,
    };
  };
  const agentView = (agent) =>
    agent && {
      ...agent,
      robot: { robotId: agent.robotId, status: robots.get(agent.robotId).status },
      batteryState: batteryStates.get(agent.id) || null,
    };
  const record = (what) => writes.push(what);
  const noteUpdate = (table) => jest.fn(async () => record(table));

  const prisma = {
    regions,
    robots,
    agents,
    mirror,
    events,
    writes,
    hooks,
    batteryStates,
    observations,
    robot: {
      findUnique: jest.fn(async ({ where }) => robotView(robots.get(where.robotId))),
    },
    region: { findFirst: jest.fn(async ({ where }) => regions.find((row) => row.regionId === where.regionId) || null) },
    shard: {
      findMany: jest.fn(async ({ where }) => shards.filter((row) => row.regionId === where.regionId)),
      findUnique: jest.fn(async ({ where }) => shards.find((row) => row.shardId === where.shardId) || null),
    },
    agent: {
      findUnique: jest.fn(async ({ where }) => agentView(agents.get(where.id))),
      findMany: jest.fn(async ({ where }) =>
        [...agents.values()].filter((row) => !where || !where.lifecycleState || row.lifecycleState === where.lifecycleState).map((row) => ({ id: row.id })),
      ),
      updateMany: jest.fn(async ({ where, data }) => {
        if (hooks.beforeAgentUpdate) await hooks.beforeAgentUpdate(where.id);
        const row = agents.get(where.id);
        const allowed = where.lifecycleState && where.lifecycleState.in;
        if (!row || (allowed && !allowed.includes(row.lifecycleState))) return { count: 0 };
        Object.assign(row, data);
        record("agent");
        return { count: 1 };
      }),
    },
    agentClass: { update: noteUpdate("agentClass") },
    energyModel: { update: noteUpdate("energyModel") },
    mobilityModel: { update: noteUpdate("mobilityModel") },
    containerModel: { update: noteUpdate("containerModel") },
    compartment: { upsert: jest.fn(async () => ({ id: "cmp-1" })) },
    energyModelParams: { upsert: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 1 })) },
    batteryState: {
      upsert: jest.fn(async ({ where, create }) => {
        if (!batteryStates.has(where.agentId)) batteryStates.set(where.agentId, { ...create });
        return batteryStates.get(where.agentId);
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const row = batteryStates.get(where.agentId);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    event: { create: jest.fn(async ({ data }) => events.push(data)) },
    observation: {
      create: jest.fn(async ({ data }) => observations.push(data)),
      findFirst: jest.fn(async ({ where }) => {
        const rows = observations.filter((row) => row.agentId === where.agentId && row.kind === where.kind);
        return rows.sort((a, b) => b.observedAt - a.observedAt)[0] || null;
      }),
    },
    commitment: { count: jest.fn(async () => 0) },
    shardMembership: {
      findFirst: jest.fn(async ({ where }) => memberships.find((row) => row.agentId === where.agentId) || null),
      create: jest.fn(async ({ data }) => {
        memberships.push(data);
        return data;
      }),
    },
    agentCellPosition: {
      findUnique: jest.fn(async ({ where }) => (mirror.has(where.agentId) ? { ...mirror.get(where.agentId) } : null)),
      findMany: jest.fn(async (args) => {
        const wanted = args && args.where && args.where.agent && args.where.agent.is && args.where.agent.is.lifecycleState;
        return [...mirror.values()].filter((row) => !wanted || (agents.get(row.agentId) || {}).lifecycleState === wanted).map((row) => ({ ...row }));
      }),
      upsert: jest.fn(async ({ where, create, update }) => {
        mirror.set(where.agentId, mirror.has(where.agentId) ? { ...mirror.get(where.agentId), ...update } : { ...create });
      }),
      delete: jest.fn(async ({ where }) => mirror.delete(where.agentId)),
    },
    $queryRawUnsafe: jest.fn(async (sql, agentRowId) => {
      const row = agents.get(agentRowId);
      return row ? [{ lifecycleState: row.lifecycleState }] : [];
    }),
    $transaction: jest.fn(async (fn) => fn(prisma)),
  };
  return prisma;
}

/** A KV double recording set membership, as `availabilityIndex` writes it. */
function recordingKv() {
  const sets = new Map();
  return {
    sets,
    async sadd(key, ...members) {
      if (!sets.has(key)) sets.set(key, new Set());
      for (const member of members) sets.get(key).add(String(member));
      return members.length;
    },
    async srem(key, ...members) {
      if (sets.has(key)) for (const member of members) sets.get(key).delete(String(member));
      return members.length;
    },
    async smembers(key) {
      return [...(sets.get(key) || [])];
    },
    async del(key) {
      sets.delete(key);
      return 1;
    },
    async keys() {
      return [...sets.keys()];
    },
    holds(agentId) {
      return [...sets.values()].some((members) => members.has(agentId));
    },
    shardOf(agentId) {
      const key = [...sets.entries()].find(([, members]) => members.has(agentId));
      return key ? key[0] : null;
    },
  };
}

const BODY = (robotId) => ({ reason: "unit back from the workshop", confirmRobotId: robotId });

beforeEach(() => {
  positionObservation.resetPositionObservationState();
});

/* ═══ A — the declaration file ═══════════════════════════════════════════════ */

describe("A — one declaration mechanism for any number of physical units", () => {
  test("three units, two campuses, no unit special-cased: each is declared from its own entry", () => {
    const policy = physicalPolicy.fromDeclaration(
      declarationWith([unitEntry("UNIT-A1"), unitEntry("rover-7"), unitEntry("RBT-3001", { control: { regionId: "jssate" } })]),
    );
    expect(policy.problems).toEqual([]);
    expect([...policy.robots.keys()].sort()).toEqual(["RBT-3001", "UNIT-A1", "rover-7"]);
    expect(policy.robotFor("RBT-3001").control.regionId).toBe("jssate");
    expect(policy.robotFor("UNIT-A1").control.regionId).toBe("rnsit");
    expect(policy.robotFor("RBT-2000")).toBeNull();
    expect(policy.problemsFor("UNIT-A1")).toEqual([]);
  });

  test.each([
    ["no regionId", { control: { regionId: undefined } }, /control\.regionId is required/],
    ["authorisation other than REGION", { control: { authorisation: "ANYWHERE" } }, /control\.authorisation must be "REGION"/],
    ["no firmware version", { control: { firmwareVersion: "" } }, /control\.firmwareVersion is required/],
    ["an unparseable service date", { control: { serviceDueAt: "soon" } }, /control\.serviceDueAt is required/],
    ["SoH above 1", { energy: { soh: 1.4 } }, /energy\.soh must be in \(0, 1\]/],
    ["moving draw below idle", { energy: { idlePowerW: 30, movingPowerW: 10 } }, /movingPowerW must not be below/],
  ])("an entry with %s is refused by name; the other units are unaffected", (_name, overrides, named) => {
    const policy = physicalPolicy.fromDeclaration(declarationWith([unitEntry("UNIT-BAD", overrides), unitEntry("UNIT-OK")]));
    expect(policy.robotFor("UNIT-BAD")).toBeNull();
    expect(policy.robotFor("UNIT-OK")).not.toBeNull();
    expect(policy.problemsFor("UNIT-BAD").join("; ")).toMatch(named);
    expect(policy.problems.join(" ")).toMatch(/robots\[UNIT-BAD\]/);
  });

  test("a unit declared twice is refused outright — neither entry is chosen — and named once", () => {
    const policy = physicalPolicy.fromDeclaration(
      declarationWith([unitEntry("UNIT-DUP"), unitEntry("UNIT-DUP", { energy: { soh: 0.5 } }), unitEntry("UNIT-OK")]),
    );
    expect(policy.robotFor("UNIT-DUP")).toBeNull();
    expect(policy.robotFor("UNIT-OK")).not.toBeNull();
    expect(policy.problemsFor("UNIT-DUP")).toEqual([expect.stringMatching(/declared 2 times/)]);
    expect(policy.problems.filter((line) => line.startsWith("robots[UNIT-DUP]"))).toHaveLength(1);
  });

  test("an entry with no robotId is named by its position, not as 'undefined'", () => {
    const policy = physicalPolicy.fromDeclaration(declarationWith([{ ...unitEntry("x"), robotId: undefined }]));
    expect(policy.robots.size).toBe(0);
    expect(policy.problems.join(" ")).toMatch(/robots\[0\]: robotId is required/);
  });

  test("a `robots` value that is not a list declares nobody, and says so", () => {
    const policy = physicalPolicy.fromDeclaration(declarationWith({ robotId: "UNIT-A1" }));
    expect(policy.robots.size).toBe(0);
    expect(policy.problems.join(" ")).toMatch(/robots must be a list/);
  });

  test("an unreadable file is every section off, with the reason — never a boot failure", () => {
    const policy = physicalPolicy.load({ PHYSICAL_FLEET_DECLARATION_FILE: "Z:/no/such/declaration.json" });
    expect(policy.robots.size).toBe(0);
    expect(policy.problems[0]).toMatch(/could not be read/);
    expect(policy.problemsFor("UNIT-A1")).toEqual([]);
  });
});

/* ═══ B — the boot path ══════════════════════════════════════════════════════ */

describe("B — applyDeclaration (boot): each unit put in service in its own region, or reported", () => {
  test("many units in one pass; held, retired, simulated and absent units are reported and never activated", async () => {
    const prisma = commissioningStore([
      { robotId: "UNIT-NEW" },
      { robotId: "UNIT-LIVE", lifecycleState: "ACTIVE", regionId: "region-row-rnsit" },
      { robotId: "UNIT-JSS" },
      { robotId: "UNIT-RETIRED", lifecycleState: "DECOMMISSIONED" },
      { robotId: "UNIT-HELD", lifecycleState: "QUARANTINED" },
      { robotId: "SIM-LOOKALIKE", simulated: true },
    ]);
    const policy = physicalPolicy.fromDeclaration(
      declarationWith([
        unitEntry("UNIT-NEW"),
        unitEntry("UNIT-LIVE"),
        unitEntry("UNIT-JSS", { control: { regionId: "jssate" } }),
        unitEntry("UNIT-RETIRED"),
        unitEntry("UNIT-HELD"),
        unitEntry("SIM-LOOKALIKE"),
        unitEntry("UNIT-NOT-COMMISSIONED"),
      ]),
    );

    const results = await physicalDeclaration.applyDeclaration(prisma, policy);
    const by = Object.fromEntries(results.map((row) => [row.robotId, row]));

    expect(by["UNIT-NEW"]).toMatchObject({ ok: true, activated: true, lifecycleBefore: "COMMISSIONED", lifecycleState: "ACTIVE" });
    expect(by["UNIT-LIVE"]).toMatchObject({ ok: true, activated: true, lifecycleBefore: "ACTIVE", lifecycleState: "ACTIVE" });
    expect(by["UNIT-JSS"]).toMatchObject({ ok: true, activated: true });
    expect(by["UNIT-RETIRED"]).toMatchObject({ ok: true, activated: false, lifecycleState: "DECOMMISSIONED" });
    expect(by["UNIT-HELD"]).toMatchObject({ ok: true, activated: false, lifecycleState: "QUARANTINED" });
    expect(by["SIM-LOOKALIKE"]).toMatchObject({ ok: false, code: "NOT_PHYSICAL" });
    expect(by["UNIT-NOT-COMMISSIONED"]).toMatchObject({ ok: false, code: "NOT_FOUND" });

    // Each unit is bound to the Region row of ITS declared region.
    expect(prisma.agents.get("agent-UNIT-NEW").regionId).toBe("region-row-rnsit");
    expect(prisma.agents.get("agent-UNIT-JSS").regionId).toBe("region-row-jssate");
    // The simulated unit and the held/retired units are untouched.
    expect(prisma.agents.get("agent-SIM-LOOKALIKE")).toMatchObject({ lifecycleState: "COMMISSIONED", regionId: null });
    expect(prisma.agents.get("agent-UNIT-RETIRED").lifecycleState).toBe("DECOMMISSIONED");
    expect(prisma.agents.get("agent-UNIT-HELD").lifecycleState).toBe("QUARANTINED");
  });

  test("a declared region with no Region row is refused NO_REGION, nothing activated", async () => {
    const prisma = commissioningStore([{ robotId: "UNIT-X" }]);
    const policy = physicalPolicy.fromDeclaration(declarationWith([unitEntry("UNIT-X", { control: { regionId: "atlantis" } })]));
    const [result] = await physicalDeclaration.applyDeclaration(prisma, policy);
    expect(result).toMatchObject({ ok: false, code: "NO_REGION" });
    expect(prisma.agents.get("agent-UNIT-X").lifecycleState).toBe("COMMISSIONED");
  });
});

/* ═══ C — one unit, without a restart ════════════════════════════════════════ */

describe("C — activateDeclaredRobot: the authorised single-unit path", () => {
  const policyFor = (...entries) => physicalPolicy.fromDeclaration(declarationWith(entries));

  test("a recommissioned (COMMISSIONED) declared unit is put in service, with an audit Event in the transaction", async () => {
    const prisma = commissioningStore([{ robotId: "UNIT-R" }]);
    const result = await physicalDeclaration.activateDeclaredRobot(prisma, "UNIT-R", BODY("UNIT-R"), {
      policy: policyFor(unitEntry("UNIT-R")),
      actorId: "admin-1",
    });
    expect(result).toEqual({ robotId: "UNIT-R", lifecycleBefore: "COMMISSIONED", lifecycleState: "ACTIVE", activated: true, alreadyActive: false });
    expect(prisma.agents.get("agent-UNIT-R")).toMatchObject({ lifecycleState: "ACTIVE", regionId: "region-row-rnsit" });
    expect(prisma.events).toHaveLength(1);
    expect(prisma.events[0]).toMatchObject({ robotId: "robot-UNIT-R", type: "INFO" });
    expect(prisma.events[0].message).toMatch(/COMMISSIONED -> ACTIVE.*admin-1.*unit back from the workshop.*not assignable/);
  });

  test("repeating it is a success that says the unit was already active", async () => {
    const prisma = commissioningStore([{ robotId: "UNIT-R", lifecycleState: "ACTIVE", regionId: "region-row-rnsit" }]);
    const result = await physicalDeclaration.activateDeclaredRobot(prisma, "UNIT-R", BODY("UNIT-R"), { policy: policyFor(unitEntry("UNIT-R")) });
    expect(result).toMatchObject({ activated: true, alreadyActive: true });
  });

  test.each([
    ["no physical fleet in this process", null, "UNIT-R", BODY("UNIT-R"), 409, "PHYSICAL_FLEET_DISABLED"],
    ["the unit is not declared", "other", "UNIT-R", BODY("UNIT-R"), 409, "NOT_DECLARED"],
    ["the unit's entry is invalid", "invalid", "UNIT-R", BODY("UNIT-R"), 409, "NOT_DECLARED"],
    ["no reason", "ok", "UNIT-R", { confirmRobotId: "UNIT-R" }, 400, "INVALID_REQUEST"],
    ["a confirmation naming another unit", "ok", "UNIT-R", { reason: "r", confirmRobotId: "UNIT-S" }, 400, "INVALID_REQUEST"],
    ["a field that tries to set state", "ok", "UNIT-R", { ...BODY("UNIT-R"), lifecycleState: "ACTIVE" }, 400, "INVALID_REQUEST"],
    ["no such robot", "ok-ghost", "UNIT-GHOST", BODY("UNIT-GHOST"), 404, "ROBOT_NOT_FOUND"],
  ])("refused when %s — nothing written", async (_name, policyKind, robotId, body, status, code) => {
    const prisma = commissioningStore([{ robotId: "UNIT-R" }]);
    const policy =
      policyKind === null
        ? null
        : policyKind === "other"
          ? policyFor(unitEntry("UNIT-OTHER"))
          : policyKind === "invalid"
            ? policyFor(unitEntry("UNIT-R", { energy: { soh: 2 } }))
            : policyKind === "ok-ghost"
              ? policyFor(unitEntry("UNIT-GHOST"))
              : policyFor(unitEntry("UNIT-R"));
    const attempt = physicalDeclaration.activateDeclaredRobot(prisma, robotId, body, { policy });
    await expect(attempt).rejects.toMatchObject({ status, code });
    expect(prisma.agents.get("agent-UNIT-R").lifecycleState).toBe("COMMISSIONED");
    expect(prisma.events).toEqual([]);
    expect(prisma.writes).toEqual([]);
  });

  test("an invalid entry is refused with that entry's own problems", async () => {
    const prisma = commissioningStore([{ robotId: "UNIT-R" }]);
    const attempt = physicalDeclaration.activateDeclaredRobot(prisma, "UNIT-R", BODY("UNIT-R"), {
      policy: policyFor(unitEntry("UNIT-R", { control: { regionId: "" } })),
    });
    await expect(attempt).rejects.toMatchObject({ code: "NOT_DECLARED", extra: { problems: [expect.stringMatching(/regionId/)] } });
  });

  test.each([
    ["retired", "DECOMMISSIONED", "ROBOT_RETIRED"],
    ["quarantined", "QUARANTINED", "LIFECYCLE_HELD"],
    ["in maintenance", "MAINTENANCE", "LIFECYCLE_HELD"],
  ])("a %s unit is refused by name and left as it is", async (_name, lifecycleState, code) => {
    const prisma = commissioningStore([{ robotId: "UNIT-R", lifecycleState }]);
    await expect(
      physicalDeclaration.activateDeclaredRobot(prisma, "UNIT-R", BODY("UNIT-R"), { policy: policyFor(unitEntry("UNIT-R")) }),
    ).rejects.toMatchObject({ status: 409, code });
    expect(prisma.agents.get("agent-UNIT-R").lifecycleState).toBe(lifecycleState);
    expect(prisma.writes).toEqual([]);
  });

  test("a simulated unit is refused NOT_PHYSICAL even when a declaration names it", async () => {
    const prisma = commissioningStore([{ robotId: "SIM-ABC", simulated: true }]);
    await expect(
      physicalDeclaration.activateDeclaredRobot(prisma, "SIM-ABC", BODY("SIM-ABC"), { policy: policyFor(unitEntry("SIM-ABC")) }),
    ).rejects.toMatchObject({ code: "NOT_PHYSICAL" });
    expect(prisma.agents.get("agent-SIM-ABC").lifecycleState).toBe("COMMISSIONED");
  });

  test("a retirement committing between the check and the write wins: NOT_APPLIED, the unit stays retired", async () => {
    const prisma = commissioningStore([{ robotId: "UNIT-R" }]);
    prisma.hooks.beforeAgentUpdate = async (agentRowId) => {
      prisma.agents.get(agentRowId).lifecycleState = "DECOMMISSIONED";
    };
    await expect(
      physicalDeclaration.activateDeclaredRobot(prisma, "UNIT-R", BODY("UNIT-R"), { policy: policyFor(unitEntry("UNIT-R")) }),
    ).rejects.toMatchObject({ code: "NOT_APPLIED" });
    expect(prisma.agents.get("agent-UNIT-R").lifecycleState).toBe("DECOMMISSIONED");
  });
});

describe("C — the HTTP surface: authenticated, elevated-only, declaration from the process", () => {
  const fs = require("fs");
  const path = require("path");
  const { requireElevatedRole } = require("../../src/middlewares/auth_middleware");
  const robotsController = require("../../src/controllers/robots.controller");

  const responder = () => {
    const res = { statusCode: 200, body: null };
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (body) => {
      res.body = body;
      return res;
    };
    return res;
  };

  test("the route is behind authUser and the elevated-role gate, and shares recommissioning's limiter", () => {
    const routes = fs.readFileSync(path.join(__dirname, "../../src/routes/robots.routes.js"), "utf8");
    const line = routes.split(/\r?\n/).find((l) => /router\.post\("\/:robotId\/physical-declaration\/apply"/.test(l));
    expect(line).toMatch(/recommissionLimiter, elevatedOnly, robotsController\.applyPhysicalDeclaration\)/);
    expect(routes).toMatch(/const elevatedOnly = requireElevatedRole\(\);/);
    expect(routes.indexOf("router.use(authUser)")).toBeGreaterThan(-1);
    expect(routes.indexOf("router.use(authUser)")).toBeLessThan(routes.indexOf(line));
  });

  test.each([["OPERATOR"], ["ADMIN"], [undefined]])("the elevated gate refuses role %s with 403 (default elevated roles: SUPER_ADMIN)", (role) => {
    const res = responder();
    const next = jest.fn();
    requireElevatedRole()({ user: role ? { id: "u1", role } : undefined, app: { locals: {} } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  test("the elevated gate admits SUPER_ADMIN", () => {
    const next = jest.fn();
    requireElevatedRole()({ user: { id: "u1", role: "SUPER_ADMIN" }, app: { locals: {} } }, responder(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("the controller reads the declaration from app.locals, never from the body", async () => {
    // No loaded declaration in the process: refused, whatever the body says it declares.
    const res = responder();
    await robotsController.applyPhysicalDeclaration(
      { params: { robotId: "UNIT-R" }, body: { reason: "r", confirmRobotId: "UNIT-R" }, user: { id: "u1" }, app: { locals: { physicalFleetPolicy: null } } },
      res,
      jest.fn(),
    );
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ ok: false, code: "PHYSICAL_FLEET_DISABLED" });

    // A body that tries to carry declared values is refused before anything is read.
    const injected = responder();
    await robotsController.applyPhysicalDeclaration(
      {
        params: { robotId: "UNIT-R" },
        body: { reason: "r", confirmRobotId: "UNIT-R", control: { regionId: "rnsit" }, energy: { soh: 1 } },
        user: { id: "u1" },
        app: { locals: { physicalFleetPolicy: physicalPolicy.fromDeclaration(declarationWith([unitEntry("UNIT-R")])) } },
      },
      injected,
      jest.fn(),
    );
    expect(injected.statusCode).toBe(400);
    expect(injected.body).toMatchObject({ code: "INVALID_REQUEST" });
    expect(injected.body.message).toMatch(/refused: control, energy/);
  });
});

/* ═══ D — lifecycle and index stay consistent ════════════════════════════════ */

describe("D — the candidate index follows the lifecycle, per unit, in its own region's shard", () => {
  function world() {
    const prisma = commissioningStore([{ robotId: "UNIT-R" }, { robotId: "UNIT-J" }]);
    const policy = physicalPolicy.fromDeclaration(
      declarationWith([unitEntry("UNIT-R"), unitEntry("UNIT-J", { control: { regionId: "jssate" } })]),
    );
    const provider = physicalProvider.createPhysicalProvider({ prisma, policy });
    const kv = recordingKv();
    const deps = { prisma, kv, chargingStatusFor: provider.chargingStatusFor, now: () => NOW };
    const fix = (robotId, point, ageMs = 1_000) =>
      prisma.observations.push({ agentId: `agent-${robotId}`, kind: "position", value: { lat: point.lat, lon: point.lon, fixType: "3D" }, observedAt: new Date(NOW - ageMs) });
    const declareSoc = (robotId) =>
      physicalDeclaration.declareStateOfCharge(prisma, { robotId, socPct: 80, enteredBy: "operator", at: new Date(NOW - 60_000) });
    const activate = (robotId) => physicalDeclaration.activateDeclaredRobot(prisma, robotId, BODY(robotId), { policy });
    return { prisma, policy, kv, deps, fix, declareSoc, activate };
  }

  test("COMMISSIONED is never indexed, even with a fix; activation alone is not enough without a trusted SoC", async () => {
    const w = world();
    w.fix("UNIT-R", RNSIT_POINT);
    await indexMaintainer.sweepOnce(w.deps);
    expect(w.prisma.mirror.size).toBe(0);

    await w.activate("UNIT-R");
    await indexMaintainer.sweepOnce(w.deps);
    // ACTIVE, positioned — and still not discoverable: no operator SoC, so the availability
    // policy answers "unknown" and the index narrows (never a default).
    expect(w.prisma.mirror.has("agent-UNIT-R")).toBe(false);
    expect(w.kv.holds("agent-UNIT-R")).toBe(false);
  });

  test("ACTIVE + a fix + a fresh SoC: indexed in the shard of the DECLARED region, not of where it stands", async () => {
    const w = world();
    // UNIT-J stands on the RNSIT campus but is declared for JSSATE: its region is the declaration's.
    w.fix("UNIT-R", RNSIT_POINT);
    w.fix("UNIT-J", RNSIT_POINT);
    await w.activate("UNIT-R");
    await w.activate("UNIT-J");
    await w.declareSoc("UNIT-R");
    await w.declareSoc("UNIT-J");
    await indexMaintainer.sweepOnce(w.deps);
    expect(w.prisma.mirror.get("agent-UNIT-R").shardId).toBe("rnsit-shard");
    expect(w.prisma.mirror.get("agent-UNIT-J").shardId).toBe("jssate-shard");
    expect(w.kv.shardOf("agent-UNIT-R")).toMatch(/rnsit-shard/);
    expect(w.kv.shardOf("agent-UNIT-J")).toMatch(/jssate-shard/);
  });

  test("restart (rebuild), retirement, recommission and re-activation never leave index and lifecycle disagreeing", async () => {
    const w = world();
    w.fix("UNIT-R", RNSIT_POINT);
    await w.activate("UNIT-R");
    await w.declareSoc("UNIT-R");
    await indexMaintainer.sweepOnce(w.deps);
    expect(w.kv.holds("agent-UNIT-R")).toBe(true);

    // Restart: Redis is cold; the rebuild restores the ACTIVE unit's entry from the mirror.
    const cold = recordingKv();
    await indexMaintainer.rebuildIndexFromMirror({ prisma: w.prisma, kv: cold });
    expect(cold.holds("agent-UNIT-R")).toBe(true);

    // Retired: the sweep removes it, and a rebuild after that does not bring it back.
    w.prisma.agents.get("agent-UNIT-R").lifecycleState = "DECOMMISSIONED";
    await indexMaintainer.sweepOnce({ ...w.deps, kv: cold });
    expect(w.prisma.mirror.has("agent-UNIT-R")).toBe(false);
    expect(cold.holds("agent-UNIT-R")).toBe(false);
    const coldAgain = recordingKv();
    await indexMaintainer.rebuildIndexFromMirror({ prisma: w.prisma, kv: coldAgain });
    expect(coldAgain.holds("agent-UNIT-R")).toBe(false);

    // Activation of a retired unit is refused; recommissioning returns it COMMISSIONED, still unindexed.
    await expect(w.activate("UNIT-R")).rejects.toMatchObject({ code: "ROBOT_RETIRED" });
    w.prisma.agents.get("agent-UNIT-R").lifecycleState = "COMMISSIONED";
    await indexMaintainer.sweepOnce({ ...w.deps, kv: coldAgain });
    expect(coldAgain.holds("agent-UNIT-R")).toBe(false);

    // Put back in service through the declaration: discoverable again, in the same shard.
    await w.activate("UNIT-R");
    await indexMaintainer.sweepOnce({ ...w.deps, kv: coldAgain });
    expect(coldAgain.shardOf("agent-UNIT-R")).toMatch(/rnsit-shard/);
  });

  test("an expired operator SoC takes an ACTIVE unit back out of the index", async () => {
    const w = world();
    w.fix("UNIT-R", RNSIT_POINT);
    await w.activate("UNIT-R");
    await physicalDeclaration.declareStateOfCharge(w.prisma, { robotId: "UNIT-R", socPct: 80, enteredBy: "op", at: new Date(NOW - 7_300_000) });
    await indexMaintainer.sweepOnce(w.deps);
    expect(w.kv.holds("agent-UNIT-R")).toBe(false);
  });

  test("a unit whose declaration was never applied is not indexed and is not given a region", async () => {
    const w = world();
    w.prisma.agents.get("agent-UNIT-R").lifecycleState = "ACTIVE"; // e.g. created ACTIVE at commissioning
    w.fix("UNIT-R", JSSATE_POINT);
    await indexMaintainer.sweepOnce({ ...w.deps, chargingStatusFor: physicalProvider.createPhysicalProvider({ prisma: w.prisma, policy: physicalPolicy.NONE }).chargingStatusFor });
    expect(w.prisma.mirror.size).toBe(0);
    expect(w.prisma.agents.get("agent-UNIT-R").regionId).toBeNull();
  });
});

/* ═══ E — the readiness diagnostic names the declaration standing ════════════ */

describe("E — readiness diagnostic: declaration blockers for physical units only", () => {
  async function diagnose(prisma, robotId, policy) {
    return robotDispatchReadiness.assessDispatchReadiness({ prisma, kv: null, snapshot: null, seams: null, physicalPolicy: policy, robotId, nowMs: NOW });
  }
  const codes = (report) => report.blockers.map((blocker) => blocker.code);

  test("physical fleet off: PHYSICAL_FLEET_DISABLED", async () => {
    const prisma = commissioningStore([{ robotId: "UNIT-R", lifecycleState: "ACTIVE" }]);
    const report = await diagnose(prisma, "UNIT-R", null);
    expect(codes(report)).toContain("PHYSICAL_FLEET_DISABLED");
    expect(report.declaration).toMatchObject({ fleetEnabled: false, declared: false });
    expect(report.dispatchReady).toBe(false);
  });

  test("not in the declaration, or an invalid entry: NOT_DECLARED with that entry's problems", async () => {
    const prisma = commissioningStore([{ robotId: "UNIT-R", lifecycleState: "ACTIVE" }]);
    const absent = await diagnose(prisma, "UNIT-R", physicalPolicy.fromDeclaration(declarationWith([unitEntry("UNIT-OTHER")])));
    expect(codes(absent)).toContain("NOT_DECLARED");
    const invalid = await diagnose(prisma, "UNIT-R", physicalPolicy.fromDeclaration(declarationWith([unitEntry("UNIT-R", { energy: { soh: 0 } })])));
    expect(invalid.declaration.problems.join(" ")).toMatch(/energy\.soh/);
    expect(invalid.blockers.find((blocker) => blocker.code === "NOT_DECLARED").detail).toMatch(/energy\.soh/);
  });

  test("fleet enabled but the file could not be read: NOT_DECLARED names the file problem, not only the absence", async () => {
    const prisma = commissioningStore([{ robotId: "UNIT-R", lifecycleState: "ACTIVE" }]);
    const report = await diagnose(prisma, "UNIT-R", physicalPolicy.load({ PHYSICAL_FLEET_DECLARATION_FILE: "Z:/no/such/declaration.json" }));
    expect(report.blockers.find((blocker) => blocker.code === "NOT_DECLARED").detail).toMatch(/could not be read/);
    expect(report.declaration.problems.join(" ")).toMatch(/could not be read/);
  });

  test("declared but never applied (COMMISSIONED, no region binding): DECLARATION_NOT_APPLIED and LIFECYCLE_NOT_ACTIVE", async () => {
    const prisma = commissioningStore([{ robotId: "UNIT-R" }]);
    const policy = physicalPolicy.fromDeclaration(declarationWith([unitEntry("UNIT-R")]));
    const report = await diagnose(prisma, "UNIT-R", policy);
    expect(codes(report)).toEqual(expect.arrayContaining(["DECLARATION_NOT_APPLIED", "LIFECYCLE_NOT_ACTIVE", "NOT_INDEXED"]));
    expect(report.blockers.find((blocker) => blocker.code === "LIFECYCLE_NOT_ACTIVE").detail).toMatch(/physical-declaration\/apply/);

    await physicalDeclaration.activateDeclaredRobot(prisma, "UNIT-R", BODY("UNIT-R"), { policy });
    const after = await diagnose(prisma, "UNIT-R", policy);
    expect(after.declaration).toMatchObject({ declared: true, applied: true, regionId: "rnsit" });
    expect(codes(after)).not.toEqual(expect.arrayContaining(["DECLARATION_NOT_APPLIED"]));
    expect(codes(after)).not.toContain("LIFECYCLE_NOT_ACTIVE");
    // Applied and ACTIVE is still not ready: no index entry, no measured position.
    expect(after.dispatchReady).toBe(false);
    expect(codes(after)).toEqual(expect.arrayContaining(["NOT_INDEXED", "NO_MEASURED_POSITION"]));
  });

  test("a simulated unit carries no declaration section and no declaration blocker", async () => {
    const prisma = commissioningStore([{ robotId: "SIM-ABC", simulated: true, lifecycleState: "ACTIVE" }]);
    const report = await diagnose(prisma, "SIM-ABC", null);
    expect(report.simulated).toBe(true);
    expect(report.declaration).toBeNull();
    expect(codes(report).filter((code) => /DECLAR|PHYSICAL_FLEET/.test(code))).toEqual([]);
  });
});

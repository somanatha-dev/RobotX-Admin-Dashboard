/**
 * The robot specification vocabulary — the pure half.
 *
 * This module decides where every operator-entered value is stored, so the tests that
 * matter most are the ones asserting the *destination*: a specification whose battery
 * capacity did not reach `EnergyModel.packNominalWh` is a number on a form that the
 * energy model never sees.
 */

const spec = require("../../../src/services/robotSpecification");

const COMPLETE = Object.freeze({
  massKg: 45,
  maxSpeedMps: 2.5,
  normalSpeedMps: 1.4,
  batteryCapacityWh: 500,
  batteryReservePct: 15,
  payloadCapacityKg: 20,
  initialBatteryPct: 82,
});

describe("robotSpecification — the chassis vocabulary", () => {
  test("resolves the operator-facing labels the Commission form offers", () => {
    expect(spec.normaliseChassisType("Rover (Ground)")).toBe(spec.CHASSIS_TYPE.ROVER);
    expect(spec.normaliseChassisType("Drone (Aerial)")).toBe(spec.CHASSIS_TYPE.DRONE);
  });

  test("resolves the tokens firmware and tests speak", () => {
    expect(spec.normaliseChassisType("ROVER")).toBe(spec.CHASSIS_TYPE.ROVER);
    expect(spec.normaliseChassisType("drone")).toBe(spec.CHASSIS_TYPE.DRONE);
  });

  test("refuses anything it does not recognise rather than guessing a family", () => {
    expect(spec.normaliseChassisType("Quadruped")).toBeNull();
    expect(spec.normaliseChassisType("")).toBeNull();
    expect(spec.normaliseChassisType(null)).toBeNull();
    expect(spec.normaliseChassisType(42)).toBeNull();
  });
});

describe("robotSpecification — validation", () => {
  test("accepts a complete specification", () => {
    const parsed = spec.parseSpecification(COMPLETE, { require: spec.COMMISSIONING_REQUIRED });
    expect(parsed.ok).toBe(true);
    expect(parsed.spec).toEqual(COMPLETE);
  });

  test("commissioning requires every field, and names each missing one", () => {
    const parsed = spec.parseSpecification({ massKg: 45 }, { require: spec.COMMISSIONING_REQUIRED });
    expect(parsed.ok).toBe(false);
    expect(parsed.problems).toHaveLength(spec.COMMISSIONING_REQUIRED.length - 1);
    expect(parsed.problems.join(" ")).toContain("Battery capacity is required.");
  });

  test("an edit requires nothing, so changing one value is not a re-declaration of six", () => {
    const parsed = spec.parseSpecification({ payloadCapacityKg: 12 });
    expect(parsed.ok).toBe(true);
    expect(parsed.spec).toEqual({ payloadCapacityKg: 12 });
  });

  test("a present field is validated whichever call it arrived on", () => {
    const parsed = spec.parseSpecification({ payloadCapacityKg: -3 });
    expect(parsed.ok).toBe(false);
    expect(parsed.problems[0]).toContain("Payload capacity must be between");
  });

  test("refuses a normal speed above the maximum — two statements that cannot both hold", () => {
    const parsed = spec.parseSpecification({ maxSpeedMps: 1.2, normalSpeedMps: 2.0 });
    expect(parsed.ok).toBe(false);
    expect(parsed.problems).toContain("Normal speed cannot exceed max speed.");
  });

  test("accepts numeric strings, because an HTML number input sends strings", () => {
    const parsed = spec.parseSpecification({ massKg: "45.5" });
    expect(parsed.ok).toBe(true);
    expect(parsed.spec.massKg).toBe(45.5);
  });

  test("refuses a non-numeric value rather than coercing it to zero", () => {
    const parsed = spec.parseSpecification({ massKg: "heavy" });
    expect(parsed.ok).toBe(false);
    expect(parsed.spec.massKg).toBeUndefined();
  });
});

describe("robotSpecification — where each entered value is persisted", () => {
  const rows = spec.modelRowsFor({ robotCode: "RBT-1000", chassisType: "ROVER", spec: COMPLETE });

  test("battery capacity lands on EnergyModel.packNominalWh", () => {
    expect(rows.energy.packNominalWh).toBe(500);
  });

  test("payload capacity lands on ContainerModel.totalMassLimitKg", () => {
    expect(rows.container.totalMassLimitKg).toBe(20);
  });

  test("the two speeds land on the two MobilityModel fields that mean them", () => {
    expect(rows.mobility.kinematicLimits).toEqual({ maxSpeedMps: 2.5 });
    expect(rows.mobility.speedModel).toEqual({ nominalSpeedMps: 1.4 });
  });

  test("mass and battery reserve are the only two values carried on the Robot row", () => {
    expect(rows.robot).toEqual({ massKg: 45, batteryReservePct: 15, battery: 82 });
  });

  test("the chassis family reaches BOTH the class column and the §2.3 capability", () => {
    expect(rows.agentClass.chassisType).toBe("ROVER");
    const chassis = rows.bundle.capabilities.find((c) => c.name === spec.CHASSIS_CAPABILITY);
    expect(chassis).toEqual(
      expect.objectContaining({ kind: "ENUMERATED", value: "ROVER" }),
    );
  });

  test("payload capacity is also a QUANTITATIVE capability, so F21 can match a task against it", () => {
    const payload = rows.bundle.capabilities.find((c) => c.name === spec.PAYLOAD_CAPABILITY);
    expect(payload).toEqual(
      expect.objectContaining({ kind: "QUANTITATIVE", value: 20, unit: "kg" }),
    );
  });

  test("a drone gets the aerial traversal domain, not the sidewalk graph", () => {
    const drone = spec.modelRowsFor({ robotCode: "RBT-2000", chassisType: "DRONE", spec: COMPLETE });
    expect(drone.mobility.traversalDomain).toBe("AIRSPACE");
    expect(rows.mobility.traversalDomain).toBe("SIDEWALK_GRAPH");
  });

  test("every id is a deterministic function of the robot's own code", () => {
    const again = spec.modelRowsFor({ robotCode: "RBT-1000", chassisType: "ROVER", spec: COMPLETE });
    expect(again.ids).toEqual(rows.ids);
    expect(rows.ids).toEqual({
      classId: "AC-RBT-1000",
      mobilityId: "MOB-RBT-1000",
      energyId: "ENG-RBT-1000",
      containerId: "CTR-RBT-1000",
      bundleId: "CAP-RBT-1000",
    });
  });

  test("two units never share a parameter set, so editing one cannot change the other", () => {
    const other = spec.modelRowsFor({ robotCode: "RBT-2000", chassisType: "ROVER", spec: COMPLETE });
    expect(other.ids.energyId).not.toBe(rows.ids.energyId);
    expect(other.ids.classId).not.toBe(rows.ids.classId);
  });

  test("an absent value produces no key at all, so an update never blanks a stored one", () => {
    const partial = spec.modelRowsFor({
      robotCode: "RBT-3000",
      chassisType: "ROVER",
      spec: { payloadCapacityKg: 8 },
    });
    expect(partial.energy.packNominalWh).toBeUndefined();
    expect(partial.mobility.kinematicLimits).toEqual({});
    expect(partial.robot).toEqual({});
  });

  test("refuses to build rows without a chassis type", () => {
    expect(() => spec.modelRowsFor({ robotCode: "RBT-1", chassisType: null, spec: COMPLETE })).toThrow(
      /chassis type/i,
    );
  });
});

describe("robotSpecification — the §2.3 RequirementSet a submission produces", () => {
  test("a requested chassis becomes an ENUMERATED EQUALS requirement F21 can evaluate", () => {
    const requirements = spec.requirementSetFor({ chassisType: "Drone (Aerial)" });
    expect(requirements).toEqual([
      { name: "chassis_type", kind: "ENUMERATED", comparator: "EQUALS", value: "DRONE" },
    ]);
  });

  test("a declared payload mass becomes an AT_LEAST requirement against max_payload_mass", () => {
    const requirements = spec.requirementSetFor({ chassisType: "ROVER", payloadMassKg: 7.5 });
    expect(requirements).toContainEqual({
      name: "max_payload_mass",
      kind: "QUANTITATIVE",
      comparator: "AT_LEAST",
      value: 7.5,
      unit: "kg",
    });
  });

  test("states nothing the submitter did not state", () => {
    expect(spec.requirementSetFor({})).toEqual([]);
    expect(spec.requirementSetFor({ payloadMassKg: 0 })).toEqual([]);
  });
});

describe("robotSpecification — the operator-facing projection", () => {
  test("reads each value back from the field it was written to", () => {
    const projection = spec.specificationOf({
      massKg: 45,
      batteryReservePct: 15,
      agent: {
        agentClass: {
          classId: "AC-RBT-1000",
          chassisType: "ROVER",
          mobilityModel: { kinematicLimits: { maxSpeedMps: 2.5 }, speedModel: { nominalSpeedMps: 1.4 } },
          energyModel: { packNominalWh: 500 },
          containerModel: { totalMassLimitKg: 20 },
        },
      },
    });

    expect(projection).toEqual({
      chassisType: "ROVER",
      agentClassId: "AC-RBT-1000",
      massKg: 45,
      maxSpeedMps: 2.5,
      normalSpeedMps: 1.4,
      batteryCapacityWh: 500,
      batteryReservePct: 15,
      payloadCapacityKg: 20,
    });
  });

  test("an unconfigured unit reads as null everywhere — never as an invented default", () => {
    const projection = spec.specificationOf({ robotId: "RBT-LEGACY" });
    expect(Object.values(projection).every((value) => value === null)).toBe(true);
  });
});

describe("the read include cannot drag an unserialisable column into a response", () => {
  /**
   * ── The defect this locks down ────────────────────────────────────────────
   * `SPECIFICATION_INCLUDE` was `include: { agent: { include: { agentClass: … } } }`, which
   * returns the **whole** `Agent` row — including `authorityEpoch` and `fenceCounter`, both
   * `BigInt`. `JSON.stringify` throws on a BigInt, so `GET /api/robots/state` and
   * `PATCH /api/robots/:robotId` answered **HTTP 500** for every robot that had an Agent
   * row, which is every robot. The `PATCH` had already committed its write by then, so it
   * looked like a lost edit and was not one.
   *
   * No unit test could have caught it: a hand-built fake client returns plain numbers, so
   * the whole suite stayed green. It was found by running the real server against a real
   * PostgreSQL. What is asserted here is therefore the **structural** property that makes
   * the class of defect unreachable rather than the one instance of it — a `select` with
   * enumerated leaves cannot acquire a new unserialisable column when somebody adds one to
   * `Agent`, and an `include` can.
   */
  test("the agent is reached by select, not by include", () => {
    expect(spec.SPECIFICATION_INCLUDE.agent.select).toBeDefined();
    expect(spec.SPECIFICATION_INCLUDE.agent.include).toBeUndefined();
  });

  test("no level of the include is a bare `true` that would return a whole row", () => {
    const bareTrue = [];
    const walk = (node, path) => {
      for (const [key, value] of Object.entries(node || {})) {
        if (value === true) {
          // A scalar leaf is fine; a relation selected as `true` returns every column.
          if (["classId", "chassisType", "packNominalWh", "totalMassLimitKg", "kinematicLimits", "speedModel"].includes(key)) continue;
          bareTrue.push(`${path}.${key}`);
        } else if (value && typeof value === "object") {
          walk(value.select || value.include || value, `${path}.${key}`);
        }
      }
    };
    walk(spec.SPECIFICATION_INCLUDE, "robot");
    expect(bareTrue).toEqual([]);
  });

  test("everything the projection reads is selected, so a narrower include is still complete", () => {
    const selected = spec.SPECIFICATION_INCLUDE.agent.select.agentClass.select;
    expect(Object.keys(selected).sort()).toEqual(
      ["chassisType", "classId", "containerModel", "energyModel", "mobilityModel"],
    );
    expect(Object.keys(selected.mobilityModel.select).sort()).toEqual(["kinematicLimits", "speedModel"]);
    expect(Object.keys(selected.energyModel.select)).toEqual(["packNominalWh"]);
    expect(Object.keys(selected.containerModel.select)).toEqual(["totalMassLimitKg"]);
  });

  test("a projection built from exactly those fields is JSON-serialisable", () => {
    const projection = spec.specificationOf({
      massKg: 45,
      batteryReservePct: 15,
      agent: {
        agentClass: {
          classId: "AC-RBT-1000",
          chassisType: "ROVER",
          mobilityModel: { kinematicLimits: { maxSpeedMps: 2.5 }, speedModel: { nominalSpeedMps: 1.4 } },
          energyModel: { packNominalWh: 500 },
          containerModel: { totalMassLimitKg: 20 },
        },
      },
    });
    expect(() => JSON.stringify(projection)).not.toThrow();
  });
});

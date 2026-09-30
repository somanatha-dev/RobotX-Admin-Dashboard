"use strict";

/**
 * The agent snapshot carries the capability bundle's **capabilities**, so F21 can match a
 * task's requirements against them.
 *
 * The defect (found live, 2026-09-27): `agentSnapshotLoaderFor` loaded
 * `agentClass.capabilityBundle: true`, which returns the bundle ROW only — Prisma returns a
 * relation's rows only when they are included. `domain/capability.indexBundle` reads
 * `bundle.capabilities`, found none, and every stated requirement came back INDETERMINATE,
 * which F21 denies. A task with no requirement passed (nothing to match), so only tasks
 * that state one — every task the dashboard's form creates (chassis + payload) — found no
 * candidate, silently.
 *
 * The prisma double below honours `include` the way Prisma does: the capability rows are
 * returned only when `capabilityBundle.include.capabilities` is requested. The rows are the
 * ones commissioning writes (`robotSpecification.capabilityRowsFor`) and the requirements
 * the ones intake writes (`robotSpecification.requirementSetFor`), so neither side is
 * restated here. On the old query the SATISFIED cases below fail.
 */

const coordinatorSolvePath = require("../../src/workers/coordinatorSolvePath");
const robotSpecification = require("../../src/services/robotSpecification");
const f21 = require("../../src/engine/feasibility/predicates/f21");

const ROW_ID = "agent-row-7f3a";
const BUSINESS_ID = "V1DEMO-01";

/** What commissioning writes for a simulated ROVER rated 5 kg. */
const BUNDLE_ROW = Object.freeze({ id: "bundle-row-1", bundleId: "CAP-V1DEMO-01", name: "V1DEMO-01 capabilities" });
const CAPABILITY_ROWS = robotSpecification
  .capabilityRowsFor(robotSpecification.CHASSIS_TYPE.ROVER, { payloadCapacityKg: 5 })
  .map((row, index) => ({ id: `cap-${index}`, bundleId: BUNDLE_ROW.id, unit: null, issuer: null, validFrom: null, validUntil: null, ...row }));

/**
 * `agentCellPosition.findFirst`, returning what Prisma would for the `include` it is given.
 * Records the query so the test can also state what was asked for.
 */
function prismaHonouringInclude(queries) {
  return {
    agentCellPosition: {
      findFirst: async (args) => {
        queries.push(args);
        const requested = args.include.agent.include.agentClass.include.capabilityBundle;
        const withRows = Boolean(requested && requested.include && requested.include.capabilities === true);
        return {
          lat: 12.9007,
          lon: 77.5176,
          fineCellId: "8b6014510498fff",
          coarseCellId: "85601453fffffff",
          availabilityClass: "IDLE_READY",
          capabilityClasses: [],
          containerClasses: [],
          observedAtMs: BigInt(Date.now()),
          agent: {
            id: ROW_ID,
            agentId: BUSINESS_ID,
            lifecycleState: "ACTIVE",
            authorityEpoch: 0n,
            fenceCounter: 0n,
            commitments: [],
            batteryState: null,
            robot: { robotId: BUSINESS_ID, simulated: true },
            agentClass: {
              id: "class-row-1",
              classId: "AC-V1DEMO-01",
              chassisType: "ROVER",
              mobilityModel: null,
              energyModel: null,
              containerModel: null,
              energyModelParams: [],
              capabilityBundle: withRows ? { ...BUNDLE_ROW, capabilities: CAPABILITY_ROWS } : { ...BUNDLE_ROW },
            },
          },
        };
      },
    },
  };
}

async function loadSnapshot() {
  const queries = [];
  const load = coordinatorSolvePath.agentSnapshotLoaderFor({ prisma: prismaHonouringInclude(queries) });
  const snapshot = await load(ROW_ID);
  return { snapshot, queries };
}

/** F21 on the loaded snapshot, for the RequirementSet intake builds from a form submission. */
function f21For(snapshot, submission) {
  return f21.evaluate({
    agentSnapshot: snapshot,
    mission: { requirements: robotSpecification.requirementSetFor(submission) },
    plan: {},
  });
}

describe("the agent snapshot carries the bundle's capabilities (F21 can match requirements)", () => {
  test("the loader asks for the bundle's capability rows", async () => {
    const { queries } = await loadSnapshot();
    expect(queries[0].include.agent.include.agentClass.include.capabilityBundle).toEqual({ include: { capabilities: true } });
  });

  test("the snapshot's bundle contains ROVER", async () => {
    const { snapshot } = await loadSnapshot();
    const chassis = (snapshot.capabilityBundle.capabilities || []).find((row) => row.name === "chassis_type");
    expect(chassis).toMatchObject({ kind: "ENUMERATED", value: "ROVER", source: "COMMISSIONING_RECORD" });
  });

  test("a task requiring ROVER: F21 is SATISFIED", async () => {
    const { snapshot } = await loadSnapshot();
    expect(f21For(snapshot, { chassisType: "ROVER" }).outcome).toBe("SATISFIED");
  });

  test("the dashboard form's task (ROVER + 1 kg): F21 is SATISFIED for both requirements", async () => {
    const { snapshot } = await loadSnapshot();
    const verdict = f21For(snapshot, { chassisType: "ROVER", payloadMassKg: 1 });
    expect(verdict.outcome).toBe("SATISFIED");
    expect(verdict.observed).toEqual({ requirementsMatched: 2 });
  });

  test("an unsupported chassis (DRONE) is still VIOLATED — rejected, not indeterminate", async () => {
    const { snapshot } = await loadSnapshot();
    const verdict = f21For(snapshot, { chassisType: "DRONE" });
    expect(verdict.outcome).toBe("VIOLATED");
    expect(verdict.reason).toMatch(/chassis_type/);
  });

  test("a payload above the rated capacity (10 kg on a 5 kg unit) is still VIOLATED", async () => {
    const { snapshot } = await loadSnapshot();
    const verdict = f21For(snapshot, { chassisType: "ROVER", payloadMassKg: 10 });
    expect(verdict.outcome).toBe("VIOLATED");
    expect(verdict.reason).toMatch(/max_payload_mass/);
  });

  test("a capability the bundle does not record stays INDETERMINATE (F21 semantics unchanged)", async () => {
    const { snapshot } = await loadSnapshot();
    const verdict = f21.evaluate({
      agentSnapshot: snapshot,
      mission: { requirements: [{ name: "cold_chain_min_temp", kind: "QUANTITATIVE", comparator: "AT_MOST", value: 2 }] },
      plan: {},
    });
    expect(verdict.outcome).toBe("INDETERMINATE");
  });
});

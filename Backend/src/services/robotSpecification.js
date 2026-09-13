"use strict";

/**
 * Robot specification — the vocabulary of a commissioned unit's configuration.
 *
 * ── What this module is, and what it deliberately is not ────────────────────
 * It is a **pure** module: parsing, validation, and the mapping from an operator's
 * entered numbers onto the model rows §2.1–§2.3 already define. It reads no clock, no
 * environment and no database, so the same input always produces the same rows and the
 * mapping is testable without a store.
 *
 * It is **not** a second type system. The chassis a unit is commissioned as resolves to
 * an `AgentClass`, which is the schema's own comment for what a class is for — *"the
 * agent class keys every model-specific parameter set"* — and every specification value
 * lands on the existing field that already means it:
 *
 * | Operator enters | Persisted on | Read by |
 * |---|---|---|
 * | battery capacity (Wh) | `EnergyModel.packNominalWh` | §14.1/§14.5 energy feasibility |
 * | payload capacity (kg) | `ContainerModel.totalMassLimitKg` | F22, §15.2 |
 * | max speed (m/s) | `MobilityModel.kinematicLimits.maxSpeedMps` | §5 traversal |
 * | normal speed (m/s) | `MobilityModel.speedModel.nominalSpeedMps` | §5 traversal |
 * | chassis type | `AgentClass.chassisType` **and** the `chassis_type` capability | F21 (§2.3) |
 * | mass (kg) | `Robot.massKg` | §14.2's `β_mass` term |
 * | battery reserve (%) | `Robot.batteryReservePct` | the unit's own protection floor |
 *
 * The last two rows are the only new columns, and each is here for the reason stated on
 * it. **Mass** had no column anywhere in the schema before this module existed, which is
 * why `Robot.massKg` was added with it (migration
 * `20260906120000_robot_specification_and_chassis_class`); the column exists now and this
 * module is its declared sole writer, so a reader looking for the vehicle's own mass
 * should look there rather than concluding none is recorded. What is still absent is a
 * *producer* on the decision path — nothing reads `massKg` onto the agent snapshot — which
 * is why `coordinatorPipeline`'s `masses.vehicleMassKg` requirement is still unsatisfied
 * and still fails closed. **Battery reserve** is the
 * *unit's* hardware protection floor, which is a different quantity from §14.5's
 * four-layer reserve stack (`engine/energy/reserves.js`): that stack is composed in
 * watt-hours from published register parameters at decision time, and writing an
 * operator-entered percentage into it would be a fabricated calibration value. The two
 * are kept apart deliberately rather than conflated because they are apart.
 *
 * ── Why the model rows are per unit ─────────────────────────────────────────
 * Because the values are per unit. Two rovers commissioned with different packs are two
 * different `packNominalWh`, and a single shared `EnergyModel` row would make editing
 * one robot's battery capacity silently change every other robot's. The chassis
 * *template* below supplies everything that genuinely is shared — the traversal domain,
 * the permission set, the capability shape — and the operator's numbers are what
 * distinguish one unit's parameter set from another's.
 *
 * Every id is a deterministic function of the robot's own code, so applying a
 * specification twice converges on the same rows rather than creating a second set.
 */

/**
 * The chassis families this deployment commissions.
 * @structural the enumerated chassis vocabulary, not a tunable value
 */
const CHASSIS_TYPE = Object.freeze({
  ROVER: "ROVER",
  DRONE: "DRONE",
});

const CHASSIS_TYPES = Object.freeze(Object.values(CHASSIS_TYPE));

/**
 * The name of the §2.3 capability that carries a unit's chassis family.
 *
 * A capability rather than a bespoke filter, because §2.3's typed algebra
 * (`engine/domain/capability.js`) and F21 already implement requirement matching, and a
 * second matcher written for one attribute is a second place the semantics drift. It is
 * `ENUMERATED` with an `EQUALS` comparator: a task asking for a rover is asking for a
 * value, not a threshold.
 */
const CHASSIS_CAPABILITY = "chassis_type";

/**
 * The name of the §2.3 capability a task's payload mass is matched against. Already
 * seeded by `prisma/seed.js` on the default bundle, and kept identical here so a robot
 * commissioned today and one backfilled before this change answer the same requirement.
 */
const PAYLOAD_CAPABILITY = "max_payload_mass";

/**
 * What is shared by every unit of a chassis family.
 *
 * Deliberately thin: it holds only what is true of the *family* and carries no number an
 * operator is asked for. A default battery capacity here would be a value nobody
 * entered, appearing on a unit's specification page as though somebody had.
 */
const CHASSIS_TEMPLATE = Object.freeze({
  [CHASSIS_TYPE.ROVER]: Object.freeze({
    chassisType: CHASSIS_TYPE.ROVER,
    label: "Rover (Ground)",
    className: "Ground rover",
    traversalDomain: "SIDEWALK_GRAPH",
    permissionSet: Object.freeze({ roadClasses: ["footway", "path", "service"], stairCapable: false }),
    loadingInterface: "HUMAN_HANDOVER",
    cleanlinessClass: "GENERAL",
    chemistry: "LFP",
  }),
  [CHASSIS_TYPE.DRONE]: Object.freeze({
    chassisType: CHASSIS_TYPE.DRONE,
    label: "Drone (Aerial)",
    className: "Aerial drone",
    traversalDomain: "AIRSPACE",
    permissionSet: Object.freeze({ roadClasses: [], stairCapable: false, airspaceClass: "UNCONTROLLED" }),
    loadingInterface: "HUMAN_HANDOVER",
    cleanlinessClass: "GENERAL",
    chemistry: "LIPO",
  }),
});

/** The six numbers an operator supplies, plus the initial state of charge (P0-12). */
const SPECIFICATION_FIELDS = Object.freeze([
  "massKg",
  "maxSpeedMps",
  "normalSpeedMps",
  "batteryCapacityWh",
  "batteryReservePct",
  "payloadCapacityKg",
]);

/**
 * Resolve an operator-facing chassis label, or an already-normalised token, to the
 * canonical chassis type.
 *
 * The UI's option values are human labels ("Rover (Ground)"), and firmware and tests
 * speak the token. Both resolve here rather than at each caller, so there is exactly one
 * answer to "what chassis is this".
 *
 * @param {unknown} input
 * @returns {string|null} a `CHASSIS_TYPE` value, or null when nothing recognisable
 */
function normaliseChassisType(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;

  const upper = trimmed.toUpperCase();
  if (CHASSIS_TYPES.includes(upper)) return upper;

  // The operator-facing labels, and any spelling that leads with the family name.
  if (upper.startsWith("ROVER")) return CHASSIS_TYPE.ROVER;
  if (upper.startsWith("DRONE")) return CHASSIS_TYPE.DRONE;
  if (upper.includes("GROUND")) return CHASSIS_TYPE.ROVER;
  if (upper.includes("AERIAL")) return CHASSIS_TYPE.DRONE;
  return null;
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteNumberOrNull(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The bounds each specification value must lie in, with the sentence a rejection
 * carries. Held as data so the API, the UI contract and the tests read one table.
 *
 * @structural units and physical bounds, not tunable behaviour
 */
const BOUNDS = Object.freeze({
  massKg: Object.freeze({ min: 0.1, max: 5000, unit: "kg", label: "Mass" }),
  maxSpeedMps: Object.freeze({ min: 0.1, max: 60, unit: "m/s", label: "Max speed" }),
  normalSpeedMps: Object.freeze({ min: 0.1, max: 60, unit: "m/s", label: "Normal speed" }),
  batteryCapacityWh: Object.freeze({ min: 1, max: 200000, unit: "Wh", label: "Battery capacity" }),
  batteryReservePct: Object.freeze({ min: 0, max: 90, unit: "%", label: "Battery reserve" }),
  payloadCapacityKg: Object.freeze({ min: 0, max: 5000, unit: "kg", label: "Payload capacity" }),
  initialBatteryPct: Object.freeze({ min: 0, max: 100, unit: "%", label: "Initial battery" }),
});

/**
 * Validate and normalise a specification.
 *
 * ── Partial input is admitted, and that is what makes PATCH honest ──────────
 * `require` names the fields that must be present. Commissioning requires all of them;
 * an edit requires none, because an edit of one field is not a re-declaration of the
 * other five. A field that is present is always validated, whichever call it arrived on.
 *
 * @param {object|null|undefined} input
 * @param {{ require?: string[] }} [options]
 * @returns {{ ok: boolean, spec: object, problems: string[] }}
 */
function parseSpecification(input, options) {
  const source = input && typeof input === "object" ? input : {};
  const settings = options || {};
  const required = Array.isArray(settings.require) ? settings.require : [];

  const spec = {};
  const problems = [];

  const fields = [...SPECIFICATION_FIELDS, "initialBatteryPct"];
  for (const field of fields) {
    const raw = source[field];
    if (raw === undefined || raw === null || raw === "") {
      if (required.includes(field)) problems.push(`${BOUNDS[field].label} is required.`);
      continue;
    }

    const value = finiteNumberOrNull(raw);
    if (value === null) {
      problems.push(`${BOUNDS[field].label} must be a number.`);
      continue;
    }

    const bound = BOUNDS[field];
    if (value < bound.min || value > bound.max) {
      problems.push(`${bound.label} must be between ${bound.min} and ${bound.max} ${bound.unit}.`);
      continue;
    }

    spec[field] = value;
  }

  // A normal speed above the maximum is not a rounding error; it is two statements that
  // cannot both be true, and accepting it would put a speed model into the traversal
  // path that its own kinematic limit forbids. Checked only when both are in hand —
  // an edit that moves one against a stored other is checked by the caller, which is the
  // only party that holds the stored value.
  if (spec.normalSpeedMps !== undefined && spec.maxSpeedMps !== undefined) {
    if (spec.normalSpeedMps > spec.maxSpeedMps) {
      problems.push("Normal speed cannot exceed max speed.");
    }
  }

  return { ok: problems.length === 0, spec, problems };
}

/** The fields commissioning requires. */
const COMMISSIONING_REQUIRED = Object.freeze([...SPECIFICATION_FIELDS, "initialBatteryPct"]);

/* ═══════════════════════════════════════════════════════════════════════════
   DEVELOPMENT simulation presets
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The three chassis weights the DEVELOPMENT simulation is exercised at.
 *
 * ── What these are ──────────────────────────────────────────────────────────
 * Three sets of **owner-declared DEVELOPMENT simulation values**, expressed in the
 * specification vocabulary this module already defines. They are a convenience for the
 * operator creating a simulated unit: selecting one fills three of the seven fields the
 * commissioning form asks for, and the operator still enters the rest.
 *
 * ── What these are emphatically NOT ─────────────────────────────────────────
 *   * **Not a robot class.** `AgentClass` is what keys a model-specific parameter set, and
 *     a simulated unit gets its own per-unit class exactly as a physical one does
 *     (`modelIdsFor`). A preset name is never written to a database column, never reaches
 *     an `AgentClass`, never becomes a capability, and nothing in the engine can read one.
 *   * **Not a chassis type.** `CHASSIS_TYPE` remains ROVER/DRONE. A preset says how heavy
 *     and how quick a development unit is, not what family it belongs to; the two are
 *     chosen independently on the form.
 *   * **Not a second specification mechanism.** The values land on the same three fields
 *     an operator would otherwise type, go through the same `parseSpecification`, and are
 *     persisted by the same `modelRowsFor`. Deleting this table would remove a
 *     convenience and change no behaviour.
 *   * **Not physical measurements.** Nothing here was weighed or timed. They are declared
 *     figures for a development simulation and carry no evidentiary weight whatsoever.
 *
 * ── Why only three of the seven fields ──────────────────────────────────────
 * Because only three were declared. The owner stated a nominal speed, a payload capacity
 * and a vehicle mass per preset, and stated a pack capacity of **6000 mAh** for the
 * simulated fleet as a whole. The remaining four commissioning fields are deliberately
 * absent rather than filled with a plausible number:
 *
 *   | Field | Why it is not here |
 *   |---|---|
 *   | `maxSpeedMps` | A *kinematic limit* is a different quantity from a nominal speed and does not follow from it. Copying the nominal into it would assert that these vehicles cannot exceed their cruising speed. |
 *   | `batteryCapacityWh` | **6000 mAh is not watt-hours.** The conversion needs a nominal pack voltage, which nobody has declared. Choosing one would invent the pack. |
 *   | `batteryReservePct` | The unit's own hardware protection floor. Undeclared, and a guess here becomes the floor a unit refuses missions at. |
 *   | `initialBatteryPct` | Configured initial state. The owner asked for it to be *realistically randomised 30–100 %*, which is a property of how a fleet is seeded, not a constant belonging to a chassis preset. |
 *
 * A preset therefore leaves those four blank and the form still requires them, which is
 * the behaviour that keeps an undeclared value from arriving through a convenience.
 *
 * @structural owner-declared DEVELOPMENT simulation figures, not tunable behaviour
 */
const SIMULATION_PRESET = Object.freeze({
  LIGHT: Object.freeze({
    name: "LIGHT",
    label: "Light",
    massKg: 1,
    normalSpeedMps: 1.2,
    payloadCapacityKg: 3,
  }),
  STANDARD: Object.freeze({
    name: "STANDARD",
    label: "Standard",
    massKg: 2,
    normalSpeedMps: 1.5,
    payloadCapacityKg: 5,
  }),
  HEAVY: Object.freeze({
    name: "HEAVY",
    label: "Heavy",
    massKg: 3,
    normalSpeedMps: 1.0,
    payloadCapacityKg: 8,
  }),
});

const SIMULATION_PRESET_NAMES = Object.freeze(Object.keys(SIMULATION_PRESET));

/**
 * The specification fields a preset declares — and, by omission, the ones it does not.
 * Exported so the UI and the tests read one list rather than three copies of it.
 * @structural the declared subset
 */
const PRESET_DECLARED_FIELDS = Object.freeze(["massKg", "normalSpeedMps", "payloadCapacityKg"]);

/**
 * The commissioning fields a preset deliberately leaves for the operator, each with the
 * reason it is not declared. Held as data so a form can *show* why a field is still empty
 * instead of leaving the operator to wonder whether the preset failed.
 * @structural the undeclared subset and its stated reasons
 */
const PRESET_UNDECLARED_FIELDS = Object.freeze({
  maxSpeedMps: "A kinematic limit is not implied by a nominal speed — declare it per unit.",
  batteryCapacityWh: "6000 mAh cannot become Wh without a declared nominal pack voltage.",
  batteryReservePct: "The unit's own hardware protection floor — undeclared.",
  initialBatteryPct: "Configured initial state, seeded per unit rather than per chassis.",
});

/**
 * Resolve a preset name to its declared values.
 *
 * Returns a **copy**, so a caller that spreads it into form state cannot mutate the table,
 * and `null` for anything unrecognised — a misspelled preset fills nothing rather than
 * silently falling back to one of the three.
 *
 * @param {unknown} name
 * @returns {{ massKg: number, normalSpeedMps: number, payloadCapacityKg: number }|null}
 */
function simulationPresetValues(name) {
  if (typeof name !== "string") return null;
  const preset = SIMULATION_PRESET[name.trim().toUpperCase()];
  if (!preset) return null;
  return {
    massKg: preset.massKg,
    normalSpeedMps: preset.normalSpeedMps,
    payloadCapacityKg: preset.payloadCapacityKg,
  };
}

/**
 * The deterministic business keys one unit's parameter set is stored under.
 *
 * @param {string} robotCode the legacy `Robot.robotId`
 * @returns {{ classId: string, mobilityId: string, energyId: string,
 *             containerId: string, bundleId: string }}
 */
function modelIdsFor(robotCode) {
  const key = String(robotCode);
  return Object.freeze({
    classId: `AC-${key}`,
    mobilityId: `MOB-${key}`,
    energyId: `ENG-${key}`,
    containerId: `CTR-${key}`,
    bundleId: `CAP-${key}`,
  });
}

/**
 * The §2.3 capability rows a unit's bundle carries.
 *
 * Three, and each is a fact somebody stated at commissioning rather than a default this
 * module invented: the chassis family, the payload limit the operator entered, and
 * `custody_transfer_capable`, whose *false* is §2.3's own stated default and the one
 * capability the specification names as safe to default.
 *
 * @param {string} chassisType
 * @param {object} spec a parsed specification
 * @returns {object[]} rows in `Capability` create shape
 */
function capabilityRowsFor(chassisType, spec) {
  const rows = [
    {
      name: CHASSIS_CAPABILITY,
      kind: "ENUMERATED",
      value: chassisType,
      source: "COMMISSIONING_RECORD",
    },
    {
      name: "custody_transfer_capable",
      kind: "BOOLEAN",
      value: false,
      source: "COMMISSIONING_RECORD",
    },
  ];

  if (spec.payloadCapacityKg !== undefined) {
    rows.push({
      name: PAYLOAD_CAPABILITY,
      kind: "QUANTITATIVE",
      value: spec.payloadCapacityKg,
      unit: "kg",
      source: "COMMISSIONING_RECORD",
    });
  }

  return rows;
}

/**
 * The complete set of model rows one unit's specification maps to.
 *
 * Returned as data rather than written here: this module has no store, and a caller that
 * receives rows can upsert them inside whatever transaction it already holds.
 *
 * @param {object} input `{ robotCode, chassisType, spec }`
 * @returns {object} `{ ids, chassis, mobility, energy, container, bundle, agentClass, robot }`
 */
function modelRowsFor(input) {
  const source = input || {};
  const robotCode = String(source.robotCode || "");
  const chassisType = normaliseChassisType(source.chassisType);
  const spec = source.spec && typeof source.spec === "object" ? source.spec : {};

  if (robotCode === "") throw new TypeError("modelRowsFor requires the robot's own code — every id derives from it");
  if (chassisType === null) {
    throw new TypeError(`modelRowsFor requires a chassis type; one of ${CHASSIS_TYPES.join(", ")}`);
  }

  const chassis = CHASSIS_TEMPLATE[chassisType];
  const ids = modelIdsFor(robotCode);

  return Object.freeze({
    ids,
    chassis,
    mobility: {
      modelId: ids.mobilityId,
      name: `${chassis.className} — ${robotCode}`,
      traversalDomain: chassis.traversalDomain,
      permissionSet: { ...chassis.permissionSet },
      // Two distinct quantities, on the two fields that mean them. `kinematicLimits` is
      // what the vehicle *cannot exceed*; `speedModel` is what it is *expected to do*,
      // which is the one a traversal estimate reads. Collapsing them into one number is
      // how a planner comes to assume a fleet always travels at its rated maximum.
      kinematicLimits: numbersOnly({ maxSpeedMps: spec.maxSpeedMps }),
      speedModel: numbersOnly({ nominalSpeedMps: spec.normalSpeedMps }),
    },
    energy: {
      modelId: ids.energyId,
      name: `${chassis.className} pack — ${robotCode}`,
      chemistry: chassis.chemistry,
      ...(spec.batteryCapacityWh === undefined ? {} : { packNominalWh: spec.batteryCapacityWh }),
    },
    container: {
      modelId: ids.containerId,
      name: `${chassis.className} container — ${robotCode}`,
      loadingInterface: chassis.loadingInterface,
      cleanlinessClass: chassis.cleanlinessClass,
      ...(spec.payloadCapacityKg === undefined ? {} : { totalMassLimitKg: spec.payloadCapacityKg }),
    },
    bundle: {
      bundleId: ids.bundleId,
      name: `${chassis.className} capabilities — ${robotCode}`,
      capabilities: capabilityRowsFor(chassisType, spec),
    },
    agentClass: {
      classId: ids.classId,
      name: `${chassis.className} — ${robotCode}`,
      chassisType,
    },
    // The two values with no existing column, and the initial state of charge. Kept in
    // one place so a caller writes the `Robot` row once.
    robot: numbersOnly({
      massKg: spec.massKg,
      batteryReservePct: spec.batteryReservePct,
      battery: spec.initialBatteryPct,
    }),
  });
}

/**
 * Drop absent keys so an upsert's `update` branch never writes `undefined` over a stored
 * value — the difference between "the operator changed nothing" and "the operator
 * cleared it".
 *
 * @param {object} object
 * @returns {object}
 */
function numbersOnly(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * The §2.3 RequirementSet a task submission produces.
 *
 * ── Why this shape ──────────────────────────────────────────────────────────
 * `Task.requirements` is the RequirementSet column §2.4 already defines, F21 is the
 * predicate that evaluates it, and `domain/capability.matchRequirements` is the algebra.
 * A requested chassis and a declared payload mass are two ordinary requirements in that
 * algebra, so neither needs a new field, a new predicate, or a filter of its own.
 *
 * The list is returned **only** for what the submitter actually stated. An empty list is
 * a task with no requirements, which is a real and different thing from a task whose
 * requirements are unknown; the caller stores `null` for the second.
 *
 * @param {{ chassisType?: unknown, payloadMassKg?: unknown }} input
 * @returns {object[]}
 */
function requirementSetFor(input) {
  const source = input || {};
  const requirements = [];

  const chassisType = normaliseChassisType(source.chassisType);
  if (chassisType !== null) {
    requirements.push({
      name: CHASSIS_CAPABILITY,
      kind: "ENUMERATED",
      comparator: "EQUALS",
      value: chassisType,
    });
  }

  const massKg = finiteNumberOrNull(source.payloadMassKg);
  if (massKg !== null && massKg > 0) {
    requirements.push({
      name: PAYLOAD_CAPABILITY,
      kind: "QUANTITATIVE",
      comparator: "AT_LEAST",
      value: massKg,
      unit: "kg",
    });
  }

  return requirements;
}

/**
 * The operator-facing projection of a robot's stored specification.
 *
 * One reader for the list page, the detail page and the edit form, so the three cannot
 * disagree about what a unit is configured as. Every field is `null` when the unit has
 * no stored value — never a default, because a page that shows an invented battery
 * capacity is worse than one that shows a dash.
 *
 * @param {object|null} robot a `Robot` row, optionally including `agent.agentClass`
 * @returns {object|null}
 */
function specificationOf(robot) {
  if (!robot || typeof robot !== "object") return null;

  const agentClass = robot.agent && robot.agent.agentClass ? robot.agent.agentClass : null;
  const mobility = agentClass && agentClass.mobilityModel ? agentClass.mobilityModel : null;
  const energy = agentClass && agentClass.energyModel ? agentClass.energyModel : null;
  const container = agentClass && agentClass.containerModel ? agentClass.containerModel : null;

  const kinematic = mobility && mobility.kinematicLimits && typeof mobility.kinematicLimits === "object"
    ? mobility.kinematicLimits
    : {};
  const speedModel = mobility && mobility.speedModel && typeof mobility.speedModel === "object"
    ? mobility.speedModel
    : {};

  return {
    chassisType: agentClass && agentClass.chassisType ? agentClass.chassisType : null,
    agentClassId: agentClass && agentClass.classId ? agentClass.classId : null,
    massKg: finiteNumberOrNull(robot.massKg),
    maxSpeedMps: finiteNumberOrNull(kinematic.maxSpeedMps),
    normalSpeedMps: finiteNumberOrNull(speedModel.nominalSpeedMps),
    batteryCapacityWh: finiteNumberOrNull(energy ? energy.packNominalWh : null),
    batteryReservePct: finiteNumberOrNull(robot.batteryReservePct),
    payloadCapacityKg: finiteNumberOrNull(container ? container.totalMassLimitKg : null),
  };
}

/**
 * The Prisma `include` that makes `specificationOf` answerable.
 *
 * Exported so every read path uses the same one. A page that forgot a level of this
 * include would render a fully-configured robot as unconfigured, which is the failure mode
 * a shared constant removes.
 *
 * ── Why this is a `select` and not an `include` ─────────────────────────────
 * Because `Agent` carries `authorityEpoch` and `fenceCounter`, and both are `BigInt`.
 * `JSON.stringify` throws on a BigInt — *"Do not know how to serialize a BigInt"* — so an
 * `include: { agent: true }` here made `GET /api/robots/state` and `PATCH /api/robots/:id`
 * answer **HTTP 500** the moment a robot had an Agent row, which is every robot. The
 * database write had already committed by then, so the failure looked like a lost edit and
 * was not one.
 *
 * A unit test with a hand-built fake client cannot catch this: its rows are plain numbers.
 * It was found by running the real server against a real PostgreSQL, which is why the
 * columns are enumerated here rather than pulled in wholesale — a `select` cannot acquire
 * a new unserialisable column when someone adds one to `Agent`.
 */
const SPECIFICATION_INCLUDE = Object.freeze({
  agent: {
    select: {
      agentClass: {
        select: {
          classId: true,
          chassisType: true,
          mobilityModel: { select: { kinematicLimits: true, speedModel: true } },
          energyModel: { select: { packNominalWh: true } },
          containerModel: { select: { totalMassLimitKg: true } },
        },
      },
    },
  },
});

module.exports = {
  CHASSIS_TYPE,
  CHASSIS_TYPES,
  CHASSIS_TEMPLATE,
  CHASSIS_CAPABILITY,
  PAYLOAD_CAPABILITY,
  SPECIFICATION_FIELDS,
  COMMISSIONING_REQUIRED,
  BOUNDS,
  // DEVELOPMENT simulation presets. Three declared values each; never a class, never a
  // chassis type, never persisted as a name.
  SIMULATION_PRESET,
  SIMULATION_PRESET_NAMES,
  PRESET_DECLARED_FIELDS,
  PRESET_UNDECLARED_FIELDS,
  simulationPresetValues,
  SPECIFICATION_INCLUDE,
  normaliseChassisType,
  parseSpecification,
  modelIdsFor,
  modelRowsFor,
  capabilityRowsFor,
  requirementSetFor,
  specificationOf,
};

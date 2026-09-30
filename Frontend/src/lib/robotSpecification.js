/**
 * The unit-specification vocabulary, client side.
 *
 * One declaration shared by the Commission form, the Units list, the detail page, the edit
 * form and the task modal's model selector — so the label, the unit and the bounds a user
 * sees are the same in all five, and a field added here appears everywhere at once.
 *
 * The bounds mirror `Backend/src/services/robotSpecification.js`. The client copy exists to
 * give immediate feedback, **not** to be the authority: the server validates every value
 * again and its refusal is what the form reports. A client-only check would be a check an
 * API caller can skip.
 */

/** The chassis families the backend commissions. Its tokens, not new ones. */
export const CHASSIS_OPTIONS = Object.freeze([
  { value: 'ROVER', label: 'Rover (Ground)', hint: 'Ground vehicle, sidewalk and service roads' },
  { value: 'DRONE', label: 'Drone (Aerial)', hint: 'Aerial vehicle, uncontrolled airspace' },
]);

export const CHASSIS_LABEL = Object.freeze(
  Object.fromEntries(CHASSIS_OPTIONS.map((option) => [option.value, option.label])),
);

/**
 * The six specification values, in the order they are asked for and displayed.
 *
 * `storedOn` records where the backend persists each one. It is shown nowhere; it is here
 * so the next person reading this file learns that these are not loose form fields but the
 * existing model rows the assignment engine reads.
 */
export const SPECIFICATION_FIELDS = Object.freeze([
  {
    key: 'massKg',
    label: 'Mass',
    unit: 'kg',
    min: 0.1,
    max: 5000,
    step: 0.1,
    placeholder: '45',
    storedOn: 'Robot.massKg',
  },
  {
    key: 'maxSpeedMps',
    label: 'Max speed',
    unit: 'm/s',
    min: 0.1,
    max: 60,
    step: 0.1,
    placeholder: '2.5',
    storedOn: 'MobilityModel.kinematicLimits.maxSpeedMps',
  },
  {
    key: 'normalSpeedMps',
    label: 'Normal speed',
    unit: 'm/s',
    min: 0.1,
    max: 60,
    step: 0.1,
    placeholder: '1.4',
    storedOn: 'MobilityModel.speedModel.nominalSpeedMps',
  },
  {
    key: 'batteryCapacityWh',
    label: 'Battery capacity',
    unit: 'Wh',
    min: 1,
    max: 200000,
    step: 1,
    placeholder: '500',
    storedOn: 'EnergyModel.packNominalWh',
  },
  {
    key: 'batteryReservePct',
    label: 'Battery reserve',
    unit: '%',
    min: 0,
    max: 90,
    step: 1,
    placeholder: '15',
    storedOn: 'Robot.batteryReservePct',
  },
  {
    key: 'payloadCapacityKg',
    label: 'Payload capacity',
    unit: 'kg',
    min: 0,
    max: 5000,
    step: 0.1,
    placeholder: '20',
    storedOn: 'ContainerModel.totalMassLimitKg',
  },
]);

/**
 * The initial state of charge, asked for separately and labelled as what it is.
 *
 * It is **configured initial state**, not a measurement. Commissioning used to seed a
 * random value between 70 % and 100 %, which then travelled to the dashboard, the
 * simulator's pack and the energy model as though somebody had read it off a vehicle. The
 * form asks instead, and every surface that shows it says where it came from.
 */
export const INITIAL_BATTERY_FIELD = Object.freeze({
  key: 'initialBatteryPct',
  label: 'Initial battery',
  unit: '%',
  min: 0,
  max: 100,
  step: 1,
  placeholder: '100',
  note: 'Configured initial state — not a measured reading.',
});

/**
 * The three DEVELOPMENT simulation presets, mirroring
 * `Backend/src/services/robotSpecification.js`.
 *
 * ── What selecting one does, and what it deliberately does not ──────────────
 * It fills **three** fields — mass, normal speed and payload capacity — because those are
 * the three the owner declared per chassis weight. It does not fill the other four, and
 * that is the point rather than an omission:
 *
 *   * `maxSpeedMps` — a kinematic limit does not follow from a nominal speed;
 *   * `batteryCapacityWh` — the declared pack is **6000 mAh**, and milliamp-hours cannot
 *     become watt-hours without a nominal pack voltage nobody has declared;
 *   * `batteryReservePct` — the unit's own hardware protection floor, undeclared;
 *   * `initialBatteryPct` — configured initial state, seeded per unit.
 *
 * Those four stay empty, visible and required, so the operator supplies them and no
 * value nobody chose reaches the engine through a convenience button. `PRESET_UNDECLARED`
 * carries the sentence explaining each, so the form can say *why* a field is still blank
 * instead of leaving it looking like the preset failed.
 *
 * These are not classes, not chassis types, and are never sent to the server: only the
 * resulting numbers are, on the same `specification` object a hand-typed form produces.
 */
export const SIMULATION_PRESETS = Object.freeze([
  Object.freeze({
    name: 'LIGHT',
    label: 'Light',
    hint: '1 kg chassis · 1.2 m/s · 3 kg payload',
    values: Object.freeze({ massKg: 1, normalSpeedMps: 1.2, payloadCapacityKg: 3 }),
  }),
  Object.freeze({
    name: 'STANDARD',
    label: 'Standard',
    hint: '2 kg chassis · 1.5 m/s · 5 kg payload',
    values: Object.freeze({ massKg: 2, normalSpeedMps: 1.5, payloadCapacityKg: 5 }),
  }),
  Object.freeze({
    name: 'HEAVY',
    label: 'Heavy',
    hint: '3 kg chassis · 1.0 m/s · 8 kg payload',
    values: Object.freeze({ massKg: 3, normalSpeedMps: 1.0, payloadCapacityKg: 8 }),
  }),
]);

/** The fields a preset fills. Everything else stays the operator's to enter. */
export const PRESET_DECLARED_KEYS = Object.freeze(['massKg', 'normalSpeedMps', 'payloadCapacityKg']);

/** Why each remaining commissioning field is not part of a preset. */
export const PRESET_UNDECLARED = Object.freeze({
  maxSpeedMps: 'Not implied by the nominal speed — enter this unit’s limit.',
  batteryCapacityWh: '6000 mAh needs a declared nominal pack voltage to become Wh.',
  batteryReservePct: 'The unit’s own hardware protection floor.',
  initialBatteryPct: 'Configured initial state, per unit.',
});

const ALL_FIELDS = [...SPECIFICATION_FIELDS, INITIAL_BATTERY_FIELD];

/** Nothing entered. The one meaning of "empty" shared by the submit gate and validation. */
function isBlank(raw) {
  return raw === undefined || raw === null || String(raw).trim() === '';
}

/**
 * The placeholder a specification input shows: the example, framed as one.
 *
 * A bare "500" in an empty number box is indistinguishable from a typed 500, and an
 * operator who reads it as entered cannot see why the form will not submit. "e.g. 500"
 * cannot be a value a number input holds.
 *
 * @param {{ placeholder: string }} field
 * @returns {string}
 */
export function examplePlaceholder(field) {
  return `e.g. ${field.placeholder}`;
}

/**
 * What still has to be entered before a commissioning form may submit.
 *
 * The submit gate and the explanation shown beside the disabled button are both this list,
 * so the page cannot say one thing is missing while waiting on another. The seven
 * specification fields are always required, as `validateSpecification({ required: true })`
 * requires them; the page names its own other required inputs (zone, identifier) in
 * `others`. Only form state is read — a placeholder is not a value.
 *
 * @param {object} spec raw specification form values
 * @param {Array<{ key: string, label: string, value: unknown }>} [others] the page's other required inputs, in form order
 * @returns {Array<{ key: string, label: string }>} the missing inputs, in form order; empty when complete
 */
export function missingRequiredInputs(spec, others = []) {
  return [...others, ...ALL_FIELDS.map((field) => ({ ...field, value: spec?.[field.key] }))]
    .filter((input) => isBlank(input.value))
    .map(({ key, label }) => ({ key, label }));
}

/**
 * Validate what the operator typed.
 *
 * @param {object} values raw form values (strings, as HTML number inputs produce)
 * @param {{ required?: boolean }} [options] `required` for commissioning; an edit is partial
 * @returns {{ ok: boolean, values: object, problems: string[] }}
 */
export function validateSpecification(values, options = {}) {
  const required = options.required === true;
  const out = {};
  const problems = [];

  for (const field of ALL_FIELDS) {
    const raw = values?.[field.key];
    if (isBlank(raw)) {
      if (required) problems.push(`${field.label} is required.`);
      continue;
    }

    const value = Number(raw);
    if (!Number.isFinite(value)) {
      problems.push(`${field.label} must be a number.`);
      continue;
    }
    if (value < field.min || value > field.max) {
      problems.push(`${field.label} must be between ${field.min} and ${field.max} ${field.unit}.`);
      continue;
    }
    out[field.key] = value;
  }

  if (
    typeof out.normalSpeedMps === 'number' &&
    typeof out.maxSpeedMps === 'number' &&
    out.normalSpeedMps > out.maxSpeedMps
  ) {
    problems.push('Normal speed cannot exceed max speed.');
  }

  return { ok: problems.length === 0, values: out, problems };
}

/**
 * Render one stored specification value, or a dash.
 *
 * A dash, never a zero and never a plausible default: a unit commissioned before the
 * specification existed has no mass, and showing "0 kg" would be a number nobody entered.
 *
 * @param {number|null|undefined} value
 * @param {string} unit
 * @returns {string}
 */
export function formatSpecValue(value, unit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, '');
  return `${rounded} ${unit}`;
}

/**
 * Is any part of this unit's specification recorded?
 *
 * @param {object|null} specification
 * @returns {boolean}
 */
export function hasSpecification(specification) {
  if (!specification) return false;
  return SPECIFICATION_FIELDS.some((field) => typeof specification[field.key] === 'number');
}

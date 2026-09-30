/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Commissioning forms — a disabled submit button says why.
 *
 *   node --test src/__architecture__/
 *   (or: npm run test:arch, from Frontend/)
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * Both commissioning forms (physical, and Create Simulated Robot) gate their submit button
 * on all seven specification fields being entered. The gate was right; the forms hid it.
 * Every empty field showed a bare example number as its placeholder — "500", "100" — which
 * reads as an entered value, and because the button was disabled, `handleSubmit` (the only
 * place that explained anything) could never run. An operator saw a filled form and a dead
 * button, with nothing to say which of the "values" were not there.
 *
 * ── What is claimed ─────────────────────────────────────────────────────────
 *   1 — a placeholder is not a value: fields showing only an example keep the form closed;
 *   2 — entering the values opens it, with validation unchanged;
 *   3 — the closed form names what is missing, without a click;
 *   4 — nothing turns a placeholder into form state;
 *   5 — the same holds on the physical commissioning form;
 *   6 — an enabled "Authorize Commissioning" still goes through the step-up;
 *   7 — one list decides and explains, derived from the one field declaration.
 *
 * As elsewhere in this directory: the rule lives in `lib/` and is exercised, and the page
 * wiring — which has no DOM here — is read from source with comments stripped.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INITIAL_BATTERY_FIELD,
  PRESET_UNDECLARED,
  SIMULATION_PRESETS,
  SPECIFICATION_FIELDS,
  examplePlaceholder,
  missingRequiredInputs,
  validateSpecification,
} from '../lib/robotSpecification.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** Source with comments removed, so prose about a hazard never counts as the hazard. */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
}

const SIMULATED_PAGE = 'pages/SimulatedRobotPage.jsx';
const COMMISSION_PAGE = 'pages/CommissionPage.jsx';
const PAGES = [SIMULATED_PAGE, COMMISSION_PAGE];

const ALL_FIELDS = [...SPECIFICATION_FIELDS, INITIAL_BATTERY_FIELD];
const EMPTY_SPEC = Object.freeze(Object.fromEntries(ALL_FIELDS.map((f) => [f.key, ''])));
const ZONE = 'Bengaluru, Bengaluru, 560098, India';

/** The page's own gate, as both pages now state it: nothing missing (and not mid-submit). */
const canSubmit = (missing, isSubmitting = false) => !isSubmitting && missing.length === 0;

/** The reported screen: STANDARD applied, max speed and reserve typed, the rest untouched. */
function reportedSimulatedSpec() {
  const standard = SIMULATION_PRESETS.find((p) => p.name === 'STANDARD');
  return {
    ...EMPTY_SPEC,
    ...Object.fromEntries(Object.entries(standard.values).map(([k, v]) => [k, String(v)])),
    maxSpeedMps: '2',
    batteryReservePct: '20',
  };
}

const simulatedMissing = (spec, zone = ZONE) =>
  missingRequiredInputs(spec, [{ key: 'zone', label: 'Operating zone', value: zone }]);

const commissionMissing = (spec, { id = 'RBT-1000', zone = ZONE } = {}) =>
  missingRequiredInputs(spec, [
    { key: 'id', label: 'Unit identifier', value: id },
    { key: 'zone', label: 'Initial assignment zone', value: zone },
  ]);

// ═══════════════════════════════════════════════════════════════════════════
// 1 — placeholders are not values
// ═══════════════════════════════════════════════════════════════════════════

test('1 — the reported screen is closed, and exactly battery capacity and initial battery are why', () => {
  const missing = simulatedMissing(reportedSimulatedSpec());

  assert.deepEqual(missing.map((m) => m.key), ['batteryCapacityWh', 'initialBatteryPct']);
  assert.equal(canSubmit(missing), false);
});

test('1 — those two are precisely the fields STANDARD does not declare and whose examples were 500 and 100', () => {
  const standard = SIMULATION_PRESETS.find((p) => p.name === 'STANDARD');
  for (const key of ['batteryCapacityWh', 'initialBatteryPct']) {
    assert.equal(key in standard.values, false, `${key} must stay undeclared by the preset`);
    assert.ok(PRESET_UNDECLARED[key], `${key} must carry its undeclared reason`);
  }
  const byKey = Object.fromEntries(ALL_FIELDS.map((f) => [f.key, f]));
  assert.equal(byKey.batteryCapacityWh.placeholder, '500');
  assert.equal(byKey.initialBatteryPct.placeholder, '100');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — complete values open the form
// ═══════════════════════════════════════════════════════════════════════════

test('2 — entering 500 and 100 opens the form, and validation accepts the result', () => {
  const spec = { ...reportedSimulatedSpec(), batteryCapacityWh: '500', initialBatteryPct: '100' };
  const missing = simulatedMissing(spec);

  assert.deepEqual(missing, []);
  assert.equal(canSubmit(missing), true);
  assert.equal(canSubmit(missing, true), false, 'a submission in flight still closes it');

  const validated = validateSpecification(spec, { required: true });
  assert.equal(validated.ok, true, validated.problems.join(' '));
  assert.equal(validated.values.batteryCapacityWh, 500);
  assert.equal(validated.values.initialBatteryPct, 100);
});

test('2 — a complete spec with no zone is still closed, and says so', () => {
  const spec = { ...reportedSimulatedSpec(), batteryCapacityWh: '500', initialBatteryPct: '100' };
  const missing = simulatedMissing(spec, '   ');
  assert.deepEqual(missing.map((m) => m.label), ['Operating zone']);
  assert.equal(canSubmit(missing), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 — the closed form explains itself, without a click
// ═══════════════════════════════════════════════════════════════════════════

test('3 — the missing list names each gap by its field label, in form order', () => {
  const missing = simulatedMissing(EMPTY_SPEC, '');
  assert.deepEqual(
    missing.map((m) => m.label),
    ['Operating zone', ...ALL_FIELDS.map((f) => f.label)],
  );
});

for (const page of PAGES) {
  test(`3 — ${page} gates the button on the list it renders beside it`, () => {
    const source = code(read(page));

    // The gate is the list.
    assert.match(source, /const missing = missingRequiredInputs\(spec,/);
    assert.match(source, /const canSubmit =[^;]*missing\.length === 0;/);
    assert.match(source, /disabled=\{!canSubmit\}/);

    // The explanation is the same list, rendered whenever it is non-empty — not inside
    // `handleSubmit`, which cannot run while the button is disabled.
    const note = source.match(/\{missing\.length > 0 \? \(\s*<p id="([\w-]+)"[\s\S]*?<\/p>/);
    assert.ok(note, 'the page must render the missing list while it is non-empty');
    assert.match(note[0], /missing\.map\(\(input\) => input\.label\)/);
    assert.match(note[0], /Complete the required fields/);
    assert.match(source, new RegExp(`aria-describedby=\\{missing\\.length > 0 \\? '${note[1]}'`));

    // Guidance, not an error: an untouched form must not render in the destructive style.
    assert.doesNotMatch(note[0], /destructive/);

    const handler = source.slice(source.indexOf('const handleSubmit'), source.indexOf('const showSelectedZone'));
    assert.doesNotMatch(handler, /missing\.map/, 'the explanation must not live only on the submit path');
  });
}

test('3 — the explanation detector is not vacuous', () => {
  const planted = code(read(SIMULATED_PAGE)).replace(/\{missing\.length > 0 \? \(\s*<p id=/, '{false ? (<p id=');
  assert.equal(/\{missing\.length > 0 \? \(\s*<p id="([\w-]+)"/.test(planted), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 — a placeholder never becomes form state
// ═══════════════════════════════════════════════════════════════════════════

test('4 — every field has an example, and an empty field is missing regardless of it', () => {
  for (const field of ALL_FIELDS) {
    assert.ok(String(field.placeholder).trim().length > 0, `${field.key} should show an example`);
  }
  assert.deepEqual(simulatedMissing(EMPTY_SPEC).map((m) => m.key), ALL_FIELDS.map((f) => f.key));
});

test('4 — the shown placeholder is framed as an example and is not a number a field could hold', () => {
  for (const field of ALL_FIELDS) {
    const shown = examplePlaceholder(field);
    assert.equal(shown, `e.g. ${field.placeholder}`);
    assert.equal(Number.isFinite(Number(shown)), false, `"${shown}" must not read as a value`);
  }
});

for (const page of PAGES) {
  test(`4 — ${page} starts every field empty and shows only framed examples`, () => {
    const source = code(read(page));

    assert.match(
      source,
      /Object\.fromEntries\(\[\.\.\.SPECIFICATION_FIELDS, INITIAL_BATTERY_FIELD\]\.map\(\(f\) => \[f\.key, ''\]\)\)/,
      'the specification state must start empty',
    );

    // A bare `field.placeholder` would be the unframed example again, and a placeholder read
    // anywhere else would be a placeholder turning into state.
    const reads = [...source.matchAll(/\.placeholder\b/g)].length;
    assert.equal(reads, 0, 'the page must reach placeholders only through examplePlaceholder()');
    const framed = [...source.matchAll(/placeholder=\{examplePlaceholder\((field|INITIAL_BATTERY_FIELD)\)\}/g)].length;
    assert.equal(framed, 2, 'both the six spec inputs and the initial battery input show framed examples');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 5 — physical commissioning
// ═══════════════════════════════════════════════════════════════════════════

test('5 — a commissioning form showing only examples is closed and names all seven', () => {
  const missing = commissionMissing(EMPTY_SPEC);
  assert.deepEqual(missing.map((m) => m.key), ALL_FIELDS.map((f) => f.key));
  assert.equal(canSubmit(missing), false);
});

test('5 — with the zone also empty, the zone is named first after the identifier', () => {
  const missing = commissionMissing(EMPTY_SPEC, { zone: '' });
  assert.equal(missing[0].label, 'Initial assignment zone');
  assert.equal(missing.length, 8);
});

test('5 — every value actually entered opens it; clearing the identifier closes it again', () => {
  const spec = {
    massKg: '45',
    maxSpeedMps: '2.5',
    normalSpeedMps: '1.4',
    batteryCapacityWh: '500',
    batteryReservePct: '15',
    payloadCapacityKg: '20',
    initialBatteryPct: '100',
  };
  assert.equal(canSubmit(commissionMissing(spec)), true);
  assert.equal(validateSpecification(spec, { required: true }).ok, true);

  const cleared = commissionMissing(spec, { id: ' ' });
  assert.deepEqual(cleared.map((m) => m.label), ['Unit identifier']);
  assert.equal(canSubmit(cleared), false);
});

test('5 — the commissioning page names its identifier and zone in the list', () => {
  const source = code(read(COMMISSION_PAGE));
  assert.match(source, /\{ key: 'id', label: 'Unit identifier', value: formData\.id \}/);
  assert.match(source, /\{ key: 'zone', label: 'Initial assignment zone', value: formData\.zone \}/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 — enabling the button authorises nothing
// ═══════════════════════════════════════════════════════════════════════════

test('6 — the commissioning page submits only through `commission`, never the API directly', () => {
  const source = code(read(COMMISSION_PAGE));
  const handler = source.slice(source.indexOf('const handleSubmit'), source.indexOf('const showSelectedZone'));

  assert.match(handler, /\bcommission\(\{/);
  assert.doesNotMatch(source, /robotsApi|commissionRobot|requestJson|\bfetch\s*\(/);
});

test('6 — `commission` asks for the step-up before any request is made', () => {
  const provider = code(read('context/AppProvider.jsx'));
  const start = provider.indexOf('const commission = useCallback(');
  const end = provider.indexOf('const createSimulatedRobot = useCallback(');
  assert.ok(start >= 0 && end > start, 'the commission action must exist where expected');
  const body = provider.slice(start, end);

  // The first thing it does is hand the whole action to requestAuth…
  assert.match(body, /^const commission = useCallback\(\s*\(robotData\) => \{\s*requestAuth\(`COMMISSION NEW UNIT:/);
  // …and both requests are inside that callback, after it.
  const auth = body.indexOf('requestAuth(');
  assert.ok(body.indexOf('locationsApi.createLocation(') > auth);
  assert.ok(body.indexOf('robotsApi.commissionRobot(') > auth);
});

test('6 — neither gate reads a role, a session or an authorisation state', () => {
  for (const page of PAGES) {
    const source = code(read(page));
    const gate = source.slice(source.indexOf('const missing = '), source.indexOf('const handleSubmit'));
    assert.ok(gate.includes('canSubmit'), `${page}: the gate region must contain canSubmit`);
    assert.doesNotMatch(gate, /role|auth|session|user|admin/i, `${page}: the gate is completeness only`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 — one list, from one declaration
// ═══════════════════════════════════════════════════════════════════════════

test('7 — "missing" and required-validation agree on every combination of blank fields', () => {
  const complete = {
    massKg: '2', maxSpeedMps: '2', normalSpeedMps: '1.5', batteryCapacityWh: '500',
    batteryReservePct: '20', payloadCapacityKg: '5', initialBatteryPct: '100',
  };
  const blanks = ['', '  ', null, undefined];

  for (let mask = 0; mask < 1 << ALL_FIELDS.length; mask += 1) {
    const spec = { ...complete };
    ALL_FIELDS.forEach((field, i) => {
      if (mask & (1 << i)) spec[field.key] = blanks[i % blanks.length];
    });

    const missing = missingRequiredInputs(spec).map((m) => `${m.label} is required.`);
    const required = validateSpecification(spec, { required: true }).problems.filter((p) => p.endsWith(' is required.'));
    assert.deepEqual(missing, required, `mask ${mask}`);
  }
});

for (const page of PAGES) {
  test(`7 — ${page} keeps no second copy of the required-field rule`, () => {
    const source = code(read(page));
    assert.doesNotMatch(source, /specComplete/);
    assert.doesNotMatch(source, /\.every\(/);
    assert.doesNotMatch(source, /\.trim\(\)\.length > 0 &&/, 'no hand-written completeness conjunction');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Preset note — explains an empty field, and only an empty one
// ═══════════════════════════════════════════════════════════════════════════

test('the preset note is kept, shown only while its field is still empty, and now covers initial battery', () => {
  const source = code(read(SIMULATED_PAGE));

  assert.match(source, /Not declared by the preset\. \{PRESET_UNDECLARED\[fieldKey\]\}/);
  const uses = [...source.matchAll(
    /<PresetUndeclaredNote\s+fieldKey=\{(field\.key|INITIAL_BATTERY_FIELD\.key)\}\s+show=\{Boolean\(appliedPreset\) && missingKeys\.has\(\1\)\}/g,
  )];
  assert.deepEqual(uses.map((m) => m[1]).sort(), ['INITIAL_BATTERY_FIELD.key', 'field.key']);
});

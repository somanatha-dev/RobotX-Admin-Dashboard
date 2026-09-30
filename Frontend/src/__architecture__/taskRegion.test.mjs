/**
 * The dashboard's task submission names its operating region.
 *
 *   node --test src/__architecture__/
 *   (or: npm run test:arch, from Frontend/)
 *
 * `POST /api/tasks/assign` refuses a body with no `regionId` (503, "no operating region
 * was named"), and it must not default one. Before this, `AppProvider.createTask` sent
 * no region at all, so every task created from the dashboard was refused even with the
 * assignment engine fully enabled. And the campus code is not the region: the registry's
 * `RNSIT` is `Campus.code`, the backend region is `Region.regionId` `rnsit`, and the
 * schema links neither to the other — so the mapping is explicit registry data.
 *
 * Behavioural where it can be (the request builder and the real request module, against a
 * stubbed `fetch`), structural only for the wiring from the form to the builder.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CAMPUS_REGISTRY, operatingRegionFor } from '../features/maps/campus/campusRegistry.js';
import { buildAssignTaskRequest } from '../lib/taskRequest.js';
import { assignTask } from '../lib/api/tasks.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const DRAFT = Object.freeze({
  campusId: 'RNSIT',
  pickup: 'rnsit-food-court',
  pickupLat: 12.900817,
  pickupLon: 77.518043,
  drop: 'rnsit-innovation-center',
  dropLat: 12.900729,
  dropLon: 77.517603,
  payload: { massKg: 1, massToleranceKg: 0.1 },
  requestedChassisType: 'ROVER',
});

test('the registry maps each campus code to its backend region explicitly, or to none', () => {
  assert.equal(operatingRegionFor('RNSIT'), 'rnsit');
  // No backend region exists for this campus; null is stated, not guessed.
  assert.equal(operatingRegionFor('jssate-bengaluru'), null);
  assert.equal(operatingRegionFor('NOPE'), null);
  assert.equal(operatingRegionFor(''), null);
  // The region is never the campus code re-cased: the two are different identifiers.
  for (const campus of CAMPUS_REGISTRY) {
    assert.ok('regionId' in campus, `${campus.id} states its operating region (or null)`);
  }
});

test('a task for RNSIT is submitted to region "rnsit", with every form field intact', () => {
  const body = buildAssignTaskRequest(DRAFT);
  assert.equal(body.regionId, 'rnsit');
  assert.equal(body.pickupLat, DRAFT.pickupLat);
  assert.equal(body.dropLon, DRAFT.dropLon);
  assert.deepEqual(body.payload, DRAFT.payload);
  assert.equal(body.requestedChassisType, 'ROVER');
  // The campus code itself is not sent as a region.
  assert.notEqual(body.regionId, DRAFT.campusId);
});

test('no campus, an unknown campus, or a campus with no region is refused — nothing is defaulted', () => {
  assert.throws(() => buildAssignTaskRequest({ ...DRAFT, campusId: '' }), /Select the campus/);
  assert.throws(() => buildAssignTaskRequest({ ...DRAFT, campusId: 'NOPE' }), /Unknown campus/);
  assert.throws(() => buildAssignTaskRequest({ ...DRAFT, campusId: 'jssate-bengaluru' }), /no operating region/);
});

test('the real request module sends regionId in the POST body', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, task: { taskId: 'TSK-1' } }), { status: 200 });
  };
  try {
    await assignTask(buildAssignTaskRequest(DRAFT));
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/tasks\/assign$/);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(JSON.parse(calls[0].init.body).regionId, 'rnsit');
});

test('the form sends its campus, and the provider submits through the builder', () => {
  const modal = read('components/modals/CreateTaskModal.jsx');
  assert.match(modal, /onCreate\(\{\s*campusId,/, 'CreateTaskModal puts the chosen campus in the draft');

  const provider = read('context/AppProvider.jsx');
  assert.match(
    provider,
    /tasksApi\.assignTask\(buildAssignTaskRequest\(taskDraft\)\)/,
    'createTask submits exactly what buildAssignTaskRequest builds',
  );
});

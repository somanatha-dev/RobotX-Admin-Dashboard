/**
 * FE-09 (refusal messages), the queued-card refresh, and the map's default viewport
 * (frontend cleanup pass, 2026-09-30).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const mod = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);

// ── FE-09: the backend's own refusal sentence reaches the operator ──────────

async function refusalOf(status, body) {
  const { requestJson } = await mod('lib/api/httpClient.js');
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(body === undefined ? '' : JSON.stringify(body), { status });
  try {
    await requestJson('/api/x', { method: 'POST', body: {}, errorMessage: 'Login failed' });
  } catch (e) {
    return e;
  } finally {
    globalThis.fetch = original;
  }
  return null;
}

test('FE-09 every backend refusal shape yields the backend sentence, not the generic fallback', async () => {
  // HTTP rate limiter (rateLimitHttp.js) — the shape that used to read "Login failed".
  const limited = await refusalOf(429, { ok: false, error: 'Rate limit exceeded' });
  assert.equal(limited.status, 429);
  assert.equal(limited.message, 'Rate limit exceeded');

  // Task intake refusal (tasks.controller.assignTask): `error` + `intake.sentence`, no `message`.
  const sentence = 'legId is required — the Leg is the decision index (§1.4)';
  const intake = await refusalOf(400, { ok: false, task: {}, intake: { outcome: 'INVALID', reason: 'VALIDATION_FAILED', sentence, problems: [sentence] }, error: sentence });
  assert.equal(intake.message, sentence);
  const shed = await refusalOf(429, { ok: false, intake: { outcome: 'DECLINED', reason: 'SHED', sentence: 'The shard is shedding load; resubmit later.' } });
  assert.equal(shed.message, 'The shard is shedding load; resubmit later.');

  // Authorisation gate: `detail` explains, `error` is only the heading.
  const forbidden = await refusalOf(403, { ok: false, error: 'Forbidden', refusal: 'ROLE', detail: 'This action needs SUPER_ADMIN.' });
  assert.equal(forbidden.message, 'This action needs SUPER_ADMIN.');

  // Error middleware: `{ message }` (a 500 is already masked server-side).
  assert.equal((await refusalOf(400, { message: 'Invalid payload: massKg must be positive' })).message, 'Invalid payload: massKg must be positive');
  assert.equal((await refusalOf(500, { message: 'Internal Server Error' })).message, 'Internal Server Error');
});

test('FE-09 the generic fallback is kept only when the backend gave no usable sentence', async () => {
  assert.equal((await refusalOf(502)).message, 'Login failed', 'empty body');
  assert.equal((await refusalOf(400, {})).message, 'Login failed');
  assert.equal((await refusalOf(400, { error: '   ', detail: ['a', 'b'] })).message, 'Login failed', 'blank or non-string fields are not used');
  // Nothing stack-like is ever read, even if a body carried one.
  assert.equal((await refusalOf(500, { stack: 'Error: boom\n    at x (/src/y.js:1:1)' })).message, 'Login failed');
  const { refusalMessage } = await mod('lib/api/httpClient.js');
  assert.equal(refusalMessage(null), null);
  assert.equal(refusalMessage({ message: 'a', detail: 'b', error: 'c' }), 'a', 'message wins');
});

// ── Queued card: an existing event re-reads the explanation, polling unchanged ──

test('queued: only OFFER_REJECT / OFFER_DEFER re-open assignment', async () => {
  const { reopensAssignment } = await mod('features/tasks/taskLifecycle.js');
  assert.equal(reopensAssignment({ response: 'OFFER_REJECT' }), true);
  assert.equal(reopensAssignment({ response: 'OFFER_DEFER' }), true);
  assert.equal(reopensAssignment({ response: 'OFFER_ACCEPT' }), false, 'ACCEPT is followed by TASK_UPDATED, which already moves the card');
  assert.equal(reopensAssignment({}), false);
  assert.equal(reopensAssignment(null), false);
});

test('queued: the signal is wired from the socket event to the card poll; the 10 s interval is unchanged', async () => {
  const provider = code(read('context/AppProvider.jsx'));
  assert.match(provider, /if \(reopensAssignment\(data\)\) setAssignmentSignal\(\(n\) => n \+ 1\);/);
  const rejection = code(read('features/tasks/taskRejection.js'));
  assert.match(rejection, /const refreshKey = options\.refreshKey \?\? 0;/);
  assert.match(rejection, /\}, \[taskId, load, refreshMs, enabled, refreshKey\]\);/);
  const page = code(read('pages/TasksPage.jsx'));
  assert.match(page, /useTaskRejection\(task\.taskId \|\| task\.id, \{ enabled: isPending, refreshKey: assignmentSignal \}\)/);
  const { REFRESH_MS } = await mod('features/tasks/taskRejection.js');
  assert.equal(REFRESH_MS, 10_000, 'no faster polling');
});

// ── Map: default viewport from the operating campuses' boundaries ───────────

test('map: the default view is the operating campuses\' boundary extent — no invented coordinates', async () => {
  const { operatingCampusBounds } = await mod('features/maps/campus/operatingCampusView.js');
  const { CAMPUS_REGISTRY, resolveCampusDefinition } = await mod('features/maps/campus/campusRegistry.js');

  const rnsit = CAMPUS_REGISTRY.find((c) => c.id === 'RNSIT');
  const ring = resolveCampusDefinition({ code: 'RNSIT', name: rnsit.name }).features.find((f) => f.kind === 'BOUNDARY').geometry.coordinates[0];
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  assert.deepEqual(operatingCampusBounds(), [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    'exactly RNSIT\'s boundary box (JSSATE has no operating region)');

  assert.equal(operatingCampusBounds(CAMPUS_REGISTRY.filter((c) => !c.regionId)), null, 'no operating campus → caller keeps world view');
  assert.equal(operatingCampusBounds([]), null);
});

test('map: only the no-filter branch changed; restored camera and filter focus are untouched', () => {
  const map = code(read('features/maps/MapControl.jsx'));
  assert.match(map, /const bounds = operatingCampusBounds\(\);/);
  assert.match(map, /mapRef\.current\?\.cameraForBounds\(bounds, \{ padding: 48 \}\)/);
  assert.match(map, /if \(!cam\) \{\s*const preset = CAMERA_PRESETS\.WORLD;/, 'world view stays the fallback');
  assert.match(map, /center: startCam \? \[startCam\.lon, startCam\.lat\] : WORLD_CENTER,/, 'a returning visit still restores the last camera');
  assert.match(map, /return \{ type: 'CAMPUS', loc: \{ lat: selectedCampus\.centerLat, lon: selectedCampus\.centerLon \} \};/, 'a selected campus still focuses as before');
});

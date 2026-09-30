/**
 * FE-05, FE-06, FE-07, FE-08, FE-10 (frontend ↔ backend integration audit, 2026-09-30).
 *
 * FE-05  the task card says where a task is from facts the dashboard receives — "Executing"
 *        for an accepted task, never an execution step it is not told (AT_PICKUP, …), and
 *        never "Verified"/"Settled", which no response exposes.
 * FE-06  "Computing…" only while assignment is genuinely being worked on; a task the engine
 *        found no feasible robot for says so.
 * FE-07  distance is the length of the route the engine offered; no ETA is derived, and an
 *        executing task is never shown as "Idle…".
 * FE-08  pickup/drop come from the selected campus's own locations inside its boundary; a
 *        point off the campus is refused before anything is sent; regionId stays `rnsit`.
 * FE-10  the map shows every robot with reported coordinates — no filter gate that hides them.
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

// ── FE-05 / FE-06: the phase a card shows ───────────────────────────────────

test('FE-06 a PENDING task is "Computing" only while assignment is genuinely pending', async () => {
  const { taskPhase, PHASE } = await mod('features/tasks/taskLifecycle.js');
  const queued = taskPhase({ status: 'PENDING', rejection: { status: 'none' } });
  assert.equal(queued.key, PHASE.QUEUED);
  assert.equal(queued.busy, true);

  const offered = taskPhase({ status: 'PENDING', rejection: { status: 'ready', explanation: { outcome: 'ASSIGNED' } } });
  assert.equal(offered.key, PHASE.OFFERED);
  assert.equal(offered.busy, true);

  const none = taskPhase({ status: 'PENDING', rejection: { status: 'ready', explanation: { outcome: 'NO_FEASIBLE_CANDIDATE' } } });
  assert.equal(none.key, PHASE.NO_FEASIBLE_ROBOT);
  assert.equal(none.label, 'No feasible robot');
  assert.equal(none.busy, false, 'no spinner once the engine has found no feasible robot');

  const unread = taskPhase({ status: 'PENDING', rejection: { status: 'unavailable' } });
  assert.equal(unread.busy, false, 'an unreadable status is not presented as work in progress');
});

test('FE-05 an accepted task is "Executing" — never an execution step the dashboard is not told', async () => {
  const { taskPhase, PHASE } = await mod('features/tasks/taskLifecycle.js');
  for (const status of ['ASSIGNED', 'IN_PROGRESS']) {
    const p = taskPhase({ status });
    assert.equal(p.key, PHASE.EXECUTING, status);
    assert.equal(p.label, 'Executing');
    assert.equal(p.busy, false);
    assert.doesNotMatch(`${p.label} ${p.detail}`, /AT_PICKUP|AT PICKUP|EN_ROUTE|LOADED|AT_DROP/i);
  }
});

test('FE-05 completed is "Completed" — not "Verified" or "Settled", which no response exposes', async () => {
  const { taskPhase, PHASE } = await mod('features/tasks/taskLifecycle.js');
  const done = taskPhase({ status: 'COMPLETED' });
  assert.equal(done.key, PHASE.COMPLETED);
  assert.equal(done.label, 'Completed');
  assert.doesNotMatch(done.label, /verified|settled/i);
  assert.match(done.detail, /not reported/);

  const held = taskPhase({ status: 'VERIFYING', verification: { failures: ['ARRIVAL_DISTANCE'] } });
  assert.equal(held.key, PHASE.VERIFYING);
  assert.match(held.detail, /ARRIVAL_DISTANCE/);
  assert.equal(taskPhase({ status: 'VERIFYING', verification: { unavailable: true, reason: 'NO_TRACK' } }).detail.includes('NO_TRACK'), true);

  const unknown = taskPhase({ status: 'SUSPENDED' });
  assert.equal(unknown.tone, 'neutral', 'an unknown status is not styled as a failure');
});

test('FE-05/06 the card: spinner only when busy, panel shares the card poll, no raw status badge', () => {
  const page = code(read('pages/TasksPage.jsx'));
  assert.match(page, /const phase = taskPhase\(\{ status, rejection, verification: task\.verification \}\);/);
  assert.match(page, /\{phase\.busy \? <Loader2/);
  assert.match(page, /\) : phase\.busy \? \(\s*<div[^>]*>\s*<Loader2[^>]*\/>\s*Computing…/);
  assert.doesNotMatch(page, /isPending \? \(\s*<div[^>]*>\s*<Loader2/, 'Computing must not be tied to PENDING alone');
  assert.doesNotMatch(page, /statusStyle\(/);
});

// ── FE-07: distance / ETA ───────────────────────────────────────────────────

test('FE-07 route length is measured from the offered route geometry', async () => {
  const { pathLengthMeters, plannedRouteMeters } = await mod('features/tasks/taskRoute.js');
  // RNSIT Pre-University College → Canara Bank, as the engine offered it on 2026-09-30.
  const toDrop = [{ lat: 12.900411, lon: 77.518715 }, { lat: 12.902348, lon: 77.518589 }];
  const m = pathLengthMeters(toDrop);
  assert.ok(Math.abs(m - 215.8) < 0.5, `expected ≈215.8 m, got ${m}`);
  assert.equal(pathLengthMeters([{ lat: 12.9, lon: 77.5 }]), 0, 'a robot already at the point');
  assert.equal(pathLengthMeters([]), null);
  assert.equal(pathLengthMeters([{ lat: 'x', lon: 77.5 }, { lat: 12.9, lon: 77.5 }]), null);
  assert.ok(Math.abs(plannedRouteMeters({ pathToPickup: [toDrop[0], toDrop[0]], pathToDrop: toDrop }) - m) < 1e-9);
  assert.equal(plannedRouteMeters({ pathToDrop: toDrop }), null, 'half a route is not a route');
  assert.equal(plannedRouteMeters(null), null);
});

test('FE-07 the card never shows "Idle…" and derives no ETA', () => {
  const page = code(read('pages/TasksPage.jsx'));
  assert.doesNotMatch(page, /Idle…/);
  assert.doesNotMatch(page, /distanceTravelled/, 'no ETA from a field the backend never sends');
  assert.doesNotMatch(page, /computeEta/);
  assert.match(page, /plannedRouteMeters\(route\)/);
  assert.match(page, /\{isExecuting \? 'Not provided' : '—'\}/);
  assert.doesNotMatch(page, /taskPathCacheRef/, 'render reads state, not a ref');

  const provider = code(read('context/AppProvider.jsx'));
  assert.match(provider, /setTaskRoutes\(\(prev\) => \(\{ \.\.\.prev, \[taskId\]: \{ pathToPickup, pathToDrop \} \}\)\);/);
});

// ── FE-08: campus-scoped locations ──────────────────────────────────────────

test('FE-08 RNSIT offers only its own locations inside the adopted boundary', async () => {
  const { campusTaskLocations, isWithinCampus } = await mod('features/tasks/campusLocations.js');
  const { locations, hasBoundary } = campusTaskLocations('RNSIT');
  assert.equal(hasBoundary, true);
  assert.ok(locations.length > 0);
  for (const loc of locations) assert.equal(isWithinCampus('RNSIT', loc.lat, loc.lon), true, loc.id);
  const ids = locations.map((l) => l.id);
  assert.ok(ids.includes('rnsit-pre-university-college'));
  // Outside the adopted boundary (RD-2026-08-30-01): never offered.
  for (const outside of ['rnsit-main-gate', 'rnsit-parking-lot', 'rnsit-playground-1']) assert.ok(!ids.includes(outside), outside);
  // A citywide point (St Joseph's, central Bengaluru) is not on the campus.
  assert.equal(isWithinCampus('RNSIT', 12.9716, 77.5946), false);
  assert.equal(isWithinCampus('RNSIT', NaN, 77.5), false);
  assert.equal(isWithinCampus('NO-SUCH-CAMPUS', 12.900411, 77.518715), false, 'unknown campus vouches for nothing');
});

test('FE-08 the request builder refuses an off-campus point; regionId stays "rnsit"', async () => {
  const { buildAssignTaskRequest } = await mod('lib/taskRequest.js');
  const draft = {
    campusId: 'RNSIT', pickup: 'RNSIT Pre-University College', pickupLat: 12.900411, pickupLon: 77.518715,
    drop: 'RNSIT Food Court', dropLat: 12.900817, dropLon: 77.518043,
    payload: { massKg: 1, massToleranceKg: 0.1 }, requestedChassisType: 'ROVER',
  };
  const body = buildAssignTaskRequest(draft);
  assert.equal(body.regionId, 'rnsit');
  assert.notEqual(body.regionId, 'RNSIT');
  assert.equal('campusId' in body, false);
  assert.throws(() => buildAssignTaskRequest({ ...draft, pickupLat: 12.9716, pickupLon: 77.5946 }), /pickup is not inside/);
  assert.throws(() => buildAssignTaskRequest({ ...draft, dropLat: 12.9716, dropLon: 77.5946 }), /drop is not inside/);
});

test('FE-08 the task form uses campus locations, not a citywide search', () => {
  const modal = code(read('components/modals/CreateTaskModal.jsx'));
  assert.doesNotMatch(modal, /LocationCombobox/);
  assert.match(modal, /campusTaskLocations\(campusId\)/);
  assert.match(modal, /disabled=\{!campusId \|\| campusLocations\.length === 0\}/, 'no location before a campus');
  assert.match(modal, /setPickup\(EMPTY_LOC\);\s*setDrop\(EMPTY_LOC\);/, 'changing campus clears both ends');
  assert.match(modal, /pickup\.lat === drop\.lat && pickup\.lon === drop\.lon/);
});

// ── FE-10: robots on the map ────────────────────────────────────────────────

test('FE-10 the map shows every robot with reported coordinates — no filter gate', () => {
  const stream = code(read('features/maps/mapControl/hooks/useRobotStream.js'));
  assert.doesNotMatch(stream, /hasAnyFilter/);
  assert.match(stream, /\.filter\(\s*\(r\) => Number\.isFinite\(r\?\.lat\) && Number\.isFinite\(r\?\.lon\)\s*\)/);
  const effect = stream.match(/const list = \(Array\.isArray\(globalRobots\)[\s\S]*?syncMarkersToRobots\(list\);/);
  assert.ok(effect, 'the robots → markers sync is intact');
});

test('FE-10 a moving robot\'s marker follows live telemetry, not the load-time snapshot', () => {
  // Measured before the fix: a robot that drove and stopped had its marker settle 49.6 m
  // from the robot — 2.8 m from where it started — because the sync re-sent the REST
  // snapshot (`live`, never refreshed) on every tick, and the renderer let a repeat of an
  // old position win over a tween already heading somewhere else.
  const stream = code(read('features/maps/mapControl/hooks/useRobotStream.js'));
  assert.match(stream, /upsertMarker\(r\?\.live && typeof r\.live === 'object' \? \{ \.\.\.r\.live, \.\.\.r \} : r\);/);
  assert.doesNotMatch(stream, /\{ \.\.\.r, \.\.\.r\.live \}/, 'the stale snapshot must not override the live row');

  const renderer = code(read('features/maps/operational/renderers/robotMarker2dRenderer.js'));
  assert.match(renderer, /const target = handle\.targetLngLat \|\| handle\.currentLngLat;\s*if \(target\[0\] === to\[0\] && target\[1\] === to\[1\]\) return;\s*cancelTween\(handle\);/);
  assert.match(renderer, /const shown = handle\.marker\?\.getLngLat\?\.\(\);/);
  assert.match(renderer, /handle\.targetLngLat = to;/);
});

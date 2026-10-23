/**
 * RBAC dashboard UX — one login, one dashboard, scoped by the account's campus.
 *
 * Pure functions are tested by calling them. The React wiring (which this suite has no DOM
 * renderer for) is checked structurally against the source, the way the other architecture
 * suites here check provider and page wiring: these assert what the code does on every path,
 * not that a rendered page looked right.
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

const CAMPUS = (code, name, regionId = null) => ({ id: `id-${code}`, code, name, regionId });
const SUPER = { isAuthenticated: true, user: { id: 'u1', role: 'SUPER_ADMIN', campus: null } };
const RNSIT_ADMIN = { isAuthenticated: true, user: { id: 'u2', role: 'ADMIN', campus: CAMPUS('RNSIT', 'RNS Institute of Technology', 'rnsit') } };
const JSS_ADMIN = { isAuthenticated: true, user: { id: 'u3', role: 'ADMIN', campus: CAMPUS('jssate-bengaluru', 'JSS Academy of Technical Education') } };

// ── Same login, same dashboard ──────────────────────────────────────────────

test('one login route and one dashboard tree for both roles; sign-in always lands on /', () => {
  const router = code(read('router/AppRouter.jsx'));
  assert.equal((router.match(/<Route path="\/login"/g) || []).length, 1);
  assert.match(router, /<Route\s+path="\/"\s+element=\{\s*<RequireAuth>\s*<Layout \/>/);
  const provider = code(read('context/AppProvider.jsx'));
  assert.match(provider, /if \(shouldNavigate\) navigate\('\/'\);/);
  assert.doesNotMatch(provider, /navigate\(['"`]\/admin/, 'no separate administrator dashboard');
});

// ── Labels from the authenticated session ───────────────────────────────────

test('the profile shows the account\'s real role and campus — no hard-coded Super Admin or demo region', () => {
  const profile = code(read('pages/ProfilePage.jsx'));
  assert.doesNotMatch(profile, /Super Admin<|>\s*Super Admin\s*</);
  assert.doesNotMatch(profile, /Local Demo|localhost environment/);
  assert.match(profile, /const campus = campusOf\(session\);/);
  assert.match(profile, /superAdmin \? 'All campuses' : campus \? campus\.name : 'No campus assigned'/);
});

test('access helpers: labels, commands, and access-change detection', async () => {
  const { accountLabel, accessChanged, mayReadSimulator } = await mod('lib/access.js');
  assert.equal(accountLabel(SUPER), 'Super Admin');
  assert.equal(accountLabel(RNSIT_ADMIN), 'Admin · RNS Institute of Technology');
  assert.equal(mayReadSimulator(SUPER), true);
  assert.equal(mayReadSimulator(RNSIT_ADMIN), false);
  assert.equal(accessChanged(RNSIT_ADMIN.user, { ...RNSIT_ADMIN.user }), false);
  assert.equal(accessChanged(RNSIT_ADMIN.user, JSS_ADMIN.user), true, 'campus moved');
  assert.equal(accessChanged(RNSIT_ADMIN.user, { ...RNSIT_ADMIN.user, role: 'SUPER_ADMIN', campus: null }), true, 'role changed');
});

// ── Simulator: SUPER_ADMIN only ─────────────────────────────────────────────

test('an ADMIN page never polls or refreshes the SUPER_ADMIN-only simulator report', () => {
  const provider = code(read('context/AppProvider.jsx'));
  assert.match(provider, /const pollsSimulator = session\.isAuthenticated && mayReadSimulator\(session\);/);
  assert.match(provider, /if \(!pollsSimulator\) return undefined;/);
  assert.match(provider, /\}, \[pollsSimulator\]\);/);
  assert.match(provider, /mayReadSimulatorRef\.current \? simulatorApi\.getSimulatorStatus\(\) : Promise\.resolve\(null\)/);
  // Set before the first refresh of a sign-in and of a restored session, and cleared at sign-out.
  const signIn = provider.slice(provider.indexOf('const applyLoggedInSession'), provider.indexOf('const login = useCallback'));
  assert.ok(signIn.indexOf('mayReadSimulatorRef.current = mayReadSimulator') < signIn.indexOf('refreshDbState()'));
  assert.match(provider, /mayReadSimulatorRef\.current = false;\s*setSession\(\{ isAuthenticated: false/);
  assert.equal((provider.match(/simulatorApi\.getSimulatorStatus\(\)/g) || []).length, 2, 'the poll and the gated refresh — no third reader');
});

test('restricted, not "unknown": runtime badge, detail row and map legend say why details are absent', () => {
  assert.match(code(read('components/system/RobotIdentity.jsx')), /if \(restricted\) \{[\s\S]*RUNTIME RESTRICTED/);
  assert.match(code(read('pages/RobotsPage.jsx')), /restricted=\{!mayReadSimulator\(session\)\}/);
  assert.match(code(read('pages/RobotDetailPage.jsx')), /mayReadSimulator\(session\) \? runtimeLabel\(runtimeStatusOf\(robot, simulatorStatus\)\) : 'Restricted'/);
  assert.match(code(read('features/maps/MapControl.jsx')), /chargingRestricted=\{!mayReadSimulator\(session\)\}/);
  assert.match(code(read('features/maps/mapControl/ui/MapLegend.jsx')), /visible to super administrators only/);
});

// ── Map: no SUPER_ADMIN-only filters, opens on the ADMIN's campus ───────────

test('an ADMIN map loads no location hierarchy and is pinned to its campus', () => {
  const hook = code(read('features/maps/mapControl/hooks/useLocationFilters.js'));
  assert.match(hook, /export function useLocationFilters\(\{ hierarchy = true, pinnedCampusId = null, defaultCampusCode = null \} = \{\}\)/);
  const countries = hook.slice(hook.indexOf('fetchLocations({ type: \'COUNTRY\' })') - 200, hook.indexOf('fetchLocations({ type: \'COUNTRY\' })'));
  assert.match(countries, /if \(!hierarchy\) return undefined;/, 'the country list (and so the whole cascade) is never requested');
  assert.match(hook, /const campusId = pinnedCampusId \|\| selectedCampusIdState;/);
  assert.match(hook, /if \(pinnedCampusId\) return;/, 'a pinned selection cannot be changed');
  const map = code(read('features/maps/MapControl.jsx'));
  // The operational map loads no hierarchy for anyone now (2026-10-23); an ADMIN is still pinned,
  // and only an unpinned map falls back to the operating campus.
  assert.match(map, /\(\{ hierarchy: false, pinnedCampusId, defaultCampusCode: pinnedCampusId \? null : operatingCampusCode\(\) \}\)/);
  assert.match(map, /campusLocked=\{!superAdmin\}/);
  assert.match(map, /const bounds = pinnedCampusCode \? campusBounds\(pinnedCampusCode\) : operatingCampusBounds\(\);/);
});

test('campusBounds frames one campus — even one with no operating region — and never another', async () => {
  const { campusBounds, operatingCampusBounds } = await mod('features/maps/campus/operatingCampusView.js');
  const { CAMPUS_REGISTRY, resolveCampusDefinition } = await mod('features/maps/campus/campusRegistry.js');
  const boxOf = (code) => {
    const entry = CAMPUS_REGISTRY.find((c) => c.id === code);
    const ring = resolveCampusDefinition({ code, name: entry.name }).features.find((f) => f.kind === 'BOUNDARY').geometry.coordinates.flat(1);
    const lons = ring.map((pt) => pt[0]);
    const lats = ring.map((pt) => pt[1]);
    return [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
  };
  assert.deepEqual(campusBounds('RNSIT'), boxOf('RNSIT'));
  const jss = campusBounds('jssate-bengaluru');
  assert.ok(jss, 'JSSATE has no operating region, but its administrator still opens on JSSATE');
  assert.notDeepEqual(jss, operatingCampusBounds(), 'not RNSIT');
  assert.equal(campusBounds('NO-SUCH-CAMPUS'), null);
  assert.deepEqual(operatingCampusBounds(), boxOf('RNSIT'), 'the SUPER_ADMIN default is unchanged');
});

// ── Task creation: the ADMIN's campus only ──────────────────────────────────

test('the task form offers an ADMIN its own campus only; a SUPER_ADMIN every campus', async () => {
  const { taskCampusesFor } = await mod('lib/access.js');
  const { CAMPUS_REGISTRY } = await mod('features/maps/campus/campusRegistry.js');
  assert.deepEqual(taskCampusesFor(SUPER, CAMPUS_REGISTRY).map((c) => c.id), CAMPUS_REGISTRY.map((c) => c.id));
  assert.deepEqual(taskCampusesFor(RNSIT_ADMIN, CAMPUS_REGISTRY).map((c) => c.id), ['RNSIT']);
  assert.deepEqual(taskCampusesFor(JSS_ADMIN, CAMPUS_REGISTRY).map((c) => c.id), ['jssate-bengaluru']);
  assert.deepEqual(taskCampusesFor({ isAuthenticated: true, user: { role: 'ADMIN', campus: null } }, CAMPUS_REGISTRY), []);
  const modal = code(read('components/modals/CreateTaskModal.jsx'));
  assert.match(modal, /const offeredCampuses = taskCampusesFor\(session, CAMPUS_REGISTRY\);/);
  assert.match(modal, /\{offeredCampuses\.map\(\(campus\) => \(/);
  assert.doesNotMatch(modal, /\{CAMPUS_REGISTRY\.map\(/, 'the full registry is no longer listed directly');
});

// ── Step-up PIN ─────────────────────────────────────────────────────────────

test('an account without a PIN is told where to set one; the profile sets it with the current password', () => {
  const modal = code(read('components/modals/AuthChallengeModal.jsx'));
  assert.match(modal, /pinStatus\(\)/);
  assert.match(modal, /pinConfigured === false \?/);
  assert.match(modal, /PIN not configured/i);
  const profile = code(read('pages/ProfilePage.jsx'));
  assert.match(profile, /await setPin\(\{ currentPassword, pin \}\)/);
  assert.match(profile, /<PinSection \/>/);
  const api = code(read('lib/api/auth.js'));
  assert.match(api, /requestJson\('\/api\/auth\/pin', \{\s*method: 'PUT'/);
});

// ── Account changes ─────────────────────────────────────────────────────────

test('a revoked account is signed out with the reason; the HTTP client carries the server\'s code', async () => {
  const { requestJson } = await mod('lib/api/httpClient.js');
  const { sessionCheckOutcome, SESSION_CHECK } = await mod('lib/sessionCheck.js');
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Your access has been revoked', code: 'ACCOUNT_DISABLED' }), { status: 401 });
  let error = null;
  try {
    await requestJson('/api/auth/me');
  } catch (e) {
    error = e;
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(error?.status, 401);
  assert.equal(error?.code, 'ACCOUNT_DISABLED');
  assert.equal(sessionCheckOutcome(error), SESSION_CHECK.NO_SESSION);

  const provider = code(read('context/AppProvider.jsx'));
  assert.match(provider, /setSignedOutReason\(reason === 'ACCOUNT_DISABLED' \? 'ACCOUNT_DISABLED' : null\);/);
  assert.match(provider, /sessionExpiredRef\.current\?\.\(err\?\.code \|\| payload\?\.code \|\| null\);/);
  assert.match(code(read('pages/LoginPage.jsx')), /signedOutReason === 'ACCOUNT_DISABLED'[\s\S]*Your access has been revoked/);
});

test('a campus change drops every old-campus record before reconnecting into the new campus', () => {
  const provider = code(read('context/AppProvider.jsx'));
  const handler = provider.slice(provider.indexOf('const onUnauthorized = async'), provider.indexOf('const onDisconnect = (reason)'));
  const changed = handler.indexOf('if (current && accessChanged(sessionRef.current.user, current))');
  assert.ok(changed > 0, 'the handler compares the account before and after');
  const reconnect = handler.indexOf('connectDashboardSocket()');
  for (const clear of ['setRobots([])', 'setTasks([])', 'taskPathCacheRef.current.clear()', 'setTaskRoutes({})', 'setSimulatorStatus(null)', 'setSession((prev) => ({ ...prev, user: current }))']) {
    const at = handler.indexOf(clear);
    assert.ok(at > changed && at < reconnect, `${clear} happens before the reconnect`);
  }
});

test('an unavailable robot is described without saying which reason applies', () => {
  const detail = code(read('pages/RobotDetailPage.jsx'));
  assert.doesNotMatch(detail, /Robot Decommissioned or Not Found/);
  assert.match(detail, /It may not exist, may have been retired, or may be outside your campus\./);
});

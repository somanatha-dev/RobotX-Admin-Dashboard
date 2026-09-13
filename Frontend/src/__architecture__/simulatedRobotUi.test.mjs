/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STEP 3 — the simulated-robot UI surface.
 *
 *   node --test src/__architecture__/
 *   (or: npm run test:arch, from Frontend/)
 *
 * Five claims, lettered as the step states them:
 *
 *   C — the simulated creation UI calls `POST /api/simulator/robot`, never `POST /api/robots`;
 *   D — there is no count-based, fleet or bulk simulator creation anywhere in the UI;
 *   E — the physical commissioning flow exposes no simulator toggle;
 *   F — the operator may create several, and the UI states no rule of its own;
 *   G — simulated identity and simulator runtime are distinct, and neither is liveness.
 *
 * ── What F used to assert ───────────────────────────────────────────────────
 * That the backend's one-simulated-robot-per-operator 409 reached the operator as a
 * refusal, with the server's sentence intact. The product rule behind it was wrong — one
 * SUPER_ADMIN may have many simulated robots — so the 409 is gone, the page's conflict
 * panel is gone, and F now asserts the corrected behaviour plus the property that
 * survived it: the UI states no limit of its own and implements no authorisation rule.
 *
 * ── Behavioural where it can be, structural where it must be ────────────────
 * C, F and G are about logic, so the logic is exercised: the request module is driven
 * against a stubbed `fetch` and the runtime rules are called directly. D and E are about
 * *absences* — a count field that must not exist, a checkbox that must not exist — and an
 * absence has no behavioural witness, so those read the source. The detectors for both
 * are verified non-vacuous below: a check that matches nothing passes for the wrong
 * reason forever.
 *
 * It runs under plain Node with no bundler and no DOM, which is why the rules under test
 * live in `lib/` rather than inside a component: a rule that can only be reached by
 * rendering a page is a rule that does not get tested.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as simulatorApi from '../lib/api/simulator.js';
import { createSimulatedRobot, getSimulatorStatus } from '../lib/api/simulator.js';
import {
  IDENTITY,
  RUNTIME,
  identityOf,
  isSimulated,
  runtimeStatusOf,
  runtimeReason,
} from '../lib/simulationIdentity.js';

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
const SIMULATOR_API = 'lib/api/simulator.js';

/** Install a `fetch` double for one call, returning `{ calls }` and a restore function. */
function stubFetch(response) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return {
      ok: response.ok !== false,
      status: response.status ?? 200,
      text: async () => JSON.stringify(response.body ?? {}),
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST C — the creation UI calls the dedicated endpoint
// ═══════════════════════════════════════════════════════════════════════════

test('C — createSimulatedRobot posts to /api/simulator/robot', async () => {
  const stub = stubFetch({ status: 201, body: { ok: true, robot: { robotId: 'SIM-ABC' } } });
  try {
    await createSimulatedRobot({ locationId: 'loc-1', chassisType: 'Rover (Ground)', specification: {} });
  } finally {
    stub.restore();
  }

  assert.equal(stub.calls.length, 1);
  assert.match(stub.calls[0].url, /\/api\/simulator\/robot$/);
  assert.equal(stub.calls[0].init.method, 'POST');
});

test('C — it never posts to the physical commissioning endpoint', async () => {
  const stub = stubFetch({ status: 201, body: { ok: true, robot: { robotId: 'SIM-ABC' } } });
  try {
    await createSimulatedRobot({ locationId: 'loc-1', chassisType: 'Rover (Ground)', specification: {} });
  } finally {
    stub.restore();
  }

  for (const call of stub.calls) {
    // `/api/robots` exactly, or with a sub-path. `/api/simulator/robot` must not match.
    assert.doesNotMatch(call.url, /\/api\/robots(\/|$)/);
  }
});

test('C — the page reaches the endpoint through that module and nothing else', () => {
  const page = code(read(SIMULATED_PAGE));

  // No hand-rolled request of any kind, and in particular no route to the commissioning
  // action: creating a simulated robot through `commission` is precisely the loophole the
  // backend closed with `SIMULATED_NOT_ALLOWED_HERE`.
  assert.doesNotMatch(page, /\bfetch\s*\(/);
  assert.doesNotMatch(page, /api\/robots/);
  assert.doesNotMatch(page, /\bcommissionRobot\b/);
  assert.match(page, /createSimulatedRobot/);

  // And the action it calls is the one wired to the simulator API module.
  const provider = code(read('context/AppProvider.jsx'));
  assert.match(provider, /simulatorApi\.createSimulatedRobot/);
});

test('C — nothing in the frontend constructs a VirtualRobot or speaks the agent protocol', () => {
  // §13: the only valid way to get a VirtualRobot is `SimulationEngine.addRobot()`,
  // server-side. The frontend calls the backend; it does not simulate anything.
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|jsx|mjs)$/.test(entry.name) && !full.includes('__architecture__')) {
        files.push({ rel: path.relative(SRC, full).replace(/\\/g, '/'), source: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(SRC);
  assert.ok(files.length > 50, 'the sweep found suspiciously few files');

  const offenders = files
    .filter((f) => /new\s+VirtualRobot\s*\(/.test(code(f.source)))
    .map((f) => f.rel);
  assert.deepEqual(offenders, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST D — there is no fleet creation
// ═══════════════════════════════════════════════════════════════════════════

/** Words that would only appear in a bulk-creation surface. */
const FLEET_PATTERNS = [
  /\bcount\b/i,
  /\bnumberOfRobots\b/i,
  /\bfleetSize\b/i,
  /\bquantity\b/i,
  /\bbulk\b/i,
];

test('D — the simulated creation page has no count, quantity or fleet-size input', () => {
  const page = code(read(SIMULATED_PAGE));
  for (const pattern of FLEET_PATTERNS) {
    assert.doesNotMatch(page, pattern, `fleet-creation vocabulary found: ${pattern}`);
  }
});

test('D — the simulator API module offers exactly one creation call, with no count', () => {
  const api = code(read(SIMULATOR_API));
  for (const pattern of FLEET_PATTERNS) {
    assert.doesNotMatch(api, pattern);
  }
  // One creation export. A `createSimulatedRobots` or a `createFleet` beside it would be
  // the fleet API arriving by a different name.
  const exported = [...api.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(exported.filter((name) => /^create/.test(name)), ['createSimulatedRobot']);
});

test('D — the request body carries no count, no robotId, no simulated and no owner', async () => {
  // The server refuses all four by name; this asserts the client never sends them, so the
  // refusal is a backstop rather than the thing being relied on.
  const stub = stubFetch({ status: 201, body: { ok: true, robot: { robotId: 'SIM-ABC' } } });
  try {
    await createSimulatedRobot({
      name: 'Test Rover',
      locationId: 'loc-1',
      lat: 12.9,
      lon: 77.5,
      chassisType: 'Rover (Ground)',
      specification: { massKg: 45 },
    });
  } finally {
    stub.restore();
  }

  const sent = JSON.parse(stub.calls[0].init.body);
  for (const forbidden of ['count', 'robotId', 'simulated', 'simulationOwnerId']) {
    assert.equal(forbidden in sent, false, `${forbidden} must not be sent`);
  }
  assert.deepEqual(Object.keys(sent).sort(), ['chassisType', 'lat', 'locationId', 'lon', 'name', 'specification']);
});

test('D — the fleet detector is not vacuous', () => {
  const planted = 'const [count, setCount] = useState(1); <Input id="fleet-size" value={count} />';
  assert.ok(FLEET_PATTERNS.some((p) => p.test(planted)), 'the detector must catch a planted count input');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST E — physical commissioning has no simulator toggle
// ═══════════════════════════════════════════════════════════════════════════

test('E — the commissioning form exposes no simulated checkbox, switch or choice', () => {
  const page = code(read(COMMISSION_PAGE));

  assert.doesNotMatch(page, /\bsimulated\b/i, 'the physical commissioning form must not mention simulation');
  assert.doesNotMatch(page, /\bsimulator\b/i);
  assert.doesNotMatch(page, /api\/simulator/);
  // No Physical/Simulated selector by any spelling.
  assert.doesNotMatch(page, /Physical\s*\/\s*Simulated/i);
});

test('E — commissioning still sends the physical payload it always sent', () => {
  // Not just an absence: the flow has to still work. `commission` is the action, and it
  // is still the one wired to `robotsApi.commissionRobot`.
  const provider = code(read('context/AppProvider.jsx'));
  assert.match(provider, /robotsApi\.commissionRobot\(/);
  const page = code(read(COMMISSION_PAGE));
  assert.match(page, /commission\(/);
});

test('E — the two flows are two routes and two buttons, not one screen with a mode', () => {
  const router = code(read('router/AppRouter.jsx'));
  assert.match(router, /path="commission"/);
  assert.match(router, /path="simulator\/new"/);

  const sidebar = code(read('components/layout/AppSidebar.jsx'));
  assert.match(sidebar, /Commission Physical Robot/);
  assert.match(sidebar, /Create Simulated Robot/);
});

test('E — the simulator-toggle detector is not vacuous', () => {
  const planted = code('<Switch id="simulated" checked={form.simulated} /> {/* simulated */}');
  assert.match(planted, /\bsimulated\b/i, 'the detector must catch a planted simulator toggle');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST F — many simulated robots are ordinary, and the UI states no rule
// ═══════════════════════════════════════════════════════════════════════════

test('F — repeated creation is ordinary: three calls, three requests, three robots', async () => {
  // The corrected rule, at the layer this file owns. Nothing in the client counts, caches
  // a previous creation, or refuses the second call.
  const ids = ['SIM-0000000000A1', 'SIM-0000000000B2', 'SIM-0000000000C3'];
  const results = [];

  for (const robotId of ids) {
    const stub = stubFetch({ status: 201, body: { ok: true, robot: { robotId, simulated: true } } });
    try {
      // eslint-disable-next-line no-await-in-loop
      results.push(await createSimulatedRobot({
        locationId: 'loc-1',
        chassisType: 'Rover (Ground)',
        specification: {},
      }));
      assert.equal(stub.calls.length, 1, 'one call must produce exactly one request');
    } finally {
      stub.restore();
    }
  }

  assert.deepEqual(results.map((r) => r.robot.robotId), ids);
});

test('F — the ownership-conflict predicate is gone from the API module', () => {
  // Its continued existence would be a client-side statement of a rule that no longer
  // exists, and the next caller to reach for it would reintroduce the removed behaviour.
  assert.equal('isAlreadyOwnedError' in simulatorApi, false);
  assert.equal('ALREADY_OWNED_STATUS' in simulatorApi, false);

  const api = code(read(SIMULATOR_API));
  assert.doesNotMatch(api, /isAlreadyOwnedError|ALREADY_OWNED/);
});

test('F — the page states no per-operator limit, in any wording', () => {
  // Structural, because this is an absence. The page previously rendered "You already have
  // a simulated robot." above the server's own sentence; both the panel and the rule it
  // described are gone.
  //
  // Comments are stripped first. The claim is about what the page *renders* and what it
  // *does*, and the file's header comment deliberately records that the rule existed and
  // was removed — history a reader needs, and the one place these words should still
  // appear. A detector that failed on it would be pushing us to delete the explanation.
  const page = code(read(SIMULATED_PAGE));
  for (const pattern of [
    /already have a simulated robot/i,
    /already own/i,
    /one at a time/i,
    /one simulated robot per/i,
    /isAlreadyOwnedError/,
  ]) {
    assert.doesNotMatch(page, pattern, `the removed one-per-operator rule survives as: ${pattern}`);
  }
});

test('F — the limit detector is not vacuous', () => {
  const planted = 'You already have a simulated robot. Each operator may own one at a time.';
  assert.match(planted, /already have a simulated robot/i);
  assert.match(planted, /one at a time/i);
});

test('F — a server refusal still reaches the operator, and is never retried', async () => {
  // What survives from the old F: refusals are not swallowed. The status under test is now
  // the SUPER_ADMIN 403 the backend answers for a non-elevated caller.
  const serverSentence = 'this surface requires an elevated role (§23.4)';
  const stub = stubFetch({ ok: false, status: 403, body: { message: serverSentence } });

  let caught = null;
  try {
    await createSimulatedRobot({ locationId: 'loc-1', chassisType: 'Rover (Ground)', specification: {} });
  } catch (err) {
    caught = err;
  } finally {
    stub.restore();
  }

  assert.ok(caught, 'a refusal must reach the caller as a rejection, not a resolved value');
  assert.equal(caught.status, 403);
  assert.equal(stub.calls.length, 1, 'a refusal is never retried');
});

test('F — the page implements no authorisation rule of its own', () => {
  // §7: "The frontend must not implement the authorization rule itself." The page must not
  // read a role, branch on one, or hide itself based on one — the backend is authoritative
  // and a hidden button is not a security control.
  const page = code(read(SIMULATED_PAGE));

  assert.doesNotMatch(page, /SUPER_ADMIN/);
  // `role=` as a JSX prop is ARIA, not authorisation, so the detector looks for a role
  // being *read* — `user.role`, `session.role`, a destructured `role` — rather than for
  // the word.
  assert.doesNotMatch(page, /\.\s*role\b|\brole\s*[=!]==|\brole\s*:/);
  assert.doesNotMatch(page, /isAdmin|hasRole|canCreate|elevated/i);
  // The refusal path shows the server's message rather than one written here.
  assert.match(page, /err\?\.message/);
});

test('F — the page renders one refusal path, and does not resubmit', () => {
  const page = code(read(SIMULATED_PAGE));

  assert.match(page, /\{formError\}/);
  // Nothing re-enters the submit path on failure.
  assert.doesNotMatch(page, /catch[\s\S]{0,200}createSimulatedRobot\(/);
});

test('F — creating another is offered, and it is not a bulk form', () => {
  const page = code(read(SIMULATED_PAGE));

  // The success view offers another creation…
  assert.match(page, /Create another/);
  // …by returning to the same one-robot form, not by looping or by asking for a number.
  assert.match(page, /setCreated\(null\)/);
  assert.doesNotMatch(page, /for\s*\(|\.map\(\s*\(\s*_\s*,/);
});

test('F — the page holds no client-side copy of any creation restriction', () => {
  // "Do not implement a client-side-only restriction." The page must not decide anything
  // about whether this creation is allowed — not from the robot list, not from a count of
  // what the operator already has, not from a role. The server decides; a second copy here
  // would be the copy that is wrong.
  const page = code(read(SIMULATED_PAGE));
  assert.doesNotMatch(page, /useAppState/);
  assert.doesNotMatch(page, /\brobots\b\s*\./);
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST G — identity, runtime and liveness are three different things
// ═══════════════════════════════════════════════════════════════════════════

const SIM_ROBOT = Object.freeze({ robotId: 'SIM-ABC', simulated: true, isOnline: false });
const PHYSICAL_ROBOT = Object.freeze({ robotId: 'RBT-1000', simulated: false, isOnline: true });

test('G — identity is read strictly, and an unstated one is not assumed physical', () => {
  assert.equal(identityOf(SIM_ROBOT), IDENTITY.SIMULATED);
  assert.equal(identityOf(PHYSICAL_ROBOT), IDENTITY.PHYSICAL);
  assert.equal(identityOf({ robotId: 'X' }), IDENTITY.UNKNOWN);
  assert.equal(identityOf({ robotId: 'X', simulated: 'true' }), IDENTITY.UNKNOWN);
  assert.equal(identityOf(null), IDENTITY.UNKNOWN);
});

test('G — a simulated robot with no simulator instance is PERSISTED_NOT_RUNNING', () => {
  const disabled = { enabled: false, started: false, robotCount: 0, robots: [] };
  assert.equal(runtimeStatusOf(SIM_ROBOT, disabled), RUNTIME.PERSISTED_NOT_RUNNING);

  const enabledButEmpty = { enabled: true, started: true, robotCount: 0, robots: [] };
  assert.equal(runtimeStatusOf(SIM_ROBOT, enabledButEmpty), RUNTIME.PERSISTED_NOT_RUNNING);

  const notStarted = { enabled: true, started: false, robots: [{ robotId: 'SIM-ABC' }] };
  assert.equal(runtimeStatusOf(SIM_ROBOT, notStarted), RUNTIME.PERSISTED_NOT_RUNNING);
});

test('G — RUNNING requires an actual instance for this robot, in a started engine', () => {
  const running = { enabled: true, started: true, robots: [{ robotId: 'SIM-ABC' }] };
  assert.equal(runtimeStatusOf(SIM_ROBOT, running), RUNTIME.RUNNING);

  // Somebody else's instance is not this robot's.
  const other = { enabled: true, started: true, robots: [{ robotId: 'SIM-OTHER' }] };
  assert.equal(runtimeStatusOf(SIM_ROBOT, other), RUNTIME.PERSISTED_NOT_RUNNING);
});

test('G — simulated=true never implies running, and never implies online', () => {
  // The claim the step names: identity and liveness are different properties. A simulated
  // robot with the simulator switched off is offline and not running, and the UI says so.
  assert.equal(isSimulated(SIM_ROBOT), true);
  assert.equal(SIM_ROBOT.isOnline, false);
  assert.equal(runtimeStatusOf(SIM_ROBOT, { enabled: false, started: false, robots: [] }), RUNTIME.PERSISTED_NOT_RUNNING);

  // And the converse: flipping `isOnline` changes nothing about the runtime answer, which
  // is how we know one is not being derived from the other.
  const onlineSim = { ...SIM_ROBOT, isOnline: true };
  assert.equal(
    runtimeStatusOf(onlineSim, { enabled: false, started: false, robots: [] }),
    RUNTIME.PERSISTED_NOT_RUNNING,
  );
});

test('G — an unreadable simulator status is UNKNOWN, never "not running"', () => {
  assert.equal(runtimeStatusOf(SIM_ROBOT, null), RUNTIME.UNKNOWN);
  assert.equal(runtimeStatusOf(SIM_ROBOT, undefined), RUNTIME.UNKNOWN);
});

test('G — a physical robot has no simulator runtime at all', () => {
  const running = { enabled: true, started: true, robots: [{ robotId: 'RBT-1000' }] };
  assert.equal(runtimeStatusOf(PHYSICAL_ROBOT, running), null);
  assert.equal(runtimeStatusOf(PHYSICAL_ROBOT, null), null);
});

test('G — the identity module never reads liveness', () => {
  // Structural, because the hazard is a line that does not exist: the `isOnline: true`
  // this programme has already had to remove twice was written by somebody deriving
  // liveness from something that was not a session.
  const lib = code(read('lib/simulationIdentity.js'));
  assert.doesNotMatch(lib, /\bisOnline\b/);
  assert.doesNotMatch(lib, /\blastSeenAt\b/);
});

test('G — getSimulatorStatus reports unavailability as null rather than inventing a state', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connection refused'); };
  try {
    assert.equal(await getSimulatorStatus(), null);
  } finally {
    globalThis.fetch = original;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// STEP 4 — RUNNING is the instance's own answer, not the engine's flag
// ═══════════════════════════════════════════════════════════════════════════

test('Step 4 — a robot the engine holds but is not running is NOT reported RUNNING', () => {
  // The finding this replaces. `runtimeStatusOf` was `enabled && started && managed`, and
  // `SimulationEngine.start()` set `started` without starting anything — so a fleet stopped
  // by POST /api/simulator/stop and started again had no sockets and no tick timers while
  // every robot here was labelled RUNNING. The backend now both starts what it claims and
  // reports each instance's own `running`, and this reads that rather than inferring it.
  const stoppedInstance = {
    enabled: true,
    started: true,
    robots: [{ robotId: 'SIM-ABC', running: false }],
  };
  assert.equal(runtimeStatusOf(SIM_ROBOT, stoppedInstance), RUNTIME.PERSISTED_NOT_RUNNING);

  const liveInstance = {
    enabled: true,
    started: true,
    robots: [{ robotId: 'SIM-ABC', running: true }],
  };
  assert.equal(runtimeStatusOf(SIM_ROBOT, liveInstance), RUNTIME.RUNNING);
});

test('Step 4 — a running instance is believed even if the engine flag lags', () => {
  // `running` is the tick timer, which is the fact. Where the per-robot answer is present it
  // governs, so the reading cannot be wrong in the permissive direction *or* the restrictive
  // one because of a flag the engine happens to hold.
  const snapshot = { enabled: true, started: false, robots: [{ robotId: 'SIM-ABC', running: true }] };
  assert.equal(runtimeStatusOf(SIM_ROBOT, snapshot), RUNTIME.RUNNING);
});

test('Step 4 — a disabled simulator is never RUNNING, whatever an instance claims', () => {
  // `enabled` stays a hard precondition: a disabled deployment spawns nothing, so a snapshot
  // asserting otherwise is incoherent and must not be read permissively.
  const incoherent = { enabled: false, started: true, robots: [{ robotId: 'SIM-ABC', running: true }] };
  assert.equal(runtimeStatusOf(SIM_ROBOT, incoherent), RUNTIME.PERSISTED_NOT_RUNNING);
});

test('Step 4 — a snapshot without the per-robot field is read the way it was before', () => {
  // Backward compatibility with a backend that does not send `running`: fall back to the
  // engine flag rather than reporting every robot stopped.
  const legacy = { enabled: true, started: true, robots: [{ robotId: 'SIM-ABC' }] };
  assert.equal(runtimeStatusOf(SIM_ROBOT, legacy), RUNTIME.RUNNING);

  const legacyStopped = { enabled: true, started: false, robots: [{ robotId: 'SIM-ABC' }] };
  assert.equal(runtimeStatusOf(SIM_ROBOT, legacyStopped), RUNTIME.PERSISTED_NOT_RUNNING);
});

test('Step 4 — a held-but-stopped instance is described as one, not as "database only"', () => {
  const snapshot = { enabled: true, started: true, robots: [{ robotId: 'SIM-ABC', running: false }] };
  const status = runtimeStatusOf(SIM_ROBOT, snapshot);
  const reason = runtimeReason(status, snapshot, SIM_ROBOT);

  assert.match(reason, /holds an instance/i);
  assert.doesNotMatch(reason, /database only/i);

  // Without the robot the more specific sentence is unavailable, and the general one is
  // still true rather than wrong.
  assert.match(runtimeReason(status, snapshot), /No simulator instance is running this unit/);
});

test('Step 4 — the disabled and not-started reasons are unchanged', () => {
  const disabled = { enabled: false, started: false, robots: [] };
  assert.match(
    runtimeReason(runtimeStatusOf(SIM_ROBOT, disabled), disabled, SIM_ROBOT),
    /simulator is disabled/i,
  );

  const notStarted = { enabled: true, started: false, robots: [] };
  assert.match(
    runtimeReason(runtimeStatusOf(SIM_ROBOT, notStarted), notStarted, SIM_ROBOT),
    /enabled but not started/i,
  );
});

test('Step 4 — the identity module still never reads liveness', () => {
  // Re-asserted after the change, because the change added a new field read (`running`) and
  // the hazard is that the next one is `isOnline`.
  const lib = code(read('lib/simulationIdentity.js'));
  assert.doesNotMatch(lib, /\bisOnline\b/);
  assert.doesNotMatch(lib, /\blastSeenAt\b/);
});

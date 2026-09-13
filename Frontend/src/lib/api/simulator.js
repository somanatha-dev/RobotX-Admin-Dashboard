import { requestJson } from './httpClient.js';

/**
 * The simulator's HTTP surface, as the frontend is allowed to use it.
 *
 * ── The boundary this module is one half of ─────────────────────────────────
 * The frontend never constructs a simulated agent; it asks the backend to. `VirtualRobot`
 * is constructed in exactly one place in the whole system — `SimulationEngine.addRobot`,
 * server-side — and nothing here knows the agent protocol, the telemetry cadence, the
 * battery model or the movement model. This file sends two requests and returns what came
 * back.
 */

/**
 * Create exactly ONE simulated robot, recorded against the authenticated operator.
 *
 * ── There is no ownership refusal to handle ─────────────────────────────────
 * This module used to export `ALREADY_OWNED_STATUS` / `isAlreadyOwnedError`, for a 409 the
 * backend answered when the operator already had a simulated robot. That rule was a
 * misreading of the requirement — one SUPER_ADMIN may have many simulated robots, with no
 * limit — so the constraint behind it was dropped and the predicate went with it. Calling
 * this function repeatedly is ordinary, expected use, and each call resolves with a new
 * robot.
 *
 * ── What is deliberately not a parameter ────────────────────────────────────
 * There is no `count`, no fleet size and no batch form — one call creates one robot, and
 * several robots come from several calls. There is no `robotId`: the server generates it,
 * so a client cannot collide with a physical unit's identifier. There is no `simulated`
 * flag: every robot created through this endpoint is simulated, which is what the endpoint
 * is. And there is no `simulationOwnerId`: the creator is derived from the session, and
 * the backend refuses a body that tries to name one.
 *
 * The payload is therefore the same legitimate creation information physical
 * commissioning collects, minus the identifier.
 *
 * ── Authorisation is the server's ───────────────────────────────────────────
 * The endpoint is SUPER_ADMIN-only, enforced by the backend. Nothing here checks a role,
 * and a caller without one receives the server's 403 as an ordinary rejection.
 *
 * @param {{ name?: string|null, locationId: string, lat?: number|null, lon?: number|null,
 *           chassisType: string, specification: object }} payload
 * @returns {Promise<{ ok: boolean, status: string, robot: object, simulator: object }>}
 */
export async function createSimulatedRobot(payload) {
  return requestJson('/api/simulator/robot', { method: 'POST', body: payload });
}

/**
 * The simulator's runtime snapshot: whether it is enabled, whether it has been started,
 * and which robots it currently has instances for.
 *
 * Resolves to `null` rather than throwing when the snapshot cannot be read — the caller
 * renders that as "status unknown", which is the honest answer, and a simulator that is
 * unreachable must not take the robot list down with it.
 *
 * @returns {Promise<object|null>}
 */
export async function getSimulatorStatus() {
  try {
    return await requestJson('/api/simulator/status');
  } catch {
    return null;
  }
}

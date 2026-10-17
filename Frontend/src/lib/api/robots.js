import { requestJson } from './httpClient.js';

export async function getRobotsState() {
  const data = await requestJson('/api/robots/state');
  return data?.robots || [];
}

export async function commissionRobot(payload) {
  const data = await requestJson('/api/robots', { method: 'POST', body: payload });
  return data?.robot || null;
}

/**
 * Issue a one-time pairing code for an already-commissioned robot.
 *
 * Sent with only the robotId, so it cannot create or change a robot. It replaces any earlier
 * unused code for the robot. The code is in this response and nowhere else, ever: the caller
 * keeps it in component memory for the life of the page and never in the URL or storage.
 *
 * @param {string} robotId
 * @returns {Promise<{ pairingCode: string, expiresIn: number }>}
 */
export async function requestPairingCode(robotId) {
  const data = await requestJson('/api/robots/commission', {
    method: 'POST',
    body: { robotId },
    errorMessage: 'Could not issue a pairing code',
  });
  return { pairingCode: data?.pairingCode ?? null, expiresIn: data?.expiresIn ?? null };
}

/**
 * Where a robot's enrollment stands: online, enrolled, a code pending, failed attempts,
 * locked. Never the code.
 *
 * @param {string} robotId
 * @returns {Promise<{ robotId: string, isOnline: boolean, lastSeenAt: string|null, enrolled: boolean, pairingPending: boolean, failedAttempts: number, locked: boolean }>}
 */
export async function getPairingStatus(robotId) {
  const data = await requestJson(`/api/robots/${encodeURIComponent(robotId)}/pairing`, {
    errorMessage: 'Could not read the pairing status',
  });
  return {
    robotId: data?.robotId ?? robotId,
    isOnline: data?.isOnline === true,
    lastSeenAt: data?.lastSeenAt ?? null,
    enrolled: data?.enrolled === true,
    pairingPending: data?.pairingPending === true,
    failedAttempts: Number.isFinite(data?.failedAttempts) ? data.failedAttempts : 0,
    locked: data?.locked === true,
  };
}

/**
 * Edit a commissioned unit's configuration.
 *
 * The backend accepts only the name, the chassis family and the six specification values;
 * anything else is refused **by name** rather than ignored, because observed state is
 * reported by the fleet and assignment state belongs to the engine. So this sends exactly
 * what the edit form collected and nothing derived from the rendered row.
 */
export async function updateRobot(robotId, patch) {
  const data = await requestJson(`/api/robots/${encodeURIComponent(robotId)}`, {
    method: 'PATCH',
    body: patch,
  });
  return data?.robot || null;
}

export async function sendCommand(robotId, type) {
  const data = await requestJson(`/api/robots/${encodeURIComponent(robotId)}/command`, {
    method: 'POST',
    body: { type },
  });
  return data;
}

/**
 * The retired units an operator may choose to recommission. Identity and display fields only.
 * @returns {Promise<Array<{ robotId: string, name: string|null, simulated: boolean, recommissionable: boolean, lastSeenAt: string|null, locationName: string|null, retiredAt: string|null }>>}
 */
export async function listRetiredRobots() {
  const data = await requestJson('/api/robots/retired', { errorMessage: 'Could not load the retired robots' });
  return Array.isArray(data?.robots) ? data.robots : [];
}

/**
 * Recommission a retired robot (its own record, not a new unit). The body is exactly what the
 * server accepts — `reason` and `confirmRobotId`; the server checks the role.
 *
 * @param {string} robotId
 * @param {{ reason: string, confirmRobotId: string }} body
 * @returns {Promise<{ robotId: string, alreadyRecommissioned: boolean, lifecycleState: string, releasedToService: boolean, pairingRequired: boolean }>}
 */
export async function recommissionRobot(robotId, body) {
  const data = await requestJson(`/api/robots/${encodeURIComponent(robotId)}/recommission`, {
    method: 'POST',
    body,
    errorMessage: 'Recommissioning failed',
  });
  return {
    robotId: data?.robotId ?? robotId,
    alreadyRecommissioned: data?.alreadyRecommissioned === true,
    lifecycleState: data?.lifecycleState ?? null,
    releasedToService: data?.releasedToService === true,
    pairingRequired: data?.pairingRequired !== false,
  };
}

export async function deleteRobot(robotId) {
  const data = await requestJson(`/api/robots/${encodeURIComponent(robotId)}`, { method: 'DELETE' });
  return data;
}

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

export async function deleteRobot(robotId) {
  const data = await requestJson(`/api/robots/${encodeURIComponent(robotId)}`, { method: 'DELETE' });
  return data;
}

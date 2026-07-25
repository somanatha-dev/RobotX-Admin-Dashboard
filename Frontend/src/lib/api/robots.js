import { requestJson } from './httpClient.js';

export async function getRobotsState() {
  const data = await requestJson('/api/robots/state');
  return data?.robots || [];
}

export async function commissionRobot(payload) {
  const data = await requestJson('/api/robots', { method: 'POST', body: payload });
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

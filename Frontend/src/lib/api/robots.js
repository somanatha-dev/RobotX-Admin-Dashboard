const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

async function readJsonSafe(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function requestJson(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await readJsonSafe(res);
  if (!res.ok) {
    const message = data?.message || 'Request failed';
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function getRobotsState() {
  const data = await requestJson('/api/robots/state');
  return data?.robots || [];
}

export async function listRobots(params) {
  const q = params && typeof params === 'object' ? params : null;
  const sp = new URLSearchParams();
  if (q?.locationId) sp.set('locationId', String(q.locationId));
  if (q?.campusId) sp.set('campusId', String(q.campusId));
  if (typeof q?.includeDescendants === 'boolean') sp.set('includeDescendants', String(q.includeDescendants));
  const qs = sp.toString();
  const data = await requestJson(qs ? `/api/robots?${qs}` : '/api/robots');
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

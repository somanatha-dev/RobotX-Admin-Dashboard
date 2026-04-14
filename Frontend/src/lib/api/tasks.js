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

export async function listTasks() {
  const data = await requestJson('/api/tasks');
  return data?.tasks || [];
}

export async function assignTask(payload) {
  const data = await requestJson('/api/tasks/assign', { method: 'POST', body: payload });
  return data?.task || null;
}

export async function cancelTask(taskId) {
  const data = await requestJson(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' });
  return data?.task || null;
}

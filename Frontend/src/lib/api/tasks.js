import { requestJson } from './httpClient.js';

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

export async function rerouteTask(taskId) {
  const data = await requestJson(`/api/tasks/${encodeURIComponent(taskId)}/reroute`, { method: 'POST' });
  return data || null;
}

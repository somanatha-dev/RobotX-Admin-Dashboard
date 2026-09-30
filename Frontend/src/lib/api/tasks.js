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

/**
 * The engine's explanation of a task's latest assignment decision (§21.3) — the existing
 * `/api/explain` surface, resolved by task. Explanatory only: the task's own status is the
 * authority, and a failure here must never be treated as a task failure.
 */
export async function explainTask(taskId) {
  return requestJson(`/api/explain/task/${encodeURIComponent(taskId)}`);
}

export async function rerouteTask(taskId) {
  const data = await requestJson(`/api/tasks/${encodeURIComponent(taskId)}/reroute`, { method: 'POST' });
  return data || null;
}

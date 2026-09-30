import { requestJson } from './httpClient.js';
import { IDEMPOTENCY_HEADER } from '../idempotency.js';

export async function listTasks() {
  const data = await requestJson('/api/tasks');
  return data?.tasks || [];
}

/**
 * Submit a task to intake.
 *
 * `idempotencyKey` is the draft's key (FS-08): the same key on every retry of one draft, so
 * a retry after an answer that never arrived is answered with the original acceptance
 * instead of a second task. Resolves to the task row and intake's own answer
 * (`intake.outcome` is `ACCEPTED`, or `DUPLICATE` for a retry the backend recognised).
 *
 * @param {object} payload the body `buildAssignTaskRequest` built
 * @param {{ idempotencyKey?: string }} [options]
 * @returns {Promise<{ task: object|null, intake: object|null }>}
 */
export async function assignTask(payload, { idempotencyKey } = {}) {
  const data = await requestJson('/api/tasks/assign', {
    method: 'POST',
    body: payload,
    headers: idempotencyKey ? { [IDEMPOTENCY_HEADER]: idempotencyKey } : undefined,
  });
  return { task: data?.task || null, intake: data?.intake || null };
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

// No caller for the legacy `POST /api/tasks/:id/reroute` (FS-06): it runs outside the
// assignment engine — it reads a route-cache task state the engine path never advances and
// asks Mapbox Directions for a new path — so the dashboard does not offer it.

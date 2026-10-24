import { requestJson } from './httpClient.js';

/**
 * DTARO — the PUBLISHED zone map (`GET /api/dtaro/zones`, SUPER_ADMIN only).
 *
 * Resolves to the backend's answer — the zones, plus `alertsEnabled` (whether obstacle alerts are
 * on) — or, when the request is refused or fails, `{ available: false, alertsEnabled: false,
 * error: <reason> }`. The legend states that reason: an empty map with no explanation is what the
 * operator saw when this failed silently (2026-10-22).
 *
 * @returns {Promise<object>}
 */
export async function getDtaroZones() {
  try {
    const data = await requestJson('/api/dtaro/zones', { errorMessage: 'Could not load the zone map' });
    return data && typeof data === 'object' ? data : { available: false, alertsEnabled: false, error: 'EMPTY_RESPONSE' };
  } catch (err) {
    return { available: false, alertsEnabled: false, error: err?.status ? `HTTP ${err.status}` : 'NETWORK' };
  }
}

/**
 * DTARO — the obstacle events this backend process already sent to the dashboard
 * (`GET /api/dtaro/activity`, SUPER_ADMIN only), oldest first and exactly as sent, so a page that
 * opens or reconnects after a report can replay them through the same reducer as live events.
 *
 * @returns {Promise<{ events: Array<{ seq: number, event: string, payload: object }>, error?: string }>}
 */
export async function getDtaroActivity() {
  try {
    const data = await requestJson('/api/dtaro/activity', { errorMessage: 'Could not load obstacle activity' });
    return { events: Array.isArray(data?.events) ? data.events : [] };
  } catch (err) {
    return { events: [], error: err?.status ? `HTTP ${err.status}` : 'NETWORK' };
  }
}

/**
 * DTARO operator decisions — every decision this backend process holds (live, with the server's
 * deadline and clock) and recent archived ones (`GET /api/dtaro/decisions`, SUPER_ADMIN only), so a
 * page that opens or reconnects restores its decision panel without restarting the countdown.
 *
 * @returns {Promise<{ enabled: boolean, decisions: object[], error?: string }>}
 */
export async function getDtaroDecisions() {
  try {
    const data = await requestJson('/api/dtaro/decisions', { errorMessage: 'Could not load obstacle decisions' });
    return { enabled: data?.enabled === true, decisions: Array.isArray(data?.decisions) ? data.decisions : [] };
  } catch (err) {
    return { enabled: false, decisions: [], error: err?.status ? `HTTP ${err.status}` : 'NETWORK' };
  }
}

/**
 * DTARO operator decisions — submit STOP, REROUTE or REJECT_BROADCAST for one decision
 * (`POST /api/dtaro/decisions/:decisionId`). The server decides whether it is in time and commits at
 * most one decision; a retry under the same `idempotencyKey` gets the committed result back.
 *
 * Resolves to `{ ok, status, outcome?, error?, decision? }`, where `decision` is the server's whole
 * decision whenever it sent one — including when it refused this request (409: already decided, or
 * the deadline passed and the server applied its default). Never throws.
 *
 * @param {string} decisionId
 * @param {'STOP'|'REROUTE'|'REJECT_BROADCAST'} decision
 * @param {string} idempotencyKey
 */
export async function submitObstacleDecision(decisionId, decision, idempotencyKey) {
  try {
    const data = await requestJson(`/api/dtaro/decisions/${encodeURIComponent(decisionId)}`, {
      method: 'POST',
      body: { decision, idempotencyKey },
      errorMessage: 'The decision was not accepted',
    });
    return { ok: true, status: 200, outcome: data?.outcome || null, decision: data?.decision || null };
  } catch (err) {
    const body = err?.body || null;
    return {
      ok: false,
      status: err?.status || null,
      error: (body && typeof body.error === 'string' && body.error) || (err?.status ? `HTTP ${err.status}` : 'NETWORK'),
      committed: body?.committed || null,
      decision: body?.decision || null,
    };
  }
}

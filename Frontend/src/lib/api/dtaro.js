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

/** A server-shaped DTARO decision (`GET /api/dtaro/decisions` / OBSTACLE_DECISION_*), for tests. */

const T0 = Date.UTC(2026, 9, 24, 6, 0, 0);
const iso = (ms) => new Date(ms).toISOString();

export function sample(over = {}) {
  return {
    decisionId: 'dec-1',
    revision: 1,
    status: 'AWAITING_OPERATOR_DECISION',
    provenance: 'SIMULATED',
    serverNow: iso(T0),
    receivedAt: iso(T0),
    deadlineAt: iso(T0 + 5000),
    windowMs: 5000,
    defaultDecision: 'REROUTE',
    decision: null,
    obstacle: { obstacleId: 'OBS-1', lat: 12.9, lon: 77.5, regionId: 'rnsit', zoneId: 'z1', cellId: '8b', expiresAt: iso(T0 + 300_000) },
    reporter: { robotId: 'SIM-R', role: 'REPORTER' },
    robots: [],
    history: [],
    ...over,
  };
}

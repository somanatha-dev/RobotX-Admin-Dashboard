export function normalizeStatus(status) {
  return String(status || '').toUpperCase();
}

export function isActive(status) {
  return normalizeStatus(status) === 'ACTIVE';
}

export function isIdle(status) {
  return normalizeStatus(status) === 'IDLE';
}

export function isIssues(status) {
  return ['ERROR', 'ISSUES', 'OFFLINE'].includes(normalizeStatus(status));
}

// Charging audit U-1 — CHARGING only. PAUSED (an operator hold) used to count, so a held robot
// was shown with the charging tone while its battery fell.
export function isCharging(status) {
  return normalizeStatus(status) === 'CHARGING';
}

export function isPaused(status) {
  return normalizeStatus(status) === 'PAUSED';
}

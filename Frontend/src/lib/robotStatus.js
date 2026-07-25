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

export function isCharging(status) {
  return ['CHARGING', 'PAUSED'].includes(normalizeStatus(status));
}

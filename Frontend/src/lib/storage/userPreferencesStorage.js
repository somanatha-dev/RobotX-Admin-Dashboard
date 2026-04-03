const KEY_PREFIX = 'robotx_user_prefs:';

const DEFAULT_PREFERENCES = {
  notificationsEnabled: true,
  auditLogEnabled: true,
  theme: 'system', // 'system' | 'light' | 'dark'
};

export function loadUserPreferences(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return { ...DEFAULT_PREFERENCES };

  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}${clean}`);
    if (!raw) return { ...DEFAULT_PREFERENCES };

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_PREFERENCES };

    return {
      notificationsEnabled:
        typeof parsed.notificationsEnabled === 'boolean'
          ? parsed.notificationsEnabled
          : DEFAULT_PREFERENCES.notificationsEnabled,
      auditLogEnabled:
        typeof parsed.auditLogEnabled === 'boolean'
          ? parsed.auditLogEnabled
          : DEFAULT_PREFERENCES.auditLogEnabled,
      theme:
        parsed.theme === 'light' || parsed.theme === 'dark' || parsed.theme === 'system'
          ? parsed.theme
          : DEFAULT_PREFERENCES.theme,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function saveUserPreferences(email, preferences) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return;

  try {
    localStorage.setItem(`${KEY_PREFIX}${clean}`, JSON.stringify(preferences));
  } catch {
    // ignore
  }
}

export { DEFAULT_PREFERENCES };

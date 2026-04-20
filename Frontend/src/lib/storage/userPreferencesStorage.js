const KEY_PREFIX = 'robotx_user_prefs:';

const DEFAULT_PREFERENCES = {
  notificationsEnabled: true,
  auditLogEnabled: true,
  theme: 'system', // 'system' | 'light' | 'dark'
};

function normalizeUserId(userId) {
  const id = String(userId || '').trim();
  return id || null;
}

function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return e || null;
}

function keyForUserId(userId) {
  const id = normalizeUserId(userId);
  return id ? `${KEY_PREFIX}${id}` : null;
}

// Legacy key (older versions used email; email can change)
function legacyKeyForEmail(email) {
  const e = normalizeEmail(email);
  return e ? `${KEY_PREFIX}${e}` : null;
}

function normalizePreferences(parsed) {
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
}

// Preferred: { userId, email } (email only used to migrate legacy storage)
export function loadUserPreferences(identity) {
  const userId = identity && typeof identity === 'object' ? identity.userId || identity.id : null;
  const email = identity && typeof identity === 'object' ? identity.email : identity;

  const key = keyForUserId(userId);
  const legacyKey = legacyKeyForEmail(email);

  // Try new key first
  if (key) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return normalizePreferences(JSON.parse(raw));
    } catch {
      // ignore
    }

    // One-time migration from legacy key -> new key
    if (legacyKey) {
      try {
        const legacyRaw = localStorage.getItem(legacyKey);
        if (legacyRaw) {
          const prefs = normalizePreferences(JSON.parse(legacyRaw));
          try {
            localStorage.setItem(key, JSON.stringify(prefs));
            localStorage.removeItem(legacyKey);
          } catch {
            // ignore
          }
          return prefs;
        }
      } catch {
        // ignore
      }
    }

    return { ...DEFAULT_PREFERENCES };
  }

  // Fallback (should be rare): read legacy-by-email only
  if (legacyKey) {
    try {
      const raw = localStorage.getItem(legacyKey);
      if (!raw) return { ...DEFAULT_PREFERENCES };
      return normalizePreferences(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_PREFERENCES };
    }
  }

  return { ...DEFAULT_PREFERENCES };
}

export function saveUserPreferences(identity, preferences) {
  const userId = identity && typeof identity === 'object' ? identity.userId || identity.id : null;
  const key = keyForUserId(userId);
  if (!key) return;

  try {
    localStorage.setItem(key, JSON.stringify(preferences));
  } catch {
    // ignore
  }
}

export { DEFAULT_PREFERENCES };

const SESSION_KEY = 'robotx_session';

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return { isAuthenticated: false, identity: '' };

    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.isAuthenticated === 'boolean') {
      return { isAuthenticated: !!parsed.isAuthenticated, identity: String(parsed.identity || '') };
    }
  } catch {
    // ignore
  }

  return { isAuthenticated: false, identity: '' };
}

export function saveSession(next) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

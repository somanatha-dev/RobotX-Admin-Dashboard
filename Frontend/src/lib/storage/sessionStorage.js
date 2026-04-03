const SESSION_KEY = 'robotx_session';

export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return { isAuthenticated: false, identity: '', user: null };

    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.isAuthenticated === 'boolean') {
      const user = parsed.user && typeof parsed.user === 'object' ? parsed.user : null;
      const normalizedUser = user
        ? {
            id: String(user.id || ''),
            email: String(user.email || ''),
            role: String(user.role || ''),
          }
        : null;

      const identity = String(parsed.identity || normalizedUser?.email || '');

      return {
        isAuthenticated: !!parsed.isAuthenticated,
        identity,
        user: normalizedUser,
      };
    }
  } catch {
    // ignore
  }

  return { isAuthenticated: false, identity: '', user: null };
}

export function saveSession(next) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

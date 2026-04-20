const SESSION_KEY = 'robotx_session';

const DEFAULT_SESSION = { isAuthenticated: false, identity: '', user: null };

// Session is cookie-based (httpOnly) now. We never read/write auth session to localStorage.
// These functions remain only for backwards compatibility with older code/branches.
export function loadSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
  return { ...DEFAULT_SESSION };
}

export function saveSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

export function clearStoredSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

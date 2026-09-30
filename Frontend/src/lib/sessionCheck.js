/**
 * FS-03 — what a failed session check (`GET /api/auth/me`) may be taken to mean.
 *
 * ── The backend contract (auth_middleware.authUser, auth_controller.getMe) ──
 *   · 401 `{ message: "Unauthorized" }` — no cookie, or a token that is invalid or expired;
 *   · 404 `{ message: "User not found" }` — the token names an account that no longer exists;
 *   · 200 `{ user }`.
 * Only the first two say there is no session. A network failure (fetch rejects, no status)
 * or a 5xx says the backend could not be asked — the session may be perfectly valid. The
 * provider used to treat every failure as "no session", so one sidebar click during a
 * backend restart sent a signed-in operator to the login page.
 */

export const SESSION_CHECK = Object.freeze({
  /** The backend answered: this cookie is not a session. Sign out. */
  NO_SESSION: 'no-session',
  /** The backend could not answer. Keep whatever session the page has, and ask again. */
  UNREACHABLE: 'unreachable',
});

/**
 * @param {unknown} error what `authApi.me()` rejected with (`requestJson` sets `status`)
 * @returns {string} one of SESSION_CHECK
 */
export function sessionCheckOutcome(error) {
  const status = error && typeof error === 'object' ? error.status : undefined;
  return status === 401 || status === 404 ? SESSION_CHECK.NO_SESSION : SESSION_CHECK.UNREACHABLE;
}

/** Delays between session checks while the backend is unreachable: 2 s, doubling, capped at 15 s. */
export function sessionRetryDelayMs(attempt) {
  const n = Math.max(0, Number(attempt) || 0);
  return Math.min(15_000, 2_000 * 2 ** n);
}

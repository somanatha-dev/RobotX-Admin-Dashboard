/**
 * FS-02 — what the dashboard may say about its own live connection.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Every robot card, marker and task phase on the page is the last value the backend pushed
 * over the dashboard socket. When that socket is down nothing new arrives, and nothing on
 * the page used to say so: measured, with the backend killed, the cards kept eight green
 * "online" dots and a fleet that looked live.
 *
 * ── What this describes, and what it does not ───────────────────────────────
 * This is the state of the **transport**, never of a robot. A reconnecting socket says
 * nothing about whether any robot is online — the backend decides that and reports it
 * (`robot_offline` / `robot_online`, or the refetch after reconnecting). So a disconnect
 * marks the page's data as *stale*, and changes no robot's status or liveness.
 */

export const CONNECTION = Object.freeze({
  /** No session, so no socket (it only exists while signed in). No banner. */
  IDLE: 'idle',
  /** First connection of this session is being opened. */
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  /** Was connected; the transport dropped and socket.io is retrying by itself. */
  RECONNECTING: 'reconnecting',
  /** Closed and not retrying (the server ended it). Only a reload reconnects. */
  DISCONNECTED: 'disconnected',
});

/**
 * The connection state, read off the socket's own flags.
 *
 * `socket.active` is true while connected *and* while socket.io is retrying a dropped
 * transport; it is false after a server-side or client-side disconnect, which socket.io
 * never retries.
 *
 * @param {{ connected?: boolean, active?: boolean }} socketFlags
 * @param {{ authenticated: boolean, everConnected: boolean }} session
 * @returns {string} one of CONNECTION
 */
export function connectionStateOf(socketFlags, { authenticated, everConnected }) {
  if (!authenticated) return CONNECTION.IDLE;
  if (socketFlags?.connected) return CONNECTION.CONNECTED;
  if (socketFlags?.active) return everConnected ? CONNECTION.RECONNECTING : CONNECTION.CONNECTING;
  return CONNECTION.DISCONNECTED;
}

function clock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * The banner for a connection state, or null when there is nothing to warn about.
 *
 * Only transport facts and their consequence for the page are stated: when live data
 * last arrived, and that what is shown may be out of date. No robot is called offline.
 *
 * @param {string} state one of CONNECTION
 * @param {number|null} lastLiveAtMs when the socket was last connected (ms since epoch)
 * @returns {{ kind: 'info'|'warning', title: string, message: string }|null}
 */
export function connectionBanner(state, lastLiveAtMs) {
  const since = clock(lastLiveAtMs);
  const stale =
    (since ? `Robot and task data shown is from ${since} or earlier` : 'Robot and task data shown may be out of date') +
    ' and is not updating. It is not evidence that any robot is online or offline.';

  switch (state) {
    case CONNECTION.CONNECTING:
      return {
        kind: 'info',
        title: 'Connecting to live updates…',
        message: 'Robot and task data will update once the live connection is open.',
      };
    case CONNECTION.RECONNECTING:
      return {
        kind: 'warning',
        title: 'Live connection lost — reconnecting',
        message: `${stale} The page refreshes everything from the backend when the connection returns.`,
      };
    case CONNECTION.DISCONNECTED:
      return {
        kind: 'warning',
        title: 'Live connection closed',
        // Reached only after the server ended the socket (it refused the session, twice
        // at most — see AppProvider's UNAUTHORIZED handling); socket.io does not retry that.
        message: `${stale} The server closed the connection and it is not retrying. Reload the page to reconnect.`,
      };
    default:
      return null;
  }
}

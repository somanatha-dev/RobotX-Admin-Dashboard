import { io } from "socket.io-client";

// `import.meta.env` is Vite's and is undefined under plain Node, which is how
// `src/__architecture__/` loads this module. Same guard as `api/httpClient.js`.
const VITE_ENV = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};
const SOCKET_URL = VITE_ENV.VITE_SOCKET_URL || "http://localhost:3000";
const GLOBAL_KEY = VITE_ENV.VITE_SOCKET_GLOBAL_KEY || "__robotx_socket__";

// Reuse the same socket across Vite Fast Refresh/HMR, so there is only ever one.
const existing = globalThis[GLOBAL_KEY];

// withCredentials so the HttpOnly `token` auth cookie (already sent with
// REST calls via credentials: 'include') is also sent on the socket
// handshake — the backend requires it to join the dashboard room.
//
// ── autoConnect: false — the socket's lifetime is the session's ────────────
// The backend answers a dashboard socket without a valid cookie with `UNAUTHORIZED` and
// a server-side disconnect, and socket.io never retries a server-side disconnect. A
// socket opened at import time — before anyone has logged in — was therefore rejected
// once and stayed dead for the rest of the page's life: the operator logged in, the
// engine assigned and settled tasks, and the dashboard showed none of it until a reload.
// So nothing connects here. `AppProvider` connects after a successful login or session
// restore, and disconnects on logout, through the two functions below.
export const socket = existing || io(SOCKET_URL, { withCredentials: true, autoConnect: false });

if (!existing) {
	globalThis[GLOBAL_KEY] = socket;
}

/**
 * Open the shared dashboard socket, if it is not already open or opening.
 *
 * Call only once the REST session is known to be valid: the handshake carries the auth
 * cookie as it is at this moment. `socket.active` is true while connected *and* while
 * socket.io is retrying a dropped transport, so a second call never opens a second
 * connection. It is false after a server-side disconnect, which is the one case that
 * needs a new call.
 *
 * @returns {boolean} whether a connection attempt was started
 */
export function connectDashboardSocket() {
	if (socket.active) return false;
	socket.connect();
	return true;
}

/**
 * Close the shared dashboard socket. It leaves the `dashboard` room with it, so no fleet
 * data reaches this page until the next `connectDashboardSocket()`.
 *
 * @returns {boolean} whether there was anything to close
 */
export function disconnectDashboardSocket() {
	if (!socket.active && !socket.connected) return false;
	socket.disconnect();
	return true;
}

/** The backend's refusal of a dashboard socket with no valid session (`socket.server.js`). */
export const SOCKET_UNAUTHORIZED = "UNAUTHORIZED";

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 15 — the dashboard's socket contract, in one place

   The backend cut over to the assignment engine, and the dashboard's contract
   changed with it. The events are enumerated here rather than spelled as string
   literals across four components, because the whole point of the change is that
   two of them no longer mean what their names suggest — and a name that lies is
   only safe if there is exactly one place to read what it actually means.

   ── What changed, and why the distinction is not pedantic ─────────────────
   The engine acknowledges at intake and *decides in a later round* (§3.4). So:

     • `task_accepted` — the honest event. The task was validated, admitted,
       deduplicated, routed to a shard and durably queued. It carries a queue
       position and a predicted assignment window. **No robot has been chosen.**

     • `task_assigned` — a compatibility echo, fired immediately after
       `task_accepted` for clients that have not migrated. Its payload still says
       `status: "PENDING"` and `robotId: null`, because that is the truth. Reading
       it as "a robot is on the way" is the exact conflation §3.4 forbids in the
       REST response, and it is no less wrong over a socket. It is retired after
       the retention window (docs/runbooks/cutover.md §5).

     • `TASK_ASSIGNED` (capitals) — unchanged, and genuinely means assigned. It is
       emitted when a route exists to draw, which is after a real decision.

   The dashboard therefore renders a *queued* card on `task_accepted` and a
   *routed* card on `TASK_ASSIGNED`, and ignores `task_assigned` entirely. That is
   the migration the execution plan's Phase 15 row asks for when it lists this file
   under "Frontend updated in the same window".
   ═══════════════════════════════════════════════════════════════════════════ */

/** Events the dashboard subscribes to, grouped by what they actually mean. */
export const DASHBOARD_EVENTS = Object.freeze({
	/** §3.4's intake acknowledgement. A queue position, not an assignment. */
	TASK_ACCEPTED: "task_accepted",
	/** A real assignment with a drawable route. */
	TASK_ASSIGNED: "TASK_ASSIGNED",
	/** Lifecycle updates for a task already known to the dashboard. */
	TASK_UPDATED: "TASK_UPDATED",
	TASK_CREATED: "TASK_CREATED",
	/** §11.2 — the agent answered an OFFER. Accept, reject, or defer. */
	OFFER_RESPONSE: "OFFER_RESPONSE",
	/** Intake refused the submission. Carries a code and an honest reason. */
	TASK_ERROR: "task_error",
	ROBOT_UPDATE: "robot:update",
	ROBOT_UPDATED: "ROBOT_UPDATED",
	/**
	 * A unit's **configuration** changed — its chassis family or one of the six
	 * specification values.
	 *
	 * Its own event, deliberately not folded into `ROBOT_UPDATE`. That one carries live
	 * telemetry at the tick rate and its consumers merge only the observed fields; a
	 * specification change is not a reading, and sending it down the telemetry channel
	 * would make a page that shows configuration re-render on every heartbeat.
	 */
	ROBOT_SPECIFICATION_UPDATED: "ROBOT_SPECIFICATION_UPDATED",
	ALERT_CREATED: "ALERT_CREATED",
	REROUTE_ALERT: "REROUTE_ALERT",
});

/**
 * Legacy events retained by the backend for unmigrated clients and retired after
 * the retention window. **The dashboard does not subscribe to these.**
 *
 * Exported so the list is greppable: when the backend removes them, this constant
 * is the search that proves nothing here depended on them.
 */
export const RETIRED_AFTER_RETENTION_WINDOW = Object.freeze([
	// A queued Leg reported as though it were assigned. Superseded by
	// `task_accepted` (queued) and `TASK_ASSIGNED` (actually assigned).
	"task_assigned",
	// The server→agent legacy dispatch events. Never dashboard-facing; listed so
	// the retirement set is complete in one place.
	"TASK_ASSIGN",
	"STOP",
]);

/**
 * The intake refusal the cutover introduced.
 *
 * After Phase 15 the legacy dispatcher is not in the build, so a shard whose engine
 * is not live has **no** decision path. Intake refuses rather than queueing work
 * nothing will drain, and says so with this code. The dashboard shows the refusal
 * instead of a spinner that would never resolve.
 */
export const ENGINE_NOT_LIVE = "ENGINE_NOT_LIVE";

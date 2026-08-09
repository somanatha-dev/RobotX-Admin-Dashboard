import { io } from "socket.io-client";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "http://localhost:3000";
const GLOBAL_KEY = import.meta.env.VITE_SOCKET_GLOBAL_KEY || "__robotx_socket__";

// Reuse the same socket across Vite Fast Refresh/HMR to avoid
// Connected → Disconnected → Connected spam during development.
const existing = globalThis[GLOBAL_KEY];

// withCredentials so the HttpOnly `token` auth cookie (already sent with
// REST calls via credentials: 'include') is also sent on the socket
// handshake — the backend now requires it to join the dashboard room.
export const socket = existing || io(SOCKET_URL, { withCredentials: true });

if (!existing) {
	globalThis[GLOBAL_KEY] = socket;
} else if (!socket.connected) {
	// If HMR restored a disconnected socket, reconnect it.
	socket.connect();
}

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

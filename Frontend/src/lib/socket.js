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

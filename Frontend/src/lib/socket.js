import { io } from "socket.io-client";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "http://localhost:3000";
const GLOBAL_KEY = import.meta.env.VITE_SOCKET_GLOBAL_KEY || "__robotx_socket__";

// Reuse the same socket across Vite Fast Refresh/HMR to avoid
// Connected → Disconnected → Connected spam during development.
const existing = globalThis[GLOBAL_KEY];

export const socket = existing || io(SOCKET_URL);

if (!existing) {
	globalThis[GLOBAL_KEY] = socket;
} else if (!socket.connected) {
	// If HMR restored a disconnected socket, reconnect it.
	socket.connect();
}

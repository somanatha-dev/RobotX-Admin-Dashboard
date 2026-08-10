# RobotX — Operator Dashboard

The realtime fleet-operations dashboard for RobotX. React 19 + Vite, talking to the backend over
REST and an authenticated Socket.IO connection.

For the system as a whole, see [`../ARCHITECTURE.md`](../ARCHITECTURE.md); for setup of both halves,
see [`../README.md`](../README.md).

> **Note on task creation.** The backend currently returns `503 ENGINE_NOT_LIVE` for
> `POST /api/tasks` — the legacy assignment engine has been retired and its replacement is not yet
> enabled. Task-creation flows in this UI will surface that error. This is expected; see
> [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §1.

## Running it

```bash
npm install
npm run dev      # Vite dev server
npm run build
npm run lint
```

Create `.env.local`:

```env
VITE_API_URL=http://localhost:3000
VITE_SOCKET_URL=http://localhost:3000
VITE_SOCKET_GLOBAL_KEY=__robotx_socket__
VITE_MAPBOX_TOKEN=YOUR_MAPBOX_TOKEN
# VITE_GOOGLE_CLIENT_ID=...
```

Vite reads env vars at startup — **restart the dev server after changing them.**

## Structure

```
src/
  main.jsx            Entry point
  App.jsx             Thin app shell
  app/RobotXApp.jsx   Provider + shell composition
  router/             AppRouter, layout, route titles
  pages/              Dashboard, Robots, RobotDetail, Map, Tasks, Commission, Profile, Login
  components/         UI primitives, layout, modals
  features/maps/      Mapbox campus and fleet rendering
  context/ hooks/     App state and extracted behaviours
  lib/
    socket.js         Socket.IO client — HMR-safe singleton
    api/              Backend REST client
    storage/          Session persistence
    mapboxMarkers.js  Marker element builder
    robotStatus.js    Status vocabulary shared with the backend
  config/             Map constants, location tree
```

## Two things worth knowing before you edit

**The socket client is a deliberate singleton.** `src/lib/socket.js` stores the connection on
`globalThis[VITE_SOCKET_GLOBAL_KEY]`. Without it, Vite Fast Refresh reloads the module on every
edit and produces a connect/disconnect loop. Always import from `lib/socket.js`; never construct a
client directly.

**Authentication is an HttpOnly cookie, not a token in JS.** The JWT is set by the backend and sent
automatically with both REST requests and the Socket.IO handshake. There is no token for frontend
code to read, store, or attach — requests need credentials enabled, nothing more.

## Stack

React 19 · Vite 8 · React Router · Tailwind CSS 4 · Radix UI · Mapbox GL · Recharts ·
Framer Motion · GSAP · Three.js · react-hook-form + Zod · `@simplewebauthn/browser` ·
`@react-oauth/google` · Socket.IO client

"# RobotX Admin Dashboard

RobotX is a realtime fleet-operations admin dashboard (Frontend) backed by a Socket.IO + Redis + Prisma service (Backend). It includes a robot telemetry simulator, live map views, fleet/task pages, and a refactored component-based React architecture.

This README documents what was implemented from the beginning of this workspace through the current state: backend runtime fixes, realtime telemetry wiring, Redis storage, env-var configuration, and the frontend refactor that removed the monolithic `App.jsx`.

## What’s in this repo

- `Backend/`
	- `server.js`: Express + Socket.IO server. Ingests telemetry, stores latest telemetry in Redis, emits realtime updates to dashboards, and writes tasks via Prisma.
	- `robot.js`: Socket.IO client simulator that emits telemetry periodically.
	- `prisma/`: Prisma schema + migrations (Postgres).
- `Frontend/`
	- Vite + React dashboard UI.
	- A stable Socket.IO client module (HMR-safe singleton) + extracted pages/components.

## Architecture (high level)

### Realtime data flow

1) **Robot / simulator** emits telemetry via Socket.IO:

- Event: `telemetry`
- Payload example:
	- `robotId`
	- `lat`, `lon`
	- `battery`

2) **Backend** receives telemetry and does two things:

- Stores the latest snapshot in Redis under `robot:<robotId>`
- Broadcasts the same snapshot to all connected frontends:
	- Event: `robot_update`

3) **Frontend** listens for `robot_update` and updates robot state live.

### Task flow (Socket.IO → Prisma)

- Admin emits: `assign_task`
- Backend writes: `prisma.task.create({ data: task })`
- Backend broadcasts: `task_assigned`

Note: Prisma schema relates `Task.robotId` to `Robot.robotId`. If your database enforces foreign keys, you must ensure a matching `Robot` record exists before inserting a `Task`.

## Key work completed (detailed)

### Backend work

1) **Runtime dependency fix**
- The robot simulator (`Backend/robot.js`) is a Socket.IO client.
- The backend package originally didn’t include the Socket.IO client dependency, which caused runtime failures when running the simulator.
- Added/installed `socket.io-client` in `Backend/package.json` so the simulator can emit telemetry.

2) **Socket.IO event pipeline**
- Implemented/confirmed a minimal, reliable telemetry handler in `Backend/server.js`:
	- `redis.set(`robot:${data.robotId}`, JSON.stringify(data))`
	- `io.emit('robot_update', data)`

3) **Redis lifecycle visibility**
- Added Redis connection lifecycle logs (`connect`, `ready`, `error`, `close`) to make it obvious whether Redis is reachable.

4) **Prisma integration**
- Prisma client initialized in `Backend/server.js`.
- `assign_task` handler persists tasks into Postgres via Prisma.

### Frontend work

1) **Realtime telemetry consumption**
- Wired a Socket.IO client to receive `robot_update` events and update robot state in realtime (used in the map/fleet experience).

2) **HMR-safe Socket.IO client**
- During Vite Fast Refresh/HMR, multiple module reloads can cause repeated connect/disconnect loops.
- Implemented a singleton socket pattern in `Frontend/src/lib/socket.js` by storing the socket on `globalThis[<key>]`.
- This prevents “Connected → Disconnected → Connected…” spam and stabilizes dev experience.

3) **Vite env migration + fixes**
- Standardized frontend configuration to use Vite-exposed env vars (`VITE_*`).
- Socket config:
	- `VITE_SOCKET_URL`
	- `VITE_SOCKET_GLOBAL_KEY`
- Mapbox config:
	- `VITE_MAPBOX_TOKEN`
	- Optional: `VITE_USE_LEGACY_EMBEDDED_MAP` (used by the map page)

4) **Major refactor: remove monolithic App**

Goal: "App.jsx should not contain logic" and the UI should be component-based.

Completed refactor outcomes:

- `Frontend/src/App.jsx` is now a thin wrapper only rendering the app shell.
- App logic lives in `Frontend/src/app/RobotXApp.jsx`, with UI layout and route rendering split into small modules under `Frontend/src/app/layout/` and `Frontend/src/app/routing/`.
- Extracted UI building blocks into:
	- `Frontend/src/components/`
	- `Frontend/src/components/layout/`
	- `Frontend/src/components/modals/`
- Extracted route/page components into:
	- `Frontend/src/pages/`

5) **Removed redundant “re-export only” file**
- Deleted `Frontend/src/socket.js` (it was only re-exporting from `src/lib/socket.js`).

6) **Helper extraction to reduce duplication**
- Moved common geo/math helpers into `Frontend/src/lib/geo.js`.
- Moved Mapbox marker DOM builder into `Frontend/src/lib/mapboxMarkers.js`.
- Extracted session persistence into `Frontend/src/lib/storage/sessionStorage.js`.
- Extracted the “Decision Required” popup into `Frontend/src/components/modals/DecisionRequiredModal.jsx`.

## Frontend folder structure (current)

- `Frontend/src/app/`
	- `RobotXApp.jsx`: app entry (wraps Provider + Shell)
	- `context/`: React Context (state/actions) + hooks
		- `appContext.js`
	- `providers/`: top-level providers
		- `AppProvider.jsx`
	- `shell/`: app composition (Sidebar/TopBar/Content + global modals)
		- `AppShell.jsx`
	- `hooks/`: extracted app behaviors (effects)
		- `useRobotSimulator.js`
		- `useDecisionCountdown.js`
		- `useNotificationsDismiss.js`
	- `layout/`: navigation + top bar + notifications UI
		- `AppSidebar.jsx`
		- `AppTopBar.jsx`
		- `NotificationsMenu.jsx`
	- `routing/`: route helpers + page rendering
		- `routes.js`: route/title helpers
		- `AppContent.jsx`: renders the active page
- `Frontend/src/config/`
	- `mapConfig.js`: map constants and location tree
- `Frontend/src/mocks/`
	- `mockData.js`: initial mock robot/task data
- `Frontend/src/pages/`
	- `DashboardPage.jsx`, `RobotsPage.jsx`, `MapPage.jsx`, `TasksPage.jsx`, `ProfilePage.jsx`, `RobotDetailPage.jsx`, `LoginPage.jsx`
- `Frontend/src/components/`
	- UI primitives used by pages (e.g. metric cards, health rows)
- `Frontend/src/components/modals/`
	- Auth/commission/task/decision modals
- `Frontend/src/lib/`
	- `socket.js`: Socket.IO singleton client
	- `geo.js`: reusable geometry helpers
	- `mapboxMarkers.js`: marker element builder
	- `storage/sessionStorage.js`: `loadSession()` / `saveSession()`
- `Frontend/src/features/`
	- Maps and campus rendering modules

## Setup & run (Windows / local dev)

### Prerequisites

- Node.js (LTS recommended)
- Redis running locally on `127.0.0.1:6379`
- Postgres database (for Prisma) if you plan to use task persistence

### 1) Backend install

From the repo root:

```bash
cd Backend
npm install
```

### 2) Configure database (Prisma)

Prisma expects `DATABASE_URL` for Postgres (see `Backend/prisma/schema.prisma`). Create `Backend/.env`:

```env
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/robotx?schema=public"
```

Then run migrations (optional but recommended if using tasks):

```bash
cd Backend
npx prisma migrate dev
```

### 3) Start backend server

```bash
cd Backend
node server.js
```

Backend listens on `http://localhost:3000`.

### 4) Start robot telemetry simulator

In a second terminal:

```bash
cd Backend
node robot.js
```

This emits `telemetry` every ~2 seconds.

### 5) Frontend install + run

```bash
cd Frontend
npm install
npm run dev
```

Vite dev server starts (see its terminal output for the URL).

## Frontend environment variables

Create `Frontend/.env.local` (not committed) if you need to override defaults:

```env
VITE_SOCKET_URL=http://localhost:3000
VITE_SOCKET_GLOBAL_KEY=__robotx_socket__

# Required for Mapbox-powered views
VITE_MAPBOX_TOKEN=YOUR_MAPBOX_TOKEN

# Optional: keep legacy map mode available
VITE_USE_LEGACY_EMBEDDED_MAP=false
```

Important: after changing env vars, restart `npm run dev`.

## Useful commands

Frontend:

```bash
cd Frontend
npm run lint
npm run build
```

Backend:

```bash
cd Backend
node server.js
node robot.js
```

## Troubleshooting

### Socket connects/disconnects repeatedly during development

- The frontend socket client uses a global singleton to avoid HMR reconnect churn.
- Verify you are importing the socket from `Frontend/src/lib/socket.js`.

### No map / Mapbox errors

- Ensure `VITE_MAPBOX_TOKEN` is set and the dev server was restarted.

### Telemetry not updating

- Confirm backend is running on port 3000.
- Confirm Redis is running on `127.0.0.1:6379`.
- Run the simulator (`node robot.js`) and watch the backend logs.

### Prisma task insert fails

- Ensure `DATABASE_URL` is set and migrations are applied.
- Ensure the referenced `Robot` exists if your DB enforces the `Task.robotId → Robot.robotId` relation.
" 

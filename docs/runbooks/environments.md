# RobotX environments

One repository, one application, **two environments**. Every environment runs the same code;
environment variables alone choose the database, the endpoints, the shard and the fleet. There
is no development-only code path, and none may be added.

## 1. The two environments

| | **LOCAL** | **ORIGINAL ROBOTX NEON** |
|---|---|---|
| Purpose | development, testing, robot integration, demonstrations | the authoritative cloud database behind the official deployment |
| Database | Docker container `robotx-recovered-db` (PostgreSQL 17.11), **`127.0.0.1:5433`**, database **`robotx`** | the original RobotX Neon project, database `neondb` (PostgreSQL 17.11) |
| Data | a verified copy of `neondb` (snapshot 2026-10-09 13:09:58 UTC), developed against since | live |
| Backend | `node server.js` at `http://localhost:3000`, loopback only | Render |
| Frontend | Vite at `http://localhost:5173` | Vercel |
| Configuration | `%USERPROFILE%\robotx-secrets\robotx-local.env` — **outside the repository and OneDrive** | the Render and Vercel dashboards |
| `SHARD_ID` | `rnsit-shard` (the world copied from Neon; the lease row lives in `robotx`) | `rnsit-shard` |
| Engine / simulator | on / on | as configured on Render |
| Physical fleet | **off** | as configured on Render |
| Redis | off (in-memory KV, single process) | as configured on Render |
| Identity | `ROBOTX_ENV=LOCAL` | `ROBOTX_ENV` unset |

### Rules

- **LOCAL never connects to Neon.** With `ROBOTX_ENV=LOCAL` the backend refuses to start (exit 78)
  unless `DATABASE_URL` and `REDIS_URL` name loopback hosts (§2.2). There is no fallback: if the
  local database is unavailable, the backend fails.
- **No credential is ever committed or placed in OneDrive.** The repository holds templates
  (`*.env.example`) and the loopback-only benchmark profile (`Backend/.env.benchmark`) only.
  The LOCAL file and every cloud credential live in `%USERPROFILE%\robotx-secrets\`, readable
  by the owner's Windows account (and SYSTEM) only.
- **Original Neon changes only deliberately** — through reviewed Prisma migrations (§5.3) and a
  separate, reviewed data-publishing process (§5.4). Restoring a local database over Neon is
  **never** the publishing workflow.
- **RobotX-2** (a second Neon project, initialised on 2026-10-08) is **not** an environment: the
  deployment never used it. It is preserved and untouched (§7).

## 2. Configuration

### 2.1 Which file the backend loads

`Backend/src/config/env.js` loads one file, the first that applies:

1. `ROBOTX_ENV_FILE`, when set — an explicit path; a missing file is an error, never a fallback.
2. `Backend/.env`, when present — the historical location, still used by older worktrees.
   **It must not exist in the main checkout** (it would be synced by OneDrive).
3. `%USERPROFILE%\robotx-secrets\robotx-local.env` — the LOCAL file.

dotenv never overrides a variable already set in the process environment, so a process-level
variable wins over the file. That is why the guard checks the *final* values. A deployment has
none of these files and sets everything in its dashboard.

The boot log names the file and the target, never a value:

```
[env] LOCAL: database 127.0.0.1:5433/robotx, Redis off; configuration from C:\Users\…\robotx-secrets\robotx-local.env
```

### 2.2 The LOCAL guard

`Backend/src/config/environmentGuard.js`, called by `server.js` before anything connects and by
`tools/env/withLocalEnv.js`. When `ROBOTX_ENV=LOCAL`:

- `DATABASE_URL` must be set and point at `localhost`, `127.0.0.1` or `::1`;
- `REDIS_URL`, if set at all, must be loopback (it feeds both the KV and the Socket.IO adapter);
- any other `ROBOTX_ENV` value is refused — including an **empty** one: a process-level
  `ROBOTX_ENV=` would otherwise switch the guard off while the LOCAL file still loaded its database.

A refusal names the variable and the kind of host, never the URL. Without `ROBOTX_ENV` (absent,
not empty) the guard does nothing, so Render, the test suite and the disposable-cluster tools are
unaffected.

Two more guards for scripts that write (same module):

- `requireLocalTarget` — LOCAL-only writers (`prisma/seed.js`, `prisma/seed-pin.js`): an absent
  `ROBOTX_ENV` is a refusal, and the database must be loopback.
- `requireDisposableTarget` — tools that destroy data in a database of their own (the benchmark's
  `TRUNCATE`, `benchmark/orchestrator.js`): loopback, and never the database the LOCAL file names.

### 2.3 Which variable selects what

| Concern | Variable(s) | Read by |
|---|---|---|
| Environment identity | `ROBOTX_ENV`, `ROBOTX_ENV_FILE` | `src/config/environmentGuard.js`, `src/config/env.js` |
| Backend port / bind address | `PORT` (default 3000), `HOST` (default `0.0.0.0`) | `server.js` |
| Database | `DATABASE_URL` | `prisma/schema.prisma`, `src/db/prisma.js`, the Prisma CLI |
| Browser origin (CORS, Socket.IO, passkeys) | `FRONTEND_URL`, `NODE_ENV` | `src/config/cors.js` |
| Auth cookie | `NODE_ENV`, `COOKIE_SECURE`, `COOKIE_SAMESITE` | `src/controllers/auth_controller.js` |
| Redis / KV / Socket.IO adapter | `REDIS_ENABLED`, `REDIS_URL` | `src/cache/kv.js`, `server.js` |
| Engine | `ENGINE_ENABLED`, `SHARD_ID`, `SHARD_CONSENSUS_REPLICATION`, `COMMAND_SIGNING_KEY`, `VERIFY_*`, `PRIVACY_*` | `server.js` boot checks |
| Simulator | `ENABLE_VIRTUAL_SIMULATOR`, `V1_DEMONSTRATION_COMPOSITION` | `src/simulation/simulationPolicy.js`, `src/services/v1DemonstrationComposition.js` |
| Physical fleet | `PHYSICAL_FLEET_ENABLED`, `PHYSICAL_FLEET_DECLARATION_FILE`, `AGENT_PROBE_INTERVAL_MS` | `src/services/fleetProviders/`, `src/services/agentProbe.service.js` |
| Admin bootstrap | `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `DEFAULT_ADMIN_PIN` | `src/services/adminBootstrap.service.js` |
| Frontend → backend | `VITE_API_URL`, `VITE_SOCKET_URL` (both fall back to `http://localhost:3000`) | `Frontend/src/lib/api/httpClient.js`, `Frontend/src/lib/socket.js` |

`Frontend/.env` holds only values that are compiled into the browser bundle and are public by
design (API URLs, the Mapbox *public* token, the Google OAuth client id, the socket singleton's
property name). It is gitignored and may stay in the repository folder.

## 3. LOCAL

### 3.1 Prerequisites

- **Docker Desktop running, and the container `robotx-recovered-db` up.** Its restart policy is
  `unless-stopped`, so it starts with Docker Desktop. Check: `docker ps --filter name=robotx-recovered-db`.
- `%USERPROFILE%\robotx-secrets\robotx-local.env` present. It is never in the repository; on a new
  machine, start from `Backend/.env.example` and keep the result in that folder.
- Node.js 20; `npm install` in `Backend/` and `Frontend/`.

### 3.2 Start

```powershell
cd Backend;  npm run dev       # http://localhost:3000 — reads robotx-local.env
cd Frontend; npm run dev       # http://localhost:5173
```

Open `http://localhost:5173` — **`localhost`, not `127.0.0.1`**: the auth cookie is set for
`localhost`, and mixing the two names makes requests cross-site, so the browser drops it.

Run **one** engine-enabled backend against `robotx` at a time: it takes the `rnsit-shard` lease.
Stop it with Ctrl+C before starting another.

### 3.3 Log in

Use an existing account from the copied data, with its Neon password. Nothing is seeded: the
`SEED_ADMIN_*` variables stay **blank**, because `ensureAdminUser` would upsert — and overwrite
the password of — a copied user. Passkeys are bound to the deployment's site and do not work on
`localhost`.

### 3.4 Verify

- Boot log: the `[env] LOCAL: database 127.0.0.1:5433/robotx …` line, `Redis disabled via
  REDIS_ENABLED=false`, then `Leadership acquired — LEADER_ONLY workers started`.
- `curl "http://localhost:3000/health?shard=rnsit-shard"` → `db: ok`, shard `ACTIVE`, `led`, `leaseValid`.
- The backend has no connection outside loopback:
  `Get-NetTCPConnection -OwningProcess <node pid> -State Established` shows only `127.0.0.1:5433`.
- Inside the container, its sessions are on `robotx` with `application_name` `robotx-local`.

### 3.5 Prisma CLI

The Prisma CLI only looks for `Backend/.env`, which no longer exists in the main checkout, so a
bare `npx prisma …` fails with *Environment variable not found: DATABASE_URL* — it cannot fall
back to anything. Run it through the LOCAL configuration and guard:

```powershell
cd Backend
npm run prisma:local -- migrate status
```

The wrapper runs only the Prisma CLI, without a shell, and only an allow-list of commands
(`tools/env/prismaCommandPolicy.js`), checked before any configuration loads:

| Allowed | Notes |
|---|---|
| `migrate status`, `migrate diff` (no shadow database), `validate`, `format`, `generate`, `version`, `--help`, `db pull --print` | read-only, or touch only local files |
| `migrate deploy --confirm-database robotx` | applies reviewed pending migrations; the name must match the target, and is not passed to Prisma |

Everything else is refused (exit 77), in any spelling or argument order: `migrate reset`,
`migrate dev`, `migrate resolve`, `db push` (the schema file lacks the migrations' triggers, CHECK
constraints and partial index), `db execute`, `db seed`, `db pull` without `--print`, `studio`.
`prisma/seed.js` and `prisma/seed-pin.js` refuse to run outside LOCAL; do not run them against
`robotx` either (`seed.js` upserts the seed world; `seed-pin.js` overwrites every user's PIN).

### 3.6 Tests and tools

- `npm test` is isolated by itself: `Backend/tests/setup/env.js` names an empty, tracked
  configuration file (`tests/fixtures/environment/isolated-test.dotenv`) and an unreachable
  `DATABASE_URL` (loopback port 1), and `src/config/envFile.js` never falls back to `Backend/.env`
  or the LOCAL file in a `NODE_ENV=test` process. A Prisma client a test forgot to mock fails at
  once instead of reaching `robotx` (`tests/unit/config/testIsolation.test.js`). No override needed.
- `tools/demo/seedV1Demonstration.js`, `tools/demo/startV1Server.js` and the `tools/verify/*`
  live-database scripts accept only **throwaway** loopback clusters (see
  `docs/runbooks/v1-demonstration-assignment.md` §4). They are not for `robotx`.

## 4. ORIGINAL ROBOTX NEON (the deployment)

- **Render (backend)** connects to the original `neondb`. This was verified from the database
  side, not assumed: its `ShardLeadership` row for `rnsit-shard` is held and released by the
  Render service's instances. Render's variables are set in its dashboard (names as in §2.3,
  with `NODE_ENV=production`, `COOKIE_SAMESITE=none`, `COOKIE_SECURE=true`); none are in the
  repository.
- **Vercel (frontend)** sets `VITE_API_URL` and `VITE_SOCKET_URL` to the Render backend. If either
  is missing, the bundle silently falls back to `http://localhost:3000`, so keep both set.
- The Render service hibernates when idle. **A request to it (including `/health`) wakes it, and
  its engine resumes writing to Neon** — check it deliberately, as part of a deployment.
- No connection string appears in this repository or its documentation. The owner keeps the
  original-Neon credential in `%USERPROFILE%\robotx-secrets\`; it is used only for deliberate,
  approved, read-only snapshots and reviewed promotions.

## 5. Workflow

1. **Develop and test locally** against Docker `robotx`.
2. **Review and validate** code and database changes.
3. **Promote reviewed schema changes with Prisma migrations.** Write each migration by hand
   (`prisma migrate diff`, then review); apply it locally with
   `npm run prisma:local -- migrate deploy --confirm-database robotx`;
   keep it backward-compatible with the code Render is still running. Apply it to Neon only with
   approval, from a clean `git archive` export of the reviewed commit, after a fresh verified
   snapshot of Neon.
   **`prisma migrate deploy` applies pending migrations. It does not synchronise application
   data**, and it never copies rows between databases.
4. **Publish application-data changes separately and safely** — through the deployed application
   (its API or dashboard) or the repository's idempotent tools (for example
   `tools/deploy/bootstrapV1Environment.js`: dry run, apply, dry run), or a reviewed changeset with
   per-row preconditions. Runtime engine state, the audit hash chain, sessions, credentials and
   sealed identity records are never copied between environments. *This mechanism is not
   implemented yet.*
5. **Push approved code** to Git and let the configured deployment run.
6. **Verify the deployment and its actual database target** — from the Neon side (the
   `rnsit-shard` lease holder and fence) and the deployment's health — rather than assuming it.

**Never restore a local database over original Neon** as a way of publishing.

## 6. Refreshing LOCAL from Neon (manual, with approval)

Not automated. The procedure used on 2026-10-09:

1. Take a read-only, snapshot-consistent `pg_dump -Fc` of `neondb` (an exported snapshot shared by
   the dump and a verification manifest), with SHA-256 and `pg_restore --list`, stored under
   `%USERPROFILE%\robotx-backups\`.
2. Restore it into a **new** database in the Docker instance with `--no-owner --no-acl
   --single-transaction --exit-on-error`. Only the Neon-managed `pg_session_jwt` extension (and
   its `auth` functions) cannot be restored; nothing in the application uses it.
3. Verify every table's row count and content hash, the migration history and the schema against
   the snapshot's manifest.
4. Point the LOCAL file at the new database. Never drop or overwrite the previous one without
   explicit approval.

## 7. Preserved historical resources (not environments)

| Resource | What it is |
|---|---|
| Docker `robotx_recovered` | frozen historical data, read-only. Its viewer stack (`:3001` / `:5174`) was retired on 2026-10-09 |
| Docker `robotx_demo` | the 2026-10-09 demo clone, no longer running. Its stack (`:3002` / `:5175`) was retired on 2026-10-09 |
| `%USERPROFILE%\robotx-backups\retired-envs-2026-10-09\` | the retired stacks' launch kit and override files, with `RESTORE.md` |
| Windows PostgreSQL `:5432` `robotx_recovered` | pristine restore of the 2026-10-09 04:06 UTC dump |
| Windows PostgreSQL `:5432` `robotx_local`, `robot_system` | earlier local development databases |
| `%USERPROFILE%\robotx-backups\` | verified dumps, manifests and configuration backups |
| RobotX-2 Neon project | initialised, never used by the deployment; untouched |

They are kept as fallbacks and history. Do not develop against them, and do not delete them
without the owner's approval.

## 8. Known application issues (inherited, not fixed)

- **Invariant I2 — VIOLATED (2).** The lease audit flags two legs of tasks assigned on 2026-10-02
  whose commitments expired; the same state exists in Neon.
- **Invariant I15 — VIOLATED.** No `DecisionRecordA` row records `versions.configVersion`, so
  the check fails whenever the window contains decisions; it reads as enforced only when the
  window is empty. Render's own run on Neon reports the same. This is an application defect, not
  an environment one.

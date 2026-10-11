# RobotX

A fleet command-and-control backend for autonomous delivery robots, with a realtime operator
dashboard.

RobotX commissions and authenticates robots, ingests their telemetry in real time, handles obstacle
reports and rerouting, and streams the whole picture to an operator dashboard. It is mid-way
through replacing its task-assignment engine.

---

## ⚠️ Current status — read this before anything else

**Task assignment does not currently work, and that is deliberate.**

| | |
|---|---|
| **Legacy DTARO assignment engine** | **Deleted.** Removed from the build by Phase 15, not merely bypassed. A build gate fails if it returns |
| **Next-generation assignment engine** | **Built and tested — 196 modules — but not deciding.** `ENGINE_ENABLED` defaults to `false`, and the coordinator's round loop **refuses to compose**: 26 of its 34 declared inputs are unresolved |
| **`POST /api/tasks/assign`** | Returns **`503 ENGINE_NOT_LIVE`** |
| **Phase 15** (verification, gates, cutover) | **BLOCKED** |
| **Phase 16** (Tier 2 enablement) | **NOT READY — must not begin** |
| **B1** (routing engine selection) | **BLOCKED** behind the region definition (D1), which awaits an operations/commercial decision |

**Everything else runs.** Robot authentication, telemetry ingestion, the live dashboard feed,
obstacle handling and rerouting, the simulator, and the operator API are all live and working.

A 503 naming the state is deliberate: with the legacy dispatcher out of the build, accepting a task
for a shard whose coordinator is not running would durably record work that no component is
responsible for deciding — the exact defect the new architecture exists to eliminate.

**Full detail: [`ARCHITECTURE.md`](ARCHITECTURE.md).**

---

## Documentation map

Read these in this order depending on what you need.

| Document | What it is |
|---|---|
| **[`ARCHITECTURE.md`](ARCHITECTURE.md)** | **Start here.** What RobotX is *today* — the live host platform, the engine's real status, the database and Redis architecture, every end-to-end workflow, a traceability matrix, known gaps, and a source-of-truth map |
| **[`ROBOTX_SYSTEM_HANDBOOK.md`](ROBOTX_SYSTEM_HANDBOOK.md)** | **Read second.** The practical companion: mental models, how each subsystem works in plain language, debugging, testing, the benchmark story, and interview/presentation material |
| [`NEXT_GENERATION_ASSIGNMENT_ENGINE.md`](NEXT_GENERATION_ASSIGNMENT_ENGINE.md) | **The frozen architecture.** Architectural authority. Where anything disagrees with it, the other thing is defective |
| [`docs/adr/`](docs/adr/) | **40 architecture decision records** — the 38 frozen Appendix C decisions, plus **ADR-33** and **ADR-34**, integration decisions numbered from 33 upward. Each fixes one decision's identity **and its rejected alternative** |
| [`IMPLEMENTATION_EXECUTION_PLAN.md`](IMPLEMENTATION_EXECUTION_PLAN.md) | The plan of record: 16 phases, capability inventory, blocking decisions, release gates |
| **[`docs/phase15/PHASE_15_MASTER.md`](docs/phase15/PHASE_15_MASTER.md)** | **Current Phase 15 status — the source of truth.** What is implemented, what is verified, what is blocked and why. Superseded Phase 15 reports are in [`docs/phase15/archive/`](docs/phase15/archive/) and are historical evidence only |
| [`docs/runbooks/`](docs/runbooks/) | [`cutover.md`](docs/runbooks/cutover.md) and [`rollback.md`](docs/runbooks/rollback.md). **Read rollback first** |
| [`docs/safety-case/SAFETY_CASE.md`](docs/safety-case/SAFETY_CASE.md) | Generated safety case — `npm run safety:case`. Do not hand-edit |
| [`Backend/src/engine/ARCHITECTURE.md`](Backend/src/engine/ARCHITECTURE.md) · [`TIERS.md`](Backend/src/engine/TIERS.md) | Engine module map and obligation tiers |
| `PHASE_*_IMPLEMENTATION_REPORT.md` · `PHASE_*_INDEPENDENT_VERIFICATION.md` | Historical engineering evidence, one pair per phase — **except Phase 0, which has an implementation report but was never independently verified** (see note below). **Phase 15's reports are not at the root**: they were consolidated into [`docs/phase15/`](docs/phase15/) on 2026-08-29 |
| [`docs/history/`](docs/history/) | **Superseded documentation.** Describes deleted systems — not current authority |

> **Two of these are build dependencies.** Four tests read `NEXT_GENERATION_ASSIGNMENT_ENGINE.md`
> and `docs/adr/**` from disk and assert against their contents; three more read `TIERS.md`.
> Moving, renaming, or reformatting them breaks the build.

> **Phase 0 was never independently verified.** `PHASE_0_IMPLEMENTATION_REPORT.md` exists;
> `PHASE_0_INDEPENDENT_VERIFICATION.md` does not, and never did. Phases 1–15 each have both.
> This was first raised as issue 5 of `PHASE_4_INDEPENDENT_VERIFICATION.md` and is recorded here
> rather than closed, because the honest options were to write a retrospective review of a phase
> whose working tree no longer exists — which would be a fabricated artefact, not evidence — or to
> say plainly that the review did not happen. Phase 0's scaffolding is nonetheless exercised
> continuously: its tests run in every later phase's suite, and the tier, parameter and tenet gates
> it introduced now govern 183–277 modules on every `npm run verify`. Treat Phase 0's *report* as
> an implementer's claim that no independent reviewer has ever checked.

---

## Repository structure

```
Backend/
  server.js              Process wiring, Socket.IO adapter, graceful shutdown
  src/
    app.js               Express pipeline: helmet → CORS → JSON/cookies → logging → /api
    routes/              13 route groups mounted under /api
    controllers/         HTTP handlers
    services/            18 transport-agnostic service modules
    sockets/             Socket.IO server, 5 handlers, per-event rate limiting
    cache/kv.js          The sole Redis facade — pipelining, fail-closed locks, fallback
    db/                  Prisma client
    engine/              Next-generation assignment engine — 196 modules, NOT DECIDING
    workers/             19 registered workers — 9 run at boot, 3 more on leadership,
                         1 refuses (B1), 6 deferred with declared blockers
    simulation/          VirtualRobot + SimulationEngine
    middlewares/         auth, rate limiting, error handling
    config/              env, logger, CORS, constants
  prisma/                Schema, migrations, seed
  tests/                 5 Jest projects: legacy, gates, engine, chaos, scale
  tools/                 Build gates, routing benchmark, replay, safety case, soak
  benchmark/             Load harness + historical results (legacy monolith)
Frontend/                Vite + React 19 operator dashboard
docs/                    ADRs, runbooks, safety case, historical documentation
formal/                  TLA+ specifications and configurations
```

---

## Development setup

There are **two environments**, and the same code runs in both; environment variables alone
select the database, endpoints, shard and fleet. **[`docs/runbooks/environments.md`](docs/runbooks/environments.md)**
is the full reference.

| | LOCAL | ORIGINAL ROBOTX NEON |
|---|---|---|
| Database | Docker container `robotx-recovered-db`, `127.0.0.1:5433`, database `robotx` — a verified copy of `neondb` | the original Neon `neondb` |
| Backend / frontend | `localhost:3000` / `localhost:5173` | Render / Vercel |
| Configuration | `%USERPROFILE%\robotx-secrets\robotx-local.env` (outside the repository and OneDrive) | Render and Vercel dashboards |

```
Browser → localhost:5173 (Vite) → localhost:3000 (backend) → Docker PostgreSQL 127.0.0.1:5433/robotx
```

### Prerequisites

- **Node.js 20** (what CI runs)
- **Docker Desktop running, with the container `robotx-recovered-db` up** (it starts with Docker
  Desktop; check with `docker ps --filter name=robotx-recovered-db`)
- **`%USERPROFILE%\robotx-secrets\robotx-local.env`** — the LOCAL backend configuration. It holds
  local secrets, so it never lives in the repository or OneDrive; on a new machine, start from
  `Backend/.env.example`. It declares `ROBOTX_ENV=LOCAL`, which makes the backend **refuse to
  start** unless its database and Redis are on loopback — local work can never reach Neon.

### Start

```powershell
cd Backend;  npm install; npm run dev    # http://localhost:3000
cd Frontend; npm install; npm run dev    # http://localhost:5173
```

Open `http://localhost:5173` — `localhost`, not `127.0.0.1`, or the auth cookie is dropped as
cross-site. Log in with an existing account from the copied data; nothing is seeded (the
`SEED_ADMIN_*` variables stay blank so a copied user is never overwritten). Check the backend
with `curl "http://localhost:3000/health?shard=rnsit-shard"`; its boot log names the database it
uses (`[env] LOCAL: database 127.0.0.1:5433/robotx …`). Run one engine-enabled backend at a time.

The Prisma CLI goes through the same configuration and guard:

```powershell
cd Backend; npm run prisma:local -- migrate status
```

The wrapper refuses (exit 77) anything outside a read-only allow-list — `prisma db push` (the
schema file lacks the migrations' triggers and CHECK constraints), `migrate dev`, `migrate reset`,
`db execute`, `db seed`, `studio` — and admits `migrate deploy` only after review, as
`migrate deploy --confirm-database robotx`. `prisma migrate deploy` applies pending migrations; **it does not synchronise
application data**. Schema promotion and data publishing to Neon are separate, reviewed steps —
see the workflow in [`docs/runbooks/environments.md`](docs/runbooks/environments.md) §5.

> **Scripted V1 demonstration.** `tools/demo/seedV1Demonstration.js` and
> `tools/demo/startV1Server.js` run the scripted acceptance scenario against a *throwaway*
> loopback cluster, and refuse port 5432 by design. See
> `docs/runbooks/v1-demonstration-assignment.md` §4.

`Frontend/.env` holds only browser-public values (API URLs, the Mapbox public token, the Google
OAuth client id); a deployment sets the same `VITE_*` names in its host's dashboard. Restart the
dev server after changing them — Vite reads them at startup.

Older databases (including Docker `robotx_recovered` and `robotx_demo`, whose `:3001`/`:3002` stacks
were retired and archived) and the backups are preserved history, not environments
(environments.md §7).

---

## Verification

The build gates run **first and independently of the tests**, deliberately: a tier-dependency
violation or an unregistered behavioural constant is a structural defect that no amount of passing
tests makes acceptable.

```bash
cd Backend

npm run gates          # all eight build gates — EXITS 1 today, see the note below
npm test               # full suite — isolated by tests/setup/env.js: never loads a real config file or reaches a real database
npm run verify         # gates + tests

# Individual gates
npm run gate:tiers       # §1.8 rule 2 — no Tier 0/1 module may depend on a Tier 2 mechanism
npm run gate:params      # §22 — no behavioural constant outside the parameter register
npm run gate:tenets      # T1 type separation, T6 no wall-clock read in the decision path
npm run gate:privacy     # §23.7 — identity isolation
npm run gate:erasure     # replay equivalence over an erased corpus
npm run gate:legacy      # the four retired modules stay retired
npm run gate:columngen   # §21.6 — a column-generation change must carry an evaluator run
npm run gate:composition # Phase 15 — every registered worker reaches production scheduling

# Test projects
npm run test:engine
npm run test:gates     # gate self-tests: plant violations, assert each gate reports them
npm run test:chaos
npm run test:scale

# Tooling
npm run routing:readiness   # B1 readiness gate — reports BLOCKED, and EXITS 0 by design
npm run release:verdict     # the §24 release-gate table — currently BLOCKED, exits 1
npm run gate:calibration    # §22.4 — currently FAIL at 39 Safety-class findings
npm run sim:fidelity        # §24.4 — currently 7 models NOT_MEASURED, exits 1
npm run safety:case         # regenerate docs/safety-case/SAFETY_CASE.md
```

> **`npm run gates` and `npm run verify` exit 1 on the current tree, and that is the correct
> result.** Seven build gates pass; the eighth, `gate:composition`, fails because no routing engine
> has been selected — execution-plan item **B1**, an external decision no commit here closes. CI
> does **not** run `gate:composition`, so CI is green while this gate is RED. Do not read a green
> CI as a green build-gate set, and do not "fix" the gate. Current state, blockers and the exact
> next action: **[`docs/phase15/PHASE_15_MASTER.md`](docs/phase15/PHASE_15_MASTER.md)**.

Frontend:

```bash
cd Frontend
npm run lint
npm run build
```

---

## Troubleshooting

**`POST /api/tasks/assign` returns 503 `ENGINE_NOT_LIVE`.**
The engine is not leading the shard. Check `ENGINE_ENABLED=true`, that `SHARD_ID` equals the
bootstrap's `--shard-id`, that the bootstrap was applied, and that the boot log has no
`LEADER_ONLY worker NOT started` line. With `ENGINE_ENABLED=false` it is expected: the legacy
dispatcher is deleted.

**Telemetry not updating.**
Confirm the backend is on port 3000; if Redis is enabled, confirm `REDIS_URL` is reachable (hosted
Redis usually needs `rediss://`); check the simulator is running.

**Socket connects and disconnects repeatedly in development.**
The frontend socket client is a global singleton to survive Vite HMR. Make sure you import it from
`Frontend/src/lib/socket.js` rather than constructing your own.

**No map, or Mapbox errors.**
Set `VITE_MAPBOX_TOKEN` and restart the dev server.

**Prisma errors on start.**
Ensure Docker Desktop and `robotx-recovered-db` are running, `%USERPROFILE%\robotx-secrets\robotx-local.env`
exists, migrations are applied, and `npx prisma generate` has run.

**`[env] REFUSED to start the LOCAL environment` (exit 78).**
Something points LOCAL at a non-loopback database or Redis — usually a `DATABASE_URL` or
`REDIS_URL` set in the shell, which overrides the configuration file. Remove it; see
[`docs/runbooks/environments.md`](docs/runbooks/environments.md) §2.2.

**A gate fails after a documentation change.**
Not a false positive. Four tests read `NEXT_GENERATION_ASSIGNMENT_ENGINE.md` and `docs/adr/**` from
disk. Restore the path or content — do not weaken the test.

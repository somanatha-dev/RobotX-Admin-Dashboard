# RobotX RBAC — super administrator and campus administrator

Status: implemented 2026-10-21, not yet deployed. This is the reference for what each role may
do, where each rule is enforced, and how to roll the change out.

## 1. Roles

| Role | Scope | Source of truth |
|---|---|---|
| `SUPER_ADMIN` | every campus | `User.role`, read from the database on every request and socket connection |
| `ADMIN` | exactly one campus (`User.campusId`) | `User.role` + `User.campusId`; the database CHECK `User_role_campus_scope` holds "ADMIN ⇔ exactly one campus, SUPER_ADMIN ⇔ none" |

There is no registration. An account exists because the boot bootstrap created the first
`SUPER_ADMIN`, or because a `SUPER_ADMIN` created an `ADMIN` through `/api/users`.

An `ADMIN` whose campus is missing or does not resolve has scope `INVALID` and is refused
everything (HTTP 403 `INVALID_SCOPE`, socket rejected). A missing campus is never
"unrestricted".

`security.elevated_roles` is unchanged (`[SUPER_ADMIN]`). The §23.4 action classes (quarantine
override, safety configuration change, bulk cancellation, manual assignment against policy),
their reasons, second approvers and audit records apply exactly as before, with one exception:
by owner decision 2026-10-23 a safety configuration change (`POST /api/config/publish`) no longer
requires a second approver by default. This is a single-owner deployment. The publisher must
still be an authenticated `SUPER_ADMIN`, give a reason, and leave an `OverrideAudit` record. To
restore two-person approval, add `SAFETY_CONFIG_CHANGE` to
`security.second_approver_action_classes`. The route also refuses a spatial map that fails the
hierarchy's containment check (`SPATIAL_CONTAINMENT`, HTTP 422) before anything is written. The platform
surfaces below are additionally gated on `role === SUPER_ADMIN` itself (`requireSuperAdmin`),
so publishing another role into `security.elevated_roles` would not open them.

## 2. Campus ownership

| Resource | Belongs to campus C when | Code |
|---|---|---|
| Robot | `Robot.campusId = C`, and its Agent names no region or names C's region | `accessScope.robotWhere` |
| Task | every Mission of the task is in C's region (`Campus.regionId`); a task with no Mission belongs to its robot's campus | `accessScope.taskWhere` |
| Campus → region | `Campus.regionId` (unique FK to `Region`) — the one link between `Campus.code` and `Region.regionId` | `PUT /api/campuses/:id/region` |

Anything that does not resolve is denied: a robot whose agent region contradicts its campus, a
task spanning two regions, a legacy task with no robot. A campus with no region (JSSATE today)
has no tasks and cannot submit any.

## 3. Capability matrix (HTTP)

ADMIN rows apply only to the ADMIN's own campus. "404" means a resource of another campus is
answered exactly like an unknown one.

| Capability | Route | SUPER_ADMIN | ADMIN |
|---|---|---|---|
| Own session, password, PIN, passkeys | `/api/auth/*` | yes | yes (own account) |
| List campuses | `GET /api/campuses` | all | own only |
| Create campus, link campus → region | `POST /api/campuses`, `PUT /api/campuses/:id/region` | yes | no |
| List robots / dashboard state | `GET /api/robots`, `GET /api/robots/state` | all | own campus (query `campusId` narrows, never widens) |
| Robot telemetry history | `GET /api/robots/:robotId/history` | yes | own campus, else 404 |
| Robot command | `POST /api/robots/:robotId/command` | STOP, PAUSE, RESUME, RETURN | **STOP, PAUSE** only; own campus, else 404 |
| Assign robot to campus | `PUT /api/robots/:robotId/campus` | yes (audited; refused if the agent's region contradicts) | no |
| Commission, pairing, unlock, clear fault, SoC declaration, edit, retire, recommission, physical declaration | `/api/robots/*` (rest) | yes (§23.4 gates where they applied) | no |
| List tasks | `GET /api/tasks` | all | own campus |
| Create task | `POST /api/tasks/assign` | any region (body/query) | own campus's region only; another region or any `shardId` → 403; campus with no region → 409 |
| Waive a predicate | `POST /api/tasks/assign` + `waivePredicate` | §23.4 gate | refused by the §23.4 gate (audited) |
| Cancel task | `POST /api/tasks/:taskId/cancel` | yes | own campus, else 404; an engine-managed task still needs an elevated role (refused) |
| Legacy reroute | `POST /api/tasks/:taskId/reroute` | yes | no |
| Explain a task | `GET /api/explain/task/:taskId` | yes | own campus, else 404 |
| Explain by decision id, query index | `GET /api/explain/*` (rest) | yes | no |
| Accounts | `/api/users` | yes | no |
| Simulator, configuration, privacy, shards, legs, diagnostics, engine health, locations | their routers | yes | no |

Default deny is structural: on each mixed router the ADMIN-capable routes are declared first and
`router.use(requireSuperAdmin())` follows, so a route added below it is SUPER_ADMIN-only. The test
`tests/unit/auth/rbacRoutePolicy.test.js` discovers every `/api` route from the routers and fails
if one outside the list above answers an ADMIN with anything but 403/404, or writes anything.

## 4. Real-time (Socket.IO)

| Room | Members | Receives |
|---|---|---|
| `dashboard` | SUPER_ADMIN sockets | every dashboard event, as before |
| `dashboard:campus:<campusId>` | that campus's ADMIN sockets | robot events (`robot:update`, `robot_online`, `robot_offline`, `robot_retired`, `robot_recommissioned`, `ROBOT_UPDATE(D)`, `ROBOT_COMMISSIONED`, `ROBOT_SPECIFICATION_UPDATED`, `OFFER_RESPONSE`, `SUPERVISION_SIGNAL`) and task events (`TASK_CREATED`, `TASK_UPDATED`, `TASK_ASSIGNED`) for that campus only |
| `user:<userId>` | every human socket of that account | nothing; used to disconnect the account's sockets |

- The server picks the rooms from the account row at the handshake; a client cannot ask for one.
- Every dashboard broadcast goes through `src/sockets/dashboardBroadcast.js`. An event not in the
  lists above (security events, pairing rejections, obstacle alerts, zone changes, command
  acknowledgements, engine invariant events) reaches SUPER_ADMIN sockets only.
- The reconnect replay of active task routes is filtered by the same task scope.
- An account change through `/api/users` disconnects that account's sockets at once; every
  dashboard socket is also re-checked against its account every 60 s. A re-check whose
  account lookup fails (a database error) decides nothing; the socket is asked about again at
  the next interval, so a transient error does not sign the operator out
  (`tests/integration/dashboardSocketRecheck.test.js`).
- Robot sockets are unchanged: pairing/session authentication, identity binding and `agentGate`
  are untouched, and a robot never authenticates as a human.

## 5. Account lifecycle

- **Initial SUPER_ADMIN**: `SEED_ADMIN_EMAIL` + `SEED_ADMIN_PASSWORD` at boot create it once.
  The bootstrap no longer touches an existing account: a changed password survives restarts, and
  an ADMIN with that email is never promoted (logged and refused). To recover a lost SUPER_ADMIN
  password, set `SEED_ADMIN_RESET_PASSWORD=true` for one boot, then unset it.
- **Create an ADMIN**: `POST /api/users {email, password, campusId}` as a SUPER_ADMIN. The role
  is not an input (a `role` field is refused). Password at least 12 characters and at most
  72 bytes, bcrypt cost 10. Account and audit event in one transaction.
- **Step-up PIN**: the dashboard's Authorization Required dialog (task creation and
  cancellation, STOP/PAUSE, global stop) asks for a PIN or a passkey, and passkey registration
  itself needs the PIN. A new ADMIN has neither: it sets its PIN in **Profile → Security →
  Step-up PIN** (`PUT /api/auth/pin {currentPassword, pin}`; `GET /api/auth/pin` says whether
  one exists). The current password is re-verified with bcrypt; the PIN is 4–10 digits, stored
  as a bcrypt hash, rate-limited (5 attempts per minute per client), audited as
  `STEP_UP_PIN_SET` / `STEP_UP_PIN_CHANGED`, and never returned or logged.
- **Change campus / disable / enable**: `PATCH /api/users/:id {campusId?, disabled?}`, for ADMIN
  accounts only. Audited. The account's sockets are sent `UNAUTHORIZED`
  (`code: ACCOUNT_DISABLED` or `ACCESS_CHANGED`) and then disconnected. The dashboard re-reads
  `/api/auth/me`: a disabled account is signed out with "Your access has been revoked"; a moved
  one drops every robot, task, route and simulator record it held, then reconnects and reloads
  into its new campus.
- **Revocation**: role, campus and `disabledAt` are re-read on every HTTP request and socket
  connection, so a disabled account's unexpired JWT stops working on its next request
  (`401 {code: "ACCOUNT_DISABLED"}`), and existing sockets close at once (or within 60 s). JWTs
  themselves are still 7-day and not individually revocable; logout clears the cookie only.
- **Audit**: account creation, campus changes, disable/enable, robot campus assignment and
  campus → region links are `OPERATOR_ACTION` events on the hash-chained audit stream with
  `payload.action` naming the change. A refused mutating request on a SUPER_ADMIN surface is
  appended as `RBAC_REFUSED`. No password, hash or token is recorded.

## 6. Rollout

Migrations (additive; no existing row changes):

1. `20261021120000_role_admin` — adds the enum value (its own migration: PostgreSQL cannot use a
   new enum value in the transaction that adds it).
2. `20261021120100_user_campus_scope` — `User.campusId`, `User.disabledAt`, `Campus.regionId`,
   the CHECK, the default role `ADMIN`.

Every existing account is SUPER_ADMIN with no campus and satisfies the CHECK unchanged. Before
deploying, review who holds the existing accounts: all of them stay platform administrators.

Steps (each needs the owner's approval; none has been done):

1. Back up the target database.
2. `npx prisma migrate deploy` against it, before the new backend boots: the boot's schema-drift
   check refuses to start without these columns. (Whether Render's build command already runs
   migrations is not recorded in this repository — check the service settings.)
3. Deploy the backend, then the frontend.
4. As a SUPER_ADMIN: link each campus to its operating region (`PUT /api/campuses/:id/region`,
   e.g. RNSIT → `rnsit` where that region exists), and assign existing robots to their campus
   (`PUT /api/robots/:robotId/campus`). Until then an ADMIN sees no robots and no tasks.
5. Create ADMIN accounts from the dashboard's **Admins** page.
6. Verify: `GET /api/auth/me` as the ADMIN names its campus; its robot list holds only that
   campus's units.

Rollback: redeploy the previous build. The new columns are nullable and unused by older code;
drop them only after every ADMIN account is removed (the CHECK and FK would otherwise refuse).

## 7. The dashboard

One login page and one dashboard for both roles; sign-in always lands on `/`. What differs is
what the server returns (scoped data) and what the dashboard offers (`Frontend/src/lib/access.js`
mirrors the server's policy; it decides only what to show):

- **Navigation**: the Admins page and the commission / simulator buttons are a SUPER_ADMIN's;
  `/commission`, `/simulator/new`, `/robots/:id/connect` and `/admins` show "not available" to
  an ADMIN (`RequireSuperAdmin`), and their APIs refuse it regardless.
- **Profile**: the account's real role, campus and operating region; the step-up PIN form.
- **Simulator report** (charging, runtime): SUPER_ADMIN only. An ADMIN page neither polls nor
  refreshes it, and says "restricted" where the details would be, not "unknown".
- **Map**: an ADMIN's map has no country/state/city/area filters (their endpoint is
  SUPER_ADMIN-only), its campus selection is pinned to its own campus, and its default view
  frames that campus — including a campus with no operating region.
- **Task form**: an ADMIN is offered its own campus only, pre-selected. A campus with no
  operating region (JSSATE today) is shown disabled and cannot submit; no region is invented.
- **Robot not found**: one sentence for "does not exist / retired / outside your campus", so
  the page never says which.

## 8. Known limitation: step-up is enforced in the browser only

`POST /api/auth/pin-auth` and `POST /api/auth/webauthn/verify` answer `{ authorized: true }` and
record nothing the action routes check. A client that skips the dialog reaches the same APIs;
every RBAC, campus, §23.4 action-class, reason and second-approver rule still applies to it, so
the dialog is a deliberate-confirmation step, not an authorisation boundary. Enforcing it on the
server would change the contract of every operator API (`/api/tasks/assign`, `/cancel`,
`/robots/:id/command`) for every caller, including the verification tools that call them
directly — an owner decision, not part of this change.

## 9. Open decisions (default: deny)

- RESUME and RETURN for a campus administrator (they set a unit moving).
- Cancellation of an engine-managed task by a campus administrator (today: elevated role only).
- Obstacle alerts (`ALERT_CREATED`, `REROUTE_ALERT`) and command acknowledgements for campus
  administrators (today: not relayed — the payloads carry no robot or task to scope them by).
- Server-side enforcement of step-up authentication (§8).
- Which existing robots belong to which campus, the RNSIT → `rnsit` link in each environment,
  and an operating region for JSSATE (none exists; until one does, a JSSATE administrator sees
  its robots but cannot create tasks).

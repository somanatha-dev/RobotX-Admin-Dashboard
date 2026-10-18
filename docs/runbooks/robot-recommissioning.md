# Recommissioning a retired robot

How an administrator brings a **retired** robot back to the fleet as the same robot, with
its identity and history intact. This is not the same as commissioning a new unit, and it
does not put the robot back to work.

Code: `Backend/src/services/robotRecommission.service.js` (the service),
`robots.controller.recommissionRobot` / `listRetiredRobots`, the routes in `robots.routes.js`,
and the dashboard's **Recommission retired robot** choice on `/commission`
(`Frontend/src/features/robots/RecommissionRetiredUnit.jsx`, `lib/robotRecommission.js`).

## 1. Why a retired robot's ID was refused

Retirement (`DELETE /api/robots/:robotId`, commit 769bba2) is soft. It keeps the robot's
`Robot` and `Agent` rows, because they hold its tasks, events, commitments, telemetry and
charging history. What marks it retired is `Agent.lifecycleState = DECOMMISSIONED`.

So the robot ID stays taken. `POST /api/robots` refuses to create a **new** unit under it,
because the new unit would inherit the old one's history. That refusal is still correct and
has not changed. What was missing was a way to say "this is the same robot, coming back".

**Example: the RBT-2000 report.** Commissioning RBT-2000 on
`https://robot-x-admin-dashboard.vercel.app/commission` answered:

> The ID "RBT-2000" belongs to a retired robot and cannot be reused. Choose a different identifier.

With nowhere to go from there, the operator was stuck. The page now offers
**Recommission RBT-2000 instead**, which opens the explicit flow below.

## 2. Identity and lifecycle semantics

| Question | Answer |
|---|---|
| New record, or the old one? | **The old one.** The same `Robot` row and the same `Agent` row (whose id is derived from the robot code). Nothing is created, copied or deleted. |
| History | All of it stays attached: tasks, events, commitments, outbox, telemetry, observations, charger reservations. The retirement Event is kept, and a recommissioning Event follows it. |
| Can two active records exist for one ID? | No. `Robot.robotId` and `Agent.robotDbId` are unique, and this operation never creates a row. The live harness confirms that PostgreSQL refuses a second `Robot` row (P2002). |
| Lifecycle | `DECOMMISSIONED → COMMISSIONED`. §2.1 defines `COMMISSIONED` as "registered and configured, not yet released into service". It is **not eligible for work**: F2 refuses it, and the index maintainer and reconciler skip it. |
| Authority epoch | Advances by exactly 1, recorded in `AgentFenceAudit` with source `recommission`. Any decision built from the retired agent's snapshot fails guard G3 at commit time. |
| Configuration | Kept as it was: chassis, specification, name, location. Edit it afterwards with `PATCH /api/robots/:robotId`. |
| `Robot.status`, stop latch, battery | Not touched. A hold that was in force at retirement (for example `PAUSED` after a STOP) is still in force. |
| Simulated robots | Refused (`SIMULATED_NOT_RECOMMISSIONABLE`). Create a new simulated robot instead. |

No schema change and no migration were needed.

## 3. Credentials and re-pairing

Every credential from before retirement is dead after recommissioning:

1. **Inside the recommissioning transaction**, once the Agent row is locked and the unit is
   confirmed retired and physical, the KV keys `session:`, `pairing:`, `pairingAttempts:` and
   `pairingLocked:` are deleted. Until the commit, every reader still sees the robot as
   retired: AUTH refuses it, and AUTH's online write waits on the lock. So nothing can
   re-create a credential in between. If the KV store cannot confirm the deletes, the
   transaction rolls back and the request answers **503**, with nothing changed.
2. The durable `RobotSession` row is deleted in the same transaction.
3. The KV keys are deleted once more after the commit.

**No pairing code is issued by recommissioning.** The robot re-enrolls through the existing
flow. The dashboard goes straight to the robot's Connect page, which calls
`POST /api/robots/commission {robotId}` to mint a fresh single-use code (valid 300 s). Then
the Pi is started with that code. Details:

- An old code is deleted in step 1, and a used code is deleted when it is consumed, so neither
  can enroll.
- An old bearer token or durable session is refused.
- Enrolling creates one new durable session for the new token.

The unit tests prove each of these against the real AUTH handler.

## 4. What stays mandatory before the robot is dispatched

Recommissioning returns the **record**. Putting the robot back to work is a separate decision,
with exactly the checks a newly commissioned physical unit has:

- **The physical fleet declaration.** It is the only path from `COMMISSIONED` to `ACTIVE`
  (`physicalDeclaration.service`, applied at backend boot). The robot must be listed in
  `PHYSICAL_FLEET_DECLARATION_FILE` with `PHYSICAL_FLEET_ENABLED=true`. That includes its
  region and the site's `snapRadiusM` (see [physical-fleet.md](physical-fleet.md)). A newly
  commissioned physical unit also needs its declaration applied before it can receive a
  state-of-charge declaration, so this is the same step, not a new one.
- **Pairing**, and an online, authenticated socket.
- **A fresh state-of-charge declaration** (`POST /api/robots/:id/soc-declaration`). Only
  possible once the declaration has been applied.
- **A live position fix** that the declaration accepts, on a permitted campus way.
- **An unengaged stop latch**, and a recent PROBE answer on the current socket.
- Health, region and route constraints, all evaluated by the feasibility gate as usual.

Nothing in this change enables motion or bypasses a safety check.

## 5. API

### `GET /api/robots/retired`

Authenticated. Lists the retired units an operator can choose from. It returns identity and
display fields only, never credentials or session data.

```json
{ "ok": true, "robots": [
  { "robotId": "RBT-2000", "name": "Rover 2000", "simulated": false, "recommissionable": true,
    "lastSeenAt": "2026-10-10T07:58:12.000Z", "locationName": "RNSIT ECE block",
    "retiredAt": "2026-10-10T08:00:00.000Z" } ] }
```

`retiredAt` is the time retirement recorded on the fence audit, or `null` if a later fence
event has replaced it.

### `POST /api/robots/:robotId/recommission`

- **Authorization:** an authenticated session (cookie or `Bearer`), plus an elevated role
  (`security.elevated_roles`, default `SUPER_ADMIN`). Both are enforced on the server.
- **Rate limit:** 10 per minute.
- **Dashboard:** the step-up challenge (passkey or PIN) runs before the request is sent.

**Request.** Exactly these two fields; any other field is refused by name:

```json
{ "reason": "Drive train repaired and re-inspected", "confirmRobotId": "RBT-2000" }
```

- `reason` is required, 1 to 500 characters, and recorded in the audit trail.
- `confirmRobotId` must repeat the path's id exactly (case-sensitive).

**Responses:**

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ ok, robotId, recommissioned: true, alreadyRecommissioned, lifecycleState: "COMMISSIONED", releasedToService: false, pairingRequired: true }` | Done. `alreadyRecommissioned: true` is a retry of a recommissioning that already committed (see below). |
| 400 | `code: INVALID_REQUEST` | Missing reason, reason too long, confirmation mismatch, or an unknown field. |
| 401 | `{ message: "Unauthorized" }` | No valid session. |
| 403 | `error: Forbidden` | The account's role is not elevated. |
| 404 | `code: ROBOT_NOT_FOUND` | Unknown robot ID. |
| 409 | `code: ROBOT_NOT_RETIRED`, `lifecycleState` | The unit is not retired: active, or already recommissioned and since moved on. |
| 409 | `code: SIMULATED_NOT_RECOMMISSIONABLE` | A retired simulated robot. |
| 429 | rate limiter | Wait and retry. |
| 503 | `code: CREDENTIAL_REVOCATION_UNAVAILABLE` | The KV store could not confirm the credential deletes. Nothing changed; safe to retry. |

Every refusal carries `{ ok: false, code, refusal, message }`. No response carries a token,
pairing code, hash or session.

**Retries and concurrency.** The transaction locks the Agent row `FOR UPDATE`, the same lock
that retirement and `commit()` take. A second request then lands in one of two places:

- If it finds the unit `COMMISSIONED` and `recommission` is still the last fence source, it
  answers 200 `alreadyRecommissioned: true` and changes nothing. That covers a double submit,
  a retry after a lost response, or the loser of two concurrent requests.
- In any other non-retired state, it answers 409 `ROBOT_NOT_RETIRED`.

Retirement and recommissioning racing each other serialise on the same lock, and both
orders were verified on real PostgreSQL.

**Event.** A `robot_recommissioned { robotId, timestamp }` socket event goes to every
dashboard, and each one refetches its lists.

### Change to `POST /api/robots` (backward compatible)

An ID that is already taken is still a 409 with the same sentence, which now ends by pointing
at recommissioning. The body gains:

- `code`: `ROBOT_ID_RETIRED` for a retired robot, or `ROBOT_ID_TAKEN` for an active one;
- `retired`: `true` or `false`;
- `ok: false` and `error: "Conflict"`.

An ordinary commissioning attempt **never** recommissions anything.

## 6. Audit

- **Success:** an `Event` row (INFO) on the robot, for example:
  `Unit RBT-2000 recommissioned (lifecycle DECOMMISSIONED -> COMMISSIONED, authority epoch 5 -> 6) by <user id>: <reason>. Previous credentials revoked; not yet released into service (pairing and the physical fleet declaration are still required).`
  `Event.createdAt` is the timestamp. The `AgentFenceAudit` row records the epoch advance.
  The server log line `[recommission] retired robot recommissioned` carries the ids and the
  new epoch.
- **Refusal:** a server log line `[recommission] refused` with the robot id, the actor id, the
  code and the status. The reason text is not logged.
- **Pairing:** issuing the fresh code writes the existing `Pairing code issued …` Event, which
  never contains the code.

## 7. Using it

**Dashboard:**

1. Go to **Commission** and choose **Recommission retired robot**. If a commissioning attempt
   was just refused, use **Recommission <ID> instead**.
2. Pick the unit. Read **What recommissioning does**.
3. Enter the reason and type the ID to confirm.
4. Pass the step-up challenge. On success the page goes to the unit's Connect page.
5. Pair the Pi with the fresh code.
6. Make sure the unit is in the physical fleet declaration the backend loaded. Then apply it with
   `POST /api/robots/<robotId>/physical-declaration/apply {"reason", "confirmRobotId"}`; this needs
   the elevated role and no restart. A restart also works. If the unit is not yet in the file, add
   it and restart, because the file is read at boot only. See [physical-fleet.md](physical-fleet.md).
7. Declare its state of charge.

**API** (the `TOKEN` placeholder stands for a session JWT; never paste real credentials into
tickets or docs):

```bash
curl -s -X POST "$API/api/robots/RBT-2000/recommission" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"Repaired and re-inspected","confirmRobotId":"RBT-2000"}'
curl -s -X POST "$API/api/robots/commission" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"robotId":"RBT-2000"}'        # fresh one-time pairing code
```

## 8. Diagnosing common errors

| Symptom | Cause, and what to do |
|---|---|
| "belongs to a retired robot and cannot be reused for a new unit" | You used **Commission new unit** with a retired ID. Use **Recommission retired robot**, or pick a new ID for a different robot. |
| 403 Forbidden | The account's role is not in `security.elevated_roles`. |
| 409 `ROBOT_NOT_RETIRED` | Already recommissioned, or never retired. Refresh the list; connect the unit from its page. |
| 503 `CREDENTIAL_REVOCATION_UNAVAILABLE` | The KV store (Redis) is unreachable. Nothing changed; retry once it is back. |
| Recommissioned and paired, but it never receives work | Expected until the declaration is applied: the Agent is `COMMISSIONED`. Check the boot log line `[physical] declaration applied to engine rows` for the robot. Then declare SoC, and check the fix, stop latch and probe (see [physical-fleet.md](physical-fleet.md)). |
| The Pi is refused at AUTH after recommissioning | Its stored token is from before retirement and is revoked by design. Issue a fresh code on the Connect page and restart the Pi with it. |
| `soc-declaration` answers `NOT_DECLARED` | The declaration has not been applied since recommissioning. Restart with the robot in the declaration. |

## 9. Deployment and rollback

- **No migration, no new environment variable, no schema change.** The backend (Render) and
  the dashboard (Vercel) only need to deploy the commit. Deploy the backend first: an old
  backend answers the new dashboard's `GET /api/robots/retired` and `POST …/recommission`
  with 404, and the dashboard shows that as a failure. It claims no success.
- **Rollback:** revert the commit. Robots recommissioned in the meantime remain
  `COMMISSIONED`, which the old code treats as a valid, non-retired, non-eligible state. Its
  physical declaration still promotes `COMMISSIONED → ACTIVE` at boot. Nothing needs
  cleaning up. To withdraw such a robot again, retire it as usual.

## 10. Verification

| Check | Command |
|---|---|
| Unit and HTTP (40 tests, including the RBT-2000 regression) | `cd Backend && npx jest tests/unit/robots/robotRecommission.test.js` |
| Retirement suite, unchanged behaviour | `npx jest tests/unit/robots/robotRetirement.test.js` |
| Real PostgreSQL (42 checks: history, concurrency, lock races, G3, F2) | `DATABASE_URL=postgresql://user@127.0.0.1:<port>/<db> node tools/verify/robotRecommissionLiveDatabase.js` (disposable loopback database only) |
| Dashboard | `cd Frontend && npm run test:arch` (`robotRecommission.test.mjs`) |

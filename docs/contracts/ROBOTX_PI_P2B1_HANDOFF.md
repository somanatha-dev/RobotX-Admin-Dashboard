# RobotX Pi — P2B-1 Handoff (authoritative backend contract)

**For:** the Rover/Pi RobotAgent implementer. **Date:** 2026-09-24, **updated by P2B-2** (same day). Items marked **[P2B-2]** are backend behaviour that changed in that pass. **Backend:** `feature/dashboard`, HEAD `f69b3e2` plus the uncommitted P1 tree.
**Parent documents:** `docs/contracts/PHYSICAL_ROBOTX_BACKEND_CONTRACT.md` and `ROBOTX_P2A_PHYSICAL_BACKEND_CONTRACT_AUDIT.md`, both in the Dashboard repository. This file is self-contained.
Every rule below was read from backend source and is cited `file:line` under `Backend/`.

Markers:
- **[LIVE]**: the backend processes it today.
- **[ACCEPTED, IGNORED]**: passes validation, has no backend effect yet. Safe to send.
- **[PROPOSED]**: not implemented in the backend.
- **[NO HW]**: not currently available from the rover hardware. Never fabricate it.

---

## 1. Robot identity [LIVE]

- The robot's identity is one string, `robotId`. It must equal **`Robot.robotId`** of a unit commissioned via `POST /api/robots/commission`. The backend's `Agent.agentId` is the same string (`robot.service.js:531-546`), so there is exactly one identifier.
- It is exact and case-sensitive, and must be a JSON **string**. A number fails the AUTH schema (`robot.handler.js:413-416`). The code enforces no format rule (`robot.service.js:71`).
- `ROBOTX_ROBOT_ID=robotx-pi` is **a local configuration value**. It is correct **only if** the operator commissioned the unit under exactly `robotx-pi`. The backend has no default robot id. An unknown id is a silent disconnect (`robot.handler.js:452`).
- The following are never identity: the socket id, the IP address, the hostname, and the `robotId` field inside TELEMETRY (ignored; identity comes from the authenticated socket).

## 2. Connection [LIVE]

- Socket.IO **v4** client to `http(s)://<backend>:<PORT>`, namespace `/`, path `/socket.io/` (`server.js:383`).
- **Never send an `Origin` header or a `User-Agent` containing `Mozilla`.** Either one classifies the client as a dashboard: it receives `UNAUTHORIZED` and is disconnected (`socket.server.js:194-218`).
- Register listeners **once per socket object**, not in `on("connect")`. The client reuses one object across reconnects.

## 3. AUTH [LIVE]

`robot.handler.js:413-706`. Emit it after **every** `connect`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `robotId` | string, length ≥ 1 | yes | §1 |
| `pairingCode` | string or number | first connection | 6 digits, single use, 300 s TTL (`robots.controller.js:431`). 5 failures lock the unit for 1 h. |
| `token` | string or number | later connections | from `AUTH_SUCCESS.token`. **Persist it to disk.** 24 h TTL, refreshed on each success (`:536,572`). |
| `dedupState` | any | optional | §11.5 handshake |
| `certificate` | any | **do not send** | switches the session to mTLS |

- **Success:** `AUTH_SUCCESS` **and** `AUTH_OK`, both `{robotId, token, dedup, session}`. Handle one of them.
- **Failure:** a silent `disconnect` with no reason. Rate limit: 5 per 60 s.
- **[P2B-2]** If a socket that is already authenticated sends `AUTH` for a **different** `robotId`, it is disconnected. Re-sending `AUTH` for the same robot is harmless.

## 4. HEARTBEAT [LIVE]

`robot.handler.js:709-790`, `commitmentLeaseRenewal.service.js:35-77`, `leases.js:90-103`.

- Payload is `{}` when idle. While holding an accepted mission it is `{"commitmentId":"<string>","fence":"<same fence string as the OFFER>"}`.
- The backend stamps **server** time on every beat. After **10 s** without one the robot is stale for assignment (`connectivity.max_heartbeat_age`).
- With a matching `commitmentId` and `fence`, the heartbeat renews the mission lease (60 s) once at least half of it has elapsed. A different commitment or fence renews nothing, silently.
- Emit every **2 s** from the RobotAgent main loop. Rate limit: 10 per 5 s, at least 100 ms apart. No acknowledgement.
- **[P2B-2] `PROBE` / `PROBE_RESULT`: ready in the backend, OFF by default** (`services/agentProbe.service.js`).
  - When the operator sets `AGENT_PROBE_INTERVAL_MS`, the server sends `PROBE {"command":"PROBE","correlationId":"<uuid>","issuedAtMs":<ms>}` to each authenticated robot socket.
  - The robot answers **on the same socket, within 2 s**, with `PROBE_RESULT {"correlationId":"<echo>","robotId":"<your robotId, optional>"}`. Other keys are ignored.
  - That answer is the only thing that satisfies §7.5 F14 (a proven command path).
  - An answer that is late, replayed, unknown or from another robot proves nothing. A proof does not survive a reconnect.
  - The Pi does not implement PROBE today, so F14 stays unsatisfied for RobotX. That is the correct outcome.

## 5. TELEMETRY [LIVE, with some blocks ACCEPTED-IGNORED]

`telemetry.handler.js:384-960`. Rate limit: 50 per 5 s, at least 100 ms apart. No acknowledgement. A schema failure is dropped silently.

| Field | Wire type | Meaning | Backend effect |
|---|---|---|---|
| `timestamp` | number (epoch ms); numeric string coerced | **agent** clock, the instant measured; must be > 0 | required for any position Observation or SoC write |
| `sequence` | integer | strictly increasing per robot | Observation ordering |
| `status` | string | one of `IDLE ACTIVE PAUSED OFFLINE ERROR ISSUES RETURNING CHARGING` (`:251`) | an unknown value is dropped; transition table applies; don't send `OFFLINE` |
| `lat`, `lon` | number | WGS-84 degrees of a **real fix** at `timestamp` | → `Observation{kind:"position", deadReckoned:false}` → candidate index, arrival detection, completion track. **[P2B-2]** No Observation is written if `timestamp` is more than `time.max_clock_skew` (500 ms) ahead of the server's clock. |
| `position` | object, optional | `{"fixType":"NO_FIX"\|"2D"\|"3D"\|"RTK_FLOAT"\|"RTK_FIXED","hAccM":<m>}` | **[P2B-2] LIVE.** `NO_FIX` means the frame's lat/lon are not written. `hAccM` > 0 is stored as `Observation.uncertaintyRadiusM`. |
| `battery` | number 0–100 | percent, **measured SoC only** | Written to `Robot.battery` (the dashboard). **[P2B-2]** It reaches the engine's SoC, `BatteryState.lastObservedSoc`, **only with** `energy.socMethod` ∈ `BMS`, `COULOMB_COUNTING`, `VOLTAGE_CURVE_CALIBRATED`. That row must also exist, and no physical unit has one today. |
| `speed` | number | m/s | live state only |
| `heading` | number | degrees | live state only, not persisted |
| `distanceTravelled` | number | cumulative metres | if omitted, the server accumulates it from positions |
| `localisation`, `safety`, `faults`, `energy` (except `socMethod`) | objects | P2A blocks, §16 | **[ACCEPTED, IGNORED]**. No backend reader yet. |

Any key at any depth named like `capability`/`capabilities`, `certification(s)`, `attestedCapability`, `hazmatCertified`, `cold_chain`/`coldChain` or `clearance` **drops the entire frame** (`attestation.js:270`).

## 6. OFFER lifecycle [LIVE on the engine path]

**OFFER is the only way a mission is assigned.**
- New tasks exist only while the engine is live (`task.service.js:887-903`), and the coordinator assigns them only by signed `OFFER`.
- `TASK_ASSIGN` has one producer: the post-restart recovery sweep (`server.js:1260-1300`). It re-sends a cached route for a task that is already ASSIGNED or IN_PROGRESS, and it carries no commitment or fence.
- On the engine path, a server restart therefore re-sends `TASK_ASSIGN` for a mission already held by `OFFER`, because the engine writes the same route cache (`assignmentProjection.service.js:305-313`).
- **The physical robot must not start a mission from `TASK_ASSIGN`.** Treat it as a non-authoritative duplicate: log it, and send no reply.

Sequence:
```
OFFER (signed envelope) ──► admit? ──► COMMAND_ACK{outboxId,fence,authorityEpoch}
                                   └─► exactly ONE of OFFER_ACCEPT | OFFER_REJECT | OFFER_DEFER, before offerExpiry (20 s)
ACCEPT ─► HEARTBEAT{commitmentId,fence} every 2 s ─► real fixes ─► server detects departure/arrival
       ─► CUSTODY_EVENT ACQUIRED ─► … ─► CUSTODY_EVENT RELEASED ─► TASK_COMPLETE
Unanswered OFFER ─► withdrawn at an advanced fence (WITHDRAW), robot excluded (`offers.js:483`)
```

**Envelope.** ⚠ **The Socket.IO event name is the VALUE of the envelope's `command` field**: `OFFER`, `WITHDRAW`, `RECALL`, `ABORT_MISSION` and so on (`commandDispatcher.service.js:308` does `io.to(room).emit(envelope.command, envelope)`).
- **There is no event literally named `command`.** Subscribe to each command name separately.
- Built at `outbox.worker.js:547-563`. The addressee is rewritten to your `robotId` at `leaderWorkers.js:260-280`.

The envelope fields:
`{outboxId, command:"OFFER", commandClass:"MISSION", fenceScope:"COMMITMENT", agentId, commitmentId, fence:"<decimal string>", authorityEpoch, fenceFloor, sequence:<int>, notValidAfter:"<ISO>", signature:"<hex>", payload}`

**Payload** (`offers.js:105-150`, `coordinatorSolvePath.js:2094-2160`):
`{commitmentId, fence, legId, taskId|null, missionPlan, stopSequence:[{sequence, stopType, siteId, lat, lon, projectedArrivalMs, departureMs, path:[{lat,lon}], pathProfile, pathDistanceMeters}], routeReference:null, payloadManifest:[], requirementAcknowledgements:[], energyReserveParams, targetSoc, offerExpiry:"<ISO>"}`
A stop with no `path` is not executable, so reject the offer with reason `NO_EXECUTABLE_PATH`.

**Admission.** Checks run in this order. This mirrors `VirtualRobot._admitEnvelope` / `_applyMissionCommandExclusively`, `fencing.js:188-212` and `sequence.js:144-163`.

1. `agentId === robotId`, else reject with `ADDRESSED_TO_ANOTHER_AGENT`.
2. `notValidAfter` is in the future, else reject with `NOT_VALID_AFTER_PASSED`.
3. Signature.
   - Algorithm: HMAC-SHA256, hex-encoded, over the UTF-8 canonical string (`commandSigning.js`).
   - Canonical string: `field=value` pairs for `agentId, command, commandClass, fenceScope, commitmentId, fence, authorityEpoch, fenceFloor, sequence, notValidAfter, payload`, in that order, joined by `\u001f`.
   - **[P2B-2] The authoritative canonical form is in §6.1.** It has been checked against a test vector produced by the backend.
   - The key is `COMMAND_SIGNING_KEY` (at least 32 bytes). **No mechanism exists to provision it to a robot**, so it must be copied out of band. Without it the robot cannot verify, and the Pi then admits no OFFER, which is correct.
4. Fence: an integer strictly greater than `fenceFloor` (when present) **and** strictly greater than this commitment's highest applied fence. Otherwise reject.
5. Sequence: per commitment, first is `0`, then contiguous. At or below the highest applied → DUPLICATE: do not apply, do not respond again. A gap → hold.
6. **Persist** the fence and sequence high-water marks **before** acting.

### 6.1 Signature canonical form [P2B-2, authoritative]

**Sources:**
- The signer is `engine/security/commandSigning.js`.
- The form is re-implemented independently, from the wire alone, in `tools/verify/wireCanonical.js` (JS) and `tools/verify/pi_canonical_reference.py` (Python).
- Both are verified against **`docs/contracts/fixtures/offer-signature-test-vector.json`**, which the backend's real OFFER path produced. The key in that file is a public test vector, never a deployment key.

```
canonical = "\u001f".join(f"{f}={render(f, envelope[f])}" for f in
            ["agentId","command","commandClass","fenceScope","commitmentId","fence",
             "authorityEpoch","fenceFloor","sequence","notValidAfter","payload"])   # this order, NOT sorted
signature = hex( HMAC_SHA256( key = UTF-8 bytes of COMMAND_SIGNING_KEY, msg = UTF-8 bytes of canonical ) )  # lower-case
```

| Value | Rendering |
|---|---|
| absent / `null` | `null` |
| envelope `fence`, `authorityEpoch`, `fenceFloor` | integer digits, **unquoted** (`fence=42`, although the wire carries `"42"`) |
| envelope `notValidAfter` | ISO-8601 UTC with milliseconds, **unquoted** (`notValidAfter=2026-09-24T10:00:20.000Z`) |
| every other value, at any depth, including everything inside `payload` | ECMAScript `JSON.stringify`. Strings **inside the payload are therefore quoted**: `"fence":"42"`, `"offerExpiry":"2026-…Z"` |
| objects inside `payload` | keys sorted at **every** depth (UTF-16 code-unit order); arrays keep their order |
| `outboxId`, `signature` | on the wire, but **not signed** |

**The Pi's three assumptions, answered:**
1. Expiry is unquoted: **yes** for the envelope's `notValidAfter`, **no** for `payload.offerExpiry`.
2. Keys are sorted recursively: **yes** inside `payload`, **no** at the envelope level, which uses the fixed order above.
3. The key is its UTF-8 bytes: **yes**, and it must be at least 32 bytes.

**Python traps (the test vector exercises both):**
- `json.dumps` escapes non-ASCII characters unless you pass `ensure_ascii=False`.
- Python writes `5e-07` where JS writes `5e-7`, and `1e-06` where JS writes `0.000001`.

So parse the wire with `json.loads`, and render numbers using ECMAScript's Number-to-String rules.

**[P2B-2] A backend defect found live, and fixed.** The backend signed OFFERs over in-memory doubles, but the Prisma → PostgreSQL `jsonb` store shortens doubles to about 16 significant digits. The delivered payload therefore carried `…136.054` where `…136.0542` had been signed.
- Measured on a live V1 run before the fix: **0 of 10 real OFFERs verified from the wire.** The simulator never verifies, so the V1 runs never showed it.
- The fix: every non-integer number in the OFFER content is now quantised to 15 significant digits **before** signing (`services/storablePrecision.service.js`). The number signed and the number you receive are now identical.
- After the fix, the live check verifies real OFFERs 100% (`tools/verify/p2bOfferSignature.js --live`).
- **The Pi needs no change.** Verify exactly the bytes you receive, and never re-round a number before canonicalising.

Other engine commands:
- `WITHDRAW` (payload `{commitmentId, supersedesFence, reason}`), `RECALL` and `ABORT_MISSION`: stop that mission, tombstone the commitment, and send `COMMAND_ACK`.
  - **[P2B-2] Fixed:** `RECALL` (`engine/lifecycle/reassignment.js`) and `SHARD_MIGRATE` (`engine/shard/membership.js`) used to be signed for the `Agent.id` row key.
    - They are now signed for `agent.agentId || agent.id`, the same identity OFFER and WITHDRAW use and the one the delivery arm addresses the envelope to. That is your `robotId`.
    - On a live V1 failures run, RECALL now verifies 1/1 from the wire. It was 0/1 before.
    - Verify every command normally. No special case is needed.
- `REROUTE`, `RESEQUENCE`, `RESUME`, `TRANSFER_CUSTODY`, `STAND_DOWN_ALL`, `QUARANTINE`, `RELEASE_QUARANTINE`, `ESTOP_CLEAR`, `SHARD_MIGRATE` and `PARAMETER_PUSH` have **no producer today**. Admit and ACK them; do not invent effects.

## 7. COMMAND_ACK [LIVE]

`command.handler.js:23-164`. One event serves both paths.

- **Engine:** `{"outboxId":"<envelope.outboxId>","fence":"<envelope.fence>","authorityEpoch":<envelope.authorityEpoch>}`.
  - `outboxId` is required (non-empty string).
  - `fence` is **required** for a mission command (OFFER, WITHDRAW, RECALL, ABORT_MISSION and the other commitment-scoped commands). Echo the envelope's `fence` exactly as it arrived: the canonical decimal string, or a non-negative integer. A missing, null or malformed fence, or one that differs from the row's, is refused and the row is not acknowledged (2026-10-05).
  - An agent-scope command (`SHARD_MIGRATE` and the other agent commands) carries `fence: null`. Echo `null` or omit it. Its guard is `authorityEpoch`, which is **required**: echo the envelope's `authorityEpoch` exactly as it arrived (the canonical decimal string, or a non-negative integer). A missing, null or malformed epoch, or one that differs from the row's, is refused and the row is not acknowledged (2026-10-05).
  - A repeated ACK of an already-acknowledged row is ignored harmlessly (`:52`).
- **Operator:** `{"commandId":"<COMMAND.commandId>"}`.
- No reply to the robot in either case.

## 8. OFFER_ACCEPT · 9. OFFER_REJECT · 10. OFFER_DEFER [LIVE]

`offer.handler.js:37-44, 203-398`, `offers.js:261-460`.

| Field | Type | ACCEPT | REJECT | DEFER |
|---|---|---|---|---|
| `commitmentId` | non-empty string, from the envelope | required | required | required |
| `fence` | string or number, an integer **equal** to the OFFER's fence (echo the string) | required | required | required |
| `reason` | string or null | — | recommended (stored as a feasibility Observation) | recommended |
| `until` | **number (epoch ms) or ISO-8601 string**, must be in the future; a numeric *string* is invalid | — | — | required |

- Extra keys are allowed (passthrough). Rate limit: 30 per 60 s.
- **No reply event reaches the robot.** A malformed, stale-fence, released or wrong-agent response is logged and ignored.
- It is also ignored when the session has no shard identity (`agentGate`).
- An invalid or past `until` refuses the DEFER, and the offer then expires.
- **Respond EXACTLY ONCE per commitment.** The Pi already persists this before sending.
- **[P2B-2] The server now enforces the same rule** (`offer.handler.js`, `awaitingResponse`). A response is applied only when all of these hold:
  - the Leg is still `OFFERED` (§4.4's `AGENT_ACK` row);
  - the offer's `notValidAfter` has not passed;
  - for an ACCEPT, §4.4's `FENCE_MATCHES_OFFER_UNEXPIRED` guard also passes.
- Anything else is ignored and changes nothing: a duplicate, a response after expiry, or a response after the Leg moved on (accepted, departed, re-queued or reassigned).

## 11. CUSTODY_EVENT [LIVE]

`offer.handler.js:324-335`, `legProgress.service.js:234-347`.

```json
{"commitmentId":"<string>","fence":"<same fence string>","kind":"ACQUIRED"}
{"commitmentId":"<string>","fence":"<same fence string>","kind":"RELEASED"}
```

- **Required fields:** `commitmentId` (string), `fence` (integer equal to the commitment's current fence), and `kind`, which is exactly `ACQUIRED` or `RELEASED` (case-sensitive).
- **Not read:** `taskId`, `robotId` (identity comes from the socket), `timestamp` and position. Extra keys are ignored.
- **Admission:** the server applies a report only once **it** has verified arrival at that stop from your position fixes, within `VERIFY_ARRIVAL_RADIUS_M` (25 m in V1).
  - `ACQUIRED` moves AT_PICKUP → LOADED. `RELEASED` moves AT_DROP → RELEASED.
  - A report sent early is held in server memory and applied after arrival. A server restart loses it.
- **Idempotency:** a repeat is ignored harmlessly (`NOT_AT_THE_STOP`). Send each report once, when the physical handover actually happens. There is no reply to the robot.

## 12. TASK_COMPLETE [LIVE]

`dtaro.handler.js:150-311, 431-575`, `verification.js:312-385`.

```json
{"taskId":"<OFFER payload.taskId>","lat":12.93541,"lon":77.53452,"timestamp":1758700000123}
```

- **Required:** `taskId`, the OFFER's `payload.taskId`. A `legId` is also resolved, but a Leg covering several tasks is refused.
- **Optional:**
  - `lat`, `lon` as **JSON numbers**. If you send them, they must also be inside the arrival radius.
  - `physicalEvidence` (L2), `attestation` (L3), `reportedCorridors`, `deadZoneWindows`.
  - `timestamp` is not read.
  - **[P2B-2]** `plannedCorridor` is **ignored**. Grading uses only the corridor the server commanded in the OFFER.
- **Evidence required (L1, the V1 level):**
  1. **[P2B-2] Arrival is judged on your last accepted position fix**, which is a measured Observation, not the claim.
     - That fix must be within `VERIFY_ARRIVAL_RADIUS_M` (25 m) of the final stop.
     - It must be **no older than `VERIFY_TRACK_MAX_GAP_SECONDS` (10 s)** at claim time. Otherwise the failure is `FINAL_FIX_STALE`.
     - A claimed `lat`/`lon`, if sent, must also be within 25 m. Otherwise the failure is `CLAIMED_POSITION_OUTSIDE_RADIUS`.
  2. The **accepted, non-dead-reckoned position track** since the commitment was granted is plausible:
     - fix rate ≥ `VERIFY_TRACK_MIN_FIX_RATE` (10 per minute)
     - no gap > `VERIFY_TRACK_MAX_GAP_SECONDS` (10 s)
     - ≥ `VERIFY_TRACK_MIN_CORRIDOR_FRACTION` (0.8) inside the commanded path corridor (±30 m)
     - no implied speed > `VERIFY_MAX_SPEED_MS` (8.33 m/s)
- **Replies:**
  - `TASK_COMPLETE_ACK {taskId, timestamp}`: sufficient, Leg settled.
  - `{taskId, verifying:true, timestamp}`: the evidence is insufficient. The Task goes to an operator queue. **Do not retry the claim.**
  - **[P2B-2]** `{taskId, verifying:true, reason, timestamp}`: the claim **could not be graded**.
    - The possible reasons are `ENGINE_GATE_CLOSED`, `NO_AGENT`, `NO_LIVE_COMMITMENT`, `NO_LEG`, `VERIFICATION_NOT_CONFIGURED` and `VERIFICATION_ERROR`.
    - **Nothing is completed**; the claim is held for the operator. The backend used to complete these on the claim alone.
    - Do not retry.
  - **[P2B-2]** `{taskId, alreadyCompleted:true, timestamp}`: a repeat claim after your Task was already completed on a graded claim. Nothing is written.
  - A claim from a kinematically unreachable position raises a `SECURITY_EVENT`.
- Rate limit: 5 per 30 s, at least 1 s apart.
- **Every `lat`/`lon` you send in TELEMETRY is stored as a real (`deadReckoned:false`) fix and counts as completion evidence.** There is no wire flag for dead reckoning, so **never put dead-reckoned or estimated coordinates in `lat`/`lon`**.

## 13. COMMAND [LIVE]

`robots.controller.js:710-783`, `commandDispatcher.service.js:154`.

- Payload: `{"commandId":"<uuid>","type":"STOP"|"PAUSE"|"RETURN"|"RESUME","timestamp":<ms>}`.
- Reply with `COMMAND_ACK {"commandId":…}`. The server re-sends at 5, 10 and 15 s, then marks the command FAILED.
- **Idempotent per `commandId`:** on redelivery, re-ACK without re-applying. Never ACK an unknown `type`.
- **[P2B-2]** The backend accepts an ACK only from the robot the command was issued to.

## 14. STOP / RETURN / RESUME [LIVE]

- `STOP`, `PAUSE`, `RETURN` and `RESUME` arrive as `COMMAND.type` (§13).
- A separate bare event, `STOP {taskId?, reason:"TASK_CANCELLED", timestamp}`, is sent on task cancellation (`tasks.controller.js:278`). It expects no ACK. It is distinct from `COMMAND` STOP.
- Engine `RESUME` and `RETURN_TO_BASE` have no producer.
- **None of these is a safety function.** The ESP32 gates stay authoritative.

## 15. Reconnect [LIVE]

- Keep auto-reconnect on. On every `connect`: `AUTH` with the stored token, then `HEARTBEAT` (with `{commitmentId, fence}` if a mission is held), then `TELEMETRY`.
- A newer socket safely displaces the old one (`robot.handler.js:576-613`).
- A mission survives an outage only within its 60 s lease. The robot must keep its fence/sequence high-water marks and tombstones **across restarts**, because redelivery is at-least-once.

## 16. Stale and missing data

**Representing absence today:**
- **Omit the field.** For numeric fields `null`, `""` and a non-numeric string are all treated the same as omission (`telemetry.handler.js:372-382`).
- There is **no** "unavailable" flag for flat fields.
- **Never send a placeholder number** (`0,0`, `-1`, `battery:0`). Any number is taken as a measurement.

**What absence does:**

| Field absent | Engine / evidence effect | Dashboard live state |
|---|---|---|
| `timestamp` | no position Observation, no SoC write. The robot is never indexed or a candidate. | frame still shown |
| `lat`/`lon` | no position Observation | **carries forward** the last Redis/DB value (`:640-656`), including a commissioning-entered position |
| `battery` | no SoC write | **Carries forward** the last *reported* value. **[P2B-2]** A physical unit is now commissioned with **no** battery value; the operator's `initialBatteryPct` is no longer written as a reading. Until the Pi reports one, the dashboard shows none. |
| `status` | status unchanged | previous |

- **Staleness:** the backend judges age against **its** decision time, using your `timestamp`. The budget is 10 s. Stale data is never re-stamped, and a stale safety reading is never treated as safe.
- **Clock:** keep the Pi on NTP/chrony. A future timestamp makes the robot indeterminate, and therefore denied.
- **P2A blocks.** Since P2B-2, `position` and `energy.socMethod` are **LIVE** (§5). The rest are **[ACCEPTED, IGNORED]**: safe to send, with no effect yet. Each block's rule:
  - `safety.estop`: send `{"present":false}` when there is no circuit.
  - `faults[]`: send the full active set. `[]` means measured-none; omitting it means not measured.
  - `localisation`: omit until corroboration is real.
  - `energy.socMethod`: send it with any `battery`.
- **Not currently available from hardware [NO HW]:**
  - e-stop circuit
  - GNSS position (NEO-9M on the ESP32 I2C bus, not driven)
  - encoder odometry (inputs wired, no feature)
  - battery voltage, current and SoC
  - link quality
  - pack and ambient temperature

  Until these exist, **the physical RobotX remains unassignable by design.** The ESP32 `SAFETY_STOP` / `safety_stop` is a proximity stop and is **never** an e-stop.

## 17. Exact examples

```jsonc
// connect → AUTH (first time)
["AUTH", {"robotId":"robotx-pi","pairingCode":"418203"}]
// ← AUTH_SUCCESS {"robotId":"robotx-pi","token":"6f0c…","dedup":null,"session":{"mode":"LEGACY","sessionId":"…","fingerprint":null,"keyStorage":null,"expiresAt":null}}
["AUTH", {"robotId":"robotx-pi","token":"6f0c…"}]                       // every later connect

["HEARTBEAT", {}]                                                          // idle, every 2 s
["TELEMETRY", {"timestamp":1758700000123,"sequence":4812,"status":"IDLE",
               "safety":{"observedAtMs":1758700000100,"estop":{"present":false},
                         "safetyStop":{"active":false,"latched":false,"reason":null},
                         "motorDriveAvailable":true,"commandTimeout":false},
               "faults":[]}]                                               // no GNSS fix: lat/lon/battery omitted

// ← OFFER {…envelope…, "commitmentId":"c-7f3a","fence":"42","sequence":0,"outboxId":"ob-19", "payload":{…,"taskId":"T-123"}}
["COMMAND_ACK",  {"outboxId":"ob-19","fence":"42","authorityEpoch":null}]
["OFFER_ACCEPT", {"commitmentId":"c-7f3a","fence":"42"}]
//   or ["OFFER_REJECT", {"commitmentId":"c-7f3a","fence":"42","reason":"NO_POSITION_FIX"}]
//   or ["OFFER_DEFER",  {"commitmentId":"c-7f3a","fence":"42","until":1758700300000,"reason":"CHARGING"}]
["HEARTBEAT", {"commitmentId":"c-7f3a","fence":"42"}]                    // every 2 s while held
["CUSTODY_EVENT", {"commitmentId":"c-7f3a","fence":"42","kind":"ACQUIRED"}]
["CUSTODY_EVENT", {"commitmentId":"c-7f3a","fence":"42","kind":"RELEASED"}]
["TASK_COMPLETE", {"taskId":"T-123","lat":12.93541,"lon":77.53452,"timestamp":1758700400000}]

// ← COMMAND {"commandId":"9b1e…","type":"STOP","timestamp":1758700000500}
["COMMAND_ACK", {"commandId":"9b1e…"}]
```

## 18. Validation rules (backend side, as implemented)

| Event | Failure | Robot sees |
|---|---|---|
| AUTH | schema, unknown `robotId`, bad code/token, lockout, exception | silent disconnect |
| any | `Origin` / `Mozilla` UA | `UNAUTHORIZED`, disconnect |
| TELEMETRY | unauthenticated | `AUTH_REQUIRED` |
| TELEMETRY | schema, rate limit, backpressure, capability key | silent drop |
| TELEMETRY | unknown `status` / forbidden transition | that field ignored |
| TELEMETRY | no `timestamp`, or `lat`/`lon` not numbers | frame kept, no Observation |
| OFFER_* | malformed, unknown/released commitment, other agent, fence ≠ current, no shard identity | silently ignored |
| OFFER_DEFER | `until` missing, invalid, or not in the future | refused; the offer then expires |
| CUSTODY_EVENT | no `commitmentId`, fence ≠ current, not this robot's live commitment, wrong stop | ignored |
| COMMAND_ACK | unknown `commandId`/`outboxId`, fence/epoch mismatch; a mission command's ACK without a well-formed fence | ignored |
| TASK_COMPLETE | L1 evidence insufficient | `TASK_COMPLETE_ACK {verifying:true}`, nothing completed |
| TASK_COMPLETE | **[P2B-2]** verification unavailable | `TASK_COMPLETE_ACK {verifying:true, reason}`, nothing completed |
| OFFER_* | **[P2B-2]** Leg no longer OFFERED, or offer expired | ignored, nothing changed |
| TELEMETRY | **[P2B-2]** `timestamp` > 500 ms ahead of the server, or `position.fixType:"NO_FIX"` | no position Observation |
| COMMAND_ACK | **[P2B-2]** command issued to another robot | ignored |
| AUTH | **[P2B-2]** authenticated socket re-AUTHs as another robot | disconnect |
| PROBE_RESULT | unknown or replayed correlation id, more than 2 s late, another robot, another socket | no proof recorded |
| HEARTBEAT | commitment/fence mismatch | liveness recorded, lease not renewed |

**[P2B-2] Closed:** the backend no longer completes a Task on a claim it could not grade (see §12). The Pi's own refusal to claim without measured evidence stays. The two are independent safeguards, and the backend's check does not replace the Pi's.

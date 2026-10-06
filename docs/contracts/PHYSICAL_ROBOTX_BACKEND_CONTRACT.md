# Physical RobotX ↔ Dashboard Backend — Robot-Side Contract

**Version:** P2A draft, 2026-09-24. **Status:** contract design. The backend has *not* implemented the items marked **PROPOSED**.
**P2B-2 update (same day):** these PROPOSED items are now implemented in the backend:
- `PROBE`/`PROBE_RESULT`, opt-in via `AGENT_PROBE_INTERVAL_MS`.
- The `position` fix block.
- The `energy.socMethod` gate.
- The clock-skew bound.

Also since P2B-2:
- Offer responses are refused once the offer is no longer open.
- `TASK_COMPLETE` never completes on an ungraded claim.

For the current, exact robot-side rules, read [`ROBOTX_PI_P2B1_HANDOFF.md`](ROBOTX_PI_P2B1_HANDOFF.md). Where the two differ, the handoff wins.
**Audience:** the Rover/Pi RobotAgent implementer.
**Authority:** backend source on `feature/dashboard`. The evidence and line citations are in [`ROBOTX_P2A_PHYSICAL_BACKEND_CONTRACT_AUDIT.md`](../../ROBOTX_P2A_PHYSICAL_BACKEND_CONTRACT_AUDIT.md).
**Reference client:** `Backend/src/simulation/VirtualRobot.js`. It speaks every EXISTS event below.

> **Ground rules**
> 1. Never send a value you did not measure. **Omit** the field instead. The backend treats absence as "unknown" and denies eligibility by name. It never guesses.
> 2. The backend assigns physical and simulated robots through **one** pipeline with no preference either way. What makes a robot assignable is real data, not its kind.
> 3. The ESP32 remains the final motion-safety authority. **Nothing the backend sends is a safety function.** `STOP` is an operator request, not an e-stop.
> 4. Even a perfect implementation of this contract does **not** make RobotX assignable today. The missing pieces are hardware (§9) and backend or owner work (B1 router, B2 charging, operator-entered facts).

---

## 1. Connection — EXISTS

- Use a Socket.IO **v4** client. Connect to `http(s)://<backend>:<PORT>` with namespace `/` and path `/socket.io/`. Transport `websocket` is recommended.
- **Do not send an `Origin` header, or a `User-Agent` containing `Mozilla`.** A client that does is treated as a dashboard, receives `UNAUTHORIZED`, and is disconnected.
- Register event listeners **once per socket instance**, never inside the `connect` handler. The client reuses one socket across reconnects, so registering on each `connect` stacks duplicate handlers.

## 2. Identity and authentication — EXISTS

- Identity is `robotId`: the operator-chosen code under which the unit was commissioned (`POST /api/robots/commission`). It is **not** the socket id, the IP address or the hostname. The backend creates the matching Agent and a per-unit class `AC-<robotId>`. Your capabilities come from that commissioning record, **never** from you.
- Emit this immediately after **every** `connect`:
  - first time: `AUTH {"robotId":"RBX-01","pairingCode":"418203"}`. The code is single-use, expires after 300 s, and 5 failures lock the unit for 1 h.
  - after that: `AUTH {"robotId":"RBX-01","token":"<AUTH_SUCCESS.token>"}`.
- On success the backend emits **both** `AUTH_SUCCESS` and `AUTH_OK` with the same payload. Handle **one** of them.
- **Persist `token` to disk.** It expires after 24 h without a successful AUTH, and after that an operator must re-pair the unit.
- Every AUTH failure is a **silent disconnect** with no reason. `AUTH_REQUIRED` means "send AUTH again".
- **Forbidden keys, in any payload, at any depth:** `capability`, `capabilities`, `certification(s)`, `attestedCapability(ies)`, `hazmatCertified`, `cold_chain`/`coldChain`, `clearance`. The match ignores case and punctuation. A hit drops the whole frame and counts toward quarantine.

## 3. Liveness

| Event | Dir | Payload | Cadence | Backend meaning | Status |
|---|---|---|---|---|---|
| `HEARTBEAT` | Pi → BE | `{}`, or while holding a mission `{"commitmentId":"…","fence":"…"}` | **every 2 s** from the RobotAgent main loop, never from a detached timer | Stamped with **server** time. More than 10 s without one = STALE (not a candidate). With `commitmentId`, it renews the mission lease (60 s). | EXISTS |
| `PROBE` | BE → Pi | `{"command":"PROBE","correlationId":"…","issuedAtMs":…}` | about every 5 s | Server-initiated round trip, the only proof of a commandable link (F14) | **PROPOSED** |
| `PROBE_RESULT` | Pi → BE | `{"command":"PROBE","correlationId":"<echo>","robotId":"RBX-01","status":"IDLE","agentTimestamp":…}` | within 2 s, on the **same** socket | Records the round-trip proof | **PROPOSED** (the reference client already sends it) |

Backend states: CONNECTED (no AUTH) → AUTHENTICATED → LIVE (heartbeat and probe proof both within 10 s) → STALE (link open, heartbeat older than 10 s) → DISCONNECTED (transport closed: `isOnline=false`, `status=OFFLINE`).
On reconnect: re-AUTH, then resume `HEARTBEAT{commitmentId,fence}` immediately if you hold a mission. The probe proof restarts from nothing.

## 4. Telemetry — `TELEMETRY`, Pi → BE

- **Rate:** 1–2 s, max 10 Hz, at least 100 ms apart.
- **Unsolicited frames:** send one immediately on any safety or fault transition.
- **Acknowledgement:** none.

```jsonc
{
  // ── required in every frame ───────────────────────────── EXISTS
  "timestamp": 1758700000123,   // epoch ms, YOUR clock, NTP/chrony-synchronised. The instant the values were measured.
  "sequence": 4812,             // strictly increasing integer per robot
  "status": "IDLE",             // IDLE | ACTIVE | PAUSED | ERROR | ISSUES | RETURNING | CHARGING
                                //   ACTIVE→CHARGING is refused; go via IDLE or PAUSED. An unknown value is dropped.

  // ── position: only from a real fix at `timestamp` ─────── lat/lon EXIST, `position` block PROPOSED
  "lat": 12.93541, "lon": 77.53452,          // WGS-84 decimal degrees. OMIT both if there is no fix.
  "position": { "fixType": "3D", "hAccM": 2.1, "satellites": 14, "source": "GNSS" },
                                             // fixType: NO_FIX|2D|3D|RTK_FLOAT|RTK_FIXED. NO_FIX ⇒ omit lat/lon.
  "localisation": {                          // PROPOSED. Omit until corroboration really exists.
    "confidence": 0.93,                      // 0..1
    "corroborations": [ { "kind": "ODOMETRY", "available": true, "divergenceM": 0.8 } ]
  },                                         // kind: INDEPENDENT_FIX | MAP_MATCH | ODOMETRY

  // ── safety: the complete current state, every frame ─── PROPOSED
  "safety": {
    "observedAtMs": 1758700000100,
    "estop": { "present": false },           // true ONLY if a physical e-stop circuit exists and is read.
                                             // If present: { "present": true, "engaged": false }. Only boolean false clears it.
    "safetyStop": { "active": false, "latched": false, "reason": null },  // ESP32 SAFETY_STOP / safety_stop
    "motorDriveAvailable": true,             // ESP32 motor_drive_available
    "commandTimeout": false                  // ESP32 COMMAND_TIMEOUT
  },

  // ── faults: the COMPLETE active set, every frame ──────── PROPOSED
  "faults": [
    { "code": "REAR_TOF_1_TIMEOUT", "severity": "DEGRADED", "component": "SENSOR", "active": true, "sinceMs": 1758699990000 }
  ],                                         // severity: INFO | DEGRADED | BLOCKING | CRITICAL (exactly these)
                                             // component: PI | ESP32 | LINK | SENSOR | CAMERA | MOTOR | GNSS | POWER
                                             // []  = measured, nothing active.  Omit = not measured.

  // ── energy: MEASURED values only ─────────────────────── battery EXISTS, `energy` block PROPOSED
  "battery": 71.5,                           // PERCENT 0..100. Send ONLY a measured SoC, else omit.
  "energy": { "socMethod": "BMS", "packVoltageV": 7.02, "packCurrentA": -1.4 },
                                             // socMethod: BMS | COULOMB_COUNTING | VOLTAGE_CURVE_CALIBRATED

  // ── optional ─────────────────────────────────────────── EXISTS
  "speed": 0.0,                              // m/s
  "heading": 270,                            // degrees; shown, not persisted
  "distanceTravelled": 1423                  // cumulative metres
}
```

**Freshness.** The backend judges freshness against **its** decision time, using your `timestamp`.

- Budget: `connectivity.max_heartbeat_age`, currently 10 s.
- Old data becomes *stale*. It is never re-stamped, and a stale safety reading is never read as SAFE.
- A `timestamp` in the future (clock ahead) is refused. The PROPOSED bound is 500 ms.
- **Keep the Pi clock disciplined.** A drifting clock makes the robot either unassignable or wrongly fresh.

## 5. Missions (engine path) — EXISTS

Missions arrive as signed **command envelopes**. The Socket.IO event name is the command name.

```jsonc
// event "OFFER"
{ "outboxId": "…", "command": "OFFER", "commandClass": "MISSION", "fenceScope": "COMMITMENT",
  "agentId": "RBX-01", "commitmentId": "…", "fence": "42", "authorityEpoch": null, "fenceFloor": null,
  "sequence": 7, "notValidAfter": "2026-09-24T10:00:20.000Z", "signature": "…",
  "payload": { "commitmentId": "…", "fence": "42", "legId": "…", "taskId": "T-123",
               "stopSequence": [ { "sequence": 1, "stopType": "PICKUP", "siteId": "…", "lat": …, "lon": …,
                                   "projectedArrivalMs": …, "departureMs": …,
                                   "path": [ { "lat": …, "lon": … } ], "pathDistanceMeters": … } ],
                                   // a stop with no `path` is not executable → OFFER_REJECT "NO_EXECUTABLE_PATH"
               "payloadManifest": [], "energyReserveParams": null, "targetSoc": null,
               "offerExpiry": "2026-09-24T10:00:20.000Z" } }
```

1. **Admit or refuse the envelope** (reference: `VirtualRobot._admitEnvelope`):
   - `agentId` must equal your `robotId`.
   - `notValidAfter` must still be in the future.
   - The signature must verify when a signing key is provisioned.
   - `fence` must be greater than or equal to your per-commitment high-water mark and greater than or equal to `fenceFloor`.
   - `sequence` must be new.
   - **Persist the high-water marks before acting.**
2. **Acknowledge delivery:** `COMMAND_ACK {"outboxId":"…","fence":"42","authorityEpoch":null}`. Send this for every admitted engine command.
3. **Answer the OFFER before `offerExpiry`** (20 s). An unanswered offer is withdrawn and the robot is excluded.
   - `OFFER_ACCEPT {"commitmentId":"…","fence":"42"}`
   - `OFFER_REJECT {"commitmentId":"…","fence":"42","reason":"BATTERY_BELOW_MISSION_NEED"}`. **Reject whenever you cannot execute the mission safely.** A rejection is a safety signal, not a failure.
   - `OFFER_DEFER {"commitmentId":"…","fence":"42","until":<epoch ms>,"reason":"…"}`
4. **While executing:**
   - Send `HEARTBEAT{commitmentId,fence}` every 2 s.
   - Send telemetry with real fixes: at least 10 fixes per minute, and no gap over 10 s.
   - The **server** detects departure and arrival from your fixes; the arrival radius is 25 m in V1. Do not report them.
5. **Custody.** When the payload is physically loaded, send `CUSTODY_EVENT {"commitmentId":"…","fence":"42","kind":"ACQUIRED"}`. When it is handed over, send `kind:"RELEASED"`. A report is applied only after the server has verified you reached that stop. An early report is held until then.
6. **Completion.** After the last stop, send `TASK_COMPLETE {"taskId":"<payload.taskId>","lat":…,"lon":…,"timestamp":…}`.
   - The backend grades it against your track and the commanded route.
   - The reply is `TASK_COMPLETE_ACK {taskId}`, or `{taskId, verifying:true}` when the evidence is insufficient. In that case an operator reviews the task; do **not** repeat the claim.
7. **Withdrawal.** On `WITHDRAW`, `RECALL` or `ABORT_MISSION` for a commitment: stop that mission, discard it, tombstone the commitment id, and send `COMMAND_ACK{outboxId,fence,authorityEpoch}` echoing that command's own envelope. The backend refuses a mission command's ACK whose `fence` is missing, null, malformed, or not that row's fence.
8. **Other engine commands.** `REROUTE`, `RESEQUENCE`, `RESUME`, `TRANSFER_CUSTODY`, `STAND_DOWN_ALL`, `QUARANTINE`, `RELEASE_QUARANTINE`, `ESTOP_CLEAR`, `SHARD_MIGRATE` and `PARAMETER_PUSH` have no backend producer today. Admit them through the same checks, ACK them, and on an unfamiliar one do nothing physical.

`TASK_ASSIGN` is legacy restart recovery. It is not how the engine assigns missions.

## 6. Faults — EXISTS, with a PROPOSED successor

- `ROBOT_FAULT {"code":"…","message":"…","sensor":"…","blocking":true}` is **edge-triggered**. It forces `status=ERROR`, and only an operator can clear that. Omitting `blocking` counts as blocking.
- Use it for a new blocking fault. Keep reporting the full `faults[]` set in telemetry (§4). **Never** report yourself healthy to clear an error: a self-reported recovery is refused under the engine.

## 7. Operator commands — EXISTS

| Event | Payload | You must |
|---|---|---|
| `COMMAND` | `{"commandId":"…","type":"STOP"\|"PAUSE"\|"RETURN"\|"RESUME","timestamp":…}` | apply it, then `COMMAND_ACK {"commandId":"…"}`. **Idempotent per `commandId`:** on redelivery, re-ACK without re-applying. The backend re-sends at 5, 10 and 15 s. Do **not** ACK an unknown `type`. |
| `STOP` | `{"taskId":"…","reason":"TASK_CANCELLED","timestamp":…}` | stop that task. No ACK. This is **distinct** from `COMMAND type STOP`. |

These are requests. The ESP32's gates still apply, and the backend never claims they achieve a safe state.

## 8. Disconnect and reconnect — EXISTS

- Keep reconnection enabled: infinite attempts, backoff up to 10 s.
- On every `connect`: `AUTH` with the token, then `HEARTBEAT`, then `TELEMETRY`.
- A newer connection safely displaces the old one.
- A mission survives a short outage only through its 60 s lease. Beyond that it is reassigned, or held as custody if you already have the goods.

## 9. What the rover cannot supply today

Status is **NOT CURRENTLY AVAILABLE**. Do not fake any of these.

| Needed by the backend | Today | Consequence |
|---|---|---|
| E-stop state (F7) | no confirmed e-stop circuit | send `"estop":{"present":false}`. RobotX is **unassignable** until real hardware exists. |
| Position | NEO-9M on the ESP32 I2C bus, "not driven"; no Pi path | omit `lat`/`lon`. Not indexed, never a candidate. |
| Localisation corroboration (F10) | encoders wired, no encoder feature | omit `localisation` |
| Battery SoC, voltage, current | no sense circuit | omit `battery` and `energy` |
| Link quality, pack/ambient temperature | none | omit |

Available now through the ESP32 UART, and worth forwarding: `state` (`SAFETY_STOP`, `SENSOR_FAULT`, `COMMAND_TIMEOUT`, …), `safety_stop`, `motor_drive_available`, `pca_status`, `tca_status`, front/rear sensor health. These map into `safety` and `faults`. **`SAFETY_STOP` is a proximity stop. Never report it as an e-stop.**

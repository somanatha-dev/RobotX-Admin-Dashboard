# Physical fleet: bringing a physical RobotX into assignment (Gate 1)

A physical robot is assigned by the **same** engine, offer and completion path as a virtual one.
What differs is where its inputs come from: real rows, the Pi's live reports, and an
owner-authored **physical fleet declaration** for the things the rover cannot measure.

## Owner decisions this rests on (2026-10-03)

| Gap on the rover | Decision | Where it lives |
|---|---|---|
| No battery ADC | Operator-declared SoC, expires after `stateOfCharge.maxAgeSeconds` | `POST /api/robots/:id/soc-declaration` |
| No hardware e-stop | The Pi-reported **software stop latch** satisfies F7, labelled `SOFTWARE_STOP_LATCH` | TELEMETRY `safety.stopLatch` |
| No temperature sensor | Declared site ambient range; pack taken at the worst case | `site.ambientC` |
| No fitted energy model | β from the declared idle and moving power draw; left uncalibrated | `robots[].energy` |

Also declared there: manual charging (`MANUAL_OUT_OF_SERVICE`), flat terrain, no constrictions
and no Wi-Fi dead zones, the fix-quality mapping for localisation, and a failure prior. Any
section left out turns its policy off, and the engine keeps refusing the robot by name.

## Enable it

1. Copy `physical-fleet.declaration.example.json`, replace every `REPLACE:` value, and enter
   the real power draw and the unit's `robotId`.
2. Start the backend with:
   ```
   PHYSICAL_FLEET_ENABLED=true
   PHYSICAL_FLEET_DECLARATION_FILE=<path to your declaration>
   AGENT_PROBE_INTERVAL_MS=2000          # F14/F15 need the PROBE round trip
   COMMAND_SIGNING_KEY=<the key the Pi verifies OFFERs with>
   ```
   With the simulator on (the V1 launcher), physical and virtual robots share one fleet. With no
   simulator, the process composes physical-only (see the blocker below about chargers).
3. Boot applies the declaration to the engine rows (β, SoH, envelope, firmware set, compartment)
   and puts each declared unit in service in its region. The log line
   `[physical] declaration applied to engine rows` lists each unit's result.

## Per unit, per shift

1. Commission once: `POST /api/robots/commission` (or an existing unit: the same call re-mints
   its 6-digit pairing code, valid 300 s). A **retired** unit is refused here; bring it back with
   `POST /api/robots/<robotId>/recommission` first (see [robot-recommissioning.md](robot-recommissioning.md)).
   It returns as `COMMISSIONED`. It is put back in service by its declaration: at the next boot, or
   without a restart with `POST /api/robots/<robotId>/physical-declaration/apply` (below).
2. Declare its state of charge: `POST /api/robots/<robotId>/soc-declaration {"socPct": 85}`.
3. The Pi connects and sends, every 2 s:
   - `HEARTBEAT` (`{commitmentId, fence}` while it holds a mission);
   - `TELEMETRY` with `timestamp`, `sequence`, `lat`, `lon`,
     `position: {fixType: "3D", hAccM: 1.5}` (set `deadReckoned: true` for an extrapolated fix),
     and `safety: {stopLatch: {engaged: false}}`;
   - `PROBE_RESULT` for every `PROBE`.

The robot becomes a candidate once all of these are live: a fresh SoC declaration, a fix the
declaration accepts within 5 m of a permitted campus way, an unengaged stop latch, and a
recent probe answer on its current socket.

## Adding a physical unit, and putting one in service (2026-10-18)

The declaration file is the **only** source of a unit's declared values. One file declares any
number of units; nothing in the code names a unit.

**Validation.** At boot the file is validated section by section and unit by unit. The log line
`[physical] physical fleet declaration loaded` lists the declared units and every problem.
- A unit entry with any missing or invalid field declares nothing for that unit. Its problems are
  named (`robots[<robotId>]: …`). The other units are unaffected.
- A `robotId` that appears **twice** is refused outright. Neither entry is used.
- `robots` that is not a list declares nobody, and says so.
- A missing or unreadable file turns every section off and does not stop the boot. Check the log.

**Adding unit N:**
1. Commission it (dashboard Commission page / `POST /api/robots`, `simulated: false`).
2. Add one entry to the declaration with its `robotId`, the existing `control.regionId`
   (a `Region.regionId`, e.g. `rnsit`), `authorisation: "REGION"`, the attested firmware and
   hardware revision, and its measured `energy` draws.
3. Restart the backend so the file is re-read. Boot applies every entry. The log line
   `[physical] declaration applied to engine rows` shows, per unit, `activated` and
   `lifecycleState`. A held or retired unit is listed `activated: false`. It is never re-activated.

**Putting ONE declared unit in service without a restart** (a unit recommissioned, or commissioned,
after the backend booted):

```
POST /api/robots/<robotId>/physical-declaration/apply
{ "reason": "<why>", "confirmRobotId": "<robotId>" }        # elevated role required
```

- **What it applies:** the declaration this backend **already loaded**. It never re-reads the file
  and never takes a value from the request.
- **What it requires:** a physical unit that is `COMMISSIONED` or `ACTIVE`.
- **Refusals (409):**
  - `PHYSICAL_FLEET_DISABLED`
  - `NOT_DECLARED`, with the entry's problems
  - `NOT_PHYSICAL`
  - `ROBOT_RETIRED`: recommission first
  - `LIFECYCLE_HELD`: QUARANTINED or MAINTENANCE
  - `NO_REGION`
  - `NOT_APPLIED`: a concurrent retirement won
- **Audit:** it writes an Event row in the same transaction.

**ACTIVE is not assignable.** The unit must still meet all of the following. Each is checked
separately:
- a fresh operator SoC declaration and a measured position, for the index;
- a qualified fix younger than 10 s, for F10 and F16;
- an unengaged stop latch on the current socket, for F7;
- a probe answer, for F14;
- the agent's readiness report, for F8;
- a contained route and energy per task (RD-2026-10-12-01 AC1).

**Off campus:** a unit whose start point is outside the declared operating boundary cannot be
routed. This is AC1, an owner policy, not a defect. Bring the unit inside through the separately
approved site-entry procedure.

## Readiness and diagnosis (2026-10-18)

- **See every blocker at once:** `GET /api/diagnostics/readiness/<robotId>` (operator login).
  It reports visible / connected / lifecycle / indexed / position freshness / the Pi's readiness
  report / battery provenance, and evaluates every agent-level predicate with `collectAll`.
  For a physical unit it also reports `declaration` and three blockers:
  - `PHYSICAL_FLEET_DISABLED`: this backend loaded no declaration.
  - `NOT_DECLARED`: the unit is absent from the file, or its entry is invalid; the entry's problems are listed.
  - `DECLARATION_NOT_APPLIED`: the unit is declared, but its engine rows are not bound to the declared region.
  Assignment itself still stops at the first denial, so a task card shows only the first.
- **The Pi's readiness report** (TELEMETRY `readiness: {blockers: [...]}`, see the contract §4)
  restricts eligibility whenever it is sent. To make a missing report blocking, add
  `"readiness": { "policy": "AGENT_REPORT_REQUIRED" }` to the declaration. Do this only once the
  deployed Pi sends the block, or the robot becomes unassignable by design.
- **A readiness refusal** (`NO_MOTOR_LINK`, `NO_POSITION_FIX`, `NO_CUSTODY_SENSING`,
  `ESTOP_LATCHED`, `AGENT_ERROR`) holds the robot from every Leg for `dispatch.nack_cooloff`, or
  until it reports `blockers: []`.
- **A demo battery** must be labelled `energy.batterySource: "DEMO_SIMULATION"`. It is shown as
  such and never planned with. An operator SoC declaration is still the only SoC the engine uses.

## Proof

`node tools/verify/gate1PhysicalOffer.js --database-url <disposable local db>` seeds a mixed fleet,
starts the real server with the physical fleet enabled, pairs a Pi stand-in, and checks that the
physical unit receives an OFFER that verifies (HMAC, addressee, expiry, tamper rejected) and is
ACKED and ACCEPTED. Disposable databases only.

## Known limits (tracked, not hidden)

- **Physical-only process and chargers.** The charger availability projection is published only
  by the simulator's development charging scheduler. With no simulator, the return-to-charger
  energy check has no projection. Run mixed until a physical charging source exists (B2).
- **Declared SoC does not decay.** It is held until it expires. Keep `maxAgeSeconds` short and
  re-declare after each mission or shift.
- **The laptop clock must be within 500 ms.** Run as Administrator:
  `w32tm /config /manualpeerlist:"time.windows.com,0x9" /syncfromflags:manual /update` then
  `w32tm /resync /force`.

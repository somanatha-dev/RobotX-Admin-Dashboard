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
   its 6-digit pairing code, valid 300 s).
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

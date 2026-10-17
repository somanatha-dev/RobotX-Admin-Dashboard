# RobotX-Pi task: readiness report and demo-battery label

**Status:** the backend side is implemented (2026-10-18, feature/dashboard, not yet deployed). The Pi side is **not started**. Nothing in the Pi repository was changed by the backend work.

**Contract:** [PHYSICAL_ROBOTX_BACKEND_CONTRACT.md](PHYSICAL_ROBOTX_BACKEND_CONTRACT.md) §4 (TELEMETRY) and §5 (OFFER_REJECT scopes).

## Why

`status: IDLE` is the Rover's operating mode. On 2026-10-17 RBT-2000 reported IDLE while:
- the ESP32 UART had received 0 bytes;
- GPS was STARTING;
- motion was disabled.

The backend had no way to see that until it sent an offer and the Pi refused it. The Pi's `RobotAgent.assess_offer` already computes exactly the facts the backend needs, in the same order and vocabulary as the refusals.

## P-1. Send `readiness` on every TELEMETRY frame

```jsonc
"readiness": { "blockers": ["NO_MOTOR_LINK", "NO_POSITION_FIX"] }   // [] when nothing blocks
```

- **Derive it from the same checks as `assess_offer`, without the offer-specific part:**
  1. `ESTOP_LATCHED` when `safety.estop_engaged`.
  2. `AGENT_ERROR` when the mode is ERROR.
  3. `NO_MOTOR_LINK` when the ESP32 link is not up, or `esp32.status().motion_ready` is false. That includes `esp32_motion_enabled=false`.
  4. `NO_POSITION_FIX` when there is no measured, fresh, navigator-usable fix.
  5. `NO_CUSTODY_SENSING` when `custody_sensing_available()` is false.
- **Do not** include `MISSION_IN_PROGRESS` or `NO_EXECUTABLE_PATH`. They are about a particular offer, not the Rover.
- **Report every blocker that applies,** not only the first.
- **The block is stamped by the frame's `timestamp`,** like everything else in the frame.
- **Never send `[]` while the Pi cannot evaluate a check.** Omit the block instead. Omitted reads as "not reported", which is safe; `[]` reads as "nothing blocks".
- **Keep the key names exactly.** Keys matching `capabilit*`, `certification*`, `clearance` and similar cause the whole frame to be dropped.

## P-2. Label the demo battery

When `ROBOTX_DEMO_BATTERY_ENABLED=1` produces the `battery` value, also send:

```jsonc
"energy": { "batterySource": "DEMO_SIMULATION" }
```

- **Never** send `socMethod` with a simulated value.
- The backend already refuses a basis-less physical `battery` as SoC. The label makes the dashboard say DEMO_SIMULATED instead of UNVERIFIED.

## P-3. Keep the refusal codes exact

The backend classifies `OFFER_REJECT.reason` by the part before the first `:`.
- `ESTOP_LATCHED`, `AGENT_ERROR`, `NO_MOTOR_LINK`, `NO_POSITION_FIX` and `NO_CUSTODY_SENSING` hold the Rover from every Leg for 120 s, or until a later readiness report shows `[]`.
- `NO_EXECUTABLE_PATH` is about one Leg only.
- Renaming a code silently turns it into an unclassified, per-Leg refusal.

## P-4. `register` is not part of the contract

The backend has no `register` listener. Whether a robot is physical or simulated, and what it can do, come from commissioning and the owner's declaration, never from the agent. Drop it from the Pi's binding, or document it there as unused.

## Acceptance (Pi side)

1. **Host tests, no hardware:**
   - With the ESP32 link down, every frame carries `blockers` containing `NO_MOTOR_LINK`.
   - With no fix, it contains `NO_POSITION_FIX`.
   - With everything up, it is `[]`.
   - A frame never carries `[]` while a check is unevaluable.
2. **Demo battery:** every demo frame carries `energy.batterySource: "DEMO_SIMULATION"` and never `socMethod`.
3. **Against a disposable backend:**
   - `robot:update.readiness` shows the blockers.
   - `GET /api/diagnostics/readiness/<robotId>` lists them as `AGENT_NOT_READY:<code>`.
4. **Owner opt-in, only after (1)–(3):** set `"readiness": {"policy": "AGENT_REPORT_REQUIRED"}` in the physical fleet declaration.

-- ROBOT SPECIFICATION — the operator-entered configuration of a commissioned unit.
--
-- ── Why only three columns ──────────────────────────────────────────────────
-- The Admin UI collects six specification values and a chassis type. Four of the six
-- already have a field in this schema that means exactly them, and this migration adds
-- nothing for those: battery capacity is `EnergyModel.packNominalWh`, payload capacity is
-- `ContainerModel.totalMassLimitKg`, and the two speeds are `MobilityModel.kinematicLimits`
-- and `MobilityModel.speedModel`. Adding a second column for any of them would be a second
-- place the same fact lives, and the decision path reads the existing one — F22 reads the
-- container model, §14.1's energy feasibility reads the pack — so a duplicate would be a
-- value the engine never sees.
--
-- Three columns have no existing home, and each is here for a stated reason:
--
--   * `Robot.massKg` — no column in this schema carries a vehicle's mass, and §14.2's
--     consumption equation has a `β_mass` term.
--
--   * `Robot.batteryReservePct` — the **unit's own** hardware protection floor. This is
--     deliberately not §14.5's reserve stack, which is four additive layers composed in
--     watt-hours from published register parameters at decision time
--     (`src/engine/energy/reserves.js`). Writing an operator-entered percentage into that
--     stack would be a calibration value nobody calibrated, so the two are kept apart.
--
--   * `AgentClass.chassisType` — the chassis family (ROVER / DRONE). It sits on the class
--     because §2.1 already makes the class "what keys every model-specific parameter set";
--     a type column on the legacy `Robot` row would be a second type system, and the two
--     would eventually disagree.
--
-- ── Additive, nullable, defaulted by nothing ────────────────────────────────
-- Every existing row stays valid and no existing write path acquires a new requirement.
-- Nullable rather than defaulted, because a default would assert a mass, a reserve or a
-- chassis family that nobody entered — and the specification pages would then display an
-- invented number as though an operator had chosen it.
--
-- ── The chassis family is NOT how a requested class is matched ──────────────
-- `AgentClass.chassisType` is for display and administration. A task requesting a rover is
-- matched through §2.3's typed algebra — the `chassis_type` capability on the agent's
-- `CapabilityBundle`, evaluated by predicate F21 — which needs no schema change at all,
-- because `Capability` already carries an `ENUMERATED` kind and `Task.requirements` is
-- already §2.4's RequirementSet column. A second matching route would be a second set of
-- semantics to keep in step with the first.

ALTER TABLE "Robot" ADD COLUMN "massKg" DOUBLE PRECISION;
ALTER TABLE "Robot" ADD COLUMN "batteryReservePct" DOUBLE PRECISION;

ALTER TABLE "AgentClass" ADD COLUMN "chassisType" TEXT;

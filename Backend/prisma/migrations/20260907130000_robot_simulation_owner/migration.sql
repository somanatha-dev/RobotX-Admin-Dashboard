-- SIMULATION OWNERSHIP — one nullable owner column, and one partial unique index that is
-- the actual product rule.
--
-- ── The rule ────────────────────────────────────────────────────────────────
--   > One authenticated User may own at most ONE simulated Robot AT A TIME.
--
-- "At a time", not "ever": the constraint is over live rows, so deleting the robot
-- vacates the slot and the same user may create a replacement. Nothing records history.
--
-- ── Why the index and not a SELECT-then-INSERT ──────────────────────────────
-- Two concurrent creation requests from the same user both run their pre-check before
-- either inserts, both see no existing simulated robot, and both insert. That is not a
-- rare interleaving — it is what a double-clicked button produces. The application's
-- pre-check is kept because it produces a better message than a constraint violation
-- does, but it is not the rule. This index is the rule, and the service maps its
-- violation (Prisma P2002) onto the same 409 the pre-check returns, so the two paths are
-- indistinguishable to a caller.
--
-- ── Why PARTIAL, on both conditions ─────────────────────────────────────────
--   * `WHERE "simulationOwnerId" IS NOT NULL` — every physical robot carries NULL here.
--     PostgreSQL's plain UNIQUE already permits repeated NULLs, so this half is not
--     strictly load-bearing; it is stated because the index's purpose is a statement about
--     owned rows, and a reader should not have to recall NULL semantics to see that the
--     physical fleet is unconstrained.
--   * `WHERE "simulated"` — this half IS load-bearing. It scopes the constraint to exactly
--     the population the product rule names. Without it the column would silently become a
--     general "one robot per user" rule, which is a different and much larger claim than
--     the one anybody agreed to, and it would be the constraint a future physical-ownership
--     feature collided with.
--
-- ── Additive and reversible ─────────────────────────────────────────────────
-- Every existing row gets `simulationOwnerId = NULL`. Combined with the `simulated`
-- column's own `DEFAULT false` from `20260907120000`, the whole existing fleet reads as
-- "physical, unowned" — no insert path acquires a requirement, and no read path acquires
-- one either. Dropping the index and the column restores the prior schema exactly.
--
-- ── ON DELETE SET NULL ──────────────────────────────────────────────────────
-- Deleting a user account must not destroy fleet rows. The simulated robot survives as an
-- unowned row, which occupies nobody's slot because the index is partial on NOT NULL.

ALTER TABLE "Robot" ADD COLUMN "simulationOwnerId" TEXT;

ALTER TABLE "Robot"
  ADD CONSTRAINT "Robot_simulationOwnerId_fkey"
  FOREIGN KEY ("simulationOwnerId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The invariant. Named so a P2002 can be attributed to it by name rather than by guessing
-- from a column list.
CREATE UNIQUE INDEX "Robot_one_simulated_per_owner"
  ON "Robot" ("simulationOwnerId")
  WHERE "simulated" AND "simulationOwnerId" IS NOT NULL;

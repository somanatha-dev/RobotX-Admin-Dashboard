-- RBAC step 2 of 2 — an administrator's campus, account deactivation, and the one
-- authoritative campus → operating-region link. Additive: no existing row is rewritten.

-- ── User ─────────────────────────────────────────────────────────────────────
-- The campus a regular ADMIN may act in. RESTRICT: a campus that still has administrators
-- cannot be deleted out from under them (deleting it would leave an ADMIN with no campus,
-- which the CHECK below forbids anyway).
ALTER TABLE "User" ADD COLUMN "campusId" TEXT;
ALTER TABLE "User" ADD COLUMN "disabledAt" TIMESTAMP(3);

ALTER TABLE "User"
    ADD CONSTRAINT "User_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "User_campusId_idx" ON "User"("campusId");

-- A new row that names no role is an ADMIN — and, with no campus, the CHECK refuses it.
-- The old default (SUPER_ADMIN) meant any code path that forgot the role created a
-- platform administrator; this one means it creates nothing.
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'ADMIN';

-- Exactly one campus for an ADMIN, none for a SUPER_ADMIN. Every existing row is a
-- SUPER_ADMIN with no campus column value, so it satisfies this as it stands.
ALTER TABLE "User"
    ADD CONSTRAINT "User_role_campus_scope" CHECK (
        ("role" = 'SUPER_ADMIN' AND "campusId" IS NULL)
        OR ("role" = 'ADMIN' AND "campusId" IS NOT NULL)
    );

-- ── Campus ───────────────────────────────────────────────────────────────────
-- The operating region a campus's tasks and agents belong to. `Campus.code` and
-- `Region.regionId` are different identifiers and nothing linked them; this column is the
-- link. Unique: one region belongs to at most one campus, so two campuses' administrators
-- can never both be scoped to the same tasks. SET NULL: a deleted region leaves its campus
-- with no region, which denies region-owned resources rather than widening anything.
-- Deliberately not backfilled: which region a campus operates in is per-environment data,
-- set by a SUPER_ADMIN (PATCH /api/campuses/:id), never guessed by a migration.
ALTER TABLE "Campus" ADD COLUMN "regionId" TEXT;
ALTER TABLE "Campus"
    ADD CONSTRAINT "Campus_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Campus_regionId_key" ON "Campus"("regionId");

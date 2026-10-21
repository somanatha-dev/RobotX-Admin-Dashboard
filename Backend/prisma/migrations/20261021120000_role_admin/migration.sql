-- RBAC step 1 of 2 — the regular, campus-scoped administrator role.
--
-- On its own because PostgreSQL refuses to use an enum value in the transaction that adds
-- it ("unsafe use of new value"), and step 2 both defaults to it and names it in a CHECK.
-- Additive: no existing row changes. Every current account is SUPER_ADMIN and stays so.

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ADMIN';

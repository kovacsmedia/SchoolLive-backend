-- Tenant: új JSONB oszlop a tenant-szintű "internetrádió alapértelmezett"
-- preset lista tárolásához. A frontend SchoolRadio oldal "Alapértelmezetté
-- tesz" gombja menti ide a current listát; új felhasználók ezt látják először.
--
-- IDEMPOTENS: ha valamiért már létezett (pl. `prisma db push` korábban),
-- az IF NOT EXISTS átsiklik rajta. JSONB típus a Postgres-en standard,
-- a Prisma `Json?` mező ezzel kompatibilis.

ALTER TABLE "Tenant"
  ADD COLUMN IF NOT EXISTS "netRadioPresetsJson" JSONB;

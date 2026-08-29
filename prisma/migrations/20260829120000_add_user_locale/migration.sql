-- Lokalizáció: a User felület-nyelv preferenciája. Idempotens (IF NOT EXISTS),
-- a projekt meglévő migrációs stílusát követve.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "locale" TEXT NOT NULL DEFAULT 'hu';

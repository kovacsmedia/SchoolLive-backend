-- Futtatás:
-- sudo -u postgres psql -d schoollive -c "ALTER TABLE \"User\" ADD COLUMN IF NOT EXISTS \"lastSeenAt\" TIMESTAMPTZ;"

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMPTZ;
-- Futtatás: psql -U deploy -d schoollive -h 127.0.0.1
-- Vagy: sudo -u deploy psql schoollive

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "activeSessionId" TEXT;

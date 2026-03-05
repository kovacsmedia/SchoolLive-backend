-- Message tábla bővítése
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "text"     TEXT;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "voice"    TEXT;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "playedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Message_tenantId_createdAt_idx" ON "Message"("tenantId", "createdAt");

-- MessageTemplate tábla
CREATE TABLE IF NOT EXISTS "MessageTemplate" (
  "id"        TEXT NOT NULL,
  "tenantId"  TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "text"      TEXT NOT NULL,
  "voice"     TEXT NOT NULL DEFAULT 'anna',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MessageTemplate_tenantId_userId_idx" ON "MessageTemplate"("tenantId", "userId");

ALTER TABLE "MessageTemplate"
  ADD CONSTRAINT "MessageTemplate_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MessageTemplate"
  ADD CONSTRAINT "MessageTemplate_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
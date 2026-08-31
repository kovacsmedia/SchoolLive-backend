-- Multi-session támogatás: a régi User.activeSessionId (egyetlen mezős,
-- minden új bejelentkezéskor felülíródó) helyett minden sikeres login egy
-- ÚJ UserSession sort kap. A régi activeSessionId/lastSeenAt/sessionExpiresAt
-- oszlopokat SZÁNDÉKOSAN nem töröljük (nincs rájuk kódhivatkozás többé, de
-- egy sima DROP COLUMN kockázata nagyobb, mint a haszna egy pár üres mezőért).

CREATE TABLE IF NOT EXISTS "UserSession" (
  "id"         TEXT PRIMARY KEY,
  "userId"     TEXT NOT NULL,
  "sessionId"  TEXT NOT NULL UNIQUE,
  "clientType" TEXT NOT NULL DEFAULT 'web',
  "clientKey"  TEXT,
  "userAgent"  TEXT,
  "ipAddress"  TEXT,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "lastSeenAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "UserSession_userId_idx" ON "UserSession"("userId");

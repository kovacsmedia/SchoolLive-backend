-- Idempotens migráció: IF NOT EXISTS mindenhol

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'YoutubePlaylistStatus') THEN
    CREATE TYPE "YoutubePlaylistStatus" AS ENUM ('IDLE', 'BUILDING', 'DONE', 'ERROR');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "YoutubePlaylist" (
  "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "tenantId"    TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "status"      "YoutubePlaylistStatus" NOT NULL DEFAULT 'IDLE',
  "errorMsg"    TEXT,
  "radioFileId" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "YoutubePlaylist_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "YoutubePlaylistItem" (
  "id"         TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "playlistId" TEXT NOT NULL,
  "youtubeUrl" TEXT NOT NULL,
  "title"      TEXT,
  "sortOrder"  INTEGER NOT NULL,
  CONSTRAINT "YoutubePlaylistItem_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'YoutubePlaylist_radioFileId_key'
  ) THEN
    ALTER TABLE "YoutubePlaylist" ADD CONSTRAINT "YoutubePlaylist_radioFileId_key" UNIQUE ("radioFileId");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'YoutubePlaylist_tenantId_fkey') THEN
    ALTER TABLE "YoutubePlaylist" ADD CONSTRAINT "YoutubePlaylist_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'YoutubePlaylist_createdById_fkey') THEN
    ALTER TABLE "YoutubePlaylist" ADD CONSTRAINT "YoutubePlaylist_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "User"("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'YoutubePlaylist_radioFileId_fkey') THEN
    ALTER TABLE "YoutubePlaylist" ADD CONSTRAINT "YoutubePlaylist_radioFileId_fkey"
      FOREIGN KEY ("radioFileId") REFERENCES "RadioFile"("id");
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'YoutubePlaylistItem_playlistId_fkey') THEN
    ALTER TABLE "YoutubePlaylistItem" ADD CONSTRAINT "YoutubePlaylistItem_playlistId_fkey"
      FOREIGN KEY ("playlistId") REFERENCES "YoutubePlaylist"("id") ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "YoutubePlaylist_tenantId_idx"       ON "YoutubePlaylist"("tenantId");
CREATE INDEX IF NOT EXISTS "YoutubePlaylistItem_playlistId_idx" ON "YoutubePlaylistItem"("playlistId");

-- PendingDevice extra mezők (szintén idempotens)
ALTER TABLE "PendingDevice"
  ADD COLUMN IF NOT EXISTS "clientId"  TEXT,
  ADD COLUMN IF NOT EXISTS "userId"    TEXT,
  ADD COLUMN IF NOT EXISTS "userAgent" TEXT;
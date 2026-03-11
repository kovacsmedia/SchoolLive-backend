-- Futtatás a szerveren:
-- sudo -u postgres psql -d schoollive -f migration_youtube_playlist.sql

CREATE TYPE "YoutubePlaylistStatus" AS ENUM ('IDLE', 'BUILDING', 'DONE', 'ERROR');

CREATE TABLE "YoutubePlaylist" (
  "id"          TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "tenantId"    TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "status"      "YoutubePlaylistStatus" NOT NULL DEFAULT 'IDLE',
  "errorMsg"    TEXT,
  "radioFileId" TEXT UNIQUE,
  "createdById" TEXT NOT NULL,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "YoutubePlaylist_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "YoutubePlaylist_tenantId_fkey"    FOREIGN KEY ("tenantId")    REFERENCES "Tenant"("id")    ON DELETE CASCADE,
  CONSTRAINT "YoutubePlaylist_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id"),
  CONSTRAINT "YoutubePlaylist_radioFileId_fkey" FOREIGN KEY ("radioFileId") REFERENCES "RadioFile"("id")
);
CREATE INDEX "YoutubePlaylist_tenantId_idx" ON "YoutubePlaylist"("tenantId");

CREATE TABLE "YoutubePlaylistItem" (
  "id"         TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "playlistId" TEXT NOT NULL,
  "youtubeUrl" TEXT NOT NULL,
  "title"      TEXT,
  "sortOrder"  INTEGER NOT NULL,
  CONSTRAINT "YoutubePlaylistItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "YoutubePlaylistItem_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "YoutubePlaylist"("id") ON DELETE CASCADE
);
CREATE INDEX "YoutubePlaylistItem_playlistId_idx" ON "YoutubePlaylistItem"("playlistId");
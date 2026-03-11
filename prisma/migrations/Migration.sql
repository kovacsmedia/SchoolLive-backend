-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "YoutubePlaylistStatus" AS ENUM ('IDLE', 'BUILDING', 'DONE', 'ERROR');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable YoutubePlaylist
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

-- CreateTable YoutubePlaylistItem
CREATE TABLE IF NOT EXISTS "YoutubePlaylistItem" (
  "id"         TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "playlistId" TEXT NOT NULL,
  "youtubeUrl" TEXT NOT NULL,
  "title"      TEXT,
  "sortOrder"  INTEGER NOT NULL,
  CONSTRAINT "YoutubePlaylistItem_pkey" PRIMARY KEY ("id")
);

-- Unique constraint radioFileId
ALTER TABLE "YoutubePlaylist" DROP CONSTRAINT IF EXISTS "YoutubePlaylist_radioFileId_key";
ALTER TABLE "YoutubePlaylist" ADD CONSTRAINT "YoutubePlaylist_radioFileId_key" UNIQUE ("radioFileId");

-- Foreign keys
ALTER TABLE "YoutubePlaylist" DROP CONSTRAINT IF EXISTS "YoutubePlaylist_tenantId_fkey";
ALTER TABLE "YoutubePlaylist" ADD CONSTRAINT "YoutubePlaylist_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE;

ALTER TABLE "YoutubePlaylist" DROP CONSTRAINT IF EXISTS "YoutubePlaylist_createdById_fkey";
ALTER TABLE "YoutubePlaylist" ADD CONSTRAINT "YoutubePlaylist_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id");

ALTER TABLE "YoutubePlaylist" DROP CONSTRAINT IF EXISTS "YoutubePlaylist_radioFileId_fkey";
ALTER TABLE "YoutubePlaylist" ADD CONSTRAINT "YoutubePlaylist_radioFileId_fkey"
  FOREIGN KEY ("radioFileId") REFERENCES "RadioFile"("id");

ALTER TABLE "YoutubePlaylistItem" DROP CONSTRAINT IF EXISTS "YoutubePlaylistItem_playlistId_fkey";
ALTER TABLE "YoutubePlaylistItem" ADD CONSTRAINT "YoutubePlaylistItem_playlistId_fkey"
  FOREIGN KEY ("playlistId") REFERENCES "YoutubePlaylist"("id") ON DELETE CASCADE;

-- Indexes
CREATE INDEX IF NOT EXISTS "YoutubePlaylist_tenantId_idx" ON "YoutubePlaylist"("tenantId");
CREATE INDEX IF NOT EXISTS "YoutubePlaylistItem_playlistId_idx" ON "YoutubePlaylistItem"("playlistId");
CREATE TYPE "DeviceClass" AS ENUM ('SPEAKER', 'DISPLAY', 'MULTI');

ALTER TABLE "Device" ADD COLUMN IF NOT EXISTS "deviceClass" "DeviceClass" NOT NULL DEFAULT 'SPEAKER';

CREATE TABLE IF NOT EXISTS "PendingDevice" (
  "id"              TEXT NOT NULL,
  "mac"             TEXT NOT NULL,
  "ipAddress"       TEXT,
  "firmwareVersion" TEXT,
  "firstSeenAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PendingDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PendingDevice_mac_key" ON "PendingDevice"("mac");
CREATE INDEX IF NOT EXISTS "PendingDevice_lastSeenAt_idx" ON "PendingDevice"("lastSeenAt");
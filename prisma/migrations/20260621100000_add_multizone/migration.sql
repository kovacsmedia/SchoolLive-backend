-- DeviceClass enum bővítése MULTIZONE értékkel
ALTER TYPE "DeviceClass" ADD VALUE IF NOT EXISTS 'MULTIZONE';

-- Multizone zóna-mezők
ALTER TABLE "Device"
  ADD COLUMN IF NOT EXISTS "parentDeviceId" TEXT,
  ADD COLUMN IF NOT EXISTS "zoneIndex"      INT;

ALTER TABLE "Device"
  ADD CONSTRAINT IF NOT EXISTS "Device_parentDeviceId_fkey"
  FOREIGN KEY ("parentDeviceId") REFERENCES "Device"("id") ON DELETE CASCADE;

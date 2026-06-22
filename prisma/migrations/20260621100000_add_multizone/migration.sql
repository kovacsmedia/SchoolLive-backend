-- DeviceClass enum bővítése MULTIZONE értékkel
ALTER TYPE "DeviceClass" ADD VALUE IF NOT EXISTS 'MULTIZONE';

-- Multizone zóna-mezők
ALTER TABLE "Device"
  ADD COLUMN IF NOT EXISTS "parentDeviceId" TEXT,
  ADD COLUMN IF NOT EXISTS "zoneIndex"      INT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Device_parentDeviceId_fkey'
  ) THEN
    ALTER TABLE "Device"
      ADD CONSTRAINT "Device_parentDeviceId_fkey"
      FOREIGN KEY ("parentDeviceId") REFERENCES "Device"("id") ON DELETE CASCADE;
  END IF;
END $$;

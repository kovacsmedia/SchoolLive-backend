ALTER TABLE "DeviceProvisionSession" 
ADD COLUMN IF NOT EXISTS "pendingDeviceKey" TEXT;
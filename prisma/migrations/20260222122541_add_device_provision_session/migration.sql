-- CreateTable
CREATE TABLE "DeviceProvisionSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "tenantId" TEXT,
    "name" TEXT NOT NULL,
    "wifiSsid" TEXT NOT NULL,
    "wifiPassword" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceProvisionSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceProvisionSession_tokenHash_key" ON "DeviceProvisionSession"("tokenHash");

-- CreateIndex
CREATE INDEX "DeviceProvisionSession_deviceId_idx" ON "DeviceProvisionSession"("deviceId");

-- CreateIndex
CREATE INDEX "DeviceProvisionSession_expiresAt_idx" ON "DeviceProvisionSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "DeviceProvisionSession" ADD CONSTRAINT "DeviceProvisionSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

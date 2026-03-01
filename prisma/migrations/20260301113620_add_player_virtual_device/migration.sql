/*
  Warnings:

  - A unique constraint covering the columns `[tenantId,clientId]` on the table `Device` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "DeviceAuthType" AS ENUM ('KEY', 'JWT');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'PLAYER';

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "authType" "DeviceAuthType" NOT NULL DEFAULT 'KEY',
ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "userId" TEXT,
ALTER COLUMN "deviceKeyHash" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Device_userId_idx" ON "Device"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_tenantId_clientId_key" ON "Device"("tenantId", "clientId");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

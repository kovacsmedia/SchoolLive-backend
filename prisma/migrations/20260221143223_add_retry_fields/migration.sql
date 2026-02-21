-- AlterTable
ALTER TABLE "DeviceCommand" ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "maxRetries" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0;

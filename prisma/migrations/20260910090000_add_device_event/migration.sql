-- Eszköz-eseménynapló: távoli eszközök újraindulásainak visszanézhetősége.
--
-- A `Device.statusPayload` csak pillanatkép (minden beacon felülírja), egy
-- távoli eszköznél viszont a soros monitor nem elérhető. Egy újraindulási
-- ciklus diagnózisához előzmény kell.
--
-- Tisztán additív: új tábla + indexek, meglévő adatot nem érint.

CREATE TABLE IF NOT EXISTS "DeviceEvent" (
  "id"              TEXT         NOT NULL,
  "tenantId"        TEXT         NOT NULL,
  "deviceId"        TEXT         NOT NULL,
  "type"            TEXT         NOT NULL,
  "resetReason"     INTEGER,
  "uptimeSec"       INTEGER,
  "freeHeap"        INTEGER,
  "minFreeHeap"     INTEGER,
  "firmwareVersion" TEXT,
  "message"         TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeviceEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DeviceEvent_deviceId_createdAt_idx"
  ON "DeviceEvent" ("deviceId", "createdAt");

CREATE INDEX IF NOT EXISTS "DeviceEvent_tenantId_createdAt_idx"
  ON "DeviceEvent" ("tenantId", "createdAt");

DO $$
BEGIN
  ALTER TABLE "DeviceEvent"
    ADD CONSTRAINT "DeviceEvent_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "DeviceEvent"
    ADD CONSTRAINT "DeviceEvent_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

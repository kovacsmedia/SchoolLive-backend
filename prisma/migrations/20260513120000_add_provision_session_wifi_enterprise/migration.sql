-- DeviceProvisionSession: WPA2 Enterprise / hidden SSID támogatás
--
-- A korábbi schema csak WPA2 Personal-t ismert (wifiSsid + wifiPassword).
-- A Phase 8b óta a frontend admin UI küldhet WPA2 Enterprise hálózati
-- credentialst (eduroam: wifiUser email + wifiPassword), illetve rejtett
-- SSID-t (broadcast nélküli AP), ezek a session-en is megjelennek hogy
-- az ESP `/provision/status/:pendingId` válaszában megkapja őket.

ALTER TABLE "DeviceProvisionSession"
  ADD COLUMN "wifiHidden"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "wifiSecurity" TEXT    NOT NULL DEFAULT 'WPA2_PERSONAL',
  ADD COLUMN "wifiUser"     TEXT    NOT NULL DEFAULT '';

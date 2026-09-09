-- Eszközkulcs gyors kereséséhez: a device key SHA-256 lenyomata, indexelve.
--
-- Eddig minden eszköz-hitelesítés (WS csatlakozás, /devices/native/*, /bells/*,
-- /firmware/*) VÉGIGOLVASTA az ÖSSZES eszközt, és soronként bcrypt.compare-t
-- futtatott – ez eszközszámmal lineáris, bcryptenként ~50-100 ms CPU. Egy
-- backend-újraindítás utáni tömeges újracsatlakozásnál ez percekig 100% CPU.
--
-- A bcrypt hash MARAD az egyetlen hitelesítő: a lookup csak KIVÁLASZTJA az
-- egyetlen szóba jövő sort, amire utána pontosan egy bcrypt.compare fut.
--
-- Nullable, mert a natív eszközök (Android/Python) provisioningkor a KÉSZ
-- bcrypt hasht küldik fel, a szerver a nyílt kulcsot sosem látja – náluk az
-- érték az első sikeres hitelesítéskor töltődik ki (backfill), addig a régi
-- teljes keresés fut. Idempotens, a projekt meglévő migrációs stílusát követve.

ALTER TABLE "Device"
  ADD COLUMN IF NOT EXISTS "deviceKeyLookup" TEXT;

CREATE INDEX IF NOT EXISTS "Device_deviceKeyLookup_idx"
  ON "Device" ("deviceKeyLookup");

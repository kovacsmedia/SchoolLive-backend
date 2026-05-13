-- BellSoundFile: új mezők az üzenet-intro hangok támogatásához
--
-- Az `kind` mező megkülönbözteti a csengetési rendben használt hangokat
-- (SCHEDULE: jelzocsengo, kibecsengo, …) az üzenetek előtt lejátszandó
-- rövid intro hangoktól (MESSAGE_INTRO: dingdong-szerűek). A meglévő
-- rekordoknak default SCHEDULE érték kerül – ez visszamenőleg kompatibilis
-- a bells/sounds endpointtal.
--
-- A `durationMs` opcionális – csak az intro hangoknál tartjuk számon, hogy
-- a 7 mp-es feltöltési limit betartható legyen. SCHEDULE típusnál null.

ALTER TABLE "BellSoundFile"
  ADD COLUMN IF NOT EXISTS "kind"       TEXT NOT NULL DEFAULT 'SCHEDULE',
  ADD COLUMN IF NOT EXISTS "durationMs" INTEGER;

CREATE INDEX IF NOT EXISTS "BellSoundFile_tenantId_kind_idx"
  ON "BellSoundFile" ("tenantId", "kind");

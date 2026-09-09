// src/modules/bells/bell-sound-paths.ts
//
// Csengetőhang-útvonalak feloldása. Két, egymástól független garanciát ad:
//
//   1. TENANT-SZEPARÁCIÓ – az új feltöltések `audio/bells/<tenantId>/<fájlnév>`
//      alá kerülnek. Korábban minden iskola a KÖZÖS `audio/bells/` könyvtárba
//      töltött fel az eredeti fájlnéven: a DB-ben van `@@unique([tenantId,
//      filename])`, a lemezen viszont semmi elválasztás nem volt, így két
//      iskola "csengo.mp3"-a felülírta egymást, és a DELETE /sounds/:id is a
//      másik iskola fájlját törölte.
//
//   2. "A CSENGETÉS SOSEM MARADHAT EL" – a feloldó SOHA nem ad vissza
//      "nincs ilyen fájl" eredményt. Ha a tenant saját fájlja hiányzik, a régi
//      lapos elrendezésre esik vissza; ha az sincs, a repóban szállított
//      default hangra (`assets/bells/`). Egy hiányzó vagy törölt feltöltés
//      tehát legrosszabb esetben MÁS hangot ad, de csendet SOSEM.
//
// A régi, lapos elrendezésű fájlok érintetlenül maradnak és továbbra is
// működnek, ezért a deploy nem igényel egyidejű adatmigrációt (ld.
// scripts/migrate-bell-sounds.mjs), és a fájlnév-alapú kliens-szerződés
// (BellEntry.soundFile, helyi cache-név) sem változik.
//
// Az ESP32 és az Android a szervertől kapott `url` mezőt használja
// (/bells/sync → sounds[].url), tehát azoknak ez transzparens.
//
// Külön modul (nem a bells.routes.ts-ben), mert a bell.scheduler.ts is
// használja – a bells.routes.ts viszont a bell.scheduler.ts-ből importálja a
// broadcastSyncBells-t, tehát a közvetlen import körkörös függőséget adna.

import fs from "fs";
import path from "path";

export const BELL_AUDIO_DIR = path.join(process.cwd(), "audio", "bells");

// A repóval együtt deployolt (rsync-elt) default hangok. Az `audio/` könyvtár
// SZÁNDÉKOSAN ki van zárva az rsyncből (felhasználói tartalom), ezért a
// defaultoknak külön, verziókövetett helyen KELL lenniük – enélkül egy
// frissen telepített node `audio/bells/`-e üres, és ott egyetlen csengetés
// sem szólalna meg, amíg a node-ok közti tükrözés utol nem éri.
export const BELL_ASSET_DIR = path.join(process.cwd(), "assets", "bells");

export const DEFAULT_SIGNAL_SOUND = "jelzocsengo.mp3";
export const DEFAULT_MAIN_SOUND   = "kibecsengo.mp3";
export const DEFAULT_BELL_SOUNDS  = [DEFAULT_SIGNAL_SOUND, DEFAULT_MAIN_SOUND] as const;

/** Az adott csengetés-típushoz tartozó default fájlnév. */
export function defaultSoundFor(type?: string | null): string {
  return type === "SIGNAL" ? DEFAULT_SIGNAL_SOUND : DEFAULT_MAIN_SOUND;
}

export function bellSoundTenantDir(tenantId: string): string {
  return path.join(BELL_AUDIO_DIR, tenantId);
}

/**
 * Induláskor egyszer: a default hangokat bemásolja az `audio/bells/`-be, ha
 * még nincsenek ott. Így egy vadonatúj node is azonnal csengetőképes, és a
 * `/bells/sync` is ki tudja őket ajánlani letöltésre.
 */
export function ensureDefaultBellSounds(): void {
  try {
    fs.mkdirSync(BELL_AUDIO_DIR, { recursive: true });
  } catch (e) {
    console.error("[BELL-SOUNDS] audio/bells létrehozás hiba:", e);
    return;
  }

  for (const name of DEFAULT_BELL_SOUNDS) {
    const target = path.join(BELL_AUDIO_DIR, name);
    if (fs.existsSync(target)) continue;

    const source = path.join(BELL_ASSET_DIR, name);
    if (!fs.existsSync(source)) {
      console.error(`[BELL-SOUNDS] ⚠️ HIÁNYZÓ DEFAULT HANG: ${source} – ellenőrizd, hogy az assets/bells/ kiment-e a deploy során!`);
      continue;
    }
    try {
      fs.copyFileSync(source, target);
      console.log(`[BELL-SOUNDS] Default hang telepítve: ${target}`);
    } catch (e) {
      console.error(`[BELL-SOUNDS] Default hang másolás hiba (${name}):`, e);
    }
  }
}

/**
 * A hangfájl TÉNYLEGES lemezes útja. SOHA nem ad vissza null-t, ha van
 * használható default – a hívónak nem kell "nincs hang" ágat kezelnie.
 *
 * Sorrend: tenant könyvtár → régi lapos hely → default az `audio/bells/`-ben
 * → default a repó `assets/bells/`-jéből.
 *
 * @param bellType a csengetés típusa ("SIGNAL" | "MAIN") – ez dönti el,
 *        MELYIK default hangra esünk vissza.
 */
export function bellSoundDiskPath(
  tenantId: string,
  filename: string,
  bellType?: string | null,
): { path: string; isFallback: boolean } | null {
  const direct = [
    path.join(bellSoundTenantDir(tenantId), filename),
    path.join(BELL_AUDIO_DIR, filename),
  ];
  for (const p of direct) {
    if (fs.existsSync(p)) return { path: p, isFallback: false };
  }

  // A kért fájl nincs meg – NEM maradhat el a csengetés, jön a default.
  const fallbackName = defaultSoundFor(bellType);
  const fallbacks = [
    path.join(BELL_AUDIO_DIR, fallbackName),
    path.join(BELL_ASSET_DIR, fallbackName),
    // Végső esély: a másik default, hátha csak az egyik hiányzik.
    path.join(BELL_AUDIO_DIR, defaultSoundFor(fallbackName === DEFAULT_SIGNAL_SOUND ? "MAIN" : "SIGNAL")),
    path.join(BELL_ASSET_DIR, defaultSoundFor(fallbackName === DEFAULT_SIGNAL_SOUND ? "MAIN" : "SIGNAL")),
  ];
  for (const p of fallbacks) {
    if (fs.existsSync(p)) return { path: p, isFallback: true };
  }

  return null;   // ide csak sérült telepítésnél juthatunk
}

/** A hangfájl publikus URL-útja (`/audio/...`), a tényleges helye szerint.
 *  Ha egyik helyen sincs meg, a tenant-szeparált alakot adjuk vissza – az a
 *  helyes cél egy most feltöltendő fájlnak. */
export function bellSoundUrlPath(tenantId: string, filename: string): string {
  const scoped = path.join(bellSoundTenantDir(tenantId), filename);
  if (!fs.existsSync(scoped) && fs.existsSync(path.join(BELL_AUDIO_DIR, filename))) {
    return `/audio/bells/${encodeURIComponent(filename)}`;
  }
  return `/audio/bells/${encodeURIComponent(tenantId)}/${encodeURIComponent(filename)}`;
}

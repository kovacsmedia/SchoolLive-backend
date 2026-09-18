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

import { execFileSync } from "child_process";

import { AUDIO_EXT, opusOutputArgs } from "../../utils/audio-format";

/**
 * EGY NÉV, TÖBB LEHETSÉGES KITERJESZTÉS.
 *
 * Az Opus-ra állás során a lemezen `csengo.opus` van, az adatbázisban viszont
 * még `csengo.mp3` állhat (vagy fordítva, ha egy régi eszköz listája nem
 * frissült). A kettő szétcsúszása néma csengetés lenne, ezért a feloldó a
 * kért néven kívül MINDIG megnézi az azonos alapnevű társat is.
 *
 * Ez szándékosan itt van és nem a migrációban: a migráció egyszer fut le és
 * hibázhat, ez viszont minden egyes feloldásnál véd. A migráció után is
 * ártalmatlan – ha a kért fájl megvan, az első találat nyer.
 */
function soundNameVariants(filename: string): string[] {
  if (!filename) return [];
  const ext = path.extname(filename).toLowerCase();
  if (ext === AUDIO_EXT) {
    const base = path.basename(filename, ext);
    return [filename, `${base}.mp3`];
  }
  return [filename, path.basename(filename, path.extname(filename)) + AUDIO_EXT];
}

export const BELL_AUDIO_DIR = path.join(process.cwd(), "audio", "bells");

// A repóval együtt deployolt (rsync-elt) default hangok. Az `audio/` könyvtár
// SZÁNDÉKOSAN ki van zárva az rsyncből (felhasználói tartalom), ezért a
// defaultoknak külön, verziókövetett helyen KELL lenniük – enélkül egy
// frissen telepített node `audio/bells/`-e üres, és ott egyetlen csengetés
// sem szólalna meg, amíg a node-ok közti tükrözés utol nem éri.
export const BELL_ASSET_DIR = path.join(process.cwd(), "assets", "bells");

export const DEFAULT_SIGNAL_SOUND = "assembly-signal-bell.opus";
export const DEFAULT_MAIN_SOUND   = "lesson-signal-bell.opus";
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

    /*
     * Az Opus-ra állás közben az assets/bells/ még tartalmazhat MP3-at. Egy
     * hiányzó .opus miatt NEM maradhatunk default hang nélkül, ezért a régi
     * kiterjesztést is elfogadjuk.
     */
    const source = soundNameVariants(name)
      .map(n => path.join(BELL_ASSET_DIR, n))
      .find(p => fs.existsSync(p)) ?? path.join(BELL_ASSET_DIR, name);
    if (!fs.existsSync(source)) {
      console.error(`[BELL-SOUNDS] ⚠️ HIÁNYZÓ DEFAULT HANG: ${source} – ellenőrizd, hogy az assets/bells/ kiment-e a deploy során!`);
      continue;
    }

    /*
     * ÁTKÓDOLUNK, NEM MÁSOLUNK.
     *
     * A cél neve `.opus`, és a lejátszók KITERJESZTÉSBŐL ismerik fel a
     * kodeket. Ha ide egy MP3 tartalmát másolnánk be `.opus` néven, a fájl
     * lejátszhatatlan lenne – néma csengetés, pont a legvédettebb ponton.
     * (Ez a hiba egyszer már benne volt: a teszt-szerver első indulásakor
     * a gyári default MP3-at tartalmazott.)
     */
    const sourceIsTarget = path.extname(source).toLowerCase() === AUDIO_EXT;

    if (sourceIsTarget) {
      try {
        fs.copyFileSync(source, target);
        console.log(`[BELL-SOUNDS] Default hang telepítve: ${target}`);
      } catch (e) {
        console.error(`[BELL-SOUNDS] Default hang másolás hiba (${name}):`, e);
      }
      continue;
    }

    const tmp = `${target}.converting`;
    try {
      execFileSync("ffmpeg", ["-y", "-i", source, ...opusOutputArgs("audio"), "-f", "opus", tmp],
                   { timeout: 60_000, stdio: "ignore" });
      if (fs.statSync(tmp).size === 0) throw new Error("üres kimenet");
      fs.renameSync(tmp, target);
      console.log(`[BELL-SOUNDS] Default hang átkódolva: ${source} → ${target}`);
    } catch (e: any) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      /*
       * Ha az átkódolás nem megy (nincs ffmpeg?), a forrást a SAJÁT nevén
       * tesszük ki. Így a tartalom és a név egyezik, a variáns-feloldó pedig
       * megtalálja – rosszabb formátum, de hallható csengetés.
       */
      const honest = path.join(BELL_AUDIO_DIR, path.basename(source));
      try {
        if (!fs.existsSync(honest)) fs.copyFileSync(source, honest);
        console.error(`[BELL-SOUNDS] ⚠️ Átkódolás sikertelen (${name}): ${e.message} – eredeti formátumban telepítve: ${honest}`);
      } catch (e2) {
        console.error(`[BELL-SOUNDS] Default hang telepítés hiba (${name}):`, e2);
      }
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
  /*
   * ÜRES FÁJLNÉV = "a típus szerinti gyári default kell".
   *
   * Ellenőrzés nélkül a `path.join(dir, "")` magát a KÖNYVTÁRAT adja, az
   * `fs.existsSync()` pedig igazat mond rá – a hívó tehát egy könyvtárra
   * mutató "hangfájlt" kapott volna, `isFallback: false` jelzéssel. A
   * lejátszás ezen elhasalt volna, azaz a csengetés elmarad. Üres névnél
   * rögtön a fallback-ágra megyünk.
   */
  if (filename) {
    const direct: string[] = [];
    for (const name of soundNameVariants(filename)) {
      direct.push(path.join(bellSoundTenantDir(tenantId), name));
      direct.push(path.join(BELL_AUDIO_DIR, name));
    }
    for (const p of direct) {
      if (fs.existsSync(p)) return { path: p, isFallback: false };
    }
  }

  // A kért fájl nincs meg – NEM maradhat el a csengetés, jön a default.
  //
  // A variánsokat ITT IS végig kell nézni: ez a legvégső védővonal, és az
  // Opus-ra állás közben épp az fordulhat elő, hogy a default még MP3-ként
  // van a lemezen. Pontos névre szűkítve ez az ág némán elbukna.
  const fallbackName  = defaultSoundFor(bellType);
  const otherDefault  = defaultSoundFor(fallbackName === DEFAULT_SIGNAL_SOUND ? "MAIN" : "SIGNAL");
  const fallbacks: string[] = [];
  for (const base of [fallbackName, otherDefault]) {
    for (const name of soundNameVariants(base)) {
      fallbacks.push(path.join(BELL_AUDIO_DIR, name));
      fallbacks.push(path.join(BELL_ASSET_DIR, name));
    }
  }
  for (const p of fallbacks) {
    if (fs.existsSync(p)) return { path: p, isFallback: true };
  }

  return null;   // ide csak sérült telepítésnél juthatunk
}

/**
 * A lemezen TÉNYLEGESEN meglévő fájlnév (nem az útvonal), vagy null.
 *
 * MIÉRT KELL: a klienseknek küldött hanglistában a `filename` és az `url`
 * NEM csúszhat szét. Az eszköz az `url`-ről tölt, de a `filename` néven
 * menti a saját fájlrendszerére, a lejátszó pedig KITERJESZTÉSBŐL ismeri fel
 * a kodeket. Ha tehát a név `.mp3`, a tartalom viszont Opus, a fájl
 * lejátszhatatlan – néma csengetés, pontosan az, amit tilos.
 */
export function resolveSoundName(tenantId: string, filename: string): string | null {
  for (const name of soundNameVariants(filename)) {
    if (fs.existsSync(path.join(bellSoundTenantDir(tenantId), name))) return name;
    if (fs.existsSync(path.join(BELL_AUDIO_DIR, name))) return name;
  }
  return null;
}

/** A hangfájl publikus URL-útja (`/audio/...`), a tényleges helye szerint.
 *  Ha egyik helyen sincs meg, a tenant-szeparált alakot adjuk vissza – az a
 *  helyes cél egy most feltöltendő fájlnak. */
export function bellSoundUrlPath(tenantId: string, filename: string): string {
  /*
   * A LÉTEZŐ változat URL-jét adjuk vissza, ne a kértét.
   *
   * Az eszköz ezt az URL-t tölti le, és ezen a néven menti a saját
   * fájlrendszerére. Ha itt olyan nevet adnánk, ami a lemezen nincs meg, az
   * eszköz 404-et kapna – vagyis pont az a hang hiányozna, amit csengetni
   * kellene.
   */
  for (const name of soundNameVariants(filename)) {
    if (fs.existsSync(path.join(bellSoundTenantDir(tenantId), name))) {
      return `/audio/bells/${encodeURIComponent(tenantId)}/${encodeURIComponent(name)}`;
    }
  }
  for (const name of soundNameVariants(filename)) {
    if (fs.existsSync(path.join(BELL_AUDIO_DIR, name))) {
      return `/audio/bells/${encodeURIComponent(name)}`;
    }
  }
  return `/audio/bells/${encodeURIComponent(tenantId)}/${encodeURIComponent(filename)}`;
}

// src/utils/audio-format.ts
//
// EGYSÉGES HANGFORMÁTUM – Opus, 96 kbit/s, 48 kHz.
//
// A rendszerben EGYETLEN tárolt hangformátum van, és ez az. Bármit tölt fel a
// felhasználó (MP3, WAV, M4A, FLAC, …), a backend azonnal átkódolja, és már
// csak az átkódolt változatot tárolja. A klienseknek (ESP32, Android, Linux,
// Windows) így sosem kell formátumot találgatniuk.
//
// MIÉRT PONT EZ:
//
//  1. A snap stream is Opus 96k (ld. snapcast.service.ts). Ha a tárolt fájl is
//     ugyanez, a lánc végig homogén, és a kisebb átviteli bitráta gyenge WiFi
//     mellett érdemben növeli az esélyt, hogy az adás túléli. Egy -85 dBm-es
//     vonalon ez nem elméleti kérdés (ld. a 2026-09-17-i eszközdiagnózist).
//
//  2. Megszűnik a köztes MP3. Korábban egy YouTube-letöltés így nézett ki:
//     Opus ~160k → MP3 128k → Opus 192k. A középső fokozat nemcsak egy plusz
//     generáció volt, hanem 16 kHz-en le is vágta a magasokat – amit utána már
//     semmilyen bitráta nem hozott vissza.
//
//  3. Egy formátum = nincs format mismatch. A konverzió egyetlen helyen,
//     ugyanazzal a kóddal történik, nem szétszórva hat hívási ponton.
//
// FONTOS: a beszéd-jellegű hangokat (TTS, üzenet-bemondás) a hívó fél
// `application: "voip"`-pal kérheti. Az Opus ilyenkor a beszédre optimalizál;
// a formátum és a bitráta ugyanaz marad.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";

/** A tárolt és sugárzott hang paraméterei. Egy helyen, mindenki innen veszi. */
export const AUDIO_CODEC        = "libopus";
/**
 * ⚙️ EZ AZ EGYETLEN SZÁM, AMIT ÁT KELL ÍRNI, HA A BITRÁTA VÁLTOZIK.
 *
 * Minden más – az ffmpeg kapcsolók, a yt-dlp minőség, a snapserver stream
 * konfigurációja és az "elég jó, nem kódoljuk újra" küszöb – ebből
 * származik. A klienseket nem érinti: a bitráta a stream fejlécében utazik,
 * a dekóder bármelyiket kezeli, tehát bitráta-emeléshez firmware-t NEM kell
 * cserélni, csak a backendet újraindítani.
 *
 * ⚠️ FELFELÉ SZABAD, LEFELÉ VESZÉLYES.
 *
 * Az ESP32 a TÁROLT fájlokat az ESP32-audioI2S saját Opus-dekóderével játssza
 * (nem a libopusszal – az csak a snapcast-streamhez van). Az a dekóder KIZÁRÓLAG
 * CELT-only kereteket tud:
 *
 *     if (configNr < 12) return ERR_OPUS_SILK_MODE_UNSUPPORTED;
 *     if (configNr < 16) return ERR_OPUS_HYBRID_MODE_UNSUPPORTED;
 *
 * 96 kbit/s-on, 48 kHz sztereóban a libopus mindig CELT-et választ – ezt
 * megmértük a TOC-bájtokból: csengetőhang, TTS (voip preset) és zene is 100%-ban
 * config 31 (CELT fullband). A jelenlegi 128 kbit/s ennél is biztosabb: minél
 * több a bit, annál inkább CELT.
 *
 * ALACSONYABB bitrátán viszont a libopus átválthat SILK-re vagy hibridre, amit az
 * eszköz nem tud dekódolni. Az egyes hibás kereteket a könyvtár átugorja (nem áll
 * le), tehát ez kattogás lenne, nem teljes némaság – de egy sok SILK-keretet
 * tartalmazó fájl gyakorlatilag használhatatlan.
 *
 * Ha valaha 64 kbit/s alá mennél, ELŐBB mérd meg a kimenetet (a TOC-bájt felső 5
 * bitje a config-szám, >= 16 kell legyen), vagy kényszeríts CELT-only módot
 * `-application lowdelay`-jel.
 */
export const AUDIO_BITRATE_KBPS = 128;

/** Ugyanaz ffmpeg/yt-dlp alakban ("128k"). Származtatott, ne írd át külön. */
export const AUDIO_BITRATE      = `${AUDIO_BITRATE_KBPS}k`;
export const AUDIO_EXT          = ".opus";
export const AUDIO_SAMPLE_RATE  = 48000;

/**
 * A csatornaszám is rögzített.
 *
 * Nem csak elvhűségből: a TTS-ben már volt egy hiba, ahol az ffmpeg concat
 * demuxere némán eldobta a beszéd-sávot, mert az intro és a TTS-kimenet
 * csatornaszáma és mintavétele eltért ("csak az üzenet-előtti hang szól").
 * Ha MINDEN tárolt fájl azonos alakú, ez a hibaosztály megszűnik.
 *
 * A sztereó mono tartalomnál nem kerül többe: az Opus csatorna-csatolása a
 * néma második csatornára gyakorlatilag nem költ bitet.
 */
export const AUDIO_CHANNELS     = 2;

/**
 * Egy MÁR Opus fájlt eddig a bitrátáig megtartunk átkódolás nélkül.
 *
 * SZÁNDÉKOSAN SZÁMÍTOTT ÉRTÉK, nem beégetett szám: ha a cél-bitráta valaha
 * változik (pl. 96 → 160), ez magától követi. Egy beégetett küszöb ilyenkor
 * némán elrontaná a logikát – a régi, alacsonyabb bitrátájú fájlokat is
 * "elég jónak" fogadná el, és sosem kódolnánk fel őket.
 *
 * A ráhagyás a VBR miatt kell: egy 96 kbit/s célra kódolt Opus fájl mért
 * átlaga simán lehet 100-105 kbit/s. Enélkül minden saját magunk által
 * gyártott fájlt feleslegesen újrakódolnánk – ami pont az a tandem-veszteség,
 * amit el akarunk kerülni.
 */
export const OPUS_KEEP_MAX_KBPS = Math.round(AUDIO_BITRATE_KBPS * 1.17);

/** ffmpeg kimeneti kapcsolók az egységes formátumhoz. */
export function opusOutputArgs(application: "audio" | "voip" = "audio"): string[] {
  return [
    "-vn",
    "-c:a", AUDIO_CODEC,
    "-b:a", AUDIO_BITRATE,
    "-application", application,
    "-ar", String(AUDIO_SAMPLE_RATE),
    "-ac", String(AUDIO_CHANNELS),
  ];
}

/**
 * yt-dlp kapcsolók: a letöltés MÁR a végleges formátumban landoljon.
 *
 * A YouTube natívan ~160 kbit/s Opust ad; ezt egy generációval lejjebb
 * kódoljuk. Cserébe nem kerül MP3 a láncba, tehát a magasak nem tűnnek el.
 */
export function ytDlpAudioArgs(): string[] {
  return [
    "--extract-audio",
    "--audio-format", "opus",
    "--audio-quality", AUDIO_BITRATE,
  ];
}

/** Egy fájlnév kiterjesztését az egységes formátumra cseréli. */
export function withAudioExt(name: string): string {
  return path.basename(name, path.extname(name)) + AUDIO_EXT;
}

/** A tárolt hangok elfogadott kiterjesztése (a régi, még át nem állt fájlokkal együtt). */
export function isAudioFile(name: string): boolean {
  return /\.(opus|ogg|mp3|wav|m4a|aac|flac)$/i.test(name);
}

/**
 * Rövid fájlnál a bitráta-mérés NEM megbízható.
 *
 * Az `ffprobe` a KONTÉNER bitrátáját adja, amibe beleszámít az Ogg-fejléc
 * (OpusHead + OpusTags + oldal-fejlécek, ~1 kB). Egy 1-2 másodperces
 * csengőhangnál ez 135-145 kbit/s-ot mutat, holott a hang 96k. Ha ilyenkor
 * "túl nagy bitrátának" hinnénk, minden ellenőrzésnél újrakódolnánk –
 * generációnként veszítve. (Élesben pontosan ez történt: a migráció minden
 * futáson újrakódolt 14 rövid fájlt.)
 */
export const BITRATE_TRUST_MIN_SEC = 10;

/** Egy hangfájl kodekje, bitrátája és hossza, vagy null, ha nem mérhető. */
export function probeAudio(
  filePath: string
): Promise<{ codec: string; kbps: number; durationSec: number } | null> {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "quiet", "-select_streams", "a:0",
       "-show_entries", "stream=codec_name:format=bit_rate,duration",
       "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      { timeout: 10_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const lines = String(stdout).trim().split(/\r?\n/);
        const codec = (lines[0] ?? "").trim().toLowerCase();
        const bits  = parseInt((lines[1] ?? "").trim(), 10);
        const dur   = parseFloat((lines[2] ?? "").trim());
        if (!codec) return resolve(null);
        resolve({
          codec,
          kbps:        isFinite(bits) && bits > 0 ? Math.round(bits / 1000) : 0,
          durationSec: isFinite(dur) && dur > 0 ? dur : 0,
        });
      },
    );
  });
}

/**
 * Átkódolás az egységes formátumra.
 *
 * A forrást CSAK sikeres konverzió után dobjuk el, és a kimenet is csak akkor
 * kapja meg a végleges nevét – egy félbemaradt ffmpeg így sosem hagy maga után
 * egy nulla hosszú, lejátszhatatlan „kész" fájlt. Ez a csengetésnél
 * kritikus: egy 0 bájtos hang néma jelzés.
 */
export function transcodeToOpus(
  srcPath: string,
  application: "audio" | "voip" = "audio",
): Promise<{ path: string; size: number } | null> {
  const dir  = path.dirname(srcPath);
  const base = path.basename(srcPath, path.extname(srcPath));
  const out  = path.join(dir, `${base}${AUDIO_EXT}`);
  const tmp  = path.join(dir, `${base}.converting${AUDIO_EXT}`);

  return new Promise((resolve) => {
    execFile(
      "ffmpeg",
      ["-y", "-i", srcPath, ...opusOutputArgs(application), tmp],
      { timeout: 120_000 },
      (err) => {
        if (err) {
          try { fs.unlinkSync(tmp); } catch { /* nincs mit takarítani */ }
          console.error(`[AUDIO] Opus konverzió sikertelen (${srcPath}):`, err.message);
          return resolve(null);
        }
        try {
          const size = fs.statSync(tmp).size;
          if (size === 0) {
            fs.unlinkSync(tmp);
            console.error(`[AUDIO] Opus konverzió üres fájlt adott: ${srcPath}`);
            return resolve(null);
          }
          if (out !== srcPath) { try { fs.unlinkSync(srcPath); } catch { /* ignore */ } }
          fs.renameSync(tmp, out);
          resolve({ path: out, size });
        } catch (e: any) {
          console.error(`[AUDIO] Opus konverzió utómunka hiba:`, e.message);
          resolve(null);
        }
      },
    );
  });
}

/**
 * Akkor és csak akkor kódol át, ha kell.
 *
 * Visszatérés: a véglegesen tárolandó útvonal, méret és név – akkor is, ha
 * nem történt konverzió. `null`, ha a fájl nem menthető.
 */
export async function normalizeToStoredFormat(
  srcPath: string,
  originalName: string,
  application: "audio" | "voip" = "audio",
): Promise<{ path: string; size: number; name: string; converted: boolean } | null> {
  const probe = await probeAudio(srcPath);

  /*
   * Ami MÁR Opus, azt csak akkor kódoljuk újra, ha bizonyítottan pazarló.
   * Rövid fájlnál a mérés nem megbízható (ld. BITRATE_TRUST_MIN_SEC), ott a
   * kétely a megtartás javára dönt – egy fölösleges újrakódolás mindig
   * generációs veszteség.
   */
  const bitrateTrusted = (probe?.durationSec ?? 0) >= BITRATE_TRUST_MIN_SEC;
  const alreadyOk =
    probe?.codec === "opus" &&
    path.extname(srcPath).toLowerCase() === AUDIO_EXT &&
    (!bitrateTrusted || probe.kbps === 0 || probe.kbps <= OPUS_KEEP_MAX_KBPS);

  if (alreadyOk) {
    return {
      path: srcPath,
      size: fs.statSync(srcPath).size,
      name: withAudioExt(originalName),
      converted: false,
    };
  }

  const conv = await transcodeToOpus(srcPath, application);
  if (!conv) return null;

  return {
    path: conv.path,
    size: conv.size,
    name: withAudioExt(originalName),
    converted: true,
  };
}

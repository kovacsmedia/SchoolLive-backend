// src/services/tts.service.ts
// Piper TTS → WAV kimenet
// generateTTS visszaadja a { filename, durationMs } értéket
// hogy a dispatchSync átadhassa az overlay timer-hez

import { spawn, execSync } from "child_process";
import path                from "path";
import fs                  from "fs";
import crypto              from "crypto";
import { stripAccents }    from "../utils/text";
import { budapestDateTimeParts } from "../utils/budapest-time";
import { opusOutputArgs } from "../utils/audio-format";

/*
 * A PIPER TELEPÍTÉSI HELYE külső, a repón kívüli – ezért abszolút út, de
 * KÖRNYEZETI VÁLTOZÓVAL FELÜLÍRHATÓ, ahogy a szomszédos FFMPEG_BIN és
 * YT_DLP_BIN is. Enélkül minden eltérő telepítés kódmódosítást igényelne.
 */
const PIPER_BIN  = process.env.PIPER_BIN  ?? "/opt/schoollive/piper/piper";
const MODELS_DIR = process.env.PIPER_MODELS_DIR ?? "/opt/schoollive/piper/models";

/*
 * AZ AUDIO KÖNYVTÁR A MUNKAKÖNYVTÁRBÓL JÖN, mint mindenhol máshol.
 *
 * Itt korábban a bedrótozott `/opt/schoollive/backend/audio` állt. Az éles
 * node-on véletlenül stimmelt, de bárhol máshol (teszt-példány, másik
 * telepítési útvonal, fejlesztői futtatás) a Piper a saját WAV-ját olyan
 * könyvtárba írta, amit az ffmpeg utána nem talált:
 *
 *   Error opening input file …/audio/tts_speech_<hash>.wav
 *
 * A tünet: a TTS-üzenet létrehozása HTTP 500-zal bukott. Ugyanez a hiba volt
 * az app.ts statikus `/audio` kiszolgálásában is.
 */
const AUDIO_DIR  = path.join(process.cwd(), "audio");

const DINGDONG_WAV = path.join(AUDIO_DIR, "dingdong.wav");
/*
 * A dingdong forrása. Az Opus-ra állás után a gyári hang `.opus`, de a régi
 * `.mp3` is előfordulhat egy még nem migrált telepítésen – és a
 * `assets/bells/` az egyetlen hely, ahol a repóval EGYÜTT érkezik. Az első
 * létező nyer; enélkül a WAV nem készült el, és az üzenet-előtti hang némán
 * elmaradt.
 */
const DINGDONG_SOURCES = [
  path.join(AUDIO_DIR, "dingdong.opus"),
  path.join(AUDIO_DIR, "dingdong.mp3"),
  path.join(process.cwd(), "assets", "bells", "dingdong.opus"),
  path.join(process.cwd(), "assets", "bells", "dingdong.mp3"),
];

const VOICES: Record<string, string> = {
  // Magyar (eredeti, hangszín-választás)
  anna:  "hu_HU-anna-medium.onnx",
  berta: "hu_HU-berta-medium.onnx",
  imre:  "hu_HU-imre-medium.onnx",
  // Idegen nyelvű TTS-fordításhoz (Messages "Fordítás" gomb) — 1 hang / nyelv.
  // A `voice` mostantól vagy magyar hangnév, vagy ISO 639-1 nyelvkód lehet,
  // ugyanez a map mindkettőt feloldja.
  en: "en_US-amy-medium.onnx",
  de: "de_DE-thorsten-medium.onnx",
  sk: "sk_SK-lili-medium.onnx",
  pl: "pl_PL-darkman-medium.onnx",
  ro: "ro_RO-mihai-medium.onnx",
  uk: "uk_UA-ukrainian_tts-medium.onnx",
  sr: "sr_RS-serbski_institut-medium.onnx",
  // Nincs natív horvát Piper-modell (a rhasspy/piper-voices repóban horvát
  // egyáltalán nem szerepel) — a szerb hangot használjuk horvát szöveghez is,
  // ld. a lokalizációs terv Context szakaszát.
  hr: "sr_RS-serbski_institut-medium.onnx",
};

function runProcess(bin: string, args: string[], input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    if (input !== undefined) { proc.stdin.write(input); proc.stdin.end(); }
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${path.basename(bin)} error (${code}): ${stderr.slice(-400)}`));
      resolve();
    });
    proc.on("error", (err) => reject(new Error(`${path.basename(bin)} spawn error: ${err.message}`)));
  });
}

// ── Hangfájl hosszának lekérése ffprobe-bal ──────────────────────────────────
function getFileDurationMs(filePath: string): number | null {
  try {
    const out = execSync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`,
      { timeout: 3000 }
    ).toString().trim();
    const sec = parseFloat(out);
    if (isFinite(sec) && sec > 0) return Math.round(sec * 1000);
  } catch {}
  return null;
}

// Dingdong WAV biztosítása
async function ensureDingdongWav(): Promise<void> {
  if (fs.existsSync(DINGDONG_WAV)) return;
  const src = DINGDONG_SOURCES.find(p => fs.existsSync(p));
  if (!src) { console.warn("[TTS] nincs dingdong forrás – üzenet-előtti hang kimarad"); return; }
  await runProcess("ffmpeg", [
    "-y", "-i", src,
    "-ar", "22050", "-ac", "1",
    DINGDONG_WAV,
  ]);
  console.log("[TTS] dingdong.wav elkészítve");
}

// ── Audio "polírozó" filter chain ─────────────────────────────────────────────
// Rádió-broadcast stílusú feldolgozás, hogy az iskolai bemondás MINDIG
// erőteljes, érthető és konzisztensen hangos legyen, függetlenül a forrás
// hangerő-szintjétől (halk Piper TTS, csendben felvett mikrofonos hangfelvétel
// stb.).
//
// 1) acompressor – erős dinamika-tömörítés: a halkabb szótagokat felemeli,
//    a csúcsokat lefogja → minden szó egyenletesen hangos. A korábbi
//    threshold=-18/ratio=3-hez képest agresszívebb (−22/4/+6 makeup) hogy
//    még a felvevő-mikrofon távoli halk részeit is felhúzza.
// 2) loudnorm – EBU R128 normalizáció: target −12 LUFS (rádiós szint,
//    NEM broadcast −16) és TP=−1.0 dBTP (0.5 dB-vel magasabb mint a
//    broadcast cap), LRA=7 (szorosabb loudness range = állandó hangerő).
// 3) alimiter – brick-wall limiter 0.97 (≈ −0.26 dBFS) ceiling-en: az
//    R128 utáni esetleges csúcsokat lefogja, így a kimenet maximálisan
//    "maxed out" a klipping veszélye nélkül. Ez a "maximalizálás" lépés.
//
// A sorrend lényeges: kompresszor → loudnorm → limiter. Ezt az üzenetek
// (TTS + recording) lejátszás-előtti rendereléséhez használjuk.
//
// Megjegyzés: az újrajátszandó üzeneteknél (replay) ezt NEM alkalmazzuk,
// mert a tárolt fájl már egyszer átment ezen a filteren.
/** A célzott hangosság (LUFS), csúcshatár és dinamikatartomány. */
const LOUDNORM_I   = -12;
const LOUDNORM_TP  = -1.0;
const LOUDNORM_LRA = 7;

const COMPRESS_STAGE = "acompressor=threshold=-22dB:ratio=4:attack=10:release=180:makeup=2";
const LIMITER_STAGE  = "alimiter=limit=0.97:attack=5:release=50";

/**
 * Tartalék lánc, ha a mérés nem sikerül (ld. measureLoudnorm).
 * Egy kissé egyenetlen szint sokkal jobb, mint a néma hiba.
 */
export const NORMALIZE_COMPRESS_FILTER =
  `${COMPRESS_STAGE},loudnorm=I=${LOUDNORM_I}:TP=${LOUDNORM_TP}:LRA=${LOUDNORM_LRA},${LIMITER_STAGE}`;

/**
 * HANGERŐ-KIEGYENLÍTÉS – kétmenetes, de NEM `loudnorm`-mal.
 *
 * A PROBLÉMA: az egyes Piper-hangok érezhetően eltérő szinten szólnak, és ez
 * végigment a láncon – „egyes nyelvek halkabbak". Mérve, ugyanarra a mondatra:
 *
 *     nyers:  anna -15.0 | berta -17.7 | imre -21.2 LUFS
 *
 * MIÉRT NEM A `loudnorm` OLDJA MEG: az EBU R128 integrált hangosság KAPUZOTT
 * mérés (400 ms-os blokkok, abszolút és relatív kapu). Egy 3-5 másodperces
 * bemondáson a kapuk a blokkok nagy részét kizárják, így a mérés – és vele a
 * korrekció – megbízhatatlan. Kétmenetes módban sem javult: a kimenet
 * -11.9 és -18.2 LUFS között szóródott, tehát 6.3 dB-en belül SEMMIT nem
 * garantált.
 *
 * AMI MŰKÖDIK: a `volumedetect` egyszerű, kapuzás NÉLKÜLI RMS-t és csúcsot ad,
 * ami rövid hangon is determinisztikus. Ebből egyetlen fix erősítést
 * számolunk. Mérve ugyanazokon a hangokon: -14.5 … -17.0 LUFS, azaz 2.5 dB
 * szóráson belül, és a három magyar hang fél dB-en belül egymáshoz képest.
 *
 * A csúcsot szándékosan engedjük PEAK_HEADROOM_DB-ig menni: a rá következő
 * limiter pont erre való. Az erősítés visszavágása helyette újra szétszórná
 * a szinteket (a halk, de csúcsos hangok alulmaradnának).
 */
const TARGET_MEAN_DBFS = -15.0;
const PEAK_HEADROOM_DB = 2.0;

export async function measureLoudnorm(inputPath: string): Promise<string | null> {
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const proc = spawn("ffmpeg", [
        "-hide_banner", "-i", inputPath,
        "-af", `${COMPRESS_STAGE},volumedetect`,
        "-f", "null", "-",
      ]);
      let err = "";
      proc.stderr.on("data", d => { err += d.toString(); });
      proc.on("close", () => resolve(err));
      proc.on("error", reject);
    });

    const mean = Number(/mean_volume:\s*(-?[\d.]+)/.exec(out)?.[1]);
    const peak = Number(/max_volume:\s*(-?[\d.]+)/.exec(out)?.[1]);
    if (!isFinite(mean) || !isFinite(peak)) return null;

    let gain = TARGET_MEAN_DBFS - mean;
    // A limiter a maradékot elkapja; ennél többet ne engedjünk rá.
    if (peak + gain > PEAK_HEADROOM_DB) gain = PEAK_HEADROOM_DB - peak;

    return `${COMPRESS_STAGE},volume=${gain.toFixed(2)}dB,${LIMITER_STAGE}`;
  } catch {
    return null;
  }
}
// ── Fájlnév-képzés az üzenet szövegéből ───────────────────────────────────────
// Cél: "<üzenet első 2 szava, ékezet nélkül>_<YYYY-MM-DD>_<óraperc>.opus" –
// ember-olvasható fájlnév letöltéskor/listázáskor, ahelyett hogy csak egy
// random hash lenne. Az időbélyeg a tényleges (Europe/Budapest) helyi idő,
// nem a szerver saját (esetleg UTC) órája.
function sanitizeFilenameWord(w: string): string {
  return stripAccents(w).replace(/[^a-zA-Z0-9]/g, "");
}

function buildTtsFilename(text: string): string {
  const words = text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(sanitizeFilenameWord)
    .filter(Boolean);
  const base = words.length > 0 ? words.join("_") : "uzenet";
  const { date, hm } = budapestDateTimeParts();

  // Ütközés-védelem: ha két üzenet ugyanazzal a 2 szóval indul ugyanabban a
  // percben, a második ne írja felül az első fájlját.
  let filename = `${base}_${date}_${hm}.opus`;
  let n = 2;
  while (fs.existsSync(path.join(AUDIO_DIR, filename))) {
    filename = `${base}_${date}_${hm}-${n}.opus`;
    n++;
  }
  return filename;
}

// ── generateTTS ───────────────────────────────────────────────────────────────
// Visszaad: { filename, durationMs }
// filename = az /audio/ könyvtárban lévő WAV fájl neve
//
// Paraméterek:
//   - text:           a felolvasandó szöveg
//   - voice:          Piper hang (anna/berta/imre)
//   - introSoundPath: opcionális override, ha a felhasználó saját intro
//                     hangot választott (BellSoundFile MESSAGE_INTRO).
//                     Ha null/undefined → default dingdong.wav.
export async function generateTTS(
  text:  string,
  voice: string = "anna",
  introSoundPath?: string | null,
): Promise<{ filename: string; durationMs: number | null }> {
  await ensureDingdongWav();

  const modelName = VOICES[voice] ?? VOICES["anna"];
  const modelPath = path.join(MODELS_DIR, modelName);

  if (!fs.existsSync(modelPath)) {
    throw new Error(`Piper modell nem található: ${modelPath}`);
  }

  const hash       = crypto.randomBytes(8).toString("hex");
  const speechFile = path.join(AUDIO_DIR, `tts_speech_${hash}.wav`);
  // A klienseknek a snap streamen át megy a hang, és a snapserver Opus
  // codec-kel sugároz – ezért a backend is Opus-ban tárolja a render output-ot.
  // Helytakarékos (1/10–1/20 a WAV-hoz képest), és a snapserver natívan
  // fogadja file-source-ként. A VÉGSŐ fájl neve (ellentétben a fenti,
  // eldobható köztes fájlokkal) ember-olvasható, az üzenet szövegéből
  // képzett – ld. buildTtsFilename().
  const finalFile  = path.join(AUDIO_DIR, buildTtsFilename(text));

  // 1. Szöveg → WAV (Piper)
  await runProcess(PIPER_BIN, [
    "--model",       modelPath,
    "--output_file", speechFile,
  ], text);

  // 2. Intro hang választása: explicit override > default dingdong > nincs
  const introPath = introSoundPath && fs.existsSync(introSoundPath)
    ? introSoundPath
    : (fs.existsSync(DINGDONG_WAV) ? DINGDONG_WAV : null);

  // 3. Render-pipeline:
  //    a) ha van intro → concat (intro + speech) majd normalize+compress → opus
  //    b) ha nincs intro → csak normalize+compress a speech-en → opus
  //
  // A végső kódolás a rendszer EGYETLEN tárolási formátuma (ld.
  // utils/audio-format.ts): Opus 96 kbit/s, 48 kHz, sztereó. A "voip" preset
  // marad – az nem a formátumot állítja, hanem a kódolót hangolja beszédre.
  const OPUS_ARGS = opusOutputArgs("voip");

  if (introPath) {
    const concatWav  = path.join(AUDIO_DIR, `concat_${hash}.wav`);
    // 3.a/1: concat FILTER (NEM demuxer!).
    //
    // A concat demuxer (`-f concat -i list.txt`) elvárja, hogy MINDEN input
    // ugyanolyan formátumú legyen (codec, sample rate, csatorna). A user
    // által feltöltött MESSAGE_INTRO bármilyen audio lehet (MP3 stereo
    // 44.1kHz, OGG, M4A stb.), míg a Piper TTS output 22050Hz mono WAV.
    // Ezzel a régi koddal a concat csendesen csak az intro-t adta vissza,
    // a TTS rész elveszett → "csak az üzenet-előtti hang szól" bug.
    //
    // A concat FILTER (`-filter_complex ...concat=...`) viszont mindkét
    // streamet előbb auto-resample-eli a közös formátumra (22050 mono),
    // majd koncatenál. Robust mindenféle intro-formátumra.
    await runProcess("ffmpeg", [
      "-y",
      "-i", introPath,
      "-i", speechFile,
      "-filter_complex",
        "[0:a]aresample=22050,aformat=channel_layouts=mono[a0];" +
        "[1:a]aresample=22050,aformat=channel_layouts=mono[a1];" +
        "[a0][a1]concat=n=2:v=0:a=1[out]",
      "-map", "[out]",
      "-ar", "22050", "-ac", "1",
      concatWav,
    ]);
    fs.unlinkSync(speechFile);
    // 3.a/2: normalize + compressor + libopus encode a concat-ra
    await runProcess("ffmpeg", [
      "-y", "-i", concatWav,
      "-af", (await measureLoudnorm(concatWav)) ?? NORMALIZE_COMPRESS_FILTER,
      ...OPUS_ARGS,
      finalFile,
    ]);
    fs.unlinkSync(concatWav);
  } else {
    // 3.b: csak normalize+compress + libopus encode
    await runProcess("ffmpeg", [
      "-y", "-i", speechFile,
      "-af", (await measureLoudnorm(speechFile)) ?? NORMALIZE_COMPRESS_FILTER,
      ...OPUS_ARGS,
      finalFile,
    ]);
    fs.unlinkSync(speechFile);
  }

  const filename   = path.basename(finalFile);
  const durationMs = getFileDurationMs(finalFile);

  console.log(`[TTS] Generálva: ${filename} (${durationMs}ms) intro=${introPath ? path.basename(introPath) : "none"}`);
  return { filename, durationMs };
}
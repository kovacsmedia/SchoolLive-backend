// src/services/tts.service.ts
// Piper TTS → WAV kimenet
// generateTTS visszaadja a { filename, durationMs } értéket
// hogy a dispatchSync átadhassa az overlay timer-hez

import { spawn, execSync } from "child_process";
import path                from "path";
import fs                  from "fs";
import crypto              from "crypto";

const PIPER_BIN  = "/opt/schoollive/piper/piper";
const MODELS_DIR = "/opt/schoollive/piper/models";
const AUDIO_DIR  = "/opt/schoollive/backend/audio";

const DINGDONG_WAV = path.join(AUDIO_DIR, "dingdong.wav");
const DINGDONG_MP3 = path.join(AUDIO_DIR, "dingdong.mp3");

const VOICES: Record<string, string> = {
  anna:  "hu_HU-anna-medium.onnx",
  berta: "hu_HU-berta-medium.onnx",
  imre:  "hu_HU-imre-medium.onnx",
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
  if (!fs.existsSync(DINGDONG_MP3)) return;
  await runProcess("ffmpeg", [
    "-y", "-i", DINGDONG_MP3,
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
export const NORMALIZE_COMPRESS_FILTER =
  "acompressor=threshold=-22dB:ratio=4:attack=10:release=180:makeup=6," +
  "loudnorm=I=-12:TP=-1.0:LRA=7," +
  "alimiter=limit=0.97:attack=5:release=50";

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
  // fogadja file-source-ként.
  const finalFile  = path.join(AUDIO_DIR, `tts_${hash}.opus`);

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
  // A végső kódolás: libopus, 48 kbps voip preset – elég kiváló érthető
  // beszédhez, ugyanakkor kis fájlméret a snapserver fogadásához.
  const OPUS_ARGS = [
    "-c:a", "libopus",
    "-b:a", "48k",
    "-application", "voip",
    "-ar", "48000",   // libopus 48k input ajánlott
    "-ac", "1",
  ];

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
      "-af", NORMALIZE_COMPRESS_FILTER,
      ...OPUS_ARGS,
      finalFile,
    ]);
    fs.unlinkSync(concatWav);
  } else {
    // 3.b: csak normalize+compress + libopus encode
    await runProcess("ffmpeg", [
      "-y", "-i", speechFile,
      "-af", NORMALIZE_COMPRESS_FILTER,
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
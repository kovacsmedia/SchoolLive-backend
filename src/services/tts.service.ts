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
// 1) acompressor: dinamika-kompresszor, a halkabb részeket felemeli, a
//    csúcsokat lefogja → érthetőbb beszéd hangszórón.
// 2) loudnorm: EBU R128 normalizáció (-16 LUFS integrated, -1.5 dBTP cap)
//    → konzisztens hangerő, nem törli el a kompresszor előnyét.
//
// A sorrend lényeges: ELSŐ a kompresszor (dinamika tömörítés), MÁSODIK a
// loudnorm (érthetőbb beszéd után normalizáljuk a végső szintet). Ezt az
// üzenetek (TTS + recording) lejátszás előtti rendereléséhez használjuk.
//
// Megjegyzés: az újrajátszandó üzeneteknél (replay) ezt NEM alkalmazzuk,
// mert a tárolt fájl már egyszer átment ezen a filteren.
export const NORMALIZE_COMPRESS_FILTER =
  "acompressor=threshold=-18dB:ratio=3:attack=20:release=250:makeup=4," +
  "loudnorm=I=-16:TP=-1.5:LRA=11";

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
  const finalFile  = path.join(AUDIO_DIR, `tts_${hash}.wav`);

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
  //    a) ha van intro → concat (intro + speech) majd normalize+compress
  //    b) ha nincs intro → csak normalize+compress a speech-en
  if (introPath) {
    const concatList = path.join(AUDIO_DIR, `concat_${hash}.txt`);
    const concatWav  = path.join(AUDIO_DIR, `concat_${hash}.wav`);
    fs.writeFileSync(concatList, `file '${introPath}'\nfile '${speechFile}'\n`);
    // 3.a/1: concat → 22050 mono raw wav
    await runProcess("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0",
      "-i", concatList,
      "-ar", "22050", "-ac", "1",
      concatWav,
    ]);
    fs.unlinkSync(concatList);
    fs.unlinkSync(speechFile);
    // 3.a/2: normalize + compressor a concat-ra
    await runProcess("ffmpeg", [
      "-y", "-i", concatWav,
      "-af", NORMALIZE_COMPRESS_FILTER,
      "-ar", "22050", "-ac", "1",
      finalFile,
    ]);
    fs.unlinkSync(concatWav);
  } else {
    // 3.b: csak normalize+compress
    await runProcess("ffmpeg", [
      "-y", "-i", speechFile,
      "-af", NORMALIZE_COMPRESS_FILTER,
      "-ar", "22050", "-ac", "1",
      finalFile,
    ]);
    fs.unlinkSync(speechFile);
  }

  const filename   = path.basename(finalFile);
  const durationMs = getFileDurationMs(finalFile);

  console.log(`[TTS] Generálva: ${filename} (${durationMs}ms) intro=${introPath ? path.basename(introPath) : "none"}`);
  return { filename, durationMs };
}
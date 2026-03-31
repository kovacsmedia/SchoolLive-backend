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

// ── generateTTS ───────────────────────────────────────────────────────────────
// Visszaad: { filename, durationMs }
// filename = az /audio/ könyvtárban lévő WAV fájl neve
export async function generateTTS(
  text:  string,
  voice: string = "anna",
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

  // 2. Dingdong + speech concat (ha van dingdong)
  if (fs.existsSync(DINGDONG_WAV)) {
    const concatList = path.join(AUDIO_DIR, `concat_${hash}.txt`);
    fs.writeFileSync(concatList, `file '${DINGDONG_WAV}'\nfile '${speechFile}'\n`);
    await runProcess("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0",
      "-i", concatList,
      "-ar", "22050", "-ac", "1",
      finalFile,
    ]);
    fs.unlinkSync(concatList);
    fs.unlinkSync(speechFile);
  } else {
    fs.renameSync(speechFile, finalFile);
  }

  const filename   = path.basename(finalFile);
  const durationMs = getFileDurationMs(finalFile);

  console.log(`[TTS] Generálva: ${filename} (${durationMs}ms)`);
  return { filename, durationMs };
}
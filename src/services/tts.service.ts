// src/services/tts.service.ts
// Piper TTS → WAV kimenet (nem MP3)
// A Snapcast PCM-et vár, felesleges a veszteséges MP3 konverzió.
// A dingdong.wav-ot is WAV-ként fűzzük hozzá ffmpeg concat-tal.
// VirtualPlayer fallback URL is WAV-ot szolgál ki.

import { spawn } from "child_process";
import path      from "path";
import fs        from "fs";
import crypto    from "crypto";

const PIPER_BIN  = "/opt/schoollive/piper/piper";
const MODELS_DIR = "/opt/schoollive/piper/models";
const AUDIO_DIR  = "/opt/schoollive/backend/audio";

// Dingdong WAV (ha MP3 van, egyszer konvertáljuk)
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

// Dingdong WAV biztosítása (MP3-ból konvertálás ha szükséges)
async function ensureDingdongWav(): Promise<boolean> {
  if (fs.existsSync(DINGDONG_WAV)) return true;
  if (!fs.existsSync(DINGDONG_MP3)) return false;
  try {
    await runProcess("ffmpeg", [
      "-y", "-i", DINGDONG_MP3,
      "-ar", "22050", "-ac", "1",   // Piper output formátum
      DINGDONG_WAV,
    ]);
    return fs.existsSync(DINGDONG_WAV);
  } catch (e) {
    console.error("[TTS] dingdong WAV konverzió sikertelen:", e);
    return false;
  }
}

export async function generateTTS(text: string, voice: string = "anna"): Promise<string> {
  const modelFile = VOICES[voice] ?? VOICES["anna"];
  const modelPath = path.join(MODELS_DIR, modelFile);

  const hasDingdong = await ensureDingdongWav();

  // Cache kulcs: szöveg + hang + dingdong jelenlét
  const cacheKey = `${text}|${voice}|dd:${hasDingdong ? "1" : "0"}|wav`;
  const hash     = crypto.createHash("sha256").update(cacheKey).digest("hex").slice(0, 16);
  const filename = `tts_${hash}.wav`;
  const outPath  = path.join(AUDIO_DIR, filename);

  // Cache találat
  if (fs.existsSync(outPath)) return filename;

  const speechWav  = path.join(AUDIO_DIR, `tts_${hash}_speech.wav`);
  const concatList = path.join(AUDIO_DIR, `tts_${hash}_list.txt`);

  try {
    // ── 1. Piper: szöveg → WAV ─────────────────────────────────────────────
    await runProcess(PIPER_BIN, [
      "--model", modelPath,
      "--output_file", speechWav,
    ], text);

    if (!fs.existsSync(speechWav)) throw new Error("Piper: WAV not created");

    // ── 2. Dingdong + TTS összefűzés WAV-ban ──────────────────────────────
    if (hasDingdong) {
      // Mindkét WAV azonos sample rate-re konvertálva (48000:16:2 snapcast formátum)
      const dingdongNorm = path.join(AUDIO_DIR, `tts_${hash}_dd.wav`);
      const speechNorm   = path.join(AUDIO_DIR, `tts_${hash}_sp.wav`);

      await runProcess("ffmpeg", [
        "-y", "-i", DINGDONG_WAV,
        "-ar", "48000", "-ac", "2", "-sample_fmt", "s16",
        dingdongNorm,
      ]);
      await runProcess("ffmpeg", [
        "-y", "-i", speechWav,
        "-ar", "48000", "-ac", "2", "-sample_fmt", "s16",
        speechNorm,
      ]);

      fs.writeFileSync(concatList,
        `file '${dingdongNorm}'\nfile '${speechNorm}'\n`
      );

      await runProcess("ffmpeg", [
        "-y",
        "-f", "concat", "-safe", "0", "-i", concatList,
        "-ar", "48000", "-ac", "2", "-sample_fmt", "s16",
        outPath,
      ]);

      // Temp fájlok
      for (const f of [dingdongNorm, speechNorm]) {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
      }
    } else {
      // Nincs dingdong – csak normalizálás 48000:16:2-re
      await runProcess("ffmpeg", [
        "-y", "-i", speechWav,
        "-ar", "48000", "-ac", "2", "-sample_fmt", "s16",
        outPath,
      ]);
    }

    if (!fs.existsSync(outPath)) throw new Error("ffmpeg: final WAV not created");
    console.log(`[TTS] Generálva: ${filename}`);
    return filename;

  } finally {
    for (const f of [speechWav, concatList]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
  }
}
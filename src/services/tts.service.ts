import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const PIPER_BIN  = "/opt/schoollive/piper/piper";
const MODELS_DIR = "/opt/schoollive/piper/models";
const AUDIO_DIR  = "/opt/schoollive/backend/audio";

const VOICES: Record<string, string> = {
  anna:  "hu_HU-anna-medium.onnx",
  berta: "hu_HU-berta-medium.onnx",
  imre:  "hu_HU-imre-medium.onnx",
};

export async function generateTTS(text: string, voice: string = "anna"): Promise<string> {
  const modelFile = VOICES[voice] ?? VOICES["anna"];
  const modelPath = path.join(MODELS_DIR, modelFile);

  const hash = crypto.createHash("sha256").update(text + voice).digest("hex").slice(0, 16);
  const filename = `tts_${hash}.mp3`;
  const outputPath = path.join(AUDIO_DIR, filename);
  const wavPath = path.join(AUDIO_DIR, `tts_${hash}.wav`);

  if (fs.existsSync(outputPath)) {
    return filename;
  }

  // 1. Piper: szöveg → WAV
  await new Promise<void>((resolve, reject) => {
    const piper = spawn(PIPER_BIN, [
      "--model", modelPath,
      "--output_file", wavPath,
    ]);

    piper.stdin.write(text);
    piper.stdin.end();

    let stderr = "";
    piper.stderr.on("data", (d) => { stderr += d.toString(); });

    piper.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Piper error (${code}): ${stderr}`));
      if (!fs.existsSync(wavPath)) return reject(new Error("Piper: WAV not created"));
      resolve();
    });

    piper.on("error", (err) => reject(new Error(`Piper spawn error: ${err.message}`)));
  });

  // 2. ffmpeg: WAV → MP3
  await new Promise<void>((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-y",
      "-i", wavPath,
      "-codec:a", "libmp3lame",
      "-qscale:a", "4",
      outputPath,
    ]);

    let stderr = "";
    ff.stderr.on("data", (d) => { stderr += d.toString(); });

    ff.on("close", (code) => {
      // WAV törlése
      try { fs.unlinkSync(wavPath); } catch { /* ignore */ }

      if (code !== 0) return reject(new Error(`ffmpeg error (${code}): ${stderr}`));
      if (!fs.existsSync(outputPath)) return reject(new Error("ffmpeg: MP3 not created"));
      resolve();
    });

    ff.on("error", (err) => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
  });

  return filename;
}
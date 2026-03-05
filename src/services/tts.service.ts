import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const execFileAsync = promisify(execFile);

const PIPER_BIN   = "/opt/schoollive/piper/piper";
const MODELS_DIR  = "/opt/schoollive/piper/models";
const AUDIO_DIR   = "/opt/schoollive/backend/audio";

const VOICES: Record<string, string> = {
  anna:  "hu_HU-anna-medium.onnx",
  berta: "hu_HU-berta-medium.onnx",
  imre:  "hu_HU-imre-medium.onnx",
};

export async function generateTTS(text: string, voice: string = "anna"): Promise<string> {
  const modelFile = VOICES[voice] ?? VOICES["anna"];
  const modelPath = path.join(MODELS_DIR, modelFile);

  // Egyedi fájlnév hash alapján
  const hash = crypto.createHash("sha256").update(text + voice).digest("hex").slice(0, 16);
  const filename = `tts_${hash}.mp3`;
  const outputPath = path.join(AUDIO_DIR, filename);

  // Ha már létezik, ne generáljuk újra
  if (fs.existsSync(outputPath)) {
    return filename;
  }

  // Piper futtatása
  await execFileAsync("/bin/sh", [
    "-c",
    `echo ${JSON.stringify(text)} | ${PIPER_BIN} --model ${modelPath} --output_file ${outputPath}`
  ]);

  if (!fs.existsSync(outputPath)) {
    throw new Error("TTS generation failed: output file not created");
  }

  return filename;
}
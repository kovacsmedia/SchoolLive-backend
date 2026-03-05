import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import crypto from "crypto";

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

  const hash = crypto.createHash("sha256").update(text + voice).digest("hex").slice(0, 16);
  const filename = `tts_${hash}.mp3`;
  const outputPath = path.join(AUDIO_DIR, filename);

  if (fs.existsSync(outputPath)) {
    return filename;
  }

  return new Promise((resolve, reject) => {
    const piper = spawn(PIPER_BIN, [
      "--model", modelPath,
      "--output_file", outputPath,
    ]);

    piper.stdin.write(text);
    piper.stdin.end();

    let stderr = "";
    piper.stderr.on("data", (d) => { stderr += d.toString(); });

    piper.on("close", (code) => {
      if (code !== 0) {
        console.error("[TTS] piper stderr:", stderr);
        return reject(new Error(`Piper exited with code ${code}: ${stderr}`));
      }
      if (!fs.existsSync(outputPath)) {
        return reject(new Error("TTS generation failed: output file not created"));
      }
      resolve(filename);
    });

    piper.on("error", (err) => {
      reject(new Error(`Failed to spawn piper: ${err.message}`));
    });
  });
}